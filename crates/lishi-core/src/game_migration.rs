//! Explicit v1 -> v2 upgrade. Never called by listing or ordinary v1 opening.
//! The caller must have released its playable store. All old formal records
//! remain byte-for-byte intact; only the current projection and schema change.

use std::{
    fmt,
    fs::File,
    io::Read,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    game_archive::{ArchiveControl, LegacyGameArchive},
    game_legacy::LegacyAdapter,
    game_protocol_v2::{validate_state_v2, WorldStateV2},
};

pub const ADAPTER_VERSION: &str = "legacy_adapter_v1";
const APPLICATION_ID: i32 = 0x4c495348;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationError {
    Unavailable,
    Busy,
    InvalidArchive,
    BackupFailed,
    Conflict,
    Database,
    Unconfirmed,
}
impl fmt::Display for MigrationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "game_migration_unavailable",
            Self::Busy => "game_migration_busy",
            Self::InvalidArchive => "game_migration_invalid",
            Self::BackupFailed => "game_migration_backup_failed",
            Self::Conflict => "game_migration_conflict",
            Self::Database => "game_migration_database",
            Self::Unconfirmed => "game_migration_unconfirmed",
        })
    }
}
impl std::error::Error for MigrationError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationReceipt {
    pub from_version: u32,
    pub to_version: u32,
    pub adapter_version: String,
    pub backup_basename: String,
    pub backup_sha256: String,
    pub content_sha256: String,
    pub immutable_legacy_sha256: String,
    pub legacy_operation_rowid_max: i64,
    pub head_turn_id: Option<String>,
    pub turn_count: u64,
    pub completed_at_ms: i64,
}

