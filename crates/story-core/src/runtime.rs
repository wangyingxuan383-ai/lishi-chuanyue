use crate::{
    chat::{self, BoxFuture, Completion, Model, TextSink},
    execution_lease,
    mcp::BuiltinMcp,
    rules, Error, Result, RunBudget, RunPlan, RunSnapshot, Store,
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

pub type LeaseFactory = Arc<dyn Fn(u64) -> Box<dyn Send> + Send + Sync>;
pub type CompletionSink = Arc<dyn Fn(String) + Send + Sync>;

/// Owns whole runs, never a UI subscription. Model waits hold no SQLite lock.
pub struct Engine {
    pub store: Store,
    pub(crate) model: Arc<dyn Model>,
    active: Mutex<HashMap<String, CancellationToken>>,
    lease: LeaseFactory,
    pub(crate) committed: CompletionSink,
}
pub(crate) struct Context {
    pub(crate) plan: RunPlan,
    pub(crate) budget: RunBudget,
    pub(crate) draft: Value,
    pub(crate) started: Instant,
    pub(crate) active_before: u64,
    pub(crate) cancel: CancellationToken,
}
impl Context {
    pub(crate) fn budget(&mut self) -> RunBudget {
        self.budget.active_ms = self.active_before + self.started.elapsed().as_millis() as u64;
        self.budget.clone()
    }
    fn step_budget(&mut self)->RunBudget {
        let mut used=self.budget();
        if self.plan.meta["autoplayBudgetVersion"]=="per-passage-1"&&self.plan.meta["parentRun"].is_string(){
            let base=&self.plan.meta["stepBudgetBase"];
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
        }
    }
    /// Only called once by a fresh native process, before accepting requests.
    pub fn recover_on_start(&self) -> Result<()> {
        self.store.initialize()?;
        let mut db = self.store.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Starting a UI process must not interrupt work owned by :agent, or
        // any other live process. Only expired/unowned stories are recovered.
        tx.execute("UPDATE execution_runs SET status='interrupted',error='进程曾中断，已保留完成步骤，可恢复' WHERE status IN ('running','committing') AND NOT EXISTS(SELECT 1 FROM world_execution_leases l WHERE l.world_id=execution_runs.world_id AND l.owner_id<>'' AND l.expires_at_ms>?)",[execution_lease::now_ms()])?;
        tx.commit()?;
        Ok(())
    }
    pub fn start(self: &Arc<Self>, plan: RunPlan) -> Result<String> {
        self.store.initialize()?;
        self.store.register(&plan)?;
        let id = plan.id.clone();
        self.launch(plan, RunBudget::default(), json!({}))?;
        Ok(id)
    }
    pub fn snapshot(&self, id: &str, after: u64) -> Result<RunSnapshot> {
        self.store.snapshot(id, after)
    }
    pub fn stop(&self, id: &str) -> Result<()> {
        if let Some(token) = self.active.lock().map_err(|_| Error::Cancelled)?.get(id) {
            token.cancel();
        }
        Ok(())
    }
    pub fn stop_all(&self) {
        if let Ok(active) = self.active.lock() {
            for token in active.values() {
                token.cancel();
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
        if self
            .active
            .lock()
            .map_err(|_| Error::Cancelled)?
            .contains_key(id)
        {
            return Ok(());
        }
        let snapshot = self.store.snapshot(id, 0)?;
        if matches!(snapshot.status.as_str(), "committed" | "previewed") {
            return Ok(());
        }
        let plan = self.store.plan(id)?;
        // Store::resume acquires ownership before changing a running flag.
        // A second process cannot mark the first owner's active run stopped.
        self.store.resume(id)?;
        self.launch(plan, snapshot.budget, snapshot.draft)
    }
    pub(crate) fn launch(
        self: &Arc<Self>,
        plan: RunPlan,
        budget: RunBudget,
        draft: Value,
    ) -> Result<()> {
        // Registration persists its fencing ticket. Do not run using the
        // caller's earlier copy, or a restarted process's former ownership.
        let plan = self.store.activate_lease(&plan.id)?;
        let execution_ticket = execution_lease::ticket(&plan)?.ok_or(Error::Stale)?;
        let token = CancellationToken::new();
        let id = plan.id.clone();
        let mut active = self.active.lock().map_err(|_| Error::Cancelled)?;
        if active.contains_key(&id) {
            return Err(Error::Invalid("运行已经在执行".into()));
        }
        active.insert(id.clone(), token.clone());
        drop(active);
        let engine = self.clone();
        let active_before = budget.active_ms;
        let total_ms = if plan.kind=="autoplay" && plan.meta["autoplayBudgetVersion"]=="per-passage-1" {
            300_000 * plan.meta["autoplayCount"].as_u64().unwrap_or(1).clamp(1,100)
        } else {
            300_000
        };
        let context = Arc::new(Mutex::new(Context {
            plan,
            budget,
            draft,
            started: Instant::now(),
            active_before,
            cancel: token.clone(),
        }));
        // The lease exists until settlement, including tools, extraction and commit.
        let lease = (self.lease)(total_ms.saturating_sub(active_before));
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
            let remaining = total_ms.saturating_sub(active_before);
            let outcome = tokio::select! {
                    _=token.cancelled()=>Err(Error::Cancelled),
                    result=tokio::time::timeout(std::time::Duration::from_millis(remaining),engine.execute(context.clone()))=>match result {
                        Ok(result)=>result,
                        Err(_)=>{token.cancel();Err(Error::Limit(if total_ms == 300_000 {"本次运行已达到 5 分钟上限"} else {"已达到本次时长上限"}))}
                    }
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
            if let (true, Err(error)) = (still_owner, outcome) {
                let status = match &error {
                    Error::Cancelled => "cancelled",
                    Error::Limit(_) => "paused",
                    Error::Stale => "stale",
                    _ => "failed",
                };
                let _ = engine.reconcile_children(&context, status);
                let _ = engine.checkpoint(&context);
                let plan = context.lock().ok().map(|c| c.plan.clone());
                if plan.is_some_and(|plan| {
                    engine
                        .store
                        .finish_owned(&plan, status, Some(&error))
                        .is_ok()
                }) {
                    let _ = engine.flush_usage(&id, status);
                    let _ = engine.store.event(&id, json!({"type":"failed","reason":if matches!(error, Error::Cancelled) {"cancelled"} else {"config"},"detail":error.to_string(),"partialSaved":false}));
                }
            }
            token.cancel();
            heartbeat_done.cancel();
            let _ = heartbeat.await;
            if execution_ticket.owner_id == id {
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
        let counters:(i64,i64,i64)=tx.query_row("SELECT COALESCE(MAX(json_extract(budget_json,'$.modelRequests')),0),COALESCE(MAX(json_extract(budget_json,'$.toolCalls')),0),COALESCE(MAX(json_extract(budget_json,'$.corrections')),0) FROM execution_runs WHERE json_extract(plan_json,'$.meta.parentRun')=?",[&c.plan.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
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
        let mut stmt=tx.prepare("SELECT id FROM execution_runs WHERE json_extract(plan_json,'$.meta.parentRun')=? AND status<>'committed'")?;
        let children = stmt
            .query_map([&c.plan.id], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);
        tx.execute("UPDATE execution_runs SET status='interrupted' WHERE json_extract(plan_json,'$.meta.parentRun')=? AND status='running'",[&c.plan.id])?;
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
        execution_lease::guard_plan(&*self.store.lock()?, &c.plan)?;
        let budget = c.budget();
        if c.plan.kind=="autoplay"&&c.plan.meta["autoplayBudgetVersion"]=="per-passage-1" {
            if budget.active_ms>=300_000*c.plan.meta["autoplayCount"].as_u64().unwrap_or(1).clamp(1,100){Err(Error::Limit("连播已达到各段合计的时间保护上限"))}else{Ok(())}
        } else {
            c.step_budget().time()
        }
    }
    async fn complete(
        self: &Arc<Self>,
        shared: &Shared,
        purpose: &str,
        mut messages: Vec<Value>,
        tools: Vec<Value>,
        aux: bool,
    ) -> Result<Completion> {
        self.check(shared)?;
        let plan = shared.lock().map_err(|_| Error::Cancelled)?.plan.clone();
        // Cache identity includes the actual task inputs, model and source scope.
        // A resumed, reassembled stage must never consume another request's result.
        let fingerprint=format!("{:x}",Sha256::digest(json!({"purpose":purpose,"model":plan.model,"messages":messages,"tools":tools,"state":plan.state,"base":plan.base_id,"source":plan.reference}).to_string()));
        let cached: Option<(String,String)> = self.store.lock()?.query_row("SELECT input_json,output_json FROM execution_steps WHERE run_id=? AND kind=? AND status='done' ORDER BY rowid DESC LIMIT 1", params![plan.id,purpose], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((input,cached))=cached {
            let input:Value=serde_json::from_str(&input)?;
            let same=input["fingerprint"]==fingerprint || (input.get("fingerprint").is_none() && {
                let mut old=input["request"]["messages"].as_array().cloned().unwrap_or_default();
                old.retain(|m|!m["content"].as_str().unwrap_or("").starts_with("【本次执行剩余额度】"));
                old==messages && input["request"]["tools"].as_array().map(Vec::as_slice).unwrap_or(&[])==tools.as_slice()
            });
            if same {self.note_reading(shared,input["request"]["messages"].as_array().map(Vec::as_slice).unwrap_or(&[]))?;return Ok(serde_json::from_str(&cached)?);}
        }
        let request_limit = plan.meta["modelRequestLimit"]
            .as_u64()
            .unwrap_or(10)
            .clamp(1, 10) as u32;
        {
            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
            c.budget();
            if c.step_budget().model_requests >= request_limit {
                return Err(Error::Limit(if request_limit == 10 {
                    "本次已达到 10 次模型请求上限"
                } else {
                    "本次模型请求额度已用完"
                }));
            }
            if purpose != "capability" {
                let local_used=c.step_budget();let left = request_limit - local_used.model_requests;
                let originals = c.draft["originalPassages"]
                    .as_array()
                    .map(Vec::len)
                    .unwrap_or(0);
                messages.insert(0,json!({"role":"system","content":format!("【本次执行剩余额度】包括当前这次，尚可请求模型{left}次（内部写作、校核也计数）；工具还可调用{}次；尚余约{}秒。此前已实际读取原文{originals}段。独立查证可同批调用，优先使用已获得的原文和本批工具结果，不重复查询相同证据。额度不足时停止非必要补查：有依据就按本次任务要求输出完整结果；缺依据须明确资料不足，不编造。若本次是最后一次模型请求，完成所需最终输出；Agent用commit_turn，原著改稿返回要求的完整JSON。",24u32.saturating_sub(local_used.tool_calls),300_000u64.saturating_sub(local_used.active_ms)/1000)}));
            }
        }
        let before=crate::stage_context::report(&plan,purpose,&messages,&tools);
        let bounded = crate::context::fit_writing_context(&plan, messages, &tools);
        let mut report=match &bounded {Ok(messages)=>crate::stage_context::report(&plan,purpose,messages,&tools),Err(_)=>before.clone()};
        report["beforeChars"] = before["chars"].clone();
        let target = plan.meta["budgetChars"].as_u64().unwrap_or(12000);
        report["status"] = if bounded.is_err() { "invalid" }
            else if report["chars"].as_u64().unwrap_or(0) > target { "above-target" }
            else { "ready" }.into();
        {
            let mut c=shared.lock().map_err(|_|Error::Cancelled)?;
            if !c.draft["contextReports"].is_object(){c.draft["contextReports"]=json!({});}
            c.draft["contextReports"][purpose]=report.clone();c.draft["phase"]=purpose.into();
        }
        self.checkpoint(shared)?;self.store.run_event(&plan,json!({"type":"request-context","report":report}))?;
        let mut messages=bounded.map_err(|e|Error::Invalid(format!("{}：{}",crate::stage_context::label(purpose),e)))?;
        let mut tools = tools;
        let mut retried = false;
        loop {
            self.check(shared)?;
            let body = chat::request(&plan.model, &messages, &tools, aux);
            let (key, token, remaining) = {
                let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                c.budget();
                if c.step_budget().model_requests >= request_limit {
                    return Err(Error::Limit(if request_limit == 10 {
                        "本次已达到 10 次模型请求上限"
                    } else {
                        "本次模型请求额度已用完"
                    }));
                }
                c.charge_request()?;
                (
                    format!("model:{}", c.budget.model_requests),
                    c.cancel.clone(),
                    300_000u64.saturating_sub(c.step_budget().active_ms),
                )
            };
            self.checkpoint(shared)?;
            self.store.lock()?.execute("INSERT INTO execution_steps(run_id,step_key,kind,status,input_json) VALUES(?,?,?,'running',?)", params![plan.id,key,purpose,json!({"fingerprint":fingerprint,"model":if aux {plan.model.aux_model.as_ref().unwrap_or(&plan.model.model)} else {&plan.model.model},"purpose":purpose,"request":body}).to_string()])?;
            self.store.run_event(&plan, json!({"type":"thinking"}))?;
            let store = self.store.clone();
            let id = plan.id.clone();
            let parent_run = plan.meta["parentRun"].as_str().map(str::to_owned);
            let original = if plan.kind == "continue" {
                plan.original.clone()
            } else {
                String::new()
            };
            let show_text = purpose.starts_with("writing:")
                || purpose.starts_with("tool:compose_draft")
                || purpose.starts_with("tool:check_draft");
            let sink: TextSink = Arc::new(move |text| {
                if !show_text {
                    return;
                }
                let visible = narrative_part(&text);
                if !visible.is_empty() {
                    let event = json!({"type":"text","delta":"","full":format!("{original}{visible}")});
                    let _ = store.event(&id, event.clone());
                    if let Some(parent) = &parent_run {
                        let _ = store.event(parent, event);
                    }
                }
            });
            let future = self
                .model
                .complete(plan.model.clone(), body, token.child_token(), sink);
            let result = tokio::select! {
                _ = token.cancelled() => Err(Error::Cancelled),
                result = tokio::time::timeout(std::time::Duration::from_millis(remaining), future) => match result {
                    Ok(value) => value,
                    Err(_) => { token.cancel(); Err(Error::Limit("本次运行已达到 5 分钟上限")) }
                }
            };
            self.checkpoint(shared)?;
            match result {
                Ok(result) => {
                    self.store.lock()?.execute("UPDATE execution_steps SET status='done',output_json=? WHERE run_id=? AND step_key=?", params![serde_json::to_string(&result)?, plan.id,key])?;
                    self.note_reading(shared, &messages)?;
                    return Ok(result);
                }
                Err(error) => {
                    self.store.lock()?.execute("UPDATE execution_steps SET status='failed',output_json=? WHERE run_id=? AND step_key=?", params![json!({"error":error.to_string()}).to_string(),plan.id,key])?;
                    let can_retry = !retried
                        && shared.lock().map_err(|_| Error::Cancelled)?.step_budget().model_requests < request_limit;
                    if can_retry && matches!(error, Error::ContextWindow) {
                        if let Some((smaller, definitions)) = crate::context::recover_writing_request(&plan, &messages, &tools)? {
                            retried = true;
                            messages = smaller;
                            tools = definitions;
                            let mut report = crate::stage_context::report(&plan, purpose, &messages, &tools);
                            report["status"] = "context-retry".into();
                            report["beforeChars"] = before["chars"].clone();
                            shared.lock().map_err(|_| Error::Cancelled)?.draft["contextReports"][purpose] = report.clone();
                            self.checkpoint(shared)?;
                            self.store.run_event(&plan, json!({"type":"request-context","report":report}))?;
                            continue;
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
                    return match error {
                        Error::Cancelled | Error::Limit(_) | Error::Stale | Error::ContextWindow
                        | Error::Provider { .. } | Error::Refused(_) => Err(error),
                        other => Err(Error::Invalid(format!("{}：{}", crate::stage_context::label(purpose), other))),
                    };
                }
            }
        }
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
                let saved = c.draft["originalPassages"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for passage in saved {
                    if !passages.contains(&passage) {
                        passages.push(passage);
                    }
                }
                c.draft["originalPassages"] = Value::Array(passages);
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
        let has_book = plan.state.get("source").is_some_and(Value::is_object);
        let tools: Vec<Value> = all_tools
            .into_iter()
            .filter(|t| is_read_tool(t["function"]["name"].as_str().unwrap_or("")))
            .collect();
        let mut messages = plan.messages.clone();
        // Ordinary passages already carry the world, rules and recalled facts in
        // their context: telling the model to read skills first cost two extra
        // requests per turn. Checks and corrections keep the full instruction.
        let rules = if matches!(plan.kind.as_str(), "turn" | "variant" | "continue" | "opening" | "autoplay") { format!("{}\n{}", crate::skills::catalog_brief(), ORDINARY_RULES) } else { format!("{}\n{}", crate::skills::catalog_text(), CLASSIC_RULES) };
        messages.insert(0,json!({"role":"system","content":rules}));
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
        let modern=plan.meta["writingContext"].is_object()||plan.meta["correctionRange"].is_object()||matches!(plan.meta["referenceReviewVersion"].as_str(),Some("reference-review-1"|"reference-review-2"));
        let support = if modern {
            self.cached_tool_support(&plan)?.unwrap_or(true)
        } else if has_book {
            self.tool_capability(&shared).await?
        } else {
            false
        };
        if plan.kind == "correction" && !support {
            return Err(Error::Invalid("这个服务与模型尚不支持所需工具调用，请更换支持工具的模型；文字润色仍可使用".into()));
        }
        let mut active_tools = if support { tools.into_iter().filter(|t|has_book||!["search_original","read_original","read_canon_facts","locate_original_event","prepare_reference_check"].contains(&t["function"]["name"].as_str().unwrap_or(""))).collect::<Vec<_>>() } else { vec![] };
        // The native validator owns machine-width bounds. Avoid repeating the
        // 16-digit JS safe-integer ceiling for every locator in each request;
        // meaningful limits (neighbours, batch sizes, text) remain visible.
        if modern {for tool in &mut active_tools{compact_locator_schema(&mut tool["function"]["parameters"]);}}
        let mut round = shared.lock().map_err(|_| Error::Cancelled)?.draft["round"]
            .as_u64()
            .unwrap_or(0);
        let result = loop {
            self.check(&shared)?;
            let attempt=self.complete(&shared,&format!("writing:{round}"),messages.clone(),active_tools.clone(),false).await;
            let response=match attempt {
                Err(error) if modern&&plan.kind!="correction"&&round==0&&!active_tools.is_empty()&&["unsupported tool","tool is not supported","does not support tools","tools are not supported","does not support tool use","不支持工具"].iter().any(|s|error.to_string().to_lowercase().contains(s))=>{self.save_tool_support(&plan,false)?;active_tools.clear();continue;},
                other=>other?,
            };
            if !response.tool_calls.is_empty(){self.save_tool_support(&plan,true)?;}
            if response.tool_calls.is_empty() {
                break response;
            }
            messages.push(chat::assistant_message(&response));
            for call in &response.tool_calls {
                let name = call["function"]["name"].as_str().unwrap_or("");
                let args: Value =
                    serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))?;
                let key = format!("tool:{round}:{}", call["id"].as_str().unwrap_or(""));
                let cached: Option<String> = self.store.lock()?.query_row("SELECT output_json FROM execution_steps WHERE run_id=? AND step_key=? AND status='done'", params![plan.id,key], |r| r.get(0)).optional()?;
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
                        mcp.call(name, &args).await?
                    };
                    self.store.lock()?.execute("INSERT OR REPLACE INTO execution_steps(run_id,step_key,kind,status,input_json,output_json) VALUES(?,?,?,'done',?,?)", params![plan.id,key,name,args.to_string(),output.to_string()])?;
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
            self.finish_preview(&shared, json!({"text":result.text}))?;
            return Ok(());
        }
        if plan.kind == "correction" {
            let response = rules::record::lenient_json(&result.text)
                .ok_or_else(|| if refused(&result,&result.text,false){Error::Refused("AI服务拒绝了本次原著改稿，原路线未改动".into())}else{Error::Invalid("原著改稿预览没有返回完整格式，可恢复重试".into())})?;
            let response = crate::writing_context::local_correction(&plan,&response)?;
            let c = shared.lock().map_err(|_| Error::Cancelled)?;
            if c.draft["originalRead"] != true || c.draft["canonSkillRead"] != true {
                return Err(Error::Invalid(
                    "没有实际读取遵循原著技能和原文，不能把这次改稿标为已查证".into(),
                ));
            }
            let mut reference = plan
                .reference
                .clone()
                .ok_or_else(|| Error::Invalid("未绑定原著资料".into()))?;
            let passages = c.draft["originalPassages"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            reference["passages"] = Value::Array(passages.clone());
            let mut corrections = response["corrections"]
                .as_array()
                .filter(|a| !a.is_empty())
                .cloned()
                .ok_or_else(|| Error::Invalid("尚未查出带原文依据的更正，原路线未改动".into()))?;
            let (source_changes, preserved_player_facts) =
                separate_correction_sources(corrections, &plan.state)?;
            corrections = source_changes;
            for change in &mut corrections {
                let citations = change["citations"]
                    .as_array_mut()
                    .filter(|a| !a.is_empty())
                    .ok_or_else(|| Error::Invalid("每项更正都需要原著引文".into()))?;
                for cite in citations {
                    if cite["bookId"] != plan.state["source"]["bookId"] {
                        return Err(Error::Invalid("改稿出处书籍不符".into()));
                    }
                    let passage = passages
                        .iter()
                        .find(|p| {
                            p["chunk"] == cite["chunk"]
                                && p["section"] == cite["section"]
                                && cite["quote"].as_str().is_some_and(|quote| {
                                    !quote.is_empty()
                                        && p["text"]
                                            .as_str()
                                            .is_some_and(|text| text.contains(quote))
                                })
                        })
                        .ok_or_else(|| Error::Invalid("改稿出处没有对应到实际读过的原句".into()))?;
                    cite["title"] = passage["title"].clone();
                    if passage["page"].is_number() {
                        cite["page"] = passage["page"].clone();
                    }
                    // Offsets come from the immutable excerpt, never a guessed model number.
                    let prefix = passage["text"]
                        .as_str()
                        .unwrap_or("")
                        .split(cite["quote"].as_str().unwrap_or(""))
                        .next()
                        .unwrap_or("");
                    let start = passage["start"].as_u64().unwrap_or(0)
                        + prefix.encode_utf16().count() as u64;
                    cite["start"] = start.into();
                    cite["end"] = (start
                        + cite["quote"].as_str().unwrap_or("").encode_utf16().count() as u64)
                        .into();
                }
            }
            let mut issues = vec![];
            let record = rules::record::normalize_record(&response["record"], &mut issues)
                .ok_or_else(|| Error::Invalid("改稿尚未完成事实整理".into()))?;
            let preview = json!({"anchor":plan.meta["anchor"],"sourceGuard":plan.meta["sourceGuard"].to_string(),"narrative":response["narrative"],"replacement":response["replacement"],"range":response["range"],"unresolved":response["unresolved"],"related":response["related"],"writingVersion":plan.meta["writingVersion"],"record":record,"correctionPatch":response["correctionPatch"],"corrections":corrections,"preservedPlayerFacts":preserved_player_facts,"reference":reference,"baseline":plan.meta["baseline"]});
            drop(c);
            self.finish_preview(&shared, preview)?;
            return Ok(());
        }
        let raw = result.text.clone();
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
                narrative_part(&raw)
            )
        };
        let parsed = rules::parse_record(&raw).map_err(Error::Invalid)?;
        if plan.kind=="opening"&&parsed["openingTitle"].is_string(){shared.lock().map_err(|_|Error::Cancelled)?.draft["openingTitle"]=parsed["openingTitle"].clone();}
        let mut record = parsed["record"].clone();
        if narrative.trim().is_empty() {
            return Err(Error::Invalid("模型没有写出正文，草稿已保留".into()));
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
            if !read && !supplied && !insufficient {
                return Err(Error::Invalid(
                    "没有可核实的原文依据，资料不足，未提交本次正文".into(),
                ));
            }
        }
        if record.is_null()
            || (plan.settings["choiceCount"].as_u64().unwrap_or(0) > 0
                && record["choices"].as_array().is_none_or(Vec::is_empty))
        {
            self.store.run_event(&plan, json!({"type":"organizing"}))?;
            let extraction=crate::stage_context::extraction(&plan,&narrative);
            let extracted = self
                .complete(&shared, "extract", extraction, vec![], true)
                .await?;
            let parsed = rules::parse_record(&format!("<record>{}", extracted.text))
                .map_err(Error::Invalid)?;
            if plan.kind=="opening"&&parsed["openingTitle"].is_string(){shared.lock().map_err(|_|Error::Cancelled)?.draft["openingTitle"]=parsed["openingTitle"].clone();}
            if record.is_null() {
                record = parsed["record"].clone();
            } else if let Some(choices) = parsed["record"].get("choices") {
                record["choices"] = choices.clone();
            }
        }
        if record.is_null() {
            return Err(Error::Invalid(
                "正文已保存为草稿，整理结果不完整，可恢复重试".into(),
            ));
        }
        if has_book && matches!(plan.meta["referenceReviewVersion"].as_str(),Some("reference-review-1"|"reference-review-2")) && !plan.meta["playerNarrative"].is_string() {
            let reviewed=self.review_reference(&shared,&plan,&mcp,&active_tools,&narrative,&record).await?;
            narrative=reviewed["narrative"].as_str().unwrap_or(&narrative).to_owned();record=reviewed["record"].clone();
            shared.lock().map_err(|_|Error::Cancelled)?.draft["referenceReview"]=reviewed["report"].clone();
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
                        seed = rules::apply_record(&seed, &patch, &opts).map_err(Error::Invalid)?
                            ["state"]
                            .clone();
                    }
                }
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
        let mut applied =
            rules::apply_record(&state, &settlement_record, &options).map_err(Error::Invalid)?;
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
            .map_err(Error::Invalid)?["state"]
                .clone();
        }
        {
            if let Some(messages) = plan.meta["upkeepMessages"].as_array() {
                let messages = crate::stage_context::organization(&plan, messages, &narrative);
                if let Some(response) = self.optional_complete(&shared, "upkeep", messages).await? {
                    if let Some(patch) =
                        crate::organize::upkeep_patch(&response.text, &applied["state"])
                    {
                        shared.lock().map_err(|_| Error::Cancelled)?.draft["upkeepPatch"] = patch;
                    }
                    shared.lock().map_err(|_| Error::Cancelled)?.draft["upkeepAttempted"] =
                        true.into();
                }
            }
            if let Some(messages) = plan.meta["chapterMessages"].as_array() {
                let (mut messages, groups) = crate::stage_context::chapter(messages, &narrative, plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize);
                if state["era"]["mode"] == "free" {
                    for message in &mut messages {
                        if message["role"] == "system" {
                            message["content"] = message["content"]
                                .as_str()
                                .unwrap_or("")
                                .replace("历史互动小说", "互动小说")
                                .into();
                        }
                    }
                }
                let mut summaries=vec![];let mut complete=true;
                if groups.len()>1 {
                    for (index, group) in groups.iter().enumerate(){
                        let mut request=messages.clone();let content=request.last_mut().ok_or_else(||Error::Invalid("章节上下文缺失".into()))?;
                        content["content"]=format!("{}\n【本章剧情·第{}/{}组】\n{}\n仅总结本组实际发生的事，后续将合并整章。",content["content"].as_str().unwrap_or(""),index+1,groups.len(),group).into();
                        if let Some(response)=self.optional_complete(&shared,&format!("chapter:part:{index}"),request).await? {
                            if let Some(chapter)=crate::organize::parse_chapter(&response.text){summaries.push(chapter);}else{complete=false;break;}
                        }else{complete=false;break;}
                    }
                }
                let content=messages.last_mut().ok_or_else(||Error::Invalid("章节上下文缺失".into()))?;
                content["content"]=format!("{}\n【本章剧情】\n{}",content["content"].as_str().unwrap_or(""),if groups.len()>1{format!("以下为按原文顺序核实的分组摘要，请合并整章，不能新增事实：\n{}",json!(summaries))}else{groups.first().cloned().unwrap_or_default()}).into();
                if let Some(response) = if complete {self.optional_complete(&shared, "chapter", messages).await?} else {None}
                {
                    if let Some(chapter) = crate::organize::parse_chapter(&response.text) {
                        shared.lock().map_err(|_| Error::Cancelled)?.draft["chapter"] = chapter;
                    }
                }
            }
        }
        self.checkpoint(&shared)?;
        let result = self.commit(&shared, &narrative, record, &applied, &result)?;
        self.store.run_event(&plan,json!({"type":"done","worldId":plan.world_id,"nodeId":result["nodeId"],"chips":applied["chips"]}))?;
        (self.committed)(format!(
            "{}:{}",
            plan.world_id,
            result["nodeId"].as_str().unwrap_or("")
        ));
        Ok(())
    }

    async fn review_reference(self:&Arc<Self>, shared:&Shared, plan:&RunPlan, mcp:&BuiltinMcp, tools:&[Value], narrative:&str, record:&Value)->Result<Value>{
        let cap=plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize;
        let parts=crate::stage_context::parts(narrative,(cap/6).clamp(256,2400));
        let mut body=String::new();let mut current=record.clone();let mut findings=vec![];let mut unresolved=vec![];
        for (index,part) in parts.iter().enumerate(){
            self.check(shared)?;
            let reviewed=self.review_reference_part(shared,plan,mcp,tools,part,&current,index).await?;
            body.push_str(reviewed["narrative"].as_str().unwrap_or(part));current=reviewed["record"].clone();
            findings.extend(reviewed["report"]["findings"].as_array().cloned().unwrap_or_default());
            unresolved.extend(reviewed["report"]["unresolved"].as_array().cloned().unwrap_or_default());
        }
        Ok(json!({"narrative":body,"record":current,"report":{"version":"reference-review-2","parts":parts.len(),"findings":findings,"unresolved":unresolved,"status":if unresolved.is_empty(){"reviewed"}else{"partial"}}}))
    }
    async fn review_reference_part(self:&Arc<Self>, shared:&Shared, plan:&RunPlan, mcp:&BuiltinMcp, tools:&[Value], narrative:&str, record:&Value,part:usize)->Result<Value>{
        self.store.run_event(plan,json!({"type":"organizing","phase":"reference-review"}))?;
        let compact=crate::stage_context::state(&plan.state,narrative,(plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize/10).min(1500)).to_string();
        let mut reference=plan.reference.clone().unwrap_or(Value::Null);
        let mut left=(plan.meta["budgetChars"].as_u64().unwrap_or(12000)/4) as usize;
        let mut evidence=vec![];
        for p in reference["passages"].as_array().into_iter().flatten().filter(|p|p["kind"]=="original") {let cost=p.to_string().encode_utf16().count();if cost<=left{left-=cost;evidence.push(p.clone());}}
        reference["passages"]=evidence.into();
        let mut messages=vec![json!({"role":"system","content":r#"核对尚未保存草稿中新引入的关键身份、关系、称谓、能力、物品、时间和事件。保留玩家明确分支，AI自行写错不算玩家改写。先用已提供原文，需要时批量定位具体主张，再read_original读原文与邻文，不扫描整本书。只纠正有依据的细节，不替玩家作决定，不补回已经改变的命运。缺少原文依据的具体值保留不确定性；确实影响当前关键情节且必须玩家决定时填写needsPlayer。最后只返回JSON：{"replacement":"完整核对后的本段正文","recordPatch":{仅受改稿影响的记录字段},"findings":[{"claim":"具体主张","status":"supported/branch/uncertain","playerFactId":"branch时对应的玩家事实ID","playerQuote":"当前是玩家写入正文时也可引用其准确原句；来源不明的旧事实标uncertain","citations":[{"bookId":"书籍ID","section":0,"chunk":0,"quote":"实际读到的原句"}]}],"unresolved":["资料不足"],"needsPlayer":"必要问题，可省略"}。没有新关键事实时findings可为空；核对说明不进入正文。"#}),json!({"role":"user","content":format!("【玩家行动】{}\n【原著用法】{}\n【当前必要事实】{}\n【玩家事实定位】{}\n【已提供原文】{}\n【待核对正文】{}\n【原回合记录】{}",plan.action,plan.state["source"],compact,crate::stage_context::facts(&plan.state,narrative,(plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize/12).min(1400)),reference,narrative,record)})];
        for round in 0..2 {
            let final_round=round==1;
            messages.push(json!({"role":"system","content":if final_round {"这是本段核对的收尾请求，不再调用工具。根据实际已读材料输出完整JSON，保留玩家分支；不能核实的项目标uncertain并写入unresolved，不能把候选或推测当原著。确实必须玩家决定的关键矛盾填needsPlayer。不延长检索，不把无法核实说成已核实。".to_owned()} else {format!("本段核对第{}轮，最多再有{}轮查证，然后必须返回JSON结论。只检查草稿新引入的具体细节；复用当前已有原句，候选够用后read_original，不再次用相同人物名泛搜；互不依赖的问题同批查证。",round+1,1-round)}}));
            let review_tools=if final_round{vec![]}else{tools.iter().filter(|t|["read_original","prepare_reference_check","read_canon_facts","read_history","read_characters"].contains(&t["function"]["name"].as_str().unwrap_or(""))).cloned().collect()};
            let result=self.complete(shared,&format!("reference-review:{part}:{round}"),messages.clone(),review_tools,false).await?;
            if !result.tool_calls.is_empty(){
                messages.push(chat::assistant_message(&result));
                for call in &result.tool_calls {
                    let name=call["function"]["name"].as_str().unwrap_or("");
                    if !is_read_tool(name){return Err(Error::Invalid("原著核对只允许读取与预演".into()));}
                    let args:Value=serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))?;
                    let key=format!("reference-tool:{part}:{round}:{}",call["id"].as_str().unwrap_or(""));
                    let cached=self.store.lock()?.query_row("SELECT output_json FROM execution_steps WHERE run_id=? AND step_key=? AND status='done'",params![plan.id,key],|r|r.get::<_,String>(0)).optional()?;
                    let value=if let Some(cached)=cached {serde_json::from_str(&cached)?} else {
                        shared.lock().map_err(|_|Error::Cancelled)?.charge_tool()?; self.checkpoint(shared)?;
                        let output=mcp.call(name,&args).await?;
                        self.store.lock()?.execute("INSERT OR REPLACE INTO execution_steps(run_id,step_key,kind,status,input_json,output_json) VALUES(?,?,?,'done',?,?)",params![plan.id,key,name,args.to_string(),output.to_string()])?;output
                    };
                    messages.push(json!({"role":"tool","tool_call_id":call["id"],"content":value.to_string()}));
                }
                continue;
            }
            let mut report=match rules::record::lenient_json(&result.text){Some(report)=>report,None=>{
                if refused(&result,&result.text,false){return Err(Error::Refused("AI服务拒绝了这次原著核对，正文草稿已保留，原路线未改动。请检查服务提示或换用可用模型后继续。".into()));}
                if !final_round{messages.push(json!({"role":"assistant","content":result.text}));messages.push(json!({"role":"user","content":"请按要求返回完整JSON核对结果；资料不足标uncertain，不再展开查证。"}));continue;}
                return Err(Error::Invalid("原著核对未返回完整结果，正文草稿已保留，可继续重试".into()));
            }};
            let provided=shared.lock().map_err(|_|Error::Cancelled)?.draft["originalPassages"].as_array().cloned().unwrap_or_default();
            if let Err(error)=crate::writing_context::validate_findings(&report,&provided,&plan.state,&plan.action){
                if !final_round{messages.push(json!({"role":"assistant","content":result.text}));messages.push(json!({"role":"user","content":format!("核对格式或依据未通过：{}。保留有效结果，补查或标明uncertain；不要把不明来源旧状态当玩家分支。",error)}));continue;}
                // Unverified evidence does not become a protected branch or a
                // verified correction. Keep the untouched draft and surface each
                // missing basis; a local correction can perform deeper checking.
                if !report["findings"].is_array(){return Err(error);}
                let mut unresolved=report["unresolved"].as_array().cloned().unwrap_or_default();
                for finding in report["findings"].as_array_mut().unwrap(){
                    if crate::writing_context::validate_findings(&json!({"findings":[finding.clone()]}),&provided,&plan.state,&plan.action).is_err(){
                        unresolved.push(format!("{}：尚未取得有效原文或玩家分支依据",finding["claim"].as_str().unwrap_or("关键细节")).into());
                        finding["status"]="uncertain".into();finding["citations"]=json!([]);
                    }
                }
                report["unresolved"]=unresolved.into();report["replacement"]=narrative.into();report["recordPatch"]=json!({});
            }
            shared.lock().map_err(|_|Error::Cancelled)?.draft["referenceReview"]=report.clone(); self.checkpoint(shared)?;
            if let Some(question)=report["needsPlayer"].as_str().filter(|s|!s.trim().is_empty()){return Err(Error::Invalid(format!("这段关键情节还需确认：{question}")));}
            let mut local=plan.clone();local.meta["anchor"]=json!({"original":narrative});local.meta["correctionRange"]=json!({"start":0,"end":narrative.encode_utf16().count()});local.meta["originalRecord"]=record.clone();
            let revised=crate::writing_context::local_correction(&local,&report)?;
            let mut issues=vec![];let record=rules::record::normalize_record(&revised["record"],&mut issues).ok_or_else(||Error::Invalid("核对后的回合记录无效，草稿已保留".into()))?;
            return Ok(json!({"narrative":revised["narrative"],"record":record,"report":{"version":"reference-review-1","findings":report["findings"],"unresolved":report["unresolved"],"status":if report["unresolved"].as_array().is_some_and(|a|!a.is_empty()){"partial"}else{"reviewed"}}}));
        }
        Err(Error::Invalid("关键细节仍需补查，草稿已保留；请缩小待查问题或补充必要线索".into()))
    }

    fn cached_tool_support(&self,plan:&RunPlan)->Result<Option<bool>>{
        let key=format!("toolCapability:{}:{}:{}",plan.model.slot,plan.model.url,plan.model.model);
        let raw=self.store.lock()?.query_row("SELECT value FROM settings WHERE key=?",[key],|r|r.get::<_,String>(0)).optional()?;
        Ok(raw.and_then(|s|serde_json::from_str::<Value>(&s).ok()).filter(|v|Utc::now().timestamp_millis()-v["at"].as_i64().unwrap_or(0)<86_400_000).and_then(|v|v["supported"].as_bool()))
    }
    fn save_tool_support(&self,plan:&RunPlan,supported:bool)->Result<()>{
        let key=format!("toolCapability:{}:{}:{}",plan.model.slot,plan.model.url,plan.model.model);
        self.store.lock()?.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",params![key,json!({"at":Utc::now().timestamp_millis(),"supported":supported}).to_string()])?;Ok(())
    }

    async fn tool_capability(self: &Arc<Self>, shared: &Shared) -> Result<bool> {
        let plan = shared.lock().map_err(|_| Error::Cancelled)?.plan.clone();
        let key = format!(
            "toolCapability:{}:{}:{}",
            plan.model.slot, plan.model.url, plan.model.model
        );
        let cached: Option<String> = self
            .store
            .lock()?
            .query_row("SELECT value FROM settings WHERE key=?", [&key], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(value) = cached {
            if let Ok(value) = serde_json::from_str::<Value>(&value) {
                if Utc::now().timestamp_millis() - value["at"].as_i64().unwrap_or(0) < 86_400_000 {
                    return Ok(value["supported"].as_bool().unwrap_or(false));
                }
            }
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
            Err(Error::Invalid(message))
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
        self.store.lock()?.execute(
            "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
            params![
                key,
                json!({"at":Utc::now().timestamp_millis(),"supported":supported}).to_string()
            ],
        )?;
        Ok(supported)
    }

    async fn optional_complete(
        self: &Arc<Self>,
        shared: &Shared,
        purpose: &str,
        messages: Vec<Value>,
    ) -> Result<Option<Completion>> {
        let plan = shared.lock().map_err(|_| Error::Cancelled)?.plan.clone();
        self.store.run_event(&plan, json!({"type":"organizing"}))?;
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
        state["protagonist"]["stats"]["money"] =
            rules::money::parse_money(&record["money"], currency)
                .unwrap_or(plan.meta["startMoney"].as_f64().unwrap_or(0.0))
                .max(0.0)
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
        execution_lease::guard_plan(&tx, plan)?;
        let time = Utc::now().to_rfc3339();
        if let Some(world) = &plan.new_world {
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
        for key in ["settingsGuard", "sourceGuard", "targetId", "executionLease"] {
            if let Some(object) = meta.as_object_mut() {
                object.remove(key);
            }
        }
        meta["chips"] = applied["chips"].clone();
        meta["notes"] = applied["notes"].clone();
        meta["log"] = applied["log"].clone();
        meta["model"] = plan.model.model.clone().into();
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
            meta["openingSeed"] = plan.state.clone();
        }
        let mut state = applied["state"].clone();
        let mut facts=state["facts"].as_array().cloned().unwrap_or_else(||if plan.kind=="opening"{vec![]}else{vec![json!({"id":format!("legacy:{}",plan.base_id.as_deref().unwrap_or("")),"detail":"此前资料来源未记录，涉及原著细节需要核实；不自动清洗旧剧情","origin":"legacyUnknown","citations":[]})]});
        if let Some(action) = plan.action["text"].as_str().filter(|s| !s.is_empty()) {
            facts.push(json!({"id":uuid::Uuid::new_v4().simple().to_string(),"nodeId":id,"detail":format!("玩家输入（不是行动结果）：{action}"),"origin":"player","citations":[]}));
        }
        if let Some(detail) = record["log"].as_str().filter(|s| !s.is_empty()) {
            facts.push(json!({"id":uuid::Uuid::new_v4().simple().to_string(),"nodeId":id,"detail":detail,"origin":"ai","citations":[]}));
        }
        state["facts"] = Value::Array(facts);
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
            let edited = rules::apply_record(&state, &patch, &opts).map_err(Error::Invalid)?;
            state = edited["state"].clone();
            tx.execute(
                "UPDATE states SET state_json=? WHERE node_id=?",
                params![state.to_string(), trailing],
            )?;
            head = trailing.clone();
        }
        for edit in &plan.carried_edits {
            let mut options = plan.options.clone();
            options["advanceTime"] = false.into();
            let next =
                rules::apply_record(&state, &edit["record"], &options).map_err(Error::Invalid)?;
            if next["state"] == state {
                continue;
            }
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
                &json!({"text":format!("{}（已沿用）",edit["actionText"].as_str().unwrap_or(""))}),
                "",
                &edit["record"],
                &json!({"chips":next["chips"]}),
                &state,
                &time,
            )?;
            head = next_id;
        }
        if c.draft["upkeepPatch"].is_object() {
            let patch = &c.draft["upkeepPatch"];
            let mut opts = plan.options.clone();
            opts["advanceTime"] = false.into();
            let next = rules::apply_record(&state, patch, &opts).map_err(Error::Invalid)?;
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
                    &json!({"by":"AI","promptVersion":plan.meta["upkeepVersion"],"chips":next["chips"]}),
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
                Ok(json!({"summary":crate::writing_context::project_state(&plan.state,&json!({"currency":plan.options["currency"],"clock":plan.options["clock"]}),plan.action["text"].as_str().unwrap_or("")),"settings":plan.settings,"referenceBinding":plan.state["source"],"partial":true,"available":{"people":plan.state["people"].as_array().map(Vec::len).unwrap_or(0),"places":plan.state["places"].as_array().map(Vec::len).unwrap_or(0),"cards":plan.state["cards"].as_array().map(Vec::len).unwrap_or(0)},"next":"人物按read_characters(query,offset,limit)读取，历史按read_history(query)搜索；完整状态保留本机，不代表其他资料为空。"}))
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
                let path = "WITH RECURSIVE up(id,parent_id,narrative,record_json,seq) AS (SELECT id,parent_id,narrative,record_json,seq FROM nodes WHERE id=? UNION ALL SELECT n.id,n.parent_id,n.narrative,n.record_json,n.seq FROM nodes n JOIN up ON n.id=up.parent_id) ";
                let mut stmt=db.prepare(&format!("{path} SELECT id,narrative,record_json FROM up WHERE narrative<>'' AND (?='' OR instr(narrative,?)>0 OR instr(COALESCE(record_json,''),?)>0) ORDER BY seq DESC LIMIT ?"))?;
                let rows=stmt.query_map(params![plan.head_id,query,query,query,limit],|r|Ok(json!({"id":r.get::<_,String>(0)?,"narrative":r.get::<_,String>(1)?,"record":r.get::<_,Option<String>>(2)?})))?;
                let turns = rows.collect::<std::result::Result<Vec<_>, _>>()?;
                let mut stmt = db.prepare(&format!("{path} SELECT c.id,c.title,c.summary FROM chapters c WHERE c.world_id=? AND c.last_node_id IN (SELECT id FROM up) AND (?='' OR instr(c.summary,?)>0 OR instr(c.title,?)>0) ORDER BY c.created_at DESC LIMIT ?"))?;
                let rows=stmt.query_map(params![plan.head_id,plan.world_id,query,query,query,limit], |r| Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,Option<String>>(1)?,"summary":r.get::<_,String>(2)?})))?;
                let chapters = rows.collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(history_excerpts(&plan, turns, chapters, query))
            }
            "search_original" | "read_original" | "read_canon_facts" | "locate_original_event" | "prepare_reference_check" | "preview_turn_record" => {
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
            | "search_original"
            | "read_original"
            | "read_canon_facts"
            | "list_skills"
            | "read_skill"
            | "read_skill_resource"
    )
}

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
        Error::Provider { kind, status, partial: false, .. }
            if kind == "network"
                || (kind == "http" && status.is_some_and(|s| s == 429 || s >= 500)) =>
        {
            Some(std::time::Duration::from_secs(if *status == Some(429) && kind == "http" { 2 } else { 1 }))
        }
        _ => None,
    }
}

fn refused(result: &Completion, text: &str, has_record: bool) -> bool {
    if matches!(
        result
            .finish_reason
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "content_filter" | "safety" | "prohibited_content" | "recitation"
    ) {
        return true;
    }
    let chinese = text
        .chars()
        .filter(|c| ('\u{3400}'..='\u{9fff}').contains(c))
        .count();
    let latin = text.chars().filter(char::is_ascii_alphabetic).count();
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    !has_record
        && ((chinese < 20 && latin >= 20 && latin > chinese * 3)
            || (compact.encode_utf16().count() < 80
                && [
                    "抱歉，我无法",
                    "抱歉，我不能",
                    "我无法继续",
                    "我不能继续",
                    "作为AI",
                    "作为一个AI",
                    "作为人工智能",
                    "Ican't",
                    "Icannot",
                    "I'msorry",
                ]
                .iter()
                .any(|s| compact.contains(s))))
}
pub fn narrative_part(text: &str) -> String {
    let end = text
        .to_ascii_lowercase()
        .find("<record")
        .unwrap_or(text.len());
    let mut visible = &text[..end];
    for marker in ["<", "<r", "<re", "<rec", "<reco", "<recor"] {
        if visible.ends_with(marker) {
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
    let branch:Option<(String,i64)>=tx.query_row("WITH RECURSIVE tail(id,last_child_id,n) AS (SELECT id,last_child_id,1 FROM nodes WHERE id=(SELECT last_child_id FROM nodes WHERE id=?) UNION ALL SELECT n.id,n.last_child_id,t.n+1 FROM nodes n JOIN tail t ON n.id=t.last_child_id) SELECT id,n FROM tail ORDER BY n DESC LIMIT 1",[base],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((head, n)) = branch {
        if n >= 3
            && !tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM lines WHERE world_id=? AND node_id=? AND id<>?)",
                params![plan.world_id, head, plan.line_id],
                |r| r.get::<_, bool>(0),
            )?
        {
            tx.execute("INSERT INTO lines(id,world_id,name,node_id,kind,auto_named,created_at) VALUES(?,?,'未命名路线',?,'line',1,?)",params![uuid::Uuid::new_v4().simple().to_string(),plan.world_id,head,Utc::now().to_rfc3339()])?;
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
        let input: Value = serde_json::from_str(&input)?;
        let output: Value = output
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let prompt = output["usage"]["prompt_tokens"].as_i64();
        let completion = output["usage"]["completion_tokens"].as_i64();
        tx.execute("INSERT INTO usage(id,world_id,node_id,purpose,model,prompt_tokens,completion_tokens,estimated,first_token_ms,total_ms,outcome,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET node_id=COALESCE(excluded.node_id,usage.node_id),outcome=CASE WHEN excluded.outcome='ok' THEN 'ok' ELSE usage.outcome END",params![format!("{run}:{key}"),world,node,input["purpose"].as_str().unwrap_or("turn"),input["model"].as_str().unwrap_or(""),prompt,completion,prompt.is_none()||completion.is_none(),output["firstTokenMs"].as_i64(),output["totalMs"].as_i64(),if status=="done" {outcome} else {"failed"},Utc::now().to_rfc3339()])?;
    }
    Ok(())
}
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
}
