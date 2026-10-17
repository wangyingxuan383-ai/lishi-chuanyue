import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { exportWorld, importWorld } from "./archive";
import { Game, type NewWorld, type TurnEvent } from "./game";
import { CODEX_FREE_PROMPT_VERSION, CODEX_PROMPT_VERSION, codexPatch } from "./prompt/codex";
import { fakeLlm, RECORD, type Script } from "./testing/fakeLlm";
import { sampleState } from "./testing/fixtures";
import { worldBlock } from "./timeline";
import * as tree from "./tree";

// The 天下大事 timeline (R05-T004, restored in R14): new history worlds get the great events
// on the player's 记事 page; the narrator only ever hears of events whose time has come (D129).
const LLM = { slot: "test", url: "https://test.invalid/v1/chat/completions", model: "story", auxModel: "aux", includeUsage: true };
const MING = { era: "天启", year: 7, month: 8, day: 1, ceYear: 1627 };
const opening = (date: Record<string, unknown>) => "你在京师的客店里醒来。" + RECORD({ date, hour: 8, money: 500, currency: [{ name: "两", value: 1000 }, { name: "文", value: 1 }] });
const ORGANIZED = JSON.stringify({
  era: { name: "明 · 天启七年 · 京师", content: "时局：新帝即位，阉党人心惶惶。\n货币：银两与铜钱并用。\n不要出现：火柴（用火石、火镰）；土豆、玉米" },
  timeline: [
    { date: "天启七年十一月", title: "魏忠贤自缢于阜城", kind: "可变" },
    // The next reign can only be counted from 天启 by its CE year.
    { date: "崇祯二年十月", ceYear: 1629, title: "后金兵临京师", kind: "固定" },
    { date: "某年", title: "说不清的事" },
  ],
});
const draft = (patch: Partial<NewWorld> = {}, settings: Partial<NewWorld["settings"]> = {}): NewWorld => ({
  title: "京师", eraId: null, organize: true,
  settings: { premise: "天启七年秋，北京。", autoUpkeep: false, chapterEvery: 0, fortune: "off", choiceCount: 3, ...settings },
  protagonist: { name: "陆安", age: 22, gender: "男", identity: "你是寄居客店的落第举子。" }, arrival: "魂穿", origin: "历史系研究生",
  opening: { mode: "ai", hint: "" }, ...patch,
});

async function begin(scripts: Script[], input: NewWorld) {
  const llm = fakeLlm(scripts);
  const platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, LLM);
  const events: TurnEvent[] = [];
  const worldId = (await game.createWorld(input, (e) => events.push(e)))!;
  expect(events.at(-1)?.type).toBe("done");
  return { llm, platform, game, worldId };
}
const head = async (game: Game, worldId: string) => (await tree.cursor(game.repo, worldId)).head;
const stateOf = async (game: Game, worldId: string) => game.repo.getState((await head(game, worldId)).id);
const request = (llm: ReturnType<typeof fakeLlm>, i: number) => JSON.stringify(llm.calls[i].body.messages);
async function turn(game: Game, worldId: string, text: string, mode: "do" | "skip" = "do") {
  const events: TurnEvent[] = [];
  await game.play(worldId, { mode, text }, (e) => events.push(e)).done;
  return events.find((e) => e.type === "done") as Extract<TurnEvent, { type: "done" }>;
}

