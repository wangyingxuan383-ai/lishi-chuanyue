// The in-app update's progress (R14), kept outside the sheet: closing the
// sheet does not stop the download, and opening it again shows where it is.
// One release at a time; the native side keeps the bytes between tries.
import { PlatformError, type Platform, type UpdateEvent } from "../../platform";
import { expectedHash, type ReleaseAsset, type ReleaseInfo } from "./update";

export type FailReason = "network" | "corrupt" | "storage" | "unavailable" | "nohash" | "missing" | "install" | "other";

export type UpdateStep =
  | { step: "idle" }
  /** Looking up the package's SHA-256. */
  | { step: "preparing" }
  | { step: "downloading"; received: number; total: number; retrying: boolean }
  | { step: "paused"; received: number; total: number }
  | { step: "verifying" }
  /** Downloaded and verified: ready for the system installer. */
  | { step: "ready" }
  /** Waiting for the player to allow 安装未知应用. */
  | { step: "permission" }
  /** The system installer is open. */
  | { step: "installing" }
  | { step: "failed"; reason: FailReason; received: number; total: number };

export interface UpdateFlow {
  version: string | null;
  size: number;
  sha256: string | null;
  state: UpdateStep;
}

const IDLE: UpdateFlow = { version: null, size: 0, sha256: null, state: { step: "idle" } };
let flow: UpdateFlow = IDLE;
const listeners = new Set<() => void>();

