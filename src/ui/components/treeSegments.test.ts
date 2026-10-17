import { describe, expect, it } from "vitest";
import type { StoryNode } from "../../engine/types";
import { countSegments, rangeLabel, segments } from "./treeSegments";

let seq = 0;
const node = (id: string, parentId: string | null, kind: StoryNode["kind"] = "turn"): StoryNode =>
  ({ id, parentId, kind, seq: ++seq, narrative: id, actionText: id } as StoryNode);

describe("turn tree segments", () => {
  it("folds chains and nests forks, numbering turns from the opening", () => {
    const nodes = [node("o", null, "opening"), node("1", "o"), node("2", "1"), node("e", "2", "edit"), node("3", "e"), node("3b", "e"), node("4b", "3b")];
    const root = segments(nodes)!;
    expect(root.nodes.map((n) => n.id)).toEqual(["o", "1", "2", "e"]);
    expect(root.children.map((c) => [c.nodes.map((n) => n.id), c.first])).toEqual([[["3"], 2], [["3b", "4b"], 2]]);
    expect(rangeLabel(0, 2)).toBe("开场～第 2 回合");
    expect(rangeLabel(3, 4)).toBe("第 3～4 回合");
    expect(rangeLabel(3, 3)).toBe("第 3 回合");
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
