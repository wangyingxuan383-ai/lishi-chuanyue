import { describe, expect, it } from "vitest";
import { bestMatches, clausesOf, describes, excerpt, pairWeights, pairsOf } from "./match";

describe("matching what the player wrote", () => {
  it("splits text into character pairs, ignoring punctuation", () => {
    expect(pairsOf("皮甲，夹层A1")).toEqual(["皮甲", "夹层", "层A", "A1"]);
    expect(pairsOf("他")).toEqual([]);
  });

  it("tells when a name is described without being spelled out", () => {
    expect(describes("刺客身上刻着鹰隼的乌木包银腰牌", "乌木包银鹰牌")).toBeGreaterThan(0.5);
    expect(describes("去找赵四", "赵四")).toBe(0); // one pair: exact matching handles it
    expect(describes("银子不够", "乌木包银鹰牌")).toBe(0);
  });

  it("matches each part of an action on its own and ignores question words", () => {
    expect(clausesOf("那两封信呢？再去西市。好")).toEqual(["那两封信呢", "再去西市"]);
    const keys = [...pairWeights("那封信是什么", ["信", "什么"]).keys()];
    expect(keys).toContain("封信");
    expect(keys).not.toContain("什么");
    expect(keys).not.toContain("是什");
    expect(pairWeights("皮甲", ["皮甲", "马车", "马车"]).get("皮甲")).toBe(1);
  });

  it("finds the passage that shares the rarest pairs", () => {
    const passages = [
      { text: "你把两封私信塞进贴身皮甲的夹层里。", at: 18 },
      { text: "马车停在门外。", at: 17 },
      { text: "他问你：“这是什么？”", at: 92 },
      { text: "门外的马车又来了。", at: 30 },
    ];
    const weights = pairWeights("我藏在贴身皮甲里的东西是什么", passages.map((p) => p.text));
    expect(bestMatches("我藏在贴身皮甲里的东西是什么", passages, weights, 2).map((p) => p.at)).toEqual([18]);
    expect(bestMatches("风很大", passages, weights, 2)).toEqual([]);
  });

  it("cuts long sentences around the part that matched", () => {
    const long = `${"甲".repeat(60)}两封私信塞进贴身皮甲${"乙".repeat(60)}`;
    const cut = excerpt(long, "贴身皮甲", 30);
    expect(cut).toContain("贴身皮甲");
    expect(cut.startsWith("…") && cut.endsWith("…")).toBe(true);
    expect(excerpt("短句。", "短句", 30)).toBe("短句。");
  });
});
