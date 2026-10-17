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

export interface Platform {
  readonly name: "android" | "windows" | "web-dev" | "other";
  sql: {
    query(sql: string, params?: Json[]): Promise<Row[]>;
    /** Runs all statements in one transaction. */
    batch(statements: SqlStatement[]): Promise<void>;
    backup(label: string): Promise<string>;
    listBackups(): Promise<BackupInfo[]>;
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
    requestNotifications(): Promise<boolean>;
    /** Can notifications show (permission and the app's switch)? Always true off Android. */
    notificationStatus(): Promise<{ granted: boolean; enabled: boolean }>;
    /** Opens the system screen for this app's notifications, or its details page (battery, autostart). */
    openSystemSettings(which: "notifications" | "app"): Promise<void>;
    /** Opens an https page in the system browser. */
    openUrl(url: string): Promise<void>;
    /** The handler returns true when it consumed the back press. */
    onBack(handler: () => boolean): () => void;
  };
}

export class PlatformError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PlatformError";
  }
}
