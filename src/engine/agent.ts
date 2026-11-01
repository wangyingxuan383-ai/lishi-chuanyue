import type { AgentExecutionSnapshot, AgentProjectionMessage, AgentProjectionStep, Json } from "../platform";
import type { Game, LlmConfig } from "./game";
import { asJson } from "./execution";

export type AgentPolicy = "auto-reversible" | "preview" | "auto";
export interface AgentLimits { modelRequests: number; toolCalls: number; activeMs: number }
export type AgentProtocol = "chat-completions" | "openai-responses" | "anthropic" | "gemini";
export interface AgentSkill { id: string; name: string; description: string; version: string; content: string; files?: Record<string, string>; source?: string; hash?: string; capabilities?: string[]; compatibility?: string | string[] | { javascript?: boolean; unsupportedScripts?: string[]; message?: string } }
export interface AgentSkillDraft extends AgentSkill { taskId?: string; status?: string; warnings?: string[] }
export interface AgentExternalSource { id: string; kind: string; title?: string; url?: string; createdAt: string }
export interface AgentExternalText { title?: string; url?: string; text: string; source: { capturedAt?: string }; nextOffset: number | null }
export interface AgentToolPackage { id: string; packageId?: string; name: string; description?: string; version: string; hash: string; enabled: boolean; draft?: boolean; compatibility: { supported: boolean; missing: string[]; tools: { entry: string; name: string }[]; subset: string } }
export interface AgentDocumentGrant { id: string; name: string; directory: boolean; writable: boolean; enabled: boolean; revision: number }
export interface AgentInput { id: string; taskId?: string; sessionId?: string; text: string; delivery?: "steer" | "queued" | "answer"; status?: string; seq?: number }
export interface AgentQuestion { id: string; title?: string; status?: string; questions: { id: string; question: string; options?: { label: string; description?: string }[]; allowFreeText?: boolean; multiple?: boolean }[] }
export interface AgentPlanItem { id?: string; title?: string; step?: string; text?: string; status: string }
export interface AgentNetwork {
  mode: "off" | "auto" | "native" | "configured";
  search?: { provider: "tavily"; slot: string; url?: string };
  native?: { binding?: "task" | "profile"; protocol?: "openai-responses" | "gemini" | "anthropic"; enabled: boolean; url?: string; model?: string; slot?: string };
  mcps?: { id: string; name: string; url: string; slot?: string; enabled: boolean; allowedTools?: string[]; readOnlyTools?: string[]; authorizationVersion?: number; authorizationIdentity?: string; allowResources?: boolean }[];
}
export interface AgentPreferences {
  profileId?: string;
  /** The next Agent task's selection; running tasks keep their model snapshot. */
  modelName?: string;
  policy: AgentPolicy;
  skills: string[];
  customSkills: AgentSkill[];
  network: AgentNetwork;
  limits: AgentLimits;
  limitsVersion?: 2;
  readOnly?: boolean;
  inputTokens?: number;
  /** Version 2 stores the Agent's own token budget rather than a play ratio. */
  inputBudgetVersion?: 2;
  protocol?: AgentProtocol;
  modelUrl?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}
