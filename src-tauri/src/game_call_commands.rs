//! Safe local model transport accounting, separate from portable game facts.
use super::{blocking, GameCommandError, GameService};
use lishi_core::game_call_log::{CallAttempt, CallLog};
use std::sync::Arc;

pub(super) async fn reserve(
    service: Arc<GameService>,
    request: &lishi_core::game_store::GameTurnRequest,
    model: &str,
    prompt_version: u32,
) -> Result<(Arc<CallLog>, u8), GameCommandError> {
    let request = request.clone();
    let model = model.to_owned();
    blocking(move || {
        let log = service.calls()?;
        let sequence = log
            .reserve(
                &request.operation_id,
                &request.world_id,
                &request.branch_id,
                &model,
                prompt_version,
            )
            .map_err(|e| GameCommandError::new(e.to_string()))?;
        Ok((log, sequence))
    })
    .await
}

pub(super) async fn finish(
    log: Arc<CallLog>,
    operation_id: &str,
    sequence: u8,
    result: &lishi_core::model_probe::ModelProbeResult,
) -> Result<(), GameCommandError> {
    let operation_id = operation_id.to_owned();
    let diagnostics = result.diagnostics.clone();
    let status = result.stream.status;
    let error = result.stream.error_code;
    blocking(move || {
        log.finish(&operation_id, sequence, &diagnostics, status, error)
            .map_err(|e| GameCommandError::new(e.to_string()))?;
        Ok(())
    })
    .await
}

impl GameService {
    pub(super) fn calls(&self) -> Result<Arc<CallLog>, GameCommandError> {
        let mut guard = self
            .call_log
            .lock()
            .map_err(|_| GameCommandError::new("call_log_unavailable"))?;
        if let Some(log) = guard.as_ref() {
            return Ok(Arc::clone(log));
        }
        let log = Arc::new(
            CallLog::open(&self.call_log_path).map_err(|e| GameCommandError::new(e.to_string()))?,
        );
        *guard = Some(Arc::clone(&log));
        Ok(log)
    }
}

#[tauri::command]
pub async fn get_game_calls(
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<Vec<CallAttempt>, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || {
        service
            .calls()?
            .list(100)
            .map_err(|e| GameCommandError::new(e.to_string()))
    })
    .await
}
