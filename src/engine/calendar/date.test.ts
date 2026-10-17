import { describe, expect, it } from "vitest";
import {
  addDays, ceYearOf, cnDay, cnNumber, coerceDate, daysBetween, eraAt, formatDate, ganzhi, monthIndex, monthLabel, parseDateLabel, season, seasonDetail,
  type CalendarRules, type GameDate,
} from "./date";

const TANG: CalendarRules = {
  lunar: true,
  eras: [{ name: "天宝", startCe: 742, yearWord: "载" }, { name: "至德", startCe: 756, startMonth: 7, yearWord: "载" }, { name: "乾元", startCe: 758, startMonth: 2 }],
};
const tianbao7: GameDate = { era: "天宝", year: 7, month: 11, day: 17, ceYear: 748, lunar: true };

describe("numbers", () => {
  it.each([[1, "一"], [10, "十"], [11, "十一"], [20, "二十"], [37, "三十七"], [100, "一百"], [105, "一百零五"], [112, "一百一十二"]])("%i → %s", (n, s) => {
    expect(cnNumber(n)).toBe(s);
  });
  it.each([[1, "初一"], [10, "初十"], [11, "十一"], [20, "二十"], [21, "廿一"], [30, "三十"]])("day %i → %s", (d, s) => {
    expect(cnDay(d)).toBe(s);
  });
});

describe("formatDate", () => {
  it("formats lunar dates with era-specific year words", () => {
    expect(formatDate(tianbao7, TANG)).toBe("天宝七载 冬月十七");
    expect(formatDate({ ...tianbao7, era: "崇祯", year: 1, month: 1, day: 1 })).toBe("崇祯元年 正月初一");
  });
  it("formats western dates", () => {
    expect(formatDate({ era: "公元前", year: 44, month: 3, day: 14, ceYear: -44, lunar: false })).toBe("公元前44年 3月14日");
  });
});

describe("addDays", () => {
  it("moves within and across months (30/29 alternating)", () => {
    expect(addDays(tianbao7, 3, TANG).date).toMatchObject({ month: 11, day: 20 });
    expect(addDays(tianbao7, 13, TANG).date).toMatchObject({ month: 11, day: 30 });
    expect(addDays(tianbao7, 14, TANG).date).toMatchObject({ month: 12, day: 1 });
  });
  it("crosses New Year and keeps the era until the table changes it", () => {
    const { date, newYears } = addDays({ ...tianbao7, month: 12, day: 29 }, 1, TANG);
    expect(date).toMatchObject({ era: "天宝", year: 8, month: 1, day: 1, ceYear: 749 });
    expect(newYears).toBe(1);
  });
  it("switches eras that began mid-year at the start of their month", () => {
    const jan756 = addDays({ era: "天宝", year: 14, month: 12, day: 29, ceYear: 755, lunar: true }, 1, TANG).date;
    expect(jan756).toMatchObject({ era: "天宝", year: 15, ceYear: 756, month: 1 });
    const june = { ...jan756, month: 6, day: 29 };
    expect(addDays(june, 1, TANG).date).toMatchObject({ era: "至德", year: 1, month: 7, day: 1, ceYear: 756 });
    const next = addDays({ era: "至德", year: 2, month: 12, day: 29, ceYear: 757, lunar: true }, 1, TANG).date;
    expect(next).toMatchObject({ era: "至德", year: 3, ceYear: 758, month: 1 });
    expect(addDays({ ...next, day: 30 }, 1, TANG).date).toMatchObject({ era: "乾元", year: 1, month: 2 });
    expect(formatDate({ era: "乾元", year: 1, month: 2, day: 1, ceYear: 758, lunar: true }, TANG)).toBe("乾元元年 二月初一");
  });
  it("keeps counting an era that is not in the table", () => {
    expect(addDays({ era: "贞观", year: 3, month: 12, day: 29, ceYear: 629, lunar: true }, 1, TANG).date).toMatchObject({ era: "贞观", year: 4 });
  });
  it("counts BC years down and skips year 0", () => {
    const end = { era: "公元前", year: 1, month: 12, day: 31, ceYear: -1, lunar: false };
    expect(addDays(end, 1).date).toMatchObject({ era: "公元", year: 1, ceYear: 1, month: 1, day: 1 });
    expect(addDays({ ...end, year: 44, ceYear: -44 }, 1).date).toMatchObject({ era: "公元前", year: 43, ceYear: -43 });
  });
  it("supports eras that continue an earlier count", () => {
    const rules: CalendarRules = { eras: [{ name: "始皇", startCe: -246 }, { name: "二世", startCe: -209 }] };
    const d = addDays({ era: "始皇", year: 37, month: 12, day: 29, ceYear: -210, lunar: true }, 1, rules).date;
    expect(d).toMatchObject({ era: "二世", year: 1, ceYear: -209 });
  });
  it("uses western month lengths", () => {
    expect(addDays({ era: "公元前", year: 44, month: 2, day: 28, ceYear: -44, lunar: false }, 1).date).toMatchObject({ month: 3, day: 1 });
  });
  it("counts New Years over long spans", () => {
    expect(addDays(tianbao7, 3 * 354, TANG).newYears).toBe(3);
  });
});

