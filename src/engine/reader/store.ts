// Reader progress, bookmarks, and highlight/note persistence (R35-T004).
// Mirrors crates/story-core/src/reader_schema.sql with zero initial rows,
// zero BLOB columns, and soft foreign keys.
import type { Json, Platform, Row, SqlStatement } from "../../platform";
import { newId, type Repo } from "../db/repo";

export type ReaderTargetType = "book" | "world_novel";
export type HighlightColor = "cinnabar" | "amber" | "bamboo";

export interface ReaderProgress {
  targetType: ReaderTargetType;
  targetId: string;
  sectionIndex: number;
  pageIndex: number;
  scrollRatio: number;
  anchorText: string;
  nodeId: string | null;
  updatedAt: string;
}

export interface ReaderBookmark {
  id: string;
  targetType: ReaderTargetType;
  targetId: string;
  sectionIndex: number;
  sectionTitle: string;
  snippet: string;
  paragraphIndex: number;
  nodeId: string | null;
  createdAt: string;
}

export interface ReaderHighlight {
  id: string;
  targetType: ReaderTargetType;
  targetId: string;
  worldId: string | null;
  sectionIndex: number;
  sectionTitle: string;
  paragraphIndex: number;
  charStart: number;
  charEnd: number;
  selectedText: string;
  note: string;
  color: HighlightColor;
  nodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

const READER_SCHEMA_STATEMENTS: SqlStatement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS reader_progress (
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      section_index INTEGER NOT NULL DEFAULT 0,
      page_index INTEGER NOT NULL DEFAULT 0,
      scroll_ratio REAL NOT NULL DEFAULT 0,
      anchor_text TEXT NOT NULL DEFAULT '',
      node_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (target_type, target_id)
    )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS reader_bookmarks (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      section_index INTEGER NOT NULL,
      section_title TEXT NOT NULL,
      snippet TEXT NOT NULL,
      paragraph_index INTEGER NOT NULL DEFAULT 0,
      node_id TEXT,
      created_at TEXT NOT NULL
    )`,
  },
  {
    sql: `CREATE INDEX IF NOT EXISTS reader_bookmarks_target_created
      ON reader_bookmarks(target_type, target_id, created_at DESC)`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS reader_highlights (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      world_id TEXT,
      section_index INTEGER NOT NULL,
      section_title TEXT NOT NULL,
      paragraph_index INTEGER NOT NULL DEFAULT 0,
      char_start INTEGER NOT NULL DEFAULT 0,
      char_end INTEGER NOT NULL DEFAULT 0,
      selected_text TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'cinnabar',
      node_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
  {
    sql: `CREATE INDEX IF NOT EXISTS reader_highlights_target_section
      ON reader_highlights(target_type, target_id, section_index)`,
  },
  {
    sql: `CREATE INDEX IF NOT EXISTS reader_highlights_created
      ON reader_highlights(created_at DESC)`,
  },
];

const ensuredPlatforms = new WeakMap<Platform, Promise<void>>();

/** Ensures reader tables and indexes exist once per Platform instance without inserting rows. */
export function ensureReaderSchema(platform: Platform): Promise<void> {
  let pending = ensuredPlatforms.get(platform);
  if (!pending) {
    pending = platform.sql.batch(READER_SCHEMA_STATEMENTS).catch((err) => {
      ensuredPlatforms.delete(platform);
      throw err;
    });
    ensuredPlatforms.set(platform, pending);
  }
  return pending;
}

const nowIso = () => new Date().toISOString();

function asTargetType(raw: Json): ReaderTargetType {
  return raw === "world_novel" ? "world_novel" : "book";
}

function asHighlightColor(raw: Json): HighlightColor {
  if (raw === "amber" || raw === "bamboo" || raw === "cinnabar") return raw;
  return "cinnabar";
}

function clampNonNegInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toProgress(r: Row): ReaderProgress {
  return {
    targetType: asTargetType(r.target_type),
    targetId: String(r.target_id),
    sectionIndex: Number(r.section_index ?? 0),
    pageIndex: Number(r.page_index ?? 0),
    scrollRatio: Number(r.scroll_ratio ?? 0),
    anchorText: String(r.anchor_text ?? ""),
    nodeId: r.node_id == null ? null : String(r.node_id),
    updatedAt: String(r.updated_at),
  };
}

function toBookmark(r: Row): ReaderBookmark {
  return {
    id: String(r.id),
    targetType: asTargetType(r.target_type),
    targetId: String(r.target_id),
    sectionIndex: Number(r.section_index ?? 0),
    sectionTitle: String(r.section_title ?? ""),
    snippet: String(r.snippet ?? ""),
    paragraphIndex: Number(r.paragraph_index ?? 0),
    nodeId: r.node_id == null ? null : String(r.node_id),
    createdAt: String(r.created_at),
  };
}

function toHighlight(r: Row): ReaderHighlight {
  return {
    id: String(r.id),
    targetType: asTargetType(r.target_type),
    targetId: String(r.target_id),
    worldId: r.world_id == null ? null : String(r.world_id),
    sectionIndex: Number(r.section_index ?? 0),
    sectionTitle: String(r.section_title ?? ""),
    paragraphIndex: Number(r.paragraph_index ?? 0),
    charStart: Number(r.char_start ?? 0),
    charEnd: Number(r.char_end ?? 0),
    selectedText: String(r.selected_text ?? ""),
    note: String(r.note ?? ""),
    color: asHighlightColor(r.color),
    nodeId: r.node_id == null ? null : String(r.node_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function getReaderProgress(
  repo: Repo,
  targetType: ReaderTargetType,
  targetId: string,
): Promise<ReaderProgress | null> {
  await ensureReaderSchema(repo.platform);
  const rows = await repo.platform.sql.query(
    `SELECT target_type, target_id, section_index, page_index, scroll_ratio, anchor_text, node_id, updated_at
     FROM reader_progress
     WHERE target_type = ? AND target_id = ?`,
    [targetType, targetId],
  );
  return rows[0] ? toProgress(rows[0]) : null;
}

export async function saveReaderProgress(
  repo: Repo,
  input: Omit<ReaderProgress, "updatedAt"> & { updatedAt?: string },
): Promise<ReaderProgress> {
  await ensureReaderSchema(repo.platform);
  const saved: ReaderProgress = {
    targetType: input.targetType,
    targetId: input.targetId,
    sectionIndex: clampNonNegInt(input.sectionIndex),
    pageIndex: clampNonNegInt(input.pageIndex),
    scrollRatio: clampRatio(input.scrollRatio),
    anchorText: input.anchorText ?? "",
    nodeId: input.nodeId ?? null,
    updatedAt: input.updatedAt ?? nowIso(),
  };
  await repo.platform.sql.batch([
    {
      sql: `INSERT INTO reader_progress (
              target_type, target_id, section_index, page_index, scroll_ratio, anchor_text, node_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(target_type, target_id) DO UPDATE SET
              section_index = excluded.section_index,
              page_index = excluded.page_index,
              scroll_ratio = excluded.scroll_ratio,
              anchor_text = excluded.anchor_text,
              node_id = excluded.node_id,
              updated_at = excluded.updated_at`,
      params: [
        saved.targetType,
        saved.targetId,
        saved.sectionIndex,
        saved.pageIndex,
        saved.scrollRatio,
        saved.anchorText,
        saved.nodeId,
        saved.updatedAt,
      ],
    },
  ]);
  return saved;
}

/** Canonical per-route progress key for `world_novel` so switching branches never overwrites main-line progress. */
export function worldNovelProgressTargetId(worldId: string, lineId?: string | null): string {
  const cleanLine = lineId?.trim() ?? "";
  return cleanLine ? `${worldId}:${cleanLine}` : worldId;
}

/**
 * Reads route-isolated `world_novel` progress for `(worldId, lineId)`, falling back to legacy
 * unscoped `worldId` records ONLY when compatible with the current route's `nodeId` / sections.
 */
export async function getWorldNovelProgress(
  repo: Repo,
  worldId: string,
  lineId?: string | null,
  opts?: {
    routeNodeIds?: ReadonlySet<string>;
    sections?: { paragraphs: { text: string; nodeId?: string | null }[] }[];
  },
): Promise<ReaderProgress | null> {
  if (!worldId) return null;
  const cleanLine = lineId?.trim() ?? "";
  if (cleanLine) {
    const scoped = await getReaderProgress(repo, "world_novel", `${worldId}:${cleanLine}`);
    if (scoped) {
      if (opts?.routeNodeIds && scoped.nodeId && !opts.routeNodeIds.has(scoped.nodeId)) {
        return null;
      }
      return scoped;
    }
  }

  const legacy = await getReaderProgress(repo, "world_novel", worldId);
  if (!legacy) return null;

  if (legacy.nodeId) {
    if (opts?.routeNodeIds && !opts.routeNodeIds.has(legacy.nodeId)) {
      return null;
    }
    return legacy;
  }

  if (opts?.sections) {
    if (legacy.sectionIndex < 0 || legacy.sectionIndex >= opts.sections.length) {
      return null;
    }
    const cleanAnchor = legacy.anchorText.trim();
    if (
      cleanAnchor &&
      !opts.sections[legacy.sectionIndex]!.paragraphs.some((p) => p.text.includes(cleanAnchor))
    ) {
      return null;
    }
  }
  return legacy;
}

export async function saveWorldNovelProgress(
  repo: Repo,
  worldId: string,
  lineId: string | null | undefined,
  input: Omit<ReaderProgress, "targetType" | "targetId" | "updatedAt"> & { updatedAt?: string },
): Promise<ReaderProgress> {
  return saveReaderProgress(repo, {
    ...input,
    targetType: "world_novel",
    targetId: worldNovelProgressTargetId(worldId, lineId),
  });
}

/**
 * Resolves the active or non-deleted branch `lineId` containing `h.nodeId` for a `world_novel`
 * highlight so `ExcerptsSheet` ("去原文") opens the exact branch instead of mis-jumping on another route.
 */
export async function resolveHighlightRouteTarget(
  repo: Repo,
  h: Pick<ReaderHighlight, "targetType" | "targetId" | "worldId" | "nodeId">,
): Promise<{ lineId?: string; nodeExists: boolean }> {
  if (h.targetType !== "world_novel") return { nodeExists: true };
  const wId = h.worldId || h.targetId;
  if (!wId || !h.nodeId) return { nodeExists: true };

  const rows = await repo.platform.sql
    .query(
      `WITH RECURSIVE down(id) AS (
         SELECT id FROM nodes WHERE id = ? AND world_id = ?
         UNION ALL
         SELECT n.id FROM nodes n JOIN down d ON n.parent_id = d.id
       )
       SELECT l.id
       FROM lines l
       LEFT JOIN worlds w ON w.id = l.world_id
       WHERE l.world_id = ?
         AND l.deleted_at IS NULL
         AND l.node_id IN (SELECT id FROM down)
       ORDER BY
         CASE WHEN l.id = w.current_line_id THEN 0 ELSE 1 END ASC,
         l.archived ASC,
         CASE WHEN l.kind = 'line' THEN 0 ELSE 1 END ASC,
         l.created_at DESC
       LIMIT 1`,
      [h.nodeId, wId, wId],
    )
    .catch(() => []);

  if (rows[0]?.id) {
    return { lineId: String(rows[0].id), nodeExists: true };
  }
  return { lineId: undefined, nodeExists: false };
}

export async function listReaderBookmarks(
  repo: Repo,
  targetType: ReaderTargetType,
  targetId: string,
): Promise<ReaderBookmark[]> {
  await ensureReaderSchema(repo.platform);
  const rows = await repo.platform.sql.query(
    `SELECT id, target_type, target_id, section_index, section_title, snippet, paragraph_index, node_id, created_at
     FROM reader_bookmarks
     WHERE target_type = ? AND target_id = ?
     ORDER BY created_at DESC, rowid DESC`,
    [targetType, targetId],
  );
  return rows.map(toBookmark);
}

export async function addReaderBookmark(
  repo: Repo,
  input: Omit<ReaderBookmark, "id" | "createdAt">,
): Promise<ReaderBookmark> {
  await ensureReaderSchema(repo.platform);
  const bookmark: ReaderBookmark = {
    id: newId(),
    targetType: input.targetType,
    targetId: input.targetId,
    sectionIndex: clampNonNegInt(input.sectionIndex),
    sectionTitle: input.sectionTitle,
    snippet: input.snippet,
    paragraphIndex: clampNonNegInt(input.paragraphIndex),
    nodeId: input.nodeId ?? null,
    createdAt: nowIso(),
  };
  await repo.platform.sql.batch([
    {
      sql: `INSERT INTO reader_bookmarks (
              id, target_type, target_id, section_index, section_title, snippet, paragraph_index, node_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        bookmark.id,
        bookmark.targetType,
        bookmark.targetId,
        bookmark.sectionIndex,
        bookmark.sectionTitle,
        bookmark.snippet,
        bookmark.paragraphIndex,
        bookmark.nodeId,
        bookmark.createdAt,
      ],
    },
  ]);
  return bookmark;
}

