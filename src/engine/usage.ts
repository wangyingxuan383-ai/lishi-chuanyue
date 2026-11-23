// What a passage or a story cost (R29-T004): requests, tokens and time from the
// usage table, by purpose. Calls the service reported no usage for are counted
// as unknown, never guessed; the price comes from 用量与花费.
import type { Platform } from "../platform";

/** Native runs suffix a purpose with its round ("writing:1"); group by the base. */
export const purposeBase = (purpose: string) => purpose.split(":")[0];
const LABELS: Record<string, string> = {
  writing: "写作", turn: "写作", opening: "开场", continue: "续写", extract: "补记", "reference-review": "原著核对", "reference-review-lite": "原著快速校对",
  codex: "整理设定", upkeep: "整理设定（游玩中）", chapter: "章节摘要", capability: "检测工具支持", ask: "查一查", assist: "补全",
  test: "测试", outline: "拟大纲", challenge: "出题", source: "通读书籍", "canon-notes": "札记", tool: "写作", autoplay: "连播",
  revise: "改稿", "revise-passage": "按要求改写", "sync-facts": "改后同步", correction: "按原著纠错", agent: "助手", "段落改写": "段落改写", "行动润色": "行动润色",
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
/** One native execution run (including cancelled, paused or failed runs that never committed a node). */
export const runUsage = (platform: Platform, runId: string) => summed(platform, "(u.id = ? OR u.id LIKE ?)", [runId, `${runId}:%`]);
/** Recent calls for a helper popup (改写, 改后同步, 查一查, 札记) since an ISO timestamp. */
export function recentUsage(platform: Platform, worldId: string | null, purposes: string[], sinceIso: string): Promise<UsageTotal | null> {
  if (!purposes.length || !sinceIso) return Promise.resolve(null);
  const clause = `${PURPOSE_SQL} IN (${IN_LIST(purposes)}) AND julianday(u.at) >= julianday(?)`;
  return worldId
    ? summed(platform, `u.world_id = ? AND ${clause}`, [worldId, ...purposes, sinceIso])
    : summed(platform, clause, [...purposes, sinceIso]);
}
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

// 速度体检 (D179 同批): where the waiting goes over the last passages, from the
// usage table only, so it costs no request.
const WRITING = ["writing", "turn", "opening", "continue", "tool"];
/** Background work that runs on the 整理用 (auxiliary) model. */
export const AUX_PURPOSES = ["extract", "reference-review", "reference-review-lite", "codex", "upkeep", "chapter", "canon-notes", "revise"];
/** Above this average wait for the first words, 辅助任务 are worth a faster model. */
export const SLOW_FIRST_MS = 15_000;

export interface SpeedPart { label: string; aux: boolean; calls: number; firstMs: number | null; totalMs: number; tokens: number }
export interface SpeedReport { passages: number; since: string; parts: SpeedPart[]; auxFirstMs: number | null; auxCalls: number; writingShare: number | null }

const IN_LIST = (list: string[]) => list.map(() => "?").join(",");

/** The last `passages` passages and everything that ran meanwhile, by purpose; null before any passage. */
export async function speedReport(platform: Platform, passages = 20, since?: string): Promise<SpeedReport | null> {
  let from = since;
  let count = 0;
  if (!from) {
    const recent = await platform.sql.query(`SELECT u.node_id, MIN(u.at) AS at, MIN(julianday(u.at)) AS ts FROM usage u WHERE u.node_id IS NOT NULL AND ${PURPOSE_SQL} IN (${IN_LIST(WRITING)})
      GROUP BY u.node_id ORDER BY ts DESC LIMIT ?`, [...WRITING, passages]);
    if (!recent.length) return null;
    count = recent.length;
    from = String(recent[recent.length - 1].at);
  }
  const rows = await platform.sql.query(`SELECT ${PURPOSE_SQL} AS purpose, COUNT(*) AS calls,
      AVG(CASE WHEN u.first_token_ms > 0 THEN u.first_token_ms END) AS first,
      COALESCE(SUM(u.total_ms), 0) AS ms,
      COALESCE(SUM(CASE WHEN u.prompt_tokens >= 0 THEN u.prompt_tokens ELSE 0 END), 0) + COALESCE(SUM(CASE WHEN u.completion_tokens >= 0 THEN u.completion_tokens ELSE 0 END), 0) AS tokens,
      SUM(CASE WHEN u.first_token_ms > 0 THEN 1 ELSE 0 END) AS timed
    FROM usage u WHERE julianday(u.at) >= julianday(?) GROUP BY purpose`, [from]);
  if (!rows.length) return null;
  const merged = new Map<string, SpeedPart & { timed: number; firstSum: number }>();
  for (const r of rows) {
    const purpose = String(r.purpose);
    const label = purposeLabel(purpose);
    const timed = Number(r.timed);
    const firstSum = r.first === null ? 0 : Number(r.first) * timed;
    const seen = merged.get(label);
    const next = seen
      ? { ...seen, calls: seen.calls + Number(r.calls), totalMs: seen.totalMs + Number(r.ms), tokens: seen.tokens + Number(r.tokens), timed: seen.timed + timed, firstSum: seen.firstSum + firstSum }
      : { label, aux: AUX_PURPOSES.includes(purpose), calls: Number(r.calls), totalMs: Number(r.ms), tokens: Number(r.tokens), timed, firstSum, firstMs: null };
    merged.set(label, next);
  }
  const parts = [...merged.values()].map(({ timed, firstSum, ...p }) => ({ ...p, firstMs: timed ? Math.round(firstSum / timed) : null }))
    .sort((a, b) => b.totalMs - a.totalMs);
  const aux = [...merged.values()].filter((p) => p.aux);
  const auxTimed = aux.reduce((n, p) => n + p.timed, 0);
  const total = parts.reduce((n, p) => n + p.totalMs, 0);
  const writing = parts.filter((p) => p.label === "写作" || p.label === "开场" || p.label === "续写").reduce((n, p) => n + p.totalMs, 0);
  return {
    passages: count, since: from, parts,
    auxFirstMs: auxTimed ? Math.round(aux.reduce((n, p) => n + p.firstSum, 0) / auxTimed) : null,
    auxCalls: aux.reduce((n, p) => n + p.calls, 0),
    writingShare: total ? writing / total : null,
  };
}

/** Names that usually answer without thinking first; “mini” only as its own word, since every “gemini” contains it. */
export const FAST_MODEL = /flash|lite|turbo|haiku|instant|nano|(^|[^a-z])(mini|small|air)([^a-z]|$)/i;

/** Faster-looking models first: names that usually answer without thinking first. */
export function fastModelsFirst(models: string[], current: string | null): string[] {
  const fast = (m: string) => (FAST_MODEL.test(m) ? 0 : /think|reason|(^|[^a-z])(r1|o1|o3|pro)([^a-z]|$)/i.test(m) ? 2 : 1);
  return models.filter((m) => m !== current && !/embed|image|tts|audio|whisper|vision|rerank|moderation|dall|speech|ocr/i.test(m)).sort((a, b) => fast(a) - fast(b) || a.localeCompare(b));
}

/** “8 秒” / “不到 1 秒”. */
export function secondsText(ms: number): string {
  return ms < 1000 ? "不到 1 秒" : `${Math.round(ms / 1000)} 秒`;
}
