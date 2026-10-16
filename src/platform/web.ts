// Browser dev harness: sql.js persisted to IndexedDB, secrets and model
// requests through the local dev server (devserver/bridge.ts). Dev only.
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { sqlJsSql } from "./sqljs";
import { PlatformError, type Platform, type StreamEvent } from "./types";

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
    const request = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const saved = await idbGet<Uint8Array>(DB_KEY);
  const db = saved ? new SQL.Database(saved) : new SQL.Database();
  db.exec("PRAGMA foreign_keys = ON;");

  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => void idbPut(DB_KEY, db.export()), 1000);
  };
  window.addEventListener("pagehide", () => {
    clearTimeout(persistTimer);
    void idbPut(DB_KEY, db.export());
  });

  // Stream events are kept in memory so resume() behaves like the native cache.
  const streams = new Map<string, { events: StreamEvent[]; controller: AbortController; active: boolean }>();
  const backHandlers: Array<() => boolean> = [];
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (let i = backHandlers.length - 1; i >= 0; i--) if (backHandlers[i]()) return;
  });

  return {
    name: "web-dev",
    sql: sqlJsSql(db, {
      persist,
      async backup(label) {
        const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.sqlite`;
        await idbPut(`backup/${name}`, db.export());
        return name;
      },
    }),
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
    },
    files: {
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
      requestNotifications: async () => true,
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
