//! Small in-memory, read-only failure details; raw replies never enter this cache.
use super::{GameCommandError, GameService, OutputRoute, WorldReply};
use lishi_core::{
    game_output_diagnostic::{diagnose_domain_output, diagnose_output, OutputDiagnostic},
    game_store::{valid_game_id, GameTurnRequest},
};
use serde::Serialize;
use std::sync::Arc;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameOutputDiagnostic {
    world_id: String,
    operation_id: String,
    #[serde(flatten)]
    diagnostic: OutputDiagnostic,
}
pub(super) fn record(
    service: &GameService,
    request: &GameTurnRequest,
    raw: &str,
    view: &WorldReply,
) {
    let protocol = match view {
        WorldReply::V1(_) => 1,
        WorldReply::V2(_) => 2,
    };
    insert(service, request, diagnose_output(protocol, raw));
}

/// Preserve the authoritative validation error. Diagnostics are only a bounded
/// in-memory side effect and cannot stage output, repair it or request a retry.
pub(super) fn validate_and_record(
    service: &GameService,
    request: &GameTurnRequest,
    output: &OutputRoute,
    view: &WorldReply,
) -> Result<(), GameCommandError> {
    if let Err(error) = output.validate_against(view, &request.operation_id) {
        let diagnostic = diagnose_domain_output(match output {
            OutputRoute::V1(_) => None,
            OutputRoute::V2(output) => Some(output),
        });
        insert(service, request, diagnostic);
        return Err(error);
    }
    Ok(())
}

