// The update reminder survives navigation and restart. Reading a release is
// separate from checking for it, so visiting Settings never clears the dot.
import { useEffect, useSyncExternalStore } from "react";
import type { Repo } from "../../engine/db/repo";
import type { Platform } from "../../platform";
import { latestRelease, newer, type ReleaseInfo } from "./update";

export interface UpdateNotice {
  release: ReleaseInfo | null;
  readVersion: string | null;
  checkedAt: number;
  checking: boolean;
  failed: boolean;
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

export function createUpdateStore(repo: Repo, platform: Platform) {
  let state: UpdateNotice = { release: null, readVersion: null, checkedAt: 0, checking: false, failed: false };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<UpdateNotice>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  let loading: Promise<void> | null = null;
  let checking: Promise<void> | null = null;
  let reading = Promise.resolve();
  const load = () => loading ??= (async () => {
    const [release, read, checkedAt, skipped] = await Promise.all([
      repo.getSetting<unknown>("updateLatestRelease", null),
      repo.getSetting<unknown>("updateReadVersion", null),
      repo.getSetting<unknown>("updateCheckedAt", 0),
      repo.getSetting<unknown>("updateSkipped", null),
    ]);
    set({ release: cachedRelease(release), readVersion: typeof read === "string" ? read : typeof skipped === "string" ? skipped : null,
      checkedAt: typeof checkedAt === "number" && Number.isFinite(checkedAt) ? checkedAt : 0 });
  })();

  return {
    load,
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async check(manual = false) {
      await load();
      if (!manual && (!await repo.getSetting("autoUpdateCheck", true) || Date.now() - state.checkedAt < 86_400_000)) return;
      if (checking) return checking;
      checking = (async () => {
        const checkedAt = Date.now();
        set({ checking: true, failed: false });
        try {
          await repo.setSetting("updateCheckedAt", checkedAt);
          set({ checkedAt });
          // Android installs in the app, so a release without its package does not count yet (D158).
          const release = await latestRelease(platform, { needPackage: platform.name === "android" });
          await repo.setSetting("updateLatestRelease", release);
          set({ release });
        } catch {
          // A temporary network failure must not erase an unread cached release.
          set({ failed: true });
        } finally {
          set({ checking: false });
        }
      })().finally(() => { checking = null; });
      return checking;
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

type UpdateStore = ReturnType<typeof createUpdateStore>;
const stores = new WeakMap<Repo, UpdateStore>();

export function updateStore(repo: Repo, platform: Platform): UpdateStore {
  let store = stores.get(repo);
  if (!store) { store = createUpdateStore(repo, platform); stores.set(repo, store); }
  return store;
}

export function useUpdateNotice(game: { repo: Repo; platform: Platform }) {
  const store = updateStore(game.repo, game.platform);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => { void store.load().catch(() => {}); }, [store]);
  return { store, state, unread: hasUnreadUpdate(state, __APP_VERSION__) };
}
