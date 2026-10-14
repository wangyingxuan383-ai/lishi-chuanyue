//! Rebuildable, local narrative references. This is a cache, never world facts.
//!
//! The caller supplies committed, player-visible narratives and the complete
//! legal ancestor path. It must obtain character identities from a filtered
//! actor view. Neither an index nor a caller-supplied path proves authorization.
//! Only one input snapshot is inspected at a time. No pending output, hidden
//! model reasoning, operation diagnostics, or external research is indexed.

use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
    fmt,
    fs::{File, TryLockError},
    path::Path,
    time::Duration,
};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    game_protocol::{MAX_ELAPSED_SECONDS, MAX_ENTITIES, MAX_NARRATIVE_BYTES},
    game_protocol_v2::{validate_state_v2, ConditionCategory, FactKey, StateSource, WorldStateV2},
    game_store_v2::CommittedTurnV2,
};

const APPLICATION_ID: i32 = 0x4c4d494e;
const SCHEMA_VERSION: i32 = 1;
pub const MEMORY_INDEX_VERSION: u32 = 1;
// Query-only semantics changed; persisted cache rows and schema remain v1.
// Include this in fingerprints so cursors from the old OR name filter expire.
const MEMORY_QUERY_VERSION: u8 = 2;
pub const MAX_MEMORY_FRAGMENT_BYTES: usize = 2048;
const FRAGMENT_OVERLAP_BYTES: usize = 256;
pub const MAX_MEMORY_QUERY_BYTES: usize = 256;
pub const MAX_MEMORY_RESULTS: usize = 64;
pub const MAX_MEMORY_VISIBLE_TURNS: usize = 100_000;
pub const MAX_MEMORY_TAGS: usize = 32;
/// Short un-tokenized searches examine at most this many already scoped rows
/// per page. `next_cursor` continues the scan even if this window has no hit.
pub const MAX_SHORT_MEMORY_CANDIDATES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryError {
    Unavailable,
    Busy,
    IncompatibleIndex,
    InvalidInput,
    InvalidScope,
    TooLarge,
    StaleCursor,
    Database,
}

impl fmt::Display for MemoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "memory_unavailable",
            Self::Busy => "memory_busy",
            Self::IncompatibleIndex => "memory_incompatible_index",
            Self::InvalidInput => "memory_invalid_input",
            Self::InvalidScope => "memory_invalid_scope",
            Self::TooLarge => "memory_too_large",
            Self::StaleCursor => "memory_stale_cursor",
            Self::Database => "memory_database",
        })
    }
}

impl std::error::Error for MemoryError {}

impl From<rusqlite::Error> for MemoryError {
    fn from(error: rusqlite::Error) -> Self {
        if matches!(error, rusqlite::Error::SqliteFailure(ref detail, _) if matches!(detail.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
        {
            Self::Busy
        } else {
            Self::Database
        }
    }
}

/// The snapshot is borrowed and discarded after this record is indexed. A
/// mixed legacy/v2 caller adapts old committed records before passing them.
#[derive(Debug, Clone)]
pub struct MemoryTurnInput<'a> {
    /// Borrow an existing record or own one yielded by a streaming DB iterator.
    pub turn: Cow<'a, CommittedTurnV2>,
    pub sequence: u64,
    /// Original writer branch, which can be an ancestor of the target scope.
    pub origin_branch_id: Cow<'a, str>,
}

impl<'a> MemoryTurnInput<'a> {
    pub fn borrowed(turn: &'a CommittedTurnV2, sequence: u64, origin_branch_id: &'a str) -> Self {
        Self {
            turn: Cow::Borrowed(turn),
            sequence,
            origin_branch_id: Cow::Borrowed(origin_branch_id),
        }
    }

