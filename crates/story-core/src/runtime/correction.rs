//! 按原著纠错的收尾 (R30 step 3, D182): what the model found becomes one of four
//! outcomes, each told to the player as it is. Only `changed` can be adopted;
//! `verified` (the passage already agrees with the book), `answer` (the player
//! asked a question) and `not_found` (with the reason and what was searched) are
//! previews too, so nothing the model checked is lost behind a failure.
use super::*;

/// The last request of a correction: answer from what was read, in one of the four forms.
pub(super) const CORRECTION_FINAL: &str = "【查阅到此为止】不要再调用工具。依据上文已读原文直接返回 JSON：有原著依据的更正写进 corrections（引文逐字摘自已读原文）；这段与原著一致，就把 outcome 写成 verified，并在 findings 里附上引文；玩家在提问，就把 outcome 写成 answer，answer 写答案，findings 附引文；查不到依据，就把 outcome 写成 not_found，把缺什么写进 unresolved。不凭记忆补原著细节。";

/// Quotes shorter than this, once punctuation and spaces are dropped, could match anywhere.
const MIN_QUOTE: usize = 6;

impl Engine {
    pub(super) fn finish_correction(&self, shared: &Shared, plan: &RunPlan, result: &crate::chat::Completion) -> Result<()> {
        let response = rules::record::complete_json(&result.text).ok_or_else(|| {
            if refused(result, &result.text, false) {
                Error::Refused("AI服务拒绝了本次原著改稿，原路线未改动".into())
            } else {
                Error::fail(crate::failure::FailKind::Review, "原著改稿预览没有返回完整格式，可恢复重试")
            }
        })?;
        let (passages, searched, lookups) = {
            let c = shared.lock().map_err(|_| Error::Cancelled)?;
            (
                c.draft["originalPassages"].as_array().cloned().unwrap_or_default(),
                searched(&c.draft["lookupLog"]),
                c.draft["lookupLog"].as_array().cloned().unwrap_or_default(),
            )
        };
        let book = plan.state["source"]["bookId"].clone();
        let mut reference = plan.reference.clone().ok_or_else(|| Error::Invalid("未绑定原著资料".into()))?;
        reference["passages"] = Value::Array(passages.clone());
        let lists = |key: &str| response[key].as_array().map(|a| a.iter().filter(|v| v.as_str().is_some_and(|s| !s.trim().is_empty())).cloned().collect::<Vec<_>>()).unwrap_or_default();
        let (unresolved, related) = (lists("unresolved"), lists("related"));
        let read = passages.iter().filter(|p| p["match"] != "nearby").count();
        let common = json!({"anchor":plan.meta["anchor"],"sourceGuard":plan.meta["sourceGuard"].to_string(),"writingVersion":plan.meta["writingVersion"],
            "reference":reference,"searched":searched,"read":read,"unresolved":unresolved,"related":related,"baseline":plan.meta["baseline"],"range":plan.meta["correctionRange"]});
        let stop = |code: &str, quotes: Vec<Value>| -> Result<()> {
            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
            c.draft["correctionStop"] = json!({"code":code,"quotes":quotes,"unresolved":unresolved,"related":related,"searched":searched,"read":read});
            Ok(())
        };
        match classify(&response, plan) {
            "changed" if passages.is_empty() => {
                // Nothing from the book reached the model: it cannot have a basis to cite.
                self.finish_preview(shared, merge(common, json!({"outcome":"not_found","reason":not_found_reason(&lookups, 0),"narrative":plan.meta["anchor"]["original"],"record":plan.meta["originalRecord"],"corrections":[]})))
            }
            "changed" => {
                let response = crate::writing_context::local_correction(plan, &response).map_err(check_reply_error)?;
                let corrections = response["corrections"].as_array().filter(|a| !a.is_empty()).cloned().unwrap_or_default();
                let (mut corrections, preserved_player_facts) = separate_correction_sources(corrections, &plan.state).map_err(check_reply_error)?;
                let mut missing = vec![];
                for change in &mut corrections {
                    let Some(citations) = change["citations"].as_array_mut().filter(|a| !a.is_empty()) else {
                        missing.push(change["detail"].clone());
                        continue;
                    };
                    for cite in citations.iter_mut() {
                        if cite["bookId"].is_string() && cite["bookId"] != book {
                            return Err(Error::fail(crate::failure::FailKind::Review, "改稿出处书籍不符"));
                        }
                        match locate_citation(&passages, cite, &book) {
                            Some(found) => *cite = found,
                            None => missing.push(cite["quote"].clone()),
                        }
                    }
                }
                if !missing.is_empty() {
                    stop("quote_mismatch", missing)?;
                    return Err(Error::fail(crate::failure::FailKind::Review, "改稿引用的原文和实际查到的对不上，没有采用"));
                }
                if corrections.is_empty() {
                    // Only notes about the player's own branch: nothing from the book to adopt.
                    return self.finish_preview(shared, merge(common, json!({"outcome":"not_found","reason":"no_basis","narrative":plan.meta["anchor"]["original"],"record":plan.meta["originalRecord"],"corrections":[],"preservedPlayerFacts":preserved_player_facts})));
                }
                let mut issues = vec![];
                let record = rules::record::normalize_record(&response["record"], &mut issues)
                    .ok_or_else(|| Error::fail(crate::failure::FailKind::Review, "改稿尚未完成事实整理"))?;
                self.finish_preview(shared, merge(common, json!({"outcome":"changed","narrative":response["narrative"],"replacement":response["replacement"],"range":response["range"],"record":record,"correctionPatch":response["correctionPatch"],"corrections":corrections,"preservedPlayerFacts":preserved_player_facts})))
            }
            outcome @ ("verified" | "answer") => {
                let mut findings = vec![];
                let mut missing = vec![];
                for finding in response["findings"].as_array().into_iter().flatten() {
                    let mut located = vec![];
                    for cite in finding["citations"].as_array().into_iter().flatten() {
                        if cite["bookId"].is_string() && cite["bookId"] != book {
                            continue;
                        }
                        match locate_citation(&passages, cite, &book) {
                            Some(found) => located.push(found),
                            None => missing.push(cite["quote"].clone()),
                        }
                    }
                    if !located.is_empty() {
                        findings.push(json!({"detail":finding["detail"],"citations":located}));
                    }
                }
                if findings.is_empty() {
                    if !missing.is_empty() {
                        stop("quote_mismatch", missing)?;
                        return Err(Error::fail(crate::failure::FailKind::Review, "核对引用的原文和实际查到的对不上"));
                    }
                    return self.finish_preview(shared, merge(common, json!({"outcome":"not_found","reason":not_found_reason(&lookups, read),"narrative":plan.meta["anchor"]["original"],"record":plan.meta["originalRecord"],"corrections":[]})));
                }
                let answer = response["answer"].as_str().map(str::trim).unwrap_or("");
                self.finish_preview(shared, merge(common, json!({"outcome":outcome,"findings":findings,"answer":answer,"narrative":plan.meta["anchor"]["original"],"record":plan.meta["originalRecord"],"corrections":[]})))
            }
            _ => self.finish_preview(shared, merge(common, json!({"outcome":"not_found","reason":not_found_reason(&lookups, read),"narrative":plan.meta["anchor"]["original"],"record":plan.meta["originalRecord"],"corrections":[]}))),
        }
    }

