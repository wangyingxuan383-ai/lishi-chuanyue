//! Isolated adversarial review of M06 portable databases and frozen evidence.
use std::{fs, path::Path};

use lishi_core::{
    game_annotations::{AnnotationBranchAccess, AnnotationScope, AnnotationStore},
    game_context::ContextScope,
    game_knowledge::ValidatedHistory,
    game_migration::upgrade_v1,
    game_portable_schema::validate_world_schema,
    game_protocol::{initial_state, WorldSetup},
    game_protocol_v2::{initial_state_v2, FactKey},
    game_research::{ExcerptOrigin, ResearchQuery, ResearchSource, ResearchTopic},
    game_research_store::{
        ResearchAdoption, ResearchBranchAccess, ResearchRecord, ResearchScope, ResearchStore,
        WorldResearchBundle,
    },
    game_store::{GameActionKind, GameStore, GameStoreError, GameTurnRequest},
    game_store_v2::GameStoreV2,
};
use rusqlite::Connection;

const WORLD: &str = "portable-review-world";

fn setup() -> WorldSetup {
    WorldSetup {
        world_id: WORLD.into(),
        title: "独立存档审查".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "李明".into(),
        narrative_style: "固定数据，无联网".into(),
    }
}

fn make_world(path: &Path, version: u32) {
    let setup = setup();
    if version == 1 {
        let store = GameStore::open(path).unwrap();
        store
            .create_world(&setup, &initial_state(&setup).unwrap(), "开局", &[])
            .unwrap();
    } else {
        let store = GameStoreV2::open(path).unwrap();
        store
            .create_world_v2(&setup, &initial_state_v2(&setup).unwrap(), "开局", &[])
            .unwrap();
        if version == 3 {
            store
                .enable_branches(&path.parent().unwrap().join("backups"), None)
                .unwrap();
        }
    }
}

fn history() -> ValidatedHistory {
    ValidatedHistory::new(WORLD, initial_state_v2(&setup()).unwrap(), vec![], None).unwrap()
}

fn context(branch: &str) -> ContextScope {
    ContextScope {
        world_id: WORLD.into(),
        branch_id: branch.into(),
        head_turn_id: None,
    }
}

#[test]
fn schema_gate_accepts_fresh_legacy_and_native_v2_v3_with_optional_fast_forward() {
    for version in 1..=3 {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("world.sqlite");
        make_world(&path, version);
        validate_world_schema(&path, version).unwrap();
        if version == 3 {
            let store = GameStoreV2::open(&path).unwrap();
            store.ensure_fast_forward_backend().unwrap();
            drop(store);
            validate_world_schema(&path, 3).unwrap();
        }
    }
}

#[test]
fn schema_gate_accepts_real_v1_to_v2_to_v3_migration_and_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.sqlite");
    make_world(&path, 1);
    upgrade_v1(&path, dir.path()).unwrap();
    validate_world_schema(&path, 2).unwrap();
    let store = GameStoreV2::open(&path).unwrap();
    store.enable_branches(dir.path(), None).unwrap();
    store.ensure_fast_forward_backend().unwrap();
    let snapshot = dir.path().join("snapshot.sqlite");
    store.snapshot_to(&snapshot).unwrap();
    drop(store);
    validate_world_schema(&path, 3).unwrap();
    validate_world_schema(&snapshot, 3).unwrap();
}

#[test]
fn schema_gate_rejects_extra_trigger_view_index_and_table_in_all_versions() {
    for version in 1..=3 {
        for statement in [
            "CREATE TRIGGER package_payload AFTER INSERT ON game_operations BEGIN UPDATE game_world SET turn_count=999 WHERE id=1; END;",
            "CREATE VIEW package_payload AS SELECT * FROM game_world;",
            "CREATE INDEX package_payload ON game_operations(status);",
            "CREATE TABLE package_payload(secret TEXT);",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("world.sqlite");
            make_world(&path, version);
            Connection::open(&path).unwrap().execute_batch(statement).unwrap();
            assert_eq!(
                validate_world_schema(&path, version),
                Err(GameStoreError::IncompatibleSchema),
                "version={version}, statement={statement}"
            );
        }
    }
}

