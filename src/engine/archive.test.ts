import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { archiveProblems, exportWorld, importWorld } from "./archive";
import { migrate } from "./db/migrate";
import { Repo } from "./db/repo";
import { newChallenge, newScript } from "./modes";
import { sampleState } from "./testing/fixtures";
import * as tree from "./tree";
import { DEFAULT_SETTINGS } from "./types";

async function emptyRepo() {
  const platform = await createMemoryPlatform();
  await migrate(platform);
  return new Repo(platform);
}

/** A world with turns, a second line, a bookmark, a pin and a chapter. */
async function richWorld(repo: Repo) {
  const { world } = await repo.createWorld({ title: "长安", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState() } });
  let c = await tree.cursor(repo, world.id);
  for (const t of ["一", "二", "三"]) c = await tree.append(repo, c, { kind: "turn", actionMode: "do", actionText: t, narrative: `第${t}段`, state: sampleState(300 + t.length), meta: { chips: [{ text: t, tone: "info" }] } });
  const side = await repo.createLine(world.id, (await repo.path(c.head.id))[1].id, "岔路", false);
  await tree.addBookmark(repo, world.id, c.head.id, "书签");
  await repo.addPin(world.id, c.head.id, "王掌柜是舅舅");
  await repo.addChapter({ worldId: world.id, firstNodeId: (await repo.path(c.head.id))[1].id, lastNodeId: c.head.id, title: "第一章", gist: "梗概", summary: "摘要", model: "aux", promptVersion: "chapter-1" });
  return { worldId: world.id, side };
}

/** Everything about a world except its ids, to compare two copies. */
async function content(repo: Repo, worldId: string) {
  const c = await tree.cursor(repo, worldId);
  const path = await repo.path(c.head.id);
  return {
    path: path.map((n) => [n.kind, n.actionText, n.narrative, n.meta]),
    states: await Promise.all(path.map((n) => repo.getState(n.id))),
    lines: (await repo.lines(worldId)).map((l) => [l.name, l.kind]),
    pins: (await repo.pinsOnPath(worldId, c.head.id)).map((p) => p.text),
    chapters: (await repo.chaptersOnPath(worldId, c.head.id)).map((x) => [x.title, x.gist, x.summary]),
  };
}

describe("world archive", () => {
  it("exports version three and continues to read version-one/two historical archives", async () => {
    const repo = await emptyRepo();
    const { worldId } = await richWorld(repo);
    const file = await exportWorld(repo, worldId);
    expect(file.version).toBe(3);
    const old = { ...file, version: 1 };
    const copy = await importWorld(repo, old, "new");
    expect(await content(repo, copy)).toEqual(await content(repo, worldId));
    const copyTwo = await importWorld(repo, { ...file, version: 2 }, "new");
    expect(await content(repo, copyTwo)).toEqual(await content(repo, worldId));
    expect(archiveProblems({ ...file, version: 0 })).toEqual(["存档格式版本无效"]);
  });
  it("round-trips a world to another device unchanged, ids included", async () => {
    const a = await emptyRepo();
    const { worldId } = await richWorld(a);
    const file = JSON.parse(JSON.stringify(await exportWorld(a, worldId)));
    const b = await emptyRepo();
    expect(await importWorld(b, file, "replace")).toBe(worldId);
    expect(await content(b, worldId)).toEqual(await content(a, worldId));
    expect((await b.getWorld(worldId))!.title).toBe("长安");
  });

  it("keeps the old world and saves the import under new ids, or replaces it", async () => {
    const repo = await emptyRepo();
    const { worldId } = await richWorld(repo);
    const file = JSON.parse(JSON.stringify(await exportWorld(repo, worldId)));
    const copy = await importWorld(repo, file, "new");
    expect(copy).not.toBe(worldId);
    expect((await repo.listWorlds()).map((w) => w.title).sort()).toEqual(["长安", "长安（导入）"]);
    expect(await content(repo, copy)).toEqual(await content(repo, worldId));
    expect(await importWorld(repo, file, "replace")).toBe(worldId);
    expect((await repo.listWorlds())).toHaveLength(2);
  });

  it("rejects a damaged file without touching the database", async () => {
    const repo = await emptyRepo();
    const { worldId } = await richWorld(repo);
    const file = JSON.parse(JSON.stringify(await exportWorld(repo, worldId)));
    const before = await content(repo, worldId);
    expect(archiveProblems({ format: "其他" })).toEqual(["这不是本游戏导出的世界文件"]);
    expect(archiveProblems({ ...file, version: 99 })).toEqual(["这个文件来自更新的版本，请先更新游戏"]);
    const broken = { ...file, states: file.states.slice(1) };
    expect(archiveProblems(broken)).toContain("有的回合缺少状态");
    await expect(importWorld(repo, broken, "replace")).rejects.toThrow("有的回合缺少状态");
    expect(await content(repo, worldId)).toEqual(before);
    expect(await repo.listWorlds()).toHaveLength(1);
  });
});

describe("play modes in a world file", () => {
  async function modesWorld(repo: Repo) {
    const state = sampleState();
    state.script = newScript({ line: "主线", beats: ["甲", "乙"], ending: "" });
    state.challenge = newChallenge({ goal: "凑够三百两", limit: "十日", failIf: "" }, 0);
    const { world } = await repo.createWorld({ title: "长安", eraId: "tang-748", settings: { ...DEFAULT_SETTINGS, pilot: "ai" }, opening: { parentId: null, kind: "opening", narrative: "开场", state } });
    const c = await tree.cursor(repo, world.id);
    const next = structuredClone(state);
    next.script!.beats[0] = { ...next.script!.beats[0], status: "done", endedMinute: 15 };
    await tree.append(repo, c, { kind: "turn", actionMode: "continue", actionText: "", narrative: "第一段", state: next });
    return world.id;
  }

  it("carries the script, the challenge and 旁观 to another device unchanged", async () => {
    const a = await emptyRepo();
    const worldId = await modesWorld(a);
    const file = JSON.parse(JSON.stringify(await exportWorld(a, worldId)));
    const b = await emptyRepo();
    await importWorld(b, file, "replace");
    expect(await content(b, worldId)).toEqual(await content(a, worldId));
    expect((await b.getWorld(worldId))!.settings.pilot).toBe("ai");
    expect((await content(b, worldId)).states[1].script!.beats[0]).toMatchObject({ status: "done", endedMinute: 15 });
  });

  it("drops mode fields it cannot read instead of refusing the whole file", async () => {
    const a = await emptyRepo();
    const worldId = await modesWorld(a);
    const file = JSON.parse(JSON.stringify(await exportWorld(a, worldId)));
    const broken = JSON.parse(file.states[0].state_json);
    file.states[0].state_json = JSON.stringify({ ...broken, script: { beats: "甲乙" }, challenge: { goal: "", status: "active", startedMinute: 0 } });
    file.world.settings_json = JSON.stringify({ ...JSON.parse(file.world.settings_json), pilot: "robot" });
    expect(archiveProblems(file)).toEqual([]);
    const b = await emptyRepo();
    await importWorld(b, file, "replace");
    const imported = await content(b, worldId);
    expect(imported.states[0]).not.toHaveProperty("script");
    expect(imported.states[0]).not.toHaveProperty("challenge");
    expect(imported.states[0].protagonist).toEqual(broken.protagonist);
    expect(imported.states[1]).toEqual((await content(a, worldId)).states[1]);
    expect((await b.getWorld(worldId))!.settings).not.toHaveProperty("pilot");
  });
});
