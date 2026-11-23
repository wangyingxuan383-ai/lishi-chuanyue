// 原著札记 (R29, D162): AI digests of a bound book — the protagonist's main plot
// over a chapter range, everything about one person or one setting, a timeline,
// or the answer to a question. They are written once on the helper model,
// edited by the player, and then carried into each passage at a fraction of
// the cost of re-reading the original. A note is guidance, not evidence: the
// deep tier still checks the original text.
import type { Repo } from "../db/repo";
import { newId } from "../db/repo";
import { ChatError, isContextWindowError, outputWasTruncated, type ChatMessage, type ChatResult } from "../llm/chat";
import { explainFailure } from "../llm/providers";
import { refusedFinish } from "../llm/refusal";
import { sourceAnalysisText } from "./facts";
import { terms, withoutRequestWords } from "./library";
import type { SourceBinding } from "./types";
import type { StoryNode } from "../types";
import * as tree from "../tree";

export const NOTES_PROMPT_VERSION = "canon-notes-5";
export type NoteKind = "plot" | "person" | "setting" | "timeline" | "question";
export const NOTE_KINDS: [NoteKind, string, string][] = [
  ["plot", "主线剧情", "某段章节里主角的主要经历、奇遇和转折"],
  ["person", "人物", "一个人物的身份、关系、本事和经历"],
  ["setting", "设定", "势力、功法、地点或规则"],
  ["timeline", "时间线", "某段章节里按先后发生的大事"],
  ["question", "问一个问题", "任何关于原著的问题，答案存下来"],
];
/** The same kinds for 本局札记, in words about this story rather than a book. */
export const STORY_NOTE_KINDS: [NoteKind, string, string][] = [
  ["plot", "主线梗概", "这局到现在的主要经历、奇遇和转折"],
  ["person", "人物", "一个人物的身份、和主角的关系、经历"],
  ["setting", "地点或势力", "一个地点、势力、物件或规矩"],
  ["timeline", "时间线", "这局按先后发生的大事"],
  ["question", "问一个问题", "关于这局故事的任何问题，答案存下来"],
];
export const NOTE_KIND_LABEL = Object.fromEntries(NOTE_KINDS.map(([k, l]) => [k, l])) as Record<NoteKind, string>;

/** `auto`: the story's own 主线梗概, kept up with each new chapter summary (D174). */
/** `toNode` (本局札记): the passage the note covers up to, so a note made on another route is known as such. */
/** `staleFrom` (本局札记): the earliest turn whose text was edited after the note was made (D183). */
export interface NoteScope {
  from?: number; to?: number; subject?: string; aliases?: string[]; question?: string; auto?: boolean; toNode?: string; staleFrom?: number;
  /** Book reading ceiling when this note was created from a scoped world (prevents spoiling past `binding.through`). */
  through?: number | null;
  /** How far 上一版 (previousContent) reached, so 恢复上一版 brings back its reach too. */
  previous?: { to?: number; toNode?: string; refs?: number[] };
}
/** `error`: one sentence for the player; `detail`: what actually went wrong, for 查看原因 (R30). */
export interface NoteProgress {
  parts: string[];
  total: number;
  /** Number of source pieces in each batch. Completed batches keep their boundaries. */
  batchSizes?: number[];
  /** Completed merges by level, in group order. Single parts are carried forward. */
  merges?: string[][];
  /** Ordered immutable source chunks. Analysis digests are interchangeable views of those chunks. */
  materialKeys?: string[];
  /**
   * A batch that could not be digested (the service would not take it) holds
   * an empty slot in parts. Since 0.17.0 the rest is merged and used for
   * writing all the same; the gap is named in the note and can be retried.
   */
  gaps?: NoteGap[];
  /** Which parts the cached merges were made from; a filled gap starts the merge again. */
  mergeBasis?: string;
  /** 续整理 / 更新到现在 (D174): the note being extended and the new range read for it. */
  update?: { base: string; from: number; to: number };
  /** Last passage of the immutable route read by an unfinished story note. */
  routeNode?: string;
  failure?: { kind: string; phase: "batch" | "merge"; batch?: number; sections?: number[]; configuration?: string };
  error?: string;
  detail?: string;
}
export interface NoteGap { batch: number; sections: number[]; reason?: "blocked" }
/** `also`: further gap batches the same manual text covers (adjacent gaps shown as one range). */
export type NoteResume = { kind: "defer"; batch: number } | { kind: "fill"; batch: number; text: string; also?: number[] };
export interface CanonNote {
  id: string; bookId: string; worldId: string | null; kind: NoteKind; title: string; scope: NoteScope;
  content: string; refs: number[]; model: string; status: "paused" | "running" | "done" | "failed";
  active: boolean; progress: NoteProgress; createdAt: string; updatedAt: string;
  /**
   * "story": 本局札记 (D174), digested from this story's own passages; `bookId`
   * is empty and scope ranges count turns (0 is the opening). Absent: a book.
   */
  source?: "book" | "story";
  /** The content before the last AI update, for 恢复上一版. */
  previousContent?: string | null;
  /** Carried over from an earlier story (D177): background, not updated here. */
  originWorldId?: string | null;
  originTitle?: string | null;
}

/** 回合 for a story's own notes, 章 for a book's. */
export const noteUnit = (note: Pick<CanonNote, "source">) => (note.source === "story" ? "回合" : "章");
const isStory = (note: Pick<CanonNote, "source">) => note.source === "story";
/** One piece of material: a chunk's existing digest when there is one, else its text. */
export interface NoteMaterial { section: number; title: string; text: string; digest: boolean }

/** About 16 000 characters of material per helper-model request. */
export const NOTE_BATCH_CHARS = 16_000;
const SEARCH_LIMIT = 24;
const NOTE_MAX = 3000, PART_MAX = 1200;
const MERGE_FAN_IN = 4;
export const NOTE_TEXT_LIMIT = 64_000;

const rowNote = (r: Record<string, unknown>): CanonNote => ({
  id: String(r.id), bookId: String(r.book_id ?? ""), worldId: r.world_id == null ? null : String(r.world_id), kind: String(r.kind) as NoteKind,
  title: String(r.title), scope: JSON.parse(String(r.scope_json || "{}")), content: String(r.content ?? ""), refs: JSON.parse(String(r.refs_json || "[]")),
  model: String(r.model ?? ""), status: String(r.status) as CanonNote["status"], active: Number(r.active) === 1,
  progress: JSON.parse(String(r.progress_json || "{}")), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  ...(r.previous_content != null ? { previousContent: String(r.previous_content) } : {}),
});
const storyRow = (r: Record<string, unknown>): CanonNote => ({
  ...rowNote({ ...r, book_id: "" }), source: "story",
  originWorldId: r.origin_world_id == null ? null : String(r.origin_world_id),
  originTitle: r.origin_title == null ? null : String(r.origin_title),
});

/** 本局札记 of a story, oldest first. */
export async function listStoryNotes(repo: Repo, worldId: string): Promise<CanonNote[]> {
  return (await repo.platform.sql.query("SELECT * FROM story_notes WHERE world_id=? ORDER BY created_at,id", [worldId])).map(storyRow);
}

