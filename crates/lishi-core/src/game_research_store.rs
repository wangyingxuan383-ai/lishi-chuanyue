//! Research-only sidecar. Immutable shared evidence and branch-local adoption
//! are independent of authoritative game state and annotations' sequence.
//! Scope paths/watermarks must come from the trusted branch store, not the UI.

use crate::{
    game_context::ContextScope,
    game_knowledge::ValidatedHistory,
    game_research::{
        hash, id, now_ms, BraveResearchConfig, ResearchConclusion, ResearchDiagnostics,
        ResearchError, ResearchOperationStatus, ResearchProvider, ResearchQuery, ResearchResult,
        ResearchSearchOutcome, ResearchSource, MAX_RESEARCH_RESULTS,
    },
    secrets::SecretValue,
    CancellationToken,
};
use rusqlite::{
    params, types::ValueRef, Connection, OpenFlags, OptionalExtension, TransactionBehavior,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fmt,
    fs::{File, TryLockError},
    path::Path,
    sync::{Mutex, MutexGuard},
};

const APPLICATION_ID: i32 = 0x4c525343;
const SCHEMA_VERSION: i32 = 1;
const MAX_RECORD_BYTES: usize = 1024 * 1024;
const MAX_RECORDS: usize = 10_000;
const MAX_ADOPTIONS_PER_WORLD: usize = 4096;
const WORLD_RESEARCH_BUNDLE_VERSION: u32 = 1;

/// Portable frozen evidence for one world. Provider configuration, secret slots,
/// search attempts, shared cache records and other worlds are never included.
/// Restore into a dedicated empty sidecar so global change sequences stay exact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldResearchBundle {
    pub version: u32,
    pub world_id: String,
    pub watermark: u64,
    pub adoptions: Vec<ResearchAdoption>,
}
impl WorldResearchBundle {
    pub fn validate(&self) -> ResearchResult<()> {
        if self.version != WORLD_RESEARCH_BUNDLE_VERSION
            || !id(&self.world_id)
            || self.watermark > i64::MAX as u64
            || self.adoptions.len() > MAX_ADOPTIONS_PER_WORLD
        {
            return Err(ResearchError::InvalidInput);
        }
        let mut ids = BTreeSet::new();
        let mut previous = 0;
        let mut encoded_bytes = 0usize;
        for adoption in &self.adoptions {
            adoption.validate()?;
            if adoption.world_id != self.world_id
                || !ids.insert(&adoption.id)
                || adoption.change_seq <= previous
                || adoption.change_seq > self.watermark
            {
                return Err(ResearchError::InvalidInput);
            }
            encoded_bytes = encoded_bytes
                .checked_add(encode(adoption)?.len())
                .filter(|size| *size <= 64 * 1024 * 1024)
                .ok_or(ResearchError::TooLarge)?;
            previous = adoption.change_seq;
        }
        Ok(())
    }

