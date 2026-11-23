//! Built-in source tools. Notes locate evidence; only immutable original text
//! enters `excerpts`, so a summary cannot satisfy the runtime's reading gate.
use crate::{Error, Result, RunPlan, Store};
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    sync::OnceLock,
};

type Keys = Vec<(String, u32)>;
fn units(text: &str) -> usize {
    text.encode_utf16().count()
}
fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .map(|v| v.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// Ordered terms match the classic index: Han bigrams, whole other words.
pub(crate) fn terms(text: &str) -> Vec<String> {
    static WORDS: OnceLock<Regex> = OnceLock::new();
    static HAN: OnceLock<Regex> = OnceLock::new();
    let words = WORDS.get_or_init(|| Regex::new(r"[\p{L}\p{N}]+").unwrap());
    let han = HAN.get_or_init(|| Regex::new(r"\p{Han}").unwrap());
    let lower = text.to_lowercase();
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for word in words.find_iter(&lower).map(|m| m.as_str()) {
        let found: Vec<String> = if han.is_match(word) {
            word.chars()
                .collect::<Vec<_>>()
                .windows(2)
                .map(|pair| pair.iter().collect())
                .collect()
        } else if units(word) > 1 {
            vec![prefix(word, 64)]
        } else {
            vec![]
        };
        for term in found {
            if seen.insert(term.clone()) {
                result.push(term);
            }
        }
    }
    result
}

fn add(keys: &mut Keys, text: &str, weight: u32, limit: usize) {
    let found = terms(text);
    let selected: Vec<_> = if found.len() > limit {
        found[..limit.div_ceil(2)]
            .iter()
            .chain(found[found.len() - limit / 2..].iter())
            .collect()
    } else {
        found.iter().collect()
    };
    for term in selected {
        if let Some((_, old)) = keys.iter_mut().find(|(key, _)| key == term) {
            *old = (*old).max(weight);
        } else {
            keys.push((term.clone(), weight));
        }
    }
}

/// Words of asking, not of the story: “核对比试是什么” is about 比试 (R30 step 3).
/// Mirrored in TS `REQUEST_WORDS` (src/engine/sources/library.ts).
pub(crate) const REQUEST_WORDS: [&str; 35] = [
    "核对一下", "核对", "检查", "一下", "是什么", "为什么", "什么", "怎么", "是否", "有没有",
    "原著", "原文", "修改", "改成", "确认", "请问", "看看", "查查",
    "查阅", "纠正", "改正", "纠错", "核实", "查证", "本段", "这段", "细节", "依据", "错误", "不符", "一致", "保留", "玩家", "主动", "改写",
];

/// A player's request with the asking words taken out.
pub(crate) fn without_request_words(text: &str) -> String {
    REQUEST_WORDS.iter().fold(text.to_owned(), |acc, word| acc.replace(word, " "))
}

pub(crate) fn parse_chapter_numeral(raw: &str) -> Option<u64> {
    let trimmed = raw
        .trim()
        .trim_start_matches('第')
        .trim()
        .trim_end_matches(['章', '回', '节', '卷', '集', '部', '篇', '话', '幕', '折'])
        .trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().all(|c| c.is_ascii_digit()) {
        return trimmed.parse::<u64>().ok();
    }
    if matches!(trimmed, "零" | "〇") {
        return Some(0);
    }
    let mut total = 0u64;
    let mut section = 0u64;
    let mut current = 0u64;
    let mut has_digit = false;
    for ch in trimmed.chars() {
        let digit = match ch {
            '零' | '〇' => Some(0),
            '一' => Some(1),
            '二' | '两' => Some(2),
            '三' => Some(3),
            '四' => Some(4),
            '五' => Some(5),
            '六' => Some(6),
            '七' => Some(7),
            '八' => Some(8),
            '九' => Some(9),
            _ => None,
        };
        if let Some(d) = digit {
            current = d;
            has_digit = true;
            continue;
        }
        let unit = match ch {
            '十' => Some(10u64),
            '百' => Some(100),
            '千' => Some(1000),
            '万' => Some(10000),
            _ => None,
        };
        if let Some(u) = unit {
            if u == 10000 {
                section = section.saturating_add(current).saturating_mul(u);
                total = total.saturating_add(section);
                section = 0;
                current = 0;
            } else {
                let factor = if current == 0 && u == 10 { 1 } else { current };
                section = section.saturating_add(factor.saturating_mul(u));
                current = 0;
            }
            has_digit = true;
        } else {
            return None;
        }
    }
    let value = total.saturating_add(section).saturating_add(current);
    (has_digit && value > 0).then_some(value)
}

fn extract_chapter_numbers(title: &str) -> Vec<u64> {
    static CHAPTER_RE: OnceLock<Regex> = OnceLock::new();
    static EN_CHAPTER_RE: OnceLock<Regex> = OnceLock::new();
    static VOLUME_RE: OnceLock<Regex> = OnceLock::new();
    static LEADING_RE: OnceLock<Regex> = OnceLock::new();
    let chapter_re = CHAPTER_RE.get_or_init(|| {
        Regex::new(r"第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*[章回节话幕折]").unwrap()
    });
    let en_chapter_re = EN_CHAPTER_RE.get_or_init(|| {
        Regex::new(r"(?i)\bchapter\s+(\d{1,5})\b").unwrap()
    });
    let volume_re = VOLUME_RE.get_or_init(|| {
        Regex::new(r"第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*[卷集部篇]").unwrap()
    });
    let leading_re = LEADING_RE.get_or_init(|| Regex::new(r"^\s*(\d{1,5})(?:[.、\s\-—:：]|$)").unwrap());
    let mut nums = BTreeSet::new();
    for cap in chapter_re.captures_iter(title) {
        if let Some(n) = cap.get(1).and_then(|m| parse_chapter_numeral(m.as_str())) {
            nums.insert(n);
        }
    }
    for cap in en_chapter_re.captures_iter(title) {
        if let Some(n) = cap.get(1).and_then(|m| m.as_str().parse::<u64>().ok()) {
            nums.insert(n);
        }
    }
    if nums.is_empty() {
        for cap in volume_re.captures_iter(title) {
            if let Some(n) = cap.get(1).and_then(|m| parse_chapter_numeral(m.as_str())) {
                nums.insert(n);
            }
        }
        if let Some(n) = leading_re
            .captures(title)
            .and_then(|cap| cap.get(1))
            .and_then(|m| m.as_str().parse::<u64>().ok())
        {
            nums.insert(n);
        }
    }
    nums.into_iter().collect()
}

pub(crate) fn chapter_query_rank(section: i64, title: &str, query: &str) -> Option<u8> {
    let lower = title.to_lowercase();
    let title_nums = extract_chapter_numbers(title);
    let index_num = (section + 1).max(0) as u64;
    let tokens: Vec<&str> = query
        .split(|c: char| c.is_whitespace() || "，、,；;。".contains(c))
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return Some(2);
    }
    let mut title_only = true;
    for token in tokens {
        let in_title = lower.contains(&token.to_lowercase());
        let num = parse_chapter_numeral(token);
        let in_title_num = num.is_some_and(|n| title_nums.contains(&n));
        if in_title || in_title_num {
            continue;
        }
        if num.is_some_and(|n| n == index_num) {
            title_only = false;
            continue;
        }
        return None;
    }
    Some(if title_only { 2 } else { 1 })
}

pub(crate) fn chapter_query_matches(section: i64, title: &str, query: &str) -> bool {
    chapter_query_rank(section, title, query).is_some()
}

/// Extract a compact query-centered snippet (reused by `reference_lookup` so the matched line stays inside the snippet).
pub(crate) fn centered_snippet(text: &str, query: &str, cap: usize) -> String {
    let mut keys = Vec::new();
    add(&mut keys, &without_request_words(query), 6, 40);
    add(&mut keys, query, 4, 40);
    let (sample, start, end) = window(text, &keys, cap);
    let total = units(text);
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        sample.trim(),
        if end < total { "…" } else { "" }
    )
}

/// List or search the table of contents within the allowed book scope (`from..=through`).
pub(crate) fn list_sections(db: &Connection, plan: &RunPlan, args: &Value) -> Result<Value> {
    if notes_only(plan) {
        return Err(Error::Invalid("这次只用你选的札记，不查原文目录；请依据札记作答".into()));
    }
    let binding = plan.reading_source();
    let Some(book) = binding["bookId"].as_str() else {
        return Ok(json!({"status":"insufficient","reason":"未绑定参考书籍","sections":[]}));
    };
    let meta: Option<(String, Option<i64>)> = db
        .query_row(
            "SELECT b.title,MAX(s.section) FROM source_books b LEFT JOIN source_sections s ON s.book_id=b.id WHERE b.id=? GROUP BY b.id",
            [book],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((title, Some(last))) = meta else {
        return Ok(json!({"status":"insufficient","reason":"参考书籍不存在或没有正文","sections":[]}));
    };
    let range = scope_range(plan);
    let allowed = binding["through"].as_i64().unwrap_or(last).min(last);
    let through = range.map_or(allowed, |(_, to)| to.min(allowed));
    let from = range.map_or(0, |(from, _)| from);
    if through < 0 || from > through {
        return Err(Error::Invalid("原著参考范围无效".into()));
    }
    let position = binding["position"].as_i64().unwrap_or(0).clamp(from, through);
    let query = args["query"].as_str().unwrap_or("").trim();
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let limit = args["limit"].as_u64().unwrap_or(40).clamp(1, 80) as usize;
    let mut stmt = db.prepare(
        "SELECT s.section, s.title, s.page, COALESCE(SUM(LENGTH(c.text)), 0) AS chars, COUNT(c.ordinal) AS chunks
         FROM source_sections s
         LEFT JOIN source_chunks c ON c.book_id = s.book_id AND c.section = s.section
         WHERE s.book_id = ? AND s.section >= ? AND s.section <= ?
         GROUP BY s.section, s.title, s.page
         ORDER BY s.section",
    )?;
    let all = stmt
        .query_map(params![book, from, through], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let total = all.len();
    let mut matched: Vec<_> = all
        .into_iter()
        .filter_map(|row| {
            let rank = if query.is_empty() {
                2
            } else {
                chapter_query_rank(row.0, &row.1, query)?
            };
            Some((rank, row))
        })
        .collect();
    if !query.is_empty() {
        matched.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1 .0.cmp(&b.1 .0)));
    }
    let matched_count = matched.len();
    let mut sections = vec![];
    for (_, (section, sec_title, page, chars, chunks)) in matched.into_iter().skip(offset).take(limit) {
        let mut row = json!({"section": section, "title": sec_title, "chars": chars, "chunks": chunks});
        if let Some(p) = page {
            row["page"] = p.into();
        }
        sections.push(row);
    }
    let next = offset + sections.len();
    Ok(json!({
        "bookId": book,
        "title": title,
        "from": from,
        "through": through,
        "position": position,
        "total": total,
        "matched": matched_count,
        "offset": offset,
        "nextOffset": (next < matched_count).then_some(next),
        "sections": sections,
        "note": "section 为 0 开始的书内顺序节号（含序章/卷标时可能与章名数字不同）；找到目标节号后用 read_original(section) 或 search_original(query, from, to) 阅读原文。"
    }))
}

