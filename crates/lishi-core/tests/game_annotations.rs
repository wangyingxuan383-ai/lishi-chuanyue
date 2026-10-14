use std::collections::BTreeMap;

use lishi_core::{
    game_annotations::{
        AnnotationBranchAccess, AnnotationError, AnnotationScope, AnnotationStore,
        SummaryAttemptStatus, SummaryCostKind, SummaryFailure, SummaryOperation, SummaryPlan,
        SummarySourceTurn, SummaryStatus, SummaryUsage,
    },
    game_context::{ContextFragmentStatus, ContextScope},
    game_knowledge::{CommittedHistoryEntry, ValidatedHistory},
    game_protocol::{EntityKind, WorldSetup},
    game_protocol_v2::{
        apply_output_v2, initial_state_v2, CommitContext, Disclosure, EntityInput, EventInput,
        FactKey, StateChangeV2, TimeAdvanceV2, TurnOutputV2, WorldStateV2,
    },
    game_provider_v2::demo_output_v2,
    game_store::{GameActionKind, GameTurnRequest},
    game_store_v2::GameStoreV2,
};

const WORLD: &str = "annotations-test-world";

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: WORLD.into(),
        title: "提醒与摘要".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "李明".into(),
        narrative_style: "事实不被派生内容改写".into(),
    }
}
fn initial() -> WorldStateV2 {
    initial_state_v2(&setup()).unwrap()
}
fn request(id: &str, action: &str, head: Option<&str>) -> GameTurnRequest {
    GameTurnRequest {
        operation_id: id.into(),
        world_id: WORLD.into(),
        branch_id: "main".into(),
        expected_head_turn_id: head.map(str::to_owned),
        action_kind: GameActionKind::Action,
        action_text: action.into(),
    }
}
fn append(
    initial: &WorldStateV2,
    entries: &mut Vec<CommittedHistoryEntry>,
    id: &str,
    output: TurnOutputV2,
) {
    let previous = entries.last().map_or(initial, |entry| &entry.state);
    let state = apply_output_v2(
        previous,
        &output,
        &CommitContext {
            operation_id: id.into(),
            turn_id: id.into(),
        },
    )
    .unwrap();
    entries.push(CommittedHistoryEntry {
        operation_id: id.into(),
        turn_id: id.into(),
        parent_turn_id: entries.last().map(|entry| entry.turn_id.clone()),
        output,
        state,
    });
}
fn demo(initial: &WorldStateV2, entries: &mut Vec<CommittedHistoryEntry>, id: &str, action: &str) {
    let previous = entries.last().map_or(initial, |entry| &entry.state);
    let req = request(
        id,
        action,
        entries.last().map(|entry| entry.turn_id.as_str()),
    );
    let output = demo_output_v2(previous, &req).unwrap();
    append(initial, entries, id, output);
}
fn history(initial: &WorldStateV2, entries: &[CommittedHistoryEntry]) -> ValidatedHistory {
    ValidatedHistory::new(
        WORLD,
        initial.clone(),
        entries.to_vec(),
        entries.last().map(|entry| entry.turn_id.as_str()),
    )
    .unwrap()
}
fn scope(history: &ValidatedHistory, branch: &str) -> AnnotationScope {
    AnnotationScope::single(ContextScope {
        world_id: WORLD.into(),
        branch_id: branch.into(),
        head_turn_id: history.head_turn_id().map(str::to_owned),
    })
}
fn sources(entries: &[CommittedHistoryEntry]) -> Vec<SummarySourceTurn<'_>> {
    entries
        .iter()
        .map(|entry| SummarySourceTurn {
            turn_id: &entry.turn_id,
            narrative: &entry.output.narrative,
        })
        .collect()
}
fn plan(id: &str) -> SummaryPlan {
    SummaryPlan {
        operation_id: id.into(),
        provider: "fixed-test-provider".into(),
        model: "fixed-test-model".into(),
        prompt_version: 3,
    }
}
fn finish_test_summary(
    store: &AnnotationStore,
    scope: &AnnotationScope,
    history: &ValidatedHistory,
    id: &str,
    body: &str,
) -> SummaryOperation {
    let attempt = store.reserve_model_request(scope, history, id).unwrap();
    store
        .finish_summary(
            scope,
            history,
            id,
            attempt.attempt_number,
            body,
            SummaryUsage::default(),
        )
        .unwrap()
}
fn cash() -> FactKey {
    FactKey::Resource {
        owner_id: "player".into(),
        key: "cash".into(),
    }
}
fn life() -> FactKey {
    FactKey::EntityLife {
        entity_id: "player".into(),
    }
}

#[test]
fn pins_bookmarks_completed_summary_and_unknown_usage_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("中文注释.sqlite");
    let initial = initial();
    let mut entries = Vec::new();
    demo(&initial, &mut entries, "annotations-first-turn", "购买口粮");
    let history = history(&initial, &entries);
    let scope = scope(&history, "main");
    let store = AnnotationStore::open(&path).unwrap();
    store
        .add_pin(&scope, &history, "cash-reminder", &cash())
        .unwrap();
    store
        .add_bookmark(
            &scope,
            &history,
            "chapter-bookmark",
            &entries[0].turn_id,
            "初次购买🔑🙂",
        )
        .unwrap();
    let operation = store
        .begin_summary(
            &scope,
            &history,
            &plan("summary-first-operation"),
            &sources(&entries),
        )
        .unwrap();
    assert_eq!(operation.model_requests_reserved, 0);
    let attempt = store
        .reserve_model_request(&scope, &history, &operation.plan.operation_id)
        .unwrap();
    let completed = store
        .finish_summary(
            &scope,
            &history,
            &operation.plan.operation_id,
            attempt.attempt_number,
            "买得口粮，资金95；派生摘要。",
            SummaryUsage::default(),
        )
        .unwrap();
    assert_eq!(completed.attempts[0].usage, SummaryUsage::default());
    assert_eq!(completed.plan.prompt_version, 3);
    let before = store.view(&scope, &history).unwrap();
    let pin = before.pins[0].context_pin(&scope, &history).unwrap();
    assert_eq!(pin.fact_key, cash());
    let fragment = before.summaries[0]
        .context_fragment(&scope, &history)
        .unwrap();
    assert_eq!(fragment.status, ContextFragmentStatus::Committed);
    assert_eq!(
        fragment.scope.head_turn_id,
        history.head_turn_id().map(str::to_owned)
    );
    assert_eq!(fragment.source_turn_ids, [entries[0].turn_id.clone()]);
    drop(store);
    let reopened = AnnotationStore::open(path).unwrap();
    assert_eq!(reopened.view(&scope, &history).unwrap(), before);
    assert_eq!(
        reopened
            .validate_rebuild_sources(
                &scope,
                &history,
                &completed.plan.operation_id,
                &sources(&entries)
            )
            .unwrap(),
        completed.sources
    );
    assert_eq!(history.current_state().resources[0].amount, 95);
    assert_eq!(entries[0].output.narrative, sources(&entries)[0].narrative);
}

