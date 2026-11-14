// What a passage or a story cost (R29-T004): requests, tokens and time from the
// usage table, by purpose. Calls the service reported no usage for are counted
// as unknown, never guessed; the price comes from 用量与花费.
import type { Platform } from "../platform";

/** Native runs suffix a purpose with its round ("writing:1"); group by the base. */
export const purposeBase = (purpose: string) => purpose.split(":")[0];
const LABELS: Record<string, string> = {
  writing: "写作", turn: "写作", opening: "开场", continue: "续写", extract: "补记", "reference-review": "原著核对", "reference-review-lite": "原著快速校对",
  codex: "整理设定", upkeep: "整理设定（游玩中）", chapter: "章节摘要", capability: "检测工具支持", ask: "查一查", assist: "补全",
  test: "测试", outline: "拟大纲", challenge: "出题", source: "通读书籍", "canon-notes": "原著札记", tool: "写作", autoplay: "连播",
};
export const purposeLabel = (purpose: string) => LABELS[purposeBase(purpose)] ?? LABELS[purpose] ?? purpose;
/** SQL for the base purpose, for GROUP BY. */
export const PURPOSE_SQL = "CASE WHEN instr(u.purpose, ':') > 0 THEN substr(u.purpose, 1, instr(u.purpose, ':') - 1) ELSE u.purpose END";

export interface UsagePart { purpose: string; label: string; calls: number; input: number; output: number; unknown: number; ms: number }
export interface UsageTotal { calls: number; input: number; output: number; unknown: number; ms: number; parts: UsagePart[] }

async function summed(platform: Platform, where: string, params: (string | number)[]): Promise<UsageTotal | null> {
  const rows = await platform.sql.query(`SELECT ${PURPOSE_SQL} AS purpose, COUNT(*) AS calls,
      COALESCE(SUM(CASE WHEN u.prompt_tokens >= 0 THEN u.prompt_tokens ELSE 0 END), 0) AS input,
      COALESCE(SUM(CASE WHEN u.completion_tokens >= 0 THEN u.completion_tokens ELSE 0 END), 0) AS output,
      SUM(CASE WHEN u.prompt_tokens IS NULL OR u.completion_tokens IS NULL THEN 1 ELSE 0 END) AS unknown,
      COALESCE(SUM(u.total_ms), 0) AS ms
    FROM usage u WHERE ${where} GROUP BY purpose ORDER BY input DESC`, params);
  if (!rows.length) return null;
  const parts = rows.map((r) => ({ purpose: String(r.purpose), label: purposeLabel(String(r.purpose)), calls: Number(r.calls), input: Number(r.input), output: Number(r.output), unknown: Number(r.unknown), ms: Number(r.ms) }));
  // Two base purposes may share a label ("turn" and "writing"): merge them for the player.
  const merged = new Map<string, UsagePart>();
  for (const p of parts) {
    const seen = merged.get(p.label);
    merged.set(p.label, seen ? { ...seen, calls: seen.calls + p.calls, input: seen.input + p.input, output: seen.output + p.output, unknown: seen.unknown + p.unknown, ms: seen.ms + p.ms } : p);
  }
  const list = [...merged.values()];
  return { calls: sum(list, "calls"), input: sum(list, "input"), output: sum(list, "output"), unknown: sum(list, "unknown"), ms: sum(list, "ms"), parts: list };
}
const sum = (parts: UsagePart[], key: "calls" | "input" | "output" | "unknown" | "ms") => parts.reduce((n, p) => n + p[key], 0);

/** One passage: every request its run made, including background 补记 and 核对. */
export const turnUsage = (platform: Platform, nodeId: string) => summed(platform, "u.node_id = ?", [nodeId]);
/** A whole story, including notes and tidying done for it. */
export const worldUsage = (platform: Platform, worldId: string) => summed(platform, "u.world_id = ?", [worldId]);

export interface Prices { input: number | null; output: number | null }
/** Estimated yuan, or null without both prices or when no call reported usage. */
export function usageCost(total: Pick<UsageTotal, "calls" | "input" | "output" | "unknown">, prices: Prices): number | null {
  if (prices.input === null || prices.output === null || total.unknown === total.calls) return null;
  return (total.input * prices.input + total.output * prices.output) / 1_000_000;
}
/** “1.4 万” / “860”. */
export function tokenText(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)} 万` : `${n}`;
}
export function costText(yuan: number): string {
  return yuan < 0.01 ? "不到 1 分钱" : `约 ¥${yuan < 1 ? yuan.toFixed(2) : yuan.toFixed(1)}`;
}
/** “3 次 · 1.4 万 tokens · 约 ¥0.02 · 21 秒”. */
export function usageLine(total: UsageTotal, prices: Prices): string {
  const cost = usageCost(total, prices);
  const tokens = total.unknown === total.calls ? "用量未知" : `${tokenText(total.input + total.output)} tokens${total.unknown ? "（部分未知）" : ""}`;
  return [`${total.calls} 次`, tokens, cost === null ? "" : costText(cost), total.ms ? `${Math.max(1, Math.round(total.ms / 1000))} 秒` : ""].filter(Boolean).join(" · ");
}
