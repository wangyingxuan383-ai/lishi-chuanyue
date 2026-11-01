// Assemble the complete pinned desktop runtime from verified public build inputs.
// No application data, credentials, downloaded extensions or development caches are copied.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { sha256, verifyRuntime } from "../../agent-host/src/artifacts.mjs";
const run=promisify(execFile),project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const options=new Map();for(let i=2;i<process.argv.length;i+=2){if(!["--node-archive","--checksums","--runtime","--output"].includes(process.argv[i])||!process.argv[i+1]||options.has(process.argv[i]))throw Error("Use distinct --name value arguments");options.set(process.argv[i],process.argv[i+1]);}
const input=name=>{const value=options.get(name);if(!value||!path.isAbsolute(value))throw Error(`${name} must be an absolute path`);return value;};
const lock=JSON.parse(await fs.readFile(path.join(project,"agent-host/upstream-lock.json"),"utf8")),name=`node-v${lock.nodeVersion}-win-x64.zip`;
const archive=await fs.readFile(input("--node-archive")),checksums=await fs.readFile(input("--checksums"),"utf8");
const checksum=checksums.split(/\r?\n/).map(line=>line.trim().split(/\s+/)).find(row=>row[1]===name)?.[0];
if(!/^[a-f0-9]{64}$/.test(checksum??"")||sha256(archive)!==checksum)throw Error("Windows Node archive differs from the official version checksum");
const runtime=options.get("--runtime")??path.join(project,"agent-host/.cache/runtime");await verifyRuntime(runtime,lock);
const output=path.resolve(options.get("--output")??path.join(project,".cache/pi-windows"));
await fs.mkdir(output); // Refuse to replace an existing artifact tree.
const prefix=`node-v${lock.nodeVersion}-win-x64/`,selected=unzipSync(archive,{filter:file=>[prefix+"node.exe",prefix+"LICENSE"].includes(file.name)});
for(const name of ["node.exe","LICENSE"])if(!selected[prefix+name]?.length)throw Error("Official Node runtime/license is missing");
const nodeDir=path.join(output,"agent/node");await fs.mkdir(nodeDir,{recursive:true});for(const name of ["node.exe","LICENSE"])await fs.writeFile(path.join(nodeDir,name),selected[prefix+name]);
const node=path.join(nodeDir,"node.exe");const version=await run(node,["--version"],{windowsHide:true});if(version.stdout.trim()!==`v${lock.nodeVersion}`)throw Error("Windows Node version differs from the pinned runtime");
await fs.cp(runtime,path.join(output,"agent/runtime"),{recursive:true});const receipt=await verifyRuntime(path.join(output,"agent/runtime"),lock);
await fs.writeFile(path.join(output,"receipt.json"),JSON.stringify({version:lock.nodeVersion,archiveSha256:checksum,nodeSha256:sha256(selected[prefix+"node.exe"]),piCommit:lock.commit,files:receipt.files.length},null,2)+"\n");
console.log(JSON.stringify({ready:true,nodeVersion:lock.nodeVersion,piCommit:lock.commit,files:receipt.files.length}));
