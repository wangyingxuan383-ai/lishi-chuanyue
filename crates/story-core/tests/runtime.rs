//! Targeted execution checks. All models and databases are isolated and local;
//! these tests never access a network service or the player's database.
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use story_core::{
    chat::{BoxFuture, Completion, Model, TextSink},
    runtime::Engine,
    Error, ModelConfig, Result, RunPlan, RunSnapshot, Store,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

enum Step {
    Reply(Completion),
    RejectContext,
    Fail(Error),
    Wait {
        started: Arc<Notify>,
        release: Arc<Notify>,
        reply: Completion,
    },
}

#[derive(Default)]
struct FakeModel {
    steps: Mutex<VecDeque<Step>>,
    requests: Mutex<Vec<Value>>,
}

impl FakeModel {
    fn scripted(steps: Vec<Step>) -> Arc<Self> {
        Arc::new(Self {
            steps: Mutex::new(steps.into()),
            requests: Mutex::new(vec![]),
        })
    }

    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

impl Model for FakeModel {
    fn complete(
        &self,
        _config: ModelConfig,
        body: Value,
        cancel: CancellationToken,
        text: TextSink,
    ) -> BoxFuture<Result<Completion>> {
        self.requests.lock().unwrap().push(body);
        let step = self.steps.lock().unwrap().pop_front();
        Box::pin(async move {
            let reply = match step {
                Some(Step::Reply(reply)) => reply,
                Some(Step::RejectContext) => return Err(Error::ContextWindow),
                Some(Step::Fail(error)) => {
                    if matches!(&error, Error::Provider { partial: true, .. }) {
                        text("已经收到部分正文".into());
                    }
                    return Err(error);
                }
                Some(Step::Wait {
                    started,
                    release,
                    reply,
                }) => {
                    started.notify_one();
                    tokio::select! {
                        _ = cancel.cancelled() => return Err(Error::Cancelled),
                        _ = release.notified() => reply,
                    }
                }
                None => return Err(Error::Invalid("隔离模型没有安排额外请求".into())),
            };
            text(reply.text.clone());
            Ok(reply)
        })
    }
}

struct Lease(Arc<AtomicUsize>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Fixture {
    store: Store,
    engine: Arc<Engine>,
    model: Arc<FakeModel>,
    leases: Arc<AtomicUsize>,
    committed: Arc<Mutex<Vec<String>>>,
}

impl Fixture {
    fn new(steps: Vec<Step>) -> Self {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        // Execute the actual shipped migrations instead of mirroring their schema.
        story_core::migration::migrate(&mut db, None).unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        store.initialize().unwrap();
        {
            let db = store.lock().unwrap();
            db.execute("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('world','隔离故事','','line','{}','test','test','test')", []).unwrap();
            db.execute("INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n0','world',0,'opening','原有正文','test')", []).unwrap();
            db.execute(
                "INSERT INTO states(node_id,state_json) VALUES('n0',?)",
                [state().to_string()],
            )
            .unwrap();
            db.execute("INSERT INTO lines(id,world_id,name,node_id,kind,created_at) VALUES('line','world','主线','n0','line','test')", []).unwrap();
        }
        let model = FakeModel::scripted(steps);
        let leases = Arc::new(AtomicUsize::new(0));
        let active = leases.clone();
        let committed = Arc::new(Mutex::new(vec![]));
        let notifications = committed.clone();
        let engine = Arc::new(Engine::new(
            store.clone(),
            model.clone(),
            Arc::new(move |_| {
                active.fetch_add(1, Ordering::SeqCst);
                Box::new(Lease(active.clone()))
            }),
            Arc::new(move |id| notifications.lock().unwrap().push(id)),
        ));
        Self {
            store,
            engine,
            model,
            leases,
            committed,
        }
    }

    fn plan(&self, id: &str) -> RunPlan {
        RunPlan {
            id: id.into(),
            world_id: "world".into(),
            line_id: "line".into(),
            head_id: "n0".into(),
            base_id: Some("n0".into()),
            kind: "turn".into(),
            model: ModelConfig {
                slot: "isolated".into(),
                url: "https://model.invalid/v1".into(),
                model: "fake".into(),
                aux_model: None,
                include_usage: true,
                max_tokens: Some(1024),
                extra: Default::default(),
            },
            messages: vec![json!({"role":"user","content":"买一张纸"})],
            extract_messages: vec![json!({"role":"user","content":"整理：{{NARRATIVE}}"})],
            state: state(),
            settings: json!({"choiceCount":0}),
            options: json!({"mode":"do","difficulty":"标准","currency":{"units":[{"name":"文","value":1}]}}),
            action: json!({"mode":"do","text":"买一张纸"}),
            meta: json!({}),
            reference: None,
            original: String::new(),
            carried_edits: vec![],
            trailing_ids: vec![],
            new_world: None,
        }
    }

    fn scalar(&self, sql: &str) -> i64 {
        self.store
            .lock()
            .unwrap()
            .query_row(sql, [], |r| r.get(0))
            .unwrap()
    }
    fn text(&self, sql: &str) -> String {
        self.store
            .lock()
            .unwrap()
            .query_row(sql, [], |r| r.get(0))
            .unwrap()
    }

    async fn settled(&self, id: &str) -> RunSnapshot {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let snapshot = self.engine.snapshot(id, 0).unwrap();
                if snapshot.status != "running" && self.leases.load(Ordering::SeqCst) == 0 {
                    return snapshot;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("isolated run did not settle")
    }
}

fn state() -> Value {
    json!({"version":2,"time":{"start":"天宝七载 冬月十七","elapsedMinutes":0},"placeId":null,"protagonist":{"name":"李安","aliases":[],"age":20,"gender":"男","identity":"行旅","origin":"现代","cheat":"","stats":{"money":10,"debt":0,"health":100,"energy":100,"fame":0},"statuses":[],"items":[]},"people":[],"places":[],"cards":[],"goals":[],"era":{"packId":null},"deviations":[]})
}

fn prose(text: &str) -> Completion {
    Completion {
        text: text.into(),
        usage: Some(json!({"prompt_tokens":12,"completion_tokens":8})),
        total_ms: 2,
        ..Default::default()
    }
}
fn record() -> Value {
    json!({"time":5,"money":-2,"items":[{"name":"纸","delta":1}]})
}
fn written() -> Completion {
    prose(&format!(
        "你付了两文，收好一张纸。<record>{}</record>",
        record()
    ))
}

#[test]
fn legacy_execution_mode_is_ignored_by_serde_instead_of_validated_or_serialized() {
    let fixture = Fixture::new(vec![]);
    let original = serde_json::to_value(fixture.plan("legacy-mode")).unwrap();
    assert!(original.get("executionMode").is_none());
    for value in [json!("agent"), json!("classic"), json!("unknown"), json!(null), json!({"old":true})] {
        let mut wire = original.clone();
        wire["executionMode"] = value;
        let plan: RunPlan = serde_json::from_value(wire).unwrap();
        assert_eq!(serde_json::to_value(plan).unwrap(), original);
    }
}

#[tokio::test]
async fn legacy_agent_flags_use_ordinary_writing_without_migrating_the_saved_state() {
    let fixture = Fixture::new(vec![Step::Reply(written())]);
    let mut plan = serde_json::to_value(fixture.plan("legacy-ordinary")).unwrap();
    plan["executionMode"] = "agent".into();
    plan["state"]["executionMode"] = "agent".into();
    let before = plan["state"].clone();
    fixture.store.lock().unwrap().execute("UPDATE states SET state_json=? WHERE node_id='n0'", [before.to_string()]).unwrap();
    fixture.engine.start(serde_json::from_value(plan).unwrap()).unwrap();
    let snapshot = fixture.settled("legacy-ordinary").await;
    assert_eq!(snapshot.status, "committed", "{:?}", snapshot.error);
    assert_eq!(fixture.model.count(), 1);
    let saved: Value = serde_json::from_str(&fixture.text("SELECT state_json FROM states WHERE node_id='n0'")).unwrap();
    assert_eq!(saved, before);
    let meta: Value = serde_json::from_str(&fixture.text("SELECT meta_json FROM nodes WHERE id<>'n0'")).unwrap();
    assert!(meta.get("executionMode").is_none());
    let stored_plan: Value = serde_json::from_str(&fixture.text("SELECT plan_json FROM execution_runs")).unwrap();
    assert!(stored_plan.get("executionMode").is_none());
}

#[tokio::test]
async fn retired_task_kind_cannot_fall_through_to_ordinary_execution() {
    let fixture = Fixture::new(vec![]);
    let mut plan = fixture.plan("retired-task");
    plan.kind = "agent_task".into();
    fixture.engine.start(plan).unwrap();
    let snapshot = fixture.settled("retired-task").await;
    assert_eq!(snapshot.status, "failed");
    assert!(snapshot.error.unwrap().contains("不支持的运行类型"));
    assert_eq!(fixture.model.count(), 0);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 1);
}

#[tokio::test]
async fn failed_opening_leaves_no_partial_world_or_nodes() {
    for storage_failure in [false, true] {
        let mut reply = written();
        if !storage_failure {
            reply.finish_reason = Some("content_filter".into());
        }
        let f = Fixture::new(vec![Step::Reply(reply)]);
        if storage_failure {
            f.store.lock().unwrap().execute_batch("CREATE TRIGGER reject_opening_state BEFORE INSERT ON states WHEN NEW.node_id <> 'n0' BEGIN SELECT RAISE(ABORT, 'isolated opening failure'); END;").unwrap();
        }
        let mut plan = f.plan("failed-opening");
        plan.kind = "opening".into();
        plan.world_id = "new-world".into();
        plan.line_id = "new-line".into();
        plan.head_id.clear();
        plan.base_id = None;
        plan.new_world = Some(json!({"title":"新故事","eraId":"free"}));
        f.engine.start(plan).unwrap();
        let saved = f.settled("failed-opening").await;
        assert_eq!(saved.status, "failed", "{:?}", saved.error);
        assert!(saved.result.is_none());
        assert_eq!(f.scalar("SELECT COUNT(*) FROM worlds"), 1);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 1);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM states"), 1);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM lines"), 1);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 1);
        assert!(f.committed.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn model_refusal_does_not_commit_a_turn_even_with_a_record() {
    let mut reply = written();
    reply.finish_reason = Some("content_filter".into());
    let f = Fixture::new(vec![Step::Reply(reply)]);
    f.engine.start(f.plan("refused-turn")).unwrap();
    let saved = f.settled("refused-turn").await;
    assert_eq!(saved.status, "failed");
    assert_eq!(saved.error_kind.as_deref(), Some("refused"));
    assert!(saved.error.unwrap().contains("原路线未改动"));
    assert!(saved.result.is_none());
    assert_eq!(f.model.count(), 1);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 1);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM states"), 1);
    assert_eq!(f.text("SELECT node_id FROM lines WHERE id='line'"), "n0");
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 1);
    assert!(f.committed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn context_retry_accounts_for_each_request_separately() {
    let f = Fixture::new(vec![Step::RejectContext, Step::Reply(written())]);
    let mut plan = f.plan("retry-usage");
    plan.messages = vec![json!({"role":"user","content":"可选背景，买一张纸","compactContent":"买一张纸"})];
    f.engine.start(plan).unwrap();
    let saved = f.settled("retry-usage").await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    assert_eq!(f.model.count(), 2);
    assert_eq!(saved.budget.model_requests, 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage WHERE outcome='failed' AND estimated=1"), 1);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage WHERE outcome='ok' AND prompt_tokens=12 AND completion_tokens=8"), 1);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 2);
    f.engine.resume("retry-usage").unwrap();
    assert_eq!(f.model.count(), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 2);
}

