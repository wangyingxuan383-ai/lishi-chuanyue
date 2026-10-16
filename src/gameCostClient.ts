import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CallAttempt } from "./gameCallClient";

export type PriceCurrency = "CNY" | "USD";
export interface ModelPrice { model: string; currency: PriceCurrency; inputPerMillion: string; outputPerMillion: string }
export interface PriceSettings { revision: number; entries: ModelPrice[] }
export interface PriceUpdate extends ModelPrice { expectedRevision: number }
export interface CostEstimate { currency: PriceCurrency; totalAmount: string; roundedToZero: boolean }
export interface CostAttempt { worldId: string; branchId: string; operationId: string; sequence: 1 | 2; model: string; estimate: CostEstimate | null }
export interface CostReply { priceRevision: number; attempts: CostAttempt[] }

function invalid(): never { throw Error("game_price_invalid"); }
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const currency = (value: unknown): value is PriceCurrency => value === "CNY" || value === "USD";
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) invalid();
}
export function validPriceModel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= 256 && !/[\s\p{Cc}]/u.test(value);
}
export function normalizePriceInput(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,6})?$/u.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (whole.length === 7 && (whole !== "1000000" || /[1-9]/u.test(fraction))) return null;
  return `${whole}.${fraction.padEnd(6, "0")}`;
}
const canonicalPrice = (value: unknown): value is string => typeof value === "string" && normalizePriceInput(value) === value;
function parsePrice(value: unknown): ModelPrice {
  if (!object(value) || !validPriceModel(value.model) || !currency(value.currency) || !canonicalPrice(value.inputPerMillion) || !canonicalPrice(value.outputPerMillion)) invalid();
  keys(value, ["model", "currency", "inputPerMillion", "outputPerMillion"]);
  return value as unknown as ModelPrice;
}
export function parsePriceSettings(value: unknown): PriceSettings {
  if (!object(value) || !integer(value.revision) || !Array.isArray(value.entries) || value.entries.length > 128) invalid();
  keys(value, ["revision", "entries"]);
  const entries = Array.from(value.entries, parsePrice);
  if ((value.revision === 0 && entries.length !== 0) || new Set(entries.map(entry => entry.model)).size !== entries.length) invalid();
  return { revision: value.revision, entries };
}
function parseEstimate(value: unknown): CostEstimate | null {
  if (value === null) return null;
  if (!object(value) || !currency(value.currency) || typeof value.totalAmount !== "string" || !/^(?:0|[1-9][0-9]{0,15})\.[0-9]{6}$/u.test(value.totalAmount)
    || typeof value.roundedToZero !== "boolean" || (value.roundedToZero && value.totalAmount !== "0.000000")) invalid();
  keys(value, ["currency", "totalAmount", "roundedToZero"]);
  return value as unknown as CostEstimate;
}
export function costAttemptKey(value: Pick<CallAttempt, "worldId" | "branchId" | "operationId" | "sequence" | "model">): string {
  return JSON.stringify([value.worldId, value.branchId, value.operationId, value.sequence, value.model]);
}
export function parseCostReply(value: unknown): CostReply {
  if (!object(value) || !integer(value.priceRevision) || !Array.isArray(value.attempts) || value.attempts.length > 100) invalid();
  keys(value, ["priceRevision", "attempts"]);
  const seen = new Set<string>();
  const attempts = Array.from(value.attempts, row => {
    if (!object(row) || !id(row.worldId) || !id(row.branchId) || !id(row.operationId) || (row.sequence !== 1 && row.sequence !== 2) || !validPriceModel(row.model)) invalid();
    keys(row, ["worldId", "branchId", "operationId", "sequence", "model", "estimate"]);
    const result: CostAttempt = { worldId: row.worldId, branchId: row.branchId, operationId: row.operationId, sequence: row.sequence, model: row.model, estimate: parseEstimate(row.estimate) };
    // A reservation belongs to exactly one scope and model. Reject conflicting bindings.
    const reservation = JSON.stringify([result.operationId, result.sequence]);
    if (seen.has(reservation)) invalid();
    seen.add(reservation);
    return result;
  });
  return { priceRevision: value.priceRevision, attempts };
}
function available() { if (!isTauri()) throw Error("game_price_store"); }
export async function getGamePrices(): Promise<PriceSettings> {
  available();
  return parsePriceSettings(await invoke("get_game_prices"));
}
export async function setGamePrice(input: PriceUpdate): Promise<PriceSettings> {
  available();
  const price = parsePrice({ model: input.model, currency: input.currency, inputPerMillion: normalizePriceInput(input.inputPerMillion), outputPerMillion: normalizePriceInput(input.outputPerMillion) });
  if (!integer(input.expectedRevision) || input.expectedRevision === Number.MAX_SAFE_INTEGER) invalid();
  const result = parsePriceSettings(await invoke("set_game_price", { input: { ...price, expectedRevision: input.expectedRevision } }));
  const updated = result.entries.find(entry => entry.model === price.model);
  if (result.revision !== input.expectedRevision + 1 || !updated || updated.currency !== price.currency || updated.inputPerMillion !== price.inputPerMillion || updated.outputPerMillion !== price.outputPerMillion) invalid();
  return result;
}
export async function clearGamePrice(model: string, expectedRevision: number): Promise<PriceSettings> {
  available();
  if (!validPriceModel(model) || !integer(expectedRevision) || expectedRevision === Number.MAX_SAFE_INTEGER) invalid();
  const result = parsePriceSettings(await invoke("clear_game_price", { model, expectedRevision }));
  if ((result.revision !== expectedRevision && result.revision !== expectedRevision + 1) || result.entries.some(entry => entry.model === model)) invalid();
  return result;
}
export async function getGameCostEstimates(): Promise<CostReply> {
  available();
  return parseCostReply(await invoke("get_game_cost_estimates"));
}