describe("era table lookups", () => {
  it("finds the era in force and the CE year of an era year", () => {
    expect(eraAt(756, 6, TANG.eras!)?.name).toBe("天宝");
    expect(eraAt(756, 7, TANG.eras!)?.name).toBe("至德");
    expect(eraAt(700, 1, TANG.eras!)).toBeNull();
    expect(ceYearOf("天宝", 7, TANG)).toBe(748);
    expect(ceYearOf("始皇", 37, { eras: [{ name: "始皇", startCe: -246 }] })).toBe(-210);
    expect(ceYearOf("公元前", 44)).toBe(-44);
    expect(ceYearOf("贞观", 3, TANG)).toBeNull();
  });
});

describe("ganzhi and seasons", () => {
  it("names sexagenary years", () => {
    expect(ganzhi(748)).toBe("戊子");
    expect(ganzhi(1628)).toBe("戊辰");
    expect(ganzhi(184)).toBe("甲子");
    expect(ganzhi(-210)).toBe("辛卯");
  });
  it("derives seasons", () => {
    expect(season(tianbao7)).toBe("冬");
    expect(season({ ...tianbao7, month: 2 })).toBe("春");
    expect(season({ era: "公元前", year: 44, month: 3, day: 15, ceYear: -44, lunar: false })).toBe("春");
    expect(seasonDetail(tianbao7)).toBe("仲冬 · 冬至之月");
    expect(seasonDetail({ ...tianbao7, month: 1 })).toBe("孟春 · 雨水之月");
  });
});

describe("coerceDate", () => {
  it("accepts model output and infers lunar style", () => {
    expect(coerceDate({ era: "宣和", year: 4, month: 2, day: 3, ceYear: 1122 })).toEqual({ era: "宣和", year: 4, month: 2, day: 3, ceYear: 1122, lunar: true });
    expect(coerceDate({ era: "公元前", year: 44, month: 3, day: 14, ceYear: -44 })?.lunar).toBe(false);
    expect(coerceDate({ era: "宣和", year: "4", month: 2 })).toMatchObject({ day: 1, ceYear: null });
  });
  it("trusts the era table over the model's CE year", () => {
    expect(coerceDate({ era: "天宝", year: 7, month: 11, day: 17, ceYear: 749 }, TANG)?.ceYear).toBe(748);
  });
  it("rejects nonsense", () => {
    expect(coerceDate({ era: "", year: 1, month: 1, day: 1 })).toBeNull();
    expect(coerceDate({ era: "天宝", year: 7, month: 13, day: 1 })).toBeNull();
    expect(coerceDate("天宝七载")).toBeNull();
  });
});

