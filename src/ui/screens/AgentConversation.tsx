import { importMcpConfiguration } from "../../engine/agent-mcp";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AgentClient, agentConversationTurns, agentSessionProjection, mergeAgentSessionPage, mergeAgentDelta, agentTaskStatus, agentTaskProjection, agentSnapshotNeedsRead, agentSnapshotEvents, agentInputBudget, BUILTIN_AGENT_SKILLS, DEFAULT_AGENT_INPUT_TOKENS, DEFAULT_AGENT_OUTPUT_TOKENS, DEFAULT_AGENT_LIMITS, getAgentPreferences, saveAgentPreferences, type AgentInput, type AgentQuestion, type AgentSkill, type AgentSkillDraft, type AgentProtocol, type AgentLimits, type AgentMessage, type AgentNetwork, type AgentPolicy, type AgentPreferences, type AgentSession, type AgentSessionDetail, type AgentToolStep, type AgentSnapshot, type AgentTask } from "../../engine/agent";
import { chatCompletionsUrl, chatModels, explainFailure, fetchModels, listProfiles, PRESETS, type Profile } from "../../engine/llm/providers";
import type { LlmConfig } from "../../engine/game";
import type { Json } from "../../platform";
import { useApp, type Route } from "../app/context";
import { Icon } from "../components/Icon";
import { MenuSheet, Sheet } from "../components/Sheet";
import { StoryText } from "../components/StoryText";
import { Switch } from "../components/Switch";
import "./agent.css";
import { AgentToolPackages } from "./AgentToolPackages";
import { AgentSources } from "./AgentSources";
import { AgentDocuments } from "./AgentDocuments";

type AgentRoute = Extract<Route, { name: "agent" }>;
const POLICIES: [AgentPolicy, string, string][] = [
  ["auto-reversible", "自动执行、可撤回", "修改直接生效，保留本次任务恢复点。"],
  ["preview", "预览后采用", "准备好整批修改后，由你采用。"],
  ["auto", "自动执行、不可撤回", "修改直接生效，不另留本次任务的撤销副本。"],
];
const STATUSES: Record<string, string> = { running: "执行中", committing: "正在保存", committed: "修改已采用", completed: "执行已结束", answered: "已答复", partial: "部分完成", blocked: "仍有问题受阻", previewed: "预览已准备好", paused: "进度已保存", cancelled: "已停止", interrupted: "执行中断", failed: "未完成", stale: "故事已有变化", undone: "已撤回", archived: "导入的任务记录", waiting_user: "等待你补充", waiting_approval: "等待授权", compacting: "正在整理上下文", queued: "已排队" };
const inFlight = (status: string) => ["running", "committing", "compacting", "stopping"].includes(status);
const canCompact = (status: string) => ["running", "paused", "failed", "cancelled", "interrupted", "blocked"].includes(status);
const TOOL_LABELS: Record<string, string> = { list_resources: "查看本局资料", read_resource: "读取本局资料", search_resources: "搜索本局资料", stage_edit: "准备修改", stage_story_turn: "准备正式剧情", finish_task: "完成任务", list_skills: "查看可用技能", read_skill: "读取技能", read_world: "读取本局设定", check_draft: "核对草稿", search_original: "检索原著", read_original: "阅读原著", read_canon_facts: "查证原著事实", web_search: "联网搜索", read_webpage: "阅读网页", list_remote_tools: "查看 MCP 工具", call_remote_tool: "调用 MCP 工具" };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function modelFor(profile: Profile, override: string, preferences?: AgentPreferences | null): LlmConfig & { protocol: AgentProtocol; contextWindowTokens?: number; maxOutputTokens?: number } {
  const model = override.trim() || profile.mainModel, protocol = preferences?.protocol ?? "chat-completions";
  let url = chatCompletionsUrl(profile.baseUrl);
  if (protocol !== "chat-completions") {
    let base = profile.baseUrl.trim().replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|messages)$/, "");
    if (protocol === "gemini") {
      base = base.replace(/\/openai$/, "");
      if (new URL(base).pathname === "/") base += "/v1beta";
      url = `${base}/models/${encodeURIComponent(model.replace(/^models\//, ""))}:streamGenerateContent?alt=sse`;
    } else {
      if (new URL(base).pathname === "/") base += "/v1";
      url = `${base}/${protocol === "openai-responses" ? "responses" : "messages"}`;
    }
  }
  return { slot: profile.keySlot, url: preferences?.modelUrl?.trim() || url, model, auxModel: profile.auxModel ?? undefined, includeUsage: profile.includeUsage, contextTokens: preferences?.inputTokens ?? DEFAULT_AGENT_INPUT_TOKENS, protocol, ...(preferences?.contextWindowTokens ? { contextWindowTokens: preferences.contextWindowTokens } : {}), ...(preferences?.maxOutputTokens ? { maxOutputTokens: preferences.maxOutputTokens, maxTokens: preferences.maxOutputTokens } : {}) };
}
const PHASES: Record<string, string> = { closing: "正在核对已保存结果", waiting_model: "等待模型", reviewing: "复核进展", preparing: "准备修改", stopping: "正在停止", planning: "正在安排任务", reading: "正在查阅资料", tools: "正在处理资料", thinking: "正在思考", compacting: "正在整理上下文", validating: "正在核对修改", committing: "正在保存", waiting_user: "等待你补充", waiting_approval: "等待授权" };
const TASK_NAMES: Record<string, string> = { ...TOOL_LABELS, browser_open:"打开资料网页",browser_read:"读取网页正文",browser_find:"查找网页内容",browser_follow:"阅读网页链接",browser_close:"关闭资料网页",list_documents:"查看资料文件",read_document:"读取资料文件",find_document:"查找资料文件",write_document:"写出资料笔记",call_tool_package:"运行工具包",draft_tool_package:"准备工具包草稿", discover_tools: "查找可用工具", read_tool_result: "读取已保存结果", update_plan: "更新任务进度", ask_user: "请你补充信息", search_agent_history: "查找助手对话", validate_changes: "检查修改影响", read_clock: "查看故事时间", stage_clock: "调整故事时间", stage_route: "准备故事路线", run_script: "处理资料", delegate_readonly: "分工查证", read_skill_resource: "读取技能资料", draft_skill: "准备常用技能", list_mcp_resources: "查看服务资料", read_mcp_resource: "读取服务资料" };
const statusOf = agentTaskStatus;
const pendingQuestion = (task: AgentTask): AgentQuestion | undefined => task.status!=="waiting_user" ? undefined : task.question && !["answered", "cancelled", "done"].includes(task.question.status ?? "") ? task.question : task.questions?.find((question) => !["answered", "cancelled", "done"].includes(question.status ?? ""));
const pendingInputs = (inputs: AgentInput[]) => inputs.filter((input) => ["steer", "queued"].includes(input.delivery ?? "") && typeof input.text === "string" && input.text.trim() && ["pending", "queued", "accepted"].includes(input.status ?? "pending"));
const skillCompatibility = (value: AgentSkill["compatibility"]): string => typeof value === "string" ? value : Array.isArray(value) ? value.join("；") : value?.message ?? (value?.javascript ? "可使用手机内的受控 JavaScript" : "");
function messageText(message: AgentMessage): string {
  if (message.displayContent !== undefined) return message.displayContent;
  if (message.role === "user" && message.delivery === "answer" && message.content.startsWith("【玩家回答】")) {
    try {
      const value = JSON.parse(message.content.slice("【玩家回答】".length));
      const answers = value.answers ?? value;
      const lines = Object.values(answers).filter((answer): answer is string => typeof answer === "string");
      if (lines.length) return `回答：\n${lines.join("\n\n")}`;
    } catch { return "已保存回答，可在执行详情查看记录。"; }
  }
  return message.content;
}
function MessageBody({ message, latest, preserve }: { message: AgentMessage; latest: boolean; preserve: () => void }) {
  const text = messageText(message), [manual, setManual] = useState<boolean | undefined>();
  const collapsible = message.role === "assistant" || text.length > 90 || text.split("\n").length > 2;
  if (!collapsible) return <StoryText emphasizeDate={false} text={text} />;
  const open = manual ?? (message.role === "assistant" && latest);
  const preview = text.replace(/\s+/g, " ").slice(0, 90);
  return <details className="agent-message-body" open={open}><summary onClick={event => { event.preventDefault(); preserve(); setManual(!open); }}><span className="agent-message-summary">{open ? "收起内容" : preview}</span></summary>{open && <StoryText emphasizeDate={false} text={text} streaming={message.status === "streaming"} />}</details>;
}

