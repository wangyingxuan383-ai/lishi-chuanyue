// Bookshelf preferences, reading duration statistics, fast shelf aggregation,
// and one-tap "save interactive world story into 书斋 library" helper (R36-T003).
// Uses existing `settings` key-value storage + `reader_*` / `source_*` tables
// so zero new SQLite schema tables are introduced and `empty_database()` stays untouched.
import type { SqlStatement } from "../../platform";
import { newId, type Repo } from "../db/repo";
import { buildNovelBook } from "../novel";
import {
  chunkStatements,
  chunksOf,
  getBooksCharMetrics,
  hasBookExternalReferences,
  indexChunksTermsAsync,
  saveBook,
  sectionStatements,
  slimBookJson,
  termStatements,
} from "../sources/library";
import { createSectionSnippetLocator } from "../sources/resplit";
import type { SourceBook } from "../sources/types";
import {
  ensureReaderSchema,
  type ReaderProgress,
  type ReaderTargetType,
} from "./store";

export interface BookShelfPref {
  pinned?: boolean;
  coverTone?: number | null;
  finished?: boolean;
  author?: string;
  origin?: string;
  sourceWorldId?: string;
  sourceLineId?: string;
}

export interface ReadingStatsStore {
  totalSeconds: number;
  byDate: Record<string, number>;
  byTarget: Record<string, number>;
}

export interface ReadingStatsSummary {
  todaySeconds: number;
  todayMinutes: number;
  weekMinutes: number;
  totalMinutes: number;
  streakDays: number;
}

export interface LibraryShelfItem {
  id: string;
  title: string;
  format: string;
  createdAt: string;
  sectionCount: number;
  totalChars: number;
  progress: ReaderProgress | null;
  currentSectionTitle: string;
  progressPct: number;
  highlightCount: number;
  bookmarkCount: number;
  readingSeconds: number;
  pinned: boolean;
  coverTone: number | null;
  finished: boolean;
  author: string;
  origin?: string;
  sourceWorldId?: string;
  sourceLineId?: string;
  lastActiveAt: string;
}

const BOOK_PREFS_KEY = "reader:bookPrefs";
const DAILY_STATS_KEY = "reader:dailyStats";

export function localDateKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function getAllBookShelfPrefs(repo: Repo): Promise<Record<string, BookShelfPref>> {
  const raw = await repo.getSetting<unknown>(BOOK_PREFS_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, BookShelfPref> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const item = v as Record<string, unknown>;
    out[k] = {
      pinned: item.pinned === true,
      coverTone: typeof item.coverTone === "number" && Number.isFinite(item.coverTone)
        ? ((Math.trunc(item.coverTone) % 8) + 8) % 8
        : null,
      finished: item.finished === true,
      author: typeof item.author === "string" ? item.author.trim().slice(0, 40) : "",
      ...(typeof item.origin === "string" && item.origin.trim()
        ? { origin: item.origin.trim().slice(0, 40) }
        : {}),
      ...(typeof item.sourceWorldId === "string" && item.sourceWorldId.trim()
        ? { sourceWorldId: item.sourceWorldId.trim().slice(0, 80) }
        : {}),
      ...(typeof item.sourceLineId === "string" && item.sourceLineId.trim()
        ? { sourceLineId: item.sourceLineId.trim().slice(0, 80) }
        : {}),
    };
  }
  return out;
}

export async function updateBookShelfPref(
  repo: Repo,
  bookId: string,
  patch: Partial<BookShelfPref>,
): Promise<BookShelfPref> {
  const all = await getAllBookShelfPrefs(repo);
  const prev = all[bookId] ?? {};
  const nextOrigin =
    patch.origin !== undefined ? patch.origin.trim().slice(0, 40) : (prev.origin ?? "");
  const nextSourceWorldId =
    patch.sourceWorldId !== undefined
      ? patch.sourceWorldId.trim().slice(0, 80)
      : (prev.sourceWorldId ?? "");
  const nextSourceLineId =
    patch.sourceLineId !== undefined
      ? patch.sourceLineId.trim().slice(0, 80)
      : (prev.sourceLineId ?? "");
  const next: BookShelfPref = {
    pinned: patch.pinned !== undefined ? !!patch.pinned : !!prev.pinned,
    coverTone:
      patch.coverTone !== undefined
        ? patch.coverTone === null
          ? null
          : ((Math.trunc(patch.coverTone) % 8) + 8) % 8
        : (prev.coverTone ?? null),
    finished: patch.finished !== undefined ? !!patch.finished : !!prev.finished,
    author:
      patch.author !== undefined
        ? patch.author.trim().slice(0, 40)
        : (prev.author ?? ""),
    ...(nextOrigin ? { origin: nextOrigin } : {}),
    ...(nextSourceWorldId ? { sourceWorldId: nextSourceWorldId } : {}),
    ...(nextSourceLineId ? { sourceLineId: nextSourceLineId } : {}),
  };
  all[bookId] = next;
  await repo.setSetting(BOOK_PREFS_KEY, all);
  return next;
}

