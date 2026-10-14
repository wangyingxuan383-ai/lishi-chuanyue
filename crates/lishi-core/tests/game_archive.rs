use std::{fs, path::Path};

use lishi_core::{
    game_archive::{ArchiveControl, GameArchiveError, LegacyGameArchive},
    game_protocol::{
        initial_state, Choice, TimeAdvance, TurnOutput, WorldSetup, GAME_PROTOCOL_VERSION,
    },
    game_store::{
        GameActionKind, GameOperationStatus, GameStore, GameTurnRequest, RECENT_TURN_LIMIT,
    },
};
use rusqlite::{params, Connection};

const WORLD_ID: &str = "archive-world-fixture-0001";

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: WORLD_ID.to_owned(),
        title: "全历史中文存档🙂".to_owned(),
        country: "秦".to_owned(),
        era_year: -221,
        location_name: "咸阳".to_owned(),
        protagonist_name: "李明".to_owned(),
        narrative_style: "事实保存，叙事中文。".to_owned(),
    }
}

fn world(path: &Path, turns: usize) {
    let store = GameStore::open(path).unwrap();
    let setup = setup();
    store
        .create_world(
            &setup,
            &initial_state(&setup).unwrap(),
            "你抵达咸阳，保管好行囊🔑。",
            &[],
        )
        .unwrap();
    let mut head = None;
    for index in 1..=turns {
        let id = format!("archive-turn-{index:08}");
        let request = request(&id, head.clone());
        let output = TurnOutput {
            protocol_version: GAME_PROTOCOL_VERSION,
            narrative: format!("第{index}回合：中文、钥匙🔑和时间继续保持。"),
            choices: vec![Choice {
                id: "continue".to_owned(),
                text: "继续。".to_owned(),
            }],
            time_advance: TimeAdvance { elapsed_seconds: 1 },
            state_changes: Vec::new(),
            events: Vec::new(),
            source_references: Vec::new(),
            uncertainties: vec!["固定测试背景，尚未研究。".to_owned()],
        };
        store.begin(&request).unwrap();
        store.mark_generating(&id).unwrap();
        store
            .stage_output(&id, &serde_json::to_string(&output).unwrap())
            .unwrap();
        store.commit(&id, &output).unwrap();
        head = Some(id);
    }
    for (suffix, status, error) in [
        ("failed", GameOperationStatus::Failed, Some("network")),
        ("cancelled", GameOperationStatus::Cancelled, None),
        (
            "interrupted",
            GameOperationStatus::Interrupted,
            Some("process_interrupted"),
        ),
    ] {
        let id = format!("archive-operation-{suffix}");
        store.begin(&request(&id, head.clone())).unwrap();
        store.finish_uncommitted(&id, status, error).unwrap();
    }
}

fn request(id: &str, head: Option<String>) -> GameTurnRequest {
    GameTurnRequest {
        operation_id: id.to_owned(),
        world_id: WORLD_ID.to_owned(),
        branch_id: "main".to_owned(),
        expected_head_turn_id: head,
        action_kind: GameActionKind::Action,
        action_text: "沿街问路，保管行囊🔑。".to_owned(),
    }
}

fn raw_rows(path: &Path) -> Vec<(String, String, String)> {
    let connection = Connection::open(path).unwrap();
    let mut statement = connection
        .prepare("SELECT turn_id,state,output FROM game_turns ORDER BY sequence")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn complete_301_turn_history_and_failed_inputs_are_streamed_without_recent_limit() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("原始中文.sqlite");
    world(&path, 301);
    let store = GameStore::open(&path).unwrap();
    assert_eq!(store.view().unwrap().turns.len(), RECENT_TURN_LIMIT);
    drop(store);
    let archive = LegacyGameArchive::open(&path).unwrap();
    let audit = archive.audit();
    assert_eq!(audit.header.world_id, WORLD_ID);
    assert_eq!(audit.header.turn_count, 301);
    assert_eq!(
        audit.header.head_turn_id.as_deref(),
        Some("archive-turn-00000301")
    );
    assert_eq!(audit.operation_count, 304);
    assert_eq!(audit.committed_operation_count, 301);
    assert_eq!(audit.uncommitted_operation_count, 3);
    let mut previous = None;
    let mut count = 0;
    assert_eq!(
        archive
            .visit_turns(|turn| {
                count += 1;
                assert_eq!(turn.sequence, count);
                assert_eq!(turn.parent_turn_id, previous);
                assert!(turn.output_json.contains("固定测试背景"));
                let state: serde_json::Value = serde_json::from_str(&turn.state_json).unwrap();
                assert_eq!(state["time"]["elapsedSeconds"].as_u64(), Some(count));
                previous = Some(turn.turn_id.clone());
                Ok(ArchiveControl::Continue)
            })
            .unwrap(),
        301
    );
    assert_eq!(count, 301);
    let mut terminal = Vec::new();
    assert_eq!(
        archive
            .visit_operations(|operation| {
                if operation.status != "committed" {
                    terminal.push((operation.status.clone(), operation.action_text.clone()));
                }
                Ok(ArchiveControl::Continue)
            })
            .unwrap(),
        304
    );
    assert_eq!(terminal.len(), 3);
    assert_eq!(
        archive
            .visit_turns(|turn| {
                assert_eq!(turn.sequence, 1);
                Ok(ArchiveControl::Stop)
            })
            .unwrap(),
        1
    );
}

