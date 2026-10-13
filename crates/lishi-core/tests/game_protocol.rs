use std::collections::BTreeMap;

use lishi_core::game_protocol::{
    apply_output, initial_state, parse_output, validate_setup, validate_state, Choice, Condition,
    DatePrecision, Entity, EntityKind, GameError, GameEvent, KnownFact, Relationship, Resource,
    StateChange, TimeAdvance, TurnOutput, WorldSetup, GAME_PROTOCOL_VERSION, MAX_CHOICES,
    MAX_ELAPSED_SECONDS, MAX_NARRATIVE_BYTES, MAX_RESOURCE_AMOUNT, MAX_TURN_OUTPUT_BYTES,
};
use serde_json::{json, Value};

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: "protocol-test-world".into(),
        title: "长安旅途".into(),
        country: "唐".into(),
        era_year: 742,
        location_name: "长安".into(),
        protagonist_name: "李青".into(),
        narrative_style: "中文、朴素叙事，保留资料不确定性。".into(),
    }
}

fn output(changes: Vec<StateChange>) -> TurnOutput {
    TurnOutput {
        protocol_version: GAME_PROTOCOL_VERSION,
        narrative: "晨光照在石阶上，你整理行囊。🙂".into(),
        choices: vec![Choice {
            id: "ask-way".into(),
            text: "向路人问路".into(),
        }],
        time_advance: TimeAdvance {
            elapsed_seconds: 60,
        },
        state_changes: changes,
        events: Vec::new(),
        source_references: Vec::new(),
        uncertainties: vec!["开局未进行独立史料研究。".into()],
    }
}

fn person(id: &str) -> Entity {
    Entity {
        id: id.into(),
        kind: EntityKind::Person,
        name: "王安".into(),
        alive: Some(true),
        attributes: BTreeMap::new(),
    }
}

fn resource(delta: i64, expected_amount: Option<i64>) -> StateChange {
    StateChange::ChangeResource {
        owner_id: "player".into(),
        key: "cash".into(),
        unit: "记账单位".into(),
        delta,
        expected_amount,
    }
}

#[test]
fn deterministic_setup_handles_bce_and_unicode_without_calendar_claims() {
    let mut selected = setup();
    selected.era_year = -221;
    let state = initial_state(&selected).unwrap();
    assert_eq!(state, initial_state(&selected).unwrap());
    assert_eq!(state.time.era_year, -221);
    assert_eq!(state.time.precision, DatePrecision::Year);
    assert_eq!(state.time.elapsed_seconds, 0);
    assert_eq!(state.location_id, "start-place");
    assert_eq!(state.protagonist_id, "player");
    assert_eq!(state.resources[0].amount, 100);
    assert_eq!(state.resources[0].unit, "记账单位");
    assert_eq!(state.entities[0].name, "李青");
    let mut advance = output(Vec::new());
    advance.time_advance.elapsed_seconds = 366 * 24 * 60 * 60;
    let next = apply_output(&state, &advance).unwrap();
    assert_eq!(next.time.era_year, -221);
    assert_eq!(next.time.precision, DatePrecision::Year);
    assert_eq!(next.time.elapsed_seconds, 366 * 24 * 60 * 60);

    for year in [0, -1_000_000, 1_000_000] {
        selected.era_year = year;
        assert_eq!(validate_setup(&selected), Err(GameError::InvalidSetup));
    }
    selected.era_year = 1;
    selected.world_id = "../world".into();
    assert_eq!(initial_state(&selected), Err(GameError::InvalidSetup));
    selected.world_id = "valid-world".into();
    selected.protagonist_name = "   ".into();
    assert_eq!(initial_state(&selected), Err(GameError::InvalidSetup));
}