/** Notes of a book; with a world, only the book's shared notes and that world's own. */
export async function listNotes(repo: Repo, bookId: string, worldId?: string | null): Promise<CanonNote[]> {
  const rows = worldId === undefined
    ? await repo.platform.sql.query("SELECT * FROM canon_notes WHERE book_id=? ORDER BY created_at", [bookId])
    : await repo.platform.sql.query("SELECT * FROM canon_notes WHERE book_id=? AND (world_id IS NULL OR world_id=?) ORDER BY created_at", [bookId, worldId]);
  return rows.map(rowNote);
}
export async function getNote(repo: Repo, id: string): Promise<CanonNote | null> {
  const [row] = await repo.platform.sql.query("SELECT * FROM canon_notes WHERE id=?", [id]);
  if (row) return rowNote(row);
  const [story] = await repo.platform.sql.query("SELECT * FROM story_notes WHERE id=?", [id]);
  return story ? storyRow(story) : null;
}
export async function saveNote(repo: Repo, note: CanonNote, existingOnly = false): Promise<void> {
  const table = isStory(note) ? "story_notes" : "canon_notes";
  // A cancelled worker may return after deletion. It must never recreate the row.
  if (existingOnly) {
    await repo.platform.sql.batch([{ sql: `UPDATE ${table} SET scope_json=?,content=?,previous_content=?,refs_json=?,model=?,status=?,active=?,progress_json=?,updated_at=? WHERE id=?`,
      params: [JSON.stringify(note.scope), note.content, note.previousContent ?? null, JSON.stringify(note.refs), note.model, note.status, note.active ? 1 : 0, JSON.stringify(note.progress), note.updatedAt, note.id] }]);
    return;
  }
  if (isStory(note)) {
    await repo.platform.sql.batch([{
      sql: `INSERT INTO story_notes(id,world_id,kind,title,scope_json,content,previous_content,refs_json,model,status,active,progress_json,origin_world_id,origin_title,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,scope_json=excluded.scope_json,content=excluded.content,
        previous_content=excluded.previous_content,refs_json=excluded.refs_json,model=excluded.model,status=excluded.status,active=excluded.active,
        progress_json=excluded.progress_json,updated_at=excluded.updated_at`,
      params: [note.id, note.worldId, note.kind, note.title, JSON.stringify(note.scope), note.content, note.previousContent ?? null, JSON.stringify(note.refs), note.model,
        note.status, note.active ? 1 : 0, JSON.stringify(note.progress), note.originWorldId ?? null, note.originTitle ?? null, note.createdAt, note.updatedAt],
    }]);
    return;
  }
  await repo.platform.sql.batch([{
    sql: `INSERT INTO canon_notes(id,book_id,world_id,kind,title,scope_json,content,previous_content,refs_json,model,status,active,progress_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,scope_json=excluded.scope_json,content=excluded.content,
      previous_content=excluded.previous_content,refs_json=excluded.refs_json,model=excluded.model,status=excluded.status,active=excluded.active,progress_json=excluded.progress_json,updated_at=excluded.updated_at`,
    params: [note.id, note.bookId, note.worldId, note.kind, note.title, JSON.stringify(note.scope), note.content, note.previousContent ?? null, JSON.stringify(note.refs), note.model,
      note.status, note.active ? 1 : 0, JSON.stringify(note.progress), note.createdAt, note.updatedAt],
  }]);
}
export async function deleteNote(repo: Repo, id: string): Promise<void> {
  await repo.platform.sql.batch([{ sql: "DELETE FROM canon_notes WHERE id=?", params: [id] }, { sql: "DELETE FROM story_notes WHERE id=?", params: [id] }]);
}

export function newNote(bookId: string, kind: NoteKind, scope: NoteScope, title: string, worldId: string | null = null): CanonNote {
  const now = new Date().toISOString();
  return { id: newId(), bookId, worldId, kind, title: title.trim() || NOTE_KIND_LABEL[kind], scope, content: "", refs: [], model: "", status: "paused", active: true, progress: { parts: [], total: 0 }, createdAt: now, updatedAt: now };
}

const NOTE_CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const NOTE_CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

function parseNoteChapterNum(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  let total = 0, section = 0, current = 0, hasDigit = false;
  for (const ch of s) {
    if (ch in NOTE_CN_DIGITS) { current = NOTE_CN_DIGITS[ch]; hasDigit = true; }
    else if (ch in NOTE_CN_UNITS) {
      const unit = NOTE_CN_UNITS[ch];
      if (unit === 10000) { section = (section + current) * unit; total += section; section = 0; current = 0; }
      else { section += (current === 0 && unit === 10 ? 1 : current) * unit; current = 0; }
      hasDigit = true;
    } else return null;
  }
  const value = total + section + current;
  return hasDigit && value > 0 ? value : null;
}

/** Chapter labels describe the supplied text, not verified original passages. */
export function mentionedChapters(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(/第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*(?:[～~—–至-]\s*(?:第\s*)?([0-9零〇一二两三四五六七八九十百千万]+)\s*)?[章回节]/g)) {
    const a = parseNoteChapterNum(match[1]);
    if (a !== null) found.push(a - 1);
    if (match[2]) {
      const b = parseNoteChapterNum(match[2]);
      if (b !== null) found.push(b - 1);
    }
  }
  return found.filter((section) => Number.isSafeInteger(section) && section >= 0);
}

export function localNoteContent(text: string): string {
  const content = text.replace(/^\uFEFF/, "").trim();
  if (!content) throw new Error("请写下札记内容。");
  if (content.length > NOTE_TEXT_LIMIT) throw new Error("一份札记最多 64,000 字，可以分成几份保存。");
  return content;
}

export function newLocalNote(note: CanonNote, text: string, chapterCount: number): CanonNote {
  const content = localNoteContent(text);
  return { ...note, content, status: "done", refs: [...new Set(mentionedChapters(content).filter((section) => section < chapterCount))] };
}

export async function renameNote(repo: Repo, id: string, title: string): Promise<void> {
  const at = new Date().toISOString();
  await repo.platform.sql.batch([{ sql: "UPDATE canon_notes SET title=?,updated_at=? WHERE id=?", params: [title, at, id] },
    { sql: "UPDATE story_notes SET title=?,updated_at=? WHERE id=?", params: [title, at, id] }]);
}

/** A 本局札记 of `worldId` (D174); ranges count turns, 0 being the opening. */
export function newStoryNote(worldId: string, kind: NoteKind, scope: NoteScope, title: string): CanonNote {
  return { ...newNote("", kind, scope, title, worldId), source: "story" };
}

/**
 * 带到新的一局 (D177): copies of the chosen notes go with a new story. A story's
 * own notes become 前作 background there; notes of a book that belonged to the
 * old story only now belong to the new one. Nothing is updated from the new story.
 */
export async function carryNotes(repo: Repo, ids: string[], toWorldId: string, from: { worldId: string; title: string }): Promise<number> {
  let carried = 0;
  for (const id of ids) {
    const note = await getNote(repo, id);
    if (!note || note.status !== "done" || !note.content.trim()) continue;
    const now = new Date().toISOString();
    const base = { ...note, id: newId(), worldId: toWorldId, progress: { parts: [], total: 0 }, previousContent: null, scope: { ...note.scope, previous: undefined }, createdAt: now, updatedAt: now, status: "done" as const };
    await saveNote(repo, isStory(note)
      ? { ...base, originWorldId: note.originWorldId ?? from.worldId, originTitle: note.originTitle ?? from.title }
      : base);
    carried++;
  }
  return carried;
}

/** 恢复上一版: the content before the last AI update comes back (and the update becomes the previous one). */
export async function restorePrevious(repo: Repo, id: string): Promise<CanonNote | null> {
  const note = await getNote(repo, id);
  if (!note?.previousContent) return null;
  // The reach goes back with the words: otherwise 更新到现在 would start after the newer
  // reach and skip what only the undone version had covered (Windows review, 0.17.0).
  const back = note.scope.previous;
  const restored = { ...note, content: note.previousContent, previousContent: note.content, updatedAt: new Date().toISOString(),
    ...(back ? { scope: { ...note.scope, to: back.to, toNode: back.toNode, previous: { to: note.scope.to, toNode: note.scope.toNode, refs: note.refs } }, refs: back.refs ?? note.refs } : {}) };
  await saveNote(repo, restored, true);
  return restored;
}

export function draftFromParts(note: CanonNote): string {
  const gaps = note.progress.gaps ?? [];
  const pending = note.progress.failure;
  const missing = [...new Set([...gaps.map((gap) => noteChapterRange(gap.sections)),
    ...(pending?.phase === "batch" && pending.sections?.length ? [noteChapterRange(pending.sections)] : [])])];
  const summary = missing.length ? `${missing.join("、")}待补。` : "原任务尚未完成。";
  return [`【部分札记】${summary}`, ...note.progress.parts.filter(Boolean)].join("\n\n");
}

/** Text copied from the detail sheet may include its controls above the notes. */
export function readNoteText(text: string): { content: string; title?: string; from?: number; to?: number } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const marker = lines.findIndex((line) => line.trim() === "查看已整理的内容");
  const header = lines.slice(0, Math.max(0, marker)).map((line) => line.trim());
  if (marker < 0 || !header.some((line) => line.includes("AI 整理，可能有误") || line.includes("这份札记补齐后才会用于写作"))) {
    return { content: localNoteContent(text) };
  }
  const title = header.find((line) => /^(?:主线|时间线)：/.test(line));
  const sections = mentionedChapters(title ?? "");
  const gaps = header.filter((line) => /^第\s*\d+(?:\s*～\s*\d+)?\s*章待补$/.test(line));
  const body = lines.slice(marker + 1);
  while (body.length && (!body.at(-1)!.trim() || /^(?:重试待补章节|全部札记|删除)$/.test(body.at(-1)!.trim()))) body.pop();
  const content = localNoteContent(body.join("\n"));
  return { content: localNoteContent(`【部分札记】${gaps.length ? `${gaps.join("、")}。` : "原任务尚未完成。"}\n\n${content}`),
    title, from: sections[0], to: sections.at(-1) };
}