fn provider(kind: &str, status: Option<u16>, partial: bool) -> Error {
    Error::Provider { kind: kind.into(), status, message: "隔离服务错误".into(), partial }
}

#[tokio::test]
async fn network_before_content_retries_once_and_accounts_each_request() {
    let f = Fixture::new(vec![Step::Fail(provider("network", None, false)), Step::Reply(written())]);
    f.engine.start(f.plan("network-retry")).unwrap();
    let saved = f.settled("network-retry").await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    assert_eq!(saved.error_kind, None);
    assert_eq!(f.model.count(), 2);
    assert_eq!(saved.budget.model_requests, 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage WHERE outcome='failed' AND estimated=1"), 1);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage WHERE outcome='ok' AND prompt_tokens=12 AND completion_tokens=8"), 1);
}

#[tokio::test]
async fn network_after_partial_content_does_not_retry() {
    let f = Fixture::new(vec![Step::Fail(provider("network", None, true)), Step::Reply(written())]);
    f.engine.start(f.plan("partial-network")).unwrap();
    let saved = f.settled("partial-network").await;
    assert_eq!(saved.status, "failed");
    assert_eq!(saved.error_kind.as_deref(), Some("network"));
    assert_eq!(f.model.count(), 1);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 1);
    assert!(saved.events.iter().any(|e| e.event["type"] == "text" && e.event["full"] == "已经收到部分正文"));
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 1);
}

