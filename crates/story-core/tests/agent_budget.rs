//! Token units, task-local calibration and optional root limits. Mock model
//! only: no HTTP, device, secrets or personal story data.
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use story_core::{
    agent_budget,
    chat::{BoxFuture, Completion, Model, TextSink},
    runtime::Engine,
    Error, ModelConfig, Result, RunSnapshot, Store,
};
use tokio_util::sync::CancellationToken;

struct BudgetModel {
    calls: AtomicU32,
    requests: Mutex<Vec<Value>>,
}
impl Model for BudgetModel {
    fn complete(
        &self,
        _: ModelConfig,
        body: Value,
        _: CancellationToken,
        _: TextSink,
    ) -> BoxFuture<Result<Completion>> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        self.requests.lock().unwrap().push(body.clone());
        if call == 2 {
            return Box::pin(std::future::ready(Err(Error::Invalid(
                "独立模拟断点".into(),
            ))));
        }
        let usage = Some(
            json!({"prompt_tokens":(agent_budget::request_units(&body)/3).max(1),"completion_tokens":10}),
        );
        let reply = if call >= 35 {
            Completion {
                text: "只读预算检查完成，没有改变故事。".into(),
                usage,
                ..Default::default()
            }
        } else {
            Completion {
                tool_calls: vec![
                    json!({"id":format!("budget-{call}"),"type":"function","function":{"name":"read_resource","arguments":json!({"kind":"settings","path":"/premise","offset":if call==1 {0}else{50000+call},"limit":24000}).to_string()}}),
                ],
                usage,
                ..Default::default()
            }
        };
        Box::pin(std::future::ready(Ok(reply)))
    }
}

async fn settled(engine: &Engine, id: &str) -> RunSnapshot {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = engine.snapshot(id, 0).unwrap();
            if !["running", "committing"].contains(&snapshot.status.as_str()) {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn default_475k_token_task_calibrates_survives_resume_and_passes_thirty_requests_without_a_cap(
) {
    let mut db = Connection::open_in_memory().unwrap();
    story_core::migration::migrate(&mut db, None).unwrap();
    let store = Store(Arc::new(Mutex::new(db)));
    store.initialize().unwrap();
    let state = json!({"version":2,"time":{"start":"第一天","elapsedMinutes":0,"startHour":8},"protagonist":{"name":"预算旅人","age":20,"stats":{"money":10,"debt":0,"health":100,"energy":100,"fame":0},"items":[],"statuses":[]},"people":[],"places":[],"cards":[],"goals":[],"facts":[],"deviations":[],"era":{"mode":"free","clockStyle":"elapsed"}});
    {
        let db = store.lock().unwrap();
        db.execute("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('w','独立预算检查','free','l',?,'test','test','test')",[json!({"mode":"free","premise":"本局资料。".repeat(4000)}).to_string()]).unwrap();
        db.execute("INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,record_json,created_at) VALUES('n','w',NULL,0,'opening','开场','{}','test')",[]).unwrap();
        db.execute("INSERT INTO states VALUES('n',?)", [state.to_string()])
            .unwrap();
        db.execute("INSERT INTO lines(id,world_id,name,node_id,kind,created_at) VALUES('l','w','主线','n','line','test')",[]).unwrap();
        db.execute(
            "INSERT INTO settings VALUES('tokenRatio:budget-model','0.5')",
            [],
        )
        .unwrap();
    }
    let model = Arc::new(BudgetModel {
        calls: AtomicU32::new(0),
        requests: Mutex::new(vec![]),
    });
    let engine = Arc::new(Engine::new(
        store.clone(),
        model.clone(),
        Arc::new(|_| Box::new(())),
        Arc::new(|_| {}),
    ));
    let session = engine
        .agent(json!({"op":"create","worldId":"w","lineId":"l"}))
        .unwrap();
    let started=engine.agent(json!({"op":"start","sessionId":session["id"],"text":"只读取资料检验任务预算，不修改本局。","model":{"slot":"no-secret","url":"https://fixture.invalid","model":"budget-model","contextTokens":12000,"includeUsage":true}})).unwrap();
    let run = started["runId"].as_str().unwrap();
    let failed = settled(&engine, run).await;
    assert_eq!(failed.status, "failed");
    assert_eq!(failed.budget.model_requests, 2);
    assert_eq!(failed.draft["tokenEstimate"]["samples"], 1);
    let plan = store.plan(run).unwrap();
    assert_eq!(
        plan.options["contextTokens"], 475000,
        "ordinary model budget must not become the Agent default"
    );
    assert_eq!(
        plan.meta["agent"]["limits"],
        json!({"modelRequests":0,"toolCalls":0,"activeMs":0})
    );
    assert_eq!(
        model.calls.load(Ordering::SeqCst),
        2,
        "paused work never restarts by itself"
    );
    engine
        .agent(json!({"op":"continue","taskId":started["taskId"]}))
        .unwrap();
    let complete = settled(&engine, run).await;
    assert_eq!(complete.status, "committed", "{:?}", complete.error);
    assert_eq!(
        complete.budget.model_requests, 35,
        "resume retains cumulative requests; default no longer ends at thirty"
    );
    assert_eq!(complete.draft["tokenEstimate"]["samples"], 34);
    assert!(
        model.requests.lock().unwrap()[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| {
                m["role"] == "tool"
                    && serde_json::from_str::<Value>(m["content"].as_str().unwrap_or(""))
                        .ok()
                        .and_then(|v| v["text"].as_str().map(|s| s.encode_utf16().count()))
                        .is_some_and(|n| n > 12000)
            }),
        "a large source page must actually reach the model without the old result cap"
    );
    assert!(
        model
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| agent_budget::request_units(r) > 12000),
        "large results are not pinned to the old twelve-thousand-character budget"
    );
    let session = engine
        .agent(json!({"op":"session","id":session["id"]}))
        .unwrap();
    assert_eq!(
        session["tasks"][0]["inputBudget"]["requestedTokens"],
        475000
    );
    assert_eq!(session["tasks"][0]["inputBudget"]["calibrated"], true);
    assert!(
        session["tasks"][0]["inputBudget"]["estimatedChars"]
            .as_u64()
            .unwrap()
            > 475000
    );
    let db = store.lock().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT value FROM settings WHERE key='tokenRatio:budget-model'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "0.5",
        "task estimation must not overwrite ordinary play settings"
    );
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM nodes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    let recorded: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM usage WHERE prompt_tokens IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(recorded, 34);
}
