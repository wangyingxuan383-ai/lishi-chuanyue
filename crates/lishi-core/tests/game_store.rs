use std::{
    fs::File,
    io::Write,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Barrier},
    time::{Duration, Instant},
};

use lishi_core::{
    game_protocol::{
        initial_state, Choice, Condition, StateChange, TimeAdvance, TurnOutput, WorldSetup,
        GAME_PROTOCOL_VERSION,
    },
    game_store::{
        GameActionKind, GameOperationStatus, GameStore, GameStoreError, GameTurnRequest, WorldView,
        MAX_ACTION_BYTES, MAX_CANDIDATE_BYTES, RECENT_TURN_LIMIT,
    },
};

const WORLD_ID: &str = "world-fixture-0001";
const BASELINE_ID: &str = "turn-baseline-0001";
const NEXT_ID: &str = "turn-next-00000002";
const OPENING: &str = "公元前221年，你带着行囊来到咸阳。🙂\n世界事实从此保存。";

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: WORLD_ID.to_owned(),
        title: "中文世界：咸阳🔑".to_owned(),
        country: "秦".to_owned(),
        era_year: -221,
        location_name: "咸阳".to_owned(),
        protagonist_name: "林时".to_owned(),
        narrative_style: "中文细致叙事，重要选择交给玩家。".to_owned(),
    }
}

fn new_world(path: &Path) -> GameStore {
    let store = GameStore::open(path).unwrap();
    let setup = setup();
    let initial = initial_state(&setup).unwrap();
    store
        .create_world(
            &setup,
            &initial,
            OPENING,
            &[Choice {
                id: "look-around".to_owned(),
                text: "观察街道与行人。".to_owned(),
            }],
        )
        .unwrap();
    store
}

fn request(id: &str, head: Option<&str>) -> GameTurnRequest {
    GameTurnRequest {
        operation_id: id.to_owned(),
        world_id: WORLD_ID.to_owned(),
        branch_id: "main".to_owned(),
        expected_head_turn_id: head.map(str::to_owned),
        action_kind: GameActionKind::Action,
        action_text: "沿街询问粮食价格，保管好钥匙🔑。".to_owned(),
    }
}

fn output(narrative: &str, changes: Vec<StateChange>) -> TurnOutput {
    TurnOutput {
        protocol_version: GAME_PROTOCOL_VERSION,
        narrative: narrative.to_owned(),
        choices: vec![Choice {
            id: "next".to_owned(),
            text: "继续了解周围的生活。".to_owned(),
        }],
        time_advance: TimeAdvance {
            elapsed_seconds: 3600,
        },
        state_changes: changes,
        events: Vec::new(),
        source_references: Vec::new(),
        uncertainties: vec!["本场景是固定测试，没有进行历史研究。".to_owned()],
    }
}

fn expense(amount_before: i64, delta: i64) -> StateChange {
    StateChange::ChangeResource {
        owner_id: "player".to_owned(),
        key: "cash".to_owned(),
        unit: "记账单位".to_owned(),
        delta,
        expected_amount: Some(amount_before),
    }
}

fn stage(store: &GameStore, request: &GameTurnRequest, output: &TurnOutput) {
    store.begin(request).unwrap();
    store.mark_generating(&request.operation_id).unwrap();
    store
        .stage_output(
            &request.operation_id,
            &serde_json::to_string(output).unwrap(),
        )
        .unwrap();
}

fn commit_turn(store: &GameStore, request: &GameTurnRequest, output: &TurnOutput) -> WorldView {
    stage(store, request, output);
    store.commit(&request.operation_id, output).unwrap()
}