    /// One line per lookup in a correction or a question, for “查过：…” and the reason it stopped.
    pub(super) fn note_lookup(&self, shared: &Shared, name: &str, args: &Value, output: &Value) -> Result<()> {
        let query = args["query"].as_str().map(str::to_owned)
            .or_else(|| args["claims"].as_array().map(|c| c.iter().filter_map(|v| v.as_str().or_else(|| v["claim"].as_str())).collect::<Vec<_>>().join("；")))
            .or_else(|| args["section"].as_u64().map(|s| format!("第{}章", s + 1)))
            .unwrap_or_default();
        let hits = ["excerpts", "facts", "notes", "candidates"].iter().find_map(|k| output[*k].as_array().map(Vec::len)).unwrap_or(0);
        let message = output["message"].as_str().unwrap_or("");
        let entry = json!({"tool":name,"query":query,"hits":hits,"status":output["status"],
            "nearby":output["match"] == "nearby","beyondScope":output["beyondScope"] == true,
            "outOfRange":output["isError"] == true && (message.contains("超出了本局允许的参考章节") || message.contains("不在本次选定的资料范围"))});
        let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
        if !c.draft["lookupLog"].is_array() {
            c.draft["lookupLog"] = json!([]);
        }
        if let Some(list) = c.draft["lookupLog"].as_array_mut() {
            list.push(entry);
        }
        Ok(())
    }
}

