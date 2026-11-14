// 让 AI 改设定 (R29-T005): the player says what to change in one entry of the
// 设定集, or in the time and currency, and the helper model returns the changed
// fields only. The result fills the editor; the player saves it as an undoable
// edit. With 参考原著, the canon notes and a few original passages go along.
import type { ChatMessage } from "../llm/chat";

export const REVISE_PROMPT_VERSION = "revise-1";

export interface ReviseEntry { label: string; name: string; aliases: string[]; text: string }
export interface ReviseEntryResult { name: string; aliases: string[]; text: string }
/** The time-and-currency form, as the RulesSheet holds it. */
export interface ReviseRules {
  clockStyle: "era" | "elapsed"; timeStyle: "24h" | "shichen"; lunar: boolean;
  eraName: string; year: number | null; month: number; day: number; displayDay: number; hour: number; minute: number;
  currency: { name: string; value: number }[];
}
export interface ReviseContext { premise: string; protagonist: string; source?: string }

function contextBlock(c: ReviseContext): string {
  return `【故事设定】\n${c.premise.trim().slice(0, 1200) || "（未写）"}\n\n【主角】${c.protagonist}${c.source ? `\n\n【参考原著】（AI 整理的札记与原文片段；与玩家要求冲突时以玩家要求为准）\n${c.source}` : ""}`;
}

export function reviseEntryMessages(entry: ReviseEntry, instruction: string, c: ReviseContext): ChatMessage[] {
  return [
    { role: "system", content: `你帮玩家修改互动小说“设定集”里的一条${entry.label}。照玩家的要求改，要求没提到的部分保持原样；只写设定资料，不写剧情，不加解释。内容不超过 ${entry.label.includes("卡") && entry.label !== "物品卡" && entry.label !== "势力卡" && entry.label !== "设定卡" ? 900 : 300} 字。只输出一个 JSON 对象：{"name":"名称","aliases":["别名"],"text":"改好的内容"}` },
    { role: "user", content: `${contextBlock(c)}\n\n【这条${entry.label}现在的样子】\n名称：${entry.name || "（未填）"}\n别名：${entry.aliases.join("、") || "（无）"}\n内容：\n${entry.text || "（空）"}\n\n【玩家的要求】${instruction.trim()}` },
  ];
}

export function reviseRulesMessages(current: ReviseRules, instruction: string, c: ReviseContext): ChatMessage[] {
  return [
    { role: "system", content: `你帮玩家调整互动小说的时间显示与货币。照玩家的要求改，没提到的保持原样。只改“显示”和货币单位，不改变剧情里已经过去多少时间。
字段：clockStyle（"era" 纪年 / "elapsed" 日序）、timeStyle（"24h" / "shichen" 时辰）、lunar（是否农历，简化的十二个月）、eraName（纪年名，如“斗罗历”）、year（纪年的年，正整数）、month（1～12）、day（日）、displayDay（日序制下的第几天）、hour（0～23）、minute（0～59）、currency（从大到小的货币单位，最小单位 value 为 1，其余写等于多少个最小单位，如 [{"name":"金魂币","value":10000},{"name":"银魂币","value":100},{"name":"铜魂币","value":1}]）。
只输出一个 JSON 对象，只包含需要改的字段，外加一句给玩家看的 "note"。` },
    { role: "user", content: `${contextBlock(c)}\n\n【现在的设置】${JSON.stringify(current)}\n\n【玩家的要求】${instruction.trim()}` },
  ];
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
const int = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);

export function parseReviseEntry(value: unknown, before: ReviseEntry): ReviseEntryResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const text = str(v.text, 4000);
  if (!text) return null;
  const aliases = Array.isArray(v.aliases) ? v.aliases.map((a) => str(a, 40)).filter((a): a is string => !!a).slice(0, 12) : before.aliases;
  return { name: str(v.name, 60) || before.name, aliases, text };
}

/** Only the fields the model actually set, each checked; anything else is dropped. */
export function parseReviseRules(value: unknown): (Partial<ReviseRules> & { note?: string }) | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const out: Partial<ReviseRules> & { note?: string } = {};
  if (v.clockStyle === "era" || v.clockStyle === "elapsed") out.clockStyle = v.clockStyle;
  if (v.timeStyle === "24h" || v.timeStyle === "shichen") out.timeStyle = v.timeStyle;
  if (typeof v.lunar === "boolean") out.lunar = v.lunar;
  const eraName = str(v.eraName, 12); if (eraName) out.eraName = eraName;
  const year = int(v.year, 1, 999_999_999); if (year !== undefined) out.year = year;
  const month = int(v.month, 1, 12); if (month !== undefined) out.month = month;
  const day = int(v.day, 1, 31); if (day !== undefined) out.day = day;
  const displayDay = int(v.displayDay, 1, Number.MAX_SAFE_INTEGER); if (displayDay !== undefined) out.displayDay = displayDay;
  const hour = int(v.hour, 0, 23); if (hour !== undefined) out.hour = hour;
  const minute = int(v.minute, 0, 59); if (minute !== undefined) out.minute = minute;
  if (Array.isArray(v.currency)) {
    const units = v.currency.map((u) => ({ name: str((u as Record<string, unknown>)?.name, 8) ?? "", value: int((u as Record<string, unknown>)?.value, 1, Number.MAX_SAFE_INTEGER) ?? 0 })).filter((u) => u.name && u.value);
    if (units.length) out.currency = units.slice(0, 6);
  }
  const note = str(v.note, 200); if (note) out.note = note;
  return Object.keys(out).filter((k) => k !== "note").length ? out : null;
}