#[tokio::test]
async fn http_429_retries_once_and_succeeds() {
    let f = Fixture::new(vec![Step::Fail(provider("http", Some(429), false)), Step::Reply(written())]);
    f.engine.start(f.plan("quota-retry")).unwrap();
    let saved = f.settled("quota-retry").await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    assert_eq!(f.model.count(), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 2);
}

#[tokio::test]
async fn consecutive_transient_errors_stop_after_one_retry_with_persisted_kind() {
    for (kind, status, expected) in [("network", None, "network"), ("http", Some(429), "quota")] {
        let f = Fixture::new(vec![Step::Fail(provider(kind, status, false)), Step::Fail(provider(kind, status, false)), Step::Reply(written())]);
        f.engine.start(f.plan("transient-twice")).unwrap();
        let saved = f.settled("transient-twice").await;
        assert_eq!(saved.status, "failed");
        assert_eq!(saved.error_kind.as_deref(), Some(expected));
        assert_eq!(serde_json::to_value(&saved).unwrap()["errorKind"], expected);
        assert_eq!(f.text("SELECT error_kind FROM execution_runs"), expected);
        assert_eq!(f.model.count(), 2);
        assert_eq!(saved.budget.model_requests, 2);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM usage WHERE outcome='failed'"), 2);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 1);
    }
}

#[tokio::test]
async fn context_and_transient_recovery_share_one_retry_in_both_orders() {
    for context_first in [true, false] {
        let network = || Step::Fail(provider("network", None, false));
        let f = Fixture::new(if context_first { vec![Step::RejectContext, network(), Step::Reply(written())] }
            else { vec![network(), Step::RejectContext, Step::Reply(written())] });
        let mut plan = f.plan("shared-retry");
        plan.messages = vec![json!({"role":"user","content":"可选背景，买一张纸","compactContent":"买一张纸"})];
        f.engine.start(plan).unwrap();
        let saved = f.settled("shared-retry").await;
        assert_eq!(saved.status, "failed");
        assert_eq!(saved.error_kind.as_deref(), Some(if context_first { "network" } else { "context" }));
        assert_eq!(f.model.count(), 2);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 2);
    }
}

#[tokio::test]
async fn cancellation_during_retry_wait_stops_before_another_request() {
    let f = Fixture::new(vec![Step::Fail(provider("http", Some(429), false)), Step::Reply(written())]);
    f.engine.start(f.plan("cancel-retry-wait")).unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while f.scalar("SELECT COUNT(*) FROM execution_steps WHERE status='failed'") == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    let began = std::time::Instant::now();
    f.engine.stop("cancel-retry-wait").unwrap();
    let saved = f.settled("cancel-retry-wait").await;
    assert!(began.elapsed() < Duration::from_secs(1));
    assert_eq!(saved.status, "cancelled");
    assert_eq!(saved.error_kind.as_deref(), Some("cancelled"));
    assert_eq!(f.model.count(), 1);
    assert_eq!(saved.budget.model_requests, 1);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 1);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 1);
}

#[tokio::test]
async fn transient_retry_obeys_request_limit_and_only_retries_eligible_errors() {
    for (kind, status, limit, expected) in [
        ("network", None, 1, "failed"),
        ("timeout_first", None, 2, "failed"),
        ("http", Some(503), 2, "committed"),
        ("timeout_idle", None, 2, "failed"),
        ("timeout_total", None, 2, "failed"),
        ("http", Some(400), 2, "failed"),
    ] {
        let f = Fixture::new(vec![Step::Fail(provider(kind, status, false)), Step::Reply(written())]);
        let mut plan = f.plan("retry-limits");
        plan.meta["modelRequestLimit"] = limit.into();
        f.engine.start(plan).unwrap();
        let saved = f.settled("retry-limits").await;
        assert_eq!(saved.status, expected, "{kind} {status:?}: {:?}", saved.error);
        assert_eq!(f.model.count(), if expected == "committed" { 2 } else { 1 });
        assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), f.model.count() as i64);
    }
}

#[tokio::test]
async fn turn_autoplay_correction_and_ask_persist_the_same_auth_failure() {
    for kind in ["turn", "autoplay", "correction", "ask"] {
        let f = Fixture::new(vec![Step::Fail(provider("http", Some(401), false))]);
        let mut plan = f.plan("auth-exits");
        plan.kind = kind.into();
        plan.meta = json!({"referenceReviewVersion":"reference-review-2"});
        if kind == "autoplay" {
            plan.meta["autoplayCount"] = 1.into();
            plan.settings["pilot"] = "ai".into();
            f.store.lock().unwrap().execute("UPDATE worlds SET settings_json=? WHERE id='world'", [plan.settings.to_string()]).unwrap();
        }
        f.engine.start(plan).unwrap();
        let saved = f.settled("auth-exits").await;
        assert_eq!(saved.status, "failed", "{kind}: {:?}", saved.error);
        assert_eq!(saved.error_kind.as_deref(), Some("auth"), "{kind}: {:?}", saved.error);
        assert_eq!(f.model.count(), 1, "{kind}");
        assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 1, "{kind}");
        assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 1);
        if kind == "autoplay" {
            assert_eq!(f.engine.snapshot("auth-exits:step:1", 0).unwrap().error_kind.as_deref(), Some("auth"));
        }
    }
}

