import { describe, expect, it } from "vitest";
import type { Platform, StreamEvent, StreamRequest } from "../../platform";
import { ChatError, chatCompletionsUrl, parseChunk, serviceBase, streamChat } from "./chat";

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

  it("returns null for non-JSON lines", () => {
    expect(parseChunk("not json")).toBeNull();
  });
});

describe("streamChat", () => {
  const request = { slot: "main", url: "https://x/v1/chat/completions", model: "m", messages: [] };

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
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2 });
    expect(result.finishReason).toBe("stop");
    expect(thinking).toBe(1);
    expect(seen).toEqual(["西市", "西市清晨"]);
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
