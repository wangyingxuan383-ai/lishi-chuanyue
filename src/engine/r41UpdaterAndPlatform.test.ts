import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
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
import { createOrderedTtsQueue } from "../platform/tauri";
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
  syncBackgroundComplete,
  syncBackgroundStopped,
} from "../ui/app/updateFlow";
import { createUpdateStore } from "../ui/app/updateStore";
import {
  resolveInstallSha,
  resolveSheetStep,
  useUpdateSheetController,
} from "../ui/components/UpdateSheet";
import { sanitizeOpeningExportTitle } from "../ui/screens/NewGame";
import {
  useReaderTts,
  type ReaderTtsController,
  type UseReaderTtsOptions,
} from "../ui/screens/reader/readerTts";

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

  it("E25: isolates .claude/ in .gitignore", () => {
    const gitignorePath = path.join(ROOT, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      const gitignore = fs.readFileSync(gitignorePath, "utf8").split(/\r?\n/);
      expect(gitignore).toContain(".claude/");
      expect(gitignore).not.toContain(".claude/worktrees/");
    }
  });
});

function createMinimalDomHarness() {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const winListeners = new Map<string, Set<EventListener>>();
  const docListeners = new Map<string, Set<EventListener>>();
  const fakeWin = {
    HTMLIFrameElement: class FakeIframe {},
    addEventListener(type: string, fn: EventListener) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: EventListener) {
      winListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev: Event) {
      winListeners.get(ev.type)?.forEach((fn) => fn(ev));
      return true;
    },
  };
  const fakeDoc = {
    nodeType: 9,
    visibilityState: "visible",
    defaultView: fakeWin,
    activeElement: null,
    documentElement: { namespaceURI: "http://www.w3.org/1999/xhtml" },
    addEventListener(type: string, fn: EventListener) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: EventListener) {
      docListeners.get(type)?.delete(fn);
    },
    createElement: (tag: string) => ({
      nodeType: 1,
      nodeName: tag.toUpperCase(),
      tagName: tag.toUpperCase(),
      namespaceURI: "http://www.w3.org/1999/xhtml",
      style: {},
      appendChild: () => {},
      removeChild: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  };
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: fakeDoc,
    appendChild: () => {},
    removeChild: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Element;
  return { fakeWin, fakeDoc, container };
}

