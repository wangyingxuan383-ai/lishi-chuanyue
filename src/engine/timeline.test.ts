import { describe, expect, it } from "vitest";
import { TANG_748 } from "../content/eras/tang-748";
import type { GameClock } from "./calendar/clock";
import { eventsBetween, packTimeline, placeEvent, worldBlock } from "./timeline";
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
    expect(block).toContain("甲：大雪封路\n乙将会：宰相病死（按史书，可能因剧情改变）");
    expect(block).not.toContain("边镇起兵");
    expect(block).toContain("【历史偏离（这一世已经和史书不同的事）】\n- 天宝七载腊月：救下了王忠嗣");
    expect(worldBlock({ timeline, deviations: [], time: { start: "", elapsedMinutes: 20 * DAY } }, 365 * DAY)).toContain("丙将会：边镇起兵");
    expect(worldBlock({ deviations: [], time: { start: "", elapsedMinutes: 0 } })).toBe("");
  });
});
