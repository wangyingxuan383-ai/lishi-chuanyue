//! Durable interruption/atomic-commit probe, separate from game or note storage.
//! Network requests never run inside a database transaction. A candidate is
//! explicitly provisional until snapshot, committed record and operation status
//! commit together. Opening the probe recovers unfinished operations without
//! retrying any network request.

use std::{
    fmt,
    fs::{File, TryLockError},
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

pub const MAX_RECOVERY_TEXT_BYTES: usize = 256 * 1024;

type RawCommitCandidate = (Option<String>, String, Option<String>);
type RawOperation = (String, Option<String>, String, Option<String>, i64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryError {
    Database,
    Unavailable,
    InvalidId,
    InvalidText,
    InvalidErrorCode,
    Busy,
    Duplicate,
    StaleHead,
    InvalidTransition,
    Cancelled,
    RevisionOverflow,
    Clock,
}

impl fmt::Display for RecoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Database => "recovery_database",
            Self::Unavailable => "recovery_unavailable",
            Self::InvalidId => "recovery_invalid_id",
            Self::InvalidText => "recovery_invalid_text",
            Self::InvalidErrorCode => "recovery_invalid_error_code",
            Self::Busy => "recovery_busy",
            Self::Duplicate => "recovery_duplicate",
            Self::StaleHead => "recovery_stale_head",
            Self::InvalidTransition => "recovery_invalid_transition",
            Self::Cancelled => "recovery_cancelled",
            Self::RevisionOverflow => "recovery_revision_overflow",
            Self::Clock => "recovery_clock",
        })
    }
}

impl std::error::Error for RecoveryError {}

impl From<rusqlite::Error> for RecoveryError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Database
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStatus {
    Pending,
    Generating,
    Validating,
    Committed,
    Failed,
    Cancelled,
    Interrupted,
}

impl RecoveryStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Generating => "generating",
            Self::Validating => "validating",
            Self::Committed => "committed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    fn parse(value: &str) -> Result<Self, RecoveryError> {
        Ok(match value {
            "pending" => Self::Pending,
            "generating" => Self::Generating,
            "validating" => Self::Validating,
            "committed" => Self::Committed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "interrupted" => Self::Interrupted,
            _ => return Err(RecoveryError::Database),
        })
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Generating | Self::Validating)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshot {
    pub operation_id: Option<String>,
    pub text: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryOperation {
    pub operation_id: String,
    pub expected_head_operation_id: Option<String>,
    pub status: RecoveryStatus,
    pub error_code: Option<String>,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryView {
    pub snapshot: RecoverySnapshot,
    pub latest_operation: Option<RecoveryOperation>,
    pub active_operation_id: Option<String>,
}

pub struct RecoveryStore {
    connection: Mutex<Connection>,
    // Keep the process lock alive until after SQLite closes. OS teardown also
    // releases it after a strong kill. Never delete/replace the lock file.
    _owner_lock: File,
}

pub fn valid_recovery_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn now_ms() -> Result<i64, RecoveryError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| RecoveryError::Clock)?
        .as_millis()
        .try_into()
        .map_err(|_| RecoveryError::Clock)
}

