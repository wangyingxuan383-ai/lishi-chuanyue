//! The saved game's simplified calendar, including its deliberate fixed month
//! lengths. Do not substitute a system calendar: that changes existing saves.
use super::{js_number, js_round, num, text, utf16_len, values};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDate {
    pub era: String,
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub ce_year: Option<i64>,
    pub lunar: bool,
}

pub const MAX_CUSTOM_ERA_YEAR: i64 = 999_999_999;
fn max_year(era: &str) -> i64 {
    if era == "公元" || era == "公元前" { 9999 } else { MAX_CUSTOM_ERA_YEAR }
}

pub fn parse_chinese_number(s: &str) -> Option<f64> {
    if Regex::new(r"^\d+(\.\d+)?$").unwrap().is_match(s) {
        return s.parse::<f64>().ok();
    }
    if s.is_empty()
        || !s
            .chars()
            .all(|c| "零〇一二两俩三四五六七八九十百千几数".contains(c))
    {
        return None;
    }
    let (mut total, mut current) = (0.0, 0.0);
    for c in s.chars() {
        let digit = match c {
            '零' | '〇' => Some(0),
            '一' => Some(1),
            '二' | '两' | '俩' => Some(2),
            '三' | '几' | '数' => Some(3),
            '四' => Some(4),
            '五' => Some(5),
            '六' => Some(6),
            '七' => Some(7),
            '八' => Some(8),
            '九' => Some(9),
            _ => None,
        };
        if let Some(n) = digit {
            current = n as f64;
        } else {
            total += if current == 0.0 { 1.0 } else { current }
                * match c {
                    '十' => 10.0,
                    '百' => 100.0,
                    _ => 1000.0,
                };
            current = 0.0;
        }
    }
    Some(total + current)
}

pub fn parse_duration_minutes(input: &Value) -> Option<f64> {
    if let Some(n) = input.as_f64() {
        return (n.is_finite() && n >= 0.0).then(|| js_round(n));
    }
    let raw = input.as_str()?;
    if raw.is_empty() {
        return None;
    }
    let text = Regex::new(r"\s+|约莫|大约|约|左右|许")
        .unwrap()
        .replace_all(raw, "");
    if Regex::new(r"^\d+$").unwrap().is_match(&text) {
        return text.parse().ok();
    }
    let pattern = Regex::new(r"(\d+(?:\.\d+)?|[零〇一二两俩三四五六七八九十百千几数]+)?(?:多|余)?个?多?(半)?个?(时辰|小时|钟头|刻钟|刻|分钟|分|息|炷香|柱香|盏茶|天|日|夜|晚|旬|月|季|年|载)(半|多|余)?").unwrap();
    let (mut minutes, mut matched) = (0.0, false);
    for m in pattern.captures_iter(&text) {
        let amount = m.get(1).and_then(|s| parse_chinese_number(s.as_str()));
        let half_before = m.get(2).is_some();
        let after = m.get(4).map(|m| m.as_str()).unwrap_or("");
        let more = after == "多" || after == "余";
        if amount.is_none() && !half_before && !more {
            continue;
        }
        let count = amount.unwrap_or(if half_before { 0.0 } else { 1.0 })
            + if half_before || after == "半" {
                0.5
            } else {
                0.0
            };
        let unit = match &m[3] {
            "时辰" => 120.0,
            "小时" | "钟头" => 60.0,
            "刻钟" | "刻" => 15.0,
            "分钟" | "分" => 1.0,
            "息" => 1.0 / 15.0,
            "炷香" | "柱香" => 30.0,
            "盏茶" => 10.0,
            "天" | "日" => 1440.0,
            "夜" | "晚" => 720.0,
            "旬" => 14400.0,
            "月" => 43200.0,
            "季" => 129600.0,
            _ => 525600.0,
        };
        minutes += count * unit;
        matched = true;
    }
    if matched {
        return Some(js_round(minutes));
    }
    for (pattern, span) in [
        (r"转眼|眨眼|弹指|顷刻|霎时|一瞬", 1.0),
        (r"片刻|须臾|少顷|稍顷", 5.0),
        (r"一会儿?|一阵子?", 10.0),
    ] {
        if Regex::new(pattern).unwrap().is_match(&text) {
            return Some(span);
        }
    }
    None
}