#[test]
fn parsing_requires_a_complete_strict_versioned_object() {
    let valid = output(vec![resource(-10, Some(100))]);
    let raw = serde_json::to_string(&valid).unwrap();
    assert_eq!(parse_output(&raw).unwrap(), valid);
    assert_eq!(
        parse_output(&format!(" \n```json\n{raw}\n```\n")).unwrap(),
        valid
    );
    assert_eq!(
        parse_output(&format!("```json\r\n{raw}\r\n``` ")).unwrap(),
        valid
    );

    for malformed in [
        String::new(),
        "   ".into(),
        format!("说明：{raw}"),
        format!("{raw} 说明"),
        format!("{raw}{raw}"),
        format!("```\n{raw}\n```"),
        format!("```json{raw}```"),
        format!("```json\n{raw}"),
        raw[..raw.len() - 1].into(),
        "[]".into(),
        "null".into(),
    ] {
        assert_eq!(parse_output(&malformed), Err(GameError::InvalidOutput));
    }
    let mut value = serde_json::to_value(&valid).unwrap();
    value["executeSql"] = json!("DELETE FROM worlds");
    assert_eq!(
        parse_output(&value.to_string()),
        Err(GameError::InvalidOutput)
    );
    value.as_object_mut().unwrap().remove("executeSql");
    value["stateChanges"][0]["executeFile"] = json!("something");
    assert_eq!(
        parse_output(&value.to_string()),
        Err(GameError::InvalidOutput)
    );
    value["stateChanges"][0]
        .as_object_mut()
        .unwrap()
        .remove("executeFile");
    value["protocolVersion"] = json!(2);
    assert_eq!(
        parse_output(&value.to_string()),
        Err(GameError::InvalidProtocol)
    );
    value["protocolVersion"] = json!(1);
    value.as_object_mut().unwrap().remove("events");
    assert_eq!(
        parse_output(&value.to_string()),
        Err(GameError::InvalidOutput)
    );
}

#[test]
fn nullable_fields_are_explicit_and_operation_types_are_closed() {
    let valid = output(vec![resource(5, None)]);
    let mut value = serde_json::to_value(&valid).unwrap();
    assert!(value["stateChanges"][0]["expectedAmount"].is_null());
    assert!(parse_output(&value.to_string()).is_ok());
    value["stateChanges"][0]
        .as_object_mut()
        .unwrap()
        .remove("expectedAmount");
    assert_eq!(
        parse_output(&value.to_string()),
        Err(GameError::InvalidOutput)
    );
    value["stateChanges"] = json!([{
        "type":"set_attribute", "entityId":"player", "key":"occupation", "value":"旅人"
    }]);
    assert_eq!(
        parse_output(&value.to_string()),
        Err(GameError::InvalidOutput)
    );
    value["stateChanges"] = json!([{
        "type":"create_entity", "entity":{
            "id":"gate", "kind":"place", "name":"城门", "attributes":{}
        }
    }]);
    assert_eq!(
        parse_output(&value.to_string()),
        Err(GameError::InvalidOutput)
    );
    value["stateChanges"] = json!([{"type":"run_sql", "sql":"SELECT 1"}]);
    assert_eq!(
        parse_output(&value.to_string()),
        Err(GameError::InvalidOutput)
    );
    value["timeAdvance"]["elapsedSeconds"] = json!(-1);
    assert_eq!(
        parse_output(&value.to_string()),
        Err(GameError::InvalidOutput)
    );
}

#[test]
fn historical_year_precision_is_required_and_cannot_claim_a_full_calendar() {
    let state = initial_state(&setup()).unwrap();
    let mut value = serde_json::to_value(&state).unwrap();
    assert_eq!(value["time"]["precision"], "year");
    value["time"].as_object_mut().unwrap().remove("precision");
    assert!(
        serde_json::from_value::<lishi_core::game_protocol::WorldState>(value.clone()).is_err()
    );
    value["time"]["precision"] = json!("day");
    assert!(serde_json::from_value::<lishi_core::game_protocol::WorldState>(value).is_err());
}

