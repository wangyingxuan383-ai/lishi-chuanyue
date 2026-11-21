// Keeping the 设定集 up to date during play (R04-T001, D122): every few turns
// the auxiliary model reads the recent story and proposes cards for what has a
// name and will likely come back, describes places that have no description,
// updates cards the AI wrote before, and adds recurring people the ledger
// missed; since upkeep-3 it also clears statuses that are not (or no longer)
// the protagonist's condition and marks deaths the ledger missed; since
// upkeep-5 it merges one place or thing that got two cards under two names;
// since upkeep-6 it keeps the protagonist's abilities in one card (“某某的本事”),
// records concrete details over summaries, and drops its own one-off cards.
// What the player or a built-in pack wrote is never changed. Changes are
// logged in ./CHANGES.md.
import type { ChatMessage } from "../llm/chat";
import type { StoryNode, WorldState } from "../types";
import { abilityCardName, isAbilityCard } from "../memory/cards";

export const UPKEEP_PROMPT_VERSION = "upkeep-7";
export const UPKEEP_FREE_PROMPT_VERSION = "upkeep-free-7";
/** Turns between two passes. */
export const UPKEEP_EVERY = 6;
const STORY_CHARS = 5000;
const SOURCE_TEXT = { 卡组: "内置卡组", AI: "AI 整理", 玩家: "玩家写的" } as const;

export interface UpkeepInput {
  premise: string;
  state: Pick<WorldState, "cards" | "places" | "people" | "dismissed" | "protagonist"> & Partial<Pick<WorldState, "era">>;
  /** The turns since the last pass, oldest first. */
  turns: Pick<StoryNode, "actionText" | "narrative">[];
  /** The era card's "不要出现" line, so cards use the era's own words. */
  taboos?: string;
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
  const free = state.era?.mode === "free";
  const worldCard = free ? state.cards.find((c) => c.kind === "时代") : null;
  const ability = abilityCardName(state.protagonist.name);
  const cards = state.cards.filter((c) => c.kind !== "时代").map((c) => c.source === "AI"
    ? `- ${c.kind} · ${c.name}（AI 整理，可以更新）：${short(c.content, isAbilityCard(c.name, state.protagonist.name) ? 400 : 100)}`
    : `- ${c.kind} · ${c.name}（${SOURCE_TEXT[c.source ?? "玩家"]}，不要改）`);
  const places = state.places.map((p) => `- ${p.name}${p.description.trim() ? `${p.source === "AI" ? "（AI 整理，可以更新）" : ""}：${short(p.description, 60)}` : "（还没有描述）"}`);
  const people = state.people.map((p) => p.name);
  return [
    {
      role: "system",
      content: `你是一部${free ? "" : "历史"}互动小说的资料员，替作者维护“设定集”：读最近几回合的剧情，把以后写作用得着的资料记下来。
要求：
- 设定集是写作时备查的资料，不是剧情梗概（梗概已经有章节摘要）：只记以后写作还会用到、容易写错的具体东西——名称、等级、年限、颜色、数量、能力和招式、物品的样子与下落、规矩、约定和代价。写具体的数字和名称，不要概括成“实力提升”“获得机缘”。
- 主角自己的本事和成长（用这个世界自己的说法写：修为或等级、境界、功法和招式、法宝或装备、血脉、契约、特殊能力等，名称、数字、年限都写具体）只记在一张名为“${ability}”的设定卡里，分项写清：没有就在 cards 里新建；剧情让它变了（升级、突破、学会新招、得到或失去法宝），就在 updates 里写出更新后的全文。这张卡可以写到 300 字。
- 新卡只记剧情里有名字、以后很可能再出现的东西，一张卡只写一样东西。${free ? "记下反复出现的组织、关键物品和设定。" : "先记反复出现的势力（官署、军队、帮会、商号、家族、党派），再记关键物件（信物、证据）和设定（规矩、案子、暗号）。"}一次最多 3 张，宁缺毋滥；已有的卡片和地点不要重复建。
- 主角就是【主角】里写的那个人，剧情里的“你”就是主角。主角做的事、拿到的东西记在主角名下（卡片里写“主角”或主角的名字），不要记到别人头上，也不要给主角另起名字。
- 人物表里没有、却在剧情里反复出现、有名字或固定称呼的人，写进 people（身份、对主角的态度、一句备注），一次最多 3 个；人物表里已有的不写，人物不建卡。人物表里的人，剧情写明已经死了的，写进 deaths。
- 剧情里到过或详细写到的地点：没有描述的补一句描述；没有的新地点可以新建。已有地点里面的一处（院子、偏厅、牢房）写进那个地点的描述，不要另建一张。
- 【主角的状况】里不是身体或精神状况的（东西、知道的事、处境、别人的态度），和剧情里早已好了、过去了的，写进 statusRemove。
- 两张标着“AI 整理，可以更新”的卡片，或两个标着“AI 整理”或“还没有描述”的地点，其实是同一样东西、同一个地方的不同叫法（如“县衙”和“县衙大堂”、“密信”和“那封信”），写进 merges：keep 是留下的那个，drop 并进去，content 写合并后的正文。只合并确定是同一个的；同类但不同的两样东西不要合并。
- 逐张检查标着“AI 整理，可以更新”的卡片和地点：最近的剧情让它过时了（东西被取走、人死了、地方被毁、真相揭开、立场改变），就重写它的正文；没变的不要动。标着“不要改”的一律不动。
- 只写剧情里写到的事实，不编造、不预告；别人转述的话、传闻和猜测要写明“某某说”“传闻”，不要写成定论。同一件事只写在最相关的那一张卡里。用资料口吻，每张不超过 80 字。
- ${free ? "名称和称呼沿用剧情与世界卡，其他叫法写进别名。世界卡只供参考，不改写；不自动编排未来事件，不输出 timeline、deviation。" : "名称用剧情里的叫法，其他叫法写进别名；但要用这个时代该有的说法，不要照抄正文里不合时代的词（附有【这个时代不该出现的东西】时，避开里面的说法）。"}
- 标着“AI 整理，可以更新”的卡里，只是一次性的场景、已经结束而且以后用不上的事（不是人物、地点、势力、关键物品、规矩，也不是“${ability}”），写进 drop，一次最多 3 张；拿不准的留着。
- 没有值得记的就输出空数组。
只输出一个 JSON 对象：
{"cards":[{"kind":"势力","name":"名称","keys":["别名"],"content":"……"}],
 "places":[{"name":"地点名","aliases":["别名"],"description":"……"}],
 "updates":[{"name":"已有卡片或地点的名称","content":"新的正文"}],
 "people":[{"name":"人物名","role":"身份","attitude":"仇视/敌意/冷淡/一般/友善/亲近/生死之交","note":"一句备注"}],
 "deaths":["人物表里已死的人名"],
 "merges":[{"keep":"留下的卡片或地点名","drop":"并进去的名称","content":"合并后的正文"}],
 "drop":["用不上的 AI 卡片名称"],
 "statusRemove":["主角状况里该去掉的名称"]}`,
    },
    {
      role: "user",
      content: `【主角】${state.protagonist.name}${state.protagonist.identity ? `（${short(state.protagonist.identity, 60)}）` : ""}；剧情里的“你”就是他

【主角的状况】${state.protagonist.statuses.map((x) => x.name).join("、") || "（无）"}

【故事设定】\n${short(input.premise.trim(), 600) || "（未写）"}${worldCard ? `\n\n【世界卡】${worldCard.name}\n${short(worldCard.content, 600)}` : ""}

【设定集里已有的卡片】
${cards.join("\n") || "（无）"}

【已有的地点】
${places.join("\n") || "（无）"}

【人物表里已有的人物（不要建卡，也不要再写进 people）】${people.join("、") || "（无）"}${state.dismissed?.length ? `\n\n【玩家删掉的，不要再建】${state.dismissed.join("、")}` : ""}${!free && input.taboos ? `\n\n【这个时代不该出现的东西】${input.taboos}` : ""}

【最近的剧情】
${storyBlock(input.turns)}`,
    },
  ];
}

