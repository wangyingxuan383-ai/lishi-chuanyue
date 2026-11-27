import {assertSqlWritable,restoreWithFence} from "./sql-maintenance";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { exit, onBackButtonPress } from "@tauri-apps/api/app";
import {
  PlatformError,
  type Failure,
  type InstallStatus,
  type NotificationStatus,
  type NotifyPrefs,
  type OemFamily,
  type PdfText,
  type Platform,
  type StreamEvent,
  type SystemSettingsTarget,
  type UpdateEnvironmentStatus,
  type UpdateEvent,
  type UpdatePackageStatus,
} from "./types";
import { orderedKeepAwake, setBrowserKeepAwake } from "./screenAwake";
import { cancellable } from "./bookFiles";

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
const MUTATING_SQL_RE = /^\s*(?:WITH\b[\s\S]*?\)\s*)?(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA\s+\w+\s*=)/i;
const importedBookRequestIds = new WeakMap<Uint8Array, string>();

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64Chunked(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  }
  return btoa(chunks.join(""));
}

function coalescedSystemBars(send: (background: string, dark: boolean) => Promise<void>) {
  let inFlight = false;
  let nextArgs: { background: string; dark: boolean } | null = null;
  let drainPromise: Promise<void> | null = null;

  return (background: string, dark: boolean): Promise<void> => {
    nextArgs = { background, dark };
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      if (inFlight) return;
      inFlight = true;
      let lastError: unknown;
      let hasError = false;
      try {
        while (nextArgs) {
          const current = nextArgs;
          nextArgs = null;
          try {
            await send(current.background, current.dark);
            hasError = false;
            lastError = undefined;
          } catch (err) {
            hasError = true;
            lastError = err;
          }
        }
      } finally {
        inFlight = false;
        drainPromise = null;
      }
      if (hasError) throw lastError;
    })();
    return drainPromise;
  };
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const { code, message, failure } = error as { code: string; message?: string; failure?: Failure };
      throw new PlatformError(code, message ?? code, failure);
    }
    throw new PlatformError("ipc", String(error));
  }
}

// Back handlers form a stack: the most recently opened layer closes first.
const backHandlers: Array<() => boolean> = [];
const setNativeKeepAwake = orderedKeepAwake((enabled) => call<void>("plugin:notifications|set_keep_awake", { enabled }));
const setNativeVolumePageTurn = orderedKeepAwake((enabled) =>
  call<void>("plugin:notifications|set_volume_page_turn", { enabled }),
);
const setNativeSystemBars = coalescedSystemBars((background, dark) =>
  call<void>("plugin:notifications|set_system_bars", { background, dark }),
);
let backListening = false;
let escapeListening = false;

function listenBack() {
  if (!escapeListening) {
    escapeListening = true;
    // On Windows, Escape closes the newest layer like Android's back button, but never quits.
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      for (let i = backHandlers.length - 1; i >= 0; i--) if (backHandlers[i]()) return;
    });
  }
  if (backListening) return;
  backListening = true;
  void onBackButtonPress(() => {
    for (let i = backHandlers.length - 1; i >= 0; i--) {
      if (backHandlers[i]()) return;
    }
    void exit(0);
  }).catch(() => {
    backListening = false;
  });
}

