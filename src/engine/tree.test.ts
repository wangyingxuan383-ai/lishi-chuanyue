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

describe("world lines (R06-T001)", () => {
  /** A card unique to the branch, so states can be told apart. */
  const branchTurn = (n: number) => {
    const state = sampleState(300 + n);
    state.cards = [{ id: `k${n}`, kind: "设定", name: `第${n}路的规矩`, keys: [], content: `只属于第 ${n} 条路` }];
    return { kind: "turn" as const, actionMode: "do" as const, actionText: `走第${n}条路`, narrative: `第${n}条路`, state };
  };

  it("keeps ten branches apart: state, cards, chapters and pins", async () => {
    const opening = c.head;
    const ids: string[] = [];
    for (let n = 1; n <= 10; n++) {
      const line = await repo.createLine(c.worldId, opening.id, `第${n}条路`, false);
      await repo.setCurrentLine(c.worldId, line.id);
      let cur = await tree.cursor(repo, c.worldId);
      cur = await tree.append(repo, cur, branchTurn(n));
      await repo.addPin(c.worldId, cur.head.id, `第${n}路的要点`);
      await repo.addChapter({ worldId: c.worldId, firstNodeId: cur.head.id, lastNodeId: cur.head.id, title: `第${n}章`, gist: "", summary: "", model: null, promptVersion: null });
      ids.push(line.id);
    }
    for (let n = 1; n <= 10; n++) {
      const cur = await tree.switchLine(repo, c.worldId, ids[n - 1]);
      const state = await repo.getState(cur.head.id);
      expect(state.protagonist.stats.money).toBe(300 + n);
      expect(state.cards.map((k) => k.name)).toEqual([`第${n}路的规矩`]);
      expect((await repo.pinsOnPath(c.worldId, cur.head.id)).map((p) => p.text)).toEqual([`第${n}路的要点`]);
      expect((await repo.chaptersOnPath(c.worldId, cur.head.id)).map((x) => x.title)).toEqual([`第${n}章`]);
    }
  });

  it("deletes into the trash, restores, and purges only turns nothing else reaches", async () => {
    c = await tree.append(repo, c, turn("一"));
    const shared = c.head;
    c = await tree.append(repo, c, turn("二"));
    c = await tree.append(repo, c, turn("三"));
    // A second line from 一 with three turns of its own, then back to the main line.
    const branch = await repo.createLine(c.worldId, shared.id, "岔路", false);
    let b = await tree.switchLine(repo, c.worldId, branch.id);
    b = await tree.append(repo, b, turn("岔一"));
    const marked = b.head;
    b = await tree.append(repo, b, turn("岔二"));
    b = await tree.append(repo, b, turn("岔三"));
    await repo.addPin(c.worldId, b.head.id, "岔路上的要点");
    await tree.switchLine(repo, c.worldId, c.line.id);
    await expect(repo.setLineDeleted(c.line.id, true)).rejects.toThrow();

    await repo.setLineDeleted(branch.id, true);
    expect((await tree.listedLines(repo, c.worldId)).map((l) => l.name)).toEqual(["主线"]);
    await repo.setLineDeleted(branch.id, false);
    expect((await tree.listedLines(repo, c.worldId)).map((l) => l.name)).toEqual(["主线", "岔路"]);

    // A bookmark on 岔一 keeps it; only 岔二 and 岔三 go.
    await tree.addBookmark(repo, c.worldId, marked.id, "岔路口");
    await repo.setLineDeleted(branch.id, true);
    expect(await repo.purgeLine(branch.id)).toBe(2);
    expect((await repo.getNode(marked.id))?.narrative).toBe("岔一");
    expect(await repo.getNode(b.head.id)).toBeNull();
    expect(await repo.pinsOnPath(c.worldId, marked.id)).toEqual([]);
    expect(await texts(await tree.cursor(repo, c.worldId))).toEqual(["开场", "一", "二", "三"]);
    expect((await repo.lines(c.worldId)).map((l) => [l.name, l.kind])).toEqual([["主线", "line"], ["岔路口", "bookmark"]]);
  });

  it("purges the trash only after thirty days", async () => {
    c = await tree.append(repo, c, turn("一"));
    const branch = await repo.createLine(c.worldId, c.head.id, "岔路", false);
    await repo.setLineDeleted(branch.id, true);
    expect(await repo.purgeTrash(c.worldId)).toBe(0);
    expect(await repo.getLine(branch.id)).not.toBeNull();
    await repo.platform.sql.query("UPDATE lines SET deleted_at = ? WHERE id = ?", [new Date(Date.now() - 31 * 86_400_000).toISOString(), branch.id]);
    await repo.purgeTrash(c.worldId);
    expect(await repo.getLine(branch.id)).toBeNull();
    // Its node is still on the main line, so it stays.
    expect((await repo.getNode(c.head.id))?.narrative).toBe("一");
  });

  it("jumps to a bookmark: back along the path, or a new line elsewhere", async () => {
    c = await tree.append(repo, c, turn("一"));
    const one = c.head;
    c = await tree.append(repo, c, turn("二"));
    c = await tree.append(repo, c, turn("三"));
    // A passage on another branch, then back on the main line.
    const side = await tree.switchLine(repo, c.worldId, (await repo.createLine(c.worldId, one.id, "岔路", false)).id);
    const sideTurn = (await tree.append(repo, side, turn("岔一"))).head;
    await tree.switchLine(repo, c.worldId, c.line.id);
    const jumped = await tree.jumpTo(repo, c.worldId, sideTurn.id, "从书签继续");
    expect(jumped.head.narrative).toBe("岔一");
    expect(jumped.line.name).toBe("从书签继续");
    await tree.switchLine(repo, c.worldId, c.line.id);
    const back = await tree.jumpTo(repo, c.worldId, one.id, "从书签继续");
    expect([back.head.id, back.line.id]).toEqual([one.id, c.line.id]);
  });
});
