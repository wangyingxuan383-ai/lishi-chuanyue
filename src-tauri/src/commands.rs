use crate::{
    credentials::{Credentials, SecretStatus},
    error::{blocking, Result},
    sql::{BackupInfo, SqlStore, Statement},
    stream::{self, GetResponse, Resume, StreamEvent, StreamInfo, Streams, Timeouts},
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::sync::Arc;
use tauri::{ipc::Channel, State};

#[tauri::command]
pub async fn sql_query(
    store: State<'_, Arc<SqlStore>>,
    sql: String,
    params: Vec<Value>,
) -> Result<Vec<Map<String, Value>>> {
    let store = Arc::clone(store.inner());
    blocking(move || store.query(&sql, params)).await
}

#[tauri::command]
pub async fn sql_batch(store: State<'_, Arc<SqlStore>>, statements: Vec<Statement>) -> Result<()> {
    let store = Arc::clone(store.inner());
    blocking(move || store.batch(statements)).await
}

#[tauri::command]
pub async fn sql_backup(store: State<'_, Arc<SqlStore>>, label: String) -> Result<String> {
    let store = Arc::clone(store.inner());
    blocking(move || store.backup(&label)).await
}

#[tauri::command]
pub async fn sql_list_backups(store: State<'_, Arc<SqlStore>>) -> Result<Vec<BackupInfo>> {
    let store = Arc::clone(store.inner());
    blocking(move || store.list_backups()).await
}

/// Replaces the live database with a backup; returns the before-restore backup's name.
#[tauri::command]
pub async fn sql_restore(store: State<'_, Arc<SqlStore>>, name: String) -> Result<String> {
    let store = Arc::clone(store.inner());
    blocking(move || store.restore(&name)).await
}

#[tauri::command]
pub async fn secret_set(
    secrets: State<'_, Arc<Credentials>>,
    slot: String,
    value: String,
    bound_base_url: String,
) -> Result<()> {
    let secrets = Arc::clone(secrets.inner());
    blocking(move || secrets.set(&slot, value, &bound_base_url)).await
}

#[tauri::command]
pub async fn secret_has(
    secrets: State<'_, Arc<Credentials>>,
    slot: String,
) -> Result<SecretStatus> {
    let secrets = Arc::clone(secrets.inner());
    blocking(move || secrets.has(&slot)).await
}

#[tauri::command]
pub async fn secret_remove(secrets: State<'_, Arc<Credentials>>, slot: String) -> Result<()> {
    let secrets = Arc::clone(secrets.inner());
    blocking(move || secrets.remove(&slot)).await
}

#[tauri::command]
pub async fn llm_stream(
    secrets: State<'_, Arc<Credentials>>,
    streams: State<'_, Arc<Streams>>,
    slot: String,
    url: String,
    body: Value,
    timeouts: Timeouts,
    on_event: Channel<StreamEvent>,
) -> Result<String> {
    streams
        .start_request(
            Arc::clone(secrets.inner()),
            slot,
            url,
            body,
            timeouts,
            Arc::new(move |event| {
                let _ = on_event.send(event);
            }),
        )
        .await
}

#[tauri::command]
pub async fn llm_cancel(streams: State<'_, Arc<Streams>>, stream_id: String) -> Result<()> {
    streams.cancel(&stream_id).await
}

#[tauri::command]
pub async fn llm_stream_resume(
    streams: State<'_, Arc<Streams>>,
    stream_id: String,
) -> Result<Option<Resume>> {
    let streams = Arc::clone(streams.inner());
    blocking(move || streams.resume(&stream_id)).await
}

#[tauri::command]
pub async fn llm_stream_list(streams: State<'_, Arc<Streams>>) -> Result<Vec<StreamInfo>> {
    let streams = Arc::clone(streams.inner());
    blocking(move || streams.list()).await
}

#[tauri::command]
pub async fn llm_stream_ack(streams: State<'_, Arc<Streams>>, stream_id: String) -> Result<()> {
    streams.inner().ack(stream_id).await
}

#[tauri::command]
pub async fn llm_get(
    secrets: State<'_, Arc<Credentials>>,
    slot: String,
    url: String,
    timeout_ms: u64,
) -> Result<GetResponse> {
    let secrets = Arc::clone(secrets.inner());
    let target = url.clone();
    let key = blocking(move || secrets.authorize(&slot, &target)).await?;
    stream::get(&url, timeout_ms, key).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    platform: &'static str,
    app_version: &'static str,
}

#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    PlatformInfo {
        platform: if cfg!(target_os = "android") {
            "android"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else {
            "other"
        },
        app_version: env!("CARGO_PKG_VERSION"),
    }
}

/// 设置 → 网络: no proxy, the system's, or a custom http/socks5 one.
#[tauri::command]
pub async fn network_set(config: crate::stream::NetworkConfig) -> Result<()> {
    crate::stream::set_network(config)
}

/// A keyless HTTPS GET for public data (checking GitHub for a new release).
/// A debug build with a test update source reads the release list from it instead.
#[tauri::command]
pub async fn http_get_public(url: String, timeout_ms: u64) -> Result<crate::stream::GetResponse> {
    if let Some(local) = crate::updates::dev_release_url(&url) {
        return crate::updates::dev_get(&local, timeout_ms).await;
    }
    crate::stream::get_public(&url, timeout_ms).await
}
