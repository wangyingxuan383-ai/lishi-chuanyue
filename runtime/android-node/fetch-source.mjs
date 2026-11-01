// Download only the locked, official build inputs. Never installs or executes them.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const directory = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(await fsp.readFile(path.join(directory, "sources.lock.json"), "utf8"));
const args = process.argv.slice(2);
if (args.some((a) => !["--ndk", "--help"].includes(a))) throw new Error("Use --ndk to additionally download the fixed Linux NDK");
if (args.includes("--help")) {
  console.log("node runtime/android-node/fetch-source.mjs [--ndk]\nDownloads and verifies fixed sources into the ignored build cache. No extraction, installation or compilation.");
  process.exit(0);
}
const cache = path.resolve(directory, "../../.cache/r19/android-node/downloads");
await fsp.mkdir(cache, { recursive: true });
const result = { version: lock.node.version, fetchedAt: new Date().toISOString(), inputs: [], compiled: false, installed: false };
async function digest(file, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function download(input, algorithm) {
  const target = path.join(cache, input.file);
  const expected = input[algorithm];
  let reused = false;
  try {
    const stat = await fsp.stat(target);
    if (input.bytes && stat.size !== input.bytes) throw new Error("size mismatch");
    if (await digest(target, algorithm) !== expected || input.sha256 && await digest(target, "sha256") !== input.sha256) throw new Error("checksum mismatch");
    reused = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Existing ${input.file} is invalid: ${error.message}; it was not overwritten`);
  }
  if (!reused) {
    const response = await fetch(input.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`${input.file}: HTTP ${response.status}`);
    const temporary = `${target}.${randomUUID()}.part`;
    const hash = createHash(algorithm);
    let bytes = 0;
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _, next) {
      bytes += chunk.length;
      if (bytes > (input.bytes ?? 256 * 1024 * 1024)) return next(new Error("Download exceeded expected size"));
      hash.update(chunk); next(null, chunk);
    } }), fs.createWriteStream(temporary, { flags: "wx" }));
    if (hash.digest("hex") !== expected || input.bytes && bytes !== input.bytes) throw new Error(`Downloaded ${input.file} failed integrity verification; retained .part file`);
    if (input.sha256 && await digest(temporary, "sha256") !== input.sha256) throw new Error(`Downloaded ${input.file} differs from locked SHA-256; retained .part file`);
    await fsp.rename(temporary, target);
  }
  result.inputs.push({ file: input.file, url: input.url, bytes: (await fsp.stat(target)).size, expectedAlgorithm: algorithm, expected, sha256: await digest(target, "sha256"), verified: true, reused });
}
const sums = await fetch(lock.node.checksumsUrl, { signal: AbortSignal.timeout(30_000) });
if (!sums.ok) throw new Error(`Node checksums: HTTP ${sums.status}`);
const checksumText = await sums.text();
const declared = checksumText.split(/\r?\n/).find((line) => line.endsWith(`  ${lock.node.file}`));
if (declared !== `${lock.node.sha256}  ${lock.node.file}`) throw new Error("Published Node checksum differs from the approved lock");
await download(lock.node, "sha256");
if (args.includes("--ndk")) await download(lock.ndk, "sha1");
await fsp.writeFile(path.join(cache, "verified-inputs.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
