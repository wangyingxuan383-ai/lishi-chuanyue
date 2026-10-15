//! Local model-call budget and redacted diagnostics, independent of world saves.
//! A reservation survives crashes; unknown delivery never becomes a claimed zero.
use crate::{
    game_store::valid_game_id,
    model_probe::ModelProbeDiagnostics,
    stream::{StreamErrorCode, StreamStatus, TokenUsage},
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::{
    fmt,
    fs::{File, TryLockError},
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

const APPLICATION_ID: i32 = 0x4c43414c;
const SCHEMA_VERSION: i32 = 1;
pub const MAX_MODEL_CALLS_PER_OPERATION: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallLogError {
    Unavailable,
    Busy,
    Incompatible,
    Invalid,
    BudgetExhausted,
    Conflict,
    Missing,
    Database,
    Clock,
}
impl fmt::Display for CallLogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "model_call_log_unavailable",
            Self::Busy => "model_call_log_busy",
            Self::Incompatible => "model_call_log_incompatible",
            Self::Invalid => "model_call_log_invalid",
            Self::BudgetExhausted => "model_call_budget_exhausted",
            Self::Conflict => "model_call_log_conflict",
            Self::Missing => "model_call_log_missing",
            Self::Database => "model_call_log_database",
            Self::Clock => "model_call_log_clock",
        })
    }
}
impl std::error::Error for CallLogError {}
impl From<rusqlite::Error> for CallLogError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Database
    }
}
pub type CallLogResult<T> = Result<T, CallLogError>;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CallState {
    Reserved,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}
