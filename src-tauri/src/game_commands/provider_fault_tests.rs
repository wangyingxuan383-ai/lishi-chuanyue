//! M06 production-turn faults use real HTTP on ephemeral literal loopback only.
//! No platform secrets, external service, UI process or private save is accessed.
use super::*;
use lishi_core::{
    game_call_log::{CallLog, CallState},
    game_store::GameActionKind,
    secrets::SecretStoreError,
};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::atomic::AtomicUsize,
    time::Instant,
};

const SYNTHETIC_KEY: &str = "synthetic-m06-provider-fault-key";
const PRIVATE_DETAIL: &str = "UPSTREAM_PRIVATE_DETAIL_MUST_NOT_ENTER_FORMAL_SAVE";

#[derive(Default)]
struct FixtureSecrets(Mutex<BTreeMap<String, String>>);
impl SecretStore for FixtureSecrets {
    fn save(&self, slot: &SecretSlot, value: &SecretValue) -> Result<(), SecretStoreError> {
        self.0
            .lock()
            .unwrap()
            .insert(slot.as_str().into(), value.expose_secret().into());
        Ok(())
    }
    fn load(&self, slot: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
        self.0
            .lock()
            .unwrap()
            .get(slot.as_str())
            .cloned()
            .map(SecretValue::new)
            .transpose()
    }
    fn delete(&self, slot: &SecretSlot) -> Result<(), SecretStoreError> {
        self.0.lock().unwrap().remove(slot.as_str());
        Ok(())
    }
}

struct ResponsePlan {
    status: u16,
    header_delay: Duration,
    chunks: Vec<Vec<u8>>,
}
impl ResponsePlan {
    fn body(body: String) -> Self {
        Self {
            status: 200,
            header_delay: Duration::ZERO,
            chunks: vec![body.into_bytes()],
        }
    }
}
struct ModelFixture {
    endpoint: String,
    count: Arc<AtomicUsize>,
    // Authentication headers deliberately never enter this capture.
    bodies: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
}
fn wait_or_stop(stop: &AtomicBool, duration: Duration) -> bool {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        if stop.load(Ordering::Acquire) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    !stop.load(Ordering::Acquire)
}
fn read_body(stream: &mut TcpStream) -> Option<String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let mut framing = None;
    loop {
        let mut buffer = [0; 4096];
        let count = stream.read(&mut buffer).unwrap_or(0);
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if framing.is_none() {
            if let Some(index) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..index]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                framing = Some((index + 4, index + 4 + length));
            }
        }
        if framing.is_some_and(|(_, total)| bytes.len() >= total) {
            break;
        }
    }
    let (start, end) = framing?;
    if bytes.len() < end {
        return None;
    }
    Some(String::from_utf8(bytes[start..end].to_vec()).unwrap())
}
impl ModelFixture {
    fn new(plan: ResponsePlan) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        listener.set_nonblocking(true).unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let accepted = Arc::clone(&count);
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&bodies);
        let stop = Arc::new(AtomicBool::new(false));
        let shutdown = Arc::clone(&stop);
        let worker = std::thread::spawn(move || {
            while !shutdown.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // Windows accepts can inherit the listener's nonblocking
                        // mode; make body reads wait for the request bytes.
                        stream.set_nonblocking(false).unwrap();
                        stream.set_nodelay(true).unwrap();
                        let Some(body) = read_body(&mut stream) else {
                            continue;
                        };
                        accepted.fetch_add(1, Ordering::SeqCst);
                        captured.lock().unwrap().push(body);
                        if !wait_or_stop(&shutdown, plan.header_delay) {
                            break;
                        }
                        let headers = format!("HTTP/1.1 {} Fixture\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n", plan.status);
                        if stream.write_all(headers.as_bytes()).is_err() {
                            continue;
                        }
                        for chunk in &plan.chunks {
                            if stream
                                .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                                .is_err()
                                || stream.write_all(chunk).is_err()
                                || stream.write_all(b"\r\n").is_err()
                                || !wait_or_stop(&shutdown, Duration::from_millis(2))
                            {
                                break;
                            }
                        }
                        let _ = stream.write_all(b"0\r\n\r\n");
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(e) => panic!("loopback fixture accept failed: {e}"),
                }
            }
        });
        Self {
            endpoint,
            count,
            bodies,
            stop,
            worker: Some(worker),
        }
    }
    fn attempts(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
    async fn request_arrived(&self) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.bodies.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("formal turn reached the fixture");
    }
}
impl Drop for ModelFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Err(error) = self.worker.take().unwrap().join() {
            if !std::thread::panicking() {
                std::panic::resume_unwind(error);
            }
        }
    }
}

