import { parseChineseNumber } from "./calendar/duration";

// Era currency: amounts are stored as integers of the smallest unit (e.g. 文)
// and displayed in the era's larger units.

export interface Currency {
  /** Largest first, e.g. [{name:"贯", value:1000}, {name:"文", value:1}]. */
  units: { name: string; value: number }[];
  /** Extra spellings accepted when parsing, e.g. 缗 = 贯, 钱 = 文. */
  aliases?: Record<string, string>;
}

export const TANG_CURRENCY: Currency = {
  units: [{ name: "贯", value: 1000 }, { name: "文", value: 1 }],
  aliases: { 缗: "贯", 钱: "文", 枚: "文", 个: "文" },
};

export function formatMoney(amount: number, currency: Currency): string {
  const sign = amount < 0 ? "−" : "";
  let rest = Math.abs(Math.round(amount));
  const parts: string[] = [];
  for (const unit of currency.units) {
    const n = Math.floor(rest / unit.value);
    rest -= n * unit.value;
    if (n) parts.push(`${n} ${unit.name}`.trim());
  }
  return sign + (parts.length ? parts.join(" ") : `0 ${currency.units[currency.units.length - 1].name}`.trim());
}


/** Parses 30 / "-2文" / "三贯二百文" / "一贯半" into the smallest unit; null if unrecognised. */
export function parseMoney(input: unknown, currency: Currency): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? Math.round(input) : null;
  if (typeof input !== "string") return null;
  let text = input.replace(/\s+/g, "").replace(/[，,]/g, "");
  let sign = 1;
  if (/^[-−－]/.test(text)) { sign = -1; text = text.slice(1); }
  else if (/^[+＋]/.test(text)) text = text.slice(1);
  if (/^\d+$/.test(text)) return sign * Number(text);
  const names = [...currency.units.map((u) => u.name), ...Object.keys(currency.aliases ?? {})];
  // Lazy, so a unit named 两 is not read as the digit two ("三两二百文" = 3 两 + 200 文).
  const pattern = new RegExp(`(\\d+(?:\\.\\d+)?|[零〇一二两俩三四五六七八九十百千]+?)(${names.join("|")})(半)?`, "g");
  let total = 0;
  let matched = false;
  for (const [, amountText, unitName, half] of text.matchAll(pattern)) {
    const amount = parseChineseNumber(amountText);
    const canonical = currency.aliases?.[unitName] ?? unitName;
    const unit = currency.units.find((u) => u.name === canonical);
    if (amount === null || !unit) continue;
    total += (amount + (half ? 0.5 : 0)) * unit.value;
    matched = true;
  }
  return matched ? sign * Math.round(total) : null;
}
