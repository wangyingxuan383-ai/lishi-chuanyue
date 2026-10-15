import { invoke } from "@tauri-apps/api/core";
import { researchT as t } from "./gameResearchMessages";

export interface ResearchEra { startYear: number; endYear: number }
export interface ResearchQuery {
  query: string; topic: "general" | "person" | "office" | "place" | "technology" | "chronology";
  era: ResearchEra | null; entityTags: string[]; region: string | null;
}
export interface ResearchSource {
  id: string; title: string; url: string; excerpt: string; excerptOrigin: "search_snippet";
  accessedAtMs: number; requestedEra: ResearchEra | null; entityTags: string[];
}
export interface ResearchConclusion {
  id: string; statement: string; status: "evidence" | "inference" | "disputed" | "unknown";
  sourceIds: string[]; conflictsWith: string[]; temporalConstraints: { era: ResearchEra; label: string }[];
}
export interface ResearchRecord {
  id: string; cacheKey: string; providerNamespace: string; query: ResearchQuery;
  sources: ResearchSource[]; conclusions: ResearchConclusion[]; createdAtMs: number;
}
export interface ResearchProfile {
  configured: boolean; revision: number; config: { endpoint: string; searchLanguage: string | null } | null;
}
export interface ResearchOperation {
  operationId: string; cacheKey: string; status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  searchSlotsUsed: number; httpAttemptsKnown: boolean;
  diagnostics: { httpAttempts: number; httpStatus: number | null; elapsedMs: number; error: string | null };
  createdAtMs: number; finishedAtMs: number | null; recordId: string | null;
}
export interface ResearchReply {
  worldId: string; branchId: string; headTurnId: string | null; cached: boolean;
  operation: ResearchOperation | null; record: ResearchRecord | null;
  warnings: { conclusionId: string; sourceIds: string[]; label: string; status: ResearchConclusion["status"] }[];
}

function fail(): never { throw new Error("research_response_invalid"); }
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function keys(v: Record<string, unknown>, expected: string[]) {
  if (Object.keys(v).length !== expected.length || Object.keys(v).some(k => !expected.includes(k))) fail();
}
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const timestamp = (v: unknown): v is number => integer(v) && v <= 8_640_000_000_000_000;
const text = (v: unknown, max: number, empty = false): v is string => typeof v === "string"
  && (empty || v.trim().length > 0) && new TextEncoder().encode(v).length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const cacheKey = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const ids = (v: unknown, max = 128): v is string[] => Array.isArray(v) && v.length <= max && v.every(id) && new Set(v).size === v.length;
const nullableId = (v: unknown) => v === null || id(v);
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === "string" && values.includes(v as T);
const topics = ["general", "person", "office", "place", "technology", "chronology"] as const;
const statuses = ["evidence", "inference", "disputed", "unknown"] as const;
const operationStatuses = ["pending", "running", "succeeded", "failed", "cancelled", "interrupted"] as const;
const researchErrors = ["invalid_input", "invalid_scope", "unavailable", "busy", "incompatible_database", "database", "duplicate_operation", "invalid_transition", "missing", "too_large", "missing_credential", "transport", "timeout", "http_status", "invalid_response", "credential_echo", "cancelled", "clock", "conflict", "invisible_source"] as const;
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(v => b.includes(v));