export interface AgentSession { id: string; worldId: string; lineId: string; title: string; createdAt: string; updatedAt: string }
export interface AgentSessionPage { sessions: AgentSession[]; nextOffset?: number | null }
export interface AgentMessage extends AgentProjectionMessage {}
export interface AgentBudget {
  modelRequests: number; toolCalls: number; activeMs: number; usageKnown?: boolean;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
  priceKnown?: boolean; estimatedCost?: number | null; currency?: string | null;
}
export interface AgentContextState {
  usedTokens?: number | null; effectiveInputBudgetTokens: number; requestedTokens?: number; outputReserveTokens?: number;
  modelWindowTokens?: number | null; measurement?: "pending" | "estimated" | "unknown"; lastRequestInputTokens?: number | null;
  requestId?: string; requestModel?: string; requestCompactionVersion?: number; lastRequestEstimatedTokens?: number; estimateRatio?: number;
  lastRequestAt?: string | null; compactions?: number; lastCompactionAt?: string | null; tokensBefore?: number; summaryChars?: number; updatedAt?: string;
}
export interface ResumeCheck { canContinue: boolean; reasonCode: string; message: string; needsRebase: boolean; routeChanged: boolean; currentLineId:string; worldId: string; lineId: string; used: AgentBudget; limits: AgentLimits }
export interface AgentTask {
  id: string; runId: string; sessionId: string; text?: string; status: string; policy: AgentPolicy;
  model?: LlmConfig; inputTokens?: number; limits: AgentLimits; budget?: AgentBudget;
  inputBudget?: AgentInputBudget;
  summary?: string; error?: string; preview?: Json; changes?: Json; result?: Json;
  execution?: { attemptId: string; phase: string; ownerStatus: string; hostActive?: boolean; formalStatus?: string; detailPhase?: string; lastHeartbeatAt?: number | null; progress?: { coverage?: number }; notice?: { decision?: string; reason?: string }; stopReceipt?: { accepted: boolean; settled: boolean } };
  phase?: string; plan?: AgentPlanItem[]; question?: AgentQuestion | null; questions?: AgentQuestion[];
  inputs?: AgentInput[]; context?: Json; subtasks?: Json[]; skillDrafts?: AgentSkillDraft[]; readOnly?: boolean;
  canUndo?: boolean;
  contextCheckpoint?: Json; contextState?: AgentContextState;
  canonVerificationVersion?: number; requiresOriginalEvidence?: boolean;
  createdAt?: string; updatedAt?: string;
}
export interface AgentSessionDetail { session: AgentSession; messages: AgentMessage[]; tasks: AgentTask[]; inputs?: AgentInput[]; nextOffset?: number | null; projectionTruncated?: boolean }
export interface AgentChangeResult { worldChanged: boolean; summary?: string; changes?: Json[]; headId?: string; undoable?: boolean; undone?: boolean }
export interface AgentStart extends AgentPreferences {
  sessionId: string; text: string; model: LlmConfig; target?: { nodeId: string; paragraph?: number };
}
export type AgentSnapshot = AgentExecutionSnapshot<AgentTask>;
export interface AgentToolStep extends AgentProjectionStep {}

