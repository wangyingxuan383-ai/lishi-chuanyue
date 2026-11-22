import { describe, expect, it } from "vitest";
import { diffStats, diffText } from "./textDiff";

describe("textDiff", () => {
  it("returns one unchanged segment when texts match", () => {
    expect(diffText("雨落长安。", "雨落长安。")).toEqual([{ kind: "same", text: "雨落长安。" }]);
    expect(diffText("", "")).toEqual([]);
  });

  it("highlights localized Chinese edits accurately", () => {
    const parts = diffText("你握着匕首练到第二式。", "你握着短剑练到第三式。");
    expect(parts).toEqual([
      { kind: "same", text: "你握着" },
      { kind: "del", text: "匕首" },
      { kind: "ins", text: "短剑" },
      { kind: "same", text: "练到第" },
      { kind: "del", text: "二" },
      { kind: "ins", text: "三" },
      { kind: "same", text: "式。" },
    ]);
    expect(diffStats(parts)).toEqual({ added: 3, removed: 3 });
  });

  it("reconstructs both original and revised strings on long multi-clause edits", () => {
    const before = "第一段在长安西市买了一柄青铜剑，花了三十文。".repeat(35);
    const after = before.replace("青铜剑，花了三十文", "精铁短剑，花了五十文");
    const parts = diffText(before, after);
    expect(parts.filter((p) => p.kind !== "ins").map((p) => p.text).join("")).toBe(before);
    expect(parts.filter((p) => p.kind !== "del").map((p) => p.text).join("")).toBe(after);
    expect(diffStats(parts).added).toBeGreaterThan(0);
  });
});
