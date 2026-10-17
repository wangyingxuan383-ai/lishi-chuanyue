import { describe, expect, it } from "vitest";
import { TANG_748 } from "../content/eras/tang-748";
import type { GameClock } from "./calendar/clock";
import { eventsBetween, packTimeline, placeEvent, retime, worldBlock } from "./timeline";
import type { TimelineEvent } from "./types";

const tang: GameClock = { date: TANG_748.start.date, hour: 7, label: "天宝七载 冬月十七", rules: TANG_748.calendar };
const DAY = 1440;

describe("timeline", () => {
  it("places a pack's events against the start: earlier ones are history", () => {
    const events = packTimeline(TANG_748.timeline, tang);
    const sisters = events.find((e) => e.title.includes("三位姐姐"))!;
    const shibao = events.find((e) => e.title.includes("石堡城"))!;
    expect(sisters).toMatchObject({ date: "天宝七载 冬月", kind: "可变", source: "卡组" });
    expect(sisters.atMinute!).toBeLessThan(0);
    expect(shibao.date).toBe("天宝八载 六月");
    expect(shibao.atMinute! / DAY).toBeGreaterThan(190);
    expect(placeEvent(tang, { date: "天宝九载十月", title: "杨钊赐名国忠", kind: "可变" })).toMatchObject({ date: "天宝九载 十月", kind: "可变" });
    expect(placeEvent(tang, { date: "某年某月", title: "说不清的事" }).atMinute).toBeNull();
  });

  it("finds the events a span of time crossed and tells the narrator what is near", () => {
    const timeline: TimelineEvent[] = [
      { id: "a", date: "甲", atMinute: 10 * DAY, title: "大雪封路", kind: "固定" },
      { id: "b", date: "乙", atMinute: 40 * DAY, title: "宰相病死", kind: "可变" },
      { id: "c", date: "丙", atMinute: 200 * DAY, title: "边镇起兵", kind: "可变" },
    ];
    expect(eventsBetween(timeline, 0, 30 * DAY).map((e) => e.id)).toEqual(["a"]);
    expect(eventsBetween(timeline, 10 * DAY, 30 * DAY)).toEqual([]);
    const block = worldBlock({ timeline, deviations: ["天宝七载腊月：救下了王忠嗣"], time: { start: "", elapsedMinutes: 20 * DAY } });
    // By default only what has happened: the books' future is the player's, not the narrator's.
    expect(block).toContain("【天下大事】\n甲：大雪封路");
    expect(block).not.toMatch(/宰相病死|边镇起兵|将会/);
    expect(block).toContain("【历史偏离（这一世已经和史书不同的事）】\n- 天宝七载腊月：救下了王忠嗣");
    expect(worldBlock({ timeline, deviations: [], time: { start: "", elapsedMinutes: 20 * DAY } }, 365 * DAY)).toContain("丙将会：边镇起兵");
    expect(worldBlock({ deviations: [], time: { start: "", elapsedMinutes: 0 } })).toBe("");
  });

  it("places an event in a later reign by its CE year, also when the start moves", () => {
    // A world organized without a pack has no reign table: 至德 cannot be counted from 天宝 by its label alone.
    const clock: GameClock = { date: { era: "天宝", year: 14, month: 11, day: 9, ceYear: 755, lunar: true }, hour: 8, label: "天宝十四载 冬月初九", rules: {} };
    expect(placeEvent(clock, { date: "至德元载七月", title: "太子即位于灵武" }).atMinute).toBeNull();
    const placed = placeEvent(clock, { date: "至德元载七月", title: "太子即位于灵武", ceYear: 756, kind: "固定" });
    expect(placed).toMatchObject({ date: "至德元年 七月", kind: "固定", ceYear: 756 });
    expect(placed.atMinute! / DAY).toBeGreaterThan(200);
    expect(placed.atMinute! / DAY).toBeLessThan(260);
    // Nonsense years are ignored rather than trusted.
    expect(placeEvent(clock, { date: "至德元载七月", title: "x", ceYear: 0 })).not.toHaveProperty("ceYear");
    const earlier = retime([{ id: "e", source: "AI", ...placed }], { ...clock, date: { ...clock.date!, year: 13, ceYear: 754 } })[0];
    expect(Math.round((earlier.atMinute! - placed.atMinute!) / DAY)).toBe(354);
  });

  it("places western dates written without 公元 (R14-T003: London's events were all left unplaced)", () => {
    const london: GameClock = { date: { era: "公元", year: 1665, month: 4, day: 28, ceYear: 1665, lunar: false }, hour: 9, label: "公元1665年 4月28日", rules: { lunar: false } };
    const fire = placeEvent(london, { date: "1666年9月", title: "伦敦大火", ceYear: 1666, kind: "固定" });
    expect(fire).toMatchObject({ date: "公元1666年 9月", kind: "固定" });
    expect(Math.round(fire.atMinute! / DAY)).toBe(491);
    expect(placeEvent(london, { date: "1665年6月", title: "洛斯托夫特海战", kind: "固定" }).atMinute! / DAY).toBeGreaterThan(30);
  });
});
