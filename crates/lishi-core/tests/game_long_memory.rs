//! Fixed-data M03 conformance: formal facts, recall, then exact context input.
//! No model or network is called. These fictional records do not establish
//! historical accuracy or prove that an arbitrary model obeys the input.

use std::{collections::BTreeMap, time::Instant};

use lishi_core::{
    game_context::{
        compile_context, ContextBudget, ContextErrorCode, ContextFragment, ContextFragmentKind,
        ContextFragmentStatus, ContextPin, ContextRules, ContextScope, ContextSectionOutcome,
    },
    game_knowledge::{
        actor_fact_view, initial_visible_grants, minimal_actor_fact_json, resolve_visible_name,
        CommittedHistoryEntry, SourceVisibilityIndex, ValidatedHistory,
    },
    game_memory::{MemoryIndex, MemoryKnownIdentity, MemoryQuery, MemoryScope, MemoryTurnInput},
    game_protocol::{EntityKind, WorldSetup},
    game_protocol_v2::{
        apply_output_v2, initial_state_v2, CommitContext, ConditionCategory, ConditionInput,
        Disclosure, EntityInput, EventInput, FactKey, StateChangeV2, StateSource, TimeAdvanceV2,
        TurnOutputV2, WorldStateV2,
    },
    game_store::{GameActionKind, GameTurnRequest},
    game_store_v2::{CommittedTurnV2, WorldViewV2},
    model_probe::{CredentialMode, ModelContextPolicy, ModelProbeRequest, SavedEndpointPolicy},
};
use sha2::{Digest, Sha256};

const WORLD: &str = "long-memory-fixed-world";
const RED: &str = "enemy-red";
const BLUE: &str = "visitor-blue";
const PARTNER: &str = "partner-chen";
const KEY: &str = "old-door-key";
const DEED: &str = "home-deed";
const SECRET: &str = "午夜独自焚毁蓝色密信";

fn turn_id(sequence: usize) -> String {
    format!("long-turn-{sequence:04}")
}

fn operation_id(sequence: usize) -> String {
    format!("long-operation-{sequence:04}")
}

fn event_id(sequence: usize) -> String {
    format!("long-event-{sequence:04}")
}

fn source(sequence: usize) -> StateSource {
    StateSource::Turn {
        operation_id: operation_id(sequence),
        turn_id: turn_id(sequence),
        event_id: event_id(sequence),
    }
}

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: WORLD.into(),
        title: "固定长局关系与旧事验收".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "李明".into(),
        narrative_style: "固定虚构数据；角色只使用正式获知的信息".into(),
    }
}

fn create(id: &str, name: &str, kind: EntityKind, event: &str) -> StateChangeV2 {
    StateChangeV2::CreateEntity {
        entity: EntityInput {
            id: id.into(),
            kind,
            name: name.into(),
            alive: (kind == EntityKind::Person).then_some(true),
            attributes: BTreeMap::new(),
        },
        event_id: event.into(),
    }
}

fn observe(actor: &str, fact_key: FactKey, event: &str) -> StateChangeV2 {
    StateChangeV2::ObserveFact {
        actor_id: actor.into(),
        fact_key,
        event_id: event.into(),
    }
}

