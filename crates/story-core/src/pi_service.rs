//! Shared native Agent facade. Pi owns execution and model conversation.
use crate::{
    pi_gateway::StoryToolGateway,
    pi_runtime::{PiTaskConfig, PiTaskHost},
    pi_store::NewSession,
    Error, Result, Store,
};
use pi_host::{AgentConnection, IncomingReceiver};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use std::{
    path::{Component, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::{oneshot, Notify};

pub type ModelResolver = Arc<dyn Fn(&Value) -> Result<Value> + Send + Sync>;
pub type ActivitySink = Arc<dyn Fn(bool) + Send + Sync>;
pub type CommitSink = Arc<dyn Fn(String) + Send + Sync>;
pub type NetworkHost = Arc<dyn Fn(Value,tokio_util::sync::CancellationToken,Option<crate::pi_accounting::NativeModelAccounting>)->crate::chat::BoxFuture<Result<Value>> + Send + Sync>;

#[derive(Clone)]
pub struct AgentHostService(Arc<State>);
struct IdleOperation(AgentHostService);
impl Drop for IdleOperation {
    fn drop(&mut self) {
        if let Ok(mut slot)=self.0.0.slot.lock() {slot.busy=false;}
        self.0.0.changed.notify_waiters();
    }
}
struct Slot {
    incoming: Option<IncomingReceiver>,
    busy: bool,
    task_id: Option<String>,
    host: Option<PiTaskHost>,
}
struct State {
    gateway: StoryToolGateway,
    connection: AgentConnection,
    session_root: PathBuf,
    resolver: ModelResolver,
    activity: ActivitySink,
    committed: CommitSink,
    network: std::sync::RwLock<Option<NetworkHost>>,
    model_http: std::sync::RwLock<Option<crate::pi_http::ModelHttpHost>>,
    slot: Mutex<Slot>,
    changed: Notify,
    closing: AtomicBool,
    stopping: Mutex<std::collections::HashSet<String>>,
    attempt_sink: std::sync::RwLock<Option<Arc<dyn Fn(&str,&str)+Send+Sync>>>,
    control_timeout: std::sync::RwLock<Option<Arc<dyn Fn(&str,&str)+Send+Sync>>>,
}

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| invalid("助手请求缺少必要参数"))
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn page(request: &Value) -> (i64, i64) {
    (
        request["offset"].as_i64().unwrap_or(0).max(0),
        request["limit"].as_i64().unwrap_or(20).clamp(1, 50),
    )
}

/// Main-process control path. No Node launch, connection, resolver or lease renewal.
pub fn persist_stop(store:&Store,request:&Value)->Result<Value>{
    crate::pi_lifecycle::request_stop(store,required(request,"taskId")?,required(request,"attemptId")?,required(request,"requestId")?)
}
pub fn control_state(store:&Store,request:&Value)->Result<Value>{crate::pi_lifecycle::state(store,required(request,"taskId")?,required(request,"attemptId")?)}
pub fn timeout_stop(store:&Store,request:&Value)->Result<Option<Value>>{
    crate::pi_lifecycle::timeout_stop(store,required(request,"taskId")?,required(request,"attemptId")?)
}
/// Never forward secret material or an endpoint supplied by a UI into the
/// resolver. The platform resolves its current slot binding independently.
fn model_reference(saved: &Value, request: &Value) -> Value {
    let mut result = Map::new();
    for source in [saved, &request["model"]] {
        if source["slot"].as_str().is_some_and(|slot|result.get("slot").and_then(Value::as_str)!=Some(slot)) && !source["profileId"].is_string() {
            result.remove("profileId");
        }
        if source["profileId"].as_str().is_some_and(|id|result.get("profileId").and_then(Value::as_str)!=Some(id)) && !source["slot"].is_string() {
            result.remove("slot");
        }
        if source["model"].is_string()&&!source["id"].is_string(){result.remove("id");}
        if source["id"].is_string()&&!source["model"].is_string(){result.remove("model");}
        for key in [
            "profileId",
            "slot",
            "id",
            "model",
            "name",
            "protocol",
            "inputTokens",
            "contextTokens",
            "contextWindowTokens",
            "maxOutputTokens",
            "reasoning",
            "temperature",
            "topP",
            "endpointRef",
        ] {
            if let Some(value) = source.get(key).filter(|v| !v.is_object() && !v.is_array()) {
                result.insert(key.into(), value.clone());
            }
        }
    }
    for key in [
        "profileId",
        "protocol",
        "contextWindowTokens",
        "maxOutputTokens",
        "inputTokens",
    ] {
        if let Some(value) = request
            .get(key)
            .filter(|v| !v.is_object() && !v.is_array() && !v.is_null())
        {
            if key=="profileId" && result.get(key)!=Some(value) && !request["model"]["slot"].is_string() {result.remove("slot");}
            result.insert(key.into(), value.clone());
        }
    }
    let input = result
        .get("inputTokens")
        .or_else(|| result.get("contextTokens"))
        .cloned()
        .unwrap_or(json!(475000));
    result.insert("inputTokens".into(), input);
    result.entry("maxOutputTokens").or_insert(json!(8192));
    // Only saved endpoint locators survive task persistence. A UI address is
    // transient and is checked against native settings by the resolver.
    if ["profileId","slot","protocol"].iter().any(|key|saved.get(*key).is_some()&&result.get(*key)!=saved.get(*key)) {result.remove("endpointRef");}
    if let Some(url)=request.get("modelUrl") {
        result.remove("endpointRef");
        if url.as_str().is_some_and(|v|!v.trim().is_empty()){result.insert("modelUrl".into(),url.clone());}
    }
    Value::Object(result)
}

fn task_metadata(request:&Value)->Result<Value> {
    let selected=request["skills"].as_array().cloned().unwrap_or_default();
    let custom=request["customSkills"].as_array().cloned().unwrap_or_default();
    if selected.len()>64 || custom.len()>64 || serde_json::to_vec(&custom)?.len()>8*1024*1024 {return Err(invalid("本次技能包过多，请只选择需要的技能"));}
    let mut snapshots=crate::skills::catalog_json().as_array().into_iter().flatten().filter_map(|s|s["name"].as_str()).map(crate::skills::read).collect::<Result<Vec<_>>>()?;
    for skill in &mut snapshots {skill["hash"]=crate::pi_store::arguments_hash(skill).into();}
    let mut names=std::collections::HashSet::new();
    for skill in snapshots.iter().chain(custom.iter()) {
        let id=skill["id"].as_str().unwrap_or_else(||text(skill,"name"));
        if id.is_empty() || !names.insert(id.to_owned()) {return Err(invalid("技能标识缺失或重复，请重新选择技能"));}
    }
    if selected.iter().any(|id|!id.as_str().is_some_and(|id|names.contains(id))) {return Err(invalid("指定技能不在本次可用目录中"));}
    Ok(json!({"capabilityPhase":"pi-tools","skills":selected,"skillSnapshots":snapshots,"customSkills":custom,"network":crate::pi_network::snapshot(&request["network"])? ,"limits":crate::pi_budget::limits(request)?,"target":request["target"],"queuedInputId":request["queuedInputId"],"enabledTools":[]}))
}

#[cfg(test)]
mod reference_tests {
    use super::*;
    #[test]
    fn explicitly_selected_service_and_model_do_not_inherit_old_locators_or_credentials() {
        let saved=json!({"profileId":"old-profile","slot":"old-slot","id":"old-model","protocol":"chat-completions","inputTokens":12000});
        let reference=model_reference(&saved,&json!({"model":{"slot":"chosen-slot","model":"chosen-model","protocol":"anthropic","apiKey":"UI-CANNOT-AUTHORIZE","baseUrl":"https://untrusted.invalid"},"inputTokens":24000}));
        assert!(reference["profileId"].is_null()&&reference["id"].is_null());
        assert_eq!(reference["slot"],"chosen-slot");assert_eq!(reference["model"],"chosen-model");assert_eq!(reference["protocol"],"anthropic");assert_eq!(reference["inputTokens"],24000);
        assert!(reference["apiKey"].is_null()&&reference["baseUrl"].is_null());
        let profile=model_reference(&saved,&json!({"profileId":"chosen-profile"}));
        assert_eq!(profile["profileId"],"chosen-profile");assert!(profile["slot"].is_null());
        let unchanged=model_reference(&saved,&json!({"model":{"slot":"old-slot","model":"new-name"}}));
        assert_eq!(unchanged["profileId"],"old-profile");assert!(unchanged["id"].is_null());assert_eq!(unchanged["model"],"new-name");
    }
}

impl AgentHostService {
    pub fn new(
        store: Store,
        connection: AgentConnection,
        incoming: IncomingReceiver,
        session_root: PathBuf,
        resolver: ModelResolver,
        activity: ActivitySink,
        committed: CommitSink,
    ) -> Result<Self> {
        if !session_root.is_absolute()
            || session_root
                .components()
                .any(|c| matches!(c, Component::ParentDir))
        {
            return Err(invalid("原生助手目录必须是绝对路径"));
        }
        std::fs::create_dir_all(&session_root).map_err(|_| invalid("无法准备原生助手目录"))?;
        crate::pi_store::PiStore(store.clone()).initialize()?;
        crate::pi_lifecycle::reconcile(&store)?;
        Ok(Self(Arc::new(State {
            gateway: StoryToolGateway::new(store),
            connection,
            session_root,
            resolver,
            activity,
            committed,
            network: std::sync::RwLock::new(None),
            model_http: std::sync::RwLock::new(None),
            slot: Mutex::new(Slot {
                incoming: Some(incoming),
                busy: false,
                task_id: None,
                host: None,
            }),
            changed: Notify::new(),
            closing: AtomicBool::new(false),
            stopping: Mutex::new(std::collections::HashSet::new()),
            attempt_sink: std::sync::RwLock::new(None),
            control_timeout: std::sync::RwLock::new(None),
        })))
    }

    pub async fn isolate_attempt(&self,task:&str,attempt:&str)->Result<bool>{
        let matched={let slot=self.0.slot.lock().map_err(|_|Error::Cancelled)?;slot.task_id.as_deref()==Some(task)&&slot.host.as_ref().is_some_and(|h|h.attempt_id()==attempt)};
        if !matched{return Ok(false);}self.0.closing.store(true,Ordering::Release);self.0.connection.close_transport().await;
        let callback=self.0.control_timeout.read().unwrap_or_else(|p|p.into_inner()).clone();if let Some(callback)=callback{callback(task,attempt);}Ok(true)
    }
    pub fn set_attempt_sink(&self,sink:Arc<dyn Fn(&str,&str)+Send+Sync>){*self.0.attempt_sink.write().unwrap_or_else(|p|p.into_inner())=Some(sink);}
    pub fn set_control_timeout(&self,sink:Arc<dyn Fn(&str,&str)+Send+Sync>) {
        *self.0.control_timeout.write().unwrap_or_else(|p|p.into_inner())=Some(sink);
    }
    pub fn usable(&self)->bool { !self.0.closing.load(Ordering::Acquire) && !self.0.connection.is_closed() && self.0.slot.lock().is_ok_and(|s|s.busy||s.incoming.is_some()) }
    pub fn active_task(&self) -> Option<String> {
        self.0.slot.lock().ok().and_then(|s| s.task_id.clone())
    }
    /// Hosts inject their existing native credential/TLS/network adapter once,
    /// before publishing this facade. It never becomes a second model loop.
    pub fn set_network(&self,network:NetworkHost)->Result<()> {
        let slot=self.0.slot.lock().map_err(|_|Error::Cancelled)?;
        if slot.busy||self.0.closing.load(Ordering::Acquire){return Err(invalid("运行中不能替换网络宿主"));}
        *self.0.network.write().map_err(|_|Error::Cancelled)?=Some(network);
        Ok(())
    }
    pub fn set_model_http(&self,host:crate::pi_http::ModelHttpHost)->Result<()> {
        let slot=self.0.slot.lock().map_err(|_|Error::Cancelled)?;
        if slot.busy||self.0.closing.load(Ordering::Acquire){return Err(invalid("运行中不能替换模型传输宿主"));}
        *self.0.model_http.write().map_err(|_|Error::Cancelled)?=Some(host);Ok(())
    }

    pub async fn request(&self, request: Value) -> Result<Value> {
        if self.0.closing.load(Ordering::Acquire) && !["stop","snapshot","delta","process_page","poll_session","session","list","search"].contains(&text(&request,"op")) {
            return Err(invalid("原生助手正在关闭"));
        }
        if ["list","search","session","poll_session","snapshot","delta"].contains(&text(&request,"op")) {
            crate::pi_lifecycle::reconcile(&self.0.gateway.0.0)?;
        }
        match text(&request, "op") {
            "resume_check"=>crate::pi_resume::check(&self.0.gateway.0.0,&request),
            "package_import"|"package_drafts"|"package_adopt"=>{
                let mut scoped=request.clone();scoped["_piOnly"]=true.into();
                crate::agent_packages::rpc(&self.0.gateway.0.0,&scoped)?.ok_or_else(||invalid("该技能包操作不存在"))
            }
            "answer_question" => {
                let id=required(&request,"taskId")?;
                self.wait_idle(Some(id)).await?;
                let answer=crate::pi_questions::answer(&self.0.gateway.0,&request)?;
                if answer["cancelled"]==true || answer["duplicate"]==true {return Ok(answer);}
                let mut next=request.clone();
                next["op"]="continue".into();
                // The answer is already a durable input; do not append it a
                // second time as an ordinary supplement.
                next["text"]=Value::Null;
                let this=self.clone();let(send,receive)=oneshot::channel();
                tokio::spawn(async move{this.run_task(next,send).await;});
                receive.await.map_err(|_|invalid("回答已保存，原生助手尚未恢复"))
                    .and_then(|v|v).map(|run|json!({"answer":answer,"run":run}))
            }
            "start" | "continue" => {
                let this = self.clone();
                let (send, receive) = oneshot::channel();
                // This owner survives a dropped UI waiter while resolving,
                // creating, prompting and returning the shared receiver.
                tokio::spawn(async move {
                    if text(&request,"op")=="continue" {
                        if let Err(error)=this.wait_idle(request["taskId"].as_str()).await {let _=send.send(Err(error));return;}
                    }
                    this.run_task(request, send).await;
                });
                receive.await.map_err(|_| invalid("原生助手未能建立任务"))?
            }
            "compact"=>{
                let id=required(&request,"taskId")?;
                let row=self.0.gateway.0.task(id)?;
                if !["running","interrupted","cancelled","paused","failed","blocked"].contains(&text(&row,"status")){return Err(invalid("只可整理尚未完成的任务；等待问题时请先回答或取消问题"));}
                if request.get("instructions").is_some_and(|v|!v.is_null()&&!v.is_string()){return Err(invalid("整理说明须为文字"));}
                if request["instructions"].as_str().is_some_and(|s|s.encode_utf16().count()>100000){return Err(invalid("整理说明过长，请缩短说明"));}
                self.stop_task(&json!({"taskId":id})).await?;
                self.wait_idle(Some(id)).await?;
                let mut next=request;next["op"]="continue".into();next["_operation"]="compact".into();next["text"]=Value::Null;
                let this=self.clone();let(send,receive)=oneshot::channel();
                tokio::spawn(async move{this.run_task(next,send).await;});
                receive.await.map_err(|_|invalid("原生上下文整理尚未开始"))?
            }
            "stop_status" => control_state(&self.0.gateway.0.0,&request),
            "stop" => {
                let id=required(&request,"taskId")?.to_owned();
                let expected=required(&request,"attemptId")?.to_owned();
                let nonce=request["requestId"].as_str().map(str::to_owned).unwrap_or_else(||uuid::Uuid::new_v4().to_string());
                let receipt=crate::pi_lifecycle::request_stop(&self.0.gateway.0.0,&id,&expected,&nonce)?;
                if receipt["settled"]!=true && self.0.stopping.lock().map_err(|_|Error::Cancelled)?.insert(expected.clone()) {
                    let this=self.clone();
                    tokio::spawn(async move {
                        let matched={let slot=this.0.slot.lock().unwrap_or_else(|p|p.into_inner());slot.task_id.as_deref()==Some(&id)&&slot.host.as_ref().is_some_and(|host|host.attempt_id()==expected)};
                        if !matched {
                            // A missing local owner is not permission to stop a
                            // fresh different process. Persisted cancellation
                            // fences writes, and expiry reconciliation settles it.
                            let _=crate::pi_lifecycle::reconcile(&this.0.gateway.0.0);
                            tokio::time::sleep(Duration::from_secs(15)).await;
                            let _=crate::pi_lifecycle::settle(&this.0.gateway.0.0,&id,&expected,"停止已保存，失联执行已隔离，要求与草稿保留");
                            return;
                        }
                        let stopped=tokio::time::timeout(Duration::from_secs(15),this.stop_task(&json!({"taskId":id}))).await;
                        if !matches!(stopped,Ok(Ok(_))) {
                            this.0.closing.store(true,Ordering::Release);
                            this.0.connection.close_transport().await;
                            let _=crate::pi_lifecycle::settle(&this.0.gateway.0.0,&id,&expected,"玩家已停止，专用宿主收尾超时，进度与草稿已保留");
                            (this.0.activity)(false);
                            let callback=this.0.control_timeout.read().unwrap_or_else(|p|p.into_inner()).clone();
                            if let Some(callback)=callback {callback(&id,&expected);}
                        }
                    });
                }
                Ok(receipt)
            }
            "enqueue_input" => {
                let id=required(&request,"taskId")?;
                let value=required(&request,"text")?.trim();
                if value.encode_utf16().count()>100000{return Err(invalid("补充要求过长，请分次发送"));}
                if request["delivery"]=="queued" {
                    let task=self.0.gateway.0.task(id)?;
                    let mut reference=model_reference(&task["model_json"],&request["request"]);
                    let resolver=self.0.resolver.clone();let fresh=reference.clone();
                    let wire=tokio::task::spawn_blocking(move||(resolver)(&fresh)).await.map_err(|_|invalid("排队任务的模型配置未能保存"))??;
                    reference.as_object_mut().unwrap().remove("modelUrl");
                    if let Some(endpoint)=wire["endpointRef"].as_str(){reference["endpointRef"]=endpoint.into();}else{reference.as_object_mut().unwrap().remove("endpointRef");}
                    let mut scoped=request.clone();
                    if !scoped["request"].is_object(){scoped["request"]=json!({});}
                    scoped["request"]["model"]=reference;
                    scoped["request"].as_object_mut().unwrap().remove("modelUrl");
                    return crate::pi_control::enqueue(&self.0.gateway.0,&scoped);
                }
                if request["delivery"]!="steer" {return Err(invalid("输入方式无效"));}
                let host=self.task_host(id)?;
                let input=host.steer_named(value,required(&request,"id")?).await?;
                Ok(json!({"id":input,"delivery":"steer","status":"pending","accepted":true}))
            }
            "cancel_queued" => crate::pi_control::cancel_queued(&self.0.gateway.0,required(&request,"inputId")?),
            "network_authorize"=>crate::pi_capabilities::authorize_network(&self.0.gateway.0.0,&request["network"]),
            "toolpkg_import"=>crate::pi_toolpkg::import(&self.0.gateway.0.0,&request).await,
            "toolpkg_cancel_import"=>crate::pi_toolpkg::cancel_import(&request),
            "toolpkg_list"=>Ok(json!({"packages":crate::pi_toolpkg::list(&*self.0.gateway.0.0.lock()?)?})),
            "toolpkg_adopt"=>crate::pi_toolpkg::adopt(&*self.0.gateway.0.0.lock()?,&request),
            "toolpkg_enable"=>crate::pi_toolpkg::enable(&*self.0.gateway.0.0.lock()?,&request),
            "external_inspect"=>crate::pi_external::inspect(&*self.0.gateway.0.0.lock()?,&request),
            "document_grants"=>Ok(json!({"grants":crate::pi_documents::list(&*self.0.gateway.0.0.lock()?)?})),
            "document_revoke"=>crate::pi_documents::revoke(&*self.0.gateway.0.0.lock()?,required(&request,"id")?),
            "network_tools"=>{
                let network=self.0.network.read().map_err(|_|Error::Cancelled)?.clone().ok_or_else(||invalid("此宿主尚未接通联网"))?;
                let mut config=crate::pi_network::snapshot(&request["network"])?;
                config["mode"]="configured".into();
                network(json!({"op":"list_remote_tools","network":config,"serverId":request["serverId"],"userDiscovery":true,"limit":500}),tokio_util::sync::CancellationToken::new(),None).await
            }
            "poll_session" => {let mut request=request;request["metadataOnly"]=true.into();self.session_detail(&request)},
            "delta" => self.delta(&request),
            "process_page"=>self.process_page(&request),
            "snapshot" => self.snapshot(
                request["taskId"]
                    .as_str()
                    .or_else(|| request["id"].as_str())
                    .ok_or_else(|| invalid("缺少任务标识"))?,
                request["after"].as_u64().unwrap_or(0),
                request["limit"].as_u64().unwrap_or(100) as usize,
            ),
            "list"|"search" => self.list(&request),
            "fork"=>{
                let this=self.clone();let(send,receive)=oneshot::channel();
                tokio::spawn(async move{let result=this.fork_session(&request).await;let _=send.send(result);});
                receive.await.map_err(|_|invalid("对话分支尚未保存"))?
            }
            "delete"=>{
                let id=required(&request,"id")?;
                let active={let slot=self.0.slot.lock().map_err(|_|Error::Cancelled)?;
                    if slot.busy&&slot.task_id.is_none(){return Err(invalid("助手正在启动，请稍后删除会话"));}
                    slot.task_id.clone()
                };
                if let Some(task)=active {
                    let row=self.0.gateway.0.task(&task)?;
                    if row["session_id"]==id {self.stop_task(&json!({"taskId":task})).await?;}
                }
                crate::pi_sessions::delete(&self.0.gateway.0,&self.0.session_root,id)
            }
            "create" => {
                let id = uuid::Uuid::new_v4().to_string();
                let title = request["title"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("Agent 助手");
                self.0.gateway.create_session(&NewSession {
                    id: id.clone(),
                    world_id: required(&request, "worldId")?.into(),
                    line_id: required(&request, "lineId")?.into(),
                    title: title.chars().take(80).collect(),
                    session_file: None,
                })?;
                self.session_summary(&id)
            }
            "session" => self.session_detail(&request),
            "rename" => {
                let title = required(&request, "title")?.trim();
                if title.chars().count() > 80 {
                    return Err(invalid("会话名称请控制在80字内"));
                }
                let id = required(&request, "id")?;
                let changed = self.0.gateway.0 .0.lock()?.execute(
                    "UPDATE pi_sessions SET title=?,updated_at=? WHERE id=?",
                    params![title, chrono::Utc::now().to_rfc3339(), id],
                )?;
                if changed == 0 {
                    return Err(invalid("这项Pi会话不存在，旧会话不能继续执行"));
                }
                self.session_summary(id)
            }
            "apply" => {
                let result = self
                    .0
                    .gateway
                    .adopt_preview(required(&request, "taskId")?)?;
                if result["worldChanged"] == true {
                    let row = self.0.gateway.0.task(required(&request, "taskId")?)?;
                    (self.0.committed)(text(&row, "world_id").into());
                }
                Ok(result)
            }
            "recoveries"=>{let world=required(&request,"worldId")?;let db=self.0.gateway.0.0.lock()?;Ok(json!({"points":crate::agent_workspace::rows(&db,"SELECT id,task_id AS taskId,created_at AS createdAt,json_extract(result_json,'$.summary') AS summary FROM story_recovery_points WHERE world_id=? ORDER BY created_at DESC LIMIT 100",&[&world])?}))},
            "restore_recovery"=>{let result=self.0.gateway.undo_recovery(required(&request,"id")?)?;(self.0.committed)(text(&result,"worldId").into());Ok(result)},
            "undo" => {
                let id = required(&request, "taskId")?;
                let recovery:Option<String>=self.0.gateway.0.0.lock()?.query_row("SELECT id FROM story_recovery_points WHERE task_id=? ORDER BY created_at DESC LIMIT 1",[id],|r|r.get(0)).optional()?;
                let result = self.0.gateway.undo_recovery(
                    recovery
                        .as_deref()
                        .ok_or_else(|| invalid("这项任务没有可撤回的恢复点"))?,
                )?;
                (self.0.committed)(text(&result, "worldId").into());
                Ok(result)
            }
            _ => Err(invalid("该助手操作尚未接入Pi服务；不会转交旧执行引擎")),
        }
    }

    fn session_summary(&self, id: &str) -> Result<Value> {
        let row = self.0.gateway.0.session(id)?;
        Ok(
            json!({"id":row["id"],"worldId":row["world_id"],"lineId":row["line_id"],"title":row["title"],"createdAt":row["created_at"],"updatedAt":row["updated_at"]}),
        )
    }
    async fn fork_session(&self,request:&Value)->Result<Value> {
        let source=required(request,"sessionId")?;self.directory_name(source)?;
        let message=required(request,"messageId")?;
        let _operation={
            let mut slot=self.0.slot.lock().map_err(|_|Error::Cancelled)?;
            if slot.busy||self.0.closing.load(Ordering::Acquire){return Err(invalid("请先停止当前执行，再另起对话"));}
            slot.busy=true;IdleOperation(self.clone())
        };
        let saved=self.0.gateway.0.session(source)?;
        let file=required(&saved,"session_file")?;
        let directory=self.0.session_root.join(source);
        crate::pi_runtime::require_owned_path(&directory,std::path::Path::new(file))?;
        let entry={let db=self.0.gateway.0.0.lock()?;crate::pi_forks::anchor(&db,source,message)?};
        let id=uuid::Uuid::new_v4().to_string();
        let target=self.0.session_root.join(&id);
        let made=self.0.connection.request("fork_session",json!({"sourceFile":file,"targetDirectory":target,"entryId":entry})).await.map_err(|_|invalid("Pi未能建立完整对话分支；原会话与故事未变"))?;
        if let Some(path)=made["sessionFile"].as_str(){crate::pi_runtime::require_owned_path(&target,std::path::Path::new(path))?;}
        if !made["sessionFile"].is_null()&&!made["sessionFile"].is_string(){return Err(invalid("Pi分支位置无效"));}
        let mut messages={let db=self.0.gateway.0.0.lock()?;crate::pi_forks::inherited(&db,source)?};
        let tasks={let db=self.0.gateway.0.0.lock()?;crate::agent_workspace::rows(&db,"SELECT id FROM pi_tasks WHERE session_id=? ORDER BY created_at,id",&[&source])?};
        for task in tasks {
            let task_id=text(&task,"id");let row=self.0.gateway.0.task(task_id)?;
            let inputs=crate::pi_control::inputs(&self.0.gateway.0,source,Some(task_id))?;
            messages.extend(crate::pi_projection::messages(&row,&self.projection_events(task_id)?,&inputs));
        }
        let title=request["title"].as_str().filter(|v|!v.trim().is_empty()).map(str::to_owned).unwrap_or_else(||format!("{} · 分支",text(&saved,"title"))).chars().take(80).collect();
        {
            let mut db=self.0.gateway.0.0.lock()?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let still:Option<Option<String>>=tx.query_row("SELECT session_file FROM pi_sessions WHERE id=?",[source],|r|r.get(0)).optional()?;
            if still.flatten().as_deref()!=Some(file){return Err(invalid("原会话已变化，未保存分支"));}
            crate::pi_store::create_session_tx(&tx,&NewSession{id:id.clone(),world_id:text(&saved,"world_id").into(),line_id:text(&saved,"line_id").into(),title,session_file:made["sessionFile"].as_str().map(str::to_owned)})?;
            crate::pi_forks::save_history(&tx,source,&id,&made["keptEntryIds"],&messages)?;
            tx.commit()?;
        }
        let mut result=self.session_summary(&id)?;
        let selected=made["selectedUserText"].as_str().map(|value| {
            // The nonce belongs to native delivery, not to a player's draft.
            // Removing this presentation marker grants no task authority.
            if value.starts_with("【本次补充标识 ") {value.split_once("】\n").map(|(_,body)|body).unwrap_or(value)}else{value}
        });
        result["selectedUserText"]=json!(selected);result["storyChanged"]=false.into();
        Ok(result)
    }
    fn list(&self, request: &Value) -> Result<Value> {
        let (offset, limit) = page(request);
        let ids = {
            let db = self.0.gateway.0 .0.lock()?;
            let mut statement=db.prepare("SELECT s.id FROM pi_sessions s WHERE s.world_id=? AND s.line_id=? AND (?='' OR instr(s.title,?)>0 OR EXISTS(SELECT 1 FROM pi_session_messages h WHERE h.session_id=s.id AND instr(json_extract(h.message_json,'$.content'),?)>0) OR EXISTS(SELECT 1 FROM pi_tasks t WHERE t.session_id=s.id AND (instr(t.text,?)>0 OR EXISTS(SELECT 1 FROM pi_events e,json_each(CASE WHEN json_type(e.event_json,'$.event.message.content')='array' THEN json_extract(e.event_json,'$.event.message.content') ELSE '[]' END) p WHERE e.task_id=t.id AND json_extract(e.event_json,'$.event.message.role')='assistant' AND json_extract(p.value,'$.type')='text' AND instr(json_extract(p.value,'$.text'),?)>0)))) ORDER BY s.updated_at DESC,s.id LIMIT ? OFFSET ?")?;
            let query=text(request,"query").trim();
            let rows = statement.query_map(
                params![
                    required(request, "worldId")?,
                    required(request, "lineId")?,
                    query,query,query,query,query,
                    limit + 1,
                    offset
                ],
                |r| r.get::<_, String>(0),
            )?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let more = ids.len() > limit as usize;
        let sessions = ids
            .into_iter()
            .take(limit as usize)
            .map(|id| self.session_summary(&id))
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({"sessions":sessions,"nextOffset":if more{Some(offset+limit)}else{None}}))
    }
    fn session_detail(&self, request: &Value) -> Result<Value> {
        let id = required(request, "id")?;
        let session = self.session_summary(id)?;
        let (offset, limit) = page(request);
        let ids = {
            let db = self.0.gateway.0 .0.lock()?;
            let mut stmt=db.prepare("SELECT id FROM pi_tasks WHERE session_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?")?;
            let rows = stmt.query_map(params![id, limit + 1, offset], |r| r.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let more = ids.len() > limit as usize;
        let mut tasks = ids
            .into_iter()
            .take(limit as usize)
            .map(|id| self.task_summary(&id))
            .collect::<Result<Vec<_>>>()?;
        tasks.reverse();
        let inputs=crate::pi_control::inputs(&self.0.gateway.0,id,None)?;
        let mut messages=if !more && request["metadataOnly"]!=true {let db=self.0.gateway.0.0.lock()?;crate::pi_forks::inherited(&db,id)?}else{vec![]};
        for task in tasks.iter().filter(|_|request["metadataOnly"]!=true) {
            let row=self.view_task(text(task,"id"))?;
            let events=self.projection_events(text(task,"id"))?;
            messages.extend(crate::pi_projection::messages(&row,&events,&inputs));
        }
        let mut remaining=1_000_000_usize;
        for message in messages.iter_mut().rev() {
            let content=text(message,"content");
            if content.len()>remaining {
                let mut end=remaining.min(content.len());while !content.is_char_boundary(end){end-=1;}
                let clipped=content[..end].to_owned();message["content"]=clipped.into();message["truncated"]=true.into();
            }
            remaining=remaining.saturating_sub(text(message,"content").len());
        }
        messages.retain(|message|!text(message,"content").is_empty());
        Ok(json!({"session":session,"messages":messages,"tasks":tasks,"inputs":inputs,"projectionTruncated":remaining==0,"nextOffset":if more{Some(offset+limit)}else{None}}))
    }
    fn view_task(&self,id:&str)->Result<Value>{
        let db=self.0.gateway.0.0.lock()?;let mut row=crate::agent_workspace::rows(&db,"SELECT id,session_id,world_id,line_id,text,status,policy,read_only,base_world_version,model_json,metadata_json,lease_json,plan_json,question_json,stop_revision,result_json,error,created_at,updated_at FROM pi_tasks WHERE id=?",&[&id])?.into_iter().next().ok_or_else(||invalid("这项助手记录不存在"))?;
        if let Some(object)=row.as_object_mut(){for(key,value)in object{if key.ends_with("_json")&&value.is_string(){*value=crate::agent_workspace::parse(value.as_str().unwrap());}}}Ok(row)
    }
    fn task_summary(&self, id: &str) -> Result<Value> {
        let row = self.view_task(id)?;
        let result = &row["result_json"];
        let execution=crate::pi_lifecycle::execution(&*self.0.gateway.0.0.lock()?,&row)?;
        let budget = crate::pi_budget::read_budget(&*self.0.gateway.0.0.lock()?,id)?;
        let recovery: bool = self.0.gateway.0 .0.lock()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM story_recovery_points WHERE task_id=?)",
            [id],
            |r| r.get(0),
        )?;
        Ok(
            json!({"id":row["id"],"runId":row["id"],"sessionId":row["session_id"],"text":row["text"],"status":row["status"],"phase":if row["status"]=="running"&&row["metadata_json"]["activeOperation"]=="compact"{json!("compacting")}else{row["status"].clone()},"policy":row["policy"],"readOnly":row["read_only"]==1,"execution":execution,
            "model":row["model_json"],"inputTokens":row["model_json"]["inputTokens"],"limits":budget["limits"],"budget":budget,"plan":row["plan_json"],"question":row["question_json"],"inputs":crate::pi_control::inputs(&self.0.gateway.0,text(&row,"session_id"),Some(id))?,
            "summary":result["summary"],"preview":result["preview"],"changes":result["changes"],"result":result,"error":row["error"],"canUndo":recovery,"contextCheckpoint":row["metadata_json"]["contextCheckpoint"],"contextState":row["metadata_json"]["contextState"],
            "createdAt":row["created_at"],"updatedAt":row["updated_at"]}),
        )
    }
    pub fn snapshot(&self, task_id: &str, after: u64, limit: usize) -> Result<Value> {
        let task = self.task_summary(task_id)?;
        let row = self.view_task(task_id)?;
        let limit = limit.clamp(1, 200);
        let mut events = {
            let db = self.0.gateway.0 .0.lock()?;
            let mut stmt=db.prepare("SELECT seq,event_json FROM pi_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?")?;
            let rows = stmt.query_map(
                params![
                    task_id,
                    after.min(i64::MAX as u64) as i64,
                    (limit + 1) as i64
                ],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )?;
            rows.map(|r| {
                let (seq, event) = r?;
                Ok(json!({"seq":seq,"event":serde_json::from_str::<Value>(&event)?}))
            })
            .collect::<Result<Vec<_>>>()?
        };
        let more = events.len() > limit;
        events.truncate(limit);
        let next = events
            .last()
            .and_then(|e| e["seq"].as_u64())
            .unwrap_or(after);
        let all_events=self.projection_events(task_id)?;
        let calls=self.projection_calls(task_id)?;
        let inputs=crate::pi_control::inputs(&self.0.gateway.0,text(&row,"session_id"),Some(task_id))?;
        let messages=crate::pi_projection::messages(&row,&all_events,&inputs);
        let steps=crate::pi_projection::steps(&all_events,&calls);
        Ok(json!({"id":task_id,"worldId":row["world_id"],"status":row["status"],"task":task,"result":row["result_json"],"error":row["error"],"events":events,"hasMore":more,"nextAfter":next,"messages":messages,"steps":steps}))
    }

    fn delta(&self,request:&Value)->Result<Value> {
        let id=required(request,"taskId")?;let after=request["after"].as_u64().unwrap_or(0);let call_after=request["callAfter"].as_i64().unwrap_or(0);
        let task=self.task_summary(id)?;let row=self.view_task(id)?;
        let (mut events,calls,next_call,call_more)={
            let db=self.0.gateway.0.0.lock()?;
            let mut stmt=db.prepare("SELECT seq,event_json FROM pi_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 201")?;
            let events=stmt.query_map(params![id,after.min(i64::MAX as u64) as i64],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?)))?.map(|row|{let(seq,raw)=row?;Ok(json!({"seq":seq,"event":crate::agent_workspace::parse(&raw)}))}).collect::<Result<Vec<_>>>()?;
            let mut stmt=db.prepare("SELECT seq,call_id FROM pi_call_updates WHERE task_id=? AND seq>? ORDER BY seq LIMIT 201")?;
            let updates=stmt.query_map(params![id,call_after],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
            let more=updates.len()>200;let updates=updates.into_iter().take(200).collect::<Vec<_>>();let next=updates.last().map(|r|r.0).unwrap_or(call_after);
            let ids=updates.into_iter().map(|r|r.1).collect::<std::collections::BTreeSet<_>>();let mut calls=vec![];
            for call in ids {let raw:Value=crate::agent_workspace::rows(&db,"SELECT rowid AS seq,call_id,task_id,tool,status,output_json FROM pi_calls WHERE task_id=? AND call_id=?",&[&id,&call])?.into_iter().next().unwrap_or(Value::Null);let mut raw=raw;raw["output_json"]=crate::pi_projection::summary_result(&crate::agent_workspace::parse(text(&raw,"output_json")));calls.push(raw);}
            (events,calls,next,more)
        };
        let more=events.len()>200;events.truncate(200);let next=events.last().and_then(|e|e["seq"].as_u64()).unwrap_or(after);
        let inputs=crate::pi_control::inputs(&self.0.gateway.0,text(&row,"session_id"),Some(id))?;
        let messages=crate::pi_projection::messages(&row,&events,&inputs);let steps=crate::pi_projection::steps(&events,&calls);
        Ok(json!({"id":id,"worldId":row["world_id"],"task":task,"status":row["status"],"result":row["result_json"],"error":row["error"],"events":events,"messages":messages,"steps":steps,"incremental":true,"nextAfter":next,"hasMore":more,"nextCallAfter":next_call,"hasMoreCalls":call_more}))
    }
    fn process_page(&self,request:&Value)->Result<Value> {
        let id=required(request,"taskId")?;let before=request["before"].as_i64().unwrap_or(i64::MAX);
        let db=self.0.gateway.0.0.lock()?;let mut rows=crate::agent_workspace::rows(&db,"SELECT rowid AS position,rowid AS seq,call_id,task_id,tool,status,output_json FROM pi_calls WHERE task_id=? AND rowid<? ORDER BY rowid DESC LIMIT 101",&[&id,&before])?;
        let more=rows.len()>100;rows.truncate(100);let next=rows.last().map(|r|r["position"].clone()).unwrap_or(Value::Null);
        for row in &mut rows {row["output_json"]=crate::pi_projection::summary_result(&crate::agent_workspace::parse(text(row,"output_json")));}
        rows.reverse();Ok(json!({"steps":crate::pi_projection::steps(&[],&rows),"nextBefore":if more{next}else{Value::Null}}))
    }
    fn projection_events(&self,id:&str)->Result<Vec<Value>> {
        let db=self.0.gateway.0.0.lock()?;
        let mut stmt=db.prepare("SELECT seq,event_json,created_at FROM (SELECT seq,event_json,created_at FROM pi_events WHERE task_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq")?;
        let rows=stmt.query_map(params![id,crate::pi_projection::MAX_EVENTS as i64],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?;
        rows.map(|r|{let(seq,event,at)=r?;Ok(json!({"seq":seq,"event":serde_json::from_str::<Value>(&event)?,"createdAt":at}))}).collect()
    }
    fn projection_calls(&self,id:&str)->Result<Vec<Value>> {
        let db=self.0.gateway.0.0.lock()?;
        let mut stmt=db.prepare("SELECT call_id,tool,status,output_json FROM (SELECT rowid,call_id,tool,status,output_json FROM pi_calls WHERE task_id=? ORDER BY rowid DESC LIMIT ?) ORDER BY rowid")?;
        let rows=stmt.query_map(params![id,crate::pi_projection::MAX_CALLS as i64],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?)))?;
        rows.map(|r|{let(call,tool,status,output)=r?;let value=output.as_deref().filter(|value|value.len()<=pi_host::MAX_FRAME_BYTES).and_then(|value|serde_json::from_str::<Value>(value).ok()).unwrap_or(Value::Null);Ok(json!({"call_id":call,"task_id":id,"tool":tool,"status":status,"output_json":crate::pi_projection::summary_result(&value)}))}).collect()
    }

    async fn run_task(&self, request: Value, reply: oneshot::Sender<Result<Value>>) {
        let mut finished=self.run_task_once(request,reply).await;
        while let Some((task_id,session))=finished.take() {
            if self.0.closing.load(Ordering::Acquire) {break;}
            let Ok(task)=self.0.gateway.0.task(&task_id) else{break;};
            if !["completed","committed","previewed"].contains(&text(&task,"status")) {break;}
            let Ok(Some(request))=crate::pi_control::next_queued(&self.0.gateway.0,&session) else{break;};
            let input=text(&request,"queuedInputId").to_owned();
            let (send,receive)=oneshot::channel();
            finished=self.run_task_once(request,send).await;
            if !matches!(receive.await,Ok(Ok(_))) {
                let _=crate::pi_control::reject_queued(&self.0.gateway.0,&input);
                break;
            }
        }
    }

    async fn run_task_once(&self, request: Value, reply: oneshot::Sender<Result<Value>>) -> Option<(String,String)> {
        let incoming = {
            let mut slot = match self.0.slot.lock() {
                Ok(slot) => slot,
                Err(_) => {
                    let _ = reply.send(Err(Error::Cancelled));
                    return None;
                }
            };
            if self.0.closing.load(Ordering::Acquire) || slot.busy {
                let code=if self.0.closing.load(Ordering::Acquire){"host_unavailable"}else{"host_draining"};
                let _=reply.send(Err(Error::Tool{code,field:"taskId",message:"原生助手仍在收尾，尚未建立新的执行批次".into(),next:json!({"safeToReconnectBeforeStart":true})}));
                return None;
            }
            let Some(incoming) = slot.incoming.take() else {
                let _ = reply.send(Err(Error::Tool{code:"host_unavailable",field:"taskId",message:"Pi连接不可复用，尚未建立新的执行批次".into(),next:json!({"safeToReconnectBeforeStart":true})}));
                return None;
            };
            slot.busy = true;
            incoming
        };
        let mut incoming = Some(incoming);
        let prepared = self.prepare_task(&request).await;
        let (task_id, session_id, model, permit) = match prepared {
            Ok(value) => value,
            Err(error) => {
                self.return_receiver(incoming.take());
                let _ = reply.send(Err(error));
                return None;
            }
        };
        let network=self.0.network.read().unwrap_or_else(|p|p.into_inner()).clone().map(|transport| {
            // Bind inherited search to this resolved execution, not mutable UI
            // preferences or ordinary Game.llm. No secret enters the request.
            let frozen=model.clone();
            let connection=self.0.connection.clone();
            Arc::new(move |mut request:Value,cancel:tokio_util::sync::CancellationToken,accounting:Option<crate::pi_accounting::NativeModelAccounting>| -> crate::chat::BoxFuture<Result<Value>> {
                request["network"]=crate::pi_network::bind_model(&request["network"],&frozen);
                let original=request.clone();let stop=cancel.clone();let connection=connection.clone();
                let future=transport(request,cancel,accounting);
                Box::pin(async move {
                    let value=future.await?;
                    if !["read_document","find_document"].contains(&original["op"].as_str().unwrap_or(""))
                        || !original["_documentGrant"].is_object() || !value["_documentRead"].is_object(){return Ok(value);}
                    let id=uuid::Uuid::new_v4().to_string();let mut params=value["_documentRead"].clone();
                    for key in ["taskId","section","offset","charBudget","boundBookHash","through","query","sectionOffset","pageSize"]{if let Some(v)=original.get(key){params[key]=v.clone();}}
                    params["id"]=id.clone().into();params["operation"]=if original["op"]=="find_document"{"find"}else{"read"}.into();
                    let response=tokio::select!{biased;
                        _=stop.cancelled()=>{let _=connection.request("cancel_document",json!({"id":id})).await;return Err(Error::Cancelled);},
                        reply=connection.request("parse_document",params)=>reply.map_err(|_|invalid("资料解析宿主已失联，任务与来源定位保留"))?,
                    };
                    if response["ok"]!=true{return Err(invalid(response["error"]["message"].as_str().unwrap_or("资料解析未完成")));}
                    let mut data=response["data"].clone();data["grantId"]=original["grantId"].clone();data["path"]=original["path"].clone();
                    Ok(data)
                })
            }) as NetworkHost
        });
        let model_http=self.0.model_http.read().unwrap_or_else(|p|p.into_inner()).clone();
        let host = match PiTaskHost::attach_with_capabilities(
            self.0.connection.clone(),
            incoming.take().unwrap(),
            self.0.gateway.clone(),
            permit.clone(),
            network,
            model_http,
        ) {
            Ok(host) => host,
            Err(error) => {
                let _ = self
                    .0
                    .gateway
                    .interrupt(&permit, "原生助手未能接管本次任务");
                self.return_receiver(None);
                let _ = reply.send(Err(error));
                return None;
            }
        };
        if let Ok(mut slot) = self.0.slot.lock() {
            slot.task_id = Some(task_id.clone());
            slot.host = Some(host.clone());
        }
        let sink=self.0.attempt_sink.read().unwrap_or_else(|p|p.into_inner()).clone();if let Some(sink)=sink{sink(&task_id,&host.attempt_id());}
        (self.0.activity)(true);
        let directory = self.0.session_root.join(&session_id);
        let create = host
            .create(PiTaskConfig {
                directory,
                model,
                constraints: "本次已接本地故事、参考书、技能、脚本、联网、只读Pi子会话和任务计划；联网工具仍以本次实际配置和授权为准，未配置不可声称可用。子会话只读正式资料及明确提供的草稿，所有费用和调用共享根任务；结果仍由主助手核对采用。"
                    .into(),
            })
            .await;
        if let Err(error) = create {
            let _ = reply.send(Err(error));
            self.finish_host(&host, &task_id).await;
            return None;
        }
        if self.0.closing.load(Ordering::Acquire) {
            let _ = reply.send(Err(invalid("原生助手正在关闭")));
            let _ = host.stop().await;
            self.finish_host(&host, &task_id).await;
            return None;
        }
        let _ = reply.send(Ok(json!({"taskId":task_id,"runId":task_id,"attemptId":host.attempt_id()})));
        if request["_operation"]=="compact" {let _=host.compact(request["instructions"].as_str()).await;}
        else {let _ = host.prompt().await;}
        if let Ok(receipt) = host.receipt() {
            if receipt["status"] == "committed" && receipt["result"]["worldChanged"] == true {
                if let Ok(row) = self.0.gateway.0.task(&task_id) {
                    (self.0.committed)(text(&row, "world_id").into());
                }
            }
        }
        self.finish_host(&host, &task_id).await;
        Some((task_id,session_id))
    }

    async fn prepare_task(
        &self,
        request: &Value,
    ) -> Result<(String, String, Value, crate::pi_gateway::TaskPermit)> {
        let continuing = text(request, "op") == "continue";
        if continuing { crate::pi_resume::ensure(&self.0.gateway.0.0,request)?; }
        if ["native", "configured"].contains(&text(&request["network"], "mode")) && self.0.network.read().map_err(|_|Error::Cancelled)?.is_none() {
            return Err(invalid("本次服务尚未接入联网能力"));
        }
        if request["limits"]
            .as_object()
            .is_some_and(|v| v.values().any(|v| v.as_u64().unwrap_or(0) > 0))
            && self.0.model_http.read().map_err(|_|Error::Cancelled)?.is_none()
        {
            return Err(invalid("本次服务尚未接入模型调用账本，不能设置执行上限"));
        }
        let saved = if continuing {
            Some(self.0.gateway.0.task(required(request, "taskId")?)?)
        } else {
            None
        };
        let mut reference = model_reference(
            saved
                .as_ref()
                .map(|v| &v["model_json"])
                .unwrap_or(&Value::Null),
            request,
        );
        let resolver = self.0.resolver.clone();
        let fresh = reference.clone();
        let model = tokio::task::spawn_blocking(move || (resolver)(&fresh))
            .await
            .map_err(|_| invalid("无法解析本次模型配置"))??;
        reference.as_object_mut().unwrap().remove("modelUrl");
        if let Some(endpoint)=model["endpointRef"].as_str(){reference["endpointRef"]=endpoint.into();}
        else {reference.as_object_mut().unwrap().remove("endpointRef");}
        if self.0.closing.load(Ordering::Acquire) && !["stop","snapshot","delta","process_page","poll_session","session","list","search"].contains(&text(&request,"op")) {
            return Err(invalid("原生助手正在关闭"));
        }
        let (id, session, permit) = if let Some(saved) = saved {
            let id = required(request, "taskId")?.to_string();
            let session = text(&saved, "session_id").to_string();
            self.directory_name(&session)?;
            let permit = self.0.gateway.resume_task(&id)?;
            let saved_model = self.0.gateway.configure_continuation(&permit,&reference,request.get("limits").filter(|v|!v.is_null()),request["_operation"]=="compact");
            if let Err(error) = saved_model {
                let _ = self
                    .0
                    .gateway
                    .interrupt(&permit, "模型配置未能保存，任务要求已保留");
                return Err(error);
            }
            if !text(request, "text").trim().is_empty() {
                // Save the new requirement before creating Pi. A failed
                // create or a lost UI waiter must not discard this correction.
                let input = self.0.gateway.append_input(
                    &permit,
                    "steer",
                    &json!({"text":text(request,"text"),"nonce":uuid::Uuid::new_v4().to_string()}),
                );
                if let Err(error) = input {
                    let _ = self
                        .0
                        .gateway
                        .interrupt(&permit, "继续要求未能保存，任务尚未启动");
                    return Err(error);
                }
            }
            (id, session, permit)
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            let session = required(request, "sessionId")?.to_string();
            self.directory_name(&session)?;
            self.0.gateway.start_task(
                &session,
                &id,
                required(request, "text")?,
                request["policy"].as_str().unwrap_or("auto-reversible"),
                request["readOnly"].as_bool().unwrap_or(false),
                reference,
                task_metadata(request)?,
            )?;
            let permit = self.0.gateway.permit(&id)?;
            (id, session, permit)
        };
        Ok((id, session, model, permit))
    }
    fn directory_name(&self, id: &str) -> Result<()> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(invalid("Pi会话目录标识无效"));
        }
        Ok(())
    }
    fn task_host(&self,id:&str)->Result<PiTaskHost> {
        let slot=self.0.slot.lock().map_err(|_|Error::Cancelled)?;
        if slot.task_id.as_deref()!=Some(id) {return Err(invalid("该任务没有当前宿主，请先继续任务"));}
        slot.host.clone().ok_or_else(||invalid("助手正在启动，请稍后补充"))
    }
    fn return_receiver(&self, incoming: Option<IncomingReceiver>) {
        if let Ok(mut slot) = self.0.slot.lock() {
            slot.incoming = incoming;
            slot.busy = false;
            slot.task_id = None;
            slot.host = None;
        }
        self.0.changed.notify_waiters();
    }
    async fn finish_host(&self, host: &PiTaskHost, task_id: &str) {
        let network=self.0.network.read().unwrap_or_else(|p|p.into_inner()).clone();
        if let Some(network)=network {let cancel=tokio_util::sync::CancellationToken::new();let _=tokio::time::timeout(Duration::from_secs(3),network(json!({"op":"browser_release_task","taskId":task_id,"attemptId":host.attempt_id()}),cancel,None)).await;}

        match host.detach_session().await {
            Ok(incoming) => {
                (self.0.activity)(false);
                self.return_receiver(Some(incoming));
            }
            Err(_) => {
                let _=self.0.gateway.0.event(task_id,&json!({"type":"service_error","code":"session_detach_failed","message":"Pi会话未能移交，需重新建立原生服务"}));
                self.0.closing.store(true,Ordering::Release);
                self.0.connection.close_transport().await;
                (self.0.activity)(false);
                self.return_receiver(None);
                if let Some(sink)=self.0.control_timeout.read().unwrap_or_else(|p|p.into_inner()).clone(){sink(task_id,&host.attempt_id());}
            }
        }
    }
    async fn stop_task(&self, request: &Value) -> Result<Value> {
        let id = request["taskId"]
            .as_str()
            .or_else(|| request["id"].as_str())
            .ok_or_else(|| invalid("缺少任务标识"))?;
        let host = {
            let slot = self.0.slot.lock().map_err(|_| Error::Cancelled)?;
            if slot.task_id.as_deref() == Some(id) {
                slot.host.clone()
            } else {
                None
            }
        };
        if let Some(host) = host {
            let result = host.stop().await?;
            self.wait_idle(Some(id)).await?;
            Ok(result)
        } else {
            let task = self.0.gateway.0.task(id)?;
            if task["status"]=="waiting_user" {
                self.0.gateway.cancel_waiting(id)?;
                return Ok(json!({"stopped":true,"task":self.task_summary(id)?}));
            }
            if ["running", "committing", "waiting_user"].contains(&text(&task, "status")) {
                let attempt=crate::pi_lifecycle::attempt(&task);
                let receipt=crate::pi_lifecycle::request_stop(&self.0.gateway.0.0,id,&attempt,&uuid::Uuid::new_v4().to_string())?;
                return Ok(receipt);
            }
            Ok(json!({"alreadyStopped":true,"task":self.task_summary(id)?}))
        }
    }
    async fn wait_idle(&self, task: Option<&str>) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let changed = self.0.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                let waiting = {
                    let slot = self.0.slot.lock().map_err(|_| Error::Cancelled)?;
                    slot.busy && (task.is_none() || slot.task_id.as_deref() == task)
                };
                if !waiting {
                    return Ok(());
                }
                changed.await;
            }
        })
        .await
        .map_err(|_| invalid("原生助手仍在收尾，尚未关闭"))?
    }
    pub async fn shutdown(&self) -> Result<()> {
        self.0.closing.store(true, Ordering::Release);
        let host = self
            .0
            .slot
            .lock()
            .map_err(|_| Error::Cancelled)?
            .host
            .clone();
        if let Some(host) = host {
            let _ = host.stop().await;
        }
        self.wait_idle(None).await?;
        self.0.connection.close_transport().await;
        Ok(())
    }
}
