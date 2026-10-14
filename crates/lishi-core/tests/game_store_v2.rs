use std::{
    fs::File,
    io::Write,
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Barrier},
    time::{Duration, Instant},
};

use lishi_core::{
    game_memory::{MemoryIndex, MemoryKnownIdentity, MemoryQuery, MemoryScope},
    game_migration::upgrade_v1,
    game_protocol::{initial_state, Choice, WorldSetup},
    game_protocol_v2::{
        apply_output_v2, initial_state_v2, CommitContext, Disclosure, EventInput, StateChangeV2,
        StateSource, TimeAdvanceV2, TurnOutputV2,
    },
    game_store::{GameActionKind, GameOperationStatus, GameStore, GameStoreError, GameTurnRequest},
    game_store_v2::{GameStoreV2, WorldViewV2, RECENT_TURN_LIMIT},
};

const WORLD: &str = "schema-two-fixed-world";
const BASE: &str = "schema-two-baseline";
const NEXT: &str = "schema-two-next-turn";

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: WORLD.into(),
        title: "长期中文世界🙂".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "李明".into(),
        narrative_style: "事实与人物认知分开".into(),
    }
}

/// Source fixture writes the same validated protocol records into an isolated
/// owned database in one transaction, avoiding 300 UI-window reloads. The
/// subsequent StoreV2 open/read still fully audits every operation and state.
fn make_three_hundred_v2(path: &Path) {
    let store = create(path);
    drop(store);
    let mut db = rusqlite::Connection::open(path).unwrap();
    let tx = db.transaction().unwrap();
    let mut state = initial_state_v2(&setup()).unwrap();
    let mut head = None;
    for n in 1..=300 {
        let id = format!("memory-persistent-turn-{n:04}");
        let mut story = output(&format!("persistent-event-{n:04}"), 100);
        story.state_changes.clear();
        story.narrative = if n == 5 {
            "李明留下早期不可丢失的原文线索。".into()
        } else {
            format!("李明完成固定持久回合{n}。")
        };
        let next_state = apply_output_v2(
            &state,
            &story,
            &CommitContext {
                operation_id: id.clone(),
                turn_id: id.clone(),
            },
        )
        .unwrap();
        tx.execute("INSERT INTO game_operations(operation_id,expected_head_turn_id,action_kind,action_text,status,created_at_ms) VALUES (?1,?2,'action','固定300局','committed',?3)", rusqlite::params![id, head, n]).unwrap();
        tx.execute("INSERT INTO game_turns(turn_id,parent_turn_id,sequence,action_kind,action_text,narrative,choices,state,output,created_at_ms) VALUES (?1,?2,?3,'action','固定300局',?4,?5,?6,?7,?3)", rusqlite::params![id, head, n, story.narrative, serde_json::to_string(&story.choices).unwrap(), serde_json::to_string(&next_state).unwrap(), serde_json::to_string_pretty(&story).unwrap()]).unwrap();
        state = next_state;
        head = Some(id);
    }
    tx.execute(
        "UPDATE game_world SET current_state=?1,head_turn_id=?2,turn_count=300 WHERE id=1",
        rusqlite::params![serde_json::to_string(&state).unwrap(), head],
    )
    .unwrap();
    tx.commit().unwrap();
}

fn raw_formal_fingerprint(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let db = rusqlite::Connection::open(path).unwrap();
    let mut statement = db
        .prepare("SELECT turn_id,state,output FROM game_turns ORDER BY sequence")
        .unwrap();
    let mut rows = statement.query([]).unwrap();
    let mut hash = Sha256::new();
    while let Some(row) = rows.next().unwrap() {
        for col in 0..3 {
            let value: String = row.get(col).unwrap();
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value.as_bytes());
        }
    }
    format!("{:x}", hash.finalize())
}

