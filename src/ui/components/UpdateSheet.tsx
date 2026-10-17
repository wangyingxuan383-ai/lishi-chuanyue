// In-app update (R14): the new version's notes, then download → verify →
// install on Android. Elsewhere the release page opens in the browser.
// The download keeps going when the sheet is closed (updateFlow.ts).
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../app/context";
import { androidPackage, openLink, plainNotes, type ReleaseInfo } from "../app/update";
import { installUpdate, pauseDownload, snapshot, startDownload, stepFor, subscribe, type FailReason } from "../app/updateFlow";
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
  const { platform, toast } = useApp();
  const flow = useSyncExternalStore(subscribe, snapshot);
  const state = stepFor(flow, release.version);
  // Android installs by itself; the browser dev harness simulates that path.
  const inApp = (platform.name === "android" || platform.name === "web-dev") && !!platform.update;
  const asset = inApp ? androidPackage(release) : null;
  const notes = plainNotes(release.notes);
  const browser = () => void openLink(platform, toast, release.url);
  const download = () => { if (asset) void startDownload(platform, release, asset); };
  const install = async () => {
    const status = await installUpdate(platform);
    if (status === "unsupported") toast(platform.name === "web-dev" ? "开发台只模拟下载，安装请在手机上试" : "这里不能直接安装，请用浏览器下载");
  };
  const meta = [`当前 ${__APP_VERSION__}`, asset && `安装包 ${mb(asset.size)}`, day(release.publishedAt), release.prerelease && "预发布"].filter(Boolean).join(" · ");
  const browserButton = <button className="ghost" onClick={browser}>用浏览器下载</button>;

  let body: ReactNode;
  if (!inApp) {
    body = <Panel>
      <p className="update-status">下载新的安装包，运行即可覆盖安装。</p>
      <p className="update-hint">存档不会丢，不用先卸载。</p>
      <div className="update-actions"><button className="primary" onClick={browser}>去下载</button></div>
    </Panel>;
  } else if (!asset) {
    body = <Panel>
      <p className="update-status">这一版没有安卓安装包。</p>
      <div className="update-actions"><button className="primary" onClick={browser}>打开发布页</button></div>
    </Panel>;
  } else switch (state.step) {
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
      const value = percent(state.received, state.total);
      body = <Panel>
        <Bar value={value} />
        <p className="update-status">{state.retrying ? "网络不稳，正在重连…" : "正在下载"}<span className="update-count">{mb(state.received)} / {mb(state.total)} · {value}%</span></p>
        <div className="update-actions"><button onClick={() => void pauseDownload(platform)}>暂停</button></div>
        <p className="update-hint">可以先关掉这里，下载会在后台继续。</p>
      </Panel>;
      break;
    }
    case "paused":
      body = <Panel>
        <Bar value={percent(state.received, state.total)} />
        <p className="update-status">已暂停<span className="update-count">{mb(state.received)} / {mb(state.total)}</span></p>
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
        <p className="update-hint">打开开关后回到这里，再点“安装”。</p>
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
      const failure = FAILURES[state.reason];
      body = <Panel tone="bad">
        {state.received > 0 && <Bar value={percent(state.received, state.total)} />}
        <p className="update-status">{failure.text}</p>
        <div className="update-actions">
          {failure.retry && <button className="primary" onClick={state.reason === "install" ? () => void install() : download}>{failure.retry}</button>}
          <button className={failure.retry ? "ghost" : "primary"} onClick={browser}>用浏览器下载</button>
        </div>
      </Panel>;
      break;
    }
  }

  return <Sheet title={`新版本 ${release.version}`} onClose={onClose}>
    <div className="update-sheet">
      <p className="update-meta">{meta}</p>
      {notes && <div className="update-notes">{notes}</div>}
      {body}
    </div>
  </Sheet>;
}

/**
 * Opens the update sheet: the Home banner and 设置 → 关于与更新 use it. The
 * sheet goes to <body>: an animated banner (.notice) would otherwise be the
 * containing block of its fixed layers and trap it inside the banner.
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
