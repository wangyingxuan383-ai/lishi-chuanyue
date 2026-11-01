// The development process shares native SQLite and execution with the app.
// HTTP is only Vite's existing loopback bridge; the child has no TCP listener.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { IncomingMessage, ServerResponse } from "node:http";

const NORMAL_BODY = 1024 * 1024;
const IMPORT_BODY = 64 * 1024 * 1024;
const MAX_RESPONSE = 128 * 1024 * 1024;
const METHODS = new Set(["status", "importLegacy", "sqlQuery", "sqlBatch", "sqlBackup", "sqlListBackups", "sqlRestore", "start", "snapshot", "list", "stop", "resume", "settle", "context", "agent", "pi_agent"]);

export class HostError extends Error {
  constructor(readonly code: string, message: string, readonly status = 500) { super(message); }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export class HostBridge {
  private child: ChildProcess | null = null;
  private build: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private writes: Promise<void> = Promise.resolve();
  private nextId = 0;
  private closed = false;
  private readonly onExit = () => { this.build?.kill(); this.child?.kill(); };

  constructor(private readonly root: string) { process.once("exit", this.onExit); }

  private fail(error: Error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }

  private async start(): Promise<void> {
    if (this.closed) throw new HostError("dev_host_closed", "开发宿主已关闭");
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const binary = path.join(this.root, "target", "debug", process.platform === "win32" ? "story-dev-host.exe" : "story-dev-host");
      {
        // Cargo also checks source changes on an existing checkout. Launch
        // the executable directly so Vite owns the actual host on Windows.
        await new Promise<void>((resolve, reject) => {
          const build = spawn("cargo", ["build", "-p", "story-dev-host"], { cwd: this.root, windowsHide: true, stdio: "ignore" });
          this.build = build;
          const timer = setTimeout(() => { build.kill(); reject(new HostError("dev_host_build", "开发宿主构建超时，请运行 cargo build -p story-dev-host")); }, 180000);
          build.once("error", () => { clearTimeout(timer); reject(new HostError("dev_host_build", "无法构建开发宿主，请先运行开发环境脚本和 cargo build -p story-dev-host")); });
          build.once("close", (code) => { if (this.build === build) this.build = null; clearTimeout(timer); code === 0 ? resolve() : reject(new HostError("dev_host_build", "开发宿主尚未构建，请运行 cargo build -p story-dev-host")); });
        });
      }
      if (this.closed) throw new HostError("dev_host_closed", "开发宿主已关闭");
      const child = spawn(binary, [], { cwd: this.root, windowsHide: true, env: { ...process.env, LISHI_DEV_ROOT: this.root, LISHI_PI_NODE: process.execPath }, stdio: ["pipe", "pipe", "ignore"] });
      this.child = child;
      const decoder = new StringDecoder("utf8"); let buffer = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > MAX_RESPONSE) {
          this.fail(new HostError("dev_host_protocol", "开发宿主返回内容过长")); child.kill(); return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line) as { id: number; result?: unknown; error?: { code?: string; message?: string } };
            const item = this.pending.get(response.id);
            if (!item) continue;
            this.pending.delete(response.id); clearTimeout(item.timer);
            if (response.error) item.reject(new HostError(response.error.code ?? "dev_host", response.error.message ?? "开发宿主操作失败"));
            else item.resolve(response.result);
          } catch {
            this.fail(new HostError("dev_host_protocol", "开发宿主返回格式无效")); child.kill(); return;
          }
        }
      });
      child.stdin!.on("error", () => { if (this.child === child) this.fail(new HostError("dev_host_closed", "开发宿主连接已断开，请重新打开页面")); });
      child.once("error", () => { if (this.child === child) this.fail(new HostError("dev_host_start", "开发宿主无法启动，请重新构建")); });
      child.once("close", () => {
        if (this.child === child) { this.child = null; this.fail(new HostError("dev_host_closed", "开发宿主已退出，运行进度已保留，请重新打开页面")); }
      });
    })();
    try { await this.starting; } finally { this.starting = null; }
  }

  async call<T>(method: string, params: unknown = {}): Promise<T> {
    if (!METHODS.has(method)) throw new HostError("dev_host_method", "未知开发宿主接口", 404);
    await this.start();
    const id = ++this.nextId;
    const line = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HostError("dev_host_timeout", "开发宿主响应超时；正在生成的故事仍可稍后查看", 504)); }, 120000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      // Writes obey pipe backpressure. Replies can arrive out of order and are
      // correlated by id; waiting for one browser response never stops a run.
      this.writes = this.writes.catch(() => {}).then(() => new Promise<void>((done, failed) => {
        const input = this.child?.stdin;
        if (!input?.writable) return failed(new HostError("dev_host_closed", "开发宿主连接已断开"));
        input.write(line, (error) => error ? failed(new HostError("dev_host_closed", "开发宿主连接已断开")) : done());
      }));
      void this.writes.catch((error: Error) => { const item = this.pending.get(id); if (item) { this.pending.delete(id); clearTimeout(item.timer); item.reject(error); } });
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true; process.removeListener("exit", this.onExit);
    this.fail(new HostError("dev_host_closed", "开发宿主已关闭，运行进度已保留"));
    this.build?.kill(); this.build = null;
    const child = this.child; this.child = null;
    if (child) {
      // EOF lets the native owner cancel and checkpoint before exiting. Page
      // requests closing never call this lifecycle method.
      child.stdin?.end();
      const timer = setTimeout(() => child.kill(), 8000); timer.unref();
      child.once("close", () => clearTimeout(timer));
    }
  }
}

