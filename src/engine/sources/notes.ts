// 原著札记 (R29, D162): AI digests of a bound book — the protagonist's main plot
// over a chapter range, everything about one person or one setting, a timeline,
// or the answer to a question. They are written once on the helper model,
// edited by the player, and then carried into each passage at a fraction of
// the cost of re-reading the original. A note is guidance, not evidence: the
// deep tier still checks the original text.
import type { Repo } from "../db/repo";
import { newId } from "../db/repo";
import type { ChatMessage } from "../llm/chat";
import { sourceAnalysisText } from "./facts";
import { terms } from "./library";
import type { SourceBinding } from "./types";

export const NOTES_PROMPT_VERSION = "canon-notes-1";
export type NoteKind = "plot" | "person" | "setting" | "timeline" | "question";
export const NOTE_KINDS: [NoteKind, string, string][] = [
  ["plot", "主线剧情", "某段章节里主角的主要经历、奇遇和转折"],
  ["person", "人物", "一个人物的身份、关系、本事和经历"],
  ["setting", "设定", "势力、功法、地点或规则"],
  ["timeline", "时间线", "某段章节里按先后发生的大事"],
  ["question", "问一个问题", "任何关于原著的问题，答案存下来"],
];
export const NOTE_KIND_LABEL = Object.fromEntries(NOTE_KINDS.map(([k, l]) => [k, l])) as Record<NoteKind, string>;

export interface NoteScope { from?: number; to?: number; subject?: string; aliases?: string[]; question?: string }
export interface NoteProgress { parts: string[]; total: number; error?: string }
export interface CanonNote {
  id: string; bookId: string; worldId: string | null; kind: NoteKind; title: string; scope: NoteScope;
  content: string; refs: number[]; model: string; status: "paused" | "running" | "done" | "failed";
  active: boolean; progress: NoteProgress; createdAt: string; updatedAt: string;
}
/** One piece of material: a chunk's existing digest when there is one, else its text. */
export interface NoteMaterial { section: number; title: string; text: string; digest: boolean }

/** About 16 000 characters of material per helper-model request. */
export const NOTE_BATCH_CHARS = 16_000;
const SEARCH_LIMIT = 24;
const NOTE_MAX = 3000, PART_MAX = 1200;

const rowNote = (r: Record<string, unknown>): CanonNote => ({
  id: String(r.id), bookId: String(r.book_id), worldId: r.world_id == null ? null : String(r.world_id), kind: String(r.kind) as NoteKind,
  title: String(r.title), scope: JSON.parse(String(r.scope_json || "{}")), content: String(r.content ?? ""), refs: JSON.parse(String(r.refs_json || "[]")),
  model: String(r.model ?? ""), status: String(r.status) as CanonNote["status"], active: Number(r.active) === 1,
  progress: JSON.parse(String(r.progress_json || "{}")), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
});

/** Notes of a book; with a world, only the book's shared notes and that world's own. */
export async function listNotes(repo: Repo, bookId: string, worldId?: string | null): Promise<CanonNote[]> {
  const rows = worldId === undefined
    ? await repo.platform.sql.query("SELECT * FROM canon_notes WHERE book_id=? ORDER BY created_at", [bookId])
    : await repo.platform.sql.query("SELECT * FROM canon_notes WHERE book_id=? AND (world_id IS NULL OR world_id=?) ORDER BY created_at", [bookId, worldId]);
  return rows.map(rowNote);
}
export async function getNote(repo: Repo, id: string): Promise<CanonNote | null> {
  const [row] = await repo.platform.sql.query("SELECT * FROM canon_notes WHERE id=?", [id]);
  return row ? rowNote(row) : null;
}
export async function saveNote(repo: Repo, note: CanonNote): Promise<void> {
  await repo.platform.sql.batch([{
    sql: `INSERT INTO canon_notes(id,book_id,world_id,kind,title,scope_json,content,refs_json,model,status,active,progress_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,scope_json=excluded.scope_json,content=excluded.content,
      refs_json=excluded.refs_json,model=excluded.model,status=excluded.status,active=excluded.active,progress_json=excluded.progress_json,updated_at=excluded.updated_at`,
    params: [note.id, note.bookId, note.worldId, note.kind, note.title, JSON.stringify(note.scope), note.content, JSON.stringify(note.refs), note.model,
      note.status, note.active ? 1 : 0, JSON.stringify(note.progress), note.createdAt, note.updatedAt],
  }]);
}
export async function deleteNote(repo: Repo, id: string): Promise<void> {
  await repo.platform.sql.batch([{ sql: "DELETE FROM canon_notes WHERE id=?", params: [id] }]);
}

