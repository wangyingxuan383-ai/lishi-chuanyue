import { describe, expect, it } from "vitest";
import { addDays, cnDay, cnNumber, coerceDate, formatDate, ganzhi, monthIndex, season, type CalendarRules, type GameDate } from "./date";

const TANG: CalendarRules = { eras: [{ name: "天宝", startCe: 742, yearWord: "载" }, { name: "至德", startCe: 756, yearWord: "载" }, { name: "乾元", startCe: 758 }] };
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
  it("crosses New Year and follows the era table", () => {
    const { date, newYears } = addDays({ ...tianbao7, month: 12, day: 29 }, 1, TANG);
    expect(date).toMatchObject({ era: "天宝", year: 8, month: 1, day: 1, ceYear: 749 });
    expect(newYears).toBe(1);
    const later = addDays({ era: "天宝", year: 14, month: 12, day: 29, ceYear: 755, lunar: true }, 1, TANG).date;
    expect(later).toMatchObject({ era: "至德", year: 1, ceYear: 756 });
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
  it("counts New Years over long spans", () => {
    expect(addDays(tianbao7, 3 * 354, TANG).newYears).toBe(3);
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
  });
});

describe("coerceDate", () => {
  it("accepts model output and infers lunar style", () => {
    expect(coerceDate({ era: "宣和", year: 4, month: 2, day: 3, ceYear: 1122 })).toEqual({ era: "宣和", year: 4, month: 2, day: 3, ceYear: 1122, lunar: true });
    expect(coerceDate({ era: "公元前", year: 44, month: 3, day: 14, ceYear: -44 })?.lunar).toBe(false);
  });
  it("rejects nonsense", () => {
    expect(coerceDate({ era: "", year: 1, month: 1, day: 1 })).toBeNull();
    expect(coerceDate({ era: "天宝", year: 7, month: 13, day: 1 })).toBeNull();
    expect(coerceDate("天宝七载")).toBeNull();
  });
});

describe("monthIndex", () => {
  it("orders BC and AD months", () => {
    expect(monthIndex(-1, 12)).toBeLessThan(monthIndex(1, 1));
    expect(monthIndex(748, 11)).toBeLessThan(monthIndex(749, 1));
  });
});
