//! Native M04/M05 integration fixtures. All credentials are synthetic and all
//! model HTTP stays on an ephemeral literal-loopback listener.
use super::*;
use lishi_core::{
    game_branches::ForkBranchRequest,
    game_fast_forward::{
        ContinueFastForwardRequest, DecisionResumeRequest, FastForwardJob, FastForwardStatus,
        StartFastForwardRequest,
    },
    game_research::{
        BraveResearchConfig, BraveResearchProvider, ConclusionStatus, ExcerptOrigin,
        ResearchConclusion, ResearchDiagnostics, ResearchOperationStatus, ResearchProvider,
        ResearchQuery, ResearchSearchOutcome, ResearchSource, ResearchTopic,
    },
    game_store::GameActionKind,
    game_store_v2::GameStoreV2,
    secrets::SecretStoreError,
};
use std::{
    future::Future,
    io::{Read, Write},
    net::TcpListener,
    pin::Pin,
    sync::atomic::AtomicUsize,
};

#[derive(Default)]
struct FixtureSecrets {
    values: Mutex<BTreeMap<String, String>>,
    loads: AtomicUsize,
}
impl SecretStore for FixtureSecrets {
    fn save(&self, slot: &SecretSlot, value: &SecretValue) -> Result<(), SecretStoreError> {
        self.values
            .lock()
            .unwrap()
            .insert(slot.as_str().into(), value.expose_secret().into());
        Ok(())
    }
    fn load(&self, slot: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        self.values
            .lock()
            .unwrap()
            .get(slot.as_str())
            .cloned()
            .map(SecretValue::new)
            .transpose()
    }
    fn delete(&self, slot: &SecretSlot) -> Result<(), SecretStoreError> {
        self.values.lock().unwrap().remove(slot.as_str());
        Ok(())
    }
}
fn setup() -> WorldSetup {
    WorldSetup {
        world_id: "milestone-native-world".into(),
        title: "原生里程碑固定夹具".into(),
        country: "唐".into(),
        era_year: 748,
        location_name: "长安".into(),
        protagonist_name: "李安".into(),
        narrative_style: "简短，明确不确定性".into(),
    }
}
fn create(service: &GameService) -> Arc<StoreRoute> {
    let setup = setup();
    let route = service.store(&setup.world_id, true).unwrap();
    route.create_world(&setup).unwrap();
    std::fs::create_dir_all(&service.backups).unwrap();
    core(&route)
        .enable_branches(&service.backups, None)
        .unwrap();
    route
}
fn core(route: &StoreRoute) -> &GameStoreV2 {
    match route {
        StoreRoute::V2(store) => store,
        _ => panic!("fixture must be v2/v3"),
    }
}
fn action(id: &str, branch: &str, head: Option<String>, text: &str) -> GameTurnRequest {
    GameTurnRequest {
        operation_id: id.into(),
        world_id: setup().world_id,
        branch_id: branch.into(),
        expected_head_turn_id: head,
        action_kind: GameActionKind::Action,
        action_text: text.into(),
    }
}
fn progress(id: &str) -> Progress {
    Progress {
        channel: Channel::new(|_| Ok(())),
        id: id.into(),
        sequence: 0,
    }
}
async fn demo_action(
    service: &Arc<GameService>,
    route: &Arc<StoreRoute>,
    request: GameTurnRequest,
) -> WorldReply {
    let lease = service
        .turn_lease(Arc::clone(route), &request.operation_id)
        .unwrap();
    let p = progress(&request.operation_id);
    run_turn(lease, request, ProviderKind::Demo, p)
        .await
        .unwrap()
}
fn fork(route: &StoreRoute, child: &str, watermark: u64) {
    let store = core(route);
    let main = store.view_branch("main").unwrap();
    let card = store
        .list_branches()
        .unwrap()
        .into_iter()
        .find(|b| b.branch_id == "main")
        .unwrap();
    store
        .fork_branch_with_watermarks(
            &ForkBranchRequest {
                world_id: setup().world_id,
                source_branch_id: "main".into(),
                expected_head_turn_id: main.head_turn_id.clone(),
                expected_revision: card.revision,
                operation_id: format!("fork-operation-{child}"),
                new_branch_id: child.into(),
                name: "固定子分支".into(),
                fork_turn_id: main.head_turn_id,
            },
            0,
            watermark,
        )
        .unwrap();
}
fn start(route: &StoreRoute, id: &str, target: u64, limit: u64, focus: &str) -> FastForwardJob {
    let store = core(route);
    store.ensure_fast_forward_backend().unwrap();
    store
        .start_fast_forward(&StartFastForwardRequest {
            world_id: setup().world_id,
            branch_id: "main".into(),
            job_id: id.into(),
            expected_head_turn_id: store.view_branch("main").unwrap().head_turn_id,
            target_elapsed_seconds: target,
            max_segment_seconds: limit,
            focus: focus.into(),
        })
        .unwrap()
}
fn continuation(job: &FastForwardJob, id: &str) -> ContinueFastForwardRequest {
    ContinueFastForwardRequest {
        world_id: job.world_id.clone(),
        branch_id: job.branch_id.clone(),
        job_id: job.job_id.clone(),
        operation_id: id.into(),
        expected_head_turn_id: job.head_turn_id.clone(),
        expected_job_revision: job.revision,
    }
}
async fn demo_segment(
    service: &Arc<GameService>,
    route: &Arc<StoreRoute>,
    job: &FastForwardJob,
    id: &str,
) -> lishi_core::game_fast_forward::FastForwardCommit {
    let request = continuation(job, id);
    let lease = service.turn_lease(Arc::clone(route), id).unwrap();
    fast_forward_commands::run_segment(lease, request, ProviderKind::Demo)
        .await
        .unwrap()
}

