//! Bounded schema diagnostics without model values, raw text or serde messages.
use crate::{
    game_protocol::TurnOutput,
    game_protocol_v2::{HoldingStatus, StateChangeV2, TurnOutputV2},
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputDiagnostic {
    pub category: &'static str,
    pub field: Option<&'static str>,
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub response_bytes: usize,
}

/// Diagnose a rejected typed output without replaying partial state changes.
/// This reports an operation's own inconsistent precondition/result, not the
/// first failing operation or a substitute for the authoritative validator.
pub fn diagnose_domain_output(output_v2: Option<&TurnOutputV2>) -> OutputDiagnostic {
    let holding_quantity_change = output_v2.is_some_and(|output| {
        output.state_changes.iter().any(|change| match change {
            StateChangeV2::SetItemHolding {
                expected_holding: Some(old),
                quantity,
                unit,
                ..
            } => {
                old.status == HoldingStatus::Known
                    && (old.quantity != Some(*quantity) || old.unit.as_ref() != Some(unit))
            }
            _ => false,
        })
    });
    OutputDiagnostic {
        category: if holding_quantity_change {
            "holding_quantity_change"
        } else {
            "domain_constraints"
        },
        field: holding_quantity_change.then_some("quantity"),
        line: None,
        column: None,
        // No raw response is retained at this typed-validation stage. Zero
        // explicitly means unavailable, rather than an original wire size.
        response_bytes: 0,
    }
}

/// Call after strict output rejection. This cannot authorize or repair output.
pub fn diagnose_output(protocol: u32, raw: &str) -> OutputDiagnostic {
    let mut result = OutputDiagnostic {
        category: "shape_constraints",
        field: None,
        line: None,
        column: None,
        response_bytes: raw.len(),
    };
    if raw.len() > 256 * 1024 {
        result.category = "too_large";
        return result;
    }
    let whole = raw.trim();
    let json = if let Some(body) = whole.strip_prefix("```json") {
        let Some(body) = body
            .strip_prefix("\r\n")
            .or_else(|| body.strip_prefix('\n'))
            .and_then(|v| v.strip_suffix("```"))
        else {
            result.category = "invalid_fence";
            return result;
        };
        body.trim()
    } else {
        whole
    };
    if !matches!(protocol, 1 | 2) {
        result.category = "invalid_protocol";
        return result;
    }
    // Prioritize whole-document syntax before a struct deserializer can stop
    // at an unknown key that happens to precede a truncated tail.
    let error = serde_json::from_str::<serde_json::Value>(json)
        .err()
        .or_else(|| match protocol {
            1 => serde_json::from_str::<TurnOutput>(json).err(),
            _ => serde_json::from_str::<TurnOutputV2>(json).err(),
        });
    if let Some(error) = error {
        result.line = Some(error.line());
        result.column = Some(error.column());
        result.category = match error.classify() {
            serde_json::error::Category::Syntax => "json_syntax",
            serde_json::error::Category::Eof => "incomplete_json",
            _ => "invalid_schema",
        };
        // serde messages may contain arbitrary upstream strings. Inspect them
        // locally, emit only fixed categories and exact known schema names.
        let message = error.to_string();
        if message.starts_with("missing field ") {
            result.category = "missing_field";
        } else if message.starts_with("unknown field ") {
            result.category = "unknown_field";
        } else if message.starts_with("unknown variant ") {
            result.category = "unknown_variant";
        }
        const FIELDS: &[&str] = &[
            "protocolVersion",
            "narrative",
            "choices",
            "timeAdvance",
            "elapsedSeconds",
            "eventId",
            "stateChanges",
            "events",
            "sourceReferences",
            "uncertainties",
            "id",
            "description",
            "entityIds",
            "disclosure",
            "type",
            "entity",
            "entityId",
            "kind",
            "name",
            "alive",
            "attributes",
            "expectedName",
            "expectedAlive",
            "expectedValue",
            "ownerId",
            "key",
            "unit",
            "delta",
            "amount",
            "expectedAmount",
            "itemId",
            "holding",
            "status",
            "holderId",
            "placeId",
            "quantity",
            "condition",
            "conditionId",
            "category",
            "active",
            "actorId",
            "targetType",
            "targetId",
            "certainty",
            "acquisitionMode",
            "knownEvidenceEventIds",
            "factKey",
            "value",
            "relationship",
            "fromId",
            "toId",
            "strength",
            "claim",
            "claimId",
            "assessment",
            "evidenceEventIds",
        ];
        if matches!(result.category, "missing_field" | "unknown_field") {
            result.field = FIELDS.iter().copied().find(|field| {
                message.starts_with(&format!(
                    "{} field `{field}`",
                    if result.category == "missing_field" {
                        "missing"
                    } else {
                        "unknown"
                    }
                ))
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        game_protocol::{GameError, WorldSetup},
        game_protocol_v2::{
            apply_output_v2, initial_state_v2, CommitContext, Disclosure, EventInput, TimeAdvanceV2,
        },
    };

    fn domain_fixture() -> (
        crate::game_protocol_v2::WorldStateV2,
        TurnOutputV2,
        CommitContext,
    ) {
        let state = initial_state_v2(&WorldSetup {
            world_id: "domain-diagnostic-world".into(),
            title: "领域诊断".into(),
            country: "唐".into(),
            era_year: 748,
            location_name: "长安".into(),
            protagonist_name: "李安".into(),
            narrative_style: "测试".into(),
        })
        .unwrap();
        let output = TurnOutputV2 {
            protocol_version: 2,
            narrative: "PRIVATE_MODEL_NARRATIVE".into(),
            choices: vec![],
            time_advance: TimeAdvanceV2 {
                elapsed_seconds: 0,
                event_id: None,
            },
            state_changes: vec![],
            events: vec![EventInput {
                id: "domain-event".into(),
                description: "核对物品".into(),
                entity_ids: vec!["player".into(), "travel-bag".into(), "start-place".into()],
                disclosure: Disclosure::Public,
            }],
            source_references: vec![],
            uncertainties: vec![],
        };
        let context = CommitContext {
            operation_id: "domain-operation".into(),
            turn_id: "domain-operation".into(),
        };
        (state, output, context)
    }

    #[test]
    fn domain_diagnostic_finds_transfer_quantity_or_unit_changes_without_values() {
        let (state, mut output, context) = domain_fixture();
        let before = state.clone();
        for (quantity, unit) in [(2, "件"), (1, "PRIVATE_UNIT")] {
            output.state_changes = vec![StateChangeV2::SetItemHolding {
                item_id: "travel-bag".into(),
                expected_holding: Some(state.item_holdings[0].value.clone()),
                holder_id: None,
                place_id: Some("start-place".into()),
                quantity,
                unit: unit.into(),
                event_id: "domain-event".into(),
            }];
            assert_eq!(
                apply_output_v2(&state, &output, &context).unwrap_err(),
                GameError::InvalidResource
            );
            let diagnostic = diagnose_domain_output(Some(&output));
            assert_eq!(diagnostic.category, "holding_quantity_change");
            assert_eq!(diagnostic.field, Some("quantity"));
            assert_eq!(diagnostic.line, None);
            assert_eq!(diagnostic.column, None);
            assert_eq!(diagnostic.response_bytes, 0);
            let json = serde_json::to_string(&diagnostic).unwrap();
            assert!(!json.contains("PRIVATE_"));
            assert!(!json.contains("travel-bag"));
            assert_eq!(state, before);
        }
    }

    #[test]
    fn domain_diagnostic_does_not_misclassify_quantity_change_then_valid_transfer() {
        let (state, mut output, context) = domain_fixture();
        let initial = state.item_holdings[0].value.clone();
        let mut updated = initial.clone();
        updated.quantity = Some(2);
        output.state_changes = vec![
            StateChangeV2::ChangeItemQuantity {
                item_id: "travel-bag".into(),
                expected_holding: initial,
                delta: 1,
                event_id: "domain-event".into(),
            },
            StateChangeV2::SetItemHolding {
                item_id: "travel-bag".into(),
                expected_holding: Some(updated),
                holder_id: None,
                place_id: Some("start-place".into()),
                quantity: 2,
                unit: "件".into(),
                event_id: "domain-event".into(),
            },
        ];
        let next = apply_output_v2(&state, &output, &context).unwrap();
        assert_eq!(next.item_holdings[0].value.quantity, Some(2));
        assert_eq!(state.item_holdings[0].value.quantity, Some(1));
        assert_eq!(
            diagnose_domain_output(Some(&output)).category,
            "domain_constraints"
        );
        // A separate domain error must not cause valid inventory operations
        // earlier in the output to be diagnosed by replaying an incomplete prefix.
        output.state_changes.push(StateChangeV2::ChangeResource {
            owner_id: "player".into(),
            key: "cash".into(),
            unit: "PRIVATE_WRONG_UNIT".into(),
            delta: 1,
            expected_amount: Some(100),
            event_id: "domain-event".into(),
        });
        assert_eq!(
            apply_output_v2(&state, &output, &context).unwrap_err(),
            GameError::InvalidResource
        );
        let diagnostic = diagnose_domain_output(Some(&output));
        assert_eq!(diagnostic.category, "domain_constraints");
        assert_eq!(diagnostic.field, None);
        assert_eq!(diagnose_domain_output(None), diagnostic);
    }

    #[test]
    fn diagnostic_classifies_without_echoing_arbitrary_model_values() {
        let missing = diagnose_output(2, "{}");
        assert_eq!(missing.category, "missing_field");
        assert_eq!(missing.field, Some("protocolVersion"));
        let secret = "PRIVATE_UNKNOWN_UPSTREAM_VALUE";
        let raw = format!(
            r#"{{"protocolVersion":2,"narrative":"x","choices":[],"timeAdvance":{{"elapsedSeconds":0,"eventId":null}},"stateChanges":[{{"type":"{secret}"}}],"events":[],"sourceReferences":[],"uncertainties":[]}}"#
        );
        let diagnostic = diagnose_output(2, &raw);
        assert_eq!(diagnostic.category, "unknown_variant");
        assert!(!serde_json::to_string(&diagnostic).unwrap().contains(secret));
    }
    #[test]
    fn diagnostic_handles_fences_syntax_and_size_without_accepting_output() {
        assert_eq!(diagnose_output(2, "{\"a\":").category, "incomplete_json");
        assert_eq!(diagnose_output(2, "{INVALID}").category, "json_syntax");
        assert_eq!(
            diagnose_output(2, "```json{} ```").category,
            "invalid_fence"
        );
        assert_eq!(
            diagnose_output(2, "```json\n{}\n```").field,
            Some("protocolVersion")
        );
        assert_eq!(
            diagnose_output(2, &"x".repeat(256 * 1024 + 1)).category,
            "too_large"
        );
    }
}