#[test]
fn pinning_and_removing_cannot_revive_people_or_change_assets() {
    let dir = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(dir.path().join("pins.sqlite")).unwrap();
    let initial = initial();
    let empty_history = history(&initial, &[]);
    let initial_scope = scope(&empty_history, "main");
    let original_pin = store
        .add_pin(&initial_scope, &empty_history, "life-reminder", &life())
        .unwrap();
    store
        .add_pin(&initial_scope, &empty_history, "money-reminder", &cash())
        .unwrap();
    let mut entries = Vec::new();
    demo(&initial, &mut entries, "annotations-fatal-turn", "死亡");
    let current = history(&initial, &entries);
    let scope = scope(&current, "main");
    let before = current.current_state().clone();
    let view = store.view(&scope, &current).unwrap();
    assert_eq!(view.pins.len(), 2);
    assert_eq!(
        original_pin.context_pin(&scope, &current).unwrap().fact_key,
        life()
    );
    store
        .remove_annotation(&scope, &current, "money-reminder")
        .unwrap();
    assert_eq!(store.view(&scope, &current).unwrap().pins.len(), 1);
    assert_eq!(current.current_state(), &before);
    assert_eq!(before.entities[0].alive, Some(false));
    assert_eq!(before.resources[0].amount, 100);
    assert_eq!(
        store.add_pin(
            &scope,
            &current,
            "unknown-reminder",
            &FactKey::Condition {
                condition_id: "missing".into()
            }
        ),
        Err(AnnotationError::UnknownFact)
    );
}

#[test]
fn hidden_and_stale_known_facts_cannot_be_promoted_by_pinning() {
    let dir = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(dir.path().join("hidden.sqlite")).unwrap();
    let initial = initial();
    let before = history(&initial, &[]);
    let before_scope = scope(&before, "main");
    let pin = store
        .add_pin(&before_scope, &before, "old-cash-pin", &cash())
        .unwrap();
    let mut entries = Vec::new();
    append(
        &initial,
        &mut entries,
        "annotations-secret-turn",
        TurnOutputV2 {
            protocol_version: 2,
            narrative: "主角不知道这个秘密。".into(),
            choices: vec![],
            time_advance: TimeAdvanceV2 {
                elapsed_seconds: 0,
                event_id: None,
            },
            state_changes: vec![
                StateChangeV2::CreateEntity {
                    entity: EntityInput {
                        id: "npc".into(),
                        kind: EntityKind::Person,
                        name: "王安".into(),
                        alive: Some(true),
                        attributes: BTreeMap::from([("secret".into(), "不能泄露的值".into())]),
                    },
                    event_id: "secret".into(),
                },
                StateChangeV2::ChangeResource {
                    owner_id: "player".into(),
                    key: "cash".into(),
                    unit: "记账单位".into(),
                    delta: -5,
                    expected_amount: Some(100),
                    event_id: "secret".into(),
                },
            ],
            events: vec![EventInput {
                id: "secret".into(),
                description: "客观变化，不向主角授予认知。".into(),
                entity_ids: vec!["player".into(), "npc".into()],
                disclosure: Disclosure::Restricted,
            }],
            source_references: vec![],
            uncertainties: vec![],
        },
    );
    let current = history(&initial, &entries);
    let scope = scope(&current, "main");
    assert_eq!(
        store.add_pin(
            &scope,
            &current,
            "secret-pin",
            &FactKey::EntityAttribute {
                entity_id: "npc".into(),
                key: "secret".into()
            }
        ),
        Err(AnnotationError::HiddenFact)
    );
    assert_eq!(
        store.add_pin(&scope, &current, "new-cash-pin", &cash()),
        Err(AnnotationError::HiddenFact)
    );
    assert!(store.view(&scope, &current).unwrap().pins.is_empty());
    assert_eq!(
        pin.context_pin(&scope, &current).unwrap_err(),
        AnnotationError::HiddenFact
    );
    assert_eq!(current.current_state().resources[0].amount, 95);
}

