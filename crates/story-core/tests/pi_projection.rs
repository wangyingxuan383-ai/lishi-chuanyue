//! Fixed Pi SDK event fixtures only. This test does not create a runtime,
//! contact a model, open SQLite or inspect a player's conversation.
use serde_json::{json, Value};
use story_core::pi_projection::{messages, persistable_event, steps, MAX_MESSAGES, MAX_TEXT_CHARS};

fn task() -> Value {
    json!({"id":"task","session_id":"session","text":"核对人物关系，保留玩家的改写","created_at":"2026-10-29T15:00:00+08:00"})
}

#[test]
fn persistent_projection_discards_hidden_payloads_and_keeps_exact_user_nonce_text() {
    let original = format!(
        "【本次补充标识 owned-id:owned-nonce】\n{}",
        "保留🙂".repeat(24_990)
    );
    let user = event(
        1,
        message(
            "message_start",
            "user",
            1,
            json!([{"type":"text","text":original,"signature":"SECRET_USER_SIGNATURE"}]),
        ),
    );
    let clean = persistable_event(&user).unwrap();
    assert_eq!(
        persistable_event(&user["event"]).unwrap(),
        clean["event"],
        "native envelope and SQLite wrapper retain the same consumption record"
    );
    assert_eq!(
        clean["event"]["event"]["message"]["content"][0]["text"],
        original
    );
    assert!(!clean.to_string().contains("SECRET_USER_SIGNATURE"));
    let update = event(
        2,
        json!({"type":"message_update","message":{"role":"assistant","timestamp":2,"content":[{"type":"text","text":"先查原著"},{"type":"thinking","thinking":"SECRET_THINKING","signature":"SECRET_SIGNATURE"}],"rawProvider":{"authorization":"SECRET_AUTH"}},"assistantMessageEvent":{"type":"thinking_delta","delta":"SECRET_THINKING"}}),
    );
    assert!(
        persistable_event(&update).is_none(),
        "thinking tokens do not persist the previous visible snapshot repeatedly"
    );
    let end = event(
        3,
        json!({"type":"message_end","message":{"role":"assistant","timestamp":2,"content":[{"type":"text","text":"先查原著"},{"type":"thinking","thinking":"SECRET_THINKING"}],"signature":"SECRET_SIGNATURE","rawProvider":{"authorization":"SECRET_AUTH"},"stopReason":"toolUse","usage":{"input":12,"output":5,"reasoning":3,"totalTokens":17,"cost":{"input":0.1,"output":0.2,"total":0.3,"secret":"SECRET_COST"},"raw":"SECRET_USAGE"}}}),
    );
    let clean = persistable_event(&end).unwrap();
    assert_eq!(
        clean["event"]["event"]["message"]["content"],
        json!([{"type":"text","text":"先查原著"}])
    );
    assert_eq!(
        clean["event"]["event"]["message"]["usage"]["totalTokens"],
        17
    );
    assert_eq!(
        clean["event"]["event"]["message"]["usage"]["cost"]["total"],
        0.3
    );
    assert!(!clean.to_string().contains("SECRET"));
    assert!(persistable_event(&event(
        4,
        json!({"type":"unknown_extension","authorization":"SECRET_KEY","payload":"SECRET_PAYLOAD"})
    ))
    .is_none());
    let compaction=persistable_event(&event(5,json!({"type":"compaction_end","reason":"threshold","willRetry":true,"aborted":false,"result":{"summary":"SECRET_SUMMARY","tokensBefore":900,"firstKeptEntryId":"entry-1","usage":{"input":90,"output":20,"raw":"SECRET_USAGE"}},"errorMessage":"SECRET_PROVIDER_ERROR"}))).unwrap();
    assert_eq!(compaction["event"]["event"]["result"]["tokensBefore"], 900);
    assert!(!compaction.to_string().contains("SECRET"));
    assert!(persistable_event(&event(6,message("message_start","user",6,json!([{"type":"text","text":"a".repeat(100_513)}])))).is_none(),"out-of-contract input is rejected, never silently truncated into a different nonce message");
}

