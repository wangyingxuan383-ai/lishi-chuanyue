import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { gameT, type GameMessageKey } from "./gameMessages";

export interface WorldSetup {
  worldId: string; title: string; country: string; eraYear: number;
  locationName: string; protagonistName: string; narrativeStyle: string;
}
export interface GameEntity {
  id: string; kind: "person" | "place" | "organization" | "item";
  name: string; alive: boolean | null; attributes: Record<string, string>;
}
export interface GameStateV1 {
  protocolVersion: 1;
  time: { eraYear: number; elapsedSeconds: number; precision: "year" };
  locationId: string; protagonistId: string; entities: GameEntity[];
  resources: { ownerId: string; key: string; unit: string; amount: number }[];
  relationships: { fromId: string; toId: string; kind: string; strength: number }[];
  conditions: { id: string; entityId: string; description: string; active: boolean }[];
  knownFacts: { actorId: string; factId: string }[];
  events: { id: string; description: string; entityIds: string[] }[];
}
export type StateSource = { type: "initial" } | { type: "turn"; operationId: string; turnId: string; eventId: string }
  | { type: "legacy_snapshot"; turnId: string | null; formatVersion: 1 };
export type AliasKind = "former_name" | "nickname" | "title" | "transliteration" | "other";
export type ConditionCategory = "injury" | "illness" | "obligation" | "other" | "legacy_unspecified";
export type Certainty = "certain" | "reported" | "doubtful" | "legacy_unspecified";
export type AcquisitionMode = "observed" | "told" | "inferred" | "legacy_unspecified";
export interface HoldingValue {
  status: "known" | "legacy_unknown"; holderId: string | null; placeId: string | null;
  quantity: number | null; unit: string | null;
}
export interface GameEntityV2 extends GameEntity {
  aliases: { text: string; kind: AliasKind; source: StateSource }[];
  createdSource: StateSource; nameSource: StateSource; lifeSource: StateSource;
  attributeSources: Record<string, StateSource>;
}
export type FactKey = { type: "entity_created" | "entity_name" | "entity_life"; entityId: string }
  | { type: "entity_attribute"; entityId: string; key: string } | { type: "entity_alias"; entityId: string; text: string }
  | { type: "item_holding"; itemId: string } | { type: "condition"; conditionId: string }
  | { type: "resource"; ownerId: string; key: string }
  | { type: "relationship"; fromId: string; toId: string; kind: string }
  | { type: "event"; eventId: string } | { type: "claim"; claimId: string } | { type: "time" | "location" };
export interface ActorKnownEntity {
  entityId: string; name: string | null; alive: boolean | null;
  attributes: Record<string, string>; aliases: string[];
}
export interface ActorKnowledge {
  targetType: "event" | "claim"; targetId: string; text: string; certainty: Certainty;
  acquisitionMode: AcquisitionMode; knownEvidenceEventIds: string[];
}
export interface ObservedCondition {
  id: string; entityId: string; description: string; category: ConditionCategory; active: boolean;
}
export interface ObservedResource { ownerId: string; key: string; unit: string; amount: number }
export interface ObservedRelationship { fromId: string; toId: string; kind: string; strength: number }
export interface ActorObservedFact { factKey: FactKey; value: unknown }
export interface GameActorView {
  worldId: string; branchId: string; headTurnId: string | null; actorId: string;
  entities: ActorKnownEntity[]; knowledge: ActorKnowledge[]; observedFacts: ActorObservedFact[];
}
export interface GameStateV2 {
  protocolVersion: 2;
  time: GameStateV1["time"] & { lastChangedSource: StateSource };
  locationId: string; locationSource: StateSource; protagonistId: string; entities: GameEntityV2[];
  resources: (ObservedResource & { lastChangedSource: StateSource })[];
  relationships: (ObservedRelationship & { lastChangedSource: StateSource })[];
  itemHoldings: { itemId: string; value: HoldingValue; source: StateSource }[];
  conditions: (ObservedCondition & { startedSource: StateSource; lastChangedSource: StateSource; resolvedSource: StateSource | null })[];
  events: { id: string; description: string; entityIds: string[]; disclosure: "public" | "restricted" | "legacy_unspecified"; createdSource: StateSource }[];
  claims: { id: string; text: string; entityIds: string[]; assessment: "unverified" | "supported" | "refuted"; evidenceEventIds: string[]; createdSource: StateSource; lastChangedSource: StateSource }[];
  knowledge: { actorId: string; targetType: "event" | "claim"; targetId: string; certainty: Certainty; acquisitionMode: AcquisitionMode; acquisitionEventId: string | null; source: StateSource; knownText: string; knownEvidenceEventIds: string[] }[];
  factObservations: { actorId: string; factKey: FactKey; factSource: StateSource; acquisitionSource: StateSource }[];
}
export type GameState = GameStateV1 | GameStateV2;
export interface GameChoice { id: string; text: string }
export type GameActionKind = "action" | "continue";
export type GameStatus = "pending" | "generating" | "validating" | "committed" | "failed" | "cancelled" | "interrupted";
export interface GameTurn {
  turnId: string; parentTurnId: string | null; actionKind: GameActionKind;
  actionText: string; narrative: string; choices: GameChoice[]; state: GameState; createdAtMs: number;
}
export interface GameOperation {
  operationId: string; expectedHeadTurnId: string | null; actionKind: GameActionKind;
  actionText: string; status: GameStatus; errorCode: string | null; createdAtMs: number;
}
export interface GameWorld {
  setup: WorldSetup; branchId: string; headTurnId: string | null; turnCount: number;
  state: GameState; openingNarrative: string; openingChoices: GameChoice[];
  turns: GameTurn[]; latestOperation: GameOperation | null; narrativePolicy: string;
}
export interface WorldSummary {
  worldId: string; title: string; country: string; eraYear: number;
  protagonistName: string; headTurnId: string | null; turnCount: number;
}
export interface GameWorldList { worlds: WorldSummary[]; unavailableCount: number }
export interface GamePreset { presetId: string; name: string; setup: WorldSetup }
export type ProviderKind = "demo" | "compatible";
export interface GameTurnRequest {
  operationId: string; worldId: string; branchId: string;
  expectedHeadTurnId: string | null; actionKind: GameActionKind; actionText: string;
}
export type GameEvent = {
  operationId: string; sequence: number; kind: "phase"; phase: GameStatus; errorCode?: string;
} | { operationId: string; sequence: number; kind: "narrative"; text: string };
export type ProviderCapability = "unknown" | "supported" | "unsupported";
export interface GameContextBudget {
  maxInputBytes: number; contextLimitTokens: number; outputReserveTokens: number; transportReserveTokens: number;
}
export const defaultContextBudget: GameContextBudget = {
  maxInputBytes: 8192, contextLimitTokens: 16384, outputReserveTokens: 4096, transportReserveTokens: 512,
};
export interface GameProviderProfile {
  config: { endpoint: string; model: string; revision: number; allowInsecureHttp: boolean; contextBudget: GameContextBudget } | null;
  configured: boolean;
  capabilities: { streaming: ProviderCapability; structuredOutput: ProviderCapability };
  revision: number;
}
export interface GameDiagnostics {
  httpStatus: number | null; usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  elapsedMs: number; attempts: number;
}
export interface GameProviderTest { status: "completed" | "failed"; errorCode: string | null; diagnostics: GameDiagnostics }

