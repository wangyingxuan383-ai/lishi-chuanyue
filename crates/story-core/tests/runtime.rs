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
    Error, ExecutionMode, ModelConfig, Result, RunPlan, RunSnapshot, Store,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

enum Step {
    Reply(Completion),
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

    fn plan(&self, id: &str, mode: ExecutionMode) -> RunPlan {
        RunPlan {
            id: id.into(),
            world_id: "world".into(),
            line_id: "line".into(),
            head_id: "n0".into(),
            base_id: Some("n0".into()),
            kind: "turn".into(),
            execution_mode: mode,
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
fn calls(calls: Vec<(&str, &str, Value)>) -> Completion {
    Completion { tool_calls: calls.into_iter().map(|(id,name,args)| json!({"id":id,"type":"function","function":{"name":name,"arguments":args.to_string()}})).collect(), finish_reason: Some("tool_calls".into()), usage: Some(json!({"prompt_tokens":10,"completion_tokens":6})), ..Default::default() }
}
fn capability() -> Step {
    Step::Reply(calls(vec![(
        "probe",
        "report_capability",
        json!({"value":"ready"}),
    )]))
}

#[tokio::test]
async fn classic_commits_without_a_subscriber_and_events_can_be_replayed_once() {
    let fixture = Fixture::new(vec![Step::Reply(written())]);
    fixture
        .engine
        .start(fixture.plan("classic", ExecutionMode::Classic))
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
    assert_eq!(state["executionMode"], "classic");
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
async fn agent_discovers_tools_reads_a_skill_receives_results_and_commits_staged_turn() {
    let fixture = Fixture::new(vec![
        capability(),
        Step::Reply(calls(vec![
            ("skill", "read_skill", json!({"name":"story-writing"})),
            ("world", "read_world", json!({})),
        ])),
        Step::Reply(calls(vec![(
            "commit",
            "commit_turn",
            json!({"narrative":"你付了两文，收好一张纸。","record":record()}),
        )])),
    ]);
    fixture
        .engine
        .start(fixture.plan("agent", ExecutionMode::Agent))
        .unwrap();
    let snapshot = fixture.settled("agent").await;
    assert_eq!(snapshot.status, "committed", "{:?}", snapshot.error);
    assert_eq!(snapshot.budget.model_requests, 3);
    assert_eq!(snapshot.budget.tool_calls, 3);
    assert_eq!(
        fixture.scalar(
            "SELECT COUNT(*) FROM execution_steps WHERE kind='read_skill' AND status='done'"
        ),
        1
    );
    let requests = fixture.model.requests.lock().unwrap();
    assert!(requests[1]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["function"]["name"] == "commit_turn"));
    let messages = requests[2]["messages"].as_array().unwrap();
    let skill = messages
        .iter()
        .find(|message| message["tool_call_id"] == "skill")
        .unwrap();
    assert_eq!(skill["role"], "tool");
    assert!(skill["content"].as_str().unwrap().contains("story-writing"));
    let world: Value = serde_json::from_str(
        messages
            .iter()
            .find(|message| message["tool_call_id"] == "world")
            .unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(world["state"]["protagonist"]["name"], "李安");
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 2);
}

#[tokio::test]
async fn fetching_original_and_committing_in_one_batch_requires_a_reading_roundtrip() {
    let commit = json!({"narrative":"你付了两文，收好一张纸。","record":record()});
    let fixture = Fixture::new(vec![
        capability(),
        Step::Reply(calls(vec![
            ("read", "read_original", json!({"section":0,"chunk":0})),
            ("early", "commit_turn", commit.clone()),
        ])),
        Step::Reply(calls(vec![("after-reading", "commit_turn", commit)])),
    ]);
    fixture.store.lock().unwrap().execute_batch("INSERT INTO source_books VALUES('book','短篇','txt','test','{}'); INSERT INTO source_sections VALUES('book',0,'第一章',NULL); INSERT INTO source_chunks VALUES('book',0,0,'纸铺一张纸售价两文。');").unwrap();
    let mut plan = fixture.plan("reading-roundtrip", ExecutionMode::Agent);
    plan.state["source"] =
        json!({"bookId":"book","position":0,"through":0,"instructions":"核对纸价"});
    fixture.engine.start(plan).unwrap();
    let snapshot = fixture.settled("reading-roundtrip").await;
    assert_eq!(snapshot.status, "committed", "{:?}", snapshot.error);
    let requests = fixture.model.requests.lock().unwrap();
    let messages = requests[2]["messages"].as_array().unwrap();
    let early: Value = serde_json::from_str(
        messages
            .iter()
            .find(|m| m["tool_call_id"] == "early")
            .unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(early["isError"], true);
    assert_eq!(snapshot.draft["originalRead"], true);
    assert_eq!(
        snapshot.draft["originalPassages"][0]["text"],
        "纸铺一张纸售价两文。"
    );
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 2);
}

#[tokio::test]
async fn history_lookup_searches_old_route_text_and_excludes_other_branches() {
    let fixture = Fixture::new(vec![
        capability(),
        Step::Reply(calls(vec![(
            "old",
            "read_history",
            json!({"query":"青铜钥匙","limit":1}),
        )])),
        Step::Reply(calls(vec![(
            "commit",
            "commit_turn",
            json!({"narrative":"你收好纸。","record":record()}),
        )])),
    ]);
    fixture.store.lock().unwrap().execute_batch("UPDATE nodes SET narrative='本路旧事：青铜钥匙藏在灯座下。' WHERE id='n0'; INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('other','world',1,'turn','另一条路线把青铜钥匙送走了。','test'); INSERT INTO chapters(id,world_id,first_node_id,last_node_id,title,gist,summary,created_at) VALUES('chapter','world','n0','n0','旧约','见面','曾约定保管青铜钥匙。','test');").unwrap();
    fixture
        .engine
        .start(fixture.plan("history-search", ExecutionMode::Agent))
        .unwrap();
    assert_eq!(fixture.settled("history-search").await.status, "committed");
    let requests = fixture.model.requests.lock().unwrap();
    let value: Value = serde_json::from_str(
        requests[2]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["tool_call_id"] == "old")
            .unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value["turns"][0]["id"], "n0");
    assert_eq!(value["chapters"][0]["id"], "chapter");
    assert!(!value.to_string().contains("另一条路线"));
}

#[tokio::test]
async fn lower_request_limit_is_visible_to_the_model_and_survives_resume() {
    let fixture = Fixture::new(vec![
        capability(),
        Step::Reply(calls(vec![("world", "read_world", json!({}))])),
    ]);
    let mut plan = fixture.plan("lower-limit", ExecutionMode::Agent);
    plan.meta["modelRequestLimit"] = 2.into();
    fixture.engine.start(plan).unwrap();
    let snapshot = fixture.settled("lower-limit").await;
    assert_eq!(snapshot.status, "paused");
    assert_eq!(fixture.model.count(), 2);
    assert!(
        fixture.model.requests.lock().unwrap()[1]["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("尚可请求模型1次")
    );
    fixture.engine.resume("lower-limit").unwrap();
    assert_eq!(fixture.settled("lower-limit").await.status, "paused");
    assert_eq!(fixture.model.count(), 2);
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
        .start(fixture.plan("resume", ExecutionMode::Classic))
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
        .start(fixture.plan("stale", ExecutionMode::Classic))
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
        .start(fixture.plan("rollback", ExecutionMode::Classic))
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
async fn the_twenty_fifth_tool_is_not_executed_and_the_draft_is_retained() {
    let ids: Vec<String> = (0..25).map(|n| format!("read-{n}")).collect();
    let response = calls(
        ids.iter()
            .map(|id| (id.as_str(), "read_world", json!({})))
            .collect(),
    );
    let fixture = Fixture::new(vec![capability(), Step::Reply(response)]);
    fixture
        .engine
        .start(fixture.plan("tool-limit", ExecutionMode::Agent))
        .unwrap();
    let snapshot = fixture.settled("tool-limit").await;
    assert_eq!(snapshot.status, "paused", "{:?}", snapshot.error);
    assert_eq!(snapshot.budget.tool_calls, 24);
    assert_eq!(fixture.model.count(), 2);
    assert_eq!(
        fixture.scalar("SELECT COUNT(*) FROM execution_steps WHERE kind='read_world'"),
        24
    );
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 1);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM execution_steps WHERE kind='writing:0' AND output_json IS NOT NULL"), 1);
}

#[tokio::test]
async fn the_capability_probe_and_every_followup_count_towards_the_ten_request_limit() {
    let mut steps = vec![capability()];
    for round in 0..9 {
        steps.push(Step::Reply(calls(vec![(
            &format!("read-{round}"),
            "read_world",
            json!({}),
        )])));
    }
    let fixture = Fixture::new(steps);
    fixture
        .engine
        .start(fixture.plan("model-limit", ExecutionMode::Agent))
        .unwrap();
    let snapshot = fixture.settled("model-limit").await;
    assert_eq!(snapshot.status, "paused", "{:?}", snapshot.error);
    assert_eq!(snapshot.budget.model_requests, 10);
    assert_eq!(snapshot.budget.tool_calls, 9);
    assert_eq!(fixture.model.count(), 10);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 1);
}

#[tokio::test]
async fn unsupported_tools_do_not_silently_run_agent_as_classic() {
    let fixture = Fixture::new(vec![Step::Reply(prose("这个模型只返回正文。"))]);
    fixture
        .engine
        .start(fixture.plan("unsupported", ExecutionMode::Agent))
        .unwrap();
    let snapshot = fixture.settled("unsupported").await;
    assert_eq!(snapshot.status, "failed");
    assert!(snapshot.error.as_deref().unwrap().contains("工具调用检查"));
    assert_eq!(fixture.model.count(), 1);
    assert_eq!(fixture.scalar("SELECT COUNT(*) FROM nodes"), 1);
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
    let mut plan = fixture.plan("continue-stale", ExecutionMode::Classic);
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
