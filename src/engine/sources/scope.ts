// 资料范围 (D184): what one request about the original may use — found
// automatically, only chosen notes, or chosen chapters of the book. The choice
// lives only in that request (the run plan's `meta.sourceScope`, removed when it
// commits); the story's own reference settings never change. The native core
// enforces it on every lookup.
import type { Repo } from "../db/repo";
import { matchWindow, passageLabel, queryTerms, referenceContext } from "./library";
import { getNote, listNotes, listStoryNotes, noteBriefTitle, noteOffRoute, noteWithinScope, routeIds, type CanonNote, type NoteBrief } from "./notes";
import type { ReferenceContext, ReferencePassage, ReferenceQuery, SourceBinding } from "./types";

export type SourceScope =
  | { mode: "auto" }
  | { mode: "chapters"; from: number; to: number }
  | { mode: "notes"; noteIds: string[] };
export type ChosenScope = Exclude<SourceScope, { mode: "auto" }>;
export interface ScopeRange { from: number; to: number }

export const AUTO_SCOPE: SourceScope = { mode: "auto" };
export const isChosen = (scope: SourceScope | null | undefined): scope is ChosenScope =>
  !!scope && (scope.mode === "chapters" || (scope.mode === "notes" && scope.noteIds.length > 0));

/** “自动”, “第 3～5 节”, “2 份札记”: the row in each feature. */
export function scopeLabel(scope: SourceScope | null | undefined): string {
  if (!isChosen(scope)) return "自动";
  if (scope.mode === "chapters") return chapterWords(scope);
  return `${scope.noteIds.length} 份札记`;
}
/** “第 3 节 · 渡口”, or the title alone when it already names its chapter (“第三章 渡口”). */
export const chapterLabel = (section: number, title?: string) => {
  const t = (title ?? "").trim().slice(0, 24);
  return !t
    ? `第 ${section + 1} 节`
    : /^(?:第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[章回节卷集部篇话幕折]|(?:序章|序言|楔子|尾声|后记|前言|引子)|chapter\s+\d+)/i.test(t)
      ? t
      : `第 ${section + 1} 节 · ${t}`;
};
export const chapterWords = (r: ScopeRange) => r.from === r.to ? `第 ${r.from + 1} 节` : `第 ${r.from + 1}～${r.to + 1} 节`;

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/** Parse Arabic digits or standard Chinese numerals (e.g. “三十五” → 35, “零” → 0, “一百零八” → 108). */
export function parseChapterNumeral(raw: string): number | null {
  const s = raw.trim().replace(/^第\s*/, "").replace(/\s*[章回节卷集部篇话幕折]$/, "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  if (s === "零" || s === "〇") return 0;
  let total = 0, section = 0, current = 0, hasDigit = false;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch];
      hasDigit = true;
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (unit === 10000) {
        section = (section + current) * unit;
        total += section;
        section = 0;
        current = 0;
      } else {
        section += (current === 0 && !hasDigit && unit === 10 ? 1 : current === 0 && unit === 10 ? 1 : current) * unit;
        current = 0;
      }
      hasDigit = true;
    } else {
      return null;
    }
  }
  const value = total + section + current;
  return hasDigit && value > 0 ? value : null;
}

/** Chapter numbers explicitly stated in a section title; volume numbers (卷/部/篇/集) are ignored when a chapter number is present. */
export function extractChapterNumbers(title: string): number[] {
  const nums = new Set<number>();
  for (const m of title.matchAll(/第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*[章回节话幕折]/g)) {
    const n = parseChapterNumeral(m[1]);
    if (n !== null) nums.add(n);
  }
  for (const m of title.matchAll(/\bchapter\s+(\d{1,5})\b/gi)) {
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n >= 0) nums.add(n);
  }
  if (!nums.size) {
    for (const m of title.matchAll(/第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*[卷集部篇]/g)) {
      const n = parseChapterNumeral(m[1]);
      if (n !== null) nums.add(n);
    }
    const leading = /^\s*(\d{1,5})(?:[.、\s\-—:：]|$)/.exec(title);
    if (leading) {
      const n = Number(leading[1]);
      if (Number.isSafeInteger(n) && n >= 0) nums.add(n);
    }
  }
  return [...nums];
}

