import { describe, expect, it } from "vitest";
import type { GameClock } from "../../engine/calendar/clock";
import { placeEvent } from "../../engine/timeline";
import type { TimelineEvent } from "../../engine/types";
import { keptCeYear } from "./Journal";

describe("editing a great event in another reign", () => {
  // No reign table: 至德 cannot be counted from 天宝 by its written date alone.
  const clock: GameClock = { date: { era: "天宝", year: 14, month: 11, day: 9, ceYear: 755, lunar: true }, hour: 8, label: "天宝十四载 冬月初九", rules: {} };
  const event: TimelineEvent = { id: "e", source: "AI", ...placeEvent(clock, { date: "至德元载七月", title: "太子即位于灵武", ceYear: 756, kind: "固定" }) };

  it("keeps the CE year while the reign stays, moving it with the year", () => {
    expect(event.atMinute).not.toBeNull();
    expect(keptCeYear(event, event.date, clock)).toBe(756);
    expect(keptCeYear(event, "至德二载三月", clock)).toBe(757);
    const edited = placeEvent(clock, { date: event.date, title: "肃宗即位于灵武", kind: "固定", ceYear: keptCeYear(event, event.date, clock) });
    expect(edited.atMinute).toBe(event.atMinute);
  });
  it("drops it for another reign, a date the clock can count itself, or an event without one", () => {
    expect(keptCeYear(event, "乾元元年三月", clock)).toBeUndefined();
    expect(keptCeYear(event, "天宝十五载正月", clock)).toBeUndefined();
    expect(keptCeYear({ ...event, ceYear: undefined }, event.date, clock)).toBeUndefined();
    expect(keptCeYear(null, event.date, clock)).toBeUndefined();
  });
});