fn service(directory: &Path, legacy: bool) -> (Arc<GameService>, Arc<StoreRoute>) {
    let service =
        Arc::new(GameService::open(directory, Arc::new(FixtureSecrets::default())).unwrap());
    let setup = WorldSetup {
        world_id: "m06-provider-fault-world".into(),
        title: "Provider故障夹具".into(),
        country: "唐".into(),
        era_year: 748,
        location_name: "长安".into(),
        protagonist_name: "行旅者".into(),
        narrative_style: "简洁".into(),
    };
    if legacy {
        let route = StoreRoute::V1(
            lishi_core::game_store::GameStore::open(service.world_path(&setup.world_id).unwrap())
                .unwrap(),
        );
        route.create_world(&setup).unwrap();
    }
    let route = service.store(&setup.world_id, true).unwrap();
    if !legacy {
        route.create_world(&setup).unwrap();
        std::fs::create_dir_all(&service.backups).unwrap();
        let StoreRoute::V2(store) = route.as_ref() else {
            unreachable!()
        };
        store.enable_branches(&service.backups, None).unwrap();
    }
    (service, route)
}
fn configure(service: &GameService, endpoint: &str) {
    save_provider_sync(
        service,
        endpoint,
        "m06-fixture-model",
        Some(SecretValue::new(SYNTHETIC_KEY.into()).unwrap()),
        0,
        true,
    )
    .unwrap();
}
fn request(id: &str) -> GameTurnRequest {
    GameTurnRequest {
        operation_id: id.into(),
        world_id: "m06-provider-fault-world".into(),
        branch_id: "main".into(),
        expected_head_turn_id: None,
        action_kind: GameActionKind::Action,
        action_text: "购买补给".into(),
    }
}
fn progress(id: &str) -> Progress {
    Progress {
        channel: Channel::new(|_| Ok(())),
        id: id.into(),
        sequence: 0,
    }
}
fn formal(view: &WorldReply) -> serde_json::Value {
    let mut value = serde_json::to_value(view).unwrap();
    value.as_object_mut().unwrap().remove("latestOperation");
    value
}
fn delta(text: &str) -> String {
    format!(
        "data: {}\n\n",
        serde_json::json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]})
    )
}
fn complete(text: &str) -> String {
    format!("{}data: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n", delta(text))
}
fn assert_failed(view: &WorldReply, before: &WorldReply, code: &str) {
    assert_eq!(formal(view), formal(before));
    let operation = view.latest_operation().unwrap();
    assert_eq!(operation.status, GameOperationStatus::Failed);
    assert_eq!(operation.error_code.as_deref(), Some(code));
    let serialized = serde_json::to_string(view).unwrap();
    assert!(!serialized.contains(PRIVATE_DETAIL));
    assert!(!serialized.contains(SYNTHETIC_KEY));
}

