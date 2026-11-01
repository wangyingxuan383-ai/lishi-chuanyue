//! Two independent SQLite connections represent the UI and Agent processes.
//! No user database, network service or model request is used here.
use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::json;
use std::{
    sync::{Arc, Barrier, Mutex},
    time::Duration,
};
use story_core::{
    chat::{BoxFuture, Completion, Model, TextSink},
    execution_lease as lease,
    runtime::Engine,
    Error, ModelConfig, Result, RunBudget, RunPlan, Store,
};
use tokio_util::sync::CancellationToken;

fn database(path: &std::path::Path) -> Connection {
    let mut db = Connection::open(path).unwrap();
    db.busy_timeout(Duration::from_secs(3)).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .unwrap();
    story_core::migration::migrate(&mut db, None).unwrap();
    db
}

#[test]
fn competing_connections_have_one_owner() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lease.sqlite");
    let first = database(&path);
    drop(first);
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|index| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut db = Connection::open(path).unwrap();
                db.busy_timeout(Duration::from_secs(3)).unwrap();
                barrier.wait();
                let tx = db
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .unwrap();
                let result = lease::acquire_tx(
                    &tx,
                    "world",
                    &format!("run-{index}"),
                    &format!("process-{index}"),
                    1_000,
                    500,
                );
                if result.is_ok() {
                    tx.commit().unwrap();
                }
                result.is_ok()
            })
        })
        .collect();
    assert_eq!(
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|won| *won)
            .count(),
        1
    );
}

#[test]
fn takeover_fences_former_commit_heartbeat_and_release() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lease.sqlite");
    let mut first = database(&path);
    first
        .execute_batch(
            "CREATE TABLE effect(value TEXT NOT NULL); INSERT INTO effect VALUES('before');",
        )
        .unwrap();
    let mut second = Connection::open(path).unwrap();
    second.busy_timeout(Duration::from_secs(3)).unwrap();
    let tx = first
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let former = lease::acquire_tx(&tx, "world", "same-task", "old-process", 1_000, 500).unwrap();
    tx.commit().unwrap();
    let tx = second
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    assert!(lease::acquire_tx(&tx, "world", "same-task", "new-process", 1_100, 500).is_err());
    drop(tx);
    let tx = second
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let next = lease::acquire_tx(&tx, "world", "same-task", "new-process", 1_501, 500).unwrap();
    tx.commit().unwrap();
    assert!(next.fence > former.fence);
    let tx = first
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let write = lease::guard(&tx, &former, 1_502).and_then(|_| {
        tx.execute("UPDATE effect SET value='wrong'", [])?;
        Ok(())
    });
    assert!(matches!(write, Err(Error::Stale)));
    assert!(matches!(
        lease::heartbeat_tx(&tx, &former, 1_502, 500),
        Err(Error::Stale)
    ));
    assert!(matches!(lease::release_tx(&tx, &former), Err(Error::Stale)));
    drop(tx);
    assert_eq!(
        second
            .query_row("SELECT value FROM effect", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "before"
    );
    lease::guard(&second, &next, 1_502).unwrap();
    let tx = second
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    lease::heartbeat_tx(&tx, &next, 1_900, 500).unwrap();
    tx.commit().unwrap();
    lease::guard(&first, &next, 2_100).unwrap();
    let tx = second
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    lease::release_tx(&tx, &next).unwrap();
    let after = lease::acquire_tx(&tx, "world", "other-task", "new-process", 2_101, 500).unwrap();
    tx.commit().unwrap();
    assert!(after.fence > next.fence);
    assert!(lease::guard(&first, &next, 2_102).is_err());
}

fn plan(id: &str, world: &str) -> RunPlan {
    serde_json::from_value(json!({
        "id":id,"worldId":world,"lineId":"line","headId":"n0","baseId":"n0","kind":"turn",
        "model":{"slot":"test","url":"https://unused.invalid","model":"unused","auxModel":null,"includeUsage":false,"maxTokens":null,"extra":{}},
        "messages":[],"extractMessages":[],"state":{},"settings":{},"options":{},"action":{},"meta":{}
    })).unwrap()
}

