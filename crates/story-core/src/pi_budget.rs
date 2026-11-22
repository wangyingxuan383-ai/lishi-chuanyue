//! Root-task accounting, shared by Pi, compaction, native search and children.
//! Mutations deliberately require the caller's existing ownership transaction.
use crate::{
    execution_lease,
    pi_store::{arguments_hash, canonical_json},
    Error, Result,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn transaction(db: &Connection) -> Result<()> {
    if db.is_autocommit() {
        return Err(invalid("用量变更须与本次执行权限在同一事务中检查"));
    }
    Ok(())
}
fn metadata(db: &Connection, task: &str) -> Result<Value> {
    let value: String = db.query_row(
        "SELECT metadata_json FROM pi_tasks WHERE id=?",
        [task],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&value)?)
}
fn save(db: &Connection, task: &str, value: &Value) -> Result<()> {
    db.execute(
        "UPDATE pi_tasks SET metadata_json=? WHERE id=?",
        params![value.to_string(), task],
    )?;
    Ok(())
}

pub(crate) fn limits(request: &Value) -> Result<Value> {
    let value = request.get("limits").unwrap_or(request);
    if !value.is_null() && !value.is_object() {
        return Err(invalid("执行上限必须是设置对象"));
    }
    let mut result = json!({"modelRequests":0,"toolCalls":0,"activeMs":0});
    for (key, max, min) in [
        ("modelRequests", 300, 1),
        ("toolCalls", 1000, 1),
        ("activeMs", 7_200_000, 60_000),
    ] {
        if let Some(value) = value.get(key).filter(|v| !v.is_null()) {
            let n = value
                .as_u64()
                .filter(|n| *n == 0 || (*n >= min && *n <= max))
                .ok_or_else(|| invalid("执行上限须为有效非负整数；0表示不限制"))?;
            result[key] = n.into();
        }
    }
    Ok(result)
}

fn safe_model(model: &Value) -> Result<Value> {
    let mut result = json!({});
    for key in [
        "profileId",
        "slot",
        "id",
        "model",
        "protocol",
        "inputTokens",
        "contextWindowTokens",
        "maxOutputTokens",
        "configHash",
        "requestHash",
    ] {
        if let Some(value) = model.get(key).filter(|v| !v.is_null()) {
            if !(value.is_boolean()
                || value.as_u64().is_some()
                || value.as_str().is_some_and(|s| s.len() <= 512))
            {
                return Err(invalid("模型用量定位字段无效"));
            }
            result[key] = value.clone();
        }
    }
    for key in ["configHash", "requestHash"] {
        if let Some(hash) = result[key].as_str() {
            if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(invalid("模型配置指纹无效"));
            }
        }
    }
    let mut price = json!({});
    for key in ["input", "output", "cacheRead", "cacheWrite"] {
        if let Some(n) = model["cost"][key]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
        {
            price[key] = n.into();
        }
    }
    if let Some(currency) = model["cost"]["currency"].as_str().filter(|s| s.len() <= 12) {
        price["currency"] = currency.into();
    }
    result["cost"] = price;
    Ok(canonical_json(&result))
}

fn activity(meta: &Value) -> (u64, bool) {
    let clock = &meta["activityClock"];
    let mut elapsed = clock["activeMs"].as_u64().unwrap_or(0);
    let mut known = clock["known"].as_bool().unwrap_or(true);
    if let Some(start) = clock["startedMs"].as_i64() {
        if clock["owner"] == execution_lease::process_instance() {
            elapsed = elapsed
                .saturating_add(execution_lease::now_ms().saturating_sub(start).max(0) as u64);
        } else {
            known = false;
        }
    }
    (elapsed, known)
}
pub(crate) fn clock_start(db: &Connection, task: &str) -> Result<Value> {
    transaction(db)?;
    let mut meta = metadata(db, task)?;
    let (elapsed, known) = activity(&meta);
    meta["activityClock"] = json!({"activeMs":elapsed,"known":known,"owner":execution_lease::process_instance(),"startedMs":execution_lease::now_ms()});
    save(db, task, &meta)?;
    read_budget(db, task)
}
pub(crate) fn clock_pause(db: &Connection, task: &str) -> Result<Value> {
    transaction(db)?;
    let mut meta = metadata(db, task)?;
    let (elapsed, known) = activity(&meta);
    meta["activityClock"] = json!({"activeMs":elapsed,"known":known,"owner":execution_lease::process_instance(),"startedMs":null});
    save(db, task, &meta)?;
    read_budget(db, task)
}
pub(crate) fn clock_finish(db: &Connection, task: &str) -> Result<Value> {
    clock_pause(db, task)
}
fn time_guard(meta: &Value) -> Result<()> {
    let cap = meta["limits"]["activeMs"].as_u64().unwrap_or(0);
    if cap > 0 && activity(meta).0 >= cap {
        return Err(Error::Limit("本次已达到活动时间上限"));
    }
    Ok(())
}
pub(crate) fn check_time(db: &Connection, task: &str) -> Result<()> {
    time_guard(&metadata(db, task)?)
}