#[test]
fn persistent_tool_end_is_small_failed_and_points_at_the_authoritative_call() {
    let start=persistable_event(&tool(1,"owned-call","search_original","tool_execution_start",json!({"query":"青铜钥匙","apiKey":"SECRET_KEY","source":"SECRET_SCRIPT_SOURCE","input":{"token":"SECRET_TOKEN"}}),Value::Null)).unwrap();
    assert_eq!(start["event"]["event"]["args"]["query"], "青铜钥匙");
    assert!(!start.to_string().contains("SECRET"));
    let source = tool(
        1,
        "owned-call",
        "read_original",
        "tool_execution_end",
        json!({"query":"青铜钥匙","apiKey":"SECRET_KEY"}),
        json!({"details":{"ok":false,"error":{"code":"outside_scope","message":"SECRET_PROVIDER_REFLECTION"},"rawProvider":"SECRET_RAW","data":{"full":"SECRET_BODY"}},"content":[{"type":"text","text":"SECRET_DUPLICATED_RESULT"}],"thinking":"SECRET_TOOL_THINKING"}),
    );
    let clean = persistable_event(&source).unwrap();
    assert!(!clean.to_string().contains("SECRET"));
    assert_eq!(clean["event"]["event"]["resultRef"]["callId"], "owned-call");
    assert_eq!(clean["event"]["event"]["result"]["details"]["ok"], false);
    let result = steps(&[clean], &[]);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0]["status"], "failed");
    assert_eq!(result[0]["read"]["callId"], "owned-call");
}

#[test]
fn child_messages_stay_out_of_root_chat_and_steps_keep_parent_attribution() {
    let mut child_text = event(
        1,
        message(
            "message_start",
            "assistant",
            1,
            json!([{"type":"text","text":"CHILD_REPLY_NOT_ROOT_DIALOGUE"},{"type":"thinking","thinking":"SECRET_CHILD_THINKING"}]),
        ),
    );
    child_text["event"]["childId"] = "child-1".into();
    child_text["event"]["parentCallId"] = "delegate-1".into();
    let mut child_tool = tool(
        2,
        "child-1-canonical",
        "read_original",
        "tool_execution_end",
        json!({}),
        json!({"details":{"ok":true,"data":{"status":"ready","excerpts":[{"text":"SECRET_DUPLICATED_ORIGINAL"}]}}}),
    );
    child_tool["event"]["childId"] = "child-1".into();
    child_tool["event"]["parentCallId"] = "delegate-1".into();
    let clean = vec![
        persistable_event(&child_text).unwrap(),
        persistable_event(&child_tool).unwrap(),
    ];
    assert!(clean
        .iter()
        .all(|e| e["event"]["childId"] == "child-1" && e["event"]["parentCallId"] == "delegate-1"));
    let dialogue = messages(&task(), &clean, &[]);
    assert_eq!(dialogue.len(), 1);
    assert!(!serde_json::to_string(&dialogue)
        .unwrap()
        .contains("CHILD_REPLY"));
    let process = steps(&clean, &[]);
    assert_eq!(process.len(), 1);
    assert_eq!(process[0]["childId"], "child-1");
    assert_eq!(process[0]["parentCallId"], "delegate-1");
    assert_eq!(process[0]["callId"], "child-1-canonical");
    assert!(!serde_json::to_string(&process).unwrap().contains("SECRET"));
}
fn event(seq: u64, value: Value) -> Value {
    json!({"seq":seq,"event":{"sessionId":"pi-session","taskId":"task","event":value}})
}
fn message(kind: &str, role: &str, timestamp: i64, content: Value) -> Value {
    json!({"type":kind,"message":{"role":role,"timestamp":timestamp,"content":content}})
}
fn tool(seq: u64, id: &str, name: &str, kind: &str, args: Value, result: Value) -> Value {
    event(
        seq,
        json!({"type":kind,"toolCallId":id,"toolName":name,"args":args,"result":result,"partialResult":{"thinking":"SECRET_PARTIAL_TOOL_THINKING"},"isError":false,"durationMs":10}),
    )
}
fn call(id: &str, name: &str, result: Value) -> Value {
    json!({"task_id":"task","call_id":id,"tool":name,"status":"done","output_json":result.to_string()})
}

