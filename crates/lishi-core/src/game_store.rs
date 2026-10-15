//! Formal single-world persistence, independent of the M01 technical probes.
//! Requests persist before HTTP starts; only validated output reaches immutable
//! turn snapshots. No network, platform keys, endpoint configuration, or raw
//! provider diagnostics belong in this store.

use std::{
    fmt,
    fs::{File, TryLockError},
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::game_protocol::{
    apply_output, parse_output, validate_setup, validate_state, Choice, TurnOutput, WorldSetup,
    WorldState, MAX_CHOICES, MAX_NARRATIVE_BYTES,
};

pub const GAME_SCHEMA_VERSION: i32 = 1;
pub const MAX_ACTION_BYTES: usize = 16 * 1024;
pub const MAX_POLICY_BYTES: usize = 8 * 1024;
pub const MAX_CANDIDATE_BYTES: usize = 256 * 1024;
pub const RECENT_TURN_LIMIT: usize = 100;
const APPLICATION_ID: i32 = 0x4c495348;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameStoreError {
    Database,
    Unavailable,
    Busy,
    Duplicate,
    StaleHead,
    InvalidRequest,
    InvalidOutput,
    InvalidTransition,
    InvalidErrorCode,
    NotFound,
    AlreadyCreated,
    IncompatibleSchema,
    Cancelled,
    RevisionOverflow,
    Clock,
}

impl fmt::Display for GameStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Database => "game_database",
            Self::Unavailable => "game_unavailable",
            Self::Busy => "game_busy",
            Self::Duplicate => "game_duplicate",
            Self::StaleHead => "game_stale_head",
            Self::InvalidRequest => "game_invalid_request",
            Self::InvalidOutput => "game_invalid_output",
            Self::InvalidTransition => "game_invalid_transition",
            Self::InvalidErrorCode => "game_invalid_error_code",
            Self::NotFound => "game_not_found",
            Self::AlreadyCreated => "game_already_created",
            Self::IncompatibleSchema => "game_incompatible_schema",
            Self::Cancelled => "game_cancelled",
            Self::RevisionOverflow => "game_revision_overflow",
            Self::Clock => "game_clock",
        })
    }
}

impl std::error::Error for GameStoreError {}

impl From<rusqlite::Error> for GameStoreError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Database
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GameActionKind {
    Action,
    Continue,
}

