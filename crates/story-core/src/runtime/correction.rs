//! 按原著纠错的收尾 (R30 step 3, D182): what the model found becomes one of four
//! outcomes, each told to the player as it is. Only `changed` can be adopted;
//! `verified` (the passage already agrees with the book), `answer` (the player
//! asked a question) and `not_found` (with the reason and what was searched) are
//! previews too, so nothing the model checked is lost behind a failure.
use super::*;

/// The last request of a correction: answer from what was read, in one of the four forms.
pub(super) const CORRECTION_FINAL: &str = "【查阅到此为止】不要再调用工具。依据上文已读原文直接返回 JSON：有原著依据的更正写进 corrections（引文逐字摘自已读原文）；这段与原著一致，就把 outcome 写成 verified，并在 findings 里附上引文；玩家在提问，就把 outcome 写成 answer，answer 写答案，findings 附引文；查不到依据，就把 outcome 写成 not_found，把缺什么写进 unresolved。不凭记忆补原著细节。";

/// Quotes shorter than this, once punctuation and spaces are dropped, could match anywhere.
const MIN_QUOTE: usize = 4;

fn sanitize_correction_patch(raw: &Value) -> Option<Value> {
    let obj = raw.as_object()?;
    let mut kept = serde_json::Map::new();
    for (key, value) in obj {
        if value.is_null() {
            continue;
        }
        match key.as_str() {
            "profile" => {
                if let Some(map) = value.as_object() {
                    let clean: serde_json::Map<String, Value> = map
                        .iter()
                        .filter(|(k, v)| {
                            matches!(k.as_str(), "name" | "age" | "identity" | "origin") && !v.is_null()
                        })
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    if !clean.is_empty() {
                        kept.insert(key.clone(), Value::Object(clean));
                    }
                }
            }
            "cards" => {
                if let Some(arr) = value.as_array() {
                    let cards: Vec<Value> = arr
                        .iter()
                        .filter_map(|c| {
                            let mut map = c.as_object()?.clone();
                            if map.get("op").and_then(Value::as_str) == Some("remove") {
                                return None;
                            }
                            let name = map.get("name").and_then(Value::as_str)?.trim();
                            if name.is_empty() {
                                return None;
                            }
                            map.remove("source");
                            Some(Value::Object(map))
                        })
                        .collect();
                    if !cards.is_empty() {
                        kept.insert(key.clone(), Value::Array(cards));
                    }
                }
            }
            "people" | "places" => {
                if let Some(arr) = value.as_array() {
                    let items: Vec<Value> = arr.iter().filter(|v| v.is_object()).cloned().collect();
                    if !items.is_empty() {
                        kept.insert(key.clone(), Value::Array(items));
                    }
                }
            }
            "place" => {
                if value.as_str().is_some_and(|s| !s.trim().is_empty()) {
                    kept.insert(key.clone(), value.clone());
                }
            }
            _ => {}
        }
    }
    (!kept.is_empty()).then_some(Value::Object(kept))
}

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
        let (mut unresolved, related) = (lists("unresolved"), lists("related"));
        let read = passages.iter().filter(|p| p["match"] != "nearby").count();
        let make_common = |unresolved_list: &Vec<Value>| {
            json!({"anchor":plan.meta["anchor"],"sourceGuard":plan.meta["sourceGuard"].to_string(),"writingVersion":plan.meta["writingVersion"],
                "reference":reference,"searched":searched,"read":read,"unresolved":unresolved_list,"related":related,"baseline":plan.meta["baseline"],"range":plan.meta["correctionRange"]})
        };
        let stop = |code: &str, quotes: Vec<Value>, unresolved_list: &Vec<Value>| -> Result<()> {
            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
            c.draft["correctionStop"] = json!({"code":code,"quotes":quotes,"unresolved":unresolved_list,"related":related,"searched":searched,"read":read});
            Ok(())
        };
        match classify(&response, plan) {
            "changed" if passages.is_empty() => {
                // Nothing from the book reached the model: it cannot have a basis to cite.
                self.finish_preview(shared, merge(make_common(&unresolved), json!({"outcome":"not_found","reason":not_found_reason(&lookups, 0),"narrative":plan.meta["anchor"]["original"],"record":plan.meta["originalRecord"],"corrections":[]})))
            }
            "changed" => {
                let response = crate::writing_context::local_correction(plan, &response).map_err(check_reply_error)?;
                let raw_corrections = response["corrections"].as_array().filter(|a| !a.is_empty()).cloned().unwrap_or_default();
                let player_facts: Vec<_> = plan.state["facts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|f| {
                        f["origin"] == "player"
                            && f["id"].as_str().is_some_and(|s| !s.is_empty())
                            && f["detail"].as_str().is_some_and(|s| !s.trim().is_empty())
                    })
                    .map(|f| json!({"id":f["id"],"detail":f["detail"]}))
                    .collect();
                let mut preserved = false;
                let mut kept_corrections = vec![];
                let mut missing = vec![];
                let mut downgraded = vec![];
                for mut change in raw_corrections {
                    let detail = change["detail"].as_str().unwrap_or("").trim().to_owned();
                    let raw_cites = change["citations"].as_array().cloned().unwrap_or_default();
                    if raw_cites.is_empty() {
                        if (change["origin"] == "player" || detail.starts_with("保留玩家分支")) && !player_facts.is_empty() {
                            preserved = true;
                        } else if !detail.is_empty() {
                            downgraded.push(Value::String(format!("未附原文出处，未采纳：{detail}")));
                        }
                        continue;
                    }
                    let mut located = vec![];
                    for cite in &raw_cites {
                        match locate_citation(&passages, cite, &book) {
                            Some(found) => located.push(found),
                            None => {
                                if let Some(q) = cite["quote"].as_str().filter(|s| !s.trim().is_empty()) {
                                    missing.push(Value::String(q.to_owned()));
                                }
                            }
                        }
                    }
                    if located.is_empty() {
                        if !detail.is_empty() {
                            downgraded.push(Value::String(format!("引文未对应到已读原文，未采纳：{detail}")));
                        }
                    } else {
                        change["citations"] = Value::Array(located);
                        kept_corrections.push(change);
                    }
                }
                let preserved_player_facts = if preserved { player_facts } else { vec![] };
                if kept_corrections.is_empty() {
                    if !missing.is_empty() {
                        stop("quote_mismatch", missing, &unresolved)?;
                        return Err(Error::fail(crate::failure::FailKind::Review, "改稿引用的原文和实际查到的对不上，没有采用"));
                    }
                    unresolved.extend(downgraded);
                    // Only notes about the player's own branch or uncited claims: nothing from the book to adopt.
                    return self.finish_preview(shared, merge(make_common(&unresolved), json!({"outcome":"not_found","reason":"no_basis","narrative":plan.meta["anchor"]["original"],"record":plan.meta["originalRecord"],"corrections":[],"preservedPlayerFacts":preserved_player_facts})));
                }
                unresolved.extend(downgraded);
                let mut issues = vec![];
                let record = rules::record::normalize_record(&response["record"], &mut issues)
                    .or_else(|| rules::record::normalize_record(&plan.meta["originalRecord"], &mut issues))
                    .ok_or_else(|| Error::fail(crate::failure::FailKind::Review, "改稿尚未完成事实整理"))?;
                let mut payload = json!({"outcome":"changed","narrative":response["narrative"],"replacement":response["replacement"],"range":response["range"],"record":record,"corrections":kept_corrections,"preservedPlayerFacts":preserved_player_facts});
                if let Some(clean_patch) = sanitize_correction_patch(&response["correctionPatch"]) {
                    payload["correctionPatch"] = clean_patch;
                }
                self.finish_preview(shared, merge(make_common(&unresolved), payload))
            }
            outcome @ ("verified" | "answer") => {
                let mut findings = vec![];
                let mut missing = vec![];
                for finding in response["findings"].as_array().into_iter().flatten() {
                    let mut located = vec![];
                    for cite in finding["citations"].as_array().into_iter().flatten() {
                        match locate_citation(&passages, cite, &book) {
                            Some(found) => located.push(found),
                            None => {
                                if let Some(q) = cite["quote"].as_str().filter(|s| !s.trim().is_empty()) {
                                    missing.push(Value::String(q.to_owned()));
                                }
                            }
                        }
                    }
                    if !located.is_empty() {
                        findings.push(json!({"detail":finding["detail"],"citations":located}));
                    }
                }
                if findings.is_empty() {
                    if !missing.is_empty() {
                        stop("quote_mismatch", missing, &unresolved)?;
                        return Err(Error::fail(crate::failure::FailKind::Review, "核对引用的原文和实际查到的对不上"));
                    }
                    return self.finish_preview(shared, merge(make_common(&unresolved), json!({"outcome":"not_found","reason":not_found_reason(&lookups, read),"narrative":plan.meta["anchor"]["original"],"record":plan.meta["originalRecord"],"corrections":[]})));
                }
                let answer = response["answer"].as_str().map(str::trim).unwrap_or("");
                self.finish_preview(shared, merge(make_common(&unresolved), json!({"outcome":outcome,"findings":findings,"answer":answer,"narrative":plan.meta["anchor"]["original"],"record":plan.meta["originalRecord"],"corrections":[]})))
            }
            _ => self.finish_preview(shared, merge(make_common(&unresolved), json!({"outcome":"not_found","reason":not_found_reason(&lookups, read),"narrative":plan.meta["anchor"]["original"],"record":plan.meta["originalRecord"],"corrections":[]}))),
        }
    }

    /// One line per lookup in a correction or a question, for “查过：…” and the reason it stopped.
    pub(super) fn note_lookup(&self, shared: &Shared, name: &str, args: &Value, output: &Value) -> Result<()> {
        let query = args["query"].as_str().map(str::to_owned)
            .or_else(|| args["queries"].as_array().map(|c| c.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("；")))
            .or_else(|| args["claims"].as_array().map(|c| c.iter().filter_map(|v| v.as_str().or_else(|| v["claim"].as_str())).collect::<Vec<_>>().join("；")))
            .or_else(|| args["section"].as_u64().map(|s| format!("第{}节", s + 1)))
            .unwrap_or_default();
        let nested_items = output["items"].as_array();
        let hits = if let Some(items) = nested_items {
            items.iter().filter(|i| i["nearbyOnly"] != true).map(|i| i["candidates"].as_array().map(Vec::len).unwrap_or(0)).sum()
        } else {
            ["excerpts", "facts", "notes", "sections", "candidates"].iter().find_map(|k| output[*k].as_array().map(Vec::len)).unwrap_or(0)
        };
        let beyond = output["beyondScope"] == true
            || nested_items.is_some_and(|items| items.iter().any(|i| i["beyondScope"] == true));
        let nearby = output["match"] == "nearby"
            || nested_items.is_some_and(|items| !items.is_empty() && items.iter().all(|i| i["nearbyOnly"] == true));
        let message = output["message"].as_str().unwrap_or("");
        let entry = json!({"tool":name,"query":query,"hits":hits,"status":output["status"],
            "nearby":nearby,"beyondScope":beyond,
            "outOfRange":output["isError"] == true && (message.contains("超出了本局允许的参考") || message.contains("不在本次选定的资料范围") || message.contains("这次只查"))});
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
/// show (including JSON-escaped tool excerpts). Appended near the end so the
/// earlier prompt prefix stays cacheable.
pub(super) fn with_read_ledger(shared: &Shared, messages: Vec<Value>, budget: usize) -> Result<Vec<Value>> {
    let passages = shared.lock().map_err(|_| Error::Cancelled)?.draft["originalPassages"].as_array().cloned().unwrap_or_default();
    Ok(read_ledger(&passages, messages, budget))
}

fn passage_visible(messages: &[Value], passage: &Value, text: &str) -> bool {
    let section = &passage["section"];
    let chunk = &passage["chunk"];
    messages.iter().any(|m| {
        if m["role"] == "system" {
            return false;
        }
        let Some(content) = m["content"].as_str() else {
            return false;
        };
        if content.contains(text) {
            return true;
        }
        if m["role"] == "tool" {
            if let Ok(parsed) = serde_json::from_str::<Value>(content) {
                if parsed["excerpts"].as_array().is_some_and(|arr| {
                    arr.iter().any(|e| {
                        e["section"] == *section
                            && e["chunk"] == *chunk
                            && e["text"].as_str().is_some_and(|t| t.contains(text))
                    })
                }) {
                    return true;
                }
            }
        }
        false
    })
}

fn read_ledger(passages: &[Value], mut messages: Vec<Value>, budget: usize) -> Vec<Value> {
    let room = budget / 4;
    let mut ledger = String::new();
    let mut left_out = 0usize;
    for passage in passages.iter().rev().filter(|p| p["match"] != "nearby") {
        let Some(text) = passage["text"].as_str().filter(|t| !t.is_empty()) else { continue };
        if passage_visible(&messages, passage, text) {
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
    // Insert right before any trailing final-only / allowance system message, keeping the prefix intact.
    let mut at = messages.len();
    while at > 0 && messages[at - 1]["role"] == "system" {
        at -= 1;
    }
    messages.insert(at, json!({"role":"system","ephemeralLedger":true,"content":format!("【本次已读原文】引文只能逐字摘自这里或上文的原文。{ledger}")}));
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

fn build_citation(passage: &Value, cite: &Value, book: &Value, exact: &str, utf16_offset: usize) -> Value {
    let start = passage["start"].as_u64().unwrap_or(0) + utf16_offset as u64;
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
    found
}

fn alnum_index(text: &str) -> Vec<(char, usize, usize, usize)> {
    let mut kept = vec![];
    let mut utf16 = 0usize;
    for (byte, ch) in text.char_indices() {
        if ch.is_alphanumeric() {
            kept.push((ch, byte, byte + ch.len_utf8(), utf16));
        }
        utf16 += ch.len_utf16();
    }
    kept
}

fn find_exact_in_passage(passage: &Value, wanted: &[char], cite: &Value, book: &Value) -> Option<Value> {
    let text = passage["text"].as_str()?;
    let kept = alnum_index(text);
    let at = kept
        .windows(wanted.len())
        .position(|w| w.iter().map(|k| k.0).eq(wanted.iter().copied()))?;
    let (first, last) = (kept[at], kept[at + wanted.len() - 1]);
    Some(build_citation(passage, cite, book, &text[first.1..last.2], first.3))
}

/// Finds a quote in what was actually read, ignoring punctuation and spaces,
/// supporting ellipsis-shortened quotes and adjacent same-section chunk boundaries,
/// and gives it back as the book's exact words with their place.
pub(crate) fn locate_citation(passages: &[Value], cite: &Value, book: &Value) -> Option<Value> {
    let quote = cite["quote"].as_str().unwrap_or("");
    let wanted: Vec<char> = quote.chars().filter(|c| c.is_alphanumeric()).collect();
    if wanted.len() < MIN_QUOTE {
        return None;
    }
    // Nearby fallback excerpts are not matched evidence and cannot ground a correction.
    let valid: Vec<&Value> = passages
        .iter()
        .filter(|p| p["kind"] == "original" && p["match"] != "nearby")
        .collect();
    let cited = |p: &&&Value| p["section"] == cite["section"] && p["chunk"] == cite["chunk"];
    let ordered: Vec<&Value> = valid
        .iter()
        .filter(cited)
        .chain(valid.iter().filter(|p| !cited(p)))
        .copied()
        .collect();
    // 1. Exact punctuation-stripped match inside a single passage.
    for passage in &ordered {
        if let Some(found) = find_exact_in_passage(passage, &wanted, cite, book) {
            return Some(found);
        }
    }
    // 2. Ellipsis-shortened quote (e.g. “考核分为……实战和理论”): match all segments in order inside one passage.
    if quote.contains('…') || quote.contains("...") {
        let normalized_sep = quote.replace("……", "…").replace("...", "…");
        let segs: Vec<Vec<char>> = normalized_sep
            .split('…')
            .map(|s| s.chars().filter(|c| c.is_alphanumeric()).collect::<Vec<_>>())
            .filter(|v| v.len() >= 3)
            .collect();
        if segs.len() >= 2 {
            for passage in &ordered {
                let Some(text) = passage["text"].as_str() else { continue };
                let kept = alnum_index(text);
                let mut cursor = 0usize;
                let mut first_span: Option<(usize, usize)> = None;
                let mut end_idx = 0usize;
                let mut matched_all = true;
                for seg in &segs {
                    let found_rel = kept[cursor..]
                        .windows(seg.len())
                        .position(|w| w.iter().map(|k| k.0).eq(seg.iter().copied()));
                    if let Some(rel) = found_rel {
                        let start_i = cursor + rel;
                        let finish_i = start_i + seg.len() - 1;
                        if first_span.is_none() {
                            first_span = Some((start_i, finish_i));
                        }
                        end_idx = finish_i;
                        cursor = finish_i + 1;
                    } else {
                        matched_all = false;
                        break;
                    }
                }
                if matched_all {
                    if let Some((start_i, seg0_end)) = first_span {
                        let first = kept[start_i];
                        let last = kept[end_idx];
                        let full_exact = &text[first.1..last.2];
                        // If the full span between ellipsis parts is reasonably tight, cite the exact continuous span;
                        // otherwise cite the longest matched segment verbatim (always >= MIN_QUOTE or fallback to first segment).
                        if full_exact.chars().count() <= 320 {
                            return Some(build_citation(passage, cite, book, full_exact, first.3));
                        }
                        let seg0 = &text[first.1..kept[seg0_end].2];
                        if seg0.chars().filter(|c| c.is_alphanumeric()).count() >= MIN_QUOTE {
                            return Some(build_citation(passage, cite, book, seg0, first.3));
                        }
                    }
                }
            }
        }
    }
    // 3. Cross-chunk boundary inside the same section (chunk c followed by chunk c + 1):
    // match across the boundary and return the dominant chunk's exact verbatim slice so adoption stays exact.
    for a in &ordered {
        let (Some(sec), Some(c0), Some(t0)) = (a["section"].as_i64(), a["chunk"].as_i64(), a["text"].as_str()) else {
            continue;
        };
        let Some(b) = valid.iter().copied().find(|p| p["section"].as_i64() == Some(sec) && p["chunk"].as_i64() == Some(c0 + 1)) else {
            continue;
        };
        let Some(t1) = b["text"].as_str() else { continue };
        let k0 = alnum_index(t0);
        let k1 = alnum_index(t1);
        let split = k0.len();
        let combined: Vec<char> = k0.iter().chain(k1.iter()).map(|k| k.0).collect();
        let Some(at) = combined.windows(wanted.len()).position(|w| w == wanted.as_slice()) else {
            continue;
        };
        let end_pos = at + wanted.len();
        if at < split && end_pos > split {
            let left_len = split - at;
            let right_len = end_pos - split;
            if left_len >= right_len && left_len >= MIN_QUOTE {
                let (first, last) = (k0[at], k0[split - 1]);
                return Some(build_citation(a, cite, book, &t0[first.1..last.2], first.3));
            } else if right_len >= MIN_QUOTE {
                let (first, last) = (k1[0], k1[right_len - 1]);
                return Some(build_citation(b, cite, book, &t1[first.1..last.2], first.3));
            }
        }
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
        // Appended after the user/history messages so the earlier prompt prefix stays cacheable.
        let ledger = out[2]["content"].as_str().unwrap();
        assert!(ledger.starts_with("【本次已读原文】"));
        // 丙 is still shown in the user message; 乙 is newest of the rest; 甲 does not fit a quarter of 2000.
        assert!(ledger.contains(&"乙".repeat(400)) && !ledger.contains(&"丙".repeat(400)) && !ledger.contains(&"甲".repeat(400)));
        assert!(ledger.contains("较早读过的 1 段未列出"));
        assert_eq!(out[1]["role"], "user");
        // Multi-line tool excerpts (JSON-escaped as \n) are recognized as already visible and not duplicated.
        let multi = passage(3, 5, "第一行原文。\n第二行原文。", 0);
        let with_tool = vec![
            json!({"role":"system","content":"规则"}),
            json!({"role":"user","content":"核对"}),
            json!({"role":"tool","tool_call_id":"t1","content":json!({"excerpts":[multi.clone()]}).to_string()}),
        ];
        assert_eq!(read_ledger(&[multi], with_tool, 4000).len(), 3);
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
