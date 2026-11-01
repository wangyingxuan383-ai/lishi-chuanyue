//! Focused commit-gate checks. SQLite model-attempt rows below are synthetic
//! bookkeeping, not HTTP requests or real-model effects. Personal data is never
//! opened. Every story read/stage/report/finish uses the actual native gateway.
use crate::{
    pi_gateway::{StoryToolGateway, TaskPermit},
    pi_store::{NewSession, PiCallRequest},
    Result, Store,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const ORIGINAL: &str = "青铜钥匙归师父保管。";
const ORIGINAL_PREMISE: &str = "青铜钥匙归掌门保管。";

#[test]
fn agent_player_branch_and_scoped_custom_permission_keep_exact_player_sources() {
    for (kind,request,subject,value,scope,changed) in [
        ("player_setting","我设定阿兰在本局仍然活着，其余参考原著。","阿兰","仍然活着","本局","阿兰在本局仍然活着。"),
        ("local_custom","参考原著；缺少门派资料时可以自行补全门派背景。","门派","自行补全","门派背景","本局自定：玄云门立于山巅。"),
    ] {
        let f=Fixture::new();let task=f.start_with("player-branch",request,json!({}));
        f.call(&task,"stage-player-branch","stage_edit",json!({"kind":"settings","path":"/premise","operation":"set","value":changed,"summary":"按玩家明确要求准备本局分支"}));
        let check=f.check(&task,"read-current-sources");
        let source=check["constraints"]["playerReferences"].as_array().unwrap().iter().find(|r|r["id"]==format!("{}:request",task.id)).unwrap();
        assert_eq!(source["kind"],"request");assert_eq!(source["explicit"],false);
        let report=f.record(&task,"record-player-source",json!({"worldVersion":task.version,"intentRevision":0,"goals":[{"id":"branch","status":"completed","summary":"采用玩家明确指定的本局分支","requiresCanon":true}],"findings":[{"id":"player-branch","goalId":"branch","topic":"本局分支","claim":changed,"basis":kind,"resources":check["resourceGroups"],"references":[{"playerReferenceId":source["id"],"quote":request,"declaration":{"subject":subject,"value":value,"scope":scope}}]}]}));
        assert!(report["unresolvedGroupIds"].as_array().unwrap().is_empty(),"{report}");
        let adopted=f.finish(&task,"adopt-player-branch");
        assert_eq!(adopted["status"],"committed");assert_eq!(f.premise(),changed);
        let finding=&adopted["goalResult"]["normalizedFindings"][0];
        assert_eq!(finding["basis"],kind);assert_eq!(finding["references"][0]["quote"],request);
        assert_eq!(finding["references"][0]["interpretationVerified"],false);
        assert_eq!(finding["references"][0]["declaration"]["value"],value);
        assert_eq!(f.count("SELECT COUNT(*) FROM pi_model_requests"),0);
    }
}

#[test]
fn old_director_edit_permission_does_not_automatically_authorize_a_new_fact() {
    let f=Fixture::new();
    f.store.lock().unwrap().execute("UPDATE nodes SET director_note='更新人物设定资料' WHERE id='opening'",[]).unwrap();
    let task=f.start_with("generic-permission","参考原著核对设定",json!({}));
    f.stage_original(&task,"stage-unverified-fact");
    let check=f.check(&task,"player-source");
    let source=check["constraints"]["playerReferences"].as_array().unwrap().iter().find(|r|r["id"]=="opening:director_note").unwrap();
    assert_eq!(source["kind"],"request");assert_eq!(source["explicit"],false);
    let report=f.record(&task,"generic-is-not-fact",json!({"worldVersion":task.version,"intentRevision":0,"goals":[{"id":"fact","summary":"更正钥匙归属","status":"completed","requiresCanon":true}],"findings":[{"id":"unsupported","goalId":"fact","topic":"钥匙归属","claim":ORIGINAL,"basis":"player_setting","resources":check["resourceGroups"],"references":[{"playerReferenceId":source["id"],"quote":source["text"],"declaration":{"subject":"人物","value":"更新","scope":"本局"}}]}]}));
    assert!(report["validSelections"].as_array().unwrap().is_empty());
    f.rejected(&task,"reject-unverified-adoption","finish_task",json!({"summary":"权限不能证明具体事实"}));
    assert_eq!(f.premise(),ORIGINAL_PREMISE);
}

struct Task {
    id: String,
    version: String,
    revision: i64,
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
        crate::migration::migrate(&mut db, None).unwrap();
        db.execute("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('world','原著核对隔离测试','free','line',?,'test','test','test')",[json!({"premise":ORIGINAL_PREMISE,"autoUpkeep":false,"chapterEvery":0}).to_string()]).unwrap();
        db.execute_batch("INSERT INTO nodes(id,world_id,seq,kind,narrative,action_text,director_note,created_at) VALUES('opening','world',0,'opening','青铜钥匙暂交掌门保管。','我先查看钥匙，不改归属。','','test');INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('line','world','主线','opening','test')").unwrap();
        let binding = json!({"bookId":"book","through":0,"position":0,"method":"search","instructions":"原著人物和物件以第一章为准"});
        let state = json!({"version":2,"time":{"start":"第一天","elapsedMinutes":0,"startHour":8},"placeId":null,"protagonist":{"name":"旅人","aliases":[],"age":20,"gender":"男","identity":"行旅","origin":"现代","cheat":"","stats":{"money":10,"debt":0,"health":100,"energy":100,"fame":0},"statuses":[],"items":[]},"people":[],"places":[],"cards":[],"goals":[],"facts":[],"era":{"packId":null,"mode":"free","clockStyle":"elapsed"},"deviations":[],"source":binding});
        db.execute(
            "INSERT INTO states(node_id,state_json) VALUES('opening',?)",
            [state.to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO source_books VALUES('book','隔离原著','txt','test',?)",
            [json!({"sections":[{"title":"钥匙归属","text":ORIGINAL}]}).to_string()],
        )
        .unwrap();
        db.execute_batch("INSERT INTO source_sections VALUES('book',0,'钥匙归属',7)")
            .unwrap();
        db.execute("INSERT INTO source_chunks VALUES('book',0,0,?)", [ORIGINAL])
            .unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        let gateway = StoryToolGateway::new(store.clone());
        gateway
            .create_session(&NewSession {
                id: "session".into(),
                world_id: "world".into(),
                line_id: "line".into(),
                title: "核对提交闸门".into(),
                session_file: None,
            })
            .unwrap();
        Self { store, gateway }
    }
    fn start(&self, id: &str) -> Task {
        let task = self.start_with(
            id,
            "请遵循原著核对钥匙归属，并按需校准日期；不要新增剧情。",
            json!({"skills":["canon-reference"]}),
        );
        let skill = self.call(
            &task,
            "read-method",
            "read_skill",
            json!({"id":"canon-reference"}),
        );
        assert_eq!(skill["bodyRead"], true);
        task
    }
    fn start_with(&self, id: &str, text: &str, metadata: Value) -> Task {
        let row = self
            .gateway
            .start_task(
                "session",
                id,
                text,
                "auto-reversible",
                false,
                json!({"model":"no-http-model"}),
                metadata,
            )
            .unwrap();
        Task {
            id: id.into(),
            version: row["base_world_version"].as_str().unwrap().into(),
            revision: 0,
            permit: self.gateway.permit(id).unwrap(),
        }
    }
    fn invoke(&self, task: &Task, id: &str, tool: &str, args: Value) -> Result<Value> {
        self.gateway.invoke(
            &task.permit,
            PiCallRequest {
                task_id: task.id.clone(),
                call_id: id.into(),
                tool: tool.into(),
                args,
                intent_revision: task.revision,
                world_version: task.version.clone(),
                external_write: false,
            },
        )
    }
    fn call(&self, task: &Task, id: &str, tool: &str, args: Value) -> Value {
        let result = self.invoke(task, id, tool, args).unwrap();
        assert_eq!(result["ok"], true, "{tool}: {result}");
        result["data"].clone()
    }
    fn rejected(&self, task: &Task, id: &str, tool: &str, args: Value) -> String {
        match self.invoke(task, id, tool, args) {
            Err(error) => error.to_string(),
            Ok(result) => {
                assert_eq!(
                    result["ok"], false,
                    "unexpected successful {tool}: {result}"
                );
                result["error"].to_string()
            }
        }
    }
    fn stage_original(&self, task: &Task, id: &str) {
        self.call(task,id,"stage_edit",json!({"kind":"settings","path":"/premise","operation":"set","value":ORIGINAL,"summary":"按原文修正钥匙归属"}));
    }
    fn check(&self, task: &Task, id: &str) -> Value {
        let mut summary=self.call(task,id,"check_draft",json!({}));
        assert_eq!(summary["evidenceLedger"],json!([]),"default draft check is a bounded evidence summary");
        let evidence=self.call(task,&format!("evidence-{id}"),"read_evidence",json!({"pageSize":20,"charBudget":24000}));
        summary["evidenceLedger"]=evidence["value"].clone();summary
    }
    fn premise(&self) -> Value {
        let raw: String = self
            .store
            .lock()
            .unwrap()
            .query_row(
                "SELECT settings_json FROM worlds WHERE id='world'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str::<Value>(&raw).unwrap()["premise"].clone()
    }
    fn head_state(&self) -> Value {
        let raw:String=self.store.lock().unwrap().query_row("SELECT s.state_json FROM lines l JOIN states s ON s.node_id=l.node_id WHERE l.id='line'",[],|row|row.get(0)).unwrap();
        serde_json::from_str(&raw).unwrap()
    }
    fn count(&self, sql: &str) -> i64 {
        self.store
            .lock()
            .unwrap()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }
    fn original_read(&self, task: &Task) {
        let read = self.call(
            task,
            "read-original",
            "read_original",
            json!({"section":0,"chunk":0,"neighbors":0}),
        );
        assert_eq!(read["excerpts"][0]["text"], ORIGINAL);
    }
    fn confirm_original(&self, task: &Task, request: &str, status: &str, accepted: bool) {
        let hash:String=self.store.lock().unwrap().query_row("SELECT delivery_hash FROM pi_tool_deliveries WHERE task_id=? AND call_id='read-original'",[&task.id],|row|row.get(0)).unwrap();
        let admitted = self
            .gateway
            .reserve_model_context(
                &task.permit,
                request,
                "model",
                &json!({"model":"no-http-model"}),
                None,
                &json!([{"callId":"read-original","tool":"read_original","hash":hash}]),
                "model",
            )
            .unwrap();
        assert_eq!(admitted["admitted"], true);
        self.gateway
            .finish_model_context(
                &task.permit,
                request,
                &json!({"input":10,"output":2}),
                status,
                accepted,
            )
            .unwrap();
    }
    fn report(&self, task: &Task, check: &Value) -> Value {
        let page = &check["evidenceLedger"][0];
        json!({"worldVersion":task.version,"intentRevision":task.revision,"goals":[{"id":"key","summary":"按原文修正青铜钥匙归属","status":"completed","requiresCanon":true,"scope":"canon"}],"findings":[{"id":"key-owner","goalId":"key","topic":"钥匙归属","claim":"原文写明青铜钥匙归师父保管","basis":"original","sourceClaim":"原文写明青铜钥匙归师父保管","revisionDecision":{"summary":"修正本局钥匙保管设定","reason":"按当前任务核对原著身份事实并纠正模型错误","appliesTo":"identity_fact"},"resources":check["resourceGroups"],"references":[{"evidenceId":page["id"].as_str().unwrap_or("not-delivered"),"quote":ORIGINAL,"location":page.get("location").cloned().unwrap_or(json!({"bookId":"book","section":0,"chunk":0,"path":"/excerpts/0/text","offset":0})),"quoteOffset":0}]}]})
    }
    fn record(&self, task: &Task, id: &str, report: Value) -> Value {
        self.call(task, id, "record_findings", json!({"report":report}))
    }
    fn finish(&self, task: &Task, id: &str) -> Value {
        self.call(
            task,
            id,
            "finish_task",
            json!({"summary":"核对后采用本次实际修改"}),
        )
    }
    fn verified_report(&self, task: &Task) -> Value {
        self.original_read(task);
        self.confirm_original(task, "read-accepted", "success", true);
        let check = self.check(task, "check-delivered");
        assert_eq!(check["evidenceLedger"].as_array().unwrap().len(), 1);
        let report = self.report(task, &check);
        let result = self.record(task, "record-verified", report.clone());
        assert_eq!(result["status"], "completed");
        report
    }
}

#[test]
fn canon_commit_requires_original_in_successful_model_window_and_reads_back_sources() {
    let f = Fixture::new();
    let task = f.start("original-gate");
    let before = f.head_state();
    f.stage_original(&task, "stage");
    f.rejected(
        &task,
        "finish-before-read",
        "finish_task",
        json!({"summary":"不能以声明代替原文"}),
    );
    assert_eq!(f.premise(), ORIGINAL_PREMISE);
    f.original_read(&task);
    assert_eq!(
        f.count("SELECT COUNT(*) FROM pi_tool_deliveries"),
        1,
        "native candidate really exists"
    );
    let candidate_check = f.check(&task, "check-candidate");
    assert!(candidate_check["evidenceLedger"]
        .as_array()
        .unwrap()
        .is_empty());
    let rejected_report = f.record(&task, "record-candidate", f.report(&task, &candidate_check));
    assert_eq!(rejected_report["status"], "blocked");
    f.rejected(
        &task,
        "finish-candidate",
        "finish_task",
        json!({"summary":"候选结果不能当作已读原文"}),
    );
    f.confirm_original(&task, "read-failed", "failed", false);
    let failed_check = f.check(&task, "check-failed");
    assert!(failed_check["evidenceLedger"]
        .as_array()
        .unwrap()
        .is_empty());
    f.rejected(
        &task,
        "finish-failed",
        "finish_task",
        json!({"summary":"失败模型请求不能授予证据"}),
    );
    assert_eq!(f.premise(), ORIGINAL_PREMISE);
    f.confirm_original(&task, "read-success", "success", true);
    let check = f.check(&task, "check-success");
    let page = &check["evidenceLedger"][0];
    assert_eq!(page["deliveryConfirmed"], true);
    assert_eq!(page["location"]["title"], "钥匙归属");
    let recorded = f.record(&task, "record-success", f.report(&task, &check));
    assert_eq!(recorded["status"], "completed");
    let receipt = f.finish(&task, "finish-success");
    assert_eq!(receipt["status"], "committed");
    assert_eq!(receipt["goalStatus"], "completed");
    assert_eq!(receipt["goalCompleted"], true);
    assert_eq!(f.premise(), ORIGINAL);
    assert_eq!(f.head_state(), before);
    assert_eq!(f.count("SELECT COUNT(*) FROM nodes"), 1);
    assert_eq!(
        receipt["goalResult"]["normalizedFindings"][0]["references"][0]["quote"],
        ORIGINAL
    );
    assert_eq!(
        receipt["goalResult"]["normalizedFindings"][0]["references"][0]["location"]["bookId"],
        "book"
    );
    assert_eq!(receipt["goalResult"]["interpretationVerified"], false);
    assert_eq!(receipt["readBack"]["fingerprint"], receipt["worldVersion"]);
    assert_eq!(f.count("SELECT COUNT(*) FROM story_recovery_points"), 1);
    assert_eq!(
        f.count("SELECT COUNT(*) FROM pi_model_requests"),
        2,
        "only synthetic SQLite attempts; zero HTTP"
    );
}

#[test]
fn changed_complete_resource_or_new_steering_invalidates_old_report_without_story_writes() {
    for scenario in ["changed-after", "new-steer"] {
        let f = Fixture::new();
        let mut task = f.start(scenario);
        f.stage_original(&task, "stage");
        let report = f.verified_report(&task);
        if scenario == "changed-after" {
            f.call(&task,"stage-more","stage_edit",json!({"kind":"settings","path":"/premise","operation":"set","value":"改为交给尚未核实的人","summary":"核对后又改同一资源"}));
            let current = f.check(&task, "check-changed");
            assert_ne!(
                current["resourceGroups"][0]["afterFingerprint"],
                report["findings"][0]["resources"][0]["afterFingerprint"]
            );
        } else {
            let input = f
                .gateway
                .append_input(
                    &task.permit,
                    "steer",
                    &json!({"text":"先核实钥匙是不是已经移交，未经核实不要修改。"}),
                )
                .unwrap();
            f.gateway.consume_input(&task.permit, &input).unwrap();
            task.revision = 1;
            let current = f.check(&task, "check-new-intent");
            assert_eq!(current["constraints"]["intentRevision"], 1);
            assert!(current["evidenceLedger"].as_array().unwrap().is_empty());
        }
        let reason = f.rejected(
            &task,
            "reject-stale-report",
            "finish_task",
            json!({"summary":"旧报告不能采用新改稿或新要求"}),
        );
        assert!(!reason.is_empty());
        assert_eq!(f.premise(), ORIGINAL_PREMISE);
        assert_eq!(f.count("SELECT COUNT(*) FROM story_recovery_points"), 0);
        assert_eq!(f.count("SELECT COUNT(*) FROM nodes"), 1);
    }
}

#[test]
fn validated_clock_change_can_commit_with_unresolved_readonly_canon_goal_as_partial() {
    let f = Fixture::new();
    let task = f.start("partial-clock");
    let before = f.head_state();
    f.call(&task,"clock","stage_clock",json!({"operation":"display","clockStyle":"era","timeStyle":"24h","calendar":{"lunar":false},"anchor":{"atElapsedMinutes":0,"minuteOfDay":480,"date":{"era":"斗罗历","year":10015,"month":1,"day":1,"ceYear":null,"lunar":false}},"summary":"只校准显示，不改实际经过时间"}));
    let check = f.check(&task, "clock-check");
    assert!(!check["resourceGroups"].as_array().unwrap().is_empty());
    let result=f.record(&task,"partial-report",json!({"worldVersion":task.version,"intentRevision":0,"goals":[{"id":"clock","summary":"把显示校准到斗罗历10015年","status":"completed","requiresCanon":false,"scope":"mechanical"},{"id":"canon","summary":"原著钥匙转交详情尚未查明","status":"blocked","requiresCanon":true,"scope":"canon"}],"findings":[{"id":"clock-display","goalId":"clock","topic":"日期显示","claim":"只按玩家指定校准显示，实际经过时间和年龄保持","basis":"local_consistency","resources":check["resourceGroups"],"references":[]},{"id":"canon-insufficient","goalId":"canon","topic":"原著转交详情","claim":"未阅读对应原文，不能声称查清转交事件","basis":"insufficient","resources":[],"references":[]}]}));
    assert_eq!(result["status"], "partial");
    assert!(result["unresolvedGroupIds"].as_array().unwrap().is_empty());
    let receipt = f.finish(&task, "finish-partial");
    assert_eq!(receipt["status"], "committed");
    assert_eq!(receipt["goalStatus"], "partial");
    assert_eq!(receipt["goalCompleted"], false);
    assert_eq!(receipt["goalResult"]["unresolvedGoals"][0]["id"], "canon");
    assert!(receipt["clockReadBack"]["after"]["text"]
        .as_str()
        .unwrap()
        .contains("10015"));
    assert_eq!(receipt["clockReadBack"]["elapsedMinutesPreserved"], true);
    assert_eq!(receipt["clockReadBack"]["dateBasis"]["originalDateVerified"],false);
    let after = f.head_state();
    assert_eq!(
        after["time"]["elapsedMinutes"],
        before["time"]["elapsedMinutes"]
    );
    assert_eq!(after["protagonist"]["age"], before["protagonist"]["age"]);
    assert_eq!(after["era"]["mode"], "free");
    // Updating the opening state preserves the original route by copying its
    // opening node. That storage copy is not a new narrative turn or elapsed
    // story progress.
    assert_eq!(f.count("SELECT COUNT(*) FROM nodes WHERE kind='turn'"), 0);
    assert_eq!(
        f.count("SELECT n.seq FROM nodes n JOIN lines l ON l.node_id=n.id WHERE l.id='line'"),
        0
    );
    assert_eq!(f.count("SELECT COUNT(*) FROM nodes WHERE id='opening'"), 1);
    assert_eq!(f.count("SELECT COUNT(*) FROM pi_model_requests"), 0);
    assert_eq!(f.premise(), ORIGINAL_PREMISE);
}

#[test]
fn delivered_original_check_steering_activates_gate_for_an_initially_ordinary_task() {
    let f = Fixture::new();
    let mut task = f.start_with("steer-canon", "整理一下本局设定，不新增剧情。", json!({}));
    let before = f.head_state();
    assert_eq!(
        f.check(&task, "before-steer")["constraints"]["requiresCanon"],
        false
    );
    f.stage_original(&task, "stage");
    let input = f
        .gateway
        .append_input(
            &task.permit,
            "steer",
            &json!({"text":"这次必须按原著纠错，先查原文再决定归属。"}),
        )
        .unwrap();
    f.gateway.consume_input(&task.permit, &input).unwrap();
    task.revision = 1;
    let current = f.check(&task, "after-steer");
    assert_eq!(current["constraints"]["requiresCanon"], true);
    assert_eq!(current["constraints"]["intentRevision"], 1);
    let reason = f.rejected(
        &task,
        "finish-without-report",
        "finish_task",
        json!({"summary":"不能忽略执行中收到的原著核对要求"}),
    );
    assert!(
        reason.contains("record_findings"),
        "must reject for the new canon gate, rather than merely a stale transport call: {reason}"
    );
    assert_eq!(f.premise(), ORIGINAL_PREMISE);
    assert_eq!(f.head_state(), before);
    assert_eq!(
        f.count("SELECT COUNT(*) FROM pi_calls WHERE tool='read_skill'"),
        0
    );
    assert_eq!(f.count("SELECT COUNT(*) FROM story_recovery_points"), 0);
    assert_eq!(f.count("SELECT COUNT(*) FROM pi_model_requests"), 0);
}

#[test]
fn factual_change_mixed_into_clock_state_cannot_borrow_a_mechanical_scope_exemption() {
    let f = Fixture::new();
    let task = f.start("mixed-clock-fact");
    let before = f.head_state();
    f.call(
        &task,
        "clock",
        "stage_clock",
        json!({"operation":"display","timeStyle":"shichen","summary":"纯时刻显示调整"}),
    );
    let clock_only = f.check(&task, "only-clock");
    assert!(!clock_only["constraints"]["mechanicalGroupIds"]
        .as_array()
        .unwrap()
        .is_empty());
    f.call(&task,"mix-fact","stage_edit",json!({"kind":"state","path":"/protagonist/identity","operation":"set","value":"原著没有核实的新身份","summary":"把人物身份混入同一完整状态草稿"}));
    let mixed = f.check(&task, "mixed-state");
    assert!(
        mixed["constraints"]["mechanicalGroupIds"]
            .as_array()
            .unwrap()
            .is_empty(),
        "whole-resource diff must remove the clock exemption after a factual field changes"
    );
    let report=f.record(&task,"fake-mechanical-report",json!({"worldVersion":task.version,"intentRevision":0,"mechanicalGroupIds":clock_only["constraints"]["mechanicalGroupIds"],"goals":[{"id":"clock","summary":"将人物身份冒称日期显示处理","status":"completed","requiresCanon":false,"scope":"mechanical"},{"id":"canon","summary":"留一个不涉及资源的原著不足目标","status":"blocked","requiresCanon":true,"scope":"canon"}],"findings":[{"id":"mixed","goalId":"clock","topic":"日期显示","claim":"全部只是机械处理","basis":"local_consistency","resources":mixed["resourceGroups"],"references":[]},{"id":"unread","goalId":"canon","topic":"原著身份","claim":"没有读取对应原著身份资料","basis":"insufficient","resources":[],"references":[]}]}));
    assert!(report["validSelections"].as_array().unwrap().is_empty());
    assert!(!report["unresolvedGroupIds"].as_array().unwrap().is_empty());
    f.rejected(
        &task,
        "reject-mixed-commit",
        "finish_task",
        json!({"summary":"机械标签和旧白名单都不能担保混入的事实"}),
    );
    assert_eq!(f.head_state(), before);
    assert_eq!(f.premise(), ORIGINAL_PREMISE);
    assert_eq!(f.count("SELECT COUNT(*) FROM story_recovery_points"), 0);
    assert_eq!(f.count("SELECT COUNT(*) FROM nodes"), 1);
    assert_eq!(f.count("SELECT COUNT(*) FROM pi_model_requests"), 0);
}