#[tokio::test]
async fn production_turn_fault_matrix_is_atomic_persistent_and_never_retries_v1_or_v3() {
    for legacy in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (service, route) = service(dir.path(), legacy);
        let baseline = route.view().unwrap();
        let valid_json = StoreRoute::demo_output(&baseline, &request("m06-valid-poison"))
            .unwrap()
            .json()
            .unwrap();
        let cases = [
            ("429", "http_status", 429, PRIVATE_DETAIL.to_owned()),
            ("empty", "empty_output", 200, "data: [DONE]\n\n".into()),
            ("refused", "refused", 200, format!("data: {{\"choices\":[{{\"delta\":{{\"refusal\":\"{PRIVATE_DETAIL}\"}}}}]}}\n\n")),
            ("bad-sse", "invalid_payload", 200, format!("data: {{INVALID_JSON_{PRIVATE_DETAIL}\n\n")),
            ("bad-output", "game_invalid_output", 200, complete("{\"narrative\":\"未完成JSON\"")),
            ("truncated", "truncated", 200, format!("{}data: {{\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"length\"}}]}}\n\n", delta(&valid_json))),
            // Even fully valid formal JSON is provisional until transport DONE.
            ("disconnected", "unexpected_eof", 200, delta(&valid_json)),
        ];
        for (name, code, status, body) in cases {
            let fixture = ModelFixture::new(ResponsePlan {
                status,
                ..ResponsePlan::body(body)
            });
            // Config revisions change only in this temporary test directory.
            let revision = service.providers.view().unwrap().revision;
            save_provider_sync(
                &service,
                &fixture.endpoint,
                "m06-fixture-model",
                Some(SecretValue::new(SYNTHETIC_KEY.into()).unwrap()),
                revision,
                true,
            )
            .unwrap();
            let request = request(&format!("m06-fault-{name}"));
            let lease = service
                .turn_lease(Arc::clone(&route), &request.operation_id)
                .unwrap();
            let view = run_turn(
                lease,
                request.clone(),
                ProviderKind::Compatible,
                progress(&request.operation_id),
            )
            .await
            .unwrap();
            if view.latest_operation().unwrap().error_code.as_deref() != Some(code) {
                eprintln!(
                    "unexpected fixture fault: {name}, count={}, ledger={:?}",
                    fixture.attempts(),
                    service
                        .calls()
                        .unwrap()
                        .operation(&request.operation_id)
                        .unwrap()
                );
            }
            assert_failed(&view, &baseline, code);
            let calls = service
                .calls()
                .unwrap()
                .operation(&request.operation_id)
                .unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].actual_http_attempts, Some(1));
            assert!(!calls[0].sent_unknown);
            assert_eq!(calls[0].http_status, Some(status));
            assert_eq!(
                calls[0].state,
                if name == "bad-output" {
                    CallState::Completed
                } else {
                    CallState::Failed
                }
            );
            let safe = serde_json::to_string(&calls).unwrap();
            assert!(!safe.contains(PRIVATE_DETAIL));
            assert!(!safe.contains(SYNTHETIC_KEY));
            assert!(service.active.lock().unwrap().is_none());
            // A repeated operation must be rejected before another HTTP attempt.
            let lease = service
                .turn_lease(Arc::clone(&route), &request.operation_id)
                .unwrap();
            assert_eq!(
                run_turn(
                    lease,
                    request.clone(),
                    ProviderKind::Compatible,
                    progress(&request.operation_id)
                )
                .await
                .unwrap_err()
                .code,
                "game_duplicate"
            );
            tokio::time::sleep(Duration::from_millis(80)).await;
            assert_eq!(
                fixture.attempts(),
                1,
                "{name}: no automatic retry or duplicate send"
            );
        }
        let path = service.world_path(&baseline.setup().world_id).unwrap();
        let calls_path = service.call_log_path.clone();
        let calls_before = service.calls().unwrap().list(100).unwrap();
        let final_view = route.view().unwrap();
        drop(route);
        drop(service);
        let reopened = StoreRoute::open_existing(&path).unwrap().view().unwrap();
        assert_eq!(reopened, final_view);
        assert_eq!(formal(&reopened), formal(&baseline));
        assert_eq!(
            CallLog::open(calls_path).unwrap().list(100).unwrap(),
            calls_before
        );
    }
}

#[tokio::test]
async fn production_turn_chinese_utf8_split_commits_exactly_once() {
    let dir = tempfile::tempdir().unwrap();
    let (service, route) = service(dir.path(), false);
    let before = route.view().unwrap();
    let request = request("m06-chinese-split-once");
    let output = StoreRoute::demo_output(&before, &request).unwrap();
    let expected_narrative = output.narrative().to_owned();
    let body = complete(&output.json().unwrap()).into_bytes();
    let split = body.iter().position(|b| !b.is_ascii()).unwrap() + 1;
    assert!(std::str::from_utf8(&body[..split]).is_err());
    let fixture = ModelFixture::new(ResponsePlan {
        status: 200,
        header_delay: Duration::ZERO,
        chunks: vec![body[..split].to_vec(), body[split..].to_vec()],
    });
    configure(&service, &fixture.endpoint);
    let lease = service
        .turn_lease(Arc::clone(&route), &request.operation_id)
        .unwrap();
    let view = run_turn(
        lease,
        request.clone(),
        ProviderKind::Compatible,
        progress(&request.operation_id),
    )
    .await
    .unwrap();
    assert_eq!(view.turn_count(), 1);
    assert_eq!(view.head_turn_id(), Some(request.operation_id.as_str()));
    assert_eq!(
        view.latest_operation().unwrap().status,
        GameOperationStatus::Committed
    );
    let WorldReply::V2(view) = view else {
        unreachable!()
    };
    assert_eq!(view.turns[0].narrative, expected_narrative);
    assert!(!view.turns[0].narrative.contains('\u{fffd}'));
    assert_eq!(fixture.attempts(), 1);
    let calls = service
        .calls()
        .unwrap()
        .operation(&request.operation_id)
        .unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].state, CallState::Completed);
    assert_eq!(calls[0].actual_http_attempts, Some(1));
    let bodies = fixture.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 1);
    assert!(!bodies[0].contains(SYNTHETIC_KEY));
}

