import { invoke, isTauri } from "@tauri-apps/api/core";
import { t, type MessageKey } from "./i18n";

export interface ProbeInfo {
  coreVersion: string;
  platform: string;
}

export interface EchoResult {
  text: string;
  unicodeScalarCount: number;
  utf8ByteCount: number;
}

export interface ProbeNote {
  text: string;
  savedAtMs: number;
  revision: number;
}

type NoteErrorCode = "note_too_large" | "storage_failed";

const noteErrorKeys = {
  note_too_large: "probe.error.noteTooLarge",
  storage_failed: "probe.error.storageFailed",
} as const satisfies Record<NoteErrorCode, MessageKey>;

function isKnownNoteError(error: unknown): error is { code: NoteErrorCode } {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown };
  return candidate.code === "note_too_large" || candidate.code === "storage_failed";
}

export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

export function hasNativeCore(): boolean {
  return isTauri();
}

async function callNative<T>(
  command: string,
  args?: Record<string, unknown>,
  failureMessage = t("probe.error.nativeCall"),
): Promise<T> {
  if (!hasNativeCore()) {
    throw new ProbeError(t("probe.error.unavailable"));
  }

  try {
    return await invoke<T>(command, args);
  } catch (error: unknown) {
    if ((command === "read_probe_note" || command === "save_probe_note") && isKnownNoteError(error)) {
      // Translate known codes locally; never display a raw native error message.
      throw new ProbeError(t(noteErrorKeys[error.code]));
    }
    // Keep raw native errors out of the UI; later commands may include private data.
    throw new ProbeError(failureMessage);
  }
}

export async function getProbeInfo(): Promise<ProbeInfo> {
  const result = await callNative<ProbeInfo>("probe_info");

  if (
    !result ||
    typeof result.coreVersion !== "string" ||
    typeof result.platform !== "string"
  ) {
    throw new ProbeError(t("probe.error.infoFormat"));
  }

  return result;
}

export async function echoText(text: string): Promise<EchoResult> {
  const result = await callNative<EchoResult>("echo_text", { text });

  if (
    !result ||
    typeof result.text !== "string" ||
    !Number.isSafeInteger(result.unicodeScalarCount) ||
    result.unicodeScalarCount < 0 ||
    !Number.isSafeInteger(result.utf8ByteCount) ||
    result.utf8ByteCount < 0
  ) {
    throw new ProbeError(t("probe.error.echoFormat"));
  }

  return result;
}

function validateProbeNote(result: ProbeNote): ProbeNote {
  if (
    !result ||
    typeof result.text !== "string" ||
    !Number.isSafeInteger(result.savedAtMs) ||
    result.savedAtMs < 0 ||
    !Number.isSafeInteger(result.revision) ||
    result.revision <= 0
  ) {
    throw new ProbeError(t("probe.error.noteFormat"));
  }

  return result;
}

export async function readProbeNote(): Promise<ProbeNote | null> {
  const result = await callNative<ProbeNote | null>(
    "read_probe_note",
    undefined,
    t("probe.error.noteRead"),
  );
  return result === null ? null : validateProbeNote(result);
}

export async function saveProbeNote(text: string): Promise<ProbeNote> {
  const result = await callNative<ProbeNote>(
    "save_probe_note",
    { text },
    t("probe.error.noteSaveUnconfirmed"),
  );
  return validateProbeNote(result);
}

export function describeProbeError(error: unknown): string {
  return error instanceof ProbeError ? error.message : t("probe.error.unknown");
}
