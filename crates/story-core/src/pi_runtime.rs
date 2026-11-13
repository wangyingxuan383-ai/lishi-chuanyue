//! Thin native Pi task owner. Pi alone owns messages, compaction and its loop.
use crate::{
    pi_gateway::{StoryToolGateway, TaskPermit},
    pi_store::PiCallRequest,
    Error, Result,
};
use pi_host::{AgentConnection, HostError, Incoming, IncomingReceiver};
use rusqlite::{params, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{sync::Notify, task::JoinSet};
use tokio_util::sync::CancellationToken;

pub const PI_PROMPT_VERSION: &str = "1.7.1";
const HEARTBEAT: Duration = Duration::from_secs(10);

/// Secret-bearing model configuration is passed only to Pi's memory transport.
/// It is never part of this type's Debug output, events or saved task metadata.
pub struct PiTaskConfig {
    pub directory: PathBuf,
    pub model: Value,
    pub constraints: String,
}

#[derive(Clone)]
pub struct PiTaskHost(Arc<State>);

struct PendingInput {
    id: String,
    wire_text: String,
    queued: bool,
}
#[derive(Clone)]
struct ChildRuntime {
    authority:crate::pi_children::ChildAuthority,
    cancel:CancellationToken,
    model_http:Option<crate::pi_http::ModelHttpController>,
}
struct State {
    gateway: StoryToolGateway,
    permit: TaskPermit,
    connection: AgentConnection,
    session_id: String,
    world_id: String,
    line_id: String,
    head_id: String,
    world_version: String,
    lease: Value,
    pi_session: Mutex<Option<String>>,
    directory: Mutex<Option<PathBuf>>,
    consumed: AtomicI64,
    pending: Mutex<HashMap<String, PendingInput>>,
    input_send: Arc<tokio::sync::Mutex<()>>,
    lifecycle: tokio::sync::Mutex<()>,
    detaching: AtomicBool,
    detached: AtomicBool,
    return_send: Mutex<Option<tokio::sync::oneshot::Sender<IncomingReceiver>>>,
    return_receive: Mutex<Option<tokio::sync::oneshot::Receiver<IncomingReceiver>>>,
    tool_slots: Arc<tokio::sync::Semaphore>,
    prompt_active: AtomicBool,
    prompt_done: Notify,
    prompt_cancel: CancellationToken,
    cancel: CancellationToken,
    done: AtomicBool,
    done_notify: Notify,
    failure: Mutex<Option<String>>,
    network: Option<crate::pi_service::NetworkHost>,
    model_http_host: Option<crate::pi_http::ModelHttpHost>,
    model_http: Mutex<Option<crate::pi_http::ModelHttpController>>,
    children:Mutex<HashMap<String,ChildRuntime>>,
    delegations:Mutex<HashMap<String,PiCallRequest>>,
}

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn host_error(error: HostError) -> Error {
    // Provider error payloads can echo URLs or authentication values. Do not
    // persist them as diagnostics. The UI can use Pi's bounded budget details.
    match error {
        HostError::Host { code, .. } if code == "model_context_window" => Error::ContextWindow,
        HostError::Host { code, .. } => invalid(&format!("Pi宿主未完成请求（{code}）")),
        _ => invalid("Pi宿主连接已结束，任务进度已保留"),
    }
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn active(status: &str) -> bool {
    ["running", "committing"].contains(&status)
}
fn interrupt_limit(state:&State,error:&Error) {
    if let Error::Limit(message)=error {
        if message.starts_with("本次") {
            let _=state.gateway.interrupt(&state.permit,message);
            state.prompt_cancel.cancel();
        }
    }
}
pub(crate) fn input_wire(id: &str, nonce: &str, value: &str) -> String {
    format!("【本次补充标识 {id}:{nonce}】\n{value}")
}
fn user_text(record: &Value) -> Option<String> {
    let event = &record["event"];
    if event["type"] != "message_start" || event["message"]["role"] != "user" {
        return None;
    }
    let content = &event["message"]["content"];
    if let Some(value) = content.as_str() {
        return Some(value.into());
    }
    let content = content.as_array()?;
    if content.iter().any(|part| part["type"] != "text") {
        return None;
    }
    Some(
        content
            .iter()
            .map(|part| part["text"].as_str().unwrap_or(""))
            .collect::<Vec<_>>()
            .join(""),
    )
}

impl PiTaskHost {
    pub(crate) fn attempt_id(&self)->String {self.0.permit.attempt_id()}

    /// Owned by the native service, never by a page subscription. `permit`
    /// stays immutable throughout this execution, including all tool futures.
    pub fn attach(
        connection: AgentConnection,
        incoming: IncomingReceiver,
        gateway: StoryToolGateway,
        permit: TaskPermit,
    ) -> Result<Self> {
        Self::attach_with_network(connection,incoming,gateway,permit,None)
    }
    pub fn attach_with_network(
        connection: AgentConnection,
        incoming: IncomingReceiver,
        gateway: StoryToolGateway,
        permit: TaskPermit,
        network: Option<crate::pi_service::NetworkHost>,
    ) -> Result<Self> {
        Self::attach_with_capabilities(connection,incoming,gateway,permit,network,None)
    }
    pub fn attach_with_capabilities(
        connection: AgentConnection,
        incoming: IncomingReceiver,
        gateway: StoryToolGateway,
        permit: TaskPermit,
        network: Option<crate::pi_service::NetworkHost>,
        model_http_host: Option<crate::pi_http::ModelHttpHost>,
    ) -> Result<Self> {
        gateway.attach_host(&permit)?;
        let task = gateway.0.task(&permit.task_id)?;
        let base = &task["base_json"];
        let (return_send, return_receive) = tokio::sync::oneshot::channel();
        let state = Arc::new(State {
            session_id: text(&task, "session_id").into(),
            world_id: text(&task, "world_id").into(),
            line_id: text(base, "lineId").into(),
            head_id: text(base, "headId").into(),
            world_version: text(&task, "base_world_version").into(),
            lease: task["lease_json"].clone(),
            consumed: AtomicI64::new(task["consumed_intent_revision"].as_i64().unwrap_or(0)),
            gateway,
            permit,
            connection,
            pi_session: Mutex::new(None),
            directory: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            input_send: Arc::new(tokio::sync::Mutex::new(())),
            lifecycle: tokio::sync::Mutex::new(()),
            detaching: AtomicBool::new(false),
            detached: AtomicBool::new(false),
            return_send: Mutex::new(Some(return_send)),
            return_receive: Mutex::new(Some(return_receive)),
            tool_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            prompt_active: AtomicBool::new(false),
            prompt_done: Notify::new(),
            prompt_cancel: CancellationToken::new(),
            cancel: CancellationToken::new(),
            done: AtomicBool::new(false),
            done_notify: Notify::new(),
            failure: Mutex::new(None),
            network,
            model_http_host,
            model_http: Mutex::new(None),
            children:Mutex::new(HashMap::new()),
            delegations:Mutex::new(HashMap::new()),
        });
        restore_pending(&state)?;
        let owned = state.clone();
        let watcher=Arc::downgrade(&state);
        tokio::spawn(async move {
            let mut timer=tokio::time::interval(HEARTBEAT);
            loop {
                let Some(owner)=watcher.upgrade() else{break;};
                tokio::select!{biased;_=owner.cancel.cancelled()=>break,_=timer.tick()=>{}}
                let gateway=owner.gateway.clone();let permit=owner.permit.clone();
                let check=tokio::task::spawn_blocking(move||{
                    let task=gateway.0.task(&permit.task_id)?;
                    if !active(text(&task,"status"))&&task["metadata_json"]["_nativeHostActive"]!=true{return Ok(false);}
                    gateway.heartbeat(&permit)?;Ok::<_,Error>(true)
                }).await;
                match check {
                    Ok(Ok(true))=>{},Ok(Ok(false))=>break,
                    error=>{
                        let reason=match error{Ok(Err(Error::Limit(reason)))=>reason,_=>"执行权限或心跳已失效，要求与草稿已保留".into()};
                        owner.prompt_cancel.cancel();
                        let _=owner.gateway.interrupt(&owner.permit,&reason);
                        break;
                    }
                }
            }
        });
        tokio::spawn(async move {
            consume(owned, incoming).await;
        });
        Ok(Self(state))
    }

    pub async fn create(&self, config: PiTaskConfig) -> Result<Value> {
        let _lifecycle = self.0.lifecycle.lock().await;
        self.ensure_attached()?;
        if self.0.prompt_cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let outcome = self.create_session(config).await;
        if outcome.is_err() {
            let _ = self
                .0
                .gateway
                .interrupt(&self.0.permit, "Pi会话未能建立，任务要求与草稿已保留");
            self.0.connection.close_transport().await;
            let _ = self.0.gateway.release_host(&self.0.permit);
        }
        outcome
    }

    async fn create_session(&self, config: PiTaskConfig) -> Result<Value> {
        let state = self.0.clone();
        if !config.directory.is_absolute() {
            return Err(invalid("助手会话目录必须由原生宿主指定"));
        }
        if config
            .directory
            .components()
            .any(|c| matches!(c, Component::ParentDir))
        {
            return Err(invalid("助手会话目录无效"));
        }
        let session = state.gateway.0.session(&state.session_id)?;
        let task=state.gateway.0.task(&state.permit.task_id)?;
        if let Some(host)=&state.model_http_host {
            *state.model_http.lock().map_err(|_|Error::Cancelled)?=Some(crate::pi_http::ModelHttpController::new(state.gateway.clone(),state.permit.clone(),config.model.clone(),task["model_json"].clone(),host.clone(),state.prompt_cancel.child_token()));
        }
        let definitions=state.gateway.definitions();
        let catalog=definitions.iter().map(|t|json!({"name":t["name"],"description":t["description"]})).collect::<Vec<_>>();
        let mut active_tools=vec!["discover_tools".to_owned(),"list_resources".into(),"read_resource".into(),"read_world".into(),"read_tool_result".into(),"list_skills".into(),"read_skill".into(),"finish_task".into()];
        for name in task["metadata_json"]["enabledTools"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            if !active_tools.iter().any(|n|n==name) {active_tools.push(name.into());}
        }
        let mut params = json!({"directory":config.directory,"model":config.model,
            "systemPrompt":format!("原生故事助手协议 {PI_PROMPT_VERSION}。玩家目标在用户消息中。按需读取本局资料，不凭对话印象代替最新存档。讨论、工具日志和说明不进入剧情。需要回顾时可按需检索同故事同路线的助手历史；历史要求和答复不代替本次授权、当前存档或原著证据。修改先暂存、预演并调用finish_task按已选策略采用；模型停止输出不代表目标完成。用discover_tools按需加载下列能力的参数，已加载的有效说明持续保留。玩家指定技能必须实际read_skill再执行方法；读取技能不等于核对完成，普通写作整理不用填写额外检查表。原著与本局事实分开核对，授权修改不是原著依据。原著规则、玩家事实、本局修订和正式采用四者分开。constraints.factContract=2时，原著改动分别记录sourceClaim和revisionDecision；涉及本局已发生事件必须补本局依据，不用“原著允许”证明“玩家已做”。网页和普通文件basis=external，不能冒充已导入原著。明确玩家分支可引用constraints.playerReferences中的真实原句，request引用附declaration对象/具体值/本局范围；本局自定须引用明确允许补全的原句和范围，不要求玩家重复填表。明确核对原著时先check_draft取constraints、完整resourceGroups和证据摘要；具体引文read_evidence按来源分页读取，用record_findings记录具体目标/依据或不足，再finish_task；普通写作整理无需额外报告。通过核对的完整独立资源组可以分批采用，关联资源不可拆半；未核对部分保留草稿，继续时重新check_draft并核对最新基线和冲突。blocked仅保存不采用；要采用有效部分用正常finish_task。任务完成以goalStatus和提交读回为准，部分完成不能宣称全部完成。采用后本批次写权限关闭，用read_commit_receipt/read_committed_snapshot核对固定回执并如实更新计划，不再编辑或重复提交。最终答复先用短段说明结果、主要修改和未解决事项，不展示内部ID、版本指纹或原始参数；详细清单留在修改详情。工具与脚本分页统一使用pageSize（条目数）、charBudget（文字预算）及nextCursor；不要自行按limit递增offset。脚本使用pages/collectPages辅助，不把oversized目录当作内容；read_timeline可批量读当前路线时间记录，避免逐回合逐字段扫全局。日期调整默认只校准纪年/日期，不重写历史经过，除非玩家明确要求。明确区分原文明示、合理推定和资料不足；依据季节、年龄或“万年之后”估算的具体年月日必须明确称为推定，不写成原著给出的精确日期。系统运行提示只建议执行方法，不构成玩家授权或原著证据；据此调整方法或保存暂停。当前能力仅限目录，未接通的联网或协作不能声称已经执行。资源定位：worldId={}，lineId={}，headId={}。\n本次指定技能：{}\n工具目录：{}\n{}",state.world_id,state.line_id,state.head_id,task["metadata_json"]["skills"],serde_json::to_string(&catalog)?,config.constraints),
            "tools":definitions,"activeTools":active_tools,"nativeAttempt":state.permit.attempt_id(),"taskContext":true,"nativeModelHttp":state.model_http_host.is_some()});
        if let Some(file) = session["session_file"].as_str() {
            require_owned_path(&config.directory, Path::new(file))?;
            params["sessionFile"] = file.into();
        }
        update_owned(&state, |tx| {
            let raw:String=tx.query_row("SELECT metadata_json FROM pi_tasks WHERE id=?",[&state.permit.task_id],|r|r.get(0))?;
            let mut metadata:Value=serde_json::from_str(&raw)?;
            metadata["piPromptVersion"]=PI_PROMPT_VERSION.into();
            tx.execute(
                "UPDATE pi_tasks SET metadata_json=? WHERE id=?",
                params![metadata.to_string(), state.permit.task_id],
            )?;
            Ok(())
        })?;
        let inspected = state
            .connection
            .request("create", params)
            .await
            .map_err(host_error)?;
        let pi_session = inspected["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| invalid("Pi宿主未返回会话标识"))?;
        let file = inspected["sessionFile"]
            .as_str()
            .ok_or_else(|| invalid("Pi宿主未返回会话位置"))?;
        require_owned_path(&config.directory, Path::new(file))?;
        *state.pi_session.lock().map_err(|_| Error::Cancelled)? = Some(pi_session.into());
        *state.directory.lock().map_err(|_| Error::Cancelled)? = Some(config.directory);
        update_owned(&state, |tx| {
            tx.execute(
                "UPDATE pi_sessions SET session_file=? WHERE id=?",
                params![file, state.session_id],
            )?;
            Ok(())
        })?;
        Ok(inspected)
    }

    pub async fn prompt(&self) -> Result<Value> {
        self.start_prompt(None).await
    }

    /// Explicit continuation text belongs to this task's Pi conversation; it
    /// does not become formal story text or reset its persistent requirements.
    pub async fn prompt_text(&self, value: &str) -> Result<Value> {
        if value.trim().is_empty() {
            return Err(invalid("继续要求不能为空"));
        }
        self.start_prompt(Some(value)).await
    }

    pub async fn compact(&self,instructions:Option<&str>)->Result<Value> {
        let lifecycle=self.0.lifecycle.lock().await;self.ensure_attached()?;
        if self.0.prompt_cancel.is_cancelled(){return Err(Error::Cancelled);}
        if self.0.prompt_active.load(Ordering::Acquire){return Err(invalid("请先停止当前执行，再整理上下文"));}
        self.0.gateway.heartbeat(&self.0.permit)?;
        self.0.prompt_active.store(true,Ordering::Release);
        let state=self.0.clone();let instructions=instructions.map(str::to_owned);
        let(send,receive)=tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let outcome=async {
                let result=tokio::select!{biased;_=state.prompt_cancel.cancelled()=>return Err(Error::Cancelled),result=state.connection.request("compact",json!({"taskId":state.permit.task_id,"instructions":instructions}))=>result.map_err(host_error)?};
                let checkpoint=state.gateway.compacted(&state.permit,&result)?;
                state.gateway.0.event(&state.permit.task_id,&json!({"type":"context_checkpoint","data":checkpoint}))?;
                Ok(json!({"taskId":state.permit.task_id,"status":"paused","checkpoint":checkpoint,"goalCompleted":false}))
            }.await;
            if outcome.is_err(){let _=state.gateway.interrupt(&state.permit,"上下文整理未完成，原要求、检查点和草稿已保留");}
            state.prompt_active.store(false,Ordering::Release);state.prompt_done.notify_waiters();
            let _=send.send(outcome);
        });
        drop(lifecycle);receive.await.map_err(|_|invalid("上下文整理的原生收尾尚未确认"))?
    }

    async fn start_prompt(&self, continuation: Option<&str>) -> Result<Value> {
        let lifecycle = self.0.lifecycle.lock().await;
        self.ensure_attached()?;
        if self.0.prompt_cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        self.0.gateway.heartbeat(&self.0.permit)?;
        if self.0.prompt_active.load(Ordering::Acquire) {
            return Err(invalid("当前助手仍在执行，请补充要求或停止"));
        }
        let send_guard = self.0.input_send.clone().lock_owned().await;
        self.ensure_attached()?;
        if let Some(value) = continuation {
            self.register_input("steer", value, None)?;
        }
        // A restored task may have inputs that were accepted but never reached
        // Pi's user-message boundary. Queue them in their original order; an
        // acknowledgement still does not permit an old draft to be committed.
        let pending = {
            let db = self.0.gateway.0 .0.lock()?;
            let mut statement = db.prepare("SELECT id FROM pi_inputs WHERE task_id=? AND status='pending' AND delivery IN ('steer','answer') ORDER BY seq")?;
            let ids = statement
                .query_map([&self.0.permit.task_id], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let saved = self.0.pending.lock().map_err(|_| Error::Cancelled)?;
            ids.into_iter()
                .map(|id| {
                    saved
                        .get(&id)
                        .map(|input| (!input.queued).then(|| (id, input.wire_text.clone())))
                        .ok_or_else(|| invalid("这条补充缺少可验证的投递标识，请先恢复任务"))
                })
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
        };
        let task = self.0.gateway.0.task(&self.0.permit.task_id)?;
        let value = text(&task, "text").to_owned();
        self.0.prompt_active.store(true, Ordering::Release);
        let state = self.0.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        // The native run outlives this response waiter and every UI subscriber.
        tokio::spawn(async move {
            let outcome = async {
                for (id, text) in pending {
                    tokio::select! { biased;
                        _=state.prompt_cancel.cancelled()=>return Err(Error::Cancelled),
                        result=state.connection.request("steer", json!({"text":text}))=>{result.map_err(host_error)?;}
                    }
                    if let Some(input)=state.pending.lock().map_err(|_|Error::Cancelled)?.get_mut(&id) {input.queued=true;}
                }
                // Keep the input ordering lock until all restored inputs have
                // been queued. New live supplements are delivered after them.
                drop(send_guard);
                run_prompt(&state, &value).await
            }
            .await;
            if outcome.is_err() && !state.prompt_cancel.is_cancelled() {
                let _ = state
                    .gateway
                    .interrupt(&state.permit, "Pi执行中断，任务要求与草稿已保留");
                let _ = state.gateway.release_host(&state.permit);
            }
            state.prompt_active.store(false, Ordering::Release);
            state.prompt_done.notify_waiters();
            let _ = send.send(outcome);
        });
        drop(lifecycle);
        receive.await.map_err(|_| invalid("原生助手执行已中断"))?
    }

    pub async fn steer(&self, value: &str) -> Result<String> {
        self.input("steer", value, None).await
    }
    pub async fn steer_named(&self, value: &str, input_id: &str) -> Result<String> {
        self.input("steer", value, Some(input_id)).await
    }
    pub async fn answer(&self, value: &str) -> Result<String> {
        self.input("answer", value, None).await
    }
    async fn input(&self, delivery: &str, value: &str, input_id: Option<&str>) -> Result<String> {
        self.ensure_attached()?;
        if value.trim().is_empty() {
            return Err(invalid("补充内容不能为空"));
        }
        let send_guard = self.0.input_send.clone().lock_owned().await;
        self.ensure_attached()?;
        if self.0.prompt_cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let (id, wire_text) = self.register_input(delivery, value, input_id)?;
        let status: String=self.0.gateway.0.0.lock()?.query_row("SELECT status FROM pi_inputs WHERE id=?",[&id],|r|r.get(0))?;
        if status=="delivered" || self.0.pending.lock().map_err(|_|Error::Cancelled)?.get(&id).is_some_and(|v|v.queued) {return Ok(id);}
        // This response acknowledges Pi's queue only. Consumption is recorded
        // exclusively by its exact user-message-start event in the consumer.
        let connection = self.0.connection.clone();
        let state = self.0.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _guard = send_guard;
            let outcome = tokio::select! {biased;
                _=state.prompt_cancel.cancelled()=>Err(Error::Cancelled),
                result=connection.request("steer", json!({"text":wire_text}))=>result.map_err(host_error).map(|_|{
                    if let Some(input)=state.pending.lock().unwrap_or_else(|p|p.into_inner()).get_mut(&id) {input.queued=true;}
                    id
                })
            };
            let _ = send.send(outcome);
        });
        receive
            .await
            .map_err(|_| invalid("原生助手输入投递已中断"))?
    }

    fn register_input(&self, delivery: &str, value: &str, input_id: Option<&str>) -> Result<(String, String)> {
        let nonce = uuid::Uuid::new_v4().to_string();
        let id = self.0.gateway.append_named_input(
            &self.0.permit,
            delivery,
            &json!({"text":value,"nonce":nonce}),
            input_id,
        )?;
        let saved:String=self.0.gateway.0.0.lock()?.query_row("SELECT content_json FROM pi_inputs WHERE id=?",[&id],|r|r.get(0))?;
        let saved:Value=serde_json::from_str(&saved)?;
        let wire_text = input_wire(&id, text(&saved,"nonce"), text(&saved,"text"));
        self.0.pending.lock().map_err(|_| Error::Cancelled)?.entry(id.clone()).or_insert_with(||PendingInput {
                id: id.clone(),
                wire_text: wire_text.clone(),
                queued: false,
            });
        Ok((id, wire_text))
    }

    pub async fn stop(&self) -> Result<Value> {
        let _lifecycle = self.0.lifecycle.lock().await;
        self.ensure_attached()?;
        self.stop_inner().await
    }

    async fn stop_inner(&self) -> Result<Value> {
        let task = self.0.gateway.0.task(&self.0.permit.task_id)?;
        if !active(text(&task, "status"))
            && task["status"] != "waiting_user"
            && !self.0.prompt_active.load(Ordering::Acquire)
        {
            return Ok(json!({"alreadyStopped":true,"taskReceipt":self.receipt()?}));
        }
        crate::pi_lifecycle::request_stop(&self.0.gateway.0.0,&self.0.permit.task_id,&self.0.permit.attempt_id(),&format!("native-{}",uuid::Uuid::new_v4()))?;
        // First cancel native senders and wait for their request futures to
        // drop. Nothing can enqueue a late prompt or supplement after abort.
        self.0.prompt_cancel.cancel();
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let notified = self.0.prompt_done.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if !self.0.prompt_active.load(Ordering::Acquire) {
                    break;
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| invalid("原生执行仍在收尾，停止尚未确认"))?;
        let _inputs = tokio::time::timeout(
            Duration::from_secs(15),
            self.0.input_send.clone().lock_owned(),
        )
        .await
        .map_err(|_| invalid("补充输入仍在收尾，停止尚未确认"))?;
        tokio::time::timeout(
            Duration::from_secs(15),
            self.0.connection.request("abort", json!({})),
        )
        .await
        .map_err(|_| invalid("停止尚未确认，停止标记已保存"))?
        .map_err(host_error)?;
        self.0
            .gateway
            .interrupt(&self.0.permit, "玩家已停止，进度与草稿已保存")?;
        Ok(json!({"abortConfirmed":true,"taskReceipt":self.receipt()?}))
    }

    pub fn receipt(&self) -> Result<Value> {
        let task = self.0.gateway.0.task(&self.0.permit.task_id)?;
        Ok(
            json!({"id":task["id"],"status":task["status"],"result":task["result_json"],"error":task["error"],
            "intentRevision":task["intent_revision"],"consumedIntentRevision":task["consumed_intent_revision"]}),
        )
    }

    pub async fn shutdown(&self) -> Result<()> {
        let _lifecycle = self.0.lifecycle.lock().await;
        // A former task must never close or abort a newly attached session.
        if self.0.detached.load(Ordering::Acquire) {
            return Ok(());
        }
        let task = self.0.gateway.0.task(&self.0.permit.task_id)?;
        if active(text(&task, "status"))
            || task["status"] == "waiting_user"
            || self.0.prompt_active.load(Ordering::Acquire)
        {
            self.stop_inner().await?;
        }
        let _ = tokio::time::timeout(
            Duration::from_secs(15),
            self.0.connection.request("close", json!({})),
        )
        .await;
        self.0.cancel.cancel();
        self.0.connection.close_transport().await;
        loop {
            let notified = self.0.done_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.0.done.load(Ordering::Acquire) {
                break;
            }
            notified.await;
        }
        self.0.gateway.release_host(&self.0.permit)?;
        Ok(())
    }

    /// Dispose only this Pi session after its task and final reply end. Android
    /// keeps the one initialized Node runtime and its private connection alive.
    /// The native owner can attach the returned receiver to its next task.
    pub async fn detach_session(&self) -> Result<IncomingReceiver> {
        let _lifecycle = self.0.lifecycle.lock().await;
        self.ensure_attached()?;
        let task = self.0.gateway.0.task(&self.0.permit.task_id)?;
        if active(text(&task, "status"))
            || self.0.prompt_active.load(Ordering::Acquire)
        {
            return Err(invalid("请先结束或停止当前助手任务，再切换会话"));
        }
        self.0.detaching.store(true, Ordering::Release);
        struct Reset<'a>(&'a AtomicBool);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _reset = Reset(&self.0.detaching);
        // The lock is moved into each input driver. Waiting here therefore
        // also waits for accepted old inputs when their UI waiter disappeared.
        let _inputs = tokio::time::timeout(
            Duration::from_secs(15),
            self.0.input_send.clone().lock_owned(),
        )
        .await
        .map_err(|_| invalid("补充输入仍在投递，尚未移交Pi会话"))?;
        tokio::time::timeout(
            Duration::from_secs(15),
            self.0.connection.request("close", json!({})),
        )
        .await
        .map_err(|_| invalid("Pi会话关闭尚未确认，未切换到其他任务"))?
        .map_err(host_error)?;
        self.0.detached.store(true, Ordering::Release);
        self.0.cancel.cancel();
        let receive = self
            .0
            .return_receive
            .lock()
            .map_err(|_| Error::Cancelled)?
            .take()
            .ok_or_else(|| invalid("当前助手会话已经移交"))?;
        let incoming = receive
            .await
            .map_err(|_| invalid("Pi会话事件通道未能移交"))?;
        loop {
            let notified = self.0.done_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.0.done.load(Ordering::Acquire) {
                break;
            }
            notified.await;
        }
        self.0.gateway.release_host(&self.0.permit)?;
        if self.0.connection.is_closed() {
            return Err(invalid("Pi连接已关闭，不能复用运行环境"));
        }
        Ok(incoming)
    }

    fn ensure_attached(&self) -> Result<()> {
        if self.0.detached.load(Ordering::Acquire) || self.0.detaching.load(Ordering::Acquire) {
            return Err(invalid("这次任务已移交，旧助手不能控制新的会话"));
        }
        Ok(())
    }
}

