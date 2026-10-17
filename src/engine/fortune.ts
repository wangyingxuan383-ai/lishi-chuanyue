// Fortune (PLAN §5.5, R05-T002): one hidden roll per parent node, weighted by
// difficulty and told to the narrator before it writes, so risky actions can
// fail for a reason the player can see afterwards. A regenerate keeps the roll;
// only "换个结果" rolls again.
import type { Difficulty } from "./types";

export type Fortune = "大顺" | "顺" | "平" | "不顺" | "大不顺";
export const FORTUNES: Fortune[] = ["大顺", "顺", "平", "不顺", "大不顺"];

/** Percentages for 大顺 … 大不顺: easy leans lucky, harsh leans unlucky. */
const WEIGHTS: Record<Difficulty, number[]> = {
  宽松: [15, 35, 35, 12, 3],
  标准: [10, 25, 35, 22, 8],
  残酷: [5, 15, 30, 35, 15],
};

export function rollFortune(difficulty: Difficulty, random: () => number = Math.random): Fortune {
  const weights = WEIGHTS[difficulty] ?? WEIGHTS["标准"];
  let r = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return FORTUNES[i];
  }
  return "平";
}

export const isFortune = (v: unknown): v is Fortune => FORTUNES.includes(v as Fortune);

/** What the narrator is told; it applies only when the action is risky or depends on luck. */
export const FORTUNE_TEXT: Record<Fortune, string> = {
  大顺: "大顺——玩家这次的行动若有风险或要看运气，结果顺利，还可能有意外之喜。",
  顺: "顺——玩家这次的行动若有风险或要看运气，结果多半顺利，最多小有波折。",
  平: "平——玩家这次的行动若有风险或要看运气，按情理决定成败。",
  不顺: "不顺——玩家这次的行动若有风险或要看运气，结果多半受阻，或要付出代价。",
  大不顺: "大不顺——玩家这次的行动若有风险或要看运气，结果失败，还可能节外生枝；但要合情合理，不写荒唐的倒霉。",
};
