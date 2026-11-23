import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BUILTIN_PERSONAS, getBuiltinPersona, type CompanionPersona } from "../../content/personas";
import {
  compactCompanionSession,
  createSession,
  deleteSession,
  draftSetupFromCompanionText,
  escalateCompanionToAgent,
  getSessionDetail,
  importHandoffMessages,
  listMemories,
  listPersonas,
  listSessions,
  saveCompanionMessageAsNote,
  saveMemory,
  sendCompanionMessage,
  updateSession,
  type CompanionBookScope,
  type CompanionCitation,
  type CompanionGear,
  type CompanionHandle,
  type CompanionMessage,
  type CompanionSession,
  type CompanionStep,
  type CompanionStreamUpdate,
} from "../../engine/companion";
import {
  AgentClient,
  agentConversationTurns,
  agentSessionProjection,
  agentSnapshotNeedsRead,
  agentTaskProjection,
  agentTaskStatus,
  mergeAgentDelta,
  mergeAgentSessionPage,
  type AgentSessionDetail,
  type AgentSnapshot,
  type AgentTask,
} from "../../engine/agent";
import { getBook, listBooks } from "../../engine/sources/library";
import { newBinding, type SourceBinding, type SourceBook } from "../../engine/sources/types";
import type { World } from "../../engine/types";
import type { Json } from "../../platform";
import { useApp, useBack } from "../app/context";
import { localFind } from "../app/localFind";
import { loadPlayDefaults } from "../app/playDefaults";
import { openLink } from "../app/update";
import { Icon } from "../components/Icon";
import { BudgetReminder } from "../components/MonthlyBudget";
import { MenuSheet, Sheet } from "../components/Sheet";
import { BookPreview, SourceLibrary } from "../components/Sources";
import { StoryText } from "../components/StoryText";
import { useMedia } from "../components/useMedia";
import { DiffView } from "../components/WritingAssist";
import { EMPTY, normalizeOpeningDraft } from "./openingDraft";
import { CompanionMarkdown } from "./companion/CompanionMarkdown";
import { MemorySheet } from "./companion/MemorySheet";
import { PersonaSheet } from "./companion/PersonaSheet";
import "./companion/companion.css";

export interface CompanionScreenProps {
  worldId?: string;
  lineId?: string;
  bookId?: string;
  sessionId?: string;
  personaId?: string;
  gear?: CompanionGear;
  prompt?: string;
  autoSend?: boolean;
  handoff?: {
    asked?: { q: string; a: string }[];
    draftQuestion?: string;
    sourceScope?: import("../../engine/sources/scope").SourceScope;
  };
}

interface WorldBrief {
  world: World;
  lineId: string | null;
  source: SourceBinding | null;
}

interface BookBrief {
  id: string;
  title: string;
  format: string;
  sectionsCount?: number;
}

interface LiveStreamState {
  sessionId: string;
  mode: "send" | "edit" | "regenerate";
  userText: string;
  targetMessageId: string | null;
  gear: "chat" | "research";
  update: CompanionStreamUpdate;
}

const GEAR_META: [CompanionGear, string, string][] = [
  ["chat", "畅聊", "闲聊、角色扮演、剧情脑暴"],
  ["research", "查资料", "搜书库、查本局设定、联网考据"],
  ["agent", "改档", "帮改本局设定与人物，先预览再采用"],
];

const GEAR_BADGE: Record<CompanionGear, string> = {
  chat: "畅聊",
  research: "查资料",
  agent: "改档",
};

const ROLE_KIND_TAG: Record<CompanionPersona["roleKind"], string> = {
  assistant: "创作与问答搭档",
  advisor: "策划与考据顾问",
  roleplay: "沉浸角色扮演",
  npc: "故事人物化身",
};

const AGENT_STATUS_TEXT: Record<string, string> = {
  running: "正在整理修改方案…",
  committing: "正在写入存档…",
  committed: "修改已采用",
  completed: "处理完成",
  answered: "已答复（未改存档）",
  partial: "已完成一部分",
  blocked: "遇到阻碍，需要补充",
  previewed: "修改预览已准备好，确认后生效",
  paused: "已暂停，可随时继续",
  cancelled: "已停止",
  interrupted: "中途中断",
  failed: "未能完成",
  stale: "故事已有新变化，需重新核对",
  undone: "本次修改已撤回",
  waiting_user: "等待你补充说明",
  compacting: "正在整理对话前文…",
};

const isTaskInFlight = (status: string) =>
  ["running", "committing", "compacting", "stopping"].includes(status);

function defaultStarters(
  persona: CompanionPersona,
  gear: CompanionGear,
  worldTitle?: string,
  bookTitle?: string,
): string[] {
  if (persona.starters?.length) return persona.starters.slice(0, 4);
  if (gear === "agent" && worldTitle) {
    return [
      `帮我核对《${worldTitle}》最近几段的人物关系，整理出矛盾点`,
      `帮我给《${worldTitle}》补充一张新势力设定卡，先给我看预览`,
      "检查主角当前的行囊、钱物和伤势是否与正文一致",
      "帮我理一理接下来的三条剧情走向建议",
    ];
  }
  if (gear === "research" || bookTitle) {
    return [
      bookTitle ? `帮我查查《${bookTitle}》里主要势力的来历与规矩` : "考据一下唐代长安西市胡商的日常作息与物价",
      worldTitle ? `梳理《${worldTitle}》目前埋下的伏笔与未解线索` : "北宋汴京一贯钱在市井里大约能买多少东西？",
      "帮我查证一下古代驿站传信与通关文牒的细节",
      "写一段既有烟火气又不拖沓的开场环境描写灵感",
    ];
  }
  if (persona.roleKind === "roleplay" || persona.roleKind === "npc") {
    return [
      "坐下喝杯热茶，聊聊你最近听到的风声",
      "要是眼下这桩事交给你办，你会怎么选？",
      "跟我讲讲你早年间最难忘的一桩旧事",
      "外面风雪正紧，今晚不妨敞开心扉聊几句",
    ];
  }
  return [
    "帮我脑暴一个反套路的历史穿越开局，主角不要皇室身份",
    worldTitle ? `聊聊《${worldTitle}》接下来怎样推进更有张力` : "卡文了，帮我设计一场茶馆试探对手底细的对手戏",
    "怎样把配角写得有血有肉、不沦为工具人?",
    "给我出三个意想不到的江湖悬疑反转点子",
  ];
}

function summarizeForMemory(raw: string): string {
  const clean = raw
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:---+|\*\*\*+)\s*$/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length <= 220 ? clean : `${clean.slice(0, 220)}…`;
}

function thoughtSummaryLabel(thinking: string, steps: CompanionStep[], citations: CompanionCitation[]): string {
  const parts: string[] = [];
  if (thinking.trim()) parts.push("已思考");
  if (citations.length > 0) parts.push(`查阅 ${citations.length} 处资料`);
  else if (steps.length > 0) parts.push(`查证 ${steps.length} 步`);
  return parts.join(" · ") || "查看思考过程";
}

function extractAgentChanges(value: Json | undefined): { summary: string; before?: string; after?: string }[] {
  if (!value || typeof value !== "object") return [];
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as Record<string, Json>).changes)
      ? ((value as Record<string, Json>).changes as Json[])
      : [];
  const out: { summary: string; before?: string; after?: string }[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, Json>;
    const summary = typeof obj.summary === "string" && obj.summary.trim() ? obj.summary : "存档内容调整";
    const before =
      typeof obj.before === "string"
        ? obj.before
        : obj.before !== undefined && obj.before !== null
          ? JSON.stringify(obj.before, null, 2)
          : undefined;
    const after =
      typeof obj.after === "string"
        ? obj.after
        : obj.after !== undefined && obj.after !== null
          ? JSON.stringify(obj.after, null, 2)
          : undefined;
    out.push({ summary, before, after });
  }
  return out;
}

