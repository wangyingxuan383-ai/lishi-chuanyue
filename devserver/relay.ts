// Node-side model request relay shared by the dev bridge and the eval scripts.
// Mirrors the native llm_stream semantics (docs/contracts/PLATFORM.md §3).
import type { StreamEvent, StreamTimeouts } from "../src/platform/types.ts";

const MAX_BODY = 4 * 1024 * 1024;

export function isBound(url: string, base: string): boolean {
  if (!url.startsWith(base)) return false;
  return ["", "/", "?"].includes(url.charAt(base.length));
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
