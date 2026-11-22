use crate::{execution_lease as lease, Error, Result, RunBudget, RunEvent, RunPlan, RunSnapshot, RunStopReceipt};
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
        crate::agent_workspace::install_hooks(&*self.lock()?);
        Ok(())
    }
    /// Keeps the run records small (R30, D171): a saved passage's run keeps
    /// only its summary after 14 days (usage stays in its own table); a run
    /// that stopped is kept 30 days for 复制诊断; a deleted story's runs go.
    /// Runs still in progress are never touched.
    pub fn prune(&self, now: chrono::DateTime<Utc>) -> Result<usize> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let saved = (now - chrono::Duration::days(14)).to_rfc3339();
        let stopped = (now - chrono::Duration::days(30)).to_rfc3339();
        let gone = "(SELECT id FROM execution_runs WHERE (status IN ('failed','cancelled','stale','interrupted','paused') AND updated_at<?1) OR (world_id NOT IN (SELECT id FROM worlds) AND (COALESCE(json_type(plan_json,'$.newWorld'),'null') <> 'object' OR status IN ('committed','previewed'))))";
        let mut changed = 0;
        for table in ["execution_events", "execution_progress", "execution_steps", "execution_failures"] {
            changed += tx.execute(&format!("DELETE FROM {table} WHERE run_id IN {gone}"), params![stopped])?;
        }
        changed += tx.execute(&format!("DELETE FROM execution_runs WHERE id IN {gone}"), params![stopped])?;
        let old = "(SELECT id FROM execution_runs WHERE status IN ('committed','previewed') AND updated_at<?1)";
        for table in ["execution_events", "execution_progress", "execution_steps"] {
            changed += tx.execute(&format!("DELETE FROM {table} WHERE run_id IN {old}"), params![saved])?;
        }
        changed += tx.execute("UPDATE execution_runs SET draft_json='{}' WHERE status IN ('committed','previewed') AND updated_at<?1 AND draft_json<>'{}'", params![saved])?;
        tx.commit()?;
        Ok(changed)
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
        Self::guard_opening_book(tx, plan)?;
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
        Self::interrupt_dead_tx(tx, &plan.world_id)?;
        let ticket = Self::acquire_plan_tx(tx, plan, now)?;
        // A look-up never waits for a passage, and a passage never waits for a look-up (D170).
        if !lease::own_lease(plan) && tx.query_row("SELECT 1 FROM execution_runs WHERE world_id=? AND status IN ('running','committing') AND id<>? AND COALESCE(json_extract(plan_json,'$.kind'),'') NOT IN ('ask','maintain')", params![plan.world_id, plan.meta["parentRun"].as_str().unwrap_or("")], |_| Ok(())).optional()?.is_some() {
            return Err(Error::Busy { holder: "turn".into(), until_ms: 0 });
        }
        let mut stored = plan.clone();
        stored.meta["executionLease"] = serde_json::to_value(ticket)?;
        if plan.new_world.is_none() {
            Self::guard(&tx, &stored)?;
        }
        let time = Utc::now().to_rfc3339();
        tx.execute("INSERT INTO execution_runs(id,world_id,line_id,base_head_id,status,plan_json,budget_json,draft_json,created_at,updated_at,parent_run) VALUES(?,?,?,?,'running',?,?,?, ?,?,?)",
            params![plan.id, plan.world_id, plan.line_id, plan.head_id, serde_json::to_string(&stored)?, serde_json::to_string(&RunBudget::default())?, "{}", time, time, plan.meta["parentRun"].as_str()])?;
        Ok(())
    }

    pub(crate) fn guard_opening_book(db: &Connection, plan: &RunPlan) -> Result<()> {
        if plan.kind == "opening" {
            if let Some(book) = plan.state["source"]["bookId"].as_str() {
                let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM source_books WHERE id=?)", [book], |row| row.get(0))?;
                if !exists {
                    return Err(Error::fail(crate::failure::FailKind::Stale, "开场使用的参考书已移除，请重新选择"));
                }
            }
        }
        Ok(())
    }
    /// Runs left "running" by an owner that is gone (closed app, lost
    /// lease) are stopped as interrupted, with a record, so they neither
    /// block the story nor look like the player's stop (R30).
    pub(crate) fn interrupt_dead_tx(tx: &Transaction<'_>, world: &str) -> Result<()> {
        let rows: Vec<(String, String, String)> = {
            let mut stmt = tx.prepare("SELECT id,plan_json,COALESCE(json_extract(draft_json,'$.phase'),'') FROM execution_runs WHERE world_id=? AND status IN ('running','committing')")?;
            let rows = stmt.query_map([world], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        let now = lease::now_ms();
        for (id, plan, phase) in rows {
            let plan: RunPlan = serde_json::from_str(&plan)?;
            if lease::alive(tx, &plan, now)? {
                continue;
            }
            Self::interrupt_tx(tx, &plan, &id, &phase)?;
        }
        Ok(())
    }
    pub(crate) fn recover_orphans(&self) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let worlds = {
            let mut statement = tx.prepare("SELECT DISTINCT world_id FROM execution_runs WHERE status IN ('running','committing')")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for world in worlds {
            Self::interrupt_dead_tx(&tx, &world)?;
        }
        tx.commit()?;
        Ok(())
    }
    fn interrupt_tx(tx: &Transaction<'_>, plan: &RunPlan, id: &str, phase: &str) -> Result<()> {
        let stopped = match lease::ticket(plan)? {
            Some(ticket) => Self::stop_requested(tx, &ticket)?,
            None => false,
        };
        let (status, error) = if stopped {
            ("cancelled", Error::Cancelled)
        } else {
            ("interrupted", Error::fail(crate::failure::FailKind::Interrupted, "上一段在写完前被中断，进度已保留"))
        };
        let failure = crate::failure::record(&error, crate::failure::Stage::of_purpose(phase), 0);
        Self::finish_tx(tx, id, status, Some(&error), Some(&failure))?;
        tx.execute(
            "UPDATE execution_steps SET status=? WHERE run_id=? AND status='running'",
            params![status, id],
        )?;
        crate::runtime::write_usage(tx, id, &plan.world_id, None, status)?;
        Self::append_event(tx, id, json!({"type":"failed","reason":status,"detail":error.to_string(),"failure":failure}))?;
        Ok(())
    }
    /// A run whose owner is gone (a closed app, a lost lease) and that nobody
    /// took over stops as interrupted, so it neither blocks the story nor keeps
    /// the page waiting (R30). Returns whether it was stopped now.
    pub fn interrupt_orphan(&self, id: &str, ours: Option<&lease::LeaseTicket>) -> Result<bool> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, String)> = tx.query_row("SELECT plan_json,COALESCE(json_extract(draft_json,'$.phase'),'') FROM execution_runs WHERE id=? AND status IN ('running','committing')", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let Some((plan, phase)) = row else { return Ok(false) };
        let plan: RunPlan = serde_json::from_str(&plan)?;
        // Taken over by another launch since: that owner decides.
        if ours.is_some_and(|ours| lease::ticket(&plan).ok().flatten().as_ref() != Some(ours)) {
            return Ok(false);
        }
        if lease::alive(&tx, &plan, lease::now_ms())? && ours.is_none() {
            return Ok(false);
        }
        Self::interrupt_tx(&tx, &plan, id, &phase)?;
        tx.commit()?;
        Ok(true)
    }
    /// Persist a request before sending any process-local cancel signal.
    pub(crate) fn request_stop(&self, id: &str, expected: Option<&str>) -> Result<RunStopReceipt> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, String, String)> = tx.query_row(
            "SELECT status,plan_json,COALESCE(json_extract(draft_json,'$.phase'),'') FROM execution_runs WHERE id=?",
            [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional()?;
        let Some((mut status, plan, phase)) = row else {
            return Ok(RunStopReceipt { execution_id: None, status: "missing".into(), accepted: false, settled: true });
        };
        let plan: RunPlan = serde_json::from_str(&plan)?;
        let ticket = lease::ticket(&plan)?.filter(|ticket| ticket.owner_id == id);
        let execution_id = ticket.as_ref().map(lease::LeaseTicket::execution_id);
        let mut settled = !matches!(status.as_str(), "running" | "committing");
        let matching = expected.map_or(true, |expected| execution_id.as_deref() == Some(expected));
        let mut accepted = false;
        if let Some(ticket) = ticket.filter(|_| matching) {
            if !settled {
                tx.execute("UPDATE execution_runs SET plan_json=json_set(plan_json,'$.meta.stopRequested',?) WHERE id=?",
                    params![ticket.execution_id(), id])?;
                accepted = true;
                if !lease::alive(&tx, &plan, lease::now_ms())? {
                    Self::interrupt_tx(&tx, &plan, id, &phase)?;
                    status = "cancelled".into();
                    settled = true;
                }
            } else {
                accepted = Self::stop_requested(&tx, &ticket)?;
            }
        }
        tx.commit()?;
        Ok(RunStopReceipt { execution_id, status, accepted, settled })
    }
    pub(crate) fn stop_requested(db: &Connection, ticket: &lease::LeaseTicket) -> Result<bool> {
        Ok(db.query_row(
            "SELECT EXISTS(SELECT 1 FROM execution_runs WHERE id=? AND json_extract(plan_json,'$.meta.stopRequested')=?)",
            params![ticket.owner_id, ticket.execution_id()], |r| r.get(0),
        )?)
    }
    pub(crate) fn guard_run(db: &Connection, plan: &RunPlan) -> Result<()> {
        crate::maintenance::guard(db)?;
        if let Some(ticket) = lease::ticket(plan)? {
            lease::guard(db, &ticket, lease::now_ms())?;
            if Self::stop_requested(db, &ticket)? {
                return Err(Error::Cancelled);
            }
        }
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
            if Self::stop_requested(tx, &ticket)? {
                return Err(Error::Cancelled);
            }
            lease::heartbeat_tx(tx, &ticket, now, lease::DEFAULT_TTL_MS)?;
            Ok(ticket)
        } else {
            lease::acquire_tx(
                tx,
                &lease::key(plan),
                &plan.id,
                lease::process_instance(),
                now,
                lease::DEFAULT_TTL_MS,
            )
        }
    }
    pub(crate) fn activate_lease(&self, id: &str) -> Result<RunPlan> {
        let db = self.lock()?;
        let text:String=db.query_row("SELECT plan_json FROM execution_runs WHERE id=? AND status IN ('running','committing')",[id],|r|r.get(0))?;
        let plan: RunPlan = serde_json::from_str(&text)?;
        lease::guard_plan(&db, &plan)?;
        Ok(plan)
    }
    pub(crate) fn heartbeat_lease(&self, ticket: &lease::LeaseTicket) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if Self::stop_requested(&tx, ticket)? {
            return Err(Error::Cancelled);
        }
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
        Self::guard_run(tx, plan)?;
        // An answer stays useful after the story moves on (D170); tidying
        // checks the story itself before applying anything (D168).
        if lease::own_lease(plan) {
            return Ok(());
        }
        let row: Option<(String,String,String)> = tx.query_row("SELECT w.current_line_id,l.node_id,w.settings_json FROM worlds w JOIN lines l ON l.id=w.current_line_id WHERE w.id=? AND w.archived=0 AND l.deleted_at IS NULL", [&plan.world_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let Some((line, head, settings)) = row else {
            return Err(Error::Stale);
        };
        if line != plan.line_id || head != plan.head_id {
            return Err(Error::Stale);
        }
        let live: Value = serde_json::from_str(&settings)?;
        if let Some(expected) = plan.meta.get("settingsGuard").filter(|value| value.is_object()) {
            // Current starts capture raw settings. Older plans may compare a subset.
            let matches = if plan.meta["generationSnapshot"] == true {
                &live == expected
            } else {
                expected.as_object().into_iter().flatten().all(|(key, value)| live.get(key).unwrap_or(&Value::Null) == value)
            };
            if !matches {
                return Err(Error::Stale);
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
        failure: Option<&Value>,
    ) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        lease::guard_plan(&tx, plan)?;
        Self::finish_tx(&tx, &plan.id, status, error, failure)?;
        tx.commit()?;
        Ok(())
    }
    /// Stops a run and keeps why: the typed record goes with the run and is
    /// appended to its history, which a later retry does not erase (D166).
    fn finish_tx(tx: &Transaction<'_>, id: &str, status: &str, error: Option<&Error>, failure: Option<&Value>) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let changed = tx.execute("UPDATE execution_runs SET status=?,error=?,error_kind=?,failure_json=?,updated_at=? WHERE id=? AND status NOT IN ('committed','previewed')",params![status,error.map(ToString::to_string),error.map(crate::failure_kind),failure.map(Value::to_string),now,id])?;
        if let (1, Some(failure)) = (changed, failure) {
            tx.execute("INSERT INTO execution_failures(run_id,seq,failure_json,at) VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM execution_failures WHERE run_id=?),?,?)", params![id, id, failure.to_string(), now])?;
        }
        Ok(())
    }
    pub fn event(&self, id: &str, event: Value) -> Result<RunEvent> {
        let mut db = self.lock()?;
        let tx = db.transaction()?;
        let saved = Self::append_event(&tx, id, event)?;
        tx.commit()?;
        Ok(saved)
    }
    fn append_event(tx: &Transaction<'_>, id: &str, event: Value) -> Result<RunEvent> {
        let seq: i64 = tx.query_row(
            "SELECT MAX(
                COALESCE((SELECT MAX(seq) FROM execution_events WHERE run_id=?1),0),
                COALESCE((SELECT seq FROM execution_progress WHERE run_id=?1),0)
             )+1",
            [id],
            |r| r.get(0),
        )?;
        let statement = if event["type"] == "text" {
            "INSERT INTO execution_progress(run_id,seq,event_json) VALUES(?,?,?)
             ON CONFLICT(run_id) DO UPDATE SET seq=excluded.seq,event_json=excluded.event_json"
        } else {
            "INSERT INTO execution_events(run_id,seq,event_json) VALUES(?,?,?)"
        };
        tx.execute(
            statement,
            params![id, seq, event.to_string()],
        )?;
        Ok(RunEvent {
            seq: seq as u64,
            event,
        })
    }
    pub(crate) fn owned<T>(&self, plan: &RunPlan, write: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        lease::guard_plan(&tx, plan)?;
        let result = write(&tx)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn run_event(&self, plan: &RunPlan, event: Value) -> Result<RunEvent> {
        self.owned(plan, |tx| {
            if let Some(parent) = plan.meta["parentRun"].as_str() {
                Self::append_event(tx, parent, event.clone())?;
            }
            Self::append_event(tx, &plan.id, event)
        })
    }
    pub fn snapshot(&self, id: &str, after: u64) -> Result<RunSnapshot> {
        self.snapshot_with_ticket(id, after, None)
    }
    /// Fast path for active runs (R31-P3): when the caller already holds the
    /// live in-process lease ticket, avoid extracting from 100KB+ `plan_json`
    /// and avoid deserializing `draft_json` while `running`/`committing`.
    pub(crate) fn snapshot_with_ticket(
        &self,
        id: &str,
        after: u64,
        active_ticket: Option<&lease::LeaseTicket>,
    ) -> Result<RunSnapshot> {
        let db = self.lock()?;
        let (world_id, status, budget_json, draft_json, result_json, error, error_kind, failure_json, ticket) =
            if let Some(live_ticket) = active_ticket {
                let row = db.query_row(
                    "SELECT world_id,status,budget_json,result_json,error,error_kind,failure_json FROM execution_runs WHERE id=?",
                    [id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, Option<String>>(3)?,
                            r.get::<_, Option<String>>(4)?,
                            r.get::<_, Option<String>>(5)?,
                            r.get::<_, Option<String>>(6)?,
                        ))
                    },
                )?;
                if matches!(row.1.as_str(), "running" | "committing") {
                    (
                        row.0,
                        row.1,
                        row.2,
                        None,
                        row.3,
                        row.4,
                        row.5,
                        row.6,
                        Some(live_ticket.clone()),
                    )
                } else {
                    let (draft, lease_raw): (String, Option<String>) = db.query_row(
                        "SELECT draft_json,json_extract(plan_json,'$.meta.executionLease') FROM execution_runs WHERE id=?",
                        [id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )?;
                    let ticket: Option<lease::LeaseTicket> =
                        lease_raw.as_deref().map(serde_json::from_str).transpose()?;
                    (
                        row.0,
                        row.1,
                        row.2,
                        Some(draft),
                        row.3,
                        row.4,
                        row.5,
                        row.6,
                        ticket,
                    )
                }
            } else {
                let row = db.query_row(
                    "SELECT world_id,status,budget_json,draft_json,result_json,error,error_kind,failure_json,json_extract(plan_json,'$.meta.executionLease') FROM execution_runs WHERE id=?",
                    [id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, Option<String>>(4)?,
                            r.get::<_, Option<String>>(5)?,
                            r.get::<_, Option<String>>(6)?,
                            r.get::<_, Option<String>>(7)?,
                            r.get::<_, Option<String>>(8)?,
                        ))
                    },
                )?;
                let ticket: Option<lease::LeaseTicket> =
                    row.8.as_deref().map(serde_json::from_str).transpose()?;
                (
                    row.0,
                    row.1,
                    row.2,
                    Some(row.3),
                    row.4,
                    row.5,
                    row.6,
                    row.7,
                    ticket,
                )
            };
        let execution_id = ticket.as_ref().map(lease::LeaseTicket::execution_id);
        let stop_requested = ticket
            .as_ref()
            .map(|ticket| Self::stop_requested(&db, ticket))
            .transpose()?
            .unwrap_or(false);
        let mut failures = vec![];
        if !matches!(status.as_str(), "running" | "committing" | "committed" | "previewed") {
            let mut stmt = db.prepare("SELECT failure_json FROM execution_failures WHERE run_id=? ORDER BY seq")?;
            for text in stmt.query_map([id], |r| r.get::<_, String>(0))? {
                failures.push(serde_json::from_str(&text?)?);
            }
        }
        let mut stmt = db.prepare(
            "SELECT seq,event_json FROM execution_events WHERE run_id=?1 AND seq>?2
             UNION ALL SELECT seq,event_json FROM execution_progress WHERE run_id=?1 AND seq>?2 ORDER BY seq",
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
            world_id,
            status,
            execution_id,
            stop_requested,
            budget: serde_json::from_str(&budget_json)?,
            draft: match draft_json {
                Some(raw) => serde_json::from_str(&raw)?,
                None => json!({}),
            },
            result: result_json.map(|s| serde_json::from_str(&s)).transpose()?,
            error,
            error_kind,
            failure: failure_json.map(|s| serde_json::from_str(&s)).transpose()?,
            failures,
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
        let mut s = db.prepare("SELECT id,world_id,status FROM execution_runs WHERE status NOT IN ('committed','previewed') AND parent_run IS NULL ORDER BY created_at")?;
        let rows = s.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"worldId":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?})))?;
        Ok(Value::Array(rows.collect::<std::result::Result<_, _>>()?))
    }
    pub fn finish(&self, id: &str, status: &str, error: Option<&Error>, failure: Option<&Value>) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::finish_tx(&tx, id, status, error, failure)?;
        tx.commit()?;
        Ok(())
    }
    /// Saved model answers of `stage` and later stages are no longer reused,
    /// so the next attempt requests them again (D166). They stay for usage.
    pub fn resume(&self, id: &str) -> Result<()> {
        let mut db = self.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        let (status, text, failure, kind): (String, String, Option<String>, Option<String>) = tx.query_row(
            "SELECT status,plan_json,failure_json,error_kind FROM execution_runs WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
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
        if plan.meta["parentRun"].as_str().is_none() {
            if let Some(held) = lease::current(&tx, &lease::key(&plan))?
                .filter(|l| !l.ticket.owner_id.is_empty() && l.expires_at_ms > lease::now_ms())
            {
                let holder = if held.ticket.owner_id == id { "turn".to_owned() } else { lease::holder(&tx, &held.ticket.owner_id) };
                return Err(Error::Busy { holder, until_ms: held.expires_at_ms });
            }
        }
        let ticket = Self::acquire_plan_tx(&tx, &plan, lease::now_ms())?;
        plan.meta["executionLease"] = serde_json::to_value(ticket)?;
        plan.meta.as_object_mut().map(|meta| meta.remove("stopRequested"));
        // Resume owns the new lease in this transaction, including for a sequence's child.
        if status == "failed" {
            let failure: Option<Value> = failure.as_deref().map(serde_json::from_str).transpose()?;
            if let Some(step) = failure.as_ref().and_then(|failure| failure["replyStep"].as_str()) {
                tx.execute("UPDATE execution_steps SET status='stale' WHERE run_id=? AND step_key=? AND status='done'", params![id, step])?;
            } else if let Some(stage) = crate::failure::retry_from(failure.as_ref(), kind.as_deref()) {
                let mut stmt = tx.prepare("SELECT step_key,kind FROM execution_steps WHERE run_id=? AND status='done' AND step_key LIKE 'model:%'")?;
                let steps = stmt.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                for (key, purpose) in steps {
                    if stage.owns_purpose(&purpose) {
                        tx.execute("UPDATE execution_steps SET status='stale' WHERE run_id=? AND step_key=?", params![id, key])?;
                    }
                }
            }
        }
        // The failure history stays in execution_failures; only the run's
        // current reason is cleared while it runs again.
        tx.execute(
            "UPDATE execution_runs SET status='running',error=NULL,error_kind=NULL,failure_json=NULL,plan_json=? WHERE id=?",
            params![serde_json::to_string(&plan)?, id],
        )?;
        tx.commit()?;
        Ok(())
    }
}
