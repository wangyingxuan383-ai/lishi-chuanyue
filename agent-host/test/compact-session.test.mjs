import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiHost } from "../src/host.mjs";

// Complete pinned Pi SDK with an in-memory native transport. No socket, HTTP
// service or real model is involved. Fixed summaries test mechanics, not the
// quality of model compression or the production Rust quota implementation.
const TASK = "owned-compact-task";
const MODEL = "owned-compact-model";
const GOAL = "完整保留玩家原始要求：按已导入原著核对人物身份，保留玩家明确改写的分支。";
const FIRST_CORRECTION = "第一次补充：不要把核对说明写成正式剧情，不推进本局时间。";
const SECOND_CORRECTION = "第二次补充：找不到原著出处的地方必须说明资料不足。";
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function appendTurns(manager, start, count) {
  const appended = [];
  for (let turn = start; turn < start + count; turn++) {
    const timestamp = 1_700_000_000_000 + turn * 4;
    // Each complete turn is ~3300 Pi-estimated tokens. With the fixture's
    // existing 6000-token retained tail, cuts fall on user-message boundaries.
    const messages = [
      { role: "user", content: [{ type: "text", text: `owned-turn-${turn}\n${"known-context ".repeat(1000)}` }], timestamp },
      { role: "assistant", content: [{ type: "toolCall", id: `owned-read-${turn}`, name: "read_resource", arguments: { id: `owned-source-${turn}` } }],
        api: "openai-completions", provider: "lishi", model: MODEL, usage: emptyUsage(), stopReason: "toolUse", timestamp: timestamp + 1 },
      { role: "toolResult", toolCallId: `owned-read-${turn}`, toolName: "read_resource",
        content: [{ type: "text", text: `完整工具结果：owned-source-${turn}` }], isError: false, timestamp: timestamp + 2 },
      { role: "assistant", content: [{ type: "text", text: `第${turn}项资料已读取，未进行正式修改。` }],
        api: "openai-completions", provider: "lishi", model: MODEL, usage: emptyUsage(), stopReason: "stop", timestamp: timestamp + 3 },
    ];
    for (const message of messages) appended.push(manager.appendMessage(message));
  }
  return appended;
}

function assertPaired(messages) {
  const calls = new Map(), results = new Map();
  for (const message of messages) {
    if (message.role === "assistant") for (const block of message.content ?? []) {
      if (block.type === "toolCall") calls.set(block.id, (calls.get(block.id) ?? 0) + 1);
    }
    if (message.role === "toolResult") {
      assert.ok(calls.has(message.toolCallId), "a result cannot survive without its preceding assistant call");
      results.set(message.toolCallId, (results.get(message.toolCallId) ?? 0) + 1);
    }
  }
  assert.ok(calls.size > 0, "the retained projection must include real complete tool groups");
  assert.deepEqual([...calls].sort(), [...results].sort(), "compaction must not split, duplicate or omit a retained tool group");
}

const bodyText = body => body.messages.map(message => typeof message.content === "string" ? message.content
  : (message.content ?? []).map(block => block.text ?? "").join("\n")).join("\n");