fn to_astro(ce: i64) -> i64 {
    if ce < 0 {
        ce + 1
    } else {
        ce
    }
}
fn from_astro(year: i64) -> i64 {
    if year <= 0 {
        year - 1
    } else {
        year
    }
}
pub fn month_index(ce: i64, month: i64) -> i64 {
    to_astro(ce) * 12 + month - 1
}
pub fn era_at(ce: i64, month: i64, rules: &Value) -> Option<&Value> {
    values(&rules["eras"])
        .iter()
        .filter(|e| {
            month_index(
                num(&e["startCe"]) as i64,
                e["startMonth"].as_i64().unwrap_or(1),
            ) <= month_index(ce, month)
        })
        .last()
}
pub fn ce_year_of(era: &str, year: i64, rules: &Value) -> Option<i64> {
    if let Some(e) = values(&rules["eras"])
        .iter()
        .find(|e| text(&e["name"]) == era)
    {
        return Some(from_astro(
            to_astro(num(&e["startCe"]) as i64) + year - e["firstYear"].as_i64().unwrap_or(1),
        ));
    }
    match era {
        "公元" => Some(year),
        "公元前" => Some(-year),
        _ => None,
    }
}
fn infer_lunar(era: &str, rules: &Value) -> bool {
    rules["lunar"].as_bool().unwrap_or_else(|| {
        !era.starts_with("公元") && era.chars().any(|c| ('一'..='鿿').contains(&c))
    })
}
pub fn coerce_date(raw: &Value, rules: &Value) -> Option<GameDate> {
    raw.as_object()?;
    let era = text(&raw["era"]).trim();
    let year = js_number(&raw["year"])?;
    let month = js_number(&raw["month"])?;
    let day = if raw["day"].is_null() {
        1.0
    } else {
        js_number(&raw["day"])?
    };
    if era.is_empty()
        || utf16_len(era) > 12
        || year.fract() != 0.0
        || !(1.0..=max_year(era) as f64).contains(&year)
        || month.fract() != 0.0
        || !(1.0..=12.0).contains(&month)
        || day.fract() != 0.0
        || !(1.0..=31.0).contains(&day)
    {
        return None;
    }
    let ce = js_number(&raw["ceYear"])
        .filter(|n| n.fract() == 0.0 && *n != 0.0 && *n > -5000.0 && *n < 2200.0)
        .map(|n| n as i64);
    let lunar = raw["lunar"]
        .as_bool()
        .unwrap_or_else(|| infer_lunar(era, rules));
    Some(GameDate {
        era: era.into(),
        year: year as i64,
        month: month as i64,
        day: day.min(if lunar { 30.0 } else { 31.0 }) as i64,
        ce_year: ce_year_of(era, year as i64, rules).or(ce),
        lunar,
    })
}

