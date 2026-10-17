// The play screen (PLAN_V3 §4.3–4.4): story stream, choices, input bar,
// regenerate/variants, long-press menu, stop/interrupt, character panel.
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { eraContext } from "../../engine/era";
import { nowOf, timeRows } from "../../engine/calendar/clock";
import type { ContextPreview, TurnEvent, TurnHandle } from "../../engine/game";
import { explainFailure } from "../../engine/llm/providers";
import type { Chip, TurnRecord } from "../../engine/state/apply";
import * as tree from "../../engine/tree";
import type { ActionMode, Intensity, Pin, StoryNode, World, WorldState } from "../../engine/types";
import { useApp, useBack } from "../app/context";
import { BookmarkSheet, LinesSheet } from "../components/Lines";
import { Panel } from "../components/Panel";
import { RulesSheet } from "../components/RulesSheet";
import { MenuSheet, Sheet } from "../components/Sheet";
import { StoryText } from "../components/StoryText";
import { fromSetup } from "./openingDraft";
import { useLongPress } from "../components/useLongPress";
import { useMouse, useWide } from "../components/useMedia";
import { useShortcuts } from "../components/useShortcuts";
import { ShortcutsSheet } from "../components/ShortcutsSheet";
import { differsFromDefaults, loadPlayDefaults, savePlayDefaults, type PlayDefaults } from "../app/playDefaults";

const PAGE = 30;
const MODES: { mode: ActionMode; label: string; placeholder: string }[] = [
  { mode: "do", label: "做", placeholder: "写下你要做的事…" },
  { mode: "say", label: "说", placeholder: "写下你要说的话…" },
  { mode: "write", label: "写", placeholder: "亲手写一段剧情，AI 会顺着往下写…" },
  { mode: "direct", label: "幕后", placeholder: "给叙事者的要求，如“这段写紧张些”" },
];
/** What each input mode does, shown in the mode picker (AUDIT 4.9). */
const MODE_NOTES: Record<string, string> = {
  do: "写你要做的事，AI 写出结果", say: "写你要说的话，原样说出口", write: "亲手写一段剧情，AI 顺着往下写", direct: "不写行动，只告诉叙事者这段怎么写",
};
const HINTS = ["写短一点", "写长一点", "换个结果", "让对方拒绝", "多些对话", "节奏快一些"];
/** "过些日子" (PLAN §4.6): how long, and how the protagonist spends it. */
const SPANS: [string, string][] = [
  ["到明天", "过一天"], ["几天", "过三五天"], ["一个月", "过一个月"], ["一季", "过一季"], ["一年", "过一年"], ["直到有事发生", "一直过下去，直到有事发生"],
];
const PASTIMES = ["照常过日子", "读书", "经营", "练武"];

interface Gen {
  phase: "starting" | "thinking" | "writing" | "organizing";
  text: string;
  action: { mode: ActionMode; text: string } | null;
  variant: boolean;
}

function ChipRow({ chips }: { chips: Chip[] }) {
  if (!chips?.length) return null;
  return <div className="chips">{chips.map((c, i) => <span key={i} className={`chip ${c.tone}`}>{c.text}</span>)}</div>;
}

/** What the protagonist heard while time passed (R05-T001). */
function ReportCard({ report }: { report?: TurnRecord["report"] }) {
  if (!report) return null;
  const rows = [["天下", report.world], ["市面", report.local], ["人情", report.people]].filter(([, text]) => text);
  if (!rows.length) return null;
  return <div className="report-card"><b>这段日子</b>{rows.map(([label, text]) => <p key={label}><span>{label}</span>{text}</p>)}</div>;
}

function TurnView({ node, onMenu, pressed, children }: { node: StoryNode; onMenu: (n: StoryNode) => void; pressed?: boolean; children?: React.ReactNode }) {
  const press = useLongPress(() => onMenu(node));
  const { devMode } = useApp();
  // Developer mode: era words the local check found (R07-T002).
  const taboos = devMode ? ((node.meta.taboos as { term: string; instead: string | null }[] | undefined) ?? []) : [];
  if (node.kind === "edit") return <div className="edit-line" data-node-id={node.id}>{node.meta.by === "AI" ? node.actionText : `你修改了：${node.actionText}`}</div>;
  return (
    <div className={`turn${pressed ? " pressed" : ""}`} data-node-id={node.id} {...press}>
      {node.kind !== "opening" && node.actionMode === "write" && node.actionText && (
        <div className="turn-written"><StoryText text={node.actionText} /></div>
      )}
      {node.kind !== "opening" && node.actionMode !== "continue" && node.actionMode !== "write" && node.actionText && (
        <div className={`turn-action ${node.actionMode ?? ""}`}>{node.actionText}</div>
      )}
      {node.kind !== "opening" && node.actionMode === "continue" && <div className="turn-action continue">（继续）</div>}
      <StoryText text={node.narrative} />
      {node.rewritten && <span className="rewritten-mark">已改写</span>}
      {node.actionMode === "skip" && <ReportCard report={(node.record as TurnRecord | null)?.report} />}
      <ChipRow chips={[...((node.meta.chips as Chip[]) ?? []), ...taboos.map((t) => ({ text: `用词：${t.term}${t.instead ? ` → ${t.instead}` : ""}`, tone: "warn" as const }))]} />
      {children}
    </div>
  );
}

