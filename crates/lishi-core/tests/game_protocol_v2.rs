use std::collections::BTreeMap;

use lishi_core::game_protocol::{
    EntityKind, GameError, WorldSetup, MAX_ELAPSED_SECONDS, MAX_RESOURCE_AMOUNT,
};
use lishi_core::game_protocol_v2::*;
use serde_json::{json, Value};

fn initial() -> WorldStateV2 {
    initial_state_v2(&WorldSetup {
        world_id: "v2-fixed-test-world".into(),
        title: "严格事实".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "李明🙂".into(),
        narrative_style: "中文；历史资料未知时保留不确定性。".into(),
    })
    .unwrap()
}

fn context(n: usize) -> CommitContext {
    CommitContext {
        operation_id: format!("op-{n}"),
        turn_id: format!("turn-{n}"),
    }
}

fn output(id: &str, subjects: &[&str], changes: Vec<StateChangeV2>) -> TurnOutputV2 {
    TurnOutputV2 {
        protocol_version: 2,
        narrative: "这是固定测试剧情，包含中文和表情🙂。".into(),
        choices: Vec::new(),
        time_advance: TimeAdvanceV2 {
            elapsed_seconds: 0,
            event_id: None,
        },
        state_changes: changes,
        events: vec![EventInput {
            id: id.into(),
            description: "明确发生的测试事件。".into(),
            entity_ids: subjects.iter().map(|id| (*id).into()).collect(),
            disclosure: Disclosure::Restricted,
        }],
        source_references: Vec::new(),
        uncertainties: Vec::new(),
    }
}

fn person(id: &str, name: &str, event: &str) -> StateChangeV2 {
    StateChangeV2::CreateEntity {
        entity: EntityInput {
            id: id.into(),
            kind: EntityKind::Person,
            name: name.into(),
            alive: Some(true),
            attributes: BTreeMap::new(),
        },
        event_id: event.into(),
    }
}

fn item(id: &str, holder: &str, quantity: i64, event: &str) -> Vec<StateChangeV2> {
    vec![
        StateChangeV2::CreateEntity {
            entity: EntityInput {
                id: id.into(),
                kind: EntityKind::Item,
                name: "钥匙".into(),
                alive: None,
                attributes: BTreeMap::new(),
            },
            event_id: event.into(),
        },
        StateChangeV2::SetItemHolding {
            item_id: id.into(),
            expected_holding: None,
            holder_id: Some(holder.into()),
            place_id: None,
            quantity,
            unit: "把".into(),
            event_id: event.into(),
        },
    ]
}

fn holding(state: &WorldStateV2, id: &str) -> HoldingValue {
    state
        .item_holdings
        .iter()
        .find(|h| h.item_id == id)
        .unwrap()
        .value
        .clone()
}

fn encounter() -> WorldStateV2 {
    apply_output_v2(
        &initial(),
        &output(
            "meet",
            &["player", "p-a", "p-b"],
            vec![person("p-a", "王安", "meet"), person("p-b", "王安", "meet")],
        ),
        &context(1),
    )
    .unwrap()
}

#[test]
fn trusted_start_has_normalized_inventory_and_strict_round_trip() {
    let state = initial();
    assert_eq!(
        holding(&state, "travel-bag"),
        HoldingValue {
            status: HoldingStatus::Known,
            holder_id: Some("player".into()),
            place_id: None,
            quantity: Some(1),
            unit: Some("件".into())
        }
    );
    assert!(state
        .entities
        .iter()
        .all(|e| e.attributes.is_empty() && e.created_source == StateSource::Initial));
    let json = serde_json::to_string(&state).unwrap();
    assert_eq!(serde_json::from_str::<WorldStateV2>(&json).unwrap(), state);
    assert!(json.contains("李明🙂"));
    let mut bad: Value = serde_json::from_str(&json).unwrap();
    bad["protocolVersion"] = json!(3);
    assert_eq!(
        validate_state_v2(&serde_json::from_value(bad).unwrap()),
        Err(GameError::InvalidProtocol)
    );
}

