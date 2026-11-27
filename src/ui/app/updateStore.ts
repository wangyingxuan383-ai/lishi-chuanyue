// The update reminder survives navigation and restart. Reading a release is
// separate from checking for it, so visiting Settings never clears the dot.
import { useEffect, useSyncExternalStore } from "react";
import type { Repo } from "../../engine/db/repo";
import type { Platform } from "../../platform";
import { expectedHash, latestRelease, newer, platformPackage, type ReleaseInfo } from "./update";
import {
  hydrateReadyPackage,
  invalidateReadyPackage,
  isBackgroundSyncing,
  snapshot as flowSnapshot,
  syncBackgroundComplete,
  syncBackgroundEvent,
  syncBackgroundStart,
  syncBackgroundStopped,
} from "./updateFlow";

const CHECK_COOLDOWN_MS = 86_400_000;
const AUTO_PREPARE_POLL_MS = 15_000;
const MIN_FREE_FLOOR_BYTES = 250 * 1024 * 1024;

export interface UpdateNotice {
  release: ReleaseInfo | null;
  readVersion: string | null;
  checkedAt: number;
  checking: boolean;
  failed: boolean;
  readyRelease: ReleaseInfo | null;
  dismissedReadyVersion: string | null;
  canInstall: boolean;
  preparing: boolean;
}

function appBuildVersion(): string {
  return typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : "0.0.0";
}

/** Ignore an incomplete cache from an interrupted/older write. */
function cachedRelease(value: unknown): ReleaseInfo | null {
  if (!value || typeof value !== "object") return null;
  const r = value as ReleaseInfo;
  if (![r.version, r.name, r.notes, r.url, r.publishedAt].every((v) => typeof v === "string")
    || typeof r.prerelease !== "boolean" || !Array.isArray(r.assets)) return null;
  if (r.assets.some((a) => !a || typeof a.name !== "string" || typeof a.url !== "string"
    || !Number.isSafeInteger(a.size) || a.size <= 0 || !(a.sha256 === null || typeof a.sha256 === "string"))) return null;
  return r;
}

export function hasUnreadUpdate(state: UpdateNotice, currentVersion: string): boolean {
  return !!state.release && newer(state.release.version, currentVersion)
    && (!state.readVersion || newer(state.release.version, state.readVersion));
}

export function hasPromptableReadyUpdate(state: UpdateNotice, currentVersion: string): boolean {
  return !!state.readyRelease
    && newer(state.readyRelease.version, currentVersion)
    && state.dismissedReadyVersion !== state.readyRelease.version;
}