async fn run_prompt(state: &Arc<State>, value: &str) -> Result<Value> {
    let response = tokio::select! {biased;
        _=state.prompt_cancel.cancelled()=>return Err(Error::Cancelled),
        value=state.connection.request(
            "prompt",
            json!({"text":value,"taskId":state.permit.task_id}),
        )=>value
    };
    let answer = match response {
        Ok(value) => value,
        Err(error) => {
            let _ = state
                .gateway
                .interrupt(&state.permit, "Pi执行中断，已保留任务进度");
            let _ = state.gateway.release_host(&state.permit);
            return Err(host_error(error));
        }
    };
    let task = state.gateway.0.task(&state.permit.task_id)?;
    let finished_by_reply = active(text(&task, "status"))
        && state.gateway.finish_readonly_reply(&state.permit, answer["text"].as_str().unwrap_or(""))?;
    if !finished_by_reply && active(text(&state.gateway.0.task(&state.permit.task_id)?, "status")) {
        state.gateway.interrupt(
            &state.permit,
            "Pi已结束本次输出，尚无正式完成回执，草稿与要求已保留",
        )?;
    }
    state.gateway.release_host(&state.permit)?;
    let task = state.gateway.0.task(&state.permit.task_id)?;
    let receipt = json!({"id":task["id"],"status":task["status"],"result":task["result_json"],"error":task["error"],
        "intentRevision":task["intent_revision"],"consumedIntentRevision":task["consumed_intent_revision"]});
    Ok(json!({"answer":answer["text"],"pi":answer,"taskReceipt":receipt}))
}