test("two manual Pi compactions persist checkpoints, preserve tool groups and accumulate nonzero summary usage", { timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lishi-pi-compact-session-"));
  const requests = [], usages = [], events = [], replies = new Map(), summaries = [];
  let host, revision = 1, contextReads = 0;
  const options = {
    directory, nativeModelHttp: true, taskContext: true,
    model: { id: MODEL, protocol: "chat-completions", baseUrl: "https://fixture.invalid/v1", apiKey: "OWNED-COMPACT-MEMORY-ONLY",
      inputTokens: 12000, contextWindowTokens: 20000, maxOutputTokens: 1024 },
    systemPrompt: "仅为隔离的上下文整理夹具。", tools: [],
    invokeTool: () => { throw new Error("compaction must not execute a story tool"); },
    getTaskState: async ({ signal }) => {
      assert.equal(signal?.aborted ?? false, false);
      assert.equal(host.taskId, TASK);
      contextReads++;
      return { ok: true, data: { goal: GOAL,
        corrections: [{ text: FIRST_CORRECTION }, ...(revision === 2 ? [{ text: SECOND_CORRECTION }] : [])],
        intentRevision: revision, consumedIntentRevision: revision, plan: [{ id: "owned-plan", status: "in_progress" }],
        skillRefs: [{ id: "follow-original", version: "owned-v1" }], draftRefs: [{ id: "owned-draft" }], storyVersion: "owned-v1" } };
    },
    onEvent: event => events.push(event),
    invokeModelHttp: async (action, args) => {
      assert.equal(host.taskId, TASK, "summary requests retain the root task identity");
      if (action === "start") {
        assert.equal(new URL(args.url).origin, "https://fixture.invalid");
        assert.ok(args.headers.every(([name]) => !["authorization", "x-api-key"].includes(name.toLowerCase())));
        const body = JSON.parse(Buffer.from(args.body, "base64").toString("utf8"));
        requests.push({ requestId: args.requestId, body });
        assert.equal(body.stream, true);
        assert.ok(requests.length <= 2, "two manual checkpoints need exactly two fixture summary requests");
        const text = bodyText(body);
        assert.ok(text.includes(GOAL), "the complete original goal is reread before the summary request");
        assert.ok(text.includes(FIRST_CORRECTION));
        if (requests.length === 1) assert.ok(text.includes("第一次手动整理"));
        else {
          assert.ok(text.includes(SECOND_CORRECTION));
          assert.ok(text.includes("<previous-summary>"));
          assert.ok(text.includes(summaries[0]), "Pi receives its actual first checkpoint when updating the summary");
        }
        const summary = `固定摘要${requests.length}。原始目标：${GOAL} 补充：${FIRST_CORRECTION}${requests.length === 2 ? SECOND_CORRECTION : ""} 工具定位仍由正式会话保存。`;
        summaries.push(summary);
        const chunk = { id: `owned-summary-${requests.length}`, object: "chat.completion.chunk", created: 1, model: MODEL,
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          choices: [{ index: 0, delta: { role: "assistant", content: summary }, finish_reason: "stop" }] };
        replies.set(args.requestId, `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
        return { ok: true, data: { status: 200, headers: [["content-type", "text/event-stream"]] } };
      }
      if (action === "read") {
        const data = replies.get(args.requestId); replies.delete(args.requestId);
        return { ok: true, data: data ? { done: false, chunk: Buffer.from(data).toString("base64") } : { done: true } };
      }
      if (action === "usage") usages.push(args);
      return { ok: true, data: {} };
    },
  };
  try {
    host = await PiHost.create(options);
    assert.equal(host.inspect().upstream.commit, "973b74c55fcf096ad5976f8d8850c147ee2e62d4");
    const initialIds = appendTurns(host.manager, 1, 4);
    const originalMessages = structuredClone(host.manager.getEntries().filter(entry => entry.type === "message"));
    assertPaired(host.manager.buildSessionProjection().messages);
    const first = await host.compact("第一次手动整理：保留原始要求、补充及工具结果定位。", TASK);
    const firstCheckpoints = host.manager.getEntries().filter(entry => entry.type === "compaction");
    assert.equal(firstCheckpoints.length, 1);
    assert.equal(firstCheckpoints[0].summary, summaries[0]);
    assert.equal(firstCheckpoints[0].fromHook, false, "the official Pi summary generator created the checkpoint");
    assert.equal(first.firstKeptEntryId, firstCheckpoints[0].firstKeptEntryId);
    assert.ok(initialIds.includes(first.firstKeptEntryId));
    assert.equal(host.manager.getEntries().find(entry => entry.id === first.firstKeptEntryId).message.role, "user");
    assert.ok(first.tokensBefore > 6000);
    assert.equal(first.summaryChars, summaries[0].length);
    assert.equal(requests.length, 1);
    assert.equal(usages.length, 1);
    assertPaired(host.manager.buildSessionProjection().messages);
    assert.deepEqual(host.manager.getEntries().filter(entry => entry.type === "message"), originalMessages);

    revision = 2;
    appendTurns(host.manager, 5, 2);
    const beforeSecond = structuredClone(host.manager.getEntries().filter(entry => entry.type === "message"));
    const second = await host.compact(null, TASK); // Native optional instructions arrive as JSON null.
    const checkpoints = host.manager.getEntries().filter(entry => entry.type === "compaction");
    assert.equal(checkpoints.length, 2);
    assert.deepEqual(checkpoints[0], firstCheckpoints[0], "a later compaction cannot overwrite the first checkpoint");
    assert.equal(checkpoints[1].summary, summaries[1]);
    assert.notEqual(checkpoints[0].id, checkpoints[1].id);
    assert.equal(second.firstKeptEntryId, checkpoints[1].firstKeptEntryId);
    assert.notEqual(second.firstKeptEntryId, first.firstKeptEntryId);
    assert.deepEqual(host.manager.getEntries().filter(entry => entry.type === "message"), beforeSecond);
    assertPaired(host.manager.buildSessionProjection().messages);
    assertPaired(host.session.messages);
    assert.equal(contextReads, 2);
    assert.equal(requests.length, 2);
    assert.equal(new Set(requests.map(request => request.requestId)).size, 2);
    assert.deepEqual(usages.map(({ requestId, status, usage }) => ({ requestId, status, input: usage.input, output: usage.output })),
      requests.map(({ requestId }) => ({ requestId, status: "success", input: 10, output: 2 })));
    assert.equal(host.session.getSessionStats().tokens.input, 20);
    assert.equal(host.session.getSessionStats().tokens.output, 4);
    for (const checkpoint of checkpoints) {
      assert.equal(checkpoint.usage.input, 10);
      assert.equal(checkpoint.usage.output, 2);
    }
    const windows=events.filter(({event})=>event.type==='context_state').map(({event})=>event.data);
    assert.ok(windows.some(w=>w.compactions===1&&Number.isFinite(w.usedTokens)),'first compaction updates current usage');
    assert.equal(windows.at(-1).compactions,2);
    assert.ok(windows.at(-1).usedTokens>0);
    assert.ok(windows.at(-1).tokensBefore>0);
    assert.equal(events.filter(({ event }) => event.type === "compaction_start" && event.reason === "manual").length, 2);
    assert.equal(events.filter(({ event }) => event.type === "compaction_end" && event.reason === "manual" && event.aborted === false).length, 2);
    assert.equal(host.accountingWrites.size, 0);
    assert.equal(host.manualCompact.active, false);
    const sessionFile = host.inspect().sessionFile;
    const transcript = await fs.readFile(sessionFile, "utf8");
    assert.ok(!transcript.includes("OWNED-COMPACT-MEMORY-ONLY"));
    assert.ok(!transcript.includes('"customType":"lishi-task-state"'), "ephemeral task snapshots are not a second persisted transcript");
    await host.close(); host = null;
    host = await PiHost.create({ ...options, sessionFile });
    assert.equal(host.manager.getEntries().filter(entry => entry.type === "compaction").length, 2);
    assertPaired(host.manager.buildSessionProjection().messages);
    assert.equal(host.session.getSessionStats().tokens.input, 20);
    assert.equal(host.session.getSessionStats().tokens.output, 4);
    assert.equal(requests.length, 2, "opening the saved session must not repeat summaries");
  } finally {
    await host?.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("lishi-pi-compact-session-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
