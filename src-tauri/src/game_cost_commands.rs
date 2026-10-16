//! Explicit local pricing commands. No credential or provider access is needed.
use super::{blocking, GameCommandError, GameService};
use lishi_core::game_cost::{estimate_attempts, CostReply, PriceSettings, PriceStore, PriceUpdate};
use std::sync::Arc;

impl GameService {
    fn prices(&self) -> Result<Arc<PriceStore>, GameCommandError> {
        let mut guard = self
            .prices
            .lock()
            .map_err(|_| GameCommandError::new("game_price_store"))?;
        if let Some(store) = guard.as_ref() {
            return Ok(Arc::clone(store));
        }
        let store = Arc::new(
            PriceStore::open(&self.prices_path)
                .map_err(|e| GameCommandError::new(e.to_string()))?,
        );
        *guard = Some(Arc::clone(&store));
        Ok(store)
    }
}
fn read(service: &GameService) -> Result<PriceSettings, GameCommandError> {
    service
        .prices()?
        .settings()
        .map_err(|e| GameCommandError::new(e.to_string()))
}
fn set(service: &GameService, input: &PriceUpdate) -> Result<PriceSettings, GameCommandError> {
    service
        .prices()?
        .set(input)
        .map_err(|e| GameCommandError::new(e.to_string()))
}
fn clear(
    service: &GameService,
    model: &str,
    expected_revision: u64,
) -> Result<PriceSettings, GameCommandError> {
    service
        .prices()?
        .clear(model, expected_revision)
        .map_err(|e| GameCommandError::new(e.to_string()))
}
fn estimates(service: &GameService) -> Result<CostReply, GameCommandError> {
    let prices = read(service)?;
    let calls = service
        .calls()
        .and_then(|calls| {
            calls
                .list(100)
                .map_err(|_| GameCommandError::new("game_price_store"))
        })
        .map_err(|_| GameCommandError::new("game_price_store"))?;
    estimate_attempts(&prices, &calls).map_err(|e| GameCommandError::new(e.to_string()))
}

