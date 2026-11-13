// Direct player correction: deterministic settlement, no model and no Agent task.
import { remapContinuity, validateContinuity } from "../continuity";
import type { Game } from "../game";
import type { RevisionGuard } from "../db/repo";
import { newId } from "../db/repo";
import { eraContext } from "../era";
import { isFortune } from "../fortune";
import type { ApplyResult, TurnRecord } from "../state/apply";
import * as tree from "../tree";
import type { StoryNode, WorldState } from "../types";
import { nowOf } from "./clock";
import { parseDurationMinutes } from "./duration";

export interface DurationCorrectionPreview {
  guard: RevisionGuard;
  inputFingerprint: string;
  target: StoryNode;
  record: TurnRecord;
  result: ApplyResult;
  originalState: WorldState;
  laterTurns: number;
  before: string;
  after: string;
  elapsedBefore: number;
  elapsedAfter: number;
  projectedEnd?: { before: string; after: string; ageBefore: number | null; ageAfter: number | null; challengeBefore?: string; challengeAfter?: string };
  remainingProblem?: string;
}
const objectRecord = (raw: unknown): TurnRecord | null => raw && typeof raw === "object" && !Array.isArray(raw) ? raw as TurnRecord : null;

// Settlement can allocate ids for people/cards. Keep their existing identities when only time changes.
function alignIds(state: WorldState, original: WorldState) {
  const replacements = new Map<string, string>();
  for (const key of ["people", "places", "cards", "goals"] as const) for (const entity of state[key]) {
    const known = original[key].find(item => item.name === entity.name && (!("kind" in entity) || !("kind" in item) || entity.kind === item.kind));
    if (known && known.id !== entity.id) { replacements.set(entity.id, known.id); entity.id = known.id; }
  }
  if (state.placeId) state.placeId = replacements.get(state.placeId) ?? state.placeId;
}

/** Apply only the deterministic differences caused by changing the duration.
 * Unrecorded original edits stay intact; a conflicting time-derived value requires review. */
function mergeCorrection(original: unknown, before: unknown, after: unknown, path = "本回合状态"): unknown {
  if (JSON.stringify(before) === JSON.stringify(after)) return structuredClone(original);
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(original) && before.length === after.length && original.length === before.length) {
    const identity = (value: unknown) => {
      if (!value || typeof value !== "object") return undefined;
      const row = value as Record<string, unknown>;
      return typeof row.id === "string" ? `id:${row.id}` : typeof row.name === "string" ? `name:${row.name}` : typeof row.text === "string" ? `text:${row.text}` : undefined;
    };
    const keys = before.map(identity);
    if (keys.every(key => key !== undefined) && new Set(keys).size === keys.length && after.every(item => keys.some(key => key === identity(item))) && original.every(item => keys.some(key => key === identity(item)))) {
      if (new Set(original.map(identity)).size !== keys.length || new Set(after.map(identity)).size !== keys.length) throw new Error(`时间变化的关联对象不唯一（${path}），未保存。`);
      return original.map(value => { const key = identity(value); return mergeCorrection(value, before.find(item => identity(item) === key), after.find(item => identity(item) === key), `${path}/${key}`); });
    }
    throw new Error(`时间变化的关联记录不完整或重复（${path}），请先核对，未保存。`);
  }
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after) && original && typeof original === "object" && !Array.isArray(original)) {
    const result = structuredClone(original) as Record<string, unknown>, left = before as Record<string, unknown>, right = after as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const merged = mergeCorrection(result[key], left[key], right[key], `${path}/${key}`);
      if (merged === undefined) delete result[key]; else result[key] = merged;
    }
    return result;
  }
  if (JSON.stringify(original) !== JSON.stringify(before) && JSON.stringify(original) !== JSON.stringify(after)) throw new Error(`时间变化与独立修改冲突（${path}），未保存。请先核对这项记录。`);
  return structuredClone(after);
}

