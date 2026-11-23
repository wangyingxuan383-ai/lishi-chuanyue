// Browser dev harness only: simulates the native update download so the
// update sheet can be tried at phone size. Nothing is downloaded or installed.
// `localStorage["lishi.devUpdateSim"]` can hold "slow", "fail" (one network
// drop at 40 %), "corrupt" (the check fails once), "permission" (the first
// install asks for 安装未知应用), "metered" and "lowspace", separated by spaces.
import { PlatformError, type Platform } from "./types";

type Update = NonNullable<Platform["update"]>;

export function simulatedUpdate(): Update {
  const options = () => {
    try { return (localStorage.getItem("lishi.devUpdateSim") ?? "").split(/\s+/); } catch { return []; }
  };
  const parts = new Map<string, number>();
  const verified = new Map<string, { bytes: number; sha256: string }>();
  let failed = false, corrupted = false, asked = false, allowed = false;
  let stop: (() => void) | null = null;
  return {
    download(request, onEvent) {
      if (stop) return Promise.reject(new PlatformError("update_busy", "已经在下载了"));
      const hit = verified.get(request.version);
      if (hit && hit.sha256 === request.sha256.toLowerCase()) {
        onEvent({ type: "verifying" });
        return Promise.resolve();
      }
      const sim = options();
      let received = parts.get(request.version) ?? 0;
      const step = Math.max(1, Math.round(request.size / (sim.includes("slow") ? 120 : 30)));
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: PlatformError) => {
          clearInterval(timer);
          stop = null;
          parts.set(request.version, received);
          if (error) reject(error); else resolve();
        };
        const timer = setInterval(() => {
          received = Math.min(request.size, received + step);
          onEvent({ type: "progress", received, total: request.size });
          if (sim.includes("fail") && !failed && received >= request.size * 0.4) {
            failed = true;
            finish(new PlatformError("update_network", "网络中断了，已下载的部分会保留"));
          } else if (received >= request.size) {
            clearInterval(timer);
            onEvent({ type: "verifying" });
            setTimeout(() => {
              if (sim.includes("corrupt") && !corrupted) {
                corrupted = true;
                received = 0;
                finish(new PlatformError("update_hash", "安装包校验没通过，已删除"));
                return;
              }
              verified.set(request.version, { bytes: request.size, sha256: request.sha256.toLowerCase() });
              finish();
            }, 500);
          }
        }, 80);
        stop = () => finish(new PlatformError("update_cancelled", "下载已暂停"));
      });
    },
    async cancel() { stop?.(); },
    async fetchText() { throw new PlatformError("update_network", "开发台不下载文件"); },
    async install() {
      if (options().includes("permission") && !asked) { asked = true; allowed = true; return "permission"; }
      return "unsupported";
    },
    async canInstall() { return allowed; },
    async packageStatus({ version, sha256 }) {
      const hit = verified.get(version);
      if (hit && hit.sha256 === sha256.toLowerCase()) {
        return { downloaded: true, verified: true, bytes: hit.bytes, canInstall: allowed };
      }
      return { downloaded: false, verified: false, bytes: parts.get(version) ?? 0, canInstall: allowed };
    },
    async environmentStatus() {
      const sim = options();
      return {
        wifiUnmetered: !sim.includes("metered"),
        freeBytes: sim.includes("lowspace") ? 64 * 1024 * 1024 : 4 * 1024 * 1024 * 1024,
      };
    },
    async devSource() { return { available: false, url: null }; },
    async setDevSource() { throw new PlatformError("update_dev_only", "只有调试版可以设置测试更新源"); },
  };
}
