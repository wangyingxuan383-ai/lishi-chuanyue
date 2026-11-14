// One writer at a time on the play screen: starting, following, failing and
// resuming a passage (or a 连播 sequence). Everything that used to be copied
// into send / regenerate / resume / resumeExecution / startAutoplay starts
// here through `start`, so they all reserve space, reset the timers and set
// up 再试一次 the same way (R28-T006).
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AutoplayEvent, AutoplayHandle, TurnEvent, TurnHandle } from "../../../engine/game";
import type { Game } from "../../../engine/game";
import { explainFailure } from "../../../engine/llm/providers";
import type { ActionMode, StoryNode } from "../../../engine/types";
import type { AppValue } from "../../app/context";
import { buzz } from "../../app/motion";
import type { Gen } from "./types";

export type Restore = { mode: ActionMode; text: string; note: string };
export type Notice = { text: string; actions: { label: string; run: () => void }[] };
type SavedRun = { id: string; status: string; error: string | null; kind?: string; steps?: number; total?: number; hasText?: boolean };

export interface GenerationDeps {
  game: Game;
  worldId: string;
  autoScroll: boolean;
  /** Following new text, shared with the reading position. */
  follow: MutableRefObject<boolean>;
  refresh: () => Promise<void>;
  /** Puts a saved passage on screen in the same render that removes its stream. */
  showSaved: (node: StoryNode) => void;
  /** Height to keep while the dock folds away (null when it cannot be measured). */
  streamFloor: () => number | undefined;
  /** Gives a failed action back to the input box. */
  restoreDraft: (restore: Restore) => void;
  /** A passage was written. */
  onDone: (node: StoryNode) => void;
  /** Anything else holding the story (the assistant, a request in flight). */
  isBusy: () => boolean;
  toast: AppValue["toast"];
  push: AppValue["push"];
  profileId?: string;
}

