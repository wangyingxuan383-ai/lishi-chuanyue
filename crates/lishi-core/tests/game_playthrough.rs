//! Complete local gameplay fixtures use the same provider output, protocol and
//! persistence path as the native app, without a network service or API key.

use lishi_core::{
    game_protocol::{
        apply_output, initial_state, parse_output, validate_state, GameError, StateChange,
        WorldSetup,
    },
    game_provider::{
        compile_game_prompt, demo_output, initial_choices, opening_narrative, ProviderError,
    },
    game_store::{
        GameActionKind, GameOperationStatus, GameStore, GameStoreError, GameTurnRequest, WorldView,
    },
};

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: "playthrough-world-one".into(),
        title: "咸阳行旅：长期状态验证".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "林时".into(),
        narrative_style: "中文朴素叙事，重要决定交给玩家。".into(),
    }
}

fn new_world(path: &std::path::Path) -> GameStore {
    let store = GameStore::open(path).unwrap();
    let setup = setup();
    store
        .create_world(
            &setup,
            &initial_state(&setup).unwrap(),
            &opening_narrative(&setup),
            &initial_choices(),
        )
        .unwrap();
    store
}

fn request(view: &WorldView, index: usize, kind: GameActionKind, action: &str) -> GameTurnRequest {
    GameTurnRequest {
        operation_id: format!("playthrough-operation-{index:04}"),
        world_id: view.setup.world_id.clone(),
        branch_id: view.branch_id.clone(),
        expected_head_turn_id: view.head_turn_id.clone(),
        action_kind: kind,
        action_text: action.into(),
    }
}

fn advance(store: &GameStore, request: &GameTurnRequest) -> WorldView {
    let before = store.view().unwrap();
    store.begin(request).unwrap();
    store.mark_generating(&request.operation_id).unwrap();
    let output = demo_output(&before.state, request).unwrap();
    assert!(output.source_references.is_empty());
    assert!(output
        .uncertainties
        .iter()
        .any(|text| text.contains("演示")));
    let next = apply_output(&before.state, &output).unwrap();
    store
        .stage_output(
            &request.operation_id,
            &serde_json::to_string(&output).unwrap(),
        )
        .unwrap();
    let committed = store.commit(&request.operation_id, &output).unwrap();
    assert_eq!(committed.state, next);
    assert_eq!(
        committed.head_turn_id.as_deref(),
        Some(request.operation_id.as_str())
    );
    assert_eq!(
        committed.turns.last().unwrap().action_text,
        request.action_text
    );
    assert_eq!(committed.turns.last().unwrap().narrative, output.narrative);
    assert_eq!(
        committed.latest_operation.as_ref().unwrap().status,
        GameOperationStatus::Committed
    );
    committed
}