export default function Play({ worldId }: { worldId: string }) {
  const { game, push, replace, toast, devMode, pop } = useApp();
  const [world, setWorld] = useState<World | null>(null);
  const [cursor, setCursor] = useState<tree.Cursor | null>(null);
  const [nodes, setNodes] = useState<StoryNode[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [state, setState] = useState<WorldState | null>(null);
  const [variants, setVariants] = useState<tree.Variants | null>(null);
  const [gen, setGen] = useState<Gen | null>(null);
  /** One message under the story at a time (AUDIT 5.1): what happened, and what to do now. */
  const [notice, setNotice] = useState<{ text: string; actions: { label: string; run: () => void }[] } | null>(null);
  const failures = useRef(0);
  /** Does the last request again, for “再试一次”. */
  const retry = useRef<(() => void) | null>(null);
  /** No new words for a while: say it is still being written (AUDIT 5.5). */
  const [slow, setSlow] = useState(false);
  const lastWords = useRef(0);
  const [modeIndex, setModeIndex] = useState(0);
  const [input, setInput] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [menuNode, setMenuNode] = useState<StoryNode | null>(null);
  const [editing, setEditing] = useState<{ node: StoryNode; field: "narrative" | "action"; text: string } | null>(null);
  const [rawNode, setRawNode] = useState<StoryNode | null>(null);
  const [context, setContext] = useState<ContextPreview | null>(null);
  const [remember, setRemember] = useState<{ node: StoryNode; text: string } | null>(null);
  const [bookmark, setBookmark] = useState<{ node: StoryNode; name: string } | null>(null);
  const [sheet, setSheet] = useState<"more" | "hints" | "settings" | "story" | "lines" | "time" | "rules" | "skip" | "ask" | "keys" | null>(null);
  const [panel, setPanel] = useState(false);
  const wide = useWide();
  const mouse = useMouse();
  const inputBox = useRef<HTMLTextAreaElement>(null);
  // The box grows with what is typed; shrink it back once the action is sent.
  useEffect(() => { if (!input && inputBox.current) inputBox.current.style.height = ""; }, [input]);
  const [following, setFollowing] = useState(true);
  const [typing, setTyping] = useState(false);
  const [notificationStart, setNotificationStart] = useState<(() => void) | null>(null);
  const handle = useRef<TurnHandle | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const readingLoaded = useRef(false);
  const restoreReading = useRef<string | null>(null);
  const readingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const era = eraContext(world?.eraId ?? null, state);
  const turn = [...nodes].reverse().find((n) => n.kind !== "edit");

  const refresh = useCallback(async (keepLimit = limit) => {
    const w = await game.repo.getWorld(worldId);
    if (!w) return pop();
    const c = await tree.cursor(game.repo, worldId);
    const path = await game.repo.path(c.head.id, keepLimit + 1);
    const currentState = await game.repo.getState(c.head.id);
    let latest = c.head;
    while (latest.kind === "edit") latest = (await game.repo.getNode(latest.parentId!))!;
    const currentVariants = await tree.variants(game.repo, latest);
    const loaded = path.slice(-keepLimit);
    if (!readingLoaded.current) {
      const saved = await game.repo.getSetting<string | null>("reading:" + worldId, null);
      readingLoaded.current = true;
      if (loaded.some((n) => n.id === saved) && saved !== loaded.filter((n) => n.kind !== "edit").at(-1)?.id) {
        restoreReading.current = saved;
        follow.current = false;
        setFollowing(false);
      }
    }
    setHasMore(path.length > keepLimit);
    setNodes(loaded);
    setWorld(w);
    setCursor(c);
    setState(currentState);
    setVariants(currentVariants);
  }, [game, worldId, limit, pop]);

  useEffect(() => { void refresh(); }, []);
  // No new words for 8 seconds while writing: say so, rather than a silent cursor (AUDIT 5.5).
  useEffect(() => {
    if (!gen) { setSlow(false); return; }
    const id = setInterval(() => setSlow(Date.now() - lastWords.current > 8000), 1000);
    return () => clearInterval(id);
  }, [!!gen]);
  // After the third turn, once ever: everything a passage can do is behind a long press (AUDIT 4.2).
  const [pressTip, setPressTip] = useState(false);
  const countTurn = async () => {
    if (await game.repo.getSetting("tip:longPress", false)) return;
    const n = (await game.repo.getSetting<number>("tip:turns", 0)) + 1;
    await game.repo.setSetting("tip:turns", n);
    if (n >= 3) { setPressTip(true); await game.repo.setSetting("tip:longPress", true); }
  };
  const [modePicker, setModePicker] = useState(false);
  // The AI filed new cards in the background: show its line and the new 设定集.
  useEffect(() => game.subscribe((id) => { if (id === worldId) void refresh(); }), [game, worldId, refresh]);
  useEffect(() => () => { if (readingTimer.current) clearTimeout(readingTimer.current); }, []);

  // Follow the bottom while the player is there; stop when they scroll up.
  const onScroll = () => {
    const el = scroller.current!;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    follow.current = atBottom;
    setFollowing(atBottom);
    if (readingTimer.current) clearTimeout(readingTimer.current);
    readingTimer.current = setTimeout(() => {
      const top = el.getBoundingClientRect().top;
      const turns = [...el.querySelectorAll<HTMLElement>(".turn[data-node-id]")];
      const nearby = turns.find((n) => n.getBoundingClientRect().bottom > top);
      if (nearby) void game.repo.setSetting("reading:" + worldId, nearby.dataset.nodeId);
    }, 400);
  };
  const toBottom = (smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };
  useLayoutEffect(() => {
    if (restoreReading.current) {
      const el = scroller.current;
      const target = el?.querySelector<HTMLElement>(`[data-node-id="${restoreReading.current}"]`);
      if (target && el) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top;
      restoreReading.current = null;
    } else if (follow.current) toBottom();
  }, [nodes, gen?.text, gen?.phase, notice]);

  // Page came back from the background: replay what the stream cached meanwhile.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void handle.current?.catchUp();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useBack(() => {
    if (gen) {
      toast("正在写，先停止或等写完");
      return true;
    }
    return false;
  }, !!gen);

  const onEvent = (restore: { mode: ActionMode; text: string; note: string } | null) => (e: TurnEvent) => {
    if (e.type === "thinking") setGen((g) => g && { ...g, phase: "thinking" });
    else if (e.type === "text") { lastWords.current = Date.now(); setSlow(false); setGen((g) => g && { ...g, phase: "writing", text: e.full }); }
    else if (e.type === "organizing") setGen((g) => g && { ...g, phase: "organizing" });
    else if (e.type === "done") {
      setGen(null);
      handle.current = null;
      failures.current = 0;
      void refresh();
      void countTurn();
    } else if (e.type === "failed") {
      setGen(null);
      handle.current = null;
      if (e.partialSaved) {
        // The interrupted passage shows its own 续写 / 重说; here only why it stopped.
        void refresh();
        if (e.reason !== "cancelled") setNotice({ text: `${explainFailure(e.reason, e.status)} 已写出的部分保留了。`, actions: [] });
      } else {
        if (restore) {
          setInput(restore.text);
          setModeIndex(Math.max(0, MODES.findIndex((m) => m.mode === restore.mode)));
          if (restore.note) { setNote(restore.note); setNoteOpen(true); }
        }
        if (e.reason === "cancelled") return;
        failures.current++;
        const actions: { label: string; run: () => void }[] = [];
        if (e.reason === "config" || e.reason === "auth") actions.push({ label: "去设置", run: () => push({ name: "setup" }) });
        else {
          if (retry.current) { const again = retry.current; actions.push({ label: e.reason === "refused" ? "原样再试" : "再试一次", run: again }); }
          if (failures.current >= 2 || e.reason === "quota" || e.reason === "refused") actions.push({ label: "换个服务", run: () => push({ name: "settings" }) });
        }
        setNotice({ text: explainFailure(e.reason, e.status), actions });
      }
    }
  };

  // Asked once before the first passage on Android. Closing the sheet is not a no (it asks again next time);
  // a no is remembered, and Settings shows the state with a way to the system switch (ANDROID_COMPAT F1).
  const beforeGenerating = async (start: () => void) => {
    if (game.platform.name !== "android" || await game.repo.getSetting("notifAsked", false)) { start(); return; }
    const status = await game.platform.system.notificationStatus().catch(() => ({ granted: false, enabled: false }));
    if (status.enabled) { await game.repo.setSetting("notifAsked", true); start(); return; }
    setNotificationStart(() => start);
  };
  const answerNotifications = async (answer: "allow" | "no" | "later") => {
    const start = notificationStart;
    setNotificationStart(null);
    if (answer !== "later") await game.repo.setSetting("notifAsked", true);
    if (answer === "allow") {
      const granted = await game.platform.system.requestNotifications().catch(() => false);
      if (!granted) toast("没有打开通知。以后可以在 设置 → 通知 里打开", { label: "去打开", run: () => void game.platform.system.openSystemSettings("notifications") });
    }
    start?.();
  };

  const send = (override?: { mode: ActionMode; text: string }, overrideNote?: string | null) => {
    if (gen || !cursor) return;
    if (!game.llm) { push({ name: "setup" }); return; }
    void beforeGenerating(() => {
      const mode = override?.mode ?? (input.trim() ? MODES[modeIndex].mode : "continue");
      const text = override?.text ?? (mode === "continue" ? "" : input.trim());
      const directorNote = overrideNote !== undefined ? overrideNote : !override && noteOpen && note.trim() ? note.trim() : null;
      lastWords.current = Date.now();
      setSlow(false);
      retry.current = () => { setInput(""); setNote(""); setNoteOpen(false); send({ mode, text }, directorNote); };
      setNotice(null);
      follow.current = true;
      setFollowing(true);
      setGen({ phase: "starting", text: "", action: { mode, text }, variant: false });
      setInput("");
      setNote("");
      setNoteOpen(false);
      setModeIndex(0);
      // A failure gives the words back to the box (and 再试一次 sends them again), choices included.
      handle.current = game.play(worldId, { mode, text, directorNote }, onEvent(mode === "continue" || mode === "skip" ? null : { mode, text, note: directorNote ?? "" }));
    });
  };

  const regenerate = (hint: string | null) => {
    if (gen || !turn?.parentId) return;
    void beforeGenerating(() => {
      setNotice(null);
      follow.current = true;
      setFollowing(true);
      lastWords.current = Date.now();
      setSlow(false);
      retry.current = () => regenerate(hint);
      setGen({ phase: "starting", text: "", action: turn.actionMode && turn.actionMode !== "continue" ? { mode: turn.actionMode, text: turn.actionText ?? "" } : null, variant: true });
      handle.current = game.regenerate(worldId, hint, onEvent(null));
    });
  };

  const resume = () => {
    if (gen || !cursor) return;
    void beforeGenerating(() => {
      setNotice(null);
      follow.current = true;
      setFollowing(true);
      setGen({ phase: "starting", text: cursor.head.narrative, action: null, variant: true });
      handle.current = game.resumeInterrupted(worldId, onEvent(null));
    });
  };

  const switchVariant = async (delta: number) => {
    if (!cursor || !variants) return;
    const next = variants.index + delta;
    if (next < 0 || next >= variants.count) return;
    await tree.switchVariant(game.repo, { ...cursor, head: turn! }, next);
    setNotice(null);
    await refresh();
  };

  const goBack = async (node: StoryNode) => {
    if (!cursor) return;
    const before = cursor.line.id;
    const c = await tree.goBackTo(game.repo, cursor, node.id);
    setNotice(null);
    await refresh();
    // Going back never deletes anything (it is a new route, or redo returns); say so, and offer the way back.
    if (c.line.id !== before) toast("已回到这里，原来的路线保留在“世界线”里", { label: "回原路线", run: () => void tree.switchLine(game.repo, worldId, before).then(() => refresh()) });
    else toast("已回到这里", { label: "撤回", run: () => void redoAll(c, cursor.head.id) });
  };
  /** Steps forward again to `target` after going back on the same line. */
  const redoAll = async (from: tree.Cursor, target: string) => {
    let c = from;
    for (let i = 0; i < 50 && c.head.id !== target && tree.canRedo(c); i++) c = await tree.redo(game.repo, c);
    await refresh();
  };
  const undo = async () => {
    if (!cursor) return;
    const undone = cursor.head;
    const c = await tree.undo(game.repo, cursor);
    setNotice(null);
    await refresh();
    const what = undone.kind === "edit" ? "这次修改" : undone.actionText ? `“${undone.actionText.slice(0, 12)}${undone.actionText.length > 12 ? "…" : ""}”` : "上一段";
    toast(`已撤销${what}`, { label: "重做", run: () => void tree.redo(game.repo, c).then(() => refresh()) });
  };
  const redo = async () => {
    if (!cursor) return;
    await tree.redo(game.repo, cursor);
    setNotice(null);
    await refresh();
    toast("已重做");
  };

  const editAction = async (node: StoryNode, text: string) => {
    if (!cursor || !node.parentId) return;
    await tree.goBackTo(game.repo, cursor, node.parentId);
    await refresh();
    const mode = node.actionMode === "say" || node.actionMode === "write" || node.actionMode === "direct" ? node.actionMode : "do";
    send({ mode, text }, node.directorNote ?? null);
  };

  const saveRewrite = async (node: StoryNode, text: string) => {
    await game.repo.updateNarrative(node.id, text);
    await refresh();
    toast("已改写，后面的剧情会按改过的文字继续", { label: "撤回", run: () => void game.repo.restoreNarrative(node.id).then(() => refresh()) });
  };

  const loadMore = async () => {
    const el = scroller.current!;
    const before = el.scrollHeight;
    const next = limit + PAGE;
    setLimit(next);
    await refresh(next);
    requestAnimationFrame(() => { el.scrollTop += el.scrollHeight - before; });
  };

  const updateSettings = async (patch: Partial<World["settings"]>) => {
    if (!world) return;
    const settings = { ...world.settings, ...patch };
    await game.repo.updateSettings(worldId, settings);
    setWorld({ ...world, settings });
  };

  // Desktop shortcuts (PLAN_V4 E): the same actions as the buttons, with the same conditions.
  const ready = !!world && !!cursor && !!state;
  const isDead = !!state && !!world && state.protagonist.stats.health <= 0 && world.settings.difficulty !== "宽松";
  const pick = (i: number) => ({ inInputs: true, run: () => {
    const choice = turn?.choices[i];
    if (!ready || gen || isDead || !choice || turn?.status === "interrupted") return false;
    send({ mode: "do", text: choice });
  } });
  const focusInput = { inInputs: true, run: () => { if (!inputBox.current || isDead) return false; inputBox.current.focus(); } };
  const keys = () => setSheet("keys");
  useShortcuts({
    "Ctrl+Z": { run: () => { if (!ready || gen || !cursor!.head.parentId) return false; void undo(); } },
    "Ctrl+Y": { run: () => { if (!ready || gen || !tree.canRedo(cursor!)) return false; void redo(); } },
    "Ctrl+Shift+Z": { run: () => { if (!ready || gen || !tree.canRedo(cursor!)) return false; void redo(); } },
    "Ctrl+R": { inInputs: true, run: () => { if (!ready || gen || !turn?.parentId || turn.kind === "opening") return false; regenerate(null); } },
    "Ctrl+K": focusInput,
    "/": focusInput,
    "Ctrl+F": { inInputs: true, run: () => { if (!ready || gen) return false; setSheet("ask"); } },
    "Ctrl+,": { inInputs: true, run: () => (gen ? (toast("正在写，先停止或等写完"), undefined) : push({ name: "settings" })) },
    "F1": { inInputs: true, run: () => (gen ? (toast("正在写，先停止或等写完"), undefined) : push({ name: "guide" })) },
    "Ctrl+Enter": { inInputs: true, run: () => { if (!ready || gen || isDead) return false; send(); } },
    "Alt+1": pick(0), "Alt+2": pick(1), "Alt+3": pick(2), "Alt+4": pick(3),
    "?": { run: keys },
    "Ctrl+/": { inInputs: true, run: keys },
  }, mouse);

  if (!world || !cursor || !state) return <div className="screen-body"><p className="muted">正在读取…</p></div>;

  const head = cursor.head;
  const placeName = state.places.find((p) => p.id === state.placeId)?.name;
  const place = placeName ?? world.title;
  const now = nowOf(era.clock, state.time.elapsedMinutes);
  const shown = gen?.variant ? nodes.slice(0, nodes.findIndex((n) => n.id === turn?.id)) : nodes;
  const mode = MODES[modeIndex];
  const dead = state.protagonist.stats.health <= 0 && world.settings.difficulty !== "宽松";
  const sendLabel = gen ? "停止" : input.trim() ? "发送" : "继续";
  const statusText = gen && { starting: "", thinking: "构思中…", writing: "", organizing: "整理中…" }[gen.phase];

  const panelProps = {
    worldId, headId: head.id, chapterEvery: world.settings.chapterEvery, state, era, busy: !!gen,
    onClose: () => setPanel(false), onOpenStory: () => { setPanel(false); setSheet("story"); },
    onOrganize: async (replaceOwnEra: boolean) => {
      const c = await game.organize(worldId, { replaceOwnEra });
      if (!c) { toast("这次没整理出来，稍后再试"); return false; }
      await refresh();
      toast("已整理设定集，可以接着修改");
      return true;
    },
    onSave: async (patch: TurnRecord, summary: string) => { await game.editState(worldId, patch, summary); await refresh(); },
  };

  return (
    <div className={`play-layout${wide ? " wide" : ""}`}>
    <div className="play">
      <div className="topbar">
        <button className="icon-btn" aria-label="返回" title="返回（Esc）" onClick={() => (gen ? toast("正在写，先停止或等写完") : pop())}>‹</button>
        <button className="title" aria-label="此时此地" title="此时此地" onClick={() => setSheet("time")}>
          <h1>{place}</h1>
          <div className="subtitle">{now.text}</div>
        </button>
        {!wide && <button className="icon-btn" aria-label="角色" title="角色" onClick={() => setPanel(true)} style={{ fontSize: 15 }}>我</button>}
        <button className="icon-btn" aria-label="更多" title="更多" onClick={() => setSheet("more")}>⋯</button>
      </div>

      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex" }}>
        <div className="story" ref={scroller} onScroll={onScroll}>
          <div className="story-inner">
            {hasMore && <button className="load-more ghost" onClick={loadMore}>加载更早的剧情</button>}
            {shown.map((node) => {
              const isHead = node.id === turn?.id && !gen;
              return (
                <TurnView key={node.id} node={node} onMenu={setMenuNode} pressed={menuNode?.id === node.id}>
                  {isHead && node.status === "interrupted" && (
                    <div className="notice">这段没有写完。{notice?.text && !notice.actions.length ? ` ${notice.text}` : ""}<div className="row"><button onClick={resume}>续写</button><button onClick={() => regenerate(null)}>重说</button></div></div>
                  )}
                  {isHead && node.status === "no_record" && <p className="muted">这段没能整理出记录，状态可能没有更新。</p>}
                  {isHead && node.kind !== "opening" && node.status !== "interrupted" && (
                    <div className="turn-tools">
                      {variants && variants.count > 1 && (
                        <>
                          <button className="ghost" aria-label="上一版" title="上一版" disabled={variants.index === 0} onClick={() => switchVariant(-1)}>‹</button>
                          <span>{variants.index + 1}/{variants.count}</span>
                          <button className="ghost" aria-label="下一版" title="下一版" disabled={variants.index === variants.count - 1} onClick={() => switchVariant(1)}>›</button>
                        </>
                      )}
                      <RegenButton title={mouse ? "重说（Ctrl+R），右键选重说的要求" : undefined} onTap={() => regenerate(null)} onLong={() => setSheet("hints")} />
                      <button className="ghost" title="重说时提个要求" onClick={() => setSheet("hints")}>换个写法</button>
                      <button className="ghost" aria-label="这一段还能做什么" title={mouse ? "这一段还能做什么（也可以右键点这一段）" : undefined} onClick={() => setMenuNode(node)}>⋯</button>
                    </div>
                  )}
                  {isHead && pressTip && (
                    <div className="tip">{mouse ? "右键或长按" : "长按"}任意一段，可以改写、回到那里重来、记住这件事或加书签。<button className="ghost" onClick={() => setPressTip(false)}>知道了</button></div>
                  )}
                </TurnView>
              );
            })}
            {gen && (
              <div className="turn">
                {gen.action?.mode === "write" && gen.action.text && <div className="turn-written"><StoryText text={gen.action.text} /></div>}
                {gen.action && gen.action.mode !== "continue" && gen.action.mode !== "write" && gen.action.text && <div className={`turn-action ${gen.action.mode}`}>{gen.action.text}</div>}
                {gen.text ? <StoryText text={gen.text} streaming={gen.phase === "writing"} /> : <p className="status-line"><span className="cursor-blink">{statusText || "落笔"}</span></p>}
                {gen.text && statusText && <p className="status-line">{statusText}</p>}
                {slow && <p className="status-line">还在写，稍等…（不想等可以点“停止”）</p>}
              </div>
            )}
            {notice && !(turn?.status === "interrupted" && !notice.actions.length) && (
              <div className="notice">
                {notice.text}
                {notice.actions.length > 0 && <div className="row">{notice.actions.map((a) => <button key={a.label} onClick={() => { setNotice(null); a.run(); }}>{a.label}</button>)}</div>}
              </div>
            )}
            {dead && <EndingCard state={state} world={world} now={now.text} turns={nodes.filter((n) => n.kind === "turn").length}
              onBack={(steps) => { const target = [...nodes].filter((n) => n.kind !== "edit").reverse()[steps]; if (target) void goBack(target); }}
              onLines={() => setSheet("lines")}
              onAgain={async () => { const setup = await game.setupOf(worldId); if (!setup) return; await game.repo.setSetting("newgameDraft", fromSetup(setup)); replace({ name: "newgame" }); }} />}
          </div>
        </div>
        {!following && <button className="to-bottom" onClick={() => { follow.current = true; setFollowing(true); toBottom(true); }}>回到底部 ↓</button>}
      </div>

      <div className="dock">
        {!dead && state.protagonist.statuses.some((x) => x.name === "垂危") && <p className="dying-note">你伤重垂危：再受重伤就会死去，先设法疗伤。</p>}
        {!gen && !dead && !(typing && (!mouse || input.trim())) && !!turn?.choices.length && turn.status !== "interrupted" && (
          <div className="choices">
            {turn.choices.map((choice, i) => <ChoiceButton key={choice} text={choice} title={mouse ? `${i < 4 ? `Alt+${i + 1} 选这个，` : ""}右键放进输入框改一改` : undefined} onTap={() => send({ mode: "do", text: choice })} onLong={() => { setInput(choice); setModeIndex(0); }} />)}
          </div>
        )}
        {noteOpen && mode.mode !== "direct" && (
          <div className="row director-row">
            <input className="director-note grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="幕后要求（只影响这一段）" aria-label="幕后要求" />
            <button className="icon-btn" aria-label="去掉幕后要求" onClick={() => { setNote(""); setNoteOpen(false); }}>×</button>
          </div>
        )}
        <div className="inputbar">
          <button className="mode-btn" aria-label={`输入方式：${mode.label}`} onClick={() => setModePicker(true)} disabled={!!gen}>{mode.label}</button>
          <textarea
            ref={inputBox}
            rows={1}
            value={input}
            disabled={dead}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            placeholder={dead ? "" : mode.placeholder}
            onKeyDown={(e) => {
              // On a desktop keyboard Enter sends and Shift+Enter starts a new line.
              if (mouse && e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!gen) send(); }
            }}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              if (modeIndex === 0 && /^[“"「]/.test(v)) setModeIndex(1);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
          />
          <button className={`send-btn ${gen ? "" : "primary"}`} title={mouse ? (gen ? "停止" : "Enter 发送，Shift+Enter 换行") : undefined} disabled={dead && !gen} onClick={() => (gen ? handle.current?.stop() : send())}>{sendLabel}</button>
        </div>
      </div>

      {menuNode && (
        <MenuSheet
          title={`“${menuNode.narrative.replace(/\s+/g, "").slice(0, 16)}…”`}
          onClose={() => setMenuNode(null)}
          items={[
            { label: "改写这段文字", hidden: menuNode.kind === "edit" || !!gen, onSelect: () => setEditing({ node: menuNode, field: "narrative", text: menuNode.narrative }) },
            { label: "恢复 AI 写的原文", hidden: !menuNode.rewritten || typeof menuNode.meta.original !== "string" || !!gen, onSelect: () => void game.repo.restoreNarrative(menuNode.id).then(() => { void refresh(); toast("已恢复原文"); }) },
            { label: "改我的行动", hidden: !menuNode.actionText || menuNode.actionMode === "continue" || menuNode.actionMode === "skip" || !!gen, onSelect: () => setEditing({ node: menuNode, field: "action", text: menuNode.actionText ?? "" }) },
            { label: "记住这件事", hidden: menuNode.kind === "edit" || !menuNode.narrative.trim() || !!gen, onSelect: () => setRemember({ node: menuNode, text: menuNode.narrative.trim() }) },
            { label: "回到这里", hidden: menuNode.id === head.id || !!gen, onSelect: () => void goBack(menuNode) },
            { label: "加书签", hidden: menuNode.kind === "edit", onSelect: () => setBookmark({ node: menuNode, name: menuNode.narrative.replace(/\s+/g, "").slice(0, 12) || "书签" }) },
            { label: "复制", onSelect: () => { void navigator.clipboard?.writeText(menuNode.narrative); toast("已复制"); } },
            { label: "查看原始输出（开发者）", hidden: !devMode, onSelect: () => setRawNode(menuNode) },
          ]}
        />
      )}
      {remember && (
        <Sheet title="记住这件事" onClose={() => setRemember(null)}>
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>把这段删改成一句要点。AI 之后每一段都会记着它；只在这条路线有效，回到这段之前就不算数。</p>
            <textarea rows={6} aria-label="要点" value={remember.text} onChange={(e) => setRemember({ ...remember, text: e.target.value })} />
            {remember.text.length > 120 && <p className="muted" style={{ margin: 0 }}>{remember.text.length} 字，越短越好。</p>}
            <button className="primary" disabled={!remember.text.trim()} onClick={() => {
              const { node, text } = remember;
              setRemember(null);
              void game.repo.addPin(worldId, node.id, text).then(() => toast("记下了"));
            }}>记下</button>
          </div>
        </Sheet>
      )}
      {editing && (
        <Sheet title={editing.field === "action" ? "改我的行动" : "改写这段文字"} onClose={() => setEditing(null)}>
          <div className="stack">
            {editing.field === "action" && <p className="muted" style={{ margin: 0 }}>会从这一回合之前重新写，原来的内容保留在另一条路线里。</p>}
            <textarea rows={editing.field === "action" ? 3 : 12} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
            <button className="primary" disabled={!editing.text.trim()} onClick={() => {
              const { node, field, text } = editing;
              setEditing(null);
              void (field === "action" ? editAction(node, text.trim()) : saveRewrite(node, text));
            }}>{editing.field === "action" ? "重新开始这一回合" : "保存"}</button>
          </div>
        </Sheet>
      )}
      {rawNode && (
        <Sheet title="原始输出" onClose={() => setRawNode(null)}>
          <p className="muted">模型 {String(rawNode.meta.model ?? "")} · 提示词 {String(rawNode.meta.promptVersion ?? "")} · 首字 {Math.round(Number(rawNode.meta.firstTokenMs ?? 0))}ms · 总计 {Math.round(Number(rawNode.meta.totalMs ?? 0))}ms{rawNode.meta.extracted ? " · 补记" : ""}</p>
          {(rawNode.meta.log as string[])?.length > 0 && <pre className="raw">{(rawNode.meta.log as string[]).join("\n")}</pre>}
          <pre className="raw">{String(rawNode.meta.raw ?? "（无）")}</pre>
        </Sheet>
      )}
      {context && (
        <Sheet title="下一回合的上下文" onClose={() => setContext(null)}>
          <p className="muted" style={{ marginTop: 0 }}>
            共 {context.chars} 字，约 {Math.round(context.chars * context.ratio).toLocaleString()} token
            （{context.calibrated ? `按实际用量校准，每字约 ${context.ratio} token` : "还没有实际用量，按每字 1 token 估算"}）；预算 {context.budgetChars} 字。
          </p>
          {context.layers.map((l) => (
            <details key={l.key} className="context-layer">
              <summary><b>{l.label}</b> <span className="muted">{l.chars} 字 · {l.note}</span></summary>
              <pre className="raw">{l.content.trim() || "（空）"}</pre>
            </details>
          ))}
        </Sheet>
      )}
      {modePicker && (
        <Sheet title="怎么写这一回合" onClose={() => setModePicker(false)}>
          <div className="sheet-menu">
            {MODES.map((m, i) => (
              <button key={m.mode} aria-pressed={i === modeIndex} className="mode-option" onClick={() => { setModeIndex(i); setModePicker(false); inputBox.current?.focus(); }}>
                <b>{m.label}</b><small>{MODE_NOTES[m.mode]}</small>
              </button>
            ))}
            {!noteOpen && mode.mode !== "direct" && <button className="mode-option" onClick={() => { setNoteOpen(true); setModePicker(false); }}><b>＋ 幕后要求</b><small>行动照写，另外告诉叙事者这一段怎么写</small></button>}
          </div>
        </Sheet>
      )}
      {sheet === "keys" && <ShortcutsSheet onClose={() => setSheet(null)} />}
      {sheet === "ask" && <AskSheet worldId={worldId} onClose={() => setSheet(null)} />}
      {sheet === "skip" && <SkipSheet onClose={() => setSheet(null)} onStart={(text) => { setSheet(null); send({ mode: "skip", text }); }} />}
      {sheet === "hints" && (
        <Sheet title="重说时希望…" onClose={() => setSheet(null)}>
          <div className="segmented">
            {HINTS.map((h) => <button key={h} onClick={() => { setSheet(null); regenerate(h); }}>{h}</button>)}
          </div>
          <HintInput onSubmit={(h) => { setSheet(null); regenerate(h); }} />
        </Sheet>
      )}
      {sheet === "more" && (
        <MenuSheet
          onClose={() => setSheet(null)}
          items={[
            { label: mouse ? "撤销（Ctrl+Z）" : "撤销", hidden: !head.parentId || !!gen, onSelect: () => void undo() },
            { label: mouse ? "重做（Ctrl+Y）" : "重做", hidden: !tree.canRedo(cursor) || !!gen, onSelect: () => void redo() },
            { label: "过些日子", hidden: !!gen, onSelect: () => setSheet("skip") },
            { label: mouse ? "查一查（Ctrl+F）" : "查一查", hidden: !!gen, onSelect: () => setSheet("ask") },
            { label: "幕后要求", hidden: noteOpen, onSelect: () => setNoteOpen(true) },
            { label: "世界线", onSelect: () => setSheet("lines") },
            { label: "故事设定与要点", onSelect: () => setSheet("story") },
            { label: "本局设置", onSelect: () => setSheet("settings") },
            { label: mouse ? "游玩指南（F1）" : "游玩指南", onSelect: () => push({ name: "guide" }) },
            { label: "快捷键", hidden: !mouse, onSelect: () => setSheet("keys") },
            { label: "查看上下文（开发者）", hidden: !devMode || !!gen, onSelect: async () => setContext(await game.previewContext(worldId)) },
            { label: "用同样设定再开一局", hidden: !!gen, onSelect: async () => {
              const setup = await game.setupOf(worldId);
              if (!setup) return;
              await game.repo.setSetting("newgameDraft", fromSetup(setup));
              replace({ name: "newgame" });
            } },
            { label: "回到首页", onSelect: () => pop() },
          ]}
        />
      )}
      {sheet === "time" && (
        <Sheet title="此时此地" onClose={() => setSheet(null)}>
          <dl className="facts">
            {placeName && <><dt>地点</dt><dd>{placeName}</dd></>}
            {timeRows(era.clock, state.time.elapsedMinutes).map((r) => <Fragment key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></Fragment>)}
            {state.protagonist.age != null && <><dt>年龄</dt><dd>{state.protagonist.age} 岁{now.date?.lunar ? "（虚岁，过年长一岁）" : ""}</dd></>}
          </dl>
          <button disabled={!!gen} onClick={() => setSheet("rules")}>修改纪年与货币</button>
        </Sheet>
      )}
      {sheet === "rules" && <RulesSheet state={state} era={era} busy={!!gen} onClose={() => setSheet(null)} onSave={async (patch, summary) => { await game.editState(worldId, patch, summary); await refresh(); }} />}
      {sheet === "lines" && <LinesSheet worldId={worldId} current={cursor.line.id} onClose={() => setSheet(null)} onChanged={(message) => { void refresh(); toast(message); }} />}
      {bookmark && <BookmarkSheet initial={bookmark.name} onClose={() => setBookmark(null)} onSave={(name) => {
        const node = bookmark.node;
        setBookmark(null);
        void tree.addBookmark(game.repo, worldId, node.id, name).then(() => toast("已加书签，在“世界线”里能找到"));
      }} />}
      {sheet === "story" && <StorySheet world={world} headId={head.id} onSave={(p) => { void updateSettings(p); setSheet(null); toast("已保存，从下一段开始生效"); }} onClose={() => setSheet(null)} />}
      {sheet === "settings" && <WorldSettingsSheet world={world} onChange={updateSettings} onRules={() => setSheet("rules")} onClose={() => setSheet(null)} />}
      {panel && !wide && <Panel {...panelProps} />}
      {notificationStart && <Sheet title="写好了提醒你？" onClose={() => void answerNotifications("later")}>
        <p>切到别的应用时，故事会在后台接着写。打开通知后，写的时候通知栏会显示进度，写好了会提醒你回来看。</p>
        <div className="row"><button className="primary" onClick={() => void answerNotifications("allow")}>打开通知</button><button onClick={() => void answerNotifications("no")}>不用了</button></div>
      </Sheet>}
    </div>
    {wide && <div className="play-side"><Panel {...panelProps} docked /></div>}
    </div>
  );
}

