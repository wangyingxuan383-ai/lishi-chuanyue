// Reading a long game like a book (PLAN_V4 direction G): chapter headings as
// 回目, search over the current path, the 前情提要 card shown on return, and
// the whole story as a plain-text novel. Everything here is local text work;
// nothing calls a model.
import type { Repo } from "./db/repo";
import type { Chapter, StoryNode, WorldState } from "./types";

const DIGITS = "零一二三四五六七八九";

/** 1 → 一, 12 → 十二, 20 → 二十, 105 → 一百零五; plain digits past 9999. */
export function cnNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9999) return String(n);
  if (n < 10) return DIGITS[n];
  if (n < 20) return `十${n % 10 ? DIGITS[n % 10] : ""}`;
  const units = ["", "十", "百", "千"];
  const digits = String(n).split("").map(Number);
  let out = "";
  let zero = false;
  digits.forEach((d, i) => {
    const unit = units[digits.length - 1 - i];
    if (d === 0) { zero = true; return; }
    if (zero && out) out += "零";
    zero = false;
    out += DIGITS[d] + unit;
  });
  return out;
}

/** “第三回　西市问米”. */
export function huimu(n: number, title?: string): string {
  return `第${cnNumber(n)}回${title ? `　${title}` : ""}`;
}

/** Turn numbers as the 记事 tab counts them: only real turns, from 1. */
export function turnNumbers(path: StoryNode[]): Map<string, number> {
  return new Map(path.filter((n) => n.kind === "turn").map((n, i) => [n.id, i + 1]));
}

// ---------- search ----------

export interface Snippet { before: string; hit: string; after: string }

/** The first hit of `query` in `text` with some words either side; null when absent. Case-insensitive, spaces folded. */
export function snippet(text: string, query: string, radius = 24): Snippet | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const at = flat.toLowerCase().indexOf(q);
  if (at < 0) return null;
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + q.length + radius);
  return {
    before: (start > 0 ? "…" : "") + flat.slice(start, at),
    hit: flat.slice(at, at + q.length),
    after: flat.slice(at + q.length, end) + (end < flat.length ? "…" : ""),
  };
}

export type HitKind = "正文" | "人物" | "设定" | "地点" | "章回";

export interface SearchHit {
  kind: HitKind;
  /** What the hit belongs to: “第 12 回合”, a name, a 回目. */
  title: string;
  snippet: Snippet;
  /** The passage to scroll to (passages and chapters). */
  nodeId?: string;
  /** Game minutes of that passage, for its time. */
  minute?: number;
}

export interface BookInput {
  path: StoryNode[];
  chapters: Chapter[];
  state: WorldState;
  /** Game minutes at each node on the path. */
  minutes?: Map<string, number>;
}

/** Searches what the player can read on the current path; passages newest first, up to `limit` of them. */
export function searchBook(input: BookInput, query: string, limit = 60): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: SearchHit[] = [];
  const first = (...texts: (string | null | undefined)[]) => {
    for (const t of texts) { const s = t ? snippet(t, q) : null; if (s) return s; }
    return null;
  };
  input.chapters.forEach((c, i) => {
    const s = first(c.title, c.gist, c.summary);
    if (s) hits.push({ kind: "章回", title: huimu(i + 1, c.title), snippet: s, nodeId: c.firstNodeId, minute: input.minutes?.get(c.firstNodeId) });
  });
  for (const p of input.state.people) {
    const s = first(p.name, ...p.aliases, p.role, p.origin, p.notes);
    if (s) hits.push({ kind: "人物", title: p.name, snippet: s });
  }
  for (const p of input.state.places) {
    const s = first(p.name, ...(p.aliases ?? []), p.description);
    if (s) hits.push({ kind: "地点", title: p.name, snippet: s });
  }
  for (const c of input.state.cards) {
    const s = first(c.name, ...c.keys, c.content);
    if (s) hits.push({ kind: "设定", title: c.name, snippet: s });
  }
  const numbers = turnNumbers(input.path);
  let passages = 0;
  for (const node of [...input.path].reverse()) {
    if (node.kind === "edit") continue;
    const s = first(node.narrative, node.actionMode === "direct" ? null : node.actionText);
    if (!s) continue;
    const n = numbers.get(node.id);
    hits.push({ kind: "正文", title: node.kind === "opening" ? "开篇" : n ? `第 ${n} 回合` : "过些日子", snippet: s, nodeId: node.id, minute: input.minutes?.get(node.id) });
    if (++passages >= limit) break;
  }
  return hits;
}

// ---------- 前情提要 ----------

/** Away this long, the story opens with a recap. */
export const RECAP_AFTER_MS = 6 * 3600_000;

