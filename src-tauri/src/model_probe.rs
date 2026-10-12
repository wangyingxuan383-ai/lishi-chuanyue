//! Controlled M01 model transport. Credentials stay in native owned values;
//! history contains only closed status codes and measured diagnostics.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use lishi_core::{
    model_probe::{CredentialMode, ModelProbeDiagnostics, ModelProbeRequest, ModelProbeResult},
    probe_jobs::{ProbeCancelReply, ProbeJobError, ProbeJobState, ProbeJobs, ProbeStreamSnapshot},
    secret_probe::SecretProbe,
    secrets::{SecretStoreError, SecretValue},
    CancellationToken, ProbeStreamEvent, StreamErrorCode, StreamEventKind, StreamResult,
    StreamStatus,
};
use serde::Serialize;
use tauri::ipc::Channel;

const HISTORY_LIMIT: usize = 10;
const SECRET_READ_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct ModelProbe {
    jobs: ProbeJobs,
    history: Mutex<VecDeque<ModelProbeHistory>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProbeHistory {
    operation_id: String,
    status: StreamStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<StreamErrorCode>,
    // A dropped caller never guesses HTTP attempts, usage, or status.
    diagnostics: Option<ModelProbeDiagnostics>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProbeSnapshot {
    stream: ProbeStreamSnapshot,
    diagnostics: Option<ModelProbeDiagnostics>,
}

#[derive(Debug, Serialize)]
pub struct ModelCommandError {
    code: String,
}

impl From<ProbeJobError> for ModelCommandError {
    fn from(error: ProbeJobError) -> Self {
        Self {
            code: match error {
                ProbeJobError::Busy => "model_busy",
                ProbeJobError::Duplicate => "model_duplicate",
                ProbeJobError::InvalidId => "model_invalid_id",
                ProbeJobError::Unavailable => "model_state_unavailable",
            }
            .to_owned(),
        }
    }
}

impl From<StreamErrorCode> for ModelCommandError {
    fn from(error: StreamErrorCode) -> Self {
        // This enum is closed and contains no URLs, bodies, or platform errors.
        let code = serde_json::to_value(error)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "model_state_unavailable".to_owned());
        Self { code }
    }
}

impl ModelProbe {
    fn reserve(self: &Arc<Self>, operation_id: &str) -> Result<ModelLease, ProbeJobError> {
        let cancel = self.jobs.register(operation_id)?;
        Ok(ModelLease {
            probe: Arc::clone(self),
            operation_id: operation_id.to_owned(),
            cancel,
            started_at: Instant::now(),
            finished: false,
        })
    }

    fn finish(
        &self,
        stream: &StreamResult,
        diagnostics: Option<ModelProbeDiagnostics>,
    ) -> Result<(), ProbeJobError> {
        // Get/history/finish share this lock order, so a final result and its
        // diagnostic record cannot race with a second reservation's history.
        let mut history = self
            .history
            .lock()
            .map_err(|_| ProbeJobError::Unavailable)?;
        self.jobs.finish(stream)?;
        history.push_front(ModelProbeHistory {
            operation_id: stream.operation_id.clone(),
            status: stream.status,
            error_code: stream.error_code,
            diagnostics,
        });
        history.truncate(HISTORY_LIMIT);
        Ok(())
    }

    fn snapshot(&self, id: Option<&str>) -> Result<Option<ModelProbeSnapshot>, ProbeJobError> {
        let history = self
            .history
            .lock()
            .map_err(|_| ProbeJobError::Unavailable)?;
        let Some(stream) = self.jobs.snapshot(id)? else {
            return Ok(None);
        };
        let diagnostics = history
            .iter()
            .find(|entry| entry.operation_id == stream.operation_id)
            .and_then(|entry| entry.diagnostics.clone());
        Ok(Some(ModelProbeSnapshot {
            stream,
            diagnostics,
        }))
    }

    fn history(&self) -> Result<Vec<ModelProbeHistory>, ProbeJobError> {
        Ok(self
            .history
            .lock()
            .map_err(|_| ProbeJobError::Unavailable)?
            .iter()
            .cloned()
            .collect())
    }
}

/// A registered request always owns a terminal cleanup, even if its future is
/// cancelled before dispatch, while loading a credential, or during HTTP.
struct ModelLease {
    probe: Arc<ModelProbe>,
    operation_id: String,
    cancel: CancellationToken,
    started_at: Instant,
    finished: bool,
}

impl ModelLease {
    fn finish(mut self, result: &ModelProbeResult) -> Result<(), ProbeJobError> {
        self.probe
            .finish(&result.stream, Some(result.diagnostics.clone()))?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for ModelLease {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.cancel.cancel();
        let Ok(Some(snapshot)) = self.probe.jobs.snapshot(Some(&self.operation_id)) else {
            return;
        };
        // Preserve an already-recorded terminal event. Cleanup never lowers a
        // completed/failed/cancelled state back to running or invents output.
        let (status, error_code) = match snapshot.state {
            ProbeJobState::Running => (
                StreamStatus::Cancelled,
                Some(StreamErrorCode::OperationDropped),
            ),
            ProbeJobState::Completed => (StreamStatus::Completed, snapshot.error_code),
            ProbeJobState::Cancelled => (StreamStatus::Cancelled, snapshot.error_code),
            ProbeJobState::Failed => (StreamStatus::Failed, snapshot.error_code),
        };
        let stream = StreamResult {
            operation_id: self.operation_id.clone(),
            status,
            error_code,
            text: snapshot.text,
            delta_count: snapshot.delta_count,
        };
        let _ = self.probe.finish(&stream, None);
    }
}

enum CredentialReadError {
    Missing,
    Unavailable,
    Unconfirmed,
    Cancelled,
}

impl CredentialReadError {
    fn stream_error(&self) -> Option<StreamErrorCode> {
        match self {
            Self::Missing => Some(StreamErrorCode::CredentialMissing),
            Self::Unavailable => Some(StreamErrorCode::CredentialUnavailable),
            Self::Unconfirmed => Some(StreamErrorCode::CredentialUnconfirmed),
            Self::Cancelled => None,
        }
    }
}

type SecretReadResult = Result<Option<SecretValue>, SecretStoreError>;

struct SecretReadWorker {
    task: tauri::async_runtime::JoinHandle<SecretReadResult>,
}

impl Drop for SecretReadWorker {
    fn drop(&mut self) {
        // Aborting only cancels queued work. A started native worker keeps its
        // owned SecretProbe reservation until the platform read actually ends.
        self.task.abort();
    }
}

async fn read_request_secret(
    probe: &SecretProbe,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<SecretValue, CredentialReadError> {
    if cancel.is_cancelled() {
        return Err(CredentialReadError::Cancelled);
    }
    // Reserve before enqueueing; a second settings/read operation cannot sneak
    // into the platform worker's queued interval.
    let operation = probe
        .reserve()
        .map_err(|_| CredentialReadError::Unavailable)?;
    let mut worker = SecretReadWorker {
        task: tauri::async_runtime::spawn_blocking(move || operation.load_for_request()),
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(CredentialReadError::Cancelled),
        result = tokio::time::timeout(timeout, &mut worker.task) => {
            match result {
                Err(_) => Err(CredentialReadError::Unconfirmed),
                Ok(Err(_)) | Ok(Ok(Err(_))) => Err(CredentialReadError::Unavailable),
                Ok(Ok(Ok(None))) => Err(CredentialReadError::Missing),
                Ok(Ok(Ok(Some(value)))) => {
                    if cancel.is_cancelled() {
                        Err(CredentialReadError::Cancelled)
                    } else {
                        Ok(value)
                    }
                }
            }
        }
    }
}

fn pre_dispatch_result(
    lease: &ModelLease,
    error: CredentialReadError,
    emit: &mut impl FnMut(ProbeStreamEvent) -> bool,
) -> ModelProbeResult {
    let started = ProbeStreamEvent {
        operation_id: lease.operation_id.clone(),
        sequence: 0,
        kind: StreamEventKind::Started,
        text: None,
        status: None,
        error_code: None,
    };
    let consumer_open = emit(started);
    let status = if matches!(error, CredentialReadError::Cancelled) || !consumer_open {
        StreamStatus::Cancelled
    } else {
        StreamStatus::Failed
    };
    let error_code = if !consumer_open {
        Some(StreamErrorCode::ConsumerClosed)
    } else {
        error.stream_error()
    };
    let stream = StreamResult {
        operation_id: lease.operation_id.clone(),
        status,
        error_code,
        text: String::new(),
        delta_count: 0,
    };
    emit(ProbeStreamEvent {
        operation_id: lease.operation_id.clone(),
        sequence: 1,
        kind: StreamEventKind::Finished,
        text: None,
        status: Some(status),
        error_code,
    });
    ModelProbeResult {
        stream,
        diagnostics: ModelProbeDiagnostics {
            http_status: None,
            usage: None,
            elapsed_ms: lease.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
            attempts: 0,
        },
    }
}

#[tauri::command]
pub async fn start_probe_model(
    request: ModelProbeRequest,
    on_event: Channel<ProbeStreamEvent>,
    probe: tauri::State<'_, Arc<ModelProbe>>,
    secrets: tauri::State<'_, Arc<SecretProbe>>,
) -> Result<ModelProbeResult, ModelCommandError> {
    request.validate()?;
    #[cfg(target_os = "android")]
    if !crate::android_tls::is_ready() {
        return Err(ModelCommandError {
            code: "model_tls_unavailable".to_owned(),
        });
    }
    let probe = Arc::clone(probe.inner());
    let lease = probe.reserve(&request.operation_id)?;
    let mut emit =
        |event: ProbeStreamEvent| probe.jobs.record_event(&event) && on_event.send(event).is_ok();
    let secret = if request.credential_mode == CredentialMode::Saved {
        match read_request_secret(secrets.inner(), &lease.cancel, SECRET_READ_TIMEOUT).await {
            Ok(secret) => Some(secret),
            Err(error) => {
                let result = pre_dispatch_result(&lease, error, &mut emit);
                lease.finish(&result)?;
                return Ok(result);
            }
        }
    } else {
        None
    };
    // The core checks cancellation again before starting HTTP. The owned
    // SecretValue is frozen for this one request and never crosses IPC.
    let mut result =
        lishi_core::model_probe::run_model_probe(request, secret, lease.cancel.clone(), emit).await;
    // The native operation includes platform credential reading as well as
    // HTTP. Core timing remains independent of this host service.
    result.diagnostics.elapsed_ms =
        u64::try_from(lease.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    lease.finish(&result)?;
    Ok(result)
}

#[tauri::command]
pub fn cancel_probe_model(
    operation_id: String,
    probe: tauri::State<'_, Arc<ModelProbe>>,
) -> Result<ProbeCancelReply, ModelCommandError> {
    Ok(probe.jobs.cancel(&operation_id)?)
}

#[tauri::command]
pub fn get_probe_model(
    operation_id: Option<String>,
    probe: tauri::State<'_, Arc<ModelProbe>>,
) -> Result<Option<ModelProbeSnapshot>, ModelCommandError> {
    Ok(probe.snapshot(operation_id.as_deref())?)
}

#[tauri::command]
pub fn list_probe_model_history(
    probe: tauri::State<'_, Arc<ModelProbe>>,
) -> Result<Vec<ModelProbeHistory>, ModelCommandError> {
    Ok(probe.history()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lishi_core::secrets::{SecretSlot, SecretStore};
    use std::sync::mpsc;

    struct MissingStore;
    impl SecretStore for MissingStore {
        fn save(&self, _: &SecretSlot, _: &SecretValue) -> Result<(), SecretStoreError> {
            Ok(())
        }
        fn load(&self, _: &SecretSlot) -> SecretReadResult {
            Ok(None)
        }
        fn delete(&self, _: &SecretSlot) -> Result<(), SecretStoreError> {
            Ok(())
        }
    }

    struct BlockingStore {
        entered: Mutex<Option<mpsc::Sender<()>>>,
        release: Mutex<mpsc::Receiver<()>>,
        finished: Mutex<Option<mpsc::Sender<()>>>,
    }

    impl SecretStore for BlockingStore {
        fn save(&self, _: &SecretSlot, _: &SecretValue) -> Result<(), SecretStoreError> {
            Ok(())
        }
        fn load(&self, _: &SecretSlot) -> SecretReadResult {
            self.entered
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .send(())
                .unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3))
                .map_err(|_| SecretStoreError::Unavailable)?;
            self.finished
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .send(())
                .unwrap();
            Ok(Some(
                SecretValue::new("invalid-native-read-fixture".to_owned()).unwrap(),
            ))
        }
        fn delete(&self, _: &SecretSlot) -> Result<(), SecretStoreError> {
            Ok(())
        }
    }

    fn blocking_store() -> (
        SecretProbe,
        mpsc::Receiver<()>,
        mpsc::Sender<()>,
        mpsc::Receiver<()>,
    ) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let probe = SecretProbe::new(Arc::new(BlockingStore {
            entered: Mutex::new(Some(entered_tx)),
            release: Mutex::new(release_rx),
            finished: Mutex::new(Some(finished_tx)),
        }))
        .unwrap();
        (probe, entered_rx, release_tx, finished_rx)
    }

    #[tokio::test]
    async fn missing_credential_is_terminal_with_zero_http_attempts() {
        let secrets = SecretProbe::new(Arc::new(MissingStore)).unwrap();
        let probe = Arc::new(ModelProbe::default());
        let lease = probe.reserve("native-missing-secret").unwrap();
        let error = read_request_secret(&secrets, &lease.cancel, Duration::from_secs(1))
            .await
            .err()
            .unwrap();
        assert!(matches!(error, CredentialReadError::Missing));
        let result =
            pre_dispatch_result(&lease, error, &mut |event| probe.jobs.record_event(&event));
        assert_eq!(result.stream.status, StreamStatus::Failed);
        assert_eq!(
            result.stream.error_code,
            Some(StreamErrorCode::CredentialMissing)
        );
        assert_eq!(result.diagnostics.attempts, 0);
        lease.finish(&result).unwrap();
        assert_eq!(
            probe
                .snapshot(Some("native-missing-secret"))
                .unwrap()
                .unwrap()
                .stream
                .state,
            ProbeJobState::Failed
        );
        assert!(probe.reserve("native-after-missing").is_ok());
    }

    #[tokio::test]
    async fn timed_out_platform_read_keeps_lease_until_worker_really_finishes() {
        let (probe, entered, release, finished) = blocking_store();
        let cancel = CancellationToken::new();
        let error = read_request_secret(&probe, &cancel, Duration::from_millis(50))
            .await
            .err()
            .unwrap();
        assert!(matches!(error, CredentialReadError::Unconfirmed));
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(matches!(
            probe.reserve(),
            Err(SecretStoreError::Unavailable)
        ));
        release.send(()).unwrap();
        finished.recv_timeout(Duration::from_secs(2)).unwrap();
        for _ in 0..100 {
            if probe.reserve().is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("owned secret reservation did not release");
    }

    #[tokio::test]
    async fn cancelling_during_key_read_stops_dispatch_and_keeps_worker_ownership() {
        let (secrets, entered, release, finished) = blocking_store();
        let cancel = CancellationToken::new();
        let canceller = cancel.clone();
        let signal = async {
            loop {
                match entered.try_recv() {
                    Ok(()) => break,
                    Err(mpsc::TryRecvError::Empty) => {
                        tokio::time::sleep(Duration::from_millis(1)).await
                    }
                    Err(_) => panic!("worker failed to enter"),
                }
            }
            canceller.cancel();
        };
        let (error, ()) = tokio::join!(
            read_request_secret(&secrets, &cancel, Duration::from_secs(2)),
            signal
        );
        let error = error.err().unwrap();
        assert!(matches!(error, CredentialReadError::Cancelled));
        let model = Arc::new(ModelProbe::default());
        let lease = model.reserve("native-cancel-read").unwrap();
        let result =
            pre_dispatch_result(&lease, error, &mut |event| model.jobs.record_event(&event));
        assert_eq!(result.stream.status, StreamStatus::Cancelled);
        assert_eq!(result.diagnostics.attempts, 0);
        lease.finish(&result).unwrap();
        assert!(model.reserve("native-after-cancel").is_ok());
        assert!(matches!(
            secrets.reserve(),
            Err(SecretStoreError::Unavailable)
        ));
        release.send(()).unwrap();
        finished.recv_timeout(Duration::from_secs(2)).unwrap();
    }

    #[tokio::test]
    async fn dropping_key_read_future_keeps_started_worker_reservation() {
        let (secrets, entered, release, finished) = blocking_store();
        let cancel = CancellationToken::new();
        let mut future = Box::pin(read_request_secret(
            &secrets,
            &cancel,
            Duration::from_secs(2),
        ));
        // Poll once to enqueue and retain its worker. Waiting for the entered
        // handshake does not require polling the read future a second time.
        tokio::select! {
            _ = &mut future => panic!("read unexpectedly finished"),
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
        }
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(future);
        assert!(matches!(
            secrets.reserve(),
            Err(SecretStoreError::Unavailable)
        ));
        release.send(()).unwrap();
        finished.recv_timeout(Duration::from_secs(2)).unwrap();
        for _ in 0..100 {
            if secrets.reserve().is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        panic!("worker's reservation remained after native read finished");
    }

    #[test]
    fn dropping_request_releases_job_without_fabricating_diagnostics() {
        let probe = Arc::new(ModelProbe::default());
        let lease = probe.reserve("native-drop-request").unwrap();
        let cancellation = lease.cancel.clone();
        assert!(matches!(
            probe.reserve("native-busy-request"),
            Err(ProbeJobError::Busy)
        ));
        drop(lease);
        assert!(cancellation.is_cancelled());
        let snapshot = probe
            .snapshot(Some("native-drop-request"))
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.stream.state, ProbeJobState::Cancelled);
        assert_eq!(
            snapshot.stream.error_code,
            Some(StreamErrorCode::OperationDropped)
        );
        assert!(snapshot.diagnostics.is_none());
        assert!(matches!(
            probe.reserve("native-drop-request"),
            Err(ProbeJobError::Duplicate)
        ));
        assert!(probe.reserve("native-new-request").is_ok());
    }

    #[test]
    fn cleanup_does_not_downgrade_a_recorded_terminal_event() {
        let probe = Arc::new(ModelProbe::default());
        let lease = probe.reserve("native-finished-event").unwrap();
        assert!(probe.jobs.record_event(&ProbeStreamEvent {
            operation_id: lease.operation_id.clone(),
            sequence: 0,
            kind: StreamEventKind::Started,
            text: None,
            status: None,
            error_code: None,
        }));
        assert!(probe.jobs.record_event(&ProbeStreamEvent {
            operation_id: lease.operation_id.clone(),
            sequence: 1,
            kind: StreamEventKind::Finished,
            text: None,
            status: Some(StreamStatus::Failed),
            error_code: Some(StreamErrorCode::HttpStatus),
        }));
        drop(lease);
        let snapshot = probe
            .snapshot(Some("native-finished-event"))
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.stream.state, ProbeJobState::Failed);
        assert_eq!(
            snapshot.stream.error_code,
            Some(StreamErrorCode::HttpStatus)
        );
        assert!(snapshot.diagnostics.is_none());
    }

    #[test]
    fn safe_history_is_bounded_and_never_contains_draft_or_request_metadata() {
        let probe = Arc::new(ModelProbe::default());
        for index in 0..12 {
            let lease = probe
                .reserve(&format!("native-history-{index:02}"))
                .unwrap();
            drop(lease);
        }
        let history = probe.history().unwrap();
        assert_eq!(history.len(), HISTORY_LIMIT);
        assert_eq!(history[0].operation_id, "native-history-11");
        assert!(probe.snapshot(Some("native-history-00")).unwrap().is_none());
        let value = serde_json::to_value(&history).unwrap();
        let fields = value[0].as_object().unwrap();
        assert_eq!(fields.len(), 4);
        assert!(fields.contains_key("operationId"));
        assert!(fields.contains_key("status"));
        assert!(fields.contains_key("errorCode"));
        assert!(fields.get("diagnostics").unwrap().is_null());
    }
}
