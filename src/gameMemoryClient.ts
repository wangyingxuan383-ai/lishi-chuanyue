import { invoke, isTauri } from "@tauri-apps/api/core";
import type { FactKey, ProviderKind } from "./gameClient";
import { memoryT as t, type MemoryPlainMessageKey } from "./gameMemoryMessages";

export interface MemoryCursor { revision: number; fingerprint: string; afterSequence: number; afterByteStart: number }
export interface MemoryQuery {
  query: string; entityIds: string[]; tags: string[];
  minElapsedSeconds: number | null; maxElapsedSeconds: number | null;
  maxResults: number; cursor: MemoryCursor | null;
}
export interface MemorySourceReference {
  worldId: string; originBranchId: string; turnId: string; sequence: number; elapsedSeconds: number;
  byteStart: number; byteEnd: number; narrativeSha256: string;
}
export type MemoryMatchKind = "known_entity" | "trigram" | "short_substring" | "tag" | "recent";
export interface MemoryFragment { text: string; source: MemorySourceReference; entityIds: string[]; tags: string[]; matchKind: MemoryMatchKind }
export interface MemoryPage {
  fragments: MemoryFragment[]; nextCursor: MemoryCursor | null; indexRevision: number; indexVersion: 1;
  candidatesExamined: number; candidateWindowExhausted: boolean;
}
export interface MemoryEnvelope { worldId: string; branchId: string; headTurnId: string | null; page: MemoryPage }
export interface PinnedFact {
  id: string; worldId: string; originBranchId: string; createdHeadTurnId: string | null;
  factKey: FactKey; createdAtMs: number; changeSeq: number;
}
export interface GameBookmark {
  id: string; worldId: string; originBranchId: string; createdHeadTurnId: string | null;
  turnId: string; label: string; createdAtMs: number; changeSeq: number;
}
export type SummaryStatus = "pending" | "running" | "deferred" | "completed" | "failed" | "cancelled" | "interrupted";
export type SummaryFailure = "network" | "timeout" | "invalid_output" | "provider_rejected" | "budget" | "cancelled" | "process_interrupted" | "manual";
export interface SummaryUsage {
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  costMicrounits: number | null; costKind: "actual" | "estimated" | null; currency: string | null;
  inputPricePerMillionMicrounits: number | null; outputPricePerMillionMicrounits: number | null;
}
export interface SummaryAttempt {
  attemptNumber: number; status: "reserved" | "completed" | "failed" | "cancelled" | "interrupted";
  reservedAtMs: number; finishedAtMs: number | null; usage: SummaryUsage; failure: SummaryFailure | null;
}
export interface SummaryOperation {
  plan: { operationId: string; provider: string; model: string; promptVersion: number };
  worldId: string; originBranchId: string; createdHeadTurnId: string | null;
  sources: { turnId: string; sequence: number; narrativeSha256: string }[];
  sourceRangeSha256: string; status: SummaryStatus; modelRequestsReserved: number; attempts: SummaryAttempt[];
  body: string | null; failure: SummaryFailure | null; createdAtMs: number; finishedAtMs: number | null; changeSeq: number;
}
export interface AnnotationView { pins: PinnedFact[]; bookmarks: GameBookmark[]; summaries: SummaryOperation[] }
export interface AnnotationEnvelope {
  worldId: string; branchId: string; headTurnId: string | null; annotations: AnnotationView; operations: SummaryOperation[];
}
export type ContextSectionKind = "rules" | "setup" | "policy" | "narrator_facts" | "actor_facts" | "pinned_fact" | "related_memory" | "historical_evidence" | "summary" | "recent_dialogue" | "current_action";
export interface ContextSectionTrace {
  kind: ContextSectionKind; id: string | null; required: boolean;
  outcome: "included" | "dropped_budget" | "deduplicated";
  utf8Bytes: number; sourceTurnCount: number; sha256: string;
}
export interface GameContextTrace {
  promptVersion: number; worldId: string; branchId: string; headTurnId: string | null; operationId: string;
  budget: { maxInputBytes: number; contextLimitTokens: number; outputReserveTokens: number; transportReserveTokens: number };
  effectiveInputLimitBytes: number; requiredInputBytes: number; inputUtf8Bytes: number; estimatedInputTokens: number;
  estimateMethod: "conservative_utf8_byte_count_not_tokenizer_usage"; actualInputTokens: number | null;
  promptSha256: string; sections: ContextSectionTrace[];
}

