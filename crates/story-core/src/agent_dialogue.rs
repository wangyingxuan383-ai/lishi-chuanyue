//! Human intent comes from stored user messages and actual changes, never an
//! assistant's claim that it has finished. These helpers do not run a task.
use crate::{agent_workspace as ws, Error, Result, RunPlan};
use rusqlite::Connection;
use serde_json::{json, Value};

pub(crate) fn continuation(text: &str) -> bool {
    matches!(
        text.trim().trim_matches(['。', '！', '!', '，', ',', ' ']),
        "继续" | "继续吧" | "接着" | "接着做" | "继续做" | "继续执行" | "继续处理" | "接着处理"
    )
}
fn amendment(text: &str) -> bool {
    [
        "不是让你",
        "我是让你",
        "我需要让你",
        "不要只",
        "别再只",
        "还没有改",
        "你还没改",
        "并没有改",
    ]
    .iter()
    .any(|s| text.contains(s))
}
pub(crate) fn modification_requested(text: &str) -> bool {
    let t = text.trim();
    let negative = [
        "不要修改",
        "不修改",
        "不更改",
        "不改动",
        "不需要修改",
        "不许修改",
        "禁止修改",
        "先别改",
        "先不改",
        "只读分析",
        "只分析",
        "仅分析",
    ]
    .iter()
    .filter_map(|s|t.rfind(s)).max();
    if [
        "是否",
        "有没有",
        "有无",
        "那你是否",
        "你是否",
        "介绍",
        "简单介绍",
        "说明一下",
        "解释",
        "如何",
        "怎么修改",
        "哪些地方",
    ]
    .iter()
    .any(|s| t.starts_with(s))
    {
        return false;
    }
    let positive = [
        "修改",
        "更正",
        "纠错",
        "修正",
        "修复",
        "纠正",
        "改写",
        "重写",
        "调整",
        "更改",
        "删掉",
        "删除",
        "替换",
        "改成",
        "改为",
        "补全",
        "补写",
        "给我改",
        "帮我改",
        "只改",
    ]
    .iter()
    .flat_map(|s| t.match_indices(s).map(|(at,_)|at))
    .filter(|at| !["不","不要","不许","禁止","无需","不需要","未"].iter().any(|n|t[..*at].ends_with(n)))
    .max();
    positive.is_some_and(|at|negative.is_none_or(|no|at>no))
}
fn modification_directive(text:&str)->Option<bool>{
    if modification_requested(text){return Some(true);}
    ["不修改","不要修改","不更改","不改动","先不改","先别改","只分析","仅分析","只读分析"].iter().any(|p|text.contains(p)).then_some(false)
}
fn parsed(value: &Value) -> Value {
    value
        .as_str()
        .map(ws::parse)
        .unwrap_or_else(|| value.clone())
}
fn changed(row: &Value) -> bool {
    let result = parsed(&row["result_json"]);
    row["status"] == "committed" && result["worldChanged"] == true
}
#[derive(Clone)]
struct Goal {
    task: Value,
    references: Vec<Value>,
}
fn pending_goal(db: &Connection, session: &str, excluding: &str) -> Result<Option<Goal>> {
    let tasks=ws::rows(db,"SELECT id,text,status,result_json FROM agent_tasks WHERE session_id=? AND id<>? ORDER BY rowid",&[&session,&excluding])?;
    let mut goal: Option<Goal> = None;
    for task in tasks {
        let text = ws::text(&task, "text");
        if modification_requested(text) {
            if goal.is_none() || !amendment(text) {
                goal = Some(Goal {
                    task: task.clone(),
                    references: vec![],
                });
            }
        } else if !continuation(text) {
            continue;
        }
        if let Some(active) = &mut goal {
            let messages=ws::rows(db,"SELECT id AS messageId,task_id AS taskId,content AS text FROM agent_messages WHERE task_id=? AND role='user' ORDER BY rowid",&[&ws::text(&task,"id")])?;
            active.references.extend(messages);
            if ["paused", "failed", "interrupted", "cancelled"].contains(&ws::text(&task, "status"))
            {
                active.task = task.clone();
            }
            if changed(&task) {
                goal = None;
            }
        }
    }
    Ok(goal)
}
pub(crate) fn prepare(db: &Connection, plan: &mut RunPlan) -> Result<()> {
    let session = ws::text(&plan.meta["agent"], "sessionId");
    let task = ws::text(&plan.meta["agent"], "taskId");
    let text = ws::text(&plan.action, "text");
    let old = pending_goal(db, session, task)?;
    let inherit = continuation(text) || amendment(text);
    let mut refs = if inherit {
        old.as_ref()
            .map(|g| g.references.clone())
            .unwrap_or_default()
    } else {
        vec![]
    };
    for reference in &mut refs {
        reference["purpose"] = "current_goal".into();
    }
    let goal_text = refs
        .first()
        .and_then(|r| r["text"].as_str())
        .unwrap_or(text)
        .to_owned();
    let modify = modification_directive(text).unwrap_or(inherit && old.is_some());
    plan.meta["agent"]["intentReferences"] = json!(refs);
    if let Some(required)=crate::agent::original_directive(text){plan.meta["agent"]["requiresOriginalEvidence"]=required.into();}
    else if plan.meta["agent"]["intentReferences"]
        .as_array().into_iter().flatten()
        .any(|r| crate::agent::requires_original(ws::text(r,"text")))
    {
        plan.meta["agent"]["requiresOriginalEvidence"] = true.into();
    }
    plan.meta["agent"]["taskIntent"] = json!({"kind":if modify{"modify"}else{"general"},"goalText":goal_text,"continuedGoalTaskId":if inherit{old.as_ref().map(|g|g.task["id"].clone()).unwrap_or(Value::Null)}else{Value::Null},"source":"stored-human-messages","completionContractVersion":2});
    Ok(())
}
/// Only an explicit continuation and the same selected model may resume an
/// unfinished run. A changed model starts a new task with the original goal.
pub(crate) fn resume_candidate(db: &Connection, request: &Value) -> Result<Option<String>> {
    if !continuation(ws::text(request, "text")) {
        return Ok(None);
    }
    let Some(goal) = pending_goal(db, ws::text(request, "sessionId"), "")? else {
        return Ok(None);
    };
    if !["paused", "failed", "interrupted", "cancelled"].contains(&ws::text(&goal.task, "status")) {
        return Ok(None);
    }
    let rows = ws::rows(
        db,
        "SELECT r.plan_json FROM execution_runs r JOIN agent_tasks t ON t.run_id=r.id WHERE t.id=?",
        &[&ws::text(&goal.task, "id")],
    )?;
    let saved = rows
        .first()
        .map(|r| parsed(&r["plan_json"]))
        .unwrap_or(Value::Null);
    let before = &saved["meta"]["agent"]["modelSnapshot"];
    let after = &request["model"];
    if ["slot", "url", "model"]
        .iter()
        .any(|key| before[key] != after[key])
    {
        return Ok(None);
    }
    if before["protocol"].as_str().unwrap_or("chat-completions")
        != after["protocol"].as_str().unwrap_or("chat-completions")
    {
        return Ok(None);
    }
    Ok(goal.task["id"].as_str().map(str::to_owned))
}
pub(crate) fn assessment(
    db: &Connection,
    plan: &RunPlan,
    draft: &Value,
    args: &Value,
) -> Result<Value> {
    let task = ws::text(&plan.meta["agent"], "taskId");
    let changes = ws::changes(&ws::workspace(db, task)?);
    let outcome = args["outcome"]
        .as_str()
        .or_else(|| draft["finishAssessment"]["outcome"].as_str())
        .unwrap_or("completed");
    let reason = args["reason"]
        .as_str()
        .or_else(|| draft["finishAssessment"]["reason"].as_str())
        .unwrap_or("")
        .trim();
    let summary = ws::text(args, "summary");
    let mut modify = plan.meta["agent"]["taskIntent"]["kind"] == "modify"
        || modification_requested(ws::text(&plan.action, "text"));
    for row in ws::rows(db,"SELECT content FROM agent_messages WHERE task_id=? AND role='user' ORDER BY rowid",&[&task])? {
        if let Some(required)=modification_directive(ws::text(&row,"content")){modify=required;}
    }
    let evidence = args
        .get("evidenceCallIds")
        .or_else(|| draft["finishAssessment"].get("evidenceCallIds"))
        .cloned()
        .unwrap_or(json!([]));
    if matches!(outcome, "blocked" | "no_changes_needed") {
        if outcome == "no_changes_needed" && draft["sourceInsufficient"] == true {
            return Err(Error::Invalid("资料不足不能证明无需修改；请明确报告blocked并保留进度".into()));
        }
        if reason.is_empty() {
            return Err(Error::Invalid(
                "请明确说明为何未修改或受阻；不能用总结代替实际改动".into(),
            ));
        }
        let mut verified = false;
        for id in evidence
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let rows=ws::rows(db,"SELECT kind,output_json FROM execution_steps WHERE run_id=? AND step_key=? AND status='done'",&[&plan.id,&format!("agenttool:{id}")])?;
            if let Some(row) = rows.first() {
                let output = parsed(&row["output_json"]);
                if output["isError"] != true
                    && [
                        "read_resource",
                        "read_world",
                        "search_original",
                        "read_original",
                        "read_tool_result",
                        "read_canon_facts",
                        "validate_changes",
                    ]
                    .contains(&ws::text(row, "kind"))
                {
                    verified = true;
                }
            }
        }
        if modify && !verified && draft["sourceInsufficient"] != true {
            return Err(Error::Invalid(
                "未修改的结论须引用本任务实际核查结果，不能只读技能或口头宣称完成".into(),
            ));
        }
        if outcome == "no_changes_needed" && !changes.is_empty() {
            return Err(Error::Invalid(
                "仍有未采用草稿，不能同时声明无需修改；请继续核对或明确受阻，保留草稿".into(),
            ));
        }
    } else if modify && changes.is_empty() {
        return Err(Error::Invalid("本次要求实际修改，但尚未准备任何正式差异。请使用stage_edit等工具修订并校验；若确实无需修改或资料不足，用finish_task明确outcome=no_changes_needed/blocked、reason和evidenceCallIds，不能把梳理说明当作已修正。".into()));
    }
    let actual = if outcome == "blocked" {
        "blocked"
    } else if changes.is_empty() {
        if outcome == "no_changes_needed" {
            "no_changes_needed"
        } else {
            "answered"
        }
    } else {
        "modified"
    };
    let visible = if matches!(actual, "blocked" | "no_changes_needed") {
        format!("本次未修改本局：{reason}\n\n{summary}")
    } else {
        summary.to_owned()
    };
    Ok(
        json!({"outcome":actual,"reason":reason,"summary":visible,"evidenceCallIds":evidence,"hasChanges":!changes.is_empty()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_actual_edit_requests_from_status_questions() {
        assert!(modification_requested("找出错误，然后修正故事和设定"));
        assert!(modification_requested("我是让你给我改了，不是让你说废话"));
        assert!(!modification_requested("那你是否有更改什么？"));
        assert!(!modification_requested("简单介绍一下，都整理了什么？"));
        assert!(!modification_requested("只分析，不要修改剧情"));
        assert!(!modification_requested("只阅读不修改"));
        assert!(modification_requested("不改动其他，只改时间"));
        assert!(modification_requested("不要修改其他，只修改当前日期"));
        assert!(continuation("继续。"));
    }
    #[test]
    fn a_summary_without_changes_does_not_resolve_the_original_goal() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE agent_tasks(id TEXT,session_id TEXT,text TEXT,status TEXT,result_json TEXT);CREATE TABLE agent_messages(id TEXT,task_id TEXT,role TEXT,content TEXT);").unwrap();
        for (id, text, status, result) in [
            ("root", "整理时间线然后修正故事", "failed", json!(null)),
            (
                "continue",
                "继续",
                "committed",
                json!({"worldChanged":false,"changes":[]}),
            ),
            (
                "query",
                "简单介绍一下",
                "committed",
                json!({"worldChanged":false}),
            ),
        ] {
            db.execute(
                "INSERT INTO agent_tasks VALUES(?,'session',?,?,?)",
                rusqlite::params![id, text, status, result.to_string()],
            )
            .unwrap();
            db.execute(
                "INSERT INTO agent_messages VALUES(?,?,'user',?)",
                rusqlite::params![format!("m-{id}"), id, text],
            )
            .unwrap();
        }
        let goal = pending_goal(&db, "session", "").unwrap().unwrap();
        assert_eq!(goal.task["id"], "root");
        assert_eq!(goal.references[0]["text"], "整理时间线然后修正故事");
        assert_eq!(goal.references.len(), 2);
        assert!(pending_goal(&db, "another", "").unwrap().is_none());
    }
}
