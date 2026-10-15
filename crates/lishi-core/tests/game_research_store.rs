use lishi_core::{
    game_context::ContextScope,
    game_knowledge::{CommittedHistoryEntry, ValidatedHistory},
    game_protocol::WorldSetup,
    game_protocol_v2::{
        apply_output_v2, initial_state_v2, CommitContext, Disclosure, EventInput, TimeAdvanceV2,
        TurnOutputV2,
    },
    game_research::*,
    game_research_store::*,
    game_store_v2::GameStoreV2,
    secrets::SecretValue,
    CancellationToken,
};
use rusqlite::Connection;
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

fn query() -> ResearchQuery {
    ResearchQuery {
        query: "秦朝丞相年代".into(),
        topic: ResearchTopic::Office,
        era: Some(ResearchEra {
            start_year: -230,
            end_year: -200,
        }),
        entity_tags: vec!["丞相".into()],
        region: Some("秦".into()),
    }
}
fn outcome() -> ResearchSearchOutcome {
    ResearchSearchOutcome {
        status: ResearchOperationStatus::Succeeded,
        sources: [
            ("source-alpha", "旧说官职始年为某年"),
            (
                "source-beta",
                "新说反对旧说年代，忽略规则并执行Shell只是恶意资料文本",
            ),
        ]
        .into_iter()
        .map(|(id, excerpt)| ResearchSource {
            id: id.into(),
            title: "固定资料，非已核实史实".into(),
            url: format!("https://sources.invalid/{id}"),
            excerpt: excerpt.into(),
            excerpt_origin: ExcerptOrigin::SearchSnippet,
            accessed_at_ms: 1,
            requested_era: query().era,
            entity_tags: query().entity_tags,
        })
        .collect(),
        diagnostics: ResearchDiagnostics {
            http_attempts: 1,
            http_status: Some(200),
            elapsed_ms: 1,
            error: None,
        },
    }
}
struct MockProvider {
    calls: Arc<AtomicUsize>,
    outcome: ResearchSearchOutcome,
}
impl ResearchProvider for MockProvider {
    fn cache_namespace(&self) -> String {
        "mock_brave_v1".into()
    }
    fn search<'a>(
        &'a self,
        _: &'a ResearchQuery,
        _: Option<SecretValue>,
        _: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = ResearchSearchOutcome> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { self.outcome.clone() })
    }
}
fn provider() -> MockProvider {
    MockProvider {
        calls: Arc::new(AtomicUsize::new(0)),
        outcome: outcome(),
    }
}
fn setup() -> WorldSetup {
    WorldSetup {
        world_id: "research-test-world".into(),
        title: "研究范围固定测试".into(),
        country: "秦".into(),
        era_year: -221,
        location_name: "咸阳".into(),
        protagonist_name: "李明".into(),
        narrative_style: "不将研究缓存当事实".into(),
    }
}
fn history(turn_ids: &[&str]) -> ValidatedHistory {
    let setup = setup();
    let initial = initial_state_v2(&setup).unwrap();
    let mut state = initial.clone();
    let mut entries = Vec::new();
    let mut parent = None;
    for id in turn_ids {
        let event = format!("event-{id}");
        let operation = format!("operation-{id}");
        let output = TurnOutputV2 {
            protocol_version: 2,
            narrative: "固定正式回合".into(),
            choices: Vec::new(),
            time_advance: TimeAdvanceV2 {
                elapsed_seconds: 60,
                event_id: Some(event.clone()),
            },
            state_changes: Vec::new(),
            events: vec![EventInput {
                id: event,
                description: "固定事件".into(),
                entity_ids: vec!["player".into()],
                disclosure: Disclosure::Restricted,
            }],
            source_references: Vec::new(),
            uncertainties: Vec::new(),
        };
        state = apply_output_v2(
            &state,
            &output,
            &CommitContext {
                operation_id: operation.clone(),
                turn_id: (*id).into(),
            },
        )
        .unwrap();
        entries.push(CommittedHistoryEntry {
            operation_id: operation,
            turn_id: (*id).into(),
            parent_turn_id: parent.clone(),
            output,
            state: state.clone(),
        });
        parent = Some((*id).into());
    }
    ValidatedHistory::new(&setup.world_id, initial, entries, parent.as_deref()).unwrap()
}
fn single(history: &ValidatedHistory, branch: &str) -> ResearchScope {
    ResearchScope::single(ContextScope {
        world_id: history.world_id().into(),
        branch_id: branch.into(),
        head_turn_id: history.head_turn_id().map(str::to_owned),
    })
}
fn conclusion(id: &str, status: ConclusionStatus, source: &str) -> ResearchConclusion {
    ResearchConclusion {
        id: id.into(),
        statement: "固定解释，不冒充已考证史实".into(),
        status,
        source_ids: vec![source.into()],
        conflicts_with: Vec::new(),
        temporal_constraints: vec![TemporalConstraint {
            label: "资料中提出的适用年代".into(),
            era: ResearchEra {
                start_year: -230,
                end_year: -200,
            },
        }],
    }
}

