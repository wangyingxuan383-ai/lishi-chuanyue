import { describe, expect, it, vi } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import type { Platform, StreamEvent } from "../platform";
import { EditRejected, Game, type AutoplayEvent, type NewWorld, type TurnEvent } from "./game";
import { modeEditSummary, newChallenge, newScript } from "./modes";
import { RECORD, fakeLlm, reply, type Script } from "./testing/fakeLlm";
import * as tree from "./tree";
import type { WorldSettings } from "./types";

// Memory SQLite and scripted streams only: no credentials, no network.
const LLM = { slot: "fake", url: "https://modes-test.invalid/v1/chat/completions", model: "story", auxModel: "aux", includeUsage: true };
const DAY = 1440;
const SETTINGS: Partial<WorldSettings> = { mode: "free", autoUpkeep: false, chapterEvery: 0, fortune: "off" };
const SETUP: NewWorld = {
  title: "汴京", eraId: null, settings: SETTINGS,
  protagonist: { name: "沈默", gender: "男", age: 26, identity: "开封府小吏" },
  arrival: "不穿越", origin: "", opening: { mode: "ai", hint: "府衙里" }, organize: false,
  script: { line: "小吏查清一桩旧案", beats: ["上官交代誊抄名册", "名册里少了一个人", "夜访失踪者的家"], ending: "旧案昭雪" },
  challenge: { goal: "十日内查出名册缺页的去向", limit: "十日", failIf: "被上官发现私查" },
};
const OPENING = "府衙里灯火昏黄，上官把一摞名册推到你面前。" + RECORD({ challenge: { progress: "还没有头绪" } });
const turn = (text: string, fields: Record<string, unknown> = {}): Script => ({ text: text + RECORD(fields) });

async function prepare(scripts: Script[], setup: NewWorld = SETUP) {
  const llm = fakeLlm([{ text: OPENING }, ...scripts]);
  const platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, { ...LLM });
  game.autoplayPauseMs = 0;
  const notified: string[] = [];
  platform.system.storyCommitted = async (id) => { notified.push(id); };
  const worldId = (await game.createWorld(setup, () => {}))!;
  return { llm, platform, game, worldId, notified };
}
const headState = async (game: Game, worldId: string) => game.repo.getState((await tree.cursor(game.repo, worldId)).head.id);
const chipsOf = async (game: Game, worldId: string) => (((await tree.cursor(game.repo, worldId)).head.meta.chips as { text: string }[]) ?? []).map((c) => c.text);
const messagesOf = (llm: ReturnType<typeof fakeLlm>, i: number) => llm.calls[i].body.messages as { role: string; content: string }[];
const lastUser = (llm: ReturnType<typeof fakeLlm>, i: number) => messagesOf(llm, i).at(-1)!.content;
const usageRows = (platform: Platform) => platform.sql.query("SELECT purpose, model, outcome FROM usage ORDER BY rowid");
const watching = (setup: NewWorld = SETUP): NewWorld => ({ ...setup, settings: { ...setup.settings, pilot: "ai" } });

