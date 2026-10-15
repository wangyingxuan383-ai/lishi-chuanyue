import { invoke, isTauri } from "@tauri-apps/api/core";
import { parseWorld, type GameActionKind, type GameWorld } from "./gameClient";
import { branchT as t, type BranchPlainMessageKey } from "./gameBranchMessages";
export interface BranchCard {
  branchId: string; parentBranchId: string | null; forkTurnId: string | null; forkTurnCount: number;
  headTurnId: string | null; turnCount: number; name: string; archived: boolean; revision: number;
  annotationForkWatermark: number; createdAtMs: number;
}
export interface ForkBranchRequest {
  worldId: string; sourceBranchId: string; expectedHeadTurnId: string | null; expectedRevision: number;
  operationId: string; newBranchId: string; name: string; forkTurnId: string | null;
}
export interface BranchEditRequest { worldId: string; branchId: string; expectedHeadTurnId: string | null; expectedRevision: number; operationId: string }
export interface RewriteAction { turnId: string; actionKind: GameActionKind; actionText: string }
export interface BranchCreated { branch: BranchCard; world: GameWorld; originalAction: RewriteAction | null }
export interface BranchUpgradeReceipt { fromVersion: 2; toVersion: 3; backupBasename: string; backupSha256: string; headTurnId: string | null; turnCount: number; completedAtMs: number }
export type FactCorrection = { kind: "name"; name: string } | { kind: "cash"; amount: number };
export class BranchError extends Error { constructor(message: string, readonly code?: string) { super(message); this.name = "BranchError"; } }
function invalid(): never { throw new BranchError(t("branches.error.format")); }
function check(condition: unknown): asserts condition { if (!condition) invalid(); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function shape(value: unknown, fields: string[]): Record<string, unknown> {
  check(object(value) && fields.every((field) => Object.hasOwn(value, field)) && Object.keys(value).every((field) => fields.includes(field))); return value;
}
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value); }
function branchId(value: unknown): value is string { return value === "main" || id(value); }
function nullableId(value: unknown): value is string | null { return value === null || id(value); }
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.trim().length > 0) && value.length <= max && new TextEncoder().encode(value).length <= max
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    && !Array.from(value).some((character) => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; });
}
export function parseBranchCard(value: unknown): BranchCard {
  const row = shape(value, ["branchId", "parentBranchId", "forkTurnId", "forkTurnCount", "headTurnId", "turnCount", "name", "archived", "revision", "annotationForkWatermark", "createdAtMs"]);
  check(branchId(row.branchId) && (row.parentBranchId === null || branchId(row.parentBranchId)) && row.parentBranchId !== row.branchId
    && nullableId(row.forkTurnId) && nullableId(row.headTurnId) && integer(row.forkTurnCount) && integer(row.turnCount) && row.forkTurnCount <= row.turnCount
    && ((row.forkTurnId === null) === (row.forkTurnCount === 0)) && ((row.headTurnId === null) === (row.turnCount === 0))
    && text(row.name, 256) && !/[\r\n\t]/.test(row.name) && typeof row.archived === "boolean" && integer(row.revision)
    && integer(row.annotationForkWatermark) && integer(row.createdAtMs)
    && (row.branchId === "main" ? row.parentBranchId === null && row.forkTurnCount === 0 : row.parentBranchId !== null));
  return row as unknown as BranchCard;
}
export function parseBranchList(value: unknown): BranchCard[] | null {
  if (value === null) return null;
  check(Array.isArray(value) && value.length > 0 && value.length <= 10000);
  const cards = value.map(parseBranchCard);
  const map = new Map(cards.map((card) => [card.branchId, card]));
  check(map.size === cards.length && map.has("main"));
  for (const card of cards) {
    let current = card; const seen = new Set<string>();
    while (current.parentBranchId !== null) {
      check(!seen.has(current.branchId) && seen.size < 256); seen.add(current.branchId);
      const parent = map.get(current.parentBranchId); check(parent && current.forkTurnCount <= parent.turnCount); current = parent;
    }
    check(current.branchId === "main");
  }
  return cards;
}
export function parseBranchCreated(value: unknown): BranchCreated {
  const row = shape(value, ["branch", "world", "originalAction"]);
  const branch = parseBranchCard(row.branch); const world = parseWorld(row.world);
  check(world.state.protocolVersion === 2 && world.branchId === branch.branchId && world.headTurnId === branch.headTurnId && world.turnCount === branch.turnCount);
  let originalAction: RewriteAction | null = null;
  if (row.originalAction !== null) {
    const action = shape(row.originalAction, ["turnId", "actionKind", "actionText"]);
    check(id(action.turnId) && (action.actionKind === "action" || action.actionKind === "continue") && text(action.actionText, 32768, action.actionKind === "continue"));
    originalAction = action as unknown as RewriteAction;
  }
  return { branch, world, originalAction };
}
export function parseBranchUpgrade(value: unknown): BranchUpgradeReceipt {
  const row = shape(value, ["fromVersion", "toVersion", "backupBasename", "backupSha256", "headTurnId", "turnCount", "completedAtMs"]);
  check(row.fromVersion === 2 && row.toVersion === 3 && typeof row.backupBasename === "string" && /^branches-[A-Za-z0-9_-]+\.sqlite$/.test(row.backupBasename)
    && typeof row.backupSha256 === "string" && /^[a-f0-9]{64}$/.test(row.backupSha256) && nullableId(row.headTurnId) && integer(row.turnCount)
    && ((row.headTurnId === null) === (row.turnCount === 0)) && integer(row.completedAtMs));
  return row as unknown as BranchUpgradeReceipt;
}
const errorKeys: Record<string, BranchPlainMessageKey> = {
  game_busy: "branches.error.busy", game_world_busy: "branches.error.busy", game_stale_head: "branches.error.stale",
  game_upgrade_required: "branches.error.upgrade", game_incompatible_schema: "branches.error.upgrade",
  game_invalid_request: "branches.error.invalid", game_duplicate: "branches.error.duplicate",
};
async function call(command: string, args: Record<string, unknown>): Promise<unknown> {
  if (!isTauri()) throw new BranchError(t("branches.unavailable"));
  try { return await invoke<unknown>(command, args); }
  catch (cause) {
    const code = object(cause) && typeof cause.code === "string" && Object.hasOwn(errorKeys, cause.code) ? cause.code : undefined;
    throw new BranchError(t(code ? errorKeys[code] : "branches.error.unknown"), code);
  }
}
export function describeBranchError(cause: unknown): string { return cause instanceof BranchError ? cause.message : t("branches.error.unknown"); }
export async function listGameBranches(worldId: string): Promise<BranchCard[] | null> { return parseBranchList(await call("list_game_branches", { worldId })); }
export async function enableGameBranches(worldId: string, expectedHeadTurnId: string | null): Promise<BranchUpgradeReceipt> {
  const receipt = parseBranchUpgrade(await call("enable_game_branches", { worldId, expectedHeadTurnId })); check(receipt.headTurnId === expectedHeadTurnId); return receipt;
}
function boundCreated(value: unknown, request: ForkBranchRequest): BranchCreated {
  const result = parseBranchCreated(value);
  check(result.world.setup.worldId === request.worldId && result.branch.branchId === request.newBranchId && result.branch.parentBranchId === request.sourceBranchId && !result.branch.archived); return result;
}
export async function forkGameBranch(request: ForkBranchRequest, rewriteTurnId?: string): Promise<BranchCreated> {
  const result = boundCreated(await call("fork_game_branch", { request, ...(rewriteTurnId === undefined ? {} : { rewriteTurnId }) }), request);
  check(rewriteTurnId === undefined ? result.originalAction === null && result.branch.forkTurnId === request.forkTurnId
    : result.originalAction?.turnId === rewriteTurnId); return result;
}
export async function editGameBranch(request: BranchEditRequest, changes: { name: string } | { archived: boolean }): Promise<BranchCard> {
  const card = parseBranchCard(await call("edit_game_branch", { request, ...changes }));
  check(card.branchId === request.branchId && card.headTurnId === request.expectedHeadTurnId && card.revision === request.expectedRevision + 1);
  if ("name" in changes) check(card.name === changes.name); else check(card.archived === changes.archived);
  return card;
}
export async function correctGameFact(request: ForkBranchRequest, correctionOperationId: string, correction: FactCorrection): Promise<BranchCreated> {
  const result = boundCreated(await call("correct_game_fact", { request, correctionOperationId, correction }), request);
  check(result.originalAction === null && result.branch.forkTurnId === request.expectedHeadTurnId && result.world.headTurnId === correctionOperationId
    && result.branch.turnCount === result.branch.forkTurnCount + 1); return result;
}