#[tokio::test]
async fn variant_carries_player_edits_after_the_previous_turn() {
    let f = Fixture::new(vec![Step::Reply(written()), Step::Reply(written())]);
    f.engine.start(f.plan("old-turn")).unwrap();
    assert_eq!(f.settled("old-turn").await.status, "committed");
    let old_turn = f.text("SELECT node_id FROM lines WHERE id='line'");
    let patch = json!({"setStats":{"money":50}});
    {
        let db = f.store.lock().unwrap();
        db.execute("INSERT INTO nodes(id,world_id,parent_id,seq,kind,action_text,record_json,created_at) VALUES('player-edit','world',?,2,'edit','钱 8 → 50',?,'test')", rusqlite::params![old_turn, patch.to_string()]).unwrap();
        db.execute("INSERT INTO states SELECT 'player-edit',json_set(state_json,'$.protagonist.stats.money',50) FROM states WHERE node_id=?", [&old_turn]).unwrap();
        db.execute("UPDATE lines SET node_id='player-edit' WHERE id='line'", []).unwrap();
    }
    let mut plan = f.plan("variant-edits");
    plan.kind = "variant".into();
    plan.head_id = "player-edit".into();
    plan.carried_edits = vec![json!({"record":patch,"actionText":"钱 8 → 50"})];
    f.engine.start(plan).unwrap();
    let saved = f.settled("variant-edits").await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    let result = saved.result.unwrap();
    let db = f.store.lock().unwrap();
    let (parent, kind, action, raw): (String, String, String, String) = db.query_row("SELECT n.parent_id,n.kind,n.action_text,s.state_json FROM nodes n JOIN states s ON s.node_id=n.id WHERE n.id=?", [result["headId"].as_str().unwrap()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(parent, result["nodeId"].as_str().unwrap());
    assert_eq!(kind, "edit");
    assert_eq!(action, "钱 8 → 50（已沿用）");
    let state: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(state["protagonist"]["stats"]["money"].as_f64(), Some(50.0));
    assert_eq!(state["time"]["elapsedMinutes"].as_f64(), Some(5.0));
    let old_money: f64 = db.query_row("SELECT json_extract(state_json,'$.protagonist.stats.money') FROM states WHERE node_id=?", [&old_turn], |r| r.get(0)).unwrap();
    assert_eq!(old_money, 8.0, "the old turn must remain unchanged");
}

#[tokio::test]
async fn native_autoplay_stops_after_death_or_the_last_script_beat() {
    for script in [false, true] {
        let record = if script { json!({"time":5,"beat":"done"}) } else { json!({"time":5,"died":true}) };
        let f = Fixture::new(vec![Step::Reply(prose(&format!("故事演到这里。<record>{record}</record>")))]);
        let mut plan = f.plan("auto-ending");
        plan.kind = "autoplay".into();
        plan.settings = json!({"pilot":"ai","choiceCount":0,"difficulty":"残酷"});
        plan.options["difficulty"] = "残酷".into();
        plan.meta = json!({"autoplayCount":3,"autoplayPauseMs":0});
        if script {
            plan.state["script"] = json!({"line":"送信","beats":[{"id":"last","text":"信送到了","status":"todo"}],"ending":"平安抵达"});
        }
        {
            let db = f.store.lock().unwrap();
            db.execute("UPDATE worlds SET settings_json=? WHERE id='world'", [plan.settings.to_string()]).unwrap();
            db.execute("UPDATE states SET state_json=? WHERE node_id='n0'", [plan.state.to_string()]).unwrap();
        }
        f.engine.start(plan).unwrap();
        let saved = f.settled("auto-ending").await;
        assert_eq!(saved.status, "committed", "script={script}: {:?}", saved.error);
        assert_eq!(saved.result.as_ref().unwrap()["reason"], if script { "script" } else { "died" });
        assert_eq!(saved.result.as_ref().unwrap()["steps"], 1);
        assert_eq!(f.model.count(), 1);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 2);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 1);
    }
}

#[tokio::test]
async fn manual_stop_of_native_autoplay_keeps_completed_steps_and_starts_no_more() {
    let started = Arc::new(Notify::new());
    let f = Fixture::new(vec![Step::Reply(written()), Step::Wait {
        started: started.clone(), release: Arc::new(Notify::new()), reply: written(),
    }]);
    let mut plan = f.plan("auto-stop");
    plan.kind = "autoplay".into();
    plan.settings = json!({"pilot":"ai","choiceCount":0,"difficulty":"标准"});
    plan.meta = json!({"autoplayCount":3,"autoplayPauseMs":0});
    f.store.lock().unwrap().execute("UPDATE worlds SET settings_json=? WHERE id='world'", [plan.settings.to_string()]).unwrap();
    f.engine.start(plan).unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();
    let head = f.text("SELECT node_id FROM lines WHERE id='line'");
    f.engine.stop("auto-stop").unwrap();
    let saved = f.settled("auto-stop").await;
    assert_eq!(saved.status, "cancelled");
    assert_eq!(saved.draft["steps"], 1);
    assert_eq!(f.model.count(), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 2);
    assert_eq!(f.text("SELECT node_id FROM lines WHERE id='line'"), head);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM execution_runs WHERE id='auto-stop:step:3'"), 0);
}

