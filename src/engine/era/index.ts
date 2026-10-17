// What the engine needs to know about a world's era. The world's own state
// rules (D121): its era card, calendar and currency were copied from a
// built-in pack or set by the opening. Saves from before D121 fall back to
// their pack. Field guide: docs/contracts/ERA_PACK.md.
import { ERAS } from "../../content/eras";
import type { EraPack } from "../../content/eras/types";
import type { GameClock } from "../calendar/clock";
import { formatDate, readDate, type CalendarRules, type GameDate } from "../calendar/date";
import { eraCardOf } from "../memory/cards";
import type { Currency } from "../money";
import type { Card, WorldState } from "../types";
import { eraCardText } from "./card";

export interface EraContext {
  packId: string | null;
  title: string;
  /** Minute 0 of the world and the calendar rules for counting from it. */
  clock: GameClock;
  currency: Currency;
  /** The era card sent with every turn; null when the world has none. */
  eraCard: Card | null;
}

/** Used when neither an era pack nor the opening defined a currency. */
export const GENERIC_CURRENCY: Currency = { units: [{ name: "", value: 1 }] };

export function eraPack(id: string | null | undefined): EraPack | null {
  return ERAS.find((e) => e.id === id) ?? null;
}

/** The start date of a world; old saves only have the label. */
export function startDate(state: WorldState, rules: CalendarRules): GameDate | null {
  return state.time.date !== undefined ? state.time.date : readDate(state.time.start, rules);
}

/** Old saves have no era card of their own; theirs comes from the pack, unsaved. */
function eraCard(state: WorldState | null | undefined, pack: EraPack | null): Card | null {
  const own = state ? eraCardOf(state) : null;
  if (own || (state && state.version >= 2) || !pack) return own;
  return { id: `pack:${pack.id}`, kind: "时代", name: pack.title, keys: [], content: eraCardText(pack), source: "卡组" };
}

export function eraContext(eraId: string | null, state?: WorldState | null): EraContext {
  const pack = eraPack(eraId);
  const rules: CalendarRules = state?.era.calendar ?? pack?.calendar ?? {};
  const clock: GameClock = {
    date: state ? startDate(state, rules) : pack?.start.date ?? null,
    hour: state?.time.startHour ?? pack?.start.hour ?? 8,
    label: state ? state.time.start : pack ? formatDate(pack.start.date, rules) : "",
    rules,
  };
  const stateCurrency = state?.era.currency?.units?.length ? (state.era.currency as Currency) : null;
  return {
    packId: pack?.id ?? null,
    title: pack?.title ?? (state?.time.start || "自定时代"),
    clock,
    currency: stateCurrency ?? pack?.currency ?? GENERIC_CURRENCY,
    eraCard: eraCard(state, pack),
  };
}