/**
 * The end of a life (AUDIT_V4 5.6): a card in the book's style, with where
 * and when it ended, what the protagonist had, and the ways on — back a few
 * turns, another route, or the same setup again. Nothing is lost.
 */
function EndingCard({ state, world, now, turns, onBack, onLines, onAgain }: {
  state: WorldState; world: World; now: string; turns: number; onBack: (steps: number) => void; onLines: () => void; onAgain: () => void;
}) {
  const me = state.protagonist;
  const known = state.people.filter((p) => p.alive !== false).length;
  const done = state.goals.filter((g) => g.status === "完成").length;
  return (
    <div className="ending-card" role="status">
      <div className="ending-seal" aria-hidden="true"><span>终</span></div>
      <h2>{me.name}{me.age ? `，年${me.age}` : ""}</h2>
      <p className="ending-line">卒于{now}。{turns ? `历 ${turns} 回合，` : ""}结识 {known} 人{done ? `，了却 ${done} 桩心愿` : ""}。</p>
      <p className="muted">这一世到此为止。走过的路都还在，可以回到之前的某一刻重来。</p>
      <div className="ending-actions">
        <button className="primary" onClick={() => onBack(1)}>回到上一回合</button>
        <button onClick={() => onBack(3)}>回到三回合前</button>
        <button onClick={onLines}>看看别的路线</button>
        <button className="ghost" onClick={onAgain}>同样设定再开一局</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{world.settings.difficulty === "残酷" ? "残酷难度下，重伤可能直接丧命。" : "长按任意一段，也可以回到那时。"}</p>
    </div>
  );
}