#[tauri::command]
pub async fn get_game_prices(
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<PriceSettings, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || read(&service)).await.map_err(safe_error)
}
#[tauri::command]
pub async fn set_game_price(
    input: PriceUpdate,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<PriceSettings, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || set(&service, &input))
        .await
        .map_err(safe_error)
}
#[tauri::command]
pub async fn clear_game_price(
    model: String,
    expected_revision: u64,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<PriceSettings, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || clear(&service, &model, expected_revision))
        .await
        .map_err(safe_error)
}
#[tauri::command]
pub async fn get_game_cost_estimates(
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<CostReply, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || estimates(&service))
        .await
        .map_err(safe_error)
}
fn safe_error(error: GameCommandError) -> GameCommandError {
    if matches!(
        error.code.as_str(),
        "game_price_invalid" | "game_price_stale" | "game_price_store"
    ) {
        error
    } else {
        GameCommandError::new("game_price_store")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lishi_core::{
        game_protocol::WorldSetup,
        model_probe::ModelProbeDiagnostics,
        secrets::{SecretSlot, SecretStore, SecretStoreError, SecretValue},
        stream::{StreamErrorCode, StreamStatus, TokenUsage},
    };
    struct NoSecrets;
    impl SecretStore for NoSecrets {
        fn save(&self, _: &SecretSlot, _: &SecretValue) -> Result<(), SecretStoreError> {
            panic!("prices must not save Key")
        }
        fn load(&self, _: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
            panic!("prices must not read Key")
        }
        fn delete(&self, _: &SecretSlot) -> Result<(), SecretStoreError> {
            panic!("prices must not delete Key")
        }
    }
    fn input(revision: u64) -> PriceUpdate {
        PriceUpdate {
            model: "fixture-model".into(),
            currency: "USD".into(),
            input_per_million: "2".into(),
            output_per_million: "4".into(),
            expected_revision: revision,
        }
    }
    #[test]
    fn prices_are_lazy_local_and_do_not_modify_world_provider_or_ledger() {
        let temp = tempfile::tempdir().unwrap();
        let service = GameService::open(temp.path(), Arc::new(NoSecrets)).unwrap();
        assert!(!temp.path().join("model-prices.sqlite").exists());
        let setup = WorldSetup {
            world_id: "cost-fixture-world".into(),
            title: "费用隔离".into(),
            country: "唐".into(),
            era_year: 748,
            location_name: "长安".into(),
            protagonist_name: "李安".into(),
            narrative_style: "测试".into(),
        };
        let world = service.store(&setup.world_id, true).unwrap();
        let before = world.create_world(&setup).unwrap();
        let profile = serde_json::to_value(service.providers.view().unwrap()).unwrap();
        let calls = service.calls().unwrap();
        let sequence = calls
            .reserve(
                "cost-operation-0001",
                &setup.world_id,
                "main",
                "fixture-model",
                8,
            )
            .unwrap();
        calls
            .finish(
                "cost-operation-0001",
                sequence,
                &ModelProbeDiagnostics {
                    attempts: 1,
                    elapsed_ms: 1,
                    http_status: Some(429),
                    usage: Some(TokenUsage {
                        prompt_tokens: 1000,
                        completion_tokens: 500,
                        total_tokens: 1500,
                    }),
                },
                StreamStatus::Failed,
                Some(StreamErrorCode::HttpStatus),
            )
            .unwrap();
        let ledger = calls.list(100).unwrap();
        assert!(estimates(&service).unwrap().attempts[0].estimate.is_none());
        assert_eq!(set(&service, &input(0)).unwrap().revision, 1);
        let estimate = estimates(&service).unwrap();
        assert_eq!(estimate.price_revision, 1);
        assert_eq!(
            estimate.attempts[0].estimate.as_ref().unwrap().total_amount,
            "0.004000"
        );
        assert_eq!(estimate.attempts[0].world_id, setup.world_id);
        assert_eq!(estimate.attempts[0].operation_id, "cost-operation-0001");
        assert_eq!(estimate.attempts[0].sequence, sequence);
        assert_eq!(clear(&service, "fixture-model", 1).unwrap().revision, 2);
        assert!(estimates(&service).unwrap().attempts[0].estimate.is_none());
        assert_eq!(calls.list(100).unwrap(), ledger);
        assert_eq!(world.view().unwrap(), before);
        assert_eq!(
            serde_json::to_value(service.providers.view().unwrap()).unwrap(),
            profile
        );
        assert!(!serde_json::to_string(&estimate)
            .unwrap()
            .contains("endpoint"));
    }
    #[test]
    fn corrupt_price_file_blocks_only_price_commands_not_world_or_service_startup() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("model-prices.sqlite");
        let foreign = b"PRIVATE_FOREIGN_PRICE_FILE";
        std::fs::write(&path, foreign).unwrap();
        let service = GameService::open(temp.path(), Arc::new(NoSecrets)).unwrap();
        for result in [
            read(&service),
            set(&service, &input(0)),
            clear(&service, "fixture-model", 0),
        ] {
            assert_eq!(result.unwrap_err().code, "game_price_store");
        }
        assert_eq!(estimates(&service).unwrap_err().code, "game_price_store");
        assert_eq!(std::fs::read(path).unwrap(), foreign);
        let setup = WorldSetup {
            world_id: "cost-corrupt-world".into(),
            title: "坏单价不挡开局".into(),
            country: "唐".into(),
            era_year: 748,
            location_name: "长安".into(),
            protagonist_name: "李安".into(),
            narrative_style: "测试".into(),
        };
        let world = service.store(&setup.world_id, true).unwrap();
        let before = world.create_world(&setup).unwrap();
        assert_eq!(world.view().unwrap(), before);
        assert!(!temp.path().join("model-calls.sqlite").exists());
    }
    #[test]
    fn estimates_use_exactly_the_latest_hundred_entries_and_cas_survives_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let service = GameService::open(temp.path(), Arc::new(NoSecrets)).unwrap();
        let calls = service.calls().unwrap();
        for index in 0..105 {
            calls
                .reserve(
                    &format!("cost-operation-{index:04}"),
                    "cost-world-0001",
                    if index % 2 == 0 { "main" } else { "child" },
                    "fixture-model",
                    8,
                )
                .unwrap();
        }
        let expected = calls.list(100).unwrap();
        set(&service, &input(0)).unwrap();
        assert_eq!(
            set(&service, &input(0)).unwrap_err().code,
            "game_price_stale"
        );
        let result = estimates(&service).unwrap();
        assert_eq!(result.attempts.len(), 100);
        for (row, call) in result.attempts.iter().zip(expected.iter()) {
            assert_eq!(
                (
                    &row.world_id,
                    &row.branch_id,
                    &row.operation_id,
                    row.sequence,
                    &row.model
                ),
                (
                    &call.world_id,
                    &call.branch_id,
                    &call.operation_id,
                    call.sequence,
                    &call.model
                )
            );
            assert!(row.estimate.is_none());
        }
        drop(calls);
        drop(service);
        let reopened = GameService::open(temp.path(), Arc::new(NoSecrets)).unwrap();
        assert_eq!(read(&reopened).unwrap().revision, 1);
        assert_eq!(
            clear(&reopened, "fixture-model", 0).unwrap_err().code,
            "game_price_stale"
        );
        assert_eq!(clear(&reopened, "fixture-model", 1).unwrap().revision, 2);
    }
}
