use std::collections::BTreeMap;
use std::path::Path;

use lishi_core::game_archive::{ArchiveControl, LegacyGameArchive, LegacyTurn, LegacyWorldHeader};
use lishi_core::game_legacy::{LegacyAdaptedWorld, LegacyAdapter};
use lishi_core::game_protocol::{
    apply_output, initial_state, Choice, Condition, Entity, EntityKind, GameError, GameEvent,
    StateChange, TimeAdvance, TurnOutput, WorldSetup, WorldState, MAX_RESOURCE_AMOUNT,
};
use lishi_core::game_protocol_v2::{
    AcquisitionMode, Certainty, ConditionCategory, Disclosure, HoldingStatus, KnowledgeTarget,
    StateSource,
};
use lishi_core::game_store::{GameActionKind, GameOperationStatus, GameStore, GameTurnRequest};

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: "legacy-adapter-fixture-0001".into(),
        title: "固定兼容夹具".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "李明".into(),
        narrative_style: "中文叙事；资料未知时标明未知。".into(),
    }
}

fn output(sequence: usize, changes: Vec<StateChange>, events: Vec<GameEvent>) -> TurnOutput {
    TurnOutput {
        protocol_version: 1,
        narrative: format!("第{sequence}回合的固定中文剧情🙂。"),
        choices: vec![Choice {
            id: "continue".into(),
            text: "继续。".into(),
        }],
        time_advance: TimeAdvance { elapsed_seconds: 1 },
        state_changes: changes,
        events,
        source_references: Vec::new(),
        uncertainties: vec!["本夹具没有真实历史研究。".into()],
    }
}

fn person(id: &str, name: &str) -> StateChange {
    StateChange::CreateEntity {
        entity: Entity {
            id: id.into(),
            kind: EntityKind::Person,
            name: name.into(),
            alive: Some(true),
            attributes: BTreeMap::new(),
        },
    }
}

fn item(id: &str, attrs: &[(&str, &str)]) -> StateChange {
    StateChange::CreateEntity {
        entity: Entity {
            id: id.into(),
            kind: EntityKind::Item,
            name: "钥匙".into(),
            alive: None,
            attributes: attrs
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect(),
        },
    }
}

fn fixture(initial: WorldState, outputs: &[TurnOutput]) -> (LegacyWorldHeader, Vec<LegacyTurn>) {
    let mut previous = initial.clone();
    let mut parent = None;
    let mut rows = Vec::new();
    for (index, output) in outputs.iter().enumerate() {
        let sequence = index as u64 + 1;
        previous = apply_output(&previous, output).unwrap();
        let id = format!("legacy-turn-{sequence:08}");
        rows.push(LegacyTurn {
            turn_id: id.clone(),
            parent_turn_id: parent,
            sequence,
            action_kind: GameActionKind::Action,
            action_text: "保管行囊与钥匙🔑。".into(),
            narrative: output.narrative.clone(),
            choices_json: serde_json::to_string_pretty(&output.choices).unwrap(),
            state_json: serde_json::to_string_pretty(&previous).unwrap(),
            output_json: serde_json::to_string_pretty(output).unwrap(),
            created_at_ms: sequence as i64,
        });
        parent = Some(id);
    }
    (
        LegacyWorldHeader {
            world_id: setup().world_id.clone(),
            setup_json: serde_json::to_string_pretty(&setup()).unwrap(),
            initial_state_json: serde_json::to_string_pretty(&initial).unwrap(),
            current_state_json: serde_json::to_string_pretty(&previous).unwrap(),
            opening_narrative: "你抵达咸阳。".into(),
            opening_choices_json: "[]".into(),
            narrative_policy: String::new(),
            head_turn_id: parent,
            turn_count: rows.len() as u64,
            created_at_ms: 0,
        },
        rows,
    )
}

fn convert(header: &LegacyWorldHeader, rows: &[LegacyTurn]) -> LegacyAdaptedWorld {
    let mut adapter = LegacyAdapter::from_header(header).unwrap();
    for row in rows {
        adapter.push_turn(row).unwrap();
    }
    adapter.finish().unwrap()
}

fn source(sequence: Option<usize>) -> StateSource {
    StateSource::LegacySnapshot {
        turn_id: sequence.map(|n| format!("legacy-turn-{n:08}")),
        format_version: 1,
    }
}