#[test]
fn rename_keeps_identity_relationship_inventory_condition_and_the_other_namesake() {
    let mut setup = vec![
        StateChangeV2::ChangeRelationship {
            from_id: "player".into(),
            to_id: "p-a".into(),
            kind: "朋友".into(),
            strength: 10,
            event_id: "known".into(),
        },
        StateChangeV2::AddCondition {
            condition: ConditionInput {
                id: "injury-a".into(),
                entity_id: "p-a".into(),
                description: "扭伤未愈".into(),
                category: ConditionCategory::Injury,
                active: true,
            },
            event_id: "known".into(),
        },
    ];
    setup.extend(item("key-a", "p-a", 1, "known"));
    let before = apply_output_v2(
        &encounter(),
        &output("known", &["player", "p-a", "key-a"], setup),
        &context(2),
    )
    .unwrap();
    let after = apply_output_v2(
        &before,
        &output(
            "rename",
            &["p-a"],
            vec![StateChangeV2::RenameEntity {
                entity_id: "p-a".into(),
                expected_name: "王安".into(),
                new_name: "王平".into(),
                event_id: "rename".into(),
            }],
        ),
        &context(3),
    )
    .unwrap();
    let a = after.entities.iter().find(|e| e.id == "p-a").unwrap();
    assert_eq!(a.name, "王平");
    assert_eq!(a.alive, Some(true));
    assert_eq!(a.aliases[0].text, "王安");
    assert_eq!(a.aliases[0].kind, AliasKind::FormerName);
    assert_eq!(
        after.entities.iter().find(|e| e.id == "p-b").unwrap().name,
        "王安"
    );
    assert_eq!(after.relationships, before.relationships);
    assert_eq!(after.item_holdings, before.item_holdings);
    assert_eq!(after.conditions, before.conditions);
    let stale = output(
        "rename-stale",
        &["p-a"],
        vec![StateChangeV2::RenameEntity {
            entity_id: "p-a".into(),
            expected_name: "王安".into(),
            new_name: "假名".into(),
            event_id: "rename-stale".into(),
        }],
    );
    assert_eq!(
        apply_output_v2(&after, &stale, &context(4)),
        Err(GameError::Conflict)
    );
    assert_eq!(a.name, "王平");
}

#[test]
fn rename_back_merges_existing_alias_but_duplicate_alias_and_id_are_rejected() {
    let before = encounter();
    let named = apply_output_v2(
        &before,
        &output(
            "n1",
            &["p-a"],
            vec![StateChangeV2::RenameEntity {
                entity_id: "p-a".into(),
                expected_name: "王安".into(),
                new_name: "王平".into(),
                event_id: "n1".into(),
            }],
        ),
        &context(2),
    )
    .unwrap();
    let back = apply_output_v2(
        &named,
        &output(
            "n2",
            &["p-a"],
            vec![StateChangeV2::RenameEntity {
                entity_id: "p-a".into(),
                expected_name: "王平".into(),
                new_name: "王安".into(),
                event_id: "n2".into(),
            }],
        ),
        &context(3),
    )
    .unwrap();
    assert_eq!(
        back.entities
            .iter()
            .find(|e| e.id == "p-a")
            .unwrap()
            .aliases
            .iter()
            .map(|a| a.text.as_str())
            .collect::<Vec<_>>(),
        ["王平"]
    );
    assert_eq!(
        apply_output_v2(
            &back,
            &output(
                "dup",
                &["p-a"],
                vec![StateChangeV2::AddAlias {
                    entity_id: "p-a".into(),
                    text: "王平".into(),
                    kind: AliasKind::Other,
                    event_id: "dup".into()
                }]
            ),
            &context(4)
        ),
        Err(GameError::Conflict)
    );
    assert_eq!(
        apply_output_v2(
            &back,
            &output("dup-id", &["p-a"], vec![person("p-a", "另一人", "dup-id")]),
            &context(4)
        ),
        Err(GameError::Conflict)
    );
}

#[test]
fn transfer_uses_all_precondition_fields_and_does_not_move_the_namesake_key() {
    let mut changes = item("key-a", "player", 1, "keys");
    changes.extend(item("key-b", "player", 1, "keys"));
    let before = apply_output_v2(
        &encounter(),
        &output("keys", &["player", "key-a", "key-b"], changes),
        &context(2),
    )
    .unwrap();
    let transfer = StateChangeV2::SetItemHolding {
        item_id: "key-a".into(),
        expected_holding: Some(holding(&before, "key-a")),
        holder_id: Some("p-a".into()),
        place_id: None,
        quantity: 1,
        unit: "把".into(),
        event_id: "transfer".into(),
    };
    let after = apply_output_v2(
        &before,
        &output(
            "transfer",
            &["player", "p-a", "key-a"],
            vec![transfer.clone()],
        ),
        &context(3),
    )
    .unwrap();
    assert_eq!(holding(&after, "key-a").holder_id.as_deref(), Some("p-a"));
    assert_eq!(holding(&after, "key-b"), holding(&before, "key-b"));
    let mut stale = transfer;
    if let StateChangeV2::SetItemHolding {
        expected_holding: Some(value),
        event_id,
        ..
    } = &mut stale
    {
        value.unit = Some("份".into());
        *event_id = "stale-transfer".into();
    }
    assert_eq!(
        apply_output_v2(
            &after,
            &output("stale-transfer", &["player", "p-a", "key-a"], vec![stale]),
            &context(4)
        ),
        Err(GameError::Conflict)
    );
}

