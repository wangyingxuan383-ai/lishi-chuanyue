// 查一查 (R07-T001): the player asks a question in the middle of a game. The
// answer comes from this world's own records first; general history knowledge
// is marked 【仅供参考】. Nothing advances or changes. Changes are logged in
// ./CHANGES.md.
import type { EraContext } from "../era";
import type { ChatMessage } from "../llm/chat";
import type { Chapter, StoryNode, WorldSettings, WorldState } from "../types";
import { renderState } from "./turn";

export const ASK_PROMPT_VERSION = "ask-1";
const RECENT_TURNS = 5;
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export interface AskInput {
  question: string;
  state: WorldState;
  era: EraContext;
  settings: WorldSettings;
  chapters: Chapter[];
  /** The path so far, oldest first; only the last few turns are used. */
  history: StoryNode[];
  pins: string[];
}

export function askMessages(input: AskInput): ChatMessage[] {
  const { state } = input;
  const cards = state.cards.filter((c) => c.kind !== "时代").map((c) => `- ${c.kind} · ${c.name}${c.keys.length ? `（又称${c.keys.join("、")}）` : ""}：${short(c.content, 120)}`);
  const places = state.places.filter((p) => p.description.trim()).map((p) => `- ${p.name}：${short(p.description, 80)}`);
  const goals = state.goals.map((g) => `- 【${g.kind}】${g.name}（${g.status}${g.progress ? `：${g.progress}` : ""}）`);
  const chapters = input.chapters.map((c, i) => `第 ${i + 1} 章 · ${c.title}：${c.summary}`);
  const recent = input.history.filter((n) => n.kind !== "edit").slice(-RECENT_TURNS).map((n) => `${n.actionText ? `【玩家】${n.actionText}\n` : ""}${n.narrative.trim()}`);
  const essentials = [...input.settings.essentials.split(/\n+/), ...input.pins].map((l) => l.trim()).filter(Boolean);
  const section = (title: string, lines: string[]) => (lines.length ? `\n\n【${title}】\n${lines.join("\n")}` : "");
  return [
    {
      role: "system",
      content: `你是一部历史互动小说的资料员，替玩家查资料、答疑问。
- 先用下面的本局资料回答（人物、地点、设定、目标、章节、最近的剧情、要点），这些就是这个世界里的事实。
- 本局资料里没有、需要靠你的历史知识回答的部分，单独成段，段首写“【仅供参考】”，提醒玩家可能有误；拿不准就说不确定，不编造。
- 本局资料里有答案的部分，段首写“【本局】”。
- 不推进剧情，不替玩家做决定，不剧透资料里没有的后续。回答简短清楚，三五句为宜。`,
    },
    {
      role: "user",
      content: `${renderState(state, input.era)}${input.settings.premise.trim() ? `\n\n【故事设定】\n${input.settings.premise.trim()}` : ""}${input.era.eraCard ? `\n\n【时代卡】${input.era.eraCard.name}\n${short(input.era.eraCard.content, 600)}` : ""}${section("设定集", [...cards, ...places])}${section("目标", goals)}${section("要点", essentials)}${section("章节", chapters)}${section("最近的剧情", recent)}

【玩家的问题】${input.question.trim()}`,
    },
  ];
}
