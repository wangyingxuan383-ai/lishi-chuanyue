//! Durable human inputs and plans. Receiving input and committing a draft share
//! the SQLite transaction boundary, so an accepted correction cannot be lost.
use crate::{agent_workspace as ws, Error, Result, RunPlan, Store};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) fn initialize(db: &Connection, task: &str) -> Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO agent_control(task_id) VALUES(?)",
        [task],
    )?;
    Ok(())
}
pub(crate) fn state(db: &Connection, task: &str) -> Result<Value> {
    initialize(db, task)?;
    let (intent, consumed, stop, plan, question, context): (i64,i64,i64,String,Option<String>,String) = db.query_row(
        "SELECT intent_revision,consumed_seq,stop_revision,plan_json,question_json,context_json FROM agent_control WHERE task_id=?", [task],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
    Ok(
        json!({"intentRevision":intent,"consumedSeq":consumed,"stopRevision":stop,"plan":ws::parse(&plan),"question":question.map(|q|ws::parse(&q)),"context":ws::parse(&context)}),
    )
}
pub(crate) fn inputs(db: &Connection, session: &str, task: Option<&str>) -> Result<Vec<Value>> {
    let mut rows = if let Some(task) = task {
        ws::rows(db,"SELECT rowid AS seq,id,task_id AS taskId,delivery,status,content_json,created_at AS createdAt,delivered_at AS deliveredAt FROM agent_inputs WHERE session_id=? AND task_id=? ORDER BY rowid",&[&session,&task])?
    } else {
        ws::rows(db,"SELECT rowid AS seq,id,task_id AS taskId,delivery,status,content_json,created_at AS createdAt,delivered_at AS deliveredAt FROM agent_inputs WHERE session_id=? ORDER BY rowid",&[&session])?
    };
    for row in &mut rows {
        let payload = ws::parse(ws::text(row, "content_json"));
        row.as_object_mut().unwrap().remove("content_json");
        row["text"] = payload["text"].clone();
        row["questionId"] = payload["questionId"].clone();
        row["cancelled"] = payload["cancelled"].clone();
    }
    Ok(rows)
}
fn task_session(db: &Connection, task: &str) -> Result<(String, String)> {
    db.query_row(
        "SELECT session_id,status FROM agent_tasks WHERE id=?",
        [task],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(Into::into)
}
pub(crate) fn enqueue(store: &Store, request: &Value) -> Result<Value> {
    let mut db = store.lock()?;
    let tx = db.transaction()?;
    let id = request["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(ws::id);
    if let Some((session, delivery, status, task, payload)) = tx
        .query_row(
            "SELECT session_id,delivery,status,task_id,content_json FROM agent_inputs WHERE id=?",
            [&id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
    {
        if request["sessionId"].as_str().is_some_and(|s| s != session) {
            return Err(Error::Invalid("输入标识属于另一段对话".into()));
        }
        let old = ws::parse(&payload);
        let old_target = old["requestedTaskId"].as_str().or(task.as_deref());
        if request["taskId"]
            .as_str()
            .is_some_and(|s| old_target.is_some_and(|t| s != t))
            || old["text"].as_str() != request["text"].as_str().map(str::trim)
            || old["request"] != request["request"]
        {
            return Err(Error::Invalid(
                "输入标识已用于其他内容，请使用新的标识".into(),
            ));
        }
        return Ok(json!({"id":id,"delivery":delivery,"status":status,"duplicate":true}));
    }
    let requested_task = request["taskId"].as_str().unwrap_or("");
    let (session, status) = if !requested_task.is_empty() {
        task_session(&tx, requested_task)?
    } else {
        let s = request["sessionId"]
            .as_str()
            .ok_or_else(|| Error::Invalid("缺少对话标识".into()))?;
        if !tx
            .query_row("SELECT 1 FROM agent_sessions WHERE id=?", [s], |_| Ok(()))
            .optional()?
            .is_some()
        {
            return Err(Error::Invalid("对话不存在".into()));
        }
        (s.into(), String::new())
    };
    let text = request["text"].as_str().unwrap_or("").trim();
    if text.is_empty() || text.encode_utf16().count() > 100000 {
        return Err(Error::Invalid("请填写有效的补充要求".into()));
    }
    let mut delivery = request["delivery"].as_str().unwrap_or("steer");
    if !["steer", "queued"].contains(&delivery) {
        return Err(Error::Invalid("输入方式无效".into()));
    }
    // A completed commit wins the transaction; a late steer becomes new work.
    if delivery == "steer"
        && ![
            "running",
            "waiting_user",
            "paused",
            "cancelled",
            "interrupted",
            "failed",
        ]
        .contains(&status.as_str())
    {
        delivery = "queued";
    }
    let target = if delivery == "steer" {
        Some(requested_task)
    } else {
        None
    };
    let payload =
        json!({"text":text,"request":request["request"],"requestedTaskId":request["taskId"]});
    tx.execute("INSERT INTO agent_inputs(id,session_id,task_id,delivery,content_json,created_at) VALUES(?,?,?,?,?,?)",params![id,session,target,delivery,payload.to_string(),ws::now()])?;
    if let Some(task) = target {
        initialize(&tx, task)?;
        tx.execute(
            "UPDATE agent_control SET intent_revision=intent_revision+1 WHERE task_id=?",
            [task],
        )?;
    }
    tx.commit()?;
    Ok(json!({"id":id,"delivery":delivery,"status":"pending","accepted":true}))
}
pub(crate) fn cancel_queued(store: &Store, id: &str) -> Result<Value> {
    let db = store.lock()?;
    let changed=db.execute("UPDATE agent_inputs SET status='cancelled' WHERE id=? AND delivery='queued' AND status='pending'",[id])?;
    Ok(json!({"cancelled":changed==1,"id":id}))
}
pub(crate) fn compact(store: &Store, request: &Value) -> Result<Value> {
    let task = request["taskId"]
        .as_str()
        .ok_or_else(|| Error::Invalid("缺少任务标识".into()))?;
    let mut db = store.lock()?;
    let tx = db.transaction()?;
    let (session, status) = task_session(&tx, task)?;
    if !["running", "paused", "failed", "cancelled", "interrupted"].contains(&status.as_str()) {
        return Err(Error::Invalid(
            "这项任务当前不能整理上下文；等待问题时请先回答，已完成任务请发起新要求".into(),
        ));
    }
    let id = request["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(ws::id);
    if let Some((old_task, delivery)) = tx
        .query_row(
            "SELECT task_id,delivery FROM agent_inputs WHERE id=?",
            [&id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
    {
        if old_task.as_deref() != Some(task) || delivery != "compact" {
            return Err(Error::Invalid("输入标识已用于其他内容".into()));
        }
        return Ok(json!({"id":id,"delivery":"compact","duplicate":true,"resume":false}));
    }
    initialize(&tx, task)?;
    tx.execute("INSERT INTO agent_inputs(id,session_id,task_id,delivery,content_json,created_at) VALUES(?,?,?,'compact',?,?)",params![id,session,task,json!({"text":"请整理当前任务上下文，保留原要求、证据与未完成事项，再继续。"}).to_string(),ws::now()])?;
    tx.execute(
        "UPDATE agent_control SET intent_revision=intent_revision+1 WHERE task_id=?",
        [task],
    )?;
    tx.commit()?;
    Ok(json!({"id":id,"delivery":"compact","status":"pending","resume":status!="running"}))
}
pub(crate) fn consume(db: &Connection, plan: &RunPlan, draft: &mut Value) -> Result<bool> {
    let task = ws::text(&plan.meta["agent"], "taskId");
    initialize(db, task)?;
    let pending=ws::rows(db,"SELECT rowid AS seq,id,delivery,content_json FROM agent_inputs WHERE task_id=? AND status='pending' AND delivery IN ('steer','answer','compact') ORDER BY rowid",&[&task])?;
    if pending.is_empty() {
        return Ok(false);
    }
    if !draft["messages"].is_array() {
        draft["messages"] = json!([]);
    }
    let mut max_seq = 0;
    for row in pending {
        let payload = ws::parse(ws::text(&row, "content_json"));
        let content = if row["delivery"] == "answer" {
            format!("【玩家回答】{}", payload["answers"])
        } else {
            ws::text(&payload, "text").to_owned()
        };
        draft["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"user","content":content,"_inputId":row["id"]}));
        db.execute("INSERT INTO agent_messages(id,session_id,task_id,role,content,created_at) VALUES(?,?,?,'user',?,?)",params![ws::id(),plan.meta["agent"]["sessionId"].as_str().unwrap_or(""),task,content,ws::now()])?;
        db.execute(
            "UPDATE agent_inputs SET status='delivered',delivered_at=? WHERE id=?",
            params![ws::now(), row["id"].as_str()],
        )?;
        max_seq = max_seq.max(row["seq"].as_i64().unwrap_or(0));
        if row["delivery"] == "compact" {
            draft["forceCompact"] = true.into();
        }
    }
    db.execute(
        "UPDATE agent_control SET consumed_seq=MAX(consumed_seq,?) WHERE task_id=?",
        params![max_seq, task],
    )?;
    let state = state(db, task)?;
    draft["intentRevision"] = state["intentRevision"].clone();
    draft["finishSummary"] = Value::Null;
    Ok(true)
}
pub(crate) fn guard_commit(db: &Connection, plan: &RunPlan, draft: &Value) -> Result<()> {
    let task = ws::text(&plan.meta["agent"], "taskId");
    let control = state(db, task)?;
    if control["intentRevision"].as_u64().unwrap_or(0)!=draft["intentRevision"].as_u64().unwrap_or(0)
        || control["stopRevision"].as_u64().unwrap_or(0)!=draft["stopRevision"].as_u64().unwrap_or(0)
        || db.query_row("SELECT 1 FROM agent_inputs WHERE task_id=? AND status='pending' AND delivery IN ('steer','answer','compact') LIMIT 1",[task],|_|Ok(())).optional()?.is_some() {
        return Err(Error::Invalid("新的补充或停止要求尚未处理，本次旧草稿不会提交".into()));
    }
    if !control["question"].is_null() {
        return Err(Error::Invalid("请等待玩家回答后再完成".into()));
    }
    Ok(())
}
pub(crate) fn stop(store: &Store, run: &str) -> Result<()> {
    let db = store.lock()?;
    let task:Option<String>=db.query_row("SELECT id FROM agent_tasks WHERE run_id=? AND status IN ('running','waiting_user','paused')",[run],|r|r.get(0)).optional()?;
    if let Some(task) = task {
        initialize(&db, &task)?;
        db.execute("UPDATE agent_control SET stop_revision=stop_revision+1,question_json=NULL WHERE task_id=?",[&task])?;
        db.execute("UPDATE agent_subtasks SET status='cancelled',updated_at=? WHERE task_id=? AND status IN ('pending','running')",params![ws::now(),task])?;
        db.execute("UPDATE agent_tasks SET status='cancelled',error='玩家停止了等待' WHERE id=? AND status='waiting_user'",[&task])?;
        db.execute("UPDATE execution_runs SET status='cancelled',error='玩家停止了等待' WHERE id=? AND status='waiting_user'",[run])?;
    }
    Ok(())
}
pub(crate) fn update_plan(db: &Connection, task: &str, args: &Value) -> Result<Value> {
    initialize(db, task)?;
    let steps = args["steps"]
        .as_array()
        .ok_or_else(|| Error::Invalid("任务步骤应是列表".into()))?;
    if steps.len() > 50 {
        return Err(Error::Invalid("任务步骤过多，请合并相关事项".into()));
    }
    for step in steps {
        if step["id"].as_str().unwrap_or("").is_empty()
            || step["text"].as_str().unwrap_or("").is_empty()
            || ![
                "pending",
                "in_progress",
                "completed",
                "cancelled",
                "blocked",
            ]
            .contains(&step["status"].as_str().unwrap_or(""))
        {
            return Err(Error::Invalid("任务步骤缺少标识、说明或有效状态".into()));
        }
    }
    db.execute(
        "UPDATE agent_control SET plan_json=? WHERE task_id=?",
        params![args["steps"].to_string(), task],
    )?;
    Ok(json!({"steps":steps,"summary":"任务计划已更新"}))
}
pub(crate) fn ask(db: &Connection, task: &str, args: &Value) -> Result<Value> {
    initialize(db, task)?;
    let mut questions = args["questions"]
        .as_array()
        .ok_or_else(|| Error::Invalid("请提供需要玩家回答的问题".into()))?
        .clone();
    if questions.is_empty() || questions.len() > 3 {
        return Err(Error::Invalid("一次请集中询问1至3项必要问题".into()));
    }
    let mut ids = std::collections::HashSet::new();
    for (index, q) in questions.iter_mut().enumerate() {
        if q["question"].as_str().unwrap_or("").trim().is_empty() {
            return Err(Error::Invalid("问题内容不能为空".into()));
        }
        if q["id"].as_str().unwrap_or("").trim().is_empty() {
            q["id"] = format!("question-{}", index + 1).into();
        }
        if !ids.insert(q["id"].as_str().unwrap_or("").to_owned()) {
            return Err(Error::Invalid("问题标识不能重复".into()));
        }
        q["allowFreeText"] = true.into();
    }
    let question = json!({"id":ws::id(),"title":args["title"].as_str().unwrap_or("需要你补充"),"questions":questions});
    db.execute(
        "UPDATE agent_control SET question_json=? WHERE task_id=?",
        params![question.to_string(), task],
    )?;
    Ok(
        json!({"waitingForUser":true,"question":question,"message":"问题已交给玩家。等待期间不继续推理或提交。"}),
    )
}
pub(crate) fn answer(store: &Store, request: &Value) -> Result<Value> {
    let task = request["taskId"]
        .as_str()
        .ok_or_else(|| Error::Invalid("缺少任务标识".into()))?;
    let mut db = store.lock()?;
    let tx = db.transaction()?;
    let (session, _) = task_session(&tx, task)?;
    let id = request["id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(ws::id);
    if let Some((old_task, delivery, payload)) = tx
        .query_row(
            "SELECT task_id,delivery,content_json FROM agent_inputs WHERE id=?",
            [&id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
    {
        let old = ws::parse(&payload);
        if old_task.as_deref() != Some(task)
            || delivery != "answer"
            || old["questionId"] != request["questionId"]
            || old["answers"] != request["answers"]
            || old["cancelled"] != (request["cancelled"] == true)
        {
            return Err(Error::Invalid("输入标识已用于其他内容".into()));
        }
        return Ok(json!({"duplicate":true,"resume":false}));
    }
    let control = state(&tx, task)?;
    if control["question"]["id"] != request["questionId"] || control["question"].is_null() {
        return Err(Error::Invalid("问题已变化，请读取最新任务".into()));
    }
    let cancelled = request["cancelled"] == true;
    if !cancelled {
        let answers = request["answers"]
            .as_object()
            .ok_or_else(|| Error::Invalid("请填写问题的回答".into()))?;
        for question in control["question"]["questions"]
            .as_array()
            .into_iter()
            .flatten()
        {
            let id = question["id"].as_str().unwrap_or("");
            if !answers
                .get(id)
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty())
            {
                return Err(Error::Invalid("请回答所有必要问题后继续".into()));
            }
        }
    }
    let payload = json!({"answers":request["answers"],"questionId":request["questionId"],"cancelled":cancelled});
    tx.execute("INSERT INTO agent_inputs(id,session_id,task_id,delivery,content_json,status,created_at) VALUES(?,?,?,'answer',?,?,?)",params![id,session,task,payload.to_string(),if cancelled{"cancelled"}else{"pending"},ws::now()])?;
    tx.execute("UPDATE agent_control SET question_json=NULL,intent_revision=intent_revision+1 WHERE task_id=?",[task])?;
    if cancelled {
        tx.execute(
            "UPDATE agent_tasks SET status='cancelled',error='玩家取消了补充问题' WHERE id=?",
            [task],
        )?;
        tx.execute("UPDATE execution_runs SET status='cancelled',error='玩家取消了补充问题' WHERE id=(SELECT run_id FROM agent_tasks WHERE id=?)",[task])?;
    }
    tx.commit()?;
    Ok(json!({"resume":!cancelled,"cancelled":cancelled,"taskId":task,"id":id}))
}
pub(crate) fn history(db: &Connection, plan: &RunPlan, args: &Value) -> Result<Value> {
    let query = args["query"].as_str().unwrap_or("");
    let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 30) as i64;
    let rows=ws::rows(db,"SELECT m.id,m.session_id AS sessionId,m.role,m.content,m.created_at AS createdAt FROM agent_messages m JOIN agent_sessions s ON s.id=m.session_id WHERE s.world_id=? AND s.line_id=? AND m.role IN ('user','assistant') AND m.content LIKE ? ORDER BY m.rowid DESC LIMIT ?",&[&plan.world_id,&plan.line_id,&format!("%{query}%"),&limit])?;
    let matches = rows
        .into_iter()
        .map(|mut r| {
            let text = ws::text(&r, "content")
                .chars()
                .take(1800)
                .collect::<String>();
            r["content"] = text.into();
            r
        })
        .collect::<Vec<_>>();
    Ok(json!({"matches":matches,"scope":"当前故事和路线的助手对话；不是正式剧情事实"}))
}
pub(crate) fn search_sessions(store: &Store, args: &Value) -> Result<Value> {
    let db = store.lock()?;
    let world = args["worldId"].as_str().unwrap_or("");
    let line = args["lineId"].as_str().unwrap_or("");
    let query = format!("%{}%", args["query"].as_str().unwrap_or(""));
    let rows=ws::rows(&db,"SELECT DISTINCT s.id,s.world_id AS worldId,s.line_id AS lineId,s.title,s.created_at AS createdAt,s.updated_at AS updatedAt FROM agent_sessions s LEFT JOIN agent_messages m ON m.session_id=s.id WHERE s.world_id=? AND s.line_id=? AND (s.title LIKE ? OR m.content LIKE ?) ORDER BY s.updated_at DESC LIMIT 50",&[&world,&line,&query,&query])?;
    Ok(json!({"sessions":rows}))
}
pub(crate) fn fork(store: &Store, args: &Value) -> Result<Value> {
    let old = args["sessionId"].as_str().unwrap_or("");
    let message = args["messageId"].as_str().unwrap_or("");
    let mut db = store.lock()?;
    let tx = db.transaction()?;
    let (world, line, title): (String, String, String) = tx.query_row(
        "SELECT world_id,line_id,title FROM agent_sessions WHERE id=?",
        [old],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let end: i64 = tx.query_row(
        "SELECT rowid FROM agent_messages WHERE id=? AND session_id=?",
        params![message, old],
        |r| r.get(0),
    )?;
    let id = ws::id();
    let at = ws::now();
    tx.execute(
        "INSERT INTO agent_sessions VALUES(?,?,?,?,?,?)",
        params![
            id,
            world,
            line,
            args["title"]
                .as_str()
                .unwrap_or(&format!("{title} · 新思路")),
            at,
            at
        ],
    )?;
    let messages=ws::rows(&tx,"SELECT role,content FROM agent_messages WHERE session_id=? AND rowid<=? AND role IN ('user','assistant') ORDER BY rowid",&[&old,&end])?;
    for m in messages {
        tx.execute(
            "INSERT INTO agent_messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)",
            params![ws::id(), id, m["role"].as_str(), m["content"].as_str(), at],
        )?;
    }
    tx.execute(
        "INSERT INTO agent_session_links VALUES(?,?,?)",
        params![id, old, message],
    )?;
    tx.commit()?;
    Ok(
        json!({"id":id,"worldId":world,"lineId":line,"title":args["title"].as_str().unwrap_or(&title),"createdAt":at,"updatedAt":at,"worldChanged":false}),
    )
}
