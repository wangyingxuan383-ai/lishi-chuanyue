//! Bound the actual native request, including tool schemas and skill messages.
//! This only edits the outgoing copy; the durable run retains the full trace.
use crate::{Error, Result, RunPlan};
use serde_json::{json, Value};
use std::{collections::HashSet, ops::Range};

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

fn request_size(messages: &[Value], tools: &[Value]) -> usize {
    units(&json!({"messages":messages,"tools":tools}).to_string())
}

fn invalid(messages: &[Value], tools: &[Value], budget: usize) -> Error {
    let cost=|role:&str|messages.iter().filter(|m|m["role"]==role).map(|m|units(&m.to_string())).sum::<usize>();
    Error::Invalid(format!("本次请求装配{}字符，超过{}字符预算：规则{}、玩家要求与必要状态{}、原文及工具结果{}、近期正文与调用记录{}、工具说明{}。请根据占用缩小本次查阅范围或调整输入预算；完整玩家要求和原著用法已保留。",request_size(messages,tools),budget,cost("system"),cost("user"),cost("tool"),cost("assistant"),units(&json!(tools).to_string())))
}

#[derive(Clone)]
struct Group {
    range: Range<usize>,
    tool: bool,
}

/// Tool calls and their results are an indivisible protocol unit.
fn groups(messages: &[Value]) -> Result<Vec<Group>> {
    let mut groups = vec![];
    let mut index = 0;
    while index < messages.len() {
        let message = &messages[index];
        if message["role"] == "tool" {
            return Err(Error::Invalid(
                "工具上下文缺少对应调用，请恢复完整运行记录后重试".into(),
            ));
        }
        let Some(calls) = message.get("tool_calls") else {
            groups.push(Group {
                range: index..index + 1,
                tool: false,
            });
            index += 1;
            continue;
        };
        let calls = calls
            .as_array()
            .filter(|calls| !calls.is_empty())
            .ok_or_else(|| Error::Invalid("工具调用记录不完整".into()))?;
        if message["role"] != "assistant" {
            return Err(Error::Invalid("工具调用不属于模型消息".into()));
        }
        let mut remaining = HashSet::new();
        for call in calls {
            let id = call["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| Error::Invalid("工具调用缺少标识".into()))?;
            if !remaining.insert(id) {
                return Err(Error::Invalid("同组工具调用标识重复".into()));
            }
        }
        let start = index;
        index += 1;
        while index < messages.len() && messages[index]["role"] == "tool" {
            let id = messages[index]["tool_call_id"].as_str().unwrap_or("");
            if !remaining.remove(id) {
                return Err(Error::Invalid("工具结果与调用不匹配".into()));
            }
            index += 1;
        }
        if !remaining.is_empty() {
            return Err(Error::Invalid(
                "工具调用缺少结果，不能发送不完整的上下文".into(),
            ));
        }
        groups.push(Group {
            range: start..index,
            tool: true,
        });
    }
    Ok(groups)
}

fn protected(plan: &RunPlan, messages: &[Value], groups: &[Group]) -> Vec<bool> {
    let mut fixed: Vec<_> = messages.iter().map(|m| m["role"] == "system").collect();
    if let Some(last) = messages.iter().rposition(|m| m["role"] == "user") {
        fixed[last] = true;
        // continueMessages adds an interrupted assistant and one final user
        // instruction after the full fixed user context. All three are needed.
        if plan.kind == "continue"
            && plan
                .messages
                .iter()
                .rfind(|m| m["role"] == "user")
                .is_some_and(|m| m["content"] == messages[last]["content"])
        {
            if let Some(base) = messages[..last].iter().rposition(|m| m["role"] == "user") {
                fixed[base..=last].fill(true);
            }
        }
    }
    if let Some(group) = groups.last().filter(|g| g.tool) {
        // The model has not consumed the newest results yet. In particular,
        // never discard a skill immediately after it has been read.
        fixed[group.range.clone()].fill(true);
    }
    let instructions = plan
        .reference
        .as_ref()
        .and_then(|r| r["binding"]["instructions"].as_str())
        .unwrap_or("");
    if !instructions.is_empty() {
        for (index, message) in messages.iter().enumerate() {
            if message["role"] == "user"
                && message["content"]
                    .as_str()
                    .is_some_and(|s| s.contains(instructions))
            {
                fixed[index] = true;
            }
        }
    }
    fixed
}

fn source_paths(value: &Value, path: &str, out: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                let escaped = key.replace('~', "~0").replace('/', "~1");
                let next = format!("{path}/{escaped}");
                if (matches!(key.as_str(), "excerpts" | "passages")
                    && child.as_array().is_some_and(|a| {
                        a.iter().any(|p| {
                            p["text"].is_string()
                                && matches!(p["kind"].as_str(), Some("original" | "analysis"))
                        })
                    }))
                    || (key == "facts"
                        && object.get("bookId").is_some_and(Value::is_string)
                        && child.as_array().is_some_and(|a| {
                            a.iter()
                                .any(|p| p["quote"].is_string() && p["subject"].is_string())
                        }))
                {
                    out.push(next);
                } else {
                    source_paths(child, &next, out);
                }
            }
        }
        Value::Array(array) => {
            for (index, child) in array.iter().enumerate() {
                source_paths(child, &format!("{path}/{index}"), out);
            }
        }
        _ => {}
    }
}