export function useGeneration(d: GenerationDeps) {
  const [gen, setGen] = useState<Gen | null>(null);
  /** 连播 under way (旁观): which step of how many; between two steps nothing is generating, but the player still waits. */
  const [auto, setAuto] = useState<{ step: number; total: number } | null>(null);
  /** One message under the story at a time (AUDIT 5.1): what happened, and what to do now. */
  const [notice, setNotice] = useState<Notice | null>(null);
  /** No new words for a while: say it is still being written (AUDIT 5.5). */
  const [slow, setSlow] = useState(false);
  /** Seconds since this passage started, for the waiting line (R28). */
  const [waited, setWaited] = useState(0);
  const handle = useRef<TurnHandle | null>(null);
  const autoHandle = useRef<AutoplayHandle | null>(null);
  const resumedAutoplay = useRef(false);
  const failures = useRef(0);
  /** Does the last request again, for “再试一次”. */
  const retry = useRef<(() => void) | null>(null);
  const lastWords = useRef(0);
  const screenActive = useRef(true);
  const recoveryNoticeVersion = useRef(0);
  const deps = useRef(d);
  deps.current = d;

  useEffect(() => {
    if (!gen) { setSlow(false); setWaited(0); return; }
    const started = Date.now();
    setWaited(0);
    const id = setInterval(() => { setSlow(Date.now() - lastWords.current > 8000); setWaited(Math.floor((Date.now() - started) / 1000)); }, 1000);
    return () => clearInterval(id);
  }, [!!gen]);

  // Page came back from the background: replay what the stream cached meanwhile.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void handle.current?.catchUp();
      void autoHandle.current?.catchUp();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  /** The shared beginning of every passage: clear the notice, reset the timers, reserve space. */
  const begin = (g: Omit<Gen, "minHeight" | "phase">) => {
    setNotice(null);
    deps.current.follow.current = deps.current.autoScroll;
    lastWords.current = Date.now();
    setSlow(false);
    setGen({ phase: "starting", minHeight: deps.current.streamFloor(), ...g });
  };
  /** A 连播 step started (new or followed). */
  const stepStarted = (index: number, total: number) => {
    setAuto({ step: index, total });
    begin({ text: "", action: null, variant: false });
  };

  const onEvent = (restore: Restore | null) => (e: TurnEvent | AutoplayEvent) => {
    if (!screenActive.current) return;
    const { game, refresh, showSaved, push, profileId } = deps.current;
    if (e.type === "step") { resumedAutoplay.current = true; stepStarted(e.index, e.total); }
    else if (e.type === "finished") { resumedAutoplay.current = false; setAuto(null); setGen(null); handle.current = null; void refresh(); }
    else if (e.type === "thinking") setGen((g) => g && { ...g, phase: "thinking" });
    else if (e.type === "text") { lastWords.current = Date.now(); setSlow(false); setGen((g) => g && { ...g, phase: "writing", text: e.full }); }
    else if (e.type === "organizing") setGen((g) => g && { ...g, phase: "organizing" });
    else if (e.type === "done") {
      showSaved(e.node);
      setGen(null);
      if (!resumedAutoplay.current) handle.current = null;
      failures.current = 0;
      buzz(game.platform);
      void refresh();
      deps.current.onDone(e.node);
    } else if (e.type === "failed") {
      resumedAutoplay.current = false;
      setAuto(null);
      handle.current = null;
      if (e.partialSaved) {
        if (e.node || e.cursor) { showSaved(e.node ?? e.cursor!.head); setGen(null); }
        else void refresh().then(() => setGen(null));
        // The interrupted passage shows its own 续写 / 重说; here only why it stopped.
        void refresh();
        if (e.reason !== "cancelled") setNotice({ text: `${e.detail ?? explainFailure(e.reason, e.status)} 已写出的部分保留了。`, actions: [] });
        return;
      }
      setGen(null);
      // A paused run still holds the action; giving it back would invite sending it twice.
      if (restore && e.reason !== "limit") deps.current.restoreDraft(restore);
      if (e.reason === "cancelled") { if (e.runId) void inspectSavedExecution(e.detail, e.runId); return; }
      // Paused at its allowance: offer to continue that run (not a new one), via the saved run.
      if (e.reason === "limit") {
        setNotice({ text: explainFailure("limit"), actions: e.runId ? [{ label: "接着写完", run: () => resumeExecution(e.runId!, true) }] : [] });
        if (e.runId) void inspectSavedExecution(e.detail, e.runId);
        return;
      }
      failures.current++;
      buzz(game.platform);
      const actions: Notice["actions"] = [];
      if (e.reason === "config" || e.reason === "auth") actions.push({ label: "去设置", run: () => push({ name: "setup", profileId }) });
      else {
        if (retry.current) { const again = retry.current; actions.push({ label: e.reason === "refused" ? "原样再试" : "再试一次", run: again }); }
        if (failures.current >= 2 || e.reason === "quota" || e.reason === "refused") actions.push({ label: "换个服务", run: () => push({ name: "settings" }) });
      }
      setNotice({ text: e.detail ?? explainFailure(e.reason, e.status), actions });
      if (e.runId) void inspectSavedExecution(e.detail, e.runId);
    }
  };

  /** Starts one passage. `run` gets the event handler and returns the engine's handle. */
  const start = (o: { action: Gen["action"]; text?: string; variant?: boolean; retry: () => void; restore?: Restore | null; run: (on: (e: TurnEvent) => void) => TurnHandle }) => {
    retry.current = o.retry;
    begin({ text: o.text ?? "", action: o.action, variant: !!o.variant });
    handle.current = o.run(onEvent(o.restore ?? null));
  };

  const resumeExecution = (id: string, resume = false) => {
    if (!screenActive.current || handle.current || deps.current.isBusy()) return;
    recoveryNoticeVersion.current++;
    start({ action: null, retry: () => resumeExecution(id, true), run: (on) => deps.current.game.followExecution(id, on, resume) });
  };
  const showSavedExecution = (run: SavedRun, fallback?: string) => {
    const detail = run.error?.trim() || fallback?.trim() || (run.status === "paused" ? "这段写得比较久，已先停下，进度已保存" : "");
    const saved = run.kind === "autoplay" ? `连播已完成 ${run.steps ?? 0}/${run.total ?? 0} 段。` : "上次生成的进度已保存。";
    const text = detail ? `${detail}${/[。！？]$/.test(detail) ? "" : "。"}${detail.includes("进度已保存") ? "" : ` ${saved}`}` : saved;
    // Opening the page never starts a request by itself. A paused run (its allowance
    // used) continues only when the player asks, with the same allowance again (D159).
    const label = run.kind === "autoplay" ? run.hasText ? "续写并继续连播" : "重试剩余连播" : run.status === "paused" ? "接着写完" : "继续上次生成";
    setNotice({ text, actions: [{ label, run: () => resumeExecution(run.id, true) }] });
  };
  const inspectSavedExecution = async (fallback?: string, expectedId?: string) => {
    const version = ++recoveryNoticeVersion.current;
    try {
      const run = await deps.current.game.currentExecution(deps.current.worldId);
      if (!run || (expectedId && run.id !== expectedId) || !screenActive.current || handle.current || version !== recoveryNoticeVersion.current) return;
      if (["cancelled", "failed", "paused"].includes(run.status)) showSavedExecution(run, fallback);
    } catch { /* The existing failure notice remains available. */ }
  };

  // Opening the story: show it, then follow a run still being written (also one
  // started before the player left the page), or say what happened to the last one.
  useEffect(() => {
    let disposed = false;
    screenActive.current = true;
    void (async () => {
      await deps.current.refresh();
      const run = await deps.current.game.currentExecution(deps.current.worldId);
      if (disposed || !run || handle.current || deps.current.isBusy()) return;
      if (["running", "committing", "interrupted"].includes(run.status)) resumeExecution(run.id, run.status === "interrupted");
      else if (["cancelled", "failed", "paused"].includes(run.status)) showSavedExecution(run);
    })().catch(() => {
      if (!disposed) setNotice({ text: "暂时没能读取上次生成的进度，请稍后重新打开故事。", actions: [] });
    });
    return () => {
      disposed = true;
      screenActive.current = false;
      recoveryNoticeVersion.current++;
      // Leaving the page does not stop the native run; it keeps writing (D160).
      handle.current?.detach?.();
      autoHandle.current?.detach?.();
      handle.current = null;
      autoHandle.current = null;
    };
  }, [d.game, d.worldId, d.refresh]);

  /**
   * 连播 (旁观): ordinary “继续” passages one after another. Each step streams
   * like a normal turn; between steps the dock still says 连播 n/m with 停止.
   */
  const startAutoplay = (turns: number) => {
    const { game, worldId, toast, refresh } = deps.current;
    let played = 0;
    retry.current = () => startAutoplay(Math.max(1, turns - played));
    setNotice(null);
    deps.current.follow.current = deps.current.autoScroll;
    setAuto({ step: 0, total: turns });
    const forward = onEvent(null);
    autoHandle.current = game.autoplay(worldId, { turns }, (e: AutoplayEvent) => {
      if (!screenActive.current) return;
      if (e.type === "step") stepStarted(e.index, e.total);
      else if (e.type === "finished") {
        autoHandle.current = null;
        setAuto(null);
        setGen(null);
        void refresh();
        if (e.reason === "count") toast(`连播了 ${e.steps} 段`);
        else if (e.reason === "busy") toast("正在写，稍后再连播");
        else if (e.reason === "player") toast("主角由你来演时不能连播");
      } else {
        if (e.type === "done") played++;
        forward(e);
      }
    });
  };

  /** 停止: the 连播 sequence, or the passage being written. */
  const stop = () => {
    if (auto && autoHandle.current) autoHandle.current.stop();
    else handle.current?.stop();
  };

  return {
    gen, setGen, auto, notice, setNotice, slow, waited,
    start, startAutoplay, resumeExecution, stop,
    /** True while a request of this page is in flight (a ref, so it is current inside callbacks). */
    inFlight: () => !!handle.current || !!autoHandle.current,
  };
}