#[test]
fn bce_chinese_world_and_ten_formal_turns_restore_exactly_with_immutable_snapshots() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("中文世界.sqlite");
    let store = new_world(&path);
    let opening = store.view().unwrap();
    assert_eq!(opening.state.time.era_year, -221);
    assert_eq!(opening.state.time.elapsed_seconds, 0);
    assert_eq!(opening.head_turn_id, None);
    assert_eq!(opening.turn_count, 0);
    assert_eq!(opening.opening_narrative, OPENING);
    let mut head = None;
    for index in 0..10 {
        let id = format!("turn-test-{index:08}");
        let mut action = request(&id, head.as_deref());
        if index % 2 == 1 {
            action.action_kind = GameActionKind::Continue;
            action.action_text.clear();
        }
        let mut changes = vec![expense(100 - index, -1)];
        if index == 2 {
            changes.push(StateChange::AddCondition {
                condition: Condition {
                    id: "ankle-injury".to_owned(),
                    entity_id: "player".to_owned(),
                    description: "脚踝扭伤，尚未治愈。".to_owned(),
                    active: true,
                },
            });
        }
        let story = output(
            &format!("第{}回合：咸阳街道，中文与🙂。", index + 1),
            changes,
        );
        let view = commit_turn(&store, &action, &story);
        assert_eq!(view.turn_count, (index + 1) as u64);
        assert_eq!(view.state.resources[0].amount, 99 - index);
        assert_eq!(view.state.time.elapsed_seconds, (index as u64 + 1) * 3600);
        assert_eq!(view.turns.last().unwrap().narrative, story.narrative);
        head = Some(id);
    }
    let final_view = store.view().unwrap();
    assert_eq!(final_view.state.resources[0].amount, 90);
    assert!(final_view.state.conditions[0].active);
    assert_eq!(final_view.turns[0].state.resources[0].amount, 99);
    assert_eq!(final_view.turns[9].state.resources[0].amount, 90);
    assert_eq!(final_view.turns[0].parent_turn_id, None);
    assert_eq!(final_view.state.time.era_year, -221);
    assert_eq!(
        store.create_world(&setup(), &opening.state, OPENING, &[]),
        Err(GameStoreError::AlreadyCreated)
    );
    let connection = rusqlite::Connection::open(&path).unwrap();
    assert!(connection
        .execute("UPDATE game_turns SET narrative='篡改'", [])
        .is_err());
    assert!(connection.execute("DELETE FROM game_turns", []).is_err());
    assert!(connection
        .execute("UPDATE game_world SET opening_narrative='篡改'", [])
        .is_err());
    assert!(connection
        .execute("UPDATE game_operations SET action_text='篡改'", [])
        .is_err());
    drop(connection);
    drop(store);
    assert_eq!(GameStore::open(path).unwrap().view().unwrap(), final_view);
}

#[test]
fn duplicate_stale_head_wrong_world_and_branch_do_not_create_operations() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("requests.sqlite");
    let store = new_world(&path);
    let view = commit_turn(
        &store,
        &request(BASELINE_ID, None),
        &output("已提交事实。", vec![]),
    );
    assert_eq!(
        store.begin(&request(BASELINE_ID, Some(BASELINE_ID))),
        Err(GameStoreError::Duplicate)
    );
    assert_eq!(
        store.begin(&request(NEXT_ID, None)),
        Err(GameStoreError::StaleHead)
    );
    let mut wrong = request(NEXT_ID, Some(BASELINE_ID));
    wrong.world_id = "another-world-0001".to_owned();
    assert_eq!(store.begin(&wrong), Err(GameStoreError::InvalidRequest));
    wrong.world_id = WORLD_ID.to_owned();
    wrong.branch_id = "fake-m04-branch".to_owned();
    assert_eq!(store.begin(&wrong), Err(GameStoreError::InvalidRequest));
    wrong.branch_id = "main".to_owned();
    wrong.action_text = " ".to_owned();
    assert_eq!(store.begin(&wrong), Err(GameStoreError::InvalidRequest));
    wrong.action_text = "中".repeat(MAX_ACTION_BYTES / 3 + 1);
    assert_eq!(store.begin(&wrong), Err(GameStoreError::InvalidRequest));
    assert_eq!(store.view().unwrap(), view);
    let connection = rusqlite::Connection::open(path).unwrap();
    let count: i64 = connection
        .query_row("SELECT count(*) FROM game_operations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let mut encoded = serde_json::to_value(request(NEXT_ID, Some(BASELINE_ID))).unwrap();
    encoded
        .as_object_mut()
        .unwrap()
        .remove("expectedHeadTurnId");
    assert!(serde_json::from_value::<GameTurnRequest>(encoded).is_err());
}

#[test]
fn second_live_owner_returns_busy_without_interrupting_first_owner() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("owner.sqlite");
    let store = new_world(&path);
    store.begin(&request(NEXT_ID, None)).unwrap();
    store.mark_generating(NEXT_ID).unwrap();
    assert!(matches!(GameStore::open(&path), Err(GameStoreError::Busy)));
    assert_eq!(
        store.view().unwrap().latest_operation.unwrap().status,
        GameOperationStatus::Generating
    );
    drop(store);
    let reopened = GameStore::open(path).unwrap();
    assert_eq!(
        reopened.view().unwrap().latest_operation.unwrap().status,
        GameOperationStatus::Interrupted
    );
    assert_eq!(reopened.view().unwrap().turn_count, 0);
}