#[test]
fn schema_gate_rejects_altered_constraints_and_preserves_sql_literal_contents() {
    for (from, to) in [
        ("CHECK(turn_count>=0)", "CHECK(turn_count>=-1)"),
        ("'pending'", "'pen ding'"),
        ("'pending'", "'PENDING'"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("world.sqlite");
        make_world(&path, 2);
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA writable_schema=ON;").unwrap();
        assert!(db
            .execute(
                "UPDATE sqlite_master SET sql=replace(sql,?1,?2) WHERE type='table' AND instr(sql,?1)>0",
                [from, to],
            )
            .unwrap() > 0);
        drop(db);
        assert!(validate_world_schema(&path, 2).is_err(), "{from} -> {to}");
    }
}

#[test]
fn schema_gate_does_not_run_recovery_or_package_trigger_and_cannot_create_a_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("world.sqlite");
    make_world(&path, 2);
    let store = GameStoreV2::open(&path).unwrap();
    store
        .begin(&GameTurnRequest {
            operation_id: "portable-pending-operation".into(),
            world_id: WORLD.into(),
            branch_id: "main".into(),
            expected_head_turn_id: None,
            action_kind: GameActionKind::Action,
            action_text: "等待".into(),
        })
        .unwrap();
    drop(store);
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER package_recovery AFTER UPDATE OF status ON game_operations BEGIN UPDATE game_operations SET error_code='game_invalid_output' WHERE operation_id=NEW.operation_id; END;").unwrap();
    drop(db);
    let before = fs::read(&path).unwrap();
    assert!(validate_world_schema(&path, 2).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    let row: (String, Option<String>) = Connection::open(&path)
        .unwrap()
        .query_row("SELECT status,error_code FROM game_operations", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(row, ("pending".into(), None));
    let absent = dir.path().join("not-created.sqlite");
    assert!(validate_world_schema(&absent, 2).is_err());
    assert!(!absent.exists());
    assert!(!dir.path().join("not-created.sqlite.owner-lock").exists());
}

#[test]
fn schema_gate_rejects_wrong_version_identity_and_incomplete_fast_forward_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("world.sqlite");
    make_world(&path, 3);
    for expected in [0, 1, 2, 4, u32::MAX] {
        assert!(validate_world_schema(&path, expected).is_err());
    }
    let store = GameStoreV2::open(&path).unwrap();
    store.ensure_fast_forward_backend().unwrap();
    drop(store);
    let db = Connection::open(&path).unwrap();
    db.execute_batch("DROP TRIGGER fast_forward_segment_no_delete;")
        .unwrap();
    drop(db);
    assert!(validate_world_schema(&path, 3).is_err());
    let db = Connection::open(&path).unwrap();
    db.pragma_update(None, "application_id", 0).unwrap();
    drop(db);
    assert!(validate_world_schema(&path, 3).is_err());
}

#[test]
fn portable_annotations_preserve_same_head_fork_watermark_without_future_pins() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("annotations.sqlite");
    let store = AnnotationStore::open(&path).unwrap();
    let history = history();
    let main = AnnotationScope::single(context("main"));
    let key = FactKey::Resource {
        owner_id: "player".into(),
        key: "cash".into(),
    };
    store.add_pin(&main, &history, "before-fork", &key).unwrap();
    let cutoff = store.watermark().unwrap();
    let child = AnnotationScope {
        context: context("review-child-branch"),
        branch_path: vec![
            AnnotationBranchAccess {
                branch_id: "main".into(),
                through_turn_id: None,
                through_change_seq: Some(cutoff),
            },
            AnnotationBranchAccess {
                branch_id: "review-child-branch".into(),
                through_turn_id: None,
                through_change_seq: None,
            },
        ],
    };
    store.add_pin(&main, &history, "after-fork", &key).unwrap();
    let snapshot = dir.path().join("portable.sqlite");
    store.snapshot_to(&snapshot).unwrap();
    AnnotationStore::validate_portable(&snapshot, WORLD, &[(&main, &history), (&child, &history)])
        .unwrap();
    let imported = AnnotationStore::open(&snapshot).unwrap();
    let pins = imported.view(&child, &history).unwrap().pins;
    assert_eq!(pins.len(), 1);
    assert_eq!(pins[0].id, "before-fork");
    assert_eq!(imported.view(&main, &history).unwrap().pins.len(), 2);
}

