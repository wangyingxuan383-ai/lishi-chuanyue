import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stringLeavesHash, contextReceipts } from "../src/context-receipts.mjs";
import { childCallId } from "../src/children.mjs";

// Shared cross-language fixture: literal pointer ordering and JSON serialization
// are specified here independently of the traversal implementation.
const FIXTURE = { ok: true, data: {
  "a/b": "中文😀", "a~b": ["甲", 1.0, null, { "": "乙\n丙" }],
  "": { "~\/": "零" }, "\uE000": "BMP", "\u{10000}": "astral",
}, count: 1.0 };
const FIXTURE_LEAVES = [
  ["/data//~0~1", "零"],
  ["/data/a~0b/0", "甲"],
  ["/data/a~0b/3/", "乙\n丙"],
  ["/data/a~1b", "中文😀"],
  ["/data/\uE000", "BMP"],
  ["/data/\u{10000}", "astral"],
];
const FIXTURE_HASH = "5a61792cff86f4497149e00c325cb4037463a2739cbd60cd7983c95aebd8c627";
const hashOf = leaves => createHash("sha256").update(JSON.stringify(leaves), "utf8").digest("hex");
const result = (callId, value, extra = {}) => ({ role: "toolResult", toolCallId: callId, toolName: "read_original",
  content: [{ type: "text", text: JSON.stringify(value) }], ...extra });

test("string leaves use UTF-8 pointer order, JSON-pointer escaping, Unicode and deterministic numeric omission", () => {
  const expected = FIXTURE_HASH;
  assert.equal(hashOf(FIXTURE_LEAVES), expected);
  assert.equal(stringLeavesHash(FIXTURE), expected);
  const reordered = { count: 9.5, data: Object.fromEntries(Object.entries(FIXTURE.data).reverse()), ok: false };
  assert.equal(stringLeavesHash(reordered), expected, "number, boolean and object insertion order do not affect the hash");
  assert.equal(stringLeavesHash("中文😀"), hashOf([["", "中文😀"]]));
  assert.equal(stringLeavesHash([1, 1.0, false, null]), hashOf([]));
  assert.notEqual(stringLeavesHash(["a", "b"]), stringLeavesHash(["b", "a"]));
  assert.equal(stringLeavesHash(Array.from({ length: 12 }, (_, index) => `leaf-${index}`)), hashOf([
    ["/0", "leaf-0"], ["/1", "leaf-1"], ["/10", "leaf-10"], ["/11", "leaf-11"],
    ...Array.from({ length: 8 }, (_, index) => [`/${index + 2}`, `leaf-${index + 2}`]),
  ]));
});

test("depth, UTF-8 string bytes and leaf limits omit the whole hash instead of clipping", () => {
  const nested = depth => { let value = "leaf"; for (let index = 0; index < depth; index++) value = { child: value }; return value; };
  assert.match(stringLeavesHash(nested(32)), /^[0-9a-f]{64}$/);
  assert.equal(stringLeavesHash(nested(33)), null);
  const exactBytes = "中".repeat(43690) + "aa";
  assert.equal(Buffer.byteLength(exactBytes, "utf8"), 131072);
  assert.match(stringLeavesHash({ text: exactBytes }), /^[0-9a-f]{64}$/);
  assert.equal(stringLeavesHash({ text: exactBytes + "a" }), null);
  assert.match(stringLeavesHash(Array.from({ length: 4096 }, () => "")), /^[0-9a-f]{64}$/);
  assert.equal(stringLeavesHash(Array.from({ length: 4097 }, () => "")), null);
  const cycle = {}; cycle.self = cycle;
  assert.equal(stringLeavesHash(cycle), null);
  assert.equal(stringLeavesHash(undefined), null);
});

test("only one complete JSON tool-result text produces a small delivery receipt", () => {
  const complete = result("owned-call", FIXTURE, { details: { hidden: "must-not-be-hashed" } });
  const messages = [
    { role: "assistant", content: [{ type: "thinking", thinking: "secret internal text" }] },
    { role: "custom", customType: "summary", content: JSON.stringify(FIXTURE) },
    { ...complete, role: "assistant" },
    { ...complete, toolCallId: "details-only", content: [], details: FIXTURE },
    { ...complete, toolCallId: "multi-block", content: [...complete.content, { type: "text", text: "extra" }] },
    { ...complete, toolCallId: "truncated", content: [{ type: "text", text: '{"ok":true,"data":{"text":"truncated' }] },
    { ...complete, toolCallId: "summary", content: [{ type: "text", text: "原文已外置，请回读 callId" }] },
    result("error-message", FIXTURE, { isError: true }),
    result("error-value", { ok: false, error: { message: "native failure" } }),
    result("error-object", { error: { message: "native failure" } }),
    result("too-long", { data: "😀".repeat(32769) }),
    complete,
  ];
  const before = structuredClone(messages);
  assert.deepEqual(contextReceipts(messages), [{ callId: "owned-call", hash: hashOf(FIXTURE_LEAVES), tool: "read_original" }]);
  assert.deepEqual(messages, before);
  assert.ok(!JSON.stringify(contextReceipts(messages)).includes("中文"));
  assert.deepEqual(contextReceipts(null), []);
});

test("child receipts use the native child call namespace and do not grant a root call identity", () => {
  const actorId = "11111111-1111-4111-8111-111111111111";
  const message = result("same-local-call", { ok: true, data: { text: "原文片段" } });
  const root = contextReceipts([message])[0];
  const child = contextReceipts([message], { actorId })[0];
  assert.equal(root.callId, "same-local-call");
  assert.equal(child.callId, childCallId(actorId, "same-local-call"));
  assert.notEqual(root.callId, child.callId);
  assert.equal(root.hash, child.hash);
  assert.equal(child.tool, "read_original");
});

test("receipts deduplicate call identities, retain the last valid result, and cap at 2048 calls", () => {
  const initial = result("same", { data: { text: "first" } });
  const final = result("same", { data: { text: "final" } });
  assert.deepEqual(contextReceipts([initial, final, final]), [
    { callId: "same", hash: stringLeavesHash({ data: { text: "final" } }), tool: "read_original" },
  ]);
  const many = Array.from({ length: 2050 }, (_, index) => result(`call-${index}`, { data: `text-${index}` }));
  const receipts = contextReceipts(many);
  assert.equal(receipts.length, 2048);
  assert.equal(new Set(receipts.map(item => item.callId)).size, 2048);
  assert.equal(receipts.at(-1).callId, "call-2047");
  assert.ok(!receipts.some(item => item.callId === "call-2048"));
});