#[test]
fn depletion_retains_zero_and_unit_and_cannot_restock_an_exhausted_identity() {
    let before = apply_output_v2(
        &initial(),
        &output("keys", &["player", "key"], item("key", "player", 2, "keys")),
        &context(1),
    )
    .unwrap();
    let after = apply_output_v2(
        &before,
        &output(
            "consume",
            &["player", "key"],
            vec![StateChangeV2::ChangeItemQuantity {
                item_id: "key".into(),
                expected_holding: holding(&before, "key"),
                delta: -2,
                event_id: "consume".into(),
            }],
        ),
        &context(2),
    )
    .unwrap();
    assert_eq!(
        holding(&after, "key"),
        HoldingValue {
            status: HoldingStatus::Known,
            holder_id: None,
            place_id: None,
            quantity: Some(0),
            unit: Some("把".into())
        }
    );
    assert!(after.entities.iter().any(|e| e.id == "key"));
    let refill = StateChangeV2::ChangeItemQuantity {
        item_id: "key".into(),
        expected_holding: holding(&after, "key"),
        delta: 1,
        event_id: "refill".into(),
    };
    assert_eq!(
        apply_output_v2(
            &after,
            &output("refill", &["key", "player"], vec![refill]),
            &context(3)
        ),
        Err(GameError::InvalidResource)
    );
    let refill = StateChangeV2::SetItemHolding {
        item_id: "key".into(),
        expected_holding: Some(holding(&after, "key")),
        holder_id: Some("player".into()),
        place_id: None,
        quantity: 1,
        unit: "把".into(),
        event_id: "refill".into(),
    };
    assert_eq!(
        apply_output_v2(
            &after,
            &output("refill", &["key", "player"], vec![refill]),
            &context(3)
        ),
        Err(GameError::InvalidResource)
    );
}

#[test]
fn late_purchase_failure_rolls_back_money_inventory_time_events_and_sources() {
    let before = initial();
    let bytes = serde_json::to_vec(&before).unwrap();
    let mut changes = vec![StateChangeV2::ChangeResource {
        owner_id: "player".into(),
        key: "cash".into(),
        unit: "记账单位".into(),
        delta: -5,
        expected_amount: Some(100),
        event_id: "purchase".into(),
    }];
    changes.extend(item("key", "player", 1, "purchase"));
    changes.push(StateChangeV2::SetLifeStatus {
        entity_id: "missing".into(),
        alive: false,
        event_id: "purchase".into(),
    });
    let mut purchase = output("purchase", &["player", "key"], changes);
    purchase.time_advance = TimeAdvanceV2 {
        elapsed_seconds: 3600,
        event_id: Some("purchase".into()),
    };
    assert_eq!(
        apply_output_v2(&before, &purchase, &context(1)),
        Err(GameError::InvalidReference)
    );
    assert_eq!(serde_json::to_vec(&before).unwrap(), bytes);
    purchase.state_changes.pop();
    let after = apply_output_v2(&before, &purchase, &context(1)).unwrap();
    assert_eq!(after.resources[0].amount, 95);
    assert_eq!(holding(&after, "key").quantity, Some(1));
    assert_eq!(after.time.elapsed_seconds, 3600);
    assert!(
        matches!(&after.resources[0].last_changed_source,StateSource::Turn {operation_id,turn_id,event_id} if operation_id=="op-1" && turn_id=="turn-1" && event_id=="purchase")
    );
}

#[test]
fn explicit_null_means_absent_not_a_resource_or_attribute_wildcard() {
    let bad = output(
        "bad",
        &["player"],
        vec![StateChangeV2::ChangeResource {
            owner_id: "player".into(),
            key: "cash".into(),
            unit: "记账单位".into(),
            delta: 1,
            expected_amount: None,
            event_id: "bad".into(),
        }],
    );
    assert_eq!(
        apply_output_v2(&initial(), &bad, &context(1)),
        Err(GameError::Conflict)
    );
    let set = StateChangeV2::SetAttribute {
        entity_id: "player".into(),
        key: "职业".into(),
        value: "商旅".into(),
        expected_value: None,
        event_id: "set".into(),
    };
    let before = apply_output_v2(
        &initial(),
        &output("set", &["player"], vec![set]),
        &context(1),
    )
    .unwrap();
    let bad = StateChangeV2::SetAttribute {
        entity_id: "player".into(),
        key: "职业".into(),
        value: "医者".into(),
        expected_value: None,
        event_id: "bad".into(),
    };
    assert_eq!(
        apply_output_v2(&before, &output("bad", &["player"], vec![bad]), &context(2)),
        Err(GameError::Conflict)
    );
}

#[test]
fn invalid_inventory_shapes_and_attribute_bypass_cannot_enter_formal_state() {
    let before = initial();
    for key in ["ownerId", "HolderID", "quantity", "Unit", "placeId"] {
        let bad = StateChangeV2::SetAttribute {
            entity_id: "travel-bag".into(),
            key: key.into(),
            value: "任意字符串".into(),
            expected_value: None,
            event_id: "bad".into(),
        };
        assert_eq!(
            apply_output_v2(
                &before,
                &output("bad", &["travel-bag"], vec![bad]),
                &context(1)
            ),
            Err(GameError::InvalidEntity)
        );
    }
    for (holder, place, quantity, unit) in [
        (Some("start-place"), None, 1, "把"),
        (Some("player"), Some("start-place"), 1, "把"),
        (None, None, 1, "把"),
        (Some("player"), None, 0, "把"),
        (Some("player"), None, -1, "把"),
        (Some("player"), None, 1, ""),
    ] {
        let mut bad = item("key", "player", 1, "bad");
        if let StateChangeV2::SetItemHolding {
            holder_id,
            place_id,
            quantity: q,
            unit: u,
            ..
        } = &mut bad[1]
        {
            *holder_id = holder.map(str::to_owned);
            *place_id = place.map(str::to_owned);
            *q = quantity;
            *u = unit.into();
        }
        assert_eq!(
            apply_output_v2(
                &before,
                &output("bad", &["key", "player", "start-place"], bad),
                &context(1)
            ),
            Err(GameError::InvalidResource)
        );
    }
    let mut missing = item("key", "player", 1, "bad");
    missing.pop();
    assert_eq!(
        apply_output_v2(&before, &output("bad", &["key"], missing), &context(1)),
        Err(GameError::InvalidResource)
    );
    let changed = StateChangeV2::SetItemHolding {
        item_id: "travel-bag".into(),
        expected_holding: Some(holding(&before, "travel-bag")),
        holder_id: Some("player".into()),
        place_id: None,
        quantity: 1,
        unit: "份".into(),
        event_id: "bad".into(),
    };
    assert_eq!(
        apply_output_v2(
            &before,
            &output("bad", &["travel-bag", "player"], vec![changed]),
            &context(1)
        ),
        Err(GameError::InvalidResource)
    );
}

