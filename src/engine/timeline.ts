// The world's own timeline of great events (PLAN §4.6, R05-T004): copied from a
// built-in pack, written by the AI organizer or added by the player. Each event
// is placed as game minutes after the start, so the program can tell when time
// reaches it. 固定 events happen whatever the player does; 可变 ones are what
// the history books say, and the story may change them (历史偏离).
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

/** A timeline event from a written date such as "天宝九载十月". */
export function placeEvent(clock: GameClock, raw: { date: string; title: string; kind?: string }): Omit<TimelineEvent, "id" | "source"> {
  const date = readDate(raw.date, clock.rules);
  return { date: date ? monthLabel(date, clock.rules) : raw.date.trim(), atMinute: date ? minutesTo(clock, date) : null, title: raw.title.trim(), kind: raw.kind === "固定" ? "固定" : "可变" };
}

/**
 * The events placed again against a new start (AUDIT_V4_FUNCTION F2): the
 * written date stays, the minute follows the clock; one that no longer fits
 * the calendar is kept without a reminder.
 */
export function retime(events: TimelineEvent[], clock: GameClock): TimelineEvent[] {
  return events
    .map((e) => {
      const date = readDate(e.date, clock.rules);
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
 * 【天下大事】 for a turn: what happened lately, what the books say comes next
 * (within `lookahead` minutes, the whole span for 过些日子), and the deviations.
 */
export function worldBlock(state: Pick<WorldState, "timeline" | "deviations" | "time">, lookahead = 60 * DAY): string {
  const now = state.time.elapsedMinutes;
  const timeline = state.timeline ?? [];
  const recent = timeline.filter((e) => e.atMinute !== null && e.atMinute <= now && e.atMinute > now - 120 * DAY);
  const coming = timeline.filter((e) => e.atMinute !== null && e.atMinute > now && e.atMinute <= now + lookahead);
  const lines = [
    ...recent.map((e) => `${e.date}：${e.title}${e.kind === "可变" ? "（按史书；若【历史偏离】改变了它，以偏离为准）" : ""}`),
    ...coming.map((e) => `${e.date}将会：${e.title}${e.kind === "固定" ? "（一定发生）" : "（按史书，可能因剧情改变）"}`),
  ];
  const deviations = (state.deviations ?? []).slice(-10);
  return `${lines.length ? `\n【天下大事】\n${lines.join("\n")}` : ""}${deviations.length ? `\n【历史偏离（这一世已经和史书不同的事）】\n- ${deviations.join("\n- ")}` : ""}`;
}