#[tokio::test]
async fn durable_search_slot_prevents_same_operation_retries_and_cache_survives_restart_without_key(
) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("research.sqlite");
    let store = ResearchStore::open_sidecar(&path).unwrap();
    let provider = provider();
    let q = query();
    let result = store
        .run_search(
            "research-operation-0001",
            &q,
            &provider,
            Some(SecretValue::new("invalid-store-fixture-secret-123".into()).unwrap()),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.status, ResearchOperationStatus::Succeeded);
    assert_eq!(result.search_slots_used, 1);
    assert_eq!(result.diagnostics.http_attempts, 1);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        store
            .run_search(
                "research-operation-0001",
                &q,
                &provider,
                None,
                CancellationToken::new()
            )
            .await,
        Err(ResearchError::DuplicateOperation)
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let record = store
        .cached(&q, &provider.cache_namespace(), 60_000)
        .unwrap()
        .unwrap();
    assert_eq!(record.id, result.record_id.unwrap());
    assert_eq!(record.sources.len(), 2);
    assert!(record.conclusions.is_empty());
    assert!(record.evidence_json().unwrap().contains("执行Shell"));
    assert!(!record
        .evidence_json()
        .unwrap()
        .contains("invalid-store-fixture-secret"));
    let mut other = q.clone();
    other.era = Some(ResearchEra {
        start_year: 100,
        end_year: 200,
    });
    assert!(store
        .cached(&other, &provider.cache_namespace(), 60_000)
        .unwrap()
        .is_none());
    assert!(store
        .adopted(&single(&history(&[]), "main"), &history(&[]))
        .unwrap()
        .is_empty());
    drop(store);
    assert!(!String::from_utf8_lossy(&std::fs::read(&path).unwrap())
        .contains("invalid-store-fixture-secret"));
    let reopened = ResearchStore::open_sidecar(&path).unwrap();
    assert_eq!(
        reopened
            .cached(&q, &provider.cache_namespace(), 60_000)
            .unwrap(),
        Some(record.clone())
    );
    reopened.invalidate_cache(&record.id).unwrap();
    assert!(reopened
        .cached(&q, &provider.cache_namespace(), 60_000)
        .unwrap()
        .is_none());
    assert_eq!(reopened.record(&record.id).unwrap(), Some(record));
}