fn insert(service: &GameService, request: &GameTurnRequest, diagnostic: OutputDiagnostic) {
    let entry = GameOutputDiagnostic {
        world_id: request.world_id.clone(),
        operation_id: request.operation_id.clone(),
        diagnostic,
    };
    if let Ok(mut entries) = service.output_diagnostics.lock() {
        entries.retain(|previous| {
            previous.world_id != entry.world_id || previous.operation_id != entry.operation_id
        });
        if entries.len() >= 64 {
            entries.pop_front();
        }
        entries.push_back(entry);
    }
}
#[tauri::command]
pub fn get_game_output_diagnostic(
    world_id: String,
    operation_id: String,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<Option<GameOutputDiagnostic>, GameCommandError> {
    read(&service, &world_id, &operation_id)
}
fn read(
    service: &GameService,
    world_id: &str,
    operation_id: &str,
) -> Result<Option<GameOutputDiagnostic>, GameCommandError> {
    if !valid_game_id(world_id) || !valid_game_id(operation_id) {
        return Err(GameCommandError::new("game_invalid_request"));
    }
    let entries = service
        .output_diagnostics
        .lock()
        .map_err(|_| GameCommandError::new("game_unavailable"))?;
    Ok(entries
        .iter()
        .find(|entry| entry.world_id == world_id && entry.operation_id == operation_id)
        .cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lishi_core::{
        game_protocol::WorldSetup,
        game_protocol_v2::{Disclosure, EventInput, StateChangeV2, TimeAdvanceV2, TurnOutputV2},
        game_store::GameActionKind,
        secrets::{SecretSlot, SecretStore, SecretStoreError, SecretValue},
    };
    struct NoSecrets;
    impl SecretStore for NoSecrets {
        fn save(&self, _: &SecretSlot, _: &SecretValue) -> Result<(), SecretStoreError> {
            panic!("diagnostic must not save Key")
        }
        fn load(&self, _: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
            panic!("diagnostic must not load Key")
        }
        fn delete(&self, _: &SecretSlot) -> Result<(), SecretStoreError> {
            panic!("diagnostic must not delete Key")
        }
    }

    #[test]
    fn native_domain_diagnostic_preserves_error_and_formal_state_without_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let service = GameService::open(temp.path(), Arc::new(NoSecrets)).unwrap();
        let setup = WorldSetup {
            world_id: "domain-diagnostic-world".into(),
            title: "领域诊断测试".into(),
            country: "唐".into(),
            era_year: 748,
            location_name: "长安".into(),
            protagonist_name: "李安".into(),
            narrative_style: "测试".into(),
        };
        let route = service.store(&setup.world_id, true).unwrap();
        let view = route.create_world(&setup).unwrap();
        let WorldReply::V2(v2) = &view else {
            panic!("new world must be v2")
        };
        let request = GameTurnRequest {
            world_id: setup.world_id.clone(),
            branch_id: "main".into(),
            expected_head_turn_id: None,
            operation_id: "domain-diagnostic-operation".into(),
            action_kind: GameActionKind::Action,
            action_text: "核对物品".into(),
        };
        let mut output = TurnOutputV2 {
            protocol_version: 2,
            narrative: "PRIVATE_MODEL_NARRATIVE".into(),
            choices: vec![],
            time_advance: TimeAdvanceV2 {
                elapsed_seconds: 0,
                event_id: None,
            },
            state_changes: vec![StateChangeV2::SetItemHolding {
                item_id: "travel-bag".into(),
                expected_holding: Some(v2.state.item_holdings[0].value.clone()),
                holder_id: None,
                place_id: Some("start-place".into()),
                quantity: 2,
                unit: "件".into(),
                event_id: "domain-event".into(),
            }],
            events: vec![EventInput {
                id: "domain-event".into(),
                description: "核对物品".into(),
                entity_ids: vec!["player".into(), "travel-bag".into(), "start-place".into()],
                disclosure: Disclosure::Public,
            }],
            source_references: vec![],
            uncertainties: vec![],
        };
        let error =
            validate_and_record(&service, &request, &OutputRoute::V2(output.clone()), &view)
                .unwrap_err();
        assert_eq!(error.code, "game_invalid_resource");
        let diagnostic = read(&service, &setup.world_id, &request.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(diagnostic.diagnostic.category, "holding_quantity_change");
        assert_eq!(diagnostic.diagnostic.field, Some("quantity"));
        let json = serde_json::to_value(&diagnostic).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 7);
        assert_eq!(json["responseBytes"], 0);
        assert!(json["line"].is_null() && json["column"].is_null());
        assert!(!json.to_string().contains("PRIVATE_"));
        assert_eq!(route.view().unwrap(), view);

        output.state_changes = vec![StateChangeV2::ChangeItemQuantity {
            item_id: "travel-bag".into(),
            expected_holding: v2.state.item_holdings[0].value.clone(),
            delta: 1,
            event_id: "domain-event".into(),
        }];
        let valid_request = GameTurnRequest {
            operation_id: "domain-valid-operation".into(),
            ..request
        };
        validate_and_record(&service, &valid_request, &OutputRoute::V2(output), &view).unwrap();
        assert!(read(&service, &setup.world_id, &valid_request.operation_id)
            .unwrap()
            .is_none());
        // Validation itself never commits a successful candidate either.
        assert_eq!(route.view().unwrap(), view);
    }
    #[test]
    fn native_diagnostic_is_bounded_scoped_redacted_and_never_changes_formal_state() {
        let temp = tempfile::tempdir().unwrap();
        let service = GameService::open(temp.path(), Arc::new(NoSecrets)).unwrap();
        let setup = WorldSetup {
            world_id: "diagnostic-world-0001".into(),
            title: "输出诊断测试".into(),
            country: "唐".into(),
            era_year: 748,
            location_name: "长安".into(),
            protagonist_name: "李安".into(),
            narrative_style: "测试".into(),
        };
        let route = service.store(&setup.world_id, true).unwrap();
        let view = route.create_world(&setup).unwrap();
        for i in 0..70 {
            let request = GameTurnRequest {
                world_id: setup.world_id.clone(),
                branch_id: "main".into(),
                expected_head_turn_id: None,
                operation_id: format!("diagnostic-operation-{i:03}"),
                action_kind: GameActionKind::Action,
                action_text: "询问".into(),
            };
            record(&service, &request, "{\"PRIVATE_UPSTREAM_FIELD\":1}", &view);
        }
        assert_eq!(service.output_diagnostics.lock().unwrap().len(), 64);
        let current = read(&service, &setup.world_id, "diagnostic-operation-069")
            .unwrap()
            .unwrap();
        let json = serde_json::to_string(&current).unwrap();
        assert!(!json.contains("PRIVATE_UPSTREAM_FIELD"));
        assert!(
            read(&service, "another-world-0001", "diagnostic-operation-069")
                .unwrap()
                .is_none()
        );
        assert!(read(&service, &setup.world_id, "../../file").is_err());
        assert_eq!(route.view().unwrap(), view);
    }

    #[test]
    fn native_diagnostic_retains_recent_records_with_nonmonotonic_ids_and_world_pairs() {
        let temp = tempfile::tempdir().unwrap();
        let service = GameService::open(temp.path(), Arc::new(NoSecrets)).unwrap();
        let setup = WorldSetup {
            world_id: "diagnostic-world-0001".into(),
            title: "输出诊断测试".into(),
            country: "唐".into(),
            era_year: 748,
            location_name: "长安".into(),
            protagonist_name: "李安".into(),
            narrative_style: "测试".into(),
        };
        let view = service
            .store(&setup.world_id, true)
            .unwrap()
            .create_world(&setup)
            .unwrap();
        let mut request = GameTurnRequest {
            world_id: setup.world_id.clone(),
            branch_id: "main".into(),
            expected_head_turn_id: None,
            operation_id: "zzz-oldest-operation".into(),
            action_kind: GameActionKind::Action,
            action_text: "询问".into(),
        };
        record(&service, &request, "{}", &view);
        for i in 0..64 {
            request.operation_id = format!("aaa-operation-{i:03}");
            record(&service, &request, "{}", &view);
        }
        assert_eq!(service.output_diagnostics.lock().unwrap().len(), 64);
        assert!(read(&service, &setup.world_id, "zzz-oldest-operation")
            .unwrap()
            .is_none());
        assert!(read(&service, &setup.world_id, "aaa-operation-000")
            .unwrap()
            .is_some());

        let other_setup = WorldSetup {
            world_id: "diagnostic-world-0002".into(),
            ..setup.clone()
        };
        let other_view = service
            .store(&other_setup.world_id, true)
            .unwrap()
            .create_world(&other_setup)
            .unwrap();
        request.world_id = other_setup.world_id.clone();
        record(&service, &request, "{\"protocolVersion\":2}", &other_view);
        let original = read(&service, &setup.world_id, &request.operation_id)
            .unwrap()
            .unwrap();
        let other = read(&service, &other_setup.world_id, &request.operation_id)
            .unwrap()
            .unwrap();
        assert_eq!(original.diagnostic.field, Some("protocolVersion"));
        assert_eq!(other.diagnostic.field, Some("narrative"));
        assert_eq!(service.output_diagnostics.lock().unwrap().len(), 64);

        // Updating one pair makes it newest without consuming a second slot.
        let size = service.output_diagnostics.lock().unwrap().len();
        record(&service, &request, "{}", &other_view);
        assert_eq!(service.output_diagnostics.lock().unwrap().len(), size);
        assert_eq!(
            service
                .output_diagnostics
                .lock()
                .unwrap()
                .back()
                .unwrap()
                .world_id,
            other_setup.world_id
        );
        assert_eq!(
            read(&service, &setup.world_id, &request.operation_id)
                .unwrap()
                .unwrap()
                .diagnostic
                .field,
            Some("protocolVersion")
        );
    }
}
