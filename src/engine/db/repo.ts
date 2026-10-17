// Data access for worlds, nodes, lines, pins, chapters and settings. All writes that must
// land together go through one sql.batch call.
import type { Json, Platform, Row, SqlStatement } from "../../platform";
import {
  DEFAULT_SETTINGS, type Chapter, type Line, type Pin, type StoryNode, type World, type WorldSettings, type WorldState,
} from "../types";

const now = () => new Date().toISOString();
export const newId = () => crypto.randomUUID().replace(/-/g, "");

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

/** The node and everything under it, for statements that remove a branch. */
const SUBTREE = `WITH RECURSIVE down(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN down ON n.parent_id = down.id) SELECT id FROM down`;

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

export class Repo {
  constructor(readonly platform: Platform) {}

  private q(sql: string, params: Json[] = []) {
    return this.platform.sql.query(sql, params);
  }

  // ---------- worlds ----------
  async listWorlds(): Promise<World[]> {
    return (await this.q("SELECT * FROM worlds WHERE archived = 0 ORDER BY played_at DESC")).map(toWorld);
  }

  async getWorld(id: string): Promise<World | null> {
    const rows = await this.q("SELECT * FROM worlds WHERE id = ?", [id]);
    return rows[0] ? toWorld(rows[0]) : null;
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

  async updateSettings(worldId: string, settings: WorldSettings): Promise<void> {
    await this.q("UPDATE worlds SET settings_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(settings), now(), worldId]);
  }

  async deleteWorld(worldId: string): Promise<void> {
    // Pins point at their node without a cascade, so they go first; states and chapters cascade.
    await this.platform.sql.batch([
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
      { sql: "INSERT INTO states (node_id, state_json) VALUES (?, ?)", params: [nodeId, JSON.stringify(node.state)] },
    ];
    if (node.parentId) {
      statements.push({ sql: "UPDATE nodes SET last_child_id = ? WHERE id = ?", params: [nodeId, node.parentId] });
    }
    return { statements, nodeId };
  }

  /**
   * Appends a node under its parent and moves the given line to it, in one
   * transaction. `extra` statements (usage rows, pins…) join the same commit.
   */
  async appendNode(worldId: string, lineId: string, node: NewNode, extra: SqlStatement[] = []): Promise<StoryNode> {
    const t = now();
    const seqRows = await this.q("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM nodes WHERE world_id = ?", [worldId]);
    const { statements, nodeId } = this.nodeStatements(worldId, seqRows[0].seq as number, node, t);
    await this.platform.sql.batch([
      ...statements,
      { sql: "UPDATE lines SET node_id = ? WHERE id = ?", params: [nodeId, lineId] },
      { sql: "UPDATE worlds SET updated_at = ?, played_at = ? WHERE id = ?", params: [t, t, worldId] },
      ...extra,
    ]);
    return (await this.getNode(nodeId))!;
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
    return rows.map((r) => ({ id: r.id as string, worldId: r.world_id as string, originNodeId: r.origin_node_id as string, text: r.text as string, createdAt: r.created_at as string }));
  }

  async addChapter(c: Omit<Chapter, "id" | "createdAt" | "edited">): Promise<Chapter> {
    const chapter: Chapter = { ...c, id: newId(), edited: false, createdAt: now() };
    await this.q(
      `INSERT INTO chapters (id, world_id, first_node_id, last_node_id, title, gist, summary, model, prompt_version, edited, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [chapter.id, c.worldId, c.firstNodeId, c.lastNodeId, c.title, c.gist, c.summary, c.model, c.promptVersion, chapter.createdAt],
    );
    return chapter;
  }

  /** A rewrite by the model (edited stays as it was) or by the player (edited = true). */
  async updateChapter(id: string, fields: Pick<Chapter, "title" | "gist" | "summary"> & Partial<Pick<Chapter, "model" | "promptVersion" | "edited">>): Promise<void> {
    const sets = ["title = ?", "gist = ?", "summary = ?"];
    const params: Json[] = [fields.title, fields.gist, fields.summary];
    if (fields.model !== undefined) { sets.push("model = ?"); params.push(fields.model); }
    if (fields.promptVersion !== undefined) { sets.push("prompt_version = ?"); params.push(fields.promptVersion); }
    if (fields.edited !== undefined) { sets.push("edited = ?"); params.push(fields.edited ? 1 : 0); }
    await this.q(`UPDATE chapters SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
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
    return rows.map((r) => ({
      id: r.id as string, worldId: r.world_id as string, firstNodeId: r.first_node_id as string, lastNodeId: r.last_node_id as string,
      title: r.title as string, gist: r.gist as string, summary: r.summary as string, model: (r.model as string) ?? null,
      promptVersion: (r.prompt_version as string) ?? null, edited: !!r.edited, createdAt: r.created_at as string,
    }));
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

  /** Adds fields to a node's meta, keeping what others wrote meanwhile. */
  async mergeMeta(nodeId: string, patch: Record<string, unknown>): Promise<void> {
    const node = await this.getNode(nodeId);
    if (node) await this.q("UPDATE nodes SET meta_json = ? WHERE id = ?", [JSON.stringify({ ...node.meta, ...patch }), nodeId]);
  }

  async updateNarrative(nodeId: string, narrative: string): Promise<void> {
    await this.q("UPDATE nodes SET narrative = ?, rewritten = 1 WHERE id = ?", [narrative, nodeId]);
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

  async createLine(worldId: string, nodeId: string, name: string, autoNamed: boolean, kind: Line["kind"] = "line"): Promise<Line> {
    const id = newId();
    await this.q(
      "INSERT INTO lines (id, world_id, name, node_id, kind, auto_named, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, worldId, name, nodeId, kind, autoNamed ? 1 : 0, now()],
    );
    return (await this.getLine(id))!;
  }

  async setCurrentLine(worldId: string, lineId: string): Promise<void> {
    await this.q("UPDATE worlds SET current_line_id = ?, played_at = ? WHERE id = ?", [lineId, now(), worldId]);
  }

  async renameLine(lineId: string, name: string): Promise<void> {
    await this.q("UPDATE lines SET name = ?, auto_named = 0 WHERE id = ?", [name.trim(), lineId]);
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
    const statements: SqlStatement[] = [{ sql: "DELETE FROM lines WHERE id = ?", params: [lineId] }];
    let removed = 0;
    if (first) {
      removed = Number((await this.q(`SELECT COUNT(*) AS n FROM (${SUBTREE})`, [first.id]))[0].n);
      statements.push(
        { sql: `DELETE FROM pins WHERE origin_node_id IN (${SUBTREE})`, params: [first.id] },
        { sql: `DELETE FROM chapters WHERE last_node_id IN (${SUBTREE}) OR first_node_id IN (${SUBTREE})`, params: [first.id, first.id] },
        // Lines still in the trash that pointed into the branch go with it.
        { sql: `DELETE FROM lines WHERE node_id IN (${SUBTREE})`, params: [first.id] },
        { sql: `UPDATE nodes SET last_child_id = NULL WHERE last_child_id IN (${SUBTREE})`, params: [first.id] },
        { sql: `DELETE FROM nodes WHERE id IN (${SUBTREE})`, params: [first.id] },
      );
    }
    await this.platform.sql.batch(statements);
    return removed;
  }

  /** Purges lines that have been in the trash longer than `days`. */
  async purgeTrash(worldId: string, days = 30): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const old = await this.q("SELECT id FROM lines WHERE world_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?", [worldId, cutoff]);
    let removed = 0;
    for (const r of old) removed += await this.purgeLine(r.id as string);
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
