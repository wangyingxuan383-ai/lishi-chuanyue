import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { archiveProblems, exportWorld, importWorld } from "./archive";
import { nowOf } from "./calendar/clock";
import { eraContext } from "./era";
import { Game, type NewWorld, type TurnEvent } from "./game";
import { fakeLlm, RECORD, type Script } from "./testing/fakeLlm";
import { sampleState } from "./testing/fixtures";
import * as tree from "./tree";

// All calls use scripted SSE on the memory platform. No secret store or network is used.
const LLM = { slot: "test", url: "https://test.invalid/v1/chat/completions", model: "story", auxModel: "aux", includeUsage: true };
const openingRecord = {
  hour: 23, date: "天宝七载冬月十七", money: 120,
  currency: [{ name: "星币", value: 1 }], place: "港口",
  items: [{ name: "电池", delta: 2 }], people: [{ name: "阿洛", role: "领航员", note: "借给你导航图" }],
  deviation: "不应记下的改史", timeline: [{ op: "add", date: "天宝八载正月", title: "不应记下的事件" }],
};
const OPENING = "你在星港醒来，阿洛把导航图递给你。" + RECORD(openingRecord);
const CODEX = JSON.stringify({
  era: { name: "星海", content: "货币：星币。\n居民可以使用电池。" },
  cards: [{ kind: "势力", name: "航行会", keys: ["飞船协会"], content: "受托保管导航图。" }],
  timeline: [{ date: "天宝八载正月", title: "不该生成的未来" }],
});
const draft = (patch: Partial<NewWorld> = {}): NewWorld => ({
  title: "远航", eraId: "tang-748", // A stale UI selection must not copy the Tang preset.
  settings: { mode: "free", premise: "一座星际港口。", fortune: "off", autoUpkeep: false, chapterEvery: 0, heroPanelEnabled: true, heroPanel: "驾驶：熟练" },
  protagonist: { name: "林舟", gender: "女", age: 220, identity: "星舰船长" },
  arrival: "不穿越", origin: "", opening: { mode: "ai", hint: "" }, ...patch,
});

async function start(scripts: Script[] = [], input = draft()) {
  const llm = fakeLlm([{ text: OPENING }, ...(input.organize ? [{ text: CODEX }] : []), ...scripts]);
  const platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, LLM);
  const events: TurnEvent[] = [];
  const worldId = (await game.createWorld(input, (e) => events.push(e)))!;
  expect(events.at(-1)?.type).toBe("done");
  return { platform, game, llm, worldId };
}

async function current(game: Game, worldId: string) {
  const cursor = await tree.cursor(game.repo, worldId);
  return { cursor, state: await game.repo.getState(cursor.head.id) };
}

async function play(game: Game, worldId: string) {
  const events: TurnEvent[] = [];
  await game.play(worldId, { mode: "do", text: "去找飞船协会的阿洛，用星币买电池" }, (e) => events.push(e)).done;
  await game.settled();
  return events;
}