export class MemoryError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = "MemoryError"; }
}
function invalid(): never { throw new MemoryError(t("memory.error.format")); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function shape(value: unknown, keys: string[]): Record<string, unknown> {
  if (!object(value) || keys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !keys.includes(key))) invalid();
  return value;
}
function check(condition: unknown): asserts condition { if (!condition) invalid(); }
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max; }
function identifier(value: unknown, max = 128): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value); }
function nullableId(value: unknown): value is string | null { return value === null || identifier(value); }
function text(value: unknown, maxBytes: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.trim().length > 0) && value.length <= maxBytes
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    && !Array.from(value).some((c) => { const code = c.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })
    && new TextEncoder().encode(value).byteLength <= maxBytes;
}
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function array(value: unknown, max: number): value is unknown[] { return Array.isArray(value) && value.length <= max; }
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T { return typeof value === "string" && allowed.includes(value as T); }
function unique(values: readonly unknown[]): boolean { return new Set(values.map((v) => JSON.stringify(v))).size === values.length; }

export function parseMemoryFactKey(value: unknown): FactKey {
  check(object(value));
  let row: Record<string, unknown>;
  switch (value.type) {
    case "entity_created": case "entity_name": case "entity_life":
      row = shape(value, ["type", "entityId"]); check(identifier(row.entityId, 64)); break;
    case "entity_attribute":
      row = shape(value, ["type", "entityId", "key"]); check(identifier(row.entityId, 64) && text(row.key, 64)); break;
    case "entity_alias":
      row = shape(value, ["type", "entityId", "text"]); check(identifier(row.entityId, 64) && text(row.text, 256)); break;
    case "item_holding": row = shape(value, ["type", "itemId"]); check(identifier(row.itemId, 64)); break;
    case "condition": row = shape(value, ["type", "conditionId"]); check(identifier(row.conditionId, 64)); break;
    case "resource": row = shape(value, ["type", "ownerId", "key"]); check(identifier(row.ownerId, 64) && text(row.key, 64)); break;
    case "relationship": row = shape(value, ["type", "fromId", "toId", "kind"]); check(identifier(row.fromId, 64) && identifier(row.toId, 64) && text(row.kind, 128)); break;
    case "event": row = shape(value, ["type", "eventId"]); check(identifier(row.eventId, 64)); break;
    case "claim": row = shape(value, ["type", "claimId"]); check(identifier(row.claimId, 64)); break;
    case "time": case "location": row = shape(value, ["type"]); break;
    default: invalid();
  }
  return row as FactKey;
}

function parseCursor(value: unknown): MemoryCursor {
  const row = shape(value, ["revision", "fingerprint", "afterSequence", "afterByteStart"]);
  check(integer(row.revision) && row.revision > 0 && hash(row.fingerprint)
    && integer(row.afterSequence, 100_000) && row.afterSequence > 0 && integer(row.afterByteStart, 65_535));
  return row as unknown as MemoryCursor;
}
function parseMemoryFragment(value: unknown, worldId: string): MemoryFragment {
  const row = shape(value, ["text", "source", "entityIds", "tags", "matchKind"]);
  const source = shape(row.source, ["worldId", "originBranchId", "turnId", "sequence", "elapsedSeconds", "byteStart", "byteEnd", "narrativeSha256"]);
  check(source.worldId === worldId && identifier(source.originBranchId) && identifier(source.turnId)
    && integer(source.sequence, 100_000) && source.sequence > 0 && integer(source.elapsedSeconds)
    && integer(source.byteStart, 65_535) && integer(source.byteEnd, 65_536) && source.byteEnd > source.byteStart
    && hash(source.narrativeSha256) && text(row.text, 2048)
    && new TextEncoder().encode(row.text).byteLength === source.byteEnd - source.byteStart
    && array(row.entityIds, 512) && row.entityIds.every((id) => identifier(id, 64)) && unique(row.entityIds)
    && array(row.tags, 32) && row.tags.every((tag) => identifier(tag, 64)) && unique(row.tags)
    && oneOf(row.matchKind, ["known_entity", "trigram", "short_substring", "tag", "recent"]));
  return { text: row.text, source: source as unknown as MemorySourceReference, entityIds: row.entityIds as string[], tags: row.tags as string[], matchKind: row.matchKind };
}
export function parseMemoryEnvelope(value: unknown): MemoryEnvelope {
  const row = shape(value, ["worldId", "branchId", "headTurnId", "page"]);
  check(identifier(row.worldId) && identifier(row.branchId) && nullableId(row.headTurnId));
  const page = shape(row.page, ["fragments", "nextCursor", "indexRevision", "indexVersion", "candidatesExamined", "candidateWindowExhausted"]);
  check(array(page.fragments, 64) && integer(page.indexRevision) && page.indexRevision > 0 && page.indexVersion === 1
    && integer(page.candidatesExamined, 4096) && typeof page.candidateWindowExhausted === "boolean");
  const fragments = page.fragments.map((fragment) => parseMemoryFragment(fragment, row.worldId as string));
  check(unique(fragments.map((f) => [f.source.turnId, f.source.byteStart])) && fragments.length <= page.candidatesExamined);
  const cursor = page.nextCursor === null ? null : parseCursor(page.nextCursor);
  check(cursor === null || cursor.revision === page.indexRevision);
  check(!page.candidateWindowExhausted || (page.candidatesExamined === 4096 && cursor !== null));
  return { worldId: row.worldId, branchId: row.branchId, headTurnId: row.headTurnId,
    page: { fragments, nextCursor: cursor, indexRevision: page.indexRevision, indexVersion: 1, candidatesExamined: page.candidatesExamined, candidateWindowExhausted: page.candidateWindowExhausted } };
}

