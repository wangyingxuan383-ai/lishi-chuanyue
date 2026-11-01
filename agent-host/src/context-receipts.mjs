// A bounded delivery manifest for the final model context. A matching hash says
// only that a tool result was present, never that the model read or verified it.
import { createHash } from "node:crypto";
import { childCallId } from "./children.mjs";

const MAX_DEPTH = 32;
const MAX_STRING_BYTES = 128 * 1024;
const MAX_LEAVES = 4096;
const MAX_CALLS = 2048;
const escapePointer = part => part.replaceAll("~", "~0").replaceAll("/", "~1");

/** SHA-256 of JSON [[pointer,string], ...], sorted by pointer's UTF-8 bytes.
 * Root depth is zero; the byte allowance counts string values, not pointers.
 * Non-string JSON scalars are intentionally absent from the hash.
 */
export function stringLeavesHash(value) {
  const leaves = [];
  let bytes = 0;
  const visit = (current, pointer, depth) => {
    if (depth > MAX_DEPTH) return false;
    if (typeof current === "string") {
      bytes += Buffer.byteLength(current, "utf8");
      if (bytes > MAX_STRING_BYTES || leaves.length >= MAX_LEAVES) return false;
      leaves.push([pointer, current]);
      return true;
    }
    if (current === null || typeof current === "number" || typeof current === "boolean") return true;
    if (!current || typeof current !== "object") return false;
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        if (!visit(current[index], `${pointer}/${index}`, depth + 1)) return false;
      }
      return true;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(current))) return false;
    for (const [key, item] of Object.entries(current)) {
      if (!visit(item, `${pointer}/${escapePointer(key)}`, depth + 1)) return false;
    }
    return true;
  };
  try {
    if (!visit(value, "", 0)) return null;
    leaves.sort((left, right) => Buffer.compare(Buffer.from(left[0], "utf8"), Buffer.from(right[0], "utf8")));
    return createHash("sha256").update(JSON.stringify(leaves), "utf8").digest("hex");
  } catch { return null; }
}

/** Inspect only the actual final tool messages, never UI details or thinking.
 * Duplicates retain the last valid result for each call in the final context.
 */
export function contextReceipts(messages, { actorId } = {}) {
  if (!Array.isArray(messages)) return [];
  const receipts = new Map();
  for (const message of messages) {
    if (message?.role !== "toolResult" || message.isError === true
        || typeof message.toolCallId !== "string" || !message.toolCallId
        || typeof message.toolName !== "string" || !message.toolName
        || !Array.isArray(message.content) || message.content.length !== 1
        || message.content[0]?.type !== "text" || typeof message.content[0].text !== "string") continue;
    const callId = actorId ? childCallId(actorId, message.toolCallId) : message.toolCallId;
    if (!receipts.has(callId) && receipts.size >= MAX_CALLS) continue;
    let value;
    try { value = JSON.parse(message.content[0].text); } catch { continue; }
    if (value && typeof value === "object" && !Array.isArray(value)
        && (value.ok === false || (Object.hasOwn(value, "error") && value.ok !== true))) continue;
    const hash = stringLeavesHash(value);
    if (hash !== null) receipts.set(callId, { callId, hash, tool: message.toolName });
  }
  return [...receipts.values()];
}
