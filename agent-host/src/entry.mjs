import { Socket } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { PiHost } from "./host.mjs";
import { forkSession } from "./fork-session.mjs";
import { parseDocument, cancelDocument, closeDocuments } from "./documents.mjs";

const fdIndex = process.argv.indexOf("--transport-fd");
const fd = fdIndex < 0 ? undefined : Number(process.argv[fdIndex + 1]);
if (fd !== undefined && (!Number.isSafeInteger(fd) || fd < 3)) throw new Error("Invalid transport fd");
const socket = fd === undefined ? undefined : new Socket({ fd, readable: true, writable: true });
const input = socket ?? process.stdin, output = socket ?? process.stdout;
let host, buffer = "", creating = false, ended = false;
const pending = new Map();
const send = async (value) => {
  if (ended) return;
  if (!output.write(JSON.stringify(value) + "\n")) await once(output, "drain");
};
async function shutdown() {
  if (ended) return;
  ended = true;
  for (const call of pending.values()) {
    call.signal?.removeEventListener("abort", call.stop);
    call.reject(new Error("Host transport closed"));
  }
  pending.clear();
  closeDocuments();
  await host?.close().catch(() => {});
}

async function invokeTool(request, { signal }) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const stop = () => { pending.delete(requestId); reject(new Error("Tool cancelled")); void send({ type: "tool_cancel", requestId }); };
    if (signal?.aborted) { reject(new Error("Tool cancelled")); return; }
    pending.set(requestId, { resolve, reject, signal, stop });
    signal?.addEventListener("abort", stop, { once: true });
    void send({ type: "tool_request", requestId, ...request }).catch((error) => {
      pending.delete(requestId);
      signal?.removeEventListener("abort", stop);
      reject(error);
    });
  });
}

async function dispatch(record) {
  const { id, method, params = {} } = record;
  try {
    if (method === "tool_result") {
      const call = pending.get(params.requestId);
      if (!call) throw new Error("Unknown or cancelled tool request");
      pending.delete(params.requestId);
      call.signal?.removeEventListener("abort", call.stop);
      call.resolve(params.result);
      return;
    }
    let data;
    if (method === "parse_document") {
      if (!host?.taskId || params.taskId !== host.taskId) throw new Error("资料解析不属于当前任务。");
      data = await parseDocument(params);
    } else if (method === "cancel_document") {
      cancelDocument(params.id); data = { cancelled: true };
    } else if (method === "fork_session") {
      if (host || creating) throw new Error("Stop and close the active session before branching");
      creating = true;
      try { data = await forkSession(params); } finally { creating = false; }
    } else if (method === "create") {
      if (host || creating) throw new Error("A host is already open or opening");
      creating = true;
      try {
        host = await PiHost.create({ ...params, invokeTool,
          invokeModelHttp: (action, args, { signal } = {}) => {
            if (!host?.taskId) throw new Error("No native task is attached");
            return invokeTool({ sessionId: host.session.sessionId, taskId: host.taskId,
              toolCallId: `http-${randomUUID()}`, name: `__model_http_${action}`, args }, { signal });
          },
          getTaskState: async ({ signal } = {}) => {
            if (!host?.taskId) return null;
            return invokeTool({ sessionId: host.session.sessionId, taskId: host.taskId,
              toolCallId: `context-${randomUUID()}`, name: "read_task_state", args: {} }, { signal });
          },
          onEvent: (event) => void send({ type: "event", ...event }).catch(shutdown) });
      } finally { creating = false; }
      if (ended) { await host.close(); host = undefined; return; }
      data = host.inspect();
    } else {
      if (!host) throw new Error("Create a session first");
      switch (method) {
        case "prompt": data = await host.prompt(params.text, params.taskId); break;
        case "steer": await host.steer(params.text); break;
        case "followUp": await host.followUp(params.text); break;
        case "abort": await host.abort(); break;
        case "compact": data = await host.compact(params.instructions, params.taskId); break;
        case "setModel": await host.setModel(params.model); data = host.inspect(); break;
        case "inspect": data = host.inspect(); break;
        case "close": await host.close(); host = undefined; break;
        default: throw new Error("Unknown host command");
      }
    }
    await send({ type: "response", id, ok: true, data: data ?? null });
  } catch (error) {
    await send({ type: "response", id, ok: false, error: { code: error.code ?? "host_error", message: error.message, ...(error.details ? { details: error.details } : {}) } });
  }
}
input.setEncoding("utf8");
input.on("data", (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer, "utf8") > 8 * 1024 * 1024) { input.destroy(new Error("Host record too large")); return; }
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).replace(/\r$/, ""); buffer = buffer.slice(at + 1);
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.method !== "string") throw new Error("Invalid command");
      void dispatch(record).catch(shutdown);
    } catch { void send({ type: "response", ok: false, error: { code: "invalid_record", message: "Invalid JSON record" } }).catch(shutdown); }
  }
});
input.on("end", () => { void shutdown(); });
input.on("error", () => { void shutdown(); });
