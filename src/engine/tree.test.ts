import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { migrate } from "./db/migrate";
import { Repo } from "./db/repo";
import { sampleState } from "./testing/fixtures";
import * as tree from "./tree";

let repo: Repo;
let c: tree.Cursor;

const turn = (text: string, money = 300) => ({ kind: "turn" as const, actionMode: "do" as const, actionText: text, narrative: text, state: sampleState(money) });
const texts = async (cur: tree.Cursor) => (await repo.path(cur.head.id)).map((n) => n.narrative);

beforeEach(async () => {
  const platform = await createMemoryPlatform();
  await migrate(platform);
  repo = new Repo(platform);
  const { world } = await repo.createWorld({
    title: "长安", eraId: "tang-748",
    opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState() },
  });
  c = await tree.cursor(repo, world.id);
});

describe("turn tree", () => {
  it("appends along the current line", async () => {
    c = await tree.append(repo, c, turn("一"));
    c = await tree.append(repo, c, turn("二"));
    expect(await texts(c)).toEqual(["开场", "一", "二"]);
    expect(await texts(await tree.cursor(repo, c.worldId))).toEqual(["开场", "一", "二"]);
  });

  it("keeps every variant and switches between them", async () => {
    c = await tree.append(repo, c, turn("一"));
    c = await tree.append(repo, c, turn("二甲"));
    c = await tree.addVariant(repo, c, turn("二乙"));
    c = await tree.addVariant(repo, c, turn("二丙"));
    let v = await tree.variants(repo, c.head);
    expect([v.index, v.count]).toEqual([2, 3]);
    c = await tree.switchVariant(repo, c, 0);
    expect(await texts(c)).toEqual(["开场", "一", "二甲"]);
    v = await tree.variants(repo, c.head);
    expect([v.index, v.count]).toEqual([0, 3]);
  });

  it("undo and redo move the head without deleting anything", async () => {
    c = await tree.append(repo, c, turn("一"));
    c = await tree.append(repo, c, turn("二"));
    c = await tree.undo(repo, c);
    expect(await texts(c)).toEqual(["开场", "一"]);
    expect(tree.canRedo(c)).toBe(true);
    c = await tree.redo(repo, c);
    expect(await texts(c)).toEqual(["开场", "一", "二"]);
  });

  it("acting after a short undo leaves the old turn only in the tree", async () => {
    c = await tree.append(repo, c, turn("一"));
    c = await tree.append(repo, c, turn("二"));
    c = await tree.undo(repo, c);
    c = await tree.append(repo, c, turn("二新"));
    expect(await texts(c)).toEqual(["开场", "一", "二新"]);
    expect(await tree.listedLines(repo, c.worldId)).toHaveLength(1);
  });

  it("acting after undoing a long stretch keeps that stretch as an unnamed line", async () => {
    for (const t of ["一", "二", "三", "四"]) c = await tree.append(repo, c, turn(t));
    for (let i = 0; i < 3; i++) c = await tree.undo(repo, c);
    c = await tree.append(repo, c, turn("另起"));
    const lines = await tree.listedLines(repo, c.worldId);
    expect(lines).toHaveLength(2);
    const kept = lines.find((l) => l.autoNamed)!;
    expect((await repo.path(kept.nodeId)).map((n) => n.narrative)).toEqual(["开场", "一", "二", "三", "四"]);
    expect(await texts(c)).toEqual(["开场", "一", "另起"]);
  });

  it("go back: short distance moves the line, long distance opens a new line", async () => {
    for (const t of ["一", "二", "三", "四"]) c = await tree.append(repo, c, turn(t));
    const path = await repo.path(c.head.id);
    const near = await tree.goBackTo(repo, c, path[3].id); // 1 turn ahead
    expect(await texts(near)).toEqual(["开场", "一", "二", "三"]);
    expect(await tree.listedLines(repo, c.worldId)).toHaveLength(1);

    c = await tree.redo(repo, near);
    const far = await tree.goBackTo(repo, c, path[1].id); // 3 turns ahead
    expect(far.line.id).not.toBe(c.line.id);
    expect(await texts(far)).toEqual(["开场", "一"]);
    const original = (await repo.getLine(c.line.id))!;
    expect((await repo.path(original.nodeId)).map((n) => n.narrative)).toEqual(["开场", "一", "二", "三", "四"]);
    const branched = await tree.append(repo, far, turn("二'"));
    expect(await texts(branched)).toEqual(["开场", "一", "二'"]);
    expect((await repo.path((await repo.getLine(c.line.id))!.nodeId)).map((n) => n.narrative)).toEqual(["开场", "一", "二", "三", "四"]);
  });

  it("each line keeps its own state snapshot", async () => {
    for (const [t, m] of [["一", 290], ["二", 280], ["三", 270], ["四", 260]] as const) c = await tree.append(repo, c, turn(t, m));
    const path = await repo.path(c.head.id);
    const far = await tree.goBackTo(repo, c, path[1].id);
    const other = await tree.append(repo, far, turn("另一种", 500));
    expect((await repo.getState(other.head.id)).protagonist.stats.money).toBe(500);
    const back = await tree.switchLine(repo, c.worldId, c.line.id);
    expect((await repo.getState(back.head.id)).protagonist.stats.money).toBe(260);
  });
});
