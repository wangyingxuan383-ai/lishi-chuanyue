use lishi_core::{
    game_archive::LegacyGameArchive,
    game_migration::{upgrade_v1, upgrade_v1_with_hook, MigrationBoundary, MigrationError},
    game_protocol::{initial_state, TimeAdvance, TurnOutput, WorldSetup},
    game_protocol_v2::WorldStateV2,
    game_store::{GameActionKind, GameStore, GameTurnRequest},
};
use rusqlite::Connection;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: "migration-fixed-world-01".into(),
        title: "旧世界迁移🙂".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "李明".into(),
        narrative_style: "固定迁移验收".into(),
    }
}
fn make_world(path: &Path) {
    let store = GameStore::open(path).unwrap();
    let s = setup();
    store
        .create_world(&s, &initial_state(&s).unwrap(), "你带着行囊来到城内。", &[])
        .unwrap();
    let mut head = None;
    for n in 1..=2 {
        let id = format!("migration-turn-000{n}");
        let req = GameTurnRequest {
            operation_id: id.clone(),
            world_id: s.world_id.clone(),
            branch_id: "main".into(),
            expected_head_turn_id: head.clone(),
            action_kind: GameActionKind::Action,
            action_text: "看守行囊🔑".into(),
        };
        let output = TurnOutput {
            protocol_version: 1,
            narrative: format!("第{n}回合，行囊仍在。"),
            choices: vec![],
            time_advance: TimeAdvance {
                elapsed_seconds: 60,
            },
            state_changes: vec![],
            events: vec![],
            source_references: vec![],
            uncertainties: vec![],
        };
        store.begin(&req).unwrap();
        store.mark_generating(&id).unwrap();
        store
            .stage_output(&id, &serde_json::to_string(&output).unwrap())
            .unwrap();
        store.commit(&id, &output).unwrap();
        head = Some(id);
    }
}
fn rows(path: &Path) -> Vec<(String, String, String)> {
    let db = Connection::open(path).unwrap();
    let mut stmt = db
        .prepare("SELECT turn_id,state,output FROM game_turns ORDER BY sequence")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}
fn version(path: &Path) -> i32 {
    Connection::open(path)
        .unwrap()
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap()
}

#[test]
fn successful_upgrade_preserves_old_raw_records_and_self_contained_v1_backup() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("世界.sqlite");
    make_world(&path);
    let before = rows(&path);
    let audit = LegacyGameArchive::open(&path).unwrap().audit().clone();
    let receipt = upgrade_v1(&path, temp.path()).unwrap();
    assert_eq!(version(&path), 2);
    assert_eq!(rows(&path), before);
    assert_eq!(receipt.content_sha256, audit.content_sha256);
    assert_eq!(receipt.turn_count, 2);
    let backup = temp.path().join(&receipt.backup_basename);
    assert_eq!(version(&backup), 1);
    assert_eq!(LegacyGameArchive::open(&backup).unwrap().audit(), &audit);
    let db = Connection::open(&path).unwrap();
    let raw: String = db
        .query_row("SELECT current_state FROM game_world", [], |r| r.get(0))
        .unwrap();
    let current: WorldStateV2 = serde_json::from_str(&raw).unwrap();
    assert_eq!(current.time.elapsed_seconds, 120);
    assert_eq!(current.entities[0].name, "李明");
    assert_eq!(current.resources[0].amount, 100);
    assert!(GameStore::open(&path).is_err()); // Old application cannot write v2.
    assert_eq!(
        GameStore::open(&backup).unwrap().view().unwrap().turn_count,
        2
    );
    assert!(!serde_json::to_string(&receipt)
        .unwrap()
        .contains(temp.path().to_string_lossy().as_ref()));
}

#[test]
fn precommit_failure_rolls_back_schema_and_projection_but_keeps_verified_backup() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("world.sqlite");
    make_world(&path);
    let before = rows(&path);
    let error = upgrade_v1_with_hook(&path, temp.path(), |point| {
        if point == MigrationBoundary::BeforeCommit {
            Err(MigrationError::Database)
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert_eq!(error, MigrationError::Database);
    assert_eq!(version(&path), 1);
    assert_eq!(rows(&path), before);
    let archive = LegacyGameArchive::open(&path).unwrap();
    assert_eq!(archive.audit().header.turn_count, 2);
    let files: Vec<_> = fs::read_dir(temp.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| {
            e.path().extension().is_some_and(|x| x == "sqlite")
                && e.file_name().to_string_lossy().contains("pre-v2")
        })
        .collect();
    assert_eq!(files.len(), 1);
}

#[test]
fn active_owner_and_bad_backup_directory_fail_without_upgrading() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("world.sqlite");
    make_world(&path);
    let owner = GameStore::open(&path).unwrap();
    assert_eq!(
        upgrade_v1(&path, temp.path()).unwrap_err(),
        MigrationError::Busy
    );
    drop(owner);
    let bad = temp.path().join("not-a-directory");
    fs::write(&bad, b"keep me").unwrap();
    assert_eq!(
        upgrade_v1(&path, &bad).unwrap_err(),
        MigrationError::Unavailable
    );
    assert_eq!(fs::read(bad).unwrap(), b"keep me");
    assert_eq!(version(&path), 1);
}

#[test]
fn migration_child_harness() {
    let Ok(source) = std::env::var("LISHI_MIGRATION_CHILD_PATH") else {
        return;
    };
    let backup = std::env::var("LISHI_MIGRATION_CHILD_BACKUP").unwrap();
    let stop = std::env::var("LISHI_MIGRATION_CHILD_BOUNDARY").unwrap();
    upgrade_v1_with_hook(source, backup, |point| {
        if format!("{point:?}") == stop {
            println!("BOUNDARY_READY");
            std::io::stdout().flush().unwrap();
            loop {
                std::thread::park();
            }
        }
        Ok(())
    })
    .unwrap();
}

#[test]
fn acknowledged_process_kills_leave_complete_old_or_new_schema_and_all_raw_turns() {
    for (point, expected) in [
        ("BackupReady", 1),
        ("BeforeTransaction", 1),
        ("BeforeCommit", 1),
        ("Committed", 2),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("world.sqlite");
        make_world(&path);
        let before = rows(&path);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "migration_child_harness", "--nocapture"])
            .env("LISHI_MIGRATION_CHILD_PATH", &path)
            .env("LISHI_MIGRATION_CHILD_BACKUP", temp.path())
            .env("LISHI_MIGRATION_CHILD_BOUNDARY", point)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line.unwrap_or_default().contains("BOUNDARY_READY") {
                    let _ = tx.send(());
                    break;
                }
            }
        });
        if rx.recv_timeout(Duration::from_secs(15)).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Child did not acknowledge {point}");
        }
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(version(&path), expected, "{point}");
        assert_eq!(rows(&path), before, "{point}");
        let db = Connection::open(&path).unwrap();
        let integrity: String = db
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
        let backups: Vec<_> = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.path().extension().is_some_and(|x| x == "sqlite")
                    && e.file_name().to_string_lossy().contains("pre-v2")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(version(&backups[0].path()), 1);
    }
}