export async function createTauriPlatform(): Promise<Platform> {
  const info = await call<{ platform: string }>("platform_info");
  const name = info.platform === "android" || info.platform === "windows" ? info.platform : "other";
  const supportsReminders = name === "android" || name === "windows";
  return {
    name,
    execution: {
      agent: (request) => call("pi_agent_request", { request }),
      companion: (request) => call("execution_companion", { request }),
      settle: (state, record, options) => call("execution_settle", { state, record, options }),
      context: (input) => call("execution_context", { input }),
      start: (plan) => call("execution_start", { plan }),
      snapshot: (id, after = 0) => call("execution_snapshot", { id, after }),
      list: () => call("execution_list"),
      stop: (id, executionId) => call("execution_stop", { id, executionId }),
      resume: (id) => call("execution_resume", { id }),
      subscribe(id, onEvent) {
        let active = true;
        let unlisten: (() => void) | null = null;
        void listen<{ runId?: string; seq?: number; event?: unknown }>("execution://event", (msg) => {
          if (!active) return;
          const payload = msg.payload;
          if (!payload || payload.runId !== id || !payload.event || typeof payload.event !== "object") return;
          onEvent({ seq: typeof payload.seq === "number" ? payload.seq : 0, event: payload.event as never });
        }).then((fn) => {
          if (!active) fn();
          else unlisten = fn;
        }).catch(() => {});
        return () => {
          active = false;
          unlisten?.();
          unlisten = null;
        };
      },
    },
    sql: {
      query: async (sql, params = []) => {
        if (MUTATING_SQL_RE.test(sql)) assertSqlWritable();
        return call("sql_query", { sql, params });
      },
      batch: (statements) => {assertSqlWritable();return call("sql_batch", { statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) });},
      backup: (label) => call("sql_backup", { label }),
      listBackups: () => call("sql_list_backups"),
      backupInventory: () => call("sql_backup_inventory"),
      deleteBackups: (names) => call("sql_delete_backups", { names }),
      restore: (name) => restoreWithFence(()=>call("sql_restore", { name })),
    },
    secrets: {
      set: (slot, value, boundBaseUrl) => call("secret_set", { slot, value, boundBaseUrl }),
      has: (slot) => call("secret_has", { slot }),
      remove: (slot) => call("secret_remove", { slot }),
    },
    llm: {
      stream: (request, onEvent) => {
        const channel = new Channel<StreamEvent>();
        channel.onmessage = onEvent;
        return call("llm_stream", { ...request, onEvent: channel });
      },
      cancel: (streamId) => call("llm_cancel", { streamId }),
      resume: (streamId) => call("llm_stream_resume", { streamId }),
      list: () => call("llm_stream_list"),
      ack: (streamId) => call("llm_stream_ack", { streamId }),
      get: (request) => call("llm_get", request),
      getPublic: (url, timeoutMs) => call("http_get_public", { url, timeoutMs }),
      setNetwork: (config) => call("network_set", { config: { proxy: config.proxy, proxyUrl: config.proxyUrl ?? null } }),
    },
    files: {
      exportWorld: (worldId, suggestedName) => call("file_export_world", { worldId, suggestedName }),
      exportBytes: async (defaultName, bytes, mime) => {
        if (bytes.byteLength > MAX_EXPORT_BYTES) {
          throw new PlatformError("file_too_large", "文件超过 64 MiB");
        }
        const bytesBase64 = encodeBase64Chunked(bytes);
        return call<boolean>("file_export_bytes", { defaultName, bytesBase64, mime });
      },
      grantAgentResource: (directory, writable) => call("file_grant_agent", { directory, writable }),
      exportText: (suggestedName, text) => call("file_export_text", { suggestedName, text }),
      importText: () => call("file_import_text"),
      importSkillPackage: async () => {
        const file = await call<{ name: string; data: string } | null>("file_import_skill");
        return file && { name: file.name, bytes: Array.from(decodeBase64Bytes(file.data)) };
      },
      importBook: async (signal, onProgress) => {
        if (signal?.aborted) throw new DOMException("已取消", "AbortError");
        const requestId = crypto.randomUUID(), channel = new Channel<number>();
        channel.onmessage = (bytes) => { if (!signal?.aborted) onProgress?.(bytes); };
        const abort = () => { void call("file_cancel_book", { requestId }).catch(() => {}); };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const file = await cancellable(call<{ name: string; data: string } | null>("file_import_book", { requestId, onProgress: channel }), signal);
          if (!file) return null;
          const bytes = decodeBase64Bytes(file.data);
          importedBookRequestIds.set(bytes, requestId);
          return { name: file.name, bytes };
        } finally { signal?.removeEventListener("abort", abort); }
      },
      extractPdf: async (bytes, signal) => {
        if (signal?.aborted) throw new DOMException("已取消", "AbortError");
        let requestId = crypto.randomUUID();
        const abort = () => { void call("file_cancel_book", { requestId }).catch(() => {}); };
        const cachedRequestId = importedBookRequestIds.get(bytes);
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (cachedRequestId) {
            try {
              return await cancellable(
                call<PdfText>("file_extract_pdf", { data: "", requestId, cachedRequestId }),
                signal,
              );
            } catch (err) {
              importedBookRequestIds.delete(bytes);
              if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
                throw err;
              }
              requestId = crypto.randomUUID();
            }
          }
          const data = encodeBase64Chunked(bytes);
          return await cancellable(call<PdfText>("file_extract_pdf", { data, requestId }), signal);
        } finally { signal?.removeEventListener("abort", abort); }
      },
    },
    update: {
      download: (request, onEvent) => {
        const channel = new Channel<UpdateEvent>();
        channel.onmessage = onEvent;
        return call("plugin:updates|download", { request, onEvent: channel });
      },
      cancel: () => call("plugin:updates|cancel"),
      fetchText: (url) => call("plugin:updates|fetch_text", { url }),
      install: async (request) => (await call<{ status: InstallStatus }>("plugin:updates|install", request)).status,
      canInstall: () => call("plugin:updates|can_install"),
      packageStatus: (request) => call<UpdatePackageStatus>("plugin:updates|package_status", request),
      environmentStatus: () => call<UpdateEnvironmentStatus>("plugin:updates|environment_status"),
      devSource: () => call("plugin:updates|dev_source"),
      setDevSource: (url) => call("plugin:updates|set_dev_source", { url }),
    },
    system: {
      storyCommitted: (completionId) => call("plugin:notifications|story_committed", { completionId }),
      ...(supportsReminders ? {
        notifyDone: (payload: { completionId: string; worldId?: string; title?: string; excerpt?: string }) =>
          call<void>("plugin:notifications|notify_done", payload),
        notifyFailed: (payload: { worldId?: string; title?: string; status?: string; line?: string; runId?: string }) =>
          call<void>("plugin:notifications|notify_failed", payload),
        setNotifyPrefs: (prefs: NotifyPrefs) => call<void>("plugin:notifications|set_notify_prefs", { ...prefs }),
        reminderStatus: () => call<{ sound: boolean; audible: boolean }>("plugin:notifications|reminder_status"),
        testReminder: () => call<void>("plugin:notifications|test_reminder"),
      } : {}),
      setKeepAwake: (enabled) => name === "android" ? setNativeKeepAwake(enabled) : setBrowserKeepAwake(enabled),
      requestNotifications: () => call("plugin:notifications|request_notification_permission"),
      notificationStatus: () => call<NotificationStatus>("plugin:notifications|notification_status"),
      openSystemSettings: (target: SystemSettingsTarget) => call("plugin:notifications|open_system_settings", { target }),
      openUrl: (url) => call("plugin:notifications|open_url", { url }),
      ...(name === "android" ? {
        backgroundStatus: () => call<{ ignoringBattery: boolean; xiaomi: boolean; oem?: OemFamily }>("plugin:notifications|background_status"),
        requestBatteryExemption: () => call<void>("plugin:notifications|request_battery_exemption"),
        openAutostart: () => call<void>("plugin:notifications|open_autostart_settings"),
        takeLaunchTarget: () => call<{ worldId: string | null; action: "read" | "resume" | null; runId?: string | null }>("plugin:notifications|take_launch_target"),
        openReminderSettings: () => call<void>("plugin:notifications|open_reminder_settings"),
        setVolumePageTurn: (enabled: boolean) => setNativeVolumePageTurn(enabled),
        ttsSpeak: (payload: { utteranceId: string; text: string; rate: number }) =>
          call<{ ok: boolean }>("plugin:notifications|tts_speak", payload).then((r) => !!r?.ok).catch(() => false),
        ttsStop: () => call<void>("plugin:notifications|tts_stop").catch(() => {}),
      } : {}),
      setSystemBars: (background, dark) =>
        name === "android" ? setNativeSystemBars(background, dark) : Promise.resolve(),
      haptic: () =>
        name === "android"
          ? call<boolean>("plugin:notifications|haptic")
          : Promise.resolve(navigator.vibrate?.(10) ?? false),
      onBack(handler) {
        backHandlers.push(handler);
        listenBack();
        return () => {
          const index = backHandlers.lastIndexOf(handler);
          if (index >= 0) backHandlers.splice(index, 1);
        };
      },
    },
  };
}