impl GameActionKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Action => "action",
            Self::Continue => "continue",
        }
    }

    fn parse(value: &str) -> Result<Self, GameStoreError> {
        match value {
            "action" => Ok(Self::Action),
            "continue" => Ok(Self::Continue),
            _ => Err(GameStoreError::Database),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameTurnRequest {
    pub operation_id: String,
    pub world_id: String,
    pub branch_id: String,
    #[serde(deserialize_with = "required_nullable")]
    pub expected_head_turn_id: Option<String>,
    pub action_kind: GameActionKind,
    pub action_text: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GameOperationStatus {
    Pending,
    Generating,
    Validating,
    Committed,
    Failed,
    Cancelled,
    Interrupted,
}

impl GameOperationStatus {
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

    fn parse(value: &str) -> Result<Self, GameStoreError> {
        match value {
            "pending" => Ok(Self::Pending),
            "generating" => Ok(Self::Generating),
            "validating" => Ok(Self::Validating),
            "committed" => Ok(Self::Committed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(GameStoreError::Database),
        }
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Generating | Self::Validating)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameOperation {
    pub operation_id: String,
    pub expected_head_turn_id: Option<String>,
    pub action_kind: GameActionKind,
    pub action_text: String,
    pub status: GameOperationStatus,
    pub error_code: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommittedTurn {
    pub turn_id: String,
    pub parent_turn_id: Option<String>,
    pub action_kind: GameActionKind,
    pub action_text: String,
    pub narrative: String,
    pub choices: Vec<Choice>,
    pub state: WorldState,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorldView {
    pub setup: WorldSetup,
    pub branch_id: String,
    pub head_turn_id: Option<String>,
    pub turn_count: u64,
    pub state: WorldState,
    pub opening_narrative: String,
    pub opening_choices: Vec<Choice>,
    pub narrative_policy: String,
    pub turns: Vec<CommittedTurn>,
    pub latest_operation: Option<GameOperation>,
}

pub struct GameStore {
    connection: Mutex<Connection>,
    // Close SQLite before releasing the lock. Strong process termination also
    // releases it; the lock file itself must never be removed or replaced.
    _owner_lock: File,
}

pub fn valid_game_id(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn now_ms() -> Result<i64, GameStoreError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| GameStoreError::Clock)?
        .as_millis()
        .try_into()
        .map_err(|_| GameStoreError::Clock)
}

fn json<T: Serialize>(value: &T) -> Result<String, GameStoreError> {
    serde_json::to_string(value).map_err(|_| GameStoreError::InvalidOutput)
}

fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, GameStoreError> {
    serde_json::from_str(value).map_err(|_| GameStoreError::Database)
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn valid_text(text: &str, limit: usize, allow_empty: bool) -> bool {
    text.len() <= limit
        && (allow_empty || !text.trim().is_empty())
        && !text
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

impl GameStore {
    pub fn snapshot_to(&self, target: &std::path::Path) -> Result<(), GameStoreError> {
        let db = self.connection()?;
        view_connection(&db)?;
        if db.query_row("SELECT EXISTS(SELECT 1 FROM game_operations WHERE status IN ('pending','generating','validating'))",[],|r|r.get::<_,bool>(0))? {return Err(GameStoreError::Busy);}
        crate::game_backup::snapshot(&db, target)
    }
    pub fn open(path: impl AsRef<Path>) -> Result<Self, GameStoreError> {
        let path = path.as_ref();
        let mut lock_name = path.as_os_str().to_os_string();
        lock_name.push(".owner-lock");
        let owner_lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(Path::new(&lock_name))
            .map_err(|_| GameStoreError::Unavailable)?;
        owner_lock.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => GameStoreError::Busy,
            TryLockError::Error(_) => GameStoreError::Unavailable,
        })?;
        let mut connection = Connection::open(path)?;
        let version: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        let application: i32 =
            connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
        if !(0..=GAME_SCHEMA_VERSION).contains(&version)
            || (version != 0 && application != APPLICATION_ID)
        {
            return Err(GameStoreError::IncompatibleSchema);
        }
        if version == 0 {
            let has_tables: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%')",
                [],
                |row| row.get(0),
            )?;
            if has_tables || application != 0 {
                return Err(GameStoreError::IncompatibleSchema);
            }
        }
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             PRAGMA foreign_keys=ON;",
        )?;
        if version == 0 {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute_batch(SCHEMA)?;
            transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
            transaction.pragma_update(None, "user_version", GAME_SCHEMA_VERSION)?;
            transaction.commit()?;
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "UPDATE game_operations SET status='interrupted',candidate=NULL,
             error_code='process_interrupted' WHERE status IN ('pending','generating','validating')",
            [],
        )?;
        transaction.commit()?;
        Ok(Self {
            connection: Mutex::new(connection),
            _owner_lock: owner_lock,
        })
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>, GameStoreError> {
        self.connection
            .lock()
            .map_err(|_| GameStoreError::Unavailable)
    }

    pub fn create_world(
        &self,
        setup: &WorldSetup,
        initial: &WorldState,
        opening_narrative: &str,
        opening_choices: &[Choice],
    ) -> Result<WorldView, GameStoreError> {
        validate_setup(setup).map_err(|_| GameStoreError::InvalidRequest)?;
        validate_state(initial).map_err(|_| GameStoreError::InvalidOutput)?;
        if !valid_game_id(&setup.world_id)
            || initial.time.era_year != setup.era_year
            || initial.time.elapsed_seconds != 0
            || !valid_text(opening_narrative, MAX_NARRATIVE_BYTES, false)
            || !valid_text(&setup.narrative_style, MAX_POLICY_BYTES, true)
            || opening_choices.len() > MAX_CHOICES
        {
            return Err(GameStoreError::InvalidRequest);
        }
        let mut choice_ids = std::collections::HashSet::new();
        if opening_choices.iter().any(|choice| {
            choice.id.is_empty()
                || choice.id.len() > 64
                || !choice
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                || !valid_text(&choice.text, 2048, false)
                || !choice_ids.insert(&choice.id)
        }) {
            return Err(GameStoreError::InvalidRequest);
        }
        let setup_json = json(setup)?;
        let state_json = json(initial)?;
        let choices_json = json(&opening_choices)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if transaction.query_row("SELECT EXISTS(SELECT 1 FROM game_world)", [], |row| {
            row.get::<_, bool>(0)
        })? {
            return Err(GameStoreError::AlreadyCreated);
        }
        transaction.execute(
            "INSERT INTO game_world(id,world_id,setup,initial_state,current_state,opening_narrative,
             opening_choices,narrative_policy,head_turn_id,turn_count,created_at_ms)
             VALUES(1,?1,?2,?3,?3,?4,?5,?6,NULL,0,?7)",
            params![
                setup.world_id,
                setup_json,
                state_json,
                opening_narrative,
                choices_json,
                setup.narrative_style,
                now_ms()?
            ],
        )?;
        transaction.commit()?;
        view_connection(&connection)
    }

    pub fn view(&self) -> Result<WorldView, GameStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let view = view_connection(&transaction)?;
        transaction.commit()?;
        Ok(view)
    }

    pub fn begin(&self, request: &GameTurnRequest) -> Result<(), GameStoreError> {
        if !valid_game_id(&request.operation_id)
            || !valid_game_id(&request.world_id)
            || request.branch_id != "main"
            || request
                .expected_head_turn_id
                .as_deref()
                .is_some_and(|head| !valid_game_id(head))
            || !valid_text(
                &request.action_text,
                MAX_ACTION_BYTES,
                request.action_kind == GameActionKind::Continue,
            )
        {
            return Err(GameStoreError::InvalidRequest);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<(String, Option<String>)> = transaction
            .query_row(
                "SELECT world_id,head_turn_id FROM game_world WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((world_id, head)) = current else {
            return Err(GameStoreError::NotFound);
        };
        if world_id != request.world_id {
            return Err(GameStoreError::InvalidRequest);
        }
        if transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM game_operations WHERE operation_id=?1)",
            [&request.operation_id],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(GameStoreError::Duplicate);
        }
        if transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM game_operations WHERE status IN ('pending','generating','validating'))",
            [],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(GameStoreError::Busy);
        }
        if head != request.expected_head_turn_id {
            return Err(GameStoreError::StaleHead);
        }
        transaction.execute(
            "INSERT INTO game_operations(operation_id,expected_head_turn_id,action_kind,action_text,
             status,candidate,error_code,created_at_ms) VALUES(?1,?2,?3,?4,'pending',NULL,NULL,?5)",
            params![
                request.operation_id,
                request.expected_head_turn_id,
                request.action_kind.as_str(),
                request.action_text,
                now_ms()?
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn mark_generating(&self, operation_id: &str) -> Result<(), GameStoreError> {
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE game_operations SET status='generating' WHERE operation_id=?1 AND status='pending'",
            [operation_id],
        )?;
        if changed != 1 {
            return Err(GameStoreError::InvalidTransition);
        }
        Ok(())
    }

    /// The provisional raw output is intentionally absent from WorldView and
    /// subsequent context. It is cleared on every terminal path and recovery.
    pub fn stage_output(&self, operation_id: &str, raw: &str) -> Result<(), GameStoreError> {
        if !valid_text(raw, MAX_CANDIDATE_BYTES, false) {
            return Err(GameStoreError::InvalidOutput);
        }
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE game_operations SET status='validating',candidate=?2
             WHERE operation_id=?1 AND status='generating'",
            params![operation_id, raw],
        )?;
        if changed != 1 {
            return Err(GameStoreError::InvalidTransition);
        }
        Ok(())
    }

    pub fn finish_uncommitted(
        &self,
        operation_id: &str,
        status: GameOperationStatus,
        error_code: Option<&str>,
    ) -> Result<(), GameStoreError> {
        if !matches!(
            status,
            GameOperationStatus::Failed
                | GameOperationStatus::Cancelled
                | GameOperationStatus::Interrupted
        ) {
            return Err(GameStoreError::InvalidTransition);
        }
        if error_code.is_some_and(|code| !safe_error_code(code)) {
            return Err(GameStoreError::InvalidErrorCode);
        }
        let connection = self.connection()?;
        let changed = connection.execute(
            "UPDATE game_operations SET status=?2,candidate=NULL,error_code=?3
             WHERE operation_id=?1 AND status IN ('pending','generating','validating')",
            params![operation_id, status.as_str(), error_code],
        )?;
        if changed != 1 {
            return Err(GameStoreError::InvalidTransition);
        }
        Ok(())
    }

    pub fn commit(
        &self,
        operation_id: &str,
        output: &TurnOutput,
    ) -> Result<WorldView, GameStoreError> {
        self.commit_with_hook(operation_id, output, || Ok(()))
    }

    /// Intended for an immediate cancellation check and isolated transaction
    /// fault tests. The hook must not perform HTTP or other external work.
    /// Any hook failure rolls back the snapshot, turn and operation together.
    pub fn commit_with_hook<F: FnOnce() -> Result<(), GameStoreError>>(
        &self,
        operation_id: &str,
        output: &TurnOutput,
        before_commit: F,
    ) -> Result<WorldView, GameStoreError> {
        let mut connection = self.connection()?;
        let operation: GameOperation =
            read_operation(&connection, operation_id)?.ok_or(GameStoreError::NotFound)?;
        if operation.status != GameOperationStatus::Validating {
            return Err(GameStoreError::InvalidTransition);
        }
        let candidate: Option<String> = connection.query_row(
            "SELECT candidate FROM game_operations WHERE operation_id=?1",
            [operation_id],
            |row| row.get(0),
        )?;
        let candidate = candidate.ok_or(GameStoreError::InvalidTransition)?;
        let parsed = parse_output(&candidate).map_err(|_| GameStoreError::InvalidOutput)?;
        if &parsed != output {
            return Err(GameStoreError::InvalidOutput);
        }
        // Pure validation completes before opening the short write transaction.
        let (head, count, state_json): (Option<String>, i64, String) = connection.query_row(
            "SELECT head_turn_id,turn_count,current_state FROM game_world WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        if head != operation.expected_head_turn_id {
            return Err(GameStoreError::StaleHead);
        }
        let state: WorldState = decode(&state_json)?;
        let next_state = apply_output(&state, output).map_err(|_| GameStoreError::InvalidOutput)?;
        let next_state_json = json(&next_state)?;
        let output_json = json(output)?;
        let choices_json = json(&output.choices)?;
        let next_count = count
            .checked_add(1)
            .ok_or(GameStoreError::RevisionOverflow)?;
        let timestamp = now_ms()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (current_head, current_count, current_state): (Option<String>, i64, String) =
            transaction.query_row(
                "SELECT head_turn_id,turn_count,current_state FROM game_world WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        if current_head != head || current_count != count || current_state != state_json {
            return Err(GameStoreError::StaleHead);
        }
        // The turn ID is the unique operation ID. No second identity can hide a
        // repeated settlement, and all old turns remain immutable.
        transaction.execute(
            "INSERT INTO game_turns(turn_id,parent_turn_id,sequence,action_kind,action_text,
             narrative,choices,state,output,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                operation_id,
                operation.expected_head_turn_id,
                next_count,
                operation.action_kind.as_str(),
                operation.action_text,
                output.narrative,
                choices_json,
                next_state_json,
                output_json,
                timestamp
            ],
        )?;
        let updated = transaction.execute(
            "UPDATE game_world SET current_state=?1,head_turn_id=?2,turn_count=?3
             WHERE id=1 AND head_turn_id IS ?4 AND turn_count=?5",
            params![next_state_json, operation_id, next_count, head, count],
        )?;
        if updated != 1 {
            return Err(GameStoreError::StaleHead);
        }
        let updated = transaction.execute(
            "UPDATE game_operations SET status='committed',candidate=NULL,error_code=NULL
             WHERE operation_id=?1 AND status='validating'",
            [operation_id],
        )?;
        if updated != 1 {
            return Err(GameStoreError::InvalidTransition);
        }
        before_commit()?;
        transaction.commit()?;
        view_connection(&connection)
    }

    /// OOC only changes the future narration policy. It creates no turn and
    /// cannot edit the opening, current facts, historical time, or head.
    pub fn update_policy(&self, policy: &str) -> Result<WorldView, GameStoreError> {
        if !valid_text(policy, MAX_POLICY_BYTES, true) {
            return Err(GameStoreError::InvalidRequest);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM game_operations WHERE status IN ('pending','generating','validating'))",
            [],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(GameStoreError::Busy);
        }
        if transaction.execute(
            "UPDATE game_world SET narrative_policy=?1 WHERE id=1",
            [policy],
        )? != 1
        {
            return Err(GameStoreError::NotFound);
        }
        transaction.commit()?;
        view_connection(&connection)
    }
}

