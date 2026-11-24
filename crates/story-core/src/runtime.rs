use crate::{
    chat::{self, BoxFuture, Completion, Model, TextSink},
    execution_lease,
    mcp::BuiltinMcp,
    rules, Error, Result, RunBudget, RunPlan, RunSnapshot, RunStopReceipt, Store,
};
use chrono::Utc;
use sha2::{Digest, Sha256};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

mod correction;
mod maintain;
mod review;

pub type LeaseFactory = Arc<dyn Fn(u64) -> Box<dyn Send> + Send + Sync>;
pub type CompletionSink = Arc<dyn Fn(String) + Send + Sync>;
/// Live push callback for native hosts (R31-P3): `(run_id, seq, event)`.
/// `seq == 0` denotes an ephemeral in-flight text frame not yet flushed to SQLite.
pub type LiveEventSink = Arc<dyn Fn(&str, u64, &Value) + Send + Sync>;
/// What a host shows while a story is being written (R29-T006): the phone's
/// progress notification, and a notice when a run stops without a passage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunSignal {
    /// `phase`: thinking, writing, organizing or checking; `chars`: words written so far.
    Phase { run_id: String, execution_id: String, world_id: String, title: String, phase: &'static str, chars: usize },
    /// `status`: paused, failed or cancelled; `reason` is player-facing.
    Ended { run_id: String, world_id: String, title: String, status: &'static str, reason: String },
    /// Retires the live notification target for this launch, including success.
    Finished { run_id: String, execution_id: String },
}
pub type RunObserver = Arc<dyn Fn(RunSignal) + Send + Sync>;
/// The phase a request stands for, for the progress notification.
pub fn signal_phase(purpose: &str) -> &'static str {
    if purpose.starts_with("reference-review") { "checking" }
    else if purpose.starts_with("writing:") || purpose.starts_with("tool:compose_draft") || purpose.starts_with("tool:check_draft") { "thinking" }
    else { "organizing" }
}

/// Owns whole runs, never a UI subscription. Model waits hold no SQLite lock.
pub struct Engine {
    pub store: Store,
    pub(crate) model: Arc<dyn Model>,
    active: Mutex<HashMap<String, ActiveRun>>,
    lease: LeaseFactory,
    pub(crate) committed: CompletionSink,
    observer: Mutex<Option<RunObserver>>,
    live_events: Mutex<Option<LiveEventSink>>,
}
struct ActiveRun { execution_id: String, ticket: execution_lease::LeaseTicket, cancel: CancellationToken, system: Arc<std::sync::OnceLock<String>> }
fn notification_target(plan:&RunPlan)->(String,String) {
    match execution_lease::ticket(plan) {
        Ok(Some(ticket))=>(ticket.owner_id.clone(),ticket.execution_id()),
        _=>(plan.id.clone(),String::new()),
    }
}
pub(crate) struct Context {
    pub(crate) plan: RunPlan,
    pub(crate) budget: RunBudget,
    pub(crate) draft: Value,
    pub(crate) started: Instant,
    pub(crate) active_before: u64,
    pub(crate) cancel: CancellationToken,
    /// Where in the passage this launch is, for the failure record (D166).
    pub(crate) stage: crate::failure::Stage,
    last_reply_step: Option<String>,
    replayed_reply: bool,
    /// Model requests counted before this launch, so a failure can say how
    /// many this attempt sent (zero means it replayed or was refused locally).
    pub(crate) requests_before: u32,
}
impl Context {
    pub(crate) fn new(plan: RunPlan, budget: RunBudget, draft: Value, cancel: CancellationToken) -> Context {
        let active_before = budget.active_ms;
        let requests_before = budget.model_requests;
        Context { plan, budget, draft, started: Instant::now(), active_before, cancel, stage: crate::failure::Stage::Prepare, requests_before, last_reply_step: None, replayed_reply: false }
    }
    pub(crate) fn failure(&self, error: &Error) -> Value {
        let mut failure = crate::failure::record(error, self.stage, self.budget.model_requests.saturating_sub(self.requests_before));
        if crate::failure::kind_of(error).after_reply() && self.stage != crate::failure::Stage::Settle {
            if let Some(key) = &self.last_reply_step {
                failure["replyStep"] = key.clone().into();
            }
        }
        failure
    }
    pub(crate) fn budget(&mut self) -> RunBudget {
        self.budget.active_ms = self.active_before + self.started.elapsed().as_millis() as u64;
        self.budget.clone()
    }
    fn step_budget(&mut self)->RunBudget {
        let mut used=self.budget();
        // A run continued after a pause counts from that point (resumeBudgetBase, D159);
        // an autoplay passage counts from its own start (stepBudgetBase).
        // When both apply, the later point wins (counters only grow).
        let resume=&self.plan.meta["resumeBudgetBase"];
        let passage=self.plan.meta["autoplayBudgetVersion"]=="per-passage-1"&&self.plan.meta["parentRun"].is_string();
        let step=&self.plan.meta["stepBudgetBase"];
        let later=|a:&Value,b:&Value| (a["modelRequests"].as_u64(),a["activeMs"].as_u64()) >= (b["modelRequests"].as_u64(),b["activeMs"].as_u64());
        let chosen=match (resume.is_object(),passage&&step.is_object()) {(true,true)=>Some(if later(resume,step){resume}else{step}),(true,false)=>Some(resume),(false,true)=>Some(step),(false,false)=>None};
        if let Some(base)=chosen.cloned(){
            let base=&base;
            used.model_requests=used.model_requests.saturating_sub(base["modelRequests"].as_u64().unwrap_or(0) as u32);
            used.tool_calls=used.tool_calls.saturating_sub(base["toolCalls"].as_u64().unwrap_or(0) as u32);
            used.corrections=used.corrections.saturating_sub(base["corrections"].as_u64().unwrap_or(0) as u32);
            used.active_ms=used.active_ms.saturating_sub(base["activeMs"].as_u64().unwrap_or(0));
        }
        used
    }
    fn charge_request(&mut self)->Result<()>{self.step_budget().request()?;self.budget.model_requests+=1;Ok(())}
    fn charge_tool(&mut self)->Result<()>{self.step_budget().tool()?;self.budget.tool_calls+=1;Ok(())}
}
pub(crate) type Shared = Arc<Mutex<Context>>;

