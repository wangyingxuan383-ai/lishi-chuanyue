use crate::{execution_lease as lease, Error, Result, RunBudget, RunEvent, RunPlan, RunSnapshot};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, MutexGuard};

pub(crate) fn lock_connection(mutex: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    mutex.lock().unwrap_or_else(|poisoned| {
        eprintln!("story-core: recovered the database connection after a panic in another thread");
        mutex.clear_poison();
        poisoned.into_inner()
    })
}

/// One shared connection lock for UI SQL, runs, tools and final commits.
#[derive(Clone)]
pub struct Store(pub Arc<Mutex<Connection>>);

impl Store {
    /// A panic in another thread while holding the connection poisons the
    /// mutex. Its open transaction was rolled back during unwinding, so the
    /// connection is still consistent: recover instead of failing every later
    /// UI query, run and tool call until the process restarts.
    pub fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        Ok(lock_connection(&self.0))
    }
    pub fn initialize(&self) -> Result<()> {
        self.lock()?.execute_batch(include_str!("schema.sql"))?;
        self.lock()?
            .execute_batch(include_str!("agent_schema.sql"))?;
        lease::ensure_schema(&*self.lock()?)?;
        Ok(())
    }
    pub fn register(&self, plan: &RunPlan) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::register_tx(&tx, plan)?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn register_tx(tx: &Transaction<'_>, plan: &RunPlan) -> Result<()> {
        crate::maintenance::guard(tx)?;
        lease::ensure_schema(tx)?;
        if tx
            .query_row(
                "SELECT 1 FROM execution_runs WHERE id=?",
                [&plan.id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(Error::Invalid("这次运行已存在，请读取或恢复它".into()));
        }
        // A stale running flag is not a lock. Preserve dead-owner progress but
        // do not let it prevent another process from acquiring the story.
        let now = lease::now_ms();
        if !lease::current(tx, &plan.world_id)?
            .is_some_and(|l| !l.ticket.owner_id.is_empty() && l.expires_at_ms > now)
        {
            tx.execute("UPDATE execution_runs SET status='interrupted',error='原执行进程的租约已失效，进度已保留' WHERE world_id=? AND status IN ('running','committing')",[&plan.world_id])?;
        }
        let ticket = Self::acquire_plan_tx(tx, plan, now)?;
        if tx.query_row("SELECT 1 FROM execution_runs WHERE world_id=? AND status IN ('running','committing') AND id<>?", params![plan.world_id, plan.meta["parentRun"].as_str().unwrap_or("")], |_| Ok(())).optional()?.is_some() {
            return Err(Error::Invalid("这个故事还在生成".into()));
        }
        let mut stored = plan.clone();
        stored.meta["executionLease"] = serde_json::to_value(ticket)?;
        if plan.new_world.is_none() {
            Self::guard(&tx, &stored)?;
        }
        let time = Utc::now().to_rfc3339();
        tx.execute("INSERT INTO execution_runs(id,world_id,line_id,base_head_id,status,plan_json,budget_json,draft_json,created_at,updated_at) VALUES(?,?,?,?,'running',?,?,?, ?,?)",
            params![plan.id, plan.world_id, plan.line_id, plan.head_id, serde_json::to_string(&stored)?, serde_json::to_string(&RunBudget::default())?, "{}", time, time])?;
        Ok(())
    }
    fn acquire_plan_tx(
        tx: &Transaction<'_>,
        plan: &RunPlan,
        now: i64,
    ) -> Result<lease::LeaseTicket> {
        if let Some(parent) = plan.meta["parentRun"].as_str() {
            let text:String=tx.query_row("SELECT plan_json FROM execution_runs WHERE id=? AND world_id=? AND status IN ('running','committing')",params![parent,plan.world_id],|r|r.get(0))?;
            let parent: RunPlan = serde_json::from_str(&text)?;
            let ticket = lease::ticket(&parent)?.ok_or(Error::Stale)?;
            if ticket.owner_instance != lease::process_instance() {
                return Err(Error::Stale);
            }
            lease::heartbeat_tx(tx, &ticket, now, lease::DEFAULT_TTL_MS)?;
            Ok(ticket)
        } else {
            lease::acquire_tx(
                tx,
                &plan.world_id,
                &plan.id,
                lease::process_instance(),
                now,
                lease::DEFAULT_TTL_MS,
            )
        }
    }
    pub(crate) fn activate_lease(&self, id: &str) -> Result<RunPlan> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let text:String=tx.query_row("SELECT plan_json FROM execution_runs WHERE id=? AND status IN ('running','committing')",[id],|r|r.get(0))?;
        let mut plan: RunPlan = serde_json::from_str(&text)?;
        let ticket = Self::acquire_plan_tx(&tx, &plan, lease::now_ms())?;
        plan.meta["executionLease"] = serde_json::to_value(ticket)?;
        tx.execute(
            "UPDATE execution_runs SET plan_json=? WHERE id=?",
            params![serde_json::to_string(&plan)?, id],
        )?;
        tx.commit()?;
        Ok(plan)
    }
    pub(crate) fn heartbeat_lease(&self, ticket: &lease::LeaseTicket) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        lease::heartbeat_tx(&tx, ticket, lease::now_ms(), lease::DEFAULT_TTL_MS)?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn release_lease(&self, ticket: &lease::LeaseTicket) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        lease::release_tx(&tx, ticket)?;
        tx.commit()?;
        Ok(())
    }
    pub fn guard(tx: &Transaction<'_>, plan: &RunPlan) -> Result<()> {
        crate::maintenance::guard(tx)?;
        if lease::ticket(plan)?.is_some() {
            lease::guard_plan(tx, plan)?;
        }
        let row: Option<(String,String,String)> = tx.query_row("SELECT w.current_line_id,l.node_id,w.settings_json FROM worlds w JOIN lines l ON l.id=w.current_line_id WHERE w.id=? AND w.archived=0 AND l.deleted_at IS NULL", [&plan.world_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((line, head, settings)) = row else {
            return Err(Error::Stale);
        };
        if line != plan.line_id || head != plan.head_id {
            return Err(Error::Stale);
        }
        let live: Value = serde_json::from_str(&settings)?;
        // Compare only keys supplied by the facade: defaults are absent in legacy settings.
        if let Some(expected) = plan.meta.get("settingsGuard").and_then(Value::as_object) {
            for (key, value) in expected {
                if live.get(key).unwrap_or(&Value::Null) != value {
                    return Err(Error::Stale);
                }
            }
        }
        let state: String = tx.query_row(
            "SELECT state_json FROM states WHERE node_id=?",
            [&plan.head_id],
            |r| r.get(0),
        )?;
        let state: Value = serde_json::from_str(&state)?;
        if let Some(expected) = plan.meta.get("sourceGuard") {
            if state.get("source").unwrap_or(&Value::Null) != expected {
                return Err(Error::Stale);
            }
        }
        Ok(())
    }
    pub fn checkpoint(&self, id: &str, budget: &RunBudget, draft: &Value) -> Result<()> {
        self.lock()?.execute("UPDATE execution_runs SET budget_json=?,draft_json=?,updated_at=? WHERE id=? AND status='running'", params![serde_json::to_string(budget)?, serde_json::to_string(draft)?, Utc::now().to_rfc3339(), id])?;
        Ok(())
    }
    pub(crate) fn checkpoint_owned(
        &self,
        plan: &RunPlan,
        budget: &RunBudget,
        draft: &Value,
    ) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        lease::guard_plan(&tx, plan)?;
        tx.execute("UPDATE execution_runs SET budget_json=?,draft_json=?,updated_at=? WHERE id=? AND status='running'", params![serde_json::to_string(budget)?,serde_json::to_string(draft)?,Utc::now().to_rfc3339(),plan.id])?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn finish_owned(
        &self,
        plan: &RunPlan,
        status: &str,
        error: Option<&Error>,
    ) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        lease::guard_plan(&tx, plan)?;
        tx.execute("UPDATE execution_runs SET status=?,error=?,error_kind=?,updated_at=? WHERE id=? AND status NOT IN ('committed','previewed')",params![status,error.map(ToString::to_string),error.map(crate::failure_kind),Utc::now().to_rfc3339(),plan.id])?;
        tx.commit()?;
        Ok(())
    }
    pub fn event(&self, id: &str, event: Value) -> Result<RunEvent> {
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        let seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq),0)+1 FROM execution_events WHERE run_id=?",
            [id],
            |r| r.get(0),
        )?;
        tx.execute(
            "INSERT INTO execution_events(run_id,seq,event_json) VALUES(?,?,?)",
            params![id, seq, event.to_string()],
        )?;
        tx.commit()?;
        Ok(RunEvent {
            seq: seq as u64,
            event,
        })
    }
    pub fn run_event(&self, plan: &RunPlan, event: Value) -> Result<RunEvent> {
        let saved = self.event(&plan.id, event.clone())?;
        if let Some(parent) = plan.meta["parentRun"].as_str() {
            self.event(parent, event)?;
        }
        Ok(saved)
    }
    pub fn snapshot(&self, id: &str, after: u64) -> Result<RunSnapshot> {
        let db = self.lock()?;
        let row = db.query_row("SELECT world_id,status,budget_json,draft_json,result_json,error,error_kind FROM execution_runs WHERE id=?", [id], |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?, r.get::<_,String>(3)?, r.get::<_,Option<String>>(4)?, r.get::<_,Option<String>>(5)?, r.get::<_,Option<String>>(6)?)))?;
        let mut stmt = db.prepare(
            "SELECT seq,event_json FROM execution_events WHERE run_id=? AND seq>? ORDER BY seq",
        )?;
        let rows = stmt.query_map(params![id, after.min(i64::MAX as u64) as i64], |r| {
            Ok((r.get::<_, i64>(0)? as u64, r.get::<_, String>(1)?))
        })?;
        let mut events = vec![];
        for row in rows {
            let (seq, text) = row?;
            events.push(RunEvent {
                seq,
                event: serde_json::from_str(&text)?,
            });
        }
        Ok(RunSnapshot {
            id: id.into(),
            world_id: row.0,
            status: row.1,
            budget: serde_json::from_str(&row.2)?,
            draft: serde_json::from_str(&row.3)?,
            result: row.4.map(|s| serde_json::from_str(&s)).transpose()?,
            error: row.5,
            error_kind: row.6,
            events,
        })
    }
    pub fn plan(&self, id: &str) -> Result<RunPlan> {
        let s: String = self.lock()?.query_row(
            "SELECT plan_json FROM execution_runs WHERE id=?",
            [id],
            |r| r.get(0),
        )?;
        Ok(serde_json::from_str(&s)?)
    }
    pub fn list(&self) -> Result<Value> {
        let db = self.lock()?;
        let mut s = db.prepare("SELECT id,world_id,status FROM execution_runs WHERE status NOT IN ('committed','previewed') AND json_extract(plan_json,'$.meta.parentRun') IS NULL ORDER BY created_at")?;
        let rows = s.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"worldId":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?})))?;
        Ok(Value::Array(rows.collect::<std::result::Result<_, _>>()?))
    }
    pub fn finish(&self, id: &str, status: &str, error: Option<&Error>) -> Result<()> {
        self.lock()?.execute("UPDATE execution_runs SET status=?,error=?,error_kind=?,updated_at=? WHERE id=? AND status NOT IN ('committed','previewed')", params![status, error.map(ToString::to_string), error.map(crate::failure_kind), Utc::now().to_rfc3339(), id])?;
        Ok(())
    }
    pub fn resume(&self, id: &str) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (status, text): (String, String) = tx.query_row(
            "SELECT status,plan_json FROM execution_runs WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if !matches!(
            status.as_str(),
            "paused" | "failed" | "cancelled" | "interrupted" | "running" | "committing"
        ) {
            return Err(Error::Invalid("这次运行不能恢复".into()));
        }
        let mut plan: RunPlan = serde_json::from_str(&text)?;
        // A root resume starts a fresh execution. Even another Engine in this
        // process must not share an already active root's fencing ticket.
        // Spectator child turns deliberately borrow their live parent's lease.
        if plan.meta["parentRun"].as_str().is_none()
            && lease::current(&tx, &plan.world_id)?
                .is_some_and(|l| !l.ticket.owner_id.is_empty() && l.expires_at_ms > lease::now_ms())
        {
            return Err(Error::Invalid("原执行尚未停止，不能重复启动".into()));
        }
        let ticket = Self::acquire_plan_tx(&tx, &plan, lease::now_ms())?;
        plan.meta["executionLease"] = serde_json::to_value(ticket)?;
        tx.execute(
            "UPDATE execution_runs SET status='running',error=NULL,error_kind=NULL,plan_json=? WHERE id=?",
            params![serde_json::to_string(&plan)?, id],
        )?;
        tx.commit()?;
        Ok(())
    }
}