export async function previewDurationCorrection(game: Game, worldId: string, headId: string, nodeId: string, duration: string): Promise<DurationCorrectionPreview> {
  // Do not accept an opening or a hidden settings edit as a time-advancing turn.
  if (/[-−负]/.test(duration)) throw new Error("经过时长不能为负数。");
  const minutes = parseDurationMinutes(duration);
  if (minutes === null || !Number.isSafeInteger(minutes) || minutes < 0) throw new Error("请填写可识别的经过时长，如90分钟、两天；也可以填0。");
  const current = await tree.cursor(game.repo, worldId);
  if (current.head.id !== headId) throw new Error("故事已变化，请重新打开时间设置。");
  const world = await game.repo.getWorld(worldId), path = await game.repo.path(headId);
  const at = path.findIndex(node => node.id === nodeId), target = path[at];
  if (!world || !target || target.kind !== "turn" || !target.parentId || target.status !== "ok") throw new Error("请选择当前路线中已经完整保存的剧情回合；开场和未完成正文不能纠正经过。");
  const originalRecord = objectRecord(target.record);
  if (!originalRecord) throw new Error("该回合没有完整记录，不能安全重算经过时长。");
  const baseline = await game.repo.getState(target.parentId), originalState = await game.repo.getState(nodeId), headState = await game.repo.getState(headId);
  const parent = await game.repo.getNode(target.parentId), era = eraContext(world.eraId, baseline);
  const record: TurnRecord = { ...structuredClone(originalRecord), time: minutes };
  // A historical fast-forward's old end-hour must not override an explicitly corrected duration.
  if (target.actionMode === "skip") record.hour = null;
  const options = { mode: target.actionMode ?? "continue", difficulty: world.settings.difficulty, currency: era.currency, clock: era.clock, ...(isFortune(parent?.meta.fortune) ? { fortune: parent.meta.fortune } : {}) };
  const oldResult = await game.settleRecord(baseline, originalRecord, options);
  const result = await game.settleRecord(baseline, record, options);
  alignIds(oldResult.state, originalState); alignIds(result.state, originalState);
  result.state = mergeCorrection(originalState, oldResult.state, result.state) as WorldState;
  if (result.state.time.elapsedMinutes === originalState.time.elapsedMinutes) throw new Error("这个回合的实际经过没有变化。");
  const [row] = await game.platform.sql.query(`SELECT target.record_json,target.meta_json,target_state.state_json,
    parent.meta_json AS parent_meta,parent_state.state_json AS parent_state,w.settings_json FROM nodes target
    JOIN states target_state ON target_state.node_id=target.id JOIN nodes parent ON parent.id=target.parent_id
    JOIN states parent_state ON parent_state.node_id=parent.id JOIN worlds w ON w.id=target.world_id WHERE target.id=?`, [nodeId]);
  const preview: DurationCorrectionPreview = {
    guard: { worldId, lineId: current.line.id, headId, nodeId, original: target.narrative, sourceGuard: JSON.stringify(headState.source ?? null), recordGuard: String(row.record_json ?? "null"), requireIdle: true,
      settingsGuard: String(row.settings_json), targetStateGuard: String(row.state_json), parentStateGuard: String(row.parent_state),
      targetMetaGuard: String(row.meta_json), parentMetaGuard: String(row.parent_meta) },
    inputFingerprint: JSON.stringify({ baseline, options, meta: target.meta, parentMeta: parent?.meta, state: result.state }),
    target, record, result, originalState,
    laterTurns: path.slice(at + 1).filter(node => node.kind === "turn").length,
    before: nowOf(eraContext(world.eraId, originalState).clock, originalState.time.elapsedMinutes).text,
    after: nowOf(eraContext(world.eraId, result.state).clock, result.state.time.elapsedMinutes).text,
    elapsedBefore: originalState.time.elapsedMinutes - baseline.time.elapsedMinutes,
    elapsedAfter: result.state.time.elapsedMinutes - baseline.time.elapsedMinutes,
  };
  // Only a local preview of the original later records. Adoption stops at the revised turn,
  // so old prose, summaries and opaque Agent state edits never become newly asserted facts.
  let projected = result.state;
  for (const node of path.slice(at + 1)) {
    const nextRecord = objectRecord(node.record);
    if (!nextRecord || node.status !== "ok" || node.meta.piTaskId || node.meta.agentTaskId || node.meta.agentTask || node.meta.agentStatePatch) {
      preview.remainingProblem = "后续含未完成记录或独立修改，无法完整预演；原路线保持不变。";
      break;
    }
    const context = eraContext(world.eraId, projected), parentNode = node.parentId ? await game.repo.getNode(node.parentId) : null;
    projected = (await game.settleRecord(projected, nextRecord, { mode: node.actionMode ?? "continue", difficulty: world.settings.difficulty, currency: context.currency, clock: context.clock, ...(isFortune(parentNode?.meta.fortune) ? { fortune: parentNode.meta.fortune } : {}) }, node.kind === "edit" ? { advanceTime: false } : undefined)).state;
  }
  if (!preview.remainingProblem && path.length > at + 1) preview.projectedEnd = {
    before: nowOf(eraContext(world.eraId, headState).clock, headState.time.elapsedMinutes).text,
    after: nowOf(eraContext(world.eraId, projected).clock, projected.time.elapsedMinutes).text,
    ageBefore: headState.protagonist.age, ageAfter: projected.protagonist.age,
    challengeBefore: headState.challenge?.status, challengeAfter: projected.challenge?.status,
  };
  return preview;
}

