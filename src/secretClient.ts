import { invoke, isTauri } from "@tauri-apps/api/core";
import { t, type MessageKey } from "./i18n";

export interface ProbeSecretStatus {
  configured: boolean;
}

const secretErrorKeys = {
  secret_invalid_slot: "probe.secret.error.invalidSlot",
  secret_invalid_value: "probe.secret.error.invalidValue",
  secret_unavailable: "probe.secret.error.unavailable",
  secret_corrupted: "probe.secret.error.corrupted",
  secret_key_unavailable: "probe.secret.error.keyUnavailable",
  secret_io_error: "probe.secret.error.io",
  secret_unconfirmed: "probe.secret.error.waitTimeout",
} as const satisfies Record<string, MessageKey>;

class SecretProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretProbeError";
  }
}

export function describeSecretError(error: unknown): string {
  return error instanceof SecretProbeError ? error.message : t("probe.secret.error.unconfirmed");
}

async function callSecret(command: string, args: Record<string, unknown>): Promise<ProbeSecretStatus> {
  if (!isTauri()) {
    throw new SecretProbeError(t("probe.error.unavailable"));
  }
  let result: unknown;
  try {
    result = await invoke<unknown>(command, args);
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (typeof code === "string" && Object.prototype.hasOwnProperty.call(secretErrorKeys, code)) {
      throw new SecretProbeError(t(secretErrorKeys[code as keyof typeof secretErrorKeys]));
    }
    // Never display an upstream error message or retain the rejected payload.
    throw new SecretProbeError(t("probe.secret.error.unconfirmed"));
  }
  if (typeof result !== "object" || result === null || !("configured" in result) || typeof result.configured !== "boolean") {
    throw new SecretProbeError(t("probe.secret.error.statusFormat"));
  }
  // Only the Boolean status crosses into the component; no extra fields are retained.
  return { configured: result.configured };
}

export function getProbeSecretStatus(): Promise<ProbeSecretStatus> {
  return callSecret("get_probe_secret_status", {});
}

export async function saveProbeSecret(token: string): Promise<ProbeSecretStatus> {
  const status = await callSecret("save_probe_secret", { token });
  if (!status.configured) {
    throw new SecretProbeError(t("probe.secret.error.statusFormat"));
  }
  return status;
}

export async function deleteProbeSecret(): Promise<ProbeSecretStatus> {
  const status = await callSecret("delete_probe_secret", {});
  if (status.configured) {
    throw new SecretProbeError(t("probe.secret.error.statusFormat"));
  }
  return status;
}
