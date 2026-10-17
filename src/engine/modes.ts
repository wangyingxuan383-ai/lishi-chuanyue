// Play modes (R14, docs/plans/R14_PLAY_MODES.md): the 剧本 (script), the 挑战
// (challenge) and 旁观 (the AI plays the protagonist). Pure helpers shared by
// the engine and the UI; the rules that change them live in state/apply.ts.
import { parseDurationMinutes } from "./calendar/duration";
import { newId } from "./db/repo";
import type { Challenge, Script, ScriptBeat, WorldState } from "./types";

/** The opening form's outline. */
export interface ScriptInput { line: string; beats: string[]; ending: string; steer?: "gentle" | "firm" }
/** The opening form's challenge. */
export interface ChallengeInput { goal: string; limit: string; failIf: string }

/** The outline editor allows one to twelve beats. */
export const MAX_BEATS = 12;

export const newBeat = (text: string): ScriptBeat => ({ id: newId(), text: text.trim(), status: "todo" });

/** A script from an outline; null when it has no beat. Empty lines are dropped, and beats past the twelfth. */
export function newScript(input: ScriptInput): Script | null {
  const beats = input.beats.map((t) => t.trim()).filter(Boolean).slice(0, MAX_BEATS);
  if (!beats.length) return null;
  return { line: input.line.trim(), beats: beats.map(newBeat), ending: input.ending.trim(), steer: input.steer === "firm" ? "firm" : "gentle" };
}

/**
 * When a limit such as “三个月” runs out, counted from `startedMinute`; null for
 * no limit or words that give no span. A bare number has no unit and gives none.
 */
export function deadlineOf(limit: string, startedMinute: number): number | null {
  const text = limit.trim();
  const minutes = text && !/^\d+$/.test(text) ? parseDurationMinutes(text) : null;
  return minutes ? startedMinute + minutes : null;
}

/** A challenge that starts at `startedMinute`; null without a goal. */
export function newChallenge(input: ChallengeInput, startedMinute: number): Challenge | null {
  const goal = input.goal.trim();
  if (!goal) return null;
  const limit = input.limit.trim();
  return { goal, limit, deadlineMinute: deadlineOf(limit, startedMinute), failIf: input.failIf.trim(), progress: "", status: "active", startedMinute };
}

/** How the outline looks again, for “再挑战一次”: the beats' words without how far they got. */
export const scriptInputOf = (s: Script): ScriptInput => ({ line: s.line, beats: s.beats.map((b) => b.text), ending: s.ending, steer: s.steer });
export const challengeInputOf = (c: Challenge): ChallengeInput => ({ goal: c.goal, limit: c.limit, failIf: c.failIf });

/** A beat as a chip or a list shows it: its first clause, at most sixteen characters. */
export function beatTitle(text: string): string {
  const line = text.trim().split("\n")[0];
  const clause = line.split(/[，,。；;：:！!？?]/)[0];
  const title = clause.length >= 2 ? clause : line;
  return title.length > 16 ? `${title.slice(0, 16)}…` : title;
}

export interface ScriptProgress {
  /** 1-based position of the current beat (“第 2/5 幕”); the last beat's once finished. */
  index: number;
  total: number;
  /** The first beat still todo; null once every beat is done or skipped. */
  current: ScriptBeat | null;
  finished: boolean;
}

/** Where the script stands; null without a script. */
export function scriptProgress(state: Pick<WorldState, "script">): ScriptProgress | null {
  const beats = state.script?.beats;
  if (!beats?.length) return null;
  const i = beats.findIndex((b) => b.status === "todo");
  return i < 0 ? { index: beats.length, total: beats.length, current: null, finished: true } : { index: i + 1, total: beats.length, current: beats[i], finished: false };
}

export interface ChallengeView {
  status: Challenge["status"];
  /** Still to be decided: the banner shows, the deadline counts. */
  active: boolean;
  goal: string;
  /** The limit as the player wrote it; "" for none. */
  limit: string;
  failIf: string;
  progress: string;
  /** How it ended (the end card's sentence); "" while active. */
  outcome: string;
  /** Game minutes left; null without a deadline or once it has ended. */
  remainingMinutes: number | null;
  /** For the banner and the challenge page: “还剩 12 天”, “还剩不到一天”, “不限时”; "" once it has ended. */
  remaining: string;
  /** Days and turns used so far, or until it ended (“用了 23 天、41 回合”). */
  days: number;
  turns: number;
}

