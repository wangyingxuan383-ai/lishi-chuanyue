//! Native transport for the independent durable interruption probe.
//! Pause points are narrow technical controls, never model/tool permissions.

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use lishi_core::{
    recovery::{valid_recovery_id, RecoveryError, RecoveryStatus, RecoveryStore, RecoveryView},
    CancellationToken, ProbeStreamEvent, StreamStatus,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

struct ActiveRecovery {
    operation_id: String,
    cancel: CancellationToken,
}

pub struct RecoveryProbe {
    store: Arc<RecoveryStore>,
    active: Arc<Mutex<Option<ActiveRecovery>>>,
}

impl RecoveryProbe {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, RecoveryError> {
        Ok(Self {
            store: Arc::new(RecoveryStore::open(path)?),
            active: Arc::new(Mutex::new(None)),
        })
    }

    fn reserve(&self, operation_id: &str) -> Result<RecoveryLease, RecoveryError> {
        if !valid_recovery_id(operation_id) {
            return Err(RecoveryError::InvalidId);
        }
        let mut active = self.active.lock().map_err(|_| RecoveryError::Unavailable)?;
        if active.is_some() {
            return Err(RecoveryError::Busy);
        }
        let cancel = CancellationToken::new();
        *active = Some(ActiveRecovery {
            operation_id: operation_id.to_owned(),
            cancel: cancel.clone(),
        });
        Ok(RecoveryLease {
            store: Arc::clone(&self.store),
            active: Arc::clone(&self.active),
            operation_id: operation_id.to_owned(),
            cancel,
            persisted: false,
        })
    }
}

/// The reservation exists before queueing and stays owned by a running commit
/// worker. Dropping the caller cannot release a worker still inside its commit.
struct RecoveryLease {
    store: Arc<RecoveryStore>,
    active: Arc<Mutex<Option<ActiveRecovery>>>,
    operation_id: String,
    cancel: CancellationToken,
    persisted: bool,
}

impl Drop for RecoveryLease {
    fn drop(&mut self) {
        if self.persisted {
            // Terminal operations are protected by the SQL status predicate;
            // this only cleans up an unexpectedly dropped unfinished operation.
            let _ = self.store.finish_uncommitted(
                &self.operation_id,
                RecoveryStatus::Interrupted,
                Some("operation_dropped"),
            );
        }
        if let Ok(mut active) = self.active.lock() {
            if active
                .as_ref()
                .is_some_and(|item| item.operation_id == self.operation_id)
            {
                *active = None;
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryPause {
    #[default]
    None,
    Validating,
    Commit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryStreamRequest {
    operation_id: String,
    url: String,
    expected_head_operation_id: Option<String>,
    #[serde(default)]
    pause_at: RecoveryPause,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryPhase {
    Pending,
    Generating,
    Validating,
    CommitPaused,
    Committed,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RecoveryProbeEvent {
    Stream {
        event: ProbeStreamEvent,
    },
    Phase {
        #[serde(rename = "operationId")]
        operation_id: String,
        phase: RecoveryPhase,
    },
}

fn send_phase(
    channel: &Channel<RecoveryProbeEvent>,
    operation_id: &str,
    phase: RecoveryPhase,
) -> bool {
    channel
        .send(RecoveryProbeEvent::Phase {
            operation_id: operation_id.to_owned(),
            phase,
        })
        .is_ok()
}

#[derive(Serialize)]
pub struct RecoveryCommandError {
    code: String,
}

impl From<RecoveryError> for RecoveryCommandError {
    fn from(error: RecoveryError) -> Self {
        Self {
            code: error.to_string(),
        }
    }
}

fn worker_error(_: tauri::Error) -> RecoveryCommandError {
    RecoveryCommandError {
        code: "recovery_worker".to_owned(),
    }
}

fn safe_stream_error(error: Option<lishi_core::StreamErrorCode>) -> Option<String> {
    // Serialize a closed enum only. External response text/URL is not stored.
    error
        .and_then(|value| serde_json::to_value(value).ok())
        .and_then(|value| value.as_str().map(str::to_owned))
}

#[tauri::command]
pub async fn start_probe_recovery_stream(
    request: RecoveryStreamRequest,
    on_event: Channel<RecoveryProbeEvent>,
    probe: tauri::State<'_, Arc<RecoveryProbe>>,
) -> Result<RecoveryView, RecoveryCommandError> {
    #[cfg(target_os = "android")]
    if !crate::android_tls::is_ready() {
        return Err(RecoveryCommandError {
            code: "recovery_tls_unavailable".to_owned(),
        });
    }
    let lease = probe.reserve(&request.operation_id)?;
    let expected_head = request.expected_head_operation_id;
    let initial_channel = on_event.clone();
    let lease =
        tauri::async_runtime::spawn_blocking(move || -> Result<RecoveryLease, RecoveryError> {
            let mut lease = lease;
            lease
                .store
                .begin(&lease.operation_id, expected_head.as_deref())?;
            lease.persisted = true;
            if !send_phase(
                &initial_channel,
                &lease.operation_id,
                RecoveryPhase::Pending,
            ) || lease.cancel.is_cancelled()
            {
                lease.store.finish_uncommitted(
                    &lease.operation_id,
                    RecoveryStatus::Cancelled,
                    Some("consumer_closed"),
                )?;
                return Err(RecoveryError::Cancelled);
            }
            lease.store.mark_generating(&lease.operation_id)?;
            Ok(lease)
        })
        .await
        .map_err(worker_error)??;
    send_phase(&on_event, &lease.operation_id, RecoveryPhase::Generating);
    let result = lishi_core::run_probe_stream(
        request.operation_id,
        request.url,
        lease.cancel.clone(),
        |event| on_event.send(RecoveryProbeEvent::Stream { event }).is_ok(),
    )
    .await;

    if result.status != StreamStatus::Completed {
        let status = if result.status == StreamStatus::Cancelled {
            RecoveryStatus::Cancelled
        } else {
            RecoveryStatus::Failed
        };
        let error = safe_stream_error(result.error_code);
        return tauri::async_runtime::spawn_blocking(
            move || -> Result<RecoveryView, RecoveryError> {
                lease
                    .store
                    .finish_uncommitted(&lease.operation_id, status, error.as_deref())?;
                lease.store.view()
            },
        )
        .await
        .map_err(worker_error)?
        .map_err(Into::into);
    }

    let lease =
        tauri::async_runtime::spawn_blocking(move || -> Result<RecoveryLease, RecoveryError> {
            lease
                .store
                .stage_validation(&lease.operation_id, &result.text)?;
            Ok(lease)
        })
        .await
        .map_err(worker_error)??;
    let validation_channel_open =
        send_phase(&on_event, &lease.operation_id, RecoveryPhase::Validating);
    if request.pause_at == RecoveryPause::Validating && validation_channel_open {
        let _ = tokio::time::timeout(Duration::from_secs(20), lease.cancel.cancelled()).await;
    }
    if lease.cancel.is_cancelled() || !validation_channel_open {
        return tauri::async_runtime::spawn_blocking(
            move || -> Result<RecoveryView, RecoveryError> {
                lease.store.finish_uncommitted(
                    &lease.operation_id,
                    RecoveryStatus::Cancelled,
                    None,
                )?;
                lease.store.view()
            },
        )
        .await
        .map_err(worker_error)?
        .map_err(Into::into);
    }
    let pause = request.pause_at;
    tauri::async_runtime::spawn_blocking(move || -> Result<RecoveryView, RecoveryError> {
        let committed = lease.store.commit_with_hook(&lease.operation_id, || {
            if lease.cancel.is_cancelled() {
                return Err(RecoveryError::Cancelled);
            }
            if pause == RecoveryPause::Commit {
                // This signal is sent only after all transaction writes, before
                // COMMIT. The bounded delay is solely a controlled kill probe.
                if !send_phase(&on_event, &lease.operation_id, RecoveryPhase::CommitPaused) {
                    return Err(RecoveryError::Cancelled);
                }
                let until = Instant::now() + Duration::from_secs(20);
                while Instant::now() < until {
                    if lease.cancel.is_cancelled() {
                        return Err(RecoveryError::Cancelled);
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            if lease.cancel.is_cancelled() {
                return Err(RecoveryError::Cancelled);
            }
            Ok(())
        });
        match committed {
            Ok(()) => {
                send_phase(&on_event, &lease.operation_id, RecoveryPhase::Committed);
            }
            Err(RecoveryError::Cancelled) => {
                lease.store.finish_uncommitted(
                    &lease.operation_id,
                    RecoveryStatus::Cancelled,
                    None,
                )?;
            }
            Err(error) => {
                let _ = lease.store.finish_uncommitted(
                    &lease.operation_id,
                    RecoveryStatus::Failed,
                    Some(&error.to_string()),
                );
                return Err(error);
            }
        }
        lease.store.view()
    })
    .await
    .map_err(worker_error)?
    .map_err(Into::into)
}

#[derive(Serialize)]
pub struct RecoveryCancelReply {
    status: &'static str,
}

#[tauri::command]
pub fn cancel_probe_recovery(
    operation_id: String,
    probe: tauri::State<'_, Arc<RecoveryProbe>>,
) -> Result<RecoveryCancelReply, RecoveryCommandError> {
    if !valid_recovery_id(&operation_id) {
        return Err(RecoveryError::InvalidId.into());
    }
    let active = probe
        .active
        .lock()
        .map_err(|_| RecoveryError::Unavailable)?;
    let status = match active.as_ref() {
        Some(item) if item.operation_id == operation_id => {
            item.cancel.cancel();
            "cancel_requested"
        }
        Some(_) => "not_found",
        // A missing live handle does not prove that a supplied ID existed.
        // The durable get command supplies authoritative terminal status.
        None => "not_found",
    };
    Ok(RecoveryCancelReply { status })
}

#[tauri::command]
pub async fn get_probe_recovery(
    probe: tauri::State<'_, Arc<RecoveryProbe>>,
) -> Result<RecoveryView, RecoveryCommandError> {
    let store = Arc::clone(&probe.store);
    tauri::async_runtime::spawn_blocking(move || store.view())
        .await
        .map_err(worker_error)?
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_reservation_is_owned_and_cancel_does_not_release_worker() {
        let directory = tempfile::tempdir().unwrap();
        let probe = RecoveryProbe::open(directory.path().join("lease.sqlite")).unwrap();
        let lease = probe.reserve("recovery-owned-lease").unwrap();
        assert!(matches!(
            probe.reserve("recovery-next-lease"),
            Err(RecoveryError::Busy)
        ));
        lease.cancel.cancel();
        assert!(matches!(
            probe.reserve("recovery-next-lease"),
            Err(RecoveryError::Busy)
        ));
        drop(lease);
        assert!(probe.reserve("recovery-next-lease").is_ok());
    }

    #[tokio::test]
    async fn aborting_caller_handle_keeps_reservation_until_running_worker_ends() {
        let directory = tempfile::tempdir().unwrap();
        let probe = RecoveryProbe::open(directory.path().join("worker.sqlite")).unwrap();
        let lease = probe.reserve("recovery-running-worker").unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let handle = tauri::async_runtime::spawn_blocking(move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            drop(lease);
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        handle.abort();
        assert!(matches!(
            probe.reserve("recovery-second-worker"),
            Err(RecoveryError::Busy)
        ));
        release_tx.send(()).unwrap();
        handle.await.unwrap();
        assert!(probe.reserve("recovery-second-worker").is_ok());
    }

    #[test]
    fn dropped_persisted_lease_interrupts_only_uncommitted_operation() {
        let directory = tempfile::tempdir().unwrap();
        let probe = RecoveryProbe::open(directory.path().join("drop.sqlite")).unwrap();
        let mut lease = probe.reserve("recovery-dropped-op").unwrap();
        lease.store.begin(&lease.operation_id, None).unwrap();
        lease.persisted = true;
        lease.store.mark_generating(&lease.operation_id).unwrap();
        drop(lease);
        let view = probe.store.view().unwrap();
        assert_eq!(
            view.latest_operation.unwrap().status,
            RecoveryStatus::Interrupted
        );
        assert_eq!(view.snapshot.revision, 0);
        assert_eq!(view.active_operation_id, None);
        let mut committed = probe.reserve("recovery-commit-op").unwrap();
        committed
            .store
            .begin(&committed.operation_id, None)
            .unwrap();
        committed.persisted = true;
        committed
            .store
            .mark_generating(&committed.operation_id)
            .unwrap();
        committed
            .store
            .stage_validation(&committed.operation_id, "正式🙂")
            .unwrap();
        committed.store.commit(&committed.operation_id).unwrap();
        drop(committed);
        assert_eq!(
            probe.store.view().unwrap().latest_operation.unwrap().status,
            RecoveryStatus::Committed
        );
        assert_eq!(probe.store.view().unwrap().snapshot.revision, 1);
    }
}
