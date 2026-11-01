import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiHost } from "../src/host.mjs";
import { childCallId } from "../src/children.mjs";

// These exercise the complete pinned Pi SDK. The native boundary below is an
// in-memory fixture: no sockets, HTTP service, private configuration or model.
// Native authorization itself is deliberately left to the Rust boundary tests.
const TASK = "owned-root-task";
const PARENT_CALL = "owned-delegate";
const CHILDREN = [
  { id: "11111111-1111-4111-8111-111111111111", name: "核对人物", prompt: "只查人物甲的身份", worldVersion: "owned-v1", providedDrafts: [{ index: 0, ref: "owned-draft-a" }] },
  { id: "22222222-2222-4222-8222-222222222222", name: "核对时间", prompt: "只查事件乙的日期", worldVersion: "owned-v1", providedDrafts: [] },
];
const deferred = () => {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
};
const tool = (name, readOnly = true) => ({ name, readOnly, description: name,
  parameters: { type: "object", properties: {}, additionalProperties: true } });
const READ_TOOLS = ["discover_tools", "list_resources", "read_resource", "read_tool_result", "list_skills", "read_skill", "read_provided_draft"].map(name => tool(name));
const call = (id, name, args) => ({ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const successful = data => ({ ok: true, data });

async function fixture(mode = "complete") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lishi-pi-children-"));
  const events = [], calls = [], requests = [], controls = [], sessions = new Map(), streams = new Map();
  const bothStarted = deferred(), bothHeld = deferred();
  const started = new Set(), held = new Set();
  let host, rootSession, maxActiveChildren = 0, catalog = READ_TOOLS;
  const activeChildren = new Set();
  const descriptor = id => CHILDREN.find(item => item.id === id);
  const transport = async (childId, action, args, options = {}) => {
    controls.push({ childId, action, requestId: args.requestId, args });
    if (action === "start") {
      const body = JSON.parse(Buffer.from(args.body, "base64").toString("utf8"));
      assert.equal(new URL(args.url).origin, "https://fixture.invalid");
      assert.ok(args.headers.every(([name]) => !["authorization", "x-api-key"].includes(name.toLowerCase())));
      requests.push({ childId, requestId: args.requestId, body });
      const count = requests.filter(request => request.childId === childId).length;
      let delta, finish = "stop", hold = false;
      if (!childId && count === 1) {
        delta = { role: "assistant", content: "分别核对人物与时间。", tool_calls: [call(PARENT_CALL, "delegate_readonly", {
          tasks: CHILDREN.map(({ name, prompt }) => ({ name, prompt })),
        })] };
        finish = "tool_calls";
      } else if (!childId) {
        assert.ok(count <= 2, "the root must not restart delegated children");
        const receipt = body.messages.find(message => message.role === "tool" && message.tool_call_id === PARENT_CALL);
        assert.ok(receipt, "the complete delegation tool result must be paired in the root transcript");
        const returned = JSON.parse(receipt.content);
        assert.equal(returned.ok, true);
        assert.equal(returned.data.reports.length, 2);
        if (mode === "complete") assert.ok(returned.data.reports.every(report => report.answered === true
          && report.text.includes(`source-${report.childId}`)));
        delta = { role: "assistant", content: mode === "steer" ? "已收到补充，保留未核实项。" : "已收到两项只读核对结果，未写入剧情。" };
      } else if (count === 1) {
        activeChildren.add(childId);
        maxActiveChildren = Math.max(maxActiveChildren, activeChildren.size);
        started.add(childId);
        if (started.size === 2) bothStarted.resolve();
        await bothStarted.promise;
        if (mode === "complete") {
          delta = { role: "assistant", tool_calls: [call("same-read-id", "read_resource", { id: `source-${childId}` })] };
          finish = "tool_calls";
        } else {
          delta = { role: "assistant", content: "正在读取核对资料。" };
          finish = null;
          hold = true;
        }
      } else {
        assert.equal(count, 2, "each child has only its own read and answer turns");
        assert.ok(body.messages.some(message => message.role === "tool" && message.tool_call_id === "same-read-id"
          && message.content.includes(`source-${childId}`)), "the child's actual tool result must reach its next request");
        delta = { role: "assistant", content: `${descriptor(childId).name}：资料来源 source-${childId}，已核对。` };
      }
      const chunk = { id: `memory-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "owned-children",
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        choices: [{ index: 0, delta, finish_reason: finish }] };
      streams.set(args.requestId, { childId, hold, chunks: [`data: ${JSON.stringify(chunk)}\n\n${hold ? "" : "data: [DONE]\n\n"}`] });
      return successful({ status: 200, headers: [["content-type", "text/event-stream"]] });
    }
    const stream = streams.get(args.requestId);
    if (action === "read") {
      assert.ok(stream, "the native reader must use its own admitted request");
      if (stream.chunks.length) return successful({ done: false, chunk: Buffer.from(stream.chunks.shift()).toString("base64") });
      if (!stream.hold) return successful({ done: true });
      held.add(childId);
      if (held.size === 2) bothHeld.resolve();
      return new Promise((resolve, reject) => {
        const abort = () => {
          options.signal?.removeEventListener("abort", abort);
          reject(new DOMException("owned cancellation", "AbortError"));
        };
        stream.release = abort;
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (action === "cancel") stream?.release?.();
    if (action === "usage" && childId) activeChildren.delete(childId);
    return successful({});
  };
  const invokeTool = async (request, options = {}) => {
    calls.push(request);
    assert.equal(request.sessionId, rootSession, "native authority remains the root session");
    assert.equal(request.taskId, TASK, "children share the root task and budget identity");
    if (request.childId) {
      assert.ok(descriptor(request.childId), "native child identity must be explicitly allocated");
      assert.equal(request.parentCallId, PARENT_CALL);
    }
    if (request.name.startsWith("__model_http_")) return transport(request.childId, request.name.slice("__model_http_".length), request.args, options);
    if (request.name === "delegate_readonly") {
      assert.equal(request.childId, undefined);
      assert.equal(request.toolCallId, PARENT_CALL);
      return successful({ children: CHILDREN, tools: catalog });
    }
    if (request.name === "__child_open") {
      assert.ok(!sessions.has(request.childId), "a child session must open once");
      sessions.set(request.childId, request.args.sessionFile);
      return successful({ opened: true });
    }
    if (request.name === "read_task_state") return successful({
      goal: descriptor(request.childId).prompt, corrections: [], plan: [],
      draftRefs: descriptor(request.childId).providedDrafts, skillRefs: [],
      intentRevision: 0, consumedIntentRevision: 0, storyVersion: "owned-v1",
    });
    if (request.name === "read_resource") {
      assert.equal(request.args.id, `source-${request.childId}`);
      return successful({ text: `核对资料 source-${request.childId}`, ref: `source-${request.childId}` });
    }
    if (request.name === "__child_finish") return successful({ childId: request.childId, answered: request.args.ok });
    if (request.name === "__children_finish") {
      assert.equal(request.childId, undefined);
      assert.equal(request.args.parentCallId, PARENT_CALL);
      const finished = calls.filter(item => item.name === "__child_finish");
      assert.equal(finished.length, 2, "native parent completion follows both child receipts");
      return successful({ reports: finished.map(item => ({ childId: item.childId, text: item.args.text, answered: item.args.ok })), goalCompleted: false });
    }
    throw new Error(`Unexpected fixture tool ${request.name}`);
  };
  try {
    host = await PiHost.create({ directory, nativeModelHttp: true,
      invokeModelHttp: (action, args, options) => transport(undefined, action, args, options),
      model: { id: "owned-children", protocol: "chat-completions", baseUrl: "https://fixture.invalid/v1",
        apiKey: "OWNED-IN-MEMORY-CHILD-FIXTURE", inputTokens: 12000, contextWindowTokens: 20000, maxOutputTokens: 1024 },
      systemPrompt: "独立夹具：将人物与时间交给两个只读助手，再报告实际结果。",
      tools: [tool("delegate_readonly", false)], invokeTool, onEvent: event => events.push(event),
    });
    rootSession = host.inspect().sessionId;
    return { host, directory, events, calls, requests, controls, sessions, bothStarted, bothHeld,
      get maxActiveChildren() { return maxActiveChildren; },
      setCatalog(value) { catalog = value; },
      async cleanup() {
        bothStarted.resolve();
        for (const stream of streams.values()) stream.release?.();
        await host.close();
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith("lishi-pi-children-"));
        await fs.rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await host?.close();
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test("two readonly delegates are independent full Pi sessions with root-scoped native calls and child-scoped events", { timeout: 20_000 }, async () => {
  const state = await fixture();
  try {
    const rootSession = state.host.inspect().sessionId;
    const result = await state.host.prompt("分别核对人物与时间；这些任务不应更改故事。", TASK);
    assert.match(result.text, /未写入剧情/);
    assert.equal(state.maxActiveChildren, 2, "both independent sessions must enter the model transport concurrently");
    assert.equal(state.requests.length, 6);
    assert.equal(state.sessions.size, 2);
    assert.equal(state.host.children.live.size, 0);
    const childSessionIds = new Set();
    for (const child of CHILDREN) {
      const sessionFile = state.sessions.get(child.id);
      assert.ok(path.relative(path.join(state.directory, "children", child.id), sessionFile)
        .split(path.sep).every(segment => segment !== ".."), "each transcript stays under its own child directory");
      const records = (await fs.readFile(sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const header = records.find(record => record.type === "session");
      assert.ok(header?.id && header.id !== rootSession);
      childSessionIds.add(header.id);
      assert.ok(records.some(record => record.type === "message" && record.message?.role === "toolResult"));
      const childRequests = state.requests.filter(request => request.childId === child.id);
      for (const request of childRequests) {
        const names = request.body.tools.map(item => item.function.name);
        for (const forbidden of ["finish_task", "delegate_readonly", "run_script", "bash", "write", "edit"]) assert.ok(!names.includes(forbidden));
        assert.deepEqual(new Set(names), new Set(READ_TOOLS.map(item => item.name)));
        const serialized = JSON.stringify(request.body);
        assert.ok(serialized.includes(child.prompt));
        assert.ok(!serialized.includes(CHILDREN.find(item => item.id !== child.id).prompt), "a sibling's prompt is not copied into this Pi session");
      }
      const childEvents = state.events.filter(record => record.childId === child.id);
      assert.ok(childEvents.length > 0);
      assert.ok(childEvents.every(record => record.sessionId === rootSession && record.taskId === TASK && record.parentCallId === PARENT_CALL));
      const toolEvents = childEvents.filter(record => record.event.type.startsWith("tool_execution_"));
      assert.ok(toolEvents.length >= 2);
      assert.ok(toolEvents.every(record => record.event.toolCallId === childCallId(child.id, "same-read-id")));
      const opened = state.calls.findIndex(item => item.name === "__child_open" && item.childId === child.id);
      const context = state.calls.findIndex(item => item.name === "read_task_state" && item.childId === child.id);
      const finished = state.calls.findIndex(item => item.name === "__child_finish" && item.childId === child.id);
      assert.ok(opened > 0 && context > opened && finished > context);
      assert.equal(state.calls[finished].args.ok, true);
      assert.match(state.calls[finished].args.text, new RegExp(`source-${child.id}`));
    }
    assert.equal(childSessionIds.size, 2);
    assert.equal(state.calls[0].name, "delegate_readonly");
    assert.equal(state.calls.at(-1).name, "__children_finish");
    assert.equal(state.controls.filter(item => item.action === "usage").length, 6);
    assert.ok(state.events.filter(record => !record.childId).every(record => record.sessionId === rootSession));
    assert.ok(!JSON.stringify(state.events).includes("OWNED-IN-MEMORY-CHILD-FIXTURE"));
  } finally { await state.cleanup(); }
});

test("root cancellation stops both active child Pi streams without starting another root request", { timeout: 20_000 }, async () => {
  const state = await fixture("cancel");
  let running;
  try {
    running = state.host.prompt("分派两项核对后停止。", TASK);
    const settled = running.then(value => ({ value }), error => ({ error }));
    await state.bothHeld.promise;
    await state.host.abort();
    const outcome = await settled;
    assert.equal(outcome.error?.code, "aborted", "an explicit stop is cancellation, not a provider failure");
    assert.equal(state.host.children.live.size, 0);
    assert.equal(state.host.inspect().streaming, false);
    assert.equal(state.requests.filter(item => !item.childId).length, 1);
    for (const child of CHILDREN) {
      assert.ok(state.controls.some(item => item.childId === child.id && item.action === "cancel"));
      assert.ok(!state.calls.some(item => item.childId === child.id && item.name === "__child_finish" && item.args.ok === true));
    }
  } finally { await state.cleanup(); await running?.catch(() => {}); }
});

test("steering the root stops stale child streams and Pi delivers the new requirement to the root", { timeout: 20_000 }, async () => {
  const state = await fixture("steer");
  let running;
  try {
    running = state.host.prompt("先分派两项核对。", TASK);
    await state.bothHeld.promise;
    await state.host.steer("新增要求：不要采用这些未完成的核对结果。");
    const result = await running;
    assert.match(result.text, /已收到补充/);
    assert.equal(state.host.children.live.size, 0);
    assert.equal(state.requests.filter(item => !item.childId).length, 2);
    const nextRoot = state.requests.filter(item => !item.childId)[1].body;
    assert.ok(nextRoot.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("不要采用这些未完成的核对结果")));
    for (const child of CHILDREN) {
      assert.ok(state.controls.some(item => item.childId === child.id && item.action === "cancel"));
      const receipt = state.calls.find(item => item.childId === child.id && item.name === "__child_finish");
      assert.equal(receipt?.args.ok, false);
    }
  } finally { await state.cleanup(); await running?.catch(() => {}); }
});

test("the child boundary rejects write, commit, recursive-delegate and script catalogs before creating a child", { timeout: 15_000 }, async () => {
  const state = await fixture();
  try {
    for (const forbidden of [tool("stage_edit", false), tool("finish_task"), tool("delegate_readonly"), tool("run_script")]) {
      state.setCatalog([...READ_TOOLS, forbidden]);
      await assert.rejects(state.host.children.delegate({ sessionId: state.host.inspect().sessionId, taskId: TASK,
        toolCallId: PARENT_CALL, name: "delegate_readonly", args: { tasks: [] } }), /Invalid readonly tool catalog/);
    }
    assert.equal(state.sessions.size, 0);
    assert.equal(state.requests.length, 0);
    assert.equal(state.host.children.live.size, 0);
  } finally { await state.cleanup(); }
});
