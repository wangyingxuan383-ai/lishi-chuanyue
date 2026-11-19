//! 天下大事与历史偏离 and 相关旧事 for the native writing context (R30, D169).
//! Ported from src/engine/timeline.ts (worldBlock) and src/engine/memory/
//! {recall,match}.ts (recallBlock): the same wording and the same choices, so
//! ordinary passages and 连播 passages get one assembly. Lengths count UTF-16
//! units, as the TypeScript did. No model call.
use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const DAY: f64 = 1440.0;
pub const RECALL_BUDGET: usize = 1200;
const QUERY_SHARE: f64 = 0.7;
const QUERY_LINES: usize = 6;
const QUERY_CHARS: usize = 240;
const QUERY_CLAUSES: usize = 8;
const PER_NAME: usize = 2;

fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn chars_prefix(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// 【天下大事】 (events of the last 120 days, none ahead) and 【历史偏离】 (the last ten).
pub fn world_block(state: &Value) -> String {
    let now = state["time"]["elapsedMinutes"].as_f64().unwrap_or(0.0);
    let timeline = list(&state["timeline"]);
    let recent: Vec<&Value> = timeline
        .iter()
        .filter(|e| e["atMinute"].as_f64().is_some_and(|at| at <= now && at > now - 120.0 * DAY))
        .collect();
    let all_deviations = list(&state["deviations"]);
    let deviations: Vec<&str> = all_deviations[all_deviations.len().saturating_sub(10)..].iter().map(text).collect();
    let note = |e: &Value| {
        if e["kind"] == "可变" || !deviations.is_empty() { "（按史书；若【历史偏离】改变了它，以偏离为准）" } else { "" }
    };
    let lines: Vec<String> = recent.iter().map(|e| format!("{}：{}{}", text(&e["date"]), text(&e["title"]), note(e))).collect();
    let mut out = String::new();
    if !lines.is_empty() {
        out += &format!("\n【天下大事】\n{}", lines.join("\n"));
    }
    if !deviations.is_empty() {
        out += &format!("\n【历史偏离（这一世已经和史书不同的事）】\n- {}", deviations.join("\n- "));
    }
    out
}

/// Distinct character pairs of a text's Han characters, letters and digits, in order.
pub fn pairs_of(text: &str) -> Vec<String> {
    static RUN: OnceLock<Regex> = OnceLock::new();
    let run = RUN.get_or_init(|| Regex::new(r"[\p{Han}A-Za-z0-9]{2,}").unwrap());
    let mut seen = HashSet::new();
    let mut out = vec![];
    for m in run.find_iter(text) {
        let chars: Vec<char> = m.as_str().chars().collect();
        for pair in chars.windows(2) {
            let pair: String = pair.iter().collect();
            if seen.insert(pair.clone()) {
                out.push(pair);
            }
        }
    }
    out
}

fn clauses_of(query: &str) -> Vec<String> {
    query
        .split(['。', '！', '？', '；', '?', '!', ';', '\n'])
        .map(str::trim)
        .filter(|s| pairs_of(s).len() >= 2)
        .map(str::to_owned)
        .collect()
}

fn meaningless(pair: &str) -> bool {
    const FUNCTION: &str = "的了是在着和与把被也都就还又这那之其而以于所为从对向给让将得地个们有没不";
    pair.chars().any(|c| "什么谁哪何吗呢".contains(c)) || pair.chars().all(|c| FUNCTION.contains(c))
}

/// Find one older chapter gist linked to the current scene without reading its full prose.
pub(crate) fn related_chapter(chapters: &[Value], query: &str, cap: usize) -> Option<String> {
    let terms: HashSet<_> = pairs_of(query).into_iter().filter(|pair| !meaningless(pair)).collect();
    if terms.len() < 3 {
        return None;
    }
    let (_, best) = chapters
        .iter()
        .map(|chapter| {
            let gist = format!("{}：{}", text(&chapter["title"]), text(&chapter["gist"]));
            let hits = pairs_of(&gist).iter().filter(|pair| terms.contains(*pair)).count();
            (hits, gist)
        })
        .filter(|(hits, _)| *hits >= 3)
        .max_by_key(|(hits, _)| *hits)?;
    Some(excerpt(&best, query, cap))
}

/// How rare each meaningful pair of the query is among `docs`, and which pairs each doc holds.
fn pair_index(query: &str, docs: &[&str]) -> (HashMap<String, f64>, Vec<HashSet<String>>) {
    let pairs: Vec<String> = pairs_of(query).into_iter().filter(|p| !meaningless(p)).collect();
    let mut held = vec![HashSet::new(); docs.len()];
    let mut weights = HashMap::new();
    if docs.is_empty() {
        return (weights, held);
    }
    let n = docs.len() as f64;
    let rarest = ((n + 1.0) / 1.5).ln();
    for pair in pairs {
        let mut df = 0.0;
        for (i, d) in docs.iter().enumerate() {
            if d.contains(pair.as_str()) {
                df += 1.0;
                held[i].insert(pair.clone());
            }
        }
        weights.insert(pair, ((n + 1.0) / (df + 0.5)).ln() / rarest);
    }
    (weights, held)
}

#[derive(Clone)]
struct Passage {
    text: String,
    at: usize,
}

fn best_matches(query: &str, passages: &[Passage], weights: &HashMap<String, f64>, limit: usize, min_score: f64, avg: f64) -> Vec<Passage> {
    let pairs: Vec<String> = pairs_of(query).into_iter().filter(|p| weights.contains_key(p)).collect();
    if pairs.len() < 2 || passages.is_empty() {
        return vec![];
    }
    struct Candidate { p: Passage, h: Vec<String>, norm: f64 }
    let mut candidates: Vec<Candidate> = passages
        .iter()
        .map(|p| Candidate {
            p: p.clone(),
            h: pairs.iter().filter(|pair| p.text.contains(pair.as_str())).cloned().collect(),
            norm: 2.2 / (1.0 + 1.2 * (0.7 + 0.3 * len16(&p.text) as f64 / avg)),
        })
        .filter(|c| c.h.len() >= 2 && c.h.iter().map(|pair| weights[pair]).sum::<f64>() >= min_score)
        .collect();
    let mut covered: HashSet<String> = HashSet::new();
    let score = |c: &Candidate, covered: &HashSet<String>| c.norm * c.h.iter().map(|pair| weights[pair] * if covered.contains(pair) { 0.3 } else { 1.0 }).sum::<f64>();
    let mut picked = vec![];
    while picked.len() < limit && !candidates.is_empty() {
        let mut best = 0;
        for i in 1..candidates.len() {
            if score(&candidates[i], &covered) > score(&candidates[best], &covered) {
                best = i;
            }
        }
        if score(&candidates[best], &covered) < min_score * 0.6 {
            break;
        }
        let chosen = candidates.remove(best);
        for pair in &chosen.h {
            covered.insert(pair.clone());
        }
        picked.push(chosen.p);
    }
    picked
}

/// At most `max` units of a sentence, around the part that matched the query.
fn excerpt(sentence: &str, query: &str, max: usize) -> String {
    let units: Vec<u16> = sentence.encode_utf16().collect();
    if units.len() <= max {
        return sentence.to_owned();
    }
    let index_of = |pair: &str| -> Option<usize> {
        let p: Vec<u16> = pair.encode_utf16().collect();
        units.windows(p.len()).position(|w| w == p.as_slice())
    };
    let at: Vec<usize> = pairs_of(query).iter().filter_map(|p| index_of(p)).collect();
    let first = at.iter().copied().min().unwrap_or(0) as i64;
    let last = at.iter().copied().max().map(|m| m as i64 + 2).unwrap_or(max as i64);
    let mid = ((first + last) as f64 / 2.0 - max as f64 / 2.0).round() as i64;
    let start = 0.max((first - 12).min(mid).min(units.len() as i64 - max as i64)) as usize;
    let end = units.len().min(start + max);
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        String::from_utf16_lossy(&units[start..end]),
        if end < units.len() { "…" } else { "" }
    )
}