#[test]
fn legacy_unknown_is_preserved_until_explicit_verified_holding_then_can_be_consumed() {
    // This is a normalized compatibility fixture, not a migration entry point.
    let mut before = initial();
    let legacy = StateSource::LegacySnapshot {
        turn_id: Some("old-turn".into()),
        format_version: 1,
    };
    let bag = before
        .entities
        .iter_mut()
        .find(|e| e.id == "travel-bag")
        .unwrap();
    bag.attributes.insert("quantity".into(), "两份?".into());
    bag.attribute_sources
        .insert("quantity".into(), legacy.clone());
    before.item_holdings[0] = ItemHolding {
        item_id: "travel-bag".into(),
        value: HoldingValue {
            status: HoldingStatus::LegacyUnknown,
            holder_id: None,
            place_id: None,
            quantity: None,
            unit: None,
        },
        source: legacy,
    };
    validate_state_v2(&before).unwrap();
    let bad = StateChangeV2::ChangeItemQuantity {
        item_id: "travel-bag".into(),
        expected_holding: holding(&before, "travel-bag"),
        delta: -1,
        event_id: "bad".into(),
    };
    assert_eq!(
        apply_output_v2(
            &before,
            &output("bad", &["travel-bag", "player"], vec![bad]),
            &context(1)
        ),
        Err(GameError::InvalidResource)
    );
    let confirm = StateChangeV2::SetItemHolding {
        item_id: "travel-bag".into(),
        expected_holding: Some(holding(&before, "travel-bag")),
        holder_id: Some("player".into()),
        place_id: None,
        quantity: 2,
        unit: "件".into(),
        event_id: "inspect".into(),
    };
    let confirmed = apply_output_v2(
        &before,
        &output("inspect", &["travel-bag", "player"], vec![confirm]),
        &context(1),
    )
    .unwrap();
    assert_eq!(
        confirmed
            .entities
            .iter()
            .find(|e| e.id == "travel-bag")
            .unwrap()
            .attributes["quantity"],
        "两份?"
    );
    let consumed = apply_output_v2(
        &confirmed,
        &output(
            "use",
            &["travel-bag", "player"],
            vec![StateChangeV2::ChangeItemQuantity {
                item_id: "travel-bag".into(),
                expected_holding: holding(&confirmed, "travel-bag"),
                delta: -1,
                event_id: "use".into(),
            }],
        ),
        &context(2),
    )
    .unwrap();
    assert_eq!(holding(&consumed, "travel-bag").quantity, Some(1));
}

#[test]
fn injury_persists_across_one_hundred_turns_and_only_explicit_resolution_closes_it() {
    let injury = StateChangeV2::AddCondition {
        condition: ConditionInput {
            id: "ankle".into(),
            entity_id: "player".into(),
            description: "脚踝扭伤".into(),
            category: ConditionCategory::Injury,
            active: true,
        },
        event_id: "injured".into(),
    };
    let mut state = apply_output_v2(
        &initial(),
        &output("injured", &["player"], vec![injury]),
        &context(1),
    )
    .unwrap();
    let first_source = state.conditions[0].started_source.clone();
    for n in 2..=101 {
        let id = format!("rest-{n}");
        let mut rest = output(&id, &["player"], Vec::new());
        rest.time_advance = TimeAdvanceV2 {
            elapsed_seconds: 3600,
            event_id: Some(id),
        };
        state = apply_output_v2(&state, &rest, &context(n)).unwrap();
    }
    assert!(state.conditions[0].active);
    assert_eq!(state.conditions[0].started_source, first_source);
    assert_eq!(state.time.elapsed_seconds, 360000);
    let improve = StateChangeV2::UpdateCondition {
        condition_id: "ankle".into(),
        expected_description: "脚踝扭伤".into(),
        new_description: "脚踝扭伤，已经好转".into(),
        event_id: "improved".into(),
    };
    let improved = apply_output_v2(
        &state,
        &output("improved", &["player"], vec![improve]),
        &context(102),
    )
    .unwrap();
    assert_eq!(improved.conditions[0].started_source, first_source);
    assert!(improved.conditions[0].active);
    let healed = apply_output_v2(
        &improved,
        &output(
            "healed",
            &["player"],
            vec![StateChangeV2::ResolveCondition {
                condition_id: "ankle".into(),
                event_id: "healed".into(),
            }],
        ),
        &context(103),
    )
    .unwrap();
    assert!(!healed.conditions[0].active);
    assert_eq!(
        healed.conditions[0].resolved_source.as_ref(),
        Some(&healed.conditions[0].last_changed_source)
    );
    assert_eq!(
        apply_output_v2(
            &healed,
            &output(
                "again",
                &["player"],
                vec![StateChangeV2::ResolveCondition {
                    condition_id: "ankle".into(),
                    event_id: "again".into()
                }]
            ),
            &context(104)
        ),
        Err(GameError::InvalidCondition)
    );
}

