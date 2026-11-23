// Character appearance & co-occurrence atlas (R35-T004).
// Scans non-interrupted nodes along the active story path to compute each
// character's debut/latest turn & date, chapter appearances, and top co-occurring
// companions without calling an LLM.
import { huimu } from "./book";
import type { GameClock } from "./calendar/clock";
import { worldClock } from "./era";
import { dateText } from "./life";
import type { TurnRecord } from "./state/apply";
import { matchName } from "./state/names";
import type { Attitude, Chapter, Person, StoryNode, WorldState } from "./types";

export interface CharacterCoOccurrence {
  id: string;
  name: string;
  count: number;
}

export interface CharacterEntry {
  id: string;
  person: Person;
  name: string;
  aliases: string[];
  role: string;
  attitude: Attitude;
  alive: boolean;
  firstNodeId: string | null;
  firstTurn: number | null;
  firstDate: string | null;
  firstChapterTitle: string | null;
  lastNodeId: string | null;
  lastTurn: number | null;
  lastDate: string | null;
  appearances: number;
  chapterIndices: number[];
  coOccurs: CharacterCoOccurrence[];
}

export interface CharacterAtlasInput {
  state: WorldState;
  path: StoryNode[];
  chapters?: Chapter[];
  clock?: GameClock | null;
  clocks?: Map<string, Pick<WorldState, "time" | "era">> | null;
}

function formatChapterLabel(oneBasedIndex: number, rawTitle: string): string {
  const trimmed = rawTitle.trim();
  if (/^第\s*[零〇一二三四五六七八九十百千万两\d]+\s*回/.test(trimmed)) return trimmed;
  return huimu(oneBasedIndex, trimmed || undefined);
}

function resolveNodeDate(
  node: StoryNode,
  isHeadNode: boolean,
  state: WorldState,
  clock?: GameClock | null,
  clocks?: Map<string, Pick<WorldState, "time" | "era">> | null,
): string | null {
  const snap = clocks?.get(node.id);
  if (snap) {
    const projected = worldClock(state.era.packId, snap);
    const mergedClock: GameClock =
      clock && !snap.era.calendar ? { ...projected, rules: clock.rules } : projected;
    return dateText(mergedClock, snap.time.elapsedMinutes);
  }
  if (clock) {
    if (node.kind === "opening") return dateText(clock, 0);
    if (isHeadNode) return dateText(clock, state.time.elapsedMinutes);
  }
  return null;
}

