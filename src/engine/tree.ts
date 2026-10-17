// Turn-tree operations (docs/PLAN_V3.md §6.4). Nothing here deletes nodes:
// undo, variants and "go back" only move line pointers, and a long abandoned
// branch is kept reachable by giving it an auto-named line.
import type { Repo, NewNode } from "./db/repo";
import type { Line, StoryNode } from "./types";

/** Branches shorter than this after the fork stay only in the tree view. */
export const KEEP_BRANCH_MIN = 3;

export interface Cursor {
  worldId: string;
  line: Line;
  head: StoryNode;
}

export async function cursor(repo: Repo, worldId: string): Promise<Cursor> {
  const world = await repo.getWorld(worldId);
  if (!world?.currentLineId) throw new Error(`world ${worldId} has no current line`);
  const line = (await repo.getLine(world.currentLineId))!;
  return { worldId, line, head: (await repo.getNode(line.nodeId))! };
}

/** Follows last_child links down from a node; returns the chain (excluding the start). */
async function tail(repo: Repo, from: StoryNode): Promise<StoryNode[]> {
  const chain: StoryNode[] = [];
  let node = from;
  while (node.lastChildId) {
    const next = await repo.getNode(node.lastChildId);
    if (!next) break;
    chain.push(next);
    node = next;
  }
  return chain;
}

/**
 * Before a new child is added under `parent`, keep the branch it replaces as
 * "last child" if it is long enough and no line already reaches into it.
 */
async function preserveReplacedBranch(repo: Repo, c: Cursor, parent: StoryNode): Promise<void> {
  if (!parent.lastChildId) return;
  const first = await repo.getNode(parent.lastChildId);
  if (!first) return;
  const branch = [first, ...(await tail(repo, first))];
  const others = (await repo.lines(c.worldId)).filter((l) => l.id !== c.line.id);
  if (branch.length < KEEP_BRANCH_MIN) return;
  if (others.some((l) => branch.some((n) => n.id === l.nodeId))) return;
  // The current line itself may sit inside the branch (it will move away now).
  await repo.createLine(c.worldId, branch[branch.length - 1].id, "未命名路线", true);
}

/** Continue the story: the new node becomes the head of the current line. */
export async function append(repo: Repo, c: Cursor, node: Omit<NewNode, "parentId">): Promise<Cursor> {
  await preserveReplacedBranch(repo, c, c.head);
  const created = await repo.appendNode(c.worldId, c.line.id, { ...node, parentId: c.head.id });
  return { ...c, line: { ...c.line, nodeId: created.id }, head: created };
}

/** Another version of the head turn: a sibling under the same parent. */
export async function addVariant(repo: Repo, c: Cursor, node: Omit<NewNode, "parentId">): Promise<Cursor> {
  if (!c.head.parentId) throw new Error("the opening has no parent to branch from");
  const created = await repo.appendNode(c.worldId, c.line.id, { ...node, parentId: c.head.parentId });
  return { ...c, line: { ...c.line, nodeId: created.id }, head: created };
}

export interface Variants {
  index: number; // 0-based position of the head among its siblings
  count: number;
  siblings: StoryNode[];
}

export async function variants(repo: Repo, node: StoryNode): Promise<Variants> {
  if (!node.parentId) return { index: 0, count: 1, siblings: [node] };
  const siblings = (await repo.children(node.parentId)).filter((n) => n.kind !== "edit");
  return { index: Math.max(0, siblings.findIndex((n) => n.id === node.id)), count: siblings.length, siblings };
}

/** Switch the head to the sibling version at `index`, continuing down that version's own tail. */
export async function switchVariant(repo: Repo, c: Cursor, index: number): Promise<Cursor> {
  const { siblings } = await variants(repo, c.head);
  const target = siblings[index];
  if (!target) return c;
  await repo.setLastChild(target.parentId!, target.id);
  const end = (await tail(repo, target)).pop() ?? target;
  await repo.moveLine(c.line.id, end.id);
  return { ...c, line: { ...c.line, nodeId: end.id }, head: end };
}

export async function undo(repo: Repo, c: Cursor): Promise<Cursor> {
  if (!c.head.parentId) return c;
  await repo.setLastChild(c.head.parentId, c.head.id); // so redo returns here
  await repo.moveLine(c.line.id, c.head.parentId);
  const parent = (await repo.getNode(c.head.parentId))!;
  return { ...c, line: { ...c.line, nodeId: parent.id }, head: parent };
}

export function canRedo(c: Cursor): boolean {
  return !!c.head.lastChildId;
}

export async function redo(repo: Repo, c: Cursor): Promise<Cursor> {
  if (!c.head.lastChildId) return c;
  const next = (await repo.getNode(c.head.lastChildId))!;
  await repo.moveLine(c.line.id, next.id);
  return { ...c, line: { ...c.line, nodeId: next.id }, head: next };
}

/**
 * Return to an earlier turn. If the current line has gone at least
 * KEEP_BRANCH_MIN turns past that point it stays where it is and a new line
 * starts at `nodeId`; otherwise the current line simply moves back.
 */
export async function goBackTo(repo: Repo, c: Cursor, nodeId: string): Promise<Cursor> {
  const path = await repo.path(c.head.id);
  const at = path.findIndex((n) => n.id === nodeId);
  if (at < 0) throw new Error("can only go back to a turn on the current path");
  const target = path[at];
  const ahead = path.length - 1 - at;
  if (ahead < KEEP_BRANCH_MIN) {
    await repo.moveLine(c.line.id, target.id);
    return { ...c, line: { ...c.line, nodeId: target.id }, head: target };
  }
  const line = await repo.createLine(c.worldId, target.id, at === 0 ? "从开场重来的路" : `第 ${at} 回合后的另一条路`, true);
  await repo.setCurrentLine(c.worldId, line.id);
  return { worldId: c.worldId, line, head: target };
}

export async function switchLine(repo: Repo, worldId: string, lineId: string): Promise<Cursor> {
  await repo.setCurrentLine(worldId, lineId);
  return cursor(repo, worldId);
}

/** Lines that should appear in the world-line list (bookmarks, archived and deleted ones excluded). */
export async function listedLines(repo: Repo, worldId: string): Promise<Line[]> {
  return (await repo.lines(worldId)).filter((l) => l.kind === "line" && !l.archived && !l.deletedAt);
}

/** A bookmark at a passage, kept as a line of its own so its turns are never purged (R06-T001). */
export async function addBookmark(repo: Repo, worldId: string, nodeId: string, name: string): Promise<Line> {
  return repo.createLine(worldId, nodeId, name.trim() || "书签", false, "bookmark");
}

/**
 * Carry on from any passage: on the current path it is "回到这里"; elsewhere
 * (a bookmark, another branch) a new line starts there and becomes current.
 */
export async function jumpTo(repo: Repo, worldId: string, nodeId: string, name: string): Promise<Cursor> {
  const c = await cursor(repo, worldId);
  if ((await repo.path(c.head.id)).some((n) => n.id === nodeId)) return goBackTo(repo, c, nodeId);
  const line = await repo.createLine(worldId, nodeId, name, true);
  await repo.setCurrentLine(worldId, line.id);
  return cursor(repo, worldId);
}