export function newNote(bookId: string, kind: NoteKind, scope: NoteScope, title: string, worldId: string | null = null): CanonNote {
  const now = new Date().toISOString();
  return { id: newId(), bookId, worldId, kind, title: title.trim() || NOTE_KIND_LABEL[kind], scope, content: "", refs: [], model: "", status: "paused", active: true, progress: { parts: [], total: 0 }, createdAt: now, updatedAt: now };
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
export async function noteMaterials(repo: Repo, note: Pick<CanonNote, "bookId" | "kind" | "scope">): Promise<NoteMaterial[]> {
  const sections = new Map((await repo.platform.sql.query("SELECT section,title FROM source_sections WHERE book_id=?", [note.bookId])).map((r) => [Number(r.section), String(r.title)]));
  if (!sections.size) return [];
  const last = Math.max(...sections.keys());
  let rows: Record<string, unknown>[];
  if (note.kind === "plot" || note.kind === "timeline") {
    const from = Math.max(0, note.scope.from ?? 0), to = Math.min(last, note.scope.to ?? last);
    rows = await repo.platform.sql.query("SELECT ordinal,section,text FROM source_chunks WHERE book_id=? AND section BETWEEN ? AND ? ORDER BY ordinal", [note.bookId, from, to]);
  } else {
    const query = note.kind === "question" ? note.scope.question ?? "" : [note.scope.subject ?? "", ...(note.scope.aliases ?? [])].join("\n");
    const keys = terms(query);
    if (!keys.length) return [];
    const scores = new Map<number, number>();
    for (const row of await repo.platform.sql.query(`SELECT term,postings FROM source_terms WHERE book_id=? AND term IN (${keys.map(() => "?").join(",")})`, [note.bookId, ...keys])) {
      const postings = JSON.parse(String(row.postings)) as number[];
      for (const ordinal of postings) scores.set(ordinal, (scores.get(ordinal) ?? 0) + 1 / Math.sqrt(postings.length));
    }
    // A name of two characters is one bigram: insist on the whole name where one was given.
    const whole = note.kind === "question" ? [] : [note.scope.subject ?? "", ...(note.scope.aliases ?? [])].map((s) => s.trim()).filter(Boolean);
    const ranked = [...scores].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, SEARCH_LIMIT * 3).map(([ordinal]) => ordinal);
    if (!ranked.length) return [];
    rows = await repo.platform.sql.query(`SELECT ordinal,section,text FROM source_chunks WHERE book_id=? AND ordinal IN (${ranked.map(() => "?").join(",")})`, [note.bookId, ...ranked]);
    if (whole.length) rows = rows.filter((r) => whole.some((name) => String(r.text).includes(name)));
    const order = new Map(ranked.map((o, i) => [o, i]));
    rows = rows.sort((a, b) => order.get(Number(a.ordinal))! - order.get(Number(b.ordinal))!).slice(0, SEARCH_LIMIT).sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
  }
  // An earlier 通读整理 already digested these chunks: its summaries cost far less to read.
  const digests = new Map<number, string>();
  if (rows.length) for (const r of await repo.platform.sql.query(`SELECT ordinal,text FROM source_analysis WHERE book_id=? AND ordinal IN (${rows.map(() => "?").join(",")})`, [note.bookId, ...rows.map((r) => Number(r.ordinal))])) {
    digests.set(Number(r.ordinal), sourceAnalysisText(String(r.text)));
  }
  const ranged = note.kind === "plot" || note.kind === "timeline";
  return rows.filter((r) => String(r.text).trim()).map((r) => {
    const digest = ranged ? digests.get(Number(r.ordinal)) : undefined;
    return { section: Number(r.section), title: sections.get(Number(r.section)) ?? "", text: digest ?? String(r.text), digest: !!digest };
  });
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
  const per = Math.max(2, Math.floor(NOTE_BATCH_CHARS / PART_MAX));
  while (count > 1) { const next = Math.ceil(count / per); n += next; count = next; }
  return n;
}