export const upsertReaderShelfMeta = updateBookShelfPref;

async function loadStatsStore(repo: Repo): Promise<ReadingStatsStore> {
  const raw = await repo.getSetting<unknown>(DAILY_STATS_KEY, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { totalSeconds: 0, byDate: {}, byTarget: {} };
  }
  const obj = raw as Record<string, unknown>;
  const byDate: Record<string, number> = {};
  if (obj.byDate && typeof obj.byDate === "object" && !Array.isArray(obj.byDate)) {
    for (const [k, v] of Object.entries(obj.byDate as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        byDate[k] = Math.round(v);
      }
    }
  }
  const byTarget: Record<string, number> = {};
  if (obj.byTarget && typeof obj.byTarget === "object" && !Array.isArray(obj.byTarget)) {
    for (const [k, v] of Object.entries(obj.byTarget as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) {
        byTarget[k] = Math.round(v);
      }
    }
  }
  const totalSeconds =
    typeof obj.totalSeconds === "number" && Number.isFinite(obj.totalSeconds) && obj.totalSeconds >= 0
      ? Math.round(obj.totalSeconds)
      : Object.values(byDate).reduce((acc, s) => acc + s, 0);
  return { totalSeconds, byDate, byTarget };
}

let latestReadingStatsFlush: Promise<void> = Promise.resolve();

export function recordReadingSeconds(
  repo: Repo,
  targetType: ReaderTargetType,
  targetId: string,
  deltaSeconds: number,
  now = new Date(),
): Promise<void> {
  if (!targetId || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return Promise.resolve();
  const clamped = Math.min(300, Math.max(1, Math.round(deltaSeconds)));
  const run = latestReadingStatsFlush
    .catch(() => {})
    .then(async () => {
      const store = await loadStatsStore(repo);
      const dayKey = localDateKey(now);
      store.totalSeconds += clamped;
      store.byDate[dayKey] = (store.byDate[dayKey] ?? 0) + clamped;
      const targetKey = `${targetType}:${targetId}`;
      store.byTarget[targetKey] = (store.byTarget[targetKey] ?? 0) + clamped;

      // Keep only the latest 120 calendar days in `byDate` to bound settings JSON size.
      const keys = Object.keys(store.byDate).sort();
      if (keys.length > 120) {
        for (const oldKey of keys.slice(0, keys.length - 120)) {
          delete store.byDate[oldKey];
        }
      }
      await repo.setSetting(DAILY_STATS_KEY, store);
    });
  latestReadingStatsFlush = run.catch(() => {});
  return run;
}

export async function getReadingStatsSummary(repo: Repo, now = new Date()): Promise<ReadingStatsSummary> {
  await latestReadingStatsFlush;
  const store = await loadStatsStore(repo);
  const todayKey = localDateKey(now);
  const todaySeconds = store.byDate[todayKey] ?? 0;

  let weekSeconds = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    weekSeconds += store.byDate[localDateKey(d)] ?? 0;
  }

  let streakDays = 0;
  for (let i = 0; i < 120; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const secs = store.byDate[localDateKey(d)] ?? 0;
    if (secs >= 30) {
      streakDays++;
    } else if (i === 0) {
      // Today hasn't reached 30s yet; check whether yesterday had an active streak.
      continue;
    } else {
      break;
    }
  }

  return {
    todaySeconds,
    todayMinutes: Math.max(todaySeconds > 0 ? 1 : 0, Math.round(todaySeconds / 60)),
    weekMinutes: Math.round(weekSeconds / 60),
    totalMinutes: Math.max(store.totalSeconds > 0 ? 1 : 0, Math.round(store.totalSeconds / 60)),
    streakDays,
  };
}