#[test]
fn complete_read_and_index_visit_300_records_without_changing_generating_operations_or_raw_json() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("complete-300.sqlite");
    make_three_hundred_v2(&path);
    let store = GameStoreV2::open(&path).unwrap();
    let baseline = store.view().unwrap();
    assert_eq!(baseline.turns.len(), RECENT_TURN_LIMIT);
    store
        .begin(&request(
            "memory-generating-only-attempt",
            baseline.head_turn_id.as_deref(),
        ))
        .unwrap();
    store
        .mark_generating("memory-generating-only-attempt")
        .unwrap();
    let before_view = store.view().unwrap();
    let raw_before = raw_formal_fingerprint(&path);
    let mut visited = 0;
    let full = store
        .visit_committed_turns(|turn, sequence, origin| {
            visited += 1;
            assert_eq!(sequence, visited);
            assert_eq!(origin, "main");
            if visited == 5 {
                assert!(turn.narrative.contains("早期不可丢失"));
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(visited, 300);
    assert_eq!(full.visible_turn_ids.len(), 300);
    assert_eq!(full.state, baseline.state);
    assert_eq!(full.head_turn_id, baseline.head_turn_id);
    let mut index = MemoryIndex::in_memory().unwrap();
    let receipt = store.rebuild_memory_index(&mut index).unwrap();
    assert_eq!(receipt.index.turn_count, 300);
    assert_eq!(receipt.scope, full);
    let q = MemoryQuery {
        query: "早期不可丢失的原文".into(),
        max_results: 8,
        ..Default::default()
    };
    let s = &receipt.scope;
    let page = index
        .retrieve(
            &MemoryScope {
                world_id: &s.setup.world_id,
                branch_id: &s.branch_id,
                head_turn_id: s.head_turn_id.as_deref(),
                visible_turn_ids: &s.visible_turn_ids,
            },
            &q,
            &s.state,
            &[MemoryKnownIdentity {
                entity_id: "player".into(),
                names: vec!["李明".into()],
            }],
        )
        .unwrap();
    assert_eq!(page.fragments.len(), 1);
    assert_eq!(page.fragments[0].source.sequence, 5);
    assert!(page
        .fragments
        .iter()
        .all(|f| f.source.turn_id != "memory-generating-only-attempt"));
    assert_eq!(raw_formal_fingerprint(&path), raw_before);
    assert_eq!(store.view().unwrap(), before_view);
    assert_eq!(
        before_view.latest_operation.unwrap().status,
        GameOperationStatus::Generating
    );
    assert!(matches!(
        GameStoreV2::open(&path),
        Err(GameStoreError::Busy)
    ));
}

#[test]
fn complete_mixed_105_v1_and_new_v2_reader_keeps_original_full_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("complete-mixed.sqlite");
    let backups = dir.path().join("backup");
    std::fs::create_dir(&backups).unwrap();
    make_v1(&path, 105);
    upgrade_v1(&path, &backups).unwrap();
    let store = GameStoreV2::open(&path).unwrap();
    let baseline = store.view().unwrap();
    let current = commit(
        &store,
        &request(NEXT, baseline.head_turn_id.as_deref()),
        &output("mixed-v2-complete", 100),
    );
    let raw_before = raw_formal_fingerprint(&path);
    let mut seen = Vec::new();
    let complete = store
        .visit_committed_turns(|turn, sequence, origin| {
            assert_eq!(turn.state.protocol_version, 2);
            assert_eq!(origin, "main");
            seen.push(turn.turn_id.clone());
            if sequence == 1 {
                assert_eq!(turn.narrative, "原始v1回合0。");
                assert_eq!(turn.state.time.elapsed_seconds, 1);
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(seen.len(), 106);
    assert_eq!(seen.first().unwrap(), "legacy-v1-00000000");
    assert_eq!(seen.last().unwrap(), NEXT);
    assert_eq!(complete.state, current.state);
    let mut index = MemoryIndex::in_memory().unwrap();
    let rebuilt = store.rebuild_memory_index(&mut index).unwrap();
    assert_eq!(rebuilt.scope, complete);
    assert_eq!(rebuilt.index.turn_count, 106);
    let s = &rebuilt.scope;
    let page = index
        .retrieve(
            &MemoryScope {
                world_id: &s.setup.world_id,
                branch_id: "main",
                head_turn_id: s.head_turn_id.as_deref(),
                visible_turn_ids: &s.visible_turn_ids,
            },
            &MemoryQuery {
                query: "原始v1回合0。".into(),
                max_results: 8,
                ..Default::default()
            },
            &s.state,
            &[MemoryKnownIdentity {
                entity_id: "player".into(),
                names: vec!["李明".into()],
            }],
        )
        .unwrap();
    assert_eq!(page.fragments[0].source.sequence, 1);
    assert_eq!(raw_formal_fingerprint(&path), raw_before);
    assert_eq!(store.view().unwrap(), current);
}

#[test]
fn visitor_abort_and_late_source_corruption_do_not_commit_a_partial_rebuilt_cache() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("source-error.sqlite");
    let store = create(&path);
    let a = commit(
        &store,
        &request(BASE, None),
        &output("before-source-error", 100),
    );
    let baseline = commit(
        &store,
        &request(NEXT, a.head_turn_id.as_deref()),
        &output("late-source-error", 99),
    );
    let mut visited = 0;
    assert_eq!(
        store.visit_committed_turns(|_, _, _| {
            visited += 1;
            Err(GameStoreError::Cancelled)
        }),
        Err(GameStoreError::Cancelled)
    );
    assert_eq!(visited, 1);
    assert_eq!(store.view().unwrap(), baseline);
    let mut index = MemoryIndex::in_memory().unwrap();
    let before = store.rebuild_memory_index(&mut index).unwrap();
    // Owned temporary fixture simulates an external writer bypassing immutable
    // triggers. Read APIs must detect it and must not "repair" formal records.
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("DROP TRIGGER game_turns_no_update; UPDATE game_turns SET output='{\"bad\":true}' WHERE sequence=2; CREATE TRIGGER game_turns_no_update BEFORE UPDATE ON game_turns BEGIN SELECT RAISE(ABORT,'immutable turn'); END;").unwrap();
    drop(db);
    let corrupt_bytes = raw_formal_fingerprint(&path);
    assert_eq!(
        store.rebuild_memory_index(&mut index),
        Err(GameStoreError::Database)
    );
    assert_eq!(raw_formal_fingerprint(&path), corrupt_bytes);
    let s = &before.scope;
    let page = index
        .retrieve(
            &MemoryScope {
                world_id: &s.setup.world_id,
                branch_id: "main",
                head_turn_id: s.head_turn_id.as_deref(),
                visible_turn_ids: &s.visible_turn_ids,
            },
            &MemoryQuery::recent(8),
            &s.state,
            &[MemoryKnownIdentity {
                entity_id: "player".into(),
                names: vec!["李明".into()],
            }],
        )
        .unwrap();
    assert_eq!(page.index_revision, before.index.revision);
    assert_eq!(page.fragments.len(), 2);
    assert!(page.fragments[0].text.contains("late-source-error"));
}

fn request(id: &str, head: Option<&str>) -> GameTurnRequest {
    GameTurnRequest {
        operation_id: id.into(),
        world_id: WORLD.into(),
        branch_id: "main".into(),
        expected_head_turn_id: head.map(str::to_owned),
        action_kind: GameActionKind::Action,
        action_text: "保管钥匙🔑，购买口粮。".into(),
    }
}

fn output(event: &str, expected_cash: i64) -> TurnOutputV2 {
    TurnOutputV2 {
        protocol_version: 2,
        narrative: format!("{event}：中文历史行动🙂。"),
        choices: vec![Choice {
            id: "next".into(),
            text: "继续调查".into(),
        }],
        time_advance: TimeAdvanceV2 {
            elapsed_seconds: 60,
            event_id: Some(event.into()),
        },
        state_changes: vec![StateChangeV2::ChangeResource {
            owner_id: "player".into(),
            key: "cash".into(),
            unit: "记账单位".into(),
            delta: -1,
            expected_amount: Some(expected_cash),
            event_id: event.into(),
        }],
        events: vec![EventInput {
            id: event.into(),
            description: "购买所需补给。".into(),
            entity_ids: vec!["player".into()],
            disclosure: Disclosure::Public,
        }],
        source_references: vec![],
        uncertainties: vec!["固定测试，未进行研究".into()],
    }
}

fn create(path: &Path) -> GameStoreV2 {
    let store = GameStoreV2::open(path).unwrap();
    let setup = setup();
    store
        .create_world_v2(
            &setup,
            &initial_state_v2(&setup).unwrap(),
            "来到咸阳。🔑🙂",
            &[],
        )
        .unwrap();
    store
}

fn stage(store: &GameStoreV2, req: &GameTurnRequest, output: &TurnOutputV2) {
    store.begin(req).unwrap();
    store.mark_generating(&req.operation_id).unwrap();
    store
        .stage_output(&req.operation_id, &serde_json::to_string(output).unwrap())
        .unwrap();
}

fn commit(store: &GameStoreV2, req: &GameTurnRequest, output: &TurnOutputV2) -> WorldViewV2 {
    stage(store, req, output);
    store.commit(&req.operation_id, output).unwrap()
}

#[test]
fn ten_v2_turns_keep_sources_aliases_and_whole_view_on_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("中文v2.sqlite");
    let store = create(&path);
    let mut head = None;
    for n in 0..10 {
        let id = format!("fixed-v2-turn-{n:08}");
        let event = format!("event-{n}");
        let mut story = output(&event, 100 - n);
        if n == 2 {
            story.state_changes.push(StateChangeV2::RenameEntity {
                entity_id: "player".into(),
                expected_name: "李明".into(),
                new_name: "李远".into(),
                event_id: event.clone(),
            });
        }
        let mut req = request(&id, head.as_deref());
        if n % 2 == 1 {
            req.action_kind = GameActionKind::Continue;
            req.action_text.clear();
        }
        let view = commit(&store, &req, &story);
        assert_eq!(view.turn_count, (n + 1) as u64);
        assert_eq!(view.state.resources[0].amount, 99 - n);
        assert!(
            matches!(&view.state.resources[0].last_changed_source, StateSource::Turn { operation_id, turn_id, event_id } if operation_id == &id && turn_id == &id && event_id == &event)
        );
        head = Some(id);
    }
    let final_view = store.view().unwrap();
    assert_eq!(final_view.state.time.era_year, -221);
    let history = store.knowledge_history().unwrap();
    assert_eq!(history.current_state(), &final_view.state);
    assert_eq!(history.turn_count(), 10);
    assert_eq!(final_view.state.time.elapsed_seconds, 600);
    assert_eq!(final_view.state.entities[0].aliases.len(), 1);
    assert_eq!(final_view.state.item_holdings[0].value.quantity, Some(1));
    let db = rusqlite::Connection::open(&path).unwrap();
    assert!(db.execute("UPDATE game_turns SET state='{}'", []).is_err());
    assert!(db.execute("DELETE FROM game_turns", []).is_err());
    assert!(db
        .execute("UPDATE game_operations SET action_text='篡改'", [])
        .is_err());
    assert!(db
        .execute("UPDATE game_world SET initial_state='{}'", [])
        .is_err());
    drop(db);
    drop(store);
    assert_eq!(GameStoreV2::open(path).unwrap().view().unwrap(), final_view);
}

#[test]
fn duplicate_stale_branch_busy_owner_and_illegal_status_do_not_settle_twice() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("reservations.sqlite");
    let store = create(&path);
    assert!(matches!(
        GameStoreV2::open(&path),
        Err(GameStoreError::Busy)
    ));
    let baseline = commit(&store, &request(BASE, None), &output("baseline", 100));
    assert_eq!(
        store.begin(&request(BASE, Some(BASE))),
        Err(GameStoreError::Duplicate)
    );
    assert_eq!(
        store.begin(&request(NEXT, None)),
        Err(GameStoreError::StaleHead)
    );
    let mut req = request(NEXT, Some(BASE));
    req.branch_id = "child-not-supported".into();
    assert_eq!(store.begin(&req), Err(GameStoreError::InvalidRequest));
    req.branch_id = "main".into();
    store.begin(&req).unwrap();
    assert_eq!(
        store.begin(&request("concurrent-other-id", Some(BASE))),
        Err(GameStoreError::Busy)
    );
    assert_eq!(
        store.stage_output(NEXT, "{}"),
        Err(GameStoreError::InvalidTransition)
    );
    assert_eq!(
        store.finish_uncommitted(NEXT, GameOperationStatus::Committed, None),
        Err(GameStoreError::InvalidTransition)
    );
    assert_eq!(
        store.finish_uncommitted(NEXT, GameOperationStatus::Failed, Some("private raw error")),
        Err(GameStoreError::InvalidErrorCode)
    );
    store
        .finish_uncommitted(NEXT, GameOperationStatus::Cancelled, None)
        .unwrap();
    assert_eq!(store.view().unwrap().state, baseline.state);
    assert_eq!(store.begin(&req), Err(GameStoreError::Duplicate));
}

#[test]
fn invalid_candidate_mismatch_late_failure_sql_error_and_cancel_are_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("atomic.sqlite");
    let store = create(&path);
    let baseline = commit(&store, &request(BASE, None), &output("baseline", 100));
    let story = output("next", 99);
    stage(&store, &request(NEXT, Some(BASE)), &story);
    let mut mismatch = story.clone();
    mismatch.narrative.push_str("未曾生成的内容");
    assert_eq!(
        store.commit(NEXT, &mismatch),
        Err(GameStoreError::InvalidOutput)
    );
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER inject_failure BEFORE UPDATE OF head_turn_id ON game_world BEGIN SELECT RAISE(FAIL,'controlled failure'); END").unwrap();
    assert_eq!(store.commit(NEXT, &story), Err(GameStoreError::Database));
    assert_eq!(store.view().unwrap().state, baseline.state);
    assert_eq!(store.view().unwrap().turn_count, 1);
    db.execute_batch("DROP TRIGGER inject_failure").unwrap();
    assert_eq!(
        store.commit_with_hook(NEXT, &story, || Err(GameStoreError::Cancelled)),
        Err(GameStoreError::Cancelled)
    );
    assert_eq!(store.view().unwrap().state, baseline.state);
    assert_eq!(
        store.view().unwrap().latest_operation.unwrap().status,
        GameOperationStatus::Validating
    );
    let after = store.commit(NEXT, &story).unwrap();
    assert_eq!(after.state.resources[0].amount, 98);
    assert_eq!(after.turn_count, 2);
    let late = "schema-two-late-invalid";
    let mut invalid = output("invalid", 98);
    invalid.state_changes.push(StateChangeV2::SetLifeStatus {
        entity_id: "missing-person".into(),
        alive: false,
        event_id: "invalid".into(),
    });
    stage(&store, &request(late, Some(NEXT)), &invalid);
    assert_eq!(
        store.commit(late, &invalid),
        Err(GameStoreError::InvalidOutput)
    );
    assert_eq!(store.view().unwrap().state, after.state);
    store
        .finish_uncommitted(
            late,
            GameOperationStatus::Failed,
            Some("game_invalid_output"),
        )
        .unwrap();
    assert_eq!(store.view().unwrap().turn_count, 2);
}