#[test]
fn forks_inherit_only_prior_configuration_and_deletions_stay_on_visible_branch() {
    let dir = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(dir.path().join("branches.sqlite")).unwrap();
    let initial = initial();
    let mut main_entries = Vec::new();
    demo(
        &initial,
        &mut main_entries,
        "annotations-common-turn",
        "整理行囊",
    );
    let common = history(&initial, &main_entries);
    let common_scope = scope(&common, "main");
    store
        .add_pin(&common_scope, &common, "early-pin", &cash())
        .unwrap();
    store
        .add_bookmark(
            &common_scope,
            &common,
            "early-bookmark",
            &main_entries[0].turn_id,
            "分叉之前",
        )
        .unwrap();
    store
        .begin_summary(
            &common_scope,
            &common,
            &plan("summary-inherited"),
            &sources(&main_entries),
        )
        .unwrap();
    store
        .reserve_model_request(&common_scope, &common, "summary-inherited")
        .unwrap();
    store
        .finish_summary(
            &common_scope,
            &common,
            "summary-inherited",
            1,
            "分叉前的原文摘要",
            SummaryUsage::default(),
        )
        .unwrap();
    let fork_watermark = store.watermark().unwrap();
    demo(
        &initial,
        &mut main_entries,
        "annotations-main-future",
        "工作赚钱",
    );
    let future = history(&initial, &main_entries);
    let future_scope = scope(&future, "main");
    store
        .remove_annotation(&future_scope, &future, "early-pin")
        .unwrap();
    store
        .add_pin(&future_scope, &future, "future-pin", &cash())
        .unwrap();
    store
        .begin_summary(
            &future_scope,
            &future,
            &plan("summary-cross-fork"),
            &sources(&main_entries),
        )
        .unwrap();
    store
        .reserve_model_request(&future_scope, &future, "summary-cross-fork")
        .unwrap();
    store
        .finish_summary(
            &future_scope,
            &future,
            "summary-cross-fork",
            1,
            "覆盖父分支未来的摘要",
            SummaryUsage::default(),
        )
        .unwrap();
    let mut child_entries = main_entries[..1].to_vec();
    demo(
        &initial,
        &mut child_entries,
        "annotations-child-turn",
        "购买口粮",
    );
    let child_history = history(&initial, &child_entries);
    let child = AnnotationScope {
        context: scope(&child_history, "child").context,
        branch_path: vec![
            AnnotationBranchAccess {
                branch_id: "main".into(),
                through_turn_id: Some(main_entries[0].turn_id.clone()),
                through_change_seq: Some(fork_watermark),
            },
            AnnotationBranchAccess {
                branch_id: "child".into(),
                through_turn_id: Some(child_entries[1].turn_id.clone()),
                through_change_seq: None,
            },
        ],
    };
    let view = store.view(&child, &child_history).unwrap();
    assert_eq!(
        view.pins
            .iter()
            .map(|pin| pin.id.as_str())
            .collect::<Vec<_>>(),
        ["early-pin"]
    );
    assert_eq!(view.bookmarks.len(), 1);
    assert_eq!(view.summaries.len(), 1);
    assert_eq!(view.summaries[0].plan.operation_id, "summary-inherited");
    assert_eq!(
        view.summaries[0]
            .context_fragment(&child, &child_history)
            .unwrap()
            .scope
            .branch_id,
        "child"
    );
    store
        .remove_annotation(&child, &child_history, "early-bookmark")
        .unwrap();
    assert!(store
        .view(&child, &child_history)
        .unwrap()
        .bookmarks
        .is_empty());
    assert_eq!(
        store.view(&future_scope, &future).unwrap().bookmarks.len(),
        1
    );
    store
        .add_pin(&child, &child_history, "child-only-pin", &life())
        .unwrap();
    assert!(!store
        .view(&future_scope, &future)
        .unwrap()
        .pins
        .iter()
        .any(|pin| pin.id == "child-only-pin"));
    // A sibling at the exact same fork node does not inherit child revisions.
    let sibling = AnnotationScope {
        context: scope(&common, "sibling").context,
        branch_path: vec![
            AnnotationBranchAccess {
                branch_id: "main".into(),
                through_turn_id: common.head_turn_id().map(str::to_owned),
                through_change_seq: Some(fork_watermark),
            },
            AnnotationBranchAccess {
                branch_id: "sibling".into(),
                through_turn_id: common.head_turn_id().map(str::to_owned),
                through_change_seq: None,
            },
        ],
    };
    assert_eq!(store.view(&sibling, &common).unwrap().pins.len(), 1);
    assert_eq!(store.view(&sibling, &common).unwrap().bookmarks.len(), 1);
}