/// What a correction has read so far, kept in view for every request (newest
/// first, within a quarter of the budget), leaving out what the messages already
/// show. A system message is never trimmed, so older duplicate tool rounds go first.
pub(super) fn with_read_ledger(shared: &Shared, messages: Vec<Value>, budget: usize) -> Result<Vec<Value>> {
    let passages = shared.lock().map_err(|_| Error::Cancelled)?.draft["originalPassages"].as_array().cloned().unwrap_or_default();
    Ok(read_ledger(&passages, messages, budget))
}

fn read_ledger(passages: &[Value], mut messages: Vec<Value>, budget: usize) -> Vec<Value> {
    let visible = |text: &str| messages.iter().any(|m| m["role"] != "system" && m["content"].as_str().is_some_and(|c| c.contains(text)));
    let room = budget / 4;
    let mut ledger = String::new();
    let mut left_out = 0usize;
    for passage in passages.iter().rev().filter(|p| p["match"] != "nearby") {
        let Some(text) = passage["text"].as_str().filter(|t| !t.is_empty()) else { continue };
        if visible(text) {
            continue;
        }
        let entry = format!("\n[原著·{}·section={}·chunk={}]\n{}\n", passage["title"].as_str().unwrap_or(""), passage["section"], passage["chunk"], text);
        if ledger.encode_utf16().count() + entry.encode_utf16().count() > room {
            left_out += 1;
            continue;
        }
        ledger += &entry;
    }
    if ledger.is_empty() {
        return messages;
    }
    if left_out > 0 {
        ledger += &format!("\n（较早读过的 {left_out} 段未列出，需要时用 read_original 重读）");
    }
    let at = messages.iter().position(|m| m["role"] != "system").unwrap_or(messages.len());
    messages.insert(at, json!({"role":"system","content":format!("【本次已读原文】引文只能逐字摘自这里或上文的原文。{ledger}")}));
    messages
}

/// The outcome the model gave, or the one its answer shows; a “change” that changes nothing is not one.
fn classify(response: &Value, plan: &RunPlan) -> &'static str {
    let has = |key: &str| response[key].as_array().is_some_and(|a| !a.is_empty());
    let given = match response["outcome"].as_str() {
        Some("changed") => "changed",
        Some("verified") => "verified",
        Some("answer") => "answer",
        Some("not_found") => "not_found",
        _ if has("corrections") => "changed",
        _ if has("findings") => if response["answer"].as_str().is_some_and(|s| !s.trim().is_empty()) { "answer" } else { "verified" },
        _ => "not_found",
    };
    if given != "changed" {
        return given;
    }
    // Same words once punctuation and spaces go, and no record change: nothing to adopt.
    let original = plan.meta["anchor"]["original"].as_str().unwrap_or("");
    let range = &plan.meta["correctionRange"];
    let selected = utf16_slice(original, range["start"].as_u64().unwrap_or(0) as usize, range["end"].as_u64().unwrap_or(original.encode_utf16().count() as u64) as usize);
    let replacement = response["replacement"].as_str().unwrap_or("");
    let unchanged_text = !replacement.trim().is_empty() && plain(replacement) == plain(&selected);
    let patch_empty = response["recordPatch"].as_object().is_none_or(|o| o.is_empty()) && response["correctionPatch"].as_object().is_none_or(|o| o.is_empty());
    if !has("corrections") || (unchanged_text && patch_empty) {
        if has("findings") { "verified" } else { "not_found" }
    } else {
        "changed"
    }
}

