import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import type { Platform, StreamEvent } from "../platform";
import { budgetSummary, monthSpend, overBudget } from "../ui/components/budgetMath";
import { Game, type NewWorld, type TurnEvent, type TurnHandle } from "./game";
import type { ChatResult } from "./llm/chat";
import { fakeLlm, RECORD, reply, type Script } from "./testing/fakeLlm";
import { sampleState } from "./testing/fixtures";
import * as tree from "./tree";

// These regressions use only memory SQLite and synthetic streams, never a credential store or server.
const LLM = { slot: "fake", url: "https://runtime-test.invalid/v1/chat/completions", model: "story", auxModel: "aux", includeUsage: true };
const SETTINGS = { mode: "free" as const, heroPanelEnabled: true, fortune: "off" as const, autoUpkeep: false, chapterEvery: 0, choiceCount: 0 };
const PRICES = { input: 10_000, output: 10_000, limit: 2.5 };
const action = { mode: "do" as const, text: "走上甲板", directorNote: "保留海上的雾" };
const draft: NewWorld = {
  title: "远航", eraId: null, settings: SETTINGS,
  protagonist: { name: "林舟", age: 20, gender: "女", identity: "船长" },
  arrival: "不穿越", origin: "", opening: { mode: "ai", hint: "" }, organize: false,
};
const errorScript = (kind: "http" | "network" | "no_secret" | "url_not_bound", status?: number): StreamEvent[] => [{ type: "error", kind, ...(status ? { status } : {}) }];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
afterEach(() => { vi.restoreAllMocks(); });

async function prepare(scripts: Script[] = []) {
  const llm = fakeLlm(scripts);
  const platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, { ...LLM });
  const notifications: { id: string; persisted: boolean }[] = [];
  platform.system.storyCommitted = async (id) => {
    const node = await game.repo.getNode(id.split(":")[1]);
    notifications.push({ id, persisted: node?.status === "ok" });
  };
  return { llm, platform, game, notifications };
}
async function seed(scripts: Script[] = []) {
  const s = await prepare(scripts);
  const state = sampleState();
  state.era = { mode: "free", clockStyle: "elapsed", packId: null };
  state.protagonist.panel = "潜水：熟练";
  const world = await s.game.repo.createWorld({ title: "远航", eraId: "free", settings: SETTINGS,
    opening: { parentId: null, kind: "opening", narrative: "你推开船舱的门。", state } });
  return { ...s, ...world, state };
}
function controlStreams(llm: Platform["llm"]) {
  const requests: { id: string; body: unknown; emit: (e: StreamEvent) => void }[] = [];
  llm.stream = async (request, emit) => {
    const id = `controlled-${requests.length + 1}`;
    requests.push({ id, body: request.body, emit });
    return id;
  };
  // Deliberately ignore cancellation: late provider events must not commit anything.
  const cancel = vi.fn(async (_id: string) => {});
  const resume = vi.fn(async (_id: string) => ({ events: [] as StreamEvent[], active: true }));
  llm.cancel = cancel;
  llm.resume = resume;
  return {
    requests, cancel, resume,
    async wait(count: number) { await vi.waitFor(() => expect(requests).toHaveLength(count)); },
    reply(index: number, text: string) { reply(text).forEach(requests[index].emit); },
  };
}
async function rows(platform: Platform) {
  return platform.sql.query("SELECT purpose, model, prompt_tokens, completion_tokens, estimated, outcome FROM usage ORDER BY rowid");
}
const partial = (text: string): Script => [
  { type: "data", data: JSON.stringify({ choices: [{ delta: { content: text } }] }) },
  { type: "error", kind: "network" },
];

