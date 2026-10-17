// Turns a built-in pack (D120) into the cards a new world starts with (D121):
// one static era card for the 设定集, kept within ERA_CARD_LIMIT characters
// by dropping the least important lines first, plus a card for each place.
// After that the world's own copy rules; the pack is never read again.
import type { EraEvent, EraPack } from "../../content/eras/types";
import { LUNAR_MONTHS, dateFromCe, monthIndex, yearLabel, type CalendarRules } from "../calendar/date";
import { newId } from "../db/repo";
import { ERA_CARD_LIMIT } from "../memory/cards";
import type { Card, Place } from "../types";

interface Section {
  head: string;
  items: string[];
  /** Items that are never dropped. */
  keep: number;
}

/** Dropped first to last when the card is too long. */
const TRIM_ORDER = ["日常", "节令", "近来大事", "物价", "称谓"];

/** "天宝六载正月" / "公元前45年10月" */
export function eventLabel(event: Pick<EraEvent, "ceYear" | "month">, rules: CalendarRules): string {
  const date = dateFromCe(event.ceYear, event.month, 1, rules);
  if (!date) return event.ceYear < 0 ? `公元前${-event.ceYear}年` : `${event.ceYear}年`;
  return date.lunar ? `${yearLabel(date, rules)}${LUNAR_MONTHS[date.month - 1]}` : `${yearLabel(date, rules)}${date.month}月`;
}

/** Events in the year up to and including the start month, newest first. */
export function recentEvents(pack: EraPack): EraEvent[] {
  const { ceYear, month } = pack.start.date;
  if (ceYear == null) return [];
  const at = monthIndex(ceYear, month);
  return pack.timeline.filter((e) => {
    const i = monthIndex(e.ceYear, e.month);
    return i <= at && i > at - 12;
  }).reverse();
}

const monthName = (month: number, lunar: boolean) => (lunar ? LUNAR_MONTHS[month - 1] : `${month}月`);

/** Seasonal details labelled with their months, starting from the opening month. */
function seasonal(pack: EraPack): string[] {
  const start = pack.start.date.month;
  const distance = (months: number[]) => Math.min(...months.map((m) => (m - start + 12) % 12));
  return pack.daily
    .filter((d) => d.months?.length)
    .sort((a, b) => distance(a.months!) - distance(b.months!))
    .map((d) => `${d.months!.map((m) => monthName(m, pack.calendar.lunar)).join("、")}：${d.text}`);
}

/** The era card's text: one line per topic, "不要出现" last (R07 reads that line). */
export function eraCardText(pack: EraPack): string {
  const sections: Section[] = [
    { head: "时局", items: [pack.situation], keep: 1 },
    { head: "货币", items: [pack.currencyNote], keep: 1 },
    { head: "物价", items: pack.prices.map((p) => `${p.item}${p.price}`), keep: 4 },
    { head: "称谓", items: pack.address.map((a) => `${a.term}（${a.usage}）`), keep: 5 },
    { head: "日常", items: pack.daily.filter((d) => !d.months?.length).map((d) => d.text), keep: 3 },
    { head: "节令", items: seasonal(pack), keep: 3 },
    { head: "近来大事", items: recentEvents(pack).map((e) => `${eventLabel(e, pack.calendar)}，${e.title}`), keep: 1 },
    { head: "文风", items: [pack.style], keep: 1 },
    { head: "不要出现", items: pack.taboos.map((t) => (t.instead ? `${t.name}（${t.instead}）` : t.name)), keep: pack.taboos.length },
  ];
  const render = () => sections.filter((s) => s.items.length).map((s) => `${s.head}：${s.items.join("；")}`).join("\n");
  let text = render();
  while (text.length > ERA_CARD_LIMIT) {
    const section = TRIM_ORDER.map((head) => sections.find((s) => s.head === head)!).find((s) => s.items.length > s.keep);
    if (!section) break;
    section.items.pop();
    text = render();
  }
  return text;
}

/** The cards a world starting from this pack gets: the era card and one card per place. */
export function packCards(pack: EraPack): { cards: Card[]; places: Place[] } {
  return {
    cards: [{ id: newId(), kind: "时代", name: pack.title, keys: [], content: eraCardText(pack), source: "卡组" }],
    places: pack.places.map((p) => ({ id: newId(), name: p.name, aliases: [], description: p.description })),
  };
}
