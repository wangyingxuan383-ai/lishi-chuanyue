//! Persistent local budget, crash uncertainty and safe diagnostic boundaries.
use lishi_core::{
    game_call_log::{CallLog, CallLogError, CallState},
    model_probe::ModelProbeDiagnostics,
    stream::TokenUsage,
    StreamErrorCode, StreamStatus,
};
use std::{
    process::{Command, Stdio},
    sync::{Arc, Barrier},
    time::{Duration, Instant},
};

const OP: &str = "model-operation-0001";
fn reserve(log: &CallLog, operation: &str) -> Result<u8, CallLogError> {
    log.reserve(operation, "call-log-world-0001", "main", "fixture-model", 4)
}
fn diagnostics(attempts: u8) -> ModelProbeDiagnostics {
    ModelProbeDiagnostics {
        attempts,
        elapsed_ms: 17,
        http_status: None,
        usage: None,
    }
}

#[test]
fn two_reservations_are_a_hard_operation_limit_even_for_known_zero_attempts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calls.sqlite");
    let log = CallLog::open(&path).unwrap();
    assert_eq!(reserve(&log, OP), Ok(1));
    let zero = log
        .finish(
            OP,
            1,
            &diagnostics(0),
            StreamStatus::Cancelled,
            Some(StreamErrorCode::InvalidConfig),
        )
        .unwrap();
    assert_eq!(zero.state, CallState::Cancelled);
    assert_eq!(zero.actual_http_attempts, Some(0));
    assert!(!zero.sent_unknown);
    assert_eq!(reserve(&log, OP), Ok(2));
    let mut result = diagnostics(1);
    result.http_status = Some(429);
    let failed = log
        .finish(
            OP,
            2,
            &result,
            StreamStatus::Failed,
            Some(StreamErrorCode::HttpStatus),
        )
        .unwrap();
    assert_eq!(failed.actual_http_attempts, Some(1));
    assert_eq!(failed.http_status, Some(429));
    assert_eq!(failed.error_code.as_deref(), Some("http_status"));
    assert_eq!(reserve(&log, OP), Err(CallLogError::BudgetExhausted));
    assert_eq!(
        log.finish(
            OP,
            2,
            &result,
            StreamStatus::Failed,
            Some(StreamErrorCode::HttpStatus)
        ),
        Ok(failed.clone())
    );
    assert_eq!(
        log.finish(OP, 2, &diagnostics(1), StreamStatus::Completed, None),
        Err(CallLogError::Conflict)
    );
    drop(log);
    let reopened = CallLog::open(&path).unwrap();
    assert_eq!(reopened.operation(OP).unwrap(), vec![zero, failed]);
    assert_eq!(reserve(&reopened, OP), Err(CallLogError::BudgetExhausted));
    assert_eq!(reserve(&reopened, "independent-operation-0002"), Ok(1));
}

#[test]
fn unknown_delivery_survives_reopen_and_late_completion_cannot_rewrite_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calls.sqlite");
    let log = CallLog::open(&path).unwrap();
    reserve(&log, OP).unwrap();
    assert_eq!(CallLog::open(&path).unwrap_err(), CallLogError::Busy);
    let pending = log.operation(OP).unwrap().remove(0);
    assert_eq!(pending.state, CallState::Reserved);
    assert!(pending.sent_unknown);
    assert_eq!(pending.actual_http_attempts, None);
    drop(log);
    let reopened = CallLog::open(&path).unwrap();
    let interrupted = reopened.operation(OP).unwrap().remove(0);
    assert_eq!(interrupted.state, CallState::Interrupted);
    assert!(interrupted.sent_unknown);
    assert_eq!(interrupted.actual_http_attempts, None);
    assert_eq!(
        interrupted.error_code.as_deref(),
        Some("process_interrupted")
    );
    assert!(interrupted.finished_at_ms.unwrap() >= interrupted.created_at_ms);
    assert_eq!(
        reopened.finish(
            OP,
            1,
            &diagnostics(1),
            StreamStatus::Failed,
            Some(StreamErrorCode::Network)
        ),
        Err(CallLogError::Conflict)
    );
    assert_eq!(reserve(&reopened, OP), Ok(2));
    assert_eq!(reserve(&reopened, OP), Err(CallLogError::BudgetExhausted));
}