impl RecoveryStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, RecoveryError> {
        let path = path.as_ref();
        let mut lock_name = path.as_os_str().to_os_string();
        lock_name.push(".owner-lock");
        let owner_lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(Path::new(&lock_name))
            .map_err(|_| RecoveryError::Unavailable)?;
        owner_lock.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => RecoveryError::Busy,
            TryLockError::Error(_) => RecoveryError::Unavailable,
        })?;
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS recovery_snapshot (
               id INTEGER PRIMARY KEY CHECK(id=1), operation_id TEXT,
               text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<=262144),
               revision INTEGER NOT NULL CHECK(revision>=0),
               CHECK((revision=0 AND operation_id IS NULL AND text='') OR
                     (revision>0 AND operation_id IS NOT NULL))
             ) STRICT;
             INSERT OR IGNORE INTO recovery_snapshot VALUES (1,NULL,'',0);
             CREATE TABLE IF NOT EXISTS recovery_operations (
               operation_id TEXT PRIMARY KEY,
               expected_head_operation_id TEXT,
               action TEXT NOT NULL CHECK(action='m01_stream_recovery_probe'),
               status TEXT NOT NULL CHECK(status IN
                 ('pending','generating','validating','committed','failed','cancelled','interrupted')),
               candidate TEXT CHECK(candidate IS NULL OR length(CAST(candidate AS BLOB))<=262144),
               error_code TEXT,
               updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>=0)
             ) STRICT;
             CREATE UNIQUE INDEX IF NOT EXISTS recovery_one_active
               ON recovery_operations((1)) WHERE status IN ('pending','generating','validating');
             CREATE TABLE IF NOT EXISTS recovery_committed (
               operation_id TEXT PRIMARY KEY REFERENCES recovery_operations(operation_id),
               revision INTEGER NOT NULL UNIQUE CHECK(revision>0),
               text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 262144)
             ) STRICT;"
        )?;
        // Recovery runs only while holding the process owner lock. A second
        // probe host returns Busy without scanning another live host's request.
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "UPDATE recovery_operations SET status='interrupted', candidate=NULL,
             error_code='process_interrupted', updated_at_ms=?1
             WHERE status IN ('pending','generating','validating')",
            [now_ms()?],
        )?;
        transaction.commit()?;
        Ok(Self {
            connection: Mutex::new(connection),
            _owner_lock: owner_lock,
        })
    }

    pub fn begin(
        &self,
        operation_id: &str,
        expected_head: Option<&str>,
    ) -> Result<(), RecoveryError> {
        if !valid_recovery_id(operation_id)
            || expected_head.is_some_and(|id| !valid_recovery_id(id))
        {
            return Err(RecoveryError::InvalidId);
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| RecoveryError::Unavailable)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM recovery_operations WHERE operation_id=?1)",
            [operation_id],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(RecoveryError::Duplicate);
        }
        if transaction.query_row("SELECT EXISTS(SELECT 1 FROM recovery_operations WHERE status IN ('pending','generating','validating'))", [], |row| row.get::<_, bool>(0))? {
            return Err(RecoveryError::Busy);
        }
        let current_head: Option<String> = transaction.query_row(
            "SELECT operation_id FROM recovery_snapshot WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        if current_head.as_deref() != expected_head {
            return Err(RecoveryError::StaleHead);
        }
        transaction.execute("INSERT INTO recovery_operations(operation_id,expected_head_operation_id,action,status,candidate,error_code,updated_at_ms) VALUES(?1,?2,'m01_stream_recovery_probe','pending',NULL,NULL,?3)", params![operation_id, expected_head, now_ms()?])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn mark_generating(&self, operation_id: &str) -> Result<(), RecoveryError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| RecoveryError::Unavailable)?;
        let changed = connection.execute("UPDATE recovery_operations SET status='generating',updated_at_ms=?2 WHERE operation_id=?1 AND status='pending'", params![operation_id, now_ms()?])?;
        if changed != 1 {
            return Err(RecoveryError::InvalidTransition);
        }
        Ok(())
    }

    pub fn stage_validation(&self, operation_id: &str, text: &str) -> Result<(), RecoveryError> {
        if text.is_empty() || text.len() > MAX_RECOVERY_TEXT_BYTES {
            return Err(RecoveryError::InvalidText);
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| RecoveryError::Unavailable)?;
        let changed = connection.execute("UPDATE recovery_operations SET status='validating',candidate=?2,updated_at_ms=?3 WHERE operation_id=?1 AND status='generating'", params![operation_id, text, now_ms()?])?;
        if changed != 1 {
            return Err(RecoveryError::InvalidTransition);
        }
        Ok(())
    }

    pub fn finish_uncommitted(
        &self,
        operation_id: &str,
        status: RecoveryStatus,
        error_code: Option<&str>,
    ) -> Result<(), RecoveryError> {
        if !matches!(
            status,
            RecoveryStatus::Failed | RecoveryStatus::Cancelled | RecoveryStatus::Interrupted
        ) {
            return Err(RecoveryError::InvalidTransition);
        }
        if error_code.is_some_and(|code| {
            code.is_empty()
                || code.len() > 64
                || !code
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }) {
            return Err(RecoveryError::InvalidErrorCode);
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| RecoveryError::Unavailable)?;
        let changed = connection.execute("UPDATE recovery_operations SET status=?2,candidate=NULL,error_code=?3,updated_at_ms=?4 WHERE operation_id=?1 AND status IN ('pending','generating','validating')", params![operation_id, status.as_str(), error_code, now_ms()?])?;
        if changed != 1 {
            return Err(RecoveryError::InvalidTransition);
        }
        Ok(())
    }

    pub fn commit(&self, operation_id: &str) -> Result<(), RecoveryError> {
        self.commit_with_hook(operation_id, || Ok(()))
    }

    /// The technical crash probe uses the hook to signal an exact pre-COMMIT
    /// boundary. A hook error rolls back every write. Normal callers use commit.
    /// The hook cannot run SQL or modify a stored candidate through this API.
    pub fn commit_with_hook<F: FnOnce() -> Result<(), RecoveryError>>(
        &self,
        operation_id: &str,
        before_commit: F,
    ) -> Result<(), RecoveryError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| RecoveryError::Unavailable)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation: Option<RawCommitCandidate> = transaction.query_row("SELECT expected_head_operation_id,status,candidate FROM recovery_operations WHERE operation_id=?1", [operation_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        let Some((expected_head, status, candidate)) = operation else {
            return Err(RecoveryError::InvalidTransition);
        };
        if status != "validating" {
            return Err(RecoveryError::InvalidTransition);
        }
        let candidate = candidate.ok_or(RecoveryError::InvalidTransition)?;
        if candidate.is_empty() || candidate.len() > MAX_RECOVERY_TEXT_BYTES {
            return Err(RecoveryError::InvalidText);
        }
        let (head, revision): (Option<String>, i64) = transaction.query_row(
            "SELECT operation_id,revision FROM recovery_snapshot WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if head != expected_head {
            return Err(RecoveryError::StaleHead);
        }
        let next_revision = revision
            .checked_add(1)
            .ok_or(RecoveryError::RevisionOverflow)?;
        transaction.execute(
            "UPDATE recovery_snapshot SET operation_id=?1,text=?2,revision=?3 WHERE id=1",
            params![operation_id, candidate, next_revision],
        )?;
        transaction.execute(
            "INSERT INTO recovery_committed(operation_id,revision,text) VALUES(?1,?2,?3)",
            params![operation_id, next_revision, candidate],
        )?;
        transaction.execute("UPDATE recovery_operations SET status='committed',candidate=NULL,error_code=NULL,updated_at_ms=?2 WHERE operation_id=?1 AND status='validating'", params![operation_id, now_ms()?])?;
        before_commit()?;
        transaction.commit()?;
        Ok(())
    }

    pub fn view(&self) -> Result<RecoveryView, RecoveryError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| RecoveryError::Unavailable)?;
        let transaction = connection.transaction()?;
        let snapshot = transaction.query_row(
            "SELECT operation_id,text,revision FROM recovery_snapshot WHERE id=1",
            [],
            |row| {
                Ok(RecoverySnapshot {
                    operation_id: row.get(0)?,
                    text: row.get(1)?,
                    revision: row.get(2)?,
                })
            },
        )?;
        let operation: Option<RawOperation> = transaction.query_row("SELECT operation_id,expected_head_operation_id,status,error_code,updated_at_ms FROM recovery_operations ORDER BY rowid DESC LIMIT 1", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).optional()?;
        let latest_operation =
            operation
                .map(
                    |(
                        operation_id,
                        expected_head_operation_id,
                        status,
                        error_code,
                        updated_at_ms,
                    )|
                     -> Result<RecoveryOperation, RecoveryError> {
                        Ok(RecoveryOperation {
                            operation_id,
                            expected_head_operation_id,
                            status: RecoveryStatus::parse(&status)?,
                            error_code,
                            updated_at_ms,
                        })
                    },
                )
                .transpose()?;
        let active_operation_id = transaction.query_row("SELECT operation_id FROM recovery_operations WHERE status IN ('pending','generating','validating')", [], |row| row.get(0)).optional()?;
        transaction.commit()?;
        Ok(RecoveryView {
            snapshot,
            latest_operation,
            active_operation_id,
        })
    }
}