#[test]
fn sqlite_backup_includes_uncheckpointed_wal_and_raw_json_whitespace() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    let destination = directory.path().join("升级前备份.sqlite");
    world(&source, 4);
    let writer = Connection::open(&source).unwrap();
    writer
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    let original_trigger: String = writer
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='game_turns_no_update'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    // A fixture deliberately stores differently spaced equivalent JSON, then
    // restores the immutable trigger. Backups must retain exact raw strings.
    let output: String = writer
        .query_row(
            "SELECT output FROM game_turns WHERE sequence=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let pretty =
        serde_json::to_string_pretty(&serde_json::from_str::<serde_json::Value>(&output).unwrap())
            .unwrap();
    writer
        .execute_batch("DROP TRIGGER game_turns_no_update;")
        .unwrap();
    writer
        .execute(
            "UPDATE game_turns SET output=?1 WHERE sequence=1",
            [&pretty],
        )
        .unwrap();
    writer.execute_batch(&original_trigger).unwrap();
    writer
        .execute(
            "UPDATE game_world SET narrative_policy=?1",
            ["只存在于WAL的新叙事方针🙂"],
        )
        .unwrap();
    let wal_path = source.with_file_name("source.sqlite-wal");
    assert!(fs::metadata(&wal_path).unwrap().len() > 0);
    let source_main = fs::read(&source).unwrap();
    let source_wal = fs::read(&wal_path).unwrap();
    let original_rows = raw_rows(&source);
    let archive = LegacyGameArchive::open(&source).unwrap();
    assert_eq!(
        archive.audit().header.narrative_policy,
        "只存在于WAL的新叙事方针🙂"
    );
    let copied = archive.backup_to_new(&destination).unwrap();
    assert_eq!(&copied, archive.audit());
    assert_eq!(fs::read(&source).unwrap(), source_main);
    assert_eq!(fs::read(&wal_path).unwrap(), source_wal);
    assert_eq!(raw_rows(&destination), original_rows);
    assert_eq!(original_rows[0].2, pretty);
    let backup = LegacyGameArchive::open(&destination).unwrap();
    assert_eq!(backup.audit(), archive.audit());
    assert!(!destination.with_file_name("升级前备份.sqlite-wal").exists());
    assert_eq!(
        Connection::open(&destination)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))
            .unwrap(),
        1
    );
}

#[test]
fn an_existing_destination_and_its_bytes_are_never_overwritten() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    let destination = directory.path().join("existing.sqlite");
    world(&source, 1);
    fs::write(&destination, b"existing user-owned data").unwrap();
    let archive = LegacyGameArchive::open(&source).unwrap();
    assert_eq!(
        archive.backup_to_new(&destination).unwrap_err(),
        GameArchiveError::DestinationExists
    );
    assert_eq!(fs::read(&destination).unwrap(), b"existing user-owned data");
    assert_eq!(
        archive.backup_to_new(&source).unwrap_err(),
        GameArchiveError::Busy
    );
    assert_eq!(archive.audit().header.turn_count, 1);
}

#[test]
fn preexisting_sidecar_is_refused_and_preserved() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    let destination = directory.path().join("reserved.sqlite");
    let sidecar = directory.path().join("reserved.sqlite-wal");
    world(&source, 0);
    fs::write(&sidecar, b"not created by this attempt").unwrap();
    let archive = LegacyGameArchive::open(&source).unwrap();
    assert_eq!(
        archive.backup_to_new(&destination).unwrap_err(),
        GameArchiveError::DestinationExists
    );
    assert_eq!(fs::read(&sidecar).unwrap(), b"not created by this attempt");
    assert!(!destination.exists());
}