#[test]
fn summary_sources_must_be_exact_contiguous_committed_originals() {
    let dir = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(dir.path().join("sources.sqlite")).unwrap();
    let initial = initial();
    let mut entries = Vec::new();
    for n in 0..3 {
        demo(
            &initial,
            &mut entries,
            &format!("annotations-source-{n}"),
            "整理行囊",
        );
    }
    let history = history(&initial, &entries);
    let scope = scope(&history, "main");
    let mut reversed = sources(&entries);
    reversed.reverse();
    assert_eq!(
        store.begin_summary(&scope, &history, &plan("summary-reversed"), &reversed),
        Err(AnnotationError::InvalidInput)
    );
    let skipped = vec![sources(&entries)[0].clone(), sources(&entries)[2].clone()];
    assert_eq!(
        store.begin_summary(&scope, &history, &plan("summary-skipped"), &skipped),
        Err(AnnotationError::InvalidInput)
    );
    let forged = [SummarySourceTurn {
        turn_id: &entries[0].turn_id,
        narrative: "把旧摘要冒充原文",
    }];
    assert_eq!(
        store.begin_summary(&scope, &history, &plan("summary-forged"), &forged),
        Err(AnnotationError::InvisibleSource)
    );
    let pending = [SummarySourceTurn {
        turn_id: "uncommitted-id",
        narrative: "待提交草稿",
    }];
    assert_eq!(
        store.begin_summary(&scope, &history, &plan("summary-pending"), &pending),
        Err(AnnotationError::InvisibleSource)
    );
    assert_eq!(
        store.add_bookmark(
            &scope,
            &history,
            "pending-bookmark",
            "uncommitted-id",
            "草稿"
        ),
        Err(AnnotationError::InvisibleSource)
    );
    let valid = sources(&entries);
    store
        .begin_summary(&scope, &history, &plan("summary-valid"), &valid)
        .unwrap();
    assert_eq!(
        store.begin_summary(&scope, &history, &plan("summary-valid"), &valid),
        Err(AnnotationError::Duplicate)
    );
    assert_eq!(
        store.validate_rebuild_sources(&scope, &history, "summary-valid", &forged),
        Err(AnnotationError::InvisibleSource)
    );
    assert_eq!(
        store
            .validate_rebuild_sources(&scope, &history, "summary-valid", &valid)
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn summary_failure_defer_retry_and_second_failure_enforce_two_request_budget() {
    let dir = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(dir.path().join("budget.sqlite")).unwrap();
    let initial = initial();
    let mut entries = Vec::new();
    demo(
        &initial,
        &mut entries,
        "annotations-budget-turn",
        "整理行囊",
    );
    let history = history(&initial, &entries);
    let scope = scope(&history, "main");
    let formal = history.current_state().clone();
    store
        .begin_summary(
            &scope,
            &history,
            &plan("summary-budget-test"),
            &sources(&entries),
        )
        .unwrap();
    store
        .defer_summary(&scope, &history, "summary-budget-test")
        .unwrap();
    assert_eq!(
        store.summary_operations(&scope, &history, 8).unwrap()[0].model_requests_reserved,
        0
    );
    let first = store
        .reserve_model_request(&scope, &history, "summary-budget-test")
        .unwrap();
    assert_eq!(first.attempt_number, 1);
    assert_eq!(
        store.reserve_model_request(&scope, &history, "summary-budget-test"),
        Err(AnnotationError::InvalidTransition)
    );
    assert_eq!(
        store.finish_summary(
            &scope,
            &history,
            "summary-budget-test",
            1,
            " ",
            SummaryUsage::default()
        ),
        Err(AnnotationError::InvalidInput)
    );
    store
        .fail_attempt(
            &scope,
            &history,
            "summary-budget-test",
            1,
            SummaryFailure::InvalidOutput,
            SummaryUsage::default(),
        )
        .unwrap();
    store
        .defer_summary(&scope, &history, "summary-budget-test")
        .unwrap();
    let second = store
        .reserve_model_request(&scope, &history, "summary-budget-test")
        .unwrap();
    assert_eq!(second.attempt_number, 2);
    let failed = store
        .fail_attempt(
            &scope,
            &history,
            "summary-budget-test",
            2,
            SummaryFailure::Network,
            SummaryUsage::default(),
        )
        .unwrap();
    assert_eq!(failed.status, SummaryStatus::Failed);
    assert_eq!(failed.model_requests_reserved, 2);
    assert_eq!(
        store.reserve_model_request(&scope, &history, "summary-budget-test"),
        Err(AnnotationError::BudgetExhausted)
    );
    assert!(store.view(&scope, &history).unwrap().summaries.is_empty());
    assert_eq!(history.current_state(), &formal);
    let mut advanced = entries.clone();
    demo(
        &initial,
        &mut advanced,
        "annotations-after-summary-failure",
        "工作赚钱",
    );
    assert_eq!(
        self::history(&initial, &advanced).current_state().resources[0].amount,
        110
    );
    assert_eq!(advanced[0], entries[0]);
}

#[test]
fn cancellation_and_process_reopen_preserve_counts_without_automatic_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recovery.sqlite");
    let initial = initial();
    let mut entries = Vec::new();
    demo(
        &initial,
        &mut entries,
        "annotations-recovery-turn",
        "整理行囊",
    );
    let history = history(&initial, &entries);
    let scope = scope(&history, "main");
    let store = AnnotationStore::open(&path).unwrap();
    for id in [
        "summary-pending",
        "summary-running",
        "summary-deferred",
        "summary-cancelled",
    ] {
        store
            .begin_summary(&scope, &history, &plan(id), &sources(&entries))
            .unwrap();
    }
    store
        .reserve_model_request(&scope, &history, "summary-running")
        .unwrap();
    store
        .defer_summary(&scope, &history, "summary-deferred")
        .unwrap();
    store
        .reserve_model_request(&scope, &history, "summary-cancelled")
        .unwrap();
    store
        .cancel_summary(&scope, &history, "summary-cancelled")
        .unwrap();
    assert!(matches!(
        AnnotationStore::open(&path),
        Err(AnnotationError::Busy)
    ));
    assert_eq!(
        store
            .summary_operations(&scope, &history, 8)
            .unwrap()
            .iter()
            .find(|op| op.plan.operation_id == "summary-running")
            .unwrap()
            .status,
        SummaryStatus::Running
    );
    drop(store);
    let reopened = AnnotationStore::open(path).unwrap();
    let operations = reopened.summary_operations(&scope, &history, 8).unwrap();
    let pending = operations
        .iter()
        .find(|op| op.plan.operation_id == "summary-pending")
        .unwrap();
    assert_eq!(pending.status, SummaryStatus::Interrupted);
    assert_eq!(pending.model_requests_reserved, 0);
    let running = operations
        .iter()
        .find(|op| op.plan.operation_id == "summary-running")
        .unwrap();
    assert_eq!(running.status, SummaryStatus::Interrupted);
    assert_eq!(running.model_requests_reserved, 1);
    assert_eq!(
        running.attempts[0].status,
        SummaryAttemptStatus::Interrupted
    );
    assert_eq!(running.attempts[0].usage, SummaryUsage::default());
    assert_eq!(
        operations
            .iter()
            .find(|op| op.plan.operation_id == "summary-cancelled")
            .unwrap()
            .status,
        SummaryStatus::Cancelled
    );
    assert_eq!(
        operations
            .iter()
            .find(|op| op.plan.operation_id == "summary-deferred")
            .unwrap()
            .status,
        SummaryStatus::Deferred
    );
    assert_eq!(
        reopened.reserve_model_request(&scope, &history, "summary-running"),
        Err(AnnotationError::InvalidTransition)
    );
    assert!(reopened
        .view(&scope, &history)
        .unwrap()
        .summaries
        .is_empty());
}

#[test]
fn branch_world_head_and_ancestor_cutoff_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(dir.path().join("scope.sqlite")).unwrap();
    let initial = initial();
    let mut entries = Vec::new();
    demo(&initial, &mut entries, "annotations-scope-turn", "整理行囊");
    let history = history(&initial, &entries);
    let correct = scope(&history, "main");
    for variant in 0..7 {
        let mut bad = correct.clone();
        match variant {
            0 => bad.context.world_id = "different-world".into(),
            1 => bad.context.head_turn_id = None,
            2 => bad.branch_path[0].through_turn_id = None,
            3 => bad.branch_path.push(bad.branch_path[0].clone()),
            5 => bad.branch_path[0].through_change_seq = Some(0),
            6 => bad.branch_path.insert(
                0,
                AnnotationBranchAccess {
                    branch_id: "ancestor".into(),
                    through_turn_id: None,
                    through_change_seq: None,
                },
            ),
            _ => bad.branch_path.insert(
                0,
                AnnotationBranchAccess {
                    branch_id: "unknown-ancestor".into(),
                    through_turn_id: Some("uncommitted-turn".into()),
                    through_change_seq: Some(0),
                },
            ),
        }
        assert!(matches!(
            store.view(&bad, &history),
            Err(AnnotationError::InvalidScope | AnnotationError::InvisibleSource)
        ));
    }
    store
        .begin_summary(
            &correct,
            &history,
            &plan("summary-other-branch"),
            &sources(&entries),
        )
        .unwrap();
    let other = scope(&history, "other");
    assert_eq!(
        store.reserve_model_request(&other, &history, "summary-other-branch"),
        Err(AnnotationError::InvisibleSource)
    );
    assert!(store
        .summary_operations(&other, &history, 8)
        .unwrap()
        .is_empty());
}

