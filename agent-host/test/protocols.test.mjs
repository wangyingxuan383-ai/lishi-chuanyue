// HTTP integration fixtures. Run only after registering the eight planned
// local model requests; this file never loads a player profile or credential.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PiHost } from "../src/host.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validation = path.join(root, ".cache/validation");
const ledger = path.join(validation, "protocol-ledger.jsonl");
const runId = `protocols-${Date.now()}-${randomUUID()}`;
const evidence = "protocol-original-tool-result-fixture";
const signature = Buffer.from("local-gemini-thought-signature-fixture").toString("base64");
let writes = Promise.resolve();

function record(value) {
  writes = writes.then(async () => {
    await fs.mkdir(validation, { recursive: true });
    const file = await fs.open(ledger, "a");
    try {
      await file.write(JSON.stringify({ recordedAt: new Date().toISOString(), runId, realRequests: 0, ...value }) + "\n");
      await file.sync();
    } finally { await file.close(); }
  });
  return writes;
}

function event(response, type, data) {
  response.write(`${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
}

function chat(response, first, model) {
  event(response, null, {
    id: `chat-fixture-${first ? 1 : 2}`, object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta: first ? { role: "assistant", tool_calls: [{
      index: 0, id: "chat_call_fixture", type: "function",
      function: { name: "read_resource", arguments: '{"ref":"fixture"}' },
    }] } : { role: "assistant", content: "已读取自有资料。" }, finish_reason: null }],
  });
  event(response, null, {
    id: `chat-fixture-${first ? 1 : 2}`, object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
  response.end("data: [DONE]\n\n");
}

function responses(response, first, model) {
  let sequence = 0;
  const id = `responses_fixture_${first ? 1 : 2}`;
  const emit = (type, data) => event(response, type, { type, sequence_number: sequence++, ...data });
  emit("response.created", { response: { id, object: "response", status: "in_progress", model } });
  const item = first
    ? { type: "function_call", id: "fc_fixture", call_id: "responses_call_fixture", name: "read_resource", arguments: '{"ref":"fixture"}', status: "completed" }
    : { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "已读取自有资料。", annotations: [] }] };
  emit("response.output_item.added", { output_index: 0, item: first ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } });
  if (first) {
    emit("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: item.arguments });
    emit("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: item.arguments });
  } else {
    emit("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: item.content[0].text });
  }
  emit("response.output_item.done", { output_index: 0, item });
  emit("response.completed", { response: {
    id, object: "response", status: "completed", model, output: [item],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  } });
  response.end();
}

function anthropic(response, first, model) {
  const emit = (type, data) => event(response, type, { type, ...data });
  emit("message_start", { message: {
    id: `msg_anthropic_fixture_${first ? 1 : 2}`, type: "message", role: "assistant", model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
  } });
  emit("content_block_start", { index: 0, content_block: first
    ? { type: "tool_use", id: "anthropic_call_fixture", name: "read_resource", input: {} }
    : { type: "text", text: "" } });
  emit("content_block_delta", { index: 0, delta: first
    ? { type: "input_json_delta", partial_json: '{"ref":"fixture"}' }
    : { type: "text_delta", text: "已读取自有资料。" } });
  emit("content_block_stop", { index: 0 });
  emit("message_delta", { delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
  emit("message_stop", {});
  response.end();
}

function gemini(response, first) {
  event(response, null, {
    responseId: `gemini_fixture_${first ? 1 : 2}`,
    candidates: [{ index: 0, content: { role: "model", parts: first
      ? [{ functionCall: { id: "gemini_call_fixture", name: "read_resource", args: { ref: "fixture" } }, thoughtSignature: signature }]
      : [{ text: "已读取自有资料。" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
  });
  response.end();
}

const cases = [
  { protocol: "chat-completions", base: "/chat/v1", endpoint: "/chat/v1/chat/completions", model: "chat-fixture", respond: chat },
  { protocol: "openai-responses", base: "/responses/v1", endpoint: "/responses/v1/responses", model: "responses-fixture", respond: responses },
  { protocol: "anthropic", base: "/anthropic/v1", endpoint: "/anthropic/v1/messages", model: "claude-fixture", respond: anthropic },
  { protocol: "gemini", base: "/gemini/v1beta", endpoint: "/gemini/v1beta/models/gemini-fixture:streamGenerateContent", model: "gemini-fixture", respond: gemini },
];

async function files(directory) {
  const result = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await files(file));
    else if (item.isFile()) result.push(file);
  }
  return result;
}

for (const fixture of cases) {
  test(`pinned Pi ${fixture.protocol}: one pure tool response and one final response`, { timeout: 30_000 }, async () => {
    const key = `local-${fixture.protocol}-fixture-only`;
    const bodies = [], urls = [], errors = [], tools = [];
    let host, directory, port, passed = false, failureName, requestCount = 0;
    const server = http.createServer(async (request, response) => {
      const number = ++requestCount;
      // Record every received attempt before replying, including malformed or
      // unexpected retries. Never persist an auth header or query key value.
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      await record({ type: "request", protocol: fixture.protocol, mockRequests: 1, number,
        method: request.method, path: url.pathname, queryKeys: [...url.searchParams.keys()].filter(name => name !== "key"),
        boundOrigin: request.headers.host === `127.0.0.1:${port}` });
      const chunks = [];
      let body;
      try {
        for await (const chunk of request) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch { body = null; }
      bodies.push(body);
      urls.push(url);
      try {
        assert.equal(request.headers.host, `127.0.0.1:${port}`);
        assert.equal(request.method, "POST");
        assert.equal(url.pathname, fixture.endpoint);
        assert.ok(number <= 2, "Unexpected extra model request");
        assert.ok(body && typeof body === "object");
        const auth = fixture.protocol === "anthropic" ? request.headers["x-api-key"]
          : fixture.protocol === "gemini" ? request.headers["x-goog-api-key"] ?? url.searchParams.get("key")
          : request.headers.authorization?.replace(/^Bearer /u, "");
        assert.equal(auth, key);
        if (fixture.protocol === "gemini") assert.equal(url.searchParams.get("alt"), "sse");
        if (number === 2) {
          assert.ok(JSON.stringify(body).includes(evidence), "Original tool result did not reach the second model request");
          if (fixture.protocol === "gemini") {
            assert.ok(body.contents.some(message => message.role === "model" && message.parts?.some(part => part.functionCall?.name === "read_resource" && part.thoughtSignature === signature)), "Google thoughtSignature was discarded");
          }
        }
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        fixture.respond(response, number === 1, fixture.model);
      } catch (error) {
        errors.push(error);
        if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Local protocol fixture did not match the expected request" } }));
      }
    });
    try {
      await fs.mkdir(validation, { recursive: true });
      directory = await fs.mkdtemp(path.join(validation, `protocol-${fixture.protocol}-`));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      port = server.address().port;
      await record({ type: "start", protocol: fixture.protocol, expectedMockRequests: 2, mockRequests: 0, inputTokens: 12000, contextWindowTokens: 20000, outputTokens: 1024 });
      host = await PiHost.create({
        directory, model: { id: fixture.model, protocol: fixture.protocol, baseUrl: `http://127.0.0.1:${port}${fixture.base}`, apiKey: key,
          inputTokens: 12000, contextWindowTokens: 20000, maxOutputTokens: 1024 },
        systemPrompt: "独立短样本，只读取所给的自有资料，然后说明读取结果。", onEvent: () => {},
        tools: [{ name: "read_resource", label: "读取自有资料", readOnly: true, description: "读取独立验证资料", parameters: {
          type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false,
        } }],
        invokeTool: async call => {
          tools.push(call);
          assert.equal(call.name, "read_resource");
          assert.deepEqual(call.args, { ref: "fixture" });
          return { ok: true, summary: "已读取自有资料", data: { text: evidence, ref: "fixture" } };
        },
      });
      const result = await host.prompt("读取自有资料后说明结果。", `own-protocol-task-${fixture.protocol}`);
      assert.equal(errors.length, 0, errors[0]?.message);
      assert.equal(bodies.length, 2);
      assert.equal(requestCount, 2);
      assert.equal(tools.length, 1);
      assert.equal(result.streaming, false);
      assert.match(result.text, /已读取自有资料/u);
      assert.equal(result.model, fixture.model);
      assert.equal(result.inputBudgetTokens, 12000);
      assert.equal(result.modelContextWindowTokens, 20000);
      assert.equal(result.outputReserveTokens, 1024);
      assert.ok(urls.every(url => url.origin === `http://127.0.0.1:${port}`));
      for (const file of await files(directory)) assert.ok(!(await fs.readFile(file, "utf8")).includes(key), "Mock key was persisted");
      passed = true;
    } catch (error) { failureName = error.name; throw error; }
    finally {
      if (host) await host.close().catch(() => {});
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await record({ type: "result", protocol: fixture.protocol, passed, mockRequests: requestCount, ...(failureName ? { failureName } : {}) });
    }
  });
}