const codeKeys = {
  invalid_request: "game.error.invalid", invalid_setup: "game.error.invalid", invalid_world_id: "game.error.invalid",
  invalid_operation: "game.error.invalid", invalid_operation_id: "game.error.invalid", invalid_action: "game.error.invalid",
  invalid_policy: "game.error.invalid", invalid_config: "game.error.invalid", game_invalid: "game.error.invalid",
  invalid_options: "game.error.invalid",
  game_invalid_request: "game.error.invalid",
  game_invalid_setup: "game.error.invalid", game_provider_invalid: "game.error.endpoint",
  busy: "game.error.busy", game_busy: "game.error.busy", operation_busy: "game.error.busy",
  game_world_busy: "game.error.busy", game_provider_busy: "game.error.busy",
  duplicate: "game.error.duplicate", duplicate_operation: "game.error.duplicate", game_duplicate: "game.error.duplicate",
  stale_head: "game.error.stale", game_stale_head: "game.error.stale",
  world_not_found: "game.error.world", database: "game.error.world", storage_failed: "game.error.world",
  game_storage: "game.error.world", world_unavailable: "game.error.world",
  game_database: "game.error.world", game_not_found: "game.error.world", game_incompatible_schema: "game.error.world",
  game_unavailable: "game.error.world", game_already_created: "game.error.world",
  game_revision_overflow: "game.error.world", game_clock: "game.error.world",
  protocol_error: "game.error.protocol", invalid_output: "game.error.protocol", invalid_state: "game.error.protocol",
  invalid_payload: "game.error.protocol", validation_failed: "game.error.protocol", invalid_utf8: "game.error.protocol",
  invalid_content_type: "game.error.protocol", consumer_closed: "game.error.event",
  event_too_large: "game.error.protocol", response_too_large: "game.error.protocol", output_too_large: "game.error.protocol",
  game_invalid_protocol: "game.error.protocol", game_invalid_output: "game.error.protocol", game_invalid_entity: "game.error.protocol",
  game_invalid_resource: "game.error.protocol", game_invalid_time: "game.error.protocol", game_dead_cannot_revive: "game.error.protocol",
  game_invalid_relationship: "game.error.protocol", game_invalid_condition: "game.error.protocol", game_invalid_knowledge: "game.error.protocol",
  game_invalid_event: "game.error.protocol", game_invalid_reference: "game.error.protocol", game_conflict: "game.error.protocol",
  game_too_large: "game.error.protocol", game_invalid_transition: "game.error.protocol", game_invalid_error_code: "game.error.protocol",
  game_context_too_large: "game.error.protocol", game_provider_failed: "game.error.network",
  protagonist_dead: "game.error.dead", provider_missing: "game.error.provider", credential_missing: "game.error.provider",
  game_protagonist_dead: "game.error.dead", model_tls_unavailable: "game.error.network",
  credential_unavailable: "game.error.provider", credential_unconfirmed: "game.error.provider",
  game_provider_missing: "game.error.provider", game_provider_stale: "game.error.stale",
  game_provider_unconfirmed: "game.error.unconfirmed", game_worker_failed: "game.error.unconfirmed",
  invalid_url: "game.error.endpoint", invalid_secret: "game.error.key", secret_invalid_value: "game.error.key",
  network: "game.error.network", client_setup: "game.error.network", tls_unavailable: "game.error.network",
  connect_timeout: "game.error.timeout", idle_timeout: "game.error.timeout", total_timeout: "game.error.timeout",
  http_status: "game.error.http", upstream_error: "game.error.http", refused: "game.error.refused",
  unexpected_eof: "game.error.truncated", empty_output: "game.error.truncated", truncated: "game.error.truncated",
  credential_echo: "game.error.secretEcho",
  game_migration_busy: "game.error.busy", game_migration_conflict: "game.error.stale",
  game_migration_backup_failed: "game.error.backup", game_migration_invalid: "game.error.upgrade",
  game_migration_unavailable: "game.error.world", game_migration_database: "game.error.upgrade",
  game_migration_unconfirmed: "game.error.unconfirmed",
} as const satisfies Record<string, GameMessageKey>;
const preStartCodes = new Set([
  "invalid_request", "invalid_setup", "invalid_world_id", "invalid_operation", "invalid_operation_id", "invalid_action",
  "game_invalid", "game_invalid_request", "game_invalid_setup", "busy", "game_busy", "game_world_busy", "operation_busy", "duplicate", "duplicate_operation", "game_duplicate",
  "stale_head", "game_stale_head", "world_not_found", "game_not_found", "protagonist_dead", "game_protagonist_dead", "provider_missing", "game_provider_missing", "invalid_url",
]);