export function CompanionScreen(props: CompanionScreenProps = {}) {
  const { game, platform, profile, reading, devMode, push, pop, toast, ask, askName } = useApp();
  useBack(() => {
    pop();
    return true;
  });

  const isDesktop = useMedia("(min-width: 900px)");
  const agentClient = useMemo(() => new AgentClient(game), [game]);

  const [personas, setPersonas] = useState<CompanionPersona[]>(BUILTIN_PERSONAS);
  const [sessions, setSessions] = useState<CompanionSession[]>([]);
  const [session, setSession] = useState<CompanionSession | null>(null);
  const [messages, setMessages] = useState<CompanionMessage[]>([]);
  const [worlds, setWorlds] = useState<WorldBrief[]>([]);
  const [books, setBooks] = useState<BookBrief[]>([]);
  const [boundWorldMissing, setBoundWorldMissing] = useState(false);
  const [boundBookMissing, setBoundBookMissing] = useState(false);
  const [memoryCount, setMemoryCount] = useState(0);
  const [budgetTick, setBudgetTick] = useState(0);

  const [input, setInput] = useState(props.handoff?.draftQuestion ?? props.prompt ?? "");
  const [sessionQuery, setSessionQuery] = useState("");
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [liveStream, setLiveStream] = useState<LiveStreamState | null>(null);
  const [agentPolicy, setAgentPolicy] = useState<"preview" | "auto-reversible">("preview");
  const [agentBusy, setAgentBusy] = useState(false);

  const [piDetail, setPiDetail] = useState<AgentSessionDetail | null>(null);
  const [piSnapshots, setPiSnapshots] = useState<Record<string, AgentSnapshot>>({});
  const piSnapCache = useRef<Record<string, AgentSnapshot>>({});
  const piSnapVer = useRef<Record<string, string>>({});
  const [recoveries, setRecoveries] = useState<{ id: string; createdAt: string }[] | null>(null);

  const [sheet, setSheet] = useState<
    "sessions" | "persona" | "memory" | "context" | "more" | "sourceLib" | null
  >(null);
  const [menuSession, setMenuSession] = useState<CompanionSession | null>(null);
  const [previewBook, setPreviewBook] = useState<{
    book: SourceBook;
    through?: number | null;
    quote?: string;
  } | null>(null);

  const handleRef = useRef<CompanionHandle | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const bootedRef = useRef(false);
  const autoSentRef = useRef(false);
  const aliveRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(reading.autoScroll);
  const [atBottom, setAtBottom] = useState(true);

  const activePersona = useMemo(() => {
    const id = session?.personaId ?? props.personaId ?? "lingxi";
    return (
      personas.find((p) => p.id === id) ??
      getBuiltinPersona(id) ??
      personas[0] ??
      BUILTIN_PERSONAS[0]
    );
  }, [personas, session?.personaId, props.personaId]);

  const activeGear: CompanionGear = session?.activeGear ?? props.gear ?? "chat";

  const boundWorldBrief = useMemo(
    () => (session?.boundWorldId ? worlds.find((w) => w.world.id === session.boundWorldId) ?? null : null),
    [worlds, session?.boundWorldId],
  );

  const boundBookBrief = useMemo(() => {
    const bookId = session?.boundBookId ?? boundWorldBrief?.source?.bookId ?? null;
    return bookId ? books.find((b) => b.id === bookId) ?? null : null;
  }, [books, session?.boundBookId, boundWorldBrief]);

  const refreshReferenceLists = useCallback(async () => {
    const [worldList, bookList] = await Promise.all([
      game.repo.listWorlds(),
      listBooks(game.repo),
    ]);
    const briefs: WorldBrief[] = [];
    for (const w of worldList) {
      const line = w.currentLineId ? await game.repo.getLine(w.currentLineId).catch(() => null) : null;
      const state = line ? await game.repo.getState(line.nodeId).catch(() => null) : null;
      briefs.push({
        world: w,
        lineId: line?.id ?? w.currentLineId ?? null,
        source: state?.source ?? null,
      });
    }
    if (!aliveRef.current) return { briefs, bookList };
    setWorlds(briefs);
    setBooks(bookList.map((b) => ({ id: b.id, title: b.title, format: b.format })));
    return { briefs, bookList };
  }, [game]);

  const refreshSessions = useCallback(
    async (query = sessionQuery) => {
      const list = await listSessions(game, query.trim() ? { query: query.trim() } : undefined);
      if (aliveRef.current) setSessions(list);
      return list;
    },
    [game, sessionQuery],
  );

  const loadActiveSession = useCallback(
    async (sessionId: string) => {
      activeSessionRef.current = sessionId;
      const detail = await getSessionDetail(game, sessionId);
      if (!aliveRef.current || activeSessionRef.current !== sessionId || !detail) return null;
      setSession(detail.session);
      setMessages(detail.messages);
      return detail;
    },
    [game],
  );

  // Check missing bound world or book whenever session or reference lists change.
  useEffect(() => {
    let live = true;
    void (async () => {
      if (session?.boundWorldId) {
        const w = await game.repo.getWorld(session.boundWorldId).catch(() => null);
        if (live) setBoundWorldMissing(!w || w.archived === true);
      } else if (live) {
        setBoundWorldMissing(false);
      }
      if (session?.boundBookId) {
        const b = await getBook(game.repo, session.boundBookId).catch(() => null);
        if (live) setBoundBookMissing(!b);
      } else if (live) {
        setBoundBookMissing(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [game, session?.boundWorldId, session?.boundBookId, worlds, books]);

  // Refresh memory badge count for active persona.
  const refreshMemoryCount = useCallback(
    async (personaId: string) => {
      try {
        const [scoped, general] = await Promise.all([
          listMemories(game, personaId),
          listMemories(game),
        ]);
        const merged = [...new Map([...scoped, ...general].map((m) => [m.id, m])).values()];
        const count = merged.filter(
          (m) => m.enabled && (m.scope === "global" || m.personaId === personaId),
        ).length;
        if (aliveRef.current) setMemoryCount(count);
      } catch {
        /* ignore */
      }
    },
    [game],
  );

  useEffect(() => {
    void refreshMemoryCount(activePersona.id);
  }, [activePersona.id, refreshMemoryCount]);

  // Boot once (guarded against StrictMode double-mount).
  useEffect(() => {
    aliveRef.current = true;
    if (bootedRef.current) return () => { aliveRef.current = false; };
    bootedRef.current = true;

    void (async () => {
      const [loadedPersonas, refs, existingSessions] = await Promise.all([
        listPersonas(game).catch(() => BUILTIN_PERSONAS),
        refreshReferenceLists(),
        listSessions(game).catch(() => [] as CompanionSession[]),
      ]);
      if (!aliveRef.current) return;
      const availPersonas = loadedPersonas.length ? loadedPersonas : BUILTIN_PERSONAS;
      setPersonas(availPersonas);
      setSessions(existingSessions);

      const defaultPersonaId =
        props.personaId ?? availPersonas[0]?.id ?? BUILTIN_PERSONAS[0]?.id ?? "lingxi";
      const worldMatch = props.worldId
        ? refs.briefs.find((item) => item.world.id === props.worldId) ?? null
        : null;
      const resolvedLineId = props.lineId ?? worldMatch?.lineId ?? null;
      const resolvedBookId = props.bookId ?? worldMatch?.source?.bookId ?? null;
      const initialScope: CompanionBookScope | null =
        props.handoff?.sourceScope?.mode === "chapters"
          ? {
              mode: "chapters",
              from: props.handoff.sourceScope.from,
              to: props.handoff.sourceScope.to,
            }
          : resolvedBookId
            ? { mode: worldMatch?.source ? "through" : "full" }
            : null;

      let targetId: string | null = null;

      if (props.sessionId) {
        const detail = await loadActiveSession(props.sessionId);
        if (detail) {
          targetId = detail.session.id;
          if (props.gear && detail.session.activeGear !== props.gear) {
            const patched = await updateSession(game, detail.session.id, { activeGear: props.gear });
            if (aliveRef.current) setSession(patched);
          }
        }
      }

      if (!targetId && props.handoff) {
        const created = await createSession(game, {
          personaId: defaultPersonaId,
          activeGear: props.gear ?? "research",
          boundWorldId: props.worldId ?? null,
          boundLineId: resolvedLineId,
          boundBookId: resolvedBookId,
          bookScope: initialScope,
        });
        if (props.handoff.asked?.length) {
          await importHandoffMessages(game, created.id, props.handoff.asked);
        }
        await refreshSessions("");
        await loadActiveSession(created.id);
        targetId = created.id;
      }

      if (!targetId) {
        const matching = existingSessions.find((s) => {
          if (props.personaId && s.personaId !== props.personaId) return false;
          if (props.worldId) return s.boundWorldId === props.worldId;
          if (props.bookId) return !s.boundWorldId && s.boundBookId === props.bookId;
          return !s.boundWorldId && !s.boundBookId && s.activeGear !== "agent" && !s.legacyPi;
        });

        if (matching && !props.autoSend) {
          if (props.gear && matching.activeGear !== props.gear) {
            await updateSession(game, matching.id, { activeGear: props.gear });
          }
          await loadActiveSession(matching.id);
          targetId = matching.id;
        } else {
          const created = await createSession(game, {
            personaId: defaultPersonaId,
            activeGear: props.gear ?? (props.bookId ? "research" : "chat"),
            boundWorldId: props.worldId ?? null,
            boundLineId: resolvedLineId,
            boundBookId: resolvedBookId,
            bookScope: initialScope,
          });
          await refreshSessions("");
          await loadActiveSession(created.id);
          targetId = created.id;
        }
      }

      if (props.autoSend && props.prompt?.trim() && targetId && !autoSentRef.current) {
        autoSentRef.current = true;
        setInput("");
        const sendGear = (props.gear === "research" ? "research" : "chat") as "chat" | "research";
        if (props.gear === "agent" && props.worldId) {
          setAgentBusy(true);
          try {
            await escalateCompanionToAgent(game, {
              sessionId: targetId,
              text: props.prompt.trim(),
              policy: "preview",
            });
            await loadActiveSession(targetId);
          } catch (err) {
            if (aliveRef.current) toast(err instanceof Error ? err.message : "未能启动改档任务");
          } finally {
            if (aliveRef.current) setAgentBusy(false);
          }
        } else {
          startStreamRun(targetId, {
            sessionId: targetId,
            gear: sendGear,
            text: props.prompt.trim(),
          });
        }
      }
    })();

    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Poll native Agent session when bound to a world & piSessionId exists.
  useEffect(() => {
    const piId = session?.piSessionId;
    const worldId = session?.boundWorldId;
    if (!piId || !worldId || !game.platform.execution?.agent) {
      setPiDetail(null);
      setPiSnapshots({});
      piSnapCache.current = {};
      piSnapVer.current = {};
      return;
    }
    let live = true;
    let polling = false;
    let wasRunning = true;
    let lastPoll = 0;

    const poll = async () => {
      if (polling) return;
      if (!wasRunning && Date.now() - lastPoll < 3200) return;
      polling = true;
      try {
        const next = await agentClient.pollSession(piId);
        if (!live || activeSessionRef.current !== session.id) return;
        lastPoll = Date.now();
        const watched = next.tasks
          .slice(-6)
          .filter((t) => !t.runId.startsWith("imported:") && t.status !== "archived");
        const snaps = await Promise.all(
          watched.map(async (t) => {
            const ver = `${t.status}:${t.updatedAt ?? ""}`;
            const prev = piSnapCache.current[t.runId];
            if (!agentSnapshotNeedsRead(prev, t.status, piSnapVer.current[t.runId] === ver)) {
              return [t.runId, prev!] as const;
            }
            const fresh = await agentClient.delta(t.id, prev?.nextAfter ?? 0, prev?.nextCallAfter ?? 0);
            const merged = mergeAgentDelta(prev, fresh);
            piSnapCache.current[t.runId] = merged;
            piSnapVer.current[t.runId] = ver;
            return [t.runId, merged] as const;
          }),
        );
        if (!live) return;
        setPiDetail((cur) => mergeAgentSessionPage(cur, next, "latest"));
        setPiSnapshots((cur) => ({ ...cur, ...Object.fromEntries(snaps) }));
        wasRunning = snaps.some(([, s]) =>
          isTaskInFlight(s.task ? agentTaskStatus(s.task, s) : s.status),
        );
      } catch {
        /* non-fatal polling error */
      } finally {
        polling = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 1200);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [agentClient, game, session?.id, session?.piSessionId, session?.boundWorldId]);

  const projectedPi = useMemo(
    () => (piDetail ? agentSessionProjection(piDetail, piSnapshots) : null),
    [piDetail, piSnapshots],
  );

  // Auto-grow textarea cleanly.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  const scrollBottom = useCallback((smooth = false) => {
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const handleScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    followRef.current = reading.autoScroll && bottom;
    setAtBottom(bottom);
  };

  useLayoutEffect(() => {
    if (reading.autoScroll && followRef.current) scrollBottom(false);
  }, [messages, liveStream?.update.text, liveStream?.update.thinking, reading.autoScroll, scrollBottom]);

  function startStreamRun(
    sessionId: string,
    sendInput: {
      sessionId: string;
      gear: "chat" | "research";
      text: string;
      parentId?: string | null;
      editMessageId?: string | null;
      regenerateMessageId?: string | null;
    },
  ) {
    if (!profile && !game.llm) {
      toast("请先连接一个 AI 服务");
      push({ name: "setup", first: true });
      return;
    }
    followRef.current = reading.autoScroll;
    const mode = sendInput.editMessageId
      ? "edit"
      : sendInput.regenerateMessageId
        ? "regenerate"
        : "send";

    setLiveStream({
      sessionId,
      mode,
      userText: sendInput.text,
      targetMessageId: sendInput.editMessageId ?? sendInput.regenerateMessageId ?? null,
      gear: sendInput.gear,
      update: {
        status: "streaming",
        text: "",
        thinking: "",
        steps: [],
        citations: [],
      },
    });

    const handle = sendCompanionMessage(game, sendInput, (u) => {
      if (!aliveRef.current || activeSessionRef.current !== sessionId) return;
      setLiveStream((prev) =>
        prev && prev.sessionId === sessionId ? { ...prev, update: u } : prev,
      );
    });
    handleRef.current = handle;

    // Pick up newly inserted DB rows shortly after start so branch metadata stays fresh.
    const syncTimer = setTimeout(() => {
      if (aliveRef.current && activeSessionRef.current === sessionId) {
        void loadActiveSession(sessionId);
      }
    }, 160);

    void handle.done
      .catch((err) => {
        if (aliveRef.current) {
          toast(err instanceof Error ? err.message : "生成未能完成，请重试");
        }
      })
      .finally(async () => {
        clearTimeout(syncTimer);
        if (handleRef.current === handle) handleRef.current = null;
        if (!aliveRef.current) return;
        setLiveStream((prev) => (prev?.sessionId === sessionId ? null : prev));
        if (activeSessionRef.current === sessionId) {
          await loadActiveSession(sessionId);
        }
        await refreshSessions();
        setBudgetTick((n) => n + 1);
      });
  }

  const isStreaming =
    Boolean(liveStream && liveStream.sessionId === session?.id) ||
    messages.some((m) => m.status === "streaming");

  const handleStop = () => {
    handleRef.current?.stop();
  };

  const handleSend = async (overrideText?: string) => {
    if (!session || isStreaming || agentBusy) return;
    const text = (overrideText ?? input).trim();
    if (!text) return;

    if (activeGear === "agent") {
      if (!session.boundWorldId || boundWorldMissing || !boundWorldBrief) {
        toast("改档前请先选择一个要修改的故事");
        setSheet("context");
        return;
      }
      if (!overrideText) setInput("");
      setAgentBusy(true);
      try {
        await escalateCompanionToAgent(game, {
          sessionId: session.id,
          text,
          policy: agentPolicy,
        });
        await loadActiveSession(session.id);
        await refreshSessions();
        setBudgetTick((n) => n + 1);
        followRef.current = true;
        requestAnimationFrame(() => scrollBottom(true));
      } catch (err) {
        if (overrideText === undefined) setInput(text);
        toast(err instanceof Error ? err.message : "未能启动改档任务");
      } finally {
        if (aliveRef.current) setAgentBusy(false);
      }
      return;
    }

    if (!overrideText) setInput("");
    const lastMsg = messages.at(-1);
    startStreamRun(session.id, {
      sessionId: session.id,
      gear: activeGear === "research" ? "research" : "chat",
      text,
      parentId: lastMsg?.id ?? session.activeLeafId ?? null,
    });
  };

  const handleEditResend = (msg: CompanionMessage) => {
    if (!session || isStreaming) return;
    const text = editingText.trim();
    if (!text) return;
    setEditingMsgId(null);
    setEditingText("");
    startStreamRun(session.id, {
      sessionId: session.id,
      gear: activeGear === "research" ? "research" : "chat",
      text,
      parentId: msg.parentId,
      editMessageId: msg.id,
    });
  };

  const handleRegenerate = (msg: CompanionMessage) => {
    if (!session || isStreaming) return;
    const parentUser =
      messages.find((m) => m.id === msg.parentId) ??
      [...messages]
        .slice(0, messages.findIndex((m) => m.id === msg.id))
        .reverse()
        .find((m) => m.role === "user");
    startStreamRun(session.id, {
      sessionId: session.id,
      gear: msg.gear === "research" || activeGear === "research" ? "research" : "chat",
      text: parentUser?.content ?? "",
      parentId: msg.parentId,
      regenerateMessageId: msg.id,
    });
  };

  const handleSwitchBranch = async (targetSiblingId: string) => {
    if (!session || isStreaming) return;
    try {
      const updated = await updateSession(game, session.id, { activeLeafId: targetSiblingId });
      setSession(updated);
      await loadActiveSession(session.id);
    } catch {
      toast("切换分支未成功，请重试");
    }
  };

  const handleSwitchGear = async (nextGear: CompanionGear) => {
    if (!session || session.activeGear === nextGear) return;
    setSession({ ...session, activeGear: nextGear });
    try {
      const saved = await updateSession(game, session.id, { activeGear: nextGear });
      if (aliveRef.current && activeSessionRef.current === saved.id) setSession(saved);
    } catch {
      /* ignore */
    }
  };

  const handleSelectPersona = async (persona: CompanionPersona) => {
    if (!session) return;
    if (messages.length === 0) {
      const updated = await updateSession(game, session.id, { personaId: persona.id });
      setSession(updated);
      await refreshSessions();
    } else {
      const created = await createSession(game, {
        personaId: persona.id,
        activeGear: persona.roleKind === "roleplay" || persona.roleKind === "npc" ? "chat" : session.activeGear,
        boundWorldId: session.boundWorldId,
        boundLineId: session.boundLineId,
        boundBookId: session.boundBookId,
        bookScope: session.bookScope,
      });
      await refreshSessions();
      await loadActiveSession(created.id);
      toast(`已与「${persona.name}」新开对话`);
    }
  };

  const handleNewSession = async () => {
    if (isStreaming) handleStop();
    const inheritWorld = Boolean(props.worldId || (session?.boundWorldId && !session?.legacyPi));
    const nextWorldId = props.worldId ?? (inheritWorld ? (session?.boundWorldId ?? null) : null);
    const nextLineId = props.worldId
      ? (props.lineId ?? session?.boundLineId ?? null)
      : inheritWorld
        ? (session?.boundLineId ?? null)
        : null;
    const nextBookId = props.bookId ?? (!session?.legacyPi ? (session?.boundBookId ?? null) : null);
    const nextGear: CompanionGear =
      activeGear === "agent" && !nextWorldId
        ? "chat"
        : session?.legacyPi && !props.worldId
          ? "chat"
          : activeGear;
    const created = await createSession(game, {
      personaId: activePersona.id,
      activeGear: nextGear,
      boundWorldId: nextWorldId,
      boundLineId: nextLineId,
      boundBookId: nextBookId,
      bookScope: nextBookId || nextWorldId ? (session?.bookScope ?? null) : null,
    });
    setEditingMsgId(null);
    await refreshSessions();
    await loadActiveSession(created.id);
    setSheet(null);
  };

  const handleSelectSession = async (target: CompanionSession) => {
    if (target.id === session?.id) {
      setSheet(null);
      return;
    }
    setEditingMsgId(null);
    await loadActiveSession(target.id);
    setSheet(null);
  };

  const handleRenameSession = async (target: CompanionSession) => {
    const title = await askName({
      title: "修改对话名称",
      initial: target.title,
      placeholder: "输入好记的对话标题",
      confirm: "保存",
    });
    if (!title || title === target.title) return;
    const saved = await updateSession(game, target.id, { title });
    if (session?.id === saved.id) setSession(saved);
    await refreshSessions();
    toast("已改名");
  };

  const handlePinSession = async (target: CompanionSession) => {
    const saved = await updateSession(game, target.id, { pinned: !target.pinned });
    if (session?.id === saved.id) setSession(saved);
    await refreshSessions();
    toast(saved.pinned ? "已置顶对话" : "已取消置顶");
  };

  const handleDeleteSession = async (target: CompanionSession) => {
    const ok = await ask({
      title: `删除对话「${target.title || "未命名对话"}」？`,
      message: "只删除这段对话记录；已经存入札记、记忆簿或故事里的修改都会保留。",
      confirm: "删除",
      danger: true,
    });
    if (!ok) return;
    if (session?.id === target.id && isStreaming) handleStop();
    await deleteSession(game, target.id);
    const rest = await refreshSessions();
    if (session?.id === target.id) {
      if (rest.length > 0) {
        await loadActiveSession(rest[0].id);
      } else {
        const fresh = await createSession(game, { personaId: activePersona.id });
        await refreshSessions();
        await loadActiveSession(fresh.id);
      }
    }
    toast("对话已删除");
  };

  const handleCompactSession = async () => {
    if (!session || isStreaming) return;
    try {
      await compactCompanionSession(game, session.id);
      await loadActiveSession(session.id);
      setBudgetTick((n) => n + 1);
      toast("已整理早期对话摘要");
    } catch (err) {
      toast(err instanceof Error ? err.message : "暂时无法整理对话摘要");
    }
  };

  const handleRememberMessage = async (msg: CompanionMessage) => {
    if (!session) return;
    try {
      const scope = activePersona.memoryScope === "global" ? "global" : "persona";
      await saveMemory(game, {
        scope,
        personaId: scope === "persona" ? activePersona.id : "",
        category: session.boundWorldId || session.boundBookId ? "lore" : "fact",
        content: summarizeForMemory(msg.content),
        sourceSessionId: session.id,
        sourceMessageId: msg.id,
        enabled: true,
        pinned: false,
      });
      await refreshMemoryCount(activePersona.id);
      toast("已记入记忆簿", {
        label: "查看",
        run: () => setSheet("memory"),
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : "没能记入记忆簿");
    }
  };

  const handleSaveAsNote = async (msg: CompanionMessage) => {
    if (!session) return;
    try {
      const note = await saveCompanionMessageAsNote(game, session, msg);
      setBudgetTick((n) => n + 1);
      toast(`已存进札记「${note.title}」`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "没能存入札记");
    }
  };

  const handleDraftNewGame = async (msg: CompanionMessage) => {
    try {
      const setup = draftSetupFromCompanionText(msg.content, activePersona.name);
      const defaults = await loadPlayDefaults(game.repo).catch(() => null);
      const bookId = session?.boundBookId ?? boundWorldBrief?.source?.bookId ?? null;
      const draft = normalizeOpeningDraft({
        ...EMPTY,
        ...(bookId && !setup.source ? { source: newBinding(bookId, false) } : {}),
        ...setup,
        age: setup.age != null ? String(setup.age) : "",
        settings: {
          ...EMPTY.settings,
          ...(defaults
            ? {
                perspective: defaults.perspective,
                style: defaults.style,
                length: defaults.length,
                choiceCount: defaults.choiceCount,
                intensity: defaults.intensity,
              }
            : {}),
          mode: setup.mode === "free" ? "free" : "history",
          clockStyle: setup.mode === "free" ? "elapsed" : "era",
          essentials: setup.essentials || "",
          rules: setup.rules || defaults?.rules || "",
        },
      });
      await game.repo.setSetting("newgameDraft", draft);
      toast("已带入新局草稿，可修改后开始");
      push({ name: "newgame" });
    } catch (err) {
      toast(err instanceof Error ? err.message : "未能生成新局草稿");
    }
  };

  const handleOpenCitation = async (cite: CompanionCitation) => {
    if (cite.kind === "web" && cite.url) {
      await openLink(platform, toast, cite.url);
      return;
    }
    if (cite.kind === "book" && cite.bookId) {
      const book = await getBook(game.repo, cite.bookId).catch(() => null);
      if (book) {
        const through =
          session?.bookScope?.mode === "through" && boundWorldBrief?.source
            ? (boundWorldBrief.source.through ?? boundWorldBrief.source.position)
            : session?.bookScope?.mode === "chapters"
              ? session.bookScope.to
              : null;
        setPreviewBook({ book, through, quote: cite.quote });
        return;
      }
      toast("这本参考书当前不在书库中");
      return;
    }
    if (cite.kind === "world" && session?.boundWorldId && !boundWorldMissing) {
      push({ name: "play", worldId: session.boundWorldId });
    }
  };

  const openAgentWorkspace = () => {
    if (!session?.boundWorldId || !boundWorldBrief) {
      setSheet("context");
      return;
    }
    const lineId = session.boundLineId ?? boundWorldBrief.lineId;
    if (!lineId) {
      toast("没有找到该故事的当前路线");
      return;
    }
    push({
      name: "agent",
      worldId: session.boundWorldId,
      lineId,
      ...(session.piSessionId ? { sessionId: session.piSessionId } : {}),
    });
  };

  // Build context attachment capsule text.
  const contextCapsule = useMemo(() => {
    if (session?.boundWorldId) {
      if (boundWorldMissing || !boundWorldBrief) {
        return { label: "原关联故事已移除", missing: true };
      }
      const title = boundWorldBrief.world.title || "未命名故事";
      const src = boundWorldBrief.source;
      const scope = session.bookScope;
      if (src) {
        if (scope?.mode === "full") {
          return { label: `🌍 《${title}》 · 读全书`, missing: false };
        }
        if (scope?.mode === "chapters") {
          return {
            label: `🌍 《${title}》 · 第 ${scope.from + 1}～${scope.to + 1} 节`,
            missing: false,
          };
        }
        const ceiling = src.through ?? src.position;
        return {
          label: `🌍 《${title}》 · 防剧透至第 ${ceiling + 1} 节`,
          missing: false,
        };
      }
      return { label: `🌍 《${title}》`, missing: false };
    }
    if (session?.boundBookId) {
      if (boundBookMissing || !boundBookBrief) {
        return { label: "原关联书籍已移除", missing: true };
      }
      const scope = session.bookScope;
      const suffix =
        scope?.mode === "chapters"
          ? ` · 防剧透至第 ${scope.to + 1} 节`
          : " · 读全书";
      return { label: `📚 《${boundBookBrief.title}》${suffix}`, missing: false };
    }
    return { label: "+ 关联故事 / 书库", missing: false };
  }, [session, boundWorldBrief, boundBookBrief, boundWorldMissing, boundBookMissing]);

  // Filter sessions for sidebar & sheet.
  const filteredSessions = useMemo(
    () =>
      sessions.filter((s) => {
        const pName = personas.find((p) => p.id === s.personaId)?.name ?? "";
        return localFind(sessionQuery, s.title, pName);
      }),
    [sessions, personas, sessionQuery],
  );
  const pinnedSessions = useMemo(() => filteredSessions.filter((s) => s.pinned), [filteredSessions]);
  const recentSessions = useMemo(() => filteredSessions.filter((s) => !s.pinned), [filteredSessions]);

  // Merge optimistic liveStream with persisted messages cleanly (zero duplicate bubbles).
  const hasPersistedStreaming = messages.some((m) => m.status === "streaming");
  const showOptimisticPair =
    Boolean(liveStream && liveStream.sessionId === session?.id) && !hasPersistedStreaming;

  const piTasksById = useMemo(() => {
    const map = new Map<string, AgentTask>();
    for (const t of projectedPi?.tasks ?? []) map.set(t.id, t);
    return map;
  }, [projectedPi]);

  const legacyTurns = useMemo(() => {
    if (!projectedPi || messages.length > 0) return [];
    return agentConversationTurns(projectedPi.messages, projectedPi.tasks);
  }, [projectedPi, messages.length]);

  const canSaveNote = Boolean(
    (session?.boundWorldId && !boundWorldMissing) ||
      (session?.boundBookId && !boundBookMissing),
  );

  const renderBranchNav = (msg: CompanionMessage) => {
    const siblings = msg.siblingIds ?? [];
    const total = msg.branchCount ?? siblings.length;
    if (total <= 1 || siblings.length <= 1) return null;
    const currentIdx =
      msg.branchIndex !== undefined
        ? msg.branchIndex
        : Math.max(0, siblings.indexOf(msg.id));
    return (
      <span className="companion-branch-nav" aria-label={`分支 ${currentIdx + 1} / ${total}`}>
        <button
          type="button"
          className="companion-branch-btn"
          aria-label="上一分支"
          disabled={isStreaming || currentIdx <= 0}
          onClick={() => void handleSwitchBranch(siblings[currentIdx - 1])}
        >
          ‹
        </button>
        <span>
          {currentIdx + 1} / {total}
        </span>
        <button
          type="button"
          className="companion-branch-btn"
          aria-label="下一分支"
          disabled={isStreaming || currentIdx >= siblings.length - 1}
          onClick={() => void handleSwitchBranch(siblings[currentIdx + 1])}
        >
          ›
        </button>
      </span>
    );
  };

  const renderThoughtDrawer = (
    status: CompanionMessage["status"],
    thinking: string,
    steps: CompanionStep[],
    citations: CompanionCitation[],
    hasContent = false,
  ) => {
    const hasAny = Boolean(thinking.trim() || steps.length > 0 || citations.length > 0);
    if (status === "streaming") {
      const runningStep = [...steps].reverse().find((s) => s.status === "running");
      if (!hasContent || runningStep) {
        const liveLabel =
          runningStep?.label || steps.at(-1)?.label || (thinking.trim() ? "正在思考…" : "正在构思回复…");
        return (
          <div className="companion-live-thought" role="status" aria-live="polite">
            <i className="companion-live-dot" aria-hidden="true" />
            <span>{liveLabel}</span>
          </div>
        );
      }
    }
    if (!hasAny) return null;
    return (
      <details className="companion-thought">
        <summary>
          <span>{thoughtSummaryLabel(thinking, steps, citations)}</span>
        </summary>
        <div className="companion-thought-body">
          {steps.length > 0 && (
            <div className="companion-steps-list">
              {steps.map((step) => (
                <div key={step.id} className="companion-step-item">
                  <span>
                    {step.label}
                    {step.query ? `「${step.query}」` : ""}
                    {step.summary ? ` · ${step.summary}` : ""}
                  </span>
                  <span className={`companion-step-status ${step.status}`}>
                    {step.status === "done"
                      ? "已查"
                      : step.status === "failed"
                        ? "未果"
                        : "查找中"}
                  </span>
                </div>
              ))}
            </div>
          )}
          {thinking.trim() && <pre className="companion-thinking-block">{thinking.trim()}</pre>}
          {citations.length > 0 && (
            <div className="companion-citations">
              {citations.map((cite, idx) => (
                <button
                  key={`${cite.title}-${idx}`}
                  type="button"
                  className="companion-citation-card"
                  onClick={() => void handleOpenCitation(cite)}
                >
                  <span className="companion-citation-head">
                    <span className="companion-citation-kind">
                      {cite.kind === "book" ? "原著" : cite.kind === "world" ? "本局" : "网页"}
                    </span>
                    <span className="companion-citation-title">
                      {cite.title}
                      {cite.section !== undefined ? ` · 第 ${cite.section + 1} 节` : ""}
                    </span>
                  </span>
                  {cite.quote && <span className="companion-citation-quote">{cite.quote}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </details>
    );
  };

  const refreshPiSessionNow = useCallback(async () => {
    const piId = session?.piSessionId;
    if (!piId) return;
    const next = await agentClient.pollSession(piId).catch(() => null);
    if (!next) return;
    const watched = next.tasks
      .slice(-6)
      .filter((t) => !t.runId.startsWith("imported:") && t.status !== "archived");
    const snaps = await Promise.all(
      watched.map(async (t) => {
        const fresh = await agentClient.delta(t.id, 0, 0);
        piSnapCache.current[t.runId] = fresh;
        piSnapVer.current[t.runId] = `${t.status}:${t.updatedAt ?? ""}`;
        return [t.runId, fresh] as const;
      }),
    ).catch(() => []);
    setPiDetail((cur) => mergeAgentSessionPage(cur, next, "latest"));
    if (snaps.length) setPiSnapshots((cur) => ({ ...cur, ...Object.fromEntries(snaps) }));
  }, [agentClient, session?.piSessionId]);

  const renderAgentTaskCard = (rawTask: AgentTask) => {
    const snap = piSnapshots[rawTask.runId];
    const task = agentTaskProjection(rawTask, snap);
    const status = agentTaskStatus(task, snap);
    const running = isTaskInFlight(status);
    const resumable = ["paused", "cancelled", "interrupted", "failed", "stale", "blocked"].includes(status);
    const previewData =
      task.preview ??
      task.changes ??
      (Array.isArray(task.drafts) && task.drafts.length > 0 ? { changes: task.drafts } : undefined);
    const diffs = extractAgentChanges(previewData);
    const draftCount = task.draftCount ?? (Array.isArray(task.drafts) ? task.drafts.length : 0);

    return (
      <div className="companion-agent-card" key={task.id}>
        <div className="companion-agent-head">
          <span
            className={`companion-agent-status${status === "committed" ? " done" : resumable ? " warn" : ""}`}
          >
            {AGENT_STATUS_TEXT[status] ?? "正在处理改档任务"}
          </span>
          <button type="button" className="ghost small" onClick={openAgentWorkspace}>
            查看修改预览 / 采用 ›
          </button>
        </div>

        {task.summary && <CompanionMarkdown text={task.summary} />}
        {(snap?.error || task.error) && (
          <p className="field-hint warn m-0">{snap?.error ?? task.error}</p>
        )}

        {diffs.length > 0 && (
          <details className="companion-agent-diffs" open={status === "previewed"}>
            <summary>变更对照（{diffs.length} 处）</summary>
            <div className="stack gap-2 mt-2">
              {diffs.map((item, idx) => (
                <div key={idx} className="companion-agent-diff-item">
                  <b>{item.summary}</b>
                  {item.before !== undefined && item.after !== undefined && (
                    <DiffView before={item.before} after={item.after} />
                  )}
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="companion-agent-actions">
          {running && task.execution?.attemptId && (
            <button
              type="button"
              onClick={() =>
                void agentClient
                  .stop(task.id, task.execution!.attemptId)
                  .catch(() => toast("正在停止任务…"))
              }
            >
              停止
            </button>
          )}
          {status === "previewed" && (
            <button
              type="button"
              className="primary"
              onClick={() =>
                void agentClient
                  .apply(task.id)
                  .then(async () => {
                    if (session?.boundWorldId) game.notifyAgentChange(session.boundWorldId);
                    await refreshPiSessionNow();
                    toast("这批修改已采用");
                  })
                  .catch((e) => toast(e instanceof Error ? e.message : "采用未成功"))
              }
            >
              采用这批修改
            </button>
          )}
          {!running && task.canUndo && (
            <button
              type="button"
              onClick={() =>
                void agentClient
                  .undo(task.id)
                  .then(async () => {
                    if (session?.boundWorldId) game.notifyAgentChange(session.boundWorldId);
                    await refreshPiSessionNow();
                    toast("已撤回这批修改");
                  })
                  .catch((e) => toast(e instanceof Error ? e.message : "撤回未成功"))
              }
            >
              撤回修改
            </button>
          )}
          {resumable && (
            <button
              type="button"
              onClick={() =>
                void agentClient
                  .continue(task.id)
                  .then(() => refreshPiSessionNow())
                  .catch((e) => toast(e instanceof Error ? e.message : "继续执行未成功"))
              }
            >
              继续执行
            </button>
          )}
          {resumable && draftCount > 0 && (
            <button
              type="button"
              onClick={async () => {
                const ok = await ask({
                  title: "清空未采用草稿？",
                  message: "只丢弃尚未采用的草稿，故事已生效的内容不受影响。",
                  confirm: "清空草稿",
                  danger: true,
                });
                if (!ok) return;
                await agentClient.discardDrafts(task.id).catch(() => null);
                await refreshPiSessionNow();
                toast("未采用草稿已清空");
              }}
            >
              清空草稿
            </button>
          )}
          {session?.boundWorldId && !boundWorldMissing && (
            <button
              type="button"
              className="ghost"
              onClick={() =>
                void agentClient
                  .recoveryPoints(session.boundWorldId!)
                  .then(setRecoveries)
                  .catch(() => toast("暂未读到恢复点"))
              }
            >
              恢复点
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderSessionRow = (item: CompanionSession) => {
    const active = item.id === session?.id;
    const p = personas.find((x) => x.id === item.personaId) ?? getBuiltinPersona(item.personaId);
    const w = item.boundWorldId ? worlds.find((x) => x.world.id === item.boundWorldId) : null;
    return (
      <div key={item.id} className={`companion-session-row${active ? " active" : ""}`}>
        <button
          type="button"
          className="companion-session-open"
          onClick={() => void handleSelectSession(item)}
        >
          <span className="companion-session-title">
            {item.pinned && <Icon name="pin" size={13} />}
            <span>{item.title || "新对话"}</span>
          </span>
          <span className="companion-session-meta">
            {p?.name ?? "灵犀"}
            {w ? ` · 《${w.world.title}》` : ""}
          </span>
        </button>
        <button
          type="button"
          className="companion-session-more"
          aria-label={`对话「${item.title || "新对话"}」操作`}
          onClick={() => setMenuSession(item)}
        >
          <Icon name="more" size={18} />
        </button>
      </div>
    );
  };

  const personaAvatarText = (activePersona.avatar?.trim() || [...activePersona.name][0] || "灵").slice(0, 2);
  const starters = useMemo(
    () =>
      defaultStarters(
        activePersona,
        activeGear,
        boundWorldBrief?.world.title,
        boundBookBrief?.title,
      ),
    [activePersona, activeGear, boundWorldBrief?.world.title, boundBookBrief?.title],
  );

  const isEmptyConversation =
    messages.length === 0 && !showOptimisticPair && legacyTurns.length === 0;

  return (
    <div className={`companion-layout${isDesktop ? " is-desktop" : ""}`}>
      <BudgetReminder revision={budgetTick} />

      {/* ---------- Desktop Persistent Sidebar (>=900px) ---------- */}
      {isDesktop && (
        <aside className="companion-sidebar" aria-label="对话与角色栏">
          <div className="companion-sidebar-top">
            <div className="companion-sidebar-brand">
              <button type="button" className="icon-btn" aria-label="返回" onClick={pop}>
                <Icon name="back" />
              </button>
              <h1>伴聊</h1>
            </div>
            <button
              type="button"
              className="companion-new-chat-btn"
              onClick={() => void handleNewSession()}
            >
              <Icon name="plus" size={18} />
              新建对话
            </button>
            <input
              type="search"
              className="companion-search-input"
              aria-label="搜索对话"
              placeholder="搜索对话或角色…"
              value={sessionQuery}
              onChange={(e) => {
                setSessionQuery(e.target.value);
                void refreshSessions(e.target.value);
              }}
            />
          </div>

          <div className="companion-sidebar-sessions">
            {pinnedSessions.length > 0 && (
              <>
                <div className="companion-group-label">置顶对话</div>
                {pinnedSessions.map(renderSessionRow)}
              </>
            )}
            <div className="companion-group-label">最近对话</div>
            {recentSessions.map(renderSessionRow)}
            {!filteredSessions.length && (
              <p className="muted t-center mt-3">没有找到匹配的对话</p>
            )}
          </div>

          <div className="companion-sidebar-foot">
            <button
              type="button"
              className="companion-sidebar-persona"
              aria-label={`切换角色，当前 ${activePersona.name}`}
              onClick={() => setSheet("persona")}
            >
              <span
                className={`companion-avatar${activePersona.roleKind === "npc" ? " role-npc" : ""}`}
                aria-hidden="true"
              >
                {personaAvatarText}
              </span>
              <span className="companion-sidebar-persona-info">
                <b>{activePersona.name}</b>
                <small>{activePersona.tagline || ROLE_KIND_TAG[activePersona.roleKind]}</small>
              </span>
              <span className="companion-persona-pill-caret" aria-hidden="true">
                ▾
              </span>
            </button>
            <button
              type="button"
              className="companion-sidebar-memory-btn"
              onClick={() => setSheet("memory")}
            >
              <Icon name="bookmark" size={17} />
              记忆簿{memoryCount > 0 ? `（${memoryCount}）` : ""}
            </button>
          </div>
        </aside>
      )}

      {/* ---------- Main Conversation Column ---------- */}
      <main className="companion-main">
        <header className="companion-topbar">
          <div className="companion-topbar-side">
            {!isDesktop && (
              <button type="button" className="icon-btn" aria-label="返回" onClick={pop}>
                <Icon name="back" />
              </button>
            )}
            {!isDesktop && (
              <button
                type="button"
                className="icon-btn"
                aria-label="对话列表"
                title="对话列表"
                onClick={() => {
                  void refreshSessions();
                  setSheet("sessions");
                }}
              >
                <Icon name="list" />
              </button>
            )}
          </div>

          <button
            type="button"
            className="companion-persona-pill"
            aria-label={`当前角色：${activePersona.name}，点此切换`}
            onClick={() => setSheet("persona")}
          >
            <span
              className={`companion-avatar mini${activePersona.roleKind === "npc" ? " role-npc" : ""}`}
              aria-hidden="true"
            >
              {personaAvatarText}
            </span>
            <span className="companion-persona-pill-name">{activePersona.name}</span>
            <span className="companion-persona-pill-caret" aria-hidden="true">
              ▾
            </span>
          </button>

          <div className="companion-topbar-side">
            <button
              type="button"
              className="icon-btn"
              aria-label={memoryCount > 0 ? `记忆簿（${memoryCount} 条启用）` : "记忆簿"}
              title="记忆簿"
              onClick={() => setSheet("memory")}
            >
              <Icon name="bookmark" size={21} />
              {memoryCount > 0 && (
                <span className="companion-memory-badge" aria-hidden="true">
                  {memoryCount > 99 ? "99" : memoryCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="更多操作"
              title="更多操作"
              onClick={() => setSheet("more")}
            >
              <Icon name="more" />
            </button>
          </div>
        </header>

        <div className="companion-stream-wrap">
          <div className="companion-stream" ref={scrollerRef} onScroll={handleScroll}>
            <div className="companion-stream-inner">
              {session?.summaryText && (
                <details className="companion-summary-fold">
                  <summary>已整理的早期对话摘要</summary>
                  <div className="companion-summary-body">{session.summaryText}</div>
                </details>
              )}

              {isEmptyConversation && (
                <section className="companion-empty" aria-label="角色欢迎页">
                  <div className="companion-empty-head">
                    <div
                      className={`companion-avatar hero-seal${activePersona.roleKind === "npc" ? " role-npc" : ""}`}
                      aria-hidden="true"
                    >
                      {personaAvatarText}
                    </div>
                    <h2>{activePersona.name}</h2>
                    <span className="companion-role-badge">
                      {ROLE_KIND_TAG[activePersona.roleKind]}
                      {activePersona.pureRoleplay ? " · 沉浸防出戏" : ""}
                    </span>
                    {activePersona.tagline && <p className="muted m-0">{activePersona.tagline}</p>}
                  </div>

                  {activePersona.greeting && (
                    <div className="companion-greeting-box">{activePersona.greeting}</div>
                  )}

                  <div className="companion-starters" role="group" aria-label="开场话题推荐">
                    {starters.map((promptText, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className="companion-starter-chip"
                        onClick={() => {
                          if (!profile && !game.llm) {
                            setInput(promptText);
                            toast("先连接 AI 服务即可开始对话");
                          } else if (activeGear === "agent" && (!session?.boundWorldId || boundWorldMissing)) {
                            setInput(promptText);
                            setSheet("context");
                          } else {
                            void handleSend(promptText);
                          }
                        }}
                      >
                        <span>{promptText}</span>
                        <i aria-hidden="true">›</i>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Legacy assistant-only sessions rendered seamlessly */}
              {legacyTurns.map((turn) => (
                <div key={turn.id} className="stack gap-2">
                  {turn.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`companion-msg ${m.role === "user" ? "user" : "assistant"}`}
                    >
                      {m.role === "user" ? (
                        <div className="companion-user-bubble">{m.displayContent ?? m.content}</div>
                      ) : (
                        <div className="companion-msg-prose">
                          <CompanionMarkdown text={m.displayContent ?? m.content} />
                        </div>
                      )}
                    </div>
                  ))}
                  {turn.task && renderAgentTaskCard(turn.task)}
                </div>
              ))}

              {/* Main tree-projected CompanionMessages */}
              {messages.map((msg) => {
                if (msg.role === "system_note") {
                  return (
                    <div key={msg.id} className="companion-msg system_note" data-message-id={msg.id}>
                      <span className="companion-note-pill">{msg.content}</span>
                    </div>
                  );
                }

                if (msg.role === "user") {
                  const isEditingThis = editingMsgId === msg.id;
                  return (
                    <div key={msg.id} className="companion-msg user" data-message-id={msg.id}>
                      {isEditingThis ? (
                        <div className="companion-inline-editor">
                          <textarea
                            rows={3}
                            aria-label="编辑并另起分支重发"
                            value={editingText}
                            onChange={(e) => setEditingText(e.target.value)}
                            onKeyDown={(e) => {
                              if (
                                e.key === "Enter" &&
                                !e.shiftKey &&
                                !e.nativeEvent.isComposing &&
                                e.keyCode !== 229
                              ) {
                                e.preventDefault();
                                handleEditResend(msg);
                              }
                            }}
                          />
                          <div className="row between">
                            <small className="muted">保存后将另起一条新分支，原分支保留</small>
                            <div className="row">
                              <button
                                type="button"
                                className="ghost small"
                                onClick={() => {
                                  setEditingMsgId(null);
                                  setEditingText("");
                                }}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className="primary small"
                                disabled={!editingText.trim() || isStreaming}
                                onClick={() => handleEditResend(msg)}
                              >
                                重发
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="companion-user-bubble">{msg.content}</div>
                          <div className="companion-msg-tools">
                            {renderBranchNav(msg)}
                            <button
                              type="button"
                              className="companion-action-btn"
                              disabled={isStreaming}
                              onClick={() => {
                                setEditingMsgId(msg.id);
                                setEditingText(msg.content);
                              }}
                            >
                              <Icon name="pen" size={14} />
                              编辑重发
                            </button>
                            <button
                              type="button"
                              className="companion-action-btn"
                              onClick={() =>
                                void navigator.clipboard
                                  ?.writeText(msg.content)
                                  .then(() => toast("已复制"), () => toast("没能复制"))
                              }
                            >
                              <Icon name="copy" size={14} />
                              复制
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                }

                // Assistant message
                const useLive =
                  msg.status === "streaming" &&
                  liveStream &&
                  liveStream.sessionId === session?.id;
                const effStatus = useLive ? liveStream.update.status : msg.status;
                const effText = useLive && liveStream.update.text ? liveStream.update.text : msg.content;
                const effThinking =
                  useLive && liveStream.update.thinking ? liveStream.update.thinking : msg.thinking;
                const effSteps =
                  useLive && liveStream.update.steps.length ? liveStream.update.steps : msg.steps;
                const effCitations =
                  useLive && liveStream.update.citations.length
                    ? liveStream.update.citations
                    : msg.citations;
                const linkedTask = msg.piTaskId ? piTasksById.get(msg.piTaskId) : undefined;

                return (
                  <article key={msg.id} className="companion-msg assistant" data-message-id={msg.id}>
                    <div className="companion-msg-head">
                      <span
                        className={`companion-avatar mini${activePersona.roleKind === "npc" ? " role-npc" : ""}`}
                        aria-hidden="true"
                      >
                        {personaAvatarText}
                      </span>
                      <span className="companion-msg-author">{activePersona.name}</span>
                      {msg.gear !== "chat" && (
                        <span className="companion-gear-tag">{GEAR_BADGE[msg.gear]}</span>
                      )}
                    </div>

                    {renderThoughtDrawer(effStatus, effThinking, effSteps, effCitations, Boolean(effText.trim()))}

                    {effText && (
                      <div className="companion-msg-prose">
                        <CompanionMarkdown
                          text={effText}
                          streaming={effStatus === "streaming"}
                        />
                      </div>
                    )}

                    {!effText.trim() && (effStatus === "cancelled" || effStatus === "interrupted") && !linkedTask && !msg.piTaskId && (
                      <p className="muted m-0">（已停止生成）</p>
                    )}

                    {linkedTask && renderAgentTaskCard(linkedTask)}

                    {!linkedTask && msg.piTaskId && session?.boundWorldId && !boundWorldMissing && (
                      <div className="companion-agent-card">
                        <div className="companion-agent-head">
                          <span className="companion-agent-status">已提交改档任务</span>
                          <button type="button" className="primary small" onClick={openAgentWorkspace}>
                            查看修改预览 / 采用 ›
                          </button>
                        </div>
                      </div>
                    )}

                    {msg.errorText && effStatus !== "streaming" && (
                      <p className="field-hint warn m-0" role="alert">
                        {msg.errorText}
                      </p>
                    )}

                    {devMode && msg.usage && effStatus !== "streaming" && (
                      <div className="companion-dev-usage">
                        开发者统计：{msg.modelId || "默认模型"} · 输入 {msg.usage.promptTokens ?? "?"} tokens · 输出{" "}
                        {msg.usage.completionTokens ?? "?"} tokens
                      </div>
                    )}

                    {effStatus !== "streaming" && (
                      <div className="companion-msg-tools">
                        {renderBranchNav(msg)}
                        {!msg.piTaskId && (
                          <button
                            type="button"
                            className="companion-action-btn"
                            disabled={isStreaming}
                            onClick={() => handleRegenerate(msg)}
                          >
                            <Icon name="refresh" size={14} />
                            换个回答
                          </button>
                        )}
                        {effText && (
                          <button
                            type="button"
                            className="companion-action-btn"
                            onClick={() =>
                              void navigator.clipboard
                                ?.writeText(effText)
                                .then(() => toast("已复制"), () => toast("没能复制"))
                            }
                          >
                            <Icon name="copy" size={14} />
                            复制
                          </button>
                        )}
                        {effText && (
                          <button
                            type="button"
                            className="companion-action-btn"
                            onClick={() => void handleRememberMessage(msg)}
                          >
                            <Icon name="bookmark" size={14} />
                            记住这条
                          </button>
                        )}
                        {effText && canSaveNote && (
                          <button
                            type="button"
                            className="companion-action-btn bridge"
                            onClick={() => void handleSaveAsNote(msg)}
                          >
                            <Icon name="memo" size={14} />
                            存进札记
                          </button>
                        )}
                        {effText && (
                          <button
                            type="button"
                            className="companion-action-btn bridge"
                            onClick={() => void handleDraftNewGame(msg)}
                          >
                            <Icon name="sparkle" size={14} />
                            拿去开新局
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}

              {/* Optimistic pair before SQLite row roundtrip lands */}
              {showOptimisticPair && liveStream && (
                <>
                  {liveStream.mode !== "regenerate" && liveStream.userText && (
                    <div className="companion-msg user">
                      <div className="companion-user-bubble">{liveStream.userText}</div>
                    </div>
                  )}
                  <article className="companion-msg assistant">
                    <div className="companion-msg-head">
                      <span
                        className={`companion-avatar mini${activePersona.roleKind === "npc" ? " role-npc" : ""}`}
                        aria-hidden="true"
                      >
                        {personaAvatarText}
                      </span>
                      <span className="companion-msg-author">{activePersona.name}</span>
                      {liveStream.gear !== "chat" && (
                        <span className="companion-gear-tag">{GEAR_BADGE[liveStream.gear]}</span>
                      )}
                    </div>
                    {renderThoughtDrawer(
                      "streaming",
                      liveStream.update.thinking,
                      liveStream.update.steps,
                      liveStream.update.citations,
                      Boolean(liveStream.update.text.trim()),
                    )}
                    {liveStream.update.text && (
                      <div className="companion-msg-prose">
                        <CompanionMarkdown text={liveStream.update.text} streaming />
                      </div>
                    )}
                  </article>
                </>
              )}
            </div>
          </div>

          {!atBottom && (
            <button
              type="button"
              className={`to-bottom${isStreaming ? " fresh" : ""}`}
              aria-label="回到底部"
              onClick={() => {
                followRef.current = reading.autoScroll;
                scrollBottom(true);
              }}
            >
              <Icon name="arrow-down" size={22} />
            </button>
          )}
        </div>

        {/* ---------- Compact Bottom Dock ---------- */}
        <footer className="companion-dock">
          <div className="companion-dock-inner">
            {activeGear === "agent" && (!session?.boundWorldId || boundWorldMissing) && (
              <div className="companion-agent-hint" role="status">
                <span>改档需要先选定一个故事，所有修改都会先生成预览供你确认。</span>
                <button type="button" className="primary" onClick={() => setSheet("context")}>
                  选择故事
                </button>
              </div>
            )}

            {activeGear === "agent" && session?.boundWorldId && !boundWorldMissing && boundWorldBrief && (
              <div className="companion-agent-hint">
                <span>
                  改档方式：
                  {agentPolicy === "preview"
                    ? `先看修改预览，确认后才写入《${boundWorldBrief.world.title}》`
                    : `直接生效并保留《${boundWorldBrief.world.title}》恢复点`}
                </span>
                <div className="row gap-1">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      setAgentPolicy((p) => (p === "preview" ? "auto-reversible" : "preview"))
                    }
                  >
                    切换为{agentPolicy === "preview" ? "直接生效（可撤回）" : "先看预览"}
                  </button>
                  {session.piSessionId && (
                    <button type="button" className="ghost" onClick={openAgentWorkspace}>
                      打开改档详情 ›
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="companion-dock-bar">
              <div className="companion-gears" role="group" aria-label="对话档位">
                {GEAR_META.map(([gearKey, label, desc]) => (
                  <button
                    key={gearKey}
                    type="button"
                    className="companion-gear-btn"
                    title={desc}
                    aria-pressed={activeGear === gearKey}
                    onClick={() => void handleSwitchGear(gearKey)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                className={`companion-context-pill${contextCapsule.missing ? " missing" : ""}`}
                aria-label={`关联资料：${contextCapsule.label}`}
                onClick={() => setSheet("context")}
              >
                <span>{contextCapsule.label}</span>
              </button>
            </div>

            <div className="companion-composer">
              <textarea
                ref={textareaRef}
                className="companion-textarea"
                rows={1}
                aria-label="输入消息"
                value={input}
                disabled={agentBusy}
                placeholder={
                  activeGear === "agent"
                    ? boundWorldBrief && !boundWorldMissing
                      ? `说明要帮改《${boundWorldBrief.world.title}》的哪处…`
                      : "先点上方“选择故事”，再说要改什么…"
                    : activeGear === "research"
                      ? `向${activePersona.name}查原著、设定或史料…`
                      : `和${activePersona.name}聊聊想法或对戏…`
                }
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    e.keyCode !== 229
                  ) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              {isStreaming ? (
                <button
                  type="button"
                  className="companion-send-btn stop"
                  aria-label="停止生成"
                  title="停止"
                  onClick={handleStop}
                >
                  <Icon name="stop" size={20} />
                </button>
              ) : (
                <button
                  type="button"
                  className={`companion-send-btn${input.trim() && !agentBusy ? " ready" : ""}`}
                  aria-label="发送"
                  title="发送"
                  disabled={!input.trim() || agentBusy || !session}
                  onClick={() => void handleSend()}
                >
                  <Icon name="send" size={20} />
                </button>
              )}
            </div>
          </div>
        </footer>
      </main>

      {/* ---------- Mobile Sessions Drawer Sheet ---------- */}
      {sheet === "sessions" && (
        <Sheet title="对话列表" onClose={() => setSheet(null)}>
          <div className="stack">
            <button
              type="button"
              className="primary"
              onClick={() => void handleNewSession()}
            >
              <Icon name="plus" size={18} />
              新建对话
            </button>
            <input
              type="search"
              aria-label="搜索对话"
              placeholder="搜索对话标题或角色名"
              value={sessionQuery}
              onChange={(e) => {
                setSessionQuery(e.target.value);
                void refreshSessions(e.target.value);
              }}
            />
            {pinnedSessions.length > 0 && (
              <>
                <h3 className="settings-sub">置顶对话</h3>
                <div className="stack gap-1">{pinnedSessions.map(renderSessionRow)}</div>
              </>
            )}
            <h3 className="settings-sub">最近对话</h3>
            <div className="stack gap-1">{recentSessions.map(renderSessionRow)}</div>
            {!filteredSessions.length && <p className="muted">还没有匹配的对话。</p>}
          </div>
        </Sheet>
      )}

      {/* ---------- Session Context Menu ---------- */}
      {menuSession && (
        <MenuSheet
          title={menuSession.title || "对话操作"}
          onClose={() => setMenuSession(null)}
          items={[
            {
              label: menuSession.pinned ? "取消置顶" : "置顶这段对话",
              icon: "pin",
              onSelect: () => void handlePinSession(menuSession),
            },
            {
              label: "修改名称",
              icon: "pen",
              onSelect: () => void handleRenameSession(menuSession),
            },
            {
              label: "删除这段对话",
              icon: "close",
              danger: true,
              onSelect: () => void handleDeleteSession(menuSession),
            },
          ]}
        />
      )}

      {/* ---------- Topbar More Menu ---------- */}
      {sheet === "more" && (
        <MenuSheet
          title="当前对话"
          onClose={() => setSheet(null)}
          items={[
            {
              label: "新建对话",
              icon: "plus",
              onSelect: () => void handleNewSession(),
            },
            {
              label: "角色工坊",
              icon: "people",
              onSelect: () => setSheet("persona"),
            },
            {
              label: "记忆簿",
              icon: "bookmark",
              onSelect: () => setSheet("memory"),
            },
            {
              label: "关联故事或参考书",
              icon: "book",
              onSelect: () => setSheet("context"),
            },
            {
              label: "打开改档预览与恢复点",
              icon: "branch",
              hidden: !session?.boundWorldId || boundWorldMissing,
              onSelect: openAgentWorkspace,
            },
            {
              label: "整理早期对话摘要",
              icon: "memo",
              hidden: messages.length < 6,
              onSelect: () => void handleCompactSession(),
            },
            {
              label: session?.pinned ? "取消置顶当前对话" : "置顶当前对话",
              icon: "pin",
              hidden: !session,
              onSelect: () => {
                if (session) void handlePinSession(session);
              },
            },
            {
              label: "重命名当前对话",
              icon: "pen",
              hidden: !session,
              onSelect: () => {
                if (session) void handleRenameSession(session);
              },
            },
            {
              label: "设置与连接服务",
              icon: "settings",
              onSelect: () => push({ name: "settings" }),
            },
            {
              label: "删除当前对话",
              icon: "close",
              danger: true,
              hidden: !session,
              onSelect: () => {
                if (session) void handleDeleteSession(session);
              },
            },
          ]}
        />
      )}

      {/* ---------- Persona Studio Sheet ---------- */}
      {sheet === "persona" && (
        <PersonaSheet
          personas={personas}
          activePersonaId={activePersona.id}
          boundWorldId={!boundWorldMissing ? session?.boundWorldId : null}
          onSelect={(p) => void handleSelectPersona(p)}
          onChanged={(updated) => setPersonas(updated.length ? updated : BUILTIN_PERSONAS)}
          onClose={() => setSheet(null)}
        />
      )}

      {/* ---------- Controllable Memory Sheet ---------- */}
      {sheet === "memory" && (
        <MemorySheet
          persona={activePersona}
          onCountChange={setMemoryCount}
          onClose={() => setSheet(null)}
        />
      )}

      {/* ---------- Context Attachment Sheet (World / Book / Spoiler Ceiling) ---------- */}
      {sheet === "context" && session && (
        <ContextAttachmentSheet
          session={session}
          worlds={worlds}
          books={books}
          onOpenSourceLibrary={() => setSheet("sourceLib")}
          onApply={async (patch) => {
            const saved = await updateSession(game, session.id, patch);
            setSession(saved);
            await refreshSessions();
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}

      {sheet === "sourceLib" && (
        <SourceLibrary
          onClose={() => {
            void refreshReferenceLists();
            setSheet("context");
          }}
          onSelect={(book) => {
            void refreshReferenceLists();
            if (session) {
              void updateSession(game, session.id, {
                boundWorldId: null,
                boundLineId: null,
                boundBookId: book.id,
                bookScope: { mode: "full" },
              }).then((saved) => {
                setSession(saved);
                void refreshSessions();
              });
            }
          }}
        />
      )}

      {/* ---------- Book Citation Preview Sheet ---------- */}
      {previewBook && (
        <Sheet title={previewBook.book.title} onClose={() => setPreviewBook(null)}>
          <div className="stack">
            {previewBook.quote && (
              <div className="notice">
                <div className="notice-body">
                  <p>引用片段：{previewBook.quote}</p>
                </div>
              </div>
            )}
            <BookPreview book={previewBook.book} through={previewBook.through} />
          </div>
        </Sheet>
      )}

      {/* ---------- Recovery Points Sheet ---------- */}
      {recoveries && session?.boundWorldId && (
        <Sheet title="故事修改恢复点" onClose={() => setRecoveries(null)}>
          <div className="stack">
            <p className="muted m-0">
              每一次改档采用前都会自动留存恢复点，点选即可撤回那一批修改。
            </p>
            {recoveries.map((pt) => (
              <button
                key={pt.id}
                type="button"
                onClick={async () => {
                  const ok = await ask({
                    title: "撤回这批故事修改？",
                    message: "若故事在那之后已有新进展，会安全中止撤回以保护当前存档。",
                    confirm: "撤回",
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    await agentClient.restoreRecovery(pt.id);
                    game.notifyAgentChange(session.boundWorldId!);
                    setRecoveries(await agentClient.recoveryPoints(session.boundWorldId!));
                    toast("已恢复到修改前状态");
                  } catch (e) {
                    toast(e instanceof Error ? e.message : "未能恢复");
                  }
                }}
              >
                {new Date(pt.createdAt).toLocaleString("zh-CN")} · 撤回这批修改
              </button>
            ))}
            {!recoveries.length && <p className="muted">当前还没有可用的恢复点。</p>}
          </div>
        </Sheet>
      )}
    </div>
  );
}

function ContextAttachmentSheet({
  session,
  worlds,
  books,
  onOpenSourceLibrary,
  onApply,
  onClose,
}: {
  session: CompanionSession;
  worlds: WorldBrief[];
  books: BookBrief[];
  onOpenSourceLibrary: () => void;
  onApply: (
    patch: Pick<
      CompanionSession,
      "boundWorldId" | "boundLineId" | "boundBookId" | "bookScope"
    >,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"world" | "book">(
    session.boundBookId && !session.boundWorldId ? "book" : "world",
  );
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(session.boundWorldId);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(session.boundBookId);
  const [scopeMode, setScopeMode] = useState<"through" | "full" | "chapters">(
    session.bookScope?.mode ?? "through",
  );
  const [fromSec, setFromSec] = useState(
    String((session.bookScope?.mode === "chapters" ? session.bookScope.from : 0) + 1),
  );
  const [toSec, setToSec] = useState(
    String((session.bookScope?.mode === "chapters" ? session.bookScope.to : 19) + 1),
  );
  const [saving, setSaving] = useState(false);

  const chosenWorld = worlds.find((w) => w.world.id === selectedWorldId) ?? null;

  const buildScope = (hasWorldSource: boolean): CompanionBookScope | null => {
    if (scopeMode === "chapters") {
      const a = Math.max(1, Math.trunc(Number(fromSec) || 1)) - 1;
      const b = Math.max(a, Math.trunc(Number(toSec) || a + 1) - 1);
      return { mode: "chapters", from: a, to: b };
    }
    if (scopeMode === "full") return { mode: "full" };
    return hasWorldSource ? { mode: "through" } : { mode: "full" };
  };

  const saveWorldSelection = async (w: WorldBrief | null) => {
    setSaving(true);
    try {
      if (!w) {
        await onApply({
          boundWorldId: null,
          boundLineId: null,
          boundBookId: null,
          bookScope: null,
        });
        return;
      }
      await onApply({
        boundWorldId: w.world.id,
        boundLineId: w.lineId,
        boundBookId: w.source?.bookId ?? null,
        bookScope: w.source ? buildScope(true) : null,
      });
    } finally {
      setSaving(false);
    }
  };

  const saveBookSelection = async (bookId: string | null) => {
    setSaving(true);
    try {
      if (!bookId) {
        await onApply({
          boundWorldId: null,
          boundLineId: null,
          boundBookId: null,
          bookScope: null,
        });
        return;
      }
      await onApply({
        boundWorldId: null,
        boundLineId: null,
        boundBookId: bookId,
        bookScope: scopeMode === "chapters" ? buildScope(false) : { mode: "full" },
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title="关联故事或书库资料" onClose={onClose}>
      <div className="stack">
        <div className="segmented" role="tablist" aria-label="关联类型">
          <button
            type="button"
            aria-pressed={tab === "world"}
            onClick={() => setTab("world")}
          >
            书架上的故事
          </button>
          <button
            type="button"
            aria-pressed={tab === "book"}
            onClick={() => setTab("book")}
          >
            参考书库
          </button>
        </div>

        {(session.boundWorldId || session.boundBookId) && (
          <button
            type="button"
            className="ghost"
            disabled={saving}
            onClick={() => void saveWorldSelection(null)}
          >
            解除当前关联（改为自由闲聊）
          </button>
        )}

        {tab === "world" ? (
          <>
            <p className="muted m-0">
              关联故事后，查资料会自动读取本局人物、设定与最近剧情；切到“改档”还能先预览再修改本局。
            </p>
            {chosenWorld?.source && (
              <div className="stack gap-2">
                <span className="field-label">原著防剧透范围</span>
                <div className="segmented">
                  <button
                    type="button"
                    aria-pressed={scopeMode === "through"}
                    onClick={() => setScopeMode("through")}
                  >
                    按故事进度防剧透
                  </button>
                  <button
                    type="button"
                    aria-pressed={scopeMode === "full"}
                    onClick={() => setScopeMode("full")}
                  >
                    读全书
                  </button>
                  <button
                    type="button"
                    aria-pressed={scopeMode === "chapters"}
                    onClick={() => setScopeMode("chapters")}
                  >
                    指定章节
                  </button>
                </div>
                {scopeMode === "chapters" && (
                  <div className="range-grid">
                    <div className="range-field">
                      <label>
                        从第
                        <input
                          inputMode="numeric"
                          value={fromSec}
                          onChange={(e) => setFromSec(e.target.value)}
                        />
                        节
                      </label>
                    </div>
                    <div className="range-field">
                      <label>
                        到第
                        <input
                          inputMode="numeric"
                          value={toSec}
                          onChange={(e) => setToSec(e.target.value)}
                        />
                        节
                      </label>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="settings-list">
              {worlds.map((item) => {
                const selected = item.world.id === selectedWorldId;
                const ceiling = item.source ? (item.source.through ?? item.source.position) + 1 : null;
                return (
                  <button
                    key={item.world.id}
                    type="button"
                    className="settings-entry"
                    aria-pressed={selected}
                    disabled={saving}
                    onClick={() => {
                      setSelectedWorldId(item.world.id);
                      if (!item.source) void saveWorldSelection(item);
                    }}
                  >
                    <span>
                      <b>
                        {item.world.title}
                        {selected ? "（已选）" : ""}
                      </b>
                      <small>
                        {ceiling !== null ? `含参考书 · 当前进度第 ${ceiling} 节` : "原创 / 历史存档"}
                      </small>
                    </span>
                    <span aria-hidden="true">›</span>
                  </button>
                );
              })}
            </div>
            {!worlds.length && <p className="muted">书架上还没有故事。</p>}
            {chosenWorld?.source && (
              <button
                type="button"
                className="primary"
                disabled={saving}
                onClick={() => void saveWorldSelection(chosenWorld)}
              >
                关联《{chosenWorld.world.title}》
              </button>
            )}
          </>
        ) : (
          <>
            <p className="muted m-0">
              不绑定具体存档，只针对书库里的一本原著考据设定、梳理人物或构思同人开局。
            </p>
            <div className="segmented">
              <button
                type="button"
                aria-pressed={scopeMode !== "chapters"}
                onClick={() => setScopeMode("full")}
              >
                读全书
              </button>
              <button
                type="button"
                aria-pressed={scopeMode === "chapters"}
                onClick={() => setScopeMode("chapters")}
              >
                防剧透（指定章节上限）
              </button>
            </div>
            {scopeMode === "chapters" && (
              <div className="range-grid">
                <div className="range-field">
                  <label>
                    从第
                    <input
                      inputMode="numeric"
                      value={fromSec}
                      onChange={(e) => setFromSec(e.target.value)}
                    />
                    节
                  </label>
                </div>
                <div className="range-field">
                  <label>
                    到第
                    <input
                      inputMode="numeric"
                      value={toSec}
                      onChange={(e) => setToSec(e.target.value)}
                    />
                    节
                  </label>
                </div>
              </div>
            )}

            <div className="settings-list">
              {books.map((b) => {
                const selected = b.id === selectedBookId;
                return (
                  <button
                    key={b.id}
                    type="button"
                    className="settings-entry"
                    aria-pressed={selected}
                    disabled={saving}
                    onClick={() => {
                      setSelectedBookId(b.id);
                      void saveBookSelection(b.id);
                    }}
                  >
                    <span>
                      <b>
                        《{b.title}》{selected ? "（已选）" : ""}
                      </b>
                      <small>{b.format.toUpperCase()}</small>
                    </span>
                    <span aria-hidden="true">选用 ›</span>
                  </button>
                );
              })}
            </div>
            {!books.length && <p className="muted">书库还是空的，可以先导入一本书。</p>}
            <button type="button" onClick={onOpenSourceLibrary}>
              <Icon name="book" size={18} />
              导入或管理书库…
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}

export default CompanionScreen;