#[test]
fn startup_interrupts_all_uncommitted_phases_without_reusing_candidate() {
    for status in [
        GameOperationStatus::Pending,
        GameOperationStatus::Generating,
        GameOperationStatus::Validating,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("interrupted.sqlite");
        let store = create(&path);
        let baseline = commit(&store, &request(BASE, None), &output("baseline", 100));
        store.begin(&request(NEXT, Some(BASE))).unwrap();
        if status != GameOperationStatus::Pending {
            store.mark_generating(NEXT).unwrap();
        }
        if status == GameOperationStatus::Validating {
            store
                .stage_output(NEXT, &serde_json::to_string(&output("draft", 99)).unwrap())
                .unwrap();
        }
        drop(store);
        let reopened = GameStoreV2::open(&path).unwrap();
        let view = reopened.view().unwrap();
        assert_eq!(view.state, baseline.state);
        assert_eq!(view.turns, baseline.turns);
        assert_eq!(view.turn_count, 1);
        assert_eq!(
            view.latest_operation.as_ref().unwrap().status,
            GameOperationStatus::Interrupted
        );
        assert_eq!(
            view.latest_operation.unwrap().error_code.as_deref(),
            Some("process_interrupted")
        );
        let db = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT candidate FROM game_operations WHERE operation_id=?1",
                [NEXT],
                |r| r.get::<_, Option<String>>(0)
            )
            .unwrap(),
            None
        );
        assert_eq!(
            reopened.commit(NEXT, &output("draft", 99)),
            Err(GameStoreError::InvalidTransition)
        );
    }
}

