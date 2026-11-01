//! Independent conversations. Normal story generation stays classic; an Agent
//! task borrows the story while running and explicitly returns authored edits.
use crate::{
    agent_budget, agent_control as control, agent_tools as tools, agent_workspace as ws,
    chat::{self, Completion, TextSink},
    mcp::BuiltinMcp,
    runtime::{Engine, Shared},
    Error, ExecutionMode, ModelConfig, Result, RunBudget, RunPlan, Store,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) const PROMPT_VERSION: &str = "agent-task-2.2.0";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub model_requests: u32,
    pub tool_calls: u32,
    pub active_ms: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            model_requests: 0,
            tool_calls: 0,
            active_ms: 0,
        }
    }
}
impl Limits {
    fn legacy() -> Self {
        Self {
            model_requests: 30,
            tool_calls: 100,
            active_ms: 900_000,
        }
    }
    pub(crate) fn model_exhausted(&self, used: u32) -> bool {
        self.model_requests != 0 && used >= self.model_requests
    }
    pub(crate) fn tools_exhausted(&self, used: u32) -> bool {
        self.tool_calls != 0 && used >= self.tool_calls
    }
    pub(crate) fn time_exhausted(&self, used: u64) -> bool {
        self.active_ms != 0 && used >= self.active_ms
    }
    pub(crate) fn remaining_models(&self, used: u32) -> Option<u32> {
        (self.model_requests != 0).then(|| self.model_requests.saturating_sub(used))
    }
    fn read(value: &Value) -> Result<Self> {
        let default = Self::default();
        for name in ["modelRequests", "toolCalls", "activeMs"] {
            if value
                .get(name)
                .is_some_and(|v| !v.is_null() && v.as_u64().is_none())
            {
                return Err(Error::Invalid("执行上限须为非负整数，0表示不限制".into()));
            }
        }
        let result = Self {
            model_requests: value["modelRequests"]
                .as_u64()
                .unwrap_or(default.model_requests as u64)
                .try_into()
                .map_err(|_| Error::Invalid("模型额度无效".into()))?,
            tool_calls: value["toolCalls"]
                .as_u64()
                .unwrap_or(default.tool_calls as u64)
                .try_into()
                .map_err(|_| Error::Invalid("工具额度无效".into()))?,
            active_ms: value["activeMs"].as_u64().unwrap_or(default.active_ms),
        };
        if result.model_requests != 0 && !(1..=300).contains(&result.model_requests)
            || result.tool_calls != 0 && !(1..=1000).contains(&result.tool_calls)
            || result.active_ms != 0 && !(60_000..=7_200_000).contains(&result.active_ms)
        {
            return Err(Error::Invalid(
                "上限可为0（不限制），或模型1—300次、工具1—1000次、时间1—120分钟".into(),
            ));
        }
        Ok(result)
    }
}
pub(crate) fn limits(plan: &RunPlan) -> Limits {
    serde_json::from_value(plan.meta["agent"]["limits"].clone())
        .unwrap_or_else(|_| Limits::legacy())
}
pub(crate) fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| Error::Invalid(format!("缺少{key}")))
}
fn session(db: &rusqlite::Connection, id: &str) -> Result<Value> {
    let mut rows=ws::rows(db,"SELECT id,world_id AS worldId,line_id AS lineId,title,created_at AS createdAt,updated_at AS updatedAt FROM agent_sessions WHERE id=?",&[&id])?;
    rows.pop()
        .ok_or_else(|| Error::Invalid("Agent对话不存在".into()))
}
pub(crate) fn task_row(db: &rusqlite::Connection, id: &str) -> Result<Value> {
    ws::rows(db, "SELECT * FROM agent_tasks WHERE id=?", &[&id])?
        .pop()
        .ok_or_else(|| Error::Invalid("Agent任务不存在".into()))
}
pub(crate) fn message(
    db: &rusqlite::Connection,
    session: &str,
    task: &str,
    role: &str,
    content: &str,
) -> Result<()> {
    db.execute("INSERT INTO agent_messages(id,session_id,task_id,role,content,created_at) VALUES(?,?,?,?,?,?)",params![ws::id(),session,task,role,content,ws::now()])?;
    Ok(())
}
fn task_json(db: &rusqlite::Connection, row: &Value) -> Result<Value> {
    let run = ws::text(row, "run_id");
    let stored: Option<(String, String, String, Option<String>, Option<String>)> = db
        .query_row(
            "SELECT status,plan_json,budget_json,result_json,error FROM execution_runs WHERE id=?",
            [run],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let mut result = ws::parse(ws::text(row, "result_json"));
    let mut status = ws::text(row, "status").to_owned();
    let mut model = Value::Null;
    let mut caps = Value::Null;
    let mut budget = Value::Null;
    let mut error = row["error"].clone();
    if let Some((run_status, plan, b, run_result, run_error)) = stored {
        let p = ws::parse(&plan);
        model = p["meta"]["agent"]["modelSnapshot"].clone();
        caps = p["meta"]["agent"]["limits"].clone();
        budget = ws::parse(&b);
        if [
            "running",
            "paused",
            "failed",
            "cancelled",
            "interrupted",
            "stale",
        ]
        .contains(&status.as_str())
        {
            status = run_status;
        }
        if result.is_null() {
            result = run_result.map(|s| ws::parse(&s)).unwrap_or(Value::Null)
        }
        if error.is_null() {
            error = json!(run_error)
        }
    }
    let backup = ws::parse(ws::text(row, "backup_json"));
    let can_undo = status == "committed"
        && !backup.is_null()
        && ws::fingerprint(db, ws::text(&backup, "worldId"))
            .map(|s| s == ws::text(&backup, "postFingerprint"))
            .unwrap_or(false);
    let control = control::state(db, ws::text(row, "id"))?;
    let subtasks=ws::rows(db,"SELECT id,name,prompt,status,intent_revision AS intentRevision,base_fingerprint AS baseFingerprint,result_json,created_at AS createdAt FROM agent_subtasks WHERE task_id=? ORDER BY created_at",&[&ws::text(row,"id")])?.into_iter().map(|mut s|{s["result"]=ws::parse(ws::text(&s,"result_json"));s.as_object_mut().unwrap().remove("result_json");s}).collect::<Vec<_>>();
    let inputs = control::inputs(db, ws::text(row, "session_id"), Some(ws::text(row, "id")))?;
    let run_plan = db
        .query_row(
            "SELECT plan_json FROM execution_runs WHERE id=?",
            [run],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .map(|s| ws::parse(&s))
        .unwrap_or(Value::Null);
    let phase = if status == "waiting_user" && !control["question"].is_null() {
        "waiting_user"
    } else {
        status.as_str()
    };
    let input_budget = if let Ok(mut plan) = serde_json::from_value::<RunPlan>(run_plan.clone()) {
        let draft = db
            .query_row(
                "SELECT draft_json FROM execution_runs WHERE id=?",
                [run],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(|s| ws::parse(&s))
            .unwrap_or(Value::Null);
        agent_budget::restore(&mut plan, &draft);
        serde_json::to_value(agent_budget::input(&plan))?
    } else {
        Value::Null
    };
    Ok(
        json!({"id":row["id"],"runId":run,"sessionId":row["session_id"],"text":row["text"],"status":status,"phase":phase,"policy":row["policy"],"readOnly":run_plan["meta"]["agent"]["readOnly"],"canonVerificationVersion":run_plan["meta"]["agent"]["canonVerificationVersion"],"requiresOriginalEvidence":run_plan["meta"]["agent"]["requiresOriginalEvidence"],"model":model,"inputTokens":run_plan["options"]["contextTokens"],"inputBudget":input_budget,"limits":caps,"budget":budget,"summary":result["summary"],"changes":result["changes"],"preview":result["preview"],"result":result,"error":error,"canUndo":can_undo,"plan":control["plan"],"question":control["question"],"inputs":inputs,"context":control["context"],"subtasks":subtasks,"createdAt":row["created_at"],"updatedAt":row["updated_at"]}),
    )
}
pub(crate) fn failed(store: &Store, run: &str, status: &str, error: &str) -> Result<()> {
    let db = store.lock()?;
    db.execute("UPDATE agent_tasks SET status=?,error=?,updated_at=? WHERE run_id=? AND status NOT IN ('committed','previewed','archived','undone')",params![status,error,ws::now(),run])?;
    Ok(())
}
impl Engine {
    pub fn agent(self: &Arc<Self>, request: Value) -> Result<Value> {
        self.store.initialize()?;
        if let Some(result) = crate::agent_packages::rpc(&self.store, &request)? {
            return Ok(result);
        }
        match required(&request, "op")? {
            "enqueue_input" => {
                let result = control::enqueue(&self.store, &request)?;
                if result["delivery"] == "queued" {
                    let sid = request["sessionId"]
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| {
                            self.store
                                .lock()
                                .ok()?
                                .query_row(
                                    "SELECT session_id FROM agent_tasks WHERE id=?",
                                    [request["taskId"].as_str().unwrap_or("")],
                                    |r| r.get::<_, String>(0),
                                )
                                .ok()
                        });
                    if let Some(sid) = sid {
                        self.start_next_queued(&sid)?;
                    }
                }
                Ok(result)
            }
            "cancel_queued" => control::cancel_queued(&self.store, required(&request, "inputId")?),
            "answer_question" => {
                let result = control::answer(&self.store, &request)?;
                let task = required(&request, "taskId")?;
                let (run,running):(String,String)=self.store.lock()?.query_row("SELECT id,status FROM execution_runs WHERE id=(SELECT run_id FROM agent_tasks WHERE id=?)",[task],|r|Ok((r.get(0)?,r.get(1)?)))?;
                if result["cancelled"] == true {
                    self.stop(&run)?;
                }
                if result["resume"] == true {
                    if running != "running" && running != "committing" {
                        if self.is_active(&run) {
                            let engine = self.clone();
                            let task = task.to_owned();
                            tokio::spawn(async move {
                                while engine.is_active(&run) {
                                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                                }
                                let eligible = engine
                                    .store
                                    .lock()
                                    .ok()
                                    .and_then(|db| {
                                        db.query_row(
                                            "SELECT status FROM agent_tasks WHERE id=?",
                                            [&task],
                                            |r| r.get::<_, String>(0),
                                        )
                                        .ok()
                                    })
                                    .is_some_and(|s| s == "waiting_user");
                                if eligible {
                                    if let Err(error) =
                                        engine.continue_agent(&json!({"taskId":task}))
                                    {
                                        let _=engine.store.event(&run,json!({"type":"resume_waiting","message":error.to_string()}));
                                    }
                                }
                            });
                        } else {
                            return self.continue_agent(&json!({"taskId":task}));
                        }
                    }
                }
                Ok(result)
            }
            "rename" => {
                let id = required(&request, "id")?;
                let title = required(&request, "title")?
                    .chars()
                    .take(80)
                    .collect::<String>();
                self.store.lock()?.execute(
                    "UPDATE agent_sessions SET title=?,updated_at=? WHERE id=?",
                    params![title, ws::now(), id],
                )?;
                session(&*self.store.lock()?, id)
            }
            "fork" => control::fork(&self.store, &request),
            "search" => control::search_sessions(&self.store, &request),
            "compact" => {
                let task = required(&request, "taskId")?;
                let result = control::compact(&self.store, &request)?;
                if result["resume"] == true {
                    self.continue_agent(&json!({"taskId":task}))?;
                }
                Ok(result)
            }
            "list" => {
                let db = self.store.lock()?;
                let world = required(&request, "worldId")?;
                let line = required(&request, "lineId")?;
                let sessions=ws::rows(&db,"SELECT id,world_id AS worldId,line_id AS lineId,title,created_at AS createdAt,updated_at AS updatedAt FROM agent_sessions WHERE world_id=? AND line_id=? ORDER BY updated_at DESC",&[&world,&line])?;
                Ok(json!({"sessions":sessions}))
            }
            "create" => {
                let db = self.store.lock()?;
                let world = required(&request, "worldId")?;
                let line = required(&request, "lineId")?;
                ws::base(&db, world, line)?;
                let id = ws::id();
                let title = request["title"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or("新的对话");
                let at = ws::now();
                db.execute("INSERT INTO agent_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)",params![id,world,line,title,at,at])?;
                session(&db, &id)
            }
            "session" => {
                let db = self.store.lock()?;
                let id = required(&request, "id")?;
                let s = session(&db, id)?;
                let messages=ws::rows(&db,"SELECT id,role,content,created_at AS createdAt,task_id AS taskId FROM agent_messages WHERE session_id=? ORDER BY rowid",&[&id])?;
                let rows = ws::rows(
                    &db,
                    "SELECT * FROM agent_tasks WHERE session_id=? ORDER BY created_at,rowid",
                    &[&id],
                )?;
                let tasks = rows
                    .iter()
                    .map(|r| task_json(&db, r))
                    .collect::<Result<Vec<_>>>()?;
                let inputs = control::inputs(&db, id, None)?;
                Ok(json!({"session":s,"messages":messages,"tasks":tasks,"inputs":inputs}))
            }
            "start" => self.start_agent(&request),
            "continue" => self.continue_agent(&request),
            "apply" => {
                let task = required(&request, "taskId")?;
                let mut db = self.store.lock()?;
                let tx = db.transaction()?;
                let row = task_row(&tx, task)?;
                if ws::text(&row, "status") != "previewed" {
                    return Err(Error::Invalid("只有尚未采用的有效预览可以采用".into()));
                }
                let run = ws::text(&row, "run_id");
                let plan: RunPlan = serde_json::from_str(&tx.query_row(
                    "SELECT plan_json FROM execution_runs WHERE id=?",
                    [run],
                    |r| r.get::<_, String>(0),
                )?)?;
                if tx.query_row("SELECT 1 FROM execution_runs WHERE world_id=? AND id<>? AND status IN ('running','committing')",params![plan.world_id,run],|_|Ok(())).optional()?.is_some(){return Err(Error::Invalid("这个故事还有任务正在运行".into()));}
                let summary = ws::parse(ws::text(&row, "result_json"))["summary"]
                    .as_str()
                    .unwrap_or("已采用本次修改")
                    .to_owned();
                let draft = tx.query_row(
                    "SELECT draft_json FROM execution_runs WHERE id=?",
                    [run],
                    |r| r.get::<_, String>(0),
                )?;
                let draft=ws::parse(&draft);
                control::guard_commit(&tx, &plan, &draft)?;
                let verification=crate::agent_verification::validate_completion(&plan,&draft,&ws::workspace(&tx,task)?)?;
                let mut result = match ws::apply(&tx, &plan, task, &summary) {
                    Ok(v) => v,
                    Err(Error::Stale) => {
                        tx.execute("UPDATE agent_tasks SET status='stale',error='故事已变化，请继续任务重新核对',updated_at=? WHERE id=?",params![ws::now(),task])?;
                        tx.execute("UPDATE execution_runs SET status='stale' WHERE id=?", [run])?;
                        tx.commit()?;
                        return Err(Error::Stale);
                    }
                    Err(e) => return Err(e),
                };
                result["verification"]=verification;
                tx.execute("UPDATE agent_tasks SET result_json=? WHERE id=?",params![result.to_string(),task])?;
                crate::runtime::write_usage(&tx, run, &plan.world_id, None, "ok")?;
                tx.execute(
                    "UPDATE execution_runs SET status='committed',result_json=? WHERE id=?",
                    params![result.to_string(), run],
                )?;
                tx.commit()?;
                drop(db);
                if result["worldChanged"] == true {
                    (self.committed)(plan.world_id)
                }
                Ok(result)
            }
            "undo" => {
                let task = required(&request, "taskId")?;
                let mut db = self.store.lock()?;
                let tx = db.transaction()?;
                let row = task_row(&tx, task)?;
                let world = ws::parse(ws::text(&row, "backup_json"))["worldId"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                if world.is_empty() {
                    return Err(Error::Invalid("这项历史任务没有可撤回的本机恢复点".into()));
                }
                if tx.query_row("SELECT 1 FROM execution_runs WHERE world_id=? AND status IN ('running','committing')",[&world],|_|Ok(())).optional()?.is_some(){return Err(Error::Invalid("请等待当前任务结束后再撤回".into()));}
                let result = ws::undo(&tx, task)?;
                tx.commit()?;
                drop(db);
                (self.committed)(world);
                Ok(result)
            }
            _ => Err(Error::Invalid("不支持的Agent操作".into())),
        }
    }
    pub(crate) fn start_agent(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let session_id = required(request, "sessionId")?;
        let prompt = required(request, "text")?;
        let policy = request["policy"].as_str().unwrap_or("auto-reversible");
        if !["auto-reversible", "preview", "auto"].contains(&policy) {
            return Err(Error::Invalid("提交方式无效".into()));
        }
        let caps = Limits::read(&request["limits"])?;
        let options = agent_budget::new_options(request)?;
        let mut model: ModelConfig = serde_json::from_value(request["model"].clone())?;
        if model.max_tokens.is_none() {
            model.max_tokens = Some(8192)
        }
        if model.url.trim().is_empty() || model.model.trim().is_empty() {
            return Err(Error::Invalid("请先选择可用的任务模型".into()));
        }
        let continuing = crate::agent_dialogue::resume_candidate(&*self.store.lock()?, request)?;
        if let Some(task) = continuing {
            let mut next = request.clone();
            next["taskId"] = task.into();
            return self.continue_agent(&next);
        }
        let task_id = ws::id();
        let run_id = ws::id();
        let at = ws::now();
        let plan = {
            let mut db = self.store.lock()?;
            let tx = db.transaction()?;
            let s = session(&tx, session_id)?;
            let world = required(&s, "worldId")?;
            let line = required(&s, "lineId")?;
            let base = ws::base(&tx, world, line)?;
            let mut snapshot = request["model"].clone();
            snapshot["contextTokens"] = options["contextTokens"].clone();
            if let Some(o) = snapshot.as_object_mut() {
                for key in ["key", "apiKey", "token", "headers"] {
                    o.remove(key);
                }
            }
            let source: String = tx.query_row(
                "SELECT state_json FROM states WHERE node_id=?",
                [base["headId"].as_str()],
                |r| r.get(0),
            )?;
            let reference_scope = ws::parse(&source)["source"].clone();
            let mut plan = RunPlan {
                id: run_id.clone(),
                world_id: world.into(),
                line_id: line.into(),
                head_id: required(&base, "headId")?.into(),
                base_id: None,
                kind: "agent_task".into(),
                execution_mode: ExecutionMode::Agent,
                model,
                messages: vec![],
                extract_messages: vec![],
                state: json!({}),
                settings: json!({}),
                options,
                action: json!({"text":prompt}),
                meta: json!({"agent":{"taskId":task_id,"sessionId":session_id,"policy":policy,"requiresOriginalEvidence":requires_original(prompt),"skills":request.get("skills").cloned().unwrap_or(json!([])),"customSkills":request.get("customSkills").cloned().unwrap_or(json!([])),"network":request.get("network").cloned().unwrap_or(json!({"mode":"off"})),"limits":caps,"target":request["target"],"modelSnapshot":snapshot,"promptVersion":PROMPT_VERSION,"requiresSkillChecks":true,"readOnly":request["readOnly"]==true,"referenceScope":reference_scope,"queuedInputId":request["queueInputId"],"allowedTools":tools::catalog().iter().map(|t|t.name).collect::<Vec<_>>(),"skillSnapshots":crate::skills::catalog_json().as_array().into_iter().flatten().filter_map(|s|s["name"].as_str()).map(crate::skills::read).collect::<Result<Vec<_>>>()?}}),
                reference: None,
                original: String::new(),
                carried_edits: vec![],
                trailing_ids: vec![],
                new_world: None,
            };
            plan.meta["agent"]["canonVerificationVersion"]=1.into();
            crate::agent_dialogue::prepare(&tx, &mut plan)?;
            // Explicit skill validation happens before persisting a run.
            for skill in plan.meta["agent"]["skills"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let name = skill
                    .as_str()
                    .ok_or_else(|| Error::Invalid("技能标识无效".into()))?;
                if crate::skills::read(name).is_err()
                    && !plan.meta["agent"]["customSkills"]
                        .as_array()
                        .is_some_and(|all| all.iter().any(|s| s["id"] == name || s["name"] == name))
                {
                    return Err(Error::Invalid(format!("找不到已配置技能{name}")));
                }
            }
            Store::register_tx(&tx, &plan)?;
            tx.execute("INSERT INTO agent_tasks(id,session_id,run_id,text,policy,status,base_json,workspace_json,created_at,updated_at) VALUES(?,?,?,?,?,'running',?,'{}',?,?)",params![task_id,session_id,run_id,prompt,policy,base.to_string(),at,at])?;
            control::initialize(&tx, &task_id)?;
            if let Some(input) = request["queueInputId"].as_str() {
                tx.execute("UPDATE agent_inputs SET status='delivered',task_id=?,delivered_at=? WHERE id=? AND delivery='queued' AND status='starting'",params![task_id,at,input])?;
            }
            message(&tx, session_id, &task_id, "user", prompt)?;
            tx.execute("UPDATE agent_sessions SET updated_at=?,title=CASE WHEN title='新的对话' THEN ? ELSE title END WHERE id=?",params![at,prompt.chars().take(24).collect::<String>(),session_id])?;
            tx.commit()?;
            plan
        };
        self.launch(plan, RunBudget::default(), json!({}))?;
        Ok(json!({"taskId":task_id,"runId":run_id}))
    }
    fn continue_agent(self: &Arc<Self>, request: &Value) -> Result<Value> {
        let task = required(request, "taskId")?;
        let (plan, budget, draft) = {
            let mut db = self.store.lock()?;
            let tx = db.transaction()?;
            let row = task_row(&tx, task)?;
            let status = ws::text(&row, "status");
            if ![
                "paused",
                "failed",
                "cancelled",
                "interrupted",
                "stale",
                "previewed",
                "waiting_user",
            ]
            .contains(&status)
            {
                return Err(Error::Invalid(
                    "这项任务不能继续；已完成或导入的历史请发起新任务".into(),
                ));
            }
            let run = required(&row, "run_id")?;
            let (p, b, d): (String, String, String) = tx.query_row(
                "SELECT plan_json,budget_json,draft_json FROM execution_runs WHERE id=?",
                [run],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            let mut plan: RunPlan = serde_json::from_str(&p)?;
            let budget: RunBudget = serde_json::from_str(&b)?;
            let mut draft = ws::parse(&d);
            draft["finishAssessment"] = Value::Null;
            draft["finishSummary"] = Value::Null;
            draft["completionRejections"] = 0.into();
            agent_budget::restore(&mut plan, &draft);
            seal_interrupted_scripts(&tx, &plan, &mut draft)?;
            if tx.query_row("SELECT 1 FROM execution_runs WHERE world_id=? AND id<>? AND status IN ('running','committing')",params![plan.world_id,run],|_|Ok(())).optional()?.is_some(){return Err(Error::Invalid("这个故事还有任务正在运行".into()));}
            if let Some(tokens) = request["inputTokens"].as_u64() {
                agent_budget::set_input(&mut plan, tokens)?;
                plan.meta["agent"]["modelSnapshot"]["contextTokens"] = tokens.into();
            } else if let Some(chars) = request["budgetChars"]
                .as_u64()
                .filter(|_| !agent_budget::token_units(&plan))
            {
                plan.options["budgetChars"] = chars.into();
            }
            let control = control::state(&tx, task)?;
            draft["stopRevision"] = control["stopRevision"].clone();
            draft["loopHistory"] = json!([]);
            draft["loopWarnings"] = 0.into();
            if request.get("limits").is_some() {
                plan.meta["agent"]["limits"] =
                    serde_json::to_value(Limits::read(&request["limits"])?)?;
            }
            let live = ws::base(&tx, &plan.world_id, &plan.line_id)?;
            let old = ws::parse(ws::text(&row, "base_json"));
            let recheck = live["fingerprint"] != old["fingerprint"] || status == "stale";
            if recheck {
                // An expired preview is never silently applied over newer facts.
                // Discard authored draft and make the Agent explicitly reread.
                tx.execute(
                    "UPDATE agent_tasks SET base_json=?,workspace_json='{}' WHERE id=?",
                    params![live.to_string(), task],
                )?;
                plan.head_id = required(&live, "headId")?.into();
                seal_pending(&mut draft);
                draft["finishSummary"] = Value::Null;
                if !draft["messages"].is_array() {
                    draft["messages"] = json!([])
                }
                draft["messages"].as_array_mut().unwrap().push(json!({"role":"user","content":"故事在任务后发生变化，旧草稿已作废。请重新读取当前资料，重新核对并完成原任务。"}));
            }
            if let Some(text) = request["text"].as_str().filter(|s| !s.trim().is_empty()) {
                seal_pending(&mut draft);
                message(&tx, required(&row, "session_id")?, task, "user", text)?;
                if !draft["messages"].is_array() {
                    draft["messages"] = json!([])
                }
                draft["messages"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"role":"user","content":text}));
                draft["finishSummary"] = Value::Null;
                if requires_original(text) {
                    plan.meta["agent"]["requiresOriginalEvidence"] = true.into();
                }
            }
            if status == "previewed" {
                draft["finishSummary"] = Value::Null;
            }
            crate::agent_dialogue::prepare(&tx, &mut plan)?;
            apply_original_directives(&tx,&mut plan)?;
            tx.execute("UPDATE execution_runs SET status='running',error=NULL,plan_json=?,draft_json=?,updated_at=? WHERE id=?",params![serde_json::to_string(&plan)?,draft.to_string(),ws::now(),run])?;
            tx.execute("UPDATE agent_tasks SET status='running',error=NULL,result_json=NULL,updated_at=? WHERE id=?",params![ws::now(),task])?;
            tx.commit()?;
            (plan, budget, draft)
        };
        let run = plan.id.clone();
        self.launch(plan, budget, draft)?;
        Ok(json!({"taskId":task,"runId":run}))
    }
    fn start_next_queued(self: &Arc<Self>, session_id: &str) -> Result<()> {
        let next = {
            let mut db = self.store.lock()?;
            let tx = db.transaction()?;
            let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_tasks WHERE session_id=? AND status IN ('running','waiting_user'))",[session_id],|r|r.get(0))?;
            if active {
                return Ok(());
            }
            if tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_inputs WHERE session_id=? AND delivery='queued' AND status='starting')",[session_id],|r|r.get::<_,bool>(0))?{return Ok(());}
            let row=ws::rows(&tx,"SELECT id,content_json FROM agent_inputs WHERE session_id=? AND delivery='queued' AND status='pending' ORDER BY rowid LIMIT 1",&[&session_id])?.pop();
            let Some(row) = row else { return Ok(()) };
            let payload = ws::parse(ws::text(&row, "content_json"));
            if !payload["request"].is_object() {
                return Ok(());
            }
            let mut request = payload["request"].clone();
            request["sessionId"] = session_id.into();
            request["text"] = payload["text"].clone();
            request["queueInputId"] = row["id"].clone();
            tx.execute(
                "UPDATE agent_inputs SET status='starting' WHERE id=? AND status='pending'",
                [row["id"].as_str()],
            )?;
            tx.commit()?;
            request
        };
        let id = next["queueInputId"].as_str().unwrap_or("");
        match self.start_agent(&next) {
            Ok(start) => {
                self.store.lock()?.execute("UPDATE agent_inputs SET status='delivered',task_id=?,delivered_at=? WHERE id=?",params![start["taskId"].as_str(),ws::now(),id])?;
                Ok(())
            }
            Err(error) => {
                self.store.lock()?.execute(
                    "UPDATE agent_inputs SET status='pending' WHERE id=? AND status='starting'",
                    [id],
                )?;
                Err(error)
            }
        }
    }
    fn consume_inputs(&self, shared: &Shared) -> Result<bool> {
        let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
        let mut db = self.store.lock()?;
        let tx = db.transaction()?;
        let plan = c.plan.clone();
        let has_input=tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_inputs WHERE task_id=? AND status='pending' AND delivery IN ('steer','answer','compact'))",[plan.meta["agent"]["taskId"].as_str()],|r|r.get::<_,bool>(0))?;
        if has_input {
            seal_pending(&mut c.draft);
        }
        let changed = control::consume(&tx, &plan, &mut c.draft)?;
        if changed {
            apply_original_directives(&tx,&mut c.plan)?;
            tx.execute("UPDATE execution_runs SET plan_json=? WHERE id=?",params![serde_json::to_string(&c.plan)?,c.plan.id])?;
            c.draft["loopHistory"] = json!([]);
            c.draft["loopWarnings"] = 0.into();
            c.draft["loopHint"] = Value::Null;
            let task = required(&plan.meta["agent"], "taskId")?;
            tx.execute("UPDATE agent_subtasks SET status='stale',updated_at=? WHERE task_id=? AND status IN ('pending','running')",params![ws::now(),task])?;
            c.draft["intentRevision"] = control::state(&tx, task)?["intentRevision"].clone();
        }
        tx.commit()?;
        drop(db);
        drop(c);
        if changed {
            self.checkpoint(shared)?;
        }
        Ok(changed)
    }
    async fn ensure_selected_skill(
        self: &Arc<Self>,
        shared: &Shared,
        mcp: &Arc<BuiltinMcp>,
    ) -> Result<()> {
        let (name, iteration) = {
            let c = shared.lock().map_err(|_| Error::Cancelled)?;
            let name = c.plan.meta["agent"]["skills"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|s| {
                    !c.draft["skillsRead"]
                        .as_array()
                        .is_some_and(|a| a.contains(s))
                        && !c.draft["skillsFetched"]
                            .as_array()
                            .is_some_and(|a| a.contains(s))
                })
                .and_then(Value::as_str)
                .map(str::to_owned);
            (name, c.draft["iteration"].as_u64().unwrap_or(0))
        };
        let Some(name) = name else { return Ok(()) };
        let id = format!("requested-skill-{name}-{iteration}");
        let call = json!({"id":id,"type":"function","function":{"name":"read_skill","arguments":json!({"id":name}).to_string()}});
        {
            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
            let present = c.draft["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|m| {
                    m["tool_calls"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|v| v["id"] == call["id"]))
                });
            if present {
                return Ok(());
            }
            c.draft["messages"]
                .as_array_mut()
                .unwrap()
                .push(json!({"role":"assistant","content":null,"tool_calls":[call.clone()]}));
        }
        self.agent_tool(shared, mcp, &call).await
    }
    pub(crate) async fn execute_agent(self: &Arc<Self>, shared: Shared) -> Result<()> {
        let plan = {
            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
            let draft = c.draft.clone();
            agent_budget::restore(&mut c.plan, &draft);
            c.plan.clone()
        };
        let mcp = Arc::new(
            BuiltinMcp::open_with(
                tools::dispatch(self.clone(), shared.clone()),
                tools::task_catalog(&plan),
            )
            .await?,
        );
        let definitions = mcp.tools().await?;
        {
            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
            if !c.draft["messages"].is_array() {
                let db = self.store.lock()?;
                let session_id = required(&plan.meta["agent"], "sessionId")?;
                let previous=ws::rows(&db,"SELECT role,content,task_id FROM agent_messages WHERE session_id=? AND role IN ('user','assistant') ORDER BY rowid DESC LIMIT 200",&[&session_id])?;
                let task_id = ws::text(&plan.meta["agent"], "taskId");
                let mut history = vec![];
                let mut current = vec![];
                for message in previous.into_iter().rev() {
                    if message["task_id"] == task_id {
                        current.push(json!({"role":message["role"],"content":message["content"]}));
                    } else {
                        history.push(json!({"role":message["role"],"content":message["content"]}));
                    }
                }
                let mut messages = vec![];
                if !history.is_empty() {
                    messages.push(json!({"role":"user","content":format!("【此前助手会话，仅供理解要求，不是当前世界事实，也不是本轮模型协议续接记录】{}",json!(history))}));
                }
                messages.extend(current);
                c.draft["messages"] = json!(messages);
                c.draft["pending"] = json!([]);
                c.draft["toolIndex"] = 0.into();
                c.draft["iteration"] = 0.into();
            }
        }
        {
            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
            let control = control::state(
                &*self.store.lock()?,
                ws::text(&plan.meta["agent"], "taskId"),
            )?;
            if c.draft["stopRevision"].is_null() {
                c.draft["stopRevision"] = control["stopRevision"].clone();
            }
            if c.draft["intentRevision"].is_null() {
                c.draft["intentRevision"] = 0.into();
            }
        }
        self.checkpoint(&shared)?;
        loop {
            self.check(&shared)?;
            self.consume_inputs(&shared)?;
            let (pending, index) = {
                let c = shared.lock().map_err(|_| Error::Cancelled)?;
                (
                    c.draft["pending"].as_array().cloned().unwrap_or_default(),
                    c.draft["toolIndex"].as_u64().unwrap_or(0) as usize,
                )
            };
            let mut cursor = index;
            while cursor < pending.len() {
                if self.consume_inputs(&shared)? {
                    break;
                }
                let call = &pending[cursor];
                let read =
                    crate::agent_policy::metadata(call["function"]["name"].as_str().unwrap_or(""))
                        ["parallel"]
                        == true;
                let end = if read {
                    pending
                        .iter()
                        .enumerate()
                        .skip(cursor)
                        .take_while(|(_, c)| {
                            crate::agent_policy::metadata(
                                c["function"]["name"].as_str().unwrap_or(""),
                            )["parallel"]
                                == true
                        })
                        .take(4)
                        .last()
                        .map(|(i, _)| i + 1)
                        .unwrap_or(cursor + 1)
                } else {
                    cursor + 1
                };
                let mut handles = vec![];
                for call in pending[cursor..end].iter().cloned() {
                    let engine = self.clone();
                    let shared = shared.clone();
                    let mcp = mcp.clone();
                    handles.push(tokio::spawn(async move {
                        engine.agent_tool(&shared, &mcp, &call).await
                    }));
                }
                for handle in handles {
                    handle
                        .await
                        .map_err(|_| Error::Invalid("工具任务意外中断".into()))??;
                }
                cursor = end;
                shared.lock().map_err(|_| Error::Cancelled)?.draft["toolIndex"] = json!(cursor);
                self.checkpoint(&shared)?;
            }
            self.consume_inputs(&shared)?;
            let question = control::state(
                &*self.store.lock()?,
                required(&plan.meta["agent"], "taskId")?,
            )?["question"]
                .clone();
            if !question.is_null() {
                self.checkpoint(&shared)?;
                self.store.lock()?.execute(
                    "UPDATE agent_tasks SET status='waiting_user',error=NULL WHERE id=?",
                    [plan.meta["agent"]["taskId"].as_str()],
                )?;
                self.store.finish(&plan.id, "waiting_user", None)?;
                self.store
                    .event(&plan.id, json!({"type":"waiting_user","question":question}))?;
                return Ok(());
            }
            let final_summary = shared.lock().map_err(|_| Error::Cancelled)?.draft["finishSummary"]
                .as_str()
                .map(str::to_owned);
            if shared.lock().map_err(|_| Error::Cancelled)?.draft["completionRejections"].as_u64().unwrap_or(0)>=3 {
                return Err(Error::Invalid("助手连续声明完成，却未满足查证或实际修改条件；已保存进度，未采用半批草稿".into()));
            }
            if let Some(summary) = final_summary {
                match self.assess_agent_completion(&shared, &json!({"summary":summary})) {
                    Ok(_) => {
                        self.finish_agent(&shared, &summary)?;
                        break;
                    }
                    Err(error) => {
                        let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                        c.draft["finishSummary"] = Value::Null;
                        c.draft["loopHint"] = error.to_string().into();
                        if c.draft["completionRejections"].as_u64().unwrap_or(0) >= 3 {
                            return Err(Error::Invalid(format!(
                                "助手仍未满足完成条件，未采用修改：{error}"
                            )));
                        }
                        c.draft["messages"].as_array_mut().unwrap().push(json!({"role":"user","content":format!("【程序执行校验反馈，不是新的玩家授权】{error}。请处理未完成项；原始要求与权限保持不变。"),"_origin":"execution_feedback"}));
                    }
                }
            }
            self.ensure_selected_skill(&shared, &mcp).await?;
            let mut reply = self.agent_complete(&shared, &definitions).await?;
            let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
            for call in &mut reply.tool_calls {
                call["id"] = json!(format!(
                    "agent-{}-{}",
                    c.draft["iteration"].as_u64().unwrap_or(0),
                    call["id"].as_str().unwrap_or("call")
                ));
            }
            c.draft["iteration"] = json!(c.draft["iteration"].as_u64().unwrap_or(0) + 1);
            if reply.tool_calls.is_empty() {
                c.draft["messages"]
                    .as_array_mut()
                    .unwrap()
                    .push(chat::assistant_message(&reply));
                c.draft["finishSummary"] = json!(reply.text);
            } else {
                c.draft["messages"]
                    .as_array_mut()
                    .unwrap()
                    .push(chat::assistant_message(&reply));
                c.draft["pending"] = json!(reply.tool_calls);
                c.draft["toolIndex"] = 0.into();
            }
            drop(c);
            self.checkpoint(&shared)?;
        }
        if let Ok(mcp) = Arc::try_unwrap(mcp) {
            mcp.close().await?;
        }
        if let Err(error) = self.start_next_queued(required(&plan.meta["agent"], "sessionId")?) {
            self.store.event(
                &plan.id,
                json!({"type":"queue_waiting","message":error.to_string()}),
            )?;
        }
        Ok(())
    }
    async fn agent_complete(
        self: &Arc<Self>,
        shared: &Shared,
        definitions: &[Value],
    ) -> Result<Completion> {
        self.check(shared)?;
        let (plan, iteration) = {
            let c = shared.lock().map_err(|_| Error::Cancelled)?;
            (c.plan.clone(), c.draft["iteration"].as_u64().unwrap_or(0))
        };
        let purpose = format!("agent:model:{iteration}");
        let cached:Option<(String,String,String)>=self.store.lock()?.query_row("SELECT step_key,input_json,output_json FROM execution_steps WHERE run_id=? AND kind=? AND status='done' ORDER BY rowid DESC LIMIT 1",params![plan.id,purpose],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((step_key, input, cached)) = cached {
            let input = ws::parse(&input);
            note_delivered(
                shared,
                input["request"]["messages"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            )?;
            let reply = serde_json::from_str(&cached)?;
            observe_model_budget(self, shared, &step_key, &input["request"], &reply)?;
            validate_completion(&reply)?;
            return Ok(reply);
        }
        let (messages, definitions) =
            crate::agent_context::assemble(self, shared, definitions).await?;
        let body = chat::request(&plan.model, &messages, &definitions, false);
        let attempt = reserve_model(self, shared)?;
        let (key, cancel) = {
            let c = shared.lock().map_err(|_| Error::Cancelled)?;
            (format!("model:{attempt}"), c.cancel.clone())
        };
        self.store.lock()?.execute("INSERT INTO execution_steps(run_id,step_key,kind,status,input_json) VALUES(?,?,?,'running',?)",params![plan.id,key,purpose,json!({"model":plan.model.model,"purpose":"agent","request":body}).to_string()])?;
        self.store.event(&plan.id, json!({"type":"thinking"}))?;
        let store = self.store.clone();
        let run = plan.id.clone();
        let sink: TextSink = Arc::new(move |text| {
            let _ = store.event(&run, json!({"type":"text","delta":text}));
        });
        let permit = self
            .agent_model_slots
            .acquire()
            .await
            .map_err(|_| Error::Cancelled)?;
        let result = self
            .model
            .complete(plan.model.clone(), body.clone(), cancel.child_token(), sink)
            .await;
        drop(permit);
        self.checkpoint(shared)?;
        match result {
            Ok(reply) => {
                note_delivered(shared, &messages)?;
                observe_model_budget(self, shared, &key, &body, &reply)?;
                if let Err(error) = validate_completion(&reply) {
                    let mut recorded = serde_json::to_value(&reply)?;
                    recorded["error"] = error.to_string().into();
                    self.store.lock()?.execute("UPDATE execution_steps SET status='failed',output_json=? WHERE run_id=? AND step_key=?",params![recorded.to_string(),plan.id,key])?;
                    return Err(error);
                }
                self.store.lock()?.execute("UPDATE execution_steps SET status='done',output_json=? WHERE run_id=? AND step_key=?",params![serde_json::to_string(&reply)?,plan.id,key])?;
                Ok(reply)
            }
            Err(error) => {
                self.store.lock()?.execute("UPDATE execution_steps SET status='failed',output_json=? WHERE run_id=? AND step_key=?",params![json!({"error":error.to_string()}).to_string(),plan.id,key])?;
                Err(error)
            }
        }
    }
    async fn agent_tool(
        self: &Arc<Self>,
        shared: &Shared,
        mcp: &Arc<BuiltinMcp>,
        call: &Value,
    ) -> Result<()> {
        let call_id = required(call, "id")?;
        let name = required(&call["function"], "name")?;
        let args: Value =
            serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))?;
        let result = self
            .invoke_via(shared, name, args, call_id, Some(mcp.clone()), false)
            .await?;
        let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
        if !c.draft["messages"].is_array() {
            c.draft["messages"] = json!([]);
        }
        let delivered = fit_result(&c.plan, name, call_id, &result);
        if !c.draft["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool" && m["tool_call_id"] == call_id)
        {
            c.draft["messages"].as_array_mut().unwrap().push(
                json!({"role":"tool","tool_call_id":call_id,"content":delivered.to_string()}),
            );
        }
        drop(c);
        self.checkpoint(shared)?;
        Ok(())
    }
    /// All model, script and child-agent calls use the same durable gateway.
    pub(crate) fn invoke_tool(
        self: &Arc<Self>,
        shared: &Shared,
        name: &str,
        args: Value,
        call_id: &str,
    ) -> chat::BoxFuture<Result<Value>> {
        let engine = self.clone();
        let shared = shared.clone();
        let name = name.to_owned();
        let id = call_id.to_owned();
        Box::pin(async move {
            engine
                .invoke_via(&shared, &name, args, &id, None, false)
                .await
        })
    }
    pub(crate) fn invoke_readonly(
        self: &Arc<Self>,
        shared: &Shared,
        name: &str,
        args: Value,
        call_id: &str,
    ) -> chat::BoxFuture<Result<Value>> {
        let engine = self.clone();
        let shared = shared.clone();
        let name = name.to_owned();
        let id = call_id.to_owned();
        Box::pin(async move {
            engine
                .invoke_via(&shared, &name, args, &id, None, true)
                .await
        })
    }
    fn invoke_via(
        self: &Arc<Self>,
        shared: &Shared,
        name: &str,
        args: Value,
        call_id: &str,
        mcp: Option<Arc<BuiltinMcp>>,
        child_scope: bool,
    ) -> chat::BoxFuture<Result<Value>> {
        let engine = self.clone();
        let shared = shared.clone();
        let name = name.to_owned();
        let call_id = call_id.to_owned();
        Box::pin(async move {
            engine.check(&shared)?;
            let mut plan = shared.lock().map_err(|_| Error::Cancelled)?.plan.clone();
            if child_scope {
                plan.meta["agent"]["subtaskReadOnly"] = true.into();
            }
            let key = format!("agenttool:{call_id}");
            let prior: Option<(String, Option<String>)> = engine
                .store
                .lock()?
                .query_row(
                    "SELECT status,output_json FROM execution_steps WHERE run_id=? AND step_key=?",
                    params![plan.id, key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((_, Some(cached))) = prior.as_ref().filter(|(s, _)| s == "done") {
                return Ok(ws::parse(cached));
            }
            let permission = if !tools::allowed(&plan, &name) {
                Err(Error::Invalid(
                    "此任务沿用创建时的能力范围，新增执行能力请发起新任务".into(),
                ))
            } else if child_scope
                && matches!(
                    name.as_str(),
                    "update_plan"
                        | "ask_user"
                        | "record_skill_check"
                        | "draft_skill"
                        | "run_script"
                        | "delegate_readonly"
                        | "finish_task"
                )
            {
                Err(Error::Invalid("只读子任务不能管理主任务或修改资料".into()))
            } else {
                crate::agent_policy::check(&plan, &name, &args)
            };
            let validation = crate::tools::validate_with(&tools::catalog(), &name, &args);
            let permitted = permission.is_ok() && validation.is_ok();
            let read_only = crate::agent_policy::read_only(&name);
            let _read = if read_only {
                Some(
                    engine
                        .agent_read_slots
                        .acquire()
                        .await
                        .map_err(|_| Error::Cancelled)?,
                )
            } else {
                None
            };
            let _write = if !read_only && name != "run_script" && name != "delegate_readonly" {
                Some(engine.agent_write_lock.lock().await)
            } else {
                None
            };
            engine.check(&shared)?;
            let external_write = crate::agent_policy::is_external_write(&plan, &name, &args);
            let canonical = canonical_json(&args).to_string();
            let uncertain=external_write&&(prior.as_ref().is_some_and(|(s,_)|s!="done")||engine.store.lock()?.query_row("SELECT 1 FROM execution_steps e JOIN execution_runs r ON r.id=e.run_id WHERE r.world_id=? AND e.kind=? AND json_extract(e.input_json,'$._canonical')=? AND (e.status='running' OR json_extract(e.output_json,'$.outcomeUnknown')=1) LIMIT 1",params![plan.world_id,name,canonical],|_|Ok(())).optional()?.is_some());
            {
                let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                if limits(&c.plan).tools_exhausted(c.budget.tool_calls) {
                    return Err(Error::Limit("本次工具调用额度已用完"));
                }
                c.budget.tool_calls = c
                    .budget
                    .tool_calls
                    .checked_add(1)
                    .ok_or(Error::Limit("累计工具次数超过可记录范围"))?;
                if !read_only {
                    c.draft["callingId"] = call_id.clone().into();
                }
            }
            engine.checkpoint(&shared)?;
            let mut stored_args = args.clone();
            stored_args["_canonical"] = canonical.into();
            engine.store.lock()?.execute("INSERT INTO execution_steps(run_id,step_key,kind,status,input_json) VALUES(?,?,?,'running',?) ON CONFLICT(run_id,step_key) DO UPDATE SET status='running'",params![plan.id,key,name,stored_args.to_string()])?;
            let parent = call_id.rsplit_once('/').map(|(p, _)| p.to_owned());
            engine.store.event(&plan.id,json!({"type":"tool","callId":call_id,"parentCallId":parent,"name":name,"status":"running"}))?;
            let mut result = if let Err(error) = permission.and(validation) {
                json!({"isError":true,"message":error.to_string()})
            } else if uncertain {
                json!({"isError":true,"outcomeUnknown":true,"message":"远端操作可能已执行，结果未知。不会自动重复写入；请先只读核对，需要重试时由玩家明确要求。"})
            } else if child_scope && name == "discover_tools" {
                let names = args["names"].as_array().cloned().unwrap_or_default();
                let allowed = crate::agent_subtasks::allowed_tools();
                if names
                    .iter()
                    .any(|n| !n.as_str().is_some_and(|n| allowed.contains(&n)))
                {
                    json!({"isError":true,"message":"只读子任务只能加载查证资料工具"})
                } else {
                    crate::agent_subtasks::discovery(&plan, &names)
                }
            } else {
                let session = match mcp {
                    Some(m) => m,
                    None => Arc::new(
                        BuiltinMcp::open_with(
                            tools::dispatch(engine.clone(), shared.clone()),
                            tools::catalog(),
                        )
                        .await?,
                    ),
                };
                let cancel = shared.lock().map_err(|_| Error::Cancelled)?.cancel.clone();
                let outcome = tokio::select! {biased;_=cancel.cancelled()=>Err(Error::Cancelled),r=session.call(&name,&args)=>r};
                match outcome {
                    Ok(v) => v,
                    Err(Error::Cancelled) => return Err(Error::Cancelled),
                    Err(e) => {
                        json!({"isError":true,"message":e.to_string(),"outcomeUnknown":external_write})
                    }
                }
            };
            if let Some(o) = result.as_object_mut() {
                o.insert("_agentTool".into(), json!(name));
                o.insert("callId".into(), json!(call_id));
                if external_write && permitted && o.get("isError") == Some(&Value::Bool(true)) {
                    o.insert("outcomeUnknown".into(), true.into());
                }
            }
            engine.store.lock()?.execute("UPDATE execution_steps SET status='done',output_json=? WHERE run_id=? AND step_key=?",params![result.to_string(),plan.id,key])?;
            engine.store.event(&plan.id,json!({"type":"tool","callId":call_id,"parentCallId":parent,"name":name,"status":if result["isError"]==true{"failed"}else{"done"},"label":result["summary"].as_str().or_else(||result["message"].as_str()).unwrap_or("完成"),"result":result}))?;
            {
                let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
                if name == "read_skill" && result["isError"] != true {
                    if !c.draft["skillsFetched"].is_array() {
                        c.draft["skillsFetched"] = json!([]);
                    }
                    if !c.draft["skillsFetched"]
                        .as_array()
                        .unwrap()
                        .contains(&result["requestedId"])
                    {
                        c.draft["skillsFetched"]
                            .as_array_mut()
                            .unwrap()
                            .push(result["requestedId"].clone());
                    }
                }
                if [
                    "read_resource",
                    "read_world",
                    "read_original",
                    "search_original",
                ]
                .contains(&name.as_str())
                    && result["isError"] != true
                {
                    if !c.draft["recentResources"].is_array() {
                        c.draft["recentResources"] = json!([]);
                    }
                    let seen = c.draft["recentResources"].as_array_mut().unwrap();
                    seen.push(json!({"tool":name,"args":args,"callId":call_id}));
                    if seen.len() > 20 {
                        seen.remove(0);
                    }
                }
                // Compare only periods with no intervening workspace change.
                let workspace = ws::workspace(
                    &*engine.store.lock()?,
                    ws::text(&plan.meta["agent"], "taskId"),
                )?;
                let signature = format!(
                    "{}:{}:{}",
                    name,
                    canonical_json(&args),
                    hash_value(&workspace)
                );
                if !child_scope {
                    if !c.draft["loopHistory"].is_array() {
                        c.draft["loopHistory"] = json!([]);
                    }
                    let history = c.draft["loopHistory"].as_array_mut().unwrap();
                    history.push(signature.into());
                    if history.len() > 24 {
                        history.remove(0);
                    }
                    let mut looping = false;
                    for period in 1..=4 {
                        let n = history.len();
                        if n >= period * 3
                            && history[n - period..] == history[n - period * 2..n - period]
                            && history[n - period..] == history[n - period * 3..n - period * 2]
                        {
                            looping = true;
                            break;
                        }
                    }
                    if looping {
                        let warnings = c.draft["loopWarnings"].as_u64().unwrap_or(0) + 1;
                        c.draft["loopWarnings"] = warnings.into();
                        if warnings >= 2 {
                            return Err(Error::Limit(
                                "重复读取没有产生新进展，请补充要求或继续时改变查证方法",
                            ));
                        }
                        c.draft["loopHint"]="检测到重复调用而没有新进展。请改变查询方式，或完成已经确认的部分。已有结果按callId读取，不重复列目录/读取同一技能。".into();
                    }
                }
            }
            engine.checkpoint(&shared)?;
            Ok(result)
        })
    }
    pub(crate) fn assess_agent_completion(&self, shared: &Shared, args: &Value) -> Result<Value> {
        let (plan, draft) = {
            let c = shared.lock().map_err(|_| Error::Cancelled)?;
            (c.plan.clone(), c.draft.clone())
        };
        let result=verify_skills(shared).and_then(|_|{
            let db=self.store.lock()?;
            let mut result=crate::agent_dialogue::assessment(&db,&plan,&draft,args)?;
            if result["outcome"]!="blocked" {
                result["verification"]=crate::agent_verification::validate_completion(&plan,&draft,&ws::workspace(&db,required(&plan.meta["agent"],"taskId")?)?)?;
            }
            Ok(result)
        });
        let mut c=shared.lock().map_err(|_|Error::Cancelled)?;
        match result {
            Ok(result)=>{c.draft["finishAssessment"]=result.clone();c.draft["completionRejections"]=0.into();Ok(result)},
            Err(error)=>{c.draft["completionRejections"]=(c.draft["completionRejections"].as_u64().unwrap_or(0)+1).into();Err(error)}
        }
    }
    fn finish_agent(&self, shared: &Shared, summary: &str) -> Result<()> {
        self.check(shared)?;
        self.checkpoint(shared)?;
        let (plan, current_draft) = {
            let c = shared.lock().map_err(|_| Error::Cancelled)?;
            (c.plan.clone(), c.draft.clone())
        };
        let task = required(&plan.meta["agent"], "taskId")?;
        let sid = required(&plan.meta["agent"], "sessionId")?;
        let assessment = &current_draft["finishAssessment"];
        let summary = format!("{}{}",assessment["summary"].as_str().unwrap_or(summary),verification_sources(&assessment["verification"]));
        let summary = summary.as_str();
        let blocked = assessment["outcome"] == "blocked";
        let (result, status) = {
            let mut db = self.store.lock()?;
            let tx = db.transaction()?;
            let row = task_row(&tx, task)?;
            if ws::text(&row, "status") == "committed" {
                return Ok(());
            }
            control::guard_commit(&tx, &plan, &current_draft)?;
            let w = ws::workspace(&tx, task)?;
            let changes = ws::changes(&w);
            if !blocked {crate::agent_verification::validate_completion(&plan,&current_draft,&w)?;}
            if !blocked && !changes.is_empty() {
                ws::validate(&tx, &plan, task)?;
            }
            let (mut result, status) = if blocked {
                let result = json!({"summary":summary,"outcome":"blocked","reason":assessment["reason"],"worldChanged":false,"changes":[],"draftRetained":!changes.is_empty()});
                tx.execute("UPDATE agent_tasks SET status='failed',result_json=?,error=?,updated_at=? WHERE id=?",params![result.to_string(),assessment["reason"].as_str(),ws::now(),task])?;
                (result, "failed")
            } else if plan.meta["agent"]["policy"] == "preview" && !changes.is_empty() {
                let details = ws::preview_changes(&w);
                let result = json!({"summary":summary,"changes":changes,"preview":{"summary":summary,"changes":details},"worldChanged":false});
                tx.execute("UPDATE agent_tasks SET status='previewed',result_json=?,updated_at=? WHERE id=?",params![result.to_string(),ws::now(),task])?;
                (result, "previewed")
            } else {
                (ws::apply(&tx, &plan, task, summary)?, "committed")
            };
            result["outcome"] = assessment["outcome"].clone();
            result["verification"] = assessment["verification"].clone();
            tx.execute(
                "UPDATE agent_tasks SET result_json=? WHERE id=?",
                params![result.to_string(), task],
            )?;
            message(&tx, sid, task, "assistant", summary)?;
            tx.execute(
                "UPDATE agent_sessions SET updated_at=? WHERE id=?",
                params![ws::now(), sid],
            )?;
            crate::runtime::write_usage(
                &tx,
                &plan.id,
                &plan.world_id,
                None,
                if blocked { "blocked" } else { "ok" },
            )?;
            tx.execute(
                "UPDATE execution_runs SET status=?,result_json=?,error=?,updated_at=? WHERE id=?",
                params![
                    status,
                    result.to_string(),
                    if blocked {
                        assessment["reason"].as_str()
                    } else {
                        None
                    },
                    ws::now(),
                    plan.id
                ],
            )?;
            tx.commit()?;
            (result, status)
        };
        let _ = status;
        self.store
            .event(&plan.id, json!({"type":"done","result":result}))?;
        if result["worldChanged"] == true {
            (self.committed)(plan.world_id)
        }
        Ok(())
    }
}
pub(crate) fn validate_completion(reply: &Completion) -> Result<()> {
    if !reply.tool_calls.is_empty() && reply.finish_reason.as_deref() == Some("length") {
        return Err(Error::Invalid(
            "模型工具参数被截断，本批工具均未执行；请调整输出上限后继续".into(),
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for call in &reply.tool_calls {
        let id = call["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error::Invalid("模型工具调用缺少标识，本批未执行".into()))?;
        if !ids.insert(id) {
            return Err(Error::Invalid("模型工具调用标识重复，本批未执行".into()));
        }
        if call["function"]["name"].as_str().unwrap_or("").is_empty() {
            return Err(Error::Invalid("模型工具调用缺少名称，本批未执行".into()));
        }
        let args = call["function"]["arguments"]
            .as_str()
            .ok_or_else(|| Error::Invalid("模型工具参数不完整，本批未执行".into()))?;
        if !serde_json::from_str::<Value>(args).is_ok_and(|v| v.is_object()) {
            return Err(Error::Invalid(
                "模型工具参数不是完整对象，本批未执行".into(),
            ));
        }
    }
    Ok(())
}
pub(crate) fn reserve_model(engine: &Engine, shared: &Shared) -> Result<u32> {
    engine.check(shared)?;
    let count = {
        let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
        if limits(&c.plan).model_exhausted(c.budget.model_requests) {
            return Err(Error::Limit("本次模型请求额度已用完"));
        }
        c.budget.model_requests = c
            .budget
            .model_requests
            .checked_add(1)
            .ok_or(Error::Limit("累计模型次数超过可记录范围"))?;
        c.budget.model_requests
    };
    engine.checkpoint(shared)?;
    Ok(count)
}
pub(crate) fn observe_model_budget(
    engine: &Arc<Engine>,
    shared: &Shared,
    step_key: &str,
    request: &Value,
    reply: &Completion,
) -> Result<()> {
    {
        let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
        let estimate = agent_budget::observe(&c.draft["tokenEstimate"], step_key, request, reply);
        c.draft["tokenEstimate"] = estimate.clone();
        c.plan.options["tokenEstimate"] = estimate;
    }
    engine.checkpoint(shared)
}
pub(crate) fn verify_skills(shared: &Shared) -> Result<()> {
    let c = shared.lock().map_err(|_| Error::Cancelled)?;
    for requested in c.plan.meta["agent"]["skills"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if !c.draft["skillsRead"]
            .as_array()
            .is_some_and(|s| s.contains(requested))
        {
            return Err(Error::Invalid("指定的技能还没有实际读取".into()));
        }
        if c.plan.meta["agent"]["requiresSkillChecks"] == true
            && !c.draft["skillChecks"].as_array().is_some_and(|checks| {
                checks.iter().any(|check| {
                    check["id"] == *requested
                        && ["completed", "insufficient", "not_applicable"]
                            .contains(&check["status"].as_str().unwrap_or(""))
                        && check["summary"]
                            .as_str()
                            .is_some_and(|s| !s.trim().is_empty())
                })
            })
        {
            return Err(Error::Invalid(format!(
                "指定技能{}已读取，但还没有实际检查结果；请用discover_tools加载record_skill_check，逐项登记completed/insufficient/not_applicable及依据，不能仅阅读说明就结束。",
                requested.as_str().unwrap_or("")
            )));
        }
    }
    let not_applicable=c.draft["skillChecks"].as_array().is_some_and(|checks|checks.iter().any(|r|r["id"]=="canon-reference"&&r["status"]=="not_applicable"));
    let canon = c.plan.meta["agent"]["requiresOriginalEvidence"] == true
        || (c.plan.meta["agent"]["skills"]
            .as_array()
            .is_some_and(|s| s.iter().any(|v| v == "canon-reference"))
        || c.draft["skillsRead"]
            .as_array()
            .is_some_and(|s| s.iter().any(|v| v == "canon-reference"))) && !not_applicable;
    if canon
        && !c.draft["skillsRead"]
            .as_array()
            .is_some_and(|s| s.iter().any(|v| v == "canon-reference"))
    {
        return Err(Error::Invalid(
            "本次明确要求参考原著，请先read_skill读取遵循原著，再核对原文或说明资料不足".into(),
        ));
    }
    if canon && c.draft["sourceRead"] != true && c.draft["sourceInsufficient"] != true {
        return Err(Error::Invalid(
            "遵循原著还没有读取原文；请先查证或明确取得资料不足的结果".into(),
        ));
    }
    Ok(())
}
pub(crate) fn requires_original(text: &str) -> bool {
    original_directive(text)==Some(true)
}
pub(crate) fn original_directive(text:&str)->Option<bool>{
    let lower = text.to_lowercase();
    let negative=["不要参考原著","不用参考原著","不参考原著","不要按原著","不按原著","无需查原著","不要对照原著","不遵循原著"].iter().filter_map(|p|text.rfind(p).map(|at|at+p.len())).max();
    let relevant=negative.map(|end|&text[end..]).unwrap_or(text);
    let positive=(["原著", "原文", "参考书"].iter().any(|s| relevant.contains(s))
        && ["参考", "遵循", "核对", "纠错", "按照", "根据", "查证","按原著","对照","参照","依据","修正","改写","纠正"]
            .iter()
            .any(|s| relevant.contains(s)))
        || lower.contains("follow canon")
        || lower.contains("check canon");
    if positive{Some(true)}else if negative.is_some(){Some(false)}else{None}
}
fn apply_original_directives(db:&rusqlite::Connection,plan:&mut RunPlan)->Result<()> {
    for row in ws::rows(db,"SELECT content FROM agent_messages WHERE task_id=? AND role='user' ORDER BY rowid",&[&required(&plan.meta["agent"],"taskId")?])? {
        if let Some(required)=original_directive(ws::text(&row,"content")){plan.meta["agent"]["requiresOriginalEvidence"]=required.into();}
    }
    Ok(())
}
fn verification_sources(verification:&Value)->String {
    if verification["required"]!=true {return String::new();}
    let mut lines=vec![];
    for finding in verification["findings"].as_array().into_iter().flatten().take(12) {
        let topic=finding["topic"].as_str().unwrap_or("核对项");
        let titles=finding["citations"].as_array().into_iter().flatten().filter_map(|c|c["title"].as_str()).collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>().join("、");
        let source=match finding["basis"].as_str().unwrap_or("") {
            "original"=>if titles.is_empty(){"已读取的原文片段（未提供章名）".to_owned()}else{titles},
            "player_choice"=>"玩家原始行动或幕后要求".to_owned(),
            "local_consistency"=>"本局资料一致性，尚非原著核实".to_owned(),
            _=>"资料不足".to_owned()
        };
        lines.push(format!("{topic}：{source}"));
    }
    if lines.is_empty(){return "\n\n原著资料不足，以上仅为当前查阅结果。".into();}
    format!("\n\n核对出处：\n{}\n出处由实际资料定位，结论仍须结合本局判断。",lines.join("\n"))
}
fn seal_pending(draft: &mut Value) {
    let pending = draft["pending"].as_array().cloned().unwrap_or_default();
    if !draft["messages"].is_array() {
        draft["messages"] = json!([])
    }
    for call in pending {
        let id = call["id"].clone();
        if !draft["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool" && m["tool_call_id"] == id)
        {
            draft["messages"].as_array_mut().unwrap().push(json!({"role":"tool","tool_call_id":id,"content":json!({"isError":true,"message":"玩家补充了新要求，未确认的旧工具结果不自动重放；请读取当前草稿和资料重新核对。"}).to_string()}));
        }
    }
    draft["pending"] = json!([]);
    draft["toolIndex"] = 0.into();
}
fn seal_interrupted_scripts(
    db: &rusqlite::Connection,
    plan: &RunPlan,
    draft: &mut Value,
) -> Result<()> {
    let pending = draft["pending"].as_array().cloned().unwrap_or_default();
    let mut interrupted = serde_json::Map::new();
    for call in pending
        .iter()
        .filter(|c| c["function"]["name"] == "run_script")
    {
        let id = call["id"].as_str().unwrap_or("");
        let key = format!("agenttool:{id}");
        if !db
            .query_row(
                "SELECT 1 FROM execution_steps WHERE run_id=? AND step_key=? AND status='running'",
                params![plan.id, key],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            continue;
        }
        let prefix = format!("{key}:host:");
        let steps=ws::rows(db,"SELECT substr(step_key,11) AS callId,kind,status FROM execution_steps WHERE run_id=? AND substr(step_key,1,length(?))=? ORDER BY rowid",&[&plan.id,&prefix,&prefix])?;
        let result = json!({"_agentTool":"run_script","callId":id,"isError":true,"interruptedScript":true,"replayBlocked":true,"completedSteps":steps.iter().filter(|s|s["status"]=="done").collect::<Vec<_>>(),"unfinishedSteps":steps.iter().filter(|s|s["status"]!="done").collect::<Vec<_>>(),"draftAvailable":true,"message":"上次脚本已中断，未完成；不会自动重跑整段source、闭包或Promise。已完成内部工具步骤和任务草稿继续保存，可用read_tool_result按completedSteps.callId回读，再读取当前草稿重新规划；不明外部写入先核对，不重放。"});
        db.execute(
            "UPDATE execution_steps SET status='done',output_json=? WHERE run_id=? AND step_key=?",
            params![result.to_string(), plan.id, key],
        )?;
        interrupted.insert(id.to_owned(), result);
    }
    if interrupted.is_empty() {
        return Ok(());
    }
    if !draft["messages"].is_array() {
        draft["messages"] = json!([]);
    }
    for call in pending {
        let id = call["id"].as_str().unwrap_or("");
        if draft["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool" && m["tool_call_id"] == id)
        {
            continue;
        }
        let result=interrupted.get(id).cloned().unwrap_or_else(||json!({"isError":true,"replayBlocked":true,"message":"同批脚本中断，尚未执行的旧调用已封存；请按已保存结果和当前草稿重新规划，不自动重放该调用组。"}));
        draft["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"tool","tool_call_id":id,"content":result.to_string()}));
    }
    draft["pending"] = json!([]);
    draft["toolIndex"] = 0.into();
    draft["finishSummary"] = Value::Null;
    draft["loopHint"] =
        "脚本中断后应根据已保存内部步骤和当前草稿重新规划；不会自动重跑旧脚本。".into();
    Ok(())
}
fn note_delivered(shared: &Shared, messages: &[Value]) -> Result<()> {
    let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
    for message in messages {
        if message["role"] != "tool" {
            continue;
        }
        if !c.draft["deliveredCalls"].is_array() {
            c.draft["deliveredCalls"] = json!([]);
        }
        if !c.draft["deliveredCalls"]
            .as_array()
            .unwrap()
            .contains(&message["tool_call_id"])
        {
            c.draft["deliveredCalls"]
                .as_array_mut()
                .unwrap()
                .push(message["tool_call_id"].clone());
        }
        let value = ws::parse(message["content"].as_str().unwrap_or(""));
        if value["isError"] == true {
            continue;
        }
        match value["_agentTool"].as_str().unwrap_or("") {
            "read_skill" => {
                let requested = value["requestedId"].clone();
                let count = value["body"].as_str().unwrap_or("").chars().count() as u64;
                record_skill_page(
                    &mut c.draft,
                    &requested,
                    "body",
                    value["bodyOffset"].as_u64().unwrap_or(0),
                    count,
                    value["bodyTotal"].as_u64().unwrap_or(count),
                );
                if !c.draft["skillVersions"].is_array() {
                    c.draft["skillVersions"] = json!([])
                }
                let version = json!({"name":value["name"],"version":value.get("version").unwrap_or(&value["metadata"]["version"])});
                if !c.draft["skillVersions"]
                    .as_array()
                    .unwrap()
                    .contains(&version)
                {
                    c.draft["skillVersions"]
                        .as_array_mut()
                        .unwrap()
                        .push(version);
                }
            }
            "read_tool_result" => {
                if value["sourceTool"] == "read_skill" && value["path"] == "/body" {
                    record_skill_page(
                        &mut c.draft,
                        &value["sourceRequestedId"],
                        "body",
                        value["offset"].as_u64().unwrap_or(0),
                        value["text"].as_str().unwrap_or("").chars().count() as u64,
                        value["total"].as_u64().unwrap_or(0),
                    );
                }
                if value["sourceTool"] == "read_original"
                    || value["sourceTool"] == "search_original"
                {
                    if value["sourceStatus"] == "insufficient" {
                        c.draft["sourceInsufficient"] = true.into();
                    }
                    if delivered_original_page(&value) {
                        c.draft["sourceRead"] = true.into();
                        c.draft["evidence"] = value.clone();
                    }
                }
            }
            "read_skill_resource" => {
                if value["path"] == "SKILL.md" {
                    let id = value["id"].as_str().unwrap_or("");
                    let requested = c.plan.meta["agent"]["skills"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|s| {
                            s.as_str() == Some(id)
                                || c.plan.meta["agent"]["customSkills"].as_array().is_some_and(
                                    |all| all.iter().any(|v| v["id"] == id && v["name"] == **s),
                                )
                        })
                        .cloned()
                        .unwrap_or_else(|| json!(id));
                    record_skill_page(
                        &mut c.draft,
                        &requested,
                        "SKILL.md",
                        value["offset"].as_u64().unwrap_or(0),
                        value["text"].as_str().unwrap_or("").chars().count() as u64,
                        value["total"].as_u64().unwrap_or(0),
                    );
                }
            }
            "read_original" => {
                if value["excerpts"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(has_original_text))
                {
                    c.draft["sourceRead"] = true.into();
                    c.draft["evidence"] = value.clone();
                }
                if value["status"] == "insufficient" {
                    c.draft["sourceInsufficient"] = true.into();
                }
            }
            "search_original" => {
                if value["status"] == "insufficient" {
                    c.draft["sourceInsufficient"] = true.into();
                }
            }
            // A webpage is usable evidence, but is never labelled imported
            // original text merely because it was fetched successfully.
            "read_webpage" => {
                c.draft["webEvidence"] = value.clone();
            }
            _ => {}
        }
    }
    crate::agent_memory::observe_delivery(&mut c.draft, messages);
    Ok(())
}
pub(crate) fn has_original_text(value: &Value) -> bool {
    value["kind"] == "original" && value["text"].as_str().is_some_and(|s| !s.trim().is_empty())
}
pub(crate) fn delivered_original_page(value: &Value) -> bool {
    let path = value["path"].as_str().unwrap_or("");
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.len() == 4
        && parts[1] == "excerpts"
        && parts[2].parse::<usize>().is_ok()
        && parts[3] == "text"
    {
        return value["text"].as_str().is_some_and(|s| !s.trim().is_empty());
    }
    if parts.len() == 3 && parts[1] == "excerpts" && parts[2].parse::<usize>().is_ok() {
        return has_original_text(&value["value"]);
    }
    if path == "/excerpts" {
        return value["value"]
            .as_array()
            .is_some_and(|a| a.iter().any(has_original_text));
    }
    path.is_empty()
        && value["value"]["excerpts"]
            .as_array()
            .is_some_and(|a| a.iter().any(has_original_text))
}
fn record_skill_page(
    draft: &mut Value,
    id: &Value,
    source: &str,
    start: u64,
    count: u64,
    total: u64,
) {
    let Some(name) = id.as_str().filter(|s| !s.is_empty()) else {
        return;
    };
    if total == 0 || count == 0 {
        return;
    }
    let key = format!("{name}:{source}");
    if !draft["skillCoverage"].is_object() {
        draft["skillCoverage"] = json!({});
    }
    let mut ranges = draft["skillCoverage"][&key]["ranges"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    ranges.push(json!([start, start.saturating_add(count).min(total)]));
    ranges.sort_by_key(|r| r[0].as_u64().unwrap_or(0));
    let mut merged: Vec<Value> = vec![];
    for range in ranges {
        if let Some(last) = merged
            .last_mut()
            .filter(|last| range[0].as_u64().unwrap_or(0) <= last[1].as_u64().unwrap_or(0))
        {
            last[1] = last[1]
                .as_u64()
                .unwrap_or(0)
                .max(range[1].as_u64().unwrap_or(0))
                .into();
        } else {
            merged.push(range);
        }
    }
    let complete = merged
        .first()
        .is_some_and(|r| r[0] == 0 && r[1].as_u64().unwrap_or(0) >= total);
    draft["skillCoverage"][&key] =
        json!({"id":name,"source":source,"total":total,"ranges":merged,"complete":complete});
    if complete {
        if !draft["skillsRead"].is_array() {
            draft["skillsRead"] = json!([]);
        }
        if !draft["skillsRead"].as_array().unwrap().contains(id) {
            draft["skillsRead"].as_array_mut().unwrap().push(id.clone());
        }
    }
}
pub(crate) fn input_budget(plan: &RunPlan) -> u64 {
    agent_budget::input(plan).estimated_chars
}
fn fit_result(plan: &RunPlan, name: &str, call: &str, result: &Value) -> Value {
    let allowance = input_budget(plan) / 4;
    let limit = if agent_budget::token_units(plan) {
        allowance
    } else {
        allowance.min(12000)
    } as usize;
    fit_result_to(name, call, result, limit)
}
pub(crate) fn fit_result_to(name: &str, call: &str, result: &Value, limit: usize) -> Value {
    // Results are JSON serialized inside message.content, so quotes and
    // backslashes cost twice. Bound that actual wire representation rather
    // than only the inner JSON or raw text length.
    let wire_units = |value: &Value| json!(value.to_string()).to_string().encode_utf16().count();
    if wire_units(result) <= limit {
        return result.clone();
    }
    let mut target = limit;
    for _ in 0..5 {
        let preview = preview_result(name, call, result, target);
        let cost = wire_units(&preview);
        if cost <= limit {
            return preview;
        }
        let next = target.saturating_sub(cost.saturating_sub(limit) + 16);
        if next == target {
            break;
        }
        target = next;
    }
    // Very small per-call shares carry one locator. Full metadata and text
    // stay in execution_steps and can be paged on the following request.
    let source_call = result["sourceCallId"].as_str().unwrap_or(call);
    let path = result["path"].as_str().unwrap_or(if name == "read_skill" {
        "/body"
    } else if result["excerpts"].is_array() {
        "/excerpts"
    } else {
        ""
    });
    let mut read = result.get("read").filter(|v| v.is_object()).cloned().unwrap_or_else(|| json!({"callId":source_call,"path":path,"offset":result["offset"].as_u64().unwrap_or(0),"limit":600}));
    normalize_read_locator(&mut read);
    let mut reference = json!({"_agentTool":name,"callId":call,"stored":true,"read":read,"readTool":if read["kind"].is_string(){"read_resource"}else{"read_tool_result"}});
    for key in [
        "status",
        "sourceTool",
        "sourceStatus",
        "sourceCallId",
        "sourceRequestedId",
    ] {
        if let Some(value) = result.get(key) {
            reference[key] = value.clone();
        }
    }
    if wire_units(&reference) <= limit {
        return reference;
    }
    let reference = json!({"stored":true,"read":read,"readTool":if read["kind"].is_string(){"read_resource"}else{"read_tool_result"}});
    if wire_units(&reference) <= limit {
        return reference;
    }
    // The enclosing tool_call_id is still a complete result locator.
    json!({})
}
fn preview_result(name: &str, call: &str, result: &Value, limit: usize) -> Value {
    if result.to_string().encode_utf16().count() <= limit {
        return result.clone();
    }
    if name == "read_skill" {
        let body = result["body"].as_str().unwrap_or("");
        let mut page = result.clone();
        let selected = body.chars().take((limit / 3).max(200)).collect::<String>();
        page["body"] = selected.clone().into();
        page["bodyOffset"] = 0.into();
        page["bodyTotal"] = body.chars().count().into();
        page["bodyNextOffset"] = selected.chars().count().into();
        page["callId"] = call.into();
        page["message"]="这是技能正文的第一页。指定技能须读完；用read_tool_result按callId、path=/body、offset=bodyNextOffset、limit分段继续。支持文件也可用read_skill_resource。".into();
        return page;
    }
    if let Some(text) = result["text"]
        .as_str()
        .filter(|_| result["path"].is_string())
    {
        let mut page = result.clone();
        page["text"] = "".into();
        page["truncated"] = true.into();
        if !page["read"].is_object() {
            page["read"] = json!({"callId":result.get("sourceCallId").unwrap_or(&result["callId"]),"path":result["path"],"offset":result["offset"],"limit":1200});
        }
        let overhead = page.to_string().encode_utf16().count();
        let mut available = limit.saturating_sub(overhead);
        let selected = text
            .chars()
            .take_while(|c| {
                let n = c.len_utf16();
                if n > available {
                    false
                } else {
                    available -= n;
                    true
                }
            })
            .collect::<String>();
        if !selected.is_empty() {
            page["nextOffset"] =
                (result["offset"].as_u64().unwrap_or(0) + selected.chars().count() as u64).into();
            page["read"]["offset"] = page["nextOffset"].clone();
            page["text"] = selected.into();
            return page;
        }
    }
    if let Some(excerpts) = result["excerpts"].as_array() {
        let mut preview = json!({"_agentTool":name,"callId":call,"stored":true,"truncated":true,"bookId":result["bookId"],"title":result["title"],"status":result["status"],"reason":result["reason"],"excerptCount":excerpts.len(),"excerpts":[],"readPaths":[],"message":"原文较长，先给命中位置和能容纳的实际片段。read_tool_result始终可用：按readPaths中的callId/path/offset分段读完；不要再次搜索同一证据。"});
        for (index, excerpt) in excerpts.iter().take(4).enumerate() {
            let path = format!("/excerpts/{index}/text");
            let read = json!({"callId":call,"path":path,"offset":0,"limit":1200});
            let mut item = json!({"index":index,"kind":excerpt["kind"],"bookId":excerpt["bookId"],"section":excerpt["section"],"chunk":excerpt["chunk"],"title":excerpt["title"],"start":excerpt["start"],"end":excerpt["end"],"textTotal":excerpt["text"].as_str().unwrap_or("").chars().count(),"read":read});
            if let Some(page) = excerpt.get("page") {
                item["page"] = page.clone();
            }
            let overhead = preview.to_string().encode_utf16().count()
                + item.to_string().encode_utf16().count()
                + 8;
            if overhead >= limit {
                break;
            }
            let text = excerpt["text"].as_str().unwrap_or("");
            let reserve = if index + 1 < excerpts.len() { 350 } else { 0 };
            let mut available = limit.saturating_sub(overhead + reserve);
            let selected = text
                .chars()
                .take_while(|c| {
                    let n = c.len_utf16();
                    if n > available {
                        false
                    } else {
                        available -= n;
                        true
                    }
                })
                .collect::<String>();
            if !selected.is_empty() {
                item["text"] = selected.clone().into();
                item["end"] = (excerpt["start"].as_u64().unwrap_or(0)
                    + selected.encode_utf16().count() as u64)
                    .into();
                if name != "search_original" {
                    item["read"]["offset"] = selected.chars().count().into();
                }
            }
            preview["readPaths"]
                .as_array_mut()
                .unwrap()
                .push(item["read"].clone());
            preview["excerpts"].as_array_mut().unwrap().push(item);
        }
        if preview["readPaths"].as_array().unwrap().is_empty() {
            preview["readPaths"] =
                json!([{"callId":call,"path":"/excerpts/0/text","offset":0,"limit":1200}]);
        }
        return preview;
    }
    if result["interruptedScript"] == true {
        return json!({"_agentTool":name,"isError":true,"interruptedScript":true,"replayBlocked":true,"callId":call,"draftAvailable":true,"completedSteps":result["completedSteps"].as_array().into_iter().flatten().take(6).collect::<Vec<_>>(),"read":{"callId":call,"path":"/completedSteps","offset":0,"limit":1200},"message":"上次脚本未完成且不会自动重跑。已完成内部步骤和草稿保存；请按定位读取，再根据当前草稿重新规划。未知外部写入先核对。"});
    }
    let mut read = result
        .get("read")
        .cloned()
        .unwrap_or_else(|| json!({"callId":call,"offset":0,"limit":1200}));
    normalize_read_locator(&mut read);
    json!({"_agentTool":name,"isError":result["isError"],"truncated":true,"stored":true,"callId":call,"keys":result.as_object().map(|o|o.keys().collect::<Vec<_>>()),"paths":result["paths"],"read":read,"readTool":if read["kind"].is_string(){"read_resource"}else{"read_tool_result"},"message":"工具结果较大，完整结果已保存在本任务。按readTool调用read对象中的完整参数；不要把正文path配到本次分页调用的新callId。定位不等于已读证据。"})
}

fn normalize_read_locator(read: &mut Value) {
    if let Some(object) = read.as_object_mut() {
        for key in ["id", "path"] {
            if object.get(key).and_then(Value::as_str) == Some("") {
                object.remove(key);
            }
        }
    }
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(o) => {
            let sorted = o
                .iter()
                .map(|(k, v)| (k.clone(), canonical_json(v)))
                .collect::<std::collections::BTreeMap<_, _>>();
            json!(sorted)
        }
        Value::Array(a) => json!(a.iter().map(canonical_json).collect::<Vec<_>>()),
        _ => value.clone(),
    }
}
fn hash_value(value: &Value) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    canonical_json(value).to_string().hash(&mut h);
    format!("{:016x}", h.finish())
}

#[cfg(test)]
mod projection_tests {
    use super::*;

    #[test]
    fn explicit_canon_requests_and_later_withdrawal_are_distinct() {
        assert_eq!(original_directive("按原著改写这段剧情"),Some(true));
        assert_eq!(original_directive("不要参考原著，保留我的改写"),Some(false));
        assert_eq!(original_directive("不要按原著改结局，但关系仍按原著核对"),Some(true));
        assert_eq!(original_directive("把时间显示改为纪年"),None);
    }

    #[test]
    fn root_limits_are_optional_but_legacy_explicit_caps_and_counts_still_apply() {
        let unlimited = Limits::read(&json!({})).unwrap();
        assert_eq!(
            serde_json::to_value(&unlimited).unwrap(),
            json!({"modelRequests":0,"toolCalls":0,"activeMs":0})
        );
        assert!(!unlimited.model_exhausted(1000));
        assert!(!unlimited.tools_exhausted(10000));
        assert!(!unlimited.time_exhausted(10_000_000));
        assert_eq!(unlimited.remaining_models(1000), None);
        let legacy =
            Limits::read(&json!({"modelRequests":30,"toolCalls":100,"activeMs":900000})).unwrap();
        assert!(!legacy.model_exhausted(29));
        assert!(legacy.model_exhausted(30));
        assert!(legacy.tools_exhausted(100));
        assert!(legacy.time_exhausted(900000));
        assert_eq!(legacy.remaining_models(20), Some(10));
        assert!(Limits::read(&json!({"modelRequests":-1})).is_err());
    }

    #[test]
    fn projected_results_fit_the_embedded_json_budget_with_escaping_and_metadata() {
        let large = json!({"_agentTool":"search_original","bookId":"quoted-book","title":"\"长书名\\🧭".repeat(50),"excerpts":(0..4).map(|i| json!({"kind":"original","section":i,"chunk":i,"text":"药铺\"\\\n🧭".repeat(800),"title":"章节".repeat(100)})).collect::<Vec<_>>()});
        for budget in [64, 128, 450, 750, 1000, 3000] {
            let fitted = fit_result_to("search_original", "parallel-call-1", &large, budget);
            let actual = json!(fitted.to_string()).to_string().encode_utf16().count();
            assert!(actual <= budget, "{actual} must fit {budget}");
            if budget >= 450 {
                assert!(
                    fitted["read"].is_object() || fitted["readPaths"].is_array(),
                    "must retain a reader locator"
                );
            }
        }
        let canonical =
            json!({"callId":"root-search","path":"/excerpts/0/text","offset":0,"limit":1200});
        let stored_page = json!({"_agentTool":"read_tool_result","callId":"page-call","sourceCallId":"root-search","sourceTool":"search_original","path":"/excerpts","value":[{"largeItemPath":"/excerpts/0","textPath":"/excerpts/0/text","read":canonical}],"read":canonical,"metadata":"细节".repeat(4000)});
        let projected = fit_result_to("read_tool_result", "new-page-call", &stored_page, 450);
        assert_eq!(
            projected["read"], canonical,
            "externalizing a page must not rebase its text pointer to the new page id"
        );
        let mut root_array = ws::page(json!([{"text":"原文".repeat(100)}]), &json!({"limit":40}));
        ws::attach_read_locators(&mut root_array, &json!({"callId":"root-array"}));
        assert_eq!(root_array["read"]["callId"], "root-array");
        assert_eq!(root_array["read"]["path"], "/0/text");
        let user_data =
            json!({"read":{"kind":"settings","path":"/fake"},"readTool":"read_resource"});
        let mut ordinary = ws::page(user_data.clone(), &json!({"limit":1200}));
        ws::attach_read_locators(&mut ordinary, &json!({"callId":"actual-data"}));
        assert_eq!(
            ordinary["value"], user_data,
            "ordinary JSON named read is not a locator"
        );
        assert_eq!(ordinary["read"]["callId"], "actual-data");
    }
}
