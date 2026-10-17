// The world's own timeline of great events (PLAN §4.6, R05-T004): copied from a
// built-in pack, written by the AI organizer or added by the player. Each event
// is placed as game minutes after the start, so the program can tell when time
// reaches it. 固定 events happen whatever the player does; 可变 ones are what
// the history books say, and the story may change them (历史偏离).
// The whole timeline is the player's (the 记事 page: the time traveller knows
// what is coming); the narrator only hears of events whose time has come (D129).
import type { GameClock } from "./calendar/clock";
import { daysBetween, monthLabel, readDate, type GameDate } from "./calendar/date";
import type { EraEvent } from "../content/eras/types";
import { dateFromCe } from "./calendar/date";
import type { TimelineEvent, WorldState } from "./types";

/** Game minutes from the start of play to the first day of `date`; null when it cannot be placed. */
export function minutesTo(clock: GameClock, date: GameDate): number | null {
  if (!clock.date) return null;
  const days = daysBetween(clock.date, date);
  return days === null ? null : days * 1440 - clock.hour * 60;
}

const validCe = (ce: unknown): ce is number => typeof ce === "number" && Number.isInteger(ce) && ce !== 0 && ce > -5000 && ce < 2200;

/**
 * A written date with its CE year filled in from `ceYear` when the label alone
 * has none: without a reign table, "至德元载七月" cannot otherwise be counted
 * from a start in 天宝.
 */
function withCe(date: GameDate | null, ceYear: unknown): GameDate | null {
  return date && date.ceYear == null && validCe(ceYear) ? { ...date, ceYear } : date;
}

/** A timeline event from a written date such as "天宝九载十月", optionally with its CE year. */
export function placeEvent(clock: GameClock, raw: { date: string; title: string; kind?: string; ceYear?: number | null }): Omit<TimelineEvent, "id" | "source"> {
  const date = withCe(readDate(raw.date, clock.rules), raw.ceYear);
  return {
    date: date ? monthLabel(date, clock.rules) : raw.date.trim(), atMinute: date ? minutesTo(clock, date) : null,
    title: raw.title.trim(), kind: raw.kind === "固定" ? "固定" : "可变", ...(validCe(raw.ceYear) ? { ceYear: raw.ceYear } : {}),
  };
}

/**
 * The events placed again against a new start (AUDIT_V4_FUNCTION F2): the
 * written date stays, the minute follows the clock; one that no longer fits
 * the calendar is kept without a reminder.
 */
export function retime(events: TimelineEvent[], clock: GameClock): TimelineEvent[] {
  return events
    .map((e) => {
      const date = withCe(readDate(e.date, clock.rules), e.ceYear);
      return { ...e, atMinute: date ? minutesTo(clock, date) : null };
    })
    .sort((a, b) => (a.atMinute ?? Infinity) - (b.atMinute ?? Infinity));
}

/** Whether a written date can be placed on this clock, for the 年表 editor (AUDIT_V4_FUNCTION F9). */
export function readEventDate(clock: GameClock, text: string): { label: string; atMinute: number } | null {
  const date = readDate(text.trim(), clock.rules);
  const at = date ? minutesTo(clock, date) : null;
  return date && at !== null ? { label: monthLabel(date, clock.rules), atMinute: at } : null;
}

/** A pack's events, placed against the world's own clock. */
export function packTimeline(events: EraEvent[], clock: GameClock): Omit<TimelineEvent, "id">[] {
  return events.flatMap((e) => {
    const date = dateFromCe(e.ceYear, e.month, 1, clock.rules);
    if (!date) return [];
    return [{ date: monthLabel(date, clock.rules), atMinute: minutesTo(clock, date), title: e.title, kind: e.kind, source: "卡组" as const }];
  });
}

/** Events whose time came during a turn: after `from`, up to and including `to`. */
export function eventsBetween(timeline: TimelineEvent[] | undefined, from: number, to: number): TimelineEvent[] {
  return (timeline ?? []).filter((e) => e.atMinute !== null && e.atMinute > from && e.atMinute <= to).sort((a, b) => a.atMinute! - b.atMinute!);
}

const DAY = 1440;

/**
 * 【天下大事】 for a turn: what happened lately (the last four months, up to
 * now) and the deviations. The narrator's prompt never looks ahead (D129,
 * turn-16): future events stay on the player's 记事 page. `lookahead` exists
 * only for tools that deliberately show what is coming; it defaults to none.
 */
export function worldBlock(state: Pick<WorldState, "timeline" | "deviations" | "time">, lookahead = 0): string {
  const now = state.time.elapsedMinutes;
  const timeline = state.timeline ?? [];
  const recent = timeline.filter((e) => e.atMinute !== null && e.atMinute <= now && e.atMinute > now - 120 * DAY);
  const coming = timeline.filter((e) => e.atMinute !== null && e.atMinute > now && e.atMinute <= now + lookahead);
  const deviations = (state.deviations ?? []).slice(-10);
  // Even a 固定 event may have been changed by the story: then the deviation wins (R14 engine review).
  const note = (e: TimelineEvent) => e.kind === "可变" || deviations.length ? "（按史书；若【历史偏离】改变了它，以偏离为准）" : "";
  const lines = [
    ...recent.map((e) => `${e.date}：${e.title}${note(e)}`),
    ...coming.map((e) => `${e.date}将会：${e.title}${e.kind === "固定" ? "（一定发生）" : "（按史书，可能因剧情改变）"}`),
  ];
  return `${lines.length ? `\n【天下大事】\n${lines.join("\n")}` : ""}${deviations.length ? `\n【历史偏离（这一世已经和史书不同的事）】\n- ${deviations.join("\n- ")}` : ""}`;
}