#[test]
fn eight_concurrent_requests_reserve_one_operation_and_one_settlement() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(create(&dir.path().join("concurrent.sqlite")));
    let barrier = Arc::new(Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|n| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let id = format!("concurrent-v2-{n:08}");
                barrier.wait();
                let result = store.begin(&request(&id, None));
                (id, result)
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|(_, r)| r.is_ok()).count(), 1);
    assert!(results
        .iter()
        .all(|(_, r)| r.is_ok() || *r == Err(GameStoreError::Busy)));
    let id = &results.iter().find(|(_, r)| r.is_ok()).unwrap().0;
    store.mark_generating(id).unwrap();
    let story = output("only-once", 100);
    store
        .stage_output(id, &serde_json::to_string(&story).unwrap())
        .unwrap();
    let view = store.commit(id, &story).unwrap();
    assert_eq!(view.turn_count, 1);
    assert_eq!(view.state.resources[0].amount, 99);
}

fn make_v1(path: &Path, count: usize) {
    use lishi_core::game_protocol::{TimeAdvance, TurnOutput};
    let store = GameStore::open(path).unwrap();
    let setup = setup();
    store
        .create_world(
            &setup,
            &initial_state(&setup).unwrap(),
            "原始v1中文开局。",
            &[],
        )
        .unwrap();
    let mut head = None;
    for n in 0..count {
        let id = format!("legacy-v1-{n:08}");
        let req = request(&id, head.as_deref());
        let story = TurnOutput {
            protocol_version: 1,
            narrative: format!("原始v1回合{n}。"),
            choices: vec![],
            time_advance: TimeAdvance { elapsed_seconds: 1 },
            state_changes: vec![],
            events: vec![],
            source_references: vec![],
            uncertainties: vec![],
        };
        store.begin(&req).unwrap();
        store.mark_generating(&id).unwrap();
        store
            .stage_output(&id, &serde_json::to_string_pretty(&story).unwrap())
            .unwrap();
        store.commit(&id, &story).unwrap();
        head = Some(id);
    }
    store
        .begin(&request("legacy-failed-secret-test", head.as_deref()))
        .unwrap();
    store
        .finish_uncommitted(
            "legacy-failed-secret-test",
            GameOperationStatus::Failed,
            Some("network"),
        )
        .unwrap();
}

