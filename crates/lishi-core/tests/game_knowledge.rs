use std::collections::BTreeMap;

use lishi_core::game_knowledge::{
    active_conditions, actor_fact_view, entity_by_id, held_items, initial_visible_grants,
    knowledge_for_actor, legacy_player_visibility_grants, minimal_actor_fact_json,
    minimal_narrator_fact_json, observed_facts_for_actor, resolve_visible_name, source_for_fact,
    CommittedHistoryEntry, FactKey, KnownValue, LegacyKnowledgeHistoryBuilder,
    SourceVisibilityGrant, SourceVisibilityIndex, ValidatedHistory,
};
use lishi_core::game_protocol::{EntityKind, GameError, WorldSetup};
use lishi_core::game_protocol_v2::{
    apply_output_v2, initial_state_v2, AcquisitionMode, AliasKind, Certainty, ClaimAssessment,
    ClaimInput, CommitContext, ConditionCategory, ConditionInput, Disclosure, EntityInput,
    EventInput, KnowledgeTarget, StateChangeV2, StateSource, TimeAdvanceV2, TurnOutputV2,
    WorldStateV2,
};

fn initial() -> WorldStateV2 {
    initial_state_v2(&WorldSetup {
        world_id: "knowledge-test-world".into(),
        title: "知识隔离".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "李明".into(),
        narrative_style: "保留人物未知信息".into(),
    })
    .unwrap()
}

fn output(event_id: &str, entity_ids: &[&str], changes: Vec<StateChangeV2>) -> TurnOutputV2 {
    TurnOutputV2 {
        protocol_version: 2,
        narrative: "一段不包含私人数据的固定剧情。".into(),
        choices: Vec::new(),
        time_advance: TimeAdvanceV2 {
            elapsed_seconds: 0,
            event_id: None,
        },
        state_changes: changes,
        events: vec![EventInput {
            id: event_id.into(),
            description: "经过明确记录的事件。".into(),
            entity_ids: entity_ids.iter().map(|id| (*id).into()).collect(),
            disclosure: Disclosure::Restricted,
        }],
        source_references: Vec::new(),
        uncertainties: Vec::new(),
    }
}

fn append(initial: &WorldStateV2, entries: &mut Vec<CommittedHistoryEntry>, output: TurnOutputV2) {
    let number = entries.len() + 1;
    let operation_id = format!("op-{number}");
    let turn_id = format!("turn-{number}");
    let previous = entries.last().map_or(initial, |entry| &entry.state);
    let context = CommitContext {
        operation_id: operation_id.clone(),
        turn_id: turn_id.clone(),
    };
    let state = apply_output_v2(previous, &output, &context).unwrap();
    entries.push(CommittedHistoryEntry {
        operation_id,
        turn_id,
        parent_turn_id: entries.last().map(|entry| entry.turn_id.clone()),
        output,
        state,
    });
}

fn build_history(initial: &WorldStateV2, entries: &[CommittedHistoryEntry]) -> ValidatedHistory {
    ValidatedHistory::new(
        "knowledge-test-world",
        initial.clone(),
        entries.to_vec(),
        entries.last().map(|entry| entry.turn_id.as_str()),
    )
    .unwrap()
}

#[test]
fn narrative_sources_are_ordered_and_hashed_from_audited_commits() {
    use sha2::{Digest, Sha256};
    let initial = initial();
    let mut entries = Vec::new();
    append(
        &initial,
        &mut entries,
        output("source-event-1", &["player"], vec![]),
    );
    append(
        &initial,
        &mut entries,
        output("source-event-2", &["player"], vec![]),
    );
    let first = build_history(&initial, &entries[..1]);
    assert_eq!(first.visible_turn_ids(), vec!["turn-1"]);
    assert!(!first.contains_turn("turn-2"));
    assert_eq!(first.turn_position("turn-1"), Some(1));
    let expected = format!(
        "{:x}",
        Sha256::digest(entries[0].output.narrative.as_bytes())
    );
    assert_eq!(first.narrative_sha256("turn-1"), Some(expected.as_str()));
    assert_eq!(first.narrative_sha256("sibling-turn"), None);
    let mut extended = first;
    extended.append_v2_entry(entries[1].clone()).unwrap();
    assert_eq!(extended.visible_turn_ids(), vec!["turn-1", "turn-2"]);
    assert_eq!(extended.turn_position("turn-2"), Some(2));
    assert_eq!(extended.narrative_sha256("turn-1"), Some(expected.as_str()));
}

fn person(id: &str, name: &str) -> StateChangeV2 {
    StateChangeV2::CreateEntity {
        entity: EntityInput {
            id: id.into(),
            kind: EntityKind::Person,
            name: name.into(),
            alive: Some(true),
            attributes: BTreeMap::new(),
        },
        event_id: "meet".into(),
    }
}

fn encounter() -> (WorldStateV2, Vec<CommittedHistoryEntry>) {
    let initial = initial();
    let mut entries = Vec::new();
    append(
        &initial,
        &mut entries,
        output(
            "meet",
            &["player", "p-a", "p-b", "witness"],
            vec![
                person("p-a", "王安"),
                person("p-b", "王安"),
                person("witness", "李四"),
            ],
        ),
    );
    (initial, entries)
}