#[test]
fn concurrent_reservations_share_the_same_limit_and_reject_scope_or_model_switches() {
    let dir = tempfile::tempdir().unwrap();
    let log = Arc::new(CallLog::open(dir.path().join("calls.sqlite")).unwrap());
    let barrier = Arc::new(Barrier::new(8));
    let threads = (0..8)
        .map(|_| {
            let log = Arc::clone(&log);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                reserve(&log, OP)
            })
        })
        .collect::<Vec<_>>();
    let results = threads
        .into_iter()
        .map(|t| t.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 2);
    assert_eq!(
        results
            .iter()
            .filter(|r| **r == Err(CallLogError::BudgetExhausted))
            .count(),
        6
    );
    assert_eq!(
        log.reserve(OP, "other-world-0001", "main", "fixture-model", 4),
        Err(CallLogError::Conflict)
    );
    assert_eq!(
        log.reserve(OP, "call-log-world-0001", "child", "fixture-model", 4),
        Err(CallLogError::Conflict)
    );
    assert_eq!(
        log.reserve(OP, "call-log-world-0001", "main", "different-model", 4),
        Err(CallLogError::Conflict)
    );
    assert_eq!(
        log.reserve(OP, "call-log-world-0001", "main", "fixture-model", 5),
        Err(CallLogError::Conflict)
    );
    assert_eq!(log.list(200).unwrap().len(), 2);
}

#[test]
fn usage_is_exact_and_invalid_diagnostics_do_not_change_a_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let log = CallLog::open(dir.path().join("calls.sqlite")).unwrap();
    reserve(&log, OP).unwrap();
    let mut d = diagnostics(2);
    assert_eq!(
        log.finish(
            OP,
            1,
            &d,
            StreamStatus::Failed,
            Some(StreamErrorCode::Network)
        ),
        Err(CallLogError::Invalid)
    );
    d.attempts = 0;
    d.http_status = Some(200);
    assert_eq!(
        log.finish(OP, 1, &d, StreamStatus::Failed, None),
        Err(CallLogError::Invalid)
    );
    d.attempts = 1;
    d.usage = Some(TokenUsage {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 99,
    });
    assert_eq!(
        log.finish(OP, 1, &d, StreamStatus::Completed, None),
        Err(CallLogError::Invalid)
    );
    assert_eq!(log.operation(OP).unwrap()[0].state, CallState::Reserved);
    d.usage.as_mut().unwrap().total_tokens = 14;
    let completed = log
        .finish(OP, 1, &d, StreamStatus::Completed, None)
        .unwrap();
    assert_eq!(completed.usage, d.usage);
    assert_eq!(completed.state, CallState::Completed);
    let json = serde_json::to_value(completed).unwrap();
    for excluded in [
        "prompt",
        "endpoint",
        "apiKey",
        "requestBody",
        "responseBody",
        "authorization",
    ] {
        assert!(json.get(excluded).is_none());
    }
    assert_eq!(log.list(0), Err(CallLogError::Invalid));
    assert_eq!(log.list(201), Err(CallLogError::Invalid));
    assert_eq!(
        log.reserve("bad", "call-log-world-0001", "main", "fixture-model", 4),
        Err(CallLogError::Invalid)
    );
}

#[test]
fn foreign_future_and_changed_schema_are_refused_without_mutating_the_database() {
    let dir = tempfile::tempdir().unwrap();
    for kind in ["foreign", "future", "changed"] {
        let path = dir.path().join(format!("{kind}.sqlite"));
        if kind != "foreign" {
            drop(CallLog::open(&path).unwrap());
        }
        let c = rusqlite::Connection::open(&path).unwrap();
        match kind {
            "foreign" => c.execute_batch("CREATE TABLE private_notes(value TEXT); INSERT INTO private_notes VALUES('preserve');"),
            "future" => c.execute_batch("PRAGMA user_version=900;"),
            _ => c.execute_batch("ALTER TABLE model_call_attempts ADD COLUMN untrusted TEXT;"),
        }.unwrap();
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        drop(c);
        let before = std::fs::read(&path).unwrap();
        assert_eq!(
            CallLog::open(&path).unwrap_err(),
            CallLogError::Incompatible
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}

#[test]
fn call_log_child_reserves_before_forced_termination() {
    let Some(directory) = std::env::var_os("LISHI_M06_CALL_LOG_CHILD") else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    let log = CallLog::open(directory.join("calls.sqlite")).unwrap();
    reserve(&log, OP).unwrap();
    std::fs::write(directory.join("reserved.marker"), b"durable").unwrap();
    loop {
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_real_killed_process_keeps_its_reserved_attempt_with_unknown_delivery() {
    let dir = tempfile::tempdir().unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "call_log_child_reserves_before_forced_termination",
            "--nocapture",
        ])
        .env("LISHI_M06_CALL_LOG_CHILD", dir.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while !dir.path().join("reserved.marker").is_file() && Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            panic!("fixture child exited before reserving");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let ready = dir.path().join("reserved.marker").is_file();
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(ready, "fixture child wrote its durable reservation");
    let log = CallLog::open(dir.path().join("calls.sqlite")).unwrap();
    let rows = log.operation(OP).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].state, CallState::Interrupted);
    assert_eq!(rows[0].actual_http_attempts, None);
    assert!(rows[0].sent_unknown);
    assert_eq!(reserve(&log, OP), Ok(2));
    assert_eq!(reserve(&log, OP), Err(CallLogError::BudgetExhausted));
}
