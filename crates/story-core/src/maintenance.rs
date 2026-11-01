//! Cross-process restore fence. Cancellation/accounting may drain; no new
//! story owner, formal commit or frontend write may enter the maintenance gap.
use crate::{execution_lease as lease, Error, Result, Store};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json,Value};
#[derive(Clone)] pub struct Ticket {pub owner:String,pub epoch:i64}
pub fn guard(db:&Connection)->Result<()> {
    let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='database_maintenance')",[],|r|r.get(0))?;
    if exists && db.query_row("SELECT EXISTS(SELECT 1 FROM database_maintenance WHERE active=1 AND expires_at_ms>?)",[lease::now_ms()],|r|r.get::<_,bool>(0))? {return Err(Error::Invalid("正在维护或恢复存档，请等待完成后操作".into()));}
    Ok(())
}
pub fn begin(store:&Store)->Result<Ticket> {
    let mut db=store.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;guard(&tx)?;
    let epoch:i64=tx.query_row("SELECT epoch FROM database_maintenance WHERE id=1",[],|r|r.get(0)).optional()?.unwrap_or(0)+1;
    let ticket=Ticket{owner:uuid::Uuid::new_v4().to_string(),epoch};install(&tx,&ticket)?;tx.commit()?;Ok(ticket)
}
pub fn install(db:&Connection,ticket:&Ticket)->Result<()> {
    db.execute("INSERT INTO database_maintenance(id,owner,active,epoch,updated_at,expires_at_ms) VALUES(1,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,active=1,epoch=excluded.epoch,updated_at=excluded.updated_at,expires_at_ms=excluded.expires_at_ms",params![ticket.owner,ticket.epoch,chrono::Utc::now().to_rfc3339(),lease::now_ms()+1_200_000])?;Ok(())
}
pub fn verify(db:&Connection,ticket:&Ticket)->Result<()> {
    if !db.query_row("SELECT EXISTS(SELECT 1 FROM database_maintenance WHERE id=1 AND owner=? AND epoch=? AND active=1 AND expires_at_ms>?)",params![ticket.owner,ticket.epoch,lease::now_ms()],|r|r.get::<_,bool>(0))? {return Err(Error::Invalid("存档维护批次已失效，未恢复或覆盖数据".into()));}Ok(())
}
pub fn end(store:&Store,ticket:&Ticket)->Result<()> {
    store.lock()?.execute("UPDATE database_maintenance SET active=0,epoch=epoch+1,expires_at_ms=0 WHERE id=1 AND owner=? AND epoch=?",params![ticket.owner,ticket.epoch])?;Ok(())
}
pub fn pending_stops(store:&Store)->Result<Vec<Value>> {
    let db=store.lock()?;let rows=crate::agent_workspace::rows(&db,"SELECT id,lease_json FROM pi_tasks WHERE status IN ('running','committing','waiting_user') OR json_extract(metadata_json,'$._nativeHostActive')=1",&[])?;
    Ok(rows.iter().map(|r|json!({"op":"stop","taskId":r["id"],"attemptId":crate::pi_lifecycle::attempt(r),"requestId":uuid::Uuid::new_v4().to_string()})).collect())
}
pub fn drained(store:&Store)->Result<bool> {
    let db=store.lock()?;
    Ok(!db.query_row("SELECT EXISTS(SELECT 1 FROM pi_tasks WHERE status IN ('running','committing') OR json_extract(metadata_json,'$._nativeHostActive')=1) OR EXISTS(SELECT 1 FROM execution_runs WHERE status IN ('running','committing'))",[],|r|r.get::<_,bool>(0))?)
}