    /// Inputs must be the complete, core-validated histories for every branch,
    /// including archived branches, rather than a recent UI history window.
    pub fn validate_scopes(
        &self,
        branches: &[(&ResearchScope, &ValidatedHistory)],
    ) -> ResearchResult<()> {
        self.validate()?;
        let mut ids = BTreeSet::new();
        for (scope, history) in branches {
            scope.validate(history)?;
            if scope.context.world_id != self.world_id
                || !ids.insert(&scope.context.branch_id)
                || scope.branch_path.iter().any(|access| {
                    access
                        .through_change_seq
                        .is_some_and(|watermark| watermark > self.watermark)
                })
            {
                return Err(ResearchError::InvalidScope);
            }
        }
        for adoption in &self.adoptions {
            let (_, history) = branches
                .iter()
                .find(|(scope, _)| scope.context.branch_id == adoption.origin_branch_id)
                .ok_or(ResearchError::InvalidScope)?;
            if adoption
                .head_turn_id
                .as_deref()
                .is_some_and(|head| !history.contains_turn(head))
            {
                return Err(ResearchError::InvisibleSource);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResearchBranchAccess {
    pub branch_id: String,
    pub through_turn_id: Option<String>,
    /// Only research_store.watermark(). An annotation sequence is invalid for
    /// this domain even when its integer happens to be equal.
    pub through_change_seq: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResearchScope {
    pub context: ContextScope,
    pub branch_path: Vec<ResearchBranchAccess>,
}
impl ResearchScope {
    pub fn single(context: ContextScope) -> Self {
        Self {
            branch_path: vec![ResearchBranchAccess {
                branch_id: context.branch_id.clone(),
                through_turn_id: context.head_turn_id.clone(),
                through_change_seq: None,
            }],
            context,
        }
    }
    pub fn validate(&self, history: &ValidatedHistory) -> ResearchResult<()> {
        if self.context.world_id != history.world_id()
            || self.context.head_turn_id.as_deref() != history.head_turn_id()
            || !id(&self.context.world_id)
            || !id(&self.context.branch_id)
            || self.branch_path.is_empty()
            || self.branch_path.len() > 128
            || self
                .branch_path
                .last()
                .map(|v| (&v.branch_id, &v.through_turn_id, v.through_change_seq))
                != Some((&self.context.branch_id, &self.context.head_turn_id, None))
        {
            return Err(ResearchError::InvalidScope);
        }
        let mut branches = BTreeSet::new();
        let mut previous = 0;
        for (position, access) in self.branch_path.iter().enumerate() {
            if !id(&access.branch_id)
                || !branches.insert(&access.branch_id)
                || (position + 1 < self.branch_path.len() && access.through_change_seq.is_none())
                || access
                    .through_change_seq
                    .is_some_and(|v| v > i64::MAX as u64)
            {
                return Err(ResearchError::InvalidScope);
            }
            let through = access
                .through_turn_id
                .as_deref()
                .map(|turn| {
                    history
                        .turn_position(turn)
                        .ok_or(ResearchError::InvisibleSource)
                })
                .transpose()?
                .unwrap_or(0);
            if through < previous {
                return Err(ResearchError::InvalidScope);
            }
            previous = through;
        }
        Ok(())
    }
    fn sees(&self, history: &ValidatedHistory, adoption: &ResearchAdoption) -> bool {
        if adoption.world_id != self.context.world_id {
            return false;
        }
        let Some(access) = self
            .branch_path
            .iter()
            .find(|access| access.branch_id == adoption.origin_branch_id)
        else {
            return false;
        };
        if access
            .through_change_seq
            .is_some_and(|watermark| adoption.change_seq > watermark)
        {
            return false;
        }
        let through = access
            .through_turn_id
            .as_deref()
            .and_then(|turn| history.turn_position(turn))
            .unwrap_or(0);
        match &adoption.head_turn_id {
            None => true,
            Some(turn) => history
                .turn_position(turn)
                .is_some_and(|position| position <= through),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchRecord {
    pub id: String,
    pub cache_key: String,
    pub provider_namespace: String,
    pub query: ResearchQuery,
    pub sources: Vec<ResearchSource>,
    pub conclusions: Vec<ResearchConclusion>,
    pub created_at_ms: i64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredResearchConfig {
    pub config: BraveResearchConfig,
    pub secret_slot: Option<String>,
    pub revision: u64,
}
impl ResearchRecord {
    pub fn validate(&self) -> ResearchResult<()> {
        self.query.validate()?;
        if !id(&self.id)
            || !id(&self.provider_namespace)
            || self.cache_key != self.query.cache_key(&self.provider_namespace)?
            || self.sources.len() > MAX_RESEARCH_RESULTS
            || self.conclusions.len() > 128
            || self.created_at_ms < 0
        {
            return Err(ResearchError::InvalidInput);
        }
        let mut ids = BTreeSet::new();
        let mut urls = BTreeSet::new();
        for source in &self.sources {
            source.validate()?;
            if !ids.insert(source.id.as_str()) || !urls.insert(&source.url) {
                return Err(ResearchError::InvalidInput);
            }
        }
        let mut conclusions = BTreeSet::new();
        for conclusion in &self.conclusions {
            conclusion.validate()?;
            if !conclusions.insert(&conclusion.id)
                || conclusion
                    .source_ids
                    .iter()
                    .any(|source| !ids.contains(source.as_str()))
            {
                return Err(ResearchError::InvalidInput);
            }
        }
        if self.conclusions.iter().any(|conclusion| {
            conclusion
                .conflicts_with
                .iter()
                .any(|other| !conclusions.contains(other))
        }) {
            return Err(ResearchError::InvalidInput);
        }
        Ok(())
    }
    /// Inert JSON for a bounded data area; never concatenate as system rules.
    pub fn evidence_json(&self) -> ResearchResult<String> {
        self.validate()?;
        encode(self)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchOperation {
    pub operation_id: String,
    pub cache_key: String,
    pub status: ResearchOperationStatus,
    pub search_slots_used: u8,
    pub diagnostics: ResearchDiagnostics,
    /// A process may die after reservation/send but before outcome persistence.
    /// In that case the reserved slot is spent and HTTP count remains unknown.
    pub http_attempts_known: bool,
    pub created_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    pub record_id: Option<String>,
}
impl ResearchOperation {
    fn validate(&self) -> ResearchResult<()> {
        let terminal = matches!(
            self.status,
            ResearchOperationStatus::Succeeded
                | ResearchOperationStatus::Failed
                | ResearchOperationStatus::Cancelled
                | ResearchOperationStatus::Interrupted
        );
        if !id(&self.operation_id)
            || self.cache_key.len() != 64
            || !self
                .cache_key
                .bytes()
                .all(|v| v.is_ascii_digit() || matches!(v, b'a'..=b'f'))
            || self.search_slots_used > 1
            || self.diagnostics.http_attempts > self.search_slots_used
            || self.created_at_ms < 0
            || self.finished_at_ms.is_some_and(|v| v < self.created_at_ms)
            || terminal != self.finished_at_ms.is_some()
            || self.record_id.as_ref().is_some_and(|v| !id(v))
            || (self.status == ResearchOperationStatus::Succeeded) != self.record_id.is_some()
            || (self.status == ResearchOperationStatus::Pending && self.search_slots_used != 0)
            || (self.status == ResearchOperationStatus::Running && self.search_slots_used != 1)
            || (self.status == ResearchOperationStatus::Pending && !self.http_attempts_known)
            || (self.status == ResearchOperationStatus::Succeeded && !self.http_attempts_known)
        {
            return Err(ResearchError::Database);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchAdoption {
    pub id: String,
    pub world_id: String,
    pub origin_branch_id: String,
    pub head_turn_id: Option<String>,
    pub record_id: String,
    pub source_ids: Vec<String>,
    /// Selected evidence and interpretation revision frozen at adoption time.
    pub evidence: ResearchRecord,
    pub change_seq: u64,
    pub created_at_ms: i64,
}
impl ResearchAdoption {
    fn validate(&self) -> ResearchResult<()> {
        if !id(&self.id)
            || !id(&self.world_id)
            || !id(&self.origin_branch_id)
            || self.head_turn_id.as_ref().is_some_and(|v| !id(v))
            || !id(&self.record_id)
            || self.source_ids.is_empty()
            || self.source_ids.len() > MAX_RESEARCH_RESULTS
            || self.source_ids.iter().any(|v| !id(v))
            || self.source_ids.iter().collect::<BTreeSet<_>>().len() != self.source_ids.len()
            || self.change_seq == 0
            || self.change_seq > i64::MAX as u64
            || self.created_at_ms < 0
            || self.evidence.id != self.record_id
            || self
                .evidence
                .sources
                .iter()
                .map(|source| &source.id)
                .collect::<BTreeSet<_>>()
                != self.source_ids.iter().collect::<BTreeSet<_>>()
        {
            Err(ResearchError::Database)
        } else {
            self.evidence
                .validate()
                .map_err(|_| ResearchError::Database)
        }
    }
}

pub struct ResearchStore {
    connection: Mutex<Connection>,
    _owner_lock: File,
}
impl fmt::Debug for ResearchStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ResearchStore { independent_evidence_sidecar: true }")
    }
}
impl From<rusqlite::Error> for ResearchError {
    fn from(value: rusqlite::Error) -> Self {
        if matches!(value,rusqlite::Error::SqliteFailure(ref detail,_) if matches!(detail.code,rusqlite::ErrorCode::DatabaseBusy|rusqlite::ErrorCode::DatabaseLocked))
        {
            Self::Busy
        } else {
            Self::Database
        }
    }
}
fn encode(value: &impl Serialize) -> ResearchResult<String> {
    let json = serde_json::to_string(value).map_err(|_| ResearchError::InvalidInput)?;
    if json.len() > MAX_RECORD_BYTES {
        Err(ResearchError::TooLarge)
    } else {
        Ok(json)
    }
}
fn decode<T: DeserializeOwned>(json: &str) -> ResearchResult<T> {
    if json.len() > MAX_RECORD_BYTES {
        return Err(ResearchError::Database);
    }
    serde_json::from_str(json).map_err(|_| ResearchError::Database)
}
fn bounded_json(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<String> {
    match row.get_ref(column)? {
        ValueRef::Text(bytes) if bytes.len() <= MAX_RECORD_BYTES => std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| rusqlite::Error::InvalidQuery),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
fn operation(
    connection: &Connection,
    operation_id: &str,
) -> ResearchResult<Option<ResearchOperation>> {
    let json = connection
        .query_row(
            "SELECT record FROM research_operations WHERE operation_id=?1",
            [operation_id],
            |row| bounded_json(row, 0),
        )
        .optional()?;
    json.map(|json| {
        let operation: ResearchOperation = decode(&json)?;
        operation.validate()?;
        if operation.operation_id != operation_id {
            return Err(ResearchError::Database);
        }
        Ok(operation)
    })
    .transpose()
}
fn save_operation(connection: &Connection, value: &ResearchOperation) -> ResearchResult<()> {
    value.validate()?;
    connection.execute(
        "UPDATE research_operations SET record=?1 WHERE operation_id=?2",
        params![encode(value)?, value.operation_id],
    )?;
    Ok(())
}
fn record(connection: &Connection, record_id: &str) -> ResearchResult<Option<ResearchRecord>> {
    let row = connection
        .query_row(
            "SELECT cache_key,record FROM research_records WHERE id=?1",
            [record_id],
            |row| Ok((row.get::<_, String>(0)?, bounded_json(row, 1)?)),
        )
        .optional()?;
    row.map(|(key, json)| {
        let mut record: ResearchRecord = decode(&json)?;
        if record.id != record_id || record.cache_key != key || !record.conclusions.is_empty() {
            return Err(ResearchError::Database);
        }
        let mut statements = connection.prepare(
            "SELECT record FROM research_conclusions WHERE record_id=?1 ORDER BY sequence",
        )?;
        let rows = statements.query_map([record_id], |row| bounded_json(row, 0))?;
        for row in rows {
            if record.conclusions.len() >= 128 {
                return Err(ResearchError::Database);
            }
            record.conclusions.push(decode(&row?)?);
        }
        record.validate().map_err(|_| ResearchError::Database)?;
        Ok(record)
    })
    .transpose()
}
fn schema_rows(connection: &Connection) -> ResearchResult<Vec<(String, String, String)>> {
    let mut statement = connection.prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
fn identity(connection: &Connection) -> ResearchResult<bool> {
    let app: i32 = connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    let version: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let objects = schema_rows(connection)?;
    if app == 0 && version == 0 && objects.is_empty() {
        return Ok(false);
    }
    if app != APPLICATION_ID || version != SCHEMA_VERSION {
        return Err(ResearchError::IncompatibleDatabase);
    }
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(SCHEMA)?;
    if objects != schema_rows(&expected)? {
        return Err(ResearchError::IncompatibleDatabase);
    }
    Ok(true)
}
fn config_revision(connection: &Connection) -> ResearchResult<u64> {
    let value: i64 = connection.query_row(
        "SELECT revision FROM research_config_meta WHERE singleton=1",
        [],
        |row| row.get(0),
    )?;
    u64::try_from(value)
        .ok()
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or(ResearchError::Database)
}
fn advance_config_revision(connection: &Connection, expected: u64) -> ResearchResult<u64> {
    if config_revision(connection)? != expected {
        return Err(ResearchError::Conflict);
    }
    let revision = expected
        .checked_add(1)
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or(ResearchError::TooLarge)?;
    connection.execute(
        "UPDATE research_config_meta SET revision=?1 WHERE singleton=1",
        [revision as i64],
    )?;
    Ok(revision)
}
fn freeze_evidence(
    mut record: ResearchRecord,
    source_ids: &[String],
) -> ResearchResult<ResearchRecord> {
    let selected = source_ids.iter().collect::<BTreeSet<_>>();
    record
        .sources
        .retain(|source| selected.contains(&source.id));
    record.conclusions.retain(|conclusion| {
        conclusion
            .source_ids
            .iter()
            .all(|source| selected.contains(source))
    });
    // Exclude a dependent interpretation as a whole when a conflicting claim
    // is not selected; never rewrite its provenance to hide the conflict.
    loop {
        let ids = record
            .conclusions
            .iter()
            .map(|conclusion| conclusion.id.clone())
            .collect::<BTreeSet<_>>();
        let before = record.conclusions.len();
        record
            .conclusions
            .retain(|conclusion| conclusion.conflicts_with.iter().all(|id| ids.contains(id)));
        if before == record.conclusions.len() {
            break;
        }
    }
    record.validate()?;
    Ok(record)
}
fn adoption_watermark(connection: &Connection) -> ResearchResult<u64> {
    let (maximum, sequence): (i64, i64) = connection.query_row(
        "SELECT (SELECT COALESCE(MAX(change_seq),0) FROM research_adoptions),COALESCE((SELECT seq FROM sqlite_sequence WHERE name='research_adoptions'),0)",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if maximum < 0 || sequence < maximum {
        return Err(ResearchError::Database);
    }
    u64::try_from(sequence).map_err(|_| ResearchError::Database)
}
fn adopt_record_in_transaction(
    tx: &Connection,
    scope: &ResearchScope,
    history: &ValidatedHistory,
    adoption_id: &str,
    cache: ResearchRecord,
    source_ids: &[String],
) -> ResearchResult<ResearchAdoption> {
    scope.validate(history)?;
    cache.validate()?;
    if !id(adoption_id)
        || source_ids.is_empty()
        || source_ids.len() > MAX_RESEARCH_RESULTS
        || source_ids.iter().any(|source| !id(source))
        || source_ids.iter().collect::<BTreeSet<_>>().len() != source_ids.len()
    {
        return Err(ResearchError::InvalidInput);
    }
    if source_ids
        .iter()
        .any(|id| !cache.sources.iter().any(|source| &source.id == id))
    {
        return Err(ResearchError::InvisibleSource);
    }
    let previous: Option<String> = tx
        .query_row(
            "SELECT record FROM research_adoptions WHERE id=?1",
            [adoption_id],
            |row| bounded_json(row, 0),
        )
        .optional()?;
    if let Some(json) = previous {
        let previous: ResearchAdoption = decode(&json)?;
        previous.validate()?;
        if previous.world_id != scope.context.world_id
            || previous.origin_branch_id != scope.context.branch_id
            || previous.head_turn_id != scope.context.head_turn_id
            || previous.record_id != cache.id
            || previous.source_ids != source_ids
        {
            return Err(ResearchError::Conflict);
        }
        // An idempotent retry preserves its original interpretation revision,
        // even when the shared cache gained conclusions since the first call.
        return Ok(previous);
    }
    let count: i64 = tx.query_row(
        "SELECT count(*) FROM research_adoptions WHERE world_id=?1",
        [&scope.context.world_id],
        |row| row.get(0),
    )?;
    if count >= MAX_ADOPTIONS_PER_WORLD as i64 {
        return Err(ResearchError::TooLarge);
    }
    adoption_watermark(tx)?;
    tx.execute(
        "INSERT INTO research_adoptions(id,world_id,record) VALUES(?1,?2,'{}')",
        params![adoption_id, scope.context.world_id],
    )?;
    let change_seq = tx.last_insert_rowid() as u64;
    let value = ResearchAdoption {
        id: adoption_id.into(),
        world_id: scope.context.world_id.clone(),
        origin_branch_id: scope.context.branch_id.clone(),
        head_turn_id: scope.context.head_turn_id.clone(),
        record_id: cache.id.clone(),
        source_ids: source_ids.to_vec(),
        evidence: freeze_evidence(cache, source_ids)?,
        change_seq,
        created_at_ms: now_ms()?,
    };
    value.validate()?;
    tx.execute(
        "UPDATE research_adoptions SET record=?1 WHERE change_seq=?2",
        params![encode(&value)?, change_seq as i64],
    )?;
    Ok(value)
}
impl ResearchStore {
    pub fn open_sidecar(path: impl AsRef<Path>) -> ResearchResult<Self> {
        let path = path.as_ref();
        if path.exists() {
            let read = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|_| ResearchError::Unavailable)?;
            identity(&read)?;
        }
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".research-owner-lock");
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(Path::new(&lock_path))
            .map_err(|_| ResearchError::Unavailable)?;
        lock.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => ResearchError::Busy,
            TryLockError::Error(_) => ResearchError::Unavailable,
        })?;
        let mut connection = Connection::open(path)?;
        let existing = identity(&connection)?;
        connection.busy_timeout(std::time::Duration::from_millis(200))?;
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;",
        )?;
        if !existing {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(SCHEMA)?;
            tx.pragma_update(None, "application_id", APPLICATION_ID)?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            tx.commit()?;
        }
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operations = {
            let mut statement = tx.prepare("SELECT record FROM research_operations")?;
            let rows = statement.query_map([], |row| bounded_json(row, 0))?;
            rows.map(|row| decode::<ResearchOperation>(&row?))
                .collect::<ResearchResult<Vec<_>>>()?
        };
        for mut value in operations {
            value.validate()?;
            if matches!(
                value.status,
                ResearchOperationStatus::Pending | ResearchOperationStatus::Running
            ) {
                value.status = ResearchOperationStatus::Interrupted;
                value.finished_at_ms = Some(now_ms()?.max(value.created_at_ms));
                save_operation(&tx, &value)?;
            }
        }
        tx.commit()?;
        Ok(Self {
            connection: Mutex::new(connection),
            _owner_lock: lock,
        })
    }
    fn connection(&self) -> ResearchResult<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| ResearchError::Unavailable)
    }
    pub fn begin(
        &self,
        operation_id: &str,
        query: &ResearchQuery,
        namespace: &str,
    ) -> ResearchResult<ResearchOperation> {
        if !id(operation_id) || operation_id.len() < 8 || !id(namespace) {
            return Err(ResearchError::InvalidInput);
        }
        let key = query.cache_key(namespace)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if operation(&tx, operation_id)?.is_some() {
            return Err(ResearchError::DuplicateOperation);
        }
        let count: i64 = tx.query_row("SELECT count(*) FROM research_operations", [], |row| {
            row.get(0)
        })?;
        if count >= MAX_RECORDS as i64 {
            return Err(ResearchError::TooLarge);
        }
        let value = ResearchOperation {
            operation_id: operation_id.into(),
            cache_key: key,
            status: ResearchOperationStatus::Pending,
            search_slots_used: 0,
            diagnostics: ResearchDiagnostics {
                http_attempts: 0,
                http_status: None,
                elapsed_ms: 0,
                error: None,
            },
            http_attempts_known: true,
            created_at_ms: now_ms()?,
            finished_at_ms: None,
            record_id: None,
        };
        value.validate()?;
        tx.execute(
            "INSERT INTO research_operations(operation_id,record) VALUES(?1,?2)",
            params![operation_id, encode(&value)?],
        )?;
        tx.commit()?;
        Ok(value)
    }
    pub fn reserve_search(&self, operation_id: &str) -> ResearchResult<ResearchOperation> {
        if !id(operation_id) || operation_id.len() < 8 {
            return Err(ResearchError::InvalidInput);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut value = operation(&tx, operation_id)?.ok_or(ResearchError::Missing)?;
        if value.status != ResearchOperationStatus::Pending || value.search_slots_used != 0 {
            return Err(ResearchError::InvalidTransition);
        }
        value.status = ResearchOperationStatus::Running;
        value.search_slots_used = 1;
        value.http_attempts_known = false;
        save_operation(&tx, &value)?;
        tx.commit()?;
        Ok(value)
    }
    pub fn finish_search(
        &self,
        operation_id: &str,
        query: &ResearchQuery,
        namespace: &str,
        outcome: &ResearchSearchOutcome,
    ) -> ResearchResult<ResearchOperation> {
        if !id(operation_id) || operation_id.len() < 8 {
            return Err(ResearchError::InvalidInput);
        }
        outcome.validate()?;
        let key = query.cache_key(namespace)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut value = operation(&tx, operation_id)?.ok_or(ResearchError::Missing)?;
        if value.cache_key != key || value.search_slots_used != 1 {
            return Err(ResearchError::InvalidTransition);
        }
        if value.status == ResearchOperationStatus::Cancelled {
            value.diagnostics.http_attempts = value
                .diagnostics
                .http_attempts
                .max(outcome.diagnostics.http_attempts);
            value.diagnostics.http_status = outcome.diagnostics.http_status;
            value.diagnostics.elapsed_ms = outcome.diagnostics.elapsed_ms;
            value.http_attempts_known = true;
            save_operation(&tx, &value)?;
            tx.commit()?;
            return Ok(value);
        }
        if value.status != ResearchOperationStatus::Running {
            return Err(ResearchError::InvalidTransition);
        }
        value.status = outcome.status;
        value.diagnostics = outcome.diagnostics.clone();
        value.http_attempts_known = true;
        value.finished_at_ms = Some(now_ms()?.max(value.created_at_ms));
        if outcome.status == ResearchOperationStatus::Succeeded {
            let count: i64 = tx.query_row("SELECT count(*) FROM research_records", [], |row| {
                row.get(0)
            })?;
            if count >= MAX_RECORDS as i64 {
                return Err(ResearchError::TooLarge);
            }
            let record = ResearchRecord {
                id: format!("research-{}", hash(operation_id.as_bytes())),
                cache_key: key,
                provider_namespace: namespace.into(),
                query: query.clone(),
                sources: outcome.sources.clone(),
                conclusions: Vec::new(),
                created_at_ms: now_ms()?,
            };
            record.validate()?;
            tx.execute("INSERT INTO research_records(id,cache_key,created_at_ms,active,record) VALUES(?1,?2,?3,1,?4)",params![record.id,record.cache_key,record.created_at_ms,encode(&record)?])?;
            value.record_id = Some(record.id);
        }
        save_operation(&tx, &value)?;
        tx.commit()?;
        Ok(value)
    }
    /// The durable search slot is reserved before sending. Reusing an operation
    /// cannot send again, including after failure, cancellation or process death.
    pub async fn run_search<P: ResearchProvider + ?Sized>(
        &self,
        operation_id: &str,
        query: &ResearchQuery,
        provider: &P,
        credential: Option<SecretValue>,
        cancel: CancellationToken,
    ) -> ResearchResult<ResearchOperation> {
        let namespace = provider.cache_namespace();
        self.begin(operation_id, query, &namespace)?;
        self.reserve_search(operation_id)?;
        let outcome = provider.search(query, credential, cancel).await;
        self.finish_search(operation_id, query, &namespace, &outcome)
    }
    pub fn cancel(&self, operation_id: &str) -> ResearchResult<ResearchOperation> {
        if !id(operation_id) || operation_id.len() < 8 {
            return Err(ResearchError::InvalidInput);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut value = operation(&tx, operation_id)?.ok_or(ResearchError::Missing)?;
        if value.status == ResearchOperationStatus::Cancelled {
            return Ok(value);
        }
        if !matches!(
            value.status,
            ResearchOperationStatus::Pending | ResearchOperationStatus::Running
        ) {
            return Err(ResearchError::InvalidTransition);
        }
        value.status = ResearchOperationStatus::Cancelled;
        value.diagnostics.error = Some(ResearchError::Cancelled);
        value.finished_at_ms = Some(now_ms()?.max(value.created_at_ms));
        save_operation(&tx, &value)?;
        tx.commit()?;
        Ok(value)
    }
    /// A cache hit is still an independent, durable operation. It consumes no
    /// network slot, needs no credential and cannot reuse an operation ID.
    pub fn record_cached_operation(
        &self,
        operation_id: &str,
        query: &ResearchQuery,
        namespace: &str,
        record_id: &str,
    ) -> ResearchResult<ResearchOperation> {
        if !id(operation_id) || operation_id.len() < 8 || !id(namespace) || !id(record_id) {
            return Err(ResearchError::InvalidInput);
        }
        let key = query.cache_key(namespace)?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if operation(&tx, operation_id)?.is_some() {
            return Err(ResearchError::DuplicateOperation);
        }
        let count: i64 = tx.query_row("SELECT count(*) FROM research_operations", [], |row| {
            row.get(0)
        })?;
        if count >= MAX_RECORDS as i64 {
            return Err(ResearchError::TooLarge);
        }
        let cached = record(&tx, record_id)?.ok_or(ResearchError::Missing)?;
        let active: bool = tx.query_row(
            "SELECT active FROM research_records WHERE id=?1",
            [record_id],
            |row| row.get(0),
        )?;
        if !active || cached.cache_key != key || cached.provider_namespace != namespace {
            return Err(ResearchError::InvalidInput);
        }
        let now = now_ms()?;
        let value = ResearchOperation {
            operation_id: operation_id.into(),
            cache_key: key,
            status: ResearchOperationStatus::Succeeded,
            search_slots_used: 0,
            diagnostics: ResearchDiagnostics {
                http_attempts: 0,
                http_status: None,
                elapsed_ms: 0,
                error: None,
            },
            http_attempts_known: true,
            created_at_ms: now,
            finished_at_ms: Some(now),
            record_id: Some(record_id.into()),
        };
        value.validate()?;
        tx.execute(
            "INSERT INTO research_operations(operation_id,record) VALUES(?1,?2)",
            params![operation_id, encode(&value)?],
        )?;
        tx.commit()?;
        Ok(value)
    }
    pub fn operation(&self, operation_id: &str) -> ResearchResult<Option<ResearchOperation>> {
        if !id(operation_id) {
            return Err(ResearchError::InvalidInput);
        }
        let connection = self.connection()?;
        operation(&connection, operation_id)
    }
    pub fn record(&self, record_id: &str) -> ResearchResult<Option<ResearchRecord>> {
        if !id(record_id) {
            return Err(ResearchError::InvalidInput);
        }
        let connection = self.connection()?;
        record(&connection, record_id)
    }
    pub fn cached(
        &self,
        query: &ResearchQuery,
        namespace: &str,
        max_age_ms: u64,
    ) -> ResearchResult<Option<ResearchRecord>> {
        if max_age_ms > 366 * 24 * 60 * 60 * 1000 {
            return Err(ResearchError::InvalidInput);
        }
        let key = query.cache_key(namespace)?;
        let now = now_ms()?;
        let connection = self.connection()?;
        let record_id:Option<String>=connection.query_row("SELECT id FROM research_records WHERE cache_key=?1 AND active=1 AND created_at_ms BETWEEN ?2 AND ?3 ORDER BY sequence DESC LIMIT 1",params![key,now.saturating_sub(max_age_ms as i64),now],|row|row.get(0)).optional()?;
        record_id
            .map(|id| record(&connection, &id)?.ok_or(ResearchError::Database))
            .transpose()
    }
    pub fn invalidate_cache(&self, record_id: &str) -> ResearchResult<()> {
        if !id(record_id) {
            return Err(ResearchError::InvalidInput);
        }
        let connection = self.connection()?;
        if connection.execute(
            "UPDATE research_records SET active=0 WHERE id=?1",
            [record_id],
        )? == 0
        {
            return Err(ResearchError::Missing);
        }
        Ok(())
    }
    /// Append-only competing interpretations; sources and earlier claims remain.
    /// This API is for core-approved/user-reviewed conclusions, not raw web JSON.
    pub fn add_conclusion(
        &self,
        record_id: &str,
        conclusion: &ResearchConclusion,
    ) -> ResearchResult<()> {
        if !id(record_id) {
            return Err(ResearchError::InvalidInput);
        }
        conclusion.validate()?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut existing = record(&tx, record_id)?.ok_or(ResearchError::Missing)?;
        if let Some(previous) = existing
            .conclusions
            .iter()
            .find(|value| value.id == conclusion.id)
        {
            return if previous == conclusion {
                Ok(())
            } else {
                Err(ResearchError::Conflict)
            };
        }
        if existing.conclusions.len() >= 128 {
            return Err(ResearchError::TooLarge);
        }
        existing.conclusions.push(conclusion.clone());
        existing.validate()?;
        tx.execute(
            "INSERT INTO research_conclusions(record_id,id,record) VALUES(?1,?2,?3)",
            params![record_id, conclusion.id, encode(conclusion)?],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn watermark(&self) -> ResearchResult<u64> {
        let connection = self.connection()?;
        adoption_watermark(&connection)
    }
    pub fn export_world_bundle(&self, world_id: &str) -> ResearchResult<WorldResearchBundle> {
        if !id(world_id) {
            return Err(ResearchError::InvalidInput);
        }
        let connection = self.connection()?;
        let watermark = adoption_watermark(&connection)?;
        let mut statement = connection.prepare(
            "SELECT id,change_seq,record FROM research_adoptions WHERE world_id=?1 ORDER BY change_seq",
        )?;
        let rows = statement.query_map([world_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                bounded_json(row, 2)?,
            ))
        })?;
        let mut adoptions = Vec::new();
        let mut encoded_bytes = 0usize;
        for row in rows {
            if adoptions.len() == MAX_ADOPTIONS_PER_WORLD {
                return Err(ResearchError::TooLarge);
            }
            let (id, seq, json) = row?;
            encoded_bytes = encoded_bytes
                .checked_add(json.len())
                .filter(|size| *size <= 64 * 1024 * 1024)
                .ok_or(ResearchError::TooLarge)?;
            let value: ResearchAdoption = decode(&json)?;
            if value.id != id || value.change_seq != seq as u64 {
                return Err(ResearchError::Database);
            }
            adoptions.push(value);
        }
        let bundle = WorldResearchBundle {
            version: WORLD_RESEARCH_BUNDLE_VERSION,
            world_id: world_id.into(),
            watermark,
            adoptions,
        };
        bundle.validate()?;
        Ok(bundle)
    }

    /// No merge or sequence renumbering is permitted. The native shell stages a
    /// dedicated per-world sidecar and publishes its directory with the world.
    pub fn restore_world_bundle(&self, bundle: &WorldResearchBundle) -> ResearchResult<()> {
        bundle.validate()?;
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let occupied: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM research_config) OR EXISTS(SELECT 1 FROM research_operations) OR EXISTS(SELECT 1 FROM research_records) OR EXISTS(SELECT 1 FROM research_conclusions) OR EXISTS(SELECT 1 FROM research_adoptions) OR EXISTS(SELECT 1 FROM sqlite_sequence WHERE seq!=0)",
            [], |row| row.get(0),
        )?;
        if occupied || config_revision(&tx)? != 0 {
            return Err(ResearchError::Conflict);
        }
        for adoption in &bundle.adoptions {
            tx.execute(
                "INSERT INTO research_adoptions(change_seq,id,world_id,record) VALUES(?1,?2,?3,?4)",
                params![
                    adoption.change_seq as i64,
                    adoption.id,
                    adoption.world_id,
                    encode(adoption)?
                ],
            )?;
        }
        if bundle.watermark > 0 {
            let changed = tx.execute(
                "UPDATE sqlite_sequence SET seq=?1 WHERE name='research_adoptions'",
                [bundle.watermark as i64],
            )?;
            if changed == 0 {
                tx.execute(
                    "INSERT INTO sqlite_sequence(name,seq) VALUES('research_adoptions',?1)",
                    [bundle.watermark as i64],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub fn config_revision(&self) -> ResearchResult<u64> {
        let connection = self.connection()?;
        config_revision(&connection)
    }
    pub fn stored_config(&self) -> ResearchResult<Option<StoredResearchConfig>> {
        let connection = self.connection()?;
        let json = connection
            .query_row(
                "SELECT record FROM research_config WHERE singleton=1",
                [],
                |row| bounded_json(row, 0),
            )
            .optional()?;
        json.map(|json| {
            let value: StoredResearchConfig = decode(&json)?;
            value
                .config
                .validate()
                .map_err(|_| ResearchError::Database)?;
            if value
                .secret_slot
                .as_ref()
                .is_some_and(|slot| crate::secrets::SecretSlot::new(slot).is_err())
                || value.revision != config_revision(&connection)?
            {
                return Err(ResearchError::Database);
            }
            Ok(value)
        })
        .transpose()
    }
    pub fn save_config(
        &self,
        config: BraveResearchConfig,
        secret_slot: Option<String>,
        expected_revision: u64,
    ) -> ResearchResult<StoredResearchConfig> {
        config.validate()?;
        if secret_slot
            .as_ref()
            .is_some_and(|slot| crate::secrets::SecretSlot::new(slot).is_err())
        {
            return Err(ResearchError::InvalidInput);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let revision = advance_config_revision(&tx, expected_revision)?;
        let value = StoredResearchConfig {
            config,
            secret_slot,
            revision,
        };
        tx.execute("INSERT INTO research_config(singleton,record) VALUES(1,?1) ON CONFLICT(singleton) DO UPDATE SET record=excluded.record",[encode(&value)?])?;
        tx.commit()?;
        Ok(value)
    }
    pub fn clear_config(&self, expected_revision: u64) -> ResearchResult<u64> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let revision = advance_config_revision(&tx, expected_revision)?;
        tx.execute("DELETE FROM research_config WHERE singleton=1", [])?;
        tx.commit()?;
        Ok(revision)
    }
    pub fn adopt(
        &self,
        scope: &ResearchScope,
        history: &ValidatedHistory,
        adoption_id: &str,
        record_id: &str,
        source_ids: &[String],
    ) -> ResearchResult<ResearchAdoption> {
        if !id(record_id) {
            return Err(ResearchError::InvalidInput);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let cache = record(&tx, record_id)?.ok_or(ResearchError::Missing)?;
        let value =
            adopt_record_in_transaction(&tx, scope, history, adoption_id, cache, source_ids)?;
        tx.commit()?;
        Ok(value)
    }
    /// Only the trusted native layer passes an already validated shared-cache
    /// record. The target sidecar need not contain a duplicate mutable cache.
    pub fn adopt_record(
        &self,
        scope: &ResearchScope,
        history: &ValidatedHistory,
        adoption_id: &str,
        record: &ResearchRecord,
        source_ids: &[String],
    ) -> ResearchResult<ResearchAdoption> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = adopt_record_in_transaction(
            &tx,
            scope,
            history,
            adoption_id,
            record.clone(),
            source_ids,
        )?;
        tx.commit()?;
        Ok(value)
    }
    pub fn adopted(
        &self,
        scope: &ResearchScope,
        history: &ValidatedHistory,
    ) -> ResearchResult<Vec<ResearchAdoption>> {
        scope.validate(history)?;
        let connection = self.connection()?;
        let mut statement=connection.prepare("SELECT id,change_seq,record FROM research_adoptions WHERE world_id=?1 ORDER BY change_seq")?;
        let rows = statement.query_map([&scope.context.world_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                bounded_json(row, 2)?,
            ))
        })?;
        let mut result = Vec::new();
        let mut inspected = 0;
        for row in rows {
            inspected += 1;
            if inspected > MAX_ADOPTIONS_PER_WORLD {
                return Err(ResearchError::Database);
            }
            let (id, seq, json) = row?;
            let value: ResearchAdoption = decode(&json)?;
            value.validate()?;
            if value.id != id || value.change_seq != seq as u64 {
                return Err(ResearchError::Database);
            }
            if scope.sees(history, &value) {
                result.push(value);
            }
        }
        Ok(result)
    }
}

const SCHEMA: &str = r#"
CREATE TABLE research_config_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision>=0 AND revision<=9007199254740991)) STRICT;
INSERT INTO research_config_meta(singleton,revision) VALUES(1,0);
CREATE TABLE research_config(singleton INTEGER PRIMARY KEY CHECK(singleton=1),record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE research_operations(operation_id TEXT PRIMARY KEY,record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE research_records(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,cache_key TEXT NOT NULL,created_at_ms INTEGER NOT NULL,active INTEGER NOT NULL CHECK(active IN(0,1)),record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE INDEX research_cache_lookup ON research_records(cache_key,active,sequence);
CREATE TABLE research_conclusions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,record_id TEXT NOT NULL REFERENCES research_records(id),id TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record)),UNIQUE(record_id,id)) STRICT;
CREATE TABLE research_adoptions(change_seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,world_id TEXT NOT NULL,record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TRIGGER research_record_immutable BEFORE UPDATE OF sequence,id,cache_key,created_at_ms,record ON research_records BEGIN SELECT RAISE(ABORT,'immutable research evidence');END;
CREATE TRIGGER research_conclusion_immutable BEFORE UPDATE ON research_conclusions BEGIN SELECT RAISE(ABORT,'immutable research conclusion');END;
CREATE TRIGGER research_adoption_immutable BEFORE UPDATE ON research_adoptions WHEN OLD.record!='{}' BEGIN SELECT RAISE(ABORT,'immutable research adoption');END;
"#;
