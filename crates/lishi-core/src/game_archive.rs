//! Explicit, read-only v1 history audit and consistent backup preparation.
//!
//! This module never opens a `GameStore`, recovers pending operations, migrates
//! a schema, or sends network requests. The owner lock and a read transaction
//! keep the selected source stable. History is visited one complete raw record
//! at a time; there is no recent-turn limit or vector of all state snapshots.

use std::{
    fmt,
    fs::{self, File, TryLockError},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use rusqlite::{
    backup::{Backup, StepResult},
    types::ValueRef,
    Connection, ErrorCode, OpenFlags, OptionalExtension, Row,
};
use sha2::{Digest, Sha256};

use crate::{
    game_protocol::{
        apply_output, parse_output, validate_setup, validate_state, Choice, WorldSetup, WorldState,
        MAX_CHOICES, MAX_NARRATIVE_BYTES, MAX_TURN_OUTPUT_BYTES,
    },
    game_store::{valid_game_id, GameActionKind, MAX_ACTION_BYTES, MAX_POLICY_BYTES},
};

const APPLICATION_ID: i32 = 0x4c495348;
const SCHEMA_VERSION: i32 = 1;
/// Per-state safety bound, not a history limit. Oversized records fail safely;
/// ordinary complete v1 states remain far below this limit.
pub const MAX_ARCHIVE_STATE_BYTES: usize = 256 * 1024 * 1024;
const BACKUP_PAGES_PER_STEP: i32 = 64;
const MAX_BACKUP_BUSY_STEPS: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameArchiveError {
    Unavailable,
    Busy,
    IncompatibleSchema,
    InvalidArchive,
    RecordTooLarge,
    DestinationExists,
    BackupFailed,
    Cancelled,
}

impl fmt::Display for GameArchiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "game_archive_unavailable",
            Self::Busy => "game_archive_busy",
            Self::IncompatibleSchema => "game_archive_incompatible_schema",
            Self::InvalidArchive => "game_archive_invalid",
            Self::RecordTooLarge => "game_archive_record_too_large",
            Self::DestinationExists => "game_archive_destination_exists",
            Self::BackupFailed => "game_archive_backup_failed",
            Self::Cancelled => "game_archive_cancelled",
        })
    }
}

impl std::error::Error for GameArchiveError {}

impl From<rusqlite::Error> for GameArchiveError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::SqliteFailure(detail, _)
                if matches!(
                    detail.code,
                    ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
                ) =>
            {
                Self::Busy
            }
            _ => Self::InvalidArchive,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyWorldHeader {
    pub world_id: String,
    pub setup_json: String,
    pub initial_state_json: String,
    pub current_state_json: String,
    pub opening_narrative: String,
    pub opening_choices_json: String,
    pub narrative_policy: String,
    pub head_turn_id: Option<String>,
    pub turn_count: u64,
    pub created_at_ms: i64,
}