fn utf16_slice(text: &str, start: usize, end: usize) -> String {
    let mut at = 0;
    text.chars().filter(|c| { let old = at; at += c.len_utf16(); old >= start && at <= end }).collect()
}

/// Letters and digits only: what a quote and the book must share.
fn plain(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Why nothing could be cited: beyond the reading limit, nothing relevant read, or read but no basis.
fn not_found_reason(lookups: &[Value], read: usize) -> &'static str {
    if lookups.iter().any(|l| l["beyondScope"] == true || l["outOfRange"] == true) {
        "out_of_range"
    } else if read == 0 {
        "no_excerpt"
    } else {
        "no_basis"
    }
}

/// Lookups grouped by what was asked: “查过：比试（2 次，命中 3 段）”.
fn searched(log: &Value) -> Value {
    let mut out: Vec<Value> = vec![];
    for entry in log.as_array().into_iter().flatten() {
        let (tool, query) = (entry["tool"].as_str().unwrap_or(""), entry["query"].as_str().unwrap_or(""));
        if query.is_empty() || tool == "read_skill" || tool == "read_world" {
            continue;
        }
        let hits = if entry["nearby"] == true { 0 } else { entry["hits"].as_u64().unwrap_or(0) };
        if let Some(seen) = out.iter_mut().find(|s| s["tool"] == tool && s["query"] == query) {
            seen["times"] = (seen["times"].as_u64().unwrap_or(1) + 1).into();
            seen["hits"] = seen["hits"].as_u64().unwrap_or(0).max(hits).into();
        } else {
            out.push(json!({"tool":tool,"query":query,"hits":hits,"times":1}));
        }
    }
    Value::Array(out)
}

fn merge(mut base: Value, extra: Value) -> Value {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            base.insert(k.clone(), v.clone());
        }
    }
    base
}

