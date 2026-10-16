// Browser dev harness: sql.js persisted to IndexedDB, secrets and model
// requests through the local dev server (devserver/bridge.ts). Dev only.
import initSqlJs, { type Database, type SqlValue } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { PlatformError, type Json, type Platform, type Row, type StreamEvent } from "./types";

const IDB_NAME = "chuanyue-dev";
const IDB_STORE = "files";
const DB_KEY = "game.sqlite";
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

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

async function idbKeys(): Promise<string[]> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(IDB_STORE).objectStore(IDB_STORE).getAllKeys();
    request.onsuccess = () => resolve(request.result.map(String));
    request.onerror = () => reject(request.error);
  });
}

function toSql(value: Json): SqlValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  throw new PlatformError("sql_param_type", "SQL 参数只能是标量");
}

function fromSql(value: SqlValue): Json {
  if (value instanceof Uint8Array) throw new PlatformError("sql_blob_unsupported", "不支持 BLOB");
  if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) > MAX_SAFE) {
    throw new PlatformError("sql_integer_range", "整数超出安全范围");
  }
  return value;
}

function run(db: Database, sql: string, params: Json[]): Row[] {
  if (params.length === 0 && !/^\s*select/i.test(sql)) {
    db.exec(sql);
    return [];
  }
  const statement = db.prepare(sql);
  try {
    statement.bind(params.map(toSql));
    const rows: Row[] = [];
    while (statement.step()) {
      const row = statement.getAsObject();
      const out: Row = {};
      for (const [key, value] of Object.entries(row)) out[key] = fromSql(value);
      rows.push(out);
    }
    return rows;
  } finally {
    statement.free();
  }
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
    sql: {
      async query(sql, params = []) {
        const rows = run(db, sql, params);
        if (!/^\s*select/i.test(sql)) persist();
        return rows;
      },
      async batch(statements) {
        db.exec("BEGIN");
        try {
          for (const s of statements) run(db, s.sql, s.params ?? []);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error instanceof PlatformError ? error : new PlatformError("sql_failed", String(error));
        }
        persist();
      },
      async backup(label) {
        const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.sqlite`;
        await idbPut(`backup/${name}`, db.export());
        return name;
      },
      async listBackups() {
        const keys = (await idbKeys()).filter((key) => key.startsWith("backup/"));
        return keys
          .map((key) => ({ name: key.slice(7), at: key.slice(7, 31), size: 0 }))
          .sort((a, b) => b.name.localeCompare(a.name));
      },
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
