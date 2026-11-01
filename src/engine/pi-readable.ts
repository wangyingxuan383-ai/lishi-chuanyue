// Readable data only: never import an executable Pi transcript or connection.
import type { PiReadableArchive } from "./archive";

const fields = (raw: any, keys: string[], cap = 16000): any => Object.fromEntries(keys.flatMap(key => typeof raw?.[key] === "string" ? [[key, raw[key].slice(0, cap)]] : []));
export function cleanSource(raw: any): any {
  const out = fields(raw, ["findingId", "goalId", "topic", "groupId", "basis", "title", "quote", "text", "bookId", "sourceKind", "scope", "playerReferenceId", "evidenceId", "subject", "value", "sourceClaim", "contentHash", "readAt"]);
  for (const key of ["page", "section", "chunk", "offset", "start", "end", "quoteOffset"]) if (Number.isSafeInteger(raw?.[key]) && raw[key] >= 0) out[key] = raw[key];
  if (raw?.location) out.location = { ...fields(raw.location, ["bookId", "nodeId", "lineId", "title", "path", "offsetUnit", "contentHash", "readAt"]), ...Object.fromEntries(["page", "section", "chunk", "offset", "start", "end"].flatMap(k => Number.isSafeInteger(raw.location[k]) && raw.location[k] >= 0 ? [[k, raw.location[k]]] : [])) };
  if (raw?.location && typeof raw.location.url === "string") {
    const link = cleanSource({ url: raw.location.url }).url;
    if (link) out.location.url = link;
  }
  if (raw?.revisionDecision) {
    out.revisionDecision = fields(raw.revisionDecision, ["summary", "reason", "appliesTo"]);
    if (Array.isArray(raw.revisionDecision.localReferences)) out.revisionDecision.localReferences = raw.revisionDecision.localReferences.slice(0, 12).map(cleanSource);
  }
  if (raw?.declaration) out.declaration = fields(raw.declaration, ["subject", "value", "scope"]);
  if (Array.isArray(raw?.references)) out.references = raw.references.slice(0, 100).map(cleanSource);
  out.interpretationVerified = false;
  if (typeof raw?.url === "string") {
    try { const url = new URL(raw.url); if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) { url.hash = ""; for (const key of [...url.searchParams.keys()]) if (/key|token|secret|password|auth|sig|credential/i.test(key)) url.searchParams.delete(key); out.url = url.href; } } catch { /* Invalid links are not citations. */ }
  }
  return out;
}

export function cleanReadablePi(raw: PiReadableArchive): PiReadableArchive {
  return { engine: "pi", version: 1, readOnly: true,
    sessions: raw.sessions.map(s => fields(s, ["id", "worldId", "lineId", "title", "createdAt", "updatedAt"])),
    tasks: raw.tasks.map(t => {
      const h: any = t.history;
      return { ...fields(t, ["id", "sessionId", "text", "policy", "createdAt", "updatedAt"]), status: "archived", history: {
        messages: Array.isArray(h?.messages) ? h.messages.slice(0, 500).filter((m: any) => ["user", "assistant"].includes(m?.role)).map((m: any) => fields(m, ["id", "role", "content", "at"])) : [],
        steps: Array.isArray(h?.steps) ? h.steps.slice(0, 1000).map((s: any) => ({ ...fields(s, ["id", "tool", "action", "object", "status", "outcome", "summary", "resultText"]), ...(Number.isSafeInteger(s.seq) ? { seq: s.seq } : {}) })) : [],
        plan: Array.isArray(h?.plan) ? h.plan.slice(0, 1000).map((s: any) => fields(s, ["id", "title", "status"])) : [],
        sources: Array.isArray(h?.sources) ? h.sources.slice(0, 100).map(cleanSource) : [],
        result: { ...fields(h?.result, ["status", "summary", "goalStatus"]), ...(typeof h?.result?.changed === "boolean" ? { changed: h.result.changed } : {}) }, truncated: h?.truncated === true,
      } };
    }),
  };
}
