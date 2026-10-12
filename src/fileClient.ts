import { invoke, isTauri } from "@tauri-apps/api/core";
import { t, type MessageKey } from "./i18n";

export type ProbeExportResult =
  | { status: "cancelled" }
  | { status: "exported"; fileName?: string };

export type ProbeImportResult =
  | { status: "cancelled" }
  | { status: "imported"; fileName?: string; note: string };

const fileErrorKeys = {
  file_busy: "probe.file.error.busy",
  file_unavailable: "probe.file.error.unavailable",
  file_io_error: "probe.file.error.io",
  file_unconfirmed: "probe.file.error.unconfirmed",
  file_invalid_extension: "probe.file.error.extension",
  pack_too_large: "probe.file.error.tooLarge",
  pack_invalid: "probe.file.error.invalid",
  pack_unsupported_version: "probe.file.error.version",
  pack_checksum_mismatch: "probe.file.error.checksum",
} as const satisfies Record<string, MessageKey>;

class FileProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileProbeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function describeFileError(error: unknown): string {
  return error instanceof FileProbeError ? error.message : t("probe.file.error.unconfirmed");
}

async function callFile(command: string, args: Record<string, unknown>): Promise<unknown> {
  if (!isTauri()) {
    throw new FileProbeError(t("probe.error.unavailable"));
  }
  try {
    return await invoke<unknown>(command, args);
  } catch (error: unknown) {
    const code = typeof error === "string" ? error : isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (code && Object.prototype.hasOwnProperty.call(fileErrorKeys, code)) {
      throw new FileProbeError(t(fileErrorKeys[code as keyof typeof fileErrorKeys]));
    }
    // Filesystem paths, permission errors, and unexpected native messages stay private.
    throw new FileProbeError(t("probe.file.error.unconfirmed"));
  }
}

export async function exportProbePack(text: string): Promise<ProbeExportResult> {
  const result = await callFile("export_probe_pack", { request: { text } });
  if (!isRecord(result) || (result.fileName !== undefined && typeof result.fileName !== "string")) {
    throw new FileProbeError(t("probe.file.error.resultFormat"));
  }
  if (result.status === "cancelled") {
    return { status: "cancelled" };
  }
  if (result.status !== "exported") {
    throw new FileProbeError(t("probe.file.error.resultFormat"));
  }
  return { status: "exported", fileName: result.fileName as string | undefined };
}

export async function importProbePack(): Promise<ProbeImportResult> {
  const result = await callFile("import_probe_pack", {});
  if (!isRecord(result) || (result.fileName !== undefined && typeof result.fileName !== "string")) {
    throw new FileProbeError(t("probe.file.error.resultFormat"));
  }
  if (result.status === "cancelled") {
    return { status: "cancelled" };
  }
  if (result.status !== "imported" || typeof result.note !== "string") {
    throw new FileProbeError(t("probe.file.error.resultFormat"));
  }
  return { status: "imported", fileName: result.fileName as string | undefined, note: result.note };
}
