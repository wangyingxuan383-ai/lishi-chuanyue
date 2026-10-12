// M01-T004 controlled POST/SSE service. Never accepts real credentials.
import http from "node:http";

const args = process.argv.slice(2);
let port = 18742;
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: node scripts/model-fixture.mjs [--port 18742]");
  process.exit(0);
}
if (args.length) {
  if (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1])) process.exit(1);
  port = Number(args[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
}
// This string is deliberately invalid for any model service. It is generated
// inside the native fixture path, never loaded from the platform secret store.
const fixtureToken = "invalid-m01-fixture-token";
const names = ["normal", "slow", "no-usage", "unauthorized", "rate-limit", "redirect",
  "malformed-usage", "truncated", "echo-secret", "stall", "large-truncated"];
const scenarios = Object.fromEntries(names.map(name => [name, {
  requests: 0, validated: 0, rejected: 0, finished: 0, disconnected: 0, active: 0,
  usageRequested: 0,
}]));
const sockets = new Set();
const contexts = new Set();
let shuttingDown = false;
let redirectedRequests = 0;

function json(response, status, value, extra = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store", ...extra });
  response.end(JSON.stringify(value));
}
function context(response, counts) {
  counts.active++;
  const timers = new Set();
  let closed = false;
  const ctx = {
    timers,
    later(ms, fn) {
      if (closed || shuttingDown) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!closed && !response.destroyed && !response.writableEnded && !shuttingDown) fn();
      }, ms);
      timers.add(timer);
    },
    clear() { for (const timer of timers) clearTimeout(timer); timers.clear(); },
  };
  contexts.add(ctx);
  response.on("finish", () => counts.finished++);
  response.on("close", () => {
    if (closed) return;
    closed = true;
    counts.active--;
    if (!response.writableFinished) counts.disconnected++;
    ctx.clear();
    contexts.delete(ctx);
  });
  response.on("error", () => ctx.clear());
  return ctx;
}
function frame(content, finish = false) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: finish ? {} : { content },
    finish_reason: finish ? "stop" : null }] })}\n\n`;
}
function usageFrame(value) { return `data: ${JSON.stringify({ choices: [], usage: value })}\n\n`; }
function sequence(response, ctx, frames, interval) {
  frames.forEach((text, index) => ctx.later(index * interval, () => {
    const bytes = Buffer.from(text);
    const unicode = bytes.findIndex(byte => byte >= 0x80);
    // Deliberately split a UTF-8 code point and the final framing newline.
    const cut = unicode >= 0 ? unicode + 1 : Math.min(7, bytes.length);
    response.write(bytes.subarray(0, cut));
    ctx.later(10, () => {
      response.write(bytes.subarray(cut, bytes.length - 1));
      ctx.later(10, () => {
        response.write(bytes.subarray(bytes.length - 1));
        if (index === frames.length - 1) response.end();
      });
    });
  }));
}
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("bounded_body");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function validBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const allowed = ["model", "messages", "stream", "stream_options"];
  if (Object.keys(body).some(key => !allowed.includes(key))) return false;
  if (typeof body.model !== "string" || !body.model.length || Buffer.byteLength(body.model) > 256
      || /[\s\p{Cc}]/u.test(body.model) || body.stream !== true) return false;
  if (!Array.isArray(body.messages) || body.messages.length !== 1) return false;
  const message = body.messages[0];
  if (!message || Object.keys(message).sort().join(",") !== "content,role"
      || message.role !== "user" || typeof message.content !== "string"
      || !Buffer.byteLength(message.content) || Buffer.byteLength(message.content) > 8192) return false;
  return body.stream_options === undefined || (body.stream_options &&
    Object.keys(body.stream_options).join(",") === "include_usage" &&
    body.stream_options.include_usage === true);
}

const server = http.createServer(async (request, response) => {
  request.on("error", () => {});
  // Only fixed path names and counters are exposed, never request strings,
  // authorization, prompts, response error bodies or arbitrary exception text.
  if (request.method === "GET" && request.url === "/stats") {
    json(response, 200, { scenarios, redirectedRequests, activeConnections: sockets.size,
      pendingTimers: [...contexts].reduce((sum, item) => sum + item.timers.size, 0) });
    return;
  }
  if (request.url === "/redirect-target") {
    redirectedRequests++;
    json(response, 500, { error: "redirect_must_not_be_followed" });
    return;
  }
  const match = /^\/([a-z-]+)\/v1\/chat\/completions$/.exec(request.url ?? "");
  const name = match?.[1];
  if (!name || !Object.hasOwn(scenarios, name)) {
    json(response, 404, { error: "unknown_fixture" });
    return;
  }
  const counts = scenarios[name];
  counts.requests++;
  const ctx = context(response, counts);
  if (request.method !== "POST" || request.headers.authorization !== `Bearer ${fixtureToken}`
      || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    counts.rejected++;
    json(response, 400, { error: "fixture_request_rejected" });
    return;
  }
  let body;
  try { body = await readBody(request); } catch {
    counts.rejected++;
    if (!response.destroyed) json(response, 400, { error: "fixture_request_rejected" });
    return;
  }
  if (!validBody(body)) {
    counts.rejected++;
    json(response, 400, { error: "fixture_request_rejected" });
    return;
  }
  const includeUsage = body.stream_options?.include_usage === true;
  counts.validated++;
  if (includeUsage) counts.usageRequested++;
  // Do not retain the body or headers in diagnostics.
  body = undefined;
  if (name === "unauthorized" || name === "rate-limit") {
    json(response, name === "unauthorized" ? 401 : 429,
      { error: { message: fixtureToken } }, name === "rate-limit" ? { "Retry-After": "1" } : {});
    return;
  }
  if (name === "redirect") {
    json(response, 307, { error: "fixed_redirect" }, { "Location": "/redirect-target" });
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store", "Connection": "keep-alive" });
  response.flushHeaders();
  if (name === "stall") return;
  if (name === "truncated" || name === "large-truncated") {
    sequence(response, ctx, [frame(name === "truncated" ? "未完成的技术响应。" : "史".repeat(4000))], 100);
    return;
  }
  if (name === "echo-secret") {
    sequence(response, ctx, [frame("安全前缀。"), frame("invalid-m01-"),
      frame("fixture-token"), frame("结束。"), "data: [DONE]\n\n"], 120);
    return;
  }
  const frames = (name === "slow" ? ["慢速", "认证", "请求。\n", "取消", "应停止", "本地", "连接", "🙂。"]
    : ["认证 POST 已验证。\n", "中文分片", "与🙂保持完整。"]).map(text => frame(text));
  frames.push(frame(undefined, true));
  if (name === "malformed-usage") {
    frames.push(usageFrame({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 999 }));
  } else if (includeUsage && name !== "no-usage") {
    frames.push(usageFrame({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));
  }
  frames.push("data: [DONE]\n\n");
  sequence(response, ctx, frames, name === "slow" ? 1000 : 120);
});
server.on("connection", socket => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.keepAliveTimeout = 500;
server.requestTimeout = 0;
function stop() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const ctx of contexts) ctx.clear();
  if (server.listening) server.close();
  for (const socket of sockets) socket.destroy();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("error", error => {
  console.error(error.code === "EADDRINUSE" ? "Fixture port is already occupied; no existing process changed."
    : "Fixture could not bind its loopback port.");
  process.exitCode = 1;
  stop();
});
server.listen(port, "127.0.0.1", () => console.log(`M01 POST fixture ready on 127.0.0.1:${port}`));
