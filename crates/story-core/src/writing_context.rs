//! Shared, bounded ordinary-writing projection. Full state remains in the run.
use crate::{rules, Error, Result};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};

const HISTORY_EVICT_STEP: usize = 5;

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn size(s: &str) -> usize {
    s.encode_utf16().count()
}
fn tail(s: &str, cap: usize) -> String {
    let mut chars: Vec<char> = s.chars().collect();
    let mut n = size(s);
    let mut i = 0;
    while n > cap && i < chars.len() {
        n -= chars[i].len_utf16();
        i += 1;
    }
    chars.drain(..i);
    chars.into_iter().collect()
}
fn head(s: &str, cap: usize) -> String {
    let mut n = 0;
    s.chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= cap
        })
        .collect()
}
fn names(v: &Value) -> Vec<&str> {
    let mut out = Vec::new();
    let name = text(&v["name"]);
    if !name.is_empty() {
        out.push(name);
    }
    for alias in list(&v["aliases"]).iter().chain(list(&v["keys"]).iter()).filter_map(Value::as_str) {
        if alias.chars().count() >= 2 {
            out.push(alias);
        }
    }
    out
}
fn mentioned(v: &Value, recent: &str) -> bool {
    names(v).iter().any(|name| recent.contains(name))
}
fn last_mention_pos(v: &Value, recent: &str) -> Option<usize> {
    names(v).iter().filter_map(|name| recent.rfind(name)).max()
}

pub fn project_state(state: &Value, era: &Value, recent: &str) -> String {
    let me = &state["protagonist"];
    let currency = &era["currency"];
    let now = rules::calendar::now_of(
        &era["clock"],
        state["time"]["elapsedMinutes"].as_f64().unwrap_or(0.0),
    );
    let place = list(&state["places"])
        .iter()
        .find(|p| !state["placeId"].is_null() && p["id"] == state["placeId"])
        .map(|p| text(&p["name"]))
        .unwrap_or("（未记录）");
    let mut items_vec = Vec::new();
    let mut items_chars = 0usize;
    for i in list(&me["items"]).iter().take(48) {
        let entry = format!(
            "{}×{}{}{}",
            text(&i["name"]),
            i["quantity"],
            text(&i["unit"]),
            if text(&i["place"]).is_empty() {
                String::new()
            } else {
                format!("（放在{}）", head(text(&i["place"]), 32))
            }
        );
        if !items_vec.is_empty() && items_chars + size(&entry) + 1 > 900 {
            break;
        }
        items_chars += size(&entry) + 1;
        items_vec.push(entry);
    }
    let items = items_vec.join("、");
    let statuses = list(&me["statuses"])
        .iter()
        .map(|s| {
            format!(
                "{}{}",
                text(&s["name"]),
                if text(&s["detail"]).is_empty() {
                    String::new()
                } else {
                    format!("：{}", head(text(&s["detail"]), 80))
                }
            )
        })
        .collect::<Vec<_>>()
        .join("；");
    let mut people = list(&state["people"]).iter().collect::<Vec<_>>();
    people.sort_by(|a, b| {
        let ma = last_mention_pos(a, recent);
        let mb = last_mention_pos(b, recent);
        mb.is_some()
            .cmp(&ma.is_some())
            .then_with(|| mb.cmp(&ma))
            .then_with(|| {
                b["lastSeenMinute"]
                    .as_i64()
                    .unwrap_or(-1)
                    .cmp(&a["lastSeenMinute"].as_i64().unwrap_or(-1))
            })
    });
    const PEOPLE_BUDGET: usize = 2400;
    const REST_BUDGET: usize = 400;
    let mut detailed = Vec::new();
    let mut detailed_chars = 0usize;
    let mut overflow_idx = 0usize;
    for (idx, p) in people.iter().enumerate() {
        if detailed.len() >= 30 {
            break;
        }
        let is_mentioned = last_mention_pos(p, recent).is_some();
        let extra = if is_mentioned {
            let origin = head(text(&p["origin"]).trim(), 80);
            let notes = head(text(&p["notes"]).trim(), 120);
            match (origin.is_empty(), notes.is_empty()) {
                (true, true) => String::new(),
                (false, true) => format!("；{origin}"),
                (true, false) => format!("；{notes}"),
                (false, false) => format!("；{origin}；{notes}"),
            }
        } else {
            String::new()
        };
        let line = format!(
            "{}{}：{}，对主角{}{}{}",
            text(&p["name"]),
            if list(&p["aliases"]).is_empty() {
                String::new()
            } else {
                format!(
                    "（又称{}）",
                    list(&p["aliases"])
                        .iter()
                        .map(text)
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join("、")
                )
            },
            if text(&p["role"]).is_empty() {
                "身份不明"
            } else {
                text(&p["role"])
            },
            text(&p["attitude"]),
            if p["alive"] == false { "，已死" } else { "" },
            extra
        );
        let cost = size(&line) + 1;
        if !detailed.is_empty() && detailed_chars + cost > PEOPLE_BUDGET {
            break;
        }
        detailed_chars += cost;
        detailed.push(line);
        overflow_idx = idx + 1;
    }
    let lines = detailed.join("\n");
    let mut rest_vec = Vec::new();
    let mut rest_chars = 0usize;
    for p in people.iter().skip(overflow_idx).take(48) {
        let entry = format!(
            "{}{}",
            text(&p["name"]),
            if p["alive"] == false {
                "（已死）"
            } else {
                ""
            }
        );
        if !rest_vec.is_empty() && rest_chars + size(&entry) + 1 > REST_BUDGET {
            break;
        }
        rest_chars += size(&entry) + 1;
        rest_vec.push(entry);
    }
    let rest = rest_vec.join("、");
    let goals = list(&state["goals"])
        .iter()
        .filter(|g| g["status"] == "进行中")
        .map(|g| {
            format!(
                "【{}】{}{}",
                text(&g["kind"]),
                text(&g["name"]),
                if text(&g["progress"]).is_empty() {
                    String::new()
                } else {
                    format!("（{}）", head(text(&g["progress"]), 80))
                }
            )
        })
        .collect::<Vec<_>>()
        .join("；");
    let level = |n: f64, words: &[&str]| {
        words[(((100.0 - n) / 100.0 * words.len() as f64).floor().max(0.0) as usize)
            .min(words.len() - 1)]
        .to_owned()
    };
    let age = if me["age"].is_number() {
        format!("，{}岁", me["age"])
    } else {
        String::new()
    };
    let identity = head(text(&me["identity"]), 180);
    let origin = head(text(&me["origin"]), 180);
    let debt = me["stats"]["debt"].as_f64().unwrap_or(0.0);
    format!("【当前】{} · {}\n主角：{}，{}{}，{}{}\n可用的钱：{}（共 {} {}）{}\n身体：健康{}，精力{}\n身上的伤病与状态：{}\n行囊：{}\n已知人物：\n{}{}\n进行中的目标：{}",text(&now["text"]),place,text(&me["name"]),text(&me["gender"]),age,identity,if origin.is_empty(){String::new()}else{format!("（穿越前是{origin}）")},rules::money::format_money(me["stats"]["money"].as_f64().unwrap_or(0.0),currency),me["stats"]["money"],list(&currency["units"]).last().map(|u|text(&u["name"])).unwrap_or("钱"),if debt!=0.0{format!("；欠债 {}",rules::money::format_money(debt,currency))}else{String::new()},level(me["stats"]["health"].as_f64().unwrap_or(80.0),&["康健","微恙","带伤","重伤","垂危"]),level(me["stats"]["energy"].as_f64().unwrap_or(70.0),&["充沛","尚可","疲惫","力竭"]),if statuses.is_empty(){"无"}else{&statuses},if items.is_empty(){"无"}else{&items},if lines.is_empty(){"无"}else{&lines},if rest.is_empty(){String::new()}else{format!("\n另有：{rest}")},if goals.is_empty(){"无"}else{&goals})
}

