//! Schema 2 playable persistence, with immutable mixed v1/v2 history.
//! Requests persist before HTTP starts; only validated output reaches immutable
//! turn snapshots. No network, platform keys, endpoint configuration, or raw
//! provider diagnostics belong in this store.

use std::{
    fs::{File, TryLockError},
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::game_archive::{LegacyTurn, LegacyWorldHeader, MAX_ARCHIVE_STATE_BYTES};
use crate::game_knowledge::{
    CommittedHistoryEntry, LegacyKnowledgeHistoryBuilder, ValidatedHistory,
};
use crate::game_legacy::LegacyAdapter;
use crate::game_memory::{MemoryBuildReceipt, MemoryError, MemoryIndex, MemoryTurnInput};
use crate::game_migration::MigrationReceipt;
use crate::game_protocol_v2::{
    apply_output_v2, initial_state_v2, parse_output_v2, validate_state_v2, CommitContext,
    TurnOutputV2, WorldStateV2,
};
use crate::game_store::{
    GameActionKind, GameOperation, GameOperationStatus, GameStoreError, GameTurnRequest,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::game_protocol::{validate_setup, Choice, WorldSetup, MAX_CHOICES, MAX_NARRATIVE_BYTES};

pub const GAME_SCHEMA_VERSION_V2: i32 = 2;
pub const MAX_ACTION_BYTES: usize = 16 * 1024;
pub const MAX_POLICY_BYTES: usize = 8 * 1024;
pub const MAX_CANDIDATE_BYTES: usize = 256 * 1024;
pub const RECENT_TURN_LIMIT: usize = 100;
const APPLICATION_ID: i32 = 0x4c495348;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommittedTurnV2 {
    pub turn_id: String,
    pub parent_turn_id: Option<String>,
    pub action_kind: GameActionKind,
    pub action_text: String,
    pub narrative: String,
    pub choices: Vec<Choice>,
    pub state: WorldStateV2,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorldViewV2 {
    pub setup: WorldSetup,
    pub branch_id: String,
    pub head_turn_id: Option<String>,
    pub turn_count: u64,
    pub state: WorldStateV2,
    pub opening_narrative: String,
    pub opening_choices: Vec<Choice>,
    pub narrative_policy: String,
    pub turns: Vec<CommittedTurnV2>,
    pub latest_operation: Option<GameOperation>,
}

/// Trusted scope of one successfully replayed, consistent committed path. The
/// ID list is internal core data, not a request accepting a path from the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedHistoryScope {
    pub setup: WorldSetup,
    pub branch_id: String,
    pub head_turn_id: Option<String>,
    pub turn_count: u64,
    pub state: WorldStateV2,
    pub visible_turn_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameMemoryIndexReceipt {
    pub scope: CommittedHistoryScope,
    pub index: MemoryBuildReceipt,
}

pub struct GameStoreV2 {
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

fn valid_text(text: &str, limit: usize, allow_empty: bool) -> bool {
    text.len() <= limit
        && (allow_empty || !text.trim().is_empty())
        && !text
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

impl GameStoreV2 {
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
        if !matches!(version, 0 | GAME_SCHEMA_VERSION_V2)
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
            transaction.pragma_update(None, "user_version", GAME_SCHEMA_VERSION_V2)?;
            transaction.commit()?;
        }
        check_schema(&connection)?;
        if connection.query_row("SELECT EXISTS(SELECT 1 FROM game_world)", [], |row| {
            row.get::<_, bool>(0)
        })? {
            // Validate the complete chain before changing recovery status.
            view_connection(&connection)?;
        } else if connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM game_operations) OR EXISTS(SELECT 1 FROM game_turns) OR EXISTS(SELECT 1 FROM game_migrations)",
            [], |row| row.get::<_, bool>(0),
        )? {
            return Err(GameStoreError::Database);
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

    pub fn create_world_v2(
        &self,
        setup: &WorldSetup,
        initial: &WorldStateV2,
        opening_narrative: &str,
        opening_choices: &[Choice],
    ) -> Result<WorldViewV2, GameStoreError> {
        validate_setup(setup).map_err(|_| GameStoreError::InvalidRequest)?;
        validate_state_v2(initial).map_err(|_| GameStoreError::InvalidOutput)?;
        // Fresh openings are produced by the trusted deterministic initializer;
        // no model can supply historical or future-turn provenance here.
        if initial != &initial_state_v2(setup).map_err(|_| GameStoreError::InvalidOutput)? {
            return Err(GameStoreError::InvalidOutput);
        }
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

    pub fn view(&self) -> Result<WorldViewV2, GameStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let view = view_connection(&transaction)?;
        transaction.commit()?;
        Ok(view)
    }

    /// Visit the entire committed path in a single read transaction. A mixed
    /// v1 prefix is replayed through LegacyAdapter, preserving original rows.
    /// Only the current/previous snapshots are retained, not a recent-100 UI
    /// window. Pending/generating/failed attempts are never visited or changed.
    /// A visitor must not re-enter this store or perform network calls. The
    /// complete-chain certificate is valid only when this method returns Ok.
    pub fn visit_committed_turns(
        &self,
        mut visitor: impl FnMut(CommittedTurnV2, u64, &str) -> Result<(), GameStoreError>,
    ) -> Result<CommittedHistoryScope, GameStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let mut visible_turn_ids = Vec::new();
        let view = scan_connection(&transaction, false, |turn, sequence| {
            visible_turn_ids.push(turn.turn_id.clone());
            visitor(turn, sequence, "main")
        })?;
        transaction.commit()?;
        Ok(history_scope(view, visible_turn_ids))
    }

    /// Bind a derived index to the owned store's actual world and current head;
    /// the frontend cannot supply a path, head, or a second set of facts. Source
    /// and cache errors abort the cache transaction. The source transaction is
    /// read-only and its owner guard remains held through cache completion.
    pub fn rebuild_memory_index(
        &self,
        index: &mut MemoryIndex,
    ) -> Result<GameMemoryIndexReceipt, GameStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let header = read_header(&transaction)?;
        let mut complete_scope = None;
        let mut source_error = None;
        let receipt = index
            .rebuild_with_visitor(
                &header.world_id,
                "main",
                header.head_turn_id.as_deref(),
                |emit| {
                    let mut visible_turn_ids = Vec::new();
                    let scan = scan_connection(&transaction, false, |turn, sequence| {
                        visible_turn_ids.push(turn.turn_id.clone());
                        emit(MemoryTurnInput::owned(turn, sequence, "main".into()))
                            .map_err(memory_store_error)
                    });
                    match scan {
                        Ok(view) => match transaction.commit() {
                            Ok(()) => {
                                complete_scope = Some(history_scope(view, visible_turn_ids));
                                Ok(())
                            }
                            Err(error) => {
                                source_error = Some(GameStoreError::from(error));
                                Err(MemoryError::Database)
                            }
                        },
                        Err(error) => {
                            source_error = Some(error);
                            Err(MemoryError::Database)
                        }
                    }
                },
            )
            .map_err(|error| source_error.unwrap_or_else(|| memory_store_error(error)))?;
        Ok(GameMemoryIndexReceipt {
            scope: complete_scope.ok_or(GameStoreError::Database)?,
            index: receipt,
        })
    }

    /// Complete, read-only fact revision index for character knowledge. It is
    /// derived from committed raw records within one SQLite read transaction,
    /// never from the recent UI window or an unverified converted head snapshot.
    pub fn knowledge_history(&self) -> Result<ValidatedHistory, GameStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        // Release the UI's recent snapshot window before building the compact
        // historical fact index; only the expected final node is needed here.
        let WorldViewV2 {
            setup,
            state,
            head_turn_id,
            turn_count,
            ..
        } = view_connection(&transaction)?;
        let header = read_header(&transaction)?;
        let receipt = migration_receipt(&transaction)?;
        let legacy_count = receipt.as_ref().map_or(0, |receipt| receipt.turn_count);
        let mut builder = receipt
            .as_ref()
            .map(|receipt| {
                LegacyKnowledgeHistoryBuilder::from_header(&legacy_header(
                    &transaction,
                    &header,
                    receipt,
                )?)
                .map_err(|_| GameStoreError::Database)
            })
            .transpose()?;
        let mut history = if builder.is_none() {
            Some(
                ValidatedHistory::new(
                    &header.world_id,
                    decode(&header.initial_state_json)?,
                    Vec::new(),
                    None,
                )
                .map_err(|_| GameStoreError::Database)?,
            )
        } else {
            None
        };
        if legacy_count == 0 {
            if let Some(builder) = builder.take() {
                history = Some(builder.finish().map_err(|_| GameStoreError::Database)?);
            }
        }
        {
            let mut statement = transaction.prepare(TURN_QUERY)?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let turn = read_turn(row)?;
                if turn.sequence <= legacy_count {
                    builder
                        .as_mut()
                        .ok_or(GameStoreError::Database)?
                        .push_turn(&turn)
                        .map_err(|_| GameStoreError::Database)?;
                    if turn.sequence == legacy_count {
                        history = Some(
                            builder
                                .take()
                                .ok_or(GameStoreError::Database)?
                                .finish()
                                .map_err(|_| GameStoreError::Database)?,
                        );
                    }
                } else {
                    history
                        .as_mut()
                        .ok_or(GameStoreError::Database)?
                        .append_v2_entry(CommittedHistoryEntry {
                            operation_id: turn.turn_id.clone(),
                            turn_id: turn.turn_id,
                            parent_turn_id: turn.parent_turn_id,
                            output: parse_output_v2(&turn.output_json)
                                .map_err(|_| GameStoreError::Database)?,
                            state: decode(&turn.state_json)?,
                        })
                        .map_err(|_| GameStoreError::Database)?;
                }
            }
        }
        let history = history.ok_or(GameStoreError::Database)?;
        if builder.is_some()
            || history.world_id() != setup.world_id
            || history.current_state() != &state
            || history.head_turn_id() != head_turn_id.as_deref()
            || history.turn_count() != turn_count
        {
            return Err(GameStoreError::Database);
        }
        transaction.commit()?;
        Ok(history)
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
        view_connection(&connection)?;
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
                action_name(request.action_kind),
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

    /// The provisional raw output is intentionally absent from WorldViewV2 and
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
            params![operation_id, status_name(status), error_code],
        )?;
        if changed != 1 {
            return Err(GameStoreError::InvalidTransition);
        }
        Ok(())
    }

    pub fn commit(
        &self,
        operation_id: &str,
        output: &TurnOutputV2,
    ) -> Result<WorldViewV2, GameStoreError> {
        self.commit_with_hook(operation_id, output, || Ok(()))
    }

    /// Intended for an immediate cancellation check and isolated transaction
    /// fault tests. The hook must not perform HTTP or other external work.
    /// Any hook failure rolls back the snapshot, turn and operation together.
    pub fn commit_with_hook<F: FnOnce() -> Result<(), GameStoreError>>(
        &self,
        operation_id: &str,
        output: &TurnOutputV2,
        before_commit: F,
    ) -> Result<WorldViewV2, GameStoreError> {
        let mut connection = self.connection()?;
        view_connection(&connection)?;
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
        let parsed = parse_output_v2(&candidate).map_err(|_| GameStoreError::InvalidOutput)?;
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
        let state: WorldStateV2 = decode(&state_json)?;
        let next_state = apply_output_v2(
            &state,
            output,
            &CommitContext {
                operation_id: operation_id.to_owned(),
                turn_id: operation_id.to_owned(),
            },
        )
        .map_err(|_| GameStoreError::InvalidOutput)?;
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
                action_name(operation.action_kind),
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
    pub fn update_policy(&self, policy: &str) -> Result<WorldViewV2, GameStoreError> {
        if !valid_text(policy, MAX_POLICY_BYTES, true) {
            return Err(GameStoreError::InvalidRequest);
        }
        let mut connection = self.connection()?;
        view_connection(&connection)?;
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
                action_kind: parse_action(&action_kind)?,
                action_text,
                status: parse_status(&status)?,
                error_code,
                created_at_ms,
            })
        },
    )
    .transpose()
}