#[tokio::test]
async fn native_branch_turn_and_cancel_return_selected_world_without_touching_parent() {
    let dir = tempfile::tempdir().unwrap();
    let service =
        Arc::new(GameService::open(dir.path(), Arc::new(FixtureSecrets::default())).unwrap());
    let route = create(&service);
    fork(&route, "native-child-one", 0);
    let before = core(&route).view_branch("main").unwrap();
    let committed = demo_action(
        &service,
        &route,
        action(
            "child-native-action",
            "native-child-one",
            None,
            "做短工赚钱",
        ),
    )
    .await;
    let WorldReply::V2(child) = committed else {
        panic!("wrong route")
    };
    assert_eq!(child.branch_id, "native-child-one");
    assert_eq!(child.turn_count, 1);
    assert_ne!(child.state, before.state);
    assert_eq!(core(&route).view_branch("main").unwrap(), before);
    let request = action(
        "child-native-cancel",
        "native-child-one",
        child.head_turn_id.clone(),
        "购买补给",
    );
    let lease = service
        .turn_lease(Arc::clone(&route), &request.operation_id)
        .unwrap();
    lease.cancel.cancel();
    let p = progress(&request.operation_id);
    let WorldReply::V2(cancelled) = run_turn(lease, request.clone(), ProviderKind::Demo, p)
        .await
        .unwrap()
    else {
        panic!("wrong cancel route")
    };
    assert_eq!(cancelled.branch_id, child.branch_id);
    assert_eq!(cancelled.state, child.state);
    assert_eq!(cancelled.head_turn_id, child.head_turn_id);
    assert_eq!(
        cancelled.latest_operation.unwrap().status,
        GameOperationStatus::Cancelled
    );
    assert_eq!(core(&route).view_branch("main").unwrap(), before);
    assert_eq!(route.begin(&request).unwrap_err().code, "game_duplicate");
    assert!(service.active.lock().unwrap().is_none());
}