/// Instruction wording is supplied by the existing prompt template. Selection,
/// evidence allowance, history fitting and accounting have one native owner.
pub fn build(input: &Value) -> Result<Value> {
    let state = &input["state"];
    let settings = &input["settings"];
    let template = &input["template"];
    let cap = input["budgetChars"].as_u64().unwrap_or(12000) as usize;
    let history = list(&input["history"]);
    let mut recent_turns = history
        .iter()
        .rev()
        .filter(|n| n["kind"] != "edit")
        .take(3)
        .map(|n| format!("{}\n{}", text(&n["actionText"]), text(&n["narrative"])))
        .collect::<Vec<_>>();
    recent_turns.reverse();
    let recent = format!(
        "{}\n{}\n{}",
        recent_turns.join("\n"),
        text(&input["text"]),
        text(&input["directorNote"])
    );
    let mut layers: Vec<Value> = vec![];
    let mut add = |key: &str, label: &str, content: String, note: &str| {
        layers.push(
            json!({"key":key,"label":label,"chars":size(&content),"content":content,"note":note}),
        );
    };
    add(
        "rules",
        "叙事规则",
        text(&template["rules"]).to_owned(),
        "沿用当前写作规则",
    );
    let panel = if settings["heroPanelEnabled"] == true
        && !text(&state["protagonist"]["panel"]).trim().is_empty()
    {
        format!(
            "\n【主角面板（玩家自记，仅作背景，不推算数值）】\n{}\n",
            text(&state["protagonist"]["panel"]).trim()
        )
    } else {
        String::new()
    };
    let premise = format!(
        "{}{}{}",
        if text(&settings["premise"]).trim().is_empty() {
            String::new()
        } else {
            format!(
                "\n【故事设定】（玩家写的，始终遵守）\n{}\n",
                text(&settings["premise"]).trim()
            )
        },
        if text(&settings["rules"]).trim().is_empty() {
            String::new()
        } else {
            format!(
                "\n【玩家给你的额外规则】（始终遵守）\n{}\n",
                text(&settings["rules"]).trim()
            )
        },
        panel
    );
    add("premise", "故事设定与额外规则", premise, "玩家要求完整保留");
    add(
        "era",
        "世界或时代卡",
        text(&template["era"]).to_owned(),
        "沿用当前世界资料",
    );
    add(
        "spec",
        "输出格式",
        text(&template["spec"]).to_owned(),
        "沿用回合记录格式",
    );
    add(
        "state",
        "当前状态与人物",
        project_state(state, &input["era"], &recent),
        "相关人物优先，完整状态留本机结算",
    );
    let essentials = std::iter::once(text(&settings["essentials"]))
        .flat_map(|s| s.lines())
        .chain(list(&input["pins"]).iter().map(text))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    add(
        "essentials",
        "要点",
        if essentials.is_empty() {
            String::new()
        } else {
            format!("\n【要点，必须记住】\n- {}", essentials.join("\n- "))
        },
        "玩家要点完整保留",
    );
    // Before 0.16.0 the native context left this layer out (D169).
    add(
        "world",
        "天下大事与历史偏离",
        if settings["mode"] == "free" { String::new() } else { crate::recall::world_block(state) },
        "只带近来已到时间的大事和已经改变的历史，不预告未来；不裁剪",
    );
    add(
        "directive",
        "叙事方针",
        if text(&settings["directive"]).is_empty() {
            String::new()
        } else {
            format!("\n【叙事方针】{}", text(&settings["directive"]))
        },
        "玩家要求完整保留",
    );
    let mut modes = String::new();
    if !list(&state["script"]["beats"]).is_empty() {
        modes=format!("\n【剧本】\n主线：{}\n{}\n想要的结局：{}\n当前未完成的这一幕自然发生，之后几幕先不写。",text(&state["script"]["line"]),list(&state["script"]["beats"]).iter().map(|b|format!("{}：{}",if b["status"]=="todo"{"待演"}else{"已演"},text(&b["text"]))).collect::<Vec<_>>().join("\n"),text(&state["script"]["ending"]));
    }
    if state["challenge"]["status"] == "active" {
        modes+=&format!("\n【挑战】{}\n期限：{}；失败条件：{}；最近进展：{}。成败依据实际行动和代价，不放水也不刻意刁难。",text(&state["challenge"]["goal"]),text(&state["challenge"]["limit"]),text(&state["challenge"]["failIf"]),text(&state["challenge"]["progress"]));
    }
    add("modes", "剧本与挑战", modes, "读取本段最新进度");
    add(
        "notes",
        "程序提示",
        text(&template["notes"]).to_owned(),
        "保留结算与用词提示",
    );
    let action = if !text(&template["action"]).is_empty() {
        text(&template["action"]).to_owned()
    } else if input["mode"] == "continue" {
        if settings["pilot"] == "ai" {
            "\n【继续】接着往下演，主角照自己的性格和打算行动。\n（写完正文后，别忘了输出 <record> 记录块。）".to_owned()
        } else {
            "\n【玩家选择继续】主角不做新的决定，可以顺着已经在做的事继续；由他人和环境推动剧情。\n（写完正文后，别忘了输出 <record> 记录块。）".to_owned()
        }
    } else {
        text(&template["action"]).to_owned()
    };
    add("action", "玩家行动", action, "本次行动与幕后要求");
    let mut reference = input["reference"].clone();
    let source = state.get("source").filter(|b| b.is_object());
    let pos_title = reference["positionTitle"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            let pos = source.and_then(|b| b["position"].as_u64()).unwrap_or(0);
            list(&reference["passages"])
                .iter()
                .find(|p| p["section"].as_u64() == Some(pos))
                .and_then(|p| p["title"].as_str())
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or("");
    let through_title = reference["throughTitle"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("");
    let instructions = source
        .map(|b| {
            let through_label = if b["through"].is_null() {
                "全书".to_owned()
            } else {
                let n = b["through"].as_u64().unwrap_or(0) + 1;
                if through_title.is_empty() {
                    format!("截至第{n}节")
                } else {
                    format!("截至第{n}节（{through_title}）")
                }
            };
            let pos_n = b["position"].as_u64().unwrap_or(0) + 1;
            let pos_label = if pos_title.is_empty() {
                format!("第{pos_n}节")
            } else {
                format!("第{pos_n}节（{pos_title}）")
            };
            format!(
                "\n【参考书籍】以下是外部资料，不是本局已发生的事实。本局实际剧情和玩家明确分支保留，AI自行写错不等于玩家改写；按相应时点理解身份与关系。摘要不能替代原文，资料不足不能声称已核实。\n参考范围：{through_label}；玩家设定原著位置：{pos_label}。\n玩家的原著用法：{}\n{}",
                text(&b["instructions"]),
                if b["fanfic"] != true {
                    "只作背景参考，不强加原著剧情。"
                } else if b["plot"] == "canon" {
                    "尽量沿原剧情，检查当前场景的重要节点；尊重玩家行动，不替主角决定。"
                } else {
                    "允许本局分支，不强行恢复原著结局。"
                }
            )
        })
        .unwrap_or_default();
    add("referenceRules", "原著用法", instructions, "用法完整保留");
    let fixed: usize = layers
        .iter()
        .map(|l| l["chars"].as_u64().unwrap_or(0) as usize)
        .sum();
    // Message roles, delimiters and the small active read-only tool catalog.
    // Generation tier (D161): absent means a caller from before tiers.
    let depth = input["depth"].as_str().or(settings["depth"].as_str()).unwrap_or("deep");
    let overhead = input["toolOverheadChars"]
        .as_u64()
        .map(|n| n as usize)
        .unwrap_or_else(|| match depth {
            "fast" => 128,
            "standard" => crate::tools::catalog().iter().filter(|t| ["read_canon_notes","read_history"].contains(&t.name) || (state["source"].is_object() && ["list_sections","search_original","read_original"].contains(&t.name))).map(|t|t.function().to_string().encode_utf16().count()).sum::<usize>() + 128,
            _ => crate::tools::catalog().iter().filter(|t| t.read_only && (state["source"].is_object() || !["list_sections","search_original","read_original","read_canon_facts","locate_original_event","prepare_reference_check"].contains(&t.name))).map(|t|t.function().to_string().encode_utf16().count()).sum::<usize>() + crate::skills::catalog_text().encode_utf16().count() + 128,
        });
    // Canon notes (D162, R31-P3): plot/timeline notes stay in the fixed system
    // prefix for prompt-cache stability, while per-turn matched person/setting/question
    // notes move into the trailing user turn so changing entities never bust cache.
    // Reserve independent shares for book vs story static notes and dynamic entity notes
    // so a long story plot note cannot starve book canon notes or per-turn entity notes.
    let notes_room = (cap / 5).min(cap.saturating_sub(fixed + overhead + 400));
    let mut notes_static = String::new();
    let mut notes_dynamic = String::new();
    let mut book_notes_only = String::new();
    let mut used_note_titles: Vec<String> = Vec::new();
    let mut has_book_notes = false;
    let is_dynamic_note = |n: &Value| matches!(text(&n["kind"]), "person" | "setting" | "question");
    let mut append_notes = |out: &mut String, items: Vec<&Value>, budget: usize, opened: &mut HashSet<bool>| {
        let total = items.len();
        for (idx, n) in items.into_iter().enumerate() {
            let story = n["source"] == "story";
            let header = if opened.contains(&story) {
                ""
            } else if story {
                "\n【本局札记】（整理自本局已写的正文，可能有误；以最近的正文和当前状态为准）"
            } else {
                "\n【原著札记】（整理或录入的原著梗概，可能有误；本局已发生的事实优先）"
            };
            let title_str = text(&n["title"]);
            let block = format!("\n· {title_str}\n{}\n", text(&n["content"]).trim());
            let used = size(out);
            let avail = budget.saturating_sub(used);
            let left_after = total.saturating_sub(idx + 1);
            if size(header) + size(&block) <= avail {
                *out += header;
                *out += &block;
                opened.insert(story);
                used_note_titles.push(title_str.to_owned());
                if !story {
                    has_book_notes = true;
                    book_notes_only += &block;
                }
            } else {
                // Cap any single oversized note when smaller notes follow so one huge note cannot starve them.
                let share = if left_after > 0 {
                    (avail / (left_after + 1)).max(320).min(avail)
                } else {
                    avail
                };
                if share > size(header) + 260 {
                    let clipped = format!("{}\n", head(&block, share - size(header) - 1));
                    *out += header;
                    *out += &clipped;
                    opened.insert(story);
                    used_note_titles.push(title_str.to_owned());
                    if !story {
                        has_book_notes = true;
                        book_notes_only += &clipped;
                    }
                }
            }
        }
    };
    let all_notes = list(&input["canonNotes"]);
    let (dyn_list, static_list): (Vec<&Value>, Vec<&Value>) =
        all_notes.iter().partition(|n| is_dynamic_note(n));
    let (story_static, book_static): (Vec<&Value>, Vec<&Value>) =
        static_list.into_iter().partition(|n| n["source"] == "story");
    let dyn_reserve = if dyn_list.is_empty() { 0 } else { (notes_room / 3).min(2000) };
    let static_budget = notes_room.saturating_sub(dyn_reserve);
    let mut static_opened = HashSet::new();
    if !story_static.is_empty() && !book_static.is_empty() {
        let story_share = (static_budget * 40) / 100;
        append_notes(&mut notes_static, story_static, story_share, &mut static_opened);
        append_notes(&mut notes_static, book_static, static_budget, &mut static_opened);
    } else if !story_static.is_empty() {
        append_notes(&mut notes_static, story_static, static_budget, &mut static_opened);
    } else {
        append_notes(&mut notes_static, book_static, static_budget, &mut static_opened);
    }
    let mut dyn_opened = HashSet::new();
    append_notes(
        &mut notes_dynamic,
        dyn_list,
        notes_room.saturating_sub(size(&notes_static)),
        &mut dyn_opened,
    );
    let notes_all = format!("{notes_static}{notes_dynamic}");
    layers.push(json!({"key":"canonNotes","label":"主线札记","chars":size(&notes_static),"content":notes_static,"note":"本局与原著主线梗概，固定在系统前缀以利缓存复用"}));
    if !notes_dynamic.is_empty() {
        layers.push(json!({"key":"canonNotesDynamic","label":"本段相关札记","chars":size(&notes_dynamic),"content":notes_dynamic,"note":"按本段出场人物、设定或提问动态带入，置于末尾用户消息"}));
    }
    let mut remaining = (cap / 4).min(cap.saturating_sub(fixed + overhead + size(&notes_all) + 400));
    let mut evidence = String::new();
    let mut fitted = vec![];
    for p in list(&reference["passages"]) {
        let label = format!(
            "\n[原著·{}·片段{}·{}]\n",
            text(&p["title"]),
            p["chunk"].as_u64().unwrap_or(0) + 1,
            if p["kind"] == "analysis" {
                "AI整理"
            } else {
                "原文"
            }
        );
        let body = text(&p["text"]);
        if remaining < size(&label) + 80 {
            break;
        }
        let max_len = remaining - size(&label) - 1;
        let orig_start = p["start"].as_u64().unwrap_or(0) as usize;
        let body_len = size(body);
        let (content, slice_offset) = if body_len <= max_len {
            (body.to_owned(), 0usize)
        } else if let Some(focus) = p["focus"].as_u64() {
            let rel_focus = (focus as usize).saturating_sub(orig_start);
            let off = rel_focus.saturating_sub(max_len / 2).min(body_len.saturating_sub(max_len));
            let mut at = 0usize;
            let sliced: String = body
                .chars()
                .filter(|c| {
                    let cur = at;
                    at += c.len_utf16();
                    cur >= off && at <= off + max_len
                })
                .collect();
            (sliced, off)
        } else {
            (head(body, max_len), 0usize)
        };
        let mut item = p.clone();
        item["text"] = content.clone().into();
        let new_start = (orig_start + slice_offset) as u64;
        if p.get("start").is_some() {
            item["start"] = new_start.into();
        }
        item["end"] = (new_start + size(&content) as u64).into();
        remaining -= size(&label) + size(&content) + 1;
        evidence += &format!("{label}{content}\n");
        fitted.push(item);
    }
    if source.is_some() && evidence.is_empty() {
        evidence = if depth == "deep" {
            "\n【原著资料不足】当前未取得可核实原文，需要补查，不能声称已核对。\n".into()
        } else if has_book_notes {
            "\n【原著资料】本回合没有取到直接相关的原文片段，以上面的原著札记为准；札记没写到的细节不编造。\n".into()
        } else {
            "\n【原著资料】本回合没有取到直接相关的原文片段。按上文的设定与已知剧情写，不编造原著细节，也不声称已核对原文。\n".into()
        };
    }
    if reference.is_object() {
        reference["passages"] = fitted.into();
        reference["status"] = if list(&reference["passages"]).is_empty() {
            "insufficient"
        } else {
            "ready"
        }
        .into();
    }
    layers.push(json!({"key":"reference","label":"原著证据","content":evidence,"chars":size(&evidence),"note":"先保留原文，最多四分之一预算"}));
    if reference.is_object() && !notes_all.is_empty() {
        reference["notes"] = notes_all.clone().into();
        if !book_notes_only.is_empty() {
            reference["bookNotes"] = book_notes_only.into();
        }
    }
    let mut room = cap.saturating_sub(fixed + overhead + size(&notes_all) + size(&evidence));
    let continuity=crate::continuity::recall(&input["continuity"],&recent,1200.min(room/4));
    room=room.saturating_sub(size(&continuity));
    // 相关旧事 (D169): sentences from turns gone from the window about who and
    // what is in play, or matching what the player wrote. Room is set aside
    // now and filled once the window is known.
    let story_turns = history.iter().filter(|n| n["kind"] != "edit").count();
    let older_room = if story_turns > 3 { crate::recall::RECALL_BUDGET.saturating_sub(size(&continuity)).min(room / 4) } else { 0 };
    room = room.saturating_sub(older_room);
    let mut cards = String::new();
    // The protagonist's own abilities (“某某的本事”, upkeep-6) come first, named or not.
    let me = text(&state["protagonist"]["name"]).trim().to_owned();
    let ability = |c: &&Value| { let n = text(&c["name"]).trim(); n == format!("{}的本事", if me.is_empty() { "主角" } else { me.as_str() }) || n == "主角的本事" };
    let mut ordered: Vec<&Value> = list(&state["cards"]).iter().filter(|c| c["kind"] != "时代" && ability(c)).collect();
    let mut related_cards: Vec<(&Value, usize)> = list(&state["cards"])
        .iter()
        .filter(|c| c["kind"] != "时代" && !ability(c))
        .filter_map(|c| last_mention_pos(c, &recent).map(|pos| (c, pos)))
        .collect();
    related_cards.sort_by(|a, b| b.1.cmp(&a.1));
    ordered.extend(related_cards.into_iter().map(|(c, _)| c));
    for c in ordered {
        let line = format!(
            "\n【{}】{}：{}",
            text(&c["kind"]),
            text(&c["name"]),
            text(&c["content"])
        );
        if size(&cards) + size(&line) <= 1500 && size(&line) <= room / 3 {
            cards += &line;
        }
    }
    for p in list(&state["places"])
        .iter()
        .filter(|p| p["id"] == state["placeId"] || mentioned(p, &recent))
    {
        let line = format!(
            "\n【地点】{}：{}",
            text(&p["name"]),
            text(&p["description"])
        );
        if size(&cards) + size(&line) <= 1500 && size(&line) <= room / 3 {
            cards += &line;
        }
    }
    let mut facts = String::new();
    // What the AI noted about a passage the player has since edited may say the
    // opposite of the text now (D183): those notes stay out.
    let edited: HashSet<&str> = history.iter().filter(|n| n["rewritten"] == true).filter_map(|n| n["id"].as_str())
        .chain(input["editedFactNodeIds"].as_array().into_iter().flatten().filter_map(Value::as_str)).collect();
    let recent_pairs: HashSet<String> = crate::recall::pairs_of(&recent)
        .into_iter()
        .filter(|p| !crate::recall::meaningless(p))
        .collect();
    let active_entities: Vec<&str> = list(&state["people"])
        .iter()
        .chain(list(&state["cards"]).iter())
        .chain(list(&state["places"]).iter())
        .flat_map(|v| names(v))
        .filter(|n| n.chars().count() >= 2 && recent.contains(n))
        .collect();
    let mut matched_facts: Vec<(u8, usize, usize, &Value)> = list(&state["facts"])
        .iter()
        .enumerate()
        .filter(|(_, f)| !(f["origin"] == "ai" && f["nodeId"].as_str().is_some_and(|id| edited.contains(id))))
        .filter_map(|(idx, f)| {
            let detail = text(&f["detail"]);
            if detail.trim().is_empty() {
                return None;
            }
            let hits = crate::recall::pairs_of(detail)
                .into_iter()
                .filter(|p| !crate::recall::meaningless(p) && recent_pairs.contains(p))
                .count();
            let entity_hit = active_entities.iter().any(|n| detail.contains(n));
            if hits < 2 && !(hits >= 1 && entity_hit) {
                return None;
            }
            let origin = text(&f["origin"]);
            let tier = if matches!(origin, "correction" | "branch" | "player") {
                0
            } else if origin == "ai" && recent.contains(detail) {
                2
            } else {
                1
            };
            Some((tier, hits + usize::from(entity_hit), idx, f))
        })
        .collect();
    matched_facts.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| b.1.cmp(&a.1)).then_with(|| b.2.cmp(&a.2)));
    for (_, _, _, f) in matched_facts.into_iter().take(8) {
        let line = format!("\n[{}]{}", text(&f["origin"]), text(&f["detail"]));
        if size(&facts) + size(&line) < 800 && size(&cards) + size(&facts) + size(&line) <= room {
            facts += &line;
        }
    }
    cards += &facts;
    room = room.saturating_sub(size(&cards));
    layers.push(json!({"key":"cards","label":"相关设定与已更正事实","chars":size(&cards),"content":cards,"note":"相关资料优先，其他资料可通过只读工具读取"}));
    let chapters = list(&input["chapters"]);
    let recap_budget = 900.min(room / 5);
    let older = if recap_budget >= 180 && chapters.len() > 3 {
        let explicit_query = format!("{}\n{}", text(&input["text"]), text(&input["directorNote"]));
        let chapter_query = if explicit_query.trim().is_empty() {
            history
                .iter()
                .rev()
                .find(|node| node["kind"] != "edit")
                .map(|node| {
                    format!(
                        "{}\n{}",
                        head(text(&node["actionText"]), 120),
                        tail(text(&node["narrative"]), 360)
                    )
                })
                .unwrap_or_default()
        } else {
            head(&explicit_query, 480)
        };
        let older_budget = recap_budget / 3;
        crate::recall::related_chapter(
            &chapters[..chapters.len() - 3],
            &chapter_query,
            older_budget - 8,
        )
        .map(|line| head(&format!("\n较早相关章节：{line}"), older_budget))
        .unwrap_or_default()
    } else {
        String::new()
    };
    // The recap's room is set aside; which chapters it shows is decided once the
    // prose window is known, so a chapter still there in full is not told twice (D183).
    room = room.saturating_sub(recap_budget);
    // Stepped history eviction (R31-P3): once history exceeds the prose budget,
    // evict oldest turns in chunks of HISTORY_EVICT_STEP aligned on global turn index
    // so the conversation message prefix stays byte-identical for 4-5 consecutive turns.
    let offset = input["historyOffset"].as_u64().unwrap_or(0) as usize;
    let story_nodes: Vec<&Value> = history.iter().filter(|n| n["kind"] != "edit").collect();
    let total_story = story_nodes.len();
    let mut fit_count = 0usize;
    let mut fit_used = 0usize;
    for n in story_nodes.iter().rev() {
        let action = if n["kind"] == "opening" {
            "（开场）"
        } else if text(&n["actionText"]).is_empty() {
            "（继续）"
        } else {
            text(&n["actionText"])
        };
        let cost = size(action) + size(text(&n["narrative"])) + 24;
        if fit_used + cost > room {
            break;
        }
        fit_used += cost;
        fit_count += 1;
    }
    let mut pairs = vec![];
    let mut kept = BTreeSet::new();
    if fit_count > 0 {
        let fit_start = total_story - fit_count;
        let start = if fit_start == 0 {
            0
        } else {
            let global_start = offset + fit_start;
            let stepped_global =
                ((global_start + HISTORY_EVICT_STEP - 1) / HISTORY_EVICT_STEP) * HISTORY_EVICT_STEP;
            let stepped_start = stepped_global.saturating_sub(offset);
            if total_story.saturating_sub(stepped_start) < fit_count.min(2) {
                fit_start
            } else {
                stepped_start
            }
        };
        for n in &story_nodes[start..] {
            let action = if n["kind"] == "opening" {
                "（开场）"
            } else if text(&n["actionText"]).is_empty() {
                "（继续）"
            } else {
                text(&n["actionText"])
            };
            pairs.push((history_action(n, action), text(&n["narrative"]).to_owned()));
            kept.insert(n["id"].clone().to_string());
        }
    } else if let Some(n) = story_nodes.last() {
        if room > 160 {
            let action = if n["kind"] == "opening" {
                "（开场）"
            } else if text(&n["actionText"]).is_empty() {
                "（继续）"
            } else {
                text(&n["actionText"])
            };
            let body = format!(
                "（这一回合较早的正文已省略）\n{}",
                tail(text(&n["narrative"]), room.saturating_sub(size(action) + 70))
            );
            pairs.push((history_action(n, action), body));
            kept.insert(n["id"].clone().to_string());
        }
    }
    let recap_raw = chapters
        .iter()
        .rev()
        .filter(|c| !kept.contains(&c["firstNodeId"].clone().to_string()))
        .take(3)
        .map(|c| {
            // A passage in it was edited after it was summarized (D183).
            let note = if c["stale"] == true { "（正文改过，梗概待更新）" } else { "" };
            format!("{}：{}{note}", text(&c["title"]), text(&c["gist"]))
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let recap_stable = head(&recap_raw, recap_budget.saturating_sub(size(&older)));
    let recap = format!("{recap_stable}{older}");
    layers.push(json!({"key":"recap","label":"前情提要","chars":size(&recap),"content":recap,"note":"原文窗口以外的章节梗概"}));
    {
        let older_turns: Vec<crate::recall::Older> = history
            .iter()
            .filter(|n| n["kind"] != "edit")
            .enumerate()
            .filter(|(_, n)| !kept.contains(&n["id"].clone().to_string()))
            .map(|(i, n)| crate::recall::Older { narrative: text(&n["narrative"]), turn: offset + i })
            .collect();
        let query = if matches!(text(&input["mode"]), "continue" | "skip") { String::new() } else { format!("{}\n{}", text(&input["text"]), text(&input["directorNote"])) };
        let old = if older_room > 0 { crate::recall::recall_block(state, &recent, &older_turns, older_room, &query) } else { String::new() };
        let recall = format!("{continuity}{old}");
        if !recall.is_empty() {
            layers.push(json!({"key":"recall","label":"知情与相关旧事","content":recall,"chars":size(&recall),"note":"本路线的知情与未完事项，以及原文窗口以外提到眼下人和物、或与本次行动相关的句子"}));
        }
    }
    let mut messages = vec![];
    // Keep only turn-invariant layers in system; per-turn older chapter recall
    // and dynamic entity/question notes go into the trailing user turn (R31-P3).
    let system = ["rules", "premise", "era", "canonNotes", "recap", "spec"]
        .iter()
        .filter_map(|key| {
            if *key == "recap" {
                Some(recap_stable.as_str())
            } else {
                layers
                    .iter()
                    .find(|l| l["key"] == *key)
                    .map(|l| text(&l["content"]))
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let compact_system = ["rules", "premise", "era", "canonNotes", "spec"].iter()
        .filter_map(|key| layers.iter().find(|layer| layer["key"] == *key).map(|layer| text(&layer["content"])))
        .collect::<Vec<_>>().join("\n");
    messages.push(json!({"role":"system","content":system,"compactContent":compact_system}));
    for (action, body) in pairs {
        messages.push(json!({"role":"user","content":action}));
        messages.push(json!({"role":"assistant","content":body}));
    }
    // The same order as the facade's request: what is true now, what is
    // relevant, the original, then the player's action last (D169).
    const ORDER: [&str; 12] = ["state", "essentials", "world", "canonNotesDynamic", "cards", "recall", "referenceRules", "reference", "directive", "modes", "notes", "action"];
    let rank = |l: &&Value| ORDER.iter().position(|k| *k == text(&l["key"])).unwrap_or(ORDER.len());
    let mut ordered: Vec<&Value> = layers.iter().filter(|l| !["rules", "premise", "era", "canonNotes", "recap", "spec", "tools"].contains(&text(&l["key"]))).collect();
    ordered.sort_by_key(rank);
    let user_layers = || ordered.iter().copied();
    let mut user_parts: Vec<&str> = user_layers().map(|l| text(&l["content"])).collect();
    if !older.is_empty() {
        let insert_at = ordered
            .iter()
            .position(|l| text(&l["key"]) == "recall")
            .unwrap_or_else(|| {
                ordered
                    .iter()
                    .position(|l| text(&l["key"]) == "referenceRules")
                    .unwrap_or(user_parts.len().saturating_sub(1))
            });
        user_parts.insert(insert_at, older.as_str());
    }
    let user = user_parts.join("\n");
    let compact_user = user_layers().filter(|l| !["cards", "recall"].contains(&text(&l["key"])))
        .map(|l| text(&l["content"])).collect::<Vec<_>>().join("\n");
    messages.push(json!({"role":"user","content":user,"compactContent":compact_user}));
    let message_chars: usize = messages.iter().map(|m| size(text(&m["content"])) + 8).sum();
    let chars = message_chars + overhead;
    layers.push(json!({"key":"tools","label":"工具与技能目录及消息包装","chars":overhead,"content":"按当前只读工具说明与技能目录预留，正式请求会优先精简可选资料。","note":"计入输入估算，必要内容完整保留"}));
    Ok(
        json!({"messages":messages,"layers":layers,"reference":reference,"notesUsed":used_note_titles,"chars":chars,"budgetChars":cap,"budgetExceeded":chars>cap,"contextVersion":"writing-context-3"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Value {
        json!({"budgetChars":14545,"template":{"rules":"按原来的旁观规则写作","era":"世界规则前后一致","spec":"正文后输出<record>","action":"继续","notes":""},"mode":"continue","settings":{"pilot":"ai","premise":"保留玩家主动改变的情节","rules":"","essentials":"","directive":""},"era":{"clock":{"mode":"free","clockStyle":"elapsed","timeStyle":"24h","hour":8},"currency":{"units":[{"name":"文","value":1}]}},"state":{"time":{"elapsedMinutes":4055*1440},"protagonist":{"name":"旅人","gender":"男","age":20,"identity":"行者","stats":{"money":120,"health":80,"energy":70},"items":[],"statuses":[]},"people":[],"places":[],"cards":[],"goals":[],"source":{"bookId":"b","instructions":"保留玩家改写","through":null,"position":0}},"reference":{"bookId":"b","passages":[{"section":10,"chunk":20,"title":"重逢","kind":"original","text":"青色玉佩只有一枚。".repeat(180),"start":0}]},"history":[{"id":"n","kind":"turn","actionText":"继续","narrative":"上一段开头。".repeat(1000)+"最后她交回青色玉佩。"}]})
    }
    #[test]
    fn world_events_and_old_sentences_reach_the_writer_and_the_action_comes_last() {
        let mut i = input();
        i["settings"]["mode"] = "history".into();
        i["state"]["time"]["elapsedMinutes"] = 200000.into();
        i["state"]["timeline"] = json!([{"date":"天宝八载六月","title":"哥舒翰攻克石堡城","kind":"固定","atMinute":190000}]);
        i["state"]["people"] = json!([{"id":"w","name":"王掌柜","aliases":[],"role":"掌柜","attitude":"冷淡","alive":true}]);
        i["reference"] = Value::Null;
        i["history"] = json!([
            {"id":"o","kind":"opening","actionText":"","narrative":"你在邸店醒来。王掌柜说房钱九十文，三日内付清。"},
            {"id":"a","kind":"turn","actionText":"出门","narrative":format!("{}王掌柜看着你出门。", "甲".repeat(4000))},
            {"id":"b","kind":"turn","actionText":"做工","narrative":"乙".repeat(4000)},
            {"id":"c","kind":"turn","actionText":"回来","narrative":format!("{}王掌柜又站在廊下。", "丙".repeat(4000))}
        ]);
        i["historyOffset"] = 0.into();
        i["template"]["action"] = "\n\n【玩家行动】去西市。".into();
        let a = build(&i).unwrap();
        let user = a["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().to_owned();
        assert!(user.contains("哥舒翰攻克石堡城"), "{user}");
        assert!(user.contains("- 开场（王掌柜）：王掌柜说房钱九十文，三日内付清。"), "{user}");
        assert!(user.trim_end().ends_with("【玩家行动】去西市。"), "{user}");
        // Free worlds have no history of record.
        i["settings"]["mode"] = "free".into();
        assert!(!build(&i).unwrap()["messages"].to_string().contains("天下大事"));
    }
    #[test]
    fn long_state_is_projected_not_dumped_and_evidence_precedes_old_prose() {
        let mut i = input();
        i["state"]["people"]=json!((0..58).map(|n|json!({"id":n.to_string(),"name":format!("角色{n}"),"aliases":[],"role":"同伴","attitude":"一般","alive":true,"notes":"旧备注".repeat(200)})).collect::<Vec<_>>());
        i["state"]["places"]=json!((0..64).map(|n|json!({"id":n.to_string(),"name":format!("地点{n}"),"description":"旧地点资料".repeat(100)})).collect::<Vec<_>>());
        assert!(i["state"].to_string().len() > 36000);
        let a = build(&i).unwrap();
        assert!(a["chars"].as_u64().unwrap() <= 14545);
        assert_eq!(a["budgetExceeded"], false);
        let body = a["messages"].to_string();
        assert!(body.contains("最后她交回青色玉佩"));
        assert!(body.contains("青色玉佩只有一枚"));
        assert!(!body.contains(&"旧备注".repeat(100)));
        assert!(body.contains("保留玩家主动改变"));
    }
    #[test]
    fn recap_retrieves_a_relevant_chapter_older_than_the_prose_window() {
        let mut i = input();
        i["historyOffset"] = 111.into();
        i["text"] = "打开青铜密匣，查清去向。".into();
        i["chapters"] = json!([
            {"title":"荒庙","gist":"青铜密匣藏在破佛像下。"},
            {"title":"摆渡","gist":"船家带你渡过长河。"},
            {"title":"集市","gist":"摊主提到大雪即将封山。"},
            {"title":"客栈","gist":"商队先在镇上休整。"},
            {"title":"商队","gist":"掌柜决定分路拜访。"}
        ]);
        let context = build(&i).unwrap();
        let recap = context["layers"].as_array().unwrap().iter().find(|layer| layer["key"] == "recap").unwrap();
        let content = recap["content"].as_str().unwrap();
        assert!(content.contains("青铜密匣藏在破佛像下"), "{content}");
        assert!(content.contains("商队：掌柜决定分路拜访"), "{content}");
        assert!(!content.contains("船家带你"), "{content}");
        assert!(recap["chars"].as_u64().unwrap() <= 900);
    }
    #[test]
    fn the_recap_leaves_out_chapters_still_in_the_window_and_marks_edited_ones() {
        let mut i = input();
        i["history"] = json!([
            {"id":"a","kind":"turn","actionText":"出门","narrative":"你出了门。"},
            {"id":"b","kind":"turn","actionText":"买纸","narrative":"你买了纸。"}
        ]);
        i["chapters"] = json!([
            {"firstNodeId":"old","title":"旧事","gist":"很早以前的事。","stale":true},
            {"firstNodeId":"a","title":"出门","gist":"出门买纸。"}
        ]);
        let context = build(&i).unwrap();
        let recap = context["layers"].as_array().unwrap().iter().find(|l| l["key"] == "recap").unwrap()["content"].as_str().unwrap().to_owned();
        assert!(recap.contains("旧事：很早以前的事。（正文改过，梗概待更新）"), "{recap}");
        assert!(!recap.contains("出门买纸"), "a chapter whose passages are all in the window is not told twice: {recap}");
    }
    #[test]
    fn what_the_ai_noted_about_a_passage_the_player_edited_stays_out() {
        let mut i = input();
        i["history"] = json!([{"id":"n1","kind":"turn","actionText":"买纸","narrative":"你买了一张青纸。","rewritten":true},{"id":"n2","kind":"turn","actionText":"看纸","narrative":"你看着青纸。"}]);
        i["state"]["facts"] = json!([
            {"id":"f1","origin":"ai","nodeId":"n1","detail":"你买了一张黄纸青纸","citations":[]},
            {"id":"f2","origin":"ai","nodeId":"n2","detail":"你看着青纸出神","citations":[]},
            {"id":"f3","origin":"player","nodeId":"n1","detail":"你买的是一张青纸","citations":[]}
        ]);
        let context = build(&i).unwrap();
        let cards = context["layers"].as_array().unwrap().iter().find(|l| l["key"] == "cards").unwrap()["content"].as_str().unwrap().to_owned();
        assert!(!cards.contains("黄纸"), "{cards}");
        assert!(cards.contains("你看着青纸出神") && cards.contains("你买的是一张青纸"), "{cards}");
    }

    #[test]
    fn obsolete_ai_facts_stay_out_even_after_the_edited_passage_leaves_the_window() {
        let mut i = input();
        i["history"] = json!([{"id":"new","kind":"turn","narrative":"玩家确认是青纸，旧说是黄纸。官印仍在柜中。"}]);
        i["editedFactNodeIds"] = json!(["old-edited"]);
        i["state"]["facts"] = json!([
            {"origin":"ai","nodeId":"old-edited","detail":"旧说是黄纸"},
            {"origin":"player","nodeId":"old-edited","detail":"玩家确认是青纸"},
            {"origin":"ai","nodeId":"old-untouched","detail":"官印仍在柜中"}
        ]);
        let context = build(&i).unwrap();
        let cards = context["layers"].as_array().unwrap().iter().find(|layer| layer["key"] == "cards").unwrap()["content"].as_str().unwrap();
        assert!(!cards.contains("旧说是黄纸"), "{cards}");
        assert!(cards.contains("玩家确认是青纸") && cards.contains("官印仍在柜中"), "{cards}");
    }
    #[test]
    fn canon_notes_join_the_fixed_part_within_a_fifth_of_the_budget() {
        let mut i = input();
        i["depth"] = "standard".into();
        i["reference"]["passages"] = json!([]);
        i["canonNotes"] = json!([
            {"title":"第1～100章主线","content":"主角拜入学院，结识五友。"},
            {"title":"很长的札记","content":"很长".repeat(4000)},
            {"title":"人物：阿柳","content":"白狐化形。"}
        ]);
        let context = build(&i).unwrap();
        let system = context["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("【原著札记】") && system.contains("结识五友") && system.contains("白狐化形"), "{}", serde_json::to_string(&context["layers"].as_array().unwrap().iter().map(|l| (l["key"].clone(), l["chars"].clone())).collect::<Vec<_>>()).unwrap());
        assert!(!system.contains(&"很长".repeat(4000)));
        let layer = context["layers"].as_array().unwrap().iter().find(|l| l["key"] == "canonNotes").unwrap();
        assert!(layer["chars"].as_u64().unwrap() as usize <= 14545 / 5);
        let user = context["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap();
        assert!(user.contains("以上面的原著札记为准") && !user.contains("需要补查"));
        assert!(context["reference"]["notes"].as_str().unwrap().contains("结识五友"));
    }
    #[test]
    fn the_protagonists_abilities_card_comes_in_without_being_named() {
        let mut i = input();
        i["state"]["protagonist"]["name"] = "林舟".into();
        i["state"]["cards"] = json!([
            {"kind":"设定","name":"林舟的本事","keys":[],"content":"武魂蓝银草；两个千年紫环"},
            {"kind":"物品","name":"玉玺","keys":[],"content":"传国玉玺"}
        ]);
        let context = build(&i).unwrap();
        let layer = context["layers"].as_array().unwrap().iter().find(|l| l["key"] == "cards").unwrap();
        let cards = layer["content"].as_str().unwrap();
        assert!(cards.contains("林舟的本事：武魂蓝银草；两个千年紫环"), "{cards}");
        assert!(!cards.contains("传国玉玺"));
    }
    #[test]
    fn story_notes_and_book_notes_each_open_their_own_heading() {
        let mut i = input();
        i["canonNotes"] = json!([
            {"title":"主线梗概","content":"开场到第十回合：主角进城。","source":"story"},
            {"title":"人物：王掌柜（前作）","content":"上一局的掌柜。","source":"story"},
            {"title":"第1～100章主线","content":"主角拜入学院。"}
        ]);
        let context = build(&i).unwrap();
        let system = context["messages"][0]["content"].as_str().unwrap();
        let story = system.find("【本局札记】").expect("story heading");
        let book = system.find("【原著札记】").expect("book heading");
        assert!(story < book && system.matches("【本局札记】").count() == 1);
        assert!(system.contains("主角进城") && system.contains("上一局的掌柜") && system.contains("拜入学院"));
    }
    #[test]
    fn fixed_player_requirements_outweigh_the_history_target() {
        let mut i = input();
        let rules = "完整要求".repeat(5000);
        i["settings"]["rules"] = rules.clone().into();
        let context = build(&i).unwrap();
        assert_eq!(context["budgetExceeded"], true);
        assert_eq!(context["budgetChars"], 14545);
        let body = context["messages"].to_string();
        assert!(body.contains(&rules));
        assert!(!body.contains("上一段开头"));
    }
    #[test]
    fn bounded_correction_preserves_other_text_and_unrelated_record() {
        let plan:crate::RunPlan=serde_json::from_value(json!({"id":"r","worldId":"w","lineId":"l","headId":"h","baseId":"h","kind":"correction","model":{"slot":"test","url":"https://unused.invalid","model":"test","includeUsage":false},"messages":[],"extractMessages":[],"state":{},"settings":{},"options":{},"action":{},"meta":{"anchor":{"original":"前文。青玉佩。后文。"},"correctionRange":{"start":3,"end":7},"originalRecord":{"money":-5,"items":[{"name":"药包","delta":1}],"people":[{"name":"青衣客","role":"弟弟"}]}}})).unwrap();
        let r=local_correction(&plan,&json!({"replacement":"白玉佩。","recordPatch":{"people":[{"name":"青衣客","role":"兄长"}]}})).unwrap();
        assert_eq!(r["narrative"],"前文。白玉佩。后文。");assert_eq!(r["record"]["money"],-5);assert_eq!(r["record"]["items"][0]["name"],"药包");assert_eq!(r["record"]["people"][0]["role"],"兄长");
        assert!(local_correction(&plan,&json!({"replacement":"改稿","recordPatch":{"source":{}}})).is_err());
    }
    #[test]
    fn review_requires_actual_original_and_explicit_player_branch() {
        let state=json!({"source":{"bookId":"b"},"facts":[{"id":"p","origin":"player","detail":"救下旅人"}]});
        let pages=vec![json!({"kind":"original","section":2,"chunk":3,"text":"青衣客是兄长。"})];
        let mut report=json!({"findings":[{"status":"supported","citations":[{"bookId":"b","section":2,"chunk":3,"quote":"青衣客是兄长"}]}]});
        validate_findings(&report,&pages,&state,&state["source"],&json!({})).unwrap();report["findings"][0]["citations"][0]["quote"]="青衣客是弟弟".into();assert!(validate_findings(&report,&pages,&state,&state["source"],&json!({})).is_err());
        report=json!({"findings":[{"status":"branch","playerFactId":"p"}]});validate_findings(&report,&pages,&state,&state["source"],&json!({})).unwrap();report["findings"][0]["playerFactId"]="ai-state".into();assert!(validate_findings(&report,&pages,&state,&state["source"],&json!({"mode":"direct","text":"修正设定"})).is_err());
    }
    #[test]
    fn unicode_windows_do_not_split_surrogate_pairs() {
        let t = "😀甲乙😀丙";
        assert_eq!(head(t, 1), "");
        assert_eq!(head(t, 3), "😀甲");
        assert_eq!(tail(t, 2), "丙");
    }
    #[test]
    fn project_state_retains_current_place_items_statuses_goals_and_many_people() {
        let mut i = input();
        i["state"]["placeId"] = "place-49".into();
        i["state"]["places"] = json!((0..50).map(|n| json!({"id":format!("place-{n}"),"name":format!("驿站{n}"),"description":"说明".repeat(30)})).collect::<Vec<_>>());
        i["state"]["protagonist"]["items"] = json!([{"name":"玄铁令","quantity":1,"unit":"枚","place":"袖中"}]);
        i["state"]["protagonist"]["statuses"] = json!([{"name":"内伤","detail":"左肋隐痛"}]);
        i["state"]["goals"] = json!([{"kind":"主线","name":"查清翠微楼内鬼","status":"进行中","progress":"已获密信"}]);
        i["state"]["people"] = json!((0..40).map(|n| json!({"id":format!("p{n}"),"name":format!("江湖客{n}"),"aliases":[],"role":"路人","attitude":"一般","alive":true,"lastSeenMinute":n * 10,"origin":"江南","notes":"长备注".repeat(40)})).collect::<Vec<_>>());
        let text = project_state(&i["state"], &i["era"], "江湖客5 来到驿站49");
        assert!(text.contains("驿站49"), "{text}");
        assert!(text.contains("玄铁令×1枚（放在袖中）"), "{text}");
        assert!(text.contains("内伤：左肋隐痛"), "{text}");
        assert!(text.contains("【主线】查清翠微楼内鬼（已获密信）"), "{text}");
        assert!(text.contains("江湖客5：路人，对主角一般；江南；"), "{text}");
        // Should retain far more than the old ~4-person JSON bottleneck.
        assert!(text.contains("江湖客39") && text.contains("江湖客15"), "{text}");
    }
    #[test]
    fn cards_match_by_keys_and_sort_by_latest_mention() {
        let mut i = input();
        i["history"] = json!([
            {"id":"n1","kind":"turn","actionText":"前事","narrative":"早先听说过旧门派。"},
            {"id":"n2","kind":"turn","actionText":"近事","narrative":"眼下最要紧的是玄铁令的下落。"}
        ]);
        i["state"]["cards"] = json!([
            {"kind":"势力","name":"旧门派","keys":[],"content":"甲".repeat(800)},
            {"kind":"物品","name":"青铜匣","keys":["玄铁令"],"content":"乙".repeat(800)}
        ]);
        let context = build(&i).unwrap();
        let cards = context["layers"].as_array().unwrap().iter().find(|l| l["key"] == "cards").unwrap()["content"].as_str().unwrap();
        assert!(cards.contains("青铜匣"), "card matched by keys and most recent mention must win 1500 budget: {cards}");
        assert!(!cards.contains("旧门派"), "older card should yield when budget is tight");
    }
    #[test]
    fn facts_filter_uses_meaningful_bigrams_not_common_single_chars() {
        let mut i = input();
        i["history"] = json!([{"id":"n1","kind":"turn","actionText":"出门","narrative":"你在街上买了一碗热面，顺便打听北城门的消息。"}]);
        i["state"]["facts"] = json!([
            {"id":"noise","origin":"ai","nodeId":"old1","detail":"你在一个雨夜见了她一面，说了几句的话"},
            {"id":"hit","origin":"correction","nodeId":"old2","detail":"北城门守将其实是周参军，并非李校尉"}
        ]);
        let context = build(&i).unwrap();
        let cards = context["layers"].as_array().unwrap().iter().find(|l| l["key"] == "cards").unwrap()["content"].as_str().unwrap();
        assert!(cards.contains("北城门守将其实是周参军"), "{cards}");
        assert!(!cards.contains("雨夜见了她一面"), "unrelated fact sharing only common single chars must stay out: {cards}");
    }
    #[test]
    fn prefix_stays_stable_across_four_turns_and_history_evicts_in_steps() {
        let mut system_messages = Vec::new();
        let mut history_counts = Vec::new();
        let make_turn = |n: usize| {
            json!({
                "id": format!("t{n}"),
                "kind": "turn",
                "actionText": format!("第{n}步行动"),
                "narrative": format!("第{n}回合正文，发生了一段详细的驿站对话与见闻，包含不少具体情节描写。").repeat(4),
                "summary": format!("第{n}回合摘要")
            })
        };
        let mut history = vec![json!({"id":"o","kind":"opening","narrative":"开局正文。"})];
        for n in 1..=10 {
            history.push(make_turn(n));
        }
        for step in 0..4 {
            let mut i = input();
            i["budgetChars"] = 6000.into();
            i["toolOverheadChars"] = 128.into();
            i["history"] = Value::Array(history.clone());
            i["chapters"] = json!([
                {"id":"c1","title":"第一章","gist":"旧章稳定前情，提到青铜密信与玄铁钥匙。","firstNodeId":"o","lastNodeId":"t1"},
                {"id":"c2","title":"第二章","gist":"渡口风波，记述码头交接。","firstNodeId":"t2","lastNodeId":"t3"},
                {"id":"c3","title":"第三章","gist":"夜探客栈，线索暂明。","firstNodeId":"t4","lastNodeId":"t5"},
                {"id":"c4","title":"第四章","gist":"长街偶遇，城门初启。","firstNodeId":"t6","lastNodeId":"t7"}
            ]);
            i["canonNotes"] = json!([
                {"kind": "plot", "title": "主线大纲", "content": "固定的原著主线梗概。"},
                {"kind": "person", "title": "动态人物", "content": format!("第{step}回检索到的动态片段")}
            ]);
            i["text"] = json!(format!("查看青铜密信与玄铁钥匙，执行第{step}步试探"));
            let built = build(&i).unwrap();
            let msgs = built["messages"].as_array().unwrap();
            let sys = msgs[0]["content"].as_str().unwrap().to_string();
            let user_tail = msgs.last().unwrap()["content"].as_str().unwrap().to_string();
            assert!(sys.contains("固定的原著主线梗概"), "static plot canon note must live in system prefix");
            assert!(!sys.contains(&format!("第{step}回检索到的动态片段")), "dynamic person canon note must stay out of system prefix");
            assert!(user_tail.contains(&format!("第{step}回检索到的动态片段")), "dynamic person canon note belongs in trailing user prompt");
            assert!(!sys.contains("较早相关章节："), "per-turn related older chapter must stay out of system prefix");
            assert!(user_tail.contains("较早相关章节："), "per-turn related older chapter belongs in trailing user prompt");
            system_messages.push(sys);
            // History messages are between system (0) and trailing user (len - 1)
            history_counts.push(msgs.len() - 2);
            history.push(make_turn(11 + step));
        }
        assert!(system_messages.windows(2).all(|w| w[0] == w[1]), "system prefix must be byte-identical across 4 consecutive turns");
        // Verify stepped eviction when budget forces dropping older history turns
        let mut tight = input();
        tight["budgetChars"] = 2600.into();
        tight["toolOverheadChars"] = 128.into();
        let mut many = vec![json!({"id":"o","kind":"opening","narrative":"开局。"})];
        for n in 1..=14 {
            many.push(make_turn(n));
        }
        tight["history"] = Value::Array(many.clone());
        let b1 = build(&tight).unwrap();
        let first_action_1 = b1["messages"][1]["content"].as_str().unwrap().to_string();
        many.push(make_turn(15));
        tight["history"] = Value::Array(many);
        let b2 = build(&tight).unwrap();
        let first_action_2 = b2["messages"][1]["content"].as_str().unwrap().to_string();
        // Either the oldest retained turn didn't move (prefix preserved!) or it jumped by a step of >= 5 turns.
        let idx = |s: &str| s.trim_start_matches('第').split("步行动").next().and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
        let jump = idx(&first_action_2).saturating_sub(idx(&first_action_1));
        assert!(jump == 0 || jump >= HISTORY_EVICT_STEP, "history eviction should keep oldest anchor stable or evict in a batch step, got {first_action_1} -> {first_action_2}");
    }
}

/// Construct the whole turn on the host; the model can only replace its selected
/// span and affected record fields. Unrelated ledger entries survive by default.
pub fn local_correction(plan: &crate::RunPlan, response: &Value) -> Result<Value> {
    if !plan.meta["correctionRange"].is_object() {
        return Ok(response.clone());
    }
    let original = plan.meta["anchor"]["original"]
        .as_str()
        .ok_or_else(|| Error::Invalid("缺少原文定位".into()))?;
    let range = &plan.meta["correctionRange"];
    fn boundary(s: &str, n: u64) -> Option<usize> {
        let mut u = 0;
        for (b, c) in s.char_indices() {
            if u == n {
                return Some(b);
            }
            u += c.len_utf16() as u64;
        }
        if u == n {
            Some(s.len())
        } else {
            None
        }
    }
    let start = range["start"]
        .as_u64()
        .and_then(|n| boundary(original, n))
        .ok_or_else(|| Error::Invalid("改稿起点无效，请重新选择段落".into()))?;
    let end = range["end"]
        .as_u64()
        .and_then(|n| boundary(original, n))
        .ok_or_else(|| Error::Invalid("改稿终点无效，请重新选择段落".into()))?;
    if start >= end {
        return Err(Error::Invalid("请选择有效的改稿范围".into()));
    }
    let has_patch = response["recordPatch"].as_object().is_some_and(|o| !o.is_empty())
        || response["correctionPatch"].as_object().is_some_and(|o| !o.is_empty());
    let replacement = response["replacement"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| has_patch.then_some(&original[start..end]))
        .ok_or_else(|| Error::Invalid("尚未返回选中范围的完整改稿".into()))?;
    let mut record = plan.meta["originalRecord"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Some(patch) = response["recordPatch"].as_object() {
        for (key, value) in patch {
            if value.is_null() {
                continue;
            }
            if ["source", "executionMode", "sourceSet", "executionSet", "settings", "rules"]
                .contains(&key.as_str())
            {
                return Err(Error::Invalid("局部纠错不能修改整局绑定或规则字段".into()));
            }
            if ["protagonist", "facts", "setStats", "scriptSet", "challengeSet"]
                .contains(&key.as_str())
            {
                continue;
            }
            if key == "choices"
                && value
                    .as_array()
                    .is_some_and(|a| a.iter().all(Value::is_string))
            {
                record.insert(key.clone(), value.clone());
            } else if let Some(changes) = value.as_array() {
                let mut values = record
                    .get(key)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for change in changes {
                    let coerced = if key == "items" && change.as_str().is_some_and(|s| !s.trim().is_empty()) {
                        json!({"name": change.as_str().unwrap().trim(), "delta": 1})
                    } else if change.is_object() {
                        change.clone()
                    } else {
                        continue;
                    };
                    let is_remove = coerced.get("remove").and_then(Value::as_bool) == Some(true)
                        || (key != "status" && coerced.get("op").and_then(Value::as_str) == Some("remove"));
                    let match_id = coerced.get("oldName").or_else(|| coerced.get("id")).or_else(|| coerced.get("name"));
                    let existing_pos = match_id.and_then(|id| {
                        values
                            .iter()
                            .position(|v| v.get("id").or_else(|| v.get("name")) == Some(id))
                    });
                    if is_remove {
                        if let Some(at) = existing_pos {
                            values.remove(at);
                        }
                        continue;
                    }
                    let mut clean = coerced.as_object().cloned().unwrap_or_default();
                    clean.remove("oldName");
                    clean.remove("remove");
                    let clean_val = Value::Object(clean);
                    if let Some(at) = existing_pos {
                        if let (Some(old), Some(new)) =
                            (values[at].as_object_mut(), clean_val.as_object())
                        {
                            old.extend(new.clone());
                        }
                    } else {
                        values.push(clean_val);
                    }
                }
                record.insert(key.clone(), values.into());
            } else if value.is_object() {
                let mut object = record
                    .get(key)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                object.extend(value.as_object().unwrap().clone());
                record.insert(key.clone(), object.into());
            } else {
                record.insert(key.clone(), value.clone());
            }
        }
    }
    let mut result = response.clone();
    for key in ["related", "unresolved"] {
        if let Some(value) = response.get(key) {
            if let Some(arr) = value.as_array() {
                let filtered: Vec<Value> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()))
                    .map(|s| Value::String(s.to_owned()))
                    .collect();
                result[key] = Value::Array(filtered);
            } else {
                result[key] = json!([]);
            }
        }
    }
    result["replacement"] = replacement.into();
    result["narrative"] =
        format!("{}{}{}", &original[..start], replacement, &original[end..]).into();
    result["record"] = record.into();
    result["range"] = range.clone();
    Ok(result)
}

pub fn validate_findings(
    report: &Value,
    passages: &[Value],
    state: &Value,
    source: &Value,
    action: &Value,
) -> Result<()> {
    let Some(findings) = report["findings"].as_array() else {
        return Err(Error::Invalid(
            "核对结果需要逐项findings，可为空列表".into(),
        ));
    };
    let norm = |s: &str| -> String { s.chars().filter(|c| c.is_alphanumeric()).collect() };
    for finding in findings {
        match finding["status"].as_str() {
            Some("supported") => {
                let cites = finding["citations"]
                    .as_array()
                    .filter(|a| !a.is_empty())
                    .ok_or_else(|| Error::Invalid("原著已支持的主张必须附实际读到的原句".into()))?;
                for cite in cites {
                    let quote = cite["quote"].as_str().unwrap_or("");
                    let norm_q = norm(quote);
                    if !source.is_object()
                        || !cite["section"].as_u64().is_some_and(|section| section <= source["through"].as_u64().unwrap_or(u64::MAX))
                        || quote.trim().is_empty()
                        || !passages.iter().any(|p| {
                            p["kind"] == "original"
                                && p.get("bookId").is_none_or(|id| id == &source["bookId"])
                                && p["chunk"] == cite["chunk"]
                                && p["section"] == cite["section"]
                                && (text(&p["text"]).contains(quote)
                                    || (norm_q.chars().count() >= 4 && norm(text(&p["text"])).contains(&norm_q)))
                        })
                    {
                        return Err(Error::Invalid(
                            "核对结论没有对应到本次实际提供或读到的原句，请补查或标资料不足".into(),
                        ));
                    }
                }
            }
            Some("branch") => {
                let explicit =
                    action["mode"] == "write" && finding["playerQuote"].as_str().is_some_and(|q|!q.trim().is_empty()&&text(&action["text"]).contains(q));
                let fact = list(&state["facts"]).iter().any(|f| {
                    f["id"] == finding["playerFactId"]
                        && ["player", "branch"].contains(&text(&f["origin"]))
                });
                if !explicit && !fact {
                    return Err(Error::Invalid("本局分支须关联playerFactId对应的玩家事实；AI旧状态与笼统修改授权不能证明玩家分支".into()));
                }
            }
            Some("uncertain") => (),
            _ => {
                return Err(Error::Invalid(
                    "核对项目status应为supported、branch或uncertain".into(),
                ))
            }
        }
    }
    Ok(())
}

fn history_action(node: &Value, body: &str) -> String {
    match text(&node["actionMode"]) {
        "direct" => format!("【幕后要求，不是角色台词】{body}"),
        "say" => format!("【玩家说】{body}"),
        "write" => format!("【玩家已写入并结算过的剧情】{body}"),
        "skip" => format!("【玩家选择过些日子】{body}"),
        _ => format!("【此前行动】{body}"),
    }
}
