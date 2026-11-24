// OpenAI-compatible Chat Completions streaming, built on Platform.llm.
// Parsing is deliberately lenient: unknown fields are ignored, and a single
// non-streamed JSON body (some relays ignore `stream`) is accepted too.
import type { Json, Platform, StreamErrorKind, StreamEvent } from "../../platform";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** A tool-only assistant message uses an empty string. */
  content: string;
  /** Optional supporting material can be removed as a whole before a retry. */
  compactContent?: string;
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
  failed?: boolean;
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
    finishReason: text(part.refusal).trim() ? "content_filter" : typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    usage,
    ...(value.error != null ? { failed: true } : {}),
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
  /** The model that answered (the backup's when it took over); set by the game's calls. */
  servedBy?: string;
}

export class ChatError extends Error {
  constructor(
    readonly kind: StreamErrorKind | "empty" | "invalid_stream",
    readonly status?: number,
    readonly partial = "",
    detail?: string,
  ) {
    super(detail ?? kind);
    this.name = "ChatError";
  }
}

const THINK_OPEN_RE = /<\s*think\s*>/gi;
const THINK_CLOSE_RE = /<\s*\/\s*think\s*>/gi;
const PARTIAL_THINK_OPEN_RE = /<\s*(?:t(?:h(?:i(?:n(?:k\s*)?)?)?)?)?$/i;

/** Strips closed `<think>...</think>` and trailing unclosed `<think>...` blocks from raw model text. */
export function stripInlineThink(raw: string): { visible: string; thinking: string } {
  THINK_OPEN_RE.lastIndex = 0;
  if (!THINK_OPEN_RE.test(raw)) return { visible: raw, thinking: "" };
  let visible = "";
  const thinkingParts: string[] = [];
  let pos = 0;
  while (pos < raw.length) {
    THINK_OPEN_RE.lastIndex = pos;
    const open = THINK_OPEN_RE.exec(raw);
    if (!open) {
      visible += raw.slice(pos);
      break;
    }
    const before = raw.slice(pos, open.index);
    if (visible.length > 0 || /[^ \t\r\n]/.test(before)) {
      visible += before;
    }
    const innerStart = open.index + open[0].length;
    THINK_CLOSE_RE.lastIndex = innerStart;
    const close = THINK_CLOSE_RE.exec(raw);
    if (!close) {
      const inner = raw.slice(innerStart).trim();
      if (inner) thinkingParts.push(inner);
      break;
    }
    const inner = raw.slice(innerStart, close.index).trim();
    if (inner) thinkingParts.push(inner);
    pos = close.index + close[0].length;
    if (visible.length === 0) {
      while (pos < raw.length && (raw[pos] === " " || raw[pos] === "\t" || raw[pos] === "\r" || raw[pos] === "\n")) {
        pos++;
      }
    }
  }
  return { visible, thinking: thinkingParts.join("\n") };
}

function hasUnclosedInlineThink(raw: string): boolean {
  THINK_OPEN_RE.lastIndex = 0;
  let pos = 0;
  while (pos < raw.length) {
    THINK_OPEN_RE.lastIndex = pos;
    const open = THINK_OPEN_RE.exec(raw);
    if (!open) return false;
    THINK_CLOSE_RE.lastIndex = open.index + open[0].length;
    const close = THINK_CLOSE_RE.exec(raw);
    if (!close) return true;
    pos = close.index + close[0].length;
  }
  return false;
}

export function outputWasTruncated(reason: string | null): boolean {
  return ["length", "max_tokens", "max_output_tokens"].includes(reason?.toLowerCase() ?? "");
}

// Keep these markers aligned with provider_context_rejected in crates/story-core/src/chat.rs.
export const CONTEXT_WINDOW_MARKERS = ["context_length_exceeded", "maximum context length", "exceeds the context window", "prompt is too long", "上下文窗口"];
export const MAX_TOKENS_MARKERS = ["max_tokens", "max_completion_tokens", "max_output_tokens", "maxoutputtokens", "maximum output", "maximum allowed completion"];