#[test]
fn source_owner_busy_refuses_without_changing_live_operation() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    world(&source, 0);
    let store = GameStore::open(&source).unwrap();
    let operation_id = "archive-live-operation-0001";
    store.begin(&request(operation_id, None)).unwrap();
    assert_eq!(
        LegacyGameArchive::open(&source).unwrap_err(),
        GameArchiveError::Busy
    );
    assert_eq!(
        store.view().unwrap().latest_operation.unwrap().status,
        GameOperationStatus::Pending
    );
    drop(store);
    // Unlike GameStore::open, the archive does not recover abandoned requests.
    let before = fs::read(&source).unwrap();
    assert_eq!(
        LegacyGameArchive::open(&source).unwrap_err(),
        GameArchiveError::Busy
    );
    assert_eq!(fs::read(&source).unwrap(), before);
    let connection = Connection::open(&source).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT status FROM game_operations WHERE operation_id=?1",
                [operation_id],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "pending"
    );
}

#[test]
fn target_owner_busy_does_not_create_a_backup() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    let destination = directory.path().join("target.sqlite");
    world(&source, 0);
    let target_lock = fs::File::options()
        .read(true)
        .write(true)
        .create_new(true)
        .open(directory.path().join("target.sqlite.owner-lock"))
        .unwrap();
    target_lock.try_lock().unwrap();
    let archive = LegacyGameArchive::open(&source).unwrap();
    assert_eq!(
        archive.backup_to_new(&destination).unwrap_err(),
        GameArchiveError::Busy
    );
    assert!(!destination.exists());
}

#[test]
fn abandoned_generating_and_validating_operations_keep_their_status_and_candidate() {
    for phase in ["generating", "validating"] {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.sqlite");
        world(&source, 0);
        let store = GameStore::open(&source).unwrap();
        let id = "archive-abandoned-operation-0001";
        store.begin(&request(id, None)).unwrap();
        store.mark_generating(id).unwrap();
        if phase == "validating" {
            store
                .stage_output(id, "PRIVATE provisional model candidate")
                .unwrap();
        }
        drop(store);
        let before = fs::read(&source).unwrap();
        assert_eq!(
            LegacyGameArchive::open(&source).unwrap_err(),
            GameArchiveError::Busy
        );
        assert_eq!(fs::read(&source).unwrap(), before);
        let connection = Connection::open(&source).unwrap();
        let (status, candidate): (String, Option<String>) = connection
            .query_row(
                "SELECT status,candidate FROM game_operations WHERE operation_id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, phase);
        assert_eq!(
            candidate.as_deref(),
            (phase == "validating").then_some("PRIVATE provisional model candidate")
        );
    }
}

#[test]
fn source_read_transaction_keeps_backup_on_the_same_audited_wal_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    let destination = directory.path().join("snapshot.sqlite");
    world(&source, 2);
    let writer = Connection::open(&source).unwrap();
    writer
        .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    writer
        .execute(
            "UPDATE game_world SET narrative_policy=?1",
            ["审计时的方针"],
        )
        .unwrap();
    let archive = LegacyGameArchive::open(&source).unwrap();
    // This deliberately bypasses the app owner lock in the fixture. Even an
    // outside writer must not make audit and backup refer to different heads.
    writer
        .execute(
            "UPDATE game_world SET narrative_policy=?1",
            ["审计之后的外部方针"],
        )
        .unwrap();
    let copied = archive.backup_to_new(&destination).unwrap();
    assert_eq!(copied.header.narrative_policy, "审计时的方针");
    assert_eq!(&copied, archive.audit());
    assert_eq!(
        writer
            .query_row("SELECT narrative_policy FROM game_world", [], |row| row
                .get::<_, String>(
                0
            ))
            .unwrap(),
        "审计之后的外部方针"
    );
    assert_eq!(
        LegacyGameArchive::open(&destination).unwrap().audit(),
        archive.audit()
    );
}

#[test]
fn future_version_wrong_application_and_uninitialized_database_are_read_only_rejected() {
    for (version, application) in [(2, 0x4c495348), (1, 42), (0, 0)] {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.sqlite");
        world(&source, 1);
        let connection = Connection::open(&source).unwrap();
        connection
            .pragma_update(None, "user_version", version)
            .unwrap();
        connection
            .pragma_update(None, "application_id", application)
            .unwrap();
        drop(connection);
        let before = fs::read(&source).unwrap();
        assert_eq!(
            LegacyGameArchive::open(&source).unwrap_err(),
            GameArchiveError::IncompatibleSchema
        );
        assert_eq!(fs::read(&source).unwrap(), before);
    }
    let directory = tempfile::tempdir().unwrap();
    let missing = directory.path().join("not-created.sqlite");
    assert_eq!(
        LegacyGameArchive::open(&missing).unwrap_err(),
        GameArchiveError::Unavailable
    );
    assert!(!missing.exists());
    assert!(!directory
        .path()
        .join("not-created.sqlite.owner-lock")
        .exists());
}

