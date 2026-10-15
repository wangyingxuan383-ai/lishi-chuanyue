//! Optional local diagnostics, stored separately from authoritative game facts.
//! Accepts only the redacted compiler trace, never a prompt, credential, endpoint
//! or Provider configuration. The calling core still selects the legal scope.

use std::{
    collections::BTreeSet,
    fmt,
    fs::{File, TryLockError},
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{
    params, types::ValueRef, Connection, OpenFlags, OptionalExtension, TransactionBehavior,
};

use crate::{
    game_context::{ContextSectionKind, ContextSectionOutcome, ContextTrace},
    game_store_v2::valid_game_id,
};

const APPLICATION_ID: i32 = 0x4c435458;
const SCHEMA_VERSION: i32 = 1;
const MAX_TRACE_BYTES: usize = 2 * 1024 * 1024;
const MAX_TRACE_SECTIONS: usize = 2048;
const MAX_EXACT_INTEGER: usize = 9_007_199_254_740_991;
pub const MAX_CONTEXT_TRACES_PER_WORLD: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceLogError {
    Unavailable,
    Busy,
    IncompatibleDatabase,
    InvalidTrace,
    DuplicateConflict,
    UsageConflict,
    Missing,
    Capacity,
    Database,
    Clock,
}
impl fmt::Display for TraceLogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "context_log_unavailable",
            Self::Busy => "context_log_busy",
            Self::IncompatibleDatabase => "context_log_incompatible_database",
            Self::InvalidTrace => "context_log_invalid_trace",
            Self::DuplicateConflict => "context_log_duplicate_conflict",
            Self::UsageConflict => "context_log_usage_conflict",
            Self::Missing => "context_log_missing",
            Self::Capacity => "context_log_capacity",
            Self::Database => "context_log_database",
            Self::Clock => "context_log_clock",
        })
    }
}
impl std::error::Error for TraceLogError {}
impl From<rusqlite::Error> for TraceLogError {
    fn from(error: rusqlite::Error) -> Self {
        if matches!(error,rusqlite::Error::SqliteFailure(ref detail,_) if matches!(detail.code,rusqlite::ErrorCode::DatabaseBusy|rusqlite::ErrorCode::DatabaseLocked))
        {
            Self::Busy
        } else {
            Self::Database
        }
    }
}
pub type TraceLogResult<T> = Result<T, TraceLogError>;

pub struct TraceStore {
    connection: Mutex<Connection>,
    // Drop SQLite before releasing this independent diagnostic owner lock.
    _owner_lock: File,
}
impl fmt::Debug for TraceStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TraceStore { redacted_diagnostics: true }")
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn validate_trace(trace: &ContextTrace) -> TraceLogResult<()> {
    let limit = trace
        .budget
        .effective_input_limit_bytes()
        .map_err(|_| TraceLogError::InvalidTrace)?;
    if !valid_game_id(&trace.world_id)
        || !valid_id(&trace.branch_id)
        || !valid_game_id(&trace.operation_id)
        || trace
            .head_turn_id
            .as_ref()
            .is_some_and(|id| !valid_game_id(id))
        || trace.prompt_version == 0
        || trace.effective_input_limit_bytes != limit
        || trace.input_utf8_bytes == 0
        || trace.input_utf8_bytes > limit
        || trace.estimated_input_tokens != trace.input_utf8_bytes
        || trace.estimate_method != "conservative_utf8_byte_count_not_tokenizer_usage"
        || trace.actual_input_tokens.is_some()
        || !valid_hash(&trace.prompt_sha256)
        || trace.sections.len() > MAX_TRACE_SECTIONS
    {
        return Err(TraceLogError::InvalidTrace);
    }
    let mut required = BTreeSet::new();
    let mut optional_ids = BTreeSet::new();
    let mut required_bytes = 0usize;
    let mut included_bytes = 0usize;
    for section in &trace.sections {
        if !valid_hash(&section.sha256)
            || section.utf8_bytes == 0
            || section.utf8_bytes > 8 * 1024 * 1024
            || section.source_turn_count > 512
            || section.id.as_ref().is_some_and(|id| !valid_id(id))
        {
            return Err(TraceLogError::InvalidTrace);
        }
        let required_kind = match section.kind {
            ContextSectionKind::Rules => Some(0),
            ContextSectionKind::Setup => Some(1),
            ContextSectionKind::Policy => Some(2),
            ContextSectionKind::NarratorFacts => Some(3),
            ContextSectionKind::ActorFacts => Some(4),
            ContextSectionKind::CurrentAction => Some(5),
            _ => None,
        };
        if let Some(kind) = required_kind {
            if !section.required
                || section.id.is_some()
                || section.source_turn_count != 0
                || section.outcome != ContextSectionOutcome::Included
                || !required.insert(kind)
            {
                return Err(TraceLogError::InvalidTrace);
            }
            required_bytes = required_bytes
                .checked_add(section.utf8_bytes)
                .ok_or(TraceLogError::InvalidTrace)?;
        } else {
            let id = section.id.as_ref().ok_or(TraceLogError::InvalidTrace)?;
            if section.required
                || !optional_ids.insert(id)
                || (section.kind == ContextSectionKind::PinnedFact
                    && section.source_turn_count != 0)
                || (section.kind != ContextSectionKind::PinnedFact
                    && section.kind != ContextSectionKind::HistoricalEvidence
                    && section.source_turn_count == 0)
            {
                return Err(TraceLogError::InvalidTrace);
            }
        }
        if section.outcome == ContextSectionOutcome::Included {
            included_bytes = included_bytes
                .checked_add(section.utf8_bytes)
                .ok_or(TraceLogError::InvalidTrace)?;
        }
    }
    if required.len() != 6
        || required_bytes != trace.required_input_bytes
        || included_bytes != trace.input_utf8_bytes
    {
        return Err(TraceLogError::InvalidTrace);
    }
    Ok(())
}