describe("operation cancellation and completion notifications", () => {
  it.each(["turn", "variant", "resume"] as const)("stops %s during either record or choice extraction, retaining text and costs", async (kind) => {
    for (const missing of ["record", "choices"] as const) {
      const s = await seed();
      await s.game.repo.updateSettings(s.world.id, { ...s.world.settings, choiceCount: missing === "choices" ? 3 : 0 });
      let before = await tree.cursor(s.game.repo, s.world.id);
      if (kind !== "turn") before = await tree.append(s.game.repo, before, {
        kind: "turn", actionMode: action.mode, actionText: action.text, narrative: "原来的半段。", state: s.state,
        status: kind === "resume" ? "interrupted" : "ok",
      });
      const streams = controlStreams(s.llm);
      const events: TurnEvent[] = [];
      const work = kind === "resume" ? s.game.resumeInterrupted(s.world.id, (e) => events.push(e))
        : kind === "variant" ? s.game.regenerate(s.world.id, null, (e) => events.push(e))
          : s.game.play(s.world.id, action, (e) => events.push(e));
      await streams.wait(1);
      streams.reply(0, "你走上甲板。" + (missing === "choices" ? RECORD({ time: 10, money: -7, choices: [] }) : ""));
      await streams.wait(2);
      await work.catchUp();
      expect(streams.resume).toHaveBeenLastCalledWith("controlled-2");
      work.stop();
      await work.done;
      // It must finish promptly even if the provider never acknowledges cancellation.
      expect(streams.cancel).toHaveBeenCalledWith("controlled-2");
      streams.reply(1, JSON.stringify({ time: 10, money: -7, choices: ["继续"] }));
      await s.game.settled();
      const after = await tree.cursor(s.game.repo, s.world.id);
      expect(after.head).toMatchObject({ status: "interrupted", record: null, choices: [],
        narrative: `${kind === "resume" ? "原来的半段。" : ""}你走上甲板。` });
      expect(await s.game.repo.getState(after.head.id)).toEqual(s.state);
      if (kind === "resume") expect(after.head.id).toBe(before.head.id);
      else if (kind === "variant") expect((await s.game.repo.getNode(before.head.id))?.narrative).toBe("原来的半段。");
      expect(events.at(-1)).toMatchObject({ type: "failed", reason: "cancelled", partialSaved: true });
      expect(events.some((e) => e.type === "done")).toBe(false);
      expect(s.notifications).toEqual([]);
      expect(await s.game.repo.getSetting("pending", null)).toBeNull();
      expect(await rows(s.platform)).toEqual(expect.arrayContaining([
        { purpose: "extract", model: "aux", prompt_tokens: null, completion_tokens: null, estimated: 1, outcome: "cancelled" },
        { purpose: kind === "resume" ? "continue" : "turn", model: "story", prompt_tokens: 100, completion_tokens: 50, estimated: 0, outcome: "cancelled" },
      ]));
      expect(await monthSpend(s.platform, PRICES)).toMatchObject({ calls: 2, unknown: 1, knownCost: 1.5 });
    }
  });

  it.each(["turn", "resume"] as const)("stops %s before request startup without creating fictitious usage", async (kind) => {
    const s = await seed();
    if (kind === "resume") await tree.append(s.game.repo, await tree.cursor(s.game.repo, s.world.id), {
      kind: "turn", narrative: "半段。", status: "interrupted", state: s.state,
    });
    const before = await tree.cursor(s.game.repo, s.world.id);
    const events: TurnEvent[] = [];
    const work = kind === "turn" ? s.game.play(s.world.id, action, (e) => events.push(e)) : s.game.resumeInterrupted(s.world.id, (e) => events.push(e));
    work.stop();
    await work.done;
    expect(s.llm.calls).toHaveLength(0);
    expect(await rows(s.platform)).toEqual([]);
    expect((await tree.cursor(s.game.repo, s.world.id)).head.id).toBe(before.head.id);
    expect(events.at(-1)).toMatchObject({ type: "failed", reason: "cancelled" });
    expect(s.notifications).toEqual([]);
  });

  it("stopping on the organizing event does not start an extraction", async () => {
    const s = await seed([{ text: "完整正文，没有记录。" }]);
    let work!: TurnHandle;
    work = s.game.play(s.world.id, action, (e) => { if (e.type === "organizing") work.stop(); });
    await work.done;
    expect(s.llm.calls).toHaveLength(1);
    expect(await monthSpend(s.platform, PRICES)).toMatchObject({ calls: 1, unknown: 0, knownCost: 1.5 });
    expect((await tree.cursor(s.game.repo, s.world.id)).head.status).toBe("interrupted");
    expect(s.notifications).toEqual([]);
  });

  it("does not resurrect a pending recovery entry when a cancelled request's stream id arrives late", async () => {
    const s = await seed();
    const started = deferred(), identified = deferred();
    let emit!: (event: StreamEvent) => void;
    s.llm.stream = async (_request, callback) => {
      emit = callback; started.resolve(); await identified.promise; return "late-stream-id";
    };
    const cancel = vi.fn(async (_id: string) => {});
    s.llm.cancel = cancel;
    const work = s.game.play(s.world.id, action, () => {});
    await started.promise;
    emit({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: "已经写出的半句，" } }] }) });
    work.stop();
    await work.done;
    identified.resolve();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("late-stream-id"));
    expect(await s.game.repo.getSetting("pending", null)).toBeNull();
    expect((await tree.cursor(s.game.repo, s.world.id)).head).toMatchObject({ status: "interrupted", narrative: "已经写出的半句，" });
    expect(await rows(s.platform)).toHaveLength(1);
    expect(s.notifications).toEqual([]);
  });

  it("checks cancellation after a successful response and before committing a valid record", async () => {
    const s = await seed([{ text: "你付了七枚钱。" + RECORD({ time: 10, money: -7 }) }]);
    const entered = deferred(), release = deferred();
    const set = s.game.repo.setSetting.bind(s.game.repo);
    vi.spyOn(s.game.repo, "setSetting").mockImplementation(async (key, value) => {
      if (key.startsWith("tokenRatio:")) { entered.resolve(); await release.promise; }
      return set(key, value);
    });
    const work = s.game.play(s.world.id, action, () => {});
    await entered.promise;
    work.stop();
    release.resolve();
    await work.done;
    const after = await tree.cursor(s.game.repo, s.world.id);
    expect(after.head).toMatchObject({ status: "interrupted", narrative: "你付了七枚钱。", record: null });
    expect(await s.game.repo.getState(after.head.id)).toEqual(s.state);
    expect((await rows(s.platform))[0]).toMatchObject({ outcome: "cancelled", prompt_tokens: 100, completion_tokens: 50 });
    expect(s.notifications).toEqual([]);
  });

  it("retains newly streamed continuation text, ignores late events, then resumes it only once", async () => {
    const s = await seed();
    const cur = await tree.append(s.game.repo, await tree.cursor(s.game.repo, s.world.id), {
      kind: "turn", actionMode: "do", actionText: action.text, narrative: "原来的半句，", status: "interrupted", state: s.state,
    });
    const streams = controlStreams(s.llm);
    const work = s.game.resumeInterrupted(s.world.id, () => {});
    await streams.wait(1);
    streams.requests[0].emit({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: "这次写出的新半句，" } }] }) });
    work.stop();
    await work.done;
    streams.reply(0, "迟到的结尾。" + RECORD({ money: -99 }));
    expect((await s.game.repo.getNode(cur.head.id))?.narrative).toBe("原来的半句，这次写出的新半句，");
    expect(s.notifications).toEqual([]);
    const next = s.game.resumeInterrupted(s.world.id, () => {});
    await streams.wait(2);
    const body = streams.requests[1].body as { messages: { role: string; content: string }[] };
    expect(body.messages.at(-2)).toEqual({ role: "assistant", content: "原来的半句，这次写出的新半句，" });
    streams.reply(1, "终于写完。" + RECORD({ time: 10, money: -7 }));
    await next.done;
    await s.game.settled();
    expect((await s.game.repo.getNode(cur.head.id))?.narrative).toBe("原来的半句，这次写出的新半句，终于写完。");
    expect(s.notifications).toEqual([{ id: `${s.world.id}:${cur.head.id}`, persisted: true }]);
    expect(await monthSpend(s.platform, PRICES)).toMatchObject({ calls: 2, unknown: 1, knownCost: 1.5 });
  });

  it("also retains continuation text after a network interruption and records both unfinished attempts", async () => {
    const s = await seed([partial("原来的半句，"), partial("续写的新半句，")]);
    await s.game.play(s.world.id, action, () => {}).done;
    const before = await tree.cursor(s.game.repo, s.world.id);
    await s.game.resumeInterrupted(s.world.id, () => {}).done;
    const after = await tree.cursor(s.game.repo, s.world.id);
    expect(after.head).toMatchObject({ id: before.head.id, narrative: "原来的半句，续写的新半句，", status: "interrupted" });
    expect(await s.game.repo.getState(after.head.id)).toEqual(s.state);
    expect(await monthSpend(s.platform, PRICES)).toMatchObject({ calls: 2, unknown: 2, knownCost: null });
    expect(s.llm.calls).toHaveLength(2);
    expect(s.notifications).toEqual([]);
  });

  it("finishes continuation choice extraction once, preserving the narrative's facts and recording both requests", async () => {
    const s = await seed([
      { text: "续写完成。" + RECORD({ time: 10, money: -7, choices: [] }) },
      { text: JSON.stringify({ time: 99, money: -99, choices: ["看看海面"] }) },
    ]);
    await s.game.repo.updateSettings(s.world.id, { ...s.world.settings, choiceCount: 3 });
    const original = await tree.append(s.game.repo, await tree.cursor(s.game.repo, s.world.id), {
      kind: "turn", actionMode: "do", actionText: action.text, narrative: "开头。", status: "interrupted", state: s.state,
    });
    await s.game.resumeInterrupted(s.world.id, () => {}).done;
    await s.game.settled();
    const after = await tree.cursor(s.game.repo, s.world.id);
    expect(after.head).toMatchObject({ id: original.head.id, narrative: "开头。续写完成。", status: "ok", choices: ["看看海面"] });
    const state = await s.game.repo.getState(after.head.id);
    expect(state.time.elapsedMinutes).toBe(s.state.time.elapsedMinutes + 10);
    expect(state.protagonist.stats.money).toBe(s.state.protagonist.stats.money - 7);
    expect((await rows(s.platform)).map((r) => r.purpose).sort()).toEqual(["continue", "extract"]);
    expect(s.notifications).toEqual([{ id: `${s.world.id}:${original.head.id}`, persisted: true }]);
  });
});