fn raw_formal_rows(path: &Path) -> Vec<(String, String, String)> {
    let db = rusqlite::Connection::open(path).unwrap();
    let mut stmt = db
        .prepare("SELECT turn_id,state,output FROM game_turns ORDER BY sequence")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn explicit_migration_over_one_hundred_turns_preserves_raw_rows_and_replays_new_v2() {
    let dir = tempfile::tempdir().unwrap();
    let backups = dir.path().join("backups");
    std::fs::create_dir(&backups).unwrap();
    let path = dir.path().join("mixed.sqlite");
    make_v1(&path, RECENT_TURN_LIMIT + 5);
    let raw = raw_formal_rows(&path);
    assert!(matches!(
        GameStoreV2::open(&path),
        Err(GameStoreError::IncompatibleSchema)
    ));
    upgrade_v1(&path, &backups).unwrap();
    let store = GameStoreV2::open(&path).unwrap();
    let view = store.view().unwrap();
    assert_eq!(view.turn_count, 105);
    assert_eq!(view.turns.len(), RECENT_TURN_LIMIT);
    assert_eq!(view.turns[0].turn_id, "legacy-v1-00000005");
    assert_eq!(view.state.time.elapsed_seconds, 105);
    assert_eq!(view.state.item_holdings[0].source, StateSource::Initial);
    let after = commit(
        &store,
        &request(NEXT, view.head_turn_id.as_deref()),
        &output("new-v2", 100),
    );
    assert_eq!(after.turn_count, 106);
    assert_eq!(after.state.resources[0].amount, 99);
    assert_eq!(after.turns[0].turn_id, "legacy-v1-00000006");
    store
        .update_policy("合法的新叙事方针不会破坏旧资料指纹。")
        .unwrap();
    store
        .begin(&request("new-v2-failed-operation", Some(NEXT)))
        .unwrap();
    store
        .finish_uncommitted(
            "new-v2-failed-operation",
            GameOperationStatus::Failed,
            Some("network"),
        )
        .unwrap();
    let final_view = store.view().unwrap();
    assert_eq!(&raw_formal_rows(&path)[..raw.len()], raw.as_slice());
    let history = store.knowledge_history().unwrap();
    assert_eq!(history.turn_count(), 106);
    assert_eq!(history.head_turn_id(), Some(NEXT));
    assert_eq!(history.current_state(), &final_view.state);
    drop(store);
    assert_eq!(GameStoreV2::open(path).unwrap().view().unwrap(), final_view);
}

#[test]
fn upgraded_zero_turn_opening_can_commit_and_both_versions_never_open_same_owner() {
    let dir = tempfile::tempdir().unwrap();
    let backups = dir.path().join("backups");
    std::fs::create_dir(&backups).unwrap();
    let path = dir.path().join("zero.sqlite");
    make_v1(&path, 0);
    upgrade_v1(&path, &backups).unwrap();
    let store = GameStoreV2::open(&path).unwrap();
    assert_eq!(store.view().unwrap().turn_count, 0);
    assert_eq!(store.knowledge_history().unwrap().turn_count(), 0);
    assert!(matches!(GameStore::open(&path), Err(GameStoreError::Busy)));
    commit(&store, &request(NEXT, None), &output("first-v2", 100));
    drop(store);
    assert!(matches!(
        GameStore::open(path),
        Err(GameStoreError::IncompatibleSchema)
    ));
}

#[test]
fn full_history_detects_old_prefix_and_failed_input_changes_beyond_recent_window() {
    let dir = tempfile::tempdir().unwrap();
    let backups = dir.path().join("backups");
    std::fs::create_dir(&backups).unwrap();
    for failed_input in [false, true] {
        let path = dir.path().join(if failed_input {
            "failed-input.sqlite"
        } else {
            "old-turn.sqlite"
        });
        make_v1(&path, 105);
        upgrade_v1(&path, &backups).unwrap();
        let store = GameStoreV2::open(&path).unwrap();
        assert_eq!(store.view().unwrap().turns[0].turn_id, "legacy-v1-00000005");
        let db = rusqlite::Connection::open(&path).unwrap();
        if failed_input {
            db.execute_batch("DROP TRIGGER game_operation_input_no_update; UPDATE game_operations SET action_text='合法中文但被外部篡改' WHERE operation_id='legacy-failed-secret-test'; CREATE TRIGGER game_operation_input_no_update BEFORE UPDATE OF operation_id,expected_head_turn_id,action_kind,action_text,created_at_ms ON game_operations BEGIN SELECT RAISE(ABORT,'immutable input'); END;").unwrap();
        } else {
            db.execute_batch("DROP TRIGGER game_turns_no_update; UPDATE game_turns SET narrative='合法中文但被外部篡改' WHERE sequence=1; CREATE TRIGGER game_turns_no_update BEFORE UPDATE ON game_turns BEGIN SELECT RAISE(ABORT,'immutable turn'); END;").unwrap();
        }
        assert_eq!(store.view(), Err(GameStoreError::Database));
        drop(store);
        assert!(matches!(
            GameStoreV2::open(&path),
            Err(GameStoreError::Database)
        ));
    }
}

#[test]
fn pure_v2_view_replays_turns_older_than_the_recent_window() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("long-v2.sqlite");
    let store = create(&path);
    let mut head = None;
    for n in 0..105 {
        let id = format!("full-v2-turn-{n:08}");
        let mut story = output(&format!("full-v2-event-{n}"), 100);
        story.state_changes.clear();
        commit(&store, &request(&id, head.as_deref()), &story);
        head = Some(id);
    }
    let view = store.view().unwrap();
    assert_eq!(view.turn_count, 105);
    assert_eq!(view.turns.len(), RECENT_TURN_LIMIT);
    assert_eq!(view.turns[0].turn_id, "full-v2-turn-00000005");
    assert_eq!(view.state.time.elapsed_seconds, 6300);
    let history = store.knowledge_history().unwrap();
    assert_eq!(history.turn_count(), 105);
    assert_eq!(history.current_state(), &view.state);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("DROP TRIGGER game_turns_no_update; UPDATE game_turns SET narrative='合法中文，但不再等于原输出' WHERE sequence=1; CREATE TRIGGER game_turns_no_update BEFORE UPDATE ON game_turns BEGIN SELECT RAISE(ABORT,'immutable turn'); END;").unwrap();
    assert_eq!(store.view(), Err(GameStoreError::Database));
}

