import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import type { ExecutionSnapshot, Json } from "../platform";
import { depthBudget, depthOf, referenceReview } from "./depth";
import { Game } from "./game";
import type { SourceBinding } from "./sources/types";
import { sampleState } from "./testing/fixtures";

const book: SourceBinding = { bookId: "b", fanfic: true, plot: "canon", through: null, position: 0, instructions: "", method: "search" };

describe("generation tiers (D161)", () => {
  it("defaults old worlds to 标准 and trims only 快速's memory", () => {
    expect(depthOf({})).toBe("standard");
    expect(depthOf({ depth: "deep" })).toBe("deep");
    expect(depthBudget(20_000, "fast")).toBe(12_000);
    expect(depthBudget(20_000, "standard")).toBe(20_000);
    expect(depthBudget(20_000, "deep")).toBe(20_000);
  });
  it("checks the original fully at 深度, lightly for 同人 at 标准, never at 快速", () => {
    expect(referenceReview("deep", book)).toBe("reference-review-2");
    expect(referenceReview("standard", book)).toBe("reference-review-lite-1");
    expect(referenceReview("standard", { ...book, fanfic: false })).toBeUndefined();
    expect(referenceReview("fast", book)).toBeUndefined();
    expect(referenceReview("deep", null)).toBeUndefined();
  });
  it("puts the world's tier into the turn's run plan", async () => {
    const platform = await createMemoryPlatform();
    const plans: Record<string, Json>[] = [];
    platform.execution = {
      agent: async () => null, settle: async () => null, list: async () => [], stop: async () => {}, resume: async () => {},
      start: async (plan) => { plans.push(plan as Record<string, Json>); return "run"; },
      snapshot: async (id): Promise<ExecutionSnapshot> => ({ id, worldId: "", status: "failed", budget: { modelRequests: 0, toolCalls: 0, corrections: 0, activeMs: 0 }, draft: null, result: null, error: "测试结束", events: [] }),
    };
    const game = await Game.open(platform, { slot: "main", url: "https://x/v1/chat/completions", model: "m", includeUsage: true, contextTokens: 10_000 });
    const { world } = await game.repo.createWorld({
      title: "试", eraId: "free", settings: { premise: "一座城。", depth: "fast" },
      opening: { parentId: null, kind: "opening", narrative: "你醒来。", state: { ...sampleState(), source: book } as never, meta: {} },
    });
    await new Promise<void>((done) => game.play(world.id, { mode: "do", text: "出门" }, (e) => { if (e.type === "failed" || e.type === "done") done(); }));
    const meta = plans[0].meta as Record<string, unknown>;
    expect(meta.depth).toBe("fast");
    expect(meta.referenceReviewVersion).toBeUndefined();
    expect(meta.budgetChars).toBeLessThan(10_000);
  });
});
