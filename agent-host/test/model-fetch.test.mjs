import test from "node:test";
import assert from "node:assert/strict";
import { NativeModelFetch } from "../src/model-fetch.mjs";

test("native pull transport preserves model bytes and opaque payloads without forwarding credentials", async () => {
  const calls = [], ids = [], chunks = ["data: ", "{\"opaque\":\"signed-fixture\"}\n\n"];
  const bridge = new NativeModelFetch(async (action, args) => {
    calls.push({ action, args });
    if (action === "start") return { ok: true, data: { status: 200, headers: [["content-type", "text/event-stream"]] } };
    if (action === "read") return { ok: true, data: chunks.length ? { chunk: Buffer.from(chunks.shift()).toString("base64"), done: false } : { done: true } };
    return { ok: true, data: {} };
  });
  const payload = JSON.stringify({ model: "fixture", signature: "opaque-field", messages: [{ role: "user", content: "中文要求" }] });
  const response = await bridge.fetch("https://model.invalid/v1/responses?key=OWNED-SECRET&alt=sse", { method: "POST", body: payload,
    headers: { Authorization: "Bearer OWNED-SECRET", "x-api-key": "OWNED-SECRET", Cookie: "OWNED-SECRET", "content-type": "application/json", "anthropic-beta": "fixture" } }, { onRequest: id => ids.push(id) });
  assert.equal(await response.text(), "data: {\"opaque\":\"signed-fixture\"}\n\n");
  assert.equal(Buffer.from(calls[0].args.body, "base64").toString(), payload);
  assert.ok(!JSON.stringify(calls).includes("OWNED-SECRET"));
  assert.ok(calls[0].args.url.endsWith("?alt=sse"));
  assert.ok(calls[0].args.headers.some(([name, value]) => name === "anthropic-beta" && value === "fixture"));
  assert.equal(ids.length, 1); assert.equal(bridge.active.size, 0);
  await bridge.recordUsage(ids, { stopReason: "toolUse", usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, private: "discard" } });
  assert.equal(calls.at(-1).action, "usage"); assert.equal(calls.at(-1).args.status, "success");
  assert.ok(!Object.hasOwn(calls.at(-1).args.usage, "private"));
  assert.equal(calls.at(-1).args.accepted, false, "usage alone cannot assert a model actually replied");
  await bridge.recordUsage(ids, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "成功答复但服务没报用量" }], usage: { input: 0, output: 0, totalTokens: 0 } });
  assert.deepEqual(calls.at(-1).args.usage, {});
  assert.equal(calls.at(-1).args.accepted, true, "a real reply and a missing usage report are separate facts");
  await bridge.close();
});

test("native stream cancellation does not reuse an aborted signal for the cleanup RPC", async () => {
  const cancelled = []; const abort = new AbortController();
  const bridge = new NativeModelFetch(async (action, args, options) => {
    if (action === "start") return { ok: true, data: { status: 200, headers: [] } };
    if (action === "cancel") { cancelled.push({ args, options }); return { ok: true, data: {} }; }
    if (action === "read") return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")), { once: true });
    });
  });
  const response = await bridge.fetch("https://model.invalid/v1", { method: "POST", body: "{}", signal: abort.signal });
  const reading = response.text(); abort.abort();
  await assert.rejects(reading, error => error.name === "AbortError");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled.length, 1); assert.equal(cancelled[0].args.reason, "aborted");
  assert.equal(cancelled[0].options.signal, undefined); assert.equal(bridge.active.size, 0);
});

test("malformed chunks and missing native admission fail without a direct fetch fallback", async () => {
  let reads = 0;
  const bridge = new NativeModelFetch(async action => {
    if (action === "start") return { ok: true, data: { status: 200, headers: [] } };
    if (action === "read") { reads++; return { ok: true, data: { done: false, chunk: "malformed!" } }; }
    return { ok: true, data: {} };
  });
  const response = await bridge.fetch("https://model.invalid/v1", { method: "POST", body: "{}" });
  await assert.rejects(response.text(), error => error.code === "model_transport_failed");
  assert.equal(reads, 1); await bridge.close();
  const unavailable = new NativeModelFetch(async () => ({ ok: false, error: { code: "gateway_failed", message: "untrusted provider detail" } }));
  await assert.rejects(unavailable.fetch("https://model.invalid/v1", { method: "POST", body: "{}" }), error => !error.message.includes("untrusted") && error.code === "model_transport_failed");
  await unavailable.close();
});

// Timeout is an interrupted, potentially billed request, never a provider retry.
test("native technical timeout is abort-shaped and never resends", async () => {
  let calls=0;
  const bridge=new NativeModelFetch(async action => {if(action==="start")calls++;return {ok:false,error:{code:"model_timeout",message:"本次模型首字节等待超时，请明确继续；没有自动重发"}}});
  await assert.rejects(bridge.fetch("https://model.invalid/v1",{method:"POST",body:"{}"}),e=>e.name==="AbortError"&&e.code==="model_timeout");
  assert.equal(calls,1); await bridge.close();
});