function annotationBase(row: Record<string, unknown>, world: string): void {
  check(row.worldId === world && identifier(row.originBranchId) && nullableId(row.createdHeadTurnId)
    && integer(row.createdAtMs) && integer(row.changeSeq) && row.changeSeq > 0);
}
function parsePin(value: unknown, world: string): PinnedFact {
  const row = shape(value, ["id", "worldId", "originBranchId", "createdHeadTurnId", "factKey", "createdAtMs", "changeSeq"]);
  annotationBase(row, world); check(identifier(row.id));
  return { ...row, factKey: parseMemoryFactKey(row.factKey) } as unknown as PinnedFact;
}
function parseBookmark(value: unknown, world: string): GameBookmark {
  const row = shape(value, ["id", "worldId", "originBranchId", "createdHeadTurnId", "turnId", "label", "createdAtMs", "changeSeq"]);
  annotationBase(row, world); check(identifier(row.id) && identifier(row.turnId) && text(row.label, 2048, true));
  return row as unknown as GameBookmark;
}
function parseUsage(value: unknown): SummaryUsage {
  const row = shape(value, ["inputTokens", "outputTokens", "totalTokens", "costMicrounits", "costKind", "currency", "inputPricePerMillionMicrounits", "outputPricePerMillionMicrounits"]);
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "costMicrounits", "inputPricePerMillionMicrounits", "outputPricePerMillionMicrounits"]) check(row[key] === null || integer(row[key]));
  check(row.costKind === null || oneOf(row.costKind, ["actual", "estimated"]));
  check(row.currency === null || text(row.currency, 16));
  check((row.costMicrounits === null) === (row.costKind === null) && (row.costMicrounits === null || row.currency !== null));
  return row as unknown as SummaryUsage;
}
const summaryFailures = ["network", "timeout", "invalid_output", "provider_rejected", "budget", "cancelled", "process_interrupted", "manual"] as const;
function parseSummary(value: unknown, world: string): SummaryOperation {
  const row = shape(value, ["plan", "worldId", "originBranchId", "createdHeadTurnId", "sources", "sourceRangeSha256", "status", "modelRequestsReserved", "attempts", "body", "failure", "createdAtMs", "finishedAtMs", "changeSeq"]);
  annotationBase(row, world);
  const plan = shape(row.plan, ["operationId", "provider", "model", "promptVersion"]);
  check(identifier(plan.operationId) && text(plan.provider, 128) && text(plan.model, 128) && integer(plan.promptVersion, 0xffff_ffff) && plan.promptVersion > 0);
  check(array(row.sources, 512) && row.sources.length > 0 && hash(row.sourceRangeSha256)
    && oneOf(row.status, ["pending", "running", "deferred", "completed", "failed", "cancelled", "interrupted"])
    && integer(row.modelRequestsReserved, 2) && array(row.attempts, 2) && row.attempts.length === row.modelRequestsReserved
    && (row.body === null || text(row.body, 65_536)) && (row.failure === null || oneOf(row.failure, summaryFailures))
    && (row.finishedAtMs === null || integer(row.finishedAtMs)));
  const sources = row.sources.map((value) => {
    const source = shape(value, ["turnId", "sequence", "narrativeSha256"]);
    check(identifier(source.turnId) && integer(source.sequence) && source.sequence > 0 && hash(source.narrativeSha256));
    return source as unknown as SummaryOperation["sources"][number];
  });
  check(unique(sources.map((s) => s.turnId)) && sources.every((s, i) => i === 0 || s.sequence === sources[i - 1].sequence + 1));
  const attempts = row.attempts.map((value, i) => {
    const attempt = shape(value, ["attemptNumber", "status", "reservedAtMs", "finishedAtMs", "usage", "failure"]);
    check(attempt.attemptNumber === i + 1 && oneOf(attempt.status, ["reserved", "completed", "failed", "cancelled", "interrupted"])
      && integer(attempt.reservedAtMs) && (attempt.finishedAtMs === null || integer(attempt.finishedAtMs))
      && (attempt.failure === null || oneOf(attempt.failure, summaryFailures)));
    check(attempt.status === "reserved" ? attempt.finishedAtMs === null && row.status === "running" && i + 1 === row.modelRequestsReserved : attempt.finishedAtMs !== null);
    return { ...attempt, usage: parseUsage(attempt.usage) } as unknown as SummaryAttempt;
  });
  check(row.status !== "completed" || row.body !== null);
  check(row.status !== "running" || attempts.at(-1)?.status === "reserved");
  return { ...row, plan, sources, attempts } as unknown as SummaryOperation;
}
export function parseAnnotationEnvelope(value: unknown): AnnotationEnvelope {
  const row = shape(value, ["worldId", "branchId", "headTurnId", "annotations", "operations"]);
  check(identifier(row.worldId) && identifier(row.branchId) && nullableId(row.headTurnId) && array(row.operations, 256));
  const view = shape(row.annotations, ["pins", "bookmarks", "summaries"]);
  check(array(view.pins, 256) && array(view.bookmarks, 256) && array(view.summaries, 256));
  const pins = view.pins.map((pin) => parsePin(pin, row.worldId as string));
  const bookmarks = view.bookmarks.map((bookmark) => parseBookmark(bookmark, row.worldId as string));
  const summaries = view.summaries.map((summary) => parseSummary(summary, row.worldId as string));
  const operations = row.operations.map((operation) => parseSummary(operation, row.worldId as string));
  check(unique([...pins.map((p) => p.id), ...bookmarks.map((b) => b.id)])
    && unique(summaries.map((s) => s.plan.operationId)) && unique(operations.map((s) => s.plan.operationId)));
  return { worldId: row.worldId, branchId: row.branchId, headTurnId: row.headTurnId, annotations: { pins, bookmarks, summaries }, operations };
}