describe("panel and player edits across versions", () => {
  it("retains pending player edits across cancelled regeneration and a later continuation", async () => {
    const s = await seed();
    await tree.append(s.game.repo, await tree.cursor(s.game.repo, s.world.id), {
      kind: "turn", actionMode: "do", actionText: action.text, narrative: "旧版本。", state: s.state,
    });
    await s.game.editState(s.world.id, { profile: { panel: "驾驶：入门" } }, "初稿面板");
    await s.game.editState(s.world.id, { cards: [{ op: "add", kind: "设定", name: "不沿用的旧事", content: "旧版" }] }, "旧整理", "AI");
    await s.game.editState(s.world.id, { profile: { panel: "驾驶：熟练" } }, "改定面板");
    const streams = controlStreams(s.llm);
    const rewriting = s.game.regenerate(s.world.id, null, () => {});
    await streams.wait(1);
    streams.reply(0, "新版本的前半段，");
    await streams.wait(2);
    rewriting.stop();
    await rewriting.done;
    const interrupted = await tree.cursor(s.game.repo, s.world.id);
    expect(interrupted.head.status).toBe("interrupted");
    expect(s.notifications).toEqual([]);
    // Reloading the engine still has the pending edits in the node, not just in a closure.
    const reloaded = await Game.open(s.platform, LLM);
    const events: TurnEvent[] = [];
    const continuation = reloaded.resumeInterrupted(s.world.id, (e) => events.push(e));
    await streams.wait(3);
    streams.reply(2, "后半段。" + RECORD({ time: 3 }));
    await continuation.done;
    await reloaded.settled();
    const after = await tree.cursor(s.game.repo, s.world.id);
    const state = await s.game.repo.getState(after.head.id);
    expect(state.protagonist.panel).toBe("驾驶：熟练");
    expect(state.cards.some((c) => c.name === "不沿用的旧事")).toBe(false);
    expect((await s.game.repo.getNode(interrupted.head.id))?.meta.carriedEdits).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "done", cursor: { head: { id: after.head.id } } });
    expect(s.notifications).toEqual([{ id: `${s.world.id}:${interrupted.head.id}`, persisted: true }]);
  });

  it.each([false, true])("replays the player's edits after the turn in order, without AI edits, unless the player went back past them (returned to the turn=%s)", async (returnedToTurn) => {
    const s = await seed([{ text: "重说的版本。" + RECORD({ time: 3, money: -10 }) }]);
    const turn = await tree.append(s.game.repo, await tree.cursor(s.game.repo, s.world.id), { kind: "turn", actionMode: "do", actionText: action.text, narrative: "原版本。", state: s.state });
    await s.game.editState(s.world.id, { profile: { panel: "驾驶：入门" }, setStats: { money: 500 } }, "第一次修改");
    await s.game.editState(s.world.id, { cards: [{ op: "add", kind: "设定", name: "旧版本限定", content: "只属于旧剧情" }] }, "AI 整理", "AI");
    await s.game.editState(s.world.id, { profile: { panel: "驾驶：熟练" }, setStats: { money: 800 } }, "第二次修改");
    const before = await tree.cursor(s.game.repo, s.world.id);
    const oldState = await s.game.repo.getState(before.head.id);
    const bookmark = await tree.addBookmark(s.game.repo, s.world.id, before.head.id, "原版本");
    if (returnedToTurn) await tree.goBackTo(s.game.repo, before, turn.head.id);
    await s.game.regenerate(s.world.id, null, () => {}).done;
    await s.game.settled();
    const after = await tree.cursor(s.game.repo, s.world.id);
    const state = await s.game.repo.getState(after.head.id);
    const edits = (await s.game.repo.path(after.head.id)).filter((n) => n.kind === "edit").map((n) => n.actionText);
    if (returnedToTurn) {
      // The player went back to the turn: the edits after it are no longer theirs to keep (R14).
      expect(edits).toEqual([]);
      expect(state.protagonist).toMatchObject({ panel: "潜水：熟练", stats: { money: s.state.protagonist.stats.money - 10 } });
    } else {
      expect(state.protagonist).toMatchObject({ panel: "驾驶：熟练", stats: { money: 800 } });
      expect(edits).toEqual(["第一次修改（已沿用）", "第二次修改（已沿用）"]);
    }
    expect(state.cards.some((c) => c.name === "旧版本限定")).toBe(false);
    expect(await s.game.repo.getState(before.head.id)).toEqual(oldState);
    expect((await s.game.repo.getLine(bookmark.id))?.nodeId).toBe(before.head.id);
    expect(s.notifications).toHaveLength(1);
    expect(s.notifications[0].persisted).toBe(true);
  });

  it("does not bring back a panel edit the player undid when the turn is regenerated", async () => {
    const s = await seed([{ text: "重说的版本。" + RECORD({ time: 3 }) }]);
    await tree.append(s.game.repo, await tree.cursor(s.game.repo, s.world.id), { kind: "turn", actionMode: "do", actionText: action.text, narrative: "原版本。", state: s.state });
    const edited = await s.game.editState(s.world.id, { setStats: { money: 9999 } }, "钱 300 → 9999");
    await tree.undo(s.game.repo, edited);
    await s.game.regenerate(s.world.id, null, () => {}).done;
    const after = await tree.cursor(s.game.repo, s.world.id);
    expect(after.head).toMatchObject({ kind: "turn", narrative: "重说的版本。" });
    expect((await s.game.repo.getState(after.head.id)).protagonist.stats.money).toBe(s.state.protagonist.stats.money);
  });

  it.each([true, false])("rebuilds continuation from current settings and parent state (panel enabled=%s)", async (enabled) => {
    const s = await seed([{ text: "续写结束。" + RECORD({ time: 5 }) }]);
    const cached = [{ role: "system", content: "过期缓存；旧面板；旧规则" }];
    const future = structuredClone(s.state);
    future.protagonist.panel = "不应读取的中断节点面板";
    await tree.append(s.game.repo, await tree.cursor(s.game.repo, s.world.id), {
      kind: "turn", narrative: "已写的半句。", status: "interrupted", state: future,
      actionMode: action.mode, actionText: action.text, directorNote: action.directorNote, meta: { messages: cached },
    });
    await s.game.repo.updateSettings(s.world.id, { ...s.world.settings, heroPanelEnabled: enabled, heroPanel: "不能用全局种子覆盖", rules: "这次采用新规则" });
    await s.game.resumeInterrupted(s.world.id, () => {}).done;
    const messages = JSON.stringify(s.llm.calls[0].body.messages);
    expect(messages).toContain("这次采用新规则");
    expect(messages).toContain(action.directorNote);
    expect(messages).not.toMatch(/过期缓存|旧规则|不能用全局种子覆盖|不应读取的中断节点面板/);
    expect(messages.includes("潜水：熟练")).toBe(enabled);
    const after = await tree.cursor(s.game.repo, s.world.id);
    expect((await s.game.repo.getState(after.head.id)).protagonist.panel).toBe("潜水：熟练");
  });
});

