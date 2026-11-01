//! Isolated readable-history archives: no model, HTTP, phone or personal data.
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use story_core::pi_archive::{export_readable, validate_readable};

const PRIVATE: &str = "LEAK-private-runtime-and-credential";

#[test]
fn fork_only_history_and_partial_goal_sources_survive_readonly_reexport() {
    let mut db=Connection::open_in_memory().unwrap();fixture(&mut db);
    db.execute_batch("INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('fork','world','line','独立分叉','test','test');").unwrap();
    for (seq,role,body) in [(0,"user","我设定阿兰在本局仍然活着"),(1,"assistant","已保存本局分支，原著另一项仍缺少依据")] {
        let message=json!({"id":format!("fork:history:{seq}"),"role":role,"content":body,"createdAt":"test","apiKey":PRIVATE,"taskId":"deleted-parent-task"});
        db.execute("INSERT INTO pi_session_messages(session_id,seq,message_id,entry_id,message_json) VALUES('fork',?,?,?,?)",params![seq,format!("fork:history:{seq}"),format!("old-entry-{seq}"),message.to_string()]).unwrap();
    }
    let receipt=json!({"status":"committed","goalStatus":"partial","goalCompleted":false,"goalResult":{"status":"partial","workspaceFingerprint":PRIVATE,"goals":[{"id":"first","status":"completed","summary":"采用玩家分支","model":PRIVATE},{"id":"second","status":"blocked","summary":"另一项原文不足"}],"normalizedFindings":[{"basis":"player_setting","resources":[{"fingerprint":PRIVATE}],"references":[{"playerReferenceId":"request:1","quote":"我设定阿兰在本局仍然活着","scope":"本局","declaration":{"apiKey":PRIVATE}}]},{"basis":"original","references":[{"quote":"真实原文引句","location":{"bookId":"book","section":0,"chunk":1,"title":"真实章名","page":3,"offset":20,"apiKey":PRIVATE}}]}]}});
    db.execute("UPDATE pi_tasks SET result_json=? WHERE id='finished'",[receipt.to_string()]).unwrap();
    let value=snapshot(&db);
    assert_eq!(value["sessions"].as_array().unwrap().len(),2);
    let fork=value["tasks"].as_array().unwrap().iter().find(|t|t["sessionId"]=="fork").unwrap();
    assert_eq!(fork["status"],"archived");assert_eq!(fork["history"]["messages"].as_array().unwrap().len(),2);
    assert_eq!(fork["history"]["messages"][0]["content"],"我设定阿兰在本局仍然活着");
    let result=&value["tasks"].as_array().unwrap().iter().find(|t|t["id"]=="finished").unwrap()["history"]["result"];
    assert_eq!(result["goalStatus"],"partial");assert_eq!(result["goalCompleted"],false);
    assert_eq!(result["goalResult"]["goals"][1]["status"],"blocked");
    assert_eq!(result["goalResult"]["sources"][0]["basis"],"player_setting");
    assert_eq!(result["goalResult"]["sources"][1]["bookId"],"book");
    assert_eq!(result["goalResult"]["sources"][1]["offset"],20);
    assert_eq!(validate_readable(&value,"world",&["line".into()]).unwrap(),value);
    assert!(!value.to_string().contains(PRIVATE));
    assert!(!value.to_string().contains("deleted-parent-task"));
    assert!(!value.to_string().contains("old-entry-"));
    assert_eq!(db.query_row("SELECT COUNT(*) FROM pi_tasks WHERE session_id='fork'",[],|r|r.get::<_,i64>(0)).unwrap(),0,"a readable export never creates runnable tasks");
}