impl Engine {
    pub fn new(
        store: Store,
        model: Arc<dyn Model>,
        lease: LeaseFactory,
        committed: CompletionSink,
    ) -> Self {
        Self {
            store,
            model,
            active: Mutex::new(HashMap::new()),
            lease,
            committed,
            observer: Mutex::new(None),
            live_events: Mutex::new(None),
        }
    }
    /// Progress and stop signals for a host's notifications; one observer at a time.
    pub fn observe(&self, observer: RunObserver) {
        if let Ok(mut slot) = self.observer.lock() { *slot = Some(observer); }
    }
    /// Live push sink for native UI streaming without per-token SQLite polling (R31-P3).
    pub fn on_live_event(&self, sink: LiveEventSink) {
        if let Ok(mut slot) = self.live_events.lock() { *slot = Some(sink); }
    }
    pub(crate) fn push_live_event(&self, plan: &RunPlan, seq: u64, event: &Value) {
        if let Some(sink) = self.live_events.lock().ok().and_then(|s| s.clone()) {
            if let Some(parent) = plan.meta["parentRun"].as_str() {
                sink(parent, seq, event);
            }
            sink(&plan.id, seq, event);
        }
    }
    pub(crate) fn emit_run_event(&self, plan: &RunPlan, event: Value) -> Result<crate::RunEvent> {
        let (saved, parent) = self.store.run_event_pair(plan, event)?;
        if let Some(sink) = self.live_events.lock().ok().and_then(|s| s.clone()) {
            if let Some((parent_id, parent_seq)) = parent {
                sink(&parent_id, parent_seq, &saved.event);
            }
            sink(&plan.id, saved.seq, &saved.event);
        }
        Ok(saved)
    }
    fn observer(&self) -> Option<RunObserver> {
        self.observer.lock().ok().and_then(|o| o.clone())
    }
    /// The story's name for a notification: the new world's title, else the saved one.
    fn signal_title(&self, plan: &RunPlan) -> String {
        if let Some(world) = &plan.new_world { return world["title"].as_str().unwrap_or("").to_owned(); }
        self.store.lock().ok().and_then(|db| db.query_row("SELECT title FROM worlds WHERE id=?", [&plan.world_id], |r| r.get::<_, String>(0)).optional().ok().flatten()).unwrap_or_default()
    }
    fn signal_phase(&self, plan: &RunPlan, phase: &'static str, chars: usize) {
        if plan.kind == "maintain" { return; }
        if let Some(observer) = self.observer() {
            let (run_id,execution_id)=notification_target(plan);
            observer(RunSignal::Phase { run_id, execution_id, world_id: plan.world_id.clone(), title: self.signal_title(plan), phase, chars });
        }
    }
    /// Only called once by a fresh native process, before accepting requests.
    pub fn recover_on_start(&self) -> Result<()> {
        self.store.initialize()?;
        self.store.recover_orphans()
    }
    pub fn start(self: &Arc<Self>, plan: RunPlan) -> Result<String> {
        self.store.initialize()?;
        // Once per process, before the first run: old records are trimmed (D171).
        static PRUNED: std::sync::Once = std::sync::Once::new();
        PRUNED.call_once(|| { let _ = self.store.prune(Utc::now()); });
        self.store.register(&plan)?;
        let id = plan.id.clone();
        self.launch(plan, RunBudget::default(), json!({}))?;
        Ok(id)
    }
    pub fn snapshot(&self, id: &str, after: u64) -> Result<RunSnapshot> {
        let active_ticket = self
            .active
            .lock()
            .map_err(|_| Error::Cancelled)?
            .get(id)
            .map(|run| run.ticket.clone());
        let snapshot = self.store.snapshot_with_ticket(id, after, active_ticket.as_ref())?;
        // A run nobody is writing any more (its process closed, its lease
        // lapsed) is stopped here, so the page stops waiting and the story is
        // free again; it can be continued (R30).
        if matches!(snapshot.status.as_str(), "running" | "committing")
            && active_ticket.is_none()
            && !self.active.lock().map_err(|_| Error::Cancelled)?.contains_key(id)
            && self.store.interrupt_orphan(id, None)?
        {
            return self.store.snapshot(id, after);
        }
        Ok(snapshot)
    }
    pub fn stop(&self, id: &str) -> Result<RunStopReceipt> {
        let attempt = self.active.lock().map_err(|_| Error::Cancelled)?.get(id).map(|run| run.execution_id.clone());
        self.request_stop(id, attempt.as_deref())
    }
    /// Drawer actions are tied to one launch, including when a run is resumed.
    pub fn stop_execution(&self, id: &str, execution_id: &str) -> Result<RunStopReceipt> {
        self.request_stop(id, Some(execution_id))
    }
    fn request_stop(&self, id: &str, expected: Option<&str>) -> Result<RunStopReceipt> {
        let receipt = self.store.request_stop(id, expected)?;
        if receipt.accepted && !receipt.settled {
            if let Some(run) = self.active.lock().map_err(|_| Error::Cancelled)?.get(id) {
                if receipt.execution_id.as_deref() == Some(run.execution_id.as_str()) {
                    run.cancel.cancel();
                }
            }
        }
        Ok(receipt)
    }
    pub fn stop_all(&self) {
        if let Ok(active) = self.active.lock() {
            for run in active.values() {
                run.cancel.cancel();
            }
        }
    }
    /// The phone stopped background work (a foreground-service timeout or
    /// destruction): recorded as the system's stop, which can be continued,
    /// never as the player's 停止 (R30, D167).
    pub fn system_stop_all(&self, reason: &str) {
        if let Ok(active) = self.active.lock() {
            for run in active.values() {
                let _ = run.system.set(reason.to_owned());
                run.cancel.cancel();
            }
        }
    }
    pub async fn shutdown(&self) {
        self.stop_all();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(6), async {
            loop {
                if self
                    .active
                    .lock()
                    .map(|active| active.is_empty())
                    .unwrap_or(true)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
    }
    pub fn resume(self: &Arc<Self>, id: &str) -> Result<()> {
        let snapshot = self.snapshot(id, u64::MAX)?;
        if self
            .active
            .lock()
            .map_err(|_| Error::Cancelled)?
            .contains_key(id)
        {
            if matches!(snapshot.status.as_str(), "running" | "committing") {
                return Ok(());
            }
            return Err(Error::Busy { holder: "turn".into(), until_ms: 0 });
        }
        if matches!(snapshot.status.as_str(), "committed" | "previewed") {
            return Ok(());
        }
        let mut plan = self.store.plan(id)?;
        // A run paused at its allowance continues with the same allowance again;
        // the totals already used stay recorded (D159). A retry after a failure
        // is a fresh attempt and gets the same allowance (R30).
        if matches!(snapshot.status.as_str(), "paused" | "failed" | "interrupted" | "cancelled") {
            plan.meta["resumeBudgetBase"] = serde_json::to_value(&snapshot.budget)?;
        }
        if matches!(snapshot.status.as_str(), "paused" | "interrupted") {
            plan.meta["keepFallbackOnResume"] = true.into();
        }
        // Store::resume acquires ownership before changing a running flag.
        // A second process cannot mark the first owner's active run stopped.
        self.store.resume(id)?;
        self.launch(plan, snapshot.budget, snapshot.draft)
    }
    pub(crate) fn launch(
        self: &Arc<Self>,
        plan: RunPlan,
        budget: RunBudget,
        mut draft: Value,
    ) -> Result<()> {
        // Registration persists its fencing ticket. Do not run using the
        // caller's earlier copy, or a restarted process's former ownership.
        let resume_base = plan.meta["resumeBudgetBase"].clone();
        let is_resumed = resume_base.is_object();
        let keep_fallback = plan.meta["keepFallbackOnResume"] == true;
        let mut plan = self.store.activate_lease(&plan.id)?;
        // The stored plan does not carry the pause point; keep the one resume() set (D159).
        if is_resumed { plan.meta["resumeBudgetBase"] = resume_base; }
        // If an earlier step in a paused/interrupted run already failed over to a healthy backup service,
        // continue on that backup model instead of reverting to the dead primary (B10).
        // A retry after `"failed"` starts fresh on the primary model first.
        if keep_fallback && draft["fallbackUsed"].is_object() {
            if let Some(backup) = plan.fallback_model.clone().filter(|b| !b.same_service(&plan.model)) {
                plan.model = backup;
            }
        } else if is_resumed && !keep_fallback {
            if let Some(obj) = draft.as_object_mut() {
                obj.remove("fallbackUsed");
            }
        }
        let execution_ticket = execution_lease::ticket(&plan)?.ok_or(Error::Stale)?;
        let execution_id=execution_ticket.execution_id();
        let token = CancellationToken::new();
        let id = plan.id.clone();
        let mut active = self.active.lock().map_err(|_| Error::Cancelled)?;
        if active.contains_key(&id) {
            return Err(Error::Invalid("运行已经在执行".into()));
        }
        let system = Arc::new(std::sync::OnceLock::new());
        active.insert(id.clone(), ActiveRun {execution_id,ticket:execution_ticket.clone(),cancel:token.clone(),system:system.clone()});
        drop(active);
        let engine = self.clone();
        let active_before = budget.active_ms;
        // Time already spent before a pause does not count against the continued run.
        let counted_before = active_before.saturating_sub(plan.meta["resumeBudgetBase"]["activeMs"].as_u64().unwrap_or(0));
        let total_ms = if plan.kind=="autoplay" && plan.meta["autoplayBudgetVersion"]=="per-passage-1" {
            crate::types::RUN_TIME_LIMIT_MS * plan.meta["autoplayCount"].as_u64().unwrap_or(1).clamp(1,100)
        } else {
            crate::types::RUN_TIME_LIMIT_MS
        };
        let context = Arc::new(Mutex::new(Context::new(plan, budget, draft, token.clone())));
        // The lease exists until settlement, including tools, extraction and commit.
        let lease = (self.lease)(total_ms.saturating_sub(counted_before));
        tokio::spawn(async move {
            let _lease = lease;
            let heartbeat_done = CancellationToken::new();
            let heartbeat_stop = heartbeat_done.clone();
            let heartbeat_owner = engine.clone();
            let heartbeat_ticket = execution_ticket.clone();
            let heartbeat_cancel = token.clone();
            let heartbeat = tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_millis(
                    execution_lease::HEARTBEAT_MS,
                ));
                interval.tick().await;
                loop {
                    tokio::select! {
                        _=heartbeat_stop.cancelled()=>break,
                        _=interval.tick()=>{
                            if heartbeat_owner.store.heartbeat_lease(&heartbeat_ticket).is_err() { heartbeat_cancel.cancel(); break; }
                        }
                    }
                }
            });
            let remaining = total_ms.saturating_sub(counted_before);
            let outcome = tokio::select! {
                    _=token.cancelled()=>Err(Error::Cancelled),
                    result=tokio::time::timeout(std::time::Duration::from_millis(remaining),engine.execute(context.clone()))=>match result {
                        Ok(result)=>result,
                        Err(_)=>{token.cancel();Err(Error::Limit(if total_ms == crate::types::RUN_TIME_LIMIT_MS {crate::types::RUN_TIME_LIMIT_TEXT} else {"已达到本次时长上限"}))}
                    }
            };
            let outcome = match outcome {
                Err(Error::Cancelled) if system.get().is_some() => Err(Error::SystemStop(system.get().cloned().unwrap_or_default())),
                other => other,
            };
            // An expired process may finish after another process resumed the
            // same run. It must not overwrite that owner's progress/status.
            let still_owner = engine
                .store
                .lock()
                .and_then(|db| {
                    execution_lease::guard(&db, &execution_ticket, execution_lease::now_ms())
                })
                .is_ok();
            // The lease was lost (the phone slept past it, or another window took
            // the story): stop as interrupted unless someone else resumed it.
            if !still_owner && engine.store.interrupt_orphan(&id, Some(&execution_ticket)).unwrap_or(false) {
                if let (Some(observer), Ok(plan)) = (engine.observer(), context.lock().map(|c| c.plan.clone())) {
                    observer(RunSignal::Ended { run_id: plan.id.clone(), world_id: plan.world_id.clone(), title: engine.signal_title(&plan), status: "interrupted", reason: crate::failure::player_line(crate::failure::FailKind::Interrupted).into() });
                }
            }
            if let (true, Err(error)) = (still_owner, outcome) {
                let status = match &error {
                    Error::Cancelled => "cancelled",
                    Error::Limit(_) => "paused",
                    Error::Stale => "stale",
                    // Not the player's stop: it can be continued like any interruption.
                    Error::SystemStop(_) => "interrupted",
                    _ => "failed",
                };
                let _ = engine.reconcile_children(&context, status);
                let _ = engine.checkpoint(&context);
                let ended = context.lock().ok().map(|c| (c.plan.clone(), c.failure(&error)));
                if let Some((plan, failure)) = ended.filter(|(plan, failure)| {
                    engine
                        .store
                        .finish_owned(plan, status, Some(&error), Some(failure))
                        .is_ok()
                }) {
                    let _ = engine.flush_usage(&id, status);
                    let _ = engine.emit_run_event(&plan, json!({"type":"failed","reason":crate::failure_kind(&error),"detail":error.to_string(),"failure":failure}));
                    // Tidying that did not finish is asked for again by the next passage.
                    if let Some(observer) = engine.observer().filter(|_| plan.kind != "maintain") {
                        observer(RunSignal::Ended { run_id: plan.id.clone(), world_id: plan.world_id.clone(), title: engine.signal_title(&plan), status, reason: crate::failure::player_line(crate::failure::kind_of(&error)).into() });
                    }
                }
            }
            token.cancel();
            heartbeat_done.cancel();
            let _ = heartbeat.await;
            if execution_ticket.owner_id == id {
                if let Some(observer) = engine.observer() {
                    observer(RunSignal::Finished { run_id: id.clone(), execution_id: execution_ticket.execution_id() });
                }
                let _ = engine.store.release_lease(&execution_ticket);
            }
            if let Ok(mut active) = engine.active.lock() {
                active.remove(&id);
            }
        });
        Ok(())
    }
    fn reconcile_children(&self, shared: &Shared, outcome: &str) -> Result<()> {
        let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
        let mut db = self.store.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        execution_lease::guard_plan(&tx, &c.plan)?;
        let counters:(i64,i64,i64)=tx.query_row("SELECT COALESCE(MAX(json_extract(budget_json,'$.modelRequests')),0),COALESCE(MAX(json_extract(budget_json,'$.toolCalls')),0),COALESCE(MAX(json_extract(budget_json,'$.corrections')),0) FROM execution_runs WHERE parent_run=?",[&c.plan.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        c.budget.model_requests = c.budget.model_requests.max(counters.0 as u32);
        c.budget.tool_calls = c.budget.tool_calls.max(counters.1 as u32);
        c.budget.corrections = c.budget.corrections.max(counters.2 as u32);
        let stored: String = tx.query_row(
            "SELECT draft_json FROM execution_runs WHERE id=?",
            [&c.plan.id],
            |r| r.get(0),
        )?;
        let stored: Value = serde_json::from_str(&stored)?;
        if stored["steps"].as_u64().unwrap_or(0) > c.draft["steps"].as_u64().unwrap_or(0) {
            c.draft["steps"] = stored["steps"].clone();
            c.draft["lastNodeId"] = stored["lastNodeId"].clone();
        }
        let mut stmt=tx.prepare("SELECT id FROM execution_runs WHERE parent_run=? AND status<>'committed'")?;
        let children = stmt
            .query_map([&c.plan.id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        let unused_key = format!("autoplayUnusedNote:{}", c.plan.world_id);
        let mut has_unused: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM settings WHERE key=?)",
            [&unused_key],
            |r| r.get(0),
        )?;
        for child_id in &children {
            let child_note_key = format!("autoplayNote:{child_id}");
            let raw_note: Option<String> = tx
                .query_row(
                    "SELECT value FROM settings WHERE key=?",
                    [&child_note_key],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(raw) = raw_note {
                let _ = tx.execute("DELETE FROM settings WHERE key=?", [&child_note_key]);
                if !has_unused {
                    let parsed = serde_json::from_str::<String>(&raw)
                        .ok()
                        .or(Some(raw))
                        .map(|s| s.trim().to_owned())
                        .filter(|s| !s.is_empty());
                    if let Some(note) = parsed {
                        let _ = tx.execute(
                            "INSERT OR IGNORE INTO settings(key, value) VALUES(?1, ?2)",
                            params![unused_key, serde_json::to_string(&note)?],
                        );
                        has_unused = true;
                    }
                }
            }
        }
        tx.execute("UPDATE execution_runs SET status='interrupted' WHERE parent_run=? AND status='running'",[&c.plan.id])?;
        tx.commit()?;
        drop(db);
        drop(c);
        for child in children {
            self.flush_usage(&child, outcome)?;
        }
        Ok(())
    }
    pub(crate) fn checkpoint(&self, shared: &Shared) -> Result<()> {
        let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
        let budget = c.budget();
        self.store.checkpoint_owned(&c.plan, &budget, &c.draft)
    }
    pub(crate) fn check(&self, shared: &Shared) -> Result<()> {
        let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
        if c.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        Store::guard_run(&*self.store.lock()?, &c.plan)?;
        if c.plan.kind=="autoplay"&&c.plan.meta["autoplayBudgetVersion"]=="per-passage-1" {
            if c.step_budget().active_ms>=crate::types::RUN_TIME_LIMIT_MS*c.plan.meta["autoplayCount"].as_u64().unwrap_or(1).clamp(1,100){Err(Error::Limit("连播已达到各段合计的时间保护上限"))}else{Ok(())}
        } else {
            c.step_budget().time()
        }
    }
    async fn complete(
        self: &Arc<Self>,
        shared: &Shared,
        purpose: &str,
        messages: Vec<Value>,
        tools: Vec<Value>,
        aux: bool,
    ) -> Result<Completion> {
        self.complete_with(shared, purpose, messages, tools, aux, false).await
    }
    /// `final_only`: the tier's lookup rounds are spent; the tools stay defined
    /// (the history holds their calls) but the model is asked to write now.
    async fn complete_with(
        self: &Arc<Self>,
        shared: &Shared,
        purpose: &str,
        messages: Vec<Value>,
        tools: Vec<Value>,
        aux: bool,
        final_only: bool,
    ) -> Result<Completion> {
        self.check(shared)?;
        let mut plan = {
            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
            c.stage = crate::failure::Stage::of_purpose(purpose);
            c.last_reply_step = None;
            c.replayed_reply = false;
            c.plan.clone()
        };
        // Cache identity includes the actual task inputs, model and source scope.
        // A resumed, reassembled stage must never consume another request's result.
        // When a downstream stage (e.g. extract/review) failed and the player switched
        // model/auxModel/depth with `allowModelSwitchReuse`, already-completed writing
        // steps may still be reused by their model-independent `input_fingerprint` (R31-P5).
        let fingerprint=format!("{:x}",Sha256::digest(json!({"purpose":purpose,"model":plan.model,"messages":messages,"tools":tools,"state":plan.state,"base":plan.base_id,"source":plan.reference,"finalOnly":final_only.then_some(true)}).to_string()));
        let input_fingerprint=format!("{:x}",Sha256::digest(json!({"purpose":purpose,"messages":messages,"tools":tools,"state":plan.state,"base":plan.base_id,"source":plan.reference,"finalOnly":final_only.then_some(true)}).to_string()));
        let cached: Option<(String,String,String)> = self.store.lock()?.query_row("SELECT step_key,input_json,output_json FROM execution_steps WHERE run_id=? AND kind=? AND status='done' ORDER BY rowid DESC LIMIT 1", params![plan.id,purpose], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((key,input,cached))=cached {
            let input:Value=serde_json::from_str(&input)?;
            let messages_match = || {
                let mut old=input["request"]["messages"].as_array().cloned().unwrap_or_default();
                old.retain(|m|!m["content"].as_str().unwrap_or("").starts_with("【本次执行剩余额度】"));
                old==messages && input["request"]["tools"].as_array().map(Vec::as_slice).unwrap_or(&[])==tools.as_slice()
            };
            let messages_tail_match = || {
                let mut old = input["request"]["messages"].as_array().cloned().unwrap_or_default();
                old.retain(|m| !m["content"].as_str().unwrap_or("").starts_with("【本次执行剩余额度】"));
                old.len() == messages.len() && old.get(1..) == messages.get(1..)
            };
            let allow_switch_reuse = plan.meta["allowModelSwitchReuse"] == true
                && purpose.starts_with("writing:");
            let cached_prose_no_tools = || {
                serde_json::from_str::<Completion>(&cached)
                    .ok()
                    .is_some_and(|c| {
                        c.tool_calls.is_empty()
                            && !chat::strip_inline_think(&c.text).trim().is_empty()
                    })
            };
            let same = input["fingerprint"] == fingerprint
                || (allow_switch_reuse
                    && (input["inputFingerprint"] == input_fingerprint
                        || (input.get("inputFingerprint").is_none() && messages_match())
                        || (messages_tail_match() && cached_prose_no_tools())))
                || (input.get("fingerprint").is_none() && messages_match());
            if same {
                let result = serde_json::from_str(&cached)?;
                shared.lock().map_err(|_| Error::Cancelled)?.replayed_reply = true;
                self.accept_response(shared, &plan, &key, purpose, &result, !tools.is_empty() && !final_only)?;
                self.note_reading(shared,input["request"]["messages"].as_array().map(Vec::as_slice).unwrap_or(&[]))?;
                return Ok(result);
            }
        }
        let mut allowance: Option<String> = None;
        let request_limit = plan.meta["modelRequestLimit"]
            .as_u64()
            .unwrap_or(crate::types::RUN_REQUEST_LIMIT as u64)
            .clamp(1, crate::types::RUN_REQUEST_LIMIT as u64) as u32;
        {
            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
            c.budget();
            if c.step_budget().model_requests >= request_limit {
                return Err(Error::Limit(if request_limit == crate::types::RUN_REQUEST_LIMIT {
                    "本次生成用到的模型请求较多，已先停下"
                } else {
                    "本次模型请求额度已用完"
                }));
            }
            // run-budget-3 (D161): the allowance is a backstop, so it is only
            // mentioned when almost spent, and at the end of the request: a
            // changing first message would defeat the service's prefix cache.
            if purpose != "capability" {
                let local_used=c.step_budget();let left = request_limit - local_used.model_requests;
                if left <= 3 {
                    allowance = Some(format!("【本次执行剩余额度】包括当前这次，尚可请求模型{left}次；工具还可调用{}次。停止非必要补查：有依据就按本次任务要求输出完整结果；缺依据须明确资料不足，不编造。若本次是最后一次模型请求，完成所需最终输出；Agent用commit_turn，原著改稿返回要求的完整JSON。",crate::types::RUN_TOOL_LIMIT.saturating_sub(local_used.tool_calls)));
                }
            }
        }
        let mut messages = messages;
        if final_only {
            let last = if plan.kind == "correction" { correction::CORRECTION_FINAL } else { "【查阅到此为止】本档的资料查询已用完。依据上文已有的设定、札记和原文直接写出本次的完整结果，不要再调用工具；资料不足之处按已知写，不编造原著细节。" };
            messages.push(json!({"role":"system","content":last}));
        }
        if let Some(note) = allowance {
            messages.push(json!({"role":"system","content":note}));
        }
        let before=crate::stage_context::report(&plan,purpose,&messages,&tools);
        let bounded = crate::context::fit_writing_context(&plan, messages, &tools);
        let target = plan.meta["budgetChars"].as_u64().unwrap_or(12000);
        let mut messages = match bounded {
            Ok(messages) => messages,
            Err(error) => {
                let mut report = before.clone();
                report["beforeChars"] = before["chars"].clone();
                report["status"] = "invalid".into();
                self.record_context_report(shared, &plan, purpose, report)?;
                return Err(Error::fail(crate::failure::FailKind::Context,
                    format!("{}：{}", crate::stage_context::label(purpose), error)));
            }
        };
        // Pin already-read correction passages AFTER context trimming so omitted earlier reads stay quotable
        // without fighting `bound_sources` or duplicating still-visible JSON-escaped tool results.
        if plan.kind == "correction" && purpose.starts_with("writing:") {
            let used = crate::context::request_size(&messages, &tools);
            let headroom = (target as usize).saturating_sub(used);
            let ledger_budget = if headroom > 400 {
                (headroom * 4).min(target as usize)
            } else {
                (target as usize / 2).min(4000)
            };
            messages = correction::with_read_ledger(shared, messages, ledger_budget)?;
        }
        let mut tools = tools;
        let mut retried = false;
        let mut context_recovered = false;
        let mut max_tokens_steps = 0u8;
        let mut swapped_max_completion = false;
        loop {
            self.check(shared)?;
            let body = chat::request_with(&plan.model, &messages, &tools, aux, final_only);
            let mut report = crate::stage_context::report(&plan, purpose, &messages, &tools);
            report["beforeChars"] = before["chars"].clone();
            report["requestChars"] = crate::stage_context::units(&body.to_string()).into();
            report["outputTokens"] = body["max_tokens"].clone();
            report["status"] = if context_recovered { "context-retry" }
                else if report["chars"].as_u64().unwrap_or(0) > target { "above-target" } else { "ready" }.into();
            self.record_context_report(shared, &plan, purpose, report)?;
            let (key, token, remaining) = {
                let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                c.budget();
                if c.step_budget().model_requests >= request_limit {
                    return Err(Error::Limit(if request_limit == crate::types::RUN_REQUEST_LIMIT {
                        "本次生成用到的模型请求较多，已先停下"
                    } else {
                        "本次模型请求额度已用完"
                    }));
                }
                c.charge_request()?;
                (
                    format!("model:{}", c.budget.model_requests),
                    c.cancel.clone(),
                    crate::types::RUN_TIME_LIMIT_MS.saturating_sub(c.step_budget().active_ms),
                )
            };
            self.checkpoint(shared)?;
            self.store.owned(&plan, |tx| {
                Store::guard_run(tx, &plan)?;
                tx.execute("INSERT INTO execution_steps(run_id,step_key,kind,status,input_json) VALUES(?,?,?,'running',?)", params![plan.id,key,purpose,json!({"fingerprint":fingerprint,"inputFingerprint":input_fingerprint,"model":if aux {plan.model.aux_model.as_ref().unwrap_or(&plan.model.model)} else {&plan.model.model},"purpose":purpose,"request":body}).to_string()])?;
                Ok(())
            })?;
            let show_text = purpose.starts_with("writing:")
                || purpose.starts_with("tool:compose_draft")
                || purpose.starts_with("tool:check_draft");
            if show_text {
                self.emit_run_event(&plan, json!({"type":"thinking"}))?;
            }
            self.signal_phase(&plan, signal_phase(purpose), 0);
            let store = self.store.clone();
            let progress_plan = plan.clone();
            let live_sink = self.live_events.lock().ok().and_then(|s| s.clone());
            let original = if plan.kind == "continue" {
                plan.original.clone()
            } else {
                String::new()
            };
            let progress = self.observer().filter(|_| show_text).map(|observer| {
                let (run_id, execution_id)=notification_target(&plan);
                let (world_id,title)=(plan.world_id.clone(),self.signal_title(&plan));
                let last = Mutex::new((Instant::now(), 0usize));
                move |chars: usize| {
                    let Ok(mut last) = last.lock() else { return };
                    // About once a second, or every 120 words: enough for a notification.
                    if (last.1 == 0 && chars > 0) || chars >= last.1 + 120 || (chars > last.1 && last.0.elapsed().as_millis() >= 1000) {
                        *last = (Instant::now(), chars);
                        observer(RunSignal::Phase { run_id: run_id.clone(), execution_id: execution_id.clone(), world_id: world_id.clone(), title: title.clone(), phase: "writing", chars });
                    }
                }
            });
            // Push live frames over the native event channel (~50ms) while
            // checkpointing SQLite execution_progress every ~1500ms (R31-P3).
            // Once `<record` starts, freeze visible narrative emission so
            // streaming does not keep cloning/re-scanning the full text.
            let live_pushed = Mutex::new(None::<Instant>);
            let db_written = Mutex::new(None::<Instant>);
            let record_seen = std::sync::atomic::AtomicBool::new(false);
            let last_visible_len = std::sync::atomic::AtomicUsize::new(0);
            let deep_thinking_emitted = std::sync::atomic::AtomicBool::new(false);
            let held = Arc::new(Mutex::new(None::<Value>));
            let held_in = held.clone();
            let sink: TextSink = Arc::new(move |text| {
                if text == "\0phase:thinking" {
                    if show_text
                        && !record_seen.load(std::sync::atomic::Ordering::Relaxed)
                        && last_visible_len.load(std::sync::atomic::Ordering::Relaxed) == 0
                        && !deep_thinking_emitted.swap(true, std::sync::atomic::Ordering::Relaxed)
                    {
                        let event = json!({"type":"thinking","deep":true});
                        if let Some(live) = &live_sink {
                            if let Some(parent) = progress_plan.meta["parentRun"].as_str() {
                                live(parent, 0, &event);
                            }
                            live(&progress_plan.id, 0, &event);
                        }
                        let _ = store.run_event(&progress_plan, event);
                    }
                    return;
                }
                if text.starts_with('\0') {
                    return;
                }
                if !show_text || record_seen.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                let (clean_text, inline_thinking) = chat::split_inline_think(&text);
                if !inline_thinking.is_empty()
                    && last_visible_len.load(std::sync::atomic::Ordering::Relaxed) == 0
                    && !deep_thinking_emitted.swap(true, std::sync::atomic::Ordering::Relaxed)
                {
                    let event = json!({"type":"thinking","deep":true});
                    if let Some(live) = &live_sink {
                        if let Some(parent) = progress_plan.meta["parentRun"].as_str() {
                            live(parent, 0, &event);
                        }
                        live(&progress_plan.id, 0, &event);
                    }
                    let _ = store.run_event(&progress_plan, event);
                }
                let has_record = find_record_tag(&clean_text).is_some();
                let visible = narrative_part(&clean_text);
                if has_record {
                    record_seen.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                if visible.is_empty() { return; }
                let prev_len = last_visible_len.swap(visible.len(), std::sync::atomic::Ordering::Relaxed);
                if visible.len() == prev_len && !has_record {
                    return;
                }
                if let Some(progress) = &progress { progress(visible.chars().count()); }
                let event = json!({"type":"text","delta":"","full":format!("{original}{visible}")});
                if let Some(live) = &live_sink {
                    let live_due = has_record || live_pushed.lock().map(|mut last| {
                        let due = last.is_none_or(|at| at.elapsed().as_millis() >= 50);
                        if due { *last = Some(Instant::now()); }
                        due
                    }).unwrap_or(true);
                    if live_due {
                        if let Some(parent) = progress_plan.meta["parentRun"].as_str() {
                            live(parent, 0, &event);
                        }
                        live(&progress_plan.id, 0, &event);
                    }
                }
                let db_interval_ms: u128 = if live_sink.is_some() { 1500 } else { 250 };
                let due = has_record || db_written.lock().map(|mut last| {
                    let due = last.is_none_or(|at| at.elapsed().as_millis() >= db_interval_ms);
                    if due { *last = Some(Instant::now()); }
                    due
                }).unwrap_or(true);
                if !due {
                    if let Ok(mut held) = held_in.lock() { *held = Some(event); }
                    return;
                }
                if let Ok(mut held) = held_in.lock() { *held = None; }
                let _ = store.run_event(&progress_plan, event);
            });
            let call_started = Instant::now();
            let future = self
                .model
                .complete(plan.model.clone(), body, token.child_token(), sink);
            let result = tokio::select! {
                _ = token.cancelled() => Err(Error::Cancelled),
                result = tokio::time::timeout(std::time::Duration::from_millis(remaining), future) => match result {
                    Ok(value) => value,
                    Err(_) => { token.cancel(); Err(Error::Limit(crate::types::RUN_TIME_LIMIT_TEXT)) }
                }
            };
            if let Some(event) = held.lock().ok().and_then(|mut held| held.take()) {
                self.emit_run_event(&plan, event)?;
            }
            self.checkpoint(shared)?;
            match result {
                Ok(result) => {
                    self.store.owned(&plan, |tx| {
                        tx.execute("UPDATE execution_steps SET status='done',output_json=? WHERE run_id=? AND step_key=?", params![serde_json::to_string(&result)?, plan.id,key])?;
                        Ok(())
                    })?;
                    self.accept_response(shared, &plan, &key, purpose, &result, !tools.is_empty() && !final_only)?;
                    self.note_reading(shared, &messages)?;
                    return Ok(result);
                }
                Err(error) => {
                    let elapsed_ms = call_started.elapsed().as_millis() as u64;
                    let status = if crate::failure::kind_of(&error) == crate::failure::FailKind::Setup {
                        "unsent"
                    } else if matches!(error, Error::Cancelled) {
                        "cancelled"
                    } else if matches!(error, Error::SystemStop(_)) {
                        "interrupted"
                    } else {
                        "failed"
                    };
                    self.store.owned(&plan, |tx| {
                        tx.execute("UPDATE execution_steps SET status=?,output_json=? WHERE run_id=? AND step_key=?", params![status,json!({"error":error.to_string(),"totalMs":elapsed_ms}).to_string(),plan.id,key])?;
                        Ok(())
                    })?;
                    let within_budget = shared.lock().map_err(|_| Error::Cancelled)?.step_budget().model_requests < request_limit;
                    let can_retry = !retried && within_budget;
                    if can_retry && matches!(error, Error::ContextWindow) {
                        if let Some((smaller, definitions)) = crate::context::recover_writing_request(&plan, &messages, &tools)? {
                            retried = true;
                            context_recovered = true;
                            messages = smaller;
                            tools = definitions;
                            continue;
                        }
                    }
                    if within_budget {
                        if let Error::Provider { kind, status, message, partial: false } = &error {
                            if kind == "http" {
                                if !swapped_max_completion
                                    && !plan.model.extra.contains_key("max_completion_tokens")
                                    && chat::provider_wants_max_completion_tokens(*status, message)
                                {
                                    let limit = plan.model.max_output_tokens();
                                    plan.model.extra.insert("max_completion_tokens".into(), limit.into());
                                    {
                                        let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                                        c.plan.model.extra.insert("max_completion_tokens".into(), limit.into());
                                    }
                                    swapped_max_completion = true;
                                    continue;
                                }
                                if max_tokens_steps < 4
                                    && chat::provider_max_tokens_rejected(*status, message)
                                {
                                    if let Some(next_max) =
                                        chat::next_max_tokens_stepdown(plan.model.max_output_tokens())
                                    {
                                        plan.model.extra.remove("maxOutputTokens");
                                        plan.model.max_tokens = Some(next_max);
                                        if plan.model.extra.contains_key("max_completion_tokens") {
                                            plan.model
                                                .extra
                                                .insert("max_completion_tokens".into(), next_max.into());
                                        }
                                        {
                                            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                                            c.plan.model.extra.remove("maxOutputTokens");
                                            c.plan.model.max_tokens = Some(next_max);
                                            if c.plan.model.extra.contains_key("max_completion_tokens") {
                                                c.plan
                                                    .model
                                                    .extra
                                                    .insert("max_completion_tokens".into(), next_max.into());
                                            }
                                        }
                                        max_tokens_steps += 1;
                                        continue;
                                    }
                                }
                            }
                        }
                    }
                    if can_retry {
                        if let Some(delay) = transient_retry_delay(&error) {
                            retried = true;
                            tokio::select! {
                                _ = token.cancelled() => return Err(Error::Cancelled),
                                _ = tokio::time::sleep(delay) => {}
                            }
                            continue;
                        }
                    }
                    // 备用服务 (D179): the main service failed this step again for a
                    // passing reason; the backup answers it, and the rest of this run.
                    // A request that offers tools never goes to a backup already known not to take them:
                    // it could only fail there too (R30 step 3).
                    let backup_without_tools = |backup: &crate::types::ModelConfig| {
                        !tools.is_empty() && self.cached_tool_support(backup).ok().flatten() == Some(false)
                    };
                    let backup = plan.fallback_model.clone().filter(|backup| !backup.same_service(&plan.model) && crate::failure::fallback_eligible(&error) && !backup_without_tools(backup));
                    if let Some(backup) = backup {
                        if shared.lock().map_err(|_| Error::Cancelled)?.step_budget().model_requests < request_limit {
                            let from = plan.model.model.clone();
                            plan.model = backup.clone();
                            {
                                let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                                // Keep the model that wrote the prose if failover only happened on an aux helper stage (B07).
                                if !aux && c.draft["proseModel"].is_null() {
                                    c.draft["proseModel"] = backup.model.clone().into();
                                }
                                c.plan.model = backup.clone();
                                c.draft["fallbackUsed"] = json!({"from": from, "to": backup.model, "reason": crate::failure_kind(&error)});
                            }
                            self.emit_run_event(&plan, json!({"type":"fallback","from":from,"to":backup.model}))?;
                            retried = false;
                            max_tokens_steps = 0;
                            swapped_max_completion = false;
                            continue;
                        }
                    }
                    return match error {
                        Error::Cancelled | Error::Limit(_) | Error::Stale | Error::ContextWindow
                        | Error::Provider { .. } | Error::Refused(_) | Error::SystemStop(_) | Error::Busy { .. } => Err(error),
                        other => Err(Error::fail(crate::failure::kind_of(&other), format!("{}：{}", crate::stage_context::label(purpose), other))),
                    };
                }
            }
        }
    }

    fn record_context_report(&self, shared: &Shared, plan: &RunPlan, purpose: &str, report: Value) -> Result<()> {
        {
            let mut context = shared.lock().map_err(|_| Error::Cancelled)?;
            if !context.draft["contextReports"].is_object() {
                context.draft["contextReports"] = json!({});
            }
            context.draft["contextReports"][purpose] = report.clone();
            context.draft["phase"] = purpose.into();
        }
        self.checkpoint(shared)?;
        self.store.run_event(plan, json!({"type":"request-context","report":report}))?;
        Ok(())
    }

    fn accept_response(
        &self, shared: &Shared, plan: &RunPlan, key: &str, purpose: &str,
        result: &Completion, allow_tool_calls: bool,
    ) -> Result<()> {
        shared.lock().map_err(|_| Error::Cancelled)?.last_reply_step = Some(key.to_owned());
        let clean_text = chat::strip_inline_think(&result.text);
        let error = if stopped_by_service(result) {
            Some(Error::Refused(format!("AI 服务拒绝了本次{}，原路线未改动", crate::stage_context::label(purpose))))
        } else if output_cut_short(result) && !complete_prose_before_record(plan, purpose, result) {
            let label = crate::stage_context::label(purpose);
            if purpose.starts_with("writing:") && is_story_plan(plan) {
                let visible = narrative_part(&clean_text);
                if !visible.is_empty() {
                    let prefix = if plan.kind == "continue" { plan.original.as_str() } else { "" };
                    shared.lock().map_err(|_| Error::Cancelled)?.draft["partialNarrative"] = format!("{prefix}{visible}").into();
                }
            }
            Some(Error::fail(crate::failure::FailKind::Format, format!("{label}受到模型输出长度限制，已保留进度")))
        } else if clean_text.trim().is_empty() && !(allow_tool_calls && !result.tool_calls.is_empty()) {
            Some(Error::fail(crate::failure::FailKind::Empty, format!("AI 没有返回可用的{}", crate::stage_context::label(purpose))))
        } else {
            None
        };
        if let Some(error) = error {
            return Err(error);
        }
        Ok(())
    }

    // A tool returning evidence is not yet a model reading it. Only record
    // excerpts which survived request budgeting and reached a completed call.
    fn note_reading(&self, shared: &Shared, messages: &[Value]) -> Result<()> {
        let mut passages = vec![];
        let mut skill = false;
        let mut insufficient = false;
        fn collect(value: &Value, passages: &mut Vec<Value>, insufficient: &mut bool) {
            if value["status"] == "insufficient" {
                *insufficient = true;
            }
            if let Some(excerpts) = value.get("excerpts").and_then(Value::as_array) {
                for excerpt in excerpts {
                    if excerpt["kind"] == "original"
                        && excerpt["text"].as_str().is_some_and(|s| !s.is_empty())
                        && !passages.contains(excerpt)
                    {
                        passages.push(excerpt.clone());
                    }
                }
            }
        }
        let plan=shared.lock().map_err(|_|Error::Cancelled)?.plan.clone();
        for passage in plan.reference.as_ref().and_then(|r|r["passages"].as_array()).into_iter().flatten(){
            if passage["kind"]=="original" && passage["text"].as_str().filter(|s|!s.is_empty()).is_some_and(|body|messages.iter().any(|m|m["content"].as_str().is_some_and(|s|s.contains(body)))){passages.push(passage.clone());}
        }
        for message in messages.iter().filter(|m| m["role"] == "tool") {
            let Some(content) = message["content"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
            else {
                continue;
            };
            if content["isError"] == true {
                continue;
            }
            collect(&content, &mut passages, &mut insufficient);
            skill |= content["name"] == "canon-reference"
                && content["body"].as_str().is_some_and(|s| !s.is_empty());
        }
        {
            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
            if !passages.is_empty() {
                c.draft["originalRead"] = true.into();
                // Keep chronological order (oldest first, newest last) so `read_ledger` (.rev()) pins newest reads first.
                let mut combined = c.draft["originalPassages"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for passage in passages {
                    combined.retain(|p| p != &passage);
                    combined.push(passage);
                }
                c.draft["originalPassages"] = Value::Array(combined);
            }
            if skill {
                c.draft["canonSkillRead"] = true.into();
            }
            if insufficient {
                c.draft["insufficientRead"] = true.into();
            }
        }
        self.checkpoint(shared)
    }
    pub(crate) async fn execute(self: &Arc<Self>, shared: Shared) -> Result<()> {
        let plan = shared.lock().map_err(|_| Error::Cancelled)?.plan.clone();
        match plan.kind.as_str() {
            "autoplay" => return Box::pin(self.execute_autoplay(shared)).await,
            "maintain" => return self.maintain(shared).await,
            "turn" | "variant" | "continue" | "opening" | "correction" | "ask" => {},
            _ => return Err(Error::Invalid("不支持的运行类型".into())),
        }
        if plan.new_world.is_none() {
            let mut db = self.store.lock()?;
            let tx = db.transaction()?;
            Store::guard(&tx, &plan)?;
            tx.commit()?;
        }
        let owner = self.clone();
        let session_context = shared.clone();
        let mcp = BuiltinMcp::open(Arc::new(move |name, args| {
            let owner = owner.clone();
            let shared = session_context.clone();
            Box::pin(async move { owner.dispatch(shared, name, args).await })
                as BoxFuture<Result<Value>>
        }))
        .await?;
        let all_tools = mcp.tools().await?;
        let has_book = plan.reading_source().is_object();
        let tools: Vec<Value> = all_tools
            .into_iter()
            .filter(|t| is_read_tool(t["function"]["name"].as_str().unwrap_or("")))
            .collect();
        let mut messages = plan.messages.clone();
        // Ordinary passages already carry the world, rules and recalled facts in
        // their context: telling the model to read skills first cost two extra
        // requests per turn. Checks and corrections keep the full instruction.
        // Generation tier (D161). Plans written before tiers keep the old
        // behaviour; checks, corrections and questions are not tiered.
        let ordinary = matches!(plan.kind.as_str(), "turn" | "variant" | "continue" | "opening" | "autoplay");
        let tier = Tier::of(&plan);
        let rules = if ordinary {
            match tier {
                Tier::Fast => ORDINARY_RULES_FAST.to_owned(),
                Tier::Standard => ORDINARY_RULES_STANDARD.to_owned(),
                Tier::Deep => format!("{}\n{}", crate::skills::catalog_brief(), ORDINARY_RULES),
            }
        } else if plan.kind == "correction" {
            CORRECTION_RULES.to_owned()
        } else if plan.kind == "ask" {
            ASK_RULES.to_owned()
        } else {
            format!("{}\n{}", crate::skills::catalog_text(), CLASSIC_RULES)
        };
        messages.insert(0,json!({"role":"system","content":rules}));
        // 按原著纠错 (D182): the canon-reference skill's writing part comes with the
        // task instead of costing one of its few lookup rounds.
        if plan.kind == "correction" {
            if let Ok(skill) = crate::skills::read_writing("canon-reference") {
                let version = skill["metadata"]["version"].clone();
                messages.insert(1, json!({"role":"system","content":format!("【遵循原著技能 canon-reference {}，已随本次任务提供，不必再读】\n{}", version.as_str().unwrap_or(""), skill["body"].as_str().unwrap_or(""))}));
                let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                c.draft["canonSkillRead"] = true.into();
                c.draft["skillVersions"]["canon-reference"] = version;
            }
        }
        if let Some(saved) = shared
            .lock()
            .map_err(|_| Error::Cancelled)?
            .draft
            .get("messages")
            .and_then(Value::as_array)
        {
            messages = saved.clone();
        }
        // A real tool roundtrip is the capability test. Never infer from a vendor name.
        let modern=plan.kind=="ask"||plan.meta["writingContext"].is_object()||plan.meta["correctionRange"].is_object()||plan.meta["depth"].is_string()||matches!(plan.meta["referenceReviewVersion"].as_str(),Some("reference-review-1"|"reference-review-2"|"reference-review-3"|"reference-review-4"|"reference-review-lite-1"|"reference-review-lite-2"|"reference-review-lite-3"|"reference-review-lite-4"|"reference-review-lite-5"));
        let support = if tier == Tier::Fast && plan.kind != "ask" {
            false
        } else if modern {
            self.cached_tool_support(&plan.model)?.unwrap_or(true)
        } else if has_book {
            self.tool_capability(&shared).await?
        } else {
            false
        };
        if plan.kind == "correction" && !support {
            return Err(Error::fail(crate::failure::FailKind::Unsupported,"这个服务与模型尚不支持所需工具调用，请更换支持工具的模型；文字润色仍可使用"));
        }
        let mut active_tools = if support {
            tools
                .into_iter()
                .filter(|t| {
                    let name = t["function"]["name"].as_str().unwrap_or("");
                    has_book || !["list_sections","search_original","read_original","read_canon_facts","locate_original_event","prepare_reference_check"].contains(&name)
                })
                .filter(|t| {
                    let name = t["function"]["name"].as_str().unwrap_or("");
                    if plan.kind == "correction" {
                        CORRECTION_TOOLS.contains(&name)
                    } else if plan.kind == "ask" {
                        ASK_TOOLS.contains(&name)
                    } else {
                        tier != Tier::Standard || STANDARD_TOOLS.contains(&name)
                    }
                })
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        // 资料范围 (D184): only the chosen notes → no tool that reads the original; a
        // range of chapters → no whole-book reference tools.
        let scoped_out: &[&str] = if crate::runtime_sources::notes_only(&plan) { &["list_sections","search_original","read_original","read_canon_facts","locate_original_event","prepare_reference_check"] } else if crate::runtime_sources::scope_range(&plan).is_some() { &["locate_original_event","prepare_reference_check"] } else { &[] };
        active_tools.retain(|t| !scoped_out.contains(&t["function"]["name"].as_str().unwrap_or("")));
        // Lookup rounds before the model must write; questions and checks keep
        // the open loop, bounded only by the run allowance.
        // A correction or a question gets a handful of lookup rounds, then must
        // answer with what it found: one that cannot find a basis says so instead
        // of searching until the run's allowance stops it (R30 step 2).
        let tool_rounds = if ordinary { tier.tool_rounds() } else if matches!(plan.kind.as_str(), "correction" | "ask") { Some(LOOKUP_ROUNDS) } else { None };
        // The native validator owns machine-width bounds. Avoid repeating the
        // 16-digit JS safe-integer ceiling for every locator in each request;
        // meaningful limits (neighbours, batch sizes, text) remain visible.
        if modern {for tool in &mut active_tools{compact_locator_schema(&mut tool["function"]["parameters"]);}}
        let mut round = shared.lock().map_err(|_| Error::Cancelled)?.draft["round"]
            .as_u64()
            .unwrap_or(0);
        // When resuming a paused lookup run (接着查), grant a fresh batch of lookup rounds from `round`.
        let resume_round_base = if plan.meta["resumeBudgetBase"].is_object() { round } else { 0 };
        let result = loop {
            self.check(&shared)?;
            let final_only = !active_tools.is_empty() && tool_rounds.is_some_and(|n| round >= resume_round_base.saturating_add(n));
            let attempt=self.complete_with(&shared,&format!("writing:{round}"),messages.clone(),active_tools.clone(),false,final_only).await;
            let response=match attempt {
                Err(error) if modern&&plan.kind!="correction"&&round==0&&!active_tools.is_empty()&&["unsupported tool","tool is not supported","does not support tools","tools are not supported","does not support tool use","不支持工具"].iter().any(|s|error.to_string().to_lowercase().contains(s))=>{
                    self.save_observed_tool_support(&shared, false)?;
                    active_tools.clear();
                    continue;
                },
                other=>other?,
            };
            if response.tool_calls.is_empty() || final_only {
                // A service that ignores tool_choice "none" still ends here:
                // whatever text came back is the passage.
                let mut response = response;
                response.tool_calls.clear();
                {
                    let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                    let wrote = c.plan.model.model.clone();
                    c.draft["proseModel"] = wrote.into();
                }
                break response;
            }
            // Validate the whole group before saving any tool result from this reply.
            let arguments = response.tool_calls.iter().map(|call| {
                let raw = call["function"]["arguments"].as_str().unwrap_or_default();
                serde_json::from_str::<Value>(if raw.trim().is_empty() { "{}" } else { raw })
                    .ok().filter(Value::is_object)
                    .ok_or_else(|| Error::fail(crate::failure::FailKind::Format, "AI 调用资料工具的参数不完整，可以再试一次"))
            }).collect::<Result<Vec<_>>>()?;
            self.save_observed_tool_support(&shared, true)?;
            messages.push(chat::assistant_message(&response));
            for (call, args) in response.tool_calls.iter().zip(arguments) {
                let name = call["function"]["name"].as_str().unwrap_or("");
                let key = format!("tool:{round}:{}", call["id"].as_str().unwrap_or(""));
                let cached: Option<String> = self.store.lock()?.query_row(
                    "SELECT output_json FROM execution_steps WHERE run_id=? AND step_key=? AND status='done' AND kind=? AND input_json=?",
                    params![plan.id,key,name,args.to_string()], |r| r.get(0)).optional()?;
                let output = if let Some(cached) = cached {
                    serde_json::from_str(&cached)?
                } else {
                    {
                        let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                        c.budget();
                        c.charge_tool()?;
                    }
                    self.checkpoint(&shared)?;
                    let output = if !is_read_tool(name) {
                        json!({"isError":true,"message":"经典写作只允许读取资料"})
                    } else {
                        let _ = self.emit_run_event(&plan, json!({"type":"tool","tool":name}));
                        mcp.call(name, &args).await?
                    };
                    self.store.lock()?.execute("INSERT OR REPLACE INTO execution_steps(run_id,step_key,kind,status,input_json,output_json) VALUES(?,?,?,'done',?,?)", params![plan.id,key,name,args.to_string(),output.to_string()])?;
                    if matches!(plan.kind.as_str(), "correction" | "ask") {
                        self.note_lookup(&shared, name, &args, &output)?;
                    }
                    output
                };
                messages.push(
                    json!({"role":"tool","tool_call_id":call["id"],"content":output.to_string()}),
                );
            }
            round += 1;
            {
                let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                c.draft["round"] = round.into();
                c.draft["messages"] = Value::Array(messages.clone());
            }
            self.checkpoint(&shared)?;
        };
        self.check(&shared)?;
        if plan.kind == "ask" {
            let clean = narrative_part(&result.text).trim().to_owned();
            if refused(&result, &clean, false) {
                return Err(Error::Refused("AI 服务拒绝了这次查阅".into()));
            }
            if clean.is_empty() {
                return Err(Error::fail(crate::failure::FailKind::Empty, "AI 没有返回可用的查阅结果"));
            }
            self.finish_preview(&shared, json!({"text":clean}))?;
            return Ok(());
        }
        if plan.kind == "correction" {
            return self.finish_correction(&shared, &plan, &result);
        }
        let raw = result.text.clone();
        let clean_raw = chat::strip_inline_think(&raw);
        let visible_prose = narrative_part(&clean_raw);
        let mut narrative = if let Some(player) = plan.meta["playerNarrative"].as_str() {
            player.to_owned()
        } else {
            format!(
                "{}{}",
                if plan.kind == "continue" {
                    &plan.original
                } else {
                    ""
                },
                visible_prose
            )
        };
        let parsed = if output_cut_short(&result) {
            json!({"record":null})
        } else if plan.meta["playerNarrative"].is_string() {
            rules::record::parse_complete_record(&clean_raw)
        } else {
            let record_start = find_record_tag(&clean_raw);
            rules::record::parse_complete_record(record_start.map(|start| &clean_raw[start..]).unwrap_or(""))
        };
        if plan.kind=="opening"&&parsed["openingTitle"].is_string(){shared.lock().map_err(|_|Error::Cancelled)?.draft["openingTitle"]=parsed["openingTitle"].clone();}
        let mut record = parsed["record"].clone();
        if narrative.trim().is_empty()
            || (!plan.meta["playerNarrative"].is_string() && visible_prose.trim().is_empty())
        {
            return Err(Error::fail(crate::failure::FailKind::Empty, "模型没有写出正文，草稿已保留"));
        }
        if refused(&result, narrative.as_str(), !record.is_null()) {
            return Err(Error::Refused(
                "AI 这次没有给出可用的故事，原路线未改动".into(),
            ));
        }
        if has_book {
            let read = shared.lock().map_err(|_| Error::Cancelled)?.draft["originalRead"]
                .as_bool()
                .unwrap_or(false);
            let supplied = plan
                .reference
                .as_ref()
                .and_then(|r| r.get("passages"))
                .and_then(Value::as_array)
                .is_some_and(|v| {
                    v.iter().any(|e| {
                        e["kind"] == "original" && e["text"].as_str().is_some_and(|s| !s.is_empty())
                    })
                });
            let insufficient = shared.lock().map_err(|_| Error::Cancelled)?.draft
                ["insufficientRead"]
                .as_bool()
                .unwrap_or(false);
            // Fast and standard tiers write from the context and notes (D162);
            // even in deep tier, custom fanfic actions or setting-card scenes may match
            // zero pre-supplied book passages without needing a lookup tool, so mark
            // insufficientRead instead of discarding finished prose.
            if tier == Tier::Deep && !read && !supplied && !insufficient {
                shared.lock().map_err(|_| Error::Cancelled)?.draft["insufficientRead"] = true.into();
            }
        }
        let needs_time = plan.kind != "opening" && !valid_turn_time(&record);
        let needs_choices = requires_choices(&plan, &record) && !valid_turn_choices(&record);
        if record.is_null() || needs_time || needs_choices {
            self.emit_run_event(&plan, json!({"type":"organizing","phase":"extract"}))?;
            let extraction=crate::stage_context::extraction(&plan,&narrative);
            let extracted = match self
                .complete(&shared, "extract", extraction, vec![], true)
                .await
            {
                Ok(reply) => Some(reply),
                Err(err @ (Error::Cancelled | Error::Stale | Error::SystemStop(_))) => {
                    return Err(err);
                }
                Err(err) if record.is_null() => return Err(err),
                Err(_) => None,
            };
            if let Some(extracted) = extracted {
                let parsed = rules::record::parse_complete_record(&extracted.text);
                if plan.kind=="opening"&&parsed["openingTitle"].is_string(){shared.lock().map_err(|_|Error::Cancelled)?.draft["openingTitle"]=parsed["openingTitle"].clone();}
                if record.is_null() {
                    record = parsed["record"].clone();
                } else {
                    if needs_time && valid_turn_time(&parsed["record"]) {
                        record["time"] = parsed["record"]["time"].clone();
                    }
                    if needs_choices && valid_turn_choices(&parsed["record"]) {
                        record["choices"] = parsed["record"]["choices"].clone();
                    }
                }
            }
        }
        if let Some(problem) = turn_record_problem(&plan, &record) {
            return Err(Error::fail(crate::failure::FailKind::Format, format!("正文已保留，{problem}，可以接着整理")));
        }
        if has_book && matches!(plan.meta["referenceReviewVersion"].as_str(),Some("reference-review-1"|"reference-review-2"|"reference-review-3"|"reference-review-4")) && !plan.meta["playerNarrative"].is_string() {
            let reviewed=self.review_reference(&shared,&plan,&mcp,&active_tools,&narrative,&record).await?;
            narrative=reviewed["narrative"].as_str().unwrap_or(&narrative).to_owned();record=reviewed["record"].clone();
            shared.lock().map_err(|_|Error::Cancelled)?.draft["referenceReview"]=reviewed["report"].clone();
        } else if has_book && matches!(plan.meta["referenceReviewVersion"].as_str(),Some("reference-review-lite-1"|"reference-review-lite-2"|"reference-review-lite-3"|"reference-review-lite-4"|"reference-review-lite-5")) && !plan.meta["playerNarrative"].is_string() {
            let (revised,revised_record,report)=self.review_reference_lite(&shared,&plan,&narrative,&record).await?;
            narrative=revised; record=revised_record;
            shared.lock().map_err(|_|Error::Cancelled)?.draft["referenceReview"]=report;
        }
        if let Some(problem) = turn_record_problem(&plan, &record) {
            return Err(Error::fail(crate::failure::FailKind::Review, format!("核对后的记录不完整：{problem}")));
        }
        let mut options = plan.options.clone();
        options["advanceTime"] = true.into();
        let mut seed = plan.state.clone();
        let mut codex_timeline = Value::Null;
        if plan.kind == "opening" {
            if let Some(messages) = plan.meta["codexMessages"].as_array() {
                if let Some(response) = self
                    .optional_complete(&shared, "codex", messages.clone())
                    .await?
                {
                    if let Some(mut patch) =
                        crate::organize::codex_patch(&response.text, &seed, &json!({}))
                    {
                        if let Some(object) = patch.as_object_mut() {
                            codex_timeline = object.remove("timeline").unwrap_or(Value::Null);
                        }
                        let mut opts = options.clone();
                        opts["advanceTime"] = false.into();
                        seed = rules::apply_record(&seed, &patch, &opts).map_err(|e| Error::fail(crate::failure::FailKind::Settle, e))?
                            ["state"]
                            .clone();
                    }
                }
            }
            // Preserve the post-codex + startMoney baseline so revising Turn 0 never wipes AI cards or initial money (B01).
            let mut opening_seed = seed.clone();
            let base_money = plan.meta["startMoney"]
                .as_f64()
                .or_else(|| opening_seed["protagonist"]["stats"]["money"].as_f64())
                .unwrap_or(0.0)
                .max(0.0);
            opening_seed["protagonist"]["stats"]["money"] = (rules::js_round(base_money).max(0.0) as i64).into();
            if let Some(events) = plan.meta["openingTimeline"].as_array() {
                let mut clock = plan.options["clock"].clone();
                clock["date"] = opening_seed["time"]["date"].clone();
                clock["hour"] = opening_seed["time"]["startHour"].clone();
                opening_seed["timeline"] = Value::Array(rules::calendar::retime(events, &clock));
            }
            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
            c.draft["openingSeed"] = opening_seed;
            if codex_timeline.is_array() {
                c.draft["codexTimeline"] = codex_timeline.clone();
            }
        }
        let state = if plan.kind == "opening" {
            self.opening_state(&plan, seed, &record)?
        } else {
            seed
        };
        let mut settlement_record = record.clone();
        if plan.kind == "opening" {
            options["advanceTime"] = false.into();
            if state["era"]["currency"].is_object() {
                options["currency"] = state["era"]["currency"].clone();
            }
            if let Some(fields) = settlement_record.as_object_mut() {
                for key in ["money", "time", "date", "hour", "currency"] {
                    fields.remove(key);
                }
            }
        }
        shared.lock().map_err(|_| Error::Cancelled)?.stage = crate::failure::Stage::Settle;
        let mut applied =
            rules::apply_record(&state, &settlement_record, &options).map_err(|e| Error::fail(crate::failure::FailKind::Settle, e))?;
        if plan.kind == "opening"
            && codex_timeline.is_array()
            && state["time"]["date"]["ceYear"].is_number()
        {
            let mut opts = options.clone();
            opts["advanceTime"] = false.into();
            applied["state"] = rules::apply_record(
                &applied["state"],
                &json!({"timeline":codex_timeline}),
                &opts,
            )
            .map_err(|e| Error::fail(crate::failure::FailKind::Settle, e))?["state"]
                .clone();
        }
        // 设定集整理 and 章节摘要 wait until the passage is saved and shown, and
        // then never hold the story (D168). A sequence's passages still run
        // them in order, before the next passage.
        let deferred = plan.meta["parentRun"].is_null() && matches!(plan.kind.as_str(), "turn" | "variant" | "continue");
        if !deferred {
            self.maintain_requests(&shared, &plan, &narrative, &applied["state"]).await?;
        }
        self.checkpoint(&shared)?;
        let result = self.commit(&shared, &narrative, record, &applied, &result)?;
        self.emit_run_event(&plan,json!({"type":"done","worldId":plan.world_id,"nodeId":result["nodeId"],"chips":applied["chips"]}))?;
        // A spectator sequence rings once when the whole sequence finishes (finish_autoplay),
        // rather than ringing on every child passage while the progress bar is still active.
        if plan.meta["parentRun"].is_null() {
            (self.committed)(format!(
                "{}:{}",
                plan.world_id,
                result["nodeId"].as_str().unwrap_or("")
            ));
        }
        if deferred {
            // The passage is saved either way; tidying that cannot start is
            // asked for again by the next passage. Use the live `c.plan` so a
            // backup service activated during the turn is reused instead of a dead primary (B07).
            let latest_plan = shared.lock().map(|c| c.plan.clone()).unwrap_or_else(|_| plan.clone());
            let _ = self.start_maintenance(&latest_plan, &narrative, &result);
        }
        Ok(())
    }

    fn cached_tool_support(&self,model:&crate::types::ModelConfig)->Result<Option<bool>>{
        let key=format!("toolCapability:{}:{}:{}",model.slot,model.url,model.model);
        let raw=self.store.lock()?.query_row("SELECT value FROM settings WHERE key=?",[key],|r|r.get::<_,String>(0)).optional()?;
        Ok(raw.and_then(|s|serde_json::from_str::<Value>(&s).ok()).filter(|v|Utc::now().timestamp_millis()-v["at"].as_i64().unwrap_or(0)<86_400_000).and_then(|v|v["supported"].as_bool()))
    }
    fn save_observed_tool_support(&self, shared: &Shared, supported: bool) -> Result<()> {
        let context = shared.lock().map_err(|_| Error::Cancelled)?;
        // A replay may have been served by the backup in the earlier launch.
        if context.replayed_reply { return Ok(()); }
        let model = context.plan.model.clone();
        drop(context);
        let key=format!("toolCapability:{}:{}:{}",model.slot,model.url,model.model);
        self.store.lock()?.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",params![key,json!({"at":Utc::now().timestamp_millis(),"supported":supported}).to_string()])?;Ok(())
    }

    async fn tool_capability(self: &Arc<Self>, shared: &Shared) -> Result<bool> {
        let model = shared.lock().map_err(|_| Error::Cancelled)?.plan.model.clone();
        if let Some(supported) = self.cached_tool_support(&model)? {
            return Ok(supported);
        }
        let result = self.complete(shared,"capability",vec![json!({"role":"user","content":"请调用 report_capability 工具，参数 value 为 ready，不要输出其他内容。"})],vec![json!({"type":"function","function":{"name":"report_capability","description":"确认工具调用能力","parameters":{"type":"object","properties":{"value":{"type":"string","enum":["ready"]}},"required":["value"],"additionalProperties":false}}})],false).await;
        let supported = match result {
            Ok(result) => result.tool_calls.iter().any(|c| {
                c["function"]["name"] == "report_capability"
                    && c["function"]["arguments"]
                        .as_str()
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .is_some_and(|v| v["value"] == "ready")
            }),
            Err(Error::Invalid(message) | Error::Fail { kind: crate::failure::FailKind::Other, message })
                if [
                    "400",
                    "404",
                    "422",
                    "unsupported tool",
                    "tool is not supported",
                    "不支持工具",
                ]
                .iter()
                .any(|s| message.to_lowercase().contains(s)) =>
            {
                false
            }
            Err(error) => return Err(error),
        };
        self.save_observed_tool_support(shared, supported)?;
        Ok(supported)
    }

    async fn optional_complete(
        self: &Arc<Self>,
        shared: &Shared,
        purpose: &str,
        messages: Vec<Value>,
    ) -> Result<Option<Completion>> {
        let plan = shared.lock().map_err(|_| Error::Cancelled)?.plan.clone();
        self.emit_run_event(&plan, json!({"type":"organizing","phase":purpose}))?;
        match self.complete(shared, purpose, messages, vec![], true).await {
            Ok(result) => Ok(Some(result)),
            Err(Error::Limit(reason)) if purpose=="upkeep" || purpose.starts_with("chapter") => {
                let mut c=shared.lock().map_err(|_|Error::Cancelled)?;
                if !c.draft["deferredStages"].is_object(){c.draft["deferredStages"]=json!({});}
                c.draft["deferredStages"][purpose]=reason.into();drop(c);self.checkpoint(shared)?;Ok(None)
            },
            Err(error @ (Error::Cancelled | Error::Limit(_))) => Err(error),
            Err(error) => {self.store.run_event(&plan,json!({"type":"optional-stage-deferred","phase":purpose,"reason":error.to_string()}))?;Ok(None)},
        }
    }

    fn opening_state(&self, plan: &RunPlan, mut state: Value, record: &Value) -> Result<Value> {
        // An opening's absolute initial amount is not an ordinary turn delta.
        if let Some(hour) = record.get("hour") {
            state["time"]["startHour"] = hour.clone();
        }
        if state["era"]["clockStyle"] != "elapsed" {
            if let Some(date) = record.get("date") {
                if let Some(parsed) =
                    rules::calendar::read_date(date, &plan.options["clock"]["rules"])
                {
                    state["time"]["date"] = serde_json::to_value(&parsed)?;
                    state["time"]["start"] =
                        rules::calendar::format_date(&parsed, &plan.options["clock"]["rules"])
                            .into();
                } else if state["era"]["packId"].is_null() && date.is_string() {
                    state["time"]["start"] = date.clone();
                }
            }
        }
        if state["era"]["packId"].is_null() {
            if let Some(currency) = record.get("currency").filter(|v| v.is_array()) {
                state["era"]["currency"] = json!({"units":currency});
            }
        }
        let currency = state["era"]
            .get("currency")
            .unwrap_or(&plan.options["currency"]);
        state["protagonist"]["stats"]["money"] = (rules::js_round(
            rules::money::parse_money(&record["money"], currency)
                .unwrap_or(plan.meta["startMoney"].as_f64().unwrap_or(0.0))
                .max(0.0),
        )
        .max(0.0) as i64)
        .into();
        if let Some(events) = plan.meta["openingTimeline"].as_array() {
            let mut clock = plan.options["clock"].clone();
            clock["date"] = state["time"]["date"].clone();
            clock["hour"] = state["time"]["startHour"].clone();
            state["timeline"] = Value::Array(rules::calendar::retime(events, &clock));
        }
        Ok(state)
    }

    fn finish_preview(&self, shared: &Shared, result: Value) -> Result<()> {
        let c = shared.lock().map_err(|_| Error::Cancelled)?;
        let mut db = self.store.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Store::guard(&tx, &c.plan)?;
        write_usage(&tx, &c.plan.id, &c.plan.world_id, None, "ok")?;
        tx.execute("UPDATE execution_runs SET status='previewed',result_json=?,updated_at=? WHERE id=? AND status='running'",params![result.to_string(),Utc::now().to_rfc3339(),c.plan.id])?;
        tx.commit()?;
        Ok(())
    }

    fn commit(
        &self,
        shared: &Shared,
        narrative: &str,
        record: Value,
        applied: &Value,
        completion: &Completion,
    ) -> Result<Value> {
        self.check(shared)?;
        shared.lock().map_err(|_| Error::Cancelled)?.stage = crate::failure::Stage::Commit;
        let c = shared.lock().map_err(|_| Error::Cancelled)?;
        let plan = &c.plan;
        let mut db = self.store.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT result_json FROM execution_runs WHERE id=? AND status='committed'",
                [&plan.id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(result) = existing {
            return Ok(serde_json::from_str(&result)?);
        }
        Store::guard_run(&tx, plan)?;
        let time = Utc::now().to_rfc3339();
        if let Some(world) = &plan.new_world {
            Store::guard_opening_book(&tx, plan)?;
            tx.execute("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES(?,?,?,?,?,?,?,?)",params![plan.world_id,if plan.meta["titlePolicy"]=="auto" {c.draft["openingTitle"].as_str().unwrap_or("未命名故事")}else{world["title"].as_str().unwrap_or("未命名故事")},world["eraId"].as_str().unwrap_or(""),plan.line_id,plan.settings.to_string(),time,time,time])?;
        } else {
            Store::guard(&tx, plan)?;
        }
        let id = if plan.kind == "continue" {
            plan.meta["targetId"]
                .as_str()
                .ok_or(Error::Stale)?
                .to_owned()
        } else {
            uuid::Uuid::new_v4().simple().to_string()
        };
        let mut meta = plan.meta.clone();
        // A saved passage keeps what describes it, not the prompts that built
        // it: those were copied into every node and only grew the save (R30).
        for key in ["settingsGuard", "generationSnapshot", "sourceGuard", "targetId", "executionLease", "writingContext", "upkeepMessages", "upkeepTextGuard", "chapterMessages", "chapterTextGuard", "chapterRefresh", "sourceScope", "textGuard", "textGuardAt", "autoplayTextHash", "codexMessages",
            "autoplayTurnSystem", "autoplayExtractSystem", "autoplayUpkeepSystem", "autoplayChapterSystem", "resumeBudgetBase", "stepBudgetBase"] {
            if let Some(object) = meta.as_object_mut() {
                object.remove(key);
            }
        }
        meta["chips"] = applied["chips"].clone();
        meta["notes"] = applied["notes"].clone();
        meta["log"] = applied["log"].clone();
        meta["model"] = c.draft["proseModel"]
            .as_str()
            .unwrap_or(&plan.model.model)
            .to_owned()
            .into();
        meta["nativeRun"] = plan.id.clone().into();
        meta["referenceReview"] = c.draft["referenceReview"].clone();
        meta["contextReports"]=c.draft["contextReports"].clone();
        meta["deferredStages"]=c.draft["deferredStages"].clone();
        meta["usage"] = completion.usage.clone().unwrap_or(Value::Null);
        meta["firstTokenMs"] = completion.first_token_ms.into();
        meta["totalMs"] = completion.total_ms.into();
        let mut reference = plan.reference.clone().unwrap_or(Value::Null);
        if let Some(passages) = c.draft["originalPassages"].as_array() {
            if reference.is_object() {
                let mut all = reference["passages"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for passage in passages {
                    if !all.contains(passage) {
                        all.push(passage.clone());
                    }
                }
                reference["passages"] = Value::Array(all);
                reference["status"] = "ready".into();
            }
        }
        meta["reference"] = reference;
        meta["skillVersions"] = c.draft["skillVersions"].clone();
        if c.draft["upkeepAttempted"] == true {
            meta["upkeep"] = true.into();
        }
        if plan.kind == "opening" {
            meta["openingSeed"] = if c.draft["openingSeed"].is_object() {
                c.draft["openingSeed"].clone()
            } else {
                plan.state.clone()
            };
            if c.draft["codexTimeline"].is_array() {
                meta["codexTimeline"] = c.draft["codexTimeline"].clone();
            }
        }
        let mut state = applied["state"].clone();
        let taboos = scan_taboos(&state, narrative);
        if !taboos.is_empty() {
            meta["taboos"] = Value::Array(taboos);
        }
        let mut facts=state["facts"].as_array().cloned().unwrap_or_else(||if plan.kind=="opening"{vec![]}else{vec![json!({"id":format!("legacy:{}",plan.base_id.as_deref().unwrap_or("")),"detail":"此前资料来源未记录，涉及原著细节需要核实；不自动清洗旧剧情","origin":"legacyUnknown","citations":[]})]});
        if let Some(action) = plan.action["text"].as_str().filter(|s| !s.is_empty()) {
            facts.push(json!({"id":uuid::Uuid::new_v4().simple().to_string(),"nodeId":id,"detail":format!("玩家输入（不是行动结果）：{action}"),"origin":"player","citations":[]}));
        }
        if let Some(detail) = record["log"].as_str().filter(|s| !s.is_empty()) {
            facts.push(json!({"id":uuid::Uuid::new_v4().simple().to_string(),"nodeId":id,"detail":detail,"origin":"ai","citations":[]}));
        }
        // Keep all player/branch/correction/legacy facts intact, while capping redundant AI turn logs
        // to the newest 60 so state_json stays bounded over long stories.
        const MAX_AI_FACTS: usize = 60;
        let ai_total = facts.iter().filter(|f| f["origin"] == "ai").count();
        if ai_total > MAX_AI_FACTS {
            let mut drop_ai = ai_total - MAX_AI_FACTS;
            facts.retain(|f| {
                if f["origin"] == "ai" && drop_ai > 0 {
                    drop_ai -= 1;
                    false
                } else {
                    true
                }
            });
        }
        state["facts"] = Value::Array(facts);
        // 原著进度跟随 (D178): the passage moves the book position forward when
        // it clearly follows a later chapter. Kept in this node's state, so it
        // goes with the route and is undone with the passage.
        if matches!(plan.kind.as_str(), "turn" | "variant" | "continue") && state["source"].is_object() {
            if let Ok(Some(next)) = crate::runtime_sources::follow_position(&tx, &state["source"], narrative) {
                let from = state["source"]["position"].as_i64().unwrap_or(0);
                let book_id = state["source"]["bookId"].as_str().unwrap_or("");
                let section_title = |sec: i64| -> Option<String> {
                    tx.query_row(
                        "SELECT title FROM source_sections WHERE book_id=? AND section=?",
                        params![book_id, sec],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
                };
                let from_title = section_title(from);
                let to_title = section_title(next);
                state["source"]["position"] = next.into();
                let mut adv = json!({"from": from, "to": next});
                if let Some(ref t) = from_title { adv["fromTitle"] = t.clone().into(); }
                if let Some(ref t) = to_title { adv["toTitle"] = t.clone().into(); }
                meta["sourceAdvanced"] = adv;
                if !meta["chips"].is_array() { meta["chips"] = json!([]); }
                if let Some(chips) = meta["chips"].as_array_mut() {
                    let chip_text = match to_title {
                        Some(t) => format!("原著进度 → 第 {} 节（{}）", next + 1, t.chars().take(18).collect::<String>()),
                        None => format!("原著进度 → 第 {} 节", next + 1),
                    };
                    chips.push(json!({"text": chip_text, "tone": "info"}));
                }
            }
        }
        let (record, continuity_issues)=crate::continuity::validate_record(&tx,&plan.world_id,plan.base_id.as_deref().unwrap_or(""),&id,narrative,&plan.action,&state,&record,false)?;
        if !continuity_issues.is_empty(){let mut logs=meta["log"].as_array().cloned().unwrap_or_default();logs.extend(continuity_issues.into_iter().map(Value::String));meta["log"]=json!(logs);}

        if plan.kind == "continue" {
            let changed=tx.execute("UPDATE nodes SET narrative=?,record_json=?,choices_json=?,status='ok',meta_json=? WHERE id=? AND status='interrupted' AND narrative=?",params![narrative,record.to_string(),record["choices"].as_array().cloned().unwrap_or_default().into_iter().collect::<Value>().to_string(),meta.to_string(),id,plan.original])?;
            if changed != 1 {
                return Err(Error::Stale);
            }
            tx.execute(
                "UPDATE states SET state_json=? WHERE node_id=?",
                params![state.to_string(), id],
            )?;
        } else {
            if plan.new_world.is_none() && plan.kind == "turn" {
                preserve_branch(&tx, plan)?;
            }
            let seq: i64 = tx.query_row(
                "SELECT COALESCE(MAX(seq),0)+1 FROM nodes WHERE world_id=?",
                [&plan.world_id],
                |r| r.get(0),
            )?;
            insert_node(
                &tx,
                &id,
                &plan.world_id,
                plan.base_id.as_deref(),
                seq,
                if plan.kind == "opening" {
                    "opening"
                } else {
                    "turn"
                },
                &plan.action,
                narrative,
                &record,
                &meta,
                &state,
                &time,
            )?;
            if plan.new_world.is_some() {
                tx.execute("INSERT INTO lines(id,world_id,name,node_id,kind,created_at) VALUES(?,?,'主线',?,'line',?)",params![plan.line_id,plan.world_id,id,time])?;
            }
        }
        let mut head = id.clone();
        for trailing in &plan.trailing_ids {
            let record_text: String = tx.query_row(
                "SELECT record_json FROM nodes WHERE id=?",
                [trailing],
                |r| r.get(0),
            )?;
            let patch: Value = serde_json::from_str(&record_text)?;
            let mut opts = plan.options.clone();
            opts["advanceTime"] = false.into();
            let edited = rules::apply_record(&state, &patch, &opts).map_err(|e| Error::fail(crate::failure::FailKind::Settle, e))?;
            state = edited["state"].clone();
            tx.execute(
                "UPDATE states SET state_json=? WHERE node_id=?",
                params![state.to_string(), trailing],
            )?;
            head = trailing.clone();
        }
        let mut carried_ids = std::collections::HashMap::new();
        if let Some(old) = plan.meta["targetId"].as_str() {
            carried_ids.insert(old, id.clone());
        }
        for edit in &plan.carried_edits {
            let mut options = plan.options.clone();
            options["advanceTime"] = false.into();
            let mut record = edit["record"].clone();
            let next =
                rules::apply_record(&state, &record, &options).map_err(|e| Error::fail(crate::failure::FailKind::Settle, e))?;
            let next_id = uuid::Uuid::new_v4().simple().to_string();
            let action = json!({"text":format!("{}（已沿用）",edit["actionText"].as_str().unwrap_or("")),"directorNote":edit["directorNote"]});
            let old_edit = edit["id"].as_str();
            if let Some(changes) = record.get_mut("continuity") {
                for kind in ["knowledge", "threads"] {
                    if let Some(items) = changes.get_mut(kind).and_then(Value::as_array_mut) {
                        for item in items {
                            if let Some(source) = item["source"]["nodeId"].as_str() {
                                let mapped = if Some(source) == old_edit { Some(&next_id) } else { carried_ids.get(source) };
                                if let Some(mapped) = mapped { item["source"]["nodeId"] = mapped.clone().into(); }
                            }
                        }
                    }
                }
                (record, _) = crate::continuity::validate_record(&tx, &plan.world_id, &head, &next_id, "", &action, &next["state"], &record, false)?;
            }
            if next["state"] == state && record["continuity"].is_null() {
                continue;
            }
            state = next["state"].clone();
            let seq: i64 = tx.query_row(
                "SELECT COALESCE(MAX(seq),0)+1 FROM nodes WHERE world_id=?",
                [&plan.world_id],
                |r| r.get(0),
            )?;
            insert_node(
                &tx,
                &next_id,
                &plan.world_id,
                Some(&head),
                seq,
                "edit",
                &action,
                "",
                &record,
                &json!({"chips":next["chips"]}),
                &state,
                &time,
            )?;
            if let Some(old) = old_edit { carried_ids.insert(old, next_id.clone()); }
            head = next_id;
        }
        if c.draft["upkeepPatch"].is_object() {
            let patch = &c.draft["upkeepPatch"];
            let mut opts = plan.options.clone();
            opts["advanceTime"] = false.into();
            let next = rules::apply_record(&state, patch, &opts).map_err(|e| Error::fail(crate::failure::FailKind::Settle, e))?;
            if next["state"] != state {
                state = next["state"].clone();
                let next_id = uuid::Uuid::new_v4().simple().to_string();
                let seq: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(seq),0)+1 FROM nodes WHERE world_id=?",
                    [&plan.world_id],
                    |r| r.get(0),
                )?;
                insert_node(
                    &tx,
                    &next_id,
                    &plan.world_id,
                    Some(&head),
                    seq,
                    "edit",
                    &json!({"text":"AI 整理了设定集"}),
                    "",
                    patch,
                    &json!({"by":"AI","promptVersion":plan.meta["upkeepVersion"],"chips":next["chips"],"upkeep":true}),
                    &state,
                    &time,
                )?;
                head = next_id;
            }
        }
        if c.draft["chapter"].is_object() {
            let chapter = &c.draft["chapter"];
            let first = plan.meta["chapterFirstId"]
                .as_str()
                .filter(|s| *s != "{{NODE_ID}}")
                .unwrap_or(&id);
            tx.execute("INSERT INTO chapters(id,world_id,first_node_id,last_node_id,title,gist,summary,model,prompt_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",params![uuid::Uuid::new_v4().simple().to_string(),plan.world_id,first,id,chapter["title"].as_str().unwrap_or("未命名章节"),chapter["gist"].as_str().unwrap_or(""),chapter["summary"].as_str().unwrap_or(""),plan.model.aux_model.as_ref().unwrap_or(&plan.model.model),plan.meta["chapterVersion"].as_str().unwrap_or("chapter-2"),time])?;
        }
        tx.execute(
            "UPDATE lines SET node_id=? WHERE id=?",
            params![head, plan.line_id],
        )?;
        tx.execute(
            "UPDATE worlds SET updated_at=?,played_at=? WHERE id=?",
            params![time, time, plan.world_id],
        )?;
        write_usage(&tx, &plan.id, &plan.world_id, Some(&id), "ok")?;
        let result =
            json!({"worldId":plan.world_id,"nodeId":id,"headId":head,"lineId":plan.line_id});
        if let Some(parent) = plan.meta["parentRun"].as_str() {
            let text: String = tx.query_row(
                "SELECT plan_json FROM execution_runs WHERE id=? AND status='running'",
                [parent],
                |r| r.get(0),
            )?;
            let mut parent_plan: RunPlan = serde_json::from_str(&text)?;
            parent_plan.head_id = head.clone();
            parent_plan.base_id = Some(head.clone());
            parent_plan.state = state.clone();
            parent_plan.meta["sourceGuard"] = state.get("source").cloned().unwrap_or(Value::Null);
            let settings: String = tx.query_row(
                "SELECT settings_json FROM worlds WHERE id=?",
                [&plan.world_id],
                |r| r.get(0),
            )?;
            parent_plan.meta["settingsGuard"] = serde_json::from_str::<Value>(&settings)?;
            let index = plan.meta["autoplayIndex"].as_i64().unwrap_or(0);
            tx.execute("UPDATE execution_runs SET base_head_id=?,plan_json=?,budget_json=?,draft_json=json_set(draft_json,'$.steps',MAX(COALESCE(json_extract(draft_json,'$.steps'),0),?),'$.lastNodeId',?),updated_at=? WHERE id=? AND status='running'",params![head,serde_json::to_string(&parent_plan)?,serde_json::to_string(&c.budget)?,index,id,time,parent])?;
        }
        tx.execute("UPDATE execution_runs SET status='committed',result_json=?,updated_at=? WHERE id=? AND status='running'",params![result.to_string(),time,plan.id])?;
        tx.commit()?;
        Ok(result)
    }
    pub(crate) fn flush_usage(&self, id: &str, outcome: &str) -> Result<()> {
        let plan = self.store.plan(id)?;
        let mut db = self.store.lock()?;
        let tx = db.transaction()?;
        let step_status = match outcome {
            "cancelled" => "cancelled",
            "interrupted" => "interrupted",
            _ => "failed",
        };
        tx.execute(
            "UPDATE execution_steps SET status=? WHERE run_id=? AND status='running'",
            params![step_status, id],
        )?;
        write_usage(&tx, id, &plan.world_id, None, outcome)?;
        tx.commit()?;
        Ok(())
    }

    async fn dispatch(
        self: &Arc<Self>,
        shared: Shared,
        name: String,
        args: Value,
    ) -> Result<Value> {
        self.check(&shared)?;
        let plan = shared.lock().map_err(|_| Error::Cancelled)?.plan.clone();
        match name.as_str() {
            "list_skills" => Ok(crate::skills::catalog_json()),
            "read_skill" => {
                let name=args["name"].as_str().unwrap_or("");let mut skill = crate::skills::read_writing(name)?;
                skill["taskAdapter"]="当前是普通写作或局部改稿，只提供只读查证与记录预演。技能中涉及Agent草稿、record_findings、finish_task等步骤不适用。直接返回本次要求的正文/JSON，正常回合由程序保存，改稿由玩家采用。".into();
                {
                    let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                    c.draft["skillVersions"][args["name"].as_str().unwrap_or("")] =
                        skill["metadata"]["version"].clone();
                }
                self.checkpoint(&shared)?;
                Ok(skill)
            }
            "read_skill_resource" => {
                let id=args["id"].as_str().unwrap_or("");let version=args["version"].as_str().unwrap_or("");
                let read=shared.lock().map_err(|_|Error::Cancelled)?.draft["skillVersions"][id].clone();
                if read!=version {return Err(Error::Invalid("请先read_skill取得本次内置技能版本及资源目录".into()));}
                crate::skills::read_writing_resource(id,args["path"].as_str().unwrap_or(""),version,args["offset"].as_u64().unwrap_or(0).min(usize::MAX as u64) as usize,args["limit"].as_u64().unwrap_or(2000).min(6000) as usize)
            }
            "read_world" => {
                Ok(json!({"summary":crate::writing_context::project_state(&plan.state,&json!({"currency":plan.options["currency"],"clock":plan.options["clock"]}),plan.action["text"].as_str().unwrap_or("")),"settings":plan.settings,"referenceBinding":plan.reading_source(),"partial":true,"available":{"people":plan.state["people"].as_array().map(Vec::len).unwrap_or(0),"places":plan.state["places"].as_array().map(Vec::len).unwrap_or(0),"cards":plan.state["cards"].as_array().map(Vec::len).unwrap_or(0)},"next":"人物按read_characters(query,offset,limit)读取，历史按read_history(query)搜索；完整状态保留本机，不代表其他资料为空。"}))
            }
            "read_story_resources" | "read_continuity" => crate::ordinary_resources::read(&*self.store.lock()?, &plan, &name, &args),
            "read_characters" => {
                let query=args["query"].as_str().unwrap_or("").trim();let offset=args["offset"].as_u64().unwrap_or(0) as usize;let limit=args["limit"].as_u64().unwrap_or(12).clamp(1,20) as usize;
                let all=plan.state["people"].as_array().into_iter().flatten().filter(|p|query.is_empty()||p["name"].as_str().unwrap_or("").contains(query)||p["aliases"].as_array().into_iter().flatten().any(|a|a.as_str().is_some_and(|s|s.contains(query)))).collect::<Vec<_>>();
                let allowance = (plan.meta["budgetChars"].as_u64().unwrap_or(12000) / 4).clamp(600, 6000) as usize;
                let mut used = 0;
                let mut people = vec![];
                for person in all.iter().skip(offset).take(limit) {
                    let cost = crate::stage_context::units(&person.to_string());
                    if !people.is_empty() && used + cost > allowance { break; }
                    if cost > allowance {
                        people.push(json!({"id":person["id"],"name":person["name"],"partial":true,
                            "read":{"kind":"people","query":person["id"]}}));
                        break;
                    }
                    people.push((*person).clone());
                    used += cost;
                }
                let next = offset.saturating_add(people.len());
                let current = crate::stage_context::state(&plan.state, query, 900);
                Ok(json!({"protagonist":current["protagonist"],"people":people,"total":all.len(),
                    "nextOffset":(next < all.len()).then_some(next),
                    "note":"长人物资料用read_story_resources的people目录按read定位，再分页读字段。"}))
            }
            "read_history" => {
                let db = self.store.lock()?;
                let query = args["query"].as_str().unwrap_or("").trim();
                let limit = args["limit"].as_i64().unwrap_or(6).clamp(1, 40);
                let at = if matches!(plan.kind.as_str(), "variant" | "continue") {
                    plan.base_id.as_deref().unwrap_or(&plan.head_id)
                } else { &plan.head_id };
                let path = "WITH RECURSIVE up(id,parent_id,narrative,record_json,seq) AS (SELECT id,parent_id,narrative,record_json,seq FROM nodes WHERE id=? UNION SELECT n.id,n.parent_id,n.narrative,n.record_json,n.seq FROM nodes n JOIN up ON n.id=up.parent_id) ";
                let mut stmt=db.prepare(&format!("{path} SELECT id,narrative,record_json FROM up WHERE narrative<>'' AND (?='' OR instr(narrative,?)>0 OR instr(COALESCE(record_json,''),?)>0) ORDER BY seq DESC LIMIT ?"))?;
                let rows=stmt.query_map(params![at,query,query,query,limit],|r|Ok(json!({"id":r.get::<_,String>(0)?,"narrative":r.get::<_,String>(1)?,"record":r.get::<_,Option<String>>(2)?})))?;
                let turns = rows.collect::<std::result::Result<Vec<_>, _>>()?;
                let mut stmt = db.prepare(&format!("{path} SELECT c.id,c.title,c.summary FROM chapters c WHERE c.world_id=? AND c.first_node_id IN (SELECT id FROM up) AND c.last_node_id IN (SELECT id FROM up) AND (?='' OR instr(c.summary,?)>0 OR instr(c.title,?)>0) ORDER BY c.created_at DESC LIMIT ?"))?;
                let rows=stmt.query_map(params![at,plan.world_id,query,query,query,limit], |r| Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,Option<String>>(1)?,"summary":r.get::<_,String>(2)?})))?;
                let chapters = rows.collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(history_excerpts(&plan, turns, chapters, query))
            }
            "read_canon_notes" => crate::runtime_sources::read_notes(&*self.store.lock()?, &plan, args["query"].as_str().unwrap_or("")),
            "list_sections" | "search_original" | "read_original" | "read_canon_facts" | "locate_original_event" | "prepare_reference_check" | "preview_turn_record" => {
                let value = crate::runtime_sources::read(&self.store, &plan, &name, &args)?;
                let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                if value["excerpts"].as_array().is_some_and(|v| !v.is_empty()) {
                    c.draft["evidence"] = value.clone();
                }
                drop(c);
                self.checkpoint(&shared)?;
                Ok(value)
            }
            _ => Err(Error::Invalid("没有这个内置工具".into())),
        }
    }
}

fn is_read_tool(name: &str) -> bool {
    matches!(
        name,
        "read_world"
            | "read_history"
            | "read_story_resources"
            | "read_continuity"
            | "read_characters"
            | "locate_original_event"
            | "prepare_reference_check"
            | "preview_turn_record"
            | "list_sections"
            | "search_original"
            | "read_original"
            | "read_canon_facts"
            | "read_canon_notes"
            | "list_skills"
            | "read_skill"
            | "read_skill_resource"
    )
}

#[cfg(test)]
fn separate_correction_sources(
    changes: Vec<Value>,
    state: &Value,
) -> Result<(Vec<Value>, Vec<Value>)> {
    let player_facts: Vec<_> = state["facts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| {
            f["origin"] == "player"
                && f["id"].as_str().is_some_and(|s| !s.is_empty())
                && f["detail"].as_str().is_some_and(|s| !s.trim().is_empty())
        })
        .map(|f| json!({"id":f["id"],"detail":f["detail"]}))
        .collect();
    let mut original = vec![];
    let mut preserved = false;
    for change in changes {
        if change["citations"]
            .as_array()
            .is_some_and(|c| !c.is_empty())
        {
            original.push(change);
        } else if (change["origin"] == "player"
            || change["detail"]
                .as_str()
                .is_some_and(|s| s.trim_start().starts_with("保留玩家分支")))
            && !player_facts.is_empty()
        {
            // Discard the model's uncited claim. The separate local note is
            // copied verbatim from trusted player provenance in the baseline.
            preserved = true;
        } else {
            return Err(Error::Invalid(
                "原著更正需要原文引文；本局分支须有已记录的玩家来源".into(),
            ));
        }
    }
    if original.is_empty() {
        return Err(Error::Invalid(
            "尚未查出带原文依据的更正，原路线未改动".into(),
        ));
    }
    Ok((original, if preserved { player_facts } else { vec![] }))
}

fn history_window(text: &str, query: &str, limit: usize) -> (String, bool) {
    let chars: Vec<_> = text.chars().collect();
    let focus = if query.is_empty() {
        0
    } else {
        text.find(query)
            .map(|at| text[..at].chars().count())
            .unwrap_or(0)
    };
    let start = focus.saturating_sub(limit / 3);
    let mut used = 0;
    let excerpt: String = chars
        .iter()
        .skip(start)
        .take_while(|ch| {
            used += ch.len_utf16();
            used <= limit
        })
        .collect();
    let omitted = start > 0 || excerpt.chars().count() < chars.len();
    (excerpt, omitted)
}

fn history_excerpts(plan: &RunPlan, turns: Vec<Value>, chapters: Vec<Value>, query: &str) -> Value {
    let allowance = (plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize / 4).min(6000);
    let mut used = 100;
    let mut truncated = false;
    let mut fit = |items: Vec<Value>, field: &str| {
        let mut result = vec![];
        for mut item in items {
            let limit = allowance.saturating_sub(used).min(1000);
            if limit < 120 {
                truncated = true;
                break;
            }
            let (excerpt, omitted) = history_window(
                item[field].as_str().unwrap_or(""),
                query,
                limit.saturating_sub(100),
            );
            item[field] = excerpt.into();
            // A shortened JSON record is an excerpt, never a complete record.
            if let Some(record) = item.as_object_mut().unwrap().remove("record") {
                if let Some(record) = record.as_str() {
                    let (excerpt, _) = history_window(record, query, 250);
                    item["recordExcerpt"] = excerpt.into();
                }
            }
            item["excerpt"] = true.into();
            let cost = item.to_string().encode_utf16().count();
            if used + cost > allowance {
                truncated = true;
                continue;
            }
            used += cost;
            truncated |= omitted;
            result.push(item);
        }
        result
    };
    let turns = fit(turns, "narrative");
    let chapters = fit(chapters, "summary");
    json!({"turns":turns,"chapters":chapters,"truncated":truncated,"note":"仅当前路线的历史摘录；可缩小关键词或减少 limit 补查，摘录不代表完整回合记录。"})
}

fn compact_locator_schema(schema:&mut Value){
    match schema {
        Value::Object(fields)=>{if fields.get("maximum").and_then(Value::as_u64)==Some(9_007_199_254_740_991){fields.remove("maximum");}for value in fields.values_mut(){compact_locator_schema(value);}},
        Value::Array(values)=>for value in values{compact_locator_schema(value);},_=>()
    }
}

/// A first-byte timeout already waited the full response window (120 s on
/// the native hosts); retrying it would leave the player waiting about four
/// minutes before seeing a failure, so only quick transient errors retry.
fn transient_retry_delay(error: &Error) -> Option<std::time::Duration> {
    match error {
        // The service broke off mid-stream with an error event (D164): the
        // passage was not finished, so one fresh attempt replaces the partial text.
        Error::Provider { kind, .. } if kind == "stream" => Some(std::time::Duration::from_secs(1)),
        // No words yet and the failure may pass: the same rule as helper tasks (D167).
        Error::Provider { kind, status, partial: false, .. }
            if kind == "network" || kind == "timeout_first"
                || (kind == "http" && status.is_some_and(|s| s == 429 || s >= 500)) =>
        {
            Some(std::time::Duration::from_secs(if *status == Some(429) && kind == "http" { 2 } else { 1 }))
        }
        _ => None,
    }
}

fn stopped_by_service(result: &Completion) -> bool {
    matches!(
        result.finish_reason.as_deref().unwrap_or("").to_ascii_lowercase().as_str(),
        "content_filter" | "safety" | "prohibited_content" | "recitation" | "refusal"
    )
}

fn output_cut_short(result: &Completion) -> bool {
    matches!(
        result.finish_reason.as_deref().unwrap_or("").to_ascii_lowercase().as_str(),
        "length" | "max_tokens" | "max_output_tokens"
    )
}

fn is_story_plan(plan: &RunPlan) -> bool {
    matches!(plan.kind.as_str(), "turn" | "variant" | "continue" | "opening")
}

fn complete_prose_before_record(plan: &RunPlan, purpose: &str, result: &Completion) -> bool {
    if !(is_story_plan(plan)
        && !plan.meta["playerNarrative"].is_string()
        && purpose.starts_with("writing:")
        && result.tool_calls.is_empty())
    {
        return false;
    }
    let clean = chat::strip_inline_think(&result.text);
    find_record_tag(&clean).is_some() && !narrative_part(&clean).is_empty()
}

fn valid_turn_time(record: &Value) -> bool {
    rules::calendar::parse_duration_minutes(&record["time"]).is_some()
}

fn valid_turn_choices(record: &Value) -> bool {
    record["choices"].as_array().is_some_and(|choices| {
        choices.iter().any(|choice| choice.as_str().is_some_and(|text| !text.trim().is_empty()))
    })
}

fn requires_choices(plan: &RunPlan, record: &Value) -> bool {
    plan.settings["choiceCount"].as_u64().unwrap_or(0) > 0
        && record["died"] != true
        && !matches!(record["challenge"]["result"].as_str(), Some("won" | "lost"))
}

/// Only a missing record stops a written passage. An elapsed time the rules cannot
/// read falls back to the action's usual length (the passage's changes say so), and
/// missing suggestions leave the player to type: neither is worth a failed passage
/// and another paid try once the 补记 pass could not mend it (R30 step 3).
fn turn_record_problem(_plan: &RunPlan, record: &Value) -> Option<&'static str> {
    (!record.is_object()).then_some("回合记录未整理完")
}

fn check_reply_error(error: Error) -> Error {
    match error {
        Error::Invalid(message) => Error::fail(crate::failure::FailKind::Review, message),
        other => other,
    }
}

fn refused(result: &Completion, text: &str, has_record: bool) -> bool {
    if stopped_by_service(result) {
        return true;
    }
    if has_record {
        return false;
    }
    let text = text.trim().to_ascii_lowercase();
    text.starts_with("the prompt could not be submitted")
        || text.starts_with("the prompt contains sensitive words")
        || (text.chars().count() < 80
            && ["抱歉，我无法提供", "抱歉，我无法生成", "抱歉，我不能提供", "抱歉，我不能生成",
                "i can't assist with", "i cannot assist with", "i'm sorry, but i can't assist"].iter().any(|phrase| text.starts_with(phrase)))
}
fn find_record_tag(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    const NEEDLE: &[u8] = b"<record";
    if bytes.len() < NEEDLE.len() {
        return None;
    }
    let mut i = 0;
    while i + NEEDLE.len() <= bytes.len() {
        if bytes[i] == b'<' && bytes[i..i + NEEDLE.len()].eq_ignore_ascii_case(NEEDLE) {
            return Some(i);
        }
        i += 1;
    }
    None
}
pub fn narrative_part(text: &str) -> String {
    let clean = chat::strip_inline_think(text);
    let end = find_record_tag(&clean).unwrap_or(clean.len());
    let mut visible = &clean[..end];
    for marker in ["<", "<r", "<re", "<rec", "<reco", "<recor"] {
        if visible.len() >= marker.len()
            && visible.as_bytes()[visible.len() - marker.len()..].eq_ignore_ascii_case(marker.as_bytes())
        {
            visible = &visible[..visible.len() - marker.len()];
            break;
        }
    }
    visible.trim_end().to_owned()
}
fn insert_node(
    tx: &Transaction<'_>,
    id: &str,
    world: &str,
    parent: Option<&str>,
    seq: i64,
    kind: &str,
    action: &Value,
    narrative: &str,
    record: &Value,
    meta: &Value,
    state: &Value,
    time: &str,
) -> Result<()> {
    tx.execute("INSERT INTO nodes(id,world_id,parent_id,last_child_id,seq,kind,action_mode,action_text,director_note,narrative,record_json,choices_json,status,rewritten,fate,meta_json,created_at) VALUES(?,?,?,NULL,?,?,?,?,?,?,?,?,'ok',0,NULL,?,?)",params![id,world,parent,seq,kind,action["mode"].as_str(),action["text"].as_str(),action["directorNote"].as_str(),narrative,record.to_string(),record.get("choices").cloned().unwrap_or(json!([])).to_string(),meta.to_string(),time])?;
    tx.execute(
        "INSERT INTO states(node_id,state_json) VALUES(?,?)",
        params![id, state.to_string()],
    )?;
    if let Some(parent) = parent {
        tx.execute(
            "UPDATE nodes SET last_child_id=? WHERE id=?",
            params![id, parent],
        )?;
    }
    Ok(())
}
fn preserve_branch(tx: &Transaction<'_>, plan: &RunPlan) -> Result<()> {
    let Some(base) = &plan.base_id else {
        return Ok(());
    };
    let branch: Option<(String, i64)> = tx.query_row(
        "WITH RECURSIVE tail(id,last_child_id,steps,turns) AS (
           SELECT id,last_child_id,1,CASE WHEN kind='edit' THEN 0 ELSE 1 END FROM nodes WHERE id=(SELECT last_child_id FROM nodes WHERE id=?)
           UNION ALL
           SELECT n.id,n.last_child_id,t.steps+1,t.turns+CASE WHEN n.kind='edit' THEN 0 ELSE 1 END FROM nodes n JOIN tail t ON n.id=t.last_child_id
         ) SELECT id,turns FROM tail ORDER BY steps DESC LIMIT 1",
        [base],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional()?;
    if let Some((head, turns)) = branch {
        let covered: bool = tx.query_row(
            "WITH RECURSIVE tail(id,last_child_id) AS (
               SELECT id,last_child_id FROM nodes WHERE id=(SELECT last_child_id FROM nodes WHERE id=?)
               UNION ALL SELECT n.id,n.last_child_id FROM nodes n JOIN tail t ON n.id=t.last_child_id
             ) SELECT EXISTS(SELECT 1 FROM lines WHERE world_id=? AND id<>? AND deleted_at IS NULL AND node_id IN (SELECT id FROM tail))",
            params![base, plan.world_id, plan.line_id],
            |r| r.get(0),
        )?;
        if turns >= 3 && !covered {
            let mut stmt = tx.prepare("SELECT name FROM lines WHERE world_id=?")?;
            let taken: std::collections::HashSet<String> = stmt.query_map([&plan.world_id], |r| r.get::<_, String>(0))?.collect::<std::result::Result<_, _>>()?;
            drop(stmt);
            let name = if !taken.contains("未命名路线") {
                "未命名路线".to_owned()
            } else {
                (2..).map(|i| format!("未命名路线（{i}）")).find(|c| !taken.contains(c)).unwrap()
            };
            tx.execute(
                "INSERT INTO lines(id,world_id,name,node_id,kind,auto_named,created_at) VALUES(?,?,?,?,'line',1,?)",
                params![uuid::Uuid::new_v4().simple().to_string(), plan.world_id, name, head, Utc::now().to_rfc3339()],
            )?;
        }
    }
    Ok(())
}
pub(crate) fn write_usage(
    tx: &Transaction<'_>,
    run: &str,
    world: &str,
    node: Option<&str>,
    outcome: &str,
) -> Result<()> {
    let plan_kind: Option<String> = tx
        .query_row(
            "SELECT json_extract(plan_json, '$.kind') FROM execution_runs WHERE id=?",
            [run],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let mut stmt=tx.prepare("SELECT step_key,input_json,output_json,status FROM execution_steps WHERE run_id=? AND step_key LIKE 'model:%'")?;
    let steps = stmt
        .query_map([run], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    drop(stmt);
    for (key, input, output, status) in steps {
        if status == "unsent" { continue; }
        let input: Value = serde_json::from_str(&input)?;
        let output: Value = output
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let prompt = output["usage"]["prompt_tokens"].as_i64();
        let completion = output["usage"]["completion_tokens"].as_i64();
        let request_outcome = match status.as_str() {
            "done" => outcome,
            "stale" => "no_record",
            "cancelled" => "cancelled",
            "interrupted" => "interrupted",
            _ => "failed",
        };
        let raw_purpose = input["purpose"].as_str().unwrap_or("turn");
        let stored_purpose = if raw_purpose.starts_with("writing:") {
            match plan_kind.as_deref() {
                Some("ask") => "ask",
                Some("correction") => "correction",
                _ => raw_purpose,
            }
        } else {
            raw_purpose
        };
        let usage_id = format!("{run}:{key}");
        let existed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM usage WHERE id=?)", [&usage_id], |r| r.get(0))?;
        tx.execute("INSERT INTO usage(id,world_id,node_id,purpose,model,prompt_tokens,completion_tokens,estimated,first_token_ms,total_ms,outcome,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET node_id=COALESCE(excluded.node_id,usage.node_id),total_ms=COALESCE(excluded.total_ms,usage.total_ms),outcome=CASE WHEN excluded.outcome IN ('ok','no_record') THEN excluded.outcome ELSE usage.outcome END",params![usage_id,world,node,stored_purpose,input["model"].as_str().unwrap_or(""),prompt,completion,prompt.is_none()||completion.is_none(),output["firstTokenMs"].as_i64(),output["totalMs"].as_i64(),request_outcome,Utc::now().to_rfc3339()])?;
        if !existed && status == "done" {
            if let Some(prompt_tokens) = prompt.filter(|&p| p > 200) {
                let model_name = input["model"].as_str().unwrap_or("");
                let req_chars: usize = input["request"]["messages"]
                    .as_array()
                    .map(|msgs| {
                        msgs.iter()
                            .map(|m| m["content"].as_str().map(|s| s.chars().count()).unwrap_or(0))
                            .sum()
                    })
                    .unwrap_or(0);
                if !model_name.is_empty() && req_chars >= 200 {
                    update_token_ratio(tx, model_name, prompt_tokens as f64, req_chars as f64)?;
                }
            }
        }
    }
    Ok(())
}

/// Calibrate per-model tokens-per-character EMA (0.45..=1.5) from reported prompt_tokens.
pub(crate) fn update_token_ratio(tx: &Transaction<'_>, model: &str, prompt_tokens: f64, request_chars: f64) -> Result<()> {
    let observed = (prompt_tokens / request_chars).clamp(0.45, 1.5);
    let key = format!("tokenRatio:{model}");
    let prev: Option<f64> = tx
        .query_row("SELECT value FROM settings WHERE key=?", [&key], |r| r.get::<_, String>(0))
        .optional()?
        .and_then(|s| serde_json::from_str::<f64>(&s).ok())
        .filter(|v| v.is_finite() && *v >= 0.2 && *v <= 3.0);
    let next = match prev {
        Some(old) => (old * 0.75 + observed * 0.25).clamp(0.45, 1.5),
        None => observed,
    };
    let rounded = (next * 10_000.0).round() / 10_000.0;
    tx.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", params![key, rounded.to_string()])?;
    Ok(())
}

fn narrative_contains_taboo(narrative: &str, term: &str) -> bool {
    let mut start = 0;
    while let Some(offset) = narrative[start..].find(term) {
        let end = start + offset + term.len();
        if term == "小时" && narrative[end..].starts_with('候') {
            start = end;
            continue;
        }
        return true;
    }
    false
}

/// Scan narrative against the era card's "不要出现：" line (historical mode only).
/// Returns [{term, instead}] hits so the next turn receives tabooReminder and devMode shows chips.
pub(crate) fn scan_taboos(state: &Value, narrative: &str) -> Vec<Value> {
    if state["era"]["mode"] == "free" || narrative.trim().is_empty() {
        return vec![];
    }
    let Some(content) = state["cards"]
        .as_array()
        .and_then(|cards| cards.iter().find(|c| c["kind"] == "时代"))
        .and_then(|c| c["content"].as_str())
    else {
        return vec![];
    };
    let Some(raw_line) = content.lines().find_map(|line| {
        let trimmed = line.trim();
        let rest = trimmed.strip_prefix("不要出现")?;
        let rest = rest.trim_start();
        rest.strip_prefix('：').or_else(|| rest.strip_prefix(':')).map(str::trim)
    }) else {
        return vec![];
    };
    let mut hits = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw_item in raw_line.split(['；', ';']) {
        let item = raw_item.trim().trim_end_matches(['。', '！', '？', '.', '!', '?']).trim();
        if item.is_empty() {
            continue;
        }
        let (terms_part, instead) = if let Some((head, tail)) = item
            .split_once('（')
            .and_then(|(h, t)| t.strip_suffix('）').map(|inner| (h, inner)))
            .or_else(|| {
                item.split_once('(')
                    .and_then(|(h, t)| t.strip_suffix(')').map(|inner| (h, inner)))
            })
        {
            let clean = tail.trim();
            let clean = clean
                .strip_prefix("该用：")
                .or_else(|| clean.strip_prefix("改用："))
                .or_else(|| clean.strip_prefix("该用:"))
                .or_else(|| clean.strip_prefix("改用:"))
                .unwrap_or(clean)
                .trim();
            (head.trim(), (!clean.is_empty()).then(|| clean.to_owned()))
        } else if let Some((head, tail)) = item.split_once('→') {
            let clean = tail.trim();
            (head.trim(), (!clean.is_empty()).then(|| clean.to_owned()))
        } else {
            (item, None)
        };
        // Skip descriptive behavioral guidance (e.g., 称官员“大人”, 动辄跪地磕头) to avoid false positives.
        if terms_part.contains('“') || terms_part.contains('"') || terms_part.contains('「')
            || terms_part.starts_with("称") || terms_part.starts_with("以") || terms_part.starts_with("动辄")
        {
            continue;
        }
        for raw_term in terms_part.split(['、', '，', ',']) {
            let term = raw_term.trim().trim_end_matches(['。', '！', '？', '.', '!', '?']).trim();
            let len = term.chars().count();
            if !(2..=6).contains(&len) {
                continue;
            }
            if narrative_contains_taboo(narrative, term) && seen.insert(term.to_owned()) {
                hits.push(json!({"term": term, "instead": instead}));
                if hits.len() >= 6 {
                    return hits;
                }
            }
        }
    }
    hits
}
/// Generation tiers (D161): how much the writer may look up before writing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Tier { Fast, Standard, Deep }
impl Tier {
    pub(crate) fn of(plan: &RunPlan) -> Self {
        match plan.meta["depth"].as_str() { Some("fast") => Tier::Fast, Some("standard") => Tier::Standard, _ => Tier::Deep }
    }
    fn tool_rounds(self) -> Option<u64> {
        match self { Tier::Fast => Some(0), Tier::Standard => Some(2), Tier::Deep => Some(4) }
    }
}
/// Lookup rounds for 按原著纠错 and 查一查 before they must answer; each round may read several things.
const LOOKUP_ROUNDS: u64 = 6;
/// The standard tier's lookups: catalog, notes, search/read original, and the story so far.
const STANDARD_TOOLS: [&str; 5] = ["list_sections", "read_canon_notes", "search_original", "read_original", "read_history"];
/// Focused read tools for 按原著纠错: omits unused world/skill/resource schemas to save ~2.5k chars per round.
const CORRECTION_TOOLS: [&str; 9] = [
    "list_sections",
    "search_original",
    "read_original",
    "read_canon_notes",
    "read_canon_facts",
    "locate_original_event",
    "prepare_reference_check",
    "read_history",
    "read_characters",
];
const CORRECTION_RULES: &str = "按原著纠错模式：遵循原著技能与本局资料已附在上下文中，不必读取 read_world 或技能目录。先看已提供的原文与札记，不够再用 list_sections 查章节目录、search_original（可翻页或限定章节）和 read_original 核对原句，最后只返回要求的 JSON 对象，不要输出 <record> 块或调用写入工具。";
/// Focused read tools for 查一查: covers book lookup + story history/resources/continuity without writing or skill clutter.
const ASK_TOOLS: [&str; 9] = [
    "list_sections",
    "search_original",
    "read_original",
    "read_canon_notes",
    "read_canon_facts",
    "read_history",
    "read_characters",
    "read_story_resources",
    "read_continuity",
];
const ASK_RULES: &str = "查一查模式：只回答玩家问题，不推进剧情，不输出 <record> 块，不调用写入工具。先看上下文里已给的本局资料、札记和原文片段；不够时可调用只读工具补查本局旧事、人物、设定、知情线索或绑定原著原文，查清后简明作答，资料不足就直说。";
const ORDINARY_RULES_FAST:&str="普通回合：本回合所需的世界、规则、人物、旧事和原著资料都已在上下文中，直接写本回合正文及<record>。";
const ORDINARY_RULES_STANDARD:&str="普通回合：本回合所需的世界、规则、人物、旧事和原著资料已在上下文中，信息够用就直接写本回合正文及<record>。若涉及原著具体规则、考核方式、人物身份、招式能力、地点细节而上下文里的原文没有覆盖，先用 list_sections / search_original / read_original 查清再写，不要凭印象编造；需要查的几项在同一批里一起查，查完就写；不要调用写入工具。";
const ORDINARY_RULES:&str="普通回合：本回合所需的世界、规则、人物和旧事已在上下文中，直接写本回合正文及<record>。只有在需要核实上下文里没有的具体人物、设定或原著细节时才调用只读工具，不要为了例行检查读取技能或世界资料；不要调用写入工具。";
const CLASSIC_RULES:&str="经典模式：生成和整理顺序由程序安排。你可以读取技能并调用只读工具核实资料。绑定参考书且任务需要原著细节时，按遵循原著技能读取原文，不用模型记忆补齐事实。最后返回本回合正文及<record>；不要调用写入工具。";

#[cfg(test)]
mod correction_notes_tests {
    use super::*;
    #[test]
    fn player_preservation_is_copied_from_trusted_provenance_not_the_model_note() {
        let state = json!({"facts":[{"id":"player","origin":"player","detail":"玩家救下阿兰，阿兰活着。"},{"id":"ai","origin":"ai","detail":"AI自行改错的事实"}]});
        let source = json!({"detail":"姐弟称谓更正","citations":[{"quote":"姐姐"}]});
        let (changes, notes) = separate_correction_sources(
            vec![
                source.clone(),
                json!({"detail":"保留玩家分支：模型在此写了不可信文字","citations":[]}),
            ],
            &state,
        )
        .unwrap();
        assert_eq!(changes, vec![source]);
        assert_eq!(
            notes,
            vec![json!({"id":"player","detail":"玩家救下阿兰，阿兰活着。"})]
        );
        assert!(!json!(notes).to_string().contains("不可信"));
    }
    #[test]
    fn uncited_original_changes_or_unproven_player_notes_are_rejected() {
        let state = json!({"facts":[{"id":"player","origin":"player","detail":"玩家救下阿兰"}]});
        assert!(separate_correction_sources(
            vec![json!({"detail":"原著人物换了身份","citations":[]})],
            &state
        )
        .is_err());
        assert!(separate_correction_sources(
            vec![json!({"detail":"保留玩家分支：AI自行写错也算改写","citations":[]})],
            &json!({"facts":[{"id":"ai","origin":"ai","detail":"自行写错"}]})
        )
        .is_err());
    }
    #[test]
    fn scan_taboos_detects_historical_anachronisms_and_skips_free_mode_or_descriptive_phrases() {
        let state = json!({
            "era": {"mode": "history"},
            "cards": [{
                "kind": "时代",
                "name": "唐 · 天宝",
                "content": "时局：长安。\n不要出现：银两、元宝（日常用铜钱、绢帛）；客栈（邸店）；称官员“大人”（称官名）；烟草"
            }]
        });
        let hits = scan_taboos(&state, "他在客栈掏出二两银两买烟草，又朝大人行礼。");
        let terms: Vec<&str> = hits.iter().filter_map(|h| h["term"].as_str()).collect();
        assert_eq!(terms, vec!["银两", "客栈", "烟草"]);
        assert_eq!(hits[0]["instead"], "日常用铜钱、绢帛");
        assert_eq!(hits[1]["instead"], "邸店");
        assert!(hits[2]["instead"].is_null());
        // Free mode never emits historical taboo hits.
        let free_state = json!({"era": {"mode": "free"}, "cards": state["cards"]});
        assert!(scan_taboos(&free_state, "银两 客栈 烟草").is_empty());
        // "小时" must not false-positive on "小时候", and trailing periods on taboo items are trimmed.
        let clock_state = json!({
            "era": {"mode": "history"},
            "cards": [{"kind":"时代","name":"唐","content":"不要出现：小时（时辰）；玻璃。"}]
        });
        let hits2 = scan_taboos(&clock_state, "他小时候住在长安，从未见过玻璃。");
        let terms2: Vec<&str> = hits2.iter().filter_map(|h| h["term"].as_str()).collect();
        assert_eq!(terms2, vec!["玻璃"]);
        let hits3 = scan_taboos(&clock_state, "等了两个小时。");
        assert_eq!(hits3.iter().filter_map(|h| h["term"].as_str()).collect::<Vec<_>>(), vec!["小时"]);
    }
    #[test]
    fn update_token_ratio_learns_and_smooths_within_bounds() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)", []).unwrap();
        let tx = db.transaction().unwrap();
        update_token_ratio(&tx, "demo-model", 700.0, 1000.0).unwrap();
        let first: f64 = tx.query_row("SELECT value FROM settings WHERE key='tokenRatio:demo-model'", [], |r| r.get::<_, String>(0)).unwrap().parse().unwrap();
        assert!((first - 0.7).abs() < 1e-4, "{first}");
        update_token_ratio(&tx, "demo-model", 1100.0, 1000.0).unwrap();
        let second: f64 = tx.query_row("SELECT value FROM settings WHERE key='tokenRatio:demo-model'", [], |r| r.get::<_, String>(0)).unwrap().parse().unwrap();
        assert!((second - 0.8).abs() < 1e-4, "{second}");
        // Clamped within [0.45, 1.5]
        update_token_ratio(&tx, "extreme-model", 100.0, 1000.0).unwrap();
        let clamped: f64 = tx.query_row("SELECT value FROM settings WHERE key='tokenRatio:extreme-model'", [], |r| r.get::<_, String>(0)).unwrap().parse().unwrap();
        assert!((clamped - 0.45).abs() < 1e-4, "{clamped}");
        tx.commit().unwrap();
    }
}