#[test]
fn ten_demo_turns_preserve_resources_injury_ooc_and_restart_exactly() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("十回合固定试玩.sqlite");
    let mut store = new_world(&path);
    let scenarios = [
        (GameActionKind::Action, "购买补给", 95, 3600, false),
        (
            GameActionKind::Action,
            "寻找短工赚取报酬",
            105,
            10800,
            false,
        ),
        (
            GameActionKind::Action,
            "向当地人打听消息",
            105,
            14400,
            false,
        ),
        (GameActionKind::Action, "不慎跌倒受伤", 105, 18000, true),
        (GameActionKind::Continue, "", 105, 21600, true),
        (GameActionKind::Action, "休息两小时", 105, 28800, false),
        (GameActionKind::Action, "购买补给", 100, 32400, false),
        (GameActionKind::Action, "工作赚钱", 110, 39600, false),
        (GameActionKind::Continue, "", 110, 43200, false),
        (
            GameActionKind::Action,
            "整理行囊，观察街道🙂",
            110,
            46800,
            false,
        ),
    ];
    let mut view = store.view().unwrap();
    let opening = view.clone();
    let mut last_request = None;
    for (index, (kind, action, amount, elapsed, injured)) in scenarios.iter().enumerate() {
        let action = request(&view, index, *kind, action);
        view = advance(&store, &action);
        assert_eq!(view.turn_count, index as u64 + 1);
        assert_eq!(view.state.resources[0].amount, *amount);
        assert_eq!(view.state.resources[0].unit, "记账单位");
        assert_eq!(view.state.time.elapsed_seconds, *elapsed);
        assert_eq!(view.state.time.era_year, -221);
        assert_eq!(view.state.location_id, "start-place");
        assert_eq!(view.state.events.len(), index + 1);
        assert_eq!(
            view.state
                .conditions
                .iter()
                .any(|condition| condition.active),
            *injured
        );
        assert_eq!(view.state.entities[0].alive, Some(true));
        last_request = Some(action);

        if index == 2 {
            let before = view.clone();
            view = store
                .update_policy("更详细描述观察，避免替主角决定。OOC不会成为主角对白。")
                .unwrap();
            assert_eq!(view.state, before.state);
            assert_eq!(view.head_turn_id, before.head_turn_id);
            assert_eq!(view.turn_count, before.turn_count);
            assert_eq!(view.turns, before.turns);
            assert_eq!(view.latest_operation, before.latest_operation);
            assert_eq!(view.opening_narrative, before.opening_narrative);
            assert_eq!(view.setup.narrative_style, before.setup.narrative_style);
            assert_ne!(view.narrative_policy, before.narrative_policy);
        }
        if index == 4 {
            let before_restart = view.clone();
            drop(store);
            store = GameStore::open(&path).unwrap();
            view = store.view().unwrap();
            assert_eq!(view, before_restart);
            assert!(view.state.conditions[0].active);
        }
    }
    assert_eq!(view.turns.len(), 10);
    assert_eq!(view.turns[0].state.resources[0].amount, 95);
    assert!(view.turns[3].state.conditions[0].active);
    assert!(!view.turns[5].state.conditions[0].active);
    assert!(view.turns[4].action_text.is_empty());
    assert_eq!(view.turns[4].action_kind, GameActionKind::Continue);
    assert_eq!(view.turns[0].parent_turn_id, None);
    for pair in view.turns.windows(2) {
        assert_eq!(
            pair[1].parent_turn_id.as_deref(),
            Some(pair[0].turn_id.as_str())
        );
    }
    assert_eq!(
        store.begin(last_request.as_ref().unwrap()),
        Err(GameStoreError::Duplicate)
    );
    assert_eq!(store.view().unwrap(), view);
    assert_eq!(view.opening_narrative, opening.opening_narrative);
    drop(store);
    let restored = GameStore::open(&path).unwrap().view().unwrap();
    assert_eq!(restored, view);
}

#[test]
fn death_and_rejected_resurrection_keep_committed_life_and_story_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("死亡状态.sqlite");
    let store = new_world(&path);
    let opening = store.view().unwrap();
    let death = request(&opening, 1, GameActionKind::Action, "死亡");
    let dead = advance(&store, &death);
    assert_eq!(dead.state.entities[0].alive, Some(false));
    let attempt = request(&dead, 2, GameActionKind::Action, "要求无依据复活");
    let mut invalid = demo_output(&opening.state, &attempt).unwrap();
    invalid.narrative = "主角无依据恢复存活，这是需要拒绝的模型输出。".into();
    invalid.state_changes = vec![StateChange::SetLifeStatus {
        entity_id: dead.state.protagonist_id.clone(),
        alive: true,
    }];
    assert_eq!(
        apply_output(&dead.state, &invalid),
        Err(GameError::DeadCannotRevive)
    );
    store.begin(&attempt).unwrap();
    store.mark_generating(&attempt.operation_id).unwrap();
    store
        .stage_output(
            &attempt.operation_id,
            &serde_json::to_string(&invalid).unwrap(),
        )
        .unwrap();
    assert_eq!(
        store.commit(&attempt.operation_id, &invalid),
        Err(GameStoreError::InvalidOutput)
    );
    store
        .finish_uncommitted(
            &attempt.operation_id,
            GameOperationStatus::Failed,
            Some(GameError::DeadCannotRevive.code()),
        )
        .unwrap();
    let rejected = store.view().unwrap();
    assert_eq!(rejected.state, dead.state);
    assert_eq!(rejected.head_turn_id, dead.head_turn_id);
    assert_eq!(rejected.turns, dead.turns);
    assert_eq!(rejected.turn_count, 1);
    assert_eq!(
        rejected
            .latest_operation
            .as_ref()
            .unwrap()
            .error_code
            .as_deref(),
        Some("game_dead_cannot_revive")
    );
    drop(store);
    assert_eq!(GameStore::open(&path).unwrap().view().unwrap(), rejected);
}

