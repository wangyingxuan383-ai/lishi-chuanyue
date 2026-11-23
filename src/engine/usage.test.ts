import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { Game } from "./game";
import { fastModelsFirst, purposeLabel, recentUsage, runUsage, speedReport, turnUsage, usageLine, worldUsage } from "./usage";

describe("每段用量 (R29-T004)", () => {
  it("labels native purposes by their base and sums a passage", async () => {
    expect(purposeLabel("writing:2")).toBe("写作");
    expect(purposeLabel("reference-review:0:1")).toBe("原著核对");
    expect(purposeLabel("canon-notes")).toBe("札记");
    expect(purposeLabel("agent")).toBe("助手");
    expect(purposeLabel("companion")).toBe("伴聊");
    expect(purposeLabel("companion:compact")).toBe("伴聊");
    expect(purposeLabel("agent-context")).toBe("助手记忆整理");
    expect(purposeLabel("status-tidy")).toBe("状况整理");
    expect(purposeLabel("sync-facts")).toBe("改后同步");
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

  it("速度体检 sums the last passages by purpose and flags slow background work", async () => {
    const platform = await createMemoryPlatform();
    await Game.open(platform, null);
    expect(await speedReport(platform)).toBeNull();
    const at = (s: number) => new Date(Date.UTC(2026, 10, 18, 8, 0, s)).toISOString();
    const row = (id: string, node: string | null, purpose: string, first: number | null, ms: number, s: number) => ({
      sql: "INSERT INTO usage(id,world_id,node_id,purpose,model,prompt_tokens,completion_tokens,estimated,first_token_ms,total_ms,outcome,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [id, "w", node, purpose, "m", 1000, 500, 0, first, ms, "ok", at(s)],
    });
    await platform.sql.batch([
      row("old", "n0", "writing:0", 1000, 9000, 0),
      row("a", "n1", "writing:0", 4000, 30_000, 10), row("b", "n1", "writing:1", 2000, 10_000, 11),
      row("c", "n1", "extract", 20_000, 25_000, 12), row("d", "n2", "writing:0", 6000, 20_000, 20),
      row("e", "n2", "reference-review:0:1", 30_000, 40_000, 21), row("f", null, "canon-notes", null, 5000, 22),
    ]);
    const report = (await speedReport(platform, 2))!;
    expect(report.passages).toBe(2);
    expect(report.parts.map((p) => [p.label, p.calls, p.firstMs])).toEqual([["写作", 3, 4000], ["原著核对", 1, 30_000], ["补记", 1, 20_000], ["札记", 1, null]]);
    expect(report.auxFirstMs).toBe(25_000);
    expect(report.auxCalls).toBe(3);
    expect(report.writingShare).toBeCloseTo(60 / 130);
    expect(fastModelsFirst(["gemini-pro", "text-embedding", "gemini-flash", "deepseek-r1", "gpt-x", "gpt-4o-mini", "gemini-x"], "gpt-x")).toEqual(["gemini-flash", "gpt-4o-mini", "gemini-x", "deepseek-r1", "gemini-pro"]);
  });

  it("runUsage and recentUsage cover interrupted runs, helper popups and mirrored agent calls", async () => {
    const platform = await createMemoryPlatform();
    await Game.open(platform, null);
    const t0 = "2026-11-23T01:00:00.000Z";
    const t1 = "2026-11-23T01:00:05.000Z";
    const t2 = "2026-11-23T01:00:10.000Z";
    const row = (id: string, world: string, node: string | null, purpose: string, input: number | null, output: number | null, outcome: string, at: string) => ({
      sql: "INSERT INTO usage(id,world_id,node_id,purpose,model,prompt_tokens,completion_tokens,estimated,first_token_ms,total_ms,outcome,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [id, world, node, purpose, "m", input, output, input === null ? 1 : 0, null, 2000, outcome, at],
    });
    await platform.sql.batch([
      row("run-1:model:1", "w", null, "writing:0", 1200, 300, "cancelled", t1),
      row("run-1:model:2", "w", null, "extract", null, null, "failed", t2),
      row("pi:t1:r1", "w", null, "agent", 2000, 400, "ok", t1),
      row("old-ask", "w", null, "ask", 500, 100, "ok", t0),
      row("new-ask", "w", null, "ask", 600, 200, "ok", t2),
    ]);
    const interrupted = (await runUsage(platform, "run-1"))!;
    expect(interrupted).toMatchObject({ calls: 2, input: 1200, output: 300, unknown: 1 });
    const ask = (await recentUsage(platform, "w", ["ask"], t1))!;
    expect(ask).toMatchObject({ calls: 1, input: 600, output: 200 });
    const world = (await worldUsage(platform, "w"))!;
    expect(world.parts.find((p) => p.label === "助手")).toMatchObject({ calls: 1, input: 2000, output: 400 });
    expect(purposeLabel("correction")).toBe("按原著纠错");
    // Mixed "+00:00" and "Z" timestamps are ordered accurately by julianday in speedReport.
    await platform.sql.batch([
      row("tz-old", "w", "n1", "writing:0", 100, 50, "ok", "2026-11-23T02:00:00+00:00"),
      row("tz-new", "w", "n2", "writing:0", 200, 80, "ok", "2026-11-23T02:00:05.000Z"),
    ]);
    const speed = (await speedReport(platform, 1))!;
    expect(speed.passages).toBe(1);
    expect(speed.since).toBe("2026-11-23T02:00:05.000Z");
  });
});
