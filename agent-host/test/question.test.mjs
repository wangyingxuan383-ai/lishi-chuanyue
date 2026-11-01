import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiHost } from "../src/host.mjs";

// Complete pinned SDK, with an in-memory transport. No socket, real service,
// user configuration or paid request is involved in this boundary check.
test("Pi settles a question after its complete tool group and resumes the saved conversation", { timeout: 15_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lishi-pi-question-"));
  const bodies = [], replies = new Map(), calls = [];
  let reportFirstUsage, releaseFirstUsage, usageCount = 0;
  const firstUsage = new Promise(resolve => { reportFirstUsage = resolve; });
  const usageAcknowledged = new Promise(resolve => { releaseFirstUsage = resolve; });
  const tool = (id, name, args) => ({ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const invokeModelHttp = async (action, args) => {
    if (action === "usage" && ++usageCount === 1) { reportFirstUsage(); await usageAcknowledged; }
    if (action === "start") {
      const body = JSON.parse(Buffer.from(args.body, "base64").toString()); bodies.push(body);
      assert.ok(bodies.length <= 3, "waiting must not trigger another provider call");
      if (bodies.length === 2) assert.ok(body.messages.some(m => m.role === "tool" && m.tool_call_id === "ask-1"), "the persisted question must keep its tool result");
      const delta = bodies.length === 1 ? { role: "assistant", content: "需要确认修改范围。", tool_calls: [tool("ask-1", "ask_user", { questions: [{ question: "核对哪段？" }] })] }
        : bodies.length === 2 ? { role: "assistant", tool_calls: [tool("finish-1", "finish_task", { summary: "已按回答核对" })] }
          : { role: "assistant", content: "已核对你选择的这一段。" };
      const chunk = { id: `in-memory-${bodies.length}`, object: "chat.completion.chunk", created: 1, model: "isolated-question", usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, choices: [{ index: 0, delta, finish_reason: bodies.length < 3 ? "tool_calls" : "stop" }] };
      replies.set(args.requestId, `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      return { ok: true, data: { status: 200, headers: [["content-type", "text/event-stream"]] } };
    }
    if (action === "read") {
      const value = replies.get(args.requestId); replies.delete(args.requestId);
      return { ok: true, data: value ? { done: false, chunk: Buffer.from(value).toString("base64") } : { done: true } };
    }
    return { ok: true, data: {} };
  };
  const options = { directory, nativeModelHttp: true, invokeModelHttp,
    model: { id: "isolated-question", protocol: "chat-completions", baseUrl: "https://fixture.invalid/v1", apiKey: "OWNED-ONLY-IN-MEMORY", inputTokens: 12000, contextWindowTokens: 20000, maxOutputTokens: 1024 },
    systemPrompt: "只处理隔离夹具，缺少范围时询问玩家。",
    tools: ["ask_user", "finish_task"].map(name => ({ name, readOnly: true, description: name, parameters: { type: "object", properties: {}, additionalProperties: true } })),
    invokeTool: async call => {
      calls.push(call.name);
      return { ok: true, data: call.name === "ask_user" ? { waitingForUser: true, question: { id: "owned-question", questions: [{ id: "scope", question: "核对哪段？" }] } } : { status: "answered", changed: false } };
    } };
  let host;
  try {
    host = await PiHost.create(options);
    const firstRun = host.prompt("核对资料，但范围尚未明确", "owned-task");
    await firstUsage;
    assert.deepEqual(calls, [], "no native story tool runs before the model usage is acknowledged");
    assert.equal(bodies.length, 1);
    releaseFirstUsage();
    const first = await firstRun;
    assert.equal(first.waitingForUser, true); assert.equal(bodies.length, 1);
    assert.deepEqual(calls, ["ask_user"]);
    const messages = host.manager.buildSessionProjection().messages;
    assert.ok(messages.some(m => m.role === "toolResult" && m.toolCallId === "ask-1" && !m.isError));
    const sessionFile = first.sessionFile;
    await host.close(); host = null;
    host = await PiHost.create({ ...options, sessionFile });
    const second = await host.prompt("玩家回答：只核对当前段落", "owned-task");
    assert.equal(second.waitingForUser, false); assert.equal(bodies.length, 3);
    assert.deepEqual(calls, ["ask_user", "finish_task"]);
    assert.ok(second.text.includes("这一段"));
  } catch (error) {
    const diagnostics = host?.session.messages.filter(m => m.role === "assistant").map(m => ({ stopReason: m.stopReason, error: m.errorMessage?.replaceAll("OWNED-ONLY-IN-MEMORY", "[owned-key]") }));
    throw new Error(`${error.code ?? "failure"}; in-memory responses=${bodies.length}; tools=${calls.join(",")}; ${JSON.stringify(diagnostics)}`);
  } finally {
    releaseFirstUsage();
    await host?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
