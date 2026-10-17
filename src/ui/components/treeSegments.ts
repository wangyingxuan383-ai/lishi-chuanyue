// The turn tree as segments (R06-T002): each chain without a fork becomes one
// row, forks nest under it. Turn numbers count story nodes from the opening (0).
import type { Line, StoryNode } from "../../engine/types";

export interface Segment { nodes: StoryNode[]; first: number; children: Segment[] }

export const isStory = (n: StoryNode) => n.kind !== "edit";

/** Each opening (including rewritten openings) starts its own numbered tree. */
export function segments(nodes: StoryNode[]): Segment[] {
  const children = new Map<string | null, StoryNode[]>();
  for (const n of nodes) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
  for (const list of children.values()) list.sort((a, b) => a.seq - b.seq);
  const build = (start: StoryNode, number: number): Segment => {
    const chain = [start];
    let at = start;
    let count = number + (isStory(start) ? 1 : 0);
    while ((children.get(at.id) ?? []).length === 1) {
      at = children.get(at.id)![0];
      chain.push(at);
      if (isStory(at)) count++;
    }
    return { nodes: chain, first: number, children: (children.get(at.id) ?? []).map((c) => build(c, count)) };
  };
  return (children.get(null) ?? []).map((root) => build(root, -1));
}

/** Archived routes stay visible in the tree; only deleted route/bookmark labels are omitted. */
export function lineMarks(lines: Line[]): Map<string, string[]> {
  const marks = new Map<string, string[]>();
  for (const line of lines) {
    if (line.deletedAt) continue;
    marks.set(line.nodeId, [...(marks.get(line.nodeId) ?? []), line.kind === "bookmark" ? `书签：${line.name}` : line.name]);
  }
  return marks;
}

/** "开场～第 5 回合", "第 6～17 回合", "第 3 回合". */
export function rangeLabel(from: number, to: number): string {
  const at = (n: number) => (n === 0 ? "开场" : `第 ${n} 回合`);
  if (from === to) return at(from);
  return from === 0 ? `开场～第 ${to} 回合` : `第 ${from}～${to} 回合`;
}

/** Number of segments, for tests and sanity checks. */
export function countSegments(roots: Segment[]): number {
  return roots.reduce((n, seg) => n + 1 + countSegments(seg.children), 0);
}
