//! Read-only continuation preflight. No lease, Node boot or model request.
use crate::{agent_workspace as ws, pi_budget, execution_lease as lease, Error, Result, Store};
use serde_json::{json, Value};

pub fn check(store:&Store, request:&Value)->Result<Value> {
    let db=store.lock()?;
    let id=ws::text(request,"taskId");
    let task=ws::rows(&db,"SELECT id,world_id,line_id,status,base_json,metadata_json,model_json FROM pi_tasks WHERE id=?",&[&id])?.into_iter().next().ok_or_else(||Error::Invalid("任务不存在，旧引擎对话不能恢复执行".into()))?;
    let meta=ws::parse(ws::text(&task,"metadata_json"));
    let usage=pi_budget::read_budget(&db,id)?;
    let limits=pi_budget::limits(request.get("limits").filter(|v|!v.is_null()).unwrap_or(&meta["limits"]))?;
    let mut reason=""; let mut message=String::new();
    if !["interrupted","cancelled","paused","failed","blocked","running","stale"].contains(&ws::text(&task,"status")) {
        reason="task_not_resumable";message="这项任务当前不能继续，请先完成正在等待的操作".into();
    }
    if meta["restoreContextMissing"]==true {reason="restore_context_missing";message="这份旧备份没有匹配的Pi会话文件；要求、回答和草稿已保留，请另起对话重新核对，不能接上较新的会话内容".into();}
    if let Some(live)=lease::current(&db,ws::text(&task,"world_id"))? {
        if !live.ticket.owner_id.is_empty() && live.expires_at_ms>lease::now_ms(){reason="execution_active";message="原执行尚未停止，请等待收尾后继续".into();}
    }
    for (field,label) in [("modelRequests","模型请求"),("toolCalls","工具调用"),("activeMs","活动时间")] {
        let cap=limits[field].as_u64().unwrap_or(0);let used=usage[field].as_u64().unwrap_or(0);
        if reason.is_empty()&&cap>0&&used>=cap {reason="budget_exhausted";message=if field=="activeMs"{format!("活动时间已用{:.1}分钟，上限{:.1}分钟；请调整执行设置后继续，累计用量保留",used as f64/60000.0,cap as f64/60000.0)}else{format!("{label}已用{used}次，上限{cap}次；请调整执行设置后继续，累计用量保留")};}
    }
    let base=ws::parse(ws::text(&task,"base_json"));
    let current=ws::base(&db,ws::text(&task,"world_id"),ws::text(&base,"lineId"));
    let route_changed=current.is_err();
    let story_changed=current.as_ref().is_ok_and(|v|v["fingerprint"]!=base["fingerprint"]);
    if reason.is_empty()&&route_changed {reason="route_changed";message="当前故事已切换路线；可以回到原路线继续，或在当前路线另起核对".into();}
    if reason.is_empty()&&story_changed&&request["recheck"]!=true {reason="story_version_changed";message="故事已有新进展，原要求与草稿保留；继续前需按最新版本重新核对".into();}
    Ok(json!({"canContinue":reason.is_empty(),"reasonCode":reason,"message":message,"used":usage,"limits":limits,"storyChanged":story_changed,"routeChanged":route_changed,"needsRebase":story_changed,"worldId":task["world_id"],"lineId":base["lineId"],"currentLineId":db.query_row("SELECT current_line_id FROM worlds WHERE id=?",[ws::text(&task,"world_id")],|r|r.get::<_,String>(0))?}))
}
/// Explicit player route choice only; never selected by a model tool.
pub fn select_original_route(store:&Store,request:&Value)->Result<Value> {
    let mut db=store.lock()?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    crate::maintenance::guard(&tx)?;
    let task=ws::rows(&tx,"SELECT * FROM pi_tasks WHERE id=?",&[&ws::text(request,"taskId")])?.into_iter().next().ok_or_else(||Error::Invalid("任务不存在".into()))?;
    let world=ws::text(&task,"world_id");
    if lease::current(&tx,world)?.is_some_and(|l|!l.ticket.owner_id.is_empty()&&l.expires_at_ms>lease::now_ms()){return Err(Error::Invalid("请先停止当前生成，再选择路线".into()));}
    let current:String=tx.query_row("SELECT current_line_id FROM worlds WHERE id=?",[world],|r|r.get(0))?;
    if current!=ws::text(request,"currentLineId"){return Err(Error::Invalid("路线再次变化，请重新打开选择".into()));}
    let base=ws::parse(ws::text(&task,"base_json"));let line=ws::text(&base,"lineId");
    if !tx.query_row("SELECT EXISTS(SELECT 1 FROM lines WHERE id=? AND world_id=?)",rusqlite::params![line,world],|r|r.get::<_,bool>(0))?{return Err(Error::Invalid("原路线已不存在，请在当前路线另起核对".into()));}
    tx.execute("UPDATE worlds SET current_line_id=? WHERE id=?",rusqlite::params![line,world])?;tx.commit()?;
    Ok(json!({"worldId":world,"lineId":line}))
}
pub fn ensure(store:&Store,request:&Value)->Result<()> {
    let result=check(store,request)?;
    if result["canContinue"]!=true {return Err(Error::Tool{code:match ws::text(&result,"reasonCode"){"budget_exhausted"=>"budget_exhausted","route_changed"=>"route_changed","story_version_changed"=>"story_version_changed",_=>"resume_unavailable"},field:"taskId",message:ws::text(&result,"message").into(),next:result});}
    Ok(())
}

