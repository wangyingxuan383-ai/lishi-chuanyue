// The game's "now" (D119): the opening date plus elapsed minutes, shown as
// "天宝七载 冬月十九 · 酉时". Worlds whose opening gave no usable date count
// days instead ("第 3 日 · 酉时").
import { coerceDate, formatDate, ganzhi, monthDays, newYearsAfterDays, seasonDetail, shiftDate, type CalendarRules, type GameDate } from "./date";

const SHICHEN = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];

export function shichen(hour: number): string {
  return SHICHEN[Math.floor((((hour + 1) % 24) + 24) % 24 / 2)];
}

export interface ClockAnchor {
  /** The existing elapsed minute mapped to this date; never resets story time. */
  atElapsedMinutes: number;
  date: GameDate;
  minuteOfDay: number;
}

/** Optional day-number calibration; the actual story duration keeps its original axis. */
export interface ElapsedClockAnchor {
  atElapsedMinutes: number;
  day: number;
  minuteOfDay: number;
}

export function readElapsedClockAnchor(raw: unknown): ElapsedClockAnchor | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.atElapsedMinutes !== "number" || !Number.isSafeInteger(v.atElapsedMinutes) || v.atElapsedMinutes < 0
    || typeof v.day !== "number" || !Number.isSafeInteger(v.day) || v.day < 1
    || typeof v.minuteOfDay !== "number" || !Number.isInteger(v.minuteOfDay) || v.minuteOfDay < 0 || v.minuteOfDay >= 1440) return null;
  return { atElapsedMinutes: v.atElapsedMinutes, day: v.day, minuteOfDay: v.minuteOfDay };
}

/** Invalid imported calibration is ignored rather than corrupting clock arithmetic. */
export function readClockAnchor(raw: unknown, rules: CalendarRules): ClockAnchor | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.atElapsedMinutes !== "number" || !Number.isSafeInteger(v.atElapsedMinutes) || v.atElapsedMinutes < 0
    || typeof v.minuteOfDay !== "number" || !Number.isInteger(v.minuteOfDay) || v.minuteOfDay < 0 || v.minuteOfDay >= 1440) return null;
  const date = coerceDate(v.date, rules);
  const source = v.date as Record<string, unknown> | null;
  if (date && source?.ceYear === null && date.era !== "公元" && date.era !== "公元前") date.ceYear = null;
  if (!date || !source || typeof source.year !== "number" || typeof source.month !== "number" || typeof source.day !== "number"
    || source.day !== date.day || date.day > monthDays(date)
    || source.ceYear != null && source.ceYear !== date.ceYear
    || source.lunar != null && typeof source.lunar !== "boolean") return null;
  return { atElapsedMinutes: v.atElapsedMinutes, minuteOfDay: v.minuteOfDay, date };
}

/** Minute 0 of a world, with an optional independent display calibration. */
export interface GameClock {
  mode?: "history" | "free";
  clockStyle?: "era" | "elapsed";
  timeStyle?: "24h" | "shichen";
  anchor?: ClockAnchor | null;
  elapsedAnchor?: ElapsedClockAnchor | null;
  /** Date at minute 0; null when unknown, and then days are counted. */
  date: GameDate | null;
  /** Hour of day at minute 0. */
  hour: number;
  /** How the start was written when there is no date ("中平元年秋"); may be empty. */
  label: string;
  rules: CalendarRules;
}

export interface Now {
  clockStyle?: "era" | "elapsed";
  timeStyle?: "24h" | "shichen";
  /** Day of the story, from 1. */
  day: number;
  /** Independently calibrated day number for display; never used for ages or deadlines. */
  displayDay: number;
  hour: number;
  minute: number;
  shichen: string;
  date: GameDate | null;
  /** New Years crossed since the start. */
  newYears: number;
  /** "天宝七载 冬月十九 · 酉时"; without a date "中平元年秋 · 第 3 日 · 酉时". */
  text: string;
}

/** Clock offset used for displayed time of day, including calibrated clocks. */
export function clockOffsetMinutes(clock: GameClock): number {
  const elapsedAnchor = (clock.clockStyle ?? (clock.mode === "free" ? "elapsed" : "era")) === "elapsed" ? readElapsedClockAnchor(clock.elapsedAnchor) : null;
  if (elapsedAnchor) return elapsedAnchor.minuteOfDay - elapsedAnchor.atElapsedMinutes;
  const anchor = readClockAnchor(clock.anchor, clock.rules);
  return anchor ? anchor.minuteOfDay - anchor.atElapsedMinutes : clock.hour * 60;
}

function clockBaseDate(clock: GameClock): GameDate | null {
  const source = clock.date;
  if (clock.mode !== "free" || !source || source.ceYear !== null || source.era === "公元" || source.era === "公元前") return source;
  const date = coerceDate(source, clock.rules);
  if (date) date.ceYear = null;
  return date;
}

