// Bookshelf preferences, reading duration statistics, fast shelf aggregation,
// and one-tap "save interactive world story into 书斋 library" helper (R36-T003).
// Uses existing `settings` key-value storage + `reader_*` / `source_*` tables
// so zero new SQLite schema tables are introduced and `empty_database()` stays untouched.
import { newId, type Repo } from "../db/repo";
import { buildNovelBook } from "../novel";
import {
  bookExists,
  chunkStatements,
  chunksOf,
  getBooksCharMetrics,
  indexChunksTermsAsync,
  saveBook,
  sectionStatements,
  slimBookJson,
  termStatements,
} from "../sources/library";
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

/** Compiles an interactive world's current route into a clean novel and stores it in `书斋` (`source_books`). */
export async function saveWorldNovelToLibrary(
  repo: Repo,
  worldId: string,
  opts?: { lineId?: string; author?: string },
): Promise<{ bookId: string; title: string; sectionCount: number }> {
  const built = await buildNovelBook(repo, worldId, {
    lineId: opts?.lineId,
    includePreface: true,
    includeChronicle: true,
    includeActions: false,
  });
  if (!built || !built.sections.length) {
    throw new Error("这部故事还没有可成书的正文段落");
  }
  const prefs = await getAllBookShelfPrefs(repo);
  let reusedBookId: string | null = null;
  for (const [candidateId, pref] of Object.entries(prefs)) {
    if (pref.origin === "world-novel" && pref.sourceWorldId === worldId) {
      if (await bookExists(repo, candidateId)) {
        reusedBookId = candidateId;
        break;
      }
    }
  }
  const bookId = reusedBookId ?? newId();
  const existingPref = reusedBookId ? prefs[reusedBookId] : undefined;
  const nowIso = new Date().toISOString();
  const sourceBook: SourceBook = {
    id: bookId,
    title: built.title,
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
    ]);
  } else {
    await saveBook(repo, sourceBook);
  }
  const defaultAuthor = built.author ? `${built.author} · 穿越成书` : "穿越成书";
  await updateBookShelfPref(repo, bookId, {
    author: opts?.author ?? (existingPref?.author ? existingPref.author : defaultAuthor),
    origin: "world-novel",
    sourceWorldId: worldId,
  });
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent("lishi:library-changed", { detail: { bookId } }));
  }
  return { bookId, title: sourceBook.title, sectionCount: sourceBook.sections.length };
}
