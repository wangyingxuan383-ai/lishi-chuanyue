import { describe, expect, it } from "vitest";
import { FORTUNE_WEIGHTS, FORTUNES, fortuneMode, fortuneNote, rollFortune } from "./fortune";

/** A small seeded generator, so the spread is the same on every run. */
function seeded(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

describe("fortune", () => {
  it("maps the dice onto the five levels", () => {
    expect(rollFortune("标准", () => 0)).toBe("大顺");
    expect(rollFortune("标准", () => 0.999)).toBe("大不顺");
    expect(rollFortune("标准", () => 0.5)).toBe("平");
  });

  it("leans lucky on easy and unlucky on harsh", () => {
    const share = (difficulty: "宽松" | "标准" | "残酷") => {
      const random = seeded(7);
      const rolls = Array.from({ length: 4000 }, () => rollFortune(difficulty, random));
      const unlucky = rolls.filter((f) => f === "不顺" || f === "大不顺").length / rolls.length;
      expect(new Set(rolls)).toEqual(new Set(FORTUNES));
      return unlucky;
    };
    const [easy, normal, harsh] = [share("宽松"), share("标准"), share("残酷")];
    expect(easy).toBeLessThan(normal);
    expect(normal).toBeLessThan(harsh);
    expect(harsh).toBeGreaterThan(0.4);
  });

  it("has weights that sum to 100, rare extremes, and order by difficulty (R11-T008)", () => {
    for (const w of Object.values(FORTUNE_WEIGHTS)) expect(w.reduce((a, b) => a + b, 0)).toBe(100);
    const [easy, normal, harsh] = [FORTUNE_WEIGHTS["宽松"], FORTUNE_WEIGHTS["标准"], FORTUNE_WEIGHTS["残酷"]];
    const lucky = (w: number[]) => w[0] + w[1];
    const unlucky = (w: number[]) => w[3] + w[4];
    expect(lucky(easy)).toBeGreaterThan(lucky(normal));
    expect(lucky(normal)).toBeGreaterThan(lucky(harsh));
    expect(unlucky(easy)).toBeLessThan(unlucky(normal));
    expect(unlucky(normal)).toBeLessThan(unlucky(harsh));
    expect(easy[0]).toBeGreaterThan(easy[4]);
    expect(harsh[4]).toBeGreaterThan(harsh[0]);
    // 标准: the extremes together at most one turn in ten, 平 the most common.
    expect(normal[0] + normal[4]).toBeLessThanOrEqual(10);
    expect(Math.max(...normal)).toBe(normal[2]);
  });

  it("tells luck per mode: a hint, a firmer 有影响, nothing when 关", () => {
    expect(fortuneNote("不顺", "off")).toBe("");
    expect(fortuneNote(undefined, "on")).toBe("");
    const hint = fortuneNote("不顺", "hint");
    const on = fortuneNote("不顺", "on");
    expect(hint).not.toBe(on);
    expect(hint).toContain("只作参考");
    expect(on).not.toContain("只作参考");
    for (const text of [hint, on]) {
      expect(text).toContain("局面悬殊的");
      expect(text).toContain("不写荒唐的倒霉，也不写荒唐的走运");
    }
    expect(fortuneMode(undefined)).toBe("hint");
    expect(fortuneMode("off")).toBe("off");
  });
});