pub(crate) fn reserve_model(
    db: &Connection,
    task: &str,
    id: &str,
    source: &str,
    model: &Value,
) -> Result<Value> {
    transaction(db)?;
    if id.is_empty()
        || id.len() > 128
        || ![
            "main",
            "model",
            "compaction",
            "summary",
            "subagent",
            "native_search",
            "retry",
            "progress_review",
        ]
        .contains(&source)
    {
        return Err(invalid("模型调用标识或用途无效"));
    }
    let model = safe_model(model)?;
    if let Some((old_source,old_model,status))=db.query_row("SELECT source,model_json,status FROM pi_model_requests WHERE task_id=? AND request_id=?",params![task,id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()?{
        if old_source!=source||arguments_hash(&serde_json::from_str::<Value>(&old_model)?)!=arguments_hash(&model){return Err(invalid("模型调用标识已用于不同配置，不能复用"));}
        return Ok(json!({"requestId":id,"admitted":false,"reused":true,"status":status,"budget":read_budget(db,task)?}));
    }
    let meta = metadata(db, task)?;
    time_guard(&meta)?;
    let (total, running): (i64, i64) = db.query_row(
        "SELECT COUNT(*),COALESCE(SUM(status='running'),0) FROM pi_model_requests WHERE task_id=?",
        [task],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let cap = meta["limits"]["modelRequests"].as_u64().unwrap_or(0);
    if cap > 0 && total as u64 >= cap {
        return Err(Error::Limit("本次已达到模型请求上限"));
    }
    if running >= 2 {
        return Err(invalid("根任务最多两个在途模型请求，请等待当前请求结束"));
    }
    db.execute("INSERT INTO pi_model_requests(task_id,request_id,source,model_json,status,started_at) VALUES(?,?,?,?,'running',?)",params![task,id,source,model.to_string(),chrono::Utc::now().to_rfc3339()])?;
    Ok(
        json!({"requestId":id,"admitted":true,"reused":false,"status":"running","budget":read_budget(db,task)?}),
    )
}
fn safe_usage(usage: &Value) -> Value {
    let mut result = json!({});
    for key in [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "reasoning",
        "totalTokens",
    ] {
        if let Some(value) = usage[key].as_u64() {
            result[key] = value.into();
        }
    }
    result
}
/// Mirror one Pi model request into the unified `usage` ledger (`purpose = 'agent'`)
/// so agent calls count in 本局用量, 用量与花费 and 本月预算 across all outcomes (R31-P4).
fn mirror_usage(db: &Connection, task: &str, id: &str, outcome: &str) -> Result<()> {
    let has_usage: bool = db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if !has_usage {
        return Ok(());
    }
    let Some((world_id, model_raw, usage_raw, started_at, finished_at)): Option<(
        Option<String>,
        String,
        Option<String>,
        String,
        Option<String>,
    )> = db
        .query_row(
            "SELECT t.world_id, r.model_json, r.usage_json, r.started_at, r.finished_at
             FROM pi_model_requests r
             JOIN pi_tasks t ON t.id = r.task_id
             WHERE r.task_id=? AND r.request_id=?",
            params![task, id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?
    else {
        return Ok(());
    };
    let model_json: Value = serde_json::from_str(&model_raw).unwrap_or_default();
    let used: Value = usage_raw
        .as_deref()
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();
    let profile_id = model_json["profileId"].as_str();
    let model_name = model_json["model"]
        .as_str()
        .or_else(|| model_json["id"].as_str())
        .unwrap_or("");
    let prompt_tokens = used["input"].as_u64().map(|inp| {
        inp.saturating_add(used["cacheRead"].as_u64().unwrap_or(0))
            .saturating_add(used["cacheWrite"].as_u64().unwrap_or(0)) as i64
    });
    let completion_tokens = used["output"].as_u64().map(|v| v as i64);
    let estimated = i64::from(prompt_tokens.is_none() || completion_tokens.is_none());
    let now = chrono::Utc::now().to_rfc3339();
    let at = finished_at.as_deref().unwrap_or(&now);
    let total_ms = chrono::DateTime::parse_from_rfc3339(&started_at)
        .ok()
        .zip(chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|(s, f)| (f - s).num_milliseconds().max(0));
    let ledger_id = format!("pi:{task}:{id}");
    db.execute(
        "INSERT INTO usage(id,world_id,node_id,purpose,profile_id,model,prompt_tokens,completion_tokens,estimated,first_token_ms,total_ms,outcome,at)
         VALUES(?1,?2,NULL,'agent',?3,?4,?5,?6,?7,NULL,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET
           prompt_tokens = COALESCE(excluded.prompt_tokens, usage.prompt_tokens),
           completion_tokens = COALESCE(excluded.completion_tokens, usage.completion_tokens),
           estimated = CASE WHEN COALESCE(excluded.prompt_tokens, usage.prompt_tokens) IS NULL OR COALESCE(excluded.completion_tokens, usage.completion_tokens) IS NULL THEN 1 ELSE 0 END,
           total_ms = COALESCE(excluded.total_ms, usage.total_ms),
           outcome = CASE WHEN usage.outcome = 'ok' THEN 'ok' ELSE excluded.outcome END",
        params![
            ledger_id,
            world_id,
            profile_id,
            model_name,
            prompt_tokens,
            completion_tokens,
            estimated,
            total_ms,
            outcome,
            at
        ],
    )?;
    Ok(())
}

pub(crate) fn finish_model(
    db: &Connection,
    task: &str,
    id: &str,
    usage: &Value,
    status: &str,
) -> Result<Value> {
    transaction(db)?;
    if !["success", "failed", "unknown"].contains(&status) {
        return Err(invalid("模型调用结果状态无效"));
    }
    let usage = safe_usage(usage);
    let (old, previous): (String, Option<String>) = db.query_row(
        "SELECT status,usage_json FROM pi_model_requests WHERE task_id=? AND request_id=?",
        params![task, id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if !["running", "awaiting_usage"].contains(&old.as_str()) {
        if old != status
            || previous
                .as_deref()
                .and_then(|v| serde_json::from_str::<Value>(v).ok())
                != Some(usage)
        {
            return Err(invalid("已确认的模型用量不能被替换"));
        }
    } else {
        db.execute("UPDATE pi_model_requests SET status=?,usage_json=?,finished_at=? WHERE task_id=? AND request_id=? AND status IN ('running','awaiting_usage')",params![status,usage.to_string(),chrono::Utc::now().to_rfc3339(),task,id])?;
        let outcome = match status {
            "success" => "ok",
            "unknown" => "interrupted",
            _ => "failed",
        };
        mirror_usage(db, task, id, outcome)?;
    }
    read_budget(db, task)
}
pub(crate) fn interrupt_models(db: &Connection, task: &str) -> Result<()> {
    transaction(db)?;
    let (stop_rev, stop_source): (i64, Option<String>) = db
        .query_row(
            "SELECT stop_revision, json_extract(metadata_json, '$.stopReceipt.source') FROM pi_tasks WHERE id=?",
            [task],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .unwrap_or((0, None));
    let mut stmt = db.prepare(
        "SELECT request_id FROM pi_model_requests WHERE task_id=? AND status IN ('running','awaiting_usage')",
    )?;
    let pending: Vec<String> = stmt
        .query_map([task], |r| r.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    db.execute(
        "UPDATE pi_model_requests SET status='unknown',usage_json=COALESCE(NULLIF(usage_json,''),'{}'),finished_at=? WHERE task_id=? AND status IN ('running','awaiting_usage')",
        params![chrono::Utc::now().to_rfc3339(), task],
    )?;
    let outcome = if stop_rev > 0 && stop_source.as_deref() != Some("system_timeout") {
        "cancelled"
    } else {
        "interrupted"
    };
    for req_id in pending {
        mirror_usage(db, task, &req_id, outcome)?;
    }
    Ok(())
}

pub(crate) fn transport_complete(db: &Connection, task: &str, id: &str) -> Result<Value> {
    transaction(db)?;
    db.execute("UPDATE pi_model_requests SET status='awaiting_usage' WHERE task_id=? AND request_id=? AND status='running'",params![task,id])?;
    read_budget(db, task)
}
pub(crate) fn admit_tool(db: &Connection, task: &str, id: &str) -> Result<()> {
    transaction(db)?;
    if db
        .query_row(
            "SELECT 1 FROM pi_calls WHERE task_id=? AND call_id=?",
            params![task, id],
            |_| Ok(()),
        )
        .optional()?
        .is_some()
    {
        return Ok(());
    }
    let meta = metadata(db, task)?;
    time_guard(&meta)?;
    let cap = meta["limits"]["toolCalls"].as_u64().unwrap_or(0);
    let count: i64 = db.query_row(
        "SELECT COUNT(*) FROM pi_calls WHERE task_id=?",
        [task],
        |r| r.get(0),
    )?;
    if cap > 0 && count as u64 >= cap {
        return Err(Error::Limit("本次已达到工具调用上限"));
    }
    Ok(())
}
pub(crate) fn read_budget(db: &Connection, task: &str) -> Result<Value> {
    let meta = metadata(db, task)?;
    let (active, known) = activity(&meta);
    let caps = limits(&meta["limits"])?;
    let mut stmt =
        db.prepare("SELECT status,model_json,usage_json FROM pi_model_requests WHERE task_id=?")?;
    let mut rows = stmt.query([task])?;
    let (mut count, mut running, mut unknown) = (0_u64, 0_u64, 0_u64);
    let mut unreported = 0_u64;
    let mut usage = json!({"input":0_u64,"output":0_u64,"cacheRead":0_u64,"cacheWrite":0_u64,"reasoning":0_u64,"totalTokens":0_u64});
    let (mut amount, mut price_known) = (0.0, true);
    let mut currency = None::<String>;
    while let Some(row) = rows.next()? {
        count += 1;
        let status: String = row.get(0)?;
        if status == "running" {
            running += 1;
        }
        if ["running", "unknown", "awaiting_usage"].contains(&status.as_str()) {
            unknown += 1;
        }
        let model: Value = serde_json::from_str(&row.get::<_, String>(1)?)?;
        let used: Value = row
            .get::<_, Option<String>>(2)?
            .as_deref()
            .and_then(|v| serde_json::from_str(v).ok())
            .unwrap_or(json!({}));
        if used["input"].as_u64().is_none() || used["output"].as_u64().is_none() {
            unreported += 1;
        }
        for key in [
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
            "reasoning",
            "totalTokens",
        ] {
            usage[key] = usage[key]
                .as_u64()
                .unwrap_or(0)
                .saturating_add(used[key].as_u64().unwrap_or(0))
                .into();
        }
        let price = &model["cost"];
        let current = price["currency"].as_str().unwrap_or("").to_owned();
        if currency.as_ref().is_some_and(|old| old != &current) {
            price_known = false;
        }
        currency.get_or_insert(current);
        if ["running", "unknown", "awaiting_usage"].contains(&status.as_str())
            || used["input"].as_u64().is_none()
            || used["output"].as_u64().is_none()
            || ["input", "output", "cacheRead", "cacheWrite"]
                .iter()
                .any(|key| price[*key].as_f64().is_none())
        {
            price_known = false;
        } else {
            for key in ["input", "output", "cacheRead", "cacheWrite"] {
                amount += price[key].as_f64().unwrap_or(0.0)
                    * used[key].as_u64().unwrap_or(0) as f64
                    / 1_000_000.0;
            }
        }
    }
    let tools: i64 = db.query_row(
        "SELECT COUNT(*) FROM pi_calls WHERE task_id=?",
        [task],
        |r| r.get(0),
    )?;
    price_known &= amount.is_finite();
    Ok(
        json!({"limits":caps,"modelRequests":count,"toolCalls":tools,"activeMs":active,"activityTimeKnown":known,"runningRequests":running,"unknownRequests":unknown,"unreportedUsageRequests":unreported,"usageKnown":unreported==0,"usage":usage,"estimatedCost":if price_known{Some(amount)}else{None},"priceKnown":price_known,"currency":currency,"estimated":true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(caps: Value) -> Connection {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::migration::migrate(&mut db, None).unwrap();
        db.execute_batch("INSERT INTO worlds(id,title,era_id,created_at,updated_at,played_at) VALUES('w','隔离','free','test','test','test');INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('s','w','l','隔离','test','test');").unwrap();
        db.execute("INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,base_json,base_world_version,metadata_json,created_at,updated_at) VALUES('t','s','w','l','仅隔离检查','running','auto','{}','v1',?,'test','test')",[json!({"limits":caps}).to_string()]).unwrap();
        db
    }
    fn model() -> Value {
        json!({"id":"own-model","protocol":"chat-completions","baseUrl":"https://private.invalid/v1","apiKey":"OWNED-NOT-PERSISTED","cost":{"input":1,"output":2,"cacheRead":0.3,"cacheWrite":0.4,"currency":"USD"}})
    }
    #[test]
    fn immutable_requests_count_retries_compaction_and_unknown_fees_without_secrets() {
        let mut db = fixture(json!({"modelRequests":2}));
        let tx = db.transaction().unwrap();
        assert_eq!(
            reserve_model(&tx, "t", "one", "main", &model()).unwrap()["admitted"],
            true
        );
        assert_eq!(
            reserve_model(&tx, "t", "one", "main", &model()).unwrap()["admitted"],
            false
        );
        let mut changed = model();
        changed["id"] = "other".into();
        assert!(reserve_model(&tx, "t", "one", "main", &changed).is_err());
        let usage = json!({"input":100,"output":50,"cacheRead":0,"cacheWrite":0,"rawCredential":"OWNED-NOT-PERSISTED"});
        let done = finish_model(&tx, "t", "one", &usage, "success").unwrap();
        assert_eq!(done["priceKnown"], true);
        assert!((done["estimatedCost"].as_f64().unwrap() - 0.0002).abs() < 1e-10);
        assert_eq!(
            finish_model(&tx, "t", "one", &usage, "success").unwrap()["modelRequests"],
            1
        );
        assert!(
            finish_model(&tx, "t", "one", &json!({"input":99,"output":50}), "success").is_err()
        );
        reserve_model(&tx, "t", "two", "compaction", &model()).unwrap();
        let result = finish_model(&tx, "t", "two", &json!({}), "failed").unwrap();
        assert_eq!(result["modelRequests"], 2);
        assert!(result["estimatedCost"].is_null());
        assert!(matches!(
            reserve_model(&tx, "t", "three", "retry", &model()),
            Err(Error::Limit(_))
        ));
        let raw: String = tx
            .query_row(
                "SELECT group_concat(model_json||COALESCE(usage_json,'')) FROM pi_model_requests",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            !raw.contains("OWNED-NOT-PERSISTED")
                && !raw.contains("private.invalid")
                && !raw.contains("rawCredential")
        );
        tx.commit().unwrap();
    }
    #[test]
    fn root_concurrency_tools_and_interruption_share_cumulative_limits() {
        let mut db = fixture(json!({"toolCalls":1}));
        let tx = db.transaction().unwrap();
        reserve_model(&tx, "t", "one", "main", &model()).unwrap();
        reserve_model(&tx, "t", "two", "subagent", &model()).unwrap();
        assert!(reserve_model(&tx, "t", "three", "subagent", &model()).is_err());
        finish_model(&tx, "t", "one", &json!({}), "failed").unwrap();
        reserve_model(&tx, "t", "three", "native_search", &model()).unwrap();
        admit_tool(&tx, "t", "call1").unwrap();
        tx.execute("INSERT INTO pi_calls(task_id,call_id,tool,args_hash,world_version,intent_revision,external_write,status,created_at,updated_at) VALUES('t','call1','read_resource','h','v1',0,0,'done','test','test')",[]).unwrap();
        admit_tool(&tx, "t", "call1").unwrap();
        assert!(matches!(
            admit_tool(&tx, "t", "call2"),
            Err(Error::Limit(_))
        ));
        interrupt_models(&tx, "t").unwrap();
        let budget = read_budget(&tx, "t").unwrap();
        assert_eq!(budget["modelRequests"], 3);
        assert_eq!(budget["runningRequests"], 0);
        assert_eq!(budget["unknownRequests"], 2);
        assert_eq!(budget["toolCalls"], 1);
        tx.commit().unwrap();
    }
    #[test]
    fn activity_pause_and_restart_do_not_charge_offline_time_or_reset_usage() {
        let mut db = fixture(json!({}));
        assert!(clock_start(&db, "t").is_err());
        let tx = db.transaction().unwrap();
        let mut meta = metadata(&tx, "t").unwrap();
        meta["activityClock"] = json!({"activeMs":1000,"startedMs":execution_lease::now_ms()-5000,"owner":execution_lease::process_instance(),"known":true});
        save(&tx, "t", &meta).unwrap();
        let paused = clock_pause(&tx, "t").unwrap();
        assert!((6000..=10000).contains(&paused["activeMs"].as_u64().unwrap()));
        clock_start(&tx, "t").unwrap();
        assert!(
            clock_finish(&tx, "t").unwrap()["activeMs"]
                .as_u64()
                .unwrap()
                >= 6000
        );
        meta = metadata(&tx, "t").unwrap();
        meta["activityClock"] = json!({"activeMs":2000,"startedMs":execution_lease::now_ms()-86_400_000,"owner":"old-process","known":true});
        save(&tx, "t", &meta).unwrap();
        let resumed = clock_start(&tx, "t").unwrap();
        assert_eq!(resumed["activityTimeKnown"], false);
        assert!(resumed["activeMs"].as_u64().unwrap() < 3000);
        tx.commit().unwrap();
    }
    #[test]
    fn mirror_usage_records_agent_requests_across_success_failure_and_interruption() {
        let mut db = fixture(json!({}));
        let tx = db.transaction().unwrap();
        let mut m = model();
        m["profileId"] = "prof-1".into();
        reserve_model(&tx, "t", "req-ok", "main", &m).unwrap();
        finish_model(
            &tx,
            "t",
            "req-ok",
            &json!({"input":120,"output":45,"cacheRead":30,"cacheWrite":10}),
            "success",
        )
        .unwrap();
        reserve_model(&tx, "t", "req-fail", "main", &m).unwrap();
        finish_model(&tx, "t", "req-fail", &json!({"input":80,"output":12}), "failed").unwrap();
        reserve_model(&tx, "t", "req-int", "main", &m).unwrap();
        interrupt_models(&tx, "t").unwrap();
        tx.commit().unwrap();

        let mut stmt = db
            .prepare(
                "SELECT id, world_id, purpose, profile_id, model, prompt_tokens, completion_tokens, estimated, outcome
                 FROM usage ORDER BY id",
            )
            .unwrap();
        let rows: Vec<(String, String, String, Option<String>, String, Option<i64>, Option<i64>, i64, String)> = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                ))
            })
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[0],
            (
                "pi:t:req-fail".into(),
                "w".into(),
                "agent".into(),
                Some("prof-1".into()),
                "own-model".into(),
                Some(80),
                Some(12),
                0,
                "failed".into(),
            )
        );
        assert_eq!(
            rows[1],
            (
                "pi:t:req-int".into(),
                "w".into(),
                "agent".into(),
                Some("prof-1".into()),
                "own-model".into(),
                None,
                None,
                1,
                "interrupted".into(),
            )
        );
        assert_eq!(
            rows[2],
            (
                "pi:t:req-ok".into(),
                "w".into(),
                "agent".into(),
                Some("prof-1".into()),
                "own-model".into(),
                Some(160), // 120 input + 30 cacheRead + 10 cacheWrite
                Some(45),
                0,
                "ok".into(),
            )
        );
    }
}