/// Finds a quote in what was actually read, ignoring punctuation and spaces,
/// and gives it back as the book's exact words with their place.
pub(crate) fn locate_citation(passages: &[Value], cite: &Value, book: &Value) -> Option<Value> {
    let quote = cite["quote"].as_str().unwrap_or("");
    let wanted: Vec<char> = quote.chars().filter(|c| c.is_alphanumeric()).collect();
    if wanted.len() < MIN_QUOTE {
        return None;
    }
    let cited = |p: &&Value| p["section"] == cite["section"] && p["chunk"] == cite["chunk"];
    let ordered = passages.iter().filter(cited).chain(passages.iter().filter(|p| !cited(p)));
    for passage in ordered {
        let Some(text) = passage["text"].as_str() else { continue };
        // (char, byte start, byte end, utf16 start) for the letters and digits of the passage.
        let mut kept = vec![];
        let mut utf16 = 0usize;
        for (byte, ch) in text.char_indices() {
            if ch.is_alphanumeric() {
                kept.push((ch, byte, byte + ch.len_utf8(), utf16));
            }
            utf16 += ch.len_utf16();
        }
        let Some(at) = kept.windows(wanted.len()).position(|w| w.iter().map(|k| k.0).eq(wanted.iter().copied())) else { continue };
        let (first, last) = (kept[at], kept[at + wanted.len() - 1]);
        let exact = &text[first.1..last.2];
        let start = passage["start"].as_u64().unwrap_or(0) + first.3 as u64;
        let end = start + exact.encode_utf16().count() as u64;
        let mut found = cite.clone();
        found["bookId"] = passage.get("bookId").filter(|b| b.is_string()).unwrap_or(book).clone();
        found["section"] = passage["section"].clone();
        found["chunk"] = passage["chunk"].clone();
        found["quote"] = exact.into();
        found["title"] = passage["title"].clone();
        if passage["page"].is_number() {
            found["page"] = passage["page"].clone();
        } else if let Some(fields) = found.as_object_mut() {
            fields.remove("page");
        }
        found["start"] = start.into();
        found["end"] = end.into();
        return Some(found);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn passage(section: i64, chunk: i64, text: &str, start: u64) -> Value {
        json!({"kind":"original","section":section,"chunk":chunk,"title":"第一章","text":text,"start":start})
    }

    #[test]
    fn a_quote_is_found_despite_punctuation_and_spaces_and_given_back_exactly() {
        let read = [passage(0, 0, "前文。入门比试，分为实战与理论两项。后文", 100)];
        let found = locate_citation(&read, &json!({"quote":"入门比试 分为实战与理论两项"}), &json!("book")).unwrap();
        assert_eq!(found["quote"], "入门比试，分为实战与理论两项");
        assert_eq!(found["start"], 103);
        assert_eq!(found["end"], 103 + "入门比试，分为实战与理论两项".encode_utf16().count() as u64);
        assert_eq!(found["bookId"], "book");
        assert_eq!(found["section"], 0);
    }

    #[test]
    fn the_cited_passage_is_preferred_and_short_or_unread_quotes_are_refused() {
        let read = [passage(0, 0, "入门比试分为实战与理论两项。", 0), passage(5, 9, "入门比试分为实战与理论两项。", 0)];
        let found = locate_citation(&read, &json!({"quote":"入门比试分为实战","section":5,"chunk":9}), &json!("book")).unwrap();
        assert_eq!((found["section"].clone(), found["chunk"].clone()), (json!(5), json!(9)));
        assert!(locate_citation(&read, &json!({"quote":"比试"}), &json!("book")).is_none());
        assert!(locate_citation(&read, &json!({"quote":"内院比试在秋天举行"}), &json!("book")).is_none());
    }

    #[test]
    fn only_a_page_read_from_the_original_is_returned() {
        let mut original = passage(0, 0, "入门比试分为实战与理论两项。", 0);
        for claimed in [json!(null), json!(3)] {
            let found = locate_citation(&[original.clone()], &json!({"quote":"入门比试分为实战","page":claimed}), &json!("book")).unwrap();
            assert!(found.get("page").is_none());
        }
        original["page"] = 12.into();
        let found = locate_citation(&[original], &json!({"quote":"入门比试分为实战","page":3}), &json!("book")).unwrap();
        assert_eq!(found["page"], 12);
    }

    #[test]
    fn read_passages_no_longer_shown_are_pinned_newest_first_within_a_quarter() {
        let read = [passage(0, 0, &"甲".repeat(400), 0), passage(1, 2, &"乙".repeat(400), 0), passage(2, 4, &"丙".repeat(400), 0)];
        let messages = vec![json!({"role":"system","content":"规则"}), json!({"role":"user","content":format!("要求{}", "丙".repeat(400))})];
        let out = read_ledger(&read, messages, 2000);
        let ledger = out[1]["content"].as_str().unwrap();
        assert!(ledger.starts_with("【本次已读原文】"));
        // 丙 is still shown in the user message; 乙 is newest of the rest; 甲 does not fit a quarter of 2000.
        assert!(ledger.contains(&"乙".repeat(400)) && !ledger.contains(&"丙".repeat(400)) && !ledger.contains(&"甲".repeat(400)));
        assert!(ledger.contains("较早读过的 1 段未列出"));
        assert_eq!(out[2]["role"], "user");
        // Nothing to pin: messages unchanged.
        assert_eq!(read_ledger(&[], vec![json!({"role":"user","content":"x"})], 2000).len(), 1);
    }

    #[test]
    fn lookups_are_grouped_and_a_nearby_fallback_is_no_hit() {
        let log = json!([
            {"tool":"search_original","query":"比试","hits":2,"nearby":false},
            {"tool":"search_original","query":"比试","hits":3,"nearby":false},
            {"tool":"search_original","query":"紫色","hits":1,"nearby":true},
            {"tool":"read_skill","query":"canon-reference","hits":0}
        ]);
        assert_eq!(searched(&log), json!([{"tool":"search_original","query":"比试","hits":3,"times":2},{"tool":"search_original","query":"紫色","hits":0,"times":1}]));
        assert_eq!(not_found_reason(&[json!({"beyondScope":true})], 3), "out_of_range");
        assert_eq!(not_found_reason(&[], 0), "no_excerpt");
        assert_eq!(not_found_reason(&[], 2), "no_basis");
    }
}
