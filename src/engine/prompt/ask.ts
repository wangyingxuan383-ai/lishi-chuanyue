// 查一查 (R07-T001): the player asks a question in the middle of a game. The
// answer comes from this world's own records first; general history knowledge
// is marked 【仅供参考】. Nothing advances or changes. Changes are logged in
// ./CHANGES.md.
import { timeRows } from "../calendar/clock";
import type { EraContext } from "../era";
import type { ChatMessage } from "../llm/chat";
import { recallBlock } from "../memory/recall";
import type { Chapter, StoryNode, WorldSettings, WorldState } from "../types";
import { renderState } from "./turn";

export const ASK_PROMPT_VERSION = "ask-2";
export const ASK_FREE_PROMPT_VERSION = "ask-3";
/** Characters of the newest story for the question; the opening always comes too. */
const RECENT_CHARS = 5000;
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export interface AskInput {
  question: string;
  state: WorldState;
  era: EraContext;
  settings: WorldSettings;
  chapters: Chapter[];
  /** The whole path so far, oldest first. */
  history: StoryNode[];
  pins: string[];
}

export function askMessages(input: AskInput): ChatMessage[] {
  const { state } = input;
  const free = state.era.mode === "free";
  const cards = state.cards.filter((c) => c.kind !== "时代").map((c) => `- ${c.kind} · ${c.name}${c.keys.length ? `（又称${c.keys.join("、")}）` : ""}：${short(c.content, 120)}`);
  const places = state.places.filter((p) => p.description.trim()).map((p) => `- ${p.name}：${short(p.description, 80)}`);
  const goals = state.goals.map((g) => `- 【${g.kind}】${g.name}（${g.status}${g.progress ? `：${g.progress}` : ""}）`);
  const chapters = input.chapters.map((c, i) => `第 ${i + 1} 章 · ${c.title}：${c.summary}`);
  // The opening sets up the debts, deadlines and people; then the newest turns that fit; then
  // 【相关旧事】 for what the question names from turns in between.
  const story = input.history.filter((n) => n.kind !== "edit");
  const opening = story[0]?.kind === "opening" ? story[0] : null;
  const picked: StoryNode[] = [];
  let used = 0;
  for (const n of [...story].reverse()) {
    if (n === opening || (picked.length && used + n.narrative.length > RECENT_CHARS)) break;
    picked.unshift(n);
    used += n.narrative.length;
  }
  const recent = picked.map((n) => `${n.actionText ? `【玩家】${n.actionText}\n` : ""}${n.narrative.trim()}`);
  const inPicked = new Set(picked.map((n) => n.id));
  const older = story.map((node, turn) => ({ node, turn })).filter(({ node }) => node !== opening && !inPicked.has(node.id));
  const recall = recallBlock(state, input.question, older);
  const since = timeRows(input.era.clock, state.time.elapsedMinutes).find((r) => r.label === "开局")?.value;
  const essentials = [...input.settings.essentials.split(/\n+/), ...input.pins].map((l) => l.trim()).filter(Boolean);
  const section = (title: string, lines: string[]) => (lines.length ? `\n\n【${title}】\n${lines.join("\n")}` : "");
  const panel = input.settings.heroPanelEnabled && state.protagonist.panel?.trim()
    ? section("主角面板（玩家自记）", [state.protagonist.panel.trim()]) : "";
  return [
    {
      role: "system",
      content: `你是一部${free ? "" : "历史"}互动小说的资料员，替玩家查资料、答疑问。
- 先用下面的本局资料回答（开场、人物、地点、设定、目标、章节、最近的剧情、相关旧事、要点），这些就是这个世界里的事实。
- 【本局】段只写本局资料里明明白白写着的内容；资料没写的${free ? "世界规则、能力和背景细节" : "官品、年代、制度细节"}，就算你知道，也放进【仅供参考】段，不要混进【本局】。
- 本局资料里没有、需要靠你的${free ? "一般知识或推测" : "历史知识"}回答的部分，单独成段，段首写“【仅供参考】”，提醒玩家可能有误；拿不准就说不确定，不编造。${free ? "不补写年表或未来事件，不输出 timeline、deviation。" : ""}
- 不推进剧情，不替玩家做决定，不剧透资料里没有的后续。回答简短清楚，三五句为宜。`,
    },
    {
      role: "user",
      content: `${renderState(state, input.era)}${since ? `\n开局：${since}` : ""}${input.settings.premise.trim() ? `\n\n【故事设定】\n${input.settings.premise.trim()}` : ""}${input.era.eraCard ? `\n\n【${free ? "世界卡" : "时代卡"}】${input.era.eraCard.name}\n${short(input.era.eraCard.content, 600)}` : ""}${section("设定集", [...cards, ...places])}${section("目标", goals)}${section("要点", essentials)}${section("章节", chapters)}${opening ? section("开场", [opening.narrative.trim().slice(0, 1200)]) : ""}${section("最近的剧情", recent)}${recall}

${panel}
【玩家的问题】${input.question.trim()}`,
    },
  ];
}
