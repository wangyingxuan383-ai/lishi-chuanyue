import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "../../engine/db/repo";
import { PlatformError, type Platform, type UpdateEnvironmentStatus, type UpdatePackageStatus, type UpdateRequest } from "../../platform";
import { androidPackage, expectedHash, latestRelease, newer, openLink, parseSums, plainNotes, platformPackage, REPO_URL, windowsPackage, type ReleaseAsset, type ReleaseInfo } from "./update";
import { createUpdateStore, hasPromptableReadyUpdate } from "./updateStore";

// Every platform call is a stub. Even an accidental browser fetch must fail locally.
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in update tests"); })); });
afterEach(() => { vi.unstubAllGlobals(); });

const release = (tag: unknown, fields: Record<string, unknown> = {}) => ({
  tag_name: tag, name: null, body: null, html_url: `${REPO_URL}/releases/tag/${String(tag)}`,
  published_at: "2026-10-17T12:00:00Z", prerelease: false, draft: false, ...fields,
});

function api(body: string, status = 200) {
  const getPublic = vi.fn(async () => ({ status, body }));
  return { platform: { llm: { getPublic } } as unknown as Platform, getPublic };
}

describe("release SemVer precedence", () => {
  it("ranks the stable release above every prerelease of the same core", () => {
    expect(newer("0.10.0-rc.1", "0.10.0")).toBe(false);
    expect(newer("0.10.0", "0.10.0-rc.1")).toBe(true);
    const ordered = ["alpha", "alpha.1", "alpha.beta", "beta", "beta.2", "beta.11", "rc.1"]
      .map((suffix) => `1.0.0-${suffix}`).concat("1.0.0");
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) expect(newer(ordered[i], ordered[j])).toBe(i > j);
    }
  });

  it.each([
    ["1.0.0-alpha", "0.99.99"], ["0.11.0-alpha", "0.10.99"], ["0.10.1-alpha", "0.10.0"],
    ["1.0.0-rc.10", "1.0.0-rc.9"], ["1.0.0-rc.a", "1.0.0-rc.999"],
    ["1.0.0-alpha.1", "1.0.0-alpha"], ["1.0.0-alpha.0", "1.0.0-alpha"],
    ["1.0.0-rc.2a", "1.0.0-rc.10a"], ["1.0.0-a", "1.0.0-Z"],
    ["9007199254740993.0.0", "9007199254740992.0.0"],
    ["1.0.0-rc.9007199254740993", "1.0.0-rc.9007199254740992"],
    ["v0.10.0+build.001", "0.10.0-rc.9+build.999"],
  ])("orders %s above %s", (higher, lower) => {
    expect(newer(higher, lower)).toBe(true);
    expect(newer(lower, higher)).toBe(false);
  });

  it.each([
    ["0.10.0", "v0.10.0"], ["0.10.0+build.999", "0.10.0+build.001"],
    ["v0.10.0-rc.1+one", "0.10.0-rc.1+two"], ["1.0.0-0+001", "1.0.0-0+xyz"],
  ])("ignores prefix and metadata for equal precedence: %s / %s", (a, b) => {
    expect(newer(a, b)).toBe(false);
    expect(newer(b, a)).toBe(false);
  });

  it.each([
    "", "latest", "release-1.0.0", "vv1.0.0", "1", "1.0", "1.0.0.1", "01.0.0", "1.01.0", "1.0.01",
    "-1.0.0", "1.0.0-", "1.0.0-rc.01", "1.0.0-00", "1.0.0-alpha..1", "1.0.0-rc_1",
    "1.0.0+", "1.0.0+build..1", "1.0.0+x+y", "1.0.0-测试", " 1.0.0", "1.0.0 ", "1.0.0\n",
  ])("rejects invalid version %j on either side", (tag) => {
    expect(newer(tag, "0.0.0")).toBe(false);
    expect(newer("99.0.0", tag)).toBe(false);
  });
});