fn identity(passage: &Value, book: &Value) -> String {
    json!({"book":passage.get("bookId").unwrap_or(book),"section":passage["section"],"chunk":passage["chunk"],"start":passage["start"],"end":passage["end"],"kind":passage["kind"],"text":passage["text"],"subject":passage["subject"],"statement":passage["statement"],"quote":passage["quote"]}).to_string()
}

fn instruction_overlap(content: &str, instructions: &str, range: &Range<usize>) -> bool {
    !instructions.is_empty()
        && content
            .match_indices(instructions)
            .any(|(start, text)| range.start < start + text.len() && start < range.end)
}

/// Only exact labeled reference bodies are replaced. The same quotation in a
/// player's instructions, state or current action remains untouched.
fn inline_ranges(
    content: &str,
    passages: &[Value],
    instructions: &str,
) -> Vec<(Range<usize>, Value)> {
    let mut ranges = vec![];
    for passage in passages {
        let Some(text) = passage["text"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        for (start, _) in content.match_indices(text) {
            let range = start..start + text.len();
            let label = content[..start].lines().last().unwrap_or("");
            if label.starts_with("[原著·")
                && label.ends_with(']')
                && label.contains("·片段")
                && !instruction_overlap(content, instructions, &range)
                && !ranges.iter().any(|(existing, _): &(Range<usize>, Value)| {
                    existing.start < range.end && range.start < existing.end
                })
            {
                ranges.push((range, passage.clone()));
            }
        }
    }
    ranges.sort_by_key(|(range, _)| range.start);
    ranges
}

/// Count complete excerpts including their provenance. Newer tool reads win;
/// no byte, scalar, or UTF-16 slicing can destroy a previously focused match.
fn bound_sources(plan: &RunPlan, messages: &mut [Value], allowance: usize) -> usize {
    let mut decoded: Vec<Option<Value>> = messages
        .iter()
        .map(|m| {
            if matches!(m["role"].as_str(), Some("user" | "tool")) {
                m["content"]
                    .as_str()
                    .and_then(|s| serde_json::from_str(s).ok())
            } else {
                None
            }
        })
        .collect();
    let mut paths = vec![vec![]; messages.len()];
    for (index, value) in decoded.iter().enumerate() {
        if let Some(value) = value {
            source_paths(value, "", &mut paths[index]);
        }
    }
    let actual_tool_original = messages.iter().enumerate().any(|(index, message)| {
        message["role"] == "tool"
            && decoded[index].as_ref().is_some_and(|value| {
                paths[index].iter().any(|path| {
                    value
                        .pointer(path)
                        .and_then(Value::as_array)
                        .is_some_and(|a| a.iter().any(|p| p["kind"] == "original"))
                })
            })
    });
    let reference = plan.reference.as_ref().unwrap_or(&Value::Null);
    let passages = reference["passages"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let instructions = reference["binding"]["instructions"].as_str().unwrap_or("");
    let mut used = 0usize;
    let mut seen = HashSet::new();
    for index in (0..messages.len()).rev() {
        if let Some(value) = &mut decoded[index] {
            for path in &paths[index] {
                let candidates = value
                    .pointer(path)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let parent_path = path
                    .rsplit_once('/')
                    .map(|(parent, _)| parent)
                    .unwrap_or("");
                let book = value
                    .pointer(parent_path)
                    .and_then(|v| v.get("bookId"))
                    .unwrap_or(&reference["bookId"])
                    .clone();
                let mut keep = vec![];
                let mut omitted = 0usize;
                for passage in candidates {
                    let cost = units(&passage.to_string());
                    let key = identity(&passage, &book);
                    if cost <= allowance.saturating_sub(used) && !seen.contains(&key) {
                        used += cost;
                        seen.insert(key);
                        keep.push(passage);
                    } else {
                        omitted += 1;
                    }
                }
                let empty = keep.is_empty();
                *value
                    .pointer_mut(path)
                    .expect("source path was collected from this value") = Value::Array(keep);
                if omitted > 0 {
                    if let Some(parent) = value
                        .pointer_mut(parent_path)
                        .and_then(Value::as_object_mut)
                    {
                        parent.insert("omitted".into(), json!({"reason":"budget","count":omitted}));
                        if empty {
                            parent.insert("status".into(), "omitted".into());
                            parent.insert("reason".into(), "budget".into());
                        }
                    }
                }
            }
            messages[index]["content"] = value.to_string().into();
        } else if messages[index]["role"] == "user" {
            let Some(content) = messages[index]["content"].as_str() else {
                continue;
            };
            let ranges = inline_ranges(content, passages, instructions);
            let mut replacements = vec![];
            for (range, passage) in ranges {
                let cost = units(&passage.to_string());
                let duplicate = actual_tool_original && passage["kind"] == "original";
                let key = identity(&passage, &reference["bookId"]);
                if !duplicate && cost <= allowance.saturating_sub(used) && !seen.contains(&key) {
                    used += cost;
                    seen.insert(key);
                } else {
                    replacements.push((
                        range,
                        if duplicate {
                            "（重复原文已省略，请查阅本次原著工具结果）"
                        } else {
                            "（此段原著资料因输入预算已省略，不能据此声称已核对）"
                        },
                    ));
                }
            }
            let mut revised = content.to_owned();
            for (range, marker) in replacements.into_iter().rev() {
                revised.replace_range(range, marker);
            }
            messages[index]["content"] = revised.into();
        }
    }
    used
}

pub fn bound_context(plan: &RunPlan, messages: Vec<Value>, tools: &[Value]) -> Result<Vec<Value>> {
    let budget = plan.meta["budgetChars"]
        .as_u64()
        .unwrap_or(12000)
        .min(usize::MAX as u64) as usize;
    let message_groups = groups(&messages)?;
    let fixed = protected(plan, &messages, &message_groups);
    let mut removed = vec![false; messages.len()];
    let current = |removed: &[bool], messages: &[Value]| {
        let mut retained = messages
            .iter()
            .enumerate()
            .filter(|(i, _)| !removed[*i])
            .map(|(_, m)| m.clone())
            .collect::<Vec<_>>();
        // Re-fit from the full trace after removing groups. Otherwise an
        // inline quote could stay marked duplicate after its tool copy went.
        bound_sources(plan, &mut retained, budget / 4);
        retained
    };
    // Old prose goes before old tool rounds. Never split an action/prose pair.
    let mut candidates = vec![];
    let mut index = 0;
    while index < messages.len() {
        let plain = message_groups
            .iter()
            .find(|g| g.range.start == index && !g.tool);
        if plain.is_some()
            && !fixed[index]
            && messages[index]["role"] == "user"
            && index + 1 < messages.len()
            && !fixed[index + 1]
            && messages[index + 1]["role"] == "assistant"
            && messages[index + 1].get("tool_calls").is_none()
        {
            candidates.push(index..index + 2);
            index += 2;
        } else {
            index += 1;
        }
    }
    candidates.extend(
        message_groups
            .iter()
            .filter(|g| g.tool && !g.range.clone().any(|i| fixed[i]))
            .map(|g| g.range.clone()),
    );
    for range in candidates {
        if request_size(&current(&removed, &messages), tools) <= budget {
            break;
        }
        removed[range].fill(true);
    }
    let mut outgoing = current(&removed, &messages);
    let mut evidence = bound_sources(plan, &mut outgoing, budget / 4);
    // If fixed layers still need room, omit complete remaining excerpts before
    // reporting failure. Their instructions and the latest tool group survive.
    while request_size(&outgoing, tools) > budget && evidence > 0 {
        let over = request_size(&outgoing, tools) - budget;
        let previous = request_size(&outgoing, tools);
        evidence = bound_sources(plan, &mut outgoing, evidence.saturating_sub(over));
        if request_size(&outgoing, tools) >= previous {
            break;
        }
    }
    if request_size(&outgoing, tools) > budget {
        return Err(invalid(&outgoing, tools, budget));
    }
    groups(&outgoing)?;
    Ok(outgoing)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(budget: usize) -> RunPlan {
        serde_json::from_value(json!({"id":"isolated","worldId":"w","lineId":"l","headId":"n","baseId":"n","kind":"turn","model":{"slot":"test","url":"https://model.invalid","model":"fake","includeUsage":false},"messages":[],"extractMessages":[],"state":{},"settings":{},"options":{},"action":{},"meta":{"budgetChars":budget}})).unwrap()
    }
    fn message(role: &str, content: impl Into<String>) -> Value {
        json!({"role":role,"content":content.into()})
    }
    fn call(id: &str, name: &str) -> Value {
        json!({"id":id,"type":"function","function":{"name":name,"arguments":"{}"}})
    }
    fn request(calls: Vec<Value>) -> Value {
        json!({"role":"assistant","content":"","tool_calls":calls})
    }
    fn response(id: &str, value: Value) -> Value {
        json!({"role":"tool","tool_call_id":id,"content":value.to_string()})
    }

    #[test]
    fn removing_an_old_tool_group_restores_its_inline_original_copy() {
        let original = "姐姐仍是守桥人，钥匙在竹匣。".repeat(8);
        let passage = json!({"kind":"original","text":original,"section":0,"chunk":0});
        let mut p = plan(2000);
        p.reference = Some(
            json!({"bookId":"book","binding":{"instructions":"按原著核实"},"passages":[passage.clone()]}),
        );
        let messages = vec![
            message("system", "规则"),
            message(
                "user",
                format!("按原著核实\n[原著·第一章·原文·片段1]\n{original}\n当前行动：问好"),
            ),
            request(vec![call("old", "read_original")]),
            response(
                "old",
                json!({"bookId":"book","excerpts":[passage],"oldContext":"往事".repeat(3000)}),
            ),
            request(vec![call("skill", "read_skill")]),
            response("skill", json!({"name":"story-writing","body":"写作指导"})),
        ];
        let outgoing = bound_context(&p, messages, &[]).unwrap();
        assert!(!outgoing.iter().any(|m| m["tool_call_id"] == "old"));
        assert!(outgoing[1]["content"].as_str().unwrap().contains(&original));
        assert!(!outgoing[1]["content"]
            .as_str()
            .unwrap()
            .contains("重复原文已省略"));
    }

    #[test]
    fn tool_schema_and_skill_overhead_shrink_old_prose_before_fixed_layers() {
        let tools = vec![
            json!({"type":"function","function":{"name":"read_original","description":"工具说明".repeat(90)}}),
        ];
        let fixed = "当前状态、玩家行动和固定资料".repeat(12);
        let mut messages = vec![message("system", "技能目录与写作规则".repeat(10))];
        for n in 0..4 {
            messages.push(message("user", format!("旧行动{n}")));
            messages.push(message(
                "assistant",
                format!("旧正文{n}{}", "往事".repeat(180)),
            ));
        }
        messages.push(message("user", &fixed));
        let outgoing = bound_context(&plan(1400), messages, &tools).unwrap();
        assert_eq!(outgoing.last().unwrap()["content"], fixed);
        assert_eq!(outgoing[0]["content"], "技能目录与写作规则".repeat(10));
        assert!(!outgoing
            .iter()
            .any(|m| m["content"].as_str().is_some_and(|s| s.contains("旧正文0"))));
        assert!(request_size(&outgoing, &tools) <= 1400);
        let partial = "中断处的正文必须完整保留🧭".repeat(10);
        let continued = vec![
            message("system", "规则"),
            message("user", "旧行动"),
            message("assistant", "旧正文".repeat(1000)),
            message("user", &fixed),
            message("assistant", &partial),
            message("user", "从中断处续写"),
        ];
        let mut p = plan(1700);
        p.kind = "continue".into();
        p.messages = continued.clone();
        let outgoing = bound_context(&p, continued, &tools).unwrap();
        assert!(outgoing
            .iter()
            .any(|m| m["role"] == "user" && m["content"] == fixed));
        assert!(outgoing
            .iter()
            .any(|m| m["role"] == "assistant" && m["content"] == partial));
        assert_eq!(outgoing.last().unwrap()["content"], "从中断处续写");
    }

    #[test]
    fn instructions_are_complete_even_when_their_text_is_also_a_quotation() {
        let instructions = "绝不删改这一段原著用法🧭".repeat(80);
        let mut p = plan(12000);
        p.reference = Some(
            json!({"bookId":"book","binding":{"instructions":instructions},"passages":[{"kind":"original","text":instructions,"section":0,"chunk":0}]}),
        );
        let fixed = format!("玩家的原著用法：{instructions}\n当前行动：说话");
        let messages = vec![
            message("system", "规则"),
            message("user", &fixed),
            request(vec![call("source", "read_original")]),
            response(
                "source",
                json!({"bookId":"book","status":"ready","excerpts":[{"kind":"original","text":"有出处的原文","section":0,"chunk":1}]}),
            ),
        ];
        let outgoing = bound_context(&p, messages.clone(), &[]).unwrap();
        assert_eq!(outgoing[1]["content"], fixed);
        p.meta["budgetChars"] = 1000.into();
        let error = bound_context(&p, messages, &[]).unwrap_err().to_string();
        assert!(error.contains("调整输入预算"));
    }

    #[test]
    fn original_evidence_shares_one_quarter_and_keeps_complete_focused_unicode_excerpts() {
        let old = json!({"bookId":"book","section":0,"chunk":0,"start":900,"end":1500,"kind":"original","text":"旧".repeat(600)});
        let new_text = format!("{}真正命中的结尾", "🧭".repeat(180));
        let new = json!({"bookId":"book","section":1,"chunk":2,"start":1840,"end":1840+units(&new_text),"kind":"original","text":new_text});
        let mut p = plan(4000);
        p.reference = Some(
            json!({"bookId":"book","binding":{"instructions":"保持人物关系"},"passages":[old.clone()]}),
        );
        let messages = vec![
            message("system", "规则"),
            message(
                "user",
                format!(
                    "玩家的原著用法：保持人物关系\n[原著·旧章·原文·片段1]\n{}\n当前行动：核对关系",
                    old["text"].as_str().unwrap()
                ),
            ),
            request(vec![call("old", "read_original")]),
            response(
                "old",
                json!({"bookId":"book","status":"ready","excerpts":[old]}),
            ),
            request(vec![call("new", "read_original")]),
            response(
                "new",
                json!({"bookId":"book","status":"ready","excerpts":[new.clone()]}),
            ),
            request(vec![call("facts", "read_canon_facts")]),
            response(
                "facts",
                json!({"bookId":"book","facts":[{"section":1,"chunk":2,"kind":"relation","subject":"甲","statement":"已经核实的关系","quote":"真正命中的结尾"}]}),
            ),
        ];
        let trace = messages.clone();
        let outgoing = bound_context(&p, messages, &[]).unwrap();
        let mut total = 0;
        for message in outgoing.iter().filter(|m| m["role"] == "tool") {
            let result: Value = serde_json::from_str(message["content"].as_str().unwrap()).unwrap();
            for excerpt in result
                .get("excerpts")
                .or_else(|| result.get("facts"))
                .and_then(Value::as_array)
                .unwrap()
            {
                total += units(&excerpt.to_string());
            }
        }
        assert!(total <= 1000);
        let latest: Value = serde_json::from_str(outgoing[5]["content"].as_str().unwrap()).unwrap();
        assert_eq!(latest["excerpts"], json!([new]));
        let previous: Value =
            serde_json::from_str(outgoing[3]["content"].as_str().unwrap()).unwrap();
        assert_eq!(previous["status"], "omitted");
        assert_eq!(previous["reason"], "budget");
        assert!(outgoing[1]["content"]
            .as_str()
            .unwrap()
            .contains("重复原文已省略"));
        assert!(trace[1]["content"]
            .as_str()
            .unwrap()
            .contains(&"旧".repeat(600)));
    }

    #[test]
    fn shrinking_tools_keeps_complete_call_result_groups_and_latest_skill() {
        let skill = "这一轮尚未使用的完整技能说明🧭".repeat(18);
        let messages = vec![
            message("system", "目录"),
            message("user", "本局固定资料与当前行动"),
            request(vec![call("old", "read_world")]),
            response("old", json!({"history":"旧正文".repeat(500)})),
            request(vec![
                call("skill", "read_skill"),
                call("world", "read_world"),
            ]),
            response("skill", json!({"name":"canon-reference","body":skill})),
            response("world", json!({"state":"当前事实"})),
        ];
        let outgoing = bound_context(&plan(1700), messages, &[]).unwrap();
        assert_eq!(outgoing.len(), 5);
        assert_eq!(outgoing[2]["tool_calls"].as_array().unwrap().len(), 2);
        assert_eq!(outgoing[3]["tool_call_id"], "skill");
        assert_eq!(outgoing[4]["tool_call_id"], "world");
        assert!(outgoing
            .iter()
            .any(|m| m["content"].as_str().is_some_and(|s| s.contains(&skill))));
        groups(&outgoing).unwrap();
        assert!(bound_context(&plan(2000), vec![response("orphan", json!({}))], &[]).is_err());
    }
}