describe("the great events of a new history world", () => {
  it.each([undefined, "history"] as const)("places the organizer's events for a real dynasty, shows them to the player and tells the narrator only once they happen (mode %s)", async (mode) => {
    const { game, worldId, llm } = await begin([
      { text: opening(MING) }, { text: ORGANIZED },
      { text: "你出门打听消息。" + RECORD({ time: "一刻" }) },
      { text: "四个月过去了。" + RECORD({ time: "四个月" }) },
      { text: "你听说了阜城的事。" + RECORD({ time: "一刻" }) },
    ], draft({}, { mode }));
    const opened = await head(game, worldId);
    expect(opened.meta.codexPromptVersion).toBe(CODEX_PROMPT_VERSION);
    expect(llm.calls[1].body.messages[0].content).toContain("另列故事开始之后几年里史书记载的大事");
    const timeline = (await stateOf(game, worldId)).timeline!;
    expect(timeline.map((e) => [e.title, e.kind, e.source])).toEqual([
      ["魏忠贤自缢于阜城", "可变", "AI"], ["后金兵临京师", "固定", "AI"], ["说不清的事", "可变", "AI"],
    ]);
    const [wei, jin, vague] = timeline;
    expect(wei.atMinute! / 1440).toBeGreaterThan(80);
    expect(wei.atMinute! / 1440).toBeLessThan(100);
    expect(jin).toMatchObject({ date: "崇祯二年 十月", ceYear: 1629 });
    expect(jin.atMinute! / 1440).toBeGreaterThan(700);
    expect(vague.atMinute).toBeNull();
    // The era card keeps its short list of era words.
    expect((await stateOf(game, worldId)).cards.find((c) => c.kind === "时代")?.content).toContain("不要出现：火柴（用火石、火镰）；土豆、玉米");

    // Neither an ordinary turn nor 过些日子 is told what the books say comes next.
    await turn(game, worldId, "出门打听消息");
    const skipped = await turn(game, worldId, "过四个月；这段时间读书", "skip");
    for (const i of [2, 3]) expect(request(llm, i)).not.toMatch(/魏忠贤自缢|后金兵临京师|说不清的事|将会|一定发生/);
    // Crossing the event shows the 📜 chip; the next request has it as something that has happened.
    expect(skipped.chips.map((c) => c.text)).toContain("📜 按史书，此时应有：魏忠贤自缢于阜城");
    await turn(game, worldId, "去茶馆");
    expect(request(llm, 4)).toContain("【天下大事】");
    expect(request(llm, 4)).toContain("魏忠贤自缢于阜城（按史书；若【历史偏离】改变了它，以偏离为准）");
    expect(request(llm, 4)).not.toMatch(/后金兵临京师|说不清的事/);
  });

  it("gives free worlds and invented settings without a CE date no great events", async () => {
    const free = await begin([{ text: opening(MING) }, { text: ORGANIZED }], draft({}, { mode: "free" }));
    expect((await stateOf(free.game, free.worldId)).timeline ?? []).toEqual([]);
    expect((await head(free.game, free.worldId)).meta.codexPromptVersion).toBe(CODEX_FREE_PROMPT_VERSION);
    expect(free.llm.calls[1].body.messages[0].content).not.toContain("史书记载的大事");
    // An invented dynasty: the opening has no CE year, so whatever the organizer listed is not placed.
    const invented = await begin([{ text: opening({ era: "景和", year: 3, month: 2, day: 1 }) }, { text: ORGANIZED }], draft({}, { premise: "架空王朝大胤，景和三年。" }));
    const state = await stateOf(invented.game, invented.worldId);
    expect(state.timeline ?? []).toEqual([]);
    expect(state.cards.find((c) => c.kind === "时代")?.name).toBe("明 · 天启七年 · 京师");
  });

  it("still copies a pack's events, and organizing again only fills a timeline that has none", async () => {
    const pack = await begin([{ text: "你醒来。" + RECORD({}) }, { text: ORGANIZED }], draft({ eraId: "tang-748", organize: false }));
    const packTimeline = (await stateOf(pack.game, pack.worldId)).timeline!;
    expect(packTimeline.length).toBeGreaterThan(10);
    expect(packTimeline.every((e) => e.source === "卡组")).toBe(true);
    expect(await pack.game.organize(pack.worldId)).not.toBeNull();
    expect((await stateOf(pack.game, pack.worldId)).timeline).toEqual(packTimeline);

    // A packless history world started without organizing: one pass fills the timeline, the next adds nothing.
    const plain = await begin([{ text: opening(MING) }, { text: ORGANIZED }, { text: JSON.stringify({ timeline: JSON.parse(ORGANIZED).timeline }) }], draft({ organize: false }));
    expect((await stateOf(plain.game, plain.worldId)).timeline ?? []).toEqual([]);
    const organized = await plain.game.organize(plain.worldId);
    expect(organized?.head.actionText).toBe("AI 整理了设定集：时代卡；年表记下 3 件史书大事");
    const filled = (await stateOf(plain.game, plain.worldId)).timeline!;
    expect(filled.map((e) => e.title)).toEqual(["魏忠贤自缢于阜城", "后金兵临京师", "说不清的事"]);
    expect(await plain.game.organize(plain.worldId)).toBeNull();
    expect((await stateOf(plain.game, plain.worldId)).timeline).toEqual(filled);
  });

  it("caps what one organizing pass may add", () => {
    const many = JSON.stringify({ timeline: Array.from({ length: 12 }, (_, i) => ({ date: `天启七年${i + 1}月`, title: `事${i}` })) });
    expect(codexPatch(many, sampleState())?.timeline).toHaveLength(8);
  });

  it.each([true, false])("checks the organizer's short list of era words and reminds the next turn only when reminders are on (%s)", async (tabooHints) => {
    const { game, worldId, llm } = await begin([
      { text: opening(MING) }, { text: ORGANIZED },
      { text: "你划了一根火柴，点亮油灯。" + RECORD({}) },
      { text: "灯下，你展开那封信。" + RECORD({}) },
    ], draft({}, { tabooHints }));
    const first = await turn(game, worldId, "点灯");
    // Developer mode always sees the hit; the narrator is reminded only with 用词提醒 on.
    expect(first.node.meta.taboos).toEqual([{ term: "火柴", instead: "火石、火镰" }]);
    await turn(game, worldId, "看信");
    expect(request(llm, 3).includes("【用词提醒】上一段用了这个时代不该有的说法：“火柴”（该用：火石、火镰）")).toBe(tabooHints);
  });

  it("leaves old saves' handwritten, pack and AI events as they were through reopen, organize and import", async () => {
    const invented = { timeline: [{ op: "add", date: "天宝八载六月", title: "模型又排的战事", kind: "固定" }], deviation: "模型预写的改史" };
    const organized = { era: { name: "长安参考", content: "当地使用铜钱。" }, ...invented };
    const llm = fakeLlm([{ text: JSON.stringify(organized) }, { text: JSON.stringify(invented) }]);
    const platform = await createMemoryPlatform(llm);
    const game = await Game.open(platform, LLM);
    const state = sampleState();
    state.timeline = [
      { id: "handwritten", date: "天宝七载冬月", atMinute: 60, title: "我与朋友的约定", kind: "固定", source: "玩家" },
      { id: "old-pack", date: "天宝八载六月", atMinute: 200 * 1440, title: "旧卡组事件", kind: "固定", source: "卡组" },
      { id: "old-ai", date: "天宝八载七月", atMinute: 230 * 1440, title: "旧整理事件", kind: "可变", source: "AI" },
    ];
    const original = structuredClone(state.timeline);
    const { world } = await game.repo.createWorld({ title: "旧世界", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: "旧开场", state } });
    const reopened = await Game.open(await createMemoryPlatform(llm, { data: platform.exportDb() }), LLM);
    const organizedCursor = await reopened.organize(world.id);
    expect((await reopened.repo.getState(organizedCursor!.head.id)).timeline).toEqual(original);
    expect(await reopened.organize(world.id)).toBeNull(); // A timeline-only reply cannot create an edit node.
    expect((await tree.cursor(reopened.repo, world.id)).head.id).toBe(organizedCursor!.head.id);
    const archive = await exportWorld(reopened.repo, world.id);
    const imported = await Game.open(await createMemoryPlatform());
    for (const mode of ["replace", "new"] as const) {
      const id = await importWorld(imported.repo, archive, mode);
      const cursor = await tree.cursor(imported.repo, id);
      const saved = await imported.repo.getState(cursor.head.id);
      expect(saved.timeline).toEqual(original);
      // The narrator hears of the appointment only once its minute has come.
      expect(worldBlock(saved)).not.toContain("我与朋友的约定");
      expect(worldBlock({ ...saved, time: { ...saved.time, elapsedMinutes: 61 } })).toContain("天宝七载冬月：我与朋友的约定");
      const changed = await imported.editState(id, {
        timeline: [{ op: "remove", id: "handwritten" }, { op: "add", date: "天宝八载正月", title: "改约正月见面", kind: "可变" }],
      }, "修改约定");
      const events = (await imported.repo.getState(changed.head.id)).timeline!;
      expect(events.find((e) => e.title === "改约正月见面")?.source).toBe("玩家");
      expect(events.filter((e) => e.id.startsWith("old-"))).toEqual(original.slice(1));
      expect(events.some((e) => e.id === "handwritten")).toBe(false);
      const undone = await tree.undo(imported.repo, changed);
      expect((await imported.repo.getState(undone.head.id)).timeline).toEqual(original);
    }
  });
});
