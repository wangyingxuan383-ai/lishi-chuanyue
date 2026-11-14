// Generation tiers (D161): 快速 / 标准 / 深度 decide how much a passage may look
// up before it is written and how its use of the original is checked. The
// native writer reads `meta.depth`; plans without it keep the old behaviour.
import type { SourceBinding } from "./sources/types";
import type { WorldSettings } from "./types";

export type Depth = "fast" | "standard" | "deep";
export const DEPTHS: Depth[] = ["fast", "standard", "deep"];
export const DEPTH_LABEL: Record<Depth, string> = { fast: "快速", standard: "标准", deep: "深度" };
/** One character for the badge beside Aa. */
export const DEPTH_MARK: Record<Depth, string> = { fast: "快", standard: "标", deep: "深" };
export const DEPTH_NOTE: Record<Depth, string> = {
  fast: "一次写完，不查资料，只带最近的剧情和要紧的设定。最快、最省。",
  standard: "缺什么才查一次再写；同人故事写完后用辅助模型快速对一遍原著。",
  deep: "可以多次翻原著原文，写完逐段核对。最贴原著，也最慢、最费。",
};
export const REFERENCE_REVIEW_LITE = "reference-review-lite-1";
export const REFERENCE_REVIEW_FULL = "reference-review-2";

/** A world saved before tiers plays at 标准. */
export function depthOf(settings: Pick<WorldSettings, "depth">): Depth {
  return settings.depth && DEPTHS.includes(settings.depth) ? settings.depth : "standard";
}

/** 快速 carries about 60% of the memory budget; the others the whole of it. */
export function depthBudget(full: number, depth: Depth): number {
  return depth === "fast" ? Math.round(full * 0.6) : full;
}

/** How the passage's use of the original is checked: none, the lite helper-model check (同人 only), or the full one. */
export function referenceReview(depth: Depth, source: SourceBinding | null | undefined): string | undefined {
  if (!source) return undefined;
  if (depth === "deep") return REFERENCE_REVIEW_FULL;
  return depth === "standard" && source.fanfic ? REFERENCE_REVIEW_LITE : undefined;
}