/** 查一查 (R07-T001): questions about this world or the era; the story does not move. */
function AskSheet({ worldId, onClose }: { worldId: string; onClose: () => void }) {
  const { game } = useApp();
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<{ q: string; a: string; pending: boolean }[]>([]);
  const pending = asked.some((x) => x.pending);
  const update = (patch: { a: string; pending: boolean }) => setAsked((list) => list.map((x, i) => (i === list.length - 1 ? { ...x, ...patch } : x)));
  const ask = async () => {
    const q = question.trim();
    if (!q || pending) return;
    setQuestion("");
    setAsked((list) => [...list, { q, a: "", pending: true }]);
    try {
      const answer = await game.ask(worldId, q, (full) => update({ a: full, pending: true }));
      update({ a: answer || "没有查到。", pending: false });
    } catch {
      update({ a: "这次没查到，稍后再试。", pending: false });
    }
  };
  return (
    <Sheet title="查一查" onClose={onClose}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>问这个世界里的人和事，或者这个时代的常识。只是查资料，故事不会往下走。</p>
        {asked.map((x, i) => (
          <div key={i} className="ask-item">
            <b>{x.q}</b>
            {x.a ? <StoryText text={x.a} /> : <p className="muted">查找中…</p>}
          </div>
        ))}
        <div className="row">
          <input className="grow" aria-label="想问什么" value={question} onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void ask(); }} placeholder="如：王掌柜是什么来头？一斗米多少钱？" />
          <button className="primary" disabled={!question.trim() || pending} onClick={() => void ask()}>问</button>
        </div>
      </div>
    </Sheet>
  );
}