fn action_name(kind: GameActionKind) -> &'static str {
    match kind {
        GameActionKind::Action => "action",
        GameActionKind::Continue => "continue",
    }
}

fn parse_action(kind: &str) -> Result<GameActionKind, GameStoreError> {
    match kind {
        "action" => Ok(GameActionKind::Action),
        "continue" => Ok(GameActionKind::Continue),
        _ => Err(GameStoreError::Database),
    }
}

fn status_name(status: GameOperationStatus) -> &'static str {
    match status {
        GameOperationStatus::Pending => "pending",
        GameOperationStatus::Generating => "generating",
        GameOperationStatus::Validating => "validating",
        GameOperationStatus::Committed => "committed",
        GameOperationStatus::Failed => "failed",
        GameOperationStatus::Cancelled => "cancelled",
        GameOperationStatus::Interrupted => "interrupted",
    }
}

fn parse_status(status: &str) -> Result<GameOperationStatus, GameStoreError> {
    match status {
        "pending" => Ok(GameOperationStatus::Pending),
        "generating" => Ok(GameOperationStatus::Generating),
        "validating" => Ok(GameOperationStatus::Validating),
        "committed" => Ok(GameOperationStatus::Committed),
        "failed" => Ok(GameOperationStatus::Failed),
        "cancelled" => Ok(GameOperationStatus::Cancelled),
        "interrupted" => Ok(GameOperationStatus::Interrupted),
        _ => Err(GameStoreError::Database),
    }
}