export function nowOf(clock: GameClock, elapsedMinutes: number): Now {
  const clockStyle = clock.clockStyle ?? (clock.mode === "free" ? "elapsed" : "era");
  const timeStyle = clock.timeStyle ?? (clockStyle === "elapsed" ? "24h" : "shichen");
  const elapsed = Math.max(0, elapsedMinutes);
  const anchor = readClockAnchor(clock.anchor, clock.rules);
  // Story days and deadlines keep their original axis when the date is calibrated.
  const days = Math.floor((clock.hour * 60 + elapsed) / 1440);
  const elapsedAnchor = clockStyle === "elapsed" ? readElapsedClockAnchor(clock.elapsedAnchor) : null;
  const total = clockOffsetMinutes(clock) + elapsed;
  const displayDay = elapsedAnchor ? elapsedAnchor.day + Math.floor(total / 1440) : days + 1;
  const inDay = ((total % 1440) + 1440) % 1440;
  const hour = Math.floor(inDay / 60);
  const sc = shichen(hour);
  const baseDate = clockBaseDate(clock);
  const moved = clockStyle !== "elapsed" && baseDate ? shiftDate(baseDate, days, clock.rules) : null;
  const date = clockStyle === "elapsed" ? null : anchor
    ? shiftDate(anchor.date, Math.floor(total / 1440), clock.rules)
    : moved;
  const time = timeStyle === "24h" ? `${String(hour).padStart(2, "0")}:${String(inDay % 60).padStart(2, "0")}` : `${sc}时`;
  const text = clockStyle === "elapsed"
    ? `第 ${displayDay} 天 · ${time}`
    : date
    ? `${formatDate(date, clock.rules)} · ${time}`
    : `${clock.label ? `${clock.label} · ` : ""}第 ${days + 1} 日 · ${time}`;
  return { clockStyle, timeStyle, day: days + 1, displayDay, hour, minute: inDay % 60, shichen: sc, date, newYears: clockStyle !== "elapsed" && clock.date ? newYearsAfterDays(clock.date, days) : 0, text };
}

const YEAR = 365 * 1440;

/** Full 365-day years of play completed between two moments. */
export function playYears(fromMinutes: number, toMinutes: number): number {
  return toMinutes <= fromMinutes ? 0 : Math.floor(toMinutes / YEAR) - Math.floor(Math.max(0, fromMinutes) / YEAR);
}

/**
 * Years that add to ages between two moments: on a dated history clock each New
 * Year crossed (虚岁); without one (free worlds, stories with no usable date)
 * each full year of play, so ages still follow the time that passed.
 */
export function newYearsBetween(clock: GameClock, fromMinutes: number, toMinutes: number): number {
  if (toMinutes <= fromMinutes) return 0;
  if (clock.mode === "free" || !clock.date) return playYears(fromMinutes, toMinutes);
  // Ages use the original historical clock, never a display anchor or style.
  const years = (elapsed: number) => newYearsAfterDays(clock.date!, Math.floor((clock.hour * 60 + Math.max(0, elapsed)) / 1440));
  return years(toMinutes) - years(fromMinutes);
}

const hhmm = (now: Now) => `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`;

/** "酉时（约 17:40）" */
export function timeOfDay(now: Now): string {
  if ((now.timeStyle ?? (now.clockStyle === "elapsed" ? "24h" : "shichen")) === "24h") return hhmm(now);
  return `${now.shichen}时（约 ${hhmm(now)}）`;
}

/** How long ago, by calendar days: "刚刚" / "今天" / "昨天" / "3 天前" / "2 个月前" / "1 年前". */
export function agoText(clock: GameClock, thenMinutes: number, nowMinutes: number): string {
  const days = nowOf(clock, nowMinutes).day - nowOf(clock, thenMinutes).day;
  if (days <= 0) return nowMinutes - thenMinutes < 120 ? "刚刚" : "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** Rows for the time sheet: date, hour, CE year and 干支, season, time since the start. */
export function timeRows(clock: GameClock, elapsedMinutes: number): { label: string; value: string }[] {
  const now = nowOf(clock, elapsedMinutes);
  if (now.clockStyle === "elapsed") return [
    { label: "日期", value: `第 ${now.displayDay} 天` },
    { label: now.timeStyle === "shichen" ? "时辰" : "时间", value: timeOfDay(now) },
    { label: "开局", value: now.day === 1 ? "今天开局" : `已过 ${now.day - 1} 天` },
  ];
  const rows = [{ label: now.timeStyle === "24h" ? "时间" : "时辰", value: timeOfDay(now) }];
  const passed = now.day === 1 ? "今天开局" : `已过 ${now.day - 1} 天`;
  const opening = clock.date ? formatDate(clock.date, clock.rules) : clock.label || "开局日期未定";
  if (!now.date) return [...rows, { label: "开局", value: `${opening} · ${passed}` }];
  const ce = now.date.ceYear;
  if (ce != null) {
    const year = ce < 0 ? `公元前 ${-ce} 年` : `公元 ${ce} 年`;
    rows.push({ label: "公元", value: now.date.lunar ? `${year} · ${ganzhi(ce)}年` : year });
  }
  rows.push({ label: "时令", value: seasonDetail(now.date) });
  rows.push({ label: "开局", value: `${opening} · ${passed}` });
  return [{ label: "日期", value: formatDate(now.date, clock.rules) }, ...rows];
}