#[test]
fn death_does_not_delete_obligations_or_transfer_items_and_a_rename_cannot_revive() {
    let mut changes = item("key", "p-a", 1, "owed");
    changes.push(StateChangeV2::AddCondition {
        condition: ConditionInput {
            id: "debt".into(),
            entity_id: "p-a".into(),
            description: "尚欠约定款项".into(),
            category: ConditionCategory::Obligation,
            active: true,
        },
        event_id: "owed".into(),
    });
    let before = apply_output_v2(
        &encounter(),
        &output("owed", &["p-a", "key"], changes),
        &context(2),
    )
    .unwrap();
    let dead = apply_output_v2(
        &before,
        &output(
            "died",
            &["p-a"],
            vec![
                StateChangeV2::SetLifeStatus {
                    entity_id: "p-a".into(),
                    alive: false,
                    event_id: "died".into(),
                },
                StateChangeV2::RenameEntity {
                    entity_id: "p-a".into(),
                    expected_name: "王安".into(),
                    new_name: "王故人".into(),
                    event_id: "died".into(),
                },
            ],
        ),
        &context(3),
    )
    .unwrap();
    assert_eq!(dead.conditions, before.conditions);
    assert_eq!(holding(&dead, "key").holder_id.as_deref(), Some("p-a"));
    assert_eq!(
        apply_output_v2(
            &dead,
            &output(
                "revive",
                &["p-a"],
                vec![StateChangeV2::SetLifeStatus {
                    entity_id: "p-a".into(),
                    alive: true,
                    event_id: "revive".into()
                }]
            ),
            &context(4)
        ),
        Err(GameError::DeadCannotRevive)
    );
}

#[test]
fn death_rumor_keeps_person_alive_and_public_news_does_not_automatically_give_knowledge() {
    let before = encounter();
    let changes = vec![
        StateChangeV2::CreateClaim {
            claim: ClaimInput {
                id: "rumor-dead".into(),
                text: "传闻王安死了。".into(),
                entity_ids: vec!["p-b".into()],
                assessment: ClaimAssessment::Unverified,
                evidence_event_ids: vec!["rumor".into()],
            },
            event_id: "rumor".into(),
        },
        StateChangeV2::RecordKnowledge {
            actor_id: "player".into(),
            target_type: KnowledgeTarget::Claim,
            target_id: "rumor-dead".into(),
            certainty: Certainty::Certain,
            acquisition_mode: AcquisitionMode::Told,
            known_evidence_event_ids: vec!["rumor".into()],
            event_id: "rumor".into(),
        },
    ];
    let mut rumor = output("rumor", &["player", "p-b"], changes);
    rumor.events[0].disclosure = Disclosure::Public;
    let after = apply_output_v2(&before, &rumor, &context(2)).unwrap();
    assert_eq!(
        after.entities.iter().find(|e| e.id == "p-b").unwrap().alive,
        Some(true)
    );
    assert_eq!(after.knowledge.len(), 1);
    assert_eq!(after.knowledge[0].actor_id, "player");
    assert_eq!(after.knowledge[0].certainty, Certainty::Certain);
    let proven = apply_output_v2(
        &after,
        &output(
            "proof",
            &["p-b"],
            vec![StateChangeV2::AssessClaim {
                claim_id: "rumor-dead".into(),
                expected_assessment: ClaimAssessment::Unverified,
                assessment: ClaimAssessment::Refuted,
                evidence_event_ids: vec!["rumor".into(), "proof".into()],
                event_id: "proof".into(),
            }],
        ),
        &context(3),
    )
    .unwrap();
    assert_eq!(proven.knowledge, after.knowledge);
    assert_eq!(proven.claims[0].assessment, ClaimAssessment::Refuted);
    assert_eq!(proven.knowledge[0].known_evidence_event_ids, ["rumor"]);
}