#[test]
fn dialogue_keeps_intermediate_text_and_deduplicates_goal_supplements_and_tool_messages() {
    let target = task();
    let inputs = vec![
        json!({"id":"supp","task_id":"task","delivery":"steer","status":"delivered","content_json":json!({"text":"不要修改参考书","nonce":"owned-nonce"}).to_string(),"created_at":"2026-10-29T15:01:00+08:00"}),
        json!({"id":"pending","taskId":"task","delivery":"steer","status":"pending","text":"只改已经确认的部分","createdAt":"2026-10-29T15:02:00+08:00"}),
        json!({"id":"other","taskId":"other-task","text":"SECRET_OTHER_TASK_INPUT"}),
    ];
    let trace = vec![
        event(
            1,
            message(
                "message_start",
                "user",
                1,
                json!([{"type":"text","text":target["text"]}]),
            ),
        ),
        event(
            2,
            message(
                "message_end",
                "user",
                1,
                json!([{"type":"text","text":target["text"]}]),
            ),
        ),
        event(
            3,
            message(
                "message_start",
                "assistant",
                2,
                json!([{"type":"thinking","thinking":"SECRET_ASSISTANT_THINKING"}]),
            ),
        ),
        event(
            4,
            json!({"type":"message_update","message":{"role":"assistant","timestamp":2,"content":[{"type":"thinking","thinking":"SECRET_ASSISTANT_THINKING"},{"type":"text","text":"先查原著，再检查本局改变。"}]},"assistantMessageEvent":{"type":"thinking_delta","delta":"SECRET_THINKING_DELTA"}}),
        ),
        // An empty error/end snapshot must not erase text already shown.
        event(5, message("message_end", "assistant", 2, json!([]))),
        tool(
            6,
            "book",
            "read_original",
            "tool_execution_end",
            json!({}),
            json!({"details":{"ok":true,"data":{"excerpts":[{"text":"SECRET_TOOL_BODY_IN_CHAT"}]}}}),
        ),
        event(
            7,
            message(
                "message_start",
                "toolResult",
                3,
                json!([{"type":"text","text":"SECRET_TOOL_BODY_IN_CHAT"}]),
            ),
        ),
        event(
            8,
            message(
                "message_start",
                "user",
                4,
                json!([{"type":"text","text":"【本次补充标识 supp:owned-nonce】\n不要修改参考书"}]),
            ),
        ),
        event(
            9,
            message(
                "message_end",
                "user",
                4,
                json!([{"type":"text","text":"【本次补充标识 supp:owned-nonce】\n不要修改参考书"}]),
            ),
        ),
        event(
            10,
            message(
                "message_start",
                "assistant",
                5,
                json!([{"type":"text","text":"已按原文核对，本局主动分支保留。"}]),
            ),
        ),
        event(
            11,
            message(
                "message_end",
                "assistant",
                5,
                json!([{"type":"text","text":"已按原文核对，本局主动分支保留。"}]),
            ),
        ),
        // A recovered execution replays the original target internally.
        event(
            12,
            message(
                "message_start",
                "user",
                6,
                json!([{"type":"text","text":target["text"]}]),
            ),
        ),
        event(
            13,
            message(
                "message_start",
                "assistant",
                7,
                json!([{"type":"thinking","thinking":"SECRET_THINKING_ONLY"}]),
            ),
        ),
        event(
            14,
            message(
                "message_end",
                "assistant",
                7,
                json!([{"type":"thinking","thinking":"SECRET_THINKING_ONLY"}]),
            ),
        ),
    ];
    let projected = messages(&target, &trace, &inputs);
    assert_eq!(
        projected
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["user", "assistant", "user", "assistant", "user"]
    );
    assert_eq!(projected[1]["content"], "先查原著，再检查本局改变。");
    assert_eq!(projected[2]["id"], "task:input:supp");
    assert_eq!(projected[2]["content"], "不要修改参考书");
    assert_eq!(projected[4]["status"], "pending");
    assert!(!serde_json::to_string(&projected)
        .unwrap()
        .contains("SECRET"));
    assert!(!serde_json::to_string(&projected)
        .unwrap()
        .contains("owned-nonce"));
    assert_eq!(
        projected,
        messages(&target, &trace, &inputs),
        "reconstruction is deterministic"
    );
}

