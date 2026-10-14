use lishi_core::{
    game_context::{
        compile_context, ContextBudget, ContextPin, ContextRules, ContextScope, ContextSectionKind,
        ContextSectionOutcome, ContextTrace,
    },
    game_context_log::{TraceLogError, TraceStore, MAX_CONTEXT_TRACES_PER_WORLD},
    game_knowledge::ValidatedHistory,
    game_protocol::WorldSetup,
    game_protocol_v2::{initial_state_v2, FactKey},
    game_store::{GameActionKind, GameTurnRequest},
    game_store_v2::{GameStoreV2, WorldViewV2},
};
use rusqlite::{params, Connection};

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: "trace-world-0001".into(),
        title: "日志测试".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "李明".into(),
        narrative_style: "保留未知信息".into(),
    }
}
fn trace() -> ContextTrace {
    trace_with_options(
        ContextBudget {
            max_input_bytes: 64 * 1024,
            context_limit_tokens: 96 * 1024,
            ..ContextBudget::default()
        },
        false,
    )
}
fn trace_with_options(budget: ContextBudget, with_pins: bool) -> ContextTrace {
    let setup = setup();
    let state = initial_state_v2(&setup).unwrap();
    let history = ValidatedHistory::new(&setup.world_id, state.clone(), Vec::new(), None).unwrap();
    let view = WorldViewV2 {
        setup: setup.clone(),
        branch_id: "main".into(),
        head_turn_id: None,
        turn_count: 0,
        state,
        opening_narrative: "只用于测试的初始剧情".into(),
        opening_choices: Vec::new(),
        narrative_policy: String::new(),
        turns: Vec::new(),
        latest_operation: None,
    };
    let request = GameTurnRequest {
        operation_id: "trace-operation-0001".into(),
        world_id: setup.world_id,
        branch_id: "main".into(),
        expected_head_turn_id: None,
        action_kind: GameActionKind::Action,
        action_text: "检查行囊与钥匙🔑🙂".into(),
    };
    let pins = if with_pins {
        ["time-pin-0001", "time-pin-0002"]
            .into_iter()
            .map(|id| ContextPin {
                id: id.into(),
                scope: ContextScope::from_view(&view),
                fact_key: FactKey::Time,
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    compile_context(
        &view,
        &request,
        &history,
        ContextRules::v2(),
        budget,
        &pins,
        &[],
    )
    .unwrap()
    .trace
}

#[test]
fn redacted_trace_json_restart_and_same_operation_id_are_immutable_and_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context-log.sqlite");
    let expected = trace();
    let store = TraceStore::open_sidecar(&path).unwrap();
    store.record(&expected).unwrap();
    store.record(&expected).unwrap();
    assert_eq!(
        store.get(&expected.operation_id).unwrap(),
        Some(expected.clone())
    );
    let mut conflicting = expected.clone();
    conflicting.prompt_sha256 = "a".repeat(64);
    assert_eq!(
        store.record(&conflicting),
        Err(TraceLogError::DuplicateConflict)
    );
    assert_eq!(
        store.get(&expected.operation_id).unwrap(),
        Some(expected.clone())
    );
    drop(store);
    let reopened = TraceStore::open_sidecar(&path).unwrap();
    assert_eq!(
        reopened.get(&expected.operation_id).unwrap(),
        Some(expected.clone())
    );
    assert_eq!(reopened.get("missing-operation").unwrap(), None);
    let json = serde_json::to_string(&expected).unwrap();
    for forbidden in [
        "李明",
        "咸阳",
        "检查行囊",
        "output_rules",
        "Authorization",
        "secretSlot",
        "endpoint",
        "apiKey",
        "model",
    ] {
        assert!(!json.contains(forbidden));
    }
    assert_eq!(
        serde_json::from_str::<ContextTrace>(&json).unwrap(),
        expected
    );
}

#[test]
fn actual_http_usage_is_separate_write_once_and_unknown_does_not_overwrite_known() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("usage-log.sqlite");
    let expected = trace();
    let store = TraceStore::open_sidecar(&path).unwrap();
    store.record(&expected).unwrap();
    store
        .record_actual_usage(&expected.operation_id, None)
        .unwrap();
    assert_eq!(
        store
            .get(&expected.operation_id)
            .unwrap()
            .unwrap()
            .actual_input_tokens,
        None
    );
    // Unit fixture stands for a validated HTTP usage count, not a tokenizer
    // estimate. The API deliberately cannot attest its caller's origin.
    store
        .record_actual_usage(&expected.operation_id, Some(173))
        .unwrap();
    store
        .record_actual_usage(&expected.operation_id, None)
        .unwrap();
    store
        .record_actual_usage(&expected.operation_id, Some(173))
        .unwrap();
    store.record(&expected).unwrap();
    assert_eq!(
        store.record_actual_usage(&expected.operation_id, Some(174)),
        Err(TraceLogError::UsageConflict)
    );
    assert_eq!(
        store
            .get(&expected.operation_id)
            .unwrap()
            .unwrap()
            .actual_input_tokens,
        Some(173)
    );
    assert_eq!(
        store.record_actual_usage("missing-operation", None),
        Err(TraceLogError::Missing)
    );
    drop(store);
    let reopened = TraceStore::open_sidecar(path).unwrap();
    assert_eq!(
        reopened
            .get(&expected.operation_id)
            .unwrap()
            .unwrap()
            .actual_input_tokens,
        Some(173)
    );
}

#[test]
fn world_or_foreign_database_is_refused_readonly_without_touching_its_content() {
    let dir = tempfile::tempdir().unwrap();
    let facts = dir.path().join("world.sqlite");
    let setup = setup();
    let store = GameStoreV2::open(&facts).unwrap();
    store
        .create_world_v2(
            &setup,
            &initial_state_v2(&setup).unwrap(),
            "固定初始剧情",
            &[],
        )
        .unwrap();
    drop(store);
    let before = std::fs::read(&facts).unwrap();
    assert!(matches!(
        TraceStore::open_sidecar(&facts),
        Err(TraceLogError::IncompatibleDatabase)
    ));
    assert_eq!(std::fs::read(&facts).unwrap(), before);
    assert!(!dir.path().join("world.sqlite.context-owner-lock").exists());
    let foreign = dir.path().join("foreign.sqlite");
    let db = Connection::open(&foreign).unwrap();
    db.execute_batch("CREATE TABLE foreign_facts(value TEXT);INSERT INTO foreign_facts VALUES('local dummy value');").unwrap();
    drop(db);
    let before = std::fs::read(&foreign).unwrap();
    assert!(matches!(
        TraceStore::open_sidecar(&foreign),
        Err(TraceLogError::IncompatibleDatabase)
    ));
    assert_eq!(std::fs::read(&foreign).unwrap(), before);
}

#[test]
fn owner_busy_and_corrupt_record_fail_closed_without_returning_raw_json() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("owner.sqlite");
    let store = TraceStore::open_sidecar(&path).unwrap();
    store.record(&trace()).unwrap();
    assert!(matches!(
        TraceStore::open_sidecar(&path),
        Err(TraceLogError::Busy)
    ));
    drop(store);
    let db = Connection::open(&path).unwrap();
    assert!(db
        .execute("UPDATE context_traces SET trace_json='{}'", [])
        .is_err());
    db.execute("INSERT INTO context_traces(operation_id,world_id,branch_id,trace_json,created_at_ms) VALUES('corrupt-operation-0001','trace-world-0001','main',?1,1)",[r#"{"apiKey":"invalid-corrupt-fixture-value"}"#]).unwrap();
    drop(db);
    let reopened = TraceStore::open_sidecar(path).unwrap();
    let error = reopened.get("corrupt-operation-0001").unwrap_err();
    assert_eq!(error, TraceLogError::Database);
    assert!(!format!("{error:?}").contains("fixture-value"));
}

#[test]
fn arbitrary_raw_text_or_estimated_usage_cannot_be_saved_as_a_redacted_trace() {
    let dir = tempfile::tempdir().unwrap();
    let store = TraceStore::open_sidecar(dir.path().join("bounded.sqlite")).unwrap();
    let original = trace();
    for edit in 0..5 {
        let mut bad = original.clone();
        match edit {
            0 => bad.estimate_method = "Authorization: Bearer invalid-fixture-value".into(),
            1 => bad.input_utf8_bytes += 1,
            2 => bad.actual_input_tokens = Some(bad.estimated_input_tokens),
            3 => bad.sections.push(bad.sections[0].clone()),
            _ => bad.prompt_sha256 = "not-an-actual-sha256".into(),
        }
        assert_eq!(store.record(&bad), Err(TraceLogError::InvalidTrace));
    }
    assert_eq!(store.get(&original.operation_id).unwrap(), None);
    let mut bad_json = serde_json::to_value(&original).unwrap();
    bad_json["apiKey"] = serde_json::json!("invalid-extra-field");
    assert!(serde_json::from_value::<ContextTrace>(bad_json).is_err());
    store.record(&original).unwrap();
}

#[test]
fn capacity_is_bounded_without_automatic_deletion_and_pruning_is_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("capacity.sqlite");
    let original = trace();
    let store = TraceStore::open_sidecar(&path).unwrap();
    store.record(&original).unwrap();
    drop(store);
    let db = Connection::open(&path).unwrap();
    let json = serde_json::to_string(&original).unwrap();
    db.execute("WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<?1) INSERT INTO context_traces(operation_id,world_id,branch_id,head_turn_id,trace_json,created_at_ms) SELECT printf('capacity-operation-%04d',n),?2,'main',NULL,json_set(?3,'$.operationId',printf('capacity-operation-%04d',n)),1 FROM numbers",params![(MAX_CONTEXT_TRACES_PER_WORLD-1) as i64,original.world_id,json]).unwrap();
    drop(db);
    let reopened = TraceStore::open_sidecar(&path).unwrap();
    let mut next = original.clone();
    next.operation_id = "capacity-next-operation".into();
    assert_eq!(reopened.record(&next), Err(TraceLogError::Capacity));
    let mut sibling = next.clone();
    sibling.operation_id = "capacity-sibling-operation".into();
    sibling.branch_id = "sibling".into();
    assert_eq!(reopened.record(&sibling), Err(TraceLogError::Capacity));
    let mut other = next.clone();
    other.operation_id = "capacity-other-operation".into();
    other.world_id = "other-world-0001".into();
    reopened.record(&other).unwrap();
    assert!(reopened.get(&original.operation_id).unwrap().is_some());
    reopened.record(&original).unwrap();
    assert_eq!(
        reopened
            .prune_world_branch(&original.world_id, "main", 1)
            .unwrap(),
        MAX_CONTEXT_TRACES_PER_WORLD - 1
    );
    assert_eq!(reopened.get(&original.operation_id).unwrap(), None);
    reopened.record(&next).unwrap();
    assert!(reopened.get(&next.operation_id).unwrap().is_some());
    assert!(reopened.get(&other.operation_id).unwrap().is_some());
}

#[test]
fn compiler_optional_deduplication_and_budget_omissions_roundtrip_without_counting_dropped_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let store = TraceStore::open_sidecar(dir.path().join("optional.sqlite")).unwrap();
    let original = trace();
    let mut included = trace_with_options(original.budget, true);
    included.operation_id = "optional-included-operation".into();
    let pins = included
        .sections
        .iter()
        .filter(|section| section.kind == ContextSectionKind::PinnedFact)
        .collect::<Vec<_>>();
    assert_eq!(pins.len(), 2);
    assert_eq!(pins[0].outcome, ContextSectionOutcome::Included);
    assert_eq!(pins[1].outcome, ContextSectionOutcome::Deduplicated);
    store.record(&included).unwrap();
    assert_eq!(
        store.get(&included.operation_id).unwrap(),
        Some(included.clone())
    );
    let mut dropped = trace_with_options(
        ContextBudget {
            max_input_bytes: original.required_input_bytes,
            ..original.budget
        },
        true,
    );
    dropped.operation_id = "optional-dropped-operation".into();
    assert_eq!(dropped.input_utf8_bytes, original.required_input_bytes);
    assert!(dropped
        .sections
        .iter()
        .filter(|section| section.kind == ContextSectionKind::PinnedFact)
        .all(|section| section.outcome == ContextSectionOutcome::DroppedBudget));
    store.record(&dropped).unwrap();
    assert_eq!(store.get(&dropped.operation_id).unwrap(), Some(dropped));
    let optional_indices = included
        .sections
        .iter()
        .enumerate()
        .filter(|(_, section)| section.kind == ContextSectionKind::PinnedFact)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    for edit in 0..3 {
        let mut bad = included.clone();
        bad.operation_id = "optional-invalid-operation".into();
        match edit {
            0 => {
                bad.sections[optional_indices[1]].id = bad.sections[optional_indices[0]].id.clone()
            }
            1 => bad.sections[optional_indices[0]].source_turn_count = 1,
            _ => bad.sections[optional_indices[0]].kind = ContextSectionKind::Summary,
        }
        assert_eq!(store.record(&bad), Err(TraceLogError::InvalidTrace));
    }
}