#[cfg(test)] mod tests {
 use super::*;
 #[test] fn context_projection_tracks_only_matching_attempt_and_is_persistent(){
  let (store,_,attempt)=crate::pi_lifecycle::tests::fixture();
  let pi=crate::pi_store::PiStore(store.clone());
  let event=|a:&str,used:i64|json!({"event":{"type":"context_state","data":{"attemptId":a,"usedTokens":used,"effectiveInputBudgetTokens":475000,"measurement":"estimated","lastRequestInputTokens":420000,"compactions":2}}});
  pi.event("t",&event(&attempt,12000)).unwrap();pi.event("t",&event(&attempt,18000)).unwrap();
  pi.event("t",&event("old-attempt",999)).unwrap();
  let task=pi.task("t").unwrap();assert_eq!(task["metadata_json"]["contextState"]["usedTokens"],18000);assert_eq!(task["metadata_json"]["contextState"]["compactions"],2);
 }
 #[test] fn exhausted_limit_is_reported_before_any_lease_or_sdk_mutation() {
  let (store,_,attempt)=crate::pi_lifecycle::tests::fixture();
  crate::pi_lifecycle::settle(&store,"t",&attempt,"隔离任务").unwrap();
  {let db=store.lock().unwrap();db.execute("UPDATE pi_tasks SET metadata_json=json_set(metadata_json,'$.activityClock.activeMs',1800807,'$.activityClock.startedMs',NULL,'$.limits.activeMs',1800000) WHERE id='t'",[]).unwrap();}
  let before=store.lock().unwrap().query_row("SELECT lease_json FROM pi_tasks WHERE id='t'",[],|r|r.get::<_,String>(0)).unwrap();
  let observed=check(&store,&json!({"taskId":"t"})).unwrap();assert_eq!(observed["reasonCode"],"budget_exhausted");assert!(observed["message"].as_str().unwrap().contains("30.0分钟"));
  assert_eq!(store.lock().unwrap().query_row("SELECT lease_json FROM pi_tasks WHERE id='t'",[],|r|r.get::<_,String>(0)).unwrap(),before);
  let adjusted=check(&store,&json!({"taskId":"t","limits":{"activeMs":0,"modelRequests":0,"toolCalls":0},"recheck":true})).unwrap();assert_ne!(adjusted["reasonCode"],"budget_exhausted");
 }
}