#[test]
fn same_name_characters_remain_distinct_without_extra_aliases_or_knowledge() {
    let (header, rows) = fixture(
        initial_state(&setup()).unwrap(),
        &[output(
            1,
            vec![
                person("p-a", "王安"),
                person("p-b", "王安"),
                StateChange::RecordKnowledge {
                    actor_id: "player".into(),
                    fact_id: "secret".into(),
                },
            ],
            vec![GameEvent {
                id: "secret".into(),
                description: "王安甲藏起钥匙。".into(),
                entity_ids: vec!["p-a".into()],
            }],
        )],
    );
    let result = convert(&header, &rows);
    let state = result.current_state;
    let people: Vec<_> = state.entities.iter().filter(|e| e.name == "王安").collect();
    assert_eq!(people.len(), 2);
    assert_ne!(people[0].id, people[1].id);
    assert!(people.iter().all(|e| e.aliases.is_empty()
        && e.created_source == source(Some(1))
        && e.name_source == source(Some(1))));
    assert!(state.claims.is_empty());
    assert_eq!(state.knowledge.len(), 1);
    let knowledge = &state.knowledge[0];
    assert_eq!(knowledge.actor_id, "player");
    assert_eq!(knowledge.target_type, KnowledgeTarget::Event);
    assert_eq!(knowledge.certainty, Certainty::LegacyUnspecified);
    assert_eq!(
        knowledge.acquisition_mode,
        AcquisitionMode::LegacyUnspecified
    );
    assert_eq!(knowledge.acquisition_event_id, None);
    assert_eq!(knowledge.known_text, "王安甲藏起钥匙。");
    assert_eq!(knowledge.source, source(Some(1)));
    assert!(knowledge.known_evidence_event_ids.is_empty());
    assert_eq!(state.events[0].disclosure, Disclosure::LegacyUnspecified);
}

