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
    committed: Arc<Mutex<Vec<String>>>,
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
        let committed = Arc::new(Mutex::new(Vec::new()));
        let sink = committed.clone();
        let engine = Arc::new(Engine::new(
            store,
            model.clone(),
            Arc::new(move |_| {
                active.fetch_add(1, Ordering::SeqCst);
                Box::new(Lease(active.clone()))
            }),
            Arc::new(move |id| sink.lock().unwrap().push(id)),
        ));
        Self {
            engine,
            model,
            leases,
            committed,
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
            fallback_model: None,
        }
    }
    async fn settled(&self) -> RunSnapshot {
        tokio::time::timeout(Duration::from_secs(30), async {
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
    let phases=Arc::new(Mutex::new(Vec::new()));let sink=phases.clone();
    f.engine.observe(Arc::new(move |signal| {
        if let story_core::runtime::RunSignal::Phase{run_id,execution_id,..}=signal {sink.lock().unwrap().push((run_id,execution_id));}
    }));
    f.engine.start(f.plan(2)).unwrap();
    let saved = f.settled().await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    assert_eq!(saved.result.as_ref().unwrap()["steps"], 2);
    assert_eq!(saved.result.as_ref().unwrap()["reason"], "count");
    let committed = f.committed.lock().unwrap().clone();
    assert_eq!(committed, vec![format!("w:{}", saved.result.as_ref().unwrap()["nodeId"].as_str().unwrap())]);
    assert_eq!(saved.budget.model_requests, 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
    let targets=phases.lock().unwrap();assert!(targets.len()>=2);
    assert!(targets.iter().all(|(run,batch)|run=="auto"&&!batch.is_empty()&&batch==&targets[0].1));drop(targets);
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
async fn whole_sequence_budget_pauses_and_continuing_grants_one_more_allowance() {
    // D159: the run pauses at its allowance (30 requests); 接着写完 continues the same
    // run with one more allowance, and the totals already used stay recorded.
    let f = Fixture::new(false);
    f.engine.start(f.plan(34)).unwrap();
    let saved = f.settled().await;
    assert_eq!(saved.status, "paused", "{:?}", saved.error);
    assert!(f.committed.lock().unwrap().is_empty(), "a paused sequence must not ring once per step");
    assert_eq!(saved.draft["steps"], 30);
    assert_eq!(saved.budget.model_requests, 30);
    assert_eq!(f.model.requests.lock().unwrap().len(), 30);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 30);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 31);
    f.engine.resume("auto").unwrap();
    let again = f.settled().await;
    assert_eq!(again.status, "committed", "{:?}", again.error);
    assert_eq!(f.committed.lock().unwrap().len(), 1);
    assert_eq!(again.result.as_ref().unwrap()["steps"], 34);
    assert_eq!(again.budget.model_requests, 34);
    assert_eq!(f.model.requests.lock().unwrap().len(), 34);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM usage"), 34);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 35);
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

#[tokio::test]
async fn carried_notes_queued_director_note_clock_taboos_upkeep_and_final_choices_work_end_to_end() {
    let f = Fixture::new(false);
    {
        let db = f.engine.store.lock().unwrap();
        db.execute(
            "INSERT INTO story_notes(id,world_id,kind,title,scope_json,content,progress_json,origin_world_id,origin_title,active,status,created_at,updated_at)
             VALUES ('carried-1','w','plot','前世因果','{\"toNode\":\"old-node-9\"}','前世留下的玄铁剑线索','{\"routeNode\":\"old-node-9\"}','old-w','前尘录',1,'done','now','now')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO settings(key, value) VALUES ('autoplayNote:auto', '\"让旧友突然来访\"')",
            [],
        )
        .unwrap();
    }
    let mut plan = f.plan(2);
    plan.meta["autoplayPilot"] = "temporary-ai".into();
    plan.meta["autoplayPauseMs"] = 10.into();
    plan.meta["upkeepEvery"] = 2.into();
    plan.meta["autoplayUpkeepSystem"] = "你是资料员".into();
    plan.settings = json!({"pilot":"player","choiceCount":3,"difficulty":"标准","mode":"history","autoUpkeep":true,"fortune":"on","premise":"盛唐长安"});
    plan.state["era"] = json!({"mode":"history","clockStyle":"era","timeStyle":"24h","packId":null,"calendar":{"lunar":true,"yearWord":"载"}});
    plan.state["time"]["anchor"] = json!({"atElapsedMinutes":0,"minuteOfDay":1200,"date":{"era":"天宝","year":7,"month":12,"day":30,"ceYear":748,"lunar":true}});
    plan.state["cards"] = json!([
        {"id":"c-era","kind":"时代","name":"盛唐","content":"不要出现：银两（铜钱）；玉米","source":"卡组"},
        {"id":"c-player","kind":"物品","name":"古玉","content":"家传古玉","source":"玩家"}
    ]);
    {
        let db = f.engine.store.lock().unwrap();
        db.execute("UPDATE worlds SET settings_json=? WHERE id='w'", [plan.settings.to_string()]).unwrap();
        db.execute("UPDATE nodes SET narrative='掌柜递来二两银两。' WHERE id='h'", []).unwrap();
        db.execute("UPDATE states SET state_json=? WHERE node_id='h'", [plan.state.to_string()]).unwrap();
    }
    f.engine.start(plan).unwrap();
    // Wait until step 2 child run is registered (after step 2's take_pending_director_note), then queue a note during the final step!
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if f.scalar("SELECT COUNT(*) FROM execution_runs WHERE id='auto:step:2'") >= 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    f.engine
        .store
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO settings(key, value) VALUES ('autoplayNote:auto', '\"留给连播结束后的提示\"') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [],
        )
        .unwrap();
    let saved = f.settled().await;
    assert_eq!(saved.status, "committed", "{:?}", saved.error);
    let requests = f.model.requests.lock().unwrap().clone();
    let turn_reqs: Vec<String> = requests
        .iter()
        .map(|r| r.to_string())
        .filter(|s| !s.contains("提取本回合记录") && !s.contains("你是资料员"))
        .collect();
    assert_eq!(turn_reqs.len(), 2, "expected 2 turn requests, got {}", turn_reqs.len());
    let req1 = &turn_reqs[0];
    let req2 = &turn_reqs[1];
    // B16: carried sequel note survives into step 2+
    assert!(req1.contains("前世留下的玄铁剑线索"), "{req1}");
    assert!(req2.contains("前世留下的玄铁剑线索"), "carried note must survive step 2: {req2}");
    // B17: queued director note keeps 【继续】 header and <record> reminder; unconsumed final-step note is preserved when queued before finish_autoplay
    assert!(req1.contains("【继续】") && req1.contains("让旧友突然来访") && req1.contains("<record>"), "{req1}");
    if let Some(unused) = saved.result.as_ref().unwrap().get("unusedDirectorNote").and_then(Value::as_str) {
        assert_eq!(unused, "留给连播结束后的提示");
    }
    // B20: calibrated anchor (腊月三十 · 20:00), taboo reminder, and fortune note
    assert!(req1.contains("天宝七载 腊月三十 · 20:00"), "{req1}");
    assert!(req1.contains("【用词提醒】") && req1.contains("银两"), "{req1}");
    assert!(req1.contains("【本回合运势"), "{req1}");
    // B15: final step of temporary-ai requests protagonist action choices, and upkeep uses structured roster
    assert!(req2.contains("建议行动"), "final step of temporary-ai must request player action choices: {req2}");
    let step2_plan = f.engine.store.plan("auto:step:2").unwrap();
    let upkeep_str = step2_plan.meta["upkeepMessages"].to_string();
    assert!(upkeep_str.contains("【设定集里已有的卡片】") && upkeep_str.contains("玩家写的，不要改"), "{upkeep_str}");
}