fn sentences(text: &str) -> Vec<String> {
    static SENTENCE: OnceLock<Regex> = OnceLock::new();
    let sentence = SENTENCE.get_or_init(|| Regex::new(r"[^。！？\n]*[。！？]?[”」』]?").unwrap());
    let flat: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    sentence.find_iter(&flat).map(|m| m.as_str().to_owned()).filter(|s| !s.is_empty()).collect()
}

/// One old turn: its narrative and its number from the opening (0).
pub struct Older<'a> {
    pub narrative: &'a str,
    pub turn: usize,
}

fn query_sentences(query: &str, older: &[Older]) -> Vec<(usize, String, String)> {
    let clauses: Vec<String> = clauses_of(&chars_prefix(query, QUERY_CHARS)).into_iter().take(QUERY_CLAUSES).collect();
    if clauses.is_empty() {
        return vec![];
    }
    let docs: Vec<&str> = older.iter().map(|o| o.narrative).collect();
    let (weights, held) = pair_index(&clauses.join("\n"), &docs);
    let passages: Vec<Passage> = older
        .iter()
        .enumerate()
        .filter(|(i, _)| held[*i].len() >= 2)
        .flat_map(|(_, o)| sentences(o.narrative).into_iter().filter(|s| len16(s) >= 6 && !s.contains('【')).map(|text| Passage { text, at: o.turn }).collect::<Vec<_>>())
        .collect();
    if passages.is_empty() {
        return vec![];
    }
    let avg = passages.iter().map(|p| len16(&p.text)).sum::<usize>() as f64 / passages.len() as f64;
    let each = 2.max(QUERY_LINES.div_ceil(clauses.len()));
    let lists: Vec<Vec<(usize, String, String)>> = clauses
        .iter()
        .map(|clause| {
            let own: Vec<String> = pairs_of(clause).into_iter().filter(|p| weights.contains_key(p)).collect();
            let mut turns = HashSet::new();
            for (i, o) in older.iter().enumerate() {
                let hit: Vec<&String> = own.iter().filter(|p| held[i].contains(*p)).collect();
                if hit.len() >= 2 && hit.iter().map(|p| weights[*p]).sum::<f64>() >= 1.5 {
                    turns.insert(o.turn);
                }
            }
            let pool: Vec<Passage> = passages.iter().filter(|p| turns.contains(&p.at)).cloned().collect();
            best_matches(clause, &pool, &weights, each, 1.5, avg)
                .into_iter()
                .map(|p| (p.at, p.text.clone(), excerpt(&p.text, clause, 70)))
                .collect()
        })
        .collect();
    let mut out: Vec<(usize, String, String)> = vec![];
    for i in 0..each {
        for list in &lists {
            if let Some(item) = list.get(i) {
                if !out.iter().any(|o| o.1 == item.1) {
                    out.push(item.clone());
                }
            }
        }
    }
    out
}