#[test]
fn store_history_reconstructs_an_older_observed_value_instead_of_the_current_fact() {
    use lishi_core::game_knowledge::{observed_facts_for_actor, FactKey, SourceVisibilityIndex};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("actor-revisions.sqlite");
    let store = create(&path);
    let mut first = output("observe-rename", 100);
    first.state_changes.push(StateChangeV2::RenameEntity {
        entity_id: "player".into(),
        expected_name: "李明".into(),
        new_name: "李远".into(),
        event_id: "observe-rename".into(),
    });
    first.state_changes.push(StateChangeV2::ObserveFact {
        actor_id: "player".into(),
        fact_key: FactKey::EntityName {
            entity_id: "player".into(),
        },
        event_id: "observe-rename".into(),
    });
    commit(&store, &request(BASE, None), &first);
    let mut second = output("later-rename", 99);
    second.state_changes.push(StateChangeV2::RenameEntity {
        entity_id: "player".into(),
        expected_name: "李远".into(),
        new_name: "王远".into(),
        event_id: "later-rename".into(),
    });
    commit(&store, &request(NEXT, Some(BASE)), &second);
    let history = store.knowledge_history().unwrap();
    let visible = SourceVisibilityIndex::from_recorded_observations(&history, Vec::new()).unwrap();
    let facts = observed_facts_for_actor(&history, &visible, "player").unwrap();
    let name = facts
        .iter()
        .find(|fact| {
            fact.fact_key
                == FactKey::EntityName {
                    entity_id: "player".into(),
                }
        })
        .unwrap();
    assert_eq!(name.value, serde_json::json!("李远"));
    assert_eq!(history.current_state().entities[0].name, "王远");
    drop(store);
    let restored = GameStoreV2::open(&path).unwrap();
    let history = restored.knowledge_history().unwrap();
    let visible = SourceVisibilityIndex::from_recorded_observations(&history, Vec::new()).unwrap();
    assert_eq!(
        observed_facts_for_actor(&history, &visible, "player").unwrap(),
        facts
    );
}

