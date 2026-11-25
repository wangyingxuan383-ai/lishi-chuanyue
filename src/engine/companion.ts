// Unified Companion ("伴聊") engine client, pure-TS SQLite/LLM fallback for tests,
// NPC knowledge-fenced persona extraction, and creative bridges (R33-T001..T003, D187).

import type { Json, Platform, SqlStatement } from "../platform";
import {
  BUILTIN_PERSONAS,
  DEFAULT_PERSONA_ID,
  exportPersonaJson,
  getBuiltinPersona,
  isBuiltinPersonaId,
  parsePersonaJson,
  type CompanionPersona,
  type PersonaExportBundle,
  type PersonaMemoryScope,
  type PersonaRoleKind,
} from "../content/personas";
import { newId } from "./db/ids";
import type { Repo } from "./db/repo";
import type { Game } from "./game";
import { readContinuity, type ProjectedKnowledge } from "./continuity";
import { ChatError, streamChat, type ChatMessage, type ChatToolDefinition } from "./llm/chat";
import { lenientJson } from "./record/parse";
import type { Arrival, SetupDraft } from "./prompt/turn";
import {
  localNoteContent,
  mentionedChapters,
  newNote,
  newStoryNote,
  saveNote,
  storyLastTurn,
  type CanonNote,
  type NoteKind,
} from "./sources/notes";
import { referenceContext } from "./sources/library";
import type { SourceBinding } from "./sources/types";
import { chatCompletionsUrl, listProfiles } from "./llm/providers";
import {
  AgentClient,
  DEFAULT_AGENT_INPUT_TOKENS,
  getAgentPreferences,
  type AgentPolicy,
  type AgentPreferences,
  type AgentProtocol,
  type AgentThinkingMode,
} from "./agent";
import type { LlmConfig } from "./game";
import * as tree from "./tree";

export {
  BUILTIN_PERSONAS,
  DEFAULT_PERSONA_ID,
  exportPersonaJson,
  getBuiltinPersona,
  isBuiltinPersonaId,
  parsePersonaJson,
  type CompanionPersona,
  type PersonaExportBundle,
  type PersonaMemoryScope,
  type PersonaRoleKind,
};

export type CompanionGear = "chat" | "research" | "agent";
export type CompanionMessageStatus = "streaming" | "done" | "cancelled" | "failed" | "interrupted";
export type CompanionMemoryScope = "persona" | "global";
export type CompanionMemoryCategory = "preference" | "fact" | "lore" | "bond" | "relation" | "note";

export interface CompanionStep {
  id: string;
  tool: string;
  label: string;
  query?: string;
  status: "running" | "done" | "failed";
  summary: string;
}

export interface CompanionCitation {
  kind: "book" | "web" | "world";
  title: string;
  url?: string;
  bookId?: string;
  section?: number;
  chunk?: number;
  quote?: string;
}

export interface CompanionUsage {
  promptTokens?: number | null;
  completionTokens?: number | null;
  firstTokenMs?: number | null;
  totalMs?: number | null;
  estimated?: boolean;
}

export interface CompanionBranchInfo {
  branchIndex: number;
  branchCount: number;
  siblingIds: string[];
}

export interface CompanionMessage {
  id: string;
  sessionId: string;
  parentId: string | null;
  seq: number;
  role: "user" | "assistant" | "system" | "system_note";
  gear: CompanionGear;
  status: CompanionMessageStatus;
  content: string;
  thinking: string;
  steps: CompanionStep[];
  citations: CompanionCitation[];
  piTaskId: string | null;
  modelId: string;
  usage: CompanionUsage | null;
  errorText: string | null;
  createdAt: string;
  updatedAt: string;
  branch?: CompanionBranchInfo;
  branchIndex?: number;
  branchCount?: number;
  siblingIds?: string[];
}

export type CompanionBookScope =
  | { mode: "through" | "full" }
  | { mode: "chapters"; from: number; to: number };

