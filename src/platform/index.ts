import type { Platform } from "./types";

export * from "./types";

let current: Promise<Platform> | undefined;

/** Native shell when running inside Tauri, otherwise the browser dev harness. */
export function getPlatform(): Promise<Platform> {
  current ??= "__TAURI_INTERNALS__" in window
    ? import("./tauri").then((m) => m.createTauriPlatform())
    : import("./web").then((m) => m.createWebPlatform());
  return current;
}