#[test]
fn knowledge_requires_explicit_actor_acquisition_and_duplicate_or_stale_update_is_rejected() {
    let before = encounter();
    let record = StateChangeV2::RecordKnowledge {
        actor_id: "player".into(),
        target_type: KnowledgeTarget::Event,
        target_id: "meet".into(),
        certainty: Certainty::Certain,
        acquisition_mode: AcquisitionMode::Observed,
        known_evidence_event_ids: Vec::new(),
        event_id: "learn".into(),
    };
    assert_eq!(
        apply_output_v2(
            &before,
            &output("learn", &["p-a"], vec![record.clone()]),
            &context(2)
        ),
        Err(GameError::InvalidReference)
    );
    let after = apply_output_v2(
        &before,
        &output("learn", &["player"], vec![record.clone()]),
        &context(2),
    )
    .unwrap();
    let mut dup = record;
    if let StateChangeV2::RecordKnowledge { event_id, .. } = &mut dup {
        *event_id = "dup".into();
    }
    assert_eq!(
        apply_output_v2(&after, &output("dup", &["player"], vec![dup]), &context(3)),
        Err(GameError::Conflict)
    );
    let stale = StateChangeV2::UpdateKnowledge {
        actor_id: "player".into(),
        target_type: KnowledgeTarget::Event,
        target_id: "meet".into(),
        expected_certainty: Certainty::Reported,
        certainty: Certainty::Doubtful,
        acquisition_mode: AcquisitionMode::Told,
        known_evidence_event_ids: Vec::new(),
        event_id: "update".into(),
    };
    assert_eq!(
        apply_output_v2(
            &after,
            &output("update", &["player"], vec![stale]),
            &context(3)
        ),
        Err(GameError::Conflict)
    );
}

#[test]
fn references_sources_commit_identity_and_subject_association_are_not_fabricated() {
    let before = encounter();
    let change = StateChangeV2::SetLifeStatus {
        entity_id: "p-a".into(),
        alive: false,
        event_id: "meet".into(),
    };
    assert_eq!(
        apply_output_v2(
            &before,
            &output("new-event", &["p-a"], vec![change]),
            &context(2)
        ),
        Err(GameError::InvalidReference)
    );
    assert_eq!(
        apply_output_v2(
            &before,
            &output(
                "new-event",
                &["p-b"],
                vec![StateChangeV2::SetLifeStatus {
                    entity_id: "p-a".into(),
                    alive: false,
                    event_id: "new-event".into()
                }]
            ),
            &context(2)
        ),
        Err(GameError::InvalidReference)
    );
    assert_eq!(
        apply_output_v2(
            &before,
            &output("new-event", &["p-a"], Vec::new()),
            &context(1)
        ),
        Err(GameError::Conflict)
    );
    let mut forged = before.clone();
    forged.entities[0].name_source = StateSource::Turn {
        operation_id: "forged".into(),
        turn_id: "forged".into(),
        event_id: "meet".into(),
    };
    assert_eq!(validate_state_v2(&forged), Err(GameError::InvalidReference));
    let mut raw = serde_json::to_value(output(
        "new",
        &["player", "p-new"],
        vec![person("p-new", "某人", "new")],
    ))
    .unwrap();
    raw["stateChanges"][0]["entity"]["createdSource"] = json!({"type":"initial"});
    assert_eq!(
        parse_output_v2(&raw.to_string()),
        Err(GameError::InvalidOutput)
    );
}

#[test]
fn strict_decode_rejects_missing_nullable_unknown_fields_unknown_ops_and_future_protocol() {
    let good = output(
        "new",
        &["player"],
        vec![StateChangeV2::SetAttribute {
            entity_id: "player".into(),
            key: "职业".into(),
            value: "商旅".into(),
            expected_value: None,
            event_id: "new".into(),
        }],
    );
    let raw = serde_json::to_string(&good).unwrap();
    assert_eq!(
        parse_output_v2(&format!("```json\n{raw}\n```")),
        Ok(good.clone())
    );
    assert!(parse_output_v2(&format!("前言{raw}")).is_err());
    assert!(parse_output_v2(&format!("{raw}\n{raw}")).is_err());
    let mut missing = serde_json::to_value(&good).unwrap();
    missing["timeAdvance"]
        .as_object_mut()
        .unwrap()
        .remove("eventId");
    assert_eq!(
        parse_output_v2(&missing.to_string()),
        Err(GameError::InvalidOutput)
    );
    let mut missing = serde_json::to_value(&good).unwrap();
    missing["stateChanges"][0]
        .as_object_mut()
        .unwrap()
        .remove("expectedValue");
    assert_eq!(
        parse_output_v2(&missing.to_string()),
        Err(GameError::InvalidOutput)
    );
    let mut future = serde_json::to_value(&good).unwrap();
    future["protocolVersion"] = json!(99);
    assert_eq!(
        parse_output_v2(&future.to_string()),
        Err(GameError::InvalidProtocol)
    );
    let mut unknown = serde_json::to_value(&good).unwrap();
    unknown["sql"] = json!("UPDATE anything");
    assert_eq!(
        parse_output_v2(&unknown.to_string()),
        Err(GameError::InvalidOutput)
    );
    let mut unknown = serde_json::to_value(&good).unwrap();
    unknown["stateChanges"][0]["type"] = json!("execute_tool");
    assert_eq!(
        parse_output_v2(&unknown.to_string()),
        Err(GameError::InvalidOutput)
    );
    let mut null = serde_json::to_value(output(
        "key",
        &["key", "player"],
        item("key", "player", 1, "key"),
    ))
    .unwrap();
    null["stateChanges"][1]
        .as_object_mut()
        .unwrap()
        .remove("placeId");
    assert_eq!(
        parse_output_v2(&null.to_string()),
        Err(GameError::InvalidOutput)
    );
}

