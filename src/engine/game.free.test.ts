import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { archiveProblems, exportWorld, importWorld } from "./archive";
import { eraContext } from "./era";
import { Game } from "./game";
import { fakeLlm, type Script } from "./testing/fakeLlm";
import { sampleState } from "./testing/fixtures";
import * as tree from "./tree";

async function start() {
  const platform = await createMemoryPlatform();
  const game = await Game.open(platform);
  const state = sampleState(120);
  state.era = { mode: "free", clockStyle: "elapsed", packId: null, currency: { units: [{ name: "星币", value: 1 }] } };
  state.time = { start: "", date: null, startHour: 23, elapsedMinutes: 0 };
  Object.assign(state.protagonist, { name: "林舟", gender: "女", age: 220, identity: "星舰船长", origin: "" });
  state.protagonist.panel = "驾驶：熟练";
  state.protagonist.items = [{ name: "电池", quantity: 2, unit: "个", place: null, note: "" }];
  state.places = [{ id: "port", name: "港口", description: "" }];
  state.placeId = "port";
  state.people = [{ id: "navigator", name: "阿洛", aliases: [], role: "领航员", attitude: "一般", alive: true, notes: "借给你导航图", lastSeenMinute: 0 }];
  state.cards = [
    { id: "world-card", kind: "时代", name: "星海", keys: [], content: "货币：星币。居民可以使用电池。", source: "AI" },
    { id: "guild", kind: "势力", name: "航行会", keys: ["飞船协会"], content: "受托保管导航图。", source: "AI" },
  ];
  const { world } = await game.repo.createWorld({ title: "远航", eraId: "free", settings: { mode: "free", heroPanelEnabled: true }, opening: { parentId: null, kind: "opening", narrative: "你在星港醒来。", state } });
  return { platform, game, worldId: world.id };
}
async function current(game: Game, worldId: string) {
  const cursor = await tree.cursor(game.repo, worldId);
  return { cursor, state: await game.repo.getState(cursor.head.id) };
}
describe("local free-world snapshots", () => {
  it("keeps free snapshots and branch-local panels through DB reopen and both archive import modes", async () => {
    const { game, platform, worldId } = await start();
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
  });

  it("preserves existing worlds after failed organization and rejected or rolled-back imports", async () => {
    const fail: Script = [{ type: "error", kind: "http", status: 401, message: "scripted failure" }];
    const { game: original, worldId } = await start();
    const game = await Game.open({ ...original.platform, llm: fakeLlm([fail]) }, { slot: "test", url: "https://test.invalid", model: "story", includeUsage: false });
    const before = await current(game, worldId);
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