pub(crate) fn require_owned_path(directory: &Path, file: &Path) -> Result<()> {
    if !file.is_absolute()
        || !file.starts_with(directory)
        || file
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(invalid("Pi会话位置不属于当前原生会话目录"));
    }
    Ok(())
}

fn update_owned(
    state: &State,
    action: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<()>,
) -> Result<()> {
    let mut db = state.gateway.0 .0.lock()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let row: String = tx.query_row(
        "SELECT lease_json FROM pi_tasks WHERE id=?",
        [&state.permit.task_id],
        |r| r.get(0),
    )?;
    if serde_json::from_str::<Value>(&row)? != state.lease {
        return Err(Error::Stale);
    }
    let ticket = serde_json::from_value(state.lease.clone())?;
    crate::execution_lease::guard(&tx, &ticket, crate::execution_lease::now_ms())?;
    action(&tx)?;
    tx.commit()?;
    Ok(())
}

fn restore_pending(state: &State) -> Result<()> {
    let (inputs, events) = {
        let db = state.gateway.0 .0.lock()?;
        let mut inputs=db.prepare("SELECT id,content_json FROM pi_inputs WHERE task_id=? AND status='pending' AND delivery IN ('steer','answer') ORDER BY seq")?;
        let inputs = inputs
            .query_map([&state.permit.task_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut events=db.prepare("SELECT event_json FROM pi_events WHERE task_id=? AND json_extract(event_json,'$.event.type')='message_start' AND json_extract(event_json,'$.event.message.role')='user' ORDER BY seq")?;
        let events = events
            .query_map([&state.permit.task_id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        (inputs, events)
    };
    let seen = events
        .into_iter()
        .filter_map(|s| serde_json::from_str::<Value>(&s).ok())
        .filter_map(|v| user_text(&v))
        .collect::<Vec<_>>();
    for (id, value) in inputs {
        let content: Value = serde_json::from_str(&value)?;
        if text(&content, "nonce").is_empty() {
            continue;
        }
        let wire_text = input_wire(&id, text(&content, "nonce"), text(&content, "text"));
        if seen.contains(&wire_text) {
            let value = state.gateway.consume_input(&state.permit, &id)?;
            if let Some(revision) = value["intent_revision"].as_i64() {
                state.consumed.store(revision, Ordering::Release);
            }
        } else {
            state.pending.lock().map_err(|_| Error::Cancelled)?.insert(
                id.clone(),
                PendingInput {
                    id,
                    wire_text,
                    queued: false,
                },
            );
        }
    }
    Ok(())
}

async fn consume(state: Arc<State>, mut incoming: IncomingReceiver) {
    let mut tools: JoinSet<(String, Option<Value>)> = JoinSet::new();
    let mut cancels: HashMap<String, CancellationToken> = HashMap::new();
    let result:Result<()>=async {
        loop {
            tokio::select! { biased;
                _=state.cancel.cancelled()=>break,
                finished=tools.join_next(), if !tools.is_empty()=>{
                    let (id,result)=finished.ok_or_else(||invalid("工具执行任务已丢失"))?.map_err(|_|invalid("工具执行未完成"))?;
                    cancels.remove(&id);
                    if let Some(value)=result { match state.connection.tool_result(&id,value).await { Ok(())|Err(HostError::ToolCancelled)=>{},Err(error)=>return Err(host_error(error)) } }
                }
                message=incoming.recv()=>{
                    let Some(message)=message else {return Err(invalid("Pi宿主已断开，进度已保留"));};
                    match message {
                        Incoming::Event(record)=>{
                            validate_envelope(&state,&record)?;
                            if let Some(safe)=crate::pi_projection::persistable_event(&record) {state.gateway.0.event(&state.permit.task_id,&safe)?;}
                            if let Some(value)=user_text(&record).filter(|_|!record["childId"].is_string()) {
                                let id=state.pending.lock().map_err(|_|Error::Cancelled)?.values().find(|input|input.wire_text==value).map(|input|input.id.clone());
                                if let Some(id)=id {
                                    let input=state.gateway.consume_input(&state.permit,&id)?;
                                    if let Some(revision)=input["intent_revision"].as_i64() {state.consumed.store(revision,Ordering::Release);}
                                    state.pending.lock().map_err(|_|Error::Cancelled)?.remove(&id);
                                }
                            }
                        }
                        Incoming::ToolCancel {request_id}=>{
                            state.gateway.0.event(&state.permit.task_id,&json!({"type":"native_tool_cancel","requestId":request_id}))?;
                            if let Some(token)=cancels.get(&request_id) {token.cancel();}
                        }
                        Incoming::Notice(_)=>{state.gateway.0.event(&state.permit.task_id,&json!({"type":"host_notice","message":"Pi控制请求未完成，详细要求和草稿已保留"}))?;}
                        Incoming::ToolRequest(request)=>{
                            let session=state.pi_session.lock().map_err(|_|Error::Cancelled)?.clone();
                            if request.task_id.as_deref()!=Some(state.permit.task_id.as_str()) || session.as_deref()!=Some(request.session_id.as_str()) {
                                return Err(invalid("Pi工具调用的任务或会话归属不符"));
                            }
                            let id=request.request_id.clone();
                            let token=state.prompt_cancel.child_token(); cancels.insert(id.clone(),token.clone());
                            // Freeze this revision now, before awaiting SQLite or a
                            // worker. Later user messages must not upgrade old calls.
                            let revision=state.consumed.load(Ordering::Acquire);
                            let owner=state.clone();
                            tools.spawn(async move {
                                let slot=tokio::select! {biased;_=token.cancelled()=>return (id,None),permit=owner.tool_slots.clone().acquire_owned()=>permit};
                                let Ok(_slot)=slot else {return(id,None);};
                                if token.is_cancelled() {return (id,None);}
                                let outcome=execute_request(&owner,request,revision,token.clone()).await;
                                if let Err(error)=&outcome {interrupt_limit(&owner,error);}
                                let value=match outcome {Ok(value)=>value,Err(error)=>json!({"ok":false,"error":{"code":match &error{Error::Limit(message) if message.contains("模型")&&message.contains("超时")=>"model_timeout",Error::Limit(message) if message.contains("活动时间")=>"model_time_limit",Error::Limit(message) if message.contains("工具")=>"tool_call_limit",Error::Limit(_)=>"model_request_limit",Error::Cancelled=>"cancelled",_=>"gateway_failed"},"message":error.to_string()}})};
                                // The gateway's call ledger is authoritative. A
                                // cancel can suppress delivery, never erase effects.
                                if token.is_cancelled() {(id,None)} else {(id,Some(value))}
                            });
                        }
                    }
                }
            }
        }
        Ok(())
    }.await;
    if result.is_err() {
        let _ = state
            .gateway
            .interrupt(&state.permit, "Pi宿主连接中断，进度已保留");
        *state.failure.lock().unwrap_or_else(|p| p.into_inner()) =
            Some("Pi宿主连接中断，进度已保留".into());
        state.connection.close_transport().await;
    }
    for token in cancels.values() {
        token.cancel();
    }
    if let Some(controller)=state.model_http.lock().unwrap_or_else(|p|p.into_inner()).as_ref(){controller.close();}
    for child in state.children.lock().unwrap_or_else(|p|p.into_inner()).values(){child.cancel.cancel();if let Some(controller)=&child.model_http{controller.close();}}
    while tools.join_next().await.is_some() {}
    if state.detached.load(Ordering::Acquire) {
        // Pi.close already acknowledged session disposal. Persist final queued
        // events, but never execute old tool requests after that boundary.
        while let Ok(message) = incoming.try_recv() {
            let event = match message {
                Incoming::Event(value) => value,
                Incoming::Notice(_) => json!({"type":"host_notice"}),
                Incoming::ToolCancel { request_id } => {
                    json!({"type":"native_tool_cancel","requestId":request_id})
                }
                Incoming::ToolRequest(request) => {
                    json!({"type":"native_tool_cancel","requestId":request.request_id,"reason":"session_detached"})
                }
            };
            let Some(safe)=crate::pi_projection::persistable_event(&event) else {continue;};
            if state
                .gateway
                .0
                .event(&state.permit.task_id, &safe)
                .is_err()
            {
                state.connection.close_transport().await;
                break;
            }
        }
    }
    if let Some(send) = state
        .return_send
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
    {
        let _ = send.send(incoming);
    }
    state.done.store(true, Ordering::Release);
    state.done_notify.notify_waiters();
}

async fn execute_request(state:&Arc<State>,request:pi_host::ToolRequest,revision:i64,token:CancellationToken)->Result<Value> {
    let child_id=request.extra.get("childId").and_then(Value::as_str);
    let parent=request.extra.get("parentCallId").and_then(Value::as_str).unwrap_or("");
    if request.extra.contains_key("childId")&&child_id.is_none()||request.extra.contains_key("parentCallId")&&!request.extra["parentCallId"].is_string(){return Err(invalid("子会话身份字段无效，不能降为主助手权限"));}
    if child_id.is_some()&&parent.is_empty(){return Err(invalid("子会话缺少原生父调用定位"));}
    if request.name=="__child_open"&&request.tool_call_id.starts_with("control-") {
        let id=child_id.ok_or_else(||invalid("子会话缺少原生身份"))?;
        let saved=state.gateway.child_record(&state.permit,id)?;
        if saved.parent_call_id!=parent{return Err(Error::Stale);}
        let directory=state.directory.lock().map_err(|_|Error::Cancelled)?.clone().ok_or(Error::Stale)?.join("children").join(id);
        let file=request.args["sessionFile"].as_str().ok_or_else(||invalid("子会话文件定位缺失"))?;
        require_owned_path(&directory,Path::new(file))?;
        let mut children=state.children.lock().map_err(|_|Error::Cancelled)?;
        if children.contains_key(id){return Err(invalid("子会话已经打开，不会重复运行"));}
        let authority=state.gateway.open_child(&state.permit,id,file)?;
        let cancel=state.prompt_cancel.child_token();
        let model_http=state.model_http.lock().map_err(|_|Error::Cancelled)?.as_ref().map(|controller|controller.child(authority.clone(),cancel.clone()));
        children.insert(id.into(),ChildRuntime{authority,cancel,model_http});
        return Ok(json!({"ok":true,"data":{"opened":true,"childId":id}}));
    }
    if request.name=="__child_finish"&&request.tool_call_id.starts_with("control-") {
        let id=child_id.ok_or_else(||invalid("子任务缺少原生身份"))?;
        let child=state.gateway.child_record(&state.permit,id)?;
        if child.parent_call_id!=parent{return Err(Error::Stale);}
        if let Some(runtime)=state.children.lock().map_err(|_|Error::Cancelled)?.get(id) {runtime.cancel.cancel();if let Some(controller)=&runtime.model_http{controller.close();}}
        return state.gateway.finish_child(&state.permit,&child,&request.args).map(|data|json!({"ok":true,"data":data}));
    }
    if request.name=="__children_finish"&&request.tool_call_id.starts_with("control-")&&child_id.is_none() {
        let parent=request.args["parentCallId"].as_str().ok_or_else(||invalid("原分派定位缺失"))?;
        let call=state.delegations.lock().map_err(|_|Error::Cancelled)?.get(parent).cloned().ok_or_else(||invalid("这项分派不属于当前原生运行"))?;
        return state.gateway.finish_children(&state.permit,&call);
    }
    let child=if let Some(id)=child_id {
        let child=state.children.lock().map_err(|_|Error::Cancelled)?.get(id).cloned().ok_or_else(||invalid("只读子会话尚未在原生宿主登记"))?;
        if child.authority.parent_call_id!=parent {return Err(Error::Stale);}
        Some(child)
    }else{None};
    let http=request.name.starts_with("__model_http_")&&request.tool_call_id.starts_with("http-");
    if http {
        let controller=if let Some(child)=&child {child.model_http.clone()}else{state.model_http.lock().map_err(|_|Error::Cancelled)?.clone()}.ok_or_else(||invalid("当前原生模型传输尚未准备好"))?;
        return controller.invoke(request.name.trim_start_matches("__model_http_"),&request.args,token).await.map(|data|json!({"ok":true,"data":data}));
    }
    if request.name=="__progress_decision"&&request.tool_call_id.starts_with("review-")&&child.is_none(){return state.gateway.progress_decision(&state.permit,&request.args).map(|data|json!({"ok":true,"data":data}));}
    if request.name=="read_task_state"&&request.tool_call_id.starts_with("context-")&&request.args.as_object().is_some_and(|v|v.is_empty()) {
        let data=if let Some(child)=&child {state.gateway.child_context(&state.permit,&child.authority)?}else{state.gateway.task_context(&state.permit)?};
        state.gateway.0.event(&state.permit.task_id,&json!({"type":"task_context_read","childId":child_id,"intentRevision":data["intentRevision"],"status":data["status"]}))?;
        return Ok(json!({"ok":true,"data":data}));
    }
    let call=PiCallRequest{task_id:state.permit.task_id.clone(),call_id:child.as_ref().map(|child|child.authority.call_id(&request.tool_call_id)).unwrap_or(request.tool_call_id),tool:request.name,args:request.args,
        intent_revision:child.as_ref().map(|child|child.authority.intent_revision).unwrap_or(revision),world_version:child.as_ref().map(|child|child.authority.world_version.clone()).unwrap_or_else(||state.world_version.clone()),external_write:false};
    if call.tool=="delegate_readonly" {
        if child.is_some(){return Err(invalid("只读子助手不能再次分派"));}
        let value=state.gateway.prepare_children(&state.permit,&call)?;
        if value["ok"]==true&&value["data"]["children"].is_array() {
            state.delegations.lock().map_err(|_|Error::Cancelled)?.insert(call.call_id.clone(),call);
            let mut value=value;value["data"]["tools"]=json!(crate::pi_children::catalog().into_iter().map(|tool|json!({"name":tool.name,"description":tool.description,"parameters":tool.parameters,"readOnly":true})).collect::<Vec<_>>());return Ok(value);
        }
        return Ok(value);
    }
    let actor=child.as_ref().map(|child|child.authority.clone());
    let actor_cancel=child.as_ref().map(|child|child.cancel.clone()).unwrap_or_else(||token.child_token());
    // Native authority is rechecked inside every tool and before actual model
    // sends. Cancellation also stops reads already waiting on a remote host.
    tokio::select!{biased;_=token.cancelled()=>Err(Error::Cancelled),_=actor_cancel.cancelled()=>Err(Error::Cancelled),value=crate::pi_async::invoke_scoped(state.gateway.clone(),state.permit.clone(),call,actor_cancel.clone(),state.network.clone(),state.prompt_cancel.clone(),actor)=>value}
}

fn validate_envelope(state: &State, record: &Value) -> Result<()> {
    if record["taskId"]
        .as_str()
        .is_some_and(|id| id != state.permit.task_id)
    {
        return Err(invalid("Pi事件不属于当前任务"));
    }
    if let Some(id)=record["childId"].as_str() {
        let children=state.children.lock().map_err(|_|Error::Cancelled)?;
        let child=children.get(id).ok_or_else(||invalid("事件不属于已登记的子会话"))?;
        if record["parentCallId"]!=child.authority.parent_call_id{return Err(Error::Stale);}
    }
    if let Some(expected) = state
        .pi_session
        .lock()
        .map_err(|_| Error::Cancelled)?
        .as_deref()
    {
        if record["sessionId"].as_str() != Some(expected) {
            return Err(invalid("Pi事件不属于当前会话"));
        }
    }
    Ok(())
}
