// The play screen (PLAN_V3 §4.3–4.4): story stream, choices, input bar,
// regenerate/variants, long-press menu, stop/interrupt, character panel.
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { eraContext } from "../../engine/era";
import { nowOf, timeRows } from "../../engine/calendar/clock";
import type { ContextPreview } from "../../engine/game";
import { challengeInputOf, challengeView } from "../../engine/modes";
import type { TurnRecord } from "../../engine/state/apply";
import * as tree from "../../engine/tree";
import type { ActionMode, Challenge, Script, StoryNode, World, WorldState } from "../../engine/types";
import { useApp, useBack } from "../app/context";
import { BookmarkSheet, LinesSheet } from "../components/Lines";
import { Panel } from "../components/Panel";
import { TimeCorrectionSheet } from "../components/TimeCorrectionSheet";
import { RulesSheet } from "../components/RulesSheet";
import { Sheet } from "../components/Sheet";
import { RecapCard, useRecap } from "../components/Recap";
import { TocSheet } from "../components/Toc";
import { StoryText, daypart, waitingLine } from "../components/StoryText";
import { fromSetup } from "./openingDraft";
import { useMedia, useMouse, useWide } from "../components/useMedia";
import { EndingCard, LifeSheet, useSealToast } from "../components/LifeSheet";
import { PassageCardSheet } from "../components/ShareCard";
import { useShortcuts } from "../components/useShortcuts";
import { ShortcutsSheet } from "../components/ShortcutsSheet";
import { Icon } from "../components/Icon";
import { buzz, motionLevel } from "../app/motion";
import { ReadingQuickSheet } from "./play/ReadingQuick";
import { adoptRewrite, adoptCanonCorrection, assertWritingAnchor, STALE_WRITING, WritingError, writingError, type WritingAnchor, type CanonCorrectionPreview } from "../../engine/writing/assist";
import { WritingAssist, type WritingDraft } from "../components/WritingAssist";
import { WritingDesk } from "../components/WritingDesk";
import { PlayQualityEffects } from "../components/PlayQualityEffects";
import { AutoplaySheet, ChallengeEndCard, ModeBanner, ScriptEndCard, endsAt } from "../components/Modes";
import { ScriptSheet } from "../components/ScriptSheet";
import { ChallengeSheet } from "../components/ChallengeSheet";
import { ReferenceSheet } from "../components/Sources";
import { AskSheet } from "./play/AskSheet";
import { InputModeSheet } from "./play/PlayInput";
import { Composer } from "./play/Composer";
import { HeadTools, NextChoices, NoticeCard, StampBurst, WritingTurn, milestoneOf } from "./play/StoryParts";
import { EPILOGUE, HINTS, MODE_SAVED, PAGE } from "./play/constants";
import { HintInput } from "./play/HintInput";
import { MoreMenu, PassageMenu, PassageMoreMenu } from "./play/PlayMenus";
import { RememberSheet } from "./play/RememberSheet";
import { SkipSheet } from "./play/SkipSheet";
import { StorySheet } from "./play/StorySheet";
import { TurnView } from "./play/TurnView";
import type { Gen, WritingSettings } from "./play/types";
import { WorldSettingsSheet } from "./play/WorldSettingsSheet";
import { DepthSheet } from "./play/DepthSheet";
import { CanonNotesSheet } from "../components/CanonNotes";
import { PassageUsageSheet, TurnUsageLine, WorldUsageSheet } from "../components/TurnUsage";
import { listNotes } from "../../engine/sources/notes";
import { DEPTH_LABEL, DEPTH_MARK, depthOf } from "../../engine/depth";
import { useGeneration } from "./play/useGeneration";
import { usePlayDraft } from "./play/usePlayDraft";
import { useAssistantBusy } from "./play/useAssistantBusy";
import { useNotificationGate } from "./play/useNotificationGate";