/** “主线：第 1～100 章” — chapter numbers are the book's section order. */
export function suggestTitle(kind: NoteKind, scope: NoteScope): string {
  const range = scope.from !== undefined && scope.to !== undefined ? `第 ${scope.from + 1}～${scope.to + 1} 章` : "";
  if (kind === "plot") return `主线：${range || "全书"}`;
  if (kind === "timeline") return `时间线：${range || "全书"}`;
  if (kind === "person") return `人物：${scope.subject?.trim() || "未命名"}`;
  if (kind === "setting") return `设定：${scope.subject?.trim() || "未命名"}`;
  return scope.question?.trim().slice(0, 24) || "问题";
}

/** Material for a note, in book order. Ranges read every chunk; subjects and questions the best matches. */
export async function noteMaterials(repo: Repo, note: Pick<CanonNote, "bookId" | "kind" | "scope"> & Partial<Pick<CanonNote, "source" | "worldId" | "progress">>, path?: StoryNode[]): Promise<(NoteMaterial & { ordinal: number })[]> {
  if (isStory(note)) return storyMaterials(repo, note, path);
  // 续整理 (D174): only the new range is read; the old note is merged in afterwards.
  const update = note.progress?.update;
  if (update) {
    const ranged = { ...note, scope: { ...note.scope, from: update.from, to: update.to }, progress: undefined };
    const rows = await noteMaterials(repo, ranged);
    return note.kind === "plot" || note.kind === "timeline" ? rows : rows.filter((m) => m.section >= update.from && m.section <= update.to);
  }
  const sections = new Map((await repo.platform.sql.query("SELECT section,title FROM source_sections WHERE book_id=?", [note.bookId])).map((r) => [Number(r.section), String(r.title)]));
  if (!sections.size) return [];
  const bookLast = Math.max(...sections.keys());
  const ceiling = typeof note.scope.through === "number" && Number.isInteger(note.scope.through) && note.scope.through >= 0
    ? Math.min(bookLast, note.scope.through)
    : bookLast;
  let rows: Record<string, unknown>[];
  if (note.kind === "plot" || note.kind === "timeline") {
    const from = Math.max(0, note.scope.from ?? 0), to = Math.min(ceiling, note.scope.to ?? ceiling);
    rows = await repo.platform.sql.query("SELECT ordinal,section,text FROM source_chunks WHERE book_id=? AND section BETWEEN ? AND ? ORDER BY ordinal", [note.bookId, from, to]);
  } else {
    const query = note.kind === "question" ? note.scope.question ?? "" : [note.scope.subject ?? "", ...(note.scope.aliases ?? [])].join("\n");
    const keys = terms(query);
    const allowedOrdinals = ceiling < bookLast
      ? new Set((await repo.platform.sql.query("SELECT ordinal FROM source_chunks WHERE book_id=? AND section <= ?", [note.bookId, ceiling])).map((r) => Number(r.ordinal)))
      : null;
    if (!keys.length) {
      // Allow 1-character character/setting names to match verbatim within the allowed ceiling.
      const single = note.kind === "question" ? "" : (note.scope.subject ?? "").trim();
      if (!single) return [];
      rows = await repo.platform.sql.query(
        "SELECT ordinal,section,text FROM source_chunks WHERE book_id=? AND section <= ? AND instr(text, ?) > 0 ORDER BY ordinal LIMIT ?",
        [note.bookId, ceiling, single, SEARCH_LIMIT],
      );
    } else {
      const scores = new Map<number, number>();
      for (const row of await repo.platform.sql.query(`SELECT term,postings FROM source_terms WHERE book_id=? AND term IN (${keys.map(() => "?").join(",")})`, [note.bookId, ...keys])) {
        const postings = (JSON.parse(String(row.postings)) as number[]).filter((o) => !allowedOrdinals || allowedOrdinals.has(o));
        if (!postings.length) continue;
        for (const ordinal of postings) scores.set(ordinal, (scores.get(ordinal) ?? 0) + 1 / Math.sqrt(postings.length));
      }
      // A name of two characters is one bigram: insist on the whole name where one was given.
      const whole = note.kind === "question" ? [] : [note.scope.subject ?? "", ...(note.scope.aliases ?? [])].map((s) => s.trim()).filter(Boolean);
      const ranked = [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, SEARCH_LIMIT * 3).map(([ordinal]) => ordinal);
      if (!ranked.length) return [];
      rows = await repo.platform.sql.query(`SELECT ordinal,section,text FROM source_chunks WHERE book_id=? AND section <= ? AND ordinal IN (${ranked.map(() => "?").join(",")})`, [note.bookId, ceiling, ...ranked]);
      if (whole.length) rows = rows.filter((r) => whole.some((name) => String(r.text).includes(name)));
      const order = new Map(ranked.map((o, i) => [o, i]));
      rows = rows.sort((a, b) => order.get(Number(a.ordinal))! - order.get(Number(b.ordinal))!).slice(0, SEARCH_LIMIT).sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
    }
  }
  // An earlier 通读整理 already digested these chunks: its summaries cost far less to read.
  const digests = new Map<number, string>();
  const ranged = note.kind === "plot" || note.kind === "timeline";
  if (ranged) for (let offset = 0; offset < rows.length; offset += 400) {
    const ordinals = rows.slice(offset, offset + 400).map((r) => Number(r.ordinal));
    const summaries = await repo.platform.sql.query(
      `SELECT a.ordinal,a.text FROM source_analysis a JOIN source_jobs j ON j.id=a.job_id
       WHERE a.book_id=? AND a.ordinal IN (${ordinals.map(() => "?").join(",")}) ORDER BY j.created_at,j.id`,
      [note.bookId, ...ordinals],
    );
    for (const row of summaries) {
      const digest = sourceAnalysisText(String(row.text));
      if (digest.trim()) digests.set(Number(row.ordinal), digest);
    }
  }
  return rows.filter((r) => String(r.text).trim()).map((r) => {
    const digest = ranged ? digests.get(Number(r.ordinal)) : undefined;
    return { ordinal: Number(r.ordinal), section: Number(r.section), title: sections.get(Number(r.section)) ?? "", text: digest ?? String(r.text), digest: !!digest };
  });
}

/** The last turn of a story's current route (0 is the opening), or -1. */
export async function storyLastTurn(repo: Repo, worldId: string | null | undefined): Promise<number> {
  if (!worldId) return -1;
  const cursor = await tree.cursor(repo, worldId);
  return (await repo.path(cursor.head.id)).filter((n) => n.kind !== "edit").length - 1;
}

/** The passages of the story's current route, edits left out, in order. */
async function storyPath(repo: Repo, worldId: string): Promise<StoryNode[]> {
  const cursor = await tree.cursor(repo, worldId);
  return (await repo.path(cursor.head.id)).filter((n) => n.kind !== "edit");
}
/**
 * A 本局札记 made on another route (the player went back or switched since):
 * its passage is no longer on the current one. Older notes without `toNode` count as on route.
 */
export function noteOffRoute(note: Pick<CanonNote, "source" | "scope" | "originWorldId" | "progress">, routeIds: Set<string>): boolean {
  const anchor = note.progress.routeNode ?? note.scope.toNode;
  return note.source === "story" && !note.originWorldId && !!anchor && !routeIds.has(anchor);
}
export async function routeIds(repo: Repo, worldId: string): Promise<Set<string>> {
  return new Set((await storyPath(repo, worldId)).map((n) => n.id));
}
/** 按现在的路线重新整理: the note starts over on the current route; the old text stays as 上一版. */
export function restartOnRoute(note: CanonNote, lastTurn: number): CanonNote {
  return { ...note, content: "", previousContent: note.content || note.previousContent, status: "paused", scope: { ...note.scope, from: 0, to: lastTurn, toNode: undefined, staleFrom: undefined,
    previous: note.content ? { to: note.scope.to, toNode: note.scope.toNode, refs: note.refs } : note.scope.previous },
    progress: { parts: [], total: 0 }, updatedAt: new Date().toISOString() };
}

/** 本局札记 that read turn `turn`, now edited: marked so writing and the notes page know (D183). */
export async function markNotesStale(repo: Repo, worldId: string, turn: number): Promise<number> {
  let marked = 0;
  for (const note of await listStoryNotes(repo, worldId)) {
    if (note.originWorldId || note.status !== "done" || (note.scope.from ?? 0) > turn || (note.scope.to ?? Infinity) < turn) continue;
    const staleFrom = Math.min(note.scope.staleFrom ?? Infinity, turn);
    if (staleFrom === note.scope.staleFrom) continue;
    await saveNote(repo, { ...note, scope: { ...note.scope, staleFrom } }, true);
    marked++;
  }
  return marked;
}

/** A story's turns, 0 being the opening, in the label notes use for them. */
export function turnLabel(index: number): string {
  return index === 0 ? "开场" : `第 ${index} 回合`;
}

/**
 * 本局札记 material (D174): this story's passages on the current route. The
 * main plot and the timeline read the chapter summaries the story already has,
 * and the passages no chapter covers yet; a person, place or faction reads the
 * passages that name it; a question the passages that share its words.
 */
