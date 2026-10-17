import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import type { Platform } from "../../platform";
import { sampleState } from "../testing/fixtures";
import { migrate } from "./migrate";
import { MIGRATIONS } from "./migrations";
import { Repo } from "./repo";

let platform: Platform;
let repo: Repo;

beforeEach(async () => {
  platform = await createMemoryPlatform();
  await migrate(platform);
  repo = new Repo(platform);
});

describe("migrate", () => {
  it("applies all migrations once", async () => {
    expect(await migrate(platform)).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    const rows = await platform.sql.query("SELECT COUNT(*) AS n FROM schema_version");
    expect(rows[0].n).toBe(MIGRATIONS.length);
  });
});

describe("Repo", () => {
  it("creates a world with opening node, state and main line", async () => {
    const { world, node, line } = await repo.createWorld({
      title: "长安", eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "你醒来。", choices: ["起身"], state: sampleState() },
    });
    expect(world.currentLineId).toBe(line.id);
    expect(line.nodeId).toBe(node.id);
    expect(node.choices).toEqual(["起身"]);
    expect((await repo.getState(node.id)).protagonist.stats.money).toBe(300);
    expect(world.settings.length).toBe("中");
  });

  it("appends nodes atomically and reads the path oldest first without states", async () => {
    const { world, node: root, line } = await repo.createWorld({
      title: "长安", eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState() },
    });
    let parent = root;
    for (let i = 1; i <= 5; i++) {
      parent = await repo.appendNode(world.id, line.id, {
        parentId: parent.id, kind: "turn", actionMode: "do", actionText: `行动${i}`, narrative: `第${i}段`, state: sampleState(300 - i),
      });
    }
    const path = await repo.path(parent.id);
    expect(path.map((n) => n.narrative)).toEqual(["开场", "第1段", "第2段", "第3段", "第4段", "第5段"]);
    expect((await repo.path(parent.id, 2)).map((n) => n.narrative)).toEqual(["第4段", "第5段"]);
    expect((await repo.getLine(line.id))!.nodeId).toBe(parent.id);
    expect((await repo.getNode(root.id))!.lastChildId).toBe(path[1].id);
    expect((await repo.getState(parent.id)).protagonist.stats.money).toBe(295);
  });

  it("applies a pin only while its origin is on the path", async () => {
    const { world, node: root, line } = await repo.createWorld({
      title: "长安", eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState() },
    });
    const a = await repo.appendNode(world.id, line.id, { parentId: root.id, kind: "turn", narrative: "甲", state: sampleState() });
    const b = await repo.appendNode(world.id, line.id, { parentId: a.id, kind: "turn", narrative: "乙", state: sampleState() });
    const branch = await repo.appendNode(world.id, line.id, { parentId: root.id, kind: "turn", narrative: "另一条路", state: sampleState() });
    const pin = await repo.addPin(world.id, a.id, "  王掌柜欠主角一个人情 ");
    expect(pin.text).toBe("王掌柜欠主角一个人情");
    expect((await repo.pinsOnPath(world.id, b.id)).map((p) => p.text)).toEqual(["王掌柜欠主角一个人情"]);
    expect(await repo.pinsOnPath(world.id, a.id)).toHaveLength(1);
    expect(await repo.pinsOnPath(world.id, root.id)).toEqual([]);
    expect(await repo.pinsOnPath(world.id, branch.id)).toEqual([]);
    await repo.deletePin(pin.id);
    expect(await repo.pinsOnPath(world.id, b.id)).toEqual([]);
  });

  it("rolls back the whole append when one statement fails", async () => {
    const { world, node: root, line } = await repo.createWorld({
      title: "长安", eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState() },
    });
    await expect(repo.appendNode(world.id, line.id, {
      parentId: root.id, kind: "turn", narrative: "不会留下", state: sampleState(),
    }, [{ sql: "INSERT INTO no_such_table VALUES (1)" }])).rejects.toThrow();
    expect(await repo.children(root.id)).toHaveLength(0);
    expect((await repo.getLine(line.id))!.nodeId).toBe(root.id);
  });

  it("deletes a world with everything under it", async () => {
    const { world } = await repo.createWorld({
      title: "长安", eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState() },
    });
    await repo.deleteWorld(world.id);
    expect(await repo.listWorlds()).toHaveLength(0);
    expect((await platform.sql.query("SELECT COUNT(*) AS n FROM states"))[0].n).toBe(0);
  });
});