export class GameError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = "GameError"; }
}
export function describeGameCode(code: string | null | undefined): string {
  return code && Object.hasOwn(codeKeys, code)
    ? gameT(codeKeys[code as keyof typeof codeKeys]) : gameT("game.error.unconfirmed");
}
export function describeGameError(error: unknown): string {
  return error instanceof GameError ? error.message : gameT("game.error.unconfirmed");
}
export function isGameRejectedBeforeStart(error: unknown): boolean {
  return error instanceof GameError && error.code !== undefined && preStartCodes.has(error.code);
}
export function hasGameCore(): boolean { return isTauri(); }
export function isGameTerminal(status: string): status is "committed" | "failed" | "cancelled" | "interrupted" {
  return status === "committed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max = 256 * 1024): value is string { return typeof value === "string" && value.length <= max; }
function nonemptyText(value: unknown, max: number): value is string { return text(value, max) && value.trim().length > 0; }
function id(value: unknown): value is string { return text(value, 128) && value.length > 0; }
function nullableId(value: unknown): value is string | null { return value === null || id(value); }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function year(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value !== 0 && Math.abs(value) <= 999999; }
function signedInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }
function code(value: unknown): value is string | null { return value === null || (typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)); }
function list(value: unknown, max = 4096): value is unknown[] { return Array.isArray(value) && value.length <= max; }
function status(value: unknown): value is GameStatus {
  return value === "pending" || value === "generating" || value === "validating" || value === "committed" ||
    value === "failed" || value === "cancelled" || value === "interrupted";
}
function actionKind(value: unknown): value is GameActionKind { return value === "action" || value === "continue"; }
function formatError(): GameError { return new GameError(gameT("game.error.format")); }