export interface CompanionSession {
  id: string;
  title: string;
  personaId: string;
  activeGear: CompanionGear;
  boundWorldId: string | null;
  boundLineId: string | null;
  boundBookId: string | null;
  bookScope: CompanionBookScope | null;
  piSessionId: string | null;
  activeLeafId: string | null;
  activeRunId?: string | null;
  summaryText: string;
  summaryUpToMsgId: string | null;
  pinned: boolean;
  archived: boolean;
  legacyPi?: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CompanionMemory {
  id: string;
  scope: CompanionMemoryScope;
  personaId: string;
  category: CompanionMemoryCategory;
  content: string;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  enabled: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CompanionPiTaskSummary {
  id: string;
  text: string;
  status: string;
  policy: string;
  summary?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanionSessionDetail {
  session: CompanionSession;
  persona: CompanionPersona;
  messages: CompanionMessage[];
  piTasks: CompanionPiTaskSummary[];
  activeRunId?: string | null;
}

export interface CompanionRunSnapshot {
  runId: string;
  sessionId: string;
  messageId: string;
  seq: number;
  status: CompanionMessageStatus;
  phase: "thinking" | "searching" | "writing" | "done";
  content: string;
  thinking: string;
  steps: CompanionStep[];
  citations: CompanionCitation[];
  usage: CompanionUsage | null;
  errorText: string | null;
  done: boolean;
}

export interface CompanionStreamUpdate {
  status: CompanionMessageStatus;
  phase?: "thinking" | "searching" | "writing" | "done";
  text: string;
  thinking: string;
  steps: CompanionStep[];
  citations: CompanionCitation[];
  usage?: CompanionUsage | null;
  errorText?: string | null;
}

export interface CompanionHandle {
  done: Promise<CompanionRunSnapshot>;
  stop: () => void;
  detach: () => void;
}

export interface CompanionSendInput {
  sessionId: string;
  text?: string;
  gear?: "chat" | "research";
  bookScope?: CompanionBookScope | null;
  regenerateMessageId?: string | null;
  editMessageId?: string | null;
  parentId?: string | null;
}

export interface CompanionSendResult {
  runId: string;
  sessionId: string;
  userMessage: CompanionMessage | null;
  assistantMessage: CompanionMessage;
}

export interface CompanionHandoffInput {
  sessionId?: string;
  title?: string;
  personaId?: string;
  activeGear?: CompanionGear;
  boundWorldId?: string | null;
  boundLineId?: string | null;
  boundBookId?: string | null;
  bookScope?: CompanionBookScope | null;
  turns?: { q?: string; a?: string; user?: string; assistant?: string; citations?: CompanionCitation[] }[];
  messages?: { role: "user" | "assistant"; content: string; gear?: CompanionGear; citations?: CompanionCitation[] }[];
  metadata?: Record<string, unknown>;
}

export interface EscalateToAgentInput {
  sessionId: string;
  text: string;
  parentId?: string | null;
  policy?: AgentPolicy | "review";
  target?: { nodeId: string; paragraph?: number };
}

export interface GetOrCreateSessionInput {
  personaId?: string;
  activeGear?: CompanionGear;
  boundWorldId?: string | null;
  boundLineId?: string | null;
  boundBookId?: string | null;
  bookScope?: CompanionBookScope | null;
  worldId?: string | null;
  lineId?: string | null;
  bookId?: string | null;
  title?: string;
  withGreeting?: boolean;
}

export interface EscalateToAgentResult {
  piSessionId: string;
  taskId: string;
  runId: string;
  userMessage: CompanionMessage | null;
  agentMessage: CompanionMessage;
}

export const MEMORY_PROMPT_CHAR_CAP = 1200;
const CHAT_RECENT_MESSAGES = 16;
const CHAT_WINDOW_CHAR_BUDGET = 24_000;

const normalizePersonaId = (id: string) => (id === "lingxi" ? DEFAULT_PERSONA_ID : id);

const COMPANION_DDL: SqlStatement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS companion_personas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '',
      tagline TEXT NOT NULL DEFAULT '',
      role_kind TEXT NOT NULL DEFAULT 'assistant',
      system_prompt TEXT NOT NULL,
      greeting TEXT NOT NULL DEFAULT '',
      starters_json TEXT NOT NULL DEFAULT '[]',
      style_notes TEXT NOT NULL DEFAULT '',
      memory_scope TEXT NOT NULL DEFAULT 'persona',
      pure_roleplay INTEGER NOT NULL DEFAULT 0,
      source_world_id TEXT,
      source_person_id TEXT,
      source_head_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS companion_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      active_gear TEXT NOT NULL DEFAULT 'chat',
      bound_world_id TEXT,
      bound_line_id TEXT,
      bound_book_id TEXT,
      book_scope_json TEXT,
      pi_session_id TEXT,
      active_leaf_id TEXT,
      summary_text TEXT NOT NULL DEFAULT '',
      summary_up_to_msg_id TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
  { sql: "CREATE INDEX IF NOT EXISTS companion_sessions_updated ON companion_sessions(archived, pinned DESC, updated_at DESC)" },
  { sql: "CREATE INDEX IF NOT EXISTS companion_sessions_world ON companion_sessions(bound_world_id, updated_at DESC)" },
  { sql: "CREATE INDEX IF NOT EXISTS companion_sessions_pi ON companion_sessions(pi_session_id)" },
  {
    sql: `CREATE TABLE IF NOT EXISTS companion_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES companion_sessions(id) ON DELETE CASCADE,
      parent_id TEXT,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      gear TEXT NOT NULL DEFAULT 'chat',
      status TEXT NOT NULL DEFAULT 'done',
      content TEXT NOT NULL DEFAULT '',
      thinking TEXT NOT NULL DEFAULT '',
      steps_json TEXT NOT NULL DEFAULT '[]',
      citations_json TEXT NOT NULL DEFAULT '[]',
      pi_task_id TEXT,
      model_id TEXT NOT NULL DEFAULT '',
      usage_json TEXT,
      error_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
  { sql: "CREATE INDEX IF NOT EXISTS companion_messages_session_seq ON companion_messages(session_id, seq)" },
  { sql: "CREATE INDEX IF NOT EXISTS companion_messages_parent ON companion_messages(session_id, parent_id, seq)" },
  {
    sql: `CREATE TABLE IF NOT EXISTS companion_memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'persona',
      persona_id TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      source_session_id TEXT,
      source_message_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  },
  { sql: "CREATE INDEX IF NOT EXISTS companion_memories_lookup ON companion_memories(scope, persona_id, enabled, pinned DESC, updated_at DESC)" },
];

const initializedPlatforms = new WeakMap<Platform, Promise<void>>();

/** Idempotently creates `companion_*` tables without inserting any built-in rows. */
export async function ensureCompanionTables(repo: Repo): Promise<void> {
  let pending = initializedPlatforms.get(repo.platform);
  if (!pending) {
    pending = repo.platform.sql.batch(COMPANION_DDL).catch((err) => {
      initializedPlatforms.delete(repo.platform);
      throw err;
    });
    initializedPlatforms.set(repo.platform, pending);
  }
  await pending;
}

type CompanionRpcFn = (request: Json) => Promise<Json>;

function nativeCompanionRpc(platform: Platform): CompanionRpcFn | undefined {
  const exec = platform.execution as (Platform["execution"] & { companion?: CompanionRpcFn }) | undefined;
  return exec?.companion ? exec.companion.bind(exec) : undefined;
}

const nowIso = () => new Date().toISOString();

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToPersona(r: Record<string, unknown>): CompanionPersona & { boundLineId?: string | null } {
  const id = String(r.id);
  const builtin = isBuiltinPersonaId(id);
  const metadata = safeJson<Record<string, unknown>>(r.metadata_json, {});
  const boundLineId =
    typeof metadata.boundLineId === "string" && metadata.boundLineId.trim()
      ? metadata.boundLineId.trim()
      : undefined;
  return {
    id,
    name: String(r.name ?? ""),
    avatar: String(r.avatar ?? ""),
    tagline: String(r.tagline ?? ""),
    roleKind: String(r.role_kind ?? "assistant") as PersonaRoleKind,
    systemPrompt: String(r.system_prompt ?? ""),
    greeting: String(r.greeting ?? ""),
    starters: safeJson<string[]>(r.starters_json, []),
    styleNotes: String(r.style_notes ?? ""),
    memoryScope: String(r.memory_scope ?? "persona") as PersonaMemoryScope,
    pureRoleplay: Number(r.pure_roleplay) !== 0,
    sourceWorldId: r.source_world_id == null ? null : String(r.source_world_id),
    sourcePersonId: r.source_person_id == null ? null : String(r.source_person_id),
    sourceHeadId: r.source_head_id == null ? null : String(r.source_head_id),
    ...(boundLineId ? { boundLineId } : {}),
    sortOrder: Number(r.sort_order ?? 100),
    builtin,
    customized: builtin,
    metadata,
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

function rowToSession(r: Record<string, unknown>): CompanionSession {
  return {
    id: String(r.id),
    title: String(r.title ?? ""),
    personaId: String(r.persona_id ?? DEFAULT_PERSONA_ID),
    activeGear: String(r.active_gear ?? "chat") as CompanionGear,
    boundWorldId: r.bound_world_id == null ? null : String(r.bound_world_id),
    boundLineId: r.bound_line_id == null ? null : String(r.bound_line_id),
    boundBookId: r.bound_book_id == null ? null : String(r.bound_book_id),
    bookScope: r.book_scope_json ? safeJson<CompanionBookScope | null>(r.book_scope_json, null) : null,
    piSessionId: r.pi_session_id == null ? null : String(r.pi_session_id),
    activeLeafId: r.active_leaf_id == null ? null : String(r.active_leaf_id),
    summaryText: String(r.summary_text ?? ""),
    summaryUpToMsgId: r.summary_up_to_msg_id == null ? null : String(r.summary_up_to_msg_id),
    pinned: Number(r.pinned) !== 0,
    archived: Number(r.archived) !== 0,
    legacyPi: false,
    metadata: safeJson<Record<string, unknown>>(r.metadata_json, {}),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

function rowToMessage(r: Record<string, unknown>): CompanionMessage {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    parentId: r.parent_id == null ? null : String(r.parent_id),
    seq: Number(r.seq),
    role: String(r.role) as CompanionMessage["role"],
    gear: String(r.gear ?? "chat") as CompanionGear,
    status: String(r.status ?? "done") as CompanionMessageStatus,
    content: String(r.content ?? ""),
    thinking: String(r.thinking ?? ""),
    steps: safeJson<CompanionStep[]>(r.steps_json, []),
    citations: safeJson<CompanionCitation[]>(r.citations_json, []),
    piTaskId: r.pi_task_id == null ? null : String(r.pi_task_id),
    modelId: String(r.model_id ?? ""),
    usage: r.usage_json ? safeJson<CompanionUsage | null>(r.usage_json, null) : null,
    errorText: r.error_text == null ? null : String(r.error_text),
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

function rowToMemory(r: Record<string, unknown>): CompanionMemory {
  return {
    id: String(r.id),
    scope: String(r.scope ?? "persona") as CompanionMemoryScope,
    personaId: String(r.persona_id ?? ""),
    category: String(r.category ?? "fact") as CompanionMemoryCategory,
    content: String(r.content ?? ""),
    sourceSessionId: r.source_session_id == null ? null : String(r.source_session_id),
    sourceMessageId: r.source_message_id == null ? null : String(r.source_message_id),
    enabled: Number(r.enabled) !== 0,
    pinned: Number(r.pinned) !== 0,
    createdAt: String(r.created_at ?? ""),
    updatedAt: String(r.updated_at ?? ""),
  };
}

function projectBranch(all: CompanionMessage[], activeLeafId: string | null): { leafId: string | null; messages: CompanionMessage[] } {
  if (!all.length) return { leafId: null, messages: [] };
  const byId = new Map(all.map((m) => [m.id, m]));
  const children = new Map<string, CompanionMessage[]>();
  const parentKey = (pid: string | null) => pid ?? "__root__";
  for (const m of all) {
    const k = parentKey(m.parentId);
    const list = children.get(k) ?? [];
    list.push(m);
    children.set(k, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  }
  const leaf = (activeLeafId ? byId.get(activeLeafId) : undefined)
    ?? [...all].sort((a, b) => b.seq - a.seq || b.id.localeCompare(a.id))[0];
  const chain: CompanionMessage[] = [];
  const seen = new Set<string>();
  let cur: CompanionMessage | undefined = leaf;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();
  const messages = chain.map((node) => {
    const siblings = children.get(parentKey(node.parentId)) ?? [node];
    const siblingIds = siblings.map((s) => s.id);
    const branchIndex = Math.max(0, siblingIds.indexOf(node.id));
    const branchCount = siblingIds.length;
    return {
      ...node,
      branchIndex,
      branchCount,
      siblingIds,
      branch: {
        branchIndex,
        branchCount,
        siblingIds,
      },
    };
  });
  return { leafId: leaf.id, messages };
}

function resolveSubtreeLeaf(all: CompanionMessage[], targetId: string): string | null {
  if (!all.some((m) => m.id === targetId)) return null;
  const children = new Map<string, CompanionMessage[]>();
  for (const m of all) {
    if (!m.parentId) continue;
    const list = children.get(m.parentId) ?? [];
    list.push(m);
    children.set(m.parentId, list);
  }
  let cur = targetId;
  const visited = new Set<string>();
  while (!visited.has(cur)) {
    visited.add(cur);
    const list = children.get(cur);
    if (!list?.length) break;
    const latest = [...list].sort((a, b) => b.seq - a.seq || b.id.localeCompare(a.id))[0];
    cur = latest.id;
  }
  return cur;
}

interface FallbackRun {
  snapshot: CompanionRunSnapshot;
  cancel: () => void;
  listeners: Set<() => void>;
  donePromise: Promise<void>;
}

const fallbackRuns = new WeakMap<Platform, Map<string, FallbackRun>>();
function runsFor(platform: Platform): Map<string, FallbackRun> {
  let map = fallbackRuns.get(platform);
  if (!map) {
    map = new Map();
    fallbackRuns.set(platform, map);
  }
  return map;
}

function personaSnapshot(p: CompanionPersona): Record<string, unknown> {
  return {
    name: p.name,
    avatar: p.avatar,
    tagline: p.tagline,
    roleKind: p.roleKind,
    systemPrompt: p.systemPrompt,
    styleNotes: p.styleNotes,
    memoryScope: p.memoryScope,
    pureRoleplay: p.pureRoleplay,
  };
}

async function tableExists(repo: Repo, name: string): Promise<boolean> {
  const [row] = await repo.platform.sql.query(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?",
    [name],
  );
  return !!row;
}

export class CompanionClient {
  constructor(private readonly game: Game) {}

  private get repo(): Repo {
    return this.game.repo;
  }

  private get rpc(): CompanionRpcFn | undefined {
    return nativeCompanionRpc(this.game.platform);
  }

  private async callNative<T>(payload: Record<string, unknown>): Promise<T> {
    return (await this.rpc!(JSON.parse(JSON.stringify(payload)) as Json)) as unknown as T;
  }

  // ---------- Personas ----------

  async listPersonas(): Promise<CompanionPersona[]> {
    if (this.rpc) return (await this.callNative<{ personas: CompanionPersona[] }>({ op: "persona_list" })).personas;
    await ensureCompanionTables(this.repo);
    const rows = await this.repo.platform.sql.query(
      "SELECT * FROM companion_personas ORDER BY sort_order ASC, updated_at DESC, id ASC",
    );
    const overrides = new Map<string, CompanionPersona>();
    const customs: CompanionPersona[] = [];
    for (const r of rows) {
      const p = rowToPersona(r);
      if (isBuiltinPersonaId(p.id)) overrides.set(p.id, p);
      else customs.push(p);
    }
    const merged = [
      ...BUILTIN_PERSONAS.map((b) => overrides.get(b.id) ?? structuredClone(b)),
      ...customs,
    ];
    return merged.sort(
      (a, b) =>
        a.sortOrder - b.sortOrder
        || Number(!!b.builtin) - Number(!!a.builtin)
        || b.updatedAt.localeCompare(a.updatedAt)
        || a.id.localeCompare(b.id),
    );
  }

  async getPersona(rawId: string): Promise<CompanionPersona> {
    const id = normalizePersonaId(rawId);
    if (this.rpc) return (await this.callNative<{ persona: CompanionPersona }>({ op: "persona_get", id })).persona;
    await ensureCompanionTables(this.repo);
    const [row] = await this.repo.platform.sql.query("SELECT * FROM companion_personas WHERE id=?", [id]);
    if (row) return rowToPersona(row);
    const builtin = getBuiltinPersona(id);
    if (builtin) return builtin;
    throw new Error("找不到这张人格卡。");
  }

  private async resolvePersona(rawId: string, snapshot?: unknown): Promise<CompanionPersona> {
    const id = normalizePersonaId(rawId);
    try {
      return await this.getPersona(id);
    } catch {
      if (snapshot && typeof snapshot === "object") {
        const s = snapshot as Record<string, unknown>;
        if (typeof s.name === "string") {
          return {
            id,
            name: s.name,
            avatar: typeof s.avatar === "string" ? s.avatar : "伴",
            tagline: typeof s.tagline === "string" ? s.tagline : "",
            roleKind: (s.roleKind as PersonaRoleKind) ?? "assistant",
            systemPrompt: typeof s.systemPrompt === "string" ? s.systemPrompt : "请自然友好地与用户对话。",
            greeting: "",
            starters: [],
            styleNotes: typeof s.styleNotes === "string" ? s.styleNotes : "",
            memoryScope: (s.memoryScope as PersonaMemoryScope) ?? "persona",
            pureRoleplay: !!s.pureRoleplay,
            sortOrder: 999,
            builtin: false,
            customized: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          };
        }
      }
      return getBuiltinPersona(DEFAULT_PERSONA_ID)!;
    }
  }

  async savePersona(
    input: Partial<CompanionPersona> & Pick<CompanionPersona, "name" | "systemPrompt"> & { boundLineId?: string | null },
  ): Promise<CompanionPersona & { boundLineId?: string | null }> {
    if (this.rpc) return (await this.callNative<{ persona: CompanionPersona & { boundLineId?: string | null } }>({ op: "persona_save", persona: input })).persona;
    await ensureCompanionTables(this.repo);
    const name = input.name.trim();
    if (!name || name.length > 64) throw new Error("请填写 1～64 字的人格名称。");
    const systemPrompt = input.systemPrompt.trim();
    if (!systemPrompt || systemPrompt.length > 24_000) throw new Error("请填写人格设定提示词（最多 24,000 字）。");
    const roleKind: PersonaRoleKind = input.roleKind ?? "assistant";
    if (!["assistant", "advisor", "roleplay", "npc"].includes(roleKind)) throw new Error("人格类型无效。");
    const memoryScope: PersonaMemoryScope = input.memoryScope ?? "persona";
    if (!["persona", "global", "off"].includes(memoryScope)) throw new Error("记忆范围无效。");
    const id = input.id?.trim() ? normalizePersonaId(input.id.trim()) : `persona:${newId()}`;
    if (id.startsWith("builtin:") && !isBuiltinPersonaId(id)) {
      throw new Error("不能新建 builtin: 前缀的人格标识。");
    }
    const avatar = (input.avatar?.trim() || name.slice(0, 1) || "伴").slice(0, 8);
    const starters = (input.starters ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 8);
    const pureRoleplay = input.pureRoleplay ?? (roleKind === "roleplay" || roleKind === "npc");
    const now = nowIso();
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
    if (typeof input.boundLineId === "string" && input.boundLineId.trim()) {
      metadata.boundLineId = input.boundLineId.trim();
    }
    const [existing] = await this.repo.platform.sql.query("SELECT created_at FROM companion_personas WHERE id=?", [id]);
    const createdAt = existing ? String(existing.created_at) : now;
    await this.repo.platform.sql.batch([
      {
        sql: `INSERT INTO companion_personas(
                id,name,avatar,tagline,role_kind,system_prompt,greeting,starters_json,style_notes,
                memory_scope,pure_roleplay,source_world_id,source_person_id,source_head_id,
                sort_order,metadata_json,created_at,updated_at
              ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, avatar=excluded.avatar, tagline=excluded.tagline,
                role_kind=excluded.role_kind, system_prompt=excluded.system_prompt,
                greeting=excluded.greeting, starters_json=excluded.starters_json,
                style_notes=excluded.style_notes, memory_scope=excluded.memory_scope,
                pure_roleplay=excluded.pure_roleplay, source_world_id=excluded.source_world_id,
                source_person_id=excluded.source_person_id, source_head_id=excluded.source_head_id,
                sort_order=excluded.sort_order, metadata_json=excluded.metadata_json,
                updated_at=excluded.updated_at`,
        params: [
          id,
          name,
          avatar,
          (input.tagline ?? "").trim().slice(0, 160),
          roleKind,
          systemPrompt,
          (input.greeting ?? "").trim().slice(0, 2000),
          JSON.stringify(starters),
          (input.styleNotes ?? "").trim().slice(0, 2000),
          memoryScope,
          pureRoleplay ? 1 : 0,
          input.sourceWorldId ?? null,
          input.sourcePersonId ?? null,
          input.sourceHeadId ?? null,
          input.sortOrder ?? 100,
          JSON.stringify(metadata),
          createdAt,
          now,
        ],
      },
    ]);
    return this.getPersona(id);
  }

  async deletePersona(rawId: string): Promise<{ id: string; deleted: boolean; resetBuiltin: boolean }> {
    const id = normalizePersonaId(rawId);
    if (this.rpc) return this.callNative({ op: "persona_delete", id });
    await ensureCompanionTables(this.repo);
    const [existing] = await this.repo.platform.sql.query("SELECT 1 AS ok FROM companion_personas WHERE id=?", [id]);
    const statements: SqlStatement[] = [{ sql: "DELETE FROM companion_personas WHERE id=?", params: [id] }];
    if (!isBuiltinPersonaId(id)) {
      statements.push({ sql: "DELETE FROM companion_memories WHERE scope='persona' AND persona_id=?", params: [id] });
    }
    await this.repo.platform.sql.batch(statements);
    if (isBuiltinPersonaId(id)) return { id, deleted: false, resetBuiltin: !!existing };
    return { id, deleted: !!existing, resetBuiltin: false };
  }

  async importPersona(raw: string | unknown): Promise<CompanionPersona> {
    if (this.rpc) return (await this.callNative<{ persona: CompanionPersona }>({ op: "persona_import", raw })).persona;
    const draft = parsePersonaJson(raw);
    return this.savePersona(draft);
  }

  // ---------- Memories ----------

  async listMemories(opts: { personaId?: string; scope?: CompanionMemoryScope | "all"; includeDisabled?: boolean } = {}): Promise<CompanionMemory[]> {
    const cleanPid = opts.personaId ? normalizePersonaId(opts.personaId) : undefined;
    if (this.rpc) {
      return (
        await this.callNative<{ memories: CompanionMemory[] }>({
          op: "memory_list",
          personaId: cleanPid,
          scope: opts.scope,
          includeDisabled: opts.includeDisabled ?? true,
        })
      ).memories;
    }
    await ensureCompanionTables(this.repo);
    const clauses = ["1=1"];
    const params: Json[] = [];
    if (opts.includeDisabled === false) clauses.push("enabled=1");
    if (opts.scope === "global") {
      clauses.push("scope='global'");
    } else if (opts.scope === "persona") {
      clauses.push("scope='persona'");
      if (cleanPid) {
        clauses.push("persona_id=?");
        params.push(cleanPid);
      }
    } else if (cleanPid) {
      clauses.push("(scope='global' OR (scope='persona' AND persona_id=?))");
      params.push(cleanPid);
    }
    const rows = await this.repo.platform.sql.query(
      `SELECT * FROM companion_memories WHERE ${clauses.join(" AND ")} ORDER BY pinned DESC, updated_at DESC, id ASC LIMIT 200`,
      params,
    );
    return rows.map(rowToMemory);
  }

  async activeMemoriesForPersona(rawPersonaId: string, memoryScope: PersonaMemoryScope = "persona"): Promise<CompanionMemory[]> {
    await ensureCompanionTables(this.repo);
    if (memoryScope === "off") return [];
    const personaId = normalizePersonaId(rawPersonaId);
    const rows = await this.repo.platform.sql.query(
      "SELECT * FROM companion_memories WHERE enabled=1 AND (scope='global' OR (scope='persona' AND persona_id=?)) ORDER BY pinned DESC, updated_at DESC, id ASC LIMIT 64",
      [personaId],
    );
    const out: CompanionMemory[] = [];
    let used = 0;
    for (const r of rows) {
      const m = rowToMemory(r);
      const content = m.content.trim();
      if (!content) continue;
      const len = content.length + 8;
      if (out.length > 0 && used + len > MEMORY_PROMPT_CHAR_CAP) continue;
      if (out.length === 0 && len > MEMORY_PROMPT_CHAR_CAP) {
        out.push({ ...m, content: content.slice(0, MEMORY_PROMPT_CHAR_CAP - 8) });
        break;
      }
      used += len;
      out.push(m);
    }
    return out;
  }

  async saveMemory(input: {
    id?: string;
    scope?: CompanionMemoryScope;
    personaId?: string;
    category?: CompanionMemoryCategory;
    content: string;
    sourceSessionId?: string | null;
    sourceMessageId?: string | null;
    enabled?: boolean;
    pinned?: boolean;
  }): Promise<CompanionMemory> {
    if (this.rpc) return (await this.callNative<{ memory: CompanionMemory }>({ op: "memory_save", memory: input })).memory;
    await ensureCompanionTables(this.repo);
    const content = input.content.trim();
    if (!content || content.length > 1000) throw new Error("记忆内容请控制在 1～1000 字以内。");
    const scope: CompanionMemoryScope = input.scope ?? "persona";
    const personaId = scope === "global" ? "" : normalizePersonaId((input.personaId ?? "").trim());
    if (scope === "persona" && !personaId) throw new Error("专属记忆需要指定所属人格。");
    const category: CompanionMemoryCategory = input.category ?? "fact";
    const id = input.id?.trim() || newId();
    const now = nowIso();
    const [existing] = await this.repo.platform.sql.query("SELECT created_at FROM companion_memories WHERE id=?", [id]);
    const createdAt = existing ? String(existing.created_at) : now;
    await this.repo.platform.sql.batch([
      {
        sql: `INSERT INTO companion_memories(
                id,scope,persona_id,category,content,source_session_id,source_message_id,
                enabled,pinned,created_at,updated_at
              ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET
                scope=excluded.scope, persona_id=excluded.persona_id, category=excluded.category,
                content=excluded.content, enabled=excluded.enabled, pinned=excluded.pinned,
                updated_at=excluded.updated_at`,
        params: [
          id,
          scope,
          personaId,
          category,
          content,
          input.sourceSessionId ?? null,
          input.sourceMessageId ?? null,
          (input.enabled ?? true) ? 1 : 0,
          (input.pinned ?? false) ? 1 : 0,
          createdAt,
          now,
        ],
      },
    ]);
    const [saved] = await this.repo.platform.sql.query("SELECT * FROM companion_memories WHERE id=?", [id]);
    return rowToMemory(saved);
  }

  async toggleMemory(id: string, patch: { enabled?: boolean; pinned?: boolean }): Promise<CompanionMemory> {
    if (this.rpc) return (await this.callNative<{ memory: CompanionMemory }>({ op: "memory_toggle", id, ...patch })).memory;
    await ensureCompanionTables(this.repo);
    const [cur] = await this.repo.platform.sql.query("SELECT * FROM companion_memories WHERE id=?", [id]);
    if (!cur) throw new Error("找不到这条记忆。");
    const nextEnabled = patch.enabled ?? Number(cur.enabled) !== 0;
    const nextPinned = patch.pinned ?? Number(cur.pinned) !== 0;
    await this.repo.platform.sql.batch([
      {
        sql: "UPDATE companion_memories SET enabled=?, pinned=?, updated_at=? WHERE id=?",
        params: [nextEnabled ? 1 : 0, nextPinned ? 1 : 0, nowIso(), id],
      },
    ]);
    const [saved] = await this.repo.platform.sql.query("SELECT * FROM companion_memories WHERE id=?", [id]);
    return rowToMemory(saved);
  }

  async deleteMemory(id: string): Promise<{ id: string; deleted: boolean }> {
    if (this.rpc) return this.callNative({ op: "memory_delete", id });
    await ensureCompanionTables(this.repo);
    const [cur] = await this.repo.platform.sql.query("SELECT 1 AS ok FROM companion_memories WHERE id=?", [id]);
    await this.repo.platform.sql.batch([{ sql: "DELETE FROM companion_memories WHERE id=?", params: [id] }]);
    return { id, deleted: !!cur };
  }

  // ---------- Sessions & Tree Messages ----------

  async listSessions(opts: {
    worldId?: string | null;
    includeArchived?: boolean;
    query?: string;
    offset?: number;
    limit?: number;
  } = {}): Promise<{ sessions: CompanionSession[]; nextOffset: number | null }> {
    if (this.rpc) {
      return this.callNative({
        op: "session_list",
        ...(opts.worldId ? { worldId: opts.worldId } : {}),
        includeArchived: !!opts.includeArchived,
        query: opts.query ?? "",
        offset: opts.offset ?? 0,
        limit: opts.limit ?? 40,
      });
    }
    await ensureCompanionTables(this.repo);
    const clauses = [opts.includeArchived ? "1=1" : "archived=0"];
    const params: Json[] = [];
    if (opts.worldId) {
      clauses.push("bound_world_id=?");
      params.push(opts.worldId);
    }
    const rows = await this.repo.platform.sql.query(
      `SELECT * FROM companion_sessions WHERE ${clauses.join(" AND ")}`,
      params,
    );
    let items = rows.map(rowToSession);

    if (await tableExists(this.repo, "pi_sessions")) {
      const piRows = await this.repo.platform.sql.query(
        `SELECT p.* FROM pi_sessions p
         WHERE (? IS NULL OR p.world_id=?)
           AND NOT EXISTS (SELECT 1 FROM companion_sessions c WHERE c.pi_session_id=p.id)`,
        [opts.worldId ?? null, opts.worldId ?? null],
      );
      for (const p of piRows) {
        const pid = String(p.id);
        items.push({
          id: `pi:${pid}`,
          title: String(p.title ?? "旧助手会话"),
          personaId: DEFAULT_PERSONA_ID,
          activeGear: "agent",
          boundWorldId: String(p.world_id ?? ""),
          boundLineId: String(p.line_id ?? ""),
          boundBookId: null,
          bookScope: null,
          piSessionId: pid,
          activeLeafId: null,
          summaryText: "",
          summaryUpToMsgId: null,
          pinned: false,
          archived: false,
          legacyPi: true,
          metadata: {},
          createdAt: String(p.created_at ?? ""),
          updatedAt: String(p.updated_at ?? ""),
        });
      }
    }

    const q = (opts.query ?? "").trim().toLowerCase();
    if (q) {
      const matched: CompanionSession[] = [];
      for (const s of items) {
        if (s.title.toLowerCase().includes(q)) {
          matched.push(s);
          continue;
        }
        const hits = await this.repo.platform.sql.query(
          "SELECT 1 AS ok FROM companion_messages WHERE session_id=? AND instr(lower(content), ?)>0 LIMIT 1",
          [s.id, q],
        );
        if (hits.length) matched.push(s);
      }
      items = matched;
    }

    items.sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned)
        || b.updatedAt.localeCompare(a.updatedAt)
        || a.id.localeCompare(b.id),
    );
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 40));
    const page = items.slice(offset, offset + limit);
    const next = offset + page.length;
    return { sessions: page, nextOffset: next < items.length ? next : null };
  }

  private async ensureMaterializedSession(id: string): Promise<string> {
    await ensureCompanionTables(this.repo);
    const [direct] = await this.repo.platform.sql.query("SELECT id FROM companion_sessions WHERE id=?", [id]);
    if (direct) return String(direct.id);
    if (id.startsWith("pi:")) {
      const piId = id.slice(3);
      const [linked] = await this.repo.platform.sql.query(
        "SELECT id FROM companion_sessions WHERE pi_session_id=? LIMIT 1",
        [piId],
      );
      if (linked) return String(linked.id);
      if (await tableExists(this.repo, "pi_sessions")) {
        const [piRow] = await this.repo.platform.sql.query("SELECT * FROM pi_sessions WHERE id=?", [piId]);
        if (piRow) {
          const persona = getBuiltinPersona(DEFAULT_PERSONA_ID)!;
          await this.repo.platform.sql.batch([
            {
              sql: `INSERT INTO companion_sessions(
                      id,title,persona_id,active_gear,bound_world_id,bound_line_id,pi_session_id,
                      metadata_json,created_at,updated_at
                    ) VALUES(?,?,?,'agent',?,?,?, ?,?,?)`,
              params: [
                id,
                String(piRow.title ?? "旧助手会话"),
                DEFAULT_PERSONA_ID,
                String(piRow.world_id),
                String(piRow.line_id),
                piId,
                JSON.stringify({ personaSnapshot: personaSnapshot(persona), legacyPi: true }),
                String(piRow.created_at),
                String(piRow.updated_at),
              ],
            },
          ]);
          return id;
        }
      }
    }
    throw new Error("找不到这段伴聊会话。");
  }

  async getSessionDetail(id: string): Promise<CompanionSessionDetail> {
    if (this.rpc) {
      const detail = await this.callNative<CompanionSessionDetail>({ op: "session_detail", id });
      const runId = detail.activeRunId ?? detail.session?.activeRunId ?? null;
      return {
        ...detail,
        activeRunId: runId,
        session: { ...detail.session, activeRunId: runId },
      };
    }
    await ensureCompanionTables(this.repo);
    let session: CompanionSession | null = null;
    const [direct] = await this.repo.platform.sql.query("SELECT * FROM companion_sessions WHERE id=?", [id]);
    if (direct) {
      session = rowToSession(direct);
    } else if (id.startsWith("pi:")) {
      const piId = id.slice(3);
      const [linked] = await this.repo.platform.sql.query(
        "SELECT * FROM companion_sessions WHERE pi_session_id=? ORDER BY updated_at DESC LIMIT 1",
        [piId],
      );
      if (linked) {
        session = rowToSession(linked);
      } else if (await tableExists(this.repo, "pi_sessions")) {
        const [piRow] = await this.repo.platform.sql.query("SELECT * FROM pi_sessions WHERE id=?", [piId]);
        if (piRow) {
          session = {
            id: `pi:${piId}`,
            title: String(piRow.title ?? "旧助手会话"),
            personaId: DEFAULT_PERSONA_ID,
            activeGear: "agent",
            boundWorldId: String(piRow.world_id ?? ""),
            boundLineId: String(piRow.line_id ?? ""),
            boundBookId: null,
            bookScope: null,
            piSessionId: piId,
            activeLeafId: null,
            activeRunId: null,
            summaryText: "",
            summaryUpToMsgId: null,
            pinned: false,
            archived: false,
            legacyPi: true,
            metadata: {},
            createdAt: String(piRow.created_at ?? ""),
            updatedAt: String(piRow.updated_at ?? ""),
          };
        }
      }
    }
    if (!session) throw new Error("找不到这段伴聊会话。");

    const activeRun = [...runsFor(this.game.platform).values()].find(
      (r) => r.snapshot.sessionId === session!.id && !r.snapshot.done,
    );
    const activeRunId = activeRun?.snapshot.runId ?? null;

    const persona = await this.resolvePersona(session.personaId, session.metadata.personaSnapshot);
    const msgRows = await this.repo.platform.sql.query(
      "SELECT * FROM companion_messages WHERE session_id=? ORDER BY seq ASC, id ASC",
      [session.id],
    );
    const all = msgRows.map(rowToMessage);

    // Self-heal orphan `streaming` messages and stale `activeRunId` metadata when no run is active:
    const healStatements: SqlStatement[] = [];
    const now = nowIso();
    for (let i = 0; i < all.length; i++) {
      const m = all[i];
      if (m.status === "streaming" && m.id !== activeRunId) {
        const healedSteps: CompanionStep[] = m.steps.map((s) =>
          s.status === "running"
            ? { ...s, status: "failed", summary: s.summary === "正在查阅…" ? "已中断" : s.summary }
            : s,
        );
        all[i] = { ...m, status: "interrupted", steps: healedSteps, updatedAt: now };
        healStatements.push({
          sql: "UPDATE companion_messages SET status='interrupted', steps_json=?, updated_at=? WHERE id=? AND status='streaming'",
          params: [JSON.stringify(healedSteps), now, m.id],
        });
      }
    }
    if (!activeRunId && ("activeRunId" in session.metadata || "active_run_id" in session.metadata)) {
      const nextMeta = { ...session.metadata };
      delete nextMeta.activeRunId;
      delete nextMeta.active_run_id;
      session = { ...session, metadata: nextMeta, updatedAt: now };
      healStatements.push({
        sql: "UPDATE companion_sessions SET metadata_json=?, updated_at=? WHERE id=?",
        params: [JSON.stringify(nextMeta), now, session.id],
      });
    }
    if (healStatements.length > 0) {
      await this.repo.platform.sql.batch(healStatements).catch(() => {});
    }

    const { leafId, messages } = projectBranch(all, session.activeLeafId);
    session = {
      ...session,
      ...(!session.activeLeafId && leafId ? { activeLeafId: leafId } : {}),
      activeRunId,
    };

    let piTasks: CompanionPiTaskSummary[] = [];
    if (session.piSessionId && (await tableExists(this.repo, "pi_tasks"))) {
      const tRows = await this.repo.platform.sql.query(
        "SELECT id,text,status,policy,result_json,error,created_at,updated_at FROM pi_tasks WHERE session_id=? ORDER BY created_at ASC, id ASC LIMIT 50",
        [session.piSessionId],
      );
      piTasks = tRows.map((t) => {
        const res = safeJson<{ summary?: string } | null>(t.result_json, null);
        return {
          id: String(t.id),
          text: String(t.text ?? ""),
          status: String(t.status ?? ""),
          policy: String(t.policy ?? "preview"),
          summary: res?.summary ?? null,
          error: t.error == null ? null : String(t.error),
          createdAt: String(t.created_at ?? ""),
          updatedAt: String(t.updated_at ?? ""),
        };
      });
    }
    return {
      session,
      persona,
      messages,
      piTasks,
      activeRunId,
    };
  }

  async getOrCreateSession(input: GetOrCreateSessionInput = {}): Promise<CompanionSessionDetail> {
    const cleanPid = input.personaId?.trim() ? normalizePersonaId(input.personaId.trim()) : undefined;
    const persona = cleanPid
      ? ((await this.resolvePersona(cleanPid)) as CompanionPersona & { boundLineId?: string | null })
      : null;
    const isNpc = Boolean(persona?.roleKind === "npc" || cleanPid?.startsWith("npc:"));
    const worldId = input.boundWorldId ?? input.worldId ?? persona?.sourceWorldId ?? null;
    const personaLineId =
      persona?.boundLineId ??
      (typeof persona?.metadata?.boundLineId === "string" && persona.metadata.boundLineId.trim()
        ? persona.metadata.boundLineId.trim()
        : null);
    let lineId = input.boundLineId ?? input.lineId ?? personaLineId ?? null;
    if (worldId && !lineId) {
      const w = await this.repo.getWorld(worldId).catch(() => null);
      lineId = w?.currentLineId || (isNpc ? "main" : null);
    }
    const bookId = input.boundBookId ?? input.bookId ?? null;
    const strictLineScope =
      isNpc || input.boundLineId !== undefined || input.lineId !== undefined || Boolean(personaLineId);

    const { sessions } = await this.listSessions({ worldId: worldId ?? undefined, limit: 100 });
    const matching = sessions.find((s) => {
      if (s.legacyPi && input.activeGear !== "agent") return false;
      if (cleanPid && normalizePersonaId(s.personaId) !== cleanPid) return false;
      if (worldId) {
        if (s.boundWorldId !== worldId) return false;
        if (strictLineScope) {
          const targetLine = lineId || "main";
          const sLine = s.boundLineId || "main";
          if (sLine !== targetLine) return false;
        }
        return true;
      }
      if (bookId) return !s.boundWorldId && s.boundBookId === bookId;
      return !s.boundWorldId && !s.boundBookId && s.activeGear !== "agent" && !s.legacyPi;
    });

    if (matching) {
      const patch: Parameters<CompanionClient["updateSession"]>[1] = {};
      if (input.activeGear && matching.activeGear !== input.activeGear) {
        patch.activeGear = input.activeGear;
      }
      if (strictLineScope && lineId && matching.boundLineId !== lineId) {
        patch.boundLineId = lineId;
      }
      if (Object.keys(patch).length > 0) {
        await this.updateSession(matching.id, patch);
      }
      return this.getSessionDetail(matching.id);
    }

    return this.createSession({
      title: input.title,
      personaId: cleanPid ?? DEFAULT_PERSONA_ID,
      activeGear: input.activeGear ?? (bookId && !worldId ? "research" : "chat"),
      boundWorldId: worldId,
      boundLineId: lineId,
      boundBookId: bookId,
      bookScope: input.bookScope ?? null,
      withGreeting: input.withGreeting,
    });
  }

  async createSession(input: {
    id?: string;
    title?: string;
    personaId?: string;
    activeGear?: CompanionGear;
    boundWorldId?: string | null;
    boundLineId?: string | null;
    boundBookId?: string | null;
    bookScope?: CompanionBookScope | null;
    piSessionId?: string | null;
    metadata?: Record<string, unknown>;
    withGreeting?: boolean;
  } = {}): Promise<CompanionSessionDetail> {
    if (this.rpc) return this.callNative({ op: "session_create", ...input });
    await ensureCompanionTables(this.repo);
    const id = input.id?.trim() || newId();
    const personaId = normalizePersonaId(input.personaId?.trim() || DEFAULT_PERSONA_ID);
    const persona = await this.resolvePersona(personaId);
    const activeGear: CompanionGear = input.activeGear ?? "chat";
    const title = (input.title?.trim() || `与${persona.name}的对话`).slice(0, 120);
    const now = nowIso();
    const metadata = { ...(input.metadata ?? {}), personaSnapshot: personaSnapshot(persona) };
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO companion_sessions(
                id,title,persona_id,active_gear,bound_world_id,bound_line_id,bound_book_id,
                book_scope_json,pi_session_id,active_leaf_id,summary_text,summary_up_to_msg_id,
                pinned,archived,metadata_json,created_at,updated_at
              ) VALUES(?,?,?,?,?,?,?,?,?,NULL,'',NULL,0,0,?,?,?)`,
        params: [
          id,
          title,
          personaId,
          activeGear,
          input.boundWorldId ?? null,
          input.boundLineId ?? null,
          input.boundBookId ?? null,
          input.bookScope ? JSON.stringify(input.bookScope) : null,
          input.piSessionId ?? null,
          JSON.stringify(metadata),
          now,
          now,
        ],
      },
    ];
    if (input.withGreeting && persona.greeting.trim()) {
      const mid = newId();
      statements.push(
        {
          sql: `INSERT INTO companion_messages(
                  id,session_id,parent_id,seq,role,gear,status,content,thinking,steps_json,
                  citations_json,created_at,updated_at
                ) VALUES(?,?,NULL,1,'assistant','chat','done',?,'','[]','[]',?,?)`,
          params: [mid, id, persona.greeting.trim(), now, now],
        },
        {
          sql: "UPDATE companion_sessions SET active_leaf_id=? WHERE id=?",
          params: [mid, id],
        },
      );
    }
    await this.repo.platform.sql.batch(statements);
    return this.getSessionDetail(id);
  }

  async updateSession(
    id: string,
    patch: Partial<{
      title: string;
      personaId: string;
      activeGear: CompanionGear;
      boundWorldId: string | null;
      boundLineId: string | null;
      boundBookId: string | null;
      bookScope: CompanionBookScope | null;
      piSessionId: string | null;
      activeLeafId: string | null;
      summaryText: string;
      summaryUpToMsgId: string | null;
      pinned: boolean;
      archived: boolean;
      metadata: Record<string, unknown>;
    }>,
  ): Promise<CompanionSession> {
    if (this.rpc) return (await this.callNative<{ session: CompanionSession }>({ op: "session_update", id, ...patch })).session;
    const realId = await this.ensureMaterializedSession(id);
    const cur = (await this.getSessionDetail(realId)).session;
    const nextPersonaId = patch.personaId?.trim() ? normalizePersonaId(patch.personaId.trim()) : cur.personaId;
    const nextMeta = { ...cur.metadata, ...(patch.metadata ?? {}) };
    if (patch.personaId && nextPersonaId !== cur.personaId) {
      nextMeta.personaSnapshot = personaSnapshot(await this.resolvePersona(nextPersonaId));
    }
    const nextTitle = patch.title !== undefined ? patch.title.trim().slice(0, 120) : cur.title;
    if (!nextTitle) throw new Error("会话标题不能为空。");
    const bookScope = patch.bookScope !== undefined ? patch.bookScope : cur.bookScope;
    let nextActiveLeafId = cur.activeLeafId;
    if (patch.activeLeafId !== undefined) {
      if (patch.activeLeafId) {
        const msgRows = await this.repo.platform.sql.query(
          "SELECT * FROM companion_messages WHERE session_id=? ORDER BY seq ASC, id ASC",
          [realId],
        );
        nextActiveLeafId = resolveSubtreeLeaf(msgRows.map(rowToMessage), patch.activeLeafId) ?? patch.activeLeafId;
      } else {
        nextActiveLeafId = null;
      }
    }
    await this.repo.platform.sql.batch([
      {
        sql: `UPDATE companion_sessions SET
                title=?, persona_id=?, active_gear=?, bound_world_id=?, bound_line_id=?,
                bound_book_id=?, book_scope_json=?, pi_session_id=?, active_leaf_id=?,
                summary_text=?, summary_up_to_msg_id=?, pinned=?, archived=?, metadata_json=?, updated_at=?
              WHERE id=?`,
        params: [
          nextTitle,
          nextPersonaId,
          patch.activeGear ?? cur.activeGear,
          patch.boundWorldId !== undefined ? patch.boundWorldId : cur.boundWorldId,
          patch.boundLineId !== undefined ? patch.boundLineId : cur.boundLineId,
          patch.boundBookId !== undefined ? patch.boundBookId : cur.boundBookId,
          bookScope ? JSON.stringify(bookScope) : null,
          patch.piSessionId !== undefined ? patch.piSessionId : cur.piSessionId,
          nextActiveLeafId,
          patch.summaryText !== undefined ? patch.summaryText : cur.summaryText,
          patch.summaryUpToMsgId !== undefined ? patch.summaryUpToMsgId : cur.summaryUpToMsgId,
          (patch.pinned ?? cur.pinned) ? 1 : 0,
          (patch.archived ?? cur.archived) ? 1 : 0,
          JSON.stringify(nextMeta),
          nowIso(),
          realId,
        ],
      },
    ]);
    return (await this.getSessionDetail(realId)).session;
  }

  async switchBranch(sessionId: string, messageId: string): Promise<CompanionSessionDetail> {
    if (this.rpc) return this.callNative({ op: "session_switch_branch", sessionId, messageId });
    const realId = await this.ensureMaterializedSession(sessionId);
    const rows = await this.repo.platform.sql.query(
      "SELECT * FROM companion_messages WHERE session_id=? ORDER BY seq ASC, id ASC",
      [realId],
    );
    const leaf = resolveSubtreeLeaf(rows.map(rowToMessage), messageId);
    if (!leaf) throw new Error("找不到要切换的消息分支。");
    await this.repo.platform.sql.batch([
      { sql: "UPDATE companion_sessions SET active_leaf_id=?, updated_at=? WHERE id=?", params: [leaf, nowIso(), realId] },
    ]);
    return this.getSessionDetail(realId);
  }

  async deleteSession(id: string): Promise<{ id: string; deleted: boolean }> {
    if (this.rpc) return this.callNative({ op: "session_delete", id });
    await ensureCompanionTables(this.repo);
    const statements: SqlStatement[] = [{ sql: "DELETE FROM companion_sessions WHERE id=?", params: [id] }];
    if (id.startsWith("pi:")) {
      const piId = id.slice(3);
      statements.push({ sql: "DELETE FROM companion_sessions WHERE pi_session_id=?", params: [piId] });
      if (await tableExists(this.repo, "pi_sessions")) {
        statements.push({ sql: "DELETE FROM pi_sessions WHERE id=?", params: [piId] });
      }
    }
    await this.repo.platform.sql.batch(statements);
    return { id, deleted: true };
  }

  async appendMessage(
    sessionId: string,
    message: {
      id?: string;
      parentId?: string | null;
      role: "user" | "assistant" | "system" | "system_note";
      gear?: CompanionGear;
      status?: CompanionMessageStatus;
      content: string;
      thinking?: string;
      steps?: CompanionStep[];
      citations?: CompanionCitation[];
      piTaskId?: string | null;
      modelId?: string;
      usage?: CompanionUsage | null;
      errorText?: string | null;
    },
  ): Promise<{ message: CompanionMessage; session: CompanionSession }> {
    if (this.rpc) return this.callNative({ op: "message_append", sessionId, message });
    const realId = await this.ensureMaterializedSession(sessionId);
    const [sessRow] = await this.repo.platform.sql.query("SELECT * FROM companion_sessions WHERE id=?", [realId]);
    const curSession = rowToSession(sessRow);
    const parentId = message.parentId !== undefined ? message.parentId : curSession.activeLeafId;
    if (parentId) {
      const [ok] = await this.repo.platform.sql.query(
        "SELECT 1 AS ok FROM companion_messages WHERE id=? AND session_id=?",
        [parentId, realId],
      );
      if (!ok) throw new Error("父消息不属于当前会话。");
    }
    const [seqRow] = await this.repo.platform.sql.query(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM companion_messages WHERE session_id=?",
      [realId],
    );
    const id = message.id?.trim() || newId();
    const seq = Number(seqRow?.seq ?? 1);
    const gear = message.gear ?? "chat";
    const status = message.status ?? "done";
    const now = nowIso();
    await this.repo.platform.sql.batch([
      {
        sql: `INSERT INTO companion_messages(
                id,session_id,parent_id,seq,role,gear,status,content,thinking,steps_json,
                citations_json,pi_task_id,model_id,usage_json,error_text,created_at,updated_at
              ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?)`,
        params: [
          id,
          realId,
          parentId,
          seq,
          message.role,
          gear,
          status,
          message.content,
          message.thinking ?? "",
          JSON.stringify(message.steps ?? []),
          JSON.stringify(message.citations ?? []),
          message.piTaskId ?? null,
          message.modelId ?? "",
          message.usage ? JSON.stringify(message.usage) : null,
          message.errorText ?? null,
          now,
          now,
        ],
      },
      {
        sql: "UPDATE companion_sessions SET active_leaf_id=?, active_gear=?, updated_at=? WHERE id=?",
        params: [id, gear, now, realId],
      },
    ]);
    const [savedMsg] = await this.repo.platform.sql.query("SELECT * FROM companion_messages WHERE id=?", [id]);
    const [savedSess] = await this.repo.platform.sql.query("SELECT * FROM companion_sessions WHERE id=?", [realId]);
    return { message: rowToMessage(savedMsg), session: rowToSession(savedSess) };
  }

  async importHandoff(input: CompanionHandoffInput): Promise<CompanionSessionDetail> {
    if (this.rpc) return this.callNative({ op: "import_handoff", ...input });
    const items: { role: "user" | "assistant"; content: string; gear: CompanionGear; citations: CompanionCitation[] }[] = [];
    for (const t of input.turns ?? []) {
      const q = (t.q ?? t.user ?? "").trim();
      const a = (t.a ?? t.assistant ?? "").trim();
      if (q) items.push({ role: "user", content: q, gear: "research", citations: [] });
      if (a) items.push({ role: "assistant", content: a, gear: "research", citations: t.citations ?? [] });
    }
    for (const m of input.messages ?? []) {
      if (m.content.trim()) {
        items.push({ role: m.role, content: m.content.trim(), gear: m.gear ?? "chat", citations: m.citations ?? [] });
      }
    }
    const firstUser = items.find((i) => i.role === "user")?.content.slice(0, 24) ?? "转入伴聊";
    let targetSessionId = input.sessionId?.trim() || "";
    let parentId: string | null = null;
    if (targetSessionId) {
      const detail = await this.getSessionDetail(targetSessionId);
      targetSessionId = detail.session.id;
      parentId = detail.session.activeLeafId;
    } else {
      const created = await this.createSession({
        title: input.title?.trim() || firstUser,
        personaId: input.personaId,
        activeGear: input.activeGear ?? "research",
        boundWorldId: input.boundWorldId,
        boundLineId: input.boundLineId,
        boundBookId: input.boundBookId,
        bookScope: input.bookScope,
        metadata: input.metadata,
        withGreeting: false,
      });
      targetSessionId = created.session.id;
    }
    for (const item of items) {
      const res = await this.appendMessage(targetSessionId, {
        parentId,
        role: item.role,
        gear: item.gear,
        content: item.content,
        citations: item.citations,
      });
      parentId = res.message.id;
    }
    return this.getSessionDetail(targetSessionId);
  }

  // ---------- Streaming Execution (`send` / `snapshot` / `stop` / `compact`) ----------

  async send(input: CompanionSendInput): Promise<CompanionSendResult> {
    const llm = this.game.llm;
    if (!llm) throw new Error("请先在设置中配置 AI 服务与模型。");
    if (this.rpc) {
      const prefs = await getAgentPreferences(this.game).catch(() => null);
      return this.callNative({
        op: "send",
        ...input,
        model: llm,
        ...(this.game.fallbackLlm ? { fallbackModel: this.game.fallbackLlm } : {}),
        ...(prefs?.network ? { network: prefs.network } : {}),
      });
    }
    return this.sendFallback(input);
  }

  async snapshot(runId: string, afterSeq = 0, waitMs = 0): Promise<CompanionRunSnapshot> {
    if (this.rpc) return this.callNative({ op: "snapshot", runId, afterSeq, waitMs });
    const map = runsFor(this.game.platform);
    const active = map.get(runId);
    if (active) {
      if (waitMs > 0 && active.snapshot.seq <= afterSeq && !active.snapshot.done) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            active.listeners.delete(wake);
            resolve();
          }, Math.min(waitMs, 5000));
          const wake = () => {
            clearTimeout(timer);
            active.listeners.delete(wake);
            resolve();
          };
          active.listeners.add(wake);
        });
      }
      return structuredClone(active.snapshot);
    }
    await ensureCompanionTables(this.repo);
    const [row] = await this.repo.platform.sql.query("SELECT * FROM companion_messages WHERE id=?", [runId]);
    if (!row) throw new Error("找不到这次伴聊生成记录。");
    const msg = rowToMessage(row);
    return {
      runId,
      sessionId: msg.sessionId,
      messageId: msg.id,
      seq: afterSeq + 1,
      status: msg.status,
      phase: "done",
      content: msg.content,
      thinking: msg.thinking,
      steps: msg.steps,
      citations: msg.citations,
      usage: msg.usage,
      errorText: msg.errorText,
      done: true,
    };
  }

  async stop(target: { runId?: string; sessionId?: string }): Promise<{ status: string; accepted: boolean }> {
    if (this.rpc) return this.callNative({ op: "stop", ...target });
    const map = runsFor(this.game.platform);
    const entry = target.runId
      ? map.get(target.runId)
      : [...map.values()].find((r) => r.snapshot.sessionId === target.sessionId && !r.snapshot.done);
    if (!entry) return { status: "settled", accepted: false };
    entry.cancel();
    await entry.donePromise.catch(() => {});
    return { status: "cancelled", accepted: true };
  }

  async compact(sessionId: string, keepRecent = 6): Promise<{ session: CompanionSession; summaryText: string; summaryUpToMsgId: string | null }> {
    const llm = this.game.llm;
    if (!llm) throw new Error("请先配置可用的 AI 服务与模型。");
    if (this.rpc) return this.callNative({ op: "compact", sessionId, keepRecent, model: llm });

    const detail = await this.getSessionDetail(sessionId);
    const done = detail.messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.status === "done" && m.content.trim());
    const keep = Math.max(2, Math.min(12, keepRecent));
    if (done.length <= keep) throw new Error("当前对话还不长，无需压缩摘要。");
    const splitAt = done.length - keep;
    const upToMsgId = done[splitAt - 1].id;
    const prevIdx = detail.session.summaryUpToMsgId
      ? done.slice(0, splitAt).findIndex((m) => m.id === detail.session.summaryUpToMsgId)
      : -1;
    const slice = done.slice(prevIdx >= 0 ? prevIdx + 1 : 0, splitAt);
    const transcript = slice.map((m) => `【${m.role === "user" ? "用户" : "回复"}】${m.content.slice(0, 1200)}`).join("\n\n");
    const handle = streamChat(this.game.platform, {
      slot: llm.slot,
      url: llm.url,
      model: llm.auxModel || llm.model,
      includeUsage: llm.includeUsage,
      messages: [
        { role: "system", content: "把下方早期伴聊对话压缩成不超过 600 字的精炼备忘，保留约定设定、结论与偏好，直接输出摘要。" },
        {
          role: "user",
          content: prevIdx >= 0 && detail.session.summaryText.trim()
            ? `【已有摘要】\n${detail.session.summaryText}\n\n【新增对话】\n${transcript}`
            : `【早期对话】\n${transcript}`,
        },
      ],
    });
    const reply = await handle.result;
    const summaryText = reply.text.trim();
    const updated = await this.updateSession(detail.session.id, { summaryText, summaryUpToMsgId: upToMsgId });
    return { session: updated, summaryText, summaryUpToMsgId: upToMsgId };
  }

  private async sendFallback(input: CompanionSendInput): Promise<CompanionSendResult> {
    const llm = this.game.llm!;
    const realSessionId = await this.ensureMaterializedSession(input.sessionId);
    const map = runsFor(this.game.platform);
    if ([...map.values()].some((r) => r.snapshot.sessionId === realSessionId && !r.snapshot.done)) {
      throw new Error("当前对话正在回复中，请先停止或等待回复完成。");
    }
    const detail = await this.getSessionDetail(realSessionId);
    const allRows = await this.repo.platform.sql.query(
      "SELECT * FROM companion_messages WHERE session_id=? ORDER BY seq ASC, id ASC",
      [realSessionId],
    );
    const all = allRows.map(rowToMessage);
    const gear: "chat" | "research" = input.gear ?? (detail.session.activeGear === "research" ? "research" : "chat");

    let userMessage: CompanionMessage | null = null;
    let assistantParentId: string;

    if (input.regenerateMessageId) {
      const target = all.find((m) => m.id === input.regenerateMessageId);
      if (!target) throw new Error("找不到要重新生成的回复。");
      if (target.role === "user") assistantParentId = target.id;
      else {
        if (!target.parentId) throw new Error("开场问候不能直接重答，请发送一条新消息。");
        assistantParentId = target.parentId;
      }
    } else {
      const text = (input.text ?? "").trim();
      if (!text) throw new Error("请输入要发送的内容。");
      let userParent: string | null;
      if (input.editMessageId) {
        const edited = all.find((m) => m.id === input.editMessageId);
        if (!edited || edited.role !== "user") throw new Error("找不到要编辑的原消息。");
        userParent = edited.parentId;
      } else if (input.parentId !== undefined) {
        userParent = input.parentId;
      } else {
        userParent = detail.session.activeLeafId;
      }
      userMessage = (await this.appendMessage(realSessionId, {
        parentId: userParent,
        role: "user",
        gear,
        status: "done",
        content: text,
      })).message;
      assistantParentId = userMessage.id;
    }

    const assistantMessage = (await this.appendMessage(realSessionId, {
      parentId: assistantParentId,
      role: "assistant",
      gear,
      status: "streaming",
      content: "",
      modelId: llm.model,
    })).message;

    if (input.bookScope !== undefined) {
      await this.updateSession(realSessionId, { bookScope: input.bookScope, activeGear: gear });
    }

    const runId = assistantMessage.id;
    const snap: CompanionRunSnapshot = {
      runId,
      sessionId: realSessionId,
      messageId: runId,
      seq: 1,
      status: "streaming",
      phase: "thinking",
      content: "",
      thinking: "",
      steps: [],
      citations: [],
      usage: null,
      errorText: null,
      done: false,
    };
    const listeners = new Set<() => void>();
    const notify = () => {
      snap.seq++;
      for (const fn of [...listeners]) fn();
    };
    let cancelCurrent: () => void = () => {};
    let cancelled = false;

    const donePromise = (async () => {
      const startedMs = Date.now();
      try {
        const updatedRows = await this.repo.platform.sql.query(
          "SELECT * FROM companion_messages WHERE session_id=? ORDER BY seq ASC, id ASC",
          [realSessionId],
        );
        const { messages: branchToParent } = projectBranch(updatedRows.map(rowToMessage), assistantParentId);
        const memories = await this.activeMemoriesForPersona(detail.persona.id, detail.persona.memoryScope);
        const pure = detail.persona.pureRoleplay && gear === "chat";

        const activeScope = input.bookScope ?? detail.session.bookScope;
        let worldBrief = "";
        let effectiveBinding: SourceBinding | null = detail.session.boundBookId
          ? {
              bookId: detail.session.boundBookId,
              through: activeScope?.mode === "chapters" ? activeScope.to : null,
              position: 0,
              fanfic: false,
              plot: "canon",
              method: "search",
              instructions: "",
            }
          : null;

        if (detail.session.boundWorldId) {
          const world = await this.repo.getWorld(detail.session.boundWorldId);
          if (world) {
            const cur = await tree.cursor(this.repo, world.id);
            const st = await this.repo.getState(cur.head.id);
            const place = st.places.find((p) => p.id === st.placeId)?.name ?? "";
            const goals = st.goals.filter((g) => g.status === "进行中").map((g) => g.name).slice(0, 4);
            worldBrief = [
              `故事：《${world.title}》｜主角：${st.protagonist.name}`,
              st.protagonist.identity ? `当前身份：${st.protagonist.identity.slice(0, 120)}` : "",
              `时间地点：${st.time.start || "未定"}${place ? ` · ${place}` : ""}`,
              goals.length ? `进行中目标：${goals.join("；")}` : "",
            ].filter(Boolean).join("\n");
            if (st.source?.bookId) {
              // Enforce world spoiler ceiling `st.source.through`!
              effectiveBinding = { ...st.source };
            }
          }
        }

        let researchNotes = "";
        if (gear === "research") {
          const lastUser = branchToParent.at(-1)?.content ?? "";
          if (effectiveBinding && lastUser) {
            const range =
              activeScope?.mode === "chapters"
                ? {
                    from: Math.max(0, activeScope.from),
                    to: effectiveBinding.through === null ? activeScope.to : Math.min(activeScope.to, effectiveBinding.through),
                  }
                : null;
            snap.phase = "searching";
            const stepId = "step-1";
            snap.steps.push({ id: stepId, tool: "search_original", label: "检索原著原文", query: lastUser.slice(0, 40), status: "running", summary: "正在查阅…" });
            notify();
            const ref = await referenceContext(this.repo, effectiveBinding, lastUser, 4800, range, { ignorePosition: true });
            const origPassages = (ref?.passages ?? []).filter((p) => p.kind === "original" && p.match !== "nearby");
            for (const p of origPassages.slice(0, 5)) {
              snap.citations.push({
                kind: "book",
                bookId: effectiveBinding.bookId,
                title: p.title,
                section: p.section,
                chunk: p.chunk,
                quote: p.text.slice(0, 220),
              });
            }
            snap.steps[0] = {
              ...snap.steps[0],
              status: "done",
              summary: origPassages.length ? `读到 ${origPassages.length} 段原文摘录` : "未找到匹配的原文片段",
            };
            if (origPassages.length) {
              researchNotes = `\n\n【允许范围内的原著摘录】\n${origPassages.map((p) => `[${p.title}·第${p.section + 1}节]\n${p.text}`).join("\n\n")}`;
            }
            notify();
          }
        }

        const validSummary =
          detail.session.summaryUpToMsgId && branchToParent.some((m) => m.id === detail.session.summaryUpToMsgId)
            ? detail.session.summaryText
            : "";
        const sysParts = [detail.persona.systemPrompt.trim()];
        if (detail.persona.styleNotes.trim()) {
          sysParts.push(`${pure ? "【神态与语气】" : "【表达风格】"}\n${detail.persona.styleNotes.trim()}`);
        }
        if (pure) {
          sysParts.push(`请始终以「${detail.persona.name}」本人第一人称自然交谈，保持知情边界，绝不提及AI、模型或系统规则。`);
        } else if (worldBrief) {
          sysParts.push(`【当前挂载故事（只读背景）】\n${worldBrief}`);
        }
        if (memories.length) {
          sysParts.push(
            `${pure ? "【你记得的往事与对方情况】" : "【长期记忆】"}\n${memories.map((m) => `- ${m.content}`).join("\n")}`,
          );
        }
        if (validSummary.trim()) {
          sysParts.push(`${pure ? "【此前交谈梗概】" : "【前文对话摘要】"}\n${validSummary.trim()}`);
        }
        if (researchNotes) sysParts.push(researchNotes.trim());

        const startIdx = validSummary && detail.session.summaryUpToMsgId
          ? branchToParent.findIndex((m) => m.id === detail.session.summaryUpToMsgId) + 1
          : 0;
        const usable = branchToParent
          .slice(startIdx)
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim());
        const windowMsgs: CompanionMessage[] = [];
        let chars = 0;
        for (const m of usable.slice(-CHAT_RECENT_MESSAGES).reverse()) {
          if (windowMsgs.length > 0 && chars + m.content.length > CHAT_WINDOW_CHAR_BUDGET) break;
          chars += m.content.length;
          windowMsgs.push(m);
        }
        windowMsgs.reverse();
        if (windowMsgs[0]?.role === "assistant") {
          const greet = windowMsgs.shift()!;
          sysParts.push(`【开场白】\n${greet.content}`);
        }

        const wire: ChatMessage[] = [{ role: "system", content: sysParts.join("\n\n") }];
        for (const m of windowMsgs) {
          const role = m.role === "assistant" ? "assistant" : "user";
          const prev = wire.at(-1);
          if (prev && prev.role === role) prev.content += `\n\n${m.content}`;
          else wire.push({ role, content: m.content });
        }

        const tools: ChatToolDefinition[] | undefined = undefined;
        const handle = streamChat(
          this.game.platform,
          {
            slot: llm.slot,
            url: llm.url,
            model: llm.model,
            includeUsage: llm.includeUsage,
            maxTokens: llm.maxOutputTokens ?? llm.maxTokens,
            extra: llm.extra as Record<string, Json> | undefined,
            messages: wire,
            tools,
          },
          {
            onThinking: () => {
              snap.phase = "thinking";
              notify();
            },
            onText: (_delta, full) => {
              snap.phase = "writing";
              snap.content = full;
              notify();
            },
          },
        );
        cancelCurrent = () => {
          cancelled = true;
          handle.cancel();
        };
        const res = await handle.result;
        if (cancelled) throw new ChatError("cancelled");
        snap.content = res.text;
        snap.status = "done";
        snap.phase = "done";
        snap.usage = {
          promptTokens: res.usage?.promptTokens ?? null,
          completionTokens: res.usage?.completionTokens ?? null,
          firstTokenMs: res.firstTokenMs ? Math.round(res.firstTokenMs) : null,
          totalMs: Math.round(res.totalMs),
          estimated: !res.usage?.promptTokens,
        };
      } catch (err) {
        if (cancelled || (err instanceof ChatError && err.kind === "cancelled")) {
          snap.status = "cancelled";
          snap.phase = "done";
        } else {
          snap.status = "failed";
          snap.phase = "done";
          snap.errorText = err instanceof Error ? err.message : String(err);
        }
        const totalMs = Date.now() - startedMs;
        snap.usage = {
          promptTokens: 1,
          completionTokens: snap.content.length,
          firstTokenMs: null,
          totalMs,
          estimated: true,
        };
      } finally {
        snap.done = true;
        const now = nowIso();
        const outcome = snap.status === "done" ? "ok" : snap.status === "cancelled" ? "cancelled" : "failed";
        const purpose = gear === "research" ? "companion:research" : "companion:chat";
        await this.repo.platform.sql.batch([
          {
            sql: `UPDATE companion_messages SET
                    status=?, content=?, thinking=?, steps_json=?, citations_json=?,
                    usage_json=?, error_text=?, updated_at=?
                  WHERE id=?`,
            params: [
              snap.status,
              snap.content,
              snap.thinking,
              JSON.stringify(snap.steps),
              JSON.stringify(snap.citations),
              JSON.stringify(snap.usage),
              snap.errorText,
              now,
              runId,
            ],
          },
          { sql: "UPDATE companion_sessions SET updated_at=? WHERE id=?", params: [now, realSessionId] },
          {
            sql: `INSERT INTO usage(id,world_id,node_id,purpose,profile_id,model,prompt_tokens,completion_tokens,estimated,first_token_ms,total_ms,outcome,at)
                  VALUES(?,?,NULL,?,NULL,?,?,?,?,?,?,?,?)`,
            params: [
              `companion:${runId}`,
              detail.session.boundWorldId,
              purpose,
              llm.model,
              snap.usage?.promptTokens ?? 1,
              snap.usage?.completionTokens ?? 0,
              snap.usage?.estimated ? 1 : 0,
              snap.usage?.firstTokenMs ?? null,
              snap.usage?.totalMs ?? 0,
              outcome,
              now,
            ],
          },
        ]).catch(() => {});
        map.delete(runId);
        notify();
      }
    })();

    map.set(runId, {
      snapshot: snap,
      cancel: () => {
        cancelled = true;
        cancelCurrent();
      },
      listeners,
      donePromise,
    });
    return { runId, sessionId: realSessionId, userMessage, assistantMessage };
  }
}

// ---------- Top-Level Functional Helpers for UI Screens ----------

export async function listPersonas(game: Game): Promise<CompanionPersona[]> {
  return new CompanionClient(game).listPersonas();
}

export async function savePersona(
  game: Game,
  input: Partial<CompanionPersona> & Pick<CompanionPersona, "name" | "systemPrompt">,
): Promise<CompanionPersona> {
  return new CompanionClient(game).savePersona(input);
}

export async function deletePersona(
  game: Game,
  id: string,
): Promise<{ id: string; deleted: boolean; resetBuiltin: boolean }> {
  return new CompanionClient(game).deletePersona(id);
}

export async function listMemories(
  game: Game,
  personaIdOrOpts?: string | { personaId?: string; scope?: CompanionMemoryScope | "all"; includeDisabled?: boolean },
): Promise<CompanionMemory[]> {
  const client = new CompanionClient(game);
  if (typeof personaIdOrOpts === "string") {
    return client.listMemories({ personaId: personaIdOrOpts, includeDisabled: true });
  }
  return client.listMemories(personaIdOrOpts ?? { scope: "global", includeDisabled: true });
}

export async function saveMemory(
  game: Game,
  input: Parameters<CompanionClient["saveMemory"]>[0],
): Promise<CompanionMemory> {
  return new CompanionClient(game).saveMemory(input);
}

export async function toggleMemory(
  game: Game,
  id: string,
  enabledOrPatch: boolean | { enabled?: boolean; pinned?: boolean },
): Promise<CompanionMemory> {
  return new CompanionClient(game).toggleMemory(
    id,
    typeof enabledOrPatch === "boolean" ? { enabled: enabledOrPatch } : enabledOrPatch,
  );
}

export async function deleteMemory(
  game: Game,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  return new CompanionClient(game).deleteMemory(id);
}

export async function listSessions(
  game: Game,
  opts?: Parameters<CompanionClient["listSessions"]>[0],
): Promise<CompanionSession[]> {
  return (await new CompanionClient(game).listSessions(opts)).sessions;
}

export async function createSession(
  game: Game,
  input?: Parameters<CompanionClient["createSession"]>[0],
): Promise<CompanionSession> {
  return (await new CompanionClient(game).createSession(input)).session;
}

export async function getOrCreateSession(
  game: Game,
  input: GetOrCreateSessionInput = {},
): Promise<CompanionSession> {
  return (await new CompanionClient(game).getOrCreateSession(input)).session;
}

export async function getSessionDetail(
  game: Game,
  id: string,
): Promise<CompanionSessionDetail | null> {
  return new CompanionClient(game).getSessionDetail(id).catch(() => null);
}

export async function updateSession(
  game: Game,
  id: string,
  patch: Parameters<CompanionClient["updateSession"]>[1],
): Promise<CompanionSession> {
  return new CompanionClient(game).updateSession(id, patch);
}

export async function switchBranch(
  game: Game,
  sessionId: string,
  messageId: string,
): Promise<CompanionSessionDetail> {
  return new CompanionClient(game).switchBranch(sessionId, messageId);
}

export async function deleteSession(
  game: Game,
  id: string,
): Promise<{ id: string; deleted: boolean }> {
  return new CompanionClient(game).deleteSession(id);
}

export async function importHandoffMessages(
  game: Game,
  sessionId: string,
  asked: { q: string; a: string }[],
): Promise<CompanionSessionDetail> {
  return new CompanionClient(game).importHandoff({ sessionId, turns: asked });
}

export async function compactCompanionSession(
  game: Game,
  sessionId: string,
  keepRecent = 6,
): Promise<{ session: CompanionSession; summaryText: string; summaryUpToMsgId: string | null }> {
  return new CompanionClient(game).compact(sessionId, keepRecent);
}

export async function stopCompanionRun(
  game: Game,
  target: { runId?: string; sessionId?: string },
): Promise<{ status: string; accepted: boolean }> {
  const directStop = (
    game.platform as Platform & {
      companion?: { stop?: (t: { runId?: string; sessionId?: string }) => Promise<{ status?: string; accepted?: boolean }> };
    }
  ).companion?.stop;
  if (directStop && !nativeCompanionRpc(game.platform)) {
    const res = await directStop(target);
    await new CompanionClient(game).stop(target).catch(() => {});
    return { status: res?.status ?? "cancelled", accepted: res?.accepted ?? true };
  }
  return new CompanionClient(game).stop(target);
}

export function followCompanionRun(
  game: Game,
  sessionId: string,
  runId: string,
  onUpdate?: (update: CompanionStreamUpdate) => void,
): CompanionHandle {
  const client = new CompanionClient(game);
  let stopped = false;
  let detached = false;
  let detachWake: (() => void) | null = null;
  let lastSnap: CompanionRunSnapshot = {
    runId,
    sessionId,
    messageId: runId,
    seq: 0,
    status: "streaming",
    phase: "thinking",
    content: "",
    thinking: "",
    steps: [],
    citations: [],
    usage: null,
    errorText: null,
    done: false,
  };

  const done = (async (): Promise<CompanionRunSnapshot> => {
    if (stopped) {
      await stopCompanionRun(game, { runId, sessionId }).catch(() => {});
    }
    if (detached) return lastSnap;
    let seq = 0;
    while (!detached) {
      const snap = await Promise.race([
        client.snapshot(runId, seq, 350).catch((err) => {
          if (detached) return null;
          throw err;
        }),
        new Promise<null>((resolve) => {
          detachWake = () => resolve(null);
        }),
      ]);
      detachWake = null;
      if (detached || !snap) return lastSnap;
      lastSnap = snap;
      seq = Math.max(seq, snap.seq);
      onUpdate?.({
        status: snap.status,
        phase: snap.phase,
        text: snap.content,
        thinking: snap.thinking,
        steps: snap.steps,
        citations: snap.citations,
        usage: snap.usage,
        errorText: snap.errorText,
      });
      if (snap.done) {
        if (snap.status === "failed") {
          throw new Error(snap.errorText || "生成未能完成，请稍后重试");
        }
        return snap;
      }
    }
    return lastSnap;
  })();

  return {
    done,
    stop: () => {
      stopped = true;
      void stopCompanionRun(game, { runId, sessionId }).catch(() => {});
    },
    detach: () => {
      detached = true;
      detachWake?.();
      detachWake = null;
    },
  };
}

export function sendCompanionMessage(
  game: Game,
  input: CompanionSendInput,
  onUpdate?: (update: CompanionStreamUpdate) => void,
): CompanionHandle {
  const client = new CompanionClient(game);
  let stopped = false;
  let detached = false;
  let detachWake: (() => void) | null = null;
  let activeRunId: string | null = null;

  const done = (async (): Promise<CompanionRunSnapshot> => {
    const started = await client.send(input);
    activeRunId = started.runId;
    if (stopped) {
      await stopCompanionRun(game, { runId: started.runId, sessionId: input.sessionId }).catch(() => {});
    }
    let lastSnap: CompanionRunSnapshot = {
      runId: started.runId,
      sessionId: started.sessionId,
      messageId: started.assistantMessage.id,
      seq: 0,
      status: started.assistantMessage.status,
      phase: "thinking",
      content: started.assistantMessage.content,
      thinking: started.assistantMessage.thinking,
      steps: started.assistantMessage.steps,
      citations: started.assistantMessage.citations,
      usage: started.assistantMessage.usage,
      errorText: started.assistantMessage.errorText,
      done: false,
    };
    if (detached) return lastSnap;
    let seq = 0;
    while (!detached) {
      const snap = await Promise.race([
        client.snapshot(started.runId, seq, 350).catch((err) => {
          if (detached) return null;
          throw err;
        }),
        new Promise<null>((resolve) => {
          detachWake = () => resolve(null);
        }),
      ]);
      detachWake = null;
      if (detached || !snap) return lastSnap;
      lastSnap = snap;
      seq = Math.max(seq, snap.seq);
      onUpdate?.({
        status: snap.status,
        phase: snap.phase,
        text: snap.content,
        thinking: snap.thinking,
        steps: snap.steps,
        citations: snap.citations,
        usage: snap.usage,
        errorText: snap.errorText,
      });
      if (snap.done) {
        if (snap.status === "failed") {
          throw new Error(snap.errorText || "生成未能完成，请稍后重试");
        }
        return snap;
      }
    }
    return lastSnap;
  })();

  return {
    done,
    stop: () => {
      stopped = true;
      if (activeRunId) {
        void stopCompanionRun(game, { runId: activeRunId, sessionId: input.sessionId }).catch(() => {});
      } else {
        void stopCompanionRun(game, { sessionId: input.sessionId }).catch(() => {});
      }
    },
    detach: () => {
      detached = true;
      detachWake?.();
      detachWake = null;
    },
  };
}

// ---------- NPC Knowledge-Fenced Persona Builder ----------

const AWARENESS_LABEL: Record<ProjectedKnowledge["awareness"], string> = {
  witnessed: "亲眼所见",
  told: "听人告知",
  believes: "深信此事",
  rumor: "耳闻传言（未必为真）",
  denied: "不信此事",
  uncertain: "将信将疑",
};

/**
 * Generates an immersive, knowledge-fenced, worldline-isolated pure-roleplay persona from a story NPC.
 *
 * SECURITY / IMMERSION INVARIANT:
 * - Scoped strictly to `resolvedLineId` (`npc:${worldId}:${resolvedLineId}:${person.id}`) so spoilers
 *   and memories from Branch A never leak into Branch B.
 * - Includes ONLY `continuity.knowledge` items where `k.active !== false && k.person === person.id` on `resolvedLineId`.
 * - NEVER leaks `protagonist.origin`, `protagonist.cheat`, `protagonist.panel`,
 *   other NPCs' private knowledge, `pins`, `continuity.threads`, or `state.timeline`.
 */
export async function personaFromStoryPerson(
  game: Game,
  worldId: string,
  personId: string,
  lineId?: string,
): Promise<CompanionPersona & { boundLineId?: string | null }> {
  const world = await game.repo.getWorld(worldId);
  if (!world) throw new Error("没有找到这局故事。");
  const resolvedLineId = lineId?.trim() || world.currentLineId || "main";
  const requestedLine = await game.repo.getLine(resolvedLineId).catch(() => null);
  const headId =
    requestedLine && requestedLine.worldId === worldId
      ? requestedLine.nodeId
      : (await tree.cursor(game.repo, worldId)).head.id;
  const state = await game.repo.getState(headId);
  const person = state.people.find(
    (p) => p.id === personId || p.name === personId || p.aliases.includes(personId),
  );
  if (!person) throw new Error("在这局故事里没有找到这位人物。");

  const continuity = await readContinuity(game.repo, worldId, headId);
  const myKnowledge = continuity.knowledge.filter(
    (k) => k.active !== false && k.person === person.id,
  );

  const heroName = state.protagonist.name || "对方";
  const placeName = state.places.find((p) => p.id === state.placeId)?.name ?? "";
  const aliasesLine = person.aliases?.length ? `（又称：${person.aliases.join("、")}）` : "";
  const knowledgeBlock = myKnowledge.length
    ? `\n\n【你截至目前亲历或听闻的具体事项】\n${myKnowledge
        .map((k) => `- [${AWARENESS_LABEL[k.awareness]}] ${k.claim}`)
        .join("\n")}`
    : "\n\n【你截至目前的知情】\n你只知道双方当面打过交道的寻常往来，没有额外探知隐秘。";

  const systemPrompt = [
    `你是《${world.title}》中的人物「${person.name}」${aliasesLine}。`,
    `你的身份：${person.role || "局中人"}${person.alive === false ? "（故事中已故，此处为追忆对话）" : ""}。`,
    person.origin ? `过往渊源：${person.origin}` : "",
    person.notes ? `你的近况：${person.notes}` : "",
    `你对「${heroName}」当前的态度：${person.attitude}。`,
    state.time.start || placeName
      ? `当下时地背景：${state.time.start || ""}${placeName ? ` · ${placeName}` : ""}。`
      : "",
    `严格守住你的知情边界：你正在与「${heroName}」私下交谈。你只知道自己的身世处境、双方当面发生过的事，以及下方列出的你本人所知事项；你绝不知道对方的穿越来历、系统/金手指、别人背地里的秘密或尚未发生的未来。始终以「${person.name}」第一人称说话与反应，绝不提及AI、提示词或游戏术语。`,
  ]
    .filter(Boolean)
    .join("\n") + knowledgeBlock;

  const client = new CompanionClient(game);
  const scopedId = `npc:${worldId}:${resolvedLineId}:${person.id}`;
  const legacyId = `npc:${worldId}:${person.id}`;

  // Gracefully migrate legacy `npc:${worldId}:${person.id}` ONLY if its `boundLineId`
  // matches `resolvedLineId` or is unset on `"main"`:
  const existingScoped = await client.getPersona(scopedId).catch(() => null);
  if (!existingScoped) {
    const legacyPersona = (await client.getPersona(legacyId).catch(() => null)) as
      | (CompanionPersona & { boundLineId?: string | null })
      | null;
    if (legacyPersona) {
      const legacyLineId =
        legacyPersona.boundLineId ??
        (typeof legacyPersona.metadata?.boundLineId === "string" && legacyPersona.metadata.boundLineId.trim()
          ? legacyPersona.metadata.boundLineId.trim()
          : null);
      const canMigrate =
        legacyLineId === resolvedLineId || (!legacyLineId && resolvedLineId === "main");
      if (canMigrate) {
        const legacyMemories = await client.listMemories({
          personaId: legacyId,
          scope: "persona",
          includeDisabled: true,
        });
        for (const mem of legacyMemories) {
          if (mem.scope === "persona" && mem.personaId === legacyId) {
            await client.saveMemory({
              scope: "persona",
              personaId: scopedId,
              category: mem.category,
              content: mem.content,
              sourceSessionId: mem.sourceSessionId,
              sourceMessageId: mem.sourceMessageId,
              enabled: mem.enabled,
              pinned: mem.pinned,
            });
          }
        }
        const { sessions: existingSessions } = await client.listSessions({
          worldId,
          includeArchived: true,
          limit: 100,
        });
        for (const sess of existingSessions) {
          if (
            sess.personaId === legacyId &&
            (!sess.boundLineId || sess.boundLineId === resolvedLineId)
          ) {
            await client.updateSession(sess.id, {
              personaId: scopedId,
              boundLineId: resolvedLineId,
            });
          }
        }
        await client.deletePersona(legacyId).catch(() => {});
      }
    }
  }

  const saved = await client.savePersona({
    id: scopedId,
    name: person.name,
    avatar: person.name.trim().slice(0, 1) || "人",
    tagline: `《${world.title}》· ${person.role || "故事人物"}（对${heroName}${person.attitude}）`.slice(0, 120),
    roleKind: "npc",
    systemPrompt,
    greeting: `（${person.name}抬眼望向${heroName}）有什么话，不妨直说。`,
    starters: [
      `最近处境如何？有什么打算？`,
      `关于眼下的局面，你怎么看？`,
      `有件事想私下问问你的意思。`,
    ],
    styleNotes: `贴合「${person.name}」（${person.role || "人物"}）的身份口吻与对${heroName}「${person.attitude}」的态度。`,
    memoryScope: "persona",
    pureRoleplay: true,
    sourceWorldId: worldId,
    sourcePersonId: person.id,
    sourceHeadId: headId,
    boundLineId: resolvedLineId,
    sortOrder: 60,
    metadata: { worldTitle: world.title, heroName, boundLineId: resolvedLineId },
  });
  return { ...saved, boundLineId: resolvedLineId };
}

// ---------- Three One-Tap Creative Bridges (R33-T003) ----------

const FREE_WORLD_RE = /修仙|仙侠|灵气|筑基|金丹|玄幻|异世界|魔法|赛博|星际|末世|武魂|魂环|斗气|宗门|异能|诡秘/;

function normalizeArrival(raw: unknown): Arrival {
  if (typeof raw === "string") {
    for (const a of ["魂穿", "身穿", "投胎", "不穿越"] as const) {
      if (raw.includes(a)) return a;
    }
  }
  return "魂穿";
}

function buildInheritedSourceBinding(context?: {
  worldSource?: SourceBinding | null;
  bookId?: string | null;
  bookScope?: CompanionBookScope | null;
}): SourceBinding | null {
  if (!context) return null;
  const { worldSource, bookId, bookScope } = context;
  if (worldSource?.bookId && (!bookId || worldSource.bookId === bookId)) {
    const through =
      bookScope?.mode === "chapters"
        ? worldSource.through === null
          ? bookScope.to
          : Math.min(worldSource.through, bookScope.to)
        : worldSource.through;
    const position =
      through !== null ? Math.min(worldSource.position, through) : worldSource.position;
    return {
      ...structuredClone(worldSource),
      through,
      position,
      fanfic: worldSource.fanfic,
      plot: worldSource.plot,
      instructions: worldSource.instructions,
    };
  }
  const effectiveBookId = bookId?.trim() || null;
  if (!effectiveBookId) return null;
  return {
    bookId: effectiveBookId,
    through: bookScope?.mode === "chapters" ? bookScope.to : null,
    position: 0,
    fanfic: false,
    plot: "canon",
    method: "search",
    instructions: "",
  };
}

/**
 * Resolves the spoiler-fenced `SourceBinding` for `"拿去开新局"` from a Companion session
 * or bound world, preserving `through`, `position`, `fanfic`, `plot`, and `instructions`.
 */
export async function resolveSessionDraftSource(
  game: Game,
  session?: Pick<CompanionSession, "boundWorldId" | "boundLineId" | "boundBookId" | "bookScope"> | null,
  fallbackWorldId?: string | null,
): Promise<SourceBinding | null> {
  const worldId = session?.boundWorldId ?? fallbackWorldId ?? null;
  let worldSource: SourceBinding | null = null;
  if (worldId) {
    const world = await game.repo.getWorld(worldId).catch(() => null);
    if (world) {
      const preferredLine = session?.boundLineId
        ? await game.repo.getLine(session.boundLineId).catch(() => null)
        : null;
      const headId =
        preferredLine && preferredLine.worldId === world.id
          ? preferredLine.nodeId
          : (await tree.cursor(game.repo, world.id).catch(() => null))?.head.id ?? null;
      const state = headId ? await game.repo.getState(headId).catch(() => null) : null;
      if (state?.source?.bookId) {
        worldSource = state.source;
      }
    }
  }
  const bookId = session?.boundBookId ?? worldSource?.bookId ?? null;
  return buildInheritedSourceBinding({
    worldSource,
    bookId,
    bookScope: session?.bookScope ?? null,
  });
}

/**
 * Bridge 1 ("用这段设定去开新局"): Extracts a `SetupDraft` from a companion reply
 * (supports embedded JSON, labeled Chinese headings, or free-form brainstorm prose).
 */
export function draftSetupFromCompanionText(
  text: string,
  personaName?: string,
  context?: {
    worldSource?: SourceBinding | null;
    bookId?: string | null;
    bookScope?: CompanionBookScope | null;
  },
): SetupDraft & { rules?: string; source?: SourceBinding | null } {
  const inheritedSource = buildInheritedSourceBinding(context);
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();

  // 1. Check for JSON setup object if present:
  const codeBlock = /```(?:json)?\s*([\s\S]*?)```/i.exec(cleaned)?.[1] ?? cleaned;
  if (codeBlock.includes("{") && codeBlock.includes("}")) {
    const parsed = lenientJson(codeBlock);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.premise === "string" || typeof obj.identity === "string") {
        const mode: "history" | "free" =
          obj.mode === "free" || FREE_WORLD_RE.test(`${obj.premise ?? ""} ${obj.identity ?? ""}`)
            ? "free"
            : "history";
        return {
          mode,
          title: typeof obj.title === "string" ? obj.title.trim().slice(0, 24) : "",
          premise: typeof obj.premise === "string" ? obj.premise.trim() : cleaned,
          name: typeof obj.name === "string" ? obj.name.trim().slice(0, 24) : "",
          gender: obj.gender === "女" ? "女" : "男",
          age: typeof obj.age === "number" && Number.isFinite(obj.age) ? Math.max(1, Math.trunc(obj.age)) : null,
          identity: typeof obj.identity === "string" ? obj.identity.trim() : "",
          arrival: normalizeArrival(obj.arrival),
          origin: typeof obj.origin === "string" ? obj.origin.trim() : "",
          hint: typeof obj.hint === "string" ? obj.hint.trim() : "",
          essentials: typeof obj.essentials === "string" ? obj.essentials.trim() : "",
          ...(typeof obj.rules === "string" ? { rules: obj.rules.trim() } : {}),
          ...(inheritedSource ? { source: inheritedSource } : {}),
        };
      }
    }
  }

  // 2. Parse labeled Chinese markdown/bullet lines + fallback prose:
  const fields: Record<string, string> = {};
  const remainingLines: string[] = [];
  const labelMap: [RegExp, string][] = [
    [/^(?:故事)?(?:标题|书名|题目|局名)\s*[：:]/, "title"],
    [/^(?:故事设定|世界观|背景设定|时代背景|设定|背景)\s*[：:]/, "premise"],
    [/^(?:主角姓名|主角名字|主角名|姓名|名字)\s*[：:]/, "name"],
    [/^(?:主角性别|性别)\s*[：:]/, "gender"],
    [/^(?:主角年龄|年龄|年岁)\s*[：:]/, "age"],
    [/^(?:主角身份|开局身份|身份与处境|身份|人设|处境)\s*[：:]/, "identity"],
    [/^(?:穿越方式|开局方式|降临方式)\s*[：:]/, "arrival"],
    [/^(?:穿越前身份|穿越前|前世身份|前世|现代身份|来历)\s*[：:]/, "origin"],
    [/^(?:开场提示|开场第一幕|第一幕|开场场景|开场|切入点)\s*[：:]/, "hint"],
    [/^(?:核心要点|谨记要点|要点|核心规则)\s*[：:]/, "essentials"],
  ];

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.、])\s*/, "").replace(/\*\*/g, "").trim();
    if (!line) continue;
    let matched = false;
    for (const [re, key] of labelMap) {
      if (re.test(line)) {
        const val = line.replace(re, "").trim();
        if (val) fields[key] = fields[key] ? `${fields[key]}\n${val}` : val;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const cleanRem = rawLine
        .replace(/^#{1,6}\s+/, "")
        .replace(/^\s*(?:---+|\*\*\*+)\s*$/, "")
        .replace(/^\s*[-*•]\s+/, "")
        .replace(/\*\*/g, "")
        .trim();
      if (cleanRem) remainingLines.push(cleanRem);
    }
  }

  const standaloneHeading = cleaned
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#*\-\s]+/, "").replace(/\*\*/g, "").trim())
    .find((l) => l.length <= 28 && /^《([^》]{1,20})》$/.test(l));
  const bookTitleMatch = /《([^》]{1,20})》/.exec(fields.title ?? standaloneHeading ?? "");
  const title = (fields.title?.replace(/[《》]/g, "").trim() || bookTitleMatch?.[1] || "").slice(0, 24);
  const premiseBody = fields.premise || remainingLines.filter(Boolean).join("\n").trim() || cleaned;
  const ageMatch = /(\d{1,3})/.exec(fields.age ?? "");
  const gender: "男" | "女" =
    fields.gender?.includes("女") || /少女|女子|公主|小姐|女扮男装|姑娘/.test(fields.identity ?? "")
      ? "女"
      : "男";
  const arrival = normalizeArrival(fields.arrival ?? cleaned);
  const mode: "history" | "free" = FREE_WORLD_RE.test(`${premiseBody}\n${fields.identity ?? ""}`)
    ? "free"
    : "history";

  return {
    mode,
    title,
    premise: premiseBody.slice(0, 2000),
    name: (fields.name ?? "").slice(0, 24),
    gender,
    age: ageMatch ? Number(ageMatch[1]) : null,
    identity: (fields.identity ?? "").slice(0, 600),
    arrival,
    origin: arrival === "不穿越" ? "" : (fields.origin ?? ""),
    hint: (fields.hint ?? (personaName ? `按与${personaName}商定的构思开场` : "")).slice(0, 300),
    essentials: (fields.essentials ?? "").slice(0, 1000),
    ...(inheritedSource ? { source: inheritedSource } : {}),
  };
}

/**
 * Bridge 2 ("存进札记"): Saves a companion message as a `CanonNote` (`canon_notes` or
 * `story_notes`), strictly preserving the attached world's `through` spoiler ceiling!
 */
export async function saveCompanionMessageAsNote(
  game: Game,
  session: Pick<CompanionSession, "id" | "title" | "boundWorldId" | "boundBookId" | "bookScope">,
  message: Pick<CompanionMessage, "id" | "content" | "citations">,
  options: { title?: string; kind?: NoteKind } = {},
): Promise<CanonNote> {
  const content = localNoteContent(message.content);
  const candidateLines = content
    .split(/\r?\n/)
    .map((l) => l.replace(/^[#>*\-\d.、\s]+/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
  const firstLine =
    candidateLines.find((l) => !/(?:检索|核实|查证|查询|整理|分析|总结)?(?:结果|情况|内容|回答)?如下[：:]$/.test(l)) ??
    candidateLines[0] ??
    "";
  const title = (options.title?.trim() || firstLine.slice(0, 24) || session.title.trim() || "伴聊整理").slice(0, 48);
  const kind: NoteKind = options.kind ?? "question";

  if (session.boundWorldId) {
    const world = await game.repo.getWorld(session.boundWorldId);
    if (world) {
      const cursor = await tree.cursor(game.repo, world.id);
      const state = await game.repo.getState(cursor.head.id);
      if (state.source?.bookId) {
        const bookId = state.source.bookId;
        const [meta] = await game.repo.platform.sql.query(
          "SELECT MAX(section) AS last_sec FROM source_sections WHERE book_id=?",
          [bookId],
        );
        const bookLast = meta?.last_sec == null ? 0 : Number(meta.last_sec);
        const worldThrough = state.source.through;
        const ceiling = worldThrough === null ? bookLast : Math.min(worldThrough, bookLast);
        const citedSections = (message.citations ?? [])
          .filter((c) => c.kind === "book" && c.bookId === bookId && typeof c.section === "number")
          .map((c) => c.section!);
        const refs = [...new Set([...citedSections, ...mentionedChapters(content)])]
          .filter((s) => Number.isInteger(s) && s >= 0 && s <= ceiling)
          .sort((a, b) => a - b);

        const scope = {
          ...(kind === "question" ? { question: title } : { subject: title }),
          ...(worldThrough !== null ? { through: ceiling } : {}),
          ...(kind === "plot" || kind === "timeline" ? { from: 0, to: ceiling } : {}),
        };
        const note: CanonNote = {
          ...newNote(bookId, kind, scope, title, world.id),
          content,
          refs,
          status: "done",
          active: true,
        };
        await saveNote(game.repo, note);
        return note;
      }

      const lastTurn = Math.max(0, await storyLastTurn(game.repo, world.id));
      const storyNote: CanonNote = {
        ...newStoryNote(
          world.id,
          kind,
          {
            ...(kind === "question" ? { question: title } : { subject: title }),
            from: 0,
            to: lastTurn,
            toNode: cursor.head.id,
          },
          title,
        ),
        content,
        status: "done",
        active: true,
      };
      await saveNote(game.repo, storyNote);
      return storyNote;
    }
  }

  if (session.boundBookId) {
    const [meta] = await game.repo.platform.sql.query(
      "SELECT b.id, MAX(s.section) AS last_sec FROM source_books b LEFT JOIN source_sections s ON s.book_id=b.id WHERE b.id=? GROUP BY b.id",
      [session.boundBookId],
    );
    if (!meta?.id) throw new Error("关联的参考书籍已不存在，无法存进札记。");
    const bookLast = meta.last_sec == null ? 0 : Number(meta.last_sec);
    const scopedTo =
      session.bookScope?.mode === "chapters" && typeof session.bookScope.to === "number"
        ? Math.min(session.bookScope.to, bookLast)
        : null;
    const ceiling = scopedTo ?? bookLast;
    const citedSections = (message.citations ?? [])
      .filter((c) => c.kind === "book" && c.bookId === session.boundBookId && typeof c.section === "number")
      .map((c) => c.section!);
    const refs = [...new Set([...citedSections, ...mentionedChapters(content)])]
      .filter((s) => Number.isInteger(s) && s >= 0 && s <= ceiling)
      .sort((a, b) => a - b);
    const note: CanonNote = {
      ...newNote(
        session.boundBookId,
        kind,
        {
          ...(kind === "question" ? { question: title } : { subject: title }),
          ...(scopedTo !== null ? { through: scopedTo } : {}),
          ...(kind === "plot" || kind === "timeline" ? { from: 0, to: ceiling } : {}),
        },
        title,
        null,
      ),
      content,
      refs,
      status: "done",
      active: true,
    };
    await saveNote(game.repo, note);
    return note;
  }

  throw new Error("请先在伴聊中挂载一个故事或一本参考书，再存进札记。");
}

/**
 * Bridge 3 ("交给改档助手处理"): Seamlessly escalates a companion session to the
 * guarded Pi `AgentClient` on `boundWorldId`:
 * - Creates or reuses `pi_session_id` on the current world/line.
 * - Prefixes ONLY genuine player-authored (`role === "user"`) statements from the
 *   active companion branch so AI prose NEVER pollutes `playerReferences`!
 * - Records `piTaskId` onto a `companion_messages` row (`gear: "agent"`).
 */
const PRIOR_CHAT_REFERENCE_RE = /(?:上面|刚才|前面|之前|按这|照这|这套|这些|如上|同上|聊的|说的|讨论)/;

function safeEndpointPathname(raw: string): string {
  if (!raw) return "/";
  try {
    return new URL(raw, "http://localhost").pathname;
  } catch {
    return raw.startsWith("/") ? raw : "/";
  }
}

export async function resolveCompanionAgentPolicy(
  game: Game,
  explicit?: AgentPolicy | "review" | null,
): Promise<AgentPolicy> {
  if (explicit === "review" || explicit === "preview") return "preview";
  if (explicit === "auto" || explicit === "auto-reversible") return explicit;

  const storedPrefs = await game.repo
    .getSetting<Record<string, unknown> | null>("agent:preferences", null)
    .catch(() => null);
  const storedPolicy = storedPrefs?.policy;
  if (storedPolicy === "review" || storedPolicy === "preview") return "preview";
  if (storedPolicy === "auto" || storedPolicy === "auto-reversible") return storedPolicy;

  const rawAdoption = await game.repo
    .getSetting<unknown>("agentAdoptionMode", null)
    .catch(() => null);
  if (rawAdoption === "review" || rawAdoption === "preview") return "preview";
  if (rawAdoption === "auto") return "auto";
  if (rawAdoption === "auto-reversible") return "auto-reversible";

  return "preview";
}

export async function saveCompanionAgentPolicy(
  game: Game,
  policy: AgentPolicy,
): Promise<void> {
  const storedPrefs = await game.repo
    .getSetting<Record<string, unknown> | null>("agent:preferences", null)
    .catch(() => null);
  await Promise.all([
    game.repo.setSetting("agent:preferences", {
      ...(storedPrefs && typeof storedPrefs === "object" ? storedPrefs : {}),
      policy,
    }),
    game.repo.setSetting(
      "agentAdoptionMode",
      policy === "auto-reversible" || policy === "auto" ? "auto" : "preview",
    ),
  ]);
}

export async function resolveEscalatedAgentModel(
  game: Game,
  prefs: AgentPreferences,
): Promise<LlmConfig & { profileId?: string; protocol?: AgentProtocol; thinkingMode?: AgentThinkingMode; contextWindowTokens?: number; maxOutputTokens?: number }> {
  const base = game.llm!;
  const available = await listProfiles(game.repo);
  const explicitProfile = prefs.profileId
    ? available.find((p) => p.id === prefs.profileId)
    : undefined;
  const staleProfile = Boolean(prefs.profileId && !explicitProfile);
  const effectivePrefs: AgentPreferences = staleProfile
    ? {
        ...prefs,
        profileId: undefined,
        modelName: undefined,
        protocol: undefined,
        modelUrl: undefined,
        contextWindowTokens: undefined,
      }
    : prefs;
  const chosen =
    explicitProfile ??
    available.find((p) => p.keySlot === base.slot) ??
    available[0];
  if (!chosen) {
    const model = (effectivePrefs.modelName?.trim() || base.model).trim();
    const protocol: AgentProtocol = effectivePrefs.protocol ?? base.protocol ?? "chat-completions";
    let fallbackUrl = base.url;
    if (protocol !== "chat-completions" && base.url) {
      let endpoint = base.url.trim().replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|messages)$/, "");
      if (protocol === "gemini") {
        endpoint = endpoint.replace(/\/openai$/, "");
        if (safeEndpointPathname(endpoint) === "/") endpoint += "/v1beta";
        fallbackUrl = `${endpoint}/models/${encodeURIComponent(model.replace(/^models\//, ""))}:streamGenerateContent?alt=sse`;
      } else {
        if (safeEndpointPathname(endpoint) === "/") endpoint += "/v1";
        fallbackUrl = `${endpoint}/${protocol === "openai-responses" ? "responses" : "messages"}`;
      }
    }
    return {
      ...base,
      url: effectivePrefs.modelUrl?.trim() || fallbackUrl,
      model,
      contextTokens: effectivePrefs.inputTokens ?? base.contextTokens ?? DEFAULT_AGENT_INPUT_TOKENS,
      protocol,
      thinkingMode: effectivePrefs.thinkingMode ?? "off",
      ...(effectivePrefs.contextWindowTokens ? { contextWindowTokens: effectivePrefs.contextWindowTokens } : {}),
      ...(effectivePrefs.maxOutputTokens ? { maxOutputTokens: effectivePrefs.maxOutputTokens, maxTokens: effectivePrefs.maxOutputTokens } : {}),
    };
  }
  const model = (effectivePrefs.modelName?.trim() || chosen.mainModel || base.model).trim();
  const protocol: AgentProtocol = effectivePrefs.protocol ?? "chat-completions";
  let url = chatCompletionsUrl(chosen.baseUrl);
  if (protocol !== "chat-completions") {
    let endpoint = chosen.baseUrl.trim().replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|messages)$/, "");
    if (protocol === "gemini") {
      endpoint = endpoint.replace(/\/openai$/, "");
      if (safeEndpointPathname(endpoint) === "/") endpoint += "/v1beta";
      url = `${endpoint}/models/${encodeURIComponent(model.replace(/^models\//, ""))}:streamGenerateContent?alt=sse`;
    } else {
      if (safeEndpointPathname(endpoint) === "/") endpoint += "/v1";
      url = `${endpoint}/${protocol === "openai-responses" ? "responses" : "messages"}`;
    }
  }
  return {
    profileId: chosen.id,
    slot: chosen.keySlot,
    url: effectivePrefs.modelUrl?.trim() || url,
    model,
    auxModel: chosen.auxModel?.trim() || "",
    includeUsage: chosen.includeUsage,
    contextTokens: effectivePrefs.inputTokens ?? DEFAULT_AGENT_INPUT_TOKENS,
    protocol,
    thinkingMode: effectivePrefs.thinkingMode ?? "off",
    ...(effectivePrefs.contextWindowTokens ? { contextWindowTokens: effectivePrefs.contextWindowTokens } : {}),
    ...(effectivePrefs.maxOutputTokens ? { maxOutputTokens: effectivePrefs.maxOutputTokens, maxTokens: effectivePrefs.maxOutputTokens } : {}),
  };
}

function sanitizePrefsForResolvedModel(
  prefs: AgentPreferences,
  resolvedModel: Awaited<ReturnType<typeof resolveEscalatedAgentModel>>,
): AgentPreferences {
  const staleProfile = Boolean(prefs.profileId && prefs.profileId !== resolvedModel.profileId);
  const sanitized: AgentPreferences = staleProfile
    ? {
        ...prefs,
        profileId: resolvedModel.profileId,
        modelName: undefined,
        protocol: undefined,
        modelUrl: undefined,
        contextWindowTokens: undefined,
      }
    : {
        ...prefs,
        profileId: resolvedModel.profileId,
      };
  if (sanitized.profileId === undefined) {
    delete sanitized.profileId;
  }
  const trimmedCustomUrl = sanitized.modelUrl?.trim();
  if (trimmedCustomUrl) {
    sanitized.modelUrl = trimmedCustomUrl;
  } else {
    delete sanitized.modelUrl;
  }
  return sanitized;
}

export async function escalateCompanionToAgent(
  game: Game,
  input: EscalateToAgentInput,
): Promise<EscalateToAgentResult> {
  const requestText = input.text.trim();
  if (!requestText) throw new Error("请写明要交给改档助手处理的具体修改要求。");
  if (!game.llm) throw new Error("请先在设置中配置 AI 服务与模型。");

  const companion = new CompanionClient(game);
  const detail = await companion.getSessionDetail(input.sessionId);
  const worldId = detail.session.boundWorldId;
  if (!worldId) throw new Error("请先挂载要操作的故事，再交给改档助手处理。");

  const [start, prefs, policy] = await Promise.all([
    game.repo.generationStart(worldId),
    getAgentPreferences(game),
    resolveCompanionAgentPolicy(game, input.policy),
  ]);
  const resolvedModel = await resolveEscalatedAgentModel(game, prefs);
  const sanitizedPrefs = sanitizePrefsForResolvedModel(prefs, resolvedModel);
  const agent = new AgentClient(game);

  let piSessionId = detail.session.piSessionId;
  if (piSessionId) {
    const existing = await agent.session(piSessionId).catch(() => null);
    if (!existing || existing.session.worldId !== worldId || existing.session.lineId !== start.lineId) {
      piSessionId = null;
    }
  }
  if (!piSessionId) {
    const created = await agent.create(worldId, start.lineId, detail.session.title || "伴聊协作");
    piSessionId = created.id;
  }

  // CRITICAL: Only player-written (`role === "user"`, `gear === "chat"`) turns enter
  // `task.text` when the request is short or refers back to prior chat — never AI replies
  // and never prior `research`/`agent` tool templates!
  const includePriorChat = requestText.length < 40 || PRIOR_CHAT_REFERENCE_RE.test(requestText);
  const branchMessages =
    input.parentId !== undefined
      ? (() => {
          if (input.parentId === null) return [];
          const idx = detail.messages.findIndex((m) => m.id === input.parentId);
          return idx >= 0 ? detail.messages.slice(0, idx + 1) : detail.messages;
        })()
      : detail.messages;
  const priorPlayerLines = includePriorChat
    ? branchMessages
        .filter(
          (m) =>
            m.role === "user" &&
            m.gear === "chat" &&
            m.status === "done" &&
            m.content.trim() &&
            m.content.trim() !== requestText,
        )
        .slice(-4)
        .map((m) => m.content.trim().slice(0, 300))
    : [];
  const combinedPlayerText = priorPlayerLines.length
    ? `【玩家此前在伴聊中提出的要求】\n${priorPlayerLines.map((l) => `- ${l}`).join("\n")}\n\n【本次执行要求】\n${requestText}`
    : requestText;

  // Atomic start: start the Pi agent run and bind `piSessionId` BEFORE writing
  // the user/card messages into `companion_messages`, so a failed start never
  // leaves a dead unclickable agent card in chat!
  const startRequest = {
    ...sanitizedPrefs,
    ...(sanitizedPrefs.modelUrl?.trim() ? { modelUrl: sanitizedPrefs.modelUrl.trim() } : {}),
    policy,
    sessionId: piSessionId,
    text: combinedPlayerText,
    model: resolvedModel,
    ...(input.target ? { target: input.target } : {}),
  };
  if (resolvedModel.profileId) {
    startRequest.profileId = resolvedModel.profileId;
  } else {
    delete startRequest.profileId;
  }
  const started = await agent.start(startRequest);

  await companion.updateSession(detail.session.id, {
    piSessionId,
    boundLineId: start.lineId,
    activeGear: "agent",
  });

  const userMsg = (
    await companion.appendMessage(detail.session.id, {
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      role: "user",
      gear: "agent",
      status: "done",
      content: requestText,
    })
  ).message;

  const agentMsg = (
    await companion.appendMessage(detail.session.id, {
      parentId: userMsg.id,
      role: "assistant",
      gear: "agent",
      status: "done",
      content: `已交给改档助手处理（方式：${policy === "preview" ? "先看预览" : policy === "auto" ? "自动采用" : "可撤回项自动采用"}）。`,
      piTaskId: started.taskId,
      modelId: resolvedModel.model,
    })
  ).message;

  return {
    piSessionId,
    taskId: started.taskId,
    runId: started.runId,
    userMessage: userMsg,
    agentMessage: agentMsg,
  };
}

export async function steerCompanionAgent(
  game: Game,
  input: {
    sessionId: string;
    piSessionId: string;
    taskId: string;
    text: string;
    phase?: string;
    delivery?: "steer" | "queued";
    policy?: AgentPolicy | "review";
  },
): Promise<{
  delivery: "steer" | "queued";
  userMessage: CompanionMessage;
  noteMessage: CompanionMessage;
}> {
  const requestText = input.text.trim();
  if (!requestText) throw new Error("请输入要补充给改档任务的说明。");
  if (!game.llm) throw new Error("请先在设置中配置 AI 服务与模型。");

  const [prefs, policy] = await Promise.all([
    getAgentPreferences(game),
    resolveCompanionAgentPolicy(game, input.policy),
  ]);
  const resolvedModel = await resolveEscalatedAgentModel(game, prefs);
  const sanitizedPrefs = sanitizePrefsForResolvedModel(prefs, resolvedModel);
  const requestedDelivery: "steer" | "queued" =
    input.phase === "closing" || input.phase === "committing"
      ? "queued"
      : (input.delivery ?? "steer");

  const directSteer = (
    game.platform as Platform & {
      agent?: {
        steer?: (args: {
          sessionId: string;
          taskId: string;
          text: string;
          delivery: "steer" | "queued";
        }) => Promise<{ delivery?: "steer" | "queued" } | void>;
      };
    }
  ).agent?.steer;

  let actualDelivery: "steer" | "queued" = requestedDelivery;
  if (directSteer && !game.platform.execution?.agent) {
    const res = await directSteer({
      sessionId: input.piSessionId,
      taskId: input.taskId,
      text: requestText,
      delivery: requestedDelivery,
    });
    if (res && (res.delivery === "steer" || res.delivery === "queued")) {
      actualDelivery = res.delivery;
    }
  } else {
    const agent = new AgentClient(game);
    const enqueueRequest = {
      ...sanitizedPrefs,
      ...(sanitizedPrefs.modelUrl?.trim() ? { modelUrl: sanitizedPrefs.modelUrl.trim() } : {}),
      policy,
      sessionId: input.piSessionId,
      text: requestText,
      model: resolvedModel,
    };
    if (resolvedModel.profileId) {
      enqueueRequest.profileId = resolvedModel.profileId;
    } else {
      delete enqueueRequest.profileId;
    }
    const accepted = await agent.enqueue(input.taskId, requestText, requestedDelivery, enqueueRequest);
    if (accepted.delivery === "steer" || accepted.delivery === "queued") {
      actualDelivery = accepted.delivery;
    }
  }

  const companion = new CompanionClient(game);
  const userMessage = (
    await companion.appendMessage(input.sessionId, {
      role: "user",
      gear: "agent",
      status: "done",
      content: requestText,
    })
  ).message;
  const noteMessage = (
    await companion.appendMessage(input.sessionId, {
      parentId: userMessage.id,
      role: "system_note",
      gear: "agent",
      status: "done",
      content:
        actualDelivery === "queued"
          ? "补充要求已排队，将在当前改档步骤收尾后接着执行"
          : "补充要求已同步给正在执行的改档任务，将在下一步处理",
    })
  ).message;

  return { delivery: actualDelivery, userMessage, noteMessage };
}
