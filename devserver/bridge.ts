// Vite dev-server middleware for the browser harness (docs/contracts/PLATFORM.md §6).
// Holds dev API keys in .cache/dev-secrets.json, injects them into model
// requests and relays SSE `data:` lines as NDJSON stream events. Dev only;
// requests from non-loopback addresses are refused.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { isBound, maskSecret, relayStream } from "./relay.ts";
import { extractBookPdf } from "./books.ts";
import { HostBridge, hostRequest } from "./host.ts";

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

function sameDevPage(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? "";
  if (!/^(?:::1|(?:::ffff:)?127\.\d+\.\d+\.\d+)$/.test(remote)) return false;
  if (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"])) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const protocol = "encrypted" in req.socket && req.socket.encrypted ? "https:" : "http:";
    return parsed.protocol === protocol && parsed.host === req.headers.host;
  }
  catch { return false; }
}

export function devBridge(options: { root: string; env: Record<string, string> }): Plugin {
  const isolatedSecrets = process.env.LISHI_DEV_SECRETS_FILE;
  const file = isolatedSecrets ? path.resolve(isolatedSecrets) : path.join(options.root, ".cache", "dev-secrets.json");
  const host = new HostBridge(options.root);

  const load = (): Secrets => {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return Object.assign(Object.create(null), value) as Secrets;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Secrets;
      throw new Error("开发台的连接配置无法读取，请检查本地配置文件。");
    }
  };
  const save = (secrets: Secrets) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(secrets, null, 2), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  };

  // .env.local only pre-fills the "main" slot; the UI can overwrite it.
  const seed = () => {
    // An isolated verification store must never inherit personal credentials.
    if (isolatedSecrets) return;
    const { DEV_LLM_BASE_URL: base, DEV_LLM_KEY: key } = options.env;
    if (!base || !key) return;
    const secrets = load();
    if (!secrets.main) {
      secrets.main = { value: key, boundBaseUrl: normalizeBase(base) };
      save(secrets);
    }
  };

  async function stream(req: IncomingMessage, res: ServerResponse) {
    const { slot, url, body, timeouts } = await readJson(req);
    const entry = load()[slot];
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
    res.flushHeaders();
    const emit = (event: unknown) => res.write(JSON.stringify(event) + "\n");
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
      try { seed(); } catch { server.config.logger.warn("开发台无法预填模型配置，存档读取仍可用。"); }
      server.httpServer?.once("close", () => host.close());
      server.middlewares.use("/__dev", (req, res) => {
        if (!sameDevPage(req)) return sendJson(res, 403, { code: "forbidden", message: "仅限当前开发页面" });
        const route = (req.url ?? "").split("?", 1)[0];
        const method = route === "/config" ? "GET" : "POST";
        if (req.method !== method) return sendJson(res, 405, { code: "method", message: `请使用 ${method}` });
        if (method === "POST") {
          const expected = route === "/book/pdf" ? "application/pdf" : "application/json";
          if (req.headers["content-type"]?.split(";", 1)[0].trim() !== expected)
            return sendJson(res, 415, { code: "content_type", message: "请求内容类型不支持" });
        }
        const handle = async () => {
          if (route.startsWith("/host/")) return hostRequest(host, route.slice("/host/".length).split("?")[0], req, res);
          if (route === "/book/pdf" && req.method === "POST") return extractBookPdf(options.root, req, res);
          if (route === "/llm/stream") return stream(req, res);
          if (route === "/llm/get") return get(req, res);
          if (route === "/config") {
            // Non-secret pre-fill for the setup form.
            return sendJson(res, 200, { baseUrl: options.env.DEV_LLM_BASE_URL ?? null, model: options.env.DEV_LLM_MODEL ?? null });
          }
          if (route === "/secret/set") {
            const { slot, value, boundBaseUrl } = await readJson(req);
            if (!/^[a-z0-9_-]{1,64}$/.test(slot) || !value || /\s/.test(value)) {
              return sendJson(res, 400, { code: "secret_invalid", message: "槽位或 Key 不合法" });
            }
            const secrets = load();
            secrets[slot] = { value, boundBaseUrl: normalizeBase(boundBaseUrl) };
            save(secrets);
            return sendJson(res, 200, null);
          }
          if (route === "/secret/has") {
            const { slot } = await readJson(req);
            const entry = load()[slot];
            return sendJson(res, 200, { configured: !!entry, boundBaseUrl: entry?.boundBaseUrl ?? null });
          }
          if (route === "/secret/remove") {
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
    closeBundle() { host.close(); },
  };
}
