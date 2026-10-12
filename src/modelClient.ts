import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { modelT, type ModelMessageKey } from "./modelMessages";
import { t } from "./i18n";
import type { StreamCancelResult, StreamEvent, StreamResult, StreamSnapshot, StreamStatus } from "./streamClient";

export type ModelCredentialMode = "fixture" | "saved";

export interface ModelProbeRequest {
  operationId: string;
  endpoint: string;
  model: string;
  prompt: string;
  includeUsage: boolean;
  credentialMode: ModelCredentialMode;
}

export interface ModelProbeUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelProbeDiagnostics {
  httpStatus: number | null;
  usage: ModelProbeUsage | null;
  elapsedMs: number;
  attempts: number;
}

export interface ModelProbeResult {
  stream: StreamResult;
  diagnostics: ModelProbeDiagnostics;
}

export interface ModelProbeSnapshot {
  stream: StreamSnapshot;
  diagnostics: ModelProbeDiagnostics | null;
}

export interface ModelProbeHistoryEntry {
  operationId: string;
  status: StreamStatus;
  errorCode?: string;
  diagnostics: ModelProbeDiagnostics | null;
}

const errorKeys = {
  invalid_url: "model.error.invalidUrl",
  invalid_config: "model.error.invalidConfig",
  invalid_options: "model.error.invalidConfig",
  model_invalid_id: "model.error.invalidId",
  model_busy: "model.error.busy",
  model_duplicate: "model.error.duplicate",
  model_state_unavailable: "model.error.stateUnavailable",
  model_tls_unavailable: "model.error.tlsUnavailable",
  credential_missing: "model.error.credentialMissing",
  credential_unavailable: "model.error.credentialUnavailable",
  credential_unconfirmed: "model.error.credentialUnconfirmed",
  credential_echo: "model.error.credentialEcho",
  operation_dropped: "model.error.dropped",
  client_setup: "model.error.clientSetup",
  network: "model.error.network",
  connect_timeout: "model.error.timeout",
  idle_timeout: "model.error.timeout",
  total_timeout: "model.error.timeout",
  http_status: "model.error.http",
  invalid_content_type: "model.error.contentType",
  invalid_payload: "model.error.payload",
  invalid_utf8: "model.error.utf8",
  event_too_large: "model.error.tooLarge",
  response_too_large: "model.error.tooLarge",
  output_too_large: "model.error.tooLarge",
  truncated: "model.error.truncated",
  unexpected_eof: "model.error.truncated",
  upstream_error: "model.error.upstream",
  refused: "model.error.refused",
  empty_output: "model.error.emptyOutput",
  consumer_closed: "model.error.channel",
} as const satisfies Record<string, ModelMessageKey>;

const rejectedBeforeStart = new Set([
  "invalid_url", "invalid_config", "invalid_options", "model_invalid_id", "model_busy",
  "model_duplicate", "model_state_unavailable", "model_tls_unavailable",
]);

export class ModelProbeError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "ModelProbeError";
  }
}

export function wasModelRejectedBeforeStart(error: unknown): error is ModelProbeError {
  return error instanceof ModelProbeError && error.code !== undefined && rejectedBeforeStart.has(error.code);
}

export function describeModelCode(code?: string): string {
  return code && Object.prototype.hasOwnProperty.call(errorKeys, code)
    ? modelT(errorKeys[code as keyof typeof errorKeys])
    : modelT("model.error.unknown");
}

export function describeModelError(error: unknown): string {
  return error instanceof ModelProbeError ? error.message : modelT("model.error.unconfirmed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStatus(value: unknown): value is StreamStatus {
  return value === "completed" || value === "cancelled" || value === "failed";
}

function isCode(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value));
}

function isOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function parseEvent(value: unknown): StreamEvent | null {
  if (!isRecord(value) || !isOperationId(value.operationId) || !isCount(value.sequence)) {
    return null;
  }
  const base = { operationId: value.operationId, sequence: value.sequence };
  if (value.kind === "started") {
    return { ...base, kind: "started" };
  }
  if (value.kind === "delta" && typeof value.text === "string" && value.text.length <= 256 * 1024) {
    return { ...base, kind: "delta", text: value.text };
  }
  if (value.kind === "finished" && isStatus(value.status) && isCode(value.errorCode)) {
    return { ...base, kind: "finished", status: value.status, errorCode: value.errorCode };
  }
  return null;
}

