use std::collections::BTreeMap;

use lishi_core::{
    game_protocol::{EntityKind, GameError, WorldSetup},
    game_protocol_v2::{
        apply_output_v2, initial_state_v2, parse_output_v2, AcquisitionMode, Certainty,
        ClaimAssessment, ClaimInput, CommitContext, ConditionCategory, ConditionInput, Disclosure,
        EntityInput, EventInput, FactKey, StateChangeV2, StateSource, TimeAdvanceV2, TurnOutputV2,
    },
    game_provider::ProviderError,
    game_provider_v2::{compile_game_prompt_v2, demo_output_v2, MAX_GAME_PROMPT_BYTES_V2},
    game_store::{GameActionKind, GameOperationStatus, GameTurnRequest},
    game_store_v2::GameStoreV2,
};
use serde_json::{json, Value};

const WORLD: &str = "provider-v2-world";

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: WORLD.into(),
        title: "中文十回合🔑🙂".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "李明".into(),
        narrative_style: "保留正式事实和角色未知信息".into(),
    }
}

fn create(path: &std::path::Path) -> GameStoreV2 {
    let store = GameStoreV2::open(path).unwrap();
    let setup = setup();
    store
        .create_world_v2(
            &setup,
            &initial_state_v2(&setup).unwrap(),
            "来到咸阳。",
            &[],
        )
        .unwrap();
    store
}

fn request(n: usize, action: &str, head: Option<&str>) -> GameTurnRequest {
    GameTurnRequest {
        operation_id: format!("provider-fixed-{n:08}"),
        world_id: WORLD.into(),
        branch_id: "main".into(),
        expected_head_turn_id: head.map(str::to_owned),
        action_kind: if action.is_empty() {
            GameActionKind::Continue
        } else {
            GameActionKind::Action
        },
        action_text: action.into(),
    }
}

fn commit(store: &GameStoreV2, n: usize, output: &TurnOutputV2) {
    let view = store.view().unwrap();
    let req = request(n, "固定场景行动", view.head_turn_id.as_deref());
    store.begin(&req).unwrap();
    store.mark_generating(&req.operation_id).unwrap();
    store
        .stage_output(&req.operation_id, &serde_json::to_string(output).unwrap())
        .unwrap();
    store.commit(&req.operation_id, output).unwrap();
}

fn scene(id: &str, entity_ids: &[&str], changes: Vec<StateChangeV2>) -> TurnOutputV2 {
    TurnOutputV2 {
        protocol_version: 2,
        narrative: "固定测试场景；不是历史研究。".into(),
        choices: vec![],
        time_advance: TimeAdvanceV2 {
            elapsed_seconds: 0,
            event_id: None,
        },
        state_changes: changes,
        events: vec![EventInput {
            id: id.into(),
            description: format!("明确记录的{id}事件。"),
            entity_ids: entity_ids.iter().map(|s| (*s).into()).collect(),
            disclosure: Disclosure::Restricted,
        }],
        source_references: vec![],
        uncertainties: vec![],
    }
}

fn section(prompt: &str, label: &str) -> Value {
    serde_json::from_str(
        prompt
            .lines()
            .find_map(|line| line.strip_prefix(label))
            .unwrap(),
    )
    .unwrap()
}

fn current_prompt(store: &GameStoreV2, n: usize) -> Result<String, ProviderError> {
    let view = store.view().unwrap();
    compile_game_prompt_v2(
        &view,
        &request(n, "继续核对事实", view.head_turn_id.as_deref()),
        &store.knowledge_history().unwrap(),
    )
}