#[test]
fn frozen_inventory_rule_preserves_valid_records_and_keeps_abnormal_strings_unknown() {
    let mut changes = vec![person("p-a", "王安")];
    let invalid = [
        (
            "leading-zero",
            vec![("ownerId", "player"), ("quantity", "01"), ("unit", "把")],
        ),
        (
            "plus",
            vec![("ownerId", "player"), ("quantity", "+1"), ("unit", "把")],
        ),
        (
            "negative-zero",
            vec![("ownerId", "player"), ("quantity", "-0"), ("unit", "把")],
        ),
        (
            "negative",
            vec![("ownerId", "player"), ("quantity", "-1"), ("unit", "把")],
        ),
        (
            "decimal",
            vec![("ownerId", "player"), ("quantity", "1.0"), ("unit", "把")],
        ),
        (
            "exponent",
            vec![("ownerId", "player"), ("quantity", "1e0"), ("unit", "把")],
        ),
        (
            "large",
            vec![
                ("ownerId", "player"),
                ("quantity", "9007199254740992"),
                ("unit", "把"),
            ],
        ),
        ("no-unit", vec![("ownerId", "player"), ("quantity", "2")]),
        ("no-quantity", vec![("ownerId", "player"), ("unit", "把")]),
        (
            "bad-owner",
            vec![("ownerId", "missing"), ("quantity", "1"), ("unit", "把")],
        ),
        (
            "place-owner",
            vec![
                ("ownerId", "start-place"),
                ("quantity", "1"),
                ("unit", "把"),
            ],
        ),
        (
            "item-owner",
            vec![("ownerId", "travel-bag"), ("quantity", "1"), ("unit", "把")],
        ),
        (
            "case-conflict",
            vec![
                ("ownerId", "player"),
                ("OwnerId", "p-a"),
                ("quantity", "1"),
                ("unit", "把"),
            ],
        ),
        (
            "holder-conflict",
            vec![
                ("ownerId", "player"),
                ("holderId", "p-a"),
                ("quantity", "1"),
                ("unit", "把"),
            ],
        ),
        (
            "place-conflict",
            vec![
                ("ownerId", "player"),
                ("placeId", "start-place"),
                ("quantity", "1"),
                ("unit", "把"),
            ],
        ),
        (
            "blank-unit",
            vec![("ownerId", "player"), ("quantity", "1"), ("unit", " ")],
        ),
    ];
    // v1 itself rejects an all-space ordinary attribute. Use a nonblank unit
    // with a newline to test a value legal in v1 but invalid as a v2 unit.
    for (id, attrs) in &invalid {
        if *id != "blank-unit" {
            changes.push(item(id, attrs));
        }
    }
    changes.push(item(
        "newline-unit",
        &[("ownerId", "player"), ("quantity", "1"), ("unit", "把\n件")],
    ));
    changes.push(item(
        "valid",
        &[("ownerId", "p-a"), ("quantity", "2"), ("unit", "把")],
    ));
    changes.push(item(
        "zero",
        &[("ownerId", "player"), ("quantity", "0"), ("unit", "把")],
    ));
    let max = MAX_RESOURCE_AMOUNT.to_string();
    changes.push(item(
        "safe-max",
        &[("ownerId", "player"), ("quantity", &max), ("unit", "把")],
    ));
    let (header, rows) = fixture(
        initial_state(&setup()).unwrap(),
        &[output(1, changes, Vec::new())],
    );
    let result = convert(&header, &rows);
    let state = &result.current_state;
    for (id, _) in &invalid {
        if *id == "blank-unit" {
            continue;
        }
        let record = state
            .item_holdings
            .iter()
            .find(|h| h.item_id == *id)
            .unwrap();
        assert_eq!(record.value.status, HoldingStatus::LegacyUnknown, "{id}");
        assert_eq!(
            (
                &record.value.holder_id,
                &record.value.place_id,
                &record.value.quantity,
                &record.value.unit
            ),
            (&None, &None, &None, &None)
        );
        assert_eq!(record.source, source(Some(1)));
        let old: WorldState = serde_json::from_str(&rows[0].state_json).unwrap();
        assert_eq!(
            state
                .entities
                .iter()
                .find(|e| e.id == *id)
                .unwrap()
                .attributes,
            old.entities
                .iter()
                .find(|e| e.id == *id)
                .unwrap()
                .attributes
        );
    }
    assert_eq!(
        state
            .item_holdings
            .iter()
            .find(|h| h.item_id == "newline-unit")
            .unwrap()
            .value
            .status,
        HoldingStatus::LegacyUnknown
    );
    let valid = state
        .item_holdings
        .iter()
        .find(|h| h.item_id == "valid")
        .unwrap();
    assert_eq!(valid.value.status, HoldingStatus::Known);
    assert_eq!(valid.value.holder_id.as_deref(), Some("p-a"));
    assert_eq!(valid.value.quantity, Some(2));
    assert_eq!(valid.value.unit.as_deref(), Some("把"));
    assert_eq!(valid.source, source(Some(1)));
    let zero = state
        .item_holdings
        .iter()
        .find(|h| h.item_id == "zero")
        .unwrap();
    assert_eq!(zero.value.quantity, Some(0));
    assert_eq!(zero.value.holder_id, None);
    assert_eq!(zero.value.place_id, None);
    assert_eq!(
        state
            .item_holdings
            .iter()
            .find(|h| h.item_id == "safe-max")
            .unwrap()
            .value
            .quantity,
        Some(MAX_RESOURCE_AMOUNT)
    );
}

#[test]
fn initial_bag_exception_never_reassigns_a_transferred_bag_after_return() {
    let first = output(
        1,
        vec![
            person("p-a", "王安"),
            StateChange::SetAttribute {
                entity_id: "travel-bag".into(),
                key: "ownerId".into(),
                value: "p-a".into(),
                expected_value: Some("player".into()),
            },
        ],
        Vec::new(),
    );
    let second = output(
        2,
        vec![StateChange::SetAttribute {
            entity_id: "travel-bag".into(),
            key: "ownerId".into(),
            value: "player".into(),
            expected_value: Some("p-a".into()),
        }],
        Vec::new(),
    );
    let (header, rows) = fixture(initial_state(&setup()).unwrap(), &[first, second]);
    let mut adapter = LegacyAdapter::from_header(&header).unwrap();
    let initial_bag = &adapter.initial_state().item_holdings[0];
    assert_eq!(initial_bag.value.quantity, Some(1));
    assert_eq!(initial_bag.source, StateSource::Initial);
    let first = adapter.push_turn(&rows[0]).unwrap();
    assert_eq!(
        first.item_holdings[0].value.status,
        HoldingStatus::LegacyUnknown
    );
    assert_eq!(first.item_holdings[0].source, source(Some(1)));
    let final_state = adapter.push_turn(&rows[1]).unwrap();
    assert_eq!(
        final_state.item_holdings[0].value.status,
        HoldingStatus::LegacyUnknown
    );
    assert_eq!(final_state.item_holdings[0].source, source(Some(2)));
    assert_eq!(
        final_state
            .entities
            .iter()
            .find(|e| e.id == "travel-bag")
            .unwrap()
            .attributes["ownerId"],
        "player"
    );
    adapter.finish().unwrap();
}

