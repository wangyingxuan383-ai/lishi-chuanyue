// The game's "now" (D119): the opening date plus elapsed minutes, shown as
// "天宝七载 冬月十九 · 酉时". Worlds whose opening gave no usable date count
// days instead ("第 3 日 · 酉时").
import { addDays, formatDate, ganzhi, seasonDetail, type CalendarRules, type GameDate } from "./date";

const SHICHEN = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];

export function shichen(hour: number): string {
  return SHICHEN[Math.floor((((hour + 1) % 24) + 24) % 24 / 2)];
}

/** Minute 0 of a world. */
export interface GameClock {
  mode?: "history" | "free";
  clockStyle?: "era" | "elapsed";
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
  /** Day of the story, from 1. */
  day: number;
  hour: number;
  minute: number;
  shichen: string;
  date: GameDate | null;
  /** New Years crossed since the start. */
  newYears: number;
  /** "天宝七载 冬月十九 · 酉时"; without a date "中平元年秋 · 第 3 日 · 酉时". */
  text: string;
}

export function nowOf(clock: GameClock, elapsedMinutes: number): Now {
  const clockStyle = clock.clockStyle ?? (clock.mode === "free" ? "elapsed" : "era");
  const total = clock.hour * 60 + Math.max(0, elapsedMinutes);
  const days = Math.floor(total / 1440);
  const inDay = total % 1440;
  const hour = Math.floor(inDay / 60);
  const sc = shichen(hour);
  const moved = clockStyle !== "elapsed" && clock.date ? addDays(clock.date, days, clock.rules) : null;
  const text = clockStyle === "elapsed"
    ? `第 ${days + 1} 天 · ${String(hour).padStart(2, "0")}:${String(inDay % 60).padStart(2, "0")}`
    : moved
    ? `${formatDate(moved.date, clock.rules)} · ${sc}时`
    : `${clock.label ? `${clock.label} · ` : ""}第 ${days + 1} 日 · ${sc}时`;
  return { clockStyle, day: days + 1, hour, minute: inDay % 60, shichen: sc, date: moved?.date ?? null, newYears: moved?.newYears ?? 0, text };
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
  if (clock.mode === "free" || clock.clockStyle === "elapsed" || !clock.date) return playYears(fromMinutes, toMinutes);
  return nowOf(clock, toMinutes).newYears - nowOf(clock, fromMinutes).newYears;
}

const hhmm = (now: Now) => `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`;

/** "酉时（约 17:40）" */
export function timeOfDay(now: Now): string {
  if (now.clockStyle === "elapsed") return hhmm(now);
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
    { label: "日期", value: `第 ${now.day} 天` },
    { label: "时间", value: timeOfDay(now) },
    { label: "开局", value: now.day === 1 ? "今天开局" : `已过 ${now.day - 1} 天` },
  ];
  const rows = [{ label: "时辰", value: timeOfDay(now) }];
  const passed = now.day === 1 ? "今天开局" : `已过 ${now.day - 1} 天`;
  if (!now.date || !clock.date) return [...rows, { label: "开局", value: `${clock.label || "开局日期未定"} · ${passed}` }];
  const ce = now.date.ceYear;
  if (ce != null) {
    const year = ce < 0 ? `公元前 ${-ce} 年` : `公元 ${ce} 年`;
    rows.push({ label: "公元", value: now.date.lunar ? `${year} · ${ganzhi(ce)}年` : year });
  }
  rows.push({ label: "时令", value: seasonDetail(now.date) });
  rows.push({ label: "开局", value: `${formatDate(clock.date, clock.rules)} · ${passed}` });
  return [{ label: "日期", value: formatDate(now.date, clock.rules) }, ...rows];
}