#[test]
fn initial_and_ten_complete_demo_turns_compile_within_native_budget() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("十回合.sqlite");
    let store = create(&path);
    let actions = [
        "购买补给",
        "做短工赚钱",
        "赶路时受伤",
        "休息两个小时",
        "",
        "打听城里的消息",
        "购买口粮",
        "工作赚钱",
        "",
        "整理行囊的钥匙🔑🙂",
    ];
    let mut lengths = Vec::new();
    for (n, action) in actions.iter().enumerate() {
        let view = store.view().unwrap();
        let req = request(n, action, view.head_turn_id.as_deref());
        let history = store.knowledge_history().unwrap();
        let prompt = compile_game_prompt_v2(&view, &req, &history)
            .unwrap_or_else(|error| panic!("turn {n} prompt: {error}"));
        lengths.push(prompt.len());
        assert!(prompt.len() <= MAX_GAME_PROMPT_BYTES_V2);
        let output = demo_output_v2(&view.state, &req).unwrap();
        let raw = serde_json::to_string(&output).unwrap();
        assert_eq!(parse_output_v2(&raw).unwrap(), output);
        store.begin(&req).unwrap();
        store.mark_generating(&req.operation_id).unwrap();
        store.stage_output(&req.operation_id, &raw).unwrap();
        store.commit(&req.operation_id, &output).unwrap();
    }
    let view = store.view().unwrap();
    let prompt = compile_game_prompt_v2(
        &view,
        &request(10, "查看正式状态", view.head_turn_id.as_deref()),
        &store.knowledge_history().unwrap(),
    )
    .expect("eleventh operation remains callable after all ten commits");
    lengths.push(prompt.len());
    println!("initial/ten-turn UTF-8 byte lengths: {lengths:?}");
    assert_eq!(view.turn_count, 10);
    assert_eq!(view.state.time.elapsed_seconds, 46_800);
    assert_eq!(view.state.resources[0].amount, 110);
    assert!(view.state.conditions.iter().all(|c| !c.active));
    assert_eq!(view.state.item_holdings.len(), 3);
    for holding in view.state.item_holdings.iter().skip(1) {
        assert_eq!(holding.value.holder_id.as_deref(), Some("player"));
        assert_eq!(holding.value.quantity, Some(1));
        assert_eq!(holding.value.unit.as_deref(), Some("份"));
    }
    let narrator = section(&prompt, "叙事者事实JSON：");
    assert_eq!(narrator["ev"].as_array().unwrap().len(), 10);
    assert_eq!(
        narrator["e"].as_array().unwrap().len(),
        view.state.entities.len()
    );
    assert_eq!(narrator["h"].as_array().unwrap().len(), 3);
    assert_eq!(narrator["r"][0][3], 110);
    assert_eq!(narrator["t"][2], 46_800);
    assert_eq!(narrator["c"][0][4], false);
    let actors = section(&prompt, "角色已知JSON：");
    let player_facts = actors["player"]["f"].as_array().unwrap();
    assert!(player_facts.contains(&json!([["resource", "player", "cash"], ["记账单位", 110]])));
    assert!(player_facts.contains(&json!([["time"], [-221, "year", 46_800]])));
    assert_eq!(
        player_facts
            .iter()
            .filter(|fact| fact[0][0] == "holding")
            .count(),
        3
    );
    drop(store);
    assert_eq!(GameStoreV2::open(path).unwrap().view().unwrap(), view);
}

#[test]
fn rename_aliases_are_same_id_and_explicitly_observed_with_core_provenance() {
    let dir = tempfile::tempdir().unwrap();
    let store = create(&dir.path().join("rename.sqlite"));
    for (n, action) in ["改名为李远", "增加别名：长安客"].iter().enumerate() {
        let view = store.view().unwrap();
        let req = request(n, action, view.head_turn_id.as_deref());
        let output = demo_output_v2(&view.state, &req).unwrap();
        commit(&store, n, &output);
    }
    let view = store.view().unwrap();
    let player = view
        .state
        .entities
        .iter()
        .find(|e| e.id == "player")
        .unwrap();
    assert_eq!(player.name, "李远");
    assert_eq!(
        player
            .aliases
            .iter()
            .map(|a| a.text.as_str())
            .collect::<Vec<_>>(),
        ["李明", "长安客"]
    );
    assert!(
        matches!(&player.name_source, StateSource::Turn { operation_id, turn_id, .. } if operation_id == "provider-fixed-00000000" && turn_id == operation_id)
    );
    assert_eq!(
        view.state
            .entities
            .iter()
            .filter(|e| e.kind == EntityKind::Person)
            .count(),
        1
    );
    let actors = section(&current_prompt(&store, 2).unwrap(), "角色已知JSON：");
    let known_player = actors["player"]["e"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e[0] == "player")
        .unwrap();
    assert_eq!(known_player[1], "李远");
    assert_eq!(known_player[4], json!(["李明", "长安客"]));
}

