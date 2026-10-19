import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

export async function extractBookPdf(root: string, req: IncomingMessage, res: ServerResponse) {
  const binary = path.join(root, "target", "debug", process.platform === "win32" ? "book-pdf.exe" : "book-pdf");
  const reply = (status: number, body: unknown) => { if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); } };
  if (!fs.existsSync(binary)) { reply(503, { error: "请先运行 cargo build -p book-pdf，再导入 PDF" }); return; }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024 * 1024) { reply(413, { error: "文件超过 64 MiB" }); return; } chunks.push(chunk); }
  const child = spawn(binary, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const timeout = setTimeout(() => { child.kill(); reply(408, { error: "PDF 读取超时，请拆分文件" }); }, 120000);
  res.on("close", () => { child.kill(); clearTimeout(timeout); });
  let output = "";
  child.stdout.on("data", (data) => { output += data; if (output.length > 128 * 1024 * 1024) child.kill(); });
  child.on("error", () => { clearTimeout(timeout); reply(500, { error: "PDF 提取工具无法启动" }); });
  child.on("close", (code) => { clearTimeout(timeout); if (res.writableEnded) return; try { reply(code === 0 ? 200 : 422, JSON.parse(output)); } catch { reply(422, { error: "无法读取 PDF，文件可能已损坏或受保护" }); } });
  child.stdin.on("error", () => {});
  child.stdin.end(Buffer.concat(chunks));
}