describe("continuing an interrupted history turn", () => {
  it("asks again with the turn's own luck and 重说 direction, and settles them as the first request would", async () => {
    const s = await prepare([partial("你翻上墙头，"), { text: "脚下一滑，摔进了院子。" + RECORD({ time: 5, risk: { what: "翻墙", result: "败" } }) }]);
    const { world } = await s.game.repo.createWorld({
      title: "长安", eraId: "tang-748", settings: { premise: "天宝七载，长安。", fortune: "on", autoUpkeep: false, chapterEvery: 0, choiceCount: 0 },
      opening: { parentId: null, kind: "opening", narrative: "你站在坊墙下。", state: sampleState() },
    });
    await tree.append(s.game.repo, await tree.cursor(s.game.repo, world.id), {
      kind: "turn", actionMode: "do", actionText: "翻墙进院", narrative: "原来的版本。", state: sampleState(),
    });
    s.game.random = () => 0.99; // 大不顺 on 标准
    await s.game.regenerate(world.id, "写短一点", () => {}).done;
    const interrupted = await tree.cursor(s.game.repo, world.id);
    expect(interrupted.head).toMatchObject({ status: "interrupted", meta: { rewriteHint: "写短一点" } });
    const first = JSON.stringify(s.llm.calls[0].body.messages);
    for (const part of ["【重写要求】写短一点", "【本回合运势（玩家看不到）】大不顺"]) expect(first).toContain(part);
    const events: TurnEvent[] = [];
    await s.game.resumeInterrupted(world.id, (e) => events.push(e)).done;
    const second = JSON.stringify(s.llm.calls[1].body.messages);
    for (const part of ["【重写要求】写短一点", "【本回合运势（玩家看不到）】大不顺", "翻墙进院"]) expect(second).toContain(part);
    const done = events.at(-1) as Extract<TurnEvent, { type: "done" }>;
    expect(done.node).toMatchObject({ id: interrupted.head.id, status: "ok", narrative: "你翻上墙头，脚下一滑，摔进了院子。" });
    expect(done.node.meta.rewriteHint).toBeUndefined();
    expect(done.chips.map((c) => c.text)).toContain("签·大不顺 · 翻墙 · 没成");
  });
});