export interface NoteEstimate { requests: number; chars: number; pieces: number; digests: number }
export async function estimateNote(repo: Repo, note: Pick<CanonNote, "bookId" | "kind" | "scope">): Promise<NoteEstimate> {
  const materials = await noteMaterials(repo, note);
  const batches = noteBatches(materials);
  return { requests: batches.length + mergeRequests(batches.length), chars: materials.reduce((n, m) => n + m.text.length, 0), pieces: materials.length, digests: materials.filter((m) => m.digest).length };
}

function focus(note: Pick<CanonNote, "kind" | "scope">): string {
  const names = [note.scope.subject, ...(note.scope.aliases ?? [])].filter(Boolean).join("、");
  switch (note.kind) {
    case "plot": return "整理主角在这些章节里的主要经历：做了什么、遇到了谁、奇遇与收获、实力或身份的变化、关键转折、和重要人物关系的变化。按先后顺序分条，每条一两句。";
    case "timeline": return "按先后顺序列出这些章节里发生的大事：谁、在哪里、做了什么、结果如何。每条一行。";
    case "person": return `整理与「${names}」有关的内容：身份来历、外貌性格、本事与成长、和其他人物的关系、经历的重要事件、说话的样子。`;
    case "setting": return `整理与「${names}」有关的设定：它是什么、规则与限制、相关的人物和势力、在情节里起的作用。`;
    case "question": return `回答这个问题：「${note.scope.question ?? ""}」。按要点作答；材料里找不到答案就直说没有找到。`;
  }
}

/** One batch of original material → a partial (or, for a single batch, the whole) note. */
export function noteBatchMessages(bookTitle: string, note: Pick<CanonNote, "kind" | "scope">, batch: NoteMaterial[], final: boolean): ChatMessage[] {
  const material = batch.map((m) => `\n[第${m.section + 1}章 ${m.title}${m.digest ? " · 已有摘要" : ""}]\n${m.text}`).join("\n");
  return [
    { role: "system", content: `你在为小说《${bookTitle}》整理“原著札记”，供之后写同人故事时参考。只依据下面给出的原著材料，不补材料以外的情节，不评价。${focus(note)}每条末尾用括号标出处章节，如（第12章）。只输出札记正文，不超过 ${final ? NOTE_MAX : PART_MAX} 字。` },
    { role: "user", content: `【原著材料】${material}` },
  ];
}

/** Partial notes of the same request → one note. */
export function noteMergeMessages(bookTitle: string, note: Pick<CanonNote, "kind" | "scope">, parts: string[], final: boolean): ChatMessage[] {
  return [
    { role: "system", content: `下面是小说《${bookTitle}》同一份原著札记分段整理的结果。合并成一篇完整的札记：去掉重复，按先后顺序，保留每条的出处章节标注。${focus(note)}只输出札记正文，不超过 ${final ? NOTE_MAX : PART_MAX * 2} 字。` },
    { role: "user", content: parts.map((p, i) => `【第 ${i + 1} 段】\n${p}`).join("\n\n") },
  ];
}

export interface NoteRunner {
  call(messages: ChatMessage[], signal: AbortSignal): Promise<string>;
  model: string;
}