#[test]
fn matching_application_identity_does_not_accept_mixed_facts_or_missing_guards() {
    for damage in [
        "CREATE TABLE world_facts(secret TEXT)",
        "DROP TRIGGER context_trace_immutable",
        "PRAGMA user_version=2",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mixed.sqlite");
        drop(TraceStore::open_sidecar(&path).unwrap());
        let db = Connection::open(&path).unwrap();
        db.execute_batch(damage).unwrap();
        drop(db);
        let before = std::fs::read(&path).unwrap();
        assert!(matches!(
            TraceStore::open_sidecar(&path),
            Err(TraceLogError::IncompatibleDatabase)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}

#[test]
fn trace_ids_hashes_budget_and_section_sizes_are_validated_before_writes() {
    let dir = tempfile::tempdir().unwrap();
    let store = TraceStore::open_sidecar(dir.path().join("invalid-traces.sqlite")).unwrap();
    let original = trace();
    for edit in 0..15 {
        let mut bad = original.clone();
        match edit {
            0 => bad.world_id = "tiny".into(),
            1 => bad.operation_id = "tiny".into(),
            2 => bad.branch_id = "Authorization: Bearer dummy".into(),
            3 => bad.head_turn_id = Some("tiny".into()),
            4 => bad.prompt_version = 0,
            5 => bad.budget.context_limit_tokens = bad.budget.output_reserve_tokens,
            6 => bad.effective_input_limit_bytes += 1,
            7 => bad.estimated_input_tokens += 1,
            8 => bad.required_input_bytes += 1,
            9 => bad.sections[0].utf8_bytes += 1,
            10 => bad.sections[0].sha256 = "A".repeat(64),
            11 => bad.sections[0].id = Some("unexpected-id".into()),
            12 => bad.sections[0].source_turn_count = 1,
            13 => bad.sections.clear(),
            _ => bad.sections = vec![bad.sections[0].clone(); 2049],
        }
        assert_eq!(
            store.record(&bad),
            Err(TraceLogError::InvalidTrace),
            "edit {edit}"
        );
    }
    assert_eq!(store.get(&original.operation_id).unwrap(), None);
    assert_eq!(store.get("tiny"), Err(TraceLogError::InvalidTrace));
    assert_eq!(
        store.record_actual_usage("tiny", Some(1)),
        Err(TraceLogError::InvalidTrace)
    );
    store.record(&original).unwrap();
    assert_eq!(
        store.record_actual_usage(&original.operation_id, Some(9_007_199_254_740_992)),
        Err(TraceLogError::InvalidTrace)
    );
    store
        .record_actual_usage(&original.operation_id, Some(0))
        .unwrap();
    assert_eq!(
        store
            .get(&original.operation_id)
            .unwrap()
            .unwrap()
            .actual_input_tokens,
        Some(0)
    );
}

#[test]
fn explicit_pruning_remains_scoped_and_does_not_touch_world_database() {
    let dir = tempfile::tempdir().unwrap();
    let world_path = dir.path().join("facts.sqlite");
    let setup = setup();
    let world = GameStoreV2::open(&world_path).unwrap();
    world
        .create_world_v2(
            &setup,
            &initial_state_v2(&setup).unwrap(),
            "固定初始剧情",
            &[],
        )
        .unwrap();
    drop(world);
    let world_before = std::fs::read(&world_path).unwrap();
    let path = dir.path().join("pruning.sqlite");
    let store = TraceStore::open_sidecar(&path).unwrap();
    let original = trace();
    store.record(&original).unwrap();
    let mut latest = original.clone();
    latest.operation_id = "latest-operation-0001".into();
    store.record(&latest).unwrap();
    let mut sibling = original.clone();
    sibling.operation_id = "sibling-operation-0001".into();
    sibling.branch_id = "sibling".into();
    store.record(&sibling).unwrap();
    let mut other = original.clone();
    other.operation_id = "other-operation-0001".into();
    other.world_id = "other-world-0001".into();
    store.record(&other).unwrap();
    assert_eq!(
        store
            .prune_world_branch(&original.world_id, "main", 1)
            .unwrap(),
        1
    );
    assert_eq!(store.get(&original.operation_id).unwrap(), None);
    for kept in [&latest, &sibling, &other] {
        assert_eq!(store.get(&kept.operation_id).unwrap(), Some(kept.clone()));
    }
    assert_eq!(
        store
            .prune_world_branch(&original.world_id, "main", 0)
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .prune_world_branch(&original.world_id, "main", 0)
            .unwrap(),
        0
    );
    assert_eq!(std::fs::read(&world_path).unwrap(), world_before);
    drop(store);
    let reopened = TraceStore::open_sidecar(path).unwrap();
    assert_eq!(reopened.get(&sibling.operation_id).unwrap(), Some(sibling));
}