/** Rank a chapter row against user search input: 2 = title/chapter-number match, 1 = 1-based section order fallback, 0 = no match. */
export function chapterQueryRank(chapter: BookChapter, query: string): 0 | 1 | 2 {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 2;
  const titleLower = chapter.title.toLowerCase();
  const titleNumbers = extractChapterNumbers(chapter.title);
  const indexNum = chapter.section + 1;
  let titleOnly = true;
  for (const token of tokens) {
    if (titleLower.includes(token)) continue;
    const n = parseChapterNumeral(token);
    if (n !== null && titleNumbers.includes(n)) continue;
    if (n !== null && n === indexNum) { titleOnly = false; continue; }
    return 0;
  }
  return titleOnly ? 2 : 1;
}

/** Match a chapter row against user search input (title text, Arabic/Chinese chapter number, or 1-based section index). */
export function matchChapterQuery(chapter: BookChapter, query: string): boolean {
  return chapterQueryRank(chapter, query) > 0;
}

/** Real book title & shifted-index indicator for a chapter directory row. */
export function chapterRowMeta(chapter: BookChapter): { primary: string; shifted: boolean } {
  const primary = chapter.title.trim() || `第 ${chapter.section + 1} 节`;
  const nums = extractChapterNumbers(primary);
  const shifted = nums.length > 0 && !nums.includes(chapter.section + 1);
  return { primary, shifted };
}

/** Compact real-title summary for a chapter range (falls back to `chapterWords` when titles are unavailable). */
export function chapterRangeSummary(chapters: BookChapter[], range: ScopeRange): string {
  const bySection = new Map(chapters.map((c) => [c.section, c]));
  const start = bySection.get(range.from);
  const end = bySection.get(range.to);
  if (range.from === range.to) return chapterLabel(range.from, start?.title);
  const a = chapterLabel(range.from, start?.title);
  const b = chapterLabel(range.to, end?.title);
  return a === b ? `${a}（第 ${range.from + 1} 节） ～ ${b}（第 ${range.to + 1} 节）` : `${a} ～ ${b}`;
}

export interface BookChapter { section: number; title: string; chars: number; chunks?: number }

/** The chapters the story may read (up to its 截至第几章), with their length. */
export async function bookChapters(repo: Repo, binding: SourceBinding): Promise<BookChapter[]> {
  const rows = await repo.platform.sql.query(`SELECT s.section, s.title, COALESCE(SUM(LENGTH(c.text)), 0) AS chars, COUNT(c.ordinal) AS chunks
    FROM source_sections s LEFT JOIN source_chunks c ON c.book_id = s.book_id AND c.section = s.section
    WHERE s.book_id = ? AND (? IS NULL OR s.section <= ?) GROUP BY s.section, s.title ORDER BY s.section`, [binding.bookId, binding.through, binding.through]);
  return rows.map((r) => ({ section: Number(r.section), title: String(r.title), chars: Number(r.chars), chunks: Number(r.chunks) }));
}
export const rangeChars = (chapters: BookChapter[], range: ScopeRange) =>
  chapters.filter((c) => c.section >= range.from && c.section <= range.to).reduce((n, c) => n + c.chars, 0);
/** Conservative whole-chapter fit estimate aligned with `rangeContext` and native JSON budget accounting. */
export function wholeChapterFits(chapters: BookChapter[], range: ScopeRange, room: number): boolean {
  if (room <= 0) return false;
  const picked = chapters.filter((c) => c.section >= range.from && c.section <= range.to);
  if (!picked.length) return false;
  const chars = picked.reduce((n, c) => n + c.chars, 0);
  const chunks = picked.reduce((n, c) => n + Math.max(1, c.chunks ?? 1), 0);
  return Math.ceil(chars * 1.06) + chunks * 120 <= room;
}

