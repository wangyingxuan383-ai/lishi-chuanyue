// Probe-only checks. This is not a Pi extension or an application entry point.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const directory = dirname(fileURLToPath(import.meta.url));
const reportPath = join(directory, "..", "runtime-checks.json");
const began = performance.now();
const report = { fixtureOnly: true, realModelRequests: 0, pid: process.pid, node: process.version, checks: {} };
const sockets = new Set();
let secureServer, proxy;
function retain(socket) { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); return socket; }
async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; }
async function direct(port, ca) {
  return new Promise((resolve, reject) => {
    const request = https.get({ host: "127.0.0.1", port, servername: "localhost", ca, rejectUnauthorized: true, timeout: 5000 }, (response) => {
      let body = ""; response.setEncoding("utf8"); response.on("data", (value) => body += value); response.once("end", () => resolve(body));
    });
    request.once("error", reject); request.once("timeout", () => request.destroy(new Error("Owned TLS check timed out")));
  });
}
async function throughProxy(proxyPort, targetPort, ca) {
  const tunnel = retain(net.connect(proxyPort, "127.0.0.1"));
  tunnel.setTimeout(5000, () => tunnel.destroy(new Error("Owned CONNECT check timed out")));
  await once(tunnel, "connect");
  const connected = new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]); const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      tunnel.off("data", onData); tunnel.off("error", reject);
      if (!buffer.subarray(0, end).toString().startsWith("HTTP/1.1 200")) { reject(new Error("Owned CONNECT failed")); return; }
      if (buffer.length > end + 4) tunnel.unshift(buffer.subarray(end + 4));
      resolve();
    }
    tunnel.on("data", onData); tunnel.once("error", reject);
  });
  tunnel.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
  await connected;
  const connection = retain(tls.connect({ socket: tunnel, servername: "localhost", ca, rejectUnauthorized: true }));
  await once(connection, "secureConnect"); assert.equal(connection.authorized, true);
  const result = new Promise((resolve, reject) => { let body = ""; connection.setEncoding("utf8"); connection.on("data", (chunk) => body += chunk); connection.once("end", () => resolve(body)); connection.once("error", reject); });
  connection.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  return result;
}
try {
  const worker = new Worker("const {parentPort} = require('node:worker_threads'); parentPort.once('message', value => parentPort.postMessage(value + 1));", { eval: true });
  const received = once(worker, "message"); worker.postMessage(41); assert.equal((await received)[0], 42); await worker.terminate();
  report.checks.worker = { ok: true, kind: "node:worker_threads", roundTrip: 42 };

  const requireRuntime = createRequire(join(directory, "..", "runtime", "package.json"));
  const photon = requireRuntime("@silvia-odwyer/photon-node");
  const image = new photon.PhotonImage(new Uint8Array([1, 2, 3, 255]), 1, 1);
  assert.equal(image.get_width(), 1); assert.equal(image.get_height(), 1); assert.deepEqual(Array.from(image.get_raw_pixels()), [1, 2, 3, 255]); image.free();
  report.checks.wasm = { ok: true, package: "@silvia-odwyer/photon-node", actualPixels: 1 };

  const cert = await readFile(join(directory, "tls-cert.pem")); const key = await readFile(join(directory, "tls-key.pem"));
  secureServer = https.createServer({ cert, key }, (_, response) => response.end("owned-tls-ok"));
  secureServer.on("connection", retain); const securePort = await listen(secureServer);
  assert.equal(await direct(securePort, cert), "owned-tls-ok");
  report.checks.tls = { ok: true, certificateVerified: true, scope: "owned localhost certificate only" };
  let connects = 0;
  proxy = net.createServer((client) => {
    retain(client); let header = "";
    function connect(chunk) {
      header += chunk.toString("ascii"); if (header.length > 8192) { client.destroy(); return; }
      if (!header.includes("\r\n\r\n")) return;
      client.off("data", connect);
      if (!header.startsWith(`CONNECT 127.0.0.1:${securePort} HTTP/1.1\r\n`)) { client.destroy(); return; }
      const upstream = retain(net.connect(securePort, "127.0.0.1", () => { connects++; client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); client.pipe(upstream); upstream.pipe(client); }));
      upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
    }
    client.on("data", connect); client.on("error", () => {});
  });
  const proxyPort = await listen(proxy); assert.match(await throughProxy(proxyPort, securePort, cert), /owned-tls-ok/); assert.equal(connects, 1);
  report.checks.proxy = { ok: true, mode: "owned HTTP CONNECT + verified TLS", connects, externalServicesTested: false };
  report.ok = true;
} catch (error) {
  report.ok = false; report.error = `${error.name}: ${error.message}`;
} finally {
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  if (secureServer) await new Promise((resolve) => secureServer.close(resolve));
  report.elapsedMs = Math.round(performance.now() - began);
  try { report.vmHwm = (await readFile("/proc/self/status", "utf8")).match(/^VmHWM:\s*(.+)$/m)?.[1] ?? null; } catch { report.vmHwm = null; }
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}
if (!report.ok) throw new Error("Owned native runtime check failed; inspect runtime-checks.json");
await import("../runtime/host/src/entry.mjs");
