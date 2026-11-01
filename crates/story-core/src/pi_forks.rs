//! Conversation branches are independent of story branches and recovery.
use crate::{agent_workspace as ws, Error, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn invalid(message: &str) -> Error { Error::Invalid(message.into()) }
fn hash(text: &str) -> String {format!("{:x}",Sha256::digest(text.as_bytes()))}
fn event(value:&Value)->&Value {value.get("event").filter(|v|v.is_object()).unwrap_or(value)}

/// Record only anchors corroborated by the current task's durable messages or
/// exact input nonce. An entry ID from a UI/model is never accepted here.
pub(crate) fn record_anchor(db:&Connection, task_id:&str, record:&Value)->Result<()> {
    let item=event(record);
    if item["type"]!="message_anchor" || record["childId"].is_string() || item["childId"].is_string() {return Ok(());}
    let entry=ws::text(item,"entryId");
    if entry.is_empty()||entry.len()>128||!entry.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_'){return Err(invalid("Pi消息定位无效"));}
    let message_id=if item["role"]=="user" {
        let goal:String=db.query_row("SELECT text FROM pi_tasks WHERE id=?",[task_id],|r|r.get(0))?;
        if item["userHash"]==hash(&goal) {Some(format!("{task_id}:user"))} else {
            let inputs=ws::rows(db,"SELECT id,content_json FROM pi_inputs WHERE task_id=? AND delivery IN ('steer','answer') ORDER BY seq",&[&task_id])?;
            inputs.iter().find_map(|input| {
                let body=ws::parse(ws::text(input,"content_json"));
                let wire=crate::pi_runtime::input_wire(ws::text(input,"id"),ws::text(&body,"nonce"),ws::text(&body,"text"));
                (item["userHash"]==hash(&wire)).then(||format!("{task_id}:input:{}",ws::text(input,"id")))
            })
        }
    } else if item["role"]=="assistant" {
        let key=ws::text(item,"messageKey");
        let events=ws::rows(db,"SELECT event_json FROM pi_events WHERE task_id=? ORDER BY seq DESC LIMIT 16",&[&task_id])?;
        let found=events.iter().any(|row|{
            let raw=ws::parse(ws::text(row,"event_json"));let prior=event(&raw);let m=&prior["message"];
            let prior_key=m["id"].as_str().map(|s|format!("id:{s}")).or_else(||m["timestamp"].as_i64().map(|t|format!("at:{t}"))).unwrap_or_default();
            prior["type"]=="message_end"&&m["role"]=="assistant"&& !key.is_empty()&&key==prior_key && !raw["childId"].is_string()
        });
        found.then(||format!("{task_id}:assistant:{key}"))
    } else {None};
    if let Some(id)=message_id {
        // Continuation may repeat the initial request. Preserve its first
        // branch anchor, rather than silently moving an existing UI message.
        db.execute("INSERT OR IGNORE INTO pi_message_anchors(task_id,message_id,entry_id) VALUES(?,?,?)",params![task_id,id,entry])?;
    }
    Ok(())
}

pub(crate) fn anchor(db:&Connection,session:&str,message:&str)->Result<String> {
    let anchor:Option<String>=db.query_row("SELECT a.entry_id FROM pi_message_anchors a JOIN pi_tasks t ON t.id=a.task_id WHERE t.session_id=? AND a.message_id=? UNION ALL SELECT entry_id FROM pi_session_messages WHERE session_id=? AND message_id=? LIMIT 1",params![session,message,session,message],|r|r.get(0)).optional()?;
    anchor.ok_or_else(||invalid("这条消息尚无完整Pi定位，不能从不完整过程另起对话"))
}

pub(crate) fn inherited(db:&Connection,session:&str)->Result<Vec<Value>> {
    let rows=ws::rows(db,"SELECT message_json FROM pi_session_messages WHERE session_id=? ORDER BY seq",&[&session])?;
    Ok(rows.iter().map(|r|ws::parse(ws::text(r,"message_json"))).collect())
}

pub(crate) fn save_history(db:&Connection,source:&str,target:&str,kept:&Value,messages:&[Value])->Result<()> {
    let ids=kept.as_array().filter(|v|v.len()<=200_000).ok_or_else(||invalid("Pi分支消息定位无效"))?;
    let mut count=0; let mut bytes=0;
    for message in messages {
        let entry=anchor(db,source,ws::text(message,"id"));
        let Ok(entry)=entry else {continue;};
        if !ids.iter().any(|v|v==&entry){continue;}
        bytes+=message.to_string().len();count+=1;
        if bytes>8*1024*1024||count>10_000{return Err(invalid("本次对话分支过长，尚未保存，请选择较近的位置"));}
        let mut copy=message.clone();let id=format!("{target}:history:{count}");
        copy["id"]=id.clone().into();copy["sessionId"]=target.into();
        // Historical projection is never a resumable task or a fresh proof.
        copy.as_object_mut().unwrap().remove("taskId");copy["status"]="archived".into();
        db.execute("INSERT INTO pi_session_messages(session_id,seq,message_id,entry_id,message_json) VALUES(?,?,?,?,?)",params![target,count,id,entry,copy.to_string()])?;
    }
    Ok(())
}

#[cfg(test)] mod tests {
    use super::*;
    use serde_json::json;
    #[test] fn anchors_require_exact_input_and_completed_root_message() {
        let db=Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE pi_tasks(id TEXT,text TEXT,session_id TEXT);CREATE TABLE pi_inputs(id TEXT,task_id TEXT,content_json TEXT,delivery TEXT,seq INTEGER);CREATE TABLE pi_events(task_id TEXT,seq INTEGER,event_json TEXT);CREATE TABLE pi_message_anchors(task_id TEXT,message_id TEXT,entry_id TEXT,UNIQUE(task_id,message_id),UNIQUE(task_id,entry_id));CREATE TABLE pi_session_messages(session_id TEXT,seq INTEGER,message_id TEXT,entry_id TEXT,message_json TEXT);").unwrap();
        db.execute("INSERT INTO pi_tasks VALUES('t','原始目标','s')",[]).unwrap();
        record_anchor(&db,"t",&json!({"event":{"type":"message_anchor","role":"user","entryId":"fake","userHash":hash("别的内容")}})).unwrap();
        assert!(anchor(&db,"s","t:user").is_err());
        record_anchor(&db,"t",&json!({"event":{"type":"message_anchor","role":"user","entryId":"user1","userHash":hash("原始目标")}})).unwrap();
        assert_eq!(anchor(&db,"s","t:user").unwrap(),"user1");
        db.execute("INSERT INTO pi_events VALUES('t',1,?)",[json!({"event":{"type":"message_end","message":{"role":"assistant","timestamp":12}}}).to_string()]).unwrap();
        record_anchor(&db,"t",&json!({"event":{"type":"message_anchor","role":"assistant","entryId":"assistant1","messageKey":"at:12"}})).unwrap();
        assert_eq!(anchor(&db,"s","t:assistant:at:12").unwrap(),"assistant1");
        record_anchor(&db,"t",&json!({"childId":"other","event":{"type":"message_anchor","role":"assistant","entryId":"bad","messageKey":"at:12"}})).unwrap();
        assert_eq!(anchor(&db,"s","t:assistant:at:12").unwrap(),"assistant1");
    }
}