/// Raw strings are exactly the stored UTF-8 text, including JSON whitespace.
/// A future adapter receives the whole committed record, not a reconstructed
/// `WorldView` that truncates old turns or drops the original model output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyTurn {
    pub turn_id: String,
    pub parent_turn_id: Option<String>,
    pub sequence: u64,
    pub action_kind: GameActionKind,
    pub action_text: String,
    pub narrative: String,
    pub choices_json: String,
    pub state_json: String,
    pub output_json: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyOperation {
    pub operation_id: String,
    pub expected_head_turn_id: Option<String>,
    pub action_kind: GameActionKind,
    pub action_text: String,
    pub status: String,
    pub error_code: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyArchiveAudit {
    pub header: LegacyWorldHeader,
    pub operation_count: u64,
    pub committed_operation_count: u64,
    pub uncommitted_operation_count: u64,
    /// Length-prefixed raw header, complete turn and operation records. This is
    /// an integrity fingerprint of game content, not a file checksum.
    pub content_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveControl {
    Continue,
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveBackupProgress {
    pub remaining_pages: i32,
    pub total_pages: i32,
}

pub struct LegacyGameArchive {
    connection: Connection,
    // Matches GameStore's existing .owner-lock convention. Never unlink locks.
    _owner_lock: File,
    audit: LegacyArchiveAudit,
}

impl fmt::Debug for LegacyGameArchive {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LegacyGameArchive { read_only: true }")
    }
}

impl LegacyGameArchive {
    /// Acquire exclusive application ownership, then audit a read-only
    /// snapshot. Active operations are refused, never silently interrupted.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, GameArchiveError> {
        let path = path.as_ref();
        if !path.is_file() {
            return Err(GameArchiveError::Unavailable);
        }
        let owner_lock = lock_owner(path)?;
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| GameArchiveError::Unavailable)?;
        connection.busy_timeout(Duration::from_millis(100))?;
        // Connection-local query_only and a deferred read transaction do not
        // change schema, world facts, operation state, or the source journal.
        connection.execute_batch("PRAGMA query_only=ON; BEGIN DEFERRED;")?;
        let audit = audit_connection(&connection)?;
        Ok(Self {
            connection,
            _owner_lock: owner_lock,
            audit,
        })
    }

    pub fn audit(&self) -> &LegacyArchiveAudit {
        &self.audit
    }

    /// Ordered complete history with bounded retained memory. `Stop` returns
    /// normally with the number visited; it does not mean a complete scan.
    pub fn visit_turns<F>(&self, mut visitor: F) -> Result<u64, GameArchiveError>
    where
        F: FnMut(&LegacyTurn) -> Result<ArchiveControl, GameArchiveError>,
    {
        let mut statement = self.connection.prepare(TURN_QUERY)?;
        let mut rows = statement.query([])?;
        let mut visited = 0;
        while let Some(row) = rows.next()? {
            let turn = read_turn(row)?;
            visited += 1;
            if visitor(&turn)? == ArchiveControl::Stop {
                break;
            }
        }
        Ok(visited)
    }

    /// Includes failed/cancelled/interrupted inputs, not only formal turns.
    pub fn visit_operations<F>(&self, mut visitor: F) -> Result<u64, GameArchiveError>
    where
        F: FnMut(&LegacyOperation) -> Result<ArchiveControl, GameArchiveError>,
    {
        let mut statement = self.connection.prepare(OPERATION_QUERY)?;
        let mut rows = statement.query([])?;
        let mut visited = 0;
        while let Some(row) = rows.next()? {
            let operation = read_operation(row)?;
            visited += 1;
            if visitor(&operation)? == ArchiveControl::Stop {
                break;
            }
        }
        Ok(visited)
    }

    pub fn backup_to_new(
        &self,
        destination: impl AsRef<Path>,
    ) -> Result<LegacyArchiveAudit, GameArchiveError> {
        self.backup_to_new_with_progress(destination, |_| Ok(ArchiveControl::Continue))
    }

    /// SQLite Online Backup includes committed WAL content. A callback may
    /// cancel or report local progress; it must not perform network work or
    /// recursively open either database. Busy retries are explicitly bounded.
    /// Failed or cancelled attempts remove only their newly reserved target;
    /// the original world and existing backups are never overwritten.
    pub fn backup_to_new_with_progress<F>(
        &self,
        destination: impl AsRef<Path>,
        mut progress: F,
    ) -> Result<LegacyArchiveAudit, GameArchiveError>
    where
        F: FnMut(ArchiveBackupProgress) -> Result<ArchiveControl, GameArchiveError>,
    {
        let mut owned = OwnedDestination::reserve(destination.as_ref())?;
        let mut target = Connection::open_with_flags(
            &owned.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| GameArchiveError::BackupFailed)?;
        target
            .busy_timeout(Duration::from_millis(100))
            .map_err(|_| GameArchiveError::BackupFailed)?;
        target
            .execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;")
            .map_err(|_| GameArchiveError::BackupFailed)?;
        {
            let backup = Backup::new(&self.connection, &mut target)
                .map_err(|_| GameArchiveError::BackupFailed)?;
            let mut busy_steps = 0;
            loop {
                let step = backup
                    .step(BACKUP_PAGES_PER_STEP)
                    .map_err(|_| GameArchiveError::BackupFailed)?;
                let current = backup.progress();
                if progress(ArchiveBackupProgress {
                    remaining_pages: current.remaining,
                    total_pages: current.pagecount,
                })? == ArchiveControl::Stop
                {
                    return Err(GameArchiveError::Cancelled);
                }
                match step {
                    StepResult::Done => break,
                    StepResult::More => {}
                    StepResult::Busy | StepResult::Locked => {
                        busy_steps += 1;
                        if busy_steps >= MAX_BACKUP_BUSY_STEPS {
                            return Err(GameArchiveError::Busy);
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    _ => return Err(GameArchiveError::BackupFailed),
                }
            }
        }
        // Ensure the resulting backup is self-contained. This only changes the
        // destination journal mode, never the source or its read transaction.
        target
            .execute_batch("PRAGMA journal_mode=DELETE;")
            .map_err(|_| GameArchiveError::BackupFailed)?;
        let copied = audit_connection(&target).map_err(|_| GameArchiveError::BackupFailed)?;
        if copied != self.audit {
            return Err(GameArchiveError::BackupFailed);
        }
        target.close().map_err(|_| GameArchiveError::BackupFailed)?;
        owned
            .reservation
            .sync_all()
            .map_err(|_| GameArchiveError::BackupFailed)?;
        owned.complete = true;
        Ok(copied)
    }
}

fn lock_owner(path: &Path) -> Result<File, GameArchiveError> {
    let mut name = path.as_os_str().to_os_string();
    name.push(".owner-lock");
    let lock = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(Path::new(&name))
        .map_err(|_| GameArchiveError::Unavailable)?;
    lock.try_lock().map_err(|error| match error {
        TryLockError::WouldBlock => GameArchiveError::Busy,
        TryLockError::Error(_) => GameArchiveError::Unavailable,
    })?;
    Ok(lock)
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    name.into()
}

struct OwnedDestination {
    path: PathBuf,
    reservation: File,
    _owner_lock: File,
    complete: bool,
}

impl OwnedDestination {
    fn reserve(path: &Path) -> Result<Self, GameArchiveError> {
        let owner_lock = lock_owner(path)?;
        // Refuse preexisting sidecars too. Cleanup must never remove somebody
        // else's journal, and a prior incomplete target is not ours to reuse.
        if ["-wal", "-shm", "-journal"]
            .iter()
            .any(|suffix| sidecar(path, suffix).exists())
        {
            return Err(GameArchiveError::DestinationExists);
        }
        let reservation = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    GameArchiveError::DestinationExists
                } else {
                    GameArchiveError::Unavailable
                }
            })?;
        Ok(Self {
            path: path.to_owned(),
            reservation,
            _owner_lock: owner_lock,
            complete: false,
        })
    }
}