describe("latestRelease without network", () => {
  it("selects stable over same-core rc and sorts numeric prereleases", async () => {
    const { platform, getPublic } = api(JSON.stringify([
      release("v0.10.0-rc.9"), release("0.10.0"), release("0.10.0-rc.10"), release("0.9.99"),
    ]));
    expect((await latestRelease(platform))?.version).toBe("0.10.0");
    expect(getPublic).toHaveBeenCalledWith("https://api.github.com/repos/wangyingxuan383-ai/lishi-chuanyue/releases?per_page=5", 12_000);
    const prereleases = api(JSON.stringify([release("v0.11.0-rc.9"), release("0.11.0-rc.10", { prerelease: true }), release("0.10.0")]));
    expect(await latestRelease(prereleases.platform)).toMatchObject({ version: "0.11.0-rc.10", prerelease: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps API order for duplicate versions and metadata-only differences", async () => {
    const a = release("v0.10.0+build.001", { name: "first", body: "第一条说明" });
    const b = release("0.10.0+build.999", { name: "second" });
    const c = release("0.10.0", { name: "third" });
    for (const items of [[a, b, c], [c, a, b], [b, a, c], [a, { ...a, name: "duplicate" }]]) {
      expect(await latestRelease(api(JSON.stringify(items)).platform)).toMatchObject({ name: items[0].name });
    }
    expect(await latestRelease(api(JSON.stringify([a, b])).platform)).toEqual({
      version: "0.10.0+build.001", name: "first", notes: "第一条说明", url: a.html_url,
      publishedAt: "2026-10-17T12:00:00Z", prerelease: false, assets: [],
    });
  });

  it("reads uploaded assets with GitHub's SHA-256 digest and drops unusable ones", async () => {
    const hex = "7890802F521B7C0D75BA4BA0C5FF9717F131DA94D0AEF654C5E2B4C2E44D083A";
    const asset = (name: unknown, fields: Record<string, unknown> = {}) => ({
      name, size: 23449427, state: "uploaded", digest: `sha256:${hex}`,
      browser_download_url: `${REPO_URL}/releases/download/v0.11.0/${String(name)}`, ...fields,
    });
    const items = [release("v0.11.0", { assets: [
      asset("chuanyue-0.11.0.apk"), asset("no-digest.zip", { digest: null }), asset("md5.zip", { digest: "md5:abc" }),
      asset("open.apk", { state: "open" }), asset("empty.apk", { size: 0 }), asset("half.apk", { size: 1.5 }),
      asset(null), asset("nolink.apk", { browser_download_url: 7 }), null, "x",
    ] })];
    const latest = await latestRelease(api(JSON.stringify(items)).platform);
    expect(latest?.assets).toEqual([
      { name: "chuanyue-0.11.0.apk", size: 23449427, url: `${REPO_URL}/releases/download/v0.11.0/chuanyue-0.11.0.apk`, sha256: hex.toLowerCase() },
      { name: "no-digest.zip", size: 23449427, url: `${REPO_URL}/releases/download/v0.11.0/no-digest.zip`, sha256: null },
      { name: "md5.zip", size: 23449427, url: `${REPO_URL}/releases/download/v0.11.0/md5.zip`, sha256: null },
    ]);
    expect(androidPackage(latest!)?.name).toBe("chuanyue-0.11.0.apk");
    expect((await latestRelease(api(JSON.stringify([release("v0.11.0", { assets: "none" })])).platform))?.assets).toEqual([]);
  });

  it("on Android skips a newer release published with source only (D158)", async () => {
    const apk = (version: string) => ({ name: `chuanyue-${version}.apk`, size: 1000, state: "uploaded", digest: null,
      browser_download_url: `${REPO_URL}/releases/download/v${version}/chuanyue-${version}.apk` });
    const items = [
      release("v0.13.0", { prerelease: true, assets: [] }),
      release("v0.12.1", { prerelease: true, assets: [] }),
      release("v0.11.17", { prerelease: true, assets: [apk("0.11.17")] }),
    ];
    expect((await latestRelease(api(JSON.stringify(items)).platform))?.version).toBe("0.13.0");
    expect((await latestRelease(api(JSON.stringify(items)).platform, { needPackage: true }))?.version).toBe("0.11.17");
    expect(await latestRelease(api(JSON.stringify(items.slice(0, 2))).platform, { needPackage: true })).toBeNull();
  });

  it("filters invalid tags, drafts and malformed entries before choosing a version", async () => {
    const items = [
      null, false, 123, [], {}, release(99), release(null), release("999.0.0-rc.01"),
      release("999.0.0\n"), release("999.0.0+"), release("999.0.0.1"),
      release("999.0.0", { draft: true }), release("998.0.0", { html_url: null }),
      release("v0.10.0-rc.1", { prerelease: true, name: 123, body: {}, published_at: null }),
    ];
    expect(await latestRelease(api(JSON.stringify(items)).platform)).toMatchObject({
      version: "0.10.0-rc.1", name: "v0.10.0-rc.1", notes: "", publishedAt: "", prerelease: true,
    });
  });

  it.each([{ items: [] }, { items: [release("latest")] }, { items: [release("1.0.0", { draft: true })] }])("returns null for a valid list with no usable releases: $items", async ({ items }) => {
    expect(await latestRelease(api(JSON.stringify(items)).platform)).toBeNull();
  });

  it.each(["", "  \n", "null", "{}", '{"message":"API unavailable"}', '"not a list"', "42", "true", "<html>error</html>", "["])("reports unreadable or non-array responses politely: %j", async (body) => {
    await expect(latestRelease(api(body).platform)).rejects.toThrow("没能读到版本信息，请稍后再试");
  });

  it("retains HTTP status for callers without trying to parse an error body", async () => {
    await expect(latestRelease(api("not JSON", 403).platform)).rejects.toMatchObject({ message: "HTTP 403", status: 403 });
  });
});

function browser(openUrl = vi.fn(async (_url: string) => {})) {
  return { platform: { system: { openUrl } } as unknown as Platform, openUrl, toast: vi.fn() };
}
const cannotOpen = () => vi.fn(async (_url: string) => { throw new Error("browser unavailable"); });

describe("openLink feedback and trust boundary", () => {
  it("leaves the clipboard and toast alone after a successful browser handoff", async () => {
    const { platform, openUrl, toast } = browser();
    const writeText = vi.fn(); vi.stubGlobal("navigator", { clipboard: { writeText } });
    await openLink(platform, toast, REPO_URL);
    expect(openUrl).toHaveBeenCalledWith(REPO_URL);
    expect(writeText).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("only says copied after a trusted link was successfully written", async () => {
    const { platform, toast } = browser(cannotOpen());
    let copied!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { copied = resolve; }));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const opening = openLink(platform, toast, REPO_URL);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(REPO_URL);
    expect(toast).not.toHaveBeenCalled();
    copied(); await opening;
    expect(toast).toHaveBeenCalledExactlyOnceWith("没能打开浏览器，链接已复制");
  });

  it.each([undefined, {}, { clipboard: {} }, { clipboard: { writeText: undefined } }])("reports unavailable clipboard without claiming success: %j", async (navigatorValue) => {
    const { platform, toast } = browser(cannotOpen());
    vi.stubGlobal("navigator", navigatorValue);
    await expect(openLink(platform, toast, REPO_URL)).resolves.toBeUndefined();
    expect(toast).toHaveBeenCalledExactlyOnceWith("没能打开浏览器，也没能复制链接");
  });

  it.each([false, true])("reports clipboard rejection or synchronous failure: synchronous=%s", async (sync) => {
    const { platform, toast } = browser(cannotOpen());
    const writeText = vi.fn(() => {
      if (sync) throw new Error("clipboard denied");
      return Promise.reject(new Error("clipboard denied"));
    });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(openLink(platform, toast, REPO_URL)).resolves.toBeUndefined();
    expect(toast).toHaveBeenCalledExactlyOnceWith("没能打开浏览器，也没能复制链接");
  });

  it("also handles a clipboard getter that throws", async () => {
    const { platform, toast } = browser(cannotOpen());
    vi.stubGlobal("navigator", { get clipboard() { throw new Error("access denied"); } });
    await expect(openLink(platform, toast, REPO_URL)).resolves.toBeUndefined();
    expect(toast).toHaveBeenCalledExactlyOnceWith("没能打开浏览器，也没能复制链接");
  });

  it.each([
    "https://example.invalid/release", "javascript:alert(1)", "file:///C:/Windows", "http://github.com/wangyingxuan383-ai/lishi-chuanyue",
    "https://github.com.evil.invalid/wangyingxuan383-ai/lishi-chuanyue", `${REPO_URL}-evil`,
    "https://user@github.com/wangyingxuan383-ai/lishi-chuanyue", `${REPO_URL}\n`,
  ])("never opens or copies untrusted URL %j", async (url) => {
    const { platform, openUrl, toast } = browser(cannotOpen());
    const writeText = vi.fn(); vi.stubGlobal("navigator", { clipboard: { writeText } });
    await openLink(platform, toast, url);
    expect(openUrl).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledExactlyOnceWith("这个链接不在应用的可信链接列表中");
  });

  it.each([
    "这个链接不在应用的可信链接列表中",
    new Error("这个链接不在应用的可信链接列表中"),
    new PlatformError("ipc", "这个链接不在应用的可信链接列表中"),
    { code: "ipc", message: "这个链接不在应用的可信链接列表中" },
  ])("preserves a platform policy refusal even for a locally trusted URL: %s", async (error) => {
    const { platform, openUrl, toast } = browser(vi.fn(async (_url: string) => { throw error; }));
    const writeText = vi.fn(); vi.stubGlobal("navigator", { clipboard: { writeText } });
    await openLink(platform, toast, REPO_URL);
    expect(openUrl).toHaveBeenCalledWith(REPO_URL);
    expect(writeText).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledExactlyOnceWith("这个链接不在应用的可信链接列表中");
  });
});

const HASH_A = "a".repeat(64), HASH_B = "b".repeat(64);
const pkg = (name: string, sha256: string | null = null): ReleaseAsset => ({ name, size: 10, url: `${REPO_URL}/releases/download/v0.11.0/${name}`, sha256 });
const info = (assets: ReleaseAsset[], version = "0.11.0"): ReleaseInfo => ({
  version, name: version, notes: "", url: `${REPO_URL}/releases/tag/v${version}`, publishedAt: "", prerelease: false, assets,
});

describe("the Android package and its expected SHA-256", () => {
  it("prefers chuanyue-<version>.apk, else the only .apk", () => {
    expect(androidPackage(info([pkg("other.apk"), pkg("chuanyue-0.11.0.apk")]))?.name).toBe("chuanyue-0.11.0.apk");
    expect(androidPackage(info([pkg("setup.exe"), pkg("Mine.APK")]))?.name).toBe("Mine.APK");
    expect(androidPackage(info([pkg("a.apk"), pkg("b.apk")]))).toBeNull();
    expect(androidPackage(info([pkg("setup.exe")]))).toBeNull();
  });

  it("parses sha256sum lines and distrusts a name listed with two hashes", () => {
    const sums = parseSums([
      `${HASH_A.toUpperCase()}  chuanyue-0.11.0.apk`, `${HASH_B} *setup.exe`, "", "# comment", "short  x.apk",
      `${HASH_A}  twice.zip`, `${HASH_B}  twice.zip`, `${HASH_A}  same.zip\r`, `${HASH_A}  same.zip`,
    ].join("\n"));
    expect(Object.fromEntries(sums)).toEqual({ "chuanyue-0.11.0.apk": HASH_A, "setup.exe": HASH_B, "same.zip": HASH_A });
  });

  it("uses GitHub's digest first, then SHA256SUMS.txt, else nothing", async () => {
    const fetchText = vi.fn(async (_url: string) => `${HASH_B}  chuanyue-0.11.0.apk\n`);
    const platform = { update: { fetchText } } as unknown as Platform;
    const apk = pkg("chuanyue-0.11.0.apk", HASH_A);
    expect(await expectedHash(platform, info([apk, pkg("SHA256SUMS.txt")]), apk)).toBe(HASH_A);
    expect(fetchText).not.toHaveBeenCalled();
    const bare = pkg("chuanyue-0.11.0.apk");
    expect(await expectedHash(platform, info([bare, pkg("SHA256SUMS.txt")]), bare)).toBe(HASH_B);
    expect(fetchText).toHaveBeenCalledWith(`${REPO_URL}/releases/download/v0.11.0/SHA256SUMS.txt`);
    expect(await expectedHash(platform, info([bare]), bare)).toBeNull();
    // The list exists but did not arrive: that is a network problem, not "no hash".
    fetchText.mockRejectedValueOnce(new PlatformError("update_network", "网络中断了"));
    await expect(expectedHash(platform, info([bare, pkg("sha256sums")]), bare)).rejects.toMatchObject({ code: "update_network" });
    fetchText.mockResolvedValueOnce(`${HASH_B}  other.apk\n`);
    expect(await expectedHash(platform, info([bare, pkg("SHA256SUMS.txt")]), bare)).toBeNull();
    expect(await expectedHash({} as Platform, info([bare, pkg("SHA256SUMS.txt")]), bare)).toBeNull();
  });
});

describe("plain release notes", () => {
  it("removes Markdown marks and keeps the words", () => {
    const notes = [
      "## 这一版新增和改进", "", "- **AI 服务**：填好 Key，模型列表自己出来", "* 看[发布页](https://example.invalid)和 `设置`",
      "1. 第一条", "> 引用的话", "---", "<!-- hidden -->", "```", "code line", "```", "![图](x.png)<br>",
    ].join("\r\n");
    expect(plainNotes(notes)).toBe(["这一版新增和改进", "· AI 服务：填好 Key，模型列表自己出来", "· 看发布页和 设置", "· 第一条", "引用的话", "code line"].join("\n"));
  });

  it("stops at the line and character limits with an ellipsis", () => {
    expect(plainNotes(["一", "二", "三", "四"].join("\n"), 2)).toBe("一\n二…");
    expect(plainNotes(`${"甲".repeat(30)}\n${"乙".repeat(40)}`, 8, 50)).toBe(`${"甲".repeat(30)}\n${"乙".repeat(19)}…`);
    expect(plainNotes(`${"甲".repeat(45)}\n${"乙".repeat(40)}`, 8, 50)).toBe(`${"甲".repeat(45)}…`);
    expect(plainNotes("")).toBe("");
  });
});

function memorySettings(initial: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(initial));
  const getSetting = vi.fn(async <T>(key: string, fallback: T): Promise<T> =>
    (map.has(key) ? (map.get(key) as T) : fallback));
  const setSetting = vi.fn(async (key: string, value: unknown): Promise<void> => {
    map.set(key, value);
  });
  return { repo: { getSetting, setSetting } as unknown as Repo, map, getSetting, setSetting };
}

describe("Windows installer selection (U5)", () => {
  it("prefers .msi, then -setup.exe / .exe on Windows, and returns null when only Android .apk exists", () => {
    const msi = pkg("chuanyue_0.11.0_x64.msi", HASH_A);
    const setupExe = pkg("chuanyue_0.11.0_x64-setup.exe", HASH_B);
    const apk = pkg("chuanyue-0.11.0.apk", HASH_A);

    expect(windowsPackage(info([apk, setupExe, msi]))?.name).toBe("chuanyue_0.11.0_x64.msi");
    expect(windowsPackage(info([apk, setupExe]))?.name).toBe("chuanyue_0.11.0_x64-setup.exe");
    expect(windowsPackage(info([apk]))).toBeNull();

    const winPlatform = { name: "windows" } as Platform;
    const androidPlat = { name: "android" } as Platform;
    expect(platformPackage(winPlatform, info([apk, setupExe]))?.name).toBe("chuanyue_0.11.0_x64-setup.exe");
    expect(platformPackage(winPlatform, info([apk]))).toBeNull();
    expect(platformPackage(androidPlat, info([apk, setupExe]))?.name).toBe("chuanyue-0.11.0.apk");
  });
});

describe("updateStore: offline retry (U1), packageStatus hydration (U3), and safe default-OFF autoPrepare", () => {
  const apkReleasePayload = (version = "0.12.0", sha = HASH_A) => JSON.stringify([
    release(`v${version}`, {
      body: "修复了若干问题",
      assets: [{
        name: `chuanyue-${version}.apk`,
        size: 40 * 1024 * 1024,
        state: "uploaded",
        digest: `sha256:${sha}`,
        browser_download_url: `${REPO_URL}/releases/download/v${version}/chuanyue-${version}.apk`,
      }],
    }),
  ]);

  it("U1: does not stamp 24h check cooldown when offline/DNS fails, allowing immediate retry", async () => {
    const { repo, map } = memorySettings();
    let online = false;
    const getPublic = vi.fn(async () => {
      if (!online) throw new PlatformError("llm_network", "DNS resolution failed");
      return { status: 200, body: apkReleasePayload("0.12.0") };
    });
    const platform = { name: "android", llm: { getPublic } } as unknown as Platform;
    const store = createUpdateStore(repo, platform, "0.10.0");

    await store.check(false);
    expect(store.snapshot().failed).toBe(true);
    expect(store.snapshot().checkedAt).toBe(0);
    expect(map.has("updateCheckedAt")).toBe(false);
    expect(map.has("updateLastCheckAt")).toBe(false);

    // Network comes back 5 seconds later: automatic check retries immediately instead of waiting 24h!
    online = true;
    await store.check(false);
    expect(getPublic).toHaveBeenCalledTimes(2);
    expect(store.snapshot().failed).toBe(false);
    expect(store.snapshot().release?.version).toBe("0.12.0");
    expect(store.snapshot().checkedAt).toBeGreaterThan(0);
    expect(map.get("updateLastCheckAt")).toBe(store.snapshot().checkedAt);

    // Now that a check succeeded, another non-manual check within 24h is skipped.
    await store.check(false);
    expect(getPublic).toHaveBeenCalledTimes(2);
  });

  it("U3: hydrates readyRelease and canInstall from packageStatus on startup without re-downloading", async () => {
    const cached: ReleaseInfo = {
      version: "0.12.0",
      name: "v0.12.0",
      notes: "更新说明",
      url: `${REPO_URL}/releases/tag/v0.12.0`,
      publishedAt: "2026-11-20T00:00:00Z",
      prerelease: false,
      assets: [{
        name: "chuanyue-0.12.0.apk",
        size: 30 * 1024 * 1024,
        url: `${REPO_URL}/releases/download/v0.12.0/chuanyue-0.12.0.apk`,
        sha256: HASH_A,
      }],
    };
    const { repo } = memorySettings({ updateLatestRelease: cached });
    let allowInstall = false;
    const packageStatus = vi.fn(async (): Promise<UpdatePackageStatus> => ({
      downloaded: true,
      verified: true,
      bytes: 30 * 1024 * 1024,
      canInstall: allowInstall,
    }));
    const download = vi.fn();
    const install = vi.fn();
    const platform = {
      name: "android",
      llm: { getPublic: vi.fn() },
      update: { packageStatus, download, install, canInstall: async () => allowInstall },
    } as unknown as Platform;

    const store = createUpdateStore(repo, platform, "0.10.0");
    await store.load();
    expect(packageStatus).toHaveBeenCalledWith({ version: "0.12.0", sha256: HASH_A });
    expect(store.readyRelease?.version).toBe("0.12.0");
    expect(store.snapshot().canInstall).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();

    // U4: after granting unknown-sources permission and resuming, refreshStatus updates canInstall.
    allowInstall = true;
    await store.refreshStatus();
    expect(store.snapshot().canInstall).toBe(true);

    // Dismissing ready prompt records dismissedReadyVersion while keeping readyRelease available in Settings.
    expect(hasPromptableReadyUpdate(store.snapshot(), "0.10.0")).toBe(true);
    await store.dismissReady();
    expect(store.dismissedReadyVersion).toBe("0.12.0");
    expect(hasPromptableReadyUpdate(store.snapshot(), "0.10.0")).toBe(false);
  });

  it("enforces default-OFF autoUpdate gate and Wi-Fi / free-space preflight gates", async () => {
    const size = 120 * 1024 * 1024; // 120 MiB -> requires max(300 MiB, 250 MiB) = 300 MiB
    const rel: ReleaseInfo = {
      version: "0.12.0",
      name: "v0.12.0",
      notes: "",
      url: `${REPO_URL}/releases/tag/v0.12.0`,
      publishedAt: "2026-11-20T00:00:00Z",
      prerelease: false,
      assets: [{
        name: "chuanyue-0.12.0.apk",
        size,
        url: `${REPO_URL}/releases/download/v0.12.0/chuanyue-0.12.0.apk`,
        sha256: HASH_A,
      }],
    };
    const { repo, map } = memorySettings({ updateLatestRelease: rel });
    let env: UpdateEnvironmentStatus = { wifiUnmetered: true, freeBytes: 800 * 1024 * 1024 };
    let pkgVerified = false;
    const download = vi.fn(async () => { pkgVerified = true; });
    const install = vi.fn();
    const environmentStatus = vi.fn(async () => env);
    const packageStatus = vi.fn(async (): Promise<UpdatePackageStatus> => ({
      downloaded: pkgVerified,
      verified: pkgVerified,
      bytes: pkgVerified ? size : 0,
      canInstall: true,
    }));
    const platform = {
      name: "android",
      llm: { getPublic: vi.fn() },
      update: {
        download,
        cancel: vi.fn(async () => {}),
        fetchText: vi.fn(),
        install,
        canInstall: vi.fn(async () => true),
        packageStatus,
        environmentStatus,
        devSource: vi.fn(),
        setDevSource: vi.fn(),
      },
    } as unknown as Platform;

    const store = createUpdateStore(repo, platform, "0.10.0");

    // 1. Default OFF (autoUpdate unset): must NOT check environment or download.
    expect(await store.autoPrepare()).toBe(false);
    expect(environmentStatus).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();

    // Turn autoUpdate ON.
    map.set("autoUpdate", true);

    // 2. Busy gate: refuses while story generation is active.
    expect(await store.autoPrepare({ isBusy: () => true })).toBe(false);
    expect(download).not.toHaveBeenCalled();

    // 3. Metered network gate: refuses when not on unmetered Wi-Fi.
    env = { wifiUnmetered: false, freeBytes: 800 * 1024 * 1024 };
    expect(await store.autoPrepare()).toBe(false);
    expect(download).not.toHaveBeenCalled();

    // 4. Free-space gate: refuses when freeBytes < Math.max(asset.size * 2.5, 250 MiB) (300 MiB here).
    env = { wifiUnmetered: true, freeBytes: 280 * 1024 * 1024 };
    expect(await store.autoPrepare()).toBe(false);
    expect(download).not.toHaveBeenCalled();

    // 5. All gates satisfied: downloads silently, verifies packageStatus, sets readyRelease, NEVER calls install!
    env = { wifiUnmetered: true, freeBytes: 500 * 1024 * 1024 };
    expect(await store.autoPrepare()).toBe(true);
    expect(download).toHaveBeenCalledTimes(1);
    expect(store.readyRelease?.version).toBe("0.12.0");
    expect(install).not.toHaveBeenCalled();
  });

  it("aborts silent download on 15s poll when switching to metered network or becoming busy, keeping partial state", async () => {
    vi.useFakeTimers();
    try {
      const rel: ReleaseInfo = {
        version: "0.12.0",
        name: "v0.12.0",
        notes: "",
        url: `${REPO_URL}/releases/tag/v0.12.0`,
        publishedAt: "2026-11-20T00:00:00Z",
        prerelease: false,
        assets: [{
          name: "chuanyue-0.12.0.apk",
          size: 50 * 1024 * 1024,
          url: `${REPO_URL}/releases/download/v0.12.0/chuanyue-0.12.0.apk`,
          sha256: HASH_A,
        }],
      };
      const { repo } = memorySettings({ updateLatestRelease: rel, autoUpdate: true });
      let wifiUnmetered = true;
      let busy = false;
      let rejectDownload!: (reason: unknown) => void;
      const cancel = vi.fn(async () => {
        rejectDownload(new PlatformError("update_cancelled", "下载已暂停"));
      });
      const download = vi.fn((_req: UpdateRequest) => new Promise<void>((_resolve, reject) => {
        rejectDownload = reject;
      }));
      const platform = {
        name: "android",
        llm: { getPublic: vi.fn() },
        update: {
          download,
          cancel,
          fetchText: vi.fn(),
          install: vi.fn(),
          canInstall: vi.fn(async () => true),
          packageStatus: vi.fn(async (): Promise<UpdatePackageStatus> => ({
            downloaded: false,
            verified: false,
            bytes: 12 * 1024 * 1024,
            canInstall: true,
          })),
          environmentStatus: vi.fn(async (): Promise<UpdateEnvironmentStatus> => ({
            wifiUnmetered,
            freeBytes: 600 * 1024 * 1024,
          })),
          devSource: vi.fn(),
          setDevSource: vi.fn(),
        },
      } as unknown as Platform;

      const store = createUpdateStore(repo, platform, "0.10.0");

      // Case A: Wi-Fi drops to metered cellular mid-download.
      const runA = store.autoPrepare({ isBusy: () => busy });
      await vi.advanceTimersByTimeAsync(100);
      expect(download).toHaveBeenCalledTimes(1);
      wifiUnmetered = false;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await runA).toBe(false);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(store.readyRelease).toBeNull();

      // Case B: Player starts generating a story (`isBusy` becomes true) mid-download.
      wifiUnmetered = true;
      const runB = store.autoPrepare({ isBusy: () => busy });
      await vi.advanceTimersByTimeAsync(100);
      expect(download).toHaveBeenCalledTimes(2);
      busy = true;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await runB).toBe(false);
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(store.readyRelease).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects SHA-256 mismatch or unverified post-download packageStatus without marking readyRelease", async () => {
    const rel: ReleaseInfo = {
      version: "0.12.0",
      name: "v0.12.0",
      notes: "",
      url: `${REPO_URL}/releases/tag/v0.12.0`,
      publishedAt: "2026-11-20T00:00:00Z",
      prerelease: false,
      assets: [{
        name: "chuanyue-0.12.0.apk",
        size: 30 * 1024 * 1024,
        url: `${REPO_URL}/releases/download/v0.12.0/chuanyue-0.12.0.apk`,
        sha256: HASH_A,
      }],
    };
    const { repo } = memorySettings({ updateLatestRelease: rel, autoUpdate: true });
    let failMode: "download_hash" | "post_status" = "download_hash";
    const install = vi.fn();
    const download = vi.fn(async () => {
      if (failMode === "download_hash") {
        throw new PlatformError("update_hash", "安装包校验没通过，已删除");
      }
    });
    const packageStatus = vi.fn(async (): Promise<UpdatePackageStatus> => ({
      downloaded: false,
      verified: false,
      bytes: 0,
      canInstall: true,
    }));
    const platform = {
      name: "android",
      llm: { getPublic: vi.fn() },
      update: {
        download,
        cancel: vi.fn(async () => {}),
        fetchText: vi.fn(),
        install,
        canInstall: vi.fn(async () => true),
        packageStatus,
        environmentStatus: vi.fn(async (): Promise<UpdateEnvironmentStatus> => ({
          wifiUnmetered: true,
          freeBytes: 600 * 1024 * 1024,
        })),
        devSource: vi.fn(),
        setDevSource: vi.fn(),
      },
    } as unknown as Platform;

    const store = createUpdateStore(repo, platform, "0.10.0");
    expect(await store.autoPrepare()).toBe(false);
    expect(store.readyRelease).toBeNull();

    // Even if download() resolved, a failing post-download packageStatus check still refuses readyRelease!
    failMode = "post_status";
    expect(await store.autoPrepare()).toBe(false);
    expect(store.readyRelease).toBeNull();
    expect(install).not.toHaveBeenCalled();
  });
});
