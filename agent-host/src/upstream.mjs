import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyRuntime } from "./artifacts.mjs";

const hostRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await fs.readFile(path.join(hostRoot, "upstream-lock.json"), "utf8"));
export const UPSTREAM = Object.freeze({ commit: lock.commit, version: lock.codingAgentVersion, node: lock.nodeVersion });

export async function loadPiSdk() {
  if (process.version !== `v${lock.nodeVersion}`) throw new Error(`Node ${lock.nodeVersion} is required`);
  // These are process-local Pi controls, never system configuration. LLM calls
  // remain enabled; catalog refresh and install telemetry do not.
  process.env.PI_OFFLINE = "1";
  process.env.PI_TELEMETRY = "0";
  const packagedDirectory = path.dirname(hostRoot);
  const isPackaged = await fs.access(path.join(packagedDirectory, "manifest.json")).then(() => true, () => false);
  const directory = path.resolve(process.env.LISHI_PI_RUNTIME_DIR ?? (isPackaged ? packagedDirectory : path.join(hostRoot, ".cache/runtime")));
  await verifyRuntime(directory, lock);
  const [sdk, ai] = await Promise.all([
    import(pathToFileURL(path.join(directory, "pi/dist/bundle/index.js")).href),
    import(pathToFileURL(path.join(directory, "memory-credentials.mjs")).href),
  ]);
  return { ...sdk, InMemoryCredentialStore: ai.InMemoryCredentialStore };
}
