import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repo } from "../../engine/db/repo";
import { migrate } from "../../engine/db/migrate";
import { createMemoryPlatform } from "../../platform/memory";
import { REPO_URL, type ReleaseInfo } from "./update";
import { createUpdateStore, hasUnreadUpdate } from "./updateStore";

const CURRENT = "0.11.1";
const release = (version = "0.12.0"): ReleaseInfo => ({
  version, name: version, notes: "更新说明", url: `${REPO_URL}/releases/tag/v${version}`,
  publishedAt: "2026-10-24T01:00:00Z", prerelease: true, assets: [],
});
const response = (version = "0.12.0") => ({ status: 200, body: JSON.stringify([{
  tag_name: `v${version}`, name: version, body: "更新说明", html_url: release(version).url,
  published_at: release(version).publishedAt, prerelease: true, assets: [],
}]) });

async function fixture() {
  const platform = await createMemoryPlatform();
  const getPublic = vi.fn(async () => response());
  platform.llm.getPublic = getPublic;
  await migrate(platform);
  const repo = new Repo(platform);
  return { platform, repo, getPublic, store: createUpdateStore(repo, platform) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T10:00:00+08:00"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in update reminder tests"); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("persistent update reminder", () => {
  it("keeps an unread release after reopening, without checking twice in a day", async () => {
    const { store, repo, platform, getPublic } = await fixture();
    await store.check();
    expect(hasUnreadUpdate(store.snapshot(), CURRENT)).toBe(true);
    const reopened = createUpdateStore(repo, platform);
    await reopened.check();
    expect(reopened.snapshot().release?.version).toBe("0.12.0");
    expect(hasUnreadUpdate(reopened.snapshot(), CURRENT)).toBe(true);
    expect(getPublic).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears only the opened version and announces a newer one", async () => {
    const { store, repo, platform, getPublic } = await fixture();
    await store.check();
    // Merely loading the state (Settings/About) does not read the details.
    await store.load();
    expect(hasUnreadUpdate(store.snapshot(), CURRENT)).toBe(true);
    await store.markRead("0.12.0");
    const reopened = createUpdateStore(repo, platform);
    await reopened.load();
    expect(hasUnreadUpdate(reopened.snapshot(), CURRENT)).toBe(false);
    getPublic.mockResolvedValue(response("0.13.0"));
    await reopened.check(true);
    expect(hasUnreadUpdate(reopened.snapshot(), CURRENT)).toBe(true);
    await reopened.markRead("0.12.0");
    expect(hasUnreadUpdate(reopened.snapshot(), CURRENT)).toBe(true);
  });

  it("retains the cache when automatic checks are off but permits a manual check", async () => {
    const { store, repo, getPublic } = await fixture();
    await repo.setSetting("updateLatestRelease", release());
    await repo.setSetting("autoUpdateCheck", false);
    await store.check();
    expect(getPublic).not.toHaveBeenCalled();
    expect(hasUnreadUpdate(store.snapshot(), CURRENT)).toBe(true);
    await store.check(true);
    expect(getPublic).toHaveBeenCalledTimes(1);
  });

  it("does not erase an unread release after a network failure", async () => {
    const { store, repo, platform, getPublic } = await fixture();
    await repo.setSetting("updateLatestRelease", release());
    getPublic.mockRejectedValue(new Error("offline"));
    await store.check(true);
    expect(store.snapshot().failed).toBe(true);
    const reopened = createUpdateStore(repo, platform);
    await reopened.load();
    expect(hasUnreadUpdate(reopened.snapshot(), CURRENT)).toBe(true);
  });

  it("checks again after a day and shares an in-flight request", async () => {
    const { store, getPublic } = await fixture();
    await Promise.all([store.check(), store.check(true)]);
    expect(getPublic).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(86_400_001);
    await store.check();
    expect(getPublic).toHaveBeenCalledTimes(2);
  });

  it("honors an old skipped version without hiding later releases", async () => {
    const { store, repo, getPublic } = await fixture();
    await repo.setSetting("updateSkipped", "0.12.0");
    await store.check();
    expect(hasUnreadUpdate(store.snapshot(), CURRENT)).toBe(false);
    getPublic.mockResolvedValue(response("0.13.0"));
    await store.check(true);
    expect(hasUnreadUpdate(store.snapshot(), CURRENT)).toBe(true);
  });

  it("ignores incomplete cache data and stops reminding after installing the release", async () => {
    const { store, repo, getPublic } = await fixture();
    await repo.setSetting("updateLatestRelease", { version: "0.12.0" });
    await store.load();
    expect(store.snapshot().release).toBeNull();
    getPublic.mockResolvedValue(response(CURRENT));
    await store.check(true);
    expect(hasUnreadUpdate(store.snapshot(), CURRENT)).toBe(false);
  });
});
