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
import { terms } from "./library";
import type { SourceBinding } from "./types";

export const NOTES_PROMPT_VERSION = "canon-notes-2";
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
  /** A deferred batch occupies an empty slot in parts. It is never merged or used in writing. */
  gaps?: NoteGap[];
  failure?: { kind: string; phase: "batch" | "merge"; batch?: number; sections?: number[]; configuration?: string };
  error?: string;
  detail?: string;
}
export interface NoteGap { batch: number; sections: number[] }
export type NoteResume = { kind: "defer"; batch: number } | { kind: "fill"; batch: number; text: string };
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
const MERGE_FAN_IN = 4;

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
export async function saveNote(repo: Repo, note: CanonNote, existingOnly = false): Promise<void> {
  // A cancelled worker may return after deletion. It must never recreate the row.
  if (existingOnly) {
    await repo.platform.sql.batch([{ sql: "UPDATE canon_notes SET title=?,scope_json=?,content=?,refs_json=?,model=?,status=?,active=?,progress_json=?,updated_at=? WHERE id=?",
      params: [note.title, JSON.stringify(note.scope), note.content, JSON.stringify(note.refs), note.model, note.status, note.active ? 1 : 0, JSON.stringify(note.progress), note.updatedAt, note.id] }]);
    return;
  }
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
export async function noteMaterials(repo: Repo, note: Pick<CanonNote, "bookId" | "kind" | "scope">): Promise<(NoteMaterial & { ordinal: number })[]> {
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

export function refusedNoteBatch(progress: NoteProgress): number | undefined {
  const failure = progress.failure;
  if (failure?.phase === "batch" && (failure.kind === "refused" || failure.kind === "suspected_refusal")) return failure.batch;
  // 0.16.1 saved only the display strings. Its batch plan can still identify the next slot.
  if (!failure && progress.error?.startsWith("AI 服务拒绝了这段资料。") && progress.detail?.startsWith("正在整理第 ")) return progress.parts?.length ?? 0;
}

export function noteChapterRange(sections: number[]): string {
  return sections.length === 1 ? `第 ${sections[0] + 1} 章` : `第 ${sections[0] + 1}～${sections.at(-1)! + 1} 章`;
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
export function noteBatchMessages(bookTitle: string, note: Pick<CanonNote, "kind" | "scope">, batch: NoteMaterial[], final: boolean, compact = false): ChatMessage[] {
  const material = batch.map((m) => `\n[第${m.section + 1}章 ${m.title}${m.digest ? " · 已有摘要" : ""}]\n${m.text}`).join("\n");
  return [
    { role: "system", content: `你在为小说《${bookTitle}》整理“原著札记”，供之后写同人故事时参考。只依据下面给出的原著材料，不补材料以外的情节，不评价。${focus(note)}每条末尾用括号标出处章节，如（第12章）。只输出札记正文，不超过 ${compact ? 600 : final ? NOTE_MAX : PART_MAX} 字。${compact ? "直接写简短要点，优先保留推进情节或回答问题的事实。" : ""}` },
    { role: "user", content: `【原著材料】${material}` },
  ];
}

/** Partial notes of the same request → one note. */
export function noteMergeMessages(bookTitle: string, note: Pick<CanonNote, "kind" | "scope">, parts: string[], final: boolean, compact = false): ChatMessage[] {
  return [
    { role: "system", content: `下面是小说《${bookTitle}》同一份原著札记分段整理的结果。合并成一篇完整的札记：去掉重复，按先后顺序，保留每条的出处章节标注。${focus(note)}只输出札记正文，不超过 ${compact ? PART_MAX : final ? NOTE_MAX : PART_MAX * 2} 字。${compact ? "用简短的要点覆盖各段的关键事实。" : ""}` },
    { role: "user", content: parts.map((p, i) => `【第 ${i + 1} 段】\n${p}`).join("\n\n") },
  ];
}

export interface NoteRunner {
  call(messages: ChatMessage[], signal: AbortSignal): Promise<string>;
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
  const hasCitedNotes = /[（(]第\s*\d+\s*章[）)]/.test(content);
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
  const materials = await noteMaterials(repo, note);
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
    throw new Error("原著资料已变化，无法对应旧进度。旧札记仍保留，可以按当前资料新建一份。");
  }
  const refusedBatch = refusedNoteBatch(note.progress);
  if (resume && ((resume.batch !== refusedBatch && (resume.kind !== "fill" || !gaps.some(({ batch }) => batch === resume.batch)))
      || resume.batch > parts.length || resume.batch >= batchSizes.length
      || resume.kind === "fill" && !resume.text.trim())) throw new Error("这批札记的进度已变，请重新打开后再试");
  const refs = [...new Set(materials.map((m) => m.section))];
  const merges = (note.progress.merges ?? []).map((level) => [...level]);
  const progress = (): NoteProgress => ({
    parts: [...parts],
    batchSizes: [...batchSizes],
    merges: merges.map((level) => [...level]),
    materialKeys,
    ...(gaps.length ? { gaps: [...gaps] } : {}),
    total: batchSizes.length + mergeRequests(batchSizes.length),
  });
  let current: CanonNote = { ...note, model: runner.model, refs, status: "running", progress: progress(), updatedAt: new Date().toISOString() };
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
    step = `正在整理${noteChapterRange(pending.sections)}。`;
    return batch;
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
      const { batch: index } = gaps[0];
      const pieces = batchAt(index, batchSizes.slice(0, index).reduce((sum, size) => sum + size, 0));
      parts[index] = await call(noteBatchMessages(bookTitle, note, pieces, batchSizes.length === 1, true));
      gaps.shift();
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
        if (!retryableReply(error) || signal.aborted) throw error;
        if (size > 1) {
          const half = Math.ceil(size / 2);
          batchSizes.splice(index, 1, half, size - half);
          compact = true;
          await save({ progress: progress() });
          continue;
        }
        if (compact || (error instanceof NoteReplyError && error.kind === "context")) throw error;
        content = await call(messages(true));
      }
      parts.push(content);
      offset += size;
      compact = false;
      await save({ progress: progress() });
    }
    if (gaps.length) {
      await save({ status: "paused", progress: progress() });
      return current;
    }
    phase = "merge";
    let mergeCompact = note.status === "failed" && parts.length === (note.progress.parts ?? []).length;
    let level = parts;
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
          if (mergeCompact || !retryableReply(error) || signal.aborted) throw error;
          merged = await call(messages(true));
        }
        mergeCompact = false;
        completed.push(merged);
        next.push(merged);
        await save({ progress: progress() });
      }
      level = next;
    }
    signal.throwIfAborted();
    await save({ content: level[0], status: "done", progress: { parts: [], total: current.progress.total } });
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
export function noteWithinScope(note: Pick<CanonNote, "kind" | "scope" | "refs">, through: number | null): boolean {
  if (through === null) return true;
  if (note.refs.some((section) => !Number.isInteger(section) || section < 0 || section > through)) return false;
  if (note.kind === "plot" || note.kind === "timeline") return Number.isInteger(note.scope.to) && note.scope.to! <= through;
  // Older notes truncated references at 400; their complete scope is unknown.
  return note.refs.length > 0 && note.refs.length < 400;
}

/** Notes for one passage: the main plot around the reading position, then people and settings named in play. */
export async function notesForTurn(repo: Repo, binding: SourceBinding | null | undefined, worldId: string, recent: string): Promise<{ title: string; kind: NoteKind; content: string }[]> {
  if (!binding) return [];
  const notes = (await listNotes(repo, binding.bookId, worldId)).filter((n) => n.active && n.status === "done" && n.content.trim() && noteWithinScope(n, binding.through));
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
