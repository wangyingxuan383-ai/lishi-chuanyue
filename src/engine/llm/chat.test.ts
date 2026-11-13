import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { Platform, StreamEvent, StreamRequest } from "../../platform";
import { ChatError, CONTEXT_WINDOW_MARKERS, chatCompletionsUrl, isContextWindowError, parseChunk, retryDecision, serviceBase, streamChat, type ChatMessage, type ChatToolDefinition } from "./chat";

function fakePlatform(events: StreamEvent[]): Platform {
  return {
    llm: {
      async stream(_request: StreamRequest, onEvent: (event: StreamEvent) => void) {
        queueMicrotask(() => events.forEach(onEvent));
        return "s1";
      },
      cancel: async () => {},
    },
  } as unknown as Platform;
}

const data = (value: unknown): StreamEvent => ({ type: "data", data: JSON.stringify(value) });

describe("parseChunk", () => {
  it("keeps missing and invalid token counts unknown while retaining an explicit zero", () => {
    expect(parseChunk(JSON.stringify({ usage: { prompt_tokens: 100 } }))?.usage).toEqual({ promptTokens: 100, completionTokens: null });
    expect(parseChunk(JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 0 } }))?.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
    for (const value of [-1, 1.5, "100", true, Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(parseChunk(JSON.stringify({ usage: { prompt_tokens: value, completion_tokens: 5 } }))?.usage).toEqual({ promptTokens: null, completionTokens: 5 });
    }
    expect(parseChunk(JSON.stringify({ usage: { total_tokens: 50 } }))?.usage).toEqual({ promptTokens: null, completionTokens: null });
    expect(parseChunk(JSON.stringify({ usage: [] }))?.usage).toBeNull();
  });
  it("reads content, reasoning, finish reason and usage, ignoring unknown fields", () => {
    expect(parseChunk(JSON.stringify({
      id: "x", weird: { nested: true },
      choices: [{ delta: { content: "长安", reasoning_content: "想", extra: 1 }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, other: 3 },
    }))).toEqual({ content: "长安", reasoning: "想", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } });
  });

  it("accepts a non-streamed message body", () => {
    expect(parseChunk(JSON.stringify({ choices: [{ message: { content: "全文" } }] }))?.content).toBe("全文");
  });

  it("reads a non-streamed tool message with positional indexes", async () => {
    const event = data({ choices: [{ message: { content: null, tool_calls: [
      { id: "call_read", type: "function", function: { name: "read_world", arguments: "{}" } },
    ] }, finish_reason: "tool_calls" }] });
    const result = await streamChat(fakePlatform([event, { type: "done" }]), {
      slot: "main", url: "https://x/v1/chat/completions", model: "m", messages: [],
    }).result;
    expect(result.text).toBe("");
    expect(result.toolCalls).toEqual([{ id: "call_read", type: "function", function: { name: "read_world", arguments: "{}" } }]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("returns null for non-JSON lines", () => {
    expect(parseChunk("not json")).toBeNull();
  });
});

describe("streamChat", () => {
  const request = { slot: "main", url: "https://x/v1/chat/completions", model: "m", messages: [] };

  it("combines separately reported token counts without inventing missing usage", async () => {
    const result = await streamChat(fakePlatform([
      data({ choices: [{ delta: { content: "正文" } }], usage: { prompt_tokens: 100 } }),
      data({ choices: [], usage: { completion_tokens: 12 } }),
      data({ choices: [], usage: {} }),
      { type: "done" },
    ]), request).result;
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 12 });
  });

  it("concatenates deltas and reports thinking once", async () => {
    let thinking = 0;
    const seen: string[] = [];
    const handle = streamChat(fakePlatform([
      { type: "open", status: 200 },
      data({ choices: [{ delta: { reasoning_content: "…" } }] }),
      data({ choices: [{ delta: { reasoning_content: "…" } }] }),
      data({ choices: [{ delta: { content: "西市" } }] }),
      data({ choices: [{ delta: { content: "清晨" }, finish_reason: "stop" }] }),
      data({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      { type: "done" },
    ]), request, { onThinking: () => thinking++, onText: (_d, full) => seen.push(full) });
    const result = await handle.result;
    expect(result.text).toBe("西市清晨");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2 });
    expect(result.finishReason).toBe("stop");
    expect(thinking).toBe(1);
    expect(seen).toEqual(["西市", "西市清晨"]);
  });

  it("assembles interleaved tool names and argument fragments without requiring story text", async () => {
    const result = await streamChat(fakePlatform([
      data({ choices: [{ delta: { tool_calls: [
        { index: 1, id: "find", type: "function", function: { name: "search_original", arguments: '{"query":"' } },
        { index: 0, id: "read", type: "function", function: { name: "read_", arguments: '{"section":' } },
      ] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "original", arguments: "3," } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [
        { index: 1, function: { arguments: '真实身份"}' } },
        { index: 0, function: { arguments: '"chunk":7}' } },
      ] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 12 } }),
      { type: "done" },
    ]), request).result;
    expect(result.toolCalls).toEqual([
      { id: "read", type: "function", function: { name: "read_original", arguments: '{"section":3,"chunk":7}' } },
      { id: "find", type: "function", function: { name: "search_original", arguments: '{"query":"真实身份"}' } },
    ]);
    expect(result.text).toBe("");
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 12 });
    expect(result.firstTokenMs).not.toBeNull();
    expect(result.totalMs).toBeGreaterThanOrEqual(result.firstTokenMs!);
  });

  it("sends tool definitions, an explicit choice and prior tool result messages unchanged", async () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "read", type: "function", function: { name: "read_world", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "read", content: '{"place":"书铺"}' },
    ];
    const tools: ChatToolDefinition[] = [{ type: "function", function: { name: "read_world", parameters: { type: "object", properties: {} } } }];
    const platform = fakePlatform([data({ choices: [{ delta: { content: "书铺里亮着灯。" } }] }), { type: "done" }]);
    const original = platform.llm.stream;
    let body: any;
    platform.llm.stream = (sent, onEvent) => { body = sent.body; return original(sent, onEvent); };
    await streamChat(platform, { ...request, messages, tools, toolChoice: { type: "function", function: { name: "read_world" } } }).result;
    expect(body.messages).toEqual(messages);
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "read_world" } });
    await streamChat(platform, request).result;
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("replays missed tool fragments once when returning from the background", async () => {
    const events: StreamEvent[] = [
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read", function: { name: "read_original", arguments: '{"section":' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "2}" } }] }, finish_reason: "tool_calls" }] }),
      { type: "done" },
    ];
    let deliver!: (event: StreamEvent) => void;
    const platform = { llm: {
      async stream(_request: StreamRequest, onEvent: (event: StreamEvent) => void) { deliver = onEvent; onEvent(events[0]); return "read"; },
      async resume() { return { events, active: false }; },
    } } as unknown as Platform;
    const handle = streamChat(platform, request);
    await handle.catchUp();
    deliver(events[1]); deliver(events[2]);
    expect((await handle.result).toolCalls?.[0].function.arguments).toBe('{"section":2}');
  });

  it("rejects an incomplete tool call instead of executing a nameless call", async () => {
    const handle = streamChat(fakePlatform([
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "incomplete", function: { arguments: "{}" } }] } }] }),
      { type: "done" },
    ]), request);
    await expect(handle.result).rejects.toMatchObject({ kind: "empty", message: "工具调用不完整，请重试" });
  });

  it("fails with the partial text when the stream errors", async () => {
    const handle = streamChat(fakePlatform([
      data({ choices: [{ delta: { content: "半句" } }] }),
      { type: "error", kind: "timeout_idle" },
    ]), request);
    await expect(handle.result).rejects.toMatchObject({ kind: "timeout_idle", partial: "半句" });
  });

  it("treats a finished stream without text as empty", async () => {
    const handle = streamChat(fakePlatform([{ type: "done" }]), request);
    await expect(handle.result).rejects.toBeInstanceOf(ChatError);
  });
});