/** Select a saved native service. The host resolves its credentials and endpoint grant. */
export function agentModelReference(model: LlmConfig, inputTokens = model.contextTokens): Json {
  return asJson({ slot: model.slot, model: model.model, protocol: model.protocol,
    ...(inputTokens !== undefined ? { inputTokens, contextTokens: inputTokens } : {}),
    ...(model.contextWindowTokens !== undefined ? { contextWindowTokens: model.contextWindowTokens } : {}),
    ...((model.maxOutputTokens ?? model.maxTokens) !== undefined ? { maxOutputTokens: model.maxOutputTokens ?? model.maxTokens } : {}),
  });
}
function taskModel(task: AgentTask): AgentTask {
  if (!task.model) return task;
  const saved = task.model as LlmConfig & { id?: string; inputTokens?: number };
  const inputTokens = task.inputTokens ?? saved.inputTokens ?? saved.contextTokens;
  const model = { ...saved, url: "", model: saved.model ?? saved.id ?? "", contextTokens: inputTokens,
    contextWindowTokens: typeof saved.contextWindowTokens === "number" ? saved.contextWindowTokens : undefined };
  return { ...task, model, ...(inputTokens !== undefined ? { inputTokens, inputBudget: agentInputBudget({ inputTokens,
    contextWindowTokens: model.contextWindowTokens, maxOutputTokens: model.maxOutputTokens ?? model.maxTokens }) } : {}) };
}
export function agentTaskProjection(task: AgentTask, snapshot?: AgentSnapshot): AgentTask {
  if (!snapshot || snapshot.task.id !== task.id || snapshot.task.sessionId !== task.sessionId || task.status === "undone"
      || (task.updatedAt && snapshot.task.updatedAt && task.updatedAt > snapshot.task.updatedAt)) return task;
  return snapshot.task;
}
export function mergeAgentDelta(previous: AgentSnapshot|undefined, fresh: AgentSnapshot): AgentSnapshot {
  const messages=[...new Map([...(previous?.messages??[]),...fresh.messages].map(item=>[item.id,item])).values()];
  const steps=[...new Map([...(previous?.steps??[]),...fresh.steps].map(item=>[item.id,item])).values()].slice(-200);
  return {...fresh,messages,steps,events:agentSnapshotEvents(previous,fresh)};
}
export function agentTaskStatus(task: AgentTask, snapshot?: AgentSnapshot): string {
  const current = agentTaskProjection(task, snapshot);
  if (current.execution?.phase === "stopping") return "stopping";
  if (current.execution?.phase === "closing" && current.execution.hostActive) return "committing";
  if (current.execution?.hostActive && current.execution.ownerStatus === "lost") return "interrupted";
  if (current.status === "running" && current.execution?.ownerStatus === "lost") return "interrupted";
  if (current.status === "running" && current.phase === "compacting") return "compacting";
  const result = current.result;
  if (["committed", "completed"].includes(current.status) && result && typeof result === "object" && !Array.isArray(result)
      && ["partial", "blocked"].includes(String(result.goalStatus))) return String(result.goalStatus);
  if (current.status === "completed" && result && typeof result === "object" && !Array.isArray(result)
      && ["answered", "partial", "blocked"].includes(String(result.status))) return String(result.status);
  return current.status;
}
/** Even a finished run can have unread event pages; do not freeze its cursor early. */
export function agentSnapshotNeedsRead(previous: AgentSnapshot | undefined, status: string, sameVersion: boolean): boolean {
  return !previous || previous.hasMore === true || previous.hasMoreCalls === true || ["running", "committing", "compacting"].includes(previous.status)
    || ["running", "committing", "compacting"].includes(status) || !sameVersion;
}
export function agentSnapshotEvents(previous: AgentSnapshot | undefined, fresh: AgentSnapshot): AgentSnapshot["events"] {
  const events = new Map<number, AgentSnapshot["events"][number]>();
  for (const event of [...(previous?.events ?? []), ...fresh.events]) events.set(event.seq, event);
  return [...events.values()].sort((a, b) => a.seq - b.seq).slice(-2000);
}
/** Native snapshots own projected messages. Replace each task's stream by identity. */
export function agentSessionProjection(detail: AgentSessionDetail, snapshots: Record<string, AgentSnapshot>): AgentSessionDetail {
  const tasks = detail.tasks.map(task => agentTaskProjection(task, snapshots[task.runId]));
  const messages: AgentMessage[] = detail.messages.filter(message => !message.taskId);
  const byTask = new Map<string, AgentMessage[]>();
  for (const message of detail.messages) if (message.taskId) {
    const group = byTask.get(message.taskId) ?? [];
    group.push(message); byTask.set(message.taskId, group);
  }
  for (const task of tasks) {
    const snapshot = snapshots[task.runId];
    const fresh = snapshot && snapshot.task === task;
    const prior=byTask.get(task.id) ?? [];
    messages.push(...(fresh ? snapshot.incremental ? [...new Map([...prior,...snapshot.messages].map(message=>[message.id,message])).values()] : snapshot.messages : prior));
  }
  return { ...detail, tasks, messages };
}
/** Paging changes only the visible projection; it never supplies model context. */
export function mergeAgentSessionPage(current: AgentSessionDetail | null, page: AgentSessionDetail, direction: "latest" | "older"): AgentSessionDetail {
  if (!current || current.session.id !== page.session.id) return page;
  const ordered = direction === "older" ? [page, current] : [current, page];
  const tasks = [...new Map(ordered.flatMap(part => part.tasks).map(task => [task.id, task])).values()]
    .sort((a, b) => a.createdAt && b.createdAt ? a.createdAt.localeCompare(b.createdAt) || b.id.localeCompare(a.id) : 0);
  const messages = [...new Map(ordered.flatMap(part => part.messages).map(message => [message.id, message])).values()];
  const taskIds = new Set(tasks.map(task => task.id));
  const prefix = messages.filter(message => !message.taskId || !taskIds.has(message.taskId));
  const byTask = new Map<string, AgentMessage[]>();
  for (const message of messages) if (message.taskId && taskIds.has(message.taskId)) {
    const group = byTask.get(message.taskId) ?? [];
    group.push(message); byTask.set(message.taskId, group);
  }
  const previousIds = new Set(current.tasks.map(task => task.id));
  const newHead = page.tasks.findIndex(task => previousIds.has(task.id));
  // Native task pages are chronological, so the newest page's new suffix
  // shifts an existing offset. Cached non-contiguous history must not make
  // the cursor jump over a missing page after a long absence.
  const newCount = newHead < 0 ? 0 : page.tasks.slice(newHead + 1).filter(task => !previousIds.has(task.id)).length;
  const nextOffset = direction === "older" ? page.nextOffset
    : page.nextOffset == null || current.nextOffset === null && newHead >= 0 ? null
      : newHead >= 0 && current.nextOffset != null ? current.nextOffset + newCount : page.nextOffset;
  const latest = direction === "older" ? current : page;
  return { ...latest, tasks, messages: [...prefix, ...tasks.flatMap(task => byTask.get(task.id) ?? [])], nextOffset,
    projectionTruncated: current.projectionTruncated || page.projectionTruncated };
}