#[test]
fn complete_purchase_output_keeps_resource_units_and_strict_item_fields() {
    let mut state = initial_state(&setup()).unwrap();
    state.resources[0].amount = 115;
    let before = state.clone();
    let purchase = serde_json::json!({
        "protocolVersion": 1,
        "narrative": "你花五个记账单位买了一份口粮，余额为一百一十。",
        "choices": [{"id": "store-food", "text": "把口粮放进行囊"}],
        "timeAdvance": {"elapsedSeconds": 300},
        "stateChanges": [
            {"type": "create_entity", "entity": {
                "id": "food-ration-one", "kind": "item", "name": "口粮", "alive": null,
                "attributes": {"ownerId": "player", "quantity": "1"}
            }},
            {"type": "change_resource", "ownerId": "player", "key": "cash",
             "unit": "记账单位", "delta": -5, "expectedAmount": 115},
            {"type": "record_knowledge", "actorId": "player", "factId": "bought-food-one"}
        ],
        "events": [{"id": "bought-food-one", "description": "主角支付五个记账单位取得一份口粮。",
                    "entityIds": ["player", "food-ration-one"]}],
        "sourceReferences": [],
        "uncertainties": ["记账单位是游戏结算单位，尚未核实历史币值。"]
    });
    let output = parse_output(&purchase.to_string()).unwrap();
    let next = apply_output(&state, &output).unwrap();
    assert_eq!(state, before);
    assert_eq!(next.resources.len(), 1);
    assert_eq!(next.resources[0].amount, 110);
    assert_eq!(next.resources[0].unit, before.resources[0].unit);
    assert_eq!(next.time.elapsed_seconds, 300);
    let food = next
        .entities
        .iter()
        .find(|entity| entity.id == "food-ration-one")
        .unwrap();
    assert_eq!(food.alive, None);
    assert_eq!(
        food.attributes.get("ownerId").map(String::as_str),
        Some("player")
    );
    assert_eq!(
        food.attributes.get("quantity").map(String::as_str),
        Some("1")
    );
    assert!(next
        .known_facts
        .iter()
        .any(|fact| fact.actor_id == "player" && fact.fact_id == "bought-food-one"));

    let mut top_level_owner = purchase.clone();
    top_level_owner["stateChanges"][0]["entity"]["ownerId"] = serde_json::json!("player");
    let mut numeric_attribute = purchase.clone();
    numeric_attribute["stateChanges"][0]["entity"]["attributes"]["quantity"] = serde_json::json!(1);
    for malformed in [top_level_owner, numeric_attribute] {
        assert_eq!(
            parse_output(&malformed.to_string()),
            Err(GameError::InvalidOutput)
        );
        assert_eq!(state, before);
    }

    // A structurally valid purchase must still reject a replacement unit, even
    // after creating its provisional item; neither change becomes a fact.
    let mut wrong_unit = purchase;
    wrong_unit["stateChanges"][1]["unit"] = serde_json::json!("文");
    let invalid = parse_output(&wrong_unit.to_string()).unwrap();
    assert_eq!(
        apply_output(&state, &invalid),
        Err(GameError::InvalidResource)
    );
    assert_eq!(state, before);
    assert!(!state
        .entities
        .iter()
        .any(|entity| entity.id == "food-ration-one"));
}