#[test]
fn wrong_head_count_chain_snapshot_or_immutable_trigger_is_rejected() {
    for corruption in [
        "UPDATE game_world SET turn_count=3",
        "UPDATE game_world SET head_turn_id='archive-turn-00000001'",
        "UPDATE game_turns SET parent_turn_id=NULL WHERE sequence=2",
        "UPDATE game_turns SET sequence=4 WHERE sequence=2",
        "UPDATE game_turns SET state=(SELECT initial_state FROM game_world) WHERE sequence=1",
        "UPDATE game_operations SET status='failed' WHERE operation_id='archive-turn-00000002'",
        "DROP TRIGGER game_turns_no_delete",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.sqlite");
        world(&source, 2);
        let connection = Connection::open(&source).unwrap();
        let trigger: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='game_turns_no_update'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        connection
            .execute_batch("DROP TRIGGER game_turns_no_update;")
            .unwrap();
        connection.execute_batch(corruption).unwrap();
        connection.execute_batch(&trigger).unwrap();
        drop(connection);
        let before = fs::read(&source).unwrap();
        assert_eq!(
            LegacyGameArchive::open(&source).unwrap_err(),
            GameArchiveError::InvalidArchive,
            "{corruption}"
        );
        assert_eq!(fs::read(&source).unwrap(), before);
    }
}

#[test]
fn cancelling_an_incomplete_backup_removes_only_its_reserved_target() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    let destination = directory.path().join("cancelled.sqlite");
    world(&source, 301);
    let before = fs::read(&source).unwrap();
    let archive = LegacyGameArchive::open(&source).unwrap();
    let mut calls = 0;
    assert_eq!(
        archive
            .backup_to_new_with_progress(&destination, |progress| {
                calls += 1;
                assert!(progress.remaining_pages > 0);
                Ok(ArchiveControl::Stop)
            })
            .unwrap_err(),
        GameArchiveError::Cancelled
    );
    assert_eq!(calls, 1);
    assert!(!destination.exists());
    assert!(!directory.path().join("cancelled.sqlite-journal").exists());
    assert_eq!(fs::read(&source).unwrap(), before);
    assert!(directory
        .path()
        .join("cancelled.sqlite.owner-lock")
        .exists());
    // Lock is released after failure; a new explicit attempt may safely retry.
    assert_eq!(
        archive.backup_to_new(&destination).unwrap(),
        archive.audit().clone()
    );
}

#[test]
fn backup_failure_keeps_source_and_prior_successful_backup_usable() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    let successful = directory.path().join("successful.sqlite");
    let failed = directory.path().join("failed.sqlite");
    world(&source, 301);
    let archive = LegacyGameArchive::open(&source).unwrap();
    archive.backup_to_new(&successful).unwrap();
    let before_source = fs::read(&source).unwrap();
    let before_backup = fs::read(&successful).unwrap();
    assert_eq!(
        archive
            .backup_to_new_with_progress(&failed, |_| Err(GameArchiveError::BackupFailed))
            .unwrap_err(),
        GameArchiveError::BackupFailed
    );
    assert!(!failed.exists());
    assert_eq!(fs::read(&source).unwrap(), before_source);
    assert_eq!(fs::read(&successful).unwrap(), before_backup);
    assert_eq!(
        LegacyGameArchive::open(&successful).unwrap().audit(),
        archive.audit()
    );
    let invalid_parent = directory.path().join("parent-is-a-file");
    fs::write(&invalid_parent, b"preserve parent").unwrap();
    assert_eq!(
        archive
            .backup_to_new(invalid_parent.join("failed.sqlite"))
            .unwrap_err(),
        GameArchiveError::Unavailable
    );
    assert_eq!(fs::read(&invalid_parent).unwrap(), b"preserve parent");
}

#[test]
fn error_strings_do_not_contain_private_paths_or_record_content() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("private-source-name.sqlite");
    fs::write(&source, b"PRIVATE RECORD CONTENT").unwrap();
    let error = LegacyGameArchive::open(&source).unwrap_err();
    assert_eq!(error.to_string(), "game_archive_invalid");
    assert!(!format!("{error:?}").contains("private-source"));
    assert!(!format!("{error:?}").contains("PRIVATE RECORD"));
}

#[test]
fn audit_rejects_mismatch_between_operation_input_and_committed_turn() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.sqlite");
    world(&source, 2);
    let connection = Connection::open(&source).unwrap();
    let trigger: String = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name='game_operation_input_no_update'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute_batch("DROP TRIGGER game_operation_input_no_update;")
        .unwrap();
    connection
        .execute(
            "UPDATE game_operations SET action_text=?1 WHERE operation_id=?2",
            params!["篡改了输入", "archive-turn-00000001"],
        )
        .unwrap();
    connection.execute_batch(&trigger).unwrap();
    drop(connection);
    assert_eq!(
        LegacyGameArchive::open(&source).unwrap_err(),
        GameArchiveError::InvalidArchive
    );
}