export const BUILTIN_AGENT_SKILLS = [
  { id: "canon-reference", name: "遵循原著", description: "搜索和阅读原文，逐项核对人物、设定与剧情，保留本局合理改写。", version: "1.6.0" },
  { id: "story-writing", name: "故事写作", description: "按任务创作正式剧情，区分正文与执行说明。", version: "1.4.0" },
  { id: "world-upkeep", name: "世界整理", description: "校对和整理人物、记忆、规则与关联状态。", version: "1.3.0" },
  { id: "historical-world", name: "历史世界", description: "核对时代、称谓、日期和历史背景。", version: "1.1.0" },
  { id: "script-play", name: "剧本", description: "参考本局可编辑剧本，尊重玩家行动。", version: "1.0.0" },
  { id: "challenge-play", name: "挑战", description: "处理本局挑战目标与期限。", version: "1.1.0" },
  { id: "spectator-play", name: "旁观", description: "依照玩家幕后要求推进旁观故事。", version: "1.0.0" },
] as const;

/** Zero means no task-level ceiling; interpreter resource limits are separate. */
export const DEFAULT_AGENT_LIMITS: AgentLimits = { modelRequests: 0, toolCalls: 0, activeMs: 0 };
export const DEFAULT_AGENT_INPUT_TOKENS = 475_000;
export const DEFAULT_AGENT_OUTPUT_TOKENS = 8192;
export interface AgentInputBudget {
  requestedTokens: number;
  effectiveTokens: number;
  estimatedChars?: number;
  calibrated: boolean;
  tokensPerUnit?: number;
  contextWindowTokens?: number | null;
  outputReserveTokens: number;
  estimated: boolean;
  legacy: boolean;
}
/** Only an explicitly configured model window limits the separate input target. */
export function agentInputBudget(settings: Pick<AgentPreferences, "inputTokens" | "contextWindowTokens" | "maxOutputTokens">): AgentInputBudget {
  const requestedTokens = settings.inputTokens ?? DEFAULT_AGENT_INPUT_TOKENS;
  const outputReserveTokens = settings.maxOutputTokens ?? DEFAULT_AGENT_OUTPUT_TOKENS;
  const contextWindowTokens = settings.contextWindowTokens;
  const effectiveTokens = contextWindowTokens === undefined ? requestedTokens : Math.max(0, Math.min(requestedTokens, contextWindowTokens - outputReserveTokens));
  return { requestedTokens, effectiveTokens, outputReserveTokens, contextWindowTokens, estimated: true, calibrated: false, legacy: false };
}
const DEFAULT_PREFERENCES: AgentPreferences = { policy: "auto-reversible", skills: [], customSkills: [], network: { mode: "auto" }, limits: DEFAULT_AGENT_LIMITS, limitsVersion: 2, inputTokens: DEFAULT_AGENT_INPUT_TOKENS, inputBudgetVersion: 2 };

