// Game calendar (D119). Chinese settings use a simplified lunisolar year —
// twelve months alternating 30/29 days, no leap months — and western settings
// use Gregorian month lengths. Era names follow the era pack's table (eras may
// begin mid-year, like 至德 in the seventh month of 756); an era that is not in
// the table keeps counting. There is no year 0 between BC and AD. Ages follow
// the Chinese custom of growing a year at each New Year (虚岁).
import { parseChineseNumber } from "./duration";

export interface GameDate {
  /** 年号 such as "天宝", or "公元" / "公元前" for western settings. */
  era: string;
  year: number;
  month: number;
  day: number;
  /** CE year, negative for BC (there is no year 0); null when unknown. */
  ceYear: number | null;
  lunar: boolean;
}

export interface EraName {
  name: string;
  startCe: number;
  /** Month the era began (default 正月); the switch happens at the start of that month. */
  startMonth?: number;
  /** Year number of startCe within this era, when counting did not restart. */
  firstYear?: number;
  /** "载" for 天宝; default "年". */
  yearWord?: string;
}

export interface CalendarRules {
  eras?: EraName[];
  yearWord?: string;
  /** Lunisolar months (Chinese settings); inferred from the era name when absent. */
  lunar?: boolean;
}

export const LUNAR_MONTHS = ["正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月"];
/** The principal solar term (中气) that falls in each lunar month. */
const PRINCIPAL_TERMS = ["雨水", "春分", "谷雨", "小满", "夏至", "大暑", "处暑", "秋分", "霜降", "小雪", "冬至", "大寒"];
const WESTERN_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const STEMS = "甲乙丙丁戊己庚辛壬癸";
const BRANCHES = "子丑寅卯辰巳午未申酉戌亥";

export function cnNumber(n: number): string {
  if (n < 10) return DIGITS[n];
  if (n < 20) return `十${n % 10 ? DIGITS[n % 10] : ""}`;
  if (n < 100) return `${DIGITS[Math.floor(n / 10)]}十${n % 10 ? DIGITS[n % 10] : ""}`;
  if (n < 1000) {
    const rest = n % 100;
    return `${DIGITS[Math.floor(n / 100)]}百${rest === 0 ? "" : rest < 10 ? `零${DIGITS[rest]}` : rest < 20 ? `一${cnNumber(rest)}` : cnNumber(rest)}`;
  }
  return String(n);
}

export function cnDay(day: number): string {
  if (day <= 10) return `初${day === 10 ? "十" : DIGITS[day]}`;
  if (day < 20) return `十${DIGITS[day - 10]}`;
  if (day === 20) return "二十";
  if (day < 30) return `廿${DIGITS[day - 20]}`;
  return "三十";
}

export function monthDays(date: Pick<GameDate, "lunar" | "month">): number {
  return date.lunar ? (date.month % 2 === 1 ? 30 : 29) : WESTERN_DAYS[date.month - 1];
}

// Astronomical years have a year 0 (1 BC = 0), which makes arithmetic simple.
const toAstro = (ce: number) => (ce < 0 ? ce + 1 : ce);
const fromAstro = (a: number) => (a <= 0 ? a - 1 : a);

/** Years from a to b with no year 0 between BC and AD. */
function yearsBetween(a: number, b: number): number {
  return toAstro(b) - toAstro(a);
}

/** Comparable month index for ordering dates: astronomical year * 12 + month. */
export function monthIndex(ceYear: number, month: number): number {
  return toAstro(ceYear) * 12 + (month - 1);
}

/** The era in force in a given month, from a table sorted by start. */
export function eraAt(ceYear: number, month: number, eras: EraName[]): EraName | null {
  let found: EraName | null = null;
  const at = monthIndex(ceYear, month);
  for (const era of eras) if (monthIndex(era.startCe, era.startMonth ?? 1) <= at) found = era;
  return found;
}

/** CE year of the nth year of an era, from the table or the western era names. */
export function ceYearOf(era: string, year: number, rules?: CalendarRules): number | null {
  const entry = rules?.eras?.find((e) => e.name === era);
  if (entry) return fromAstro(toAstro(entry.startCe) + year - (entry.firstYear ?? 1));
  if (era === "公元") return year;
  if (era === "公元前") return -year;
  return null;
}

/** The date for a CE year and month: from the era table, or 公元 / 公元前 when not lunar. */
export function dateFromCe(ceYear: number, month: number, day: number, rules: CalendarRules): GameDate | null {
  if (rules.lunar === false) return { era: ceYear < 0 ? "公元前" : "公元", year: Math.abs(ceYear), month, day, ceYear, lunar: false };
  const era = rules.eras ? eraAt(ceYear, month, rules.eras) : null;
  if (!era) return null;
  return { era: era.name, year: (era.firstYear ?? 1) + yearsBetween(era.startCe, ceYear), month, day, ceYear, lunar: true };
}

