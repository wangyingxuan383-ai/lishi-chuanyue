//! Business effects only: isolated SQLite, no model, service or personal data.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use story_core::{
    pi_gateway::{StoryToolGateway, TaskPermit},
    pi_store::{NewSession, PiCallRequest},
    Result, Store,
};

fn state(money: i64, elapsed: i64) -> Value {
    json!({"version":2,"time":{"start":"第一天","elapsedMinutes":elapsed,"startHour":8},"placeId":null,
        "protagonist":{"name":"旅人","aliases":[],"age":20,"gender":"男","identity":"行旅","origin":"现代","cheat":"",
            "stats":{"money":money,"debt":0,"health":100,"energy":100,"fame":0},"statuses":[],"items":[]},
        "people":[],"places":[],"cards":[],"goals":[],"facts":[],"era":{"packId":null,"mode":"free","clockStyle":"elapsed"},"deviations":[]})
}

struct Task {
    id: String,
    world_version: String,
    permit: TaskPermit,
}

struct Fixture {
    store: Store,
    gateway: StoryToolGateway,
}

impl Fixture {
    fn new() -> Self {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        story_core::migration::migrate(&mut db, None).unwrap();
        db.execute("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('world','独立故事','free','line',?,'test','test','test')",[json!({"premise":"原设定","autoUpkeep":false,"chapterEvery":0}).to_string()]).unwrap();
        for (id, parent, seq, narrative, record, money) in [
            ("n0", None, 0, "开场", Value::Null, 10),
            (
                "n1",
                Some("n0"),
                1,
                "借了两文",
                json!({"money":-2,"time":5}),
                8,
            ),
            (
                "n2",
                Some("n1"),
                2,
                "后来买纸花了三文",
                json!({"money":-3,"time":5}),
                5,
            ),
        ] {
            db.execute("INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,record_json,created_at) VALUES(?,'world',?,?,?,?,?,'test')",params![id,parent,seq,if seq==0{"opening"}else{"turn"},narrative,record.to_string()]).unwrap();
            db.execute(
                "INSERT INTO states(node_id,state_json) VALUES(?,?)",
                params![id, state(money, seq * 5).to_string()],
            )
            .unwrap();
        }
        db.execute_batch("INSERT INTO lines(id,world_id,name,node_id,kind,created_at) VALUES('line','world','主线','n2','line','test'); INSERT INTO lines(id,world_id,name,node_id,kind,created_at) VALUES('side','world','保留支线','n2','line','test')").unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        let gateway = StoryToolGateway::new(store.clone());
        gateway
            .create_session(&NewSession {
                id: "session".into(),
                world_id: "world".into(),
                line_id: "line".into(),
                title: "独立助手".into(),
                session_file: None,
            })
            .unwrap();
        Self { store, gateway }
    }

    fn start(&self, id: &str, policy: &str, read_only: bool) -> Task {
        let row = self
            .gateway
            .start_task(
                "session",
                id,
                "处理本局资料，不新增剧情",
                policy,
                read_only,
                json!({"model":"isolated-no-model-request"}),
                json!({}),
            )
            .unwrap();
        Task {
            id: id.into(),
            world_version: row["base_world_version"].as_str().unwrap().into(),
            permit: self.gateway.permit(id).unwrap(),
        }
    }

    fn request(
        task: &Task,
        call_id: &str,
        tool: &str,
        args: Value,
        revision: i64,
    ) -> PiCallRequest {
        PiCallRequest {
            task_id: task.id.clone(),
            call_id: call_id.into(),
            tool: tool.into(),
            args,
            intent_revision: revision,
            world_version: task.world_version.clone(),
            external_write: false,
        }
    }

    fn call(&self, task: &Task, call_id: &str, tool: &str, args: Value) -> Value {
        let value = self
            .gateway
            .invoke(&task.permit, Self::request(task, call_id, tool, args, 0))
            .unwrap();
        assert_eq!(value["ok"], true, "{value}");
        value
    }

    fn stage_setting(&self, task: &Task) -> Value {
        self.call(task,"edit-setting","stage_edit",json!({"kind":"settings","path":"/premise","operation":"set","value":"修改后的本局设定","summary":"修改本局设定"}))
    }

    fn finish(&self, task: &Task, call_id: &str) -> Value {
        self.call(
            task,
            call_id,
            "finish_task",
            json!({"summary":"已处理本局资料"}),
        )
    }