export function needsRecap(lastSeen: string | number | null | undefined, now = Date.now()): boolean {
  if (lastSeen == null) return false;
  const t = typeof lastSeen === "number" ? lastSeen : Date.parse(lastSeen);
  return Number.isFinite(t) && now - t > RECAP_AFTER_MS;
}

/** The last `count` sentences of a passage, a closing quote kept with its sentence. */
export function lastSentences(text: string, count = 2, max = 90): string {
  const sentences = text.replace(/\s+/g, "").match(/[^。！？…]+[。！？…]*[”」』]*/g) ?? [];
  const out = sentences.slice(-count).join("");
  return out.length > max ? `…${out.slice(-max)}` : out;
}

/** The first sentences of a summary, cut near `max` characters. */
function opening(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, "");
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const end = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut}…`;
}

export interface Recap {
  /** The latest chapter, as “第三回　西市问米” with its summary. */
  chapter: { heading: string; summary: string } | null;
  /** How the last passage ended. */
  last: string;
  goals: string[];
}

/** 前回说到……: built from what is saved, no model call. Null when there is nothing to recap yet. */
export function recapOf(input: Pick<BookInput, "path" | "chapters" | "state">): Recap | null {
  const last = [...input.path].reverse().find((n) => n.kind !== "edit" && n.narrative.trim());
  if (!last || !input.path.some((n) => n.kind === "turn" || n.kind === "fastforward")) return null;
  const c = input.chapters.at(-1);
  return {
    chapter: c ? { heading: huimu(input.chapters.length, c.title), summary: opening(c.summary || c.gist) } : null,
    last: lastSentences(last.narrative),
    goals: input.state.goals.filter((g) => g.status === "进行中").map((g) => g.name).slice(0, 3),
  };
}

// ---------- the story as a novel ----------

const INDENT = "　　";

function paragraphs(text: string): string {
  return text.split(/\n+/).map((p) => p.trim()).filter(Boolean).map((p) => INDENT + p).join("\n");
}

/** One turn's own line: what the protagonist did or said. Null for a plain 继续 or a note to the narrator. */
function actionLine(node: StoryNode): string | null {
  const text = node.actionText?.replace(/\s+/g, " ").trim();
  if (!text || node.kind === "opening") return null;
  switch (node.actionMode) {
    case "do": return `◇ 你：${text}`;
    case "say": return `◇ 你说：${text}`;
    case "skip": return `◇ 过些日子：${text}`;
    default: return null;
  }
}

/**
 * The current path as a readable novel: the title, chapters as 回目 headings
 * (the opening as 楔子 when there are chapters), the player's actions as short
 * marked lines and the narrative in indented paragraphs.
 */
export function storyText(input: { title: string; subtitle?: string; path: StoryNode[]; chapters: Chapter[] }): string {
  const out: string[] = [`《${input.title}》`];
  if (input.subtitle) out.push(input.subtitle);
  const starts = new Map(input.chapters.map((c, i) => [c.firstNodeId, i]));
  const lastOfAll = input.chapters.at(-1)?.lastNodeId;
  let afterLast = false;
  let trailing = false;
  const story = input.path.filter((n) => n.kind !== "edit");
  for (const node of story) {
    const k = starts.get(node.id);
    if (node.kind === "opening" && input.chapters.length) out.push("", "", "楔子");
    else if (k !== undefined) out.push("", "", huimu(k + 1, input.chapters[k].title));
    else if (afterLast && !trailing) { out.push("", "", `${huimu(input.chapters.length + 1)}（待续）`); trailing = true; }
    const parts: string[] = [];
    if (node.actionMode === "write" && node.actionText?.trim()) parts.push(paragraphs(node.actionText));
    const line = actionLine(node);
    if (line) parts.push(line);
    if (node.narrative.trim()) parts.push(paragraphs(node.narrative));
    if (parts.length) out.push("", parts.join("\n\n"));
    if (node.id === lastOfAll) afterLast = true;
  }
  out.push("", "", "（未完待续）", "");
  return out.join("\n");
}

/** The current line of a world as a novel, ready to save as a .txt file. */
export async function exportStory(repo: Repo, worldId: string): Promise<{ fileName: string; text: string }> {
  const world = await repo.getWorld(worldId);
  const line = world?.currentLineId ? await repo.getLine(world.currentLineId) : null;
  if (!world || !line) throw new Error("world not found");
  const [path, chapters, state] = await Promise.all([repo.path(line.nodeId), repo.chaptersOnPath(worldId, line.nodeId), repo.getState(line.nodeId)]);
  const who = [state.protagonist.name, state.time.start].filter(Boolean).join(" · ");
  const subtitle = `${who}${line.name !== "主线" ? `　（${line.name}）` : ""}`;
  const safe = world.title.replace(/[\\/:*?"<>|]/g, "").trim() || "故事";
  return { fileName: `${safe}.txt`, text: storyText({ title: world.title, subtitle, path, chapters }) };
}
