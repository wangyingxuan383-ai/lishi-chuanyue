// External control for Pi's public session.compact(). It never generates its
// own summary, rewrites messages or retries an interrupted story operation.
import { AsyncLocalStorage } from "node:async_hooks";

function failure(code, compacted = false) {
  const messages = {
    manual_compact_busy: "正在整理上下文，请等整理结束后再执行新要求",
    manual_compact_reentrant: "不能在回合收尾中等待整理上下文，请从独立控制入口发起",
    manual_compact_unavailable: "当前助手会话尚未准备好，未开始整理上下文",
    manual_compact_session_changed: "助手会话已经变化，未整理原会话",
    manual_compact_not_idle: "当前执行尚未停止，未开始整理上下文",
    manual_compact_finalize_failed: compacted
      ? "Pi已完成整理，但本机任务记录的收尾尚未确认，请先检查任务状态"
      : "整理未完成，本机任务记录的收尾尚未确认",
  };
  const error = new Error(messages[code]);
  error.code = code;
  if (code === "manual_compact_finalize_failed") error.details = { compacted };
  return error;
}

export function createManualCompactControl({
  getSession,
  isRunning,
  waitForIdle = session => session.waitForIdle(),
  abort = session => session.abort(),
  assertAvailable = () => {},
  beforeCompact = () => {},
  afterCompact = () => {},
}) {
  if (typeof getSession !== "function") throw failure("manual_compact_unavailable");
  const boundary = new AsyncLocalStorage();
  let active = false;

  const control = {
    get active() { return active; },
    // Call at the entry to prompt/continue/model switch, before any await.
    assertCanPrompt() { if (active) throw failure("manual_compact_busy"); },
    // Root's existing public finishTurn hook must run inside this boundary.
    // Waiting for idle from a listener that the same run is awaiting forms a
    // cycle; reject that origin immediately instead of scheduling another loop.
    withTurnBoundary(operation) { return boundary.run(true, operation); },
    async compact(instructions) {
      if (boundary.getStore()) throw failure("manual_compact_reentrant");
      if (active) throw failure("manual_compact_busy");
      if (instructions !== undefined && typeof instructions !== "string") throw failure("manual_compact_unavailable");
      // Reserving synchronously prevents a prompt/continue accepted on the
      // next microtask from racing abort, waitForIdle or summary generation.
      active = true;
      let session, result, primaryError, compacted = false, beforeStarted = false, interrupted = false;
      try {
        session = getSession();
        if (!session || typeof session.compact !== "function") throw failure("manual_compact_unavailable");
        await assertAvailable({ session, phase: "starting" });
        beforeStarted = true;
        await beforeCompact({ session, instructions });
        interrupted = isRunning ? !!isRunning(session) : !!(session.isStreaming || session.isCompacting);
        if (interrupted) await abort(session);
        // This hook should also await the host's prompt finalizer/native
        // accounting, beyond AgentSession.waitForIdle(), when those exist.
        await waitForIdle(session);
        await assertAvailable({ session, phase: "compacting" });
        if (getSession() !== session) throw failure("manual_compact_session_changed");
        if (session.isStreaming || session.isCompacting || (isRunning && isRunning(session))) throw failure("manual_compact_not_idle");
        // The SDK owns cut points, paired tool groups, checkpoints and request
        // routing. NativeModelFetch/task-context hooks remain on that session.
        result = await session.compact(instructions);
        compacted = true;
      } catch (error) { primaryError = error; }
      try {
        // Exactly one terminal callback, while new prompts are still fenced.
        // It can release a native control reservation without resetting usage.
        if (beforeStarted) await afterCompact({ session, instructions, interrupted, compacted, result, error: primaryError });
      } catch (cleanupError) {
        if (!primaryError) primaryError = failure("manual_compact_finalize_failed", compacted);
        // Keep the provider/budget error primary and the cleanup evidence in
        // memory. Never automatically repeat a possibly successful compact.
        if (primaryError && typeof primaryError === "object" && Object.isExtensible(primaryError)) {
          Object.defineProperty(primaryError, "manualCompactCleanupError", { value: cleanupError });
        }
      } finally { active = false; }
      if (primaryError !== undefined) throw primaryError;
      return result;
    },
  };
  return control;
}