describe("parseDateLabel", () => {
  it.each([
    ["天宝七载冬月十七", { era: "天宝", year: 7, month: 11, day: 17, ceYear: 748 }, "day"],
    ["天宝七载（戊子）冬月", { era: "天宝", year: 7, month: 11, day: 1 }, "month"],
    ["大唐天宝七载十一月初三", { era: "天宝", year: 7, month: 11, day: 3 }, "day"],
    ["宣和四年春二月初三", { era: "宣和", year: 4, month: 2, day: 3, ceYear: null }, "day"],
    ["崇祯元年正月廿三", { era: "崇祯", year: 1, month: 1, day: 23 }, "day"],
    ["光绪二十六年五月二十日", { era: "光绪", year: 26, month: 5, day: 20 }, "day"],
    ["开元二十九年腊月", { era: "开元", year: 29, month: 12 }, "month"],
    ["中平元年秋", { era: "中平", year: 1, month: 7, day: 1 }, "season"],
    ["始皇三十七年七月", { era: "始皇", year: 37, month: 7 }, "month"],
    ["公元前44年3月14日", { era: "公元前", year: 44, month: 3, day: 14, ceYear: -44, lunar: false }, "day"],
    // R14-T003: the organizer wrote London's events as "1665年4月", without 公元.
    ["1665年4月", { era: "公元", year: 1665, month: 4, day: 1, ceYear: 1665, lunar: false }, "month"],
    ["1666年9月2日", { era: "公元", year: 1666, month: 9, day: 2, ceYear: 1666 }, "day"],
  ] as const)("%s", (text, expected, precision) => {
    const parsed = parseDateLabel(text, TANG.eras!.some((e) => text.includes(e.name)) ? TANG : undefined);
    expect(parsed?.date).toMatchObject(expected);
    expect(parsed?.precision).toBe(precision);
  });
  it.each(["某年某月", "第一日", "", "冬月十七"])("rejects %s", (text) => {
    expect(parseDateLabel(text)).toBeNull();
  });
});

describe("monthIndex", () => {
  it("orders BC and AD months", () => {
    expect(monthIndex(-1, 12)).toBeLessThan(monthIndex(1, 1));
    expect(monthIndex(748, 11)).toBeLessThan(monthIndex(749, 1));
  });
});

describe("daysBetween", () => {
  it("counts lunar days within a year and across New Year, both ways", () => {
    expect(daysBetween(tianbao7, { ...tianbao7, day: 27 })).toBe(10);
    // 冬月十七 → 正月初一 of the next year: 13 days of 冬月 (30 days) + 29 of 腊月 + 1.
    expect(daysBetween(tianbao7, { era: "天宝", year: 8, month: 1, day: 1, ceYear: 749, lunar: true })).toBe(13 + 29 + 1);
    const later = addDays(tianbao7, 400, TANG).date;
    expect(daysBetween(tianbao7, later)).toBe(400);
    expect(daysBetween(later, tianbao7)).toBe(-400);
  });

  it("uses the era name when a made-up world has no CE years, and gives up across eras", () => {
    const jinghe = (year: number, month: number, day: number): GameDate => ({ era: "景和", year, month, day, ceYear: null, lunar: true });
    expect(daysBetween(jinghe(3, 2, 12), jinghe(3, 3, 12))).toBe(29);
    expect(daysBetween(jinghe(3, 2, 12), { ...jinghe(1, 1, 1), era: "永宁" })).toBeNull();
  });

  it("labels a month", () => {
    expect(monthLabel({ era: "天宝", year: 9, month: 10, day: 1, ceYear: 750, lunar: true }, TANG)).toBe("天宝九载 十月");
    expect(monthLabel({ era: "公元", year: 1665, month: 4, day: 1, ceYear: 1665, lunar: false })).toBe("公元1665年 4月");
  });
});