#[tokio::test]
async fn native_fast_forward_commits_only_explicit_segments_and_reopens_completed_job() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(FixtureSecrets::default());
    let service = Arc::new(GameService::open(dir.path(), secrets.clone()).unwrap());
    let route = create(&service);
    let initial = core(&route).view_branch("main").unwrap();
    let job = start(&route, "native-ff-target-job", 20, 10, "日常");
    let first = demo_segment(&service, &route, &job, "native-ff-target-one").await;
    assert_eq!(first.job.status, FastForwardStatus::SegmentLimit);
    assert_eq!(first.world.state.time.elapsed_seconds, 10);
    assert_eq!(first.job.segments_committed, 1);
    assert_eq!(first.job.model_requests_reserved, 0);
    tokio::time::sleep(Duration::from_millis(210)).await;
    assert_eq!(
        core(&route).get_fast_forward_job(&job.job_id).unwrap(),
        first.job
    );
    let done = demo_segment(&service, &route, &first.job, "native-ff-target-two").await;
    assert_eq!(done.job.status, FastForwardStatus::Completed);
    assert_eq!(done.world.state.time.elapsed_seconds, 20);
    assert_eq!(done.world.state.item_holdings, initial.state.item_holdings);
    assert_eq!(done.job.model_requests_reserved, 0);
    assert_eq!(secrets.loads.load(Ordering::SeqCst), 0);
    let expected = done.world;
    drop(route);
    drop(service);
    let reopened = GameService::open(dir.path(), secrets).unwrap();
    let route = reopened.store(&setup().world_id, false).unwrap();
    assert_eq!(core(&route).view_branch("main").unwrap(), expected);
    assert_eq!(
        core(&route).get_fast_forward_job(&job.job_id).unwrap(),
        done.job
    );
    assert!(reopened.active.lock().unwrap().is_none());
}

#[tokio::test]
async fn native_fast_forward_pauses_before_choice_and_requires_a_separate_committed_action() {
    let dir = tempfile::tempdir().unwrap();
    let service =
        Arc::new(GameService::open(dir.path(), Arc::new(FixtureSecrets::default())).unwrap());
    let route = create(&service);
    let job = start(
        &route,
        "native-ff-decision-job",
        100_000,
        120,
        "遇到决策暂停",
    );
    let paused = demo_segment(&service, &route, &job, "native-ff-decision-one").await;
    assert_eq!(paused.job.status, FastForwardStatus::PausedDecision);
    assert_eq!(paused.world.turn_count, 1);
    assert_eq!(paused.world.state.time.elapsed_seconds, 120);
    assert_eq!(
        paused.job.decision.as_ref().unwrap().choice_ids,
        paused
            .world
            .turns
            .last()
            .unwrap()
            .choices
            .iter()
            .map(|c| c.id.clone())
            .collect::<Vec<_>>()
    );
    let invalid = DecisionResumeRequest {
        world_id: setup().world_id,
        branch_id: "main".into(),
        job_id: job.job_id.clone(),
        decision_turn_id: "native-ff-decision-one".into(),
        expected_job_revision: paused.job.revision,
    };
    assert!(core(&route)
        .resume_fast_forward_after_decision(&invalid)
        .is_err());
    assert!(core(&route)
        .begin_fast_forward_segment(&continuation(&paused.job, "native-ff-auto-forbidden"))
        .is_err());
    let committed = demo_action(
        &service,
        &route,
        action(
            "native-explicit-decision",
            "main",
            paused.world.head_turn_id.clone(),
            "主动了解眼前情况",
        ),
    )
    .await;
    let resumed = core(&route)
        .resume_fast_forward_after_decision(&DecisionResumeRequest {
            decision_turn_id: "native-explicit-decision".into(),
            ..invalid
        })
        .unwrap();
    assert_eq!(resumed.status, FastForwardStatus::Ready);
    assert!(resumed.decision.is_none());
    assert_eq!(resumed.head_turn_id.as_deref(), committed.head_turn_id());
    assert_eq!(resumed.segments_committed, 1);
    assert_eq!(core(&route).view_branch("main").unwrap().turn_count, 2);
}