fn grant(actor: &str, fact: FactKey, source: StateSource) -> SourceVisibilityGrant {
    SourceVisibilityGrant {
        actor_id: actor.into(),
        fact,
        source,
    }
}

fn initial_people_grants(entries: &[CommittedHistoryEntry]) -> Vec<SourceVisibilityGrant> {
    ["p-a", "p-b"]
        .iter()
        .flat_map(|id| {
            let entity = entries[0]
                .state
                .entities
                .iter()
                .find(|entity| &entity.id == id)
                .unwrap();
            [
                grant(
                    "player",
                    FactKey::EntityName {
                        entity_id: (*id).into(),
                    },
                    entity.name_source.clone(),
                ),
                grant(
                    "player",
                    FactKey::EntityLife {
                        entity_id: (*id).into(),
                    },
                    entity.life_source.clone(),
                ),
            ]
        })
        .collect()
}

#[test]
fn name_collisions_return_all_candidates_and_do_not_give_unknown_actor_global_names() {
    let (initial, entries) = encounter();
    let history = build_history(&initial, &entries);
    let visibility = SourceVisibilityIndex::new(&history, initial_people_grants(&entries)).unwrap();
    let matches = resolve_visible_name(&history, &visibility, "player", "  王安  ").unwrap();
    assert_eq!(
        matches
            .iter()
            .map(|candidate| candidate.entity_id.as_str())
            .collect::<Vec<_>>(),
        ["p-a", "p-b"]
    );
    assert!(
        resolve_visible_name(&history, &visibility, "witness", "王安")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        actor_fact_view(&history, &visibility, "witness", "p-a")
            .unwrap()
            .name,
        KnownValue::Unknown
    );
    assert_eq!(
        resolve_visible_name(&history, &visibility, "player", "王 安")
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        resolve_visible_name(&history, &visibility, "player", "\n").unwrap_err(),
        GameError::InvalidEntity
    );
}

#[test]
fn secret_rename_death_and_attribute_keep_previous_known_values() {
    let (initial, mut entries) = encounter();
    let mut grants = initial_people_grants(&entries);
    append(
        &initial,
        &mut entries,
        output(
            "secret",
            &["p-a", "p-b"],
            vec![
                StateChangeV2::RenameEntity {
                    entity_id: "p-a".into(),
                    expected_name: "王安".into(),
                    new_name: "王平".into(),
                    event_id: "secret".into(),
                },
                StateChangeV2::SetLifeStatus {
                    entity_id: "p-b".into(),
                    alive: false,
                    event_id: "secret".into(),
                },
                StateChangeV2::AddAlias {
                    entity_id: "p-a".into(),
                    text: "密使".into(),
                    kind: AliasKind::Title,
                    event_id: "secret".into(),
                },
                StateChangeV2::SetAttribute {
                    entity_id: "p-a".into(),
                    key: "密令".into(),
                    value: "隐藏地点".into(),
                    expected_value: None,
                    event_id: "secret".into(),
                },
            ],
        ),
    );
    let history = build_history(&initial, &entries);
    let visibility = SourceVisibilityIndex::new(&history, grants.clone()).unwrap();
    assert_eq!(
        actor_fact_view(&history, &visibility, "player", "p-a")
            .unwrap()
            .name
            .value()
            .unwrap(),
        "王安"
    );
    assert_eq!(
        actor_fact_view(&history, &visibility, "player", "p-b")
            .unwrap()
            .alive
            .value(),
        Some(&true)
    );
    assert!(actor_fact_view(&history, &visibility, "player", "p-a")
        .unwrap()
        .attributes
        .is_empty());
    assert!(
        resolve_visible_name(&history, &visibility, "player", "王平")
            .unwrap()
            .is_empty()
    );
    assert!(
        resolve_visible_name(&history, &visibility, "player", "密使")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        resolve_visible_name(&history, &visibility, "player", "王安")
            .unwrap()
            .len(),
        2
    );
    let source = entries[1]
        .state
        .entities
        .iter()
        .find(|entity| entity.id == "p-a")
        .unwrap()
        .name_source
        .clone();
    grants.push(grant(
        "player",
        FactKey::EntityName {
            entity_id: "p-a".into(),
        },
        source.clone(),
    ));
    grants.push(grant(
        "player",
        FactKey::EntityAlias {
            entity_id: "p-a".into(),
            text: "王安".into(),
        },
        source.clone(),
    ));
    grants.push(grant(
        "player",
        FactKey::EntityAlias {
            entity_id: "p-a".into(),
            text: "密使".into(),
        },
        source,
    ));
    let visible = SourceVisibilityIndex::new(&history, grants).unwrap();
    assert_eq!(
        resolve_visible_name(&history, &visible, "player", "王平").unwrap()[0].entity_id,
        "p-a"
    );
    assert_eq!(
        resolve_visible_name(&history, &visible, "player", "王安")
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        resolve_visible_name(&history, &visible, "player", "密使").unwrap()[0].display_name,
        "王平"
    );
    assert!(resolve_visible_name(&history, &visible, "witness", "密使")
        .unwrap()
        .is_empty());
}