/** These settings contain only resource locators. Credentials stay in secret slots. */
export async function getAgentPreferences(game: Game): Promise<AgentPreferences> {
  const saved = await game.repo.getSetting<Partial<AgentPreferences>>("agent:preferences", {});
  const upgradeDefault = saved.inputBudgetVersion !== 2 && (saved.inputTokens === undefined || saved.inputTokens === 12_000);
  const limits = { ...DEFAULT_AGENT_LIMITS, ...saved.limits };
  if (saved.limitsVersion !== 2) {
    if (limits.modelRequests === 30) limits.modelRequests = 0;
    if (limits.toolCalls === 100) limits.toolCalls = 0;
    if (limits.activeMs === 900_000) limits.activeMs = 0;
  }
  return { ...structuredClone(DEFAULT_PREFERENCES), ...saved, inputTokens: upgradeDefault ? DEFAULT_AGENT_INPUT_TOKENS : saved.inputTokens ?? DEFAULT_AGENT_INPUT_TOKENS, inputBudgetVersion: 2, limitsVersion: 2, network: { ...DEFAULT_PREFERENCES.network, ...saved.network }, limits };
}
export async function saveAgentPreferences(game: Game, preferences: AgentPreferences): Promise<void> {
  const { modelRequests, toolCalls, activeMs } = preferences.limits;
  if (!Number.isInteger(modelRequests) || modelRequests < 0 || modelRequests > 300 || !Number.isInteger(toolCalls) || toolCalls < 0 || toolCalls > 1000 || !Number.isFinite(activeMs) || activeMs !== 0 && (activeMs < 60_000 || activeMs > 7_200_000)) throw new Error("请填写有效的执行上限，关闭限制时使用0");
  if (preferences.inputTokens !== undefined && (!Number.isInteger(preferences.inputTokens) || preferences.inputTokens < 2000 || preferences.inputTokens > 2_000_000)) throw new Error("输入预算请填写2000到2000000之间的整数");
  if (preferences.contextWindowTokens !== undefined && (!Number.isInteger(preferences.contextWindowTokens) || preferences.contextWindowTokens < 2000)) throw new Error("模型总窗口请填写不小于2000的整数，或留空");
  if (preferences.maxOutputTokens !== undefined && (!Number.isInteger(preferences.maxOutputTokens) || preferences.maxOutputTokens < 1)) throw new Error("输出上限请填写正整数，或留空");
  if (agentInputBudget(preferences).effectiveTokens <= 0) throw new Error("输出预留应小于模型总窗口，请调整后保存");
  await game.repo.setSetting("agent:preferences", { ...preferences, inputTokens: preferences.inputTokens ?? DEFAULT_AGENT_INPUT_TOKENS, inputBudgetVersion: 2, limitsVersion: 2 });
}