#[tokio::test]
async fn native_fast_forward_precancel_preserves_state_and_does_not_reserve_model_budget() {
    let dir = tempfile::tempdir().unwrap();
    let service =
        Arc::new(GameService::open(dir.path(), Arc::new(FixtureSecrets::default())).unwrap());
    let route = create(&service);
    let before = core(&route).view_branch("main").unwrap();
    let job = start(&route, "native-ff-cancel-job", 20, 10, "日常");
    let request = continuation(&job, "native-ff-cancel-one");
    let lease = service
        .turn_lease(Arc::clone(&route), &request.operation_id)
        .unwrap();
    lease.cancel.cancel();
    assert_eq!(
        fast_forward_commands::run_segment(lease, request.clone(), ProviderKind::Compatible)
            .await
            .unwrap_err()
            .code,
        "game_cancelled"
    );
    let failed = core(&route).get_fast_forward_job(&job.job_id).unwrap();
    assert_eq!(failed.status, FastForwardStatus::Cancelled);
    assert_eq!(failed.segments_committed, 0);
    assert_eq!(failed.model_requests_reserved, 0);
    let view = core(&route).view_branch("main").unwrap();
    assert_eq!(view.state, before.state);
    assert_eq!(view.head_turn_id, before.head_turn_id);
    assert_eq!(
        view.latest_operation.unwrap().status,
        GameOperationStatus::Cancelled
    );
    assert!(service.active.lock().unwrap().is_none());
    let lease = service
        .turn_lease(Arc::clone(&route), &request.operation_id)
        .unwrap();
    assert!(
        fast_forward_commands::run_segment(lease, request, ProviderKind::Demo)
            .await
            .is_err()
    );
    assert_eq!(
        core(&route).get_fast_forward_job(&job.job_id).unwrap(),
        failed
    );
    assert!(service.active.lock().unwrap().is_none());
}

struct ModelFixture {
    endpoint: String,
    requests: Arc<Mutex<Vec<String>>>,
    worker: Option<std::thread::JoinHandle<()>>,
    stop: Arc<AtomicBool>,
}
impl ModelFixture {
    fn new(output: &str) -> Self {
        Self::with_delay(output, Duration::ZERO)
    }
    fn with_delay(output: &str, delay: Duration) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let capture = Arc::clone(&requests);
        let stop = Arc::new(AtomicBool::new(false));
        let shutdown = Arc::clone(&stop);
        let delta = serde_json::json!({"choices":[{"index":0,"delta":{"content":output},"finish_reason":null}]}).to_string();
        let body = format!("data: {delta}\n\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":17,\"completion_tokens\":9,\"total_tokens\":26}}}}\n\ndata: [DONE]\n\n");
        let worker = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            while !shutdown.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut bytes = Vec::new();
                        let mut expected = None;
                        loop {
                            let mut buffer = [0; 4096];
                            let count = stream.read(&mut buffer).unwrap_or(0);
                            if count == 0 {
                                break;
                            }
                            bytes.extend_from_slice(&buffer[..count]);
                            if expected.is_none() {
                                if let Some(index) = bytes.windows(4).position(|v| v == b"\r\n\r\n")
                                {
                                    let headers = String::from_utf8_lossy(&bytes[..index]);
                                    let length = headers
                                        .lines()
                                        .find_map(|line| {
                                            let (name, value) = line.split_once(':')?;
                                            name.eq_ignore_ascii_case("content-length")
                                                .then(|| value.trim().parse::<usize>().unwrap())
                                        })
                                        .unwrap_or(0);
                                    expected = Some(index + 4 + length);
                                }
                            }
                            if expected.is_some_and(|n| bytes.len() >= n) {
                                break;
                            }
                        }
                        capture
                            .lock()
                            .unwrap()
                            .push(String::from_utf8(bytes).unwrap());
                        std::thread::sleep(delay);
                        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    Err(e) => panic!("loopback fixture accept: {e}"),
                }
            }
        });
        Self {
            endpoint,
            requests,
            worker: Some(worker),
            stop,
        }
    }
    fn captured(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}
