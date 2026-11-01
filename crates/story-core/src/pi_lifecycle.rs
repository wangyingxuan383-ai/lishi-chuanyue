//! Durable execution control. Unlike a business tool, stopping does not require
//! a live host, an unexpired lease, or remaining model/tool budget.
use crate::{
    agent_workspace as ws, execution_lease as lease, pi_store::arguments_hash, Error, Result, Store,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};

fn task(db: &Connection, id: &str) -> Result<Value> {
    ws::rows(db, "SELECT id,world_id,status,metadata_json,lease_json,stop_revision,host_owner,error,updated_at FROM pi_tasks WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or_else(|| Error::Invalid("这项助手任务不存在".into()))
}
fn column(row:&Value,key:&str)->Value {row[key].as_str().map(ws::parse).unwrap_or_else(||row[key].clone())}
fn ticket(row: &Value) -> Result<lease::LeaseTicket> {
    let value = column(row,"lease_json");
    serde_json::from_value(value).map_err(|_| Error::Stale)
}
pub(crate) fn attempt(row: &Value) -> String {
    arguments_hash(&column(row,"lease_json"))
}
fn ongoing(row: &Value) -> bool {
    ["running", "committing"].contains(&ws::text(row, "status"))
        || column(row,"metadata_json")["_nativeHostActive"] == true
}
pub(crate) fn execution(db: &Connection, row: &Value) -> Result<Value> {
    let Ok(saved) = ticket(row) else {return Ok(json!({"attemptId":"","phase":row["status"],"ownerStatus":"idle"}));};
    let current = lease::current(db, ws::text(row, "world_id"))?;
    let owned = current.as_ref().filter(|state| state.ticket == saved);
    let live = owned.is_some_and(|state| state.expires_at_ms > lease::now_ms());
    let meta = column(row,"metadata_json");
    let stopping = row["stop_revision"].as_i64().unwrap_or(0) > 0 && ongoing(row);
    let phase = if stopping {
        "stopping"
    } else if ongoing(row) && !live {
        "interrupted"
    } else if meta["_nativeHostActive"]==true && ["committed","completed","previewed","blocked","paused"].contains(&ws::text(row,"status")) {
        "closing"
    } else if ws::text(row, "status") == "running" {
        meta["executionPhase"].as_str().unwrap_or("working")
    } else {
        ws::text(row, "status")
    };
    Ok(
        json!({"attemptId":attempt(row),"phase":phase,"hostActive":meta["_nativeHostActive"]==true,"formalStatus":row["status"],"detailPhase":meta["executionPhase"],"ownerStatus":if live{"active"}else if ongoing(row){"lost"}else{"idle"},
        "lastHeartbeatAt":owned.map(|s|s.heartbeat_at_ms),"leaseExpiresAt":owned.map(|s|s.expires_at_ms),"stopReceipt":meta["stopReceipt"],"progress":meta["progressReview"]["progress"],"notice":meta["runtimeGuidance"]}),
    )
}
fn cleanup(tx: &Transaction<'_>, row: &Value, reason: &str) -> Result<()> {
    let id = ws::text(row, "id");
    let saved = ticket(row)?;
    let status = if ["running", "committing"].contains(&ws::text(row, "status"))
        || row["status"] == "waiting_user" && row["stop_revision"].as_i64().unwrap_or(0) > 0
    {
        if row["stop_revision"].as_i64().unwrap_or(0) > 0 {
            "cancelled"
        } else {
            "interrupted"
        }
    } else {
        ws::text(row, "status")
    };
    crate::pi_budget::clock_finish(tx, id)?;
    crate::pi_budget::interrupt_models(tx, id)?;
    crate::pi_children::interrupt(tx, id, reason)?;
    tx.execute(
        "UPDATE pi_calls SET status='unknown',updated_at=? WHERE task_id=? AND status='running'",
        params![ws::now(), id],
    )?;
    tx.execute("UPDATE pi_external_effects SET status='unknown',updated_at=? WHERE task_id=? AND status='running'",params![ws::now(),id])?;
    // Read fresh metadata after budget/child cleanup; do not overwrite their
    // accounting changes with the older task snapshot.
    let mut meta = ws::parse(ws::text(&task(tx, id)?, "metadata_json"));
    meta["_nativeHostActive"] = false.into();
    meta["executionPhase"] = status.into();
    if meta["stopReceipt"].is_object() {
        meta["stopReceipt"]["settled"] = true.into();
        meta["stopReceipt"]["finishedAt"] = ws::now().into();
        meta["stopReceipt"]["status"] = status.into();
    }
    tx.execute("UPDATE pi_tasks SET status=?,metadata_json=?,question_json=CASE WHEN stop_revision>0 THEN NULL ELSE question_json END,error=CASE WHEN status IN ('running','committing','waiting_user') THEN ? ELSE error END,updated_at=? WHERE id=?",params![status,meta.to_string(),reason,ws::now(),id])?;
    if lease::current(tx, &saved.world_id)?.is_some_and(|state| state.ticket == saved) {
        lease::release_tx(tx, &saved)?;
    }
    Ok(())
}

pub(crate) fn state(store:&Store,id:&str,expected:&str)->Result<Value>{
    let db=store.lock()?;let row=task(&db,id)?;if attempt(&row)!=expected{return Err(Error::Stale);}
    let result:Option<String>=if row["status"]=="committed"{db.query_row("SELECT result_json FROM pi_tasks WHERE id=?",[id],|r|r.get(0)).optional()?.flatten()}else{None};
    Ok(json!({"taskId":id,"status":row["status"],"execution":execution(&db,&row)?,"error":row["error"],"updatedAt":row["updated_at"],"budget":crate::pi_budget::read_budget(&db,id)?,"result":result.as_deref().map(ws::parse)}))
}

/// Only the same immutable execution attempt may be settled. Expiration is
/// expected on a dead host and must not prevent recording its final state.
pub(crate) fn settle(store: &Store, id: &str, expected: &str, reason: &str) -> Result<Value> {
    let mut db = store.lock()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row = task(&tx, id)?;
    if attempt(&row) != expected {
        return Err(Error::Stale);
    }
    cleanup(&tx, &row, reason)?;
    let result = execution(&tx, &task(&tx, id)?)?;
    tx.commit()?;
    Ok(result)
}

pub(crate) fn request_stop(
    store: &Store,
    id: &str,
    expected: &str,
    request_id: &str,
) -> Result<Value> {
    if request_id.is_empty() || request_id.len() > 128 || expected.is_empty() {
        return Err(Error::Invalid(
            "停止请求缺少执行批次或请求标识，请刷新任务后重试".into(),
        ));
    }
    let mut db = store.lock()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row = task(&tx, id)?;
    if attempt(&row) != expected {
        return Err(Error::Invalid(
            "执行批次已变化，旧停止请求没有影响新任务；请刷新后操作".into(),
        ));
    }
    let mut meta = ws::parse(ws::text(&row, "metadata_json"));
    if meta["stopReceipt"]["attemptId"] == expected {
        let result = meta["stopReceipt"].clone();
        tx.commit()?;
        return Ok(result);
    }
    let stopped = !ongoing(&row) && row["status"] != "waiting_user";
    let receipt = json!({"taskId":id,"attemptId":expected,"requestId":request_id,"accepted":true,"settled":stopped,"acceptedAt":ws::now(),"status":if stopped{ws::text(&row,"status")}else{"stopping"}});
    meta["stopReceipt"] = receipt;
    meta["executionPhase"] = if stopped {
        row["status"].clone()
    } else {
        "stopping".into()
    };
    tx.execute(
        "UPDATE pi_tasks SET stop_revision=stop_revision+1,metadata_json=?,updated_at=? WHERE id=?",
        params![meta.to_string(), ws::now(), id],
    )?;
    let row = task(&tx, id)?;
    let saved = ticket(&row)?;
    let live = lease::current(&tx, &saved.world_id)?
        .is_some_and(|state| state.ticket == saved && state.expires_at_ms > lease::now_ms());
    if !live || row["status"] == "waiting_user" && !ongoing(&row) {
        cleanup(&tx, &row, "玩家已停止，要求与未采用草稿保留")?;
    }
    let result = ws::parse(ws::text(&task(&tx, id)?, "metadata_json"))["stopReceipt"].clone();
    tx.commit()?;
    Ok(result)
}

/// Called on native service startup and reads. A still-live owner (including
/// another process) is left alone. No task is resumed and no model is called.
pub(crate) fn reconcile(store: &Store) -> Result<usize> {
    let mut db = store.lock()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let rows=ws::rows(&tx,"SELECT id,world_id,status,metadata_json,lease_json,stop_revision,host_owner,error,updated_at FROM pi_tasks WHERE status IN ('running','committing') OR json_extract(metadata_json,'$._nativeHostActive')=1",&[])?;
    let mut count = 0;
    for row in rows {
        let saved = ticket(&row)?;
        if lease::current(&tx, &saved.world_id)?
            .is_some_and(|state| state.ticket == saved && state.expires_at_ms > lease::now_ms())
        {
            continue;
        }
        cleanup(
            &tx,
            &row,
            "执行宿主已失联，进度与草稿已保留；没有自动恢复执行",
        )?;
        count += 1;
    }
    tx.commit()?;
    Ok(count)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{pi_gateway::StoryToolGateway, pi_store::NewSession};
    use std::sync::{Arc, Mutex};
    pub(crate) fn fixture() -> (Store, StoryToolGateway, String) {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migration::migrate(&mut db, None).unwrap();
        db.execute_batch("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('w','独立停止检查','free','l','{}','test','test','test');INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n','w',0,'opening','正式正文','test');INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l','w','主线','n','test');INSERT INTO states(node_id,state_json) VALUES('n','{\"time\":{\"start\":\"第一天\",\"elapsedMinutes\":0},\"source\":null}');").unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        let gateway = StoryToolGateway::new(store.clone());
        gateway
            .create_session(&NewSession {
                id: "s".into(),
                world_id: "w".into(),
                line_id: "l".into(),
                title: "独立任务".into(),
                session_file: None,
            })
            .unwrap();
        let row = gateway
            .start_task(
                "s",
                "t",
                "核对日期",
                "auto-reversible",
                false,
                json!({"model":"no-http"}),
                json!({}),
            )
            .unwrap();
        (
            store,
            gateway,
            attempt(&json!({"lease_json":row["lease_json"].to_string()})),
        )
    }
    fn expire(store: &Store) {
        store
            .lock()
            .unwrap()
            .execute("UPDATE world_execution_leases SET expires_at_ms=0", [])
            .unwrap();
    }
    #[test]
    fn stop_is_durable_before_cleanup_and_prevents_a_late_commit() {
        let (store, gw, id) = fixture();
        let receipt = request_stop(&store, "t", &id, "user-stop").unwrap();
        assert_eq!(receipt["accepted"], true);
        assert_eq!(receipt["settled"], false);
        let row = gw.0.task("t").unwrap();
        assert_eq!(row["stop_revision"], 1);
        let mut db = store.lock().unwrap();
        let tx = db.transaction().unwrap();
        assert!(matches!(
            crate::pi_store::guard_commit(&tx, "t", 0, row["base_world_version"].as_str().unwrap()),
            Err(Error::Cancelled)
        ));
        drop(tx);
        drop(db);
        settle(&store, "t", &id, "玩家停止").unwrap();
        assert_eq!(gw.0.task("t").unwrap()["status"], "cancelled");
        assert_eq!(
            request_stop(&store, "t", &id, "user-stop").unwrap()["settled"],
            true
        );
        assert_eq!(gw.0.task("t").unwrap()["stop_revision"], 1);
    }
    #[test]
    fn orphan_stop_does_not_need_a_host_lease_or_model_budget() {
        let (store, gw, id) = fixture();
        expire(&store);
        store.lock().unwrap().execute("UPDATE pi_tasks SET workspace_json='{\"edits\":[{\"summary\":\"未采用草稿\"}]}',metadata_json=json_set(metadata_json,'$.limits.modelRequests',1) WHERE id='t'",[]).unwrap();
        let receipt = request_stop(&store, "t", &id, "lost-owner-stop").unwrap();
        assert_eq!(receipt["settled"], true);
        let row = gw.0.task("t").unwrap();
        assert_eq!(row["status"], "cancelled");
        assert_eq!(row["workspace_json"]["edits"][0]["summary"], "未采用草稿");
        assert_eq!(
            store
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM pi_model_requests", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn expired_attempt_reconciles_without_replay_and_old_stop_cannot_cancel_resume() {
        let (store, gw, old) = fixture();
        assert_eq!(reconcile(&store).unwrap(), 0);
        expire(&store);
        assert_eq!(reconcile(&store).unwrap(), 1);
        assert_eq!(gw.0.task("t").unwrap()["status"], "interrupted");
        let permit = gw.resume_task("t").unwrap();
        assert_ne!(permit.attempt_id(), old);
        assert!(request_stop(&store, "t", &old, "late-old-stop").is_err());
        assert_eq!(gw.0.task("t").unwrap()["stop_revision"], 0);
        assert!(settle(&store, "t", &old, "late-old-exit").is_err());
        assert_eq!(gw.0.task("t").unwrap()["status"], "running");
    }
    #[test]
    fn cleanup_keeps_committed_story_and_a_different_new_owner() {
        let (store, gw, id) = fixture();
        store.lock().unwrap().execute("UPDATE pi_tasks SET status='committed',result_json='{\"worldChanged\":true}',metadata_json=json_set(metadata_json,'$._nativeHostActive',1) WHERE id='t'",[]).unwrap();
        expire(&store);
        let mut db = store.lock().unwrap();
        let tx = db.transaction().unwrap();
        let next = lease::acquire_tx(
            &tx,
            "w",
            "other-task",
            "other-host",
            lease::now_ms(),
            lease::DEFAULT_TTL_MS,
        )
        .unwrap();
        tx.commit().unwrap();
        drop(db);
        settle(&store, "t", &id, "旧执行收尾").unwrap();
        assert_eq!(gw.0.task("t").unwrap()["status"], "committed");
        let db = store.lock().unwrap();
        assert_eq!(lease::current(&db, "w").unwrap().unwrap().ticket, next);
        assert_eq!(
            db.query_row("SELECT narrative FROM nodes WHERE id='n'", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "正式正文"
        );
    }
    #[test]
    fn lost_inflight_usage_and_remote_effects_stay_unknown_and_waiting_question_survives() {
        let (store, gw, id) = fixture();
        store.lock().unwrap().execute_batch("INSERT INTO pi_model_requests VALUES('t','r','model','{}','running',NULL,'test',NULL);INSERT INTO pi_external_effects VALUES('e','w','t','c','remote','hash','running','test','test');").unwrap();
        expire(&store);
        reconcile(&store).unwrap();
        let db = store.lock().unwrap();
        assert_eq!(
            db.query_row("SELECT status FROM pi_model_requests", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "unknown"
        );
        assert_eq!(
            db.query_row("SELECT status FROM pi_external_effects", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "unknown"
        );
        drop(db);
        assert_eq!(gw.0.task("t").unwrap()["status"], "interrupted");
        store.lock().unwrap().execute("UPDATE pi_tasks SET status='waiting_user',question_json='{\"id\":\"q\"}' WHERE id='t'",[]).unwrap();
        settle(&store, "t", &id, "等待问题").unwrap();
        assert_eq!(gw.0.task("t").unwrap()["status"], "waiting_user");
        request_stop(&store,"t",&id,"stop-question").unwrap();
        assert_eq!(gw.0.task("t").unwrap()["status"],"cancelled");
        assert!(gw.0.task("t").unwrap()["question_json"].is_null());
    }
}

pub(crate) fn timeout_stop(store:&Store,id:&str,expected:&str)->Result<Option<Value>> {
    let mut db=store.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;let row=task(&tx,id)?;
    if attempt(&row)!=expected{return Err(Error::Stale);}
    let receipt=column(&row,"metadata_json")["stopReceipt"].clone();
    if receipt["accepted"]!=true||receipt["settled"]==true||row["stop_revision"].as_i64().unwrap_or(0)==0 {return Ok(None);}
    cleanup(&tx,&row,"停止已保存；原执行收尾超时，进度与草稿保留")?;
    let receipt=column(&task(&tx,id)?,"metadata_json")["stopReceipt"].clone();tx.commit()?;Ok(Some(receipt))
}

#[cfg(test)]mod cold_tests {
 use super::*;
 #[test]fn facade_control_needs_no_sdk_or_host_and_timeout_does_not_touch_a_new_attempt(){
  let(store,gw,expected)=super::tests::fixture();let request=json!({"taskId":"t","attemptId":expected,"requestId":"cold-control"});
  let before=std::time::Instant::now();assert_eq!(crate::pi_service::persist_stop(&store,&request).unwrap()["accepted"],true);assert!(before.elapsed()<std::time::Duration::from_secs(1));
  assert_eq!(crate::pi_service::timeout_stop(&store,&request).unwrap().unwrap()["settled"],true);assert!(crate::pi_service::timeout_stop(&store,&request).unwrap().is_none());
  assert_eq!(gw.0.task("t").unwrap()["status"],"cancelled");gw.resume_task("t").unwrap();assert!(matches!(crate::pi_service::timeout_stop(&store,&request),Err(Error::Stale)));assert_eq!(gw.0.task("t").unwrap()["stop_revision"],0);
 }
}
