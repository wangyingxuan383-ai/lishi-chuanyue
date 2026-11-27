import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBound } from "../../devserver/relay";
import { Repo } from "./db/repo";
import {
  PlatformError,
  type Platform,
  type UpdateEnvironmentStatus,
  type UpdateEvent,
  type UpdatePackageStatus,
  type UpdateRequest,
} from "../platform";
import { orderedKeepAwake } from "../platform/screenAwake";
import { assertBound } from "../platform/web";
import { REPO_URL, type ReleaseAsset, type ReleaseInfo } from "../ui/app/update";
import {
  hydrateReadyPackage,
  installUpdate,
  invalidateReadyPackage,
  resetUpdateFlow,
  snapshot,
  startDownload,
  stepFor,
} from "../ui/app/updateFlow";
import { createUpdateStore } from "../ui/app/updateStore";
import { resolveSheetStep } from "../ui/components/UpdateSheet";
import { sanitizeOpeningExportTitle } from "../ui/screens/NewGame";

const ROOT = path.resolve(__dirname, "../..");
const HASH_OLD = "a".repeat(64);
const HASH_NEW = "b".repeat(64);

function makeApk(overrides: Partial<ReleaseAsset> = {}): ReleaseAsset {
  return {
    name: "chuanyue-0.23.0.apk",
    size: 40_000_000,
    url: `${REPO_URL}/releases/download/v0.23.0/chuanyue-0.23.0.apk`,
    sha256: HASH_OLD,
    ...overrides,
  };
}

function makeRelease(assets: ReleaseAsset[], version = "0.23.0"): ReleaseInfo {
  return {
    version,
    name: `v${version}`,
    notes: "更新内容",
    url: `${REPO_URL}/releases/tag/v${version}`,
    publishedAt: "2026-11-27T00:00:00Z",
    prerelease: false,
    assets,
  };
}

function memoryRepo(initial: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(initial));
  const repo = {
    async getSetting<T>(key: string, fallback: T): Promise<T> {
      return (map.has(key) ? map.get(key) : fallback) as T;
    },
    async setSetting(key: string, value: unknown): Promise<void> {
      map.set(key, value);
    },
  } as unknown as Repo;
  return { repo, map };
}

