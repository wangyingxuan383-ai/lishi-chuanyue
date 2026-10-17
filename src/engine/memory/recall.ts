// 【相关旧事】 (R04 follow-up to eval F): when a person, card, place or item that
// is in play right now was talked about in turns that have left the raw-text
// window, the sentences that mention it come back — its first appearance and
// its latest one. After eval H, what the player wrote this turn is matched
// against those turns too, so a thing described rather than named ("皮甲里那两
// 封信") still finds where it happened. No model call.
import type { StoryNode, WorldState } from "../types";
import { bestMatches, clausesOf, excerpt, pairWeights, pairsOf, type Passage } from "./match";

export const RECALL_BUDGET = 1200;
/** Of the budget, what the sentences matching the player's words may take; the names in play get the rest. */
const QUERY_SHARE = 0.7;
/** Sentences matching what the player wrote, at most, shared among its parts (two each at least). */
const QUERY_LINES = 6;
/** Snippets per name: where it first appeared and where it last did. */
const PER_NAME = 2;
const SENTENCE = /[^。！？\n]*[。！？]?[”」』]?/g;

/** Names in play: everything with a name that the recent text mentions, the latest-mentioned first. */
export function namesInPlay(state: WorldState, recent: string): { name: string; alias: string[] }[] {
  const all = [
    ...state.people.map((p) => ({ name: p.name, alias: p.aliases })),
    ...state.cards.filter((c) => c.kind !== "时代").map((c) => ({ name: c.name, alias: c.keys })),
    ...state.places.map((p) => ({ name: p.name, alias: p.aliases ?? [] })),
    ...state.protagonist.items.map((i) => ({ name: i.name, alias: [] as string[] })),
  ];
  return all
    .map((e) => ({ ...e, at: Math.max(...[e.name, ...e.alias].filter((w) => w && w.length >= 2).map((w) => recent.lastIndexOf(w)), -1) }))
    .filter((e) => e.at >= 0)
    .sort((a, b) => b.at - a.at || b.name.length - a.name.length)
    .map(({ name, alias }) => ({ name, alias }));
}

// Sentences with 【…】 are context the model once copied into a passage, not story.
const sentencesOf = (text: string) => (text.replace(/\s+/g, "").match(SENTENCE) ?? []).filter((s) => s.length >= 6 && !s.includes("【"));

/**
 * Old sentences that match each part of what the player wrote, taken in turn
 * (the first match of every part, then the second), oldest turns allowed.
 */
function querySentences(query: string, older: { node: StoryNode; turn: number }[]): { turn: number; source: string; text: string }[] {
  const clauses = clausesOf(query);
  if (!clauses.length) return [];
  const weights = pairWeights(clauses.join("\n"), older.map(({ node }) => node.narrative));
  const wanted = [...weights.keys()];
  // Only turns sharing at least two of the query's pairs are split into sentences.
  const passages: Passage[] = older
    .filter(({ node }) => wanted.filter((p) => node.narrative.includes(p)).length >= 2)
    .flatMap(({ node, turn }) => sentencesOf(node.narrative).map((text) => ({ text, at: turn })));
  const each = Math.max(2, Math.ceil(QUERY_LINES / clauses.length));
  const lists = clauses.map((clause) => bestMatches(clause, passages, weights, each).map((p) => ({ turn: p.at, source: p.text, text: excerpt(p.text, clause, 70) })));
  const out: { turn: number; source: string; text: string }[] = [];
  for (let i = 0; i < each; i++) for (const list of lists) if (list[i] && !out.some((o) => o.source === list[i].source)) out.push(list[i]);
  return out;
}

/** The sentence around a word, trimmed to a readable length. */
function sentenceWith(text: string, word: string): string | null {
  for (const s of text.replace(/\s+/g, "").match(SENTENCE) ?? []) {
    if (s.includes(word)) return s.length > 90 ? `${s.slice(0, 88)}…` : s;
  }
  return null;
}

/**
 * Old sentences from turns outside the window (`older`, oldest first, each
 * with its turn number): first those matching what the player wrote this turn
 * (`query`), then those about the names in play, the most recently mentioned
 * first. Budgeted.
 */
export function recallBlock(state: WorldState, recent: string, older: { node: StoryNode; turn: number }[], budget = RECALL_BUDGET, query = ""): string {
  if (!older.length) return "";
  const lines: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  const label = (turn: number) => (turn === 0 ? "开场" : `第 ${turn} 回合`);
  if (pairsOf(query).length >= 2) {
    for (const { turn, source, text } of querySentences(query, older)) {
      const line = `- ${label(turn)}：${text}`;
      if (used + line.length > budget * QUERY_SHARE) break;
      seen.add(source);
      lines.push(line);
      used += line.length;
    }
  }
  for (const { name, alias } of namesInPlay(state, recent)) {
    const words = [name, ...alias].filter((w) => w.length >= 2);
    const hits = older.filter(({ node }) => words.some((w) => node.narrative.includes(w)));
    const picks = hits.length > PER_NAME ? [hits[0], hits[hits.length - 1]] : hits;
    for (const { node, turn } of picks) {
      const word = words.find((w) => node.narrative.includes(w))!;
      const sentence = sentenceWith(node.narrative, word);
      if (!sentence || sentence.includes("【") || seen.has(sentence) || [...seen].some((s) => s.startsWith(sentence.replace(/…$/, "")))) continue;
      const line = `- ${label(turn)}（${name}）：${sentence}`;
      if (used + line.length > budget) return lines.length ? `\n【相关旧事】（早先的剧情里和眼下有关的句子）\n${lines.join("\n")}` : "";
      seen.add(sentence);
      lines.push(line);
      used += line.length;
    }
  }
  return lines.length ? `\n【相关旧事】（早先的剧情里和眼下有关的句子）\n${lines.join("\n")}` : "";
}