impl Drop for ModelFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
fn configure_model(service: &GameService, endpoint: &str) {
    save_provider_sync(
        service,
        endpoint,
        "fixture-model",
        Some(SecretValue::new("synthetic-native-model-key-123".into()).unwrap()),
        0,
        true,
    )
    .unwrap();
}

#[tokio::test]
async fn native_compatible_fast_forward_uses_one_sse_request_and_records_usage() {
    let dir = tempfile::tempdir().unwrap();
    let service =
        Arc::new(GameService::open(dir.path(), Arc::new(FixtureSecrets::default())).unwrap());
    let route = create(&service);
    let job = start(
        &route,
        "native-ff-wire-job",
        20,
        20,
        "查询官职制度，保留不确定性",
    );
    let operation = "native-ff-wire-one";
    let mut generating = job.clone();
    generating.status = FastForwardStatus::Running;
    generating.active_operation_id = Some(operation.into());
    let output = lishi_core::game_fast_forward::demo_fast_forward_segment(
        &generating,
        &core(&route).view().unwrap().state,
        operation,
    )
    .unwrap();
    let fixture = ModelFixture::new(&serde_json::to_string(&output).unwrap());
    // A separately configured but absent search credential must not consume
    // the model credential or prevent the explicit model segment.
    service
        .research()
        .unwrap()
        .save_config(
            BraveResearchConfig::default(),
            Some("research-missing-fixture-slot".into()),
            0,
        )
        .unwrap();
    configure_model(&service, &fixture.endpoint);
    let lease = service.turn_lease(Arc::clone(&route), operation).unwrap();
    let result = fast_forward_commands::run_segment(
        lease,
        continuation(&job, operation),
        ProviderKind::Compatible,
    )
    .await
    .unwrap();
    assert_eq!(result.job.status, FastForwardStatus::Completed);
    assert_eq!(result.job.model_requests_reserved, 1);
    let segments = core(&route).fast_forward_segments(&job.job_id).unwrap();
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0].model_requests_reserved, 1);
    assert_eq!(segments[0].usage.total_tokens, Some(26));
    assert_eq!(segments[0].status, GameOperationStatus::Committed);
    let requests = fixture.captured();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /v1/chat/completions "));
    let (_, body) = requests[0].split_once("\r\n\r\n").unwrap();
    assert!(body.contains("stopReason"));
    assert!(body.contains("历史细节尚不确定"));
    assert!(
        body.contains("output_reserve_tokens")
            || serde_json::from_str::<serde_json::Value>(body).unwrap()["max_tokens"].is_number()
    );
    assert!(!body.contains("synthetic-native-model-key-123"));
    assert!(service.active.lock().unwrap().is_none());
}

#[tokio::test]
async fn native_fast_forward_inflight_cancel_keeps_the_reserved_request_and_never_commits() {
    let dir = tempfile::tempdir().unwrap();
    let service =
        Arc::new(GameService::open(dir.path(), Arc::new(FixtureSecrets::default())).unwrap());
    let route = create(&service);
    let before = core(&route).view().unwrap();
    let job = start(&route, "native-ff-inflight-job", 20, 20, "日常");
    let operation = "native-ff-inflight-one";
    let fixture = ModelFixture::with_delay("{}", Duration::from_millis(350));
    configure_model(&service, &fixture.endpoint);
    let lease = service.turn_lease(Arc::clone(&route), operation).unwrap();
    let cancel = lease.cancel.clone();
    let task = tokio::spawn(fast_forward_commands::run_segment(
        lease,
        continuation(&job, operation),
        ProviderKind::Compatible,
    ));
    for _ in 0..100 {
        if !fixture.captured().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        fixture.captured().len(),
        1,
        "fixture request did not reach the wire"
    );
    assert_eq!(
        service
            .turn_lease(Arc::clone(&route), "native-ff-overlap-denied")
            .err()
            .unwrap()
            .code,
        "game_busy"
    );
    cancel.cancel();
    assert_eq!(task.await.unwrap().unwrap_err().code, "game_cancelled");
    let cancelled = core(&route).get_fast_forward_job(&job.job_id).unwrap();
    assert_eq!(cancelled.status, FastForwardStatus::Cancelled);
    assert_eq!(cancelled.model_requests_reserved, 1);
    assert_eq!(cancelled.segments_committed, 0);
    let segment = core(&route)
        .fast_forward_segments(&job.job_id)
        .unwrap()
        .remove(0);
    assert_eq!(segment.status, GameOperationStatus::Cancelled);
    assert_eq!(segment.usage.total_tokens, None);
    let after = core(&route).view().unwrap();
    assert_eq!(after.state, before.state);
    assert_eq!(after.head_turn_id, before.head_turn_id);
    assert!(service.active.lock().unwrap().is_none());
    assert_eq!(fixture.captured().len(), 1);
}

