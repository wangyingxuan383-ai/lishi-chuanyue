//! Optional recall of visible Pi conversations, scoped to the current route.
//! History is neither live story state nor new authorization or canon evidence.
use crate::{agent_workspace as ws, tools::ToolDefinition, Error, Result, RunPlan};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const NOTICE: &str = "这是历史对话，只供回顾；不代表本局当前事实、原著依据或本次新增授权。修改前重新读取本局。停用的旧引擎会话不参与检索。";
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
// A historical transcript can contain quotations. With a chapter fence, a
// session is readable only when every task used a provably narrower fence;
// inherited messages lack per-task provenance, so are conservatively omitted.
const SCOPE: &str = "(?=0 OR (NOT EXISTS(SELECT 1 FROM pi_session_messages hf WHERE hf.session_id=s.id) AND NOT EXISTS(SELECT 1 FROM pi_tasks tf WHERE tf.session_id=s.id AND (json_extract(tf.metadata_json,'$.referenceScope.bookId') IS NOT ? OR json_type(tf.metadata_json,'$.referenceScope.through') IS NOT 'integer' OR COALESCE(json_extract(tf.metadata_json,'$.referenceScope.through'),-1) NOT BETWEEN 0 AND ?))))";
fn fence(plan: &RunPlan) -> (bool, &str, i64) {
    let scope = &plan.meta["agent"]["referenceScope"];
    let through = scope["through"]
        .as_u64()
        .map(|n| n.min(i64::MAX as u64) as i64);
    (
        through.is_some(),
        ws::text(scope, "bookId"),
        through.unwrap_or(0),
    )
}