beforeEach(() => {
  resetUpdateFlow();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("R41-T008: Guide backup FAQ consistency (#2)", () => {
  it("documents manual backup, default-OFF daily backup, 5 compressed backups, overwrite/migration safety backups, and export advice", () => {
    const guideText = fs.readFileSync(path.join(ROOT, "src/ui/screens/Guide.tsx"), "utf8");
    expect(guideText).not.toContain("保留 20 份");
    expect(guideText).toContain("设置 → 存档与数据");
    expect(guideText).toContain("每日自动备份");
    expect(guideText).toContain("默认关闭");
    expect(guideText).toContain("最多保留最近 5 份压缩备份");
    expect(guideText).toContain("覆盖导入世界与数据库升级前也会自动备份一次");
    expect(guideText).toContain("卸载应用会删掉本机所有世界");
  });
});

describe("R41-T008: Updater hash refresh, ready re-verification, background sync & Windows gate (#4, E08, E22)", () => {
  it("refreshes expectedHash from scratch after corrupt/nohash/unavailable failure or same-version asset replacement", async () => {
    const sumsAsset: ReleaseAsset = {
      name: "SHA256SUMS.txt",
      size: 128,
      url: `${REPO_URL}/releases/download/v0.23.0/SHA256SUMS.txt`,
      sha256: null,
    };
    const apkNoDigest = makeApk({ sha256: null, size: 1000 });
    let currentSumsText = `${HASH_OLD}  chuanyue-0.23.0.apk\n`;
    const fetchText = vi.fn(async () => currentSumsText);
    let failCorrupt = true;
    const download = vi.fn(async (_req: UpdateRequest, onEvent: (e: UpdateEvent) => void) => {
      onEvent({ type: "progress", received: 500, total: _req.size });
      if (failCorrupt) {
        throw new PlatformError("update_hash", "安装包校验没通过，已删除");
      }
    });
    const platform = {
      name: "android",
      update: {
        download,
        cancel: vi.fn(async () => {}),
        fetchText,
        install: vi.fn(async () => "started" as const),
        canInstall: vi.fn(async () => true),
      },
    } as unknown as Platform;

    // First attempt fails with corrupt hash; publisher then updates SHA256SUMS.txt for the same version.
    await startDownload(platform, makeRelease([apkNoDigest, sumsAsset]), apkNoDigest);
    expect(stepFor(snapshot(), "0.23.0")).toEqual({
      step: "failed",
      reason: "corrupt",
      received: 0,
      total: 1000,
    });
    expect(download).toHaveBeenLastCalledWith(
      expect.objectContaining({ sha256: HASH_OLD, size: 1000 }),
      expect.any(Function),
    );

    failCorrupt = false;
    currentSumsText = `${HASH_NEW}  chuanyue-0.23.0.apk\n`;
    await startDownload(platform, makeRelease([apkNoDigest, sumsAsset]), apkNoDigest);
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenLastCalledWith(
      expect.objectContaining({ sha256: HASH_NEW, size: 1000 }),
      expect.any(Function),
    );
    expect(stepFor(snapshot(), "0.23.0")).toEqual({ step: "ready" });

    // Same version re-uploaded with a different size/digest refreshes flow.sha256 and restarts cleanly.
    const replacedApk = makeApk({ size: 2048, sha256: "d".repeat(64) });
    await startDownload(platform, makeRelease([replacedApk]), replacedApk);
    expect(download).toHaveBeenLastCalledWith(
      expect.objectContaining({ sha256: "d".repeat(64), size: 2048 }),
      expect.any(Function),
    );
    expect(snapshot().sha256).toBe("d".repeat(64));
    expect(snapshot().size).toBe(2048);
  });

  it("updates ready hash on hydrate/install and invalidates stale ready state when disk verification fails", async () => {
    hydrateReadyPackage({ version: "0.23.0", size: 1000, sha256: HASH_OLD });
    expect(snapshot().sha256).toBe(HASH_OLD);
    expect(stepFor(snapshot(), "0.23.0")).toEqual({ step: "ready" });

    // Hydrating a re-published package of the same version updates size & sha256 in place.
    hydrateReadyPackage({ version: "0.23.0", size: 1500, sha256: HASH_NEW });
    expect(snapshot().sha256).toBe(HASH_NEW);
    expect(snapshot().size).toBe(1500);

    // Passing an updated package to installUpdate never uses the superseded hash.
    const install = vi.fn(async () => "started" as const);
    const platform = {
      name: "android",
      update: {
        download: vi.fn(),
        cancel: vi.fn(),
        fetchText: vi.fn(),
        install,
        canInstall: vi.fn(async () => true),
      },
    } as unknown as Platform;

    const thirdHash = "e".repeat(64);
    await installUpdate(platform, { version: "0.23.0", size: 1800, sha256: thirdHash });
    expect(install).toHaveBeenCalledWith({ version: "0.23.0", size: 1800, sha256: thirdHash });

    // When packageStatus reports verified === false, invalidateReadyPackage + resolveSheetStep never show stale green Ready.
    resetUpdateFlow();
    hydrateReadyPackage({ version: "0.23.0", size: 1800, sha256: thirdHash });
    expect(stepFor(snapshot(), "0.23.0")).toEqual({ step: "ready" });
    const unverifiedDisk: UpdatePackageStatus & { sha256: string } = {
      downloaded: false,
      verified: false,
      bytes: 0,
      canInstall: true,
      sha256: thirdHash,
    };
    expect(resolveSheetStep({ step: "ready" }, unverifiedDisk, makeApk())).toEqual({ step: "idle" });
    invalidateReadyPackage("0.23.0");
    expect(stepFor(snapshot(), "0.23.0")).toEqual({ step: "idle" });
  });

  it("polls and retries update_busy with backoff instead of failing after a single 400ms wait", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const cancel = vi.fn(async () => {});
    const download = vi.fn(async () => {
      attempts++;
      if (attempts <= 3) {
        throw new PlatformError("update_busy", "已经在下载了");
      }
    });
    const platform = {
      name: "android",
      update: {
        download,
        cancel,
        fetchText: vi.fn(),
        install: vi.fn(),
        canInstall: vi.fn(async () => true),
      },
    } as unknown as Platform;

    const apk = makeApk();
    const run = startDownload(platform, makeRelease([apk]), apk);
    await vi.runAllTimersAsync();
    await run;

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(4);
    expect(stepFor(snapshot(), "0.23.0")).toEqual({ step: "ready" });
  });

  it("synchronizes background autoPrepare progress into updateFlow so UpdateSheet never misreports 'paused'", async () => {
    const apk = makeApk({ size: 20 * 1024 * 1024 });
    const rel = makeRelease([apk]);
    const { repo } = memoryRepo({ updateLatestRelease: rel, autoUpdate: true });

    let finishDownload!: () => void;
    let emitProgress!: (event: UpdateEvent) => void;
    let diskVerified = false;

    const platform = {
      name: "android",
      llm: { getPublic: vi.fn() },
      update: {
        download: vi.fn((_req: UpdateRequest, onEvent: (e: UpdateEvent) => void) => {
          emitProgress = onEvent;
          return new Promise<void>((resolve) => {
            finishDownload = () => {
              diskVerified = true;
              resolve();
            };
          });
        }),
        cancel: vi.fn(async () => {}),
        fetchText: vi.fn(),
        install: vi.fn(),
        canInstall: vi.fn(async () => true),
        packageStatus: vi.fn(async (): Promise<UpdatePackageStatus> => ({
          downloaded: diskVerified,
          verified: diskVerified,
          bytes: diskVerified ? apk.size : 6 * 1024 * 1024,
          canInstall: true,
        })),
        environmentStatus: vi.fn(async (): Promise<UpdateEnvironmentStatus> => ({
          wifiUnmetered: true,
          freeBytes: 500 * 1024 * 1024,
        })),
      },
    } as unknown as Platform;

    const store = createUpdateStore(repo, platform, "0.22.0");
    const prepPromise = store.autoPrepare();
    await new Promise((r) => setTimeout(r, 10));

    expect(store.snapshot().preparing).toBe(true);
    emitProgress({ type: "progress", received: 8 * 1024 * 1024, total: apk.size });
    const midStep = stepFor(snapshot(), "0.23.0");
    expect(midStep).toEqual({
      step: "downloading",
      received: 8 * 1024 * 1024,
      total: apk.size,
      retrying: false,
    });
    const hydratedPartial = {
      downloaded: false,
      verified: false,
      bytes: 8 * 1024 * 1024,
      canInstall: true,
      sha256: HASH_OLD,
    };
    expect(resolveSheetStep({ step: "idle" }, hydratedPartial, apk, true).step).toBe("downloading");

    finishDownload();
    expect(await prepPromise).toBe(true);
    expect(stepFor(snapshot(), "0.23.0")).toEqual({ step: "ready" });
  });

  it("E08: skips hydratePackage and autoPrepare on Windows so .msi/.exe is never silently fetched as .apk", async () => {
    const winAsset: ReleaseAsset = {
      name: "chuanyue-0.23.0-windows-x64-setup.exe",
      size: 18_000_000,
      url: `${REPO_URL}/releases/download/v0.23.0/chuanyue-0.23.0-windows-x64-setup.exe`,
      sha256: HASH_NEW,
    };
    const { repo } = memoryRepo({ updateLatestRelease: makeRelease([winAsset]), autoUpdate: true });
    const download = vi.fn();
    const packageStatus = vi.fn();
    const environmentStatus = vi.fn();
    const winPlatform = {
      name: "windows",
      llm: { getPublic: vi.fn() },
      update: {
        download,
        cancel: vi.fn(),
        fetchText: vi.fn(),
        install: vi.fn(),
        canInstall: vi.fn(async () => false),
        packageStatus,
        environmentStatus,
      },
    } as unknown as Platform;

    const store = createUpdateStore(repo, winPlatform, "0.22.0");
    await store.load();
    expect(await store.autoPrepare()).toBe(false);
    expect(packageStatus).not.toHaveBeenCalled();
    expect(environmentStatus).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(store.readyRelease).toBeNull();

    const updatesRs = fs.readFileSync(path.join(ROOT, "src-tauri/src/updates.rs"), "utf8");
    expect(updatesRs).toContain("wifi_unmetered: false");
    const settingsTsx = fs.readFileSync(path.join(ROOT, "src/ui/screens/Settings.tsx"), "utf8");
    expect(settingsTsx).toContain('const canInAppUpdate = game.platform.name === "android" && !!game.platform.update;');
  });
});

describe("R41-T008: Export filename sanitization & Android SAF onResume / TTS / Volume guards (E09, E23)", () => {
  it("E09: sanitizes NewGame opening export titles across illegal chars, control codes, trailing dots and Windows device names", () => {
    expect(sanitizeOpeningExportTitle("大明/1644:崇祯?*\"<>|\r\n开篇...")).toBe("大明·1644·崇祯·开篇");
    expect(sanitizeOpeningExportTitle("   ...   ")).toBe("未命名");
    expect(sanitizeOpeningExportTitle("")).toBe("未命名");
    for (const dev of ["CON", "prn", "Aux", "NUL", "COM1", "lpt9"]) {
      expect(sanitizeOpeningExportTitle(dev)).toBe(`_${dev}`);
    }
  });

  it("E09 & E23: verifies Android Kotlin plugins avoid synchronous onResume hasWindowFocus deadlock and reset dead TTS", () => {
    const pickerKt = fs.readFileSync(
      path.join(ROOT, "src-tauri/gen/android/app/src/main/java/io/timejump/chuanyue/DocumentPickerPlugin.kt"),
      "utf8",
    );
    const filesKt = fs.readFileSync(
      path.join(ROOT, "src-tauri/gen/android/app/src/main/java/io/timejump/chuanyue/FilesPlugin.kt"),
      "utf8",
    );
    const notifyKt = fs.readFileSync(
      path.join(ROOT, "src-tauri/gen/android/app/src/main/java/io/timejump/chuanyue/NotificationsPlugin.kt"),
      "utf8",
    );

    expect(pickerKt).not.toContain("if (activity.isInMultiWindowMode || !activity.hasWindowFocus()) return");
    expect(filesKt).not.toContain("if (activity.isInMultiWindowMode || !activity.hasWindowFocus()) return");
    expect(pickerKt).toContain("sanitizeExportDisplayName");
    expect(filesKt).toContain("sanitizeExportDisplayName");
    expect(pickerKt).toContain("scheduleReturnCheck");
    expect(filesKt).toContain("scheduleReturnCheck");

    expect(notifyKt).toContain("override fun onStop(utteranceId: String?, interrupted: Boolean)");
    expect(notifyKt).toContain("resetDeadTts(engine)");
  });

  it("E23: serializes rapid setVolumePageTurn IPC toggles in invocation order", async () => {
    const applied: boolean[] = [];
    let releaseFirst!: () => void;
    const queue = orderedKeepAwake(async (enabled) => {
      if (!enabled) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      applied.push(enabled);
    });

    // ReaderScreen unmount sends `false` (slow), while Play mount immediately sends `true` (fast).
    const first = queue(false);
    const second = queue(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(applied).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(applied).toEqual([false, true]);
    expect(applied[applied.length - 1]).toBe(true);
  });
});

describe("R41-T008: Dev harness URL binding normalization & .claude public isolation (E24, E25)", () => {
  it("E24: rejects .. path traversal, encoded hierarchy escapes, and prefix mismatches in relay.isBound and web.assertBound", () => {
    const base = "https://relay.example.com/team-a/v1";
    const allowed = [
      "https://relay.example.com/team-a/v1",
      "https://relay.example.com/team-a/v1/",
      "https://relay.example.com/team-a/v1/chat/completions",
      "https://relay.example.com/team-a/v1?models=1",
    ];
    for (const target of allowed) {
      expect(isBound(target, base), target).toBe(true);
      expect(() => assertBound(target, base)).not.toThrow();
    }

    const rejected = [
      "https://relay.example.com/team-a/v1/../../other",
      "https://relay.example.com/team-a/v1/../v2/chat/completions",
      "https://relay.example.com/team-a/v1/%2e%2e/other",
      "https://relay.example.com/team-a/v1/sub%2f..%2f..%2fother",
      "https://relay.example.com/team-a/v1\\..\\other",
      "https://relay.example.com/team-a/v1-other/chat/completions",
      "http://relay.example.com/team-a/v1/chat/completions",
      "https://relay.example.com:8443/team-a/v1/chat/completions",
      "https://user:pass@relay.example.com/team-a/v1/chat/completions",
      "https://relay.example.com/team-a/v1/chat/completions#frag",
    ];
    for (const target of rejected) {
      expect(isBound(target, base), `relay should reject ${target}`).toBe(false);
      expect(() => assertBound(target, base), `web should reject ${target}`).toThrowError(
        expect.objectContaining({ code: "llm_url_not_bound" }),
      );
    }
  });

  it("E24: supports Google Gemini /v1beta/openai <-> /v1beta dual-path binding on the same origin", () => {
    const geminiOai = "https://generativelanguage.googleapis.com/v1beta/openai";
    const geminiNativeUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse";
    expect(isBound(geminiNativeUrl, geminiOai)).toBe(true);
    expect(() => assertBound(geminiNativeUrl, geminiOai)).not.toThrow();

    const geminiNat = "https://generativelanguage.googleapis.com/v1beta";
    const geminiOaiUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    expect(isBound(geminiOaiUrl, geminiNat)).toBe(true);
    expect(() => assertBound(geminiOaiUrl, geminiNat)).not.toThrow();

    // Non-segment `foov1beta` and different API version `v1alpha` remain rejected.
    expect(
      isBound("https://relay.example.com/foov1beta/models/x", "https://relay.example.com/foov1beta/openai"),
    ).toBe(false);
    expect(
      isBound("https://generativelanguage.googleapis.com/v1alpha/models/gemini-2.5-flash:generateContent", geminiOai),
    ).toBe(false);
  });

  it("E25: isolates .claude/ in both .gitignore and scripts/publish-public.mjs LOCAL_ONLY", () => {
    const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split(/\r?\n/);
    expect(gitignore).toContain(".claude/");
    expect(gitignore).not.toContain(".claude/worktrees/");

    const publishScript = fs.readFileSync(path.join(ROOT, "scripts/publish-public.mjs"), "utf8");
    expect(publishScript).toContain('".claude/"');
  });
});
