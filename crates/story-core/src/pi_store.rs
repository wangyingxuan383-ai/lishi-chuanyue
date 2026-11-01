//! Pi owns its transcript; these rows own business state and durable effects.
use crate::{Error, Result, Store};
use chrono::Utc;
use rusqlite::{
    params, types::ValueRef, Connection, OptionalExtension, Transaction, TransactionBehavior,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

#[derive(Clone)]
pub struct PiStore(pub Store);

#[derive(Clone)]
pub struct NewSession {
    pub id: String,
    pub world_id: String,
    pub line_id: String,
    pub title: String,
    pub session_file: Option<String>,
}

#[derive(Clone)]
pub struct NewTask {
    pub id: String,
    pub session_id: String,
    pub text: String,
    pub policy: String,
    pub read_only: bool,
    pub base: Value,
    pub world_version: String,
    pub model: Value,
    pub metadata: Value,
    pub lease: Value,
    pub host_owner: String,
}

#[derive(Clone)]
pub struct PiCallRequest {
    pub task_id: String,
    pub call_id: String,
    pub tool: String,
    pub args: Value,
    pub intent_revision: i64,
    pub world_version: String,
    pub external_write: bool,
}

#[derive(Debug, PartialEq)]
pub enum BeginCall {
    Execute,
    Cached(Value),
    InFlight,
    Unknown,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}

pub fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort();
            let mut result = Map::new();
            for key in keys {
                result.insert(key.clone(), canonical_json(&object[key]));
            }
            Value::Object(result)
        }
        Value::Array(values) => Value::Array(values.iter().map(canonical_json).collect()),
        _ => value.clone(),
    }
}

pub fn arguments_hash(args: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(canonical_json(args).to_string().as_bytes())
    )
}

// Deliberately omit URLs, credentials, authorization headers and provider
// payloads. Native configuration resolves the saved profile/slot reference.
fn model_snapshot(model: &Value) -> Value {
    let mut result = Map::new();
    for field in [
        "profileId",
        "slot",
        "id",
        "model",
        "name",
        "protocol",
        "inputTokens",
        "contextWindowTokens",
        "maxOutputTokens",
        "reasoning",
        "temperature",
        "topP",
        "endpointRef",
    ] {
        if let Some(value) = model.get(field).filter(|v| !v.is_object() && !v.is_array()) {
            result.insert(field.into(), value.clone());
        }
    }
    Value::Object(result)
}

fn object_row(db: &Connection, table: &str, id: &str) -> Result<Value> {
    let mut statement = db.prepare(&format!("SELECT * FROM {table} WHERE id=?"))?;
    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|s| (*s).into())
        .collect();
    let value = statement
        .query_row([id], |row| {
            let mut object = Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => v.into(),
                    ValueRef::Real(v) => Value::from(v),
                    ValueRef::Text(v) => {
                        let text = String::from_utf8_lossy(v);
                        if name.ends_with("_json") {
                            serde_json::from_str(&text).map_err(|error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    index,
                                    rusqlite::types::Type::Text,
                                    Box::new(error),
                                )
                            })?
                        } else {
                            text.into_owned().into()
                        }
                    }
                    ValueRef::Blob(_) => Value::Null,
                };
                object.insert(name.clone(), value);
            }
            Ok(Value::Object(object))
        })
        .optional()?;
    value.ok_or_else(|| invalid("这项助手记录不存在"))
}

pub(crate) fn create_session_tx(tx: &Transaction<'_>, session: &NewSession) -> Result<()> {
    if session.id.is_empty() || session.title.trim().is_empty() {
        return Err(invalid("会话名称不能为空"));
    }
    let valid = tx.query_row("SELECT 1 FROM worlds w JOIN lines l ON l.world_id=w.id WHERE w.id=? AND l.id=? AND w.archived=0 AND l.deleted_at IS NULL",params![session.world_id,session.line_id], |_| Ok(())).optional()?.is_some();
    if !valid {
        return Err(Error::Stale);
    }
    let time = now();
    tx.execute("INSERT INTO pi_sessions(id,world_id,line_id,title,session_file,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",params![session.id,session.world_id,session.line_id,session.title,session.session_file,time,time])?;
    Ok(())
}