#[test]
fn narrative_choices_sources_and_payload_limits_are_enforced() {
    let state = initial_state(&setup()).unwrap();
    let mut valid = output(Vec::new());
    valid.narrative = "  \n ".into();
    assert_eq!(apply_output(&state, &valid), Err(GameError::InvalidOutput));
    valid.narrative = "中".repeat(MAX_NARRATIVE_BYTES / 3 + 1);
    assert_eq!(apply_output(&state, &valid), Err(GameError::TooLarge));
    valid.narrative = "正常正文".into();
    valid.choices = (0..=MAX_CHOICES)
        .map(|index| Choice {
            id: format!("choice-{index}"),
            text: "前进".into(),
        })
        .collect();
    assert_eq!(apply_output(&state, &valid), Err(GameError::TooLarge));
    valid.choices = vec![
        Choice {
            id: "same".into(),
            text: "前进".into()
        };
        2
    ];
    assert_eq!(apply_output(&state, &valid), Err(GameError::InvalidOutput));
    valid.choices.clear();
    valid.source_references = vec!["invented-history-reference".into()];
    assert_eq!(
        apply_output(&state, &valid),
        Err(GameError::InvalidReference)
    );
    assert_eq!(
        parse_output(&" ".repeat(MAX_TURN_OUTPUT_BYTES + 1)),
        Err(GameError::TooLarge)
    );
    let large = output(
        (0..128)
            .map(|index| StateChange::SetAttribute {
                entity_id: "player".into(),
                key: format!("attribute-{index}"),
                value: "a".repeat(2048),
                expected_value: None,
            })
            .collect(),
    );
    assert_eq!(apply_output(&state, &large), Err(GameError::TooLarge));
}

#[test]
fn late_invalid_operation_rolls_back_time_events_and_every_prior_change() {
    let state = initial_state(&setup()).unwrap();
    let before = serde_json::to_vec(&state).unwrap();
    let mut turn = output(vec![
        resource(-10, Some(100)),
        StateChange::SetAttribute {
            entity_id: "player".into(),
            key: "occupation".into(),
            value: "旅人".into(),
            expected_value: None,
        },
        StateChange::Move {
            location_id: "unknown-place".into(),
        },
    ]);
    turn.events.push(GameEvent {
        id: "paid-fare".into(),
        description: "付了路费".into(),
        entity_ids: vec!["player".into()],
    });
    assert_eq!(
        apply_output(&state, &turn),
        Err(GameError::InvalidReference)
    );
    assert_eq!(serde_json::to_vec(&state).unwrap(), before);
    assert_eq!(state.resources[0].amount, 100);
    assert!(state.events.is_empty());
    assert_eq!(state.time.elapsed_seconds, 0);
}

#[test]
fn resource_preconditions_units_debt_and_overflow_are_checked() {
    let mut state = initial_state(&setup()).unwrap();
    let next = apply_output(&state, &output(vec![resource(-10, Some(100))])).unwrap();
    assert_eq!(next.resources[0].amount, 90);
    assert_eq!(
        apply_output(&next, &output(vec![resource(-10, Some(100))])),
        Err(GameError::Conflict)
    );
    assert_eq!(
        apply_output(&state, &output(vec![resource(-101, None)])),
        Err(GameError::InvalidResource)
    );
    let wrong_unit = StateChange::ChangeResource {
        owner_id: "player".into(),
        key: "cash".into(),
        unit: "美元".into(),
        delta: 1,
        expected_amount: None,
    };
    assert_eq!(
        apply_output(&state, &output(vec![wrong_unit])),
        Err(GameError::InvalidResource)
    );
    state.resources[0].amount = MAX_RESOURCE_AMOUNT;
    assert_eq!(
        apply_output(&state, &output(vec![resource(1, None)])),
        Err(GameError::InvalidResource)
    );
    assert_eq!(
        apply_output(&state, &output(vec![resource(i64::MAX, None)])),
        Err(GameError::InvalidResource)
    );
    state.resources[0].amount = i64::MAX;
    assert_eq!(validate_state(&state), Err(GameError::InvalidResource));

    let state = initial_state(&setup()).unwrap();
    let create = StateChange::ChangeResource {
        owner_id: "player".into(),
        key: "grain".into(),
        unit: "袋".into(),
        delta: 2,
        expected_amount: Some(0),
    };
    let next = apply_output(&state, &output(vec![create])).unwrap();
    assert_eq!(next.resources.len(), 2);
    assert_eq!(next.resources[1].amount, 2);
    let missing_owner = StateChange::ChangeResource {
        owner_id: "missing".into(),
        key: "grain".into(),
        unit: "袋".into(),
        delta: 2,
        expected_amount: None,
    };
    assert_eq!(
        apply_output(&state, &output(vec![missing_owner])),
        Err(GameError::InvalidReference)
    );
}