export async function countAllHighlights(repo: Repo): Promise<number> {
  await ensureReaderSchema(repo.platform);
  const [row] = await repo.platform.sql.query("SELECT COUNT(*) AS cnt FROM reader_highlights");
  return Number(row?.cnt ?? 0);
}

/**
 * Aggregates every imported / saved novel in `source_books` with progress,
 * current chapter title, annotation counts, and shelf preferences in one fast query
 * without loading book body JSON or chunks into JS memory.
 */
export async function listLibraryShelfItems(repo: Repo): Promise<LibraryShelfItem[]> {
  await latestReadingStatsFlush;
  await ensureReaderSchema(repo.platform);
  const [rows, prefs, stats] = await Promise.all([
    repo.platform.sql.query(
      `SELECT b.id, b.title, b.format, b.created_at AS createdAt,
         (SELECT COUNT(*) FROM source_sections s WHERE s.book_id = b.id) AS sectionCount,
         p.section_index AS progSection,
         p.page_index AS progPage,
         p.scroll_ratio AS progRatio,
         p.anchor_text AS progAnchor,
         p.node_id AS progNodeId,
         p.updated_at AS progUpdatedAt,
         COALESCE(
           (SELECT s2.title FROM source_sections s2 WHERE s2.book_id = b.id AND s2.section = COALESCE(p.section_index, 0)),
           (SELECT s3.title FROM source_sections s3 WHERE s3.book_id = b.id ORDER BY s3.section ASC LIMIT 1),
           ''
         ) AS currentSectionTitle,
         (SELECT COUNT(*) FROM reader_highlights h WHERE h.target_type = 'book' AND h.target_id = b.id) AS highlightCount,
         (SELECT COUNT(*) FROM reader_bookmarks bm WHERE bm.target_type = 'book' AND bm.target_id = b.id) AS bookmarkCount
       FROM source_books b
       LEFT JOIN reader_progress p ON p.target_type = 'book' AND p.target_id = b.id`,
    ),
    getAllBookShelfPrefs(repo),
    loadStatsStore(repo),
  ]);

  const charMetrics = await getBooksCharMetrics(
    repo,
    rows.map((r) => ({ id: String(r.id), sectionCount: Number(r.sectionCount ?? 0) })),
  );

  const items: LibraryShelfItem[] = rows.map((r) => {
    const id = String(r.id);
    const sectionCount = Math.max(1, Number(r.sectionCount ?? 1));
    const hasProg = r.progUpdatedAt != null;
    const progress: ReaderProgress | null = hasProg
      ? {
          targetType: "book",
          targetId: id,
          sectionIndex: Number(r.progSection ?? 0),
          pageIndex: Number(r.progPage ?? 0),
          scrollRatio: Number(r.progRatio ?? 0),
          anchorText: String(r.progAnchor ?? ""),
          nodeId: r.progNodeId == null ? null : String(r.progNodeId),
          updatedAt: String(r.progUpdatedAt),
        }
      : null;

    const pref = prefs[id] ?? {};
    let progressPct = 0;
    if (pref.finished) {
      progressPct = 100;
    } else if (progress) {
      const intra =
        progress.scrollRatio > 0
          ? Math.min(0.98, progress.scrollRatio)
          : progress.pageIndex > 0
            ? Math.min(0.9, progress.pageIndex * 0.12)
            : 0.04;
      const rawPct = ((Math.min(sectionCount - 1, progress.sectionIndex) + intra) / sectionCount) * 100;
      progressPct = Math.min(100, Math.max(1, Math.round(rawPct)));
    }

    const createdAt = String(r.createdAt);
    return {
      id,
      title: String(r.title),
      format: String(r.format || "txt"),
      createdAt,
      sectionCount: Number(r.sectionCount ?? 0),
      totalChars: charMetrics.get(id)?.totalChars ?? 0,
      progress,
      currentSectionTitle: String(r.currentSectionTitle ?? ""),
      progressPct,
      highlightCount: Number(r.highlightCount ?? 0),
      bookmarkCount: Number(r.bookmarkCount ?? 0),
      readingSeconds: stats.byTarget[`book:${id}`] ?? 0,
      pinned: !!pref.pinned,
      coverTone: pref.coverTone ?? null,
      finished: !!pref.finished,
      author: pref.author ?? "",
      ...(pref.origin ? { origin: pref.origin } : {}),
      ...(pref.sourceWorldId ? { sourceWorldId: pref.sourceWorldId } : {}),
      ...(pref.sourceLineId ? { sourceLineId: pref.sourceLineId } : {}),
      lastActiveAt: progress?.updatedAt ?? createdAt,
    };
  });

  // Default order: pinned first, then most recently read/imported
  items.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.lastActiveAt.localeCompare(a.lastActiveAt);
  });
  return items;
}