/// Fingerprint the unchanged v1 prefix, excluding world fields that later v2
/// turns legitimately update. The audit at migration has already verified it.
/// This lets later v2 opening detect modifications to old failed inputs too.
pub fn immutable_legacy_fingerprint(
    db: &Connection,
    turns: u64,
    operation_rowid_max: i64,
) -> Result<String, MigrationError> {
    let turns: i64 = turns
        .try_into()
        .map_err(|_| MigrationError::InvalidArchive)?;
    if operation_rowid_max < 0 {
        return Err(MigrationError::InvalidArchive);
    }
    let mut digest = Sha256::new();
    for (tag,query,bound) in [
        ("world","SELECT world_id,setup,initial_state,opening_narrative,opening_choices,created_at_ms FROM game_world WHERE id=1 AND ?1>=0",0),
        ("turns","SELECT turn_id,parent_turn_id,sequence,action_kind,action_text,narrative,choices,state,output,created_at_ms FROM game_turns WHERE sequence<=?1 ORDER BY sequence",turns),
        ("operations","SELECT operation_id,expected_head_turn_id,action_kind,action_text,status,error_code,created_at_ms FROM game_operations WHERE rowid<=?1 ORDER BY rowid",operation_rowid_max),
    ] {
        digest.update(tag.as_bytes());let mut statement=db.prepare(query).map_err(|_|MigrationError::Database)?;
        let columns=statement.column_count();let mut rows=statement.query([bound]).map_err(|_|MigrationError::Database)?;
        while let Some(row)=rows.next().map_err(|_|MigrationError::Database)? {
            digest.update([0x52]);
            for n in 0..columns {use rusqlite::types::ValueRef;
                match row.get_ref(n).map_err(|_|MigrationError::Database)? {
                    ValueRef::Null=>digest.update([0]),
                    ValueRef::Integer(v)=>{digest.update([1]);digest.update(v.to_le_bytes());},
                    ValueRef::Real(v)=>{digest.update([2]);digest.update(v.to_bits().to_le_bytes());},
                    ValueRef::Text(v)=>{digest.update([3]);digest.update((v.len() as u64).to_le_bytes());digest.update(v);},
                    ValueRef::Blob(v)=>{digest.update([4]);digest.update((v.len() as u64).to_le_bytes());digest.update(v);},
                }
            }
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationBoundary {
    BackupReady,
    BeforeTransaction,
    BeforeCommit,
    Committed,
}

fn archive_error(error: crate::game_archive::GameArchiveError) -> MigrationError {
    use crate::game_archive::GameArchiveError as E;
    match error {
        E::Busy => MigrationError::Busy,
        E::Unavailable => MigrationError::Unavailable,
        E::BackupFailed | E::DestinationExists => MigrationError::BackupFailed,
        _ => MigrationError::InvalidArchive,
    }
}

fn file_sha256(path: &Path) -> Result<String, MigrationError> {
    let mut file = File::open(path).map_err(|_| MigrationError::BackupFailed)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|_| MigrationError::BackupFailed)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn upgrade_v1(
    path: impl AsRef<Path>,
    backup_directory: impl AsRef<Path>,
) -> Result<MigrationReceipt, MigrationError> {
    upgrade_v1_with_hook(path, backup_directory, |_| Ok(()))
}

pub fn upgrade_v1_if_head(
    path: impl AsRef<Path>,
    backup_directory: impl AsRef<Path>,
    expected_head: Option<&str>,
) -> Result<MigrationReceipt, MigrationError> {
    upgrade_checked(path, backup_directory, Some(expected_head), |_| Ok(()))
}

/// Hooks are for controlled fault tests. They must never call network services
/// or open the same world. A failure before COMMIT rolls back; post-COMMIT
/// acknowledgement failure is explicitly unconfirmed, not reported as rollback.
pub fn upgrade_v1_with_hook(
    path: impl AsRef<Path>,
    backup_directory: impl AsRef<Path>,
    hook: impl FnMut(MigrationBoundary) -> Result<(), MigrationError>,
) -> Result<MigrationReceipt, MigrationError> {
    upgrade_checked(path, backup_directory, None, hook)
}

fn upgrade_checked(
    path: impl AsRef<Path>,
    backup_directory: impl AsRef<Path>,
    expected_head: Option<Option<&str>>,
    mut hook: impl FnMut(MigrationBoundary) -> Result<(), MigrationError>,
) -> Result<MigrationReceipt, MigrationError> {
    let path = path.as_ref();
    let directory = backup_directory.as_ref();
    if !directory.is_dir() {
        return Err(MigrationError::Unavailable);
    }
    let archive = LegacyGameArchive::open(path).map_err(archive_error)?;
    let audit = archive.audit();
    if expected_head.is_some_and(|expected| audit.header.head_turn_id.as_deref() != expected) {
        return Err(MigrationError::Conflict);
    }
    let mut adapter =
        LegacyAdapter::from_header(&audit.header).map_err(|_| MigrationError::InvalidArchive)?;
    archive
        .visit_turns(|turn| {
            adapter
                .push_turn(turn)
                .map_err(|_| crate::game_archive::GameArchiveError::InvalidArchive)?;
            Ok(ArchiveControl::Continue)
        })
        .map_err(archive_error)?;
    let adapted = adapter
        .finish()
        .map_err(|_| MigrationError::InvalidArchive)?;
    validate_state_v2(&adapted.current_state).map_err(|_| MigrationError::InvalidArchive)?;
    let current_json = serde_json::to_string(&adapted.current_state)
        .map_err(|_| MigrationError::InvalidArchive)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| MigrationError::Unavailable)?;
    let completed_at_ms: i64 = now
        .as_millis()
        .try_into()
        .map_err(|_| MigrationError::Unavailable)?;
    // Only an internally generated basename is joined, never an imported path.
    let world_hash = format!("{:x}", Sha256::digest(audit.header.world_id.as_bytes()));
    let basename = format!("world-{world_hash}-pre-v2-{}.sqlite", now.as_nanos());
    let backup = directory.join(&basename);
    archive.backup_to_new(&backup).map_err(archive_error)?;
    let proof_db = Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| MigrationError::Unavailable)?;
    let legacy_operation_rowid_max: i64 = proof_db
        .query_row(
            "SELECT coalesce(max(rowid),0) FROM game_operations",
            [],
            |r| r.get(0),
        )
        .map_err(|_| MigrationError::Database)?;
    let immutable_legacy_sha256 = immutable_legacy_fingerprint(
        &proof_db,
        audit.header.turn_count,
        legacy_operation_rowid_max,
    )?;
    drop(proof_db);
    let receipt = MigrationReceipt {
        from_version: 1,
        to_version: 2,
        adapter_version: ADAPTER_VERSION.into(),
        backup_basename: basename,
        backup_sha256: file_sha256(&backup)?,
        content_sha256: audit.content_sha256.clone(),
        immutable_legacy_sha256,
        legacy_operation_rowid_max,
        head_turn_id: audit.header.head_turn_id.clone(),
        turn_count: audit.header.turn_count,
        completed_at_ms,
    };
    hook(MigrationBoundary::BackupReady)?;
    // Archive retains the application owner lock and a WAL read snapshot.
    // This second connection is trusted internal writing, not a second owner.
    let mut writer = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|_| MigrationError::Unavailable)?;
    writer
        .busy_timeout(std::time::Duration::from_millis(500))
        .map_err(|_| MigrationError::Database)?;
    writer
        .execute_batch("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")
        .map_err(|_| MigrationError::Database)?;
    let mode: String = writer
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(|_| MigrationError::Database)?;
    // v1 playable saves use WAL. Refuse foreign journal modes rather than
    // changing one while the audited read snapshot is still alive.
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(MigrationError::InvalidArchive);
    }
    hook(MigrationBoundary::BeforeTransaction)?;
    let transaction = writer
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| MigrationError::Busy)?;
    let version: i32 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| MigrationError::Database)?;
    let application: i32 = transaction
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(|_| MigrationError::Database)?;
    let (world, head, count, state): (String, Option<String>, i64, String) = transaction
        .query_row(
            "SELECT world_id,head_turn_id,turn_count,current_state FROM game_world WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| MigrationError::Database)?;
    let active:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM game_operations WHERE status IN ('pending','generating','validating'))",[],|row|row.get(0)).map_err(|_|MigrationError::Database)?;
    if version != 1
        || application != APPLICATION_ID
        || active
        || world != audit.header.world_id
        || head != receipt.head_turn_id
        || u64::try_from(count).ok() != Some(receipt.turn_count)
        || state != audit.header.current_state_json
    {
        return Err(MigrationError::Conflict);
    }
    if immutable_legacy_fingerprint(
        &transaction,
        receipt.turn_count,
        receipt.legacy_operation_rowid_max,
    )? != receipt.immutable_legacy_sha256
    {
        return Err(MigrationError::Conflict);
    }
    transaction.execute_batch("CREATE TABLE game_migrations (from_version INTEGER NOT NULL,to_version INTEGER NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(from_version,to_version));").map_err(|_|MigrationError::Database)?;
    let receipt_json = serde_json::to_string(&receipt).map_err(|_| MigrationError::Database)?;
    transaction
        .execute("INSERT INTO game_migrations VALUES(1,2,?1)", [receipt_json])
        .map_err(|_| MigrationError::Database)?;
    let changed = transaction
        .execute(
            "UPDATE game_world SET current_state=?1 WHERE id=1 AND current_state=?2",
            params![current_json, audit.header.current_state_json],
        )
        .map_err(|_| MigrationError::Database)?;
    if changed != 1 {
        return Err(MigrationError::Conflict);
    }
    transaction
        .pragma_update(None, "user_version", 2)
        .map_err(|_| MigrationError::Database)?;
    hook(MigrationBoundary::BeforeCommit)?;
    transaction
        .commit()
        .map_err(|_| MigrationError::Unconfirmed)?;
    drop(archive);
    let version: i32 = writer
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| MigrationError::Unconfirmed)?;
    let state: String = writer
        .query_row(
            "SELECT current_state FROM game_world WHERE id=1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| MigrationError::Unconfirmed)?;
    let parsed: WorldStateV2 =
        serde_json::from_str(&state).map_err(|_| MigrationError::Unconfirmed)?;
    if version != 2 || parsed != adapted.current_state {
        return Err(MigrationError::Unconfirmed);
    }
    hook(MigrationBoundary::Committed).map_err(|_| MigrationError::Unconfirmed)?;
    Ok(receipt)
}
