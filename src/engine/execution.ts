import { PlatformError, type ExecutionSnapshot, type Json, type Platform } from "../platform";
import type { LlmConfig } from "./game";
import type { ChatMessage } from "./llm/chat";
import type { WorldSettings, WorldState } from "./types";

/** Entry data, persisted without credentials. The native core owns everything afterwards. */
export interface RunPlan {
  id: string; worldId: string; lineId: string; headId: string; baseId: string | null;
  kind: "turn" | "variant" | "continue" | "opening" | "correction" | "ask" | "autoplay";
  model: LlmConfig;
  /** 备用服务 (D179). */
  fallbackModel?: LlmConfig;
  messages: ChatMessage[];
  extractMessages: ChatMessage[];
  state: WorldState; settings: WorldSettings;
  options: Record<string, unknown>;
  action: { mode: string; text: string; directorNote?: string | null };
  meta: Record<string, unknown>;
  reference?: unknown;
  original?: string;
  carriedEdits?: unknown[];
  trailingIds?: string[];
  newWorld?: { title: string; eraId: string };
}
export const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

/** Detaching only stops delivery. Explicit stop is the sole cancellation path. */
export function startRun(platform: Platform, plan: RunPlan | null, onEvent: (event: Record<string, unknown>) => void, existingId?: string, after = 0) {
  const execution = platform.execution;
  let stopped = false, attached = true, processed = after, timer: ReturnType<typeof setTimeout> | undefined;
  let terminal = false, polling: Promise<void> | null = null;
  let observationFailures = 0;
  let currentAttempt: string | null | undefined, stopAttempt: string | null | undefined;
  let stopSending = false, stopAcknowledged = false, stopRetryAt = 0;
  let settle!: (snapshot: ExecutionSnapshot) => void, fail!: (error: unknown) => void;
  const done = new Promise<ExecutionSnapshot>((resolve, reject) => { settle = resolve; fail = reject; });
  const registered = (async () => {
    if (!execution) throw new Error("当前运行环境没有原生执行核心，请启动本机开发宿主或使用应用");
    return existingId ?? execution.start(asJson(plan));
  })();
  const signal = (state: string) => {
    if (attached) onEvent({ type: "execution-status", state });
  };
  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void next(), delay);
  };
  const acknowledgeStop = () => {
    if (!stopAcknowledged && !terminal) signal("stop-requested");
    stopAcknowledged = true;
  };
  const sendStop = async (id: string) => {
    if (!execution || terminal || !stopped || stopSending || stopAcknowledged || Date.now() < stopRetryAt) return;
    // Freeze the first observed attempt; a late click cannot stop a later resume.
    if (stopAttempt === undefined) stopAttempt = currentAttempt;
    if (!stopAttempt) return;
    stopSending = true;
    try {
      const receipt = await execution.stop(id, stopAttempt);
      if (receipt.accepted) acknowledgeStop();
      if (receipt.settled || receipt.executionId !== stopAttempt) stopAcknowledged = true;
    } catch {
      if (!terminal) signal("stop-unconfirmed");
      stopRetryAt = Date.now() + 1500;
    } finally {
      stopSending = false;
    }
  };
  const poll = async (id: string) => {
    if (!execution || terminal) return;
    const snapshot = await execution.snapshot(id, attached ? processed : Number.MAX_SAFE_INTEGER);
    if (observationFailures > 0) signal("connected");
    observationFailures = 0;
    currentAttempt = snapshot.executionId ?? null;
    const running = ["running", "committing"].includes(snapshot.status);
    if (running && snapshot.stopRequested && (!stopped || currentAttempt === stopAttempt)) acknowledgeStop();
    if (attached) for (const item of snapshot.events) {
      if (item.seq <= processed) continue;
      processed = item.seq;
      if (item.event && typeof item.event === "object" && !Array.isArray(item.event)) onEvent(item.event as Record<string, unknown>);
    }
    if (!running) { terminal = true; settle(snapshot); return; }
    void sendStop(id);
    schedule(attached ? 350 : 1000);
  };
  const terminate = (error: unknown) => { terminal = true; clearTimeout(timer); fail(error); };
  const lostObservation = (error: unknown) => {
    if (error instanceof PlatformError && error.code === "execution_missing") { terminate(error); return; }
    if (observationFailures++ === 0) signal("reconnecting");
    schedule(Math.min(5_000, 350 * 2 ** Math.min(observationFailures, 4)));
  };
  const next = () => {
    if (polling) return polling;
    polling = registered.then((id) => poll(id).catch(lostObservation), terminate).finally(() => { polling = null; });
    return polling;
  };
  void next();
  return {
    done,
    cancel() { stopped = true; void registered.then(sendStop, () => {}); },
    async catchUp() { attached = true; clearTimeout(timer); await next(); },
    detach() { attached = false; },
  };
}
