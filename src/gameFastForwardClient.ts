import { invoke, isTauri } from "@tauri-apps/api/core";
import { parseWorld, type GameWorld, type ProviderKind } from "./gameClient";
import { fastForwardT as t, type FastForwardPlainMessageKey } from "./gameFastForwardMessages";
export type FastForwardStatus = "ready" | "running" | "paused_decision" | "segment_limit" | "completed" | "cancelled" | "interrupted" | "failed";
export interface FastForwardDecision { prompt: string; choiceIds: string[] }
export interface FastForwardJob {
  jobId: string; worldId: string; branchId: string; startHeadTurnId: string | null; headTurnId: string | null;
  startElapsedSeconds: number; elapsedSeconds: number; targetElapsedSeconds: number; maxSegmentSeconds: number;
  focus: string; status: FastForwardStatus; revision: number; segmentsCommitted: number; modelRequestsReserved: number;
  activeOperationId: string | null; decision: FastForwardDecision | null; lastError: string | null; createdAtMs: number; updatedAtMs: number;
}
export interface StartFastForwardRequest { worldId: string; branchId: string; jobId: string; expectedHeadTurnId: string | null; targetElapsedSeconds: number; maxSegmentSeconds: number; focus: string }
export interface ContinueFastForwardRequest { worldId: string; branchId: string; jobId: string; operationId: string; expectedHeadTurnId: string | null; expectedJobRevision: number }
export interface DecisionResumeRequest { worldId: string; branchId: string; jobId: string; decisionTurnId: string; expectedJobRevision: number }
export interface FastForwardCommit { job: FastForwardJob; world: GameWorld }
export interface CalendarMoment { date: { eraYear: number; month: number; day: number }; hour: number; minute: number; second: number }
export interface GameCalendar { worldId: string; branchId: string; headTurnId: string | null; calendarRange: { earliest: CalendarMoment; latest: CalendarMoment }; birthdayKnown: boolean; age: { minimumYears: number; maximumYears: number; mayNotBeBornYet: boolean } | null }
export class FastForwardError extends Error { constructor(message: string, readonly code?: string) { super(message); this.name = "FastForwardError"; } }
function invalid(): never { throw new FastForwardError(t("ff.error.format")); }
function check(condition: unknown): asserts condition { if (!condition) invalid(); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function shape(value: unknown, fields: string[]): Record<string, unknown> { check(object(value) && fields.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => fields.includes(key))); return value; }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value); }
function nullableId(value: unknown): value is string | null { return value === null || id(value); }
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.trim().length > 0) && value.length <= max && new TextEncoder().encode(value).length <= max
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    && !Array.from(value).some(character => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; });
}
function status(value: unknown): value is FastForwardStatus { return typeof value === "string" && ["ready", "running", "paused_decision", "segment_limit", "completed", "cancelled", "interrupted", "failed"].includes(value); }
export function parseFastForwardJob(value: unknown): FastForwardJob {
  const row = shape(value, ["jobId", "worldId", "branchId", "startHeadTurnId", "headTurnId", "startElapsedSeconds", "elapsedSeconds", "targetElapsedSeconds", "maxSegmentSeconds", "focus", "status", "revision", "segmentsCommitted", "modelRequestsReserved", "activeOperationId", "decision", "lastError", "createdAtMs", "updatedAtMs"]);
  check(id(row.jobId) && id(row.worldId) && (row.branchId === "main" || id(row.branchId)) && nullableId(row.startHeadTurnId) && nullableId(row.headTurnId) && nullableId(row.activeOperationId)
    && integer(row.startElapsedSeconds) && integer(row.elapsedSeconds) && integer(row.targetElapsedSeconds) && integer(row.maxSegmentSeconds) && row.maxSegmentSeconds > 0
    && row.startElapsedSeconds < row.targetElapsedSeconds && row.elapsedSeconds >= row.startElapsedSeconds && text(row.focus, 4096, true) && status(row.status)
    && integer(row.revision) && integer(row.segmentsCommitted) && integer(row.modelRequestsReserved) && integer(row.createdAtMs) && integer(row.updatedAtMs)
    && ((row.status === "running") === (row.activeOperationId !== null))
    && (row.status === "completed" ? row.elapsedSeconds >= row.targetElapsedSeconds : row.elapsedSeconds < row.targetElapsedSeconds)
    && (row.lastError === null || (typeof row.lastError === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(row.lastError))));
  let decision: FastForwardDecision | null = null;
  if (row.decision !== null) {
    const d = shape(row.decision, ["prompt", "choiceIds"]);
    check((row.status === "paused_decision" || row.status === "cancelled") && text(d.prompt, 2048) && Array.isArray(d.choiceIds)
      && d.choiceIds.length > 0 && d.choiceIds.length <= 32 && d.choiceIds.every(choice => typeof choice === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(choice))
      && new Set(d.choiceIds).size === d.choiceIds.length);
    decision = d as unknown as FastForwardDecision;
  }
  check(row.status !== "paused_decision" || decision !== null);
  return { ...row, decision } as unknown as FastForwardJob;
}
export function parseFastForwardList(value: unknown): FastForwardJob[] {
  check(Array.isArray(value) && value.length <= 64); const jobs = value.map(parseFastForwardJob); check(new Set(jobs.map(job => job.jobId)).size === jobs.length); return jobs;
}
export function parseFastForwardCommit(value: unknown): FastForwardCommit {
  const row = shape(value, ["job", "world"]); const job = parseFastForwardJob(row.job); const world = parseWorld(row.world);
  check(world.state.protocolVersion === 2 && world.setup.worldId === job.worldId && world.branchId === job.branchId && world.headTurnId === job.headTurnId && world.state.time.elapsedSeconds === job.elapsedSeconds
    && ["segment_limit", "completed", "paused_decision"].includes(job.status));
  return { job, world };
}
export function parseGameCalendar(value: unknown): GameCalendar {
  const row = shape(value, ["worldId", "branchId", "headTurnId", "calendarRange", "birthdayKnown", "age"]);
  check(id(row.worldId) && (row.branchId === "main" || id(row.branchId)) && nullableId(row.headTurnId) && typeof row.birthdayKnown === "boolean");
  const range = shape(row.calendarRange, ["earliest", "latest"]);
  function moment(value: unknown): CalendarMoment {
    const m = shape(value, ["date", "hour", "minute", "second"]); const d = shape(m.date, ["eraYear", "month", "day"]);
    check(typeof d.eraYear === "number" && Number.isSafeInteger(d.eraYear) && d.eraYear !== 0 && Math.abs(d.eraYear) <= 999999 && integer(d.month) && d.month >= 1 && d.month <= 12
      && integer(d.day) && d.day >= 1 && integer(m.hour) && m.hour < 24 && integer(m.minute) && m.minute < 60 && integer(m.second) && m.second < 60);
    const y = d.eraYear < 0 ? d.eraYear + 1 : d.eraYear; const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    check(d.day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][d.month - 1]);
    return { ...m, date: d } as unknown as CalendarMoment;
  }
  const earliest = moment(range.earliest), latest = moment(range.latest);
  const order = (m: CalendarMoment) => [m.date.eraYear < 0 ? m.date.eraYear + 1 : m.date.eraYear, m.date.month, m.date.day, m.hour, m.minute, m.second];
  const a = order(earliest), b = order(latest); const firstDifference = a.findIndex((n, i) => n !== b[i]); check(firstDifference < 0 || a[firstDifference] < b[firstDifference]);
  let age: GameCalendar["age"] = null;
  if (row.age !== null) {
    const entry = shape(row.age, ["minimumYears", "maximumYears", "mayNotBeBornYet"]);
    check(row.birthdayKnown && integer(entry.minimumYears) && integer(entry.maximumYears) && entry.minimumYears <= entry.maximumYears && typeof entry.mayNotBeBornYet === "boolean"); age = entry as unknown as GameCalendar["age"];
  }
  check(row.birthdayKnown || age === null);
  return { ...row, calendarRange: { earliest, latest }, age } as unknown as GameCalendar;
}
const errors: Record<string, FastForwardPlainMessageKey> = {
  game_busy: "ff.error.busy", game_world_busy: "ff.error.busy", game_stale_head: "ff.error.stale", game_provider_stale: "ff.error.stale",
  game_invalid_request: "ff.error.invalid", game_invalid_transition: "ff.error.invalid", game_duplicate: "ff.error.invalid",
  game_upgrade_required: "ff.error.upgrade", game_incompatible_schema: "ff.error.upgrade",
  game_provider_missing: "ff.error.provider", game_provider_failed: "ff.error.provider", game_context_too_large: "ff.error.large",
  game_cancelled: "ff.cancelled",
};
async function call(command: string, args: Record<string, unknown>): Promise<unknown> {
  if (!isTauri()) throw new FastForwardError(t("ff.unavailable"));
  try { return await invoke<unknown>(command, args); }
  catch (cause) { const code = object(cause) && typeof cause.code === "string" && Object.hasOwn(errors, cause.code) ? cause.code : undefined; throw new FastForwardError(t(code ? errors[code] : "ff.error.unknown"), code); }
}
export function describeFastForwardError(cause: unknown): string { return cause instanceof FastForwardError ? cause.message : t("ff.error.unknown"); }
function bound(job: FastForwardJob, worldId: string, branchId: string, jobId?: string): FastForwardJob { check(job.worldId === worldId && job.branchId === branchId && (jobId === undefined || job.jobId === jobId)); return job; }
export async function listGameFastForward(worldId: string, branchId: string): Promise<FastForwardJob[]> {
  return parseFastForwardList(await call("list_game_fast_forward", { worldId, branchId })).map(job => bound(job, worldId, branchId));
}
export async function startGameFastForward(request: StartFastForwardRequest): Promise<FastForwardJob> {
  const job = bound(parseFastForwardJob(await call("start_game_fast_forward", { request })), request.worldId, request.branchId, request.jobId);
  check(job.headTurnId === request.expectedHeadTurnId && job.startHeadTurnId === request.expectedHeadTurnId && job.targetElapsedSeconds === request.targetElapsedSeconds
    && job.maxSegmentSeconds === request.maxSegmentSeconds && job.focus === request.focus && job.status === "ready" && job.revision === 0 && job.segmentsCommitted === 0 && job.modelRequestsReserved === 0); return job;
}
export async function continueGameFastForward(request: ContinueFastForwardRequest, providerKind: ProviderKind): Promise<FastForwardCommit> {
  const result = parseFastForwardCommit(await call("continue_game_fast_forward", { request, providerKind })); bound(result.job, request.worldId, request.branchId, request.jobId);
  check(result.world.headTurnId === request.operationId); return result;
}
export async function resumeGameFastForward(request: DecisionResumeRequest): Promise<FastForwardJob> {
  const job = bound(parseFastForwardJob(await call("resume_game_fast_forward_decision", { request })), request.worldId, request.branchId, request.jobId);
  check(job.headTurnId === request.decisionTurnId && job.revision === request.expectedJobRevision + 1 && job.decision === null && (job.status === "ready" || job.status === "completed" || job.status === "cancelled" && job.lastError === "game_protagonist_dead")); return job;
}
export async function cancelGameFastForward(worldId: string, branchId: string, jobId: string, expectedJobRevision: number): Promise<FastForwardJob> {
  const job = bound(parseFastForwardJob(await call("cancel_game_fast_forward", { worldId, branchId, jobId, expectedJobRevision })), worldId, branchId, jobId);
  check(job.status === "cancelled" && job.revision === expectedJobRevision + 1); return job;
}
export async function getGameCalendar(worldId: string, branchId: string, expectedHeadTurnId: string | null): Promise<GameCalendar> {
  const calendar = parseGameCalendar(await call("get_game_calendar", { worldId, branchId, expectedHeadTurnId }));
  check(calendar.worldId === worldId && calendar.branchId === branchId && calendar.headTurnId === expectedHeadTurnId); return calendar;
}
