import type { Currency } from "../../engine/money";

export interface EraIdentity {
  title: string;
  detail: string; // situation including the seed of the opening crisis
  money: number;
}

/** Minimal era data used in R02; the full era pack format comes in R03. */
export interface EraDraft {
  id: string;
  title: string;
  blurb: string;
  startLabel: string;
  startHour: number;
  currency: Currency;
  startMoney: number;
  promptExcerpt: string;
  taboos: string[];
  identities: EraIdentity[];
  names: { surnames: string[]; male: string[]; female: string[] };
}