describe("usage for opening extraction and failed retry attempts", () => {
  it("counts both successful opening requests and triggers the budget using their combined cost", async () => {
    const s = await prepare([{ text: "你坐在船舱里。" }, { text: JSON.stringify({ time: 0, money: 20, choices: [] }) }]);
    const worldId = await s.game.createWorld(draft, () => {});
    await s.game.settled();
    expect(worldId).toBeTruthy();
    expect(await rows(s.platform)).toEqual([
      { purpose: "opening", model: "story", prompt_tokens: 100, completion_tokens: 50, estimated: 0, outcome: "ok" },
      { purpose: "extract", model: "aux", prompt_tokens: 100, completion_tokens: 50, estimated: 0, outcome: "ok" },
    ]);
    const spend = await monthSpend(s.platform, PRICES);
    expect(spend).toMatchObject({ calls: 2, unknown: 0, knownCost: 3 });
    expect(overBudget(PRICES, spend)).toBe(true);
    expect(s.notifications).toHaveLength(1);
    expect(s.notifications[0].persisted).toBe(true);
  });

  it.each(["failed", "malformed"] as const)("keeps independent opening/extraction usage when extraction is %s and no world is created", async (outcome) => {
    const s = await prepare([{ text: "你坐在船舱里。" }, outcome === "failed" ? errorScript("http", 403) : { text: "没有提供 JSON。" }]);
    expect(await s.game.createWorld(draft, () => {})).toBeNull();
    const usage = await rows(s.platform);
    expect(usage).toHaveLength(2);
    expect(usage.find((r) => r.purpose === "opening")).toMatchObject({ prompt_tokens: 100, completion_tokens: 50, outcome: "no_record" });
    expect(usage.find((r) => r.purpose === "extract")).toMatchObject(outcome === "failed"
      ? { prompt_tokens: null, completion_tokens: null, estimated: 1, outcome: "failed" }
      : { prompt_tokens: 100, completion_tokens: 50, outcome: "no_record" });
    const spend = await monthSpend(s.platform, PRICES);
    expect(spend.calls).toBe(2);
    expect(spend.unknown).toBe(outcome === "failed" ? 1 : 0);
    if (outcome === "failed") expect(budgetSummary(spend)).toContain("用量不全");
    expect(await s.game.repo.listWorlds()).toEqual([]);
    expect(s.notifications).toEqual([]);
  });

  it.each(["refused", "cut off"] as const)("still books the organizing request when the opening is %s after organizing began", async (failure) => {
    const opening: Script = failure === "refused" ? { text: "I cannot help with that request.", finish: "content_filter" } : partial("你坐在船舱里，");
    const s = await prepare([opening, { text: JSON.stringify({ era: { name: "远航", content: "海上的世界。" } }) }]);
    expect(await s.game.createWorld({ ...draft, organize: true }, () => {})).toBeNull();
    await s.game.settled();
    const usage = await rows(s.platform);
    expect(usage.find((r) => r.purpose === "codex")).toMatchObject({ model: "aux", prompt_tokens: 100, completion_tokens: 50, outcome: "stale" });
    expect(usage.find((r) => r.purpose === "opening")?.outcome).toBe(failure === "refused" ? "refused" : "failed");
    expect(await s.game.repo.listWorlds()).toEqual([]);
  });

  it("counts failed opening extraction retries once each, without inventing zero-cost calls", async () => {
    const s = await prepare([{ text: "你坐在船舱里。" }, errorScript("http", 503), { text: JSON.stringify({ time: 0, money: 20 }) }]);
    expect(await s.game.createWorld(draft, () => {})).toBeTruthy();
    expect(s.llm.calls).toHaveLength(3);
    const usage = await rows(s.platform);
    expect(usage).toHaveLength(3);
    expect(usage.filter((r) => r.purpose === "extract").map((r) => r.outcome)).toEqual(["failed", "ok"]);
    expect(await monthSpend(s.platform, PRICES)).toMatchObject({ calls: 3, unknown: 1, knownCost: 3 });
  });

  it.each(["success", "failed"] as const)("counts failed turn retries separately when the final attempt is %s", async (outcome) => {
    const s = await seed([errorScript("http", 503), outcome === "success" ? { text: "终于写完。" + RECORD({}) } : errorScript("http", 503)]);
    await s.game.play(s.world.id, action, () => {}).done;
    await s.game.settled();
    expect(s.llm.calls).toHaveLength(2);
    const usage = await rows(s.platform);
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ purpose: "turn", model: "story", prompt_tokens: null, completion_tokens: null, estimated: 1, outcome: "failed" });
    expect(usage[1].outcome).toBe(outcome === "success" ? "ok" : "failed");
    const spend = await monthSpend(s.platform, PRICES);
    expect(spend).toMatchObject({ calls: 2, unknown: outcome === "success" ? 1 : 2, knownCost: outcome === "success" ? 1.5 : null });
    expect(s.notifications).toHaveLength(outcome === "success" ? 1 : 0);
  });

  it("records retry failures in other Game.call consumers without duplicating their final row", async () => {
    const s = await seed([errorScript("http", 503), { text: "船在港口。" }]);
    await s.game.ask(s.world.id, "船在哪？", () => {});
    expect((await rows(s.platform)).map((r) => r.outcome)).toEqual(["failed", "ok"]);
    expect(await monthSpend(s.platform, PRICES)).toMatchObject({ calls: 2, unknown: 1, knownCost: 1.5 });
  });

  it.each(["ask", "codex"] as const)("%s also distinguishes real failures from unsent credential/binding failures", async (purpose) => {
    for (const failure of ["http", "no_secret", "url_not_bound"] as const) {
      const s = await seed([errorScript(failure, failure === "http" ? 503 : undefined), errorScript(failure, failure === "http" ? 503 : undefined)]);
      const work = purpose === "ask" ? s.game.ask(s.world.id, "船在哪？", () => {}) : s.game.organize(s.world.id);
      if (purpose === "ask") await expect(work).rejects.toThrow();
      else expect(await work).toBeNull();
      const usage = await rows(s.platform);
      expect(usage).toHaveLength(failure === "http" ? 2 : 0);
      expect(usage.every((r) => r.purpose === purpose && r.outcome === "failed" && r.prompt_tokens === null && r.completion_tokens === null)).toBe(true);
      expect(s.llm.calls).toHaveLength(failure === "http" ? 2 : 1);
      expect(s.notifications).toEqual([]);
    }
  });

  it.each(["no_secret", "url_not_bound"] as const)("does not count unsent %s as a paid/unknown request or retry it", async (kind) => {
    const s = await seed([errorScript(kind)]);
    const events: TurnEvent[] = [];
    await s.game.play(s.world.id, action, (e) => events.push(e)).done;
    expect(s.llm.calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "failed", reason: "config", partialSaved: false });
    expect(await rows(s.platform)).toEqual([]);
    expect(s.notifications).toEqual([]);
  });

  it.each(["llm_no_secret", "llm_url_not_bound"])("also excludes local startup rejection %s from usage", async (code) => {
    const s = await seed();
    const stream = vi.fn(async () => { throw { code, message: "local refusal" }; });
    s.llm.stream = stream;
    await s.game.play(s.world.id, action, () => {}).done;
    expect(stream).toHaveBeenCalledTimes(1);
    expect(await rows(s.platform)).toEqual([]);
    expect(s.notifications).toEqual([]);
  });

  it("cancels between retry attempts without starting or billing an extra request", async () => {
    const s = await seed([errorScript("http", 503)]);
    const entered = deferred(), release = deferred();
    const batch = s.platform.sql.batch.bind(s.platform.sql);
    vi.spyOn(s.platform.sql, "batch").mockImplementation(async (statements) => {
      if (statements.some((x) => x.sql.includes("INSERT INTO usage"))) { entered.resolve(); await release.promise; }
      return batch(statements);
    });
    const work = s.game.play(s.world.id, action, () => {});
    await entered.promise;
    work.stop();
    release.resolve();
    await work.done;
    expect(s.llm.calls).toHaveLength(1);
    expect(await rows(s.platform)).toHaveLength(1);
    expect((await tree.cursor(s.game.repo, s.world.id)).head.id).toBe(s.node.id);
    expect(s.notifications).toEqual([]);
  });

  it("keeps primary player-opening extraction as one auxiliary-model usage row", async () => {
    const s = await prepare([{ text: JSON.stringify({ time: 0, money: 20, choices: [] }) }]);
    expect(await s.game.createWorld({ ...draft, opening: { mode: "player", text: "我坐在船舱里。" } }, () => {})).toBeTruthy();
    expect(await rows(s.platform)).toHaveLength(1);
    expect((await rows(s.platform))[0]).toMatchObject({ model: "aux", prompt_tokens: 100, completion_tokens: 50 });
  });

  it("marks a partially reported token count as estimated (compatible with nullable ChatUsage)", async () => {
    const s = await seed();
    // Exercise the Game usage boundary independently of the parser fix landing on main.
    const result = { text: "完成。", finishReason: "stop", firstTokenMs: 1, totalMs: 2,
      usage: { promptTokens: 100, completionTokens: null } } as unknown as ChatResult;
    await s.platform.sql.batch([s.game["usage"](s.world.id, s.node.id, "turn", result, "ok", "story")]);
    expect((await rows(s.platform))[0]).toMatchObject({ prompt_tokens: 100, completion_tokens: null, estimated: 1 });
    expect(await monthSpend(s.platform, PRICES)).toMatchObject({ calls: 1, unknown: 1, knownCost: null });
  });
});
