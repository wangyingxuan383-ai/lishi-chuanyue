//! Tauri adapters only: the scheduler and all model/tool settlement live in story-core.
#[path = "../../crates/agent-network.rs"]
mod agent_network;
#[cfg(not(target_os="android"))]
#[path = "../../crates/agent-documents.rs"]
mod agent_documents;
#[path = "../../crates/agent-model.rs"]
mod agent_model;
use crate::credentials::Credentials;
use serde_json::Value;
use std::sync::Arc;
use story_core::{
    chat::{BoxFuture, Completion, Model, TextSink},
    runtime::Engine,
    Error, ModelConfig, RunPlan, RunSnapshot, RunStopReceipt,
};
use tauri::State;
use tokio_util::sync::CancellationToken;

pub struct NativeModel {
    pub credentials: Arc<Credentials>,
}

fn model_start_error(error: crate::error::PlatformError) -> Error {
    use story_core::failure::FailKind;
    let kind = match error.code {
        "llm_no_secret" => "no_secret",
        "llm_url_not_bound" => "url_not_bound",
        "llm_bindings_unavailable" | "secret_failed" => {
            return Error::fail(FailKind::Setup, error.message);
        }
        "llm_stream_storage" => return Error::fail(FailKind::Storage, error.message),
        _ => return Error::Invalid(error.message.into()),
    };
    Error::Provider { kind: kind.into(), status: None, message: error.message.into(), partial: false }
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
        Box::pin(async move {
            // Route all protocols (including chat-completions) through in-memory
            // agent_model::complete so native runs avoid per-token .jsonl disk writes
            // and double SSE parsing while sharing the pooled HTTP client (R31-P3).
            let key = credentials
                .authorize(&config.slot, &config.url)
                .map_err(model_start_error)?;
            let client = crate::stream::client().map_err(|_| {
                Error::fail(
                    story_core::failure::FailKind::Network,
                    "无法初始化模型连接，请检查网络设置",
                )
            })?;
            agent_model::complete(
                client,
                config,
                body,
                key.expose_secret().to_owned(),
                cancel,
                text,
            )
            .await
        })
    }
}
fn message(error: story_core::Error) -> Value {
    serde_json::json!({"code":"execution","message":error.to_string(),"failure":story_core::failure::refused_at_start(&error)})
}
async fn blocking_exec<T: Send + 'static>(work: impl FnOnce() -> Result<T, Value> + Send + 'static) -> Result<T, Value> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| serde_json::json!({"code":"execution","message":"本地执行任务中断"}))?
}

#[tauri::command]
pub async fn execution_start(
    engine: State<'_, Arc<Engine>>,
    plan: RunPlan,
) -> Result<String, Value> {
    let engine = engine.inner().clone();
    blocking_exec(move || engine.start(plan).map_err(message)).await
}
#[tauri::command]
pub async fn execution_snapshot(
    engine: State<'_, Arc<Engine>>,
    id: String,
    after: u64,
) -> Result<RunSnapshot, Value> {
    let engine = engine.inner().clone();
    blocking_exec(move || {
        engine.snapshot(&id, after).map_err(|error| match error {
            Error::Sql(rusqlite::Error::QueryReturnedNoRows) => {
                serde_json::json!({"code":"execution_missing","message":"找不到这次运行"})
            }
            other => message(other),
        })
    })
    .await
}
#[tauri::command]
pub async fn execution_list(engine: State<'_, Arc<Engine>>) -> Result<Value, Value> {
    let engine = engine.inner().clone();
    blocking_exec(move || engine.store.list().map_err(message)).await
}
#[tauri::command]
pub async fn execution_stop(engine: State<'_, Arc<Engine>>, id: String, execution_id: Option<String>) -> Result<RunStopReceipt, Value> {
    let engine = engine.inner().clone();
    blocking_exec(move || {
        match execution_id {
            Some(execution_id) => engine.stop_execution(&id, &execution_id),
            None => engine.stop(&id),
        }
        .map_err(message)
    })
    .await
}
#[tauri::command]
pub async fn execution_resume(engine: State<'_, Arc<Engine>>, id: String) -> Result<(), Value> {
    let engine = engine.inner().clone();
    blocking_exec(move || engine.resume(&id).map_err(message)).await
}

#[tauri::command]
pub async fn execution_settle(state: Value, record: Value, options: Value) -> Result<Value, Value> {
    blocking_exec(move || {
        story_core::rules::apply_record(&state, &record, &options)
            .map_err(Error::Invalid)
            .map_err(message)
    })
    .await
}

#[tauri::command]
pub async fn execution_context(input: Value) -> Result<Value, Value> {
    blocking_exec(move || story_core::writing_context::build(&input).map_err(message)).await
}

#[tauri::command]
pub async fn execution_companion(
    companion: State<'_, Arc<story_core::companion_runtime::CompanionRuntime>>,
    request: Value,
) -> Result<Value, Value> {
    companion.inner().dispatch(request).await.map_err(message)
}