fn validate_identity(connection: &Connection) -> TraceLogResult<()> {
    let application: i32 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    let version: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if application == APPLICATION_ID && version == SCHEMA_VERSION {
        return validate_schema(connection);
    }
    if application == 0
        && version == 0
        && !connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%')",
            [],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Ok(());
    }
    Err(TraceLogError::IncompatibleDatabase)
}

fn validate_schema(connection: &Connection) -> TraceLogResult<()> {
    let mut statement = connection.prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let expected = [
        ("trigger", "context_trace_immutable", TRIGGER_SCHEMA),
        ("index", "context_trace_world", INDEX_SCHEMA),
        ("table", "context_traces", TABLE_SCHEMA),
    ];
    let actual = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    if actual.len() != expected.len()
        || actual.iter().zip(expected).any(
            |((kind, name, sql), (expected_kind, expected_name, expected_sql))| {
                kind != expected_kind
                    || name != expected_name
                    || sql.trim_end_matches(';') != expected_sql.trim_end_matches(';')
            },
        )
    {
        return Err(TraceLogError::IncompatibleDatabase);
    }
    Ok(())
}

fn bounded_text(row: &rusqlite::Row<'_>, index: usize, max: usize) -> rusqlite::Result<String> {
    match row.get_ref(index)? {
        ValueRef::Text(bytes) if bytes.len() <= max => std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    index,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            }),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn bounded_optional_text(
    row: &rusqlite::Row<'_>,
    index: usize,
    max: usize,
) -> rusqlite::Result<Option<String>> {
    if row.get_ref(index)? == ValueRef::Null {
        Ok(None)
    } else {
        bounded_text(row, index, max).map(Some)
    }
}

struct StoredTrace {
    base: ContextTrace,
    actual_input_tokens: Option<usize>,
}
fn read_record(connection: &Connection, id: &str) -> TraceLogResult<Option<StoredTrace>> {
    let row=connection.query_row("SELECT world_id,branch_id,head_turn_id,trace_json,actual_input_tokens FROM context_traces WHERE operation_id=?1",[id],|row|Ok((bounded_text(row,0,128)?,bounded_text(row,1,128)?,bounded_optional_text(row,2,128)?,bounded_text(row,3,MAX_TRACE_BYTES)?,row.get::<_,Option<i64>>(4)?))).optional()?;
    row.map(|(world, branch, head, json, actual)| {
        let base: ContextTrace =
            serde_json::from_str(&json).map_err(|_| TraceLogError::Database)?;
        validate_trace(&base).map_err(|_| TraceLogError::Database)?;
        if base.operation_id != id
            || base.world_id != world
            || base.branch_id != branch
            || base.head_turn_id != head
        {
            return Err(TraceLogError::Database);
        }
        let actual_input_tokens = actual
            .map(|tokens| {
                usize::try_from(tokens)
                    .ok()
                    .filter(|tokens| *tokens <= MAX_EXACT_INTEGER)
                    .ok_or(TraceLogError::Database)
            })
            .transpose()?;
        Ok(StoredTrace {
            base,
            actual_input_tokens,
        })
    })
    .transpose()
}

