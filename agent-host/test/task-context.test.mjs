import test from "node:test";
import assert from "node:assert/strict";
import { TaskContext, TASK_CONTEXT_TYPE, TASK_CONTEXT_VERSION, taskContextExtensions } from "../src/task-context.mjs";

const snapshot = (overrides = {}) => ({ ok: true, data: {
  goal: "读取原著，纠正本局设定，保留玩家主动改写。", corrections: [], plan: { steps: ["读取", "核对"] },
  draftRefs: [{ ref: "own-draft" }], skillRefs: [{ id: "canon", version: "1" }], requestedSkills: ["canon"],
  intentRevision: 1, consumedIntentRevision: 1, status: "running", resource: { worldId: "own-world", lineId: "own-line" },
  ...overrides,
} });
const decode = message => JSON.parse(message.content.slice(message.content.indexOf("\n") + 1));

test("only explicit taskContext enables the one inline extension and no user resources", async () => {
  let constructions = 0, flags;
  const handlers = new Map();
  class Loader {
    constructor(options) { constructions++; flags = options; }
    async reload() { await flags.extensionFactories[0].factory({ on: (type, handler) => handlers.set(type, handler) }); }
    getExtensions() { return { extensions: [{ path: "<inline:lishi-task-context>" }], errors: [], runtime: {} }; }
  }
  const pi = { DefaultResourceLoader: Loader };
  assert.equal(await taskContextExtensions(pi, { enabled: false }), null);
  assert.equal(await taskContextExtensions(pi, { enabled: "true" }), null);
  assert.equal(constructions, 0);
  const settings = { ownedMemorySettings: true };
  let reads = 0, taskId = null;
  const loaded = await taskContextExtensions(pi, {
    enabled: true, directory: "D:/own-task-only", settingsManager: settings,
    getTaskId: () => taskId, getTaskState: async () => { reads++; return snapshot(); },
  });
  assert.equal(constructions, 1);
  for (const key of ["noExtensions", "noSkills", "noThemes", "noPromptTemplates", "noContextFiles"]) assert.equal(flags[key], true);
  for (const key of ["additionalExtensionPaths", "additionalSkillPaths", "additionalThemePaths", "additionalPromptTemplatePaths", "appendSystemPrompt"]) assert.deepEqual(flags[key], []);
  assert.equal(flags.settingsManager, settings);
  assert.equal(flags.systemPrompt, "");
  assert.equal(flags.extensionFactories.length, 1);
  assert.equal(handlers.size, 2);
  assert.equal(await handlers.get("context")({ messages: [] }, {}), undefined);
  assert.equal(reads, 0, "Session creation must not read a task before attachment");
  taskId = "own-task";
  await handlers.get("context")({ messages: [] }, {});
  assert.equal(reads, 1);
  loaded.context.assertRequest();
});

