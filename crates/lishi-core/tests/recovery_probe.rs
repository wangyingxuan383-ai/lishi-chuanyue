use std::{
    fs::File,
    io::Write,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Barrier},
    time::{Duration, Instant},
};

use lishi_core::recovery::{RecoveryError, RecoveryStatus, RecoveryStore, MAX_RECOVERY_TEXT_BYTES};

const INITIAL_ID: &str = "recovery-baseline";
const INITIAL_TEXT: &str = "长安的正式快照🙂\n钥匙仍在。";
const NEXT_ID: &str = "recovery-next-op";
const NEXT_TEXT: &str = "下一份完整正式快照\n中文与emoji🙂";

fn commit_text(store: &RecoveryStore, id: &str, head: Option<&str>, text: &str) {
    store.begin(id, head).expect("persist pending");
    store.mark_generating(id).expect("start generation");
    store.stage_validation(id, text).expect("stage candidate");
    store.commit(id).expect("commit atomically");
}

#[test]
fn completed_snapshot_reopens_and_duplicate_or_stale_requests_never_commit() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("recovery.sqlite");
    let store = RecoveryStore::open(&path).unwrap();
    assert_eq!(store.view().unwrap().snapshot.revision, 0);
    commit_text(&store, INITIAL_ID, None, INITIAL_TEXT);
    let before = store.view().unwrap();
    assert_eq!(before.snapshot.text, INITIAL_TEXT);
    assert_eq!(
        before.latest_operation.as_ref().unwrap().status,
        RecoveryStatus::Committed
    );
    assert_eq!(
        store.begin(INITIAL_ID, Some(INITIAL_ID)),
        Err(RecoveryError::Duplicate)
    );
    assert_eq!(
        store.commit(INITIAL_ID),
        Err(RecoveryError::InvalidTransition)
    );
    assert_eq!(store.begin(NEXT_ID, None), Err(RecoveryError::StaleHead));
    assert_eq!(store.view().unwrap(), before);
    drop(store);
    assert_eq!(RecoveryStore::open(path).unwrap().view().unwrap(), before);
}

#[test]
fn owner_lock_rejects_second_live_host_without_interrupting_its_operation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("owned.sqlite");
    let store = RecoveryStore::open(&path).unwrap();
    store.begin(NEXT_ID, None).unwrap();
    store.mark_generating(NEXT_ID).unwrap();
    assert!(matches!(
        RecoveryStore::open(&path),
        Err(RecoveryError::Busy)
    ));
    assert_eq!(
        store.view().unwrap().latest_operation.unwrap().status,
        RecoveryStatus::Generating
    );
    drop(store);
    let reopened = RecoveryStore::open(path).unwrap();
    assert_eq!(
        reopened.view().unwrap().latest_operation.unwrap().status,
        RecoveryStatus::Interrupted
    );
    assert_eq!(reopened.view().unwrap().snapshot.revision, 0);
}