async function availableNotes(repo: Repo, notes: CanonNote[], binding: SourceBinding | null | undefined, worldId: string | null): Promise<CanonNote[]> {
  const route = worldId && notes.some((n) => n.source === "story" && n.worldId === worldId && (n.scope.toNode || n.progress.routeNode))
    ? await routeIds(repo, worldId) : null;
  return notes.filter((n) => {
    if (n.status !== "done" || !n.active || !n.content.trim()) return false;
    if (n.source === "story") return !!worldId && n.worldId === worldId && (!route || !noteOffRoute(n, route));
    return !!binding && n.bookId === binding.bookId && (n.worldId === null || n.worldId === worldId)
      && noteWithinScope(n, binding.through, !!worldId && n.worldId === worldId);
  });
}

/** The notes one may choose: the book's (shared and this story's) and this story's own, finished ones only. */
export async function choosableNotes(repo: Repo, binding: SourceBinding | null | undefined, worldId: string | null): Promise<{ book: CanonNote[]; story: CanonNote[] }> {
  const [book, story] = await Promise.all([binding ? listNotes(repo, binding.bookId, worldId) : [], worldId ? listStoryNotes(repo, worldId) : []]);
  const eligible = await availableNotes(repo, [...book, ...story], binding, worldId);
  return { book: eligible.filter((n) => n.source !== "story"), story: eligible.filter((n) => n.source === "story") };
}

/** The chapters a set of book notes covers, or null (本局札记 count turns, not chapters). */
export function notesRange(notes: CanonNote[]): ScopeRange | null {
  const sections = notes.filter((n) => n.source !== "story").flatMap((n) => [
    ...n.refs.filter((r) => Number.isInteger(r) && r >= 0),
    ...[n.scope.from, n.scope.to].filter((r): r is number => Number.isInteger(r) && (r as number) >= 0),
  ]);
  return sections.length ? { from: Math.min(...sections), to: Math.max(...sections) } : null;
}

/** The whole text of the chosen chapters as original passages, when it fits `room`; otherwise undefined. */
export async function rangeContext(repo: Repo, binding: SourceBinding, range: ScopeRange, room: number): Promise<ReferenceContext | undefined> {
  const [book] = await repo.platform.sql.query("SELECT id, title FROM source_books WHERE id = ?", [binding.bookId]);
  if (!book) return;
  const to = binding.through === null ? range.to : Math.min(range.to, binding.through);
  const params = [binding.bookId, range.from, to];
  const [size] = await repo.platform.sql.query("SELECT SUM(LENGTH(text) + 96) AS chars FROM source_chunks WHERE book_id = ? AND section >= ? AND section <= ?", params);
  // Reject large chapter ranges within SQLite before moving the text over the native bridge.
  if (size?.chars == null || Number(size.chars) > room) return;
  const rows = await repo.platform.sql.query(`SELECT c.ordinal, c.section, c.text, s.title, s.page FROM source_chunks c
    JOIN source_sections s ON s.book_id = c.book_id AND s.section = c.section
    WHERE c.book_id = ? AND c.section >= ? AND c.section <= ? ORDER BY c.ordinal`, params);
  if (!rows.length) return;
  const passages: ReferencePassage[] = rows.map((r) => ({
    section: Number(r.section), title: String(r.title), ...(r.page == null ? {} : { page: Number(r.page) }), chunk: Number(r.ordinal),
    text: String(r.text), kind: "original" as const, start: 0, end: String(r.text).length,
  }));
  // Match both exact prompt label size and Rust `bound_sources` (`passage.to_string()` UTF-16 length)
  // so chapters promised as whole are never silently truncated at send time.
  if (passages.reduce((n, p) => n + passageLabel(p).length + p.text.length + 1, 0) > room) return;
  if (passages.reduce((n, p) => n + JSON.stringify(p).length, 0) > room) return;
  const posSection = Math.max(0, Math.min(binding.position, to));
  const [posRow] = await repo.platform.sql.query("SELECT title FROM source_sections WHERE book_id = ? AND section = ?", [binding.bookId, posSection]);
  const [throughRow] = binding.through === null ? [] : await repo.platform.sql.query("SELECT title FROM source_sections WHERE book_id = ? AND section = ?", [binding.bookId, to]);
  return {
    bookId: String(book.id), title: String(book.title), binding: { ...binding }, passages,
    ...(posRow ? { positionTitle: String(posRow.title) } : {}),
    ...(throughRow ? { throughTitle: String(throughRow.title) } : {}),
    status: "ready",
  };
}