#[test]
fn noncanonical_initial_state_has_no_trusted_bag_or_guessed_information() {
    let mut initial = initial_state(&setup()).unwrap();
    initial
        .entities
        .iter_mut()
        .find(|e| e.id == "travel-bag")
        .unwrap()
        .attributes
        .insert("note".into(), "自定义初始行囊".into());
    let (header, rows) = fixture(initial, &[]);
    let result = convert(&header, &rows);
    assert_eq!(
        result.current_state.item_holdings[0].value.status,
        HoldingStatus::LegacyUnknown
    );
    assert_eq!(result.current_state.item_holdings[0].source, source(None));
    assert!(result.current_state.knowledge.is_empty());
    assert!(result.current_state.claims.is_empty());
}

#[test]
fn same_turn_bag_transfer_and_return_does_not_reactivate_opening_exception() {
    let (header, rows) = fixture(
        initial_state(&setup()).unwrap(),
        &[output(
            1,
            vec![
                person("p-a", "王安"),
                StateChange::SetAttribute {
                    entity_id: "travel-bag".into(),
                    key: "ownerId".into(),
                    value: "p-a".into(),
                    expected_value: Some("player".into()),
                },
                StateChange::SetAttribute {
                    entity_id: "travel-bag".into(),
                    key: "ownerId".into(),
                    value: "player".into(),
                    expected_value: Some("p-a".into()),
                },
            ],
            Vec::new(),
        )],
    );
    let result = convert(&header, &rows);
    assert_eq!(
        result.current_state.item_holdings[0].value.status,
        HoldingStatus::LegacyUnknown
    );
    assert_eq!(
        result.current_state.item_holdings[0].source,
        source(Some(1))
    );
}

#[test]
fn original_newly_reserved_free_attributes_remain_unchanged_with_legacy_sources() {
    let reserved = [
        ("aliases", "原有普通文本属性"),
        ("createdSource", "原有普通来源描述"),
        ("nameSource", "原有名称说明"),
        ("lifeSource", "原有生存说明"),
        ("attributeSources", "原有属性说明"),
    ];
    let mut changes = vec![person("p-a", "王安")];
    for (key, value) in reserved {
        changes.push(StateChange::SetAttribute {
            entity_id: "p-a".into(),
            key: key.into(),
            value: value.into(),
            expected_value: None,
        });
    }
    let (header, rows) = fixture(
        initial_state(&setup()).unwrap(),
        &[output(1, changes, Vec::new())],
    );
    let result = convert(&header, &rows);
    let entity = result
        .current_state
        .entities
        .iter()
        .find(|e| e.id == "p-a")
        .unwrap();
    for (key, value) in reserved {
        assert_eq!(entity.attributes[key], value);
        assert_eq!(entity.attribute_sources[key], source(Some(1)));
    }
    assert!(entity.aliases.is_empty());
}

