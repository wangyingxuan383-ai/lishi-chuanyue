import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import type { ExecutionSnapshot, Json } from "../platform";
import { depthBudget, depthOf, referenceReview } from "./depth";
import { Game } from "./game";
import { saveBook } from "./sources/library";
import type { SourceBinding } from "./sources/types";
import { sampleState } from "./testing/fixtures";
import { buildTurnContext } from "./prompt/turn";

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
    expect(referenceReview("standard", book)).toBe("reference-review-lite-4");
    expect(referenceReview("standard", { ...book, fanfic: false })).toBeUndefined();
    expect(referenceReview("fast", book)).toBeUndefined();
    expect(referenceReview("deep", null)).toBeUndefined();
  });
  it("passes the tier, free-world chapter version and old edited facts to the native turn", async () => {
    const platform = await createMemoryPlatform();
    const plans: Record<string, Json>[] = [];
    const contexts: Record<string, Json>[] = [];
    platform.execution = {
      agent: async () => null, settle: async () => null, list: async () => [], stop: async () => ({executionId:null,status:"cancelled",accepted:true,settled:true}), resume: async () => {},
      start: async (plan) => { plans.push(plan as Record<string, Json>); return "run"; },
      context: async (input) => {
        contexts.push(input as Record<string, Json>);
        return buildTurnContext(input as never) as unknown as Json;
      },
      snapshot: async (id): Promise<ExecutionSnapshot> => ({ id, worldId: "", status: "failed", budget: { modelRequests: 0, toolCalls: 0, corrections: 0, activeMs: 0 }, draft: null, result: null, error: "测试结束", events: [] }),
    };
    const game = await Game.open(platform, { slot: "main", url: "https://x/v1/chat/completions", model: "m", includeUsage: true, contextTokens: 10_000 });
    await saveBook(game.repo, { id: book.bookId, title: "试读", format: "txt", createdAt: new Date().toISOString(), sections: [{ title: "开篇", text: "旅人走出城门。" }] });
    const { world, node, line } = await game.repo.createWorld({
      title: "试", eraId: "free", settings: { premise: "一座城。", depth: "fast", chapterEvery: 1 },
      opening: { parentId: null, kind: "opening", narrative: "你醒来。", state: { ...sampleState(), era: { mode: "free", packId: null }, source: book } as never, meta: {} },
    });
    await platform.sql.batch([
      { sql: "UPDATE nodes SET rewritten=1 WHERE id=?", params: [node.id] },
      { sql: `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<201)
        INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,created_at)
        SELECT 'passage-'||n,?,CASE WHEN n=1 THEN ? ELSE 'passage-'||(n-1) END,n,'turn','后续','test' FROM sequence`, params: [world.id, node.id] },
      { sql: "INSERT INTO states SELECT 'passage-201',json_set(state_json,'$.facts',json(?)) FROM states WHERE node_id=?", params: [JSON.stringify([{ id: "old-ai", origin: "ai", nodeId: node.id, detail: "旧记事" }]), node.id] },
      { sql: "UPDATE lines SET node_id='passage-201' WHERE id=?", params: [line.id] },
    ]);
    await new Promise<void>((done) => game.play(world.id, { mode: "do", text: "出门" }, (e) => { if (e.type === "failed" || e.type === "done") done(); }));
    const meta = plans[0].meta as Record<string, unknown>;
    expect(meta.depth).toBe("fast");
    expect(meta.referenceReviewVersion).toBeUndefined();
    expect(meta.budgetChars).toBeLessThan(10_000);
    expect(meta.chapterVersion).toBe("chapter-3-free");
    expect((meta.chapterMessages as { content: string }[])[0].content).not.toContain("历史互动小说");
    expect((meta.chapterMessages as { content: string }[])[0].content).toContain("沿用本局世界设定与称呼");
    expect(contexts[0].history).toHaveLength(200);
    expect(contexts[0].editedFactNodeIds).toEqual([node.id]);
  });
});