fn bounded_text(
    row: &rusqlite::Row<'_>,
    index: usize,
    limit: usize,
) -> Result<String, GameStoreError> {
    let value = row
        .get_ref(index)?
        .as_str()
        .map_err(|_| GameStoreError::Database)?;
    if value.len() > limit {
        return Err(GameStoreError::Database);
    }
    Ok(value.to_owned())
}

fn checked_choices(choices: &[Choice]) -> Result<(), GameStoreError> {
    let mut ids = std::collections::BTreeSet::new();
    if choices.len() > MAX_CHOICES
        || choices.iter().any(|choice| {
            choice.id.is_empty()
                || choice.id.len() > 64
                || !choice
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
                || !valid_text(&choice.text, 2048, false)
                || !ids.insert(&choice.id)
        })
    {
        return Err(GameStoreError::Database);
    }
    Ok(())
}

fn read_header(connection: &Connection) -> Result<LegacyWorldHeader, GameStoreError> {
    let mut statement = connection.prepare("SELECT world_id,setup,initial_state,current_state,opening_narrative,opening_choices,narrative_policy,head_turn_id,turn_count,created_at_ms FROM game_world WHERE id=1")?;
    let mut rows = statement.query([])?;
    let row = rows.next()?.ok_or(GameStoreError::NotFound)?;
    Ok(LegacyWorldHeader {
        world_id: bounded_text(row, 0, 128)?,
        setup_json: bounded_text(row, 1, 32 * 1024)?,
        initial_state_json: bounded_text(row, 2, MAX_ARCHIVE_STATE_BYTES)?,
        current_state_json: bounded_text(row, 3, MAX_ARCHIVE_STATE_BYTES)?,
        opening_narrative: bounded_text(row, 4, MAX_NARRATIVE_BYTES)?,
        opening_choices_json: bounded_text(row, 5, 128 * 1024)?,
        narrative_policy: bounded_text(row, 6, MAX_POLICY_BYTES)?,
        head_turn_id: row.get(7)?,
        turn_count: u64::try_from(row.get::<_, i64>(8)?).map_err(|_| GameStoreError::Database)?,
        created_at_ms: row.get(9)?,
    })
}