pub fn parse_date_label(raw: &str, rules: &Value) -> Option<(GameDate, &'static str)> {
    let removed = Regex::new(r"[（(][^）)]*[）)]")
        .unwrap()
        .replace_all(raw, "");
    let s = Regex::new(r"\s+").unwrap().replace_all(&removed, "");
    let m = Regex::new(r"^(.*?)(元|[〇零一二两三四五六七八九十百]+|\d+)(?:年|载)(.*)$")
        .unwrap()
        .captures(&s)?;
    let mut era = m[1].to_owned();
    let dynasty = Regex::new(r"^(?:大[唐宋明清汉]|[东西北南][汉宋晋]|[唐宋明清汉秦隋晋])").unwrap();
    if let Some(prefix) = dynasty.find(&era) {
        let rest = &era[prefix.end()..];
        if !rest.starts_with(['王', '帝']) && utf16_len(rest) >= 2 {
            era = rest.into();
        }
    }
    if era.is_empty() && Regex::new(r"^\d+$").unwrap().is_match(&m[2]) {
        era = "公元".into();
    }
    let year = if &m[2] == "元" {
        1.0
    } else {
        parse_chinese_number(&m[2])?
    };
    if era.is_empty()
        || utf16_len(&era) > 8
        || era.chars().any(|c| c.is_ascii_digit())
        || year < 1.0
        || year > max_year(&era) as f64
        || year.fract() != 0.0
    {
        return None;
    }
    let mut rest = m[3].trim_start_matches(['，', ',', '、']).to_owned();
    let (mut month, mut day, mut precision) = (1, 1, "year");
    if let Some(sm) = Regex::new(r"^([孟仲季])?([春夏秋冬])")
        .unwrap()
        .captures(&rest)
    {
        let full = sm.get(0).unwrap();
        if !rest[full.end()..].starts_with('月') {
            month = "春夏秋冬"
                .chars()
                .position(|c| c.to_string() == sm[2])
                .unwrap() as i64
                * 3
                + 1
                + sm.get(1)
                    .map(|x| {
                        "孟仲季"
                            .chars()
                            .position(|c| c.to_string() == x.as_str())
                            .unwrap() as i64
                    })
                    .unwrap_or(0);
            precision = "season";
            rest = rest[full.end()..].into();
        }
    }
    if let Some(mm) = Regex::new(r"^闰?(正|冬|腊|十[一二]|[一二三四五六七八九十]|\d{1,2})月")
        .unwrap()
        .captures(&rest)
    {
        month = match &mm[1] {
            "正" => 1,
            "冬" => 11,
            "腊" => 12,
            n => parse_chinese_number(n)? as i64,
        };
        if !(1..=12).contains(&month) {
            return None;
        }
        precision = "month";
        let tail = &rest[mm.get(0).unwrap().end()..];
        if let Some(dm) = Regex::new(r"^(初(?:十|[一二三四五六七八九])|廿[一二三四五六七八九]|卅|[一二三]?十[一二三四五六七八九]?|\d{1,2})日?").unwrap().captures(tail) {
            let token = &dm[1];
            let d = if let Some(n)=token.strip_prefix('初') {parse_chinese_number(n)} else if let Some(n)=token.strip_prefix('廿') {parse_chinese_number(n).map(|n|20.0+n)} else if token=="卅" {Some(30.0)} else {parse_chinese_number(token)};
            if let Some(d)=d.filter(|n| *n>=1.0 && *n<=31.0) {day=d as i64; precision="day";}
        }
    }
    let lunar = infer_lunar(&era, rules);
    Some((
        GameDate {
            ce_year: ce_year_of(&era, year as i64, rules),
            era,
            year: year as i64,
            month,
            day: day.min(if lunar { 30 } else { 31 }),
            lunar,
        },
        precision,
    ))
}
pub fn read_date(raw: &Value, rules: &Value) -> Option<GameDate> {
    if let Some(s) = raw.as_str() {
        parse_date_label(s, rules).map(|p| p.0)
    } else {
        coerce_date(raw, rules)
    }
}
pub fn month_days(date: &GameDate) -> i64 {
    if date.lunar {
        if date.month % 2 == 1 {
            30
        } else {
            29
        }
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][date.month.clamp(1, 12) as usize - 1]
    }
}
fn with_era(mut date: GameDate, rules: &Value) -> GameDate {
    if let Some(ce) = date.ce_year {
        if values(&rules["eras"])
            .iter()
            .any(|e| text(&e["name"]) == date.era)
        {
            if let Some(e) = era_at(ce, date.month, rules) {
                date.era = text(&e["name"]).into();
                date.year = e["firstYear"].as_i64().unwrap_or(1) + to_astro(ce)
                    - to_astro(num(&e["startCe"]) as i64);
            }
        }
    }
    date
}
pub fn add_days(date: &GameDate, days: f64, rules: &Value) -> (GameDate, i64) {
    let mut date = date.clone();
    let mut left = days.max(0.0).floor() as i64;
    let mut years = 0;
    while left > 0 {
        let remaining = month_days(&date) - date.day;
        if left <= remaining {
            date.day += left;
            break;
        }
        left -= remaining.max(0) + 1;
        if date.month >= 12 {
            date.ce_year = date.ce_year.map(|ce| from_astro(to_astro(ce) + 1));
            date.month = 1;
            date.day = 1;
            years += 1;
            if date.era == "公元前" {
                if date.year <= 1 {
                    date.era = "公元".into();
                    date.year = 1;
                } else {
                    date.year -= 1;
                }
            } else {
                date.year += 1;
            }
        } else {
            date.month += 1;
            date.day = 1;
        }
        date = with_era(date, rules);
    }
    (date, years)
}
pub fn cn_number(n: i64) -> String {
    let digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    if !(0..1000).contains(&n) {
        return n.to_string();
    }
    if n < 10 {
        return digits[n as usize].into();
    }
    if n < 20 {
        return format!(
            "十{}",
            if n % 10 == 0 {
                ""
            } else {
                digits[(n % 10) as usize]
            }
        );
    }
    if n < 100 {
        return format!(
            "{}十{}",
            digits[(n / 10) as usize],
            if n % 10 == 0 {
                ""
            } else {
                digits[(n % 10) as usize]
            }
        );
    }
    let rest = n % 100;
    format!(
        "{}百{}",
        digits[(n / 100) as usize],
        if rest == 0 {
            String::new()
        } else if rest < 10 {
            format!("零{}", digits[rest as usize])
        } else if rest < 20 {
            format!("一{}", cn_number(rest))
        } else {
            cn_number(rest)
        }
    )
}
pub fn cn_day(day: i64) -> String {
    match day {
        1..=9 => format!("初{}", cn_number(day)),
        10 => "初十".into(),
        11..=19 => format!("十{}", cn_number(day - 10)),
        20 => "二十".into(),
        21..=29 => format!("廿{}", cn_number(day - 20)),
        _ => "三十".into(),
    }
}
const MONTHS: [&str; 12] = [
    "正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月",
];
pub fn year_label(date: &GameDate, rules: &Value) -> String {
    if !date.lunar {
        return format!("{}{}年", date.era, date.year);
    }
    let word = values(&rules["eras"])
        .iter()
        .find(|e| text(&e["name"]) == date.era)
        .and_then(|e| e["yearWord"].as_str())
        .or(rules["yearWord"].as_str())
        .unwrap_or("年");
    format!(
        "{}{}{}",
        date.era,
        if date.year == 1 {
            "元".into()
        } else {
            cn_number(date.year)
        },
        word
    )
}
pub fn month_label(date: &GameDate, rules: &Value) -> String {
    format!(
        "{} {}",
        year_label(date, rules),
        if date.lunar {
            MONTHS[date.month.clamp(1, 12) as usize - 1].into()
        } else {
            format!("{}月", date.month)
        }
    )
}
pub fn format_date(date: &GameDate, rules: &Value) -> String {
    format!(
        "{} {}",
        year_label(date, rules),
        if date.lunar {
            format!(
                "{}{}",
                MONTHS[date.month.clamp(1, 12) as usize - 1],
                cn_day(date.day)
            )
        } else {
            format!("{}月{}日", date.month, date.day)
        }
    )
}
fn days_before_month(month: i64, lunar: bool) -> i64 {
    (1..month)
        .map(|m| {
            month_days(&GameDate {
                era: "".into(),
                year: 1,
                month: m,
                day: 1,
                ce_year: None,
                lunar,
            })
        })
        .sum()
}
pub fn days_between(a: &GameDate, b: &GameDate) -> Option<i64> {
    let years = match (a.ce_year, b.ce_year) {
        (Some(a), Some(b)) => to_astro(b) - to_astro(a),
        _ if a.era == b.era => b.year - a.year,
        _ => return None,
    };
    Some(
        years * days_before_month(13, a.lunar) + days_before_month(b.month, a.lunar) + b.day
            - days_before_month(a.month, a.lunar)
            - a.day,
    )
}

