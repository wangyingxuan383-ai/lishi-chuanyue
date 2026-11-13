//! Rebuild visible dialogue and tool progress from durable Pi events. This is
//! a read-only UI projection, never a model transcript or completion authority.
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const MAX_EVENTS: usize = 20_000;
pub const MAX_MESSAGES: usize = 500;
pub const MAX_CALLS: usize = 1_000;
pub const MAX_TEXT_CHARS: usize = 16_000;
const MAX_RESULT_BYTES: usize = 512 * 1024;

/// Persist only the UI/accounting portion of a Pi event. Pi's own session is
/// authoritative for the model transcript, and pi_calls owns complete tool
/// outputs. In particular, a hidden-thinking delta must not write the entire
/// growing assistant message again. Node also throttles visible snapshots.
///
/// Valid user messages retain their exact text (including the native input
/// nonce): the original input limit is 100k UTF-16 units plus its small marker.
/// Oversize or non-text user events are rejected instead of silently changed.
pub fn persistable_event(record: &Value) -> Option<Value> {
    fn string_fields(from: &Value, to: &mut Value, keys: &[&str], cap: usize) {
        for key in keys {
            if let Some(value) = from[*key].as_str() {
                if value.len() <= cap {
                    to[*key] = value.into();
                }
            }
        }
    }
    fn numbers(from: &Value, to: &mut Value, keys: &[&str]) {
        for key in keys {
            if from[*key]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.0)
            {
                to[*key] = from[*key].clone();
            }
        }
    }
    fn booleans(from: &Value, to: &mut Value, keys: &[&str]) {
        for key in keys {
            if from[*key].is_boolean() {
                to[*key] = from[*key].clone();
            }
        }
    }
    fn usage(raw: &Value) -> Value {
        let mut out = json!({});
        numbers(
            raw,
            &mut out,
            &[
                "input",
                "output",
                "cacheRead",
                "cacheWrite",
                "cacheWrite1h",
                "reasoning",
                "totalTokens",
            ],
        );
        if raw["cost"].is_object() {
            let mut cost = json!({});
            numbers(
                &raw["cost"],
                &mut cost,
                &[
                    "input",
                    "output",
                    "cacheRead",
                    "cacheWrite",
                    "cacheWrite1h",
                    "total",
                ],
            );
            if cost.as_object().is_some_and(|v| !v.is_empty()) {
                out["cost"] = cost;
            }
        }
        out
    }
    fn message(raw: &Value, kind: &str) -> Option<Value> {
        let role = text(raw, "role");
        if !["user", "assistant", "toolResult"].contains(&role) {
            return None;
        }
        let mut out = json!({"role":role});
        string_fields(raw, &mut out, &["id", "toolCallId", "toolName"], 512);
        numbers(raw, &mut out, &["timestamp"]);
        booleans(raw, &mut out, &["isError", "endTurn"]);
        if role == "user" {
            if kind == "message_update" {
                return None;
            }
            let mut total = 0;
            let content = if let Some(s) = raw["content"].as_str() {
                if s.encode_utf16().count() > 100_512 {
                    return None;
                }
                Value::String(s.into())
            } else {
                let parts = raw["content"].as_array()?;
                if parts.len() > 2048 {
                    return None;
                }
                let mut clean = vec![];
                for part in parts {
                    if part["type"] != "text" {
                        return None;
                    }
                    let value = part["text"].as_str()?;
                    total += value.encode_utf16().count();
                    if total > 100_512 {
                        return None;
                    }
                    clean.push(json!({"type":"text","text":value}));
                }
                Value::Array(clean)
            };
            out["content"] = content;
        } else if role == "assistant" {
            let (content, cut) = visible(raw);
            if kind == "message_update" && content.is_empty() {
                return None;
            }
            out["content"] = if content.is_empty() {
                json!([])
            } else {
                json!([{"type":"text","text":content}])
            };
            if cut {
                out["projectionTruncated"] = true.into();
            }
            if ["stop", "length", "toolUse", "error", "aborted"].contains(&text(raw, "stopReason"))
            {
                out["stopReason"] = raw["stopReason"].clone();
            }
            string_fields(
                raw,
                &mut out,
                &["api", "provider", "model", "responseModel"],
                256,
            );
        }
        if kind == "message_end" && raw["usage"].is_object() {
            out["usage"] = usage(&raw["usage"]);
        }
        Some(out)
    }
    let original = event(record);
    let kind = text(original, "type");
    let mut clean = json!({"type":kind});
    match kind {
        "message_start" | "message_update" | "message_end" => {
            if kind == "message_update" {
                let change = text(&original["assistantMessageEvent"], "type");
                if !change.is_empty() && !matches!(change, "text_start" | "text_delta" | "text_end")
                {
                    return None;
                }
            }
            clean["message"] = message(&original["message"], kind)?;
        }
        "tool_execution_start" | "tool_execution_update" | "tool_execution_end" => {
            string_fields(
                original,
                &mut clean,
                &["toolCallId", "toolName", "parentToolCallId"],
                512,
            );
            if !clean["toolCallId"].is_string() {
                return None;
            }
            if kind == "tool_execution_start" {
                let mut args = object_args(&original["args"]);
                string_fields(
                    &original["args"],
                    &mut args,
                    &["bookId", "routeId", "serverId", "callId"],
                    512,
                );
                numbers(
                    &original["args"],
                    &mut args,
                    &["section", "chunk", "offset", "limit"],
                );
                clean["args"] = args;
            }
            if kind == "tool_execution_update" {
                let mut progress = json!({});
                numbers(
                    &original["partialResult"],
                    &mut progress,
                    &["completed", "total", "count", "elapsedMs"],
                );
                clean["progress"] = progress;
            }
            if kind == "tool_execution_end" {
                booleans(original, &mut clean, &["isError"]);
                numbers(original, &mut clean, &["durationMs"]);
                let mut result = business(&original["result"]);
                if result["ok"] == false {
                    // Failure semantics and the real call locator suffice;
                    // provider error prose can echo request credentials.
                    result["error"]["message"] = "工具报告业务失败，请查看已保存结果".into();
                }
                clean["result"] = json!({"details":result});
                if original["result"]["usage"].is_object() {
                    clean["result"]["usage"] = usage(&original["result"]["usage"]);
                }
                clean["resultRef"] =
                    json!({"callId":clean["toolCallId"],"path":"","offset":0,"limit":1200});
            }
        }
        "agent_start" | "agent_end" | "agent_settled" | "turn_start" | "turn_end" => {
            booleans(original, &mut clean, &["aborted", "willRetry"]);
        }
        "context_state" => {
            let raw=&original["data"];let mut data=json!({"version":1});
            numbers(raw,&mut data,&["usedTokens","effectiveInputBudgetTokens","requestedTokens","modelWindowTokens","outputReserveTokens","lastRequestInputTokens","compactions","tokensBefore","tokensAfter","summaryChars","requestCompactionVersion","lastRequestEstimatedTokens","estimateRatio"]);
            string_fields(raw,&mut data,&["attemptId","requestId","requestModel","lastRequestAt","lastCompactionAt","updatedAt"],256);
            if ["pending","estimated","unknown"].contains(&text(raw,"measurement")){data["measurement"]=raw["measurement"].clone();}
            clean["data"]=data;
        }
        "queue_update" => {
            for key in ["steering", "followUp"] {
                if let Some(items) = original[key].as_array() {
                    clean[format!("{key}Count")] = items.len().into();
                }
            }
        }
        "compaction_start" | "compaction_end" => {
            if ["manual", "threshold", "overflow"].contains(&text(original, "reason")) {
                clean["reason"] = original["reason"].clone();
            }
            booleans(original, &mut clean, &["aborted", "willRetry"]);
            if kind == "compaction_end" {
                let raw = &original["result"];
                let mut result = json!({});
                numbers(raw, &mut result, &["tokensBefore", "tokensAfter"]);
                string_fields(raw, &mut result, &["firstKeptEntryId"], 512);
                if raw["usage"].is_object() {
                    result["usage"] = usage(&raw["usage"]);
                }
                clean["result"] = result;
            }
        }
        "auto_retry_start"
        | "auto_retry_end"
        | "summarization_retry_scheduled"
        | "summarization_retry_attempt_start"
        | "summarization_retry_finished" => {
            numbers(original, &mut clean, &["attempt", "maxAttempts", "delayMs"]);
            booleans(original, &mut clean, &["success"]);
            if ["compaction", "branchSummary"].contains(&text(original, "source")) {
                clean["source"] = original["source"].clone();
            }
            if ["manual", "threshold", "overflow"].contains(&text(original, "reason")) {
                clean["reason"] = original["reason"].clone();
            }
        }
        "message_anchor" => {
            string_fields(original, &mut clean, &["entryId", "messageKey", "userHash"], 512);
            if !["user", "assistant"].contains(&text(original,"role")) || !clean["entryId"].is_string() {return None;}
            clean["role"]=original["role"].clone();
        }
        "entry_appended" => {
            let mut entry = json!({});
            string_fields(&original["entry"], &mut entry, &["id", "parentId"], 512);
            if [
                "message",
                "compaction",
                "branch_summary",
                "model_change",
                "thinking_level_change",
                "label",
                "session_info",
            ]
            .contains(&text(&original["entry"], "type"))
            {
                entry["type"] = original["entry"]["type"].clone();
            }
            clean["entry"] = entry;
        }
        "native_tool_cancel" => {
            string_fields(original, &mut clean, &["requestId"], 512);
        }
        "task_context_read" => {
            numbers(original, &mut clean, &["intentRevision"]);
            if [
                "running",
                "waiting_user",
                "committed",
                "previewed",
                "completed",
                "blocked",
            ]
            .contains(&text(original, "status"))
            {
                clean["status"] = original["status"].clone();
            }
        }
        _ => return None,
    }
    // Parent/child attribution is native-owned and must survive filtering so
    // child updates can never be mistaken for the root dialogue or its input.
    string_fields(original, &mut clean, &["childId", "parentCallId"], 512);
    let source = envelope(record);
    if record["event"].is_object() {
        let mut outer = json!({"type":"event","event":clean});
        string_fields(
            source,
            &mut outer,
            &["sessionId", "taskId", "childId", "parentCallId"],
            512,
        );
        if record["event"]["event"].is_object() {
            let mut wrapper = json!({"event":outer});
            numbers(record, &mut wrapper, &["seq"]);
            Some(wrapper)
        } else {
            Some(outer)
        }
    } else {
        Some(clean)
    }
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn field<'a>(v: &'a Value, a: &str, b: &str) -> &'a str {
    v[a].as_str().or_else(|| v[b].as_str()).unwrap_or("")
}
fn clipped(value: &str, cap: usize) -> (String, bool) {
    let mut chars = value.chars();
    let result = chars.by_ref().take(cap).collect();
    (result, chars.next().is_some())
}
fn parsed(value: &Value) -> Value {
    match value {
        Value::String(s) if s.len() <= MAX_RESULT_BYTES => {
            serde_json::from_str(s).unwrap_or(Value::Null)
        }
        Value::String(_) => Value::Null,
        _ => value.clone(),
    }
}
fn event(record: &Value) -> &Value {
    if record["event"]["event"].is_object() {
        &record["event"]["event"]
    } else if record["event"].is_object() {
        &record["event"]
    } else {
        record
    }
}
fn envelope(record: &Value) -> &Value {
    if record["event"]["event"].is_object() {
        &record["event"]
    } else {
        record
    }
}
fn ordered(events: &[Value]) -> Vec<(u64, &Value)> {
    let offset = events.len().saturating_sub(MAX_EVENTS);
    let mut seen = HashSet::new();
    let mut all = events
        .iter()
        .enumerate()
        .skip(offset)
        .map(|(i, v)| (v["seq"].as_u64().unwrap_or(i as u64 + 1), v))
        .collect::<Vec<_>>();
    all.sort_by_key(|(seq, _)| *seq);
    all.retain(|(seq, _)| seen.insert(*seq));
    all
}
fn visible(message: &Value) -> (String, bool) {
    if let Some(s) = message["content"].as_str() {
        return clipped(s, MAX_TEXT_CHARS);
    }
    let mut out = String::new();
    let mut remaining = MAX_TEXT_CHARS;
    let mut truncated = false;
    for part in message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .take(256)
    {
        if part["type"] != "text" {
            continue;
        }
        let (s, cut) = clipped(text(part, "text"), remaining);
        remaining = remaining.saturating_sub(s.chars().count());
        out.push_str(&s);
        truncated |= cut;
        if remaining == 0 {
            truncated = true;
            break;
        }
    }
    (out, truncated)
}
fn created(message: &Value, fallback: &str) -> String {
    message["timestamp"]
        .as_i64()
        .and_then(DateTime::<Utc>::from_timestamp_millis)
        .map(|v| v.to_rfc3339())
        .unwrap_or_else(|| fallback.into())
}
fn timestamp(message: &Value) -> String {
    message["id"]
        .as_str()
        .map(|v| format!("id:{}", identity(v)))
        .or_else(|| message["timestamp"].as_i64().map(|v| format!("at:{v}")))
        .unwrap_or_default()
}
fn identity(value: &str) -> String {
    if value.len() <= 512 {
        value.into()
    } else {
        format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
    }
}
fn make_message(
    task: &Value,
    id: &str,
    role: &str,
    content: &str,
    at: &str,
    seq: u64,
    status: &str,
    truncated: bool,
) -> Value {
    json!({"id":id,"taskId":task["id"],"sessionId":task.get("session_id").or_else(||task.get("sessionId")),"role":role,"content":content,"createdAt":at,"seq":seq,"status":status,"truncated":truncated})
}
struct Input {
    id: String,
    text: String,
    nonce: String,
    status: String,
    delivery: String,
    at: String,
    truncated: bool,
    display: Option<String>,
}
fn inputs_for(task: &Value, inputs: &[Value]) -> Vec<Input> {
    let mut all = inputs
        .iter()
        .rev()
        .take(MAX_MESSAGES)
        .filter_map(|input| {
            let target = field(input, "task_id", "taskId");
            if !target.is_empty() && target != text(task, "id") {
                return None;
            }
            if text(input, "delivery") == "queued" && target.is_empty() {
                return None;
            }
            let content = parsed(&input["content_json"]);
            let value = input["text"]
                .as_str()
                .or_else(|| content["text"].as_str())
                .unwrap_or("");
            if value.is_empty() || text(input, "id").is_empty() {
                return None;
            }
            let (body, truncated) = clipped(value, MAX_TEXT_CHARS);
            Some(Input {
                id: clipped(text(input, "id"), 128).0,
                text: body,
                nonce: clipped(text(&content, "nonce"), 128).0,
                status: clipped(text(input, "status"), 32).0,
                delivery: clipped(text(input, "delivery"), 32).0,
                at: clipped(field(input, "created_at", "createdAt"), 80).0,
                truncated,
                display: if input["delivery"]=="answer" {input["displayContent"].as_str().map(str::to_owned).or_else(||crate::pi_questions::display_answer(&content))}else{None},
            })
        })
        .collect::<Vec<_>>();
    all.reverse();
    all
}
fn matches_input(input: &Input, value: &str, truncated: bool) -> bool {
    if value == input.text {
        return true;
    }
    let Some((marker, body)) = value.split_once("】\n") else {
        return false;
    };
    let prefix = format!("【本次补充标识 {}:", input.id);
    marker.starts_with(&prefix)
        && (body == input.text || truncated && input.text.starts_with(body))
        && (input.nonce.is_empty() || marker == format!("{prefix}{}", input.nonce))
}

