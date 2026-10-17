// Matching what the player wrote against the 设定集 and older passages when
// the exact name is not there (R04-T005, after eval H): "刻着鹰隼的乌木包银腰牌"
// should find the card 乌木包银鹰牌, "藏进皮甲的那两封信" the sentence where the
// letters went into the armour. Character pairs of the Han, letter and digit
// runs, weighted by how rare they are in the story; no model call.

const RUN = /[\p{Script=Han}A-Za-z0-9]{2,}/gu;

/** Distinct character pairs of a text's Han characters, letters and digits. */
export function pairsOf(text: string): string[] {
  const out = new Set<string>();
  for (const run of text.match(RUN) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

/**
 * How well `text` describes a name it does not spell out: the share of the
 * name's character pairs found in the text, when that is at least two pairs
 * and at least half of them; otherwise 0.
 */
export function describes(text: string, name: string): number {
  const pairs = pairsOf(name);
  if (pairs.length < 2) return 0;
  const shared = pairs.filter((p) => text.includes(p)).length;
  return shared >= 2 && shared * 2 >= pairs.length ? shared / pairs.length : 0;
}

/** The parts of what the player wrote, each matched on its own. */
export function clausesOf(query: string): string[] {
  return query.split(/[。！？；?!;\n]+/).map((s) => s.trim()).filter((s) => pairsOf(s).length >= 2);
}

/** Question words, and pairs of nothing but function characters, say nothing about what is meant. */
const QUESTION = /[什么谁哪何吗呢]/;
const FUNCTION = /^[的了是在着和与把被也都就还又这那之其而以于所为从对向给让将得地个们有没不]+$/;

/**
 * How rare each of the query's meaningful pairs is among `docs` (the story's
 * turns), scaled so that a pair found in a single turn weighs 1 however long
 * the story is.
 */
export function pairWeights(query: string, docs: string[]): Map<string, number> {
  return pairIndex(query, docs).weights;
}

/** pairWeights, and which of the pairs each doc holds (so callers need not search the docs again). */
export function pairIndex(query: string, docs: string[]): { weights: Map<string, number>; held: Set<string>[] } {
  const pairs = pairsOf(query).filter((p) => !QUESTION.test(p) && !FUNCTION.test(p));
  const held = docs.map(() => new Set<string>());
  if (!docs.length) return { weights: new Map(), held };
  const rarest = Math.log((docs.length + 1) / 1.5);
  const weights = new Map(pairs.map((pair) => {
    let df = 0;
    docs.forEach((d, i) => { if (d.includes(pair)) { df++; held[i].add(pair); } });
    return [pair, Math.log((docs.length + 1) / (df + 0.5)) / rarest] as const;
  }));
  return { weights, held };
}

export interface Passage {
  text: string;
  /** Anything the caller needs back with a match. */
  at: number;
}

/**
 * The passages that share the most rare character pairs with the query, best
 * first. A passage needs at least two shared pairs and `minScore` in weight
 * (1.5: about two pairs found nowhere else); long passages count for a little
 * less (as in BM25). Each pick makes the pairs it covered count for less, so
 * the next one adds something new.
 */
export function bestMatches(query: string, passages: Passage[], weights: Map<string, number>, limit: number, minScore = 1.5, avgLength?: number): Passage[] {
  const pairs = pairsOf(query).filter((p) => weights.has(p));
  if (pairs.length < 2 || !passages.length) return [];
  // A caller scoring only part of a pool passes the whole pool's average, so the scores stay the same.
  const avg = avgLength ?? passages.reduce((n, p) => n + p.text.length, 0) / passages.length;
  const candidates = passages
    .map((p) => ({ p, h: pairs.filter((pair) => p.text.includes(pair)), norm: 2.2 / (1 + 1.2 * (0.7 + (0.3 * p.text.length) / avg)) }))
    .filter(({ h }) => h.length >= 2 && h.reduce((sum, pair) => sum + weights.get(pair)!, 0) >= minScore);
  const covered = new Set<string>();
  const score = (c: (typeof candidates)[number]) => c.norm * c.h.reduce((sum, pair) => sum + weights.get(pair)! * (covered.has(pair) ? 0.3 : 1), 0);
  const picked: Passage[] = [];
  while (picked.length < limit && candidates.length) {
    let best = 0;
    for (let i = 1; i < candidates.length; i++) if (score(candidates[i]) > score(candidates[best])) best = i;
    if (score(candidates[best]) < minScore * 0.6) break;
    const [chosen] = candidates.splice(best, 1);
    picked.push(chosen.p);
    for (const pair of chosen.h) covered.add(pair);
  }
  return picked;
}

/** At most `max` characters of a sentence, around the part that matched the query. */
export function excerpt(sentence: string, query: string, max: number): string {
  if (sentence.length <= max) return sentence;
  const at = pairsOf(query).map((p) => sentence.indexOf(p)).filter((i) => i >= 0);
  const first = at.length ? Math.min(...at) : 0;
  const last = at.length ? Math.max(...at) + 2 : max;
  const start = Math.max(0, Math.min(first - 12, Math.round((first + last) / 2 - max / 2), sentence.length - max));
  const end = Math.min(sentence.length, start + max);
  return `${start > 0 ? "…" : ""}${sentence.slice(start, end)}${end < sentence.length ? "…" : ""}`;
}
