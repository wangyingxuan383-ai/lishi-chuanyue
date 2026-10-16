// What the engine needs to know about a world's era, whether or not an era
// pack exists. Free-form worlds get their date label and currency from the
// opening; era packs add a prompt excerpt and a list of anachronisms.
import { ERAS } from "../content/eras";
import type { Currency } from "./money";
import type { WorldState } from "./types";

export interface EraContext {
  packId: string | null;
  title: string;
  startLabel: string;
  startHour: number;
  currency: Currency;
  excerpt: string | null;
  taboos: string[];
}

/** Used when neither an era pack nor the opening defined a currency. */
export const GENERIC_CURRENCY: Currency = { units: [{ name: "", value: 1 }] };

export function eraPack(id: string | null | undefined) {
  return ERAS.find((e) => e.id === id) ?? null;
}

export function eraContext(eraId: string | null, state?: WorldState | null): EraContext {
  const pack = eraPack(eraId);
  const stateCurrency = state?.era.currency?.units?.length ? (state.era.currency as Currency) : null;
  return {
    packId: pack?.id ?? null,
    title: pack?.title ?? state?.time.start ?? "自定时代",
    startLabel: state?.time.start || pack?.startLabel || "",
    startHour: state?.time.startHour ?? pack?.startHour ?? 8,
    currency: stateCurrency ?? pack?.currency ?? GENERIC_CURRENCY,
    excerpt: pack?.promptExcerpt ?? null,
    taboos: pack?.taboos ?? [],
  };
}