#[test]
fn safe_integer_time_and_resource_limits_and_negative_balances_are_enforced() {
    let mut before = initial();
    before.time.elapsed_seconds = MAX_ELAPSED_SECONDS;
    let mut advance = output("time", &["player"], Vec::new());
    advance.time_advance = TimeAdvanceV2 {
        elapsed_seconds: 1,
        event_id: Some("time".into()),
    };
    assert_eq!(
        apply_output_v2(&before, &advance, &context(1)),
        Err(GameError::InvalidTime)
    );
    let mut missing = advance;
    missing.time_advance.event_id = None;
    assert_eq!(
        apply_output_v2(&initial(), &missing, &context(1)),
        Err(GameError::InvalidTime)
    );
    for delta in [-101, MAX_RESOURCE_AMOUNT] {
        let change = StateChangeV2::ChangeResource {
            owner_id: "player".into(),
            key: "cash".into(),
            unit: "记账单位".into(),
            delta,
            expected_amount: Some(100),
            event_id: "cash".into(),
        };
        assert_eq!(
            apply_output_v2(
                &initial(),
                &output("cash", &["player"], vec![change]),
                &context(1)
            ),
            Err(GameError::InvalidResource)
        );
    }
    let mut illegal = initial();
    illegal.time.era_year = 0;
    assert_eq!(validate_state_v2(&illegal), Err(GameError::InvalidTime));
}

#[test]
fn duplicate_events_claims_and_invalid_entity_references_fail_before_a_commit() {
    let before = encounter();
    let mut duplicate = output("new", &["player"], Vec::new());
    duplicate.events.push(duplicate.events[0].clone());
    assert_eq!(
        apply_output_v2(&before, &duplicate, &context(2)),
        Err(GameError::InvalidEvent)
    );
    let unknown = output("unknown", &["missing"], Vec::new());
    assert_eq!(
        apply_output_v2(&before, &unknown, &context(2)),
        Err(GameError::InvalidEvent)
    );
    let claim = StateChangeV2::CreateClaim {
        claim: ClaimInput {
            id: "c".into(),
            text: "有人提出主张。".into(),
            entity_ids: vec!["p-a".into()],
            assessment: ClaimAssessment::Supported,
            evidence_event_ids: Vec::new(),
        },
        event_id: "claim".into(),
    };
    assert_eq!(
        apply_output_v2(
            &before,
            &output("claim", &["p-a"], vec![claim]),
            &context(2)
        ),
        Err(GameError::InvalidKnowledge)
    );
    let bad = StateChangeV2::ChangeRelationship {
        from_id: "player".into(),
        to_id: "missing".into(),
        kind: "朋友".into(),
        strength: 10,
        event_id: "relation".into(),
    };
    assert!(apply_output_v2(
        &before,
        &output("relation", &["player", "missing"], vec![bad]),
        &context(2)
    )
    .is_err());
}

#[test]
fn legacy_markers_are_not_model_operations_and_alias_limit_is_not_silently_truncated() {
    let mut out = output("legacy", &["player"], Vec::new());
    out.events[0].disclosure = Disclosure::LegacyUnspecified;
    assert_eq!(
        parse_output_v2(&serde_json::to_string(&out).unwrap()),
        Err(GameError::InvalidEvent)
    );
    let changes = (0..=MAX_ALIASES)
        .map(|n| StateChangeV2::AddAlias {
            entity_id: "player".into(),
            text: format!("称呼{n}"),
            kind: AliasKind::Nickname,
            event_id: "many".into(),
        })
        .collect();
    assert_eq!(
        apply_output_v2(
            &initial(),
            &output("many", &["player"], changes),
            &context(1)
        ),
        Err(GameError::InvalidEntity)
    );
    assert!(initial().entities[0].aliases.is_empty());
}

#[test]
fn legal_v1_new_reserved_attributes_remain_legacy_text_but_cannot_be_model_written() {
    for key in [
        "aliases",
        "CreatedSource",
        "nameSource",
        "lifeSource",
        "attributeSources",
    ] {
        let mut state = initial();
        state.entities[0]
            .attributes
            .insert(key.into(), "原版字符串🙂".into());
        state.entities[0].attribute_sources.insert(
            key.into(),
            StateSource::LegacySnapshot {
                turn_id: None,
                format_version: 1,
            },
        );
        validate_state_v2(&state).unwrap();
        let change = StateChangeV2::SetAttribute {
            entity_id: "player".into(),
            key: key.into(),
            value: "伪造来源".into(),
            expected_value: Some("原版字符串🙂".into()),
            event_id: "overwrite".into(),
        };
        assert_eq!(
            apply_output_v2(
                &state,
                &output("overwrite", &["player"], vec![change]),
                &context(1)
            ),
            Err(GameError::InvalidEntity)
        );
        let mut input = person("p-new", "新人物", "create");
        if let StateChangeV2::CreateEntity { entity, .. } = &mut input {
            entity.attributes.insert(key.into(), "伪造来源".into());
        }
        assert_eq!(
            apply_output_v2(
                &initial(),
                &output("create", &["p-new"], vec![input]),
                &context(1)
            ),
            Err(GameError::InvalidEntity)
        );
    }
    for key in ["name", "alive", "protocolVersion", "id"] {
        let mut illegal = initial();
        illegal.entities[0]
            .attributes
            .insert(key.into(), "旧版也非法".into());
        illegal.entities[0].attribute_sources.insert(
            key.into(),
            StateSource::LegacySnapshot {
                turn_id: None,
                format_version: 1,
            },
        );
        assert_eq!(validate_state_v2(&illegal), Err(GameError::InvalidEntity));
    }
}