#[test]
fn rest_resolves_only_generated_demo_injury_and_preserves_other_conditions() {
    let initial = initial_state_v2(&setup()).unwrap();
    let categories = [
        ("debt", "需要偿还的债务", ConditionCategory::Obligation),
        ("old-injury", "需要就医的旧伤", ConditionCategory::Injury),
        ("illness", "持续发热", ConditionCategory::Illness),
        (
            "legacy",
            "没有分类的承诺",
            ConditionCategory::LegacyUnspecified,
        ),
    ];
    // Model output cannot create the legacy-only category; inject the preserved
    // legacy snapshot category separately after legitimate sourced creation.
    let changes = categories
        .iter()
        .map(|(id, description, category)| StateChangeV2::AddCondition {
            condition: ConditionInput {
                id: (*id).into(),
                entity_id: "player".into(),
                description: (*description).into(),
                category: if *category == ConditionCategory::LegacyUnspecified {
                    ConditionCategory::Other
                } else {
                    *category
                },
                active: true,
            },
            event_id: "conditions".into(),
        })
        .collect();
    let base = apply_output_v2(
        &initial,
        &scene("conditions", &["player"], changes),
        &CommitContext {
            operation_id: "condition-setup".into(),
            turn_id: "condition-setup".into(),
        },
    )
    .unwrap();
    let injury_req = request(1, "赶路受伤", None);
    let injured = apply_output_v2(
        &base,
        &demo_output_v2(&base, &injury_req).unwrap(),
        &CommitContext {
            operation_id: injury_req.operation_id.clone(),
            turn_id: injury_req.operation_id,
        },
    )
    .unwrap();
    let req = request(2, "休息两个小时", None);
    let rested = apply_output_v2(
        &injured,
        &demo_output_v2(&injured, &req).unwrap(),
        &CommitContext {
            operation_id: req.operation_id.clone(),
            turn_id: req.operation_id,
        },
    )
    .unwrap();
    for (id, _, _) in categories {
        assert!(
            rested
                .conditions
                .iter()
                .find(|c| c.id == id)
                .unwrap()
                .active
        );
    }
    assert!(!rested.conditions.last().unwrap().active);
    assert_eq!(rested.resources[0].amount, initial.resources[0].amount);
}

#[test]
fn insufficient_funds_do_not_create_inventory_or_negative_resource() {
    let initial = initial_state_v2(&setup()).unwrap();
    let poor = apply_output_v2(
        &initial,
        &scene(
            "spend",
            &["player"],
            vec![StateChangeV2::ChangeResource {
                owner_id: "player".into(),
                key: "cash".into(),
                unit: "记账单位".into(),
                delta: -99,
                expected_amount: Some(100),
                event_id: "spend".into(),
            }],
        ),
        &CommitContext {
            operation_id: "spend-cash".into(),
            turn_id: "spend-cash".into(),
        },
    )
    .unwrap();
    let req = request(1, "购买口粮", None);
    let output = demo_output_v2(&poor, &req).unwrap();
    let after = apply_output_v2(
        &poor,
        &output,
        &CommitContext {
            operation_id: req.operation_id.clone(),
            turn_id: req.operation_id,
        },
    )
    .unwrap();
    assert_eq!(after.resources, poor.resources);
    assert_eq!(after.item_holdings, poor.item_holdings);
    assert_eq!(after.entities, poor.entities);
    assert!(output.narrative.contains("购买没有发生"));
}

