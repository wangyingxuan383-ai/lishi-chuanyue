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

/**
 * Problems with a list of currency units (largest first, the smallest worth 1,
 * each a whole multiple of the next), with the index of the unit concerned;
 * empty when the units are usable. Used for era packs and player edits.
 */
export function currencyIssues(units: unknown[]): { index: number | null; message: string }[] {
  const issues: { index: number | null; message: string }[] = [];
  if (!units.length) return [{ index: null, message: "缺少货币单位" }];
  const seen = new Set<string>();
  const unit = (u: unknown) => (u && typeof u === "object" ? (u as { name?: unknown; value?: unknown }) : {});
  units.forEach((raw, index) => {
    const u = unit(raw);
    const name = typeof u.name === "string" ? u.name.trim() : "";
    if (!name) return issues.push({ index, message: "货币单位缺少名字" });
    if (seen.has(name)) issues.push({ index, message: `单位“${name}”重复` });
    seen.add(name);
    if (!Number.isInteger(u.value) || (u.value as number) < 1) return issues.push({ index, message: `“${name}”缺少换算（value 要是正整数，以最小单位计）` });
    const value = u.value as number;
    const next = unit(units[index + 1]);
    if (Number.isInteger(next.value) && (next.value as number) >= 1) {
      if ((next.value as number) >= value) issues.push({ index, message: "单位要从大到小排列" });
      else if (value % (next.value as number) !== 0) issues.push({ index, message: `“${name}”不是“${String(next.name)}”的整数倍` });
    }
    if (index === units.length - 1 && value !== 1) issues.push({ index, message: "最小单位的 value 要是 1" });
  });
  return issues;
}
