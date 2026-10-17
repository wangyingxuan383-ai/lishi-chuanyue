// Checking for a new version (设置 → 更新, UX_APP_BASICS): asks GitHub for the
// latest release of the public repository and compares it with this build.
// Nothing is downloaded here; the update sheet (updateFlow.ts) does that on
// Android, after finding the package's published SHA-256 (expectedHash).
import type { Platform } from "../../platform";
import { allowedLink } from "../../platform/linkPolicy";

export const REPO_URL = "https://github.com/wangyingxuan383-ai/lishi-chuanyue";
const LATEST = "https://api.github.com/repos/wangyingxuan383-ai/lishi-chuanyue/releases?per_page=5";

export interface ReleaseAsset {
  name: string;
  size: number;
  /** `browser_download_url`. */
  url: string;
  /** Lowercase hex SHA-256 that GitHub computed at upload (`digest`); null for older assets. */
  sha256: string | null;
}

export interface ReleaseInfo { version: string; name: string; notes: string; url: string; publishedAt: string; prerelease: boolean; assets: ReleaseAsset[] }

/** Uploaded assets with a usable name, size and link; an unfinished upload ("open") is left out. */
function assetsOf(value: unknown): ReleaseAsset[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const a = item as Record<string, unknown>;
    if (typeof a.name !== "string" || !a.name || typeof a.browser_download_url !== "string") return [];
    if (typeof a.size !== "number" || !Number.isSafeInteger(a.size) || a.size <= 0) return [];
    if (a.state !== undefined && a.state !== "uploaded") return [];
    const digest = typeof a.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest)?.[1].toLowerCase() ?? null : null;
    return [{ name: a.name, size: a.size, url: a.browser_download_url, sha256: digest }];
  });
}

/** The Android package of a release: `chuanyue-<version>.apk`, or its only .apk. */
export function androidPackage(release: ReleaseInfo): ReleaseAsset | null {
  const apks = release.assets.filter((a) => a.name.toLowerCase().endsWith(".apk"));
  return apks.find((a) => a.name === `chuanyue-${release.version}.apk`) ?? (apks.length === 1 ? apks[0] : null);
}

/** `sha256sum` lines (`<hash>  <name>`, `<hash> *<name>`); a name listed twice with different hashes counts as unknown. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (!match) continue;
    const name = match[2].trim(), hash = match[1].toLowerCase();
    if (sums.has(name) && sums.get(name) !== hash) conflicting.add(name);
    sums.set(name, hash);
  }
  for (const name of conflicting) sums.delete(name);
  return sums;
}

/**
 * The SHA-256 the package must have: GitHub's digest, else the release's
 * SHA256SUMS.txt. Null when neither says; then nothing is installed in-app.
 * Rejects when SHA256SUMS.txt exists but could not be read (try again later).
 */
export async function expectedHash(platform: Platform, release: ReleaseInfo, asset: ReleaseAsset): Promise<string | null> {
  if (asset.sha256) return asset.sha256;
  const sums = release.assets.find((a) => /^sha256sums(\.txt)?$/i.test(a.name));
  if (!sums || !platform.update) return null;
  return parseSums(await platform.update.fetchText(sums.url)).get(asset.name) ?? null;
}

/** Release notes as short plain text: Markdown marks removed, at most `maxLines` lines and `maxChars` characters. */
export function plainNotes(markdown: string, maxLines = 8, maxChars = 360): string {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "· ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/<[^>]+>/g, "")
      .trim())
    .filter((line) => line && !/^([-*_=])(\s*\1){2,}$/.test(line));
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (kept.length === maxLines || length + line.length > maxChars) {
      const room = maxChars - length;
      if (kept.length < maxLines && room > 12) kept.push(`${line.slice(0, room - 1)}…`);
      else if (kept.length) kept[kept.length - 1] += "…";
      return kept.join("\n");
    }
    kept.push(line);
    length += line.length;
  }
  return kept.join("\n");
}

interface Version { core: string[]; prerelease: string[] }

/** SemVer, with an optional tag prefix. Build metadata does not affect precedence. */
function parseVersion(tag: unknown): Version | null {
  if (typeof tag !== "string") return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag);
  // JS's $ also matches before a final newline; a tag must match in full.
  if (!match || match[0] !== tag) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^0\d+$/.test(part))) return null;
  return { core: match.slice(1, 4), prerelease };
}

const compareText = (a: string, b: string) => a === b ? 0 : a < b ? -1 : 1;
// Compare decimal strings without losing precision for large version identifiers.
const compareNumber = (a: string, b: string) => a.length - b.length || compareText(a, b);

function compareVersion(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const order = compareNumber(a.core[i], b.core[i]);
    if (order) return order;
  }
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i], right = b.prerelease[i];
    const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    const order = leftNumeric && rightNumeric ? compareNumber(left, right)
      : leftNumeric !== rightNumeric ? (leftNumeric ? -1 : 1) : compareText(left, right);
    if (order) return order;
  }
  return a.prerelease.length - b.prerelease.length;
}

/** True when `a` has higher SemVer precedence; invalid tags never announce an update. */
export function newer(a: string, b: string): boolean {
  const pa = parseVersion(a), pb = parseVersion(b);
  return !!pa && !!pb && compareVersion(pa, pb) > 0;
}

/** The newest release, pre-releases included (this is a personal build line). */
export async function latestRelease(platform: Platform): Promise<ReleaseInfo | null> {
  const response = await platform.llm.getPublic(LATEST, 12_000);
  if (response.status !== 200) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  let list: unknown;
  const invalidResponse = () => new Error("没能读到版本信息，请稍后再试");
  try { list = JSON.parse(response.body); } catch { throw invalidResponse(); }
  if (!Array.isArray(list)) throw invalidResponse();
  const releases = list.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const r = item as Record<string, unknown>;
    const version = parseVersion(r.tag_name);
    if (!version || r.draft || typeof r.html_url !== "string") return [];
    return [{ version, release: {
      version: (r.tag_name as string).replace(/^v/, ""),
      name: typeof r.name === "string" ? r.name : r.tag_name as string,
      notes: typeof r.body === "string" ? r.body : "",
      url: r.html_url, publishedAt: typeof r.published_at === "string" ? r.published_at : "", prerelease: r.prerelease === true,
      assets: assetsOf(r.assets),
    } }];
  });
  // Equal precedence returns 0: keep the API's order, including metadata-only differences.
  const release = releases.sort((a, b) => compareVersion(b.version, a.version))[0]?.release;
  if (!release) return null;
  return release;
}

/** Opens a link in the browser; says so when nothing could open it. */
export async function openLink(platform: Platform, toast: (text: string) => void, url: string) {
  const refused = "这个链接不在应用的可信链接列表中";
  if (!allowedLink(url, "browser")) { toast(refused); return; }
  try { await platform.system.openUrl(url); } catch (error) {
    // Native IPC and the browser policy use this refusal. A rejected link must
    // not become a clipboard fallback, even if this build's local policy allows it.
    const message = typeof error === "string" ? error
      : error && typeof error === "object" && "message" in error ? String(error.message) : "";
    if (message.includes(refused)) { toast(refused); return; }
    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (!clipboard?.writeText) { toast("没能打开浏览器，也没能复制链接"); return; }
      await clipboard.writeText(url);
    } catch { toast("没能打开浏览器，也没能复制链接"); return; }
    toast("没能打开浏览器，链接已复制");
  }
}