/// `events` accepts PiStore's {seq,event:envelope} records; `inputs` accepts
/// either raw pi_inputs rows or the existing safe camel-case input projection.
/// The task goal and accepted supplements remain visible when a page waiter
/// disappeared. Internal replay of the original prompt is not a second input.
pub fn messages(task: &Value, events: &[Value], inputs: &[Value]) -> Vec<Value> {
    if task["status"]=="archived" {
        let raw=parsed(&task["result_json"]);
        return raw["history"]["messages"].as_array().into_iter().flatten().enumerate().filter(|(_,m)|["user","assistant"].contains(&text(m,"role"))).map(|(i,m)|make_message(task,&format!("{}:imported:{i}",text(task,"id")),text(m,"role"),text(m,"content"),text(m,"createdAt"),i as u64,"archived",m["truncated"]==true)).collect();
    }

    let task_id = text(task, "id");
    let at = field(task, "created_at", "createdAt");
    let initial = text(task, "text");
    let (goal, cut) = clipped(initial, MAX_TEXT_CHARS);
    let mut out = vec![];
    if !goal.is_empty() {
        out.push(make_message(
            task,
            &format!("{task_id}:user"),
            "user",
            &goal,
            at,
            0,
            "delivered",
            cut,
        ));
    }
    let inputs = inputs_for(task, inputs);
    let mut used = HashSet::new();
    let mut current: Option<(usize, String)> = None;
    let mut message_keys: HashMap<String, usize> = HashMap::new();
    for (seq, record) in ordered(events) {
        if !text(envelope(record), "childId").is_empty()
            || !text(event(record), "childId").is_empty()
        {
            continue;
        }
        let owner = text(envelope(record), "taskId");
        if !owner.is_empty() && owner != task_id {
            continue;
        }
        let item = event(record);
        let kind = text(item, "type");
        if !["message_start", "message_update", "message_end"].contains(&kind) {
            continue;
        }
        let message = &item["message"];
        let role = text(message, "role");
        if !["user", "assistant"].contains(&role) {
            continue;
        }
        let (content, cut) = visible(message);
        if role == "user" {
            if kind != "message_start" || content.is_empty() {
                continue;
            }
            if let Some(input) = inputs
                .iter()
                .find(|i| !used.contains(&i.id) && matches_input(i, &content, cut))
            {
                used.insert(input.id.clone());
                let (body, limited) = clipped(&input.text, MAX_TEXT_CHARS);
                let mut row = make_message(
                    task,
                    &format!("{task_id}:input:{}", input.id),
                    "user",
                    &body,
                    &input.at,
                    seq,
                    "delivered",
                    limited || input.truncated,
                );
                row["delivery"] = input.delivery.clone().into();
                if let Some(display)=&input.display {row["displayContent"]=clipped(display,MAX_TEXT_CHARS).0.into();}
                out.push(row);
            } else if content != goal
                && !inputs
                    .iter()
                    .any(|i| used.contains(&i.id) && matches_input(i, &content, cut))
            {
                out.push(make_message(
                    task,
                    &format!("{task_id}:user:{seq}"),
                    "user",
                    &content,
                    &created(message, at),
                    seq,
                    "delivered",
                    cut,
                ));
            }
            continue;
        }
        let key = timestamp(message);
        let index = if kind == "message_start" {
            // A new response keeps any earlier intermediate assistant text.
            let id = if key.is_empty() || message_keys.contains_key(&key) {
                format!("{task_id}:assistant:{seq}")
            } else {
                format!("{task_id}:assistant:{key}")
            };
            let index = out.len();
            out.push(make_message(
                task,
                &id,
                "assistant",
                "",
                &created(message, at),
                seq,
                "streaming",
                false,
            ));
            if !key.is_empty() {
                message_keys.insert(key.clone(), index);
            }
            current = Some((index, key.clone()));
            index
        } else if let Some(index) = (!key.is_empty())
            .then(|| message_keys.get(&key).copied())
            .flatten()
            .or_else(|| current.as_ref().map(|(i, _)| *i))
        {
            index
        } else {
            let index = out.len();
            let id = if key.is_empty() {
                format!("{task_id}:assistant:{seq}")
            } else {
                format!("{task_id}:assistant:{key}")
            };
            out.push(make_message(
                task,
                &id,
                "assistant",
                "",
                &created(message, at),
                seq,
                "streaming",
                false,
            ));
            if !key.is_empty() {
                message_keys.insert(key.clone(), index);
            }
            current = Some((index, key.clone()));
            index
        };
        if !content.is_empty() {
            out[index]["content"] = content.into();
            out[index]["truncated"] = cut.into();
        }
        if kind == "message_end" {
            out[index]["status"] = match text(message, "stopReason") {
                "error" => "failed",
                "aborted" => "cancelled",
                _ => "completed",
            }
            .into();
            if current.as_ref().is_some_and(|(i, _)| *i == index) {
                current = None;
            }
        }
    }
    for input in inputs.into_iter().filter(|input| !used.contains(&input.id)) {
        let (content, cut) = clipped(&input.text, MAX_TEXT_CHARS);
        let mut row = make_message(
            task,
            &format!("{task_id}:input:{}", input.id),
            "user",
            &content,
            &input.at,
            u64::MAX,
            &input.status,
            cut || input.truncated,
        );
        if let Some(display)=&input.display {row["displayContent"]=clipped(display,MAX_TEXT_CHARS).0.into();}
        row["delivery"] = input.delivery.into();
        out.push(row);
    }
    out.retain(|m| !text(m, "content").is_empty());
    let limited = events.len() > MAX_EVENTS || out.len() > MAX_MESSAGES;
    if out.len() > MAX_MESSAGES {
        out.drain(1..out.len() - MAX_MESSAGES + 1);
    }
    if limited {
        if let Some(first) = out.first_mut() {
            first["projectionTruncated"] = true.into();
        }
    }
    out
}

