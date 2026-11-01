// Fetch transport only. Payloads, signatures, SSE parsing and retry remain Pi's.
import { randomUUID } from "node:crypto";

const MAX_BODY = 5 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024;
const AUTH_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "host", "content-length", "x-api-key", "x-goog-api-key", "api-key"]);
const abortError = () => new DOMException("模型请求已停止", "AbortError");
function invalid(code = "model_transport_failed") {
  const messages = { model_request_too_large: "单次模型请求超过本机传输大小，请先整理上下文或分段处理", model_request_limit: "本次模型请求已到所设上限，进度已保存", model_time_limit: "本次已到所设活动时间上限，进度已保存" };
  const error = new Error(messages[code] ?? "模型连接未完成，任务与草稿已保留");
  error.code = code;
  return error;
}
function bytes(encoded) {
  if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_CHUNK / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw invalid();
  const value = Buffer.from(encoded, "base64");
  if (value.length > MAX_CHUNK || value.toString("base64") !== encoded) throw invalid();
  return new Uint8Array(value);
}

export class NativeModelFetch {
  constructor(invoke) {
    if (typeof invoke !== "function") throw invalid();
    this.invoke = invoke;
    this.active = new Map();
  }
  async call(action, args, signal) {
    if (signal?.aborted) throw abortError();
    const result = await this.invoke(action, args, { signal });
    if (result?.ok !== true) {
      if (signal?.aborted || result?.error?.code === "cancelled") throw abortError();
      if (result?.error?.code === "model_timeout") {
        const error=new Error("模型等待超时，进度已保存，未自动重发");error.name="AbortError";error.code="model_timeout";throw error;
      }
      throw invalid(["model_request_limit", "model_time_limit", "model_request_too_large"].includes(result?.error?.code) ? result.error.code : undefined);
    }
    return result.data;
  }
  forget(state) {
    state.signal?.removeEventListener("abort", state.abort);
    this.active.delete(state.id);
  }
  async cancel(state, reason) {
    if (state.cancelled || state.ended) return;
    state.cancelled = true;
    this.forget(state);
    // The cancellation control itself must survive the already-aborted model
    // signal. The native task owner independently cancels every active stream.
    await this.call("cancel", { requestId: state.id, reason });
  }
  async fetch(input, options, { onRequest = () => {}, receipts = [], purpose = "model" } = {}) {
    let request;
    try { request = new Request(input, options); } catch { throw invalid("invalid_model_request"); }
    if (request.method !== "POST") throw invalid("invalid_model_request");
    if (request.signal.aborted) throw abortError();
    const body = Buffer.from(await request.arrayBuffer());
    if (body.length > MAX_BODY) throw invalid("model_request_too_large");
    const url = new URL(request.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw invalid("invalid_model_request");
    for (const name of ["key", "api_key", "apikey", "access_token"]) url.searchParams.delete(name);
    const headers = [...request.headers].filter(([name, value]) => !AUTH_HEADERS.has(name.toLowerCase()) && name.length <= 128 && value.length <= 8192);
    if (headers.length > 64) throw invalid("invalid_model_request");
    const state = { id: `model-${randomUUID()}`, signal: request.signal, controller: null, ended: false, cancelled: false };
    state.abort = () => {
      state.controller?.error(abortError());
      void this.cancel(state, "aborted").catch(() => {});
    };
    this.active.set(state.id, state);
    request.signal.addEventListener("abort", state.abort, { once: true });
    try {
      const reply = await this.call("start", { requestId: state.id, method: "POST", url: url.href, headers, body: body.toString("base64"), receipts, purpose }, request.signal);
      if (!Number.isInteger(reply?.status) || reply.status < 200 || reply.status > 599 || !Array.isArray(reply.headers)) throw invalid();
      onRequest(state.id);
      if ([204, 205, 304].includes(reply.status)) {
        await this.cancel(state, "consumer");
        return new Response(null, { status: reply.status, headers: reply.headers });
      }
      const stream = new ReadableStream({
        start: controller => { state.controller = controller; },
        pull: async controller => {
          try {
            if (state.cancelled || request.signal.aborted) throw abortError();
            const next = await this.call("read", { requestId: state.id }, request.signal);
            if (next?.done === true) {
              state.ended = true;
              this.forget(state);
              controller.close();
            } else {
              const data = bytes(next?.chunk);
              if (!data.length) throw invalid();
              controller.enqueue(data);
            }
          } catch (error) {
            controller.error(request.signal.aborted ? abortError() : error);
            void this.cancel(state, request.signal.aborted ? "aborted" : "read_failed").catch(() => {});
          }
        },
        cancel: () => this.cancel(state, request.signal.aborted ? "aborted" : "consumer"),
      }, { highWaterMark: 1 });
      // Native code has already checked the model binding, system TLS and
      // proxy, and removed sensitive response headers. No redirect is followed.
      return new Response(stream, { status: reply.status, headers: reply.headers });
    } catch (error) {
      void this.cancel(state, request.signal.aborted ? "aborted" : "start_failed").catch(() => {});
      throw request.signal.aborted ? abortError() : error;
    }
  }
  async recordUsage(ids, message) {
    const failed = ["error", "aborted"].includes(message?.stopReason);
    const accepted = !failed && message?.role === "assistant" && Array.isArray(message.content) && message.content.length > 0;
    let usage = failed ? {} : Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]
      .filter(key => Number.isSafeInteger(message?.usage?.[key]) && message.usage[key] >= 0).map(key => [key, message.usage[key]]));
    // Providers without usage leave Pi's zero-filled defaults. They are not an
    // actual report of a free request, even if the response itself succeeded.
    if (!Object.values(usage).some(value => value > 0)) usage = {};
    for (let index = 0; index < ids.length; index++) {
      await this.call("usage", { requestId: ids[index], status: failed || index < ids.length - 1 ? "failed" : "success", accepted: accepted && index === ids.length - 1, usage: index === ids.length - 1 ? usage : {} });
    }
  }
  async close() {
    await Promise.allSettled([...this.active.values()].map(state => this.cancel(state, "aborted")));
  }
}
