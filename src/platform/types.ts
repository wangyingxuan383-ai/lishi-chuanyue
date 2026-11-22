// Platform services shared by the Tauri shell and the browser dev harness.
// Contract: docs/contracts/PLATFORM.md

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Row = Record<string, Json>;
export interface PdfText { pages: string[]; headings: { title: string; page: number }[] }

export interface SqlStatement {
  sql: string;
  params?: Json[];
}

export interface BackupInfo {
  name: string;
  at: string;
  size: number;
}

export interface BackupInventory {
  items: BackupInfo[];
  totalBytes: number;
}

export interface BackupDeletion {
  inventory: BackupInventory;
  failed: number;
}

export type StreamErrorKind =
  | "network"
  /** The connection closed before the reply ended (words had already come). */
  | "stream"
  | "storage"
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

/** Why a generation stopped, as the native engine records it (R30, D166). */
export interface Failure {
  kind: string;
  /** prepare | write | record | review | settle | commit | maintain */
  stage: string;
  /** Whether the failing attempt reached the service: yes | no | unknown. */
  sent: string;
  partial?: boolean;
  /** Model requests this attempt sent; 0 means nothing was sent. */
  requests: number;
  status?: number;
  /** What the service said, cleaned: no links or keys, at most 300 characters. */
  said?: string;
  /** The engineering detail, for the details sheet only. */
  detail?: string;
  /** For `busy`: ask | assistant | autoplay | turn | other, and when its hold ends. */
  holder?: string;
  untilMs?: number;
  at: string;
}

export interface ExecutionSnapshot {
  id: string; worldId: string; status: string;
  executionId?: string | null; stopRequested?: boolean;
  budget: { modelRequests: number; toolCalls: number; corrections: number; activeMs: number };
  draft: Json; result: Json; error: string | null;
  errorKind?: string | null;
  failure?: Failure | null;
  /** Earlier failed attempts, oldest first (only once the run has stopped). */
  failures?: Failure[];
  events: { seq: number; event: Json }[];
}
export interface RunStopReceipt {
  executionId: string | null; status: string; accepted: boolean; settled: boolean;
}

/** Safe native Pi projections; raw provider messages never become UI context. */
export interface AgentProjectionMessage {
  id: string; sessionId?: string; taskId?: string;
  role: "user" | "assistant" | "tool"; content: string; displayContent?: string; createdAt: string;
  status?: string; seq?: number; truncated?: boolean; delivery?: string;
}
export interface AgentProjectionStep {
  id: string; callId: string; taskId: string; childId?: string | null; parentCallId?: string | null;
  tool: string; action: string; object: string; status: string; outcome: string;
  summary: string; resultText: string; seq: number; attempts: number; durationMs?: number | null;
  truncated?: boolean; deliveryFailed?: boolean; read?: Json;
}
export interface AgentExecutionSnapshot<TTask = Json> {
  id: string; worldId: string; status: string; task: TTask; result: Json; error: string | null;
  events: { seq: number; event: Json }[]; messages: AgentProjectionMessage[]; steps: AgentProjectionStep[];
  hasMore?: boolean; nextAfter?: number; nextCallAfter?: number; hasMoreCalls?: boolean; incremental?: boolean;
}

/** `sound`: "写好了" and "没写完" ring and vibrate (R30 step 2, D176). */
export interface NotifyPrefs { progress: boolean; excerpt: boolean; lockscreen: boolean; sound: boolean }

export interface Platform {
  readonly name: "android" | "windows" | "web-dev" | "other";
  /** Runs survive page suspension; unsubscribe by stopping polling, never by cancelling. */
  execution?: {
    /** Dedicated Pi RPC, including Agent snapshot/stop; ordinary runs use the methods below. */
    agent(request: Json): Promise<Json>;
    settle(state: Json, record: Json, options: Json): Promise<Json>;
    context?(input: Json): Promise<Json>;
    start(plan: Json): Promise<string>;
    snapshot(id: string, after?: number): Promise<ExecutionSnapshot>;
    list(): Promise<{ id: string; worldId: string; status: string }[]>;
    stop(id: string, executionId?: string): Promise<RunStopReceipt>;
    resume(id: string): Promise<void>;
    /** Optional native live-event subscription to stream text without per-token polling (R31-P3). */
    subscribe?(id: string, onEvent: (payload: { seq?: number; event: Json }) => void): () => void;
  };
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
    backupInventory(): Promise<BackupInventory>;
    deleteBackups(names: string[]): Promise<BackupDeletion>;
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
    /** Native snapshot-to-file path; the full archive never passes through the WebView. */
    exportWorld?(worldId: string, suggestedName: string): Promise<boolean>;
    exportText(suggestedName: string, text: string): Promise<boolean>;
    importText(): Promise<string | null>;
    importSkillPackage?(): Promise<{ name: string; bytes: number[] } | null>;
    grantAgentResource?(directory: boolean, writable: boolean): Promise<{ id: string; name: string; directory: boolean; writable: boolean; enabled: boolean; revision: number } | null>;
    importBook(signal?: AbortSignal, onProgress?: (bytes: number) => void): Promise<{ name: string; bytes: Uint8Array } | null>;
    extractPdf(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfText>;
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
    /** R29-T006: battery optimisation and phone make, for keeping a passage writing in the background (Android). */
    backgroundStatus?(): Promise<{ ignoringBattery: boolean; xiaomi: boolean }>;
    requestBatteryExemption?(): Promise<void>;
    /** Xiaomi's 自启动管理, else the app's details page. */
    openAutostart?(): Promise<void>;
    /** What the notifications show: live progress, the passage's first line, that line on the lock screen. */
    setNotifyPrefs?(prefs: NotifyPrefs): Promise<void>;
    /** Whether "写好了" will ring: the app's switch and what the system will actually do (Android). */
    reminderStatus?(): Promise<{ sound: boolean; audible: boolean }>;
    /** Posts one sample reminder now, so the player hears it. */
    testReminder?(): Promise<void>;
    /** The reminder's own system settings, where its sound can be turned back on. */
    openReminderSettings?(): Promise<void>;
    /** The story a tapped notification asked to open, once. */
    takeLaunchTarget?(): Promise<{ worldId: string | null; action: "read" | "resume" | null; runId?: string | null }>;
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
  /** A run refused before it started carries the same typed record as a stopped run (R30). */
  constructor(readonly code: string, message: string, readonly failure?: Failure) {
    super(message);
    this.name = "PlatformError";
  }
}