#[test]
fn future_unrelated_missing_trigger_and_schema_one_are_refused_without_auto_migration() {
    let dir = tempfile::tempdir().unwrap();
    for (version, app) in [(3, 0x4c495348), (2, 123), (0, 0)] {
        let path = dir.path().join(format!("foreign-{version}.sqlite"));
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('保留');",
        )
        .unwrap();
        db.pragma_update(None, "user_version", version).unwrap();
        db.pragma_update(None, "application_id", app).unwrap();
        drop(db);
        let original = std::fs::read(&path).unwrap();
        assert!(matches!(
            GameStoreV2::open(&path),
            Err(GameStoreError::IncompatibleSchema)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }
    let path = dir.path().join("schema-one.sqlite");
    make_v1(&path, 0);
    let db = rusqlite::Connection::open(&path).unwrap();
    let version: i32 = db
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 1);
    drop(db);
    assert!(matches!(
        GameStoreV2::open(&path),
        Err(GameStoreError::IncompatibleSchema)
    ));
    let broken = dir.path().join("removed-trigger.sqlite");
    let store = create(&broken);
    drop(store);
    let db = rusqlite::Connection::open(&broken).unwrap();
    db.execute_batch("DROP TRIGGER game_turns_no_update")
        .unwrap();
    drop(db);
    assert!(matches!(
        GameStoreV2::open(broken),
        Err(GameStoreError::IncompatibleSchema)
    ));
}