// 整理状况 (R30 step 2): on request from the character panel, which of the
// protagonist's statuses are over or are not a condition at all. The player
// sees the list with reasons and chooses; nothing is removed without that.
export const STATUS_TIDY_PROMPT_VERSION = "status-tidy-1";

export function statusTidyMessages(state: Pick<WorldState, "protagonist" | "time">, turns: Pick<StoryNode, "actionText" | "narrative">[]): ChatMessage[] {
  const now = state.time.elapsedMinutes;
  const age = (since: number) => {
    const days = Math.floor(Math.max(0, now - since) / 1440);
    return days >= 1 ? `，已有 ${days} 天` : "";
  };
  return [
    {
      role: "system",
      content: `你替互动小说的作者整理主角身上的状况。逐条看【主角的状况】，挑出该去掉的：
- 按最近的剧情已经好了、过去了的（伤养好了、酒醒了、吃饱了、歇过来了、毒解了）；
- 剧情里很久没再提、按常理早该好了的轻伤小病（看“已有几天”）；
- 根本不是身体或精神状况的（东西、知道的事、身份处境、别人的态度）。
还在的、拿不准的不列。“垂危”不列。每条用一句话写理由，引剧情里的依据。
只输出一个 JSON 对象：{"remove":[{"name":"状况名称，照抄","why":"一句理由"}]}`,
    },
    {
      role: "user",
      content: `【主角的状况】
${state.protagonist.statuses.map((x) => `- ${x.name}${x.detail ? `：${short(x.detail, 60)}` : ""}${age(x.sinceMinute)}`).join("\n") || "（无）"}

【最近的剧情】
${storyBlock(turns)}`,
    },
  ];
}

/** The statuses to offer for removal: only names the protagonist has, never 垂危, each once. */
export function parseStatusTidy(value: unknown, statuses: { name: string }[]): { name: string; why: string }[] {
  const list = (value as { remove?: unknown } | null)?.remove;
  if (!Array.isArray(list)) return [];
  const out: { name: string; why: string }[] = [];
  for (const item of list) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!name || name === "垂危" || out.some((x) => x.name === name) || !statuses.some((x) => x.name === name)) continue;
    out.push({ name, why: typeof item?.why === "string" ? short(item.why.trim(), 80) : "" });
  }
  return out;
}