    fn premise(&self) -> String {
        let text: String = self
            .store
            .lock()
            .unwrap()
            .query_row(
                "SELECT settings_json FROM worlds WHERE id='world'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str::<Value>(&text).unwrap()["premise"]
            .as_str()
            .unwrap()
            .into()
    }

    fn head_state(&self, line: &str) -> Value {
        let text: String = self.store.lock().unwrap().query_row("SELECT s.state_json FROM lines l JOIN states s ON s.node_id=l.node_id WHERE l.id=?",[line],|r|r.get(0)).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    fn count(&self, sql: &str) -> i64 {
        self.store
            .lock()
            .unwrap()
            .query_row(sql, [], |r| r.get(0))
            .unwrap()
    }
}

fn assert_rejected(result: Result<Value>) {
    if let Ok(value) = result {
        assert_eq!(value["ok"], false, "unexpected successful call: {value}");
    }
}

#[test]
fn draft_commit_cache_and_recovery_have_separate_lifetimes() {
    let f = Fixture::new();
    let task = f.start("edit-task", "auto-reversible", false);
    let before = f.head_state("line");
    let staged = f.stage_setting(&task);
    assert_eq!(f.premise(), "原设定");
    assert_eq!(f.count("SELECT COUNT(*) FROM story_recovery_points"), 0);
    assert_eq!(f.stage_setting(&task), staged);
    assert_eq!(
        f.count("SELECT COUNT(*) FROM pi_calls WHERE tool='stage_edit'"),
        1
    );
    assert!(f.gateway.invoke(&task.permit,Fixture::request(&task,"edit-setting","stage_edit",json!({"kind":"settings","path":"/premise","operation":"set","value":"另一份内容","summary":"不同参数"}),0)).is_err());
    let completed = f.finish(&task, "finish");
    assert_eq!(completed["data"]["status"], "committed");
    assert_eq!(f.premise(), "修改后的本局设定");
    assert_eq!(f.head_state("line"), before);
    assert_eq!(f.count("SELECT COUNT(*) FROM nodes"), 3);
    let recovery = completed["data"]["recoveryId"].as_str().unwrap();
    f.store
        .lock()
        .unwrap()
        .execute("DELETE FROM pi_sessions WHERE id='session'", [])
        .unwrap();
    assert_eq!(f.count("SELECT COUNT(*) FROM pi_tasks"), 0);
    assert_eq!(f.count("SELECT COUNT(*) FROM story_recovery_points"), 1);
    f.gateway.undo_recovery(recovery).unwrap();
    assert_eq!(f.premise(), "原设定");
    assert_eq!(f.head_state("line"), before);
}

#[test]
fn stale_preview_cannot_replace_new_story_and_auto_has_no_recovery_copy() {
    let preview = Fixture::new();
    let task = preview.start("preview-task", "preview", false);
    preview.stage_setting(&task);
    let result = preview.finish(&task, "preview");
    assert_eq!(result["data"]["status"], "previewed");
    assert_eq!(preview.premise(), "原设定");
    preview
        .store
        .lock()
        .unwrap()
        .execute(
            "UPDATE worlds SET settings_json=? WHERE id='world'",
            [json!({"premise":"玩家后来的新设定"}).to_string()],
        )
        .unwrap();
    assert!(preview.gateway.adopt_preview(&task.id).is_err());
    assert_eq!(preview.premise(), "玩家后来的新设定");
    assert_eq!(
        preview.count("SELECT COUNT(*) FROM story_recovery_points"),
        0
    );

    let automatic = Fixture::new();
    let task = automatic.start("auto-task", "auto", false);
    automatic.stage_setting(&task);
    let result = automatic.finish(&task, "finish");
    assert_eq!(result["data"]["status"], "committed");
    assert!(result["data"]["recoveryId"].is_null());
    assert_eq!(
        automatic.count("SELECT COUNT(*) FROM story_recovery_points"),
        0
    );
}

#[test]
fn unconsumed_steer_and_explicit_stop_block_old_commit() {
    let f = Fixture::new();
    let task = f.start("controlled-task", "auto-reversible", false);
    f.stage_setting(&task);
    let input = f
        .gateway
        .0
        .append_input(
            "session",
            Some(&task.id),
            "steer",
            &json!({"text":"先保留旧设定"}),
        )
        .unwrap();
    assert_rejected(f.gateway.invoke(
        &task.permit,
        Fixture::request(
            &task,
            "old-finish",
            "finish_task",
            json!({"summary":"旧要求完成"}),
            0,
        ),
    ));
    assert_rejected(f.gateway.invoke(
        &task.permit,
        Fixture::request(
            &task,
            "premature-finish",
            "finish_task",
            json!({"summary":"未消费补充"}),
            1,
        ),
    ));
    assert_eq!(f.premise(), "原设定");
    f.gateway.0.consume_input(&input).unwrap();
    let read = f
        .gateway
        .invoke(
            &task.permit,
            Fixture::request(
                &task,
                "read-after-steer",
                "read_resource",
                json!({"kind":"settings"}),
                1,
            ),
        )
        .unwrap();
    assert_eq!(read["ok"], true);
    f.gateway.stop(&task.id).unwrap();
    assert_rejected(f.gateway.invoke(
        &task.permit,
        Fixture::request(
            &task,
            "stopped-finish",
            "finish_task",
            json!({"summary":"已停止"}),
            1,
        ),
    ));
    assert_eq!(f.premise(), "原设定");
    assert_eq!(f.count("SELECT COUNT(*) FROM story_recovery_points"), 0);
}

#[test]
fn readonly_task_can_answer_but_cannot_stage_or_create_story() {
    let f = Fixture::new();
    let task = f.start("read-task", "auto-reversible", true);
    let before = f.head_state("line");
    f.call(&task, "read", "read_resource", json!({"kind":"settings"}));
    assert_rejected(f.gateway.invoke(&task.permit,Fixture::request(&task,"forbidden-edit","stage_edit",json!({"kind":"settings","path":"/premise","operation":"set","value":"不应采用","summary":"禁止修改"}),0)));
    let result = f.finish(&task, "answer");
    assert_eq!(result["data"]["status"], "answered");
    assert_eq!(result["data"]["changed"], false);
    assert_eq!(f.premise(), "原设定");
    assert_eq!(f.head_state("line"), before);
    assert_eq!(f.count("SELECT COUNT(*) FROM nodes"), 3);
    assert_eq!(f.count("SELECT COUNT(*) FROM story_recovery_points"), 0);
}

#[test]
fn earlier_narrative_and_record_recompute_current_route_and_preserve_side_route() {
    let f = Fixture::new();
    let task = f.start("history-task", "auto-reversible", false);
    let side_before = f.head_state("side");
    f.call(&task,"edit-narrative","stage_edit",json!({"kind":"node","id":"n1","path":"/narrative","operation":"set","value":"借了四文","summary":"纠正早回合正文"}));
    f.call(&task,"edit-record","stage_edit",json!({"kind":"node","id":"n1","path":"/record","operation":"set","value":{"money":-4,"time":5},"summary":"同步核对早回合记录"}));
    let result = f.finish(&task, "finish-history");
    assert_eq!(result["data"]["status"], "committed");
    let live = f.head_state("line");
    assert_eq!(live["protagonist"]["stats"]["money"].as_f64(), Some(3.0));
    assert_eq!(live["time"]["elapsedMinutes"].as_f64(), Some(10.0));
    assert_eq!(f.head_state("side"), side_before);
    let db = f.store.lock().unwrap();
    assert_eq!(
        db.query_row("SELECT node_id FROM lines WHERE id='side'", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "n2"
    );
    assert_eq!(
        db.query_row("SELECT narrative FROM nodes WHERE id='n1'", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "借了两文"
    );
    assert_eq!(db.query_row("SELECT p.narrative FROM lines l JOIN nodes n ON n.id=l.node_id JOIN nodes p ON p.id=n.parent_id WHERE l.id='line'",[],|r|r.get::<_,String>(0)).unwrap(),"借了四文");
    assert_eq!(
        db.query_row("SELECT MAX(seq) FROM nodes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn call_receipt_failure_rolls_back_world_recovery_and_commit_and_can_retry_new_call() {
    let f = Fixture::new();
    let task = f.start("transaction-task", "auto-reversible", false);
    f.stage_setting(&task);
    f.store.lock().unwrap().execute_batch("CREATE TRIGGER reject_finish_receipt BEFORE UPDATE OF status,output_json ON pi_calls WHEN NEW.tool='finish_task' AND NEW.status='done' BEGIN SELECT RAISE(ABORT,'isolated-receipt-failure'); END").unwrap();
    assert!(f
        .gateway
        .invoke(
            &task.permit,
            Fixture::request(
                &task,
                "finish-receipt-fails",
                "finish_task",
                json!({"summary":"回执失败"}),
                0
            )
        )
        .is_err());
    assert_eq!(f.premise(), "原设定");
    assert_eq!(f.count("SELECT COUNT(*) FROM story_recovery_points"), 0);
    assert_eq!(f.gateway.0.task(&task.id).unwrap()["status"], "running");
    assert_eq!(f.count("SELECT COUNT(*) FROM pi_calls WHERE call_id='finish-receipt-fails' AND status='running'"),1);
    f.store
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER reject_finish_receipt")
        .unwrap();
    let result = f.finish(&task, "finish-new-call");
    assert_eq!(result["data"]["status"], "committed");
    assert_eq!(f.premise(), "修改后的本局设定");
    assert_eq!(f.count("SELECT COUNT(*) FROM story_recovery_points"), 1);
}

#[test]
fn resumed_same_process_cannot_reuse_old_permit_for_reads_or_cached_calls() {
    let f = Fixture::new();
    let mut task = f.start("resumed-task", "auto-reversible", false);
    f.call(
        &task,
        "old-read",
        "read_resource",
        json!({"kind":"settings"}),
    );
    f.gateway.interrupt(&task.permit, "独立宿主断开").unwrap();
    let resumed = f.gateway.resume_task(&task.id).unwrap();
    assert!(f.gateway.heartbeat(&task.permit).is_err());
    assert_rejected(f.gateway.invoke(
        &task.permit,
        Fixture::request(
            &task,
            "old-read",
            "read_resource",
            json!({"kind":"settings"}),
            0,
        ),
    ));
    assert_rejected(f.gateway.invoke(
        &task.permit,
        Fixture::request(
            &task,
            "old-new-read",
            "read_resource",
            json!({"kind":"settings"}),
            0,
        ),
    ));
    task.permit = resumed;
    f.gateway.heartbeat(&task.permit).unwrap();
    f.call(
        &task,
        "new-read",
        "read_resource",
        json!({"kind":"settings"}),
    );
}

#[test]
fn resumed_execution_rejects_old_owner_inputs_consumption_and_stop() {
    let f = Fixture::new();
    let task = f.start("controlled-task", "auto-reversible", false);
    let input = f
        .gateway
        .append_input(
            &task.permit,
            "steer",
            &json!({"text":"保留玩家主动改变的剧情","nonce":"owned-control"}),
        )
        .unwrap();
    f.gateway.interrupt(&task.permit, "独立宿主离开").unwrap();
    let resumed = f.gateway.resume_task(&task.id).unwrap();
    assert!(f
        .gateway
        .append_input(
            &task.permit,
            "steer",
            &json!({"text":"旧进程不应追加","nonce":"stale-control"})
        )
        .is_err());
    assert!(f.gateway.consume_input(&task.permit, &input).is_err());
    assert!(f.gateway.stop_owned(&task.permit).is_err());
    assert_eq!(f.count("SELECT COUNT(*) FROM pi_inputs"), 1);
    let saved = f.gateway.0.task(&task.id).unwrap();
    assert_eq!(saved["intent_revision"], 1);
    assert_eq!(saved["consumed_intent_revision"], 0);
    assert_eq!(saved["stop_revision"], 0);
    f.gateway.consume_input(&resumed, &input).unwrap();
    let next = f
        .gateway
        .append_input(
            &resumed,
            "steer",
            &json!({"text":"当前执行可以追加","nonce":"current-control"}),
        )
        .unwrap();
    f.gateway.consume_input(&resumed, &next).unwrap();
    f.gateway.stop_owned(&resumed).unwrap();
    let saved = f.gateway.0.task(&task.id).unwrap();
    assert_eq!(saved["intent_revision"], 2);
    assert_eq!(saved["consumed_intent_revision"], 2);
    assert_eq!(saved["stop_revision"], 1);
}

#[test]
fn blocked_task_keeps_its_draft_and_can_resume_but_archived_story_cannot_start() {
    let f = Fixture::new();
    let mut task = f.start("blocked-task", "auto-reversible", false);
    f.stage_setting(&task);
    let blocked = f.call(
        &task,
        "block",
        "finish_task",
        json!({"summary":"暂缺资料","outcome":"blocked","reason":"需要补充依据"}),
    );
    assert_eq!(blocked["data"]["status"], "blocked");
    assert_eq!(f.premise(), "原设定");
    task.permit = f.gateway.resume_task(&task.id).unwrap();
    let committed = f.finish(&task, "finish-after-resume");
    assert_eq!(committed["data"]["status"], "committed");
    assert_eq!(f.premise(), "修改后的本局设定");
    f.store
        .lock()
        .unwrap()
        .execute("UPDATE worlds SET archived=1 WHERE id='world'", [])
        .unwrap();
    assert!(f
        .gateway
        .start_task(
            "session",
            "archived-task",
            "不能操作回收站故事",
            "auto",
            false,
            json!({}),
            json!({})
        )
        .is_err());
}

#[test]
fn safe_batches_keep_unverified_draft_and_story_owned_sources_for_all_policies() {
    for policy in ["auto-reversible","preview","auto"] {
        let f=Fixture::new();
        f.store.lock().unwrap().execute_batch("INSERT INTO pins(id,world_id,text,created_at) VALUES('p1','world','旧资料一','test'),('p2','world','旧资料二','test')").unwrap();
        let task=f.start("batch-task",policy,false);
        f.call(&task,"p1","stage_edit",json!({"kind":"pin","id":"p1","path":"/text","operation":"set","value":"已核对资料","summary":"改资料一"}));
        f.call(&task,"p2","stage_edit",json!({"kind":"pin","id":"p2","path":"/text","operation":"set","value":"未核对资料","summary":"改资料二"}));
        let check=f.call(&task,"check","check_draft",json!({}));
        let groups=check["data"]["resourceGroups"].as_array().unwrap();
        let selection=|id:&str|{let g=groups.iter().find(|g|g["id"]==id).unwrap();json!({"groupId":g["groupId"],"fingerprint":g["fingerprint"],"afterFingerprint":g["afterFingerprint"],"originalFingerprint":g["originalFingerprint"]})};
        f.call(&task,"findings","record_findings",json!({"report":{"worldVersion":task.world_version,"intentRevision":0,"goals":[{"id":"g1","status":"completed","summary":"第一项一致性"},{"id":"g2","status":"blocked","summary":"第二项资料不足"}],"findings":[{"id":"f1","goalId":"g1","topic":"资料一","claim":"核对本局资料一","basis":"local_consistency","resources":[selection("p1")],"references":[]},{"id":"f2","goalId":"g2","topic":"资料二","claim":"仍缺核对依据","basis":"insufficient","resources":[selection("p2")],"references":[]}]}}));
        let mut result=f.finish(&task,"finish")["data"].clone();
        if policy=="preview" {
            assert_eq!(result["status"],"previewed");
            assert_eq!(f.count("SELECT count(*) FROM pins WHERE text='已核对资料'"),0);
            result=f.gateway.adopt_preview(&task.id).unwrap();
        }
        assert_eq!(result["status"],"committed","{result}");
        assert_eq!(result["goalStatus"],"partial");
        assert_eq!(result["goalCompleted"],false);
        assert_eq!(f.count("SELECT count(*) FROM pins WHERE id='p1' AND text='已核对资料'"),1);
        assert_eq!(f.count("SELECT count(*) FROM pins WHERE id='p2' AND text='旧资料二'"),1);
        assert_eq!(f.count("SELECT count(*) FROM story_fact_sources"),1);
        assert_eq!(f.count("SELECT count(*) FROM pi_commit_batches"),1);
        assert_eq!(f.count("SELECT count(*) FROM story_recovery_points"),if policy=="auto-reversible"{1}else{0});
        let row=f.gateway.0.task(&task.id).unwrap();
        assert_eq!(row["status"],"paused");
        let remaining=row["workspace_json"].clone();
        assert_eq!(remaining["edits"].as_array().unwrap().len(),1);
        assert_eq!(remaining["edits"][0]["id"],"p2");
        assert_eq!(remaining["edits"][0]["after"]["text"],"未核对资料");
        let permit=f.gateway.resume_task(&task.id).unwrap();
        f.gateway.interrupt(&permit,"定向检查结束").unwrap();
        f.store.lock().unwrap().execute("DELETE FROM pi_sessions WHERE id='session'",[]).unwrap();
        assert_eq!(f.count("SELECT count(*) FROM story_fact_sources"),1,"provenance must outlive chat deletion");
        assert_eq!(f.count("SELECT count(*) FROM pi_commit_batches"),1);
    }
}

#[test]
fn resume_three_way_rechecks_new_story_instead_of_overwriting_and_preserves_draft() {
    let f=Fixture::new();let task=f.start("resume-rebase","auto-reversible",false);
    f.stage_setting(&task);f.gateway.interrupt(&task.permit,"模拟中断").unwrap();
    f.store.lock().unwrap().execute("UPDATE worlds SET settings_json=? WHERE id='world'",[json!({"premise":"玩家后来改的新设定","autoUpkeep":false,"chapterEvery":0,"viewpoint":"third"}).to_string()]).unwrap();
    let check=story_core::pi_resume::check(&f.store,&json!({"taskId":task.id})).unwrap();assert_eq!(check["reasonCode"],"story_version_changed");
    let permit=f.gateway.resume_task(&task.id).unwrap();
    let row=f.gateway.0.task(&task.id).unwrap();let work=&row["workspace_json"];
    assert_eq!(work["edits"][0]["after"]["premise"],"玩家后来改的新设定");
    assert_eq!(work["edits"][0]["rebaseConflicts"][0]["proposed"],"修改后的本局设定");
    assert_eq!(work["edits"][0]["after"]["viewpoint"],"third");
    let target=Task{id:task.id,world_version:row["base_world_version"].as_str().unwrap().into(),permit};
    assert_rejected(f.gateway.invoke(&target.permit,Fixture::request(&target,"cannot-finish-conflict","finish_task",json!({"summary":"错误地完成"}),0)));
    assert_eq!(f.premise(),"玩家后来改的新设定");
    f.gateway.interrupt(&target.permit,"检查结束").unwrap();
}

#[test]
fn adopted_route_with_an_unresolved_goal_can_continue_reading_on_its_actual_line() {
    let f=Fixture::new();let task=f.start("fork-partial","auto-reversible",false);
    f.call(&task,"route","stage_route",json!({"name":"修订路线","headId":"n1","activate":true,"summary":"先回退"}));
    let check=f.call(&task,"check","check_draft",json!({}));
    let selected=check["data"]["resourceGroups"].as_array().unwrap().iter().map(|g|json!({"groupId":g["groupId"],"fingerprint":g["fingerprint"],"afterFingerprint":g["afterFingerprint"],"originalFingerprint":g["originalFingerprint"]})).collect::<Vec<_>>();
    f.call(&task,"findings","record_findings",json!({"report":{"worldVersion":task.world_version,"intentRevision":0,"goals":[{"id":"g1","status":"completed","summary":"回退"},{"id":"g2","status":"blocked","summary":"后续资料不足"}],"findings":[{"id":"f1","goalId":"g1","topic":"路线","claim":"回到目标回合","basis":"local_consistency","resources":selected,"references":[]}]}}));
    let result=f.finish(&task,"finish");assert_eq!(result["data"]["goalStatus"],"partial");
    let row=f.gateway.0.task(&task.id).unwrap();let next_line=row["base_json"]["lineId"].as_str().unwrap();assert_ne!(next_line,"line");assert_eq!(row["line_id"],next_line);
    assert_eq!(f.gateway.0.session("session").unwrap()["line_id"],next_line);
    let target=Task{id:task.id.clone(),world_version:row["base_world_version"].as_str().unwrap().into(),permit:f.gateway.resume_task(&task.id).unwrap()};
    let read=f.call(&target,"new-line-read","read_resource",json!({"kind":"state","path":"/time"}));assert!(read["data"]["value"].is_object());
    f.gateway.interrupt(&target.permit,"检查结束").unwrap();
    f.gateway.undo_recovery(result["data"]["recoveryId"].as_str().unwrap()).unwrap();
    assert_eq!(f.gateway.0.session("session").unwrap()["line_id"],"line","restoring a story route must keep its surviving conversation reachable");
}

#[test]
fn readonly_analysis_can_read_formal_sources_and_record_checks_without_edit_permission() {
    let f=Fixture::new();let task=f.start("readonly-checks","auto-reversible",true);
    f.call(&task,"sources","read_fact_sources",json!({}));
    f.call(&task,"checked","record_findings",json!({"report":{"worldVersion":task.world_version,"intentRevision":0,"goals":[{"id":"g","status":"no_change","summary":"只读查询"}],"findings":[{"id":"f","goalId":"g","topic":"本局查询","claim":"仅记录查询结论，不改变本局","basis":"local_consistency","resources":[],"references":[]}]}}));
    assert_rejected(f.gateway.invoke(&task.permit,Fixture::request(&task,"forbidden","stage_edit",json!({"kind":"settings","path":"/premise","operation":"set","value":"不能写入","summary":"写入"}),0)));
    assert_eq!(f.finish(&task,"finish")["data"]["changed"],false);assert_eq!(f.premise(),"原设定");assert_eq!(f.count("SELECT count(*) FROM pi_commit_batches"),0);
}

#[test]
fn adopted_task_closes_writes_but_can_verify_immutable_receipt_and_finish_plan() {
    let f=Fixture::new(); let task=f.start("closeout","auto-reversible",false);
    f.gateway.attach_host(&task.permit).unwrap();
    f.stage_setting(&task); let adopted=f.finish(&task,"adopt");
    assert!(adopted["data"].get("formalSnapshot").is_none(),"full story must not enter task context");
    let receipt=f.call(&task,"receipt","read_commit_receipt",json!({"path":"/worldVersion"}));
    assert_eq!(receipt["data"]["text"],adopted["data"]["worldVersion"]);
    f.store.lock().unwrap().execute("UPDATE worlds SET settings_json=? WHERE id='world'",[json!({"premise":"后来真实进度"}).to_string()]).unwrap();
    let frozen=f.call(&task,"verify","read_committed_snapshot",json!({"kind":"settings","path":"/premise"}));
    assert_eq!(frozen["data"]["text"],"修改后的本局设定"); assert_eq!(frozen["data"]["immutable"],true);
    f.call(&task,"legacy-head","read_resource",json!({"kind":"goals"}));
    f.call(&task,"plan-done","update_plan",json!({"steps":[{"id":"adopt","text":"采用后读取正式回执","status":"completed"}]}));
    for tool in ["stage_edit","finish_task"] {
        let args=if tool=="stage_edit"{json!({"kind":"settings","path":"/premise","operation":"set","value":"禁止覆盖","summary":"不可再次修改"})}else{json!({"summary":"不可重复采用"})};
        let value=f.gateway.invoke(&task.permit,Fixture::request(&task,tool,tool,args,0)).unwrap();
        assert_eq!(value["ok"],false); assert_eq!(value["error"]["code"],"task_writes_closed");
    }
    assert_eq!(f.premise(),"后来真实进度");
    f.gateway.release_host(&task.permit).unwrap();
    f.call(&task,"later-receipt","read_commit_receipt",json!({}));
}

#[test]
fn facts_append_rejects_a_nested_list_before_staging_and_normalizes_new_source_aliases(){
    let f=Fixture::new();let task=f.start("facts-shape","auto-reversible",false);
    let invalid=f.gateway.invoke(&task.permit,Fixture::request(&task,"bad-append","stage_edit",json!({"kind":"facts","operation":"append","value":[{"id":"one","detail":"来源资料","origin":"canon","citations":[]}],"summary":"准备事实"}),0)).unwrap();
    assert_eq!(invalid["ok"],false);assert_eq!(invalid["error"]["code"],"invalid_append_item");
    let row=f.gateway.0.task(&task.id).unwrap();let before=&row["workspace_json"];assert!(before["edits"].as_array().is_none_or(Vec::is_empty));
    f.call(&task,"one-append","stage_edit",json!({"kind":"facts","operation":"append","value":{"id":"one","detail":"来源资料","origin":"canon","citations":[]},"summary":"准备单条事实"}));
    let row=f.gateway.0.task(&task.id).unwrap();let work=&row["workspace_json"];
    assert_eq!(work["edits"][0]["after"][0]["origin"],"source");
    assert_eq!(row["status"],"running");assert!(row["result_json"].is_null(),"staging must not pretend to adopt a source claim");
}
