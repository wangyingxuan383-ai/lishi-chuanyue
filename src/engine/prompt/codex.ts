// Organizing the 设定集 from the player's own setup (R03-T008, D121): an era
// card and a few key cards that fill in what the premise leaves open,
// without contradicting it. Changes are logged in ./CHANGES.md.
import type { ChatMessage } from "../llm/chat";
import { lenientJson } from "../record/parse";
import type { CardPatch, PlacePatch, TurnRecord } from "../state/apply";
import { matchName } from "../state/names";
import type { CardKind, WorldState } from "../types";

export const CODEX_PROMPT_VERSION = "codex-1";

export interface CodexInput {
  premise: string;
  protagonist: { name: string; gender: string; age: number | null; identity: string };
  arrival: string;
  /** Cards the world already has, so the model does not repeat them. */
  known?: string[];
}

export function codexMessages(input: CodexInput): ChatMessage[] {
  const p = input.protagonist;
  return [
    {
      role: "system",
      content: `你帮玩家整理一部历史互动小说的“设定集”。玩家写好了故事设定，你据此整理出一张时代卡和至多 5 张关键卡片，供写作时参考。
要求：
- 只补故事设定里没写清楚的部分；与故事设定一致，绝不改动或否定玩家写的内容。
- 故事设定是真实朝代，就写那个时代真实的情况；是架空或改编的，就按设定自洽地编，货币、称谓、制度都跟着设定走。
- 拿不准的写得笼统些，不编造确切数字；不写具体人物（人物由剧情产生），不预告剧情。
- 时代卡按下面的顺序一行一个话题，总共不超过 800 字：
时局：谁当权、局势如何、人们在谈什么
货币：用什么钱，怎么换算，日常怎么花
物价：五六样常见东西大约多少钱
称谓：常见称呼各对谁用
日常：衣食住行的几个具体细节
节令：一年中几个重要节日，标明月份
文风：叙述和对白应是什么味道
不要出现：这个时代容易写错的东西，如“算盘（用算筹）”，十条以上，用“；”分开
- 卡片只写故事设定里出现或明显会出现的势力、地点、规矩（kind 写“势力”“地点”“设定”或“物品”），每张不超过 80 字。
只输出一个 JSON 对象：
{"era":{"name":"时代卡名称，如“北宋 · 宣和年间 · 汴京”","content":"时局：……\\n货币：……\\n……\\n不要出现：……"},
 "cards":[{"kind":"势力","name":"名称","keys":["别名"],"content":"一两句话"}]}`,
    },
    {
      role: "user",
      content: `【故事设定】\n${input.premise.trim() || "（未写，请根据主角推断）"}\n\n【主角】${p.name || "未定"}，${p.gender}${p.age ? `，${p.age}岁` : ""}。${p.identity}\n穿越方式：${input.arrival}${input.known?.length ? `\n\n【已有卡片，不要重复】${input.known.join("、")}` : ""}`,
    },
  ];
}

const KINDS: CardKind[] = ["势力", "物品", "设定"];
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Turns the model's answer into an edit patch: the era card, place cards and
 * other cards, all marked AI. What the player wrote is kept: their cards,
 * places that already have a description, and their era card unless
 * `replaceOwnEra`. Null when nothing usable came back.
 */
export function codexPatch(raw: string, state: Pick<WorldState, "cards" | "places" | "dismissed">, opts: { replaceOwnEra?: boolean } = {}): TurnRecord | null {
  const value = lenientJson(raw) as { era?: { name?: unknown; content?: unknown }; cards?: unknown } | null;
  if (!value || typeof value !== "object") return null;
  const cards: CardPatch[] = [];
  const places: PlacePatch[] = [];
  const dismissed = new Set(state.dismissed ?? []);
  const mine = (kind: CardKind, name: string) => dismissed.has(name) || !!matchName(state.cards.filter((c) => c.source === "玩家" && c.kind === kind).map((c) => ({ name: c.name, aliases: c.keys })), name);
  const described = (name: string) => !!matchName(state.places, name)?.description.trim();
  const eraName = text(value.era?.name, 40);
  const eraContent = text(value.era?.content, 1200);
  const eraOwn = state.cards.find((c) => c.kind === "时代");
  if (eraContent && (eraOwn?.source !== "玩家" || opts.replaceOwnEra)) cards.push({ op: "add", kind: "时代", name: eraName || "时代", content: eraContent, source: "AI" });
  for (const item of (Array.isArray(value.cards) ? value.cards : []).slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const name = text(c.name, 20);
    const content = text(c.content, 200);
    const keys = Array.isArray(c.keys) ? c.keys.map((k) => text(k, 20)).filter(Boolean).slice(0, 4) : [];
    if (!name || !content) continue;
    if (c.kind === "地点") {
      if (!described(name) && !dismissed.has(name)) places.push({ op: "add", name, aliases: keys, description: content, source: "AI" });
    } else {
      const kind = KINDS.includes(c.kind as CardKind) ? (c.kind as CardKind) : "设定";
      if (!mine(kind, name)) cards.push({ op: "add", kind, name, keys, content, source: "AI" });
    }
  }
  if (!cards.length && !places.length) return null;
  return { ...(cards.length ? { cards } : {}), ...(places.length ? { places } : {}) };
}

/** "时代卡、天地会、西市等" for the edit line. */
export function codexSummary(patch: TurnRecord): string {
  const names = [
    ...(patch.cards ?? []).map((c) => (c.kind === "时代" ? "时代卡" : c.name ?? "")), ...(patch.places ?? []).map((p) => p.name ?? ""),
    ...(patch.people ?? []).map((p) => p.name),
  ].filter(Boolean);
  return `AI 整理了设定集：${names.slice(0, 3).join("、")}${names.length > 3 ? "等" : ""}`;
}