#[test]
fn explicit_visible_sources_return_latest_known_attribute_not_current_hidden_value() {
    let (initial, mut entries) = encounter();
    append(
        &initial,
        &mut entries,
        output(
            "known-address",
            &["p-a"],
            vec![StateChangeV2::SetAttribute {
                entity_id: "p-a".into(),
                key: "住处".into(),
                value: "东市".into(),
                expected_value: None,
                event_id: "known-address".into(),
            }],
        ),
    );
    let source = entries[1]
        .state
        .entities
        .iter()
        .find(|entity| entity.id == "p-a")
        .unwrap()
        .attribute_sources["住处"]
        .clone();
    append(
        &initial,
        &mut entries,
        output(
            "hidden-address",
            &["p-a"],
            vec![StateChangeV2::SetAttribute {
                entity_id: "p-a".into(),
                key: "住处".into(),
                value: "西市".into(),
                expected_value: Some("东市".into()),
                event_id: "hidden-address".into(),
            }],
        ),
    );
    let history = build_history(&initial, &entries);
    let visibility = SourceVisibilityIndex::new(
        &history,
        vec![grant(
            "player",
            FactKey::EntityAttribute {
                entity_id: "p-a".into(),
                key: "住处".into(),
            },
            source,
        )],
    )
    .unwrap();
    let view = actor_fact_view(&history, &visibility, "player", "p-a").unwrap();
    assert_eq!(view.attributes["住处"].value().unwrap(), "东市");
    assert_eq!(view.name, KnownValue::Unknown);
    let json = minimal_actor_fact_json(&history, &visibility, "player", 8192).unwrap();
    assert!(json.contains("东市"));
    assert!(!json.contains("西市"));
    assert!(!json.contains("王安"));
}

#[test]
fn claim_global_assessment_and_new_evidence_do_not_refresh_actor_belief() {
    let (initial, mut entries) = encounter();
    append(
        &initial,
        &mut entries,
        output(
            "rumor",
            &["player", "p-b"],
            vec![
                StateChangeV2::CreateClaim {
                    claim: ClaimInput {
                        id: "death-rumor".into(),
                        text: "听说王安已死。".into(),
                        entity_ids: vec!["p-b".into()],
                        assessment: ClaimAssessment::Unverified,
                        evidence_event_ids: vec!["rumor".into()],
                    },
                    event_id: "rumor".into(),
                },
                StateChangeV2::RecordKnowledge {
                    actor_id: "player".into(),
                    target_type: KnowledgeTarget::Claim,
                    target_id: "death-rumor".into(),
                    certainty: Certainty::Certain,
                    acquisition_mode: AcquisitionMode::Told,
                    known_evidence_event_ids: vec!["rumor".into()],
                    event_id: "rumor".into(),
                },
                StateChangeV2::ObserveFact {
                    actor_id: "player".into(),
                    fact_key: FactKey::Claim {
                        claim_id: "death-rumor".into(),
                    },
                    event_id: "rumor".into(),
                },
            ],
        ),
    );
    let known_before = knowledge_for_actor(&build_history(&initial, &entries), "player").unwrap();
    append(
        &initial,
        &mut entries,
        output(
            "alive-proof",
            &["p-b"],
            vec![StateChangeV2::AssessClaim {
                claim_id: "death-rumor".into(),
                expected_assessment: ClaimAssessment::Unverified,
                assessment: ClaimAssessment::Refuted,
                evidence_event_ids: vec!["rumor".into(), "alive-proof".into()],
                event_id: "alive-proof".into(),
            }],
        ),
    );
    let history = build_history(&initial, &entries);
    let known = knowledge_for_actor(&history, "player").unwrap();
    assert_eq!(known, known_before);
    assert_eq!(known[0].certainty, Certainty::Certain);
    assert_eq!(known[0].known_evidence_event_ids, ["rumor"]);
    assert!(knowledge_for_actor(&history, "witness").unwrap().is_empty());
    let json = serde_json::to_string(&known).unwrap();
    assert!(!json.contains("assessment"));
    assert!(!json.contains("refuted"));
    assert!(!json.contains("alive-proof"));
    let visibility =
        SourceVisibilityIndex::from_recorded_observations(&history, Vec::new()).unwrap();
    let actor_facts = observed_facts_for_actor(&history, &visibility, "player").unwrap();
    assert_eq!(actor_facts[0].value["assessment"], "unverified");
    assert_eq!(
        actor_facts[0].value["evidenceEventIds"],
        serde_json::json!(["rumor"])
    );
    let actor_json = minimal_actor_fact_json(&history, &visibility, "player", 16384).unwrap();
    assert!(!actor_json.contains("refuted"));
    assert!(!actor_json.contains("alive-proof"));
    assert_eq!(
        entity_by_id(history.current_state(), "p-b")
            .unwrap()
            .unwrap()
            .alive,
        Some(true)
    );
    append(
        &initial,
        &mut entries,
        output(
            "tell-proof",
            &["player", "p-b"],
            vec![StateChangeV2::UpdateKnowledge {
                actor_id: "player".into(),
                target_type: KnowledgeTarget::Claim,
                target_id: "death-rumor".into(),
                expected_certainty: Certainty::Certain,
                certainty: Certainty::Doubtful,
                acquisition_mode: AcquisitionMode::Told,
                known_evidence_event_ids: vec!["alive-proof".into()],
                event_id: "tell-proof".into(),
            }],
        ),
    );
    let changed = knowledge_for_actor(&build_history(&initial, &entries), "player").unwrap();
    assert_eq!(changed[0].certainty, Certainty::Doubtful);
    assert_eq!(changed[0].known_evidence_event_ids, ["alive-proof"]);
}