fn fixture(db: &mut Connection) {
    story_core::migration::migrate(db, None).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON;
        INSERT INTO worlds(id,title,era_id,created_at,updated_at,played_at) VALUES('world','隔离归档','free','test','test','test');
        INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n','world',0,'opening','正式正文','test');
        INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('line','world','主线','n','test');
        UPDATE worlds SET current_line_id='line' WHERE id='world';
        INSERT INTO pi_sessions(id,world_id,line_id,title,session_file,created_at,updated_at) VALUES('session','world','line','只读对话','/private/executable-session.jsonl','test','test');
        INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('unfinished-only','world','line','未完成会话','test','test');
        INSERT INTO agent_sessions VALUES('legacy','world','line','旧引擎会话','test','test');").unwrap();
    for (id, session, status, active) in [
        ("finished", "session", "committed", false),
        ("running", "unfinished-only", "running", true),
        ("preview", "session", "previewed", false),
        ("reply-pending", "session", "committed", true),
    ] {
        let text = if id == "finished" {
            "更正设定"
        } else {
            "UNFINISHED-task-must-not-export"
        };
        db.execute("INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,base_json,base_world_version,workspace_json,model_json,metadata_json,lease_json,plan_json,result_json,created_at,updated_at) VALUES(?,?,'world','line',?,?,'auto-reversible',?,?,?,?,?,?,?,?, 'test','test')",params![id,session,text,status,PRIVATE,PRIVATE,json!({"draft":PRIVATE}).to_string(),json!({"apiKey":PRIVATE,"baseUrl":PRIVATE}).to_string(),json!({"_nativeHostActive":active,"apiKey":PRIVATE,"network":PRIVATE}).to_string(),json!({"owner":PRIVATE}).to_string(),json!([{"id":"plan","title":"校对设定","status":"completed","hidden":PRIVATE}]).to_string(),json!({"status":"committed","summary":"实际结果","worldVersion":PRIVATE,"readBack":{"private":PRIVATE},"changes":[{"kind":"settings","id":"","summary":"更正称谓","before":PRIVATE,"after":PRIVATE}],"sources":[{"title":"引用原文","bookId":"book","quote":"原文依据","section":2,"page":3,"url":"https://source.example/read?id=1&token=URL-SECRET#PRIVATE-FRAGMENT","headers":{"Authorization":PRIVATE}}]}).to_string()]).unwrap();
    }
    let event = json!({"sessionId":"session","taskId":"finished","event":{"type":"message_end","message":{"role":"assistant","timestamp":1,"content":[{"type":"thinking","thinking":"HIDDEN-THINKING"},{"type":"text","text":"实际结果"}],"apiKey":PRIVATE}}});
    db.execute(
        "INSERT INTO pi_events VALUES('finished',1,?,'test')",
        [event.to_string()],
    )
    .unwrap();
    let call = json!({"ok":true,"data":{"status":"committed","changes":[{"after":PRIVATE}],"apiKey":PRIVATE,"text":PRIVATE}});
    db.execute("INSERT INTO pi_calls(task_id,call_id,tool,args_hash,world_version,intent_revision,external_write,status,output_json,created_at,updated_at) VALUES('finished','call','finish_task',?,?,0,0,'done',?,'test','test')",params![PRIVATE,PRIVATE,call.to_string()]).unwrap();
    db.execute("INSERT INTO pi_inputs(id,session_id,task_id,seq,delivery,content_json,status,created_at) VALUES('input','session','finished',1,'steer',?,'delivered','test')",[json!({"text":"保留玩家分支","nonce":"INTERNAL-NONCE"}).to_string()]).unwrap();
    db.execute("INSERT INTO pi_inputs(id,session_id,task_id,seq,delivery,content_json,status,created_at) VALUES('pending','session','finished',2,'queued',?,'pending','test')",[json!({"text":"UNFINISHED-queued-input"}).to_string()]).unwrap();
    db.execute(
        "INSERT INTO story_recovery_points VALUES('recovery','world','finished',?,?,?,'test')",
        params![PRIVATE, PRIVATE, PRIVATE],
    )
    .unwrap();
}

fn snapshot(db: &Connection) -> Value {
    db.execute_batch("PRAGMA query_only=ON;BEGIN").unwrap();
    let value = export_readable(db, "world").unwrap();
    db.execute_batch("ROLLBACK").unwrap();
    value
}

#[test]
fn requires_the_callers_read_only_transaction() {
    let mut db = Connection::open_in_memory().unwrap();
    fixture(&mut db);
    assert!(export_readable(&db, "world").is_err());
    db.execute_batch("BEGIN").unwrap();
    assert!(export_readable(&db, "world").is_err());
    db.execute_batch("ROLLBACK").unwrap();
    let value = snapshot(&db);
    assert_eq!(value["engine"], "pi");
    assert_eq!(value["readOnly"], true);
}

#[test]
fn exports_only_completed_visible_history_without_runtime_or_replay_state() {
    let mut db = Connection::open_in_memory().unwrap();
    fixture(&mut db);
    let value = snapshot(&db);
    assert_eq!(value["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(value["tasks"].as_array().unwrap().len(), 1);
    let history = &value["tasks"][0]["history"];
    assert_eq!(history["result"]["summary"], "实际结果");
    assert_eq!(history["steps"][0]["outcome"], "committed");
    assert_eq!(
        history["sources"][0]["url"],
        "https://source.example/read?id=1"
    );
    assert!(history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["content"] == "保留玩家分支"));
    assert!(history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["content"] == "实际结果"));
    let text = value.to_string();
    for forbidden in [
        PRIVATE,
        "UNFINISHED",
        "HIDDEN-THINKING",
        "INTERNAL-NONCE",
        "executable-session",
        "URL-SECRET",
        "PRIVATE-FRAGMENT",
        "legacy",
        "Authorization",
        "base_json",
        "pi_calls",
        "readBack",
        "workspace_json",
        "lease_json",
    ] {
        assert!(!text.contains(forbidden), "unexpected {forbidden}");
    }
    assert!(value["tasks"][0]["history"]["steps"][0]
        .get("read")
        .is_none());
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM story_recovery_points", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        1
    );
}

