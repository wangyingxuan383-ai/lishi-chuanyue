import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { exportWorld, importWorld } from "./archive";
import { Game } from "./game";
import { eraContext, eraPack } from "./era";
import { packCards } from "./era/card";
import { codexPatch } from "./prompt/codex";
import { fakeLlm } from "./testing/fakeLlm";
import { sampleState } from "./testing/fixtures";
import { packTimeline, worldBlock } from "./timeline";
import type { WorldState } from "./types";
import * as tree from "./tree";
const LLM = { slot: "test", url: "https://test.invalid/v1/chat/completions", model: "story", auxModel: "aux", includeUsage: true };
describe("stored history timelines", () => {
  it("organizing again only fills a timeline that has none", async () => {
    const organized = {
      era: { name: "明 · 天启七年 · 京师", content: "时局：新帝即位，阉党人心惶惶。\n货币：银两与铜钱并用。\n不要出现：火柴（用火石、火镰）；土豆、玉米" },
      timeline: [
        { date: "天启七年十一月", title: "魏忠贤自缢于阜城", kind: "可变" },
        { date: "崇祯二年十月", ceYear: 1629, title: "后金兵临京师", kind: "固定" },
        { date: "某年", title: "说不清的事" },
      ],
    };
    const seed = async (state: WorldState, eraId: string) => {
      const llm = fakeLlm([{ text: JSON.stringify(organized) }, { text: JSON.stringify({ timeline: organized.timeline }) }]);
      const game = await Game.open(await createMemoryPlatform(llm), LLM);
      const { world } = await game.repo.createWorld({ title: "历史样本", eraId, opening: { parentId: null, kind: "opening", narrative: "旧开场", state } });
      return { game, worldId: world.id };
    };
    const stateOf = async (game: Game, worldId: string) => game.repo.getState((await tree.cursor(game.repo, worldId)).head.id);
    const tang = eraPack("tang-748")!, state = sampleState();
    state.time.date = structuredClone(tang.start.date);
    Object.assign(state, packCards(tang));
    state.timeline = packTimeline(tang.timeline, eraContext(tang.id, state).clock).map((e, i) => ({ ...e, id: `event-${i}` }));
    const pack = await seed(state, tang.id), original = (await stateOf(pack.game, pack.worldId)).timeline!;
    expect(original.length).toBeGreaterThan(10);
    expect(original.every(e => e.source === "卡组")).toBe(true);
    expect(await pack.game.organize(pack.worldId)).not.toBeNull();
    expect((await stateOf(pack.game, pack.worldId)).timeline).toEqual(original);

    const ming = sampleState();
    ming.era.packId = null;
    ming.time = { start: "天启七年 八月初一", date: { era: "天启", year: 7, month: 8, day: 1, ceYear: 1627, lunar: true }, startHour: 8, elapsedMinutes: 0 };
    const plain = await seed(ming, "free");
    expect((await stateOf(plain.game, plain.worldId)).timeline ?? []).toEqual([]);
    const result = await plain.game.organize(plain.worldId);
    expect(result?.head.actionText).toBe("AI 整理了设定集：时代卡；年表记下 3 件史书大事");
    const filled = (await stateOf(plain.game, plain.worldId)).timeline!;
    expect(filled.map(e => e.title)).toEqual(["魏忠贤自缢于阜城", "后金兵临京师", "说不清的事"]);
    expect(await plain.game.organize(plain.worldId)).toBeNull();
    expect((await stateOf(plain.game, plain.worldId)).timeline).toEqual(filled);
  });

  it("caps what one organizing pass may add", () => {
    const many = JSON.stringify({ timeline: Array.from({ length: 12 }, (_, i) => ({ date: `天启七年${i + 1}月`, title: `事${i}` })) });
    expect(codexPatch(many, sampleState())?.timeline).toHaveLength(8);
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