test("every generation rereads native state without mutating or splitting full tool groups", async () => {
  let reads = 0;
  const task = new TaskContext({ getTaskId: () => "own-task", getTaskState: async () => snapshot({
    target: {nodeId:"selected", evidence:[{bookId:"book",section:2,quote:"already read"}]}, goal: `current-goal-${++reads}`, corrections: [{ text: `correction-${reads}`, intentRevision: reads }],
    intentRevision: reads, consumedIntentRevision: reads,
  }) });
  const messages = [
    { role: "user", content: [{ type: "text", text: "用户原文" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read_resource", arguments: {} }], timestamp: 2 },
    { role: "toolResult", toolCallId: "call-1", toolName: "read_resource", content: [{ type: "text", text: "工具原文" }], timestamp: 3 },
  ];
  const original = structuredClone(messages);
  const first = await task.prepare({ messages });
  assert.deepEqual(messages, original);
  assert.deepEqual(first.messages.slice(0, 3), original);
  assert.ok(first.messages.slice(0, 3).every((message, index) => message === messages[index]));
  assert.equal(first.messages[3].customType, TASK_CONTEXT_TYPE);
  assert.equal(first.messages[3].details.version, TASK_CONTEXT_VERSION);
  assert.equal(first.messages[3].display, false);
  assert.equal(first.messages[3].details.ephemeral, true);
  const second = await task.prepare({ messages: first.messages });
  assert.equal(reads, 2);
  assert.equal(second.messages.length, 4, "Only our prior ephemeral message is replaced");
  assert.equal(decode(second.messages[3]).goal, "current-goal-2");
  assert.equal(decode(second.messages[3]).target.evidence[0].quote, "already read");
  assert.deepEqual(decode(second.messages[3]).corrections, [{ text: "correction-2", intentRevision: 2 }]);
  assert.deepEqual(second.messages.slice(0, 3), original);
});

test("long goals and corrections remain whole and user text is never removed as a marker", async () => {
  const goal = "原始要求".repeat(20000), correction = "最新补充".repeat(10000);
  const task = new TaskContext({ getTaskId: () => "own-task", getTaskState: async () => snapshot({ goal, corrections: [{ text: correction }] }) });
  const user = { role: "user", content: `本次任务实时约束 ${TASK_CONTEXT_VERSION}。这仍是玩家的文字。` };
  const other = { role: "custom", customType: TASK_CONTEXT_TYPE, content: "another owner", details: { owner: "other-extension" } };
  const result = await task.prepare({ messages: [user, other] });
  assert.equal(result.messages[0], user);
  assert.equal(result.messages[1], other);
  const state = decode(result.messages[2]);
  assert.equal(state.goal, goal);
  assert.equal(state.corrections[0].text, correction);
});

test("failed or invalid native reads fail closed at the provider guard and recover only after a fresh success", async () => {
  let result = { ok: false, error: { message: "private-endpoint-must-not-be-echoed" } };
  const observed = [];
  const task = new TaskContext({ getTaskId: () => "own-task", getTaskState: async () => result, onError: error => observed.push(error) });
  const messages = [{ role: "user", content: "keep" }];
  assert.deepEqual((await task.prepare({ messages })).messages, messages);
  let requests = 0;
  const provider = () => { task.assertRequest(); requests++; };
  assert.throws(provider, error => error.code === "task_context_unavailable" && !error.message.includes("private-endpoint"));
  assert.equal(requests, 0);
  result = { ok: true, data: { goal: "missing required state" } };
  await task.prepare({ messages });
  assert.throws(provider, error => error.code === "task_context_unavailable");
  result = snapshot();
  await task.prepare({ messages });
  provider();
  assert.equal(requests, 1);
  assert.equal(task.lastError, null);
  assert.equal(observed.at(-1), null);
});

test("context reads share cancellation and cancelled work cannot reach the provider", async () => {
  const controller = new AbortController();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const task = new TaskContext({ getTaskId: () => "own-task", getTaskState: ({ signal }) => {
    assert.equal(signal, controller.signal);
    entered();
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled fixture")), { once: true }));
  } });
  const prepared = task.prepare({ messages: [] }, { signal: controller.signal });
  await ready;
  controller.abort();
  await prepared;
  assert.throws(() => task.assertRequest(), error => error.code === "task_context_cancelled");
  let reads = 0;
  const aborted = new TaskContext({ getTaskId: () => "own-task", getTaskState: async () => { reads++; return snapshot(); } });
  await aborted.prepare({ messages: [] }, { signal: controller.signal });
  assert.equal(reads, 0);
  assert.throws(() => aborted.assertRequest(), error => error.code === "task_context_cancelled");
});

test("inline extension load failures stop creation instead of quietly dropping task constraints", async () => {
  class BrokenLoader {
    async reload() {}
    getExtensions() { return { extensions: [], errors: [{ error: "fixture-load-failure" }] }; }
  }
  await assert.rejects(taskContextExtensions({ DefaultResourceLoader: BrokenLoader }, {
    enabled: true, directory: "D:/own-task", settingsManager: {}, getTaskId: () => "own-task", getTaskState: async () => snapshot(),
  }), error => error.code === "task_context_unavailable");
});

test("compaction rereads constraints for temporary summary and split-prefix requests without changing history", async () => {
  let reads = 0;
  const task = new TaskContext({ getTaskId: () => "own-task", getTaskState: async () => { reads++; return snapshot(); } });
  const history = [
    { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read_resource", arguments: {} }] },
    { role: "toolResult", toolCallId: "call-1", toolName: "read_resource", content: [{ type: "text", text: "original" }] },
  ];
  const original = structuredClone(history);
  const prefix = [{ role: "user", content: "recent turn" }];
  const preparation = { messagesToSummarize: history, turnPrefixMessages: prefix, isSplitTurn: true, firstKeptEntryId: "same-cut", tokensBefore: 1000 };
  assert.equal(await task.prepareCompaction({ preparation }), undefined);
  assert.equal(reads, 1);
  assert.deepEqual(history, original);
  assert.deepEqual(prefix, [{ role: "user", content: "recent turn" }]);
  assert.deepEqual(preparation.messagesToSummarize.slice(0, 2), original);
  assert.equal(preparation.turnPrefixMessages[0], prefix[0]);
  assert.deepEqual(decode(preparation.messagesToSummarize.at(-1)), decode(preparation.turnPrefixMessages.at(-1)));
  assert.equal(preparation.firstKeptEntryId, "same-cut");
  assert.equal(preparation.tokensBefore, 1000);
  await task.prepareCompaction({ preparation });
  assert.equal(reads, 2);
  assert.equal(preparation.messagesToSummarize.length, 3);
  assert.equal(preparation.turnPrefixMessages.length, 2);
  const noSplit = { messagesToSummarize: history, turnPrefixMessages: [], isSplitTurn: false };
  await task.prepareCompaction({ preparation: noSplit });
  assert.deepEqual(noSplit.turnPrefixMessages, [], "Do not manufacture another summary request");
});

test("failed compaction reads cancel before summaries and preserve the previous preparation", async () => {
  const task = new TaskContext({ getTaskId: () => "own-task", getTaskState: async () => { throw new Error("fixture read failure"); } });
  const preparation = { messagesToSummarize: [{ role: "user", content: "keep" }], turnPrefixMessages: [], isSplitTurn: false };
  const original = structuredClone(preparation);
  assert.deepEqual(await task.prepareCompaction({ preparation }), { cancel: true });
  assert.deepEqual(preparation, original);
  assert.throws(() => task.assertRequest(), error => error.code === "task_context_unavailable");
});
