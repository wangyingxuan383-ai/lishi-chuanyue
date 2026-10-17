// Turns a model's free-form duration ("半个时辰", "两刻钟", "约莫三日", "90分钟")
// into minutes. Traditional units: 1 刻 = 15 min, 1 时辰 = 120 min.
// Returns null when nothing recognisable is found.

// 几 and 数 ("a few") count as three: 十几息, 数日 (eval I: a 过些日子 that stopped
// after 十几息 was taken as a whole day).
const DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 几: 3, 数: 3,
};

/** Parses Arabic or simple Chinese numerals up to the thousands, e.g. 十五, 二十, 一百二十. */
export function parseChineseNumber(text: string): number | null {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  if (!/^[零〇一二两俩三四五六七八九十百千几数]+$/.test(text)) return null;
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (char in DIGITS) current = DIGITS[char];
    else {
      total += (current || 1) * (char === "十" ? 10 : char === "百" ? 100 : 1000);
      current = 0;
    }
  }
  return total + current;
}

const UNIT_MINUTES: Record<string, number> = {
  时辰: 120, 小时: 60, 钟头: 60, 刻钟: 15, 刻: 15, 分钟: 1, 分: 1, 息: 1 / 15,
  炷香: 30, 柱香: 30, 盏茶: 10, 天: 1440, 日: 1440, 夜: 720, 晚: 720,
  旬: 14400, 月: 43200, 季: 129600, 年: 525600, 载: 525600,
};

// amount? 个? 半? unit 半?   e.g. 一个半时辰 / 半个时辰 / 一个时辰半 / 两刻钟 / 90分钟
const PATTERN = new RegExp(
  `(\\d+(?:\\.\\d+)?|[零〇一二两俩三四五六七八九十百千几数]+)?个?(半)?个?(${Object.keys(UNIT_MINUTES).join("|")})(半)?`,
  "g",
);

/** Words for a short while, with no number: a passage that stops at once says these. */
const MOMENTS: [RegExp, number][] = [[/^(?:转眼|眨眼|弹指|顷刻|霎时|一瞬)/, 1], [/^(?:片刻|须臾|少顷|稍顷)/, 5], [/^(?:一会儿?|一阵子?)/, 10]];

export function parseDurationMinutes(input: string | number | null | undefined): number | null {
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? Math.round(input) : null;
  if (!input) return null;
  const text = input.replace(/\s+/g, "").replace(/约莫|大约|约|左右|许/g, "");
  if (/^\d+$/.test(text)) return Number(text);
  for (const [word, value] of MOMENTS) if (word.test(text)) return value;
  let minutes = 0;
  let matched = false;
  for (const [, amountText, halfBefore, unit, halfAfter] of text.matchAll(PATTERN)) {
    const amount = amountText ? parseChineseNumber(amountText) : null;
    if (amount === null && !halfBefore) continue; // a bare unit such as "日" in "日头" is not a duration
    const count = (amount ?? 0) + (halfBefore || halfAfter ? 0.5 : 0);
    minutes += count * UNIT_MINUTES[unit];
    matched = true;
  }
  return matched ? Math.round(minutes) : null;
}