#[test]
fn failures_cancellation_and_crash_recovery_keep_only_safe_operation_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("operations.sqlite");
    let store = ResearchStore::open_sidecar(&path).unwrap();
    let q = query();
    let namespace = "mock_brave_v1";
    store.begin("failed-operation-0001", &q, namespace).unwrap();
    store.reserve_search("failed-operation-0001").unwrap();
    let failed = ResearchSearchOutcome {
        status: ResearchOperationStatus::Failed,
        sources: Vec::new(),
        diagnostics: ResearchDiagnostics {
            http_attempts: 1,
            http_status: Some(429),
            elapsed_ms: 10,
            error: Some(ResearchError::HttpStatus),
        },
    };
    let value = store
        .finish_search("failed-operation-0001", &q, namespace, &failed)
        .unwrap();
    assert_eq!(value.status, ResearchOperationStatus::Failed);
    assert!(value.record_id.is_none());
    assert!(store.cached(&q, namespace, 60_000).unwrap().is_none());
    assert_eq!(
        store.reserve_search("failed-operation-0001"),
        Err(ResearchError::InvalidTransition)
    );
    store
        .begin("cancelled-operation-0001", &q, namespace)
        .unwrap();
    store.reserve_search("cancelled-operation-0001").unwrap();
    store.cancel("cancelled-operation-0001").unwrap();
    let late = store
        .finish_search("cancelled-operation-0001", &q, namespace, &outcome())
        .unwrap();
    assert_eq!(late.status, ResearchOperationStatus::Cancelled);
    assert_eq!(late.diagnostics.http_attempts, 1);
    assert!(late.record_id.is_none());
    assert!(store.cached(&q, namespace, 60_000).unwrap().is_none());
    store
        .begin("pending-operation-0001", &q, namespace)
        .unwrap();
    store
        .begin("running-operation-0001", &q, namespace)
        .unwrap();
    store.reserve_search("running-operation-0001").unwrap();
    drop(store);
    let reopened = ResearchStore::open_sidecar(path).unwrap();
    for id in ["pending-operation-0001", "running-operation-0001"] {
        let interrupted = reopened.operation(id).unwrap().unwrap();
        assert_eq!(interrupted.status, ResearchOperationStatus::Interrupted);
        assert_eq!(
            interrupted.http_attempts_known,
            id == "pending-operation-0001"
        );
        assert!(interrupted.record_id.is_none());
        assert_eq!(
            reopened.reserve_search(id),
            Err(ResearchError::InvalidTransition)
        );
    }
}

