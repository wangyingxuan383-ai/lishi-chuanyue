import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PiHost } from "../src/host.mjs";
import { verifyRuntime } from "../src/artifacts.mjs";

const hostRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const record = async (value) => {
  const directory = path.join(hostRoot, ".cache/validation");
  await fs.mkdir(directory, { recursive: true });
  await fs.appendFile(path.join(directory, "ledger.jsonl"), JSON.stringify({ recordedAt: new Date().toISOString(), ...value }) + "\n");
};

test("full pinned Pi SDK executes native tool results, persists context and cancels streaming", { timeout: 35_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lishi-pi-host-"));
  const requests = [];
  let heldResolve;
  const held = new Promise((resolve) => { heldResolve = resolve; });
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const output = (delta, finish = null) => response.write(`data: ${JSON.stringify({
      id: `mock-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "isolated-pi",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
    const tool = (index, id, name, args) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
    if (requests.length === 1) {
      output({ role: "assistant", content: "先查资料，再准备修改。", tool_calls: [
        tool(0, "read-1", "read_resource", { id: "own-card" }),
        tool(1, "clock-1", "stage_clock", { year: 0 }),
      ] });
      output({}, "tool_calls");
    } else if (requests.length === 2) {
      output({ role: "assistant", tool_calls: [tool(0, "edit-1", "stage_edit", { text: "本局测试设定" })] });
      output({}, "tool_calls");
    } else if (requests.length === 5) {
      output({ role: "assistant", content: "正在等待更多内容" });
      heldResolve();
      return;
    } else {
      output({ role: "assistant", content: requests.length === 3 ? "已准备设定草稿，日期设置失败，尚未采用。" : "保留了上一轮的资料与草稿结果。" });
      output({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const events = [], calls = [];
  let draft;
  const model = { id: "isolated-pi", protocol: "chat-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "local-mock-secret-only", contextWindowTokens: 475_000, maxOutputTokens: 8192 };
  const tools = [
    { name: "read_resource", label: "读取本局资料", description: "读取已定位的本局资料", readOnly: true, parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
    { name: "stage_clock", label: "调整日期", description: "准备日期调整", readOnly: false, parameters: { type: "object", properties: { year: { type: "integer" } }, required: ["year"], additionalProperties: false } },
    { name: "stage_edit", label: "准备修改", description: "准备一份修改草稿", readOnly: false, parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  ];
  const options = { directory, model, tools, systemPrompt: "独立验证助手；只使用所给工具。解释与草稿分开，不宣称错误调用成功。", onEvent: (event) => events.push(event), invokeTool: async (call) => {
    calls.push(call);
    if (call.name === "read_resource") return { ok: true, summary: "已读取测试设定卡", data: { text: "旧设定", ref: "own-card" } };
    if (call.name === "stage_clock") return { ok: false, error: { code: "invalid_year", message: "日期设置失败：year须为正整数" } };
    draft = call.args.text;
    return { ok: true, summary: "设定草稿已准备，尚未采用", data: { staged: true, text: draft } };
  } };
  let host;
  try {
    host = await PiHost.create(options);
    assert.deepEqual(new Set(host.inspect().tools), new Set(tools.map((tool) => tool.name)));
    const first = await host.prompt("读取设定并准备修订，同时尝试日期设置。", "own-task-1");
    assert.equal(requests.length, 3);
    assert.equal(draft, "本局测试设定");
    assert.equal(calls.length, 3);
    assert.ok(JSON.stringify(requests[1].messages).includes("旧设定"));
    assert.ok(JSON.stringify(requests[1].messages).includes("own-card"));
    assert.ok(JSON.stringify(requests[1].messages).includes("invalid_year"));
    assert.ok(calls.every((call) => call.taskId === "own-task-1"));
    assert.match(first.text, /日期设置失败/);
    assert.ok(events.some(({ event }) => event.type === "tool_execution_end" && event.toolName === "stage_clock" && event.isError === true));
    assert.ok(events.some(({ event }) => event.type === "message_end" && event.message.role === "assistant"));
    const windows=events.filter(({event})=>event.type==='context_state').map(({event})=>event.data);
    assert.ok(windows.length>=3,'request and response boundaries must project current context');
    assert.ok(windows.every(w=>Number.isFinite(w.usedTokens)&&w.usedTokens>0));
    assert.ok(windows.at(-1).usedTokens>windows[0].usedTokens,'current usage must grow as messages and tools accumulate');
    assert.equal(windows.at(-1).effectiveInputBudgetTokens,466808);
    const sessionFile = host.inspect().sessionFile;
    assert.ok(sessionFile);
    const transcript = await fs.readFile(sessionFile, "utf8");
    assert.ok(transcript.includes("日期设置失败"));
    assert.ok(!transcript.includes(model.apiKey));
    assert.ok(!JSON.stringify(events).includes(model.apiKey));
    assert.equal((await fs.readdir(directory)).includes("auth.json"), false);
    assert.equal((await fs.readdir(directory)).includes("models.json"), false);
    await host.close();
    host = await PiHost.create({ ...options, sessionFile });
    await host.prompt("继续查阅此前结果。", "own-task-2");
    assert.equal(requests.length, 4);
    assert.ok(JSON.stringify(requests[3].messages).includes("本局测试设定"));
    const running = host.prompt("等待取消验证。", "own-task-3");
    await held;
    await host.abort();
    await assert.rejects(running,error=>error.code==="aborted");
    assert.equal(host.inspect().streaming, false);
    assert.equal(requests.length, 5);
    const result = { case: "sdk-tools-restore-cancel", ok: true, pinnedCommit: first.upstream.commit, fullSdk: true, mockRequests: requests.length, realRequests: 0, toolGatewayCalls: calls.length, failedToolReported: true, sourceTextAndRefDelivered: true, persistentContextRestored: true, cancellationPassed: true, credentialsNotPersisted: true };
    console.log(JSON.stringify(result));
    await record(result);
  } finally {
    await host?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // Only the explicitly owned temporary directory is removed, in one runtime.
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("lishi-pi-host-")) throw new Error("Unexpected temporary directory");
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("packaged stdio host preserves tool data and command framing", { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lishi-pi-stdio-"));
  const requests = [], records = [], waiting = new Map();
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = requests.length === 1
      ? { role: "assistant", tool_calls: [{ index: 0, id: "rpc-read", type: "function", function: { name: "read_resource", arguments: '{}' } }] }
      : { role: "assistant", content: "已读到实际资料；尚未修改故事。" };
    response.end(`data: ${JSON.stringify({ id: "rpc-mock", object: "chat.completion.chunk", created: 1, model: "rpc-mock", choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const child = spawn(process.execPath, [path.join(hostRoot, ".cache/runtime/host/src/entry.mjs")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PI_TELEMETRY: "true" } });
  const exited = once(child, "exit");
  let buffer = "", stderr = "", failure, passed = false;
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => {
    buffer += chunk; let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const item = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); records.push(item);
      if (item.type === "tool_request") send({ method: "tool_result", params: { requestId: item.requestId, result: { ok: true, summary: "读取完成", data: { text: "私有资料\u2028下一行中文", ref: "owned-rpc-ref" } } } });
      if (item.type === "response" && waiting.has(item.id)) { const pending = waiting.get(item.id); waiting.delete(item.id); clearTimeout(pending.timer); item.ok ? pending.resolve(item.data) : pending.reject(new Error(item.error.message)); }
    }
  });
  const command = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Host command timed out: ${method}`)); }, 15_000);
    waiting.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
  try {
    // U+2028 belongs inside JSON strings; only LF delimits host records.
    child.stdin.write('null\n');
    const created = await command("create", "create", { directory, model: { id: "rpc-mock", protocol: "chat-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "rpc-mock-key-only", inputTokens: 475_000, maxOutputTokens: 8192 }, systemPrompt: "独立协议检查，只读资料。", tools: [{ name: "read_resource", label: "读取资料", description: "读取自有测试资料", readOnly: true, parameters: { type: "object", properties: {}, additionalProperties: false } }] });
    assert.equal(created.modelWindowVerified, false); assert.equal(created.priceKnown, false);
    const result = await command("prompt", "prompt", { text: "读取资料\u2028并说明结果。", taskId: "own-stdio-task" });
    assert.match(result.text, /实际资料/); assert.equal(requests.length, 2);
    assert.ok(JSON.stringify(requests[1].messages).includes("owned-rpc-ref"));
    assert.ok(JSON.stringify(requests[1].messages).includes("私有资料"));
    assert.ok(records.some((item) => item.error?.code === "invalid_record"));
    assert.ok(!JSON.stringify(records).includes("rpc-mock-key-only"));
    const switched = await command("model", "setModel", { model: { id: "switched", protocol: "chat-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "rpc-mock-key-only", contextWindowTokens: 20_000, maxOutputTokens: 1000, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } } });
    assert.equal(switched.model, "switched"); assert.equal(switched.modelWindowConfigured, true); assert.equal(switched.modelWindowVerified, false); assert.equal(switched.outputReserveTokens, 1000); assert.equal(switched.priceKnown, true);
    await command("close", "close"); child.stdin.end();
    const [code] = await exited; assert.equal(code, 0, stderr); passed = true;
  } catch (error) { failure = error.message; throw error; }
  finally {
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error("Host test ended")); }
    if (!passed) child.kill();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await record({ case: "packaged-stdio", ok: passed, mockRequests: requests.length, realRequests: 0, error: failure, configuredPricePreserved: passed, modelWindowUpdated: passed, sourceDataDelivered: passed });
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("lishi-pi-stdio-")) throw new Error("Unexpected temporary directory");
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("runtime manifest rejects altered build artifacts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lishi-pi-manifest-"));
  const lock = JSON.parse(await fs.readFile(path.join(hostRoot, "upstream-lock.json"), "utf8"));
  try {
    await fs.cp(path.join(hostRoot, ".cache/runtime"), directory, { recursive: true });
    await verifyRuntime(directory, lock);
    await fs.appendFile(path.join(directory, "memory-credentials.mjs"), "\n// Changed after the recorded build\n");
    await assert.rejects(verifyRuntime(directory, lock), /checksum mismatch/);
    await record({ case: "artifact-manifest", ok: true, mockRequests: 0, realRequests: 0, alteredArtifactRejected: true });
  } finally {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("lishi-pi-manifest-")) throw new Error("Unexpected temporary directory");
    await fs.rm(directory, { recursive: true, force: true });
  }
});