#[test]
fn pending_generating_and_validating_recover_as_interrupted_without_formal_draft() {
    for stage in [
        RecoveryStatus::Pending,
        RecoveryStatus::Generating,
        RecoveryStatus::Validating,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recover.sqlite");
        let store = RecoveryStore::open(&path).unwrap();
        commit_text(&store, INITIAL_ID, None, INITIAL_TEXT);
        store.begin(NEXT_ID, Some(INITIAL_ID)).unwrap();
        if stage != RecoveryStatus::Pending {
            store.mark_generating(NEXT_ID).unwrap();
        }
        if stage == RecoveryStatus::Validating {
            store.stage_validation(NEXT_ID, NEXT_TEXT).unwrap();
        }
        assert_eq!(store.view().unwrap().snapshot.text, INITIAL_TEXT);
        drop(store);
        let store = RecoveryStore::open(&path).unwrap();
        let view = store.view().unwrap();
        assert_eq!(view.snapshot.text, INITIAL_TEXT);
        assert_eq!(view.snapshot.revision, 1);
        assert_eq!(view.active_operation_id, None);
        assert_eq!(
            view.latest_operation.unwrap().status,
            RecoveryStatus::Interrupted
        );
        assert_eq!(store.commit(NEXT_ID), Err(RecoveryError::InvalidTransition));
        assert_eq!(
            store.begin(NEXT_ID, Some(INITIAL_ID)),
            Err(RecoveryError::Duplicate)
        );
        let raw = rusqlite::Connection::open(path).unwrap();
        let candidate: Option<String> = raw
            .query_row(
                "SELECT candidate FROM recovery_operations WHERE operation_id=?1",
                [NEXT_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(candidate, None);
    }
}

#[test]
fn failed_cancelled_and_invalid_candidates_keep_formal_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let store = RecoveryStore::open(directory.path().join("fail.sqlite")).unwrap();
    commit_text(&store, INITIAL_ID, None, INITIAL_TEXT);
    for (index, status) in [RecoveryStatus::Failed, RecoveryStatus::Cancelled]
        .into_iter()
        .enumerate()
    {
        let id = format!("failed-operation-{index}");
        store.begin(&id, Some(INITIAL_ID)).unwrap();
        assert_eq!(
            store.stage_validation(&id, NEXT_TEXT),
            Err(RecoveryError::InvalidTransition)
        );
        store.mark_generating(&id).unwrap();
        assert_eq!(
            store.stage_validation(&id, ""),
            Err(RecoveryError::InvalidText)
        );
        assert_eq!(
            store.stage_validation(&id, &"中".repeat(MAX_RECOVERY_TEXT_BYTES / 3 + 1)),
            Err(RecoveryError::InvalidText)
        );
        assert_eq!(
            store.view().unwrap().latest_operation.unwrap().status,
            RecoveryStatus::Generating
        );
        assert_eq!(
            store.finish_uncommitted(&id, status, Some("http://private.invalid")),
            Err(RecoveryError::InvalidErrorCode)
        );
        store
            .finish_uncommitted(&id, status, Some("unexpected_eof"))
            .unwrap();
        assert_eq!(store.view().unwrap().snapshot.text, INITIAL_TEXT);
        assert_eq!(store.view().unwrap().snapshot.revision, 1);
        assert_eq!(store.commit(&id), Err(RecoveryError::InvalidTransition));
    }
}

#[test]
fn simultaneous_begin_has_one_winner_and_rejects_stale_head_after_commit() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(RecoveryStore::open(directory.path().join("parallel.sqlite")).unwrap());
    let barrier = Arc::new(Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|index| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let id = format!("parallel-op-{index}");
                barrier.wait();
                let result = store.begin(&id, None);
                (id, result)
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(
        results.iter().filter(|(_, result)| result.is_ok()).count(),
        1
    );
    assert!(results
        .iter()
        .all(|(_, result)| result.is_ok() || *result == Err(RecoveryError::Busy)));
    let winner = &results.iter().find(|(_, result)| result.is_ok()).unwrap().0;
    store.mark_generating(winner).unwrap();
    store.stage_validation(winner, INITIAL_TEXT).unwrap();
    store.commit(winner).unwrap();
    assert_eq!(store.begin(NEXT_ID, None), Err(RecoveryError::StaleHead));
    assert_eq!(store.view().unwrap().snapshot.revision, 1);
}

#[test]
fn sql_failure_after_snapshot_write_and_cancel_hook_roll_back_all_three_records() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollback.sqlite");
    let store = RecoveryStore::open(&path).unwrap();
    commit_text(&store, INITIAL_ID, None, INITIAL_TEXT);
    store.begin(NEXT_ID, Some(INITIAL_ID)).unwrap();
    store.mark_generating(NEXT_ID).unwrap();
    store.stage_validation(NEXT_ID, NEXT_TEXT).unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("CREATE TRIGGER crash_after_snapshot BEFORE INSERT ON recovery_committed BEGIN SELECT RAISE(FAIL,'injected'); END;").unwrap();
    assert_eq!(store.commit(NEXT_ID), Err(RecoveryError::Database));
    assert_eq!(store.view().unwrap().snapshot.text, INITIAL_TEXT);
    assert_eq!(
        store.view().unwrap().latest_operation.unwrap().status,
        RecoveryStatus::Validating
    );
    connection
        .execute_batch("DROP TRIGGER crash_after_snapshot;")
        .unwrap();
    assert_eq!(
        store.commit_with_hook(NEXT_ID, || Err(RecoveryError::Cancelled)),
        Err(RecoveryError::Cancelled)
    );
    assert_eq!(store.view().unwrap().snapshot.revision, 1);
    let count: i64 = connection
        .query_row("SELECT count(*) FROM recovery_committed", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
    store.commit(NEXT_ID).unwrap();
    assert_eq!(store.view().unwrap().snapshot.revision, 2);
    assert_eq!(store.view().unwrap().snapshot.text, NEXT_TEXT);
    let count: i64 = connection
        .query_row("SELECT count(*) FROM recovery_committed", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 2);
}

fn child_ready_and_wait(ready: &Path) {
    let mut file = File::create_new(ready).unwrap();
    file.write_all(b"at-boundary").unwrap();
    file.sync_all().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("parent did not terminate isolated crash child");
}

/// Launched only by the test below, using this test executable itself. It has
/// no application paths, keys, HTTP calls, or arbitrary failpoint commands.
#[test]
fn recovery_child_process_harness() {
    let Some(path) = std::env::var_os("LISHI_RECOVERY_TEST_DB") else {
        return;
    };
    let ready = std::env::var_os("LISHI_RECOVERY_TEST_READY").unwrap();
    let phase = std::env::var("LISHI_RECOVERY_TEST_PHASE").unwrap();
    let store = RecoveryStore::open(Path::new(&path)).unwrap();
    store.begin(NEXT_ID, Some(INITIAL_ID)).unwrap();
    if phase == "pending" {
        child_ready_and_wait(Path::new(&ready));
        return;
    }
    store.mark_generating(NEXT_ID).unwrap();
    if phase == "generating" {
        child_ready_and_wait(Path::new(&ready));
        return;
    }
    store.stage_validation(NEXT_ID, NEXT_TEXT).unwrap();
    if phase == "validating" {
        child_ready_and_wait(Path::new(&ready));
        return;
    }
    if phase == "transaction" {
        store
            .commit_with_hook(NEXT_ID, || {
                child_ready_and_wait(Path::new(&ready));
                Ok(())
            })
            .unwrap();
        return;
    }
    assert_eq!(phase, "committed");
    store.commit(NEXT_ID).unwrap();
    child_ready_and_wait(Path::new(&ready));
}

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn strong_kill_at_acknowledged_boundaries_is_all_or_nothing_and_releases_owner() {
    for phase in [
        "pending",
        "generating",
        "validating",
        "transaction",
        "committed",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("child.sqlite");
        let ready = directory.path().join("ready");
        let store = RecoveryStore::open(&path).unwrap();
        commit_text(&store, INITIAL_ID, None, INITIAL_TEXT);
        drop(store);
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "recovery_child_process_harness", "--nocapture"])
            .env("LISHI_RECOVERY_TEST_DB", &path)
            .env("LISHI_RECOVERY_TEST_READY", &ready)
            .env("LISHI_RECOVERY_TEST_PHASE", phase)
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
                "child exited before {phase} acknowledgement"
            );
            if std::fs::read(&ready).ok().as_deref() == Some(b"at-boundary") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "child never acknowledged {phase}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        child
            .0
            .kill()
            .expect("kill only owned isolated child after boundary acknowledgement");
        child.0.wait().unwrap();
        drop(child);
        let store = RecoveryStore::open(&path).expect("kill releases owner; WAL recovers");
        let view = store.view().unwrap();
        let did_commit = phase == "committed";
        assert_eq!(
            view.snapshot.revision,
            if did_commit { 2 } else { 1 },
            "{phase}"
        );
        assert_eq!(
            view.snapshot.text,
            if did_commit { NEXT_TEXT } else { INITIAL_TEXT },
            "{phase}"
        );
        assert_eq!(
            view.latest_operation.unwrap().status,
            if did_commit {
                RecoveryStatus::Committed
            } else {
                RecoveryStatus::Interrupted
            },
            "{phase}"
        );
        assert_eq!(view.active_operation_id, None);
        assert_eq!(
            store.begin(NEXT_ID, view.snapshot.operation_id.as_deref()),
            Err(RecoveryError::Duplicate)
        );
        let raw = rusqlite::Connection::open(path).unwrap();
        let count: i64 = raw
            .query_row("SELECT count(*) FROM recovery_committed", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, if did_commit { 2 } else { 1 }, "{phase}");
        let (latest_status, latest_text): (String, Option<String>) = raw
            .query_row(
                "SELECT status,candidate FROM recovery_operations WHERE operation_id=?1",
                [NEXT_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            latest_status,
            if did_commit {
                "committed"
            } else {
                "interrupted"
            }
        );
        assert_eq!(
            latest_text, None,
            "provisional candidate cleared after restart"
        );
    }
}