struct Step {
    id: String,
    task: String,
    name: String,
    args: Value,
    result: Value,
    seq: u64,
    starts: usize,
    ended: bool,
    error: bool,
    cancelled: bool,
    duration: Value,
    ledger_status: String,
    limited: bool,
    call_limited: bool,
    child: String,
    parent: String,
}
fn business(value: &Value) -> Value {
    if value["ok"].is_boolean() {
        return summary_result(value);
    }
    if value["details"]["ok"].is_boolean() {
        return summary_result(&value["details"]);
    }
    for part in value["content"].as_array().into_iter().flatten().take(4) {
        if part["type"] == "text" {
            let decoded = parsed(&part["text"]);
            if decoded["ok"].is_boolean() {
                return summary_result(&decoded);
            }
        }
    }
    Value::Null
}
pub(crate) fn summary_result(value: &Value) -> Value {
    let data = &value["data"];
    let mut projected = json!({"ok":value["ok"],"outcomeUnknown":value["outcomeUnknown"],"error":{"code":clipped(text(&value["error"],"code"),80).0,"message":clipped(text(&value["error"],"message"),180).0},"data":{}});
    for key in [
        "status",
        "goalStatus",
        "goalCompleted",
        "reason",
        "worldChanged",
        "staged",
        "reused",
        "changed",
        "bodyRead",
        "isError",
    ] {
        if data[key].is_boolean() || data[key].is_string() {
            projected["data"][key] = if let Some(s) = data[key].as_str() {
                clipped(s, 40).0.into()
            } else {
                data[key].clone()
            };
        }
    }
    for key in ["title", "name"] {
        if let Some(s) = data[key].as_str() {
            projected["data"][key] = clipped(s, 100).0.into();
        }
    }
    for key in [
        "changes",
        "matches",
        "excerpts",
        "resources",
        "steps",
        "definitions",
        "goals", "unresolvedGoals", "validSelections", "normalizedFindings",
    ] {
        if let Some(items) = data[key].as_array() {
            projected["data"][format!("{key}Count")] = items.len().into();
        }
    }
    if let Some(items) = data["steps"].as_array() {
        projected["data"]["completedSteps"] = items
            .iter()
            .take(1000)
            .filter(|s| s["status"] == "completed")
            .count()
            .into();
    }
    if let Some(s) = data["text"].as_str() {
        projected["data"]["textChars"] = s.chars().take(MAX_TEXT_CHARS + 1).count().into();
    }
    projected["data"]["hasPaths"] = data["paths"].is_array().into();
    projected["data"]["hasValue"] = (!data["value"].is_null()).into();
    if let Some(items)=data["value"].as_array(){projected["data"]["valueCount"]=items.len().into();}
    for key in [
        "changesCount",
        "matchesCount",
        "excerptsCount",
        "resourcesCount",
        "stepsCount",
        "definitionsCount",
        "goalsCount", "unresolvedGoalsCount", "validSelectionsCount", "normalizedFindingsCount",
        "completedSteps",
        "textChars", "valueCount",
        "hasPaths",
        "hasValue",
    ] {
        if data[key].is_boolean() || data[key].as_u64().is_some() {
            projected["data"][key] = data[key].clone();
        }
    }
    projected
}