#[tokio::test]
async fn production_turn_precancel_and_inflight_cancel_do_not_commit_or_retry() {
    let dir = tempfile::tempdir().unwrap();
    let (service, route) = service(dir.path(), false);
    let before = route.view().unwrap();
    let fixture = ModelFixture::new(ResponsePlan {
        header_delay: Duration::from_secs(35),
        ..ResponsePlan::body(complete("{}"))
    });
    configure(&service, &fixture.endpoint);
    let pre = request("m06-turn-precancel");
    let lease = service
        .turn_lease(Arc::clone(&route), &pre.operation_id)
        .unwrap();
    lease.cancel.cancel();
    let cancelled = run_turn(
        lease,
        pre.clone(),
        ProviderKind::Compatible,
        progress(&pre.operation_id),
    )
    .await
    .unwrap();
    assert_eq!(formal(&cancelled), formal(&before));
    assert_eq!(
        cancelled.latest_operation().unwrap().status,
        GameOperationStatus::Cancelled
    );
    assert_eq!(fixture.attempts(), 0);
    assert!(service
        .calls()
        .unwrap()
        .operation(&pre.operation_id)
        .unwrap()
        .is_empty());
    let request = request("m06-turn-inflight-cancel");
    let lease = service
        .turn_lease(Arc::clone(&route), &request.operation_id)
        .unwrap();
    let cancel = lease.cancel.clone();
    let task = tokio::spawn(run_turn(
        lease,
        request.clone(),
        ProviderKind::Compatible,
        progress(&request.operation_id),
    ));
    fixture.request_arrived().await;
    cancel.cancel();
    let cancelled = tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(formal(&cancelled), formal(&before));
    assert_eq!(
        cancelled.latest_operation().unwrap().status,
        GameOperationStatus::Cancelled
    );
    assert_eq!(
        cancelled.latest_operation().unwrap().error_code.as_deref(),
        Some("game_cancelled")
    );
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(fixture.attempts(), 1);
    let calls = service
        .calls()
        .unwrap()
        .operation(&request.operation_id)
        .unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].state, CallState::Cancelled);
    assert_eq!(calls[0].actual_http_attempts, Some(1));
    assert!(!calls[0].sent_unknown);
    assert!(service.active.lock().unwrap().is_none());
}

#[tokio::test]
async fn production_turn_real_header_timeout_preserves_facts_and_uses_one_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let (service, route) = service(dir.path(), false);
    let before = route.view().unwrap();
    let fixture = ModelFixture::new(ResponsePlan {
        header_delay: Duration::from_secs(35),
        ..ResponsePlan::body(complete("{}"))
    });
    configure(&service, &fixture.endpoint);
    let request = request("m06-turn-header-timeout");
    let lease = service
        .turn_lease(Arc::clone(&route), &request.operation_id)
        .unwrap();
    let view = tokio::time::timeout(
        Duration::from_secs(34),
        run_turn(
            lease,
            request.clone(),
            ProviderKind::Compatible,
            progress(&request.operation_id),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_failed(&view, &before, "connect_timeout");
    assert_eq!(fixture.attempts(), 1);
    let calls = service
        .calls()
        .unwrap()
        .operation(&request.operation_id)
        .unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].actual_http_attempts, Some(1));
    assert_eq!(calls[0].error_code.as_deref(), Some("connect_timeout"));
    assert_eq!(calls[0].http_status, None);
    assert!(service.active.lock().unwrap().is_none());
}

#[tokio::test]
async fn production_turn_cannot_send_a_third_model_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let (service, route) = service(dir.path(), false);
    let before = route.view().unwrap();
    let fixture = ModelFixture::new(ResponsePlan::body(complete("{}")));
    configure(&service, &fixture.endpoint);
    let request = request("m06-turn-budget-exhausted");
    let log = service.calls().unwrap();
    for sequence in [1, 2] {
        assert_eq!(
            log.reserve(
                &request.operation_id,
                &request.world_id,
                &request.branch_id,
                "m06-fixture-model",
                lishi_core::game_provider_v2::GAME_PROMPT_VERSION_V2
            )
            .unwrap(),
            sequence
        );
    }
    let lease = service
        .turn_lease(Arc::clone(&route), &request.operation_id)
        .unwrap();
    let view = run_turn(
        lease,
        request.clone(),
        ProviderKind::Compatible,
        progress(&request.operation_id),
    )
    .await
    .unwrap();
    assert_eq!(formal(&view), formal(&before));
    assert_eq!(
        view.latest_operation().unwrap().status,
        GameOperationStatus::Failed
    );
    assert_eq!(log.operation(&request.operation_id).unwrap().len(), 2);
    assert_eq!(fixture.attempts(), 0);
}