#[test]
fn narrator_secrets_and_global_claim_assessment_do_not_refresh_actor_knowledge() {
    let dir = tempfile::tempdir().unwrap();
    let store = create(&dir.path().join("knowledge.sqlite"));
    commit(
        &store,
        0,
        &scene(
            "encounter",
            &["player", "npc"],
            vec![
                StateChangeV2::CreateEntity {
                    entity: EntityInput {
                        id: "npc".into(),
                        kind: EntityKind::Person,
                        name: "王安".into(),
                        alive: Some(true),
                        attributes: BTreeMap::from([("private_code".into(), "未泄露密语".into())]),
                    },
                    event_id: "encounter".into(),
                },
                StateChangeV2::CreateClaim {
                    claim: ClaimInput {
                        id: "rumor".into(),
                        text: "城门可能会关闭".into(),
                        entity_ids: vec!["npc".into()],
                        assessment: ClaimAssessment::Unverified,
                        evidence_event_ids: vec![],
                    },
                    event_id: "encounter".into(),
                },
                StateChangeV2::RecordKnowledge {
                    actor_id: "player".into(),
                    target_type: lishi_core::game_protocol_v2::KnowledgeTarget::Claim,
                    target_id: "rumor".into(),
                    certainty: Certainty::Reported,
                    acquisition_mode: AcquisitionMode::Told,
                    known_evidence_event_ids: vec![],
                    event_id: "encounter".into(),
                },
                StateChangeV2::ObserveFact {
                    actor_id: "player".into(),
                    fact_key: FactKey::EntityName {
                        entity_id: "npc".into(),
                    },
                    event_id: "encounter".into(),
                },
            ],
        ),
    );
    commit(
        &store,
        1,
        &scene(
            "proof",
            &["player", "npc"],
            vec![
                StateChangeV2::RenameEntity {
                    entity_id: "npc".into(),
                    expected_name: "王安".into(),
                    new_name: "王远".into(),
                    event_id: "proof".into(),
                },
                StateChangeV2::SetAttribute {
                    entity_id: "npc".into(),
                    key: "private_code".into(),
                    value: "更新密语".into(),
                    expected_value: Some("未泄露密语".into()),
                    event_id: "proof".into(),
                },
                StateChangeV2::AssessClaim {
                    claim_id: "rumor".into(),
                    expected_assessment: ClaimAssessment::Unverified,
                    assessment: ClaimAssessment::Supported,
                    evidence_event_ids: vec!["proof".into()],
                    event_id: "proof".into(),
                },
            ],
        ),
    );
    let prompt = current_prompt(&store, 2).unwrap();
    let narrator = section(&prompt, "叙事者事实JSON：");
    let actors = section(&prompt, "角色已知JSON：");
    assert!(narrator.to_string().contains("更新密语"));
    assert!(narrator.to_string().contains("王远"));
    assert_eq!(narrator["cl"][0][3], "supported");
    assert_eq!(narrator["cl"][0][4], json!(["proof"]));
    assert!(actors.get("npc").is_none());
    assert!(!actors.to_string().contains("密语"));
    assert!(!actors.to_string().contains("王远"));
    assert!(!actors.to_string().contains("supported"));
    let known_npc = actors["player"]["e"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e[0] == "npc")
        .unwrap();
    assert_eq!(known_npc[1], "王安");
    assert_eq!(known_npc[2], Value::Null);
    assert_eq!(known_npc[3], json!({}));
    assert_eq!(
        actors["player"]["b"][0],
        json!(["claim", "rumor", "城门可能会关闭", "reported", "told", []])
    );
}

#[test]
fn staged_or_failed_text_is_absent_and_world_outside_policy_remains_separate() {
    let dir = tempfile::tempdir().unwrap();
    let store = create(&dir.path().join("candidate.sqlite"));
    store
        .update_policy("世界外方针：简洁，不是主角发言。")
        .unwrap();
    let req = request(0, "查看行囊", None);
    store.begin(&req).unwrap();
    store.mark_generating(&req.operation_id).unwrap();
    let mut candidate = demo_output_v2(&store.view().unwrap().state, &req).unwrap();
    candidate.narrative = "草稿唯一标记-not-committed-123".into();
    store
        .stage_output(
            &req.operation_id,
            &serde_json::to_string(&candidate).unwrap(),
        )
        .unwrap();
    let staged = current_prompt(&store, 1).unwrap();
    assert!(!staged.contains("not-committed"));
    assert_eq!(
        section(&staged, "世界外方针JSON："),
        "世界外方针：简洁，不是主角发言。"
    );
    assert_eq!(
        section(&staged, "当前行动JSON："),
        json!({"kind":"action","text":"继续核对事实"})
    );
    store
        .finish_uncommitted(
            &req.operation_id,
            GameOperationStatus::Failed,
            Some("game_invalid_output"),
        )
        .unwrap();
    let failed = current_prompt(&store, 2).unwrap();
    assert!(!failed.contains("not-committed"));
    assert_eq!(store.view().unwrap().turn_count, 0);
}