export function parseGameContextTrace(value: unknown): GameContextTrace | null {
  if (value === null) return null;
  const row = shape(value, ["promptVersion", "worldId", "branchId", "headTurnId", "operationId", "budget", "effectiveInputLimitBytes", "requiredInputBytes", "inputUtf8Bytes", "estimatedInputTokens", "estimateMethod", "actualInputTokens", "promptSha256", "sections"]);
  check(integer(row.promptVersion, 0xffff_ffff) && row.promptVersion > 0 && identifier(row.worldId) && identifier(row.branchId)
    && nullableId(row.headTurnId) && identifier(row.operationId) && hash(row.promptSha256)
    && row.estimateMethod === "conservative_utf8_byte_count_not_tokenizer_usage"
    && (row.actualInputTokens === null || integer(row.actualInputTokens)) && array(row.sections, 2048));
  const budget = shape(row.budget, ["maxInputBytes", "contextLimitTokens", "outputReserveTokens", "transportReserveTokens"]);
  check(integer(budget.maxInputBytes, 4_194_304) && budget.maxInputBytes > 0 && integer(budget.contextLimitTokens, 4_194_304) && budget.contextLimitTokens > 0
    && integer(budget.outputReserveTokens) && budget.outputReserveTokens > 0 && integer(budget.transportReserveTokens)
    && budget.contextLimitTokens > budget.outputReserveTokens + budget.transportReserveTokens);
  const limit = Math.min(budget.maxInputBytes, budget.contextLimitTokens - budget.outputReserveTokens - budget.transportReserveTokens);
  check(row.effectiveInputLimitBytes === limit && integer(row.requiredInputBytes, limit) && row.requiredInputBytes > 0
    && integer(row.inputUtf8Bytes, limit) && row.inputUtf8Bytes >= row.requiredInputBytes && row.estimatedInputTokens === row.inputUtf8Bytes);
  const sections = row.sections.map((value) => {
    const section = shape(value, ["kind", "id", "required", "outcome", "utf8Bytes", "sourceTurnCount", "sha256"]);
    check(oneOf(section.kind, ["rules", "setup", "policy", "narrator_facts", "actor_facts", "pinned_fact", "related_memory", "historical_evidence", "summary", "recent_dialogue", "current_action"])
      && nullableId(section.id) && typeof section.required === "boolean" && oneOf(section.outcome, ["included", "dropped_budget", "deduplicated"])
      && integer(section.utf8Bytes, 8_388_608) && integer(section.sourceTurnCount, 512) && hash(section.sha256)
      && (!section.required || section.outcome === "included"));
    return section as unknown as ContextSectionTrace;
  });
  check(sections.filter((section) => section.outcome === "included").reduce((total, section) => total + section.utf8Bytes, 0) === row.inputUtf8Bytes
    && sections.filter((section) => section.required).reduce((total, section) => total + section.utf8Bytes, 0) === row.requiredInputBytes);
  return { ...row, budget, sections } as unknown as GameContextTrace;
}

