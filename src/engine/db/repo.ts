// Data access for worlds, nodes, lines, pins, chapters and settings. All writes that must
// land together go through one sql.batch call.
import type { Json, Platform, Row, SqlStatement } from "../../platform";
import {
  DEFAULT_SETTINGS, type Chapter, type Line, type Pin, type StoryNode, type World, type WorldSettings, type WorldState,
} from "../types";

const now = () => new Date().toISOString();
import { newId } from "./ids";
export { newId } from "./ids";

function parse<T>(text: Json, fallback: T): T {
  if (typeof text !== "string" || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toWorld(r: Row): World {
  return {
    id: r.id as string,
    title: r.title as string,
    eraId: r.era_id as string,
    currentLineId: (r.current_line_id as string) ?? null,
    settings: { ...DEFAULT_SETTINGS, ...parse<Partial<WorldSettings>>(r.settings_json, {}) },
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    playedAt: r.played_at as string,
    archived: !!r.archived,
  };
}

const NODE_COLUMNS = `id, world_id, parent_id, last_child_id, seq, kind, action_mode, action_text, director_note,
  narrative, record_json, choices_json, status, rewritten, fate, meta_json, created_at`;

function toNode(r: Row): StoryNode {
  return {
    id: r.id as string,
    worldId: r.world_id as string,
    parentId: (r.parent_id as string) ?? null,
    lastChildId: (r.last_child_id as string) ?? null,
    seq: r.seq as number,
    kind: r.kind as StoryNode["kind"],
    actionMode: (r.action_mode as StoryNode["actionMode"]) ?? null,
    actionText: (r.action_text as string) ?? null,
    directorNote: (r.director_note as string) ?? null,
    narrative: r.narrative as string,
    record: parse(r.record_json, null),
    choices: parse<string[]>(r.choices_json, []),
    status: r.status as StoryNode["status"],
    rewritten: !!r.rewritten,
    fate: (r.fate as string) ?? null,
    meta: parse(r.meta_json, {}),
    createdAt: r.created_at as string,
  };
}

function toLine(r: Row): Line {
  return {
    id: r.id as string,
    worldId: r.world_id as string,
    name: r.name as string,
    nodeId: r.node_id as string,
    kind: r.kind as Line["kind"],
    autoNamed: !!r.auto_named,
    archived: !!r.archived,
    createdAt: r.created_at as string,
    deletedAt: (r.deleted_at as string) ?? null,
  };
}

function toPin(r: Row): Pin {
  return { id: r.id as string, worldId: r.world_id as string, originNodeId: r.origin_node_id as string, text: r.text as string, createdAt: r.created_at as string };
}

/**
 * Chapters whose span holds `nodeId` are marked out of date after its text changed
 * (D183), on every route that shares the passage. One the player wrote is only flagged, never rewritten.
 */
export function staleChaptersStatement(worldId: string, nodeId: string, ifNarrative?: string): SqlStatement {
  return {
    sql: `WITH RECURSIVE down(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN down d ON n.parent_id=d.id),
      up(id) AS (SELECT ? UNION ALL SELECT n.parent_id FROM nodes n JOIN up u ON n.id=u.id WHERE n.parent_id IS NOT NULL)
      UPDATE chapters SET stale=1 WHERE world_id=? AND last_node_id IN (SELECT id FROM down) AND first_node_id IN (SELECT id FROM up)
        ${ifNarrative === undefined ? "" : "AND EXISTS (SELECT 1 FROM nodes WHERE id=? AND narrative=?)"}`,
    params: ifNarrative === undefined ? [nodeId, nodeId, worldId] : [nodeId, nodeId, worldId, nodeId, ifNarrative],
  };
}

function toChapter(r: Row): Chapter {
  return {
    id: r.id as string, worldId: r.world_id as string, firstNodeId: r.first_node_id as string, lastNodeId: r.last_node_id as string,
    title: r.title as string, gist: r.gist as string, summary: r.summary as string, model: (r.model as string) ?? null,
    promptVersion: (r.prompt_version as string) ?? null, edited: !!r.edited, ...(r.stale ? { stale: true } : {}), createdAt: r.created_at as string,
  };
}

// Only fixed schema column names are passed here.
function rowJson(table: string, columns: string): string {
  return `json_object(${columns.split(",").map(column => {
    const key = column.trim();
    return `'${key}',${table}.${key}`;
  }).join(",")})`;
}

/** The node and everything under it, for statements that remove a branch. */
const SUBTREE = `WITH RECURSIVE down(id) AS (SELECT ? UNION SELECT n.id FROM nodes n JOIN down ON n.parent_id = down.id) SELECT id FROM down`;
export class ReferencedRoute extends Error {}

export interface NewNode {
  id?: string;
  parentId: string | null;
  kind: StoryNode["kind"];
  actionMode?: StoryNode["actionMode"];
  actionText?: string | null;
  directorNote?: string | null;
  narrative: string;
  record?: unknown;
  choices?: string[];
  status?: StoryNode["status"];
  fate?: string | null;
  meta?: Record<string, unknown>;
  state: WorldState;
}

export interface RevisionGuard {
  worldId: string; lineId: string; headId: string; nodeId: string; original: string;
  /** Exact JSON of the source binding on the preview's head; absent/null is "null". */
  sourceGuard: string;
  /** Direct time corrections also guard the exact original record and active native lease. */
  recordGuard?: string;
  requireIdle?: boolean;
  settingsGuard?: string;
  targetStateGuard?: string;
  parentStateGuard?: string;
  targetMetaGuard?: string;
  parentMetaGuard?: string;
}

export class Repo {
  constructor(readonly platform: Platform) {}

  private q(sql: string, params: Json[] = []) {
    return this.platform.sql.query(sql, params);
  }

  // ---------- worlds ----------
  async listWorlds(): Promise<World[]> {
    return (await this.q("SELECT * FROM worlds WHERE archived = 0 ORDER BY played_at DESC")).map(toWorld);
  }

  /**
   * Single-query world shelf summary: extracts only protagonist name, time and era inside SQLite
   * plus route turn count and latest narrative, avoiding 3N IPC round-trips and full `state_json` parses.
   */
  async listWorldCardInputs(): Promise<{
    world: World;
    protagonistName: string;
    time: WorldState["time"];
    era: WorldState["era"];
    turns: number;
    last: string;
  }[]> {
    const rows = await this.q(
      `WITH heads AS (
         SELECT w.*, l.node_id AS head_node_id,
                json_extract(s.state_json, '$.protagonist.name') AS protagonist_name,
                json_extract(s.state_json, '$.time') AS time_json,
                json_extract(s.state_json, '$.era') AS era_json
         FROM worlds w
         JOIN lines l ON l.id = w.current_line_id AND l.world_id = w.id
         JOIN states s ON s.node_id = l.node_id
         WHERE w.archived = 0
       ),
       up(world_id, id, depth) AS (
         SELECT id, head_node_id, 0 FROM heads
         UNION ALL
         SELECT up.world_id, n.parent_id, up.depth + 1
         FROM nodes n JOIN up ON n.id = up.id
         WHERE n.parent_id IS NOT NULL
       ),
       stats AS (
         SELECT up.world_id,
                SUM(CASE WHEN n.kind IN ('turn', 'fastforward') THEN 1 ELSE 0 END) AS turns
         FROM up JOIN nodes n ON n.id = up.id
         GROUP BY up.world_id
       ),
       latest_prose AS (
         SELECT world_id, narrative FROM (
           SELECT up.world_id, n.narrative,
                  ROW_NUMBER() OVER (PARTITION BY up.world_id ORDER BY up.depth ASC) AS rn
           FROM up JOIN nodes n ON n.id = up.id
           WHERE n.kind <> 'edit'
         ) WHERE rn = 1
       )
       SELECT h.*, COALESCE(st.turns, 0) AS turns, COALESCE(lp.narrative, '') AS last_narrative
       FROM heads h
       LEFT JOIN stats st ON st.world_id = h.id
       LEFT JOIN latest_prose lp ON lp.world_id = h.id
       ORDER BY h.played_at DESC`,
    );
    return rows.map((r) => ({
      world: toWorld(r),
      protagonistName: typeof r.protagonist_name === "string" ? r.protagonist_name : "",
      time: parse<WorldState["time"]>(r.time_json ?? null, { start: "", elapsedMinutes: 0 }),
      era: parse<WorldState["era"]>(r.era_json ?? null, { packId: null }),
      turns: Number(r.turns ?? 0),
      last: typeof r.last_narrative === "string" ? r.last_narrative : "",
    }));
  }

  /** Single-query world + active line + bound source lookup for CompanionScreen without parsing full `state_json`. */
  async listWorldSourceBriefs(): Promise<{ world: World; lineId: string | null; source: NonNullable<WorldState["source"]> | null }[]> {
    const rows = await this.q(
      `SELECT w.*, l.id AS active_line_id,
              CASE WHEN s.node_id IS NOT NULL THEN json_extract(s.state_json, '$.source') ELSE NULL END AS source_json
       FROM worlds w
       LEFT JOIN lines l ON l.id = w.current_line_id AND l.world_id = w.id
       LEFT JOIN states s ON s.node_id = l.node_id
       WHERE w.archived = 0
       ORDER BY w.played_at DESC`,
    );
    return rows.map((r) => ({
      world: toWorld(r),
      lineId: typeof r.active_line_id === "string" ? r.active_line_id : (typeof r.current_line_id === "string" ? r.current_line_id : null),
      source: parse<NonNullable<WorldState["source"]> | null>(r.source_json ?? null, null) ?? null,
    }));
  }

  async getWorld(id: string): Promise<World | null> {
    const rows = await this.q("SELECT * FROM worlds WHERE id = ?", [id]);
    return rows[0] ? toWorld(rows[0]) : null;
  }

  /** Captures the inputs and guards for a new model run at the same read boundary. */
  async generationStart(worldId: string) {
    const [row] = await this.q(`SELECT ${NODE_COLUMNS.split(",").map(column => `n.${column.trim()}`).join(",")},
        l.id AS line_id,w.era_id,w.settings_json,s.state_json
      FROM worlds w JOIN lines l ON l.id=w.current_line_id AND l.world_id=w.id
      JOIN nodes n ON n.id=l.node_id AND n.world_id=w.id JOIN states s ON s.node_id=n.id
      WHERE w.id=? AND w.archived=0 AND l.deleted_at IS NULL`, [worldId]);
    if (!row) throw new Error("没有找到这本故事的当前路线。");
    const rawSettings = JSON.parse(String(row.settings_json)) as Partial<WorldSettings>;
    const state = JSON.parse(String(row.state_json)) as WorldState;
    return {
      lineId: String(row.line_id), eraId: String(row.era_id), head: toNode(row), state,
      settings: { ...DEFAULT_SETTINGS, ...rawSettings },
      guard: { settingsGuard: rawSettings, generationSnapshot: true, sourceGuard: state.source ?? null },
    };
  }

  /** Creates a world with its opening node and main line in one transaction. */
  async createWorld(input: { title: string; eraId: string; settings?: Partial<WorldSettings>; opening: NewNode }): Promise<{ world: World; node: StoryNode; line: Line }> {
    const worldId = newId();
    const lineId = newId();
    const t = now();
    const settings = { ...DEFAULT_SETTINGS, ...input.settings };
    const { statements, nodeId } = this.nodeStatements(worldId, 1, input.opening, t);
    await this.platform.sql.batch([
      {
        sql: `INSERT INTO worlds (id, title, era_id, current_line_id, settings_json, created_at, updated_at, played_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [worldId, input.title, input.eraId, lineId, JSON.stringify(settings), t, t, t],
      },
      ...statements,
      {
        sql: "INSERT INTO lines (id, world_id, name, node_id, kind, created_at) VALUES (?, ?, ?, ?, 'line', ?)",
        params: [lineId, worldId, "主线", nodeId, t],
      },
    ]);
    return {
      world: (await this.getWorld(worldId))!,
      node: (await this.getNode(nodeId))!,
      line: (await this.getLine(lineId))!,
    };
  }

  /** A world's name (AUDIT_V4_FUNCTION C1). */
  async renameWorld(worldId: string, title: string): Promise<void> {
    await this.q("UPDATE worlds SET title = ?, updated_at = ? WHERE id = ?", [title, now(), worldId]);
  }

  /**
   * Deleting a world puts it in the recycle bin (C2): `archived` 2 means deleted,
   * with the time in updated_at; it comes back with restoreWorld, and goes for
   * good after 30 days (purgeDeletedWorlds) or when emptied.
   */
  async trashWorld(worldId: string): Promise<void> {
    await this.q("UPDATE worlds SET archived = 2, updated_at = ? WHERE id = ?", [now(), worldId]);
  }

  async restoreWorld(worldId: string): Promise<void> {
    await this.q("UPDATE worlds SET archived = 0, played_at = ? WHERE id = ?", [now(), worldId]);
  }

  async deletedWorlds(): Promise<World[]> {
    return (await this.q("SELECT * FROM worlds WHERE archived = 2 ORDER BY updated_at DESC")).map(toWorld);
  }

  /** Worlds in the bin for more than `days` days are deleted for good. */
  async purgeDeletedWorlds(days = 30): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const old = await this.q("SELECT id FROM worlds WHERE archived = 2 AND updated_at <= ?", [cutoff]);
    for (const row of old) await this.deleteWorld(row.id as string);
    return old.length;
  }

  async updateSettings(worldId: string, settings: WorldSettings): Promise<void> {
    const entries = Object.entries(settings).filter(([k, v]) => v !== undefined && /^[A-Za-z0-9_]+$/.test(k));
    if (!entries.length) {
      await this.q("UPDATE worlds SET updated_at = ? WHERE id = ?", [now(), worldId]);
      return;
    }
    const args = entries.flatMap(([k]) => [`'$.${k}'`, "json(?)"]);
    const values = entries.map(([, v]) => JSON.stringify(v));
    await this.q(
      `UPDATE worlds SET settings_json = json_set(COALESCE(settings_json, '{}'), ${args.join(", ")}), updated_at = ? WHERE id = ?`,
      [...values, now(), worldId],
    );
  }

  async deleteWorld(worldId: string): Promise<void> {
    if (this.platform.execution?.agent) {
      for (const s of await this.q("SELECT id FROM pi_sessions WHERE world_id = ?", [worldId]).catch(() => [])) {
        await this.platform.execution.agent({ op: "delete", id: String(s.id) }).catch(() => null);
      }
    }
    const readerTables = new Set(
      (
        await this.q(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('reader_progress', 'reader_bookmarks', 'reader_highlights')",
        ).catch(() => [])
      ).map((r) => String(r.name)),
    );
    const readerCleanups: SqlStatement[] = [];
    for (const table of ["reader_progress", "reader_bookmarks", "reader_highlights"] as const) {
      if (!readerTables.has(table)) continue;
      const cols = await this.q(`PRAGMA table_info(${table})`).catch(() => []);
      const hasWorldId = cols.some((c) => String(c.name) === "world_id");
      if (hasWorldId) {
        readerCleanups.push({
          sql: `DELETE FROM ${table} WHERE (target_type = 'world_novel' AND target_id = ?) OR world_id = ?`,
          params: [worldId, worldId],
        });
      } else {
        readerCleanups.push({
          sql: `DELETE FROM ${table} WHERE target_type = 'world_novel' AND target_id = ?`,
          params: [worldId],
        });
      }
    }
    // Pins point at their node without a cascade, so they go first; states and chapters cascade.
    await this.platform.sql.batch([
      ...readerCleanups,
      { sql: "DELETE FROM settings WHERE key IN (?, ?)", params: [`autoplayUnusedNote:${worldId}`, `carriedDone:${worldId}`] },
      { sql: "DELETE FROM pi_external_effects WHERE world_id = ?", params: [worldId] },
      {
        sql: "DELETE FROM world_execution_leases WHERE world_id = ? OR (world_id LIKE ? || '#read:%' AND instr(world_id, ? || '#read:') = 1)",
        params: [worldId, worldId, worldId],
      },
      { sql: "DELETE FROM execution_runs WHERE world_id = ?", params: [worldId] },
      { sql: "DELETE FROM pins WHERE world_id = ?", params: [worldId] },
      { sql: "DELETE FROM lines WHERE world_id = ?", params: [worldId] },
      { sql: "DELETE FROM nodes WHERE world_id = ?", params: [worldId] },
      { sql: "DELETE FROM worlds WHERE id = ?", params: [worldId] },
    ]);
  }

  // ---------- nodes ----------
  private nodeStatements(worldId: string, seq: number, node: NewNode, t: string): { statements: SqlStatement[]; nodeId: string } {
    const nodeId = node.id ?? newId();
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO nodes (${NODE_COLUMNS})
              VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        params: [
          nodeId, worldId, node.parentId, seq, node.kind, node.actionMode ?? null, node.actionText ?? null,
          node.directorNote ?? null, node.narrative, node.record === undefined ? null : JSON.stringify(node.record),
          JSON.stringify(node.choices ?? []), node.status ?? "ok", node.fate ?? null, JSON.stringify(node.meta ?? {}), t,
        ],
      },
      this.nodeStateStatement(nodeId, node.state),
    ];
    if (node.parentId) {
      statements.push({ sql: "UPDATE nodes SET last_child_id = ? WHERE id = ?", params: [nodeId, node.parentId] });
    }
    return { statements, nodeId };
  }

  private nodeStateStatement(nodeId: string, state: WorldState, guarded = false): SqlStatement {
    const sourceBook = state.source?.bookId ?? null;
    return {
      sql: `INSERT INTO states(node_id,state_json)
        SELECT ?,CASE WHEN ? IS NULL OR EXISTS(SELECT 1 FROM source_books WHERE id=?) THEN ? END
        ${guarded ? "WHERE EXISTS(SELECT 1 FROM nodes WHERE id=?)" : ""}`,
      params: [nodeId, sourceBook, sourceBook, JSON.stringify(state), ...(guarded ? [nodeId] : [])],
    };
  }

  /**
   * Appends a node under its parent and moves the given line to it, in one
   * transaction. `extra` statements (usage rows, pins…) join the same commit.
   */
  async appendNode(worldId: string, lineId: string, node: NewNode, extra: SqlStatement[] = [], guard?: { headId: string; settingsJson?: string; requireIdle?: boolean; preserveNodeId?: string }): Promise<StoryNode> {
    const t = now();
    const seqRows = await this.q("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM nodes WHERE world_id = ?", [worldId]);
    const { statements, nodeId } = this.nodeStatements(worldId, seqRows[0].seq as number, node, t);
    if (guard) {
      if (extra.length) throw new Error("受保护的手动追加不接受未校验的附加写入");
      const condition = `EXISTS(SELECT 1 FROM worlds w JOIN lines l ON l.id=w.current_line_id
        WHERE w.id=? AND w.archived=0 AND l.id=? AND l.world_id=w.id AND l.node_id=? AND l.deleted_at IS NULL AND l.archived=0
          AND (? IS NULL OR w.settings_json=?))
        AND (?=0 OR NOT EXISTS(SELECT 1 FROM world_execution_leases busy WHERE busy.world_id=? AND busy.expires_at_ms>?))`;
      const exists = "EXISTS(SELECT 1 FROM nodes WHERE id=?)";
      const preservedName = guard.preserveNodeId ? await this.uniqueLineName(worldId, "未命名路线") : null;
      await this.platform.sql.batch([
        { sql: statements[0].sql.replace(/VALUES\s*\(([\s\S]*)\)\s*$/, `SELECT $1 WHERE ${condition}`), params: [...statements[0].params!, worldId, lineId, guard.headId, guard.settingsJson ?? null, guard.settingsJson ?? null, guard.requireIdle ? 1 : 0, worldId, Date.now()] },
        this.nodeStateStatement(nodeId, node.state, true),
        ...(node.parentId ? [{ sql: "UPDATE nodes SET last_child_id=? WHERE id=? AND " + exists, params: [nodeId, node.parentId, nodeId] }] : []),
        { sql: "UPDATE lines SET node_id=? WHERE id=? AND " + exists, params: [nodeId, lineId, nodeId] },
        { sql: "UPDATE worlds SET updated_at=?,played_at=? WHERE id=? AND " + exists, params: [t, t, worldId, nodeId] },
        ...(guard.preserveNodeId ? [{ sql: "INSERT INTO lines(id,world_id,name,node_id,kind,auto_named,created_at) SELECT ?,?,?,?,'line',1,? WHERE " + exists, params: [newId(), worldId, preservedName!, guard.preserveNodeId, t, nodeId] }] : []),
      ]);
      const saved = await this.getNode(nodeId);
      if (!saved) throw new Error("故事已变化或仍有任务执行，请等任务结束后重新打开再试。");
      return saved;
    }
    await this.platform.sql.batch([
      ...statements,
      { sql: "UPDATE lines SET node_id = ? WHERE id = ?", params: [nodeId, lineId] },
      { sql: "UPDATE worlds SET updated_at = ?, played_at = ? WHERE id = ?", params: [t, t, worldId] },
      ...extra,
    ]);
    return (await this.getNode(nodeId))!;
  }

  /**
   * Adopt a preview atomically, either on a new route or as the latest passage's
   * sibling. `carried` are edit nodes chained after it in the same write (the
   * player's own edits made after the passage, D183); the route ends on the last.
   */
  async forkRevision(guard: RevisionGuard, node: NewNode, name: string, asVersion = false, carried: NewNode[] = []): Promise<{ node: StoryNode; line: Line }> {
    const t = now(), lineId = asVersion ? guard.lineId : newId();
    const unique = asVersion ? undefined : await this.uniqueLineName(guard.worldId, name);
    const [next] = await this.q("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM nodes WHERE world_id=?", [guard.worldId]);
    const { statements, nodeId } = this.nodeStatements(guard.worldId, Number(next.seq), node, t);
    const condition = `EXISTS (
      SELECT 1 FROM worlds w JOIN lines l ON l.id=w.current_line_id
      JOIN states s ON s.node_id=l.node_id JOIN nodes target ON target.id=?
      WHERE w.id=? AND w.archived=0 AND w.current_line_id=? AND l.world_id=w.id
        AND l.node_id=? AND l.deleted_at IS NULL AND l.archived=0
        AND target.world_id=w.id AND target.narrative=? AND target.parent_id IS ?
        AND COALESCE(json_extract(s.state_json,'$.source'),'null')=?
        AND (? IS NULL OR COALESCE(target.record_json,'null')=?)
        AND (? IS NULL OR w.settings_json=?)
        AND (? IS NULL OR (SELECT state_json FROM states WHERE node_id=target.id)=?)
        AND (? IS NULL OR (SELECT state_json FROM states WHERE node_id=target.parent_id)=?)
        AND (? IS NULL OR target.meta_json=?)
        AND (? IS NULL OR (SELECT meta_json FROM nodes WHERE id=target.parent_id)=?)
        AND (?=0 OR NOT EXISTS (SELECT 1 FROM world_execution_leases busy WHERE busy.world_id=w.id AND busy.expires_at_ms>?))
        AND target.id IN (WITH RECURSIVE path(id) AS (
          SELECT l.node_id UNION ALL SELECT n.parent_id FROM nodes n JOIN path p ON n.id=p.id WHERE n.parent_id IS NOT NULL
        ) SELECT id FROM path)
    )`;
    const exists = "EXISTS(SELECT 1 FROM nodes WHERE id=?)";
    // Each carried edit is written only if the revision itself was.
    const chain = carried.flatMap((edit, i) => {
      const { statements: own, nodeId: editId } = this.nodeStatements(guard.worldId, Number(next.seq) + i + 1, edit, t);
      return [
        { sql: own[0].sql.replace(/VALUES\s*\(([\s\S]*)\)\s*$/, `SELECT $1 WHERE ${exists}`), params: [...own[0].params!, nodeId] },
        this.nodeStateStatement(editId, edit.state, true),
        ...(edit.parentId ? [{ sql: "UPDATE nodes SET last_child_id=? WHERE id=? AND " + exists, params: [editId, edit.parentId, editId] }] : []),
      ];
    });
    const end = carried.at(-1)?.id ?? nodeId;
    await this.platform.sql.batch([
      { sql: statements[0].sql.replace(/VALUES\s*\(([\s\S]*)\)\s*$/, `SELECT $1 WHERE ${condition}`), params: [...statements[0].params!, guard.nodeId, guard.worldId, guard.lineId, guard.headId, guard.original, node.parentId, guard.sourceGuard, guard.recordGuard ?? null, guard.recordGuard ?? null,
        guard.settingsGuard ?? null, guard.settingsGuard ?? null, guard.targetStateGuard ?? null, guard.targetStateGuard ?? null,
        guard.parentStateGuard ?? null, guard.parentStateGuard ?? null, guard.targetMetaGuard ?? null, guard.targetMetaGuard ?? null,
        guard.parentMetaGuard ?? null, guard.parentMetaGuard ?? null, guard.requireIdle ? 1 : 0, Date.now()] },
      this.nodeStateStatement(nodeId, node.state, true),
      ...(asVersion ? [
        { sql: "UPDATE nodes SET last_child_id=? WHERE id=? AND " + exists, params: [nodeId, node.parentId, nodeId] },
      ] : []),
      ...chain,
      ...(asVersion ? [
        { sql: "UPDATE lines SET node_id=? WHERE id=? AND " + exists, params: [end, lineId, end] },
      ] : [{ sql: "INSERT INTO lines(id,world_id,name,node_id,kind,auto_named,created_at) SELECT ?,?,?,?,'line',0,? WHERE " + exists, params: [lineId, guard.worldId, unique!, end, t, end] }]),
      { sql: "UPDATE worlds SET current_line_id=?,updated_at=?,played_at=? WHERE id=? AND " + exists, params: [lineId, t, t, guard.worldId, nodeId] },
    ]);
    const created = await this.getNode(end), line = await this.getLine(lineId);
    if (!created || !line) throw new Error("故事、原文或参考用法已经改变，请重新生成改稿。");
    return { node: created, line };
  }

  async getNode(id: string): Promise<StoryNode | null> {
    const rows = await this.q(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = ?`, [id]);
    return rows[0] ? toNode(rows[0]) : null;
  }

  /** The world's opening node. */
  async opening(worldId: string): Promise<StoryNode | null> {
    const rows = await this.q(`SELECT ${NODE_COLUMNS} FROM nodes WHERE world_id = ? AND kind = 'opening' ORDER BY seq LIMIT 1`, [worldId]);
    return rows[0] ? toNode(rows[0]) : null;
  }

  async addPin(worldId: string, originNodeId: string, text: string): Promise<Pin> {
    const pin: Pin = { id: newId(), worldId, originNodeId, text: text.trim(), createdAt: now() };
    await this.q("INSERT INTO pins (id, world_id, origin_node_id, text, created_at) VALUES (?, ?, ?, ?, ?)", [pin.id, worldId, originNodeId, pin.text, pin.createdAt]);
    return pin;
  }

  async deletePin(id: string): Promise<void> {
    await this.q("DELETE FROM pins WHERE id = ?", [id]);
  }

  /** Pins whose origin is on the path from the root to `nodeId`, oldest first. */
  async pinsOnPath(worldId: string, nodeId: string): Promise<Pin[]> {
    const rows = await this.q(
      `WITH RECURSIVE up(id) AS (
         SELECT id FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.parent_id FROM nodes n JOIN up ON n.id = up.id WHERE n.parent_id IS NOT NULL
       )
       SELECT id, world_id, origin_node_id, text, created_at FROM pins
       WHERE world_id = ? AND origin_node_id IN (SELECT id FROM up)
       ORDER BY created_at, id`,
      [nodeId, worldId],
    );
    return rows.map(toPin);
  }

  async addChapter(c: Omit<Chapter, "id" | "createdAt" | "edited">): Promise<Chapter> {
    const { stale, ...rest } = c;
    const chapter: Chapter = { ...rest, id: newId(), edited: false, ...(stale ? { stale: true } : {}), createdAt: now() };
    if (stale) {
      await this.q(
        `INSERT INTO chapters (id, world_id, first_node_id, last_node_id, title, gist, summary, model, prompt_version, edited, stale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
        [chapter.id, c.worldId, c.firstNodeId, c.lastNodeId, c.title, c.gist, c.summary, c.model, c.promptVersion, chapter.createdAt],
      );
    } else {
      await this.q(
        `INSERT INTO chapters (id, world_id, first_node_id, last_node_id, title, gist, summary, model, prompt_version, edited, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [chapter.id, c.worldId, c.firstNodeId, c.lastNodeId, c.title, c.gist, c.summary, c.model, c.promptVersion, chapter.createdAt],
      );
    }
    return chapter;
  }

  /**
   * Inserts a newly summarized chapter only if the world is still active (archived = 0),
   * all summarized source nodes still exist, and no chapter with the same `first_node_id`
   * already covers the route; marks `stale = 1` automatically if any source node's prose
   * changed while the summary was in flight.
   */
  async addChapterGuarded(
    c: Omit<Chapter, "id" | "createdAt" | "edited">,
    guard: { headId: string; sourceNodes: { id: string; narrative: string }[] },
  ): Promise<Chapter | null> {
    if (!guard.sourceNodes.length) return null;
    const id = newId();
    const createdAt = now();
    const sourceNarrativeChecks = guard.sourceNodes
      .map(() => "OR NOT EXISTS (SELECT 1 FROM nodes WHERE id = ? AND narrative = ?)")
      .join(" ");
    const sourceExistChecks = guard.sourceNodes
      .map(() => "AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND world_id = ?)")
      .join(" ");
    await this.q(
      `WITH RECURSIVE route(id) AS (
         SELECT id FROM nodes WHERE id = ? AND world_id = ?
         UNION ALL
         SELECT n.parent_id FROM nodes n JOIN route r ON n.id = r.id WHERE n.parent_id IS NOT NULL
       ),
       span_up(id) AS (
         SELECT id FROM nodes WHERE id = ? AND world_id = ?
         UNION ALL
         SELECT n.parent_id FROM nodes n JOIN span_up s ON n.id = s.id WHERE n.parent_id IS NOT NULL
       ),
       span_down(id) AS (
         SELECT ?
         UNION ALL
         SELECT n.id FROM nodes n JOIN span_down d ON n.parent_id = d.id
       )
       INSERT INTO chapters (id, world_id, first_node_id, last_node_id, title, gist, summary, model, prompt_version, edited, stale, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
         CASE WHEN ? = 1 ${sourceNarrativeChecks} THEN 1 ELSE NULL END,
         ?
       WHERE EXISTS (SELECT 1 FROM worlds WHERE id = ? AND archived = 0)
         ${sourceExistChecks}
         AND NOT EXISTS (
           SELECT 1 FROM chapters existing
           WHERE existing.world_id = ? AND existing.first_node_id = ?
             AND (existing.last_node_id IN (SELECT id FROM route)
                  OR existing.last_node_id IN (SELECT id FROM span_up)
                  OR existing.last_node_id IN (SELECT id FROM span_down))
         )`,
      [
        guard.headId,
        c.worldId,
        c.lastNodeId,
        c.worldId,
        c.lastNodeId,
        id,
        c.worldId,
        c.firstNodeId,
        c.lastNodeId,
        c.title,
        c.gist,
        c.summary,
        c.model,
        c.promptVersion,
        c.stale ? 1 : 0,
        ...guard.sourceNodes.flatMap((s) => [s.id, s.narrative]),
        createdAt,
        c.worldId,
        ...guard.sourceNodes.flatMap((s) => [s.id, c.worldId]),
        c.worldId,
        c.firstNodeId,
      ],
    );
    const rows = await this.q("SELECT * FROM chapters WHERE id = ?", [id]);
    return rows[0] ? toChapter(rows[0]) : null;
  }

  /** A rewrite by the model (edited stays as it was) or by the player (edited = true). */
  async updateChapter(
    id: string,
    fields: Pick<Chapter, "title" | "gist" | "summary"> & Partial<Pick<Chapter, "model" | "promptVersion" | "edited">>,
    expected?: Pick<Chapter, "title" | "gist" | "summary" | "edited"> & { stale?: boolean },
    sourceNodes?: { id: string; narrative: string }[],
  ): Promise<boolean> {
    if (sourceNodes) {
      if (!sourceNodes.length) return false;
      if (new Set(sourceNodes.map((s) => s.id)).size !== sourceNodes.length) return false;
    }
    // Any new summary, by the AI or the player, is of the text as it is now (D183).
    const sets = ["title = ?", "gist = ?", "summary = ?", "stale = NULL"];
    const params: Json[] = [fields.title, fields.gist, fields.summary];
    if (fields.model !== undefined) { sets.push("model = ?"); params.push(fields.model); }
    if (fields.promptVersion !== undefined) { sets.push("prompt_version = ?"); params.push(fields.promptVersion); }
    if (fields.edited !== undefined) { sets.push("edited = ?"); params.push(fields.edited ? 1 : 0); }
    const cte = sourceNodes
      ? `WITH RECURSIVE span(id, first_id, parent_id, kind, status) AS (
           SELECT n.id, c.first_node_id, n.parent_id, n.kind, n.status
           FROM chapters c JOIN nodes n ON n.id = c.last_node_id AND n.world_id = c.world_id
           WHERE c.id = ?
           UNION ALL
           SELECT p.id, span.first_id, p.parent_id, p.kind, p.status
           FROM span JOIN nodes p ON p.id = span.parent_id
           WHERE span.id <> span.first_id
         ) `
      : "";
    const guard = expected ? " AND title=? AND gist=? AND summary=? AND edited=?" : "";
    const sourceGuard = sourceNodes
      ? ` AND EXISTS (SELECT 1 FROM worlds w WHERE w.id = chapters.world_id AND w.archived = 0)
          AND EXISTS (SELECT 1 FROM span WHERE id = first_id)
          AND (SELECT COUNT(*) FROM span WHERE kind = 'turn' AND status <> 'interrupted') = ?
          ${sourceNodes
            .map(
              () =>
                "AND EXISTS (SELECT 1 FROM span JOIN nodes n ON n.id = span.id WHERE span.id = ? AND span.kind = 'turn' AND span.status <> 'interrupted' AND n.narrative = ?)",
            )
            .join(" ")}`
      : "";
    await this.q(`${cte}UPDATE chapters SET ${sets.join(", ")} WHERE id = ?${guard}${sourceGuard}`, [
      ...(sourceNodes ? [id] : []),
      ...params,
      id,
      ...(expected ? [expected.title, expected.gist, expected.summary, expected.edited ? 1 : 0] : []),
      ...(sourceNodes ? [sourceNodes.length, ...sourceNodes.flatMap((s) => [s.id, s.narrative])] : []),
    ]);
    if (!expected && !sourceNodes) return true;
    if (sourceNodes) {
      const [check] = await this.q(
        `${cte}SELECT c.title, c.gist, c.summary, c.edited, c.stale,
           (EXISTS (SELECT 1 FROM worlds w WHERE w.id = c.world_id AND w.archived = 0)
            AND EXISTS (SELECT 1 FROM span WHERE id = first_id)
            AND (SELECT COUNT(*) FROM span WHERE kind = 'turn' AND status <> 'interrupted') = ?
            ${sourceNodes
              .map(
                () =>
                  "AND EXISTS (SELECT 1 FROM span JOIN nodes n ON n.id = span.id WHERE span.id = ? AND span.kind = 'turn' AND span.status <> 'interrupted' AND n.narrative = ?)",
              )
              .join(" ")}
           ) AS span_ok
         FROM chapters c WHERE c.id = ?`,
        [id, sourceNodes.length, ...sourceNodes.flatMap((s) => [s.id, s.narrative]), id],
      );
      if (!check || !check.span_ok || check.stale) return false;
      return (
        check.title === fields.title &&
        check.gist === fields.gist &&
        check.summary === fields.summary &&
        (fields.edited === undefined || !!check.edited === fields.edited)
      );
    }
    const [saved] = await this.q("SELECT title,gist,summary,edited,stale FROM chapters WHERE id=?", [id]);
    return (
      !!saved &&
      !saved.stale &&
      saved.title === fields.title &&
      saved.gist === fields.gist &&
      saved.summary === fields.summary &&
      (fields.edited === undefined || !!saved.edited === fields.edited)
    );
  }

  async deleteChapter(id: string): Promise<void> {
    await this.q("DELETE FROM chapters WHERE id = ?", [id]);
  }

  /** Chapters whose last node is on the path from the root to `nodeId`, oldest first. */
  async chaptersOnPath(worldId: string, nodeId: string): Promise<Chapter[]> {
    const rows = await this.q(
      `WITH RECURSIVE up(id, depth) AS (
         SELECT id, 0 FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.parent_id, up.depth + 1 FROM nodes n JOIN up ON n.id = up.id WHERE n.parent_id IS NOT NULL
       )
       SELECT c.* FROM chapters c JOIN up ON c.last_node_id = up.id
       WHERE c.world_id = ?
       ORDER BY up.depth DESC, c.created_at`,
      [nodeId, worldId],
    );
    return rows.map(toChapter);
  }

  /** One native read of a consistent route's prose, pins and chapter directory. */
  async promptHistory(worldId: string, nodeId: string): Promise<{ path: StoryNode[]; pins: Pin[]; chapters: Chapter[] }> {
    const rows = await this.q(`WITH RECURSIVE route(id) AS (
        SELECT id FROM nodes WHERE id=? AND world_id=?
        UNION SELECT n.parent_id FROM nodes n JOIN route ON route.id=n.id WHERE n.parent_id IS NOT NULL AND n.world_id=?
      )
      SELECT ${NODE_COLUMNS.split(",").map(column => `n.${column.trim()}`).join(",")},
        CASE WHEN n.id=? THEN (
          SELECT json_group_array(json(detail)) FROM (
            SELECT ${rowJson("p", "id,world_id,origin_node_id,text,created_at")} AS detail
            FROM pins p JOIN route ON route.id=p.origin_node_id WHERE p.world_id=? ORDER BY p.created_at,p.id
          )
        ) END AS prompt_pins,
        CASE WHEN n.id=? THEN (
          SELECT json_group_array(json(detail)) FROM (
            SELECT ${rowJson("c", "id,world_id,first_node_id,last_node_id,title,gist,summary,model,prompt_version,edited,stale,created_at")} AS detail
            FROM chapters c JOIN nodes last ON last.id=c.last_node_id
            WHERE c.world_id=? AND c.first_node_id IN route AND c.last_node_id IN route ORDER BY last.seq,c.created_at,c.id
          )
        ) END AS prompt_chapters
      FROM nodes n JOIN route ON route.id=n.id ORDER BY n.seq`, [nodeId, worldId, worldId, nodeId, worldId, nodeId, worldId]);
    const head = rows.at(-1);
    return {
      path: rows.map(toNode),
      pins: parse<Row[]>(head?.prompt_pins ?? null, []).map(toPin),
      chapters: parse<Row[]>(head?.prompt_chapters ?? null, []).map(toChapter),
    };
  }

  async getState(nodeId: string): Promise<WorldState> {
    const rows = await this.q("SELECT state_json FROM states WHERE node_id = ?", [nodeId]);
    if (!rows[0]) throw new Error(`missing state for node ${nodeId}`);
    return JSON.parse(rows[0].state_json as string) as WorldState;
  }

  /** Path from the root to `nodeId`, oldest first; `limit` keeps only the newest nodes. */
  async path(nodeId: string, limit = 100_000): Promise<StoryNode[]> {
    const rows = await this.q(
      `WITH RECURSIVE up(id, depth) AS (
         SELECT id, 0 FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.parent_id, up.depth + 1 FROM nodes n JOIN up ON n.id = up.id WHERE n.parent_id IS NOT NULL
       )
       SELECT ${NODE_COLUMNS.split(",").map((c) => `n.${c.trim()}`).join(", ")}
       FROM up JOIN nodes n ON n.id = up.id
       WHERE up.depth < ?
       ORDER BY up.depth DESC`,
      [nodeId, limit],
    );
    return rows.map(toNode);
  }

  /** Small clock snapshots keep chapter/bookmark dates at their saved calibration. */
  async clocksOnPath(nodeId: string): Promise<Map<string, Pick<WorldState, "time" | "era">>> {
    const rows = await this.q(`WITH RECURSIVE up(id) AS (
      SELECT id FROM nodes WHERE id=? UNION ALL SELECT n.parent_id FROM nodes n JOIN up ON n.id=up.id WHERE n.parent_id IS NOT NULL
    ) SELECT s.node_id AS id,json_extract(s.state_json,'$.time') AS time,json_extract(s.state_json,'$.era') AS era FROM up JOIN states s ON s.node_id=up.id`, [nodeId]);
    return new Map(rows.map(row => [String(row.id), { time: JSON.parse(String(row.time)), era: JSON.parse(String(row.era)) }]));
  }

  /** Game minutes at each node on the path to `nodeId`, read from the states without parsing them (目录 and search). */
  async minutesOnPath(nodeId: string): Promise<Map<string, number>> {
    const rows = await this.q(
      `WITH RECURSIVE up(id) AS (
         SELECT id FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.parent_id FROM nodes n JOIN up ON n.id = up.id WHERE n.parent_id IS NOT NULL
       )
       SELECT s.node_id AS id, json_extract(s.state_json, '$.time.elapsedMinutes') AS minute
       FROM up JOIN states s ON s.node_id = up.id`,
      [nodeId],
    );
    return new Map(rows.filter((r) => r.minute != null).map((r) => [r.id as string, Number(r.minute)]));
  }

  /** Turns on the path to `nodeId` and its latest passage, without loading the path (home and world lines, R08-T003). */
  async homeSummary(nodeId: string): Promise<{ turns: number; last: string }> {
    const rows = await this.q(
      `WITH RECURSIVE up(id, depth) AS (
         SELECT id, 0 FROM nodes WHERE id = ?
         UNION ALL
         SELECT n.parent_id, up.depth + 1 FROM nodes n JOIN up ON n.id = up.id WHERE n.parent_id IS NOT NULL
       )
       SELECT (SELECT COUNT(*) FROM up JOIN nodes n ON n.id = up.id WHERE n.kind IN ('turn', 'fastforward')) AS turns,
              (SELECT n.narrative FROM up JOIN nodes n ON n.id = up.id WHERE n.kind <> 'edit' ORDER BY up.depth LIMIT 1) AS last`,
      [nodeId],
    );
    return { turns: Number(rows[0]?.turns ?? 0), last: (rows[0]?.last as string) ?? "" };
  }

  /** Every node of a world, oldest first, for the turn tree. */
  async allNodes(worldId: string): Promise<StoryNode[]> {
    return (await this.q(`SELECT ${NODE_COLUMNS} FROM nodes WHERE world_id = ? ORDER BY seq`, [worldId])).map(toNode);
  }

  async children(nodeId: string): Promise<StoryNode[]> {
    return (await this.q(`SELECT ${NODE_COLUMNS} FROM nodes WHERE parent_id = ? ORDER BY seq`, [nodeId])).map(toNode);
  }

  /** Replaces a node's content and state in place (used to finish an interrupted turn). */
  async completeNode(nodeId: string, fields: { narrative: string; record: unknown; choices: string[]; status: StoryNode["status"]; meta: Record<string, unknown> }, state: WorldState, extra: SqlStatement[] = []): Promise<StoryNode> {
    await this.platform.sql.batch([
      {
        sql: "UPDATE nodes SET narrative = ?, record_json = ?, choices_json = ?, status = ?, meta_json = ? WHERE id = ?",
        params: [fields.narrative, JSON.stringify(fields.record ?? null), JSON.stringify(fields.choices), fields.status, JSON.stringify(fields.meta), nodeId],
      },
      { sql: "UPDATE states SET state_json = ? WHERE node_id = ?", params: [JSON.stringify(state), nodeId] },
      ...extra,
    ]);
    return (await this.getNode(nodeId))!;
  }

  /** Adds fields to a node's meta atomically inside SQLite, keeping what background upkeep wrote meanwhile (B06). */
  async mergeMeta(nodeId: string, patch: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && /^[A-Za-z0-9_]+$/.test(k));
    if (!entries.length) return;
    const args = entries.flatMap(([k]) => [`'$.${k}'`, "json(?)"]);
    const values = entries.map(([, v]) => JSON.stringify(v));
    await this.q(`UPDATE nodes SET meta_json = json_set(COALESCE(meta_json, '{}'), ${args.join(", ")}) WHERE id = ?`, [...values, nodeId]);
  }

  /** The player rewrote a passage; the first original is kept in meta.original so it can come back (AUDIT_V4_FUNCTION E2). */
  async updateNarrative(nodeId: string, narrative: string): Promise<void> {
    const node = await this.getNode(nodeId);
    if (!node) return;
    await this.platform.sql.batch([
      {
        sql: `UPDATE nodes SET narrative = ?, rewritten = 1,
          meta_json = json_set(COALESCE(meta_json, '{}'), '$.original',
            CASE WHEN json_type(meta_json, '$.original') = 'text' THEN json_extract(meta_json, '$.original') ELSE narrative END)
          WHERE id = ?`,
        params: [narrative, nodeId],
      },
      staleChaptersStatement(node.worldId, nodeId),
    ]);
  }

  /** Puts the AI's original text back after a rewrite without clobbering concurrent meta fields (B06). */
  async restoreNarrative(nodeId: string): Promise<boolean> {
    const node = await this.getNode(nodeId);
    if (!node || typeof node.meta.original !== "string") return false;
    await this.platform.sql.batch([
      {
        sql: `UPDATE nodes SET narrative = json_extract(meta_json, '$.original'), rewritten = 0,
          meta_json = json_remove(COALESCE(meta_json, '{}'), '$.original')
          WHERE id = ? AND json_type(meta_json, '$.original') = 'text'`,
        params: [nodeId],
      },
      staleChaptersStatement(node.worldId, nodeId),
    ]);
    return true;
  }

  async setLastChild(nodeId: string, childId: string): Promise<void> {
    await this.q("UPDATE nodes SET last_child_id = ? WHERE id = ?", [childId, nodeId]);
  }

  // ---------- lines ----------
  async getLine(id: string): Promise<Line | null> {
    const rows = await this.q("SELECT * FROM lines WHERE id = ?", [id]);
    return rows[0] ? toLine(rows[0]) : null;
  }

  async lines(worldId: string): Promise<Line[]> {
    return (await this.q("SELECT * FROM lines WHERE world_id = ? ORDER BY created_at", [worldId])).map(toLine);
  }

  async moveLine(lineId: string, nodeId: string): Promise<void> {
    await this.q("UPDATE lines SET node_id = ? WHERE id = ?", [nodeId, lineId]);
  }

  /**
   * `name`, or `name（2）`, `name（3）`… when another route or bookmark of the
   * world already has it (AUDIT_V4_FUNCTION G1). `except` is the line being renamed.
   */
  async uniqueLineName(worldId: string, name: string, except?: string): Promise<string> {
    const base = name.trim().replace(/（\d+）$/, "") || "未命名";
    const taken = new Set((await this.q("SELECT name FROM lines WHERE world_id = ? AND id <> ?", [worldId, except ?? ""])).map((r) => r.name as string));
    if (!taken.has(name.trim()) && name.trim()) return name.trim();
    for (let n = 2; ; n++) if (!taken.has(`${base}（${n}）`)) return `${base}（${n}）`;
  }

  async createLine(worldId: string, nodeId: string, name: string, autoNamed: boolean, kind: Line["kind"] = "line"): Promise<Line> {
    const id = newId();
    const unique = await this.uniqueLineName(worldId, name);
    await this.q(
      "INSERT INTO lines (id, world_id, name, node_id, kind, auto_named, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, worldId, unique, nodeId, kind, autoNamed ? 1 : 0, now()],
    );
    return (await this.getLine(id))!;
  }

  async setCurrentLine(worldId: string, lineId: string): Promise<void> {
    await this.q("UPDATE worlds SET current_line_id = ?, played_at = ? WHERE id = ?", [lineId, now(), worldId]);
  }

  /** Renames a line; a name another line has gets a number. Returns the name it got. */
  async renameLine(lineId: string, name: string): Promise<string> {
    const line = await this.getLine(lineId);
    const unique = line ? await this.uniqueLineName(line.worldId, name, lineId) : name.trim();
    await this.q("UPDATE lines SET name = ?, auto_named = 0 WHERE id = ?", [unique, lineId]);
    return unique;
  }

  async setLineArchived(lineId: string, archived: boolean): Promise<void> {
    await this.q("UPDATE lines SET archived = ? WHERE id = ?", [archived ? 1 : 0, lineId]);
  }

  /** Into the trash, or back out of it (R06-T001). The current line cannot be deleted. */
  async setLineDeleted(lineId: string, deleted: boolean): Promise<void> {
    const line = await this.getLine(lineId);
    if (deleted && line && (await this.getWorld(line.worldId))?.currentLineId === lineId) throw new Error("the current line cannot be deleted");
    await this.q("UPDATE lines SET deleted_at = ? WHERE id = ?", [deleted ? now() : null, lineId]);
  }

  /**
   * Removes a line for good, with the turns only it reached: the branch below
   * the first node on its path that no other line or bookmark reaches.
   * Returns how many nodes were removed.
   */
  async purgeLine(lineId: string): Promise<number> {
    const line = await this.getLine(lineId);
    if (!line) return 0;
    if ((await this.getWorld(line.worldId))?.currentLineId === lineId) throw new Error("the current line cannot be purged");
    const keep = new Set((await this.q(
      `WITH RECURSIVE keep(id) AS (
         SELECT node_id FROM lines WHERE world_id = ? AND id <> ? AND deleted_at IS NULL
         UNION
         SELECT n.parent_id FROM nodes n JOIN keep ON n.id = keep.id WHERE n.parent_id IS NOT NULL
       ) SELECT id FROM keep`,
      [line.worldId, lineId],
    )).map((r) => r.id as string));
    const first = (await this.path(line.nodeId)).find((n) => !keep.has(n.id));
    const selection = `purge_${newId().replace(/-/g, "")}`;
    const nodes = `SELECT id FROM ${selection} WHERE kind='node'`;
    const lines = `SELECT id FROM ${selection} WHERE kind='line'`;
    const eligible = `EXISTS(SELECT 1 FROM lines l JOIN worlds w ON w.id=l.world_id
      WHERE l.id=? AND l.world_id=? AND l.node_id=? AND l.deleted_at IS NOT NULL AND w.current_line_id<>l.id)`;
    const statements: SqlStatement[] = [{
      sql: `CREATE TEMP TABLE ${selection} AS
        WITH gone(id) AS (${SUBTREE}),
        routes(id) AS (SELECT ? UNION SELECT id FROM lines WHERE node_id IN (SELECT id FROM gone))
        SELECT * FROM (SELECT 'node' AS kind,id FROM gone WHERE id IS NOT NULL UNION ALL SELECT 'line',id FROM routes)
        WHERE ${eligible}
          AND NOT EXISTS(SELECT 1 FROM lines WHERE id IN routes AND id<>? AND deleted_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM worlds WHERE current_line_id IN routes)
          AND NOT EXISTS(SELECT 1 FROM story_fact_sources WHERE line_id IN routes OR node_id IN gone)
          AND NOT EXISTS(SELECT 1 FROM fact_corrections WHERE node_id IN gone OR original_node_id IN gone)
          AND NOT EXISTS(SELECT 1 FROM nodes WHERE json_extract(meta_json,'$.revision.nodeId') IN gone)
          AND NOT EXISTS(SELECT 1 FROM nodes WHERE id NOT IN (SELECT id FROM gone WHERE id IS NOT NULL) AND json_extract(meta_json,'$.revision.lineId') IN routes)
          AND NOT EXISTS(SELECT 1 FROM execution_runs WHERE line_id IN routes AND status IN ('running','committing'))
          AND NOT EXISTS(SELECT 1 FROM pi_sessions WHERE line_id IN routes)
          AND NOT EXISTS(SELECT 1 FROM pi_tasks WHERE line_id IN routes)`,
      params: [first?.id ?? null, lineId, lineId, line.worldId, line.nodeId, lineId],
    }];
    const removed = first ? Number((await this.q(`SELECT COUNT(*) AS n FROM (${SUBTREE})`, [first.id]))[0].n) : 0;
    statements.push({ sql: `DELETE FROM lines WHERE id IN (${lines})` });
    if (first) {
      statements.push(
        { sql: `DELETE FROM pins WHERE origin_node_id IN (${nodes})` },
        { sql: `DELETE FROM chapters WHERE last_node_id IN (${nodes}) OR first_node_id IN (${nodes})` },
        { sql: `UPDATE nodes SET last_child_id = NULL WHERE last_child_id IN (${nodes})` },
        { sql: `DELETE FROM nodes WHERE id IN (${nodes})` },
      );
    }
    statements.push({ sql: `DROP TABLE ${selection}` });
    await this.platform.sql.batch(statements);
    if (await this.getLine(lineId)) throw new ReferencedRoute("这条路线仍有资料引用，或刚发生变化，已保留在回收站。");
    return removed;
  }

  /** Purges lines that have been in the trash longer than `days`. */
  async purgeTrash(worldId: string, days = 30): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const old = await this.q("SELECT id FROM lines WHERE world_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?", [worldId, cutoff]);
    let removed = 0;
    for (const r of old) {
      try { removed += await this.purgeLine(r.id as string); }
      catch (error) { if (!(error instanceof ReferencedRoute)) throw error; }
    }
    return removed;
  }

  /** The trash of every world, at app start (AUDIT_V4_FUNCTION G2): worlds never opened again are cleaned too. */
  async purgeAllTrash(days = 30): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const old = await this.q("SELECT id FROM lines WHERE deleted_at IS NOT NULL AND deleted_at < ?", [cutoff]);
    let removed = 0;
    for (const r of old) {
      try { removed += await this.purgeLine(r.id as string); }
      catch (error) { if (!(error instanceof ReferencedRoute)) throw error; }
    }
    return removed;
  }

  // ---------- usage ----------
  usageStatement(u: {
    worldId: string | null; nodeId: string | null; purpose: string; model: string; promptTokens: number | null;
    completionTokens: number | null; estimated: boolean; firstTokenMs: number | null; totalMs: number | null; outcome: string;
  }): SqlStatement {
    return {
      sql: `INSERT INTO usage (id, world_id, node_id, purpose, model, prompt_tokens, completion_tokens, estimated, first_token_ms, total_ms, outcome, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [newId(), u.worldId, u.nodeId, u.purpose, u.model, u.promptTokens, u.completionTokens, u.estimated ? 1 : 0,
        u.firstTokenMs === null ? null : Math.round(u.firstTokenMs), u.totalMs === null ? null : Math.round(u.totalMs), u.outcome, now()],
    };
  }

  // ---------- settings ----------
  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const rows = await this.q("SELECT value FROM settings WHERE key = ?", [key]);
    return rows[0] ? parse<T>(rows[0].value, fallback) : fallback;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.q("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, JSON.stringify(value)]);
  }
}
