//! Read-only continuation preflight. No lease, Node boot or model request.
use crate::{agent_workspace as ws, pi_budget, execution_lease as lease, Error, Result, Store};
use serde_json::{json, Value};

pub(crate) fn route_available(db: &rusqlite::Connection, world: &str, line: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM worlds w JOIN lines l ON l.world_id=w.id
         WHERE w.id=? AND w.archived=0 AND l.id=? AND l.archived=0 AND l.deleted_at IS NULL)",
        rusqlite::params![world,line],
        |row| row.get(0),
    )?)
}

pub fn check(store:&Store, request:&Value)->Result<Value> {
    let db=store.lock()?;
    crate::maintenance::guard(&db)?;
    let id=ws::text(request,"taskId");
    let task=ws::rows(&db,"SELECT id,world_id,line_id,status,base_json,metadata_json,model_json FROM pi_tasks WHERE id=?",&[&id])?.into_iter().next().ok_or_else(||Error::Invalid("任务不存在，旧引擎对话不能恢复执行".into()))?;
    let meta=ws::parse(ws::text(&task,"metadata_json"));
    let usage=pi_budget::read_budget(&db,id)?;
    let limits=pi_budget::limits(request.get("limits").filter(|v|!v.is_null()).unwrap_or(&meta["limits"]))?;
    let status = ws::text(&task, "status");
    let mut reason=""; let mut message=String::new();
    if !["interrupted","cancelled","paused","failed","blocked","running","stale","previewed"].contains(&status) {
        reason="task_not_resumable";message="这项任务当前不能继续，请先完成正在等待的操作".into();
    }
    if meta["restoreContextMissing"]==true {reason="restore_context_missing";message="这份旧备份没有匹配的改档会话文件；要求、回答和草稿已保留，请另起对话重新核对，不能接上较新的会话内容".into();}
    if let Some(live)=lease::current(&db,ws::text(&task,"world_id"))? {
        if !live.ticket.owner_id.is_empty() && live.expires_at_ms>lease::now_ms(){reason="execution_active";message="原执行尚未停止，请等待收尾后继续".into();}
    }
    for (field,label) in [("modelRequests","模型请求"),("toolCalls","工具调用"),("activeMs","活动时间")] {
        let cap=limits[field].as_u64().unwrap_or(0);let used=usage[field].as_u64().unwrap_or(0);
        if reason.is_empty()&&cap>0&&used>=cap {reason="budget_exhausted";message=if field=="activeMs"{format!("活动时间已用{:.1}分钟，上限{:.1}分钟；请调整执行设置后继续，累计用量保留",used as f64/60000.0,cap as f64/60000.0)}else{format!("{label}已用{used}次，上限{cap}次；请调整执行设置后继续，累计用量保留")};}
    }
    let base=ws::parse(ws::text(&task,"base_json"));
    let world = ws::text(&task, "world_id");
    let line = ws::text(&base, "lineId");
    let current_line_id: String = db.query_row("SELECT current_line_id FROM worlds WHERE id=?",[world],|r|r.get(0))?;
    let current=ws::base(&db,world,line);
    let raw_route_changed=current.is_err();
    let story_changed=current.as_ref().is_ok_and(|v|v["fingerprint"]!=base["fingerprint"]);
    let (route_changed, needs_rebase) = if status == "previewed" {
        if reason.is_empty() && !route_available(&db, world, &current_line_id)? {
            reason = "route_unavailable";
            message = "当前路线已归档、删除或无法进入。请恢复后再继续。".into();
        }
        let diverged = raw_route_changed || story_changed;
        if reason.is_empty() && !diverged {
            reason = "task_not_resumable";
            message = "这项任务当前不能继续，请先完成正在等待的操作".into();
        } else if reason.is_empty() && diverged && request["recheck"] != true {
            reason = "story_version_changed";
            message = if raw_route_changed {
                "故事已切换路线，原要求与草稿保留；继续前需按当前最新路线重新校对".into()
            } else {
                "故事已有新进展，原要求与草稿保留；继续前需按最新版本重新校对".into()
            };
        }
        (false, diverged)
    } else {
        if reason.is_empty() && !route_available(&db, world, line)? {
            reason="route_unavailable";message="原路线已归档、删除或无法进入。恢复原路线，或在当前路线另起核对。".into();
        }
        if reason.is_empty()&&raw_route_changed {reason="route_changed";message="当前故事已切换路线；可以回到原路线继续，或在当前路线另起核对".into();}
        if reason.is_empty()&&story_changed&&request["recheck"]!=true {reason="story_version_changed";message="故事已有新进展，原要求与草稿保留；继续前需按最新版本重新核对".into();}
        (raw_route_changed, story_changed)
    };
    Ok(json!({"canContinue":reason.is_empty(),"reasonCode":reason,"message":message,"used":usage,"limits":limits,"storyChanged":story_changed,"routeChanged":route_changed,"needsRebase":needs_rebase,"worldId":task["world_id"],"lineId":base["lineId"],"currentLineId":current_line_id}))
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
    let changed = tx.execute(
        "UPDATE worlds SET current_line_id=? WHERE id=? AND archived=0
         AND EXISTS(SELECT 1 FROM lines
           WHERE id=? AND world_id=worlds.id AND archived=0 AND deleted_at IS NULL)",
        rusqlite::params![line,world,line],
    )?;
    if changed != 1 {
        return Err(Error::Invalid("原路线已归档、删除或无法进入。恢复原路线，或在当前路线另起核对。".into()));
    }
    tx.commit()?;
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
 #[test]
 fn resume_cannot_select_a_deleted_or_archived_route() {
     let (store, _, attempt) = crate::pi_lifecycle::tests::fixture();
     crate::pi_lifecycle::settle(&store, "t", &attempt, "隔离任务").unwrap();
     store.lock().unwrap().execute_batch(
         "INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('next','w','新路线','n','test');
          UPDATE worlds SET current_line_id='next' WHERE id='w';
          UPDATE lines SET deleted_at='test' WHERE id='l';",
     ).unwrap();
     let request = json!({"taskId":"t","currentLineId":"next"});
     assert!(select_original_route(&store, &request).is_err());
     store.lock().unwrap().execute("UPDATE lines SET deleted_at=NULL,archived=1 WHERE id='l'", []).unwrap();
     assert!(select_original_route(&store, &request).is_err());
     let current = || store.lock().unwrap().query_row(
         "SELECT current_line_id FROM worlds WHERE id='w'", [], |r| r.get::<_, String>(0)
     ).unwrap();
     assert_eq!(current(), "next");
     store.lock().unwrap().execute("UPDATE lines SET archived=0 WHERE id='l'", []).unwrap();
     assert_eq!(select_original_route(&store, &request).unwrap()["lineId"], "l");
     assert_eq!(current(), "l");
 }
 #[test]
 fn restore_fence_blocks_resume_preflight_and_preview_adoption() {
     let (store, gateway, attempt) = crate::pi_lifecycle::tests::fixture();
     crate::pi_lifecycle::settle(&store, "t", &attempt, "隔离任务").unwrap();
     let maintenance = crate::maintenance::begin(&store).unwrap();
     assert!(check(&store, &json!({"taskId":"t"})).is_err());
     assert!(gateway.resume_task("t").is_err());
     store.lock().unwrap().execute("UPDATE pi_tasks SET status='previewed' WHERE id='t'", []).unwrap();
     assert!(gateway.adopt_preview("t").unwrap_err().to_string().contains("维护"));
     assert_eq!(gateway.0.task("t").unwrap()["status"], "previewed");
     crate::maintenance::end(&store, &maintenance).unwrap();
 }
 #[test]
 fn archived_story_cannot_reacquire_a_resume_lease() {
     let (store, gateway, attempt) = crate::pi_lifecycle::tests::fixture();
     crate::pi_lifecycle::settle(&store, "t", &attempt, "隔离任务").unwrap();
     store.lock().unwrap().execute("UPDATE worlds SET archived=2 WHERE id='w'", []).unwrap();
     assert_eq!(check(&store, &json!({"taskId":"t","recheck":true})).unwrap()["reasonCode"], "route_unavailable");
     assert!(gateway.resume_task("t").is_err());
     assert!(!lease::current(&store.lock().unwrap(), "w").unwrap().is_some_and(|owner| !owner.ticket.owner_id.is_empty()));
 }

 #[test]
 fn r41_unlocks_legacy_through_honors_explicit_range_and_breaks_stale_preview_deadlock() {
     use crate::pi_store::{NewSession, PiCallRequest};
     let (store, gateway, attempt) = crate::pi_lifecycle::tests::fixture();
     crate::pi_lifecycle::settle(&store, "t", &attempt, "收尾初始隔离任务").unwrap();

     // Seed a multi-section book and legacy `through: 0` on world `w`:
     {
         let db = store.lock().unwrap();
         db.execute(
             "INSERT INTO source_books VALUES('b-r41','测试原著','txt','test',?)",
             [json!({"sections":[{"title":"第一章","text":"第一章允许内容"},{"title":"第二章","text":"第二章允许内容"},{"title":"第三章","text":"第三章终局真相"}]}).to_string()],
         ).unwrap();
         db.execute_batch(
             "INSERT INTO source_sections VALUES('b-r41',0,'第一章',1),('b-r41',1,'第二章',2),('b-r41',2,'第三章',3);
              INSERT INTO source_chunks VALUES('b-r41',0,0,'第一章允许内容'),('b-r41',1,1,'第二章允许内容'),('b-r41',2,2,'第三章终局真相');",
         ).unwrap();
         let mut st: Value = serde_json::from_str(
             &db.query_row("SELECT state_json FROM states WHERE node_id='n'", [], |r| r.get::<_, String>(0)).unwrap(),
         ).unwrap();
         st["source"] = json!({"bookId":"b-r41","through":0,"position":0,"method":"search","instructions":""});
         db.execute("UPDATE states SET state_json=? WHERE node_id='n'", [st.to_string()]).unwrap();
     }

     gateway.create_session(&NewSession {
         id: "s-r41".into(),
         world_id: "w".into(),
         line_id: "l".into(),
         title: "R41 恢复与范围测试".into(),
         session_file: None,
     }).unwrap();

     // 1. E03: Default start_task normalizes legacy `state.source.through = 0` to `null` (full book):
     let unlocked = gateway.start_task("s-r41", "t-unlock", "改档任务", "preview", false, json!({"model":"m"}), json!({})).unwrap();
     assert!(unlocked["metadata_json"]["referenceScope"]["through"].is_null());
     let unlock_permit = gateway.permit("t-unlock").unwrap();
     let ver = unlocked["base_world_version"].as_str().unwrap().to_owned();
     let sec2 = gateway.invoke(&unlock_permit, PiCallRequest {
         task_id: "t-unlock".into(),
         call_id: "read-sec2".into(),
         tool: "read_original".into(),
         args: json!({"section": 2}),
         intent_revision: 0,
         world_version: ver.clone(),
         external_write: false,
     }).unwrap();
     assert_eq!(sec2["ok"], true, "default task must read section 2 despite legacy state.source.through=0: {sec2}");
     gateway.interrupt(&unlock_permit, "切到区间测试").unwrap();

     // 2. E03: Explicit `referenceScope: { bookId, from: 1, through: 1, explicitRange: true }` restricts both < from and > through:
     let scoped = gateway.start_task(
         "s-r41",
         "t-scoped",
         "只按第二节修改",
         "preview",
         false,
         json!({"model":"m"}),
         json!({"referenceScope": {"bookId": "b-r41", "from": 1, "through": 1, "explicitRange": true}}),
     ).unwrap();
     assert_eq!(scoped["metadata_json"]["referenceScope"]["from"], 1);
     assert_eq!(scoped["metadata_json"]["referenceScope"]["through"], 1);
     let scoped_permit = gateway.permit("t-scoped").unwrap();
     let s_ver = scoped["base_world_version"].as_str().unwrap().to_owned();
     let denied_before = gateway.invoke(&scoped_permit, PiCallRequest {
         task_id: "t-scoped".into(),
         call_id: "read-sec0".into(),
         tool: "read_original".into(),
         args: json!({"section": 0}),
         intent_revision: 0,
         world_version: s_ver.clone(),
         external_write: false,
     }).unwrap();
     assert_eq!(denied_before["ok"], false, "section < from must be rejected");
     let allowed_mid = gateway.invoke(&scoped_permit, PiCallRequest {
         task_id: "t-scoped".into(),
         call_id: "read-sec1".into(),
         tool: "read_original".into(),
         args: json!({"section": 1}),
         intent_revision: 0,
         world_version: s_ver.clone(),
         external_write: false,
     }).unwrap();
     assert_eq!(allowed_mid["ok"], true, "section within [from, through] must succeed");
     let denied_after = gateway.invoke(&scoped_permit, PiCallRequest {
         task_id: "t-scoped".into(),
         call_id: "read-sec2-denied".into(),
         tool: "read_original".into(),
         args: json!({"section": 2}),
         intent_revision: 0,
         world_version: s_ver.clone(),
         external_write: false,
     }).unwrap();
     assert_eq!(denied_after["ok"], false, "section > through must be rejected");

     // 3. E04: Stage an edit and produce a `previewed` task, then advance/switch route -> resume_check & resume_task break deadlock:
     assert_eq!(gateway.invoke(&scoped_permit, PiCallRequest {
         task_id: "t-scoped".into(),
         call_id: "stage-1".into(),
         tool: "stage_edit".into(),
         args: json!({"kind":"settings","path":"/premise","operation":"set","value":"校对后的新设定","summary":"更新设定"}),
         intent_revision: 0,
         world_version: s_ver.clone(),
         external_write: false,
     }).unwrap()["ok"], true);
     let fin = gateway.invoke(&scoped_permit, PiCallRequest {
         task_id: "t-scoped".into(),
         call_id: "finish-prev".into(),
         tool: "finish_task".into(),
         args: json!({"summary":"预览已就绪"}),
         intent_revision: 0,
         world_version: s_ver,
         external_write: false,
     }).unwrap();
     assert_eq!(fin["data"]["status"], "previewed");

     // Fresh preview is not resumable (can be adopted directly):
     assert_eq!(check(&store, &json!({"taskId":"t-scoped"})).unwrap()["reasonCode"], "task_not_resumable");

     // Switch world to a new branch `l2` with a new node `n2`:
     {
         let db = store.lock().unwrap();
         let st: String = db.query_row("SELECT state_json FROM states WHERE node_id='n'", [], |r| r.get(0)).unwrap();
         db.execute("INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,created_at) VALUES('n2','w','n',2,'turn','新分支推进','test')", []).unwrap();
         db.execute("INSERT INTO states(node_id,state_json) VALUES('n2',?)", [st]).unwrap();
         db.execute("INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l2','w','分支二','n2','test')", []).unwrap();
         db.execute("UPDATE worlds SET current_line_id='l2' WHERE id='w'", []).unwrap();
     }

     // Adopting stale preview fails with Stale, while check() allows recheck=true and resume_task rebases onto `l2`:
     assert!(matches!(gateway.adopt_preview("t-scoped"), Err(Error::Stale)));
     let pre_recheck = check(&store, &json!({"taskId":"t-scoped"})).unwrap();
     assert_eq!(pre_recheck["reasonCode"], "story_version_changed");
     assert_eq!(pre_recheck["needsRebase"], true);
     let ok_recheck = check(&store, &json!({"taskId":"t-scoped","recheck":true})).unwrap();
     assert_eq!(ok_recheck["canContinue"], true);

     let resumed = gateway.resume_task("t-scoped").unwrap();
     let rebased_row = gateway.0.task("t-scoped").unwrap();
     assert_eq!(rebased_row["status"], "running");
     assert_eq!(rebased_row["line_id"], "l2");
     assert_eq!(rebased_row["base_json"]["lineId"], "l2");
     // Explicit chapter range survived pi_rebase::save!
     assert_eq!(rebased_row["metadata_json"]["referenceScope"]["from"], 1);
     assert_eq!(rebased_row["metadata_json"]["referenceScope"]["through"], 1);
     gateway.interrupt(&resumed, "收尾").unwrap();
 }
}