#[test]
fn pending_generating_and_validating_recover_without_formal_or_context_draft() {
    for status in [
        GameOperationStatus::Pending,
        GameOperationStatus::Generating,
        GameOperationStatus::Validating,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recover.sqlite");
        let store = new_world(&path);
        let formal = commit_turn(
            &store,
            &request(BASELINE_ID, None),
            &output("正式剧情🔑。", vec![]),
        );
        store.begin(&request(NEXT_ID, Some(BASELINE_ID))).unwrap();
        if status != GameOperationStatus::Pending {
            store.mark_generating(NEXT_ID).unwrap();
        }
        if status == GameOperationStatus::Validating {
            store
                .stage_output(NEXT_ID, "尚未提交的草稿秘密。invalid JSON")
                .unwrap();
        }
        assert_eq!(store.view().unwrap().state, formal.state);
        assert_eq!(store.view().unwrap().turns, formal.turns);
        drop(store);
        let store = GameStore::open(&path).unwrap();
        let view = store.view().unwrap();
        assert_eq!(view.head_turn_id, formal.head_turn_id);
        assert_eq!(view.state, formal.state);
        assert_eq!(view.turns, formal.turns);
        let operation = view.latest_operation.unwrap();
        assert_eq!(operation.action_text, request(NEXT_ID, None).action_text);
        assert_eq!(operation.status, GameOperationStatus::Interrupted);
        assert_eq!(operation.error_code.as_deref(), Some("process_interrupted"));
        assert_eq!(
            store.begin(&request(NEXT_ID, Some(BASELINE_ID))),
            Err(GameStoreError::Duplicate)
        );
        let connection = rusqlite::Connection::open(path).unwrap();
        let candidate: Option<String> = connection
            .query_row(
                "SELECT candidate FROM game_operations WHERE operation_id=?1",
                [NEXT_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(candidate, None);
    }
}

#[test]
fn malformed_or_mismatched_output_and_illegal_state_never_enter_formal_story() {
    let directory = tempfile::tempdir().unwrap();
    let store = new_world(&directory.path().join("invalid.sqlite"));
    let baseline = store.view().unwrap();
    let okay = output("完整候选。", vec![]);
    store.begin(&request(NEXT_ID, None)).unwrap();
    store.mark_generating(NEXT_ID).unwrap();
    assert_eq!(
        store.stage_output(NEXT_ID, ""),
        Err(GameStoreError::InvalidOutput)
    );
    assert_eq!(
        store.stage_output(NEXT_ID, &"中".repeat(MAX_CANDIDATE_BYTES / 3 + 1)),
        Err(GameStoreError::InvalidOutput)
    );
    store.stage_output(NEXT_ID, "{").unwrap();
    assert_eq!(
        store.commit(NEXT_ID, &okay),
        Err(GameStoreError::InvalidOutput)
    );
    store
        .finish_uncommitted(
            NEXT_ID,
            GameOperationStatus::Failed,
            Some("game_invalid_output"),
        )
        .unwrap();
    let illegal = [
        output("余额不得为负。", vec![expense(100, -101)]),
        output(
            "不能移动到不存在的地点。",
            vec![StateChange::Move {
                location_id: "unknown-place".to_owned(),
            }],
        ),
    ];
    for (index, bad) in illegal.iter().enumerate() {
        let id = format!("invalid-turn-{index:08}");
        stage(&store, &request(&id, None), bad);
        assert_eq!(store.commit(&id, bad), Err(GameStoreError::InvalidOutput));
        store
            .finish_uncommitted(
                &id,
                GameOperationStatus::Failed,
                Some("game_invalid_reference"),
            )
            .unwrap();
        assert_eq!(store.view().unwrap().state, baseline.state);
        assert_eq!(store.view().unwrap().turn_count, 0);
    }
    let id = "mismatched-output-0001";
    stage(&store, &request(id, None), &okay);
    let another = output("调用方偷偷替换了草稿。", vec![]);
    assert_eq!(
        store.commit(id, &another),
        Err(GameStoreError::InvalidOutput)
    );
    assert_eq!(store.view().unwrap().state, baseline.state);
    assert!(store.view().unwrap().turns.is_empty());
}

#[test]
fn formal_death_persists_and_cannot_be_reversed_by_next_model_output() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("death.sqlite");
    let store = new_world(&path);
    let death = output(
        "主角死亡，事实必须保存。",
        vec![StateChange::SetLifeStatus {
            entity_id: "player".to_owned(),
            alive: false,
        }],
    );
    let formal = commit_turn(&store, &request(BASELINE_ID, None), &death);
    let revival = output(
        "模型试图无依据复活主角。",
        vec![StateChange::SetLifeStatus {
            entity_id: "player".to_owned(),
            alive: true,
        }],
    );
    stage(&store, &request(NEXT_ID, Some(BASELINE_ID)), &revival);
    assert_eq!(
        store.commit(NEXT_ID, &revival),
        Err(GameStoreError::InvalidOutput)
    );
    store
        .finish_uncommitted(
            NEXT_ID,
            GameOperationStatus::Failed,
            Some("game_dead_cannot_revive"),
        )
        .unwrap();
    assert_eq!(store.view().unwrap().state, formal.state);
    drop(store);
    assert_eq!(
        GameStore::open(path)
            .unwrap()
            .view()
            .unwrap()
            .state
            .entities[0]
            .alive,
        Some(false)
    );
}

#[test]
fn cancellation_failed_requests_and_closed_error_codes_preserve_formal_facts() {
    let directory = tempfile::tempdir().unwrap();
    let store = new_world(&directory.path().join("cancel.sqlite"));
    let baseline = store.view().unwrap();
    for (index, status) in [GameOperationStatus::Failed, GameOperationStatus::Cancelled]
        .into_iter()
        .enumerate()
    {
        let id = format!("ended-request-{index:08}");
        let candidate = output("不应成为正式剧情。", vec![expense(100, -20)]);
        stage(&store, &request(&id, None), &candidate);
        assert_eq!(
            store.finish_uncommitted(&id, status, Some("usersecret1234")),
            Err(GameStoreError::InvalidErrorCode)
        );
        assert_eq!(
            store.finish_uncommitted(&id, status, Some("https://private.invalid")),
            Err(GameStoreError::InvalidErrorCode)
        );
        assert_eq!(
            store.finish_uncommitted(&id, GameOperationStatus::Committed, None),
            Err(GameStoreError::InvalidTransition)
        );
        store
            .finish_uncommitted(&id, status, Some("unexpected_eof"))
            .unwrap();
        assert_eq!(
            store.commit(&id, &candidate),
            Err(GameStoreError::InvalidTransition)
        );
        let view = store.view().unwrap();
        assert_eq!(view.state, baseline.state);
        assert_eq!(view.head_turn_id, None);
        assert_eq!(view.turn_count, 0);
    }
}

#[test]
fn concurrent_requests_reserve_one_operation_then_reject_old_heads() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(new_world(&directory.path().join("concurrent.sqlite")));
    let barrier = Arc::new(Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|index| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let id = format!("concurrent-turn-{index:08}");
                barrier.wait();
                let result = store.begin(&request(&id, None));
                (id, result)
            })
        })
        .collect();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(
        results.iter().filter(|(_, result)| result.is_ok()).count(),
        1
    );
    assert!(results
        .iter()
        .all(|(_, result)| result.is_ok() || *result == Err(GameStoreError::Busy)));
    let id = &results.iter().find(|(_, result)| result.is_ok()).unwrap().0;
    store.mark_generating(id).unwrap();
    let candidate = output("唯一被接受的回合。", vec![expense(100, -5)]);
    store
        .stage_output(id, &serde_json::to_string(&candidate).unwrap())
        .unwrap();
    store.commit(id, &candidate).unwrap();
    assert_eq!(
        store.begin(&request(NEXT_ID, None)),
        Err(GameStoreError::StaleHead)
    );
    assert_eq!(store.view().unwrap().state.resources[0].amount, 95);
    assert_eq!(store.view().unwrap().turn_count, 1);
}