function disambiguateShelfTitle(
  baseTitle: string,
  suffixLabel: string,
  usedTitles: ReadonlySet<string>,
): string {
  if (!usedTitles.has(baseTitle)) return baseTitle;
  const firstCandidate = `${baseTitle}（${suffixLabel}）`;
  if (!usedTitles.has(firstCandidate)) return firstCandidate;
  let n = 2;
  while (usedTitles.has(`${baseTitle}（${suffixLabel} ${n}）`)) {
    n += 1;
  }
  return `${baseTitle}（${suffixLabel} ${n}）`;
}

/**
 * Compiles an interactive world's active/specified route into a clean novel in `书斋` (`source_books`).
 * Copy-on-write guarantees:
 * - Reuses an existing `world-novel` book ONLY when `sourceWorldId` matches, `sourceLineId` matches
 *   (or was legacy unset), AND `hasBookExternalReferences` is false; re-anchors existing reader
 *   bookmarks, highlights, and progress on in-place update without mis-binding deleted snippets.
 * - Allocates a brand-new `newId()` whenever the prior book is cited by any story/note/job or
 *   when compiling a different route (`lineId`), cloning & re-anchoring annotations, moving `pinned`,
 *   and disambiguating colliding titles cleanly.
 */
export async function saveWorldNovelToLibrary(
  repo: Repo,
  worldId: string,
  opts?: { lineId?: string; author?: string },
): Promise<{ bookId: string; forked: boolean; title: string; sectionCount: number }> {
  const built = await buildNovelBook(repo, worldId, {
    lineId: opts?.lineId,
    includePreface: true,
    includeChronicle: true,
    includeActions: false,
  });
  if (!built || !built.sections.length) {
    throw new Error("这部故事还没有可成书的正文段落");
  }
  const targetLineId = built.lineId;
  const [prefs, existingBookRows] = await Promise.all([
    getAllBookShelfPrefs(repo),
    repo.platform.sql
      .query("SELECT id, title, created_at FROM source_books ORDER BY created_at DESC, rowid DESC")
      .catch(() => []),
  ]);

  let reusedBookId: string | null = null;
  let priorSameRouteBookId: string | null = null;

  for (const row of existingBookRows) {
    const candidateId = String(row.id);
    const pref = prefs[candidateId];
    if (!pref || pref.origin !== "world-novel" || pref.sourceWorldId !== worldId) continue;
    const sameRoute = !pref.sourceLineId || pref.sourceLineId === targetLineId;
    if (!sameRoute) continue;
    if (!(await hasBookExternalReferences(repo, candidateId))) {
      reusedBookId = candidateId;
      break;
    }
    if (!priorSameRouteBookId) {
      priorSameRouteBookId = candidateId;
    }
  }

  const bookId = reusedBookId ?? newId();
  const existingPref = reusedBookId ? prefs[reusedBookId] : undefined;
  const priorPref = !reusedBookId && priorSameRouteBookId ? prefs[priorSameRouteBookId] : undefined;
  const nowIso = new Date().toISOString();

  const otherBookTitles = new Set<string>();
  for (const row of existingBookRows) {
    if (String(row.id) !== bookId) {
      otherBookTitles.add(String(row.title ?? ""));
    }
  }

  const cleanLineName = built.lineName?.trim() ?? "";
  const baseTitle =
    cleanLineName && cleanLineName !== "主线" && !built.title.includes(cleanLineName)
      ? `${built.title} · ${cleanLineName}`
      : built.title;
  const resolvedTitle = disambiguateShelfTitle(baseTitle, "新编", otherBookTitles);

  const sourceBook: SourceBook = {
    id: bookId,
    title: resolvedTitle,
    format: "txt",
    createdAt: nowIso,
    sections: built.sections.map((sec, idx) => {
      const body = sec.paragraphs
        .map((p) => (p.kind === "divider" ? (p.text === "◇" ? "◇" : `◇ ${p.text} ◇`) : p.text))
        .join("\n\n");
      const withStatus =
        idx === built.sections.length - 1 && built.statusLine && !body.includes(built.statusLine)
          ? body
            ? `${body}\n\n${built.statusLine}`
            : built.statusLine
          : body;
      return {
        title: sec.subtitle ? `${sec.title} · ${sec.subtitle}` : sec.title,
        text: withStatus,
      };
    }),
  };

  if (reusedBookId) {
    await ensureReaderSchema(repo.platform);
    const [oldSecCountRow] = await repo.platform.sql
      .query("SELECT COUNT(*) AS cnt FROM source_sections WHERE book_id = ?", [bookId])
      .catch(() => []);
    const oldSectionCount = Math.max(1, Number(oldSecCountRow?.cnt ?? 1));
    const { maxSection, getParas, locateSnippet } = createSectionSnippetLocator(
      sourceBook.sections,
      oldSectionCount,
    );

    const reanchorStmts: SqlStatement[] = [];

    const bmRows = await repo.platform.sql
      .query(
        "SELECT id, section_index, snippet FROM reader_bookmarks WHERE target_type = 'book' AND target_id = ?",
        [bookId],
      )
      .catch(() => []);
    for (const r of bmRows) {
      const oldSec = Number(r.section_index ?? 0);
      const hit = locateSnippet(String(r.snippet ?? ""), oldSec);
      if (hit) {
        reanchorStmts.push({
          sql: "UPDATE reader_bookmarks SET section_index = ?, section_title = ?, paragraph_index = ? WHERE id = ?",
          params: [hit.sectionIndex, hit.sectionTitle, hit.paragraphIndex, String(r.id)],
        });
      } else if (oldSec > maxSection) {
        reanchorStmts.push({
          sql: "UPDATE reader_bookmarks SET section_index = ?, section_title = ?, paragraph_index = 0 WHERE id = ?",
          params: [maxSection, sourceBook.sections[maxSection]!.title, String(r.id)],
        });
      }
    }

    const hlRows = await repo.platform.sql
      .query(
        "SELECT id, section_index, selected_text FROM reader_highlights WHERE target_type = 'book' AND target_id = ?",
        [bookId],
      )
      .catch(() => []);
    for (const r of hlRows) {
      const oldSec = Number(r.section_index ?? 0);
      const hit = locateSnippet(String(r.selected_text ?? ""), oldSec);
      if (hit) {
        reanchorStmts.push({
          sql: "UPDATE reader_highlights SET section_index = ?, section_title = ?, paragraph_index = ?, char_start = ?, char_end = ? WHERE id = ?",
          params: [hit.sectionIndex, hit.sectionTitle, hit.paragraphIndex, hit.charStart, hit.charEnd, String(r.id)],
        });
      } else {
        // Old highlighted text was rewritten or deleted: clear char_start/char_end so it never
        // paints an unrelated sentence at the old offset, while retaining the excerpt record itself.
        const clamped = Math.min(maxSection, Math.max(0, oldSec));
        reanchorStmts.push({
          sql: "UPDATE reader_highlights SET section_index = ?, section_title = ?, char_start = 0, char_end = 0 WHERE id = ?",
          params: [clamped, sourceBook.sections[clamped]!.title, String(r.id)],
        });
      }
    }

    const progRows = await repo.platform.sql
      .query(
        "SELECT section_index, anchor_text FROM reader_progress WHERE target_type = 'book' AND target_id = ?",
        [bookId],
      )
      .catch(() => []);
    if (progRows[0]) {
      const oldSec = Number(progRows[0].section_index ?? 0);
      const hit = locateSnippet(String(progRows[0].anchor_text ?? ""), oldSec);
      if (hit) {
        const paras = getParas(hit.sectionIndex);
        const approxRatio = paras.length > 1 ? Number((hit.paragraphIndex / (paras.length - 1)).toFixed(4)) : 0;
        reanchorStmts.push({
          sql: `UPDATE reader_progress
                SET section_index = ?, page_index = 0, scroll_ratio = ?
                WHERE target_type = 'book' AND target_id = ?`,
          params: [hit.sectionIndex, approxRatio, bookId],
        });
      } else if (oldSec > maxSection) {
        reanchorStmts.push({
          sql: `UPDATE reader_progress
                SET section_index = ?, page_index = 0, scroll_ratio = 0
                WHERE target_type = 'book' AND target_id = ?`,
          params: [maxSection, bookId],
        });
      }
    }

    const chunks = chunksOf(sourceBook);
    const index = await indexChunksTermsAsync(chunks);
    await repo.platform.sql.batch([
      { sql: "DELETE FROM source_terms WHERE book_id = ?", params: [bookId] },
      { sql: "DELETE FROM source_chunks WHERE book_id = ?", params: [bookId] },
      { sql: "DELETE FROM source_sections WHERE book_id = ?", params: [bookId] },
      {
        sql: "UPDATE source_books SET title = ?, format = ?, created_at = ?, json = ? WHERE id = ?",
        params: [sourceBook.title, sourceBook.format, nowIso, slimBookJson(sourceBook), bookId],
      },
      ...sectionStatements(bookId, sourceBook.sections),
      ...chunkStatements(bookId, chunks),
      ...termStatements(bookId, index),
      ...reanchorStmts,
    ]);
  } else {
    await saveBook(repo, sourceBook);

    if (priorSameRouteBookId) {
      await ensureReaderSchema(repo.platform);
      const [oldSecCountRow] = await repo.platform.sql
        .query("SELECT COUNT(*) AS cnt FROM source_sections WHERE book_id = ?", [priorSameRouteBookId])
        .catch(() => []);
      const oldSectionCount = Math.max(1, Number(oldSecCountRow?.cnt ?? 1));
      const { maxSection, getParas, locateSnippet } = createSectionSnippetLocator(
        sourceBook.sections,
        oldSectionCount,
      );

      const cloneStmts: SqlStatement[] = [];

      const bmRows = await repo.platform.sql
        .query(
          "SELECT section_index, section_title, snippet, paragraph_index, node_id, created_at FROM reader_bookmarks WHERE target_type = 'book' AND target_id = ?",
          [priorSameRouteBookId],
        )
        .catch(() => []);
      for (const r of bmRows) {
        const oldSec = Number(r.section_index ?? 0);
        const snippet = String(r.snippet ?? "");
        const hit = locateSnippet(snippet, oldSec);
        const clamped = Math.min(maxSection, Math.max(0, oldSec));
        const nextSec = hit ? hit.sectionIndex : clamped;
        const nextTitle = hit
          ? hit.sectionTitle
          : oldSec > maxSection
            ? sourceBook.sections[maxSection]!.title
            : (sourceBook.sections[clamped]?.title ?? String(r.section_title ?? ""));
        const nextPara = hit
          ? hit.paragraphIndex
          : oldSec > maxSection
            ? 0
            : Number(r.paragraph_index ?? 0);
        cloneStmts.push({
          sql: `INSERT INTO reader_bookmarks (
                  id, target_type, target_id, section_index, section_title, snippet, paragraph_index, node_id, created_at
                ) VALUES (?, 'book', ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            newId(),
            bookId,
            nextSec,
            nextTitle,
            snippet,
            nextPara,
            r.node_id == null ? null : String(r.node_id),
            String(r.created_at ?? nowIso),
          ],
        });
      }

      const hlRows = await repo.platform.sql
        .query(
          "SELECT world_id, section_index, paragraph_index, selected_text, note, color, node_id, created_at, updated_at FROM reader_highlights WHERE target_type = 'book' AND target_id = ?",
          [priorSameRouteBookId],
        )
        .catch(() => []);
      for (const r of hlRows) {
        const oldSec = Number(r.section_index ?? 0);
        const sel = String(r.selected_text ?? "");
        const hit = locateSnippet(sel, oldSec);
        const clamped = Math.min(maxSection, Math.max(0, oldSec));
        const nextSec = hit ? hit.sectionIndex : clamped;
        const nextTitle = hit ? hit.sectionTitle : sourceBook.sections[clamped]!.title;
        const nextPara = hit ? hit.paragraphIndex : Number(r.paragraph_index ?? 0);
        const nextStart = hit ? hit.charStart : 0;
        const nextEnd = hit ? hit.charEnd : 0;
        cloneStmts.push({
          sql: `INSERT INTO reader_highlights (
                  id, target_type, target_id, world_id, section_index, section_title,
                  paragraph_index, char_start, char_end, selected_text, note, color,
                  node_id, created_at, updated_at
                ) VALUES (?, 'book', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            newId(),
            bookId,
            r.world_id == null ? null : String(r.world_id),
            nextSec,
            nextTitle,
            nextPara,
            nextStart,
            nextEnd,
            sel,
            String(r.note ?? ""),
            String(r.color ?? "cinnabar"),
            r.node_id == null ? null : String(r.node_id),
            String(r.created_at ?? nowIso),
            String(r.updated_at ?? nowIso),
          ],
        });
      }

      const progRows = await repo.platform.sql
        .query(
          "SELECT section_index, page_index, scroll_ratio, anchor_text, node_id FROM reader_progress WHERE target_type = 'book' AND target_id = ?",
          [priorSameRouteBookId],
        )
        .catch(() => []);
      if (progRows[0]) {
        const pRow = progRows[0];
        const oldSec = Number(pRow.section_index ?? 0);
        const anchor = String(pRow.anchor_text ?? "");
        const hit = locateSnippet(anchor, oldSec);
        const paras = hit ? getParas(hit.sectionIndex) : [];
        const nextSec = hit ? hit.sectionIndex : Math.min(maxSection, Math.max(0, oldSec));
        const nextPage = hit || oldSec > maxSection ? 0 : Number(pRow.page_index ?? 0);
        const nextRatio = hit
          ? paras.length > 1
            ? Number((hit.paragraphIndex / (paras.length - 1)).toFixed(4))
            : 0
          : oldSec > maxSection
            ? 0
            : Number(pRow.scroll_ratio ?? 0);
        cloneStmts.push({
          sql: `INSERT INTO reader_progress (
                  target_type, target_id, section_index, page_index, scroll_ratio, anchor_text, node_id, updated_at
                ) VALUES ('book', ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(target_type, target_id) DO UPDATE SET
                  section_index = excluded.section_index,
                  page_index = excluded.page_index,
                  scroll_ratio = excluded.scroll_ratio,
                  anchor_text = excluded.anchor_text,
                  node_id = excluded.node_id,
                  updated_at = excluded.updated_at`,
          params: [
            bookId,
            nextSec,
            nextPage,
            nextRatio,
            anchor,
            pRow.node_id == null ? null : String(pRow.node_id),
            nowIso,
          ],
        });
      }

      if (cloneStmts.length > 0) {
        await repo.platform.sql.batch(cloneStmts);
      }
    }
  }

  if (!reusedBookId && priorSameRouteBookId && priorPref?.pinned) {
    await updateBookShelfPref(repo, priorSameRouteBookId, { pinned: false });
  }

  const routeSuffix = cleanLineName && cleanLineName !== "主线" ? ` · ${cleanLineName}` : "";
  const defaultAuthor = built.author ? `${built.author}${routeSuffix} · 穿越成书` : `穿越成书${routeSuffix}`;
  const inheritedAuthor = existingPref?.author || priorPref?.author || defaultAuthor;
  await updateBookShelfPref(repo, bookId, {
    author: opts?.author ?? inheritedAuthor,
    ...(priorPref
      ? {
          coverTone: priorPref.coverTone ?? null,
          pinned: !!priorPref.pinned,
        }
      : {}),
    origin: "world-novel",
    sourceWorldId: worldId,
    sourceLineId: targetLineId,
  });
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent("lishi:library-changed", { detail: { bookId } }));
  }
  return {
    bookId,
    forked: !reusedBookId && !!priorSameRouteBookId,
    title: sourceBook.title,
    sectionCount: sourceBook.sections.length,
  };
}
