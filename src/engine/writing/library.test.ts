import { expect, it } from "vitest";
import { Game } from "../game";
import { createMemoryPlatform } from "../../platform/memory";
import { sampleState } from "../testing/fixtures";
import { PRESETS_KEY, ACTIONS_KEY, loadActions, loadPresets, savePreset } from "./library";
import { deletionPatch } from "./codex";
import * as tree from "../tree";

it("persists requirements without mixing story facts and preserves duplicate names", async () => {
  const platform = await createMemoryPlatform();
  const game = await Game.open(platform);
  await savePreset(game.repo, "市井", { directive: "多些对话", rules: "别代替我回答" });
  await savePreset(game.repo, "市井", { directive: "短一些", rules: "" });
  const reloaded = await Game.open(await createMemoryPlatform(undefined, { data: platform.exportDb() }));
  const list = await loadPresets(reloaded.repo);
  expect(list).toHaveLength(2);
  expect(list[0].id).not.toBe(list[1].id);
  expect(list[0]).toMatchObject({ name: "市井", directive: "多些对话", rules: "别代替我回答" });
});

it("ignores malformed imported library entries", async () => {
  const game = await Game.open(await createMemoryPlatform());
  await game.repo.setSetting(PRESETS_KEY, [null, {}, { name: 2 }]);
  await game.repo.setSetting(ACTIONS_KEY, [{ id: "1", name: "继续", text: "", mode: "continue" }, { id: "2", name: "问路", text: "请问路", mode: "say" }]);
  expect(await loadPresets(game.repo)).toEqual([]);
  expect(await loadActions(game.repo)).toEqual([{ id: "2", name: "问路", text: "请问路", mode: "say" }]);
});

it("batch deletion is a single undoable edit and protects current place and era card", async () => {
  const game = await Game.open(await createMemoryPlatform());
  const state = sampleState();
  state.placeId = "here";
  state.places = [{ id: "here", name: "客栈", aliases: [], description: "落脚地" }, { id: "there", name: "书铺", aliases: [], description: "旧书" }];
  state.cards = [{ id: "era", kind: "时代", name: "时代", keys: [], content: "背景" }, { id: "guild", kind: "势力", name: "行会", keys: [], content: "商人" }];
  const { world, node } = await game.repo.createWorld({ title: "批量", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: "开场", state } });
  const patch = deletionPatch(state, [{ id: "here", kind: "地点" }, { id: "there", kind: "地点" }, { id: "guild", kind: "势力" }, { id: "guild", kind: "势力" }]);
  expect(patch.places).toEqual([{ op: "remove", id: "there" }]);
  expect(patch.cards).toEqual([{ op: "remove", id: "guild" }]);
  await game.editState(world.id, patch, "批量删除 2 项设定");
  const current = await tree.cursor(game.repo, world.id);
  expect((await game.repo.getState(current.head.id)).cards.map((c) => c.id)).toEqual(["era"]);
  expect(current.head.parentId).toBe(node.id);
  const undone = await tree.undo(game.repo, current);
  expect(await game.repo.getState(undone.head.id)).toEqual(state);
});