#[test]
fn full_stream_snapshots_keep_a_stable_id_without_duplicating_deltas() {
    let target = task();
    let mut trace = vec![
        event(1, message("message_start", "assistant", 100, json!([]))),
        event(
            2,
            message(
                "message_update",
                "assistant",
                100,
                json!([{"type":"text","text":"开始核对"}]),
            ),
        ),
    ];
    let first = messages(&target, &trace, &[]);
    trace.push(event(3,message("message_update","assistant",100,json!([{"type":"text","text":"开始核对人物关系"},{"type":"reasoning","text":"SECRET_REASONING"}]))));
    trace.push(event(
        4,
        message(
            "message_end",
            "assistant",
            100,
            json!([{"type":"text","text":"开始核对人物关系，正在读取。"}]),
        ),
    ));
    let complete = messages(&target, &trace, &[]);
    assert_eq!(first[1]["id"], complete[1]["id"]);
    assert_eq!(complete[1]["content"], "开始核对人物关系，正在读取。");
    assert_eq!(complete[1]["status"], "completed");
    assert!(!complete[1]["content"]
        .as_str()
        .unwrap()
        .contains("开始核对开始核对"));
}

#[test]
fn tool_rows_merge_attempts_and_report_actual_business_outcomes() {
    let mut trace = vec![
        tool(
            1,
            "clock",
            "stage_clock",
            "tool_execution_start",
            json!({"path":"纪年","apiKey":"SECRET_KEY"}),
            Value::Null,
        ),
        event(
            2,
            json!({"type":"tool_execution_update","toolCallId":"clock","toolName":"stage_clock","partialResult":{"thinking":"SECRET_PARTIAL","text":"完成"}}),
        ),
        tool(
            3,
            "clock",
            "stage_clock",
            "tool_execution_end",
            json!({}),
            json!({"details":{"ok":true,"data":{"staged":true}}}),
        ),
        tool(
            4,
            "clock",
            "stage_clock",
            "tool_execution_start",
            json!({"path":"纪年"}),
            Value::Null,
        ),
        tool(
            5,
            "clock",
            "stage_clock",
            "tool_execution_end",
            json!({}),
            json!({"details":{"ok":true,"data":{"staged":true}}}),
        ),
        tool(
            6,
            "stage",
            "stage_edit",
            "tool_execution_end",
            json!({"kind":"settings","path":"/premise"}),
            json!({"details":{"ok":true,"data":{"staged":true}}}),
        ),
        tool(
            7,
            "search",
            "search_original",
            "tool_execution_end",
            json!({"query":"大赛规则"}),
            json!({"details":{"ok":true,"data":{"status":"insufficient","reason":"no_match","excerpts":[]}}}),
        ),
        tool(
            8,
            "nothing",
            "finish_task",
            "tool_execution_end",
            json!({}),
            json!({"content":[{"type":"text","text":json!({"ok":true,"data":{"status":"answered","changed":false}}).to_string()}]}),
        ),
        tool(
            9,
            "commit",
            "finish_task",
            "tool_execution_end",
            json!({}),
            json!({"details":{"ok":true,"data":{"status":"committed","changes":[{},{}]}}}),
        ),
        tool(
            10,
            "read",
            "read_resource",
            "tool_execution_start",
            json!({"kind":"people","Authorization":"SECRET_HEADER"}),
            Value::Null,
        ),
    ];
    trace.push(trace[0].clone()); // Delivery of the same persisted sequence again.
    let calls = vec![
        call(
            "clock",
            "stage_clock",
            json!({"ok":false,"error":{"code":"invalid_date","message":"year=10015 超出范围"}}),
        ),
        call(
            "commit",
            "finish_task",
            json!({"ok":true,"data":{"status":"committed","goalStatus":"partial","goalCompleted":false,"changes":[{},{}]}}),
        ),
        json!({"task_id":"task","call_id":"external","tool":"call_remote_tool","status":"unknown","output_json":json!({"ok":false,"outcomeUnknown":true}).to_string()}),
    ];
    let projected = steps(&trace, &calls);
    assert_eq!(projected.len(), 7);
    let find = |id: &str| projected.iter().find(|s| s["callId"] == id).unwrap();
    assert_eq!(
        find("clock")["status"],
        "failed",
        "a generic tool-end success cannot override the actual business failure"
    );
    assert_eq!(find("clock")["attempts"], 2);
    assert!(find("clock")["summary"]
        .as_str()
        .unwrap()
        .contains("year=10015"));
    assert_eq!(find("stage")["outcome"], "draft");
    assert!(find("stage")["summary"]
        .as_str()
        .unwrap()
        .contains("尚未采用"));
    assert_eq!(find("search")["outcome"], "no_match");
    assert!(find("search")["summary"]
        .as_str()
        .unwrap()
        .contains("大赛规则"));
    assert_eq!(find("nothing")["outcome"], "answered");
    assert_eq!(find("commit")["outcome"], "committed");
    assert!(find("commit")["summary"]
        .as_str()
        .unwrap()
        .contains("已采用2项"));
    assert!(find("commit")["summary"].as_str().unwrap().contains("仍有目标未完成"));
    assert_eq!(find("external")["status"], "unknown");
    assert_eq!(find("read")["status"], "running");
    assert!(!serde_json::to_string(&projected)
        .unwrap()
        .contains("SECRET"));
    assert_eq!(steps(&trace, &calls), projected);
}

