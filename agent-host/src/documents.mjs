import { Worker } from "node:worker_threads";

const active = new Map();
export function cancelDocument(id) { const worker = active.get(id); if (worker) void worker.terminate(); }
export function closeDocuments() { for (const worker of active.values()) void worker.terminate(); active.clear(); }
export async function parseDocument(params) {
  if (typeof params?.id !== "string" || typeof params?.path !== "string" || active.has(params.id) || active.size >= 2) throw new Error("资料解析请求无效或仍在处理。");
  const worker = new Worker(new URL("./document-worker.mjs", import.meta.url), { workerData: params, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 2 } });
  active.set(params.id, worker);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { void worker.terminate(); reject(new Error("资料解析超时，已停止本次解析。")); }, 45000);
      const done = fn => value => { clearTimeout(timeout); fn(value); };
      worker.once("message", done(resolve));
      worker.once("error", done(() => reject(new Error("资料解析未完成，进度已保留。"))));
      worker.once("exit", done(() => reject(new Error("资料解析已停止。"))));
    });
  } finally { active.delete(params.id); await worker.terminate(); }
}