describe("free mode on the native memory-platform engine", () => {
  it("opens without a Tang preset or timeline and keeps the opening's currency and panel seed", async () => {
    const { game, worldId, llm } = await start([], draft({ organize: true }));
    const { cursor, state } = await current(game, worldId);
    expect(state.era).toMatchObject({ mode: "free", clockStyle: "elapsed", packId: null, currency: { units: [{ name: "星币", value: 1 }] } });
    expect(state.era.calendar).toBeUndefined();
    expect(state.time).toMatchObject({ date: null, start: "", startHour: 23, elapsedMinutes: 0 });
    expect(nowOf(eraContext("tang-748", state).clock, 0).text).toBe("第 1 天 · 23:00");
    expect(state.protagonist).toMatchObject({ age: 220, panel: "驾驶：熟练", stats: { money: 120 } });
    expect(state.cards.map((c) => c.name)).toEqual(["星海", "航行会"]);
    expect(state.cards.filter((c) => c.kind === "时代")).toHaveLength(1);
    expect(state.places.map((p) => p.name)).toEqual(["港口"]);
    expect(state.timeline ?? []).toEqual([]);
    expect(state.deviations).toEqual([]);
    expect(cursor.head.meta.codexPromptVersion).toBe("codex-3");
    expect(llm.calls[1].body.messages[0].content).toContain("世界卡");
    expect(llm.calls[1].body.messages[0].content).not.toContain("历史互动小说");
  });

  it("advances, remembers people and cards, updates the world card in place and suppresses historical warnings", async () => {
    const turn = "阿洛收下五枚星币，给你一枚电池。你用了算盘清点。" + RECORD({ time: 90, money: "-5星币", items: [{ name: "电池", delta: 1 }], people: [{ name: "阿洛", note: "帮你采购电池" }], deviation: "改写史书" });
    const { game, worldId, llm } = await start([{ text: turn }, { text: JSON.stringify({ era: { name: "远航世界", content: "不要出现：算盘" }, timeline: [{ date: "天宝八载正月", title: "不该加入" }] }) }, { text: turn }], draft({ organize: true }));
    const original = (await current(game, worldId)).state.cards[0].id;
    expect((await play(game, worldId)).at(-1)?.type).toBe("done");
    const first = await current(game, worldId);
    expect(first.state.protagonist).toMatchObject({ age: 220, panel: "驾驶：熟练", stats: { money: 115 }, items: [expect.objectContaining({ name: "电池", quantity: 3 })] });
    expect(first.state.people[0]).toMatchObject({ notes: "帮你采购电池", origin: "借给你导航图" });
    expect(nowOf(eraContext(null, first.state).clock, first.state.time.elapsedMinutes).text).toBe("第 2 天 · 00:30");
    expect(JSON.stringify(llm.calls[2].body)).toContain("航行会");
    const edited = await game.organize(worldId);
    expect(edited?.head.actionText).toContain("世界卡");
    expect((await current(game, worldId)).state.cards[0]).toMatchObject({ id: original, kind: "时代", name: "远航世界" });
    expect((await play(game, worldId)).at(-1)?.type).toBe("done");
    const second = await current(game, worldId);
    expect(second.cursor.head.meta.taboos).toBeUndefined();
    expect(second.state.timeline ?? []).toEqual([]);
    expect(second.state.deviations).toEqual([]);
    expect(second.state.protagonist.stats.money).toBe(110);
    await tree.undo(game.repo, second.cursor);
    expect((await current(game, worldId)).state.protagonist.stats.money).toBe(115);
    await tree.redo(game.repo, await tree.cursor(game.repo, worldId));
    expect((await current(game, worldId)).state).toEqual(second.state);
  });

  it("supports a player-written opening and another game with the same snapshot seed", async () => {
    const llm = fakeLlm([{ text: JSON.stringify(openingRecord) }, { text: JSON.stringify(openingRecord) }]);
    const game = await Game.open(await createMemoryPlatform(llm), LLM);
    const input = draft({ opening: { mode: "player", text: "你把飞船停在星港。" } });
    const worldId = (await game.createWorld(input, () => {}))!;
    const original = await current(game, worldId);
    // A later settings seed must not replace the opening snapshot during restart.
    await game.repo.updateSettings(worldId, { ...(await game.repo.getWorld(worldId))!.settings, heroPanel: "错误的全局种子" });
    const setup = (await game.setupOf(worldId))!;
    expect(setup).toMatchObject({ eraId: null, settings: { mode: "free", clockStyle: "elapsed", heroPanel: "驾驶：熟练" } });
    const another = (await game.createWorld(setup, () => {}))!;
    expect(another).not.toBe(worldId);
    const again = await current(game, another);
    expect(again.cursor.head.narrative).toBe(input.opening.mode === "player" ? input.opening.text : "");
    expect(again.state.protagonist).toEqual(original.state.protagonist);
    expect(again.state.era).toEqual(original.state.era);
    expect((await current(game, worldId)).state).toEqual(original.state);
  });

  it("keeps free snapshots and branch-local panels through DB reopen and both archive import modes", async () => {
    const { game, platform, worldId } = await start([], draft({ organize: true }));
    const opening = await current(game, worldId);
    const state = structuredClone(opening.state);
    state.protagonist.panel = "驾驶：大师";
    const branch = await tree.append(game.repo, opening.cursor, { kind: "edit", narrative: "", actionText: "面板记录", state });
    await tree.addBookmark(game.repo, worldId, branch.head.id, "成长之后");
    await tree.undo(game.repo, branch);
    expect((await current(game, worldId)).state.protagonist.panel).toBe("驾驶：熟练");
    await tree.redo(game.repo, await tree.cursor(game.repo, worldId));
    const reopened = await Game.open(await createMemoryPlatform(undefined, { data: platform.exportDb() }));
    expect((await current(reopened, worldId)).state).toEqual(state);
    const archive = JSON.parse(JSON.stringify(await exportWorld(reopened.repo, worldId)));
    expect(archiveProblems(archive)).toEqual([]);
    const imported = await Game.open(await createMemoryPlatform());
    expect(await importWorld(imported.repo, archive, "replace")).toBe(worldId);
    const copy = await importWorld(imported.repo, archive, "new");
    expect(copy).not.toBe(worldId);
    for (const id of [worldId, copy]) {
      const head = await current(imported, id);
      expect(head.state).toEqual(state); // Includes unchanged card ids and snapshot flags.
      expect((await imported.repo.getWorld(id))!.settings).toMatchObject({ mode: "free", heroPanelEnabled: true });
      const prior = await tree.undo(imported.repo, head.cursor);
      expect((await imported.repo.getState(prior.head.id)).protagonist.panel).toBe("驾驶：熟练");
    }
  });

  it("runs automatic upkeep, questions and chapter summaries without history framing or timeline effects", async () => {
    const turns = Array.from({ length: 6 }, () => ({ text: "你和阿洛查验飞船。" + RECORD({ time: 15 }) }));
    const { game, worldId, llm } = await start([
      ...turns,
      { text: JSON.stringify({ cards: [{ kind: "设定", name: "跃迁", content: "跃迁需要充能。" }], timeline: [{ title: "不该加入", date: "天宝八载" }], deviation: "不该记录" }) },
      { text: "【本局】用星币买电池。" },
      { text: JSON.stringify({ title: "驶向星海", gist: "检查飞船", summary: "你和阿洛查验飞船，跃迁需要充能。" }) },
      { text: JSON.stringify({ title: "驶向星海", gist: "再次检查", summary: "你和阿洛完成了飞船检查。" }) },
    ], draft({ settings: { ...draft().settings, autoUpkeep: true }, organize: true }));
    for (let i = 0; i < 6; i++) expect((await play(game, worldId)).at(-1)?.type).toBe("done");
    const afterUpkeep = await current(game, worldId);
    expect(afterUpkeep.cursor.head).toMatchObject({ kind: "edit", meta: { promptVersion: "upkeep-4" } });
    expect(afterUpkeep.state.cards.some((c) => c.name === "跃迁")).toBe(true);
    expect(afterUpkeep.state.timeline ?? []).toEqual([]);
    expect(afterUpkeep.state.deviations).toEqual([]);
    expect(await game.ask(worldId, "买电池花什么钱？", () => {})).toContain("星币");
    expect((await current(game, worldId)).state).toEqual(afterUpkeep.state);
    const chapter = await game.writeChapter(worldId);
    expect(chapter?.promptVersion).toBe("chapter-2-free");
    expect((await game.rewriteChapter(worldId, chapter!.id))?.promptVersion).toBe("chapter-2-free");
    for (const call of llm.calls.filter((c) => c.body.model === "aux")) {
      expect(call.body.messages[0].content).not.toContain("历史互动小说");
      expect(call.body.messages[0].content).toContain("timeline");
    }
  });

  it("keeps legacy history worlds unmigrated through reopen, export/import and restart", async () => {
    const game = await Game.open(await createMemoryPlatform());
    const state = sampleState();
    const { world } = await game.repo.createWorld({ title: "旧历史", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "自定时代的旧开场", state } });
    const archive = await exportWorld(game.repo, world.id);
    const clone = await importWorld(game.repo, archive, "new");
    const saved = (await current(game, clone)).state;
    expect(saved).toEqual(state);
    expect(saved.era).not.toHaveProperty("mode");
    expect(eraContext("free", saved).mode).toBe("history");
    expect((await game.setupOf(clone))!.settings.mode).toBeUndefined();
    const { game: historical, worldId } = await start([], draft({ settings: { ...draft().settings, mode: undefined, heroPanel: undefined } }));
    const historyState = (await current(historical, worldId)).state;
    expect(historyState.era.packId).toBe("tang-748");
    // A history world started from the Tang pack has its great events again (R14); free worlds have none.
    expect(historyState.timeline?.length).toBeGreaterThan(0);
    expect(historyState.era.mode).toBeUndefined();
    expect((await historical.setupOf(worldId))!.eraId).toBe("tang-748");
  });

  it("preserves existing worlds after failed opening, turn, organization and rejected or rolled-back imports", async () => {
    const fail: Script = [{ type: "error", kind: "http", status: 401, message: "scripted failure" }];
    const { game, worldId } = await start([fail, fail, fail], draft({ organize: false }));
    const before = await current(game, worldId);
    expect(await game.createWorld(draft(), () => {})).toBeNull();
    expect((await play(game, worldId)).at(-1)).toMatchObject({ type: "failed", reason: "auth" });
    expect(await game.organize(worldId)).toBeNull();
    expect((await current(game, worldId)).state).toEqual(before.state);
    expect((await current(game, worldId)).cursor.head.id).toBe(before.cursor.head.id);
    const archive = await exportWorld(game.repo, worldId);
    await expect(importWorld(game.repo, { ...archive, states: [] }, "replace")).rejects.toThrow("有的回合缺少状态");
    // A duplicate SQL row fails inside the replacement transaction, after deletes began.
    const duplicate = { ...archive, nodes: [...archive.nodes, archive.nodes[0]] };
    expect(archiveProblems(duplicate)).toEqual([]);
    await expect(importWorld(game.repo, duplicate, "replace")).rejects.toThrow();
    expect((await current(game, worldId)).state).toEqual(before.state);
    expect((await current(game, worldId)).cursor.head.id).toBe(before.cursor.head.id);
    expect(await game.repo.listWorlds()).toHaveLength(1);
  });
});