fn read_operation(
    connection: &Connection,
    operation_id: &str,
) -> Result<Option<GameOperation>, GameStoreError> {
    type RawOperation = (
        String,
        Option<String>,
        String,
        String,
        String,
        Option<String>,
        i64,
    );
    let raw: Option<RawOperation> = connection.query_row(
        "SELECT operation_id,expected_head_turn_id,action_kind,action_text,status,error_code,created_at_ms
         FROM game_operations WHERE operation_id=?1",
        [operation_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    ).optional()?;
    raw.map(
        |(
            operation_id,
            expected_head_turn_id,
            action_kind,
            action_text,
            status,
            error_code,
            created_at_ms,
        )| {
            Ok(GameOperation {
                operation_id,
                expected_head_turn_id,
                action_kind: GameActionKind::parse(&action_kind)?,
                action_text,
                status: GameOperationStatus::parse(&status)?,
                error_code,
                created_at_ms,
            })
        },
    )
    .transpose()
}

fn view_connection(connection: &Connection) -> Result<WorldView, GameStoreError> {
    type RawWorld = (String, Option<String>, i64, String, String, String, String);
    let raw: Option<RawWorld> = connection.query_row(
        "SELECT setup,head_turn_id,turn_count,current_state,opening_narrative,opening_choices,narrative_policy
         FROM game_world WHERE id=1", [],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
    ).optional()?;
    let Some((
        setup,
        head_turn_id,
        turn_count,
        state,
        opening_narrative,
        opening_choices,
        narrative_policy,
    )) = raw
    else {
        return Err(GameStoreError::NotFound);
    };
    let state: WorldState = decode(&state)?;
    validate_state(&state).map_err(|_| GameStoreError::Database)?;
    let mut statement = connection.prepare(
        "SELECT turn_id,parent_turn_id,action_kind,action_text,narrative,choices,state,created_at_ms
         FROM game_turns ORDER BY sequence DESC LIMIT ?1",
    )?;
    let raw_turns = statement.query_map([RECENT_TURN_LIMIT as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, i64>(7)?,
        ))
    })?;
    let mut turns = Vec::new();
    for turn in raw_turns {
        let (
            turn_id,
            parent_turn_id,
            action_kind,
            action_text,
            narrative,
            choices,
            state,
            created_at_ms,
        ) = turn?;
        turns.push(CommittedTurn {
            turn_id,
            parent_turn_id,
            action_kind: GameActionKind::parse(&action_kind)?,
            action_text,
            narrative,
            choices: decode(&choices)?,
            state: decode(&state)?,
            created_at_ms,
        });
    }
    turns.reverse();
    let latest_id: Option<String> = connection
        .query_row(
            "SELECT operation_id FROM game_operations ORDER BY rowid DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let latest_operation = latest_id
        .map(|id| read_operation(connection, &id))
        .transpose()?
        .flatten();
    Ok(WorldView {
        setup: decode(&setup)?,
        branch_id: "main".to_owned(),
        head_turn_id,
        turn_count: turn_count
            .try_into()
            .map_err(|_| GameStoreError::Database)?,
        state,
        opening_narrative,
        opening_choices: decode(&opening_choices)?,
        narrative_policy,
        turns,
        latest_operation,
    })
}

