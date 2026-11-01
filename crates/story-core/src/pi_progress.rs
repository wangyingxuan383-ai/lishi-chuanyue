//! Measurements trigger an AI review; they never decide that a task is looping.
use crate::{agent_workspace as ws,pi_store::{arguments_hash,PiCallRequest},Error,Result};
use rusqlite::{params,Connection};
use serde_json::{json,Value};
fn clean(value:&Value)->Value {match value {Value::Object(items)=>Value::Object(items.iter().filter(|(k,_)|!["read","callId","storedResult","updatedAt","createdAt"].contains(&k.as_str())).map(|(k,v)|(k.clone(),clean(v))).collect()),Value::Array(items)=>json!(items.iter().map(clean).collect::<Vec<_>>()),v=>v.clone()}}
pub(crate) fn observe(db:&Connection,call:&PiCallRequest,result:&Value)->Result<()> {
    let data=&result["data"];
    let key=arguments_hash(&json!([call.world_version,call.tool,clean(&call.args),clean(result)]));
    let readable=result["ok"]==true&&crate::agent_policy::read_only(&call.tool)&&!matches!(call.tool.as_str(),"read_plan"|"check_draft"|"validate_changes"|"update_plan"|"ask_user"|"discover_tools")&&data["largeItem"]!=true&&data["directoryOnly"]!=true&&data["paged"]!=true&&(data.get("value").is_some_and(|v|!v.is_null()&&!v.as_array().is_some_and(Vec::is_empty))||data["text"].as_str().is_some_and(|s|!s.is_empty())||["excerpts","resources"].iter().any(|key|data[*key].as_array().is_some_and(|v|!v.is_empty())));
    let summary=json!({"tool":call.tool,"range":clean(&call.args),"ok":result["ok"],"error":result["error"]["code"],"fingerprint":key});
    let summary=summary.to_string().chars().take(1000).collect::<String>();
    db.execute("INSERT OR IGNORE INTO pi_progress_calls(task_id,call_id,fingerprint,coverage,summary) VALUES(?,?,?,?,?)",params![call.task_id,call.call_id,key,if readable{Some(key.as_str())}else{None},summary])?;Ok(())
}
fn meta(task:&Value)->Value{task["metadata_json"].as_str().map(ws::parse).unwrap_or_else(||task["metadata_json"].clone())}
fn save(db:&Connection,task:&Value,meta:&Value)->Result<()>{db.execute("UPDATE pi_tasks SET metadata_json=? WHERE id=?",params![meta.to_string(),ws::text(task,"id")])?;Ok(())}
fn net_draft(workspace:&Value)->Value {
    let routes=workspace["routes"].as_array().cloned().unwrap_or_default();
    let normalize_route=|id:&Value| routes.iter().find(|r|r["id"]==*id).map(|r|json!({"headId":r["headId"],"activate":r["activate"]})).unwrap_or_else(||id.clone());
    json!({"edits":workspace["edits"].as_array().into_iter().flatten().filter(|e|e["original"]!=e["after"]).map(|e|json!({"kind":e["kind"],"id":e["id"],"route":normalize_route(&e["routeId"]),"after":e["after"]})).collect::<Vec<_>>(),"routes":routes.iter().map(|r|json!({"headId":r["headId"],"activate":r["activate"]})).collect::<Vec<_>>(),"turns":workspace["turns"].as_array().into_iter().flatten().map(|t|json!({"narrative":t["narrative"],"record":t["record"]})).collect::<Vec<_>>()})
}
fn signature(db:&Connection,task:&Value)->Result<Value>{
    let id=ws::text(task,"id");let coverage:i64=db.query_row("SELECT COUNT(DISTINCT coverage) FROM pi_progress_calls WHERE task_id=?",[id],|r|r.get(0))?;
    let workspace=task["workspace_json"].as_str().map(ws::parse).unwrap_or_else(||task["workspace_json"].clone());
    let valid:Option<String>=db.query_row("SELECT fingerprint FROM pi_progress_calls WHERE task_id=? AND summary LIKE '%validate_changes%' AND json_extract(summary,'$.ok')=1 ORDER BY seq DESC LIMIT 1",[id],|r|r.get(0)).ok();
    Ok(json!({"coverage":coverage,"draft":arguments_hash(&net_draft(&workspace)),"validation":valid}))
}
pub(crate) fn prepare(db:&Connection,task:&Value)->Result<Value>{
    if task["status"]!="running"||task["stop_revision"].as_i64().unwrap_or(0)>0{return Ok(Value::Null);}
    let id=ws::text(task,"id");let rounds:i64=db.query_row("SELECT COUNT(*) FROM pi_model_requests WHERE task_id=? AND source='model' AND status='success'",[id],|r|r.get(0))?;
    let mut metadata=meta(task);let mut state=metadata["progressReview"].clone();if !state.is_object(){state=json!({});}
    let actual=signature(db,task)?;
    let mut seen=state["seenDrafts"].as_array().cloned().unwrap_or_default();
    let new_draft=!seen.contains(&actual["draft"]);
    let changed=state["progress"]["coverage"]!=actual["coverage"] || state["progress"]["validation"]!=actual["validation"] || new_draft;
    if changed {state["lastProgressRound"]=rounds.into();}
    state["progress"]=actual.clone();
    if new_draft {seen.push(actual["draft"].clone());if seen.len()>64{seen.remove(0);}}
    state["seenDrafts"]=json!(seen);
    let pending=state["pending"].clone();
    if pending.is_object()&&pending["intentRevision"]==task["intent_revision"]&&pending["worldVersion"]==task["base_world_version"] {return Ok(pending);}
    state["pending"]=Value::Null;
    let mut stmt=db.prepare("SELECT fingerprint,summary FROM pi_progress_calls WHERE task_id=? ORDER BY seq DESC LIMIT 32")?;
    let recent=stmt.query_map([id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let repeated=recent.iter().any(|(key,_)|recent.iter().filter(|(k,_)|k==key).count()>=3);
    let cycle=(2..=8).any(|n|recent.len()>=n*2&&recent[..n].iter().map(|r|&r.0).eq(recent[n..n*2].iter().map(|r|&r.0)));
    let idle=rounds-state["lastProgressRound"].as_i64().unwrap_or(rounds)>=8;
    let allowed=rounds>=4&&rounds-state["lastReviewRound"].as_i64().unwrap_or(0)>=4;
    let request=if allowed&&(repeated||cycle||idle){
        let request=json!({"id":ws::id(),"intentRevision":task["intent_revision"],"worldVersion":task["base_world_version"],"round":rounds,"trigger":{"repeated":repeated,"cycle":cycle,"noProgressRounds":rounds-state["lastProgressRound"].as_i64().unwrap_or(rounds)},"goal":ws::text(task,"text").chars().take(7000).collect::<String>(),"constraints":metadata["skills"],"contextCheckpoint":metadata["contextCheckpoint"],"actual":actual,"recent":recent.iter().take(16).map(|r|ws::parse(&r.1)).collect::<Vec<_>>(),"note":"只复核执行方法和实际进展；重复也可能是正常批处理、资料变化或压缩后回读。不要把计划改字当作进展，不判断原著事实，不扩大授权。"});
        state["lastReviewRound"]=rounds.into();state["pending"]=request.clone();metadata["executionPhase"]="reviewing".into();request
    }else{Value::Null};
    metadata["progressReview"]=state;save(db,task,&metadata)?;Ok(request)
}
pub(crate) fn decide(db:&Connection,task:&Value,args:&Value)->Result<Value>{
    let mut metadata=meta(task);let pending=metadata["progressReview"]["pending"].clone();
    if !pending.is_object()||args["id"]!=pending["id"]||pending["worldVersion"]!=task["base_world_version"]||pending["intentRevision"]!=task["intent_revision"]||task["stop_revision"].as_i64().unwrap_or(0)>0 {return Err(Error::Stale);}
    let decision=ws::text(args,"decision");if !["continue","replan","pause","ask_user","failed"].contains(&decision){return Err(Error::Invalid("进展复核结论无效".into()));}
    let reason=ws::text(args,"reason").chars().take(3000).collect::<String>();if reason.trim().is_empty(){return Err(Error::Invalid("进展复核缺少依据和继续建议".into()));}
    let guidance=json!({"kind":"system_runtime_notice","decision":decision,"reason":reason,"reviewId":pending["id"],"trigger":pending["trigger"],"actual":pending["actual"],"round":pending["round"],"notPlayerAuthorization":true,"notCanonEvidence":true});
    metadata["runtimeGuidance"]=guidance.clone();metadata["progressReview"]["pending"]=Value::Null;metadata["executionPhase"]="working".into();save(db,task,&metadata)?;
    if decision=="ask_user" {crate::pi_questions::ask(db,task,&json!({"title":"需要补充后继续","questions":[{"id":"progress","question":reason}]}))?;}
    if ["pause","failed"].contains(&decision){db.execute("UPDATE pi_tasks SET status='paused',error=?,updated_at=? WHERE id=?",params![format!("{}：{}",if decision=="failed"{"进展复核故障，进度已保存"}else{"助手保存进度并暂停"},reason),ws::now(),ws::text(task,"id")])?;}
    Ok(json!({"decision":decision,"paused":(["pause","failed","ask_user"].contains(&decision)),"guidance":guidance}))
}

#[cfg(test)]
mod tests {
 use super::*;
 use crate::pi_lifecycle::tests::fixture;
 fn rounds(db:&Connection,n:i64){db.execute("DELETE FROM pi_model_requests WHERE task_id='t'",[]).unwrap();for i in 0..n{db.execute("INSERT INTO pi_model_requests(task_id,request_id,source,model_json,status,started_at) VALUES('t',?,'model','{}','success','test')",[format!("m{i}")]).unwrap();}}
 fn row(db:&Connection)->Value {ws::rows(db,"SELECT * FROM pi_tasks WHERE id='t'",&[]).unwrap().remove(0)}
 #[test] fn repeating_calls_only_request_review_and_decisions_are_versioned(){
  let(store,_,_)=fixture();let db=store.lock().unwrap();rounds(&db,4);
  let call=PiCallRequest{task_id:"t".into(),call_id:"c".into(),tool:"read_resource".into(),args:json!({"kind":"state","path":"/time"}),intent_revision:0,world_version:"v".into(),external_write:false};
  for i in 0..3 {let mut call=call.clone();call.call_id=format!("c{i}");observe(&db,&call,&json!({"ok":true,"data":{"value":{"elapsedMinutes":0}}})).unwrap();}
  let pending=prepare(&db,&row(&db)).unwrap();assert!(pending["id"].is_string());assert_eq!(row(&db)["status"],"running","detector must not pause by itself");
  assert_eq!(decide(&db,&row(&db),&json!({"id":pending["id"],"decision":"replan","reason":"重复读取同一时钟，改为批量时间线"})).unwrap()["paused"],false);
  assert!(prepare(&db,&row(&db)).unwrap().is_null(),"review no more than once per four main rounds");
  rounds(&db,8);let pending=prepare(&db,&row(&db)).unwrap();db.execute("UPDATE pi_tasks SET intent_revision=1 WHERE id='t'",[]).unwrap();
  assert!(matches!(decide(&db,&row(&db),&json!({"id":pending["id"],"decision":"pause","reason":"旧判断"})),Err(Error::Stale)));
 }
 #[test] fn normal_unique_reading_is_progress_but_plan_edits_are_not(){
  let(store,_,_)=fixture();let db=store.lock().unwrap();
  for i in 0..12 {rounds(&db,i);let call=PiCallRequest{task_id:"t".into(),call_id:format!("c{i}"),tool:"read_resource".into(),args:json!({"kind":"node","id":format!("n{i}"),"path":"/time"}),intent_revision:0,world_version:"v".into(),external_write:false};observe(&db,&call,&json!({"ok":true,"data":{"value":{"time":i}}})).unwrap();assert!(prepare(&db,&row(&db)).unwrap().is_null());}
  for i in 12..20 {rounds(&db,i);db.execute("UPDATE pi_tasks SET plan_json=? WHERE id='t'",[json!([{"title":format!("改字{i}"),"status":"in_progress"}]).to_string()]).unwrap();let request=prepare(&db,&row(&db)).unwrap();if i<19{assert!(request.is_null());}else{assert!(request["id"].is_string());}}
 }
 #[test] fn autonomous_pause_question_and_review_failure_preserve_draft(){
  for decision in ["pause","ask_user","failed"] {let(store,_,_)=fixture();let mut guard=store.lock().unwrap();let tx=guard.transaction().unwrap();let db=&*tx;db.execute("UPDATE pi_tasks SET workspace_json='{\"edits\":[1]}',metadata_json=json_set(metadata_json,'$.progressReview.pending',json(?)) WHERE id='t'",[json!({"id":"review","intentRevision":0,"worldVersion":row(&db)["base_world_version"]}).to_string()]).unwrap();
   decide(&db,&row(&db),&json!({"id":"review","decision":decision,"reason":"需要确认原著日期；草稿保留，明确继续"})).unwrap();assert_eq!(row(&db)["workspace_json"],"{\"edits\":[1]}");assert_eq!(row(&db)["status"],if decision=="ask_user"{"waiting_user"}else{"paused"});assert!(!meta(&row(&db))["runtimeGuidance"]["notPlayerAuthorization"].is_null());}
 }
}
