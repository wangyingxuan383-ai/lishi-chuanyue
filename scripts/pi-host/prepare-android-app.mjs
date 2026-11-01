// Assemble only verified build products; this command never builds or installs an APK.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256, verifyRuntime } from "../../agent-host/src/artifacts.mjs";

const run = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  if (!name.startsWith("--") || !process.argv[i + 1] || options.has(name)) throw new Error("Provide distinct --name value arguments");
  options.set(name, process.argv[i + 1]);
}
for (const name of options.keys()) {
  if (!["--runtime", "--native", "--jni", "--notices", "--readelf", "--output"].includes(name)) throw new Error(`Unknown argument ${name}`);
}
const required = (name) => {
  const value = options.get(name);
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute native build path`);
  return value;
};
const runtime = options.get("--runtime") ?? path.join(project, "agent-host/.cache/runtime");
const native = required("--native");
const jni = required("--jni");
const notices = required("--notices");
const readelf = required("--readelf");
const output = required("--output");
const lock = JSON.parse(await fs.readFile(path.join(project, "agent-host/upstream-lock.json"), "utf8"));
const sources = JSON.parse(await fs.readFile(path.join(project, "runtime/android-node/sources.lock.json"), "utf8"));
await verifyRuntime(runtime, lock);

async function ordinaryFile(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Build inputs must be ordinary files");
  return fs.readFile(file);
}

const libraries = new Map([
  ["libnode.so", path.join(native, "libnode.so")],
  ["liblishi_node_embed.so", path.join(native, "liblishi_node_embed.so")],
  ["libc++_shared.so", path.join(native, "libc++_shared.so")],
  ["liblishi_agent_host.so", jni],
]);
const allowedDependencies = new Set([...libraries.keys(), "libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so"]);
const nativeRecords = [];
for (const [name, source] of libraries) {
  const bytes = await ordinaryFile(source);
  const { stdout: header } = await run(readelf, ["-h", source], { windowsHide: true });
  const { stdout: segments } = await run(readelf, ["-lW", source], { windowsHide: true });
  const { stdout: dynamic } = await run(readelf, ["-dW", source], { windowsHide: true });
  if (!header.includes("ELF64") || !header.includes("AArch64")) throw new Error(`${name} must be ARM64 ELF64`);
  const loads = segments.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts[0] === "LOAD");
  const relro = segments.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts[0] === "GNU_RELRO");
  // NDK r28c's unmodified libc++ uses 16KiB LOADs with a smaller RELRO tail.
  // It already ran in the 16KiB gate; require that exact SDK binary. Our own
  // three linked libraries still require explicitly aligned RELRO ends.
  const sdkLibcxx = name === "libc++_shared.so";
  if (sdkLibcxx && sha256(bytes) !== sources.ndk.arm64LibcxxSha256) throw new Error("libc++ must match the locked NDK r28c ARM64 binary");
  if (!loads.length || loads.some((parts) => BigInt(parts.at(-1)) < 16384n)
    || !relro.length || (!sdkLibcxx && relro.some((parts) => (BigInt(parts[2]) + BigInt(parts[5])) % 16384n !== 0n))) {
    throw new Error(`${name} does not meet the 16KiB ELF alignment gate`);
  }
  const soname = dynamic.match(/SONAME[^\n]*\[([^\]]+)\]/)?.[1];
  if (soname !== name) throw new Error(`${name} has a mismatched SONAME`);
  const dependencies = [...dynamic.matchAll(/NEEDED[^\n]*\[([^\]]+)\]/g)].map((match) => match[1]);
  if (dependencies.some((dependency) => !allowedDependencies.has(dependency))) throw new Error(`${name} has an unpackaged dependency`);
  nativeRecords.push({ path: `jniLibs/arm64-v8a/${name}`, bytes: bytes.length, sha256: sha256(bytes), dependencies,
    sdkLibcxx, relroEnds: relro.map((parts) => `0x${(BigInt(parts[2]) + BigInt(parts[5])).toString(16)}`) });
}

const noticeManifest = JSON.parse(await ordinaryFile(path.join(notices, "manifest.json")));
if (noticeManifest.nodeVersion !== sources.node.version || noticeManifest.nodeArchiveSha256 !== sources.node.sha256
  || noticeManifest.ndkVersion !== sources.ndk.version || noticeManifest.ndkArchiveSha256 !== sources.ndk.sha256) {
  throw new Error("Native notices must match the locked Node/NDK sources");
}
const noticeFiles = noticeManifest.files;
if (!noticeFiles || Array.isArray(noticeFiles) || typeof noticeFiles !== "object" || !Object.keys(noticeFiles).length) throw new Error("Native notices are missing");
const seen = new Set();
for (const [name, item] of Object.entries(noticeFiles)) {
  if (typeof name !== "string" || name.includes("/") || name.includes("\\") || name === "." || name === ".." || seen.has(name)) throw new Error("Invalid native notice path");
  seen.add(name);
  const bytes = await ordinaryFile(path.join(notices, name));
  if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`Native notice changed: ${name}`);
  if (sources.notices[name] && item.sha256 !== sources.notices[name].sha256) throw new Error(`Native notice differs from source lock: ${name}`);
}
for (const name of Object.keys(sources.notices)) if (!seen.has(name)) throw new Error(`Missing source notice: ${name}`);

// Reject an existing directory instead of deleting or replacing arbitrary build paths.
await fs.mkdir(output);
try {
  const assets = path.join(output, "assets");
  await fs.mkdir(assets);
  await fs.cp(runtime, path.join(assets, "pi-runtime"), { recursive: true });
  await verifyRuntime(path.join(assets, "pi-runtime"), lock);
  await fs.mkdir(path.join(assets, "native-notices"));
  for (const name of seen) await fs.copyFile(path.join(notices, name), path.join(assets, "native-notices", name));
  await fs.copyFile(path.join(notices, "manifest.json"), path.join(assets, "native-notices/manifest.json"));
  const destination = path.join(output, "jniLibs/arm64-v8a");
  await fs.mkdir(destination, { recursive: true });
  for (const [name, source] of libraries) {
    await fs.copyFile(source, path.join(destination, name));
    const record = nativeRecords.find((item) => item.path.endsWith(`/${name}`));
    if (sha256(await fs.readFile(path.join(destination, name))) !== record.sha256) throw new Error("Native product changed during copy");
  }
  const receipt = { schema: 1, ready: true, commit: lock.commit, nodeVersion: sources.node.version,
    minSdk: 24, targetSdk: 36, abi: "arm64-v8a", pageSize: 16384, runtimeTested: false,
    manifestSha256: sha256(await fs.readFile(path.join(assets, "pi-runtime/manifest.json"))), libraries: nativeRecords };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ output, ...receipt }));
} catch (error) {
  // An incomplete directory has no ready receipt and is never accepted by Gradle.
  throw error;
}
