use super::{blocking, GameCommandError, GameService, StoreRoute};
use lishi_core::game_branches::FactCorrection;
use lishi_core::game_branches::{
    BranchCard, BranchCreated, BranchEditRequest, BranchUpgradeReceipt, ForkBranchRequest,
};
use std::sync::Arc;
#[tauri::command]
pub async fn enable_game_branches(
    world_id: String,
    expected_head_turn_id: Option<String>,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<BranchUpgradeReceipt, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || {
        let active = s
            .active
            .lock()
            .map_err(|_| GameCommandError::new("game_unavailable"))?;
        if active.is_some() {
            return Err(GameCommandError::new("game_busy"));
        }
        let route = s.store(&world_id, false)?;
        let StoreRoute::V2(store) = route.as_ref() else {
            return Err(GameCommandError::new("game_upgrade_required"));
        };
        Ok(store.enable_branches(&s.backups, expected_head_turn_id.as_deref())?)
    })
    .await
}
#[tauri::command]
pub async fn list_game_branches(
    world_id: String,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<Option<Vec<BranchCard>>, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || {
        let route = s.store(&world_id, false)?;
        let StoreRoute::V2(store) = route.as_ref() else {
            return Ok(None);
        };
        if !store.branches_enabled()? {
            return Ok(None);
        }
        Ok(Some(store.list_branches()?))
    })
    .await
}
#[tauri::command]
pub async fn fork_game_branch(
    request: ForkBranchRequest,
    rewrite_turn_id: Option<String>,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<BranchCreated, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || {
        let active = s
            .active
            .lock()
            .map_err(|_| GameCommandError::new("game_unavailable"))?;
        if active.is_some() {
            return Err(GameCommandError::new("game_busy"));
        }
        let route = s.store(&request.world_id, false)?;
        let StoreRoute::V2(store) = route.as_ref() else {
            return Err(GameCommandError::new("game_upgrade_required"));
        };
        let watermark = s
            .memory(&request.world_id)?
            .annotations
            .watermark()
            .map_err(|e| GameCommandError::new(e.to_string()))?;
        let research_watermark = s
            .evidence_for_world(&request.world_id)?
            .watermark()
            .map_err(|e| GameCommandError::new(e.to_string()))?;
        Ok(if let Some(turn) = rewrite_turn_id {
            store.rewrite_branch_with_watermarks(&request, &turn, watermark, research_watermark)?
        } else {
            store.fork_branch_with_watermarks(&request, watermark, research_watermark)?
        })
    })
    .await
}
#[tauri::command]
pub async fn edit_game_branch(
    request: BranchEditRequest,
    name: Option<String>,
    archived: Option<bool>,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<BranchCard, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || {
        let active = s
            .active
            .lock()
            .map_err(|_| GameCommandError::new("game_unavailable"))?;
        if active.is_some() {
            return Err(GameCommandError::new("game_busy"));
        }
        let route = s.store(&request.world_id, false)?;
        let StoreRoute::V2(store) = route.as_ref() else {
            return Err(GameCommandError::new("game_upgrade_required"));
        };
        match (name, archived) {
            (Some(name), None) => Ok(store.rename_branch(&request, &name)?),
            (None, Some(true)) => Ok(store.archive_branch(&request)?),
            (None, Some(false)) => Ok(store.restore_branch(&request)?),
            _ => Err(GameCommandError::new("game_invalid_request")),
        }
    })
    .await
}
#[tauri::command]
pub async fn correct_game_fact(
    request: ForkBranchRequest,
    correction_operation_id: String,
    correction: FactCorrection,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<BranchCreated, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || {
        let active = s
            .active
            .lock()
            .map_err(|_| GameCommandError::new("game_unavailable"))?;
        if active.is_some() {
            return Err(GameCommandError::new("game_busy"));
        }
        let route = s.store(&request.world_id, false)?;
        let StoreRoute::V2(store) = route.as_ref() else {
            return Err(GameCommandError::new("game_upgrade_required"));
        };
        let watermark = s
            .memory(&request.world_id)?
            .annotations
            .watermark()
            .map_err(|e| GameCommandError::new(e.to_string()))?;
        let research_watermark = s
            .evidence_for_world(&request.world_id)?
            .watermark()
            .map_err(|e| GameCommandError::new(e.to_string()))?;
        Ok(store.correct_fact_on_new_branch(
            &request,
            &correction_operation_id,
            &correction,
            watermark,
            research_watermark,
        )?)
    })
    .await
}