const errorKeys: Record<string, MemoryPlainMessageKey> = {
  game_busy: "memory.error.busy", busy: "memory.error.busy", annotations_busy: "memory.error.busy", memory_busy: "memory.error.busy",
  game_stale_head: "memory.error.stale", stale_head: "memory.error.stale", memory_stale_cursor: "memory.error.stale", memory_invalid_scope: "memory.error.stale", annotations_invalid_scope: "memory.error.stale",
  annotations_hidden_fact: "memory.error.hidden", annotations_unknown_fact: "memory.error.hidden",
  annotations_invisible_source: "memory.error.invisible", annotations_duplicate: "memory.error.duplicate", annotations_missing: "memory.error.missing",
  annotations_too_large: "memory.error.large", memory_too_large: "memory.error.large", game_context_too_large: "memory.error.large",
  annotations_budget_exhausted: "memory.error.budget",
};
async function call(command: string, args: Record<string, unknown>): Promise<unknown> {
  if (!isTauri()) throw new MemoryError(t("memory.unavailable"));
  try { return await invoke<unknown>(command, args); }
  catch (error) {
    const code = object(error) && typeof error.code === "string" && Object.hasOwn(errorKeys, error.code) ? error.code : undefined;
    throw new MemoryError(t(code ? errorKeys[code] : "memory.error.unknown"), code);
  }
}
export function describeMemoryError(error: unknown): string { return error instanceof MemoryError ? error.message : t("memory.error.unknown"); }
function bound<T extends { worldId: string; headTurnId: string | null }>(envelope: T, worldId: string, head: string | null): T {
  check(envelope.worldId === worldId && envelope.headTurnId === head); return envelope;
}
export async function queryGameMemory(worldId: string, expectedHeadTurnId: string | null, query: MemoryQuery): Promise<MemoryEnvelope> {
  return bound(parseMemoryEnvelope(await call("query_game_memory", { worldId, expectedHeadTurnId, query })), worldId, expectedHeadTurnId);
}
export async function getGameAnnotations(worldId: string, expectedHeadTurnId: string | null): Promise<AnnotationEnvelope> {
  return bound(parseAnnotationEnvelope(await call("get_game_annotations", { worldId, expectedHeadTurnId })), worldId, expectedHeadTurnId);
}
async function mutate(command: string, worldId: string, expectedHeadTurnId: string | null, extra: Record<string, unknown>): Promise<AnnotationEnvelope> {
  return bound(parseAnnotationEnvelope(await call(command, { worldId, expectedHeadTurnId, ...extra })), worldId, expectedHeadTurnId);
}
export function pinGameFact(worldId: string, head: string | null, factKey: FactKey): Promise<AnnotationEnvelope> { return mutate("pin_game_fact", worldId, head, { factKey }); }
export function bookmarkGameTurn(worldId: string, head: string | null, turnId: string, label: string): Promise<AnnotationEnvelope> { return mutate("bookmark_game_turn", worldId, head, { turnId, label }); }
export function removeGameAnnotation(worldId: string, head: string | null, annotationId: string): Promise<AnnotationEnvelope> { return mutate("remove_game_annotation", worldId, head, { annotationId }); }
export function createGameSummary(worldId: string, head: string | null, operationId: string, sourceTurnIds: string[], providerKind: ProviderKind): Promise<AnnotationEnvelope> {
  return mutate("create_game_summary", worldId, head, { operationId, sourceTurnIds, providerKind });
}
export async function getGameContextTrace(worldId: string, operationId: string, expectedHeadTurnId: string | null): Promise<GameContextTrace | null> {
  const trace = parseGameContextTrace(await call("get_game_context_trace", { worldId, operationId }));
  check(trace === null || (trace.worldId === worldId && trace.operationId === operationId && trace.headTurnId === expectedHeadTurnId));
  return trace;
}