fn read_turn(row: &rusqlite::Row<'_>) -> Result<LegacyTurn, GameStoreError> {
    Ok(LegacyTurn {
        turn_id: bounded_text(row, 0, 128)?,
        parent_turn_id: row.get(1)?,
        sequence: u64::try_from(row.get::<_, i64>(2)?).map_err(|_| GameStoreError::Database)?,
        action_kind: parse_action(&bounded_text(row, 3, 16)?)?,
        action_text: bounded_text(row, 4, MAX_ACTION_BYTES)?,
        narrative: bounded_text(row, 5, MAX_NARRATIVE_BYTES)?,
        choices_json: bounded_text(row, 6, 128 * 1024)?,
        state_json: bounded_text(row, 7, MAX_ARCHIVE_STATE_BYTES)?,
        output_json: bounded_text(row, 8, MAX_CANDIDATE_BYTES)?,
        created_at_ms: row.get(9)?,
    })
}

const TURN_QUERY: &str = "SELECT turn_id,parent_turn_id,sequence,action_kind,action_text,narrative,choices,state,output,created_at_ms FROM game_turns ORDER BY sequence";

fn migration_receipt(connection: &Connection) -> Result<Option<MigrationReceipt>, GameStoreError> {
    let mut statement =
        connection.prepare("SELECT from_version,to_version,receipt FROM game_migrations")?;
    let mut rows = statement.query([])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    if row.get::<_, i64>(0)? != 1 || row.get::<_, i64>(1)? != 2 {
        return Err(GameStoreError::Database);
    }
    let receipt: MigrationReceipt = decode(&bounded_text(row, 2, 1024 * 1024)?)?;
    if receipt.from_version != 1
        || receipt.to_version != 2
        || receipt.adapter_version != crate::game_migration::ADAPTER_VERSION
        || receipt.completed_at_ms < 0
        || (receipt.turn_count == 0) != receipt.head_turn_id.is_none()
        || receipt
            .head_turn_id
            .as_deref()
            .is_some_and(|id| !valid_game_id(id))
        || receipt.legacy_operation_rowid_max < 0
        || ![
            &receipt.backup_sha256,
            &receipt.content_sha256,
            &receipt.immutable_legacy_sha256,
        ]
        .iter()
        .all(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        || receipt.backup_basename.is_empty()
        || receipt.backup_basename.contains(['/', '\\'])
        || rows.next()?.is_some()
    {
        return Err(GameStoreError::Database);
    }
    if crate::game_migration::immutable_legacy_fingerprint(
        connection,
        receipt.turn_count,
        receipt.legacy_operation_rowid_max,
    )
    .map_err(|_| GameStoreError::Database)?
        != receipt.immutable_legacy_sha256
    {
        return Err(GameStoreError::Database);
    }
    Ok(Some(receipt))
}

fn legacy_header(
    connection: &Connection,
    header: &LegacyWorldHeader,
    receipt: &MigrationReceipt,
) -> Result<LegacyWorldHeader, GameStoreError> {
    let mut prefix = header.clone();
    prefix.turn_count = receipt.turn_count;
    prefix.head_turn_id = receipt.head_turn_id.clone();
    prefix.current_state_json = if receipt.turn_count == 0 {
        prefix.initial_state_json.clone()
    } else {
        let mut statement =
            connection.prepare("SELECT turn_id,state FROM game_turns WHERE sequence=?1")?;
        let mut rows = statement
            .query([i64::try_from(receipt.turn_count).map_err(|_| GameStoreError::Database)?])?;
        let row = rows.next()?.ok_or(GameStoreError::Database)?;
        let head = bounded_text(row, 0, 128)?;
        let state = bounded_text(row, 1, MAX_ARCHIVE_STATE_BYTES)?;
        if Some(head) != receipt.head_turn_id {
            return Err(GameStoreError::Database);
        }
        state
    };
    Ok(prefix)
}

/// Streaming full-history verification; only the latest UI window is retained.
/// A migrated initial row and v1 turn rows are never rewritten or cached as a
/// second set of authoritative facts.
fn view_connection(connection: &Connection) -> Result<WorldViewV2, GameStoreError> {
    scan_connection(connection, true, |_, _| Ok(()))
}

fn history_scope(view: WorldViewV2, visible_turn_ids: Vec<String>) -> CommittedHistoryScope {
    CommittedHistoryScope {
        setup: view.setup,
        branch_id: view.branch_id,
        head_turn_id: view.head_turn_id,
        turn_count: view.turn_count,
        state: view.state,
        visible_turn_ids,
    }
}

fn memory_store_error(error: MemoryError) -> GameStoreError {
    match error {
        MemoryError::Busy => GameStoreError::Busy,
        MemoryError::Unavailable => GameStoreError::Unavailable,
        MemoryError::TooLarge => GameStoreError::InvalidRequest,
        _ => GameStoreError::Database,
    }
}

/// Shared validation for UI views and complete read-only consumers. A visitor
/// receives one validated record at a time; keep_recent=false never clones a
/// window of historical snapshots. M04 replaces the selected SQL ancestor path.
fn scan_connection(
    connection: &Connection,
    keep_recent: bool,
    mut visitor: impl FnMut(CommittedTurnV2, u64) -> Result<(), GameStoreError>,
) -> Result<WorldViewV2, GameStoreError> {
    check_schema(connection)?;
    let header = read_header(connection)?;
    let setup: WorldSetup = decode(&header.setup_json)?;
    validate_setup(&setup).map_err(|_| GameStoreError::Database)?;
    let stored_current: WorldStateV2 = decode(&header.current_state_json)?;
    validate_state_v2(&stored_current).map_err(|_| GameStoreError::Database)?;
    let opening_choices: Vec<Choice> = decode(&header.opening_choices_json)?;
    checked_choices(&opening_choices)?;
    if !valid_game_id(&header.world_id)
        || header.world_id != setup.world_id
        || header.created_at_ms < 0
        || !valid_text(&header.opening_narrative, MAX_NARRATIVE_BYTES, false)
        || !valid_text(&header.narrative_policy, MAX_POLICY_BYTES, true)
        || (header.turn_count == 0) != header.head_turn_id.is_none()
        || header
            .head_turn_id
            .as_deref()
            .is_some_and(|id| !valid_game_id(id))
    {
        return Err(GameStoreError::Database);
    }
    let receipt = migration_receipt(connection)?;
    let legacy_count = receipt.as_ref().map_or(0, |r| r.turn_count);
    if legacy_count > header.turn_count {
        return Err(GameStoreError::Database);
    }
    let mut adapter = if let Some(receipt) = &receipt {
        let prefix = legacy_header(connection, &header, receipt)?;
        Some(LegacyAdapter::from_header(&prefix).map_err(|_| GameStoreError::Database)?)
    } else {
        None
    };
    let mut current = if let Some(adapter) = &adapter {
        adapter.initial_state().clone()
    } else {
        let initial: WorldStateV2 = decode(&header.initial_state_json)?;
        if initial != initial_state_v2(&setup).map_err(|_| GameStoreError::Database)? {
            return Err(GameStoreError::Database);
        }
        initial
    };
    if legacy_count == 0 {
        if let Some(adapter) = adapter.take() {
            current = adapter
                .finish()
                .map_err(|_| GameStoreError::Database)?
                .current_state;
        }
    }
    let mut count = 0_u64;
    let mut head: Option<String> = None;
    let mut seen = std::collections::BTreeSet::new();
    let mut turns = std::collections::VecDeque::new();
    let mut statement = connection.prepare(TURN_QUERY)?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let turn = read_turn(row)?;
        count = count.checked_add(1).ok_or(GameStoreError::Database)?;
        if turn.sequence != count
            || turn.parent_turn_id != head
            || !valid_game_id(&turn.turn_id)
            || !seen.insert(turn.turn_id.clone())
            || turn.created_at_ms < 0
            || !valid_text(
                &turn.action_text,
                MAX_ACTION_BYTES,
                turn.action_kind == GameActionKind::Continue,
            )
        {
            return Err(GameStoreError::Database);
        }
        let choices: Vec<Choice> = decode(&turn.choices_json)?;
        checked_choices(&choices)?;
        if count <= legacy_count {
            let legacy = adapter.as_mut().ok_or(GameStoreError::Database)?;
            current = legacy
                .push_turn(&turn)
                .map_err(|_| GameStoreError::Database)?
                .clone();
            if count == legacy_count {
                current = adapter
                    .take()
                    .ok_or(GameStoreError::Database)?
                    .finish()
                    .map_err(|_| GameStoreError::Database)?
                    .current_state;
            }
        } else {
            let output =
                parse_output_v2(&turn.output_json).map_err(|_| GameStoreError::Database)?;
            let snapshot: WorldStateV2 = decode(&turn.state_json)?;
            let replayed = apply_output_v2(
                &current,
                &output,
                &CommitContext {
                    operation_id: turn.turn_id.clone(),
                    turn_id: turn.turn_id.clone(),
                },
            )
            .map_err(|_| GameStoreError::Database)?;
            if replayed != snapshot
                || output.narrative != turn.narrative
                || output.choices != choices
            {
                return Err(GameStoreError::Database);
            }
            current = snapshot;
        }
        let matching: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM game_operations WHERE operation_id=?1 AND expected_head_turn_id IS ?2 AND action_kind=?3 AND action_text=?4 AND status='committed' AND candidate IS NULL AND error_code IS NULL)", params![turn.turn_id, turn.parent_turn_id, action_name(turn.action_kind), turn.action_text], |row| row.get(0))?;
        if !matching {
            return Err(GameStoreError::Database);
        }
        head = Some(turn.turn_id.clone());
        let committed = CommittedTurnV2 {
            turn_id: turn.turn_id,
            parent_turn_id: turn.parent_turn_id,
            action_kind: turn.action_kind,
            action_text: turn.action_text,
            narrative: turn.narrative,
            choices,
            state: current.clone(),
            created_at_ms: turn.created_at_ms,
        };
        if keep_recent {
            turns.push_back(committed);
            if turns.len() > RECENT_TURN_LIMIT {
                turns.pop_front();
            }
        } else {
            visitor(committed, count)?;
        }
    }
    if adapter.is_some()
        || count != header.turn_count
        || head != header.head_turn_id
        || current != stored_current
    {
        return Err(GameStoreError::Database);
    }
    let latest_operation = check_operations(connection, &head, count)?;
    Ok(WorldViewV2 {
        setup,
        branch_id: "main".into(),
        head_turn_id: head,
        turn_count: count,
        state: current,
        opening_narrative: header.opening_narrative,
        opening_choices,
        narrative_policy: header.narrative_policy,
        turns: turns.into_iter().collect(),
        latest_operation,
    })
}