async function storyMaterials(repo: Repo, note: Pick<CanonNote, "kind" | "scope"> & Partial<Pick<CanonNote, "worldId" | "progress">>, capturedPath?: StoryNode[]): Promise<(NoteMaterial & { ordinal: number })[]> {
  if (!note.worldId) return [];
  const path = capturedPath ?? await storyPath(repo, note.worldId);
  if (!path.length) return [];
  const range = note.progress?.update ?? { from: Math.max(0, note.scope.from ?? 0), to: Math.min(path.length - 1, note.scope.to ?? path.length - 1) };
  const splitLongText = (raw: string, limit = NOTE_BATCH_CHARS): string[] => {
    if (raw.length <= limit) return [raw];
    const chunks: string[] = [];
    let current = "";
    for (const para of raw.split(/\n{2,}/)) {
      if (para.length > limit) {
        if (current) { chunks.push(current); current = ""; }
        for (let i = 0; i < para.length; i += limit) chunks.push(para.slice(i, i + limit));
      } else if (current && current.length + 2 + para.length > limit) {
        chunks.push(current);
        current = para;
      } else {
        current = current ? `${current}\n\n${para}` : para;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  };
  const piecesForNode = (index: number): (NoteMaterial & { ordinal: number })[] => {
    const node = path[index];
    const full = `${node.actionText?.trim() ? `【行动】${node.actionText.trim()}\n` : ""}${node.narrative}`;
    const parts = splitLongText(full);
    return parts.map((text, partIdx) => ({
      ordinal: index * 1000 + partIdx,
      section: index,
      title: parts.length > 1 ? `${turnLabel(index)}（${partIdx + 1}/${parts.length}）` : turnLabel(index),
      text,
      digest: false,
    }));
  };
  const inRange = path.map((_, index) => index).filter((index) => index >= range.from && index <= range.to);
  if (note.kind === "plot" || note.kind === "timeline") {
    const chapters = await repo.chaptersOnPath(note.worldId, path.at(-1)!.id);
    const at = new Map(path.map((n, index) => [n.id, index]));
    const covered = new Set<number>();
    const pieces: (NoteMaterial & { ordinal: number })[] = [];
    chapters.forEach((chapter, index) => {
      const first = at.get(chapter.firstNodeId), last = at.get(chapter.lastNodeId);
      if (chapter.stale || first === undefined || last === undefined || first < range.from || last > range.to || !chapter.summary.trim()) return;
      pieces.push({ ordinal: 1_000_000_000 + index, section: last, title: `${chapter.title}（${turnLabel(first)}～${turnLabel(last)}）`, text: chapter.summary, digest: true });
      for (let i = first; i <= last; i++) covered.add(i);
    });
    for (const index of inRange) if (!covered.has(index) && path[index].narrative.trim()) pieces.push(...piecesForNode(index));
    return pieces.sort((a, b) => a.section - b.section || a.ordinal - b.ordinal);
  }
  let picked: number[];
  if (note.kind === "question") {
    const keys = terms(withoutRequestWords(note.scope.question ?? "")).slice(0, 24);
    const activeKeys = keys.length ? keys : terms(note.scope.question ?? "").slice(0, 24);
    if (!activeKeys.length) return [];
    const minHits = Math.min(2, activeKeys.length);
    picked = inRange.map((index) => ({ index, score: activeKeys.filter((key) => path[index].narrative.includes(key)).length }))
      .filter(({ score }) => score >= minHits).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, SEARCH_LIMIT).map(({ index }) => index);
  } else {
    const names = [note.scope.subject ?? "", ...(note.scope.aliases ?? [])].map((s) => s.trim()).filter((s) => s.length >= 1);
    if (!names.length) return [];
    const hits = inRange.filter((index) => names.some((name) => path[index].narrative.includes(name) || (path[index].actionText ?? "").includes(name)));
    // Where it first appeared matters, and what happened lately matters most.
    picked = hits.length > 40 ? [...hits.slice(0, 6), ...hits.slice(-34)] : hits;
  }
  return picked.sort((a, b) => a - b).flatMap(piecesForNode);
}

/** Material in request-sized batches, never splitting one piece. */
export function noteBatches(materials: NoteMaterial[], limit = NOTE_BATCH_CHARS): NoteMaterial[][] {
  const batches: NoteMaterial[][] = [];
  let current: NoteMaterial[] = [], size = 0;
  for (const m of materials) {
    if (current.length && size + m.text.length > limit) { batches.push(current); current = []; size = 0; }
    current.push(m); size += m.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Requests the merge needs: one per level until the parts fit one request. */
function mergeRequests(parts: number): number {
  let n = 0, count = parts;
  while (count > 1) {
    const remainder = count % MERGE_FAN_IN;
    n += Math.floor(count / MERGE_FAN_IN) + Number(remainder > 1);
    count = Math.ceil(count / MERGE_FAN_IN);
  }
  return n;
}

export function noteStepsDone(progress: NoteProgress): number {
  return (progress.parts?.filter(Boolean).length ?? 0) + (progress.merges?.reduce((count, level) => count + level.length, 0) ?? 0);
}

/**
 * Progress in the player's words (R30 step 2): how far the reading got, then
 * the merge; the batch and merge counts are for the developer mode.
 */
export function noteProgressLabel(progress: NoteProgress, unit: "章" | "回合" = "章"): string {
  if (!progress.total) return "尚未开始整理";
  const keys = progress.materialKeys ?? [];
  const sizes = progress.batchSizes ?? [];
  const sectionOf = (key: string | undefined) => (key ? Number(key.split(":")[1]) : NaN);
  const label = (section: number) => (unit === "回合" ? turnLabel(section) : `第 ${section + 1} 章`);
  const gaps = progress.gaps?.length ? ` · ${gapRanges(progress.gaps).length} 处没整理成` : "";
  if (keys.length && sizes.length) {
    const read = progress.parts.length;
    if (read < sizes.length) {
      const done = sizes.slice(0, read).reduce((sum, size) => sum + size, 0);
      if (!done) return `正在从${label(sectionOf(keys[0]))}读起${gaps}`;
      return `已整理到${label(sectionOf(keys[done - 1]))}，共到${label(sectionOf(keys.at(-1)))}${gaps}`;
    }
    return `正在合并成一份札记${gaps}`;
  }
  return `已完成 ${Math.round((noteStepsDone(progress) / progress.total) * 100)}%${gaps}`;
}

/** The engineering view of the same progress, for the developer mode. */
export function noteProgressDetail(progress: NoteProgress): string {
  const batches = progress.batchSizes?.length ?? 0;
  const completed = progress.parts.filter(Boolean).length;
  const merged = noteStepsDone(progress) - completed;
  return `分段 ${completed}/${batches} · 汇总 ${merged}/${mergeRequests(batches)} · 缺口 ${progress.gaps?.length ?? 0}`;
}

/**
 * 续整理到 / 更新到现在 (D174): prepares `note` to read only `from`..`to` and
 * merge that into its content. The finished note keeps the old one for 恢复上一版.
 */
export function startNoteUpdate(note: CanonNote, to: number): CanonNote {
  const from = (note.scope.to ?? -1) + 1;
  if (note.status !== "done" || !note.content.trim()) throw new Error("这份札记还没整理完，先接着整理。");
  if (to < from) throw new Error(note.source === "story" ? "札记已经整理到最新了。" : "选的章节没有超过札记已有的范围。");
  return { ...note, status: "paused", progress: { parts: [], total: 0, update: { base: note.content, from, to } }, updatedAt: new Date().toISOString() };
}

/** 札记预备 (D178): the book position is within 3 chapters of what this note covers, and the book goes on. */
export function noteNearEnd(note: CanonNote, position: number, lastSection: number): boolean {
  const to = note.scope.to;
  return note.source !== "story" && !note.originWorldId && note.status === "done" && note.active && to !== undefined
    && to < lastSection && position >= to - 2 && (!!note.model || note.kind === "plot");
}
/** 本局札记 this many turns behind the story (0 when current or not updatable). */
export function noteBehind(note: CanonNote, lastTurn: number): number {
  if (note.source !== "story" || note.originWorldId || note.status !== "done" || note.scope.to === undefined) return 0;
  return Math.max(0, lastTurn - note.scope.to);
}
/** Where 续整理 should reach by default: about 30 chapters past the position, within the book. */
export function nextNoteReach(note: CanonNote, position: number, lastSection: number): number {
  return Math.min(lastSection, Math.max((note.scope.to ?? -1) + 1, position + 30));
}

export function refusedNoteBatch(progress: NoteProgress): number | undefined {
  const failure = progress.failure;
  if (failure?.phase === "batch" && (failure.kind === "refused" || failure.kind === "suspected_refusal")) return failure.batch;
  // 0.16.1 saved only the display strings. Its batch plan can still identify the next slot.
  if (!failure && progress.error?.startsWith("AI 服务拒绝了这段资料。") && progress.detail?.startsWith("正在整理第 ")) return progress.parts?.length ?? 0;
}

export function noteChapterRange(sections: number[], unit: "章" | "回合" = "章"): string {
  if (unit === "回合") return sections.length === 1 ? turnLabel(sections[0]) : `${turnLabel(sections[0])}～${turnLabel(sections.at(-1)!)}`;
  return sections.length === 1 ? `第 ${sections[0] + 1} 章` : `第 ${sections[0] + 1}～${sections.at(-1)! + 1} 章`;
}

/** Adjacent gaps as one range each, for the player: six blocked chapters in a row are one line. */
export function gapRanges(gaps: NoteGap[]): { batches: number[]; sections: number[] }[] {
  const ranges: { batches: number[]; sections: number[] }[] = [];
  for (const gap of [...gaps].sort((a, b) => a.batch - b.batch)) {
    const last = ranges.at(-1);
    if (last && gap.batch === last.batches.at(-1)! + 1) { last.batches.push(gap.batch); last.sections.push(...gap.sections); }
    else ranges.push({ batches: [gap.batch], sections: [...gap.sections] });
  }
  for (const range of ranges) range.sections = [...new Set(range.sections)].sort((a, b) => a - b);
  return ranges;
}

export interface NoteEstimate { requests: number; chars: number; pieces: number; digests: number }
export async function estimateNote(repo: Repo, note: Pick<CanonNote, "bookId" | "kind" | "scope"> & Partial<Pick<CanonNote, "source" | "worldId" | "progress">>): Promise<NoteEstimate> {
  const materials = await noteMaterials(repo, note);
  const batches = noteBatches(materials);
  return { requests: batches.length + mergeRequests(batches.length), chars: materials.reduce((n, m) => n + m.text.length, 0), pieces: materials.length, digests: materials.filter((m) => m.digest).length };
}

/** 札记 are for writing later passages: what will be needed again, in concrete terms, not a summary of a summary. */
const KEEP_DETAILS = "札记是给之后写作备查的，不是概括：以后会再用到的具体信息都要留下——名字和称号、等级与年限、颜色、数量、能力和招式的名称与效果、物品的样子和下落、约定、伏笔；不要为了简短把这些写成“实力提升”“获得机缘”之类的概括。";
function focus(note: Pick<CanonNote, "kind" | "scope"> & Partial<Pick<CanonNote, "source">>): string {
  const names = [note.scope.subject, ...(note.scope.aliases ?? [])].filter(Boolean).join("、");
  const where = isStory(note) ? "这一段故事" : "这些章节";
  switch (note.kind) {
    case "plot": return `整理主角在${where}里的经历：做了什么、遇到了谁、奇遇与收获、实力或身份的具体变化、关键转折、和重要人物关系的变化、还没解决的悬念。按先后顺序分条。${KEEP_DETAILS}`;
    case "timeline": return `按先后顺序列出${where}里发生的大事：谁、在哪里、做了什么、结果如何。每条一行，写具体的名称和数字。`;
    case "person": return `整理与「${names}」有关的内容：身份来历、外貌性格、本事与成长（具体到等级、年限、能力名称）、和其他人物的关系、经历的重要事件、说话的样子。${KEEP_DETAILS}`;
    case "setting": return `整理与「${names}」有关的设定：它是什么、具体的规则与限制（等级、数字、条件）、相关的人物和势力、在情节里起的作用。${KEEP_DETAILS}`;
    case "question": return `回答这个问题：「${note.scope.question ?? ""}」。按要点作答；材料里找不到答案就直说没有找到。`;
  }
}

/** One batch of original material → a partial (or, for a single batch, the whole) note. */
export function noteBatchMessages(bookTitle: string, note: Pick<CanonNote, "kind" | "scope"> & Partial<Pick<CanonNote, "source">>, batch: NoteMaterial[], final: boolean, compact = false, neutral = false): ChatMessage[] {
  const story = isStory(note);
  const material = batch.map((m) => story ? `\n[${m.title}${m.digest ? " · 章节摘要" : ""}]\n${m.text}` : `\n[第${m.section + 1}章 ${m.title}${m.digest ? " · 已有摘要" : ""}]\n${m.text}`).join("\n");
  // A batch the service would not take is tried once more as a plain, neutral summary (R30 step 2).
  const calm = neutral ? NEUTRAL : "";
  const intro = story
    ? `你在为互动小说《${bookTitle}》整理“本局札记”：这局故事已经写出的内容，供之后接着写时参考。只依据下面给出的本局正文，不补材料以外的情节，不评价。${focus(note)}每条末尾必须用括号标明出处回合，如（第1回合）或（第12回合）。`
    : `你在为小说《${bookTitle}》整理“原著札记”，供之后写同人故事时参考。只依据下面给出的原著材料，不补材料以外的情节，不评价。${focus(note)}每条末尾必须用括号标明出处章节，如（第12章）。`;
  return [
    { role: "system", content: `${intro}${calm}只输出札记正文，不超过 ${compact ? 600 : final ? NOTE_MAX : PART_MAX} 字。${compact ? "直接写简短要点，优先保留推进情节或回答问题的事实。" : ""}` },
    { role: "user", content: `${story ? "【本局正文】" : "【原著材料】"}${material}` },
  ];
}

/** 续整理 (D174): the existing note and what the new range added → one note, the old one leading. */
export function noteUpdateMessages(bookTitle: string, note: Pick<CanonNote, "kind" | "scope"> & Partial<Pick<CanonNote, "source">>, base: string, addition: string): ChatMessage[] {
  const unit = noteUnit(note);
  return [
    { role: "system", content: `下面是《${bookTitle}》的一份已有札记，以及根据后面新增的${unit === "章" ? "章节" : "回合"}整理出的补充。把补充合进原札记：原札记的内容和说法保留（它可能被玩家亲手改过），只补充新的信息，或改正被新内容明确推翻的地方，并写明变化；保持原有的结构和出处标注，按先后顺序。${focus(note)}只输出合并后的札记正文，不超过 ${NOTE_MAX * 2} 字。` },
    { role: "user", content: `【原札记】\n${base}\n\n【新增${unit === "章" ? "章节" : "回合"}的补充】\n${addition}` },
  ];
}

/** Partial notes of the same request → one note. */
const NEUTRAL = "这是对文学作品的客观概括：用中性、概括的语言叙述情节和人物关系，不复述暴力、血腥或露骨的细节，不照抄原句。";
export function noteMergeMessages(bookTitle: string, note: Pick<CanonNote, "kind" | "scope"> & Partial<Pick<CanonNote, "source">>, parts: string[], final: boolean, compact = false, neutral = false): ChatMessage[] {
  const story = isStory(note);
  return [
    { role: "system", content: `${neutral ? NEUTRAL : ""}下面是${story ? "互动小说" : "小说"}《${bookTitle}》同一份${story ? "本局" : "原著"}札记分段整理的结果。合并成一篇完整的札记：去掉重复，按先后顺序，保留每条的出处${story ? "回合" : "章节"}标注，不要在合并时把具体名称、数字、等级和能力概括掉。${focus(note)}只输出札记正文，不超过 ${compact ? PART_MAX : final ? NOTE_MAX : PART_MAX * 2} 字。${compact ? "用简短的要点覆盖各段的关键事实。" : ""}` },
    { role: "user", content: parts.map((p, i) => `【第 ${i + 1} 段】\n${p}`).join("\n\n") },
  ];
}

export interface NoteRunner {
  call(messages: ChatMessage[], signal: AbortSignal): Promise<string>;
  /** 备用服务 (D179): a batch the main service will not take is tried here before it becomes a gap. */
  fallback?(messages: ChatMessage[], signal: AbortSignal): Promise<string>;
  model: string;
  configuration?: string;
}

class NoteReplyError extends Error {
  constructor(readonly kind: "empty" | "length" | "refused" | "suspected_refusal" | "context", message: string) {
    super(message);
  }
}

export function noteReplyProblem(result: Pick<ChatResult, "text" | "finishReason">): NoteReplyError | null {
  const finish = result.finishReason?.toLowerCase();
  const content = result.text.trim();
  if (refusedFinish(finish ?? null)) {
    return new NoteReplyError("refused", "AI 服务拒绝了这段资料。可以换个整理模型后接着做。");
  }
  if (outputWasTruncated(finish ?? null)) return new NoteReplyError("length", "模型写到一半达到了输出上限。");
  if (!content) return new NoteReplyError("empty", "模型没有写出札记正文。");
  const hasCitedNotes = /[（(]第\s*\d+\s*(?:[～~—–至-]\s*(?:第\s*)?\d+\s*)?(?:章|回合)[）)]/.test(content);
  if (!hasCitedNotes && /^(?:the prompt (?:could not|cannot) be submitted|the prompt contains sensitive words|抱歉[，,！!\s]*(?:我)?(?:无法|不能)(?:提供|处理|整理|回答|生成))/i.test(content)) {
    return new NoteReplyError("suspected_refusal", "收到的回复像拒答，无法确认这段札记。");
  }
  return null;
}

function replyError(error: unknown): unknown {
  if (isContextWindowError(error)) return new NoteReplyError("context", "这批资料超过了模型能读的长度。");
  if (error instanceof ChatError && error.kind === "empty") {
    return noteReplyProblem({ text: "", finishReason: error.message }) ?? error;
  }
  return error;
}

const retryableReply = (error: unknown) => error instanceof NoteReplyError && ["empty", "length", "context"].includes(error.kind);
/** The service would not take this material (a filter on the original, or a refusal). */
const blockedReply = (error: unknown) => error instanceof NoteReplyError && (error.kind === "refused" || error.kind === "suspected_refusal");

/** A failed note in the player's words (R30): one sentence, the cause kept apart. */
export function noteFailure(error: unknown): { error: string; detail?: string } {
  if (error instanceof NoteReplyError) return { error: `${error.message}已完成的部分保留了。` };
  const kind = error && typeof error === "object" && "kind" in error ? String((error as { kind: unknown }).kind) : null;
  const status = error && typeof error === "object" && "status" in error ? Number((error as { status: unknown }).status) || undefined : undefined;
  const detail = error instanceof Error ? error.message.replace(/\S*:\/\/\S+/g, "[链接]").slice(0, 300) : undefined;
  const kept = "已完成的部分保留了，可以接着整理。";
  if (kind) return { error: `${explainFailure(kind, status)}${kept}`, ...(detail ? { detail } : {}) };
  return { error: detail && detail.length <= 60 ? detail : `没能整理完。${kept}`, ...(detail && detail.length > 60 ? { detail } : {}) };
}

/**
 * Write (or resume) a note: each batch is digested once and saved, so a pause
 * or a failure keeps the finished parts; then the parts are merged.
 */
export async function runNote(repo: Repo, note: CanonNote, bookTitle: string, runner: NoteRunner, signal: AbortSignal, onProgress: (note: CanonNote) => void, resume?: NoteResume): Promise<CanonNote> {
  const path = isStory(note) && note.worldId ? await storyPath(repo, note.worldId) : undefined;
  const coveredTo = path ? Math.min(path.length - 1, note.progress.update?.to ?? note.scope.to ?? path.length - 1) : undefined;
  const routeNode = coveredTo === undefined ? undefined : path?.[coveredTo]?.id;
  // Another route only when the passage it had reached is no longer on this one: a person,
  // place or question note reads to the end, and the story may have grown since it paused.
  if (path && ((note.progress.routeNode && !path.some((node) => node.id === note.progress.routeNode))
      || (note.scope.toNode && !note.originWorldId && !path.some((node) => node.id === note.scope.toNode)))) {
    throw new Error("札记整理用的是之前的路线。切回那条路线接着整理，或按现在的路线重新整理。");
  }
  const materials = await noteMaterials(repo, note, path);
  if (!materials.length) throw new Error(note.kind === "plot" || note.kind === "timeline" ? "这段章节里没有正文" : "原著里没有找到相关内容，换个名字或别名试试");
  const materialKeys = materials.map(({ ordinal, section }) => `${ordinal}:${section}`);
  const parts = [...(note.progress.parts ?? [])];
  const batchSizes = [...(note.progress.batchSizes ?? noteBatches(materials).map((batch) => batch.length))];
  const gaps = [...(note.progress.gaps ?? [])];
  if (batchSizes.some((size) => !Number.isInteger(size) || size < 1)
      || batchSizes.reduce((sum, size) => sum + size, 0) !== materials.length
      || parts.length > batchSizes.length
      || (note.progress.materialKeys && (note.progress.materialKeys.length !== materialKeys.length
        || note.progress.materialKeys.some((key, i) => key !== materialKeys[i])))
      || gaps.some(({ batch }) => !Number.isInteger(batch) || batch < 0 || batch >= parts.length || parts[batch] !== "")
      || new Set(gaps.map(({ batch }) => batch)).size !== gaps.length
      || parts.some((part, index) => !part.trim() && !gaps.some(({ batch }) => batch === index))) {
    // A story's passages change as it goes on (a new chapter summary stands for
    // its turns): a story note simply starts the unfinished job again.
    if (!isStory(note)) throw new Error("原著资料已变化，无法对应旧进度。旧札记仍保留，可以按当前资料新建一份。");
    parts.length = 0; gaps.length = 0;
    batchSizes.splice(0, batchSizes.length, ...noteBatches(materials).map((batch) => batch.length));
    note = { ...note, progress: { ...note.progress, parts: [], merges: [], gaps: [], materialKeys: undefined } };
  }
  const refusedBatch = refusedNoteBatch(note.progress);
  if (resume && ((resume.batch !== refusedBatch && (resume.kind !== "fill" || !gaps.some(({ batch }) => batch === resume.batch)))
      || resume.batch > parts.length || resume.batch >= batchSizes.length
      || resume.kind === "fill" && !resume.text.trim())) throw new Error("这批札记的进度已变，请重新打开后再试");
  const refs = [...new Set(materials.map((m) => m.section))];
  const merges = (note.progress.merges ?? []).map((level) => [...level]);
  const update = note.progress.update;
  const basis = () => parts.map((part) => (part ? "1" : "0")).join("");
  let mergeBasis = note.progress.mergeBasis ?? basis();
  const progress = (): NoteProgress => ({
    parts: [...parts],
    batchSizes: [...batchSizes],
    merges: merges.map((level) => [...level]),
    materialKeys,
    ...(gaps.length ? { gaps: [...gaps] } : {}),
    mergeBasis,
    ...(update ? { update } : {}),
    ...(routeNode ? { routeNode } : {}),
    total: batchSizes.length + mergeRequests(batchSizes.length) + (update ? 1 : 0),
  });
  const unit = noteUnit(note);
  let current: CanonNote = { ...note, model: runner.model, refs: isStory(note) ? [] : update ? note.refs : refs, status: "running", progress: progress(), updatedAt: new Date().toISOString() };
  const save = async (patch: Partial<CanonNote>) => { current = { ...current, ...patch, updatedAt: new Date().toISOString() }; await saveNote(repo, current, true); onProgress({ ...current }); };
  // 暂停 always frees the note, even when a request never answers (a phone
  // that slept mid-request): before 0.16.0 that left it "整理中" and 接着整理 refused.
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => { abort = () => reject(new DOMException("已暂停", "AbortError")); });
  stopped.catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  const call = async (messages: ChatMessage[]) => {
    signal.throwIfAborted();
    try {
      const text = (await Promise.race([runner.call(messages, signal), stopped])).trim();
      signal.throwIfAborted();
      if (!text) throw new NoteReplyError("empty", "模型没有写出札记正文。");
      return text;
    } catch (error) { throw replyError(error); }
  };
  let step = "";
  let phase: "batch" | "merge" = "batch";
  let pending: NoteGap | undefined;
  const batchAt = (index: number, offset: number) => {
    const batch = materials.slice(offset, offset + batchSizes[index]);
    pending = { batch: index, sections: [...new Set(batch.map(({ section }) => section))] };
    step = `正在整理${noteChapterRange(pending.sections, unit)}。`;
    return batch;
  };
  /**
   * One piece the service would not take (R30 step 2): once more as a neutral
   * summary, then on the backup service; null when it stays blocked, and the
   * piece becomes a named gap instead of stopping the whole note.
   */
  const unblock = async (pieces: NoteMaterial[]): Promise<string | null> => unblockWith(noteBatchMessages(bookTitle, note, pieces, batchSizes.length === 1, true, true));
  const unblockWith = async (messages: ChatMessage[]): Promise<string | null> => {
    try { return await call(messages); }
    catch (error) { if (!blockedReply(error) || signal.aborted) throw error; }
    if (runner.fallback) {
      try {
        const text = (await Promise.race([runner.fallback(messages, signal), stopped])).trim();
        signal.throwIfAborted();
        if (text) return text;
      } catch (error) {
        const problem = replyError(error);
        if (signal.aborted || !(blockedReply(problem) || retryableReply(problem) || problem instanceof ChatError)) throw problem;
      }
    }
    return null;
  };
  try {
    signal.throwIfAborted();
    if (resume) {
      const index = resume.batch;
      const offset = batchSizes.slice(0, index).reduce((sum, size) => sum + size, 0);
      batchAt(index, offset);
      const gapIndex = gaps.findIndex(({ batch }) => batch === index);
      if (resume.kind === "fill") {
        parts[index] = resume.text.trim().slice(0, NOTE_MAX);
        if (gapIndex >= 0) gaps.splice(gapIndex, 1);
        // One note for a run of adjacent gaps: the others point at it.
        for (const other of resume.also ?? []) {
          const at = gaps.findIndex(({ batch }) => batch === other);
          if (at < 0 || other === index) continue;
          parts[other] = `（这一段的要点并在${noteChapterRange(pending!.sections, unit)}的补记里）`;
          gaps.splice(at, 1);
        }
      } else if (gapIndex < 0) {
        parts[index] = "";
        gaps.push(pending!);
      }
    }
    await save({});
    let offset = batchSizes.slice(0, parts.length).reduce((sum, size) => sum + size, 0);
    // Older failures had no reason beyond “no usable note”. Try a shorter reply
    // on the first unfinished step instead of repeating the same request.
    let compact = note.status === "failed";
    // Once later batches exist, a gap can be filled without repainting or resending them.
    if (!resume && parts.length === batchSizes.length && gaps.length) {
      for (let i = 0; i < gaps.length;) {
        const index = gaps[i].batch;
        const offset = batchSizes.slice(0, index).reduce((sum, size) => sum + size, 0);
        const pieces = batchAt(index, offset);
        let content: string | null;
        try { content = await call(noteBatchMessages(bookTitle, note, pieces, batchSizes.length === 1, true)); }
        catch (error) {
          if (!blockedReply(error) || signal.aborted) throw error;
          const size = batchSizes[index];
          if (size > 1) {
            const half = Math.ceil(size / 2);
            batchSizes.splice(index, 1, half, size - half);
            parts.splice(index, 1, "", "");
            merges.length = 0;
            mergeBasis = "";
            for (let j = 0; j < gaps.length; j++) {
              if (gaps[j].batch > index) gaps[j] = { ...gaps[j], batch: gaps[j].batch + 1 };
            }
            const left = batchAt(index, offset);
            const right = batchAt(index + 1, offset + half);
            const sections = (batch: NoteMaterial[]) => [...new Set(batch.map((piece) => piece.section))];
            gaps.splice(i, 1, { batch: index, sections: sections(left), reason: "blocked" },
              { batch: index + 1, sections: sections(right), reason: "blocked" });
            await save({ progress: progress() });
            continue;
          }
          content = await unblock(pieces);
        }
        if (content === null) { i++; continue; }
        parts[index] = content;
        gaps.splice(i, 1);
        await save({ progress: progress() });
      }
    }
    // An update that only adds chapter summaries goes straight into the merge: they are digests already.
    if (update && !parts.length && batchSizes.length === 1 && materials.every((m) => m.digest)) {
      parts.push(materials.map((m) => `[${m.title}]\n${m.text}`).join("\n\n"));
      offset = materials.length;
      await save({ progress: progress() });
    }
    while (parts.length < batchSizes.length) {
      const index = parts.length;
      const size = batchSizes[index];
      const batch = batchAt(index, offset);
      const messages = (short: boolean) => noteBatchMessages(bookTitle, note, batch, batchSizes.length === 1, short);
      let content: string;
      try { content = await call(messages(compact)); }
      catch (error) {
        const blocked = blockedReply(error);
        if ((!retryableReply(error) && !blocked) || signal.aborted) throw error;
        // Smaller batches find the one piece a filter stops at, and keep the rest.
        if (size > 1) {
          const half = Math.ceil(size / 2);
          batchSizes.splice(index, 1, half, size - half);
          compact = !blocked || compact;
          await save({ progress: progress() });
          continue;
        }
        if (blocked) {
          const unblocked = await unblock(batch);
          if (unblocked === null) {
            parts.push("");
            gaps.push({ ...pending!, reason: "blocked" });
            offset += size;
            compact = false;
            await save({ progress: progress() });
            continue;
          }
          content = unblocked;
        } else {
          if (compact || (error instanceof NoteReplyError && error.kind === "context")) throw error;
          content = await call(messages(true));
        }
      }
      parts.push(content);
      offset += size;
      compact = false;
      await save({ progress: progress() });
    }
    // Gaps no longer keep the note from being merged and used (D175).
    if (basis() !== mergeBasis) { merges.length = 0; mergeBasis = basis(); }
    phase = "merge";
    let mergeCompact = note.status === "failed" && parts.length === (note.progress.parts ?? []).length;
    let level = parts.filter(Boolean);
    if (!level.length) throw new NoteReplyError("refused", "这段资料服务一直不肯处理，换个整理模型或在设定里配个备用服务后再试。");
    for (let depth = 0; level.length > 1; depth++) {
      signal.throwIfAborted();
      const completed = merges[depth] ?? (merges[depth] = []);
      const final = level.length <= MERGE_FAN_IN;
      const next: string[] = [];
      for (let start = 0; start < level.length; start += MERGE_FAN_IN) {
        const group = level.slice(start, start + MERGE_FAN_IN);
        if (group.length === 1) { next.push(group[0]); continue; }
        const index = start / MERGE_FAN_IN;
        if (completed[index]) { next.push(completed[index]); continue; }
        step = final ? "正在合并整份札记。" : `正在合并第 ${depth + 1} 轮的第 ${index + 1} 组。`;
        const messages = (short: boolean) => noteMergeMessages(bookTitle, note, group, final, short);
        let merged: string;
        try { merged = await call(messages(mergeCompact)); }
        catch (error) {
          if (signal.aborted) throw error;
          if (blockedReply(error)) {
            // The digests are already summaries; ask once more in neutral words, then the backup.
            const unblocked = await unblockWith(noteMergeMessages(bookTitle, note, group, final, true, true));
            if (unblocked === null) throw new NoteReplyError("refused", "合并札记时服务一直不肯处理，换个整理模型或在设定里配个备用服务后再试；已整理的部分保留了。");
            merged = unblocked;
          } else {
            if (mergeCompact || !retryableReply(error)) throw error;
            merged = await call(messages(true));
          }
        }
        mergeCompact = false;
        completed.push(merged);
        next.push(merged);
        await save({ progress: progress() });
      }
      level = next;
    }
    signal.throwIfAborted();
    let content = level[0];
    // 续整理 (D174): the new range's digest goes into the existing note, which leads.
    if (update) {
      step = "正在把新内容合进原札记。";
      const messages = noteUpdateMessages(bookTitle, note, update.base, content);
      try { content = await call(messages); }
      catch (error) {
        if (signal.aborted) throw error;
        if (blockedReply(error)) {
          const unblocked = await unblockWith([{ ...messages[0], content: NEUTRAL + messages[0].content }, ...messages.slice(1)]);
          if (unblocked === null) throw new NoteReplyError("refused", "把新内容合进原札记时服务一直不肯处理，换个整理模型或配个备用服务后再试；原札记没有改动。");
          content = unblocked;
        } else if (retryableReply(error)) {
          const compactMsg: ChatMessage[] = [
            { ...messages[0], content: `${messages[0].content} 用简洁要点保留关键事实，不超过 ${NOTE_MAX} 字。` },
            ...messages.slice(1),
          ];
          content = await call(compactMsg);
        } else {
          throw error;
        }
      }
    }
    if (gaps.length) {
      const missing = gapRanges(gaps).map(({ sections }) => noteChapterRange(sections, unit)).join("、");
      content = `${content}\n\n（${missing}有部分内容未能整理：服务没有处理这段${isStory(note) ? "正文" : "原文"}。）`;
    }
    const reached = coveredTo !== undefined ? { ...note.scope, to: coveredTo, toNode: routeNode }
      : update ? { ...note.scope, to: update.to } : note.scope;
    // A retried gap finishes the same update again: its reach was already moved on, and
    // 上一版 preserves the previous saved text so any manual edits remain restorable.
    const applied = !!update && !!note.scope.previous && (note.scope.to ?? -1) >= update.from;
    const scope = update ? { ...reached, previous: applied ? note.scope.previous : { to: note.scope.to, toNode: note.scope.toNode, refs: note.refs } } : reached;
    // With gaps the parts stay, so a later retry of a gap merges again (and re-applies an update).
    const settled: NoteProgress = gaps.length ? progress() : { parts: [], total: current.progress.total };
    const updatedRefs = update && !isStory(note) ? [...new Set([...note.refs, ...refs])].sort((a, b) => a - b) : current.refs;
    const prevSnapshot = update ? (applied && note.content.trim() ? note.content : update.base) : undefined;
    await save({ content, status: "done", scope, refs: updatedRefs, ...(prevSnapshot !== undefined ? { previousContent: prevSnapshot } : {}), progress: settled });
  } catch (error) {
    const failure = noteFailure(error);
    const detail = [step, failure.detail].filter(Boolean).join(" ");
    const kind = error instanceof NoteReplyError || error instanceof ChatError ? error.kind : "storage_or_unknown";
    await save(signal.aborted ? { status: "paused" } : {
      status: "failed", progress: { ...current.progress, ...failure, ...(detail ? { detail } : {}),
        failure: { kind, phase, ...(phase === "batch" ? pending : undefined), configuration: runner.configuration } },
    });
  } finally { signal.removeEventListener("abort", abort); }
  return current;
}

/** Mixed summaries cannot be safely truncated into an earlier chapter range. */
export function noteWithinScope(note: Pick<CanonNote, "kind" | "scope" | "refs">, through: number | null, sameWorld = false): boolean {
  if (through === null) return true;
  if (note.refs.some((section) => !Number.isInteger(section) || section < 0 || section > through)) return false;
  if (note.kind === "plot" || note.kind === "timeline") return Number.isInteger(note.scope.to) && note.scope.to! <= through;
  // A note explicitly scoped to a reading ceiling `scope.through <= through` (including manual notes without literal chapter numbers) is safe.
  if (typeof note.scope.through === "number" && Number.isInteger(note.scope.through) && note.scope.through >= 0 && note.scope.through <= through) {
    return note.refs.length < 400;
  }
  // Older notes truncated references at 400; their complete scope is unknown.
  // An answer this story saved (question) was asked within its reading limit even when it cites no chapter.
  return (note.refs.length > 0 || (note.kind === "question" && sameWorld)) && note.refs.length < 400;
}

/** Keep long imports intact on disk, then read around the current chapter (or query hits first for lookups/corrections). */
function noteExcerpt(content: string, position: number, query: string, latest = false, queryFirst = false): string {
  const cap = 2400;
  if (content.length <= cap) return content;
  const blocks = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const notice = blocks[0]?.startsWith("【部分札记】") ? blocks.shift()! : "";
  const keys = terms(withoutRequestWords(query)).slice(0, 24);
  const ranked = blocks.map((line, index) => {
    const chapters = mentionedChapters(line);
    const near = chapters.length ? Math.min(...chapters.map((chapter) => Math.abs(chapter - position))) : Infinity;
    return { line, index, near, matches: keys.filter((key) => line.includes(key)).length };
  }).sort((a, b) => (queryFirst
    ? (b.matches - a.matches || a.near - b.near)
    : (a.near - b.near || b.matches - a.matches))
    || (latest ? b.index - a.index : a.index - b.index));
  const chosen = [];
  let room = cap - (notice ? notice.length + 2 : 0);
  for (const item of ranked) {
    if (room <= 1) break;
    if (!chosen.length || item.line.length + 2 <= room) {
      const hit = keys.map((key) => item.line.indexOf(key)).find((index) => index >= 0) ?? 0;
      const start = item.line.length <= room - 2 ? 0 : Math.min(Math.max(0, hit - Math.floor(room / 3)), item.line.length - room + 2);
      const line = item.line.slice(start, start + room - 2).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, "");
      chosen.push({ ...item, line });
      room -= line.length + 2;
    }
  }
  return [notice, ...chosen.sort((a, b) => a.index - b.index).map(({ line }) => line)].filter(Boolean).join("\n\n");
}

export interface NoteBrief { title: string; kind: NoteKind; content: string; source?: "book" | "story" }

/**
 * Notes for one passage (D162, D174): this story's own main plot first, then
 * the book's plot around the reading position, then people, places and
 * factions named in play from either, and notes carried over from an earlier story.
 */
/**
 * A saved question (查一查 存为札记, 问一个问题) about what is being written: at
 * least two of its two-character pieces, request words left out, are in the text.
 */
export function askedAbout(question: string, recent: string): boolean {
  const pieces = new Set<string>();
  for (const run of withoutRequestWords(question).split(/[^\p{L}\p{N}]+/u)) for (let i = 0; i + 2 <= run.length; i++) pieces.add(run.slice(i, i + 2));
  if (!pieces.size) return false;
  const need = Math.min(2, pieces.size);
  let found = 0;
  for (const piece of pieces) if (recent.includes(piece) && ++found >= need) return true;
  return false;
}

export async function notesForTurn(repo: Repo, binding: SourceBinding | null | undefined, worldId: string, recent: string, opts: { allChapters?: boolean } = {}): Promise<NoteBrief[]> {
  const ranked: [number, CanonNote, string, number][] = [];
  const named = (n: CanonNote) => [n.scope.subject, ...(n.scope.aliases ?? [])].map((s) => s?.trim()).filter((s): s is string => !!s).some((name) => recent.includes(name));
  // Answers kept from 查一查 go in when the passage is about them (the toast promises it).
  const asked = (n: CanonNote) => n.kind === "question" && askedAbout(n.scope.question ?? n.title, recent);
  const queryFirst = !!opts.allChapters;
  const qKeys = queryFirst ? terms(withoutRequestWords(recent)).slice(0, 24) : [];
  const overlap = (n: CanonNote) => qKeys.length ? qKeys.filter((k) => n.title.includes(k) || n.content.includes(k)).length : 0;
  if (worldId) {
    const own = (await listStoryNotes(repo, worldId).catch(() => [])).filter((n) => n.active && n.status === "done" && n.content.trim());
    // A note from another route would tell the writer about events that did not happen here.
    const route = own.some((n) => n.scope.toNode || n.progress.routeNode) ? await routeIds(repo, worldId).catch(() => null) : null;
    for (const n of own) {
      if (route && noteOffRoute(n, route)) continue;
      const carried = !!n.originWorldId;
      if (n.kind === "plot" && !carried) ranked.push([0, n, noteExcerpt(n.content, Infinity, queryFirst ? recent : "", true, queryFirst), overlap(n)]);
      else if ((n.kind === "person" || n.kind === "setting") && named(n)) ranked.push([carried ? 4 : 2, n, noteExcerpt(n.content, Infinity, recent, true, queryFirst), overlap(n)]);
      else if (asked(n)) ranked.push([carried ? 4 : 2, n, noteExcerpt(n.content, Infinity, recent, true, queryFirst), overlap(n)]);
      else if (carried && (n.kind === "plot" || n.kind === "timeline")) ranked.push([5, n, noteExcerpt(n.content, Infinity, queryFirst ? recent : "", true, queryFirst), overlap(n)]);
    }
  }
  if (binding) {
    // An answer this story saved was asked within its own reading limit, though it cites no chapter.
    const notes = (await listNotes(repo, binding.bookId, worldId)).filter((n) => n.active && n.status === "done" && n.content.trim()
      && noteWithinScope(n, binding.through, !!worldId && n.worldId === worldId));
    const at = binding.position;
    const ranges = notes.filter((n) => n.kind === "plot" || n.kind === "timeline");
    if (opts.allChapters) {
      // Corrections and lookups search the entire allowed range: rank plot/timeline notes by query match first, then proximity.
      const scored = ranges.map((n) => ({
        n,
        hits: overlap(n),
        dist: (n.scope.from ?? 0) <= at && at <= (n.scope.to ?? Infinity) ? 0
          : Math.min(Math.abs((n.scope.from ?? 0) - at), Math.abs((n.scope.to ?? Infinity) - at)),
      })).sort((a, b) => b.hits - a.hits || a.dist - b.dist);
      for (const { n, hits } of scored.slice(0, 3)) ranked.push([1, n, noteExcerpt(n.content, at, recent, false, true), hits]);
    } else {
      const covering = ranges.filter((n) => (n.scope.from ?? 0) <= at && at <= (n.scope.to ?? Infinity));
      const before = ranges.filter((n) => (n.scope.to ?? Infinity) < at).sort((a, b) => (b.scope.to ?? 0) - (a.scope.to ?? 0));
      for (const n of covering) ranked.push([1, n, noteExcerpt(n.content, at, ""), 0]);
      if (!covering.length && before[0]) ranked.push([1, before[0], noteExcerpt(before[0].content, at, ""), 0]);
    }
    for (const n of notes) if (((n.kind === "person" || n.kind === "setting") && named(n)) || asked(n)) ranked.push([3, n, noteExcerpt(n.content, at, recent, false, queryFirst), overlap(n)]);
  }
  return ranked.sort((a, b) => a[0] - b[0] || b[3] - a[3]).map(([, n, content]) => ({
    title: noteBriefTitle(n), kind: n.kind, content, source: isStory(n) ? "story" as const : "book" as const,
  }));
}

export function noteBriefTitle(note: Pick<CanonNote, "title" | "originTitle" | "scope">): string {
  if (note.originTitle) return `${note.title}（前作《${note.originTitle}》）`;
  if (note.scope.staleFrom !== undefined) return `${note.title}（${turnLabel(note.scope.staleFrom)}之后的正文改过，以正文为准）`;
  return note.title;
}
