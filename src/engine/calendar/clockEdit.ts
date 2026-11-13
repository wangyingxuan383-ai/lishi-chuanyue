// Shared display-only contract. It never edits elapsedMinutes, ages or deadlines.
import type { WorldState } from "../types";
import { coerceDate, monthDays, readDate, type CalendarRules } from "./date";
import { readClockAnchor, readElapsedClockAnchor, type ClockAnchor, type ElapsedClockAnchor } from "./clock";

export interface ClockDisplayChange {
  clockStyle?: "era" | "elapsed";
  timeStyle?: "24h" | "shichen";
  calendar?: CalendarRules;
  anchor?: ClockAnchor | null;
  elapsedAnchor?: ElapsedClockAnchor | null;
}

export function applyDisplayClock(before: WorldState, changes: ClockDisplayChange): WorldState {
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length
    || Object.keys(changes).some(key => !["clockStyle", "timeStyle", "calendar", "anchor", "elapsedAnchor"].includes(key))) throw new Error("请选择时间显示方式或提供日期/日序锚点；显示设置不能更改实际经过");
  if (changes.clockStyle !== undefined && !["era", "elapsed"].includes(changes.clockStyle)
    || changes.timeStyle !== undefined && !["24h", "shichen"].includes(changes.timeStyle)) throw new Error("时间显示方式无效");
  if (changes.calendar !== undefined) validateCalendar(changes.calendar);
  const next = structuredClone(before);
  for (const key of ["clockStyle", "timeStyle", "calendar"] as const) if (changes[key] !== undefined) Object.assign(next.era, { [key]: structuredClone(changes[key]) });
  for (const key of ["anchor", "elapsedAnchor"] as const) if (changes[key] !== undefined) Object.assign(next.time, { [key]: structuredClone(changes[key]) });
  const rules = next.era.calendar ?? {};
  if (!Number.isFinite(next.time.elapsedMinutes) || next.time.elapsedMinutes < 0 || next.time.elapsedMinutes > Number.MAX_SAFE_INTEGER) throw new Error("经过时间必须是非负有限数值");
  if (next.time.startHour !== undefined && (!Number.isFinite(next.time.startHour) || next.time.startHour < 0 || next.time.startHour >= 24)) throw new Error("开局时间须在0至24点之间");
  const configuration = (state: WorldState) => JSON.stringify({ era: state.era, time: { ...state.time, elapsedMinutes: undefined } });
  if (configuration(before) === configuration(next)) return next;
  if (next.era.calendar != null) validateCalendar(next.era.calendar);
  if (next.time.date != null) {
    const date = coerceDate(next.time.date, rules);
    if (!date || next.time.date.day !== date.day || date.day > monthDays(date) || next.time.date.ceYear != null && next.time.date.ceYear !== date.ceYear) throw new Error("开局日期无效，请先核对原有纪年和历法。");
  }
  if (next.time.anchor != null && !readClockAnchor(next.time.anchor, rules)) throw new Error("日期锚点无效：请提供有效日期、非负经过分钟和0至1439的当天分钟");
  if (changes.anchor && next.era.mode === "free" && !["公元", "公元前"].includes(changes.anchor.date.era) && changes.anchor.date.ceYear !== null) throw new Error("自由世界的自定纪年不映射为公元年，请保留未知公元年");
  if (next.time.elapsedAnchor != null && !readElapsedClockAnchor(next.time.elapsedAnchor)) throw new Error("日序锚点无效：须提供非负安全整数经过分钟、正整数日序和0至1439的当天分钟");
  const style = next.era.clockStyle ?? (next.era.mode === "free" ? "elapsed" : "era");
  if (style === "era" && !readClockAnchor(next.time.anchor, rules) && !(next.time.date !== undefined ? coerceDate(next.time.date, rules) : readDate(next.time.start, rules))) throw new Error("请先填写有效的当前纪年日期，再切换纪年显示");
  return next;
}

function validateCalendar(raw: CalendarRules) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !["eras", "yearWord", "lunar"].includes(key))
    || raw.lunar !== undefined && typeof raw.lunar !== "boolean"
    || raw.yearWord !== undefined && (typeof raw.yearWord !== "string" || [...raw.yearWord].length > 24)) throw new Error("历法字段无效");
  if (raw.eras !== undefined) {
    if (!Array.isArray(raw.eras)) throw new Error("年号表必须是列表");
    let previous = -Infinity;
    const names = new Set<string>();
    for (const era of raw.eras) {
      const at = (era.startCe < 0 ? era.startCe + 1 : era.startCe) * 12 + (era.startMonth ?? 1) - 1;
      if (!era.name?.trim() || era.name.length > 12 || names.has(era.name.trim()) || !Number.isInteger(era.startCe) || !era.startCe || Math.abs(era.startCe) > 9999
        || !Number.isInteger(era.startMonth ?? 1) || (era.startMonth ?? 1) < 1 || (era.startMonth ?? 1) > 12 || at <= previous
        || era.firstYear !== undefined && (!Number.isInteger(era.firstYear) || era.firstYear < 1 || era.firstYear > 9999)
        || era.yearWord !== undefined && (typeof era.yearWord !== "string" || [...era.yearWord].length > 24)) throw new Error("年号表须按生效时间排序，且名称、纪年不得重复或越界");
      previous = at; names.add(era.name.trim());
    }
  }
}

/** Strict form date validation; imported date coercion is intentionally more tolerant. */
export function validClockDate(raw: unknown, rules: CalendarRules) {
  const date = coerceDate(raw, rules);
  const value = raw as Record<string, unknown> | null;
  return date && value && value.day === date.day && date.day <= monthDays(date) ? date : null;
}