export function createUpdateStore(repo: Repo, platform: Platform, currentVersion = appBuildVersion()) {
  let state: UpdateNotice = {
    release: null,
    readVersion: null,
    checkedAt: 0,
    checking: false,
    failed: false,
    readyRelease: null,
    dismissedReadyVersion: null,
    canInstall: false,
    preparing: false,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<UpdateNotice>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  let loading: Promise<void> | null = null;
  let checking: Promise<void> | null = null;
  let preparing: Promise<boolean> | null = null;
  let reading = Promise.resolve();

  const hydratePackage = async (target: ReleaseInfo | null, allowSumsFetch: boolean): Promise<void> => {
    if (platform.name !== "android" || !platform.update) {
      if (state.readyRelease !== null || state.canInstall !== false) {
        set({ readyRelease: null, canInstall: false });
      }
      return;
    }
    if (!target || !newer(target.version, currentVersion)) {
      const canInstall = await platform.update.canInstall().catch(() => false);
      set({ readyRelease: null, canInstall });
      return;
    }
    const asset = platformPackage(platform, target);
    if (!asset || !platform.update.packageStatus) {
      const canInstall = await platform.update.canInstall().catch(() => false);
      set({ canInstall });
      return;
    }
    const sha256 = asset.sha256 ?? (allowSumsFetch ? await expectedHash(platform, target, asset).catch(() => null) : null);
    if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
      invalidateReadyPackage(target.version);
      const canInstall = await platform.update.canInstall().catch(() => false);
      set({ readyRelease: null, canInstall });
      return;
    }
    const pkg = await platform.update.packageStatus({ version: target.version, sha256 }).catch(() => null);
    if (pkg && pkg.downloaded && pkg.verified) {
      hydrateReadyPackage({ version: target.version, url: asset.url, size: asset.size, sha256 });
      set({ readyRelease: target, canInstall: pkg.canInstall });
    } else {
      invalidateReadyPackage(target.version);
      set({ readyRelease: null, canInstall: pkg?.canInstall ?? false });
    }
  };

  const load = () => loading ??= (async () => {
    const [release, read, checkedAt, lastCheckAt, skipped, dismissedReady] = await Promise.all([
      repo.getSetting<unknown>("updateLatestRelease", null),
      repo.getSetting<unknown>("updateReadVersion", null),
      repo.getSetting<unknown>("updateCheckedAt", 0),
      repo.getSetting<unknown>("updateLastCheckAt", 0),
      repo.getSetting<unknown>("updateSkipped", null),
      repo.getSetting<unknown>("updateDismissedReadyVersion", null),
    ]);
    const tsA = typeof checkedAt === "number" && Number.isFinite(checkedAt) ? checkedAt : 0;
    const tsB = typeof lastCheckAt === "number" && Number.isFinite(lastCheckAt) ? lastCheckAt : 0;
    const parsed = cachedRelease(release);
    set({
      release: parsed,
      readVersion: typeof read === "string" ? read : typeof skipped === "string" ? skipped : null,
      checkedAt: Math.max(tsA, tsB),
      dismissedReadyVersion: typeof dismissedReady === "string" ? dismissedReady : null,
    });
    await hydratePackage(parsed, false);
  })();

  const checkBusy = async (isBusy?: () => boolean): Promise<boolean> => {
    try {
      if (isBusy?.()) return true;
    } catch {
      return true;
    }
    if (platform.execution?.list) {
      const active = await platform.execution.list().catch(() => []);
      if (active.some((item) => item.status === "running")) return true;
    }
    return false;
  };

  return {
    load,
    snapshot: () => state,
    get readyRelease() { return state.readyRelease; },
    get dismissedReadyVersion() { return state.dismissedReadyVersion; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async refreshStatus() {
      await load();
      await hydratePackage(state.release, false);
    },
    async dismissReady(version?: string) {
      await load();
      const target = version ?? state.readyRelease?.version ?? state.release?.version ?? null;
      if (!target) return;
      await repo.setSetting("updateDismissedReadyVersion", target);
      set({ dismissedReadyVersion: target });
    },
    async check(manual = false) {
      await load();
      if (
        !manual &&
        (!(await repo.getSetting("autoUpdateCheck", true)) ||
          (state.checkedAt > 0 && Date.now() - state.checkedAt < CHECK_COOLDOWN_MS))
      ) {
        return;
      }
      if (checking) return checking;
      checking = (async () => {
        set({ checking: true, failed: false });
        try {
          // Android installs in the app, so a release without its package does not count yet (D158).
          const release = await latestRelease(platform, { needPackage: platform.name === "android" });
          // Only stamp the 24h cooldown AFTER the network check succeeds!
          const checkedAt = Date.now();
          await Promise.all([
            repo.setSetting("updateLatestRelease", release),
            repo.setSetting("updateCheckedAt", checkedAt),
            repo.setSetting("updateLastCheckAt", checkedAt),
          ]);
          set({ release, checkedAt, failed: false });
          await hydratePackage(release, false);
        } catch {
          // A temporary network or DNS failure must neither erase an unread cached release nor stamp checkedAt.
          set({ failed: true });
        } finally {
          set({ checking: false });
        }
      })().finally(() => { checking = null; });
      return checking;
    },
    async autoPrepare(opts?: { isBusy?: () => boolean }): Promise<boolean> {
      await load();
      if (platform.name !== "android" || !platform.update) return false;
      if (preparing) return preparing;
      preparing = (async () => {
        // Gate 1: Default-OFF setting — MUST be strictly true.
        const autoUpdate = await repo.getSetting<unknown>("autoUpdate", false);
        if (autoUpdate !== true) return false;
        if (platform.name !== "android" || !platform.update) return false;
        if (await checkBusy(opts?.isBusy)) return false;

        // Gate 2: Newer non-ignored release with a matching platform asset + valid SHA-256.
        const release = state.release;
        if (!release || !newer(release.version, currentVersion)) return false;
        const skipped = await repo.getSetting<unknown>("updateSkipped", null);
        if (typeof skipped === "string" && skipped === release.version) return false;
        const asset = platformPackage(platform, release);
        if (!asset || asset.size <= 0) return false;
        const currentFlow = flowSnapshot();
        if (
          !isBackgroundSyncing() &&
          currentFlow.version === release.version &&
          (currentFlow.state.step === "preparing" ||
            currentFlow.state.step === "downloading" ||
            currentFlow.state.step === "verifying" ||
            currentFlow.state.step === "permission" ||
            currentFlow.state.step === "installing")
        ) {
          return false;
        }
        const sha256 = await expectedHash(platform, release, asset).catch(() => null);
        if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) return false;

        // Already downloaded & verified on disk? Hydrate immediately without re-downloading.
        let initialBytes = 0;
        if (platform.update.packageStatus) {
          const existing = await platform.update.packageStatus({ version: release.version, sha256 }).catch(() => null);
          if (existing?.downloaded && existing.verified) {
            hydrateReadyPackage({ version: release.version, url: asset.url, size: asset.size, sha256 });
            set({ readyRelease: release, canInstall: existing.canInstall });
            return true;
          }
          invalidateReadyPackage(release.version);
          initialBytes = existing?.bytes ?? 0;
        }

        // Gate 3: Environment check — unmetered Wi-Fi + sufficient free disk space.
        if (!platform.update.environmentStatus) return false;
        const env = await platform.update.environmentStatus().catch(() => null);
        const minFreeBytes = Math.max(asset.size * 2.5, MIN_FREE_FLOOR_BYTES);
        if (!env || env.wifiUnmetered !== true || typeof env.freeBytes !== "number" || env.freeBytes < minFreeBytes) {
          return false;
        }
        if (await checkBusy(opts?.isBusy)) return false;

        // Silent background download with 15s guard polling; keeps .part on abort for HTTP Range resume.
        let aborted = false;
        let finished = false;
        let receivedBytes = initialBytes;
        set({ preparing: true });
        syncBackgroundStart({
          version: release.version,
          url: asset.url,
          size: asset.size,
          sha256,
          received: initialBytes,
        });
        const pollTimer = setInterval(() => {
          if (aborted || finished) return;
          void (async () => {
            if (aborted || finished) return;
            const busyNow = await checkBusy(opts?.isBusy);
            if (busyNow) {
              aborted = true;
              await platform.update?.cancel().catch(() => {});
              return;
            }
            const nextEnv = await platform.update?.environmentStatus?.().catch(() => null);
            if (!nextEnv || nextEnv.wifiUnmetered !== true) {
              aborted = true;
              await platform.update?.cancel().catch(() => {});
            }
          })();
        }, AUTO_PREPARE_POLL_MS);

        try {
          await platform.update.download(
            { version: release.version, url: asset.url, size: asset.size, sha256 },
            (event) => {
              if (event.type === "progress") receivedBytes = event.received;
              syncBackgroundEvent(release.version, asset.size, event);
            },
          );
          finished = true;
          if (aborted) {
            syncBackgroundStopped(release.version, asset.size, receivedBytes);
            return false;
          }
          // Re-verify packageStatus before marking readyRelease; NEVER auto-launch OS installer.
          if (platform.update.packageStatus) {
            const verified = await platform.update.packageStatus({ version: release.version, sha256 }).catch(() => null);
            if (!verified || !verified.downloaded || !verified.verified) {
              syncBackgroundStopped(release.version, asset.size, verified?.bytes ?? 0);
              invalidateReadyPackage(release.version);
              if (state.readyRelease?.version === release.version) set({ readyRelease: null });
              return false;
            }
            syncBackgroundComplete({ version: release.version, url: asset.url, size: asset.size, sha256 });
            set({ readyRelease: release, canInstall: verified.canInstall });
          } else {
            syncBackgroundComplete({ version: release.version, url: asset.url, size: asset.size, sha256 });
            const canInstall = await platform.update.canInstall().catch(() => false);
            set({ readyRelease: release, canInstall });
          }
          return true;
        } catch {
          finished = true;
          syncBackgroundStopped(release.version, asset.size, receivedBytes);
          if (state.readyRelease?.version === release.version) set({ readyRelease: null });
          return false;
        } finally {
          finished = true;
          clearInterval(pollTimer);
          set({ preparing: false });
        }
      })().finally(() => { preparing = null; });
      return preparing;
    },
    markRead(version: string) {
      reading = reading.catch(() => {}).then(async () => {
        await load();
        if (state.readVersion && !newer(version, state.readVersion)) return;
        await repo.setSetting("updateReadVersion", version);
        set({ readVersion: version });
      });
      return reading;
    },
  };
}

export type UpdateStore = ReturnType<typeof createUpdateStore>;
const stores = new WeakMap<Repo, UpdateStore>();

export function updateStore(repo: Repo, platform: Platform): UpdateStore {
  let store = stores.get(repo);
  if (!store) { store = createUpdateStore(repo, platform); stores.set(repo, store); }
  return store;
}

export function useUpdateNotice(game: { repo: Repo; platform: Platform }) {
  const store = updateStore(game.repo, game.platform);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    void store.load().then(() => store.autoPrepare()).catch(() => {});
    const onResume = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void store.refreshStatus().catch(() => {});
      }
    };
    window.addEventListener("lishi:app-resume", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      window.removeEventListener("lishi:app-resume", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [store]);
  const current = appBuildVersion();
  return {
    store,
    state,
    unread: hasUnreadUpdate(state, current),
    readyToPrompt: hasPromptableReadyUpdate(state, current),
  };
}