#[test]
fn invalid_chain_or_snapshot_is_atomic_and_retrying_the_correct_row_is_safe() {
    let (header, rows) = fixture(
        initial_state(&setup()).unwrap(),
        &[
            output(1, Vec::new(), Vec::new()),
            output(2, Vec::new(), Vec::new()),
        ],
    );
    let expected = convert(&header, &rows);
    let mut adapter = LegacyAdapter::from_header(&header).unwrap();
    let initial = adapter.current_state().clone();
    let mut bad_rows = Vec::new();
    let mut row = rows[0].clone();
    row.sequence = 2;
    bad_rows.push(row);
    let mut row = rows[0].clone();
    row.parent_turn_id = Some("bogus-parent".into());
    bad_rows.push(row);
    let mut row = rows[0].clone();
    row.turn_id = "bad id".into();
    bad_rows.push(row);
    let mut row = rows[0].clone();
    row.narrative = "不同正文".into();
    bad_rows.push(row);
    let mut row = rows[0].clone();
    row.choices_json = "[]".into();
    bad_rows.push(row);
    let mut row = rows[0].clone();
    row.state_json = header.initial_state_json.clone();
    bad_rows.push(row);
    let mut row = rows[0].clone();
    row.output_json = row
        .output_json
        .replace("\"protocolVersion\": 1", "\"protocolVersion\": 2");
    bad_rows.push(row);
    for row in &bad_rows {
        assert!(adapter.push_turn(row).is_err());
        assert_eq!(adapter.current_state(), &initial);
        assert_eq!(adapter.turn_count(), 0);
        assert_eq!(adapter.head_turn_id(), None);
    }
    adapter.push_turn(&rows[0]).unwrap();
    let mut duplicate = rows[1].clone();
    duplicate.turn_id = rows[0].turn_id.clone();
    assert!(adapter.push_turn(&duplicate).is_err());
    assert_eq!(adapter.turn_count(), 1);
    adapter.push_turn(&rows[1]).unwrap();
    assert!(adapter.push_turn(&rows[1]).is_err());
    assert_eq!(adapter.finish().unwrap(), expected);
    let mut truncated = LegacyAdapter::from_header(&header).unwrap();
    truncated.push_turn(&rows[0]).unwrap();
    assert_eq!(truncated.finish().unwrap_err(), GameError::Conflict);
}

#[test]
fn raw_json_whitespace_is_preserved_and_changes_fingerprint_without_changing_projection() {
    let (header, rows) = fixture(
        initial_state(&setup()).unwrap(),
        &[output(1, Vec::new(), Vec::new())],
    );
    let header_before = header.clone();
    let rows_before = rows.clone();
    let expected = convert(&header, &rows);
    assert_eq!(header, header_before);
    assert_eq!(rows, rows_before);
    assert_eq!(convert(&header, &rows), expected);
    let mut compact = rows.clone();
    let value: serde_json::Value = serde_json::from_str(&compact[0].output_json).unwrap();
    compact[0].output_json = serde_json::to_string(&value).unwrap();
    let changed = convert(&header, &compact);
    assert_eq!(changed.current_state, expected.current_state);
    assert_ne!(changed.raw_history_sha256, expected.raw_history_sha256);
}

fn write_long_archive(path: &Path) {
    let store = GameStore::open(path).unwrap();
    let setup = setup();
    store
        .create_world(&setup, &initial_state(&setup).unwrap(), "你抵达咸阳。", &[])
        .unwrap();
    let mut head = None;
    for n in 1..=300 {
        let mut changes = vec![StateChange::ChangeResource {
            owner_id: "player".into(),
            key: "cash".into(),
            unit: "记账单位".into(),
            delta: 1,
            expected_amount: Some(99 + n as i64),
        }];
        let mut events = Vec::new();
        if n == 1 {
            changes.extend([
                person("p-a", "王安"),
                person("p-b", "王安"),
                StateChange::AddCondition {
                    condition: Condition {
                        id: "injury".into(),
                        entity_id: "player".into(),
                        description: "持续扭伤；不得因摘要而消失。".into(),
                        active: true,
                    },
                },
                StateChange::RecordKnowledge {
                    actor_id: "player".into(),
                    fact_id: "old-secret".into(),
                },
            ]);
            events.push(GameEvent {
                id: "old-secret".into(),
                description: "钥匙藏在行囊里，只有主角知道。".into(),
                entity_ids: vec!["player".into()],
            });
        }
        if n == 4 {
            changes.push(StateChange::SetAttribute {
                entity_id: "p-a".into(),
                key: "job".into(),
                value: "药肆掌柜".into(),
                expected_value: None,
            });
        }
        if n == 6 {
            changes.push(StateChange::ChangeRelationship {
                from_id: "player".into(),
                to_id: "p-a".into(),
                kind: "信任".into(),
                strength: 10,
            });
        }
        if n == 200 {
            changes.push(StateChange::RecordKnowledge {
                actor_id: "p-a".into(),
                fact_id: "old-secret".into(),
            });
        }
        if n == 250 {
            changes.push(StateChange::ResolveCondition {
                condition_id: "injury".into(),
            });
        }
        if n == 299 {
            changes.push(StateChange::SetLifeStatus {
                entity_id: "p-b".into(),
                alive: false,
            });
        }
        let output = output(n, changes, events);
        let id = format!("legacy-turn-{n:08}");
        let request = GameTurnRequest {
            operation_id: id.clone(),
            world_id: setup.world_id.clone(),
            branch_id: "main".into(),
            expected_head_turn_id: head,
            action_kind: GameActionKind::Action,
            action_text: format!("固定第{n}回合。"),
        };
        store.begin(&request).unwrap();
        store.mark_generating(&id).unwrap();
        store
            .stage_output(&id, &serde_json::to_string_pretty(&output).unwrap())
            .unwrap();
        store.commit(&id, &output).unwrap();
        head = Some(id);
    }
    let request = GameTurnRequest {
        operation_id: "legacy-failed-input".into(),
        world_id: setup.world_id,
        branch_id: "main".into(),
        expected_head_turn_id: head,
        action_kind: GameActionKind::Action,
        action_text: "失败的原始中文行动必须保留。".into(),
    };
    store.begin(&request).unwrap();
    store
        .finish_uncommitted(
            &request.operation_id,
            GameOperationStatus::Failed,
            Some("network"),
        )
        .unwrap();
}

