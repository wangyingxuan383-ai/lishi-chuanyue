//! Independent branch-boundary regressions. All databases are temporary.
use lishi_core::{
    game_branches::{FactCorrection, ForkBranchRequest},
    game_migration::upgrade_v1,
    game_protocol::{initial_state, WorldSetup},
    game_protocol_v2::{initial_state_v2, Disclosure, StateChangeV2},
    game_provider_v2::demo_output_v2,
    game_store::{GameActionKind, GameOperationStatus, GameStore, GameStoreError, GameTurnRequest},
    game_store_v2::GameStoreV2,
};
use tempfile::TempDir;

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: "branch-review-world-01".into(),
        title: "独立分支边界回归".into(),
        country: "唐".into(),
        era_year: 748,
        location_name: "长安".into(),
        protagonist_name: "李安".into(),
        narrative_style: "中文".into(),
    }
}

fn create() -> (TempDir, GameStoreV2) {
    let directory = tempfile::tempdir().unwrap();
    let store = GameStoreV2::open(directory.path().join("world.sqlite")).unwrap();
    store
        .create_world_v2(&setup(), &initial_state_v2(&setup()).unwrap(), "开局", &[])
        .unwrap();
    store
        .enable_branches(&directory.path().join("backups"), None)
        .unwrap();
    (directory, store)
}

fn correction_request(store: &GameStoreV2) -> ForkBranchRequest {
    let card = store
        .list_branches()
        .unwrap()
        .into_iter()
        .find(|branch| branch.branch_id == "main")
        .unwrap();
    ForkBranchRequest {
        world_id: setup().world_id,
        source_branch_id: "main".into(),
        expected_head_turn_id: card.head_turn_id.clone(),
        expected_revision: card.revision,
        operation_id: "review-correction-fork-01".into(),
        new_branch_id: "review-corrected-branch-01".into(),
        name: "修正新线".into(),
        fork_turn_id: card.head_turn_id,
    }
}

#[test]
fn legal_maximum_operation_id_can_create_a_short_auditable_correction_event() {
    let (directory, store) = create();
    let before = store.view().unwrap();
    let operation_id = "c".repeat(128);
    let request = correction_request(&store);
    let result = store
        .correct_fact_on_new_branch(
            &request,
            &operation_id,
            &FactCorrection::Name {
                name: "李平".into(),
            },
            0,
            0,
        )
        .expect("a valid operation ID must not become an oversized event ID");
    assert_eq!(
        result.world.head_turn_id.as_deref(),
        Some(operation_id.as_str())
    );
    assert_eq!(result.world.state.entities[0].name, "李平");
    assert!(result.world.state.events.last().unwrap().id.len() <= 64);
    assert_eq!(store.view().unwrap(), before);
    drop(store);
    let reopened = GameStoreV2::open(directory.path().join("world.sqlite")).unwrap();
    assert_eq!(
        reopened.view_branch(&request.new_branch_id).unwrap(),
        result.world
    );
}