/// 资料范围 (D184): the chapters one request chose, 0-based and inclusive. It
/// lives only in the request (`meta.sourceScope`), never in the story.
pub(crate) fn scope_range(plan: &RunPlan) -> Option<(i64, i64)> {
    let scope = &plan.meta["sourceScope"];
    match (scope["from"].as_i64(), scope["to"].as_i64()) {
        (Some(from), Some(to)) if matches!(scope["mode"].as_str(), Some("chapters" | "notes")) => Some((from.max(0), to.max(from.max(0)))),
        _ => None,
    }
}
/// Only the chosen notes: the original is not looked up at all (a correction keeps
/// its lookups within what the notes cover, `lookups`).
pub(crate) fn notes_only(plan: &RunPlan) -> bool {
    let scope = &plan.meta["sourceScope"];
    scope["mode"] == "notes" && scope["lookups"] != true
}
fn chosen_notes(plan: &RunPlan) -> Option<HashSet<String>> {
    let scope = &plan.meta["sourceScope"];
    (scope["mode"] == "notes").then(|| strings(&scope["noteIds"]).into_iter().map(str::to_owned).collect())
}
fn scope_words(range: Option<(i64, i64)>) -> String {
    range.map(|(from, to)| if from == to { format!("第 {} 节", from + 1) } else { format!("第 {}～{} 节", from + 1, to + 1) }).unwrap_or_default()
}

fn query_keys(plan: &RunPlan, args: &Value) -> Keys {
    let mut keys = vec![];
    let text = |v: &Value| v.as_str().unwrap_or("").to_owned();
    let query = text(&args["query"]);
    add(&mut keys, &query, 6, 80);
    // The model's own query leads; the turn's other words only help break ties.
    let extra = |w: u32| if query.trim().is_empty() { w } else { 1 };
    add(&mut keys, &text(&plan.action["text"]), extra(4), 60);
    for hint in [
        &plan.meta["rewriteHint"],
        &plan.action["rewriteHint"],
        &plan.meta["setup"]["hint"],
    ] {
        add(&mut keys, &without_request_words(&text(hint)), extra(5), 60);
    }
    for hint in [&plan.action["directorNote"], &plan.meta["directorNote"]] {
        add(&mut keys, &text(hint), extra(4), 40);
    }
    let mut names = vec![text(&plan.state["protagonist"]["name"])];
    names.extend(
        strings(&plan.state["protagonist"]["aliases"])
            .into_iter()
            .map(str::to_owned),
    );
    if let Some(people) = plan.state["people"].as_array() {
        for p in people.iter().rev().take(6).rev() {
            names.push(text(&p["name"]));
            names.extend(strings(&p["aliases"]).into_iter().map(str::to_owned));
        }
    }
    add(&mut keys, &names.join("\n"), extra(3), 60);
    if let Some(places) = plan.state["places"].as_array() {
        if let Some(place) = places.iter().find(|p| p["id"] == plan.state["placeId"]) {
            add(&mut keys, &text(&place["name"]), extra(3), 20);
        }
    }
    // Parse the complete saved use, including its last line. Selection is over
    // unique terms, never an arbitrary leading slice of a long instruction.
    add(
        &mut keys,
        &text(&plan.reading_source()["instructions"]),
        extra(2),
        80,
    );
    keys.sort_by(|a, b| b.1.cmp(&a.1));
    keys.truncate(240);
    keys
}

#[derive(Clone)]
struct Fact {
    id: String,
    job: Option<String>,
    section: i64,
    chunk: i64,
    kind: String,
    subject: String,
    aliases: Vec<String>,
    statement: String,
    quote: String,
    from: Option<i64>,
    through: Option<i64>,
    title: String,
    page: Option<i64>,
}

impl Fact {
    fn value(&self, book: &str, position: i64) -> Value {
        let mut value = json!({"id":self.id,"bookId":book,"jobId":self.job,"section":self.section,"chunk":self.chunk,
            "title":self.title,"kind":self.kind,"subject":self.subject,"aliases":self.aliases,"statement":self.statement,"quote":self.quote,
            "validFrom":self.from,"validThrough":self.through,
            "temporalNote":if self.section<position && self.through.is_none() {"出处较早，未注明失效章节；较早身份不能直接当作当前身份，须核对后续原文。"} else {"按注明的章节范围理解；人物是否知情另按本局正文判断。"}});
        if let Some(page) = self.page {
            value["page"] = page.into();
        }
        value
    }
    fn score(&self, keys: &Keys) -> u32 {
        let names = format!("{}\n{}", self.subject, self.aliases.join("\n")).to_lowercase();
        let statement = self.statement.to_lowercase();
        keys.iter()
            .map(|(key, weight)| {
                if names.contains(key) {
                    weight * 4
                } else if statement.contains(key) {
                    *weight
                } else {
                    0
                }
            })
            .sum()
    }
}

