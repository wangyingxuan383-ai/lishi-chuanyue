// Browser dev console on 127.0.0.1:1421 with its own store and secrets, for
// UI scripts: never touches .cache/dev-host (your own dev saves and services).
//   node scripts/ui/dev-isolated.mjs [--fresh] [--port 1421] [--store .cache/ui-isolated] [--allow-remote]
// --fresh deletes the store first. Needs cargo on PATH (it builds
// story-dev-host on first use). Without --allow-remote the dev bridge may only
// reach this machine; the store's own fake-secrets.json is the only key file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(root);
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const port = Number(option("--port", "1421"));
const relative = option("--store", ".cache/ui-isolated");
if (!relative.startsWith(".cache/")) throw new Error("--store must be under .cache/");
const store = path.join(root, relative);
if (process.argv.includes("--fresh")) fs.rmSync(store, { recursive: true, force: true });
fs.mkdirSync(store, { recursive: true });
process.env.LISHI_DEV_DATABASE_DIR = relative;
process.env.LISHI_DEV_SECRETS_FILE = path.join(store, "fake-secrets.json");
delete process.env.DEV_LLM_BASE_URL; delete process.env.DEV_LLM_KEY; delete process.env.DEV_LLM_MODEL;

// The dev bridge must not reach off this machine during UI checks.
const fetchLocal = globalThis.fetch;
if (!process.argv.includes("--allow-remote")) globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return Promise.reject(new Error("UI checks: off-machine requests are disabled"));
  return fetchLocal(input, options);
};

const { createServer } = await import("vite");
const marker = { name: "ui-isolation", configureServer(server) { server.middlewares.use("/__ui-isolation", (_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ databaseDir: relative, secretsFile: `${relative}/fake-secrets.json`, port, loopbackOnly: !process.argv.includes("--allow-remote") }));
}); } };
const server = await createServer({ plugins: [marker], server: { host: "127.0.0.1", port, strictPort: true } });
await server.listen();
server.printUrls();