fn safe_error_code(code: &str) -> bool {
    matches!(
        code,
        "invalid_url"
            | "invalid_config"
            | "credential_missing"
            | "credential_unavailable"
            | "credential_unconfirmed"
            | "credential_echo"
            | "operation_dropped"
            | "client_setup"
            | "network"
            | "connect_timeout"
            | "idle_timeout"
            | "total_timeout"
            | "http_status"
            | "invalid_content_type"
            | "invalid_utf8"
            | "event_too_large"
            | "response_too_large"
            | "output_too_large"
            | "invalid_payload"
            | "upstream_error"
            | "refused"
            | "truncated"
            | "unexpected_eof"
            | "empty_output"
            | "consumer_closed"
            | "invalid_options"
            | "process_interrupted"
            | "game_provider_missing"
            | "game_provider_failed"
            | "game_context_too_large"
            | "game_context_invalid_budget"
            | "game_context_invalid_input"
            | "game_context_stale_scope"
            | "game_context_uncommitted_fragment"
            | "game_context_invisible_source"
            | "game_context_unknown_fact"
            | "game_worker_failed"
            | "game_cancelled"
            | "game_database"
            | "game_unavailable"
            | "game_busy"
            | "game_duplicate"
            | "game_stale_head"
            | "game_invalid_request"
            | "game_invalid_output"
            | "game_invalid_transition"
            | "game_invalid_error_code"
            | "game_not_found"
            | "game_already_created"
            | "game_incompatible_schema"
            | "game_revision_overflow"
            | "game_clock"
            | "game_invalid_setup"
            | "game_invalid_protocol"
            | "game_invalid_entity"
            | "game_invalid_resource"
            | "game_invalid_time"
            | "game_dead_cannot_revive"
            | "game_invalid_relationship"
            | "game_invalid_condition"
            | "game_invalid_knowledge"
            | "game_invalid_event"
            | "game_invalid_reference"
            | "game_conflict"
            | "game_too_large"
            | "model_tls_unavailable"
            | "game_provider_busy"
            | "game_provider_unconfirmed"
            | "game_provider_invalid"
            | "game_protagonist_dead"
            | "game_provider_stale"
    )
}

