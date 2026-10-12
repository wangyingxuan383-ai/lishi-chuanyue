//! Only status crosses IPC after save/delete. Platform work runs off the UI thread.

use std::sync::Arc;
use std::time::Duration;

use lishi_core::secret_probe::{ProbeSecretStatus, SecretProbe};
use lishi_core::secrets::{SecretStoreError, SecretValue};
use serde::Serialize;

#[derive(Serialize)]
pub struct SecretCommandError {
    code: &'static str,
}

const SECRET_CALL_TIMEOUT: Duration = Duration::from_secs(10);

async fn run_secret_task(
    work: impl FnOnce() -> Result<ProbeSecretStatus, SecretStoreError> + Send + 'static,
) -> Result<ProbeSecretStatus, SecretCommandError> {
    run_secret_task_with_timeout(SECRET_CALL_TIMEOUT, work).await
}

async fn run_secret_task_with_timeout(
    timeout: Duration,
    work: impl FnOnce() -> Result<ProbeSecretStatus, SecretStoreError> + Send + 'static,
) -> Result<ProbeSecretStatus, SecretCommandError> {
    // Commands acquire an owned core reservation before enqueueing this work.
    // On timeout abort may stop queued work; started platform calls continue.
    // The reservation remains owned by the task until it drops or really ends.
    let mut task = tauri::async_runtime::spawn_blocking(work);
    match tokio::time::timeout(timeout, &mut task).await {
        Err(_) => {
            task.abort();
            Err(SecretCommandError {
                code: "secret_unconfirmed",
            })
        }
        Ok(Err(_)) => Err(SecretStoreError::Unavailable.into()),
        Ok(Ok(result)) => result.map_err(Into::into),
    }
}

impl From<SecretStoreError> for SecretCommandError {
    fn from(error: SecretStoreError) -> Self {
        Self {
            code: match error {
                SecretStoreError::InvalidSlot => "secret_invalid_slot",
                SecretStoreError::InvalidSecret => "secret_invalid_value",
                SecretStoreError::Unavailable => "secret_unavailable",
                SecretStoreError::Corrupted => "secret_corrupted",
                SecretStoreError::KeyUnavailable => "secret_key_unavailable",
                SecretStoreError::IoError => "secret_io_error",
            },
        }
    }
}

#[tauri::command]
pub async fn get_probe_secret_status(
    probe: tauri::State<'_, Arc<SecretProbe>>,
) -> Result<ProbeSecretStatus, SecretCommandError> {
    let operation = probe.reserve()?;
    run_secret_task(move || operation.status()).await
}

#[tauri::command]
pub async fn save_probe_secret(
    token: String,
    probe: tauri::State<'_, Arc<SecretProbe>>,
) -> Result<ProbeSecretStatus, SecretCommandError> {
    let token = SecretValue::new(token)?;
    let operation = probe.reserve()?;
    run_secret_task(move || operation.save(token)).await
}

#[tauri::command]
pub async fn delete_probe_secret(
    probe: tauri::State<'_, Arc<SecretProbe>>,
) -> Result<ProbeSecretStatus, SecretCommandError> {
    let operation = probe.reserve()?;
    run_secret_task(move || operation.delete()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[tokio::test]
    async fn caller_timeout_is_unconfirmed_and_does_not_cancel_the_worker() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let result = run_secret_task_with_timeout(Duration::from_millis(30), move || {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            finished_tx.send(()).unwrap();
            Ok(ProbeSecretStatus { configured: false })
        })
        .await;
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(result.unwrap_err().code, "secret_unconfirmed");
        assert!(matches!(
            finished_rx.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        release_tx.send(()).unwrap();
        finished_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    }
}