#[test]
fn network_finish_obeys_cancellation_and_preserves_reported_cancel_usage() {
    let dir = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(dir.path().join("cancel-usage.sqlite")).unwrap();
    let initial = initial();
    let mut entries = Vec::new();
    demo(
        &initial,
        &mut entries,
        "annotations-cancel-usage-turn",
        "整理行囊",
    );
    let history = history(&initial, &entries);
    let scope = scope(&history, "main");
    store
        .begin_summary(
            &scope,
            &history,
            &plan("summary-cancel-usage"),
            &sources(&entries),
        )
        .unwrap();
    store
        .reserve_model_request(&scope, &history, "summary-cancel-usage")
        .unwrap();
    let usage = SummaryUsage {
        input_tokens: Some(12),
        output_tokens: Some(3),
        total_tokens: Some(15),
        ..SummaryUsage::default()
    };
    let cancel = lishi_core::CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        store.finish_summary_cancellable(
            &scope,
            &history,
            "summary-cancel-usage",
            1,
            "迟到正文",
            usage.clone(),
            &cancel
        ),
        Err(AnnotationError::Cancelled)
    );
    let completed = store
        .cancel_summary_with_usage(&scope, &history, "summary-cancel-usage", usage.clone())
        .unwrap();
    assert_eq!(completed.status, SummaryStatus::Cancelled);
    assert_eq!(
        completed.attempts[0].status,
        SummaryAttemptStatus::Cancelled
    );
    assert_eq!(completed.attempts[0].usage, usage);
    assert!(store.view(&scope, &history).unwrap().summaries.is_empty());
}

#[test]
fn usage_price_unknowns_are_preserved_and_invalid_cost_is_not_saved() {
    let dir = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(dir.path().join("usage.sqlite")).unwrap();
    let initial = initial();
    let mut entries = Vec::new();
    demo(&initial, &mut entries, "annotations-usage-turn", "整理行囊");
    let history = history(&initial, &entries);
    let scope = scope(&history, "main");
    store
        .begin_summary(
            &scope,
            &history,
            &plan("summary-usage-test"),
            &sources(&entries),
        )
        .unwrap();
    store
        .reserve_model_request(&scope, &history, "summary-usage-test")
        .unwrap();
    let invalid = SummaryUsage {
        cost_microunits: Some(1),
        ..Default::default()
    };
    assert_eq!(
        store.finish_summary(
            &scope,
            &history,
            "summary-usage-test",
            1,
            "测试摘要",
            invalid
        ),
        Err(AnnotationError::InvalidInput)
    );
    let usage = SummaryUsage {
        input_tokens: Some(10),
        output_tokens: None,
        total_tokens: None,
        cost_microunits: Some(5),
        cost_kind: Some(SummaryCostKind::Estimated),
        currency: Some("USD".into()),
        input_price_per_million_microunits: Some(100),
        output_price_per_million_microunits: None,
    };
    let completed = store
        .finish_summary(
            &scope,
            &history,
            "summary-usage-test",
            1,
            "测试摘要",
            usage.clone(),
        )
        .unwrap();
    assert_eq!(completed.attempts[0].usage, usage);
    assert_eq!(completed.attempts[0].usage.output_tokens, None);
    assert_eq!(completed.attempts[0].usage.total_tokens, None);
}

#[test]
fn sidecar_rejects_formal_or_unknown_databases_and_keeps_configuration_immutable() {
    let dir = tempfile::tempdir().unwrap();
    let world_path = dir.path().join("world.sqlite");
    let world = GameStoreV2::open(&world_path).unwrap();
    let setup = setup();
    world
        .create_world_v2(&setup, &initial_state_v2(&setup).unwrap(), "开局", &[])
        .unwrap();
    let baseline = world.view().unwrap();
    assert!(matches!(
        AnnotationStore::open(&world_path),
        Err(AnnotationError::IncompatibleDatabase)
    ));
    assert_eq!(world.view().unwrap(), baseline);
    let unknown = dir.path().join("foreign.sqlite");
    let db = rusqlite::Connection::open(&unknown).unwrap();
    db.execute("CREATE TABLE private_data(value TEXT)", [])
        .unwrap();
    drop(db);
    assert!(matches!(
        AnnotationStore::open(&unknown),
        Err(AnnotationError::IncompatibleDatabase)
    ));
    let path = dir.path().join("sidecar.sqlite");
    let store = AnnotationStore::open(&path).unwrap();
    let history = history(&initial(), &[]);
    let scope = scope(&history, "main");
    store
        .add_pin(&scope, &history, "immutable-pin", &cash())
        .unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    assert!(db
        .execute("UPDATE annotations SET record='{}'", [])
        .is_err());
    assert!(db.execute("DELETE FROM annotations", []).is_err());
    store
        .remove_annotation(&scope, &history, "immutable-pin")
        .unwrap();
    assert!(db.execute("DELETE FROM annotation_deletions", []).is_err());
    assert_eq!(
        db.pragma_query_value(None, "application_id", |row| row.get::<_, i32>(0))
            .unwrap(),
        0x4c414e4e
    );
}