/// Only predefined diagnostic codes enter immutable operation records. New
/// optional subsystems cannot leave a formal operation active on error.
pub fn persisted_game_error_code(code: &str) -> &str {
    if safe_error_code(code) {
        code
    } else {
        "game_provider_failed"
    }
}

pub(crate) const SCHEMA: &str = "
CREATE TABLE game_world (
 id INTEGER PRIMARY KEY CHECK(id=1), world_id TEXT NOT NULL UNIQUE,
 setup TEXT NOT NULL CHECK(json_valid(setup)), initial_state TEXT NOT NULL CHECK(json_valid(initial_state)),
 current_state TEXT NOT NULL CHECK(json_valid(current_state)), opening_narrative TEXT NOT NULL,
 opening_choices TEXT NOT NULL CHECK(json_valid(opening_choices)), narrative_policy TEXT NOT NULL,
 head_turn_id TEXT REFERENCES game_turns(turn_id), turn_count INTEGER NOT NULL CHECK(turn_count>=0),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 CHECK((turn_count=0 AND head_turn_id IS NULL) OR (turn_count>0 AND head_turn_id IS NOT NULL))
) STRICT;
CREATE TABLE game_operations (
 operation_id TEXT PRIMARY KEY, expected_head_turn_id TEXT REFERENCES game_turns(turn_id),
 action_kind TEXT NOT NULL CHECK(action_kind IN ('action','continue')), action_text TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','generating','validating','committed','failed','cancelled','interrupted')),
 candidate TEXT CHECK(candidate IS NULL OR length(CAST(candidate AS BLOB)) BETWEEN 1 AND 262144),
 error_code TEXT, created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 CHECK((status='validating' AND candidate IS NOT NULL) OR (status<>'validating' AND candidate IS NULL))
) STRICT;
CREATE UNIQUE INDEX game_one_active ON game_operations((1)) WHERE status IN ('pending','generating','validating');
CREATE TABLE game_turns (
 turn_id TEXT PRIMARY KEY REFERENCES game_operations(operation_id), parent_turn_id TEXT REFERENCES game_turns(turn_id),
 sequence INTEGER NOT NULL UNIQUE CHECK(sequence>0), action_kind TEXT NOT NULL CHECK(action_kind IN ('action','continue')),
 action_text TEXT NOT NULL, narrative TEXT NOT NULL, choices TEXT NOT NULL CHECK(json_valid(choices)),
 state TEXT NOT NULL CHECK(json_valid(state)), output TEXT NOT NULL CHECK(json_valid(output)),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0)
) STRICT;
CREATE TRIGGER game_turns_no_update BEFORE UPDATE ON game_turns BEGIN SELECT RAISE(ABORT,'immutable turn'); END;
CREATE TRIGGER game_turns_no_delete BEFORE DELETE ON game_turns BEGIN SELECT RAISE(ABORT,'immutable turn'); END;
CREATE TRIGGER game_operation_input_no_update BEFORE UPDATE OF operation_id,expected_head_turn_id,action_kind,action_text,created_at_ms
 ON game_operations BEGIN SELECT RAISE(ABORT,'immutable input'); END;
CREATE TRIGGER game_operations_no_delete BEFORE DELETE ON game_operations BEGIN SELECT RAISE(ABORT,'immutable input'); END;
CREATE TRIGGER game_opening_no_update BEFORE UPDATE OF world_id,setup,initial_state,opening_narrative,opening_choices,created_at_ms
 ON game_world BEGIN SELECT RAISE(ABORT,'immutable opening'); END;
CREATE TRIGGER game_opening_no_delete BEFORE DELETE ON game_world BEGIN SELECT RAISE(ABORT,'immutable opening'); END;
";
