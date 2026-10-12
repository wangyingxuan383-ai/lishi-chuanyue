// Checks durable project context, never reads credentials or runtime saves.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docFiles = ["AGENTS.md", "README.md", "CHANGELOG.md"];
function collect(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(relative);
    else if (entry.isFile() && entry.name.endsWith(".md")) docFiles.push(relative);
  }
}
collect("docs");
const failures = [];
const contents = new Map();
const decoder = new TextDecoder("utf-8", { fatal: true });
function read(relative) {
  const absolute = path.resolve(root, relative);
  if (contents.has(absolute)) return contents.get(absolute);
  try {
    const text = decoder.decode(fs.readFileSync(absolute));
    contents.set(absolute, text);
    return text;
  } catch { failures.push(`Unreadable UTF-8 file: ${relative}`); return ""; }
}
function slug(text) {
  return text.toLowerCase().replace(/[`*_]/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}
function anchors(text) {
  const used = new Map();
  const result = new Set();
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const match = /^#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line);
    if (!match) continue;
    const base = slug(match[1]);
    const count = used.get(base) ?? 0;
    result.add(base + (count ? `-${count}` : ""));
    used.set(base, count + 1);
  }
  return result;
}
let linkCount = 0;
for (const relative of docFiles) {
  const text = read(relative);
  if (text.includes("\uFFFD")) failures.push(`Replacement character: ${relative}`);
  const fences = text.split(/\r?\n/).filter(line => /^\s*```/.test(line)).length;
  if (fences % 2) failures.push(`Unbalanced code fence: ${relative}`);
  const withoutCode = text.replace(/```[\s\S]*?```/g, "");
  for (const match of withoutCode.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].replace(/^<|>$/g, "");
    if (/^[a-z][a-z\d+.-]*:/i.test(raw)) continue;
    linkCount++;
    const [pathname, fragment] = raw.split("#");
    let resolved;
    try { resolved = path.resolve(path.dirname(path.join(root, relative)), decodeURIComponent(pathname)); }
    catch { failures.push(`Invalid relative link: ${relative}`); continue; }
    if (!fs.existsSync(resolved)) { failures.push(`Missing link: ${relative} -> ${raw}`); continue; }
    if (fragment && resolved.endsWith(".md") && !anchors(read(path.relative(root, resolved))).has(decodeURIComponent(fragment))) {
      failures.push(`Missing anchor: ${relative} -> ${raw}`);
    }
  }
}
const tasks = read("docs/TASKS.md");
const decisions = read("docs/DECISIONS.md");
const taskIds = new Set();
const dependencies = new Map();
const decisionIds = new Set([...decisions.matchAll(/^### ([DV]\d{3})\b/gm)].map(match => match[1]));
const states = new Set(["待开始", "进行中", "待验收", "已完成", "受阻", "已取消"]);
const required = ["目标/交付", "依赖", "状态", "负责人/范围", "验收", "实际成果", "证据", "阻塞", "更新时间", "完成时间", "关联决策"];
for (const match of tasks.matchAll(/^### (M\d{2}-T\d{3}) ([^\r\n]+)\r?\n([\s\S]*?)(?=^### |^## |$(?![\s\S]))/gm)) {
  const [, id, , block] = match;
  if (taskIds.has(id)) failures.push(`Duplicate task: ${id}`);
  taskIds.add(id);
  for (const field of required) if (!block.includes(`- ${field}：`)) failures.push(`Missing field: ${id}/${field}`);
  const state = /^- 状态：([^。\r\n]+)/m.exec(block)?.[1];
  if (!states.has(state)) failures.push(`Invalid task state: ${id}`);
  const dependencyText = /^- 依赖：(.+)$/m.exec(block)?.[1] ?? "";
  dependencies.set(id, [...dependencyText.matchAll(/M\d{2}-T\d{3}/g)].map(item => item[0]));
  const related = /^- 关联决策：(.+)$/m.exec(block)?.[1] ?? "";
  for (const item of related.matchAll(/[DV]\d{3}/g)) if (!decisionIds.has(item[0])) failures.push(`Unknown decision: ${id}/${item[0]}`);
  if (state === "已完成" && /^- 完成时间：[—-]/m.test(block)) failures.push(`Completed task lacks date: ${id}`);
}
if (!taskIds.size) failures.push("No task records parsed");
const visiting = new Set(), visited = new Set();
function visit(id) {
  if (visiting.has(id)) { failures.push(`Dependency cycle: ${id}`); return; }
  if (visited.has(id)) return;
  visiting.add(id);
  for (const dependency of dependencies.get(id) ?? []) {
    if (!taskIds.has(dependency)) failures.push(`Unknown dependency: ${id}/${dependency}`);
    else visit(dependency);
  }
  visiting.delete(id); visited.add(id);
}
for (const id of taskIds) visit(id);
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`Document checks passed: ${docFiles.length} Markdown files, ${linkCount} relative links, ${taskIds.size} tasks, ${decisionIds.size} decisions; dependencies acyclic.`);
}