#[test]
fn concurrent_reservations_charge_one_attempt_and_late_cancelled_completion_is_rejected() {
    use std::sync::{Arc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(AnnotationStore::open(dir.path().join("concurrent.sqlite")).unwrap());
    let initial = initial();
    let mut entries = Vec::new();
    demo(
        &initial,
        &mut entries,
        "annotations-concurrent-turn",
        "整理行囊",
    );
    let history = Arc::new(history(&initial, &entries));
    let scope = scope(&history, "main");
    store
        .begin_summary(
            &scope,
            &history,
            &plan("summary-concurrent"),
            &sources(&entries),
        )
        .unwrap();
    let barrier = Arc::new(Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let store = store.clone();
            let history = history.clone();
            let scope = scope.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.reserve_model_request(&scope, &history, "summary-concurrent")
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(results
        .iter()
        .all(|result| result.is_ok() || *result == Err(AnnotationError::InvalidTransition)));
    store
        .cancel_summary(&scope, &history, "summary-concurrent")
        .unwrap();
    assert_eq!(
        store.finish_summary(
            &scope,
            &history,
            "summary-concurrent",
            1,
            "迟到的结果",
            SummaryUsage::default()
        ),
        Err(AnnotationError::InvalidTransition)
    );
    let operation = store
        .summary_operations(&scope, &history, 1)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(operation.model_requests_reserved, 1);
    assert_eq!(operation.attempts.len(), 1);
    assert_eq!(operation.status, SummaryStatus::Cancelled);
    assert!(operation.body.is_none());
}

#[test]
fn failed_database_update_rolls_back_reservation_and_all_ids_share_a_namespace() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("atomic.sqlite");
    let store = AnnotationStore::open(&path).unwrap();
    let initial = initial();
    let mut entries = Vec::new();
    demo(
        &initial,
        &mut entries,
        "annotations-atomic-turn",
        "整理行囊",
    );
    let history = history(&initial, &entries);
    let scope = scope(&history, "main");
    store
        .begin_summary(
            &scope,
            &history,
            &plan("summary-atomic"),
            &sources(&entries),
        )
        .unwrap();
    assert_eq!(
        store.add_pin(&scope, &history, "summary-atomic", &cash()),
        Err(AnnotationError::Duplicate)
    );
    store
        .add_pin(&scope, &history, "same-id-pin", &cash())
        .unwrap();
    assert_eq!(
        store.begin_summary(&scope, &history, &plan("same-id-pin"), &sources(&entries)),
        Err(AnnotationError::Duplicate)
    );
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER controlled_failure BEFORE UPDATE ON summary_operations BEGIN SELECT RAISE(FAIL,'test failure'); END;").unwrap();
    assert_eq!(
        store.reserve_model_request(&scope, &history, "summary-atomic"),
        Err(AnnotationError::Database)
    );
    let baseline = store
        .summary_operations(&scope, &history, 1)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(baseline.model_requests_reserved, 0);
    assert!(baseline.attempts.is_empty());
    assert_eq!(baseline.status, SummaryStatus::Pending);
    db.execute_batch("DROP TRIGGER controlled_failure;")
        .unwrap();
    assert_eq!(
        store
            .reserve_model_request(&scope, &history, "summary-atomic")
            .unwrap()
            .attempt_number,
        1
    );
}

#[test]
fn same_head_after_fork_pin_deletion_and_summary_finish_do_not_leak() {
    let dir = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(dir.path().join("same-head.sqlite")).unwrap();
    let initial = initial();
    let mut entries = Vec::new();
    demo(&initial, &mut entries, "annotations-same-head", "整理行囊");
    let history = history(&initial, &entries);
    let parent = scope(&history, "main");
    store
        .add_pin(&parent, &history, "before-fork", &cash())
        .unwrap();
    store
        .begin_summary(
            &parent,
            &history,
            &plan("summary-finishes-later"),
            &sources(&entries),
        )
        .unwrap();
    let watermark = store.watermark().unwrap();
    let child = AnnotationScope {
        context: scope(&history, "child").context,
        branch_path: vec![
            AnnotationBranchAccess {
                branch_id: "main".into(),
                through_turn_id: history.head_turn_id().map(str::to_owned),
                through_change_seq: Some(watermark),
            },
            AnnotationBranchAccess {
                branch_id: "child".into(),
                through_turn_id: history.head_turn_id().map(str::to_owned),
                through_change_seq: None,
            },
        ],
    };
    store
        .add_pin(&parent, &history, "after-fork", &life())
        .unwrap();
    store
        .remove_annotation(&parent, &history, "before-fork")
        .unwrap();
    store
        .reserve_model_request(&parent, &history, "summary-finishes-later")
        .unwrap();
    store
        .finish_summary(
            &parent,
            &history,
            "summary-finishes-later",
            1,
            "父分支分叉后的新摘要正文",
            SummaryUsage::default(),
        )
        .unwrap();
    let child_view = store.view(&child, &history).unwrap();
    assert_eq!(
        child_view
            .pins
            .iter()
            .map(|pin| pin.id.as_str())
            .collect::<Vec<_>>(),
        ["before-fork"]
    );
    assert!(child_view.summaries.is_empty());
    let old_operation = store
        .summary_operations(&child, &history, 8)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(old_operation.status, SummaryStatus::Pending);
    assert_eq!(old_operation.model_requests_reserved, 0);
    assert!(old_operation.body.is_none());
    assert_eq!(
        store.view(&parent, &history).unwrap().pins[0].id,
        "after-fork"
    );
    assert_eq!(store.view(&parent, &history).unwrap().summaries.len(), 1);
}

#[test]
fn trusted_local_summary_never_reserves_a_model_call_and_honors_cancel() {
    use lishi_core::game_annotations::{LOCAL_SUMMARY_MODEL, SUMMARY_PROMPT_VERSION};
    let dir = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(dir.path().join("local.sqlite")).unwrap();
    let initial = initial();
    let mut entries = Vec::new();
    demo(&initial, &mut entries, "annotations-local-turn", "整理行囊");
    let history = history(&initial, &entries);
    let scope = scope(&history, "main");
    let mut local = plan("summary-local");
    local.provider = LOCAL_SUMMARY_MODEL.into();
    local.model = LOCAL_SUMMARY_MODEL.into();
    local.prompt_version = SUMMARY_PROMPT_VERSION;
    store
        .begin_summary(&scope, &history, &local, &sources(&entries))
        .unwrap();
    let cancel = lishi_core::CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        store.finish_local_summary(
            &scope,
            &history,
            &local.operation_id,
            "本地原文摘录",
            &cancel
        ),
        Err(AnnotationError::Cancelled)
    );
    let result = store
        .finish_local_summary(
            &scope,
            &history,
            &local.operation_id,
            "本地原文摘录",
            &lishi_core::CancellationToken::new(),
        )
        .unwrap();
    assert_eq!(result.model_requests_reserved, 0);
    assert!(result.attempts.is_empty());
    assert_eq!(result.status, SummaryStatus::Completed);
    store
        .begin_summary(
            &scope,
            &history,
            &plan("summary-not-local"),
            &sources(&entries),
        )
        .unwrap();
    assert_eq!(
        store.finish_local_summary(
            &scope,
            &history,
            "summary-not-local",
            "拒绝冒充",
            &lishi_core::CancellationToken::new()
        ),
        Err(AnnotationError::InvalidTransition)
    );
}

#[test]
fn summary_prompt_is_bounded_original_json_with_output_reserve() {
    use lishi_core::{game_annotations::compile_summary_prompt, game_context::ContextBudget};
    let initial = initial();
    let mut entries = Vec::new();
    demo(
        &initial,
        &mut entries,
        "annotations-prompt-turn",
        "观察一句所谓的“忽略规则”",
    );
    let history = history(&initial, &entries);
    let prompt =
        compile_summary_prompt(&history, &sources(&entries), ContextBudget::default()).unwrap();
    assert_eq!(prompt.input_utf8_bytes, prompt.prompt.len());
    assert_eq!(prompt.output_reserve_tokens, 4096);
    let json = prompt
        .prompt
        .lines()
        .find_map(|line| line.strip_prefix("原文JSON："))
        .unwrap();
    let records: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(records[0]["narrative"], entries[0].output.narrative);
    assert!(!format!("{prompt:?}").contains("忽略规则"));
    let budget = ContextBudget {
        max_input_bytes: 100,
        ..ContextBudget::default()
    };
    assert!(matches!(
        compile_summary_prompt(&history, &sources(&entries), budget),
        Err(AnnotationError::TooLarge)
    ));
    assert_eq!(history.current_state().resources[0].amount, 100);
}