fn output(sequence: usize) -> TurnOutputV2 {
    let event = event_id(sequence);
    let mut subjects = vec!["player".into()];
    let mut changes = Vec::new();
    let mut observed = Vec::new();
    let mut npc_observed = Vec::new();
    let mut extra_events = Vec::new();
    let narrative = match sequence {
        5 => {
            changes.push(StateChangeV2::AddCondition {
                condition: ConditionInput {
                    id: "old-leg-injury".into(),
                    entity_id: "player".into(),
                    description: "渡口扭伤左腿，旧腿伤尚未痊愈".into(),
                    category: ConditionCategory::Injury,
                    active: true,
                },
                event_id: event.clone(),
            });
            observed.push(FactKey::Condition {
                condition_id: "old-leg-injury".into(),
            });
            "李明在渡口扭伤左腿，旧腿伤留下了。".into()
        }
        30 => {
            subjects.extend([RED.into(), BLUE.into()]);
            for id in [RED, BLUE] {
                changes.push(create(id, "赵明", EntityKind::Person, &event));
                observed.extend([
                    FactKey::EntityCreated {
                        entity_id: id.into(),
                    },
                    FactKey::EntityName {
                        entity_id: id.into(),
                    },
                    FactKey::EntityLife {
                        entity_id: id.into(),
                    },
                ]);
            }
            changes.push(StateChangeV2::ChangeRelationship {
                from_id: "player".into(),
                to_id: RED.into(),
                kind: "enmity".into(),
                strength: -80,
                event_id: event.clone(),
            });
            observed.push(FactKey::Relationship {
                from_id: "player".into(),
                to_id: RED.into(),
                kind: "enmity".into(),
            });
            npc_observed.push(observe(
                RED,
                FactKey::EntityName {
                    entity_id: RED.into(),
                },
                &event,
            ));
            "李明遇见两位同叫赵明的人，只与红帽赵明结仇；蓝帽来客不是仇敌。".into()
        }
        31 => {
            subjects.push(RED.into());
            "红帽赵明与你谈及赤色漆匣，旧怨仍在。".into()
        }
        32 => {
            subjects.push(BLUE.into());
            "蓝帽赵明展示一卷蓝色河图，此人与红帽仇敌不同。".into()
        }
        35 => {
            subjects.extend([PARTNER.into(), DEED.into()]);
            changes.extend([
                create(PARTNER, "陈兰", EntityKind::Person, &event),
                create(DEED, "宅契", EntityKind::Item, &event),
                StateChangeV2::ChangeRelationship {
                    from_id: "player".into(),
                    to_id: PARTNER.into(),
                    kind: "marriage".into(),
                    strength: 75,
                    event_id: event.clone(),
                },
                StateChangeV2::ChangeResource {
                    owner_id: "player".into(),
                    key: "cash".into(),
                    unit: "记账单位".into(),
                    delta: 80,
                    expected_amount: Some(100),
                    event_id: event.clone(),
                },
                StateChangeV2::SetItemHolding {
                    item_id: DEED.into(),
                    expected_holding: None,
                    holder_id: Some("player".into()),
                    place_id: None,
                    quantity: 1,
                    unit: "份".into(),
                    event_id: event.clone(),
                },
            ]);
            for id in [PARTNER, DEED] {
                observed.extend([
                    FactKey::EntityCreated {
                        entity_id: id.into(),
                    },
                    FactKey::EntityName {
                        entity_id: id.into(),
                    },
                ]);
            }
            observed.extend([
                FactKey::Relationship {
                    from_id: "player".into(),
                    to_id: PARTNER.into(),
                    kind: "marriage".into(),
                },
                FactKey::Resource {
                    owner_id: "player".into(),
                    key: "cash".into(),
                },
                FactKey::ItemHolding {
                    item_id: DEED.into(),
                },
            ]);
            "李明与陈兰约定长期相伴，成婚关系正式记录；资产增加八十并收好宅契。".into()
        }
        40 => {
            let secret_event = "secret-event-0040";
            extra_events.push(EventInput {
                id: secret_event.into(),
                description: "未公开的独立行动".into(),
                entity_ids: vec![RED.into()],
                disclosure: Disclosure::Restricted,
            });
            changes.push(StateChangeV2::SetAttribute {
                entity_id: RED.into(),
                key: "private_plan".into(),
                value: SECRET.into(),
                expected_value: None,
                event_id: secret_event.into(),
            });
            "你在客栈整理账簿，没有听见城外谈话。".into()
        }
        70 => {
            subjects.push(KEY.into());
            changes.extend([
                create(KEY, "钥匙", EntityKind::Item, &event),
                StateChangeV2::SetItemHolding {
                    item_id: KEY.into(),
                    expected_holding: None,
                    holder_id: Some("player".into()),
                    place_id: None,
                    quantity: 1,
                    unit: "把".into(),
                    event_id: event.clone(),
                },
            ]);
            observed.extend([
                FactKey::EntityCreated {
                    entity_id: KEY.into(),
                },
                FactKey::EntityName {
                    entity_id: KEY.into(),
                },
                FactKey::ItemHolding {
                    item_id: KEY.into(),
                },
            ]);
            "李明把钥匙藏在行囊里；门上约定的暗号是青石落泉。".into()
        }
        100 => {
            changes.push(StateChangeV2::AddCondition {
                condition: ConditionInput {
                    id: "unpaid-debt".into(),
                    entity_id: "player".into(),
                    description: "欠铺主十枚，下月应还；尚未偿还".into(),
                    category: ConditionCategory::Obligation,
                    active: true,
                },
                event_id: event.clone(),
            });
            observed.push(FactKey::Condition {
                condition_id: "unpaid-debt".into(),
            });
            "李明欠铺主十枚，约定下月偿还；此后没有偿债事件。".into()
        }
        150 => {
            subjects.push(RED.into());
            changes.push(StateChangeV2::RenameEntity {
                entity_id: "player".into(),
                expected_name: "李明".into(),
                new_name: "李安".into(),
                event_id: event.clone(),
            });
            observed.push(FactKey::EntityName {
                entity_id: "player".into(),
            });
            "李明更名为李安，再遇红帽赵明；旧怨没有和解。".into()
        }
        300 => "李安回顾伤债、仇敌与相伴关系，准备走向旧门。".into(),
        _ => format!(
            "第{sequence}回合，{}观察街市并整理见闻。",
            if sequence < 150 { "李明" } else { "李安" }
        ),
    };
    observed.extend([
        FactKey::Time,
        FactKey::Event {
            event_id: event.clone(),
        },
    ]);
    changes.extend(
        observed
            .into_iter()
            .map(|fact| observe("player", fact, &event)),
    );
    changes.extend(npc_observed);
    let mut events = vec![EventInput {
        id: event.clone(),
        description: format!("固定事件{sequence}"),
        entity_ids: subjects,
        disclosure: Disclosure::Restricted,
    }];
    events.extend(extra_events);
    TurnOutputV2 {
        protocol_version: 2,
        narrative,
        choices: Vec::new(),
        time_advance: TimeAdvanceV2 {
            elapsed_seconds: 60,
            event_id: Some(event),
        },
        state_changes: changes,
        events,
        source_references: Vec::new(),
        uncertainties: Vec::new(),
    }
}

