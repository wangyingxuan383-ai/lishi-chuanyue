// Node-side model request relay shared by the dev bridge and the eval scripts.
// Mirrors the native llm_stream semantics (docs/contracts/PLATFORM.md §3).
import type { StreamEvent, StreamTimeouts } from "../src/platform/types.ts";

const MAX_BODY = 4 * 1024 * 1024;

function cleanRawUrlPath(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 8192 || /[\u0000-\u001f\u007f\\]/.test(trimmed)) return null;
  const schemeSep = trimmed.indexOf("://");
  if (schemeSep <= 0) return null;
  const afterScheme = trimmed.slice(schemeSep + 3);
  const pathStart = afterScheme.search(/[/?#]/);
  const rawPath =
    pathStart < 0
      ? "/"
      : afterScheme[pathStart] === "/"
        ? afterScheme.slice(pathStart).split(/[?#]/, 1)[0]
        : "/";

  let current = rawPath;
  for (let depth = 0; depth < 8; depth++) {
    if (current.split("/").some((seg) => seg === "." || seg === "..")) return null;
    let changed = false;
    let decoded = "";
    for (let i = 0; i < current.length; i++) {
      if (current[i] !== "%") {
        decoded += current[i];
        continue;
      }
      const hex = current.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
      const byte = Number.parseInt(hex, 16);
      // Reject encoded '.', '/', '\' or control characters that would alter path hierarchy.
      if (byte === 0x2e || byte === 0x2f || byte === 0x5c || byte < 0x20 || byte === 0x7f) return null;
      decoded += String.fromCharCode(byte);
      i += 2;
      changed = true;
    }
    current = decoded;
    if (!changed) break;
    if (depth === 7) return null;
  }
  if (current.split("/").some((seg) => seg === "." || seg === "..")) return null;
  return current;
}

function pathWithinPrefix(basePath: string, targetPath: string): boolean {
  const normBase = basePath.replace(/\/+$/, "");
  const normTarget = targetPath.replace(/\/+$/, "");
  if (!normBase) return targetPath.startsWith("/");
  return normTarget === normBase || targetPath.startsWith(`${normBase}/`);
}

export function isBound(url: string, base: string): boolean {
  if (typeof url !== "string" || typeof base !== "string" || !url || !base) return false;
  if (cleanRawUrlPath(base) === null || cleanRawUrlPath(url) === null) return false;
  let baseUrl: URL;
  let targetUrl: URL;
  try {
    baseUrl = new URL(base.trim());
    targetUrl = new URL(url.trim());
  } catch {
    return false;
  }
  if (!/^https?:$/.test(baseUrl.protocol) || !/^https?:$/.test(targetUrl.protocol)) return false;
  if (!baseUrl.hostname || !targetUrl.hostname) return false;
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) return false;
  if (targetUrl.username || targetUrl.password || targetUrl.hash) return false;
  if (baseUrl.origin !== targetUrl.origin) return false;

  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const targetPath = targetUrl.pathname;
  if (pathWithinPrefix(basePath, targetPath)) return true;

  // Align with native Gemini dual-path rule: `/v1beta/openai` <-> `/v1beta` on the same origin.
  if (basePath.endsWith("/v1beta/openai")) {
    const geminiNativePath = basePath.slice(0, -"/openai".length);
    if (pathWithinPrefix(geminiNativePath, targetPath)) return true;
  }
  return false;
}

export function maskSecret(text: string, key: string): string {
  return key ? text.split(key).join("***") : text;
}

/** Sends one streaming POST and reports events until a terminal one. */
export async function relayStream(
  request: { key: string; url: string; body: unknown; timeouts: StreamTimeouts; signal?: AbortSignal },
  emit: (event: StreamEvent) => void,
): Promise<void> {
  const controller = new AbortController();
  request.signal?.addEventListener("abort", () => controller.abort());
  let finished = false;
  const finish = (event: StreamEvent) => {
    if (finished) return;
    finished = true;
    emit(event);
    controller.abort();
  };
  const total = setTimeout(() => finish({ type: "error", kind: "timeout_total" }), request.timeouts.totalMs);
  let idle = setTimeout(() => finish({ type: "error", kind: "timeout_first" }), request.timeouts.firstByteMs);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => finish({ type: "error", kind: "timeout_idle" }), request.timeouts.idleMs);
  };

  try {
    const upstream = await fetch(request.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${request.key}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Accept-Encoding": "identity",
      },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    if (upstream.status < 200 || upstream.status >= 300) {
      const text = (await upstream.text().catch(() => "")).slice(0, 8192);
      return finish({ type: "error", kind: "http", status: upstream.status, message: maskSecret(text, request.key) });
    }
    emit({ type: "open", status: upstream.status });
    const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    const reader = upstream.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let size = 0;
    // Returns true when the line ended the stream.
    const handleLine = (line: string): boolean => {
      if (!line.startsWith("data:")) return false;
      const data = line.slice(5).replace(/^ /, "");
      if (data === "[DONE]") {
        finish({ type: "done" });
        return true;
      }
      if (request.key && data.includes(request.key)) {
        finish({ type: "error", kind: "secret_echo" });
        return true;
      }
      emit({ type: "data", data });
      return false;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done || finished) break;
      touch();
      size += value.length;
      if (size > MAX_BODY) return finish({ type: "error", kind: "too_large" });
      buffer += value;
      if (!isSse) continue;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (handleLine(line)) return;
      }
    }
    if (finished) return;
    if (!isSse && buffer) {
      if (request.key && buffer.includes(request.key)) return finish({ type: "error", kind: "secret_echo" });
      emit({ type: "data", data: buffer });
    } else if (buffer && handleLine(buffer.replace(/\r$/, ""))) {
      return;
    }
    finish({ type: "done" });
  } catch {
    finish(request.signal?.aborted ? { type: "error", kind: "cancelled" } : { type: "error", kind: "network" });
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
}