#[test]
fn sql_failure_and_cancel_before_commit_roll_back_turn_snapshot_head_and_status() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollback.sqlite");
    let store = new_world(&path);
    let baseline = commit_turn(
        &store,
        &request(BASELINE_ID, None),
        &output("基准正式事实。", vec![expense(100, -10)]),
    );
    let candidate = output("候选不得部分提交。", vec![expense(90, -10)]);
    stage(&store, &request(NEXT_ID, Some(BASELINE_ID)), &candidate);
    let raw = rusqlite::Connection::open(&path).unwrap();
    raw.execute_batch("CREATE TRIGGER injected_failure BEFORE UPDATE OF head_turn_id ON game_world BEGIN SELECT RAISE(FAIL,'isolated fault'); END;").unwrap();
    assert_eq!(
        store.commit(NEXT_ID, &candidate),
        Err(GameStoreError::Database)
    );
    assert_eq!(store.view().unwrap().state, baseline.state);
    assert_eq!(store.view().unwrap().head_turn_id, baseline.head_turn_id);
    assert_eq!(
        store.view().unwrap().latest_operation.unwrap().status,
        GameOperationStatus::Validating
    );
    raw.execute_batch("DROP TRIGGER injected_failure;").unwrap();
    assert_eq!(
        store.commit_with_hook(NEXT_ID, &candidate, || Err(GameStoreError::Cancelled)),
        Err(GameStoreError::Cancelled)
    );
    assert_eq!(store.view().unwrap().turn_count, 1);
    let count: i64 = raw
        .query_row("SELECT count(*) FROM game_turns", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
    store.commit(NEXT_ID, &candidate).unwrap();
    assert_eq!(store.view().unwrap().state.resources[0].amount, 80);
    assert_eq!(store.view().unwrap().turn_count, 2);
    assert_eq!(
        store.finish_uncommitted(NEXT_ID, GameOperationStatus::Failed, Some("game_database")),
        Err(GameStoreError::InvalidTransition)
    );
}