function SkipSheet({ onStart, onClose }: { onStart: (text: string) => void; onClose: () => void }) {
  const [span, setSpan] = useState("一个月");
  const [pastime, setPastime] = useState("照常过日子");
  const [own, setOwn] = useState("");
  const how = pastime === "自己写" ? own.trim() : pastime;
  return (
    <Sheet title="过些日子" onClose={onClose}>
      <div className="stack">
        <span className="muted">过多久</span>
        <div className="segmented">
          {SPANS.map(([label]) => <button key={label} aria-pressed={span === label} onClick={() => setSpan(label)}>{label}</button>)}
        </div>
        <span className="muted">这段时间做什么</span>
        <div className="segmented">
          {[...PASTIMES, "自己写"].map((p) => <button key={p} aria-pressed={pastime === p} onClick={() => setPastime(p)}>{p}</button>)}
        </div>
        {pastime === "自己写" && <input aria-label="这段时间做什么" value={own} onChange={(e) => setOwn(e.target.value)} placeholder="如：在西市摆摊替人写信" />}
        <p className="muted" style={{ margin: 0 }}>遇到要你拿主意的事，会提前停下来。</p>
        <button className="primary" disabled={!how} onClick={() => onStart(`${SPANS.find(([label]) => label === span)![1]}；这段时间${how}`)}>开始</button>
      </div>
    </Sheet>
  );
}