#[test]
fn spectator_children_share_root_ownership_without_unlocking_story() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lease.sqlite");
    let db = database(&path);
    db.execute("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('world','test','','line','{}','t','t','t')",[]).unwrap();
    db.execute("INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n0','world',0,'opening','','t')",[]).unwrap();
    db.execute(
        "INSERT INTO states(node_id,state_json) VALUES('n0','{}')",
        [],
    )
    .unwrap();
    db.execute("INSERT INTO lines(id,world_id,name,node_id,kind,created_at) VALUES('line','world','test','n0','line','t')",[]).unwrap();
    let store = Store(Arc::new(Mutex::new(db)));
    let mut parent = plan("parent", "world");
    parent.kind = "autoplay".into();
    store.register(&parent).unwrap();
    // Resuming a root is different from borrowing it for spectator children.
    // A second Engine in the same process may not reuse the live root lease.
    assert!(store.resume("parent").is_err());
    let parent = store.plan("parent").unwrap();
    let root = lease::ticket(&parent).unwrap().unwrap();
    let mut child = parent.clone();
    child.id = "child-1".into();
    child.kind = "turn".into();
    child.meta["parentRun"] = "parent".into();
    store.register(&child).unwrap();
    assert_eq!(
        lease::ticket(&store.plan("child-1").unwrap())
            .unwrap()
            .unwrap(),
        root
    );
    store.finish("child-1", "committed", None).unwrap();
    child.id = "child-2".into();
    store.register(&child).unwrap();
    assert_eq!(
        lease::ticket(&store.plan("child-2").unwrap())
            .unwrap()
            .unwrap(),
        root
    );
    let mut other = Connection::open(path).unwrap();
    let tx = other
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    assert!(lease::acquire_tx(
        &tx,
        "world",
        "pi-task",
        "agent-process",
        lease::now_ms(),
        lease::DEFAULT_TTL_MS
    )
    .is_err());
}

struct NoModel;
impl Model for NoModel {
    fn complete(
        &self,
        _: ModelConfig,
        _: serde_json::Value,
        _: CancellationToken,
        _: TextSink,
    ) -> BoxFuture<Result<Completion>> {
        Box::pin(async { panic!("recovery must not request a model") })
    }
}

#[test]
fn new_process_recovery_preserves_other_live_story_owner() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lease.sqlite");
    let mut db = database(&path);
    let now = lease::now_ms();
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    lease::acquire_tx(
        &tx,
        "live",
        "pi-task",
        "agent-process",
        now,
        lease::DEFAULT_TTL_MS,
    )
    .unwrap();
    lease::acquire_tx(
        &tx,
        "expired",
        "old-run",
        "dead-process",
        now - 100_000,
        1_000,
    )
    .unwrap();
    for (id, world) in [("live-legacy-run", "live"), ("expired-run", "expired")] {
        tx.execute("INSERT INTO execution_runs(id,world_id,line_id,base_head_id,status,plan_json,budget_json,draft_json,created_at,updated_at) VALUES(?,?,'line','n0','running',?,?,'{}','t','t')",params![id,world,serde_json::to_string(&plan(id,world)).unwrap(),serde_json::to_string(&RunBudget::default()).unwrap()]).unwrap();
    }
    tx.commit().unwrap();
    let store = Store(Arc::new(Mutex::new(db)));
    let engine = Engine::new(
        store.clone(),
        Arc::new(NoModel),
        Arc::new(|_| Box::new(())),
        Arc::new(|_| {}),
    );
    engine.recover_on_start().unwrap();
    assert_eq!(
        store.snapshot("live-legacy-run", 0).unwrap().status,
        "running"
    );
    assert_eq!(
        store.snapshot("expired-run", 0).unwrap().status,
        "interrupted"
    );
    // Resume cannot first mutate the other owner's running row.
    assert!(store.resume("live-legacy-run").is_err());
    assert_eq!(
        store.snapshot("live-legacy-run", 0).unwrap().status,
        "running"
    );
}
