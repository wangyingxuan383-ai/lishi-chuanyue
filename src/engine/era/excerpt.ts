// The 【时代资料】 block of the system prompt (PLAN §5.3, layer 2): what the
// narrator should know about the pack's period in the current month. It is
// kept within EXCERPT_LIMIT characters by dropping the least important lines
// first, down to a few of each; the situation, currency, style and taboos are
// never dropped.
import type { EraEvent, EraPack } from "../../content/eras/types";
import { LUNAR_MONTHS, dateFromCe, monthIndex, yearLabel, type CalendarRules, type GameDate } from "../calendar/date";

/** Roughly 1k tokens for Chinese text. */
export const EXCERPT_LIMIT = 1000;

interface Section {
  head: string;
  items: string[];
  /** Items that are never trimmed. */
  keep: number;
}

/** Trimmed first to last when the excerpt is too long. */
const TRIM_ORDER = ["地点", "风物", "近来大事", "物价", "称谓"];

/** "天宝六载正月" / "公元前45年10月" */
export function eventLabel(event: Pick<EraEvent, "ceYear" | "month">, rules: CalendarRules): string {
  const date = dateFromCe(event.ceYear, event.month, 1, rules);
  if (!date) return event.ceYear < 0 ? `公元前${-event.ceYear}年` : `${event.ceYear}年`;
  return date.lunar ? `${yearLabel(date, rules)}${LUNAR_MONTHS[date.month - 1]}` : `${yearLabel(date, rules)}${date.month}月`;
}

/** Events in the year up to and including the given month, newest first. */
export function recentEvents(pack: EraPack, date: GameDate | null): EraEvent[] {
  const ref = date?.ceYear != null ? date : pack.start.date;
  if (ref.ceYear == null) return [];
  const at = monthIndex(ref.ceYear, ref.month);
  return pack.timeline.filter((e) => {
    const i = monthIndex(e.ceYear, e.month);
    return i <= at && i > at - 12;
  }).reverse();
}

export function eraExcerpt(pack: EraPack, date: GameDate | null): string {
  const month = date?.month ?? pack.start.date.month;
  const seasonal = pack.daily.filter((d) => d.months?.includes(month)).map((d) => d.text);
  const general = pack.daily.filter((d) => !d.months).map((d) => d.text);
  const sections: Section[] = [
    { head: "时局", items: [pack.situation], keep: 1 },
    { head: "货币", items: [pack.currencyNote], keep: 1 },
    { head: "物价", items: pack.prices.map((p) => `${p.item}${p.price}`), keep: 4 },
    { head: "称谓", items: pack.address.map((a) => `${a.term}（${a.usage}）`), keep: 5 },
    { head: "风物", items: [...seasonal, ...general], keep: 3 },
    { head: "近来大事", items: recentEvents(pack, date).map((e) => `${eventLabel(e, pack.calendar)}，${e.title}`), keep: 1 },
    { head: "地点", items: pack.places.map((p) => `${p.name}（${p.description}）`), keep: 3 },
    { head: "文风", items: [pack.style], keep: 1 },
    { head: "不要出现", items: pack.taboos.map((t) => (t.instead ? `${t.name}（${t.instead}）` : t.name)), keep: pack.taboos.length },
  ];
  const render = () => [
    `【时代资料】${pack.title}（与【故事设定】冲突时以故事设定为准；拿不准的细节写得模糊些）`,
    ...sections.filter((s) => s.items.length).map((s) => `- ${s.head}：${s.items.join("；")}`),
  ].join("\n");
  let text = render();
  while (text.length > EXCERPT_LIMIT) {
    const section = TRIM_ORDER.map((head) => sections.find((s) => s.head === head)!).find((s) => s.items.length > s.keep);
    if (!section) break;
    section.items.pop();
    text = render();
  }
  return text;
}