#[tokio::test]
async fn production_turn_aborted_after_http_reopens_as_unknown_without_resending() {
    let dir = tempfile::tempdir().unwrap();
    let (service, route) = service(dir.path(), false);
    let before = route.view().unwrap();
    let fixture = ModelFixture::new(ResponsePlan {
        header_delay: Duration::from_secs(35),
        ..ResponsePlan::body(complete("{}"))
    });
    configure(&service, &fixture.endpoint);
    let request = request("m06-turn-dropped-after-http");
    let lease = service
        .turn_lease(Arc::clone(&route), &request.operation_id)
        .unwrap();
    let task = tokio::spawn(run_turn(
        lease,
        request.clone(),
        ProviderKind::Compatible,
        progress(&request.operation_id),
    ));
    fixture.request_arrived().await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let ledger_path = service.call_log_path.clone();
    let world_path = service.world_path(&request.world_id).unwrap();
    assert_eq!(formal(&route.view().unwrap()), formal(&before));
    drop(route);
    drop(service);
    let ledger = CallLog::open(ledger_path).unwrap();
    let calls = ledger.operation(&request.operation_id).unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].state, CallState::Interrupted);
    assert_eq!(calls[0].actual_http_attempts, None);
    assert!(calls[0].sent_unknown);
    assert_eq!(
        formal(
            &StoreRoute::open_existing(&world_path)
                .unwrap()
                .view()
                .unwrap()
        ),
        formal(&before)
    );
    assert_eq!(fixture.attempts(), 1);
}

#[tokio::test]
async fn fast_forward_failure_and_exhausted_budget_share_the_persistent_call_ledger() {
    use lishi_core::game_fast_forward::{
        ContinueFastForwardRequest, FastForwardStatus, StartFastForwardRequest,
    };
    for exhausted in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (service, route) = service(dir.path(), false);
        let before = route.view().unwrap();
        let StoreRoute::V2(store) = route.as_ref() else {
            unreachable!()
        };
        store.ensure_fast_forward_backend().unwrap();
        let job = store
            .start_fast_forward(&StartFastForwardRequest {
                world_id: before.setup().world_id.clone(),
                branch_id: "main".into(),
                job_id: "m06-ff-fault-job".into(),
                expected_head_turn_id: None,
                target_elapsed_seconds: 20,
                max_segment_seconds: 20,
                focus: "日常".into(),
            })
            .unwrap();
        let fixture = ModelFixture::new(ResponsePlan {
            status: 429,
            ..ResponsePlan::body(PRIVATE_DETAIL.into())
        });
        configure(&service, &fixture.endpoint);
        let request = ContinueFastForwardRequest {
            world_id: job.world_id.clone(),
            branch_id: job.branch_id.clone(),
            job_id: job.job_id.clone(),
            operation_id: "m06-ff-fault-attempt".into(),
            expected_head_turn_id: job.head_turn_id.clone(),
            expected_job_revision: job.revision,
        };
        let log = service.calls().unwrap();
        if exhausted {
            for sequence in [1, 2] {
                assert_eq!(
                    log.reserve(
                        &request.operation_id,
                        &request.world_id,
                        &request.branch_id,
                        "m06-fixture-model",
                        21_001
                    )
                    .unwrap(),
                    sequence
                );
            }
        }
        let lease = service
            .turn_lease(Arc::clone(&route), &request.operation_id)
            .unwrap();
        assert!(fast_forward_commands::run_segment(
            lease,
            request.clone(),
            ProviderKind::Compatible
        )
        .await
        .is_err());
        assert_eq!(formal(&route.view().unwrap()), formal(&before));
        let failed = store.get_fast_forward_job(&job.job_id).unwrap();
        assert_eq!(failed.status, FastForwardStatus::Failed);
        assert_eq!(failed.segments_committed, 0);
        assert_eq!(failed.model_requests_reserved, 1);
        let calls = log.operation(&request.operation_id).unwrap();
        if exhausted {
            assert_eq!(calls.len(), 2);
            assert!(calls
                .iter()
                .all(|c| c.state == CallState::Reserved && c.actual_http_attempts.is_none()));
            assert_eq!(fixture.attempts(), 0);
        } else {
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].state, CallState::Failed);
            assert_eq!(calls[0].http_status, Some(429));
            assert_eq!(calls[0].actual_http_attempts, Some(1));
            assert_eq!(calls[0].error_code.as_deref(), Some("http_status"));
            tokio::time::sleep(Duration::from_millis(80)).await;
            assert_eq!(fixture.attempts(), 1);
        }
        assert!(service.active.lock().unwrap().is_none());
    }
}