impl Drop for OwnedDestination {
    fn drop(&mut self) {
        if !self.complete {
            // SQLite connection/backup handles drop first on every failure.
            // Files are newly created under the held target owner lock.
            let _ = fs::remove_file(&self.path);
            for suffix in ["-wal", "-shm", "-journal"] {
                let _ = fs::remove_file(sidecar(&self.path, suffix));
            }
        }
    }
}

fn text(row: &Row<'_>, index: usize, limit: usize) -> Result<String, GameArchiveError> {
    match row.get_ref(index)? {
        ValueRef::Text(bytes) if bytes.len() <= limit => std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| GameArchiveError::InvalidArchive),
        ValueRef::Text(_) => Err(GameArchiveError::RecordTooLarge),
        _ => Err(GameArchiveError::InvalidArchive),
    }
}

fn nullable_text(
    row: &Row<'_>,
    index: usize,
    limit: usize,
) -> Result<Option<String>, GameArchiveError> {
    if row.get_ref(index)? == ValueRef::Null {
        Ok(None)
    } else {
        text(row, index, limit).map(Some)
    }
}

fn action(value: &str) -> Result<GameActionKind, GameArchiveError> {
    match value {
        "action" => Ok(GameActionKind::Action),
        "continue" => Ok(GameActionKind::Continue),
        _ => Err(GameArchiveError::InvalidArchive),
    }
}

fn action_text_valid(kind: GameActionKind, value: &str) -> bool {
    value.len() <= MAX_ACTION_BYTES
        && (kind == GameActionKind::Continue || !value.trim().is_empty())
        && plain_text(value)
}

fn plain_text(value: &str) -> bool {
    !value
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
}

const TURN_QUERY: &str = "SELECT turn_id,parent_turn_id,sequence,action_kind,action_text,
    narrative,choices,state,output,created_at_ms FROM game_turns ORDER BY sequence";
