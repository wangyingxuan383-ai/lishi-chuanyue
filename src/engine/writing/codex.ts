import type { TurnRecord } from "../state/apply";
import type { CardKind, WorldState } from "../types";

export type CodexKind = "地点" | Exclude<CardKind, "时代">;
export interface CodexSelection { id: string; kind: CodexKind }
export const selectionKey = (item: CodexSelection) => `${item.kind}:${item.id}`;
/** Build one edit node, excluding the current place and the world's era card. */
export function deletionPatch(state: WorldState, selection: CodexSelection[]): TurnRecord {
  const keys = new Set(selection.map(selectionKey));
  const places = state.places.filter((p) => p.id !== state.placeId && keys.has(selectionKey({ id: p.id, kind: "地点" })));
  const cards = state.cards.filter((c) => c.kind !== "时代" && keys.has(selectionKey({ id: c.id, kind: c.kind as CodexKind })));
  return { places: places.map((p) => ({ op: "remove", id: p.id })), cards: cards.map((c) => ({ op: "remove", id: c.id })) };
}