function set(next: Partial<UpdateFlow>) {
  flow = { ...flow, ...next };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const snapshot = (): UpdateFlow => flow;

/** What the sheet for `version` shows. */
export function stepFor(current: UpdateFlow, version: string): UpdateStep {
  return current.version === version ? current.state : { step: "idle" };
}

/** Tests only. */
export function resetUpdateFlow() {
  flow = IDLE;
  waitingPermission = false;
  clearReturnWatch?.();
  listeners.clear();
}

const codeOf = (error: unknown) =>
  error instanceof PlatformError ? error.code : error && typeof error === "object" && "code" in error ? String(error.code) : "";

const REASONS: Record<string, FailReason> = {
  update_network: "network", update_http: "unavailable", update_url: "unavailable",
  update_hash: "corrupt", update_size: "corrupt", update_storage: "storage", update_missing: "missing",
};

const running = (state: UpdateStep) => state.step === "preparing" || state.step === "downloading" || state.step === "verifying";

/** Hydrates an already-downloaded and SHA-256-verified APK on disk without clobbering active download/permission/install steps. */
export function hydrateReadyPackage(pkg: { version: string; size: number; sha256: string }) {
  if (!pkg.version || !pkg.sha256) return;
  if (flow.version === pkg.version) {
    if (running(flow.state) || flow.state.step === "permission" || flow.state.step === "installing" || flow.state.step === "ready") {
      return;
    }
  }
  set({ version: pkg.version, size: pkg.size, sha256: pkg.sha256, state: { step: "ready" } });
}

/** Downloads (or resumes) the package; `ready` once its SHA-256 matches. */
export async function startDownload(platform: Platform, release: ReleaseInfo, asset: ReleaseAsset): Promise<void> {
  const update = platform.update;
  if (!update) return;
  const same = flow.version === release.version;
  if (same && running(flow.state)) return;
  waitingPermission = false;
  clearReturnWatch?.();
  const before = same && "received" in flow.state ? flow.state.received : 0;
  set({ version: release.version, size: asset.size, sha256: same ? flow.sha256 : null, state: { step: "preparing" } });
  let sha256 = flow.sha256;
  try {
    sha256 ??= await expectedHash(platform, release, asset);
  } catch (error) {
    // SHA256SUMS.txt is there but did not arrive: a network problem, worth a retry.
    const code = codeOf(error);
    const reason = code === "update_network" || code === "update_http" ? "network" : "nohash";
    if (flow.version === release.version) set({ state: { step: "failed", reason, received: before, total: asset.size } });
    return;
  }
  if (flow.version !== release.version) return;
  if (!sha256) { set({ state: { step: "failed", reason: "nohash", received: 0, total: asset.size } }); return; }
  set({ sha256, state: { step: "downloading", received: before, total: asset.size, retrying: false } });
  let received = before;
  const onEvent = (event: UpdateEvent) => {
    if (flow.version !== release.version || !running(flow.state)) return;
    if (event.type === "progress") {
      received = event.received;
      set({ state: { step: "downloading", received, total: event.total, retrying: false } });
    } else if (event.type === "retrying") {
      set({ state: { step: "downloading", received, total: asset.size, retrying: true } });
    } else set({ state: { step: "verifying" } });
  };
  const request = { version: release.version, url: asset.url, size: asset.size, sha256 };
  try {
    try {
      await update.download(request, onEvent);
    } catch (error) {
      // A download this page lost track of (after a reload) still holds the slot: stop it, start again.
      if (codeOf(error) !== "update_busy") throw error;
      await update.cancel();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await update.download(request, onEvent);
    }
    if (flow.version === release.version) set({ state: { step: "ready" } });
  } catch (error) {
    if (flow.version !== release.version) return;
    const code = codeOf(error);
    if (code === "update_cancelled") { set({ state: { step: "paused", received, total: asset.size } }); return; }
    const reason = REASONS[code] ?? "other";
    set({ state: { step: "failed", reason, received: reason === "corrupt" ? 0 : received, total: asset.size } });
  }
}

/** Pauses the running download; the bytes so far are kept. */
export async function pauseDownload(platform: Platform) {
  await platform.update?.cancel();
}

let watching = false;
let waitingPermission = false;
let clearReturnWatch: (() => void) | null = null;

export const isWaitingPermission = (): boolean => waitingPermission && flow.state.step === "permission";

/** If waiting for 安装未知应用 and permission is now granted, resumes installation automatically. */
export async function resumePermissionInstall(platform: Platform): Promise<boolean> {
  if (!waitingPermission || flow.state.step !== "permission") return false;
  const allowed = await platform.update?.canInstall().catch(() => false);
  if (!allowed || !waitingPermission || flow.state.step !== "permission") return false;
  waitingPermission = false;
  clearReturnWatch?.();
  await installUpdate(platform);
  return true;
}

/** After the player comes back from the 安装未知应用 switch, continue by itself when it is on now. */
function continueOnReturn(platform: Platform) {
  if (watching) return;
  const hasDoc = typeof document !== "undefined";
  const hasWin = typeof window !== "undefined";
  if (!hasDoc && !hasWin) return;
  watching = true;
  const cleanup = () => {
    if (!watching) return;
    watching = false;
    clearReturnWatch = null;
    if (hasDoc) document.removeEventListener("visibilitychange", onReturn);
    if (hasWin) {
      window.removeEventListener("lishi:app-resume", onReturn);
      window.removeEventListener("focus", onReturn);
    }
  };
  const onReturn = () => {
    if (hasDoc && document.visibilityState !== "visible") return;
    cleanup();
    void resumePermissionInstall(platform);
  };
  clearReturnWatch = cleanup;
  if (hasDoc) document.addEventListener("visibilitychange", onReturn);
  if (hasWin) {
    window.addEventListener("lishi:app-resume", onReturn);
    window.addEventListener("focus", onReturn);
  }
}

/** Hands the verified package to the system installer. */
export async function installUpdate(
  platform: Platform,
  pkg?: { version: string; size: number; sha256: string },
): Promise<"started" | "permission" | "unsupported" | "failed"> {
  const update = platform.update;
  if (pkg && pkg.version && pkg.sha256 && (flow.version !== pkg.version || !flow.sha256 || flow.state.step === "idle")) {
    set({ version: pkg.version, size: pkg.size, sha256: pkg.sha256, state: { step: "ready" } });
  }
  const { version, size, sha256 } = flow;
  if (!update || !version || !sha256) return "failed";
  try {
    const rawStatus = await update.install({ version, size, sha256 });
    const status = (rawStatus as string) === "needs_permission" ? "permission" : rawStatus;
    if (flow.version !== version) return status;
    if (status === "permission") {
      waitingPermission = true;
      set({ state: { step: "permission" } });
      continueOnReturn(platform);
    } else if (status === "started") {
      waitingPermission = false;
      clearReturnWatch?.();
      set({ state: { step: "installing" } });
    } else {
      waitingPermission = false;
      clearReturnWatch?.();
      set({ state: { step: "ready" } });
    }
    return status;
  } catch (error) {
    waitingPermission = false;
    clearReturnWatch?.();
    if (flow.version === version) {
      const code = codeOf(error);
      const reason: FailReason = code === "update_hash" ? "corrupt" : code === "update_missing" ? "missing" : "install";
      set({ state: { step: "failed", reason, received: 0, total: size } });
    }
    return "failed";
  }
}
