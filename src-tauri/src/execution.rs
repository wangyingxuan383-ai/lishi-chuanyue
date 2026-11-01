//! Tauri adapters only: the scheduler and all model/tool settlement live in story-core.
#[path = "../../crates/agent-network.rs"]
mod agent_network;
#[cfg(not(target_os="android"))]
#[path = "../../crates/agent-documents.rs"]
mod agent_documents;
#[path = "../../crates/agent-model.rs"]
mod agent_model;
use crate::{
    credentials::Credentials,
    stream::{StreamEvent, Streams, Timeouts},
};
use serde_json::Value;
use std::{sync::Arc, time::Instant};
use story_core::{
    chat::{Accumulator, BoxFuture, Completion, Model, TextSink},
    runtime::Engine,
    Error, ModelConfig, RunPlan, RunSnapshot,
};
use tauri::State;
use tokio_util::sync::CancellationToken;

pub struct NativeModel {
    pub credentials: Arc<Credentials>,
    pub streams: Arc<Streams>,
}

// A dropped completion future must stop the independent native stream, even
// when its caller was aborted rather than explicitly cancelling the token.
struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl NativeModel {
    #[cfg(not(target_os="android"))]
    pub async fn document(request:Value,data:std::path::PathBuf,cancel:CancellationToken)->story_core::Result<Value> {
        tokio::task::spawn_blocking(move||agent_documents::execute(request,data,cancel)).await.map_err(|_|Error::Invalid("资料处理已中断".into()))?
    }
    pub fn network_counted(
        &self,
        request: Value,
        cancel: CancellationToken,
        accounting:Option<story_core::pi_accounting::NativeModelAccounting>,
    ) -> BoxFuture<story_core::Result<Value>> {
        let credentials = self.credentials.clone();
        Box::pin(async move {
            let client = crate::stream::client()
                .map_err(|_| Error::Invalid("无法初始化联网连接，请检查网络设置".into()))?;
            let authorize = Arc::new(move |slot: &str, url: &str| {
                credentials
                    .authorize(slot, url)
                    .map(|key| key.expose_secret().to_owned())
                    .map_err(|_| Error::Invalid("联网能力的密钥未配置或地址与绑定不符".into()))
            });
            agent_network::execute_counted(client, request, authorize, cancel,accounting).await
        })
    }
}
impl Model for NativeModel {
    fn network(&self,request:Value,cancel:CancellationToken)->BoxFuture<story_core::Result<Value>> {self.network_counted(request,cancel,None)}

    fn complete(
        &self,
        config: ModelConfig,
        body: Value,
        cancel: CancellationToken,
        text: TextSink,
    ) -> BoxFuture<story_core::Result<Completion>> {
        let credentials = self.credentials.clone();
        let streams = self.streams.clone();
        Box::pin(async move {
            if config.protocol() != "chat-completions" {
                let key=credentials.authorize(&config.slot,&config.url)
                    .map_err(|_|Error::Invalid("模型凭据未配置或地址与绑定不符".into()))?;
                let client=crate::stream::client().map_err(|_|Error::Invalid("无法初始化模型连接，请检查网络设置".into()))?;
                return agent_model::complete(client,config,body,key.expose_secret().to_owned(),cancel,text).await;
            }
            let body=story_core::chat::wire_chat_body(body);
            let tools=body["tools"].as_array().cloned().unwrap_or_default();
            let started = Instant::now();
            let cancel_on_drop = CancelOnDrop(cancel.clone());
            let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
            let id = streams
                .start_request(
                    credentials,
                    config.slot,
                    config.url,
                    body,
                    Timeouts {
                        first_byte_ms: 120_000,
                        idle_ms: 120_000,
                        total_ms: 180_000,
                    },
                    Arc::new(move |event| {
                        let _ = send.send(event);
                    }),
                )
                .await
                .map_err(|e| Error::Invalid(e.message.into()))?;
            // Dropping the request future must cancel its native network work too.
            let drop_cancel = cancel.clone();
            let drop_streams = streams.clone();
            let drop_id = id.clone();
            let cleanup = tokio::spawn(async move {
                drop_cancel.cancelled().await;
                // ack first cancels/waits for the stream, then removes its
                // temporary transcript. The durable run owns reusable output.
                let _ = drop_streams.ack(drop_id).await;
            });
            let mut accumulator = Accumulator::default();
            let result = loop {
                let event = tokio::select! {_ = cancel.cancelled()=>break Err(Error::Cancelled),event=receive.recv()=>event};
                match event {
                    Some(StreamEvent::Data { data }) => {
                        if accumulator.push(&data).is_some() {
                            accumulator
                                .result
                                .first_token_ms
                                .get_or_insert(started.elapsed().as_millis() as u64);
                            text(accumulator.result.text.clone());
                        }
                    }
                    Some(StreamEvent::Done) => {
                        accumulator.result.total_ms = started.elapsed().as_millis() as u64;
                        break accumulator.finish_with_tools(&tools);
                    }
                    Some(StreamEvent::Error {
                        kind,
                        status,
                        message,
                    }) => {
                        break Err(if kind == "cancelled" {
                            Error::Cancelled
                        } else {
                            Error::Invalid(format!(
                                "{}{}",
                                status
                                    .map(|s| format!("AI 服务返回 {s}："))
                                    .unwrap_or_default(),
                                message.unwrap_or_else(|| format!("模型请求未完成（{kind}）"))
                            ))
                        })
                    }
                    Some(StreamEvent::Open { .. }) => {}
                    None => break Err(Error::Invalid("模型连接已经结束".into())),
                }
            };
            drop(cancel_on_drop);
            let _ = cleanup.await;
            result
        })
    }
}
fn message(error: story_core::Error) -> Value {
    serde_json::json!({"code":"execution","message":error.to_string()})
}

#[tauri::command]
pub async fn execution_start(
    engine: State<'_, Arc<Engine>>,
    plan: RunPlan,
) -> Result<String, Value> {
    engine.start(plan).map_err(message)
}
#[tauri::command]
pub async fn execution_snapshot(
    engine: State<'_, Arc<Engine>>,
    id: String,
    after: u64,
) -> Result<RunSnapshot, Value> {
    engine.snapshot(&id, after).map_err(message)
}
#[tauri::command]
pub async fn execution_list(engine: State<'_, Arc<Engine>>) -> Result<Value, Value> {
    engine.store.list().map_err(message)
}
#[tauri::command]
pub async fn execution_stop(engine: State<'_, Arc<Engine>>, id: String) -> Result<(), Value> {
    engine.stop(&id).map_err(message)
}
#[tauri::command]
pub async fn execution_resume(engine: State<'_, Arc<Engine>>, id: String) -> Result<(), Value> {
    engine.resume(&id).map_err(message)
}

#[tauri::command]
pub async fn execution_agent(
    engine: State<'_, Arc<Engine>>,
    request: Value,
) -> Result<Value, Value> {
    engine.agent_request(request).await.map_err(message)
}

#[tauri::command]
pub async fn execution_settle(state: Value, record: Value, options: Value) -> Result<Value, Value> {
    story_core::rules::apply_record(&state, &record, &options)
        .map_err(Error::Invalid)
        .map_err(message)
}

#[tauri::command]
pub async fn execution_context(input: Value) -> Result<Value, Value> {
    story_core::writing_context::build(&input).map_err(message)
}