#[test]
fn person_death_cannot_be_reversed_or_hidden_in_attributes() {
    let state = initial_state(&setup()).unwrap();
    let dead = apply_output(
        &state,
        &output(vec![StateChange::SetLifeStatus {
            entity_id: "player".into(),
            alive: false,
        }]),
    )
    .unwrap();
    assert_eq!(dead.entities[0].alive, Some(false));
    assert_eq!(
        apply_output(
            &dead,
            &output(vec![StateChange::SetLifeStatus {
                entity_id: "player".into(),
                alive: true
            }])
        ),
        Err(GameError::DeadCannotRevive)
    );
    for key in [
        "alive",
        "Alive",
        "id",
        "locationId",
        "time",
        "name",
        " alive ",
    ] {
        let rewrite = StateChange::SetAttribute {
            entity_id: "player".into(),
            key: key.into(),
            value: "true".into(),
            expected_value: None,
        };
        assert_eq!(
            apply_output(&state, &output(vec![rewrite])),
            Err(GameError::InvalidEntity)
        );
    }
    assert_eq!(
        apply_output(
            &state,
            &output(vec![StateChange::SetLifeStatus {
                entity_id: "start-place".into(),
                alive: false
            }])
        ),
        Err(GameError::InvalidEntity)
    );
}

#[test]
fn entity_creation_and_location_reference_are_explicit() {
    let state = initial_state(&setup()).unwrap();
    let place = Entity {
        id: "market".into(),
        kind: EntityKind::Place,
        name: "市集".into(),
        alive: None,
        attributes: BTreeMap::new(),
    };
    let next = apply_output(
        &state,
        &output(vec![
            StateChange::CreateEntity {
                entity: place.clone(),
            },
            StateChange::Move {
                location_id: "market".into(),
            },
        ]),
    )
    .unwrap();
    assert_eq!(next.location_id, "market");
    assert_eq!(
        apply_output(
            &next,
            &output(vec![StateChange::CreateEntity { entity: place }])
        ),
        Err(GameError::Conflict)
    );
    assert_eq!(
        apply_output(
            &state,
            &output(vec![StateChange::Move {
                location_id: "player".into()
            }])
        ),
        Err(GameError::InvalidReference)
    );
    let mut invalid = person("bad-person");
    invalid.alive = None;
    assert_eq!(
        apply_output(
            &state,
            &output(vec![StateChange::CreateEntity { entity: invalid }])
        ),
        Err(GameError::InvalidEntity)
    );
    let mut invalid = person("../../outside");
    invalid.alive = Some(true);
    assert_eq!(
        apply_output(
            &state,
            &output(vec![StateChange::CreateEntity { entity: invalid }])
        ),
        Err(GameError::InvalidEntity)
    );
}

