import { invoke, isTauri } from "@tauri-apps/api/core";
export type CallState = "reserved" | "completed" | "failed" | "cancelled" | "interrupted";
export interface CallAttempt {
  operationId: string; worldId: string; branchId: string; model: string; promptVersion: number;
  sequence: 1 | 2; state: CallState; actualHttpAttempts: 0 | 1 | null; sentUnknown: boolean;
  httpStatus: number | null; usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  elapsedMs: number | null; errorCode: string | null; createdAtMs: number; finishedAtMs: number | null;
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(v);
const nullableCount = (v: unknown) => v === null || count(v);
export function parseCallAttempts(value: unknown): CallAttempt[] {
  if (!Array.isArray(value) || value.length > 100) throw Error("call_invalid");
  const seen = new Set<string>();
  return value.map(row => {
    if (!record(row) || Object.keys(row).length !== 15 || !id(row.operationId) || !id(row.worldId) || !id(row.branchId) ||
      typeof row.model !== "string" || !row.model.length || new TextEncoder().encode(row.model).length > 256 || /\s|\p{Cc}/u.test(row.model) ||
      !count(row.promptVersion) || row.promptVersion === 0 || ![1, 2].includes(row.sequence as number) ||
      !["reserved", "completed", "failed", "cancelled", "interrupted"].includes(row.state as string) ||
      ![null, 0, 1].includes(row.actualHttpAttempts as number | null) || typeof row.sentUnknown !== "boolean" ||
      row.sentUnknown !== (row.actualHttpAttempts === null) || !nullableCount(row.elapsedMs) || !count(row.createdAtMs) ||
      !nullableCount(row.finishedAtMs) || (row.finishedAtMs !== null && (row.finishedAtMs as number) < row.createdAtMs) ||
      !(row.httpStatus === null || count(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599) ||
      !(row.errorCode === null || typeof row.errorCode === "string" && /^[a-z_]{1,64}$/u.test(row.errorCode))) throw Error("call_invalid");
    if (row.usage !== null && (!record(row.usage) || Object.keys(row.usage).length !== 3 || !count(row.usage.promptTokens) || !count(row.usage.completionTokens) ||
      !count(row.usage.totalTokens) || row.usage.promptTokens + row.usage.completionTokens !== row.usage.totalTokens)) throw Error("call_invalid");
    if ((row.state === "reserved" || row.state === "interrupted") !== row.sentUnknown || (row.state === "reserved") !== (row.finishedAtMs === null)) throw Error("call_invalid");
    if (row.sentUnknown && (row.httpStatus !== null || row.usage !== null || row.elapsedMs !== null)) throw Error("call_invalid");
    if (row.state === "completed" && (row.actualHttpAttempts !== 1 || row.errorCode !== null)) throw Error("call_invalid");
    if (row.actualHttpAttempts === 0 && (row.httpStatus !== null || row.usage !== null)) throw Error("call_invalid");
    const key = JSON.stringify([row.operationId, row.sequence]);
    if (seen.has(key)) throw Error("call_invalid");
    seen.add(key);
    return row as unknown as CallAttempt;
  });
}
export async function getGameCalls(): Promise<CallAttempt[]> {
  if (!isTauri()) throw Error("call_unavailable");
  return parseCallAttempts(await invoke("get_game_calls"));
}