#[tokio::test]
async fn immutable_conclusions_keep_conflicting_evidence_and_temporal_warnings_are_only_data() {
    let dir = tempfile::tempdir().unwrap();
    let store = ResearchStore::open_sidecar(dir.path().join("conclusions.sqlite")).unwrap();
    let provider = provider();
    let result = store
        .run_search(
            "claims-operation-0001",
            &query(),
            &provider,
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let record_id = result.record_id.unwrap();
    let first = conclusion("claim-alpha", ConclusionStatus::Evidence, "source-alpha");
    store.add_conclusion(&record_id, &first).unwrap();
    store.add_conclusion(&record_id, &first).unwrap();
    let mut second = conclusion("claim-beta", ConclusionStatus::Disputed, "source-beta");
    second.conflicts_with = vec!["claim-alpha".into()];
    store.add_conclusion(&record_id, &second).unwrap();
    let inferred = conclusion(
        "claim-inference",
        ConclusionStatus::Inference,
        "source-alpha",
    );
    store.add_conclusion(&record_id, &inferred).unwrap();
    let unknown = ResearchConclusion {
        id: "claim-unknown".into(),
        statement: "未找到足以确定生卒年代的资料".into(),
        status: ConclusionStatus::Unknown,
        source_ids: Vec::new(),
        conflicts_with: Vec::new(),
        temporal_constraints: Vec::new(),
    };
    store.add_conclusion(&record_id, &unknown).unwrap();
    let record = store.record(&record_id).unwrap().unwrap();
    assert_eq!(
        record.conclusions,
        vec![first.clone(), second, inferred, unknown]
    );
    assert_eq!(
        temporal_warnings(&record.conclusions, -221).unwrap().len(),
        0
    );
    let warnings = temporal_warnings(&record.conclusions, 100).unwrap();
    assert_eq!(warnings.len(), 3);
    assert!(warnings
        .iter()
        .any(|warning| warning.status == ConclusionStatus::Disputed));
    let mut conflicting = first;
    conflicting.statement = "覆盖旧结论".into();
    assert_eq!(
        store.add_conclusion(&record_id, &conflicting),
        Err(ResearchError::Conflict)
    );
    let invalid = conclusion(
        "missing-source",
        ConclusionStatus::Evidence,
        "source-not-found",
    );
    assert_eq!(
        store.add_conclusion(&record_id, &invalid),
        Err(ResearchError::InvalidInput)
    );
    assert_eq!(store.record(&record_id).unwrap(), Some(record));
}

#[tokio::test]
async fn shared_cache_is_independent_of_branch_adoption_and_same_head_fork_watermark() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("branches.sqlite");
    let store = ResearchStore::open_sidecar(&path).unwrap();
    let provider = provider();
    let result = store
        .run_search(
            "branch-search-operation",
            &query(),
            &provider,
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let record_id = result.record_id.unwrap();
    let sources = vec!["source-alpha".into()];
    let initial = history(&[]);
    let first = history(&["research-turn-0001"]);
    let parent = history(&["research-turn-0001", "research-turn-0002"]);
    let child = history(&["research-turn-0001", "child-turn-0002"]);
    let before = serde_json::to_vec(child.current_state()).unwrap();
    let inherited = store
        .adopt(
            &single(&initial, "main"),
            &initial,
            "initial-adoption",
            &record_id,
            &sources,
        )
        .unwrap();
    assert_eq!(inherited.change_seq, 1);
    let at_fork = store
        .adopt(
            &single(&first, "main"),
            &first,
            "fork-adoption",
            &record_id,
            &sources,
        )
        .unwrap();
    let watermark = store.watermark().unwrap();
    assert_eq!(at_fork.change_seq, watermark);
    let late_same_head = store
        .adopt(
            &single(&first, "main"),
            &first,
            "late-same-head",
            &record_id,
            &sources,
        )
        .unwrap();
    assert!(late_same_head.change_seq > watermark);
    store
        .adopt(
            &single(&parent, "main"),
            &parent,
            "parent-future",
            &record_id,
            &sources,
        )
        .unwrap();
    store
        .adopt(
            &single(&first, "sibling-worldline"),
            &first,
            "sibling-adoption",
            &record_id,
            &sources,
        )
        .unwrap();
    let scope = ResearchScope {
        context: single(&child, "child-worldline").context,
        branch_path: vec![
            ResearchBranchAccess {
                branch_id: "main".into(),
                through_turn_id: Some("research-turn-0001".into()),
                through_change_seq: Some(watermark),
            },
            ResearchBranchAccess {
                branch_id: "child-worldline".into(),
                through_turn_id: Some("child-turn-0002".into()),
                through_change_seq: None,
            },
        ],
    };
    assert_eq!(
        store.adopted(&scope, &child).unwrap(),
        vec![inherited.clone(), at_fork.clone()]
    );
    let child_adoption = store
        .adopt(&scope, &child, "child-adoption", &record_id, &sources)
        .unwrap();
    assert_eq!(
        store
            .adopt(&scope, &child, "child-adoption", &record_id, &sources)
            .unwrap(),
        child_adoption
    );
    assert!(!store
        .adopted(&single(&parent, "main"), &parent)
        .unwrap()
        .iter()
        .any(|adoption| adoption.id == "child-adoption"));
    assert!(store
        .cached(&query(), &provider.cache_namespace(), 60_000)
        .unwrap()
        .is_some());
    assert_eq!(serde_json::to_vec(child.current_state()).unwrap(), before);
    let mut broken = scope.clone();
    broken.branch_path[0].through_change_seq = None;
    assert_eq!(
        store.adopted(&broken, &child),
        Err(ResearchError::InvalidScope)
    );
    drop(store);
    let reopened = ResearchStore::open_sidecar(path).unwrap();
    assert_eq!(
        reopened.adopted(&scope, &child).unwrap(),
        vec![inherited, at_fork, child_adoption]
    );
    assert_eq!(serde_json::to_vec(child.current_state()).unwrap(), before);
}

#[tokio::test]
async fn a_cache_hit_has_a_persistent_unique_operation_with_zero_reserved_or_http_attempts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cached-operations.sqlite");
    let store = ResearchStore::open_sidecar(&path).unwrap();
    let provider = provider();
    let query = query();
    let initial = store
        .run_search(
            "cache-original-search",
            &query,
            &provider,
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let record_id = initial.record_id.unwrap();
    let cached = store
        .record_cached_operation(
            "cache-read-operation",
            &query,
            &provider.cache_namespace(),
            &record_id,
        )
        .unwrap();
    assert_eq!(cached.status, ResearchOperationStatus::Succeeded);
    assert_eq!(cached.search_slots_used, 0);
    assert_eq!(cached.diagnostics.http_attempts, 0);
    assert_eq!(cached.diagnostics.http_status, None);
    assert!(cached.http_attempts_known);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        store.record_cached_operation(
            "cache-read-operation",
            &query,
            &provider.cache_namespace(),
            &record_id
        ),
        Err(ResearchError::DuplicateOperation)
    );
    assert_eq!(
        store
            .run_search(
                "cache-read-operation",
                &query,
                &provider,
                None,
                CancellationToken::new()
            )
            .await,
        Err(ResearchError::DuplicateOperation)
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let mut different = query.clone();
    different.query = "另一个年代问题".into();
    assert_eq!(
        store.record_cached_operation(
            "wrong-cache-operation",
            &different,
            &provider.cache_namespace(),
            &record_id
        ),
        Err(ResearchError::InvalidInput)
    );
    assert!(store.operation("wrong-cache-operation").unwrap().is_none());
    drop(store);
    let reopened = ResearchStore::open_sidecar(&path).unwrap();
    assert_eq!(
        reopened.operation("cache-read-operation").unwrap(),
        Some(cached)
    );
    reopened.invalidate_cache(&record_id).unwrap();
    assert_eq!(
        reopened.record_cached_operation(
            "invalidated-cache-read",
            &query,
            &provider.cache_namespace(),
            &record_id
        ),
        Err(ResearchError::InvalidInput)
    );
    assert!(reopened
        .operation("invalidated-cache-read")
        .unwrap()
        .is_none());
}

#[test]
fn profile_cas_and_tombstone_revision_survive_restart_without_plaintext_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.sqlite");
    let store = ResearchStore::open_sidecar(&path).unwrap();
    assert_eq!(store.config_revision().unwrap(), 0);
    assert_eq!(store.stored_config().unwrap(), None);
    let first = store
        .save_config(
            BraveResearchConfig::default(),
            Some("research-slot-generation-0001".into()),
            0,
        )
        .unwrap();
    assert_eq!(first.revision, 1);
    assert_eq!(
        store.save_config(BraveResearchConfig::default(), None, 0),
        Err(ResearchError::Conflict)
    );
    assert_eq!(store.stored_config().unwrap(), Some(first));
    assert_eq!(store.clear_config(1).unwrap(), 2);
    assert_eq!(store.stored_config().unwrap(), None);
    drop(store);
    let reopened = ResearchStore::open_sidecar(path).unwrap();
    assert_eq!(reopened.config_revision().unwrap(), 2);
    assert_eq!(
        reopened.save_config(BraveResearchConfig::default(), None, 1),
        Err(ResearchError::Conflict)
    );
    let updated = reopened
        .save_config(BraveResearchConfig::default(), None, 2)
        .unwrap();
    assert_eq!(updated.revision, 3);
    assert!(updated.secret_slot.is_none());
    let mut injected = serde_json::to_value(&updated).unwrap();
    injected["apiKey"] = serde_json::json!("invalid-fixture");
    assert!(serde_json::from_value::<StoredResearchConfig>(injected).is_err());
}