#[test]
fn same_turn_events_relationships_conditions_and_knowledge_are_checked() {
    let state = initial_state(&setup()).unwrap();
    let mut turn = output(vec![
        StateChange::CreateEntity {
            entity: person("wang-an"),
        },
        StateChange::ChangeRelationship {
            from_id: "player".into(),
            to_id: "wang-an".into(),
            kind: "信任".into(),
            strength: 20,
        },
        StateChange::AddCondition {
            condition: Condition {
                id: "sprained-ankle".into(),
                entity_id: "player".into(),
                description: "左脚扭伤".into(),
                active: true,
            },
        },
        StateChange::RecordKnowledge {
            actor_id: "player".into(),
            fact_id: "met-guide".into(),
        },
    ]);
    turn.events = vec![GameEvent {
        id: "met-guide".into(),
        description: "遇见王安并知道北门所在。".into(),
        entity_ids: vec!["player".into(), "wang-an".into()],
    }];
    let next = apply_output(&state, &turn).unwrap();
    assert_eq!(next.relationships[0].strength, 20);
    assert_eq!(next.known_facts[0].fact_id, "met-guide");
    assert!(next.conditions[0].active);
    let resolved = apply_output(
        &next,
        &output(vec![StateChange::ResolveCondition {
            condition_id: "sprained-ankle".into(),
        }]),
    )
    .unwrap();
    assert!(!resolved.conditions[0].active);
    assert_eq!(
        apply_output(
            &resolved,
            &output(vec![StateChange::ResolveCondition {
                condition_id: "sprained-ankle".into()
            }])
        ),
        Err(GameError::InvalidCondition)
    );
    assert_eq!(apply_output(&next, &turn), Err(GameError::Conflict));
    assert_eq!(
        apply_output(
            &state,
            &output(vec![StateChange::RecordKnowledge {
                actor_id: "player".into(),
                fact_id: "imagined-secret".into()
            }])
        ),
        Err(GameError::InvalidKnowledge)
    );
    let relationship = StateChange::ChangeRelationship {
        from_id: "player".into(),
        to_id: "missing".into(),
        kind: "信任".into(),
        strength: 101,
    };
    assert_eq!(
        apply_output(&state, &output(vec![relationship])),
        Err(GameError::InvalidRelationship)
    );
}

#[test]
fn unsafe_state_and_time_overflow_never_become_valid_turn_bases() {
    let mut state = initial_state(&setup()).unwrap();
    state.time.elapsed_seconds = MAX_ELAPSED_SECONDS;
    assert_eq!(
        apply_output(&state, &output(Vec::new())),
        Err(GameError::InvalidTime)
    );
    state.time.elapsed_seconds = 0;
    state.entities.push(state.entities[0].clone());
    assert_eq!(validate_state(&state), Err(GameError::InvalidEntity));

    let mut state = initial_state(&setup()).unwrap();
    state.resources.push(Resource {
        owner_id: "player".into(),
        key: "cash".into(),
        unit: "记账单位".into(),
        amount: 1,
    });
    assert_eq!(validate_state(&state), Err(GameError::InvalidResource));
    state.resources.pop();
    state.relationships.push(Relationship {
        from_id: "player".into(),
        to_id: "player".into(),
        kind: "信任".into(),
        strength: 0,
    });
    assert_eq!(validate_state(&state), Err(GameError::InvalidRelationship));
    state.relationships.clear();
    state.events.push(GameEvent {
        id: "missing-reference".into(),
        description: "无效事件".into(),
        entity_ids: vec!["missing".into()],
    });
    assert_eq!(validate_state(&state), Err(GameError::InvalidEvent));
    state.events.clear();
    state.known_facts.push(KnownFact {
        actor_id: "start-place".into(),
        fact_id: "missing".into(),
    });
    assert_eq!(validate_state(&state), Err(GameError::InvalidKnowledge));
}

#[test]
fn expected_attribute_value_detects_conflict_and_safe_codes_do_not_echo_input() {
    let state = initial_state(&setup()).unwrap();
    let create = StateChange::SetAttribute {
        entity_id: "player".into(),
        key: "occupation".into(),
        value: "旅人".into(),
        expected_value: None,
    };
    let next = apply_output(&state, &output(vec![create])).unwrap();
    let change = StateChange::SetAttribute {
        entity_id: "player".into(),
        key: "occupation".into(),
        value: "学徒".into(),
        expected_value: Some("旅人".into()),
    };
    let changed = apply_output(&next, &output(vec![change.clone()])).unwrap();
    assert_eq!(
        changed.entities[0].attributes.get("occupation").unwrap(),
        "学徒"
    );
    assert_eq!(
        apply_output(&changed, &output(vec![change])),
        Err(GameError::Conflict)
    );
    assert_eq!(
        parse_output("secret-value-untrusted-output")
            .unwrap_err()
            .to_string(),
        "game_invalid_output"
    );
    assert_eq!(
        serde_json::to_value(&changed).unwrap()["entities"][1]["alive"],
        Value::Null
    );
}