/** Applies the era table when the date's era is one of its entries. */
function withEra(date: GameDate, rules?: CalendarRules): GameDate {
  if (date.ceYear == null || !rules?.eras?.some((e) => e.name === date.era)) return date;
  const era = eraAt(date.ceYear, date.month, rules.eras);
  return era ? { ...date, era: era.name, year: (era.firstYear ?? 1) + yearsBetween(era.startCe, date.ceYear) } : date;
}

function nextYear(date: GameDate): GameDate {
  const ceYear = date.ceYear == null ? null : fromAstro(toAstro(date.ceYear) + 1);
  const base = { ...date, ceYear, month: 1, day: 1 };
  if (date.era === "公元前") return date.year <= 1 ? { ...base, era: "公元", year: 1 } : { ...base, year: date.year - 1 };
  return { ...base, year: date.year + 1 };
}

/** Adds whole days; also reports how many New Years were crossed. */
export function addDays(date: GameDate, days: number, rules?: CalendarRules): { date: GameDate; newYears: number } {
  let d: GameDate = { ...date };
  let left = Math.max(0, Math.floor(days));
  let newYears = 0;
  while (left > 0) {
    const remaining = monthDays(d) - d.day;
    if (left <= remaining) {
      d = { ...d, day: d.day + left };
      break;
    }
    left -= Math.max(0, remaining) + 1;
    if (d.month >= 12) {
      d = nextYear(d);
      newYears++;
    } else d = { ...d, month: d.month + 1, day: 1 };
    d = withEra(d, rules);
  }
  return { date: d, newYears };
}

export function yearLabel(date: GameDate, rules?: CalendarRules): string {
  if (!date.lunar) return `${date.era}${date.year}年`;
  const word = rules?.eras?.find((e) => e.name === date.era)?.yearWord ?? rules?.yearWord ?? "年";
  return `${date.era}${date.year === 1 ? "元" : cnNumber(date.year)}${word}`;
}

export function monthDayLabel(date: GameDate): string {
  return date.lunar ? `${LUNAR_MONTHS[date.month - 1]}${cnDay(date.day)}` : `${date.month}月${date.day}日`;
}

/** "天宝九载 十月" / "公元1665年 4月": month precision, for timeline events. */
export function monthLabel(date: GameDate, rules?: CalendarRules): string {
  return `${yearLabel(date, rules)} ${date.lunar ? LUNAR_MONTHS[date.month - 1] : `${date.month}月`}`;
}

/** Days in the months before `month` of one year (the simplified calendar has no leap months or days). */
function daysBeforeMonth(month: number, lunar: boolean): number {
  let days = 0;
  for (let m = 1; m < month; m++) days += monthDays({ lunar, month: m });
  return days;
}

/**
 * Days from `a` to `b` (negative when `b` is earlier). Needs CE years, or the
 * same era name when the world has no CE years; null otherwise.
 */
export function daysBetween(a: GameDate, b: GameDate): number | null {
  const years = a.ceYear != null && b.ceYear != null ? yearsBetween(a.ceYear, b.ceYear) : a.era === b.era ? b.year - a.year : null;
  if (years === null) return null;
  const yearDays = daysBeforeMonth(13, a.lunar);
  return years * yearDays + daysBeforeMonth(b.month, a.lunar) + b.day - (daysBeforeMonth(a.month, a.lunar) + a.day);
}

/** "天宝七载 冬月十七" / "公元前44年 3月14日" */
export function formatDate(date: GameDate, rules?: CalendarRules): string {
  return `${yearLabel(date, rules)} ${monthDayLabel(date)}`;
}

export function ganzhi(ceYear: number): string {
  const index = (((toAstro(ceYear) - 4) % 60) + 60) % 60;
  return STEMS[index % 10] + BRANCHES[index % 12];
}

export function season(date: GameDate): string {
  if (date.lunar) return "春夏秋冬"[Math.floor((date.month - 1) / 3)];
  return ["冬", "冬", "春", "春", "春", "夏", "夏", "夏", "秋", "秋", "秋", "冬"][date.month - 1];
}

/** "仲冬 · 冬至之月" for lunar dates, the plain season otherwise. */
export function seasonDetail(date: GameDate): string {
  if (!date.lunar) return season(date);
  return `${"孟仲季"[(date.month - 1) % 3]}${season(date)} · ${PRINCIPAL_TERMS[date.month - 1]}之月`;
}