function RegenButton({ onTap, onLong, title }: { onTap: () => void; onLong: () => void; title?: string }) {
  const press = useLongPress(onLong, onTap);
  return <button className="ghost" title={title} {...press}>重说</button>;
}

function ChoiceButton({ text, onTap, onLong, title }: { text: string; onTap: () => void; onLong: () => void; title?: string }) {
  const press = useLongPress(onLong, onTap);
  return <button className="choice" title={title} {...press}>{text}</button>;
}

function HintInput({ onSubmit }: { onSubmit: (hint: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="row" style={{ marginTop: 12 }}>
      <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="或者自己写，如：让掌柜答应" />
      <button className="primary" disabled={!text.trim()} onClick={() => onSubmit(text.trim())}>重说</button>
    </div>
  );
}


function StorySheet({ world, headId, onSave, onClose }: { world: World; headId: string; onSave: (p: Partial<World["settings"]>) => void; onClose: () => void }) {
  const { game } = useApp();
  const s = world.settings;
  const [pins, setPins] = useState<Pin[]>([]);
  useEffect(() => { void game.repo.pinsOnPath(world.id, headId).then(setPins); }, [world.id, headId]);
  const [premise, setPremise] = useState(s.premise);
  const [essentials, setEssentials] = useState(s.essentials);
  const [rules, setRules] = useState(s.rules);
  const [directive, setDirective] = useState(s.directive);
  return (
    <Sheet title="故事设定与要点" onClose={onClose}>
      <div className="stack">
        <label>故事设定（AI 每一段都会参考）<textarea rows={6} value={premise} onChange={(e) => setPremise(e.target.value)} /></label>
        <label>要点（必须一直记住的事，每行一条，所有路线都有效）<textarea rows={4} value={essentials} onChange={(e) => setEssentials(e.target.value)} placeholder="比如：王掌柜其实是主角的远房舅舅" /></label>
        {pins.length > 0 && <div className="stack" style={{ gap: 4 }}>
          <span className="muted">从剧情里记下的要点（只在这条路线有效；长按正文选“记住这件事”添加）</span>
          {pins.map((pin) => (
            <div className="item-row" key={pin.id}>
              <div className="grow">{pin.text}</div>
              <button aria-label={`删除要点：${pin.text}`} onClick={() => void game.repo.deletePin(pin.id).then(() => setPins((list) => list.filter((x) => x.id !== pin.id)))}>删除</button>
            </div>
          ))}
        </div>}
        <label>叙事方针（文风和节奏）<textarea rows={2} value={directive} onChange={(e) => setDirective(e.target.value)} placeholder="比如：节奏快一些，多写市井人物" /></label>
        <label>给 AI 的额外规则<textarea rows={3} value={rules} onChange={(e) => setRules(e.target.value)} placeholder="比如：不要让主角轻易获得权力" /></label>
        <button className="primary" onClick={() => onSave({ premise, essentials, rules, directive })}>保存</button>
      </div>
    </Sheet>
  );
}

function WorldSettingsSheet({ world, onChange, onRules, onClose }: { world: World; onChange: (p: Partial<World["settings"]>) => void; onRules: () => void; onClose: () => void }) {
  const { game, toast } = useApp();
  const s = world.settings;
  const [defaults, setDefaults] = useState<PlayDefaults | null>(null);
  useEffect(() => { void loadPlayDefaults(game.repo).then(setDefaults); }, []);
  const differs = defaults ? differsFromDefaults(s, defaults) : [];
  /** “本局” on a heading whose value differs from the play defaults. */
  const mark = (key: keyof PlayDefaults) => (differs.includes(key) ? <span className="tag own">本局</span> : null);
  const levels: Intensity[] = ["含蓄", "写实", "浓烈"];
  const intensity = (key: keyof typeof s.intensity, label: string) => (
    <div className="stack" style={{ gap: 6 }}>
      <span className="muted">{label}</span>
      <div className="segmented">
        {levels.map((l) => <button key={l} aria-pressed={s.intensity[key] === l} onClick={() => onChange({ intensity: { ...s.intensity, [key]: l } })}>{l}</button>)}
      </div>
    </div>
  );
  return (
    <Sheet title="本局设置" onClose={onClose}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>只影响这个世界，从下一段开始生效。新开一局的默认在 设置 → 写作与叙事 / 游玩默认。</p>
        <span className="muted">难度 {mark("difficulty")}</span>
        <div className="segmented">
          {(["宽松", "标准", "残酷"] as const).map((l) => <button key={l} aria-pressed={s.difficulty === l} onClick={() => onChange({ difficulty: l })}>{l}</button>)}
        </div>
        <p className="muted" style={{ margin: 0 }}>{s.difficulty === "宽松" ? "运气偏好；受了重伤也只是昏过去，不会死。" : s.difficulty === "残酷" ? "运气偏差；重伤可能直接丧命。" : "运气平常；伤重时先“垂危”，剧情真写到才会死。"}</p>
        <span className="muted">每段篇幅 {mark("length")}</span>
        <div className="segmented">
          {(["短", "中", "长"] as const).map((l) => <button key={l} aria-pressed={s.length === l} onClick={() => onChange({ length: l })}>{l}</button>)}
        </div>
        <span className="muted">建议选项数量 {mark("choiceCount")}</span>
        <div className="segmented">
          {[0, 2, 3, 4].map((n) => <button key={n} aria-pressed={s.choiceCount === n} onClick={() => onChange({ choiceCount: n })}>{n === 0 ? "不要" : n}</button>)}
        </div>
        <span className="muted">叙述视角 {mark("perspective")}</span>
        <div className="segmented">
          {([["你", "你"], ["我", "我"], ["他", "他 / 她"]] as const).map(([v, l]) => <button key={v} aria-pressed={s.perspective === v} onClick={() => onChange({ perspective: v })}>{l}</button>)}
        </div>
        <span className="muted">文风 {mark("style")}</span>
        <div className="segmented">
          {(["白话", "半文半白"] as const).map((v) => <button key={v} aria-pressed={s.style === v} onClick={() => onChange({ style: v })}>{v}</button>)}
        </div>
        <span className="muted">设定集自动整理 {mark("autoUpkeep")}</span>
        <div className="segmented">
          {([[true, "开"], [false, "关"]] as const).map(([v, l]) => <button key={l} aria-pressed={s.autoUpkeep === v} onClick={() => onChange({ autoUpkeep: v })}>{l}</button>)}
        </div>
        <p className="muted" style={{ margin: 0 }}>开着时，每过几回合 AI 会把新出现的人物、地点和势力记进设定集；只改它自己写的卡，你写的不会动。</p>
        <span className="muted">章节摘要 {mark("chapterEvery")}</span>
        <div className="segmented">
          {[0, 8, 12, 20].map((n) => <button key={n} aria-pressed={s.chapterEvery === n} onClick={() => onChange({ chapterEvery: n })}>{n ? `每 ${n} 回合` : "关"}</button>)}
        </div>
        <p className="muted" style={{ margin: 0 }}>每过这么多回合，AI 把这段剧情写成一章摘要，更早的剧情靠它记住；在“我 → 记事”里查看和修改。</p>
        {intensity("violence", "暴力与伤亡")}
        {intensity("romance", "感情与亲密")}
        {intensity("darkness", "黑暗与压抑")}
        <p className="muted">“浓烈”仍受所用 AI 服务的规则限制。</p>
        {defaults && differs.length > 0 && <div className="row" style={{ flexWrap: "wrap" }}>
          <button onClick={() => { onChange({ difficulty: defaults.difficulty, length: defaults.length, choiceCount: defaults.choiceCount, perspective: defaults.perspective, style: defaults.style, autoUpkeep: defaults.autoUpkeep, chapterEvery: defaults.chapterEvery, intensity: defaults.intensity }); toast("已恢复为默认"); }}>全部恢复为默认</button>
          <button className="ghost" onClick={() => { const next = { ...defaults, difficulty: s.difficulty, length: s.length, choiceCount: s.choiceCount, perspective: s.perspective, style: s.style, autoUpkeep: s.autoUpkeep, chapterEvery: s.chapterEvery, intensity: s.intensity }; void savePlayDefaults(game.repo, next).then(() => { setDefaults(next); toast("以后新开一局都用这些设置"); }); }}>设为以后的默认</button>
        </div>}
        <button className="ghost" style={{ textAlign: "left" }} onClick={onRules}>纪年与货币 ›</button>
      </div>
    </Sheet>
  );
}