#[test]
fn validation_rebuilds_whitelists_and_rejects_foreign_or_executable_records() {
    let mut db = Connection::open_in_memory().unwrap();
    fixture(&mut db);
    let original = snapshot(&db);
    for variant in 0..5 {
        let mut broken = original.clone();
        match variant {
            0 => broken["sessions"][0]["worldId"] = "another-world".into(),
            1 => broken["sessions"][0]["lineId"] = "another-line".into(),
            2 => broken["tasks"][0]["sessionId"] = "another-session".into(),
            3 => broken["tasks"][0]["status"] = "running".into(),
            _ => broken["readOnly"] = false.into(),
        }
        assert!(validate_readable(&broken, "world", &["line".into()]).is_err());
    }
    let mut extra = original;
    extra["apiKey"] = PRIVATE.into();
    extra["sessions"][0]["session_file"] = PRIVATE.into();
    extra["tasks"][0]["history"]["result"]["model_json"] = PRIVATE.into();
    let clean = validate_readable(&extra, "world", &["line".into()]).unwrap();
    assert!(!clean.to_string().contains(PRIVATE));
}

#[test]
fn reexports_archived_history_without_restoring_executable_events_or_changing_task_identity() {
    let mut db = Connection::open_in_memory().unwrap();
    fixture(&mut db);
    let initial = snapshot(&db);
    let mut saved = initial["tasks"][0]["history"].clone();
    saved["apiKey"] = PRIVATE.into();
    saved["result"]["workspace_json"] = PRIVATE.into();
    db.execute_batch(
        "PRAGMA query_only=OFF;DELETE FROM pi_events;DELETE FROM pi_calls;DELETE FROM pi_inputs;",
    )
    .unwrap();
    db.execute(
        "UPDATE pi_tasks SET status='archived',result_json=? WHERE id='finished'",
        [json!({"history":saved,"session_file":PRIVATE}).to_string()],
    )
    .unwrap();
    let again = snapshot(&db);
    assert_eq!(again["tasks"][0]["history"], initial["tasks"][0]["history"]);
    assert_eq!(again["tasks"][0]["id"], "finished");
    assert_eq!(again["tasks"][0]["sessionId"], "session");
    assert_eq!(again["sessions"][0]["lineId"], "line");
    assert_eq!(again["tasks"][0]["text"], "更正设定");
    assert_eq!(again["tasks"][0]["status"], "archived");
    assert!(!again.to_string().contains(PRIVATE));
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM pi_events", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM pi_calls", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn uses_the_existing_wal_snapshot_without_claiming_to_snapshot_the_whole_export() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("isolated.sqlite");
    let mut reader = Connection::open(&path).unwrap();
    fixture(&mut reader);
    reader
        .execute_batch(
            "PRAGMA journal_mode=WAL;PRAGMA query_only=ON;BEGIN;SELECT COUNT(*) FROM worlds",
        )
        .unwrap();
    let writer = Connection::open(&path).unwrap();
    writer
        .execute(
            "UPDATE pi_tasks SET result_json=? WHERE id='finished'",
            [json!({"summary":"稍后的结果"}).to_string()],
        )
        .unwrap();
    assert_eq!(
        export_readable(&reader, "world").unwrap()["tasks"][0]["history"]["result"]["summary"],
        "实际结果"
    );
    reader.execute_batch("ROLLBACK;BEGIN").unwrap();
    assert_eq!(
        export_readable(&reader, "world").unwrap()["tasks"][0]["history"]["result"]["summary"],
        "稍后的结果"
    );
    reader.execute_batch("ROLLBACK").unwrap();
}

#[test]
fn formal_export_preserves_external_proof_and_revision_without_device_capabilities() {
    let mut db=Connection::open_in_memory().unwrap();fixture(&mut db);
    db.execute("INSERT INTO source_books VALUES('book','引用原文','txt','test','{\"id\":\"book\",\"sections\":[]}')",[]).unwrap();
    let source=json!({"sourceClaim":"网页记载青桥旧称","contentHash":"sha256:page","readAt":"2026-11-01","revisionDecision":{"summary":"补充地名","reason":"与本局一致","appliesTo":"world_rule","apiKey":PRIVATE},"references":[{"quote":"青桥旧称","sourceKind":"external","location":{"url":format!("https://source.example/read?id=2&token={PRIVATE}#private"),"contentHash":"sha256:page","readAt":"2026-11-01","grantId":PRIVATE}}],"packageCode":PRIVATE});
    db.execute("INSERT INTO story_fact_sources VALUES('proof','world','line','n','state','n','batch','finished','external','地名依据',?,'test')",[source.to_string()]).unwrap();
    db.execute("INSERT INTO agent_capability_grants VALUES('private','file',?,'write',1,1,'test','test')",[json!({"uri":PRIVATE}).to_string()]).unwrap();
    let store=story_core::Store(std::sync::Arc::new(std::sync::Mutex::new(db)));
    let archive=story_core::world_archive::export(&store,"world").unwrap();
    assert_eq!(archive["version"],7);
    let evidence:Value=serde_json::from_str(archive["factSources"][0]["source_json"].as_str().unwrap()).unwrap();
    assert_eq!(evidence["sourceClaim"],"网页记载青桥旧称");assert_eq!(evidence["revisionDecision"]["summary"],"补充地名");
    assert_eq!(evidence["references"][0]["location"]["url"],"https://source.example/read?id=2");
    assert_eq!(evidence["references"][0]["location"]["contentHash"],"sha256:page");
    assert!(!archive.to_string().contains(PRIVATE));assert!(archive.get("agent_capability_grants").is_none());
}
