//! Native Pi bridge only. All host records are in-memory fixtures, no model.
use pi_host::{AgentConnection, TransportOptions};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use story_core::{
    pi_gateway::StoryToolGateway,
    pi_runtime::{PiTaskConfig, PiTaskHost, PI_PROMPT_VERSION},
    pi_store::NewSession,
    Store,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

struct Peer {
    input: BufReader<ReadHalf<DuplexStream>>,
    output: WriteHalf<DuplexStream>,
}
impl Peer {
    async fn read(&mut self) -> Value {
        let mut line = String::new();
        assert!(self.input.read_line(&mut line).await.unwrap() > 0);
        serde_json::from_str(&line).unwrap()
    }
    async fn send(&mut self, value: Value) {
        let mut data = serde_json::to_vec(&value).unwrap();
        data.push(b'\n');
        self.output.write_all(&data).await.unwrap();
    }
    async fn reply(&mut self, request: &Value, value: Value) {
        self.send(json!({"type":"response","id":request["id"],"ok":true,"data":value}))
            .await;
    }
    async fn create(&mut self) {
        let request = self.read().await;
        assert_eq!(request["method"], "create");
        assert!(!request["params"]["systemPrompt"]
            .as_str()
            .unwrap()
            .contains("PRIVATE-WORLD-SENTINEL"));
        let directory = PathBuf::from(request["params"]["directory"].as_str().unwrap());
        self.reply(
            &request,
            json!({"sessionId":"pi-session","sessionFile":directory.join("sessions/test.jsonl")}),
        )
        .await;
    }
    async fn tool(&mut self, id: &str, name: &str, args: Value) -> Value {
        self.send(json!({"type":"tool_request","requestId":id,"sessionId":"pi-session","taskId":"task","toolCallId":id,"name":name,"args":args})).await;
        let result = self.read().await;
        assert_eq!(result["method"], "tool_result");
        assert_eq!(result["params"]["requestId"], id);
        result["params"]["result"].clone()
    }
    async fn close(&mut self) {
        let request = self.read().await;
        assert_eq!(request["method"], "close");
        self.reply(&request, Value::Null).await;
    }
}
struct Fixture {
    store: Store,
    host: PiTaskHost,
    connection: AgentConnection,
}

#[tokio::test]
async fn stopping_manual_compaction_keeps_the_previous_checkpoint_and_draft() {
    let(f,mut peer)=Fixture::new();
    let(ready_send,ready)=tokio::sync::oneshot::channel();
    let peer_task=tokio::spawn(async move {
        peer.create().await;
        let compact=peer.read().await;assert_eq!(compact["method"],"compact");ready_send.send(()).unwrap();
        let abort=peer.read().await;assert_eq!(abort["method"],"abort");peer.reply(&abort,Value::Null).await;
        peer.reply(&compact,json!({"firstKeptEntryId":"must-not-adopt-late-checkpoint","tokensBefore":1000,"summaryChars":12})).await;
        peer.close().await;
    });
    f.create().await;
    let previous=json!({"firstKeptEntryId":"owned-previous-cut"});let draft=json!({"edits":[],"note":"未采用资料保持"});
    {
        let db=f.store.lock().unwrap();
        let raw:String=db.query_row("SELECT metadata_json FROM pi_tasks WHERE id='task'",[],|r|r.get(0)).unwrap();let mut meta:Value=serde_json::from_str(&raw).unwrap();meta["contextCheckpoint"]=previous.clone();
        db.execute("UPDATE pi_tasks SET metadata_json=?,workspace_json=? WHERE id='task'",rusqlite::params![meta.to_string(),draft.to_string()]).unwrap();
    }
    let host=f.host.clone();let compact=tokio::spawn(async move{host.compact(None).await});
    tokio::time::timeout(Duration::from_secs(10),ready).await.unwrap().unwrap();
    let stopped=tokio::time::timeout(Duration::from_secs(10),f.host.stop()).await.unwrap().unwrap();assert_eq!(stopped["abortConfirmed"],true);
    assert!(compact.await.unwrap().is_err());
    {
        let db=f.store.lock().unwrap();
        let(status,meta,work):(String,String,String)=db.query_row("SELECT status,metadata_json,workspace_json FROM pi_tasks WHERE id='task'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(status,"cancelled");assert_eq!(serde_json::from_str::<Value>(&meta).unwrap()["contextCheckpoint"],previous);assert_eq!(serde_json::from_str::<Value>(&work).unwrap(),draft);
    }
    f.host.shutdown().await.unwrap();peer_task.await.unwrap();
}
impl Fixture {
    fn new() -> (Self, Peer) {
        Self::with_network(None)
    }
    fn with_network(network:Option<story_core::pi_service::NetworkHost>) -> (Self,Peer) {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        story_core::migration::migrate(&mut db, None).unwrap();
        let settings =
            json!({"premise":"PRIVATE-WORLD-SENTINEL","autoUpkeep":false,"chapterEvery":0});
        let state = json!({"version":2,"time":{"start":"第一天","elapsedMinutes":0,"startHour":8},"placeId":null,"protagonist":{"name":"旅人","aliases":[],"age":20,"gender":"男","identity":"行旅","origin":"现代","cheat":"","stats":{"money":10,"debt":0,"health":100,"energy":100,"fame":0},"statuses":[],"items":[]},"people":[],"places":[],"cards":[],"goals":[],"facts":[],"era":{"packId":null,"mode":"free","clockStyle":"elapsed"},"deviations":[]});
        db.execute("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('world','独立','free','line',?,'test','test','test')",[settings.to_string()]).unwrap();
        db.execute_batch("INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('node','world',0,'opening','旧正文','test');INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('line','world','主线','node','test')").unwrap();
        db.execute(
            "INSERT INTO states(node_id,state_json) VALUES('node',?)",
            [state.to_string()],
        )
        .unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        let gateway = StoryToolGateway::new(store.clone());
        gateway
            .create_session(&NewSession {
                id: "session".into(),
                world_id: "world".into(),
                line_id: "line".into(),
                title: "隔离".into(),
                session_file: None,
            })
            .unwrap();
        gateway
            .start_task(
                "session",
                "task",
                "调整本局设定，不新增剧情",
                "auto-reversible",
                false,
                json!({"model":"fixture"}),
                json!({}),
            )
            .unwrap();
        let permit = gateway.permit("task").unwrap();
        let (native, peer) = tokio::io::duplex(16384);
        let (read, write) = tokio::io::split(native);
        let (connection, incoming) =
            AgentConnection::attach(read, write, TransportOptions::default()).unwrap();
        let host = PiTaskHost::attach_with_network(connection.clone(), incoming, gateway, permit,network).unwrap();
        let (read, write) = tokio::io::split(peer);
        (
            Self {
                store,
                host,
                connection,
            },
            Peer {
                input: BufReader::new(read),
                output: write,
            },
        )
    }
    async fn create(&self) {
        self.host
            .create(PiTaskConfig {
                directory: std::env::temp_dir().join(format!("pi-owned-{}", uuid::Uuid::new_v4())),
                model: json!({"id":"fixture","apiKey":"OWNED-MEMORY-ONLY"}),
                constraints: "沿用本局规则".into(),
            })
            .await
            .unwrap();
    }
    fn saved(&self, sql: &str) -> Value {
        let db = self.store.lock().unwrap();
        let value: String = db.query_row(sql, [], |r| r.get(0)).unwrap();
        serde_json::from_str(&value).unwrap()
    }
}
async fn bounded<T>(value: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), value)
        .await
        .expect("native bridge must not deadlock")
}

