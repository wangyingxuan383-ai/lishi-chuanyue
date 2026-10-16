// OpenAI-compatible Chat Completions streaming, built on Platform.llm.
// Parsing is deliberately lenient: unknown fields are ignored, and a single
// non-streamed JSON body (some relays ignore `stream`) is accepted too.
import type { Json, Platform, StreamErrorKind, StreamEvent } from "../../platform";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChunkDelta {
  content: string;
  reasoning: string;
  finishReason: string | null;
  usage: ChatUsage | null;
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
  const usage = value.usage && typeof value.usage === "object"
    ? {
        promptTokens: Number(value.usage.prompt_tokens) || 0,
        completionTokens: Number(value.usage.completion_tokens) || 0,
      }
    : null;
  return {
    content: text(part.content),
    reasoning: text(part.reasoning_content) || text(part.reasoning),
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    usage,
  };
}

export interface ChatCallbacks {
  /** Model is thinking (reasoning tokens arrived) before any visible text. */
  onThinking?: () => void;
  onText?: (delta: string, full: string) => void;
}

export interface ChatResult {
  text: string;
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
}

export const DEFAULT_TIMEOUTS = { firstByteMs: 30_000, idleMs: 30_000, totalMs: 180_000 };

export interface ChatHandle {
  streamId: Promise<string>;
  result: Promise<ChatResult>;
  cancel(): void;
}

export function streamChat(platform: Platform, request: ChatRequest, callbacks: ChatCallbacks = {}): ChatHandle {
  const started = performance.now();
  let text = "";
  let finishReason: string | null = null;
  let usage: ChatUsage | null = null;
  let firstTokenMs: number | null = null;
  let thinking = false;
  let settle!: (result: ChatResult) => void;
  let fail!: (error: ChatError) => void;
  const result = new Promise<ChatResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

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
      finishReason = chunk.finishReason ?? finishReason;
      usage = chunk.usage ?? usage;
    } else if (event.type === "done") {
      if (!text) fail(new ChatError("empty", undefined, "", finishReason ?? undefined));
      else settle({ text, finishReason, usage, firstTokenMs, totalMs: performance.now() - started });
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
  };
  const streamId = platform.llm.stream(
    { slot: request.slot, url: request.url, body, timeouts: request.timeouts ?? DEFAULT_TIMEOUTS },
    onEvent,
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
  };
}

/** Accepts a root like https://host/v1 or a full .../chat/completions URL. */
export function chatCompletionsUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

/** The base a key is bound to: everything before /chat/completions. */
export function serviceBase(base: string): string {
  return chatCompletionsUrl(base).replace(/\/chat\/completions$/, "");
}
