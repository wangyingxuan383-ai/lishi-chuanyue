use lishi_core::{
    game_branches::{BranchEditRequest, ForkBranchRequest},
    game_migration::upgrade_v1,
    game_protocol::{initial_state, WorldSetup},
    game_protocol_v2::{initial_state_v2, StateChangeV2},
    game_provider_v2::demo_output_v2,
    game_store::{GameActionKind, GameOperationStatus, GameStore, GameStoreError, GameTurnRequest},
    game_store_v2::GameStoreV2,
};
use tempfile::TempDir;
fn setup() -> WorldSetup {
    WorldSetup {
        world_id: "branch-test-world-01".into(),
        title: "分支验证".into(),
        country: "唐".into(),
        era_year: 748,
        location_name: "长安".into(),
        protagonist_name: "李安".into(),
        narrative_style: "中文".into(),
    }
}
fn create() -> (TempDir, GameStoreV2) {
    let d = tempfile::tempdir().unwrap();
    let s = GameStoreV2::open(d.path().join("world.sqlite")).unwrap();
    s.create_world_v2(&setup(), &initial_state_v2(&setup()).unwrap(), "开局", &[])
        .unwrap();
    (d, s)
}
fn turn(s: &GameStoreV2, branch: &str, id: &str, action: &str) {
    let w = if s.branches_enabled().unwrap() {
        s.view_branch(branch).unwrap()
    } else {
        s.view().unwrap()
    };
    let r = GameTurnRequest {
        world_id: w.setup.world_id.clone(),
        branch_id: branch.into(),
        expected_head_turn_id: w.head_turn_id.clone(),
        operation_id: id.into(),
        action_kind: GameActionKind::Action,
        action_text: action.into(),
    };
    let out = demo_output_v2(&w.state, &r).unwrap();
    s.begin(&r).unwrap();
    s.mark_generating(id).unwrap();
    s.stage_output(id, &serde_json::to_string(&out).unwrap())
        .unwrap();
    s.commit(id, &out).unwrap();
}
fn fork(s: &GameStoreV2, source: &str, id: &str, at: Option<&str>, watermark: u64) {
    let c = s
        .list_branches()
        .unwrap()
        .into_iter()
        .find(|b| b.branch_id == source)
        .unwrap();
    s.fork_branch(
        &ForkBranchRequest {
            world_id: setup().world_id,
            source_branch_id: source.into(),
            expected_head_turn_id: c.head_turn_id,
            expected_revision: c.revision,
            operation_id: format!("fork-operation-{id}"),
            new_branch_id: id.into(),
            name: id.into(),
            fork_turn_id: at.map(str::to_owned),
        },
        watermark,
    )
    .unwrap();
}
fn edit(s: &GameStoreV2, b: &str, id: &str) -> BranchEditRequest {
    let c = s
        .list_branches()
        .unwrap()
        .into_iter()
        .find(|c| c.branch_id == b)
        .unwrap();
    BranchEditRequest {
        world_id: setup().world_id,
        branch_id: b.into(),
        expected_head_turn_id: c.head_turn_id,
        expected_revision: c.revision,
        operation_id: id.into(),
    }
}
#[test]
fn research_citation_ids_must_be_registered_before_validation_and_commit() {
    let (d, s) = create();
    s.enable_branches(&d.path().join("backups"), None).unwrap();
    let r = GameTurnRequest {
        world_id: setup().world_id,
        branch_id: "main".into(),
        expected_head_turn_id: None,
        operation_id: "citation-operation-01".into(),
        action_kind: GameActionKind::Action,
        action_text: "观察".into(),
    };
    let before = s.view().unwrap();
    let mut o = demo_output_v2(&before.state, &r).unwrap();
    o.source_references = vec!["source-registered-01".into()];
    s.begin(&r).unwrap();
    s.mark_generating(&r.operation_id).unwrap();
    s.stage_output(&r.operation_id, &serde_json::to_string(&o).unwrap())
        .unwrap();
    assert_eq!(
        s.commit(&r.operation_id, &o),
        Err(GameStoreError::InvalidOutput)
    );
    assert_eq!(s.view().unwrap().state, before.state);
    assert_eq!(
        s.allow_research_sources(&r.operation_id, &o.source_references),
        Err(GameStoreError::InvalidTransition)
    );
    s.finish_uncommitted(
        &r.operation_id,
        GameOperationStatus::Failed,
        Some("game_invalid_output"),
    )
    .unwrap();
    let mut r = r;
    r.operation_id = "citation-operation-02".into();
    let mut o = demo_output_v2(&before.state, &r).unwrap();
    o.source_references = vec!["source-registered-01".into()];
    s.begin(&r).unwrap();
    s.mark_generating(&r.operation_id).unwrap();
    s.allow_research_sources(&r.operation_id, &o.source_references)
        .unwrap();
    s.stage_output(&r.operation_id, &serde_json::to_string(&o).unwrap())
        .unwrap();
    let result = s.commit(&r.operation_id, &o).unwrap();
    assert_eq!(result.turn_count, 1);
    drop(s);
    let s = GameStoreV2::open(d.path().join("world.sqlite")).unwrap();
    assert_eq!(s.view().unwrap(), result);
    assert_eq!(
        s.allow_research_sources(&r.operation_id, &["source-forged-01".into()]),
        Err(GameStoreError::InvalidTransition)
    );
}
#[test]
fn explicit_correction_is_atomic_auditable_and_does_not_change_original() {
    use lishi_core::game_branches::FactCorrection;
    let (d, s) = create();
    turn(&s, "main", "correction-prefix-01", "工作");
    let before = s.view().unwrap();
    s.enable_branches(&d.path().join("backups"), before.head_turn_id.as_deref())
        .unwrap();
    let c = s.list_branches().unwrap().remove(0);
    let request = ForkBranchRequest {
        world_id: setup().world_id,
        source_branch_id: "main".into(),
        expected_head_turn_id: c.head_turn_id.clone(),
        expected_revision: c.revision,
        operation_id: "correction-fork-01".into(),
        new_branch_id: "corrected-branch-01".into(),
        name: "显式修正".into(),
        fork_turn_id: c.head_turn_id,
    };
    assert!(s
        .correct_fact_on_new_branch(
            &request,
            "correction-value-01",
            &FactCorrection::Cash { amount: -1 },
            0,
            0
        )
        .is_err());
    assert_eq!(s.list_branches().unwrap().len(), 1);
    let result = s
        .correct_fact_on_new_branch(
            &request,
            "correction-value-01",
            &FactCorrection::Cash { amount: 250 },
            0,
            0,
        )
        .unwrap();
    assert_eq!(result.world.state.resources[0].amount, 250);
    assert_eq!(
        result.world.state.time.elapsed_seconds,
        before.state.time.elapsed_seconds
    );
    assert_eq!(result.world.turn_count, 2);
    assert!(result
        .world
        .turns
        .last()
        .unwrap()
        .narrative
        .contains("玩家明确修正"));
    assert_eq!(s.view().unwrap(), before);
    assert!(s
        .correct_fact_on_new_branch(
            &request,
            "correction-value-01",
            &FactCorrection::Cash { amount: 300 },
            0,
            0
        )
        .is_err());
    drop(s);
    let s = GameStoreV2::open(d.path().join("world.sqlite")).unwrap();
    assert_eq!(s.view_branch("corrected-branch-01").unwrap(), result.world);
}
#[test]
fn same_head_annotation_add_delete_and_memory_cache_are_branch_scoped() {
    use lishi_core::{
        game_annotations::AnnotationStore,
        game_memory::{MemoryIndex, MemoryQuery, MemoryScope},
        game_protocol_v2::FactKey,
    };
    let (d, s) = create();
    turn(&s, "main", "annotation-prefix-01", "工作");
    s.enable_branches(&d.path().join("backups"), Some("annotation-prefix-01"))
        .unwrap();
    let notes = AnnotationStore::open(d.path().join("annotations.sqlite")).unwrap();
    let parent = s.read_branch_context("main").unwrap();
    let fact = FactKey::Resource {
        owner_id: "player".into(),
        key: "cash".into(),
    };
    notes
        .add_pin(
            &parent.annotation_scope,
            &parent.history,
            "pin-before-fork-01",
            &fact,
        )
        .unwrap();
    notes
        .add_bookmark(
            &parent.annotation_scope,
            &parent.history,
            "mark-before-fork-01",
            "annotation-prefix-01",
            "早期书签",
        )
        .unwrap();
    let watermark = notes.watermark().unwrap();
    fork(
        &s,
        "main",
        "annotation-child-01",
        Some("annotation-prefix-01"),
        watermark,
    );
    notes
        .add_pin(
            &parent.annotation_scope,
            &parent.history,
            "pin-after-fork-01",
            &FactKey::EntityName {
                entity_id: "player".into(),
            },
        )
        .unwrap();
    notes
        .remove_annotation(
            &parent.annotation_scope,
            &parent.history,
            "pin-before-fork-01",
        )
        .unwrap();
    let child = s.read_branch_context("annotation-child-01").unwrap();
    let inherited = notes.view(&child.annotation_scope, &child.history).unwrap();
    assert_eq!(inherited.pins.len(), 1);
    assert_eq!(inherited.pins[0].id, "pin-before-fork-01");
    notes
        .remove_annotation(
            &child.annotation_scope,
            &child.history,
            "pin-before-fork-01",
        )
        .unwrap();
    assert_eq!(
        notes
            .view(&child.annotation_scope, &child.history)
            .unwrap()
            .pins
            .len(),
        0
    );
    assert_eq!(
        notes
            .view(&parent.annotation_scope, &parent.history)
            .unwrap()
            .pins[0]
            .id,
        "pin-after-fork-01"
    );
    turn(&s, "main", "parent-secret-after-fork", "父线秘密暗号黑云");
    turn(
        &s,
        "annotation-child-01",
        "child-visible-after-fork",
        "子线暗号青石",
    );
    let mut index = MemoryIndex::open_sidecar(d.path().join("index.sqlite")).unwrap();
    let receipt = s
        .rebuild_memory_index_branch("annotation-child-01", &mut index)
        .unwrap();
    assert!(!receipt
        .scope
        .visible_turn_ids
        .iter()
        .any(|id| id == "parent-secret-after-fork"));
    let ids = receipt.scope.visible_turn_ids;
    let scope = MemoryScope {
        world_id: &setup().world_id,
        branch_id: "annotation-child-01",
        head_turn_id: Some("child-visible-after-fork"),
        visible_turn_ids: &ids,
    };
    let view = s.view_branch("annotation-child-01").unwrap();
    let query = MemoryQuery {
        query: "黑云".into(),
        ..MemoryQuery::recent(10)
    };
    assert!(index
        .retrieve(&scope, &query, &view.state, &[])
        .unwrap()
        .fragments
        .is_empty());
    let query = MemoryQuery {
        query: "青石".into(),
        ..MemoryQuery::recent(10)
    };
    assert_eq!(
        index
            .retrieve(&scope, &query, &view.state, &[])
            .unwrap()
            .fragments[0]
            .source
            .turn_id,
        "child-visible-after-fork"
    );
}
#[test]
fn ten_branches_have_correct_cash_names_origins_and_frozen_ancestors() {
    let (d, s) = create();
    turn(&s, "main", "before-fork-01", "工作");
    let baseline = s.view().unwrap();
    let receipt = s
        .enable_branches(&d.path().join("backups"), baseline.head_turn_id.as_deref())
        .unwrap();
    assert_eq!(receipt.to_version, 3);
    let backup = d.path().join("backups").join(receipt.backup_basename);
    let db = rusqlite::Connection::open(backup).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0))
            .unwrap(),
        2
    );
    drop(db);
    for n in 0..10 {
        fork(
            &s,
            "main",
            &format!("branch-fixed-{n:02}"),
            Some("before-fork-01"),
            12,
        );
    }
    turn(&s, "main", "future-main-rename", "改名李远");
    turn(&s, "main", "future-main-work", "工作");
    for n in 0..10 {
        let b = format!("branch-fixed-{n:02}");
        turn(&s, &b, &format!("child-turn-{n:02}"), "购买补给");
        let c = s.read_branch_context(&b).unwrap();
        assert_eq!(c.view.turn_count, 2);
        assert_eq!(c.view.state.entities[0].name, "李安");
        assert_eq!(c.view.state.resources[0].amount, 105);
        assert!(!c.history.contains_turn("future-main-rename"));
        assert_eq!(
            c.annotation_scope.branch_path[0].through_change_seq,
            Some(12)
        );
        assert_eq!(
            c.annotation_scope.branch_path[0].through_turn_id.as_deref(),
            Some("before-fork-01")
        );
        assert_eq!(
            c.history.visible_turn_ids(),
            vec!["before-fork-01".to_string(), format!("child-turn-{n:02}")]
        );
    }
    let main = s.view().unwrap();
    drop(s);
    let reopened = GameStoreV2::open(d.path().join("world.sqlite")).unwrap();
    assert_eq!(reopened.view().unwrap(), main);
    assert_eq!(reopened.list_branches().unwrap().len(), 11);
}
#[test]
fn nested_earlier_rewind_and_first_turn_rewrite_are_precise() {
    let (d, s) = create();
    for n in 1..=4 {
        turn(&s, "main", &format!("main-turn-{n:02}"), "工作");
    }
    s.enable_branches(&d.path().join("backups"), Some("main-turn-04"))
        .unwrap();
    fork(&s, "main", "parent-branch-01", Some("main-turn-04"), 20);
    turn(&s, "parent-branch-01", "parent-own-turn", "工作");
    fork(
        &s,
        "parent-branch-01",
        "rewound-branch-01",
        Some("main-turn-01"),
        30,
    );
    let c = s.read_branch_context("rewound-branch-01").unwrap();
    assert_eq!(c.view.turn_count, 1);
    assert_eq!(c.view.state.resources[0].amount, 110);
    assert!(!c.history.contains_turn("main-turn-02"));
    assert!(!c.history.contains_turn("parent-own-turn"));
    assert_eq!(
        c.annotation_scope.branch_path[0].through_turn_id.as_deref(),
        Some("main-turn-01")
    );
    assert_eq!(
        c.annotation_scope.branch_path[0].through_change_seq,
        Some(20)
    );
    let parent = s
        .list_branches()
        .unwrap()
        .into_iter()
        .find(|c| c.branch_id == "main")
        .unwrap();
    let r = ForkBranchRequest {
        world_id: setup().world_id,
        source_branch_id: "main".into(),
        expected_head_turn_id: parent.head_turn_id,
        expected_revision: parent.revision,
        operation_id: "rewrite-operation-01".into(),
        new_branch_id: "rewrite-branch-01".into(),
        name: "重写第一回合".into(),
        fork_turn_id: None,
    };
    let rewritten = s.rewrite_branch(&r, "main-turn-01", 40).unwrap();
    assert_eq!(rewritten.world.turn_count, 0);
    assert_eq!(rewritten.world.state.resources[0].amount, 100);
    assert_eq!(rewritten.original_action.unwrap().action_text, "工作");
}
#[test]
fn stale_duplicate_archive_restore_and_transaction_rollback() {
    let (d, s) = create();
    s.enable_branches(&d.path().join("backups"), None).unwrap();
    fork(&s, "main", "archive-branch-01", None, 0);
    turn(&s, "archive-branch-01", "archive-turn-01", "工作");
    let req = edit(&s, "archive-branch-01", "edit-archive-01");
    let old = s.view_branch("archive-branch-01").unwrap();
    s.archive_branch(&req).unwrap();
    assert!(s.rename_branch(&req, "旧revision").is_err());
    fork(&s, "main", "other-branch-01", None, 0);
    let c = s.view_branch("archive-branch-01").unwrap();
    let r = GameTurnRequest {
        world_id: setup().world_id,
        branch_id: c.branch_id,
        expected_head_turn_id: c.head_turn_id,
        operation_id: "archived-attempt-01".into(),
        action_kind: GameActionKind::Action,
        action_text: "工作".into(),
    };
    assert!(s.begin(&r).is_err());
    s.restore_branch(&edit(&s, "archive-branch-01", "restore-operation-01"))
        .unwrap();
    assert_eq!(s.view_branch("archive-branch-01").unwrap(), old);
    let mut r = r;
    r.operation_id = "rollback-operation-01".into();
    let out = demo_output_v2(&old.state, &r).unwrap();
    s.begin(&r).unwrap();
    s.mark_generating(&r.operation_id).unwrap();
    s.stage_output(&r.operation_id, &serde_json::to_string(&out).unwrap())
        .unwrap();
    assert_eq!(
        s.commit_with_hook(&r.operation_id, &out, || Err(GameStoreError::Cancelled)),
        Err(GameStoreError::Cancelled)
    );
    assert_eq!(s.view_branch("archive-branch-01").unwrap().state, old.state);
    s.finish_uncommitted(&r.operation_id, GameOperationStatus::Cancelled, None)
        .unwrap();
    assert_eq!(s.begin(&r), Err(GameStoreError::Duplicate));
    let mut stale = r;
    stale.operation_id = "stale-operation-01".into();
    stale.expected_head_turn_id = None;
    assert_eq!(s.begin(&stale), Err(GameStoreError::StaleHead));
}
#[test]
fn migrated_v1_fork_three_of_ten_excludes_future_raw_snapshots() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("old.sqlite");
    let v1 = GameStore::open(&path).unwrap();
    let set = setup();
    v1.create_world(&set, &initial_state(&set).unwrap(), "开局", &[])
        .unwrap();
    for n in 1..=10 {
        let w = v1.view().unwrap();
        let r = GameTurnRequest {
            world_id: set.world_id.clone(),
            branch_id: "main".into(),
            expected_head_turn_id: w.head_turn_id,
            operation_id: format!("legacy-turn-{n:02}"),
            action_kind: GameActionKind::Action,
            action_text: "工作".into(),
        };
        let out = lishi_core::game_provider::demo_output(&w.state, &r).unwrap();
        v1.begin(&r).unwrap();
        v1.mark_generating(&r.operation_id).unwrap();
        v1.stage_output(&r.operation_id, &serde_json::to_string(&out).unwrap())
            .unwrap();
        v1.commit(&r.operation_id, &out).unwrap();
    }
    drop(v1);
    std::fs::create_dir(d.path().join("v1backups")).unwrap();
    upgrade_v1(&path, d.path().join("v1backups")).unwrap();
    let s = GameStoreV2::open(&path).unwrap();
    let original = s.view().unwrap();
    s.enable_branches(&d.path().join("v2backups"), Some("legacy-turn-10"))
        .unwrap();
    fork(&s, "main", "legacy-fork-three", Some("legacy-turn-03"), 0);
    let c = s.read_branch_context("legacy-fork-three").unwrap();
    assert_eq!(c.view.turn_count, 3);
    assert_eq!(c.view.state.resources[0].amount, 130);
    assert!(!c.history.contains_turn("legacy-turn-04"));
    turn(&s, "legacy-fork-three", "legacy-child-own", "购买补给");
    assert_eq!(
        s.view_branch("legacy-fork-three").unwrap().state.resources[0].amount,
        125
    );
    assert_eq!(s.view().unwrap(), original);
}
#[test]
fn future_death_and_private_events_do_not_enter_child() {
    let (d, s) = create();
    turn(&s, "main", "live-prefix-01", "工作");
    s.enable_branches(&d.path().join("backups"), Some("live-prefix-01"))
        .unwrap();
    fork(&s, "main", "living-child-01", Some("live-prefix-01"), 0);
    let w = s.view().unwrap();
    let r = GameTurnRequest {
        world_id: setup().world_id,
        branch_id: "main".into(),
        expected_head_turn_id: w.head_turn_id,
        operation_id: "death-parent-01".into(),
        action_kind: GameActionKind::Action,
        action_text: "危险".into(),
    };
    let mut o = demo_output_v2(&w.state, &r).unwrap();
    let e = o.events[0].id.clone();
    o.choices.clear();
    o.events[0].entity_ids = vec!["player".into()];
    o.state_changes = vec![StateChangeV2::SetLifeStatus {
        entity_id: "player".into(),
        alive: false,
        event_id: e,
    }];
    s.begin(&r).unwrap();
    s.mark_generating(&r.operation_id).unwrap();
    s.stage_output(&r.operation_id, &serde_json::to_string(&o).unwrap())
        .unwrap();
    s.commit(&r.operation_id, &o).unwrap();
    let child = s.read_branch_context("living-child-01").unwrap();
    assert_eq!(child.view.state.entities[0].alive, Some(true));
    assert!(!child.history.contains_turn("death-parent-01"));
    assert_eq!(s.view().unwrap().state.entities[0].alive, Some(false));
}