#[test]
fn public_event_is_not_automatic_knowledge_or_initial_omniscience() {
    let initial = initial();
    let mut entries = Vec::new();
    let mut public = output("public-news", &["player"], Vec::new());
    public.events[0].disclosure = Disclosure::Public;
    append(&initial, &mut entries, public);
    let history = build_history(&initial, &entries);
    let empty = SourceVisibilityIndex::new(&history, Vec::new()).unwrap();
    assert!(knowledge_for_actor(&history, "player").unwrap().is_empty());
    assert_eq!(
        actor_fact_view(&history, &empty, "player", "player")
            .unwrap()
            .alive,
        KnownValue::Unknown
    );
    let visible = SourceVisibilityIndex::new(
        &history,
        vec![grant(
            "player",
            FactKey::EntityName {
                entity_id: "player".into(),
            },
            StateSource::Initial,
        )],
    )
    .unwrap();
    assert_eq!(
        actor_fact_view(&history, &visible, "player", "player")
            .unwrap()
            .name
            .value()
            .unwrap(),
        "李明"
    );
    assert_eq!(
        actor_fact_view(&history, &visible, "player", "player")
            .unwrap()
            .alive,
        KnownValue::Unknown
    );
}

#[test]
fn formal_inventory_conditions_and_fact_provenance_are_read_only() {
    let (initial, mut entries) = encounter();
    append(
        &initial,
        &mut entries,
        output(
            "injury",
            &["p-a"],
            vec![StateChangeV2::AddCondition {
                condition: ConditionInput {
                    id: "injury-a".into(),
                    entity_id: "p-a".into(),
                    description: "扭伤".into(),
                    category: ConditionCategory::Injury,
                    active: true,
                },
                event_id: "injury".into(),
            }],
        ),
    );
    let history = build_history(&initial, &entries);
    let state = history.current_state();
    let before = state.clone();
    assert_eq!(held_items(state, "player").unwrap().len(), 1);
    assert!(held_items(state, "p-a").unwrap().is_empty());
    assert_eq!(active_conditions(state, "p-a").unwrap()[0].id, "injury-a");
    assert!(active_conditions(state, "p-b").unwrap().is_empty());
    assert_eq!(
        source_for_fact(
            state,
            &FactKey::Condition {
                condition_id: "injury-a".into()
            }
        )
        .unwrap(),
        Some(&StateSource::Turn {
            operation_id: "op-2".into(),
            turn_id: "turn-2".into(),
            event_id: "injury".into()
        })
    );
    assert_eq!(
        source_for_fact(
            state,
            &FactKey::EntityName {
                entity_id: "not-here".into()
            }
        )
        .unwrap(),
        None
    );
    assert!(entity_by_id(state, "not-here").unwrap().is_none());
    assert!(held_items(state, "start-place").is_err());
    assert!(active_conditions(state, "not-here").is_err());
    assert_eq!(state, &before);
}

#[test]
fn forged_or_incomplete_history_and_invalid_grants_are_rejected() {
    let (initial, mut entries) = encounter();
    append(
        &initial,
        &mut entries,
        output("later", &["player"], Vec::new()),
    );
    let mut forged = entries.clone();
    forged[0]
        .state
        .entities
        .iter_mut()
        .find(|entity| entity.id == "p-a")
        .unwrap()
        .name = "伪造值".into();
    assert!(ValidatedHistory::new(
        "knowledge-test-world",
        initial.clone(),
        forged,
        Some("turn-2")
    )
    .is_err());
    assert!(ValidatedHistory::new(
        "knowledge-test-world",
        initial.clone(),
        entries[1..].to_vec(),
        Some("turn-2")
    )
    .is_err());
    assert!(ValidatedHistory::new(
        "knowledge-test-world",
        initial.clone(),
        entries[..1].to_vec(),
        Some("turn-2")
    )
    .is_err());
    assert!(ValidatedHistory::new(
        "knowledge-test-world",
        entries[0].state.clone(),
        Vec::new(),
        None
    )
    .is_err());
    let history = build_history(&initial, &entries);
    assert!(SourceVisibilityIndex::new(
        &history,
        vec![grant("unknown", FactKey::Time, StateSource::Initial)]
    )
    .is_err());
    assert!(SourceVisibilityIndex::new(
        &history,
        vec![grant(
            "player",
            FactKey::EntityName {
                entity_id: "p-a".into()
            },
            StateSource::Initial
        )]
    )
    .is_err());
    assert!(SourceVisibilityIndex::new(
        &history,
        vec![grant(
            "player",
            FactKey::EntityName {
                entity_id: "p-a".into()
            },
            StateSource::Turn {
                operation_id: "fake".into(),
                turn_id: "fake".into(),
                event_id: "meet".into()
            }
        )]
    )
    .is_err());
    let index = SourceVisibilityIndex::new(&history, Vec::new()).unwrap();
    assert!(actor_fact_view(&history, &index, "unknown", "p-a").is_err());
    assert!(knowledge_for_actor(&history, "unknown").is_err());
    assert!(knowledge_for_actor(&history, "start-place").is_err());
}