/** What the banner, the challenge page and the end card show; null without a challenge. */
export function challengeView(state: Pick<WorldState, "challenge" | "time">): ChallengeView | null {
  const c = state.challenge;
  if (!c) return null;
  const now = state.time.elapsedMinutes;
  const active = c.status === "active";
  const left = active && c.deadlineMinute !== null ? Math.max(0, c.deadlineMinute - now) : null;
  const remaining = !active ? "" : left === null ? "不限时" : left >= 1440 ? `还剩 ${Math.floor(left / 1440)} 天` : "还剩不到一天";
  const spent = Math.max(0, (active ? now : c.endedMinute ?? now) - c.startedMinute);
  return {
    status: c.status, active, goal: c.goal, limit: c.limit, failIf: c.failIf, progress: c.progress, outcome: active ? "" : c.outcome ?? "",
    remainingMinutes: left, remaining, days: Math.max(1, Math.ceil(spent / 1440)), turns: c.turns ?? 0,
  };
}

/** The line a script or challenge edit leaves in the story, in the player's words. */
export function modeEditSummary(before: Pick<WorldState, "script" | "challenge">, patch: { scriptSet?: Script | null; challengeSet?: Challenge | null }): string {
  const parts: string[] = [];
  if (patch.scriptSet !== undefined) parts.push(patch.scriptSet === null ? "你删掉了剧本" : before.script ? "你修改了剧本" : "你加了一个剧本");
  const was = before.challenge;
  const next = patch.challengeSet;
  if (next !== undefined) {
    parts.push(next === null ? "你删掉了挑战"
      : next.status === "abandoned" && was?.status === "active" ? "你放弃了挑战"
        : was && was.startedMinute === next.startedMinute ? "你修改了挑战" : "你加了一个挑战");
  }
  return parts.join("；");
}

const words = (v: unknown) => (typeof v === "string" ? v.trim() : null);
const minute = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const BEAT_STATUS = ["todo", "done", "skipped"] as const;
const CHALLENGE_STATUS = ["active", "won", "lost", "abandoned"] as const;

/** A script from a panel or a file, checked; a string says what is wrong, in the player's words. Empty beats are dropped. */
export function checkScript(raw: unknown): Script | string {
  const o = raw as Partial<Record<keyof Script, unknown>> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.beats)) return "剧本的内容不完整";
  const beats: ScriptBeat[] = [];
  for (const item of o.beats as Partial<Record<keyof ScriptBeat, unknown>>[]) {
    const text = words(item?.text);
    if (!text) continue;
    const status = BEAT_STATUS.find((s) => s === (item.status ?? "todo"));
    if (!status) return "剧本的内容不完整";
    const ended = minute(item.endedMinute);
    beats.push({ id: words(item.id) || newId(), text, status, ...(status !== "todo" && ended !== null ? { endedMinute: ended } : {}) });
  }
  if (!beats.length) return "剧本至少要有一幕";
  if (beats.length > MAX_BEATS) return `剧本最多 ${MAX_BEATS} 幕`;
  return { line: words(o.line) ?? "", beats, ending: words(o.ending) ?? "", steer: o.steer === "firm" ? "firm" : "gentle" };
}

/** A challenge from a panel or a file, checked; the deadline always follows its written limit. */
export function checkChallenge(raw: unknown): Challenge | string {
  const o = raw as Partial<Record<keyof Challenge, unknown>> | null;
  if (!o || typeof o !== "object") return "挑战的内容不完整";
  const goal = words(o.goal);
  if (!goal) return "挑战要有一个目标";
  const status = CHALLENGE_STATUS.find((s) => s === o.status);
  const started = minute(o.startedMinute);
  if (!status || started === null) return "挑战的内容不完整";
  const limit = words(o.limit) ?? "";
  const ended = minute(o.endedMinute);
  const outcome = words(o.outcome);
  const turns = minute(o.turns);
  return {
    goal, limit, deadlineMinute: deadlineOf(limit, started), failIf: words(o.failIf) ?? "", progress: words(o.progress) ?? "", status, startedMinute: started,
    ...(status !== "active" && ended !== null ? { endedMinute: ended } : {}),
    ...(status !== "active" && outcome ? { outcome } : {}),
    ...(turns ? { turns } : {}),
  };
}