const OPERATION_QUERY: &str = "SELECT operation_id,expected_head_turn_id,action_kind,action_text,
    status,error_code,created_at_ms FROM game_operations ORDER BY rowid";

fn read_turn(row: &Row<'_>) -> Result<LegacyTurn, GameArchiveError> {
    let sequence: i64 = row.get(2)?;
    Ok(LegacyTurn {
        turn_id: text(row, 0, 128)?,
        parent_turn_id: nullable_text(row, 1, 128)?,
        sequence: sequence
            .try_into()
            .map_err(|_| GameArchiveError::InvalidArchive)?,
        action_kind: action(&text(row, 3, 16)?)?,
        action_text: text(row, 4, MAX_ACTION_BYTES)?,
        narrative: text(row, 5, MAX_NARRATIVE_BYTES)?,
        choices_json: text(row, 6, 128 * 1024)?,
        state_json: text(row, 7, MAX_ARCHIVE_STATE_BYTES)?,
        output_json: text(row, 8, MAX_TURN_OUTPUT_BYTES)?,
        created_at_ms: row.get(9)?,
    })
}

fn read_operation(row: &Row<'_>) -> Result<LegacyOperation, GameArchiveError> {
    Ok(LegacyOperation {
        operation_id: text(row, 0, 128)?,
        expected_head_turn_id: nullable_text(row, 1, 128)?,
        action_kind: action(&text(row, 2, 16)?)?,
        action_text: text(row, 3, MAX_ACTION_BYTES)?,
        status: text(row, 4, 32)?,
        error_code: nullable_text(row, 5, 128)?,
        created_at_ms: row.get(6)?,
    })
}

fn header(connection: &Connection) -> Result<LegacyWorldHeader, GameArchiveError> {
    if connection.query_row("SELECT COUNT(*) FROM game_world", [], |row| {
        row.get::<_, i64>(0)
    })? != 1
    {
        return Err(GameArchiveError::InvalidArchive);
    }
    let mut query = connection.prepare(
        "SELECT world_id,setup,initial_state,current_state,opening_narrative,
         opening_choices,narrative_policy,head_turn_id,turn_count,created_at_ms
         FROM game_world WHERE id=1",
    )?;
    let mut rows = query.query([])?;
    let row = rows.next()?.ok_or(GameArchiveError::InvalidArchive)?;
    let count: i64 = row.get(8)?;
    Ok(LegacyWorldHeader {
        world_id: text(row, 0, 128)?,
        setup_json: text(row, 1, 32 * 1024)?,
        initial_state_json: text(row, 2, MAX_ARCHIVE_STATE_BYTES)?,
        current_state_json: text(row, 3, MAX_ARCHIVE_STATE_BYTES)?,
        opening_narrative: text(row, 4, MAX_NARRATIVE_BYTES)?,
        opening_choices_json: text(row, 5, 128 * 1024)?,
        narrative_policy: text(row, 6, MAX_POLICY_BYTES)?,
        head_turn_id: nullable_text(row, 7, 128)?,
        turn_count: count
            .try_into()
            .map_err(|_| GameArchiveError::InvalidArchive)?,
        created_at_ms: row.get(9)?,
    })
}

fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, GameArchiveError> {
    serde_json::from_str(value).map_err(|_| GameArchiveError::InvalidArchive)
}

