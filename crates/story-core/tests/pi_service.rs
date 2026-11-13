//! Service ownership checks with an in-memory protocol peer; no model calls.
use pi_host::{AgentConnection, TransportOptions};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use story_core::{pi_service::AgentHostService, Store};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

struct Peer {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
}
impl Peer {
    async fn read(&mut self) -> Value {
        let mut line = String::new();
        assert!(self.reader.read_line(&mut line).await.unwrap() > 0);
        serde_json::from_str(&line).unwrap()
    }
    async fn reply(&mut self, request: &Value, data: Value) {
        let mut bytes = serde_json::to_vec(
            &json!({"type":"response","id":request["id"],"ok":true,"data":data}),
        )
        .unwrap();
        bytes.push(b'\n');
        self.writer.write_all(&bytes).await.unwrap();
    }
    async fn event(&mut self, task: &str, role: &str, value: &str) {
        let mut bytes=serde_json::to_vec(&json!({"type":"event","sessionId":"pi-continued","taskId":task,"event":{"type":"message_start","message":{"role":role,"content":[{"type":"text","text":value}]}}})).unwrap();
        bytes.push(b'\n');
        self.writer.write_all(&bytes).await.unwrap();
    }
    async fn finish(&mut self, task: &str, id: &str) -> Value {
        let mut bytes=serde_json::to_vec(&json!({"type":"tool_request","requestId":id,"sessionId":"pi-continued","taskId":task,"toolCallId":id,"name":"finish_task","args":{"summary":"已核对，无需修改","outcome":"no_changes_needed"}})).unwrap();
        bytes.push(b'\n');
        self.writer.write_all(&bytes).await.unwrap();
        let result = self.read().await;
        assert_eq!(result["method"], "tool_result");
        result["params"]["result"].clone()
    }
    async fn one_task(&mut self, index: usize) {
        let create = self.read().await;
        assert_eq!(create["method"], "create");
        assert_eq!(
            create["params"]["model"]["apiKey"],
            "OWNED-SERVICE-MEMORY-KEY"
        );
        let directory = std::path::PathBuf::from(create["params"]["directory"].as_str().unwrap());
        self.reply(&create,json!({"sessionId":format!("pi-{index}"),"sessionFile":directory.join("sessions/owned.jsonl")})).await;
        let prompt = self.read().await;
        assert_eq!(prompt["method"], "prompt");
        self.reply(&prompt, json!({"text":"只完成独立协议往返，没有正式修改"}))
            .await;
        let close = self.read().await;
        assert_eq!(close["method"], "close");
        self.reply(&close, Value::Null).await;
    }
    async fn eof(&mut self) {
        let mut line = String::new();
        assert_eq!(self.reader.read_line(&mut line).await.unwrap(), 0);
    }
}
struct Fixture {
    _directory: tempfile::TempDir,
    store: Store,
    service: AgentHostService,
    connection: AgentConnection,
    activity: Arc<Mutex<Vec<bool>>>,
    resolved: Arc<AtomicUsize>,
}
impl Fixture {
    fn new() -> (Self, Peer) {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        story_core::migration::migrate(&mut db, None).unwrap();
        db.execute_batch("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('world','隔离','free','line','{}','test','test','test');INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('node','world',0,'opening','独立正文','test');INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('line','world','主线','node','test');INSERT INTO settings(key,value) VALUES('ordinary:model','\"ordinary-original\"')").unwrap();
        db.execute("INSERT INTO states VALUES('node',?)",[json!({"version":2,"time":{"start":"第一天","startHour":8,"elapsedMinutes":0},"protagonist":{"name":"旅人","age":20,"stats":{"money":10,"debt":0,"health":100,"energy":100,"fame":0},"items":[],"statuses":[]},"people":[],"places":[],"cards":[],"goals":[],"facts":[],"era":{"mode":"free","clockStyle":"elapsed"},"deviations":[]}).to_string()]).unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        let (native, peer) = tokio::io::duplex(32768);
        let (read, write) = tokio::io::split(native);
        let (connection, incoming) =
            AgentConnection::attach(read, write, TransportOptions::default()).unwrap();
        let activity = Arc::new(Mutex::new(Vec::new()));
        let activity_copy = activity.clone();
        let resolved = Arc::new(AtomicUsize::new(0));
        let counter = resolved.clone();
        let directory = tempfile::tempdir().unwrap();
        let service=AgentHostService::new(store.clone(),connection.clone(),incoming,directory.path().to_path_buf(),Arc::new(move|reference|{
            assert!(reference["apiKey"].is_null()&&reference["url"].is_null()&&reference["baseUrl"].is_null()&&reference["headers"].is_null());
            counter.fetch_add(1,Ordering::SeqCst);
            Ok(json!({"id":"resolved-agent-model","protocol":"chat-completions","baseUrl":"https://fixture.invalid/v1","apiKey":"OWNED-SERVICE-MEMORY-KEY","inputTokens":12000,"contextWindowTokens":20000,"maxOutputTokens":1024}))
        }),Arc::new(move|active|activity_copy.lock().unwrap().push(active)),Arc::new(|_|{})).unwrap();
        let (read, write) = tokio::io::split(peer);
        (
            Self {
                _directory: directory,
                store,
                service,
                connection,
                activity,
                resolved,
            },
            Peer {
                reader: BufReader::new(read),
                writer: write,
            },
        )
    }
    async fn session(&self) -> String {
        self.service
            .request(json!({"op":"create","worldId":"world","lineId":"line"}))
            .await
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    async fn start(&self, session: &str) -> Value { self.start_with(session, true).await }
    /// An editing task: a reply without finish_task leaves it interrupted, which
    /// the compact/continue tests need. A read-only reply may finish implicitly (R26).
    async fn start_editing(&self, session: &str) -> Value { self.start_with(session, false).await }
    async fn start_with(&self, session: &str, read_only: bool) -> Value {
        self.service.request(json!({"op":"start","sessionId":session,"text":"只读取本局资料","readOnly":read_only,"model":{"slot":"agent-slot","model":"requested-agent","apiKey":"UNTRUSTED-UI-KEY","url":"https://untrusted.invalid/v1","headers":{"Authorization":"UNTRUSTED-UI-KEY"}}})).await.unwrap()
    }
    async fn idle(&self) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while self.service.active_task().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("service protocol must not deadlock")
}

#[tokio::test]
async fn manual_compact_reopens_pi_without_prompt_or_resetting_requirements_drafts_and_usage() {
    let(f,mut peer)=Fixture::new();
    let peer_task=tokio::spawn(async move {
        peer.one_task(1).await;
        for index in 1..=2 {
            let create=peer.read().await;assert_eq!(create["method"],"create");assert!(create["params"]["sessionFile"].is_string());
            let directory=std::path::PathBuf::from(create["params"]["directory"].as_str().unwrap());
            peer.reply(&create,json!({"sessionId":"pi-continued","sessionFile":directory.join("sessions/owned.jsonl")})).await;
            let compact=peer.read().await;assert_eq!(compact["method"],"compact","manual control must not replay the original prompt");
            assert_eq!(compact["params"]["instructions"],"保留原始要求和证据定位");
            peer.reply(&compact,json!({"firstKeptEntryId":format!("owned-cut-{index}"),"tokensBefore":1200,"summaryChars":30,"messageCount":4})).await;
            let close=peer.read().await;assert_eq!(close["method"],"close");peer.reply(&close,Value::Null).await;
        }
        peer.eof().await;
    });
    let session=f.session().await;let first=bounded(f.start_editing(&session)).await;f.idle().await;let id=first["taskId"].as_str().unwrap();
    let draft=json!({"edits":[{"kind":"settings","id":"","before":{},"after":{"premise":"未采用草稿"},"summary":"尚未核对"}]});
    {
        let db=f.store.lock().unwrap();
        db.execute("UPDATE pi_tasks SET workspace_json=?,intent_revision=1 WHERE id=?",rusqlite::params![draft.to_string(),id]).unwrap();
        db.execute("INSERT INTO pi_inputs(id,session_id,task_id,seq,delivery,status,content_json,intent_revision,created_at) VALUES('owned-pending',?,?,1,'steer','pending','{\"text\":\"保留玩家分支\",\"nonce\":\"owned-nonce\"}',1,'test')",rusqlite::params![session,id]).unwrap();
        db.execute("INSERT INTO pi_model_requests(task_id,request_id,source,model_json,status,usage_json,started_at,finished_at) VALUES(?,'owned-earlier','model','{}','success','{\"input\":123,\"output\":7}','test','test')",[id]).unwrap();
    }
    for index in 1..=2 {
        let accepted=bounded(f.service.request(json!({"op":"compact","taskId":id,"instructions":"保留原始要求和证据定位"}))).await.unwrap();
        assert_eq!(accepted["taskId"],id);f.idle().await;
        let snapshot=f.service.snapshot(id,0,100).unwrap();assert_eq!(snapshot["status"],"paused");
        assert_eq!(snapshot["task"]["contextCheckpoint"]["firstKeptEntryId"],format!("owned-cut-{index}"));
        assert_eq!(snapshot["task"]["contextCheckpoint"]["consumedIntentRevision"],0);
        assert_eq!(snapshot["task"]["contextCheckpoint"]["latestIntentRevision"],1);
        let db=f.store.lock().unwrap();
        let(row,work):(String,String)=db.query_row("SELECT text,workspace_json FROM pi_tasks WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(row,"只读取本局资料");assert_eq!(serde_json::from_str::<Value>(&work).unwrap(),draft);
        assert_eq!(db.query_row("SELECT status FROM pi_inputs WHERE id='owned-pending'",[],|r|r.get::<_,String>(0)).unwrap(),"pending");
        assert_eq!(db.query_row("SELECT SUM(json_extract(usage_json,'$.input')) FROM pi_model_requests WHERE task_id=?",[id],|r|r.get::<_,i64>(0)).unwrap(),123);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM nodes",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(db.query_row("SELECT settings_json FROM worlds WHERE id='world'",[],|r|r.get::<_,String>(0)).unwrap(),"{}");
    }
    f.service.shutdown().await.unwrap();bounded(peer_task).await.unwrap();
}

#[tokio::test]
async fn one_connection_runs_two_owned_tasks_and_resolver_never_rebinds_ordinary_model() {
    let (f, mut peer) = Fixture::new();
    let peer_task = tokio::spawn(async move {
        peer.one_task(1).await;
        peer.one_task(2).await;
        peer.eof().await;
    });
    let session = f.session().await;
    let first = bounded(f.start(&session)).await;
    f.idle().await;
    assert!(!f.connection.is_closed());
    let second = bounded(f.start(&session)).await;
    f.idle().await;
    assert_ne!(first["taskId"], second["taskId"]);
    assert_eq!(f.resolved.load(Ordering::SeqCst), 2);
    assert_eq!(*f.activity.lock().unwrap(), vec![true, false, true, false]);
    let db = f.store.lock().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT value FROM settings WHERE key='ordinary:model'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "\"ordinary-original\""
    );
    let mut rows = db
        .prepare("SELECT model_json,metadata_json FROM pi_tasks")
        .unwrap();
    for row in rows
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .unwrap()
    {
        let (model, metadata) = row.unwrap();
        assert!(
            !model.contains("UNTRUSTED")
                && !model.contains("OWNED-SERVICE-MEMORY-KEY")
                && !metadata.contains("OWNED-SERVICE-MEMORY-KEY")
        );
    }
    drop(rows);
    drop(db);
    bounded(f.service.shutdown()).await.unwrap();
    bounded(peer_task).await.unwrap();
    assert!(f.service.request(json!({"op":"list","worldId":"world","lineId":"line"})).await.is_ok(),"closing still permits durable control/status reads");
    assert!(f.service.request(json!({"op":"start","sessionId":session,"text":"closed"})).await.is_err());
}

#[tokio::test]
async fn legacy_task_cannot_continue_or_fall_back_to_old_engine() {
    let (f, mut peer) = Fixture::new();
    f.store.lock().unwrap().execute_batch("INSERT INTO agent_sessions VALUES('legacy-session','world','line','旧助手','test','test');INSERT INTO agent_tasks(id,session_id,run_id,text,policy,status,base_json,created_at,updated_at) VALUES('legacy-task','legacy-session','legacy-run','旧任务','auto-reversible','failed','{}','test','test')").unwrap();
    assert!(f
        .service
        .request(json!({"op":"continue","taskId":"legacy-task"}))
        .await
        .is_err());
    assert_eq!(f.resolved.load(Ordering::SeqCst), 0);
    assert_eq!(
        f.store
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM pi_tasks", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(f
        .service
        .request(json!({"op":"enqueue_input","taskId":"legacy-task","text":"继续"}))
        .await
        .is_err());
    bounded(f.service.shutdown()).await.unwrap();
    peer.eof().await;
}

#[tokio::test]
async fn continue_saves_corrections_and_replays_unconsumed_inputs_in_order() {
    let (f, mut peer) = Fixture::new();
    f.service.set_model_http(Arc::new(|_,_,_,_|Box::pin(async {panic!("this fixture must not send HTTP")}))).unwrap();
    let peer_task = tokio::spawn(async move {
        peer.one_task(1).await; // An ended answer without a receipt is interrupted.
        let create = peer.read().await;
        assert_eq!(create["method"], "create");
        assert!(create["params"]["sessionFile"].is_string());
        let directory = std::path::PathBuf::from(create["params"]["directory"].as_str().unwrap());
        peer.reply(&create,json!({"sessionId":"pi-continued","sessionFile":directory.join("sessions/owned.jsonl")})).await;
        let first = peer.read().await;
        assert_eq!(first["method"], "steer");
        let old = first["params"]["text"].as_str().unwrap().to_string();
        assert!(old.ends_with("保留已经改变的剧情"));
        peer.reply(&first, Value::Null).await;
        let second = peer.read().await;
        assert_eq!(second["method"], "steer");
        let correction = second["params"]["text"].as_str().unwrap().to_string();
        assert!(correction.ends_with("只核对人物关系"));
        peer.reply(&second, Value::Null).await;
        let prompt = peer.read().await;
        assert_eq!(prompt["method"], "prompt");
        assert_eq!(prompt["params"]["text"], "只读取本局资料");
        let task = prompt["params"]["taskId"].as_str().unwrap();
        assert_eq!(peer.finish(task, "before-inputs").await["ok"], false);
        peer.event(task, "assistant", &correction).await;
        assert_eq!(peer.finish(task, "assistant-echo").await["ok"], false);
        peer.event(task, "user", &old).await;
        assert_eq!(peer.finish(task, "before-correction").await["ok"], false);
        peer.event(task, "user", &correction).await;
        let finish = peer.finish(task, "after-inputs").await;
        assert_eq!(finish["ok"], true, "{finish}");
        peer.reply(&prompt, json!({"text":"已按两项补充核对"}))
            .await;
        let close = peer.read().await;
        assert_eq!(close["method"], "close");
        peer.reply(&close, Value::Null).await;
        peer.eof().await;
    });
    let session = f.session().await;
    let first = bounded(f.start_editing(&session)).await;
    f.idle().await;
    let id = first["taskId"].as_str().unwrap();
    // Simulate a supplement saved before the old host stopped, never consumed.
    {
        let db = f.store.lock().unwrap();
        db.execute("UPDATE pi_tasks SET intent_revision=1 WHERE id=?", [id])
            .unwrap();
        db.execute("INSERT INTO pi_inputs(id,session_id,task_id,seq,delivery,content_json,intent_revision,created_at) VALUES('owned-old-input',?,?,1,'steer',?,1,'test')",rusqlite::params![session,id,json!({"text":"保留已经改变的剧情","nonce":"OWNED-PERSISTED-NONCE"}).to_string()]).unwrap();
        db.execute("INSERT INTO pi_model_requests(task_id,request_id,source,model_json,status,usage_json,started_at,finished_at) VALUES(?,'owned-earlier-request','model','{}','success','{\"input\":123,\"output\":7}','test','test')",[id]).unwrap();
    }
    let continued = bounded(
        f.service
            .request(json!({"op":"continue","taskId":id,"text":"只核对人物关系","limits":{"modelRequests":2,"toolCalls":20,"activeMs":0},"model":{"inputTokens":24000}})),
    )
    .await
    .unwrap();
    assert_eq!(continued["taskId"], id);
    f.idle().await;
    let snapshot = f.service.snapshot(id, 0, 100).unwrap();
    assert_eq!(snapshot["status"], "completed");
    assert_eq!(snapshot["task"]["limits"]["modelRequests"],2,"the explicitly continued cap must be visible");
    assert_eq!(snapshot["task"]["model"]["inputTokens"],24000);
    assert_eq!(snapshot["task"]["budget"]["modelRequests"],1,"continuing cannot reset earlier paid attempts");
    assert_eq!(snapshot["task"]["budget"]["usage"]["input"],123);
    {
        let db = f.store.lock().unwrap();
        let revisions: (i64, i64) = db
            .query_row(
                "SELECT intent_revision,consumed_intent_revision FROM pi_tasks WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(revisions, (2, 2));
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM pi_inputs WHERE task_id=? AND status='delivered'",
                [id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    bounded(f.service.shutdown()).await.unwrap();
    bounded(peer_task).await.unwrap();
}

#[tokio::test]
async fn dropped_start_waiter_keeps_service_task_until_confirmed_stop() {
    let (f, mut peer) = Fixture::new();
    let (creating_send, creating) = tokio::sync::oneshot::channel();
    let (release_send, release) = tokio::sync::oneshot::channel();
    let (prompting_send, prompting) = tokio::sync::oneshot::channel();
    let peer_task = tokio::spawn(async move {
        let create = peer.read().await;
        assert_eq!(create["method"], "create");
        creating_send.send(()).unwrap();
        release.await.unwrap();
        let directory = std::path::PathBuf::from(create["params"]["directory"].as_str().unwrap());
        peer.reply(&create,json!({"sessionId":"owned-dropped-waiter","sessionFile":directory.join("sessions/owned.jsonl")})).await;
        let prompt = peer.read().await;
        assert_eq!(prompt["method"], "prompt");
        prompting_send.send(()).unwrap();
        let abort = peer.read().await;
        assert_eq!(abort["method"], "abort");
        peer.reply(&abort, Value::Null).await;
        peer.reply(&prompt, json!({"text":"已停止"})).await;
        let close = peer.read().await;
        assert_eq!(close["method"], "close");
        peer.reply(&close, Value::Null).await;
        peer.eof().await;
    });
    let session = f.session().await;
    let service = f.service.clone();
    let waiter = tokio::spawn(async move {
        service.request(json!({"op":"start","sessionId":session,"text":"独立读取，不改故事","readOnly":true})).await
    });
    bounded(creating).await.unwrap();
    waiter.abort();
    let _ = waiter.await;
    release_send.send(()).unwrap();
    bounded(prompting).await.unwrap();
    let id = f
        .service
        .active_task()
        .expect("native task survives missing UI waiter");
    let attempt=f.service.snapshot(&id,0,1).unwrap()["task"]["execution"]["attemptId"].clone();
    let stopped = bounded(f.service.request(json!({"op":"stop","taskId":id,"attemptId":attempt,"requestId":"owned-stop"})))
        .await
        .unwrap();
    assert_eq!(stopped["accepted"], true);
    f.idle().await;
    assert!(f.service.active_task().is_none());
    assert_eq!(
        f.service.snapshot(&id, 0, 20).unwrap()["status"],
        "cancelled"
    );
    assert_eq!(*f.activity.lock().unwrap(), vec![true, false]);
    assert!(
        !f.connection.is_closed(),
        "stopping one task preserves the initialized Node connection"
    );
    bounded(f.service.shutdown()).await.unwrap();
    bounded(peer_task).await.unwrap();
}

#[tokio::test]
async fn questions_release_the_story_and_answers_survive_a_stale_restart() {
    for changed in [false,true] {
        let(f,mut peer)=Fixture::new();
        let peer_task=tokio::spawn(async move {
            let create=peer.read().await;
            let directory=std::path::PathBuf::from(create["params"]["directory"].as_str().unwrap());
            peer.reply(&create,json!({"sessionId":"pi-continued","sessionFile":directory.join("sessions/question.jsonl")})).await;
            let prompt=peer.read().await;
            let task=prompt["params"]["taskId"].as_str().unwrap().to_owned();
            let mut bytes=serde_json::to_vec(&json!({"type":"tool_request","requestId":"ask-owned","sessionId":"pi-continued","taskId":task,"toolCallId":"ask-owned","name":"ask_user","args":{"questions":[{"id":"scope","question":"要核对哪一段？","options":[{"label":"当前一段"}]}]}})).unwrap();
            bytes.push(b'\n');peer.writer.write_all(&bytes).await.unwrap();
            let reply=peer.read().await;
            assert_eq!(reply["params"]["result"]["data"]["waitingForUser"],true,"{reply}");
            peer.reply(&prompt,json!({"text":"请补充范围","waitingForUser":true})).await;
            let close=peer.read().await;assert_eq!(close["method"],"close");peer.reply(&close,Value::Null).await;
            if !changed {
                let create=peer.read().await;assert_eq!(create["method"],"create");
                assert!(create["params"]["sessionFile"].as_str().unwrap().ends_with("question.jsonl"));
                peer.reply(&create,json!({"sessionId":"pi-continued","sessionFile":directory.join("sessions/question.jsonl")})).await;
                let steer=peer.read().await;assert_eq!(steer["method"],"steer");
                let answer=steer["params"]["text"].as_str().unwrap().to_owned();assert!(answer.contains("只核对当前段落"));
                peer.reply(&steer,Value::Null).await;
                let prompt=peer.read().await;assert_eq!(prompt["method"],"prompt");
                peer.event(&task,"user",&answer).await;
                assert_eq!(peer.finish(&task,"finish-after-answer").await["ok"],true);
                peer.reply(&prompt,json!({"text":"已按回答核对"})).await;
                let close=peer.read().await;assert_eq!(close["method"],"close");peer.reply(&close,Value::Null).await;
            }
            peer.eof().await;
        });
        let session=f.session().await;let started=bounded(f.start(&session)).await;f.idle().await;
        let task=started["taskId"].as_str().unwrap();
        let waiting=f.service.snapshot(task,0,100).unwrap();
        assert_eq!(waiting["status"],"waiting_user");
        assert_eq!(f.activity.lock().unwrap().last(),Some(&false),"waiting cannot retain foreground execution resources");
        {
            let db=f.store.lock().unwrap();
            let owner:String=db.query_row("SELECT owner_id FROM world_execution_leases WHERE world_id='world'",[],|r|r.get(0)).unwrap();
            assert_eq!(owner,"");
            if changed {db.execute("UPDATE worlds SET settings_json='{\"premise\":\"玩家等待期间的新设定\"}' WHERE id='world'",[]).unwrap();}
        }
        let question=&waiting["task"]["question"];
        let request=json!({"op":"answer_question","id":"owned-answer","taskId":task,"questionId":question["id"],"answers":{"scope":"只核对当前段落"},"cancelled":false});
        let result=bounded(f.service.request(request.clone())).await;
        if changed {
            assert!(result.is_err(),"an old base cannot overwrite progress made while waiting");
            let db=f.store.lock().unwrap();
            let raw:String=db.query_row("SELECT content_json FROM pi_inputs WHERE id='owned-answer'",[],|r|r.get(0)).unwrap();
            assert!(raw.contains("只核对当前段落"),"a stale restart must preserve the answer");
            assert_eq!(db.query_row("SELECT status FROM pi_tasks WHERE id=?",[task],|r|r.get::<_,String>(0)).unwrap(),"paused");
        } else {
            result.unwrap();f.idle().await;
            let done=f.service.snapshot(task,0,100).unwrap();assert_eq!(done["status"],"completed");assert!(done["task"]["question"].is_null());
            assert_eq!(bounded(f.service.request(request)).await.unwrap()["duplicate"],true);
        }
        bounded(f.service.shutdown()).await.unwrap();bounded(peer_task).await.unwrap();
    }
}

#[tokio::test]
async fn named_supplements_are_idempotent_and_queued_work_gets_a_new_task() {
    let (f,mut peer)=Fixture::new();
    let (prompt_send,prompt_ready)=tokio::sync::oneshot::channel();
    let (release_send,release)=tokio::sync::oneshot::channel();
    let (done_send,done)=tokio::sync::oneshot::channel();
    let peer_task=tokio::spawn(async move {
        let create=peer.read().await;
        let directory=std::path::PathBuf::from(create["params"]["directory"].as_str().unwrap());
        peer.reply(&create,json!({"sessionId":"pi-continued","sessionFile":directory.join("sessions/owned.jsonl")})).await;
        let prompt=peer.read().await;
        let first=prompt["params"]["taskId"].as_str().unwrap().to_owned();
        prompt_send.send(()).unwrap();
        let supplement=peer.read().await;
        assert_eq!(supplement["method"],"steer");
        let wire=supplement["params"]["text"].as_str().unwrap().to_owned();
        peer.reply(&supplement,Value::Null).await;
        release.await.unwrap();
        peer.event(&first,"user",&wire).await;
        assert_eq!(peer.finish(&first,"first-finish").await["ok"],true);
        peer.reply(&prompt,json!({"text":"已处理当前补充"})).await;
        let close=peer.read().await;assert_eq!(close["method"],"close");peer.reply(&close,Value::Null).await;
        let create=peer.read().await;assert_eq!(create["method"],"create");
        peer.reply(&create,json!({"sessionId":"pi-continued","sessionFile":directory.join("sessions/owned.jsonl")})).await;
        let prompt=peer.read().await;assert_eq!(prompt["method"],"prompt");
        assert_eq!(prompt["params"]["text"],"稍后核对时间");
        let second=prompt["params"]["taskId"].as_str().unwrap();assert_ne!(first,second);
        assert_eq!(peer.finish(second,"queued-finish").await["ok"],true);
        peer.reply(&prompt,json!({"text":"已处理下一项任务"})).await;
        let close=peer.read().await;assert_eq!(close["method"],"close");peer.reply(&close,Value::Null).await;
        done_send.send(()).unwrap();
        peer.eof().await;
    });
    let session=f.session().await;
    let started=bounded(f.start(&session)).await;
    bounded(prompt_ready).await.unwrap();
    let id=started["taskId"].as_str().unwrap();
    let input=json!({"op":"enqueue_input","id":"owned-supplement","taskId":id,"text":"保留玩家分支","delivery":"steer"});
    let a=bounded(f.service.request(input.clone())).await.unwrap();
    let b=bounded(f.service.request(input)).await.unwrap();assert_eq!(a["id"],b["id"]);
    assert!(f.service.request(json!({"op":"enqueue_input","id":"owned-supplement","taskId":id,"text":"替换内容","delivery":"steer"})).await.is_err());
    let queued=json!({"op":"enqueue_input","id":"owned-queued","taskId":id,"text":"稍后核对时间","delivery":"queued","request":{"model":{"slot":"agent-slot","apiKey":"UI-QUEUE-SECRET"},"policy":"preview","readOnly":true}});
    assert_eq!(f.service.request(queued.clone()).await.unwrap()["id"],"owned-queued");
    assert_eq!(f.service.request(queued).await.unwrap()["id"],"owned-queued");
    f.service.request(json!({"op":"enqueue_input","id":"owned-cancelled","taskId":id,"text":"不应启动","delivery":"queued"})).await.unwrap();
    assert_eq!(f.service.request(json!({"op":"cancel_queued","inputId":"owned-cancelled"})).await.unwrap()["cancelled"],true);
    release_send.send(()).unwrap();bounded(done).await.unwrap();f.idle().await;
    {
        let db=f.store.lock().unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM pi_tasks",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        assert_eq!(db.query_row("SELECT intent_revision FROM pi_tasks WHERE id=?",[id],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(db.query_row("SELECT status FROM pi_inputs WHERE id='owned-queued'",[],|r|r.get::<_,String>(0)).unwrap(),"delivered");
        assert_eq!(db.query_row("SELECT status FROM pi_inputs WHERE id='owned-cancelled'",[],|r|r.get::<_,String>(0)).unwrap(),"cancelled");
        assert!(!db.query_row("SELECT content_json FROM pi_inputs WHERE id='owned-queued'",[],|r|r.get::<_,String>(0)).unwrap().contains("UI-QUEUE-SECRET"));
        assert_eq!(db.query_row("SELECT COUNT(*) FROM nodes",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
    bounded(f.service.shutdown()).await.unwrap();bounded(peer_task).await.unwrap();
}

#[tokio::test]
async fn deleting_a_conversation_keeps_adopted_story_and_independent_recovery() {
    use story_core::{pi_gateway::StoryToolGateway,pi_store::PiCallRequest};
    let (f,mut peer)=Fixture::new();
    let server=tokio::spawn(async move{peer.one_task(1).await;peer.eof().await;});
    let session=f.session().await;let started=f.service.request(json!({"op":"start","sessionId":session,"text":"修改设定","readOnly":false})).await.unwrap();f.idle().await;
    let task=started["taskId"].as_str().unwrap();
    let gateway=StoryToolGateway::new(f.store.clone());let permit=gateway.resume_task(task).unwrap();
    let version=gateway.0.task(task).unwrap()["base_world_version"].as_str().unwrap().to_owned();
    let call=|id:&str,tool:&str,args:Value|gateway.invoke(&permit,PiCallRequest{task_id:task.into(),call_id:id.into(),tool:tool.into(),args,intent_revision:0,world_version:version.clone(),external_write:false}).unwrap();
    assert_eq!(call("edit","stage_edit",json!({"kind":"settings","operation":"merge","value":{"premise":"正式采用的设定"},"summary":"保留正式修改"}))["ok"],true);
    let committed=call("finish","finish_task",json!({"summary":"已采用设定"}));assert_eq!(committed["ok"],true,"{committed}");
    let directory=f._directory.path().join(&session);std::fs::create_dir_all(directory.join("sessions")).unwrap();
    std::fs::write(directory.join("sessions/owned.jsonl"),"owned Pi transcript").unwrap();
    let canary=f._directory.path().join("independent-story-canary");std::fs::write(&canary,"keep").unwrap();
    f.store.lock().unwrap().execute("INSERT INTO pi_events(task_id,seq,event_json,created_at) VALUES(?,1,?,'test')",rusqlite::params![task,json!({"sessionId":"pi-1","taskId":task,"event":{"type":"message_end","message":{"role":"assistant","timestamp":7,"content":[{"type":"text","text":"可搜索的中途说明"},{"type":"thinking","thinking":"不可搜索的隐藏思考"}]}}}).to_string()]).unwrap();
    let detail=f.service.request(json!({"op":"session","id":session})).await.unwrap();
    assert!(detail["messages"].to_string().contains("可搜索的中途说明"));assert!(!detail["messages"].to_string().contains("隐藏思考"));
    assert_eq!(f.service.request(json!({"op":"search","worldId":"world","lineId":"line","query":"中途说明"})).await.unwrap()["sessions"].as_array().unwrap().len(),1);
    assert!(f.service.request(json!({"op":"search","worldId":"world","lineId":"line","query":"隐藏思考"})).await.unwrap()["sessions"].as_array().unwrap().is_empty());
    let deleted=f.service.request(json!({"op":"delete","id":session})).await.unwrap();assert_eq!(deleted["deleted"],true);
    assert!(!directory.exists());assert_eq!(std::fs::read_to_string(canary).unwrap(),"keep");
    assert_eq!(f.store.lock().unwrap().query_row("SELECT COUNT(*) FROM pi_tasks",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(f.store.lock().unwrap().query_row("SELECT COUNT(*) FROM story_recovery_points",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    let settings:String=f.store.lock().unwrap().query_row("SELECT settings_json FROM worlds WHERE id='world'",[],|r|r.get(0)).unwrap();assert!(settings.contains("正式采用的设定"));
    assert_eq!(f.service.request(json!({"op":"undo","taskId":task})).await.unwrap()["undone"],true);
    bounded(f.service.shutdown()).await.unwrap();bounded(server).await.unwrap();
}

#[tokio::test]
async fn active_conversation_is_deleted_only_after_native_stop_acknowledgement() {
    let (f,mut peer)=Fixture::new();
    let (ready_send,ready)=tokio::sync::oneshot::channel();
    let (abort_send,abort_seen)=tokio::sync::oneshot::channel();
    let (allow_send,allow)=tokio::sync::oneshot::channel();
    let server=tokio::spawn(async move{
        let create=peer.read().await;let directory=std::path::PathBuf::from(create["params"]["directory"].as_str().unwrap());
        peer.reply(&create,json!({"sessionId":"pi-continued","sessionFile":directory.join("sessions/owned.jsonl")})).await;
        let prompt=peer.read().await;ready_send.send(()).unwrap();
        let abort=peer.read().await;assert_eq!(abort["method"],"abort");abort_send.send(()).unwrap();
        allow.await.unwrap();peer.reply(&abort,Value::Null).await;peer.reply(&prompt,json!({"text":"已停止"})).await;
        let close=peer.read().await;assert_eq!(close["method"],"close");peer.reply(&close,Value::Null).await;peer.eof().await;
    });
    let session=f.session().await;f.start(&session).await;bounded(ready).await.unwrap();
    let service=f.service.clone();let target=session.clone();
    let deleting=tokio::spawn(async move{service.request(json!({"op":"delete","id":target})).await});
    bounded(abort_seen).await.unwrap();
    assert_eq!(f.store.lock().unwrap().query_row("SELECT COUNT(*) FROM pi_sessions WHERE id=?",[&session],|r|r.get::<_,i64>(0)).unwrap(),1);
    allow_send.send(()).unwrap();assert_eq!(bounded(deleting).await.unwrap().unwrap()["deleted"],true);
    assert!(f.service.active_task().is_none());
    bounded(f.service.shutdown()).await.unwrap();bounded(server).await.unwrap();
}

#[tokio::test]
async fn conversation_fork_uses_corroborated_entries_keeps_story_and_survives_source_deletion() {
    use sha2::{Digest, Sha256};
    use story_core::{pi_gateway::StoryToolGateway, pi_store::PiCallRequest};
    let (f, mut peer) = Fixture::new();
    let server = tokio::spawn(async move {
        peer.one_task(1).await;
        let mut branches = vec![];
        for selected in ["owned-user-two", "owned-assistant-one"] {
            let request = peer.read().await;
            assert_eq!(request["method"], "fork_session");
            assert_eq!(request["params"]["entryId"], selected);
            let source = std::path::PathBuf::from(request["params"]["sourceFile"].as_str().unwrap());
            assert_eq!(std::fs::read_to_string(&source).unwrap(), "owned source Pi file");
            let target = std::path::PathBuf::from(request["params"]["targetDirectory"].as_str().unwrap());
            assert!(!target.exists(), "the native facade must allocate a fresh branch directory");
            std::fs::create_dir_all(target.join("sessions")).unwrap();
            let file = target.join("sessions/owned-branch.jsonl");
            std::fs::write(&file, "independent owned Pi branch").unwrap();
            branches.push(file.clone());
            peer.reply(&request, json!({"sessionFile":file,"piSessionId":"owned-branch","selectedUserText":if selected=="owned-user-two"{json!("【本次补充标识 owned-selected:owned-nonce】\n稍后要核对的𠮷人物")}else{Value::Null},"keptEntryIds":["owned-user-one","owned-assistant-one"],"keptToolCallIds":[]})).await;
        }
        let create = peer.read().await;
        assert_eq!(create["method"], "create");
        assert_eq!(create["params"]["sessionFile"], branches[0].to_string_lossy().as_ref());
        peer.reply(&create, json!({"sessionId":"pi-continued","sessionFile":branches[0]})).await;
        let prompt = peer.read().await;
        assert_eq!(prompt["method"], "prompt");
        assert_eq!(prompt["params"]["text"], "只读取本局资料");
        assert!(!prompt.to_string().contains("尚未发送的要求"));
        let task = prompt["params"]["taskId"].as_str().unwrap();
        assert_eq!(peer.finish(task, "branch-only-finish").await["ok"], true);
        peer.reply(&prompt, json!({"text":"新对话独立核对完成"})).await;
        let close = peer.read().await;
        assert_eq!(close["method"], "close");
        peer.reply(&close, Value::Null).await;
        peer.eof().await;
    });
    let source = f.session().await;
    let started = bounded(f.service.request(json!({"op":"start","sessionId":source,"text":"只读取本局资料","readOnly":false}))).await.unwrap();
    f.idle().await;
    let task = started["taskId"].as_str().unwrap();
    let gateway = StoryToolGateway::new(f.store.clone());
    let permit = gateway.resume_task(task).unwrap();
    let version = gateway.0.task(task).unwrap()["base_world_version"].as_str().unwrap().to_owned();
    let call = |id: &str, tool: &str, args: Value| gateway.invoke(&permit, PiCallRequest { task_id: task.into(), call_id: id.into(), tool: tool.into(), args, intent_revision: 0, world_version: version.clone(), external_write: false }).unwrap();
    assert_eq!(call("owned-edit", "stage_edit", json!({"kind":"settings","operation":"merge","value":{"premise":"已正式采用的故事设定"},"summary":"保留故事事实"}))["ok"], true);
    let committed = call("owned-finish", "finish_task", json!({"summary":"设定已经采用"}));
    assert_eq!(committed["ok"], true, "{committed}");
    let source_directory = f._directory.path().join(&source);
    std::fs::create_dir_all(source_directory.join("sessions")).unwrap();
    std::fs::write(source_directory.join("sessions/owned.jsonl"), "owned source Pi file").unwrap();
    let hash = format!("{:x}", Sha256::digest("只读取本局资料".as_bytes()));
    gateway.0.event(task, &json!({"event":{"type":"message_anchor","role":"user","entryId":"owned-user-one","userHash":hash}})).unwrap();
    gateway.0.event(task, &json!({"event":{"type":"message_start","message":{"role":"assistant","timestamp":42,"content":[{"type":"text","text":"已读取𠮷人物资料，正式设定保留。"}]}}})).unwrap();
    gateway.0.event(task, &json!({"event":{"type":"message_end","message":{"role":"assistant","timestamp":42,"content":[{"type":"text","text":"已读取𠮷人物资料，正式设定保留。"}]}}})).unwrap();
    gateway.0.event(task, &json!({"event":{"type":"message_anchor","role":"assistant","entryId":"owned-assistant-one","messageKey":"at:42"}})).unwrap();
    {
        let db = f.store.lock().unwrap();
        db.execute("INSERT INTO pi_inputs(id,session_id,task_id,seq,delivery,status,content_json,intent_revision,created_at) VALUES('owned-selected',?,?,1,'steer','delivered','{\"text\":\"稍后要核对的𠮷人物\",\"nonce\":\"owned-nonce\"}',1,'test')", rusqlite::params![source, task]).unwrap();
        db.execute("INSERT INTO pi_inputs(id,session_id,task_id,seq,delivery,status,content_json,intent_revision,created_at) VALUES('owned-pending-fork',?,?,2,'queued','pending','{\"text\":\"尚未发送的要求\",\"nonce\":\"pending-nonce\"}',0,'test')", rusqlite::params![source, task]).unwrap();
    }
    // The actual Pi append event is represented by its exact nonce-bearing
    // wire hash, not by accepting a UI-supplied entry ID as an edit target.
    let wire = "【本次补充标识 owned-selected:owned-nonce】\n稍后要核对的𠮷人物";
    let selected_hash = format!("{:x}", Sha256::digest(wire.as_bytes()));
    gateway.0.event(task, &json!({"event":{"type":"message_anchor","role":"user","entryId":"owned-user-two","userHash":selected_hash}})).unwrap();
    let anchor_count: i64 = f.store.lock().unwrap().query_row("SELECT COUNT(*) FROM pi_message_anchors WHERE task_id=? AND entry_id='owned-user-two'", [task], |r| r.get(0)).unwrap();
    assert_eq!(anchor_count, 1, "the fixture wire must match the real native input format");
    assert!(f.service.request(json!({"op":"fork","sessionId":source,"messageId":format!("{task}:assistant:at:999")})).await.is_err(), "an uncorroborated UI message must not become a Pi branch anchor");
    let user_fork = bounded(f.service.request(json!({"op":"fork","sessionId":source,"messageId":format!("{task}:input:owned-selected")}))).await.unwrap();
    assert_eq!(user_fork["storyChanged"], false);
    assert_eq!(user_fork["selectedUserText"], "稍后要核对的𠮷人物");
    let assistant_fork = bounded(f.service.request(json!({"op":"fork","sessionId":source,"messageId":format!("{task}:assistant:at:42")}))).await.unwrap();
    assert_ne!(user_fork["id"], assistant_fork["id"]);
    let target = user_fork["id"].as_str().unwrap();
    let before = f.service.request(json!({"op":"session","id":target})).await.unwrap();
    assert_eq!(before["tasks"].as_array().unwrap().len(), 0, "forked dialogue history is not a resumable copy of old tasks");
    assert_eq!(before["messages"].as_array().unwrap().len(), 2);
    assert!(before["messages"].to_string().contains("已读取𠮷人物资料"));
    assert!(!before.to_string().contains("尚未发送的要求"));
    assert!(before["messages"].as_array().unwrap().iter().all(|m| m["taskId"].is_null()));
    assert_eq!(f.service.request(json!({"op":"delete","id":source})).await.unwrap()["deleted"], true);
    assert!(!source_directory.exists());
    let after = f.service.request(json!({"op":"session","id":target})).await.unwrap();
    assert_eq!(before["messages"], after["messages"], "source deletion must not erase independent branch dialogue");
    let found=f.service.request(json!({"op":"search","worldId":"world","lineId":"line","query":"已读取𠮷人物资料"})).await.unwrap();
    assert!(found["sessions"].as_array().unwrap().iter().any(|s|s["id"]==target),"inherited dialogue remains searchable after source deletion");
    {
        let db = f.store.lock().unwrap();
        assert!(db.query_row("SELECT settings_json FROM worlds WHERE id='world'", [], |r| r.get::<_, String>(0)).unwrap().contains("已正式采用的故事设定"));
        assert_eq!(db.query_row("SELECT COUNT(*) FROM story_recovery_points", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM pi_inputs WHERE session_id=?", [target], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
    let continued = bounded(f.start(target)).await;
    assert_ne!(continued["taskId"], task);
    f.idle().await;
    assert_eq!(f.service.snapshot(continued["taskId"].as_str().unwrap(), 0, 100).unwrap()["status"], "completed");
    bounded(f.service.shutdown()).await.unwrap(); bounded(server).await.unwrap();
}

#[tokio::test]
async fn more_than_2500_mock_calls_have_true_counts_incremental_pages_and_orphan_stop() {
    let(f,_peer)=Fixture::new();let session=f.session().await;
    let gateway=story_core::pi_gateway::StoryToolGateway::new(f.store.clone());
    gateway.start_task(&session,"long-process","模拟长过程","auto-reversible",true,json!({"model":"no-http"}),json!({})).unwrap();
    {
        let mut db=f.store.lock().unwrap();let tx=db.transaction().unwrap();
        for n in 0..2505 {tx.execute("INSERT INTO pi_calls(task_id,call_id,tool,args_hash,world_version,intent_revision,external_write,status,output_json,created_at,updated_at) VALUES('long-process',?,'read_resource','hash','v',0,0,'done',?,'test','test')",rusqlite::params![format!("script:host:{n}"),json!({"ok":true,"data":{"text":format!("资料{n}")}}).to_string()]).unwrap();}tx.commit().unwrap();
    }
    let mut cursor=0;let mut ids=std::collections::HashSet::new();let mut pages=0;
    loop {let page=f.service.request(json!({"op":"delta","taskId":"long-process","after":0,"callAfter":cursor})).await.unwrap();assert_eq!(page["task"]["budget"]["toolCalls"],2505);assert!(page["steps"].as_array().unwrap().len()<=200);for step in page["steps"].as_array().unwrap(){ids.insert(step["id"].to_string());}pages+=1;let next=page["nextCallAfter"].as_i64().unwrap();assert!(next>cursor);cursor=next;if page["hasMoreCalls"]!=true {break;}}
    assert_eq!(ids.len(),2505);assert_eq!(pages,13);
    let no_change=f.service.request(json!({"op":"delta","taskId":"long-process","callAfter":cursor})).await.unwrap();assert_eq!(no_change["steps"],json!([]));
    let mut before=Value::Null;let mut all=std::collections::HashSet::new();loop{let page=f.service.request(json!({"op":"process_page","taskId":"long-process","before":before})).await.unwrap();for step in page["steps"].as_array().unwrap(){all.insert(step["id"].to_string());}before=page["nextBefore"].clone();if before.is_null(){break;}}
    assert_eq!(all.len(),2505);
    let attempt=no_change["task"]["execution"]["attemptId"].clone();f.store.lock().unwrap().execute("UPDATE world_execution_leases SET expires_at_ms=0",[]).unwrap();
    let began=std::time::Instant::now();let stopped=f.service.request(json!({"op":"stop","taskId":"long-process","attemptId":attempt,"requestId":"lost-long-process"})).await.unwrap();assert!(began.elapsed()<Duration::from_secs(1));assert_eq!(stopped["accepted"],true);assert_eq!(stopped["settled"],true);assert_eq!(f.resolved.load(Ordering::SeqCst),0,"mock calls cannot contact a model");
    f.service.shutdown().await.unwrap();
}

#[tokio::test]
async fn unresponsive_host_acknowledges_stop_then_isolated_timeout_settles() {
 let(f,mut peer)=Fixture::new();let(signal,ready)=tokio::sync::oneshot::channel();
 let peer_task=tokio::spawn(async move{let create=peer.read().await;let directory=std::path::PathBuf::from(create["params"]["directory"].as_str().unwrap());peer.reply(&create,json!({"sessionId":"unresponsive","sessionFile":directory.join("sessions/stuck.jsonl")})).await;let prompt=peer.read().await;assert_eq!(prompt["method"],"prompt");signal.send(()).unwrap();let abort=peer.read().await;assert_eq!(abort["method"],"abort");loop{let mut line=String::new();if peer.reader.read_line(&mut line).await.unwrap()==0{break;}}});
 let killed=Arc::new(Mutex::new(None));let capture=killed.clone();f.service.set_control_timeout(Arc::new(move|task,attempt|*capture.lock().unwrap()=Some((task.to_owned(),attempt.to_owned()))));
 let session=f.session().await;let start=f.start(&session).await;ready.await.unwrap();let id=start["taskId"].as_str().unwrap();let attempt=start["attemptId"].clone();
 let before=std::time::Instant::now();let accepted=f.service.request(json!({"op":"stop","taskId":id,"attemptId":attempt,"requestId":"hung-stop"})).await.unwrap();assert!(before.elapsed()<Duration::from_secs(1));assert_eq!(accepted["accepted"],true);
 tokio::time::timeout(Duration::from_secs(25),async{loop{if killed.lock().unwrap().is_some(){break;}tokio::time::sleep(Duration::from_millis(50)).await;}}).await.unwrap();
 assert_eq!(killed.lock().unwrap().as_ref().unwrap().0,id);assert!(before.elapsed()<Duration::from_secs(30));assert_eq!(f.service.snapshot(id,0,1).unwrap()["status"],"cancelled");assert!(f.connection.is_closed());bounded(peer_task).await.unwrap();
}

#[tokio::test]
async fn continue_waits_for_the_previous_sessions_close_after_database_settlement() {
    let(f,mut peer)=Fixture::new();
    let peer_task=tokio::spawn(async move{
        let create=peer.read().await;let directory=std::path::PathBuf::from(create["params"]["directory"].as_str().unwrap());
        peer.reply(&create,json!({"sessionId":"pi-draining","sessionFile":directory.join("sessions/owned.jsonl")})).await;
        let prompt=peer.read().await;peer.reply(&prompt,json!({"text":"第一次答复"})).await;
        let close=peer.read().await;assert_eq!(close["method"],"close");
        tokio::time::sleep(Duration::from_millis(400)).await;
        peer.reply(&close,Value::Null).await;
        peer.one_task(2).await;peer.eof().await;
    });
    let session=f.session().await;let first=bounded(f.start_editing(&session)).await;let id=first["taskId"].as_str().unwrap();
    for _ in 0..100 {
        if f.service.snapshot(id,0,100).unwrap()["status"]=="interrupted"{break;}
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let began=std::time::Instant::now();
    let next=bounded(f.service.request(json!({"op":"continue","taskId":id}))).await.unwrap();
    assert_eq!(next["taskId"],id);assert!(began.elapsed()>=Duration::from_millis(200),"continue must wait for transport ownership, not only the released DB lease");
    f.idle().await;f.connection.close_transport().await;bounded(peer_task).await.unwrap();assert_eq!(f.resolved.load(Ordering::SeqCst),2);
}
