// Checking for a new version (设置 → 更新, UX_APP_BASICS): asks GitHub for the
// latest release of the public repository and compares it with this build.
// Nothing is downloaded or installed here; the player is sent to the release.
import type { Platform } from "../../platform";

export const REPO_URL = "https://github.com/wangyingxuan383-ai/lishi-chuanyue";
const LATEST = "https://api.github.com/repos/wangyingxuan383-ai/lishi-chuanyue/releases?per_page=5";

export interface ReleaseInfo { version: string; name: string; notes: string; url: string; publishedAt: string; prerelease: boolean }

/** Compares "0.8.0" style versions; true when `a` is newer than `b`. */
export function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** The newest release, pre-releases included (this is a personal build line). */
export async function latestRelease(platform: Platform): Promise<ReleaseInfo | null> {
  const response = await platform.llm.getPublic(LATEST, 12_000);
  if (response.status !== 200) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  const list = JSON.parse(response.body) as { tag_name: string; name: string | null; body: string | null; html_url: string; published_at: string; prerelease: boolean; draft: boolean }[];
  const release = list.filter((r) => !r.draft).sort((a, b) => (newer(a.tag_name, b.tag_name) ? -1 : 1))[0];
  if (!release) return null;
  return {
    version: release.tag_name.replace(/^v/, ""), name: release.name ?? release.tag_name, notes: release.body ?? "",
    url: release.html_url, publishedAt: release.published_at, prerelease: release.prerelease,
  };
}

/** Opens a link in the browser; says so when nothing could open it. */
export async function openLink(platform: Platform, toast: (text: string) => void, url: string) {
  try { await platform.system.openUrl(url); } catch { toast("没能打开浏览器，链接已复制"); await navigator.clipboard?.writeText(url).catch(() => {}); }
}