describe("worlds with a script and a challenge", () => {
  it("starts with both, tells the opening about them and returns them for another try", async () => {
    const { llm, game, worldId } = await prepare([], watching());
    const opening = await tree.cursor(game.repo, worldId);
    const state = await game.repo.getState(opening.head.id);
    expect(state.script).toMatchObject({ line: "小吏查清一桩旧案", steer: "gentle", ending: "旧案昭雪" });
    expect(state.script!.beats.map((b) => [b.text, b.status])).toEqual([["上官交代誊抄名册", "todo"], ["名册里少了一个人", "todo"], ["夜访失踪者的家", "todo"]]);
    expect(state.challenge).toMatchObject({ goal: "十日内查出名册缺页的去向", limit: "十日", deadlineMinute: 10 * DAY, startedMinute: 0, status: "active", progress: "还没有头绪" });
    const request = messagesOf(llm, 0).map((m) => m.content).join("\n");
    expect(request).toContain("这一幕：上官交代誊抄名册");
    expect(request).toContain("【挑战】十日内查出名册缺页的去向");
    expect(request).toContain("主角由你来演");
    expect(opening.head.meta).not.toHaveProperty("log");
    expect(await game.setupOf(worldId)).toMatchObject({
      settings: { pilot: "ai" },
      script: { line: "小吏查清一桩旧案", beats: ["上官交代誊抄名册", "名册里少了一个人", "夜访失踪者的家"], ending: "旧案昭雪", steer: "gentle" },
      challenge: { goal: "十日内查出名册缺页的去向", limit: "十日", failIf: "被上官发现私查" },
    });
  });

  it("keeps an unreadable limit's words without a deadline and says so in the developer log", async () => {
    const { game, worldId } = await prepare([], { ...SETUP, script: null, challenge: { goal: "查出缺页", limit: "秋收前", failIf: "" } });
    const opening = await tree.cursor(game.repo, worldId);
    expect((await game.repo.getState(opening.head.id)).challenge).toMatchObject({ limit: "秋收前", deadlineMinute: null });
    expect(opening.head.meta.log).toEqual(["期限“秋收前”无法换算，按不限时处理"]);
    const plain = await game.setupOf(worldId);
    expect(plain).not.toHaveProperty("script");
  });

  it("starts an ordinary world without any mode, as before", async () => {
    const { game, worldId, llm } = await prepare([], { ...SETUP, script: null, challenge: { goal: " ", limit: "", failIf: "" } });
    const state = await headState(game, worldId);
    expect(state).not.toHaveProperty("script");
    expect(state).not.toHaveProperty("challenge");
    expect(messagesOf(llm, 0).map((m) => m.content).join("\n")).not.toMatch(/【剧本】|【挑战】/);
    const setup = await game.setupOf(worldId);
    expect(setup).not.toHaveProperty("script");
    expect(setup).not.toHaveProperty("challenge");
  });

  it("plays beats and ends the challenge on time, a 过些日子 included", async () => {
    const { game, worldId } = await prepare([
      turn("你翻开名册。", { beat: "done", challenge: { progress: "找到缺页的位置" } }),
      turn("十多天过去了。", { time: "半个月" }),
    ]);
    await game.play(worldId, { mode: "do", text: "翻开名册" }, () => {}).done;
    expect(await chipsOf(game, worldId)).toEqual(expect.arrayContaining(["📜 第 1 幕演完：上官交代誊抄名册", "⚑ 挑战进展：找到缺页的位置"]));
    await game.play(worldId, { mode: "skip", text: "过半个月" }, () => {}).done;
    const state = await headState(game, worldId);
    expect(state.challenge).toMatchObject({ status: "lost", outcome: "期限已到", endedMinute: 10 * DAY, turns: 2 });
    expect(await chipsOf(game, worldId)).toContain("⚑ 挑战失败：期限已到");
  });

  it("edits the script and the challenge as undoable story edits, refused in the player's words", async () => {
    const { game, worldId } = await prepare([]);
    const before = await tree.cursor(game.repo, worldId);
    const state = await game.repo.getState(before.head.id);
    const script = { ...state.script!, beats: [...state.script!.beats.slice(0, 2), { ...state.script!.beats[2], text: "夜访失踪者的旧宅" }] };
    const summary = modeEditSummary(state, { scriptSet: script });
    expect(summary).toBe("你修改了剧本");
    const edited = await game.editState(worldId, { scriptSet: script }, summary);
    expect(edited.head).toMatchObject({ kind: "edit", actionText: "你修改了剧本" });
    expect((await game.repo.getState(edited.head.id)).script!.beats[2].text).toBe("夜访失踪者的旧宅");
    const undone = await tree.undo(game.repo, edited);
    expect((await game.repo.getState(undone.head.id)).script!.beats[2].text).toBe("夜访失踪者的家");
    const redone = await tree.redo(game.repo, undone);
    expect((await game.repo.getState(redone.head.id)).script!.beats[2].text).toBe("夜访失踪者的旧宅");
    await expect(game.editState(worldId, { scriptSet: { ...script, beats: [] } }, "你修改了剧本")).rejects.toEqual(new EditRejected("剧本至少要有一幕"));
    await expect(game.editState(worldId, { scriptSet: script }, "你修改了剧本")).rejects.toThrow("和现在的内容一样");
    const given = await game.editState(worldId, { challengeSet: { ...state.challenge!, status: "abandoned" } }, "你放弃了挑战");
    expect((await game.repo.getState(given.head.id)).challenge).toMatchObject({ status: "abandoned", endedMinute: 0 });
  });

  it("keeps each branch's script to itself", async () => {
    const { game, worldId } = await prepare([
      turn("你把名册誊完了。", { beat: "done" }),
      turn("你推说眼花，把名册搁下。"),
    ]);
    const opening = await tree.cursor(game.repo, worldId);
    await game.play(worldId, { mode: "do", text: "连夜誊抄" }, () => {}).done;
    const first = await tree.cursor(game.repo, worldId);
    expect((await game.repo.getState(first.head.id)).script!.beats[0].status).toBe("done");
    await tree.goBackTo(game.repo, first, opening.head.id);
    await game.play(worldId, { mode: "do", text: "推说眼花" }, () => {}).done;
    expect((await headState(game, worldId)).script!.beats[0].status).toBe("todo");
    expect((await game.repo.getState(first.head.id)).script!.beats[0].status).toBe("done");
  });

  it("drafts an outline and a challenge on the auxiliary model, or gives null", async () => {
    const { llm, platform, game } = await prepare([
      { text: JSON.stringify({ line: "查清旧案", beats: ["誊抄名册", " ", "发现缺页", "夜访旧宅"], ending: "昭雪" }) },
      { text: "抱歉，这个我帮不了。" },
      [{ type: "error", kind: "http", status: 401, message: "test" }],
      { text: JSON.stringify({ goal: "十日内查出缺页的去向", limit: "十日", failIf: "" }) },
      { text: JSON.stringify({ limit: "十日" }) },
    ]);
    const current = { mode: "free" as const, premise: "汴京，开封府。", name: "沈默", script: { line: "查清旧案", beats: ["誊抄名册"] } };
    expect(await game.draftScript(current)).toEqual({ line: "查清旧案", beats: ["誊抄名册", "发现缺页", "夜访旧宅"], ending: "昭雪" });
    expect(lastUser(llm, 1)).toContain("故事设定：汴京，开封府。");
    expect(lastUser(llm, 1)).toContain("主线：查清旧案\n已写的幕：\n1. 誊抄名册");
    expect(llm.calls[1].body.model).toBe("aux");
    expect(await game.draftScript({})).toBeNull();
    expect(await game.draftScript({})).toBeNull();
    expect(await game.draftChallenge({ premise: "汴京" })).toEqual({ goal: "十日内查出缺页的去向", limit: "十日", failIf: "" });
    expect(messagesOf(llm, 4)[0].content).toContain("出一个开局挑战");
    expect(await game.draftChallenge({})).toBeNull();
    expect((await usageRows(platform)).slice(1)).toEqual([
      { purpose: "outline", model: "aux", outcome: "ok" },
      { purpose: "outline", model: "aux", outcome: "no_record" },
      { purpose: "outline", model: "aux", outcome: "failed" },
      { purpose: "challenge", model: "aux", outcome: "ok" },
      { purpose: "challenge", model: "aux", outcome: "no_record" },
    ]);
  });
});

