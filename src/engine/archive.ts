// One world as a single JSON file (R08-T001): every node with its state, the
// lines and bookmarks, the pins and the chapters. Import checks the whole file
// before touching the database and writes it in one transaction; a world that
// is already there is either replaced or kept, with the import saved as a new
// world under fresh ids.
import { cleanReadablePi, cleanSource } from "./pi-readable";
import type { Json, Row, SqlStatement } from "../platform";
import { newId, type Repo } from "./db/repo";
import { checkChallenge, checkScript } from "./modes";
import { bookStatements, chunksOf } from "./sources/library";
import { validBinding, type SourceBook, type AnalysisJob } from "./sources/types";
import { sourceAnalysisResult, structuredSourceAnalysis } from "./sources/facts";

export const ARCHIVE_FORMAT = "lishi-world";
// v7 preserves formal provenance and readable Pi history. Imported
// task summaries are read-only; credentials, unfinished runs and undo images
// stay on the device that owns the execution.
// Old readers reject newer versions rather than silently losing their meaning.
export const ARCHIVE_VERSION = 7;

/** Export cancellation stays distinct from preparation/selection/write errors. */
export async function exportWorldFile(repo: Repo, worldId: string, title: string): Promise<boolean> {
  const name = `${title}.lishi.json`;
  if (repo.platform.files.exportWorld) return repo.platform.files.exportWorld(worldId, name);
  const archive = await exportWorld(repo, worldId);
  return repo.platform.files.exportText(name, JSON.stringify(archive));
}
export interface AgentHistory {
  plan?: { id?: string; title: string; status: string }[];
  context?: { summary?: string; compactions?: number; inputTokens?: number; estimatedChars?: number; modelRequests?: number; toolCalls?: number };
  answers?: { questionId: string; answers: Record<string, string>; cancelled: boolean }[];
  skills?: { id: string; name?: string; version?: string; hash?: string }[];
}
export interface AgentArchivedTask { id: string; sessionId: string; text: string; policy: string; summary: string; createdAt: string; updatedAt: string; history?: AgentHistory }
export interface AgentArchivedSubtask { id: string; taskId: string; name: string; prompt: string; status: string; summary: string; sources?: { title: string; quote?: string; url?: string; section?: number; page?: number }[]; createdAt: string; updatedAt: string }
export interface AgentArchive {
  sessions: Row[];
  messages: Row[];
  tasks: AgentArchivedTask[];
  links?: { sessionId: string; parentSessionId: string; parentMessageId: string }[];
  subtasks?: AgentArchivedSubtask[];
}
export interface BookBundle { book: SourceBook; jobs: AnalysisJob[]; analysis: { jobId: string; ordinal: number; section: number; text: string }[] }

export interface PiReadableArchive {
  engine: "pi"; version: 1; readOnly: true;
  sessions: { id: string; worldId: string; lineId: string; title: string; createdAt: string; updatedAt: string }[];
  tasks: { id: string; sessionId: string; lineId?: string; text: string; status: string; policy: string; createdAt: string; updatedAt: string; history: Json }[];
}
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
  agent?: AgentArchive;
  pi?: PiReadableArchive;
  factSources?: Row[];
  factCorrections?: Row[];
}

const NODE_FIELDS = ["id", "world_id", "parent_id", "last_child_id", "seq", "kind", "action_mode", "action_text", "director_note", "narrative", "record_json", "choices_json", "status", "rewritten", "fate", "meta_json", "created_at"];
const WORLD_FIELDS = ["id", "title", "era_id", "current_line_id", "settings_json", "created_at", "updated_at", "played_at", "archived"];
const LINE_FIELDS = ["id", "world_id", "name", "node_id", "kind", "auto_named", "archived", "created_at", "deleted_at"];
const PIN_FIELDS = ["id", "world_id", "origin_node_id", "text", "created_at"];
const CHAPTER_FIELDS = ["id", "world_id", "first_node_id", "last_node_id", "summary", "model", "prompt_version", "edited", "created_at", "title", "gist"];

