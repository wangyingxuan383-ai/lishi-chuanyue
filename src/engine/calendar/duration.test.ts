import { describe, expect, it } from "vitest";
import { parseChineseNumber, parseDurationMinutes } from "./duration";

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
  ])("%s → %i", (text, minutes) => {
    expect(parseDurationMinutes(text)).toBe(minutes);
  });

  it("accepts plain minute numbers", () => {
    expect(parseDurationMinutes(45)).toBe(45);
    expect(parseDurationMinutes("45")).toBe(45);
  });

  it("returns null when nothing is recognisable", () => {
    expect(parseDurationMinutes("很久")).toBeNull();
    expect(parseDurationMinutes("日头偏西")).toBeNull();
    expect(parseDurationMinutes("")).toBeNull();
    expect(parseDurationMinutes(undefined)).toBeNull();
  });
});