fn fixed_history() -> (WorldSetup, Vec<CommittedTurnV2>, ValidatedHistory) {
    let setup = setup();
    let initial = initial_state_v2(&setup).unwrap();
    let mut state = initial.clone();
    let mut entries = Vec::new();
    let mut turns = Vec::new();
    let mut parent = None;
    for sequence in 1..=300 {
        let output = output(sequence);
        let id = turn_id(sequence);
        state = apply_output_v2(
            &state,
            &output,
            &CommitContext {
                operation_id: operation_id(sequence),
                turn_id: id.clone(),
            },
        )
        .unwrap_or_else(|error| panic!("turn {sequence}: {error:?}"));
        entries.push(CommittedHistoryEntry {
            operation_id: operation_id(sequence),
            turn_id: id.clone(),
            parent_turn_id: parent.clone(),
            output: output.clone(),
            state: state.clone(),
        });
        turns.push(CommittedTurnV2 {
            turn_id: id.clone(),
            parent_turn_id: parent.clone(),
            action_kind: GameActionKind::Continue,
            action_text: String::new(),
            narrative: output.narrative,
            choices: Vec::new(),
            state: state.clone(),
            created_at_ms: sequence as i64,
        });
        parent = Some(id);
    }
    let history =
        ValidatedHistory::new(&setup.world_id, initial, entries, parent.as_deref()).unwrap();
    (setup, turns, history)
}

fn actor_identities(
    history: &ValidatedHistory,
    visibility: &SourceVisibilityIndex,
) -> Vec<MemoryKnownIdentity> {
    // Names come exclusively from this actor's filtered revisions, including
    // historical known names. No global entity name or alias is copied here.
    history
        .current_state()
        .entities
        .iter()
        .filter_map(|entity| {
            let facts = actor_fact_view(history, visibility, "player", &entity.id).unwrap();
            let mut names = facts.name.value().cloned().into_iter().collect::<Vec<_>>();
            names.extend(
                facts
                    .aliases
                    .iter()
                    .filter_map(|alias| alias.value().cloned()),
            );
            (!names.is_empty()).then_some(MemoryKnownIdentity {
                entity_id: entity.id.clone(),
                names,
            })
        })
        .collect()
}

