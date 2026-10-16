// Shared helpers for eval scripts: a Node "platform" that only implements the
// llm part, reading dev keys from .cache/dev-secrets.json (written by the
// browser dev harness). Keys are never printed.
import fs from "node:fs";
import path from "node:path";
import { isBound, relayStream } from "../../devserver/relay.ts";
import type { Platform, StreamEvent } from "../../src/platform/types.ts";

export const ROOT = path.resolve(import.meta.dirname, "../..");

export function loadDevSecret(slot = "main"): { key: string; base: string } {
  const file = path.join(ROOT, ".cache", "dev-secrets.json");
  const secrets = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = secrets[slot];
  if (!entry) throw new Error(`.cache/dev-secrets.json 中没有槽位 ${slot}；请先在浏览器开发台保存服务`);
  return { key: entry.value, base: entry.boundBaseUrl };
}

export function nodePlatform(slot = "main"): Platform {
  const { key, base } = loadDevSecret(slot);
  const controllers = new Map<string, AbortController>();
  return {
    name: "other",
    llm: {
      async stream(request, onEvent: (event: StreamEvent) => void) {
        if (!isBound(request.url, base)) throw Object.assign(new Error("url not bound"), { code: "llm_url_not_bound" });
        const id = crypto.randomUUID();
        const controller = new AbortController();
        controllers.set(id, controller);
        void relayStream({ key, url: request.url, body: request.body, timeouts: request.timeouts, signal: controller.signal }, onEvent)
          .finally(() => controllers.delete(id));
        return id;
      },
      async cancel(id: string) {
        controllers.get(id)?.abort();
      },
    },
  } as unknown as Platform;
}

export function serviceBaseUrl(): string {
  return loadDevSecret().base;
}

export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