const pretty = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(pretty).filter(Boolean).join("\n\n");
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  const text = [object.summary, object.label, object.description, object.narrative, object.text].filter((item): item is string => typeof item === "string").join("\n");
  return text || pretty(object.changes ?? object.operations ?? object.edits ?? object.preview);
};
const FIELD_LABELS: Record<string, string> = { narrative: "正文", action_text: "我的行动", action_mode: "输入方式", record: "回合记录", choices: "建议选项", settings: "故事设置", essentials: "重要设定", protagonist: "主角", people: "人物", places: "地点", cards: "设定", goals: "目标", notes: "记忆", facts: "原著事实", time: "时间", start: "开场时间", elapsedMinutes: "经过分钟", money: "钱物", health: "健康", energy: "精力", source: "参考书籍", rules: "规则", premise: "故事设定", title: "标题", name: "名字", identity: "身份", role: "身份", aliases: "别名", attitude: "态度", log: "记忆", summary: "摘要", text: "内容", state: "状态", items: "物品", statuses: "身上的状况", meta: "相关记录", factsAdd: "新增事实", factsRemove: "移除事实", sourceSet: "参考方式", instructions: "使用说明", position: "原著位置", through: "参考章节上限", era: "世界与历法", clockStyle: "日期显示", timeStyle: "时刻显示", calendar: "历法", date: "日期", anchor: "日期锚点", atElapsedMinutes: "锚点对应的实际经过分钟", ceYear: "公元年份", startHour: "开局时刻", minuteOfDay: "当天分钟", year: "年", month: "月", day: "日", eras: "年号", startCe: "起始年份", firstYear: "起始纪年", yearWord: "纪年名称", lunar: "农历" };
const PRIVATE_RESOURCE_FIELDS = new Set(["id", "world_id", "node_id", "line_id", "parent_id", "created_at", "updated_at"]);
function ValueContent({ value }: { value: unknown }): ReactNode {
  if (value === undefined || value === null) return <span className="muted">无</span>;
  if (typeof value === "string") return value ? <StoryText emphasizeDate={false} text={value} /> : <span className="muted">空</span>;
  if (typeof value === "number" || typeof value === "boolean") return <span>{typeof value === "boolean" ? value ? "是" : "否" : value}</span>;
  if (Array.isArray(value)) return value.length ? <div className="stack">{value.map((item, index) => <div className="agent-value" key={index}><ValueContent value={item} /></div>)}</div> : <span className="muted">无</span>;
  return <dl className="agent-values">{Object.entries(value as Record<string, unknown>).filter(([key]) => !PRIVATE_RESOURCE_FIELDS.has(key)).map(([key, entry]) => <div key={key}><dt>{FIELD_LABELS[key] ?? key}</dt><dd><ValueContent value={entry} /></dd></div>)}</dl>;
}
function ChangePreview({ value }: { value: Json | undefined }) {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const changes = Array.isArray(object?.changes) ? object.changes : [];
  return <div className="stack agent-change-preview">{changes.map((change, index) => {
    if (!change || typeof change !== "object" || Array.isArray(change)) return null;
    const before = change.before, after = change.after;
    const recordBefore = before && typeof before === "object" && !Array.isArray(before) ? before : null;
    const recordAfter = after && typeof after === "object" && !Array.isArray(after) ? after : null;
    const keys = recordBefore || recordAfter ? [...new Set([...Object.keys(recordBefore ?? {}), ...Object.keys(recordAfter ?? {})])].filter((key) => !PRIVATE_RESOURCE_FIELDS.has(key) && JSON.stringify(recordBefore?.[key]) !== JSON.stringify(recordAfter?.[key])) : [];
    return <section key={index}><p><b>{typeof change.summary === "string" ? change.summary : "本次修改"}</b></p>{keys.length ? keys.map((key) => <details key={key} open={key === "narrative"}><summary>{FIELD_LABELS[key] ?? key}</summary><p className="muted">修改前</p><ValueContent value={recordBefore?.[key]} /><p className="muted">修改后</p><ValueContent value={recordAfter?.[key]} /></details>) : before !== undefined || after !== undefined ? <><details><summary>修改前</summary><ValueContent value={before} /></details><details open><summary>修改后</summary><ValueContent value={after} /></details></> : <StoryText emphasizeDate={false} text={pretty(change)} />}</section>;
  })}</div>;
}
function sourceLinks(value: unknown): { url: string; title: string }[] {
  const found = new Map<string, string>();
  let count = 0;
  const scan = (item: unknown, depth = 0) => {
    if (++count > 3000 || depth > 12 || found.size >= 30) return;
    if (typeof item === "string") {
      if (item.trim().startsWith("{")) { try { scan(JSON.parse(item), depth + 1); } catch { /* Plain tool output. */ } }
      return;
    }
    if (Array.isArray(item)) { item.forEach((entry) => scan(entry, depth + 1)); return; }
    if (!item || typeof item !== "object") return;
    const object = item as Record<string, unknown>;
    const url = typeof object.url === "string" ? object.url : typeof object.link === "string" ? object.link : null;
    if (url && /^https?:\/\//i.test(url)) {
      try { const parsed = new URL(url); found.set(parsed.href, typeof object.title === "string" ? object.title : parsed.hostname); } catch { /* Ignore malformed external result links. */ }
    }
    Object.values(object).forEach((entry) => scan(entry, depth + 1));
  };
  scan(value);
  return [...found].map(([url, title]) => ({ url, title }));
}
function ContextDetails({ task }: { task: AgentTask }) {
  const contextValue = task.contextCheckpoint ?? task.context;
  const context = contextValue && typeof contextValue === "object" && !Array.isArray(contextValue) ? contextValue : {};
  const inputTokens = task.inputTokens ?? task.model?.contextTokens;
  const budget = task.inputBudget ?? (inputTokens === undefined ? undefined : { ...agentInputBudget({ inputTokens, contextWindowTokens: task.model?.contextWindowTokens, maxOutputTokens: task.model?.maxOutputTokens ?? task.model?.maxTokens }), legacy: true });
  const state=task.contextState, used=state?.usedTokens, capacity=state?.effectiveInputBudgetTokens ?? budget?.effectiveTokens;
  return <details><summary>上下文用量{typeof used==="number" && capacity ? ` · 约${Math.round(used/capacity*100)}%` : ""}</summary><div className="stack">
    {state && <p aria-live="polite">当前上下文：{typeof used==="number" ? `约 ${used.toLocaleString()} / ${capacity?.toLocaleString()} tokens（估算），剩余约 ${Math.max(0,(capacity??0)-used).toLocaleString()} tokens` : state.measurement==="pending" ? "正在整理，等待重新估算" : "暂未取得当前占用"}</p>}
    {!state && <p className="muted">暂未取得当前上下文占用；继续执行后更新，下面是配置的预算。</p>}
    {typeof state?.lastRequestInputTokens==="number" && <p>最近服务报告输入：{state.lastRequestInputTokens.toLocaleString()} tokens（含缓存，为单次请求，非累计消耗）</p>}
    {typeof state?.lastRequestEstimatedTokens==="number" && <p className="muted">对应请求发送前估算：约 {state.lastRequestEstimatedTokens.toLocaleString()} tokens；与当前窗口分别统计。</p>}
    {typeof state?.estimateRatio==="number" && (state.estimateRatio>1.35 || state.estimateRatio<0.65) && <p className="field-hint warn">最近请求估算与服务统计差异较大，当前百分比仍为估算。</p>}
    {typeof state?.compactions==="number" && <p>已整理 {state.compactions} 次{state.lastCompactionAt ? `；最近：${new Date(state.lastCompactionAt).toLocaleString("zh-CN")}` : ""}</p>}
    {typeof state?.tokensBefore==="number" && <p>最近整理前：约 {state.tokensBefore.toLocaleString()} tokens{typeof used==="number" ? `；当前约 ${used.toLocaleString()} tokens` : ""}</p>}
    {state?.updatedAt && <p className="muted">统计更新：{new Date(state.updatedAt).toLocaleString("zh-CN")}</p>}
    {budget && <p>{budget.legacy ? "旧任务记录的输入预算" : "本次输入预算"}：{budget.requestedTokens.toLocaleString()} tokens</p>}
    {budget?.legacy && <p className="muted">此旧任务仍使用旧的字符估算；继续时可采用当前 Agent 输入预算，已用次数不清零。</p>}
    {budget && !budget.legacy && <p>实际可用输入：{budget.effectiveTokens.toLocaleString()} tokens</p>}
    {budget?.contextWindowTokens ? <p>模型总窗口：{budget.contextWindowTokens.toLocaleString()} tokens；输出预留：{budget.outputReserveTokens.toLocaleString()} tokens</p> : <p className="muted">模型总窗口未填写，不按模型名称猜测容量。</p>}
    {budget && !budget.legacy && budget.effectiveTokens < budget.requestedTokens && <p className="field-hint">已按模型总窗口扣除输出预留，因此本次可用输入小于所填预算。</p>}
    {budget && !budget.legacy && <p className="muted">{budget.calibrated ? "已按本任务服务返回的用量校准 token 估算。" : "尚未按本任务实际用量校准，当前按估算管理。"}{budget.estimatedChars !== undefined ? `内部字符估算容量为 ${budget.estimatedChars.toLocaleString()} 字符，不等于 token 数。` : ""}</p>}
    {!state && typeof context.compactions === "number" && <p>已整理 {context.compactions} 次</p>}
    {!state && typeof context.beforeChars === "number" && typeof context.afterChars === "number" && <p>上次整理：{context.beforeChars.toLocaleString()} 字符 → {context.afterChars.toLocaleString()} 字符</p>}
    {!state && typeof context.tokensBefore === "number" && <p>上次整理前：约 {context.tokensBefore.toLocaleString()} tokens</p>}
    {!state && typeof context.summaryChars === "number" && <p>已保存摘要：{context.summaryChars.toLocaleString()} 字</p>}
    {!state && typeof context.at === "string" && <p className="muted">上次整理：{new Date(context.at).toLocaleString("zh-CN")}</p>}
    {typeof context.warning === "string" && <p className="field-hint warn">{context.warning}</p>}
    {typeof context.summary === "string" && <details><summary>已保存的执行摘要</summary><StoryText emphasizeDate={false} text={context.summary} /></details>}
  </div></details>;
}