/// Signed display projection, using the same fixed month lengths as saves.
pub fn shift_date(date: &GameDate, days: i64, rules: &Value) -> Option<GameDate> {
    let year_days = days_before_month(13, date.lunar);
    let origin = date.ce_year.map(to_astro).unwrap_or(date.year);
    let serial = origin
        .checked_mul(year_days)?
        .checked_add(days_before_month(date.month, date.lunar) + date.day - 1)?
        .checked_add(days)?;
    if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&serial) { return None; }
    let year = serial.div_euclid(year_days);
    let mut left = serial.rem_euclid(year_days);
    let mut next = date.clone();
    next.month = 1;
    while left >= month_days(&next) {
        left -= month_days(&next);
        next.month += 1;
    }
    next.day = left + 1;
    next.ce_year = date.ce_year.map(|_| from_astro(year));
    next.year = date.year + year - origin;
    if date.era == "公元" || date.era == "公元前" {
        let ce = next.ce_year.unwrap_or_else(|| from_astro(year));
        next.era = if ce < 0 { "公元前" } else { "公元" }.into();
        next.year = ce.abs();
        next.ce_year = Some(ce);
    }
    let next = with_era(next, rules);
    (1..=max_year(&next.era)).contains(&next.year).then_some(next)
}

fn new_years_after_days(date: &GameDate, days: f64) -> f64 {
    ((days_before_month(date.month, date.lunar) as f64 + date.day as f64 - 1.0
        + days.max(0.0).floor())
        / days_before_month(13, date.lunar) as f64)
        .floor()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockAnchor {
    pub at_elapsed_minutes: f64,
    pub date: GameDate,
    pub minute_of_day: f64,
}

/// Strict calibration input; legacy opening-date coercion remains unchanged.
pub fn read_clock_anchor(raw: &Value, rules: &Value) -> Option<ClockAnchor> {
    let at = super::safe_integer(&raw["atElapsedMinutes"]).filter(|n| *n >= 0.0)?;
    let minute = super::safe_integer(&raw["minuteOfDay"]).filter(|n| (0.0..1440.0).contains(n))?;
    let source = &raw["date"];
    let mut date = coerce_date(source, rules)?;
    // An explicit independent display anchor does not reinterpret an old
    // history date whose unknown CE value is still inferred from its era table.
    if source.get("ceYear").is_some_and(Value::is_null) && date.era != "公元" && date.era != "公元前" {
        date.ce_year=None;
    }
    if !source["year"].is_number()
        || !source["month"].is_number()
        || !source["day"].is_number()
        || source["day"].as_f64()? != date.day as f64
        || date.day > month_days(&date)
        || !source["ceYear"].is_null()
            && source["ceYear"].as_f64() != date.ce_year.map(|ce| ce as f64)
        || !source["lunar"].is_null() && !source["lunar"].is_boolean()
    {
        return None;
    }
    Some(ClockAnchor {
        at_elapsed_minutes: at,
        date,
        minute_of_day: minute,
    })
}

/// Day/time display offset; does not change the story's elapsed-time axis.
pub fn clock_offset_minutes(clock: &Value) -> f64 {
    if let Some(anchor) = read_clock_anchor(&clock["anchor"], &clock["rules"]) {
        anchor.minute_of_day - anchor.at_elapsed_minutes
    } else {
        num(&clock["hour"]) * 60.0
    }
}

fn clock_base_date(clock: &Value) -> Option<GameDate> {
    let source = &clock["date"];
    let mut date = coerce_date(source, &clock["rules"])?;
    // New free-world dates explicitly opt out of the CE axis. Keep the old
    // history coercion and any explicitly saved CE date unchanged.
    if clock["mode"] == "free" && source.get("ceYear").is_some_and(Value::is_null)
        && date.era != "公元" && date.era != "公元前" {
        date.ce_year = None;
    }
    Some(date)
}

pub fn now_of(clock: &Value, elapsed: f64) -> Value {
    let style = clock["clockStyle"]
        .as_str()
        .unwrap_or(if text(&clock["mode"]) == "free" {
            "elapsed"
        } else {
            "era"
        });
    let time_style = clock["timeStyle"]
        .as_str()
        .unwrap_or(if style == "elapsed" { "24h" } else { "shichen" });
    let days = ((num(&clock["hour"]) * 60.0 + elapsed.max(0.0)) / 1440.0).floor();
    let total = clock_offset_minutes(clock) + elapsed.max(0.0);
    let in_day = total.rem_euclid(1440.0);
    let hour = (in_day / 60.0).floor();
    let shichen = [
        "子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥",
    ][(((hour + 1.0) % 24.0 + 24.0) % 24.0 / 2.0).floor() as usize];
    let base_date = clock_base_date(clock);
    let date = if style == "elapsed" {
        None
    } else if let Some(anchor) = read_clock_anchor(&clock["anchor"], &clock["rules"]) {
        shift_date(
            &anchor.date,
            (total / 1440.0).floor() as i64,
            &clock["rules"],
        )
    } else {
        base_date
            .as_ref()
            .and_then(|d| shift_date(d, days as i64, &clock["rules"]))
    };
    let time = if time_style == "24h" {
        format!("{:02}:{:02}", hour as i64, (in_day % 60.0) as i64)
    } else {
        format!("{}时", shichen)
    };
    let label = if style == "elapsed" {
        format!("第 {} 天 · {}", days + 1.0, time)
    } else if let Some(date) = &date {
        format!("{} · {}", format_date(date, &clock["rules"]), time)
    } else {
        format!(
            "{}第 {} 日 · {}",
            if text(&clock["label"]).is_empty() {
                String::new()
            } else {
                format!("{} · ", text(&clock["label"]))
            },
            days + 1.0,
            time
        )
    };
    let new_years = if style != "elapsed" {
        base_date
            .as_ref()
            .map(|d| new_years_after_days(d, days))
            .unwrap_or(0.0)
    } else {
        0.0
    };
    json!({"clockStyle":style,"timeStyle":time_style,"day":days+1.0,"hour":hour,"minute":in_day%60.0,"shichen":shichen,"date":date,"newYears":new_years,"text":label})
}
pub fn play_years(from: f64, to: f64) -> f64 {
    if to <= from {
        0.0
    } else {
        (to / 525600.0).floor() - (from.max(0.0) / 525600.0).floor()
    }
}
pub fn new_years_between(clock: &Value, from: f64, to: f64) -> f64 {
    if to <= from {
        0.0
    } else if text(&clock["mode"]) == "free" || clock["date"].is_null() {
        play_years(from, to)
    } else {
        // Display calibration cannot add ages or extend lifetimes.
        coerce_date(&clock["date"], &clock["rules"])
            .map(|d| {
                let years = |elapsed: f64| {
                    new_years_after_days(
                        &d,
                        ((num(&clock["hour"]) * 60.0 + elapsed.max(0.0)) / 1440.0).floor(),
                    )
                };
                years(to) - years(from)
            })
            .unwrap_or_else(|| play_years(from, to))
    }
}

pub fn place_event(clock: &Value, raw: &Value) -> Value {
    let mut date = read_date(&raw["date"], &clock["rules"]);
    let ce = raw["ceYear"]
        .as_i64()
        .filter(|n| *n != 0 && *n > -5000 && *n < 2200);
    if let Some(d) = date.as_mut() {
        if d.ce_year.is_none() {
            d.ce_year = ce;
        }
    }
    let start = coerce_date(&clock["date"], &clock["rules"]);
    let at = date
        .as_ref()
        .and_then(|d| start.as_ref().and_then(|start| days_between(start, d)))
        .map(|days| days as f64 * 1440.0 - num(&clock["hour"]) * 60.0);
    let mut event = json!({"date":date.as_ref().map(|d|month_label(d,&clock["rules"])).unwrap_or_else(||text(&raw["date"]).trim().into()),"atMinute":at,"title":text(&raw["title"]).trim(),"kind":if text(&raw["kind"])=="固定"{"固定"}else{"可变"}});
    if let Some(ce) = ce {
        event["ceYear"] = json!(ce);
    }
    event
}
pub fn retime(events: &[Value], clock: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = events
        .iter()
        .map(|e| {
            let mut next = e.clone();
            next["atMinute"] = place_event(clock, e)["atMinute"].clone();
            next
        })
        .collect();
    out.sort_by(|a, b| {
        a["atMinute"]
            .as_f64()
            .unwrap_or(f64::INFINITY)
            .total_cmp(&b["atMinute"].as_f64().unwrap_or(f64::INFINITY))
    });
    out
}
