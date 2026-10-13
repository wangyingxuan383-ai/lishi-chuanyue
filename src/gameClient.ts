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
export interface GameState {
  protocolVersion: 1;
  time: { eraYear: number; elapsedSeconds: number; precision: "year" };
  locationId: string; protagonistId: string; entities: GameEntity[];
  resources: { ownerId: string; key: string; unit: string; amount: number }[];
  relationships: { fromId: string; toId: string; kind: string; strength: number }[];
  conditions: { id: string; entityId: string; description: string; active: boolean }[];
  knownFacts: { actorId: string; factId: string }[];
  events: { id: string; description: string; entityIds: string[] }[];
}
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
  setup: WorldSetup; branchId: "main"; headTurnId: string | null; turnCount: number;
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
  operationId: string; worldId: string; branchId: "main";
  expectedHeadTurnId: string | null; actionKind: GameActionKind; actionText: string;
}
export type GameEvent = {
  operationId: string; sequence: number; kind: "phase"; phase: GameStatus; errorCode?: string;
} | { operationId: string; sequence: number; kind: "narrative"; text: string };
export type ProviderCapability = "unknown" | "supported" | "unsupported";
export interface GameProviderProfile {
  config: { endpoint: string; model: string; revision: number; allowInsecureHttp: boolean } | null;
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
function parseState(value: unknown): GameState {
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
function parseOperation(value: unknown): GameOperation | null {
  if (value === null) return null;
  if (!record(value) || !id(value.operationId) || !nullableId(value.expectedHeadTurnId) || !actionKind(value.actionKind) ||
    !text(value.actionText, 32768) || !status(value.status) || !code(value.errorCode) || !count(value.createdAtMs)) throw formatError();
  return { operationId: value.operationId, expectedHeadTurnId: value.expectedHeadTurnId, actionKind: value.actionKind,
    actionText: value.actionText, status: value.status, errorCode: value.errorCode, createdAtMs: value.createdAtMs };
}
function parseWorld(value: unknown): GameWorld {
  if (!record(value) || value.branchId !== "main" || !nullableId(value.headTurnId) || !count(value.turnCount) ||
    !text(value.openingNarrative) || !text(value.narrativePolicy, 8192) || !list(value.turns, 100)) throw formatError();
  const turns = value.turns.map((turn): GameTurn => {
    if (!record(turn) || !id(turn.turnId) || !nullableId(turn.parentTurnId) || !actionKind(turn.actionKind) ||
      !text(turn.actionText, 32768) || !text(turn.narrative) || !count(turn.createdAtMs)) throw formatError();
    return { turnId: turn.turnId, parentTurnId: turn.parentTurnId, actionKind: turn.actionKind,
      actionText: turn.actionText, narrative: turn.narrative, choices: parseChoices(turn.choices),
      state: parseState(turn.state), createdAtMs: turn.createdAtMs };
  });
  return { setup: parseSetup(value.setup), branchId: "main", headTurnId: value.headTurnId, turnCount: value.turnCount,
    state: parseState(value.state), openingNarrative: value.openingNarrative,
    openingChoices: parseChoices(value.openingChoices), turns, latestOperation: parseOperation(value.latestOperation), narrativePolicy: value.narrativePolicy };
}
function capability(value: unknown): value is ProviderCapability { return value === "unknown" || value === "supported" || value === "unsupported"; }
function parseProfile(value: unknown): GameProviderProfile {
  if (!record(value) || typeof value.configured !== "boolean" || !count(value.revision) || !record(value.capabilities) ||
    !capability(value.capabilities.streaming) || !capability(value.capabilities.structuredOutput)) throw formatError();
  let config: GameProviderProfile["config"] = null;
  if (value.config !== null) {
    if (!record(value.config) || !text(value.config.endpoint, 2048) || !text(value.config.model, 256) || !count(value.config.revision) ||
      typeof value.config.allowInsecureHttp !== "boolean") throw formatError();
    config = { endpoint: value.config.endpoint, model: value.config.model, revision: value.config.revision,
      allowInsecureHttp: value.config.allowInsecureHttp };
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
export async function getGameWorld(worldId: string): Promise<GameWorld> {
  const value = parseWorld(await call("get_game_world", { worldId }));
  if (value.setup.worldId !== worldId) throw formatError();
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
  if (value.setup.worldId !== request.worldId) throw formatError();
  return value;
}
export async function cancelGameTurn(operationId: string): Promise<{ operationId: string; state: "cancel_requested" | "finished" | "not_found" }> {
  const value = await call("cancel_game_turn", { operationId });
  if (!record(value) || value.operationId !== operationId || (value.state !== "cancel_requested" && value.state !== "finished" && value.state !== "not_found")) throw formatError();
  return { operationId, state: value.state };
}
export async function setGamePolicy(worldId: string, policy: string): Promise<GameWorld> {
  const value = parseWorld(await call("set_game_policy", { worldId, policy }));
  if (value.setup.worldId !== worldId) throw formatError();
  return value;
}
export async function getGameProvider(): Promise<GameProviderProfile> { return parseProfile(await call("get_game_provider")); }
export async function saveGameProvider(endpoint: string, model: string, token: string | null, expectedRevision: number, allowInsecureHttp = false): Promise<GameProviderProfile> {
  return parseProfile(await call("save_game_provider", { endpoint, model, token, expectedRevision, allowInsecureHttp }));
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