describe("R42-T001: UpdateSheet download -> ready transition, hotfix re-verification & resolvedSha precedence", () => {
  it("transitions idle/paused -> preparing -> downloading -> verifying -> ready without getting stuck on stale hydrated snapshot, while still catching hotfix hash changes on already-ready state", async () => {
    const origWin = (globalThis as Record<string, unknown>).window;
    const origDoc = (globalThis as Record<string, unknown>).document;
    const origIframe = (globalThis as Record<string, unknown>).HTMLIFrameElement;
    const { fakeWin, fakeDoc, container } = createMinimalDomHarness();

    const sumsAsset: ReleaseAsset = {
      name: "SHA256SUMS.txt",
      size: 128,
      url: `${REPO_URL}/releases/download/v0.23.0/SHA256SUMS.txt`,
      sha256: null,
    };
    const apk = makeApk({ sha256: null, size: 10_000 });
    let currentSumsHash = HASH_OLD;
    let verifiedHashOnDisk: string | null = null;
    let partialBytesOnDisk = 4_000;
    let emitEvent!: (event: UpdateEvent) => void;
    let finishDownload!: () => void;

    const install = vi.fn(async () => "started" as const);
    const packageStatus = vi.fn(async ({ sha256 }: { version: string; sha256: string }): Promise<UpdatePackageStatus> => {
      const ok = verifiedHashOnDisk === sha256;
      return {
        downloaded: ok,
        verified: ok,
        bytes: ok ? apk.size : partialBytesOnDisk,
        canInstall: true,
      };
    });

    const platform = {
      name: "android",
      update: {
        download: vi.fn((req: UpdateRequest, onEvent: (e: UpdateEvent) => void) => {
          emitEvent = onEvent;
          return new Promise<void>((resolve) => {
            finishDownload = () => {
              verifiedHashOnDisk = req.sha256;
              partialBytesOnDisk = req.size;
              resolve();
            };
          });
        }),
        cancel: vi.fn(async () => {}),
        fetchText: vi.fn(async () => `${currentSumsHash}  ${apk.name}\n`),
        install,
        canInstall: vi.fn(async () => true),
        packageStatus,
      },
    } as unknown as Platform;

    const { repo } = memoryRepo();
    let rel = makeRelease([apk, sumsAsset]);
    let latestCtrl!: ReturnType<typeof useUpdateSheetController>;
    let root: ReturnType<typeof createRoot> | null = null;

    function SheetProbe({ release }: { release: ReleaseInfo }) {
      latestCtrl = useUpdateSheetController({
        repo,
        platform,
        release,
        toast: () => {},
      });
      return null;
    }

    try {
      (globalThis as Record<string, unknown>).window = fakeWin;
      (globalThis as Record<string, unknown>).document = fakeDoc;
      (globalThis as Record<string, unknown>).HTMLIFrameElement = class FakeIframe {};
      root = createRoot(container);

      // 1. Open sheet before download completes (partial .part on disk -> "paused" with verified: false)
      await act(async () => {
        root!.render(createElement(SheetProbe, { release: rel }));
      });
      expect(latestCtrl.effectiveState).toEqual({
        step: "paused",
        received: 4_000,
        total: 10_000,
      });

      // 2. Initiate download -> step through downloading -> verifying -> ready (must NEVER revert to paused/idle!)
      await act(async () => {
        latestCtrl.download();
      });
      expect(latestCtrl.effectiveState.step).toBe("downloading");

      await act(async () => {
        emitEvent({ type: "progress", received: 7_500, total: 10_000 });
      });
      expect(latestCtrl.effectiveState).toEqual({
        step: "downloading",
        received: 7_500,
        total: 10_000,
        retrying: false,
      });

      await act(async () => {
        emitEvent({ type: "verifying" });
      });
      expect(latestCtrl.effectiveState).toEqual({ step: "verifying" });

      await act(async () => {
        finishDownload();
      });
      expect(latestCtrl.effectiveState).toEqual({ step: "ready" });
      expect(latestCtrl.resolvedSha).toBe(HASH_OLD);

      // 3. Hotfix scenario: publisher updates SHA256SUMS.txt to HASH_NEW while state was ALREADY "ready"
      currentSumsHash = HASH_NEW;
      rel = makeRelease([apk, sumsAsset]);
      partialBytesOnDisk = 0;
      await act(async () => {
        root!.render(createElement(SheetProbe, { release: rel }));
      });
      expect(latestCtrl.effectiveState).toEqual({ step: "idle" });
      expect(stepFor(snapshot(), "0.23.0")).toEqual({ step: "idle" });

      // 4. Download hotfixed HASH_NEW and verify install() uses fresh HASH_NEW (never stale HASH_OLD)
      await act(async () => {
        latestCtrl.download();
      });
      await act(async () => {
        finishDownload();
      });
      expect(latestCtrl.effectiveState).toEqual({ step: "ready" });
      expect(latestCtrl.resolvedSha).toBe(HASH_NEW);
      await act(async () => {
        await latestCtrl.install();
      });
      expect(install).toHaveBeenCalledWith({
        version: "0.23.0",
        size: 10_000,
        sha256: HASH_NEW,
      });
    } finally {
      try {
        if (root) {
          await act(async () => {
            root!.unmount();
          });
        }
      } finally {
        (globalThis as Record<string, unknown>).window = origWin;
        (globalThis as Record<string, unknown>).document = origDoc;
        (globalThis as Record<string, unknown>).HTMLIFrameElement = origIframe;
      }
    }
  });

  it("prefers asset.sha256, then fresh flow.sha256 over stale hydrated.sha256 in resolveInstallSha", () => {
    const apkNoDigest = makeApk({ sha256: null });
    const relNoDigest = makeRelease([apkNoDigest]);
    const staleHydrated = {
      downloaded: true,
      verified: true,
      bytes: apkNoDigest.size,
      canInstall: true,
      sha256: HASH_OLD,
    };
    const freshFlow = {
      version: "0.23.0",
      url: apkNoDigest.url,
      size: apkNoDigest.size,
      sha256: HASH_NEW,
      state: { step: "ready" as const },
    };
    expect(resolveInstallSha(relNoDigest, apkNoDigest, freshFlow, staleHydrated)).toBe(HASH_NEW);

    // Falls back to hydrated.sha256 when flow is for another version or has null sha256
    expect(
      resolveInstallSha(relNoDigest, apkNoDigest, { ...freshFlow, sha256: null }, staleHydrated),
    ).toBe(HASH_OLD);

    // Explicit asset.sha256 takes top precedence
    const explicitHash = "f".repeat(64);
    const apkWithDigest = makeApk({ sha256: explicitHash });
    expect(
      resolveInstallSha(makeRelease([apkWithDigest]), apkWithDigest, freshFlow, staleHydrated),
    ).toBe(explicitHash);
  });
});

