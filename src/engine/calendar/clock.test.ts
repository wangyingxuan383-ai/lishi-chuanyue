import { describe, expect, it } from "vitest";
import { TANG_748 } from "../../content/eras/tang-748";
import { newYearsBetween, nowOf, shichen, timeRows, type GameClock } from "./clock";

const tang: GameClock = { date: { era: "天宝", year: 7, month: 11, day: 17, ceYear: 748, lunar: true }, hour: 7, label: "天宝七载 冬月十七", rules: TANG_748.calendar };
const vague: GameClock = { date: null, hour: 8, label: "中平元年秋", rules: {} };

describe("game clock", () => {
  it("names the double hour", () => {
    expect([23, 0, 7, 12, 18].map(shichen)).toEqual(["子", "子", "辰", "午", "酉"]);
  });

  it("shows the era date and double hour", () => {
    expect(nowOf(tang, 0).text).toBe("天宝七载 冬月十七 · 辰时");
    expect(nowOf(tang, 2 * 1440 + 11 * 60)).toMatchObject({ day: 3, hour: 18, text: "天宝七载 冬月十九 · 酉时" });
  });

  it("counts days when the start date is unknown", () => {
    expect(nowOf(vague, 0).text).toBe("中平元年秋 · 第 1 日 · 辰时");
    expect(nowOf(vague, 2 * 1440 + 10 * 60).text).toBe("中平元年秋 · 第 3 日 · 酉时");
    expect(nowOf({ ...vague, label: "" }, 0).text).toBe("第 1 日 · 辰时");
  });

  it("counts New Years between two moments", () => {
    const eve: GameClock = { ...tang, date: { ...tang.date!, month: 12, day: 29 }, hour: 20 };
    expect(newYearsBetween(eve, 0, 120)).toBe(0);
    expect(newYearsBetween(eve, 0, 240)).toBe(1);
    expect(newYearsBetween(eve, 240, 300)).toBe(0);
    expect(newYearsBetween(eve, 0, 400 * 1440)).toBe(2);
    expect(newYearsBetween(vague, 0, 400 * 1440)).toBe(0);
  });

  it("lists the details for the time sheet", () => {
    expect(timeRows(tang, 2 * 1440)).toEqual([
      { label: "日期", value: "天宝七载 冬月十九" },
      { label: "时辰", value: "辰时（约 07:00）" },
      { label: "公元", value: "公元 748 年 · 戊子年" },
      { label: "时令", value: "仲冬 · 冬至之月" },
      { label: "开局", value: "天宝七载 冬月十七 · 已过 2 天" },
    ]);
    expect(timeRows(vague, 0)).toEqual([
      { label: "时辰", value: "辰时（约 08:00）" },
      { label: "开局", value: "中平元年秋 · 今天开局" },
    ]);
  });

  it("shows western dates without 干支", () => {
    const rome: GameClock = { date: { era: "公元前", year: 44, month: 3, day: 14, ceYear: -44, lunar: false }, hour: 21, label: "", rules: { lunar: false } };
    expect(nowOf(rome, 180).text).toBe("公元前44年 3月15日 · 子时");
    expect(timeRows(rome, 0)[2]).toEqual({ label: "公元", value: "公元前 44 年" });
  });
});