#[allow(clippy::too_many_arguments)]
fn facts(
    db: &Connection,
    book: &str,
    binding: &Value,
    from: i64,
    through: i64,
    position: i64,
    keys: &Keys,
    all: bool,
    ignore_position: bool,
) -> Result<Vec<Fact>> {
    let sql = if ignore_position {
        "SELECT f.id,f.job_id,f.section,f.chunk,f.kind,f.subject,f.aliases_json,f.statement,f.quote,f.valid_from,f.valid_through,s.title,s.page,c.text FROM canon_facts f JOIN source_chunks c ON c.book_id=f.book_id AND c.ordinal=f.chunk AND c.section=f.section JOIN source_sections s ON s.book_id=f.book_id AND s.section=f.section JOIN source_jobs j ON j.id=f.job_id AND j.book_id=f.book_id WHERE f.book_id=?1 AND f.section<=?2 AND (?3 IS NULL OR f.job_id=?3)"
    } else {
        "SELECT f.id,f.job_id,f.section,f.chunk,f.kind,f.subject,f.aliases_json,f.statement,f.quote,f.valid_from,f.valid_through,s.title,s.page,c.text FROM canon_facts f JOIN source_chunks c ON c.book_id=f.book_id AND c.ordinal=f.chunk AND c.section=f.section JOIN source_sections s ON s.book_id=f.book_id AND s.section=f.section JOIN source_jobs j ON j.id=f.job_id AND j.book_id=f.book_id WHERE f.book_id=?1 AND f.section<=?2 AND COALESCE(f.valid_from,f.section)<=?4 AND (f.valid_through IS NULL OR f.valid_through>=?4) AND (?3 IS NULL OR f.job_id=?3)"
    };
    let mut statement = db.prepare(sql)?;
    let job = binding["analysisId"].as_str();
    let map_row = |r: &rusqlite::Row<'_>| {
        Ok((
            Fact {
                id: r.get(0)?,
                job: r.get(1)?,
                section: r.get(2)?,
                chunk: r.get(3)?,
                kind: r.get(4)?,
                subject: r.get(5)?,
                aliases: serde_json::from_str::<Value>(&r.get::<_, String>(6)?)
                    .ok()
                    .map(|v| strings(&v).into_iter().map(str::to_owned).collect())
                    .unwrap_or_default(),
                statement: r.get(7)?,
                quote: r.get(8)?,
                from: r.get(9)?,
                through: r.get(10)?,
                title: r.get(11)?,
                page: r.get(12)?,
            },
            r.get::<_, String>(13)?,
        ))
    };
    let collected: Vec<(Fact, String)> = if ignore_position {
        statement
            .query_map(params![book, through, job], map_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?
    } else {
        statement
            .query_map(params![book, through, job, position], map_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut selected = vec![];
    let mut seen = HashSet::new();
    for (fact, original) in collected {
        if !["person", "relation", "event", "rule"].contains(&fact.kind.as_str())
            || fact.section < from
            || fact.quote.trim().is_empty()
            || !original.contains(&fact.quote)
            || fact.from.is_some_and(|n| n < 0 || n > fact.section)
            || fact
                .through
                .is_some_and(|n| n < fact.from.unwrap_or(fact.section) || n > fact.section)
        {
            continue;
        }
        let score = fact.score(keys);
        if !all && score == 0 {
            continue;
        }
        let fingerprint = json!([
            fact.section,
            fact.chunk,
            fact.kind,
            fact.subject,
            fact.statement,
            fact.quote
        ])
        .to_string();
        if !seen.insert(fingerprint) {
            continue;
        }
        selected.push((fact, score));
    }
    selected.sort_by(|(a, x), (b, y)| {
        y.cmp(x)
            .then_with(|| {
                a.section
                    .abs_diff(position)
                    .cmp(&b.section.abs_diff(position))
            })
            .then_with(|| a.chunk.cmp(&b.chunk))
    });
    Ok(selected.into_iter().take(16).map(|(f, _)| f).collect())
}

fn prefix(text: &str, cap: usize) -> String {
    slice(text, 0, cap).0
}

/// Return a UTF-16 window, keeping both edges on Unicode scalar boundaries.
fn slice(text: &str, start: usize, end: usize) -> (String, usize, usize) {
    let mut boundaries = Vec::new();
    let mut at = 0;
    for (byte, c) in text.char_indices() {
        boundaries.push((at, byte));
        at += c.len_utf16();
    }
    boundaries.push((at, text.len()));
    let first = boundaries.partition_point(|(n, _)| *n < start.min(at));
    let last = boundaries
        .partition_point(|(n, _)| *n <= end.min(at))
        .saturating_sub(1)
        .max(first);
    let (start, from) = boundaries[first];
    let (end, to) = boundaries[last];
    (text[from..to].to_owned(), start, end)
}

fn lower_offsets(text: &str) -> (String, Vec<usize>) {
    let mut lower = String::new();
    let mut offsets = vec![];
    let mut at = 0;
    for c in text.chars() {
        let folded = c.to_lowercase().collect::<String>();
        offsets.extend(std::iter::repeat_n(at, folded.len()));
        lower.push_str(&folded);
        at += c.len_utf16();
    }
    offsets.push(at);
    (lower, offsets)
}

/// Prefer the highest-priority matching term; early generic bigrams cannot win.
fn window(text: &str, keys: &Keys, cap: usize) -> (String, usize, usize) {
    let length = units(text);
    let (lower, offsets) = lower_offsets(text);
    let mut candidates = BTreeSet::from([0]);
    for (key, _) in keys {
        for (at, _) in lower.match_indices(key).take(12) {
            candidates.insert(
                offsets[at]
                    .saturating_sub(cap / 2)
                    .min(length.saturating_sub(cap)),
            );
        }
    }
    let mut best = None;
    let mut best_score = 0;
    for start in candidates {
        let candidate = slice(text, start, (start + cap).min(length));
        let sample = candidate.0.to_lowercase();
        let mut highest = 0;
        let mut score = 0;
        for (key, weight) in keys {
            if sample.contains(key) {
                highest = highest.max(*weight);
                score += weight;
            }
        }
        score += highest * 10000;
        if best.is_none() || score > best_score {
            best = Some(candidate);
            best_score = score;
        }
    }
    best.unwrap_or_else(|| slice(text, 0, cap))
}

/// Notes guide writing but never enter `excerpts`, so reading one is not reading the original.
pub fn read_notes(db: &Connection, plan: &RunPlan, query: &str) -> Result<Value> {
    let book = plan.reading_source()["bookId"].as_str();
    let mut statement = db.prepare(
        "WITH RECURSIVE route(id,parent_id) AS (
            SELECT id,parent_id FROM nodes WHERE world_id=?2 AND id=?3
            UNION SELECT n.id,n.parent_id FROM nodes n JOIN route r ON n.id=r.parent_id WHERE n.world_id=?2
         )
         SELECT id,kind,title,scope_json,content,refs_json,world_id,'book' AS source,0 AS stale,updated_at
         FROM canon_notes WHERE book_id=?1 AND active=1 AND status='done' AND TRIM(content)<>'' AND (world_id IS NULL OR world_id=?2)
         UNION ALL
         SELECT id,kind,title,scope_json,content,refs_json,world_id,'story',json_extract(scope_json,'$.staleFrom') IS NOT NULL,updated_at
         FROM story_notes WHERE world_id=?2 AND active=1 AND status='done' AND TRIM(content)<>''
         AND (origin_world_id IS NOT NULL OR COALESCE(json_extract(progress_json,'$.routeNode'),json_extract(scope_json,'$.toNode'),'') IN ('',?3)
              OR EXISTS (SELECT 1 FROM route WHERE route.id=COALESCE(json_extract(progress_json,'$.routeNode'),json_extract(scope_json,'$.toNode'))))
         ORDER BY updated_at DESC, id"
    )?;
    let rows = statement
        .query_map(params![book, plan.world_id, plan.head_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, Option<String>>(6)?, r.get::<_, String>(7)?, r.get::<_, bool>(8)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let query = query.trim();
    let words: Vec<&str> = query.split(|c: char| c.is_whitespace() || "，、,；;。".contains(c)).filter(|w| !w.is_empty()).collect();
    let cleaned = without_request_words(query);
    let q_bigrams = terms(&cleaned);
    let mut keys = Vec::new();
    add(&mut keys, &cleaned, 4, 24);
    add(&mut keys, query, 2, 16);
    let through = plan.reading_source()["through"].as_u64();
    let range = scope_range(plan);
    let chosen = chosen_notes(plan);
    let rows: Vec<_> = rows.into_iter().filter(|(id,kind,_,scope,_,refs,world,source,_)| {
        if let Some(ids) = &chosen {
            if !ids.contains(id) { return false; }
            // In notes mode, `range` bounds original-text lookups only; never drop chosen story or empty-ref notes.
            return source == "story"
                || note_within_scope(kind,scope,refs,through,world.as_deref()==Some(plan.world_id.as_str()));
        }
        if source == "story" { return range.is_none(); }
        note_within_scope(kind,scope,refs,through,world.as_deref()==Some(plan.world_id.as_str()))
            && range.is_none_or(|(from, to)| note_within_range(kind,scope,refs,from,to))
    }).collect();
    let total = rows.len();
    let mut scored_rows: Vec<_> = rows
        .into_iter()
        .enumerate()
        .filter_map(|(order, row)| {
            if query.is_empty() {
                return Some((1u32, order, row));
            }
            let title_lower = row.2.to_lowercase();
            let hay_lower = format!("{}\n{}\n{}", row.2, row.3, row.4).to_lowercase();
            let mut score = 0u32;
            for w in &words {
                let wl = w.to_lowercase();
                if title_lower.contains(&wl) {
                    score += 6;
                } else if hay_lower.contains(&wl) {
                    score += 4;
                }
            }
            for bg in &q_bigrams {
                if title_lower.contains(bg) {
                    score += 3;
                } else if hay_lower.contains(bg) {
                    score += 1;
                }
            }
            (score > 0).then_some((score, order, row))
        })
        .collect();
    if !query.is_empty() {
        scored_rows.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    }
    let mut remaining = budget(plan);
    let mut notes = vec![];
    for (_, _, (id, kind, title, _scope, content, _, _, source, stale)) in scored_rows {
        // An empty query lists what exists; a query returns the notes themselves (or focused excerpts).
        let body = if query.is_empty() { slice(&content, 0, 160).0 } else { content.clone() };
        let value = json!({"id":id,"kind":kind,"title":title,"content":body,"source":source,"stale":stale,"partial":units(&body) < units(&content)});
        let size = cost(&value);
        if size > remaining {
            if remaining > 400 {
                let (excerpt_body, _, _) = window(&content, &keys, remaining - 200);
                let excerpt = json!({"id":id,"kind":kind,"title":title,"content":excerpt_body,"source":source,"stale":stale,"partial":true});
                let excerpt_size = cost(&excerpt);
                if excerpt_size <= remaining {
                    remaining -= excerpt_size;
                    notes.push(excerpt);
                    continue;
                }
            }
            break;
        }
        remaining -= size;
        notes.push(value);
    }
    Ok(json!({"bookId":book,"notes":notes,"total":total,"note":"札记可能有误，标为待更新的本局札记请核对当前路线。原著查证请阅读原文。"}))
}

/// A note about the chosen chapters only (D184).
fn note_within_range(kind: &str, scope: &str, refs: &str, from: i64, to: i64) -> bool {
    let refs: Value = serde_json::from_str(refs).unwrap_or(Value::Null);
    let Some(refs) = refs.as_array() else { return false; };
    if refs.is_empty() || refs.iter().any(|s| s.as_i64().is_none_or(|s| s < from || s > to)) { return false; }
    if matches!(kind, "plot" | "timeline") {
        let scope: Value = serde_json::from_str(scope).unwrap_or(Value::Null);
        scope["from"].as_i64().unwrap_or(0) >= from && scope["to"].as_i64().is_some_and(|t| t <= to)
    } else {
        true
    }
}

fn note_within_scope(kind: &str, scope: &str, refs: &str, through: Option<u64>, same_world: bool) -> bool {
    let Some(through) = through else { return true; };
    let refs: Value = serde_json::from_str(refs).unwrap_or(Value::Null);
    let Some(refs) = refs.as_array() else { return false; };
    if refs.iter().any(|s| s.as_u64().is_none_or(|s| s > through)) { return false; }
    if matches!(kind, "plot" | "timeline") {
        let scope: Value = serde_json::from_str(scope).unwrap_or(Value::Null);
        scope["to"].as_u64().is_some_and(|to| to <= through)
    } else {
        (!refs.is_empty() || kind == "question" && same_world) && refs.len() < 400
    }
}

fn budget(plan: &RunPlan) -> usize {
    let base = plan.meta["budgetChars"].as_u64().unwrap_or(12000);
    if plan.kind == "correction" {
        ((base / 3).min(10000)) as usize
    } else {
        ((base / 4).min(8000)) as usize
    }
}
fn read_budget(plan: &RunPlan, name: &str) -> usize {
    if name == "read_original" {
        let base = plan.meta["budgetChars"].as_u64().unwrap_or(12000);
        return ((base / 2).min(12000)) as usize;
    }
    budget(plan)
}
fn cost(value: &Value) -> usize {
    units(&value.to_string()) + 1
}

fn analysis_locator(
    db: &Connection,
    binding: &Value,
    original: &Value,
    keys: &Keys,
    remaining: &mut usize,
) -> Result<Option<Value>> {
    let Some(job) = binding["analysisId"]
        .as_str()
        .filter(|_| binding["method"] == "analysis")
    else {
        return Ok(None);
    };
    let raw: Option<String> = db.query_row("SELECT text FROM source_analysis WHERE job_id=? AND book_id=? AND ordinal=? AND section=?",
        params![job, original["bookId"].as_str(), original["chunk"].as_i64(), original["section"].as_i64()], |r| r.get(0)).optional()?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let structured: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let summary = if structured["version"] == "source-3" {
        structured["summary"].as_str().unwrap_or("")
    } else {
        &raw
    };
    let mut note = json!({"kind":"analysis","bookId":original["bookId"],"title":original["title"],"section":original["section"],"chunk":original["chunk"],"text":"",
        "note":"AI整理只辅助定位，本条不是原文，身份与关系须核对同块原文。"});
    let mut cap = remaining.saturating_sub(cost(&note)).min(1000);
    if cap < units(summary).min(80) {
        return Ok(None);
    }
    loop {
        let (text, _, _) = window(summary, keys, cap);
        if text.trim().is_empty() {
            return Ok(None);
        }
        note["text"] = text.into();
        let size = cost(&note);
        if size <= *remaining {
            *remaining -= size;
            return Ok(Some(note));
        }
        cap = cap.saturating_sub(size - *remaining);
        if cap < units(summary).min(80) {
            return Ok(None);
        }
    }
}

/// Source ranges and temporal note ranges are checked before any ranking.
pub fn read(store: &Store, plan: &RunPlan, name: &str, args: &Value) -> Result<Value> {
    let db=store.lock()?;
    // Only immutable, explicitly versioned reads are reusable. The result is still
    // returned through the ordinary tool message and normal evidence-delivery gate.
    if name=="read_original" && args["ref"]["bookVersion"].is_string() {
        let book=plan.reading_source()["bookId"].as_str().unwrap_or("");
        let has_index=db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='reference_index_versions'",[],|r|r.get::<_,i64>(0))?>0;
        let revision=if has_index{db.query_row("SELECT revision FROM reference_index_versions WHERE book_id=?",[book],|r|r.get::<_,i64>(0)).optional()?.unwrap_or(1)}else{1};
        let version=format!("{book}:{revision}");
        let has_run=db.query_row("SELECT EXISTS(SELECT 1 FROM execution_runs WHERE id=?)",[&plan.id],|r|r.get::<_,bool>(0))?;
        if has_run && db.query_row("SELECT EXISTS(SELECT 1 FROM source_books WHERE id=?)",[book],|r|r.get::<_,bool>(0))? && args["ref"]["bookId"]==book && args["ref"]["bookVersion"]==version {
            let key=format!("source-read:{}",crate::pi_store::arguments_hash(&json!([plan.reading_source(),version,plan.meta["budgetChars"],plan.meta["sourceScope"],args])));
            let cached:Option<String>=db.query_row("SELECT output_json FROM execution_steps WHERE run_id=? AND step_key=? AND status='done'",params![plan.id,key],|r|r.get(0)).optional()?;
            if let Some(raw)=cached{let mut value:Value=serde_json::from_str(&raw)?;value["cacheHit"]=true.into();return Ok(value);}
            let value=read_db(&db,plan,name,args)?;
            db.execute("INSERT OR REPLACE INTO execution_steps(run_id,step_key,kind,status,input_json,output_json) VALUES(?,?,'source-read','done',?,?)",params![plan.id,key,args.to_string(),value.to_string()])?;
            return Ok(value);
        }
    }
    read_db(&db, plan, name, args)
}

/// Shared source reader for native callers already holding a guarded story
/// transaction. It uses the same ranking, citation and chapter limits.
pub(crate) fn read_db(db: &Connection, plan: &RunPlan, name: &str, args: &Value) -> Result<Value> {
    // 资料范围 (D184): a request limited to chosen notes does not read the original;
    // the turn-level reference tools work on the whole allowed range, so they are off too.
    if notes_only(plan) && ["list_sections","search_original","read_original","read_canon_facts","locate_original_event","prepare_reference_check"].contains(&name) {
        return Err(Error::Invalid("这次只用你选的札记，不查原文；请依据札记作答，札记里没有的写明资料不足".into()));
    }
    if name == "list_sections" {
        return list_sections(db, plan, args);
    }
    if scope_range(plan).is_some() && ["locate_original_event","prepare_reference_check"].contains(&name) {
        return Err(Error::Invalid(format!("这次只查{}，请用 search_original 在这几节里检索", scope_words(scope_range(plan)))));
    }
    if ["locate_original_event","prepare_reference_check"].contains(&name) { return crate::reference_lookup::read(db,plan,name,args); }
    if name=="preview_turn_record" { return crate::reference_lookup::preview_record(plan,args); }
    let mut resolved=args.clone();
    if name=="read_original" && args["ref"].is_object() {
        let r=&args["ref"];if !r["section"].is_u64() || !r["chunk"].is_u64() {return Err(Error::Invalid("原文定位需要section和chunk，请重新检索".into()));}let book=plan.reading_source()["bookId"].as_str().unwrap_or("");
        if r["bookId"]!=book{return Err(Error::Invalid("原文定位不属于本局绑定书籍".into()));}
        if let Some(version)=r["bookVersion"].as_str(){
            let exists=db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='reference_index_versions'",[],|r|r.get::<_,i64>(0))?>0;
            let revision=if exists{db.query_row("SELECT revision FROM reference_index_versions WHERE book_id=?",[book],|r|r.get::<_,i64>(0)).optional()?.unwrap_or(1)}else{1};
            if version!=format!("{book}:{revision}"){return Err(Error::Invalid("原文版本已经改变，请重新检索后读取".into()));}
        }
        for field in ["section","chunk","start","end"]{if !r[field].is_null(){resolved[field]=r[field].clone();}}
    }
    let args=&resolved;
    if !["search_original", "read_original", "read_canon_facts"].contains(&name) {
        return Err(Error::Invalid("没有这个原著工具".into()));
    }
    let binding = plan.reading_source();
    let Some(book) = binding["bookId"].as_str() else {
        return Ok(json!({"status":"insufficient","reason":"未绑定参考书籍","excerpts":[]}));
    };
    let meta:Option<(String,Option<i64>)>=db.query_row("SELECT b.title,MAX(s.section) FROM source_books b LEFT JOIN source_sections s ON s.book_id=b.id WHERE b.id=? GROUP BY b.id",[book],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((title, Some(last))) = meta else {
        return Ok(
            json!({"status":"insufficient","reason":"参考书籍不存在或没有正文","excerpts":[]}),
        );
    };
    let range = scope_range(plan);
    let allowed = binding["through"].as_i64().unwrap_or(last).min(last);
    let max_through = range.map_or(allowed, |(_, to)| to.min(allowed));
    let min_from = range.map_or(0, |(from, _)| from);
    let mut from = min_from;
    let mut through = max_through;
    if name == "search_original" {
        if let Some(arg_from) = args["from"].as_i64() {
            if arg_from > max_through {
                return Err(Error::Invalid(if range.is_some() { format!("这次只查{}，起始节号超出范围", scope_words(range)) } else { "起始节号超出了本局允许的参考范围".into() }));
            }
            from = from.max(arg_from);
        }
        if let Some(arg_to) = args["to"].as_i64() {
            if arg_to < min_from {
                return Err(Error::Invalid("结束节号不在允许范围内".into()));
            }
            through = through.min(arg_to);
        }
    }
    if through < 0 || from > through {
        return Err(Error::Invalid("原著参考范围无效".into()));
    }
    let position = binding["position"].as_i64().unwrap_or(0).clamp(from, through);
    let raw_query = args["query"].as_str().unwrap_or("").trim();
    let ignore_position = matches!(plan.kind.as_str(), "correction" | "ask");
    let mut keys = query_keys(plan, args);
    let notes = facts(
        db,
        book,
        binding,
        from,
        through,
        position,
        &keys,
        name == "read_canon_facts" && raw_query.is_empty(),
        ignore_position,
    )?;
    if name == "read_canon_facts" {
        let mut remaining = budget(plan);
        let mut fitted = vec![];
        for note in notes {
            let value = note.value(book, position);
            let size = cost(&value);
            if size <= remaining {
                remaining -= size;
                fitted.push(value);
            }
        }
        // No status=insufficient here: absent AI notes do not mean the book lacks evidence.
        return Ok(
            json!({"bookId":book,"title":title,"through":through,"position":position,"facts":fitted,
            "note":"人物资料和摘要只辅助定位，不代表已读原文；没有整理资料时仍应搜索并阅读原文。较早身份须核对后续变化，人物知情范围按本局正文判断。"}),
        );
    }
    let cleaned_query = without_request_words(raw_query);
    let explicit_terms: HashSet<String> = {
        let mut set: HashSet<String> = terms(&cleaned_query).into_iter().collect();
        if set.is_empty() {
            set.extend(terms(raw_query));
        }
        set
    };
    let explicit_mode = name == "search_original" && !raw_query.is_empty();
    let mut fact_alias_terms = HashSet::new();
    for note in &notes {
        let note_matches_explicit = !explicit_mode || {
            let identity = format!("{}\n{}", note.subject, note.aliases.join("\n")).to_lowercase();
            let stmt_lower = note.statement.to_lowercase();
            explicit_terms.iter().any(|t| identity.contains(t) || stmt_lower.contains(t))
                || identity.contains(&raw_query.to_lowercase())
        };
        if !note_matches_explicit {
            continue;
        }
        for key in terms(&format!("{}\n{}", note.subject, note.aliases.join("\n"))) {
            fact_alias_terms.insert(key.clone());
            if let Some((_, weight)) = keys.iter_mut().find(|(k, _)| *k == key) {
                *weight = (*weight).max(3);
            } else if keys.len() < 480 {
                keys.push((key, 3));
            }
        }
    }
    let mut statement =
        db.prepare("SELECT ordinal,section FROM source_chunks WHERE book_id=? AND section>=? AND section<=?")?;
    let scope = statement
        .query_map(params![book, from, through], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<HashMap<i64, i64>, _>>()?;
    let mut scores = HashMap::<i64, f64>::new();
    let mut bg_scores = HashMap::<i64, f64>::new();
    let mut explicit_hits = HashMap::<i64, usize>::new();
    let query_terms: HashSet<String> = terms(raw_query).into_iter().collect();
    let (mut inside, mut outside) = (HashMap::<i64, usize>::new(), HashMap::<i64, usize>::new());
    // A word in a large share of the allowed text says little about where to look.
    let common = (scope.len() * 15 / 100).max(8);
    let search_offset = if name == "search_original" { args["offset"].as_u64().unwrap_or(0) as usize } else { 0 };
    if name == "search_original" {
        if !keys.is_empty() {
            let placeholders = vec!["?"; keys.len()].join(",");
            let mut values = vec![book.to_owned()];
            values.extend(keys.iter().map(|(term, _)| term.clone()));
            let mut stmt = db.prepare(&format!("SELECT term,postings FROM source_terms WHERE book_id=? AND term IN ({placeholders})"))?;
            let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (term, raw) = row?;
                let mut weight = keys.iter().find(|(key, _)| key == &term).map(|(_, w)| *w).unwrap_or(1);
                let postings = serde_json::from_str::<Vec<i64>>(&raw).unwrap_or_default();
                let is_explicit = explicit_terms.contains(&term) || fact_alias_terms.contains(&term);
                if query_terms.contains(&term) {
                    for id in &postings {
                        *(if scope.contains_key(id) { &mut inside } else { &mut outside }).entry(*id).or_default() += 1;
                    }
                }
                let allowed_postings = postings.into_iter().filter(|n| scope.contains_key(n)).collect::<Vec<_>>();
                if allowed_postings.is_empty() {
                    continue;
                }
                if allowed_postings.len() > common {
                    // Explicit query terms keep weight >= 3 so core character names aren't flattened to noise.
                    weight = if is_explicit { weight.min(3) } else { weight.min(1) };
                }
                let score = weight as f64 / (allowed_postings.len() as f64).sqrt();
                if explicit_mode && !is_explicit {
                    for id in allowed_postings {
                        *bg_scores.entry(id).or_default() += score;
                    }
                } else {
                    for id in allowed_postings {
                        *scores.entry(id).or_default() += score;
                        if is_explicit {
                            *explicit_hits.entry(id).or_default() += 1;
                        }
                    }
                }
            }
        }
        // Single-character or punctuation-stripped queries that yield 0 bigrams still match verbatim chunks.
        if explicit_mode && explicit_terms.is_empty() {
            let mut stmt = db.prepare("SELECT ordinal FROM source_chunks WHERE book_id=? AND section>=? AND section<=? AND instr(lower(text), lower(?)) > 0 LIMIT 48")?;
            for row in stmt.query_map(params![book, from, through, raw_query], |r| r.get::<_, i64>(0))? {
                let id = row?;
                *scores.entry(id).or_default() += 6.0;
                *explicit_hits.entry(id).or_default() += 1;
            }
        }
        for note in &notes {
            if scope.contains_key(&note.chunk) {
                let target = if explicit_mode && !scores.contains_key(&note.chunk) { &mut bg_scores } else { &mut scores };
                *target.entry(note.chunk).or_default() += 2.0;
            }
        }
        let mut stmt = db.prepare("SELECT section,title FROM source_sections WHERE book_id=? AND section>=? AND section<=?")?;
        let titles = stmt.query_map(params![book, from, through], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
        let lower_titles: Vec<(i64, String, String)> = titles.into_iter().map(|(s, t)| (s, t.to_lowercase(), t)).collect();
        if explicit_mode {
            // Direct chapter-title / chapter-number match (e.g. “第三十五章” or “35 渡口”).
            let matched_chapters: Vec<i64> = lower_titles.iter().filter(|(s, _, orig)| chapter_query_matches(*s, orig, raw_query)).map(|(s, _, _)| *s).collect();
            if !matched_chapters.is_empty() {
                let boost = 12.0 / (matched_chapters.len() as f64).sqrt();
                for (&id, &s) in &scope {
                    if matched_chapters.contains(&s) {
                        *scores.entry(id).or_default() += boost;
                        *explicit_hits.entry(id).or_default() += 1;
                    }
                }
            }
            for term in &explicit_terms {
                let matched_secs: Vec<i64> = lower_titles.iter().filter(|(_, lower, _)| lower.contains(term)).map(|(s, _, _)| *s).collect();
                if matched_secs.is_empty() { continue; }
                let boost = 10.0 / (matched_secs.len() as f64).sqrt();
                for (&id, &s) in &scope {
                    if matched_secs.contains(&s) {
                        *scores.entry(id).or_default() += boost;
                        *explicit_hits.entry(id).or_default() += 1;
                    }
                }
            }
            // Multi-term coverage bonus + gentle tie-breaking from background context ONLY on chunks that actually matched.
            for (id, score) in scores.iter_mut() {
                let hits = explicit_hits.get(id).copied().unwrap_or(1);
                *score *= 1.0 + 0.35 * (hits.saturating_sub(1) as f64);
                if let Some(bg) = bg_scores.get(id) {
                    *score += (*bg).min(1.5);
                }
            }
        } else {
            for (key, weight) in &keys {
                let matched_secs: Vec<i64> = lower_titles.iter().filter(|(_, lower, _)| lower.contains(key)).map(|(s, _, _)| *s).collect();
                if matched_secs.is_empty() { continue; }
                let boost = (*weight as f64 * 2.0) / (matched_secs.len() as f64).sqrt();
                for (&id, &s) in &scope {
                    if matched_secs.contains(&s) {
                        *scores.entry(id).or_default() += boost;
                    }
                }
            }
        }
    } else {
        let section = args["section"]
            .as_i64()
            .ok_or_else(|| Error::Invalid("请指定要读的节号 section（从 0 开始）".into()))?;
        if section < 0 || section > through || section < from {
            return Err(Error::Invalid(if range.is_some() { format!("这次只查{}，这段原文不在范围里", scope_words(range)) } else { "这段原文超出了本局允许的参考范围".into() }));
        }
        if let Some(value) = args.get("chunk") {
            let chunk = value
                .as_i64()
                .ok_or_else(|| Error::Invalid("原著片段序号无效".into()))?;
            if scope.get(&chunk) != Some(&section) {
                return Err(Error::Invalid("片段不属于指定章节或已超范围".into()));
            }
            let neighbors = match args.get("neighbors") {
                Some(n) => n
                    .as_u64()
                    .filter(|n| *n <= 2)
                    .ok_or_else(|| Error::Invalid("邻近片段数量应为 0 至 2".into()))?,
                None => 1,
            };
            for (&id, &s) in &scope {
                if s <= through && id.abs_diff(chunk) <= neighbors {
                    scores.insert(id, 10.0 - id.abs_diff(chunk) as f64);
                }
            }
        } else {
            let mut ids: Vec<_> = scope
                .iter()
                .filter(|(_, s)| **s == section)
                .map(|(id, _)| *id)
                .collect();
            ids.sort_unstable();
            for id in ids.into_iter().take(3) {
                scores.insert(id, 1.0);
            }
        }
    }
    // On ordinary turns (not whole-book lookups or explicit chapter ranges), favor passages near the current book position.
    if name == "search_original" && !ignore_position && range.is_none() {
        for (id, score) in scores.iter_mut() {
            let dist = scope.get(id).map_or(0, |s| s.abs_diff(position)) as f64;
            *score *= 1.0 + 0.9 / (1.0 + dist / 6.0);
        }
    }
    let mut ranked: Vec<_> = scores.into_iter().collect();
    ranked.sort_by(|(a, x), (b, y)| {
        y.total_cmp(x)
            .then_with(|| {
                scope[a]
                    .abs_diff(position)
                    .cmp(&scope[b].abs_diff(position))
            })
            .then_with(|| a.cmp(b))
    });
    let total_hits = ranked.len();
    let mut ids: Vec<i64> = ranked.into_iter().skip(search_offset).take(48).map(|(id, _)| id).collect();
    // Nothing matched: the passage at the current position, marked as such, so it
    // is not mistaken for a hit (R30 step 3).
    let mut nearby_only = false;
    if name == "search_original" && search_offset == 0 {
        if let Some(nearby) = scope
            .iter()
            .filter(|(_, s)| **s == position)
            .map(|(id, _)| *id)
            .min()
        {
            if ids.is_empty() {
                ids.retain(|id| *id != nearby);
                ids.insert(1.min(ids.len()), nearby);
                nearby_only = true;
            }
        }
    }
    let best = |counts: &HashMap<i64, usize>| counts.values().copied().max().unwrap_or(0);
    let wanted = query_terms.len();
    let beyond_scope = name == "search_original" && wanted > 0
        && best(&outside) >= 2.max((wanted * 6).div_ceil(10)) && best(&outside) > best(&inside);
    let mut remaining = read_budget(plan, name);
    let mut excerpts = vec![];
    let mut analysis = vec![];
    let mut budget_limited = false;
    let mut window_keys = keys.clone();
    if explicit_mode {
        window_keys = explicit_terms.iter().map(|t| (t.clone(), 8)).collect();
        for (k, w) in &keys {
            if !explicit_terms.contains(k) {
                window_keys.push((k.clone(), (*w).min(2)));
            }
        }
    }
    for id in ids.iter().copied().take(5) {
        let (section,text,label,page):(i64,String,String,Option<i64>)=db.query_row("SELECT c.section,c.text,s.title,s.page FROM source_chunks c JOIN source_sections s ON s.book_id=c.book_id AND s.section=c.section WHERE c.book_id=? AND c.ordinal=? AND c.section<=?",params![book,id,through],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        let mut excerpt = json!({"kind":"original","bookId":book,"title":label,"section":section,"chunk":id,"start":0,"end":0,"text":""});
        if nearby_only {
            excerpt["match"] = "nearby".into();
        }
        if let Some(page) = page {
            excerpt["page"] = page.into();
        }
        let overhead = cost(&excerpt) + 12;
        let mut cap = remaining.saturating_sub(overhead);
        cap = cap.min(if name == "search_original" {
            1200
        } else {
            2400
        });
        if cap < units(&text).min(80) {
            budget_limited = true;
            break;
        }
        loop {
            let mut focus_keys = window_keys.clone();
            if name=="read_original" && args["chunk"]==id {
                if let Some(start)=args["start"].as_u64(){let focus=utf16_slice(&text,start as usize,args["end"].as_u64().unwrap_or(start+200) as usize);add(&mut focus_keys,&focus,20,80);}
            }
            let (sample, start, end) = window(&text, &focus_keys, cap);
            if sample.trim().is_empty() {
                break;
            }
            excerpt["text"] = sample.into();
            excerpt["start"] = start.into();
            excerpt["end"] = end.into();
            let size = cost(&excerpt);
            if size <= remaining {
                remaining -= size;
                if excerpts.is_empty() {
                    if let Some(locator) =
                        analysis_locator(db, binding, &excerpt, &window_keys, &mut remaining)?
                    {
                        analysis.push(locator);
                    }
                }
                excerpts.push(excerpt);
                break;
            }
            cap = cap.saturating_sub(size - remaining);
            if cap < units(&text).min(80) {
                budget_limited = true;
                break;
            }
        }
    }
    let ready = !excerpts.is_empty();
    let mut output =
        json!({"bookId":book,"title":title,"through":through,"position":position,"status":if ready {"ready"} else {"insufficient"},"excerpts":excerpts,"notes":analysis,
        "reason":if ready {Value::Null} else if budget_limited {json!("budget")} else {json!("no_match")},
        "note":"这些是实际原著正文，不是本局已经发生的事实。原文优先于整理和模型记忆；按出处及当前原著位置判断身份变化，较早身份须复核，角色只能知道本局获知的事。玩家明确改写与合理后果保留，AI自行写错不算玩家改写。"});
    if name == "search_original" && !nearby_only {
        output["totalHits"] = total_hits.into();
        let shown = output["excerpts"].as_array().map(Vec::len).unwrap_or(0);
        let next_off = search_offset + shown;
        if next_off < total_hits {
            output["nextOffset"] = next_off.into();
            let mut more = vec![];
            for id in ids.iter().copied().skip(shown).take(8) {
                if let Ok((sec, sec_title)) = db.query_row(
                    "SELECT c.section, s.title FROM source_chunks c JOIN source_sections s ON s.book_id=c.book_id AND s.section=c.section WHERE c.book_id=? AND c.ordinal=?",
                    params![book, id],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                ) {
                    more.push(json!({"section": sec, "chunk": id, "title": sec_title}));
                }
            }
            if !more.is_empty() {
                output["moreMatches"] = more.into();
            }
        }
    }
    if nearby_only {
        output["match"] = "nearby".into();
        output["note"] = "没有找到和查询词对应的原文；下面只是当前原著位置附近的一段，不能当作查到的依据。".into();
    }
    if beyond_scope {
        // Where it is, not what it says: the text past the limit stays out (R30 step 3).
        output["beyondScope"] = true.into();
        output["scopeNote"] = if range.is_some() {
            format!("查询词在{}以外的原文里更集中，超出了这次选的资料范围。", scope_words(Some((from, through))))
        } else {
            format!("查询词在第 {} 节之后的原文里更集中，超出了本局允许的参考范围。", through + 1)
        }.into();
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn setup(sections: &[String]) -> (Store, RunPlan) {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migration::migrate(&mut db,None).unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        store.initialize().unwrap();
        let plan:RunPlan=serde_json::from_value(json!({"id":"sources-test","worldId":"world","lineId":"line","headId":"head","baseId":"head","kind":"turn","executionMode":"classic","model":{"slot":"unused","url":"https://test.invalid/v1","model":"mock","auxModel":null,"includeUsage":false,"maxTokens":null},"messages":[],"extractMessages":[],"state":{"source":{"bookId":"book","through":null,"position":0,"instructions":""},"protagonist":{"name":"旅人"},"people":[],"places":[]},"settings":{},"options":{},"action":{"mode":"continue","text":""},"meta":{"budgetChars":12000},"reference":null,"original":"","carriedEdits":[],"trailingIds":[],"newWorld":null})).unwrap();
        {
            let db = store.lock().unwrap();
            db.execute(
                "INSERT INTO source_books VALUES('book','隔离原著','txt','test','{}')",
                [],
            )
            .unwrap();
            db.execute(
                "INSERT INTO source_jobs VALUES('job','book','{}','test')",
                [],
            )
            .unwrap();
            let mut index = HashMap::<String, Vec<i64>>::new();
            let mut ordinal = 0;
            for (section, body) in sections.iter().enumerate() {
                db.execute(
                    "INSERT INTO source_sections VALUES('book',?,?,NULL)",
                    params![section as i64, format!("第{}章", section + 1)],
                )
                .unwrap();
                let mut start = 0;
                while start < units(body) {
                    let (text, _, end) = slice(body, start, start + 2400);
                    db.execute(
                        "INSERT INTO source_chunks VALUES('book',?,?,?)",
                        params![ordinal, section as i64, text],
                    )
                    .unwrap();
                    for term in terms(&text) {
                        index.entry(term).or_default().push(ordinal);
                    }
                    ordinal += 1;
                    start = end;
                }
            }
            for (term, ids) in index {
                db.execute(
                    "INSERT INTO source_terms VALUES('book',?,?)",
                    params![term, json!(ids).to_string()],
                )
                .unwrap();
            }
        }
        (store, plan)
    }

    fn add_fact(
        store: &Store,
        section: i64,
        chunk: i64,
        subject: &str,
        alias: &str,
        quote: &str,
        from: i64,
        through: Option<i64>,
    ) {
        store.lock().unwrap().execute("INSERT INTO canon_facts(id,book_id,job_id,section,chunk,kind,subject,aliases_json,statement,quote,valid_from,valid_through) VALUES(?,'book','job',?,?,'person',?,?,?, ?,?,?)",params![format!("{section}-{alias}"),section,chunk,subject,json!([alias]).to_string(),format!("{subject}又称{alias}"),quote,from,through]).unwrap();
    }

    #[test]
    fn long_canon_note_tool_can_read_a_match_after_the_opening_pages() {
        let (store, plan) = setup(&["短原文".into()]);
        let db = store.lock().unwrap();
        let content = "旧章梗概。".repeat(4800) + "后章才发现青铜钥匙。";
        db.execute("INSERT INTO canon_notes(id,book_id,world_id,kind,title,scope_json,content,refs_json,model,status,active,progress_json,created_at,updated_at) VALUES('n','book',NULL,'plot','长札记','{\"from\":0,\"to\":0}',?,'[]','','done',1,'{}','t','t')", [&content]).unwrap();
        let result = read_notes(&db, &plan, "青铜钥匙").unwrap();
        let note = &result["notes"][0];
        assert!(note["content"].as_str().unwrap().contains("后章才发现青铜钥匙"));
        assert_eq!(note["partial"], true);
        assert!(result.get("excerpts").is_none());
    }

    #[test]
    fn versioned_source_reads_reuse_only_the_same_run_and_chapter_scope() {
        let (store,mut plan)=setup(&["甲在桥边交回密信。".into()]);
        store.lock().unwrap().execute("INSERT INTO execution_runs(id,world_id,line_id,base_head_id,status,plan_json,budget_json,draft_json,created_at,updated_at) VALUES(?,'world','line','head','running','{}','{}','{}','test','test')",[&plan.id]).unwrap();
        let args=json!({"ref":{"bookId":"book","bookVersion":"book:1","section":0,"chunk":0}});
        let first=read(&store,&plan,"read_original",&args).unwrap();assert_ne!(first["cacheHit"],true);
        let second=read(&store,&plan,"read_original",&args).unwrap();assert_eq!(second["cacheHit"],true);assert_eq!(first["excerpts"],second["excerpts"]);
        plan.state["source"]["through"]=0.into();assert_ne!(read(&store,&plan,"read_original",&args).unwrap()["cacheHit"],true);
        store.lock().unwrap().execute_batch("CREATE TABLE IF NOT EXISTS reference_index_versions(book_id TEXT PRIMARY KEY,revision INTEGER);INSERT OR REPLACE INTO reference_index_versions(book_id,revision) VALUES('book',2)").unwrap();
        assert!(read(&store,&plan,"read_original",&args).is_err());
    }

    #[test]
    fn rewriting_reads_the_current_reference_scope_instead_of_the_old_base_scope() {
        let (store, mut plan) = setup(&["青玉佩藏在竹匣。".into(), "后日青玉佩交给掌门。".into()]);
        plan.kind = "variant".into();
        plan.meta["generationSnapshot"] = true.into();
        plan.meta["sourceGuard"] = plan.state["source"].clone();
        plan.meta["sourceGuard"]["through"] = 0.into();
        let later = json!({"section":1,"chunk":1});
        assert!(read(&store, &plan, "read_original", &later).is_err());
        let early = json!({"section":0,"chunk":0});
        assert!(read(&store, &plan, "read_original", &early).is_ok());
        let location = read(&store, &plan, "locate_original_event", &json!({"query":"青玉佩"})).unwrap();
        assert_eq!(location["through"], 0);

        plan.meta["sourceGuard"] = Value::Null;
        let unbound = read(&store, &plan, "read_original", &early).unwrap();
        assert_eq!(unbound["status"], "insufficient");
        assert_eq!(unbound["excerpts"], json!([]));
        let location = read(&store, &plan, "locate_original_event", &json!({"query":"青玉佩"})).unwrap();
        assert_eq!(location["status"], "insufficient");
        assert_eq!(location["items"], json!([]));
    }

    #[test]
    fn cached_candidates_keep_scope_and_reject_stale_or_incomplete_refs() {
        let (store,mut plan)=setup(&["青玉佩藏在竹匣。".into(),"后日青玉佩交给掌门。".into()]);
        plan.state["source"]["through"]=0.into();
        let first=read(&store,&plan,"locate_original_event",&json!({"query":"青玉佩"})).unwrap();
        let r=first["items"][0]["candidates"][0]["ref"].clone();assert_eq!(r["section"],0);
        let second=read(&store,&plan,"locate_original_event",&json!({"query":"青玉佩"})).unwrap();assert_eq!(second["cached"],true);
        let original=read(&store,&plan,"read_original",&json!({"ref":r,"neighbors":2})).unwrap();assert!(original["excerpts"].as_array().unwrap().iter().all(|p|p["section"]==0));
        store.lock().unwrap().execute("UPDATE source_chunks SET text=text||'版本变化' WHERE book_id='book' AND ordinal=0",[]).unwrap();
        assert!(read(&store,&plan,"read_original",&json!({"ref":r})).unwrap_err().to_string().contains("版本"));
        assert!(read(&store,&plan,"read_original",&json!({"ref":{"bookId":"book"}})).is_err());
        assert!(read(&store,&plan,"prepare_reference_check",&json!({"claims":["青玉佩",null]})).is_err());
    }
    #[test]
    fn late_priority_hit_keeps_utf16_offsets_and_respects_the_quarter_budget() {
        let text = format!(
            "普通背景{}青铜钥匙藏在灯座下。{}",
            "😀雨".repeat(600),
            "雪".repeat(200)
        );
        let (store, mut plan) = setup(&[text.clone()]);
        plan.action["text"] = json!("普通背景");
        plan.meta["rewriteHint"] = json!("核对青铜钥匙");
        let result = read(&store, &plan, "search_original", &json!({})).unwrap();
        assert_eq!(result["status"], "ready");
        let excerpt = &result["excerpts"][0];
        let start = excerpt["start"].as_u64().unwrap() as usize;
        let end = excerpt["end"].as_u64().unwrap() as usize;
        assert!(excerpt["text"]
            .as_str()
            .unwrap()
            .contains("青铜钥匙藏在灯座下"));
        assert_eq!(slice(&text, start, end).0, excerpt["text"]);
        assert!(!excerpt["text"].as_str().unwrap().contains('\u{fffd}'));
        assert!(cost(excerpt) <= budget(&plan));
        plan.meta["budgetChars"] = json!(300);
        let tight = read(&store, &plan, "search_original", &json!({})).unwrap();
        assert_eq!(tight["status"], "insufficient");
        assert!(tight["excerpts"].as_array().unwrap().is_empty());
    }

    #[test]
    fn chapter_filter_precedes_rank_and_neighbor_reads_cannot_cross_it() {
        let mut sections = vec![format!("{}青龙在药铺行医。", "雨".repeat(2400))];
        sections.extend((0..60).map(|_| "青龙终章秘密。".to_owned()));
        let (store, mut plan) = setup(&sections);
        plan.state["source"]["through"] = json!(0);
        let result = read(
            &store,
            &plan,
            "search_original",
            &json!({"query":"青龙终章"}),
        )
        .unwrap();
        let excerpts = result["excerpts"].as_array().unwrap();
        assert!(excerpts.iter().all(|p| p["section"] == 0));
        assert!(excerpts
            .iter()
            .any(|p| p["text"].as_str().unwrap().contains("青龙在药铺行医")));
        assert!(!result.to_string().contains("终章秘密"));
        let read_back = read(
            &store,
            &plan,
            "read_original",
            &json!({"section":0,"chunk":1,"neighbors":2}),
        )
        .unwrap();
        assert!(read_back["excerpts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["section"] == 0));
        assert!(read(&store, &plan, "read_original", &json!({"section":1})).is_err());
        assert!(read(
            &store,
            &plan,
            "read_original",
            &json!({"section":0,"chunk":2})
        )
        .is_err());
        assert!(read(
            &store,
            &plan,
            "read_original",
            &json!({"section":0,"chunk":1,"neighbors":3})
        )
        .is_err());
    }

    #[test]
    fn scoped_aliases_are_arrays_and_old_or_future_identity_does_not_expand_the_query() {
        let sections = vec![
            "沈青字子安，尚是学徒。".into(),
            "沈青善辨药性，受任医官。".into(),
            "沈青后来继任掌门，号玄影。".into(),
        ];
        let (store, mut plan) = setup(&sections);
        add_fact(&store, 0, 0, "沈青", "子安", "沈青字子安", 0, Some(0));
        add_fact(
            &store,
            2,
            2,
            "沈青",
            "玄影",
            "沈青后来继任掌门，号玄影。",
            2,
            None,
        );
        // A broken quote must not become a trusted locator even if a row exists.
        add_fact(
            &store,
            0,
            0,
            "伪造",
            "无据别名",
            "别章和本章均没有这句话",
            0,
            None,
        );
        let early = read(&store, &plan, "read_canon_facts", &json!({"query":"子安"})).unwrap();
        assert_eq!(early["facts"][0]["aliases"], json!(["子安"]));
        assert_eq!(early["facts"][0]["quote"], "沈青字子安");
        assert!(early["facts"][0].get("bookId").is_some());
        assert_eq!(early["facts"][0]["title"], "第1章");
        {
            let summary = json!({"version":"source-3","summary":"人物：沈青字子安。","facts":[{"quote":"这段JSON不是原文"}]}).to_string();
            store
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO source_analysis VALUES('job','book',0,0,?)",
                    [summary],
                )
                .unwrap();
        }
        plan.state["source"]["method"] = json!("analysis");
        plan.state["source"]["analysisId"] = json!("job");
        let with_notes = read(&store, &plan, "search_original", &json!({"query":"子安"})).unwrap();
        assert_eq!(with_notes["notes"][0]["text"], "人物：沈青字子安。");
        assert!(with_notes["excerpts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["kind"] == "original" && !p["text"].as_str().unwrap().contains("这段JSON")));
        plan.state["source"]["position"] = json!(1);
        assert!(
            read(&store, &plan, "read_canon_facts", &json!({"query":"子安"})).unwrap()["facts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            read(&store, &plan, "read_canon_facts", &json!({"query":"玄影"})).unwrap()["facts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let keys = query_keys(&plan, &json!({"query":"玄影"}));
        assert!(facts(
            &store.lock().unwrap(),
            "book",
            &plan.state["source"],
            0,
            2,
            1,
            &keys,
            false,
            false,
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            facts(
                &store.lock().unwrap(),
                "book",
                &plan.state["source"],
                0,
                2,
                1,
                &keys,
                false,
                true,
            )
            .unwrap()
            .len(),
            1
        );
        plan.state["source"]["position"] = json!(2);
        assert_eq!(
            read(&store, &plan, "read_canon_facts", &json!({"query":"玄影"})).unwrap()["facts"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        plan.state["source"]["through"] = json!(1);
        assert!(
            read(&store, &plan, "read_canon_facts", &json!({"query":"玄影"})).unwrap()["facts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(read(
            &store,
            &plan,
            "read_canon_facts",
            &json!({"query":"无据别名"})
        )
        .unwrap()["facts"]
            .as_array()
            .unwrap()
            .is_empty());
        // The complete instruction tail and current character aliases participate.
        plan.state["source"]["instructions"] = json!(format!(
            "{}核对青铜钥匙的梅花纹样。",
            "普通说明".repeat(1200)
        ));
        plan.state["people"] = json!([{"name":"阿青","aliases":["沈青"]}]);
        let keys = query_keys(&plan, &json!({}));
        assert!(keys.iter().any(|(k, _)| k == "梅花"));
        assert!(keys.iter().any(|(k, _)| k == "沈青"));
    }

    /// Twelve chapters that share a filler line and differ by seven characters each.
    fn following_book() -> (Store, Vec<String>) {
        let pool: Vec<char> = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥金木水火土日月星云雷电霜雨露江河湖海山川林泉松柏梅兰竹菊龙虎凤鹤狮象豹鹿琴棋书画笔墨纸砚剑刀枪戟弓箭盾冠带袍靴珠玉翠珀铜铁锡银".chars().collect();
        let marks: Vec<String> = (0..12).map(|i| pool[i * 7..i * 7 + 7].iter().collect()).collect();
        let sections: Vec<String> = marks.iter().map(|m| format!("他走在路上看见风雪。{m}。他走在路上看见风雪。")).collect();
        let (store, _) = setup(&sections);
        (store, marks)
    }

    #[test]
    fn book_position_follows_the_passage_forward_only_and_at_most_five_chapters() {
        let (store, marks) = following_book();
        let db = store.lock().unwrap();
        let binding = |position: i64, plot: &str| json!({"bookId":"book","fanfic":true,"plot":plot,"position":position,"through":null});
        let passage = |i: usize| format!("他走在路上看见风雪，忽然想起{}。", marks[i]);
        assert_eq!(follow_position(&db, &binding(3, "canon"), &passage(7)).unwrap(), Some(5), "at most two sections at a time");
        assert_eq!(follow_position(&db, &binding(0, "canon"), &passage(9)).unwrap(), Some(2), "at most two sections at a time");
        assert_eq!(follow_position(&db, &binding(3, "canon"), &passage(2)).unwrap(), None, "never backwards");
        assert_eq!(follow_position(&db, &binding(3, "canon"), &passage(3)).unwrap(), None, "still in the same chapter");
        assert_eq!(follow_position(&db, &binding(3, "rewrite"), &passage(7)).unwrap(), None, "a rewritten plot is left alone");
        assert_eq!(follow_position(&db, &binding(3, "canon"), "他走在路上看见风雪。").unwrap(), None, "nothing distinctive");
        let limited = json!({"bookId":"book","fanfic":true,"plot":"canon","position":3,"through":5});
        assert_eq!(follow_position(&db, &limited, &passage(7)).unwrap(), None, "past the reading limit");
    }

    /// Thirty chapters; every one mentions 核对 (the request word), one mentions 比试.
    fn ranged_book() -> (Store, RunPlan) {
        let sections: Vec<String> = (0..12).map(|i| format!("第{i}章：青铜钥匙在第{i}章出现，众人议论钥匙的来历。")).collect();
        setup(&sections)
    }

    #[test]
    fn a_chosen_range_of_chapters_limits_search_reading_and_facts() {
        let (store, mut plan) = ranged_book();
        plan.meta["sourceScope"] = json!({"mode":"chapters","from":4,"to":6});
        add_fact(&store, 2, 2, "铜匠", "老铜", "第2章：青铜钥匙", 2, None);
        add_fact(&store, 5, 5, "锁匠", "老锁", "第5章：青铜钥匙", 5, None);
        let db = store.lock().unwrap();
        let found = read_db(&db, &plan, "search_original", &json!({"query":"青铜钥匙"})).unwrap();
        let sections: Vec<i64> = found["excerpts"].as_array().unwrap().iter().map(|e| e["section"].as_i64().unwrap()).collect();
        assert!(!sections.is_empty() && sections.iter().all(|s| (4..=6).contains(s)), "{found}");
        assert_eq!(found["through"], 6);
        let outside = read_db(&db, &plan, "read_original", &json!({"section":2})).unwrap_err().to_string();
        assert!(outside.contains("第 5～7 节"), "{outside}");
        assert!(read_db(&db, &plan, "read_original", &json!({"section":5})).is_ok());
        let facts = read_db(&db, &plan, "read_canon_facts", &json!({"query":""})).unwrap();
        let subjects: Vec<&str> = facts["facts"].as_array().unwrap().iter().map(|f| f["subject"].as_str().unwrap()).collect();
        assert!(!subjects.contains(&"铜匠"), "{facts}");
        // The whole-book reference tools are not for a chosen range.
        assert!(read_db(&db, &plan, "locate_original_event", &json!({"query":"钥匙"})).is_err());
        // A range past the story's own reading limit is cut to it.
        plan.state["source"]["through"] = 5.into();
        assert_eq!(read_db(&db, &plan, "search_original", &json!({"query":"青铜钥匙"})).unwrap()["through"], 5);
    }

    #[test]
    fn only_the_chosen_notes_are_read_and_the_original_is_not_unless_a_correction_needs_it() {
        let (store, mut plan) = ranged_book();
        {
            let db = store.lock().unwrap();
            for (id, refs) in [("a", "[1]"), ("b", "[5]"), ("c", "[9]")] {
                db.execute("INSERT INTO canon_notes(id,book_id,world_id,kind,title,scope_json,content,refs_json,model,status,active,progress_json,created_at,updated_at) VALUES(?,'book',NULL,'person',?,'{}',?,?,'','done',1,'{}','t','t')",
                    params![id, format!("人物{id}"), format!("札记{id}：青铜钥匙"), refs]).unwrap();
            }
        }
        let db = store.lock().unwrap();
        plan.meta["sourceScope"] = json!({"mode":"notes","noteIds":["a","c"]});
        let notes = read_notes(&db, &plan, "青铜钥匙").unwrap();
        let ids: Vec<&str> = notes["notes"].as_array().unwrap().iter().map(|n| n["id"].as_str().unwrap()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"a") && ids.contains(&"c"));
        let refused = read_db(&db, &plan, "search_original", &json!({"query":"青铜钥匙"})).unwrap_err().to_string();
        assert!(refused.contains("只用你选的札记"), "{refused}");
        // A correction reads the original within what its notes cover, while still letting
        // read_canon_notes read every explicitly chosen book, question, and on-route story note.
        db.execute("INSERT OR IGNORE INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES(?1,'试读','','line','{}','t','t','t')", params![plan.world_id]).unwrap();
        db.execute("INSERT INTO canon_notes(id,book_id,world_id,kind,title,scope_json,content,refs_json,model,status,active,progress_json,created_at,updated_at) VALUES('q','book',?,'question','问事','{}','问事札记：青铜钥匙来源','[]','','done',1,'{}','t','t')", params![plan.world_id]).unwrap();
        db.execute("INSERT OR IGNORE INTO nodes(id,world_id,parent_id,seq,kind,narrative,created_at) VALUES(?1,?2,NULL,0,'opening','开场','t')", params![plan.head_id, plan.world_id]).unwrap();
        db.execute("INSERT INTO story_notes(id,world_id,kind,title,scope_json,content,refs_json,model,status,active,progress_json,created_at,updated_at) VALUES('s',?,'plot','本局主线',json_object('toNode',?),'本局札记：青铜钥匙在掌柜手里','[]','','done',1,'{}','t','t')", params![plan.world_id, plan.head_id]).unwrap();
        plan.state["source"]["through"] = 6.into();
        plan.meta["sourceScope"] = json!({"mode":"notes","noteIds":["b","c","q","s"],"lookups":true,"from":5,"to":5});
        let found = read_db(&db, &plan, "search_original", &json!({"query":"青铜钥匙"})).unwrap();
        assert!(found["excerpts"].as_array().unwrap().iter().all(|e| e["section"] == 5), "{found}");
        let chosen_reads = read_notes(&db, &plan, "青铜钥匙").unwrap();
        let chosen_ids: Vec<&str> = chosen_reads["notes"].as_array().unwrap().iter().map(|n| n["id"].as_str().unwrap()).collect();
        assert!(chosen_ids.contains(&"b") && chosen_ids.contains(&"q") && chosen_ids.contains(&"s"), "{chosen_reads}");
        assert!(!chosen_ids.contains(&"c"), "past through must stay excluded: {chosen_reads}");
        plan.state["source"]["through"] = Value::Null;
        // A range of chapters reads only the notes about those chapters.
        plan.meta["sourceScope"] = json!({"mode":"chapters","from":4,"to":6});
        let ids: Vec<String> = read_notes(&db, &plan, "青铜钥匙").unwrap()["notes"].as_array().unwrap().iter().map(|n| n["id"].as_str().unwrap().to_owned()).collect();
        assert_eq!(ids, ["b"]);
    }

    #[test]
    fn a_cached_read_is_not_reused_under_another_scope() {
        let (store, mut plan) = ranged_book();
        store.lock().unwrap().execute("INSERT INTO execution_runs(id,world_id,line_id,base_head_id,status,plan_json,budget_json,draft_json,created_at,updated_at) VALUES(?,'world','line','head','running','{}','{}','{}','test','test')",[&plan.id]).unwrap();
        let revision: i64 = store.lock().unwrap().query_row("SELECT revision FROM reference_index_versions WHERE book_id='book'", [], |r| r.get(0)).unwrap_or(1);
        let args = json!({"ref":{"bookId":"book","bookVersion":format!("book:{revision}"),"section":5,"chunk":5}});
        assert_ne!(read(&store, &plan, "read_original", &args).unwrap()["cacheHit"], true);
        assert_eq!(read(&store, &plan, "read_original", &args).unwrap()["cacheHit"], true);
        plan.meta["sourceScope"] = json!({"mode":"chapters","from":4,"to":6});
        assert_ne!(read(&store, &plan, "read_original", &args).unwrap()["cacheHit"], true);
        plan.meta["sourceScope"] = json!({"mode":"chapters","from":0,"to":2});
        assert!(read(&store, &plan, "read_original", &args).is_err());
    }

    fn exam_book() -> (Store, RunPlan) {
        let sections: Vec<String> = (0..30).map(|i| if i == 17 { "院长宣布入门比试分为实战与理论两项，核对名单后入场。".to_owned() } else { format!("第{i}日，众人核对账目，又核对了一遍货物。") }).collect();
        setup(&sections)
    }

    #[test]
    fn the_models_query_outweighs_the_players_request_words_and_common_terms() {
        let (store, mut plan) = exam_book();
        plan.meta["rewriteHint"] = "核对比试是什么".into();
        plan.state["source"]["position"] = 2.into();
        let db = store.lock().unwrap();
        let result = read_db(&db, &plan, "search_original", &json!({"query":"入门比试"})).unwrap();
        assert_eq!(result["excerpts"][0]["section"], 17, "{result}");
        assert!(result.get("match").is_none());
        // The request words alone no longer drive the search either.
        assert!(!without_request_words("核对比试是什么").contains("核对"));
        assert!(without_request_words("核对比试是什么").contains("比试"));
    }

    #[test]
    fn a_search_with_no_match_says_it_only_returned_the_nearby_passage() {
        let (store, plan) = exam_book();
        let db = store.lock().unwrap();
        let result = read_db(&db, &plan, "search_original", &json!({"query":"紫色魂环"})).unwrap();
        assert_eq!(result["match"], "nearby", "{result}");
        assert_eq!(result["excerpts"][0]["match"], "nearby");
        assert!(result["note"].as_str().unwrap().contains("不能当作查到的依据"));
    }

    #[test]
    fn a_match_only_past_the_reading_limit_is_flagged_without_its_text() {
        let (store, mut plan) = exam_book();
        plan.state["source"]["through"] = 10.into();
        let db = store.lock().unwrap();
        let result = read_db(&db, &plan, "search_original", &json!({"query":"入门比试实战理论"})).unwrap();
        assert_eq!(result["beyondScope"], true, "{result}");
        assert!(result["scopeNote"].as_str().unwrap().contains("第 11 节之后"));
        assert!(!result.to_string().contains("院长宣布"));
    }

    #[test]
    fn explicit_query_is_not_polluted_by_background_instructions_and_supports_pagination_and_toc() {
        let mut sections: Vec<String> = (0..12)
            .map(|i| format!("第{}日，参考原著人物性格与关系，城中风平浪静。", i + 1))
            .collect();
        sections[9] = format!(
            "{}翠微楼的玄铁令由林晚照掌管，绝无二话。{}",
            "前文铺垫山雨欲来。".repeat(70),
            "后文众人各自散去。".repeat(70)
        );
        let (store, mut plan) = setup(&sections);
        plan.kind = "correction".into();
        plan.state["source"]["instructions"] = "参考原著人物性格与关系".into();
        plan.state["source"]["position"] = 0.into();
        {
            let db = store.lock().unwrap();
            db.execute("UPDATE source_sections SET title='序章 楔子' WHERE book_id='book' AND section=0", []).unwrap();
            for s in 1..12i64 {
                let title = if s == 9 { "第九章 翠微楼玄铁令".to_owned() } else { format!("第{s}章") };
                db.execute("UPDATE source_sections SET title=?1 WHERE book_id='book' AND section=?2", params![title, s]).unwrap();
            }
            // Zero-match explicit query must report nearby_only even though instructions match every chapter.
            let miss = read_db(&db, &plan, "search_original", &json!({"query":"不存在的星辰剑"})).unwrap();
            assert_eq!(miss["match"], "nearby", "{miss}");
            // locate_original_event must center its snippet around the actual match (at char ~630+) and hide nearby misses.
            let located = read_db(&db, &plan, "locate_original_event", &json!({"queries":["翠微楼 玄铁令","不存在的星辰剑"]})).unwrap();
            assert!(located["items"][0]["candidates"][0]["snippet"].as_str().unwrap().contains("玄铁令"), "{located}");
            assert_eq!(located["items"][1]["status"], "insufficient", "{located}");
            assert_eq!(located["items"][1]["nearbyOnly"], true, "{located}");
            // list_sections matches Chinese/Arabic numerals and titles on shifted front-matter books.
            let toc = read_db(&db, &plan, "list_sections", &json!({"query":"9"})).unwrap();
            assert!(toc["sections"].as_array().unwrap().iter().any(|s| s["section"] == 9), "{toc}");
            let toc_cn = read_db(&db, &plan, "list_sections", &json!({"query":"第九章"})).unwrap();
            assert_eq!(toc_cn["sections"][0]["section"], 9, "{toc_cn}");
            // search_original supports from/to filtering and reports totalHits/nextOffset/moreMatches.
            let paged = read_db(&db, &plan, "search_original", &json!({"query":"城中风平浪静","offset":0})).unwrap();
            assert!(paged["totalHits"].as_u64().unwrap() >= 10, "{paged}");
            assert!(paged["nextOffset"].is_u64(), "{paged}");
            let ranged = read_db(&db, &plan, "search_original", &json!({"query":"翠微楼","from":8,"to":10})).unwrap();
            assert_eq!(ranged["excerpts"][0]["section"], 9, "{ranged}");
        }
    }

    #[test]
    fn read_canon_notes_matches_unspaced_chinese_phrases_by_tokens_and_allows_empty_query() {
        let (store, plan) = setup(&["正文".to_owned()]);
        let db = store.lock().unwrap();
        db.execute(
            "INSERT INTO canon_notes(id,book_id,world_id,kind,title,scope_json,content,refs_json,status,active,progress_json,model,created_at,updated_at) VALUES('n1','book',NULL,'person','人物：林晚照','{}','林晚照在翠微楼掌管玄铁令。','[0]','done',1,'{}','m','t','t')",
            [],
        ).unwrap();
        let listed = read_notes(&db, &plan, "").unwrap();
        assert_eq!(listed["notes"].as_array().unwrap().len(), 1);
        let hit = read_notes(&db, &plan, "林晚照玄铁令").unwrap();
        assert_eq!(hit["notes"].as_array().unwrap().len(), 1, "{hit}");
    }

}

fn utf16_slice(text:&str,start:usize,end:usize)->String { let mut at=0; text.chars().filter(|c|{let old=at;at+=c.len_utf16();old>=start&&at<=end}).collect() }

/// 原著进度跟随 (R30 step 2, D178): which chapter of the bound book a passage
/// most likely follows, from the book's own search index, no model request.
/// Only forward from `position`, at most five chapters at a time, and only
/// when one chapter clearly leads; otherwise None and the position stays.
pub(crate) fn follow_position(db: &rusqlite::Connection, binding: &Value, narrative: &str) -> Result<Option<i64>> {
    let Some(book) = binding["bookId"].as_str() else { return Ok(None) };
    if binding["fanfic"] != true || binding["plot"] != "canon" {
        return Ok(None);
    }
    let last: Option<i64> = db.query_row("SELECT MAX(section) FROM source_sections WHERE book_id=?", [book], |r| r.get(0)).optional()?.flatten();
    let Some(last) = last else { return Ok(None) };
    let through = binding["through"].as_i64().unwrap_or(last).min(last);
    let position = binding["position"].as_i64().unwrap_or(0).clamp(0, through);
    if position >= through {
        return Ok(None);
    }
    // Look a little behind (the passage may still be in the current section) and moderately ahead.
    let (from, to) = ((position - 2).max(0), (position + 12).min(through));
    let mut stmt = db.prepare("SELECT ordinal,section,LENGTH(text) FROM source_chunks WHERE book_id=? AND section BETWEEN ? AND ?")?;
    let window: HashMap<i64, (i64, i64)> = stmt.query_map(params![book, from, to], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?.collect::<std::result::Result<_, _>>()?;
    if window.is_empty() {
        return Ok(None);
    }
    let total: f64 = db.query_row("SELECT COUNT(*) FROM source_chunks WHERE book_id=?", [book], |r| r.get::<_, i64>(0))? as f64;
    let mut keys = terms(narrative);
    keys.truncate(400);
    if keys.is_empty() {
        return Ok(None);
    }
    let placeholders = vec!["?"; keys.len()].join(",");
    let mut values = vec![book.to_owned()];
    values.extend(keys.iter().cloned());
    let mut stmt = db.prepare(&format!("SELECT postings FROM source_terms WHERE book_id=? AND term IN ({placeholders})"))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |r| r.get::<_, String>(0))?;
    let mut chunk_scores = HashMap::<i64, (f64, usize)>::new();
    let max_df = (total * 0.03).clamp(3.0, 40.0);
    for raw in rows {
        let postings = serde_json::from_str::<Vec<i64>>(&raw?).unwrap_or_default();
        let df = postings.len() as f64;
        // Words found all over the book (names, common phrases) say nothing about where we are.
        if df == 0.0 || df > max_df {
            continue;
        }
        let weight = (total / df).ln();
        for chunk in postings.into_iter().filter(|c| window.contains_key(c)) {
            let entry = chunk_scores.entry(chunk).or_insert((0.0, 0));
            entry.0 += weight;
            entry.1 += 1;
        }
    }
    let mut sections = HashMap::<i64, (f64, usize)>::new();
    for (chunk, (raw_score, hits)) in chunk_scores {
        let (sec, len) = window[&chunk];
        let norm = ((len.max(600) as f64) / 1200.0).sqrt().max(1.0);
        let score = raw_score / norm;
        let entry = sections.entry(sec).or_insert((0.0, 0));
        if score > entry.0 {
            *entry = (score, hits);
        }
    }
    let Some((&best, &(top, top_hits))) = sections.iter().max_by(|a, b| a.1.0.total_cmp(&b.1.0).then(b.0.cmp(a.0))) else { return Ok(None) };
    let runner_up = sections.iter().filter(|(s, _)| s.abs_diff(best) > 1).map(|(_, (v, _))| *v).fold(0.0, f64::max);
    if best <= position || top_hits < 3 || top < 12.0 || top < runner_up * 1.4 {
        return Ok(None);
    }
    Ok(Some(best.min(position + 2)))
}
