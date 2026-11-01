//! Application task controls. These rows are not a second model transcript.
use crate::{pi_store::PiStore, Error, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

pub(crate) fn inputs(store: &PiStore, session: &str, task: Option<&str>) -> Result<Vec<Value>> {
    let db = store.0.lock()?;
    let mut stmt=db.prepare("SELECT id,task_id,seq,delivery,status,content_json,created_at FROM pi_inputs WHERE session_id=? AND (? IS NULL OR task_id=?) ORDER BY seq")?;
    let rows = stmt.query_map(params![session, task, task], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
        ))
    })?;
    rows.map(|r|{let (id,task,seq,delivery,status,content,at)=r?;let content:Value=serde_json::from_str(&content)?;Ok(json!({"id":id,"sessionId":session,"taskId":task,"seq":seq,"delivery":delivery,"status":status,"text":content["text"],"displayContent":if delivery=="answer"{crate::pi_questions::display_answer(&content)}else{None},"createdAt":at}))}).collect()
}

/// Queued input is a new task, never a prompt injected into an old story base.
/// Only non-secret configuration references are persisted here.
pub(crate) fn enqueue(store: &PiStore, request: &Value) -> Result<Value> {
    let task_id = text(request, "taskId");
    let task = store.task(task_id)?;
    let session = text(&task, "session_id");
    if request["sessionId"].as_str().is_some_and(|s| s != session) {
        return Err(invalid("这条输入不属于当前会话"));
    }
    let value = text(request, "text").trim();
    if value.is_empty() || value.encode_utf16().count() > 100000 {
        return Err(invalid("请填写有效的任务要求"));
    }
    let mut next = serde_json::Map::new();
    next.insert("policy".into(), task["policy"].clone());
    next.insert("readOnly".into(), (task["read_only"] == 1).into());
    for name in ["skills", "customSkills"] {
        next.insert(name.into(), task["metadata_json"][name].clone());
    }
    next.insert(
        "network".into(),
        crate::pi_network::snapshot(&task["metadata_json"]["network"])?,
    );
    let supplied = &request["request"];
    for name in [
        "policy",
        "readOnly",
        "skills",
        "customSkills",
        "limits",
        "inputTokens",
        "contextWindowTokens",
        "maxOutputTokens",
        "target",
        "modelUrl",
    ] {
        if let Some(value) = supplied.get(name) {
            next.insert(name.into(), value.clone());
        }
    }
    // Reuse the task's safe model locator unless the player selected another.
    let mut model = if supplied["model"].is_object(){json!({})}else{task["model_json"].clone()};
    if !model.is_object() {
        model = json!({});
    }
    for name in [
        "profileId",
        "slot",
        "id",
        "model",
        "protocol",
        "inputTokens",
        "contextTokens",
        "contextWindowTokens",
        "maxOutputTokens",
        "reasoning",
        "temperature",
        "topP",
        "endpointRef",
    ] {
        if let Some(v) = supplied["model"]
            .get(name)
            .filter(|v| !v.is_array() && !v.is_object())
        {
            model[name] = v.clone();
        }
    }
    next.insert("model".into(), model);
    if supplied["network"].is_object() {
        next.insert(
            "network".into(),
            crate::pi_network::snapshot(&supplied["network"])?,
        );
    }
    // Network settings are resolved from the current authorized preferences
    // when the new task starts, rather than retaining a stale UI capability.
    next.insert("op".into(), "start".into());
    next.insert("sessionId".into(), session.into());
    next.insert("text".into(), value.into());
    let id=store.append_named_input_guarded(session,None,"queued",&json!({"text":value,"request":next}),request["id"].as_str(),|tx|{
        let valid=tx.query_row("SELECT 1 FROM pi_sessions s JOIN worlds w ON w.id=s.world_id WHERE s.id=? AND w.archived=0",[session],|_|Ok(())).optional()?.is_some();
        if !valid{return Err(invalid("该故事已归档或会话已删除"));} Ok(())
    })?;
    Ok(json!({"id":id,"delivery":"queued","status":"pending","accepted":true}))
}

pub(crate) fn cancel_queued(store: &PiStore, id: &str) -> Result<Value> {
    let changed=store.0.lock()?.execute("UPDATE pi_inputs SET status='cancelled' WHERE id=? AND delivery='queued' AND status='pending'",[id])?;
    Ok(json!({"id":id,"cancelled":changed==1}))
}

pub(crate) fn next_queued(store: &PiStore, session: &str) -> Result<Option<Value>> {
    let row=store.0.lock()?.query_row("SELECT id,content_json FROM pi_inputs WHERE session_id=? AND delivery='queued' AND status='pending' ORDER BY seq LIMIT 1",[session],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
    row.map(|(id, payload)| {
        let payload: Value = serde_json::from_str(&payload)?;
        let mut request = payload["request"].clone();
        if !request.is_object() {
            return Err(invalid("排队任务缺少配置，原始要求已保留"));
        }
        request["queuedInputId"] = id.into();
        Ok(request)
    })
    .transpose()
}

pub(crate) fn reject_queued(store: &PiStore, id: &str) -> Result<()> {
    store.0.lock()?.execute("UPDATE pi_inputs SET status='failed' WHERE id=? AND delivery='queued' AND status='pending'",[id])?;
    Ok(())
}