#[test]
fn ooc_policy_is_persistent_and_does_not_change_turns_time_opening_or_facts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("policy.sqlite");
    let store = new_world(&path);
    let before = store.view().unwrap();
    let after = store
        .update_policy("世界外指令：减少修辞，勿替主角作重要决定。")
        .unwrap();
    assert_eq!(after.state, before.state);
    assert_eq!(after.head_turn_id, before.head_turn_id);
    assert_eq!(after.turn_count, 0);
    assert_eq!(after.turns, before.turns);
    assert_eq!(after.setup, before.setup);
    assert_eq!(after.opening_narrative, before.opening_narrative);
    store.begin(&request(NEXT_ID, None)).unwrap();
    assert_eq!(
        store.update_policy("生成中不改叙事方针。"),
        Err(GameStoreError::Busy)
    );
    assert_eq!(
        store.view().unwrap().narrative_policy,
        after.narrative_policy
    );
    store
        .finish_uncommitted(NEXT_ID, GameOperationStatus::Cancelled, None)
        .unwrap();
    drop(store);
    assert_eq!(
        GameStore::open(path)
            .unwrap()
            .view()
            .unwrap()
            .narrative_policy,
        after.narrative_policy
    );
}

#[test]
fn bounded_recent_view_preserves_all_immutable_turns_in_database() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("longer.sqlite");
    let store = new_world(&path);
    let mut head = None;
    for index in 0..RECENT_TURN_LIMIT + 5 {
        let id = format!("bounded-turn-{index:08}");
        commit_turn(
            &store,
            &request(&id, head.as_deref()),
            &output(&format!("正式回合{index}。"), vec![]),
        );
        head = Some(id);
    }
    let view = store.view().unwrap();
    assert_eq!(view.turns.len(), RECENT_TURN_LIMIT);
    assert_eq!(view.turn_count, (RECENT_TURN_LIMIT + 5) as u64);
    assert_eq!(view.turns[0].turn_id, "bounded-turn-00000005");
    assert_eq!(view.turns.last().unwrap().turn_id, "bounded-turn-00000104");
    let raw = rusqlite::Connection::open(path).unwrap();
    let count: i64 = raw
        .query_row("SELECT count(*) FROM game_turns", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, (RECENT_TURN_LIMIT + 5) as i64);
}