/** Dedicated RPC; it never rebinds the ordinary story's model or transcript. */
export class AgentClient {
  constructor(private readonly game: Game) {}
  private async call<T>(request: unknown): Promise<T> {
    if (!this.game.platform.execution?.agent) throw new Error("当前环境还不能运行 Agent 助手，请使用应用或本机开发宿主");
    return await this.game.platform.execution.agent(asJson(request)) as unknown as T;
  }
  async list(worldId: string, lineId: string): Promise<AgentSession[]> { return (await this.sessionList(worldId, lineId)).sessions; }
  sessionList(worldId: string, lineId: string, query = "", offset = 0): Promise<AgentSessionPage> { return this.call({ op: query ? "search" : "list", worldId, lineId, ...(query ? { query } : {}), offset, limit: 50 }); }
  create(worldId: string, lineId: string, title?: string): Promise<AgentSession> { return this.call({ op: "create", worldId, lineId, title }); }
  async session(id: string, offset = 0): Promise<AgentSessionDetail> {
    const detail = await this.call<AgentSessionDetail>({ op: "session", id, offset, limit: 50 });
    return { ...detail, tasks: detail.tasks.map(taskModel) };
  }
  async snapshot(taskId: string, after = 0): Promise<AgentSnapshot> {
    const snapshot = await this.call<AgentSnapshot>({ op: "snapshot", taskId, after, limit: 200 });
    return { ...snapshot, task: taskModel(snapshot.task) };
  }
  async pollSession(id: string): Promise<AgentSessionDetail> { const detail=await this.call<AgentSessionDetail>({op:"poll_session",id,limit:50});return {...detail,tasks:detail.tasks.map(taskModel)}; }
  async delta(taskId: string, after=0, callAfter=0): Promise<AgentSnapshot> {const result=await this.call<AgentSnapshot>({op:"delta",taskId,after,callAfter});return {...result,task:taskModel(result.task)};}
  processPage(taskId: string, before?: number): Promise<{steps: AgentToolStep[];nextBefore: number|null}> {return this.call({op:"process_page",taskId,before});}
  selectOriginalRoute(taskId:string,currentLineId:string):Promise<Json> {return this.call({op:"resume_route",taskId,currentLineId});}
  async recoveryPoints(worldId:string):Promise<{id:string;createdAt:string}[]> {return (await this.call<{points:{id:string;createdAt:string}[]}>({op:"recoveries",worldId})).points;}
  restoreRecovery(recoveryId:string):Promise<Json> {return this.call({op:"restore_recovery",id:recoveryId});}
  resumeCheck(taskId: string, limits?: AgentLimits): Promise<ResumeCheck> { return this.call({op:"resume_check",taskId,limits}); }
  stopStatus(taskId: string, attemptId: string): Promise<{taskId: string;status: string;execution: NonNullable<AgentTask["execution"]>;budget?: AgentBudget;result?: Json;error?: string;updatedAt?: string}> {return this.call({op:"stop_status",taskId,attemptId});}
  stop(taskId: string, attemptId: string): Promise<unknown> { return this.call({ op: "stop", taskId, attemptId, requestId: crypto.randomUUID() }); }
  delete(id: string): Promise<{ id: string; deleted: boolean; storyChanged: boolean }> { return this.call({ op: "delete", id }); }
  rename(id: string, title: string): Promise<AgentSession> { return this.call({ op: "rename", id, title }); }
  async search(worldId: string, lineId: string, query: string): Promise<AgentSession[]> { return (await this.sessionList(worldId, lineId, query)).sessions; }
  fork(sessionId: string, messageId: string, title?: string): Promise<AgentSession & { selectedUserText?: string | null }> { return this.call({ op: "fork", sessionId, messageId, title }); }
  async start(input: AgentStart): Promise<{ taskId: string; runId: string }> {
    const inputTokens = input.inputTokens ?? DEFAULT_AGENT_INPUT_TOKENS;
    return this.call({ op: "start", ...input, inputTokens, model: agentModelReference(input.model, inputTokens) });
  }
  async enqueue(taskId: string, text: string, delivery: "steer" | "queued", request?: AgentStart): Promise<{ id?: string; status?: string; delivery?: "steer" | "queued" }> {
    const prepared = request ? { ...request, inputTokens: request.inputTokens ?? DEFAULT_AGENT_INPUT_TOKENS, model: agentModelReference(request.model, request.inputTokens ?? DEFAULT_AGENT_INPUT_TOKENS) } : undefined;
    return this.call({ op: "enqueue_input", id: crypto.randomUUID(), taskId, text, delivery, ...(prepared ? { request: prepared, sessionId: prepared.sessionId } : {}) });
  }
  answer(taskId: string, questionId: string, answers: Record<string, string>, cancelled = false): Promise<unknown> { return this.call({ op: "answer_question", id: crypto.randomUUID(), taskId, questionId, answers, cancelled }); }
  cancelQueued(inputId: string): Promise<unknown> { return this.call({ op: "cancel_queued", inputId }); }
  compact(taskId: string, inputTokens?: number, taskModel?: LlmConfig, limits?: AgentLimits, modelUrl?: string): Promise<unknown> {
    return this.call({ op: "compact", taskId, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(taskModel ? { model: agentModelReference(taskModel, inputTokens) } : {}), ...(limits ? { limits } : {}), ...(modelUrl ? { modelUrl } : {}) });
  }
  async authorizeNetwork(network: AgentNetwork): Promise<AgentNetwork> { return (await this.call<{ network: AgentNetwork }>({ op: "network_authorize", network })).network; }
  async toolPackages(): Promise<AgentToolPackage[]> { return (await this.call<{ packages: AgentToolPackage[] }>({ op: "toolpkg_list" })).packages; }
  externalSources(sessionId: string, worldId: string, offset = 0): Promise<{items: AgentExternalSource[]; nextOffset: number | null}> { return this.call({op:"external_inspect",sessionId,worldId,offset}); }
  externalSource(sessionId: string, worldId: string, id: string, offset = 0): Promise<AgentExternalText> { return this.call({op:"external_inspect",sessionId,worldId,id,offset}); }
  async documentGrants(): Promise<AgentDocumentGrant[]> { return (await this.call<{ grants: AgentDocumentGrant[] }>({ op: "document_grants" })).grants; }
  revokeDocument(id: string): Promise<unknown> { return this.call({ op: "document_revoke", id }); }
  importToolPackage(bytes: string, importId: string): Promise<AgentToolPackage> { return this.call({ op: "toolpkg_import", bytes, importId }); }
  cancelToolPackageImport(importId: string): Promise<unknown> { return this.call({ op: "toolpkg_cancel_import", importId }); }
  adoptToolPackage(id: string, hash: string): Promise<unknown> { return this.call({ op: "toolpkg_adopt", id, hash }); }
  enableToolPackage(id: string, enabled: boolean): Promise<unknown> { return this.call({ op: "toolpkg_enable", id, enabled }); }
  remoteTools(network: AgentNetwork, serverId: string): Promise<Json> { return this.call({ op: "network_tools", network, serverId }); }
  importPackage(name: string, bytes: number[]): Promise<{ draft: AgentSkillDraft }> { return this.call({ op: "package_import", name, bytes }); }
  async packageDrafts(taskId?: string): Promise<AgentSkillDraft[]> { return (await this.call<{ drafts: AgentSkillDraft[] }>({ op: "package_drafts", ...(taskId ? { taskId } : {}) })).drafts; }
  adoptPackage(draftId: string): Promise<{ skill: AgentSkill }> { return this.call({ op: "package_adopt", draftId }); }