/** Builds the appearance timeline and top-4 co-occurrence list for every `Person` in `state.people`. */
export function buildCharacterAtlas({
  state,
  path,
  chapters = [],
  clock = null,
  clocks = null,
}: CharacterAtlasInput): CharacterEntry[] {
  const people = state.people;
  if (!people.length) return [];

  // Collect all known names & aliases per person (including historical renames on `path`).
  const searchTermsById = new Map<string, Set<string>>();
  for (const p of people) {
    const set = new Set<string>();
    if (p.name.trim()) set.add(p.name.trim());
    for (const alias of p.aliases) {
      if (alias.trim()) set.add(alias.trim());
    }
    searchTermsById.set(p.id, set);
  }

  for (const node of path) {
    if (node.status === "interrupted") continue;
    const rec = node.record && typeof node.record === "object" ? (node.record as TurnRecord) : null;
    if (!Array.isArray(rec?.people)) continue;
    for (const patch of rec.people) {
      if (!patch || patch.op === "remove" || !patch.id) continue;
      const set = searchTermsById.get(patch.id);
      if (!set) continue;
      if (typeof patch.name === "string" && patch.name.trim()) set.add(patch.name.trim());
      if (Array.isArray(patch.aliases)) {
        for (const a of patch.aliases) {
          if (typeof a === "string" && a.trim()) set.add(a.trim());
        }
      }
    }
  }

  // Map path indices to 1-based chapter indices and titles.
  const pathIndexById = new Map(path.map((n, idx) => [n.id, idx]));
  const nodeChapters = new Map<string, { index: number; title: string }[]>();
  let earliestChapterPathPos = Infinity;

  chapters.forEach((ch, idx) => {
    const start = pathIndexById.get(ch.firstNodeId);
    const end = pathIndexById.get(ch.lastNodeId);
    if (start === undefined || end === undefined || start > end) return;
    earliestChapterPathPos = Math.min(earliestChapterPathPos, start);
    const label = formatChapterLabel(idx + 1, ch.title);
    for (let pos = start; pos <= end; pos++) {
      const nid = path[pos].id;
      const list = nodeChapters.get(nid) ?? [];
      list.push({ index: idx + 1, title: label });
      nodeChapters.set(nid, list);
    }
  });

  interface PersonAccumulator {
    firstNodeId: string | null;
    firstTurn: number | null;
    firstDate: string | null;
    firstChapterTitle: string | null;
    lastNodeId: string | null;
    lastTurn: number | null;
    lastDate: string | null;
    appearances: number;
    chapterSet: Set<number>;
    coCounts: Map<string, number>;
  }

  const accById = new Map<string, PersonAccumulator>();
  for (const p of people) {
    accById.set(p.id, {
      firstNodeId: null,
      firstTurn: null,
      firstDate: null,
      firstChapterTitle: null,
      lastNodeId: null,
      lastTurn: null,
      lastDate: null,
      appearances: 0,
      chapterSet: new Set<number>(),
      coCounts: new Map<string, number>(),
    });
  }

  const headNodeId = path.at(-1)?.id ?? null;
  let turnCounter = 0;

  for (let idx = 0; idx < path.length; idx++) {
    const node = path[idx];
    if (node.status === "interrupted") continue;
    if (node.kind === "turn" || node.kind === "fastforward") {
      turnCounter++;
    }

    const rec = node.record && typeof node.record === "object" ? (node.record as TurnRecord) : null;
    const peoplePatches = Array.isArray(rec?.people)
      ? rec.people.filter((item) => item && item.op !== "remove")
      : [];

    if (node.kind === "edit" && peoplePatches.length === 0) continue;

    const matchedIds = new Set<string>();

    // 1. Structured `record.people` mentions (handles both narrative turns and `edit` people patches).
    for (const patch of peoplePatches) {
      if (patch.id && accById.has(patch.id)) {
        matchedIds.add(patch.id);
        continue;
      }
      if (typeof patch.name === "string" && patch.name.trim()) {
        const target = matchName(people, patch.name.trim(), { partial: false });
        if (target) matchedIds.add(target.id);
      }
    }

    // 2. Narrative & player action text matching on `opening`, `turn`, and `fastforward` nodes.
    if (node.kind !== "edit") {
      const actionPart =
        node.actionMode && node.actionMode !== "direct" && node.actionText
          ? node.actionText
          : "";
      const haystack = `${actionPart}\n${node.narrative}`;
      if (haystack.trim()) {
        for (const p of people) {
          if (matchedIds.has(p.id)) continue;
          const terms = searchTermsById.get(p.id);
          if (!terms) continue;
          for (const term of terms) {
            if (haystack.includes(term)) {
              matchedIds.add(p.id);
              break;
            }
          }
        }
      }
    }

    if (matchedIds.size === 0) continue;

    const currentTurn = node.kind === "opening" ? 0 : turnCounter;
    const nodeDate = resolveNodeDate(node, node.id === headNodeId, state, clock, clocks);
    const chList = nodeChapters.get(node.id) ?? [];
    const primaryChapterTitle =
      chList[0]?.title ??
      (node.kind === "opening" && chapters.length > 0 && idx < earliestChapterPathPos ? "楔子" : null);

    for (const pid of matchedIds) {
      const acc = accById.get(pid)!;
      acc.appearances++;
      if (acc.firstNodeId === null) {
        acc.firstNodeId = node.id;
        acc.firstTurn = currentTurn;
        acc.firstDate = nodeDate;
        acc.firstChapterTitle = primaryChapterTitle;
      }
      acc.lastNodeId = node.id;
      acc.lastTurn = currentTurn;
      acc.lastDate = nodeDate;
      for (const ch of chList) {
        acc.chapterSet.add(ch.index);
      }
    }

    // Co-occurrence across narrative scenes (`opening`, `turn`, `fastforward`).
    if (node.kind !== "edit" && matchedIds.size > 1) {
      const ids = [...matchedIds];
      for (let i = 0; i < ids.length; i++) {
        const aCounts = accById.get(ids[i])!.coCounts;
        for (let j = 0; j < ids.length; j++) {
          if (i === j) continue;
          aCounts.set(ids[j], (aCounts.get(ids[j]) ?? 0) + 1);
        }
      }
    }
  }

  const personOrder = new Map(people.map((p, idx) => [p.id, idx]));
  const personById = new Map(people.map((p) => [p.id, p]));

  return people.map((person) => {
    const acc = accById.get(person.id)!;
    const coOccurs = [...acc.coCounts.entries()]
      .filter(([, count]) => count > 0)
      .sort(
        (a, b) =>
          b[1] - a[1] ||
          (personOrder.get(a[0]) ?? 0) - (personOrder.get(b[0]) ?? 0),
      )
      .slice(0, 4)
      .map(([otherId, count]) => ({
        id: otherId,
        name: personById.get(otherId)?.name ?? "",
        count,
      }));

    return {
      id: person.id,
      person,
      name: person.name,
      aliases: [...person.aliases],
      role: person.role,
      attitude: person.attitude,
      alive: person.alive,
      firstNodeId: acc.firstNodeId,
      firstTurn: acc.firstTurn,
      firstDate: acc.firstDate,
      firstChapterTitle: acc.firstChapterTitle,
      lastNodeId: acc.lastNodeId,
      lastTurn: acc.lastTurn,
      lastDate: acc.lastDate,
      appearances: acc.appearances,
      chapterIndices: [...acc.chapterSet].sort((a, b) => a - b),
      coOccurs,
    };
  });
}
