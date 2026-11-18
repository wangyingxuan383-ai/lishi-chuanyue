//! Cross-process ownership of one story. Every database mutation checks the
//! fencing ticket in its own transaction; model/network waits hold no lock.
use crate::{Error, Result, RunPlan};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub const SCHEMA: &str = include_str!("execution_lease_schema.sql");
pub const DEFAULT_TTL_MS: i64 = 45_000;
pub const HEARTBEAT_MS: u64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseTicket {
    pub world_id: String,
    pub owner_id: String,
    pub owner_instance: String,
    pub fence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseState {
    pub ticket: LeaseTicket,
    pub heartbeat_at_ms: i64,
    pub expires_at_ms: i64,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Process identity deliberately differs after a restart and between the UI
/// and dedicated Agent processes. A persisted task ID is not an ownership key.
pub fn process_instance() -> &'static str {
    static INSTANCE: OnceLock<String> = OnceLock::new();
    INSTANCE.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

pub fn ensure_schema(db: &Connection) -> Result<()> {
    db.execute_batch(SCHEMA)?;
    Ok(())
}

pub fn current(db: &Connection, world: &str) -> Result<Option<LeaseState>> {
    Ok(db.query_row("SELECT owner_id,owner_instance,fence,heartbeat_at_ms,expires_at_ms FROM world_execution_leases WHERE world_id=?",[world],|r|Ok(LeaseState {
        ticket: LeaseTicket { world_id:world.into(),owner_id:r.get(0)?,owner_instance:r.get(1)?,fence:r.get(2)? },
        heartbeat_at_ms:r.get(3)?,expires_at_ms:r.get(4)?,
    })).optional()?)
}

fn expiration(now: i64, ttl: i64) -> Result<i64> {
    if ttl <= 0 {
        return Err(Error::Invalid("执行租约时长无效".into()));
    }
    now.checked_add(ttl)
        .ok_or_else(|| Error::Invalid("执行租约时长超出范围".into()))
}

/// Caller must own an IMMEDIATE transaction. Expired owners receive a new
/// generation even when resuming the same task, fencing their former process.
pub fn acquire_tx(
    tx: &Transaction<'_>,
    world: &str,
    owner: &str,
    instance: &str,
    now: i64,
    ttl: i64,
) -> Result<LeaseTicket> {
    if world.is_empty() || owner.is_empty() || instance.is_empty() {
        return Err(Error::Invalid("执行租约缺少故事或任务标识".into()));
    }
    let expires = expiration(now, ttl)?;
    let previous = current(tx, world)?;
    let fence = if let Some(previous) = previous {
        if previous.expires_at_ms > now && !previous.ticket.owner_id.is_empty() {
            if previous.ticket.owner_id != owner || previous.ticket.owner_instance != instance {
                return Err(Error::Busy { holder: holder(tx, &previous.ticket.owner_id), until_ms: previous.expires_at_ms });
            }
            previous.ticket.fence
        } else {
            previous
                .ticket
                .fence
                .checked_add(1)
                .ok_or_else(|| Error::Invalid("故事执行版本超出范围".into()))?
        }
    } else {
        1
    };
    tx.execute("INSERT INTO world_execution_leases(world_id,owner_id,owner_instance,fence,heartbeat_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(world_id) DO UPDATE SET owner_id=excluded.owner_id,owner_instance=excluded.owner_instance,fence=excluded.fence,heartbeat_at_ms=excluded.heartbeat_at_ms,expires_at_ms=excluded.expires_at_ms",params![world,owner,instance,fence,now,expires])?;
    Ok(LeaseTicket {
        world_id: world.into(),
        owner_id: owner.into(),
        owner_instance: instance.into(),
        fence,
    })
}

/// What kind of task a lease owner is, for the "busy" notice (R30).
pub fn holder(db: &Connection, owner: &str) -> String {
    let kind: Option<String> = db
        .query_row("SELECT json_extract(plan_json,'$.kind') FROM execution_runs WHERE id=?", [owner], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    if let Some(kind) = kind {
        return match kind.as_str() {
            "ask" => "ask",
            "autoplay" => "autoplay",
            _ => "turn",
        }
        .into();
    }
    let assistant = db
        .query_row("SELECT 1 FROM pi_tasks WHERE id=?", [owner], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some();
    if assistant { "assistant" } else { "other" }.into()
}

pub fn guard(db: &Connection, ticket: &LeaseTicket, now: i64) -> Result<()> {
    let valid=db.query_row("SELECT 1 FROM world_execution_leases WHERE world_id=? AND owner_id=? AND owner_instance=? AND fence=? AND expires_at_ms>?",params![ticket.world_id,ticket.owner_id,ticket.owner_instance,ticket.fence,now],|_|Ok(())).optional()?.is_some();
    if valid {
        Ok(())
    } else {
        Err(Error::Stale)
    }
}

pub fn heartbeat_tx(tx: &Transaction<'_>, ticket: &LeaseTicket, now: i64, ttl: i64) -> Result<()> {
    let expires = expiration(now, ttl)?;
    let changed=tx.execute("UPDATE world_execution_leases SET heartbeat_at_ms=?,expires_at_ms=? WHERE world_id=? AND owner_id=? AND owner_instance=? AND fence=? AND expires_at_ms>?",params![now,expires,ticket.world_id,ticket.owner_id,ticket.owner_instance,ticket.fence,now])?;
    if changed == 1 {
        Ok(())
    } else {
        Err(Error::Stale)
    }
}

/// Never delete a row: the monotonic fence must survive release and reacquire.
pub fn release_tx(tx: &Transaction<'_>, ticket: &LeaseTicket) -> Result<()> {
    let changed=tx.execute("UPDATE world_execution_leases SET owner_id='',owner_instance='',expires_at_ms=0 WHERE world_id=? AND owner_id=? AND owner_instance=? AND fence=?",params![ticket.world_id,ticket.owner_id,ticket.owner_instance,ticket.fence])?;
    if changed == 1 {
        Ok(())
    } else {
        Err(Error::Stale)
    }
}

/// Runs that never hold the story (R30): 查一查 only reads it (D170), and the
/// tidying after a saved passage applies its result only if it still fits (D168).
pub fn own_lease(plan: &RunPlan) -> bool {
    matches!(plan.kind.as_str(), "ask" | "maintain")
}

/// The lease a run holds: the story's own for every passage, a private one
/// for a run that never holds the story, so it neither keeps the story from
/// being written nor waits for a passage.
pub fn key(plan: &RunPlan) -> String {
    if own_lease(plan) {
        format!("{}#read:{}", plan.world_id, plan.id)
    } else {
        plan.world_id.clone()
    }
}

/// Whether a run still has a live owner: its lease (or its sequence's) is held
/// by it and has not expired.
pub fn alive(db: &Connection, plan: &RunPlan, now: i64) -> Result<bool> {
    let owner = plan.meta["parentRun"].as_str().unwrap_or(&plan.id).to_owned();
    Ok(current(db, &key(plan))?.is_some_and(|l| l.expires_at_ms > now && l.ticket.owner_id == owner))
}

pub fn ticket(plan: &RunPlan) -> Result<Option<LeaseTicket>> {
    let Some(value) = plan.meta.get("executionLease") else {
        return Ok(None);
    };
    let ticket: LeaseTicket = serde_json::from_value(value.clone())?;
    if ticket.world_id != key(plan)
        || ticket.owner_id.is_empty()
        || ticket.owner_instance.is_empty()
        || ticket.fence <= 0
    {
        return Err(Error::Stale);
    }
    Ok(Some(ticket))
}

pub fn guard_plan(db: &Connection, plan: &RunPlan) -> Result<()> {
    let ticket = ticket(plan)?.ok_or(Error::Stale)?;
    guard(db, &ticket, now_ms())
}