describe("R42-T001: updateFlow background preemption race guard", () => {
  it("prevents cancelled autoPrepare's syncBackgroundStopped/syncBackgroundComplete from clobbering preempting startDownload state", async () => {
    vi.useFakeTimers();
    const apk = makeApk({ size: 20_000 });
    const rel = makeRelease([apk]);
    const { repo } = memoryRepo({ updateLatestRelease: rel, autoUpdate: true });

    let bgReject!: (err: unknown) => void;
    let bgEmit!: (ev: UpdateEvent) => void;
    let fgResolve!: () => void;
    let fgEmit!: (ev: UpdateEvent) => void;
    let downloadCallCount = 0;

    const platform = {
      name: "android",
      llm: { getPublic: vi.fn() },
      update: {
        download: vi.fn((_req: UpdateRequest, onEvent: (e: UpdateEvent) => void) => {
          downloadCallCount += 1;
          if (downloadCallCount === 1) {
            bgEmit = onEvent;
            return new Promise<void>((_res, rej) => {
              bgReject = rej;
            });
          }
          if (downloadCallCount === 2) {
            return Promise.reject(new PlatformError("update_busy", "已经在下载了"));
          }
          fgEmit = onEvent;
          return new Promise<void>((res) => {
            fgResolve = res;
          });
        }),
        cancel: vi.fn(async () => {
          bgReject?.(new PlatformError("update_cancelled", "下载已暂停"));
        }),
        fetchText: vi.fn(),
        install: vi.fn(),
        canInstall: vi.fn(async () => true),
        packageStatus: vi.fn(async (): Promise<UpdatePackageStatus> => ({
          downloaded: false,
          verified: false,
          bytes: 0,
          canInstall: true,
        })),
        environmentStatus: vi.fn(async (): Promise<UpdateEnvironmentStatus> => ({
          wifiUnmetered: true,
          freeBytes: 500 * 1024 * 1024,
        })),
      },
    } as unknown as Platform;

    const store = createUpdateStore(repo, platform, "0.22.0");
    const bgPromise = store.autoPrepare();
    await vi.advanceTimersByTimeAsync(10);
    expect(downloadCallCount).toBe(1);

    bgEmit({ type: "progress", received: 5_000, total: apk.size });
    expect(stepFor(snapshot(), "0.23.0")).toEqual({
      step: "downloading",
      received: 5_000,
      total: apk.size,
      retrying: false,
    });

    // Foreground startDownload preempts autoPrepare, cancels background slot, and backs off on update_busy
    const fgPromise = startDownload(platform, rel, apk);
    await vi.advanceTimersByTimeAsync(50);

    // Background autoPrepare has caught cancellation and called syncBackgroundStopped,
    // which MUST NOT overwrite foreground startDownload's active downloading state to "paused"!
    expect(await bgPromise).toBe(false);
    expect(stepFor(snapshot(), "0.23.0")).toEqual({
      step: "downloading",
      received: 5_000,
      total: apk.size,
      retrying: false,
    });

    // Direct late background calls while backgroundSyncing === false are also strict no-ops
    syncBackgroundStopped("0.23.0", apk.size, 5_000);
    syncBackgroundComplete({ version: "0.23.0", url: apk.url, size: apk.size, sha256: HASH_OLD });
    expect(stepFor(snapshot(), "0.23.0").step).toBe("downloading");

    await vi.advanceTimersByTimeAsync(400);
    expect(downloadCallCount).toBe(3);
    fgEmit({ type: "progress", received: 15_000, total: apk.size });
    expect(stepFor(snapshot(), "0.23.0")).toEqual({
      step: "downloading",
      received: 15_000,
      total: apk.size,
      retrying: false,
    });

    fgResolve();
    await fgPromise;
    expect(stepFor(snapshot(), "0.23.0")).toEqual({ step: "ready" });
  });
});