describe("urls", () => {
  it("normalizes roots and full endpoints", () => {
    expect(chatCompletionsUrl("https://api.x.com")).toBe("https://api.x.com/v1/chat/completions");
    expect(chatCompletionsUrl("https://api.x.com/v1/")).toBe("https://api.x.com/v1/chat/completions");
    expect(chatCompletionsUrl("https://x/api/v3/chat/completions")).toBe("https://x/api/v3/chat/completions");
    expect(serviceBase("http://1.2.3.4:8317/")).toBe("http://1.2.3.4:8317/v1");
    expect(chatCompletionsUrl("https://generativelanguage.googleapis.com/v1beta/openai")).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(chatCompletionsUrl("https://open.bigmodel.cn/api/paas/v4")).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
  });
});

describe("retryDecision", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "可选前文：必需选区", compactContent: "必需选区" }];

  it.each([
    new ChatError("network"), new ChatError("timeout_first"),
    new ChatError("http", 429), new ChatError("http", 500), new ChatError("http", 503),
  ])("retries a first transient failure without changing messages: %s", error => {
    const result = retryDecision(error, 1, messages);
    expect(result.retry).toBe(true);
    expect(result.messages).toBe(messages);
    expect(retryDecision(error, 2, messages).retry).toBe(false);
  });

  it.each([
    new ChatError("cancelled"), new ChatError("timeout_idle"), new ChatError("timeout_total"),
    new ChatError("http", 401), new ChatError("http", 403), new ChatError("http", 402),
    new ChatError("http", 400), new ChatError("empty"), new Error("network"),
    new ChatError("network", undefined, "半句"), new ChatError("http", 429, "[tool]"),
    new ChatError("http", 413, "半句"),
  ])("does not retry ineligible or partial failures: %s", error => {
    expect(retryDecision(error, 1, messages)).toEqual({ retry: false, messages });
  });

  it("only retries context rejection with a smaller request and shares the retry allowance", () => {
    const error = new ChatError("http", 400, "", "maximum context length");
    const decision = retryDecision(error, 1, messages);
    expect(decision).toEqual({ retry: true, messages: [{ ...messages[0], content: "必需选区" }] });
    expect(messages[0].content).toBe("可选前文：必需选区");
    expect(retryDecision(error, 1, decision.messages).retry).toBe(false);
    expect(retryDecision(new ChatError("network"), 2, decision.messages).retry).toBe(false);
    expect(retryDecision(error, 2, messages).retry).toBe(false);
    expect(retryDecision(new ChatError("http", 413), 1, messages).retry).toBe(true);
  });

  it("keeps the TS and Rust provider context rejection markers identical", () => {
    const rust = readFileSync(new URL("../../../crates/story-core/src/chat.rs", import.meta.url), "utf8");
    const body = rust.match(/pub fn provider_context_rejected\([\s\S]*?\n\}/)?.[0];
    expect(body).toBeDefined();
    const markers = body!.match(/\[\s*"[\s\S]*?\]/)?.[0];
    expect(markers).toBeDefined();
    expect(JSON.parse(markers!).sort()).toEqual([...CONTEXT_WINDOW_MARKERS].sort());
    for (const marker of CONTEXT_WINDOW_MARKERS) {
      expect(isContextWindowError(new ChatError("http", 422, "", marker.toUpperCase()))).toBe(true);
      expect(isContextWindowError(new ChatError("http", 401, "", marker))).toBe(false);
    }
  });

  it("treats streamed tool fragments as partial output when the network fails", async () => {
    const handle = streamChat(fakePlatform([
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read", function: { name: "read_original", arguments: "{" } }] } }] }),
      { type: "error", kind: "network" },
    ]), { slot: "test", url: "https://fixture.invalid", model: "mock", messages });
    const error = await handle.result.catch(error => error);
    expect(error).toBeInstanceOf(ChatError);
    expect(error.partial).toBeTruthy();
    expect(retryDecision(error, 1, messages).retry).toBe(false);
  });
});
