//! Model-window delivery receipts. A prepared tool result or an admitted HTTP
//! attempt alone is not proof that a successful model turn saw its contents.
use crate::{agent_workspace as ws, Error, Result};
use rusqlite::{params,Connection,OptionalExtension};
use serde_json::{json,Value};

fn transaction(db:&Connection)->Result<()> {
    if db.is_autocommit(){return Err(Error::Invalid("送达记录必须与本次权限或模型账本在同一事务中更新".into()));}Ok(())
}
pub(crate) fn source(db:&Connection,task:&str,call:&str)->Result<Option<Value>> {
    let raw:Option<String>=db.query_row("SELECT source_json FROM pi_tool_deliveries WHERE task_id=? AND call_id=?",params![task,call],|r|r.get(0)).optional()?;
    raw.map(|raw|serde_json::from_str(&raw).map_err(Error::from)).transpose()
}
// Evidence pages share large scope/configuration fields. Store that common
// frame once; expansion is exact, and delivery hashes still cover the actual
// model-visible payload. This never promotes undelivered text into evidence.
fn pack_pages(pages:&Value)->Value {
    let Some(items)=pages.as_array().filter(|v|!v.is_empty()) else{return pages.clone();};
    let mut frame=serde_json::Map::new();
    for (key,value) in items[0].as_object().into_iter().flatten(){
        if items.iter().all(|item|item.get(key)==Some(value)){frame.insert(key.clone(),value.clone());}
    }
    let entries=items.iter().map(|item|{let mut item=item.clone();if let Some(object)=item.as_object_mut(){for key in frame.keys(){object.remove(key);}}item}).collect::<Vec<_>>();
    json!({"format":"shared-page-frame-1","frame":frame,"entries":entries})
}
fn unpack_pages(packed:Value)->Vec<Value> {
    if let Some(items)=packed.as_array(){return items.clone();}
    if packed["format"]!="shared-page-frame-1"{return vec![];}
    packed["entries"].as_array().into_iter().flatten().map(|item|{let mut out=packed["frame"].clone();if let (Some(out),Some(item))=(out.as_object_mut(),item.as_object()){out.extend(item.clone());}out}).collect()
}
pub(crate) fn save(db:&Connection,task:&Value,call:&str,actor:&str,candidate:&Value)->Result<()> {
    transaction(db)?;
    if !candidate["deliveryHash"].as_str().is_some_and(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit()))||!candidate["pages"].is_array()||!candidate["source"].is_object() {return Err(Error::Invalid("原生证据候选格式无效".into()));}
    let pages=serde_json::to_string(&pack_pages(&candidate["pages"]))?;let source=serde_json::to_string(&candidate["source"])?;
    if pages.len()>256*1024||source.len()>256*1024 {return Err(Error::Invalid("原生证据候选超过保存上限，请缩小读取范围".into()));}
    db.execute("INSERT INTO pi_tool_deliveries(task_id,call_id,actor_id,delivery_hash,source_json,pages_json,world_version,intent_revision) VALUES(?,?,?,?,?,?,?,?)",params![ws::text(task,"id"),call,actor,candidate["deliveryHash"].as_str().unwrap(),source,pages,ws::text(task,"base_world_version"),task["consumed_intent_revision"].as_i64().unwrap_or(0)])?;
    Ok(())
}
pub(crate) fn admit(db:&Connection,task:&Value,request:&str,actor:&str,receipts:&Value,purpose:&str)->Result<()> {
    transaction(db)?;
    let Some(receipts)=receipts.as_array() else {if receipts.is_null(){return Ok(());}return Err(Error::Invalid("模型上下文送达清单无效".into()));};
    if receipts.len()>2048{return Err(Error::Invalid("上下文送达清单过长，请先整理上下文".into()));}
    if purpose=="compaction" {return Ok(());}
    let task_id=ws::text(task,"id");
    for receipt in receipts {
        let call=ws::text(receipt,"callId");let hash=ws::text(receipt,"hash");
        if call.len()>128||hash.len()!=64||!hash.bytes().all(|b|b.is_ascii_hexdigit()){return Err(Error::Invalid("模型上下文送达定位无效".into()));}
        // A shortened/replaced tool result can remain valid model context.
        // It simply cannot claim the larger original payload as read evidence.
        let candidate:Option<(String,i64)>=db.query_row("SELECT d.world_version,d.intent_revision FROM pi_tool_deliveries d JOIN pi_calls c ON c.task_id=d.task_id AND c.call_id=d.call_id WHERE d.task_id=? AND d.call_id=? AND d.actor_id=? AND d.delivery_hash=? AND c.tool=? AND c.status='done'",params![task_id,call,actor,hash,ws::text(receipt,"tool")],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((world,intent))=candidate else {continue;};
        if task["base_world_version"]!=world||intent>task["consumed_intent_revision"].as_i64().unwrap_or(0){continue;}
        db.execute("INSERT OR IGNORE INTO pi_context_deliveries(task_id,request_id,actor_id,call_id,delivery_hash,world_version,intent_revision,status) VALUES(?,?,?,?,?,?,?,'admitted')",params![task_id,request,actor,call,hash,world,task["consumed_intent_revision"].as_i64().unwrap_or(0)])?;
    }
    Ok(())
}
pub(crate) fn confirm(db:&Connection,task:&str,request:&str,accepted:bool)->Result<()> {
    transaction(db)?;
    if accepted {
        db.execute("UPDATE pi_context_deliveries SET status='accepted' WHERE task_id=? AND request_id=? AND EXISTS(SELECT 1 FROM pi_model_requests m WHERE m.task_id=pi_context_deliveries.task_id AND m.request_id=pi_context_deliveries.request_id AND m.status='success')",params![task,request])?;
    }
    Ok(())
}
pub(crate) fn pages(db:&Connection,task:&Value)->Result<Value> {
    let mut stmt=db.prepare("SELECT DISTINCT d.call_id,d.actor_id,d.pages_json,d.delivery_hash FROM pi_tool_deliveries d JOIN pi_context_deliveries r ON r.task_id=d.task_id AND r.call_id=d.call_id AND r.delivery_hash=d.delivery_hash WHERE d.task_id=? AND r.status='accepted' AND d.world_version=? AND r.intent_revision=? AND (d.actor_id='' OR EXISTS(SELECT 1 FROM pi_children c WHERE c.task_id=d.task_id AND c.id=d.actor_id AND c.status='answered' AND c.intent_revision=?)) ORDER BY d.rowid DESC LIMIT 1000")?;
    let intent=task["consumed_intent_revision"].as_i64().unwrap_or(0);
    let rows=stmt.query_map(params![ws::text(task,"id"),ws::text(task,"base_world_version"),intent,intent],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?;
    let mut pages=vec![];
    for row in rows {let(call,actor,raw,hash)=row?;let value:Value=serde_json::from_str(&raw)?;for mut page in unpack_pages(value){
        if ["snippet","auxiliary"].contains(&ws::text(&page,"sourceKind")){continue;}
        page["callId"]=call.clone().into();page["actorId"]=actor.clone().into();page["deliveryConfirmed"]=true.into();
        page["confirmedIntentRevision"]=intent.into();
        page["id"]=crate::pi_store::arguments_hash(&json!({"callId":call,"actor":actor,"hash":hash,"path":page["deliveredPath"],"start":page["start"],"end":page["end"]})).into();
        if page["sourceKind"]!="external" {page["location"]=json!({"bookId":page["bookId"],"section":page["section"],"chunk":page["chunk"],"title":page["title"],"page":page["page"],"path":page["sourcePath"],"offset":page["start"]});}
        page["snapshot"]=json!({"worldVersion":page["worldVersion"]});pages.push(page);
    }}
    Ok(json!(pages))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->(Connection,Value) {
        let mut db=Connection::open_in_memory().unwrap();crate::migration::migrate(&mut db,None).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;INSERT INTO worlds(id,title,era_id,created_at,updated_at,played_at) VALUES('w','隔离','free','test','test','test');INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('s','w','l','隔离','test','test');INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,base_json,base_world_version,created_at,updated_at) VALUES('t','s','w','l','查原著','running','auto','{}','v1','test','test');INSERT INTO pi_calls(task_id,call_id,tool,args_hash,world_version,intent_revision,external_write,status,output_json,created_at,updated_at) VALUES('t','read','read_original','h','v1',0,0,'done','{}','test','test')").unwrap();
        (db,json!({"id":"t","base_world_version":"v1","consumed_intent_revision":0}))
    }
    fn candidate()->Value {json!({"deliveryHash":"a".repeat(64),"source":{"rootTool":"read_original"},"pages":[{"sourceKind":"original","quote":"这是本机原文中的准确原句。","worldVersion":"v1","bookId":"b","section":0,"chunk":0,"title":"真实章名","start":0,"end":15,"sourcePath":"/excerpts/0/text"}]})}
    fn receipts()->Value{json!([{"callId":"read","tool":"read_original","hash":"a".repeat(64)}])}
    #[test] fn large_repeated_scope_is_stored_once_without_changing_evidence_pages(){
        let(mut db,task)=fixture();let mut candidate=candidate();
        candidate["pages"]=json!((0..512).map(|i|json!({"sourceKind":"world","worldVersion":"v1","quote":format!("资料{i}"),"path":format!("/value/{i}"),"referenceScope":{"bookId":"b","through":4,"instructions":"长说明".repeat(1000)}})).collect::<Vec<_>>());
        assert!(candidate["pages"].to_string().len()>256*1024);
        let tx=db.transaction().unwrap();save(&tx,&task,"read","",&candidate).unwrap();tx.commit().unwrap();
        let saved:String=db.query_row("SELECT pages_json FROM pi_tool_deliveries WHERE call_id='read'",[],|r|r.get(0)).unwrap();assert!(saved.len()<256*1024);
        assert_eq!(json!(unpack_pages(serde_json::from_str(&saved).unwrap())),candidate["pages"]);
    }
    #[test]
    fn only_a_successful_model_turn_confirms_text_and_compaction_never_grants_evidence() {
        let(mut db,task)=fixture();
        let tx=db.transaction().unwrap();save(&tx,&task,"read","",&candidate()).unwrap();tx.commit().unwrap();
        assert!(pages(&db,&task).unwrap().as_array().unwrap().is_empty(),"saving full results never means read");
        for(id,purpose,status,accepted,count)in [("failed","model","failed",false,0),("summary","compaction","success",true,0),("actual","model","success",true,1)] {
            let tx=db.transaction().unwrap();crate::pi_budget::reserve_model(&tx,"t",id,purpose,&json!({})).unwrap();admit(&tx,&task,id,"",&receipts(),purpose).unwrap();
            assert!(pages(&tx,&task).unwrap().as_array().unwrap().is_empty());
            crate::pi_budget::finish_model(&tx,"t",id,&json!({"input":10,"output":2}),status).unwrap();confirm(&tx,"t",id,accepted).unwrap();tx.commit().unwrap();
            assert_eq!(pages(&db,&task).unwrap().as_array().unwrap().len(),count);
        }
        let proven=pages(&db,&task).unwrap();assert_eq!(proven[0]["deliveryConfirmed"],true);assert_eq!(proven[0]["location"]["title"],"真实章名");assert!(proven[0]["id"].is_string());
        let mut next=task.clone();next["consumed_intent_revision"]=1.into();assert!(pages(&db,&next).unwrap().as_array().unwrap().is_empty(),"new instructions do not automatically upgrade an old read acknowledgement");
        let tx=db.transaction().unwrap();crate::pi_budget::reserve_model(&tx,"t","new-intent","model",&json!({})).unwrap();admit(&tx,&next,"new-intent","",&receipts(),"model").unwrap();crate::pi_budget::finish_model(&tx,"t","new-intent",&json!({}),"success").unwrap();confirm(&tx,"t","new-intent",true).unwrap();tx.commit().unwrap();
        assert_eq!(pages(&db,&next).unwrap()[0]["confirmedIntentRevision"],1);
    }
    #[test]
    fn changed_payload_actor_or_world_cannot_claim_the_original_candidate() {
        let(mut db,task)=fixture();let tx=db.transaction().unwrap();save(&tx,&task,"read","",&candidate()).unwrap();
        for(id,actor,wrong_hash)in[("wrong-hash","",true),("wrong-actor","other",false)] {
            crate::pi_budget::reserve_model(&tx,"t",id,"model",&json!({})).unwrap();let mut list=receipts();if wrong_hash{list[0]["hash"]="b".repeat(64).into();}
            admit(&tx,&task,id,actor,&list,"model").unwrap();crate::pi_budget::finish_model(&tx,"t",id,&json!({}),"success").unwrap();confirm(&tx,"t",id,true).unwrap();
        }
        tx.commit().unwrap();assert!(pages(&db,&task).unwrap().as_array().unwrap().is_empty());
        let tx=db.transaction().unwrap();crate::pi_budget::reserve_model(&tx,"t","old-world","model",&json!({})).unwrap();let mut changed=task.clone();changed["base_world_version"]="v2".into();admit(&tx,&changed,"old-world","",&receipts(),"model").unwrap();crate::pi_budget::finish_model(&tx,"t","old-world",&json!({}),"success").unwrap();confirm(&tx,"t","old-world",true).unwrap();tx.commit().unwrap();
        assert!(pages(&db,&changed).unwrap().as_array().unwrap().is_empty());
    }
}
