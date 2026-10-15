use lishi_core::{
    game_branches::ForkBranchRequest,
    game_fast_forward::*,
    game_protocol::WorldSetup,
    game_protocol_v2::{initial_state_v2, TurnOutputV2},
    game_provider_v2::demo_output_v2,
    game_store::{GameActionKind, GameOperationStatus, GameStoreError, GameTurnRequest},
    game_store_v2::GameStoreV2,
};
const WORLD: &str = "fast-forward-store-world";
fn setup() -> WorldSetup {
    WorldSetup {
        world_id: WORLD.into(),
        title: "快进作业验证".into(),
        country: "唐".into(),
        era_year: 618,
        location_name: "长安".into(),
        protagonist_name: "行旅者".into(),
        narrative_style: "中文".into(),
    }
}
fn create(backend: bool) -> (tempfile::TempDir, GameStoreV2) {
    let directory = tempfile::tempdir().unwrap();
    let store = GameStoreV2::open(directory.path().join("world.sqlite")).unwrap();
    store
        .create_world_v2(&setup(), &initial_state_v2(&setup()).unwrap(), "开局", &[])
        .unwrap();
    store
        .enable_branches(&directory.path().join("backups"), None)
        .unwrap();
    if backend {
        store.ensure_fast_forward_backend().unwrap();
    }
    (directory, store)
}
fn start(
    store: &GameStoreV2,
    branch: &str,
    id: &str,
    target: u64,
    cap: u64,
    focus: &str,
) -> FastForwardJob {
    let view = store.view_branch(branch).unwrap();
    store
        .start_fast_forward(&StartFastForwardRequest {
            world_id: WORLD.into(),
            branch_id: branch.into(),
            job_id: id.into(),
            expected_head_turn_id: view.head_turn_id,
            target_elapsed_seconds: target,
            max_segment_seconds: cap,
            focus: focus.into(),
        })
        .unwrap()
}
fn begin(store: &GameStoreV2, job: &FastForwardJob, id: &str) -> FastForwardSegmentStart {
    store
        .begin_fast_forward_segment(&ContinueFastForwardRequest {
            world_id: WORLD.into(),
            branch_id: job.branch_id.clone(),
            job_id: job.job_id.clone(),
            operation_id: id.into(),
            expected_head_turn_id: job.head_turn_id.clone(),
            expected_job_revision: job.revision,
        })
        .unwrap()
}
fn segment(store: &GameStoreV2, start: &FastForwardSegmentStart) -> FastForwardSegment {
    store.mark_generating(&start.request.operation_id).unwrap();
    demo_fast_forward_segment(
        &store.get_fast_forward_job(&start.job.job_id).unwrap(),
        &store.view_branch(&start.job.branch_id).unwrap().state,
        &start.request.operation_id,
    )
    .unwrap()
}
fn finish_demo(store: &GameStoreV2, job: &FastForwardJob, id: &str) -> FastForwardCommit {
    let started = begin(store, job, id);
    let output = segment(store, &started);
    store.stage_fast_forward_segment(id, &output).unwrap();
    store.commit_fast_forward_segment(id, &output).unwrap()
}
fn fork(store: &GameStoreV2, branch: &str) {
    let main = store
        .list_branches()
        .unwrap()
        .into_iter()
        .find(|card| card.branch_id == "main")
        .unwrap();
    store
        .fork_branch(
            &ForkBranchRequest {
                world_id: WORLD.into(),
                source_branch_id: "main".into(),
                expected_head_turn_id: main.head_turn_id,
                expected_revision: main.revision,
                operation_id: format!("fork-intent-{branch}"),
                new_branch_id: branch.into(),
                name: branch.into(),
                fork_turn_id: None,
            },
            0,
        )
        .unwrap();
}
fn ordinary_turn(store: &GameStoreV2, branch: &str, id: &str, action: &str) {
    let view = store.view_branch(branch).unwrap();
    let request = GameTurnRequest {
        world_id: WORLD.into(),
        branch_id: branch.into(),
        operation_id: id.into(),
        expected_head_turn_id: view.head_turn_id,
        action_kind: GameActionKind::Action,
        action_text: action.into(),
    };
    let output = demo_output_v2(&view.state, &request).unwrap();
    store.begin(&request).unwrap();
    store.mark_generating(id).unwrap();
    store
        .stage_output(id, &serde_json::to_string(&output).unwrap())
        .unwrap();
    store.commit(id, &output).unwrap();
}
#[test]
fn listing_and_missing_backend_recovery_do_not_create_schema() {
    let (directory, store) = create(false);
    assert!(store.list_fast_forward_jobs("main").unwrap().is_empty());
    assert_eq!(store.recover_fast_forward_jobs().unwrap(), 0);
    let db = rusqlite::Connection::open(directory.path().join("world.sqlite")).unwrap();
    assert!(!db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name LIKE 'game_fast_forward_%')",
            [],
            |row| row.get::<_, bool>(0)
        )
        .unwrap());
    store.ensure_fast_forward_backend().unwrap();
    store.ensure_fast_forward_backend().unwrap();
}
#[test]
fn one_explicit_segment_commits_raw_v2_and_limit_then_target_without_hidden_calls() {
    let (directory, store) = create(true);
    let before = store.view().unwrap();
    let job = start(&store, "main", "fast-forward-job-limit", 20, 10, "");
    assert_eq!(store.view().unwrap(), before);
    let first = finish_demo(&store, &job, "fast-forward-segment-first");
    assert_eq!(first.job.status, FastForwardStatus::SegmentLimit);
    assert_eq!(first.job.elapsed_seconds, 10);
    assert_eq!(first.job.segments_committed, 1);
    assert_eq!(first.job.model_requests_reserved, 0);
    assert_eq!(first.world.turn_count, 1);
    assert_eq!(first.world.state.resources, before.state.resources);
    let second = finish_demo(&store, &first.job, "fast-forward-segment-last");
    assert_eq!(second.job.status, FastForwardStatus::Completed);
    assert_eq!(second.job.elapsed_seconds, 20);
    assert_eq!(second.world.turn_count, 2);
    let records = store.fast_forward_segments(&job.job_id).unwrap();
    assert_eq!(records.len(), 2);
    assert!(records
        .iter()
        .all(|record| record.model_requests_reserved == 0
            && record.usage == FastForwardUsage::default()));
    let db = rusqlite::Connection::open(directory.path().join("world.sqlite")).unwrap();
    let raw: String = db
        .query_row(
            "SELECT output FROM game_turns WHERE turn_id='fast-forward-segment-last'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let formal: TurnOutputV2 = serde_json::from_str(&raw).unwrap();
    assert_eq!(formal.protocol_version, 2);
    assert!(!raw.contains("stopReason"));
}
#[test]
fn decision_stops_before_asset_outcome_until_a_separate_player_action_commits() {
    let (_directory, store) = create(true);
    let job = start(
        &store,
        "main",
        "fast-forward-decision-job",
        100_000,
        10,
        "出现关键决策时暂停",
    );
    let before = store.view().unwrap();
    let paused = finish_demo(&store, &job, "fast-forward-decision-boundary");
    assert_eq!(paused.job.status, FastForwardStatus::PausedDecision);
    assert_eq!(paused.world.state.resources, before.state.resources);
    assert_eq!(paused.world.state.conditions, before.state.conditions);
    assert!(paused.job.decision.is_some());
    let next = ContinueFastForwardRequest {
        world_id: WORLD.into(),
        branch_id: "main".into(),
        job_id: job.job_id.clone(),
        operation_id: "automatic-choice-forbidden".into(),
        expected_head_turn_id: paused.job.head_turn_id.clone(),
        expected_job_revision: paused.job.revision,
    };
    assert!(matches!(
        store.begin_fast_forward_segment(&next),
        Err(GameStoreError::InvalidTransition)
    ));
    assert_eq!(store.view().unwrap().turn_count, 1);
    ordinary_turn(&store, "main", "explicit-decision-action", "购买补给");
    assert_eq!(store.view().unwrap().state.resources[0].amount, 95);
    let resumed = store
        .resume_fast_forward_after_decision(&DecisionResumeRequest {
            world_id: WORLD.into(),
            branch_id: "main".into(),
            job_id: job.job_id,
            decision_turn_id: "explicit-decision-action".into(),
            expected_job_revision: paused.job.revision,
        })
        .unwrap();
    assert_eq!(resumed.status, FastForwardStatus::Ready);
    assert!(resumed.decision.is_none());
    assert_eq!(
        resumed.head_turn_id.as_deref(),
        Some("explicit-decision-action")
    );
}
#[test]
fn reservations_usage_duplicate_ids_and_head_revision_cas_are_enforced() {
    let (_directory, store) = create(true);
    let job = start(&store, "main", "fast-forward-budget-job", 100, 10, "");
    let started = begin(&store, &job, "fast-forward-model-segment");
    let reserved = store
        .reserve_fast_forward_model_request(&started.request.operation_id)
        .unwrap();
    assert_eq!(reserved.model_requests_reserved, 1);
    assert!(store
        .reserve_fast_forward_model_request(&started.request.operation_id)
        .is_err());
    store
        .record_fast_forward_usage(
            &started.request.operation_id,
            FastForwardUsage {
                input_tokens: Some(23),
                output_tokens: Some(7),
                total_tokens: Some(30),
            },
        )
        .unwrap();
    let output = segment(&store, &started);
    store
        .stage_fast_forward_segment(&started.request.operation_id, &output)
        .unwrap();
    let committed = store
        .commit_fast_forward_segment(&started.request.operation_id, &output)
        .unwrap();
    assert_eq!(
        store.fast_forward_segments(&job.job_id).unwrap()[0]
            .usage
            .total_tokens,
        Some(30)
    );
    let stale = ContinueFastForwardRequest {
        world_id: WORLD.into(),
        branch_id: "main".into(),
        job_id: job.job_id.clone(),
        operation_id: "fast-forward-stale-revision".into(),
        expected_head_turn_id: committed.job.head_turn_id.clone(),
        expected_job_revision: job.revision,
    };
    assert!(matches!(
        store.begin_fast_forward_segment(&stale),
        Err(GameStoreError::StaleHead)
    ));
    let mut duplicate = stale;
    duplicate.operation_id = started.request.operation_id;
    duplicate.expected_job_revision = committed.job.revision;
    assert!(matches!(
        store.begin_fast_forward_segment(&duplicate),
        Err(GameStoreError::Duplicate)
    ));
    let other = start(&store, "main", "fast-forward-other-job", 100, 10, "");
    duplicate.operation_id = other.job_id;
    assert!(matches!(
        store.begin_fast_forward_segment(&duplicate),
        Err(GameStoreError::Duplicate)
    ));
}
#[test]
fn job_and_formal_turn_roll_back_together_when_commit_hook_or_sql_fails() {
    let (directory, store) = create(true);
    let job = start(&store, "main", "fast-forward-rollback-job", 100, 10, "");
    let started = begin(&store, &job, "fast-forward-rollback-segment");
    let output = segment(&store, &started);
    store
        .stage_fast_forward_segment(&started.request.operation_id, &output)
        .unwrap();
    let staged = store.get_fast_forward_job(&job.job_id).unwrap();
    assert!(matches!(
        store.commit_fast_forward_segment_with_hook(
            &started.request.operation_id,
            &output,
            || Err(GameStoreError::Cancelled)
        ),
        Err(GameStoreError::Cancelled)
    ));
    assert_eq!(store.view().unwrap().turn_count, 0);
    assert_eq!(store.get_fast_forward_job(&job.job_id).unwrap(), staged);
    let db = rusqlite::Connection::open(directory.path().join("world.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER controlled_fast_failure BEFORE UPDATE ON game_fast_forward_jobs BEGIN SELECT RAISE(FAIL,'fixture failure'); END;").unwrap();
    assert!(matches!(
        store.commit_fast_forward_segment(&started.request.operation_id, &output),
        Err(GameStoreError::Database)
    ));
    assert_eq!(store.view().unwrap().turn_count, 0);
    assert_eq!(store.get_fast_forward_job(&job.job_id).unwrap(), staged);
    db.execute_batch("DROP TRIGGER controlled_fast_failure;")
        .unwrap();
    let completed = store
        .commit_fast_forward_segment(&started.request.operation_id, &output)
        .unwrap();
    assert_eq!(completed.world.turn_count, 1);
    assert_eq!(completed.job.elapsed_seconds, 10);
}
#[test]
fn cancel_preserves_committed_progress_and_rejects_a_late_candidate() {
    let (_directory, store) = create(true);
    let job = start(&store, "main", "fast-forward-cancel-job", 100, 10, "");
    let first = finish_demo(&store, &job, "fast-forward-cancel-first");
    let second = begin(&store, &first.job, "fast-forward-cancel-second");
    store
        .reserve_fast_forward_model_request(&second.request.operation_id)
        .unwrap();
    let output = segment(&store, &second);
    store
        .stage_fast_forward_segment(&second.request.operation_id, &output)
        .unwrap();
    let current = store.get_fast_forward_job(&job.job_id).unwrap();
    let cancelled = store
        .cancel_fast_forward_job(&job.job_id, current.revision)
        .unwrap();
    assert_eq!(cancelled.status, FastForwardStatus::Cancelled);
    assert_eq!(cancelled.elapsed_seconds, 10);
    assert_eq!(cancelled.head_turn_id, first.job.head_turn_id);
    assert_eq!(cancelled.model_requests_reserved, 1);
    assert!(store
        .commit_fast_forward_segment(&second.request.operation_id, &output)
        .is_err());
    assert_eq!(store.view().unwrap().turn_count, 1);
    let resumed = finish_demo(&store, &cancelled, "fast-forward-cancel-resumed");
    assert_eq!(resumed.job.elapsed_seconds, 20);
    assert_eq!(store.fast_forward_segments(&job.job_id).unwrap().len(), 3);
}
#[test]
fn reopen_interrupts_only_uncommitted_segment_and_keeps_count_and_head() {
    let (directory, store) = create(true);
    let job = start(&store, "main", "fast-forward-recovery-job", 100, 10, "");
    let first = finish_demo(&store, &job, "fast-forward-recovery-first");
    let second = begin(&store, &first.job, "fast-forward-recovery-second");
    store.mark_generating(&second.request.operation_id).unwrap();
    store
        .reserve_fast_forward_model_request(&second.request.operation_id)
        .unwrap();
    drop(store);
    let reopened = GameStoreV2::open(directory.path().join("world.sqlite")).unwrap();
    reopened.recover_fast_forward_jobs().unwrap();
    let interrupted = reopened.get_fast_forward_job(&job.job_id).unwrap();
    assert_eq!(interrupted.status, FastForwardStatus::Interrupted);
    assert_eq!(interrupted.elapsed_seconds, 10);
    assert_eq!(interrupted.model_requests_reserved, 1);
    assert_eq!(interrupted.head_turn_id, first.job.head_turn_id);
    let records = reopened.fast_forward_segments(&job.job_id).unwrap();
    assert_eq!(records[0].status, GameOperationStatus::Interrupted);
    assert_eq!(records[0].model_requests_reserved, 1);
    assert_eq!(records[0].usage, FastForwardUsage::default());
    assert_eq!(reopened.view().unwrap().turn_count, 1);
    let next = finish_demo(&reopened, &interrupted, "fast-forward-recovery-next");
    assert_eq!(next.job.elapsed_seconds, 20);
}
#[test]
fn branch_jobs_do_not_cross_heads_or_inherit_when_a_child_is_created() {
    let (_directory, store) = create(true);
    fork(&store, "fast-forward-child-branch");
    let main = start(&store, "main", "fast-forward-main-job", 100, 10, "");
    assert!(store
        .list_fast_forward_jobs("fast-forward-child-branch")
        .unwrap()
        .is_empty());
    let child = start(
        &store,
        "fast-forward-child-branch",
        "fast-forward-child-job",
        100,
        10,
        "",
    );
    let completed = finish_demo(&store, &child, "fast-forward-child-segment");
    assert_eq!(completed.world.branch_id, "fast-forward-child-branch");
    assert_eq!(store.view().unwrap().turn_count, 0);
    assert_eq!(
        store
            .get_fast_forward_job(&main.job_id)
            .unwrap()
            .elapsed_seconds,
        0
    );
    let crossed = ContinueFastForwardRequest {
        world_id: WORLD.into(),
        branch_id: "main".into(),
        job_id: child.job_id,
        operation_id: "cross-branch-fast-forward".into(),
        expected_head_turn_id: completed.job.head_turn_id,
        expected_job_revision: completed.job.revision,
    };
    assert!(matches!(
        store.begin_fast_forward_segment(&crossed),
        Err(GameStoreError::InvalidRequest)
    ));
    assert_eq!(
        finish_demo(&store, &main, "fast-forward-main-segment")
            .world
            .branch_id,
        "main"
    );
}
#[test]
fn malformed_backend_is_rejected_and_unchosen_pause_survives_restart() {
    let (directory, store) = create(false);
    let db = rusqlite::Connection::open(directory.path().join("world.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE game_fast_forward_jobs(fake TEXT);")
        .unwrap();
    assert_eq!(
        store.ensure_fast_forward_backend(),
        Err(GameStoreError::IncompatibleSchema)
    );
    db.execute_batch("DROP TABLE game_fast_forward_jobs;")
        .unwrap();
    store.ensure_fast_forward_backend().unwrap();
    let job = start(
        &store,
        "main",
        "fast-forward-pause-reopen",
        100,
        10,
        "决策暂停",
    );
    let paused = finish_demo(&store, &job, "fast-forward-pause-node");
    drop(store);
    let reopened = GameStoreV2::open(directory.path().join("world.sqlite")).unwrap();
    assert_eq!(
        reopened.get_fast_forward_job(&job.job_id).unwrap(),
        paused.job
    );
    assert_eq!(reopened.view().unwrap().state.resources[0].amount, 100);
}

fn crash_pause(directory: &std::path::Path) {
    std::fs::write(directory.join("crash-boundary-ready"), b"ready").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("fast-forward crash fixture was not terminated");
}
#[test]
fn fast_forward_process_crash_child() {
    let Ok(directory) = std::env::var("LISHI_FAST_FORWARD_CRASH_ROOT") else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    let phase = std::env::var("LISHI_FAST_FORWARD_CRASH_PHASE").unwrap();
    let store = GameStoreV2::open(directory.join("world.sqlite")).unwrap();
    let job = store
        .get_fast_forward_job("fast-forward-crash-job")
        .unwrap();
    let first = finish_demo(&store, &job, "fast-forward-crash-first");
    let second = begin(&store, &first.job, "fast-forward-crash-second");
    store.mark_generating(&second.request.operation_id).unwrap();
    store
        .reserve_fast_forward_model_request(&second.request.operation_id)
        .unwrap();
    if phase == "generating" {
        crash_pause(&directory);
    }
    let job = store.get_fast_forward_job(&job.job_id).unwrap();
    let view = store.view().unwrap();
    let output =
        demo_fast_forward_segment(&job, &view.state, &second.request.operation_id).unwrap();
    store
        .stage_fast_forward_segment(&second.request.operation_id, &output)
        .unwrap();
    if phase == "before_commit" {
        let _ = store.commit_fast_forward_segment_with_hook(
            &second.request.operation_id,
            &output,
            || {
                crash_pause(&directory);
                Ok(())
            },
        );
    } else {
        store
            .commit_fast_forward_segment(&second.request.operation_id, &output)
            .unwrap();
        crash_pause(&directory);
    }
}
#[test]
fn strong_kill_at_generating_transaction_and_ack_boundary_preserves_exact_progress() {
    use std::{
        process::{Child, Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for phase in ["generating", "before_commit", "after_commit"] {
        let (directory, store) = create(true);
        start(&store, "main", "fast-forward-crash-job", 100, 10, "");
        drop(store);
        let mut child = OwnedChild(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "fast_forward_process_crash_child", "--nocapture"])
                .env("LISHI_FAST_FORWARD_CRASH_ROOT", directory.path())
                .env("LISHI_FAST_FORWARD_CRASH_PHASE", phase)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        while !directory.path().join("crash-boundary-ready").is_file() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "crash child exited before {phase}"
            );
            assert!(
                Instant::now() < deadline,
                "crash child did not reach {phase}"
            );
            thread::sleep(Duration::from_millis(10));
        }
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let reopened = GameStoreV2::open(directory.path().join("world.sqlite")).unwrap();
        let job = reopened
            .get_fast_forward_job("fast-forward-crash-job")
            .unwrap();
        let view = reopened.view().unwrap();
        assert_eq!(job.model_requests_reserved, 1);
        assert_eq!(job.target_elapsed_seconds, 100);
        assert_eq!(view.state.resources[0].amount, 100);
        if phase == "after_commit" {
            assert_eq!(job.status, FastForwardStatus::SegmentLimit);
            assert_eq!(job.elapsed_seconds, 20);
            assert_eq!(job.segments_committed, 2);
            assert_eq!(view.turn_count, 2);
            assert_eq!(
                view.head_turn_id.as_deref(),
                Some("fast-forward-crash-second")
            );
        } else {
            assert_eq!(job.status, FastForwardStatus::Interrupted);
            assert_eq!(job.elapsed_seconds, 10);
            assert_eq!(job.segments_committed, 1);
            assert_eq!(view.turn_count, 1);
            assert_eq!(
                view.head_turn_id.as_deref(),
                Some("fast-forward-crash-first")
            );
        }
        assert!(job.active_operation_id.is_none());
    }
}

#[test]
fn cancelled_attempt_can_receive_late_actual_usage_without_changing_progress() {
    let (_directory, store) = create(true);
    let job = start(&store, "main", "fast-forward-late-usage", 100, 10, "");
    let begun = begin(&store, &job, "fast-forward-usage-attempt");
    let reserved = store
        .reserve_fast_forward_model_request(&begun.request.operation_id)
        .unwrap();
    let cancelled = store
        .cancel_fast_forward_job(&job.job_id, reserved.revision)
        .unwrap();
    let usage = FastForwardUsage {
        input_tokens: Some(12),
        output_tokens: Some(3),
        total_tokens: Some(15),
    };
    store
        .record_fast_forward_usage(&begun.request.operation_id, usage.clone())
        .unwrap();
    store
        .record_fast_forward_usage(&begun.request.operation_id, usage.clone())
        .unwrap();
    assert_eq!(
        store.fast_forward_segments(&job.job_id).unwrap()[0].usage,
        usage
    );
    assert_eq!(store.get_fast_forward_job(&job.job_id).unwrap(), cancelled);
    assert_eq!(store.view().unwrap().turn_count, 0);
    assert!(store
        .record_fast_forward_usage(&begun.request.operation_id, FastForwardUsage::default())
        .is_err());
}

#[test]
fn an_explicit_fatal_choice_keeps_death_and_stops_the_unfinished_target() {
    use lishi_core::game_protocol_v2::StateChangeV2;
    let (_directory, store) = create(true);
    let job = start(
        &store,
        "main",
        "fast-forward-fatal-choice",
        100_000,
        10,
        "决策",
    );
    let paused = finish_demo(&store, &job, "fast-forward-fatal-boundary");
    let view = store.view().unwrap();
    let request = GameTurnRequest {
        world_id: WORLD.into(),
        branch_id: "main".into(),
        operation_id: "explicit-fatal-choice".into(),
        expected_head_turn_id: view.head_turn_id,
        action_kind: GameActionKind::Action,
        action_text: "明确选择危险行动".into(),
    };
    let mut output = demo_output_v2(&view.state, &request).unwrap();
    let event = output.events[0].id.clone();
    output.choices.clear();
    output.state_changes = vec![StateChangeV2::SetLifeStatus {
        entity_id: "player".into(),
        alive: false,
        event_id: event,
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
    let stopped = store
        .resume_fast_forward_after_decision(&DecisionResumeRequest {
            world_id: WORLD.into(),
            branch_id: "main".into(),
            job_id: job.job_id,
            decision_turn_id: request.operation_id,
            expected_job_revision: paused.job.revision,
        })
        .unwrap();
    assert_eq!(stopped.status, FastForwardStatus::Cancelled);
    assert_eq!(stopped.last_error.as_deref(), Some("game_protagonist_dead"));
    let request = ContinueFastForwardRequest {
        world_id: WORLD.into(),
        branch_id: "main".into(),
        job_id: stopped.job_id.clone(),
        operation_id: "cannot-fast-forward-death".into(),
        expected_head_turn_id: stopped.head_turn_id,
        expected_job_revision: stopped.revision,
    };
    assert!(matches!(
        store.begin_fast_forward_segment(&request),
        Err(GameStoreError::InvalidRequest)
    ));
    assert_eq!(store.view().unwrap().state.entities[0].alive, Some(false));
}