export default function AgentConversation({ route }: { route: AgentRoute }) {
  const { game, pop, profile, toast, reading, ask, askName } = useApp();
  const client = useMemo(() => new AgentClient(game), [game]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [nextSessionOffset, setNextSessionOffset] = useState<number | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(route.sessionId ?? null);
  const sessionRef = useRef<string | null>(route.sessionId ?? null);
  const [detail, setDetail] = useState<AgentSessionDetail | null>(null);
  const [prefs, setPrefs] = useState<AgentPreferences | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [model, setModel] = useState("");
  const [input, setInput] = useState(route.initialText ?? "");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const inputRevision = useRef(0);
  const changeInput = (value: string) => { inputRevision.current++; setInput(value); };
  const [target, setTarget] = useState(route.target);
  const [sourceUrl, setSourceUrl] = useState<string>();
  const [sheet, setSheet] = useState<"sessions" | "settings" | "actions" | "question" | "model" | "packages" | "documents" | "sources" | null>(null);
  const [questionTaskId, setQuestionTaskId] = useState<string | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, Record<string, string>>>({});
  const [pending, setPending] = useState(false);
  const [routeChoice,setRouteChoice]=useState<{task:AgentTask;currentLineId:string}|null>(null);
  const [recoveries,setRecoveries]=useState<{id:string;createdAt:string}[]|null>(null);
  const [error, setError] = useState("");
  const [snapshots, setSnapshots] = useState<Record<string, AgentSnapshot>>({});
  const snapshotCache = useRef<Record<string, AgentSnapshot>>({});
  const snapshotVersions = useRef<Record<string, string>>({});
  const deletedSessions = useRef(new Set<string>());
  const sessionQueryRevision = useRef(0);
  const historyRevision = useRef(0);
  const conversation = useMemo(() => detail ? agentSessionProjection(detail, snapshots) : null, [detail, snapshots]);
  const alive = useRef(true);
  const stoppingTasks = useRef(new Set<string>());
  const pausedAfterStop = useRef<string | null>(null);
  const stopRevision = useRef(0);
  const requestedSkills = useRef(route.skills ?? []);
  const selected = profiles.find((item) => item.id === prefs?.profileId) ?? profile ?? profiles[0] ?? null;
  const [worldTitle, setWorldTitle] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const prependPosition = useRef<{ sessionId: string; messageId?: string; offset: number; top: number; height: number } | null>(null);
  const follow = useRef(reading.autoScroll);
  const rememberPosition = useCallback(() => {
    const el=scroller.current;if(!el || reading.autoScroll && follow.current)return;
    const top=el.getBoundingClientRect().top;
    const anchor=[...el.querySelectorAll<HTMLElement>("[data-message-id]")].find(item=>item.getBoundingClientRect().bottom>top);
    const position={sessionId:sessionRef.current??"",messageId:anchor?.dataset.messageId,offset:anchor?anchor.getBoundingClientRect().top-top:0,top:el.scrollTop,height:el.scrollHeight};
    prependPosition.current=position;
    requestAnimationFrame(()=>{
      if(prependPosition.current!==position)return;
      const item=position.messageId?[...el.querySelectorAll<HTMLElement>("[data-message-id]")].find(item=>item.dataset.messageId===position.messageId):null;
      el.scrollTop=item?el.scrollTop+item.getBoundingClientRect().top-el.getBoundingClientRect().top-position.offset:position.top;
      prependPosition.current=null;
    });
  },[reading.autoScroll]);

  const [atBottom, setAtBottom] = useState(true);
  const inputDraft = useRef({ sessionId, input });
  inputDraft.current = { sessionId, input };
  useEffect(() => () => {
    const saved = inputDraft.current;
    if (saved.sessionId && !deletedSessions.current.has(saved.sessionId)) void game.repo.setSetting(`agent:input:${saved.sessionId}`, saved.input);
  }, [game]);
  const activeTasks = conversation?.tasks.filter((task) => inFlight(statusOf(task)) || task.status === "waiting_user") ?? [];
  const busy = activeTasks.length > 0;
  const completed = useRef(new Set<string>());
  const readSessions = useCallback(async (query: string, offset = 0) => {
    const append = offset > 0;
    const revision = append ? sessionQueryRevision.current : ++sessionQueryRevision.current;
    if (!append) { setSessionQuery(query); setNextSessionOffset(null); }
    setSessionsLoading(true);
    try {
      const page = await client.sessionList(route.worldId, route.lineId, query, offset);
      if (alive.current && revision === sessionQueryRevision.current) {
        setSessions(current => append ? [...new Map([...current, ...page.sessions].map(session => [session.id, session])).values()] : page.sessions);
        setNextSessionOffset(page.nextOffset ?? null);
      }
      return page.sessions;
    } finally { if (alive.current && revision === sessionQueryRevision.current) setSessionsLoading(false); }
  }, [client, route.worldId, route.lineId]);
  const refresh = useCallback(async (id: string) => {
    const revision = historyRevision.current;
    const next = await client.session(id);
    if (alive.current && id === sessionRef.current && revision === historyRevision.current) setDetail(current => mergeAgentSessionPage(current, next, "latest"));
    return next;
  }, [client]);
  useEffect(() => {
    alive.current = true;
    let live = true;
    const draftRevision = inputRevision.current;
    void (async () => {
      const [saved, available, existing, world] = await Promise.all([getAgentPreferences(game), listProfiles(game.repo), readSessions(""), game.repo.getWorld(route.worldId)]);
      if (!live) return;
      saved.skills = [...new Set([...saved.skills, ...requestedSkills.current])];
      setPrefs(saved); setProfiles(available); setWorldTitle(world?.title ?? "");
      const id = route.sessionId ?? existing[0]?.id ?? (await client.create(route.worldId, route.lineId)).id;
      if (!live) return;
      sessionRef.current = id; setSessionId(id);
      const next = await refresh(id);
      const lastModel = next.tasks.at(-1)?.model?.model;
      const chosenProfile = available.find((item) => item.id === saved.profileId) ?? profile ?? available[0];
      setModel(saved.modelName ?? (next.tasks.at(-1)?.model?.slot === chosenProfile?.keySlot ? lastModel : undefined) ?? chosenProfile?.mainModel ?? "");
      if (!route.initialText) {
        const savedInput = await game.repo.getSetting<string>(`agent:input:${id}`, "");
        if (live && sessionRef.current === id && inputRevision.current === draftRevision) setInput(savedInput);
      }
    })().catch((failure) => { if (live) setError(errorText(failure)); });
    return () => { live = false; alive.current = false; };
  }, [client, game, route.worldId, route.lineId, route.sessionId, refresh, readSessions]);
  useEffect(() => {
    if (!sessionId) return;
    const timer = setTimeout(() => { if (!deletedSessions.current.has(sessionId)) void game.repo.setSetting(`agent:input:${sessionId}`, input); }, 250);
    return () => clearTimeout(timer);
  }, [game, sessionId, input]);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight * .2)}px`;
  }, [input]);
  // Polling is a subscription. Closing this page never stops native execution.
  useEffect(() => {
    if (!sessionId) return;
    let live = true, polling = false, lastRead = 0, wasRunning = true;
    const poll = async () => {
      if (polling || stoppingTasks.current.size > 0 || pausedAfterStop.current === sessionId) return;
      if (!wasRunning && Date.now() - lastRead < 3000) return;
      polling = true;
      const controlRevision=stopRevision.current;
      try {
        const next = await client.pollSession(sessionId);
        if (!live || sessionRef.current !== sessionId) return;
        lastRead = Date.now();
        const watched = next.tasks.slice(-8).filter((task) => !task.runId.startsWith("imported:") && task.status !== "archived").map((task) => ({ id: task.runId, status: task.status, version: `${task.status}:${task.updatedAt ?? ""}` }));
        const read = await Promise.all(watched.map(async ({ id, status, version }) => {
          const previous = snapshotCache.current[id];
          if (!agentSnapshotNeedsRead(previous, status, snapshotVersions.current[id] === version)) return [id, previous!] as const;
          const fresh = await client.delta(id, previous?.nextAfter ?? 0, previous?.nextCallAfter ?? 0);
          if (!live || sessionRef.current !== sessionId) return [id, previous ?? fresh] as const;
          const nextSnapshot = mergeAgentDelta(previous, fresh);
          snapshotCache.current[id] = nextSnapshot; snapshotVersions.current[id] = version;
          return [id, nextSnapshot] as const;
        }));
        if (!live) return;
        rememberPosition(); setDetail(current => mergeAgentSessionPage(current, next, "latest")); setSnapshots((current) => ({ ...current, ...Object.fromEntries(read) }));
        wasRunning = read.some(([, snapshot]) => inFlight(snapshot.task ? statusOf(snapshot.task, snapshot) : snapshot.status));
        for (const [id, snap] of read) if (snap.status === "committed" && !completed.current.has(id)) { completed.current.add(id); game.notifyAgentChange(route.worldId); }
      } catch (failure) { if (live && controlRevision===stopRevision.current) setError(errorText(failure)); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1100);
    return () => { live = false; clearInterval(timer); };
  }, [client, game, route.worldId, route.lineId, sessionId]);
  const stopTask = async (task: AgentTask) => {
    const current=agentTaskProjection(task,snapshotCache.current[task.runId]),attempt=current.execution?.attemptId;
    if (!attempt || stoppingTasks.current.has(task.id)) return;
    stoppingTasks.current.add(task.id);stopRevision.current++;setError("");
    try {
      await client.stop(task.id,attempt);
      pausedAfterStop.current=task.sessionId;
      for(let read=0;read<150 && alive.current;read++) {
        const state=await client.stopStatus(task.id,attempt);
        if (!alive.current || sessionRef.current!==task.sessionId) break;
        const next={...current,status:state.status,execution:state.execution,budget:state.budget??current.budget,result:state.result??current.result,error:state.error,updatedAt:state.updatedAt};
        if(state.status==="committed"&&!completed.current.has(task.id)){completed.current.add(task.id);game.notifyAgentChange(route.worldId);}
        const prior=snapshotCache.current[task.runId];
        const snap:AgentSnapshot=prior?{...prior,task:next,status:state.status,error:state.error??null}:{id:task.runId,worldId:route.worldId,task:next,status:state.status,error:state.error??null,result:current.result??null,events:[],messages:[],steps:[],incremental:true};
        snapshotCache.current[task.runId]=snap;setSnapshots(values=>({...values,[task.runId]:snap}));
        if(state.execution.stopReceipt?.settled){if(["committed","completed","previewed"].includes(state.status))pausedAfterStop.current=null;break;}
        await new Promise(resolve=>setTimeout(resolve,200));
      }
    }catch(failure){if(alive.current)setError(errorText(failure));}finally{stoppingTasks.current.delete(task.id);}
  };
  const act = async (work: () => Promise<unknown>) => {
    pausedAfterStop.current=null;
    if (pending) return;
    setPending(true); setError("");
    const controlRevision=stopRevision.current;
    try { await work(); if (controlRevision===stopRevision.current && sessionRef.current) await refresh(sessionRef.current); }
    catch (failure) { if (alive.current && controlRevision===stopRevision.current) setError(errorText(failure)); }
    finally { if (alive.current) setPending(false); }
  };
  const makeRequest = () => sessionId && prefs && selected ? { ...prefs, sessionId, text: input.trim(), model: modelFor(selected, model, prefs), ...(target ? { target } : {}) } : null;
  const clearSentInput = async () => {
    setTarget(undefined); changeInput("");
    if (sessionId) await game.repo.setSetting(`agent:input:${sessionId}`, "");
  };
  const send = (delivery: "steer" | "queued" = "steer") => void act(async () => {
    const request = makeRequest();
    if (!request || !input.trim()) return;
    const active = activeTasks.at(-1);
    if (busy && !active) throw new Error("请先完成或停止上次的生成");
    if (active?.status === "waiting_user") throw new Error("请先回答助手的问题，或停止这项任务后再发送新要求");
    if (active) {
      const actualDelivery = active.execution?.phase === "closing" ? "queued" : delivery;
      const accepted = await client.enqueue(active.id, input.trim(), actualDelivery, request);
      toast((accepted.delivery ?? delivery) === "queued" ? "已排队，当前任务完成后执行" : "补充已接收，将在下一步处理");
    } else await client.start(request);
    await clearSentInput();
  });
  const changeSession = async (id: string, savePreviousDraft = true) => {
    if (sessionId && savePreviousDraft) await game.repo.setSetting(`agent:input:${sessionId}`, input);
    const draftRevision = ++inputRevision.current;
    historyRevision.current++; prependPosition.current = null; setOlderLoading(false);
    sessionRef.current = id; setSessionId(id); setDetail(null); setSnapshots({}); snapshotCache.current = {}; snapshotVersions.current = {}; setError("");
    const savedInput = await game.repo.getSetting<string>(`agent:input:${id}`, "");
    if (sessionRef.current === id && inputRevision.current === draftRevision) setInput(savedInput);
    const loaded = await refresh(id);
    if (!alive.current || sessionRef.current !== id || inputRevision.current !== draftRevision) return;
    setModel(prefs?.modelName ?? (loaded.tasks.at(-1)?.model?.slot === selected?.keySlot ? loaded.tasks.at(-1)?.model?.model : undefined) ?? selected?.mainModel ?? "");
    setSheet(null);
  };
  const newSession = () => void act(async () => {
    const made = await client.create(route.worldId, route.lineId);
    await readSessions("");
    await changeSession(made.id);
  });
  const tasks = conversation?.tasks ?? [];
  const last = tasks.at(-1);
  const liveTask = activeTasks.at(-1);
  const scrollBottom = (smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    follow.current = reading.autoScroll && bottom; setAtBottom(bottom);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    const position = prependPosition.current;
    if (el && position && position.sessionId === conversation?.session.id) {
      const anchor = position.messageId ? [...el.querySelectorAll<HTMLElement>("[data-message-id]")].find(item => item.dataset.messageId === position.messageId) : null;
      el.scrollTop = anchor ? el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - position.offset : position.top + el.scrollHeight - position.height;
      prependPosition.current = null;
    } else if (reading.autoScroll && follow.current) scrollBottom();
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }, [conversation, reading.autoScroll]);
  const loadOlder = async () => {
    const id = sessionRef.current, offset = detail?.nextOffset;
    if (!id || detail?.session.id !== id || offset == null || olderLoading) return;
    const revision = historyRevision.current;
    setOlderLoading(true);
    try {
      const page = await client.session(id, offset);
      if (!alive.current || sessionRef.current !== id || historyRevision.current !== revision) return;
      const el = scroller.current;
      if (el) {
        const top = el.getBoundingClientRect().top;
        const anchor = [...el.querySelectorAll<HTMLElement>("[data-message-id]")].find(item => item.getBoundingClientRect().bottom > top);
        prependPosition.current = { sessionId: id, messageId: anchor?.dataset.messageId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, top: el.scrollTop, height: el.scrollHeight };
        follow.current = false;
      }
      setDetail(current => current?.session.id === id ? mergeAgentSessionPage(current, page, "older") : current);
    } catch (failure) { if (alive.current && sessionRef.current === id && historyRevision.current === revision) setError(errorText(failure)); }
    finally { if (alive.current && sessionRef.current === id && historyRevision.current === revision) setOlderLoading(false); }
  };
  const turns = agentConversationTurns(conversation?.messages ?? [], tasks);
  const queue = pendingInputs(detail?.inputs ?? tasks.flatMap((task) => task.inputs ?? []));
  const questionTask = tasks.find((task) => task.id === questionTaskId);
  const question = questionTask ? pendingQuestion(questionTask) : undefined;
  const openQuestion = (task: AgentTask) => { setQuestionTaskId(task.id); setSheet("question"); };
  const renameSession = (session: AgentSession) => void act(async () => {
    const title = await askName({ title: "对话名称", initial: session.title, confirm: "保存" });
    if (title) { await client.rename(session.id, title); await readSessions(""); }
  });
  const deleteSession = (session: AgentSession) => void act(async () => {
    if (!await ask({ title: "删除这段助手对话？", message: "对话、过程与未采用草稿会删除，已经生效的故事修改和恢复点保留。正在执行的任务会先停止。", confirm: "删除对话", danger: true })) return;
    const deleted = await client.delete(session.id);
    if (!deleted.deleted) throw new Error("对话尚未删除，请稍后重试");
    deletedSessions.current.add(session.id);
    await game.repo.setSetting(`agent:input:${session.id}`, "");
    const remaining = await readSessions("");
    if (sessionRef.current === session.id) {
      const next = remaining[0] ?? await client.create(route.worldId, route.lineId);
      await changeSession(next.id, false);
      if (!remaining.length) setSessions([next]);
    }
    toast("对话已删除，故事修改保留");
  });
  const forkAt = (message: AgentMessage) => void act(async () => {
    if (!sessionId) return;
    const made = await client.fork(sessionId, message.id);
    await readSessions(""); await changeSession(made.id);
    if (!alive.current || sessionRef.current !== made.id) return;
    if (typeof made.selectedUserText === "string") changeInput(made.selectedUserText);
    else if (message.role === "user") changeInput(messageText(message));
    toast("已另起对话，故事修改不会自动撤回");
  });
  const continueTask = (task: AgentTask) => void act(async () => {
    const check=await client.resumeCheck(task.id,prefs?.limits);
    if(check.routeChanged){setRouteChoice({task,currentLineId:check.currentLineId});return;}
    if(!check.canContinue && !check.needsRebase) {
      if(check.reasonCode==="budget_exhausted")setSheet("settings");
      throw new Error(check.message);
    }

    await client.continue(task.id,input.trim()||undefined,prefs?.limits,prefs?.inputTokens??DEFAULT_AGENT_INPUT_TOKENS,prefs&&selected?modelFor(selected,model,prefs):task.model,prefs?.modelUrl,check.needsRebase);
    changeInput("");
  });
  const compactTask = (task: AgentTask) => void act(async () => { await client.compact(task.id, prefs?.inputTokens ?? DEFAULT_AGENT_INPUT_TOKENS, prefs && selected ? modelFor(selected, model, prefs) : task.model, prefs?.limits, prefs?.modelUrl); toast("已安排整理上下文"); });
  const inspectTask = (task: AgentTask) => {
    const previous = snapshotCache.current[task.runId];
    if ((previous && !previous.hasMore) || task.runId.startsWith("imported:") || task.status === "archived") return;
    const expectedSession = sessionRef.current;
    void client.snapshot(task.id, previous?.nextAfter ?? 0).then((fresh) => {
      if (!alive.current || sessionRef.current !== expectedSession) return;
      const snapshot = { ...fresh, events: agentSnapshotEvents(snapshotCache.current[task.runId], fresh) };
      snapshotCache.current[task.runId] = snapshot;
      setSnapshots((current) => ({ ...current, [task.runId]: snapshot }));
    }).catch((failure) => setError(errorText(failure)));
  };
  const querySessions = (value: string) => {
    const revision = sessionQueryRevision.current + 1;
    void readSessions(value).catch((failure) => { if (alive.current && revision === sessionQueryRevision.current) setError(errorText(failure)); });
  };
  return <div className="play agent-conversation">
    <div className="topbar">
      <button className="icon-btn" aria-label="返回故事" onClick={pop}><Icon name="back" /></button>
      <div className="title"><h1>Agent 助手</h1><div className="subtitle">{worldTitle}</div></div>
      <button className="icon-btn" aria-label="Agent 对话记录" onClick={() => { setSheet("sessions"); querySessions(""); }}><Icon name="book" /></button>
      <button className="icon-btn" aria-label="Agent 执行设置" onClick={() => setSheet("settings")}><Icon name="settings" /></button>
    </div>
    <div className="agent-reading"><div className="story agent-messages" ref={scroller} onScroll={onScroll}><div className="story-inner">
      {detail?.nextOffset != null && <button className="ghost" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? "正在读取…" : "更早的对话"}</button>}
      {!conversation?.messages.length && <p className="muted">告诉助手要查什么、改什么。它可以按需读取和修改本局；这里只保存助手对话，正式修改会回到故事中。</p>}
      {target && <p className="muted">已带入要修改的{target.paragraph === undefined ? "回合" : `第 ${target.paragraph + 1} 段`}，正文由助手按需读取。</p>}
      {turns.map((turn) => <section className="agent-turn" data-task-id={turn.task?.id} key={turn.id}>
        {!turn.messages.length && turn.task?.text && <div className="agent-message user"><small className="muted">你</small><StoryText emphasizeDate={false} text={turn.task.text} /></div>}
        {turn.messages.map((message) => <div className={`agent-message ${message.role}`} data-message-id={message.id} key={message.id}>
          <div className="agent-message-head"><small className="muted">{message.role === "user" ? "你" : "Agent 助手"}</small><button className="ghost" aria-label="从这条另起对话" onClick={() => forkAt(message)} disabled={pending}><Icon name="share" size={16} /></button></div>
          <MessageBody message={message} latest={message.id === conversation?.messages.filter(item => item.role === "assistant").at(-1)?.id} preserve={rememberPosition} />
        </div>)}
        {turn.task && <TaskCard task={turn.task} snapshot={snapshots[turn.task.runId]} toolMessages={turn.toolMessages} replies={turn.messages.filter((message) => message.role === "assistant").map((message) => message.content)} pending={pending} onStop={() => void stopTask(turn.task!)} onApply={() => void act(async () => { await client.apply(turn.task!.id); game.notifyAgentChange(route.worldId); toast("修改已采用"); })} onUndo={() => void act(async () => { await client.undo(turn.task!.id); game.notifyAgentChange(route.worldId); toast("本次修改已撤回"); })} onContinue={() => continueTask(turn.task!)} onQuestion={() => openQuestion(turn.task!)} onCompact={() => compactTask(turn.task!)} onInspect={() => inspectTask(turn.task!)} onSource={url => { setSourceUrl(url); setSheet("sources"); }} />}
      </section>)}
      {error && <p className="field-hint warn" role="alert">{error}</p>}
    </div></div>{!atBottom && <button className="to-bottom" aria-label="回到底部 ↓" onClick={() => { follow.current = reading.autoScroll; scrollBottom(true); }}><Icon name="arrow-down" size={22} /></button>}</div>
    <div className="dock agent-dock">
      <div className="agent-toolbar"><button className="ghost agent-model-button" aria-label={`切换 Agent 模型，当前 ${model || selected?.mainModel || "未选择"}`} title={model || selected?.mainModel} disabled={!prefs || !selected} onClick={() => setSheet("model")}><span>{model || selected?.mainModel || "选择模型"}</span><Icon name="forward" size={14} /></button><button className="ghost" onClick={() => setSheet("settings")}>{prefs?.skills.length ? `技能 ${prefs.skills.length}` : "技能"} · {prefs?.network.mode === "off" ? "不联网" : "联网"}{prefs?.readOnly ? " · 只读" : ""}</button>{liveTask && <button className="ghost danger-text" disabled={statusOf(liveTask, snapshots[liveTask.runId]) === "stopping"} onClick={() => void stopTask(liveTask)}>停止</button>}<button className="icon-btn" aria-label="助手更多操作" onClick={() => setSheet("actions")}><Icon name="more" size={20} /></button></div>
      {!!queue.length && <details className="agent-queue"><summary>等待处理 · {queue.length}条</summary>{queue.map((queued) => <div className="row" key={queued.id}><span className="grow">{queued.text}</span><button className="ghost" disabled={pending} onClick={() => void act(() => client.cancelQueued(queued.id))}>取消</button></div>)}</details>}
      <div className="inputbar"><textarea ref={textarea} aria-label="给 Agent 助手的任务" rows={1} value={input} disabled={pending} placeholder={busy ? "补充当前任务…" : "告诉助手要完成什么…"} onChange={(event) => changeInput(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} /><button className={`send-btn ${input.trim() ? "primary" : ""}`} disabled={pending || (!busy && (!input.trim() || !selected || !sessionId || !prefs))} onClick={() => liveTask && !input.trim() ? void stopTask(liveTask) : send()}>{busy ? input.trim() ? "补充" : "停止" : "发送"}</button></div>
    </div>
    {sheet === "actions" && <MenuSheet title="助手操作" onClose={() => setSheet(null)} items={[
      { label: "故事修改恢复点", onSelect: () => void act(async()=>{setSheet(null);setRecoveries(await client.recoveryPoints(route.worldId));}) },
      { label: "执行设置", onSelect: () => setSheet("settings") },
      { label: "工具包", onSelect: () => setSheet("packages") },
      { label: "资料文件", onSelect: () => setSheet("documents") },
      { label: "资料来源", onSelect: () => { setSourceUrl(undefined); setSheet("sources"); } },
      { label: "做完当前任务后再执行", hidden: !busy || !input.trim() || !liveTask, onSelect: () => send("queued") },
      { label: "整理当前上下文", hidden: !last || !canCompact(statusOf(last, snapshots[last.runId])), onSelect: () => last && compactTask(last) },
      { label: "新建对话", onSelect: newSession },
      { label: "重命名对话", hidden: !detail, onSelect: () => detail && renameSession(detail.session) },
      { label: "删除当前对话", danger: true, hidden: !detail, onSelect: () => detail && deleteSession(detail.session) },
    ]} />}
    {routeChoice && <Sheet title="选择继续的路线" onClose={()=>setRouteChoice(null)}><div className="stack"><p>故事已切换路线，旧要求、回答和草稿仍保留。请选择在哪里继续核对。</p><button disabled={pending} onClick={()=>void act(async()=>{await client.selectOriginalRoute(routeChoice.task.id,routeChoice.currentLineId);game.notifyAgentChange(route.worldId);setRouteChoice(null);toast("已回到原路线，请继续执行并重新核对");})}>回到原路线继续</button><button disabled={pending} onClick={()=>void act(async()=>{const made=await client.create(route.worldId,routeChoice.currentLineId,"重新核对");const answers=detail?.messages.filter(m=>m.taskId===routeChoice.task.id&&m.delivery==="answer").map(messageText).join("\n")??"";changeInput([routeChoice.task.text,answers].filter(Boolean).join("\n\n"));setRouteChoice(null);await readSessions("");await changeSession(made.id);toast("已另起对话，旧草稿没有跨路线采用");})}>在当前路线另起核对</button></div></Sheet>}
    {recoveries && <Sheet title="故事修改恢复点" onClose={()=>setRecoveries(null)}><div className="stack"><p className="muted">删除对话后，已经建立的恢复点仍在这里。撤回会检查故事是否已有新进展。</p>{recoveries.map(point=><button key={point.id} disabled={pending} onClick={()=>void act(async()=>{if(!await ask({title:"撤回这批故事修改？",message:"本批采用后的故事有新进展时会停止撤回，保留现有数据。",confirm:"撤回",danger:true}))return;await client.restoreRecovery(point.id);game.notifyAgentChange(route.worldId);setRecoveries(await client.recoveryPoints(route.worldId));toast("这批修改已撤回");})}>{new Date(point.createdAt).toLocaleString("zh-CN")} · 撤回</button>)}{!recoveries.length&&<p className="muted">暂无可用恢复点。</p>}</div></Sheet>}
    {sheet === "sessions" && <Sheet title="Agent 对话记录" onClose={() => setSheet(null)}><div className="stack"><label>搜索对话<input value={sessionQuery} onChange={(event) => querySessions(event.target.value)} placeholder="名称或对话内容" /></label><button className="primary" disabled={pending} onClick={newSession}>新建对话</button><div className="settings-list">{sessions.map((session) => <div className="row agent-session" key={session.id}><button className="settings-entry grow" aria-pressed={session.id === sessionId} onClick={() => void act(() => changeSession(session.id))}><span><b>{session.title || "Agent 对话"}</b><small>{new Date(session.updatedAt).toLocaleString("zh-CN")}</small></span><span>›</span></button><button className="ghost" onClick={() => renameSession(session)} aria-label={`重命名${session.title}`}>改名</button></div>)}{!sessions.length && <p className="muted">{sessionsLoading ? "正在读取…" : "没有找到相关对话。"}</p>}</div>{nextSessionOffset != null && <button className="ghost" disabled={sessionsLoading} onClick={() => { const revision = sessionQueryRevision.current; void readSessions(sessionQuery, nextSessionOffset).catch(failure => { if (alive.current && revision === sessionQueryRevision.current) setError(errorText(failure)); }); }}>{sessionsLoading ? "正在读取…" : "更多会话"}</button>}</div></Sheet>}
    {sheet === "question" && question && questionTask && <QuestionSheet question={question} answers={questionAnswers[question.id] ?? {}} pending={pending} onChange={(answers) => setQuestionAnswers({ ...questionAnswers, [question.id]: answers })} onClose={() => setSheet(null)} onSubmit={(cancelled) => void act(async () => { await client.answer(questionTask.id, question.id, questionAnswers[question.id] ?? {}, cancelled); setSheet(null); })} />}
    {sheet === "model" && prefs && selected && <AgentModelPicker profiles={profiles} selected={selected} current={model || selected.mainModel} running={busy} onClose={() => setSheet(null)} onPick={async (chosen, nextModel) => { const changedService = chosen.id !== selected.id; const next = { ...prefs, profileId: chosen.id, modelName: nextModel, ...((changedService || nextModel !== model) ? { contextWindowTokens: undefined } : {}), ...(changedService ? { modelUrl: undefined, protocol: "chat-completions" as const } : {}) }; await saveAgentPreferences(game, next); setPrefs(next); setModel(nextModel); setSheet(null); toast(busy ? "已选择，下一项任务使用此模型" : "Agent 模型已切换"); }} />}
    {sheet === "packages" && <AgentToolPackages client={client} onClose={() => setSheet(null)} />}
    {sheet === "sources" && sessionId && <AgentSources client={client} sessionId={sessionId} worldId={route.worldId} initialUrl={sourceUrl} onClose={() => setSheet(null)} />}
    {sheet === "documents" && <AgentDocuments client={client} onClose={() => setSheet(null)} />}
    {sheet === "settings" && prefs && <AgentSettings client={client} preferences={prefs} profiles={profiles} profileId={selected?.id} model={model} onClose={() => setSheet(null)} onAdopt={(skill) => setPrefs((current) => current ? { ...current, customSkills: [...current.customSkills.filter((entry) => entry.id !== skill.id), skill] } : current)} onSave={async (next, nextModel) => { const saved = { ...next, modelName: nextModel }; await saveAgentPreferences(game, saved); setPrefs(saved); setModel(nextModel); setSheet(null); toast("Agent 设置已保存"); }} />}

  </div>;
}

function TaskCard({ task, snapshot, toolMessages, replies, pending, onStop, onApply, onUndo, onContinue, onQuestion, onCompact, onInspect, onSource }: { task: AgentTask; snapshot?: AgentSnapshot; toolMessages: AgentMessage[]; replies: string[]; pending: boolean; onStop: () => void; onApply: () => void; onUndo: () => void; onContinue: () => void; onQuestion: () => void; onCompact: () => void; onInspect: () => void; onSource: (url: string) => void }) {
  const { game, platform, toast, devMode } = useApp();
  const status = statusOf(task, snapshot), running = inFlight(status), budget = agentTaskProjection(task,snapshot).budget;
  const [olderSteps,setOlderSteps]=useState<AgentToolStep[]>([]), [nextBefore,setNextBefore]=useState<number|null|undefined>(), [processLoading,setProcessLoading]=useState(false);
  const loadProcess=async()=>{if(processLoading||nextBefore===null)return;setProcessLoading(true);try{const result=await new AgentClient(game).processPage(task.id,nextBefore);setOlderSteps(current=>[...new Map([...result.steps,...current].map(step=>[step.id,step])).values()]);setNextBefore(result.nextBefore);}catch(error){toast(errorText(error));}finally{setProcessLoading(false);}};
  const previewValue = task.preview ?? task.changes;
  const preview = pretty(previewValue);
  const hasChanges = Array.isArray(previewValue) ? previewValue.length > 0 : !!previewValue && typeof previewValue === "object" && Array.isArray(previewValue.changes) && previewValue.changes.length > 0;
  const links = sourceLinks({ result: task.result, events: snapshot?.events });
  const tools = [...new Map([...olderSteps,...(snapshot?.steps ?? [])].map(step=>[step.id,step])).values()].sort((a,b)=>a.seq-b.seq);
  const resumable = ["paused", "cancelled", "interrupted", "failed", "stale", "blocked"].includes(status);
  const plan = task.plan ?? [], completed = plan.filter((item) => item.status === "completed" || item.status === "done").length;
  const current = plan.find((item) => item.status === "in_progress"), activeTool = [...tools].reverse().find((step) => step.status === "running");
  const actualResult = task.result ?? snapshot?.result;
  const remaining = actualResult && typeof actualResult === "object" && !Array.isArray(actualResult) && Array.isArray(actualResult.pendingChanges) ? actualResult.pendingChanges : [];
  const adopted = actualResult && typeof actualResult === "object" && !Array.isArray(actualResult) && actualResult.status === "committed";
  const clock = actualResult && typeof actualResult==="object" && !Array.isArray(actualResult) ? actualResult.clockReadBack : null;
  const dateBasis = clock && typeof clock==="object" && !Array.isArray(clock) ? clock.dateBasis : null;
  const dateNote = dateBasis && typeof dateBasis==="object" && !Array.isArray(dateBasis) && typeof dateBasis.note==="string" ? dateBasis.note : null;
  const noChanges = status === "answered" || ["committed", "completed"].includes(status) && actualResult && typeof actualResult === "object" && !Array.isArray(actualResult) && (actualResult.worldChanged === false || actualResult.changed === false);
  const progress = running ? PHASES[task.execution?.phase ?? ""] ?? PHASES[status] ?? current?.title ?? current?.step ?? current?.text ?? activeTool?.summary ?? PHASES[task.phase ?? ""] ?? "正在执行" : noChanges ? "已答复，未修改本局" : `${STATUSES[status] ?? status}${["interrupted","failed","paused","blocked"].includes(status) && !actualResult ? "，尚未正式采用" : ""}`;
  const question = pendingQuestion(task);
  return <div className={`agent-task ${resumable ? "agent-task-attention" : ""}`}>
    {task.summary && !replies.length && <StoryText emphasizeDate={false} text={task.summary} />}
    {running && typeof task.execution?.progress?.coverage === "number" && <p className="field-hint">已读取 {task.execution.progress.coverage} 个资料范围{hasChanges ? "，已准备修改草稿" : ""}</p>}
    {dateNote && <p className="field-hint">{dateNote}</p>}
    {task.execution?.notice?.reason && <p className="field-hint" role="status">系统运行提示：{task.execution.notice.reason}</p>}
    {(task.error || snapshot?.error) && <p className="field-hint warn" role="status">{snapshot?.error ?? task.error}</p>}
    {hasChanges && <details className="agent-preview" open={status === "previewed"}><summary>{status === "previewed" ? "修改预览" : "本次修改"}</summary>{previewValue ? <ChangePreview value={Array.isArray(previewValue) ? { changes: previewValue } : previewValue} /> : <StoryText emphasizeDate={false} text={preview} />}</details>}
    {!!remaining.length && <details className="agent-preview"><summary>{adopted ? "待继续核对的草稿" : "尚待核对的草稿"} · {remaining.length}项</summary><p className="field-hint">{adopted ? "已采用的修改保留；以下部分尚未采用，继续时重新校对。" : "这些内容尚未核对通过，不会随已通过部分一起采用。"}</p><ChangePreview value={{changes:remaining}} /></details>}
    <details className="agent-process" onToggle={(event) => { if (event.currentTarget.open) onInspect(); }}><summary><span>{progress}{plan.length && !resumable ? ` · 计划${completed}/${plan.length}项` : budget ? ` · 模型${budget.modelRequests.toLocaleString()}次 · 工具${budget.toolCalls.toLocaleString()}次` : ""}</span></summary>
      {plan.length > 0 && <ol className="agent-plan">{plan.map((item, index) => <li key={item.id ?? index} data-status={item.status}><span>{({ pending: "待做", in_progress: "正在做", completed: "完成", done: "完成", cancelled: "已取消", blocked: "待补充" } as Record<string, string>)[item.status] ?? "待做"}</span>{item.title ?? item.step ?? item.text}</li>)}</ol>}
      {nextBefore!==null && <button className="btn btn-ghost" disabled={processLoading} onClick={()=>void loadProcess()}>{processLoading?"正在读取…":"查看更早过程"}</button>}
      {!!tools.length && <div className="agent-steps">{tools.map((step) => <p key={step.id} data-call-id={step.callId} data-child-id={step.childId ?? undefined} data-parent-call-id={step.parentCallId ?? undefined}><span>{step.childId ? "只读助手 · " : ""}{step.summary || `${step.action}${step.object ? ` · ${step.object}` : ""}：${step.resultText}`}</span>{!running && step.status === "running" && <small>已中断</small>}</p>)}</div>}
      {!tools.length && !!toolMessages.length && <div className="agent-steps">{toolMessages.map((message) => <p key={message.id}><span>{TASK_NAMES[message.content.match(/^([a-z_]+):/)?.[1] ?? ""] ?? "处理资料"}</span><small>已记录</small></p>)}</div>}
      {snapshot?.hasMore && <button className="ghost" disabled={pending} onClick={onInspect}>读取更多过程</button>}
      {!!task.subtasks?.length && <div className="agent-subtasks">{task.subtasks.map((subtask, index) => {
        if (!subtask || typeof subtask !== "object" || Array.isArray(subtask)) return null;
        return <details key={typeof subtask.id === "string" ? subtask.id : index}><summary>{String(subtask.name ?? subtask.title ?? subtask.task ?? "资料核对")} · {STATUSES[String(subtask.status)] ?? "已记录"}</summary><StoryText emphasizeDate={false} text={pretty(subtask.summary ?? subtask.result)} /></details>;
      })}</div>}
      {budget && <p className="muted">模型 {budget.modelRequests}次{task.limits?.modelRequests === 0 ? "（不限制）" : task.limits?.modelRequests ? ` / ${task.limits.modelRequests}次` : ""} · 工具 {budget.toolCalls}次{task.limits?.toolCalls === 0 ? "（不限制）" : task.limits?.toolCalls ? ` / ${task.limits.toolCalls}次` : ""} · 用时 {Math.ceil(budget.activeMs / 60000)}分钟{task.limits?.activeMs === 0 ? "（不限制）" : task.limits?.activeMs ? ` / ${Math.ceil(task.limits.activeMs / 60000)}分钟` : ""}</p>}
      {budget?.usage && <p className="muted">已报告输入 {budget.usage.input?.toLocaleString() ?? "未知"} tokens · 输出 {budget.usage.output?.toLocaleString() ?? "未知"} tokens{budget.usageKnown === false ? "，部分请求尚未报告完整用量" : ""}</p>}
      {budget && <p className="muted">{budget.priceKnown && typeof budget.estimatedCost === "number" ? `预计费用 ${budget.estimatedCost.toLocaleString("zh-CN", { maximumFractionDigits: 6 })}${budget.currency ? ` ${budget.currency}` : ""}` : "金额未知"}</p>}
      {task.model?.model && <p className="muted">本次模型：{task.model.model}</p>}
      {(task.contextState || task.contextCheckpoint || task.context || task.inputBudget || task.inputTokens || task.model?.contextTokens) && <ContextDetails task={task} />}
      {canCompact(status) && <button className="ghost" disabled={pending} onClick={onCompact}>整理上下文</button>}
      {devMode && <details><summary>原始记录（开发者）</summary><pre className="raw">{JSON.stringify({ context: task.context, events: snapshot?.events, tools: toolMessages.map((message) => message.content) }, null, 2)}</pre></details>}
    </details>
    {!!links.length && <details><summary>资料来源 · {links.length}</summary>{links.map((link) => <p key={link.url}><button className="link" onClick={() => onSource(link.url)}>{link.title}</button></p>)}</details>}
    <div className="row agent-task-actions">
      {(running || status === "waiting_user") && <button disabled={status === "stopping"} onClick={onStop}>{status === "stopping" ? "正在停止…" : "停止"}</button>}
      {question && <button className="primary" disabled={pending} onClick={onQuestion}>补充信息</button>}
      {status === "previewed" && <button className="primary" disabled={pending} onClick={onApply}>采用这批修改</button>}
      {!running && task.canUndo && <button disabled={pending} onClick={onUndo}>撤回最近一批</button>}
      {resumable && <button disabled={pending} onClick={onContinue}>{status === "stale" ? "按当前故事重新校对" : "继续执行"}</button>}
    </div>
  </div>;
}

function QuestionSheet({ question, answers, pending, onChange, onClose, onSubmit }: { question: AgentQuestion; answers: Record<string, string>; pending: boolean; onChange: (answers: Record<string, string>) => void; onClose: () => void; onSubmit: (cancelled: boolean) => void }) {
  return <Sheet title={question.title || "助手需要你补充"} onClose={onClose}><div className="stack">
    {question.questions.map((item) => <fieldset className="agent-question" key={item.id}><legend>{item.question}</legend>{item.options?.map((option) => <button className="agent-answer" key={option.label} aria-pressed={answers[item.id] === option.label} onClick={() => onChange({ ...answers, [item.id]: option.label })}><b>{option.label}</b>{option.description && <small>{option.description}</small>}</button>)}{item.allowFreeText !== false && <label>也可以自己填写<textarea rows={2} value={answers[item.id] ?? ""} onChange={(event) => onChange({ ...answers, [item.id]: event.target.value })} /></label>}</fieldset>)}
    <p className="muted">返回故事可以继续阅读，之后也能回来回答。</p><div className="row"><button disabled={pending} onClick={() => onSubmit(true)}>取消这次提问</button><button className="primary" disabled={pending || question.questions.some((item) => !answers[item.id]?.trim())} onClick={() => onSubmit(false)}>回答并继续</button></div>
  </div></Sheet>;
}

function AgentModelPicker({ profiles, selected, current, running, onClose, onPick }: { profiles: Profile[]; selected: Profile; current: string; running: boolean; onClose: () => void; onPick: (profile: Profile, model: string) => Promise<void> }) {
  const { platform } = useApp();
  const [profileId, setProfileId] = useState(selected.id);
  const chosen = profiles.find((entry) => entry.id === profileId) ?? selected;
  const [available, setAvailable] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    setAvailable([]); setLoading(true); setNote("");
    void fetchModels(platform, chosen.keySlot, chosen.baseUrl).then((models) => {
      if (!live) return;
      setAvailable(chatModels(models, PRESETS.find((preset) => preset.id === chosen.provider) ?? PRESETS.find((preset) => preset.id === "custom")!));
      if (!models.length) setNote("服务没有给出模型列表，可以选择已保存的模型，或手动填写。");
    }).catch((failure) => {
      if (live) setNote(`暂未拿到模型列表：${explainFailure("http", (failure as { status?: number }).status)} 也可以使用已保存的模型或手动填写。`);
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [platform, chosen.id, chosen.keySlot, chosen.baseUrl, chosen.provider, refresh]);
  const options = [...new Set([...(chosen.id === selected.id ? [current] : []), chosen.mainModel, chosen.auxModel, ...available].filter((value): value is string => !!value))];
  const shown = options.filter((value) => value.toLowerCase().includes(query.trim().toLowerCase()));
  const pick = async (value: string) => {
    if (saving || !value.trim()) return;
    setSaving(true); setNote("");
    try { await onPick(chosen, value.trim()); }
    catch (failure) { setNote(errorText(failure)); setSaving(false); }
  };
  return <Sheet title="Agent 使用的模型" onClose={onClose}><div className="stack">
    <p className="muted" style={{ margin: 0 }}>{running ? "下一项任务使用所选模型，正在执行的任务继续使用原模型。" : "只用于 Agent 助手，不改变普通游玩的 AI 服务。"}</p>
    <label>AI 服务<select value={chosen.id} disabled={saving} onChange={(event) => { setProfileId(event.target.value); setQuery(""); setTyped(""); }}>{profiles.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
    <div className="row"><input className="grow" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" aria-label="搜索 Agent 模型" autoCapitalize="off" /><button className="link" disabled={loading || saving} onClick={() => setRefresh((value) => value + 1)}>{loading ? "正在获取…" : "刷新列表"}</button></div>
    <div className="sheet-menu model-list">{shown.map((value) => <button key={value} className="mode-option" aria-pressed={chosen.id === selected.id && value === current} disabled={saving} onClick={() => void pick(value)}><b>{value}</b>{value === chosen.mainModel ? <small>服务主模型</small> : value === chosen.auxModel ? <small>服务辅助模型</small> : null}</button>)}{!shown.length && <p className="muted">没有找到“{query}”。</p>}</div>
    {note && <p className="field-hint" role="status">{note}</p>}
    <details><summary className="muted">列表里没有？手动填写</summary><div className="row" style={{ marginTop: 8 }}><input className="grow" value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="模型名" aria-label="手动填写 Agent 模型名" autoCapitalize="off" spellCheck={false} /><button className="primary" disabled={saving || !typed.trim()} onClick={() => void pick(typed)}>用这个</button></div></details>
  </div></Sheet>;
}

function AgentSettings({ client, preferences, profiles, profileId, model, onClose, onSave, onAdopt }: { client: AgentClient; preferences: AgentPreferences; profiles: Profile[]; profileId?: string; model: string; onClose: () => void; onSave: (preferences: AgentPreferences, model: string) => Promise<void>; onAdopt: (skill: AgentSkill) => void }) {
  const { platform, toast } = useApp();
  const [draft, setDraft] = useState<AgentPreferences>(() => structuredClone(preferences));
  const [nextModel, setNextModel] = useState(model);
  const [mcpImport, setMcpImport] = useState("");
  const [mcpImportNote, setMcpImportNote] = useState<string[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [custom, setCustom] = useState({ name: "", description: "", content: "" });
  const [mcp, setMcp] = useState({ name: "", url: "", key: "" });
  const [packages, setPackages] = useState<AgentSkillDraft[]>([]);
  const [remoteTools, setRemoteTools] = useState<Record<string, { name: string; title?: string; description?: string }[]>>({});
  useEffect(() => { void client.packageDrafts().then(setPackages).catch((failure) => setError(errorText(failure))); }, [client]);
  const importPackage = async () => {
    setSaving(true); setError("");
    try {
      const files = platform.files as typeof platform.files & { importSkillPackage?: () => Promise<{ name: string; bytes: number[] } | null> };
      const file = files.importSkillPackage ? await files.importSkillPackage() : await platform.files.importText().then((content) => content === null ? null : { name: "SKILL.md", bytes: [...new TextEncoder().encode(content)] });
      if (!file) return;
      const imported = await client.importPackage(file.name, file.bytes);
      setPackages((current) => [...current.filter((entry) => entry.id !== imported.draft.id), imported.draft]);
    } catch (failure) { setError(errorText(failure)); } finally { setSaving(false); }
  };
  const adoptPackage = async (id: string) => {
    setSaving(true); setError("");
    try {
      const { skill } = await client.adoptPackage(id);
      setDraft((current) => ({ ...current, customSkills: [...current.customSkills.filter((entry) => entry.id !== skill.id), skill] }));
      onAdopt(skill);
      setPackages((current) => current.filter((entry) => entry.id !== id));
      toast("已保存为常用技能，可在本次指定技能中选择");
    } catch (failure) { setError(errorText(failure)); } finally { setSaving(false); }
  };
  const changeMcp = (id: string, patch: Partial<NonNullable<AgentNetwork["mcps"]>[number]>) => network({ mcps: draft.network.mcps!.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) });
  const discoverRemoteTools = async (id: string) => {
    setSaving(true); setError("");
    try {
      const entry = draft.network.mcps?.find((server) => server.id === id);
      if (entry?.slot && keys[entry.slot]?.trim()) await platform.secrets.set(entry.slot, keys[entry.slot].trim(), entry.url);
      const result = await client.remoteTools(draft.network, id);
      const object = result && typeof result === "object" && !Array.isArray(result) ? result : {};
      const servers = Array.isArray(object.servers) ? object.servers : [];
      const direct = Array.isArray(object.tools) ? object.tools : [];
      const tools = [...direct, ...servers.flatMap((server) => server && typeof server === "object" && !Array.isArray(server) && Array.isArray(server.tools) ? server.tools : [])];
      setRemoteTools((current) => ({ ...current, [id]: tools.flatMap((tool) => tool && typeof tool === "object" && !Array.isArray(tool) && typeof tool.name === "string" ? [{ name: tool.name, ...(typeof tool.title === "string" ? { title: tool.title } : {}), ...(typeof tool.description === "string" ? { description: tool.description } : {}) }] : []) }));
    } catch (failure) { setError(errorText(failure)); } finally { setSaving(false); }
  };
  const importRemoteConfig = async (fromFile = false) => {
    setError("");
    try {
      const text = fromFile ? await platform.files.importText() : mcpImport;
      if (text === null) return;
      const imported = importMcpConfiguration(text);
      if ((draft.network.mcps?.length ?? 0) + imported.servers.length > 32) throw new Error("服务总数超过32项，请先移除不再使用的服务。");
      setDraft(current => ({ ...current, network: { ...current.network, mcps: [...(current.network.mcps ?? []), ...imported.servers] } }));
      setKeys(current => ({ ...current, ...imported.keys })); setMcpImport("");
      setMcpImportNote([`已读入${imported.servers.length}项远端服务；启用并选择工具后保存才授权。`, ...imported.issues]);
    } catch (failure) { setError(errorText(failure)); }
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(preferences) || nextModel !== model || Object.values(keys).some(Boolean);
  const network = (patch: Partial<AgentNetwork>) => setDraft({ ...draft, network: { ...draft.network, ...patch } });
  const setLimit = (key: keyof AgentLimits, value: number) => setDraft({ ...draft, limits: { ...draft.limits, [key]: value } });
  const toggleSkill = (id: string) => setDraft({ ...draft, skills: draft.skills.includes(id) ? draft.skills.filter((value) => value !== id) : [...draft.skills, id] });
  const removeMcp = (id: string, slot?: string) => {
    network({ mcps: draft.network.mcps!.filter((entry) => entry.id !== id) });
    if (slot) { const next = { ...keys }; delete next[slot]; setKeys(next); }
  };
  const search = draft.network.search ?? { provider: "tavily" as const, slot: "agent-search", url: "https://api.tavily.com/search" };
  const native = { protocol: "openai-responses" as const, enabled: true, url: "", model: "", slot: "agent-native-web", ...draft.network.native };
  const inheritsSearch = !draft.network.native || draft.network.native.binding === "task";
  const inputBudget = agentInputBudget(draft);
  const save = async () => {
    setSaving(true); setError("");
    try {
      for (const [slot, key] of Object.entries(keys)) {
        if (!key.trim()) continue;
        const url = slot === draft.network.search?.slot ? draft.network.search.url ?? "https://api.tavily.com/search" : slot === draft.network.native?.slot ? draft.network.native.url : draft.network.mcps?.find((entry) => entry.slot === slot)?.url;
        if (!url) throw new Error("请先填写对应服务地址");
        await platform.secrets.set(slot, key.trim(), url);
      }
      const mcps = draft.network.mcps?.map((entry) => {
        const original = preferences.network.mcps?.find((saved) => saved.id === entry.id);
        const changed = !original || JSON.stringify([original.url, original.allowedTools, original.readOnlyTools, original.allowResources]) !== JSON.stringify([entry.url, entry.allowedTools, entry.readOnlyTools, entry.allowResources]);
        const allowedTools = [...new Set((entry.allowedTools ?? []).flatMap((tool) => tool.split(/[,，\n]+/)).map((tool) => tool.trim()).filter(Boolean))];
        const readOnlyTools = [...new Set((entry.readOnlyTools ?? []).flatMap((tool) => tool.split(/[,，\n]+/)).map((tool) => tool.trim()).filter((tool) => allowedTools.includes(tool)))];
        return { ...entry, allowedTools, readOnlyTools, authorizationVersion: changed ? (original?.authorizationVersion ?? 0) + 1 : original?.authorizationVersion };
      });
      const authorized = await client.authorizeNetwork({ ...draft.network, mcps });
      await onSave({ ...draft, network: authorized, profileId: draft.profileId ?? profileId }, nextModel);
    } catch (failure) { setError(errorText(failure)); }
    finally { setSaving(false); }
  };
  return <Sheet title="Agent 执行设置" onClose={onClose} dirty={dirty}><div className="stack agent-settings">
    <label>AI 服务<select value={draft.profileId ?? profileId ?? ""} onChange={(event) => { const chosen = profiles.find((entry) => entry.id === event.target.value); setDraft({ ...draft, profileId: event.target.value }); setNextModel(chosen?.mainModel ?? ""); }}><option value="" disabled>选择已连接的 AI 服务</option>{profiles.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
    <label>本次使用的模型<input value={nextModel} onChange={(event) => setNextModel(event.target.value)} placeholder="留空使用服务的主模型" /></label>
    <p className="muted">助手单独保存模型选择，不改变普通游玩的 AI 服务。</p>
    <details><summary>接口与上下文</summary><div className="stack">
      <label>接口类型<select value={draft.protocol ?? "chat-completions"} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as AgentProtocol })}><option value="chat-completions">Chat Completions（兼容接口）</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option></select></label>
      <label>完整接口地址（可不填）<input value={draft.modelUrl ?? ""} onChange={(event) => setDraft({ ...draft, modelUrl: event.target.value.trim() || undefined })} placeholder="留空使用所选服务的标准接口" /></label>
      <p className="muted">自定义服务的路径与标准接口不同时，在这里填写完整地址。</p>
      <label>本次输入预算（tokens）<input type="number" min={2000} max={2000000} value={draft.inputTokens ?? DEFAULT_AGENT_INPUT_TOKENS} onChange={(event) => setDraft({ ...draft, inputTokens: Number(event.target.value), inputBudgetVersion: 2 })} /></label>
      <label>模型总窗口（tokens，不清楚可留空）<input type="number" min={2000} value={draft.contextWindowTokens ?? ""} onChange={(event) => setDraft({ ...draft, contextWindowTokens: event.target.value ? Number(event.target.value) : undefined })} /></label>
      <label>输出上限（tokens，可不填）<input type="number" min={1} value={draft.maxOutputTokens ?? ""} onChange={(event) => setDraft({ ...draft, maxOutputTokens: event.target.value ? Number(event.target.value) : undefined })} placeholder={`默认 ${DEFAULT_AGENT_OUTPUT_TOKENS.toLocaleString()}`} /></label>
      <p>实际可用输入：{inputBudget.effectiveTokens.toLocaleString()} tokens</p>
      {inputBudget.contextWindowTokens != null ? <p className="muted">按所填模型总窗口 {inputBudget.contextWindowTokens.toLocaleString()} tokens 扣除输出预留 {inputBudget.outputReserveTokens.toLocaleString()} tokens。{inputBudget.effectiveTokens < inputBudget.requestedTokens ? "实际输入小于所填预算。" : ""}</p> : <p className="muted">尚未填写模型总窗口；输入预算不代表服务一定支持该容量，不按模型名称猜测。</p>}
      <p className="muted">默认输入预算为475,000 tokens，与普通游玩分开保存。字符仅用于内部估算；继续任务时保留已用次数。</p>
    </div></details>
    <div className="setting"><Switch label="只读分析" note="只查资料和提出建议，不修改本局或外部服务。" checked={draft.readOnly ?? false} onChange={(readOnly) => setDraft({ ...draft, readOnly })} /></div>
    <div className="setting"><div className="setting-head"><b>修改如何生效</b><small>{POLICIES.find(([value]) => value === draft.policy)?.[2]}</small></div><div className="segmented">{POLICIES.map(([value, label]) => <button key={value} aria-pressed={draft.policy === value} onClick={() => setDraft({ ...draft, policy: value })}>{label}</button>)}</div></div>
    <details><summary>本次指定技能{draft.skills.length ? ` · ${draft.skills.length}个` : ""}</summary><div className="stack"><p className="muted">未指定时由助手自行选择；指定后，本次必须读取并执行。</p>{[...BUILTIN_AGENT_SKILLS, ...draft.customSkills].map((skill) => <div key={skill.id} className="setting"><Switch label={skill.name} note={skill.description} checked={draft.skills.includes(skill.id)} onChange={() => toggleSkill(skill.id)} /></div>)}</div></details>
    <details><summary>我的技能</summary><div className="stack"><button disabled={saving} onClick={() => void importPackage()}>从文件导入技能包</button><p className="muted">支持说明、参考资料、模板与受控 JavaScript。导入后先看内容，采用后保存为常用；不会自动选中或扩大权限。</p>{packages.map((entry) => <div className="setting agent-package" key={entry.id}><b>{entry.name} · {entry.version}</b><p>{entry.description}</p>{entry.source && <small className="muted">来源：{entry.source}</small>}{entry.capabilities?.length ? <p className="muted">所需能力：{entry.capabilities.join("、")}</p> : null}{entry.compatibility && <p className="muted">{skillCompatibility(entry.compatibility)}</p>}{entry.warnings?.map((warning) => <p className="field-hint warn" key={warning}>{warning}</p>)}<details><summary>查看说明与文件</summary><StoryText emphasizeDate={false} text={entry.content} />{Object.keys(entry.files ?? {}).filter((path) => path !== "SKILL.md").map((path) => <details key={path}><summary>{path}</summary><pre className="raw">{entry.files![path]}</pre></details>)}</details><button disabled={saving} onClick={() => void adoptPackage(entry.id)}>采用为常用技能</button></div>)}{draft.customSkills.map((skill) => <div className="writing-saved-row" key={skill.id}><span className="grow">{skill.name} · {skill.version}</span><button className="ghost" aria-label={`删除技能 ${skill.name}`} onClick={() => setDraft({ ...draft, customSkills: draft.customSkills.filter((entry) => entry.id !== skill.id), skills: draft.skills.filter((id) => id !== skill.id) })}>删除</button></div>)}<label>技能名称<input value={custom.name} onChange={(event) => setCustom({ ...custom, name: event.target.value })} /></label><label>适用情景<input value={custom.description} onChange={(event) => setCustom({ ...custom, description: event.target.value })} /></label><label>技能说明（SKILL.md）<textarea rows={7} value={custom.content} onChange={(event) => setCustom({ ...custom, content: event.target.value })} placeholder="写下这个技能的做法、需要读取的资料和完成条件" /></label><button disabled={!custom.name.trim() || !custom.content.trim()} onClick={() => { const id = `user-skill-${crypto.randomUUID().slice(0, 12)}`; setDraft({ ...draft, customSkills: [...draft.customSkills, { id, name: custom.name.trim(), description: custom.description.trim(), content: custom.content, version: "1.0.0" }] }); setCustom({ name: "", description: "", content: "" }); }}>保存为我的技能</button></div></details>
    <details><summary>联网与已配置工具</summary><div className="stack">
      <div className="segmented">{([["off", "不联网"], ["auto", "自动选择"], ["native", "当前模型联网"], ["configured", "搜索服务／MCP"]] as const).map(([value, label]) => <button key={value} aria-pressed={draft.network.mode === value} onClick={() => network({ mode: value, ...(value === "native" ? { native: { ...native, binding: "task", enabled: true } } : {}) })}>{label}</button>)}</div>
      <p className="muted">自动选择优先使用当前任务模型的原生搜索，其次使用已配置的搜索服务或 MCP；接口不支持时会明确说明，不根据模型名称猜测。</p>
      <details><summary>独立搜索服务</summary><div className="stack"><label>Tavily 搜索地址<input value={search.url ?? "https://api.tavily.com/search"} onChange={(event) => network({ search: { ...search, url: event.target.value } })} /></label><label>搜索服务 Key<input type="password" autoComplete="off" value={keys[search.slot] ?? ""} placeholder="留空保留已保存的 Key" onChange={(event) => { network({ search }); setKeys({ ...keys, [search.slot]: event.target.value }); }} /></label><button onClick={() => network({ search })}>使用此搜索服务</button></div></details>
      <div className="setting"><Switch label="跟随当前任务模型" note={`跟随：${nextModel || "所选服务的主模型"}，不需要重复填写地址或密钥。切换模型对下一次执行生效。`} checked={inheritsSearch} onChange={(follow) => network({ native: follow ? { ...native, binding: "task", enabled: true } : { ...native, binding: "profile" }, ...(!follow ? { mode: "auto" as const } : {}) })} /></div>
      {!inheritsSearch && <details><summary>独立搜索模型（高级）</summary><div className="stack"><p className="muted">这是一套独立搜索配置，不会随任务模型切换；原有配置保留。</p><Switch label="启用独立搜索模型" checked={native.enabled} onChange={(enabled) => network({ native: { ...native, binding: "profile", enabled } })} /><label>接口类型<select value={native.protocol} onChange={(event) => network({ native: { ...native, binding: "profile", protocol: event.target.value as typeof native.protocol } })}><option value="openai-responses">OpenAI Responses</option><option value="gemini">Gemini</option><option value="anthropic">Anthropic</option></select></label><label>联网接口地址<input value={native.url} onChange={(event) => network({ native: { ...native, binding: "profile", url: event.target.value } })} /></label><label>联网模型<input value={native.model} onChange={(event) => network({ native: { ...native, binding: "profile", model: event.target.value } })} /></label><label>联网接口 Key<input type="password" autoComplete="off" value={keys[native.slot] ?? ""} placeholder="留空保留已保存的 Key" onChange={(event) => { network({ native: { ...native, binding: "profile" } }); setKeys({ ...keys, [native.slot]: event.target.value }); }} /></label></div></details>}
      <details><summary>MCP 服务</summary><div className="stack"><details><summary>导入服务配置</summary><div className="stack"><label>JSON 配置<textarea rows={4} value={mcpImport} onChange={event => setMcpImport(event.target.value)} autoComplete="off" spellCheck={false} placeholder="粘贴包含 mcpServers 的配置" /></label><div className="row"><button disabled={saving || !mcpImport.trim()} onClick={() => void importRemoteConfig()}>读取配置</button><button disabled={saving} onClick={() => void importRemoteConfig(true)}>从文件读取</button></div>{mcpImportNote.map((note, index) => <p className="field-hint" key={index}>{note}</p>)}</div></details><p className="muted">按服务预先授权，允许范围内自动执行。外部修改不随本局预览或撤回恢复。</p>{(draft.network.mcps ?? []).map((entry) => <div className="setting agent-mcp" key={entry.id}><Switch label={entry.name} note={entry.url} checked={entry.enabled} onChange={(enabled) => changeMcp(entry.id, { enabled })} /><details><summary>工具与授权</summary><div className="stack"><label>服务地址<input value={entry.url} onChange={(event) => { changeMcp(entry.id, { url: event.target.value, allowedTools: [], readOnlyTools: [] }); setRemoteTools((current) => ({ ...current, [entry.id]: [] })); }} /></label><Switch label="允许读取服务资料" note="允许助手读取这个服务提供的资料，仍遵守只读任务和服务端权限。" checked={entry.allowResources ?? false} onChange={(allowResources) => changeMcp(entry.id, { allowResources })} /><button disabled={saving} onClick={() => void discoverRemoteTools(entry.id)}>查看服务提供的工具</button>{remoteTools[entry.id]?.map((tool) => <div className="setting" key={tool.name}><Switch label={tool.title || tool.name} note={tool.description} checked={entry.allowedTools?.includes(tool.name) ?? false} onChange={(allowed) => changeMcp(entry.id, { allowedTools: allowed ? [...(entry.allowedTools ?? []), tool.name] : (entry.allowedTools ?? []).filter((name) => name !== tool.name), readOnlyTools: allowed ? entry.readOnlyTools : entry.readOnlyTools?.filter((name) => name !== tool.name) })} /><Switch label="允许只读子任务使用" checked={entry.readOnlyTools?.includes(tool.name) ?? false} onChange={(allowed) => changeMcp(entry.id, { allowedTools: allowed ? [...new Set([...(entry.allowedTools ?? []), tool.name])] : entry.allowedTools, readOnlyTools: allowed ? [...(entry.readOnlyTools ?? []), tool.name] : entry.readOnlyTools?.filter((name) => name !== tool.name) })} /></div>)}<label>允许调用的工具（每行一个名称）<textarea rows={3} value={(entry.allowedTools ?? []).join("\n")} onChange={(event) => changeMcp(entry.id, { allowedTools: [...new Set(event.target.value.split("\n"))] })} /></label><label>确认只读、可供只读任务使用的工具<textarea rows={2} value={(entry.readOnlyTools ?? []).join("\n")} onChange={(event) => changeMcp(entry.id, { readOnlyTools: [...new Set(event.target.value.split("\n"))] })} /></label><p className="muted">名单为空时不授权调用。修改地址后需重新选择工具；服务的只读标注仍需你确认。</p></div></details><button className="ghost" onClick={() => removeMcp(entry.id, entry.slot)}>移除服务</button></div>)}<label>服务名称<input value={mcp.name} onChange={(event) => setMcp({ ...mcp, name: event.target.value })} /></label><label>Streamable HTTP 地址<input value={mcp.url} onChange={(event) => setMcp({ ...mcp, url: event.target.value })} placeholder="https://…/mcp" /></label><label>访问令牌（没有可留空）<input type="password" autoComplete="off" value={mcp.key} onChange={(event) => setMcp({ ...mcp, key: event.target.value })} /></label><button disabled={!mcp.name.trim() || !mcp.url.trim()} onClick={() => { const id = crypto.randomUUID().slice(0, 12), slot = `agent-mcp-${id}`; network({ mcps: [...(draft.network.mcps ?? []), { id, name: mcp.name.trim(), url: mcp.url.trim(), ...(mcp.key.trim() ? { slot } : {}), enabled: true, allowedTools: [], readOnlyTools: [], authorizationVersion: 1 }] }); if (mcp.key.trim()) setKeys({ ...keys, [slot]: mcp.key.trim() }); setMcp({ name: "", url: "", key: "" }); }}>添加服务并选择授权</button></div></details>
    </div></details>
    <details><summary>执行上限</summary><div className="stack">
      <p className="muted">默认不限制任务次数和活动时长，任务完成或你点停止时结束。内部调用和失败重试仍记录用量，继续时不清零。</p>
      <div className="setting"><Switch label="限制模型请求次数" note={draft.limits.modelRequests > 0 ? "累计达到所填次数时保存进度。" : "不限制"} checked={draft.limits.modelRequests > 0} onChange={(enabled) => setLimit("modelRequests", enabled ? 30 : 0)} />{draft.limits.modelRequests > 0 && <label>最多模型请求次数<input type="number" min={1} max={300} value={draft.limits.modelRequests} onChange={(event) => setLimit("modelRequests", Number(event.target.value))} /></label>}</div>
      <div className="setting"><Switch label="限制工具调用次数" note={draft.limits.toolCalls > 0 ? "累计达到所填次数时保存进度。" : "不限制"} checked={draft.limits.toolCalls > 0} onChange={(enabled) => setLimit("toolCalls", enabled ? 100 : 0)} />{draft.limits.toolCalls > 0 && <label>最多工具调用次数<input type="number" min={1} max={1000} value={draft.limits.toolCalls} onChange={(event) => setLimit("toolCalls", Number(event.target.value))} /></label>}</div>
      <div className="setting"><Switch label="限制活动执行时长" note={draft.limits.activeMs > 0 ? "等待你回答时不计活动时长。" : "不限制"} checked={draft.limits.activeMs > 0} onChange={(enabled) => setLimit("activeMs", enabled ? 900_000 : 0)} />{draft.limits.activeMs > 0 && <label>最多活动执行分钟<input type="number" min={1} max={120} value={draft.limits.activeMs / 60000} onChange={(event) => setLimit("activeMs", Number(event.target.value) * 60000)} /></label>}</div>
      <p className="muted">任务上限与脚本的内存、计算和取消限制分别处理。</p>
      <button onClick={() => setDraft({ ...draft, limits: { ...DEFAULT_AGENT_LIMITS }, limitsVersion: 2 })}>恢复默认（不限制）</button>
    </div></details>
    {error && <p className="field-hint warn" role="alert">{error}</p>}
    <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button>
  </div></Sheet>;
}