fn check_operations(
    connection: &Connection,
    head: &Option<String>,
    expected_committed: u64,
) -> Result<Option<GameOperation>, GameStoreError> {
    let mut statement = connection.prepare("SELECT operation_id,expected_head_turn_id,action_kind,action_text,status,error_code,created_at_ms,candidate FROM game_operations ORDER BY rowid")?;
    let mut rows = statement.query([])?;
    let mut latest = None;
    let mut active = 0_u64;
    let mut committed = 0_u64;
    while let Some(row) = rows.next()? {
        let operation = GameOperation {
            operation_id: bounded_text(row, 0, 128)?,
            expected_head_turn_id: row.get(1)?,
            action_kind: parse_action(&bounded_text(row, 2, 16)?)?,
            action_text: bounded_text(row, 3, MAX_ACTION_BYTES)?,
            status: parse_status(&bounded_text(row, 4, 16)?)?,
            error_code: row.get(5)?,
            created_at_ms: row.get(6)?,
        };
        let candidate: Option<String> = row.get(7)?;
        if !valid_game_id(&operation.operation_id)
            || operation
                .expected_head_turn_id
                .as_deref()
                .is_some_and(|id| !valid_game_id(id))
            || !valid_text(
                &operation.action_text,
                MAX_ACTION_BYTES,
                operation.action_kind == GameActionKind::Continue,
            )
            || operation.created_at_ms < 0
            || operation
                .error_code
                .as_deref()
                .is_some_and(|code| !safe_error_code(code))
            || (operation.status == GameOperationStatus::Validating) != candidate.is_some()
            || candidate
                .as_deref()
                .is_some_and(|text| !valid_text(text, MAX_CANDIDATE_BYTES, false))
        {
            return Err(GameStoreError::Database);
        }
        if operation.status.is_active() {
            active += 1;
            if operation.expected_head_turn_id != *head || operation.error_code.is_some() {
                return Err(GameStoreError::Database);
            }
        }
        if operation.status == GameOperationStatus::Committed {
            committed += 1;
            if operation.error_code.is_some() {
                return Err(GameStoreError::Database);
            }
        }
        latest = Some(operation);
    }
    if active > 1 || committed != expected_committed {
        return Err(GameStoreError::Database);
    }
    Ok(latest)
}

