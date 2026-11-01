import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiHost } from "../src/host.mjs";

// Full pinned AgentSession and SessionManager; all provider bytes are supplied
// in memory. No HTTP/socket, personal data or paid model request is used.
test("message anchors refer to actual persisted Pi entries and preserve Unicode messages and tool groups", { timeout: 15_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lishi-pi-message-anchor-"));
  const events = [], replies = new Map(), calls = [];
  const goal = "核对旅人𠮷的纪年😀，保留玩家改写。\n时间不推进。";
  const interim = "先查阅第二章𠮷，再判断时间锚点。";
  const final = "已查阅中文与😀片段，没有修改正式故事。";
  let host, requests = 0;
  try {
    host = await PiHost.create({ directory, nativeModelHttp: true,
      model: { id: "owned-anchor-model", protocol: "chat-completions", baseUrl: "https://fixture.invalid/v1", apiKey: "OWNED-ANCHOR-KEY-IN-MEMORY", inputTokens: 12000, contextWindowTokens: 20000, maxOutputTokens: 1024 },
      tools: [{ name: "read_original", description: "读取隔离原著", readOnly: true, parameters: { type: "object", properties: {}, additionalProperties: true } }],
      systemPrompt: "只核对隔离夹具，不修改故事。",
      onEvent: event => events.push(event),
      invokeTool: async call => { calls.push(call); return { ok: true, data: { text: "第二章：旅人𠮷读到斗罗历10015年。" } }; },
      invokeModelHttp: async (action, args) => {
        if (action === "start") {
          requests++;
          assert.ok(requests <= 2, "one read and one answer should settle the fixture");
          const delta = requests === 1 ? { role: "assistant", content: interim, tool_calls: [{ index: 0, id: "owned-read", type: "function", function: { name: "read_original", arguments: "{}" } }] } : { role: "assistant", content: final };
          const chunk = { id: `owned-anchor-${requests}`, object: "chat.completion.chunk", created: 1, model: "owned-anchor-model", usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, choices: [{ index: 0, delta, finish_reason: requests === 1 ? "tool_calls" : "stop" }] };
          replies.set(args.requestId, `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
          return { ok: true, data: { status: 200, headers: [["content-type", "text/event-stream"]] } };
        }
        if (action === "read") {
          const data = replies.get(args.requestId); replies.delete(args.requestId);
          return { ok: true, data: data ? { done: false, chunk: Buffer.from(data).toString("base64") } : { done: true } };
        }
        return { ok: true, data: {} };
      },
    });
    const result = await host.prompt(goal, "owned-anchor-task");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 2); assert.equal(calls.length, 1); assert.ok(result.text.includes(final));
    const entries = host.manager.getEntries().filter(entry => entry.type === "message");
    const anchors = events.filter(record => record.event.type === "message_anchor");
    const completed = events.filter(record => record.event.type === "message_end" && ["user", "assistant"].includes(record.event.message?.role));
    assert.equal(anchors.length, 3, "the original user and both assistant messages need actual Pi entry locators");
    assert.equal(completed.length, anchors.length, "anchors must supplement, never replace, final visible message events");
    const transcript = await fs.readFile(result.sessionFile, "utf8");
    for (const record of anchors) {
      assert.equal(record.taskId, "owned-anchor-task");
      const anchor = record.event, entry = entries.find(item => item.id === anchor.entryId);
      assert.ok(entry, "no manufactured entry ID is accepted");
      assert.equal(entry.message.role, anchor.role);
      assert.ok(transcript.includes(`"id":"${anchor.entryId}"`), "the entry must exist in the real saved Pi transcript");
      const correspondingEnd = completed.find(item => item.event.message === entry.message);
      assert.ok(correspondingEnd, "the anchored message must be the exact SDK object from message_end");
      assert.ok(events.indexOf(correspondingEnd) < events.indexOf(record), "append-boundary anchor must follow its completed message");
      if (anchor.role === "user") {
        assert.equal(anchor.userHash, createHash("sha256").update(goal).digest("hex"));
      } else {
        assert.equal(anchor.messageKey, `at:${entry.message.timestamp}`);
        assert.equal(anchor.userHash, undefined);
      }
    }
    assert.ok(entries.some(entry => entry.message.role === "toolResult" && entry.message.toolCallId === "owned-read"));
    assert.ok(completed.some(record => JSON.stringify(record.event.message.content).includes(interim)));
    assert.ok(completed.some(record => JSON.stringify(record.event.message.content).includes(final)));
    assert.ok(!transcript.includes("OWNED-ANCHOR-KEY-IN-MEMORY"));
  } finally {
    await host?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