#[test]
fn visibility_index_is_bound_to_complete_history_not_only_head_and_current_state() {
    let (initial, mut entries) = encounter();
    append(
        &initial,
        &mut entries,
        output("later", &["player"], Vec::new()),
    );
    let history = build_history(&initial, &entries);
    let index = SourceVisibilityIndex::new(&history, initial_people_grants(&entries)).unwrap();
    let mut altered = entries.clone();
    altered[0].output.narrative = "不同的已提交正文。".into();
    let other = build_history(&initial, &altered);
    assert_eq!(history.current_state(), other.current_state());
    assert_eq!(history.head_turn_id(), other.head_turn_id());
    assert_eq!(
        actor_fact_view(&other, &index, "player", "p-a"),
        Err(GameError::Conflict)
    );
}

#[test]
fn visibility_from_an_identical_other_world_is_rejected() {
    let (initial, entries) = encounter();
    let history = build_history(&initial, &entries);
    let index = SourceVisibilityIndex::new(&history, initial_people_grants(&entries)).unwrap();
    let other = ValidatedHistory::new(
        "different-world",
        initial.clone(),
        entries.clone(),
        Some("turn-1"),
    )
    .unwrap();
    assert_eq!(history.current_state(), other.current_state());
    assert_eq!(history.world_id(), "knowledge-test-world");
    assert_eq!(
        actor_fact_view(&other, &index, "player", "p-a"),
        Err(GameError::Conflict)
    );
    for id in ["short", "../world-name", "world 名称"] {
        assert!(
            ValidatedHistory::new(id, initial.clone(), entries.clone(), Some("turn-1")).is_err()
        );
    }
}

#[test]
fn compact_character_json_keeps_unicode_and_enforces_exact_byte_limit_without_sources() {
    let (initial, entries) = encounter();
    let history = build_history(&initial, &entries);
    let index = SourceVisibilityIndex::new(&history, initial_people_grants(&entries)).unwrap();
    let json = minimal_actor_fact_json(&history, &index, "player", 8192).unwrap();
    assert!(json.contains("王安"));
    assert!(!json.contains("李四"));
    assert!(!json.contains("operation_id"));
    assert!(!json.contains("source"));
    assert_eq!(
        minimal_actor_fact_json(&history, &index, "player", json.len()).unwrap(),
        json
    );
    assert_eq!(
        minimal_actor_fact_json(&history, &index, "player", json.len() - 1),
        Err(GameError::TooLarge)
    );
    assert_eq!(
        minimal_actor_fact_json(&history, &index, "player", 0),
        Err(GameError::TooLarge)
    );
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["entities"].as_array().unwrap().len(), 2);
}

#[test]
fn formal_observation_rebuilds_after_replay_without_learning_sibling_facts_or_hidden_rename() {
    let (initial, mut entries) = encounter();
    append(
        &initial,
        &mut entries,
        output(
            "learn",
            &["player", "p-a"],
            vec![StateChangeV2::ObserveFact {
                actor_id: "player".into(),
                fact_key: FactKey::EntityName {
                    entity_id: "p-a".into(),
                },
                event_id: "learn".into(),
            }],
        ),
    );
    append(
        &initial,
        &mut entries,
        output(
            "hidden",
            &["p-a"],
            vec![StateChangeV2::RenameEntity {
                entity_id: "p-a".into(),
                expected_name: "王安".into(),
                new_name: "秘密姓名".into(),
                event_id: "hidden".into(),
            }],
        ),
    );
    let history = build_history(&initial, &entries);
    let rebuilt = SourceVisibilityIndex::from_recorded_observations(&history, Vec::new()).unwrap();
    let view = actor_fact_view(&history, &rebuilt, "player", "p-a").unwrap();
    assert_eq!(view.name.value().map(String::as_str), Some("王安"));
    assert_eq!(view.alive, KnownValue::Unknown);
    assert!(
        resolve_visible_name(&history, &rebuilt, "player", "秘密姓名")
            .unwrap()
            .is_empty()
    );
    assert!(resolve_visible_name(&history, &rebuilt, "player", "王安")
        .unwrap()
        .iter()
        .all(|candidate| candidate.entity_id == "p-a"));
    assert!(observed_facts_for_actor(&history, &rebuilt, "witness")
        .unwrap()
        .is_empty());
    let json = minimal_actor_fact_json(&history, &rebuilt, "player", 16384).unwrap();
    assert!(!json.contains("秘密姓名"));
    append(
        &initial,
        &mut entries,
        output(
            "reveal",
            &["player", "p-a"],
            vec![StateChangeV2::ObserveFact {
                actor_id: "player".into(),
                fact_key: FactKey::EntityName {
                    entity_id: "p-a".into(),
                },
                event_id: "reveal".into(),
            }],
        ),
    );
    let history = build_history(&initial, &entries);
    let visible = SourceVisibilityIndex::from_recorded_observations(&history, Vec::new()).unwrap();
    assert_eq!(
        actor_fact_view(&history, &visible, "player", "p-a")
            .unwrap()
            .name
            .value()
            .map(String::as_str),
        Some("秘密姓名")
    );
    assert_eq!(history.current_state().fact_observations.len(), 1);
    assert!(SourceVisibilityIndex::from_recorded_observations(
        &history,
        initial_people_grants(&entries)
    )
    .is_err());
}