#[test]
fn cash_correction_requires_the_current_amount_to_be_player_known() {
    let (_directory, store) = create();
    let opening = store.view().unwrap();
    let request = GameTurnRequest {
        world_id: setup().world_id,
        branch_id: "main".into(),
        expected_head_turn_id: opening.head_turn_id,
        operation_id: "review-hidden-cash-change".into(),
        action_kind: GameActionKind::Action,
        action_text: "继续等待".into(),
    };
    let mut output = demo_output_v2(&opening.state, &request).unwrap();
    let event_id = output.events[0].id.clone();
    output.events[0].disclosure = Disclosure::Restricted;
    output.narrative = "你仍在等候，没有清点资产。".into();
    output.state_changes = vec![StateChangeV2::ChangeResource {
        owner_id: "player".into(),
        key: "cash".into(),
        unit: opening.state.resources[0].unit.clone(),
        delta: 30,
        expected_amount: Some(opening.state.resources[0].amount),
        event_id,
    }];
    store.begin(&request).unwrap();
    store.mark_generating(&request.operation_id).unwrap();
    store
        .stage_output(
            &request.operation_id,
            &serde_json::to_string(&output).unwrap(),
        )
        .unwrap();
    store.commit(&request.operation_id, &output).unwrap();
    let before = store.view().unwrap();
    let context = store.read_branch_context("main").unwrap();
    let grants =
        lishi_core::game_knowledge::initial_visible_grants(&context.history, "player").unwrap();
    let visibility = lishi_core::game_knowledge::SourceVisibilityIndex::from_recorded_observations(
        &context.history,
        grants,
    )
    .unwrap();
    let known = lishi_core::game_knowledge::observed_facts_for_actor(
        &context.history,
        &visibility,
        "player",
    )
    .unwrap();
    let cash = known
        .iter()
        .find(|fact| matches!(&fact.fact_key, lishi_core::game_protocol_v2::FactKey::Resource { key, .. } if key == "cash"))
        .unwrap();
    assert_eq!(cash.value["amount"], 100);
    assert_eq!(before.state.resources[0].amount, 130);
    assert!(matches!(
        store.correct_fact_on_new_branch(
            &correction_request(&store),
            "review-correction-hidden-cash",
            &FactCorrection::Cash { amount: 250 },
            0,
            0,
        ),
        Err(GameStoreError::InvalidRequest)
    ));
    assert_eq!(store.list_branches().unwrap().len(), 1);
    assert_eq!(store.view().unwrap(), before);
}

#[test]
fn malformed_failed_operation_is_rejected_before_schema_three_recovery() {
    let (directory, store) = create();
    let request = GameTurnRequest {
        world_id: setup().world_id,
        branch_id: "main".into(),
        expected_head_turn_id: None,
        operation_id: "review-failed-operation".into(),
        action_kind: GameActionKind::Action,
        action_text: "继续等待".into(),
    };
    store.begin(&request).unwrap();
    store
        .finish_uncommitted(
            &request.operation_id,
            GameOperationStatus::Failed,
            Some("game_invalid_output"),
        )
        .unwrap();
    drop(store);
    let path = directory.path().join("world.sqlite");
    let database = rusqlite::Connection::open(&path).unwrap();
    database
        .execute(
            "UPDATE game_operations SET error_code='unsafe external text with spaces' WHERE operation_id=?1",
            [&request.operation_id],
        )
        .unwrap();
    drop(database);
    assert!(matches!(
        GameStoreV2::open(&path),
        Err(GameStoreError::Database)
    ));
    let database = rusqlite::Connection::open(&path).unwrap();
    let status: String = database
        .query_row(
            "SELECT status FROM game_operations WHERE operation_id=?1",
            [&request.operation_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "failed");
}

#[test]
fn legacy_origins_cover_the_complete_selected_path_beyond_the_recent_window() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy.sqlite");
    let legacy = GameStore::open(&path).unwrap();
    legacy
        .create_world(&setup(), &initial_state(&setup()).unwrap(), "开局", &[])
        .unwrap();
    for index in 1..=101 {
        let view = legacy.view().unwrap();
        let request = GameTurnRequest {
            world_id: setup().world_id,
            branch_id: "main".into(),
            expected_head_turn_id: view.head_turn_id,
            operation_id: format!("review-legacy-turn-{index:03}"),
            action_kind: GameActionKind::Action,
            action_text: "等待".into(),
        };
        let output = lishi_core::game_provider::demo_output(&view.state, &request).unwrap();
        legacy.begin(&request).unwrap();
        legacy.mark_generating(&request.operation_id).unwrap();
        legacy
            .stage_output(
                &request.operation_id,
                &serde_json::to_string(&output).unwrap(),
            )
            .unwrap();
        legacy.commit(&request.operation_id, &output).unwrap();
    }
    drop(legacy);
    let backup = directory.path().join("v1-backups");
    std::fs::create_dir(&backup).unwrap();
    upgrade_v1(&path, &backup).unwrap();
    let store = GameStoreV2::open(&path).unwrap();
    store
        .enable_branches(
            &directory.path().join("v2-backups"),
            Some("review-legacy-turn-101"),
        )
        .unwrap();
    let context = store.read_branch_context("main").unwrap();
    assert_eq!(context.history.visible_turn_ids().len(), 101);
    assert_eq!(context.view.turns.len(), 100);
    assert_eq!(context.origins, vec!["main"; 101]);
}
