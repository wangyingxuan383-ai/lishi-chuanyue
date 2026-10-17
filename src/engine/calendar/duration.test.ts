import { describe, expect, it } from "vitest";
import { parseChineseNumber, parseDurationMinutes, skipSpanMinutes } from "./duration";

describe("parseChineseNumber", () => {
  it.each([["十", 10], ["十五", 15], ["二十", 20], ["一百二十", 120], ["两", 2], ["90", 90]])("%s", (text, value) => {
    expect(parseChineseNumber(text)).toBe(value);
  });
});

describe("parseDurationMinutes", () => {
  it.each([
    ["一刻", 15],
    ["一刻钟", 15],
    ["两刻钟", 30],
    ["半个时辰", 60],
    ["一个时辰", 120],
    ["两个时辰", 240],
    ["一个半时辰", 180],
    ["一个时辰半", 180],
    ["约莫半个时辰", 60],
    ["90分钟", 90],
    ["十五分钟", 15],
    ["三天", 4320],
    ["一夜", 720],
    ["一炷香", 30],
    ["一盏茶", 10],
    ["半天", 720],
    ["一个月", 43200],
    ["2小时", 120],
    ["半个时辰左右", 60],
    ["十几息", 1],
    ["数日", 4320],
    ["几个时辰", 360],
    ["片刻", 5],
    ["须臾之间", 5],
    ["转眼", 1],
    ["一会儿", 10],
    ["转眼三个月", 129600],
    ["转眼一年", 525600],
    ["须臾两日", 2880],
    ["一个多月", 43200],
    ["三个多月", 129600],
    ["十多天", 14400],
    ["二十余日", 28800],
    ["月余", 43200],
    ["一年多", 525600],
  ])("%s → %i", (text, minutes) => {
    expect(parseDurationMinutes(text)).toBe(minutes);
  });

  it("accepts plain minute numbers", () => {
    expect(parseDurationMinutes(45)).toBe(45);
    expect(parseDurationMinutes("45")).toBe(45);
  });

  it("reads only the span of a 过些日子, not the plan after it", () => {
    expect(skipSpanMinutes("过一个月；这段时间读完十年的账册")).toBe(43200);
    expect(skipSpanMinutes("过三天")).toBe(4320);
  });

  it("returns null when nothing is recognisable", () => {
    expect(parseDurationMinutes("很久")).toBeNull();
    expect(parseDurationMinutes("日头偏西")).toBeNull();
    expect(parseDurationMinutes("")).toBeNull();
    expect(parseDurationMinutes(undefined)).toBeNull();
  });
});