function parseDiagnostics(value: unknown): ModelProbeDiagnostics | null {
  if (
    !isRecord(value) || !isCount(value.elapsedMs) || !isCount(value.attempts) || value.attempts > 1 ||
    !(value.httpStatus === null || (isCount(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599))
  ) {
    return null;
  }
  let usage: ModelProbeUsage | null = null;
  if (value.usage !== null) {
    if (
      !isRecord(value.usage) || !isCount(value.usage.promptTokens) ||
      !isCount(value.usage.completionTokens) || !isCount(value.usage.totalTokens)
    ) {
      return null;
    }
    usage = {
      promptTokens: value.usage.promptTokens,
      completionTokens: value.usage.completionTokens,
      totalTokens: value.usage.totalTokens,
    };
  }
  return { httpStatus: value.httpStatus, usage, elapsedMs: value.elapsedMs, attempts: value.attempts };
}

function parseStreamResult(value: unknown, operationId: string): StreamResult | null {
  if (
    !isRecord(value) || value.operationId !== operationId || !isStatus(value.status) ||
    typeof value.text !== "string" || value.text.length > 256 * 1024 ||
    !isCount(value.deltaCount) || !isCode(value.errorCode)
  ) {
    return null;
  }
  return {
    operationId, status: value.status, text: value.text, deltaCount: value.deltaCount,
    errorCode: value.errorCode,
  };
}

function parseStreamSnapshot(value: unknown, operationId: string | null): StreamSnapshot | null {
  if (
    !isRecord(value) || !isOperationId(value.operationId) ||
    (operationId !== null && value.operationId !== operationId) ||
    (value.state !== "running" && !isStatus(value.state)) || !isCount(value.sequence) ||
    typeof value.text !== "string" || value.text.length > 256 * 1024 ||
    !isCount(value.deltaCount) || !isCode(value.errorCode)
  ) {
    return null;
  }
  return {
    operationId: value.operationId, state: value.state, sequence: value.sequence, text: value.text,
    deltaCount: value.deltaCount, errorCode: value.errorCode,
  };
}

async function callModel(command: string, args: Record<string, unknown>): Promise<unknown> {
  if (!isTauri()) {
    throw new ModelProbeError(t("probe.error.unavailable"));
  }
  try {
    return await invoke<unknown>(command, args);
  } catch (error: unknown) {
    // Discard any rejected upstream text or extra fields instead of retaining them in the UI.
    const code = isRecord(error) && typeof error.code === "string" &&
      Object.prototype.hasOwnProperty.call(errorKeys, error.code) ? error.code : undefined;
    throw new ModelProbeError(code ? describeModelCode(code) : modelT("model.error.unconfirmed"), code);
  }
}

export async function startProbeModel(
  request: ModelProbeRequest,
  onEvent: (event: StreamEvent) => void,
  onInvalidEvent: () => void,
): Promise<ModelProbeResult> {
  if (!isTauri()) {
    throw new ModelProbeError(t("probe.error.unavailable"));
  }
  const channel = new Channel<unknown>();
  channel.onmessage = (value) => {
    const event = parseEvent(value);
    if (event === null) {
      onInvalidEvent();
    } else if (event.operationId === request.operationId) {
      onEvent(event);
    }
  };
  const result = await callModel("start_probe_model", { request, onEvent: channel });
  const stream = isRecord(result) ? parseStreamResult(result.stream, request.operationId) : null;
  const diagnostics = isRecord(result) ? parseDiagnostics(result.diagnostics) : null;
  if (stream === null || diagnostics === null) {
    throw new ModelProbeError(modelT("model.error.resultFormat"));
  }
  return { stream, diagnostics };
}

export async function cancelProbeModel(operationId: string): Promise<StreamCancelResult> {
  const result = await callModel("cancel_probe_model", { operationId });
  if (
    !isRecord(result) || result.operationId !== operationId ||
    (result.state !== "cancel_requested" && result.state !== "finished" && result.state !== "not_found")
  ) {
    throw new ModelProbeError(modelT("model.error.resultFormat"));
  }
  return { operationId, state: result.state };
}

export async function getProbeModel(operationId: string | null): Promise<ModelProbeSnapshot | null> {
  const result = await callModel("get_probe_model", { operationId });
  if (result === null) {
    return null;
  }
  const stream = isRecord(result) ? parseStreamSnapshot(result.stream, operationId) : null;
  const diagnostics = isRecord(result) && result.diagnostics !== null ? parseDiagnostics(result.diagnostics) : null;
  if (stream === null || !isRecord(result) || (result.diagnostics !== null && diagnostics === null)) {
    throw new ModelProbeError(modelT("model.error.resultFormat"));
  }
  return { stream, diagnostics };
}

export async function listProbeModelHistory(): Promise<ModelProbeHistoryEntry[]> {
  const result = await callModel("list_probe_model_history", {});
  if (!Array.isArray(result) || result.length > 10) {
    throw new ModelProbeError(modelT("model.error.resultFormat"));
  }
  const seen = new Set<string>();
  return result.map((value: unknown) => {
    if (
      !isRecord(value) || !isOperationId(value.operationId) || seen.has(value.operationId) ||
      !isStatus(value.status) || !isCode(value.errorCode)
    ) {
      throw new ModelProbeError(modelT("model.error.resultFormat"));
    }
    const diagnostics = value.diagnostics === null ? null : parseDiagnostics(value.diagnostics);
    if (value.diagnostics !== null && diagnostics === null) {
      throw new ModelProbeError(modelT("model.error.resultFormat"));
    }
    seen.add(value.operationId);
    return { operationId: value.operationId, status: value.status, errorCode: value.errorCode, diagnostics };
  });
}
