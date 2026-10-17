import { describe, expect, it } from "vitest";
import { FORTUNES, rollFortune } from "./fortune";

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
});