#[test]
fn portable_annotations_reject_other_world_unknown_branch_and_extra_executable_schema() {
    let dir = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(dir.path().join("annotations.sqlite")).unwrap();
    let history = history();
    let main = AnnotationScope::single(context("main"));
    let key = FactKey::Resource {
        owner_id: "player".into(),
        key: "cash".into(),
    };
    store.add_pin(&main, &history, "pin-one", &key).unwrap();
    let path = dir.path().join("portable.sqlite");
    store.snapshot_to(&path).unwrap();
    assert!(
        AnnotationStore::validate_portable(&path, "another-world", &[(&main, &history)]).is_err()
    );
    let other = AnnotationScope::single(context("review-child-branch"));
    assert!(AnnotationStore::validate_portable(&path, WORLD, &[(&other, &history)]).is_err());
    Connection::open(&path).unwrap().execute_batch("CREATE TRIGGER package_payload AFTER INSERT ON annotations BEGIN SELECT RAISE(ABORT,'blocked'); END;").unwrap();
    let before = fs::read(&path).unwrap();
    assert!(AnnotationStore::validate_portable(&path, WORLD, &[(&main, &history)]).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn portable_annotations_reject_constraint_literal_whitespace_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let store = AnnotationStore::open(dir.path().join("annotations.sqlite")).unwrap();
    let path = dir.path().join("portable.sqlite");
    store.snapshot_to(&path).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA writable_schema=ON;").unwrap();
    assert_eq!(db.execute("UPDATE sqlite_master SET sql=replace(sql,'''pin''','''p in''') WHERE name='annotations'", []).unwrap(), 1);
    drop(db);
    let history = history();
    let scope = AnnotationScope::single(context("main"));
    assert!(AnnotationStore::validate_portable(&path, WORLD, &[(&scope, &history)]).is_err());
}

#[test]
fn canonical_v1_annotations_upgrade_and_portable_roundtrip_preserve_pin() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("fresh.sqlite");
    let store = AnnotationStore::open(&source).unwrap();
    let history = history();
    let scope = AnnotationScope::single(context("main"));
    let key = FactKey::Resource {
        owner_id: "player".into(),
        key: "cash".into(),
    };
    let pin = store.add_pin(&scope, &history, "legacy-pin", &key).unwrap();
    let db = Connection::open(&source).unwrap();
    // Canonical pre-revision tables retain every original STRICT/NOT NULL/
    // CHECK/index/immutable constraint; only the later sequence additions and
    // revision objects are absent. No weak legacy fixture is trusted here.
    let schema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name")
        .unwrap().query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    let legacy_path = dir.path().join("legacy.sqlite");
    let legacy = Connection::open(&legacy_path).unwrap();
    for (name, sql) in schema {
        if matches!(
            name.as_str(),
            "annotations"
                | "annotation_deletions"
                | "summary_operations"
                | "annotations_scope"
                | "summaries_scope"
                | "annotations_no_update"
                | "annotations_no_delete"
                | "deletions_no_update"
                | "deletions_no_delete"
                | "summary_identity_no_update"
        ) {
            let sql = if matches!(name.as_str(), "annotations" | "annotation_deletions") {
                sql.replace(
                    ",change_seq INTEGER NOT NULL REFERENCES annotation_changes(change_seq)",
                    "",
                )
            } else {
                sql
            };
            legacy.execute_batch(&sql).unwrap();
        }
    }
    legacy
        .pragma_update(None, "application_id", 0x4c414e4ei32)
        .unwrap();
    legacy.pragma_update(None, "user_version", 1).unwrap();
    let mut raw = serde_json::to_value(&pin).unwrap();
    raw.as_object_mut().unwrap().remove("changeSeq");
    legacy.execute("INSERT INTO annotations(id,kind,world_id,origin_branch,created_head,created_at_ms,record) VALUES(?1,'pin',?2,'main',NULL,?3,?4)", rusqlite::params![pin.id, WORLD, pin.created_at_ms, serde_json::to_string(&raw).unwrap()]).unwrap();
    drop(legacy);
    let upgraded = AnnotationStore::open(&legacy_path).unwrap();
    assert_eq!(
        upgraded.view(&scope, &history).unwrap().pins[0].fact_key,
        key
    );
    let portable = dir.path().join("portable.sqlite");
    upgraded.snapshot_to(&portable).unwrap();
    AnnotationStore::validate_portable(&portable, WORLD, &[(&scope, &history)]).unwrap();
    let imported = AnnotationStore::open(&portable).unwrap();
    assert_eq!(
        imported.view(&scope, &history).unwrap().pins[0].id,
        "legacy-pin"
    );
    imported
        .add_pin(&scope, &history, "post-import-pin", &key)
        .unwrap();
    assert_eq!(imported.view(&scope, &history).unwrap().pins.len(), 2);
}

