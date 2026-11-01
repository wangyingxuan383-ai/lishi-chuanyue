// OpenAI-compatible Chat Completions streaming, built on Platform.llm.
// Parsing is deliberately lenient: unknown fields are ignored, and a single
// non-streamed JSON body (some relays ignore `stream`) is accepted too.
import type { Json, Platform, StreamErrorKind, StreamEvent } from "../../platform";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** A tool-only assistant message uses an empty string. */
  content: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, Json>; strict?: boolean };
}

export type ChatToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ChunkDelta {
  content: string;
  reasoning: string;
  finishReason: string | null;
  usage: ChatUsage | null;
  /** Present only when this payload includes supported tool-call fragments. */
  toolCalls?: ToolCallDelta[];
}

/** Extracts what we need from one `data:` payload; null when it is not JSON. */
export function parseChunk(data: string): ChunkDelta | null {
  let value: any;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
  const part = choice?.delta ?? choice?.message ?? {};
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const tokens = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const usage = value.usage && typeof value.usage === "object" && !Array.isArray(value.usage)
    ? {
        promptTokens: tokens(value.usage.prompt_tokens),
        completionTokens: tokens(value.usage.completion_tokens),
      }
    : null;
  const toolCalls: ToolCallDelta[] = Array.isArray(part.tool_calls) ? part.tool_calls.flatMap((call: unknown, position: number) => {
    if (!call || typeof call !== "object" || Array.isArray(call)) return [];
    const c = call as Record<string, unknown>;
    if (c.type !== undefined && c.type !== "function") return [];
    const index = c.index === undefined ? position : c.index;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return [];
    const fn = c.function && typeof c.function === "object" && !Array.isArray(c.function) ? c.function as Record<string, unknown> : {};
    return [{ index, ...(typeof c.id === "string" ? { id: c.id } : {}),
      ...(typeof fn.name === "string" ? { name: fn.name } : {}),
      ...(typeof fn.arguments === "string" ? { arguments: fn.arguments } : {}) }];
  }) : [];
  return {
    content: text(part.content),
    reasoning: text(part.reasoning_content) || text(part.reasoning),
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    usage,
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

export interface ChatCallbacks {
  /** Model is thinking (reasoning tokens arrived) before any visible text. */
  onThinking?: () => void;
  onText?: (delta: string, full: string) => void;
}

export interface ChatResult {
  text: string;
  /** Actual calls return an array; optional so existing saved/test results remain valid. */
  toolCalls?: ChatToolCall[];
  finishReason: string | null;
  usage: ChatUsage | null;
  firstTokenMs: number | null;
  totalMs: number;
}

export class ChatError extends Error {
  constructor(
    readonly kind: StreamErrorKind | "empty",
    readonly status?: number,
    readonly partial = "",
    detail?: string,
  ) {
    super(detail ?? kind);
    this.name = "ChatError";
  }
}

export interface ChatRequest {
  slot: string;
  url: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  includeUsage?: boolean;
  timeouts?: { firstByteMs: number; idleMs: number; totalMs: number };
  extra?: Record<string, Json>;
  tools?: ChatToolDefinition[];
  toolChoice?: ChatToolChoice;
}

export const DEFAULT_TIMEOUTS = { firstByteMs: 30_000, idleMs: 30_000, totalMs: 180_000 };

export interface ChatHandle {
  streamId: Promise<string>;
  result: Promise<ChatResult>;
  cancel(): void;
  /** Replays events the page missed while it was paused in the background. */
  catchUp(): Promise<void>;
}

export function streamChat(platform: Platform, request: ChatRequest, callbacks: ChatCallbacks = {}): ChatHandle {
  const started = performance.now();
  let text = "";
  let finishReason: string | null = null;
  let usage: ChatUsage | null = null;
  let firstTokenMs: number | null = null;
  let thinking = false;
  const calls = new Map<number, ChatToolCall>();
  let settle!: (result: ChatResult) => void;
  let fail!: (error: ChatError) => void;
  const result = new Promise<ChatResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  // Events are numbered in arrival order so a replay from the native cache
  // (catchUp) and late channel deliveries never apply the same event twice.
  let processed = 0;
  let channelIndex = 0;
  const fromChannel = (event: StreamEvent) => {
    const index = channelIndex++;
    if (index < processed) return;
    processed = index + 1;
    onEvent(event);
  };
  const onEvent = (event: StreamEvent) => {
    if (event.type === "data") {
      const chunk = parseChunk(event.data);
      if (!chunk) return;
      if (chunk.reasoning && !text && !thinking) {
        thinking = true;
        callbacks.onThinking?.();
      }
      if (chunk.content) {
        firstTokenMs ??= performance.now() - started;
        text += chunk.content;
        callbacks.onText?.(chunk.content, text);
      }
      for (const delta of chunk.toolCalls ?? []) {
        firstTokenMs ??= performance.now() - started;
        const call = calls.get(delta.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
        if (delta.id) call.id = delta.id;
        call.function.name += delta.name ?? "";
        call.function.arguments += delta.arguments ?? "";
        calls.set(delta.index, call);
      }
      finishReason = chunk.finishReason ?? finishReason;
      if (chunk.usage) usage = {
        promptTokens: chunk.usage.promptTokens ?? usage?.promptTokens ?? null,
        completionTokens: chunk.usage.completionTokens ?? usage?.completionTokens ?? null,
      };
    } else if (event.type === "done") {
      const toolCalls = [...calls].sort(([a], [b]) => a - b).map(([, call]) => call);
      if (toolCalls.some((call) => !call.id || !call.function.name)) fail(new ChatError("empty", undefined, text, "工具调用不完整，请重试"));
      else if (!text && !toolCalls.length) fail(new ChatError("empty", undefined, "", finishReason ?? undefined));
      else settle({ text, toolCalls, finishReason, usage, firstTokenMs, totalMs: performance.now() - started });
    } else if (event.type === "error") {
      fail(new ChatError(event.kind, event.status, text, event.message));
    }
  };

  const body: Record<string, Json> = {
    model: request.model,
    messages: request.messages as unknown as Json,
    stream: true,
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...request.extra,
    ...(request.tools !== undefined ? { tools: request.tools as unknown as Json } : {}),
    ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice as Json } : {}),
  };
  const streamId = platform.llm.stream(
    { slot: request.slot, url: request.url, body, timeouts: request.timeouts ?? DEFAULT_TIMEOUTS },
    fromChannel,
  );
  // A request refused before it starts (unbound URL, missing key) rejects here.
  streamId.catch((error) => {
    const code = String(error?.code ?? "");
    const kind = code === "llm_url_not_bound" || code === "url_not_bound" ? "url_not_bound"
      : code === "llm_no_secret" || code === "no_secret" ? "no_secret" : "network";
    fail(new ChatError(kind, undefined, "", String(error?.message ?? error)));
  });
  return {
    streamId,
    result,
    cancel: () => void streamId.then((id) => platform.llm.cancel(id)),
    async catchUp() {
      const snapshot = await platform.llm.resume(await streamId).catch(() => null);
      if (!snapshot) return;
      for (const event of snapshot.events.slice(processed)) {
        processed++;
        onEvent(event);
      }
    },
  };
}

/**
 * Accepts a bare host (https://api.x.com → /v1/chat/completions), a base with
 * a path (…/v1, …/api/v3, …/v1beta/openai → + /chat/completions) or a full
 * …/chat/completions URL.
 */
export function chatCompletionsUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  let path = "";
  try {
    path = new URL(trimmed).pathname.replace(/\/+$/, "");
  } catch {
    /* treat as host only */
  }
  return path ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

/** The base a key is bound to: everything before /chat/completions. */
export function serviceBase(base: string): string {
  return chatCompletionsUrl(base).replace(/\/chat\/completions$/, "");
}