const parseJson = (value: unknown): Record<string, any> => {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
};
const archivedPlan = (value: unknown): NonNullable<AgentHistory["plan"]> => !Array.isArray(value) ? [] : value.flatMap((item) => {
  if (!item || typeof item !== "object") return [];
  const title = item.title ?? item.step ?? item.text;
  return typeof title === "string" && typeof item.status === "string" ? [{ ...(typeof item.id === "string" ? { id: item.id } : {}), title, status: item.status }] : [];
});
/** Deliberately a whitelist: connection snapshots and executable context never enter a world file. */
function archivedHistory(value: unknown): AgentHistory {
  const raw = parseJson(value), history: AgentHistory = {};
  if (Array.isArray(raw.plan)) history.plan = archivedPlan(raw.plan);
  const context = parseJson(raw.context);
  if (Object.keys(context).length) {
    history.context = {};
    if (typeof context.summary === "string") history.context.summary = context.summary;
    for (const key of ["compactions", "inputTokens", "estimatedChars", "modelRequests", "toolCalls"] as const) if (typeof context[key] === "number" && Number.isFinite(context[key]) && context[key] >= 0) history.context[key] = context[key];
  }
  if (Array.isArray(raw.answers)) history.answers = raw.answers.flatMap((answer: any) => typeof answer?.questionId === "string" ? [{ questionId: answer.questionId, answers: Object.fromEntries(Object.entries(parseJson(answer.answers)).filter((entry) => typeof entry[1] === "string")) as Record<string, string>, cancelled: answer.cancelled === true }] : []);
  if (Array.isArray(raw.skills)) history.skills = raw.skills.flatMap((skill: any) => typeof skill?.id === "string" ? [{ id: skill.id, ...Object.fromEntries(["name", "version", "hash"].flatMap((key) => typeof skill[key] === "string" ? [[key, skill[key]]] : [])) }] : []);
  return history;
}
const archivedSources = (value: unknown): NonNullable<AgentArchivedSubtask["sources"]> => !Array.isArray(value) ? [] : value.slice(0, 100).flatMap((source) => {
  if (!source || typeof source !== "object" || typeof source.title !== "string") return [];
  return [{ title: source.title, ...(typeof source.quote === "string" ? { quote: source.quote } : typeof source.text === "string" ? { quote: source.text } : {}), ...(typeof source.url === "string" && /^https?:\/\//i.test(source.url) ? { url: source.url } : {}), ...(Number.isInteger(source.section) && source.section >= 0 ? { section: source.section } : {}), ...(Number.isInteger(source.page) && source.page > 0 ? { page: source.page } : {}) }];
});

export async function exportWorld(repo: Repo, worldId: string): Promise<WorldArchive> {
  if(repo.platform.execution?.agent) return await repo.platform.execution.agent({op:"archive_export",worldId}) as unknown as WorldArchive;

  const q = (sql: string) => repo.platform.sql.query(sql, [worldId]);
  const [world] = await q("SELECT * FROM worlds WHERE id = ?");
  if (!world) throw new Error("world not found");
  const states = await q("SELECT s.node_id, s.state_json FROM states s JOIN nodes n ON n.id = s.node_id WHERE n.world_id = ?");
  const nodes = await q("SELECT * FROM nodes WHERE world_id = ? ORDER BY seq");
  const bookIds = new Set(states.map((s) => JSON.parse(String(s.state_json)).source?.bookId).filter(Boolean) as string[]);
  const findBooks = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && typeof (value as any).bookId === "string") bookIds.add((value as any).bookId);
    for (const part of Object.values(value)) findBooks(part);
  };
  // A correction or opening seed can cite an earlier book after the current binding changes.
  for (const row of states) findBooks(JSON.parse(String(row.state_json)));
  for (const row of nodes) findBooks(JSON.parse(String(row.meta_json)));
  const factSources=await q("SELECT * FROM story_fact_sources WHERE world_id=?");
  const factCorrections=await q("SELECT * FROM fact_corrections WHERE world_id=?");
  const pi:PiReadableArchive={engine:"pi",version:1,readOnly:true,sessions:[],tasks:[]};
  for(const row of await q("SELECT * FROM pi_sessions WHERE world_id=?")) {
    const tasks=await repo.platform.sql.query("SELECT * FROM pi_tasks WHERE session_id=? AND status IN ('completed','committed','undone','archived') ORDER BY created_at,id",[row.id]);
    if(!tasks.length)continue;
    pi.sessions.push({id:String(row.id),worldId,lineId:String(row.line_id),title:String(row.title),createdAt:String(row.created_at),updatedAt:String(row.updated_at)});
    for(const task of tasks) {
      const result=parseJson(task.result_json);
      pi.tasks.push({id:String(task.id),sessionId:String(row.id),lineId:String(task.line_id),text:String(task.text),status:"archived",policy:String(task.policy),createdAt:String(task.created_at),updatedAt:String(task.updated_at),history:result.history??{messages:[],steps:[],plan:[],sources:[],result:{status:task.status,summary:result.summary??""},truncated:true}});
    }
  }
  const readable=cleanReadablePi(pi);
  findBooks(readable);
  for(const source of factSources){source.source_json=JSON.stringify(cleanSource(JSON.parse(String(source.source_json))));findBooks(JSON.parse(String(source.source_json)));}
  for(const correction of factCorrections)findBooks(JSON.parse(String(correction.json)));
  const books: BookBundle[] = [];
  for (const id of bookIds) {
    const [row] = await repo.platform.sql.query("SELECT json FROM source_books WHERE id=?", [id]);
    if (!row) throw new Error("参考书籍缺失，无法导出完整世界");
    books.push({ book: JSON.parse(String(row.json)), jobs: (await repo.platform.sql.query("SELECT json FROM source_jobs WHERE book_id=?", [id])).map((r) => JSON.parse(String(r.json))),
      analysis: (await repo.platform.sql.query("SELECT job_id AS jobId,ordinal,section,text FROM source_analysis WHERE book_id=?", [id])) as any });
  }
  return {
    format:ARCHIVE_FORMAT, version:ARCHIVE_VERSION, exportedAt:new Date().toISOString(), world,nodes,states,
    lines:await q("SELECT * FROM lines WHERE world_id=?"),pins:await q("SELECT * FROM pins WHERE world_id=?"),chapters:await q("SELECT * FROM chapters WHERE world_id=?"),books,
    pi:readable,factSources,factCorrections
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
  if (a.version >= 3) {
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
          else if (job && structuredSourceAnalysis(part.text)) {
            // Rebuild the same validated facts on import, using its newly assigned job/book.
            try {
              const parsed = sourceAnalysisResult(part.text, b, chunks[part.ordinal], job);
              if (structuredSourceAnalysis(parsed.text)!.facts.length !== structuredSourceAnalysis(part.text)!.facts.length) problems.push("书籍整理事实缺少有效原文出处或生效范围");
            } catch { problems.push("书籍整理事实缺少有效原文出处或生效范围"); }
          }
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
  if (a.version >= 4 && !problems.length) {
    const bundles = new Map((a.books ?? []).map((b) => [b.book.id, b]));
    const lines = new Set(a.lines.map((l) => l.id));
    const citationValid = (c: any) => {
      const bundle = bundles.get(c?.bookId), chunk = bundle && chunksOf(bundle.book)[c?.chunk];
      return !!chunk && Number.isInteger(c.section) && c.section === chunk.section && typeof c.title === "string"
        && typeof c.quote === "string" && !!c.quote.trim() && chunk.text.includes(c.quote)
        && (c.start === undefined && c.end === undefined || Number.isInteger(c.start) && Number.isInteger(c.end) && c.start >= 0 && c.end > c.start && chunk.text.slice(c.start, c.end) === c.quote);
    };
    const checkState = (state: any) => {
      if (state.executionMode !== undefined && !["classic", "agent"].includes(state.executionMode)) problems.push("有的路线的执行方式无效");
      if (state.source != null) {
        const b = bundles.get(state.source.bookId)?.book;
        if (!validBinding(state.source) || !b || state.source.position >= b.sections.length || state.source.through !== null && (state.source.through >= b.sections.length || state.source.position > state.source.through)) problems.push("初始信息或路线中的参考书籍无效");
      }
      if (state.facts !== undefined && (!Array.isArray(state.facts) || state.facts.some((f: any) => !f || typeof f.id !== "string" || typeof f.detail !== "string"
        || !["source", "player", "branch", "ai", "correction", "legacyUnknown"].includes(f.origin) || !Array.isArray(f.citations) || f.citations.some((c: any) => !citationValid(c))
        || f.nodeId !== undefined && !nodes.has(f.nodeId) || f.supersedes !== undefined && (!Array.isArray(f.supersedes) || f.supersedes.some((id: unknown) => typeof id !== "string"))))) problems.push("有的事实出处损坏或找不到原文");
    };
    for (const row of a.states) checkState(JSON.parse(String(row.state_json)));
    for (const row of a.nodes) {
      let meta: any;
      try { meta = JSON.parse(String(row.meta_json)); } catch { problems.push("有的回合附加信息损坏"); continue; }
      if (meta.openingSeed !== undefined) {
        const seed = meta.openingSeed;
        if (!seed || seed.time?.elapsedMinutes !== 0 || typeof seed.protagonist?.name !== "string" || !Array.isArray(seed.people)) problems.push("有的开场初始信息损坏");
        else checkState(seed);
      }
      const revision = meta.revision;
      if (revision !== undefined && (!revision || revision.kind !== "canonCorrection" || !nodes.has(revision.nodeId) || !lines.has(revision.lineId)
        || !Array.isArray(revision.corrections) || revision.corrections.some((c: any) => typeof c?.detail !== "string" || !Array.isArray(c.citations) || !c.citations.length || c.citations.some((v: any) => !citationValid(v))))) problems.push("有的修订路线引用无效");
    }
  }
  if (a.version >= 7) {
    const pi=a.pi, lines=new Set(a.lines.map(l=>l.id));
    if(pi!==undefined) {
      if(!pi || pi.engine!=="pi" || pi.version!==1 || pi.readOnly!==true || !Array.isArray(pi.sessions) || !Array.isArray(pi.tasks)) problems.push("助手只读历史格式无效");
      else {
        const sessions=new Map(pi.sessions.map(item=>[item?.id,item]));
        if(sessions.size!==pi.sessions.length || pi.sessions.some(item=>!item || typeof item.id!=="string" || item.worldId!==a.world!.id || !lines.has(item.lineId) || typeof item.title!=="string")) problems.push("助手会话不属于本故事或路线");
        if(new Set(pi.tasks.map(item=>item?.id)).size!==pi.tasks.length || pi.tasks.some(item=>!item || typeof item.id!=="string" || !sessions.has(item.sessionId) || item.lineId !== undefined && !lines.has(item.lineId) || !["completed","committed","undone","archived"].includes(item.status) || !item.history || typeof item.history!=="object"))problems.push("助手历史含有无效或未完成任务");
      }
    }
    if(a.factSources!==undefined && (!Array.isArray(a.factSources) || a.factSources.some(item=>!item || item.world_id!==a.world!.id || !lines.has(item.line_id) || item.node_id!=null&&!nodes.has(item.node_id as string) || !["original","player_setting","player_choice","local_custom","local_consistency","external","insufficient","legacyUnknown"].includes(String(item.basis)) || typeof item.claim!=="string" || typeof item.source_json!=="string")))problems.push("正式事实来源损坏或属于其他故事");
    if(a.factCorrections!==undefined && (!Array.isArray(a.factCorrections) || a.factCorrections.some(item=>!item || item.world_id!==a.world!.id || !nodes.has(item.node_id as string) || !nodes.has(item.original_node_id as string))))problems.push("事实更正引用无效");
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
  const mapState = (state: any) => ({ ...state, ...(Array.isArray(state.facts) ? { facts: state.facts.map((f: any) => ({ ...f, id: id(f.id), ...(f.nodeId ? { nodeId: id(f.nodeId) } : {}), ...(f.supersedes ? { supersedes: f.supersedes.map(id) } : {}) })) } : {}) });
  const mapMeta = (text: Json) => {
    const meta = JSON.parse(String(text));
    if (meta.openingSeed) meta.openingSeed = mapState(meta.openingSeed);
    if (meta.revision) meta.revision = { ...meta.revision, nodeId: id(meta.revision.nodeId), lineId: id(meta.revision.lineId) };
    return JSON.stringify(meta);
  };
  const sourceIds=(value:any):any=>Array.isArray(value)?value.map(sourceIds):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([key,v])=>[key,["nodeId","lineId","taskId","sessionId"].includes(key)&&typeof v==="string"?id(v):key==="playerReferenceId"&&typeof v==="string"&&v.includes(":")?`${id(v.slice(0,v.lastIndexOf(":")))}${v.slice(v.lastIndexOf(":"))}`:sourceIds(v)])):value;
  return {
    ...a,
    world: { ...a.world, id: worldId, current_line_id: id(a.world.current_line_id), title: `${a.world.title as string}（导入）` },
    nodes: a.nodes.map((n) => ({ ...n, id: id(n.id), world_id: worldId, parent_id: id(n.parent_id), last_child_id: n.last_child_id == null ? null : id(n.last_child_id), meta_json: mapMeta(n.meta_json) })),
    states: a.states.map((s) => ({ ...s, node_id: id(s.node_id), state_json: JSON.stringify(mapState(JSON.parse(String(s.state_json)))) })),
    lines: a.lines.map((l) => ({ ...l, id: id(l.id), world_id: worldId, node_id: id(l.node_id) })),
    pins: a.pins.map((p) => ({ ...p, id: id(p.id), world_id: worldId, origin_node_id: id(p.origin_node_id) })),
    chapters: a.chapters.map((c) => ({ ...c, id: id(c.id), world_id: worldId, first_node_id: id(c.first_node_id), last_node_id: id(c.last_node_id) })),
    ...(a.pi ? {pi:{...a.pi,sessions:a.pi.sessions.map(item=>({...item,id:id(item.id)!,worldId:worldId!,lineId:id(item.lineId)!})),tasks:a.pi.tasks.map(item=>({...item,id:id(item.id)!,sessionId:id(item.sessionId)!,...(item.lineId ? {lineId:id(item.lineId)!} : {}),history:sourceIds(item.history)}))}} : {}),
    ...(a.factSources ? {factSources:a.factSources.map(item=>({...item,id:id(item.id),world_id:worldId,line_id:id(item.line_id),node_id:id(item.node_id),task_id:id(item.task_id),batch_id:id(item.batch_id),source_json:JSON.stringify(sourceIds(JSON.parse(String(item.source_json)))),resource_id:["node","state","people","protagonist","places","cards","goals","facts"].includes(String(item.resource_kind))&&item.resource_id ? id(item.resource_id):item.resource_id}))} : {}),
    ...(a.factCorrections ? {factCorrections:a.factCorrections.map(item=>({...item,id:id(item.id),world_id:worldId,node_id:id(item.node_id),original_node_id:id(item.original_node_id)}))} : {}),
    ...(a.version >= 5 && a.agent ? { agent: {
      sessions: a.agent.sessions.map((session) => ({ ...session, id: id(session.id), world_id: worldId, line_id: id(session.line_id) })),
      tasks: a.agent.tasks.map((task) => ({ ...task, id: id(task.id)!, sessionId: id(task.sessionId)! })),
      messages: a.agent.messages.map((message) => ({ ...message, id: id(message.id), session_id: id(message.session_id), task_id: id(message.task_id) })),
      ...(a.agent.links ? { links: a.agent.links.map((link) => ({ sessionId: id(link.sessionId)!, parentSessionId: id(link.parentSessionId)!, parentMessageId: id(link.parentMessageId)! })) } : {}),
      ...(a.agent.subtasks ? { subtasks: a.agent.subtasks.map((task) => ({ ...task, id: id(task.id)!, taskId: id(task.taskId)! })) } : {}),
    } } : {}),
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
    if (!json.includes('"script"') && !json.includes('"challenge"') && !json.includes('"executionMode"')) return row;
    const state = JSON.parse(json) as { script?: unknown; challenge?: unknown; executionMode?: unknown };
    let changed = false;
    if (state.executionMode !== undefined && state.executionMode !== "classic" && state.executionMode !== "agent") { delete state.executionMode; changed = true; }
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
  const formal={...(raw as WorldArchive),agent:undefined};
  const archive = cleanModes(mode === "new" ? remap(formal) : formal);
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
    if (Array.isArray(value?.facts)) value.facts = value.facts.map((f: any) => ({ ...f, citations: f.citations.map((c: any) => ({ ...c, bookId: bookIds.get(c.bookId) ?? c.bookId })) }));
    return JSON.stringify(value);
  };
  const mapMeta = (text: Json) => {
    if (typeof text !== "string") return text;
    const meta = JSON.parse(text);
    if (meta?.reference) {
      meta.reference = { ...meta.reference, bookId: bookIds.get(meta.reference.bookId) ?? meta.reference.bookId, binding: mapSource(meta.reference.binding) };
    }
    if (meta?.openingSeed) meta.openingSeed = JSON.parse(mapJson(JSON.stringify(meta.openingSeed), "source") as string);
    if (meta?.revision?.corrections) meta.revision.corrections = meta.revision.corrections.map((c: any) => ({ ...c, citations: c.citations.map((v: any) => ({ ...v, bookId: bookIds.get(v.bookId) ?? v.bookId })) }));
    if (Array.isArray(meta?.carriedEdits)) meta.carriedEdits = meta.carriedEdits.map((edit: any) => ({ ...edit, record: edit.record ? { ...edit.record, ...(edit.record.sourceSet ? { sourceSet: mapSource(edit.record.sourceSet) } : {}) } : edit.record }));
    return JSON.stringify(meta);
  };
  for (const bundle of archive.books ?? []) {
    const bookId = bookIds.get(bundle.book.id)!;
    // A long novel can produce hundreds of thousands of index rows. Keep the
    // single import transaction without passing each row as a JS argument.
    for (const statement of bookStatements({ ...bundle.book, id: bookId })) statements.push(statement);
    for (const job of bundle.jobs) {
      const mapped = { ...job, id: jobIds.get(job.id)!, bookId, status: job.status === "running" ? "paused" : job.status };
      statements.push({ sql: "INSERT INTO source_jobs(id,book_id,json,created_at) VALUES(?,?,?,?)", params: [mapped.id, bookId, JSON.stringify(mapped), new Date().toISOString()] });
    }
    const book = { ...bundle.book, id: bookId }, chunks = chunksOf(book);
    for (const part of bundle.analysis) {
      const job = bundle.jobs.find((j) => j.id === part.jobId)!;
      const mappedJob = { ...job, id: jobIds.get(job.id)!, bookId };
      const result = sourceAnalysisResult(part.text, book, chunks[part.ordinal], mappedJob);
      statements.push({ sql: "INSERT INTO source_analysis(job_id,book_id,ordinal,section,text) VALUES(?,?,?,?,?)", params: [mappedJob.id, bookId, part.ordinal, part.section, result.text] });
      for (const statement of result.statements) statements.push(statement);
    }
  }
  if (mode === "replace") {
    // Acquire SQLite write transaction first, then reject a concurrent owner.
    statements.push({sql:"INSERT INTO worlds(id,title,era_id,settings_json,created_at,updated_at,played_at) SELECT 'archive-guard',NULL,'','{}','','','' WHERE EXISTS(SELECT 1 FROM world_execution_leases WHERE world_id=? AND owner_id<>'' AND expires_at_ms>?)",params:[worldId,Date.now()]});
    statements.push(
      { sql: "DELETE FROM pins WHERE world_id = ?", params: [worldId] },
      { sql: "DELETE FROM chapters WHERE world_id = ?", params: [worldId] },
      { sql: "DELETE FROM lines WHERE world_id = ?", params: [worldId] },
      { sql: "DELETE FROM nodes WHERE world_id = ?", params: [worldId] },
      { sql: "DELETE FROM worlds WHERE id = ?", params: [worldId] },
    );
  }
  statements.push(insert("worlds", WORLD_FIELDS, { ...archive.world, current_line_id: null }));
  for (const n of nodes) statements.push(insert("nodes", NODE_FIELDS, { ...n, last_child_id: null, record_json: mapJson(n.record_json, "sourceSet"), meta_json: mapMeta(n.meta_json) }));
  // Redo pointers, only where the node they point to came along.
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes) if (n.last_child_id != null && nodeIds.has(n.last_child_id)) statements.push({ sql: "UPDATE nodes SET last_child_id = ? WHERE id = ?", params: [n.last_child_id as Json, n.id as Json] });
  for (const s of archive.states) statements.push(insert("states", ["node_id", "state_json"], { ...s, state_json: mapJson(s.state_json, "source") }));
  for (const l of archive.lines) statements.push(insert("lines", LINE_FIELDS, l));
  for (const p of archive.pins) statements.push(insert("pins", PIN_FIELDS, p));
  for (const c of archive.chapters) statements.push(insert("chapters", CHAPTER_FIELDS, c));
  statements.push({ sql: "UPDATE worlds SET current_line_id = ? WHERE id = ?", params: [archive.world.current_line_id as Json, worldId] });
  const mapBooksDeep=(value:any):any=>Array.isArray(value)?value.map(mapBooksDeep):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==="bookId"&&typeof v==="string"?bookIds.get(v)??v:mapBooksDeep(v)])):value;
  if(archive.version>=7 && archive.pi) {
    let pi=repo.platform.execution?.agent ? archive.pi : cleanReadablePi(archive.pi);
    if(repo.platform.execution?.agent) pi=await repo.platform.execution.agent({op:"archive_validate",worldId:String(worldId),lineIds:archive.lines.map(line=>line.id),pi:JSON.parse(JSON.stringify(pi))}) as unknown as PiReadableArchive;
    for(const session of pi.sessions) statements.push({sql:"INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)",params:[session.id,worldId,session.lineId,session.title,session.createdAt,session.updatedAt]});
    for(const task of pi.tasks) {
      const session=pi.sessions.find(item=>item.id===task.sessionId)!;
      statements.push({sql:"INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,base_json,base_world_version,result_json,created_at,updated_at) VALUES(?,?,?,?,?,'archived',?,'{}','',?,?,?)",params:[task.id,task.sessionId,worldId,task.lineId ?? session.lineId,task.text,task.policy,JSON.stringify({history:mapBooksDeep(task.history),summary:"导入的只读助手历史"}),task.createdAt,task.updatedAt]});
    }
  }
  for(const source of archive.factSources??[]) statements.push(insert("story_fact_sources",["id","world_id","line_id","node_id","resource_kind","resource_id","batch_id","task_id","basis","claim","source_json","created_at"],{...source,source_json:JSON.stringify(mapBooksDeep(cleanSource(JSON.parse(String(source.source_json)))))}));
  for(const correction of archive.factCorrections??[])statements.push(insert("fact_corrections",["id","world_id","node_id","original_node_id","json","created_at"],{...correction,json:JSON.stringify(mapBooksDeep(JSON.parse(String(correction.json))))}));
  await repo.platform.sql.batch(statements);
  return worldId;
}