impl CallState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallAttempt {
    pub operation_id: String,
    pub world_id: String,
    pub branch_id: String,
    pub model: String,
    pub prompt_version: u32,
    pub sequence: u8,
    pub state: CallState,
    /// None means the process cannot establish whether HTTP was attempted.
    pub actual_http_attempts: Option<u8>,
    pub sent_unknown: bool,
    pub http_status: Option<u16>,
    pub usage: Option<TokenUsage>,
    pub elapsed_ms: Option<u64>,
    pub error_code: Option<String>,
    pub created_at_ms: i64,
    pub finished_at_ms: Option<i64>,
}
pub struct CallLog {
    connection: Mutex<Connection>,
    // SQLite closes before releasing the sidecar's exclusive process owner.
    _owner_lock: File,
}
impl fmt::Debug for CallLog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("CallLog { redacted_model_attempts: true }")
    }
}
fn now_ms() -> CallLogResult<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|v| i64::try_from(v.as_millis()).ok())
        .ok_or(CallLogError::Clock)
}
fn valid_branch(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'-' | b'_'))
}
fn identity(c: &Connection) -> CallLogResult<bool> {
    let application: i32 = c.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i32 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let objects: Vec<(String, String, String)> = c
        .prepare(
            "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    if application == 0 && version == 0 && objects.is_empty() {
        return Ok(false);
    }
    if application != APPLICATION_ID
        || version != SCHEMA_VERSION
        || objects.len() != 1
        || objects[0].0 != "table"
        || objects[0].1 != "model_call_attempts"
        || objects[0].2.trim().trim_end_matches(';') != SCHEMA.trim().trim_end_matches(';')
    {
        return Err(CallLogError::Incompatible);
    }
    Ok(true)
}
fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CallAttempt> {
    let uint = |index| -> rusqlite::Result<Option<u64>> {
        row.get::<_, Option<i64>>(index)?
            .map(|v| u64::try_from(v).map_err(|_| rusqlite::Error::InvalidQuery))
            .transpose()
    };
    let state: String = row.get(6)?;
    let state = match state.as_str() {
        "reserved" => CallState::Reserved,
        "completed" => CallState::Completed,
        "failed" => CallState::Failed,
        "cancelled" => CallState::Cancelled,
        "interrupted" => CallState::Interrupted,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    let input = uint(10)?;
    let output = uint(11)?;
    let total = uint(12)?;
    let usage = match (input, output, total) {
        (Some(prompt_tokens), Some(completion_tokens), Some(total_tokens)) => Some(TokenUsage {
            prompt_tokens,
            completion_tokens,
            total_tokens,
        }),
        (None, None, None) => None,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(CallAttempt {
        operation_id: row.get(0)?,
        world_id: row.get(1)?,
        branch_id: row.get(2)?,
        model: row.get(3)?,
        prompt_version: row.get(4)?,
        sequence: row.get(5)?,
        state,
        actual_http_attempts: row.get(7)?,
        sent_unknown: row.get(8)?,
        http_status: row.get(9)?,
        usage,
        elapsed_ms: uint(13)?,
        error_code: row.get(14)?,
        created_at_ms: row.get(15)?,
        finished_at_ms: row.get(16)?,
    })
}
const SELECT: &str = "SELECT operation_id,world_id,branch_id,model,prompt_version,sequence,state,actual_http_attempts,sent_unknown,http_status,input_tokens,output_tokens,total_tokens,elapsed_ms,error_code,created_at_ms,finished_at_ms FROM model_call_attempts";
impl CallLog {
    pub fn open(path: impl AsRef<Path>) -> CallLogResult<Self> {
        let path = path.as_ref();
        // Refuse foreign/future databases before opening them for mutation.
        if path.exists() {
            let read = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| CallLogError::Unavailable)?;
            identity(&read)?;
        }
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".model-call-owner-lock");
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(Path::new(&lock_path))
            .map_err(|_| CallLogError::Unavailable)?;
        lock.try_lock().map_err(|e| match e {
            TryLockError::WouldBlock => CallLogError::Busy,
            TryLockError::Error(_) => CallLogError::Unavailable,
        })?;
        let mut c = Connection::open(path)?;
        let existing = identity(&c)?;
        c.busy_timeout(std::time::Duration::from_millis(200))?;
        c.execute_batch("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;")?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if !existing {
            tx.execute_batch(SCHEMA)?;
            tx.pragma_update(None, "application_id", APPLICATION_ID)?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        tx.execute("UPDATE model_call_attempts SET state='interrupted',error_code='process_interrupted',finished_at_ms=max(created_at_ms,?1) WHERE state='reserved'", [now_ms()?])?;
        tx.commit()?;
        Ok(Self {
            connection: Mutex::new(c),
            _owner_lock: lock,
        })
    }
    fn connection(&self) -> CallLogResult<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| CallLogError::Unavailable)
    }
    pub fn reserve(
        &self,
        operation_id: &str,
        world_id: &str,
        branch_id: &str,
        model: &str,
        prompt_version: u32,
    ) -> CallLogResult<u8> {
        if !valid_game_id(operation_id)
            || !valid_game_id(world_id)
            || !valid_branch(branch_id)
            || !(1..=256).contains(&model.len())
            || model.chars().any(|c| c.is_whitespace() || c.is_control())
            || prompt_version == 0
        {
            return Err(CallLogError::Invalid);
        }
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior:Option<(String,String,String,u32,u8)> = tx.query_row("SELECT world_id,branch_id,model,prompt_version,sequence FROM model_call_attempts WHERE operation_id=?1 ORDER BY sequence DESC LIMIT 1",[operation_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
        let sequence = match prior {
            Some((world, branch, saved_model, version, sequence)) => {
                if world != world_id
                    || branch != branch_id
                    || saved_model != model
                    || version != prompt_version
                {
                    return Err(CallLogError::Conflict);
                }
                if sequence >= MAX_MODEL_CALLS_PER_OPERATION {
                    return Err(CallLogError::BudgetExhausted);
                }
                sequence + 1
            }
            None => 1,
        };
        tx.execute("INSERT INTO model_call_attempts(operation_id,world_id,branch_id,model,prompt_version,sequence,state,sent_unknown,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,'reserved',1,?7)",params![operation_id,world_id,branch_id,model,prompt_version,sequence,now_ms()?])?;
        tx.commit()?;
        Ok(sequence)
    }
    pub fn finish(
        &self,
        operation_id: &str,
        sequence: u8,
        diagnostics: &ModelProbeDiagnostics,
        status: StreamStatus,
        error_code: Option<StreamErrorCode>,
    ) -> CallLogResult<CallAttempt> {
        if diagnostics.attempts > 1
            || diagnostics.elapsed_ms > i64::MAX as u64
            || (diagnostics.attempts == 0
                && (diagnostics.http_status.is_some() || diagnostics.usage.is_some()))
            || (status == StreamStatus::Completed
                && (error_code.is_some() || diagnostics.attempts != 1))
            || diagnostics
                .http_status
                .is_some_and(|v| !(100..=599).contains(&v))
            || diagnostics.usage.as_ref().is_some_and(|u| {
                u.total_tokens > 9_007_199_254_740_991
                    || u.prompt_tokens.checked_add(u.completion_tokens) != Some(u.total_tokens)
            })
        {
            return Err(CallLogError::Invalid);
        }
        let state = match status {
            StreamStatus::Completed => CallState::Completed,
            StreamStatus::Failed => CallState::Failed,
            StreamStatus::Cancelled => CallState::Cancelled,
        };
        let error = error_code
            .map(|e| {
                serde_json::to_value(e)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .ok_or(CallLogError::Invalid)
            })
            .transpose()?;
        let mut c = self.connection()?;
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior = tx
            .query_row(
                &format!("{SELECT} WHERE operation_id=?1 AND sequence=?2"),
                params![operation_id, sequence],
                read_row,
            )
            .optional()?
            .ok_or(CallLogError::Missing)?;
        if prior.state != CallState::Reserved {
            if prior.state == state
                && prior.actual_http_attempts == Some(diagnostics.attempts)
                && prior.http_status == diagnostics.http_status
                && prior.usage == diagnostics.usage
                && prior.elapsed_ms == Some(diagnostics.elapsed_ms)
                && prior.error_code == error
            {
                return Ok(prior);
            }
            return Err(CallLogError::Conflict);
        }
        let usage = diagnostics.usage.as_ref();
        // Validation above bounds these unsigned values to exact signed integers.
        tx.execute("UPDATE model_call_attempts SET state=?3,actual_http_attempts=?4,sent_unknown=0,http_status=?5,input_tokens=?6,output_tokens=?7,total_tokens=?8,elapsed_ms=?9,error_code=?10,finished_at_ms=max(created_at_ms,?11) WHERE operation_id=?1 AND sequence=?2",params![operation_id,sequence,state.as_str(),diagnostics.attempts,diagnostics.http_status,usage.map(|u|u.prompt_tokens as i64),usage.map(|u|u.completion_tokens as i64),usage.map(|u|u.total_tokens as i64),diagnostics.elapsed_ms as i64,error,now_ms()?])?;
        let attempt = tx.query_row(
            &format!("{SELECT} WHERE operation_id=?1 AND sequence=?2"),
            params![operation_id, sequence],
            read_row,
        )?;
        tx.commit()?;
        Ok(attempt)
    }
    pub fn operation(&self, operation_id: &str) -> CallLogResult<Vec<CallAttempt>> {
        if !valid_game_id(operation_id) {
            return Err(CallLogError::Invalid);
        }
        let c = self.connection()?;
        let mut s = c.prepare(&format!("{SELECT} WHERE operation_id=?1 ORDER BY sequence"))?;
        let rows = s
            .query_map([operation_id], read_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn list(&self, limit: usize) -> CallLogResult<Vec<CallAttempt>> {
        if !(1..=200).contains(&limit) {
            return Err(CallLogError::Invalid);
        }
        let c = self.connection()?;
        let mut s = c.prepare(&format!(
            "{SELECT} ORDER BY created_at_ms DESC,operation_id,sequence DESC LIMIT ?1"
        ))?;
        let rows = s
            .query_map([limit as i64], read_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}
const SCHEMA: &str = "CREATE TABLE model_call_attempts (
 operation_id TEXT NOT NULL, world_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 model TEXT NOT NULL, prompt_version INTEGER NOT NULL CHECK(prompt_version>0),
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 2),
 state TEXT NOT NULL CHECK(state IN ('reserved','completed','failed','cancelled','interrupted')),
 actual_http_attempts INTEGER CHECK(actual_http_attempts BETWEEN 0 AND 1),
 sent_unknown INTEGER NOT NULL CHECK(sent_unknown IN (0,1)),
 http_status INTEGER CHECK(http_status BETWEEN 100 AND 599),
 input_tokens INTEGER CHECK(input_tokens>=0), output_tokens INTEGER CHECK(output_tokens>=0), total_tokens INTEGER CHECK(total_tokens>=0),
 elapsed_ms INTEGER CHECK(elapsed_ms>=0), error_code TEXT,
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0), finished_at_ms INTEGER,
 PRIMARY KEY(operation_id,sequence),
 CHECK((sent_unknown=1 AND actual_http_attempts IS NULL AND state IN ('reserved','interrupted')) OR (sent_unknown=0 AND actual_http_attempts IS NOT NULL AND state IN ('completed','failed','cancelled'))),
 CHECK((state='reserved' AND finished_at_ms IS NULL) OR (state<>'reserved' AND finished_at_ms>=created_at_ms)),
 CHECK((input_tokens IS NULL AND output_tokens IS NULL AND total_tokens IS NULL) OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND total_tokens=input_tokens+output_tokens))
) STRICT;";
