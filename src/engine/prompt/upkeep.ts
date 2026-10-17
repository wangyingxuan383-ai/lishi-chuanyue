// Keeping the 设定集 up to date during play (R04-T001, D122): every few turns
// the auxiliary model reads the recent story and proposes cards for what has a
// name and will likely come back, describes places that have no description,
// and updates cards the AI wrote before. What the player or a built-in pack
// wrote is never changed. Changes are logged in ./CHANGES.md.
import type { ChatMessage } from "../llm/chat";
import { lenientJson } from "../record/parse";
import type { CardPatch, PlacePatch, TurnRecord } from "../state/apply";
import { matchName } from "../state/names";
import type { CardKind, StoryNode, WorldState } from "../types";

export const UPKEEP_PROMPT_VERSION = "upkeep-1";
/** Turns between two passes. */
export const UPKEEP_EVERY = 6;
/** Most new cards, updates and places taken from one pass. */
const MAX_EACH = 3;
const STORY_CHARS = 5000;
const SOURCE_TEXT = { 卡组: "内置卡组", AI: "AI 整理", 玩家: "玩家写的" } as const;

export interface UpkeepInput {
  premise: string;
  state: Pick<WorldState, "cards" | "places" | "people" | "dismissed">;
  /** The turns since the last pass, oldest first. */
  turns: Pick<StoryNode, "actionText" | "narrative">[];
}

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The newest turns that fit in STORY_CHARS, oldest first. */
function storyBlock(turns: UpkeepInput["turns"]): string {
  const parts: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const part = `${turns[i].actionText ? `【玩家】${turns[i].actionText}\n` : ""}${turns[i].narrative.trim()}`;
    if (parts.length && used + part.length > STORY_CHARS) break;
    parts.unshift(part);
    used += part.length;
  }
  return parts.join("\n\n");
}

export function upkeepMessages(input: UpkeepInput): ChatMessage[] {
  const { state } = input;
  const cards = state.cards.filter((c) => c.kind !== "时代").map((c) => c.source === "AI"
    ? `- ${c.kind} · ${c.name}（AI 整理，可以更新）：${short(c.content, 100)}`
    : `- ${c.kind} · ${c.name}（${SOURCE_TEXT[c.source ?? "玩家"]}，不要改）`);
  const places = state.places.map((p) => `- ${p.name}${p.description.trim() ? `${p.source === "AI" ? "（AI 整理，可以更新）" : ""}：${short(p.description, 60)}` : "（还没有描述）"}`);
  const people = state.people.map((p) => p.name);
  return [
    {
      role: "system",
      content: `你是一部历史互动小说的资料员，替作者维护“设定集”：读最近几回合的剧情，把以后写作用得着的资料记成卡片。
要求：
- 新卡只记剧情里有名字、以后很可能再出现的东西：势力（官署、帮会、商号、家族、党派）、物品（关键物件、信物、证据）、设定（规矩、案子、传闻、暗号）。一次最多 3 张，宁缺毋滥；已有的卡片和地点不要重复建。
- 人物不建卡（另有人物表）。主角随身的普通东西不建卡。
- 剧情里到过或详细写到的地点：没有描述的补一句描述；没有的新地点可以新建。
- 标着“AI 整理，可以更新”的卡片和地点，最近的剧情让它的情况变了（易主、被毁、真相揭开、立场改变），就重写它的正文；没变的不要动。标着“不要改”的一律不动。
- 只写剧情里写到或能直接推出的事实，不编造、不预告；用资料口吻写，每张不超过 80 字。
- 名称用剧情里的叫法；剧情里对它的其他叫法写进别名。
- 没有值得记的就输出空数组。
只输出一个 JSON 对象：
{"cards":[{"kind":"势力","name":"名称","keys":["别名"],"content":"……"}],
 "places":[{"name":"地点名","aliases":["别名"],"description":"……"}],
 "updates":[{"name":"已有卡片的名称","content":"新的正文"}]}`,
    },
    {
      role: "user",
      content: `【故事设定】\n${short(input.premise.trim(), 600) || "（未写）"}

【设定集里已有的卡片】
${cards.join("\n") || "（无）"}

【已有的地点】
${places.join("\n") || "（无）"}

【人物表里已有的人物（不要建卡）】${people.join("、") || "（无）"}${state.dismissed?.length ? `\n\n【玩家删掉的，不要再建】${state.dismissed.join("、")}` : ""}

【最近的剧情】
${storyBlock(input.turns)}`,
    },
  ];
}

const KINDS: CardKind[] = ["势力", "物品", "设定"];
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
const names = (v: unknown) => (Array.isArray(v) ? v.map((k) => text(k, 20)).filter(Boolean).slice(0, 4) : []);

/**
 * Turns the model's answer into an edit patch against the current state.
 * New names must not already be a card, place or person, nor something the
 * player deleted; updates only touch what the AI wrote. Null when nothing is left.
 */
export function upkeepPatch(raw: string, state: Pick<WorldState, "cards" | "places" | "people" | "dismissed">): TurnRecord | null {
  const value = lenientJson(raw) as { cards?: unknown; places?: unknown; updates?: unknown } | null;
  if (!value || typeof value !== "object") return null;
  const dismissed = new Set(state.dismissed ?? []);
  const cardNames = state.cards.filter((c) => c.kind !== "时代").map((c) => ({ id: c.id, name: c.name, aliases: c.keys }));
  const known = (name: string) => dismissed.has(name) || !!matchName(cardNames, name) || !!matchName(state.people, name) || !!matchName(state.places, name);
  const cards: CardPatch[] = [];
  const places: PlacePatch[] = [];

  for (const item of list(value.cards)) {
    if (cards.length >= MAX_EACH) break;
    const name = text(item.name, 20);
    const content = text(item.content, 200);
    if (!name || !content || known(name) || cards.some((c) => c.name === name)) continue;
    const kind = KINDS.includes(item.kind as CardKind) ? (item.kind as CardKind) : "设定";
    cards.push({ op: "add", kind, name, keys: names(item.keys), content, source: "AI" });
  }
  let updates = 0;
  for (const item of list(value.updates)) {
    if (updates >= MAX_EACH) break;
    const found = matchName(cardNames, text(item.name, 20));
    const card = found && state.cards.find((c) => c.id === found.id);
    const content = text(item.content, 200);
    if (!card || card.source !== "AI" || !content || content === card.content) continue;
    cards.push({ op: "update", id: card.id, name: card.name, content, source: "AI" });
    updates++;
  }
  for (const item of list(value.places)) {
    if (places.length >= MAX_EACH) break;
    const name = text(item.name, 20);
    const description = text(item.description, 200);
    if (!name || !description || dismissed.has(name)) continue;
    const place = matchName(state.places, name);
    if (place) {
      // Only fill a blank description or update one the AI wrote.
      if ((place.description.trim() && place.source !== "AI") || place.description === description) continue;
      places.push({ op: "update", id: place.id, name: place.name, aliases: [...(place.aliases ?? []), ...names(item.aliases)], description, source: "AI" });
    } else if (!known(name) && !places.some((p) => p.name === name)) {
      places.push({ op: "add", name, aliases: names(item.aliases), description, source: "AI" });
    }
  }
  if (!cards.length && !places.length) return null;
  return { ...(cards.length ? { cards } : {}), ...(places.length ? { places } : {}) };
}