function parseSetup(value: unknown): WorldSetup {
  if (!record(value) || !id(value.worldId) || !nonemptyText(value.title, 256) || !nonemptyText(value.country, 128) || !year(value.eraYear) ||
    !nonemptyText(value.locationName, 256) || !nonemptyText(value.protagonistName, 128) || !text(value.narrativeStyle, 8192)) throw formatError();
  return { worldId: value.worldId, title: value.title, country: value.country, eraYear: value.eraYear,
    locationName: value.locationName, protagonistName: value.protagonistName, narrativeStyle: value.narrativeStyle };
}
function parseChoices(value: unknown): GameChoice[] {
  if (!list(value, 32)) throw formatError();
  const choices = value.map((choice) => {
    if (!record(choice) || !id(choice.id) || !text(choice.text, 8192) || !choice.text.length) throw formatError();
    return { id: choice.id, text: choice.text };
  });
  if (new Set(choices.map((choice) => choice.id)).size !== choices.length) throw formatError();
  return choices;
}
function parseStateV1(value: unknown): GameStateV1 {
  if (!record(value) || value.protocolVersion !== 1 || !record(value.time) || !year(value.time.eraYear) ||
    !count(value.time.elapsedSeconds) || value.time.precision !== "year" || !id(value.locationId) || !id(value.protagonistId) ||
    !list(value.entities) || !list(value.resources) || !list(value.relationships) || !list(value.conditions) ||
    !list(value.knownFacts) || !list(value.events)) throw formatError();
  const entities = value.entities.map((entity): GameEntity => {
    if (!record(entity) || !id(entity.id) || !nonemptyText(entity.name, 256) ||
      (entity.kind !== "person" && entity.kind !== "place" && entity.kind !== "organization" && entity.kind !== "item") ||
      !(entity.alive === null || typeof entity.alive === "boolean") || !record(entity.attributes) ||
      Object.keys(entity.attributes).length > 128 || Object.entries(entity.attributes).some(([key, attr]) => !id(key) || !text(attr, 8192))) throw formatError();
    return { id: entity.id, kind: entity.kind, name: entity.name, alive: entity.alive,
      attributes: entity.attributes as Record<string, string> };
  });
  if (new Set(entities.map((entity) => entity.id)).size !== entities.length) throw formatError();
  const resources = value.resources.map((resource) => {
    if (!record(resource) || !id(resource.ownerId) || !id(resource.key) || !text(resource.unit, 128) || !count(resource.amount)) throw formatError();
    return { ownerId: resource.ownerId, key: resource.key, unit: resource.unit, amount: resource.amount };
  });
  const relationships = value.relationships.map((relationship) => {
    if (!record(relationship) || !id(relationship.fromId) || !id(relationship.toId) || !id(relationship.kind) || !signedInteger(relationship.strength)) throw formatError();
    return { fromId: relationship.fromId, toId: relationship.toId, kind: relationship.kind, strength: relationship.strength };
  });
  const conditions = value.conditions.map((condition) => {
    if (!record(condition) || !id(condition.id) || !id(condition.entityId) || !text(condition.description, 8192) || typeof condition.active !== "boolean") throw formatError();
    return { id: condition.id, entityId: condition.entityId, description: condition.description, active: condition.active };
  });
  const knownFacts = value.knownFacts.map((fact) => {
    if (!record(fact) || !id(fact.actorId) || !id(fact.factId)) throw formatError();
    return { actorId: fact.actorId, factId: fact.factId };
  });
  const events = value.events.map((event) => {
    if (!record(event) || !id(event.id) || !text(event.description, 8192) || !list(event.entityIds) || !event.entityIds.every(id)) throw formatError();
    return { id: event.id, description: event.description, entityIds: event.entityIds as string[] };
  });
  return { protocolVersion: 1, time: { eraYear: value.time.eraYear, elapsedSeconds: value.time.elapsedSeconds, precision: "year" },
    locationId: value.locationId, protagonistId: value.protagonistId, entities, resources, relationships, conditions, knownFacts, events };
}
function shape(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw formatError();
  return value;
}
function requireFormat(condition: boolean): void { if (!condition) throw formatError(); }
function v2Text(value: unknown, maxBytes: number, multiline = false): value is string {
  return typeof value === "string" && value.trim().length > 0 && new TextEncoder().encode(value).length <= maxBytes &&
    !Array.from(value).some((char) => /[\u0000-\u001f\u007f-\u009f]/.test(char) && !(multiline && /[\n\r\t]/.test(char)));
}
function entityId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value); }
function commitId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
function nullableEntityId(value: unknown): value is string | null { return value === null || entityId(value); }
function enumValue<T extends string>(value: unknown, options: readonly T[]): value is T { return typeof value === "string" && options.includes(value as T); }
function unique(values: readonly unknown[]): boolean {
  const key = (value: unknown) => JSON.stringify(value, (_name, item: unknown) =>
    record(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
  return new Set(values.map(key)).size === values.length;
}
function parseSource(value: unknown): StateSource {
  if (!record(value)) throw formatError();
  if (value.type === "initial") { shape(value, ["type"]); return { type: "initial" }; }
  if (value.type === "legacy_snapshot") {
    shape(value, ["type", "turnId", "formatVersion"]);
    if (!(value.turnId === null || commitId(value.turnId)) || value.formatVersion !== 1) throw formatError();
    return { type: "legacy_snapshot", turnId: value.turnId, formatVersion: 1 };
  }
  shape(value, ["type", "operationId", "turnId", "eventId"]);
  if (value.type !== "turn" || !commitId(value.operationId) || !commitId(value.turnId) || !entityId(value.eventId)) throw formatError();
  return { type: "turn", operationId: value.operationId, turnId: value.turnId, eventId: value.eventId };
}
function parseFactKey(value: unknown): FactKey {
  if (!record(value)) throw formatError();
  switch (value.type) {
    case "entity_created": case "entity_name": case "entity_life":
      shape(value, ["type", "entityId"]); requireFormat(entityId(value.entityId)); break;
    case "entity_attribute":
      shape(value, ["type", "entityId", "key"]); requireFormat(entityId(value.entityId) && v2Text(value.key, 64)); break;
    case "entity_alias":
      shape(value, ["type", "entityId", "text"]); requireFormat(entityId(value.entityId) && v2Text(value.text, 256)); break;
    case "item_holding": shape(value, ["type", "itemId"]); requireFormat(entityId(value.itemId)); break;
    case "condition": shape(value, ["type", "conditionId"]); requireFormat(entityId(value.conditionId)); break;
    case "resource": shape(value, ["type", "ownerId", "key"]); requireFormat(entityId(value.ownerId) && v2Text(value.key, 64)); break;
    case "relationship":
      shape(value, ["type", "fromId", "toId", "kind"]); requireFormat(entityId(value.fromId) && entityId(value.toId) && value.fromId !== value.toId && v2Text(value.kind, 128)); break;
    case "event": shape(value, ["type", "eventId"]); requireFormat(entityId(value.eventId)); break;
    case "claim": shape(value, ["type", "claimId"]); requireFormat(entityId(value.claimId)); break;
    case "time": case "location": shape(value, ["type"]); break;
    default: throw formatError();
  }
  return value as unknown as FactKey;
}
const categories = ["injury", "illness", "obligation", "other", "legacy_unspecified"] as const;
const certainties = ["certain", "reported", "doubtful", "legacy_unspecified"] as const;
const acquisitions = ["observed", "told", "inferred", "legacy_unspecified"] as const;
const aliasKinds = ["former_name", "nickname", "title", "transliteration", "other"] as const;
function parseHolding(value: unknown): HoldingValue {
  const row = shape(value, ["status", "holderId", "placeId", "quantity", "unit"]);
  requireFormat(nullableEntityId(row.holderId) && nullableEntityId(row.placeId));
  if (row.status === "legacy_unknown") {
    requireFormat(row.holderId === null && row.placeId === null && row.quantity === null && row.unit === null);
  } else {
    requireFormat(row.status === "known" && count(row.quantity) && v2Text(row.unit, 64));
    requireFormat(row.quantity === 0 ? row.holderId === null && row.placeId === null : (row.holderId === null) !== (row.placeId === null));
  }
  return row as unknown as HoldingValue;
}
function parseStateV2(value: unknown): GameStateV2 {
  const row = shape(value, ["protocolVersion", "time", "locationId", "locationSource", "protagonistId", "entities", "resources", "relationships", "itemHoldings", "conditions", "events", "claims", "knowledge", "factObservations"]);
  requireFormat(row.protocolVersion === 2 && entityId(row.locationId) && entityId(row.protagonistId));
  const clock = shape(row.time, ["eraYear", "elapsedSeconds", "precision", "lastChangedSource"]);
  requireFormat(year(clock.eraYear) && count(clock.elapsedSeconds) && clock.precision === "year");
  const sources: StateSource[] = [parseSource(clock.lastChangedSource), parseSource(row.locationSource)];
  const bounded = (name: string, max: number): unknown[] => { if (!list(row[name], max)) throw formatError(); return row[name] as unknown[]; };
  const entities = bounded("entities", 512).map((entity) => {
    const e = shape(entity, ["id", "kind", "name", "alive", "attributes", "aliases", "createdSource", "nameSource", "lifeSource", "attributeSources"]);
    requireFormat(entityId(e.id) && enumValue(e.kind, ["person", "place", "organization", "item"]) && v2Text(e.name, 256));
    requireFormat(e.kind === "person" ? typeof e.alive === "boolean" : e.alive === null);
    if (!record(e.attributes) || !record(e.attributeSources) || Object.keys(e.attributes).length > 64) throw formatError();
    requireFormat(Object.keys(e.attributes).sort().join("\u0000") === Object.keys(e.attributeSources).sort().join("\u0000"));
    for (const [key, val] of Object.entries(e.attributes)) { requireFormat(v2Text(key, 64) && key === key.trim() && v2Text(val, 2048, true)); sources.push(parseSource(e.attributeSources[key])); }
    sources.push(parseSource(e.createdSource), parseSource(e.nameSource), parseSource(e.lifeSource));
    if (!list(e.aliases, 32)) throw formatError();
    const aliases = e.aliases.map((alias) => {
      const a = shape(alias, ["text", "kind", "source"]);
      requireFormat(v2Text(a.text, 256) && a.text !== e.name && enumValue(a.kind, aliasKinds)); sources.push(parseSource(a.source)); return a;
    });
    requireFormat(unique(aliases.map((a) => a.text))); return e as unknown as GameEntityV2;
  });
  requireFormat(unique(entities.map((e) => e.id)));
  const byId = new Map(entities.map((e) => [e.id, e]));
  requireFormat(byId.get(row.locationId as string)?.kind === "place" && byId.get(row.protagonistId as string)?.kind === "person");
  const refs = (ids: unknown): string[] => {
    if (!list(ids, 64) || !ids.every(entityId) || !unique(ids) || !ids.every((id) => byId.has(id))) throw formatError(); return ids;
  };
  const resources = bounded("resources", 512).map((resource) => {
    const r = shape(resource, ["ownerId", "key", "unit", "amount", "lastChangedSource"]);
    requireFormat(entityId(r.ownerId) && byId.has(r.ownerId as string) && v2Text(r.key, 64) && v2Text(r.unit, 64) && count(r.amount)); sources.push(parseSource(r.lastChangedSource)); return r;
  });
  requireFormat(unique(resources.map((r) => [r.ownerId, r.key])));
  const relations = bounded("relationships", 512).map((relation) => {
    const r = shape(relation, ["fromId", "toId", "kind", "strength", "lastChangedSource"]);
    requireFormat(entityId(r.fromId) && entityId(r.toId) && r.fromId !== r.toId && byId.has(r.fromId as string) && byId.has(r.toId as string) && v2Text(r.kind, 128) && signedInteger(r.strength) && Math.abs(r.strength) <= 100); sources.push(parseSource(r.lastChangedSource)); return r;
  });
  requireFormat(unique(relations.map((r) => [r.fromId, r.toId, r.kind])));
  const holdings = bounded("itemHoldings", 512).map((holding) => {
    const h = shape(holding, ["itemId", "value", "source"]);
    requireFormat(entityId(h.itemId) && byId.get(h.itemId as string)?.kind === "item");
    const v = parseHolding(h.value), s = parseSource(h.source); sources.push(s);
    requireFormat(v.status !== "legacy_unknown" || s.type === "legacy_snapshot");
    requireFormat(v.holderId === null || ["person", "organization"].includes(byId.get(v.holderId)?.kind ?? ""));
    requireFormat(v.placeId === null || byId.get(v.placeId)?.kind === "place"); return h;
  });
  requireFormat(unique(holdings.map((h) => h.itemId)) && entities.filter((e) => e.kind === "item").every((e) => holdings.some((h) => h.itemId === e.id)));
  const conditions = bounded("conditions", 512).map((condition) => {
    const c = shape(condition, ["id", "entityId", "description", "category", "active", "startedSource", "lastChangedSource", "resolvedSource"]);
    requireFormat(entityId(c.id) && entityId(c.entityId) && byId.has(c.entityId as string) && v2Text(c.description, 2048, true) && enumValue(c.category, categories) && typeof c.active === "boolean");
    const start = parseSource(c.startedSource), changed = parseSource(c.lastChangedSource); sources.push(start, changed);
    requireFormat(c.category !== "legacy_unspecified" || start.type === "legacy_snapshot");
    requireFormat(c.active ? c.resolvedSource === null : c.resolvedSource !== null);
    if (c.resolvedSource !== null) { const resolved = parseSource(c.resolvedSource); sources.push(resolved); requireFormat(JSON.stringify(changed) === JSON.stringify(resolved)); } return c;
  });
  requireFormat(unique(conditions.map((c) => c.id)));
  const events = bounded("events", 4096).map((event) => {
    const e = shape(event, ["id", "description", "entityIds", "disclosure", "createdSource"]);
    requireFormat(entityId(e.id) && v2Text(e.description, 2048, true) && enumValue(e.disclosure, ["public", "restricted", "legacy_unspecified"])); refs(e.entityIds);
    const s = parseSource(e.createdSource); sources.push(s);
    requireFormat((e.disclosure !== "legacy_unspecified" || s.type === "legacy_snapshot") && (s.type !== "turn" || s.eventId === e.id)); return e;
  });
  requireFormat(unique(events.map((e) => e.id)));
  const eventIds = new Set(events.map((e) => e.id));
  const evidence = (ids: unknown): void => { requireFormat(list(ids, 64) && ids.every(entityId) && unique(ids) && ids.every((id) => eventIds.has(id))); };
  const claims = bounded("claims", 4096).map((claim) => {
    const c = shape(claim, ["id", "text", "entityIds", "assessment", "evidenceEventIds", "createdSource", "lastChangedSource"]);
    requireFormat(entityId(c.id) && v2Text(c.text, 2048, true) && enumValue(c.assessment, ["unverified", "supported", "refuted"])); refs(c.entityIds); evidence(c.evidenceEventIds);
    requireFormat(c.assessment === "unverified" || (c.evidenceEventIds as unknown[]).length > 0); sources.push(parseSource(c.createdSource), parseSource(c.lastChangedSource)); return c;
  });
  requireFormat(unique(claims.map((c) => c.id)));
  const knowledge = bounded("knowledge", 4096).map((known) => {
    const k = shape(known, ["actorId", "targetType", "targetId", "certainty", "acquisitionMode", "acquisitionEventId", "source", "knownText", "knownEvidenceEventIds"]);
    requireFormat(entityId(k.actorId) && byId.get(k.actorId as string)?.kind === "person" && entityId(k.targetId) && enumValue(k.targetType, ["event", "claim"]) && enumValue(k.certainty, certainties) && enumValue(k.acquisitionMode, acquisitions) && nullableEntityId(k.acquisitionEventId) && v2Text(k.knownText, 2048, true));
    const target = k.targetType === "event" ? events.find((e) => e.id === k.targetId)?.description : claims.find((c) => c.id === k.targetId)?.text;
    requireFormat(target === k.knownText); evidence(k.knownEvidenceEventIds);
    requireFormat(k.targetType !== "event" || (k.knownEvidenceEventIds as unknown[]).length === 0);
    const s = parseSource(k.source); sources.push(s);
    requireFormat(s.type === "legacy_snapshot" ? k.acquisitionEventId === null || eventIds.has(k.acquisitionEventId) :
      k.certainty !== "legacy_unspecified" && k.acquisitionMode !== "legacy_unspecified" && s.type === "turn" && s.eventId === k.acquisitionEventId); return k;
  });
  requireFormat(unique(knowledge.map((k) => [k.actorId, k.targetType, k.targetId])));
  const factExists = (fact: FactKey): boolean => {
    switch (fact.type) {
      case "entity_created": case "entity_name": return byId.has(fact.entityId);
      case "entity_life": return byId.get(fact.entityId)?.kind === "person";
      case "entity_attribute": return Object.hasOwn(byId.get(fact.entityId)?.attributes ?? {}, fact.key);
      case "entity_alias": return byId.has(fact.entityId); // A formerly observed alias may now be the formal name.
      case "item_holding": return holdings.some((h) => h.itemId === fact.itemId);
      case "condition": return conditions.some((c) => c.id === fact.conditionId);
      case "resource": return resources.some((r) => r.ownerId === fact.ownerId && r.key === fact.key);
      case "relationship": return relations.some((r) => r.fromId === fact.fromId && r.toId === fact.toId && r.kind === fact.kind);
      case "event": return eventIds.has(fact.eventId);
      case "claim": return claims.some((c) => c.id === fact.claimId);
      case "time": case "location": return true;
    }
  };
  const observations = bounded("factObservations", 4096).map((observation) => {
    const o = shape(observation, ["actorId", "factKey", "factSource", "acquisitionSource"]);
    requireFormat(entityId(o.actorId) && byId.get(o.actorId as string)?.kind === "person");
    requireFormat(factExists(parseFactKey(o.factKey)));
    const acquisition = parseSource(o.acquisitionSource); requireFormat(acquisition.type === "turn");
    sources.push(parseSource(o.factSource), acquisition); return o;
  });
  requireFormat(unique(observations.map((o) => [o.actorId, o.factKey])));
  for (const s of sources) requireFormat(s.type !== "turn" || eventIds.has(s.eventId));
  return row as unknown as GameStateV2;
}
/** Strict native boundary decoder; does not create or repair world facts. */
export function parseGameState(value: unknown): GameState {
  if (!record(value)) throw formatError();
  return value.protocolVersion === 2 ? parseStateV2(value) : parseStateV1(value);
}
function parseOperation(value: unknown): GameOperation | null {
  if (value === null) return null;
  if (!record(value) || !id(value.operationId) || !nullableId(value.expectedHeadTurnId) || !actionKind(value.actionKind) ||
    !text(value.actionText, 32768) || !status(value.status) || !code(value.errorCode) || !count(value.createdAtMs)) throw formatError();
  return { operationId: value.operationId, expectedHeadTurnId: value.expectedHeadTurnId, actionKind: value.actionKind,
    actionText: value.actionText, status: value.status, errorCode: value.errorCode, createdAtMs: value.createdAtMs };
}
export function parseWorld(value: unknown): GameWorld {
  if (!record(value) || !(value.branchId === "main" || (typeof value.branchId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value.branchId))) || !nullableId(value.headTurnId) || !count(value.turnCount) ||
    !text(value.openingNarrative) || !text(value.narrativePolicy, 8192) || !list(value.turns, 100)) throw formatError();
  const turns = value.turns.map((turn): GameTurn => {
    if (!record(turn) || !id(turn.turnId) || !nullableId(turn.parentTurnId) || !actionKind(turn.actionKind) ||
      !text(turn.actionText, 32768) || !text(turn.narrative) || !count(turn.createdAtMs)) throw formatError();
    return { turnId: turn.turnId, parentTurnId: turn.parentTurnId, actionKind: turn.actionKind,
      actionText: turn.actionText, narrative: turn.narrative, choices: parseChoices(turn.choices),
      state: parseGameState(turn.state), createdAtMs: turn.createdAtMs };
  });
  return { setup: parseSetup(value.setup), branchId: value.branchId, headTurnId: value.headTurnId, turnCount: value.turnCount,
    state: parseGameState(value.state), openingNarrative: value.openingNarrative,
    openingChoices: parseChoices(value.openingChoices), turns, latestOperation: parseOperation(value.latestOperation), narrativePolicy: value.narrativePolicy };
}
function capability(value: unknown): value is ProviderCapability { return value === "unknown" || value === "supported" || value === "unsupported"; }
export function parseContextBudget(value: unknown): GameContextBudget {
  if (!record(value) || !count(value.maxInputBytes) || value.maxInputBytes < 1 || value.maxInputBytes > 4 * 1024 * 1024 ||
    !count(value.contextLimitTokens) || value.contextLimitTokens < 1 || value.contextLimitTokens > 4 * 1024 * 1024 ||
    !count(value.outputReserveTokens) || value.outputReserveTokens < 1 || !count(value.transportReserveTokens) ||
    value.outputReserveTokens + value.transportReserveTokens >= value.contextLimitTokens) throw formatError();
  return { maxInputBytes: value.maxInputBytes, contextLimitTokens: value.contextLimitTokens,
    outputReserveTokens: value.outputReserveTokens, transportReserveTokens: value.transportReserveTokens };
}
function parseProfile(value: unknown): GameProviderProfile {
  if (!record(value) || typeof value.configured !== "boolean" || !count(value.revision) || !record(value.capabilities) ||
    !capability(value.capabilities.streaming) || !capability(value.capabilities.structuredOutput)) throw formatError();
  let config: GameProviderProfile["config"] = null;
  if (value.config !== null) {
    if (!record(value.config) || !text(value.config.endpoint, 2048) || !text(value.config.model, 256) || !count(value.config.revision) ||
      typeof value.config.allowInsecureHttp !== "boolean") throw formatError();
    config = { endpoint: value.config.endpoint, model: value.config.model, revision: value.config.revision,
      allowInsecureHttp: value.config.allowInsecureHttp,
      contextBudget: value.config.contextBudget === undefined ? { ...defaultContextBudget } : parseContextBudget(value.config.contextBudget) };
  }
  return { config, configured: value.configured, revision: value.revision, capabilities: {
    streaming: value.capabilities.streaming, structuredOutput: value.capabilities.structuredOutput } };
}
function parseDiagnostics(value: unknown): GameDiagnostics {
  if (!record(value) || !(value.httpStatus === null || (count(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)) ||
    !count(value.elapsedMs) || !count(value.attempts) || value.attempts > 1) throw formatError();
  let usage: GameDiagnostics["usage"] = null;
  if (value.usage !== null) {
    if (!record(value.usage) || !count(value.usage.promptTokens) || !count(value.usage.completionTokens) || !count(value.usage.totalTokens) ||
      value.usage.promptTokens + value.usage.completionTokens !== value.usage.totalTokens) throw formatError();
    usage = { promptTokens: value.usage.promptTokens, completionTokens: value.usage.completionTokens, totalTokens: value.usage.totalTokens };
  }
  return { httpStatus: value.httpStatus, usage, elapsedMs: value.elapsedMs, attempts: value.attempts };
}
function parseEvent(value: unknown): GameEvent | null {
  if (!record(value) || !id(value.operationId) || !count(value.sequence)) return null;
  if (value.kind === "phase" && status(value.phase) && (value.errorCode === undefined || code(value.errorCode))) {
    return { operationId: value.operationId, sequence: value.sequence, kind: "phase", phase: value.phase,
      ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}) };
  }
  if (value.kind === "narrative" && text(value.text)) return { operationId: value.operationId, sequence: value.sequence, kind: "narrative", text: value.text };
  return null;
}
async function call(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!isTauri()) throw new GameError(gameT("game.error.unavailable"));
  try { return await invoke<unknown>(command, args); }
  catch (error: unknown) {
    // Native/server messages may contain private details. Retain only whitelisted codes.
    const errorCode = record(error) && typeof error.code === "string" && Object.hasOwn(codeKeys, error.code) ? error.code : undefined;
    throw new GameError(describeGameCode(errorCode), errorCode);
  }
}

