//! Readable Pi history only. This is not a Pi session or executable import.
//!
//! The caller owns one read-only transaction covering the whole world export.
//! This module neither opens its own snapshot nor writes any Agent tables.
use crate::{agent_workspace as ws, pi_projection as projection, Error, Result};
use rusqlite::Connection;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

pub const READABLE_VERSION: u64 = 1;
const MAX_SESSIONS: usize = 10_000;
const MAX_TASKS: usize = 20_000;
const MAX_FIELD: usize = 16_000;
const MAX_JSON_BYTES: usize = 512 * 1024;
const FINISHED: &[&str] = &["completed", "committed", "undone", "archived"];

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn text<'a>(raw: &'a Value, key: &str) -> &'a str {
    raw[key].as_str().unwrap_or("")
}
fn parsed(value: &Value) -> Value {
    if let Some(value) = value.as_str() {
        serde_json::from_str(value).unwrap_or(Value::Null)
    } else {
        value.clone()
    }
}
fn strings(raw: &Value, keys: &[&str], maximum: usize) -> Value {
    let mut clean = Map::new();
    for key in keys {
        if let Some(value) = raw[*key].as_str() {
            clean.insert(
                (*key).into(),
                value.chars().take(maximum).collect::<String>().into(),
            );
        }
    }
    Value::Object(clean)
}
fn scalar_fields(raw: &Value, clean: &mut Value, keys: &[&str]) {
    for key in keys {
        if raw[*key].is_boolean() || raw[*key].as_u64().is_some() {
            clean[*key] = raw[*key].clone();
        }
    }
}
fn required(raw: &Value, key: &str, maximum: usize) -> Result<String> {
    raw[key]
        .as_str()
        .filter(|value| !value.is_empty() && value.chars().count() <= maximum)
        .map(str::to_owned)
        .ok_or_else(|| invalid("助手只读历史字段无效或过长"))
}
fn array<'a>(raw: &'a Value, key: &str, maximum: usize) -> Result<&'a Vec<Value>> {
    raw[key]
        .as_array()
        .filter(|items| items.len() <= maximum)
        .ok_or_else(|| invalid("助手只读历史列表无效或过长"))
}
fn readable_url(raw: &str) -> Option<String> {
    if raw.len() > 8192 || raw.chars().any(char::is_control) {
        return None;
    }
    let (scheme, rest) = raw.split_once("://")?;
    if !["http", "https"].contains(&scheme.to_ascii_lowercase().as_str()) {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains(['@', '%', '\\']) {
        return None;
    }
    let no_fragment = raw.split('#').next()?;
    let Some((base, query)) = no_fragment.split_once('?') else {
        return Some(no_fragment.into());
    };
    let query = query
        .split('&')
        .filter(|part| {
            let key = part.split('=').next().unwrap_or("").to_ascii_lowercase();
            // Encoded names are not useful for a readable citation and may hide
            // a credential parameter. Never preserve such names in an archive.
            !key.contains('%')
                && !["key", "apikey", "auth", "sig"].contains(&key.as_str())
                && ![
                    "token",
                    "secret",
                    "password",
                    "signature",
                    "credential",
                    "authorization",
                ]
                .iter()
                .any(|part| key.contains(part))
                && !key.ends_with("_key")
                && !key.starts_with("x-amz-")
                && !key.starts_with("x-goog-")
        })
        .collect::<Vec<_>>()
        .join("&");
    Some(if query.is_empty() {
        base.into()
    } else {
        format!("{base}?{query}")
    })
}
fn sources(raw: &Value) -> Vec<Value> {
    raw.as_array()
        .into_iter()
        .flatten()
        .take(100)
        .filter(|item| item.is_object())
        .map(|item| {
            let mut clean = strings(item, &["title", "bookId", "worldId", "originWorldId", "originTitle", "nodeId", "lineId", "quote", "sourceKind", "basis", "playerReferenceId", "scope"], MAX_FIELD);
            if clean.get("quote").is_none() {
                if let Some(value) = item["text"].as_str() {
                    clean["quote"] = value.chars().take(MAX_FIELD).collect::<String>().into();
                }
            }
            for key in ["section", "page", "chunk", "start", "end", "offset"] {
                if item[key].as_u64().is_some() {
                    clean[key] = item[key].clone();
                }
            }
            if let Some(url) = item["url"].as_str().and_then(readable_url) {
                clean["url"] = url.into();
            }
            clean
        })
        .filter(|item| !item.as_object().unwrap().is_empty())
        .collect()
}
pub(crate) fn formal_source(raw:&Value)->Value {
    let mut clean=strings(raw,&["findingId","goalId","topic","groupId","basis","title","quote","text","bookId","worldId","originWorldId","originTitle","sourceKind","scope","playerReferenceId","evidenceId","subject","value","sourceClaim","contentHash","readAt"],MAX_FIELD);
    for key in ["page","section","chunk","offset","start","end","quoteOffset"] {if raw[key].as_u64().is_some(){clean[key]=raw[key].clone();}}
    if raw["location"].is_object(){let mut location=strings(&raw["location"],&["bookId","nodeId","lineId","worldId","originWorldId","originTitle","title","path","offsetUnit","contentHash","readAt"],MAX_FIELD);for key in ["page","section","chunk","offset","start","end"]{if raw["location"][key].as_u64().is_some(){location[key]=raw["location"][key].clone();}}if let Some(url)=raw["location"]["url"].as_str().and_then(readable_url){location["url"]=url.into();}clean["location"]=location;}
    if raw["revisionDecision"].is_object(){let mut decision=strings(&raw["revisionDecision"],&["summary","reason","appliesTo"],MAX_FIELD);if let Some(refs)=raw["revisionDecision"]["localReferences"].as_array(){decision["localReferences"]=json!(refs.iter().take(12).map(formal_source).collect::<Vec<_>>());}clean["revisionDecision"]=decision;}
    if raw["declaration"].is_object(){clean["declaration"]=strings(&raw["declaration"],&["subject","value","scope"],MAX_FIELD);}
    if let Some(items)=raw["references"].as_array(){clean["references"]=json!(items.iter().take(100).map(formal_source).collect::<Vec<_>>());}
    if let Some(url)=raw["url"].as_str().and_then(readable_url){clean["url"]=url.into();}
    clean["interpretationVerified"]=false.into();clean
}
fn result(raw: &Value) -> Value {
    let mut clean = strings(raw, &["status", "summary", "goalStatus"], MAX_FIELD);
    scalar_fields(raw, &mut clean, &["changed", "worldChanged", "goalCompleted"]);
    if let Some(changes) = raw["changes"].as_array() {
        clean["changes"] = changes
            .iter()
            .take(1000)
            .map(|change| strings(change, &["kind", "id", "summary"], MAX_FIELD))
            .collect::<Vec<_>>()
            .into();
    }
    for key in ["goals", "goalResults"] {
        if let Some(goals) = raw[key].as_array() {
            clean[key] = goals
                .iter()
                .take(1000)
                .map(|source| {
                    let mut goal = strings(
                        source,
                        &["id", "title", "status", "summary", "reason"],
                        MAX_FIELD,
                    );
                    goal["sources"] = sources(&source["sources"]).into();
                    goal
                })
                .collect::<Vec<_>>()
                .into();
        }
    }
    if raw["goalResult"].is_object() {
        let report=&raw["goalResult"];
        let goals=report["goals"].as_array().into_iter().flatten().take(64)
            .map(|goal|strings(goal,&["id","status","summary"],MAX_FIELD)).collect::<Vec<_>>();
        let mut citations=vec![];
        for finding in report["normalizedFindings"].as_array().into_iter().flatten().take(256) {
            for reference in finding["references"].as_array().into_iter().flatten().take(12) {
                let mut source=reference["location"].as_object().cloned().unwrap_or_default();
                for key in ["quote","sourceKind","playerReferenceId","scope"] {
                    if reference[key].is_string(){source.insert(key.into(),reference[key].clone());}
                }
                source.insert("basis".into(),finding["basis"].clone());
                citations.push(Value::Object(source));
            }
        }
        // A re-imported summary has already lost its executable report. Keep
        // that readable summary and its sources without recreating authority.
        citations.extend(report["sources"].as_array().into_iter().flatten().cloned());
        clean["goalResult"]=json!({"status":text(report,"status").chars().take(40).collect::<String>(),"goals":goals,"sources":sources(&json!(citations)),"interpretationVerified":false});
    }
    clean
}
fn history(raw: &Value) -> Result<Value> {
    let mut clean = json!({"messages":[],"steps":[],"plan":[],"sources":[],"result":{}});
    let mut message_ids = HashSet::new();
    for item in array(raw, "messages", projection::MAX_MESSAGES)? {
        let id = required(item, "id", 1024)?;
        if !message_ids.insert(id) || !["user", "assistant"].contains(&text(item, "role")) {
            return Err(invalid("助手只读对话记录无效"));
        }
        required(item, "content", MAX_FIELD)?;
        let mut message = strings(item, &["id", "role", "content", "createdAt"], MAX_FIELD);
        if message.get("createdAt").is_none() {
            if let Some(at) = item["at"].as_str() {
                message["createdAt"] = at.chars().take(MAX_FIELD).collect::<String>().into();
            }
        }
        scalar_fields(item, &mut message, &["seq", "truncated"]);
        clean["messages"].as_array_mut().unwrap().push(message);
    }
    for item in array(raw, "steps", projection::MAX_CALLS)? {
        required(item, "id", 1024)?;
        if !["running", "completed", "failed", "cancelled", "unknown"]
            .contains(&text(item, "status"))
        {
            return Err(invalid("助手只读过程状态无效"));
        }
        let mut step = strings(
            item,
            &[
                "id",
                "tool",
                "action",
                "object",
                "status",
                "outcome",
                "summary",
                "resultText",
            ],
            MAX_FIELD,
        );
        scalar_fields(
            item,
            &mut step,
            &[
                "seq",
                "attempts",
                "durationMs",
                "truncated",
                "deliveryFailed",
            ],
        );
        clean["steps"].as_array_mut().unwrap().push(step);
    }
    for item in array(raw, "plan", 1000)? {
        let title = item
            .get("title")
            .or_else(|| item.get("step"))
            .or_else(|| item.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if title.is_empty()
            || title.chars().count() > MAX_FIELD
            || ![
                "pending",
                "in_progress",
                "completed",
                "cancelled",
                "blocked",
                "done",
            ]
            .contains(&text(item, "status"))
        {
            return Err(invalid("助手只读任务计划无效"));
        }
        let mut plan = strings(item, &["id", "status"], 512);
        plan["title"] = title.into();
        clean["plan"].as_array_mut().unwrap().push(plan);
    }
    clean["sources"] = sources(&raw["sources"]).into();
    clean["result"] = result(&raw["result"]);
    clean["truncated"] = (raw["truncated"] == true).into();
    Ok(clean)
}

/// Validate references and rebuild the read-only whitelist. Extra fields such
/// as session files, model credentials, drafts and raw events are discarded.
/// The result must be stored as dedicated history, never replayed as a session.
pub fn validate_readable(raw: &Value, world: &str, line_ids: &[String]) -> Result<Value> {
    if raw["engine"] != "pi"
        || raw["version"].as_u64() != Some(READABLE_VERSION)
        || raw["readOnly"] != true
    {
        return Err(invalid("不是有效的Pi只读历史"));
    }
    let lines: HashSet<_> = line_ids.iter().map(String::as_str).collect();
    let fallback_line = line_ids.first().map(String::as_str);
    let mut session_ids = HashSet::new();
    let mut sequel_sessions = HashSet::new();
    let mut task_ids = HashSet::new();
    let mut clean =
        json!({"engine":"pi","version":READABLE_VERSION,"readOnly":true,"sessions":[],"tasks":[]});
    for item in array(raw, "sessions", MAX_SESSIONS)? {
        let id = required(item, "id", 512)?;
        let session_world = text(item, "worldId");
        let origin_world = text(item, "originWorldId");
        let is_sequel = !origin_world.is_empty() && (session_world == world || session_world == origin_world);
        let line_ok = lines.contains(text(item, "lineId")) || (is_sequel && fallback_line.is_some());
        if !session_ids.insert(id.clone()) || (!is_sequel && session_world != world) || !line_ok {
            return Err(invalid("助手只读会话不属于本局或路线"));
        }
        if is_sequel {
            sequel_sessions.insert(id);
        }
        required(item, "title", MAX_FIELD)?;
        let mut session = strings(
            item,
            &["id", "worldId", "originWorldId", "originTitle", "lineId", "title", "createdAt", "updatedAt"],
            MAX_FIELD,
        );
        session["worldId"] = world.into();
        if !lines.contains(text(item, "lineId")) {
            if let Some(fallback) = fallback_line {
                session["lineId"] = fallback.into();
            }
        }
        clean["sessions"].as_array_mut().unwrap().push(session);
    }
    for item in array(raw, "tasks", MAX_TASKS)? {
        let id = required(item, "id", 512)?;
        let session_id = text(item, "sessionId");
        if !task_ids.insert(id)
            || !session_ids.contains(session_id)
            || !FINISHED.contains(&text(item, "status"))
            || !["auto-reversible", "preview", "auto"].contains(&text(item, "policy"))
        {
            return Err(invalid("助手只读任务引用或状态无效"));
        }
        let task_origin = text(item, "originWorldId");
        let is_sequel = sequel_sessions.contains(session_id) || !task_origin.is_empty();
        if let Some(task_world) = item["worldId"].as_str().filter(|w| !w.is_empty()) {
            if task_world != world && (!is_sequel || (!task_origin.is_empty() && task_world != task_origin)) {
                return Err(invalid("助手只读任务不属于本局路线"));
            }
        }
        let mut task = strings(
            item,
            &[
                "id",
                "sessionId",
                "worldId",
                "originWorldId",
                "originTitle",
                "lineId",
                "text",
                "status",
                "policy",
                "createdAt",
                "updatedAt",
            ],
            MAX_FIELD,
        );
        if task.get("worldId").is_some() {
            task["worldId"] = world.into();
        }
        if let Some(line_id) = item["lineId"].as_str() {
            if !lines.contains(line_id) {
                if is_sequel {
                    task.as_object_mut().unwrap().remove("lineId");
                } else {
                    return Err(invalid("助手只读任务不属于本局路线"));
                }
            }
        }
        task["history"] = history(&item["history"])?;
        clean["tasks"].as_array_mut().unwrap().push(task);
    }
    Ok(clean)
}

/// Requires the caller's existing read-only world snapshot. Opening a second
/// transaction here would not make separately exported story rows consistent.
pub fn export_readable(db: &Connection, world: &str) -> Result<Value> {
    if db.is_autocommit()
        || !(db.is_readonly("main")?
            || db.pragma_query_value(None, "query_only", |row| row.get::<_, bool>(0))?)
    {
        return Err(invalid("助手历史导出须在调用方的同一只读存档事务中进行"));
    }
    if db.query_row("SELECT COUNT(*) FROM worlds WHERE id=?", [world], |row| {
        row.get::<_, i64>(0)
    })? != 1
    {
        return Err(invalid("要导出的故事不存在"));
    }
    let lines = ws::rows(db, "SELECT id FROM lines WHERE world_id=?", &[&world])?
        .into_iter()
        .map(|row| text(&row, "id").to_owned())
        .collect::<Vec<_>>();
    let fallback_line: Option<String> = db
        .query_row("SELECT current_line_id FROM worlds WHERE id=?", [world], |row| {
            row.get::<_, Option<String>>(0)
        })
        .ok()
        .flatten()
        .filter(|id| lines.iter().any(|line| line == id))
        .or_else(|| lines.first().cloned());
    let mut sessions=ws::rows(db,"SELECT id,world_id AS worldId,line_id AS lineId,title,created_at AS createdAt,updated_at AS updatedAt FROM pi_sessions WHERE world_id=? AND (EXISTS(SELECT 1 FROM pi_tasks t WHERE t.session_id=pi_sessions.id AND t.status IN ('completed','committed','undone','archived') AND CASE WHEN json_valid(t.metadata_json) THEN COALESCE(json_extract(t.metadata_json,'$._nativeHostActive'),0)=0 ELSE 0 END) OR EXISTS(SELECT 1 FROM pi_session_messages m WHERE m.session_id=pi_sessions.id)) ORDER BY created_at,id",&[&world])?;
    for session in &mut sessions {
        if !lines.iter().any(|line| line == text(session, "lineId")) {
            if let Some(fallback) = &fallback_line {
                session["lineId"] = fallback.clone().into();
            }
        }
    }
    let mut tasks = vec![];
    for session in &sessions {
        let id = text(session, "id");
        let mut inherited=ws::rows(db,"SELECT substr(message_json,1,524289) AS message_json FROM (SELECT seq,message_json FROM pi_session_messages WHERE session_id=? ORDER BY seq DESC LIMIT 501) ORDER BY seq DESC",&[&id])?;
        if !inherited.is_empty() {
            let mut truncated=inherited.len()>projection::MAX_MESSAGES;
            inherited.truncate(projection::MAX_MESSAGES);inherited.reverse();
            let messages=inherited.into_iter().filter_map(|row| {
                if text(&row,"message_json").len()>MAX_JSON_BYTES {truncated=true;return None;}
                let item=parsed(&row["message_json"]);
                if !["user","assistant"].contains(&text(&item,"role")) || text(&item,"content").trim().is_empty(){truncated=true;return None;}
                let mut message=strings(&item,&["id","role","content","createdAt"],MAX_FIELD);
                let cut=text(&item,"content").chars().count()>MAX_FIELD || item["truncated"]==true;
                truncated|=cut;message["truncated"]=cut.into();
                Some(message)
            }).collect::<Vec<_>>();
            let readable=history(&json!({"messages":messages,"steps":[],"plan":[],"sources":[],"result":{"status":"inherited","summary":"另起对话时保留的记录；故事修改并未撤回。"},"truncated":truncated}))?;
            tasks.push(json!({"id":format!("history:{id}"),"sessionId":id,"text":"另起对话时保留的记录","status":"archived","policy":"auto","createdAt":session["createdAt"],"updatedAt":session["createdAt"],"history":readable}));
        }
        for row in ws::rows(db,"SELECT id,session_id,world_id,line_id,text,status,policy,plan_json,result_json,created_at,updated_at FROM pi_tasks WHERE session_id=? AND status IN ('completed','committed','undone','archived') AND CASE WHEN json_valid(metadata_json) THEN COALESCE(json_extract(metadata_json,'$._nativeHostActive'),0)=0 ELSE 0 END ORDER BY created_at,id",&[&id])? {
            // Adoption/undo moves the live conversation to the resulting line.
            // Earlier finished tasks retain their original line if it still exists,
            // or degrade to None if undo_recovery purged that temporary branch (B27).
            if text(&row,"world_id")!=world {return Err(invalid("助手任务属于其他故事或路线"));}
            let valid_line = lines.iter().any(|line| line == text(&row, "line_id"));
            let task=text(&row,"id");
            let stored_result=parsed(&row["result_json"]);
            if row["status"]=="archived" && stored_result["history"].is_object() {
                // Dedicated imported history is readable data, never a Pi
                // file or event replay. Re-export it through the same whitelist.
                let readable=history(&stored_result["history"])?;
                let mut exported = json!({"id":row["id"],"sessionId":row["session_id"],"text":row["text"],"status":row["status"],"policy":row["policy"],"createdAt":row["created_at"],"updatedAt":row["updated_at"],"history":readable});
                if valid_line { exported["lineId"] = row["line_id"].clone(); }
                tasks.push(exported);
                continue;
            }
            let mut event_rows=ws::rows(db,"SELECT seq,substr(event_json,1,524289) AS event_json FROM pi_events WHERE task_id=? ORDER BY seq DESC LIMIT 20001",&[&task])?;
            let mut truncated=event_rows.len()>projection::MAX_EVENTS;
            event_rows.truncate(projection::MAX_EVENTS);event_rows.reverse();
            let events=event_rows.into_iter().filter_map(|row| {
                if text(&row,"event_json").len()>MAX_JSON_BYTES {truncated=true;return None;}
                let value=parsed(&row["event_json"]);if !value.is_object(){truncated=true;return None;}
                Some(json!({"seq":row["seq"],"event":value}))
            }).collect::<Vec<_>>();
            let mut inputs=ws::rows(db,"SELECT id,task_id,content_json,delivery,status,created_at FROM pi_inputs WHERE task_id=? AND status='delivered' ORDER BY seq DESC LIMIT 501",&[&task])?;
            truncated|=inputs.len()>projection::MAX_MESSAGES;inputs.truncate(projection::MAX_MESSAGES);inputs.reverse();
            let mut call_rows=ws::rows(db,"SELECT call_id,task_id,tool,status,substr(output_json,1,524289) AS output_json FROM pi_calls WHERE task_id=? ORDER BY rowid DESC LIMIT 1001",&[&task])?;
            truncated|=call_rows.len()>projection::MAX_CALLS;call_rows.truncate(projection::MAX_CALLS);call_rows.reverse();
            let mut source_refs=sources(&parsed(&row["result_json"])["sources"]);
            for call in &mut call_rows {
                let output=parsed(&call["output_json"]);
                if text(call,"output_json").len()>MAX_JSON_BYTES {truncated=true;}
                source_refs.extend(sources(&output["data"]["sources"]));
                source_refs.extend(sources(&output["data"]["citations"]));
                source_refs.extend(sources(&output["data"]["excerpts"]));
                call["output_json"]=projection::summary_result(&output);
            }
            let mut seen_sources=HashSet::new();source_refs.retain(|source|seen_sources.insert(source.to_string()));
            truncated|=source_refs.len()>100;
            let messages=projection::messages(&row,&events,&inputs).into_iter().filter(|message|!text(message,"content").is_empty()).collect::<Vec<_>>();
            truncated|=messages.iter().any(|message|message["truncated"]==true);
            let readable=history(&json!({"messages":messages,"steps":projection::steps(&events,&call_rows),"plan":parsed(&row["plan_json"]),"sources":source_refs,"result":parsed(&row["result_json"]),"truncated":truncated}))?;
            let mut exported = json!({"id":row["id"],"sessionId":row["session_id"],"text":row["text"],"status":row["status"],"policy":row["policy"],"createdAt":row["created_at"],"updatedAt":row["updated_at"],"history":readable});
            if valid_line { exported["lineId"] = row["line_id"].clone(); }
            tasks.push(exported);
        }
    }
    validate_readable(
        &json!({"engine":"pi","version":READABLE_VERSION,"readOnly":true,"sessions":sessions,"tasks":tasks}),
        world,
        &lines,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::TransactionBehavior;

    #[test]
    fn sequel_origin_world_id_and_message_timestamps_survive_validation_while_foreign_injection_fails() {
        let cleaned_source = formal_source(&json!({
            "findingId": "f1",
            "worldId": "sequel-w",
            "originWorldId": "prequel-w",
            "originTitle": "前作长安",
            "quote": "前作札记原句",
            "apiKey": "secret-leak",
            "location": {
                "worldId": "prequel-w",
                "originWorldId": "prequel-w",
                "originTitle": "前作长安",
                "nodeId": "n-old",
                "lineId": "l-old",
                "url": "https://example.invalid/doc?id=1&token=secret#frag"
            }
        }));
        assert_eq!(cleaned_source["originWorldId"], "prequel-w");
        assert_eq!(cleaned_source["originTitle"], "前作长安");
        assert_eq!(cleaned_source["location"]["originWorldId"], "prequel-w");
        assert_eq!(cleaned_source["location"]["url"], "https://example.invalid/doc?id=1");
        assert!(!cleaned_source.to_string().contains("secret"));

        let sequel_archive = json!({
            "engine": "pi",
            "version": 1,
            "readOnly": true,
            "sessions": [{
                "id": "s-seq",
                "worldId": "prequel-w",
                "originWorldId": "prequel-w",
                "originTitle": "前作长安",
                "lineId": "prequel-line",
                "title": "前作整理",
                "createdAt": "2026-11-23T08:00:00Z",
                "updatedAt": "2026-11-23T08:05:00Z"
            }],
            "tasks": [{
                "id": "t-seq",
                "sessionId": "s-seq",
                "worldId": "prequel-w",
                "originWorldId": "prequel-w",
                "lineId": "prequel-line",
                "text": "整理前作人物",
                "status": "archived",
                "policy": "auto",
                "createdAt": "2026-11-23T08:00:00Z",
                "updatedAt": "2026-11-23T08:05:00Z",
                "history": {
                    "messages": [
                        {"id": "m1", "role": "user", "content": "整理", "at": "2026-11-23T08:00:01Z"},
                        {"id": "m2", "role": "assistant", "content": "已整理", "createdAt": "2026-11-23T08:00:09Z"}
                    ],
                    "steps": [],
                    "plan": [],
                    "sources": [{"title": "前作", "originWorldId": "prequel-w", "quote": "旧事"}],
                    "result": {"status": "committed", "summary": "完成"}
                }
            }]
        });
        let valid = validate_readable(&sequel_archive, "sequel-w", &["main-line".to_owned()]).unwrap();
        assert_eq!(valid["sessions"][0]["worldId"], "sequel-w");
        assert_eq!(valid["sessions"][0]["originWorldId"], "prequel-w");
        assert_eq!(valid["sessions"][0]["lineId"], "main-line");
        assert!(valid["tasks"][0].get("lineId").is_none());
        assert_eq!(valid["tasks"][0]["history"]["messages"][0]["createdAt"], "2026-11-23T08:00:01Z");
        assert_eq!(valid["tasks"][0]["history"]["messages"][1]["createdAt"], "2026-11-23T08:00:09Z");
        assert_eq!(valid["tasks"][0]["history"]["sources"][0]["originWorldId"], "prequel-w");

        // Without originWorldId, foreign worldId or foreign lineId is still rejected.
        let mut foreign = sequel_archive.clone();
        foreign["sessions"][0].as_object_mut().unwrap().remove("originWorldId");
        assert!(validate_readable(&foreign, "sequel-w", &["main-line".to_owned()]).is_err());
    }

    #[test]
    fn export_readable_degrades_dangling_line_ids_instead_of_blocking_world_backup() {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migration::migrate(&mut db, None).unwrap();
        db.execute_batch(
            "INSERT INTO worlds(id,title,era_id,created_at,updated_at,played_at) VALUES('w','长安','free','t','t','t');
             INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n','w',1,'opening','开场','t');
             INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l1','w','主线','n','t');
             UPDATE worlds SET current_line_id='l1' WHERE id='w';
             INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('s1','w','purged-line','旧分支会话','t','t');
             INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,base_json,base_world_version,result_json,created_at,updated_at)
               VALUES('t1','s1','w','purged-line','查证','completed','auto','{}','','{\"summary\":\"完成\"}','t','t');",
        ).unwrap();
        db.pragma_update(None, "query_only", true).unwrap();
        let tx = db.transaction_with_behavior(TransactionBehavior::Deferred).unwrap();
        let exported = export_readable(&tx, "w").unwrap();
        tx.commit().unwrap();
        assert_eq!(exported["sessions"][0]["lineId"], "l1");
        assert!(exported["tasks"][0].get("lineId").is_none());
    }
}