const inferLunar = (era: string, rules?: CalendarRules) => rules?.lunar ?? (!/^公元/.test(era) && /[一-鿿]/.test(era));

/** Accepts whatever the model wrote for the opening date; null when unusable. */
export function coerceDate(raw: unknown, rules?: CalendarRules): GameDate | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const era = typeof v.era === "string" ? v.era.trim() : "";
  const year = Number(v.year);
  const month = Number(v.month);
  const day = v.day === undefined || v.day === null ? 1 : Number(v.day);
  if (!era || era.length > 12 || !Number.isInteger(year) || year < 1 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const ce = Number(v.ceYear);
  const stated = Number.isInteger(ce) && ce !== 0 && ce > -5000 && ce < 2200 ? ce : null;
  const lunar = typeof v.lunar === "boolean" ? v.lunar : inferLunar(era, rules);
  return { era, year, month, day: Math.min(day, lunar ? 30 : 31), ceYear: ceYearOf(era, year, rules) ?? stated, lunar };
}

// A dynasty written before the era name ("大唐天宝"), but not "秦王政".
const DYNASTY = /^(?:大[唐宋明清汉]|[东西北南][汉宋晋]|[唐宋明清汉秦隋晋])(?![王帝])/;
const DAY_TOKEN = /^(初(?:十|[一二三四五六七八九])|廿[一二三四五六七八九]|卅|[一二三]?十[一二三四五六七八九]?|\d{1,2})日?/;

function dayValue(token: string): number | null {
  if (token.startsWith("初")) return token === "初十" ? 10 : DIGITS.indexOf(token[1]);
  if (token.startsWith("廿")) return 20 + DIGITS.indexOf(token[1]);
  if (token === "卅") return 30;
  return parseChineseNumber(token);
}

export type DatePrecision = "day" | "month" | "season" | "year";

/**
 * Reads a date written in words, e.g. "天宝七载（戊子）冬月十七",
 * "宣和四年春二月初三", "中平元年秋", "公元前44年3月14日". Precision says how
 * much was given; a season starts at its first month, a missing day is 初一.
 * Null when there is no era year.
 */
export function parseDateLabel(text: string | null | undefined, rules?: CalendarRules): { date: GameDate; precision: DatePrecision } | null {
  if (!text) return null;
  const s = text.replace(/[（(][^）)]*[）)]/g, "").replace(/\s+/g, "");
  const m = /^(.*?)(元|[〇零一二两三四五六七八九十百]+|\d+)(?:年|载)(.*)$/.exec(s);
  if (!m) return null;
  let era = m[1];
  const stripped = era.replace(DYNASTY, "");
  if (stripped.length >= 2) era = stripped;
  const year = m[2] === "元" ? 1 : parseChineseNumber(m[2]);
  if (!era || era.length > 8 || /\d/.test(era) || !year || year < 1) return null;
  let rest = m[3].replace(/^[，,、]/, "");
  let month = 1;
  let day = 1;
  let precision: DatePrecision = "year";
  const sm = /^([孟仲季])?([春夏秋冬])(?!月)/.exec(rest);
  if (sm) {
    month = "春夏秋冬".indexOf(sm[2]) * 3 + 1 + (sm[1] ? "孟仲季".indexOf(sm[1]) : 0);
    precision = "season";
    rest = rest.slice(sm[0].length);
  }
  const mm = /^闰?(正|冬|腊|十[一二]|[一二三四五六七八九十]|\d{1,2})月/.exec(rest);
  if (mm) {
    month = ({ 正: 1, 冬: 11, 腊: 12 } as Record<string, number>)[mm[1]] ?? parseChineseNumber(mm[1]) ?? 0;
    if (month < 1 || month > 12) return null;
    precision = "month";
    rest = rest.slice(mm[0].length);
    const dm = DAY_TOKEN.exec(rest);
    const d = dm ? dayValue(dm[1]) : null;
    if (d && d >= 1 && d <= 31) { day = d; precision = "day"; }
  }
  const lunar = inferLunar(era, rules);
  return { date: { era, year, month, day: Math.min(day, lunar ? 30 : 31), ceYear: ceYearOf(era, year, rules), lunar }, precision };
}

/** A start date as the model or an old save wrote it: an object for coerceDate, or words for parseDateLabel. */
export function readDate(raw: unknown, rules?: CalendarRules): GameDate | null {
  return typeof raw === "string" ? parseDateLabel(raw, rules)?.date ?? null : coerceDate(raw, rules);
}
