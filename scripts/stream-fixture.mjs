// M01-T004: local, deterministic HTTP/SSE fixtures. No model calls or game state.
import http from "node:http";

const usage = "Usage: node scripts/stream-fixture.mjs [--port 18741]";
const args = process.argv.slice(2);
let port = 18741;
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  console.log(usage);
  process.exit(0);
}
if (args.length !== 0) {
  if (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1])) {
    console.error(usage);
    process.exit(1);
  }
  port = Number(args[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    console.error("Fixture port must be an integer from 1 to 65535.");
    process.exit(1);
  }
}

const scenarioNames = [
  "normal", "slow", "stall", "truncated", "malformed", "http-error",
  "invalid-utf8", "large-event",
];
const scenarios = Object.fromEntries(scenarioNames.map((name) => [name, {
  requests: 0,
  responsesCompleted: 0,
  responsesClosed: 0,
  clientDisconnects: 0,
  shutdownDisconnects: 0,
  activeResponses: 0,
}]));
const sockets = new Set();
const activeResponses = new Set();
let connectionsOpened = 0;
let connectionsClosed = 0;
let statsRequests = 0;
let shuttingDown = false;

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function openStream(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
}

function chunk(content, finished = false) {
  return JSON.stringify({
    id: "m01-loopback-fixture",
    object: "chat.completion.chunk",
    choices: [{
      index: 0,
      delta: finished ? {} : { content },
      finish_reason: finished ? "stop" : null,
    }],
  });
}

function event(data) {
  return Buffer.from(`data: ${data}\n\n`, "utf8");
}

function createResponseContext(response, scenario) {
  const timers = new Set();
  let closed = false;
  const counters = scenarios[scenario];
  counters.activeResponses += 1;
  const context = {
    timers,
    schedule(delay, callback) {
      if (closed || response.destroyed || response.writableEnded || shuttingDown) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!closed && !response.destroyed && !response.writableEnded && !shuttingDown) {
          callback();
        }
      }, delay);
      timers.add(timer);
    },
    clearTimers() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
  activeResponses.add(context);
  response.on("finish", () => { counters.responsesCompleted += 1; });
  response.on("close", () => {
    if (closed) return;
    closed = true;
    context.clearTimers();
    activeResponses.delete(context);
    counters.responsesClosed += 1;
    counters.activeResponses -= 1;
    if (!response.writableFinished) {
      if (shuttingDown) counters.shutdownDisconnects += 1;
      else counters.clientDisconnects += 1;
    }
  });
  // Deliberate cancellation/timeout may cause a response error; raw errors are not logged.
  response.on("error", () => { context.clearTimers(); });
  return context;
}

// Split the data: prefix, a multibyte UTF-8 character, and the closing blank line.
// All parts of one event finish within 40 ms; event starts remain 300/1000 ms apart.
function writeFragmented(response, context, bytes, afterWrite) {
  const unicodeByte = bytes.findIndex((value) => value >= 0x80);
  const cuts = [...new Set([
    0, 2, 7, unicodeByte >= 0 ? unicodeByte + 1 : 7, bytes.length - 1, bytes.length,
  ].filter((value) => value >= 0 && value <= bytes.length))].sort((a, b) => a - b);
  for (let index = 0; index < cuts.length - 1; index += 1) {
    const last = index === cuts.length - 2;
    context.schedule(index * 10, () => {
      response.write(bytes.subarray(cuts[index], cuts[index + 1]));
      if (last && afterWrite) afterWrite();
    });
  }
}

function sendSequence(response, context, values, intervalMs) {
  values.forEach((value, index) => {
    context.schedule(index * intervalMs, () => {
      writeFragmented(response, context, value, index === values.length - 1
        ? () => response.end()
        : undefined);
    });
  });
}

const server = http.createServer((request, response) => {
  request.on("error", () => {});
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    jsonResponse(response, 405, { error: "get_only" });
    return;
  }
  let pathname;
  try {
    pathname = new URL(request.url, "http://127.0.0.1").pathname;
  } catch {
    jsonResponse(response, 400, { error: "invalid_request" });
    return;
  }
  if (pathname === "/stats") {
    statsRequests += 1;
    jsonResponse(response, 200, {
      scenarios,
      connectionsOpened,
      connectionsClosed,
      activeConnections: sockets.size,
      statsRequests,
      pendingTimers: [...activeResponses].reduce((total, item) => total + item.timers.size, 0),
    });
    return;
  }
  const scenario = pathname.startsWith("/stream/") ? pathname.slice("/stream/".length) : "";
  if (!Object.hasOwn(scenarios, scenario)) {
    jsonResponse(response, 404, { error: "unknown_fixture" });
    return;
  }
  scenarios[scenario].requests += 1;
  // Fixed scenario names and counters only: no URL, query, headers, or request body.
  console.log(`fixture ${scenario}: request ${scenarios[scenario].requests}`);
  const context = createResponseContext(response, scenario);
  if (scenario === "http-error") {
    response.setHeader("Retry-After", "1");
    jsonResponse(response, 429, {
      error: { code: "rate_limit_fixture", message: "固定测试：请求上限。" },
    });
    return;
  }
  openStream(response);
  if (scenario === "stall") return;
  if (scenario === "normal" || scenario === "slow") {
    const texts = scenario === "normal"
      ? ["长安城的晨光", "照在石阶上。\n", "你握紧行囊，启程🙂。"]
      : ["慢速", "测试", "第一段。\n", "第二段", "仍在", "发送", "中文", "🙂结束。"];
    sendSequence(response, context, [
      ...texts.map((text) => event(chunk(text))),
      event(chunk(undefined, true)),
      event("[DONE]"),
    ], scenario === "normal" ? 300 : 1000);
    return;
  }
  if (scenario === "truncated") {
    sendSequence(response, context, [event(chunk("你走到")), event(chunk("城门前。"))], 300);
    return;
  }
  if (scenario === "malformed") {
    sendSequence(response, context, [event('{"choices":[broken-json}')], 300);
    return;
  }
  if (scenario === "invalid-utf8") {
    const bytes = Buffer.concat([
      Buffer.from('data: {"choices":[{"delta":{"content":"'),
      Buffer.from([0xc3, 0x28]), // Invalid continuation byte inside otherwise valid JSON.
      Buffer.from('"},"finish_reason":null}]}\n\n'),
    ]);
    sendSequence(response, context, [bytes], 300);
    return;
  }
  if (scenario === "large-event") {
    // More than 1 MiB before the event separator, for bounded-buffer rejection.
    sendSequence(response, context, [event(chunk("x".repeat(1024 * 1024)))], 300);
  }
});

server.on("connection", (socket) => {
  sockets.add(socket);
  connectionsOpened += 1;
  socket.on("close", () => {
    sockets.delete(socket);
    connectionsClosed += 1;
  });
});
server.keepAliveTimeout = 1000;
server.requestTimeout = 0;

function stop() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const context of activeResponses) context.clearTimers();
  if (server.listening) server.close(() => { console.log("SSE fixture stopped."); });
  for (const socket of sockets) socket.destroy();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("error", (error) => {
  console.error(error.code === "EADDRINUSE"
    ? `Fixture port ${port} is already in use; no existing process was changed.`
    : `Fixture could not listen on 127.0.0.1:${port}.`);
  process.exitCode = 1;
  stop();
});
server.listen(port, "127.0.0.1", () => {
  console.log(`SSE fixture listening on http://127.0.0.1:${port}`);
});