function reply(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value ?? null));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const clean = () => { req.off("data", data); req.off("end", end); req.off("error", error); req.off("aborted", aborted); };
    const error = () => { clean(); req.once("error", () => {}); reject(new HostError("dev_host_body", "请求未完整发送", 400)); };
    const aborted = () => error();
    const end = () => { clean(); resolve(Buffer.concat(chunks)); };
    const data = (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); size += chunk.length;
      if (size > limit) {
        clean(); req.once("error", () => {}); req.resume();
        reject(new HostError("dev_host_too_large", "请求内容超过开发宿主上限", 413));
      } else chunks.push(chunk);
    };
    req.on("data", data); req.once("end", end); req.once("error", error); req.once("aborted", aborted);
  });
}

export async function hostRequest(host: HostBridge, method: string, req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return reply(res, 405, { code: "method", message: "请使用 POST" });
  if (!METHODS.has(method)) return reply(res, 404, { code: "not_found", message: "未知开发宿主接口" });
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return reply(res, 403, { code: "forbidden", message: "仅限当前开发页面" }); }
    catch { return reply(res, 403, { code: "forbidden", message: "仅限当前开发页面" }); }
  }
  // Skill packages use a JSON byte array (up to 8 MiB before serialization).
  // Native agent RPCs validate each operation's own limits after decoding.
  const limit = method === "pi_agent" ? 8 * 1024 * 1024 : method === "importLegacy" || method === "sqlBatch" || method === "agent" ? IMPORT_BODY : NORMAL_BODY;
  if (Number(req.headers["content-length"]) > limit) {
    req.resume();
    return reply(res, 413, { code: "dev_host_too_large", message: "请求内容超过开发宿主上限" });
  }
  try {
    const body = await readBody(req, limit);
    let params: unknown;
    try { params = JSON.parse(body.toString("utf8") || "{}"); }
    catch { return reply(res, 400, { code: "dev_host_json", message: "请求格式无效" }); }
    const result = await host.call(method, params);
    reply(res, 200, result);
  } catch (error) {
    reply(res, error instanceof HostError ? error.status : 500, { code: error instanceof HostError ? error.code : "dev_host", message: error instanceof HostError ? error.message : "开发宿主操作失败" });
  }
}