/**
 * Write (or resume) a note: each batch is digested once and saved, so a pause
 * or a failure keeps the finished parts; then the parts are merged.
 */
export async function runNote(repo: Repo, note: CanonNote, bookTitle: string, runner: NoteRunner, signal: AbortSignal, onProgress: (note: CanonNote) => void): Promise<CanonNote> {
  const materials = await noteMaterials(repo, note);
  if (!materials.length) throw new Error(note.kind === "plot" || note.kind === "timeline" ? "这段章节里没有正文" : "原著里没有找到相关内容，换个名字或别名试试");
  const batches = noteBatches(materials);
  const refs = [...new Set(materials.map((m) => m.section))].slice(0, 400);
  let current: CanonNote = { ...note, model: runner.model, refs, status: "running", progress: { parts: note.progress.parts ?? [], total: batches.length + mergeRequests(batches.length) }, updatedAt: new Date().toISOString() };
  const save = async (patch: Partial<CanonNote>) => { current = { ...current, ...patch, updatedAt: new Date().toISOString() }; await saveNote(repo, current); onProgress({ ...current }); };
  await save({});
  try {
    if (batches.length === 1) {
      const content = await runner.call(noteBatchMessages(bookTitle, note, batches[0], true), signal);
      await save({ content: content.trim(), status: "done", progress: { parts: [], total: 1 } });
      return current;
    }
    const parts = [...current.progress.parts];
    for (let i = parts.length; i < batches.length; i++) {
      if (signal.aborted) { await save({ status: "paused", progress: { ...current.progress, parts } }); return current; }
      parts.push((await runner.call(noteBatchMessages(bookTitle, note, batches[i], false), signal)).trim());
      await save({ progress: { ...current.progress, parts } });
    }
    let level = parts;
    while (level.length > 1) {
      if (signal.aborted) { await save({ status: "paused" }); return current; }
      const groups = noteBatches(level.map((text) => ({ section: 0, title: "", text, digest: false })));
      const final = groups.length === 1;
      const next: string[] = [];
      for (const group of groups) next.push((await runner.call(noteMergeMessages(bookTitle, note, group.map((g) => g.text), final), signal)).trim());
      level = next;
    }
    await save({ content: level[0] ?? "", status: "done", progress: { parts: [], total: current.progress.total } });
  } catch (error) {
    await save(signal.aborted ? { status: "paused" } : { status: "failed", progress: { ...current.progress, error: error instanceof Error ? error.message : "没能整理" } });
  }
  return current;
}

/** Notes for one passage: the main plot around the reading position, then people and settings named in play. */
export async function notesForTurn(repo: Repo, binding: SourceBinding | null | undefined, worldId: string, recent: string): Promise<{ title: string; kind: NoteKind; content: string }[]> {
  if (!binding) return [];
  const notes = (await listNotes(repo, binding.bookId, worldId)).filter((n) => n.active && n.status === "done" && n.content.trim());
  const at = binding.position;
  const ranked: [number, CanonNote][] = [];
  const ranges = notes.filter((n) => n.kind === "plot" || n.kind === "timeline");
  const covering = ranges.filter((n) => (n.scope.from ?? 0) <= at && at <= (n.scope.to ?? Infinity));
  const before = ranges.filter((n) => (n.scope.to ?? Infinity) < at).sort((a, b) => (b.scope.to ?? 0) - (a.scope.to ?? 0));
  for (const n of covering) ranked.push([0, n]);
  if (!covering.length && before[0]) ranked.push([1, before[0]]);
  for (const n of notes) {
    if (n.kind !== "person" && n.kind !== "setting") continue;
    const names = [n.scope.subject, ...(n.scope.aliases ?? [])].map((s) => s?.trim()).filter((s): s is string => !!s);
    if (names.some((name) => recent.includes(name))) ranked.push([2, n]);
  }
  return ranked.sort((a, b) => a[0] - b[0]).map(([, n]) => ({ title: n.title, kind: n.kind, content: n.content }));
}