#[tokio::test]
async fn oversized_chapter_is_grouped_and_only_the_complete_summary_is_saved() {
    let summary = prose(r#"{"title":"青桥旧事","gist":"行旅买纸","summary":"行旅买纸后，接到了渡江口信。"}"#);
    let mut steps = vec![Step::Reply(written())];
    steps.extend((0..8).map(|_| Step::Reply(summary.clone())));
    let fixture = Fixture::new(steps);
    let mut plan = fixture.plan("chapter-groups");
    plan.meta = json!({"budgetChars":6000,"chapterFirstId":"n0","chapterVersion":"chapter-1","chapterMessages":[{"role":"system","content":"记录本章全部实际剧情，返回title/gist/summary的JSON。"},{"role":"user","content":format!("【前几章梗概】{}\n【本章剧情】\n{}结尾唯一事件：接到渡江口信。\n{{{{NARRATIVE}}}}","过去的摘要".repeat(1000),"行旅询问旧事。\n".repeat(1000))}]});
    fixture.engine.start(plan).unwrap();
    let done = fixture.settled("chapter-groups").await;
    assert_eq!(done.status,"committed");
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM chapters"),1);
    assert!(fixture.text("SELECT summary FROM chapters").contains("渡江口信"));
    let requests = fixture.model.requests.lock().unwrap();
    assert!(requests.len()>2);
    assert!(requests.iter().skip(1).all(|r| r["messages"].to_string().encode_utf16().count()<6000));
    assert!(requests.iter().any(|r|r.to_string().contains("结尾唯一事件")));
    assert!(requests.last().unwrap().to_string().contains("分组摘要"));
}
fn calls(calls: Vec<(&str, &str, Value)>) -> Completion {
    Completion { tool_calls: calls.into_iter().map(|(id,name,args)| json!({"id":id,"type":"function","function":{"name":name,"arguments":args.to_string()}})).collect(), finish_reason: Some("tool_calls".into()), usage: Some(json!({"prompt_tokens":10,"completion_tokens":6})), ..Default::default() }
}
#[tokio::test]
async fn canon_correction_delivers_required_text_and_evidence_above_the_history_target() {
    let quote = "纸铺一张纸售价两文。";
    let original = "前文。四文纸。后文。";
    let response = json!({
        "replacement":"两文纸。", "recordPatch":{},
        "corrections":[{"claim":"纸价","citations":[{"bookId":"book","section":0,"chunk":0,"quote":quote}]}]
    });
    let fixture = Fixture::new(vec![
        Step::Reply(calls(vec![
            ("skill", "read_skill", json!({"name":"canon-reference"})),
            ("original", "read_original", json!({"section":0,"chunk":0})),
        ])),
        Step::RejectContext,
        Step::Reply(prose(&response.to_string())),
    ]);
    let binding = json!({"bookId":"book","position":0,"through":0,"instructions":"保留玩家设定"});
    fixture.store.lock().unwrap().execute_batch("INSERT INTO source_books VALUES('book','短篇','txt','test','{}'); INSERT INTO source_sections VALUES('book',0,'第一章',NULL); INSERT INTO source_chunks VALUES('book',0,0,'纸铺一张纸售价两文。');").unwrap();
    let required = format!("【原著用法】保留玩家设定\n【选中范围】四文纸。\n【玩家要求】{}", "保留所选段落的完整要求".repeat(440));
    let mut plan = fixture.plan("correction-history-target");
    plan.kind = "correction".into();
    plan.state["source"] = binding.clone();
    plan.reference = Some(json!({"bookId":"book","binding":binding,"passages":[]}));
    plan.messages = vec![
        json!({"role":"system","content":"依据已读原文改稿。".repeat(240)}),
        json!({"role":"user","content":"旧行动"}),
        json!({"role":"assistant","content":"可省略的旧剧情".repeat(1500)}),
        json!({"role":"user","content":required}),
    ];
    plan.meta = json!({"budgetChars":14545,"anchor":{"original":original},"correctionRange":{"start":3,"end":7},"originalRecord":{"time":5,"money":-2}});
    fixture.engine.start(plan).unwrap();
    let snapshot = fixture.settled("correction-history-target").await;
    assert_eq!(snapshot.status, "previewed", "{:?}", snapshot.error);
    assert_eq!(snapshot.result.unwrap()["narrative"], "前文。两文纸。后文。");
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 1);
    let requests = fixture.model.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    let first_followup = &requests[1];
    let followup = &requests[2];
    assert!(first_followup.to_string().encode_utf16().count() > 14545);
    assert!(followup.to_string().len() < first_followup.to_string().len());
    assert_eq!(snapshot.draft["contextReports"]["writing:1"]["status"], "context-retry");
    let messages = followup["messages"].as_array().unwrap();
    assert!(messages.iter().any(|m| m["role"] == "user" && m["content"] == required));
    assert!(messages.iter().any(|m| m["tool_call_id"] == "original" && m["content"].as_str().unwrap().contains(quote)));
    assert!(!followup.to_string().contains("可省略的旧剧情"));
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM usage WHERE outcome='failed'"), 1);
}

#[tokio::test]
async fn context_recovery_resends_only_a_smaller_request_and_stops_after_one_rejection() {
    for optional in [false, true] {
        let fixture = Fixture::new(vec![Step::RejectContext, Step::RejectContext]);
        let mut plan = fixture.plan("provider-context");
        if optional {
            plan.messages[0] = json!({"role":"user","content":"带可选背景，买一张纸","compactContent":"买一张纸"});
        }
        fixture.engine.start(plan).unwrap();
        let snapshot = fixture.settled("provider-context").await;
        assert!(snapshot.error.unwrap().contains("上下文窗口不足"));
        assert_eq!(fixture.model.count(), if optional { 2 } else { 1 });
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 1);
        let requests = fixture.model.requests.lock().unwrap();
        assert!(requests.iter().all(|body| !body.to_string().contains("compactContent")));
        if optional {
            assert_eq!(requests[1]["messages"].as_array().unwrap().last().unwrap()["content"], "买一张纸");
        }
    }
}

