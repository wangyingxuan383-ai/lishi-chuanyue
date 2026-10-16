import type { Currency } from "../../engine/money";

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
}