/** Called through Game's per-world edit serialization. Compare again inside the SQL transaction. */
export async function adoptDurationCorrection(game: Game, preview: DurationCorrectionPreview): Promise<tree.Cursor> {
  const fresh = await previewDurationCorrection(game, preview.guard.worldId, preview.guard.headId, preview.guard.nodeId, String(preview.record.time));
  if (fresh.inputFingerprint !== preview.inputFingerprint || fresh.guard.lineId !== preview.guard.lineId || fresh.guard.recordGuard !== preview.guard.recordGuard || fresh.guard.sourceGuard !== preview.guard.sourceGuard || fresh.guard.original !== preview.guard.original
    || JSON.stringify(fresh.originalState) !== JSON.stringify(preview.originalState)) throw new Error("故事、回合记录或参考用法已经变化，请重新预演。");
  const id = newId(), { target, result } = fresh;
  // Keep the target's source/provenance; its original timeline and all following nodes remain untouched.
  result.state.source = structuredClone(fresh.originalState.source);
  result.state.facts = fresh.originalState.facts?.map(fact => ({ ...structuredClone(fact), ...(fact.nodeId === target.id ? { nodeId: id } : {}) }));
  if (fresh.record.continuity) {
    fresh.record.continuity = remapContinuity(fresh.record.continuity, node => node === target.id ? id : node);
    fresh.record.continuity = (await validateContinuity(game.repo, fresh.guard.worldId, target.parentId, id, target.narrative, `${target.actionText ?? ""}\n${target.directorNote ?? ""}`, result.state, fresh.record.continuity, true)).changes;
  }
  const created = await game.repo.forkRevision(fresh.guard, {
    id, parentId: target.parentId, kind: "turn", narrative: target.narrative,
    actionMode: target.actionMode, actionText: target.actionText, directorNote: target.directorNote,
    record: fresh.record, choices: target.choices, status: "ok", state: result.state,
    meta: { ...target.meta, chips: result.chips, notes: result.notes, log: result.log,
      revision: { kind: "manualDuration", nodeId: target.id, lineId: fresh.guard.lineId, before: fresh.elapsedBefore, after: fresh.elapsedAfter } },
  }, "纠正经过后的路线");
  return { worldId: fresh.guard.worldId, line: created.line, head: created.node };
}