impl TraceStore {
    /// Foreign/world database identities are checked read-only before locks,
    /// journal changes or schema creation. Existing diagnostic rows are kept.
    pub fn open_sidecar(path: impl AsRef<Path>) -> TraceLogResult<Self> {
        let path = path.as_ref();
        if path.exists() {
            let inspection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| TraceLogError::Unavailable)?;
            validate_identity(&inspection)?;
        }
        let mut lock_name = path.as_os_str().to_os_string();
        lock_name.push(".context-owner-lock");
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(Path::new(&lock_name))
            .map_err(|_| TraceLogError::Unavailable)?;
        lock.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => TraceLogError::Busy,
            TryLockError::Error(_) => TraceLogError::Unavailable,
        })?;
        let mut connection = Connection::open(path)?;
        validate_identity(&connection)?;
        let application: i32 =
            connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
        connection.busy_timeout(std::time::Duration::from_millis(500))?;
        connection.execute_batch("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;")?;
        if application == 0 {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            for schema in [TABLE_SCHEMA, INDEX_SCHEMA, TRIGGER_SCHEMA] {
                tx.execute_batch(schema)?;
            }
            tx.pragma_update(None, "application_id", APPLICATION_ID)?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            tx.commit()?;
        }
        validate_schema(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            _owner_lock: lock,
        })
    }
    fn connection(&self) -> TraceLogResult<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| TraceLogError::Unavailable)
    }
    /// The first compilation is immutable. An exact duplicate remains
    /// idempotent after actual usage has been recorded; conflicts are refused.
    pub fn record(&self, trace: &ContextTrace) -> TraceLogResult<()> {
        validate_trace(trace)?;
        let json = serde_json::to_string(trace).map_err(|_| TraceLogError::InvalidTrace)?;
        if json.len() > MAX_TRACE_BYTES {
            return Err(TraceLogError::InvalidTrace);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(stored) = read_record(&tx, &trace.operation_id)? {
            if stored.base != *trace {
                return Err(TraceLogError::DuplicateConflict);
            }
            tx.commit()?;
            return Ok(());
        }
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM context_traces WHERE world_id=?1",
            [&trace.world_id],
            |row| row.get(0),
        )?;
        if count < 0 {
            return Err(TraceLogError::Database);
        }
        if count as usize >= MAX_CONTEXT_TRACES_PER_WORLD {
            return Err(TraceLogError::Capacity);
        }
        let timestamp: i64 = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| TraceLogError::Clock)?
            .as_millis()
            .try_into()
            .map_err(|_| TraceLogError::Clock)?;
        tx.execute("INSERT INTO context_traces(operation_id,world_id,branch_id,head_turn_id,trace_json,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6)",params![trace.operation_id,trace.world_id,trace.branch_id,trace.head_turn_id,json,timestamp])?;
        tx.commit()?;
        Ok(())
    }
    /// Only actual HTTP usage belongs here. The API cannot prove its origin;
    /// the native caller passes the validated response's input-token count.
    /// Unknown never overwrites known, and known conflicting values are refused.
    pub fn record_actual_usage(
        &self,
        operation_id: &str,
        actual_input_tokens: Option<usize>,
    ) -> TraceLogResult<()> {
        if !valid_game_id(operation_id)
            || actual_input_tokens.is_some_and(|tokens| tokens > MAX_EXACT_INTEGER)
        {
            return Err(TraceLogError::InvalidTrace);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stored = read_record(&tx, operation_id)?.ok_or(TraceLogError::Missing)?;
        if let Some(actual) = actual_input_tokens {
            match stored.actual_input_tokens {
                Some(previous) if previous != actual => return Err(TraceLogError::UsageConflict),
                Some(_) => {}
                None => {
                    tx.execute("UPDATE context_traces SET actual_input_tokens=?1 WHERE operation_id=?2 AND actual_input_tokens IS NULL",params![actual as i64,operation_id])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn get(&self, operation_id: &str) -> TraceLogResult<Option<ContextTrace>> {
        if !valid_game_id(operation_id) {
            return Err(TraceLogError::InvalidTrace);
        }
        let connection = self.connection()?;
        Ok(read_record(&connection, operation_id)?.map(|mut stored| {
            stored.base.actual_input_tokens = stored.actual_input_tokens;
            stored.base
        }))
    }
    /// Explicit diagnostic cleanup only. Never invoked by opening a world,
    /// filling a log or exporting a save. Latest insertion order is retained.
    pub fn prune_world_branch(
        &self,
        world_id: &str,
        branch_id: &str,
        keep_latest: usize,
    ) -> TraceLogResult<usize> {
        if !valid_game_id(world_id)
            || !valid_id(branch_id)
            || keep_latest > MAX_CONTEXT_TRACES_PER_WORLD
        {
            return Err(TraceLogError::InvalidTrace);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let removed=tx.execute("DELETE FROM context_traces WHERE world_id=?1 AND branch_id=?2 AND sequence NOT IN (SELECT sequence FROM context_traces WHERE world_id=?1 AND branch_id=?2 ORDER BY sequence DESC LIMIT ?3)",params![world_id,branch_id,keep_latest as i64])?;
        tx.commit()?;
        Ok(removed)
    }
}

const TABLE_SCHEMA:&str="CREATE TABLE context_traces(sequence INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL UNIQUE,world_id TEXT NOT NULL,branch_id TEXT NOT NULL,head_turn_id TEXT,trace_json TEXT NOT NULL CHECK(json_valid(trace_json)),actual_input_tokens INTEGER CHECK(actual_input_tokens>=0 AND actual_input_tokens<=9007199254740991),created_at_ms INTEGER NOT NULL) STRICT;";
const INDEX_SCHEMA: &str =
    "CREATE INDEX context_trace_world ON context_traces(world_id,branch_id,sequence);";
const TRIGGER_SCHEMA:&str="CREATE TRIGGER context_trace_immutable BEFORE UPDATE OF sequence,operation_id,world_id,branch_id,head_turn_id,trace_json,created_at_ms ON context_traces BEGIN SELECT RAISE(ABORT,'immutable redacted trace');END;";
