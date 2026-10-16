// Vite dev-server middleware for the browser harness (docs/contracts/PLATFORM.md §6).
// Holds dev API keys in .cache/dev-secrets.json, injects them into model
// requests and relays SSE `data:` lines as NDJSON stream events. Dev only;
// requests from non-loopback addresses are refused.
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { isBound, maskSecret, relayStream } from "./relay.ts";

interface SecretEntry {
  value: string;
  boundBaseUrl: string;
}

type Secrets = Record<string, SecretEntry>;

const MAX_BODY = 1024 * 1024;

function normalizeBase(url: string): string {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("invalid base url");
  }
  return url.replace(/\/+$/, "");
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) reject(new Error("body too large"));
      else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value ?? null));
}

export function devBridge(options: { root: string; env: Record<string, string> }): Plugin {
  const file = path.join(options.root, ".cache", "dev-secrets.json");

  const load = (): Secrets => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Secrets;
    } catch {
      return {};
    }
  };
  const save = (secrets: Secrets) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(secrets, null, 2));
  };

  // .env.local only pre-fills the "main" slot; the UI can overwrite it.
  const seed = () => {
    const { DEV_LLM_BASE_URL: base, DEV_LLM_KEY: key } = options.env;
    const secrets = load();
    if (base && key && !secrets.main) {
      secrets.main = { value: key, boundBaseUrl: normalizeBase(base) };
      save(secrets);
    }
  };

  async function stream(req: IncomingMessage, res: ServerResponse) {
    const { slot, url, body, timeouts } = await readJson(req);
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
    res.flushHeaders();
    const emit = (event: unknown) => res.write(JSON.stringify(event) + "\n");
    const entry = load()[slot];
    if (!entry) return void (emit({ type: "error", kind: "no_secret" }), res.end());
    if (!isBound(url, entry.boundBaseUrl)) return void (emit({ type: "error", kind: "url_not_bound" }), res.end());
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    await relayStream({ key: entry.value, url, body, timeouts, signal: controller.signal }, emit);
    res.end();
  }

  async function get(req: IncomingMessage, res: ServerResponse) {
    const { slot, url, timeoutMs } = await readJson(req);
    const entry = load()[slot];
    if (!entry) return sendJson(res, 400, { code: "no_secret", message: "尚未保存 Key" });
    if (!isBound(url, entry.boundBaseUrl)) return sendJson(res, 400, { code: "url_not_bound", message: "地址与 Key 绑定的服务不一致" });
    try {
      const upstream = await fetch(url, {
        redirect: "manual",
        headers: { Authorization: `Bearer ${entry.value}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = maskSecret((await upstream.text()).slice(0, 1024 * 1024), entry.value);
      sendJson(res, 200, { status: upstream.status, body });
    } catch {
      sendJson(res, 502, { code: "network", message: "无法连接服务" });
    }
  }

  return {
    name: "chuanyue-dev-bridge",
    apply: "serve",
    configureServer(server) {
      seed();
      server.middlewares.use("/__dev", (req, res) => {
        const remote = req.socket.remoteAddress ?? "";
        if (!/^(::1|127\.|::ffff:127\.)/.test(remote)) return sendJson(res, 403, { code: "forbidden", message: "仅限本机" });
        const route = req.url ?? "";
        const handle = async () => {
          if (route.startsWith("/llm/stream")) return stream(req, res);
          if (route.startsWith("/llm/get")) return get(req, res);
          if (route.startsWith("/config")) {
            // Non-secret pre-fill for the setup form.
            return sendJson(res, 200, { baseUrl: options.env.DEV_LLM_BASE_URL ?? null, model: options.env.DEV_LLM_MODEL ?? null });
          }
          if (route.startsWith("/secret/set")) {
            const { slot, value, boundBaseUrl } = await readJson(req);
            if (!/^[a-z0-9_-]{1,64}$/.test(slot) || !value || /\s/.test(value)) {
              return sendJson(res, 400, { code: "secret_invalid", message: "槽位或 Key 不合法" });
            }
            const secrets = load();
            secrets[slot] = { value, boundBaseUrl: normalizeBase(boundBaseUrl) };
            save(secrets);
            return sendJson(res, 200, null);
          }
          if (route.startsWith("/secret/has")) {
            const { slot } = await readJson(req);
            const entry = load()[slot];
            return sendJson(res, 200, { configured: !!entry, boundBaseUrl: entry?.boundBaseUrl ?? null });
          }
          if (route.startsWith("/secret/remove")) {
            const { slot } = await readJson(req);
            const secrets = load();
            delete secrets[slot];
            save(secrets);
            return sendJson(res, 200, null);
          }
          sendJson(res, 404, { code: "not_found", message: "未知接口" });
        };
        handle().catch((error) => {
          if (!res.headersSent) sendJson(res, 500, { code: "dev_bridge", message: String(error?.message ?? error) });
          else res.end();
        });
      });
    },
  };
}
