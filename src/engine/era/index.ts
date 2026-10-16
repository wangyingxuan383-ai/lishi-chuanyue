// What the engine needs to know about a world's era, whether or not an era
// pack exists. Free-form worlds get their start date and currency from the
// opening; era packs add a calendar of era names, a prompt excerpt and a list
// of anachronisms. Field guide: docs/contracts/ERA_PACK.md.
import { ERAS } from "../../content/eras";
import type { EraPack, Taboo } from "../../content/eras/types";
import { nowOf, type GameClock } from "../calendar/clock";
import { formatDate, readDate, type CalendarRules, type GameDate } from "../calendar/date";
import type { Currency } from "../money";
import type { WorldState } from "../types";
import { eraExcerpt } from "./excerpt";

export interface EraContext {
  packId: string | null;
  title: string;
  /** Minute 0 of the world and the calendar rules for counting from it. */
  clock: GameClock;
  currency: Currency;
  /** The pack's 【时代资料】 for the current month; null without a pack. */
  excerpt: string | null;
  taboos: Taboo[];
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

export function eraContext(eraId: string | null, state?: WorldState | null): EraContext {
  const pack = eraPack(eraId);
  const rules: CalendarRules = pack?.calendar ?? {};
  const clock: GameClock = {
    date: state ? startDate(state, rules) : pack?.start.date ?? null,
    hour: state?.time.startHour ?? pack?.start.hour ?? 8,
    label: state ? state.time.start : pack ? formatDate(pack.start.date, rules) : "",
    rules,
  };
  const stateCurrency = state?.era.currency?.units?.length ? (state.era.currency as Currency) : null;
  const today = state ? nowOf(clock, state.time.elapsedMinutes).date : clock.date;
  return {
    packId: pack?.id ?? null,
    title: pack?.title ?? (state?.time.start || "自定时代"),
    clock,
    currency: stateCurrency ?? pack?.currency ?? GENERIC_CURRENCY,
    excerpt: pack ? eraExcerpt(pack, today) : null,
    taboos: pack?.taboos ?? [],
  };
}