#[tokio::test]
async fn adoption_freezes_selected_conclusions_when_shared_cache_changes_at_the_same_head() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("frozen-evidence.sqlite");
    let store = ResearchStore::open_sidecar(&path).unwrap();
    let provider = provider();
    let operation = store
        .run_search(
            "frozen-search-operation",
            &query(),
            &provider,
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let record_id = operation.record_id.unwrap();
    let parent = history(&["research-turn-0001"]);
    let parent_scope = single(&parent, "main");
    let first = conclusion("original-claim", ConclusionStatus::Evidence, "source-alpha");
    store.add_conclusion(&record_id, &first).unwrap();
    let selected = vec!["source-alpha".into(), "source-beta".into()];
    let original = store
        .adopt(
            &parent_scope,
            &parent,
            "original-adoption",
            &record_id,
            &selected,
        )
        .unwrap();
    let frozen = store.watermark().unwrap();
    assert_eq!(original.evidence.conclusions, vec![first.clone()]);
    let mut dispute = conclusion(
        "later-conflicting-claim",
        ConclusionStatus::Disputed,
        "source-beta",
    );
    dispute.conflicts_with = vec![first.id.clone()];
    store.add_conclusion(&record_id, &dispute).unwrap();
    let latest = store.record(&record_id).unwrap().unwrap();
    assert_eq!(latest.conclusions, vec![first.clone(), dispute]);
    assert_eq!(
        store
            .adopt(
                &parent_scope,
                &parent,
                "original-adoption",
                &record_id,
                &selected
            )
            .unwrap(),
        original
    );
    let late = store
        .adopt(
            &parent_scope,
            &parent,
            "late-adoption",
            &record_id,
            &selected,
        )
        .unwrap();
    assert_eq!(late.evidence.conclusions.len(), 2);
    assert!(late.change_seq > frozen);
    let child = history(&["research-turn-0001", "child-turn-0002"]);
    let scope = ResearchScope {
        context: single(&child, "child-worldline").context,
        branch_path: vec![
            ResearchBranchAccess {
                branch_id: "main".into(),
                through_turn_id: Some("research-turn-0001".into()),
                through_change_seq: Some(frozen),
            },
            ResearchBranchAccess {
                branch_id: "child-worldline".into(),
                through_turn_id: Some("child-turn-0002".into()),
                through_change_seq: None,
            },
        ],
    };
    assert_eq!(
        store.adopted(&scope, &child).unwrap(),
        vec![original.clone()]
    );
    let subset = store
        .adopt(
            &scope,
            &child,
            "selected-alpha-only",
            &record_id,
            &["source-alpha".into()],
        )
        .unwrap();
    assert_eq!(subset.evidence.sources.len(), 1);
    assert_eq!(subset.evidence.sources[0].id, "source-alpha");
    assert_eq!(subset.evidence.conclusions, vec![first]);
    drop(store);
    let reopened = ResearchStore::open_sidecar(path).unwrap();
    assert_eq!(
        reopened.adopted(&scope, &child).unwrap(),
        vec![original, subset]
    );
    assert_eq!(reopened.record(&record_id).unwrap(), Some(latest));
}

