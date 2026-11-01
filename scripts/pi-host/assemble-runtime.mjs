// Package the upstream's complete official bundle, without replacing its loop.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { artifactFiles, sha256, verifyRuntime } from "../../agent-host/src/artifacts.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const host = path.join(project, "agent-host");

export async function assembleRuntime(source, lock, sourceReceipt) {
  if (!sourceReceipt.built || sourceReceipt.commit !== lock.commit || sourceReceipt.sourceTreeVerified !== true) throw new Error("Build the verified pinned source before packaging its runtime");
  const directory = path.join(host, ".cache/runtime");
  const temporary = await fs.mkdtemp(path.join(host, ".cache/runtime-build-"));
  const copy = async (relativeSource, relativeTarget) => fs.cp(path.join(source, relativeSource), path.join(temporary, relativeTarget), { recursive: true, dereference: true });
  await fs.mkdir(path.join(temporary, "pi/dist"), { recursive: true });
  for (const name of ["package.json", "README.md", "CHANGELOG.md"]) await copy(`packages/coding-agent/${name}`, `pi/${name}`);
  await copy("LICENSE", "pi/LICENSE");
  await copy("packages/coding-agent/dist/bundle", "pi/dist/bundle");
  for (const resource of ["modes/interactive/theme", "modes/interactive/assets", "core/export-html"]) await copy(`packages/coding-agent/dist/${resource}`, `pi/dist/${resource}`);
  for (const dependency of ["@silvia-odwyer/photon-node", "jiti"]) await copy(`node_modules/${dependency}`, `node_modules/${dependency}`);
  await fs.cp(path.join(host, "src"), path.join(temporary, "host/src"), { recursive: true });
  await fs.copyFile(path.join(host, "upstream-lock.json"), path.join(temporary, "host/upstream-lock.json"));
  await fs.copyFile(path.join(host, "THIRD_PARTY_NOTICES.md"), path.join(temporary, "THIRD_PARTY_NOTICES.md"));
  // Keep notices from bundled dependencies as well as the two external ones.
  const dependencyNotices = [];
  const visitDependencies = async (nodeModules) => {
    for (const entry of await fs.readdir(nodeModules, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const packageRoot = path.join(nodeModules, entry.name);
      if (entry.name.startsWith("@") && entry.isDirectory()) { await visitDependencies(packageRoot); continue; }
      if (!entry.isDirectory()) continue;
      let pkg;
      try { pkg = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")); } catch { continue; }
      const target = path.join("notices/dependencies", `${pkg.name}@${pkg.version}`);
      dependencyNotices.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? "SEE PACKAGE NOTICES" });
      for (const item of await fs.readdir(packageRoot, { withFileTypes: true })) {
        if (item.isFile() && /^(?:licen[sc]e|notice|copying|copyright)(?:[.\-_]|$)/i.test(item.name)) {
          await fs.mkdir(path.join(temporary, target), { recursive: true });
          await fs.copyFile(path.join(packageRoot, item.name), path.join(temporary, target, item.name));
        }
      }
    }
  };
  await visitDependencies(path.join(source, "node_modules"));
  await fs.mkdir(path.join(temporary, "notices"), { recursive: true });
  await fs.writeFile(path.join(temporary, "notices/dependencies.json"), JSON.stringify(dependencyNotices.sort((a, b) => a.name.localeCompare(b.name)), null, 2) + "\n");
  await fs.writeFile(path.join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }) + "\n");
  const { build } = await import(pathToFileURL(path.join(source, "node_modules/esbuild/lib/main.js")).href);
  // Exactly the same text/EPUB/DOCX parser used by the existing import flow.
  // It runs in a bounded worker and has no database or model dependencies.
  const parserBuild=await build({ absWorkingDir:project,entryPoints:[path.join(project,"src/engine/sources/parse.ts")], bundle:true,
    format:"esm",platform:"node",target:"node24.19",legalComments:"inline",
    outfile:path.join(temporary,"host/src/document-parser.mjs"),logLevel:"silent",metafile:true });
  // Preserve the exact notices of libraries bundled from the APP lockfile,
  // including transitive XML dependencies; these are not Pi's dependencies.
  const parserPackages=new Set();
  for(const input of Object.keys(parserBuild.metafile.inputs)){
    if(!input.includes("node_modules"))continue;
    let directory=path.dirname(await fs.realpath(path.resolve(project,input)));
    for(let depth=0;depth<10;depth++){
      let pkg;try{pkg=JSON.parse(await fs.readFile(path.join(directory,"package.json"),"utf8"));}catch{}
      if(pkg?.name){
        const id=`${pkg.name}@${pkg.version}`;
        if(!parserPackages.has(id)){
          parserPackages.add(id);
          if(!dependencyNotices.some(item=>item.name===pkg.name&&item.version===pkg.version))dependencyNotices.push({name:pkg.name,version:pkg.version,license:pkg.license??"SEE PACKAGE NOTICES"});
          const target=path.join(temporary,"notices/dependencies",id);await fs.mkdir(target,{recursive:true});
          for(const item of await fs.readdir(directory,{withFileTypes:true})){if(item.isFile()&&/^(?:licen[sc]e|notice|copying|copyright)(?:[.\-_]|$)/i.test(item.name))await fs.copyFile(path.join(directory,item.name),path.join(target,item.name));}
        }
        break;
      }
      const parent=path.dirname(directory);if(parent===directory)throw new Error("Parser dependency notice is missing");directory=parent;
    }
  }
  await fs.writeFile(path.join(temporary,"notices/dependencies.json"),JSON.stringify(dependencyNotices.sort((a,b)=>a.name.localeCompare(b.name)),null,2)+"\n");
  // This tiny public credential-store export is from the same source snapshot.
  // The full AgentSession implementation is the unmodified official bundle.
  await build({
    stdin: { contents: 'export { InMemoryCredentialStore } from "./packages/ai/dist/index.js";', resolveDir: source, sourcefile: "lishi-memory-credentials.mjs" },
    bundle: true, format: "esm", platform: "node", target: "node24.19", legalComments: "inline",
    outfile: path.join(temporary, "memory-credentials.mjs"), logLevel: "silent",
  });
  const files = [];
  for (const name of await artifactFiles(temporary)) {
    const bytes = await fs.readFile(path.join(temporary, name));
    files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = {
    schemaVersion: 1, built: true, fullCodingAgent: true,
    commit: lock.commit, codingAgentVersion: lock.codingAgentVersion, nodeVersion: lock.nodeVersion,
    sourceArchiveSha256: lock.archive.sha256, sourceNpmLockSha256: lock.sourceNpmLockSha256,
    modelCatalogSha256: lock.modelCatalog.sha256, builtAt: sourceReceipt.verifiedAt, files,
  };
  await fs.writeFile(path.join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await verifyRuntime(temporary, lock);
  if (path.dirname(directory) !== path.join(host, ".cache")) throw new Error("Unexpected runtime build directory");
  // This exact build-owned directory contains no personal saves or credentials.
  await fs.rm(directory, { recursive: true, force: true });
  await fs.rename(temporary, directory);
  return { directory, files: files.length, bytes: files.reduce((sum, item) => sum + item.bytes, 0), manifestSha256: sha256(await fs.readFile(path.join(directory, "manifest.json"))) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(await fs.readFile(path.join(host, "upstream-lock.json"), "utf8"));
  const source = path.join(host, ".cache/upstream", lock.sourceDirectory);
  const receipt = JSON.parse(await fs.readFile(path.join(host, ".cache/upstream/source-receipt.json"), "utf8"));
  receipt.runtime = await assembleRuntime(source, lock, receipt);
  await fs.writeFile(path.join(host, ".cache/upstream/source-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt.runtime));
}
