// One world as a single JSON file (R08-T001): every node with its state, the
// lines and bookmarks, the pins and the chapters. Import checks the whole file
// before touching the database and writes it in one transaction; a world that
// is already there is either replaced or kept, with the import saved as a new
// world under fresh ids.
import type { Json, Row, SqlStatement } from "../platform";
import { newId, type Repo } from "./db/repo";
import { checkChallenge, checkScript } from "./modes";

export const ARCHIVE_FORMAT = "lishi-world";
// v2 carries free-world mode and branch-scoped custom panels. Old readers
// must reject it rather than silently interpreting those worlds as history.
export const ARCHIVE_VERSION = 2;

export interface WorldArchive {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  exportedAt: string;
  world: Row;
  nodes: Row[];
  states: Row[];
  lines: Row[];
  pins: Row[];
  chapters: Row[];
}

const NODE_FIELDS = ["id", "world_id", "parent_id", "last_child_id", "seq", "kind", "action_mode", "action_text", "director_note", "narrative", "record_json", "choices_json", "status", "rewritten", "fate", "meta_json", "created_at"];
const WORLD_FIELDS = ["id", "title", "era_id", "current_line_id", "settings_json", "created_at", "updated_at", "played_at", "archived"];
const LINE_FIELDS = ["id", "world_id", "name", "node_id", "kind", "auto_named", "archived", "created_at", "deleted_at"];
const PIN_FIELDS = ["id", "world_id", "origin_node_id", "text", "created_at"];
const CHAPTER_FIELDS = ["id", "world_id", "first_node_id", "last_node_id", "summary", "model", "prompt_version", "edited", "created_at", "title", "gist"];

export async function exportWorld(repo: Repo, worldId: string): Promise<WorldArchive> {
  const q = (sql: string) => repo.platform.sql.query(sql, [worldId]);
  const [world] = await q("SELECT * FROM worlds WHERE id = ?");
  if (!world) throw new Error("world not found");
  return {
    format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, exportedAt: new Date().toISOString(), world,
    nodes: await q("SELECT * FROM nodes WHERE world_id = ? ORDER BY seq"),
    states: await q("SELECT s.node_id, s.state_json FROM states s JOIN nodes n ON n.id = s.node_id WHERE n.world_id = ?"),
    lines: await q("SELECT * FROM lines WHERE world_id = ? ORDER BY created_at"),
    pins: await q("SELECT * FROM pins WHERE world_id = ?"),
    chapters: await q("SELECT * FROM chapters WHERE world_id = ?"),
  };
}

/** What is wrong with a file, in the player's words; empty when it can be imported. */
export function archiveProblems(raw: unknown): string[] {
  const a = raw as Partial<WorldArchive> | null;
  if (!a || typeof a !== "object" || a.format !== ARCHIVE_FORMAT) return ["这不是本游戏导出的世界文件"];
  if (typeof a.version !== "number" || a.version > ARCHIVE_VERSION) return ["这个文件来自更新的版本，请先更新游戏"];
  if (!Number.isInteger(a.version) || a.version < 1) return ["存档格式版本无效"];
  if (!a.world || !Array.isArray(a.nodes) || !Array.isArray(a.states) || !Array.isArray(a.lines) || !Array.isArray(a.pins) || !Array.isArray(a.chapters)) return ["文件不完整"];
  const problems: string[] = [];
  const nodes = new Set(a.nodes.map((n) => n.id as string));
  if (!a.nodes.length) problems.push("文件里没有任何回合");
  if (a.nodes.some((n) => n.world_id !== a.world!.id)) problems.push("回合属于别的世界");
  if (a.nodes.some((n) => n.parent_id != null && !nodes.has(n.parent_id as string))) problems.push("有的回合找不到上一回合");
  const states = new Set(a.states.map((s) => s.node_id as string));
  if (a.nodes.some((n) => !states.has(n.id as string))) problems.push("有的回合缺少状态");
  if (a.states.some((s) => { try { JSON.parse(s.state_json as string); return false; } catch { return true; } })) problems.push("有的状态损坏了");
  if (a.lines.some((l) => !nodes.has(l.node_id as string))) problems.push("有的世界线指向不存在的回合");
  if (!a.lines.some((l) => l.id === a.world!.current_line_id)) problems.push("找不到当前世界线");
  if (a.pins.some((p) => p.origin_node_id != null && !nodes.has(p.origin_node_id as string))) problems.push("有的要点指向不存在的回合");
  return problems;
}

