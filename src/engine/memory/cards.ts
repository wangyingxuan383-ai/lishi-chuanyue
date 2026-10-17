// The 设定集 in context (PLAN §4.14, §5.3 layers 2 and 6, D121): the era
// card goes with every turn; places and the other cards come in when their
// name or an alias appears in recent text, most recently mentioned first,
// within a character budget.
import type { Card, Place, WorldState } from "../types";

/** Characters of the era card sent to the model (≈1k tokens for Chinese). */
export const ERA_CARD_LIMIT = 1000;
/** Characters of triggered cards per turn. */
export const CARD_BUDGET = 1500;

export function eraCardOf(state: Pick<WorldState, "cards">): Card | null {
  return state.cards.find((c) => c.kind === "时代") ?? null;
}

interface Entry {
  terms: string[];
  line: string;
}

const also = (names: string[]) => (names.length ? `（又称${names.join("、")}）` : "");

export function cardLine(card: Card): string {
  return `【${card.kind}】${card.name}${also(card.keys)}：${card.content}`;
}

function placeLine(place: Place): string {
  return `【地点】${place.name}${also(place.aliases ?? [])}：${place.description}`;
}

/** Terms of two or more characters; single characters would match almost anything. */
const termsOf = (name: string, others: string[]) => [...new Set([name, ...others].map((t) => t.trim()).filter((t) => t.length >= 2))];

/**
 * The latest position where one of the terms appears in the text, ignoring
 * a short term that is only part of a longer term of another entry there
 * ("长安" inside "长安县").
 */
function lastMention(text: string, terms: string[], longer: string[]): number {
  let best = -1;
  for (const term of terms) {
    let at = text.lastIndexOf(term);
    while (at > best) {
      if (!shadowed(text, at, term, longer)) { best = at; break; }
      if (at === 0) break;
      at = text.lastIndexOf(term, at - 1);
    }
  }
  return best;
}

function shadowed(text: string, at: number, term: string, longer: string[]): boolean {
  return longer.some((other) => {
    if (other.length <= term.length) return false;
    for (let offset = other.indexOf(term); offset >= 0; offset = other.indexOf(term, offset + 1)) {
      if (at - offset >= 0 && text.startsWith(other, at - offset)) return true;
    }
    return false;
  });
}

/**
 * Lines for the triggered cards: the current place first (when it has a
 * description), then places and cards mentioned in `recent`, newest mention
 * first, as long as they fit the budget.
 */
export function activeCardLines(state: WorldState, recent: string, budget = CARD_BUDGET): string[] {
  const entries: (Entry & { id: string })[] = [
    ...state.places.filter((p) => p.description.trim()).map((p) => ({ id: p.id, terms: termsOf(p.name, p.aliases ?? []), line: placeLine(p) })),
    ...state.cards.filter((c) => c.kind !== "时代" && c.content.trim()).map((c) => ({ id: c.id, terms: termsOf(c.name, c.keys), line: cardLine(c) })),
  ];
  const ordered: Entry[] = [];
  const here = entries.find((e) => e.id === state.placeId);
  if (here) ordered.push(here);
  const mentioned = entries
    .filter((e) => e !== here)
    .map((e) => ({ e, at: lastMention(recent, e.terms, entries.filter((x) => x !== e).flatMap((x) => x.terms)) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => b.at - a.at);
  ordered.push(...mentioned.map((m) => m.e));
  const lines: string[] = [];
  let used = 0;
  for (const entry of ordered) {
    if (used + entry.line.length > budget) continue;
    lines.push(entry.line);
    used += entry.line.length;
  }
  return lines;
}
