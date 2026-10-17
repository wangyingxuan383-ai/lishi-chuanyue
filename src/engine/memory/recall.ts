// 【相关旧事】 (R04 follow-up to eval F): when a person, card, place or item that
// is in play right now was talked about in turns that have left the raw-text
// window, the sentences that mention it come back — its first appearance and
// its latest one. Plain substring matching on names and aliases; no model call.
import type { StoryNode, WorldState } from "../types";

export const RECALL_BUDGET = 900;
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

/** The sentence around a word, trimmed to a readable length. */
function sentenceWith(text: string, word: string): string | null {
  for (const s of text.replace(/\s+/g, "").match(SENTENCE) ?? []) {
    if (s.includes(word)) return s.length > 90 ? `${s.slice(0, 88)}…` : s;
  }
  return null;
}

/**
 * Old sentences about the names in play, from turns outside the window
 * (`older`, oldest first, each with its turn number). Budgeted; the names the
 * recent text mentions most recently come first.
 */
export function recallBlock(state: WorldState, recent: string, older: { node: StoryNode; turn: number }[], budget = RECALL_BUDGET): string {
  if (!older.length) return "";
  const lines: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const { name, alias } of namesInPlay(state, recent)) {
    const words = [name, ...alias].filter((w) => w.length >= 2);
    const hits = older.filter(({ node }) => words.some((w) => node.narrative.includes(w)));
    const picks = hits.length > PER_NAME ? [hits[0], hits[hits.length - 1]] : hits;
    for (const { node, turn } of picks) {
      const word = words.find((w) => node.narrative.includes(w))!;
      const sentence = sentenceWith(node.narrative, word);
      if (!sentence || seen.has(sentence)) continue;
      const line = `- ${turn === 0 ? "开场" : `第 ${turn} 回合`}（${name}）：${sentence}`;
      if (used + line.length > budget) return lines.length ? `\n【相关旧事】（早先的剧情里和眼下有关的句子）\n${lines.join("\n")}` : "";
      seen.add(sentence);
      lines.push(line);
      used += line.length;
    }
  }
  return lines.length ? `\n【相关旧事】（早先的剧情里和眼下有关的句子）\n${lines.join("\n")}` : "";
}
