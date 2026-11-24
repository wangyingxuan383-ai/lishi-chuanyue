// In-app update: the new version's notes, then download → verify →
// install on Android. On Windows, prefers direct installer (.msi / -setup.exe)
// while cleanly showing release notes when only an Android .apk is published.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { type UpdatePackageStatus } from "../../platform";
import { useApp } from "../app/context";
import { androidPackage, expectedHash, openLink, plainNotes, windowsPackage, type ReleaseInfo } from "../app/update";
import { updateStore } from "../app/updateStore";
import { hydrateReadyPackage, installUpdate, pauseDownload, resumePermissionInstall, snapshot, startDownload, stepFor, subscribe, type FailReason } from "../app/updateFlow";
import { Sheet } from "./Sheet";
import "./update.css";

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
const percent = (received: number, total: number) => (total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0);

function day(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : `${date.getMonth() + 1}月${date.getDate()}日`;
}

const FAILURES: Record<FailReason, { text: string; retry: string | null }> = {
  network: { text: "网络断了，已下载的部分会保留。", retry: "重试" },
  unavailable: { text: "下载地址暂时打不开，请稍后再试。", retry: "重试" },
  corrupt: { text: "下载的文件不完整，已删除。", retry: "重新下载" },
  storage: { text: "手机存储空间不够，清理后再试。", retry: "重试" },
  missing: { text: "下载好的安装包不见了。", retry: "重新下载" },
  nohash: { text: "这一版没有校验信息，请用浏览器下载。", retry: null },
  install: { text: "没能打开系统安装界面。", retry: "再试一次" },
  other: { text: "下载没有完成，请再试一次。", retry: "重试" },
};

function Bar({ value }: { value: number | null }) {
  return <div className={value === null ? "update-bar busy" : "update-bar"} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
    <i style={value === null ? undefined : { width: `${value}%` }} />
  </div>;
}

function Panel({ tone, children }: { tone?: "ok" | "bad"; children: ReactNode }) {
  return <div className={tone ? `update-panel ${tone}` : "update-panel"} aria-live="polite">{children}</div>;
}