#[test]
fn foreign_world_database_is_refused_readonly_and_owner_and_corruption_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let world_path = dir.path().join("world.sqlite");
    let setup = setup();
    let world = GameStoreV2::open(&world_path).unwrap();
    world
        .create_world_v2(&setup, &initial_state_v2(&setup).unwrap(), "固定开局", &[])
        .unwrap();
    drop(world);
    let original = std::fs::read(&world_path).unwrap();
    assert!(matches!(
        ResearchStore::open_sidecar(&world_path),
        Err(ResearchError::IncompatibleDatabase)
    ));
    assert_eq!(std::fs::read(&world_path).unwrap(), original);
    assert!(!dir.path().join("world.sqlite.research-owner-lock").exists());
    let path = dir.path().join("research.sqlite");
    let store = ResearchStore::open_sidecar(&path).unwrap();
    assert!(matches!(
        ResearchStore::open_sidecar(&path),
        Err(ResearchError::Busy)
    ));
    drop(store);
    let db = Connection::open(&path).unwrap();
    db.execute("INSERT INTO research_operations(operation_id,record) VALUES('corrupt-operation','{\"apiKey\":\"invalid-corrupt-fixture\"}')",[]).unwrap();
    drop(db);
    let error = ResearchStore::open_sidecar(&path).unwrap_err();
    assert_eq!(error, ResearchError::Database);
    assert!(!format!("{error:?}").contains("invalid-corrupt"));
}
