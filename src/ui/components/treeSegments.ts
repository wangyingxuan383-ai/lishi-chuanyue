// The turn tree as segments (R06-T002): each chain without a fork becomes one
// row, forks nest under it. Turn numbers count story nodes from the opening (0).
import type { StoryNode } from "../../engine/types";

export interface Segment { nodes: StoryNode[]; first: number; children: Segment[] }

export const isStory = (n: StoryNode) => n.kind !== "edit";

export function segments(nodes: StoryNode[]): Segment | null {
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
  const root = children.get(null)?.[0];
  return root ? build(root, -1) : null;
}

/** "开场～第 5 回合", "第 6～17 回合", "第 3 回合". */
export function rangeLabel(from: number, to: number): string {
  const at = (n: number) => (n === 0 ? "开场" : `第 ${n} 回合`);
  if (from === to) return at(from);
  return from === 0 ? `开场～第 ${to} 回合` : `第 ${from}～${to} 回合`;
}

/** Number of segments, for tests and sanity checks. */
export function countSegments(seg: Segment | null): number {
  return seg ? 1 + seg.children.reduce((n, c) => n + countSegments(c), 0) : 0;
}
