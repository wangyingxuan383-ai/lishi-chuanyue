import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { editSummary, jumpTarget, segments } from "../ui/components/treeSegments";
import { migrate } from "./db/migrate";
import { Repo } from "./db/repo";
import { cleanReadablePi, cleanSource } from "./pi-readable";
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

  it("retains a deleted route while story evidence still references it", async () => {
    c = await tree.append(repo, c, turn("一"));
    const branch = await repo.createLine(c.worldId, c.head.id, "有出处的岔路", false);
    await repo.setLineDeleted(branch.id, true);
    await repo.platform.sql.batch([{
      sql: "INSERT INTO story_fact_sources(id,world_id,line_id,node_id,resource_kind,resource_id,batch_id,task_id,basis,claim,source_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      params: ["fact", c.worldId, branch.id, c.head.id, "rule", "r", "b", "t", "player", "线索", "{}", "2026-11-18"],
    }]);
    await expect(repo.purgeLine(branch.id)).rejects.toThrow("仍有资料引用");
    expect(await repo.getLine(branch.id)).not.toBeNull();
    expect(await repo.getNode(c.head.id)).not.toBeNull();
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

describe("line names (AUDIT_V4_FUNCTION G1)", () => {
  it("numbers a route or bookmark whose name is taken, also on rename", async () => {
    c = await tree.append(repo, c, turn("一"));
    const a = await tree.addBookmark(repo, c.worldId, c.head.id, "主线");
    const b = await tree.addBookmark(repo, c.worldId, c.head.id, "主线");
    expect([a.name, b.name]).toEqual(["主线（2）", "主线（3）"]);
    expect(await repo.renameLine(b.id, "主线")).toBe("主线（3）");
    expect(await repo.renameLine(b.id, "当铺")).toBe("当铺");
    expect(await repo.renameLine(a.id, "当铺")).toBe("当铺（2）");
    expect(await repo.renameLine(a.id, "当铺（2）")).toBe("当铺（2）");
  });
});

describe("R32-T004 regressions (B24, B25, B32)", () => {
  const editNode = (summary: string) => ({ kind: "edit" as const, narrative: "", actionText: summary, state: sampleState() });

  it("B24: replacedBranchEnd ignores trashed routes so a 3+ turn branch only held by trash is still preserved", async () => {
    c = await tree.append(repo, c, turn("一"));
    const fork = c.head;
    for (const t of ["二", "三", "四"]) c = await tree.append(repo, c, turn(t));
    const branchTip = c.head;
    const trashed = await repo.createLine(c.worldId, branchTip.id, "废弃路线", false);
    await repo.setLineDeleted(trashed.id, true);

    // Undo back to 一 and start a new turn: the trashed route must NOT prevent auto-preserving 二->三->四.
    for (let i = 0; i < 3; i++) c = await tree.undo(repo, c);
    expect(c.head.id).toBe(fork.id);
    c = await tree.append(repo, c, turn("二新"));
    const active = await tree.listedLines(repo, c.worldId);
    expect(active).toHaveLength(2);
    const preserved = active.find((l) => l.autoNamed)!;
    expect(preserved.nodeId).toBe(branchTip.id);

    // Even if the 30-day trash line is purged later, the preserved branch stays intact.
    await repo.platform.sql.query("UPDATE lines SET deleted_at = ? WHERE id = ?", [new Date(Date.now() - 31 * 86_400_000).toISOString(), trashed.id]);
    await repo.purgeTrash(c.worldId);
    expect((await repo.path(preserved.nodeId)).map((n) => n.narrative)).toEqual(["开场", "一", "二", "三", "四"]);
  });

  it("B25: goBackTo repairs stale lastChildId along the current path so redo returns to the current branch", async () => {
    c = await tree.append(repo, c, turn("分叉点"));
    const fork = c.head;
    const lineA = await tree.append(repo, c, turn("A1"));
    const lineA2 = await tree.append(repo, lineA, turn("A2"));

    // Simulate another branch B created later from `fork`, overwriting `fork.lastChildId = B1`.
    const routeB = await repo.createLine(c.worldId, fork.id, "支线B", false);
    let curB = await tree.switchLine(repo, c.worldId, routeB.id);
    curB = await tree.append(repo, curB, turn("B1"));
    expect((await repo.getNode(fork.id))!.lastChildId).toBe(curB.head.id);

    // Switch back to main line (at A2) and goBackTo `fork` (ahead = 2 < KEEP_BRANCH_MIN, same-line move).
    const onA = await tree.switchLine(repo, c.worldId, lineA2.line.id);
    let back = await tree.goBackTo(repo, onA, fork.id);
    expect(back.line.id).toBe(onA.line.id);
    expect(back.head.lastChildId).toBe(lineA.head.id);

    // Redoing twice must return to A1 -> A2, never B1!
    back = await tree.redo(repo, back);
    expect(back.head.narrative).toBe("A1");
    back = await tree.redo(repo, back);
    expect(back.head.narrative).toBe("A2");
  });

  it("B25: goBackTo counts story turns only (ignoring edit nodes) for KEEP_BRANCH_MIN and route naming", async () => {
    c = await tree.append(repo, c, editNode("开场改名"));
    c = await tree.append(repo, c, turn("第一回"));
    const turn1 = c.head;
    c = await tree.append(repo, c, editNode("整理设定集"));
    c = await tree.append(repo, c, editNode("添加物品"));
    c = await tree.append(repo, c, turn("第二回"));
    c = await tree.append(repo, c, editNode("后台整理"));

    // Only 1 story turn ("第二回") is ahead of `turn1` despite 3 edit nodes: must stay on the same line!
    const near = await tree.goBackTo(repo, c, turn1.id);
    expect(near.line.id).toBe(c.line.id);

    // Add two more story turns after `turn1` so 3 story turns lie ahead; route name must say 第 1 回合 (not array index 2).
    let farCur = near;
    for (const t of ["二乙", "三乙", "四乙"]) farCur = await tree.append(repo, farCur, turn(t));
    const far = await tree.goBackTo(repo, farCur, turn1.id);
    expect(far.line.id).not.toBe(farCur.line.id);
    expect(far.line.name).toBe("第 1 回合后的另一条路");
  });

  it("B25: TreeView segment helpers land on trailing contiguous edits and summarize pure-edit segments", async () => {
    c = await tree.append(repo, c, turn("一"));
    const t1 = c.head;
    c = await tree.append(repo, c, editNode("整理一"));
    c = await tree.append(repo, c, editNode("面板加状况"));
    const t1LastEdit = c.head;
    const mainEnd = await tree.append(repo, c, turn("二"));

    // Create a pure-edit fork off `t1LastEdit`
    const editBranch = await repo.createLine(c.worldId, t1LastEdit.id, "纯修改分支", false);
    let eb = await tree.switchLine(repo, c.worldId, editBranch.id);
    eb = await tree.append(repo, eb, editNode("改人物态度"));
    eb = await tree.append(repo, eb, editNode("加心愿"));

    const all = await repo.allNodes(c.worldId);
    const [root] = segments(all);
    // Jumping to `t1` in `root` lands on `t1LastEdit` (preserving its two contiguous edits, stopping before the fork).
    expect(jumpTarget(root, t1.id).id).toBe(t1LastEdit.id);
    expect(root.children).toHaveLength(2);
    const pureSeg = root.children.find((s) => s.nodes.every((n) => n.kind === "edit"))!;
    expect(editSummary(pureSeg.nodes)).toBe("改人物态度 → 加心愿");
    expect(mainEnd.head.narrative).toBe("二");
  });

  it("B32 & B27: cleanReadablePi preserves createdAt, normalizes legacy at, and keeps sequel originWorldId", () => {
    const cleaned = cleanReadablePi({
      engine: "pi",
      version: 1,
      readOnly: true,
      sessions: [{ id: "s1", worldId: "w2", originWorldId: "w1", originTitle: "前传", lineId: "l1", title: "对话", createdAt: "t0", updatedAt: "t1" } as any],
      tasks: [{
        id: "t1", sessionId: "s1", originWorldId: "w1", lineId: "l1", text: "查证", status: "completed", policy: "auto", createdAt: "t0", updatedAt: "t1",
        history: {
          messages: [
            { id: "m1", role: "user", content: "问", at: "2026-11-23T08:00:00Z" },
            { id: "m2", role: "assistant", content: "答", createdAt: "2026-11-23T08:01:00Z", secret: "drop" },
          ],
          steps: [], plan: [], sources: [{ title: "前传札记", originWorldId: "w1", quote: "引文" }], result: { status: "completed", summary: "好" },
        },
      } as any],
    });
    const msgs = (cleaned.tasks[0].history as any).messages;
    expect(msgs).toEqual([
      { id: "m1", role: "user", content: "问", createdAt: "2026-11-23T08:00:00Z" },
      { id: "m2", role: "assistant", content: "答", createdAt: "2026-11-23T08:01:00Z" },
    ]);
    expect((cleaned.sessions[0] as any).originWorldId).toBe("w1");
    expect(cleanSource({ quote: "x", originWorldId: "w1", location: { originWorldId: "w1", nodeId: "n1" } })).toMatchObject({
      originWorldId: "w1",
      location: { originWorldId: "w1", nodeId: "n1" },
    });
  });
});
