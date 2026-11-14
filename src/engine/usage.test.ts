import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { Game } from "./game";
import { purposeLabel, turnUsage, usageLine, worldUsage } from "./usage";

describe("每段用量 (R29-T004)", () => {
  it("labels native purposes by their base and sums a passage", async () => {
    expect(purposeLabel("writing:2")).toBe("写作");
    expect(purposeLabel("reference-review:0:1")).toBe("原著核对");
    expect(purposeLabel("canon-notes")).toBe("原著札记");
    const platform = await createMemoryPlatform();
    await Game.open(platform, null);
    const row = (id: string, node: string | null, purpose: string, input: number | null, output: number | null, ms: number) => ({
      sql: "INSERT INTO usage(id,world_id,node_id,purpose,model,prompt_tokens,completion_tokens,estimated,first_token_ms,total_ms,outcome,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [id, "w", node, purpose, "m", input, output, input === null ? 1 : 0, 100, ms, "ok", new Date().toISOString()],
    });
    await platform.sql.batch([row("a", "n1", "writing:0", 9000, 800, 12_000), row("b", "n1", "writing:1", 4000, 1200, 6_000), row("c", "n1", "extract", null, null, 2_000), row("d", "n2", "writing:0", 1, 1, 1), row("e", null, "canon-notes", 100, 100, 1000)]);
    const total = (await turnUsage(platform, "n1"))!;
    expect(total).toMatchObject({ calls: 3, input: 13_000, output: 2000, unknown: 1, ms: 20_000 });
    expect(total.parts.map((p) => [p.label, p.calls])).toEqual([["写作", 2], ["补记", 1]]);
    expect(usageLine(total, { input: 2, output: 8 })).toBe("3 次 · 1.5 万 tokens（部分未知） · 约 ¥0.04 · 20 秒");
    expect(usageLine(total, { input: null, output: null })).toBe("3 次 · 1.5 万 tokens（部分未知） · 20 秒");
    expect((await worldUsage(platform, "w"))!.calls).toBe(5);
    expect(await turnUsage(platform, "none")).toBeNull();
  });
});
