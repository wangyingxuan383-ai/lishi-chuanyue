// Chapter summaries (R04-T003, D106): every few turns the auxiliary model
// condenses the turns since the last chapter into a title, a one-line gist and
// a summary. Turns that have left the raw-text window reach the narrator only
// through these. Changes are logged in ./CHANGES.md.
import type { ChatMessage } from "../llm/chat";
import { lenientJson } from "../record/parse";
import type { Chapter, StoryNode } from "../types";

export const CHAPTER_PROMPT_VERSION = "chapter-1";
/** Characters of 【前情提要】 in a turn prompt (PLAN §5.3, layer 7). */
export const RECAP_BUDGET = 1500;
/** The newest chapters outside the window are given in full; older ones by their gist. */
const FULL_CHAPTERS = 3;

export interface ChapterInput {
  premise: string;
  protagonist: string;
  /** Chapters before this one on the path, oldest first. */
  previous: Pick<Chapter, "title" | "gist">[];
  /** The turns of this chapter, oldest first, and the number of the first one. */
  turns: Pick<StoryNode, "actionText" | "narrative">[];
  firstTurn: number;
}

export function chapterMessages(input: ChapterInput): ChatMessage[] {
  const last = input.firstTurn + input.turns.length - 1;
  const story = input.turns.map((t, i) => `第 ${input.firstTurn + i} 回合\n${t.actionText ? `【玩家】${t.actionText}\n` : ""}${t.narrative.trim()}`).join("\n\n");
  const previous = input.previous.map((c, i) => `第 ${i + 1} 章 · ${c.title}：${c.gist}`).join("\n");
  return [
    {
      role: "system",
      content: `你是一部历史互动小说的记录员。把下面这一章的剧情写成章节摘要，供作者在以后的回合里回顾前情。
要求：
- summary：150～250 字，按时间顺序写清发生了什么：主角做了什么、和谁打了交道、结果如何；得到或失去的重要东西；受的伤；许下的承诺、欠下的人情或债、结下的仇；还没解开的悬念。
- 人名、地名、物品名照剧情里的叫法；钱数、日期、期限照原文写。
- 只写剧情里发生过的事，不评论、不推测、不预告。
- gist：一句话梗概，不超过 40 字。
- title：章节标题，4～8 个字。
只输出一个 JSON 对象：{"title":"……","gist":"……","summary":"……"}`,
    },
    {
      role: "user",
      content: `【故事设定】${input.premise.trim().slice(0, 400) || "（未写）"}
【主角】${input.protagonist}${previous ? `\n\n【前几章梗概】\n${previous}` : ""}

【本章剧情（第 ${input.firstTurn}～${last} 回合）】
${story}`,
    },
  ];
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The model's answer as a chapter, or null when it has no summary. */
export function parseChapter(raw: string): Pick<Chapter, "title" | "gist" | "summary"> | null {
  const value = lenientJson(raw) as { title?: unknown; gist?: unknown; summary?: unknown } | null;
  const summary = text(value?.summary, 600);
  if (!summary) return null;
  return { title: text(value?.title, 16) || "无题", gist: text(value?.gist, 80) || summary.slice(0, 40), summary };
}

/**
 * 【前情提要】 for a turn: chapters (oldest first, numbered from 1) whose
 * first turn is no longer in the raw-text window. The newest few come in full,
 * older ones by their gist; the oldest are dropped first to fit the budget.
 */
export function recapBlock(chapters: Chapter[], inWindow: (nodeId: string) => boolean, budget = RECAP_BUDGET): string {
  const needed = chapters.map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => !inWindow(c.firstNodeId));
  if (!needed.length) return "";
  const lines = needed.map(({ c, n }, i) => `第 ${n} 章 · ${c.title}：${i >= needed.length - FULL_CHAPTERS ? c.summary : c.gist}`);
  while (lines.length > 1 && lines.join("\n").length > budget) lines.shift();
  return `【前情提要】（更早的剧情，按先后排列）\n${lines.join("\n").slice(0, budget)}`;
}
