use serde::Serialize;
use std::sync::Arc;
use tauri::Manager;

mod stream_probe;

#[cfg(target_os = "android")]
mod android_tls;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeInfo {
    core_version: &'static str,
    platform: &'static str,
}

#[derive(Serialize)]
struct ProbeCommandError {
    code: &'static str,
    message: &'static str,
}

fn storage_error() -> ProbeCommandError {
    ProbeCommandError {
        code: "storage_failed",
        message: "本地数据库操作失败，请重新读取核实。",
    }
}

#[tauri::command]
fn probe_info() -> ProbeInfo {
    ProbeInfo {
        core_version: lishi_core::CORE_VERSION,
        platform: std::env::consts::OS,
    }
}

#[tauri::command]
fn echo_text(text: String) -> lishi_core::EchoResult {
    lishi_core::echo_text(text)
}

#[tauri::command]
async fn read_probe_note(
    store: tauri::State<'_, Arc<lishi_core::storage::ProbeStore>>,
) -> Result<Option<lishi_core::storage::ProbeNote>, ProbeCommandError> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.read_note())
        .await
        .map_err(|_| storage_error())?
        .map_err(|_| storage_error())
}

#[tauri::command]
async fn save_probe_note(
    text: String,
    store: tauri::State<'_, Arc<lishi_core::storage::ProbeStore>>,
) -> Result<lishi_core::storage::ProbeNote, ProbeCommandError> {
    if text.len() > lishi_core::storage::MAX_PROBE_NOTE_BYTES {
        return Err(ProbeCommandError {
            code: "note_too_large",
            message: "测试笔记超过 64 KiB，请减少内容后重试。",
        });
    }
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.save_note(&text))
        .await
        .map_err(|_| storage_error())?
        .map_err(|_| storage_error())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "android")]
            android_tls::initialize(app)?;
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let store = lishi_core::storage::ProbeStore::open(data_dir.join("m01-probe.sqlite"))?;
            app.manage(Arc::new(store));
            app.manage(Arc::new(lishi_core::probe_jobs::ProbeJobs::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_info,
            echo_text,
            read_probe_note,
            save_probe_note,
            stream_probe::start_probe_stream,
            stream_probe::cancel_probe_stream,
            stream_probe::get_probe_stream
        ])
        .run(tauri::generate_context!())
        .expect("failed to run platform probe");
}