/** The chosen notes, each cut to its share of `room` around what is asked. */
async function scopedNotes(repo: Repo, noteIds: string[], query: string | ReferenceQuery, room: number, binding: SourceBinding | null | undefined, worldId: string | null): Promise<{ briefs: NoteBrief[]; notes: CanonNote[] }> {
  const ids = [...new Set(noteIds)];
  const existing = (await Promise.all(ids.map((id) => getNote(repo, id)))).filter((n): n is CanonNote => !!n);
  const notes = await availableNotes(repo, existing, binding, worldId);
  if (notes.length !== ids.length) throw new Error("所选札记已不适用于这个故事或当前路线，请重新选择资料范围。");
  const share = Math.floor(room / Math.max(1, notes.length));
  const keys = queryTerms(query, "");
  const titles = notes.map(noteBriefTitle);
  if (titles.some((title) => share - title.length - 24 < 1)) throw new Error("选中的札记太多，请少选几份再试。");
  const briefs = notes.map((n, index): NoteBrief => {
    const title = titles[index];
    const limit = share - title.length - 24;
    const content = n.content.length > limit ? matchWindow(n.content, keys, limit).text : n.content;
    return { title, kind: n.kind, content, source: n.source === "story" ? "story" : "book" };
  });
  return { briefs, notes };
}

/** One line for the request, so the model does not spend its lookups finding the limit (D184). */
export function scopeNote(meta: Record<string, unknown>): string {
  const range = typeof meta.from === "number" && typeof meta.to === "number" ? chapterWords({ from: meta.from, to: meta.to }) : "";
  if (meta.mode === "chapters") return `\n【资料范围】这次只用原著${range}，查原文也只在这几节里。`;
  if (meta.mode !== "notes") return "";
  return meta.lookups ? `\n【资料范围】这次先用上面给出的札记${range ? `；查原文只在${range}里` : ""}。` : "\n【资料范围】这次只用上面给出的札记，不查原文。";
}

export interface ScopedMaterial {
  /** Original passages that go into the request; a correction may cite them. */
  reference?: ReferenceContext;
  notes: NoteBrief[];
  /** The chosen chapters went in whole (otherwise they were searched). */
  whole: boolean;
  /** For the native run's lookups (`meta.sourceScope`); never kept with the story. */
  meta: Record<string, unknown>;
}

/**
 * What one request gets for a chosen scope. Chapters: whole when they fit in
 * `room`, else the passages about `query` found within them. Notes: the chosen
 * notes only; `lookups` (按原著纠错, which must cite the original) may also read
 * the chapters the chosen book notes cover.
 */
export async function scopedMaterial(repo: Repo, binding: SourceBinding | null | undefined, scope: ChosenScope, query: string | ReferenceQuery, room: number, opts: { worldId?: string; lookups?: boolean } = {}): Promise<ScopedMaterial> {
  if (scope.mode === "chapters") {
    const range = { from: Math.max(0, Math.min(scope.from, scope.to)), to: Math.max(scope.from, scope.to) };
    const whole = binding ? await rangeContext(repo, binding, range, room) : undefined;
    const reference = whole ?? await referenceContext(repo, binding, query, room, range);
    return { reference, notes: [], whole: !!whole, meta: { mode: "chapters", ...range } };
  }
  const lookups = !!opts.lookups && !!binding;
  const { briefs, notes } = await scopedNotes(repo, scope.noteIds, query, lookups ? Math.floor(room / 2) : room, binding, opts.worldId ?? null);
  const range = lookups ? notesRange(notes) : null;
  const reference = lookups ? await referenceContext(repo, binding, query, Math.floor(room / 2), range) : undefined;
  return { reference, notes: briefs, whole: false, meta: { mode: "notes", noteIds: notes.map((n) => n.id), ...(lookups ? { lookups: true, ...(range ?? {}) } : {}) } };
}