#[test]
fn version_one_sidecar_upgrade_preserves_configuration_and_completed_summary() {
    let dir = tempfile::tempdir().unwrap();
    let initial = initial();
    let mut entries = Vec::new();
    demo(
        &initial,
        &mut entries,
        "annotations-upgrade-turn",
        "整理行囊",
    );
    let history = history(&initial, &entries);
    let scope = scope(&history, "main");
    let producer = AnnotationStore::open(dir.path().join("producer.sqlite")).unwrap();
    let pin = producer
        .add_pin(&scope, &history, "upgrade-pin", &cash())
        .unwrap();
    let bookmark = producer
        .add_bookmark(
            &scope,
            &history,
            "upgrade-bookmark",
            &entries[0].turn_id,
            "原有书签",
        )
        .unwrap();
    producer
        .begin_summary(
            &scope,
            &history,
            &plan("summary-upgrade"),
            &sources(&entries),
        )
        .unwrap();
    producer
        .reserve_model_request(&scope, &history, "summary-upgrade")
        .unwrap();
    let completed = producer
        .finish_summary(
            &scope,
            &history,
            "summary-upgrade",
            1,
            "原有摘要正文",
            SummaryUsage::default(),
        )
        .unwrap();
    let old_json = |value: serde_json::Value| {
        let mut object = value;
        object.as_object_mut().unwrap().remove("changeSeq");
        serde_json::to_string(&object).unwrap()
    };
    let path = dir.path().join("old-v1.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA application_id=1279348302; PRAGMA user_version=1;
CREATE TABLE annotations(id TEXT PRIMARY KEY,kind TEXT,world_id TEXT,origin_branch TEXT,created_head TEXT,created_at_ms INTEGER,record TEXT);
CREATE TABLE annotation_deletions(annotation_id TEXT,world_id TEXT,origin_branch TEXT,at_head TEXT,at_head_key TEXT,created_at_ms INTEGER,PRIMARY KEY(annotation_id,origin_branch,at_head_key));
CREATE TABLE summary_operations(operation_id TEXT PRIMARY KEY,world_id TEXT,origin_branch TEXT,created_head TEXT,status TEXT,created_at_ms INTEGER,record TEXT);
CREATE TRIGGER annotations_no_update BEFORE UPDATE ON annotations BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER deletions_no_update BEFORE UPDATE ON annotation_deletions BEGIN SELECT RAISE(ABORT,'immutable'); END;").unwrap();
    // Explicit hexadecimal value avoids interpreting the fixture decimal.
    db.pragma_update(None, "application_id", 0x4c414e4ei32)
        .unwrap();
    for (id, kind, created, record) in [
        (
            &pin.id,
            "pin",
            pin.created_at_ms,
            old_json(serde_json::to_value(&pin).unwrap()),
        ),
        (
            &bookmark.id,
            "bookmark",
            bookmark.created_at_ms,
            old_json(serde_json::to_value(&bookmark).unwrap()),
        ),
    ] {
        db.execute(
            "INSERT INTO annotations VALUES(?1,?2,?3,'main',?4,?5,?6)",
            rusqlite::params![id, kind, WORLD, history.head_turn_id(), created, record],
        )
        .unwrap();
    }
    db.execute(
        "INSERT INTO summary_operations VALUES(?1,?2,'main',?3,'completed',?4,?5)",
        rusqlite::params![
            completed.plan.operation_id,
            WORLD,
            history.head_turn_id(),
            completed.created_at_ms,
            old_json(serde_json::to_value(&completed).unwrap())
        ],
    )
    .unwrap();
    drop(db);
    let upgraded = AnnotationStore::open(&path).unwrap();
    let view = upgraded.view(&scope, &history).unwrap();
    assert_eq!(view.pins[0].fact_key, pin.fact_key);
    assert_eq!(view.bookmarks[0].label, bookmark.label);
    assert_eq!(view.summaries[0].body, completed.body);
    assert_eq!(view.summaries[0].attempts, completed.attempts);
    assert_eq!(upgraded.watermark().unwrap(), 3);
    let db = rusqlite::Connection::open(path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))
            .unwrap(),
        2
    );
    assert!(db
        .execute("UPDATE annotations SET record='{}'", [])
        .is_err());
}

#[test]
fn same_source_rebuild_selects_latest_completion_for_context_and_keeps_all_history() {
    use lishi_core::{
        game_context::{compile_context, ContextBudget, ContextRules},
        game_store_v2::WorldViewV2,
    };
    let directory = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(directory.path().join("effective-summary.sqlite")).unwrap();
    let initial = initial();
    let mut entries = Vec::new();
    demo(
        &initial,
        &mut entries,
        "annotations-effective-source",
        "整理行囊",
    );
    let history = history(&initial, &entries);
    let scope = scope(&history, "main");
    let originals = sources(&entries);
    // Creation order deliberately opposes completion order. A rebuild that
    // finishes last wins even when its operation began earlier.
    for id in ["summary-created-first", "summary-created-second"] {
        store
            .begin_summary(&scope, &history, &plan(id), &originals)
            .unwrap();
    }
    let old = finish_test_summary(
        &store,
        &scope,
        &history,
        "summary-created-second",
        "旧版本摘要：保留旧表述",
    );
    let new = finish_test_summary(
        &store,
        &scope,
        &history,
        "summary-created-first",
        "新版本摘要：保留重建表述",
    );
    assert_eq!(old.source_range_sha256, new.source_range_sha256);
    assert!(new.change_seq > old.change_seq);
    let annotations = store.view(&scope, &history).unwrap();
    assert_eq!(annotations.summaries, vec![new.clone()]);
    let operations = store.summary_operations(&scope, &history, 8).unwrap();
    assert_eq!(operations.len(), 2);
    assert!(operations.contains(&old));
    assert!(operations.contains(&new));
    assert_eq!(
        store
            .validate_rebuild_sources(&scope, &history, &new.plan.operation_id, &originals)
            .unwrap(),
        old.sources
    );
    let view = WorldViewV2 {
        setup: setup(),
        branch_id: "main".into(),
        head_turn_id: history.head_turn_id().map(str::to_owned),
        turn_count: history.turn_count(),
        state: history.current_state().clone(),
        opening_narrative: "可信开局".into(),
        opening_choices: vec![],
        narrative_policy: setup().narrative_style,
        turns: vec![],
        latest_operation: None,
    };
    let fragments = annotations
        .summaries
        .iter()
        .map(|summary| summary.context_fragment(&scope, &history).unwrap())
        .collect::<Vec<_>>();
    let compiled = compile_context(
        &view,
        &request(
            "summary-effective-context",
            "核对已有线索",
            history.head_turn_id(),
        ),
        &history,
        ContextRules::v2(),
        ContextBudget {
            max_input_bytes: 64 * 1024,
            context_limit_tokens: 96 * 1024,
            ..ContextBudget::default()
        },
        &[],
        &fragments,
    )
    .unwrap();
    assert!(compiled.prompt.contains(new.body.as_deref().unwrap()));
    assert!(!compiled.prompt.contains(old.body.as_deref().unwrap()));
    assert_eq!(history.current_state(), &entries[0].state);
}