export function validResearchEra(v: unknown): v is ResearchEra {
  return object(v) && Object.keys(v).length === 2 && "startYear" in v && "endYear" in v
    && typeof v.startYear === "number" && typeof v.endYear === "number"
    && Number.isInteger(v.startYear) && Number.isInteger(v.endYear)
    && v.startYear !== 0 && v.endYear !== 0 && v.startYear >= -999999 && v.endYear <= 999999 && v.startYear <= v.endYear;
}
export function validResearchQuestion(value: string): boolean {
  return text(value, 1800) && Array.from(value).length <= 600 && value.trim().split(/\s+/u).length <= 75;
}
function query(v: unknown): ResearchQuery {
  if (!object(v) || typeof v.query !== "string" || !validResearchQuestion(v.query) || !oneOf(v.topic, topics)
    || !(v.era === null || validResearchEra(v.era)) || !Array.isArray(v.entityTags) || v.entityTags.length > 16
    || !v.entityTags.every(tag => text(tag, 128)) || !(v.region === null || text(v.region, 128))) fail();
  keys(v, ["query", "topic", "era", "entityTags", "region"]);
  return v as unknown as ResearchQuery;
}
function url(v: unknown, endpoint = false): v is string {
  if (!text(v, 2048) || /[\s\u0000-\u001f\u007f-\u009f]/u.test(v)) return false;
  try {
    const value = new URL(v);
    return (endpoint ? value.protocol === "https:" && !value.search && !value.hash && !v.includes("?") && !v.includes("#")
      : ["https:", "http:"].includes(value.protocol)) && !value.username && !value.password && !!value.hostname;
  } catch { return false; }
}
function conclusion(v: unknown): ResearchConclusion {
  if (!object(v) || !id(v.id) || !text(v.statement, 4096) || !oneOf(v.status, statuses)
    || !ids(v.sourceIds, 5) || !ids(v.conflictsWith, 16) || v.conflictsWith.includes(v.id)
    || (v.status !== "unknown" && v.sourceIds.length === 0)
    || !Array.isArray(v.temporalConstraints) || v.temporalConstraints.length > 16) fail();
  keys(v, ["id", "statement", "status", "sourceIds", "conflictsWith", "temporalConstraints"]);
  for (const constraint of v.temporalConstraints) {
    if (!object(constraint) || !validResearchEra(constraint.era) || !text(constraint.label, 256)) fail();
    keys(constraint, ["era", "label"]);
  }
  return v as unknown as ResearchConclusion;
}
export function parseResearchRecord(v: unknown): ResearchRecord {
  if (!object(v) || !id(v.id) || !cacheKey(v.cacheKey) || !id(v.providerNamespace) || !timestamp(v.createdAtMs)
    || !Array.isArray(v.sources) || v.sources.length > 5 || !Array.isArray(v.conclusions) || v.conclusions.length > 128) fail();
  keys(v, ["id", "cacheKey", "providerNamespace", "query", "sources", "conclusions", "createdAtMs"]);
  query(v.query);
  for (const source of v.sources) {
    if (!object(source) || !id(source.id) || !text(source.title, 1024) || !url(source.url) || !text(source.excerpt, 4096, true)
      || source.excerptOrigin !== "search_snippet" || !timestamp(source.accessedAtMs)
      || !(source.requestedEra === null || validResearchEra(source.requestedEra)) || !Array.isArray(source.entityTags)
      || source.entityTags.length > 16 || !source.entityTags.every(tag => text(tag, 128))) fail();
    keys(source, ["id", "title", "url", "excerpt", "excerptOrigin", "accessedAtMs", "requestedEra", "entityTags"]);
  }
  const sources = v.sources as ResearchSource[], conclusions = v.conclusions.map(conclusion);
  const sourceIds = new Set(sources.map(s => s.id)), conclusionIds = new Set(conclusions.map(c => c.id));
  if (sourceIds.size !== sources.length || new Set(sources.map(s => s.url)).size !== sources.length
    || conclusionIds.size !== conclusions.length || conclusions.some(c => c.sourceIds.some(s => !sourceIds.has(s))
      || c.conflictsWith.some(other => !conclusionIds.has(other)))) fail();
  return v as unknown as ResearchRecord;
}
export function parseResearchProfile(v: unknown): ResearchProfile {
  if (!object(v) || typeof v.configured !== "boolean" || !integer(v.revision)) fail();
  keys(v, ["configured", "revision", "config"]);
  if (v.config !== null) {
    if (!object(v.config) || !url(v.config.endpoint, true)
      || !(v.config.searchLanguage === null || (typeof v.config.searchLanguage === "string" && /^[a-z-]{2,16}$/.test(v.config.searchLanguage)))) fail();
    keys(v.config, ["endpoint", "searchLanguage"]);
  } else if (v.configured) fail();
  return v as unknown as ResearchProfile;
}
function operation(v: unknown): ResearchOperation {
  if (!object(v) || !id(v.operationId) || !cacheKey(v.cacheKey) || !oneOf(v.status, operationStatuses)
    || !integer(v.searchSlotsUsed) || v.searchSlotsUsed > 1 || typeof v.httpAttemptsKnown !== "boolean"
    || !object(v.diagnostics) || !integer(v.diagnostics.httpAttempts) || v.diagnostics.httpAttempts > v.searchSlotsUsed
    || !integer(v.diagnostics.elapsedMs) || !(v.diagnostics.httpStatus === null || (integer(v.diagnostics.httpStatus) && v.diagnostics.httpStatus >= 100 && v.diagnostics.httpStatus <= 599))
    || !(v.diagnostics.error === null || oneOf(v.diagnostics.error, researchErrors))
    || !timestamp(v.createdAtMs) || !(v.finishedAtMs === null || timestamp(v.finishedAtMs)) || !nullableId(v.recordId)) fail();
  keys(v, ["operationId", "cacheKey", "status", "searchSlotsUsed", "httpAttemptsKnown", "diagnostics", "createdAtMs", "finishedAtMs", "recordId"]);
  keys(v.diagnostics, ["httpAttempts", "httpStatus", "elapsedMs", "error"]);
  const terminal = v.status !== "pending" && v.status !== "running";
  if (terminal !== (v.finishedAtMs !== null) || (v.finishedAtMs !== null && (v.finishedAtMs as number) < v.createdAtMs)
    || (v.status === "succeeded") !== (v.recordId !== null)
    || (v.status === "pending" && (v.searchSlotsUsed !== 0 || !v.httpAttemptsKnown))
    || (v.status === "running" && v.searchSlotsUsed !== 1)
    || (v.status === "succeeded" && (!v.httpAttemptsKnown || v.diagnostics.error !== null))) fail();
  return v as unknown as ResearchOperation;
}
export function parseResearchReply(v: unknown): ResearchReply {
  if (!object(v) || !id(v.worldId) || !id(v.branchId) || !nullableId(v.headTurnId) || typeof v.cached !== "boolean"
    || !Array.isArray(v.warnings) || v.warnings.length > 256) fail();
  keys(v, ["worldId", "branchId", "headTurnId", "cached", "operation", "record", "warnings"]);
  const record = v.record === null ? null : parseResearchRecord(v.record);
  const op = v.operation === null ? null : operation(v.operation);
  if (op && ((op.recordId !== null) !== (record !== null) || (record && (op.recordId !== record.id || op.cacheKey !== record.cacheKey)))) fail();
  if (v.cached && (!record || (op && (op.searchSlotsUsed !== 0 || op.diagnostics.httpAttempts !== 0 || !op.httpAttemptsKnown)))) fail();
  for (const warning of v.warnings) {
    if (!object(warning) || !id(warning.conclusionId) || !ids(warning.sourceIds, 5) || !text(warning.label, 256) || !oneOf(warning.status, statuses)) fail();
    keys(warning, ["conclusionId", "sourceIds", "label", "status"]);
    const linked = record?.conclusions.find(c => c.id === warning.conclusionId);
    if (!linked || !sameIds(warning.sourceIds, linked.sourceIds) || warning.status !== linked.status) fail();
  }
  return v as unknown as ResearchReply;
}
export async function getResearchProfile() { return parseResearchProfile(await invoke("get_game_research_profile")); }
export async function saveResearchProfile(config: NonNullable<ResearchProfile["config"]>, token: string | null, expectedRevision: number) {
  const profile = parseResearchProfile(await invoke("save_game_research_profile", { config, token, expectedRevision }));
  if (profile.revision <= expectedRevision || !profile.config || profile.config.endpoint !== config.endpoint || profile.config.searchLanguage !== config.searchLanguage) fail();
  return profile;
}
export async function deleteResearchProfile(expectedRevision: number) {
  const profile = parseResearchProfile(await invoke("delete_game_research_profile", { expectedRevision }));
  if (profile.revision <= expectedRevision || profile.configured || profile.config !== null) fail();
  return profile;
}
export async function researchHistory(worldId: string, branchId: string, expectedHeadTurnId: string | null, operationId: string, value: ResearchQuery, forceRefresh: boolean) {
  query(value);
  const reply = parseResearchReply(await invoke("research_game_history", { worldId, branchId, expectedHeadTurnId, operationId, query: value, forceRefresh }));
  if (reply.worldId !== worldId || reply.branchId !== branchId || reply.headTurnId !== expectedHeadTurnId || (reply.operation && reply.operation.operationId !== operationId)) fail();
  return reply;
}
export async function listResearch(worldId: string, branchId: string, expectedHeadTurnId: string | null) {
  const value = await invoke("list_game_research", { worldId, branchId, expectedHeadTurnId });
  if (!Array.isArray(value) || value.length > 4096) fail();
  return value.map(parseResearchRecord);
}
export async function adoptResearch(worldId: string, branchId: string, expectedHeadTurnId: string | null, record: ResearchRecord) {
  parseResearchRecord(record);
  const adoptionId = crypto.randomUUID(), sourceIds = record.sources.map(s => s.id);
  const value = await invoke("adopt_game_research", { worldId, branchId, expectedHeadTurnId, recordId: record.id, adoptionId, sourceIds });
  if (!object(value) || value.worldId !== worldId || value.originBranchId !== branchId || value.headTurnId !== expectedHeadTurnId
    || value.recordId !== record.id || value.id !== adoptionId || !ids(value.sourceIds, 5) || value.sourceIds.length === 0
    || !integer(value.changeSeq) || value.changeSeq === 0 || !timestamp(value.createdAtMs)) fail();
  keys(value, ["id", "worldId", "originBranchId", "headTurnId", "recordId", "sourceIds", "evidence", "changeSeq", "createdAtMs"]);
  const evidence = parseResearchRecord(value.evidence);
  if (evidence.id !== record.id || evidence.cacheKey !== record.cacheKey || !sameIds(value.sourceIds, sourceIds)
    || !sameIds(evidence.sources.map(s => s.id), sourceIds)) fail();
  return value;
}
export async function addConclusion(recordId: string, value: ResearchConclusion) {
  conclusion(value);
  const record = parseResearchRecord(await invoke("add_game_research_conclusion", { recordId, conclusion: value }));
  const appended = record.conclusions.find(c => c.id === value.id);
  if (record.id !== recordId || !appended || appended.statement !== value.statement || appended.status !== value.status
    || !sameIds(appended.sourceIds, value.sourceIds) || !sameIds(appended.conflictsWith, value.conflictsWith)
    || JSON.stringify(appended.temporalConstraints) !== JSON.stringify(value.temporalConstraints)) fail();
  return record;
}
export function describeResearchError(cause: unknown): string {
  const code = object(cause) && typeof cause.code === "string" ? cause.code : cause instanceof Error ? cause.message : "";
  if (["research_config_missing", "research_key_missing", "research_missing_credential"].includes(code)) return t("errorConfig");
  if (["game_busy", "research_busy"].includes(code)) return t("errorBusy");
  if (["game_stale_head", "research_Conflict", "research_conflict"].includes(code)) return t("errorStale");
  if (code === "research_response_invalid") return t("errorResponse");
  if (["research_invalid_input", "research_too_large"].includes(code)) return t("errorInput");
  if (["game_cancelled", "research_cancelled"].includes(code)) return t("cancelled");
  return t("errorGeneric");
}