#[test]
fn orphan_operations_before_world_creation_are_rejected_before_recovery_mutates_them() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("orphan.sqlite");
    let store = GameStoreV2::open(&path).unwrap();
    drop(store);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute("INSERT INTO game_operations(operation_id,expected_head_turn_id,action_kind,action_text,status,candidate,error_code,created_at_ms) VALUES('orphan-operation-001',NULL,'action','不得在创建世界前存在','pending',NULL,NULL,1)", []).unwrap();
    assert!(matches!(
        GameStoreV2::open(&path),
        Err(GameStoreError::Database)
    ));
    assert_eq!(
        db.query_row("SELECT status FROM game_operations", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "pending"
    );
}

fn acknowledge_and_wait(path: &Path) {
    let mut file = File::create_new(path).unwrap();
    file.write_all(b"owned-v2-boundary").unwrap();
    file.sync_all().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("owned test child was not terminated by its parent");
}

#[test]
fn v2_owned_child_process_harness() {
    let Some(path) = std::env::var_os("LISHI_V2_TEST_DB") else {
        return;
    };
    let ready = std::env::var_os("LISHI_V2_TEST_READY").unwrap();
    let phase = std::env::var("LISHI_V2_TEST_PHASE").unwrap();
    let store = GameStoreV2::open(Path::new(&path)).unwrap();
    store.begin(&request(NEXT, Some(BASE))).unwrap();
    if phase == "pending" {
        acknowledge_and_wait(Path::new(&ready));
        return;
    }
    store.mark_generating(NEXT).unwrap();
    if phase == "generating" {
        acknowledge_and_wait(Path::new(&ready));
        return;
    }
    let story = output("child-next", 99);
    store
        .stage_output(NEXT, &serde_json::to_string(&story).unwrap())
        .unwrap();
    if phase == "validating" {
        acknowledge_and_wait(Path::new(&ready));
        return;
    }
    if phase == "transaction" {
        store
            .commit_with_hook(NEXT, &story, || {
                acknowledge_and_wait(Path::new(&ready));
                Ok(())
            })
            .unwrap();
        return;
    }
    store.commit(NEXT, &story).unwrap();
    acknowledge_and_wait(Path::new(&ready));
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn real_process_kill_at_five_boundaries_keeps_only_whole_commits() {
    let dir = tempfile::tempdir().unwrap();
    for phase in [
        "pending",
        "generating",
        "validating",
        "transaction",
        "committed",
    ] {
        let path = dir.path().join(format!("strong-kill-{phase}.sqlite"));
        let ready = dir.path().join(format!("owned-ready-{phase}"));
        let store = create(&path);
        let baseline = commit(&store, &request(BASE, None), &output("baseline", 100));
        drop(store);
        let mut child = OwnedChild(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "v2_owned_child_process_harness", "--nocapture"])
                .env("LISHI_V2_TEST_DB", &path)
                .env("LISHI_V2_TEST_READY", &ready)
                .env("LISHI_V2_TEST_PHASE", phase)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(15);
        while !ready.exists() && Instant::now() < deadline {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "child failed before {phase}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "missing actual {phase} acknowledgement");
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        drop(child);
        let reopened = GameStoreV2::open(&path).unwrap();
        let view = reopened.view().unwrap();
        if phase == "committed" {
            assert_eq!(view.turn_count, 2);
            assert_eq!(view.state.resources[0].amount, 98);
            assert_eq!(
                view.latest_operation.unwrap().status,
                GameOperationStatus::Committed
            );
        } else {
            assert_eq!(view.turn_count, 1);
            assert_eq!(view.state, baseline.state);
            assert_eq!(view.turns, baseline.turns);
            assert_eq!(
                view.latest_operation.unwrap().status,
                GameOperationStatus::Interrupted
            );
        }
        let db = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM game_turns", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            if phase == "committed" { 2 } else { 1 }
        );
    }
}
