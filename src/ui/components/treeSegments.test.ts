import { describe, expect, it } from "vitest";
import type { Line, StoryNode } from "../../engine/types";
import { countSegments, isStory, lineMarks, rangeLabel, segments, type Segment } from "./treeSegments";

let seq = 0;
const node = (id: string, parentId: string | null, kind: StoryNode["kind"] = "turn"): StoryNode =>
  ({ id, parentId, kind, seq: ++seq, narrative: id, actionText: id } as StoryNode);

describe("turn tree segments", () => {
  it("folds chains and nests forks, numbering turns from the opening", () => {
    const nodes = [node("o", null, "opening"), node("1", "o"), node("2", "1"), node("e", "2", "edit"), node("3", "e"), node("3b", "e"), node("4b", "3b")];
    const [root] = segments(nodes);
    expect(segments(nodes)).toHaveLength(1);
    expect(root.nodes.map((n) => n.id)).toEqual(["o", "1", "2", "e"]);
    expect(root.children.map((c) => [c.nodes.map((n) => n.id), c.first])).toEqual([[["3"], 2], [["3b", "4b"], 2]]);
    expect(rangeLabel(0, 2)).toBe("开场～第 2 回合");
    expect(rangeLabel(3, 4)).toBe("第 3～4 回合");
    expect(rangeLabel(3, 3)).toBe("第 3 回合");
  });

  it("returns no segments or marks for an empty world", () => {
    expect(segments([])).toEqual([]);
    expect(countSegments([])).toBe(0);
    expect(lineMarks([]).size).toBe(0);
  });

  it("keeps rewritten openings and their forks, sorted and independently numbered", () => {
    const nodes = [
      node("old", null, "opening"), node("old-1", "old"),
      node("new", null, "opening"), node("new-edit", "new", "edit"),
      node("new-1", "new-edit"), node("new-2", "new-1"),
      node("new-alt", "new-edit"), node("new-alt-2", "new-alt"),
      node("third", null, "opening"),
    ];
    const shuffled = [...nodes].reverse();
    const roots = segments(shuffled);
    expect(shuffled.map((n) => n.id)).toEqual([...nodes].reverse().map((n) => n.id));
    expect(roots.map((s) => [s.nodes[0].id, s.first])).toEqual([["old", -1], ["new", -1], ["third", -1]]);
    expect(roots[0].nodes.map((n) => n.id)).toEqual(["old", "old-1"]);
    expect(roots[1].nodes.map((n) => n.id)).toEqual(["new", "new-edit"]);
    expect(roots[1].children.map((s) => [s.nodes.map((n) => n.id), s.first])).toEqual([
      [["new-1", "new-2"], 0], [["new-alt", "new-alt-2"], 0],
    ]);
    expect(roots[2].nodes.map((n) => n.id)).toEqual(["third"]);
    expect(countSegments(roots)).toBe(5);
  });

  it("keeps archived routes and bookmarks on every root without deleted labels", () => {
    const nodes = [node("old", null, "opening"), node("old-1", "old"), node("new", null, "opening"), node("new-1", "new")];
    const lines = [
      { id: "archived", nodeId: "old-1", name: "旧路线", kind: "line", archived: true, deletedAt: null },
      { id: "current", nodeId: "new-1", name: "改写后的路线", kind: "line", archived: false, deletedAt: null },
      { id: "mark", nodeId: "new-1", name: "新开场之后", kind: "bookmark", archived: false, deletedAt: null },
      { id: "opening", nodeId: "new", name: "另一个开场", kind: "bookmark", archived: false, deletedAt: null },
      { id: "deleted", nodeId: "new-1", name: "已删除的路", kind: "line", archived: false, deletedAt: "2026-10-17" },
      { id: "deleted-mark", nodeId: "old", name: "已删除的书签", kind: "bookmark", archived: false, deletedAt: "2026-10-17" },
    ] as Line[];
    const roots = segments(nodes);
    const marks = lineMarks(lines);
    expect(roots.map((s) => s.nodes.flatMap((n) => marks.get(n.id) ?? []))).toEqual([
      ["旧路线"], ["书签：另一个开场", "改写后的路线", "书签：新开场之后"],
    ]);
    const currentPath = new Set(["new", "new-1"]);
    expect(roots.map((s) => s.nodes.some((n) => currentPath.has(n.id)))).toEqual([false, true]);
  });

  it("includes every node in a 200-node forest with independent opening numbers and sorted forks", () => {
    const nodes: StoryNode[] = [];
    for (let r = 0; r < 4; r++) {
      const root = `o${r}`;
      nodes.push(node(root, null, "opening"));
      let parent = root;
      for (let i = 1; i <= 25; i++) {
        const id = `m${r}-${i}`;
        nodes.push(node(id, parent, i === 10 ? "edit" : "turn"));
        parent = id;
      }
      for (let b = 0; b < 3; b++) {
        parent = `m${r}-${(b + 1) * 5}`;
        for (let i = 1; i <= 8; i++) {
          const id = `b${r}-${b}-${i}`;
          nodes.push(node(id, parent, b === 1 && i === 2 ? "edit" : "turn"));
          parent = id;
        }
      }
    }
    expect(nodes).toHaveLength(200);
    const started = performance.now();
    const roots = segments([...nodes].reverse());
    expect(performance.now() - started).toBeLessThan(50);
    expect(roots.map((r) => r.nodes[0].id)).toEqual(["o0", "o1", "o2", "o3"]);
    expect(countSegments(roots)).toBe(28);
    const seen: string[] = [];
    const numbered = new Map<string, number>();
    const visit = (seg: Segment) => {
      let number = seg.first;
      for (const n of seg.nodes) {
        seen.push(n.id);
        if (isStory(n)) numbered.set(n.id, ++number);
      }
      const order = seg.children.map((s) => s.nodes[0].seq);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      seg.children.forEach(visit);
    };
    roots.forEach(visit);
    expect(seen).toHaveLength(200);
    expect(new Set(seen)).toEqual(new Set(nodes.map((n) => n.id)));
    for (let r = 0; r < 4; r++) {
      expect(numbered.get(`o${r}`)).toBe(0);
      expect(numbered.get(`m${r}-25`)).toBe(24);
      expect(numbered.has(`m${r}-10`)).toBe(false);
      expect(numbered.get(`b${r}-1-1`)).toBe(10);
      expect(numbered.get(`b${r}-1-8`)).toBe(16);
    }
  });

  it("handles a 200-node world with 10 branches quickly", () => {
    const nodes = [node("o", null, "opening")];
    let last = "o";
    for (let i = 1; i <= 100; i++) { nodes.push(node(`m${i}`, last)); last = `m${i}`; }
    for (let b = 0; b < 10; b++) {
      let at = `m${(b + 1) * 9}`;
      for (let i = 1; i <= 10; i++) { nodes.push(node(`b${b}-${i}`, at)); at = `b${b}-${i}`; }
    }
    expect(nodes.length).toBe(201);
    const started = performance.now();
    const root = segments(nodes);
    expect(performance.now() - started).toBeLessThan(50);
    // Each fork splits the main line once and adds one branch segment.
    expect(countSegments(root)).toBe(21);
  });
});
