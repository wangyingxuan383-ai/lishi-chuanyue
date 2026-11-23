// One writer at a time on the play screen: starting, following, failing and
// resuming a passage (or a 连播 sequence). Everything that used to be copied
// into send / regenerate / resume / resumeExecution / startAutoplay starts
// here through `start`, so they all reserve space, reset the timers and set
// up 再试一次 the same way (R28-T006).
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AutoplayEvent, AutoplayHandle, FailReason, SavedExecution, TurnEvent, TurnHandle } from "../../../engine/game";
import type { Game } from "../../../engine/game";
import type { Failure } from "../../../platform";
import { explainFailure } from "../../../engine/llm/providers";
import type { ActionMode, StoryNode } from "../../../engine/types";
import type { AppValue } from "../../app/context";
import { buzz } from "../../app/motion";
import type { Gen } from "./types";

export type Restore = { mode: ActionMode; text: string; note: string };
export type NoticeAction = { label: string; run: () => void; keepNotice?: boolean };
export type Notice = { text: string; actions: NoticeAction[]; runId?: string; failure?: Failure; failures?: Failure[]; reason?: FailReason; detail?: string; partialText?: string; proseSaved?: boolean; restore?: Restore };
type SavedRun = Pick<SavedExecution, "id" | "status" | "error"> & Partial<SavedExecution>;

function hasRestoreWords(r?: Restore | null): r is Restore {
  return !!r && !!(r.text.trim() || r.note.trim());
}

function restoreFromSaved(run?: SavedRun): Restore | null {
  // Only an unsent `turn` belongs in the input box; `variant` (重说) and `continue` (续写)
  // carry an already-committed passage's action and must never pollute Composer (B02).
  if (run?.kind && run.kind !== "turn") return null;
  const a = run?.action;
  if (!a) return null;
  const text = a.text?.trim() ? a.text : "";
  const note = a.directorNote?.trim() ? a.directorNote : "";
  if (!text && !note) return null;
  if ((a.mode === "continue" || a.mode === "skip") && !note) return null;
  return { mode: a.mode, text, note };
}

function toolProgressLabel(tool: string): string {
  if (/original|section|reference/i.test(tool)) return "正在翻查原著…";
  if (/canon_note|canon_fact/i.test(tool)) return "正在核对札记…";
  return "正在查阅前情…";
}

function organizingProgressLabel(phase?: string): string {
  switch (phase) {
    case "extract": return "正在整理记录…";
    case "reference-review": case "reference-review-lite": return "正在核对原著一致…";
    case "upkeep": case "codex": return "正在整理设定集…";
    case "chapter": return "正在整理章节摘要…";
    default: return "整理中…";
  }
}

/**
 * What the player can do about a failure (R30, D166): one main action per kind,
 * never a generic button that replays the same failure.
 * - continue: the saved run goes on (nothing was lost; a failed request is sent again);
 * - redo: the stage the model's answer broke is asked again (the passage, or only its record);
 * - fresh: the same action is written anew with what is set now;
 * - settings / wait: nothing to retry until something else changes.
 */
export function failurePlan(reason: FailReason, hasRun: boolean): { main: "continue" | "redo" | "fresh" | "settings" | "wait"; label: string; switchService: boolean } {
  switch (reason) {
    case "network": case "timeout": case "stream": case "system_stop": case "interrupted": case "limit": case "cancelled":
      return { main: hasRun ? "continue" : "fresh", label: hasRun ? "接着写完" : "再试一次", switchService: false };
    case "http": case "storage": case "other":
      return { main: hasRun ? "continue" : "fresh", label: "再试一次", switchService: false };
    case "quota":
      return { main: hasRun ? "continue" : "fresh", label: "再试一次", switchService: true };
    case "refused": case "empty":
      return { main: hasRun ? "redo" : "fresh", label: "重新写这一段", switchService: reason === "refused" };
    case "format": case "review": case "settle":
      return { main: hasRun ? "redo" : "fresh", label: reason === "settle" ? "重新写这一段" : "重试这一步", switchService: false };
    case "stale": case "context":
      return { main: "fresh", label: "按现在的情况重写", switchService: false };
    case "busy":
      return { main: "wait", label: "等它结束再写", switchService: false };
    case "auth": case "setup":
      return { main: "settings", label: "去设置", switchService: false };
    case "unsupported":
      return { main: "settings", label: "换个模型", switchService: false };
  }
}

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
  restoreDraft: (restore: Restore, force?: boolean) => void;
  /** Clears an auto-restored draft right before NoticeCard retries that exact saved run. */
  clearRestoredDraft?: (restore: Restore) => void;
  /** A passage was written. */
  onDone: (node: StoryNode) => void;
  /** Anything else holding the story (the assistant, a request in flight). */
  isBusy: () => boolean;
  toast: AppValue["toast"];
  push: AppValue["push"];
  profileId?: string;
  resumeRunId?: string;
}