export default function Play({ worldId, active = true }: { worldId: string; active?: boolean }) {
  const { game, push, replace, toast, devMode, pop, profile, reading } = useApp();
  const [world, setWorld] = useState<World | null>(null);
  const [cursor, setCursor] = useState<tree.Cursor | null>(null);
  // The head now, for toast actions: one offered before a newer turn or edit does nothing.
  const headRef = useRef<string | null>(null);
  headRef.current = cursor?.head.id ?? null;
  const busyRef = useRef(false);
  const still = (headId: string, run: () => void) => () => { if (headRef.current === headId && !busyRef.current) run(); else toast("故事已经往下走了，这一步不再适用"); };
  const [nodes, setNodes] = useState<StoryNode[]>([]);
  const visibleNodes = useRef<StoryNode[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const limit = useRef(PAGE);
  const [state, setState] = useState<WorldState | null>(null);
  const [variants, setVariants] = useState<tree.Variants | null>(null);
  const [agentFloor, setAgentFloor] = useState<number | undefined>();
  /** The state before the latest passage: an end card shows only on the passage where the script or challenge ended. */
  const [before, setBefore] = useState<WorldState | null>(null);
  /** The end card set aside with 继续玩下去 / 继续自由发展, by the passage it belongs to. */
  const [endSeen, setEndSeen] = useState<string | null>(null);
  /** 旁观: the input offers 幕后 / 写 only. */
  const watch = world?.settings.pilot === "ai";
  const draft = usePlayDraft(game, worldId, !!world, watch);
  const { input, setInput, note, setNote, noteOpen, setNoteOpen, modeIndex, setModeIndex, modeList, currentMode } = draft;
  const [menuNode, setMenuNode] = useState<StoryNode | null>(null);
  const [menuMore, setMenuMore] = useState<StoryNode | null>(null);
  const [editing, setEditing] = useState<{ node: StoryNode; field: "narrative" | "action"; text: string } | null>(null);
  const [rawNode, setRawNode] = useState<StoryNode | null>(null);
  const [context, setContext] = useState<ContextPreview | null>(null);
  const [remember, setRemember] = useState<{ node: StoryNode; text: string } | null>(null);
  const [bookmark, setBookmark] = useState<{ node: StoryNode; name: string } | null>(null);
  const [sheet, setSheet] = useState<"more" | "reading" | "depth" | "notes" | "usage" | "hints" | "settings" | "story" | "lines" | "time" | "rules" | "duration" | "reference" | "skip" | "ask" | "toc" | "life" | "keys" | "script" | "challenge" | "autoplay" | null>(null);
  const [cardNode, setCardNode] = useState<StoryNode | null>(null);
  const [panel, setPanel] = useState(false);
  const openPanel = useCallback(() => setPanel(true), []);
  const wide = useWide();
  const mouse = useMouse();
  /** Room for the long placeholders in the one-line input box. */
  const roomy = useMedia("(min-width: 520px)");
  const inputBox = useRef<HTMLTextAreaElement>(null);
  // The box grows with what is typed; shrink it back once the action is sent.
  useEffect(() => { if (!input && inputBox.current) inputBox.current.style.height = ""; }, [input]);
  const [atBottom, setAtBottom] = useState(true);
  const [typing, setTyping] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const shownPage = useRef(active);
  shownPage.current = active;
  type ReadingAnchor = { nodeId: string; paragraph: number; offset: number; top: number; order: string[] };
  const assistantAnchor = useRef<ReadingAnchor | null>(null);
  const [returnAnchor, setReturnAnchor] = useState<ReadingAnchor | null>(null);
  const captureReading = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const turns = [...el.querySelectorAll<HTMLElement>("[data-node-id]")];
    const node = turns.find((item) => item.getBoundingClientRect().bottom > top + 1) ?? turns.at(-1);
    if (!node?.dataset.nodeId) return;
    const paragraphs = [...node.querySelectorAll<HTMLElement>(".story-text p")];
    const p = paragraphs.find((item) => item.getBoundingClientRect().bottom > top + 1);
    assistantAnchor.current = { nodeId: node.dataset.nodeId, paragraph: p ? paragraphs.indexOf(p) : -1, offset: (p ?? node).getBoundingClientRect().top - top, top: el.scrollTop, order: turns.map((item) => item.dataset.nodeId!) };
  };
  const follow = useRef(reading.autoScroll);
  const initialScroll = useRef(true);
  const readingLoaded = useRef(false);
  const restoreReading = useRef<string | null>(null);
  const readingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshVersion = useRef(0);
  const era = eraContext(world?.eraId ?? null, state);
  const turn = [...nodes].reverse().find((n) => n.kind !== "edit");
  // 前情提要: back after more than six hours, a card at the bottom of the story (direction G).
  const [recap, closeRecap] = useRecap(worldId, world?.playedAt ?? null, cursor?.head.id ?? null, state);
  // A late recap follows the same reading preference as new story text.
  useEffect(() => {
    if (!recap || !reading.autoScroll || !follow.current) return;
    const frame = requestAnimationFrame(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [recap, reading.autoScroll]);
  // 印谱: "得一枚印：…" the first time a seal is earned (PLAN_V4 direction G).
  useSealToast(world, state, nodes.filter((n) => n.kind === "turn" || n.kind === "fastforward").length);
  const refresh = useCallback(async (keepLimit = limit.current) => {
    const version = ++refreshVersion.current;
    const w = await game.repo.getWorld(worldId);
    if (!w) return pop();
    const c = await tree.cursor(game.repo, worldId);
    let path = await game.repo.path(c.head.id, keepLimit + 1);
    // A growing story keeps the history already on screen. Dropping the first
    // loaded turn shifts every visible paragraph, even without a scroll call.
    const visible = visibleNodes.current;
    const oldHead = path.findIndex((n) => n.id === visible.at(-1)?.id);
    const needed = oldHead < 0 ? keepLimit : Math.max(keepLimit, visible.length + path.length - oldHead - 1);
    if (needed > keepLimit) {
      keepLimit = needed;
      path = await game.repo.path(c.head.id, keepLimit + 1);
    }
    const currentState = await game.repo.getState(c.head.id);
    let latest = c.head;
    while (latest.kind === "edit") latest = (await game.repo.getNode(latest.parentId!))!;
    const currentVariants = await tree.variants(game.repo, latest);
    const previous = latest.parentId ? await game.repo.getState(latest.parentId) : null;
    const loaded = path.slice(-keepLimit);
    if (version !== refreshVersion.current) return;
    if (!readingLoaded.current) {
      const saved = await game.repo.getSetting<string | null>("reading:" + worldId, null);
      if (version !== refreshVersion.current) return;
      readingLoaded.current = true;
      if (loaded.some((n) => n.id === saved) && saved !== loaded.filter((n) => n.kind !== "edit").at(-1)?.id) {
        restoreReading.current = saved;
        follow.current = false;
      }
    }
    setHasMore(path.length > keepLimit);
    limit.current = keepLimit;
    visibleNodes.current = loaded;
    setNodes(loaded);
    setWorld(w);
    setCursor(c);
    setState(currentState);
    setBefore(previous);
    setVariants(currentVariants);
  }, [game, worldId, pop]);
  // Choices and writing tools fold away during a request. Reserve their space
  // in the story until new words fill it, so a taller viewport cannot clamp a
  // reader at the bottom upward. No scroll position is restored at completion.
  const streamFloor = () => {
    const el = scroller.current;
    const dock = el?.closest(".play")?.querySelector<HTMLElement>(".dock");
    const input = dock?.querySelector<HTMLElement>(".inputbar");
    if (!el || !dock || !input) return undefined;
    const dockStyle = getComputedStyle(dock), storyStyle = getComputedStyle(el);
    const folding = Math.max(0, dock.offsetHeight - input.offsetHeight - parseFloat(dockStyle.paddingTop) - parseFloat(dockStyle.paddingBottom) - parseFloat(dockStyle.borderTopWidth));
    return Math.max(0, el.scrollTop + el.clientHeight + folding - parseFloat(storyStyle.paddingTop) - parseFloat(storyStyle.paddingBottom));
  };
  // Install the saved passage in the same render that removes its stream (the generation
  // hook clears the stream). Do not shrink the scroll range while refresh reads SQLite.
  const showSaved = (node: StoryNode) => {
    refreshVersion.current++;
    const current = visibleNodes.current;
    const existing = current.findIndex((n) => n.id === node.id);
    const parent = current.findIndex((n) => n.id === node.parentId);
    const saved = existing >= 0 ? current.map((n) => n.id === node.id ? node : n)
      : [...(parent >= 0 ? current.slice(0, parent + 1) : current), node];
    visibleNodes.current = saved;
    setNodes(saved);
  };
  const notifications = useNotificationGate(game, toast);
  const agentBusy = useAssistantBusy(game, worldId, (running) => setAgentFloor(running ? streamFloor() : undefined));
  const generation = useGeneration({
    game, worldId, autoScroll: reading.autoScroll, follow, refresh, showSaved, streamFloor,
    restoreDraft: draft.restore, onDone: (node) => { void countTurn(); celebrate(node); }, isBusy: () => busyRef.current,
    toast, push, profileId: profile?.id,
  });
  const { gen, auto, notice, setNotice, slow, waited } = generation;
  // A finished passage settles with a gold sweep; a milestone is stamped down (华丽, D160).
  const [fresh, setFresh] = useState<string | null>(null);
  const [stamp, setStamp] = useState<{ label: string; sub: string; key: number } | null>(null);
  const celebrate = (node: StoryNode) => {
    const level = motionLevel();
    if (level === "off") return;
    setFresh(node.id);
    setTimeout(() => setFresh((f) => (f === node.id ? null : f)), 1800);
    if (level !== "rich") return;
    const milestone = milestoneOf(((node.meta.chips as { text: string }[] | undefined) ?? []).map((c) => c.text));
    if (!milestone) return;
    const key = Date.now();
    setTimeout(() => { setStamp({ ...milestone, key }); buzz(game.platform); }, 500);
    setTimeout(() => setStamp((s) => (s?.key === key ? null : s)), 2600);
  };
  const busy = !!gen || !!auto || agentBusy;
  busyRef.current = busy;
  useEffect(() => { if (gen) closeRecap(); }, [!!gen]);
  const [writing, setWriting] = useState<WritingDraft | null>(null);
  const [desk, setDesk] = useState(false);
  const writingScope = useRef({ worldId, headId: cursor?.head.id, lineId: cursor?.line.id, input, mode: currentMode.mode, busy, active: true });
  writingScope.current = { worldId, headId: cursor?.head.id, lineId: cursor?.line.id, input, mode: currentMode.mode, busy, active };
  useEffect(() => () => { writingScope.current.active = false; }, []);
  useEffect(() => { setWriting(null); setDesk(false); }, [worldId, cursor?.head.id, cursor?.line.id, busy]);
  // After the third turn, once ever: everything a passage can do is behind a long press (AUDIT 4.2).
  const [pressTip, setPressTip] = useState(false);
  const [usageNode, setUsageNode] = useState<string | null>(null);
  const countTurn = async () => {
    if (await game.repo.getSetting("tip:longPress", false)) return;
    const n = (await game.repo.getSetting<number>("tip:turns", 0)) + 1;
    await game.repo.setSetting("tip:turns", n);
    if (n >= 3) { setPressTip(true); await game.repo.setSetting("tip:longPress", true); }
  };
  const [modePicker, setModePicker] = useState(false);
  // 同人 with no 原著札记 yet: suggest digesting the main plot once (R29-T003).
  const [notesTip, setNotesTip] = useState(false);
  const fanficBook = state?.source?.fanfic ? state.source.bookId : null;
  useEffect(() => {
    setNotesTip(false);
    if (!fanficBook) return;
    let live = true;
    void (async () => {
      if (await game.repo.getSetting(`tip:notes:${worldId}`, false)) return;
      const notes = await listNotes(game.repo, fanficBook, worldId);
      if (live && !notes.length) setNotesTip(true);
    })();
    return () => { live = false; };
  }, [fanficBook, worldId]);
  const dismissNotesTip = () => { setNotesTip(false); void game.repo.setSetting(`tip:notes:${worldId}`, true); };
  // The AI filed new cards in the background: show its line and the new 设定集.
  useEffect(() => game.subscribe((id) => { if (id === worldId && shownPage.current) void refresh(); }), [game, worldId, refresh]);
  useEffect(() => {
    if (!active) { captureReading(); follow.current = false; return; }
    const anchor = assistantAnchor.current;
    if (!anchor) return;
    let live = true;
    // Refresh once on return. Later background updates do not restore this anchor.
    void refresh().then(() => { if (live) setReturnAnchor(anchor); });
    return () => { live = false; };
  }, [active, refresh]);
  useEffect(() => () => { if (readingTimer.current) clearTimeout(readingTimer.current); }, []);

  // The arrow reflects the viewport; following also requires the player's preference.
  const onScroll = () => {
    if (!active) return;
    const el = scroller.current!;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    follow.current = reading.autoScroll && bottom;
    setAtBottom(bottom);
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
    const el = scroller.current;
    if (!active || !el || !nodes.length) return;
    if (returnAnchor) {
      const turns = [...el.querySelectorAll<HTMLElement>("[data-node-id]")];
      let target = turns.find((item) => item.dataset.nodeId === returnAnchor.nodeId);
      if (!target) {
        const oldIndex = returnAnchor.order.indexOf(returnAnchor.nodeId);
        target = turns.filter((item) => returnAnchor.order.includes(item.dataset.nodeId!)).sort((a, b) => Math.abs(returnAnchor.order.indexOf(a.dataset.nodeId!) - oldIndex) - Math.abs(returnAnchor.order.indexOf(b.dataset.nodeId!) - oldIndex))[0] ?? turns[Math.min(Math.max(0, oldIndex), turns.length - 1)];
      }
      const paragraphs = target ? [...target.querySelectorAll<HTMLElement>(".story-text p")] : [];
      const paragraph = returnAnchor.paragraph < 0 ? target : paragraphs[Math.min(returnAnchor.paragraph, paragraphs.length - 1)] ?? target;
      if (paragraph) el.scrollTop += paragraph.getBoundingClientRect().top - el.getBoundingClientRect().top - returnAnchor.offset;
      else el.scrollTop = returnAnchor.top;
      assistantAnchor.current = null;
      restoreReading.current = null;
      initialScroll.current = false;
      follow.current = false;
      setReturnAnchor(null);
    } else if (assistantAnchor.current) return;
    else if (restoreReading.current) {
      const target = el.querySelector<HTMLElement>(`[data-node-id="${restoreReading.current}"]`);
      if (target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top;
      restoreReading.current = null;
      initialScroll.current = false;
    } else if (initialScroll.current) {
      // Opening a world still starts at its latest passage when no earlier spot was saved.
      toBottom();
      initialScroll.current = false;
    } else if (reading.autoScroll && follow.current) toBottom();
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }, [active, returnAnchor, nodes, gen?.text, gen?.phase, notice, recap, reading.autoScroll]);
  // Leaving while a passage is written is fine: it keeps writing and the shelf shows it (D160).
  const send = (override?: { mode: ActionMode; text: string }, overrideNote?: string | null) => {
    if (busy || !cursor) return;
    if (!game.llm) { push({ name: "setup" }); return; }
    void notifications.gate(() => {
      const mode = override?.mode ?? (input.trim() ? currentMode.mode : "continue");
      const text = override?.text ?? (mode === "continue" ? "" : input.trim());
      // An open 幕后要求 goes with a typed action and with a tapped choice alike.
      const directorNote = overrideNote !== undefined ? overrideNote : draft.directorNote();
      // A tapped choice leaves what the player was typing in the box (R28-T009).
      if (!override) setInput("");
      draft.clearAfterSend(mode);
      buzz(game.platform);
      generation.start({
        action: { mode, text },
        // A failure gives the words back to the box; 再试一次 sends them again without doubling them.
        retry: () => { setInput(""); setNote(""); setNoteOpen(false); send({ mode, text }, directorNote); },
        restore: mode === "continue" || mode === "skip" ? null : { mode, text, note: directorNote ?? "" },
        run: (on) => game.play(worldId, { mode, text, directorNote }, on),
      });
    });
  };

  const startAutoplay = (turns: number) => {
    if (busy || !cursor) return;
    if (!game.llm) { push({ name: "setup" }); return; }
    void notifications.gate(() => generation.startAutoplay(turns));
  };

  const regenerate = (hint: string | null) => {
    if (busy || !turn?.parentId) return;
    void notifications.gate(() => generation.start({
      action: turn.actionMode && turn.actionMode !== "continue" ? { mode: turn.actionMode, text: turn.actionText ?? "" } : null,
      variant: true, retry: () => regenerate(hint), run: (on) => game.regenerate(worldId, hint, on),
    }));
  };

  const resume = () => {
    if (busy || !cursor) return;
    void notifications.gate(() => generation.start({
      action: null, text: turn?.narrative ?? cursor.head.narrative, variant: true,
      retry: resume, run: (on) => game.resumeInterrupted(worldId, on),
    }));
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
    if (c.line.id !== before) toast("已回到这里，原来的路线保留在“世界线”里", { label: "回原路线", run: still(c.head.id, () => void tree.switchLine(game.repo, worldId, before).then(() => refresh())) });
    else toast("已回到这里", { label: "撤回", run: still(c.head.id, () => void redoAll(c, cursor.head.id)) });
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
    toast(`已撤销${what}`, { label: "重做", run: still(c.head.id, () => void tree.redo(game.repo, c).then(() => refresh())) });
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
    if (!cursor) return;
    try { await applyRewrite({ worldId, lineId: cursor.line.id, headId: cursor.head.id, nodeId: node.id, original: node.narrative }, text); }
    catch (e) { toast(writingError(e)); }
  };
  const checkScope = (anchor: WritingAnchor) => {
    const current = writingScope.current;
    if (!current.active || current.busy || current.worldId !== anchor.worldId || current.headId !== anchor.headId || current.lineId !== anchor.lineId) throw new WritingError(STALE_WRITING);
  };
  /** A rewrite goes into the passage itself (R14 engine review); the first original stays for 恢复原文. */
  const applyRewrite = async (anchor: WritingAnchor, text: string) => {
    checkScope(anchor);
    await adoptRewrite(game, anchor, text);
    await refresh();
    toast("已改写，后面的剧情会按改过的文字继续", { label: "撤回", run: () => void game.repo.restoreNarrative(anchor.nodeId).then(() => refresh()) });
  };
  const openWriting = (kind: "rewrite" | "polish", node: StoryNode) => {
    if (!cursor || busy) return;
    setWriting({ kind, text: kind === "rewrite" ? node.narrative : input, mode: currentMode.mode, source: state?.source,
      anchor: { worldId, lineId: cursor.line.id, headId: cursor.head.id, nodeId: node.id, original: node.narrative } });
  };
  const adoptWriting = async (text: string, correction?: CanonCorrectionPreview) => {
    if (!writing) return;
    const draft = writing;
    checkScope(draft.anchor);
    if (correction) {
      const revised = await adoptCanonCorrection(game, correction);
      await refresh();
      toast("已进入修订路线，原路线和后续剧情保留", { label: "回到原路线", run: still(revised.head.id, () => void tree.switchLine(game.repo, worldId, draft.anchor.lineId).then(() => refresh())) });
      return;
    }
    if (draft.kind === "rewrite") { await applyRewrite(draft.anchor, text); return; }
    await assertWritingAnchor(game, draft.anchor);
    checkScope(draft.anchor);
    if (writingScope.current.input !== draft.text || writingScope.current.mode !== draft.mode) throw new WritingError("输入已经改过了，请重新润色，保留你刚写的内容。");
    setInput(text);
    toast("已放进输入框，还没有发送", { label: "撤回", run: () => {
      try { checkScope(draft.anchor); if (writingScope.current.input !== text || writingScope.current.mode !== draft.mode) throw new WritingError("输入已经改过了，保留现在的内容。"); setInput(draft.text); }
      catch (e) { toast(writingError(e)); }
    } });
  };

  const loadMore = async () => {
    const el = scroller.current!;
    const before = el.scrollHeight;
    const next = limit.current + PAGE;
    limit.current = next;
    await refresh(next);
    requestAnimationFrame(() => { el.scrollTop += el.scrollHeight - before; });
  };

  /** Scrolls the story to a passage on the current path, loading earlier pages when it is not shown yet (目录, search). */
  const scrollToNode = async (nodeId: string) => {
    const find = () => scroller.current?.querySelector<HTMLElement>(`.turn[data-node-id="${nodeId}"]`) ?? null;
    const flash = (target: HTMLElement) => {
      target.classList.remove("toc-flash");
      void target.offsetWidth;
      target.classList.add("toc-flash");
      setTimeout(() => target.classList.remove("toc-flash"), 1800);
    };
    follow.current = false;
    const shownNow = find();
    if (shownNow && scroller.current) {
      scroller.current.scrollTop += shownNow.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top - 8;
      flash(shownNow);
      return;
    }
    if (!cursor) return;
    const path = await game.repo.path(cursor.head.id);
    const index = path.findIndex((n) => n.id === nodeId);
    if (index < 0) return;
    const next = Math.max(limit.current, Math.ceil((path.length - index) / PAGE) * PAGE);
    restoreReading.current = nodeId;
    limit.current = next;
    await refresh(next);
    setTimeout(() => { const target = find(); if (target) flash(target); }, 50);
  };

  const updateSettings = async (patch: Partial<WritingSettings>) => {
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
    if (!ready || busy || isDead || !choice || turn?.status === "interrupted") return false;
    send({ mode: watch ? "direct" : "do", text: choice });
  } });
  const focusInput = { inInputs: true, run: () => { if (!inputBox.current || isDead) return false; inputBox.current.focus(); } };
  const keys = () => setSheet("keys");
  useShortcuts({
    "Ctrl+Z": { run: () => { if (!ready || busy || !cursor!.head.parentId) return false; void undo(); } },
    "Ctrl+Y": { run: () => { if (!ready || busy || !tree.canRedo(cursor!)) return false; void redo(); } },
    "Ctrl+Shift+Z": { run: () => { if (!ready || busy || !tree.canRedo(cursor!)) return false; void redo(); } },
    "Ctrl+R": { inInputs: true, run: () => { if (!ready || busy || !turn?.parentId || turn.kind === "opening") return false; regenerate(null); } },
    "Ctrl+K": focusInput,
    "/": focusInput,
    "Ctrl+F": { inInputs: true, run: () => { if (!ready || busy) return false; setSheet("ask"); } },
    "Ctrl+,": { inInputs: true, run: () => (busy ? (toast("正在写，先停止或等写完"), undefined) : push({ name: "settings" })) },
    "F1": { inInputs: true, run: () => (busy ? (toast("正在写，先停止或等写完"), undefined) : push({ name: "guide" })) },
    "Ctrl+Enter": { inInputs: true, run: () => { if (!ready || busy || isDead) return false; send(); } },
    "Alt+1": pick(0), "Alt+2": pick(1), "Alt+3": pick(2), "Alt+4": pick(3),
    "?": { run: keys },
    "Ctrl+/": { inInputs: true, run: keys },
  }, mouse && active);

  if (!world || !cursor || !state) return (
    <div className="screen-body skeleton-story" aria-label="正在读取" role="status">
      {[92, 100, 96, 70, 0, 100, 88, 94, 60].map((w, i) => w ? <i key={i} className="skeleton" style={{ width: `${w}%` }} /> : <br key={i} />)}
    </div>
  );

  const head = cursor.head;
  const placeName = state.places.find((p) => p.id === state.placeId)?.name;
  const place = placeName ?? world.title;
  const now = nowOf(era.clock, state.time.elapsedMinutes);
  const shown = gen?.variant ? nodes.slice(0, nodes.findIndex((n) => n.id === turn?.id)) : nodes;
  const mode = currentMode;
  const dead = isDead;
  const sendLabel = agentBusy ? "等待" : busy ? "停止" : input.trim() ? "发送" : "继续";
  // The choices live in the story now, so typing no longer hides them (D160).
  const showChoices = !busy && !dead && !!turn?.choices.length && turn.status !== "interrupted";
  const stopOrSend = () => { if (gen || auto) generation.stop(); else send(); };
  // The end cards of a script played out or a challenge decided on the latest passage (not after death).
  const ends = turn && !dead && endSeen !== turn.id ? endsAt(state, before) : { challenge: false, script: false };
  const ending = challengeView(state);
  /** After a 剧本 / 挑战 edit: one line in the story, and a toast that can take it back. */
  const saveMode = async (patch: TurnRecord, summary: string) => {
    const c = await game.editState(worldId, patch, summary);
    await refresh();
    toast(MODE_SAVED.find(([re]) => re.test(summary))?.[1] ?? "已保存剧本", { label: "撤销", run: still(c.head.id, () => void tree.undo(game.repo, c).then(() => refresh())) });
  };
  /** The same opening again; 再挑战一次 brings this challenge, also one added after the opening. */
  const again = async (retry: boolean) => {
    const setup = await game.setupOf(worldId);
    if (!setup) return;
    if (retry && state.challenge) setup.challenge = challengeInputOf(state.challenge);
    await game.repo.setSetting("newgameDraft", fromSetup(setup));
    if (retry) await game.repo.setSetting("newgameAutostart", true);
    replace({ name: "newgame" });
  };
  /** 回到之前: to just before the passage that ended it, keeping edits made before that passage (such as adding the challenge). */
  const backOne = () => { const target = nodes.find((n) => n.id === turn?.parentId); if (target) void goBack(target); };
  const statusText = gen && { starting: "", thinking: "构思中…", writing: "", organizing: "整理中…" }[gen.phase];

  const panelProps = {
    worldId, headId: head.id, chapterEvery: world.settings.chapterEvery, state, era, settings: world.settings, busy,
    onContinuitySaved: refresh, onClose: () => setPanel(false), onOpenStory: () => { setPanel(false); setSheet("story"); },
    onOrganize: async (replaceOwnEra: boolean, useSource?: boolean) => {
      const c = await game.organize(worldId, { replaceOwnEra, useSource });
      if (!c) { toast("这次没整理出来，稍后再试"); return false; }
      await refresh();
      toast("已整理设定集，可以接着修改");
      return true;
    },
    onSave: async (patch: TurnRecord, summary: string, expectedHeadId?: string) => { await game.editState(worldId, patch, summary, undefined, expectedHeadId); await refresh(); },
  };

  return (
    <div className={`play-layout${wide ? " wide" : ""}`}>
    <PlayQualityEffects revision={`${head.id}:${gen?.phase ?? "idle"}:${writing?.kind ?? ""}:${sheet ?? ""}`} />
    <div className="play" data-daypart={daypart(now.hour)}>
      <div className="topbar">
        <button className="icon-btn" aria-label="返回" title="返回（Esc）" onClick={() => pop()}><Icon name="back" /></button>
        <button className="title" aria-label="此时此地" title="此时此地" onClick={() => setSheet("time")}>
          <h1>{place}</h1>
          <div className="subtitle">{now.text}</div>
        </button>
        {!wide && <button className="icon-btn" aria-label="角色" title="角色" onClick={() => setPanel(true)}><span className="name-seal" aria-hidden="true">{(state.protagonist.name.trim() || "我")[0]}</span></button>}
        <button className={`icon-btn depth-btn depth-${depthOf(world.settings)}`} aria-label={`生成档位：${DEPTH_LABEL[depthOf(world.settings)]}`} title={`生成档位：${DEPTH_LABEL[depthOf(world.settings)]}`} onClick={() => setSheet("depth")}><span aria-hidden="true">{DEPTH_MARK[depthOf(world.settings)]}</span></button>
        <button className="icon-btn reading-btn" aria-label="字号与主题" title="字号与主题" onClick={() => setSheet("reading")}><span aria-hidden="true">Aa</span></button>
        <button className="icon-btn" aria-label="更多" title="更多" onClick={() => setSheet("more")}><Icon name="more" /></button>
      </div>
      <ModeBanner state={state} onScript={() => setSheet("script")} onChallenge={() => setSheet("challenge")} />

      <div className="story-wrap">
        <div className="story" ref={scroller} onScroll={onScroll}>
          <div className="story-inner" style={(gen?.minHeight ?? agentFloor) === undefined ? undefined : { minHeight: gen?.minHeight ?? agentFloor }}>
            {hasMore && <button className="load-more ghost" onClick={loadMore}>加载更早的剧情</button>}
            {shown.map((node) => {
              const isHead = node.id === turn?.id && !busy;
              return (
                <TurnView key={node.id} node={node} onMenu={setMenuNode} onPanel={openPanel} pressed={menuNode?.id === node.id} fresh={fresh === node.id} watch={watch}>{isHead ? <>
                  {isHead && node.status === "interrupted" && (
                    <NoticeCard notice={{ text: `这段没有写完。${notice?.text && !notice.actions.length ? ` ${notice.text}` : ""}`, actions: [{ label: "续写", run: resume }, { label: "重说", run: () => regenerate(null) }] }} onAction={(run) => run()} />
                  )}
                  {isHead && node.status === "no_record" && <p className="muted">这段没能整理出记录，状态可能没有更新。</p>}
                  {isHead && node.kind !== "opening" && node.status !== "interrupted" && (
                    <HeadTools node={node} variants={variants} mouse={mouse} onSwitch={(d) => void switchVariant(d)}
                      onRegen={() => regenerate(null)} onHints={() => setSheet("hints")} onUndo={() => void undo()} onMenu={() => setMenuNode(node)} />
                  )}
                  {isHead && reading.usageLine && node.kind !== "edit" && node.status !== "interrupted" && <TurnUsageLine nodeId={node.id} />}
                  {isHead && notesTip && !pressTip && (
                    <div className="tip">先让 AI 整理一下原著主线？写作时带上札记，每段更快、更省，也更贴原著。<button className="ghost" onClick={() => { dismissNotesTip(); setSheet("notes"); }}>去整理</button><button className="ghost" onClick={dismissNotesTip}>不用</button></div>
                  )}
                  {isHead && pressTip && (
                    <div className="tip">{mouse ? "右键或长按" : "长按"}任意一段，可以改写、回到那里重来、记住这件事或加书签。<button className="ghost" onClick={() => setPressTip(false)}>知道了</button></div>
                  )}
                </> : null}</TurnView>
              );
            })}
            {showChoices && <NextChoices choices={turn!.choices} watch={watch} mouse={mouse}
              onPick={(choice) => send({ mode: watch ? "direct" : "do", text: choice })} onFill={(choice) => { setInput(choice); setModeIndex(0); }} />}
            {gen && <WritingTurn gen={gen} statusText={statusText || ""} waitLine={waitingLine(place, now.hour)} waited={waited} slow={slow} />}
            {notice && !(turn?.status === "interrupted" && !notice.actions.length) && (
              <NoticeCard notice={notice} onAction={(run) => { setNotice(null); run(); }} />
            )}
            {dead && <EndingCard state={state} world={world} now={now.text} turns={nodes.filter((n) => n.kind === "turn").length}
              onLife={() => setSheet("life")}
              onBack={(steps) => { const target = [...nodes].filter((n) => n.kind !== "edit").reverse()[steps]; if (target) void goBack(target); }}
              onLines={() => setSheet("lines")}
              onAgain={() => void again(false)} />}
            {!busy && ends.challenge && ending && (
              <ChallengeEndCard view={ending} onAgain={() => void again(true)} onBack={backOne} onContinue={() => setEndSeen(turn?.id ?? null)} />
            )}
            {!busy && ends.script && state.script && (
              <ScriptEndCard script={state.script}
                onEpilogue={() => { setModeIndex(Math.max(0, modeList.findIndex((m) => m.mode === "direct"))); setInput(EPILOGUE); setEndSeen(turn?.id ?? null); requestAnimationFrame(() => inputBox.current?.focus()); }}
                onContinue={() => setEndSeen(turn?.id ?? null)} onLife={() => setSheet("life")} />
            )}
            {recap && !gen && <RecapCard recap={recap} place={place} time={now.text} onClose={closeRecap} />}
          </div>
        </div>
        {stamp && <StampBurst key={stamp.key} label={stamp.label} sub={stamp.sub} />}
        {!atBottom && <button className={`to-bottom${gen?.text ? " fresh" : ""}`} aria-label={gen?.text ? "下面有新写的内容，回到底部" : "回到底部 ↓"} onClick={() => { follow.current = reading.autoScroll; toBottom(true); }}><Icon name="arrow-down" size={22} /></button>}
      </div>

      <Composer dead={dead} state={state} watch={watch} auto={auto} input={input} typing={typing} mouse={mouse} busy={busy}
        agentBusy={agentBusy} turn={turn} head={head} noteOpen={noteOpen} note={note} mode={mode} modeIndex={modeIndex}
        gen={gen} roomy={roomy} inputBox={inputBox} setInput={setInput} setModeIndex={setModeIndex} setNote={setNote}
        setNoteOpen={setNoteOpen} setTyping={setTyping} onModes={() => setModePicker(true)} onDesk={() => setDesk(true)}
        onPolish={() => openWriting("polish", turn ?? head)} onAutoplay={() => setSheet("autoplay")} onSend={() => send()} onStopOrSend={stopOrSend} />

      {menuNode && <PassageMenu menuNode={menuNode} head={head} busy={busy} setMenuNode={setMenuNode}
        openWriting={openWriting} setRemember={setRemember} goBack={goBack} toast={toast} setMenuMore={setMenuMore} />}
      {menuMore && <PassageMoreMenu menuMore={menuMore} busy={busy} devMode={devMode} game={game} setMenuMore={setMenuMore}
        setEditing={setEditing} refresh={refresh} toast={toast} setBookmark={setBookmark} setCardNode={setCardNode} setRawNode={setRawNode} setUsageNode={setUsageNode} />}
      {writing && <WritingAssist draft={writing} onClose={() => setWriting(null)} onAdopt={adoptWriting} />}
      {desk && <WritingDesk text={input} mode={mode.mode} onClose={() => setDesk(false)} onDone={(text, nextMode) => {
        // 旁观 has only 幕后 and 写: 做 / 说 written in the big box go in as a 幕后 note.
        setInput(text); setModeIndex(Math.max(0, modeList.findIndex((m) => m.mode === nextMode))); setDesk(false); inputBox.current?.focus();
      }} />}
      {remember && <RememberSheet remember={remember} setRemember={setRemember} game={game} worldId={worldId} toast={toast} />}
      {editing && (
        <Sheet title={editing.field === "action" ? "改我的行动" : "改写这段文字"} onClose={() => setEditing(null)}>
          <div className="stack">
            {editing.field === "action" && <p className="muted m-0">会从这一回合之前重新写，原来的内容保留在另一条路线里。</p>}
            {editing.field === "narrative" && <p className="muted m-0">只改这一段的文字，钱物和时间不变；原文随时可以恢复。</p>}
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
          <p className="muted mt-0">
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
      {modePicker && <InputModeSheet watch={watch} modeList={modeList} modeIndex={modeIndex} inputBox={inputBox} noteOpen={noteOpen}
        mode={mode} worldId={worldId} cursor={cursor} setModePicker={setModePicker} setModeIndex={setModeIndex}
        setNoteOpen={setNoteOpen} captureReading={captureReading} push={push} />}
      {sheet === "life" && <LifeSheet world={world} state={state} headId={head.id} dead={dead} onClose={() => setSheet(null)} />}
      {cardNode && <PassageCardSheet world={world} node={cardNode} onClose={() => setCardNode(null)} />}
      {sheet === "keys" && <ShortcutsSheet onClose={() => setSheet(null)} />}
      {sheet === "reading" && <ReadingQuickSheet onClose={() => setSheet(null)} />}
      {sheet === "depth" && <DepthSheet value={depthOf(world.settings)} onChange={(depth) => { void updateSettings({ depth }).then(() => toast(`已换成${DEPTH_LABEL[depth]}档，从下一段起生效`)); }} onClose={() => setSheet(null)} />}
      {sheet === "ask" && <AskSheet worldId={worldId} bookId={state.source?.bookId} onClose={() => setSheet(null)} />}
      {sheet === "skip" && <SkipSheet onClose={() => setSheet(null)} onStart={(text) => { setSheet(null); send({ mode: "skip", text }); }} />}
      {sheet === "hints" && (
        <Sheet title="重说时希望…" onClose={() => setSheet(null)}>
          <div className="segmented">
            {HINTS.map((h) => <button key={h} onClick={() => { setSheet(null); regenerate(h); }}>{h}</button>)}
          </div>
          <HintInput onSubmit={(h) => { setSheet(null); regenerate(h); }} />
        </Sheet>
      )}
      {sheet === "more" && <MoreMenu mouse={mouse} busy={busy} state={state} dead={dead} watch={watch} head={head} cursor={cursor}
        noteOpen={noteOpen} devMode={devMode} game={game} worldId={worldId} setSheet={setSheet} undo={undo} redo={redo}
        setNoteOpen={setNoteOpen} push={push} again={again} setContext={setContext} />}
      {sheet === "time" && (
        <Sheet title="此时此地" onClose={() => setSheet(null)}>
          <dl className="facts">
            {placeName && <><dt>地点</dt><dd>{placeName}</dd></>}
            {timeRows(era.clock, state.time.elapsedMinutes).map((r) => <Fragment key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></Fragment>)}
            {state.protagonist.age != null && <><dt>年龄</dt><dd>{state.protagonist.age} 岁{state.era.mode !== "free" && era.clock.date?.lunar ? "（虚岁，过年长一岁）" : ""}</dd></>}
          </dl>
          <button disabled={busy} onClick={() => setSheet("rules")}>{(world.settings as WritingSettings).mode === "free" ? "修改时间与货币" : "修改纪年与货币"}</button>
        </Sheet>
      )}
      {sheet === "rules" && <RulesSheet worldId={worldId} state={state} era={era} headId={head.id} busy={busy} onClose={() => setSheet(null)} onCorrectDuration={() => setSheet("duration")} onSave={async (patch, summary, expectedHeadId) => { await game.editState(worldId, patch, summary, undefined, expectedHeadId); await refresh(); toast("已保存时间与货币，可在 ⋯ 中撤销"); }} />}
      {sheet === "duration" && <TimeCorrectionSheet worldId={worldId} headId={head.id} busy={busy} onClose={() => setSheet(null)} onSaved={refresh} />}
      {sheet === "reference" && state.source && <ReferenceSheet worldId={worldId} binding={state.source} onClose={() => setSheet(null)} />}
      {sheet === "usage" && <WorldUsageSheet worldId={worldId} onClose={() => setSheet(null)} />}
      {usageNode && <PassageUsageSheet nodeId={usageNode} onClose={() => setUsageNode(null)} />}
      {sheet === "notes" && state.source && <CanonNotesSheet bookId={state.source.bookId} worldId={worldId} position={state.source.position} onClose={() => setSheet(null)} />}
      {sheet === "toc" && <TocSheet worldId={worldId} headId={head.id} state={state} clock={era.clock} onClose={() => setSheet(null)}
        onJump={(nodeId) => { closeRecap(); void scrollToNode(nodeId); }}
        onBookmark={(line) => void tree.jumpTo(game.repo, worldId, line.nodeId, `从书签“${line.name}”继续`).then(async () => { await refresh(); toast(`已回到书签“${line.name}”`); })} />}
      {sheet === "lines" && <LinesSheet worldId={worldId} current={cursor.line.id} onClose={() => setSheet(null)} onChanged={(message) => { void refresh(); toast(message); }} />}
      {bookmark && <BookmarkSheet initial={bookmark.name} onClose={() => setBookmark(null)} onSave={(name) => {
        const node = bookmark.node;
        setBookmark(null);
        void tree.addBookmark(game.repo, worldId, node.id, name).then(() => toast("已加书签，在“世界线”里能找到"));
      }} />}
      {sheet === "story" && <StorySheet world={world} headId={head.id} onSave={async (p) => { await updateSettings(p); setSheet(null); toast("已保存，从下一段开始生效"); }} onClose={() => setSheet(null)} />}
      {sheet === "settings" && <WorldSettingsSheet world={world} state={state} busy={busy} onChange={updateSettings} onPanelSave={async (text) => {
        // The ledger agent supplies profile.panel; the content belongs to this branch's snapshot.
        const patch: TurnRecord & { profile: { panel: string } } = { profile: { panel: text.slice(0, 2000) } };
        await game.editState(worldId, patch, "主角面板"); await refresh();
      }} onPilot={(pilot) => { void updateSettings({ pilot }); toast(pilot === "ai" ? "主角交给 AI 了，你在幕后指点" : "主角由你来演了"); }}
        onScript={() => setSheet("script")} onChallenge={() => setSheet("challenge")} onRules={() => setSheet("rules")} onSourceSave={async (source) => { await game.bindSource(worldId, source); await refresh(); }} onClose={() => setSheet(null)} />}
      {sheet === "script" && <ScriptSheet state={state} busy={busy} onClose={() => setSheet(null)}
        onSave={(script: Script | null, summary) => saveMode({ scriptSet: script }, summary)} />}
      {sheet === "challenge" && <ChallengeSheet state={state} busy={busy} onClose={() => setSheet(null)}
        onSave={(challenge: Challenge | null, summary) => saveMode({ challengeSet: challenge }, summary)} />}
      {sheet === "autoplay" && <AutoplaySheet temporary={!watch} onClose={() => setSheet(null)} onStart={(n) => { setSheet(null); startAutoplay(n); }} />}
      {panel && !wide && <Panel {...panelProps} />}
      {notifications.sheet}
    </div>
    {wide && <div className="play-side"><Panel {...panelProps} docked /></div>}
    </div>
  );
}