fn assert_formal_facts(state: &WorldStateV2) {
    assert_eq!(state.time.elapsed_seconds, 18_000);
    let player = state
        .entities
        .iter()
        .find(|entity| entity.id == "player")
        .unwrap();
    assert_eq!(player.name, "李安");
    assert!(player.aliases.iter().any(|alias| alias.text == "李明"));
    assert_eq!(player.name_source, source(150));
    let enemy = state
        .relationships
        .iter()
        .find(|relation| relation.to_id == RED && relation.kind == "enmity")
        .unwrap();
    assert_eq!(enemy.strength, -80);
    assert_eq!(enemy.last_changed_source, source(30));
    assert!(!state
        .relationships
        .iter()
        .any(|relation| relation.to_id == BLUE && relation.kind == "enmity"));
    let partner = state
        .relationships
        .iter()
        .find(|relation| relation.to_id == PARTNER && relation.kind == "marriage")
        .unwrap();
    assert_eq!(partner.strength, 75);
    assert_eq!(partner.last_changed_source, source(35));
    let cash = state
        .resources
        .iter()
        .find(|resource| resource.owner_id == "player" && resource.key == "cash")
        .unwrap();
    assert_eq!(cash.amount, 180);
    assert_eq!(cash.last_changed_source, source(35));
    for (item, sequence, unit) in [(KEY, 70, "把"), (DEED, 35, "份")] {
        let holding = state
            .item_holdings
            .iter()
            .find(|holding| holding.item_id == item)
            .unwrap();
        assert_eq!(holding.value.holder_id.as_deref(), Some("player"));
        assert_eq!(holding.value.quantity, Some(1));
        assert_eq!(holding.value.unit.as_deref(), Some(unit));
        assert_eq!(holding.source, source(sequence));
    }
    for (id, category, sequence) in [
        ("old-leg-injury", ConditionCategory::Injury, 5),
        ("unpaid-debt", ConditionCategory::Obligation, 100),
    ] {
        let condition = state
            .conditions
            .iter()
            .find(|condition| condition.id == id)
            .unwrap();
        assert!(condition.active);
        assert_eq!(condition.category, category);
        assert_eq!(condition.last_changed_source, source(sequence));
        assert_eq!(condition.resolved_source, None);
    }
}