fn record() -> ResearchRecord {
    let query = ResearchQuery {
        query: "秦朝年代".into(),
        topic: ResearchTopic::Chronology,
        era: None,
        entity_tags: vec![],
        region: None,
    };
    ResearchRecord {
        id: "review-record-01".into(),
        cache_key: query.cache_key("review_fixed_v1").unwrap(),
        provider_namespace: "review_fixed_v1".into(),
        query,
        sources: vec![ResearchSource {
            id: "review-source-01".into(),
            title: "固定资料".into(),
            url: "https://sources.invalid/one".into(),
            excerpt: "固定摘录，不代表考证结果".into(),
            excerpt_origin: ExcerptOrigin::SearchSnippet,
            accessed_at_ms: 1,
            requested_era: None,
            entity_tags: vec![],
        }],
        conclusions: vec![],
        created_at_ms: 1,
    }
}

fn bundle() -> WorldResearchBundle {
    let record = record();
    WorldResearchBundle {
        version: 1,
        world_id: WORLD.into(),
        watermark: 101,
        adoptions: vec![ResearchAdoption {
            id: "review-adoption-old".into(),
            world_id: WORLD.into(),
            origin_branch_id: "main".into(),
            head_turn_id: None,
            record_id: record.id.clone(),
            source_ids: vec!["review-source-01".into()],
            evidence: record,
            change_seq: 3,
            created_at_ms: 1,
        }],
    }
}

#[test]
fn research_restore_keeps_sparse_high_watermark_new_adoption_and_fork_isolation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("evidence.sqlite");
    let history = history();
    let main = ResearchScope::single(context("main"));
    let child = ResearchScope {
        context: context("review-child-branch"),
        branch_path: vec![
            ResearchBranchAccess {
                branch_id: "main".into(),
                through_turn_id: None,
                through_change_seq: Some(101),
            },
            ResearchBranchAccess {
                branch_id: "review-child-branch".into(),
                through_turn_id: None,
                through_change_seq: None,
            },
        ],
    };
    let bundle = bundle();
    bundle
        .validate_scopes(&[(&main, &history), (&child, &history)])
        .unwrap();
    let store = ResearchStore::open_sidecar(&path).unwrap();
    store.restore_world_bundle(&bundle).unwrap();
    assert_eq!(store.watermark().unwrap(), 101);
    assert_eq!(store.export_world_bundle(WORLD).unwrap(), bundle);
    assert_eq!(store.config_revision().unwrap(), 0);
    assert!(store.stored_config().unwrap().is_none());
    assert!(store.record("review-record-01").unwrap().is_none());
    let added = store
        .adopt_record(
            &main,
            &history,
            "review-adoption-new",
            &record(),
            &["review-source-01".into()],
        )
        .unwrap();
    assert_eq!(added.change_seq, 102);
    assert_eq!(store.adopted(&child, &history).unwrap(), bundle.adoptions);
    assert_eq!(store.adopted(&main, &history).unwrap().len(), 2);
    drop(store);
    let reopened = ResearchStore::open_sidecar(&path).unwrap();
    assert_eq!(reopened.watermark().unwrap(), 102);
    assert_eq!(
        reopened.adopted(&child, &history).unwrap(),
        bundle.adoptions
    );
}

#[test]
fn research_bundle_rejects_missing_origins_invalid_heads_or_fork_future_watermark() {
    let history = history();
    let main = ResearchScope::single(context("main"));
    for mutate in 0..4 {
        let mut value = bundle();
        match mutate {
            0 => value.adoptions[0].origin_branch_id = "missing-branch".into(),
            1 => value.adoptions[0].head_turn_id = Some("missing-turn".into()),
            2 => value.adoptions[0].world_id = "other-world".into(),
            _ => value.watermark = 2,
        }
        assert!(value.validate_scopes(&[(&main, &history)]).is_err());
    }
    let branch = ResearchScope {
        context: context("review-child-branch"),
        branch_path: vec![
            ResearchBranchAccess {
                branch_id: "main".into(),
                through_turn_id: None,
                through_change_seq: Some(102),
            },
            ResearchBranchAccess {
                branch_id: "review-child-branch".into(),
                through_turn_id: None,
                through_change_seq: None,
            },
        ],
    };
    assert!(bundle()
        .validate_scopes(&[(&main, &history), (&branch, &history)])
        .is_err());
}