#[test]
fn formal_inventory_observation_keeps_previous_quantity_after_a_hidden_transfer() {
    let (initial, mut entries) = encounter();
    append(
        &initial,
        &mut entries,
        output(
            "learn-bag",
            &["player", "travel-bag"],
            vec![StateChangeV2::ObserveFact {
                actor_id: "player".into(),
                fact_key: FactKey::ItemHolding {
                    item_id: "travel-bag".into(),
                },
                event_id: "learn-bag".into(),
            }],
        ),
    );
    let holding = entries.last().unwrap().state.item_holdings[0].value.clone();
    append(
        &initial,
        &mut entries,
        output(
            "hidden-bag",
            &["player", "p-a", "travel-bag"],
            vec![StateChangeV2::SetItemHolding {
                item_id: "travel-bag".into(),
                expected_holding: Some(holding),
                holder_id: Some("p-a".into()),
                place_id: None,
                quantity: 1,
                unit: "件".into(),
                event_id: "hidden-bag".into(),
            }],
        ),
    );
    let history = build_history(&initial, &entries);
    let visibility =
        SourceVisibilityIndex::from_recorded_observations(&history, Vec::new()).unwrap();
    let known = observed_facts_for_actor(&history, &visibility, "player").unwrap();
    assert_eq!(known.len(), 1);
    assert_eq!(known[0].value["holderId"], "player");
    assert_eq!(held_items(history.current_state(), "p-a").unwrap().len(), 1);
    assert!(
        minimal_actor_fact_json(&history, &visibility, "player", 16384)
            .unwrap()
            .contains("observedFacts")
    );
}