fn object_args(value: &Value) -> Value {
    let mut projected = json!({});
    for key in ["query", "path", "name", "kind", "id"] {
        if let Some(s) = value[key].as_str() {
            projected[key] = clipped(s, 100).0.into();
        }
    }
    projected
}
fn action(tool: &str) -> &str {
    match tool {
        "search_original" => "检索原著",
        "read_original" => "阅读原著",
        "read_canon_facts" => "核对原著资料",
        "search_resources" => "搜索本局资料",
        "read_resource" | "read_world" | "read_story_resources" => "读取本局资料",
        "list_resources" => "查看资料目录",
        "read_skill" => "读取技能",
        "list_skills" => "查看技能目录",
        "read_skill_resource" => "读取技能资料",
        "stage_edit" => "调整本局资料",
        "stage_story_turn" => "准备正式剧情",
        "stage_route" => "准备路线",
        "stage_clock" => "调整时间",
        "read_clock" => "读取时间",
        "read_commit_receipt" => "读取采用回执",
        "read_committed_snapshot" => "核对正式快照",
        "read_timeline" => "批量读取本局时间线",
        "read_evidence" => "读取核对依据",
        "read_fact_sources" => "读取正式事实来源",
        "finish_task" => "保存修改",
        "validate_changes" => "预演修改",
        "check_draft" => "核对草稿依据",
        "record_findings" => "保存核对结果",
        "search_agent_history" => "检索助手对话",
        "read_agent_history" => "回顾助手对话",
        "read_player_choices" => "核对玩家原始要求",
        "read_continuity" => "查阅人物知情与线索",
        "read_tool_result" => "回读工具结果",
        "update_plan" => "更新任务计划",
        "read_plan" => "查看任务计划",
        "discover_tools" => "加载工具",
        "run_script" => "运行受控脚本",
        "web_search" => "联网搜索",
        "read_webpage" => "读取网页",
        "browser_open"=>"打开资料网页","browser_read"=>"读取网页正文","browser_find"=>"查找网页内容","browser_follow"=>"阅读网页链接","browser_close"=>"关闭资料网页",
        "list_documents"=>"查看资料文件","read_document"=>"读取资料文件","find_document"=>"查找资料文件","write_document"=>"写出资料笔记","call_tool_package"=>"运行工具包","draft_tool_package"=>"准备工具包草稿",
        "delegate_readonly" => "分派只读查证",
        "call_remote_tool" => "调用外部工具",
        _ => "调用工具",
    }
}
fn object(step: &Step, data: &Value) -> String {
    let args = &step.args;
    let label = if !text(args, "query").is_empty() {
        text(args, "query")
    } else if !text(data, "title").is_empty() {
        text(data, "title")
    } else if !text(data, "name").is_empty() {
        text(data, "name")
    } else if step.name == "stage_edit" && !text(args,"summary").is_empty() {
        text(args,"summary")
    } else if !text(args, "path").is_empty() {
        text(args, "path")
    } else if !text(args, "name").is_empty() {
        text(args, "name")
    } else if !text(args, "kind").is_empty() {
        match text(args, "kind") {
            "settings" => "世界设定",
            "state" => "当前状态",
            "node" => "历史剧情",
            "protagonist" => "主角",
            "book" => "参考书籍",
            "people" => "人物",
            "places" => "地点",
            "cards" => "设定集",
            "goals" => "目标",
            "facts" => "事实与记忆",
            other => other,
        }
    } else if !text(args, "id").is_empty() {
        text(args, "id")
    } else {
        ""
    };
    clipped(label, 100).0
}
fn outcome(step: &Step) -> (&'static str, &'static str, String) {
    if step.ledger_status == "unknown" || step.result["outcomeUnknown"] == true {
        return ("unknown", "unknown", "操作结果未知，须先核对".into());
    }
    if step.result["ok"] == false {
        if ["cancelled", "aborted"].contains(&text(&step.result["error"], "code")) {
            return ("cancelled", "cancelled", "已停止，未确认完成".into());
        }
        let message = clipped(text(&step.result["error"], "message"), 180).0;
        return (
            "failed",
            "failed",
            if message.is_empty() {
                "执行失败".into()
            } else {
                message
            },
        );
    }
    if step.result["ok"] != true {
        if step.cancelled {
            return ("cancelled", "cancelled", "已停止，未确认完成".into());
        }
        if step.error {
            return ("failed", "failed", "执行失败".into());
        }
        if step.ended || step.ledger_status == "done" {
            return (
                "unknown",
                "unconfirmed",
                "调用已结束，业务结果待核对".into(),
            );
        }
        return ("running", "running", "正在执行".into());
    }
    let data = &step.result["data"];
    if data["status"] == "committed" || data["worldChanged"] == true {
        let count = data["changesCount"].as_u64();
        return (
            "completed",
            "committed",
            (count
                .map(|n| format!("已采用{n}项修改"))
                .unwrap_or_else(|| "修改已正式采用".into())) + if data["goalStatus"]=="partial"||data["goalStatus"]=="blocked" {"，仍有目标未完成"}else{""},
        );
    }
    if data["status"] == "previewed" {
        return ("completed", "preview", "修改预览已准备，尚未采用".into());
    }
    if data["status"] == "blocked" {
        return ("completed", "blocked", "仍有问题受阻，草稿已保留".into());
    }
    if step.name=="record_findings" {
        let unfinished=data["unresolvedGoalsCount"].as_u64().unwrap_or(0);
        return ("completed", "findings", format!("已保存核对结果，{unfinished}项目标仍待处理"));
    }
    if data["staged"] == true {
        return ("completed", "draft", "草稿已准备，尚未采用".into());
    }
    if data["reused"] == true {
        return ("completed", "reused", "已复用保存的结果".into());
    }
    if data["status"]=="answered" {
        return ("completed", "answered", if data["goalStatus"]=="partial"||data["goalStatus"]=="blocked" {"已答复，仍有目标未完成"}else{"已答复，本局未改变"}.into());
    }
    if data["changed"] == false {
        return ("completed", "no_change", "无需修改，本局未改变".into());
    }
    if data["status"] == "insufficient" {
        if data["reason"] == "no_match" {
            return ("completed", "no_match", "未找到匹配的原文，尚未核实".into());
        }
        return ("completed", "insufficient", "资料不足，尚未核实".into());
    }
    if data["isError"] == true {
        return ("failed", "failed", "工具返回业务错误".into());
    }
    for (field, label, kind) in [
        ("matches", "找到", "found"),
        (
            "excerpts",
            if step.name == "search_original" {
                "找到"
            } else {
                "已读取"
            },
            "read",
        ),
        ("resources", "列出", "listed"),
    ] {
        if let Some(count) = data[format!("{field}Count")].as_u64() {
            return if count == 0 {
                ("completed", "no_match", "没有找到符合条件的资料".into())
            } else {
                (
                    "completed",
                    kind,
                    format!(
                        "{label}{count}{}",
                        if field == "excerpts" {
                            "段原文"
                        } else {
                            "项资料"
                        }
                    ),
                )
            };
        }
    }
    if step.name == "read_skill" && data["bodyRead"] == false {
        return ("completed", "located", "技能已定位，正文待分页读取".into());
    }
    if step.name == "read_skill" {
        return (
            "completed",
            "read",
            "技能说明已读取，执行仍须按方法进行".into(),
        );
    }
    if step.name == "check_draft" {
        return (
            "completed",
            "evidence",
            "已返回证据定位，事实仍须核对".into(),
        );
    }
    if let Some(count)=data["valueCount"].as_u64(){return ("completed","read",format!("已返回{count}项实际资料"));}
    if let Some(count) = data["textChars"].as_u64() {
        return (
            "completed",
            "read",
            if count > MAX_TEXT_CHARS as u64 {
                format!("已读取超过{MAX_TEXT_CHARS}字")
            } else {
                format!("已读取{count}字")
            },
        );
    }
    if let Some(count) = data["stepsCount"].as_u64() {
        return (
            "completed",
            "plan",
            format!(
                "计划已更新，{}/{count}步已完成",
                data["completedSteps"].as_u64().unwrap_or(0)
            ),
        );
    }
    if let Some(count) = data["definitionsCount"].as_u64() {
        return ("completed", "loaded", format!("已加载{count}项工具"));
    }
    if data["hasPaths"] == true && data["hasValue"] != true {
        return (
            "completed",
            "located",
            "已返回字段定位，正文待按需读取".into(),
        );
    }
    ("completed", "executed", "已取得结果".into())
}