describe("连播", () => {
  const steps = (events: AutoplayEvent[]) => events.filter((e) => e.type === "step" || e.type === "finished" || e.type === "done" || e.type === "failed").map((e) => e.type === "step" ? `step ${e.index}/${e.total}` : e.type === "finished" ? `finished ${e.steps} ${e.reason}` : e.type);

  it("plays ordinary 继续 turns in a row, each billed and announced, until the count is used", async () => {
    const { llm, platform, game, worldId, notified } = await prepare([turn("你翻开名册。"), turn("你发现少了一页。")], watching());
    const events: AutoplayEvent[] = [];
    const handle = game.autoplay(worldId, { turns: 2 }, (e) => events.push(e));
    expect(await handle.done).toEqual({ steps: 2, reason: "count" });
    await game.settled();
    expect(steps(events)).toEqual(["step 1/2", "done", "step 2/2", "done", "finished 2 count"]);
    expect(lastUser(llm, 1)).toContain("【继续】接着往下演");
    const path = await game.repo.path((await tree.cursor(game.repo, worldId)).head.id);
    expect(path.map((n) => [n.kind, n.actionMode])).toEqual([["opening", null], ["turn", "continue"], ["turn", "continue"]]);
    expect((await usageRows(platform)).map((r) => r.purpose)).toEqual(["opening", "turn", "turn"]);
    expect(notified).toHaveLength(3);
  });

  it("starts nothing when the player plays the protagonist or something is being written", async () => {
    const mine = await prepare([]);
    const events: AutoplayEvent[] = [];
    expect(await mine.game.autoplay(mine.worldId, { turns: 3 }, (e) => events.push(e)).done).toEqual({ steps: 0, reason: "player" });
    expect(steps(events)).toEqual(["finished 0 player"]);
    expect(mine.llm.calls).toHaveLength(1);

    const s = await prepare([], watching());
    const requests: ((e: StreamEvent) => void)[] = [];
    s.llm.stream = async (_request, emit) => { requests.push(emit); return `held-${requests.length}`; };
    const writing = s.game.play(s.worldId, { mode: "direct", text: "让上官回来" }, () => {});
    expect(await s.game.autoplay(s.worldId, { turns: 3 }, () => {}).done).toEqual({ steps: 0, reason: "busy" });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    reply("上官回来了。" + RECORD({})).forEach(requests[0]);
    await writing.done;
    const first = s.game.autoplay(s.worldId, { turns: 1 }, () => {});
    expect(await s.game.autoplay(s.worldId, { turns: 1 }, () => {}).done).toEqual({ steps: 0, reason: "busy" });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    reply("你又翻了一页。" + RECORD({})).forEach(requests[1]);
    expect(await first.done).toEqual({ steps: 1, reason: "count" });
  });

  it("stops the step being written, keeping its words, and starts no other", async () => {
    const s = await prepare([], watching());
    const requests: ((e: StreamEvent) => void)[] = [];
    s.llm.stream = async (_request, emit) => { requests.push(emit); return `held-${requests.length}`; };
    const events: AutoplayEvent[] = [];
    const handle = s.game.autoplay(s.worldId, { turns: 5 }, (e) => events.push(e));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0]({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: "你提笔写下第一行，" } }] }) });
    await vi.waitFor(() => expect(events.some((e) => e.type === "text")).toBe(true));
    handle.stop();
    expect(await handle.done).toEqual({ steps: 0, reason: "stopped" });
    const head = (await tree.cursor(s.game.repo, s.worldId)).head;
    expect(head).toMatchObject({ status: "interrupted", narrative: "你提笔写下第一行，", actionMode: "continue" });
    expect(steps(events)).toEqual(["step 1/5", "failed", "finished 0 stopped"]);
    expect(requests).toHaveLength(1);
  });

  it("stops during the pause between two steps", async () => {
    const s = await prepare([turn("你翻开名册。"), turn("不该写到这里。")], watching());
    s.game.autoplayPauseMs = 60_000;
    const events: AutoplayEvent[] = [];
    const handle = s.game.autoplay(s.worldId, { turns: 2 }, (e) => events.push(e));
    await vi.waitFor(() => expect(events.some((e) => e.type === "done")).toBe(true));
    handle.stop();
    expect(await handle.done).toEqual({ steps: 1, reason: "stopped" });
    expect(s.llm.calls).toHaveLength(2);
  });

  it("ends early when a step fails, the protagonist dies, the challenge ends or the last beat is played", async () => {
    const failing = await prepare([[{ type: "error", kind: "http", status: 401, message: "test" }]], watching());
    expect(await failing.game.autoplay(failing.worldId, { turns: 3 }, () => {}).done).toEqual({ steps: 0, reason: "failed" });

    const harsh = watching({ ...SETUP, settings: { ...SETTINGS, difficulty: "残酷" } });
    const dying = await prepare([turn("一支冷箭射来。", { stats: { health: -40 } }), turn("你倒在雪地里。", { stats: { health: -40 } })], harsh);
    expect(await dying.game.autoplay(dying.worldId, { turns: 5 }, () => {}).done).toEqual({ steps: 2, reason: "died" });
    // A dead protagonist starts nothing.
    expect(await dying.game.autoplay(dying.worldId, { turns: 5 }, () => {}).done).toEqual({ steps: 0, reason: "died" });

    const winning = await prepare([turn("你找到了缺页。", { challenge: { progress: "缺页找到了", result: "won" } })], watching());
    expect(await winning.game.autoplay(winning.worldId, { turns: 3 }, () => {}).done).toEqual({ steps: 1, reason: "challenge" });
    expect((await headState(winning.game, winning.worldId)).challenge).toMatchObject({ status: "won", turns: 1 });

    const short = watching({ ...SETUP, script: { line: "", beats: ["誊抄名册"], ending: "" }, challenge: null });
    const ending = await prepare([turn("名册誊完了。", { beat: "done" })], short);
    expect(await ending.game.autoplay(ending.worldId, { turns: 3 }, () => {}).done).toEqual({ steps: 1, reason: "script" });
  });

  it("goes on past a challenge that had already ended and a script already played", async () => {
    const s = await prepare([turn("你继续查。"), turn("又过了一夜。")], watching());
    const state = await headState(s.game, s.worldId);
    const done = { ...state.script!, beats: state.script!.beats.map((b) => ({ ...b, status: "done" as const })) };
    await s.game.editState(s.worldId, { challengeSet: { ...state.challenge!, status: "abandoned" }, scriptSet: done }, "你放弃了挑战");
    expect(await s.game.autoplay(s.worldId, { turns: 2 }, () => {}).done).toEqual({ steps: 2, reason: "count" });
  });

  it("rereads the settings before every step: switching back to “我来演” ends it", async () => {
    const s = await prepare([turn("你翻开名册。")], watching());
    s.game.autoplayPauseMs = 200;
    const world = (await s.game.repo.getWorld(s.worldId))!;
    let switched: Promise<void> | null = null;
    const handle = s.game.autoplay(s.worldId, { turns: 3 }, (e: AutoplayEvent | TurnEvent) => {
      if (e.type === "done") switched = s.game.repo.updateSettings(s.worldId, { ...world.settings, pilot: "player" });
    });
    expect(await handle.done).toEqual({ steps: 1, reason: "player" });
    await switched;
  });
});

/** A challenge added in play counts from the minute it was added (the UI's “加一个挑战”). */
describe("a challenge added later", () => {
  it("counts its deadline from the minute it was added", async () => {
    const { game, worldId } = await prepare([turn("一天过去了。", { time: "一天" }), turn("又过了五天。", { time: "五天" })], { ...SETUP, script: null, challenge: null });
    await game.play(worldId, { mode: "do", text: "等" }, () => {}).done;
    const state = await headState(game, worldId);
    const challenge = newChallenge({ goal: "五日内回京", limit: "五日", failIf: "" }, state.time.elapsedMinutes)!;
    expect(modeEditSummary(state, { challengeSet: challenge })).toBe("你加了一个挑战");
    await game.editState(worldId, { challengeSet: challenge, scriptSet: newScript({ line: "", beats: ["回京"], ending: "" }) }, "你加了一个挑战");
    expect((await headState(game, worldId)).challenge).toMatchObject({ startedMinute: DAY, deadlineMinute: 6 * DAY });
    await game.play(worldId, { mode: "do", text: "再等" }, () => {}).done;
    expect((await headState(game, worldId)).challenge).toMatchObject({ status: "lost", turns: 1, endedMinute: 6 * DAY });
  });
});