    pub fn owned(turn: CommittedTurnV2, sequence: u64, origin_branch_id: String) -> Self {
        Self {
            turn: Cow::Owned(turn),
            sequence,
            origin_branch_id: Cow::Owned(origin_branch_id),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryKnownIdentity {
    pub entity_id: String,
    /// Only names/aliases the selected actor knows, including historical names.
    pub names: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct MemoryScope<'a> {
    pub world_id: &'a str,
    pub branch_id: &'a str,
    pub head_turn_id: Option<&'a str>,
    /// Complete, ordered root-to-head path. Never a broad branch SQL predicate.
    pub visible_turn_ids: &'a [String],
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryQuery {
    pub query: String,
    pub entity_ids: Vec<String>,
    /// Exact tags, OR within this list, AND with an entity/text filter.
    pub tags: Vec<String>,
    pub min_elapsed_seconds: Option<u64>,
    pub max_elapsed_seconds: Option<u64>,
    /// Zero is invalid; use `MemoryQuery::recent` for a useful default.
    pub max_results: usize,
    pub cursor: Option<MemoryCursor>,
}

impl MemoryQuery {
    pub fn recent(max_results: usize) -> Self {
        Self {
            max_results,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryCursor {
    pub revision: u64,
    pub fingerprint: String,
    pub after_sequence: u64,
    pub after_byte_start: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryMatchKind {
    KnownEntity,
    Trigram,
    ShortSubstring,
    Tag,
    Recent,
}

/// A byte range in the immutable original narrative, not an established fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemorySourceReference {
    pub world_id: String,
    pub origin_branch_id: String,
    pub turn_id: String,
    pub sequence: u64,
    pub elapsed_seconds: u64,
    pub byte_start: usize,
    pub byte_end: usize,
    pub narrative_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryFragment {
    pub text: String,
    pub source: MemorySourceReference,
    /// Only IDs allowed by the caller's current filtered identity view.
    pub entity_ids: Vec<String>,
    pub tags: Vec<String>,
    pub match_kind: MemoryMatchKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryPage {
    pub fragments: Vec<MemoryFragment>,
    pub next_cursor: Option<MemoryCursor>,
    pub index_revision: u64,
    pub index_version: u32,
    pub candidates_examined: usize,
    pub candidate_window_exhausted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryBuildReceipt {
    pub turn_count: u64,
    pub fragment_count: u64,
    pub revision: u64,
    pub head_turn_id: Option<String>,
}

pub struct MemoryIndex {
    connection: Connection,
    // Independent cache lock; never acquire or remove a world store lock.
    _owner_lock: Option<File>,
}

impl fmt::Debug for MemoryIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MemoryIndex { derived_cache: true }")
    }
}

impl MemoryIndex {
    /// A dedicated cache file, never a world save. Existing foreign databases
    /// are refused before any schema/journal change. A path alias to a facts
    /// database is also refused by its independent application ID.
    pub fn open_sidecar(path: impl AsRef<Path>) -> Result<Self, MemoryError> {
        let path = path.as_ref();
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".memory-owner-lock");
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(Path::new(&lock_path))
            .map_err(|_| MemoryError::Unavailable)?;
        lock.try_lock().map_err(|e| match e {
            TryLockError::WouldBlock => MemoryError::Busy,
            TryLockError::Error(_) => MemoryError::Unavailable,
        })?;
        let connection = Connection::open(path).map_err(|_| MemoryError::Unavailable)?;
        Self::initialize(connection, Some(lock))
    }

    pub fn in_memory() -> Result<Self, MemoryError> {
        Self::initialize(Connection::open_in_memory()?, None)
    }

    fn initialize(
        mut connection: Connection,
        owner_lock: Option<File>,
    ) -> Result<Self, MemoryError> {
        let application: i32 =
            connection.pragma_query_value(None, "application_id", |r| r.get(0))?;
        let version: i32 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        let has_tables: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%')",
            [],
            |r| r.get(0),
        )?;
        if !((application == 0 && version == 0 && !has_tables)
            || (application == APPLICATION_ID && version == SCHEMA_VERSION))
        {
            return Err(MemoryError::IncompatibleIndex);
        }
        connection.busy_timeout(Duration::from_millis(100))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
        if application == 0 {
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute_batch(SCHEMA)?;
            transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
            transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            transaction.commit()?;
        }
        // Force an actual FTS5/trigram prepare, rather than infer capability.
        connection.prepare("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?1 LIMIT 1")?;
        connection.execute_batch(TEMP_SCHEMA)?;
        Ok(Self {
            connection,
            _owner_lock: owner_lock,
        })
    }

    /// Atomically replace one scope. Failed input rolls the old cache back.
    /// Iterator order must be a complete single ancestor chain, not siblings.
    /// Rebuilding changes only this dedicated cache; source JSON is never read
    /// through SQL here, much less updated. No 100/recent-turn truncation.
    pub fn rebuild<'a>(
        &mut self,
        world_id: &str,
        branch_id: &str,
        expected_head_turn_id: Option<&str>,
        records: impl IntoIterator<Item = MemoryTurnInput<'a>>,
    ) -> Result<MemoryBuildReceipt, MemoryError> {
        self.rebuild_fallible(
            world_id,
            branch_id,
            expected_head_turn_id,
            records.into_iter().map(Ok),
        )
    }

    /// SQL readers can yield a closed error instead of collecting all records
    /// or silently dropping a failed row. Any source error rolls back this
    /// complete cache rebuild and leaves the previous index revision intact.
    pub fn rebuild_fallible<'a>(
        &mut self,
        world_id: &str,
        branch_id: &str,
        expected_head_turn_id: Option<&str>,
        records: impl IntoIterator<Item = Result<MemoryTurnInput<'a>, MemoryError>>,
    ) -> Result<MemoryBuildReceipt, MemoryError> {
        self.rebuild_with_visitor(world_id, branch_id, expected_head_turn_id, |emit| {
            for record in records {
                emit(record?)?;
            }
            Ok(())
        })
    }

    /// Bridge a live SQL cursor without retaining history snapshots. Every
    /// producer error, including one after the last emitted row, rolls back the
    /// complete cache replacement. Emitted records must be owned when their
    /// backing cursor/adapter snapshot will change on the next iteration.
    pub fn rebuild_with_visitor<'a>(
        &mut self,
        world_id: &str,
        branch_id: &str,
        expected_head_turn_id: Option<&str>,
        producer: impl FnOnce(
            &mut dyn FnMut(MemoryTurnInput<'a>) -> Result<(), MemoryError>,
        ) -> Result<(), MemoryError>,
    ) -> Result<MemoryBuildReceipt, MemoryError> {
        validate_scope_ids(world_id, branch_id, expected_head_turn_id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let old: Option<(i64, u64)> = tx
            .query_row(
                "SELECT id,revision FROM memory_scopes WHERE world_id=?1 AND branch_id=?2",
                params![world_id, branch_id],
                |r| Ok((r.get(0)?, read_u64(r, 1)?)),
            )
            .optional()?;
        let revision = old.as_ref().map_or(Ok(1), |(_, r)| {
            r.checked_add(1).ok_or(MemoryError::TooLarge)
        })?;
        let sql_revision = i64::try_from(revision).map_err(|_| MemoryError::TooLarge)?;
        let scope_id = match old {
            Some((id, _)) => {
                tx.execute("DELETE FROM memory_turns WHERE scope_id=?1", [id])?;
                id
            }
            None => {
                tx.execute("INSERT INTO memory_scopes(world_id,branch_id,revision,turn_count) VALUES (?1,?2,0,0)", params![world_id, branch_id])?;
                tx.last_insert_rowid()
            }
        };
        let mut head: Option<String> = None;
        let mut count = 0_u64;
        let mut fragments = 0_u64;
        let mut last_time = 0_u64;
        producer(&mut |record| {
            if count >= MAX_MEMORY_VISIBLE_TURNS as u64 {
                return Err(MemoryError::TooLarge);
            }
            validate_record(&record)?;
            let turn = record.turn.as_ref();
            if record.sequence != count + 1
                || turn.parent_turn_id != head
                || turn.state.time.elapsed_seconds < last_time
            {
                return Err(MemoryError::InvalidScope);
            }
            let narrative_hash = hash_bytes(turn.narrative.as_bytes());
            tx.execute(
                "INSERT INTO memory_turns(scope_id,turn_id,parent_turn_id,sequence,elapsed_seconds,narrative_sha256,origin_branch_id) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![scope_id, turn.turn_id, turn.parent_turn_id, record.sequence as i64, turn.state.time.elapsed_seconds as i64, narrative_hash, record.origin_branch_id.as_ref()],
            )?;
            let (participants, tags, names) = record_metadata(turn);
            for (start, end) in fragment_ranges(&turn.narrative) {
                let text = &turn.narrative[start..end];
                tx.execute("INSERT INTO memory_fragments(scope_id,turn_id,byte_start,byte_end,text) VALUES (?1,?2,?3,?4,?5)", params![scope_id, turn.turn_id, start as i64, end as i64, text])?;
                let fragment_id = tx.last_insert_rowid();
                let mut entities = participants.clone();
                for (name, ids) in &names {
                    // Ambiguous identical names never choose or link both IDs.
                    // Explicit formal event participants still distinguish them.
                    if ids.len() == 1 && text.contains(name.as_str()) {
                        entities.insert(ids.iter().next().expect("one ID").clone());
                    }
                }
                for entity_id in entities {
                    tx.execute(
                        "INSERT INTO memory_entities(fragment_id,entity_id) VALUES (?1,?2)",
                        params![fragment_id, entity_id],
                    )?;
                }
                for tag in &tags {
                    tx.execute(
                        "INSERT INTO memory_tags(fragment_id,tag) VALUES (?1,?2)",
                        params![fragment_id, tag],
                    )?;
                }
                fragments += 1;
            }
            last_time = turn.state.time.elapsed_seconds;
            head = Some(turn.turn_id.clone());
            count += 1;
            Ok(())
        })?;
        if head.as_deref() != expected_head_turn_id {
            return Err(MemoryError::InvalidScope);
        }
        tx.execute(
            "UPDATE memory_scopes SET head_turn_id=?1,revision=?2,turn_count=?3 WHERE id=?4",
            params![head, sql_revision, count as i64, scope_id],
        )?;
        tx.commit()?;
        Ok(MemoryBuildReceipt {
            turn_count: count,
            fragment_count: fragments,
            revision,
            head_turn_id: head,
        })
    }

    /// Results are bounded and paginated newest-first. Scope is checked before
    /// ranking or text lookup. Names from an unfiltered global state are never
    /// used for name resolution. `current_state` is only used for validation
    /// and current entity existence; the actor-filtered names remain separate.
    pub fn retrieve(
        &mut self,
        scope: &MemoryScope<'_>,
        query: &MemoryQuery,
        current_state: &WorldStateV2,
        known_identities: &[MemoryKnownIdentity],
    ) -> Result<MemoryPage, MemoryError> {
        validate_query(query)?;
        validate_state_v2(current_state).map_err(|_| MemoryError::InvalidInput)?;
        let allowed = validate_identities(current_state, known_identities)?;
        let (scope_id, revision) =
            self.validate_scope(scope, current_state.time.elapsed_seconds)?;
        let fingerprint = query_fingerprint(scope, query, current_state, known_identities)?;
        if let Some(cursor) = &query.cursor {
            if cursor.revision != revision
                || cursor.fingerprint != fingerprint
                || cursor.after_sequence == 0
                || cursor.after_sequence > MAX_MEMORY_VISIBLE_TURNS as u64
                || cursor.after_byte_start >= MAX_NARRATIVE_BYTES
            {
                return Err(MemoryError::StaleCursor);
            }
        }
        let mut entity_ids: BTreeSet<String> = query.entity_ids.iter().cloned().collect();
        if entity_ids.iter().any(|id| !allowed.contains(id)) {
            return Err(MemoryError::InvalidInput);
        }
        let text = query.query.trim();
        let (name_groups, topic) = resolve_query_names(text, known_identities);
        let matched_name = !name_groups.is_empty();
        if matched_name && !entity_ids.is_empty() {
            let named = name_groups.iter().flatten().cloned().collect();
            entity_ids = entity_ids.intersection(&named).cloned().collect();
            if entity_ids.is_empty() {
                return Ok(MemoryPage {
                    fragments: vec![],
                    next_cursor: None,
                    index_revision: revision,
                    index_version: MEMORY_INDEX_VERSION,
                    candidates_examined: 0,
                    candidate_window_exhausted: false,
                });
            }
        }
        // Resolve identities, then retain the rest of the literal query as an
        // AND topic filter. Distinct names are also separate AND groups, with
        // ambiguous candidates OR within one name. "李安钥匙" must not become
        // all memories of 李安 just because 钥匙 is a known item name.
        // Remove longer overlapping names first; unknown global aliases never
        // participate in this reduction. Single-character names only resolve
        // when they are the complete query, preventing accidental common-glyph
        // matches inside an unrelated Chinese topic.
        let text = topic.trim_matches(|c: char| {
            c.is_whitespace() || matches!(c, ',' | '，' | ':' | '：' | ';' | '；' | '、')
        });
        self.connection
            .execute_batch("DELETE FROM memory_query_entities; DELETE FROM memory_query_names; DELETE FROM memory_query_tags;")?;
        for id in &entity_ids {
            self.connection.execute(
                "INSERT INTO memory_query_entities(entity_id) VALUES (?1)",
                [id],
            )?;
        }
        for (group_id, ids) in name_groups.iter().enumerate() {
            for id in ids {
                self.connection.execute(
                    "INSERT INTO memory_query_names(group_id,entity_id) VALUES (?1,?2)",
                    params![group_id as i64, id],
                )?;
            }
        }
        for tag in &query.tags {
            self.connection
                .execute("INSERT INTO memory_query_tags(tag) VALUES (?1)", [tag])?;
        }

        let text_mode = if text.is_empty() {
            0_i64
        } else if text.chars().count() >= 3 {
            1
        } else {
            2
        };
        // FTS grammar is quoted as a literal phrase, independently of SQL
        // parameterization. A model/user string cannot inject MATCH operators.
        let fts_query = format!("\"{}\"", text.replace('"', "\"\""));
        let cursor_sequence = query
            .cursor
            .as_ref()
            .map_or(i64::MAX, |c| c.after_sequence as i64);
        let cursor_start = query.cursor.as_ref().map_or(0, |c| c.after_byte_start);
        let mut statement = self.connection.prepare(RETRIEVE_SQL)?;
        let short_scan = text_mode == 2;
        let mut rows = statement.query(params![
            scope_id,
            !entity_ids.is_empty(),
            !query.tags.is_empty(),
            if short_scan { 3 } else { text_mode },
            fts_query,
            text,
            query.min_elapsed_seconds.unwrap_or(0) as i64,
            query.max_elapsed_seconds.unwrap_or(MAX_ELAPSED_SECONDS) as i64,
            query.cursor.is_some(),
            cursor_sequence,
            cursor_start as i64,
            if short_scan {
                MAX_SHORT_MEMORY_CANDIDATES as i64
            } else {
                (query.max_results + 1) as i64
            },
        ])?;
        let match_kind = if matched_name || !entity_ids.is_empty() {
            MemoryMatchKind::KnownEntity
        } else if text_mode == 1 {
            MemoryMatchKind::Trigram
        } else if text_mode == 2 {
            MemoryMatchKind::ShortSubstring
        } else if !query.tags.is_empty() {
            MemoryMatchKind::Tag
        } else {
            MemoryMatchKind::Recent
        };
        let mut result = Vec::with_capacity(query.max_results + 1);
        let mut examined = 0;
        let mut last_examined = None;
        while let Some(row) = rows.next()? {
            examined += 1;
            let sequence = read_u64(row, 3)?;
            let start = read_u64(row, 5)? as usize;
            last_examined = Some((sequence, start));
            let text_value: String = row.get(1)?;
            if short_scan && !text_value.contains(text) {
                continue;
            }
            let fragment_id: i64 = row.get(0)?;
            let mut entity_statement = self.connection.prepare(
                "SELECT entity_id FROM memory_entities WHERE fragment_id=?1 ORDER BY entity_id",
            )?;
            let entities = entity_statement
                .query_map([fragment_id], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .filter(|id| allowed.contains(id))
                .collect();
            let mut tag_statement = self
                .connection
                .prepare("SELECT tag FROM memory_tags WHERE fragment_id=?1 ORDER BY tag")?;
            let tags = tag_statement
                .query_map([fragment_id], |r| r.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            result.push(MemoryFragment {
                text: text_value,
                source: MemorySourceReference {
                    world_id: scope.world_id.to_owned(),
                    turn_id: row.get(2)?,
                    sequence,
                    elapsed_seconds: read_u64(row, 4)?,
                    byte_start: start,
                    byte_end: read_u64(row, 6)? as usize,
                    narrative_sha256: row.get(7)?,
                    origin_branch_id: row.get(8)?,
                },
                entity_ids: entities,
                tags,
                match_kind,
            });
            if result.len() > query.max_results {
                break;
            }
        }
        let has_more = result.len() > query.max_results;
        let window_exhausted = short_scan && !has_more && examined == MAX_SHORT_MEMORY_CANDIDATES;
        result.truncate(query.max_results);
        let next_cursor = if has_more {
            result.last().map(|last| MemoryCursor {
                revision,
                fingerprint,
                after_sequence: last.source.sequence,
                after_byte_start: last.source.byte_start,
            })
        } else if window_exhausted {
            last_examined.map(|(sequence, start)| MemoryCursor {
                revision,
                fingerprint,
                after_sequence: sequence,
                after_byte_start: start,
            })
        } else {
            None
        };
        Ok(MemoryPage {
            fragments: result,
            next_cursor,
            index_revision: revision,
            index_version: MEMORY_INDEX_VERSION,
            candidates_examined: examined,
            candidate_window_exhausted: window_exhausted,
        })
    }

    fn validate_scope(
        &self,
        scope: &MemoryScope<'_>,
        current_time: u64,
    ) -> Result<(i64, u64), MemoryError> {
        validate_scope_ids(scope.world_id, scope.branch_id, scope.head_turn_id)?;
        if scope.visible_turn_ids.len() > MAX_MEMORY_VISIBLE_TURNS {
            return Err(MemoryError::TooLarge);
        }
        let meta: Option<(i64, u64, Option<String>, u64)> = self.connection.query_row(
            "SELECT id,revision,head_turn_id,turn_count FROM memory_scopes WHERE world_id=?1 AND branch_id=?2",
            params![scope.world_id, scope.branch_id], |r| Ok((r.get(0)?, read_u64(r, 1)?, r.get(2)?, read_u64(r, 3)?)),
        ).optional()?;
        let (id, revision, head, count) = meta.ok_or(MemoryError::InvalidScope)?;
        if head.as_deref() != scope.head_turn_id
            || count != scope.visible_turn_ids.len() as u64
            || scope.visible_turn_ids.last().map(String::as_str) != scope.head_turn_id
        {
            return Err(MemoryError::InvalidScope);
        }
        let mut statement = self.connection.prepare("SELECT turn_id,parent_turn_id,sequence,elapsed_seconds FROM memory_turns WHERE scope_id=?1 ORDER BY sequence")?;
        let mut rows = statement.query([id])?;
        let mut previous: Option<String> = None;
        let mut last_time = 0;
        for (index, expected) in scope.visible_turn_ids.iter().enumerate() {
            if !valid_id(expected, 128) {
                return Err(MemoryError::InvalidScope);
            }
            let row = rows.next()?.ok_or(MemoryError::InvalidScope)?;
            let actual: String = row.get(0)?;
            let parent: Option<String> = row.get(1)?;
            let sequence = read_u64(row, 2)?;
            last_time = read_u64(row, 3)?;
            if actual != *expected || parent != previous || sequence != index as u64 + 1 {
                return Err(MemoryError::InvalidScope);
            }
            previous = Some(actual);
        }
        if rows.next()?.is_some() || last_time != current_time {
            return Err(MemoryError::InvalidScope);
        }
        Ok((id, revision))
    }
}

fn valid_id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn read_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn valid_text(value: &str, max: usize, empty: bool) -> bool {
    value.len() <= max
        && (empty || !value.trim().is_empty())
        && !value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\r' | '\n' | '\t'))
}

fn validate_scope_ids(world: &str, branch: &str, head: Option<&str>) -> Result<(), MemoryError> {
    if !valid_id(world, 128)
        || world.len() < 8
        || !valid_id(branch, 128)
        || head.is_some_and(|head| !valid_id(head, 128))
    {
        return Err(MemoryError::InvalidScope);
    }
    Ok(())
}

fn validate_record(record: &MemoryTurnInput<'_>) -> Result<(), MemoryError> {
    let turn = record.turn.as_ref();
    if !valid_id(&turn.turn_id, 128)
        || !valid_id(record.origin_branch_id.as_ref(), 128)
        || turn
            .parent_turn_id
            .as_ref()
            .is_some_and(|id| !valid_id(id, 128))
    {
        return Err(MemoryError::InvalidInput);
    }
    if turn.narrative.len() > MAX_NARRATIVE_BYTES {
        return Err(MemoryError::TooLarge);
    }
    if !valid_text(&turn.narrative, MAX_NARRATIVE_BYTES, false) {
        return Err(MemoryError::InvalidInput);
    }
    validate_state_v2(&turn.state).map_err(|_| MemoryError::InvalidInput)
}

fn validate_query(query: &MemoryQuery) -> Result<(), MemoryError> {
    if query.query.len() > MAX_MEMORY_QUERY_BYTES
        || query.entity_ids.len() > MAX_ENTITIES
        || query.tags.len() > MAX_MEMORY_TAGS
        || query.max_results > MAX_MEMORY_RESULTS
    {
        return Err(MemoryError::TooLarge);
    }
    if query.max_results == 0
        || !valid_text(&query.query, MAX_MEMORY_QUERY_BYTES, true)
        || query.entity_ids.iter().any(|id| !valid_id(id, 64))
        || query.tags.iter().any(|tag| !valid_id(tag, 64))
        || query.min_elapsed_seconds.unwrap_or(0)
            > query.max_elapsed_seconds.unwrap_or(MAX_ELAPSED_SECONDS)
        || query
            .max_elapsed_seconds
            .is_some_and(|max| max > MAX_ELAPSED_SECONDS)
    {
        return Err(MemoryError::InvalidInput);
    }
    Ok(())
}

fn validate_identities(
    state: &WorldStateV2,
    identities: &[MemoryKnownIdentity],
) -> Result<BTreeSet<String>, MemoryError> {
    if identities.len() > MAX_ENTITIES {
        return Err(MemoryError::TooLarge);
    }
    let state_ids: BTreeSet<&str> = state.entities.iter().map(|e| e.id.as_str()).collect();
    let mut ids = BTreeSet::new();
    for identity in identities {
        if !valid_id(&identity.entity_id, 64)
            || !state_ids.contains(identity.entity_id.as_str())
            || !ids.insert(identity.entity_id.clone())
            || identity.names.len() > 33
            || identity
                .names
                .iter()
                .any(|n| !valid_text(n, 256, false) || n.chars().any(char::is_control))
        {
            return Err(MemoryError::InvalidInput);
        }
    }
    Ok(ids)
}

fn resolve_query_names(
    text: &str,
    identities: &[MemoryKnownIdentity],
) -> (Vec<BTreeSet<String>>, String) {
    let mut names: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for identity in identities {
        for name in &identity.names {
            if !name.is_empty() && (text == name || name.chars().count() >= 2) {
                names.entry(name).or_default().insert(&identity.entity_id);
            }
        }
    }
    let mut spans = Vec::new();
    for name in names.keys() {
        spans.extend(
            text.match_indices(name)
                .map(|(start, _)| (start, start + name.len(), *name)),
        );
    }
    spans.sort_by_key(|(start, end, _)| (*start, std::cmp::Reverse(*end)));
    let mut groups = Vec::new();
    let mut topic = String::new();
    let mut copied_until = 0;
    for (start, end, name) in spans {
        if start < copied_until {
            continue;
        }
        topic.push_str(&text[copied_until..start]);
        let candidates = names[name].iter().map(|id| (*id).to_owned()).collect();
        if !groups.contains(&candidates) {
            groups.push(candidates);
        }
        copied_until = end;
    }
    topic.push_str(&text[copied_until..]);
    (groups, topic)
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn query_fingerprint(
    scope: &MemoryScope<'_>,
    query: &MemoryQuery,
    state: &WorldStateV2,
    identities: &[MemoryKnownIdentity],
) -> Result<String, MemoryError> {
    let mut without_cursor = query.clone();
    without_cursor.cursor = None;
    let bytes = serde_json::to_vec(&(
        MEMORY_QUERY_VERSION,
        scope.world_id,
        scope.branch_id,
        scope.head_turn_id,
        scope.visible_turn_ids,
        without_cursor,
        state,
        identities,
    ))
    .map_err(|_| MemoryError::InvalidInput)?;
    Ok(hash_bytes(&bytes))
}

fn source_this_turn(source: &StateSource, turn_id: &str) -> bool {
    matches!(source, StateSource::Turn { turn_id: id, .. } | StateSource::LegacySnapshot { turn_id: Some(id), .. } if id == turn_id)
}

fn player_observed(state: &WorldStateV2, fact: &FactKey, source: &StateSource) -> bool {
    state.fact_observations.iter().any(|observation| {
        observation.actor_id == state.protagonist_id
            && observation.fact_key == *fact
            && observation.fact_source == *source
    })
}

type RecordMetadata = (
    BTreeSet<String>,
    BTreeSet<&'static str>,
    BTreeMap<String, BTreeSet<String>>,
);

fn record_metadata(turn: &CommittedTurnV2) -> RecordMetadata {
    let state = &turn.state;
    let mut entities = BTreeSet::new();
    let mut tags = BTreeSet::new();
    let mut names: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut known_names = BTreeSet::new();
    for entity in &state.entities {
        // Keep collision counts for all entities, but permit lexical ID links
        // only for names formally known to the protagonist. An unknown global
        // alias is never an extra index key, even if the caller later knows ID.
        let initial_name = matches!(
            entity.name_source,
            StateSource::Initial | StateSource::LegacySnapshot { .. }
        ) && (entity.id == state.protagonist_id
            || entity.id == "travel-bag"
            || entity.id == state.location_id);
        if initial_name
            || player_observed(
                state,
                &FactKey::EntityName {
                    entity_id: entity.id.clone(),
                },
                &entity.name_source,
            )
        {
            known_names.insert((entity.name.clone(), entity.id.clone()));
        }
        for alias in &entity.aliases {
            if player_observed(
                state,
                &FactKey::EntityAlias {
                    entity_id: entity.id.clone(),
                    text: alias.text.clone(),
                },
                &alias.source,
            ) {
                known_names.insert((alias.text.clone(), entity.id.clone()));
            }
        }
        for name in std::iter::once(&entity.name).chain(entity.aliases.iter().map(|a| &a.text)) {
            names
                .entry(name.clone())
                .or_default()
                .insert(entity.id.clone());
        }
    }
    names.retain(|name, ids| {
        ids.len() == 1
            && known_names.contains(&(name.clone(), ids.iter().next().expect("one ID").clone()))
    });
    for event in &state.events {
        if source_this_turn(&event.created_source, &turn.turn_id)
            && player_observed(
                state,
                &FactKey::Event {
                    event_id: event.id.clone(),
                },
                &event.created_source,
            )
        {
            entities.extend(event.entity_ids.iter().cloned());
            tags.insert("event");
        }
    }
    for condition in &state.conditions {
        // Tags are literal narrative cues, never a disclosure of an NPC's
        // global condition. Their presence does not establish a medical fact.
        let cue = match condition.category {
            ConditionCategory::Injury => turn.narrative.contains('伤'),
            ConditionCategory::Illness => turn.narrative.contains('病'),
            ConditionCategory::Obligation => {
                turn.narrative.contains('欠')
                    || turn.narrative.contains('债')
                    || turn.narrative.contains('诺')
            }
            ConditionCategory::Other | ConditionCategory::LegacyUnspecified => {
                turn.narrative.contains(&condition.description)
            }
        };
        if source_this_turn(&condition.last_changed_source, &turn.turn_id) && cue {
            if condition.entity_id == state.protagonist_id
                || player_observed(
                    state,
                    &FactKey::Condition {
                        condition_id: condition.id.clone(),
                    },
                    &condition.last_changed_source,
                )
            {
                entities.insert(condition.entity_id.clone());
            }
            tags.insert("condition");
            tags.insert(match condition.category {
                ConditionCategory::Injury => "injury",
                ConditionCategory::Illness => "illness",
                ConditionCategory::Obligation => "obligation",
                ConditionCategory::Other => "other_condition",
                ConditionCategory::LegacyUnspecified => "legacy_condition",
            });
        }
    }
    for item in &state.item_holdings {
        if source_this_turn(&item.source, &turn.turn_id) {
            if player_observed(
                state,
                &FactKey::ItemHolding {
                    item_id: item.item_id.clone(),
                },
                &item.source,
            ) {
                entities.insert(item.item_id.clone());
                entities.extend(item.value.holder_id.iter().cloned());
                entities.extend(item.value.place_id.iter().cloned());
            }
            if ["钥匙", "物品", "行囊", "口粮"]
                .iter()
                .any(|cue| turn.narrative.contains(cue))
            {
                tags.insert("item");
            }
        }
    }
    for resource in &state.resources {
        if source_this_turn(&resource.last_changed_source, &turn.turn_id) {
            if player_observed(
                state,
                &FactKey::Resource {
                    owner_id: resource.owner_id.clone(),
                    key: resource.key.clone(),
                },
                &resource.last_changed_source,
            ) {
                entities.insert(resource.owner_id.clone());
            }
            if ["钱", "资产", "资金"]
                .iter()
                .any(|cue| turn.narrative.contains(cue))
            {
                tags.insert("resource");
            }
        }
    }
    for relationship in &state.relationships {
        if source_this_turn(&relationship.last_changed_source, &turn.turn_id) {
            if player_observed(
                state,
                &FactKey::Relationship {
                    from_id: relationship.from_id.clone(),
                    to_id: relationship.to_id.clone(),
                    kind: relationship.kind.clone(),
                },
                &relationship.last_changed_source,
            ) {
                entities.insert(relationship.from_id.clone());
                entities.insert(relationship.to_id.clone());
            }
            if ["仇", "朋友", "婚", "关系"]
                .iter()
                .any(|cue| turn.narrative.contains(cue))
            {
                tags.insert("relationship");
            }
        }
    }
    (entities, tags, names)
}

/// Overlapping raw byte ranges preserve Unicode boundaries and recall phrases
/// crossing a chunk edge. Maximum query bytes never exceeds the overlap.
fn fragment_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + MAX_MEMORY_FRAGMENT_BYTES).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        ranges.push((start, end));
        if end == text.len() {
            break;
        }
        start = end.saturating_sub(FRAGMENT_OVERLAP_BYTES);
        while !text.is_char_boundary(start) {
            start -= 1;
        }
    }
    ranges
}

const SCHEMA: &str = "
CREATE TABLE memory_scopes (
 id INTEGER PRIMARY KEY, world_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 head_turn_id TEXT, revision INTEGER NOT NULL, turn_count INTEGER NOT NULL,
 UNIQUE(world_id,branch_id));
CREATE TABLE memory_turns (
 scope_id INTEGER NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
 turn_id TEXT NOT NULL, parent_turn_id TEXT, sequence INTEGER NOT NULL,
 elapsed_seconds INTEGER NOT NULL, narrative_sha256 TEXT NOT NULL,
 origin_branch_id TEXT NOT NULL, PRIMARY KEY(scope_id,turn_id), UNIQUE(scope_id,sequence));
CREATE TABLE memory_fragments (
 id INTEGER PRIMARY KEY, scope_id INTEGER NOT NULL, turn_id TEXT NOT NULL,
 byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, text TEXT NOT NULL,
 FOREIGN KEY(scope_id,turn_id) REFERENCES memory_turns(scope_id,turn_id) ON DELETE CASCADE,
 UNIQUE(scope_id,turn_id,byte_start));
CREATE TABLE memory_entities (
 fragment_id INTEGER NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
 entity_id TEXT NOT NULL, PRIMARY KEY(fragment_id,entity_id));
CREATE INDEX memory_entity_lookup ON memory_entities(entity_id,fragment_id);
CREATE TABLE memory_tags (
 fragment_id INTEGER NOT NULL REFERENCES memory_fragments(id) ON DELETE CASCADE,
 tag TEXT NOT NULL, PRIMARY KEY(fragment_id,tag));
CREATE INDEX memory_tag_lookup ON memory_tags(tag,fragment_id);
CREATE INDEX memory_time_lookup ON memory_turns(scope_id,elapsed_seconds,sequence);
CREATE VIRTUAL TABLE memory_fts USING fts5(text,content='memory_fragments',content_rowid='id',tokenize='trigram');
CREATE TRIGGER memory_fragment_insert AFTER INSERT ON memory_fragments BEGIN
 INSERT INTO memory_fts(rowid,text) VALUES(new.id,new.text); END;
CREATE TRIGGER memory_fragment_delete AFTER DELETE ON memory_fragments BEGIN
 INSERT INTO memory_fts(memory_fts,rowid,text) VALUES('delete',old.id,old.text); END;
";

const TEMP_SCHEMA: &str = "
CREATE TEMP TABLE memory_query_entities(entity_id TEXT PRIMARY KEY);
CREATE TEMP TABLE memory_query_names(group_id INTEGER NOT NULL,entity_id TEXT NOT NULL,PRIMARY KEY(group_id,entity_id));
CREATE TEMP TABLE memory_query_tags(tag TEXT PRIMARY KEY);
";

// Predicate inputs are always bound. Entity/name and short-text fallback do
// not use MATCH, so FTS's <3 Unicode-character limitation cannot lose 李明.
// The scope/time indexes bound fallback to one validated ancestor path.
const RETRIEVE_SQL: &str = "
SELECT f.id,f.text,t.turn_id,t.sequence,t.elapsed_seconds,f.byte_start,f.byte_end,t.narrative_sha256,t.origin_branch_id
FROM memory_turns t JOIN memory_fragments f ON f.scope_id=t.scope_id AND f.turn_id=t.turn_id
WHERE t.scope_id=?1 AND t.elapsed_seconds BETWEEN ?7 AND ?8
 AND (?2=0 OR EXISTS(SELECT 1 FROM memory_entities e JOIN memory_query_entities q ON e.entity_id=q.entity_id WHERE e.fragment_id=f.id))
 AND NOT EXISTS(
  SELECT 1 FROM (SELECT DISTINCT group_id FROM memory_query_names) n
  WHERE NOT EXISTS(SELECT 1 FROM memory_entities e JOIN memory_query_names q ON e.entity_id=q.entity_id
   WHERE e.fragment_id=f.id AND q.group_id=n.group_id))
 AND (?3=0 OR EXISTS(SELECT 1 FROM memory_tags g JOIN memory_query_tags q ON g.tag=q.tag WHERE g.fragment_id=f.id))
 AND (?4=0 OR ?4=3 OR (?4=1 AND f.id IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?5)) OR (?4=2 AND instr(f.text,?6)>0))
 AND (?9=0 OR t.sequence<?10 OR (t.sequence=?10 AND f.byte_start>?11))
ORDER BY t.sequence DESC,f.byte_start ASC LIMIT ?12";

#[cfg(test)]
mod query_tests {
    use super::*;

    #[test]
    fn longer_overlapping_names_resolve_only_their_ids_and_preserve_the_topic() {
        let known = [
            MemoryKnownIdentity {
                entity_id: "first".into(),
                names: vec!["李明".into()],
            },
            MemoryKnownIdentity {
                entity_id: "second".into(),
                names: vec!["李明".into(), "李明甲".into()],
            },
        ];
        let (selected, topic) = resolve_query_names("李明甲欠债", &known);
        assert_eq!(selected, vec![BTreeSet::from(["second".into()])]);
        assert_eq!(topic, "欠债");
        let (selected, topic) = resolve_query_names("李明", &known);
        assert_eq!(
            selected,
            vec![BTreeSet::from(["first".into(), "second".into()])]
        );
        assert!(topic.is_empty());
        let (selected, topic) = resolve_query_names("夜鸦欠债", &known);
        assert!(selected.is_empty());
        assert_eq!(topic, "夜鸦欠债");
    }

    #[test]
    fn distinct_words_keep_and_groups_while_one_ambiguous_name_keeps_or_candidates() {
        let known = [
            MemoryKnownIdentity {
                entity_id: "first".into(),
                names: vec!["李明".into(), "李安".into()],
            },
            MemoryKnownIdentity {
                entity_id: "second".into(),
                names: vec!["李明".into()],
            },
            MemoryKnownIdentity {
                entity_id: "key".into(),
                names: vec!["钥匙".into()],
            },
        ];
        let (groups, topic) = resolve_query_names("李明钥匙青石", &known);
        assert_eq!(
            groups,
            vec![
                BTreeSet::from(["first".into(), "second".into()]),
                BTreeSet::from(["key".into()])
            ]
        );
        assert_eq!(topic, "青石");
        let (groups, topic) = resolve_query_names("李安李安钥匙", &known);
        assert_eq!(
            groups,
            vec![
                BTreeSet::from(["first".into()]),
                BTreeSet::from(["key".into()])
            ]
        );
        assert!(topic.is_empty());
    }
}