export function isContextWindowError(error: unknown): boolean {
  return error instanceof ChatError && error.kind === "http" && !error.partial
    && (error.status === 413 || ([400, 422].includes(error.status ?? 0)
      && CONTEXT_WINDOW_MARKERS.some(marker => error.message.toLowerCase().includes(marker))));
}

export function isMaxCompletionTokensParamError(error: unknown): boolean {
  if (!(error instanceof ChatError) || error.kind !== "http" || !!error.partial || ![400, 422].includes(error.status ?? 0)) {
    return false;
  }
  const lower = error.message.toLowerCase();
  return lower.includes("max_completion_tokens")
    && (lower.includes("not supported") || lower.includes("unsupported") || lower.includes("unrecognized") || lower.includes("unknown") || lower.includes("extra_forbidden"));
}

export function isMaxTokensError(error: unknown): boolean {
  if (!(error instanceof ChatError) || error.kind !== "http" || !!error.partial || ![400, 422].includes(error.status ?? 0)) {
    return false;
  }
  if (isContextWindowError(error) || isMaxCompletionTokensParamError(error)) return false;
  const lower = error.message.toLowerCase();
  if (lower.includes("budget_tokens") || lower.includes("must be greater than") || (lower.includes("greater than") && !lower.includes("maximum") && !lower.includes("limit"))) {
    return false;
  }
  return MAX_TOKENS_MARKERS.some(marker => lower.includes(marker));
}

export const CONTEXT_WINDOW_MESSAGE = "AI 服务报告模型上下文窗口不足。可缩小本次正文或资料范围，或改用输入窗口更大的模型。";

export function compactChatMessages(messages: ChatMessage[]): ChatMessage[] | null {
  let changed = false;
  const compact = messages.map(message => {
    const { compactContent } = message;
    if (compactContent === undefined || compactContent.length >= message.content.length) return message;
    changed = true;
    return { ...message, content: compactContent };
  });
  return changed ? compact : null;
}

