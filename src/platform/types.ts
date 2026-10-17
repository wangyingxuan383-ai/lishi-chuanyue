// Platform services shared by the Tauri shell and the browser dev harness.
// Contract: docs/contracts/PLATFORM.md

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Row = Record<string, Json>;

export interface SqlStatement {
  sql: string;
  params?: Json[];
}

export interface BackupInfo {
  name: string;
  at: string;
  size: number;
}

export type StreamErrorKind =
  | "network"
  | "timeout_first"
  | "timeout_idle"
  | "timeout_total"
  | "http"
  | "cancelled"
  | "too_large"
  | "secret_echo"
  | "url_not_bound"
  | "no_secret";

export type StreamEvent =
  | { type: "open"; status: number }
  | { type: "data"; data: string }
  | { type: "done" }
  | { type: "error"; kind: StreamErrorKind; status?: number; message?: string };

export interface StreamTimeouts {
  firstByteMs: number;
  idleMs: number;
  totalMs: number;
}

export interface StreamRequest {
  slot: string;
  url: string;
  body: Json;
  timeouts: StreamTimeouts;
}

export interface StreamSnapshot {
  events: StreamEvent[];
  active: boolean;
}

export interface StreamListing {
  streamId: string;
  finished: boolean;
  active: boolean;
}

/** Progress of the in-app update download (R14). */
export type UpdateEvent =
  | { type: "progress"; received: number; total: number }
  /** A dropped or failed connection; the next attempt resumes after `waitMs`. */
  | { type: "retrying"; attempt: number; waitMs: number }
  | { type: "verifying" };

export interface UpdateRequest {
  /** Release version without the "v"; the package is kept as `<version>.apk`. */
  version: string;
  /** The release asset's download URL (GitHub; a debug build also takes a local test server). */
  url: string;
  size: number;
  /** The published SHA-256, 64 hex digits, that the finished file must have. */
  sha256: string;
}

export type InstallStatus = "started" | "permission" | "unsupported";

export interface Platform {
  readonly name: "android" | "windows" | "web-dev" | "other";
  /**
   * In-app update (R14). Android downloads, verifies and installs; Windows has
   * it for the debug test source only (the sheet sends players to the browser);
   * the browser dev harness simulates it. Absent elsewhere.
   */
  update?: {
    /** Resolves once the package is complete and matches `sha256`; resumes an earlier part. Rejects with `update_cancelled` after `cancel()`. */
    download(request: UpdateRequest, onEvent: (event: UpdateEvent) => void): Promise<void>;
    /** Pauses the running download; the bytes so far are kept for the next try. */
    cancel(): Promise<void>;
    /** A small text asset of a release (SHA256SUMS.txt), from the same hosts. */
    fetchText(url: string): Promise<string>;
    /** Checks the package again and opens the system installer — or first this app's "安装未知应用" switch. */
    install(request: { version: string; size: number; sha256: string }): Promise<InstallStatus>;
    /** Whether the system lets this app install packages yet. */
    canInstall(): Promise<boolean>;
    /** Debug builds: a local test server (`http://127.0.0.1:<port>`) instead of GitHub for the update check. */
    devSource(): Promise<{ available: boolean; url: string | null }>;
    setDevSource(url: string | null): Promise<void>;
  };
  sql: {
    query(sql: string, params?: Json[]): Promise<Row[]>;
    /** Runs all statements in one transaction. */
    batch(statements: SqlStatement[]): Promise<void>;
    backup(label: string): Promise<string>;
    listBackups(): Promise<BackupInfo[]>;
    /**
     * Replaces the whole database with the backup `name` after saving the
     * current data as a "before-restore" backup; resolves with that backup's
     * name. Rejects when the file is not an intact database of this app. The
     * app should reload afterwards: everything it holds in memory is stale.
     */
    restore(name: string): Promise<string>;
  };
  secrets: {
    set(slot: string, value: string, boundBaseUrl: string): Promise<void>;
    has(slot: string): Promise<{ configured: boolean; boundBaseUrl: string | null }>;
    remove(slot: string): Promise<void>;
  };
  llm: {
    /** Resolves with the stream id once the request is registered; events follow. */
    stream(request: StreamRequest, onEvent: (event: StreamEvent) => void): Promise<string>;
    cancel(streamId: string): Promise<void>;
    resume(streamId: string): Promise<StreamSnapshot | null>;
    list(): Promise<StreamListing[]>;
    ack(streamId: string): Promise<void>;
    get(request: { slot: string; url: string; timeoutMs: number }): Promise<{ status: number; body: string }>;
    /** A keyless HTTPS GET for public data (the update check). */
    getPublic(url: string, timeoutMs: number): Promise<{ status: number; body: string }>;
    /** How requests reach the internet: no proxy, the system's, or a custom http/socks5 one. */
    setNetwork(config: { proxy: "none" | "system" | "custom"; proxyUrl?: string | null }): Promise<void>;
  };
  files: {
    exportText(suggestedName: string, text: string): Promise<boolean>;
    importText(): Promise<string | null>;
  };
  system: {
    /** Only after the chosen story node is durably committed. Never for streams, candidates, tests or cancellation. */
    storyCommitted(completionId: string): Promise<void>;
    /** Owned by the active play page; release when leaving it. */
    setKeepAwake(enabled: boolean): Promise<void>;
    requestNotifications(): Promise<boolean>;
    /** Can notifications show (permission and the app's switch)? Always true off Android. */
    notificationStatus(): Promise<{ granted: boolean; enabled: boolean }>;
    /** Opens the system screen for this app's notifications, or its details page (battery, autostart). */
    openSystemSettings(which: "notifications" | "app"): Promise<void>;
    /** Opens an https page in the system browser. */
    openUrl(url: string): Promise<void>;
    /** The handler returns true when it consumed the back press. */
    onBack(handler: () => boolean): () => void;
    /**
     * Matches the phone's status and navigation bars to the app theme's
     * background (`#rrggbb`); `dark` asks for light icons. A no-op off Android.
     */
    setSystemBars(background: string, dark: boolean): Promise<void>;
    /** A short native tap of the vibration motor (long press); false when there is none. */
    haptic(): Promise<boolean>;
  };
}

export class PlatformError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PlatformError";
  }
}
