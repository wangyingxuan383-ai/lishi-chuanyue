// Conversation branching delegates file/context construction to the pinned Pi
// SessionManager. This adapter only validates the native-selected boundary.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadPiSdk } from "./upstream.mjs";

const invalid = (message, code = "invalid_fork") => Object.assign(new Error(message), { code });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function absolute(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") || value.split(/[\\/]/u).includes("..")) {
    throw invalid("Session paths must be absolute and cannot contain parent traversal", "invalid_session_path");
  }
  return path.resolve(value);
}

// Check each ancestor, rather than realpath alone: resolving a symlink would
// make a disallowed path look like a harmless canonical path.
async function noLinks(value) {
  const root = path.parse(value).root;
  const pieces = value.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;
  let stat = await fs.lstat(cursor);
  if (stat.isSymbolicLink()) throw invalid("Session paths cannot contain links", "invalid_session_path");
  for (const piece of pieces) {
    cursor = path.join(cursor, piece);
    stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw invalid("Session paths cannot contain links", "invalid_session_path");
  }
  return stat;
}

function inspectFile(bytes) {
  if (bytes.length > 256 * 1024 * 1024) throw invalid("Session file is too large");
  let rows;
  try { rows = bytes.toString("utf8").split(/\r?\n/u).filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { throw invalid("Session file is not valid JSONL"); }
  const header = rows[0];
  // Opening an older Pi file can rewrite it through an automatic migration.
  if (header?.type !== "session" || header.version !== 3 || typeof header.id !== "string" || !header.id) {
    throw invalid("Only current Pi session version 3 can be branched", "unsupported_session_version");
  }
  const ids = new Set();
  for (const row of rows.slice(1)) {
    if (!row || typeof row !== "object" || row.type === "session" || typeof row.type !== "string" ||
        typeof row.id !== "string" || !row.id || ids.has(row.id) ||
        (row.parentId !== null && (typeof row.parentId !== "string" || !ids.has(row.parentId)))) {
      throw invalid("Session entry identifiers or parent links are invalid");
    }
    ids.add(row.id);
  }
  return rows;
}

const callsIn = entry => entry.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)
  ? entry.message.content.filter(item => item?.type === "toolCall") : [];

function completeBoundary(branch, index) {
  const pending = new Set(), seen = new Set();
  for (const call of callsIn(branch[index])) {
    if (typeof call.id !== "string" || !call.id || pending.has(call.id)) throw invalid("Assistant tool calls have invalid or duplicate identifiers", "incomplete_tool_group");
    pending.add(call.id);
  }
  if (!pending.size) return index;
  let end = index;
  for (let next = index + 1; next < branch.length; next++) {
    const entry = branch[next];
    if (entry.type !== "message") {
      if (pending.size && ["compaction", "branch_summary"].includes(entry.type)) throw invalid("Context checkpoint interrupts a tool group", "incomplete_tool_group");
      if (pending.size) end = next;
      continue;
    }
    if (entry.message?.role !== "toolResult") {
      if (pending.size) throw invalid("Another message interrupts the selected assistant tool group", "incomplete_tool_group");
      break;
    }
    const id = entry.message.toolCallId;
    if (!pending.has(id) || seen.has(id)) throw invalid("Tool group contains an unmatched or duplicate result", "incomplete_tool_group");
    seen.add(id); pending.delete(id); end = next;
  }
  if (pending.size) throw invalid("Selected assistant tool group has missing results", "incomplete_tool_group");
  return end;
}

function validatePrefix(entries) {
  const pending = new Set(), allCalls = new Set();
  for (const entry of entries) {
    if (entry.type !== "message") {
      if (pending.size && ["compaction", "branch_summary"].includes(entry.type)) throw invalid("Context checkpoint interrupts a retained tool group", "incomplete_tool_group");
      continue;
    }
    const message = entry.message;
    if (message?.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) throw invalid("Retained context has an unmatched or duplicate tool result", "incomplete_tool_group");
    } else {
      if (pending.size) throw invalid("Retained context contains an incomplete tool group", "incomplete_tool_group");
      for (const call of callsIn(entry)) {
        if (typeof call.id !== "string" || !call.id || allCalls.has(call.id)) throw invalid("Retained context has duplicate or invalid tool calls", "incomplete_tool_group");
        pending.add(call.id); allCalls.add(call.id);
      }
    }
  }
  if (pending.size) throw invalid("Retained context ends with an incomplete tool group", "incomplete_tool_group");
  return [...allCalls];
}

function userText(message) {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content) ? message.content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
}

/** Branch the active Pi conversation without changing formal story data. */
export async function forkSession({ sourceFile, targetDirectory, entryId }) {
  const source = absolute(sourceFile), target = absolute(targetDirectory);
  if (typeof entryId !== "string" || !entryId) throw invalid("A native-selected message entry is required");
  const sourceStat = await noLinks(source);
  if (!sourceStat.isFile()) throw invalid("Source session must be a regular file", "invalid_session_path");
  const parentStat = await noLinks(path.dirname(target));
  if (!parentStat.isDirectory()) throw invalid("Target parent must be a directory", "invalid_session_path");
  const bytes = await fs.readFile(source);
  inspectFile(bytes);
  const pi = await loadPiSdk();
  // mkdir is deliberately exclusive: never merge into somebody else's folder.
  try { await fs.mkdir(target, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw invalid("Target session directory already exists", "target_exists"); throw error; }
  let sessionFile = null;
  try {
    // The exclusive directory must exist before open(): Pi creates missing
    // session directories itself. Current-version validation above prevents
    // open() from migrating and rewriting the original session.
    const manager = pi.SessionManager.open(source, target, target);
    const branch = manager.getBranch();
    const index = branch.findIndex(entry => entry.id === entryId);
    if (index < 0) throw invalid("The selected message is not on the active branch", "fork_anchor_not_active");
    const selected = branch[index];
    if (selected.type !== "message" || !["user", "assistant"].includes(selected.message?.role)) throw invalid("Only user and assistant messages can anchor a conversation branch");
    const end = selected.message.role === "user" ? index - 1 : completeBoundary(branch, index);
    const kept = branch.slice(0, end + 1);
    const keptToolCallIds = validatePrefix(kept);
    const selectedUserText = selected.message.role === "user" ? userText(selected.message) : null;
    if (digest(await fs.readFile(source)) !== digest(bytes)) throw invalid("Source session changed while preparing the branch", "session_changed");
    const hasConversation = kept.some(entry => entry.type === "message" && ["user", "assistant"].includes(entry.message?.role));
    if (hasConversation) {
      sessionFile = manager.createBranchedSession(kept.at(-1).id);
      if (!sessionFile || !path.isAbsolute(sessionFile) || path.dirname(sessionFile) !== target) throw invalid("Pi did not create an owned branch file");
      await noLinks(sessionFile);
    }
    if (digest(await fs.readFile(source)) !== digest(bytes)) throw invalid("Source session changed during branching", "session_changed");
    return {
      sessionFile,
      piSessionId: sessionFile ? manager.getSessionId() : null,
      selectedUserText,
      keptEntryIds: hasConversation ? manager.getBranch().map(entry => entry.id) : [],
      keptToolCallIds: hasConversation ? keptToolCallIds : [],
    };
  } catch (error) {
    // Only remove the single newly-owned file and empty directory. Never recurse
    // over a path that another process could have replaced.
    if (sessionFile && path.dirname(sessionFile) === target) await fs.unlink(sessionFile).catch(() => {});
    await fs.rmdir(target).catch(() => {});
    throw error;
  }
}