export function UpdateSheet({ release, onClose }: { release: ReleaseInfo; onClose: () => void }) {
  const { game, platform, toast } = useApp();
  const store = updateStore(game.repo, platform);
  useEffect(() => { void store.markRead(release.version).catch(() => {}); }, [store, release.version]);
  const flow = useSyncExternalStore(subscribe, snapshot);
  const rawState = stepFor(flow, release.version);
  // Android installs by itself; the browser dev harness simulates that path.
  const inApp = (platform.name === "android" || platform.name === "web-dev") && !!platform.update;
  const asset = inApp ? androidPackage(release) : null;
  const desktopAsset = !inApp && platform.name === "windows" ? windowsPackage(release) : null;
  const [hydrated, setHydrated] = useState<(UpdatePackageStatus & { sha256: string }) | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(false);

  useEffect(() => {
    void game.repo.getSetting<boolean>("autoUpdate", false).then((v) => setAutoUpdate(v === true)).catch(() => {});
  }, [game.repo]);

  // Hydrate already-downloaded & SHA-256-verified package on open and refresh canInstall on app resume / split-screen return.
  useEffect(() => {
    if (!inApp || !asset || !platform.update) return;
    let alive = true;
    const refresh = async () => {
      try {
        const sha256 = asset.sha256 ?? await expectedHash(platform, release, asset).catch(() => null);
        if (!alive) return;
        if (sha256 && platform.update?.packageStatus) {
          const pkg = await platform.update.packageStatus({ version: release.version, sha256 });
          if (!alive) return;
          setHydrated({ ...pkg, sha256 });
          if (pkg.downloaded && pkg.verified) {
            hydrateReadyPackage({ version: release.version, size: asset.size, sha256 });
          }
          if (pkg.canInstall) {
            void resumePermissionInstall(platform);
          }
          void store.refreshStatus().catch(() => {});
        } else if (platform.update?.canInstall) {
          const allowed = await platform.update.canInstall();
          if (!alive) return;
          setHydrated((prev) => (prev ? { ...prev, canInstall: allowed } : null));
          if (allowed) {
            void resumePermissionInstall(platform);
          }
        }
      } catch {
        // Ignore transient inspection errors; manual download remains available.
      }
    };
    void refresh();
    const onResume = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void refresh();
      }
    };
    window.addEventListener("lishi:app-resume", onResume);
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      alive = false;
      window.removeEventListener("lishi:app-resume", onResume);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [inApp, asset?.name, asset?.sha256, platform, release, store]);

  const notes = plainNotes(release.notes);
  const browser = () => void openLink(platform, toast, release.url);
  const downloadDesktop = () => void openLink(platform, toast, desktopAsset ? desktopAsset.url : release.url);
  const download = () => {
    if (asset) void startDownload(platform, release, asset);
  };
  const install = async () => {
    const pkg =
      asset && (hydrated?.sha256 || (flow.version === release.version ? flow.sha256 : null))
        ? {
            version: release.version,
            size: asset.size,
            sha256: (hydrated?.sha256 ?? flow.sha256)!,
          }
        : undefined;
    const status = await installUpdate(platform, pkg);
    if (status === "failed") {
      setHydrated(null);
    } else if (status === "unsupported") {
      toast(platform.name === "web-dev" ? "开发台只模拟下载，安装请在手机上试" : "这里不能直接安装，请用浏览器下载");
    }
  };

  // Derive effective step: recognize hydrated verified package when flow is idle, and clear permission prompt once canInstall is granted.
  const effectiveState = (() => {
    if (rawState.step === "permission" && hydrated?.canInstall) {
      return { step: "ready" as const };
    }
    if (rawState.step === "idle") {
      if (hydrated?.downloaded && hydrated.verified) {
        return { step: "ready" as const };
      }
      if (hydrated && hydrated.bytes > 0 && asset && hydrated.bytes < asset.size) {
        return { step: "paused" as const, received: hydrated.bytes, total: asset.size };
      }
    }
    return rawState;
  })();

  const displayAsset = asset ?? desktopAsset;
  const meta = [`当前 ${__APP_VERSION__}`, displayAsset && `安装包 ${mb(displayAsset.size)}`, day(release.publishedAt), release.prerelease && "预发布"].filter(Boolean).join(" · ");
  const browserButton = <button className="ghost" onClick={browser}>用浏览器下载</button>;

  let body: ReactNode;
  if (!inApp) {
    if (desktopAsset) {
      body = <Panel>
        <p className="update-status">下载新的电脑安装包（{desktopAsset.name}），运行即可覆盖安装。</p>
        <p className="update-hint">存档不会丢，不用先卸载。</p>
        <div className="update-actions">
          <button className="primary" onClick={downloadDesktop}>下载安装包</button>
          <button className="ghost" onClick={browser}>打开发布页</button>
        </div>
      </Panel>;
    } else if (androidPackage(release)) {
      body = <Panel>
        <p className="update-status">这一版目前已发布安卓安装包，电脑版安装包稍后提供。</p>
        <p className="update-hint">上方是这一版的更新说明；存档保存在本机，后续覆盖安装即可。</p>
        <div className="update-actions"><button className="primary" onClick={browser}>查看发布页</button></div>
      </Panel>;
    } else {
      body = <Panel>
        <p className="update-status">下载新的安装包，运行即可覆盖安装。</p>
        <p className="update-hint">存档不会丢，不用先卸载。</p>
        <div className="update-actions"><button className="primary" onClick={browser}>去下载</button></div>
      </Panel>;
    }
  } else if (!asset) {
    body = <Panel>
      <p className="update-status">这一版没有安卓安装包。</p>
      <div className="update-actions"><button className="primary" onClick={browser}>打开发布页</button></div>
    </Panel>;
  } else switch (effectiveState.step) {
    case "idle":
      body = <Panel>
        <div className="update-actions"><button className="primary" onClick={download}>下载更新</button>{browserButton}</div>
        <p className="update-hint">覆盖安装，存档不会丢。下载完先校验再安装。</p>
      </Panel>;
      break;
    case "preparing":
      body = <Panel><Bar value={null} /><p className="update-status">正在准备下载…</p></Panel>;
      break;
    case "downloading": {
      const value = percent(effectiveState.received, effectiveState.total);
      body = <Panel>
        <Bar value={value} />
        <p className="update-status">{effectiveState.retrying ? "网络不稳，正在重连…" : "正在下载"}<span className="update-count">{mb(effectiveState.received)} / {mb(effectiveState.total)} · {value}%</span></p>
        <div className="update-actions"><button onClick={() => void pauseDownload(platform)}>暂停</button></div>
        <p className="update-hint">可以先关掉这里，下载会在后台继续。</p>
      </Panel>;
      break;
    }
    case "paused":
      body = <Panel>
        <Bar value={percent(effectiveState.received, effectiveState.total)} />
        <p className="update-status">已暂停<span className="update-count">{mb(effectiveState.received)} / {mb(effectiveState.total)}</span></p>
        <div className="update-actions"><button className="primary" onClick={download}>继续下载</button>{browserButton}</div>
      </Panel>;
      break;
    case "verifying":
      body = <Panel><Bar value={100} /><p className="update-status">正在校验安装包…</p></Panel>;
      break;
    case "ready":
      body = <Panel tone="ok">
        <p className="update-status">安装包已下载，校验无误。</p>
        <div className="update-actions"><button className="primary" onClick={() => void install()}>安装</button></div>
        <p className="update-hint">覆盖安装，存档不会丢。系统确认时选“安装”。</p>
      </Panel>;
      break;
    case "permission":
      body = <Panel>
        <p className="update-status">需要允许本应用“安装未知应用”</p>
        <p className="update-hint">打开开关后回到这里，状态会自动刷新，再点“安装”即可。</p>
        <div className="update-actions"><button className="primary" onClick={() => void install()}>安装</button></div>
      </Panel>;
      break;
    case "installing":
      body = <Panel tone="ok">
        <p className="update-status">已打开系统安装界面</p>
        <p className="update-hint">按提示完成更新，装好后从桌面重新打开。</p>
        <div className="update-actions"><button onClick={() => void install()}>再次打开安装</button></div>
      </Panel>;
      break;
    case "failed": {
      const failure = FAILURES[effectiveState.reason];
      body = <Panel tone="bad">
        {effectiveState.received > 0 && <Bar value={percent(effectiveState.received, effectiveState.total)} />}
        <p className="update-status">{failure.text}</p>
        <div className="update-actions">
          {failure.retry && <button className="primary" onClick={effectiveState.reason === "install" ? () => void install() : download}>{failure.retry}</button>}
          <button className={failure.retry ? "ghost" : "primary"} onClick={browser}>用浏览器下载</button>
        </div>
      </Panel>;
      break;
    }
  }

  const toggleAutoUpdate = (next: boolean) => {
    setAutoUpdate(next);
    void game.repo.setSetting("autoUpdate", next).then(() => {
      if (next) void store.autoPrepare().catch(() => {});
    });
  };

  return <Sheet title={`新版本 ${release.version}`} onClose={onClose}>
    <div className="update-sheet">
      <p className="update-meta">{meta}</p>
      {notes && <div className="update-notes">{notes}</div>}
      {body}
      {inApp && (
        <label className="update-auto-toggle">
          <input type="checkbox" checked={autoUpdate} onChange={(e) => toggleAutoUpdate(e.target.checked)} className="check-20" />
          <span>
            <b>Wi-Fi 下自动准备更新</b>
            <small>连上不计流量的 Wi-Fi 且空间充足时提前下好并校验，准备好后再由你点“安装”</small>
          </span>
        </label>
      )}
      <p className="update-hint">下载较慢时，建议开启代理后重试。</p>
    </div>
  </Sheet>;
}