fn audit_connection(connection: &Connection) -> Result<LegacyArchiveAudit, GameArchiveError> {
    let version: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let app: i32 = connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if version != SCHEMA_VERSION || app != APPLICATION_ID {
        return Err(GameArchiveError::IncompatibleSchema);
    }
    if connection.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))? != "ok"
        || connection
            .prepare("PRAGMA foreign_key_check")?
            .query([])?
            .next()?
            .is_some()
    {
        return Err(GameArchiveError::InvalidArchive);
    }
    immutable_triggers(connection)?;
    if connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM game_operations
         WHERE status IN ('pending','generating','validating'))",
        [],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(GameArchiveError::Busy);
    }
    if connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM game_operations WHERE candidate IS NOT NULL)",
        [],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(GameArchiveError::InvalidArchive);
    }
    let header = header(connection)?;
    let setup: WorldSetup = decode(&header.setup_json)?;
    validate_setup(&setup).map_err(|_| GameArchiveError::InvalidArchive)?;
    let mut previous: WorldState = decode(&header.initial_state_json)?;
    validate_state(&previous).map_err(|_| GameArchiveError::InvalidArchive)?;
    let current: WorldState = decode(&header.current_state_json)?;
    validate_state(&current).map_err(|_| GameArchiveError::InvalidArchive)?;
    let choices: Vec<Choice> = decode(&header.opening_choices_json)?;
    let mut ids = std::collections::BTreeSet::new();
    if !valid_game_id(&header.world_id)
        || setup.world_id != header.world_id
        || previous.time.era_year != setup.era_year
        || previous.time.elapsed_seconds != 0
        || header.created_at_ms < 0
        || header.opening_narrative.trim().is_empty()
        || !plain_text(&header.opening_narrative)
        || !plain_text(&header.narrative_policy)
        || choices.len() > MAX_CHOICES
        || choices.iter().any(|choice| {
            choice.id.is_empty()
                || choice.id.len() > 64
                || !choice
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                || choice.text.trim().is_empty()
                || choice.text.len() > 2048
                || !plain_text(&choice.text)
                || !ids.insert(&choice.id)
        })
    {
        return Err(GameArchiveError::InvalidArchive);
    }
    let mut hash = Sha256::new();
    hash.update(b"lishi-v1-archive-content\0");
    hash_header(&mut hash, &header);
    let mut expected_sequence = 1_u64;
    let mut previous_id = None;
    let mut turns = connection.prepare(TURN_QUERY)?;
    let mut rows = turns.query([])?;
    while let Some(row) = rows.next()? {
        let turn = read_turn(row)?;
        if turn.sequence != expected_sequence
            || turn.parent_turn_id != previous_id
            || !valid_game_id(&turn.turn_id)
            || !action_text_valid(turn.action_kind, &turn.action_text)
            || turn.created_at_ms < 0
        {
            return Err(GameArchiveError::InvalidArchive);
        }
        let output =
            parse_output(&turn.output_json).map_err(|_| GameArchiveError::InvalidArchive)?;
        let snapshot: WorldState = decode(&turn.state_json)?;
        let choices: Vec<Choice> = decode(&turn.choices_json)?;
        let next =
            apply_output(&previous, &output).map_err(|_| GameArchiveError::InvalidArchive)?;
        if next != snapshot || turn.narrative != output.narrative || choices != output.choices {
            return Err(GameArchiveError::InvalidArchive);
        }
        let matching_operation: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM game_operations
             WHERE operation_id=?1 AND expected_head_turn_id IS ?2 AND status='committed'
             AND action_kind=?3 AND action_text=?4 AND error_code IS NULL)",
            rusqlite::params![
                turn.turn_id,
                turn.parent_turn_id,
                action_name(turn.action_kind),
                turn.action_text
            ],
            |row| row.get(0),
        )?;
        if !matching_operation {
            return Err(GameArchiveError::InvalidArchive);
        }
        hash_turn(&mut hash, &turn);
        previous = snapshot;
        previous_id = Some(turn.turn_id);
        expected_sequence = expected_sequence
            .checked_add(1)
            .ok_or(GameArchiveError::InvalidArchive)?;
    }
    if expected_sequence - 1 != header.turn_count
        || previous_id != header.head_turn_id
        || previous != current
    {
        return Err(GameArchiveError::InvalidArchive);
    }
    let mut operation_count = 0_u64;
    let mut committed_count = 0_u64;
    let mut operations = connection.prepare(OPERATION_QUERY)?;
    let mut rows = operations.query([])?;
    while let Some(row) = rows.next()? {
        let operation = read_operation(row)?;
        if !valid_game_id(&operation.operation_id)
            || operation
                .expected_head_turn_id
                .as_deref()
                .is_some_and(|id| !valid_game_id(id))
            || !action_text_valid(operation.action_kind, &operation.action_text)
            || operation.created_at_ms < 0
            || !matches!(
                operation.status.as_str(),
                "committed" | "failed" | "cancelled" | "interrupted"
            )
        {
            return Err(GameArchiveError::InvalidArchive);
        }
        operation_count += 1;
        if operation.status == "committed" {
            committed_count += 1;
        }
        hash_operation(&mut hash, &operation);
    }
    if committed_count != header.turn_count {
        return Err(GameArchiveError::InvalidArchive);
    }
    Ok(LegacyArchiveAudit {
        header,
        operation_count,
        committed_operation_count: committed_count,
        uncommitted_operation_count: operation_count - committed_count,
        content_sha256: format!("{:x}", hash.finalize()),
    })
}