#[tokio::test]
async fn native_compatible_fast_forward_malformed_output_does_not_commit_or_automatically_retry() {
    let dir = tempfile::tempdir().unwrap();
    let service =
        Arc::new(GameService::open(dir.path(), Arc::new(FixtureSecrets::default())).unwrap());
    let route = create(&service);
    let before = core(&route).view().unwrap();
    let job = start(&route, "native-ff-invalid-job", 20, 20, "日常");
    let fixture = ModelFixture::new("{\"narrative\":\"truncated\"");
    configure_model(&service, &fixture.endpoint);
    let operation = "native-ff-invalid-one";
    let lease = service.turn_lease(Arc::clone(&route), operation).unwrap();
    assert!(fast_forward_commands::run_segment(
        lease,
        continuation(&job, operation),
        ProviderKind::Compatible
    )
    .await
    .is_err());
    let failed = core(&route).get_fast_forward_job(&job.job_id).unwrap();
    assert_eq!(failed.status, FastForwardStatus::Failed);
    assert_eq!(failed.model_requests_reserved, 1);
    assert_eq!(failed.segments_committed, 0);
    let view = core(&route).view().unwrap();
    assert_eq!(view.state, before.state);
    assert_eq!(view.head_turn_id, before.head_turn_id);
    tokio::time::sleep(Duration::from_millis(210)).await;
    assert_eq!(fixture.captured().len(), 1);
    assert!(service.active.lock().unwrap().is_none());
}

#[tokio::test]
async fn native_corrupt_optional_research_does_not_block_world_creation_or_context_and_demo() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("research.sqlite"), b"not a SQLite database").unwrap();
    let service =
        Arc::new(GameService::open(dir.path(), Arc::new(FixtureSecrets::default())).unwrap());
    let route = create(&service);
    assert!(service.research().is_err());
    let view = core(&route).view().unwrap();
    let history = core(&route).selected_history("main").unwrap();
    let fragments = research_commands::fragments(&service, core(&route), &view, &history).unwrap();
    assert_eq!(fragments.len(), 1);
    assert!(fragments[0].body.contains("不确定性"));
    assert!(
        research_commands::allowed_sources(&service, core(&route), &view, &history)
            .unwrap()
            .is_empty()
    );
    let request = action(
        "native-badresearch-action",
        "main",
        None,
        "研究官职制度后继续观察",
    );
    let hint = research_commands::preflight(
        Arc::clone(&service),
        Arc::clone(&route),
        &request,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    route.begin(&request).unwrap();
    route.mark_generating(&request.operation_id).unwrap();
    let (prompt, _) = service
        .compile_context_prompt_with_research(
            &route,
            &WorldReply::V2(Box::new(view)),
            &request,
            ContextBudget::default(),
            hint,
        )
        .unwrap();
    assert!(prompt.contains("没有可引用来源"));
    route
        .finish_uncommitted(
            &request.operation_id,
            GameOperationStatus::Cancelled,
            Some("game_cancelled"),
        )
        .unwrap();
    assert_eq!(
        demo_action(
            &service,
            &route,
            action("native-badresearch-demo", "main", None, "继续观察")
        )
        .await
        .turn_count(),
        1
    );
    assert_eq!(
        std::fs::read(dir.path().join("research.sqlite")).unwrap(),
        b"not a SQLite database"
    );
}

