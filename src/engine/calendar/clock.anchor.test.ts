import { describe, expect, it } from "vitest";
import { eraContext } from "../era";
import { applyRecord } from "../state/apply";
import { sampleState } from "../testing/fixtures";
import { TANG_748 } from "../../content/eras/tang-748";
import { addDays } from "./date";
import { clockOffsetMinutes, newYearsBetween, nowOf, readClockAnchor, timeOfDay, timeRows, type GameClock } from "./clock";

const elapsed = 4054 * 1440 + 12 * 60 + 5;
const anchor = { atElapsedMinutes: elapsed, date: { era: "斗罗", year: 2631, month: 5, day: 8, ceYear: null, lunar: false }, minuteOfDay: 20 * 60 + 5 };
const clock: GameClock = { mode: "free", clockStyle: "era", timeStyle: "24h", anchor, date: null, hour: 8, label: "", rules: { lunar: false } };

describe("independent clock calibration", () => {
  it("calibrates day 4055 without resetting elapsed time, age, deadline or free-world rules", () => {
    const state = sampleState();
    state.era = { mode: "free", clockStyle: "era", timeStyle: "24h", packId: null, calendar: { lunar: false } };
    state.time = { start: "", startHour: 8, elapsedMinutes: elapsed, anchor };
    state.challenge = { goal: "找到同伴", limit: "十天", deadlineMinute: elapsed + 14400, failIf: "", progress: "", status: "active", startedMinute: elapsed };
    const before = structuredClone(state);
    const context = eraContext("tang-748", state);
    expect(context).toMatchObject({ mode: "free", packId: null });
    expect(nowOf(context.clock, elapsed)).toMatchObject({ day: 4055, text: "斗罗2631年 5月8日 · 20:05" });
    const applied = applyRecord(state, { time: 0, deviation: "不应制造史事" }, { mode: "continue", difficulty: "标准", currency: context.currency, clock: context.clock });
    expect(applied.state.time).toEqual(before.time);
    expect(applied.state.protagonist.age).toBe(before.protagonist.age);
    expect(applied.state.challenge?.deadlineMinute).toBe(before.challenge?.deadlineMinute);
    expect(applied.state.deviations).toEqual(before.deviations);
    expect(state).toEqual(before);
  });

  it("chooses date and time styles independently and can return to elapsed days", () => {
    expect(nowOf({ ...clock, timeStyle: "shichen" }, elapsed).text).toBe("斗罗2631年 5月8日 · 戌时");
    const counted = nowOf({ ...clock, clockStyle: "elapsed" }, elapsed);
    expect(counted.text).toBe("第 4055 天 · 20:05");
    expect(timeOfDay(counted)).toBe("20:05");
    expect(nowOf({ ...clock, clockStyle: "elapsed", timeStyle: "shichen" }, elapsed).text).toBe("第 4055 天 · 戌时");
    expect(timeRows(clock, elapsed)).toContainEqual({ label: "日期", value: "斗罗2631年 5月8日" });
    expect(clockOffsetMinutes(clock) + elapsed).toBe(anchor.minuteOfDay);
  });

  it("projects both sides of an anchor across BC/AD without a year zero", () => {
    const calibrated: GameClock = { ...clock, anchor: { atElapsedMinutes: 120, minuteOfDay: 0, date: { era: "公元", year: 1, month: 1, day: 1, ceYear: 1, lunar: false } } };
    expect(nowOf(calibrated, 0)).toMatchObject({ hour: 22, date: { era: "公元前", year: 1, month: 12, day: 31, ceYear: -1 } });
    expect(nowOf(calibrated, 240)).toMatchObject({ hour: 2, date: { era: "公元", year: 1, month: 1, day: 1, ceYear: 1 } });
  });

  it("preserves the saved simplified-calendar projection across months, years and era changes", () => {
    const legacy: GameClock = { mode: "history", clockStyle: "era", hour: 8, label: "", rules: TANG_748.calendar, date: { era: "天宝", year: 15, month: 6, day: 20, ceYear: 756, lunar: true } };
    for (const days of [0, 1, 28, 29, 30, 31, 354, 710, 4054]) {
      expect(nowOf(legacy, days * 1440).date).toEqual(addDays(legacy.date!, days, legacy.rules).date);
    }
  });

  it("keeps history ages on the original calendar and free ages on elapsed years", () => {
    const historical: GameClock = { ...clock, mode: "history", date: { era: "天宝", year: 7, month: 12, day: 29, ceYear: 748, lunar: true }, hour: 20 };
    for (const clockStyle of ["elapsed", "era"] as const) {
      expect(newYearsBetween({ ...historical, clockStyle }, 0, 240)).toBe(1);
      expect(newYearsBetween({ ...historical, clockStyle, mode: "free" }, 0, 240)).toBe(0);
    }
    expect(newYearsBetween(clock, elapsed, elapsed + 365 * 1440)).toBe(1);
  });

  it("rejects impossible or unsafe anchors instead of silently clamping dates", () => {
    for (const bad of [
      { ...anchor, atElapsedMinutes: -1 }, { ...anchor, minuteOfDay: 1440 },
      { ...anchor, atElapsedMinutes: Number.MAX_SAFE_INTEGER + 1 },
      { ...anchor, date: { ...anchor.date, month: 2, day: 29 } },
      { ...anchor, date: { ...anchor.date, month: 2, day: 30, lunar: true } },
      { ...anchor, date: { era: "公元", year: 2026, month: 1, day: 1, ceYear: 2025, lunar: false } },
    ]) expect(readClockAnchor(bad, clock.rules)).toBeNull();
    expect(nowOf({ ...clock, anchor: { ...anchor, minuteOfDay: 1440 } }, 0).hour).toBe(8);
  });

  it("projects a fictional year above 9999 without giving it a CE identity", () => {
    const calibrated: GameClock = { ...clock, anchor: { atElapsedMinutes: elapsed, minuteOfDay: 1430,
      date: { era: "斗罗历", year: 10015, month: 12, day: 31, ceYear: null, lunar: false } } };
    expect(nowOf(calibrated, elapsed).text).toBe("斗罗历10015年 12月31日 · 23:50");
    expect(nowOf(calibrated, elapsed + 20)).toMatchObject({ date: { era: "斗罗历", year: 10016, month: 1, day: 1, ceYear: null }, text: "斗罗历10016年 1月1日 · 00:10" });
    expect(readClockAnchor({ ...anchor, date: { ...anchor.date, year: 1_000_000_000 } }, clock.rules)).toBeNull();
    const collision = { ...calibrated, rules: { lunar: false, eras: [{ name: "斗罗历", startCe: 1 }] } };
    expect(nowOf(collision, elapsed).date?.ceYear).toBeNull();
  });

  it("keeps a free world's explicit base-date CE unknown despite a matching era table", () => {
    const base: GameClock = { mode: "free", clockStyle: "era", timeStyle: "24h", anchor: null,
      hour: 23.5, label: "", rules: { lunar: false, eras: [{ name: "斗罗历", startCe: 1 }] },
      date: { era: "斗罗历", year: 10015, month: 12, day: 31, ceYear: null, lunar: false } };
    expect(nowOf(base, 10)).toMatchObject({ date: { era: "斗罗历", year: 10015, ceYear: null }, text: "斗罗历10015年 12月31日 · 23:40" });
    expect(nowOf(base, 40)).toMatchObject({ date: { era: "斗罗历", year: 10016, month: 1, day: 1, ceYear: null }, text: "斗罗历10016年 1月1日 · 00:10" });
    expect(base.date?.ceYear).toBeNull();
    // Existing saved CE values are not silently erased by the display helper.
    expect(nowOf({ ...base, date: { ...base.date!, ceYear: 10015 } }, 10).date?.ceYear).toBe(10015);
  });
});