pub(crate) fn catalog() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition { name: "search_agent_history", read_only: true,
            description: "按标题、玩家要求和可见助手答复检索当前故事当前路线的新版助手会话，返回sessionId定位和分页。不会搜索其他故事、路线、隐藏思考或停用旧引擎会话；历史对话不能代替当前事实和本次授权。",
            parameters: json!({"type":"object","additionalProperties":false,"properties":{"query":{"type":"string","maxLength":1000},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":20}}}) },
        ToolDefinition { name: "read_agent_history", read_only: true,
            description: "按sessionId列出该路线会话的任务定位（limit为条数，最多20）；再传taskId读取可见对话，或inherited=true读取分叉继承消息。消息的path、offset、limit与资料分页一致，limit为字符预算；长消息按返回的/content路径读取。可用expectedVersion防止分页变化。不返回原Pi文件、隐藏思考、模型配置或工具原始输出。",
            parameters: json!({"type":"object","additionalProperties":false,"properties":{"sessionId":{"type":"string"},"taskId":{"type":"string"},"inherited":{"type":"boolean"},"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":24000},"expectedVersion":{"type":"string"}},"required":["sessionId"]}) },
    ]
}

pub(crate) fn search(db: &Connection, plan: &RunPlan, args: &Value) -> Result<Value> {
    let query = ws::text(args, "query").trim();
    if query.encode_utf16().count() > 1000 {
        return Err(invalid("检索文字过长，请缩短关键词"));
    }
    let offset = args["offset"].as_u64().unwrap_or(0).min(i64::MAX as u64) as i64;
    let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 20) as i64;
    let (limited, book, through) = fence(plan);
    let mut statement=db.prepare(&format!("SELECT s.id,s.title,s.updated_at,(SELECT COUNT(*) FROM pi_tasks t WHERE t.session_id=s.id) FROM pi_sessions s WHERE s.world_id=? AND s.line_id=? AND (?='' OR instr(s.title,?)>0 OR EXISTS(SELECT 1 FROM pi_session_messages h WHERE h.session_id=s.id AND json_type(h.message_json,'$.content')='text' AND instr(json_extract(h.message_json,'$.content'),?)>0) OR EXISTS(SELECT 1 FROM pi_tasks t WHERE t.session_id=s.id AND (instr(t.text,?)>0 OR EXISTS(SELECT 1 FROM pi_inputs i WHERE i.task_id=t.id AND i.status IN ('delivered','applied') AND instr(json_extract(i.content_json,'$.text'),?)>0) OR EXISTS(SELECT 1 FROM pi_events e,json_each(CASE WHEN json_type(e.event_json,'$.event.message.content')='array' THEN json_extract(e.event_json,'$.event.message.content') ELSE '[]' END) p WHERE e.task_id=t.id AND json_extract(e.event_json,'$.event.type')='message_end' AND json_extract(e.event_json,'$.event.message.role')='assistant' AND COALESCE(json_extract(e.event_json,'$.childId'),'')='' AND COALESCE(json_extract(e.event_json,'$.event.childId'),'')='' AND json_extract(p.value,'$.type')='text' AND instr(json_extract(p.value,'$.text'),?)>0)))) AND {SCOPE} ORDER BY s.updated_at DESC,s.id LIMIT ? OFFSET ?"))?;
    let rows=statement.query_map(params![plan.world_id,plan.line_id,query,query,query,query,query,query,limited,book,through,limit+1,offset],|r|Ok(json!({"sessionId":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"updatedAt":r.get::<_,String>(2)?,"taskCount":r.get::<_,i64>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let more = rows.len() > limit as usize;
    let sessions = rows.into_iter().take(limit as usize).collect::<Vec<_>>();
    Ok(
        json!({"sessions":sessions,"matchesCount":sessions.len(),"offset":offset,"nextOffset":if more{Some(offset+limit)}else{None},"worldId":plan.world_id,"lineId":plan.line_id,"historicalOnly":true,"message":NOTICE}),
    )
}

pub(crate) fn read(db: &Connection, plan: &RunPlan, args: &Value) -> Result<Value> {
    let session = ws::text(args, "sessionId");
    let (limited, book, through) = fence(plan);
    let exists=db.query_row(&format!("SELECT 1 FROM pi_sessions s WHERE s.id=? AND s.world_id=? AND s.line_id=? AND {SCOPE}"),params![session,plan.world_id,plan.line_id,limited,book,through],|_|Ok(())).optional()?.is_some();
    if !exists {
        return Err(invalid("会话不存在、已删除、不属于当前路线，或其历史参考范围超出本次限章；请重新检索或读取当前资料"));
    }
    let task_id = ws::text(args, "taskId");
    if args["inherited"] == true && !task_id.is_empty() {
        return Err(invalid("一次选择任务对话或继承对话，请勿同时指定"));
    }
    let data = if args["inherited"] == true {
        // Saved branch history is already a visible-message projection.
        json!(crate::pi_forks::inherited(db, session)?
            .into_iter()
            .filter_map(|row| visible_row(&row))
            .collect::<Vec<_>>())
    } else if task_id.is_empty() {
        if !ws::text(args, "path").is_empty() {
            return Err(invalid(
                "请先从任务目录选择taskId，或用inherited=true读取继承对话",
            ));
        }
        // SQL paging bounds work for a large session; this listing never loads
        // all of its events or original task contents into the model window.
        let offset = args["offset"].as_u64().unwrap_or(0).min(i64::MAX as u64) as i64;
        let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 20) as i64;
        let mut statement=db.prepare("SELECT id,substr(text,1,240),status,base_world_version,created_at FROM pi_tasks WHERE session_id=? AND world_id=? AND line_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?")?;
        let tasks=statement.query_map(params![session,plan.world_id,plan.line_id,limit+1,offset],|r|Ok(json!({"sessionId":session,"taskId":r.get::<_,String>(0)?,"requestPreview":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"storyVersionAtStart":r.get::<_,String>(3)?,"createdAt":r.get::<_,String>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let more = tasks.len() > limit as usize;
        let inherited: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM pi_session_messages WHERE session_id=?)",
            [session],
            |r| r.get(0),
        )?;
        return Ok(
            json!({"tasks":tasks.into_iter().take(limit as usize).collect::<Vec<_>>(),"hasInheritedMessages":inherited,"offset":offset,"nextOffset":if more{Some(offset+limit)}else{None},"historicalOnly":true,"message":NOTICE}),
        );
    } else {
        let rows=ws::rows(db,"SELECT id,session_id,text,status,created_at,updated_at FROM pi_tasks WHERE id=? AND session_id=? AND world_id=? AND line_id=?",&[&task_id,&session,&plan.world_id,&plan.line_id])?;
        let task = rows
            .first()
            .ok_or_else(|| invalid("该任务不存在或不属于所选会话，请重新列出任务"))?;
        // Recall excludes growing streaming snapshots and raw tool outputs.
        let raw=ws::rows(db,"SELECT seq,event_json FROM (SELECT seq,event_json FROM pi_events WHERE task_id=? AND COALESCE(json_extract(event_json,'$.event.type'),json_extract(event_json,'$.type')) IN ('message_start','message_end') ORDER BY seq DESC LIMIT 2000) ORDER BY seq",&[&task_id])?;
        let events = raw
            .iter()
            .map(|row| json!({"seq":row["seq"],"event":ws::parse(ws::text(row,"event_json"))}))
            .collect::<Vec<_>>();
        let inputs=ws::rows(db,"SELECT id,task_id,delivery,status,content_json,created_at FROM pi_inputs WHERE task_id=? ORDER BY seq",&[&task_id])?;
        let mut messages = crate::pi_projection::messages(task, &events, &inputs)
            .into_iter()
            .filter_map(|row| visible_row(&row))
            .collect::<Vec<_>>();
        // The original task request remains recoverable in full even if the UI
        // projection clips it. Never substitute a model summary for that text.
        if let Some(initial) = messages
            .iter_mut()
            .find(|row| row["id"] == format!("{task_id}:user"))
        {
            initial["content"] = task["text"].clone();
            initial["truncated"] = false.into();
        }
        for input in &inputs {
            if let Some(message) = messages
                .iter_mut()
                .find(|row| row["id"] == format!("{task_id}:input:{}", ws::text(input, "id")))
            {
                let original = ws::parse(ws::text(input, "content_json"));
                if original["text"].is_string() {
                    message["content"] = original["text"].clone();
                    message["truncated"] = false.into();
                }
            }
        }
        json!(messages)
    };
    let version = format!("{:x}", Sha256::digest(serde_json::to_vec(&data)?));
    if args["expectedVersion"]
        .as_str()
        .is_some_and(|old| old != version)
    {
        return Err(invalid(
            "历史对话已变化，请去掉expectedVersion重新读取定位，再继续分页",
        ));
    }
    let pointer = ws::text(args, "path");
    let selected = if pointer.is_empty() {
        data
    } else {
        data.pointer(pointer)
            .cloned()
            .ok_or_else(|| invalid("历史消息路径无效，请从会话定位重新读取"))?
    };
    let mut result = ws::page(selected, args);
    let mut locator = json!({"sessionId":session,"expectedVersion":version});
    if !task_id.is_empty() {
        locator["taskId"] = task_id.into();
    }
    if args["inherited"] == true {
        locator["inherited"] = true.into();
    }
    ws::attach_read_locators(&mut result, &locator);
    result["readTool"] = "read_agent_history".into();
    result["historyVersion"] = version.into();
    result["historicalOnly"] = true.into();
    result["message"] = NOTICE.into();
    Ok(result)
}

fn visible_row(row: &Value) -> Option<Value> {
    if !row["content"].is_string() {
        return None;
    }
    if !["user", "assistant"].contains(&ws::text(row, "role")) {
        return None;
    }
    let mut safe = json!({});
    for key in ["id", "role", "content", "createdAt", "status"] {
        if let Some(value) = row[key].as_str() {
            safe[key] = value.into();
        }
    }
    for key in ["truncated", "projectionTruncated"] {
        if row[key].is_boolean() {
            safe[key] = row[key].clone();
        }
    }
    Some(safe)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, RunPlan) {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE worlds(id TEXT PRIMARY KEY); INSERT INTO worlds VALUES('w'),('x');",
        )
        .unwrap();
        db.execute_batch(include_str!("pi_schema.sql")).unwrap();
        for (id, world, line) in [
            ("s", "w", "l"),
            ("other-world", "x", "l"),
            ("other-line", "w", "else"),
            ("fork", "w", "l"),
        ] {
            db.execute("INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES(?,?,?,'核对历法','test',?)",params![id,world,line,id]).unwrap();
        }
        for (id, session, world, line) in [
            ("t", "s", "w", "l"),
            ("foreign", "other-world", "x", "l"),
            ("foreign-line", "other-line", "w", "else"),
        ] {
            db.execute("INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,base_json,base_world_version,created_at,updated_at) VALUES(?,?,?,?,'校准纪年','completed','auto-reversible','{}','old-world-version','test','test')",params![id,session,world,line]).unwrap();
        }
        let plan=serde_json::from_value(json!({"id":"current","worldId":"w","lineId":"l","headId":"head","baseId":null,"kind":"agent","model":{"slot":"unused","url":"https://unused.invalid","model":"no-http","auxModel":null,"includeUsage":false,"maxTokens":null},"messages":[],"extractMessages":[],"state":{},"settings":{},"options":{},"action":{}})).unwrap();
        (db, plan)
    }
    fn event(db: &Connection, seq: i64, role: &str, content: Value, child: bool) {
        let mut event = json!({"event":{"type":"message_end","message":{"role":role,"id":format!("m-{seq}"),"content":content,"stopReason":"stop"}}});
        if child {
            event["childId"] = "child".into();
        }
        db.execute(
            "INSERT INTO pi_events VALUES('t',?,?, 'test')",
            params![seq, event.to_string()],
        )
        .unwrap();
    }

    #[test]
    fn search_and_read_are_route_scoped_and_ignore_hidden_or_old_history() {
        let (db, plan) = fixture();
        event(
            &db,
            1,
            "assistant",
            json!([{"type":"text","text":"纪年调整说明"},{"type":"thinking","thinking":"隐藏口令"}]),
            false,
        );
        event(
            &db,
            2,
            "assistant",
            json!([{"type":"text","text":"子助手私有内容"}]),
            true,
        );
        event(
            &db,
            3,
            "toolResult",
            json!([{"type":"text","text":"工具原始秘密"}]),
            false,
        );
        db.execute_batch("CREATE TABLE agent_messages(content TEXT);INSERT INTO agent_messages VALUES('停用旧会话');").unwrap();
        assert_eq!(
            search(&db, &plan, &json!({"query":"纪年调整"})).unwrap()["sessions"][0]["sessionId"],
            "s"
        );
        for query in ["隐藏口令", "子助手私有内容", "工具原始秘密", "停用旧会话"]
        {
            assert_eq!(
                search(&db, &plan, &json!({"query":query})).unwrap()["sessions"],
                json!([])
            );
        }
        let first = search(&db, &plan, &json!({"query":"校准纪年","limit":1})).unwrap();
        assert_eq!(first["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(first["sessions"][0]["sessionId"], "s");
        for id in ["other-world", "other-line", "deleted"] {
            assert!(read(&db, &plan, &json!({"sessionId":id})).is_err());
        }
        assert!(read(&db, &plan, &json!({"sessionId":"s","taskId":"foreign"})).is_err());
        let page = read(&db, &plan, &json!({"sessionId":"s","taskId":"t"})).unwrap();
        let text = page.to_string();
        assert!(text.contains("纪年调整说明"));
        for secret in [
            "隐藏口令",
            "子助手私有内容",
            "工具原始秘密",
            "base_json",
            "model_json",
        ] {
            assert!(!text.contains(secret));
        }
        assert_eq!(page["historicalOnly"], true);
    }

    #[test]
    fn full_original_request_can_be_paged_and_changed_history_ref_is_rejected() {
        let (db, plan) = fixture();
        let goal = format!("{}保留原始要求尾部", "甲🙂".repeat(10000));
        db.execute("UPDATE pi_tasks SET text=? WHERE id='t'", [&goal])
            .unwrap();
        let listing = read(
            &db,
            &plan,
            &json!({"sessionId":"s","taskId":"t","limit":800}),
        )
        .unwrap();
        assert_eq!(listing["largeItem"], true);
        assert_eq!(listing["value"][0]["largeItemPath"], "/0");
        let tail=read(&db,&plan,&json!({"sessionId":"s","taskId":"t","path":"/0/content","offset":20000,"limit":100,"expectedVersion":listing["historyVersion"]})).unwrap();
        assert_eq!(tail["text"], "保留原始要求尾部");
        assert_eq!(tail["read"]["taskId"], "t");
        assert_eq!(tail["readTool"], "read_agent_history");
        event(
            &db,
            1,
            "assistant",
            json!([{"type":"text","text":"后来的答复"}]),
            false,
        );
        assert!(read(&db,&plan,&json!({"sessionId":"s","taskId":"t","path":"/0/content","expectedVersion":listing["historyVersion"]})).is_err());
        let listing = read(&db, &plan, &json!({"sessionId":"s","limit":1})).unwrap();
        assert_eq!(
            listing["tasks"][0]["storyVersionAtStart"],
            "old-world-version"
        );
        assert!(
            listing["tasks"][0]["requestPreview"]
                .as_str()
                .unwrap()
                .chars()
                .count()
                <= 240
        );
    }

    #[test]
    fn chapter_fence_blocks_broader_unknown_and_inherited_transcripts() {
        let (db, mut plan) = fixture();
        plan.meta = json!({"agent":{"referenceScope":{"bookId":"book","through":2}}});
        assert_eq!(
            search(&db, &plan, &json!({"query":"校准纪年"})).unwrap()["sessions"],
            json!([])
        );
        for scope in [
            json!({"bookId":"book","through":null}),
            json!({"bookId":"book","through":3}),
            json!({"bookId":"other","through":0}),
        ] {
            db.execute(
                "UPDATE pi_tasks SET metadata_json=? WHERE id='t'",
                [json!({"referenceScope":scope}).to_string()],
            )
            .unwrap();
            assert!(read(&db, &plan, &json!({"sessionId":"s","taskId":"t"})).is_err());
        }
        db.execute(
            "UPDATE pi_tasks SET metadata_json=? WHERE id='t'",
            [json!({"referenceScope":{"bookId":"book","through":1}}).to_string()],
        )
        .unwrap();
        assert_eq!(
            search(&db, &plan, &json!({"query":"校准纪年"})).unwrap()["sessions"][0]["sessionId"],
            "s"
        );
        assert!(read(&db, &plan, &json!({"sessionId":"s","taskId":"t"})).is_ok());
        let inherited =
            json!({"id":"history","role":"assistant","content":"未有独立范围的继承消息"});
        db.execute(
            "INSERT INTO pi_session_messages VALUES('s',1,'history','entry',?)",
            [inherited.to_string()],
        )
        .unwrap();
        assert!(read(&db, &plan, &json!({"sessionId":"s","inherited":true})).is_err());
        assert_eq!(
            search(&db, &plan, &json!({"query":"校准纪年"})).unwrap()["sessions"],
            json!([])
        );
    }

    #[test]
    fn fork_history_survives_parent_deletion_and_returns_only_visible_fields() {
        let (db, plan) = fixture();
        let row = json!({"id":"fork:history:1","role":"assistant","content":"继承的历法说明","status":"archived","thinking":"不应出现","entryId":"private-entry","apiKey":"not-a-real-key"});
        db.execute(
            "INSERT INTO pi_session_messages VALUES('fork',1,'fork:history:1','private-entry',?)",
            [row.to_string()],
        )
        .unwrap();
        db.execute("DELETE FROM pi_sessions WHERE id='s'", [])
            .unwrap();
        let found = search(&db, &plan, &json!({"query":"继承的历法"})).unwrap();
        assert_eq!(found["sessions"][0]["sessionId"], "fork");
        assert_eq!(
            read(&db, &plan, &json!({"sessionId":"fork"})).unwrap()["hasInheritedMessages"],
            true
        );
        let history = read(&db, &plan, &json!({"sessionId":"fork","inherited":true})).unwrap();
        assert_eq!(history["value"][0]["content"], "继承的历法说明");
        for secret in ["thinking", "private-entry", "apiKey", "not-a-real-key"] {
            assert!(!history.to_string().contains(secret));
        }
    }

    #[test]
    fn readonly_gateway_discovers_and_accounts_history_reads_without_story_changes() {
        use crate::{
            pi_gateway::StoryToolGateway,
            pi_store::{NewSession, PiCallRequest},
            Store,
        };
        use std::sync::{Arc, Mutex};
        let mut db = Connection::open_in_memory().unwrap();
        crate::migration::migrate(&mut db, None).unwrap();
        db.execute_batch("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('w','隔离回顾','free','l','{}','test','test','test');INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n','w',0,'opening','正式正文','test');INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l','w','主线','n','test');INSERT INTO states(node_id,state_json) VALUES('n','{\"time\":{\"start\":\"第一天\",\"elapsedMinutes\":0},\"source\":null}');").unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        let gateway = StoryToolGateway::new(store.clone());
        gateway
            .create_session(&NewSession {
                id: "s".into(),
                world_id: "w".into(),
                line_id: "l".into(),
                title: "回顾测试".into(),
                session_file: None,
            })
            .unwrap();
        let task = gateway
            .start_task(
                "s",
                "t",
                "回顾之前要求",
                "auto-reversible",
                true,
                json!({"model":"no-http"}),
                json!({}),
            )
            .unwrap();
        let permit = gateway.permit("t").unwrap();
        for (id, name, args) in [
            (
                "discover",
                "discover_tools",
                json!({"names":["search_agent_history","read_agent_history"]}),
            ),
            ("search", "search_agent_history", json!({"query":"回顾"})),
            (
                "read",
                "read_agent_history",
                json!({"sessionId":"s","taskId":"t"}),
            ),
        ] {
            let result = gateway
                .invoke(
                    &permit,
                    PiCallRequest {
                        task_id: "t".into(),
                        call_id: id.into(),
                        tool: name.into(),
                        args,
                        intent_revision: 0,
                        world_version: task["base_world_version"].as_str().unwrap().into(),
                        external_write: false,
                    },
                )
                .unwrap();
            assert_eq!(result["ok"], true, "{result}");
        }
        let db = store.lock().unwrap();
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM pi_calls WHERE status='done'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            3
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM pi_model_requests", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT narrative FROM nodes WHERE id='n'", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "正式正文"
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
