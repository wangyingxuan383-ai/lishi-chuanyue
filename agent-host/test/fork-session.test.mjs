import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPiSdk } from "../src/upstream.mjs";
import { forkSession } from "../src/fork-session.mjs";

// Full pinned SDK and temporary files only. No models, credentials or HTTP.
const pi = await loadPiSdk();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = content => ({ role: "user", content, timestamp: 1 });
const assistant = content => ({ role: "assistant", content, timestamp: 2, api: "openai-completions", provider: "fixture", model: "fixture", usage, stopReason: content.some(item => item.type === "toolCall") ? "toolUse" : "stop" });
const result = id => ({ role: "toolResult", toolCallId: id, toolName: "read_resource", content: [{ type: "text", text: "owned fixture" }], isError: false, timestamp: 3 });
const call = id => ({ type: "toolCall", id, name: "read_resource", arguments: { id: "own-card" } });
const text = value => ({ type: "text", text: value });

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lishi-pi-fork-"));
  try {
    const manager = pi.SessionManager.create(root, path.join(root, "source"));
    manager.appendModelChange("fixture", "fixture");
    await run({ root, manager, target: name => path.join(root, name), source: () => manager.getSessionFile() });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("fork before the first user returns an empty destination without serializing a synthetic Pi session", async () => fixture(async ({ root, manager, target, source }) => {
  const first = manager.appendMessage(user([text("原始要求"), { type: "image", data: "not-text", mimeType: "image/png" }, text("追加说明")]));
  manager.appendMessage(assistant([text("旧回复")]));
  const before = await fs.readFile(source());
  const fork = await forkSession({ sourceFile: source(), targetDirectory: target("empty"), entryId: first });
  assert.deepEqual(fork, { sessionFile: null, piSessionId: null, selectedUserText: "原始要求\n追加说明", keptEntryIds: [], keptToolCallIds: [] });
  assert.deepEqual(await fs.readdir(target("empty")), []);
  assert.deepEqual(await fs.readFile(source()), before);
  assert.ok(root);
}));

test("forking a later user uses Pi's branch file, preserves checkpoints and excludes the selected and following conversation", async () => fixture(async ({ manager, target, source }) => {
  const first = manager.appendMessage(user("最早要求"));
  const answer = manager.appendMessage(assistant([text("此前结果")]));
  const checkpoint = manager.appendCompaction("此前要求与进度", first, 100);
  const selected = manager.appendMessage(user("重新编辑的要求"));
  const excluded = manager.appendMessage(assistant([text("旧路线后续")]));
  const before = await fs.readFile(source());
  const fork = await forkSession({ sourceFile: source(), targetDirectory: target("new"), entryId: selected });
  assert.equal(fork.selectedUserText, "重新编辑的要求");
  assert.ok(fork.piSessionId && fork.piSessionId !== manager.getSessionId());
  assert.deepEqual(fork.keptEntryIds, manager.getBranch(checkpoint).map(entry => entry.id));
  assert.ok(fork.keptEntryIds.includes(answer));
  assert.ok(!fork.keptEntryIds.includes(selected) && !fork.keptEntryIds.includes(excluded));
  const reopened = pi.SessionManager.open(fork.sessionFile);
  assert.equal(reopened.getHeader().parentSession, source());
  assert.equal(reopened.getHeader().cwd, target("new"));
  assert.equal(reopened.getBranch().at(-1).id, checkpoint);
  assert.ok(reopened.getBranch().some(entry => entry.type === "compaction" && entry.summary === "此前要求与进度"));
  assert.deepEqual(await fs.readFile(source()), before);
}));

test("assistant tool boundary extends through every result and keeps a complete call group in original order", async () => fixture(async ({ manager, target, source }) => {
  manager.appendMessage(user("查两项资料"));
  const selected = manager.appendMessage(assistant([text("正在读取"), call("a"), call("b")]));
  const b = manager.appendMessage(result("b"));
  manager.appendCustomEntry("fixture-meta", { safe: true });
  const a = manager.appendMessage(result("a"));
  const excluded = manager.appendMessage(assistant([text("下一次模型的总结")]));
  const before = await fs.readFile(source());
  const fork = await forkSession({ sourceFile: source(), targetDirectory: target("full-group"), entryId: selected });
  assert.equal(fork.selectedUserText, null);
  assert.deepEqual(fork.keptToolCallIds, ["a", "b"]);
  assert.ok(fork.keptEntryIds.includes(b) && fork.keptEntryIds.includes(a));
  assert.ok(!fork.keptEntryIds.includes(excluded));
  const branch = pi.SessionManager.open(fork.sessionFile).getBranch();
  assert.equal(branch.at(-1).id, a);
  assert.deepEqual(branch.filter(entry => entry.type === "message").map(entry => entry.message.role), ["user", "assistant", "toolResult", "toolResult"]);
  assert.deepEqual(await fs.readFile(source()), before);
}));

test("incomplete, duplicate, unmatched and interrupted tool groups are rejected without changing the source", async () => {
  for (const variant of ["missing", "duplicate", "unmatched", "interrupted", "checkpoint", "duplicate-calls"]) {
    await fixture(async ({ manager, target, source }) => {
      manager.appendMessage(user("只在隔离会话中查证"));
      const selected = manager.appendMessage(assistant(variant === "duplicate-calls" ? [call("a"), call("a")] : [call("a"), call("b")]));
      manager.appendMessage(result("a"));
      if (variant === "duplicate") { manager.appendMessage(result("b")); manager.appendMessage(result("b")); }
      if (variant === "unmatched") manager.appendMessage(result("not-a-call"));
      if (variant === "interrupted") manager.appendMessage(user("插入另一消息"));
      if (variant === "checkpoint") manager.appendCompaction("不应切断调用", selected, 1);
      const before = await fs.readFile(source());
      await assert.rejects(forkSession({ sourceFile: source(), targetDirectory: target(variant), entryId: selected }), { code: "incomplete_tool_group" });
      assert.deepEqual(await fs.readFile(source()), before, variant);
      await assert.rejects(fs.stat(target(variant)), { code: "ENOENT" });
    });
  }
});

test("an inactive source branch or non-chat anchor cannot be selected", async () => fixture(async ({ manager, target, source }) => {
  const userId = manager.appendMessage(user("第一条要求"));
  const old = manager.appendMessage(assistant([text("旧分叉")]));
  manager.branch(userId);
  const meta = manager.appendCustomEntry("fixture-meta", {});
  manager.appendMessage(assistant([text("当前分叉")]));
  await assert.rejects(forkSession({ sourceFile: source(), targetDirectory: target("inactive"), entryId: old }), { code: "fork_anchor_not_active" });
  await assert.rejects(forkSession({ sourceFile: source(), targetDirectory: target("meta"), entryId: meta }), { code: "invalid_fork" });
}));

test("legacy, malformed and cyclic session files are rejected before public Pi open can migrate or alter them", async () => fixture(async ({ manager, target, source }) => {
  const first = manager.appendMessage(user("原始要求"));
  const original = await fs.readFile(source(), "utf8");
  const rows = original.trim().split("\n").map(JSON.parse);
  for (const variant of ["legacy", "duplicate-id", "cycle", "invalid-json"]) {
    const changed = structuredClone(rows);
    if (variant === "legacy") changed[0].version = 2;
    if (variant === "duplicate-id") changed.at(-1).id = changed[1].id;
    if (variant === "cycle") changed[1].parentId = changed.at(-1).id;
    const bytes = variant === "invalid-json" ? "{invalid" : changed.map(row => JSON.stringify(row)).join("\n") + "\n";
    const file = target(`${variant}.jsonl`);
    await fs.writeFile(file, bytes);
    await assert.rejects(forkSession({ sourceFile: file, targetDirectory: target(variant), entryId: first }));
    assert.equal(await fs.readFile(file, "utf8"), bytes);
    await assert.rejects(fs.stat(target(variant)), { code: "ENOENT" });
  }
}));

test("paths must be absolute, traversal-free and new, with no source or destination links", async () => fixture(async ({ root, manager, target, source }) => {
  const first = manager.appendMessage(user("原始要求"));
  await assert.rejects(forkSession({ sourceFile: `.${path.sep}relative.jsonl`, targetDirectory: target("relative"), entryId: first }), { code: "invalid_session_path" });
  await assert.rejects(forkSession({ sourceFile: source(), targetDirectory: `${root}${path.sep}child${path.sep}..${path.sep}traversal`, entryId: first }), { code: "invalid_session_path" });
  await fs.mkdir(target("existing"));
  await fs.writeFile(target("existing/keep.txt"), "preserve");
  await assert.rejects(forkSession({ sourceFile: source(), targetDirectory: target("existing"), entryId: first }), { code: "target_exists" });
  assert.equal(await fs.readFile(target("existing/keep.txt"), "utf8"), "preserve");
  // Directory junctions are available on Windows without Developer Mode.
  await fs.symlink(path.dirname(source()), target("linked-source"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(forkSession({ sourceFile: path.join(target("linked-source"), path.basename(source())), targetDirectory: target("source-link-rejected"), entryId: first }), { code: "invalid_session_path" });
  await fs.symlink(root, target("linked-parent"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(forkSession({ sourceFile: source(), targetDirectory: target("linked-parent/new"), entryId: first }), { code: "invalid_session_path" });
}));
