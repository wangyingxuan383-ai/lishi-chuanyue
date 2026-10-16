// Game calendar (D119). Chinese settings use a simplified lunisolar year —
// twelve months alternating 30/29 days, no leap months — and western settings
// use Gregorian month lengths. Era names change at New Year from the era
// pack's table; without a table the era keeps counting. Ages follow the
// Chinese custom of growing a year at each New Year (虚岁).

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
  /** Year number of startCe within this era, when counting did not restart (始皇 from 26). */
  firstYear?: number;
  /** "载" for 天宝; default "年". */
  yearWord?: string;
}

export interface CalendarRules {
  eras?: EraName[];
  yearWord?: string;
}

export const LUNAR_MONTHS = ["正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月"];
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

/** Years from a to b with no year 0 between BC and AD. */
function yearsBetween(a: number, b: number): number {
  return a < 0 && b > 0 ? b - a - 1 : b - a;
}

function eraFor(ceYear: number, eras: EraName[]): EraName | null {
  let found: EraName | null = null;
  for (const era of eras) if (yearsBetween(era.startCe, ceYear) >= 0) found = era;
  return found;
}

function nextYear(date: GameDate, rules?: CalendarRules): GameDate {
  const ceYear = date.ceYear == null ? null : date.ceYear === -1 ? 1 : date.ceYear + 1;
  const base = { ...date, ceYear, month: 1, day: 1 };
  if (ceYear != null && rules?.eras?.length && rules.eras.some((e) => e.name === date.era)) {
    const era = eraFor(ceYear, rules.eras);
    if (era) return { ...base, era: era.name, year: (era.firstYear ?? 1) + yearsBetween(era.startCe, ceYear) };
  }
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
      d.day += left;
      break;
    }
    left -= Math.max(0, remaining) + 1;
    if (d.month >= 12) {
      d = nextYear(d, rules);
      newYears++;
    } else d = { ...d, month: d.month + 1, day: 1 };
  }
  return { date: d, newYears };
}

/** Whole days since the start of the game, counting from the start hour. */
export function daysElapsed(startHour: number, elapsedMinutes: number): number {
  return Math.floor((startHour * 60 + elapsedMinutes) / 1440);
}

export function yearLabel(date: GameDate, rules?: CalendarRules): string {
  if (!date.lunar) return `${date.era}${date.year}年`;
  const word = rules?.eras?.find((e) => e.name === date.era)?.yearWord ?? rules?.yearWord ?? "年";
  return `${date.era}${date.year === 1 ? "元" : cnNumber(date.year)}${word}`;
}

export function monthDayLabel(date: GameDate): string {
  return date.lunar ? `${LUNAR_MONTHS[date.month - 1]}${cnDay(date.day)}` : `${date.month}月${date.day}日`;
}

/** "天宝七载 冬月十七" / "公元前44年 3月14日" */
export function formatDate(date: GameDate, rules?: CalendarRules): string {
  return `${yearLabel(date, rules)} ${monthDayLabel(date)}`;
}

export function ganzhi(ceYear: number): string {
  const astronomical = ceYear < 0 ? ceYear + 1 : ceYear;
  const index = (((astronomical - 4) % 60) + 60) % 60;
  return STEMS[index % 10] + BRANCHES[index % 12];
}

export function season(date: GameDate): string {
  if (date.lunar) return "春夏秋冬"[Math.floor((date.month - 1) / 3)];
  return ["冬", "冬", "春", "春", "春", "夏", "夏", "夏", "秋", "秋", "秋", "冬"][date.month - 1];
}

/** Accepts whatever the model wrote for the opening date; null when unusable. */
export function coerceDate(raw: unknown): GameDate | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const era = typeof v.era === "string" ? v.era.trim() : "";
  const year = Number(v.year);
  const month = Number(v.month);
  const day = Number(v.day);
  if (!era || era.length > 12 || !Number.isInteger(year) || year < 1 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) return null;
  const ce = Number(v.ceYear);
  const ceYear = Number.isInteger(ce) && ce !== 0 && ce > -5000 && ce < 2200 ? ce : null;
  const lunar = typeof v.lunar === "boolean" ? v.lunar : !/^公元/.test(era) && /[一-鿿]/.test(era);
  return { era, year, month, day: Math.min(day, lunar ? 30 : 31), ceYear, lunar };
}

/** Comparable month index for timeline lookups: ceYear * 12 + month. */
export function monthIndex(ceYear: number, month: number): number {
  const astronomical = ceYear < 0 ? ceYear + 1 : ceYear;
  return astronomical * 12 + (month - 1);
}