/// Names in play: everything with a name the recent text mentions, latest first.
fn names_in_play(state: &Value, recent: &str) -> Vec<(String, Vec<String>)> {
    let strings = |v: &Value| list(v).iter().map(|s| text(s).to_owned()).collect::<Vec<_>>();
    let mut all: Vec<(String, Vec<String>)> = vec![];
    all.extend(list(&state["people"]).iter().map(|p| (text(&p["name"]).to_owned(), strings(&p["aliases"]))));
    all.extend(list(&state["cards"]).iter().filter(|c| c["kind"] != "时代").map(|c| (text(&c["name"]).to_owned(), strings(&c["keys"]))));
    all.extend(list(&state["places"]).iter().map(|p| (text(&p["name"]).to_owned(), strings(&p["aliases"]))));
    all.extend(list(&state["protagonist"]["items"]).iter().map(|i| (text(&i["name"]).to_owned(), vec![])));
    let mut found: Vec<(i64, (String, Vec<String>))> = all
        .into_iter()
        .map(|(name, alias)| {
            let at = std::iter::once(&name)
                .chain(alias.iter())
                .filter(|w| w.chars().count() >= 2)
                .filter_map(|w| recent.rfind(w.as_str()).map(|b| recent[..b].encode_utf16().count() as i64))
                .max()
                .unwrap_or(-1);
            (at, (name, alias))
        })
        .filter(|(at, _)| *at >= 0)
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0).then(len16(&b.1 .0).cmp(&len16(&a.1 .0))));
    found.into_iter().map(|(_, e)| e).collect()
}

fn sentence_with(text: &str, word: &str) -> Option<String> {
    sentences(text).into_iter().find(|s| s.contains(word)).map(|s| {
        let units: Vec<u16> = s.encode_utf16().collect();
        if units.len() > 90 { format!("{}…", String::from_utf16_lossy(&units[..88])) } else { s }
    })
}