function parseObservedValue(fact: FactKey, value: unknown): void {
  switch (fact.type) {
    case "entity_created": {
      const e = shape(value, ["id", "kind"]); requireFormat(e.id === fact.entityId && enumValue(e.kind, ["person", "place", "organization", "item"])); break;
    }
    case "entity_name": requireFormat(v2Text(value, 256)); break;
    case "entity_life": requireFormat(typeof value === "boolean"); break;
    case "entity_attribute": requireFormat(v2Text(value, 2048, true)); break;
    case "entity_alias": {
      const a = shape(value, ["text", "kind"]); requireFormat(a.text === fact.text && enumValue(a.kind, aliasKinds)); break;
    }
    case "item_holding": parseHolding(value); break;
    case "condition": {
      const c = shape(value, ["id", "entityId", "description", "category", "active"]);
      requireFormat(c.id === fact.conditionId && entityId(c.entityId) && v2Text(c.description, 2048, true) && enumValue(c.category, categories) && typeof c.active === "boolean"); break;
    }
    case "resource": {
      const r = shape(value, ["ownerId", "key", "unit", "amount"]);
      requireFormat(r.ownerId === fact.ownerId && r.key === fact.key && v2Text(r.unit, 64) && count(r.amount)); break;
    }
    case "relationship": {
      const r = shape(value, ["fromId", "toId", "kind", "strength"]);
      requireFormat(r.fromId === fact.fromId && r.toId === fact.toId && r.kind === fact.kind && signedInteger(r.strength) && Math.abs(r.strength) <= 100); break;
    }
    case "event": {
      const e = shape(value, ["id", "description", "entityIds", "disclosure"]);
      requireFormat(e.id === fact.eventId && v2Text(e.description, 2048, true) && list(e.entityIds, 64) && e.entityIds.every(entityId) && unique(e.entityIds) && enumValue(e.disclosure, ["public", "restricted", "legacy_unspecified"])); break;
    }
    case "claim": {
      const c = shape(value, ["id", "text", "entityIds", "assessment", "evidenceEventIds"]);
      requireFormat(c.id === fact.claimId && v2Text(c.text, 2048, true) && list(c.entityIds, 64) && c.entityIds.every(entityId) && unique(c.entityIds) && enumValue(c.assessment, ["unverified", "supported", "refuted"]) && list(c.evidenceEventIds, 64) && c.evidenceEventIds.every(entityId) && unique(c.evidenceEventIds)); break;
    }
    case "time": {
      const clock = shape(value, ["eraYear", "precision", "elapsedSeconds"]); requireFormat(year(clock.eraYear) && clock.precision === "year" && count(clock.elapsedSeconds)); break;
    }
    case "location": requireFormat(entityId(value)); break;
  }
}
export function parseGameActorView(value: unknown, branchId = "main"): GameActorView {
  requireFormat(branchId === "main" || /^[A-Za-z0-9_-]{8,128}$/.test(branchId));
  const view = shape(value, ["worldId", "headTurnId", "actorId", "entities", "knowledge", "observedFacts"]);
  if (!commitId(view.worldId) || !(view.headTurnId === null || commitId(view.headTurnId)) || !entityId(view.actorId) ||
    !list(view.entities, 512) || !list(view.knowledge, 4096) || !list(view.observedFacts, 16384)) throw formatError();
  const entities = view.entities.map((entity) => {
    const e = shape(entity, ["entityId", "name", "alive", "attributes", "aliases"]);
    requireFormat(entityId(e.entityId) && (e.name === null || v2Text(e.name, 256)) && (e.alive === null || typeof e.alive === "boolean"));
    if (!record(e.attributes) || Object.keys(e.attributes).length > 64 || !list(e.aliases, 32)) throw formatError();
    requireFormat(Object.entries(e.attributes).every(([key, value]) => v2Text(key, 64) && v2Text(value, 2048, true)) && e.aliases.every((alias) => v2Text(alias, 256)) && unique(e.aliases));
    return e as unknown as ActorKnownEntity;
  });
  requireFormat(unique(entities.map((e) => e.entityId)));
  const knowledge = view.knowledge.map((known) => {
    const k = shape(known, ["targetType", "targetId", "text", "certainty", "acquisitionMode", "knownEvidenceEventIds"]);
    requireFormat(enumValue(k.targetType, ["event", "claim"]) && entityId(k.targetId) && v2Text(k.text, 2048, true) && enumValue(k.certainty, certainties) && enumValue(k.acquisitionMode, acquisitions) && list(k.knownEvidenceEventIds, 64) && k.knownEvidenceEventIds.every(entityId) && unique(k.knownEvidenceEventIds));
    return k as unknown as ActorKnowledge;
  });
  requireFormat(unique(knowledge.map((k) => [k.targetType, k.targetId])));
  const observedFacts = view.observedFacts.map((observed) => {
    const o = shape(observed, ["factKey", "value"]); const factKey = parseFactKey(o.factKey); parseObservedValue(factKey, o.value); return { factKey, value: o.value };
  });
  requireFormat(unique(observedFacts.map((o) => o.factKey)));
  return { worldId: view.worldId, branchId, headTurnId: view.headTurnId, actorId: view.actorId, entities, knowledge, observedFacts };
}