export async function removeReaderBookmark(repo: Repo, id: string): Promise<void> {
  await ensureReaderSchema(repo.platform);
  await repo.platform.sql.batch([{ sql: "DELETE FROM reader_bookmarks WHERE id = ?", params: [id] }]);
}

export async function listReaderHighlights(
  repo: Repo,
  filter?: { targetType?: ReaderTargetType; targetId?: string; worldId?: string },
): Promise<ReaderHighlight[]> {
  await ensureReaderSchema(repo.platform);
  const clauses: string[] = [];
  const params: Json[] = [];
  if (filter?.targetType !== undefined) {
    clauses.push("target_type = ?");
    params.push(filter.targetType);
  }
  if (filter?.targetId !== undefined) {
    clauses.push("target_id = ?");
    params.push(filter.targetId);
  }
  if (filter?.worldId !== undefined) {
    clauses.push("world_id = ?");
    params.push(filter.worldId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const orderBy = filter?.targetId !== undefined
    ? "ORDER BY section_index ASC, paragraph_index ASC, char_start ASC, created_at ASC"
    : "ORDER BY created_at DESC, rowid DESC";
  const rows = await repo.platform.sql.query(
    `SELECT id, target_type, target_id, world_id, section_index, section_title,
            paragraph_index, char_start, char_end, selected_text, note, color,
            node_id, created_at, updated_at
     FROM reader_highlights
     ${where}
     ${orderBy}`,
    params,
  );
  return rows.map(toHighlight);
}

export async function addReaderHighlight(
  repo: Repo,
  input: Omit<ReaderHighlight, "id" | "createdAt" | "updatedAt">,
): Promise<ReaderHighlight> {
  await ensureReaderSchema(repo.platform);
  const t = nowIso();
  const start = clampNonNegInt(input.charStart);
  const end = Math.max(start, clampNonNegInt(input.charEnd));
  const highlight: ReaderHighlight = {
    id: newId(),
    targetType: input.targetType,
    targetId: input.targetId,
    worldId: input.worldId ?? null,
    sectionIndex: clampNonNegInt(input.sectionIndex),
    sectionTitle: input.sectionTitle,
    paragraphIndex: clampNonNegInt(input.paragraphIndex),
    charStart: start,
    charEnd: end,
    selectedText: input.selectedText,
    note: input.note ?? "",
    color: asHighlightColor(input.color),
    nodeId: input.nodeId ?? null,
    createdAt: t,
    updatedAt: t,
  };
  await repo.platform.sql.batch([
    {
      sql: `INSERT INTO reader_highlights (
              id, target_type, target_id, world_id, section_index, section_title,
              paragraph_index, char_start, char_end, selected_text, note, color,
              node_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        highlight.id,
        highlight.targetType,
        highlight.targetId,
        highlight.worldId,
        highlight.sectionIndex,
        highlight.sectionTitle,
        highlight.paragraphIndex,
        highlight.charStart,
        highlight.charEnd,
        highlight.selectedText,
        highlight.note,
        highlight.color,
        highlight.nodeId,
        highlight.createdAt,
        highlight.updatedAt,
      ],
    },
  ]);
  return highlight;
}

export async function updateReaderHighlight(
  repo: Repo,
  id: string,
  patch: { color?: HighlightColor; note?: string },
): Promise<void> {
  await ensureReaderSchema(repo.platform);
  const sets: string[] = [];
  const params: Json[] = [];
  if (patch.color !== undefined) {
    sets.push("color = ?");
    params.push(asHighlightColor(patch.color));
  }
  if (patch.note !== undefined) {
    sets.push("note = ?");
    params.push(patch.note);
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  params.push(nowIso(), id);
  await repo.platform.sql.batch([
    { sql: `UPDATE reader_highlights SET ${sets.join(", ")} WHERE id = ?`, params },
  ]);
}

export async function removeReaderHighlight(repo: Repo, id: string): Promise<void> {
  await ensureReaderSchema(repo.platform);
  await repo.platform.sql.batch([{ sql: "DELETE FROM reader_highlights WHERE id = ?", params: [id] }]);
}

function formatHighlightDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso.trim());
  if (m) return m[1];
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "未知日期";
  return new Date(parsed).toISOString().slice(0, 10);
}

function wrapBookTitle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "《未命名书卷》";
  return trimmed.startsWith("《") && trimmed.endsWith("》") ? trimmed : `《${trimmed}》`;
}

/** Formats highlights into clean Markdown grouped by book/world and chapter with blockquote, note, and date. */
export function exportHighlightsMarkdown(
  highlights: ReaderHighlight[],
  titlesByTarget?: Record<string, string>,
): string {
  if (!highlights.length) return "";

  const groups = new Map<string, { title: string; items: ReaderHighlight[] }>();
  for (const h of highlights) {
    const key = `${h.targetType}:${h.targetId}`;
    let group = groups.get(key);
    if (!group) {
      const resolved =
        titlesByTarget?.[key] ??
        titlesByTarget?.[h.targetId] ??
        (h.targetType === "world_novel" ? "本局故事" : "书架藏书");
      group = { title: wrapBookTitle(resolved), items: [] };
      groups.set(key, group);
    }
    group.items.push(h);
  }

  const lines: string[] = ["# 书摘与批注"];

  for (const group of groups.values()) {
    lines.push("", `## ${group.title}`);
    const sorted = [...group.items].sort(
      (a, b) =>
        a.sectionIndex - b.sectionIndex ||
        a.paragraphIndex - b.paragraphIndex ||
        a.charStart - b.charStart ||
        a.createdAt.localeCompare(b.createdAt),
    );
    const bySection = new Map<number, { title: string; items: ReaderHighlight[] }>();
    for (const item of sorted) {
      let sec = bySection.get(item.sectionIndex);
      if (!sec) {
        sec = { title: item.sectionTitle.trim() || `第 ${item.sectionIndex + 1} 节`, items: [] };
        bySection.set(item.sectionIndex, sec);
      }
      sec.items.push(item);
    }
    for (const sec of bySection.values()) {
      lines.push("", `### ${sec.title}`);
      for (const item of sec.items) {
        const quoted = item.selectedText
          .trim()
          .split(/\r?\n/)
          .map((line) => `> ${line.trim()}`)
          .join("\n");
        lines.push("", quoted);
        if (item.note.trim()) {
          lines.push("", `批注：${item.note.trim()}`);
        }
        lines.push("", `—— 摘于 ${formatHighlightDate(item.createdAt)}`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}
