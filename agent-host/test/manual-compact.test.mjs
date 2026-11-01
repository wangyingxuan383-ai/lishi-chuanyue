import test from "node:test";
import assert from "node:assert/strict";
import { createManualCompactControl } from "../src/manual-compact.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("busy external control aborts and waits for both idle and finalization before public Pi compact", async () => {
  const order = [], stopped = deferred(), finalized = deferred();
  const session = { isStreaming: true, isCompacting: false, compact: async instructions => {
    order.push("compact"); assert.equal(instructions, "保留完整要求"); return { summary: "Pi-owned summary", firstKeptEntryId: "same-cut" };
  } };
  const control = createManualCompactControl({ getSession: () => session,
    assertAvailable: ({ phase }) => order.push(phase), beforeCompact: () => order.push("reserve"),
    abort: async () => { order.push("abort"); await stopped.promise; session.isStreaming = false; },
    waitForIdle: async () => { order.push("wait-idle"); await finalized.promise; },
    afterCompact: state => { order.push("release"); assert.equal(state.interrupted, true); assert.equal(state.compacted, true); assert.equal(control.active, true); },
  });
  const running = control.compact("保留完整要求");
  assert.equal(control.active, true);
  assert.throws(() => control.assertCanPrompt(), { code: "manual_compact_busy" });
  await assert.rejects(control.compact("second"), { code: "manual_compact_busy" });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!order.includes("compact"));
  stopped.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(order.includes("wait-idle"));
  assert.ok(!order.includes("compact"));
  finalized.resolve();
  assert.deepEqual(await running, { summary: "Pi-owned summary", firstKeptEntryId: "same-cut" });
  assert.deepEqual(order, ["starting", "reserve", "abort", "wait-idle", "compacting", "compact", "release"]);
  assert.equal(control.active, false);
  control.assertCanPrompt();
});

test("idle control preserves the exact instructions and delegates once without abort or synthetic messages", async () => {
  let compacts = 0, aborts = 0;
  const instructions = "不要丢要求\n" + "长说明".repeat(10000);
  const session = { isStreaming: false, compact: async value => { compacts++; assert.equal(value, instructions); return { summary: "official" }; } };
  const control = createManualCompactControl({ getSession: () => session, abort: () => { aborts++; }, waitForIdle: async () => {} });
  assert.deepEqual(await control.compact(instructions), { summary: "official" });
  assert.equal(compacts, 1);
  assert.equal(aborts, 0);
  assert.deepEqual(Object.keys(session).sort(), ["compact", "isStreaming"]);
});

test("finishTurn and its asynchronous continuations reject reentrant compact without waiting for their own run", async () => {
  let calls = 0;
  const session = { isStreaming: true, compact: () => { calls++; } };
  const control = createManualCompactControl({ getSession: () => session, waitForIdle: () => { throw new Error("must not wait inside finishTurn"); } });
  await control.withTurnBoundary(async () => {
    await Promise.resolve();
    await assert.rejects(control.compact(), { code: "manual_compact_reentrant" });
  });
  assert.equal(calls, 0);
  assert.equal(control.active, false);
});

test("failed Pi compaction retains the previous checkpoint and releases the control fence exactly once", async () => {
  const checkpoint = { id: "original", summary: "keep" };
  const error = Object.assign(new Error("fixture budget exceeded"), { code: "input_budget_exceeded" });
  let after = 0;
  const session = { isStreaming: false, checkpoint, compact: async () => { throw error; } };
  const control = createManualCompactControl({ getSession: () => session, waitForIdle: async () => {}, afterCompact: state => {
    after++; assert.equal(state.compacted, false); assert.equal(state.error, error);
  } });
  await assert.rejects(control.compact(), received => received === error);
  assert.equal(session.checkpoint, checkpoint);
  assert.equal(after, 1);
  assert.equal(control.active, false);
  control.assertCanPrompt();
});

test("session replacement or an unfinished prompt cannot compact against the wrong live operation", async () => {
  let compacts = 0;
  const original = { isStreaming: false, compact: async () => { compacts++; } };
  let current = original;
  const changed = createManualCompactControl({ getSession: () => current, waitForIdle: async () => { current = { ...original }; } });
  await assert.rejects(changed.compact(), { code: "manual_compact_session_changed" });
  const busy = createManualCompactControl({ getSession: () => original, isRunning: () => true, abort: async () => {}, waitForIdle: async () => {} });
  await assert.rejects(busy.compact(), { code: "manual_compact_not_idle" });
  assert.equal(compacts, 0);
  assert.equal(changed.active, false);
  assert.equal(busy.active, false);
});

test("native finalization failure reports a possibly applied checkpoint and never repeats compact", async () => {
  let calls = 0, after = 0;
  const session = { compact: async () => { calls++; return { summary: "already applied" }; } };
  const control = createManualCompactControl({ getSession: () => session, waitForIdle: async () => {}, afterCompact: () => { after++; throw new Error("fixture native cleanup failed"); } });
  await assert.rejects(control.compact(), error => {
    assert.equal(error.code, "manual_compact_finalize_failed");
    assert.deepEqual(error.details, { compacted: true });
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(after, 1);
  assert.equal(control.active, false);
});

test("unavailable control fails before reserving native state and unlocks after rejection", async () => {
  let reserved = 0;
  const control = createManualCompactControl({ getSession: () => ({}), beforeCompact: () => { reserved++; } });
  await assert.rejects(control.compact(), { code: "manual_compact_unavailable" });
  assert.equal(reserved, 0);
  assert.equal(control.active, false);
});
