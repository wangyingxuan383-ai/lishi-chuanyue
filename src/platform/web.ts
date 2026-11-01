import {assertSqlWritable,restoreWithFence} from "./sql-maintenance";
// Browser dev harness: SQLite and whole story runs live in the resident native
// host. IndexedDB is read only once for importing the previous browser store.
import { PlatformError, type BackupInfo, type ExecutionSnapshot, type Platform, type Row, type StreamEvent } from "./types";
import { assertLink, getPublic } from "./linkPolicy";
import { setBrowserKeepAwake } from "./screenAwake";
import { simulatedUpdate } from "./webUpdate";

const IDB_NAME = "chuanyue-dev";
const IDB_STORE = "files";
const DB_KEY = "game.sqlite";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(IDB_STORE);
    transaction.oncomplete = () => db.close();
    transaction.onabort = () => { db.close(); reject(transaction.error); };
    const request = transaction.objectStore(IDB_STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function bridge<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/__dev/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new PlatformError(payload?.code ?? "dev_bridge", payload?.message ?? `开发服务器返回 ${response.status}`);
  }
  return payload as T;
}

export async function createWebPlatform(): Promise<Platform> {
  const status = await bridge<{ empty: boolean }>("host/status", {});
  if (status.empty) {
    const saved = await idbGet<Uint8Array | ArrayBuffer>(DB_KEY);
    if (saved) {
      const bytes = saved instanceof Uint8Array ? saved : new Uint8Array(saved);
      if (bytes.length) {
        // Base64 expands the file. Refuse before allocating an oversized HTTP
        // body, leaving the previous store and its backups untouched.
        if (4 * Math.ceil(bytes.length / 3) + 32 > 64 * 1024 * 1024) {
          throw new PlatformError("sql_import_too_large", "旧开发台数据库超过导入上限，原数据仍保留在浏览器中");
        }
        // Keep both the old DB_KEY and every IndexedDB backup untouched. The
        // host rechecks emptiness under its SQL lock before the one-time copy.
        const chunks: string[] = [];
        for (let at = 0; at < bytes.length; at += 32768) chunks.push(String.fromCharCode(...bytes.subarray(at, at + 32768)));
        await bridge("host/importLegacy", { bytesBase64: btoa(chunks.join("")) });
      }
    }
  }
  // Existing developer scripts may still call flush before reloading. All SQL
  // writes now await durable host commits, so there is no browser debounce.
  if (import.meta.env.DEV) {
    (window as unknown as { __lishiFlush?: () => Promise<void> }).__lishiFlush = async () => { await bridge("host/status", {}); };
  }

  // Stream events are kept in memory so resume() behaves like the native cache.
  const streams = new Map<string, { events: StreamEvent[]; controller: AbortController; active: boolean }>();
  const backHandlers: Array<() => boolean> = [];
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (let i = backHandlers.length - 1; i >= 0; i--) if (backHandlers[i]()) return;
  });

  return {
    name: "web-dev",
    execution: {
      agent: (request) => bridge("host/pi_agent", { request }),
      settle: (state, record, options) => bridge("host/settle", { state, record, options }),
      context: (input) => bridge("host/context", { input }),
      start: (plan) => bridge<string>("host/start", { plan }),
      snapshot: (id, after = 0) => bridge<ExecutionSnapshot>("host/snapshot", { id, after }),
      list: () => bridge<{ id: string; worldId: string; status: string }[]>("host/list", {}),
      stop: (id) => bridge<void>("host/stop", { id }),
      resume: (id) => bridge<void>("host/resume", { id }),
    },
    sql: {
      query: (sql, params = []) => bridge<Row[]>("host/sqlQuery", { sql, params }),
      batch: (statements) => {assertSqlWritable();return bridge<void>("host/sqlBatch", { statements });},
      backup: (label) => bridge<string>("host/sqlBackup", { label }),
      listBackups: () => bridge<BackupInfo[]>("host/sqlListBackups", {}),
      restore: (name) => restoreWithFence(()=>bridge<string>("host/sqlRestore", { name })),
    },
    secrets: {
      set: (slot, value, boundBaseUrl) => bridge("secret/set", { slot, value, boundBaseUrl }),
      has: (slot) => bridge("secret/has", { slot }),
      remove: (slot) => bridge("secret/remove", { slot }),
    },
    llm: {
      async stream(request, onEvent) {
        // Match the native shell: an unbound URL is refused before any stream exists.
        const status = await bridge<{ configured: boolean; boundBaseUrl: string | null }>("secret/has", { slot: request.slot });
        const base = status.boundBaseUrl;
        if (base && !(request.url.startsWith(base) && ["", "/", "?"].includes(request.url.charAt(base.length)))) {
          throw new PlatformError("llm_url_not_bound", "请求地址与密钥绑定地址不符");
        }
        const streamId = crypto.randomUUID().replace(/-/g, "");
        const controller = new AbortController();
        const entry = { events: [] as StreamEvent[], controller, active: true };
        streams.set(streamId, entry);
        const emit = (event: StreamEvent) => {
          entry.events.push(event);
          if (event.type === "done" || event.type === "error") entry.active = false;
          onEvent(event);
        };
        void (async () => {
          try {
            const response = await fetch("/__dev/llm/stream", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(request),
              signal: controller.signal,
            });
            if (!response.body) throw new Error("empty body");
            const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = "";
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += value;
              let newline: number;
              while ((newline = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (line) emit(JSON.parse(line) as StreamEvent);
              }
            }
            if (entry.active) emit({ type: "error", kind: "network", message: "interrupted" });
          } catch {
            if (entry.active) {
              emit(controller.signal.aborted ? { type: "error", kind: "cancelled" } : { type: "error", kind: "network" });
            }
          }
        })();
        return streamId;
      },
      async cancel(streamId) {
        streams.get(streamId)?.controller.abort();
      },
      async resume(streamId) {
        const entry = streams.get(streamId);
        return entry ? { events: [...entry.events], active: entry.active } : null;
      },
      async list() {
        return [...streams].map(([streamId, entry]) => ({ streamId, finished: !entry.active, active: entry.active }));
      },
      async ack(streamId) {
        streams.get(streamId)?.controller.abort();
        streams.delete(streamId);
      },
      get: (request) => bridge("llm/get", request),
      // The dev harness reads public pages straight from the browser (GitHub allows it).
      getPublic,
      setNetwork: async () => {},
    },
    // The update sheet's download, simulated (webUpdate.ts): nothing is fetched or installed.
    update: simulatedUpdate(),
    files: {
      importSkillPackage() {
        return new Promise((resolve, reject) => {
          const input = Object.assign(document.createElement("input"), { type: "file", accept: ".zip,.md,.json" });
          input.onchange = () => void (async () => {
            try {
              const file = input.files?.[0];
              if (!file) { resolve(null); return; }
              if (file.size > 8 * 1024 * 1024) throw new Error("技能包最多 8 MiB");
              resolve({ name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) });
            } catch (error) { reject(error); }
          })();
          input.oncancel = () => resolve(null);
          input.click();
        });
      },
      importBook(signal, onProgress) {
        return new Promise((resolve, reject) => {
          const input = Object.assign(document.createElement("input"), { type: "file", accept: ".txt,.epub,.pdf,.docx" });
          const abort = () => { input.remove(); reject(new DOMException("已取消", "AbortError")); };
          if (signal?.aborted) { abort(); return; }
          signal?.addEventListener("abort", abort, { once: true });
          const finish = () => signal?.removeEventListener("abort", abort);
          input.onchange = () => void (async () => {
            try {
              const file = input.files?.[0];
              if (!file) { resolve(null); return; }
              if (file.size > 64 * 1024 * 1024) throw new Error("文件超过 64 MiB");
              const bytes = new Uint8Array(await file.arrayBuffer());
              onProgress?.(bytes.length);
              if (!signal?.aborted) resolve({ name: file.name, bytes });
            } catch (error) { reject(error); } finally { finish(); }
          })();
          input.oncancel = () => { finish(); resolve(null); };
          input.click();
        });
      },
      async extractPdf(bytes, signal) {
        const response = await fetch("/__dev/book/pdf", { method: "POST", body: bytes as BodyInit, signal, headers: { "Content-Type": "application/pdf" } });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error || "PDF 提取失败，请启动本地开发桥");
        return { pages: result.pages, headings: result.headings ?? [] };
      },
      async exportText(suggestedName, text) {
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const link = Object.assign(document.createElement("a"), { href: url, download: suggestedName });
        link.click();
        URL.revokeObjectURL(url);
        return true;
      },
      importText() {
        return new Promise((resolve) => {
          const input = Object.assign(document.createElement("input"), { type: "file" });
          input.onchange = () => void (input.files?.[0]?.text() ?? Promise.resolve(null)).then(resolve);
          input.oncancel = () => resolve(null);
          input.click();
        });
      },
    },
    system: {
      storyCommitted: async () => {},
      setKeepAwake: setBrowserKeepAwake,
      requestNotifications: async () => true,
      notificationStatus: async () => ({ granted: true, enabled: true }),
      openSystemSettings: async () => {},
      openUrl: async (url) => { assertLink(url, "browser"); window.open(url, "_blank", "noopener"); },
      setSystemBars: async () => {},
      haptic: async () => navigator.vibrate?.(10) ?? false,
      onBack(handler) {
        backHandlers.push(handler);
        return () => {
          const index = backHandlers.lastIndexOf(handler);
          if (index >= 0) backHandlers.splice(index, 1);
        };
      },
    },
  };
}