#[tokio::test]
async fn a_nested_script_tool_limit_pauses_the_root_without_repeating_or_saving_partial_script_data() {
    let(f,mut peer)=Fixture::new();
    f.store.lock().unwrap().execute("UPDATE pi_tasks SET metadata_json='{\"limits\":{\"toolCalls\":1}}' WHERE id='task'",[]).unwrap();
    let server=tokio::spawn(async move {
        peer.create().await;
        let prompt=peer.read().await;assert_eq!(prompt["method"],"prompt");
        peer.send(json!({"type":"tool_request","requestId":"script-limited","sessionId":"pi-session","taskId":"task","toolCallId":"script-limited","name":"run_script","args":{"source":"const value = await tools.read_clock({}); store('partial', value); return value;"}})).await;
        // Reaching the nested cap cancels the run itself. It cannot ask the
        // model to retry the same script or wait for an unpaired tool result.
        peer.close().await;
    });
    bounded(f.create()).await;
    assert!(bounded(f.host.prompt()).await.is_err());
    bounded(f.host.shutdown()).await.unwrap();bounded(server).await.unwrap();
    let db=f.store.lock().unwrap();
    let(status,error,meta):(String,String,String)=db.query_row("SELECT status,error,metadata_json FROM pi_tasks WHERE id='task'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(status,"interrupted");assert!(error.contains("工具调用上限"),"{error}");
    assert!(serde_json::from_str::<Value>(&meta).unwrap()["scriptStore"]["partial"].is_null());
    assert_eq!(db.query_row("SELECT COUNT(*) FROM pi_calls",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM pi_model_requests",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}

#[tokio::test]
async fn native_search_uses_the_root_model_ledger_and_cannot_bypass_its_limit() {
    use std::sync::atomic::{AtomicUsize,Ordering};
    let dispatched=Arc::new(AtomicUsize::new(0));let seen=dispatched.clone();
    let network:story_core::pi_service::NetworkHost=Arc::new(move|request,_,accounting|{
        let seen=seen.clone();Box::pin(async move {
            let accounting=accounting.expect("native model search must have root accounting");
            if request["query"]=="unconfigured" {return Err(story_core::Error::Invalid("隔离的凭据检查未通过，未发送".into()));}
            accounting.admit()?;seen.fetch_add(1,Ordering::SeqCst);
            if request["query"]=="lost" {return Err(story_core::Error::Invalid("隔离的未确认响应".into()));}
            accounting.finish(&json!({"input":6,"output":2}),"success")?;
            Ok(json!({"text":"夹具结果","sources":[{"url":"https://fixture.invalid/evidence"}]}))
        })
    });
    let(f,mut peer)=Fixture::with_network(Some(network));
    f.store.lock().unwrap().execute("UPDATE pi_tasks SET metadata_json=? WHERE id='task'",[json!({"limits":{"modelRequests":2},"network":{"mode":"native","native":{"enabled":true,"protocol":"openai-responses","slot":"owned-network-slot","url":"https://fixture.invalid/responses","model":"owned-search-model"}}}).to_string()]).unwrap();
    let server=tokio::spawn(async move {
        peer.create().await;let prompt=peer.read().await;assert_eq!(prompt["method"],"prompt");
        assert_eq!(peer.tool("native-preflight","web_search",json!({"query":"unconfigured"})).await["ok"],false);
        assert_eq!(peer.tool("native-one","web_search",json!({"query":"check"})).await["ok"],true);
        assert_eq!(peer.tool("native-lost","web_search",json!({"query":"lost"})).await["ok"],false);
        peer.send(json!({"type":"tool_request","requestId":"native-over-cap","sessionId":"pi-session","taskId":"task","toolCallId":"native-over-cap","name":"web_search","args":{"query":"not sent"}})).await;
        peer.close().await;
    });
    bounded(f.create()).await;assert!(bounded(f.host.prompt()).await.is_err());
    bounded(f.host.shutdown()).await.unwrap();bounded(server).await.unwrap();
    assert_eq!(dispatched.load(Ordering::SeqCst),2,"a third attempt must fail before dispatch");
    let db=f.store.lock().unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM pi_model_requests WHERE source='native_search'",[],|r|r.get::<_,i64>(0)).unwrap(),2);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM pi_model_requests WHERE status='unknown'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(db.query_row("SELECT SUM(json_extract(usage_json,'$.input')) FROM pi_model_requests",[],|r|r.get::<_,i64>(0)).unwrap(),6);
    assert!(db.query_row("SELECT error FROM pi_tasks WHERE id='task'",[],|r|r.get::<_,String>(0)).unwrap().contains("模型请求"));
    assert_eq!(db.query_row("SELECT COUNT(*) FROM nodes",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}

#[tokio::test]
async fn local_modification_is_adopted_and_only_actual_receipt_reports_it() {
    let (f, mut peer) = Fixture::new();
    let store = f.store.clone();
    let server = tokio::spawn(async move {
        peer.create().await;
        let prompt = peer.read().await;
        assert_eq!(prompt["method"], "prompt");
        let edit=peer.tool("edit","stage_edit",json!({"kind":"settings","path":"/premise","operation":"set","value":"新设定","summary":"修改设定"})).await;
        assert_eq!(edit["ok"], true, "{edit}");
        let finish = peer
            .tool("finish", "finish_task", json!({"summary":"已采用设定修改"}))
            .await;
        assert_eq!(finish["ok"], true, "{finish}");
        assert_eq!(
            store
                .lock()
                .unwrap()
                .query_row(
                    "SELECT owner_id FROM world_execution_leases WHERE world_id='world'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "task",
            "final assistant reply still owns its session file and story lease"
        );
        peer.send(json!({"type":"event","sessionId":"pi-session","taskId":"task","event":{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"已修改设定"}]}}})).await;
        peer.reply(&prompt, json!({"text":"已修改设定"})).await;
        peer.close().await;
    });
    bounded(f.create()).await;
    let result = bounded(f.host.prompt()).await.unwrap();
    assert_eq!(result["answer"], "已修改设定");
    assert_eq!(result["taskReceipt"]["status"], "committed");
    assert_eq!(
        f.store
            .lock()
            .unwrap()
            .query_row(
                "SELECT owner_id FROM world_execution_leases WHERE world_id='world'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        ""
    );
    assert_eq!(
        f.saved("SELECT settings_json FROM worlds WHERE id='world'")["premise"],
        "新设定"
    );
    let metadata = f.saved("SELECT metadata_json FROM pi_tasks WHERE id='task'");
    assert_eq!(metadata["piPromptVersion"], PI_PROMPT_VERSION);
    assert!(!metadata.to_string().contains("OWNED-MEMORY-ONLY"));
    assert_eq!(
        f.store
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    bounded(f.host.shutdown()).await.unwrap();
    bounded(server).await.unwrap();
}

#[tokio::test]
async fn script_tools_share_native_authority_ledger_and_task_store() {
    let (f,mut peer)=Fixture::new();
    let (release,hold)=tokio::sync::oneshot::channel();
    f.store.lock().unwrap().execute("UPDATE pi_tasks SET read_only=1 WHERE id='task'",[]).unwrap();
    let server=tokio::spawn(async move {
        peer.create().await;
        let prompt=peer.read().await;
        let args=json!({"source":"if(typeof process!=='undefined'||typeof fetch!=='undefined')throw Error('native IO');const clock=await tools.read_clock({});const edit=await tools.stage_edit({kind:'settings',path:'/premise',operation:'set',value:'unauthorized',summary:'越权'});store('runs',(load('runs')??0)+1);return {read:clock.ok,write:edit.ok,runs:load('runs')};"});
        let first=peer.tool("script-owned","run_script",args.clone()).await;
        assert_eq!(first["ok"],true,"{first}");
        assert_eq!(first["data"]["value"],json!({"read":true,"write":false,"runs":1}));
        let cached=peer.tool("script-owned","run_script",args).await;
        assert_eq!(cached,first);
        let next=peer.tool("script-next","run_script",json!({"source":"return load('runs');"})).await;
        assert_eq!(next["data"]["value"],1);
        let end=peer.tool("finish","finish_task",json!({"summary":"已只读检查","outcome":"no_changes_needed"})).await;
        assert_eq!(end["ok"],true,"{end}");
        peer.send(json!({"type":"event","sessionId":"pi-session","taskId":"task","event":{"type":"message_end","rawProvider":"HIDDEN-PROVIDER-FIELD","message":{"role":"assistant","timestamp":5,"content":[{"type":"text","text":"可见说明保留"},{"type":"thinking","thinking":"HIDDEN-REASONING"}],"usage":{"input":2,"output":3,"providerPayload":"HIDDEN-PROVIDER-FIELD"}}}})).await;
        peer.reply(&prompt,json!({"text":"只读检查完成"})).await;
        peer.close().await;
        hold.await.unwrap();
    });
    f.create().await;
    bounded(f.host.prompt()).await.unwrap();
    bounded(f.host.detach_session()).await.unwrap();
    release.send(()).unwrap();
    bounded(server).await.unwrap();
    let db=f.store.lock().unwrap();
    let saved:String=db.query_row("SELECT metadata_json FROM pi_tasks WHERE id='task'",[],|r|r.get(0)).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&saved).unwrap()["scriptStore"]["runs"],1);
    assert_eq!(db.query_row("SELECT COUNT(*) FROM pi_calls WHERE task_id='task' AND call_id LIKE 'script-owned:host:%'",[],|r|r.get::<_,i64>(0)).unwrap(),2);
    let settings:String=db.query_row("SELECT settings_json FROM worlds WHERE id='world'",[],|r|r.get(0)).unwrap();
    assert!(!settings.contains("unauthorized"));
    let events:String=db.query_row("SELECT COALESCE(group_concat(event_json),'') FROM pi_events WHERE task_id='task'",[],|r|r.get(0)).unwrap();
    assert!(events.contains("可见说明保留"));assert!(!events.contains("HIDDEN-REASONING")&&!events.contains("HIDDEN-PROVIDER-FIELD"));
}

#[tokio::test]
async fn remote_permissions_and_unknown_effects_are_shared_with_the_native_ledger() {
    use std::sync::atomic::{AtomicUsize,Ordering};
    use sha2::Digest;
    let attempts=Arc::new(AtomicUsize::new(0));let counter=attempts.clone();
    let network:story_core::pi_service::NetworkHost=Arc::new(move|request,_,_|{
        let counter=counter.clone();Box::pin(async move {
            counter.fetch_add(1,Ordering::SeqCst);
            assert_eq!(request["network"]["mcps"][0]["allowedTools"],json!(["read","write"]));
            if request["name"]=="write" {Err(story_core::Error::Invalid("模拟远端结果未确认".into()))} else {Ok(json!({"result":{"content":[{"type":"text","text":"已读自有资料"}]}}))}
        })
    });
    let (f,mut peer)=Fixture::with_network(Some(network));
    let service=json!({"id":"configured","url":"https://fixture.invalid/mcp","slot":"own-slot"});
    let identity=format!("{:x}",sha2::Sha256::digest(service.to_string().as_bytes()));
    let config=json!({"mode":"configured","mcps":[{"id":"configured","url":"https://fixture.invalid/mcp","slot":"own-slot","enabled":true,"authorizationVersion":1,"authorizationIdentity":identity,"allowedTools":["read","write"],"readOnlyTools":["read"]}]});
    f.store.lock().unwrap().execute("UPDATE pi_tasks SET read_only=1,metadata_json=json_set(metadata_json,'$.network',json(?)) WHERE id='task'",[config.to_string()]).unwrap();
    let store=f.store.clone();let (release,hold)=tokio::sync::oneshot::channel();
    let server=tokio::spawn(async move{
        peer.create().await;let prompt=peer.read().await;
        let denied=peer.tool("readonly-write","call_remote_tool",json!({"serverId":"configured","name":"write","arguments":{}})).await;
        assert_eq!(denied["ok"],false);assert_eq!(denied["outcomeUnknown"],false);
        let read=peer.tool("authorized-read","call_remote_tool",json!({"serverId":"configured","name":"read","arguments":{}})).await;
        assert_eq!(read["ok"],true,"{read}");
        store.lock().unwrap().execute("UPDATE pi_tasks SET read_only=0 WHERE id='task'",[]).unwrap();
        let args=json!({"serverId":"configured","name":"write","arguments":{"target":"owned-remote"}});
        let unknown=peer.tool("unknown-write","call_remote_tool",args.clone()).await;
        assert_eq!(unknown["outcomeUnknown"],true);
        let repeat=peer.tool("must-not-replay","call_remote_tool",args).await;
        assert_eq!(repeat["error"]["code"],"outcome_unknown");
        assert_eq!(peer.tool("finish","finish_task",json!({"summary":"本局未修改，远端结果待核对","outcome":"no_changes_needed"})).await["ok"],true);
        peer.reply(&prompt,json!({"text":"远端修改结果未确认"})).await;peer.close().await;hold.await.unwrap();
    });
    f.create().await;bounded(f.host.prompt()).await.unwrap();bounded(f.host.detach_session()).await.unwrap();release.send(()).unwrap();bounded(server).await.unwrap();
    assert_eq!(attempts.load(Ordering::SeqCst),2);
    assert_eq!(f.store.lock().unwrap().query_row("SELECT status FROM pi_calls WHERE task_id='task' AND call_id='unknown-write'",[],|r|r.get::<_,String>(0)).unwrap(),"unknown");
    assert_eq!(f.store.lock().unwrap().query_row("SELECT status FROM pi_calls WHERE task_id='task' AND call_id='readonly-write'",[],|r|r.get::<_,String>(0)).unwrap(),"done");
}

#[tokio::test]
async fn steer_ack_and_assistant_echo_do_not_consume_new_requirements() {
    let (f, mut peer) = Fixture::new();
    let (ready_send, ready) = tokio::sync::oneshot::channel();
    let (checked_send, checked) = tokio::sync::oneshot::channel();
    let (release_send, release) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        peer.create().await;
        let prompt = peer.read().await;
        ready_send.send(()).unwrap();
        let steer = peer.read().await;
        assert_eq!(steer["method"], "steer");
        let marker = steer["params"]["text"].as_str().unwrap().to_owned();
        peer.reply(&steer, Value::Null).await;
        let old = peer
            .tool(
                "old-finish",
                "finish_task",
                json!({"summary":"旧模型尚未处理新要求"}),
            )
            .await;
        assert_eq!(old["ok"], false);
        peer.send(json!({"type":"event","sessionId":"pi-session","taskId":"task","event":{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":marker}]}}})).await;
        checked_send.send(()).unwrap();
        release.await.unwrap();
        peer.send(json!({"type":"event","sessionId":"pi-session","taskId":"task","event":{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":marker}]}}})).await;
        let finish = peer
            .tool(
                "new-finish",
                "finish_task",
                json!({"summary":"读过新要求后无需改动","outcome":"no_changes_needed"}),
            )
            .await;
        assert_eq!(finish["ok"], true, "{finish}");
        peer.reply(&prompt, json!({"text":"已按新要求检查"})).await;
        peer.close().await;
    });
    bounded(f.create()).await;
    let handle = f.host.clone();
    let prompt = tokio::spawn(async move { handle.prompt().await });
    bounded(ready).await.unwrap();
    let input = bounded(f.host.steer("保留玩家主动改写")).await.unwrap();
    bounded(checked).await.unwrap();
    {
        let db = f.store.lock().unwrap();
        let row:(i64,i64,String)=db.query_row("SELECT intent_revision,consumed_intent_revision,(SELECT status FROM pi_inputs WHERE id=?) FROM pi_tasks WHERE id='task'",[input],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(row, (1, 0, "pending".into()));
    }
    release_send.send(()).unwrap();
    let result = bounded(prompt).await.unwrap().unwrap();
    assert_eq!(result["taskReceipt"]["status"], "completed");
    assert_eq!(result["taskReceipt"]["consumedIntentRevision"], 1);
    bounded(f.host.shutdown()).await.unwrap();
    bounded(server).await.unwrap();
}

#[tokio::test]
async fn plain_model_answer_is_not_a_formal_completion() {
    let (f, mut peer) = Fixture::new();
    let server = tokio::spawn(async move {
        peer.create().await;
        let prompt = peer.read().await;
        peer.reply(&prompt, json!({"text":"我已全部改好"})).await;
        peer.close().await;
    });
    bounded(f.create()).await;
    let result = bounded(f.host.prompt()).await.unwrap();
    assert_eq!(result["answer"], "我已全部改好");
    assert_eq!(result["taskReceipt"]["status"], "interrupted");
    assert_eq!(result["taskReceipt"]["result"], Value::Null);
    assert_eq!(
        f.saved("SELECT settings_json FROM worlds")["premise"],
        "PRIVATE-WORLD-SENTINEL"
    );
    bounded(f.host.shutdown()).await.unwrap();
    bounded(server).await.unwrap();
}

#[tokio::test]
async fn dropping_the_page_waiter_keeps_native_run_until_explicit_stop() {
    let (f, mut peer) = Fixture::new();
    let (ready_send, ready) = tokio::sync::oneshot::channel();
    let store = f.store.clone();
    let server = tokio::spawn(async move {
        peer.create().await;
        let prompt = peer.read().await;
        ready_send.send(()).unwrap();
        let abort = peer.read().await;
        assert_eq!(abort["method"], "abort");
        assert!(
            store
                .lock()
                .unwrap()
                .query_row(
                    "SELECT stop_revision FROM pi_tasks WHERE id='task'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap()
                > 0
        );
        peer.reply(&abort, Value::Null).await;
        peer.reply(&prompt, json!({"text":"已停止"})).await;
        peer.close().await;
    });
    bounded(f.create()).await;
    let handle = f.host.clone();
    let waiter = tokio::spawn(async move { handle.prompt().await });
    bounded(ready).await.unwrap();
    waiter.abort();
    let _ = waiter.await;
    assert_eq!(f.host.receipt().unwrap()["status"], "running");
    let stopped = bounded(f.host.stop()).await.unwrap();
    assert_eq!(stopped["abortConfirmed"], true);
    assert_eq!(stopped["taskReceipt"]["status"], "cancelled");
    bounded(f.host.shutdown()).await.unwrap();
    bounded(server).await.unwrap();
}

#[tokio::test]
async fn detach_reuses_node_connection_and_old_host_cannot_control_next_task() {
    let (f, mut peer) = Fixture::new();
    let (second_ready_send, second_ready) = tokio::sync::oneshot::channel();
    let (continue_send, continue_second) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        peer.create().await;
        let first = peer.read().await;
        assert_eq!(first["method"], "prompt");
        let finished = peer
            .tool(
                "finish-one",
                "finish_task",
                json!({"summary":"第一次查阅完成","outcome":"no_changes_needed"}),
            )
            .await;
        assert_eq!(finished["ok"], true, "{finished}");
        peer.reply(&first, json!({"text":"第一次答复"})).await;
        peer.close().await; // Only this Pi session closes; stdin stays open.
        peer.create().await;
        let second = peer.read().await;
        assert_eq!(second["method"], "prompt");
        assert_eq!(second["params"]["taskId"], "task-two");
        second_ready_send.send(()).unwrap();
        continue_second.await.unwrap();
        peer.send(json!({"type":"tool_request","requestId":"finish-two","sessionId":"pi-session","taskId":"task-two","toolCallId":"finish-two","name":"finish_task","args":{"summary":"第二次查阅完成","outcome":"no_changes_needed"}})).await;
        let result = peer.read().await;
        assert_eq!(
            result["method"], "tool_result",
            "old host must not send abort/prompt/close/steer into task two"
        );
        assert_eq!(result["params"]["result"]["ok"], true, "{result}");
        peer.reply(&second, json!({"text":"第二次答复"})).await;
        peer.close().await;
    });
    bounded(f.create()).await;
    let first = bounded(f.host.prompt()).await.unwrap();
    assert_eq!(first["taskReceipt"]["status"], "completed");
    let incoming = bounded(f.host.detach_session()).await.unwrap();
    assert!(!f.connection.is_closed());
    assert!(
        bounded(f.host.detach_session()).await.is_err(),
        "receiver transfer is one-time"
    );
    let gateway = StoryToolGateway::new(f.store.clone());
    gateway
        .start_task(
            "session",
            "task-two",
            "第二次查阅",
            "auto-reversible",
            false,
            json!({"model":"fixture"}),
            json!({}),
        )
        .unwrap();
    let permit = gateway.permit("task-two").unwrap();
    let second = PiTaskHost::attach(f.connection.clone(), incoming, gateway, permit).unwrap();
    let file: String = f
        .store
        .lock()
        .unwrap()
        .query_row(
            "SELECT session_file FROM pi_sessions WHERE id='session'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let directory = PathBuf::from(file)
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    bounded(second.create(PiTaskConfig {
        directory: directory.clone(),
        model: json!({"id":"fixture"}),
        constraints: String::new(),
    }))
    .await
    .unwrap();
    let handle = second.clone();
    let running = tokio::spawn(async move { handle.prompt().await });
    bounded(second_ready).await.unwrap();
    assert!(bounded(f.host.prompt()).await.is_err());
    assert!(bounded(f.host.stop()).await.is_err());
    assert!(bounded(f.host.steer("旧补充")).await.is_err());
    assert!(bounded(f.host.answer("旧回答")).await.is_err());
    assert!(bounded(f.host.create(PiTaskConfig {
        directory,
        model: json!({"id":"fixture"}),
        constraints: String::new()
    }))
    .await
    .is_err());
    bounded(f.host.shutdown()).await.unwrap(); // A detached old handle is inert.
    assert!(!f.connection.is_closed());
    continue_send.send(()).unwrap();
    let result = bounded(running).await.unwrap().unwrap();
    assert_eq!(result["answer"], "第二次答复");
    assert_eq!(result["taskReceipt"]["status"], "completed");
    bounded(second.shutdown()).await.unwrap();
    bounded(server).await.unwrap();
}

#[tokio::test]
async fn input_queued_before_prompt_is_not_submitted_twice() {
    let (f, mut peer) = Fixture::new();
    let server = tokio::spawn(async move {
        peer.create().await;
        let steer = peer.read().await;
        assert_eq!(steer["method"], "steer");
        let marker = steer["params"]["text"].as_str().unwrap().to_string();
        peer.reply(&steer, Value::Null).await;
        let prompt = peer.read().await;
        assert_eq!(
            prompt["method"], "prompt",
            "already acknowledged input must not be queued twice"
        );
        peer.send(json!({"type":"event","sessionId":"pi-session","taskId":"task","event":{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":marker}]}}})).await;
        let finish = peer
            .tool(
                "finish",
                "finish_task",
                json!({"summary":"已核对","outcome":"no_changes_needed"}),
            )
            .await;
        assert_eq!(finish["ok"], true, "{finish}");
        peer.reply(&prompt, json!({"text":"已核对"})).await;
        peer.close().await;
    });
    bounded(f.create()).await;
    bounded(f.host.steer("保留玩家主动分支")).await.unwrap();
    let reply = bounded(f.host.prompt()).await.unwrap();
    assert_eq!(reply["taskReceipt"]["consumedIntentRevision"], 1);
    bounded(f.host.shutdown()).await.unwrap();
    bounded(server).await.unwrap();
}

#[tokio::test]
async fn stop_during_pending_input_cannot_launch_a_prompt_after_abort() {
    let (f, mut peer) = Fixture::new();
    let (ready_send, ready) = tokio::sync::oneshot::channel();
    let store = f.store.clone();
    let server = tokio::spawn(async move {
        peer.create().await;
        let steer = peer.read().await;
        assert_eq!(steer["method"], "steer");
        // Keep this queue acknowledgement outstanding while the player stops.
        ready_send.send(()).unwrap();
        let abort = peer.read().await;
        assert_eq!(
            abort["method"], "abort",
            "no late prompt may cross the stop boundary"
        );
        assert_eq!(
            store
                .lock()
                .unwrap()
                .query_row(
                    "SELECT owner_id FROM world_execution_leases WHERE world_id='world'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "task",
            "lease must stay owned until Pi confirms abort"
        );
        peer.reply(&abort, Value::Null).await;
        peer.close().await;
    });
    bounded(f.create()).await;
    let host = f.host.clone();
    let running = tokio::spawn(async move { host.prompt_text("只核对人物关系").await });
    bounded(ready).await.unwrap();
    let stop = bounded(f.host.stop()).await.unwrap();
    assert_eq!(stop["abortConfirmed"], true);
    assert_eq!(stop["taskReceipt"]["status"], "cancelled");
    assert!(bounded(running).await.unwrap().is_err());
    assert!(bounded(f.host.prompt()).await.is_err());
    let db = f.store.lock().unwrap();
    let input:(i64,i64,String)=db.query_row("SELECT intent_revision,consumed_intent_revision,(SELECT status FROM pi_inputs WHERE task_id='task') FROM pi_tasks WHERE id='task'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!(input, (1, 0, "pending".into()));
    drop(db);
    bounded(f.host.shutdown()).await.unwrap();
    bounded(server).await.unwrap();
}
