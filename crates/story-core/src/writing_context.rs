//! Shared, bounded ordinary-writing projection. Full state remains in the run.
use crate::{rules, Error, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;

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
    std::iter::once(text(&v["name"]))
        .chain(list(&v["aliases"]).iter().filter_map(Value::as_str))
        .filter(|s| !s.is_empty())
        .collect()
}
fn mentioned(v: &Value, recent: &str) -> bool {
    names(v).iter().any(|name| recent.contains(name))
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
        .find(|p| p["id"] == state["placeId"])
        .map(|p| text(&p["name"]))
        .unwrap_or("（未记录）");
    let items = list(&me["items"])
        .iter()
        .map(|i| {
            format!(
                "{}×{}{}{}",
                text(&i["name"]),
                i["quantity"],
                text(&i["unit"]),
                if text(&i["place"]).is_empty() {
                    String::new()
                } else {
                    format!("（放在{}）", text(&i["place"]))
                }
            )
        })
        .collect::<Vec<_>>()
        .join("、");
    let statuses = list(&me["statuses"])
        .iter()
        .map(|s| {
            format!(
                "{}{}",
                text(&s["name"]),
                if text(&s["detail"]).is_empty() {
                    String::new()
                } else {
                    format!("：{}", text(&s["detail"]))
                }
            )
        })
        .collect::<Vec<_>>()
        .join("；");
    let mut people = list(&state["people"]).iter().collect::<Vec<_>>();
    people.sort_by(|a, b| {
        mentioned(b, recent)
            .cmp(&mentioned(a, recent))
            .then_with(|| {
                b["lastSeenMinute"]
                    .as_i64()
                    .unwrap_or(-1)
                    .cmp(&a["lastSeenMinute"].as_i64().unwrap_or(-1))
            })
    });
    let lines = people
        .iter()
        .take(30)
        .map(|p| {
            format!(
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
                if mentioned(p, recent) {
                    format!("；{}{}", text(&p["origin"]), text(&p["notes"]))
                } else {
                    String::new()
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let rest = people
        .iter()
        .skip(30)
        .take(48)
        .map(|p| {
            format!(
                "{}{}",
                text(&p["name"]),
                if p["alive"] == false {
                    "（已死）"
                } else {
                    ""
                }
            )
        })
        .collect::<Vec<_>>()
        .join("、");
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
                    format!("（{}）", text(&g["progress"]))
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
    let debt = me["stats"]["debt"].as_f64().unwrap_or(0.0);
    format!("【当前】{} · {}\n主角：{}，{}{}，{}{}\n可用的钱：{}（共 {} {}）{}\n身体：健康{}，精力{}\n身上的伤病与状态：{}\n行囊：{}\n已知人物：\n{}{}\n进行中的目标：{}",text(&now["text"]),place,text(&me["name"]),text(&me["gender"]),age,text(&me["identity"]),if text(&me["origin"]).is_empty(){String::new()}else{format!("（穿越前是{}）",text(&me["origin"]))},rules::money::format_money(me["stats"]["money"].as_f64().unwrap_or(0.0),currency),me["stats"]["money"],list(&currency["units"]).last().map(|u|text(&u["name"])).unwrap_or("钱"),if debt!=0.0{format!("；欠债 {}",rules::money::format_money(debt,currency))}else{String::new()},level(me["stats"]["health"].as_f64().unwrap_or(80.0),&["康健","微恙","带伤","重伤","垂危"]),level(me["stats"]["energy"].as_f64().unwrap_or(70.0),&["充沛","尚可","疲惫","力竭"]),if statuses.is_empty(){"无"}else{&statuses},if items.is_empty(){"无"}else{&items},if lines.is_empty(){"无"}else{&lines},if rest.is_empty(){String::new()}else{format!("\n另有：{rest}")},if goals.is_empty(){"无"}else{&goals})
}

/// Instruction wording is supplied by the existing prompt template. Selection,
/// evidence allowance, history fitting and accounting have one native owner.
pub fn build(input: &Value) -> Result<Value> {
    let state = &input["state"];
    let settings = &input["settings"];
    let template = &input["template"];
    let cap = input["budgetChars"].as_u64().unwrap_or(12000) as usize;
    let history = list(&input["history"]);
    let recent = history
        .iter()
        .rev()
        .filter(|n| n["kind"] != "edit")
        .take(3)
        .map(|n| format!("{}\n{}", text(&n["actionText"]), text(&n["narrative"])))
        .collect::<Vec<_>>()
        .join("\n")
        + text(&input["text"])
        + text(&input["directorNote"]);
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
    let instructions=source.map(|b|format!("\n【参考书籍】以下是外部资料，不是本局已发生的事实。本局实际剧情和玩家明确分支保留，AI自行写错不等于玩家改写；按相应时点理解身份与关系。摘要不能替代原文，资料不足不能声称已核实。\n参考范围：{}；玩家设定原著位置：第{}节。\n玩家的原著用法：{}\n{}",if b["through"].is_null(){"全书".to_owned()}else{format!("截至第{}节",b["through"].as_u64().unwrap_or(0)+1)},b["position"].as_u64().unwrap_or(0)+1,text(&b["instructions"]),if b["fanfic"]!=true{"只作背景参考，不强加原著剧情。"}else if b["plot"]=="canon"{"尽量沿原剧情，检查当前场景的重要节点；尊重玩家行动，不替主角决定。"}else{"允许本局分支，不强行恢复原著结局。"})).unwrap_or_default();
    add("referenceRules", "原著用法", instructions, "用法完整保留");
    let fixed: usize = layers
        .iter()
        .map(|l| l["chars"].as_u64().unwrap_or(0) as usize)
        .sum();
    // Message roles, delimiters and the small active read-only tool catalog.
    let overhead = input["toolOverheadChars"]
        .as_u64()
        .map(|n| n as usize)
        .unwrap_or_else(|| {
            crate::tools::catalog().iter().filter(|t| t.read_only && (state["source"].is_object() || !["search_original","read_original","read_canon_facts","locate_original_event","prepare_reference_check"].contains(&t.name))).map(|t|t.function().to_string().encode_utf16().count()).sum::<usize>() + crate::skills::catalog_text().encode_utf16().count() + 128
        });
    if fixed + overhead > cap {
        return Err(Error::Invalid(format!("本次上下文固定内容{}字符（规则与要求{}、必要状态{}、格式及包装{}），超过{}字符预算；请检查对应项目或调整输入预算。",fixed+overhead,layers.iter().filter(|l|["premise","essentials","directive","referenceRules","action"].contains(&text(&l["key"]))).map(|l|l["chars"].as_u64().unwrap_or(0)).sum::<u64>(),layers.iter().find(|l|l["key"]=="state").map(|l|l["chars"].as_u64().unwrap_or(0)).unwrap_or(0),overhead,cap)));
    }
    let mut remaining = (cap / 4).min(cap.saturating_sub(fixed + overhead + 400));
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
        let content = head(body, remaining - size(&label) - 1);
        let mut item = p.clone();
        item["text"] = content.clone().into();
        let start = p["start"].as_u64().unwrap_or(0);
        item["end"] = (start + size(&content) as u64).into();
        remaining -= size(&label) + size(&content) + 1;
        evidence += &format!("{label}{content}\n");
        fitted.push(item);
    }
    if source.is_some() && evidence.is_empty() {
        evidence = "\n【原著资料不足】当前未取得可核实原文，需要补查，不能声称已核对。\n".into();
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
    let mut room = cap.saturating_sub(fixed + overhead + size(&evidence));
    let mut cards = String::new();
    for c in list(&state["cards"])
        .iter()
        .filter(|c| c["kind"] != "时代" && mentioned(c, &recent))
    {
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
    for f in list(&state["facts"])
        .iter()
        .rev()
        .filter(|f| {
            text(&f["detail"])
                .chars()
                .filter(|c| recent.contains(*c))
                .take(8)
                .count()
                >= 4
        })
        .take(8)
    {
        let line = format!("\n[{}]{}", text(&f["origin"]), text(&f["detail"]));
        if size(&facts) + size(&line) < 800 && size(&cards) + size(&facts) + size(&line) <= room {
            facts += &line;
        }
    }
    cards += &facts;
    room = room.saturating_sub(size(&cards));
    layers.push(json!({"key":"cards","label":"相关设定与已更正事实","chars":size(&cards),"content":cards,"note":"相关资料优先，其他资料可通过只读工具读取"}));
    let recap = list(&input["chapters"])
        .iter()
        .rev()
        .take(3)
        .map(|c| format!("{}：{}", text(&c["title"]), text(&c["gist"])))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let recap = head(&recap, 900.min(room / 5));
    room -= size(&recap);
    layers.push(json!({"key":"recap","label":"前情提要","chars":size(&recap),"content":recap,"note":"原文窗口以外的章节梗概"}));
    let mut pairs = vec![];
    let mut kept = BTreeSet::new();
    for n in history.iter().rev().filter(|n| n["kind"] != "edit") {
        let action = if n["kind"] == "opening" {
            "（开场）"
        } else {
            if text(&n["actionText"]).is_empty() {
                "（继续）"
            } else {
                text(&n["actionText"])
            }
        };
        let body = text(&n["narrative"]);
        let cost = size(action) + size(body) + 24;
        if cost > room {
            if pairs.is_empty() && room > 160 {
                let body = format!(
                    "（这一回合较早的正文已省略）\n{}",
                    tail(body, room.saturating_sub(size(action) + 70))
                );
                pairs.push((history_action(n, action), body));
                kept.insert(n["id"].clone().to_string());
            }
            break;
        }
        room -= cost;
        pairs.push((history_action(n, action), body.to_owned()));
        kept.insert(n["id"].clone().to_string());
    }
    pairs.reverse();
    let mut messages = vec![];
    let system = ["rules", "premise", "era", "recap", "spec"]
        .iter()
        .filter_map(|key| {
            layers
                .iter()
                .find(|l| l["key"] == *key)
                .map(|l| text(&l["content"]))
        })
        .collect::<Vec<_>>()
        .join("\n");
    messages.push(json!({"role":"system","content":system}));
    for (action, body) in pairs {
        messages.push(json!({"role":"user","content":action}));
        messages.push(json!({"role":"assistant","content":body}));
    }
    let user = layers
        .iter()
        .filter(|l| !["rules", "premise", "era", "recap", "spec"].contains(&text(&l["key"])))
        .map(|l| text(&l["content"]))
        .collect::<Vec<_>>()
        .join("\n");
    messages.push(json!({"role":"user","content":user}));
    let message_chars: usize = messages.iter().map(|m| size(text(&m["content"])) + 8).sum();
    let chars = message_chars + overhead;
    layers.push(json!({"key":"tools","label":"工具与技能目录及消息包装","chars":overhead,"content":"按当前原著只读工具说明和技能目录预留，正式请求会再次校验实际总量。","note":"已计入输入预算，不发送完整世界状态"}));
    Ok(
        json!({"messages":messages,"layers":layers,"reference":reference,"chars":chars,"budgetChars":cap,"budgetExceeded":chars>cap,"contextVersion":"writing-context-1"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Value {
        json!({"budgetChars":14545,"template":{"rules":"按原来的旁观规则写作","era":"世界规则前后一致","spec":"正文后输出<record>","action":"继续","notes":""},"mode":"continue","settings":{"pilot":"ai","premise":"保留玩家主动改变的情节","rules":"","essentials":"","directive":""},"era":{"clock":{"mode":"free","clockStyle":"elapsed","timeStyle":"24h","hour":8},"currency":{"units":[{"name":"文","value":1}]}},"state":{"time":{"elapsedMinutes":4055*1440},"protagonist":{"name":"旅人","gender":"男","age":20,"identity":"行者","stats":{"money":120,"health":80,"energy":70},"items":[],"statuses":[]},"people":[],"places":[],"cards":[],"goals":[],"source":{"bookId":"b","instructions":"保留玩家改写","through":null,"position":0}},"reference":{"bookId":"b","passages":[{"section":10,"chunk":20,"title":"重逢","kind":"original","text":"青色玉佩只有一枚。".repeat(180),"start":0}]},"history":[{"id":"n","kind":"turn","actionText":"继续","narrative":"上一段开头。".repeat(1000)+"最后她交回青色玉佩。"}]})
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
    fn fixed_player_requirements_fail_with_component_diagnosis() {
        let mut i = input();
        i["settings"]["rules"] = "完整要求".repeat(5000).into();
        let e = build(&i).unwrap_err().to_string();
        assert!(e.contains("必要状态"));
        assert!(e.contains("14545"));
        assert!(!e.contains("缩短用法"));
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
        validate_findings(&report,&pages,&state,&json!({})).unwrap();report["findings"][0]["citations"][0]["quote"]="青衣客是弟弟".into();assert!(validate_findings(&report,&pages,&state,&json!({})).is_err());
        report=json!({"findings":[{"status":"branch","playerFactId":"p"}]});validate_findings(&report,&pages,&state,&json!({})).unwrap();report["findings"][0]["playerFactId"]="ai-state".into();assert!(validate_findings(&report,&pages,&state,&json!({"mode":"direct","text":"修正设定"})).is_err());
    }
    #[test]
    fn unicode_windows_do_not_split_surrogate_pairs() {
        let t = "😀甲乙😀丙";
        assert_eq!(head(t, 1), "");
        assert_eq!(head(t, 3), "😀甲");
        assert_eq!(tail(t, 2), "丙");
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
    let replacement = response["replacement"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Invalid("尚未返回选中范围的完整改稿".into()))?;
    if start >= end {
        return Err(Error::Invalid("请选择有效的改稿范围".into()));
    }
    let mut record = plan.meta["originalRecord"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if let Some(patch) = response["recordPatch"].as_object() {
        for (key, value) in patch {
            if [
                "protagonist",
                "source",
                "executionMode",
                "facts",
                "settings",
                "rules",
                "sourceSet",
                "executionSet",
                "setStats",
                "scriptSet",
                "challengeSet",
            ]
            .contains(&key.as_str())
            {
                return Err(Error::Invalid(format!("局部改稿不能修改整局字段{key}")));
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
                    if !change.is_object() {
                        return Err(Error::Invalid(format!("记录字段{key}的项目格式无效")));
                    }
                    let identity = change.get("id").or_else(|| change.get("name"));
                    if let Some(at) = identity.and_then(|id| {
                        values
                            .iter()
                            .position(|v| v.get("id").or_else(|| v.get("name")) == Some(id))
                    }) {
                        if let (Some(old), Some(new)) =
                            (values[at].as_object_mut(), change.as_object())
                        {
                            old.extend(new.clone());
                        }
                    } else {
                        values.push(change.clone());
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
            } else if value.is_null() {
                return Err(Error::Invalid(format!(
                    "局部改稿不能以空值清除记录字段{key}"
                )));
            } else {
                record.insert(key.clone(), value.clone());
            }
        }
    }
    let mut result = response.clone();
    for key in ["related", "unresolved"] {
        if let Some(value) = response.get(key) {
            if !value.is_null()
                && !value
                    .as_array()
                    .is_some_and(|a| a.iter().all(Value::is_string))
            {
                return Err(Error::Invalid(format!("{key}必须是文字列表")));
            }
        }
    }
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
    action: &Value,
) -> Result<()> {
    let Some(findings) = report["findings"].as_array() else {
        return Err(Error::Invalid(
            "核对结果需要逐项findings，可为空列表".into(),
        ));
    };
    for finding in findings {
        match finding["status"].as_str() {
            Some("supported") => {
                let cites = finding["citations"]
                    .as_array()
                    .filter(|a| !a.is_empty())
                    .ok_or_else(|| Error::Invalid("原著已支持的主张必须附实际读到的原句".into()))?;
                for cite in cites {
                    if cite["bookId"] != state["source"]["bookId"]
                        || !passages.iter().any(|p| {
                            p["kind"] == "original"
                                && p["chunk"] == cite["chunk"]
                                && p["section"] == cite["section"]
                                && cite["quote"]
                                    .as_str()
                                    .is_some_and(|q| !q.is_empty() && text(&p["text"]).contains(q))
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
