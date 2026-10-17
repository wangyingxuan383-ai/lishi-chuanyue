import type { Platform } from "../../platform";
import type { Repo } from "../../engine/db/repo";

export interface BudgetConfig { limit: number | null; input: number | null; output: number | null }
export const EMPTY_BUDGET: BudgetConfig = { limit: null, input: null, output: null };
export function budgetNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function normalizeBudget(value: Partial<BudgetConfig> | null): BudgetConfig {
  return { limit: budgetNumber(value?.limit), input: budgetNumber(value?.input), output: budgetNumber(value?.output) };
}
/**
 * The saved budget and prices — one set of prices for the budget and the usage
 * details. Before R14 the details sheet kept its own prices (setting "prices",
 * 0 meaning not filled in); they are used until the player saves prices here.
 */
export async function readBudget(repo: Repo): Promise<BudgetConfig> {
  const config = normalizeBudget(await repo.getSetting<Partial<BudgetConfig> | null>("monthlyBudget", EMPTY_BUDGET));
  if (config.input !== null || config.output !== null) return config;
  const old = await repo.getSetting<{ input?: number; output?: number } | null>("prices", null);
  const price = (n: unknown) => (budgetNumber(n) ? (n as number) : null);
  return { ...config, input: price(old?.input), output: price(old?.output) };
}
export function monthRange(now = new Date()) {
  return {
    month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    to: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
  };
}
export interface MonthSpend { month: string; calls: number; unknown: number; knownCost: number | null }
export async function monthSpend(platform: Platform, config: BudgetConfig, now = new Date()): Promise<MonthSpend> {
  const { month, from, to } = monthRange(now);
  const [row] = await platform.sql.query(`SELECT COUNT(*) AS calls,
    COALESCE(SUM(CASE WHEN prompt_tokens IS NULL OR completion_tokens IS NULL OR prompt_tokens < 0 OR completion_tokens < 0 THEN 1 ELSE 0 END), 0) AS unknown,
    COALESCE(SUM(CASE WHEN prompt_tokens >= 0 AND completion_tokens >= 0 THEN prompt_tokens ELSE 0 END), 0) AS input,
    COALESCE(SUM(CASE WHEN prompt_tokens >= 0 AND completion_tokens >= 0 THEN completion_tokens ELSE 0 END), 0) AS output
    FROM usage WHERE julianday(at) >= julianday(?) AND julianday(at) < julianday(?)`, [from, to]);
  const prices = normalizeBudget(config);
  return { month, calls: Number(row.calls), unknown: Number(row.unknown),
    knownCost: prices.input === null || prices.output === null || (Number(row.calls) > 0 && Number(row.unknown) === Number(row.calls))
      ? null : (Number(row.input) * prices.input + Number(row.output) * prices.output) / 1_000_000 };
}
export function overBudget(config: BudgetConfig, spend: MonthSpend): boolean {
  return config.limit !== null && config.limit > 0 && spend.knownCost !== null && spend.knownCost >= config.limit;
}
export function budgetSummary(spend: MonthSpend): string {
  if (spend.unknown === spend.calls && spend.calls > 0) return `本月 ${spend.calls} 次调用都缺少用量，花费未知。`;
  if (spend.knownCost === null) return "还没填全单价，本月花费未知。";
  return `${spend.unknown ? "已知部分约" : "本月估计"} ${spend.knownCost.toFixed(2)} 元${spend.unknown ? `；另有 ${spend.unknown} 次用量不全，未计入` : ""}。`;
}

// Two mounted consumers must not claim the same month's reminder concurrently.
const pending = new WeakMap<Repo, Promise<boolean>>();
export function claimBudgetReminder(repo: Repo, config: BudgetConfig, spend: MonthSpend): Promise<boolean> {
  if (!overBudget(config, spend)) return Promise.resolve(false);
  const previous = pending.get(repo);
  if (previous) return previous.then(() => claimBudgetReminder(repo, config, spend));
  const result = (async () => {
    if (await repo.getSetting("budgetReminderMonth", "") === spend.month) return false;
    await repo.setSetting("budgetReminderMonth", spend.month);
    return true;
  })();
  pending.set(repo, result);
  void result.finally(() => { if (pending.get(repo) === result) pending.delete(repo); }).catch(() => {});
  return result;
}