pub(crate) fn create_task_tx(tx: &Transaction<'_>, task: &NewTask) -> Result<()> {
    if task.id.is_empty() || task.text.trim().is_empty() || task.world_version.is_empty() {
        return Err(invalid("任务缺少要求或故事版本"));
    }
    if !["auto-reversible", "preview", "auto"].contains(&task.policy.as_str()) {
        return Err(invalid("采用策略无效"));
    }
    let (world, line): (String, String) = tx.query_row(
        "SELECT world_id,line_id FROM pi_sessions WHERE id=?",
        [&task.session_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let time = now();
    tx.execute("INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,read_only,base_json,base_world_version,model_json,metadata_json,lease_json,host_owner,created_at,updated_at) VALUES(?,?,?,?,?,'running',?,?,?,?,?,?,?,?,?,?)",params![task.id,task.session_id,world,line,task.text,task.policy,task.read_only,task.base.to_string(),task.world_version,model_snapshot(&task.model).to_string(),task.metadata.to_string(),task.lease.to_string(),task.host_owner,time,time])?;
    if let Some(input)=task.metadata["queuedInputId"].as_str() {
        let saved:Option<(String,String)>=tx.query_row("SELECT session_id,content_json FROM pi_inputs WHERE id=? AND delivery='queued' AND status='pending'",[input],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((session,payload))=saved else{return Err(invalid("排队要求已取消或已启动，不能重复执行"));};
        if session!=task.session_id || serde_json::from_str::<Value>(&payload)?["text"]!=task.text {return Err(invalid("排队要求与本任务不一致"));}
        tx.execute("UPDATE pi_inputs SET task_id=?,status='delivered',delivered_at=? WHERE id=?",params![task.id,time,input])?;
    }
    tx.execute(
        "UPDATE pi_sessions SET updated_at=? WHERE id=?",
        params![time, task.session_id],
    )?;
    Ok(())
}

fn check_call_identity(
    tx: &Transaction<'_>,
    call: &PiCallRequest,
) -> Result<Option<(String, Option<String>)>> {
    let prior: Option<(String,String,String,i64,bool,String,Option<String>)> = tx.query_row("SELECT tool,args_hash,world_version,intent_revision,external_write,status,output_json FROM pi_calls WHERE task_id=? AND call_id=?",params![call.task_id,call.call_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
    if let Some((tool, hash, world, intent, external, status, output)) = prior {
        if tool != call.tool
            || hash != arguments_hash(&call.args)
            || world != call.world_version
            || intent != call.intent_revision
            || external != call.external_write
        {
            return Err(invalid(
                "tool_call_identity_mismatch：调用标识已用于不同工具、参数或版本，不能复用",
            ));
        }
        return Ok(Some((status, output)));
    }
    Ok(None)
}

/// Only called after the gateway rereads the actual world in this transaction.
pub(crate) fn guard_commit(
    tx: &Transaction<'_>,
    task_id: &str,
    intent_revision: i64,
    current_world_version: &str,
) -> Result<()> {
    crate::maintenance::guard(tx)?;
    let row = object_row(tx, "pi_tasks", task_id)?;
    if row["read_only"] == 1 {
        return Err(invalid("只读分析不能修改正式故事"));
    }
    guard_task(&row, intent_revision, current_world_version)?;
    if !row["question_json"].is_null() {
        return Err(invalid("请先处理当前等待回答的问题"));
    }
    let pending = tx.query_row("SELECT 1 FROM pi_inputs WHERE task_id=? AND status='pending' AND delivery IN ('steer','answer') LIMIT 1",[task_id], |_| Ok(())).optional()?.is_some();
    if pending {
        return Err(invalid("还有尚未生效的补充要求，不能采用旧草稿"));
    }
    Ok(())
}

fn guard_task(row: &Value, intent: i64, world: &str) -> Result<()> {
    if row["stop_revision"].as_i64().unwrap_or(0) > 0 {
        return Err(Error::Cancelled);
    }
    if !["running", "committing", "previewed"].contains(&row["status"].as_str().unwrap_or("")) {
        return Err(invalid("当前任务没有执行权限"));
    }
    if row["intent_revision"].as_i64() != Some(intent)
        || row["consumed_intent_revision"].as_i64() != Some(intent)
    {
        return Err(invalid("任务要求已经变化，请先读取并处理新要求"));
    }
    if row["base_world_version"].as_str() != Some(world) {
        return Err(Error::Stale);
    }
    Ok(())
}

pub(crate) fn complete_call_tx(
    tx: &Transaction<'_>,
    call: &PiCallRequest,
    result: &Value,
) -> Result<()> {
    let Some((status, prior)) = check_call_identity(tx, call)? else {
        return Err(invalid("工具结果没有对应的已登记调用"));
    };
    if status == "done" {
        if prior
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .as_ref()
            != Some(result)
        {
            return Err(invalid("已保存的工具结果不能被替换"));
        }
        return Ok(());
    }
    if status != "running" {
        return Err(invalid("结果未知的调用必须先核对，不能自动标记完成"));
    }
    crate::pi_progress::observe(tx,call,result)?;
    let unknown = result["outcomeUnknown"] == true;
    let status = if unknown { "unknown" } else { "done" };
    let time = now();
    tx.execute("UPDATE pi_calls SET status=?,output_json=?,updated_at=? WHERE task_id=? AND call_id=? AND status='running'",params![status,result.to_string(),time,call.task_id,call.call_id])?;
    if call.external_write {
        tx.execute(
            "UPDATE pi_external_effects SET status=?,updated_at=? WHERE task_id=? AND call_id=?",
            params![status, time, call.task_id, call.call_id],
        )?;
    }
    Ok(())
}

impl PiStore {
    pub fn initialize(&self) -> Result<()> {
        self.0
            .lock()?
            .execute_batch(include_str!("execution_lease_schema.sql"))?;
        self.0
            .lock()?
            .execute_batch(include_str!("pi_schema.sql"))?;
        self.0.lock()?.execute_batch(include_str!("migrations/009.sql"))?;
        self.0.lock()?.execute_batch(include_str!("migrations/010.sql"))?;
        self.0.lock()?.execute_batch(include_str!("migrations/011.sql"))?;
        Ok(())
    }
    pub fn create_session(&self, session: &NewSession) -> Result<()> {
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        create_session_tx(&tx, session)?;
        tx.commit()?;
        Ok(())
    }
    pub fn create_task(&self, task: &NewTask) -> Result<()> {
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        create_task_tx(&tx, task)?;
        tx.commit()?;
        Ok(())
    }
    pub fn session(&self, id: &str) -> Result<Value> {
        object_row(&*self.0.lock()?, "pi_sessions", id)
    }
    pub fn task(&self, id: &str) -> Result<Value> {
        object_row(&*self.0.lock()?, "pi_tasks", id)
    }
    pub fn event(&self, task: &str, event: &Value) -> Result<u64> {
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::pi_forks::record_anchor(&tx, task, event)?;
        let seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM pi_events WHERE task_id=?",
            [task],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO pi_events(task_id,seq,event_json,created_at) VALUES(?,?,?,?)",
            params![task, seq, event.to_string(), now()],
        )?;
        let observed=if event["event"]["type"]=="context_state" {Some(&event["event"]["data"])}else if event["type"]=="context_state"{Some(&event["data"])}else{None};
        if let Some(data)=observed.filter(|_| !event["childId"].is_string()&&!event["event"]["childId"].is_string()) {
            let mut row=object_row(&tx,"pi_tasks",task)?;
            if crate::pi_lifecycle::attempt(&row)==data["attemptId"].as_str().unwrap_or("") {
                row["metadata_json"]["contextState"]=data.clone();
                tx.execute("UPDATE pi_tasks SET metadata_json=?,updated_at=? WHERE id=?",params![row["metadata_json"].to_string(),now(),task])?;
            }
        }
        tx.commit()?;
        Ok(seq as u64)
    }
    pub fn events(&self, task: &str, after: u64) -> Result<Vec<Value>> {
        let db = self.0.lock()?;
        let mut statement = db.prepare(
            "SELECT seq,event_json FROM pi_events WHERE task_id=? AND seq>? ORDER BY seq",
        )?;
        let rows = statement.query_map(params![task, after.min(i64::MAX as u64) as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        rows.map(|r| {
            let (seq, event) = r?;
            Ok(json!({"seq":seq,"event":serde_json::from_str::<Value>(&event)?}))
        })
        .collect()
    }
    pub fn begin_call(&self, call: &PiCallRequest) -> Result<BeginCall> {
        self.begin_call_guarded(call, |_, _| Ok(()))
    }
    pub(crate) fn begin_call_guarded(
        &self,
        call: &PiCallRequest,
        authorize: impl FnOnce(&Transaction<'_>, bool) -> Result<()>,
    ) -> Result<BeginCall> {
        if call.call_id.is_empty() || call.tool.is_empty() {
            return Err(invalid("工具调用缺少标识或名称"));
        }
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior = check_call_identity(&tx, call)?;
        authorize(&tx, prior.is_some())?;
        if let Some((status, output)) = prior {
            return match status.as_str() {
                "done" => Ok(BeginCall::Cached(serde_json::from_str(
                    output
                        .as_deref()
                        .ok_or_else(|| invalid("工具结果记录不完整"))?,
                )?)),
                "unknown" => Ok(BeginCall::Unknown),
                _ => Ok(BeginCall::InFlight),
            };
        }
        let task = object_row(&tx, "pi_tasks", &call.task_id)?;
        if crate::pi_closeout::terminal(&task) {
            // The owning gateway already fenced the execution above. This
            // only admits a durable receipt read or a rejected late tool;
            // closeout dispatch can never acquire story write authority.
            if task["stop_revision"].as_i64().unwrap_or(0)!=0 {return Err(Error::Cancelled);}
            let receipt=serde_json::from_str::<Value>(task["result_json"].as_str().unwrap_or("null"))?;
            if task["intent_revision"].as_i64()!=Some(call.intent_revision)
                || task["base_world_version"]!=call.world_version && receipt["worldVersion"]!=call.world_version {return Err(Error::Stale);}
        } else {
            guard_task(&task, call.intent_revision, &call.world_version)?;
        }
        crate::pi_budget::admit_tool(&tx,&call.task_id,&call.call_id)?;
        tx.execute("UPDATE pi_tasks SET metadata_json=json_set(metadata_json,'$.executionPhase',?) WHERE id=?",params![if crate::agent_policy::read_only(&call.tool){"reading"}else{"preparing"},call.task_id])?;
        let hash = arguments_hash(&call.args);
        let uncertain=call.external_write && tx.query_row("SELECT 1 FROM pi_external_effects WHERE world_id=? AND tool=? AND args_hash=? AND status IN ('running','unknown') LIMIT 1",params![task["world_id"].as_str().unwrap_or(""),call.tool,hash],|_|Ok(())).optional()?.is_some();
        let time = now();
        let status = if uncertain { "unknown" } else { "running" };
        tx.execute("INSERT INTO pi_calls(task_id,call_id,tool,args_hash,world_version,intent_revision,external_write,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",params![call.task_id,call.call_id,call.tool,hash,call.world_version,call.intent_revision,call.external_write,status,time,time])?;
        if call.external_write {
            tx.execute("INSERT INTO pi_external_effects(id,world_id,task_id,call_id,tool,args_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",params![uuid::Uuid::new_v4().to_string(),task["world_id"].as_str().unwrap_or(""),call.task_id,call.call_id,call.tool,hash,status,time,time])?;
        }
        tx.commit()?;
        Ok(if uncertain {
            BeginCall::Unknown
        } else {
            BeginCall::Execute
        })
    }
    pub fn finish_call(&self, call: &PiCallRequest, result: &Value) -> Result<()> {
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        complete_call_tx(&tx, call, result)?;
        tx.commit()?;
        Ok(())
    }
    pub fn stop(&self, task: &str) -> Result<()> {
        self.stop_guarded(task, |_| Ok(()))
    }
    pub(crate) fn stop_guarded(
        &self,
        task: &str,
        authorize: impl FnOnce(&Transaction<'_>) -> Result<()>,
    ) -> Result<()> {
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        authorize(&tx)?;
        let changed=tx.execute("UPDATE pi_tasks SET stop_revision=stop_revision+1,updated_at=? WHERE id=? AND status IN ('running','committing','waiting_user')",params![now(),task])?;
        if changed == 0 {
            return Err(invalid("当前任务没有运行或等待回答"));
        }
        tx.commit()?;
        Ok(())
    }
    pub fn append_input(
        &self,
        session: &str,
        task: Option<&str>,
        delivery: &str,
        content: &Value,
    ) -> Result<String> {
        self.append_input_guarded(session, task, delivery, content, |_| Ok(()))
    }
    pub(crate) fn append_input_guarded(
        &self,
        session: &str,
        task: Option<&str>,
        delivery: &str,
        content: &Value,
        authorize: impl FnOnce(&Transaction<'_>) -> Result<()>,
    ) -> Result<String> {
        self.append_named_input_guarded(session, task, delivery, content, None, authorize)
    }
    pub(crate) fn append_named_input_guarded(
        &self,
        session: &str,
        task: Option<&str>,
        delivery: &str,
        content: &Value,
        input_id: Option<&str>,
        authorize: impl FnOnce(&Transaction<'_>) -> Result<()>,
    ) -> Result<String> {
        if !["steer", "queued", "answer"].contains(&delivery) {
            return Err(invalid("输入处理方式无效"));
        }
        if delivery != "queued" && task.is_none() {
            return Err(invalid("补充与回答必须关联当前任务"));
        }
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        authorize(&tx)?;
        let id = input_id.map(str::to_owned).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if id.is_empty() || id.len() > 128 {
            return Err(invalid("输入标识无效"));
        }
        if let Some(old) = tx.query_row("SELECT session_id,task_id,delivery,content_json FROM pi_inputs WHERE id=?",[&id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).optional()? {
            let mut prior:Value=serde_json::from_str(&old.3)?;
            let mut expected=content.clone();
            if let Some(value)=prior.as_object_mut(){value.remove("nonce");}
            if let Some(value)=expected.as_object_mut(){value.remove("nonce");}
            if old.0 != session || old.1.as_deref()!=task || old.2!=delivery || prior!=expected {
                return Err(invalid("输入标识已用于其他内容，不能替换"));
            }
            tx.commit()?;
            return Ok(id);
        }
        let mut revision = None;
        if let Some(id) = task {
            let row = object_row(&tx, "pi_tasks", id)?;
            if row["session_id"] != session {
                return Err(invalid("不能把输入送往其他会话"));
            }
            if delivery != "queued" {
                if !["running", "waiting_user"].contains(&row["status"].as_str().unwrap_or("")) {
                    return Err(invalid("当前任务已结束，请新建任务"));
                }
                tx.execute(
                    "UPDATE pi_tasks SET intent_revision=intent_revision+1,updated_at=? WHERE id=?",
                    params![now(), id],
                )?;
                revision = Some(row["intent_revision"].as_i64().unwrap_or(0) + 1);
            }
        }
        let seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM pi_inputs WHERE session_id=?",
            [session],
            |r| r.get(0),
        )?;
        tx.execute("INSERT INTO pi_inputs(id,session_id,task_id,seq,delivery,content_json,intent_revision,created_at) VALUES(?,?,?,?,?,?,?,?)",params![id,session,task,seq,delivery,content.to_string(),revision,now()])?;
        tx.commit()?;
        Ok(id)
    }
    pub fn consume_input(&self, id: &str) -> Result<Value> {
        self.consume_input_guarded(id, |_, _| Ok(()))
    }
    pub(crate) fn consume_input_guarded(
        &self,
        id: &str,
        authorize: impl FnOnce(&Transaction<'_>, &Value) -> Result<()>,
    ) -> Result<Value> {
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let input = object_row(&tx, "pi_inputs", id)?;
        authorize(&tx, &input)?;
        if input["status"] == "delivered" {
            return Ok(input);
        }
        if input["status"] != "pending" {
            return Err(invalid("这条输入不能重复采用"));
        }
        if let Some(task) = input["task_id"]
            .as_str()
            .filter(|_| input["delivery"] != "queued")
        {
            let first:String=tx.query_row("SELECT id FROM pi_inputs WHERE task_id=? AND status='pending' AND delivery IN ('steer','answer') ORDER BY seq LIMIT 1",[task],|r|r.get(0))?;
            if first != id {
                return Err(invalid("请按收到顺序处理补充与回答"));
            }
            tx.execute(
                "UPDATE pi_tasks SET consumed_intent_revision=?,updated_at=? WHERE id=?",
                params![input["intent_revision"].as_i64(), now(), task],
            )?;
        }
        tx.execute("UPDATE pi_inputs SET status='delivered',delivered_at=? WHERE id=? AND status='pending'",params![now(),id])?;
        let result = object_row(&tx, "pi_inputs", id)?;
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn fixture() -> PiStore {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::migration::migrate(&mut db, None).unwrap();
        db.execute_batch("INSERT INTO worlds(id,title,era_id,created_at,updated_at,played_at) VALUES('world','隔离','free','test','test','test'); INSERT INTO nodes(id,world_id,seq,kind,created_at) VALUES('node','world',0,'opening','test'); INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('line','world','路线','node','test')").unwrap();
        let store = PiStore(Store(Arc::new(Mutex::new(db))));
        session_and_task(&store, "session", "task");
        store
    }
    fn session_and_task(store: &PiStore, session: &str, task: &str) {
        store
            .create_session(&NewSession {
                id: session.into(),
                world_id: "world".into(),
                line_id: "line".into(),
                title: "测试会话".into(),
                session_file: None,
            })
            .unwrap();
        store.create_task(&NewTask{id:task.into(),session_id:session.into(),text:"处理独立资料".into(),policy:"auto-reversible".into(),read_only:false,base:json!({}),world_version:"world-v1".into(),model:json!({"model":"test","apiKey":"owned-secret","headers":{"Authorization":"owned-secret"}}),metadata:json!({}),lease:json!({}),host_owner:"isolated-owner".into()}).unwrap();
    }
    fn call(task: &str) -> PiCallRequest {
        PiCallRequest {
            task_id: task.into(),
            call_id: "call-1".into(),
            tool: "stage_edit".into(),
            args: json!({"b":2,"a":1}),
            intent_revision: 0,
            world_version: "world-v1".into(),
            external_write: false,
        }
    }
    #[test]
    fn paired_calls_are_immutable_and_canonical_arguments_reuse_results() {
        let store = fixture();
        let mut request = call("task");
        assert_eq!(store.begin_call(&request).unwrap(), BeginCall::Execute);
        request.args = serde_json::from_str("{\"a\":1,\"b\":2}").unwrap();
        assert_eq!(store.begin_call(&request).unwrap(), BeginCall::InFlight);
        let result = json!({"ok":false,"error":{"code":"invalid_year"}});
        store.finish_call(&request, &result).unwrap();
        assert_eq!(
            store.begin_call(&request).unwrap(),
            BeginCall::Cached(result.clone())
        );
        request.args["a"] = 3.into();
        assert!(store.begin_call(&request).is_err());
        request.args["a"] = 1.into();
        request.tool = "another_tool".into();
        assert!(store.begin_call(&request).is_err());
        let saved = store.task("task").unwrap().to_string();
        assert!(!saved.contains("owned-secret"));
    }
    #[test]
    fn unknown_external_effect_and_story_recovery_survive_chat_deletion() {
        let store = fixture();
        let mut request = call("task");
        request.external_write = true;
        assert_eq!(store.begin_call(&request).unwrap(), BeginCall::Execute);
        store
            .finish_call(&request, &json!({"ok":false,"outcomeUnknown":true}))
            .unwrap();
        store.0.lock().unwrap().execute("INSERT INTO story_recovery_points(id,world_id,task_id,before_json,post_fingerprint,created_at) VALUES('restore','world','task','{}','world-v1','test')",[]).unwrap();
        store
            .0
            .lock()
            .unwrap()
            .execute("DELETE FROM pi_sessions WHERE id='session'", [])
            .unwrap();
        assert_eq!(
            store
                .0
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM story_recovery_points", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        session_and_task(&store, "new-session", "new-task");
        request.task_id = "new-task".into();
        assert_eq!(store.begin_call(&request).unwrap(), BeginCall::Unknown);
    }
    #[test]
    fn pending_requirements_stop_and_world_version_fence_commits() {
        let store = fixture();
        let check = |revision, world: &str| {
            let mut db = store.0.lock().unwrap();
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            guard_commit(&tx, "task", revision, world)
        };
        assert!(check(0, "world-v1").is_ok());
        let input = store
            .append_input(
                "session",
                Some("task"),
                "steer",
                &json!({"text":"保留原剧情"}),
            )
            .unwrap();
        assert!(check(0, "world-v1").is_err());
        assert!(check(1, "world-v1").is_err());
        store.consume_input(&input).unwrap();
        assert!(check(1, "world-v1").is_ok());
        assert!(check(1, "world-v2").is_err());
        store.stop("task").unwrap();
        assert!(matches!(check(1, "world-v1"), Err(Error::Cancelled)));
    }
}