#[test]
fn three_hundred_formal_turns_preserve_relationships_assets_names_and_recalled_original_context() {
    let started = Instant::now();
    let (setup, turns, history) = fixed_history();
    let originals = turns
        .iter()
        .map(|turn| serde_json::to_vec(turn).unwrap())
        .collect::<Vec<_>>();
    let state = history.current_state();
    assert_eq!(history.turn_count(), 300);
    assert_formal_facts(state);
    let visibility = SourceVisibilityIndex::from_recorded_observations(
        &history,
        initial_visible_grants(&history, "player").unwrap(),
    )
    .unwrap();
    let known = actor_identities(&history, &visibility);
    let collisions = resolve_visible_name(&history, &visibility, "player", "赵明").unwrap();
    assert_eq!(
        collisions
            .iter()
            .map(|candidate| candidate.entity_id.as_str())
            .collect::<Vec<_>>(),
        vec![RED, BLUE]
    );
    let player_known = actor_fact_view(&history, &visibility, "player", "player").unwrap();
    assert_eq!(player_known.name.value().map(String::as_str), Some("李安"));
    assert!(player_known
        .aliases
        .iter()
        .any(|alias| alias.value().is_some_and(|name| name == "李明")));
    assert_eq!(
        state
            .entities
            .iter()
            .find(|entity| entity.id == RED)
            .unwrap()
            .attributes["private_plan"],
        SECRET
    );
    for actor in ["player", RED] {
        let filtered = actor_fact_view(&history, &visibility, actor, RED).unwrap();
        assert!(!filtered.attributes.contains_key("private_plan"));
        let brain = minimal_actor_fact_json(&history, &visibility, actor, 2 * 1024 * 1024).unwrap();
        assert!(!brain.contains(SECRET));
    }
    assert_eq!(
        actor_fact_view(&history, &visibility, RED, RED)
            .unwrap()
            .name
            .value()
            .map(String::as_str),
        Some("赵明")
    );
    assert!(actor_fact_view(&history, &visibility, RED, BLUE)
        .unwrap()
        .name
        .value()
        .is_none());

    let temporary = tempfile::tempdir().unwrap();
    let mut index =
        MemoryIndex::open_sidecar(temporary.path().join("derived-index.sqlite")).unwrap();
    let receipt = index
        .rebuild(
            WORLD,
            "main",
            history.head_turn_id(),
            turns.iter().enumerate().map(|(position, turn)| {
                MemoryTurnInput::borrowed(turn, position as u64 + 1, "main")
            }),
        )
        .unwrap();
    assert_eq!(receipt.turn_count, 300);
    let visible = history.visible_turn_ids();
    let scope = MemoryScope {
        world_id: WORLD,
        branch_id: "main",
        head_turn_id: history.head_turn_id(),
        visible_turn_ids: &visible,
    };
    let mut recalled = Vec::new();
    for (text, expected) in [
        ("李明旧腿伤", 5),
        ("李安钥匙", 70),
        ("李明欠铺主十枚", 100),
        ("陈兰成婚", 35),
    ] {
        let page = index
            .retrieve(
                &scope,
                &MemoryQuery {
                    query: text.into(),
                    max_results: 1,
                    ..MemoryQuery::default()
                },
                state,
                &known,
            )
            .unwrap();
        assert_eq!(page.fragments.len(), 1, "{text}");
        let fragment = &page.fragments[0];
        assert_eq!(fragment.source.sequence, expected, "{text}");
        assert_eq!(fragment.source.turn_id, turn_id(expected as usize));
        assert_eq!(fragment.text, turns[expected as usize - 1].narrative);
        assert_eq!(
            fragment.source.narrative_sha256,
            format!(
                "{:x}",
                Sha256::digest(turns[expected as usize - 1].narrative.as_bytes())
            )
        );
        recalled.push(fragment.clone());
    }
    for (entity, expected, quote) in [(RED, 31, "赤色漆匣"), (BLUE, 32, "蓝色河图")] {
        let page = index
            .retrieve(
                &scope,
                &MemoryQuery {
                    query: "赵明".into(),
                    entity_ids: vec![entity.into()],
                    min_elapsed_seconds: Some(31 * 60),
                    max_elapsed_seconds: Some(32 * 60),
                    max_results: 1,
                    ..MemoryQuery::default()
                },
                state,
                &known,
            )
            .unwrap();
        assert_eq!(page.fragments.len(), 1);
        assert_eq!(page.fragments[0].source.sequence, expected);
        assert!(page.fragments[0].text.contains(quote));
        assert!(page.fragments[0].entity_ids.contains(&entity.into()));
        assert!(!page.fragments[0].entity_ids.contains(&if entity == RED {
            BLUE.into()
        } else {
            RED.into()
        }));
        recalled.push(page.fragments[0].clone());
    }
    assert!(index
        .retrieve(
            &scope,
            &MemoryQuery {
                query: SECRET.into(),
                max_results: 1,
                ..MemoryQuery::default()
            },
            state,
            &known
        )
        .unwrap()
        .fragments
        .is_empty());

    let view = WorldViewV2 {
        setup,
        branch_id: "main".into(),
        head_turn_id: history.head_turn_id().map(str::to_owned),
        turn_count: 300,
        state: state.clone(),
        opening_narrative: "固定开局".into(),
        opening_choices: Vec::new(),
        narrative_policy: "角色不能从叙事者事实偷获知秘密".into(),
        turns: turns[200..].to_vec(),
        latest_operation: None,
    };
    let request = GameTurnRequest {
        operation_id: "long-context-final-request".into(),
        world_id: WORLD.into(),
        branch_id: "main".into(),
        expected_head_turn_id: view.head_turn_id.clone(),
        action_kind: GameActionKind::Action,
        action_text: "李安拿起钥匙，回顾赵明与陈兰的约定后走向旧门。".into(),
    };
    let budget = ContextBudget {
        max_input_bytes: 128 * 1024,
        context_limit_tokens: 196 * 1024,
        output_reserve_tokens: 4096,
        transport_reserve_tokens: 512,
    };
    let selected = ContextScope::from_view(&view);
    let fragments = recalled
        .iter()
        .map(|fragment| ContextFragment {
            id: format!("recalled-{:04}", fragment.source.sequence),
            scope: selected.clone(),
            kind: ContextFragmentKind::RelatedMemory,
            status: ContextFragmentStatus::Committed,
            source_turn_ids: vec![fragment.source.turn_id.clone()],
            body: fragment.text.clone(),
            relevance: 100,
        })
        .collect::<Vec<_>>();
    let pins = [
        ContextPin {
            id: "pin-current-debt".into(),
            scope: selected.clone(),
            fact_key: FactKey::Condition {
                condition_id: "unpaid-debt".into(),
            },
        },
        ContextPin {
            id: "pin-current-marriage".into(),
            scope: selected.clone(),
            fact_key: FactKey::Relationship {
                from_id: "player".into(),
                to_id: PARTNER.into(),
                kind: "marriage".into(),
            },
        },
    ];
    let without_recall = compile_context(
        &view,
        &request,
        &history,
        ContextRules::v2(),
        budget,
        &pins,
        &[],
    )
    .unwrap();
    assert!(!without_recall.prompt.contains("青石落泉"));
    let compiled = compile_context(
        &view,
        &request,
        &history,
        ContextRules::v2(),
        budget,
        &pins,
        &fragments,
    )
    .unwrap();
    for quote in [
        "青石落泉",
        "李明把钥匙藏在行囊里",
        "赤色漆匣",
        "蓝色河图",
        "欠铺主十枚",
        "旧腿伤",
        "陈兰",
        "李安",
    ] {
        assert!(compiled.prompt.contains(quote), "{quote}");
    }
    assert!(compiled
        .trace
        .sections
        .iter()
        .any(|section| section.id.as_deref() == Some("recalled-0070")
            && section.outcome == ContextSectionOutcome::Included));
    assert_eq!(compiled.trace.actual_input_tokens, None);
    assert_eq!(compiled.trace.estimated_input_tokens, compiled.prompt.len());
    assert_eq!(compiled.trace.input_utf8_bytes, compiled.prompt.len());
    assert!(compiled.prompt.len() <= 128 * 1024);
    let actor_line = compiled
        .prompt
        .lines()
        .find_map(|line| line.strip_prefix("角色已知JSON："))
        .unwrap();
    assert!(!actor_line.contains(SECRET));
    let actor_context: serde_json::Value = serde_json::from_str(actor_line).unwrap();
    assert!(actor_context[RED]["e"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entity| entity[0].as_str() != Some(BLUE)));
    // Objective narrator facts may retain the secret; its absence from every
    // actor's section is the knowledge boundary, not deleting formal facts.
    assert!(compiled
        .prompt
        .lines()
        .find(|line| line.starts_with("叙事者事实JSON："))
        .unwrap()
        .contains(SECRET));
    let guarded = ModelProbeRequest {
        operation_id: request.operation_id.clone(),
        endpoint: "https://fixed-fixture.invalid/v1/chat/completions".into(),
        model: "fixed-data-no-model-call".into(),
        prompt: compiled.prompt.clone(),
        include_usage: true,
        credential_mode: CredentialMode::Saved,
    };
    guarded
        .validate_with_context_policy(
            SavedEndpointPolicy::HttpsOnly,
            ModelContextPolicy {
                max_prompt_bytes: budget.effective_input_limit_bytes().unwrap(),
                output_reserve_tokens: Some(4096),
            },
        )
        .unwrap();

    for status in [
        ContextFragmentStatus::Draft,
        ContextFragmentStatus::Failed,
        ContextFragmentStatus::Cancelled,
        ContextFragmentStatus::Interrupted,
    ] {
        let mut forbidden = fragments[1].clone();
        forbidden.status = status;
        forbidden.body = "未提交草稿把钥匙暗号改为金砂".into();
        assert_eq!(
            compile_context(
                &view,
                &request,
                &history,
                ContextRules::v2(),
                budget,
                &[],
                &[forbidden]
            )
            .unwrap_err()
            .code,
            ContextErrorCode::UncommittedFragment
        );
    }
    for source_id in ["sibling-secret-turn-0001", "long-turn-0301"] {
        let mut forbidden = fragments[1].clone();
        forbidden.source_turn_ids = vec![source_id.into()];
        forbidden.body = "旁支资料替换暗号为银沙".into();
        assert_eq!(
            compile_context(
                &view,
                &request,
                &history,
                ContextRules::v2(),
                budget,
                &[],
                &[forbidden]
            )
            .unwrap_err()
            .code,
            ContextErrorCode::InvisibleSource
        );
    }
    assert!(!compiled.prompt.contains("金砂"));
    assert!(!compiled.prompt.contains("银沙"));
    for (turn, original) in turns.iter().zip(originals) {
        assert_eq!(serde_json::to_vec(turn).unwrap(), original);
    }
    assert_eq!(&view.state, history.current_state());
    assert_formal_facts(&view.state);
    eprintln!("fixed_long_memory turns=300 recall=6 same_name_ids=2 required_bytes={} input_bytes={} configured_bytes=131072 configured_tokens=200704 actual_usage=unknown network_calls=0 elapsed_ms={}", compiled.trace.required_input_bytes, compiled.trace.input_utf8_bytes, started.elapsed().as_millis());
}