#[test]
fn a_formally_learned_new_name_keeps_the_actors_previously_known_name_recallable() {
    let (initial, mut entries) = encounter();
    append(
        &initial,
        &mut entries,
        output(
            "learn-old-name",
            &["player", "p-a"],
            vec![StateChangeV2::ObserveFact {
                actor_id: "player".into(),
                fact_key: FactKey::EntityName {
                    entity_id: "p-a".into(),
                },
                event_id: "learn-old-name".into(),
            }],
        ),
    );
    append(
        &initial,
        &mut entries,
        output(
            "rename-revealed",
            &["player", "p-a"],
            vec![
                StateChangeV2::RenameEntity {
                    entity_id: "p-a".into(),
                    expected_name: "王安".into(),
                    new_name: "王平".into(),
                    event_id: "rename-revealed".into(),
                },
                StateChangeV2::ObserveFact {
                    actor_id: "player".into(),
                    fact_key: FactKey::EntityName {
                        entity_id: "p-a".into(),
                    },
                    event_id: "rename-revealed".into(),
                },
            ],
        ),
    );
    let history = build_history(&initial, &entries);
    let visibility =
        SourceVisibilityIndex::from_recorded_observations(&history, Vec::new()).unwrap();
    assert_eq!(
        actor_fact_view(&history, &visibility, "player", "p-a")
            .unwrap()
            .name
            .value()
            .map(String::as_str),
        Some("王平")
    );
    assert_eq!(
        resolve_visible_name(&history, &visibility, "player", "王安").unwrap()[0].entity_id,
        "p-a"
    );
    assert_eq!(
        resolve_visible_name(&history, &visibility, "player", "王平").unwrap()[0].entity_id,
        "p-a"
    );
    assert!(
        resolve_visible_name(&history, &visibility, "witness", "王安")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn controlled_initial_grants_do_not_reveal_new_v2_facts_or_broadcast_to_npcs() {
    let (initial, mut entries) = encounter();
    append(
        &initial,
        &mut entries,
        output(
            "hidden-cash",
            &["player"],
            vec![StateChangeV2::ChangeResource {
                owner_id: "player".into(),
                key: "cash".into(),
                unit: "记账单位".into(),
                delta: 12,
                expected_amount: Some(100),
                event_id: "hidden-cash".into(),
            }],
        ),
    );
    let history = build_history(&initial, &entries);
    let grants = initial_visible_grants(&history, "player").unwrap();
    assert!(grants
        .iter()
        .all(|grant| !matches!(grant.source, StateSource::Turn { .. })));
    let visibility = SourceVisibilityIndex::from_recorded_observations(&history, grants).unwrap();
    let facts = observed_facts_for_actor(&history, &visibility, "player").unwrap();
    let cash = facts
        .iter()
        .find(|fact| matches!(fact.fact_key,FactKey::Resource { ref key,..} if key=="cash"))
        .unwrap();
    assert_eq!(cash.value["amount"], 100);
    assert_eq!(history.current_state().resources[0].amount, 112);
    assert!(
        resolve_visible_name(&history, &visibility, "player", "王安")
            .unwrap()
            .is_empty()
    );
    assert!(initial_visible_grants(&history, "witness")
        .unwrap()
        .is_empty());
    assert_eq!(
        legacy_player_visibility_grants(&history).unwrap(),
        initial_visible_grants(&history, "player").unwrap()
    );
}

#[test]
fn narrator_required_facts_keep_all_values_and_fail_the_exact_utf8_budget() {
    let (initial, mut entries) = encounter();
    append(
        &initial,
        &mut entries,
        output(
            "secret",
            &["p-a"],
            vec![StateChangeV2::SetAttribute {
                entity_id: "p-a".into(),
                key: "暗号".into(),
                value: "秘密钥匙🔑🙂".into(),
                expected_value: None,
                event_id: "secret".into(),
            }],
        ),
    );
    let history = build_history(&initial, &entries);
    let json = minimal_narrator_fact_json(&history, 65536).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["worldId"], "knowledge-test-world");
    assert_eq!(parsed["headTurnId"], "turn-2");
    assert!(json.contains("秘密钥匙🔑🙂"));
    assert!(json.contains("item_holding"));
    assert!(json.contains("记账单位"));
    assert!(json.contains("100"));
    assert!(!json.contains("createdSource"));
    assert_eq!(
        minimal_narrator_fact_json(&history, json.len()).unwrap(),
        json
    );
    assert_eq!(
        minimal_narrator_fact_json(&history, json.len() - 1),
        Err(GameError::TooLarge)
    );
    let visible = SourceVisibilityIndex::from_recorded_observations(&history, Vec::new()).unwrap();
    assert!(
        !minimal_actor_fact_json(&history, &visible, "player", 65536)
            .unwrap()
            .contains("秘密钥匙")
    );
}

#[test]
fn legacy_raw_history_replay_supports_previous_known_value_and_binds_exact_content() {
    use lishi_core::game_archive::{LegacyTurn, LegacyWorldHeader};
    use lishi_core::game_protocol as v1;
    use lishi_core::game_store::GameActionKind;
    let setup = WorldSetup {
        world_id: "legacy-knowledge-world".into(),
        title: "兼容知识夹具".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "李明".into(),
        narrative_style: "保留正式历史".into(),
    };
    let before = v1::initial_state(&setup).unwrap();
    let mut current = before.clone();
    let mut rows = Vec::new();
    for (index, address) in ["东市", "隐藏的西市"].into_iter().enumerate() {
        let output = v1::TurnOutput {
            protocol_version: 1,
            narrative: format!("固定第{}回合🙂", index + 1),
            choices: Vec::new(),
            time_advance: v1::TimeAdvance { elapsed_seconds: 1 },
            state_changes: vec![
                v1::StateChange::SetAttribute {
                    entity_id: "player".into(),
                    key: "住址".into(),
                    value: address.into(),
                    expected_value: if index == 0 {
                        None
                    } else {
                        Some("东市".into())
                    },
                },
                v1::StateChange::ChangeResource {
                    owner_id: "player".into(),
                    key: "cash".into(),
                    unit: "记账单位".into(),
                    delta: if index == 0 { 5 } else { 7 },
                    expected_amount: Some(if index == 0 { 100 } else { 105 }),
                },
            ],
            events: Vec::new(),
            source_references: Vec::new(),
            uncertainties: Vec::new(),
        };
        current = v1::apply_output(&current, &output).unwrap();
        rows.push(LegacyTurn {
            turn_id: format!("legacy-turn-{}", index + 1),
            parent_turn_id: if index == 0 {
                None
            } else {
                Some("legacy-turn-1".into())
            },
            sequence: index as u64 + 1,
            action_kind: GameActionKind::Action,
            action_text: "核对地址".into(),
            narrative: output.narrative.clone(),
            choices_json: "[]".into(),
            state_json: serde_json::to_string(&current).unwrap(),
            output_json: serde_json::to_string(&output).unwrap(),
            created_at_ms: index as i64,
        });
    }
    let header = LegacyWorldHeader {
        world_id: setup.world_id.clone(),
        setup_json: serde_json::to_string(&setup).unwrap(),
        initial_state_json: serde_json::to_string(&before).unwrap(),
        current_state_json: serde_json::to_string(&current).unwrap(),
        opening_narrative: "到达咸阳".into(),
        opening_choices_json: "[]".into(),
        narrative_policy: String::new(),
        head_turn_id: Some("legacy-turn-2".into()),
        turn_count: 2,
        created_at_ms: 0,
    };
    let build = |rows: &[LegacyTurn]| {
        let mut builder = LegacyKnowledgeHistoryBuilder::from_header(&header).unwrap();
        for row in rows {
            builder.push_turn(row).unwrap();
        }
        builder.finish().unwrap()
    };
    let history = build(&rows);
    assert_eq!(history.turn_count(), 2);
    let legacy_visible = SourceVisibilityIndex::from_recorded_observations(
        &history,
        legacy_player_visibility_grants(&history).unwrap(),
    )
    .unwrap();
    let known_cash = observed_facts_for_actor(&history, &legacy_visible, "player").unwrap();
    assert_eq!(
        known_cash
            .iter()
            .find(|fact| matches!(fact.fact_key,FactKey::Resource {ref key,..} if key=="cash"))
            .unwrap()
            .value["amount"],
        112
    );
    assert!(
        !minimal_actor_fact_json(&history, &legacy_visible, "player", 16384)
            .unwrap()
            .contains("隐藏的西市")
    );
    let visibility = SourceVisibilityIndex::new(
        &history,
        vec![grant(
            "player",
            FactKey::EntityAttribute {
                entity_id: "player".into(),
                key: "住址".into(),
            },
            StateSource::LegacySnapshot {
                turn_id: Some("legacy-turn-1".into()),
                format_version: 1,
            },
        )],
    )
    .unwrap();
    let view = actor_fact_view(&history, &visibility, "player", "player").unwrap();
    assert_eq!(
        view.attributes["住址"].value().map(String::as_str),
        Some("东市")
    );
    assert!(
        !minimal_actor_fact_json(&history, &visibility, "player", 16384)
            .unwrap()
            .contains("隐藏的西市")
    );
    assert!(history.current_state().fact_observations.is_empty());
    let mut changed = rows.clone();
    changed[0].state_json = serde_json::to_string_pretty(
        &serde_json::from_str::<v1::WorldState>(&changed[0].state_json).unwrap(),
    )
    .unwrap();
    let other = build(&changed);
    assert_eq!(history.current_state(), other.current_state());
    assert_eq!(
        actor_fact_view(&other, &visibility, "player", "player"),
        Err(GameError::Conflict)
    );
    let mut incomplete = LegacyKnowledgeHistoryBuilder::from_header(&header).unwrap();
    incomplete.push_turn(&rows[0]).unwrap();
    assert!(incomplete.finish().is_err());
    // A legacy prefix can continue with a v2 turn without rewriting its old
    // JSON or dropping a previously visible value.
    let mut mixed = history.clone();
    let out = output(
        "learn-current-address",
        &["player"],
        vec![
            StateChangeV2::ChangeResource {
                owner_id: "player".into(),
                key: "cash".into(),
                unit: "记账单位".into(),
                delta: -5,
                expected_amount: Some(112),
                event_id: "learn-current-address".into(),
            },
            StateChangeV2::ObserveFact {
                actor_id: "player".into(),
                fact_key: FactKey::EntityAttribute {
                    entity_id: "player".into(),
                    key: "住址".into(),
                },
                event_id: "learn-current-address".into(),
            },
        ],
    );
    let context = CommitContext {
        operation_id: "new-operation".into(),
        turn_id: "new-v2-turn".into(),
    };
    let state = apply_output_v2(mixed.current_state(), &out, &context).unwrap();
    let entry = CommittedHistoryEntry {
        operation_id: context.operation_id,
        turn_id: context.turn_id,
        parent_turn_id: Some("legacy-turn-2".into()),
        output: out,
        state,
    };
    mixed.append_v2_entry(entry.clone()).unwrap();
    assert_eq!(mixed.turn_count(), 3);
    let new_index = SourceVisibilityIndex::from_recorded_observations(&mixed, Vec::new()).unwrap();
    let compat_visible = SourceVisibilityIndex::from_recorded_observations(
        &mixed,
        legacy_player_visibility_grants(&mixed).unwrap(),
    )
    .unwrap();
    let known_cash = observed_facts_for_actor(&mixed, &compat_visible, "player").unwrap();
    assert_eq!(
        known_cash
            .iter()
            .find(|fact| matches!(fact.fact_key,FactKey::Resource {ref key,..} if key=="cash"))
            .unwrap()
            .value["amount"],
        112
    );
    assert_eq!(mixed.current_state().resources[0].amount, 107);
    assert_eq!(
        actor_fact_view(&mixed, &new_index, "player", "player")
            .unwrap()
            .attributes["住址"]
            .value()
            .map(String::as_str),
        Some("隐藏的西市")
    );
    assert!(mixed.append_v2_entry(entry).is_err());
    assert_eq!(mixed.turn_count(), 3);
    assert_eq!(
        actor_fact_view(&mixed, &visibility, "player", "player"),
        Err(GameError::Conflict)
    );
}
