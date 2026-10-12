//! Native IPC transport only; network and operation coordination live in core.

use std::sync::Arc;

use lishi_core::probe_jobs::{ProbeCancelReply, ProbeJobError, ProbeJobs, ProbeStreamSnapshot};
use lishi_core::{ProbeStreamEvent, StreamResult};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeStreamRequest {
    operation_id: String,
    url: String,
}

#[derive(Serialize)]
pub struct ProbeStreamCommandError {
    code: &'static str,
}

impl From<ProbeJobError> for ProbeStreamCommandError {
    fn from(error: ProbeJobError) -> Self {
        Self {
            code: match error {
                ProbeJobError::Busy => "stream_busy",
                ProbeJobError::Duplicate => "stream_duplicate",
                ProbeJobError::InvalidId => "stream_invalid_id",
                ProbeJobError::Unavailable => "stream_state_unavailable",
            },
        }
    }
}

#[tauri::command]
pub async fn start_probe_stream(
    request: ProbeStreamRequest,
    on_event: Channel<ProbeStreamEvent>,
    jobs: tauri::State<'_, Arc<ProbeJobs>>,
) -> Result<StreamResult, ProbeStreamCommandError> {
    #[cfg(target_os = "android")]
    if !crate::android_tls::is_ready() {
        return Err(ProbeStreamCommandError {
            code: "stream_tls_unavailable",
        });
    }
    let jobs = Arc::clone(jobs.inner());
    // Reservation precedes network I/O, including duplicate/busy rejection.
    let cancel = jobs.register(&request.operation_id)?;
    let result = lishi_core::run_probe_stream(request.operation_id, request.url, cancel, |event| {
        jobs.record_event(&event) && on_event.send(event).is_ok()
    })
    .await;
    jobs.finish(&result)?;
    Ok(result)
}

#[tauri::command]
pub fn cancel_probe_stream(
    operation_id: String,
    jobs: tauri::State<'_, Arc<ProbeJobs>>,
) -> Result<ProbeCancelReply, ProbeStreamCommandError> {
    Ok(jobs.cancel(&operation_id)?)
}

#[tauri::command]
pub fn get_probe_stream(
    operation_id: Option<String>,
    jobs: tauri::State<'_, Arc<ProbeJobs>>,
) -> Result<Option<ProbeStreamSnapshot>, ProbeStreamCommandError> {
    Ok(jobs.snapshot(operation_id.as_deref())?)
}
