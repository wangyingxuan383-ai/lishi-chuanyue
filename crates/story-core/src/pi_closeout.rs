//! Post-adoption reads are immutable receipt views, never a new story lease.
use crate::{agent_workspace as ws, pi_store::PiCallRequest, Error, Result, RunPlan};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{json, Value};

pub(crate) fn terminal(task: &Value) -> bool {
    matches!(ws::text(task, "status"), "committed" | "completed" | "previewed" | "blocked")
        || task["status"] == "paused" && ws::parse(ws::text(task, "result_json"))["batchId"].is_string()
}

pub(crate) fn snapshot(db: &Connection, plan: &RunPlan) -> Result<Value> {
    let mut saved = serde_json::Map::new();
    for kind in ["settings", "state", "protagonist", "people", "places", "cards", "goals", "facts", "node", "line"] {
        saved.insert(kind.into(), ws::resource(db, plan, kind, "")?);
    }
    Ok(Value::Object(saved))
}

pub(crate) fn receipt_summary(receipt: &Value) -> Value {
    let mut summary=serde_json::Map::new();
    for key in ["status","goalStatus","goalCompleted","worldChanged","batchId","worldVersion","snapshotRef","pendingContinue","readBack","clockReadBack"] {
        if let Some(value)=receipt.get(key) {summary.insert(key.into(),value.clone());}
    }
    summary.insert("summary".into(),ws::text(receipt,"summary").chars().take(2400).collect::<String>().into());
    summary.insert("changeCount".into(),receipt["changes"].as_array().map_or(0,Vec::len).into());
    summary.insert("read".into(),json!({"tool":"read_commit_receipt","args":{}}));
    Value::Object(summary)
}

pub(crate) fn call(db: &Connection, task: &Value, plan: &RunPlan, request: &PiCallRequest) -> Result<Value> {
    if task["stop_revision"].as_i64().unwrap_or(0) != 0 { return Err(Error::Cancelled); }
    if task["intent_revision"].as_i64() != Some(request.intent_revision) { return Err(Error::Stale); }
    let receipt = ws::parse(ws::text(task, "result_json"));
    if request.world_version != ws::text(task, "base_world_version") && request.world_version != ws::text(&receipt, "worldVersion") {
        return Err(Error::Stale);
    }
    let args = &request.args;
    if args["batchId"].as_str().is_some_and(|id| receipt["batchId"] != id) { return Err(Error::Stale); }
    match request.tool.as_str() {
        "discover_tools" => {
            let allowed=["read_commit_receipt","read_committed_snapshot","read_tool_result","read_external_resource","read_plan","update_plan"];
            if args["names"].as_array().is_none_or(|names|names.iter().any(|name|!name.as_str().is_some_and(|name|allowed.contains(&name)))) {
                return Err(Error::Invalid("收尾只能加载回执、快照、已完成结果和计划工具；本批修改权限已经关闭".into()));
            }
            crate::pi_tools::call(db,task,plan,request)
        }
        "read_commit_receipt" => {
            let path=ws::text(args,"path");
            let value=if path.is_empty(){receipt.clone()}else{receipt.pointer(path).cloned().ok_or_else(||Error::Invalid("回执没有此字段".into()))?};
            Ok(ws::page(value, args))
        }
        "read_committed_snapshot" | "read_resource" | "read_clock" => {
            let kind = if request.tool == "read_clock" { "clock" } else { ws::canonical_kind(ws::text(args, "kind")) };
            let raw:Option<String>=db.query_row("SELECT snapshot_json FROM pi_commit_snapshots WHERE task_id=? AND batch_id=? AND world_version=?",params![ws::text(task,"id"),ws::text(&receipt,"batchId"),ws::text(&receipt,"worldVersion")],|row|row.get(0)).optional()?;
            let saved=raw.map(|raw|ws::parse(&raw)).unwrap_or(Value::Null);
            let mut value = if kind == "clock" { receipt["clockReadBack"].clone() } else { saved[kind].clone() };
            if value.is_null() { return Err(Error::Invalid("此回执没有保存该资料快照；可读取read_commit_receipt或原工具结果，不能把当前故事冒充当时状态".into())); }
            if !ws::text(args, "id").is_empty() || args["ref"].is_object() { return Err(Error::Invalid("收尾只读固定提交快照，请使用read_committed_snapshot的kind，不使用旧实体定位".into())); }
            if !ws::text(args,"path").is_empty() { value=value.pointer(ws::text(args,"path")).cloned().ok_or_else(|| Error::Invalid("提交快照没有此字段".into()))?; }
            let mut page = ws::page(value, args);
            page["batchId"]=receipt["batchId"].clone(); page["worldVersion"]=receipt["worldVersion"].clone(); page["immutable"]=true.into();
            Ok(page)
        }
        "read_tool_result" | "read_external_resource" | "read_plan" => crate::pi_tools::call(db, task, plan, request),
        "update_plan" if ws::parse(ws::text(task,"metadata_json"))["_nativeHostActive"] == true => crate::pi_tools::call(db, task, plan, request),
        _ => Err(Error::Tool { code:"task_writes_closed".into(), field:"tool".into(), message:"本批次已经结束修改；只能读取提交回执、固定快照和已完成结果，不能追加写入或重复提交".into(), next:json!({"tool":"read_commit_receipt","args":{}}) }),
    }
}