fn check_schema(connection: &Connection) -> Result<(), GameStoreError> {
    if connection.pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))?
        != GAME_SCHEMA_VERSION_V2
        || connection.pragma_query_value(None, "application_id", |row| row.get::<_, i32>(0))?
            != APPLICATION_ID
        || connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))? != "ok"
        || connection
            .prepare("PRAGMA foreign_key_check")?
            .query([])?
            .next()?
            .is_some()
    {
        return Err(GameStoreError::IncompatibleSchema);
    }
    for (name, body) in [
        ("game_turns_no_update", "BEFORE UPDATE ON game_turns BEGIN SELECT RAISE(ABORT,'immutable turn'); END"),
        ("game_turns_no_delete", "BEFORE DELETE ON game_turns BEGIN SELECT RAISE(ABORT,'immutable turn'); END"),
        ("game_operation_input_no_update", "BEFORE UPDATE OF operation_id,expected_head_turn_id,action_kind,action_text,created_at_ms ON game_operations BEGIN SELECT RAISE(ABORT,'immutable input'); END"),
        ("game_operations_no_delete", "BEFORE DELETE ON game_operations BEGIN SELECT RAISE(ABORT,'immutable input'); END"),
        ("game_opening_no_update", "BEFORE UPDATE OF world_id,setup,initial_state,opening_narrative,opening_choices,created_at_ms ON game_world BEGIN SELECT RAISE(ABORT,'immutable opening'); END"),
        ("game_opening_no_delete", "BEFORE DELETE ON game_world BEGIN SELECT RAISE(ABORT,'immutable opening'); END"),
    ] {
        let sql: Option<String> = connection.query_row("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?1", [name], |row| row.get(0)).optional()?;
        let normalize = |value: &str| value.chars().filter(|c| !c.is_ascii_whitespace()).collect::<String>().to_ascii_lowercase();
        if sql.as_deref().map(normalize) != Some(normalize(&format!("CREATE TRIGGER {name} {body}"))) { return Err(GameStoreError::IncompatibleSchema); }
    }
    let has_receipts: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='game_migrations')",
        [],
        |row| row.get(0),
    )?;
    if !has_receipts {
        return Err(GameStoreError::IncompatibleSchema);
    }
    Ok(())
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

const SCHEMA: &str = "
CREATE TABLE game_migrations (from_version INTEGER NOT NULL,to_version INTEGER NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(from_version,to_version));
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