/** Fresh ids for everything, keeping every reference between them. */
function remap(a: WorldArchive): WorldArchive {
  const ids = new Map<string, string>();
  const id = (old: Json) => {
    if (old == null) return null;
    if (!ids.has(old as string)) ids.set(old as string, newId());
    return ids.get(old as string)!;
  };
  const worldId = id(a.world.id);
  return {
    ...a,
    world: { ...a.world, id: worldId, current_line_id: id(a.world.current_line_id), title: `${a.world.title as string}（导入）` },
    nodes: a.nodes.map((n) => ({ ...n, id: id(n.id), world_id: worldId, parent_id: id(n.parent_id), last_child_id: n.last_child_id == null ? null : id(n.last_child_id) })),
    states: a.states.map((s) => ({ ...s, node_id: id(s.node_id) })),
    lines: a.lines.map((l) => ({ ...l, id: id(l.id), world_id: worldId, node_id: id(l.node_id) })),
    pins: a.pins.map((p) => ({ ...p, id: id(p.id), world_id: worldId, origin_node_id: id(p.origin_node_id) })),
    chapters: a.chapters.map((c) => ({ ...c, id: id(c.id), world_id: worldId, first_node_id: id(c.first_node_id), last_node_id: id(c.last_node_id) })),
  };
}

/**
 * Play modes (R14) are optional: a script, challenge or pilot that is not in a
 * shape this version understands is dropped, and the rest of the world kept.
 */
function cleanModes(a: WorldArchive): WorldArchive {
  let settings: { pilot?: unknown } = {};
  try { settings = JSON.parse(String(a.world.settings_json)); } catch { /* unreadable settings fall back to defaults, as before */ }
  const world = settings?.pilot === undefined || settings.pilot === "player" || settings.pilot === "ai" ? a.world
    : { ...a.world, settings_json: JSON.stringify({ ...settings, pilot: undefined }) };
  const states = a.states.map((row) => {
    const json = row.state_json as string;
    if (!json.includes('"script"') && !json.includes('"challenge"')) return row;
    const state = JSON.parse(json) as { script?: unknown; challenge?: unknown };
    let changed = false;
    for (const [key, check] of [["script", checkScript], ["challenge", checkChallenge]] as const) {
      if (state[key] == null) continue;
      const checked = check(state[key]);
      state[key] = typeof checked === "string" ? undefined : checked;
      changed = true;
    }
    return changed ? { ...row, state_json: JSON.stringify(state) } : row;
  });
  return { ...a, world, states };
}

const insert = (table: string, fields: string[], row: Row): SqlStatement => ({
  sql: `INSERT INTO ${table} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
  params: fields.map((f) => (row[f] === undefined ? null : row[f]) as Json),
});

/**
 * Writes an archive. `mode`: "new" always saves under fresh ids; "replace"
 * removes a world with the same id first. Returns the world's id. Throws with
 * the problems when the file cannot be used; the database is then untouched.
 */
export async function importWorld(repo: Repo, raw: unknown, mode: "new" | "replace"): Promise<string> {
  const problems = archiveProblems(raw);
  if (problems.length) throw new Error(problems.join("；"));
  const archive = cleanModes(mode === "new" ? remap(raw as WorldArchive) : (raw as WorldArchive));
  const worldId = archive.world.id as string;
  // Parents before children, so every foreign key holds as rows go in.
  const nodes = [...archive.nodes].sort((a, b) => (a.seq as number) - (b.seq as number));
  const statements: SqlStatement[] = [];
  if (mode === "replace") {
    statements.push(
      { sql: "DELETE FROM pins WHERE world_id = ?", params: [worldId] },
      { sql: "DELETE FROM chapters WHERE world_id = ?", params: [worldId] },
      { sql: "DELETE FROM lines WHERE world_id = ?", params: [worldId] },
      { sql: "DELETE FROM nodes WHERE world_id = ?", params: [worldId] },
      { sql: "DELETE FROM worlds WHERE id = ?", params: [worldId] },
    );
  }
  statements.push(
    insert("worlds", WORLD_FIELDS, { ...archive.world, current_line_id: null }),
    ...nodes.map((n) => insert("nodes", NODE_FIELDS, { ...n, last_child_id: null })),
    // Redo pointers, only where the node they point to came along.
    ...nodes.filter((n) => n.last_child_id != null && nodes.some((x) => x.id === n.last_child_id)).map((n) => ({ sql: "UPDATE nodes SET last_child_id = ? WHERE id = ?", params: [n.last_child_id as Json, n.id as Json] })),
    ...archive.states.map((s) => insert("states", ["node_id", "state_json"], s)),
    ...archive.lines.map((l) => insert("lines", LINE_FIELDS, l)),
    ...archive.pins.map((p) => insert("pins", PIN_FIELDS, p)),
    ...archive.chapters.map((c) => insert("chapters", CHAPTER_FIELDS, c)),
    { sql: "UPDATE worlds SET current_line_id = ? WHERE id = ?", params: [archive.world.current_line_id as Json, worldId] },
  );
  await repo.platform.sql.batch(statements);
  return worldId;
}
