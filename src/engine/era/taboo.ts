// The era card's "不要出现" line as a local check (R07-T002): after each turn
// the narrative is searched for those words. Hits are shown in developer mode
// and the next turn gets a short reminder of what to say instead. The world's
// own card is the source (D121); entries copied from a built-in pack use the
// pack's match words, so "小时" does not fire inside "小时候".
import type { EraPack } from "../../content/eras/types";
import type { Card } from "../types";

export interface TabooTerm { term: string; entry: string; instead: string | null }
export interface TabooHit { term: string; instead: string | null }

const TABOO_LINE = /^\s*不要出现\s*[：:]\s*(.*)$/;

/** The entries of an era card's "不要出现：" line (a full- or half-width colon), or null when it has none. */
export function tabooLine(content: string | null | undefined): string | null {
  for (const line of (content ?? "").split("\n")) {
    const m = TABOO_LINE.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/** The card text with at most `max` entries on its "不要出现" line: a short reminder, not a rulebook. */
export function shortTabooLine(content: string, max: number): string {
  return content.split("\n").flatMap((line) => {
    const m = TABOO_LINE.exec(line);
    if (!m) return [line];
    const items = m[1].split(/[；;]/).map((s) => s.trim()).filter(Boolean).slice(0, max);
    return items.length ? [`不要出现：${items.join("；")}`] : [];
  }).join("\n");
}

/** Words to look for, from the card's "不要出现：" line. */
export function tabooTerms(eraCard: Card | null, pack: EraPack | null): TabooTerm[] {
  const line = tabooLine(eraCard?.content);
  if (!line) return [];
  const terms: TabooTerm[] = [];
  for (const raw of line.split(/[；;]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const m = entry.match(/^(.*?)[（(](.*)[）)]$/);
    const name = (m ? m[1] : entry).trim();
    const instead = m ? m[2].trim().replace(/^用/, "") : null;
    const fromPack = pack?.taboos.find((t) => t.name === name);
    // A pack entry knows its literal words; a written one is split on 、 and short phrases are kept
    // (a note in brackets after one of them, "算盘（用算筹）、银票", is not part of the word).
    const words = fromPack ? fromPack.match ?? [fromPack.name]
      : name.split("、").map((w) => w.replace(/[（(][^）)]*[）)]/g, "").trim()).filter((w) => w.length >= 2 && w.length <= 6);
    for (const term of words) terms.push({ term, entry: name, instead });
  }
  // A pack's extra watch words, for worlds that started from it.
  for (const w of pack?.watch ?? []) {
    for (const term of w.words) if (!terms.some((t) => t.term === term)) terms.push({ term, entry: w.words.join("、"), instead: w.instead });
  }
  return terms;
}

/** Longer words that contain a term but mean something else (a 火折子 is not a memorial). */
const OTHER_WORDS: Record<string, string[]> = { 折子: ["火折子"], 马灯: ["走马灯"] };

/** Words that count only where a sentence or a line of speech starts: “小的这就去” is a servant, 最小的儿子 is not. */
const AT_START: Record<string, RegExp> = { 小的: /(^|[“”「」『』"'‘’，。！？；：、…—\s])小的/ };

/** The taboo words in a passage, each once. */
export function findTaboos(text: string, terms: TabooTerm[]): TabooHit[] {
  const hits = new Map<string, TabooHit>();
  for (const t of terms) {
    if (hits.has(t.term)) continue;
    const plain = (OTHER_WORDS[t.term] ?? []).reduce((s, w) => s.split(w).join("　"), text);
    if (AT_START[t.term] ? AT_START[t.term].test(plain) : plain.includes(t.term)) hits.set(t.term, { term: t.term, instead: t.instead });
  }
  return [...hits.values()];
}

/** The reminder the next turn gets. */
export function tabooReminder(hits: TabooHit[]): string {
  if (!hits.length) return "";
  return `\n【用词提醒】上一段用了这个时代不该有的说法：${hits.map((h) => `“${h.term}”${h.instead ? `（该用：${h.instead}）` : ""}`).join("、")}。之后不要再用，已经写出的不必解释。`;
}
