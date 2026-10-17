import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformError, type Platform, type UpdateEvent, type UpdateRequest } from "../../platform";
import { REPO_URL, type ReleaseAsset, type ReleaseInfo } from "./update";
import { installUpdate, pauseDownload, resetUpdateFlow, snapshot, startDownload, stepFor, subscribe } from "./updateFlow";

const HASH = "c".repeat(64);
const apk = (sha256: string | null = HASH): ReleaseAsset => ({ name: "chuanyue-0.11.0.apk", size: 1000, url: `${REPO_URL}/releases/download/v0.11.0/chuanyue-0.11.0.apk`, sha256 });
const release = (assets: ReleaseAsset[], version = "0.11.0"): ReleaseInfo => ({
  version, name: version, notes: "", url: `${REPO_URL}/releases/tag/v${version}`, publishedAt: "", prerelease: false, assets,
});

/** A native side whose download the test finishes by hand. */
function native() {
  let finish: { resolve: () => void; reject: (error: unknown) => void; onEvent: (event: UpdateEvent) => void } | null = null;
  const download = vi.fn((_request: UpdateRequest, onEvent: (event: UpdateEvent) => void) =>
    new Promise<void>((resolve, reject) => { finish = { resolve, reject, onEvent }; }));
  const update = {
    download,
    cancel: vi.fn(async () => { finish?.reject(new PlatformError("update_cancelled", "下载已暂停")); }),
    fetchText: vi.fn(async () => ""),
    install: vi.fn(async () => "started" as const),
    canInstall: vi.fn(async () => true),
    devSource: vi.fn(async () => ({ available: false, url: null })),
    setDevSource: vi.fn(async () => {}),
  };
  return {
    platform: { name: "android", update } as unknown as Platform,
    update,
    emit: (event: UpdateEvent) => finish!.onEvent(event),
    succeed: () => finish!.resolve(),
    fail: (code: string) => finish!.reject(new PlatformError(code, code)),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const step = (version = "0.11.0") => stepFor(snapshot(), version);

beforeEach(() => { resetUpdateFlow(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("update download flow", () => {
  it("downloads with the published hash, shows progress, then is ready", async () => {
    const { platform, update, emit, succeed } = native();
    const seen: string[] = [];
    subscribe(() => seen.push(snapshot().state.step));
    const running = startDownload(platform, release([apk()]), apk());
    await settle();
    expect(update.download).toHaveBeenCalledWith({ version: "0.11.0", url: apk().url, size: 1000, sha256: HASH }, expect.any(Function));
    emit({ type: "progress", received: 400, total: 1000 });
    expect(step()).toEqual({ step: "downloading", received: 400, total: 1000, retrying: false });
    emit({ type: "retrying", attempt: 1, waitMs: 1000 });
    expect(step()).toEqual({ step: "downloading", received: 400, total: 1000, retrying: true });
    emit({ type: "verifying" });
    expect(step()).toEqual({ step: "verifying" });
    succeed(); await running;
    expect(step()).toEqual({ step: "ready" });
    expect(seen[0]).toBe("preparing");
    // Another version's sheet still starts from the beginning.
    expect(step("0.12.0")).toEqual({ step: "idle" });
  });

  it("refuses to download without a published hash", async () => {
    const { platform, update } = native();
    await startDownload(platform, release([apk(null)]), apk(null));
    expect(step()).toEqual({ step: "failed", reason: "nohash", received: 0, total: 1000 });
    expect(update.download).not.toHaveBeenCalled();
  });

  it("reads SHA256SUMS.txt when there is no digest, and retries it after a network error", async () => {
    const { platform, update, succeed } = native();
    const sums = { name: "SHA256SUMS.txt", size: 90, url: `${REPO_URL}/releases/download/v0.11.0/SHA256SUMS.txt`, sha256: null };
    update.fetchText.mockRejectedValueOnce(new PlatformError("update_network", "网络中断了"));
    await startDownload(platform, release([apk(null), sums]), apk(null));
    expect(step()).toEqual({ step: "failed", reason: "network", received: 0, total: 1000 });
    expect(update.download).not.toHaveBeenCalled();
    update.fetchText.mockResolvedValueOnce(`${HASH}  chuanyue-0.11.0.apk\n`);
    const retry = startDownload(platform, release([apk(null), sums]), apk(null));
    await settle(); succeed(); await retry;
    expect(update.download).toHaveBeenCalledWith(expect.objectContaining({ sha256: HASH }), expect.any(Function));
    expect(step()).toEqual({ step: "ready" });
  });

  it("pauses, keeps the count and resumes on the next try", async () => {
    const { platform, update, emit, succeed } = native();
    const first = startDownload(platform, release([apk()]), apk());
    await settle();
    emit({ type: "progress", received: 300, total: 1000 });
    // A second tap while it runs does not start another download.
    await startDownload(platform, release([apk()]), apk());
    expect(update.download).toHaveBeenCalledTimes(1);
    await pauseDownload(platform); await first;
    expect(step()).toEqual({ step: "paused", received: 300, total: 1000 });
    const second = startDownload(platform, release([apk()]), apk());
    await settle();
    expect(step()).toEqual({ step: "downloading", received: 300, total: 1000, retrying: false });
    succeed(); await second;
    expect(update.download).toHaveBeenCalledTimes(2);
    expect(step()).toEqual({ step: "ready" });
  });

  it.each([
    ["update_network", "network", 500], ["update_http", "unavailable", 500], ["update_hash", "corrupt", 0],
    ["update_size", "corrupt", 0], ["update_storage", "storage", 500], ["ipc", "other", 500],
  ])("maps %s to a player-facing reason", async (code, reason, received) => {
    const { platform, emit, fail } = native();
    const running = startDownload(platform, release([apk()]), apk());
    await settle();
    emit({ type: "progress", received: 500, total: 1000 });
    fail(code); await running;
    expect(step()).toEqual({ step: "failed", reason, received, total: 1000 });
  });

  it("stops a download it lost track of and starts again once", async () => {
    vi.useFakeTimers();
    const { platform, update } = native();
    update.download.mockRejectedValueOnce(new PlatformError("update_busy", "已经在下载了")).mockResolvedValueOnce(undefined);
    const running = startDownload(platform, release([apk()]), apk());
    await vi.runAllTimersAsync(); await running;
    expect(update.cancel).toHaveBeenCalledTimes(1);
    expect(update.download).toHaveBeenCalledTimes(2);
    expect(step()).toEqual({ step: "ready" });
  });
});

describe("handing the package to the installer", () => {
  async function ready() {
    const fake = native();
    const running = startDownload(fake.platform, release([apk()]), apk());
    await settle(); fake.succeed(); await running;
    return fake;
  }

  it("opens the installer with the verified version, size and hash", async () => {
    const { platform, update } = await ready();
    expect(await installUpdate(platform)).toBe("started");
    expect(update.install).toHaveBeenCalledWith({ version: "0.11.0", size: 1000, sha256: HASH });
    expect(step()).toEqual({ step: "installing" });
  });

  it("asks for 安装未知应用, then continues by itself when the player comes back allowed", async () => {
    const { platform, update } = await ready();
    const listeners = new Set<() => void>();
    const page = { visibilityState: "hidden", addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) };
    vi.stubGlobal("document", page);
    update.install.mockResolvedValueOnce("permission" as never);
    expect(await installUpdate(platform)).toBe("permission");
    expect(step()).toEqual({ step: "permission" });
    for (const f of [...listeners]) f(); // still in the system settings
    expect(update.canInstall).not.toHaveBeenCalled();
    page.visibilityState = "visible";
    for (const f of [...listeners]) f();
    await settle(); await settle();
    expect(update.canInstall).toHaveBeenCalledTimes(1);
    expect(update.install).toHaveBeenCalledTimes(2);
    expect(step()).toEqual({ step: "installing" });
    expect(listeners.size).toBe(0);
  });

  it("stays on the permission step when the switch is still off", async () => {
    const { platform, update } = await ready();
    const listeners = new Set<() => void>();
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) });
    update.install.mockResolvedValueOnce("permission" as never);
    update.canInstall.mockResolvedValueOnce(false);
    await installUpdate(platform);
    for (const f of [...listeners]) f();
    await settle(); await settle();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(step()).toEqual({ step: "permission" });
  });

  it.each([["update_hash", "corrupt"], ["update_missing", "missing"], ["update_install", "install"]])("reports %s from the installer step", async (code, reason) => {
    const { platform, update } = await ready();
    update.install.mockRejectedValueOnce(new PlatformError(code, code));
    expect(await installUpdate(platform)).toBe("failed");
    expect(step()).toEqual({ step: "failed", reason, received: 0, total: 1000 });
  });

  it("keeps the ready step where the platform cannot install", async () => {
    const { platform, update } = await ready();
    update.install.mockResolvedValueOnce("unsupported" as never);
    expect(await installUpdate(platform)).toBe("unsupported");
    expect(step()).toEqual({ step: "ready" });
  });
});
