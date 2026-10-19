import { Channel, invoke } from "@tauri-apps/api/core";
import { exit, onBackButtonPress } from "@tauri-apps/api/app";
import { PlatformError, type InstallStatus, type Platform, type StreamEvent, type UpdateEvent, type PdfText } from "./types";
import { orderedKeepAwake, setBrowserKeepAwake } from "./screenAwake";
import { cancellable } from "./bookFiles";

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const { code, message } = error as { code: string; message?: string };
      throw new PlatformError(code, message ?? code);
    }
    throw new PlatformError("ipc", String(error));
  }
}

// Back handlers form a stack: the most recently opened layer closes first.
const backHandlers: Array<() => boolean> = [];
const setNativeKeepAwake = orderedKeepAwake((enabled) => call<void>("plugin:notifications|set_keep_awake", { enabled }));
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
  return {
    name,
    sql: {
      query: (sql, params = []) => call("sql_query", { sql, params }),
      batch: (statements) =>
        call("sql_batch", { statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) }),
      backup: (label) => call("sql_backup", { label }),
      listBackups: () => call("sql_list_backups"),
      restore: (name) => call("sql_restore", { name }),
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
      exportText: (suggestedName, text) => call("file_export_text", { suggestedName, text }),
      importText: () => call("file_import_text"),
      importBook: async (signal, onProgress) => {
        if (signal?.aborted) throw new DOMException("已取消", "AbortError");
        const requestId = crypto.randomUUID(), channel = new Channel<number>();
        channel.onmessage = (bytes) => { if (!signal?.aborted) onProgress?.(bytes); };
        const abort = () => { void call("file_cancel_book", { requestId }).catch(() => {}); };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const file = await cancellable(call<{ name: string; data: string } | null>("file_import_book", { requestId, onProgress: channel }), signal);
          return file && { name: file.name, bytes: Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0)) };
        } finally { signal?.removeEventListener("abort", abort); }
      },
      extractPdf: async (bytes, signal) => {
        if (signal?.aborted) throw new DOMException("已取消", "AbortError");
        const requestId = crypto.randomUUID();
        const abort = () => { void call("file_cancel_book", { requestId }).catch(() => {}); };
        let raw = ""; for (let i = 0; i < bytes.length; i += 32768) raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
        signal?.addEventListener("abort", abort, { once: true });
        try { return await cancellable(call<PdfText>("file_extract_pdf", { data: btoa(raw), requestId }), signal); }
        finally { signal?.removeEventListener("abort", abort); }
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
      devSource: () => call("plugin:updates|dev_source"),
      setDevSource: (url) => call("plugin:updates|set_dev_source", { url }),
    },
    system: {
      storyCommitted: (completionId) => call("plugin:notifications|story_committed", { completionId }),
      setKeepAwake: (enabled) => name === "android" ? setNativeKeepAwake(enabled) : setBrowserKeepAwake(enabled),
      requestNotifications: () => call("plugin:notifications|request_notification_permission"),
      notificationStatus: () => call("plugin:notifications|notification_status"),
      openSystemSettings: (which) => call(which === "notifications" ? "plugin:notifications|open_notification_settings" : "plugin:notifications|open_app_settings"),
      openUrl: (url) => call("plugin:notifications|open_url", { url }),
      setSystemBars: (background, dark) =>
        name === "android" ? call("plugin:notifications|set_system_bars", { background, dark }) : Promise.resolve(),
      // Android: a native haptic, which needs no VIBRATE permission and follows the
      // system's touch-feedback switch. Elsewhere the web API, where it exists.
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
