import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { t, type MessageKey } from "./i18n";

export type StreamStatus = "completed" | "cancelled" | "failed";

export interface StreamRequest {
  operationId: string;
  url: string;
}

export type StreamEvent =
  | { operationId: string; sequence: number; kind: "started" }
  | { operationId: string; sequence: number; kind: "delta"; text: string }
  | { operationId: string; sequence: number; kind: "finished"; status: StreamStatus; errorCode?: string };

export interface StreamResult {
  operationId: string;
  status: StreamStatus;
  errorCode?: string;
  text: string;
  deltaCount: number;
}

export interface StreamSnapshot {
  operationId: string;
  state: "running" | StreamStatus;
  sequence: number;
  text: string;
  deltaCount: number;
  errorCode?: string;
}

export interface StreamCancelResult {
  operationId: string;
  state: "cancel_requested" | "finished" | "not_found";
}

const errorKeys = {
  invalid_url: "probe.stream.error.invalidUrl",
  stream_invalid_id: "probe.stream.error.invalidOperation",
  stream_busy: "probe.stream.error.busy",
  stream_duplicate: "probe.stream.error.duplicate",
  stream_state_unavailable: "probe.stream.error.stateUnavailable",
  stream_tls_unavailable: "probe.stream.error.tlsUnavailable",
  invalid_options: "probe.stream.error.options",
  client_setup: "probe.stream.error.clientSetup",
  network: "probe.stream.error.connection",
  connect_timeout: "probe.stream.error.timeout",
  idle_timeout: "probe.stream.error.timeout",
  total_timeout: "probe.stream.error.timeout",
  http_status: "probe.stream.error.http",
  invalid_content_type: "probe.stream.error.contentType",
  invalid_payload: "probe.stream.error.malformed",
  invalid_utf8: "probe.stream.error.utf8",
  event_too_large: "probe.stream.error.tooLarge",
  response_too_large: "probe.stream.error.tooLarge",
  output_too_large: "probe.stream.error.tooLarge",
  truncated: "probe.stream.error.truncated",
  unexpected_eof: "probe.stream.error.truncated",
  upstream_error: "probe.stream.error.upstream",
  refused: "probe.stream.error.refused",
  empty_output: "probe.stream.error.emptyOutput",
  consumer_closed: "probe.stream.error.channel",
} as const satisfies Record<string, MessageKey>;

export class StreamProbeError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "StreamProbeError";
  }
}

export function wasRejectedBeforeStart(error: unknown): error is StreamProbeError {
  return error instanceof StreamProbeError && (
    error.code === "stream_busy" || error.code === "stream_duplicate" ||
    error.code === "stream_invalid_id" || error.code === "stream_state_unavailable" ||
    error.code === "stream_tls_unavailable"
  );
}

export function describeStreamCode(code?: string): string {
  if (code && Object.prototype.hasOwnProperty.call(errorKeys, code)) {
    return t(errorKeys[code as keyof typeof errorKeys]);
  }
  return t("probe.stream.error.unknown");
}

export function describeStreamError(error: unknown): string {
  return error instanceof StreamProbeError ? error.message : t("probe.stream.error.unconfirmed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isStatus(value: unknown): value is StreamStatus {
  return value === "completed" || value === "cancelled" || value === "failed";
}

function isOptionalCode(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isEvent(value: unknown): value is StreamEvent {
  if (!isRecord(value) || typeof value.operationId !== "string" || !isSequence(value.sequence)) {
    return false;
  }
  if (value.kind === "started") {
    return true;
  }
  if (value.kind === "delta") {
    return typeof value.text === "string";
  }
  return value.kind === "finished" && isStatus(value.status) && isOptionalCode(value.errorCode);
}

async function callStream<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new StreamProbeError(t("probe.error.unavailable"));
  }
  try {
    return await invoke<T>(command, args);
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    throw new StreamProbeError(code ? describeStreamCode(code) : t("probe.stream.error.unconfirmed"), code);
  }
}

export async function startProbeStream(
  request: StreamRequest,
  onEvent: (event: StreamEvent) => void,
  onInvalidEvent: () => void,
): Promise<StreamResult> {
  if (!isTauri()) {
    throw new StreamProbeError(t("probe.error.unavailable"));
  }
  const channel = new Channel<unknown>();
  channel.onmessage = (value) => {
    if (!isEvent(value)) {
      onInvalidEvent();
      return;
    }
    if (value.operationId === request.operationId) {
      onEvent(value);
    }
  };
  const result = await callStream<unknown>("start_probe_stream", { request, onEvent: channel });
  if (
    !isRecord(result) || result.operationId !== request.operationId || !isStatus(result.status) ||
    typeof result.text !== "string" || !isSequence(result.deltaCount) || !isOptionalCode(result.errorCode)
  ) {
    throw new StreamProbeError(t("probe.stream.error.resultFormat"));
  }
  return result as unknown as StreamResult;
}

export async function cancelProbeStream(operationId: string): Promise<StreamCancelResult> {
  const result = await callStream<unknown>("cancel_probe_stream", { operationId });
  if (
    !isRecord(result) || result.operationId !== operationId ||
    (result.state !== "cancel_requested" && result.state !== "finished" && result.state !== "not_found")
  ) {
    throw new StreamProbeError(t("probe.stream.error.resultFormat"));
  }
  return result as unknown as StreamCancelResult;
}

export async function getProbeStream(operationId: string | null): Promise<StreamSnapshot | null> {
  const result = await callStream<unknown>("get_probe_stream", { operationId });
  if (result === null) {
    return null;
  }
  if (
    !isRecord(result) || typeof result.operationId !== "string" ||
    (operationId !== null && result.operationId !== operationId) ||
    (result.state !== "running" && !isStatus(result.state)) || !isSequence(result.sequence) ||
    typeof result.text !== "string" || !isSequence(result.deltaCount) || !isOptionalCode(result.errorCode)
  ) {
    throw new StreamProbeError(t("probe.stream.error.resultFormat"));
  }
  return result as unknown as StreamSnapshot;
}