#[test]
fn mandatory_fact_overflow_fails_instead_of_omitting_events() {
    let dir = tempfile::tempdir().unwrap();
    let store = create(&dir.path().join("budget.sqlite"));
    for n in 0..3 {
        let id = format!("long-event-{n}");
        let mut output = scene(&id, &["player"], vec![]);
        output.events[0].description = "保留的正式事实".repeat(90);
        commit(&store, n, &output);
    }
    assert_eq!(store.view().unwrap().state.events.len(), 3);
    assert_eq!(
        current_prompt(&store, 3),
        Err(ProviderError::ContextTooLarge)
    );
    assert_eq!(store.view().unwrap().turn_count, 3);
}

#[test]
fn request_and_history_must_match_world_branch_head_count_and_state() {
    let dir = tempfile::tempdir().unwrap();
    let store = create(&dir.path().join("stale.sqlite"));
    let view = store.view().unwrap();
    let history = store.knowledge_history().unwrap();
    let req = request(0, "查看事实", None);
    for variant in 0..3 {
        let mut bad = req.clone();
        match variant {
            0 => bad.world_id = "different-world".into(),
            1 => bad.branch_id = "child".into(),
            _ => bad.expected_head_turn_id = Some("different-head".into()),
        }
        assert_eq!(
            compile_game_prompt_v2(&view, &bad, &history),
            Err(ProviderError::Stale)
        );
    }
    let mut bad = view.clone();
    bad.turn_count += 1;
    assert_eq!(
        compile_game_prompt_v2(&bad, &req, &history),
        Err(ProviderError::Stale)
    );
    let mut bad = view.clone();
    bad.state.resources[0].amount = 99;
    assert_eq!(
        compile_game_prompt_v2(&bad, &req, &history),
        Err(ProviderError::Stale)
    );
    commit(&store, 0, &demo_output_v2(&view.state, &req).unwrap());
    let current = store.view().unwrap();
    let req = request(1, "再次查看", current.head_turn_id.as_deref());
    assert_eq!(
        compile_game_prompt_v2(&current, &req, &history),
        Err(ProviderError::Stale)
    );
}

#[test]
fn safe_example_is_complete_schema_and_valid_without_source_or_state_change() {
    let dir = tempfile::tempdir().unwrap();
    let store = create(&dir.path().join("schema.sqlite"));
    let prompt = current_prompt(&store, 0).unwrap();
    let example = prompt
        .lines()
        .find(|line| line.starts_with("{\"protocolVersion\":2"))
        .unwrap();
    let output = parse_output_v2(example).unwrap();
    assert!(output.state_changes.is_empty());
    assert!(output.events.is_empty());
    assert!(output.source_references.is_empty());
    assert_eq!(
        apply_output_v2(
            &store.view().unwrap().state,
            &output,
            &CommitContext {
                operation_id: "schema-safe-example".into(),
                turn_id: "schema-safe-example".into()
            }
        )
        .unwrap(),
        store.view().unwrap().state
    );
    assert!(prompt.contains("来源由核心填"));
    assert!(prompt.contains("observe_fact"));
}

#[test]
fn malformed_demo_input_and_dead_player_are_rejected_without_mutation() {
    let initial = initial_state_v2(&setup()).unwrap();
    let baseline = initial.clone();
    let mut req = request(0, "查看事实", None);
    req.operation_id = "invalid/id".into();
    assert_eq!(
        demo_output_v2(&initial, &req),
        Err(GameError::InvalidReference)
    );
    for action in ["", "\0", " \n "] {
        let mut req = request(0, action, None);
        req.action_kind = GameActionKind::Action;
        assert_eq!(
            demo_output_v2(&initial, &req),
            Err(GameError::InvalidOutput)
        );
    }
    let mut req = request(0, "不应忽略文本", None);
    req.action_kind = GameActionKind::Continue;
    assert_eq!(
        demo_output_v2(&initial, &req),
        Err(GameError::InvalidOutput)
    );
    assert_eq!(initial, baseline);
    let req = request(0, "死亡", None);
    let dead = apply_output_v2(
        &initial,
        &demo_output_v2(&initial, &req).unwrap(),
        &CommitContext {
            operation_id: req.operation_id.clone(),
            turn_id: req.operation_id,
        },
    )
    .unwrap();
    assert_eq!(
        demo_output_v2(&dead, &request(1, "继续行动", None)),
        Err(GameError::InvalidEntity)
    );
}
