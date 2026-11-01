// Fetch and build the approved complete Pi SDK. Never uses the same-version
// registry release as a substitute for the pinned source commit.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { assembleRuntime } from "./assemble-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const host = path.join(root, "agent-host");
const lock = JSON.parse(await fs.readFile(path.join(host, "upstream-lock.json"), "utf8"));
const cache = path.join(host, ".cache/upstream");
const source = path.join(cache, lock.sourceDirectory);
const hash = (value) => createHash("sha256").update(value).digest("hex");
await fs.mkdir(cache, { recursive: true });
if (process.version !== `v${lock.nodeVersion}`) throw new Error(`Use Node ${lock.nodeVersion}; found ${process.version}`);

async function download(spec, target) {
  try {
    const existing = await fs.readFile(target);
    if (hash(existing) !== spec.sha256) throw new Error(`Cached integrity mismatch: ${path.basename(target)}`);
    return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let content;
  try {
    const response = await fetch(spec.url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
    content = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // Windows' native HTTPS path can use a configured system proxy when Node's
    // direct connection cannot. No proxy value, header or credential is printed.
    if (process.platform !== "win32") throw error;
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const temporary = `${target}.download`;
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri ${quote(spec.url)} -OutFile ${quote(temporary)} -TimeoutSec 40`],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 45_000 });
      content = await fs.readFile(temporary);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  if (hash(content) !== spec.sha256) throw new Error(`Downloaded integrity mismatch: ${path.basename(target)}`);
  await fs.writeFile(target, content);
  return content;
}

await download(lock.archive, path.join(cache, "pi-973b74c.tar.gz"));
try { await fs.access(source); } catch {
  const python = process.platform === "win32" ? "python" : "python3";
  // Reject links and path escapes; extract only into this dedicated cache.
  const program = `import pathlib,tarfile,sys\nr=pathlib.Path(sys.argv[1]).resolve()\nwith tarfile.open(r/'pi-973b74c.tar.gz','r:gz') as t:\n for m in t.getmembers():\n  if not (r/m.name).resolve().is_relative_to(r) or m.issym() or m.islnk(): raise RuntimeError('Unsafe source archive')\n t.extractall(r,filter='data')\n`;
  execFileSync(python, ["-c", program, cache], { stdio: "inherit" });
}
for (const [name, expected] of [["package-lock.json", lock.sourceNpmLockSha256], ["packages/coding-agent/package.json", lock.sourcePackageSha256]]) {
  if (hash(await fs.readFile(path.join(source, name))) !== expected) throw new Error(`Pinned source mismatch: ${name}`);
}
// A manifest hash alone cannot prove all build inputs are from this snapshot.
// Compare every original archive file before running any upstream build script.
const verifySource = `import pathlib,tarfile,sys,hashlib\nr=pathlib.Path(sys.argv[1]).resolve()\nwith tarfile.open(sys.argv[2],'r:gz') as t:\n for m in t.getmembers():\n  if not m.isfile(): continue\n  relative=pathlib.PurePosixPath(m.name).parts[1:]\n  p=r.joinpath(*relative)\n  if not p.is_file() or hashlib.sha256(p.read_bytes()).digest()!=hashlib.sha256(t.extractfile(m).read()).digest(): raise RuntimeError('Pinned source file differs: '+str(pathlib.Path(*relative)))\n`;
execFileSync(process.platform === "win32" ? "python" : "python3", ["-c", verifySource, source, path.join(cache, "pi-973b74c.tar.gz")], { stdio: "inherit" });
const packageJson = JSON.parse(await fs.readFile(path.join(source, "packages/coding-agent/package.json"), "utf8"));
if (packageJson.version !== lock.codingAgentVersion) throw new Error("Pi source version mismatch");
const catalog = path.join(cache, "models.all.json");
await download(lock.modelCatalog, catalog);
const receipt = {
  commit: lock.commit, codingAgentVersion: packageJson.version, nodeVersion: process.version,
  archiveSha256: lock.archive.sha256, npmLockSha256: lock.sourceNpmLockSha256,
  catalogSha256: lock.modelCatalog.sha256, source, verifiedAt: new Date().toISOString(), sourceTreeVerified: true, built: false,
};
if (process.argv.includes("--build")) {
  const npm = (args) => process.platform === "win32"
    ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd: source, stdio: "inherit" })
    : execFileSync("npm", args, { cwd: source, stdio: "inherit" });
  npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  execFileSync(process.execPath, ["packages/ai/scripts/hydrate-model-catalog.ts", catalog], { cwd: source, stdio: "inherit" });
  npm(["run", "build:offline"]);
  receipt.built = true;
  receipt.runtime = await assembleRuntime(source, lock, receipt);
}
await fs.writeFile(path.join(cache, "source-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ ...receipt, source: path.relative(root, source) }));