describe("R42-T001: Native TTS FIFO serialization, interrupted/stopped pause & nextParagraph chapter-end advance", () => {
  it("serializes ttsStop and ttsSpeak onto a single FIFO queue without wedging on errors", async () => {
    const order: string[] = [];
    let releaseStop!: () => void;
    const queue = createOrderedTtsQueue(
      async ({ utteranceId }) => {
        order.push(`speak:${utteranceId}`);
        if (utteranceId === "fail-me") throw new Error("ipc boom");
        return true;
      },
      async () => {
        order.push("stop:start");
        await new Promise<void>((resolve) => {
          releaseStop = resolve;
        });
        order.push("stop:done");
      },
    );

    const stopCall = queue.ttsStop();
    const speak1 = queue.ttsSpeak({ utteranceId: "fail-me", text: "第一句", rate: 1.0 });
    const speak2 = queue.ttsSpeak({ utteranceId: "ok-2", text: "第二句", rate: 1.25 });

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["stop:start"]);

    releaseStop();
    const [, r1, r2] = await Promise.all([stopCall, speak1, speak2]);
    expect(r1).toBe(false);
    expect(r2).toBe(true);
    expect(order).toEqual(["stop:start", "stop:done", "speak:fail-me", "speak:ok-2"]);
  });

  it("pauses cleanly on native 'interrupted'/'stopped' without marking unavailable, and honors sleepMode === 'chapter' + immediate cancel in nextParagraph", async () => {
    const origWin = (globalThis as Record<string, unknown>).window;
    const origDoc = (globalThis as Record<string, unknown>).document;
    const origIframe = (globalThis as Record<string, unknown>).HTMLIFrameElement;
    const { fakeWin, fakeDoc, container } = createMinimalDomHarness();

    let latestUtteranceId = "";
    let curSec = 0;
    const spoken: Array<{ sec: number; text: string }> = [];
    const toasts: string[] = [];
    const ttsStop = vi.fn(async () => {});
    const ttsSpeak = vi.fn(async ({ utteranceId, text }: { utteranceId: string; text: string }) => {
      latestUtteranceId = utteranceId;
      spoken.push({ sec: curSec, text });
      return true;
    });

    const chapters = [
      [
        { kind: "prose", text: "第一章首段。" },
        { kind: "prose", text: "第一章末段。" },
      ],
      [{ kind: "prose", text: "第二章首段。" }],
    ];

    const ttsPlatform = {
      name: "android" as const,
      system: {
        ttsSpeak,
        ttsStop,
      },
    } as unknown as Platform;

    let ctrl!: ReaderTtsController;
    let root: ReturnType<typeof createRoot> | null = null;
    let resolveSectionAdvance: (() => void) | null = null;

    let hookProps: UseReaderTtsOptions = {
      platform: ttsPlatform,
      paragraphs: chapters[0]!,
      sectionIndex: 0,
      sectionReady: true,
      jumpTarget: null,
      onSectionEnd: () =>
        new Promise<boolean>((resolve) => {
          resolveSectionAdvance = () => {
            curSec += 1;
            hookProps = {
              ...hookProps,
              sectionIndex: curSec,
              paragraphs: chapters[curSec] ?? [],
            };
            root?.render(createElement(Harness, hookProps));
            resolve(true);
          };
        }),
      toast: (msg) => toasts.push(msg),
    };

    function Harness(props: UseReaderTtsOptions) {
      ctrl = useReaderTts(props);
      return null;
    }

    try {
      (globalThis as Record<string, unknown>).window = fakeWin;
      (globalThis as Record<string, unknown>).document = fakeDoc;
      (globalThis as Record<string, unknown>).HTMLIFrameElement = class FakeIframe {};
      root = createRoot(container);

      await act(async () => {
        root!.render(createElement(Harness, hookProps));
      });

      // 1. Native "interrupted" pauses cleanly (status === "paused", NOT "unavailable")
      await act(async () => {
        ctrl.play(0);
      });
      expect(ctrl.status).toBe("playing");
      expect(ctrl.speakingIndex).toBe(0);

      await act(async () => {
        fakeWin.dispatchEvent(
          new CustomEvent("lishi:tts-event", {
            detail: { utteranceId: latestUtteranceId, state: "interrupted" },
          }),
        );
      });
      expect(ctrl.status).toBe("paused");
      expect(ctrl.speakingIndex).toBe(0);
      expect(toasts).not.toContain("当前设备未安装系统语音朗读引擎");

      // Resume and verify "stopped" also pauses cleanly without marking unavailable
      await act(async () => {
        ctrl.resume();
      });
      expect(ctrl.status).toBe("playing");
      await act(async () => {
        fakeWin.dispatchEvent(
          new CustomEvent("lishi:tts-event", {
            detail: { utteranceId: latestUtteranceId, state: "stopped" },
          }),
        );
      });
      expect(ctrl.status).toBe("paused");
      expect(ctrl.speakingIndex).toBe(0);
      expect(toasts).toEqual([]);

      // 2. nextParagraph() at end of chapter with sleepMode === "chapter" stops immediately & toasts
      await act(async () => {
        ctrl.setSleepMode("chapter");
        ctrl.play(1);
      });
      expect(ctrl.status).toBe("playing");
      expect(ctrl.speakingIndex).toBe(1);
      ttsStop.mockClear();

      await act(async () => {
        ctrl.nextParagraph();
      });
      expect(ttsStop).toHaveBeenCalledTimes(1);
      expect(ctrl.status).toBe("idle");
      expect(ctrl.sleepMode).toBe("off");
      expect(resolveSectionAdvance).toBeNull();
      expect(toasts).toContain("已读完本章，定时朗读结束");

      // 3. nextParagraph() at end of chapter with sleepMode === "off" cancels current speech immediately
      //    while waiting for async onSectionEnd, then speaks paragraph 0 of next chapter
      await act(async () => {
        ctrl.play(1);
      });
      ttsStop.mockClear();
      spoken.length = 0;

      await act(async () => {
        ctrl.nextParagraph();
      });
      // Cancelled immediately BEFORE async section transition resolves!
      expect(ttsStop).toHaveBeenCalledTimes(1);
      expect(spoken).toEqual([]);
      expect(resolveSectionAdvance).not.toBeNull();

      await act(async () => {
        resolveSectionAdvance!();
      });
      expect(curSec).toBe(1);
      expect(ctrl.status).toBe("playing");
      expect(ctrl.speakingIndex).toBe(0);
      expect(spoken).toEqual([{ sec: 1, text: "第二章首段。" }]);

      // 4. Genuine native "error" (without WebSpeech) still transitions to "unavailable"
      await act(async () => {
        fakeWin.dispatchEvent(
          new CustomEvent("lishi:tts-event", {
            detail: { utteranceId: latestUtteranceId, state: "error" },
          }),
        );
      });
      expect(ctrl.status).toBe("unavailable");
      expect(toasts).toContain("当前设备未安装系统语音朗读引擎");
    } finally {
      try {
        if (root) {
          await act(async () => {
            root!.unmount();
          });
        }
      } finally {
        (globalThis as Record<string, unknown>).window = origWin;
        (globalThis as Record<string, unknown>).document = origDoc;
        (globalThis as Record<string, unknown>).HTMLIFrameElement = origIframe;
      }
    }
  });
});