/**
 * Opens the update details from 设置 → 关于与更新. Keep its fixed layers in
 * <body>, outside any screen animation's containing block.
 */
export function UpdateButton({ release, label = "去更新" }: { release: ReleaseInfo; label?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="primary" onClick={() => setOpen(true)}>{label}</button>
    {open && createPortal(<UpdateSheet release={release} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

/** 设置 → 开发者, debug builds only: read releases from a local test server (docs/DEVELOPMENT.md). */
export function UpdateDevSource() {
  const { platform, toast } = useApp();
  const [saved, setSaved] = useState<string | null | undefined>(undefined);
  const [value, setValue] = useState("");
  useEffect(() => {
    let live = true;
    void platform.update?.devSource().then((info) => {
      if (live && info.available) { setSaved(info.url); setValue(info.url ?? ""); }
    }, () => {});
    return () => { live = false; };
  }, [platform]);
  if (saved === undefined || !platform.update) return null;
  const save = async (url: string | null) => {
    try {
      await platform.update!.setDevSource(url);
      setSaved(url); setValue(url ?? "");
      toast(url ? "检查更新改读测试更新源" : "检查更新改回 GitHub");
    } catch (error) { toast(error instanceof Error ? error.message : "没能保存"); }
  };
  return <div className="setting">
    <div className="setting-head"><b>测试更新源（调试版）</b><small>“检查更新”改从这台电脑的测试服务读取版本，配合 adb reverse 使用；清除后改回 GitHub。</small></div>
    <div className="row">
      <input className="grow" value={value} onChange={(e) => setValue(e.target.value.trim())} placeholder="http://127.0.0.1:18990" inputMode="url" autoCapitalize="off" aria-label="测试更新源" />
      <button className="primary" disabled={!value || value === saved} onClick={() => void save(value)}>保存</button>
      {saved && <button onClick={() => void save(null)}>清除</button>}
    </div>
  </div>;
}