#[test]
fn prompt_includes_formal_facts_and_policy_but_excludes_uncommitted_output() {
    let directory = tempfile::tempdir().unwrap();
    let selected = WorldSetup {
        narrative_style: "偏好缓慢推进，使用克制对白和具体感官描写。".into(),
        ..setup()
    };
    let store = GameStore::open(directory.path().join("上下文事实.sqlite")).unwrap();
    store
        .create_world(
            &selected,
            &initial_state(&selected).unwrap(),
            &opening_narrative(&selected),
            &initial_choices(),
        )
        .unwrap();
    let injury = request(
        &store.view().unwrap(),
        1,
        GameActionKind::Action,
        "受伤并记住旧街道",
    );
    let injured = advance(&store, &injury);
    store
        .update_policy("只描述主角能够观察到的事情，保留不确定性。")
        .unwrap();
    let view = store.view().unwrap();
    let pending = request(&view, 2, GameActionKind::Action, "准备调查城门");
    let mut provisional = demo_output(&view.state, &pending).unwrap();
    provisional.narrative = "UNCOMMITTED_FAKE_SECRET：未提交正文不得进入上下文。".into();
    store.begin(&pending).unwrap();
    store.mark_generating(&pending.operation_id).unwrap();
    store
        .stage_output(
            &pending.operation_id,
            &serde_json::to_string(&provisional).unwrap(),
        )
        .unwrap();
    let pending_view = store.view().unwrap();
    assert_eq!(pending_view.state, injured.state);
    let next = request(
        &pending_view,
        3,
        GameActionKind::Action,
        "检查行囊里的钥匙🔑",
    );
    let prompt = compile_game_prompt(&pending_view, &next).unwrap();
    assert!(prompt.len() <= 8192);
    assert!(prompt.contains(&serde_json::to_string(&pending_view.state).unwrap()));
    assert!(prompt.contains("林时"));
    assert!(prompt.contains("咸阳"));
    assert!(prompt.contains("-221"));
    assert!(prompt.contains(&selected.narrative_style));
    assert!(prompt.contains("只描述主角能够观察到的事情"));
    assert!(prompt.contains("受伤并记住旧街道"));
    assert!(prompt.contains("检查行囊里的钥匙🔑"));
    assert!(!prompt.contains("UNCOMMITTED_FAKE_SECRET"));
    assert!(!prompt.contains("准备调查城门"));
    store
        .finish_uncommitted(
            &pending.operation_id,
            GameOperationStatus::Cancelled,
            Some("game_cancelled"),
        )
        .unwrap();
    assert_eq!(store.view().unwrap().state, injured.state);
}

#[test]
fn oversized_required_context_is_rejected_without_dropping_facts_or_player_input() {
    let directory = tempfile::tempdir().unwrap();
    let store = new_world(&directory.path().join("上下文预算.sqlite"));
    let view = store.view().unwrap();
    let action = request(&view, 1, GameActionKind::Action, "观察街道");
    let mut large_state_view = view.clone();
    for index in 0..5 {
        large_state_view.state.entities[0].attributes.insert(
            format!("essential-fact-{index}"),
            format!("must-preserve-{index}-{}", "x".repeat(1900)),
        );
    }
    validate_state(&large_state_view.state).unwrap();
    assert_eq!(
        compile_game_prompt(&large_state_view, &action),
        Err(ProviderError::ContextTooLarge)
    );
    assert_eq!(store.view().unwrap(), view);

    let policy_view = store.update_policy(&"P".repeat(7500)).unwrap();
    assert_eq!(
        compile_game_prompt(&policy_view, &action),
        Err(ProviderError::ContextTooLarge)
    );
    store.update_policy(&view.narrative_policy).unwrap();
    let mut long_action = request(&view, 2, GameActionKind::Action, &"a".repeat(9000));
    long_action.action_text.push_str("中文行动完整保留🙂");
    store.begin(&long_action).unwrap();
    store.mark_generating(&long_action.operation_id).unwrap();
    let pending_view = store.view().unwrap();
    assert_eq!(
        compile_game_prompt(&pending_view, &long_action),
        Err(ProviderError::ContextTooLarge)
    );
    store
        .finish_uncommitted(
            &long_action.operation_id,
            GameOperationStatus::Failed,
            Some("game_context_too_large"),
        )
        .unwrap();
    let failed = store.view().unwrap();
    assert_eq!(failed.state, view.state);
    assert_eq!(failed.head_turn_id, view.head_turn_id);
    assert_eq!(failed.turn_count, 0);
    assert!(failed.turns.is_empty());
    assert_eq!(
        failed.latest_operation.as_ref().unwrap().action_text,
        long_action.action_text
    );
    assert_eq!(
        failed
            .latest_operation
            .as_ref()
            .unwrap()
            .error_code
            .as_deref(),
        Some("game_context_too_large")
    );
}
