//! Task-owned external material. A locator proves captured bytes, not truth.
use crate::{agent_workspace as ws, pi_store::PiCallRequest, Error, Result, RunPlan};
use rusqlite::{params,Connection,OptionalExtension};
use serde_json::{json,Value};

pub(crate) fn capture(db:&Connection,task:&Value,request:&PiCallRequest,value:&Value)->Result<Option<Value>> {
    if value["isError"]==true||value["result"]["isError"]==true {return Ok(None);}
    if !matches!(request.tool.as_str(),"web_search"|"read_webpage"|"read_mcp_resource"|"read_document"|"find_document"|"browser_open"|"browser_read"|"browser_find"|"browser_follow") {return Ok(None);}
    let data=serde_json::to_string(value)?;
    if data.len()>2*1024*1024 {return Err(Error::Invalid("资料较大，请缩小读取范围后保存快照".into()));}
    let version=crate::pi_store::arguments_hash(value);
    let key=crate::pi_store::arguments_hash(&json!([request.tool,request.args]));
    let id=ws::id();
    let actor:Option<String>=db.query_row("SELECT child_id FROM pi_child_calls WHERE task_id=? AND call_id=?",params![ws::text(task,"id"),request.call_id],|row|row.get(0)).optional()?;
    let source=json!({"tool":request.tool,"callId":request.call_id,"actorId":actor.unwrap_or_default(),"url":value["url"],"title":value["title"],"serverId":request.args["serverId"],"uri":request.args["uri"],"capturedAt":ws::now(),"untrusted":true});
    db.execute("INSERT INTO pi_resource_snapshots(id,task_id,world_id,kind,resource_key,version,data_json,source_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",params![id,ws::text(task,"id"),ws::text(task,"world_id"),request.tool,key,version,data,source.to_string(),ws::now()])?;
    Ok(Some(json!({"id":id,"taskId":task["id"],"worldId":task["world_id"],"version":version,"kind":request.tool})))
}

pub(crate) fn read(db:&Connection,task:&Value,plan:&RunPlan,args:&Value)->Result<Value> {
    let reference=&args["ref"];
    if reference["taskId"]!=task["id"] || reference["worldId"]!=task["world_id"] {
        return Err(Error::Invalid("资料快照不属于本任务，不能跨故事或会话读取".into()));
    }
    let saved:Option<(String,String,String)>=db.query_row("SELECT data_json,source_json,version FROM pi_resource_snapshots WHERE id=? AND task_id=? AND world_id=?",params![ws::text(reference,"id"),ws::text(task,"id"),ws::text(task,"world_id")],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let Some((raw,source,version))=saved else{return Err(Error::Invalid("资料快照已经删除或不存在，请重新读取来源".into()));};
    let source=ws::parse(&source);
    let actor=ws::text(&plan.meta["agent"],"readOnlyActor");
    if !actor.is_empty() && ws::text(&source,"actorId")!=actor {return Err(Error::Invalid("此快照未提供给当前只读子助手".into()));}
    if reference["version"]!=version {return Err(Error::Stale);}
    let mut value=ws::parse(&raw);let path=ws::text(args,"path");
    if !path.is_empty(){value=value.pointer(path).cloned().ok_or_else(||Error::Invalid("资料快照没有此字段".into()))?;}
    let mut page=ws::page(value,args);page["source"]=source;page["resourceRef"]=reference.clone();page["untrusted"]=true.into();
    Ok(page)
}

/// Player-facing text-only source inspection, never a model authority grant.
pub(crate) fn inspect(db:&Connection,args:&Value)->Result<Value>{
    let session=ws::text(args,"sessionId");let world=ws::text(args,"worldId");
    if args["id"].is_string(){
        let row:Option<(String,String)>=db.query_row("SELECT r.data_json,r.source_json FROM pi_resource_snapshots r JOIN pi_tasks t ON t.id=r.task_id WHERE t.session_id=? AND r.world_id=? AND r.id=?",params![session,world,ws::text(args,"id")],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((data,source))=row else{return Err(Error::Invalid("资料已删除或不属于这次对话".into()));};
        let data=ws::parse(&data);let mut text=ws::text(&data,"text").to_owned();
        if text.is_empty(){for key in ["hits","sources"]{for part in data[key].as_array().into_iter().flatten(){if let Some(body)=part["text"].as_str(){if !text.is_empty(){text.push_str("\n\n");}text.push_str(body);}}}}
        let offset=args["offset"].as_u64().unwrap_or(0) as usize;let size=8000;let total=text.chars().count();
        return Ok(json!({"title":data["title"],"url":data["url"],"text":text.chars().skip(offset).take(size).collect::<String>(),"source":ws::parse(&source),"nextOffset":if offset+size<total{json!(offset+size)}else{Value::Null},"untrusted":true}));
    }
    let offset=args["offset"].as_u64().unwrap_or(0) as i64;
    let mut stmt=db.prepare("SELECT r.id,r.kind,r.data_json,r.created_at FROM pi_resource_snapshots r JOIN pi_tasks t ON t.id=r.task_id WHERE t.session_id=? AND r.world_id=? ORDER BY r.rowid DESC LIMIT 41 OFFSET ?")?;
    let mut items=vec![];
    for row in stmt.query_map(params![session,world,offset],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?{let(id,kind,raw,created)=row?;let data=ws::parse(&raw);items.push(json!({"id":id,"kind":kind,"title":data["title"],"url":data["url"],"createdAt":created}));}
    let more=items.len()>40;items.truncate(40);Ok(json!({"items":items,"nextOffset":if more{json!(offset+40)}else{Value::Null}}))
}