/** Multi-step max_tokens step-down (8192 -> 4096 -> 2048 -> 1024) plus one retry for stream/context/transient failures. */
export function retryDecision(
  error: unknown,
  attempt: number,
  messages: ChatMessage[],
  maxTokens?: number,
): { retry: boolean; messages: ChatMessage[]; maxTokens?: number } {
  if (!(error instanceof ChatError) || attempt < 1) return { retry: false, messages };
  if (!error.partial && attempt <= 3 && isMaxTokensError(error) && (maxTokens ?? 0) > 1024) {
    const cur = maxTokens!;
    const nextMax = cur > 4096 ? 4096 : cur > 2048 ? 2048 : 1024;
    return { retry: true, messages, maxTokens: nextMax };
  }
  if (attempt !== 1) return { retry: false, messages };
  if (error.kind === "stream") return { retry: true, messages };
  if (error.partial) return { retry: false, messages };
  const compact = isContextWindowError(error) ? compactChatMessages(messages) : null;
  // The same rule as native passages (D167): no words yet, and the failure may pass.
  const transient = error.kind === "network" || error.kind === "timeout_first"
    || (error.kind === "http" && (error.status === 429 || (error.status ?? 0) >= 500));
  return { retry: compact !== null || transient, messages: compact ?? messages };
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

/**
 * One set of limits for every model request, native passages and helper tasks
 * alike (R30, D167): a model that thinks before writing may take minutes for
 * its first word; after that only silence ends a request, and the backstop
 * keeps one that never ends from running for ever.
 */
export const DEFAULT_TIMEOUTS = { firstByteMs: 180_000, idleMs: 120_000, totalMs: 900_000 };

export interface ChatHandle {
  streamId: Promise<string>;
  result: Promise<ChatResult>;
  cancel(): void;
  /** Replays events the page missed while it was paused in the background. */
  catchUp(): Promise<void>;
}

export function streamChat(platform: Platform, request: ChatRequest, callbacks: ChatCallbacks = {}): ChatHandle {
  const started = performance.now();
  let rawText = "";
  let text = "";
  let finishReason: string | null = null;
  let usage: ChatUsage | null = null;
  let firstTokenMs: number | null = null;
  let thinking = false;
  let ended = false;
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
    if (ended) return;
    if (event.type === "data") {
      const chunk = parseChunk(event.data);
      if (!chunk) return;
      if (chunk.failed) {
        ended = true;
        fail(new ChatError("stream", undefined, text || (calls.size ? "[tool]" : ""), "AI 服务在回复途中返回了错误"));
        return;
      }
      if (chunk.reasoning && !text && !thinking) {
        thinking = true;
        callbacks.onThinking?.();
      }
      if (chunk.content) {
        rawText += chunk.content;
        const stripped = stripInlineThink(rawText);
        if (!text && !thinking && (stripped.thinking || hasUnclosedInlineThink(rawText))) {
          thinking = true;
          callbacks.onThinking?.();
        }
        const partialMatch = PARTIAL_THINK_OPEN_RE.exec(stripped.visible);
        const safeVisible = partialMatch ? stripped.visible.slice(0, partialMatch.index) : stripped.visible;
        const readyToEmit = text.length > 0 || /[^ \t\r\n]/.test(safeVisible);
        if (readyToEmit && safeVisible.length > text.length) {
          firstTokenMs ??= performance.now() - started;
          const delta = safeVisible.slice(text.length);
          text = safeVisible;
          callbacks.onText?.(delta, text);
        }
      }
      for (const delta of chunk.toolCalls ?? []) {
        firstTokenMs ??= performance.now() - started;
        const call = calls.get(delta.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
        if (delta.id) call.id = delta.id;
        call.function.name += delta.name ?? "";
        call.function.arguments += delta.arguments ?? "";
        calls.set(delta.index, call);
      }
      if (finishReason !== "content_filter") finishReason = chunk.finishReason ?? finishReason;
      if (chunk.usage) usage = {
        promptTokens: chunk.usage.promptTokens ?? usage?.promptTokens ?? null,
        completionTokens: chunk.usage.completionTokens ?? usage?.completionTokens ?? null,
      };
    } else if (event.type === "done") {
      ended = true;
      if (rawText) {
        const finalVisible = stripInlineThink(rawText).visible;
        if (finalVisible.length > text.length) {
          firstTokenMs ??= performance.now() - started;
          const delta = finalVisible.slice(text.length);
          text = finalVisible;
          callbacks.onText?.(delta, text);
        }
      }
      const toolCalls = [...calls].sort(([a], [b]) => a - b).map(([, call]) => call);
      if (toolCalls.some((call) => !call.id || !call.function.name)) fail(new ChatError("empty", undefined, text, "工具调用不完整，请重试"));
      else if (!text && !toolCalls.length) fail(new ChatError("empty", undefined, "", finishReason ?? undefined));
      else settle({ text, toolCalls, finishReason, usage, firstTokenMs, totalMs: performance.now() - started });
    } else if (event.type === "error") {
      ended = true;
      fail(new ChatError(event.kind, event.status, text || (calls.size ? "[tool]" : ""), event.message));
    }
  };

  const extra = { ...request.extra };
  for (const key of ["model", "messages", "stream", "stream_options", "n", "max_tokens", "tools", "tool_choice"]) delete extra[key];
  const body: Record<string, Json> = {
    ...extra,
    model: request.model,
    messages: request.messages.map(({ compactContent: _compact, ...message }) => message) as unknown as Json,
    stream: true,
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.includeUsage ? { stream_options: { include_usage: true } } : {}),
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
      : code === "llm_no_secret" || code === "no_secret" || code === "llm_bindings_unavailable" ? "no_secret"
        : code === "llm_stream_storage" ? "storage" : "network";
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
