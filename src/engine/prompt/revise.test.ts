import { describe, expect, it } from "vitest";
import { parseReviseEntry, parseReviseRules, reviseEntryMessages, reviseRulesMessages } from "./revise";

describe("让 AI 改设定 (R29-T005)", () => {
  const entry = { label: "势力卡", name: "青云书院", aliases: ["青云"], text: "怪才书院。" };
  it("keeps the old name and aliases when the model leaves them out, and refuses an empty change", () => {
    expect(parseReviseEntry({ text: "只收怪才的书院，分内外院。" }, entry)).toEqual({ name: "青云书院", aliases: ["青云"], text: "只收怪才的书院，分内外院。" });
    expect(parseReviseEntry({ name: "", text: "" }, entry)).toBeNull();
    expect(parseReviseEntry("不是对象", entry)).toBeNull();
  });
  it("takes only valid time and currency fields", () => {
    expect(parseReviseRules({ clockStyle: "era", eraName: "玄元历", year: 2800, month: 13, hour: 25, currency: [{ name: "金灵币", value: 10000 }, { name: "", value: 3 }, { name: "铜灵币", value: 1 }], note: "改用玄元历" }))
      .toEqual({ clockStyle: "era", eraName: "玄元历", year: 2800, currency: [{ name: "金灵币", value: 10000 }, { name: "铜灵币", value: 1 }], note: "改用玄元历" });
    expect(parseReviseRules({ note: "没改什么" })).toBeNull();
  });
  it("sends the original only when asked", () => {
    const plain = reviseEntryMessages(entry, "补上来历", { premise: "玄元", protagonist: "林舟" });
    const sourced = reviseRulesMessages({ clockStyle: "elapsed", timeStyle: "24h", lunar: false, eraName: "", year: null, month: 1, day: 1, displayDay: 3, hour: 8, minute: 0, currency: [] }, "改用玄元历", { premise: "玄元", protagonist: "林舟", source: "【原著札记】玄元历两千八百年" });
    expect(plain[1].content).not.toContain("【参考原著】");
    expect(sourced[1].content).toContain("玄元历两千八百年");
  });
});
