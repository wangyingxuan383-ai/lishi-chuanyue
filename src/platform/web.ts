// Browser dev harness: sql.js persisted to IndexedDB, secrets and model
// requests through the local dev server (devserver/bridge.ts). Dev only.
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { exportDatabase, sqlJsSql } from "./sqljs";
import { PlatformError, type Platform, type StreamEvent } from "./types";
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

async function idbDelete(key: string): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Backups live in IndexedDB as `backup/<name>` and hold `{ at, bytes }` (older ones: bare bytes).
type StoredBackup = { at: string; bytes: Uint8Array } | Uint8Array;
const BACKUP_PREFIX = "backup/";
const KEEP_BACKUPS = 20;

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
  // After a restore the stored database is the restored one; the page reloads
  // and nothing from the old in-memory copy may overwrite it.
  let restored = false;
  const persist = () => {
    clearTimeout(persistTimer);
    if (restored) return;
    persistTimer = setTimeout(() => void idbPut(DB_KEY, exportDatabase(db)), 1000);
  };
  window.addEventListener("pagehide", () => {
    clearTimeout(persistTimer);
    if (!restored) void idbPut(DB_KEY, exportDatabase(db));
  });
  // UI scripts save before reloading instead of waiting out the one-second debounce,
  // which a busy machine sometimes missed (the recap check in game-flow).
  if (import.meta.env.DEV) {
    (window as unknown as { __lishiFlush?: () => Promise<void> }).__lishiFlush = async () => {
      clearTimeout(persistTimer);
      if (!restored) await idbPut(DB_KEY, exportDatabase(db));
    };
  }

  const listBackups = async () => {
    const backups: { name: string; at: string; size: number }[] = [];
    for (const key of await idbKeys()) {
      if (!key.startsWith(BACKUP_PREFIX)) continue;
      const stored = await idbGet<StoredBackup>(key);
      if (!stored) continue;
      const bytes = stored instanceof Uint8Array ? stored : stored.bytes;
      const at = stored instanceof Uint8Array ? new Date(0).toISOString() : stored.at;
      backups.push({ name: key.slice(BACKUP_PREFIX.length), at, size: bytes.length });
    }
    return backups.sort((a, b) => (a.name < b.name ? 1 : -1));
  };
  const backup = async (label: string, keep?: string) => {
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.sqlite`;
    await idbPut(`${BACKUP_PREFIX}${name}`, { at: new Date().toISOString(), bytes: exportDatabase(db) });
    for (const old of (await listBackups()).slice(KEEP_BACKUPS)) {
      if (old.name !== keep) await idbDelete(`${BACKUP_PREFIX}${old.name}`);
    }
    return name;
  };
  // Same checks as the native SqlStore.restore: an intact database of this app, not from a newer version.
  const restore = async (name: string) => {
    const stored = await idbGet<StoredBackup>(`${BACKUP_PREFIX}${name}`);
    if (!stored) throw new PlatformError("sql_restore_missing", "没有这份备份");
    const bytes = stored instanceof Uint8Array ? stored : stored.bytes;
    const version = (database: InstanceType<typeof SQL.Database>) =>
      Number(database.exec("SELECT MAX(version) FROM schema_version")[0]?.values[0]?.[0] ?? 0);
    let candidate: number;
    try {
      const copy = new SQL.Database(bytes);
      try { candidate = version(copy); } finally { copy.close(); }
    } catch {
      candidate = 0;
    }
    if (!candidate) throw new PlatformError("sql_restore_invalid", "这份备份已损坏，或不是本应用的存档");
    let live = 0;
    try { live = version(db); } catch { /* an empty database has no schema yet */ }
    if (live && candidate > live) throw new PlatformError("sql_restore_newer", "这份备份来自更新版本的应用，请先更新");
    const saved = await backup("before-restore", name);
    clearTimeout(persistTimer);
    restored = true;
    await idbPut(DB_KEY, bytes);
    return saved;
  };

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
      backup: (label) => backup(label),
      listBackups,
      restore,
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
      // The dev harness reads public pages straight from the browser (GitHub allows it).
      getPublic,
      setNetwork: async () => {},
    },
    // The update sheet's download, simulated (webUpdate.ts): nothing is fetched or installed.
    update: simulatedUpdate(),
    files: {
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