export async function listGameWorlds(): Promise<GameWorldList> {
  const value = await call("list_game_worlds");
  if (!record(value) || !list(value.worlds, 10000) || !count(value.unavailableCount)) throw formatError();
  const worlds = value.worlds.map((world): WorldSummary => {
    if (!record(world) || !id(world.worldId) || !nonemptyText(world.title, 256) || !nonemptyText(world.country, 128) || !year(world.eraYear) ||
      !nonemptyText(world.protagonistName, 128) || !nullableId(world.headTurnId) || !count(world.turnCount)) throw formatError();
    return { worldId: world.worldId, title: world.title, country: world.country, eraYear: world.eraYear,
      protagonistName: world.protagonistName, headTurnId: world.headTurnId, turnCount: world.turnCount };
  });
  return { worlds, unavailableCount: value.unavailableCount };
}
export async function createGameWorld(setup: WorldSetup): Promise<GameWorld> {
  const value = parseWorld(await call("create_game_world", { setup }));
  if (value.setup.worldId !== setup.worldId) throw formatError();
  return value;
}
export async function getGameWorld(worldId: string, branchId = "main"): Promise<GameWorld> {
  const value = parseWorld(await call("get_game_world", { worldId, branchId }));
  if (value.setup.worldId !== worldId || value.branchId !== branchId) throw formatError();
  return value;
}
export async function upgradeGameWorld(worldId: string, expectedHeadTurnId: string | null): Promise<GameWorld> {
  const value = parseWorld(await call("upgrade_game_world", { worldId, expectedHeadTurnId }));
  if (value.setup.worldId !== worldId || value.state.protocolVersion !== 2 || value.headTurnId !== expectedHeadTurnId) throw formatError();
  return value;
}
export async function getGameActorView(worldId: string, actorId: string, branchId = "main"): Promise<GameActorView> {
  const value = parseGameActorView(await call("get_game_actor_view", { worldId, actorId, branchId }), branchId);
  if (value.worldId !== worldId || value.actorId !== actorId) throw formatError();
  return value;
}
export async function startGameTurn(request: GameTurnRequest, providerKind: ProviderKind,
  onEvent: (event: GameEvent) => void, onInvalidEvent: () => void): Promise<GameWorld> {
  const channel = new Channel<unknown>();
  channel.onmessage = (value) => {
    const event = parseEvent(value);
    if (!event) onInvalidEvent();
    else if (event.operationId === request.operationId) onEvent(event);
  };
  const value = parseWorld(await call("start_game_turn", { request, providerKind, onEvent: channel }));
  if (value.setup.worldId !== request.worldId || value.branchId !== request.branchId) throw formatError();
  return value;
}
export async function cancelGameTurn(operationId: string): Promise<{ operationId: string; state: "cancel_requested" | "finished" | "not_found" }> {
  const value = await call("cancel_game_turn", { operationId });
  if (!record(value) || value.operationId !== operationId || (value.state !== "cancel_requested" && value.state !== "finished" && value.state !== "not_found")) throw formatError();
  return { operationId, state: value.state };
}
export async function setGamePolicy(worldId: string, policy: string, branchId = "main", expectedHeadTurnId?: string | null): Promise<GameWorld> {
  const value = parseWorld(await call("set_game_policy", { worldId, policy, branchId, ...(expectedHeadTurnId === undefined ? {} : { expectedHeadTurnId }) }));
  if (value.setup.worldId !== worldId || value.branchId !== branchId || (expectedHeadTurnId !== undefined && value.headTurnId !== expectedHeadTurnId)) throw formatError();
  return value;
}
export async function getGameProvider(): Promise<GameProviderProfile> { return parseProfile(await call("get_game_provider")); }
export async function saveGameProvider(endpoint: string, model: string, token: string | null, expectedRevision: number, allowInsecureHttp = false, contextBudget?: GameContextBudget): Promise<GameProviderProfile> {
  return parseProfile(await call("save_game_provider", { endpoint, model, token, expectedRevision, allowInsecureHttp,
    ...(contextBudget ? { contextBudget: parseContextBudget(contextBudget) } : {}) }));
}
export async function deleteGameProvider(expectedRevision: number): Promise<GameProviderProfile> {
  return parseProfile(await call("delete_game_provider", { expectedRevision }));
}
function parsePresets(value: unknown): GamePreset[] {
  if (!list(value, 1000)) throw formatError();
  return value.map((preset) => {
    if (!record(preset) || !id(preset.presetId) || !id(preset.name)) throw formatError();
    return { presetId: preset.presetId, name: preset.name, setup: parseSetup(preset.setup) };
  });
}
export async function listGamePresets(): Promise<GamePreset[]> { return parsePresets(await call("list_game_presets")); }
export async function saveGamePreset(name: string, setup: WorldSetup): Promise<GamePreset[]> {
  return parsePresets(await call("save_game_preset", { name, setup }));
}
export async function testGameProvider(): Promise<GameProviderTest> {
  const value = await call("test_game_provider");
  if (!record(value) || (value.status !== "completed" && value.status !== "failed") || !code(value.errorCode)) throw formatError();
  return { status: value.status, errorCode: value.errorCode, diagnostics: parseDiagnostics(value.diagnostics) };
}