#[tokio::test]
async fn large_character_results_offer_a_readable_location_and_advance_the_page() {
    let fixture = Fixture::new(vec![
        Step::Reply(calls(vec![("people", "read_characters", json!({"limit":2}))])),
        Step::Reply(calls(vec![("detail", "read_story_resources", json!({"kind":"people","query":"long-person"}))])),
        Step::Reply(prose("可以按定位查看本局人物。")),
    ]);
    let mut plan = fixture.plan("large-people-page");
    plan.kind = "ask".into();
    plan.meta = json!({"budgetChars":14545,"writingContext":{}});
    let long = "旧人物资料正文。".repeat(5000);
    plan.state["people"] = json!([
        {"id":"long-person","name":"掌柜","notes":long},
        {"id":"next-person","name":"旅人","notes":"第二项"}
    ]);
    fixture.store.lock().unwrap().execute("UPDATE states SET state_json=? WHERE node_id='n0'", [plan.state.to_string()]).unwrap();
    fixture.engine.start(plan).unwrap();
    let snapshot = fixture.settled("large-people-page").await;
    assert_eq!(snapshot.status, "previewed", "{:?}", snapshot.error);
    let requests = fixture.model.requests.lock().unwrap();
    let result = |index: usize, id: &str| -> Value {
        let message = requests[index]["messages"].as_array().unwrap().iter().find(|m| m["tool_call_id"] == id).unwrap();
        serde_json::from_str(message["content"].as_str().unwrap()).unwrap()
    };
    let page = result(1, "people");
    assert_eq!(page["people"][0]["name"], "掌柜");
    assert_eq!(page["people"][0]["read"]["query"], "long-person");
    assert_eq!(page["nextOffset"], 1);
    assert!(!page.to_string().contains(&long));
    assert!(result(2, "detail")["value"][0]["ref"].is_object());
}

#[tokio::test]
async fn classic_commits_without_a_subscriber_and_events_can_be_replayed_once() {
    let fixture = Fixture::new(vec![Step::Reply(written())]);
    fixture
        .engine
        .start(fixture.plan("classic"))
        .unwrap();
    // There is deliberately no snapshot reader until the lease has ended.
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.leases.load(Ordering::SeqCst) != 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let snapshot = fixture.engine.snapshot("classic", 0).unwrap();
    assert_eq!(snapshot.status, "committed", "{:?}", snapshot.error);
    assert_eq!(snapshot.budget.model_requests, 1);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 2);
    let node = snapshot.result.as_ref().unwrap()["nodeId"]
        .as_str()
        .unwrap();
    let state: String = fixture
        .store
        .lock()
        .unwrap()
        .query_row(
            "SELECT state_json FROM states WHERE node_id=?",
            [node],
            |r| r.get(0),
        )
        .unwrap();
    let state: Value = serde_json::from_str(&state).unwrap();
    assert_eq!(state["protagonist"]["stats"]["money"].as_f64(), Some(8.0));
    assert!(state.get("executionMode").is_none());
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM usage WHERE outcome='ok' AND node_id IS NOT NULL"),
        1
    );
    assert_eq!(fixture.committed.lock().unwrap().len(), 1);
    assert!(snapshot
        .events
        .iter()
        .any(|event| event.event["type"] == "done"));
    assert!(snapshot
        .events
        .windows(2)
        .all(|events| events[0].seq + 1 == events[1].seq));
    let last_seq = snapshot.events.last().unwrap().seq;
    assert!(fixture
        .engine
        .snapshot("classic", last_seq)
        .unwrap()
        .events
        .is_empty());
    fixture.engine.resume("classic").unwrap();
    fixture.engine.resume("classic").unwrap();
    assert_eq!(fixture.model.count(), 1);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 2);
}

#[tokio::test]
async fn stopped_extraction_resumes_cached_writing_without_duplicate_settlement_or_usage() {
    let started = Arc::new(Notify::new());
    let fixture = Fixture::new(vec![
        Step::Reply(prose("你付了两文，收好一张纸。")),
        Step::Wait {
            started: started.clone(),
            release: Arc::new(Notify::new()),
            reply: prose(&record().to_string()),
        },
        Step::Reply(prose(&record().to_string())),
    ]);
    fixture
        .engine
        .start(fixture.plan("resume"))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    // UI SQL remains available while a model is waiting.
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 1);
    fixture.engine.stop("resume").unwrap();
    let stopped = fixture.settled("resume").await;
    assert_eq!(stopped.status, "cancelled");
    assert_eq!(fixture.leases.load(Ordering::SeqCst), 0);
    fixture.engine.resume("resume").unwrap();
    let snapshot = fixture.settled("resume").await;
    assert_eq!(snapshot.status, "committed", "{:?}", snapshot.error);
    assert_eq!(
        fixture.model.count(),
        3,
        "completed writing must not be requested twice"
    );
    assert_eq!(snapshot.budget.model_requests, 3);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 2);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM usage"), 3);
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM usage WHERE outcome='ok' AND node_id IS NOT NULL"),
        2,
        "reused successful steps must belong to the committed node"
    );
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM usage WHERE outcome='failed'"),
        1
    );
    fixture.engine.resume("resume").unwrap();
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM usage"), 3);
}

#[tokio::test]
async fn moving_the_route_during_a_model_wait_refuses_the_entire_commit() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let fixture = Fixture::new(vec![Step::Wait {
        started: started.clone(),
        release: release.clone(),
        reply: written(),
    }]);
    fixture
        .engine
        .start(fixture.plan("stale"))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    fixture
        .store
        .lock()
        .unwrap()
        .execute("UPDATE lines SET deleted_at='test' WHERE id='line'", [])
        .unwrap();
    release.notify_one();
    let snapshot = fixture.settled("stale").await;
    assert_eq!(snapshot.status, "stale");
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 1);
    assert_eq!(
        fixture.text("SELECT node_id FROM lines WHERE id='line'"),
        "n0"
    );
    assert_eq!(fixture.committed.lock().unwrap().len(), 0);
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM usage WHERE node_id IS NOT NULL"),
        0
    );
}