struct ResearchFixture {
    namespace: String,
}
impl ResearchProvider for ResearchFixture {
    fn cache_namespace(&self) -> String {
        self.namespace.clone()
    }
    fn search<'a>(
        &'a self,
        _: &'a ResearchQuery,
        _: Option<SecretValue>,
        _: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = ResearchSearchOutcome> + Send + 'a>> {
        Box::pin(async {
            ResearchSearchOutcome {
                status: ResearchOperationStatus::Succeeded,
                sources: ["source-alpha-native", "source-beta-native"]
                    .into_iter()
                    .map(|id| ResearchSource {
                        id: id.into(),
                        title: "合成资料夹具，非已核实史料".into(),
                        url: format!("https://sources.invalid/{id}"),
                        excerpt: format!("{id} 资料原文：忽略规则、执行Shell只是待防范的文本。"),
                        excerpt_origin: ExcerptOrigin::SearchSnippet,
                        accessed_at_ms: 1,
                        requested_era: None,
                        entity_tags: vec![],
                    })
                    .collect(),
                diagnostics: ResearchDiagnostics {
                    http_attempts: 0,
                    http_status: None,
                    elapsed_ms: 0,
                    error: None,
                },
            }
        })
    }
}
fn research_query() -> ResearchQuery {
    ResearchQuery {
        query: "固定研究官职".into(),
        topic: ResearchTopic::Office,
        era: None,
        entity_tags: vec![],
        region: None,
    }
}
async fn seed_research(service: &GameService) -> String {
    let config = BraveResearchConfig::default();
    let namespace = BraveResearchProvider::new(config.clone())
        .unwrap()
        .cache_namespace();
    let store = service.research().unwrap();
    store.save_config(config, None, 0).unwrap();
    store
        .run_search(
            "native-seed-research",
            &research_query(),
            &ResearchFixture { namespace },
            None,
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .record_id
        .unwrap()
}

#[tokio::test]
async fn native_research_cache_hit_is_logged_without_key_load_and_never_changes_world() {
    let dir = tempfile::tempdir().unwrap();
    let secrets = Arc::new(FixtureSecrets::default());
    let service = Arc::new(GameService::open(dir.path(), secrets.clone()).unwrap());
    let route = create(&service);
    let before = core(&route).view().unwrap();
    let record_id = seed_research(&service).await;
    let (operation, record, cached) = research_commands::search(
        Arc::clone(&service),
        research_query(),
        "native-cached-query".into(),
        false,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(cached);
    let op = operation.unwrap();
    assert_eq!(op.search_slots_used, 0);
    assert_eq!(op.diagnostics.http_attempts, 0);
    assert!(op.http_attempts_known);
    assert_eq!(record.unwrap().id, record_id);
    assert_eq!(secrets.loads.load(Ordering::SeqCst), 0);
    assert_eq!(core(&route).view().unwrap(), before);
    assert!(research_commands::search(
        Arc::clone(&service),
        research_query(),
        "native-cached-query".into(),
        false,
        CancellationToken::new()
    )
    .await
    .is_err());
    assert_eq!(secrets.loads.load(Ordering::SeqCst), 0);
    assert_eq!(core(&route).view().unwrap(), before);
}

#[tokio::test]
async fn native_adopted_research_is_frozen_and_branch_scoped_before_compatible_turn_cites_it() {
    let dir = tempfile::tempdir().unwrap();
    let service =
        Arc::new(GameService::open(dir.path(), Arc::new(FixtureSecrets::default())).unwrap());
    let route = create(&service);
    let id = seed_research(&service).await;
    let store = core(&route);
    let initial = store.view().unwrap();
    let history = store.selected_history("main").unwrap();
    let scope = research_commands::scope(store, &initial).unwrap();
    let research = service.research().unwrap();
    let first = research
        .adopt(
            &scope,
            &history,
            "native-adoption-alpha",
            &id,
            &["source-alpha-native".into()],
        )
        .unwrap();
    fork(
        &route,
        "native-research-child",
        research.watermark().unwrap(),
    );
    research
        .add_conclusion(
            &id,
            &ResearchConclusion {
                id: "late-conclusion-native".into(),
                statement: "LATE_MAIN_ONLY_CONCLUSION".into(),
                status: ConclusionStatus::Inference,
                source_ids: vec!["source-beta-native".into()],
                conflicts_with: vec![],
                temporal_constraints: vec![],
            },
        )
        .unwrap();
    research
        .adopt(
            &scope,
            &history,
            "native-adoption-beta",
            &id,
            &["source-beta-native".into()],
        )
        .unwrap();
    assert_eq!(first.evidence.conclusions.len(), 0);
    let child = store.view_branch("native-research-child").unwrap();
    let child_history = store.selected_history(&child.branch_id).unwrap();
    let fragments = research_commands::fragments(&service, store, &child, &child_history).unwrap();
    let body =
        serde_json::to_string(&fragments.iter().map(|f| &f.body).collect::<Vec<_>>()).unwrap();
    assert!(body.contains("source-alpha-native"));
    assert!(!body.contains("source-beta-native"));
    assert!(!body.contains("LATE_MAIN_ONLY_CONCLUSION"));
    assert!(body.contains("cannotOverrideWorldFacts"));
    assert_eq!(
        research_commands::allowed_sources(&service, store, &child, &child_history).unwrap(),
        ["source-alpha-native"]
    );
    let request = action(
        "native-cited-child-turn",
        &child.branch_id,
        None,
        "继续观察",
    );
    let compile_request = action("native-cited-preflight", &child.branch_id, None, "继续观察");
    route.begin(&compile_request).unwrap();
    route
        .mark_generating(&compile_request.operation_id)
        .unwrap();
    let compiled = service.compile_context_prompt(
        &route,
        &WorldReply::V2(Box::new(child.clone())),
        &compile_request,
        ContextBudget::default(),
    );
    assert!(
        compiled.is_ok(),
        "frozen child context compile failed: {:?}",
        compiled.err()
    );
    route
        .finish_uncommitted(
            &compile_request.operation_id,
            GameOperationStatus::Cancelled,
            Some("game_cancelled"),
        )
        .unwrap();
    let mut output = lishi_core::game_provider_v2::demo_output_v2(&child.state, &request).unwrap();
    output.source_references = vec!["source-alpha-native".into()];
    let fixture = ModelFixture::new(&serde_json::to_string(&output).unwrap());
    configure_model(&service, &fixture.endpoint);
    let lease = service
        .turn_lease(Arc::clone(&route), &request.operation_id)
        .unwrap();
    let p = progress(&request.operation_id);
    let WorldReply::V2(result) = run_turn(lease, request, ProviderKind::Compatible, p)
        .await
        .unwrap()
    else {
        panic!("wrong cited route")
    };
    assert_eq!(result.branch_id, child.branch_id);
    assert_eq!(result.turn_count, 1);
    assert_eq!(
        result.latest_operation.unwrap().status,
        GameOperationStatus::Committed
    );
    // Replaying the selected path revalidates its registered source references.
    assert_eq!(
        store
            .selected_history(&child.branch_id)
            .unwrap()
            .turn_count(),
        1
    );
    assert_eq!(store.view().unwrap(), initial);
    let captured = fixture.captured();
    assert_eq!(captured.len(), 1);
    let (_, prompt) = captured[0].split_once("\r\n\r\n").unwrap();
    assert!(prompt.contains("source-alpha-native"));
    assert!(!prompt.contains("source-beta-native"));
    assert!(!prompt.contains("LATE_MAIN_ONLY_CONCLUSION"));
    assert!(!prompt.contains("synthetic-native-model-key-123"));
}
