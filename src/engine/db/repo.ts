// Data access for worlds, nodes, lines, pins and settings. All writes that must
// land together go through one sql.batch call.
import type { Json, Platform, Row, SqlStatement } from "../../platform";
import {
  DEFAULT_SETTINGS, type Line, type Pin, type StoryNode, type World, type WorldSettings, type WorldState,
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
  };
}

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
    // states/pins/lines/chapters cascade from nodes and worlds.
    await this.platform.sql.batch([
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