/// Calls are raw or decoded pi_calls rows. Ledger business results take
/// precedence over a generic Pi tool-end success flag. Start/update/end/retry
/// records collapse to a single row per call identifier.
pub fn steps(events: &[Value], calls: &[Value]) -> Vec<Value> {
    let mut all: BTreeMap<String, Step> = BTreeMap::new();
    for (seq, record) in ordered(events) {
        let e = event(record);
        let kind = text(e, "type");
        if ![
            "tool_execution_start",
            "tool_execution_update",
            "tool_execution_end",
        ]
        .contains(&kind)
        {
            continue;
        }
        let raw_id = text(e, "toolCallId");
        if raw_id.is_empty() {
            continue;
        }
        let id = identity(raw_id);
        if all.len() >= MAX_CALLS && !all.contains_key(&id) {
            continue;
        }
        let step = all.entry(id.clone()).or_insert_with(|| Step {
            id,
            task: text(envelope(record), "taskId").into(),
            name: text(e, "toolName").into(),
            args: Value::Null,
            result: Value::Null,
            seq,
            starts: 0,
            ended: false,
            error: false,
            cancelled: false,
            duration: Value::Null,
            ledger_status: String::new(),
            limited: false,
            call_limited: raw_id.len() > 512,
            child: field(envelope(record), "childId", "child_id").into(),
            parent: field(envelope(record), "parentCallId", "parent_call_id").into(),
        });
        if step.child.is_empty() {
            step.child = field(e, "childId", "child_id").into();
        }
        if step.parent.is_empty() {
            step.parent = field(e, "parentCallId", "parentToolCallId").into();
        }
        if e["args"].is_object() {
            step.args = object_args(&e["args"]);
        }
        if !text(e, "toolName").is_empty() {
            step.name = text(e, "toolName").into();
        }
        if kind == "tool_execution_start" {
            step.starts += 1;
        }
        if kind == "tool_execution_end" {
            step.ended = true;
            step.error = e["isError"] == true;
            step.duration = e["durationMs"].clone();
            step.result = business(&e["result"]);
        }
    }
    for call in calls.iter().rev().take(MAX_CALLS) {
        let raw_id = field(call, "call_id", "callId");
        if raw_id.is_empty() {
            continue;
        }
        let id = identity(raw_id);
        if all.len() >= MAX_CALLS && !all.contains_key(&id) {
            continue;
        }
        let step = all.entry(id.clone()).or_insert_with(|| Step {
            id,
            task: field(call, "task_id", "taskId").into(),
            name: field(call, "tool", "toolName").into(),
            args: Value::Null,
            result: Value::Null,
            seq: call["seq"].as_u64().unwrap_or(u64::MAX),
            starts: 0,
            ended: false,
            error: false,
            cancelled: false,
            duration: Value::Null,
            ledger_status: String::new(),
            limited: false,
            call_limited: raw_id.len() > 512,
            child: field(call, "child_id", "childId").into(),
            parent: field(call, "parent_call_id", "parentCallId").into(),
        });
        if step.child.is_empty() {
            step.child = field(call, "child_id", "childId").into();
        }
        if step.parent.is_empty() {
            step.parent = field(call, "parent_call_id", "parentCallId").into();
        }
        let raw = call
            .get("output_json")
            .or_else(|| call.get("output"))
            .unwrap_or(&Value::Null);
        let result = if raw.is_string() {
            business(&parsed(raw))
        } else {
            business(raw)
        };
        if !result.is_null() {
            step.result = result;
        }
        step.limited = raw.as_str().is_some_and(|s| s.len() > MAX_RESULT_BYTES);
        step.ledger_status = text(call, "status").into();
        if step.name.is_empty() {
            step.name = field(call, "tool", "toolName").into();
        }
        if step.task.is_empty() {
            step.task = field(call, "task_id", "taskId").into();
        }
        step.cancelled = step.ledger_status == "cancelled";
    }
    let mut rows=all.values().map(|step| {
        let (status,kind,result)=outcome(step);
        let action=action(&step.name);
        let object=object(step,&step.result["data"]);
        json!({"id":format!("pi-step:{}:{}",step.task,step.id),"callId":step.id,"taskId":step.task,"childId":if step.child.is_empty(){Value::Null}else{json!(step.child)},"parentCallId":if step.parent.is_empty(){Value::Null}else{json!(step.parent)},"tool":step.name,"kind":step.name,"action":action,"object":object,"status":status,"outcome":kind,"summary":if object.is_empty(){format!("{action}：{result}")}else{format!("{action} · {object}：{result}")},"resultText":result,"seq":step.seq,"attempts":step.starts.max(1),"durationMs":step.duration,"truncated":step.limited||step.call_limited,"deliveryFailed":step.error&&step.result["ok"]==true,"read":if step.call_limited{Value::Null}else{json!({"callId":step.id,"path":"","offset":0,"limit":1200})}})
    }).collect::<Vec<_>>();
    rows.sort_by_key(|s| s["seq"].as_u64().unwrap_or(u64::MAX));
    rows
}
