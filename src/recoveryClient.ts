import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { t, type MessageKey } from "./i18n";
import { describeStreamCode, type StreamEvent } from "./streamClient";

export type RecoveryStatus = "pending" | "generating" | "validating" | "committed" | "failed" | "cancelled" | "interrupted";
export type RecoveryPause = "none" | "validating" | "commit";
export type RecoveryPhase = "pending" | "generating" | "validating" | "commit_paused" | "committed";

export interface RecoverySnapshot {
  operationId: string | null;
  text: string;
  revision: number;
}

export interface RecoveryOperation {
  operationId: string;
  expectedHeadOperationId: string | null;
  status: RecoveryStatus;
  errorCode: string | null;
  updatedAtMs: number;
}

export interface RecoveryView {
  snapshot: RecoverySnapshot;
  latestOperation: RecoveryOperation | null;
  activeOperationId: string | null;
}

export interface RecoveryRequest {
  operationId: string;
  url: string;
  expectedHeadOperationId: string | null;
  pauseAt: RecoveryPause;
}

export type RecoveryEvent =
  | { kind: "stream"; event: StreamEvent }
  | { kind: "phase"; operationId: string; phase: RecoveryPhase };

class RecoveryProbeError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "RecoveryProbeError";
  }
}

const recoveryErrorKeys = {
  recovery_database: "probe.recovery.error.database",
  recovery_unavailable: "probe.recovery.error.database",
  recovery_busy: "probe.recovery.error.busy",
  recovery_duplicate: "probe.recovery.error.duplicate",
  recovery_stale_head: "probe.recovery.error.staleHead",
  recovery_invalid_id: "probe.recovery.error.invalid",
  recovery_invalid_text: "probe.recovery.error.invalid",
  recovery_invalid_error_code: "probe.recovery.error.invalid",
  recovery_invalid_transition: "probe.recovery.error.invalid",
  recovery_revision_overflow: "probe.recovery.error.invalid",
  recovery_clock: "probe.recovery.error.invalid",
  recovery_worker: "probe.recovery.error.worker",
  recovery_tls_unavailable: "probe.recovery.error.tls",
  recovery_cancelled: "probe.recovery.phase.cancelled",
} as const satisfies Record<string, MessageKey>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnsigned(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStatus(value: unknown): value is RecoveryStatus {
  return value === "pending" || value === "generating" || value === "validating" || value === "committed" ||
    value === "failed" || value === "cancelled" || value === "interrupted";
}

function isStreamEvent(value: unknown): value is StreamEvent {
  if (!isRecord(value) || typeof value.operationId !== "string" || !isUnsigned(value.sequence)) {
    return false;
  }
  if (value.kind === "started") {
    return true;
  }
  if (value.kind === "delta") {
    return typeof value.text === "string";
  }
  return value.kind === "finished" && (value.status === "completed" || value.status === "cancelled" || value.status === "failed") &&
    (value.errorCode === undefined || typeof value.errorCode === "string");
}

function parseEvent(value: unknown): RecoveryEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "stream" && isStreamEvent(value.event)) {
    return { kind: "stream", event: value.event };
  }
  if (value.kind === "phase" && typeof value.operationId === "string" && (
    value.phase === "pending" || value.phase === "generating" || value.phase === "validating" ||
    value.phase === "commit_paused" || value.phase === "committed"
  )) {
    return { kind: "phase", operationId: value.operationId, phase: value.phase };
  }
  return null;
}

function parseView(value: unknown): RecoveryView {
  if (!isRecord(value) || !isRecord(value.snapshot) || !isNullableString(value.snapshot.operationId) ||
    typeof value.snapshot.text !== "string" || !isUnsigned(value.snapshot.revision) || !isNullableString(value.activeOperationId)) {
    throw new RecoveryProbeError(t("probe.recovery.error.resultFormat"));
  }
  let latestOperation: RecoveryOperation | null = null;
  if (value.latestOperation !== null) {
    const operation = value.latestOperation;
    if (!isRecord(operation) || typeof operation.operationId !== "string" || !isNullableString(operation.expectedHeadOperationId) ||
      !isStatus(operation.status) || !isNullableString(operation.errorCode) || !isUnsigned(operation.updatedAtMs)) {
      throw new RecoveryProbeError(t("probe.recovery.error.resultFormat"));
    }
    latestOperation = {
      operationId: operation.operationId,
      expectedHeadOperationId: operation.expectedHeadOperationId,
      status: operation.status,
      errorCode: operation.errorCode,
      updatedAtMs: operation.updatedAtMs,
    };
  }
  return {
    snapshot: { operationId: value.snapshot.operationId, text: value.snapshot.text, revision: value.snapshot.revision },
    latestOperation,
    activeOperationId: value.activeOperationId,
  };
}

export function isRecoveryTerminal(status: RecoveryStatus): boolean {
  return status === "committed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

export function describeRecoveryError(error: unknown): string {
  return error instanceof RecoveryProbeError ? error.message : t("probe.recovery.error.unconfirmed");
}

export function describeRecoveryCode(code?: string | null): string {
  if (code && Object.prototype.hasOwnProperty.call(recoveryErrorKeys, code)) {
    return t(recoveryErrorKeys[code as keyof typeof recoveryErrorKeys]);
  }
  return code ? describeStreamCode(code) : t("probe.recovery.error.unconfirmed");
}

async function callRecovery(command: string, args: Record<string, unknown>): Promise<unknown> {
  if (!isTauri()) {
    throw new RecoveryProbeError(t("probe.error.unavailable"));
  }
  try {
    return await invoke<unknown>(command, args);
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    throw new RecoveryProbeError(describeRecoveryCode(code), code);
  }
}

export async function getProbeRecovery(): Promise<RecoveryView> {
  return parseView(await callRecovery("get_probe_recovery", {}));
}

export async function startProbeRecovery(
  request: RecoveryRequest,
  onEvent: (event: RecoveryEvent) => void,
  onInvalidEvent: () => void,
): Promise<RecoveryView> {
  if (!isTauri()) {
    throw new RecoveryProbeError(t("probe.error.unavailable"));
  }
  const channel = new Channel<unknown>();
  channel.onmessage = (value) => {
    const event = parseEvent(value);
    if (event === null) {
      onInvalidEvent();
      return;
    }
    const operationId = event.kind === "stream" ? event.event.operationId : event.operationId;
    if (operationId === request.operationId) {
      onEvent(event);
    }
  };
  return parseView(await callRecovery("start_probe_recovery_stream", { request, onEvent: channel }));
}

export async function cancelProbeRecovery(operationId: string): Promise<{ status: "cancel_requested" | "finished" | "not_found" }> {
  const value = await callRecovery("cancel_probe_recovery", { operationId });
  if (!isRecord(value) || (value.status !== "cancel_requested" && value.status !== "finished" && value.status !== "not_found")) {
    throw new RecoveryProbeError(t("probe.recovery.error.resultFormat"));
  }
  return { status: value.status };
}
