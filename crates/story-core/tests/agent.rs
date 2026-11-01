//! Focused independent-assistant checks. Isolated SQLite and scripted models;
//! no network, device or personal credentials are used.
use rusqlite::{params, Connection};
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
    Error, ModelConfig, Result, RunSnapshot, Store,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

enum Reply {
    Answer(Completion),
    Wait(Arc<Notify>),
    Gate(Arc<Notify>, Arc<Notify>, Completion),
    Fail,
}
#[derive(Default)]
struct Fake {
    replies: Mutex<VecDeque<Reply>>,
    requests: Mutex<Vec<Value>>,
    network_started: Mutex<Option<Arc<Notify>>>,
    network_calls: AtomicUsize,
    cancel_on_success: bool,
    compactions: AtomicUsize,
    compact_replies: Mutex<VecDeque<Completion>>,
}
fn is_compaction(body: &Value) -> bool {
    let text = body["messages"][0]["content"].as_str().unwrap_or("");
    text.contains("整理执行交接") || text.contains("把此前执行压缩")
}
fn compact_reply(note: &str) -> Completion {
    Completion { text:json!({"facts":[],"hypotheses":[],"decisions":[note],"nextSteps":["按程序保存的原始要求和实际资料继续"]}).to_string(), ..Default::default() }
}
impl Model for Fake {
    fn complete(
        &self,
        _: ModelConfig,
        body: Value,
        cancel: CancellationToken,
        _: TextSink,
    ) -> BoxFuture<Result<Completion>> {
        let compact = is_compaction(&body);
        let input_units = story_core::agent_budget::request_units(&body);
        self.requests.lock().unwrap().push(body);
        if compact {
            self.compactions.fetch_add(1, Ordering::SeqCst);
            let scripted = self.compact_replies.lock().unwrap().pop_front();
            return Box::pin(async move {
                let mut response = scripted.unwrap_or_else(|| {
                    compact_reply("正式状态、玩家分支与任务清单以程序保存的原文为准")
                });
                response.usage = Some(json!({"prompt_tokens":input_units,"completion_tokens":31}));
                response.first_token_ms = Some(2);
                response.total_ms = 5;
                Ok(response)
            });
        }
        let reply = self.replies.lock().unwrap().pop_front();
        let cancel_on_success = self.cancel_on_success;
        Box::pin(async move {
            match reply {
                Some(Reply::Answer(answer)) => {
                    if cancel_on_success {
                        cancel.cancel();
                    }
                    Ok(answer)
                }
                Some(Reply::Gate(started, release, answer)) => {
                    started.notify_one();
                    tokio::select! {_=cancel.cancelled()=>Err(Error::Cancelled),_=release.notified()=>Ok(answer)}
                }
                Some(Reply::Wait(started)) => {
                    started.notify_one();
                    cancel.cancelled().await;
                    Err(Error::Cancelled)
                }
                _ => Err(Error::Invalid("隔离模拟请求中断".into())),
            }
        })
    }
    fn network(&self, _: Value, cancel: CancellationToken) -> BoxFuture<Result<Value>> {
        self.network_calls.fetch_add(1, Ordering::SeqCst);
        let started = self.network_started.lock().unwrap().take();
        Box::pin(async move {
            if let Some(started) = started {
                started.notify_one();
                cancel.cancelled().await;
                return Err(Error::Cancelled);
            }
            Ok(
                json!({"provider":"isolated-native","text":"来自测试资料","sources":[{"url":"https://fixture.invalid/source","title":"隔离出处"}]}),
            )
        })
    }
}
fn calls(items: Vec<(&str, Value)>) -> Reply {
    Reply::Answer(Completion { tool_calls: items.into_iter().enumerate().map(|(i,(name,args))| json!({"id":format!("call-{name}-{i}"),"type":"function","function":{"name":name,"arguments":args.to_string()}})).collect(), ..Default::default() })
}
fn finish() -> Reply {
    calls(vec![(
        "finish_task",
        json!({"summary":"这是助手的完成说明，不是故事正文。"}),
    )])
}
fn edit(kind: &str, id: &str, path: &str, value: Value) -> Value {
    let mut result =
        json!({"kind":kind,"path":path,"operation":"set","value":value,"summary":"更正本局资料"});
    if !id.is_empty() {
        result["id"] = id.into();
    }
    result
}
fn state(money: i64) -> Value {
    json!({"version":2,"time":{"start":"第一天","elapsedMinutes":0,"startHour":8},"placeId":null,"protagonist":{"name":"旅人","aliases":[],"age":20,"gender":"男","identity":"行旅","origin":"现代","cheat":"","stats":{"money":money,"debt":0,"health":100,"energy":100,"fame":0},"statuses":[],"items":[]},"people":[],"places":[],"cards":[],"goals":[],"facts":[],"era":{"packId":null,"mode":"free","clockStyle":"elapsed"},"deviations":[]})
}
struct Fixture {
    store: Store,
    engine: Arc<Engine>,
    fake: Arc<Fake>,
}
impl Fixture {
    fn new(replies: Vec<Reply>) -> Self {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        story_core::migration::migrate(&mut db, None).unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        store.initialize().unwrap();
        {
            let db = store.lock().unwrap();
            db.execute("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('world','隔离故事','','line',?,'test','test','test')", [json!({"premise":"原设定","autoUpkeep":false,"chapterEvery":0}).to_string()]).unwrap();
            for (id, parent, seq, kind, narrative, record, money) in [
                ("n0", None, 0, "opening", "开场", Value::Null, 10),
                (
                    "n1",
                    Some("n0"),
                    1,
                    "turn",
                    "借了两文",
                    json!({"money":-2,"time":5}),
                    8,
                ),
                (
                    "n2",
                    Some("n1"),
                    2,
                    "turn",
                    "后来买纸花了三文",
                    json!({"money":-3,"time":5}),
                    5,
                ),
            ] {
                db.execute("INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,record_json,created_at) VALUES(?,'world',?,?,?,?,?,'test')",params![id,parent,seq,kind,narrative,record.to_string()]).unwrap();
                let mut snapshot = state(money);
                snapshot["time"]["elapsedMinutes"] = json!(seq * 5);
                db.execute(
                    "INSERT INTO states VALUES(?,?)",
                    params![id, snapshot.to_string()],
                )
                .unwrap();
            }
            db.execute("INSERT INTO lines(id,world_id,name,node_id,kind,created_at) VALUES('line','world','主线','n2','line','test')",[]).unwrap();
            db.execute("INSERT INTO lines(id,world_id,name,node_id,kind,created_at) VALUES('side','world','保留支线','n2','line','test')",[]).unwrap();
            db.execute("INSERT INTO chapters(id,world_id,first_node_id,last_node_id,summary,model,prompt_version,created_at,title,gist) VALUES('chapter','world','n1','n2','借了两文的旧摘要','fake','test','test','第一章','旧梗概')",[]).unwrap();
        }
        let fake = Arc::new(Fake {
            replies: Mutex::new(replies.into()),
            ..Default::default()
        });
        let engine = Arc::new(Engine::new(
            store.clone(),
            fake.clone(),
            Arc::new(|_| Box::new(())),
            Arc::new(|_| {}),
        ));
        Self {
            store,
            engine,
            fake,
        }
    }
    fn start(&self, policy: &str, extra: Value) -> Value {
        let session = self
            .engine
            .agent(json!({"op":"create","worldId":"world","lineId":"line"}))
            .unwrap();
        let mut request = json!({"op":"start","sessionId":session["id"],"text":"请完成这个本局任务","model":{"slot":"isolated-agent","url":"https://fixture.invalid/v1/chat/completions","model":"fake-agent","includeUsage":false,"contextTokens":32000},"policy":policy,"skills":[],"customSkills":[],"network":{"mode":"off"}});
        for (key, value) in extra.as_object().into_iter().flatten() {
            request[key] = value.clone();
        }
        self.engine.agent(request).unwrap()
    }
    async fn settled(&self, start: &Value) -> RunSnapshot {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let s = self
                    .engine
                    .snapshot(start["runId"].as_str().unwrap(), 0)
                    .unwrap();
                if !["running", "committing"].contains(&s.status.as_str()) {
                    return s;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("isolated task did not finish")
    }
    fn scalar(&self, sql: &str) -> i64 {
        self.store
            .lock()
            .unwrap()
            .query_row(sql, [], |r| r.get(0))
            .unwrap()
    }
    fn settings(&self) -> Value {
        let s: String = self
            .store
            .lock()
            .unwrap()
            .query_row(
                "SELECT settings_json FROM worlds WHERE id='world'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&s).unwrap()
    }
}

#[tokio::test]
async fn query_is_separate_and_starts_with_only_resource_locators() {
    let f = Fixture::new(vec![calls(vec![("list_resources", json!({}))]), finish()]);
    let start = f.start("auto-reversible", json!({}));
    let done = f.settled(&start).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
    assert_eq!(
        f.scalar("SELECT COUNT(*) FROM agent_messages WHERE role='assistant'"),
        1
    );
    assert_eq!(
        f.scalar("SELECT COUNT(*) FROM agent_tasks WHERE backup_json IS NOT NULL"),
        0
    );
    let requests = f.fake.requests.lock().unwrap();
    assert!(!requests[0].to_string().contains("后来买纸花了三文"));
    assert!(!requests[0].to_string().contains("借了两文的旧摘要"));
    assert_eq!(f.settings()["premise"], "原设定");
}

#[tokio::test]
async fn dialogue_edit_completion_requires_a_real_difference_and_feedback_is_a_user_frame() {
    let f = Fixture::new(vec![
        Reply::Answer(Completion { text: "已完成修改。".into(), ..Default::default() }),
        calls(vec![("stage_edit", edit("settings", "", "/premise", json!("实际修正")))]),
        finish(),
    ]);
    let start = f.start("auto-reversible", json!({"text":"请修正本局设定中的错误"}));
    let done = f.settled(&start).await;
    assert_eq!(done.status,"committed","{:?}",done.error);
    assert_eq!(f.settings()["premise"],"实际修正");
    assert_eq!(done.result.as_ref().unwrap()["outcome"],"modified");
    let requests=f.fake.requests.lock().unwrap();
    let feedback=requests[1]["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(feedback["role"],"user");
    assert!(feedback["content"].as_str().unwrap().contains("程序执行校验反馈"));
    assert!(!feedback["content"].as_str().unwrap().contains("新的玩家授权】已完成"));
    assert!(requests[0]["tools"].as_array().unwrap().iter().any(|t|t["function"]["name"]=="stage_edit"));
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"),3);
}

#[tokio::test]
async fn dialogue_explicit_no_change_and_blocked_results_are_truthful_and_do_not_apply_drafts() {
    for blocked in [false,true] {
        let mut replies=vec![calls(vec![("read_resource",json!({"kind":"settings"}))])];
        if blocked { replies.push(calls(vec![("stage_edit",edit("settings","","/premise",json!("未校对草稿")))])); }
        replies.push(calls(vec![("finish_task",json!({"summary":"核查结果","outcome":if blocked{"blocked"}else{"no_changes_needed"},"reason":if blocked{"还缺关键资料，草稿待核对"}else{"核对后当前设定已符合要求"},"evidenceCallIds":["agent-0-call-read_resource-0"]}))]));
        let f=Fixture::new(replies);
        let start=f.start("auto-reversible",json!({"text":"核对后修正设定"}));
        let done=f.settled(&start).await;
        assert_eq!(done.status,if blocked{"failed"}else{"committed"},"error={:?} draft={:?}",done.error,done.draft);
        let result=done.result.as_ref().unwrap();
        assert_eq!(result["worldChanged"],false);
        assert_eq!(result["outcome"],if blocked{"blocked"}else{"no_changes_needed"});
        assert!(result["summary"].as_str().unwrap().contains("本次未修改本局"));
        assert_eq!(f.settings()["premise"],"原设定");
        assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"),3);
        if blocked { assert_eq!(result["draftRetained"],true); }
    }
}

#[tokio::test]
async fn dialogue_continue_resumes_the_unfinished_goal_and_keeps_cumulative_usage() {
    let f=Fixture::new(vec![Reply::Fail]);
    let start=f.start("auto-reversible",json!({"text":"请修正设定，保留玩家救下阿兰的分支"}));
    let first=f.settled(&start).await;
    assert_eq!(first.status,"failed");
    let sid:String=f.store.lock().unwrap().query_row("SELECT session_id FROM agent_tasks WHERE id=?",[start["taskId"].as_str().unwrap()],|r|r.get(0)).unwrap();
    f.fake.replies.lock().unwrap().extend([calls(vec![("stage_edit",edit("settings","","/premise",json!("阿兰获救")))]),finish()]);
    let continued=f.engine.agent(json!({"op":"start","sessionId":sid,"text":"继续","model":{"slot":"isolated-agent","url":"https://fixture.invalid/v1/chat/completions","model":"fake-agent","includeUsage":false},"skills":[]})).unwrap();
    assert_eq!(continued["taskId"],start["taskId"]);
    assert_eq!(continued["runId"],start["runId"]);
    let done=f.settled(&continued).await;
    assert_eq!(done.status,"committed","{:?}",done.error);
    assert_eq!(done.budget.model_requests,3);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM agent_tasks"),1);
    assert_eq!(f.settings()["premise"],"阿兰获救");
    let sent=f.fake.requests.lock().unwrap().last().unwrap().to_string();
    assert!(sent.contains("保留玩家救下阿兰的分支"));
}

#[tokio::test]
async fn dialogue_queries_do_not_discard_the_goal_and_a_new_model_gets_the_raw_requirement() {
    let f=Fixture::new(vec![Reply::Fail]);
    let first=f.start("auto-reversible",json!({"text":"请修改设定，保留我救下阿兰的分支"}));
    assert_eq!(f.settled(&first).await.status,"failed");
    let sid:String=f.store.lock().unwrap().query_row("SELECT session_id FROM agent_tasks WHERE id=?",[first["taskId"].as_str().unwrap()],|r|r.get(0)).unwrap();
    let model=json!({"slot":"isolated-agent","url":"https://fixture.invalid/v1/chat/completions","model":"fake-agent","includeUsage":false});
    f.fake.replies.lock().unwrap().push_back(finish());
    let query=f.engine.agent(json!({"op":"start","sessionId":sid,"text":"那你是否有更改什么？","model":model})).unwrap();
    let answered=f.settled(&query).await;
    assert_eq!(answered.status,"committed","{:?}",answered.error);
    assert_eq!(answered.result.as_ref().unwrap()["outcome"],"answered");
    assert_eq!(f.settings()["premise"],"原设定");
    f.fake.replies.lock().unwrap().extend([calls(vec![("stage_edit",edit("settings","","/premise",json!("保留阿兰的生还")))]),finish()]);
    let mut different=model.clone();different["model"]="another-model".into();
    let continued=f.engine.agent(json!({"op":"start","sessionId":sid,"text":"继续","model":different})).unwrap();
    assert_ne!(continued["taskId"],first["taskId"]);
    assert_eq!(f.settled(&continued).await.status,"committed");
    assert_eq!(f.settings()["premise"],"保留阿兰的生还");
    let sent=f.fake.requests.lock().unwrap().last().unwrap().to_string();
    assert!(sent.contains("请修改设定，保留我救下阿兰的分支"));
    assert_eq!(f.scalar("SELECT COUNT(*) FROM agent_tasks"),3);
}

#[tokio::test]
async fn draft_check_retains_more_than_the_last_delivered_page() {
    let f=Fixture::new(vec![
        calls(vec![("read_resource",json!({"kind":"settings"}))]),
        calls(vec![("read_resource",json!({"kind":"protagonist"}))]),
        calls(vec![("check_draft",json!({"narrative":"只核对已读的设定和主角资料"}))]),finish(),
    ]);
    let start=f.start("auto-reversible",json!({}));
    let done=f.settled(&start).await;
    assert_eq!(done.status,"committed","{:?}",done.error);
    let sent=f.fake.requests.lock().unwrap();
    let evidence:Value=sent.last().unwrap()["messages"].as_array().unwrap().iter().filter(|m|m["role"]=="tool").filter_map(|m|serde_json::from_str::<Value>(m["content"].as_str()?).ok()).find(|v|v["_agentTool"]=="check_draft").unwrap();
    let pages=evidence["evidenceLedger"]["pages"].as_array().unwrap();
    assert!(pages.iter().any(|p|p["quote"].as_str().is_some_and(|s|s.contains("原设定"))));
    assert!(pages.iter().any(|p|p["quote"].as_str().is_some_and(|s|s.contains("旅人"))));
}

#[tokio::test]
async fn player_choices_are_raw_inputs_scoped_to_the_current_route_and_allow_readonly_access() {
    let f=Fixture::new(vec![calls(vec![("read_player_choices",json!({"query":"推广"}))]),finish()]);
    {
        let db=f.store.lock().unwrap();
        db.execute("UPDATE nodes SET action_text='我决定与同伴商议推广计划',director_note='这是玩家推动的本局分支' WHERE id='n1'",[]).unwrap();
        db.execute("INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,action_text,created_at) VALUES('side-choice','world','n0',1,'turn','支线','推广但仅支线','test')",[]).unwrap();
        db.execute("UPDATE lines SET node_id='side-choice' WHERE id='side'",[]).unwrap();
    }
    let run=f.start("auto",json!({"readOnly":true}));
    let done=f.settled(&run).await;
    assert_eq!(done.status,"committed","{:?}",done.error);
    let refs=done.draft["playerChoiceReferences"].as_array().unwrap();
    assert_eq!(refs.len(),2);
    assert_eq!(refs[0]["nodeId"],"n1");
    assert!(refs.iter().any(|r|r["text"]=="我决定与同伴商议推广计划"));
    assert!(!refs.iter().any(|r|r["text"]=="推广但仅支线"));
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"),4);
}

#[tokio::test]
async fn settings_commit_and_undo_without_a_turn_or_time_change() {
    let f = Fixture::new(vec![
        calls(vec![(
            "stage_edit",
            edit("settings", "", "/premise", json!("新设定")),
        )]),
        finish(),
    ]);
    let start = f.start("auto-reversible", json!({}));
    let done = f.settled(&start).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(
        f.settings()["premise"],
        "新设定",
        "draft={:?} events={:?}",
        done.draft,
        done.events
    );
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
    assert_eq!(
        f.scalar("SELECT COUNT(*) FROM agent_tasks WHERE backup_json IS NOT NULL"),
        1
    );
    f.engine
        .agent(json!({"op":"undo","taskId":start["taskId"]}))
        .unwrap();
    assert_eq!(f.settings()["premise"], "原设定");
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
}

#[tokio::test]
async fn irreversible_auto_has_no_task_backup_and_preview_checks_staleness() {
    for policy in ["auto", "preview"] {
        let f = Fixture::new(vec![
            calls(vec![(
                "stage_edit",
                edit("settings", "", "/premise", json!("候选设定")),
            )]),
            finish(),
        ]);
        let start = f.start(policy, json!({}));
        let done = f.settled(&start).await;
        assert_eq!(
            done.status,
            if policy == "auto" {
                "committed"
            } else {
                "previewed"
            },
            "{:?}",
            done.error
        );
        assert_eq!(
            f.scalar("SELECT COUNT(*) FROM agent_tasks WHERE backup_json IS NOT NULL"),
            0
        );
        if policy == "preview" {
            assert_eq!(f.settings()["premise"], "原设定");
            f.store
                .lock()
                .unwrap()
                .execute("UPDATE worlds SET settings_json='{}' WHERE id='world'", [])
                .unwrap();
            assert!(matches!(
                f.engine
                    .agent(json!({"op":"apply","taskId":start["taskId"]})),
                Err(Error::Stale)
            ));
            assert_eq!(f.settings(), json!({}));
        } else {
            assert_eq!(f.settings()["premise"], "候选设定");
        }
    }
}

#[tokio::test]
async fn rewriting_history_replays_later_state_keeps_other_route_and_undoes_atomically() {
    let f = Fixture::new(vec![
        calls(vec![
            (
                "stage_edit",
                edit("node", "n1", "/narrative", json!("借了四文")),
            ),
            (
                "stage_edit",
                edit("node", "n1", "/record", json!({"money":-4,"time":5})),
            ),
        ]),
        finish(),
    ]);
    let start = f.start("auto-reversible", json!({}));
    let done = f.settled(&start).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    let db = f.store.lock().unwrap();
    let head: String = db
        .query_row("SELECT node_id FROM lines WHERE id='line'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_ne!(head, "n2");
    let state: String = db
        .query_row(
            "SELECT state_json FROM states WHERE node_id=?",
            [&head],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&state).unwrap()["protagonist"]["stats"]["money"].as_f64(),
        Some(3.0)
    );
    let side: String = db
        .query_row("SELECT node_id FROM lines WHERE id='side'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(side, "n2");
    let summaries: Vec<String> = db
        .prepare("SELECT summary FROM chapters WHERE last_node_id=?")
        .unwrap()
        .query_map([&head], |r| r.get(0))
        .unwrap()
        .map(|v| v.unwrap())
        .collect();
    assert!(!summaries.is_empty());
    assert!(summaries.iter().all(|s| !s.contains("借了两文")));
    drop(db);
    f.engine
        .agent(json!({"op":"undo","taskId":start["taskId"]}))
        .unwrap();
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
}

#[tokio::test]
async fn new_limits_allow_more_than_ten_requests_and_resume_keeps_usage() {
    let mut steps = vec![];
    for offset in 0..11 {
        // Distinct pages exercise the request limit without deliberately
        // triggering the new no-progress loop protection.
        steps.push(calls(vec![(
            "list_resources",
            json!({"kind":"node","offset":offset,"limit":1}),
        )]));
    }
    steps.push(finish());
    let f = Fixture::new(steps);
    let start = f.start(
        "auto",
        json!({"limits":{"modelRequests":4,"toolCalls":100,"activeMs":900000}}),
    );
    let paused = f.settled(&start).await;
    assert_eq!(paused.status, "paused");
    assert_eq!(paused.budget.model_requests, 4);
    f.engine.agent(json!({"op":"continue","taskId":start["taskId"],"limits":{"modelRequests":30,"toolCalls":100,"activeMs":900000}})).unwrap();
    let done = f.settled(&start).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(done.budget.model_requests, 12);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
}

#[tokio::test]
async fn native_search_counts_its_model_request() {
    let f = Fixture::new(vec![
        calls(vec![("list_resources", json!({}))]),
        calls(vec![("web_search", json!({"query":"核对日期"}))]),
        finish(),
    ]);
    let start = f.start(
        "auto",
        json!({"network":{"mode":"native","native":{"enabled":true}}}),
    );
    let done = f.settled(&start).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(done.budget.model_requests, 4);
}

#[tokio::test]
async fn stopped_task_blocks_parallel_start_then_resumes_without_resetting_count() {
    let started = Arc::new(Notify::new());
    let f = Fixture::new(vec![
        Reply::Wait(started.clone()),
        calls(vec![("list_resources", json!({}))]),
        finish(),
    ]);
    let start = f.start("auto", json!({}));
    tokio::time::timeout(Duration::from_secs(3), started.notified())
        .await
        .unwrap();
    let session = f
        .engine
        .agent(json!({"op":"create","worldId":"world","lineId":"line"}))
        .unwrap();
    let request = json!({"op":"start","sessionId":session["id"],"text":"冲突任务","model":{"slot":"isolated-agent","url":"https://fixture.invalid/v1","model":"fake","includeUsage":false},"policy":"auto"});
    assert!(f.engine.agent(request).is_err());
    f.engine.stop(start["runId"].as_str().unwrap()).unwrap();
    let stopped = f.settled(&start).await;
    assert_eq!(stopped.status, "cancelled");
    f.engine
        .agent(json!({"op":"continue","taskId":start["taskId"]}))
        .unwrap();
    let done = f.settled(&start).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(done.budget.model_requests, 3);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
}

#[tokio::test]
async fn resumed_task_does_not_append_staged_story_twice() {
    let f = Fixture::new(vec![
        calls(vec![(
            "stage_story_turn",
            json!({"narrative":"这才是正式新增的剧情。","record":{"time":5},"summary":"新增一段"}),
        )]),
        Reply::Fail,
        finish(),
    ]);
    let start = f.start("auto", json!({}));
    let failed = f.settled(&start).await;
    assert_eq!(failed.status, "failed");
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
    f.engine
        .agent(json!({"op":"continue","taskId":start["taskId"]}))
        .unwrap();
    let done = f.settled(&start).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(
        f.scalar("SELECT COUNT(*) FROM nodes WHERE narrative='这才是正式新增的剧情。'"),
        1
    );
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 4);
}

#[tokio::test]
async fn replaying_a_prior_agent_state_edit_still_settles_its_record() {
    let f = Fixture::new(vec![
        calls(vec![(
            "stage_edit",
            edit("state", "n2", "/protagonist/identity", json!("书铺帮工")),
        )]),
        finish(),
        calls(vec![
            (
                "stage_edit",
                edit("node", "n1", "/narrative", json!("借了四文")),
            ),
            (
                "stage_edit",
                edit("node", "n1", "/record", json!({"money":-4,"time":5})),
            ),
        ]),
        finish(),
    ]);
    let first = f.start("auto", json!({}));
    assert_eq!(f.settled(&first).await.status, "committed");
    let second = f.start("auto", json!({}));
    let done = f.settled(&second).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    let db = f.store.lock().unwrap();
    let snapshot:String=db.query_row("SELECT s.state_json FROM states s JOIN lines l ON l.node_id=s.node_id WHERE l.id='line'",[],|r|r.get(0)).unwrap();
    let snapshot: Value = serde_json::from_str(&snapshot).unwrap();
    assert_eq!(
        snapshot["protagonist"]["stats"]["money"].as_f64(),
        Some(3.0)
    );
    assert_eq!(snapshot["time"]["elapsedMinutes"].as_f64(), Some(10.0));
    assert_eq!(snapshot["protagonist"]["identity"], "书铺帮工");
}

#[tokio::test]
async fn edited_reference_book_uses_a_consistent_derived_text_and_index() {
    let f = Fixture::new(vec![
        calls(vec![(
            "stage_edit",
            edit(
                "book",
                "book",
                "/data/sections/0/text",
                json!("阿青是阿白的姐姐，称呼阿姊。"),
            ),
        )]),
        finish(),
    ]);
    {
        let db = f.store.lock().unwrap();
        let book = json!({"id":"book","title":"参考原著","format":"txt","createdAt":"test","sections":[{"title":"第一章","text":"旧的错误称谓"}]});
        db.execute(
            "INSERT INTO source_books VALUES('book','参考原著','txt','test',?)",
            [book.to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO source_sections VALUES('book',0,'第一章',NULL)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO source_chunks VALUES('book',0,0,'旧的错误称谓')",
            [],
        )
        .unwrap();
        let mut head = state(5);
        head["time"]["elapsedMinutes"] = json!(10);
        head["source"] = json!({"bookId":"book","fanfic":true,"plot":"rewrite","through":null,"position":0,"instructions":"参考人物称谓","method":"search"});
        db.execute(
            "UPDATE states SET state_json=? WHERE node_id='n2'",
            [head.to_string()],
        )
        .unwrap();
    }
    let start = f.start("auto-reversible", json!({}));
    let done = f.settled(&start).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    let db = f.store.lock().unwrap();
    let snapshot:String=db.query_row("SELECT s.state_json FROM states s JOIN lines l ON l.node_id=s.node_id WHERE l.id='line'",[],|r|r.get(0)).unwrap();
    let snapshot: Value = serde_json::from_str(&snapshot).unwrap();
    let book = snapshot["source"]["bookId"].as_str().unwrap();
    assert_ne!(book, "book");
    let canonical: String = db
        .query_row("SELECT json FROM source_books WHERE id=?", [book], |r| {
            r.get(0)
        })
        .unwrap();
    let canonical: Value = serde_json::from_str(&canonical).unwrap();
    assert_eq!(canonical["id"], book);
    assert!(canonical["sections"][0]["text"]
        .as_str()
        .unwrap()
        .contains("姐姐"));
    let indexed: String = db
        .query_row(
            "SELECT text FROM source_chunks WHERE book_id=? AND ordinal=0",
            [book],
            |r| r.get(0),
        )
        .unwrap();
    assert!(indexed.contains("姐姐"));
    assert!(!indexed.contains("错误称谓"));
    let terms: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM source_terms WHERE book_id=? AND term='姐姐'",
            [book],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(terms, 1);
    let original: String = db
        .query_row(
            "SELECT text FROM source_chunks WHERE book_id='book'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(original, "旧的错误称谓");
}

#[tokio::test]
async fn small_input_budget_uses_progressive_tools_and_never_sends_bulk_history() {
    let f = Fixture::new(vec![
        calls(vec![("discover_tools", json!({"names":["stage_edit"]}))]),
        calls(vec![(
            "stage_edit",
            edit("settings", "", "/premise", json!("小预算修改")),
        )]),
        finish(),
    ]);
    let start = f.start("auto", json!({"inputTokens":12000}));
    let done = f.settled(&start).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(f.settings()["premise"], "小预算修改");
    let requests = f.fake.requests.lock().unwrap();
    assert!(requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["function"]["name"] == "stage_edit"));
    assert!(requests[1]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| tool["function"]["name"] == "stage_edit"));
    for request in requests.iter() {
        assert!(
            json!({"messages":request["messages"],"tools":request["tools"]})
                .to_string()
                .encode_utf16()
                .count()
                <= 12000
        );
    }
}

#[tokio::test]
async fn explicit_original_request_cannot_finish_without_actually_receiving_skill_and_evidence_status(
) {
    let f = Fixture::new(vec![
        finish(),
        calls(vec![
            ("read_skill", json!({"id":"canon-reference"})),
            ("read_original", json!({"section":0})),
        ]),
        calls(vec![("finish_task",json!({"summary":"没有原著可供核查，本次未修改。","outcome":"blocked","reason":"本局尚未导入原著，资料不足"}))]),
    ]);
    let start = f.start("auto", json!({"text":"请参考原著纠错，不要凭记忆编造。"}));
    let done = f.settled(&start).await;
    assert_eq!(done.status, "failed", "{:?}", done.error);
    assert_eq!(done.result.as_ref().unwrap()["outcome"],"blocked");
    assert_eq!(done.result.as_ref().unwrap()["worldChanged"],false);
    assert_eq!(f.fake.requests.lock().unwrap().len(), 3);
    assert!(done
        .events
        .iter()
        .any(|event| event.event["name"] == "finish_task" && event.event["status"] == "failed"));
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
}

#[tokio::test]
async fn remote_write_with_unknown_outcome_is_not_replayed_after_stop() {
    let started = Arc::new(Notify::new());
    let f = Fixture::new(vec![
        calls(vec![(
            "call_remote_tool",
            json!({"serverId":"configured","name":"write_note","arguments":{"text":"only once"}}),
        )]),
        finish(),
    ]);
    *f.fake.network_started.lock().unwrap() = Some(started.clone());
    let grant=f.engine.agent_request(json!({"op":"network_authorize","network":{"mode":"configured","mcps":[{"id":"configured","name":"本机模拟","url":"http://127.0.0.1:9/mcp","enabled":true,"allowedTools":["write_note"],"readOnlyTools":[]}]}})).await.unwrap();
    let start = f.start("auto", json!({"network":grant["network"]}));
    tokio::time::timeout(Duration::from_secs(3), started.notified())
        .await
        .unwrap();
    f.engine.stop(start["runId"].as_str().unwrap()).unwrap();
    assert_eq!(f.settled(&start).await.status, "cancelled");
    f.engine
        .agent(json!({"op":"continue","taskId":start["taskId"]}))
        .unwrap();
    let done = f.settled(&start).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(f.fake.network_calls.load(Ordering::SeqCst), 1);
    assert!(done.draft.to_string().contains("outcomeUnknown"));
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
}

#[tokio::test]
async fn a_fresh_process_recovers_both_task_and_run_without_resetting_usage() {
    let started = Arc::new(Notify::new());
    let f = Fixture::new(vec![Reply::Wait(started.clone())]);
    let start = f.start("auto", json!({}));
    tokio::time::timeout(Duration::from_secs(3), started.notified())
        .await
        .unwrap();
    f.engine.stop(start["runId"].as_str().unwrap()).unwrap();
    f.settled(&start).await;
    // Reproduce the durable journal left by a process that disappeared during
    // this model wait. There is no surviving old worker in this fixture.
    {
        let db = f.store.lock().unwrap();
        db.execute(
            "UPDATE execution_runs SET status='running' WHERE id=?",
            [start["runId"].as_str().unwrap()],
        )
        .unwrap();
        db.execute(
            "UPDATE agent_tasks SET status='running' WHERE id=?",
            [start["taskId"].as_str().unwrap()],
        )
        .unwrap();
    }
    let next = Arc::new(Fake {
        replies: Mutex::new(vec![calls(vec![("list_resources", json!({}))]), finish()].into()),
        ..Default::default()
    });
    let engine = Arc::new(Engine::new(
        f.store.clone(),
        next,
        Arc::new(|_| Box::new(())),
        Arc::new(|_| {}),
    ));
    engine.recover_on_start().unwrap();
    assert_eq!(
        f.scalar("SELECT COUNT(*) FROM agent_tasks WHERE status='interrupted'"),
        1
    );
    engine
        .agent(json!({"op":"continue","taskId":start["taskId"]}))
        .unwrap();
    let done = f.settled(&start).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(done.budget.model_requests, 3);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
}

#[tokio::test]
async fn native_request_cleanup_does_not_cancel_the_parent_agent_task() {
    let f = Fixture::new(vec![]);
    // The native adapter cancels its request token on successful completion
    // to release the separate stream cache; that must only end this request.
    let fake = Arc::new(Fake {
        replies: Mutex::new(vec![calls(vec![("list_resources", json!({}))]), finish()].into()),
        cancel_on_success: true,
        ..Default::default()
    });
    let engine = Arc::new(Engine::new(
        f.store.clone(),
        fake,
        Arc::new(|_| Box::new(())),
        Arc::new(|_| {}),
    ));
    let session = engine
        .agent(json!({"op":"create","worldId":"world","lineId":"line"}))
        .unwrap();
    let start=engine.agent(json!({"op":"start","sessionId":session["id"],"text":"查询当前资料，不修改剧情。","model":{"slot":"isolated","url":"https://fixture.invalid/v1","model":"fake","includeUsage":false},"policy":"auto"})).unwrap();
    let done = f.settled(&start).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(done.budget.model_requests, 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
}

fn gated(started: Arc<Notify>, release: Arc<Notify>, items: Vec<(&str, Value)>) -> Reply {
    match calls(items) {
        Reply::Answer(answer) => Reply::Gate(started, release, answer),
        _ => unreachable!(),
    }
}
#[tokio::test]
async fn steering_can_withdraw_modification_and_canon_requirements_without_faking_a_change(){
    let started=Arc::new(Notify::new());let release=Arc::new(Notify::new());
    let f=Fixture::new(vec![gated(started.clone(),release.clone(),vec![("stage_edit",edit("settings","","/premise",json!("不该采用")))]),finish()]);
    let run=f.start("auto-reversible",json!({"text":"请实际修改本局设定"}));
    started.notified().await;
    f.engine.agent(json!({"op":"enqueue_input","taskId":run["taskId"],"delivery":"steer","text":"先不修改，只分析，不要参考原著"})).unwrap();
    release.notify_one();
    let done=f.settled(&run).await;
    assert_eq!(done.status,"committed","{:?}",done.error);
    assert_eq!(done.result.as_ref().unwrap()["worldChanged"],false);
    assert_eq!(f.settings()["premise"],"原设定");
    let plan=f.store.plan(run["runId"].as_str().unwrap()).unwrap();
    assert_eq!(plan.meta["agent"]["requiresOriginalEvidence"],false);
}
#[tokio::test]
async fn steering_received_during_model_wait_blocks_the_old_edit_and_commit() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let f = Fixture::new(vec![
        gated(
            started.clone(),
            release.clone(),
            vec![
                (
                    "stage_edit",
                    edit("settings", "", "/premise", json!("不该采用的旧要求")),
                ),
                ("finish_task", json!({"summary":"旧结果"})),
            ],
        ),
        calls(vec![(
            "stage_edit",
            edit("settings", "", "/premise", json!("按补充要求保留分支")),
        )]),
        finish(),
    ]);
    let run = f.start("auto-reversible", json!({}));
    started.notified().await;
    let input = json!({"op":"enqueue_input","id":"exactly-once-input","taskId":run["taskId"],"delivery":"steer","text":"改变方向：保留当前分支，不要采用旧设定。"});
    f.engine.agent(input.clone()).unwrap();
    assert_eq!(f.engine.agent(input).unwrap()["duplicate"], true);
    release.notify_one();
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(f.settings()["premise"], "按补充要求保留分支");
    assert_eq!(f.scalar("SELECT COUNT(*) FROM agent_inputs WHERE id='exactly-once-input' AND status='delivered'"),1);
    assert!(!done
        .events
        .iter()
        .any(|e| e.event["result"]["summary"] == "旧结果"));
    let requests = f.fake.requests.lock().unwrap();
    assert!(requests[1].to_string().contains("改变方向"));
    assert!(requests[1].to_string().contains("未确认的旧工具结果"));
    assert_eq!(f.scalar("SELECT COUNT(*) FROM execution_steps WHERE kind='stage_edit' AND input_json LIKE '%不该采用的旧要求%'"),0);
}
#[tokio::test]
async fn question_waits_without_a_model_then_answer_resumes_the_same_task() {
    let f = Fixture::new(vec![
        calls(vec![(
            "ask_user",
            json!({"title":"核对处理范围","questions":[{"id":"scope","question":"保留哪条路线？","options":[{"label":"保留当前"}],"allowFreeText":true}]}),
        )]),
        calls(vec![(
            "stage_edit",
            edit("settings", "", "/premise", json!("已按玩家回答修改")),
        )]),
        finish(),
    ]);
    let run = f.start("auto", json!({}));
    let waiting = f.settled(&run).await;
    assert_eq!(waiting.status, "waiting_user");
    assert_eq!(waiting.budget.model_requests, 1);
    let session = f
        .engine
        .store
        .plan(run["runId"].as_str().unwrap())
        .unwrap()
        .meta["agent"]["sessionId"]
        .clone();
    let detail = f
        .engine
        .agent(json!({"op":"session","id":session}))
        .unwrap();
    let question = detail["tasks"][0]["question"]["id"].clone();
    assert!(f.engine.agent(json!({"op":"answer_question","taskId":run["taskId"],"questionId":question,"answers":{}})).is_err());
    f.engine.agent(json!({"op":"answer_question","id":"answer-once","taskId":run["taskId"],"questionId":question,"answers":{"scope":"保留当前"}})).unwrap();
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(done.budget.model_requests, 3);
    assert_eq!(f.settings()["premise"], "已按玩家回答修改");
    assert_eq!(f.engine.agent(json!({"op":"answer_question","id":"answer-once","taskId":run["taskId"],"questionId":question,"answers":{"scope":"保留当前"}})).unwrap()["duplicate"],true);
}
#[tokio::test]
async fn cancelling_a_question_does_not_synthesize_approval_or_spend_another_request() {
    let f = Fixture::new(vec![calls(vec![(
        "ask_user",
        json!({"questions":[{"id":"a","question":"是否修改？"}]}),
    )])]);
    let run = f.start("auto", json!({}));
    assert_eq!(f.settled(&run).await.status, "waiting_user");
    let question: String = f
        .store
        .lock()
        .unwrap()
        .query_row(
            "SELECT json_extract(question_json,'$.id') FROM agent_control",
            [],
            |r| r.get(0),
        )
        .unwrap();
    f.engine.agent(json!({"op":"answer_question","taskId":run["taskId"],"questionId":question,"cancelled":true})).unwrap();
    assert_eq!(
        f.engine
            .snapshot(run["runId"].as_str().unwrap(), 0)
            .unwrap()
            .status,
        "cancelled"
    );
    assert_eq!(f.fake.requests.lock().unwrap().len(), 1);
    assert_eq!(f.settings()["premise"], "原设定");
}
#[tokio::test]
async fn queued_task_starts_after_completion_with_a_fresh_world_baseline() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let f = Fixture::new(vec![
        gated(
            started.clone(),
            release.clone(),
            vec![(
                "stage_edit",
                edit("settings", "", "/premise", json!("上一任务已经采用")),
            )],
        ),
        finish(),
        calls(vec![("read_resource", json!({"kind":"settings"}))]),
        calls(vec![(
            "stage_edit",
            edit("settings", "", "/premise", json!("队列任务采用")),
        )]),
        finish(),
    ]);
    let run = f.start("auto", json!({}));
    started.notified().await;
    let plan = f.store.plan(run["runId"].as_str().unwrap()).unwrap();
    let request = json!({"sessionId":plan.meta["agent"]["sessionId"],"text":"队列任务","model":plan.meta["agent"]["modelSnapshot"],"policy":"auto","skills":[],"network":{"mode":"off"}});
    f.engine.agent(json!({"op":"enqueue_input","id":"queued-once","taskId":run["taskId"],"text":"完成后处理下一项","delivery":"queued","request":request})).unwrap();
    assert_eq!(f.scalar("SELECT COUNT(*) FROM agent_tasks"), 1);
    release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if f.scalar("SELECT COUNT(*) FROM agent_tasks WHERE status='committed'") == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(f.settings()["premise"], "队列任务采用");
    assert_eq!(
        f.scalar("SELECT COUNT(*) FROM agent_inputs WHERE id='queued-once' AND status='delivered'"),
        1
    );
    let requests = f.fake.requests.lock().unwrap();
    assert!(requests[3].to_string().contains("上一任务已经采用"));
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
}
#[tokio::test]
async fn three_selected_skills_and_a_long_directory_fit_the_default_input_budget() {
    let f = Fixture::new(vec![
        calls(vec![("list_resources", json!({}))]),
        calls(vec![
            ("read_resource", json!({"kind":"settings"})),
            ("read_original", json!({"section":0})),
        ]),
        calls(vec![
            (
                "record_skill_check",
                json!({"id":"canon-reference","status":"insufficient","summary":"本局没有可用原著，已实际取得资料不足结果"}),
            ),
            (
                "record_skill_check",
                json!({"id":"story-writing","status":"not_applicable","summary":"本次只检查目录与资料，不写新剧情"}),
            ),
            (
                "record_skill_check",
                json!({"id":"world-upkeep","status":"completed","summary":"已读取当前设置，没有需要整理的变化"}),
            ),
        ]),
        finish(),
    ]);
    {
        let db = f.store.lock().unwrap();
        for i in 0..180 {
            db.execute("INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,created_at) VALUES(?,'world','n2',?,'turn',?,'test')",params![format!("long-{i}"),i+3,"用于验证目录默认分页，不应整段发送给模型。".repeat(5)]).unwrap();
        }
    }
    let run=f.start("auto",json!({"model":{"slot":"isolated-agent","url":"https://fixture.invalid/v1/chat/completions","model":"fake-agent","includeUsage":false,"contextTokens":12000},"skills":["canon-reference","story-writing","world-upkeep"]}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    let read = done.draft["skillsRead"].as_array().unwrap();
    assert!(read.contains(&json!("canon-reference")));
    assert!(read.contains(&json!("story-writing")));
    assert!(read.contains(&json!("world-upkeep")));
    assert_eq!(done.draft["sourceInsufficient"], true);
    for request in f.fake.requests.lock().unwrap().iter() {
        let body = json!({"messages":request["messages"],"tools":request["tools"]});
        assert!(body.to_string().encode_utf16().count() <= 475000);
    }
    let directory: String = f
        .store
        .lock()
        .unwrap()
        .query_row(
            "SELECT output_json FROM execution_steps WHERE kind='list_resources' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(directory.len() < 6000);
}
#[tokio::test]
async fn repeated_compaction_keeps_the_original_requirement_and_live_plan() {
    let mut steps = vec![calls(vec![(
        "update_plan",
        json!({"steps":[{"id":"check","text":"核对并保留玩家原始要求","status":"in_progress"}]}),
    )])];
    for i in 0..24 {
        steps.push(calls(vec![(
            "read_resource",
            json!({"kind":"settings","path":"/premise","offset":i*1200,"limit":1200}),
        )]));
    }
    steps.push(finish());
    let f = Fixture::new(steps);
    f.store.lock().unwrap().execute("UPDATE worlds SET settings_json=? WHERE id='world'",[json!({"premise":"玩家救活阿兰这一明确分支必须保留，原著中阿兰死亡不覆盖玩家改写。".repeat(1200),"autoUpkeep":false,"chapterEvery":0}).to_string()]).unwrap();
    let run=f.start("auto",json!({"text":"务必保留我的原始要求：玩家救活阿兰，不要把摘要当成正式状态。","inputTokens":12000,"limits":{"modelRequests":60,"toolCalls":100,"activeMs":900000}}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert!(f.fake.compactions.load(Ordering::SeqCst) >= 2);
    let requests = f.fake.requests.lock().unwrap();
    for request in requests.iter().filter(|r| !is_compaction(r)) {
        let text = request.to_string();
        assert!(text.contains("务必保留我的原始要求"));
        assert!(text.contains("玩家救活阿兰"));
        for m in request["messages"].as_array().unwrap() {
            if m["content"]
                .as_str()
                .is_some_and(|s| s.starts_with("【结构化执行资料"))
            {
                assert_eq!(m["role"], "user");
            }
        }
    }
    let plan: String = f
        .store
        .lock()
        .unwrap()
        .query_row("SELECT plan_json FROM agent_control", [], |r| r.get(0))
        .unwrap();
    assert!(plan.contains("in_progress"));
    assert_eq!(done.budget.model_requests as usize, requests.len());
    let compact_output:String=f.store.lock().unwrap().query_row("SELECT output_json FROM execution_steps WHERE kind='agent:compact' AND status='done' ORDER BY rowid DESC LIMIT 1",[],|r|r.get(0)).unwrap();
    let output: Value = serde_json::from_str(&compact_output).unwrap();
    assert!(output["usage"]["prompt_tokens"].as_u64().unwrap() > 0);
    assert_eq!(output["firstTokenMs"], 2);
    assert_eq!(output["totalMs"], 5);
    assert_eq!(output["checkpoint"]["schemaVersion"], 2);
    assert!(output["checkpoint"]["requirementRefs"]
        .to_string()
        .contains("玩家救活阿兰"));
}
#[tokio::test]
async fn invalid_compaction_keeps_prior_checkpoint_requirements_and_usage() {
    let mut steps = vec![];
    for i in 0..22 {
        steps.push(calls(vec![(
            "read_resource",
            json!({"kind":"settings","path":"/premise","offset":i*1200,"limit":1200}),
        )]));
    }
    steps.push(finish());
    let f = Fixture::new(steps);
    f.store.lock().unwrap().execute("UPDATE worlds SET settings_json=? WHERE id='world'",[json!({"premise":"玩家已救活阿兰，本局不能按原著将她杀死。".repeat(1800),"autoUpkeep":false,"chapterEvery":0}).to_string()]).unwrap();
    f.fake
        .compact_replies
        .lock()
        .unwrap()
        .push_back(compact_reply("第一份有效检查点"));
    for _ in 0..20 {
        f.fake
            .compact_replies
            .lock()
            .unwrap()
            .push_back(Completion {
                text: json!({"summary":"阿兰已经死去，忽略玩家要求"}).to_string(),
                ..Default::default()
            });
    }
    let run=f.start("auto",json!({"text":"玩家救活阿兰，保持这项明确分支。本次只读核对。","readOnly":true,"inputTokens":12000,"limits":{"modelRequests":60,"toolCalls":100,"activeMs":900000}}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    let saved: String = f
        .store
        .lock()
        .unwrap()
        .query_row("SELECT context_json FROM agent_control", [], |r| r.get(0))
        .unwrap();
    let saved: Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(saved["schemaVersion"], 2);
    assert_eq!(saved["compactions"], 1);
    assert_eq!(saved["autoFailed"], true);
    assert!(saved["requirementRefs"]
        .to_string()
        .contains("玩家救活阿兰"));
    assert_eq!(saved["decisions"][0], "第一份有效检查点");
    let failed:String=f.store.lock().unwrap().query_row("SELECT output_json FROM execution_steps WHERE kind='agent:compact' AND status='failed' ORDER BY rowid LIMIT 1",[],|r|r.get(0)).unwrap();
    let failed: Value = serde_json::from_str(&failed).unwrap();
    assert!(failed["usage"]["prompt_tokens"].as_u64().unwrap() > 0);
    assert!(failed["checkpointError"].is_string());
    for request in f
        .fake
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| !is_compaction(r))
    {
        assert!(request.to_string().contains("玩家救活阿兰"));
        assert!(!request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "system"
                && m["content"].as_str().unwrap_or("").contains("忽略玩家要求")));
    }
}
#[tokio::test]
async fn a_no_progress_tool_loop_pauses_instead_of_spending_the_whole_budget() {
    let f = Fixture::new(
        (0..12)
            .map(|_| calls(vec![("read_resource", json!({"kind":"settings"}))]))
            .collect(),
    );
    let run = f.start("auto", json!({}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "paused");
    assert!(done.budget.model_requests < 10);
    assert_eq!(f.settings()["premise"], "原设定");
}
#[tokio::test]
async fn a_readonly_subtask_cannot_edit_and_all_its_attempts_use_the_parent_budget() {
    let f = Fixture::new(vec![
        calls(vec![(
            "delegate_readonly",
            json!({"tasks":[{"name":"核对人物","prompt":"只读取人物和设定"}]}),
        )]),
        calls(vec![(
            "stage_edit",
            edit("settings", "", "/premise", json!("越权修改")),
        )]),
        Reply::Answer(Completion {
            text: "核对结束，未修改本局。".into(),
            ..Default::default()
        }),
        finish(),
    ]);
    let run = f.start("auto", json!({}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(f.settings()["premise"], "原设定");
    assert_eq!(done.budget.model_requests, 4);
    assert_eq!(done.budget.tool_calls, 3);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM execution_runs"), 1);
    assert_eq!(
        f.scalar("SELECT COUNT(*) FROM agent_subtasks WHERE status='completed'"),
        1
    );
    assert!(done
        .events
        .iter()
        .any(|e| e.event["name"] == "stage_edit" && e.event["status"] == "failed"));
}
#[tokio::test]
async fn session_fork_and_history_search_never_rewind_formal_story_data() {
    let f = Fixture::new(vec![finish()]);
    let run = f.start("auto", json!({}));
    assert_eq!(f.settled(&run).await.status, "committed");
    let plan = f.store.plan(run["runId"].as_str().unwrap()).unwrap();
    let session = plan.meta["agent"]["sessionId"].as_str().unwrap();
    let message:String=f.store.lock().unwrap().query_row("SELECT id FROM agent_messages WHERE session_id=? AND role='user' ORDER BY rowid LIMIT 1",[session],|r|r.get(0)).unwrap();
    let branch = f
        .engine
        .agent(json!({"op":"fork","sessionId":session,"messageId":message,"title":"另一种思路"}))
        .unwrap();
    assert_eq!(branch["worldChanged"], false);
    f.engine
        .agent(json!({"op":"rename","id":branch["id"],"title":"重新核对"}))
        .unwrap();
    let matches = f
        .engine
        .agent(json!({"op":"search","worldId":"world","lineId":"line","query":"重新核对"}))
        .unwrap();
    assert_eq!(matches["sessions"].as_array().unwrap().len(), 1);
    let other = f
        .engine
        .agent(json!({"op":"search","worldId":"other-world","lineId":"line","query":"重新核对"}))
        .unwrap();
    assert!(other["sessions"].as_array().unwrap().is_empty());
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
}

#[tokio::test]
async fn large_selected_skill_is_read_in_pages_without_repeating_the_whole_document() {
    let f = Fixture::new(vec![
        calls(vec![(
            "read_skill_resource",
            json!({"id":"long-skill","path":"SKILL.md","offset":0,"limit":1200}),
        )]),
        calls(vec![(
            "read_skill_resource",
            json!({"id":"long-skill","path":"SKILL.md","offset":1200,"limit":1200}),
        )]),
        calls(vec![(
            "read_skill_resource",
            json!({"id":"long-skill","path":"SKILL.md","offset":2400,"limit":1200}),
        )]),
        calls(vec![("record_skill_check",json!({"id":"long-skill","status":"completed","summary":"已分段读完技能并核对本次任务；不产生剧情"}))]),
        finish(),
    ]);
    let body = "按需核实。".repeat(720);
    let run=f.start("auto",json!({"inputTokens":12000,"skills":["long-skill"],"customSkills":[{"id":"long-skill","name":"长技能","version":"1","content":body,"files":{"SKILL.md":body}}]}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert!(done.draft["skillsRead"]
        .as_array()
        .unwrap()
        .contains(&json!("long-skill")));
    assert_eq!(
        f.scalar("SELECT COUNT(*) FROM execution_steps WHERE kind='read_skill'"),
        1
    );
    for request in f.fake.requests.lock().unwrap().iter() {
        assert!(
            json!({"messages":request["messages"],"tools":request["tools"]})
                .to_string()
                .encode_utf16()
                .count()
                <= 12000
        );
    }
}

#[tokio::test]
async fn malformed_or_truncated_tool_groups_are_rejected_before_any_staging() {
    for finish_reason in [None, Some("length")] {
        let mut reply = match calls(vec![
            (
                "stage_edit",
                edit("settings", "", "/premise", json!("不得执行")),
            ),
            ("finish_task", json!({"summary":"不得完成"})),
        ]) {
            Reply::Answer(reply) => reply,
            _ => unreachable!(),
        };
        if finish_reason.is_none() {
            reply.tool_calls[1]["function"]["arguments"] = "{\"summary\":".into();
        }
        reply.finish_reason = finish_reason.map(str::to_owned);
        let f = Fixture::new(vec![Reply::Answer(reply)]);
        let run = f.start("auto", json!({}));
        let done = f.settled(&run).await;
        assert_eq!(done.status, "failed");
        assert_eq!(
            f.scalar("SELECT COUNT(*) FROM execution_steps WHERE kind='stage_edit'"),
            0
        );
        assert_eq!(f.settings()["premise"], "原设定");
    }
}

#[tokio::test]
async fn questions_receive_stable_ids_and_terminal_compaction_is_rejected() {
    let f = Fixture::new(vec![
        calls(vec![(
            "ask_user",
            json!({"questions":[{"question":"采用哪一种？","options":[{"label":"保留"}]}]}),
        )]),
        finish(),
    ]);
    let run = f.start("auto", json!({}));
    assert_eq!(f.settled(&run).await.status, "waiting_user");
    let plan = f.store.plan(run["runId"].as_str().unwrap()).unwrap();
    let detail = f
        .engine
        .agent(json!({"op":"session","id":plan.meta["agent"]["sessionId"]}))
        .unwrap();
    let question = &detail["tasks"][0]["question"];
    assert_eq!(question["questions"][0]["id"], "question-1");
    assert_eq!(question["questions"][0]["allowFreeText"], true);
    f.engine.agent(json!({"op":"answer_question","id":"stable-answer","taskId":run["taskId"],"questionId":question["id"],"answers":{"question-1":"自由填写的明确回答"}})).unwrap();
    assert_eq!(f.settled(&run).await.status, "committed");
    assert!(f
        .engine
        .agent(json!({"op":"compact","taskId":run["taskId"]}))
        .is_err());
    assert_eq!(
        f.scalar("SELECT COUNT(*) FROM agent_inputs WHERE delivery='queued'"),
        0
    );
}

#[tokio::test]
async fn child_discovers_original_tools_but_generic_book_reads_keep_the_chapter_limit() {
    let f = Fixture::new(vec![
        calls(vec![(
            "delegate_readonly",
            json!({"tasks":[{"name":"核对原著","prompt":"核对已允许的第一章"}]}),
        )]),
        calls(vec![(
            "discover_tools",
            json!({"names":["search_original","read_original"]}),
        )]),
        calls(vec![
            (
                "read_resource",
                json!({"kind":"book","id":"book","path":"/data/sections"}),
            ),
            ("read_original", json!({"section":0})),
            ("read_original", json!({"section":1})),
        ]),
        Reply::Answer(Completion {
            text: "仅参考第一章；后文不在本次范围。".into(),
            ..Default::default()
        }),
        finish(),
    ]);
    {
        let db = f.store.lock().unwrap();
        let first = "阿青是姐姐；柳夫人是师父。".repeat(350);
        let book = json!({"id":"book","title":"限章资料","format":"txt","sections":[{"title":"第一章","text":first},{"title":"第二章","text":"不可泄露的后文标记"}],"summary":"不可泄露的全书总结"});
        db.execute(
            "INSERT INTO source_books VALUES('book','限章资料','txt','test',?)",
            [book.to_string()],
        )
        .unwrap();
        for (i, text) in [first.as_str(), "不可泄露的后文标记"].iter().enumerate() {
            db.execute(
                "INSERT INTO source_sections VALUES('book',?,? ,NULL)",
                params![i as i64, format!("第{i}章")],
            )
            .unwrap();
            db.execute(
                "INSERT INTO source_chunks VALUES('book',?,?,?)",
                params![i as i64, i as i64, text],
            )
            .unwrap();
        }
        let mut current = state(5);
        current["source"] = json!({"bookId":"book","through":0,"method":"search","position":0});
        db.execute(
            "UPDATE states SET state_json=? WHERE node_id='n2'",
            [current.to_string()],
        )
        .unwrap();
    }
    let run = f.start("auto", json!({"inputTokens":12000}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    let requests = f.fake.requests.lock().unwrap();
    assert!(requests[2]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["function"]["name"] == "search_original"));
    assert!(!requests.iter().any(|r| r.to_string().contains("不可泄露")));
    assert!(requests[3]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["function"]["name"] == "read_tool_result"));
    assert!(
        requests[3]["messages"].as_array().unwrap().iter().any(|m| {
            let value: Value =
                serde_json::from_str(m["content"].as_str().unwrap_or("")).unwrap_or(Value::Null);
            value["_agentTool"] == "read_original"
                && value["excerpts"][0]["text"]
                    .as_str()
                    .is_some_and(|s| s.contains("阿青是姐姐"))
                && value["readPaths"][0]["path"].is_string()
        }),
        "child must receive actual preview plus a reusable locator"
    );
    assert_eq!(done.budget.model_requests, 5);
}

#[tokio::test]
async fn known_model_window_reserves_output_without_changing_the_app_allowance() {
    let f = Fixture::new(vec![finish()]);
    let run=f.start("auto",json!({"inputTokens":20000,"model":{"slot":"isolated-agent","url":"https://fixture.invalid/v1/chat/completions","model":"fake-agent","includeUsage":false,"contextWindowTokens":18000,"maxOutputTokens":1000}}));
    assert_eq!(f.settled(&run).await.status, "committed");
    let requests = f.fake.requests.lock().unwrap();
    assert_eq!(requests[0]["max_tokens"], 1000);
    assert!(
        json!({"messages":requests[0]["messages"],"tools":requests[0]["tools"]})
            .to_string()
            .encode_utf16()
            .count()
            <= 17000
    );
    assert_eq!(
        f.store
            .plan(run["runId"].as_str().unwrap())
            .unwrap()
            .options["contextTokens"],
        20000
    );
}

#[tokio::test]
async fn old_task_keeps_authority_and_reuses_its_recorded_skill_version() {
    let started = Arc::new(Notify::new());
    let f = Fixture::new(vec![Reply::Wait(started.clone())]);
    let run = f.start("auto", json!({}));
    started.notified().await;
    f.engine.stop(run["runId"].as_str().unwrap()).unwrap();
    assert_eq!(f.settled(&run).await.status, "cancelled");
    let mut plan = f.store.plan(run["runId"].as_str().unwrap()).unwrap();
    plan.meta["agent"]
        .as_object_mut()
        .unwrap()
        .remove("allowedTools");
    plan.meta["agent"]
        .as_object_mut()
        .unwrap()
        .remove("skillSnapshots");
    plan.meta["agent"]["promptVersion"] = "agent-task-1.0.0".into();
    {
        let db = f.store.lock().unwrap();
        db.execute(
            "UPDATE execution_runs SET plan_json=? WHERE id=?",
            params![serde_json::to_string(&plan).unwrap(), plan.id],
        )
        .unwrap();
        let saved = json!({"name":"story-writing","requestedId":"story-writing","metadata":{"version":"1.0.0"},"body":"# Old recorded instructions","_agentTool":"read_skill"});
        db.execute("INSERT INTO execution_steps(run_id,step_key,kind,status,input_json,output_json) VALUES(?,'legacy-recorded-skill','read_skill','done','{}',?)",params![plan.id,saved.to_string()]).unwrap();
    }
    f.fake.replies.lock().unwrap().extend([
        calls(vec![("run_script",json!({"source":"return await tools.stage_edit({kind:'settings',path:'/premise',operation:'set',value:'不得升级',summary:'不得升级'})"})),("read_skill",json!({"id":"story-writing"}))]),finish()
    ]);
    f.engine
        .agent(json!({"op":"continue","taskId":run["taskId"]}))
        .unwrap();
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(f.settings()["premise"], "原设定");
    let db = f.store.lock().unwrap();
    let denied: String = db
        .query_row(
            "SELECT output_json FROM execution_steps WHERE kind='run_script'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&denied).unwrap()["isError"],
        true
    );
    let reused:String=db.query_row("SELECT output_json FROM execution_steps WHERE kind='read_skill' ORDER BY rowid DESC LIMIT 1",[],|r|r.get(0)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&reused).unwrap()["metadata"]["version"],
        "1.0.0"
    );
}

#[tokio::test]
async fn clock_adjustment_passes_the_real_tool_gateway_and_commits_without_a_turn() {
    let f = Fixture::new(vec![
        calls(vec![("read_clock", json!({}))]),
        calls(vec![(
            "stage_clock",
            json!({"operation":"display","clockStyle":"era","timeStyle":"24h","anchor":{"atElapsedMinutes":10,"date":{"era":"斗罗","year":2631,"month":5,"day":8,"ceYear":null,"lunar":false},"minuteOfDay":1205},"summary":"只校准日期显示"}),
        )]),
        calls(vec![("validate_changes", json!({}))]),
        finish(),
    ]);
    let run = f.start("auto-reversible", json!({"inputTokens":12000}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    let db = f.store.lock().unwrap();
    let saved:String=db.query_row("SELECT s.state_json FROM states s JOIN lines l ON l.node_id=s.node_id WHERE l.id='line'",[],|r|r.get(0)).unwrap();
    let current: Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(current["time"]["elapsedMinutes"], 10);
    assert_eq!(current["protagonist"]["stats"]["money"], 5);
    assert_eq!(current["era"]["mode"], "free");
    assert_eq!(current["era"]["clockStyle"], "era");
    assert_eq!(current["time"]["anchor"]["minuteOfDay"], 1205);
    assert_eq!(
        db.query_row(
            "SELECT n.seq FROM nodes n JOIN lines l ON l.node_id=n.id WHERE l.id='line'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(db.query_row("SELECT COUNT(*) FROM execution_steps WHERE run_id=? AND kind IN ('read_clock','stage_clock','validate_changes') AND json_extract(output_json,'$.isError') IS NOT 1",[run["runId"].as_str().unwrap()],|r|r.get::<_,i64>(0)).unwrap(),3);
}

#[tokio::test]
async fn resource_locators_book_titles_and_discovery_describe_the_actual_available_tools() {
    let selected = json!([
        "search_original",
        "read_original",
        "stage_edit",
        "stage_clock",
        "stage_story_turn",
        "validate_changes",
        "record_skill_check",
        "search_resources",
        "read_clock"
    ]);
    let f = Fixture::new(vec![
        calls(vec![("discover_tools", json!({"names":selected}))]),
        calls(vec![
            ("search_resources", json!({"kind":"book","query":"青桥传"})),
            ("search_resources", json!({"kind":"world","query":"青桥传"})),
            ("search_resources", json!({"kind":"node","query":"第1回合"})),
        ]),
        calls(vec![
            ("read_original", json!({"bookId":"青桥传","section":0})),
            ("read_original", json!({"bookId":"青桥传","section":1})),
            (
                "search_original",
                json!({"bookId":"未导入的书名","query":"姐姐"}),
            ),
        ]),
        finish(),
    ]);
    {
        let db = f.store.lock().unwrap();
        let book = json!({"id":"actual-book-id","title":"青桥传","format":"txt","sections":[{"title":"第一章","text":"陆青是姐姐；这是读取后才可见的原文。"},{"title":"后文","text":"禁止出现的后文标记"}]});
        db.execute(
            "INSERT INTO source_books VALUES('actual-book-id','青桥传','txt','test',?)",
            [book.to_string()],
        )
        .unwrap();
        for (i, text) in ["陆青是姐姐；这是读取后才可见的原文。", "禁止出现的后文标记"]
            .iter()
            .enumerate()
        {
            db.execute(
                "INSERT INTO source_sections VALUES('actual-book-id',?,?,NULL)",
                params![i as i64, format!("第{i}章")],
            )
            .unwrap();
            db.execute(
                "INSERT INTO source_chunks VALUES('actual-book-id',?,?,?)",
                params![i as i64, i as i64, text],
            )
            .unwrap();
        }
        let mut current = state(5);
        current["time"]["elapsedMinutes"] = 10.into();
        current["source"] =
            json!({"bookId":"actual-book-id","through":0,"position":0,"method":"search"});
        db.execute(
            "UPDATE states SET state_json=? WHERE node_id='n2'",
            [current.to_string()],
        )
        .unwrap();
    }
    let run = f.start("auto", json!({"inputTokens":12000}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    let requests = f.fake.requests.lock().unwrap();
    let first = requests[0].to_string();
    assert!(
        first.contains("actual-book-id")
            && first.contains("青桥传")
            && first.contains("currentHead")
    );
    assert!(!first.contains("这是读取后才可见的原文"));
    assert!(!requests
        .iter()
        .any(|r| r.to_string().contains("禁止出现的后文标记")));
    let db = f.store.lock().unwrap();
    let discover: String = db
        .query_row(
            "SELECT output_json FROM execution_steps WHERE kind='discover_tools'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let discover: Value = serde_json::from_str(&discover).unwrap();
    assert!(!discover["deferred"].as_array().unwrap().is_empty());
    let actual = requests[1]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].clone())
        .collect::<Vec<_>>();
    assert_eq!(discover["enabled"], json!(actual));
    let mut statement=db.prepare("SELECT kind,input_json,output_json FROM execution_steps WHERE kind IN ('search_resources','read_original','search_original') ORDER BY rowid").unwrap();
    let outputs = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .map(|r| {
            let (kind, args, result) = r.unwrap();
            (
                kind,
                serde_json::from_str::<Value>(&args).unwrap(),
                serde_json::from_str::<Value>(&result).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    assert!(outputs
        .iter()
        .any(|(_, a, v)| a["kind"] == "book" && v["matches"][0]["id"] == "actual-book-id"));
    assert!(outputs
        .iter()
        .any(|(_, a, v)| a["kind"] == "world" && v["isError"] == true));
    assert!(outputs.iter().any(|(_, a, v)| a["kind"] == "node"
        && v["matches"][0]["id"] == "n1"
        && v["matches"][0]["seq"] == 1));
    assert!(outputs.iter().any(|(k, a, v)| k == "read_original"
        && a["section"] == 0
        && v["isError"] != true
        && v.to_string().contains("陆青是姐姐")));
    assert!(outputs.iter().any(|(_, a, v)| a["bookId"] == "未导入的书名"
        && v["isError"] == true
        && v["message"]
            .as_str()
            .unwrap_or("")
            .contains("actual-book-id")));
}

#[tokio::test]
async fn a_same_value_stage_cannot_fake_a_completed_modification_or_create_a_route() {
    let f=Fixture::new(vec![
        calls(vec![("stage_edit",edit("settings","","/premise",json!("原设定")))]),
        finish(),finish(),finish(),
    ]);
    let run=f.start("auto-reversible",json!({"text":"请实际修改本局设定"}));
    let done=f.settled(&run).await;
    assert_eq!(done.status,"failed");
    assert!(done.error.as_deref().unwrap_or("").contains("未满足查证或实际修改条件"));
    assert_eq!(f.settings()["premise"],"原设定");
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"),3);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM lines"),2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM agent_tasks WHERE backup_json IS NOT NULL"),0);
    let saved:String=f.store.lock().unwrap().query_row("SELECT workspace_json FROM agent_tasks WHERE id=?",[run["taskId"].as_str().unwrap()],|r|r.get(0)).unwrap();
    let workspace:Value=serde_json::from_str(&saved).unwrap();
    assert!(workspace["edits"].as_array().unwrap().is_empty());
    assert_eq!(workspace["appliedCalls"].as_array().unwrap().len(),1);
}

#[tokio::test]
async fn discarding_a_draft_preserves_formal_data_and_cumulative_usage() {
    let f=Fixture::new(vec![
        calls(vec![("stage_edit",edit("settings","","/premise",json!("撤回的草稿")))]),
        calls(vec![("discard_draft",json!({"all":true}))]),
        calls(vec![("check_draft",json!({"narrative":"只检查已撤回的任务草稿"}))]),
        finish(),
    ]);
    let run=f.start("auto-reversible",json!({}));
    let done=f.settled(&run).await;
    assert_eq!(done.status,"committed","{:?}",done.error);
    assert_eq!(f.settings()["premise"],"原设定");
    assert_eq!(done.result.as_ref().unwrap()["worldChanged"],false);
    assert_eq!(done.budget.model_requests,4);
    assert_eq!(done.budget.tool_calls,4);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"),3);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM lines"),2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM agent_tasks WHERE backup_json IS NOT NULL"),0);
    let db=f.store.lock().unwrap();
    let saved:String=db.query_row("SELECT workspace_json FROM agent_tasks WHERE id=?",[run["taskId"].as_str().unwrap()],|r|r.get(0)).unwrap();
    let workspace:Value=serde_json::from_str(&saved).unwrap();
    assert!(workspace["edits"].as_array().unwrap().is_empty());
    assert_eq!(workspace["appliedCalls"].as_array().unwrap().len(),1);
    let checked:String=db.query_row("SELECT output_json FROM execution_steps WHERE run_id=? AND kind='check_draft'",[run["runId"].as_str().unwrap()],|r|r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&checked).unwrap()["verification"]["requiredEditCallIds"],json!([]));
}

#[tokio::test]
async fn canon_report_binds_actual_edits_and_quotes_before_commit_with_real_chapter_titles() {
    let original_call = "agent-0-call-read_original-1";
    let edit_call = "agent-1-call-stage_edit-0";
    let f = Fixture::new(vec![
        calls(vec![
            ("read_skill", json!({"id":"canon-reference"})),
            ("read_original", json!({"section":211,"chunk":301,"neighbors":0})),
        ]),
        calls(vec![("stage_edit", edit("settings", "", "/premise", json!("陆青是陆白的姐姐，陆白称她为阿姊。")))]),
        calls(vec![("record_skill_check", json!({"id":"canon-reference","status":"completed","summary":"旧式声称已核对全部内容","evidenceCallIds":[original_call]}))]),
        calls(vec![("record_skill_check", json!({"id":"canon-reference","status":"completed","summary":"已逐项核对人物关系与称谓","evidenceCallIds":[original_call],"findings":[{"topic":"人物关系与称谓","claim":"陆青是姐姐，应称阿姊","basis":"original","editCallIds":[edit_call],"citations":[{"callId":original_call,"quote":"陆青是陆白的姐姐。陆白应称她为阿姊。"}]}]}))]),
        finish(),
    ]);
    {
        let db = f.store.lock().unwrap();
        let book = json!({"id":"proof-book","title":"逐项核对短篇","format":"txt","sections":[{"title":"第六十三章 预备队（上）","text":"陆青是陆白的姐姐。陆白应称她为阿姊。"}]});
        db.execute("INSERT INTO source_books VALUES('proof-book','逐项核对短篇','txt','test',?)",[book.to_string()]).unwrap();
        db.execute("INSERT INTO source_sections VALUES('proof-book',211,'第六十三章 预备队（上）',NULL)",[]).unwrap();
        db.execute("INSERT INTO source_chunks VALUES('proof-book',301,211,'陆青是陆白的姐姐。陆白应称她为阿姊。')",[]).unwrap();
        let mut current = state(5);
        current["time"]["elapsedMinutes"] = 10.into();
        current["source"] = json!({"bookId":"proof-book","through":211,"position":211,"method":"search"});
        db.execute("UPDATE states SET state_json=? WHERE node_id='n2'",[current.to_string()]).unwrap();
    }
    let run = f.start("auto-reversible", json!({"text":"请参考原著纠正本局设定中的人物关系和称谓，不凭记忆编造。"}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(f.settings()["premise"], "陆青是陆白的姐姐，陆白称她为阿姊。");
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM execution_steps WHERE kind='record_skill_check' AND json_extract(output_json,'$.isError')=1"), 1);
    let result = done.result.as_ref().unwrap();
    let citation = &result["verification"]["findings"][0]["citations"][0];
    assert_eq!(citation["title"], "第六十三章 预备队（上）");
    assert_eq!(citation["sectionIndex"], 211);
    assert_eq!(citation["chunkIndex"], 301);
    assert_eq!(citation["callId"], original_call);
    assert_eq!(result["verification"]["sourceLocationVerified"], true);
    assert_eq!(result["verification"]["interpretationVerified"], false);
    assert!(result["summary"].as_str().unwrap().contains("人物关系与称谓：第六十三章 预备队（上）"));
    assert!(!result["summary"].as_str().unwrap().contains("第211章"));
}

#[tokio::test]
async fn large_parallel_search_results_can_be_read_progressively_before_a_history_revision() {
    #[derive(Default)]
    struct ReaderState {
        phase: usize,
        read: Value,
        seen: String,
        pages: usize,
        saw_locator: bool,
        reread_page: bool,
        evidence_call: String,
        skill_page_requested: bool,
        skill_read: Value,
        skill_finished: bool,
    }
    #[derive(Default)]
    struct Reader {
        state: Mutex<ReaderState>,
        requests: Mutex<Vec<Value>>,
    }
    impl Model for Reader {
        fn complete(
            &self,
            _: ModelConfig,
            body: Value,
            _: CancellationToken,
            _: TextSink,
        ) -> BoxFuture<Result<Completion>> {
            self.requests.lock().unwrap().push(body.clone());
            if is_compaction(&body) {
                return Box::pin(async {
                    Ok(compact_reply(
                        "按保存的原文定位继续读取，未见关键细节时不得先改稿",
                    ))
                });
            }
            let mut s = self.state.lock().unwrap();
            let counter = s.pages;
            let tool = |name: &str, args: Value| Completion {
                tool_calls: vec![
                    json!({"id":format!("reader-{counter}-{name}"),"type":"function","function":{"name":name,"arguments":args.to_string()}}),
                ],
                ..Default::default()
            };
            let reply = match s.phase {
                0 => {
                    if s.skill_read.is_null() {
                        s.skill_read=json!({"waiting":true});
                        return Box::pin(std::future::ready(Ok(tool("read_skill",json!({"id":"canon-reference"})))));
                    }
                    let supplied=body["messages"].as_array().unwrap().iter().rev().find(|m|m["role"]=="tool").unwrap();
                    s.skill_read=json!({"callId":supplied["tool_call_id"],"path":"/body","offset":0,"limit":24000});
                    assert!(s.skill_read["callId"].is_string(),"follow the actual skill result locator");
                    s.phase = 1;
                    tool(
                        "discover_tools",
                        json!({"names":["search_original","read_original","read_canon_facts","search_resources","validate_changes","record_skill_check"]}),
                    )
                }
                1 => {
                    if !s.skill_page_requested {
                        s.skill_page_requested = true;
                        return Box::pin(std::future::ready(Ok(tool("read_tool_result",s.skill_read.clone()))));
                    }
                    if !s.skill_finished {
                        let page=body["messages"].as_array().unwrap().iter().rev().filter(|m|m["role"]=="tool").filter_map(|m|serde_json::from_str::<Value>(m["content"].as_str()?).ok()).find(|v|v["_agentTool"]=="read_tool_result"&&v["sourceTool"]=="read_skill"&&v["path"]=="/body").unwrap();
                        let next=page["nextOffset"].as_u64().unwrap();
                        let total=page["total"].as_u64().unwrap();
                        if next<total {
                            s.skill_read["offset"]=next.into();
                            s.skill_read["limit"]=600.into();
                            return Box::pin(std::future::ready(Ok(tool("read_tool_result",s.skill_read.clone()))));
                        }
                        s.skill_finished=true;
                    }
                    s.phase = 2;
                    Completion { tool_calls:["柳夫人 师父", "柳夫人", "师父", "药铺 师父"].iter().enumerate().map(|(i,query)| json!({"id":format!("search-{i}"),"type":"function","function":{"name":"search_original","arguments":json!({"query":query}).to_string()}})).collect(), ..Default::default() }
                }
                2 => {
                    assert!(
                        body["tools"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|t| t["function"]["name"] == "read_tool_result"),
                        "reader must be available before another discovery"
                    );
                    let last = body["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .rev()
                        .find(|m| m["role"] == "tool")
                        .unwrap();
                    let result: Value =
                        serde_json::from_str(last["content"].as_str().unwrap()).unwrap();
                    if result["_agentTool"] == "search_original" {
                        s.read = result["readPaths"][0]
                            .as_object()
                            .map(|_| result["readPaths"][0].clone())
                            .unwrap_or_else(|| result["read"].clone());
                        assert!(
                            s.read["callId"].is_string(),
                            "stored result must retain its reader locator"
                        );
                        s.read["path"] = "/excerpts".into();
                        s.read["offset"] = 0.into();
                        s.read["limit"] = 100.into();
                        let reply = tool("read_tool_result", s.read.clone());
                        return Box::pin(async move { Ok(reply) });
                    } else if result["value"][0]["largeItemPath"].is_string() {
                        s.saw_locator = true;
                        s.read = result["value"][0]["read"].clone();
                        assert!(s.read["path"].is_string());
                        assert!(
                            s.read["callId"]
                                .as_str()
                                .is_some_and(|id| id.contains("search-")),
                            "text pointer must retain the original result id"
                        );
                        return Box::pin(std::future::ready(Ok(tool(
                            "read_tool_result",
                            json!({"callId":last["tool_call_id"],"limit":100}),
                        ))));
                    } else if !result["text"].is_string() && result["read"].is_object() {
                        s.reread_page = true;
                        assert_eq!(result["sourceTool"], "search_original");
                        assert_eq!(
                            result["read"], s.read,
                            "paging a stored page keeps its canonical read locator"
                        );
                    } else {
                        assert_eq!(result["_agentTool"], "read_tool_result");
                        if s.pages == 0 {
                            let progress = body["messages"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find_map(|m| {
                                    m["content"]
                                        .as_str()
                                        .and_then(|c| c.strip_prefix("【持久任务状态，来自程序】"))
                                        .and_then(|c| serde_json::from_str::<Value>(c).ok())
                                })
                                .unwrap();
                            assert_ne!(
                                progress["sourceRead"], true,
                                "a large-item locator alone must not satisfy original reading"
                            );
                        }
                        let text = result["text"].as_str().unwrap_or_else(|| {
                            panic!("actual text page, not a keys-only placeholder: {result}")
                        });
                        assert!(!text.is_empty());
                        if text.contains("柳夫人是师父") {
                            s.evidence_call = last["tool_call_id"].as_str().unwrap().into();
                        }
                        s.seen.push_str(text);
                        s.read["offset"] = result["nextOffset"].clone();
                        s.pages += 1;
                    }
                    if s.seen.contains("原著证据：柳夫人是师父。") {
                        s.phase = 3;
                        tool("discover_tools", json!({"names":["stage_edit"]}))
                    } else {
                        let mut read = s.read.clone();
                        read["limit"] = 300.into();
                        tool("read_tool_result", read)
                    }
                }
                3 => {
                    assert!(
                        body["tools"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|t| t["function"]["name"] == "stage_edit"),
                        "focused edit schema must fit beside the permanent reader"
                    );
                    s.phase = 4;
                    tool(
                        "stage_edit",
                        json!({"kind":"node","id":"n1","operation":"merge","value":{"narrative":"你向师父柳夫人行礼。","record":{"time":5,"money":-2,"log":"向师父柳夫人行礼"}},"summary":"依据刚读到的原文更正身份与记录"}),
                    )
                }
                4 => {
                    s.phase = 5;
                    let staged = body["messages"].as_array().unwrap().iter().rev().find(|m|m["role"]=="tool").unwrap();
                    let edit_call = staged["tool_call_id"].as_str().unwrap();
                    assert!(!s.evidence_call.is_empty(),"proof must cite the actual delivered text page");
                    tool(
                        "record_skill_check",
                        json!({"id":"canon-reference","status":"completed","summary":"已分段读到柳夫人为师父的原文，并同步更正正文与记录","evidenceCallIds":[s.evidence_call],"findings":[{"topic":"柳夫人身份","claim":"柳夫人是师父","basis":"original","editCallIds":[edit_call],"citations":[{"callId":s.evidence_call,"quote":"柳夫人是师父。"}]}]}),
                    )
                }
                _ => tool(
                    "finish_task",
                    json!({"summary":"已依据实际读到的原文修订，保留原路线。"}),
                ),
            };
            Box::pin(async move { Ok(reply) })
        }
    }
    let reader = Arc::new(Reader::default());
    let mut f = Fixture::new(vec![]);
    f.engine = Arc::new(Engine::new(
        f.store.clone(),
        reader.clone(),
        Arc::new(|_| Box::new(())),
        Arc::new(|_| {}),
    ));
    {
        let db = f.store.lock().unwrap();
        let first = format!("{}原著证据：柳夫人是师父。", "药铺背景记闻。".repeat(330));
        let second = "柳夫人在药铺解释师父职责与日常往来。".repeat(110);
        let book = json!({"id":"paged-book","title":"分页原著","format":"txt","sections":[{"title":"第一章","text":format!("{first}{second}")}]});
        db.execute(
            "INSERT INTO source_books VALUES('paged-book','分页原著','txt','test',?)",
            [book.to_string()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO source_sections VALUES('paged-book',0,'第一章',NULL)",
            [],
        )
        .unwrap();
        for (id, text) in [first, second].iter().enumerate() {
            db.execute(
                "INSERT INTO source_chunks VALUES('paged-book',?,0,?)",
                params![id as i64, text],
            )
            .unwrap();
        }
        for term in ["柳夫", "夫人", "师父"] {
            db.execute(
                "INSERT INTO source_terms VALUES('paged-book',?,'[0,1]')",
                [term],
            )
            .unwrap();
        }
        let mut current = state(5);
        current["time"]["elapsedMinutes"] = 10.into();
        current["source"] =
            json!({"bookId":"paged-book","through":0,"position":0,"method":"search"});
        db.execute(
            "UPDATE states SET state_json=? WHERE node_id='n2'",
            [current.to_string()],
        )
        .unwrap();
    }
    let run = f.start(
        "auto-reversible",
        json!({"inputTokens":12000,"skills":["canon-reference"]}),
    );
    let done = f.settled(&run).await;
    let reports = {
        let db = f.store.lock().unwrap();
        let mut stmt = db.prepare("SELECT output_json FROM execution_steps WHERE kind='record_skill_check'").unwrap();
        stmt.query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<std::result::Result<Vec<_>,_>>().unwrap()
    };
    assert_eq!(done.status, "committed", "{:?}; reports={reports:?}; skillCoverage={:?}", done.error,done.draft["skillCoverage"]);
    assert_eq!(done.draft["sourceRead"], true);
    assert!(reader.state.lock().unwrap().pages >= 2);
    assert!(reader.state.lock().unwrap().saw_locator);
    assert!(reader.state.lock().unwrap().reread_page);
    let db = f.store.lock().unwrap();
    let size: i64 = db
        .query_row(
            "SELECT length(output_json) FROM execution_steps WHERE kind='search_original'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(size > 3000, "must exercise stored large search output");
    let revised:String=db.query_row("WITH RECURSIVE p AS (SELECT n.* FROM nodes n JOIN lines l ON l.node_id=n.id WHERE l.id='line' UNION ALL SELECT n.* FROM nodes n JOIN p ON p.parent_id=n.id) SELECT narrative FROM p WHERE seq=1",[],|r|r.get(0)).unwrap();
    assert!(revised.contains("师父柳夫人"));
    assert!(reader.requests.lock().unwrap().iter().all(|r| {
        json!({"messages":r["messages"],"tools":r["tools"]})
            .to_string()
            .encode_utf16()
            .count()
            <= 12000
    }));
}

#[tokio::test]
async fn stopped_script_is_sealed_for_replanning_instead_of_replaying_its_source() {
    let f = Fixture::new(vec![
        calls(vec![(
            "run_script",
            json!({"source":"await tools.stage_edit({kind:'settings',path:'/premise',operation:'set',value:'中断前已暂存',summary:'保留已完成步骤'});while(true){}"}),
        )]),
        finish(),
    ]);
    let run = f.start("auto", json!({}));
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if f.scalar(
                "SELECT COUNT(*) FROM execution_steps WHERE kind='stage_edit' AND status='done'",
            ) > 0
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    f.engine.stop(run["runId"].as_str().unwrap()).unwrap();
    assert_eq!(f.settled(&run).await.status, "cancelled");
    assert_eq!(f.settings()["premise"], "原设定");
    f.engine
        .agent(json!({"op":"continue","taskId":run["taskId"]}))
        .unwrap();
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(
        f.scalar("SELECT COUNT(*) FROM execution_steps WHERE kind='run_script'"),
        1
    );
    assert_eq!(
        f.scalar("SELECT COUNT(*) FROM execution_steps WHERE kind='stage_edit'"),
        1
    );
    assert_eq!(f.settings()["premise"], "中断前已暂存");
    let saved: String = f
        .store
        .lock()
        .unwrap()
        .query_row(
            "SELECT output_json FROM execution_steps WHERE kind='run_script'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let saved: Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(saved["interruptedScript"], true);
    assert_eq!(saved["replayBlocked"], true);
    assert_eq!(saved["completedSteps"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn selected_skills_need_a_nonempty_execution_report_before_new_tasks_finish() {
    let f = Fixture::new(vec![
        finish(),
        calls(vec![(
            "record_skill_check",
            json!({"id":"story-writing","status":"not_applicable","summary":"  "}),
        )]),
        finish(),
        calls(vec![(
            "record_skill_check",
            json!({"id":"story-writing","status":"not_applicable","summary":"本次只分析设置，不产生正式剧情"}),
        )]),
        finish(),
    ]);
    let run = f.start(
        "auto",
        json!({"skills":["story-writing"],"inputTokens":12000}),
    );
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(done.draft["skillChecks"][0]["status"], "not_applicable");
    assert_eq!(f.scalar("SELECT COUNT(*) FROM execution_steps WHERE kind='finish_task' AND json_extract(output_json,'$.isError')=1"), 2);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM execution_steps WHERE kind='record_skill_check' AND json_extract(output_json,'$.isError')=1"), 1);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM nodes"), 3);
}

#[tokio::test]
async fn a_book_title_edit_validation_does_not_reveal_excluded_chapters_or_summaries() {
    let f = Fixture::new(vec![
        calls(vec![(
            "stage_edit",
            edit("book", "scoped-book", "/title", json!("局内修订名")),
        )]),
        calls(vec![
            ("validate_changes", json!({})),
            (
                "read_resource",
                json!({"kind":"book","id":"scoped-book","path":"/data","limit":12000}),
            ),
        ]),
        finish(),
    ]);
    let original = json!({"id":"scoped-book","title":"原书","format":"txt","sections":[{"title":"第一章","text":"当前可读原文"},{"title":"第二章","text":"不可泄露_后文秘密"}],"summary":"不可泄露_全书总结"});
    {
        let db = f.store.lock().unwrap();
        db.execute(
            "INSERT INTO source_books VALUES('scoped-book','原书','txt','test',?)",
            [original.to_string()],
        )
        .unwrap();
        for (section, text) in ["当前可读原文", "不可泄露_后文秘密"]
            .into_iter()
            .enumerate()
        {
            db.execute(
                "INSERT INTO source_sections VALUES('scoped-book',?,?,NULL)",
                params![section as i64, format!("章{section}")],
            )
            .unwrap();
            db.execute(
                "INSERT INTO source_chunks VALUES('scoped-book',?,?,?)",
                params![section as i64, section as i64, text],
            )
            .unwrap();
        }
        let mut current = state(5);
        current["time"]["elapsedMinutes"] = 10.into();
        current["source"] =
            json!({"bookId":"scoped-book","through":0,"position":0,"method":"search"});
        db.execute(
            "UPDATE states SET state_json=? WHERE node_id='n2'",
            [current.to_string()],
        )
        .unwrap();
    }
    let run = f.start("preview", json!({"inputTokens":24000}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "previewed", "{:?}", done.error);
    assert!(f
        .fake
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|r| !r.to_string().contains("不可泄露")));
    let db = f.store.lock().unwrap();
    let validation: String = db
        .query_row(
            "SELECT output_json FROM execution_steps WHERE kind='validate_changes'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!validation.contains("不可泄露"));
    assert!(validation.contains("当前可读原文"));
    let saved: String = db
        .query_row(
            "SELECT workspace_json FROM agent_tasks WHERE id=?",
            [run["taskId"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        saved.contains("不可泄露_后文秘密"),
        "internal version must retain the untouched book"
    );
    assert_eq!(
        db.query_row(
            "SELECT json FROM source_books WHERE id='scoped-book'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        original.to_string()
    );
    drop(db);
    assert_eq!(f.scalar("SELECT COUNT(*) FROM source_books"), 1);
}

#[tokio::test]
async fn small_tool_facts_remain_readable_and_do_not_expand_into_resource_markers() {
    let f = Fixture::new(vec![
        calls(vec![("read_clock", json!({}))]),
        calls(vec![("read_resource", json!({"kind":"protagonist"}))]),
        calls(vec![("read_resource", json!({"kind":"settings"}))]),
        finish(),
    ]);
    let run = f.start("auto", json!({"inputTokens":12000}));
    assert_eq!(f.settled(&run).await.status, "committed");
    let requests = f.fake.requests.lock().unwrap();
    for tool in ["read_clock", "read_resource"] {
        let original = requests
            .iter()
            .flat_map(|r| r["messages"].as_array().unwrap())
            .find(|m| {
                m["role"] == "tool"
                    && serde_json::from_str::<Value>(m["content"].as_str().unwrap_or(""))
                        .unwrap_or(Value::Null)["_agentTool"]
                        == tool
            })
            .unwrap();
        let id = original["tool_call_id"].clone();
        let retained = requests.last().unwrap()["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["tool_call_id"] == id)
            .unwrap();
        assert_eq!(
            retained["content"], original["content"],
            "small {tool} facts must remain unchanged"
        );
        let value: Value = serde_json::from_str(retained["content"].as_str().unwrap()).unwrap();
        assert_ne!(value["stored"], true, "not a keys-only resource marker");
        if tool == "read_resource" {
            assert_eq!(value["value"]["age"], 20);
        }
    }
}

#[tokio::test]
async fn a_projected_resource_text_page_can_follow_its_exact_read_parameters() {
    struct TextReader {
        phase: Mutex<usize>,
        read: Mutex<Value>,
        original: String,
    }
    impl Model for TextReader {
        fn complete(
            &self,
            _: ModelConfig,
            body: Value,
            _: CancellationToken,
            _: TextSink,
        ) -> BoxFuture<Result<Completion>> {
            let mut phase = self.phase.lock().unwrap();
            let (name, args) = match *phase {
                0 => (
                    "read_resource",
                    json!({"kind":"node","id":"n1","path":"/narrative","limit":24000}),
                ),
                1 => {
                    let last = body["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .rev()
                        .find(|m| m["role"] == "tool")
                        .unwrap();
                    let page: Value =
                        serde_json::from_str(last["content"].as_str().unwrap()).unwrap();
                    assert_eq!(page["readTool"], "read_resource");
                    assert_eq!(page["read"]["kind"], "node");
                    assert_eq!(page["read"]["id"], "n1");
                    assert_eq!(page["read"]["path"], "/narrative");
                    assert!(
                        page["read"]["callId"].is_null(),
                        "resource path must not be paired with a tool result id"
                    );
                    assert!(page["read"]["offset"].as_u64().unwrap() > 0);
                    *self.read.lock().unwrap() = page["read"].clone();
                    ("read_resource", page["read"].clone())
                }
                _ => {
                    let last = body["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .rev()
                        .find(|m| m["role"] == "tool")
                        .unwrap();
                    let page: Value =
                        serde_json::from_str(last["content"].as_str().unwrap()).unwrap();
                    assert_ne!(page["isError"], true);
                    let offset = self.read.lock().unwrap()["offset"].as_u64().unwrap() as usize;
                    let text = page["text"].as_str().unwrap();
                    assert!(!text.is_empty());
                    assert_eq!(
                        text,
                        self.original
                            .chars()
                            .skip(offset)
                            .take(text.chars().count())
                            .collect::<String>()
                    );
                    (
                        "finish_task",
                        json!({"summary":"已按准确定位读取下一页，没有猜测路径"}),
                    )
                }
            };
            *phase += 1;
            let completion = Completion {
                tool_calls: vec![
                    json!({"id":format!("text-page-{phase}"),"type":"function","function":{"name":name,"arguments":args.to_string()}}),
                ],
                ..Default::default()
            };
            Box::pin(std::future::ready(Ok(completion)))
        }
    }
    let original = (0..800)
        .map(|n| format!("第{n}行：正文\"\\🧭。\n"))
        .collect::<String>();
    let mut f = Fixture::new(vec![]);
    f.store
        .lock()
        .unwrap()
        .execute("UPDATE nodes SET narrative=? WHERE id='n1'", [&original])
        .unwrap();
    f.engine = Arc::new(Engine::new(
        f.store.clone(),
        Arc::new(TextReader {
            phase: Mutex::new(0),
            read: Mutex::new(Value::Null),
            original,
        }),
        Arc::new(|_| Box::new(())),
        Arc::new(|_| {}),
    ));
    let run = f.start("auto", json!({"inputTokens":12000}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    assert_eq!(done.budget.model_requests, 3);
}

#[tokio::test]
async fn large_array_locators_advance_and_each_returned_reader_reaches_its_chapter() {
    #[derive(Default)]
    struct Pages {
        phase: usize,
        root: String,
        cursor: u64,
        readers: Vec<Value>,
        body: usize,
        text: String,
    }
    #[derive(Default)]
    struct ArrayReader(Mutex<Pages>);
    impl Model for ArrayReader {
        fn complete(
            &self,
            _: ModelConfig,
            body: Value,
            _: CancellationToken,
            _: TextSink,
        ) -> BoxFuture<Result<Completion>> {
            if is_compaction(&body) {
                return Box::pin(std::future::ready(Ok(compact_reply(
                    "按nextOffset遍历目录，按完整read独立读取正文",
                ))));
            }
            let mut s = self.0.lock().unwrap();
            let last = || {
                body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .rev()
                    .find(|m| m["role"] == "tool")
                    .unwrap()
            };
            let (name, args) = match s.phase {
                0 => {
                    s.phase = 1;
                    ("search_original", json!({"query":"柳夫人 师父"}))
                }
                1 => {
                    s.root = last()["tool_call_id"].as_str().unwrap().into();
                    s.phase = 2;
                    (
                        "read_tool_result",
                        json!({"callId":s.root,"path":"/excerpts","offset":s.cursor,"limit":1}),
                    )
                }
                2 => {
                    let page: Value =
                        serde_json::from_str(last()["content"].as_str().unwrap()).unwrap();
                    let next = page["nextOffset"]
                        .as_u64()
                        .expect("metadata page must retain its next offset");
                    assert!(
                        next > s.cursor,
                        "a returned locator consumes its array position"
                    );
                    s.cursor = next;
                    let read = page["value"][0]["read"].clone();
                    assert_eq!(read["callId"], s.root);
                    assert!(read["path"].as_str().unwrap().ends_with("/text"));
                    s.readers.push(read);
                    if next < page["total"].as_u64().unwrap() {
                        (
                            "read_tool_result",
                            json!({"callId":s.root,"path":"/excerpts","offset":next,"limit":1}),
                        )
                    } else {
                        let progress = body["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find_map(|m| {
                                m["content"]
                                    .as_str()
                                    .and_then(|t| t.strip_prefix("【持久任务状态，来自程序】"))
                                    .and_then(|t| serde_json::from_str::<Value>(t).ok())
                            })
                            .unwrap();
                        assert_ne!(
                            progress["sourceRead"], true,
                            "two metadata locators do not count as reading original prose"
                        );
                        s.phase = 3;
                        ("read_tool_result", s.readers[0].clone())
                    }
                }
                _ => {
                    let page: Value =
                        serde_json::from_str(last()["content"].as_str().unwrap()).unwrap();
                    let text = page["text"]
                        .as_str()
                        .expect("returned read parameters must deliver prose");
                    s.text.push_str(text);
                    s.body += 1;
                    if s.body < s.readers.len() {
                        ("read_tool_result", s.readers[s.body].clone())
                    } else {
                        (
                            "finish_task",
                            json!({"summary":"两章已按目录逐项读取，定位不跳项"}),
                        )
                    }
                }
            };
            let completion = Completion {
                tool_calls: vec![
                    json!({"id":format!("array-{}-{}-{}",s.phase,s.cursor,s.body),"type":"function","function":{"name":name,"arguments":args.to_string()}}),
                ],
                ..Default::default()
            };
            Box::pin(std::future::ready(Ok(completion)))
        }
    }
    let reader = Arc::new(ArrayReader::default());
    let mut f = Fixture::new(vec![]);
    f.engine = Arc::new(Engine::new(
        f.store.clone(),
        reader.clone(),
        Arc::new(|_| Box::new(())),
        Arc::new(|_| {}),
    ));
    {
        let db = f.store.lock().unwrap();
        let texts = [
            format!(
                "柳夫人是师父。第一章事实：钥匙在灯座。{}",
                "药铺背景。".repeat(500)
            ),
            format!(
                "柳夫人是师父。第二章事实：钥匙移入竹匣。{}",
                "桥头背景。".repeat(500)
            ),
        ];
        let book = json!({"id":"two-chapters","title":"两章原著","format":"txt","sections":texts.iter().enumerate().map(|(i,text)|json!({"title":format!("第{}章",i+1),"text":text})).collect::<Vec<_>>()});
        db.execute(
            "INSERT INTO source_books VALUES('two-chapters','两章原著','txt','test',?)",
            [book.to_string()],
        )
        .unwrap();
        for (i, text) in texts.iter().enumerate() {
            db.execute(
                "INSERT INTO source_sections VALUES('two-chapters',?,?,NULL)",
                params![i as i64, format!("章{i}")],
            )
            .unwrap();
            db.execute(
                "INSERT INTO source_chunks VALUES('two-chapters',?,?,?)",
                params![i as i64, i as i64, text],
            )
            .unwrap();
        }
        for term in ["柳夫", "夫人", "师父"] {
            db.execute(
                "INSERT INTO source_terms VALUES('two-chapters',?,'[0,1]')",
                [term],
            )
            .unwrap();
        }
        let mut current = state(5);
        current["time"]["elapsedMinutes"] = 10.into();
        current["source"] =
            json!({"bookId":"two-chapters","through":1,"position":1,"method":"search"});
        db.execute(
            "UPDATE states SET state_json=? WHERE node_id='n2'",
            [current.to_string()],
        )
        .unwrap();
    }
    let run = f.start("auto", json!({"inputTokens":12000}));
    let done = f.settled(&run).await;
    assert_eq!(done.status, "committed", "{:?}", done.error);
    let pages = reader.0.lock().unwrap();
    assert_eq!(pages.cursor, 2);
    assert_eq!(pages.readers.len(), 2);
    assert!(pages.text.contains("第一章事实：钥匙在灯座"));
    assert!(pages.text.contains("第二章事实：钥匙移入竹匣"));
    assert_eq!(done.draft["sourceRead"], true);
}