export function useGeneration(d: GenerationDeps) {
  const [gen, setGen] = useState<Gen | null>(null);
  /** 连播 under way (旁观): which step of how many; between two steps nothing is generating, but the player still waits. */
  const [auto, setAuto] = useState<{ step: number; total: number; runId?: string; activeNote?: string | null } | null>(null);
  /** One message under the story at a time (AUDIT 5.1): what happened, and what to do now. */
  const [notice, setNotice] = useState<Notice | null>(null);
  /** No new words for a while: say it is still being written (AUDIT 5.5). */
  const [slow, setSlow] = useState(false);
  /** Seconds since this passage started, for the waiting line (R28). */
  const [waited, setWaited] = useState(0);
  const [executionStatus, setExecutionStatus] = useState("");
  const handle = useRef<TurnHandle | null>(null);
  const autoHandle = useRef<AutoplayHandle | null>(null);
  const resumedAutoplay = useRef(false);
  const failures = useRef(0);
  /** Does the last request again, for “再试一次”. */
  const retry = useRef<(() => void) | null>(null);
  const lastWords = useRef(0);
  const streamedText = useRef("");
  const reachedOrganizing = useRef(false);
  const savedActions = useRef<Map<string, Restore>>(new Map());
  const savedKinds = useRef<Map<string, string>>(new Map());
  const screenActive = useRef(true);
  const recoveryNoticeVersion = useRef(0);
  const deps = useRef(d);
  deps.current = d;

  const hasStreamText = !!gen?.text;
  useEffect(() => {
    if (!gen) { setSlow(false); setWaited(0); return; }
    const started = Date.now();
    if (!hasStreamText) setWaited(0);
    // Once prose starts streaming, stop ticking `waited` every second to avoid
    // unnecessary Play tree re-renders; only monitor stalled streams (`slow`).
    const id = setInterval(() => {
      const stalled = Date.now() - lastWords.current > 8000;
      setSlow((prev) => (prev === stalled ? prev : stalled));
      if (!hasStreamText) setWaited(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [!!gen, hasStreamText]);

  // Page came back from the background or received a foreground notification tap: replay cached stream events.
  useEffect(() => {
    const catchUp = () => {
      void handle.current?.catchUp();
      void autoHandle.current?.catchUp();
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      catchUp();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("lishi:catch-up", catchUp);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("lishi:catch-up", catchUp);
    };
  }, []);

  /** The shared beginning of every passage: clear the notice, reset the timers, reserve space. */
  const begin = (g: Omit<Gen, "minHeight" | "phase">) => {
    recoveryNoticeVersion.current++;
    setNotice(null);
    setExecutionStatus("");
    streamedText.current = g.text ?? "";
    reachedOrganizing.current = false;
    deps.current.follow.current = deps.current.autoScroll;
    lastWords.current = Date.now();
    setSlow(false);
    setGen({ phase: "starting", minHeight: deps.current.streamFloor(), ...g });
  };
  /** A 连播 step started (new or followed). */
  const stepStarted = (index: number, total: number, runId?: string, directorNote?: string) => {
    const cleanNote = directorNote?.trim() || undefined;
    setAuto((prev) => ({
      step: index,
      total,
      runId: runId ?? prev?.runId,
      activeNote: cleanNote ?? null,
    }));
    const stepAction = cleanNote
      ? ({ mode: "continue" as ActionMode, text: "", directorNote: cleanNote } as Gen["action"])
      : null;
    begin({ text: "", action: stepAction, variant: false });
  };

  const onEvent = (restore: Restore | null) => (e: TurnEvent | AutoplayEvent) => {
    if (!screenActive.current) return;
    const { game, refresh, showSaved } = deps.current;
    if (e.type === "step") { resumedAutoplay.current = true; stepStarted(e.index, e.total, e.runId, e.directorNote); }
    else if (e.type === "finished") { resumedAutoplay.current = false; streamedText.current = ""; reachedOrganizing.current = false; setAuto(null); setGen(null); setExecutionStatus(""); handle.current = null; void refresh(); }
    else if (e.type === "execution-status") setExecutionStatus({
      reconnecting: "正在重新读取生成进度…", connected: "", "stop-requested": "已收到停止请求，正在收尾…",
      "stop-unconfirmed": "还没确认停止，正在重试连接…",
    }[e.state]);
    else if (e.type === "thinking") setGen((g) => g && { ...g, phase: "thinking", detail: e.deep ? "深度思考中…" : "构思中…" });
    else if (e.type === "tool") setGen((g) => g && { ...g, phase: "thinking", detail: toolProgressLabel(e.tool) });
    else if (e.type === "text") { lastWords.current = Date.now(); streamedText.current = e.full; setSlow(false); setGen((g) => g && { ...g, phase: "writing", detail: undefined, text: e.full }); }
    else if (e.type === "organizing") { reachedOrganizing.current = true; setGen((g) => g && { ...g, phase: "organizing", detail: organizingProgressLabel(e.phase) }); }
    // 备用服务 (D179): say it once; the passage keeps going on the backup.
    else if (e.type === "fallback") deps.current.toast(e.to ? `主服务出错，这段改由备用服务（${e.to}）接着写` : "主服务出错，这段改由备用服务接着写");
    else if (e.type === "done") {
      showSaved(e.node);
      streamedText.current = "";
      reachedOrganizing.current = false;
      setExecutionStatus("");
      setGen(null);
      if (!resumedAutoplay.current) handle.current = null;
      failures.current = 0;
      buzz(game.platform);
      void refresh();
      deps.current.onDone(e.node);
    } else if (e.type === "failed") {
      const partialText = streamedText.current.trim() || undefined;
      const proseSaved = reachedOrganizing.current;
      const keptRestore = hasRestoreWords(restore)
        ? restore
        : (e.runId ? savedActions.current.get(e.runId) ?? null : null);
      if (e.runId && keptRestore) savedActions.current.set(e.runId, keptRestore);
      streamedText.current = "";
      reachedOrganizing.current = false;
      resumedAutoplay.current = false;
      setAuto(null);
      handle.current = null;
      setGen(null);
      setExecutionStatus("");
      // Restore the player's prompt back into an empty input box whenever the turn errored before
      // prose was saved (or cannot resume in place), so tapping 发送/继续 never loses their input.
      const nonResumable = ["setup", "auth", "unsupported", "stale", "context"].includes(e.reason);
      if (keptRestore && (!e.runId || nonResumable || (!proseSaved && e.reason !== "cancelled"))) {
        deps.current.restoreDraft(keptRestore, false);
      }
      if (e.reason !== "cancelled" && e.reason !== "limit") { failures.current++; buzz(game.platform); }
      setNotice(failureNotice({ reason: e.reason, status: e.status, detail: e.detail, runId: e.runId, failure: e.failure, failures: e.failures, partialText, proseSaved, restore: keptRestore ?? undefined }));
    }
  };

  /** The notice for a stopped passage: one sentence, its main action, and the record behind “查看原因”. */
  const failureNotice = (f: { reason: FailReason; status?: number; detail?: string; runId?: string; failure?: Failure; failures?: Failure[]; saved?: SavedRun; partialText?: string; proseSaved?: boolean; restore?: Restore }): Notice => {
    const { push, profileId } = deps.current;
    const plan = failurePlan(f.reason, !!f.runId);
    const actions: Notice["actions"] = [];
    const again = retry.current;
    if (plan.main === "settings") actions.push({ label: plan.label, run: () => push({ name: f.reason === "unsupported" ? "settings" : "setup", profileId }) });
    else if (plan.main === "wait") {
      const until = f.failure?.untilMs ?? 0;
      if (again) actions.push({ label: plan.label, run: () => {
        const version = ++recoveryNoticeVersion.current;
        const delay = Math.min(Math.max(until - Date.now(), 0), 45_000);
        setNotice({ text: "等这个故事空出来就写…", actions: [] });
        setTimeout(() => {
          if (screenActive.current && recoveryNoticeVersion.current === version && !handle.current && !autoHandle.current && !deps.current.isBusy()) again();
        }, delay + 300);
      } });
    } else if ((plan.main === "continue" || plan.main === "redo") && f.runId) {
      const id = f.runId;
      actions.push({ label: plan.label, run: () => retryExecution(id) });
    } else if (plan.main === "fresh") {
      if (f.runId) { const id = f.runId; actions.push({ label: plan.label, run: () => retryExecution(id) }); }
      else if (again) actions.push({ label: plan.label, run: again });
    }
    const kept = hasRestoreWords(f.restore) ? f.restore : null;
    if (kept) actions.push({ label: "放回输入框", keepNotice: true, run: () => { deps.current.restoreDraft(kept, true); deps.current.toast("已放回输入框"); } });
    if (plan.switchService || failures.current >= 2) actions.push({ label: "换个服务", keepNotice: true, run: () => push({ name: "settings" }) });
    // The HTTP status lives in the failure record: 500 and 400 read differently.
    const partialText = f.partialText?.trim() || undefined;
    const proseSaved = !!f.proseSaved;
    return {
      text: noticeText(f.reason, f.status ?? f.failure?.status, f.saved, proseSaved, !!partialText),
      actions,
      reason: f.reason,
      ...(f.runId ? { runId: f.runId } : {}),
      ...(f.detail ? { detail: f.detail } : {}),
      ...(f.failure ? { failure: f.failure } : {}),
      ...(f.failures?.length ? { failures: f.failures } : {}),
      ...(partialText ? { partialText, proseSaved } : proseSaved ? { proseSaved } : {}),
      ...(kept ? { restore: kept } : {}),
    };
  };

  /** Starts one passage. `run` gets the event handler and returns the engine's handle. */
  const start = (o: { action: Gen["action"]; text?: string; variant?: boolean; retry: () => void; restore?: Restore | null; run: (on: (e: TurnEvent) => void) => TurnHandle }) => {
    retry.current = o.retry;
    const isVariant = !!o.variant;
    begin({ text: o.text ?? "", action: o.action, variant: isVariant });
    handle.current = o.run((e) => {
      if (isVariant && e.type === "failed" && e.runId) savedKinds.current.set(e.runId, "variant");
      onEvent(o.restore ?? null)(e);
    });
  };

  /** Follows a run still being written (also one started before the page opened). */
  const resumeExecution = (id: string, resume = false, saved?: SavedRun) => {
    if (!screenActive.current || handle.current || deps.current.isBusy()) return;
    recoveryNoticeVersion.current++;
    if (saved?.kind) savedKinds.current.set(id, saved.kind);
    const kind = saved?.kind ?? savedKinds.current.get(id);
    const kept = restoreFromSaved(saved) ?? savedActions.current.get(id) ?? null;
    if (kept) savedActions.current.set(id, kept);
    start({
      action: kept?.text.trim() ? { mode: kept.mode, text: kept.text } : null,
      variant: kind === "variant",
      restore: kept,
      retry: () => retryExecution(id),
      run: (on) => deps.current.game.followExecution(id, on, resume),
    });
  };
  /** Tries a stopped run again: continued, asked again from the failed stage, or rebuilt (D166). */
  const retryExecution = (id: string) => {
    if (!screenActive.current || handle.current || deps.current.isBusy()) return;
    recoveryNoticeVersion.current++;
    const kind = savedKinds.current.get(id);
    const kept = savedActions.current.get(id) ?? null;
    if (kept) deps.current.clearRestoredDraft?.(kept);
    start({
      action: kept?.text.trim() ? { mode: kept.mode, text: kept.text } : null,
      variant: kind === "variant",
      restore: kept,
      retry: () => retryExecution(id),
      run: (on) => deps.current.game.retryRun(id, on),
    });
  };
  /** Reopening the story after a stop: the same notice the failure gave, never a request by itself. */
  const showSavedExecution = (run: SavedRun) => {
    if (run.kind) savedKinds.current.set(run.id, run.kind);
    const reason = run.reason ?? (run.status === "paused" ? "limit" : run.status === "cancelled" ? "cancelled" : run.status === "interrupted" ? "interrupted" : "other");
    const kept = restoreFromSaved(run);
    if (kept) {
      savedActions.current.set(run.id, kept);
      if (run.status === "failed" && !run.proseSaved) deps.current.restoreDraft(kept, false);
    }
    setNotice(failureNotice({ reason, detail: run.error ?? undefined, runId: run.id, failure: run.failure ?? undefined, saved: run, partialText: run.partialText, proseSaved: run.proseSaved, restore: kept ?? undefined }));
  };

  // Opening the story: show it, then follow a run still being written (also one
  // started before the player left the page), or say what happened to the last one.
  useEffect(() => {
    let disposed = false;
    screenActive.current = true;
    void (async () => {
      await deps.current.refresh();
      if (deps.current.resumeRunId) return;
      const run = await deps.current.game.currentExecution(deps.current.worldId);
      if (disposed || !run || handle.current || deps.current.isBusy()) return;
      // A passage still being written is followed; an interrupted one costs a
      // request to continue, so the player decides (R30).
      if (["running", "committing"].includes(run.status)) resumeExecution(run.id, false, run);
      else if (["cancelled", "failed", "paused", "interrupted"].includes(run.status)) showSavedExecution(run);
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

  useEffect(() => {
    if (!d.resumeRunId) return;
    let disposed = false;
    const version = recoveryNoticeVersion.current;
    void d.game.currentExecution(d.worldId, d.resumeRunId).then((run) => {
      if (disposed || recoveryNoticeVersion.current !== version || handle.current || autoHandle.current || deps.current.isBusy()) return;
      // Already finished, retried or cleaned up: the story itself shows where things stand.
      if (!run) return;
      if (["running", "committing"].includes(run.status)) resumeExecution(run.id, false, run);
      else showSavedExecution(run);
    }).catch(() => {
      if (!disposed && recoveryNoticeVersion.current === version) setNotice({ text: "暂时没能读取那段的进度。故事里看得到的内容都已保存；没写完的话可以点“续写”或重说。", actions: [] });
    });
    return () => { disposed = true; };
  }, [d.game, d.worldId, d.resumeRunId]);

  /**
   * 连播 (旁观): ordinary “继续” passages one after another. Each step streams
   * like a normal turn; between steps the dock still says 连播 n/m with 停止.
   */
  const startAutoplay = (turns: number) => {
    const { game, worldId, toast, refresh } = deps.current;
    let played = 0;
    retry.current = () => startAutoplay(Math.max(1, turns - played));
    setNotice(null);
    streamedText.current = "";
    reachedOrganizing.current = false;
    setGen(null);
    deps.current.follow.current = deps.current.autoScroll;
    setAuto({ step: 0, total: turns, activeNote: null });
    const forward = onEvent(null);
    autoHandle.current = game.autoplay(worldId, { turns }, (e: AutoplayEvent) => {
      if (!screenActive.current) return;
      if (e.type === "step") stepStarted(e.index, e.total, e.runId, e.directorNote);
      else if (e.type === "finished") {
        autoHandle.current = null;
        streamedText.current = "";
        reachedOrganizing.current = false;
        setAuto(null);
        setGen(null);
        void refresh();
        if (e.reason === "count") toast(`连播了 ${e.steps} 段`);
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
    gen, setGen, auto, notice, setNotice, slow, waited, executionStatus,
    start, startAutoplay, resumeExecution, retryExecution, stop,
    /** True while a request of this page is in flight (a ref, so it is current inside callbacks). */
    inFlight: () => !!handle.current || !!autoHandle.current,
  };
}

/** One sentence for the notice: what happened, in the player's words; the cause is behind “查看原因”. */
function noticeText(reason: FailReason, status?: number, saved?: SavedRun, proseSaved = false, hasPartial = false): string {
  const base = reason === "cancelled"
    ? (proseSaved
        ? "已停止，正文已保留；点“接着写完”会直接补记，不会重写正文。"
        : hasPartial
          ? "已停止，正文写到一半断开；上方保留了已收到的内容供参考，续跑会重新生成本段。"
          : "已停止，已查到的资料与进度已保留。")
    : explainFailure(reason, status);
  const stageHint = reason !== "cancelled" && reason !== "busy" && reason !== "stale" && reason !== "auth" && reason !== "setup"
    ? (proseSaved ? " 正文已保留，续跑会直接补记。" : hasPartial ? " 正文写到一半断开，续跑会重新生成本段。" : "")
    : "";
  if (saved?.kind === "autoplay" && reason !== "busy") return `${base}${stageHint} 连播已完成 ${saved.steps ?? 0}/${saved.total ?? 0} 段。`;
  return `${base}${stageHint}`;
}