#[test]
fn unknown_and_future_schema_are_refused_before_recovery_or_database_changes() {
    let directory = tempfile::tempdir().unwrap();
    for future in [false, true] {
        let path = directory.path().join(if future {
            "future.sqlite"
        } else {
            "unrelated.sqlite"
        });
        let raw = rusqlite::Connection::open(&path).unwrap();
        raw.execute_batch(
            "CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('保留原始数据');",
        )
        .unwrap();
        if future {
            raw.pragma_update(None, "user_version", 2).unwrap();
        }
        drop(raw);
        let bytes = std::fs::read(&path).unwrap();
        assert!(matches!(
            GameStore::open(&path),
            Err(GameStoreError::IncompatibleSchema)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

fn acknowledge_and_wait(path: &Path) {
    let mut file = File::create_new(path).unwrap();
    file.write_all(b"acknowledged-game-boundary").unwrap();
    file.sync_all().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("parent did not terminate the isolated owned test child");
}

/// Only the isolated parent below launches this test executable with paths in
/// its own temporary directory. There are no application paths or credentials.
#[test]
fn game_store_child_process_harness() {
    let Some(path) = std::env::var_os("LISHI_GAME_TEST_DB") else {
        return;
    };
    let ready = std::env::var_os("LISHI_GAME_TEST_READY").unwrap();
    let phase = std::env::var("LISHI_GAME_TEST_PHASE").unwrap();
    let store = GameStore::open(Path::new(&path)).unwrap();
    store.begin(&request(NEXT_ID, Some(BASELINE_ID))).unwrap();
    if phase == "pending" {
        acknowledge_and_wait(Path::new(&ready));
        return;
    }
    store.mark_generating(NEXT_ID).unwrap();
    if phase == "generating" {
        acknowledge_and_wait(Path::new(&ready));
        return;
    }
    let candidate = output("强杀边界后的新正式剧情🔑。", vec![expense(90, -10)]);
    store
        .stage_output(NEXT_ID, &serde_json::to_string(&candidate).unwrap())
        .unwrap();
    if phase == "validating" {
        acknowledge_and_wait(Path::new(&ready));
        return;
    }
    if phase == "transaction" {
        store
            .commit_with_hook(NEXT_ID, &candidate, || {
                acknowledge_and_wait(Path::new(&ready));
                Ok(())
            })
            .unwrap();
        return;
    }
    assert_eq!(phase, "committed");
    store.commit(NEXT_ID, &candidate).unwrap();
    acknowledge_and_wait(Path::new(&ready));
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn strong_kill_five_acknowledged_boundaries_is_atomic_and_releases_owner() {
    for phase in [
        "pending",
        "generating",
        "validating",
        "transaction",
        "committed",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owned-child.sqlite");
        let ready = directory.path().join("boundary-ready");
        let store = new_world(&path);
        let baseline = commit_turn(
            &store,
            &request(BASELINE_ID, None),
            &output("强杀前的已提交剧情。", vec![expense(100, -10)]),
        );
        drop(store);
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "game_store_child_process_harness", "--nocapture"])
            .env("LISHI_GAME_TEST_DB", &path)
            .env("LISHI_GAME_TEST_READY", &ready)
            .env("LISHI_GAME_TEST_PHASE", phase)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = ChildGuard(command.spawn().unwrap());
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "child exited before {phase}"
            );
            if std::fs::read(&ready).ok().as_deref() == Some(b"acknowledged-game-boundary") {
                break;
            }
            assert!(Instant::now() < deadline, "no acknowledgement for {phase}");
            std::thread::sleep(Duration::from_millis(10));
        }
        child
            .0
            .kill()
            .expect("terminate only this owned child after its acknowledgement");
        child.0.wait().unwrap();
        drop(child);
        let store = GameStore::open(&path).unwrap();
        let view = store.view().unwrap();
        let committed = phase == "committed";
        assert_eq!(view.turn_count, if committed { 2 } else { 1 }, "{phase}");
        assert_eq!(
            view.state.resources[0].amount,
            if committed { 80 } else { 90 },
            "{phase}"
        );
        assert_eq!(
            view.state.time.elapsed_seconds,
            if committed { 7200 } else { 3600 },
            "{phase}"
        );
        assert_eq!(
            view.latest_operation.unwrap().status,
            if committed {
                GameOperationStatus::Committed
            } else {
                GameOperationStatus::Interrupted
            },
            "{phase}"
        );
        if !committed {
            assert_eq!(view.state, baseline.state);
            assert_eq!(view.turns, baseline.turns);
        }
        assert_eq!(
            store.begin(&request(NEXT_ID, view.head_turn_id.as_deref())),
            Err(GameStoreError::Duplicate)
        );
        let raw = rusqlite::Connection::open(path).unwrap();
        let count: i64 = raw
            .query_row("SELECT count(*) FROM game_turns", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, if committed { 2 } else { 1 }, "{phase}");
        let candidate: Option<String> = raw
            .query_row(
                "SELECT candidate FROM game_operations WHERE operation_id=?1",
                [NEXT_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(candidate, None, "{phase}");
    }
}
