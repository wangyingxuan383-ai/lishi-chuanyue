//! Three local-only checks for the native spectator owner. No WebView, network
//! or user database is involved.
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use story_core::{
    chat::{BoxFuture, Completion, Model, TextSink},
    runtime::Engine,
    ModelConfig, Result, RunPlan, RunSnapshot, Store,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct ModelFixture {
    requests: Mutex<Vec<Value>>,
    challenge: bool,
    omit_record: std::sync::atomic::AtomicBool,
}
impl Model for ModelFixture {
    fn complete(
        &self,
        _: ModelConfig,
        body: Value,
        _: CancellationToken,
        text: TextSink,
    ) -> BoxFuture<Result<Completion>> {
        let extracting=body.to_string().contains("提取本回合记录");
        let naming=body.to_string().contains("storyTitle");
        self.requests.lock().unwrap().push(body);
        let number = self.requests.lock().unwrap().len();
        let challenge = self.challenge;
        let omit=self.omit_record.load(Ordering::SeqCst);
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            let mut record = if challenge {
                json!({"time":5,"money":-1,"challenge":{"result":"won","progress":"达成目标","why":"任务完成"}})
            } else {
                json!({"time":5,"money":-1})
            };
            if naming{record["storyTitle"]="行旅札记".into();}
            let prose=if extracting{record.to_string()}else if omit&&number==1{"第1段，主角付出一文。".into()}else{format!("第{number}段，主角付出一文。<record>{record}</record>")};
            text(prose.clone());
            Ok(Completion {
                text: prose,
                usage: Some(json!({"prompt_tokens":4,"completion_tokens":6})),
                ..Default::default()
            })
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
    engine: Arc<Engine>,
    model: Arc<ModelFixture>,
    leases: Arc<AtomicUsize>,
}
impl Fixture {
    fn new(challenge: bool) -> Self {
        let mut db = Connection::open_in_memory().unwrap();
        story_core::migration::migrate(&mut db, None).unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        store.initialize().unwrap();
        let mut state = json!({"version":2,"executionMode":"classic","time":{"start":"初日","elapsedMinutes":0,"startHour":8},"placeId":null,"protagonist":{"name":"李安","aliases":[],"age":20,"gender":"男","identity":"行旅","origin":"现代","cheat":"","stats":{"money":20,"debt":0,"health":100,"energy":100,"fame":0},"statuses":[],"items":[]},"people":[],"places":[],"cards":[],"goals":[],"era":{"mode":"free","clockStyle":"elapsed","packId":null},"deviations":[]});
        if challenge {
            state["challenge"] = json!({"goal":"办成任务","limit":"","deadlineMinute":null,"failIf":"","progress":"","status":"active","startedMinute":0});
        }
        {
            let db = store.lock().unwrap();
            db.execute_batch("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES ('w','隔离故事','','l','{\"pilot\":\"ai\",\"choiceCount\":0,\"difficulty\":\"标准\"}','now','now','now'); INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES ('h','w',0,'opening','开场','now'); INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES ('l','w','主线','h','now');").unwrap();
            db.execute("INSERT INTO states VALUES ('h',?)", [state.to_string()])
                .unwrap();
        }
        let model = Arc::new(ModelFixture {
            challenge,
            ..Default::default()
        });
        let leases = Arc::new(AtomicUsize::new(0));
        let active = leases.clone();
        let engine = Arc::new(Engine::new(
            store,
            model.clone(),
            Arc::new(move |_| {
                active.fetch_add(1, Ordering::SeqCst);
                Box::new(Lease(active.clone()))
            }),
            Arc::new(|_| {}),
        ));
        Self {
            engine,
            model,
            leases,
        }
    }
    fn plan(&self, count: u64) -> RunPlan {
        let db = self.engine.store.lock().unwrap();
        let state: String = db
            .query_row("SELECT state_json FROM states WHERE node_id='h'", [], |r| {
                r.get(0)
            })
            .unwrap();
        RunPlan {
            id: "auto".into(),
            world_id: "w".into(),
            line_id: "l".into(),
            head_id: "h".into(),
            base_id: Some("h".into()),
            kind: "autoplay".into(),
            model: ModelConfig {
                slot: "fixture".into(),
                url: "https://never.invalid".into(),
                model: "mock".into(),
                aux_model: None,
                include_usage: false,
                max_tokens: None,
                extra: Default::default(),
            },
            messages: vec![json!({"role":"system","content":"沿用原叙事规则"})],
            extract_messages: vec![json!({"role":"system","content":"提取本回合记录"})],
            state: serde_json::from_str(&state).unwrap(),
            settings: json!({"pilot":"ai","choiceCount":0,"difficulty":"标准"}),
            options: json!({"mode":"continue","difficulty":"标准","currency":{"units":[{"name":"文","value":1}]},"clock":{"mode":"free","clockStyle":"elapsed","date":null,"hour":8,"rules":{},"label":""}}),
            action: json!({"mode":"continue","text":""}),
            meta: json!({"autoplayCount":count,"autoplayPauseMs":0,"budgetChars":24000}),
            reference: None,
            original: String::new(),
            carried_edits: vec![],
            trailing_ids: vec![],
            new_world: None,
        }
    }
    async fn settled(&self) -> RunSnapshot {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let s = self.engine.snapshot("auto", 0).unwrap();
                if s.status != "running" && self.leases.load(Ordering::SeqCst) == 0 {
                    return s;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }
    fn scalar(&self, sql: &str) -> i64 {
        self.engine
            .store
            .lock()
            .unwrap()
            .query_row(sql, [], |r| r.get(0))
            .unwrap()
    }
}

#[tokio::test]
async fn native_sequence_finishes_without_reader_and_uses_new_state() {
    let f = Fixture::new(false);
    f.engine.start(f.plan(2)).unwrap();
    let saved = f.settled().await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    assert_eq!(saved.result.as_ref().unwrap()["steps"], 2);
    assert_eq!(saved.result.as_ref().unwrap()["reason"], "count");
    assert_eq!(saved.budget.model_requests, 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
    let requests = f.model.requests.lock().unwrap();
    let second = requests[1].to_string();
    assert!(second.contains("第1段"));
    assert!(second.contains("共 19"), "the next passage must receive the settled purse in the compact current-state projection");
    assert_eq!(
        saved
            .events
            .iter()
            .filter(|e| e.event["type"] == "step")
            .count(),
        2
    );
    assert_eq!(
        saved
            .events
            .iter()
            .filter(|e| e.event["type"] == "done")
            .count(),
        2
    );
    let parent = f.engine.store.plan("auto").unwrap();
    assert_ne!(parent.head_id, "h");
    drop(requests);
    // The settings are read again between passages, without a WebView callback.
    let changed = Fixture::new(false);
    let mut plan = changed.plan(3);
    plan.meta["autoplayPauseMs"] = 100.into();
    changed.engine.start(plan).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if changed.scalar("SELECT COUNT(*) FROM nodes") == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    changed.engine.store.lock().unwrap().execute("UPDATE worlds SET settings_json=json_set(settings_json,'$.pilot','player') WHERE id='w'", []).unwrap();
    let stopped = changed.settled().await;
    assert_eq!(stopped.status, "committed", "{:?}", stopped.error);
    assert_eq!(stopped.result.as_ref().unwrap()["reason"], "player");
    assert_eq!(stopped.result.as_ref().unwrap()["steps"], 1);
}

#[tokio::test]
async fn whole_sequence_budget_pauses_and_resume_never_bypasses_it() {
    let f = Fixture::new(false);
    f.engine.start(f.plan(12)).unwrap();
    let saved = f.settled().await;
    assert_eq!(saved.status, "paused", "{:?}", saved.error);
    assert_eq!(saved.draft["steps"], 10);
    assert_eq!(saved.budget.model_requests, 10);
    assert_eq!(f.model.requests.lock().unwrap().len(), 10);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 10);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 11);
    f.engine.resume("auto").unwrap();
    let again = f.settled().await;
    assert_eq!(again.status, "paused");
    assert_eq!(again.draft["steps"], 10);
    assert_eq!(f.model.requests.lock().unwrap().len(), 10);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 10);
}

#[tokio::test]
async fn challenge_result_stops_remaining_native_steps() {
    let f = Fixture::new(true);
    f.engine.start(f.plan(3)).unwrap();
    let saved = f.settled().await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    assert_eq!(saved.result.as_ref().unwrap()["steps"], 1);
    assert_eq!(saved.result.as_ref().unwrap()["reason"], "challenge");
    assert_eq!(f.model.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn one_passage_ignores_legacy_world_agent_flag(){
    let f=Fixture::new(false);
    f.engine.store.lock().unwrap().execute("UPDATE states SET state_json=json_set(state_json,'$.executionMode','agent') WHERE node_id='h'",[]).unwrap();
    f.engine.start(f.plan(1)).unwrap();
    let saved=f.settled().await;
    assert_eq!(saved.status,"committed","{:?}",saved.error);
    assert_eq!(saved.result.as_ref().unwrap()["steps"],1);
    assert_eq!(saved.budget.model_requests,1);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"),2);
}

#[tokio::test]
async fn new_sequence_keeps_cumulative_usage_beyond_one_passage_limit(){
    let f=Fixture::new(false);let mut plan=f.plan(12);plan.meta["autoplayBudgetVersion"]="per-passage-1".into();
    f.engine.start(plan).unwrap();let saved=f.settled().await;
    assert_eq!(saved.status,"committed","{:?}",saved.error);assert_eq!(saved.result.as_ref().unwrap()["steps"],12);
    assert_eq!(saved.budget.model_requests,12);assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"),12);assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"),13);
}

#[tokio::test]
async fn temporary_ai_sequence_keeps_player_settings_and_bounded_extraction() {
    let f=Fixture::new(false);
    f.model.omit_record.store(true,Ordering::SeqCst);
    let mut plan=f.plan(2);
    plan.meta["autoplayPilot"]="temporary-ai".into();plan.meta["autoplayBudgetVersion"]="per-passage-1".into();plan.meta["budgetChars"]=14545.into();
    plan.settings["pilot"]="player".into();
    f.engine.store.lock().unwrap().execute("UPDATE worlds SET settings_json=? WHERE id='w'",[plan.settings.to_string()]).unwrap();
    plan.state["facts"]=json!((0..300).map(|i|json!({"id":i,"origin":"player","detail":"旧事".repeat(100)})).collect::<Vec<_>>());
    f.engine.store.lock().unwrap().execute("UPDATE states SET state_json=? WHERE node_id='h'",[plan.state.to_string()]).unwrap();
    f.engine.start(plan).unwrap();let saved=f.settled().await;
    assert_eq!(saved.status,"committed","{:?}",saved.error);assert_eq!(saved.result.unwrap()["steps"],2);
    let settings:String=f.engine.store.lock().unwrap().query_row("SELECT settings_json FROM worlds WHERE id='w'",[],|r|r.get(0)).unwrap();assert_eq!(serde_json::from_str::<Value>(&settings).unwrap()["pilot"],"player");
    let requests=f.model.requests.lock().unwrap();assert_eq!(requests.len(),3);
    assert!(requests.iter().all(|r|r.to_string().encode_utf16().count()<=14545));
    assert!(!requests[1].to_string().contains("旧事旧事"));
}
#[tokio::test]
async fn opening_name_is_metadata_and_manual_name_wins() {
 for manual in [false,true]{
    let f=Fixture::new(false);let mut p=f.plan(1);p.id="new-opening".into();p.world_id="new-world".into();p.line_id="new-line".into();p.head_id=String::new();p.base_id=None;p.kind="opening".into();p.messages=vec![json!({"role":"system","content":"开场请额外返回storyTitle"})];p.new_world=Some(json!({"title":"手写书名","eraId":"free"}));p.meta["titlePolicy"]=if manual{"manual"}else{"auto"}.into();
    f.engine.start(p).unwrap();
    let saved=tokio::time::timeout(Duration::from_secs(5),async{loop{let s=f.engine.snapshot("new-opening",0).unwrap();if s.status!="running"{break s;}tokio::time::sleep(Duration::from_millis(5)).await;}}).await.unwrap();assert_eq!(saved.status,"committed","{:?}",saved.error);
    let db=f.engine.store.lock().unwrap();let title:String=db.query_row("SELECT title FROM worlds WHERE id='new-world'",[],|r|r.get(0)).unwrap();assert_eq!(title,if manual{"手写书名"}else{"行旅札记"});
    let raw:String=db.query_row("SELECT record_json FROM nodes WHERE world_id='new-world' LIMIT 1",[],|r|r.get(0)).unwrap();assert!(!raw.contains("storyTitle"));
 }
}