/// 【相关旧事】: old sentences from turns outside the window, first those
/// matching what the player wrote (`query`), then those about the names in
/// play, the most recently mentioned first. Budgeted.
pub fn recall_block(state: &Value, recent: &str, older: &[Older], budget: usize, query: &str) -> String {
    if older.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = vec![];
    let mut seen: Vec<String> = vec![];
    let mut used = 0usize;
    let label = |turn: usize| if turn == 0 { "开场".to_owned() } else { format!("第 {turn} 回合") };
    let wrap = |lines: &[String]| if lines.is_empty() { String::new() } else { format!("\n【相关旧事】（早先的剧情里和眼下有关的句子）\n{}", lines.join("\n")) };
    if pairs_of(query).len() >= 2 {
        for (turn, source, text) in query_sentences(query, older) {
            let line = format!("- {}：{}", label(turn), text);
            if (used + len16(&line)) as f64 > budget as f64 * QUERY_SHARE {
                break;
            }
            seen.push(source);
            used += len16(&line);
            lines.push(line);
        }
    }
    for (name, alias) in names_in_play(state, recent) {
        let words: Vec<&String> = std::iter::once(&name).chain(alias.iter()).filter(|w| w.chars().count() >= 2).collect();
        let hits: Vec<&Older> = older.iter().filter(|o| words.iter().any(|w| o.narrative.contains(w.as_str()))).collect();
        let picks: Vec<&Older> = if hits.len() > PER_NAME { vec![hits[0], hits[hits.len() - 1]] } else { hits };
        for o in picks {
            let Some(word) = words.iter().find(|w| o.narrative.contains(w.as_str())) else { continue };
            let Some(sentence) = sentence_with(o.narrative, word) else { continue };
            let stem = sentence.trim_end_matches('…');
            if sentence.contains('【') || seen.contains(&sentence) || seen.iter().any(|s| s.starts_with(stem)) {
                continue;
            }
            let line = format!("- {}（{}）：{}", label(o.turn), name, sentence);
            if used + len16(&line) > budget {
                return wrap(&lines);
            }
            used += len16(&line);
            seen.push(sentence);
            lines.push(line);
        }
    }
    wrap(&lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn world_events_of_the_last_120_days_and_the_deviations() {
        let state = json!({"time":{"elapsedMinutes":200000},"timeline":[
            {"date":"天宝八载六月","title":"哥舒翰攻克石堡城","kind":"固定","atMinute":190000},
            {"date":"天宝九载","title":"未来的事","kind":"固定","atMinute":300000},
            {"date":"很久以前","title":"旧事","kind":"固定","atMinute":1000}],
            "deviations":["李林甫提前罢相"]});
        assert_eq!(world_block(&state), "\n【天下大事】\n天宝八载六月：哥舒翰攻克石堡城（按史书；若【历史偏离】改变了它，以偏离为准）\n【历史偏离（这一世已经和史书不同的事）】\n- 李林甫提前罢相");
        assert_eq!(world_block(&json!({"time":{"elapsedMinutes":0}})), "");
    }

    #[test]
    fn old_sentences_about_names_in_play_and_about_what_the_player_wrote() {
        let state = json!({"people":[{"name":"王掌柜","aliases":["掌柜"]}],"cards":[],"places":[],"protagonist":{"items":[]}});
        let older = [
            Older { narrative: "你在西市旁的邸店醒来。王掌柜催你付九十文房钱。", turn: 0 },
            Older { narrative: "你把两封密信藏进皮甲的夹层里，谁也没看见。", turn: 3 },
        ];
        let block = recall_block(&state, "王掌柜又来了", &older, RECALL_BUDGET, "我取出藏在皮甲里的那两封信");
        assert!(block.starts_with("\n【相关旧事】（早先的剧情里和眼下有关的句子）\n"), "{block}");
        assert!(block.contains("- 第 3 回合：你把两封密信藏进皮甲的夹层里，谁也没看见。"), "{block}");
        assert!(block.contains("- 开场（王掌柜）：王掌柜催你付九十文房钱。"), "{block}");
        assert_eq!(recall_block(&state, "无关", &[], RECALL_BUDGET, ""), "");
    }

    #[test]
    fn pairs_and_excerpts_count_like_the_typescript() {
        assert_eq!(pairs_of("皮甲 ab1"), vec!["皮甲", "ab", "b1"]);
        let long = format!("{}两封信{}", "前".repeat(60), "后".repeat(60));
        let cut = excerpt(&long, "两封信", 70);
        assert!(cut.starts_with('…') && cut.ends_with('…') && cut.contains("两封信"));
        assert_eq!(len16(&cut), 72);
    }
}
