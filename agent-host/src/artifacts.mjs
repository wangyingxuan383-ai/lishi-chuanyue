import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function artifactFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Runtime artifacts must not contain symbolic links");
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await artifactFiles(directory, name));
    else if (entry.isFile() && name !== "manifest.json") result.push(name);
    else if (!entry.isFile()) throw new Error("Unexpected runtime artifact type");
  }
  return result.sort();
}

export async function verifyRuntime(directory, lock) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.built !== true || manifest.fullCodingAgent !== true
    || manifest.commit !== lock.commit || manifest.codingAgentVersion !== lock.codingAgentVersion
    || manifest.nodeVersion !== lock.nodeVersion || manifest.sourceArchiveSha256 !== lock.archive.sha256
    || manifest.sourceNpmLockSha256 !== lock.sourceNpmLockSha256 || manifest.modelCatalogSha256 !== lock.modelCatalog.sha256) {
    throw new Error("Pi runtime build receipt does not match the approved source lock");
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Pi runtime has no artifact manifest");
  const names = await artifactFiles(directory);
  if (JSON.stringify(names) !== JSON.stringify(manifest.files.map((item) => item.path))) throw new Error("Pi runtime artifact list changed");
  for (const item of manifest.files) {
    if (item.path.startsWith("/") || item.path.includes("\\") || item.path.split("/").some((part) => part === ".." || part === ".")) throw new Error("Invalid runtime artifact path");
    const bytes = await fs.readFile(path.join(directory, item.path));
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`Pi runtime artifact checksum mismatch: ${item.path}`);
  }
  for (const required of ["pi/dist/bundle/index.js", "memory-credentials.mjs", "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", "node_modules/jiti/package.json", "host/src/entry.mjs", "host/src/document-parser.mjs", "host/src/document-worker.mjs", "host/upstream-lock.json", "notices/dependencies.json"]) {
    if (!names.includes(required)) throw new Error(`Required Pi runtime resource is absent: ${required}`);
  }
  return manifest;
}