#[test]
fn long_dialogue_is_bounded_and_other_task_events_do_not_enter_it() {
    let mut target = task();
    target["text"] = "长要求".repeat(MAX_TEXT_CHARS).into();
    let mut trace = vec![
        event(
            1,
            message(
                "message_start",
                "user",
                1,
                json!([{"type":"text","text":target["text"]}]),
            ),
        ),
        json!({"seq":2,"event":{"taskId":"other-task","event":{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"SECRET_OTHER_TASK"}]}}}}),
    ];
    for index in 0..MAX_MESSAGES + 20 {
        trace.push(event(
            index as u64 + 3,
            message(
                "message_end",
                "assistant",
                index as i64 + 2,
                json!([{"type":"text","text":format!("第{index}条中途说明")}]),
            ),
        ));
    }
    let projected = messages(&target, &trace, &[]);
    assert!(projected.len() <= MAX_MESSAGES);
    assert_eq!(projected[0]["id"], "task:user");
    assert_eq!(projected[0]["truncated"], true);
    assert_eq!(projected[0]["projectionTruncated"], true);
    assert!(projected
        .iter()
        .all(|m| m["content"].as_str().unwrap().chars().count() <= MAX_TEXT_CHARS));
    assert!(!serde_json::to_string(&projected)
        .unwrap()
        .contains("SECRET"));
}
