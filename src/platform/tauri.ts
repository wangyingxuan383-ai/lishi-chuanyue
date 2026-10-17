import { Channel, invoke } from "@tauri-apps/api/core";
import { exit, onBackButtonPress } from "@tauri-apps/api/app";
import { PlatformError, type Platform, type StreamEvent } from "./types";

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
    },
    system: {
      requestNotifications: () => call("plugin:notifications|request_notification_permission"),
      notificationStatus: () => call("plugin:notifications|notification_status"),
      openSystemSettings: (which) => call(which === "notifications" ? "plugin:notifications|open_notification_settings" : "plugin:notifications|open_app_settings"),
      openUrl: (url) => call("plugin:notifications|open_url", { url }),
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