fn immutable_triggers(connection: &Connection) -> Result<(), GameArchiveError> {
    for (name, body) in [
        ("game_turns_no_update", "BEFORE UPDATE ON game_turns BEGIN SELECT RAISE(ABORT,'immutable turn'); END"),
        ("game_turns_no_delete", "BEFORE DELETE ON game_turns BEGIN SELECT RAISE(ABORT,'immutable turn'); END"),
        ("game_operation_input_no_update", "BEFORE UPDATE OF operation_id,expected_head_turn_id,action_kind,action_text,created_at_ms ON game_operations BEGIN SELECT RAISE(ABORT,'immutable input'); END"),
        ("game_operations_no_delete", "BEFORE DELETE ON game_operations BEGIN SELECT RAISE(ABORT,'immutable input'); END"),
        ("game_opening_no_update", "BEFORE UPDATE OF world_id,setup,initial_state,opening_narrative,opening_choices,created_at_ms ON game_world BEGIN SELECT RAISE(ABORT,'immutable opening'); END"),
        ("game_opening_no_delete", "BEFORE DELETE ON game_world BEGIN SELECT RAISE(ABORT,'immutable opening'); END"),
    ] {
        let actual: Option<String> = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?1", [name], |row| row.get(0),
        ).optional()?;
        let expected = format!("CREATE TRIGGER {name} {body}");
        let normalized = |value: &str| value.chars().filter(|ch| !ch.is_ascii_whitespace()).collect::<String>().to_ascii_lowercase();
        if actual.as_deref().map(normalized) != Some(normalized(&expected)) {
            return Err(GameArchiveError::InvalidArchive);
        }
    }
    Ok(())
}

fn hash_text(hash: &mut Sha256, value: &str) {
    hash.update((value.len() as u64).to_le_bytes());
    hash.update(value.as_bytes());
}

fn hash_nullable(hash: &mut Sha256, value: Option<&str>) {
    hash.update([u8::from(value.is_some())]);
    if let Some(value) = value {
        hash_text(hash, value);
    }
}

fn action_name(kind: GameActionKind) -> &'static str {
    match kind {
        GameActionKind::Action => "action",
        GameActionKind::Continue => "continue",
    }
}

fn hash_header(hash: &mut Sha256, header: &LegacyWorldHeader) {
    for field in [
        &header.world_id,
        &header.setup_json,
        &header.initial_state_json,
        &header.current_state_json,
        &header.opening_narrative,
        &header.opening_choices_json,
        &header.narrative_policy,
    ] {
        hash_text(hash, field);
    }
    hash_nullable(hash, header.head_turn_id.as_deref());
    hash.update(header.turn_count.to_le_bytes());
    hash.update(header.created_at_ms.to_le_bytes());
}

fn hash_turn(hash: &mut Sha256, turn: &LegacyTurn) {
    hash.update(b"turn\0");
    hash_text(hash, &turn.turn_id);
    hash_nullable(hash, turn.parent_turn_id.as_deref());
    hash.update(turn.sequence.to_le_bytes());
    for field in [
        action_name(turn.action_kind),
        &turn.action_text,
        &turn.narrative,
        &turn.choices_json,
        &turn.state_json,
        &turn.output_json,
    ] {
        hash_text(hash, field);
    }
    hash.update(turn.created_at_ms.to_le_bytes());
}

fn hash_operation(hash: &mut Sha256, operation: &LegacyOperation) {
    hash.update(b"operation\0");
    hash_text(hash, &operation.operation_id);
    hash_nullable(hash, operation.expected_head_turn_id.as_deref());
    for field in [
        action_name(operation.action_kind),
        &operation.action_text,
        &operation.status,
    ] {
        hash_text(hash, field);
    }
    hash_nullable(hash, operation.error_code.as_deref());
    hash.update(operation.created_at_ms.to_le_bytes());
}
