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
    /// The model name each request went to (备用服务, D179).
    services: Mutex<Vec<String>>,
}

impl FakeModel {
    fn scripted(steps: Vec<Step>) -> Arc<Self> {
        Arc::new(Self {
            steps: Mutex::new(steps.into()),
            requests: Mutex::new(vec![]),
            services: Mutex::new(vec![]),
        })
    }

    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

impl Model for FakeModel {
    fn complete(
        &self,
        config: ModelConfig,
        body: Value,
        cancel: CancellationToken,
        text: TextSink,
    ) -> BoxFuture<Result<Completion>> {
        self.requests.lock().unwrap().push(body);
        self.services.lock().unwrap().push(config.model.clone());
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
            fallback_model: None,
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
async fn a_truncated_self_written_opening_record_keeps_the_players_text_for_retry() {
    let player_text = "城门刚开。\n我攥着纸，朝城里走。";
    let f = Fixture::new(vec![
        Step::Reply(Completion {
            finish_reason: Some("length".into()),
            ..prose(r#"{"money":99,"choices":["入城""#)
        }),
        Step::Reply(prose(r#"{"money":6,"choices":["问路"],"log":"主角进城"}"#)),
    ]);
    let mut plan = f.plan("self-written-opening");
    plan.kind = "opening".into();
    plan.world_id = "new-world".into();
    plan.line_id = "new-line".into();
    plan.head_id.clear();
    plan.base_id = None;
    plan.new_world = Some(json!({"title":"城门","eraId":"free"}));
    plan.settings["choiceCount"] = 1.into();
    plan.meta["playerNarrative"] = player_text.into();
    plan.messages = vec![json!({"role":"user","content":player_text})];

    f.engine.start(plan).unwrap();
    let stopped = f.settled("self-written-opening").await;
    assert_eq!(stopped.status, "failed");
    assert_eq!(stopped.error_kind.as_deref(), Some("format"));
    assert_eq!(f.scalar("SELECT COUNT(*) FROM worlds WHERE id='new-world'"), 0);
    assert_eq!(f.model.count(), 1);

    f.engine.resume("self-written-opening").unwrap();
    let saved = f.settled("self-written-opening").await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    assert_eq!(f.model.count(), 2);
    assert_eq!(f.text("SELECT narrative FROM nodes WHERE world_id='new-world'"), player_text);
    let record: Value = serde_json::from_str(&f.text("SELECT record_json FROM nodes WHERE world_id='new-world'")).unwrap();
    assert_eq!(record["money"], 6);
    assert_eq!(record["choices"], json!(["问路"]));
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

fn backup() -> ModelConfig {
    ModelConfig {
        slot: "isolated-backup".into(),
        url: "https://backup.invalid/v1".into(),
        model: "backup".into(),
        aux_model: None,
        include_usage: true,
        max_tokens: Some(1024),
        extra: Default::default(),
    }
}

#[tokio::test]
async fn backup_service_takes_over_after_the_main_service_fails_twice() {
    for (kind, status) in [("http", Some(503)), ("network", None), ("http", Some(429))] {
        let f = Fixture::new(vec![Step::Fail(provider(kind, status, false)), Step::Fail(provider(kind, status, false)), Step::Reply(written())]);
        let mut plan = f.plan("backup-takes-over");
        plan.fallback_model = Some(backup());
        f.engine.start(plan).unwrap();
        let saved = f.settled("backup-takes-over").await;
        assert_eq!(saved.status, "committed", "{kind}: {:?}", saved.error);
        assert_eq!(*f.model.services.lock().unwrap(), ["fake", "fake", "backup"]);
        assert!(saved.events.iter().any(|e| e.event["type"] == "fallback" && e.event["from"] == "fake" && e.event["to"] == "backup"));
        assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 3);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 2);
    }
}

#[tokio::test]
async fn backup_service_does_not_take_over_refusals_keys_or_the_same_service() {
    for (error, expected) in [
        (Error::Refused("隔离拒绝".into()), "refused"),
        (provider("http", Some(401), false), "auth"),
        (provider("http", Some(402), false), "quota"),
    ] {
        let f = Fixture::new(vec![Step::Fail(error), Step::Reply(written())]);
        let mut plan = f.plan("no-takeover");
        plan.fallback_model = Some(backup());
        f.engine.start(plan).unwrap();
        let saved = f.settled("no-takeover").await;
        assert_eq!(saved.status, "failed");
        assert_eq!(saved.error_kind.as_deref(), Some(expected));
        assert!(f.model.services.lock().unwrap().iter().all(|s| s == "fake"));
    }
    // The backup is the service already in use: nothing to switch to.
    let f = Fixture::new(vec![Step::Fail(provider("http", Some(500), false)), Step::Fail(provider("http", Some(500), false)), Step::Reply(written())]);
    let mut plan = f.plan("same-service");
    plan.fallback_model = Some(plan.model.clone());
    f.engine.start(plan).unwrap();
    assert_eq!(f.settled("same-service").await.status, "failed");
    assert_eq!(f.model.count(), 2);
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
        // Retried like a dropped connection since D167: nothing was received yet.
        ("timeout_first", None, 2, "committed"),
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
async fn variant_reanchors_a_continuity_only_player_edit_to_the_new_passage() {
    let f = Fixture::new(vec![Step::Reply(written()), Step::Reply(written())]);
    f.engine.start(f.plan("original")).unwrap();
    assert_eq!(f.settled("original").await.status, "committed");
    let old_turn = f.text("SELECT node_id FROM lines WHERE id='line'");
    let patch = json!({"continuity":{"threads":[{"id":"paper","kind":"clue","title":"一张纸","detail":"纸张以后还用得上","status":"open",
        "source":{"nodeId":old_turn,"from":"narrative","quote":"收好一张纸"}}]}});
    {
        let db = f.store.lock().unwrap();
        db.execute("INSERT INTO nodes(id,world_id,parent_id,seq,kind,action_text,director_note,record_json,created_at)
            VALUES('clue-edit','world',?,2,'edit','留下线索','玩家备注',?,'test')", rusqlite::params![old_turn, patch.to_string()]).unwrap();
        db.execute("INSERT INTO states SELECT 'clue-edit',state_json FROM states WHERE node_id=?", [&old_turn]).unwrap();
        db.execute("UPDATE lines SET node_id='clue-edit' WHERE id='line'", []).unwrap();
    }
    let mut plan = f.plan("new-variant");
    plan.kind = "variant".into();
    plan.head_id = "clue-edit".into();
    plan.meta["targetId"] = old_turn.into();
    plan.carried_edits = vec![json!({"id":"clue-edit","record":patch,"actionText":"留下线索","directorNote":"玩家备注"})];
    f.engine.start(plan).unwrap();
    let saved = f.settled("new-variant").await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    let result = saved.result.unwrap();
    assert_ne!(result["headId"], result["nodeId"]);
    let record: Value = serde_json::from_str(&f.text("SELECT n.record_json FROM nodes n JOIN lines l ON l.node_id=n.id")).unwrap();
    assert_eq!(record["continuity"]["threads"][0]["source"]["nodeId"], result["nodeId"]);
    assert_eq!(f.text("SELECT n.director_note FROM nodes n JOIN lines l ON l.node_id=n.id"), "玩家备注");
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
async fn a_truncated_tool_group_runs_nothing_and_resume_requests_a_new_reply() {
    let mut invalid = calls(vec![("good", "read_history", json!({"query":"纸"})), ("bad", "read_history", json!({}))]);
    invalid.tool_calls[1]["function"]["arguments"] = "{\"query\":".into();
    let f = Fixture::new(vec![Step::Reply(invalid), Step::Reply(written())]);
    let mut plan = f.plan("bad-tools");
    plan.meta["depth"] = "standard".into();
    f.engine.start(plan).unwrap();
    let failed = f.settled("bad-tools").await;
    assert_eq!(failed.error_kind.as_deref(), Some("format"));
    assert_eq!(failed.failure.as_ref().unwrap()["replyStep"], "model:1");
    assert_eq!(f.scalar("SELECT COUNT(*) FROM execution_steps WHERE step_key LIKE 'tool:%'"), 0);
    f.engine.resume("bad-tools").unwrap();
    assert_eq!(f.settled("bad-tools").await.status, "committed");
    assert_eq!(f.model.count(), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 2);
}

#[tokio::test]
async fn a_reused_tool_id_cannot_return_a_different_querys_cache() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let f = Fixture::new(vec![Step::Wait { started: started.clone(), release: release.clone(),
        reply: calls(vec![("same", "read_history", json!({"query":"正文"}))]) }, Step::Reply(written())]);
    let mut plan = f.plan("tool-cache");
    plan.meta["depth"] = "standard".into();
    f.engine.start(plan).unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();
    f.store.lock().unwrap().execute("INSERT INTO execution_steps(run_id,step_key,kind,status,input_json,output_json) VALUES(
        'tool-cache','tool:0:same','read_history','done','{\"query\":\"另一段\"}','{\"sentinel\":\"不该带回的旧结果\"}')", []).unwrap();
    release.notify_one();
    assert_eq!(f.settled("tool-cache").await.status, "committed");
    let requests = f.model.requests.lock().unwrap();
    let output = requests[1]["messages"].as_array().unwrap().iter().find(|m| m["tool_call_id"] == "same").unwrap().to_string();
    assert!(output.contains("原有正文") && !output.contains("不该带回的旧结果"), "{output}");
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
    let required = format!("【原著用法】保留玩家设定\n【选中范围】四文纸。\n【玩家要求】{}", "保留所选段落的完整要求".repeat(660));
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

/// A correction on a one-chapter book, with `given` passages shown up front.
fn correction_fixture(steps: Vec<Step>, id: &str, given: &[Value], hint: &str) -> (Fixture, RunPlan) {
    let fixture = Fixture::new(steps);
    let binding = json!({"bookId":"book","position":0,"through":0,"instructions":"保留玩家设定"});
    fixture.store.lock().unwrap().execute_batch("INSERT INTO source_books VALUES('book','短篇','txt','test','{}'); INSERT INTO source_sections VALUES('book',0,'第一章',NULL); INSERT INTO source_chunks VALUES('book',0,0,'纸铺一张纸售价两文。入门比试分为实战与理论两项。');").unwrap();
    let mut plan = fixture.plan(id);
    plan.kind = "correction".into();
    plan.state["source"] = binding.clone();
    plan.reference = Some(json!({"bookId":"book","binding":binding,"passages":given}));
    let shown: String = given.iter().map(|p| format!("[原著·第一章·原文·片段1]\n{}\n", p["text"].as_str().unwrap())).collect();
    plan.messages = vec![json!({"role":"system","content":"依据已读原文改稿。"}), json!({"role":"user","content":format!("{shown}【选中范围】四文纸。\n【玩家要求】{hint}")})];
    plan.meta = json!({"budgetChars":14545,"anchor":{"original":"前文。四文纸。后文。"},"correctionRange":{"start":3,"end":7},"originalRecord":{"time":5,"money":-2}});
    (fixture, plan)
}

fn up_front() -> Value {
    json!({"kind":"original","bookId":"book","title":"第一章","section":0,"chunk":0,"start":0,"text":"纸铺一张纸售价两文。入门比试分为实战与理论两项。"})
}

#[tokio::test]
async fn a_correction_with_evidence_up_front_answers_in_one_request_and_the_skill_comes_with_it() {
    // The quote has other punctuation and no book, chapter or chunk: it is still found.
    let reply = json!({"outcome":"changed","replacement":"两文纸。","recordPatch":{},"corrections":[{"detail":"纸价两文","citations":[{"quote":"纸铺 一张纸售价两文","page":3}]}]});
    let (f, plan) = correction_fixture(vec![Step::Reply(prose(&reply.to_string()))], "up-front", &[up_front()], "核对纸价");
    f.engine.start(plan).unwrap();
    let saved = f.settled("up-front").await;
    assert_eq!(saved.status, "previewed", "{:?}", saved.error);
    let result = saved.result.unwrap();
    assert_eq!(result["outcome"], "changed");
    assert_eq!(result["narrative"], "前文。两文纸。后文。");
    let cite = &result["corrections"][0]["citations"][0];
    assert_eq!(cite["quote"], "纸铺一张纸售价两文");
    assert!(cite.get("page").is_none());
    assert_eq!((cite["bookId"].clone(), cite["section"].clone(), cite["chunk"].clone(), cite["start"].clone()), (json!("book"), json!(0), json!(0), json!(0)));
    assert_eq!(f.model.count(), 1);
    let first = f.model.requests.lock().unwrap()[0].clone();
    assert!(first["messages"][1]["content"].as_str().unwrap().contains("遵循原著技能"));
    assert!(saved.draft["skillVersions"]["canon-reference"].is_string());
}

#[tokio::test]
async fn a_passage_that_already_matches_the_book_is_verified_and_a_question_is_answered() {
    for (outcome, hint) in [("verified", "核对比试"), ("answer", "比试是什么")] {
        let reply = json!({"outcome":outcome,"answer":"入门比试分实战与理论两项。","findings":[{"detail":"比试分两项","citations":[{"quote":"入门比试分为实战与理论两项"}]}]});
        let (f, plan) = correction_fixture(vec![Step::Reply(prose(&reply.to_string()))], "checked", &[up_front()], hint);
        f.engine.start(plan).unwrap();
        let saved = f.settled("checked").await;
        assert_eq!(saved.status, "previewed", "{outcome}: {:?}", saved.error);
        let result = saved.result.unwrap();
        assert_eq!(result["outcome"], outcome);
        assert_eq!(result["narrative"], "前文。四文纸。后文。");
        assert_eq!(result["corrections"], json!([]));
        assert_eq!(result["findings"][0]["citations"][0]["quote"], "入门比试分为实战与理论两项");
    }
}

#[tokio::test]
async fn a_correction_that_finds_no_basis_reports_what_it_searched_after_six_rounds() {
    // Something the book does not have (a fanfic protagonist's own setting).
    let mut steps: Vec<Step> = ["s0", "s1", "s2", "s3", "s4", "s5"].into_iter().map(|id| Step::Reply(calls(vec![(id, "search_original", json!({"query":"紫色魂环"}))]))).collect();
    steps.push(Step::Reply(prose(&json!({"outcome":"not_found","unresolved":["原著没有写到主角的魂环"]}).to_string())));
    let (f, plan) = correction_fixture(steps, "rounds", &[], "魂环是紫紫");
    f.engine.start(plan).unwrap();
    let saved = f.settled("rounds").await;
    assert_eq!(saved.status, "previewed", "{:?}", saved.error);
    let result = saved.result.unwrap();
    assert_eq!(result["outcome"], "not_found");
    assert_eq!(result["reason"], "no_excerpt");
    assert_eq!(result["searched"], json!([{"tool":"search_original","query":"紫色魂环","hits":0,"times":6}]));
    assert_eq!(result["unresolved"], json!(["原著没有写到主角的魂环"]));
    let requests = f.model.requests.lock().unwrap();
    assert_eq!(requests.len(), 7);
    assert!(requests[6].to_string().contains("不要再调用工具"));
    assert!(!requests[5].to_string().contains("不要再调用工具"));
}

#[tokio::test]
async fn a_quote_that_was_never_read_fails_as_a_mismatch_and_keeps_the_lists() {
    let reply = json!({"outcome":"changed","replacement":"两文纸。","corrections":[{"detail":"纸价","citations":[{"quote":"纸铺一张纸售价三文钱整"}]}],"unresolved":["纸的种类"]});
    let (f, plan) = correction_fixture(vec![Step::Reply(prose(&reply.to_string()))], "mismatch", &[up_front()], "核对纸价");
    f.engine.start(plan).unwrap();
    let saved = f.settled("mismatch").await;
    assert_eq!(saved.status, "failed");
    assert_eq!(saved.draft["correctionStop"]["code"], "quote_mismatch");
    assert_eq!(saved.draft["correctionStop"]["quotes"], json!(["纸铺一张纸售价三文钱整"]));
    assert_eq!(saved.draft["correctionStop"]["unresolved"], json!(["纸的种类"]));
}

#[tokio::test]
async fn a_correction_paused_at_its_allowance_goes_on_from_what_it_read() {
    let reply = json!({"outcome":"answer","answer":"两项","findings":[{"detail":"比试","citations":[{"quote":"入门比试分为实战与理论两项"}]}]});
    let (f, mut plan) = correction_fixture(vec![
        Step::Reply(calls(vec![("r0", "read_original", json!({"section":0}))])),
        Step::Reply(prose(&reply.to_string())),
    ], "paused", &[], "比试是什么");
    plan.meta["modelRequestLimit"] = 1.into();
    f.engine.start(plan).unwrap();
    let paused = f.settled("paused").await;
    assert_eq!(paused.status, "paused", "{:?}", paused.error);
    f.engine.resume("paused").unwrap();
    let saved = f.settled("paused").await;
    assert_eq!(saved.status, "previewed", "{:?}", saved.error);
    assert_eq!(saved.result.unwrap()["outcome"], "answer");
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
async fn reconnect_reads_the_latest_stream_text_without_replaying_older_full_copies() {
    let f = Fixture::new(vec![]);
    f.store.register(&f.plan("buffered")).unwrap();
    let first = f.store.event("buffered", json!({"type":"thinking"})).unwrap();
    for size in 1..=200 {
        f.store.event("buffered", json!({"type":"text","full":"字".repeat(size)})).unwrap();
    }
    let phase = f.store.event("buffered", json!({"type":"organizing"})).unwrap();
    let snapshot = f.store.snapshot("buffered", first.seq).unwrap();
    assert_eq!(snapshot.events.len(), 2);
    assert_eq!(snapshot.events[0].event["full"], "字".repeat(200));
    assert_eq!(snapshot.events[1].seq, phase.seq);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM execution_progress WHERE run_id='buffered'"), 1);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM execution_events WHERE run_id='buffered'"), 2);
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
        fixture.scalar("SELECT COUNT(*) FROM usage WHERE outcome='cancelled'"),
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
async fn a_new_setting_after_generation_preparation_cannot_be_overlooked() {
    let fixture = Fixture::new(vec![]);
    let mut plan = fixture.plan("settings-changed");
    plan.meta["settingsGuard"] = json!({});
    plan.meta["generationSnapshot"] = true.into();
    fixture.store.lock().unwrap().execute(
        "UPDATE worlds SET settings_json=? WHERE id='world'", [json!({"rules":"新规则"}).to_string()],
    ).unwrap();

    assert!(matches!(fixture.engine.start(plan), Err(Error::Stale)));
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM execution_runs"), 0);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM usage"), 0);
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
        Step::Reply(prose(r#"{"issues":[{"quote":"两文","problem":"原著一张纸三文","fix":"三文","citations":[{"section":1,"chunk":1,"quote":"一张纸卖三文"}],"recordPatch":{"money":-3}}]}"#)),
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
    assert_eq!(snapshot.draft["referenceReview"]["version"], "reference-review-lite-4");
    assert_eq!(snapshot.draft["referenceReview"]["skipped"], 0);
    let saved: String=fixture.store.lock().unwrap().query_row("SELECT record_json FROM nodes WHERE id=?",[&node],|r|r.get(0)).unwrap();
    let record: Value=serde_json::from_str(&saved).unwrap();
    assert_eq!(record["money"],-3);assert_eq!(record["time"],5);assert_eq!(record["items"][0]["name"],"纸");
    let state: String=fixture.store.lock().unwrap().query_row("SELECT state_json FROM states WHERE node_id=?",[&node],|r|r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&state).unwrap()["protagonist"]["stats"]["money"].as_f64(),Some(7.0));
}

#[tokio::test]
async fn a_failed_lite_check_keeps_the_passage_and_commits() {
  for malformed in ["我看不出问题。",r#"{"issues":[{"quote":"两文","fix":"三文","recordPatch":{"money":-3,"items":[]}}"#] {
    let fixture = Fixture::new(vec![Step::Reply(written()), Step::Reply(prose(malformed))]);
    let mut plan = bound(&fixture, "lite-skip", "standard");
    plan.meta["referenceReviewVersion"] = "reference-review-lite-1".into();
    fixture.engine.start(plan).unwrap();
    let snapshot = fixture.settled("lite-skip").await;
    assert_eq!(snapshot.status, "committed", "{:?}", snapshot.error);
    assert_eq!(snapshot.draft["referenceReview"]["status"], "skipped");
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes WHERE narrative LIKE '%两文%'"), 1);
  }
}

#[tokio::test]
async fn a_rejected_lite_correction_cannot_leak_into_a_later_record_patch() {
    let fixture=Fixture::new(vec![Step::Reply(written()),Step::Reply(prose(r#"{"issues":[{"quote":"不存在的纸","fix":"布","recordPatch":{"items":[{"name":"布","delta":1}]}},{"quote":"两文","fix":"三文","recordPatch":{"money":-3,"items":[{"name":"布","delta":1}]}}]}"#))]);
    let mut plan=bound(&fixture,"dependent-lite","standard");plan.meta["referenceReviewVersion"]="reference-review-lite-2".into();
    fixture.engine.start(plan).unwrap();let saved=fixture.settled("dependent-lite").await;
    assert_eq!(saved.status,"committed","{:?}",saved.error);
    let id=saved.result.as_ref().unwrap()["nodeId"].as_str().unwrap();
    let record:String=fixture.store.lock().unwrap().query_row("SELECT record_json FROM nodes WHERE id=?",[id],|r|r.get(0)).unwrap();
    let record:Value=serde_json::from_str(&record).unwrap();
    assert_eq!(record["items"][0]["name"],"纸","a rejected sentence must not change the item through a later patch: {record}");
    assert_eq!(record["money"],-2);
    assert!(!saved.draft["referenceReview"]["unresolved"].as_array().unwrap().is_empty());
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
async fn canon_notes_tool_respects_the_same_chapter_limit_as_the_writer() {
    let fixture=Fixture::new(vec![Step::Reply(calls(vec![("n","read_canon_notes",json!({"query":"掌柜"}))])),Step::Reply(written())]);
    fixture.store.lock().unwrap().execute_batch("INSERT INTO source_books VALUES('book','长篇','txt','test','{}');
      INSERT INTO canon_notes(id,book_id,kind,title,scope_json,content,refs_json,status,created_at,updated_at) VALUES
      ('safe','book','person','掌柜','{}','掌柜在第一章开店。','[0]','done','t','t'),
      ('later','book','plot','掌柜后传','{\"from\":0,\"to\":3}','掌柜后来继位。','[0,3]','done','t','t'),
      ('unknown','book','person','掌柜旧札记','{}','掌柜另一个未来身份。','[]','done','t','t');").unwrap();
    let mut plan=bound(&fixture,"limited-notes","standard");plan.state["source"]["through"]=0.into();
    fixture.engine.start(plan).unwrap();assert_eq!(fixture.settled("limited-notes").await.status,"committed");
    let requests=fixture.model.requests.lock().unwrap();
    let result=requests[1]["messages"].as_array().unwrap().iter().find(|m|m["tool_call_id"]=="n").unwrap()["content"].as_str().unwrap();
    assert!(result.contains("第一章开店")&&!result.contains("继位")&&!result.contains("未来身份"),"{result}");
}

#[tokio::test]
async fn chosen_story_notes_are_available_without_a_book_but_off_route_notes_are_excluded() {
    for selected in [false, true] {
        let f = Fixture::new(vec![Step::Reply(calls(vec![("n","read_canon_notes",json!({"query":"掌柜"}))])),Step::Reply(written())]);
        f.store.lock().unwrap().execute_batch("INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,created_at) VALUES('other','world','n0',1,'turn','旧路','test');
            INSERT INTO story_notes(id,world_id,kind,title,scope_json,content,status,created_at,updated_at) VALUES
            ('here','world','plot','当前路线','{\"toNode\":\"n0\"}','掌柜已经回家。','done','t','t'),
            ('there','world','plot','其他路线','{\"toNode\":\"other\"}','掌柜死在旧路。','done','t','t');").unwrap();
        let mut plan = f.plan("story-notes");
        plan.meta["depth"] = "standard".into();
        if selected { plan.meta["sourceScope"] = json!({"mode":"notes","noteIds":["here","there"]}); }
        f.engine.start(plan).unwrap();
        assert_eq!(f.settled("story-notes").await.status, "committed");
        let requests = f.model.requests.lock().unwrap();
        assert!(tool_names(&requests[0]).contains(&"read_canon_notes".to_owned()));
        let result = requests[1]["messages"].as_array().unwrap().iter().find(|m| m["tool_call_id"] == "n").unwrap().to_string();
        assert!(result.contains("掌柜已经回家") && !result.contains("掌柜死在旧路"), "{result}");
    }
}

#[tokio::test]
async fn only_this_storys_question_note_may_have_no_chapter_references_under_a_limit() {
    let f = Fixture::new(vec![Step::Reply(calls(vec![("n","read_canon_notes",json!({"query":"掌柜"}))])),Step::Reply(written())]);
    f.store.lock().unwrap().execute_batch("INSERT INTO source_books VALUES('book','长篇','txt','test','{}');
        INSERT INTO canon_notes(id,book_id,world_id,kind,title,content,refs_json,status,created_at,updated_at) VALUES
        ('ours','book','world','question','问事','掌柜房钱已收。','[]','done','t','t'),
        ('shared','book',NULL,'question','问事','掌柜将去远方。','[]','done','t','t'),
        ('late','book','world','question','问事','掌柜以后继位。','[6]','done','t','t');").unwrap();
    let mut plan = bound(&f, "limited-question", "standard");
    plan.state["source"]["through"] = 5.into();
    f.engine.start(plan).unwrap();
    assert_eq!(f.settled("limited-question").await.status, "committed");
    let requests = f.model.requests.lock().unwrap();
    let result = requests[1]["messages"].as_array().unwrap().iter().find(|m| m["tool_call_id"] == "n").unwrap().to_string();
    assert!(result.contains("掌柜房钱已收") && !result.contains("将去远方") && !result.contains("以后继位"), "{result}");
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
async fn notification_stop_targets_one_launch_and_ignores_a_stale_action_after_resume() {
    use story_core::runtime::RunSignal;
    async fn stopped_while_other_runs(fixture:&Fixture,id:&str) {
        tokio::time::timeout(Duration::from_secs(5),async {
            loop {
                if fixture.engine.snapshot(id,0).unwrap().status=="cancelled" && fixture.leases.load(Ordering::SeqCst)==1 {break;}
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("targeted stop did not finish while the other story stayed active");
    }
    let (a_started,b_started,resumed_started)=(Arc::new(Notify::new()),Arc::new(Notify::new()),Arc::new(Notify::new()));
    let b_release=Arc::new(Notify::new());
    let fixture=Fixture::new(vec![
        Step::Wait{started:a_started.clone(),release:Arc::new(Notify::new()),reply:written()},
        Step::Wait{started:b_started.clone(),release:b_release.clone(),reply:written()},
        Step::Wait{started:resumed_started.clone(),release:Arc::new(Notify::new()),reply:written()},
    ]);
    {
        let db=fixture.store.lock().unwrap();
        db.execute("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('other','另一故事','','other-line','{}','t','t','t')",[]).unwrap();
        db.execute("INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('other-n','other',0,'opening','另一开场','t')",[]).unwrap();
        db.execute("INSERT INTO states(node_id,state_json) VALUES('other-n',?)",[state().to_string()]).unwrap();
        db.execute("INSERT INTO lines(id,world_id,name,node_id,kind,created_at) VALUES('other-line','other','主线','other-n','line','t')",[]).unwrap();
    }
    let seen=Arc::new(Mutex::new(Vec::new()));let sink=seen.clone();
    fixture.engine.observe(Arc::new(move |s|sink.lock().unwrap().push(s)));
    fixture.engine.start(fixture.plan("stop-a")).unwrap();a_started.notified().await;
    let mut other=fixture.plan("stop-b");other.world_id="other".into();other.line_id="other-line".into();other.head_id="other-n".into();other.base_id=Some("other-n".into());
    fixture.engine.start(other).unwrap();b_started.notified().await;
    let batch=||seen.lock().unwrap().iter().rev().find_map(|s|match s {RunSignal::Phase{run_id,execution_id,..} if run_id=="stop-a"=>Some(execution_id.clone()),_=>None}).unwrap();
    let old=batch();fixture.engine.stop_execution("stop-a",&old).unwrap();
    stopped_while_other_runs(&fixture,"stop-a").await;
    assert_eq!(fixture.engine.snapshot("stop-b",0).unwrap().status,"running");
    fixture.engine.resume("stop-a").unwrap();resumed_started.notified().await;
    let new=batch();assert_ne!(old,new);
    fixture.engine.stop_execution("stop-a",&old).unwrap();
    assert_eq!(fixture.engine.snapshot("stop-a",0).unwrap().status,"running");
    fixture.engine.stop_execution("stop-a",&new).unwrap();stopped_while_other_runs(&fixture,"stop-a").await;
    b_release.notify_one();assert_eq!(fixture.settled("stop-b").await.status,"committed");
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
    // A break mid-stream is its own kind now (R30), with the service's words kept.
    assert_eq!(stopped.error_kind.as_deref(), Some("stream"));
    let failure = stopped.failure.expect("typed failure");
    assert_eq!((failure["kind"].as_str(), failure["stage"].as_str(), failure["sent"].as_str(), failure["requests"].as_u64()), (Some("stream"), Some("write"), Some("yes"), Some(2)));
    assert!(failure["said"].as_str().unwrap().contains("upstream timeout"));
    assert_eq!(stopped.failures.len(), 1);
}

#[tokio::test]
async fn a_missing_record_is_typed_and_its_retry_really_asks_again() {
    // The passage is written; neither it nor the extraction gives a record.
    let f = Fixture::new(vec![
        Step::Reply(prose("你付了两文，收好一张纸。")),
        Step::Reply(prose("不是记录")),
        Step::Reply(prose(&record().to_string())),
    ]);
    f.engine.start(f.plan("no-record")).unwrap();
    let saved = f.settled("no-record").await;
    assert_eq!(saved.status, "failed");
    assert_eq!(saved.error_kind.as_deref(), Some("format"));
    let failure = saved.failure.clone().expect("typed failure");
    assert_eq!((failure["kind"].as_str(), failure["stage"].as_str(), failure["requests"].as_u64()), (Some("format"), Some("record"), Some(2)));
    assert!(failure.get("said").is_none(), "no service words for a local failure");
    assert_eq!(saved.failures, vec![failure.clone()]);
    assert_eq!(f.model.count(), 2);
    // Before 0.16.0 this replayed the saved extraction and failed again with no
    // request at all. Now only the extraction is asked again; the passage stays.
    f.engine.resume("no-record").unwrap();
    let again = f.settled("no-record").await;
    assert_eq!(again.status, "committed", "{:?}", again.error);
    assert_eq!(f.model.count(), 3);
    assert_eq!(f.text("SELECT narrative FROM nodes WHERE id<>'n0'"), "你付了两文，收好一张纸。");
    assert_eq!(f.scalar("SELECT COUNT(*) FROM execution_failures WHERE run_id='no-record'"), 1);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM execution_steps WHERE run_id='no-record' AND status='stale'"), 1);
}

#[tokio::test]
async fn a_length_stopped_reply_never_advances_story_and_retries_only_the_broken_stage() {
    let limited = |text: &str| Completion { finish_reason: Some("length".into()), ..prose(text) };
    let cut_writing = Fixture::new(vec![Step::Reply(limited("你沿着城墙走了几步，还")), Step::Reply(written())]);
    cut_writing.engine.start(cut_writing.plan("cut-prose")).unwrap();
    let failed = cut_writing.settled("cut-prose").await;
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.draft["partialNarrative"], "你沿着城墙走了几步，还");
    assert_eq!(cut_writing.scalar("SELECT COUNT(*) FROM nodes"), 1);
    cut_writing.engine.resume("cut-prose").unwrap();
    assert_eq!(cut_writing.settled("cut-prose").await.status, "committed");
    assert_eq!(cut_writing.model.count(), 2);

    let cut_extraction = Fixture::new(vec![
        Step::Reply(prose("你付了两文，收好一张纸。")),
        Step::Reply(limited(&record().to_string())),
        Step::Reply(prose(&record().to_string())),
    ]);
    cut_extraction.engine.start(cut_extraction.plan("cut-extract")).unwrap();
    let failed = cut_extraction.settled("cut-extract").await;
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.failure.as_ref().unwrap()["stage"], "record");
    assert_eq!(cut_extraction.scalar("SELECT COUNT(*) FROM nodes"), 1);
    cut_extraction.engine.resume("cut-extract").unwrap();
    assert_eq!(cut_extraction.settled("cut-extract").await.status, "committed");
    assert_eq!(cut_extraction.model.count(), 3);
    assert_eq!(cut_extraction.scalar("SELECT COUNT(*) FROM usage WHERE outcome='no_record'"), 1);
}

#[tokio::test]
async fn completing_missing_time_and_choices_keeps_existing_purchase_changes() {
    let f = Fixture::new(vec![
        Step::Reply(prose(r#"你付了两文，收好一张纸。<record>{"money":-2,"items":[{"name":"纸","delta":1}]}</record>"#)),
        Step::Reply(prose(r#"{"time":5,"choices":["去找先生"],"money":-7,"items":[{"name":"伞","delta":1}]}"#)),
    ]);
    let mut plan = f.plan("complete-selected-action");
    plan.settings["choiceCount"] = 1.into();
    f.engine.start(plan).unwrap();

    let saved = f.settled("complete-selected-action").await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    assert_eq!(f.model.count(), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes WHERE kind='turn'"), 1);
    assert_eq!(f.text("SELECT narrative FROM nodes WHERE kind='turn'"), "你付了两文，收好一张纸。");
    let record: Value = serde_json::from_str(&f.text("SELECT record_json FROM nodes WHERE kind='turn'")).unwrap();
    assert_eq!(record["time"], 5);
    assert_eq!(record["choices"], json!(["去找先生"]));
    assert_eq!(record["money"], -2);
    let items = record["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["name"], "纸");
    assert_eq!(items[0]["delta"].as_f64(), Some(1.0));
}

#[tokio::test]
async fn a_refused_passage_is_written_again_on_retry() {
    let mut refused = written();
    refused.finish_reason = Some("content_filter".into());
    let f = Fixture::new(vec![Step::Reply(refused), Step::Reply(written())]);
    f.engine.start(f.plan("refused-retry")).unwrap();
    let saved = f.settled("refused-retry").await;
    assert_eq!((saved.status.as_str(), saved.error_kind.as_deref()), ("failed", Some("refused")));
    assert_eq!(saved.failure.as_ref().unwrap()["stage"], "write");
    f.engine.resume("refused-retry").unwrap();
    let again = f.settled("refused-retry").await;
    assert_eq!(again.status, "committed", "{:?}", again.error);
    assert_eq!(f.model.count(), 2);
}

#[tokio::test]
async fn a_story_held_by_another_passage_is_refused_as_busy_not_as_settings() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let f = Fixture::new(vec![Step::Wait { started: started.clone(), release: release.clone(), reply: written() }]);
    f.engine.start(f.plan("holder")).unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();
    let refused = f.engine.start(f.plan("second")).unwrap_err();
    assert!(matches!(&refused, Error::Busy { holder, .. } if holder == "turn"), "{refused:?}");
    assert_eq!(story_core::failure_kind(&refused), "busy");
    let record = story_core::failure::refused_at_start(&refused);
    assert_eq!((record["kind"].as_str(), record["sent"].as_str(), record["requests"].as_u64()), (Some("busy"), Some("no"), Some(0)));
    release.notify_one();
    assert_eq!(f.settled("holder").await.status, "committed");
}

#[tokio::test]
async fn a_run_whose_owner_is_gone_is_interrupted_instead_of_blocking_the_story() {
    let f = Fixture::new(vec![Step::Reply(written())]);
    // A run left "running" by a process that ended: its lease lapsed long ago.
    let plan = f.plan("orphan");
    f.store.register(&plan).unwrap();
    f.store.lock().unwrap().execute("UPDATE world_execution_leases SET expires_at_ms=1", []).unwrap();
    let seen = f.engine.snapshot("orphan", 0).unwrap();
    assert_eq!(seen.status, "interrupted");
    assert_eq!(seen.failure.as_ref().unwrap()["kind"], "interrupted");
    assert!(seen.events.iter().any(|e| e.event["type"] == "failed" && e.event["reason"] == "interrupted"));
    // The story is free: a new passage starts and is written.
    f.engine.start(f.plan("after-orphan")).unwrap();
    assert_eq!(f.settled("after-orphan").await.status, "committed");
}

#[tokio::test]
async fn a_look_up_neither_holds_the_story_nor_waits_for_a_passage() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let f = Fixture::new(vec![Step::Wait { started: started.clone(), release: release.clone(), reply: prose("王掌柜是邸店掌柜。") }, Step::Reply(written())]);
    let mut ask = f.plan("look-up");
    ask.kind = "ask".into();
    f.engine.start(ask).unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();
    // Opening another native host must recognize the question's private lease.
    f.engine.recover_on_start().unwrap();
    assert_eq!(f.store.snapshot("look-up", 0).unwrap().status, "running");
    // A passage starts while the question is still being answered.
    f.engine.start(f.plan("while-asking")).unwrap();
    release.notify_one();
    assert_eq!(f.settled("look-up").await.status, "previewed");
    assert_eq!(f.settled("while-asking").await.status, "committed");
}

#[tokio::test]
async fn a_stop_by_the_phone_system_is_not_recorded_as_the_players_stop() {
    let started = Arc::new(Notify::new());
    let f = Fixture::new(vec![Step::Wait { started: started.clone(), release: Arc::new(Notify::new()), reply: written() }, Step::Reply(written())]);
    f.engine.start(f.plan("system-stop")).unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();
    f.engine.system_stop_all("android");
    let saved = f.settled("system-stop").await;
    assert_eq!((saved.status.as_str(), saved.error_kind.as_deref()), ("interrupted", Some("system_stop")));
    // It continues like any interruption.
    f.engine.resume("system-stop").unwrap();
    assert_eq!(f.settled("system-stop").await.status, "committed");
}

#[tokio::test]
async fn tidying_runs_after_the_passage_is_saved_and_never_holds_the_story() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let upkeep = prose(r#"{"cards":[{"kind":"物品","name":"铜鹰符","keys":["鹰符"],"content":"平卢军的调兵信物"}],"places":[]}"#);
    let f = Fixture::new(vec![Step::Reply(written()), Step::Wait { started: started.clone(), release: release.clone(), reply: upkeep }, Step::Reply(written())]);
    let mut plan = f.plan("tidy");
    plan.meta = json!({"upkeepVersion":"upkeep-test","upkeepMessages":[{"role":"system","content":"替作者维护“设定集”"},{"role":"user","content":"{{NARRATIVE}}"}]});
    f.engine.start(plan).unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();
    // The passage is saved and shown while 设定集整理 is still being asked.
    assert_eq!(f.engine.snapshot("tidy", 0).unwrap().status, "committed");
    assert_eq!(f.engine.snapshot("tidy~maintain", 0).unwrap().status, "running");
    let node = f.text("SELECT node_id FROM lines WHERE id='line'");
    release.notify_one();
    assert_eq!(f.settled("tidy~maintain").await.status, "committed");
    let head = f.text("SELECT node_id FROM lines WHERE id='line'");
    assert_ne!(head, node, "the 设定集 edit follows the passage");
    assert_eq!(f.text(&format!("SELECT action_text FROM nodes WHERE id='{head}'")), "AI 整理了设定集");
    assert_eq!(f.scalar(&format!("SELECT json_extract(meta_json,'$.upkeep') FROM nodes WHERE id='{head}'")), 1);
    // The next passage starts from there.
    let mut next = f.plan("next");
    next.head_id = head.clone();
    next.base_id = Some(head);
    f.engine.start(next).unwrap();
    assert_eq!(f.settled("next").await.status, "committed");
}

#[tokio::test]
async fn an_edit_during_tidying_keeps_the_old_text_out_of_the_settings_and_marks_the_chapter() {
    // D183: the player edits the passage while 设定集整理 and 章节摘要 are still being asked.
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let upkeep = prose(r#"{"cards":[{"kind":"物品","name":"铜鹰符","keys":[],"content":"改前的说法"}],"places":[]}"#);
    let chapter = prose(r#"{"title":"买纸","gist":"买了纸","summary":"你付了两文买纸。"}"#);
    let f = Fixture::new(vec![Step::Reply(written()), Step::Wait { started: started.clone(), release: release.clone(), reply: upkeep }, Step::Reply(chapter)]);
    let mut plan = f.plan("edited");
    plan.meta = json!({"upkeepVersion":"upkeep-test","upkeepMessages":[{"role":"user","content":"{{NARRATIVE}}"}],
        "chapterFirstId":"{{NODE_ID}}","chapterVersion":"chapter-test","chapterMessages":[{"role":"system","content":"章节"},{"role":"user","content":"【本章剧情】\n{{NARRATIVE}}"}]});
    f.engine.start(plan).unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();
    let node = f.text("SELECT node_id FROM lines WHERE id='line'");
    f.store.lock().unwrap().execute("UPDATE nodes SET narrative='玩家改过的正文', rewritten=1 WHERE id=?", [&node]).unwrap();
    release.notify_one();
    assert_eq!(f.settled("edited~maintain").await.status, "committed");
    // No 设定集 edit from the old text, and the passage still waits for one.
    assert_eq!(f.text("SELECT node_id FROM lines WHERE id='line'"), node);
    assert_eq!(f.scalar(&format!("SELECT COUNT(*) FROM nodes WHERE json_extract(meta_json,'$.upkeep') IS NOT NULL AND id='{node}'")), 0);
    // The chapter of the old text is kept, marked as waiting to be summarized again.
    assert_eq!(f.scalar("SELECT COUNT(*) FROM chapters WHERE stale=1"), 1);
}

#[tokio::test]
async fn an_older_edit_before_or_during_tidying_invalidates_the_whole_covered_span() {
    for before_saving in [true, false] {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let upkeep = prose(r#"{"cards":[{"kind":"物品","name":"铜鹰符","keys":[],"content":"改前的说法"}],"places":[]}"#);
        let chapter = prose(r#"{"title":"买纸","gist":"买了纸","summary":"主角付了两文买纸。"}"#);
        let wait = |reply| Step::Wait { started: started.clone(), release: release.clone(), reply };
        let steps = if before_saving { vec![wait(written()), Step::Reply(upkeep), Step::Reply(chapter)] }
            else { vec![Step::Reply(written()), wait(upkeep), Step::Reply(chapter)] };
        let f = Fixture::new(steps);
        f.store.lock().unwrap().execute("UPDATE nodes SET kind='turn',narrative='旧稿 📖' WHERE id='n0'", []).unwrap();
        let hash = "n0\x1f旧稿 📖\x1e".chars().fold(0xcbf29ce484222325u64, |acc, ch| (acc ^ ch as u64).wrapping_mul(0x100000001b3));
        let guard = json!({"ids":["n0"],"hash":format!("{hash:x}")});
        let mut plan = f.plan("older-edit");
        plan.meta = json!({"upkeepMessages":[{"role":"user","content":"旧稿 📖\n{{NARRATIVE}}"}], "upkeepTextGuard":guard,
            "chapterFirstId":"n0","chapterVersion":"chapter-2-free","chapterTextGuard":guard,
            "chapterMessages":[{"role":"user","content":"【本章剧情】\n旧稿 📖\n{{NARRATIVE}}"}]});
        f.engine.start(plan).unwrap();
        tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();
        f.store.lock().unwrap().execute("UPDATE nodes SET narrative='玩家改过的前文', rewritten=1 WHERE id='n0'", []).unwrap();
        release.notify_one();
        assert_eq!(f.settled("older-edit").await.status, "committed");
        assert_eq!(f.settled("older-edit~maintain").await.status, "committed");
        assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes WHERE kind='edit' OR json_extract(meta_json,'$.upkeep')=1"), 0);
        assert_eq!(f.scalar("SELECT stale FROM chapters WHERE first_node_id='n0'"), 1);
        assert_eq!(f.text("SELECT prompt_version FROM chapters WHERE first_node_id='n0'"), "chapter-2-free");
    }
}

#[tokio::test]
async fn a_route_that_shares_its_first_turn_with_another_still_gets_its_own_chapter() {
    let chapter = prose(r#"{"title":"新路","gist":"走了新路","summary":"你走了另一条路。"}"#);
    let f = Fixture::new(vec![Step::Reply(written()), Step::Reply(chapter)]);
    // Another route's chapter starts at n0 too, but ends on a passage not on this route.
    {
        let db = f.store.lock().unwrap();
        db.execute("INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,created_at) VALUES('other','world','n0',9,'turn','别的路线','test')", []).unwrap();
        db.execute("INSERT INTO chapters(id,world_id,first_node_id,last_node_id,title,gist,summary,created_at) VALUES('c-other','world','n0','other','旧路','旧','旧路线的章','test')", []).unwrap();
    }
    let mut plan = f.plan("own-chapter");
    plan.meta = json!({"chapterFirstId":"n0","chapterVersion":"chapter-test","chapterMessages":[{"role":"system","content":"章节"},{"role":"user","content":"【本章剧情】\n{{NARRATIVE}}"}]});
    f.engine.start(plan).unwrap();
    assert_eq!(f.settled("own-chapter").await.status, "committed");
    assert_eq!(f.settled("own-chapter~maintain").await.status, "committed");
    assert_eq!(f.scalar("SELECT COUNT(*) FROM chapters WHERE first_node_id='n0'"), 2);
}

#[tokio::test]
async fn a_stale_chapter_is_summarized_again_unless_the_player_wrote_it_or_its_text_changed_again() {
    let fresh = prose(r#"{"title":"新摘要","gist":"按改后正文","summary":"按改后的正文重写的摘要。"}"#);
    let f = Fixture::new(vec![Step::Reply(written()), Step::Reply(fresh.clone()), Step::Reply(fresh)]);
    {
        let db = f.store.lock().unwrap();
        db.execute("INSERT INTO chapters(id,world_id,first_node_id,last_node_id,title,gist,summary,created_at,stale) VALUES('c1','world','n0','n0','旧','旧梗概','改前的摘要','test',1)", []).unwrap();
        db.execute("INSERT INTO chapters(id,world_id,first_node_id,last_node_id,title,gist,summary,created_at,stale,edited) VALUES('c2','world','n0','n0','玩家写','玩家的梗概','玩家的摘要','test',1,1)", []).unwrap();
    }
    let refresh = |id: &str| json!({"id":id,"firstNodeId":"n0","lastNodeId":"n0","messages":[{"role":"system","content":"章节"},{"role":"user","content":"【本章剧情】\n原有正文"}]});
    let mut plan = f.plan("refresh");
    plan.meta = json!({"chapterRefresh":[refresh("c1"), refresh("c2")]});
    f.engine.start(plan).unwrap();
    assert_eq!(f.settled("refresh").await.status, "committed");
    assert_eq!(f.settled("refresh~maintain").await.status, "committed");
    assert_eq!(f.text("SELECT summary FROM chapters WHERE id='c1'"), "按改后的正文重写的摘要。");
    assert_eq!(f.scalar("SELECT COALESCE(stale,0) FROM chapters WHERE id='c1'"), 0);
    // The player's own summary is not replaced; it stays flagged for them.
    assert_eq!(f.text("SELECT summary FROM chapters WHERE id='c2'"), "玩家的摘要");
    assert_eq!(f.scalar("SELECT stale FROM chapters WHERE id='c2'"), 1);
    // The saved passage keeps no copy of what was refreshed.
    let node = f.text("SELECT node_id FROM lines WHERE id='line'");
    assert_eq!(f.scalar(&format!("SELECT json_extract(meta_json,'$.chapterRefresh') IS NULL FROM nodes WHERE id='{node}'")), 1);
}

#[tokio::test]
async fn old_run_records_are_trimmed_but_runs_in_progress_and_recent_ones_stay() {
    let f = Fixture::new(vec![Step::Reply(written())]);
    f.engine.start(f.plan("recent")).unwrap();
    assert_eq!(f.settled("recent").await.status, "committed");
    let db = f.store.lock().unwrap();
    let old = "2026-01-01T00:00:00+00:00";
    for (id, world, status) in [("old-saved", "world", "committed"), ("old-failed", "world", "failed"), ("old-running", "world", "running"), ("gone-world", "deleted", "committed")] {
        db.execute("INSERT INTO execution_runs(id,world_id,line_id,base_head_id,status,plan_json,budget_json,draft_json,created_at,updated_at) VALUES(?,?,'line','n0',?,'{}','{}','{\"text\":\"很长的草稿\"}',?,?)", rusqlite::params![id, world, status, old, old]).unwrap();
        db.execute("INSERT INTO execution_events(run_id,seq,event_json) VALUES(?,1,'{}')", [id]).unwrap();
    }
    drop(db);
    let mut opening = f.plan("unfinished-opening");
    opening.new_world = Some(json!({}));
    opening.world_id = "world-not-committed-yet".into();
    f.store.register(&opening).unwrap();
    f.store.prune(chrono::Utc::now()).unwrap();
    assert_eq!(f.store.snapshot("unfinished-opening", 0).unwrap().status, "running");
    let count = |sql: &str| f.scalar(sql);
    assert_eq!(count("SELECT COUNT(*) FROM execution_runs WHERE id IN ('old-failed','gone-world')"), 0);
    assert_eq!(count("SELECT COUNT(*) FROM execution_runs WHERE id='old-saved' AND draft_json='{}'"), 1);
    assert_eq!(count("SELECT COUNT(*) FROM execution_events WHERE run_id IN ('old-saved','old-failed','gone-world')"), 0);
    assert_eq!(count("SELECT COUNT(*) FROM execution_events WHERE run_id='old-running'"), 1);
    assert!(count("SELECT COUNT(*) FROM execution_events WHERE run_id='recent'") > 0);
}

#[tokio::test]
async fn retry_of_sequence_invalidates_only_the_failed_child_stage() {
    let f = Fixture::new(vec![
        Step::Reply(written()),
        Step::Reply(prose("你买好纸，经过城门。")),
        Step::Reply(prose("无有效记录")),
        Step::Reply(prose(&record().to_string())),
    ]);
    let mut plan = f.plan("sequence-retry");
    plan.kind = "autoplay".into();
    plan.meta = json!({"autoplayCount":2, "autoplayPauseMs":0});
    plan.settings["pilot"] = "ai".into();
    f.store.lock().unwrap().execute("UPDATE worlds SET settings_json=?", [plan.settings.to_string()]).unwrap();
    f.engine.start(plan).unwrap();
    let failed = f.settled("sequence-retry").await;
    assert_eq!(failed.status, "failed", "{:?}", failed.error);
    assert_eq!(failed.failure.as_ref().unwrap()["stage"], "record");
    assert_eq!(failed.draft["steps"], 1);
    f.engine.resume("sequence-retry").unwrap();
    let complete = f.settled("sequence-retry").await;
    assert_eq!(complete.status, "committed", "{:?}", complete.error);
    assert_eq!(f.model.count(), 4);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes WHERE kind='turn'"), 2);
}

#[tokio::test]
async fn sequence_resume_after_a_past_edit_rebuilds_only_the_unsaved_passage() {
    let f = Fixture::new(vec![
        Step::Reply(written()), Step::Reply(prose("旧草稿：经过城门。")),
        Step::Reply(prose("无有效记录")), Step::Reply(written())
    ]);
    let mut plan = f.plan("edited-sequence");
    plan.kind = "autoplay".into();
    plan.meta = json!({"autoplayCount":2,"autoplayPauseMs":0,"autoplayPilot":"temporary-ai","autoplayBudgetVersion":"per-passage-1"});
    f.engine.start(plan).unwrap();
    let failed = f.settled("edited-sequence").await;
    assert_eq!(failed.status, "failed", "{:?}", failed.error);
    assert_eq!(failed.draft["steps"], 1);
    let saved = f.text("SELECT node_id FROM lines WHERE id='line'");
    f.store.lock().unwrap().execute("UPDATE nodes SET narrative='玩家改为在桥边喝茶。',rewritten=1 WHERE id=?", [&saved]).unwrap();
    f.engine.resume("edited-sequence").unwrap();
    let done = f.settled("edited-sequence").await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(f.model.count(), 4);
    let requests = f.model.requests.lock().unwrap();
    assert!(requests[3].to_string().contains("玩家改为在桥边喝茶") && !requests[3].to_string().contains("旧草稿"));
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes WHERE kind='turn'"), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 4);
    assert_eq!(done.budget.model_requests, 4);
}

#[tokio::test]
async fn inline_upkeep_leaves_the_same_cadence_marker_as_deferred_upkeep() {
    let upkeep = prose(r#"{"cards":[{"kind":"物品","name":"铜鹰符","keys":[],"content":"调兵信物"}],"places":[]}"#);
    let f = Fixture::new(vec![Step::Reply(written()), Step::Reply(upkeep)]);
    let mut plan = f.plan("inline-upkeep");
    plan.kind = "autoplay".into();
    plan.settings["autoUpkeep"] = true.into();
    plan.meta = json!({"autoplayCount":1,"autoplayPilot":"temporary-ai","upkeepEvery":1,"autoplayUpkeepSystem":"整理设定"});
    f.engine.start(plan).unwrap();
    let done = f.settled("inline-upkeep").await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes WHERE kind='edit' AND json_extract(meta_json,'$.by')='AI' AND json_extract(meta_json,'$.upkeep')=1"), 1);
}

#[tokio::test]
async fn deferred_upkeep_does_not_move_the_next_writers_base() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let upkeep = prose(r#"{"cards":[{"kind":"物品","name":"铜鹰符","keys":["鹰符"],"content":"调兵信物"}],"places":[]}"#);
    let f = Fixture::new(vec![Step::Reply(written()), Step::Wait { started:started.clone(), release:release.clone(), reply:upkeep }]);
    let mut plan = f.plan("tidy-busy");
    plan.meta = json!({"upkeepMessages":[{"role":"user","content":"{{NARRATIVE}}"}]});
    f.engine.start(plan).unwrap();
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await.unwrap();
    let head = f.text("SELECT node_id FROM lines WHERE id='line'");
    let mut next = f.plan("new-writer");
    next.head_id = head.clone();
    next.base_id = Some(head.clone());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match f.store.register(&next) {
                Ok(()) => break,
                Err(Error::Busy { .. }) => tokio::time::sleep(Duration::from_millis(5)).await,
                Err(error) => panic!("could not start the next passage: {error:?}"),
            }
        }
    }).await.unwrap();
    release.notify_one();
    assert_eq!(f.settled("tidy-busy~maintain").await.status, "committed");
    assert_eq!(f.text("SELECT node_id FROM lines WHERE id='line'"), head);
}

#[tokio::test]
async fn an_expired_backup_capability_is_rechecked_and_does_not_change_the_main_models_cache() {
    let fail = || Step::Fail(provider("network", None, false));
    let unsupported = Error::Provider { kind:"http".into(), status:Some(400), message:"does not support tools".into(), partial:false };
    let f = Fixture::new(vec![fail(), fail(), Step::Fail(unsupported), Step::Reply(written())]);
    let mut plan = f.plan("fallback-capability");
    plan.meta["depth"] = "standard".into();
    let b = backup();
    let key = format!("toolCapability:{}:{}:{}", b.slot, b.url, b.model);
    let at = chrono::Utc::now().timestamp_millis() - 86_400_001;
    f.store.lock().unwrap().execute("INSERT INTO settings(key,value) VALUES(?,?)", rusqlite::params![key, json!({"at":at,"supported":false}).to_string()]).unwrap();
    plan.fallback_model = Some(b.clone());
    f.engine.start(plan).unwrap();
    let done = f.settled("fallback-capability").await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(*f.model.services.lock().unwrap(), ["fake", "fake", b.model.as_str(), b.model.as_str()]);
    let requests = f.model.requests.lock().unwrap();
    assert!(!tool_names(&requests[2]).is_empty() && tool_names(&requests[3]).is_empty());
    assert_eq!(f.scalar("SELECT COUNT(*) FROM settings WHERE key LIKE 'toolCapability:%'"), 1);
    let cached: String = f.store.lock().unwrap().query_row("SELECT value FROM settings WHERE key=?", [key], |row| row.get(0)).unwrap();
    let capability: Value = serde_json::from_str(&cached).unwrap();
    assert_eq!(capability["supported"], false);
    assert!(capability["at"].as_i64().unwrap() > at);
}

#[tokio::test]
async fn an_older_run_probes_the_backup_without_remembering_its_answer_for_the_main_model() {
    let fail = || Step::Fail(provider("network", None, false));
    let f = Fixture::new(vec![fail(), fail(), Step::Reply(prose("我只能用文字回答。")),
        Step::Fail(provider("auth", Some(401), false)), Step::Reply(written())]);
    let mut plan = bound(&f, "old-capability", "standard");
    plan.meta = json!({});
    let b = backup();
    plan.fallback_model = Some(b.clone());
    f.engine.start(plan).unwrap();
    assert_eq!(f.settled("old-capability").await.status, "failed");
    f.engine.resume("old-capability").unwrap();
    let done = f.settled("old-capability").await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(*f.model.services.lock().unwrap(), ["fake", "fake", b.model.as_str(), b.model.as_str(), "fake"]);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM settings WHERE key LIKE 'toolCapability:%'"), 1);
    assert!(f.text("SELECT key FROM settings WHERE key LIKE 'toolCapability:%'").ends_with(&format!(":{}", b.model)));
}

#[tokio::test]
async fn a_request_with_tools_does_not_fall_back_to_a_backup_known_without_tools() {
    let fail = || Step::Fail(provider("http", Some(503), false));
    let (f, mut plan) = correction_fixture(vec![fail(), fail(), Step::Reply(written())], "backup-no-tools", &[up_front()], "核对纸价");
    plan.fallback_model = Some(backup());
    let b = backup();
    f.store.lock().unwrap().execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", rusqlite::params![format!("toolCapability:{}:{}:{}", b.slot, b.url, b.model), json!({"at":chrono::Utc::now().timestamp_millis(),"supported":false}).to_string()]).unwrap();
    f.engine.start(plan).unwrap();
    let saved = f.settled("backup-no-tools").await;
    assert_eq!(saved.status, "failed", "{:?}", saved.error);
    assert!(f.model.services.lock().unwrap().iter().all(|s| s == "fake"), "{:?}", f.model.services.lock().unwrap());
}

#[tokio::test]
async fn an_unreadable_time_or_missing_suggestions_do_not_fail_a_written_passage() {
    let f = Fixture::new(vec![
        Step::Reply(prose(r#"天亮了，你推门出去。<record>{"time":"次日清晨","log":"出门"}</record>"#)),
        Step::Reply(prose(r#"{"time":"次日清晨"}"#)),
    ]);
    let mut plan = f.plan("unreadable-time");
    plan.settings["choiceCount"] = 2.into();
    f.engine.start(plan).unwrap();
    let saved = f.settled("unreadable-time").await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    assert_eq!(f.text("SELECT narrative FROM nodes WHERE kind='turn'"), "天亮了，你推门出去。");
    let meta: Value = serde_json::from_str(&f.text("SELECT meta_json FROM nodes WHERE kind='turn'")).unwrap();
    assert!(meta["log"].to_string().contains("无法识别"), "{meta}");
}

#[tokio::test]
async fn model_switch_reuse_keeps_completed_writing_and_retries_extract_on_new_model() {
    let f = Fixture::new(vec![
        Step::Reply(prose("暮色渐沉，你在城门口拦下马车。")),
        Step::Fail(provider("http", Some(500), false)),
        Step::Fail(provider("http", Some(500), false)),
        Step::Reply(prose(&record().to_string())),
    ]);
    f.engine.start(f.plan("switch-model")).unwrap();
    let failed = f.settled("switch-model").await;
    assert_eq!(failed.status, "failed");
    assert_eq!(f.model.count(), 3, "1 writing + 2 failed extract attempts");
    // Simulate retryRun switching model & auxModel after prose succeeded and extract failed.
    let mut plan = f.store.plan("switch-model").unwrap();
    plan.model.model = "new-main-model".into();
    plan.model.aux_model = Some("new-aux-model".into());
    plan.meta["allowModelSwitchReuse"] = true.into();
    f.store.lock().unwrap().execute(
        "UPDATE execution_runs SET plan_json=? WHERE id='switch-model'",
        rusqlite::params![serde_json::to_string(&plan).unwrap()],
    ).unwrap();
    f.engine.resume("switch-model").unwrap();
    let done = f.settled("switch-model").await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(f.model.count(), 4, "completed writing must be reused instead of re-burned after model switch");
    assert_eq!(f.text("SELECT narrative FROM nodes WHERE kind='turn'"), "暮色渐沉，你在城门口拦下马车。");
}
