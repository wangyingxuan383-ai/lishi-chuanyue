// A local stand-in for GitHub Releases, for trying the in-app update on a
// phone through `adb reverse` (debug builds only; docs/DEVELOPMENT.md).
// It serves the release list the app asks for, with the package's SHA-256 as
// GitHub's `digest`, redirects the download like GitHub does, honours Range
// requests, and can misbehave on purpose. Nothing leaves this machine.
//
//   node scripts/update-fixture.mjs --apk <file.apk> [--port 18990] [--version 0.10.1]
//     [--no-digest] [--sums] [--drop-at 0.3] [--corrupt] [--rate 400]
//
//   --no-digest  leave out GitHub's digest (with --sums: the app reads SHA256SUMS.txt;
//                without it the app offers only the browser)
//   --sums       also publish SHA256SUMS.txt
//   --drop-at f  cut the connection once after this share of the file (resume test)
//   --corrupt    the first complete download has one wrong byte (hash check test)
//   --rate KB/s  throttle, to watch progress or switch apps mid-download
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const root = path.resolve(import.meta.dirname, "..");
const apkPath = option("apk", null);
if (!apkPath || !fs.statSync(apkPath, { throwIfNoEntry: false })?.isFile()) {
  console.error("Usage: node scripts/update-fixture.mjs --apk <file.apk> [--port 18990] [--version x.y.z] [--no-digest] [--sums] [--drop-at 0.3] [--corrupt] [--rate 400]");
  process.exit(2);
}
const port = Number(option("port", 18990));
const current = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const [major, minor, patch] = current.split(".").map(Number);
const version = option("version", `${major}.${minor}.${patch + 1}`);
const dropAt = option("drop-at", null) === null ? null : Number(option("drop-at", "0"));
const rate = Number(option("rate", 0)) * 1024;
let corruptOnce = flag("corrupt");
let dropOnce = dropAt !== null;

const bytes = fs.readFileSync(apkPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const apkName = `chuanyue-${version}.apk`;
const sums = `${sha256}  ${apkName}\n`;
const base = `http://127.0.0.1:${port}`;
const repo = "/wangyingxuan383-ai/lishi-chuanyue";
const download = (name) => `${base}${repo}/releases/download/v${version}/${name}`;

function releases() {
  const assets = [{
    name: apkName, size: bytes.length, state: "uploaded", content_type: "application/vnd.android.package-archive",
    digest: flag("no-digest") ? null : `sha256:${sha256}`, browser_download_url: download(apkName),
  }];
  if (flag("sums")) assets.push({ name: "SHA256SUMS.txt", size: Buffer.byteLength(sums), state: "uploaded", content_type: "text/plain", digest: null, browser_download_url: download("SHA256SUMS.txt") });
  return [{
    tag_name: `v${version}`, name: `历史穿越 ${version}（本机测试）`, draft: false, prerelease: true,
    body: ["## 本机测试版本", "", "- 这是 update-fixture 给出的假版本，用来试应用内下载、校验和安装。", `- 安装包 ${(bytes.length / 1048576).toFixed(1)} MB。`].join("\n"),
    html_url: `https://github.com${repo}/releases`,
    published_at: new Date().toISOString(), assets,
  }];
}

const log = (...parts) => console.log(new Date().toLocaleTimeString("zh-CN", { hour12: false }), ...parts);

/** Sends `body[start..]`, throttled and possibly cut, as one response. */
function send(req, res, body, type) {
  const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
  let start = range ? Number(range[1]) : 0;
  if (start >= body.length && body.length > 0) {
    res.writeHead(416, { "Content-Range": `bytes */${body.length}` }).end();
    log(req.method, req.url.split("?")[0], `range ${start}-`, "→ 416");
    return;
  }
  let payload = body;
  if (type !== "text/plain" && corruptOnce && start === 0) {
    corruptOnce = false;
    payload = Buffer.from(body);
    payload[payload.length >> 1] ^= 0xff;
    log("serving one wrong byte this time (--corrupt)");
  }
  const headers = { "Content-Type": type, "Content-Length": body.length - start, "Accept-Ranges": "bytes", "Connection": "close" };
  if (range) headers["Content-Range"] = `bytes ${start}-${body.length - 1}/${body.length}`;
  res.writeHead(range ? 206 : 200, headers);
  log(req.method, req.url.split("?")[0], range ? `range ${start}-` : "full", `→ ${range ? 206 : 200}`);
  const cut = dropOnce && type !== "text/plain" && dropAt * body.length > start ? Math.floor(dropAt * body.length) : null;
  const piece = 64 * 1024;
  const pump = () => {
    while (start < body.length) {
      if (cut !== null && start >= cut) {
        dropOnce = false;
        log(`dropping the connection at ${start} bytes (--drop-at)`);
        res.socket?.destroy();
        return;
      }
      const end = Math.min(body.length, start + piece, cut ?? Infinity);
      const ok = res.write(payload.subarray(start, end));
      start = end;
      if (rate) { setTimeout(pump, (piece / rate) * 1000); return; }
      if (!ok) { res.once("drain", pump); return; }
    }
    res.end();
    log("  sent to the end");
  };
  res.on("close", () => { if (start < body.length) log(`  connection closed at ${start} bytes`); });
  pump();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, base);
  if (url.pathname === `/repos${repo}/releases`) {
    log("GET release list");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(releases()));
    return;
  }
  const asset = url.pathname.startsWith(`${repo}/releases/download/v${version}/`) ? url.pathname.split("/").pop() : null;
  if (asset === apkName || asset === "SHA256SUMS.txt") {
    // Like GitHub: a short-lived signed link on another path.
    res.writeHead(302, { Location: `/assets/${asset}?sig=${randomBytes(6).toString("hex")}` }).end();
    log("GET", url.pathname, "→ 302");
    return;
  }
  if (url.pathname === `/assets/${apkName}`) return send(req, res, bytes, "application/vnd.android.package-archive");
  if (url.pathname === "/assets/SHA256SUMS.txt") return send(req, res, Buffer.from(sums), "text/plain");
  log(req.method, url.pathname, "→ 404");
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not here\n");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Update fixture on ${base}: version ${version} (the app is ${current})`);
  console.log(`  package  ${path.resolve(apkPath)} (${bytes.length} bytes)`);
  console.log(`  sha256   ${sha256}${flag("no-digest") ? " (not published as digest)" : ""}`);
  console.log(`  options  ${[flag("sums") && "sums", dropAt !== null && `drop-at ${dropAt}`, flag("corrupt") && "corrupt", rate && `rate ${rate / 1024} KB/s`].filter(Boolean).join(", ") || "none"}`);
  console.log(`Phone: adb reverse tcp:${port} tcp:${port}; then 设置 → 开发者 → 测试更新源 = ${base}`);
});