#[tokio::test]
async fn a_storage_failure_rolls_back_body_state_and_route_together() {
    let fixture = Fixture::new(vec![Step::Reply(written())]);
    fixture.store.lock().unwrap().execute_batch("CREATE TRIGGER reject_new_state BEFORE INSERT ON states WHEN NEW.node_id <> 'n0' BEGIN SELECT RAISE(ABORT, 'isolated fault'); END;").unwrap();
    fixture
        .engine
        .start(fixture.plan("rollback"))
        .unwrap();
    let snapshot = fixture.settled("rollback").await;
    assert_eq!(snapshot.status, "failed");
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 1);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM states"), 1);
    assert_eq!(
        fixture.text("SELECT node_id FROM lines WHERE id='line'"),
        "n0"
    );
    assert!(snapshot.result.is_none());
    assert_eq!(fixture.committed.lock().unwrap().len(), 0);
}

#[tokio::test]
async fn continuation_cannot_commit_if_the_target_is_no_longer_interrupted() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let fixture = Fixture::new(vec![Step::Wait {
        started: started.clone(),
        release: release.clone(),
        reply: written(),
    }]);
    fixture
        .store
        .lock()
        .unwrap()
        .execute("UPDATE nodes SET status='interrupted' WHERE id='n0'", [])
        .unwrap();
    let mut plan = fixture.plan("continue-stale");
    plan.kind = "continue".into();
    plan.original = "原有正文".into();
    plan.meta = json!({"targetId":"n0"});
    fixture.engine.start(plan).unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    fixture
        .store
        .lock()
        .unwrap()
        .execute("UPDATE nodes SET status='ok' WHERE id='n0'", [])
        .unwrap();
    release.notify_one();
    let snapshot = fixture.settled("continue-stale").await;
    assert_eq!(snapshot.status, "stale");
    assert_eq!(
        fixture.text("SELECT narrative FROM nodes WHERE id='n0'"),
        "原有正文"
    );
    let state: Value =
        serde_json::from_str(&fixture.text("SELECT state_json FROM states WHERE node_id='n0'"))
            .unwrap();
    assert_eq!(state["protagonist"]["stats"]["money"], 10);
    assert_eq!(fixture.committed.lock().unwrap().len(), 0);
}

// Generation tiers (D161): how many requests a bound-book turn costs.
fn bound(fixture: &Fixture, id: &str, depth: &str) -> RunPlan {
    let binding = json!({"bookId":"book","fanfic":true,"plot":"canon","position":0,"through":null,"instructions":"沿原著"});
    let mut plan = fixture.plan(id);
    plan.state["source"] = binding.clone();
    plan.reference = Some(json!({"bookId":"book","binding":binding,"passages":[{"kind":"original","title":"第一章","section":0,"chunk":0,"text":"纸铺里一张纸卖三文。"}]}));
    plan.meta = json!({"budgetChars":14545,"writingContext":{},"depth":depth});
    plan
}
fn tool_names(body: &Value) -> Vec<String> {
    body["tools"].as_array().into_iter().flatten().map(|t| t["function"]["name"].as_str().unwrap_or("").to_owned()).collect()
}

#[tokio::test]
async fn fast_tier_writes_in_one_request_without_tools_or_review() {
    let fixture = Fixture::new(vec![Step::Reply(written())]);
    let mut plan = bound(&fixture, "fast", "fast");
    plan.meta["referenceReviewVersion"] = Value::Null;
    fixture.engine.start(plan).unwrap();
    let snapshot = fixture.settled("fast").await;
    assert_eq!(snapshot.status, "committed", "{:?}", snapshot.error);
    let requests = fixture.model.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].get("tools").is_none());
    // The allowance is a backstop: not mentioned while plenty remains.
    assert!(!requests[0].to_string().contains("剩余额度"));
    assert!(!requests[0].to_string().contains("list_skills"));
}