describe("R42-T001: Android SAF timeout quarantine, cross-plugin isBusy guard & surrogate-safe truncation", () => {
  it("verifies DocumentPickerPlugin.kt and FilesPlugin.kt quarantine timed-out slots, guard cross-plugin busy state, and avoid UTF-16 surrogate splits", () => {
    const pickerKt = fs.readFileSync(
      path.join(ROOT, "src-tauri/gen/android/app/src/main/java/io/timejump/chuanyue/DocumentPickerPlugin.kt"),
      "utf8",
    );
    const filesKt = fs.readFileSync(
      path.join(ROOT, "src-tauri/gen/android/app/src/main/java/io/timejump/chuanyue/FilesPlugin.kt"),
      "utf8",
    );

    // Timeout quarantine: calls current.gate.timedOut() without immediately calling finish()
    expect(pickerKt).toContain("current.gate.timedOut()");
    expect(filesKt).toContain("current.gate.timedOut()");
    expect(pickerKt).toContain("quarantineWatch");
    expect(filesKt).toContain("quarantineWatch");

    // Cross-plugin busy guard
    expect(pickerKt).toContain("internal fun isBusy(): Boolean");
    expect(filesKt).toContain("internal fun isBusy(): Boolean");
    expect(pickerKt).toContain("FilesPlugin.isBusy()");
    expect(filesKt).toContain("DocumentPickerPlugin.isBusy()");

    // Surrogate-safe truncation
    expect(pickerKt).toContain("if (cut.isNotEmpty() && Character.isHighSurrogate(cut.last())) cut.dropLast(1)");
  });
});
