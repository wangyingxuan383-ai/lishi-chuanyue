import type { ExecutionSnapshot, Json, Platform } from "../platform";
import type { LlmConfig } from "./game";
import type { ChatMessage } from "./llm/chat";
import type { ExecutionMode, WorldSettings, WorldState } from "./types";

/** Entry data, persisted without credentials. The native core owns everything afterwards. */
export interface RunPlan {
  id: string; worldId: string; lineId: string; headId: string; baseId: string | null;
  kind: "turn" | "variant" | "continue" | "opening" | "correction" | "ask" | "autoplay";
  executionMode: ExecutionMode;
  model: LlmConfig;
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
  let settle!: (snapshot: ExecutionSnapshot) => void, fail!: (error: unknown) => void;
  const done = new Promise<ExecutionSnapshot>((resolve, reject) => { settle = resolve; fail = reject; });
  const registered = (async () => {
    if (!execution) throw new Error("当前运行环境没有原生执行核心，请启动本机开发宿主或使用应用");
    const id = existingId ?? await execution.start(asJson(plan));
    if (stopped) await execution.stop(id);
    return id;
  })();
  const poll = async () => {
    const id = await registered;
    if (!execution || terminal) return;
    const snapshot = await execution.snapshot(id, attached ? processed : Number.MAX_SAFE_INTEGER);
    if (attached) for (const item of snapshot.events) {
      if (item.seq <= processed) continue;
      processed = item.seq;
      if (item.event && typeof item.event === "object" && !Array.isArray(item.event)) onEvent(item.event as Record<string, unknown>);
    }
    if (!["running", "committing"].includes(snapshot.status)) { terminal = true; settle(snapshot); return; }
    timer = setTimeout(() => void next(), attached ? 350 : 1000);
  };
  const next = () => {
    if (polling) return polling;
    polling = poll().catch((error) => { terminal = true; fail(error); }).finally(() => { polling = null; });
    return polling;
  };
  void next();
  return {
    done,
    cancel() { stopped = true; void registered.then((id) => execution?.stop(id)).catch(() => {}); },
    async catchUp() { attached = true; clearTimeout(timer); await next(); },
    detach() { attached = false; },
  };
}
