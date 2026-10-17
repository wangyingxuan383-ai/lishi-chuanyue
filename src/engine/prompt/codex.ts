// Organizing the 设定集 from the player's own setup (R03-T008, D121): an era
// card and a few key cards that fill in what the premise leaves open,
// without contradicting it. Changes are logged in ./CHANGES.md.
import type { ChatMessage } from "../llm/chat";
import { shortTabooLine } from "../era/taboo";
import { lenientJson } from "../record/parse";
import type { CardPatch, PlacePatch, TurnRecord } from "../state/apply";
import { matchName } from "../state/names";
import type { CardKind, WorldState } from "../types";

export const CODEX_PROMPT_VERSION = "codex-5";
export const CODEX_FREE_PROMPT_VERSION = "codex-3";
/** Most great events and "不要出现" entries taken from one organizing pass. */
const TIMELINE_MAX = 8;
const TABOO_MAX = 8;

export interface CodexInput {
  /** Taken from the world's snapshot; omitted for legacy history worlds. */
  mode?: "history" | "free";
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
      content: input.mode === "free" ? `你帮玩家整理一部互动小说的“设定集”。根据故事设定整理一张世界卡和至多 5 张关键卡片，供写作时参考。
- 只补故事设定里没写清楚的部分；与故事设定一致，绝不改动或否定玩家写的内容。
- 世界卡自由组织，记清设定中已有的世界背景、日常生活、货币和称呼；没有写明的细节可以留白，不强加风格或规则。不超过 800 字。
- 货币与换算沿用世界设定；不默认使用铜钱或任何特定币制。
- 关键卡片只写设定中出现或明显会出现的势力、地点、规矩、物品，每张不超过 80 字。人物由剧情产生，不预告剧情。
- 不生成年表或未来事件，不输出 timeline、deviation，不添加禁词清单。
只输出一个 JSON 对象（era 存放世界卡）：
{"era":{"name":"世界卡名称","content":"世界资料"},"cards":[{"kind":"势力/地点/设定/物品","name":"名称","keys":["别名"],"content":"一两句话"}]}` : `你帮玩家整理一部历史互动小说的“设定集”。玩家写好了故事设定，你据此整理出一张时代卡和至多 5 张关键卡片，供写作时参考。
要求：
- 只补故事设定里没写清楚的部分；与故事设定一致，绝不改动或否定玩家写的内容。
- 故事设定是真实朝代，就写那个时代真实的情况；是架空或改编的，就按设定自洽地编，货币、称谓、制度都跟着设定走。
- 拿不准的写得笼统些，不编造确切数字；不写具体人物（人物由剧情产生），不预告剧情。
- 时代卡是写作时备查的背景资料，一行一个话题，从时局、货币（怎么换算、日常怎么花）、物价、称谓、日常、节令里挑与故事有关的写，没把握的就不写，总共不超过 800 字。
- 时代卡最后可以加一行“不要出现：”，列几样这个时代最容易写错的东西，至多 8 条，用“；”分开，有替代说法的写在括号里，如“不要出现：火柴（用火石、火镰）”。只是备查，不必凑数。
- 卡片只写故事设定里出现或明显会出现的势力、地点、规矩（kind 写“势力”“地点”“设定”或“物品”），每张不超过 80 字。
- 故事设定是真实朝代时，另列故事开始之后几年里史书记载的大事，至多 8 件：日期写到月份（如“崇祯二年十月”），ceYear 写公元年份；kind 写“固定”（天灾、远方的战事这类主角左右不了的）或“可变”（朝中人事、近处的案子这类可能因主角而改变的）。这份年表只给玩家看，叙事者要到时间到了才知道。架空或改编的世界不写。
只输出一个 JSON 对象：
{"era":{"name":"时代卡名称，如“北宋 · 宣和年间 · 汴京”","content":"时局：……\\n货币：……\\n……"},
 "cards":[{"kind":"势力","name":"名称","keys":["别名"],"content":"一两句话"}],
 "timeline":[{"date":"崇祯二年十月","ceYear":1629,"title":"一句话写清这件大事","kind":"固定"}]}`,
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
 * other cards, all marked AI, and for a history world the great events it
 * listed. What the player wrote is kept: their cards, places that already have
 * a description, and their era card unless `replaceOwnEra`. Null when nothing
 * usable came back.
 */
export function codexPatch(raw: string, state: Pick<WorldState, "cards" | "places" | "dismissed"> & Partial<Pick<WorldState, "era">>, opts: { replaceOwnEra?: boolean } = {}): TurnRecord | null {
  const free = state.era?.mode === "free";
  const value = lenientJson(raw) as { era?: { name?: unknown; content?: unknown }; cards?: unknown; timeline?: unknown } | null;
  if (!value || typeof value !== "object") return null;
  const cards: CardPatch[] = [];
  const places: PlacePatch[] = [];
  const dismissed = new Set(state.dismissed ?? []);
  const mine = (kind: CardKind, name: string) => dismissed.has(name) || !!matchName(state.cards.filter((c) => c.source === "玩家" && c.kind === kind).map((c) => ({ name: c.name, aliases: c.keys })), name);
  const described = (name: string) => !!matchName(state.places, name)?.description.trim();
  const eraName = text(value.era?.name, 40);
  const eraContent = free ? text(value.era?.content, 1200) : shortTabooLine(text(value.era?.content, 1200), TABOO_MAX);
  const eraOwn = state.cards.find((c) => c.kind === "时代");
  if (eraContent && (eraOwn?.source !== "玩家" || opts.replaceOwnEra)) cards.push({ op: "add", kind: "时代", name: eraName || (free ? "世界" : "时代"), content: eraContent, source: "AI" });
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
  // A history world's great events, for the player's 记事 page; a free world never gets any.
  // The caller places them once the start date is known, and the narrator hears of each only
  // when its time has come (D129).
  const timeline = (!free && Array.isArray(value.timeline) ? value.timeline : []).slice(0, TIMELINE_MAX).flatMap((raw) => {
    const e = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const date = text(e.date, 20);
    const title = text(e.title, 60);
    const ceYear = typeof e.ceYear === "number" && Number.isInteger(e.ceYear) ? e.ceYear : null;
    return date && title ? [{ op: "add" as const, date, title, kind: e.kind === "固定" ? "固定" : "可变", source: "AI" as const, ...(ceYear !== null ? { ceYear } : {}) }] : [];
  });
  if (!cards.length && !places.length && !timeline.length) return null;
  return { ...(cards.length ? { cards } : {}), ...(places.length ? { places } : {}), ...(timeline.length ? { timeline } : {}) };
}

/** "时代卡、天地会、西市等；记下周管事已去世；去掉了 2 项过去的状况" for the edit line. */
export function codexSummary(patch: TurnRecord, state?: Pick<WorldState, "era">): string {
  const deaths = (patch.people ?? []).filter((p) => p.alive === false).map((p) => p.name);
  const names = [
    ...(patch.cards ?? []).map((c) => (c.kind === "时代" ? state?.era.mode === "free" ? "世界卡" : "时代卡" : c.name ?? "")), ...(patch.places ?? []).map((p) => p.name ?? ""),
    ...(patch.people ?? []).filter((p) => p.alive !== false).map((p) => p.name),
  ].filter(Boolean);
  const cleared = (patch.status ?? []).filter((x) => x.op === "remove").length;
  const events = (patch.timeline ?? []).filter((e) => e.op === "add").length;
  const parts = [
    names.length ? `${names.slice(0, 3).join("、")}${names.length > 3 ? "等" : ""}` : "",
    deaths.length ? `记下${deaths.join("、")}已去世` : "",
    cleared ? `去掉了 ${cleared} 项过去的状况` : "",
    events ? `年表记下 ${events} 件史书大事` : "",
  ].filter(Boolean);
  return `AI 整理了设定集：${parts.join("；")}`;
}