#[tokio::test]
async fn standard_tier_looks_up_once_then_must_write_and_lite_check_fixes_one_sentence() {
    let fixture = Fixture::new(vec![
        Step::Reply(calls(vec![("h", "read_history", json!({"query":"纸"}))])),
        // A service that ignores tool_choice "none" and calls again still ends the loop.
        Step::Reply(Completion { tool_calls: calls(vec![("again", "search_original", json!({"query":"纸"}))]).tool_calls, ..written() }),
        Step::Reply(prose(r#"{"issues":[{"quote":"两文","problem":"原著一张纸三文","fix":"三文"},{"quote":"不存在的句子","problem":"x","fix":"y"}]}"#)),
    ]);
    let mut plan = bound(&fixture, "standard", "standard");
    plan.meta["referenceReviewVersion"] = "reference-review-lite-1".into();
    plan.model.aux_model = Some("helper".into());
    fixture.engine.start(plan).unwrap();
    let snapshot = fixture.settled("standard").await;
    assert_eq!(snapshot.status, "committed", "{:?}", snapshot.error);
    let requests = fixture.model.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    let offered = tool_names(&requests[0]);
    assert!(!offered.is_empty() && offered.iter().all(|n| ["read_canon_notes", "search_original", "read_original", "read_history"].contains(&n.as_str())), "{offered:?}");
    assert_eq!(requests[0]["tool_choice"], "auto");
    assert_eq!(requests[1]["tool_choice"], "none");
    assert!(requests[1]["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().contains("查阅到此为止"));
    // The lite check: helper model, no tools.
    assert_eq!(requests[2]["model"], "helper");
    assert!(requests[2].get("tools").is_none());
    let node = snapshot.result.as_ref().unwrap()["nodeId"].as_str().unwrap().to_owned();
    drop(requests);
    let narrative: String = fixture.store.lock().unwrap().query_row("SELECT narrative FROM nodes WHERE id=?", [&node], |r| r.get(0)).unwrap();
    assert_eq!(narrative, "你付了三文，收好一张纸。");
    assert_eq!(snapshot.draft["referenceReview"]["version"], "reference-review-lite-1");
    assert_eq!(snapshot.draft["referenceReview"]["skipped"], 1);
}

#[tokio::test]
async fn a_failed_lite_check_keeps_the_passage_and_commits() {
    let fixture = Fixture::new(vec![Step::Reply(written()), Step::Reply(prose("我看不出问题。"))]);
    let mut plan = bound(&fixture, "lite-skip", "standard");
    plan.meta["referenceReviewVersion"] = "reference-review-lite-1".into();
    fixture.engine.start(plan).unwrap();
    let snapshot = fixture.settled("lite-skip").await;
    assert_eq!(snapshot.status, "committed", "{:?}", snapshot.error);
    assert_eq!(snapshot.draft["referenceReview"]["status"], "skipped");
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes WHERE narrative LIKE '%两文%'"), 1);
}

#[tokio::test]
async fn deep_tier_caps_lookup_rounds_and_the_allowance_goes_last_when_nearly_spent() {
    let mut steps: Vec<Step> = (0..4).map(|i| Step::Reply(calls(vec![(["a", "b", "c", "d"][i], "read_history", json!({"query":format!("纸{i}")}))]))).collect();
    steps.push(Step::Reply(written()));
    let fixture = Fixture::new(steps);
    let mut plan = bound(&fixture, "deep", "deep");
    plan.meta["modelRequestLimit"] = 6.into();
    fixture.engine.start(plan).unwrap();
    let snapshot = fixture.settled("deep").await;
    assert_eq!(snapshot.status, "committed", "{:?}", snapshot.error);
    let requests = fixture.model.requests.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert_eq!(requests[3]["tool_choice"], "auto");
    assert_eq!(requests[4]["tool_choice"], "none");
    let first = requests[0]["messages"].as_array().unwrap();
    assert!(!first[0]["content"].as_str().unwrap().contains("剩余额度"));
    assert!(!requests[0].to_string().contains("剩余额度"), "6 left: not mentioned");
    let last = requests[3]["messages"].as_array().unwrap();
    assert!(last.last().unwrap()["content"].as_str().unwrap().starts_with("【本次执行剩余额度】包括当前这次，尚可请求模型3次"));
}

#[tokio::test]
async fn standard_tier_reads_the_books_canon_notes_but_not_another_storys() {
    let fixture = Fixture::new(vec![
        Step::Reply(calls(vec![("n", "read_canon_notes", json!({"query":"掌柜"}))])),
        Step::Reply(written()),
    ]);
    fixture.store.lock().unwrap().execute_batch("INSERT INTO source_books VALUES('book','长篇','txt','test','{}');
        INSERT INTO canon_notes(id,book_id,world_id,kind,title,content,status,created_at,updated_at) VALUES('a','book',NULL,'person','人物：掌柜','掌柜姓王，脾气急。','done','t','t');
        INSERT INTO canon_notes(id,book_id,world_id,kind,title,content,status,active,created_at,updated_at) VALUES('b','book',NULL,'person','人物：掌柜（停用）','停用的札记','done',0,'t','t');").unwrap();
    let plan = bound(&fixture, "notes", "standard");
    fixture.engine.start(plan).unwrap();
    let snapshot = fixture.settled("notes").await;
    assert_eq!(snapshot.status, "committed", "{:?}", snapshot.error);
    let requests = fixture.model.requests.lock().unwrap();
    assert!(tool_names(&requests[0]).contains(&"read_canon_notes".to_owned()));
    let result = requests[1]["messages"].as_array().unwrap().iter().find(|m| m["tool_call_id"] == "n").unwrap()["content"].as_str().unwrap().to_owned();
    assert!(result.contains("掌柜姓王") && !result.contains("停用的札记"), "{result}");
}

#[tokio::test]
async fn an_observer_hears_progress_and_a_stop_without_a_passage() {
    use story_core::runtime::RunSignal;
    let seen = Arc::new(Mutex::new(Vec::<RunSignal>::new()));
    let fixture = Fixture::new(vec![Step::Reply(written())]);
    let sink = seen.clone();
    fixture.engine.observe(Arc::new(move |signal| sink.lock().unwrap().push(signal)));
    fixture.engine.start(fixture.plan("observed")).unwrap();
    assert_eq!(fixture.settled("observed").await.status, "committed");
    // A second story whose service fails before any passage.
    let failing = Fixture::new(vec![Step::Fail(Error::Invalid("服务出错".into()))]);
    let sink = seen.clone();
    failing.engine.observe(Arc::new(move |signal| sink.lock().unwrap().push(signal)));
    failing.engine.start(failing.plan("observed-fail")).unwrap();
    assert_eq!(failing.settled("observed-fail").await.status, "failed");
    let seen = seen.lock().unwrap();
    assert!(seen.iter().any(|s| matches!(s, RunSignal::Phase { phase: "thinking", title, .. } if title == "隔离故事")));
    assert!(seen.iter().any(|s| matches!(s, RunSignal::Phase { phase: "writing", chars, .. } if *chars > 0)));
    assert!(seen.iter().any(|s| matches!(s, RunSignal::Ended { run_id, status: "failed", .. } if run_id == "observed-fail")));
    assert!(!seen.iter().any(|s| matches!(s, RunSignal::Ended { run_id, .. } if run_id == "observed")));
}

#[tokio::test]
async fn a_service_error_mid_stream_is_retried_once_and_the_passage_is_written() {
    let broke = Error::Provider { kind: "stream".into(), status: None, message: "AI 服务中途出错：upstream timeout".into(), partial: true };
    let f = Fixture::new(vec![Step::Fail(broke), Step::Reply(written())]);
    f.engine.start(f.plan("stream-retry")).unwrap();
    let saved = f.settled("stream-retry").await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    assert_eq!(f.model.count(), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 2);
    // Twice in a row still stops, with the service's own words.
    let twice = || Error::Provider { kind: "stream".into(), status: None, message: "AI 服务中途出错：upstream timeout".into(), partial: true };
    let g = Fixture::new(vec![Step::Fail(twice()), Step::Fail(twice())]);
    g.engine.start(g.plan("stream-twice")).unwrap();
    let stopped = g.settled("stream-twice").await;
    assert_eq!(stopped.status, "failed");
    assert!(stopped.error.unwrap().contains("upstream timeout"));
    assert_eq!(stopped.error_kind.as_deref(), Some("network"));
}