#[test]
fn observation_sources_are_core_generated_and_require_explicit_actor_and_fact() {
    let before = encounter();
    let observe = StateChangeV2::ObserveFact {
        actor_id: "player".into(),
        fact_key: FactKey::EntityName {
            entity_id: "p-a".into(),
        },
        event_id: "learn-name".into(),
    };
    let after = apply_output_v2(
        &before,
        &output("learn-name", &["player", "p-a"], vec![observe.clone()]),
        &context(2),
    )
    .unwrap();
    assert_eq!(after.fact_observations.len(), 1);
    assert_eq!(
        after.fact_observations[0].fact_source,
        before
            .entities
            .iter()
            .find(|e| e.id == "p-a")
            .unwrap()
            .name_source
    );
    assert_eq!(
        after.fact_observations[0].acquisition_source,
        StateSource::Turn {
            operation_id: "op-2".into(),
            turn_id: "turn-2".into(),
            event_id: "learn-name".into()
        }
    );
    assert_eq!(
        apply_output_v2(
            &before,
            &output("learn-name", &["p-a"], vec![observe.clone()]),
            &context(2)
        ),
        Err(GameError::InvalidReference)
    );
    assert_eq!(
        apply_output_v2(
            &before,
            &output("learn-name", &["player"], vec![observe.clone()]),
            &context(2)
        ),
        Err(GameError::InvalidReference)
    );
    let mut forged =
        serde_json::to_value(output("learn-name", &["player", "p-a"], vec![observe])).unwrap();
    forged["stateChanges"][0]["factSource"] = json!({"type":"initial"});
    assert_eq!(
        parse_output_v2(&forged.to_string()),
        Err(GameError::InvalidOutput)
    );
    forged["stateChanges"][0]
        .as_object_mut()
        .unwrap()
        .remove("factSource");
    forged["stateChanges"][0]["factKey"]["wholeEntity"] = json!(true);
    assert_eq!(
        parse_output_v2(&forged.to_string()),
        Err(GameError::InvalidOutput)
    );
}

#[test]
fn observation_of_an_intermediate_value_does_not_leak_the_turns_hidden_final_value() {
    let before = encounter();
    let changes = vec![
        StateChangeV2::RenameEntity {
            entity_id: "p-a".into(),
            expected_name: "王安".into(),
            new_name: "王平".into(),
            event_id: "name-change".into(),
        },
        StateChangeV2::ObserveFact {
            actor_id: "player".into(),
            fact_key: FactKey::EntityName {
                entity_id: "p-a".into(),
            },
            event_id: "name-change".into(),
        },
        StateChangeV2::RenameEntity {
            entity_id: "p-a".into(),
            expected_name: "王平".into(),
            new_name: "秘密姓名".into(),
            event_id: "name-change".into(),
        },
    ];
    assert_eq!(
        apply_output_v2(
            &before,
            &output("name-change", &["player", "p-a"], changes),
            &context(2)
        ),
        Err(GameError::Conflict)
    );
    assert!(before.fact_observations.is_empty());
    assert_eq!(
        before.entities.iter().find(|e| e.id == "p-a").unwrap().name,
        "王安"
    );
}

#[test]
fn late_invalid_observation_rolls_back_payment_quantity_and_time() {
    let before = initial();
    let mut out = output(
        "settle",
        &["player", "travel-bag"],
        vec![
            StateChangeV2::ChangeResource {
                owner_id: "player".into(),
                key: "cash".into(),
                unit: "记账单位".into(),
                delta: -5,
                expected_amount: Some(100),
                event_id: "settle".into(),
            },
            StateChangeV2::ChangeItemQuantity {
                item_id: "travel-bag".into(),
                expected_holding: holding(&before, "travel-bag"),
                delta: -1,
                event_id: "settle".into(),
            },
            StateChangeV2::ObserveFact {
                actor_id: "player".into(),
                fact_key: FactKey::EntityLife {
                    entity_id: "travel-bag".into(),
                },
                event_id: "settle".into(),
            },
        ],
    );
    out.time_advance = TimeAdvanceV2 {
        elapsed_seconds: 60,
        event_id: Some("settle".into()),
    };
    assert_eq!(
        apply_output_v2(&before, &out, &context(1)),
        Err(GameError::InvalidReference)
    );
    assert_eq!(before, initial());
}
