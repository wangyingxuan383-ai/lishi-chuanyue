// Fortune (PLAN §5.5, R05-T002, R11-T008): one hidden roll per parent node,
// weighted by difficulty and told to the narrator before it writes, so risky
// actions can fail for a reason the player can see afterwards. A regenerate
// keeps the roll; only "换个结果" rolls again. Plausibility comes first: the
// roll only tips outcomes that are genuinely uncertain, and a world can turn it
// down to a hint (the default) or off.
import type { Difficulty } from "./types";

export type Fortune = "大顺" | "顺" | "平" | "不顺" | "大不顺";
export const FORTUNES: Fortune[] = ["大顺", "顺", "平", "不顺", "大不顺"];

/** How much the roll counts in a world: 有影响 / 只作参考 / 关 (R11-T008). */
export type FortuneMode = "on" | "hint" | "off";
export const FORTUNE_MODES: [FortuneMode, string][] = [["on", "有影响"], ["hint", "只作参考"], ["off", "关"]];
export const FORTUNE_MODE_NOTE: Record<FortuneMode, string> = {
  on: "暗中抽签，胜负难料时结果多半跟着签走；人多势众、本来就容易的事仍按情理。",
  hint: "暗中抽签，只给 AI 一点倾向，成败主要按情理。",
  off: "不抽签，成败全按情理。",
};

/** Old worlds saved before the setting existed behave as 只作参考. */
export const fortuneMode = (v: unknown): FortuneMode => (v === "on" || v === "off" ? v : "hint");

/**
 * Percentages for 大顺 … 大不顺: easy leans lucky, harsh leans unlucky, and the
 * extremes are rare (R11-T008 lowered them, most of all on 标准).
 */
export const FORTUNE_WEIGHTS: Record<Difficulty, number[]> = {
  宽松: [12, 35, 38, 12, 3],
  标准: [5, 25, 45, 20, 5],
  残酷: [4, 16, 35, 33, 12],
};

export function rollFortune(difficulty: Difficulty, random: () => number = Math.random): Fortune {
  const weights = FORTUNE_WEIGHTS[difficulty] ?? FORTUNE_WEIGHTS["标准"];
  let r = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return FORTUNES[i];
  }
  return "平";
}

export const isFortune = (v: unknown): v is Fortune => FORTUNES.includes(v as Fortune);

/** 有影响: the roll decides outcomes that are genuinely in doubt. */
const ON_TEXT: Record<Fortune, string> = {
  大顺: "大顺——玩家这次的行动若有风险、胜负难料，结果顺利，还可能有意外之喜。",
  顺: "顺——玩家这次的行动若有风险、胜负难料，结果多半顺利，最多小有波折。",
  平: "平——玩家这次的行动若有风险，按情理决定成败。",
  不顺: "不顺——玩家这次的行动若有风险、胜负难料，结果多半受阻，或要付出代价。",
  大不顺: "大不顺——玩家这次的行动若有风险、胜负难料，结果失败，还可能节外生枝。",
};

/** 只作参考: a gentle tilt in colour and small costs. */
const HINT_TEXT: Record<Fortune, string> = {
  大顺: "大顺——胜负难料时偏向顺利，可以有点小惊喜。",
  顺: "顺——胜负难料时稍稍偏向顺利。",
  平: "平——完全按情理。",
  不顺: "不顺——胜负难料时稍稍偏向受阻，或多些波折、小代价。",
  大不顺: "大不顺——胜负难料时偏向失手；占上风的事也可能出点小岔子，但不推翻明摆着的结果。",
};

/** 情理优先 (R11-T008): what holds in both modes. */
const PLAUSIBLE = "成败先看情理：局面悬殊的（人多势众、实力或准备远胜对方，或者本来就容易、本来就办不到的事），按情理写，运势最多影响代价和细节，不翻转结果。要合情合理，不写荒唐的倒霉，也不写荒唐的走运。没有风险的日常行动不受运势影响，也不要在正文里提运势。";

/** The 【本回合运势】 block for the narrator; empty when the world has luck off or no roll was made. */
export function fortuneNote(fortune: Fortune | undefined, mode: FortuneMode = "hint"): string {
  if (!fortune || mode === "off") return "";
  if (mode === "on") return `\n【本回合运势（玩家看不到）】${ON_TEXT[fortune]}${PLAUSIBLE}`;
  return `\n【本回合运势（玩家看不到，只作参考）】${HINT_TEXT[fortune]}运势只是一点倾向，只在胜负确实难料（双方相当、全凭运气）时起作用，顺就多些顺手，不顺就多些波折。${PLAUSIBLE}`;
}
