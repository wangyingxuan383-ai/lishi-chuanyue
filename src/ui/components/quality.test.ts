import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { migrate } from "../../engine/db/migrate";
import { Repo } from "../../engine/db/repo";
import { budgetSummary, claimBudgetReminder, EMPTY_BUDGET, monthRange, monthSpend, normalizeBudget, overBudget, readBudget } from "./budgetMath";
import { checkCardSize, checkCardText } from "./shareLimits";

describe("monthly budget with recorded usage", () => {
  let platform: Awaited<ReturnType<typeof createMemoryPlatform>>;
  let repo: Repo;
  const now = new Date(2026, 9, 17, 10);
  const priced = { limit: 1, input: 1, output: 2 };
  beforeEach(async () => { platform = await createMemoryPlatform(); await migrate(platform); repo = new Repo(platform); });
  const add = (id: string, input: number | null, output: number | null, at = now.toISOString()) => platform.sql.batch([{
    sql: "INSERT INTO usage (id, purpose, model, prompt_tokens, completion_tokens, outcome, at) VALUES (?, 'turn', 'local-fake', ?, ?, 'ok', ?)",
    params: [id, input, output, at],
  }]);
  it("does not treat missing prices or wholly missing usage as zero spend", async () => {
    await add("a", null, null);
    const noPrice = await monthSpend(platform, EMPTY_BUDGET, now);
    expect(noPrice.knownCost).toBeNull(); expect(budgetSummary(noPrice)).toContain("未知");
    expect(overBudget({ ...EMPTY_BUDGET, limit: 1 }, noPrice)).toBe(false);
    const unknown = await monthSpend(platform, priced, now);
    expect(unknown.knownCost).toBeNull();
    expect(unknown.unknown).toBe(1); expect(budgetSummary(unknown)).toContain("未知");
    expect(budgetSummary(unknown)).not.toContain("0.00");
  });
  it("both token fields are required; mixed usage is explicitly only a known subtotal", async () => {
    await add("known", 1_000_000, 500_000); await add("partial", 800_000, null); await add("other-partial", null, 1_000_000);
    const spend = await monthSpend(platform, priced, now);
    expect(spend).toMatchObject({ calls: 3, unknown: 2, knownCost: 2 });
    expect(budgetSummary(spend)).toContain("已知部分约 2.00 元");
    expect(overBudget(priced, spend)).toBe(true);
  });
  it("uses device-local month boundaries, includes all models/outcomes, excludes adjacent months", async () => {
    const { from, to } = monthRange(now);
    await add("before", 1_000_000, 0, new Date(Date.parse(from) - 1).toISOString());
    await add("start", 1_000_000, 0, from); await add("next", 1_000_000, 0, to);
    await add("end", 1_000_000, 0, new Date(Date.parse(to) - 1).toISOString());
    expect(await monthSpend(platform, priced, now)).toMatchObject({ month: "2026-10", calls: 2, knownCost: 2 });
  });
  it("reminds once per month across concurrent checks and reloads, then again in a new month", async () => {
    await add("a", 2_000_000, 0);
    const spend = await monthSpend(platform, priced, now);
    const claims = await Promise.all([claimBudgetReminder(repo, priced, spend), claimBudgetReminder(repo, priced, spend)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimBudgetReminder(new Repo(platform), priced, spend)).toBe(false);
    expect(await claimBudgetReminder(repo, priced, { ...spend, month: "2026-11" })).toBe(true);
  });
  it("allows explicit zero prices and disables blank/zero limits without consuming a reminder", async () => {
    await add("a", 1_000_000, 1_000_000);
    const free = { limit: null, input: 0, output: 0 };
    expect((await monthSpend(platform, free, now)).knownCost).toBe(0);
    expect(await claimBudgetReminder(repo, { ...priced, limit: 0 }, { month: "2026-10", calls: 1, unknown: 0, knownCost: 3 })).toBe(false);
    expect(await repo.getSetting("budgetReminderMonth", null)).toBeNull();
    expect(normalizeBudget({ limit: -1, input: NaN, output: Infinity })).toEqual(EMPTY_BUDGET);
  });
  it("uses one set of prices: the budget's, or the old usage-sheet prices until those are saved", async () => {
    expect(await readBudget(repo)).toEqual(EMPTY_BUDGET);
    await repo.setSetting("prices", { input: 1.5, output: 0 });
    // The old sheet stored 0 for a box left empty: unknown, not free.
    expect(await readBudget(repo)).toEqual({ limit: null, input: 1.5, output: null });
    await repo.setSetting("monthlyBudget", { limit: 5, input: 2, output: 8 });
    expect(await readBudget(repo)).toEqual({ limit: 5, input: 2, output: 8 });
    await repo.setSetting("monthlyBudget", { limit: 5, input: null, output: null });
    expect((await readBudget(repo)).input).toBe(1.5);
  });
});

describe("share image boundaries", () => {
  it("allows normal cards but rejects oversized allocation on either axis or area", () => {
    expect(() => checkCardSize(1080, 8100)).not.toThrow();
    for (const size of [[1080, 8200], [8200, 1440], [5000, 5000], [Infinity, 1440], [0, 1440]]) {
      expect(() => checkCardSize(size[0], size[1])).toThrow("太长");
    }
  });
  it("rejects huge text before measuring and does not silently truncate", () => {
    expect(() => checkCardText("文".repeat(24_000))).not.toThrow();
    expect(() => checkCardText("文".repeat(24_001))).toThrow("文字太多");
  });
});