  apply(taskId: string): Promise<AgentChangeResult> { return this.call({ op: "apply", taskId }); }
  undo(taskId: string): Promise<AgentChangeResult> { return this.call({ op: "undo", taskId }); }
  async continue(taskId: string, text?: string, limits?: AgentLimits, inputTokens?: number, taskModel?: LlmConfig, modelUrl?: string, recheck = false): Promise<{ taskId: string; runId: string }> {
    return this.call({ op: "continue", taskId, text, limits, recheck, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(taskModel ? { model: agentModelReference(taskModel, inputTokens) } : {}), ...(modelUrl ? { modelUrl } : {}) });
  }
  preferences(): Promise<AgentPreferences> { return getAgentPreferences(this.game); }
  savePreferences(value: AgentPreferences): Promise<void> { return saveAgentPreferences(this.game, value); }
}

export interface AgentConversationTurn { id: string; task?: AgentTask; messages: AgentMessage[]; toolMessages: AgentMessage[] }
/** Place each task beside its own conversation, never a second task feed at the bottom. */
export function agentConversationTurns(messages: AgentMessage[], tasks: AgentTask[]): AgentConversationTurn[] {
  const byTask = new Map(tasks.map((task) => [task.id, task])), grouped = new Map<string, AgentConversationTurn>(), turns: AgentConversationTurn[] = [];
  for (const message of messages) {
    const key = message.taskId || `message:${message.id}`;
    let turn = grouped.get(key);
    if (!turn) { turn = { id: key, task: message.taskId ? byTask.get(message.taskId) : undefined, messages: [], toolMessages: [] }; grouped.set(key, turn); turns.push(turn); }
    (message.role === "tool" ? turn.toolMessages : turn.messages).push(message);
  }
  for (const task of tasks) if (!grouped.has(task.id)) turns.push({ id: task.id, task, messages: [], toolMessages: [] });
  return turns.filter((turn) => turn.task || turn.messages.length);
}