#[test]
fn all_300_archive_turns_preserve_sources_original_hash_and_failed_inputs() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("完整三百回合.sqlite");
    write_long_archive(&path);
    let archive = LegacyGameArchive::open(&path).unwrap();
    let original = archive.audit().clone();
    assert_eq!(original.operation_count, 301);
    let mut adapter = LegacyAdapter::from_header(&original.header).unwrap();
    let mut seen = 0;
    archive
        .visit_turns(|turn| {
            let state = adapter.push_turn(turn).unwrap();
            seen += 1;
            let injury = state.conditions.iter().find(|c| c.id == "injury").unwrap();
            assert_eq!(injury.started_source, source(Some(1)));
            assert_eq!(injury.category, ConditionCategory::LegacyUnspecified);
            assert_eq!(injury.active, seen < 250);
            if seen >= 250 {
                assert_eq!(injury.resolved_source, Some(source(Some(250))));
            }
            assert_eq!(state.item_holdings[0].source, StateSource::Initial);
            assert_eq!(
                state.item_holdings[0].value.holder_id.as_deref(),
                Some("player")
            );
            assert!(state.claims.is_empty());
            assert_eq!(state.knowledge.len(), if seen < 200 { 1 } else { 2 });
            Ok(ArchiveControl::Continue)
        })
        .unwrap();
    assert_eq!(seen, 300);
    let result = adapter.finish().unwrap();
    assert_eq!(result.turn_count, 300);
    assert_eq!(result.current_state.resources[0].amount, 400);
    assert_eq!(
        result.current_state.resources[0].last_changed_source,
        source(Some(300))
    );
    assert_eq!(
        result.current_state.time.last_changed_source,
        source(Some(300))
    );
    assert_eq!(result.current_state.location_source, source(None));
    let a = result
        .current_state
        .entities
        .iter()
        .find(|e| e.id == "p-a")
        .unwrap();
    assert_eq!(a.attribute_sources["job"], source(Some(4)));
    assert_eq!(a.life_source, source(Some(1)));
    let b = result
        .current_state
        .entities
        .iter()
        .find(|e| e.id == "p-b")
        .unwrap();
    assert_eq!(b.alive, Some(false));
    assert_eq!(b.life_source, source(Some(299)));
    assert_eq!(
        result.current_state.relationships[0].last_changed_source,
        source(Some(6))
    );
    assert_eq!(
        result.current_state.events[0].created_source,
        source(Some(1))
    );
    assert!(result
        .current_state
        .knowledge
        .iter()
        .all(|k| k.actor_id != "p-b"));
    assert_eq!(
        result
            .current_state
            .knowledge
            .iter()
            .find(|k| k.actor_id == "player")
            .unwrap()
            .source,
        source(Some(1))
    );
    assert_eq!(
        result
            .current_state
            .knowledge
            .iter()
            .find(|k| k.actor_id == "p-a")
            .unwrap()
            .source,
        source(Some(200))
    );
    drop(archive);
    let reopened = LegacyGameArchive::open(&path).unwrap();
    assert_eq!(reopened.audit(), &original);
    let mut failed = 0;
    reopened
        .visit_operations(|operation| {
            if operation.status == "failed" {
                failed += 1;
                assert_eq!(operation.action_text, "失败的原始中文行动必须保留。");
            }
            Ok(ArchiveControl::Continue)
        })
        .unwrap();
    assert_eq!(failed, 1);
}
