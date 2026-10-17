// Shared with Rust through link-policy.json. This does not restrict player-configured AI endpoints.
import policy from "./link-policy.json";

export function allowedLink(raw: string, purpose: "browser" | "publicGet"): boolean {
  if (/[\s\u0000-\u001f\u007f"\\]/u.test(raw)) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    if (purpose === "publicGet") return policy.publicGet.includes(raw);
    return policy.browser.some((rule) => url.origin === rule.origin
      && (url.pathname === rule.path || (rule.children && url.pathname.startsWith(`${rule.path}/`))));
  } catch { return false; }
}

export function assertLink(url: string, purpose: "browser" | "publicGet") {
  if (!allowedLink(url, purpose)) throw new Error("这个链接不在应用的可信链接列表中");
}

export async function getPublic(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  assertLink(url, "publicGet");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("请求超时设置无效");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { accept: "application/vnd.github+json" }, redirect: "error", signal: controller.signal });
    return { status: response.status, body: await response.text() };
  } finally { clearTimeout(timeout); }
}