#[test]
fn failed_and_deferred_rebuilds_do_not_hide_previous_completed_summary() {
    let directory = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(directory.path().join("failed-rebuild.sqlite")).unwrap();
    let initial = initial();
    let mut entries = Vec::new();
    demo(
        &initial,
        &mut entries,
        "annotations-rebuild-failure-source",
        "整理行囊",
    );
    let history = history(&initial, &entries);
    let scope = scope(&history, "main");
    let originals = sources(&entries);
    store
        .begin_summary(
            &scope,
            &history,
            &plan("summary-still-effective"),
            &originals,
        )
        .unwrap();
    let previous = finish_test_summary(
        &store,
        &scope,
        &history,
        "summary-still-effective",
        "此前成功的摘要仍然可用",
    );
    store
        .begin_summary(
            &scope,
            &history,
            &plan("summary-failed-rebuild"),
            &originals,
        )
        .unwrap();
    store
        .reserve_model_request(&scope, &history, "summary-failed-rebuild")
        .unwrap();
    store
        .fail_attempt(
            &scope,
            &history,
            "summary-failed-rebuild",
            1,
            SummaryFailure::Network,
            SummaryUsage::default(),
        )
        .unwrap();
    store
        .fail_summary(
            &scope,
            &history,
            "summary-failed-rebuild",
            SummaryFailure::Network,
        )
        .unwrap();
    store
        .begin_summary(
            &scope,
            &history,
            &plan("summary-deferred-rebuild"),
            &originals,
        )
        .unwrap();
    store
        .defer_summary(&scope, &history, "summary-deferred-rebuild")
        .unwrap();
    assert_eq!(
        store.view(&scope, &history).unwrap().summaries,
        vec![previous]
    );
    let operations = store.summary_operations(&scope, &history, 8).unwrap();
    assert_eq!(operations.len(), 3);
    assert!(operations
        .iter()
        .any(|summary| summary.status == SummaryStatus::Failed));
    assert!(operations
        .iter()
        .any(|summary| summary.status == SummaryStatus::Deferred));
}

#[test]
fn fork_keeps_old_effective_summary_and_child_rebuild_overrides_visible_ancestor_only() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fork-rebuild.sqlite");
    let store = AnnotationStore::open(&path).unwrap();
    let initial = initial();
    let mut entries = Vec::new();
    demo(
        &initial,
        &mut entries,
        "annotations-fork-rebuild-source",
        "整理行囊",
    );
    let history = history(&initial, &entries);
    let parent = scope(&history, "main");
    let originals = sources(&entries);
    store
        .begin_summary(&parent, &history, &plan("summary-before-fork"), &originals)
        .unwrap();
    let old = finish_test_summary(
        &store,
        &parent,
        &history,
        "summary-before-fork",
        "分叉前有效摘要",
    );
    store
        .begin_summary(
            &parent,
            &history,
            &plan("summary-parent-rebuild"),
            &originals,
        )
        .unwrap();
    let watermark = store.watermark().unwrap();
    let child = AnnotationScope {
        context: scope(&history, "child").context,
        branch_path: vec![
            AnnotationBranchAccess {
                branch_id: "main".into(),
                through_turn_id: history.head_turn_id().map(str::to_owned),
                through_change_seq: Some(watermark),
            },
            AnnotationBranchAccess {
                branch_id: "child".into(),
                through_turn_id: history.head_turn_id().map(str::to_owned),
                through_change_seq: None,
            },
        ],
    };
    let parent_new = finish_test_summary(
        &store,
        &parent,
        &history,
        "summary-parent-rebuild",
        "父线分叉后完成的重建摘要",
    );
    assert_eq!(
        store.view(&parent, &history).unwrap().summaries,
        vec![parent_new.clone()]
    );
    assert_eq!(
        store.view(&child, &history).unwrap().summaries,
        vec![old.clone()]
    );
    let inherited = store.summary_operations(&child, &history, 8).unwrap();
    assert_eq!(inherited.len(), 2);
    let frozen = inherited
        .iter()
        .find(|operation| operation.plan.operation_id == "summary-parent-rebuild")
        .unwrap();
    assert_eq!(frozen.status, SummaryStatus::Pending);
    assert!(frozen.body.is_none());
    store
        .begin_summary(&child, &history, &plan("summary-child-rebuild"), &originals)
        .unwrap();
    let child_new = finish_test_summary(
        &store,
        &child,
        &history,
        "summary-child-rebuild",
        "子线自己的重建摘要",
    );
    assert_eq!(
        store.view(&child, &history).unwrap().summaries,
        vec![child_new.clone()]
    );
    assert_eq!(
        store.view(&parent, &history).unwrap().summaries,
        vec![parent_new.clone()]
    );
    assert_eq!(
        store.summary_operations(&child, &history, 8).unwrap().len(),
        3
    );
    drop(store);
    let reopened = AnnotationStore::open(path).unwrap();
    assert_eq!(
        reopened.view(&child, &history).unwrap().summaries,
        vec![child_new]
    );
    assert_eq!(
        reopened.view(&parent, &history).unwrap().summaries,
        vec![parent_new]
    );
}
