// One world as a single JSON file (R08-T001): every node with its state, the
// lines and bookmarks, the pins and the chapters. Import checks the whole file
// before touching the database and writes it in one transaction; a world that
// is already there is either replaced or kept, with the import saved as a new
// world under fresh ids.
import type { Json, Row, SqlStatement } from "../platform";
import { newId, type Repo } from "./db/repo";
import { checkChallenge, checkScript } from "./modes";
import { bookStatements, chunksOf } from "./sources/library";
import { validBinding, type SourceBook, type AnalysisJob } from "./sources/types";

export const ARCHIVE_FORMAT = "lishi-world";
// v2 added free worlds and panels; v3 carries immutable books and source bindings.
// Old readers reject newer versions rather than silently losing their meaning.
export const ARCHIVE_VERSION = 3;
export interface BookBundle { book: SourceBook; jobs: AnalysisJob[]; analysis: { jobId: string; ordinal: number; section: number; text: string }[] }

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
  books?: BookBundle[];
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
  const states = await q("SELECT s.node_id, s.state_json FROM states s JOIN nodes n ON n.id = s.node_id WHERE n.world_id = ?");
  const bookIds = new Set(states.map((s) => JSON.parse(String(s.state_json)).source?.bookId).filter(Boolean) as string[]);
  const books: BookBundle[] = [];
  for (const id of bookIds) {
    const [row] = await repo.platform.sql.query("SELECT json FROM source_books WHERE id=?", [id]);
    if (!row) throw new Error("参考书籍缺失，无法导出完整世界");
    books.push({ book: JSON.parse(String(row.json)), jobs: (await repo.platform.sql.query("SELECT json FROM source_jobs WHERE book_id=?", [id])).map((r) => JSON.parse(String(r.json))),
      analysis: (await repo.platform.sql.query("SELECT job_id AS jobId,ordinal,section,text FROM source_analysis WHERE book_id=?", [id])) as any });
  }
  return {
    format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, exportedAt: new Date().toISOString(), world,
    nodes: await q("SELECT * FROM nodes WHERE world_id = ? ORDER BY seq"),
    states, books,
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
  if (a.version === 3) {
    if (!Array.isArray(a.books)) problems.push("文件缺少参考书籍清单");
    else {
      const ids = new Set<string>();
      for (const bundle of a.books) {
        const b = bundle?.book;
        if (!b || typeof b.id !== "string" || ids.has(b.id) || typeof b.title !== "string" || !["txt", "epub", "pdf", "docx"].includes(b.format) || !Array.isArray(b.sections) || !b.sections.length || b.sections.some((s) => !s || typeof s.title !== "string" || typeof s.text !== "string" || (s.page !== undefined && (!Number.isInteger(s.page) || s.page < 1)))) { problems.push("参考书籍损坏"); continue; }
        ids.add(b.id);
        if (b.sections.reduce((n, s) => n + s.text.length, 0) > 64 * 1024 * 1024 || typeof b.createdAt !== "string") problems.push("参考书籍过大或信息不完整");
        if (!Array.isArray(bundle.jobs) || !Array.isArray(bundle.analysis)) { problems.push("书籍整理记录损坏"); continue; }
        if (bundle.jobs.some((j) => !j || typeof j.id !== "string")) { problems.push("书籍整理任务损坏"); continue; }
        const jobs = new Set(bundle.jobs.map((j) => j.id));
        if (jobs.size !== bundle.jobs.length || bundle.jobs.some((j) => j.bookId !== b.id || typeof j.instructions !== "string" || typeof j.model !== "string" || typeof j.promptVersion !== "string" || !["running", "paused", "done", "failed"].includes(j.status) || !Number.isInteger(j.completed) || !Number.isInteger(j.total) || j.completed < 0 || j.total < j.completed || !(j.through === null || Number.isInteger(j.through) && j.through >= 0 && j.through < b.sections.length))) problems.push("书籍整理任务损坏");
        const chunks = chunksOf(b), completed = new Set<string>();
        for (const part of bundle.analysis) {
          if (!part) { problems.push("书籍整理片段损坏"); continue; }
          const key = `${part.jobId}:${part.ordinal}`;
          const job = bundle.jobs.find((j) => j.id === part.jobId);
          if (!jobs.has(part.jobId) || completed.has(key) || !Number.isInteger(part.ordinal) || chunks[part.ordinal]?.section !== part.section || typeof part.text !== "string" || part.text.length > 20000 || job && job.through !== null && part.section > job.through) problems.push("书籍整理片段损坏");
          completed.add(key);
        }
      }
      if (problems.length) return problems;
      for (const row of a.states) try {
        const source = JSON.parse(String(row.state_json)).source;
        if (source != null) {
          if (!validBinding(source) || !ids.has(source.bookId)) problems.push("有的路线缺少有效参考书籍");
          else {
            const bundle = a.books.find((b) => b.book.id === source.bookId)!;
            if (source.position >= bundle.book.sections.length || source.through !== null && (source.through >= bundle.book.sections.length || source.position > source.through) || source.analysisId && !bundle.jobs.some((j) => j.id === source.analysisId)) problems.push("有的路线的书籍范围或整理引用无效");
          }
        }
      } catch { /* handled above */ }
    }
  }
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
  // Always assign fresh book/job ids. Importing cannot rewrite immutable material
  // referenced by a different world, even when replacing this world's tree.
  const bookIds = new Map<string, string>(), jobIds = new Map<string, string>();
  for (const bundle of archive.books ?? []) {
    bookIds.set(bundle.book.id, newId());
    for (const job of bundle.jobs) jobIds.set(job.id, newId());
  }
  const mapSource = (value: any) => {
    if (value?.bookId && bookIds.has(value.bookId)) return { ...value, bookId: bookIds.get(value.bookId), ...(value.analysisId ? { analysisId: jobIds.get(value.analysisId) } : {}) };
    return value;
  };
  const mapJson = (text: Json, field: string) => {
    if (typeof text !== "string") return text;
    const value = JSON.parse(text);
    if (value?.[field]) value[field] = mapSource(value[field]);
    return JSON.stringify(value);
  };
  const mapMeta = (text: Json) => {
    if (typeof text !== "string") return text;
    const meta = JSON.parse(text);
    if (meta?.reference) {
      meta.reference = { ...meta.reference, bookId: bookIds.get(meta.reference.bookId) ?? meta.reference.bookId, binding: mapSource(meta.reference.binding) };
    }
    if (Array.isArray(meta?.carriedEdits)) meta.carriedEdits = meta.carriedEdits.map((edit: any) => ({ ...edit, record: edit.record ? { ...edit.record, ...(edit.record.sourceSet ? { sourceSet: mapSource(edit.record.sourceSet) } : {}) } : edit.record }));
    return JSON.stringify(meta);
  };
  for (const bundle of archive.books ?? []) {
    const bookId = bookIds.get(bundle.book.id)!;
    statements.push(...bookStatements({ ...bundle.book, id: bookId }));
    for (const job of bundle.jobs) {
      const mapped = { ...job, id: jobIds.get(job.id)!, bookId, status: job.status === "running" ? "paused" : job.status };
      statements.push({ sql: "INSERT INTO source_jobs(id,book_id,json,created_at) VALUES(?,?,?,?)", params: [mapped.id, bookId, JSON.stringify(mapped), new Date().toISOString()] });
    }
    for (const part of bundle.analysis) statements.push({ sql: "INSERT INTO source_analysis(job_id,book_id,ordinal,section,text) VALUES(?,?,?,?,?)", params: [jobIds.get(part.jobId)!, bookId, part.ordinal, part.section, part.text] });
  }
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
    ...nodes.map((n) => insert("nodes", NODE_FIELDS, { ...n, last_child_id: null, record_json: mapJson(n.record_json, "sourceSet"), meta_json: mapMeta(n.meta_json) })),
    // Redo pointers, only where the node they point to came along.
    ...nodes.filter((n) => n.last_child_id != null && nodes.some((x) => x.id === n.last_child_id)).map((n) => ({ sql: "UPDATE nodes SET last_child_id = ? WHERE id = ?", params: [n.last_child_id as Json, n.id as Json] })),
    ...archive.states.map((s) => insert("states", ["node_id", "state_json"], { ...s, state_json: mapJson(s.state_json, "source") })),
    ...archive.lines.map((l) => insert("lines", LINE_FIELDS, l)),
    ...archive.pins.map((p) => insert("pins", PIN_FIELDS, p)),
    ...archive.chapters.map((c) => insert("chapters", CHAPTER_FIELDS, c)),
    { sql: "UPDATE worlds SET current_line_id = ? WHERE id = ?", params: [archive.world.current_line_id as Json, worldId] },
  );
  await repo.platform.sql.batch(statements);
  return worldId;
}
