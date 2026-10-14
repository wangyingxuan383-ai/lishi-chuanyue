//! Explicit derived summaries have their own persisted operation and budget.
//! They never enter formal turn operations and never hold SQLite across HTTP.
use std::{collections::BTreeSet, sync::Arc};

use super::{
    blocking,
    memory_service::{context_scope, AnnotationsReply, GameMemoryService},
    profile_work, saved_credential, ActiveTurn, GameCommandError, GameService, StoreRoute,
};
use lishi_core::{
    game_annotations::{
        compile_summary_prompt, AnnotationError, AnnotationScope, SummaryFailure, SummaryPlan,
        SummaryPrompt, SummarySourceTurn, SummaryUsage, LOCAL_SUMMARY_MODEL, MAX_SUMMARY_BYTES,
        MAX_SUMMARY_SOURCE_BYTES, MAX_SUMMARY_SOURCE_TURNS, SUMMARY_PROMPT_VERSION,
    },
    game_knowledge::ValidatedHistory,
    game_provider::{self, ProviderKind, StoredProvider},
    game_store_v2::{valid_game_id, WorldViewV2},
    model_probe::{CredentialMode, ModelContextPolicy, ModelProbeRequest, SavedEndpointPolicy},
    CancellationToken, StreamErrorCode, StreamStatus,
};

fn error(value: impl std::fmt::Display) -> GameCommandError {
    GameCommandError::new(value.to_string())
}

struct SummaryLease {
    service: Arc<GameService>,
    store: Arc<StoreRoute>,
    id: String,
    cancel: CancellationToken,
    cleanup: Option<(
        Arc<GameMemoryService>,
        Arc<ValidatedHistory>,
        AnnotationScope,
    )>,
    done: bool,
}
impl SummaryLease {
    fn acquire(
        service: Arc<GameService>,
        store: Arc<StoreRoute>,
        id: &str,
    ) -> Result<Self, GameCommandError> {
        if !valid_game_id(id) {
            return Err(GameCommandError::new("game_invalid_request"));
        }
        let cancel = CancellationToken::new();
        {
            let mut active = service
                .active
                .lock()
                .map_err(|_| GameCommandError::new("game_unavailable"))?;
            if active.is_some() {
                return Err(GameCommandError::new("game_busy"));
            }
            *active = Some(ActiveTurn {
                id: id.into(),
                cancel: cancel.clone(),
            });
        }
        Ok(Self {
            service,
            store,
            id: id.into(),
            cancel,
            cleanup: None,
            done: false,
        })
    }
}
impl Drop for SummaryLease {
    fn drop(&mut self) {
        if !self.done {
            self.cancel.cancel();
            if let Some((memory, history, scope)) = &self.cleanup {
                let _ = memory.annotations.cancel_summary(scope, history, &self.id);
            }
        }
        if let Ok(mut active) = self.service.active.lock() {
            if active
                .as_ref()
                .is_some_and(|operation| operation.id == self.id)
            {
                *active = None;
            }
        }
    }
}

struct PreparedSummary {
    memory: Arc<GameMemoryService>,
    history: Arc<ValidatedHistory>,
    scope: AnnotationScope,
    view: WorldViewV2,
    frozen: Option<StoredProvider>,
    content: PreparedContent,
}
enum PreparedContent {
    Local(String),
    Model(SummaryPrompt),
    Deferred,
}

fn prepare_summary(
    service: &GameService,
    route: &StoreRoute,
    world_id: &str,
    expected_head: Option<&str>,
    operation_id: &str,
    source_turn_ids: &[String],
    provider_kind: ProviderKind,
) -> Result<PreparedSummary, GameCommandError> {
    let store = match route {
        StoreRoute::V2(store) => store,
        _ => return Err(GameCommandError::new("game_upgrade_required")),
    };
    if source_turn_ids.is_empty()
        || source_turn_ids.len() > MAX_SUMMARY_SOURCE_TURNS
        || source_turn_ids.iter().any(|id| !valid_game_id(id))
    {
        return Err(GameCommandError::new("annotations_invalid_input"));
    }
    let wanted: BTreeSet<_> = source_turn_ids.iter().collect();
    if wanted.len() != source_turn_ids.len() {
        return Err(GameCommandError::new("annotations_invalid_input"));
    }
    let view = store.view()?;
    if view.setup.world_id != world_id || view.head_turn_id.as_deref() != expected_head {
        return Err(GameCommandError::new("game_stale_head"));
    }
    let history = Arc::new(store.knowledge_history()?);
    // Read the entire audited path. UI's recent 100 turns are never sources.
    let mut originals = Vec::new();
    let mut source_bytes = 0usize;
    let complete = store.visit_committed_turns(|turn, _, _| {
        if wanted.contains(&turn.turn_id) {
            source_bytes = source_bytes
                .checked_add(turn.narrative.len())
                .ok_or(lishi_core::game_store::GameStoreError::InvalidRequest)?;
            if source_bytes > MAX_SUMMARY_SOURCE_BYTES {
                return Err(lishi_core::game_store::GameStoreError::InvalidRequest);
            }
            originals.push((turn.turn_id, turn.narrative));
        }
        Ok(())
    })?;
    if complete.head_turn_id != view.head_turn_id
        || complete.branch_id != view.branch_id
        || complete.setup.world_id != view.setup.world_id
        || complete.state != view.state
        || history.current_state() != &view.state
    {
        return Err(GameCommandError::new("game_stale_head"));
    }
    if originals
        .iter()
        .map(|source| &source.0)
        .ne(source_turn_ids.iter())
    {
        return Err(GameCommandError::new("annotations_invisible_source"));
    }
    let sources: Vec<_> = originals
        .iter()
        .map(|(turn_id, narrative)| SummarySourceTurn { turn_id, narrative })
        .collect();
    let frozen = if provider_kind == ProviderKind::Compatible {
        Some(
            service
                .providers
                .stored()?
                .ok_or_else(|| GameCommandError::new("game_provider_missing"))?,
        )
    } else {
        None
    };
    let plan = SummaryPlan {
        operation_id: operation_id.into(),
        provider: if frozen.is_some() {
            "compatible".into()
        } else {
            LOCAL_SUMMARY_MODEL.into()
        },
        model: frozen.as_ref().map_or_else(
            || LOCAL_SUMMARY_MODEL.into(),
            |profile| profile.config.model.clone(),
        ),
        prompt_version: SUMMARY_PROMPT_VERSION,
    };
    let memory = service.memory(world_id)?;
    let scope = context_scope(&view);
    memory
        .annotations
        .begin_summary(&scope, &history, &plan, &sources)
        .map_err(error)?;
    // Oversized optional work is durably deferred before any credential read
    // or request reservation. It cannot block future formal turns.
    let content = if let Some(profile) = &frozen {
        match compile_summary_prompt(&history, &sources, profile.config.context_budget) {
            Ok(prompt) => PreparedContent::Model(prompt),
            Err(AnnotationError::TooLarge) => PreparedContent::Deferred,
            Err(problem) => {
                memory
                    .annotations
                    .fail_summary(&scope, &history, operation_id, SummaryFailure::Budget)
                    .map_err(error)?;
                return Err(error(problem));
            }
        }
    } else {
        let mut body = String::from("本地原文摘录（未调用模型）\n");
        let mut too_large = false;
        for source in &sources {
            if body
                .len()
                .saturating_add(source.turn_id.len())
                .saturating_add(source.narrative.len())
                .saturating_add(5)
                > MAX_SUMMARY_BYTES
            {
                too_large = true;
                break;
            }
            body.push_str(source.turn_id);
            body.push_str("：\n");
            body.push_str(source.narrative);
            body.push('\n');
        }
        if too_large {
            PreparedContent::Deferred
        } else {
            PreparedContent::Local(body)
        }
    };
    Ok(PreparedSummary {
        memory,
        history,
        scope,
        view,
        frozen,
        content,
    })
}

fn usage(diagnostics: &lishi_core::model_probe::ModelProbeDiagnostics) -> SummaryUsage {
    let Some(tokens) = &diagnostics.usage else {
        return SummaryUsage::default();
    };
    // Upstream counters outside JSON's exact integer range remain unknown;
    // malformed usage cannot prevent persisting the summary's real status.
    if [
        tokens.prompt_tokens,
        tokens.completion_tokens,
        tokens.total_tokens,
    ]
    .iter()
    .any(|tokens| *tokens > 9_007_199_254_740_991)
    {
        return SummaryUsage::default();
    }
    SummaryUsage {
        input_tokens: Some(tokens.prompt_tokens),
        output_tokens: Some(tokens.completion_tokens),
        total_tokens: Some(tokens.total_tokens),
        ..SummaryUsage::default()
    }
}
fn stream_failure(code: Option<StreamErrorCode>) -> SummaryFailure {
    match code {
        Some(
            StreamErrorCode::ConnectTimeout
            | StreamErrorCode::IdleTimeout
            | StreamErrorCode::TotalTimeout,
        ) => SummaryFailure::Timeout,
        Some(StreamErrorCode::Network | StreamErrorCode::ClientSetup) => SummaryFailure::Network,
        Some(
            StreamErrorCode::HttpStatus | StreamErrorCode::Refused | StreamErrorCode::UpstreamError,
        ) => SummaryFailure::ProviderRejected,
        _ => SummaryFailure::InvalidOutput,
    }
}

async fn run_summary(
    mut lease: SummaryLease,
    world_id: String,
    expected_head: Option<String>,
    source_turn_ids: Vec<String>,
    provider_kind: ProviderKind,
) -> Result<AnnotationsReply, GameCommandError> {
    let service = Arc::clone(&lease.service);
    let route = Arc::clone(&lease.store);
    let id = lease.id.clone();
    let mut prepared = blocking(move || {
        prepare_summary(
            &service,
            &route,
            &world_id,
            expected_head.as_deref(),
            &id,
            &source_turn_ids,
            provider_kind,
        )
    })
    .await?;
    lease.cleanup = Some((
        Arc::clone(&prepared.memory),
        Arc::clone(&prepared.history),
        prepared.scope.clone(),
    ));
    let content = std::mem::replace(&mut prepared.content, PreparedContent::Deferred);
    let mut attempt = None;
    let mut actual_usage = SummaryUsage::default();
    let outcome: Result<Option<String>, SummaryFailure> = async {
        if lease.cancel.is_cancelled() {
            return Err(SummaryFailure::Cancelled);
        }
        match content {
            PreparedContent::Deferred => Ok(None),
            PreparedContent::Local(body) => Ok(Some(body)),
            PreparedContent::Model(prompt) => {
                #[cfg(target_os = "android")]
                if !crate::android_tls::is_ready() {
                    return Err(SummaryFailure::Network);
                }
                let frozen = prepared.frozen.as_ref().ok_or(SummaryFailure::Manual)?;
                let (profile, key) = profile_work(Arc::clone(&lease.service), |service| {
                    saved_credential(&service)
                })
                .await
                .map_err(|_| SummaryFailure::ProviderRejected)?;
                if profile.config.revision != frozen.config.revision {
                    return Err(SummaryFailure::ProviderRejected);
                }
                let budget = profile.config.context_budget;
                let policy = if profile.config.allow_insecure_http {
                    SavedEndpointPolicy::ExplicitHttp
                } else {
                    SavedEndpointPolicy::HttpsOnly
                };
                let context = ModelContextPolicy {
                    max_prompt_bytes: budget
                        .effective_input_limit_bytes()
                        .map_err(|_| SummaryFailure::Budget)?,
                    output_reserve_tokens: Some(prompt.output_reserve_tokens),
                };
                let request = ModelProbeRequest {
                    operation_id: lease.id.clone(),
                    endpoint: profile.config.endpoint,
                    model: profile.config.model,
                    prompt: prompt.prompt,
                    include_usage: true,
                    credential_mode: CredentialMode::Saved,
                };
                request
                    .validate_with_context_policy(policy, context)
                    .map_err(|_| SummaryFailure::ProviderRejected)?;
                if lease.cancel.is_cancelled() {
                    return Err(SummaryFailure::Cancelled);
                }
                let memory = Arc::clone(&prepared.memory);
                let history = Arc::clone(&prepared.history);
                let scope = prepared.scope.clone();
                let id = lease.id.clone();
                attempt = Some(
                    blocking(move || {
                        memory
                            .annotations
                            .reserve_model_request(&scope, &history, &id)
                            .map_err(error)
                    })
                    .await
                    .map_err(|_| SummaryFailure::Manual)?
                    .attempt_number,
                );
                let mut options = game_provider::production_stream_options();
                options.max_output_bytes = MAX_SUMMARY_BYTES;
                let result = lishi_core::model_probe::run_model_probe_with_context_policy(
                    request,
                    Some(key),
                    lease.cancel.clone(),
                    options,
                    policy,
                    context,
                    |_| true,
                )
                .await;
                actual_usage = usage(&result.diagnostics);
                if result.stream.status == StreamStatus::Cancelled || lease.cancel.is_cancelled() {
                    return Err(SummaryFailure::Cancelled);
                }
                if result.stream.status != StreamStatus::Completed {
                    return Err(stream_failure(result.stream.error_code));
                }
                Ok(Some(result.stream.text))
            }
        }
    }
    .await;
    let memory = Arc::clone(&prepared.memory);
    let history = Arc::clone(&prepared.history);
    let scope = prepared.scope;
    let view = prepared.view;
    let route = Arc::clone(&lease.store);
    let id = lease.id.clone();
    let cancel = lease.cancel.clone();
    let reply = blocking(move || {
        // The shared native operation lease prevents head changes during HTTP;
        // repeat the comparison before publishing any derived fragment.
        let current = route.view()?;
        if current.head_turn_id() != view.head_turn_id.as_deref()
            || current.setup().world_id != view.setup.world_id
            || !matches!(&current, super::WorldReply::V2(current) if current.branch_id == view.branch_id)
        {
            memory
                .annotations
                .cancel_summary_with_usage(&scope, &history, &id, actual_usage)
                .map_err(error)?;
            return Err(GameCommandError::new("game_stale_head"));
        }
        if cancel.is_cancelled() || matches!(outcome, Err(SummaryFailure::Cancelled)) {
            memory
                .annotations
                .cancel_summary_with_usage(&scope, &history, &id, actual_usage)
                .map_err(error)?;
        } else {
            match outcome {
                Ok(None) => {
                    memory
                        .annotations
                        .defer_summary(&scope, &history, &id)
                        .map_err(error)?;
                }
                Ok(Some(body)) => {
                    let finish = if let Some(attempt) = attempt {
                        memory.annotations.finish_summary_cancellable(
                            &scope,
                            &history,
                            &id,
                            attempt,
                            &body,
                            actual_usage.clone(),
                            &cancel,
                        )
                    } else {
                        memory
                            .annotations
                            .finish_local_summary(&scope, &history, &id, &body, &cancel)
                    };
                    if let Err(problem) = finish {
                        if problem == AnnotationError::Cancelled {
                            memory
                                .annotations
                                .cancel_summary_with_usage(&scope, &history, &id, actual_usage)
                                .map_err(error)?;
                        } else {
                            if let Some(attempt) = attempt {
                                memory
                                    .annotations
                                    .fail_attempt(
                                        &scope,
                                        &history,
                                        &id,
                                        attempt,
                                        SummaryFailure::InvalidOutput,
                                        actual_usage,
                                    )
                                    .map_err(error)?;
                            }
                            memory
                                .annotations
                                .fail_summary(&scope, &history, &id, SummaryFailure::InvalidOutput)
                                .map_err(error)?;
                        }
                    }
                }
                Err(failure) => {
                    if let Some(attempt) = attempt {
                        memory
                            .annotations
                            .fail_attempt(&scope, &history, &id, attempt, failure, actual_usage)
                            .map_err(error)?;
                    }
                    memory
                        .annotations
                        .fail_summary(&scope, &history, &id, failure)
                        .map_err(error)?;
                }
            }
        }
        memory.annotation_reply(&view, &history)
    })
    .await?;
    lease.done = true;
    Ok(reply)
}

#[tauri::command]
pub async fn create_game_summary(
    world_id: String,
    expected_head_turn_id: Option<String>,
    operation_id: String,
    source_turn_ids: Vec<String>,
    provider_kind: ProviderKind,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<AnnotationsReply, GameCommandError> {
    let service = Arc::clone(service.inner());
    let owner = Arc::clone(&service);
    let world = world_id.clone();
    let route = blocking(move || owner.store(&world, false)).await?;
    let lease = SummaryLease::acquire(service, route, &operation_id)?;
    // IPC receiver loss detaches this owned task; explicit cancellation still
    // reaches it through cancel_game_turn's shared operation token.
    tauri::async_runtime::spawn(run_summary(
        lease,
        world_id,
        expected_head_turn_id,
        source_turn_ids,
        provider_kind,
    ))
    .await
    .map_err(|_| GameCommandError::new("game_worker_failed"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use lishi_core::{
        game_context::ContextBudget,
        game_protocol::WorldSetup,
        game_store::{GameActionKind, GameTurnRequest},
        secrets::{SecretSlot, SecretStore, SecretStoreError, SecretValue},
    };
    use std::{
        collections::BTreeMap,
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            mpsc, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };

    const WORLD: &str = "summary-native-world";
    const FAKE_KEY: &str = "invalid-summary-only-fixture-key";
    #[derive(Default)]
    struct FakeSecrets {
        values: Mutex<BTreeMap<String, String>>,
        reads: AtomicUsize,
    }
    impl SecretStore for FakeSecrets {
        fn save(&self, slot: &SecretSlot, value: &SecretValue) -> Result<(), SecretStoreError> {
            self.values
                .lock()
                .unwrap()
                .insert(slot.as_str().into(), value.expose_secret().into());
            Ok(())
        }
        fn load(&self, slot: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.values
                .lock()
                .unwrap()
                .get(slot.as_str())
                .map(|value| SecretValue::new(value.clone()))
                .transpose()
        }
        fn delete(&self, slot: &SecretSlot) -> Result<(), SecretStoreError> {
            self.values.lock().unwrap().remove(slot.as_str());
            Ok(())
        }
    }
    fn seed(
        turns: usize,
    ) -> (
        tempfile::TempDir,
        Arc<GameService>,
        Arc<StoreRoute>,
        Arc<FakeSecrets>,
        Vec<String>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let secrets = Arc::new(FakeSecrets::default());
        let service = Arc::new(GameService::open(directory.path(), secrets.clone()).unwrap());
        let route = service.store(WORLD, true).unwrap();
        route
            .create_world(&WorldSetup {
                world_id: WORLD.into(),
                title: "摘要隔离夹具".into(),
                country: "唐".into(),
                era_year: 618,
                location_name: "长安".into(),
                protagonist_name: "行旅者".into(),
                narrative_style: "简洁".into(),
            })
            .unwrap();
        let mut ids = Vec::new();
        for index in 0..turns {
            let view = route.view().unwrap();
            let id = format!("summary-source-{index:04}");
            let request = GameTurnRequest {
                world_id: WORLD.into(),
                branch_id: "main".into(),
                operation_id: id.clone(),
                expected_head_turn_id: view.head_turn_id().map(str::to_owned),
                action_kind: GameActionKind::Action,
                action_text: format!("整理行囊，记录线索{index}"),
            };
            route.begin(&request).unwrap();
            route.mark_generating(&id).unwrap();
            let output = StoreRoute::demo_output(&view, &request).unwrap();
            route.stage_output(&id, &output.json().unwrap()).unwrap();
            route.commit_with_hook(&id, &output, || Ok(())).unwrap();
            ids.push(id);
        }
        (directory, service, route, secrets, ids)
    }
    fn configure(
        service: &GameService,
        secrets: &FakeSecrets,
        endpoint: &str,
        budget: ContextBudget,
    ) {
        let slot = SecretSlot::new("summary-test-key").unwrap();
        secrets
            .save(&slot, &SecretValue::new(FAKE_KEY.into()).unwrap())
            .unwrap();
        service
            .providers
            .save_with_context_budget(endpoint, "summary-fixture", slot.as_str(), 0, true, budget)
            .unwrap();
    }
    fn head(route: &StoreRoute) -> Option<String> {
        route.view().unwrap().head_turn_id().map(str::to_owned)
    }
    async fn summarize(
        service: &Arc<GameService>,
        route: &Arc<StoreRoute>,
        id: &str,
        sources: Vec<String>,
        kind: ProviderKind,
    ) -> Result<AnnotationsReply, GameCommandError> {
        let lease = SummaryLease::acquire(Arc::clone(service), Arc::clone(route), id)?;
        run_summary(lease, WORLD.into(), head(route), sources, kind).await
    }
    fn json(reply: &AnnotationsReply) -> serde_json::Value {
        serde_json::to_value(reply).unwrap()
    }
    fn formal(route: &StoreRoute) -> serde_json::Value {
        serde_json::to_value(route.view().unwrap()).unwrap()
    }

    #[derive(Clone, Copy)]
    enum Response {
        Complete,
        Reject,
        Empty,
        Slow,
    }
    struct Fixture {
        endpoint: String,
        calls: Arc<AtomicUsize>,
        requests: mpsc::Receiver<serde_json::Value>,
        stop: Arc<AtomicBool>,
        task: Option<thread::JoinHandle<()>>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(task) = self.task.take() {
                task.join().unwrap();
            }
        }
    }
    fn read_exact_before(
        socket: &mut TcpStream,
        mut remaining: &mut [u8],
        deadline: Instant,
    ) -> std::io::Result<()> {
        while !remaining.is_empty() {
            if Instant::now() >= deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "fixture request read deadline exceeded",
                ));
            }
            match socket.read(remaining) {
                Ok(0) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "fixture request ended early",
                    ))
                }
                Ok(size) => remaining = &mut remaining[size..],
                Err(problem) if problem.kind() == std::io::ErrorKind::Interrupted => continue,
                // Windows reports a socket timeout as WSAEWOULDBLOCK. Both
                // forms retry within the one deadline for the complete request.
                Err(problem)
                    if matches!(
                        problem.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    thread::sleep(Duration::from_millis(1));
                }
                Err(problem) => return Err(problem),
            }
        }
        Ok(())
    }
    fn request_body(socket: &mut TcpStream) -> serde_json::Value {
        // Accepted sockets must not inherit the listener's polling mode.
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            read_exact_before(socket, &mut byte, deadline).expect("bounded fixture HTTP header");
            header.push(byte[0]);
            assert!(header.len() < 16 * 1024);
        }
        let headers = String::from_utf8(header).unwrap();
        let size: usize = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().unwrap())
            })
            .unwrap();
        assert!(size < 8 * 1024 * 1024);
        let mut body = vec![0; size];
        read_exact_before(socket, &mut body, deadline).expect("bounded fixture HTTP body");
        serde_json::from_slice(&body).unwrap()
    }
    fn fixture(response: Response) -> Fixture {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&calls);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let (tx, requests) = mpsc::channel();
        let task = thread::spawn(move || {
            let mut accept_deadline = Instant::now() + Duration::from_secs(10);
            while !stopped.load(Ordering::SeqCst) {
                assert!(
                    Instant::now() < accept_deadline,
                    "fixture accept deadline exceeded"
                );
                let (mut socket, _) = match listener.accept() {
                    Ok(socket) => socket,
                    Err(problem)
                        if matches!(
                            problem.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(problem) if problem.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(problem) => panic!("fixture accept: {problem}"),
                };
                count.fetch_add(1, Ordering::SeqCst);
                let body = request_body(&mut socket);
                accept_deadline = Instant::now() + Duration::from_secs(10);
                let _ = tx.send(body);
                let (status,content_type,text)=match response {
                    Response::Complete|Response::Slow=>(200,"text/event-stream","data: {\"choices\":[{\"delta\":{\"content\":\"来源准确的剧情摘要\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":23,\"completion_tokens\":7,\"total_tokens\":30}}\n\ndata: [DONE]\n\n"),
                    Response::Reject=>(429,"application/json","{\"error\":\"fixture refusal\"}"),
                    Response::Empty=>(200,"text/event-stream","data: [DONE]\n\n"),
                };
                if matches!(response, Response::Slow) {
                    thread::sleep(Duration::from_millis(300));
                }
                let header=format!("HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",text.len());
                // Cancellation may close the peer before these writes.
                let _ = socket.write_all(header.as_bytes());
                let _ = socket.write_all(text.as_bytes());
            }
        });
        Fixture {
            endpoint,
            calls,
            requests,
            stop,
            task: Some(task),
        }
    }

    #[tokio::test]
    async fn native_local_summary_uses_originals_beyond_recent_window_and_never_changes_formal_world(
    ) {
        let (_directory, service, route, secrets, ids) = seed(102);
        let before = formal(&route);
        assert!(before["turns"]
            .as_array()
            .unwrap()
            .iter()
            .all(|turn| turn["turnId"] != ids[0]));
        let reply = summarize(
            &service,
            &route,
            "summary-local-old",
            ids[..2].to_vec(),
            ProviderKind::Demo,
        )
        .await
        .unwrap();
        let reply = json(&reply);
        let operation = &reply["operations"][0];
        assert_eq!(operation["status"], "completed");
        assert_eq!(operation["plan"]["provider"], LOCAL_SUMMARY_MODEL);
        assert_eq!(operation["modelRequestsReserved"], 0);
        assert_eq!(operation["attempts"], serde_json::json!([]));
        assert_eq!(operation["sources"][0]["turnId"], ids[0]);
        assert_eq!(operation["sources"][1]["sequence"], 2);
        assert!(operation["body"].as_str().unwrap().contains(&ids[0]));
        assert_eq!(secrets.reads.load(Ordering::SeqCst), 0);
        assert_eq!(formal(&route), before);
        assert!(service.active.lock().unwrap().is_none());
        assert!(summarize(
            &service,
            &route,
            "summary-local-old",
            ids[..2].to_vec(),
            ProviderKind::Demo
        )
        .await
        .is_err());
        assert_eq!(formal(&route), before);
    }
    #[tokio::test]
    async fn native_loopback_summary_sends_once_with_reserved_output_and_real_usage() {
        let local = fixture(Response::Complete);
        let (_directory, service, route, secrets, ids) = seed(2);
        configure(
            &service,
            &secrets,
            &local.endpoint,
            ContextBudget::default(),
        );
        let before = formal(&route);
        let reply = json(
            &summarize(
                &service,
                &route,
                "summary-network-once",
                ids.clone(),
                ProviderKind::Compatible,
            )
            .await
            .unwrap(),
        );
        let body = local.requests.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["stream_options"]["include_usage"], true);
        assert!(body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains(&ids[0]));
        assert_eq!(local.calls.load(Ordering::SeqCst), 1);
        let op = &reply["operations"][0];
        assert_eq!(op["status"], "completed");
        assert_eq!(op["modelRequestsReserved"], 1);
        assert_eq!(op["attempts"][0]["usage"]["inputTokens"], 23);
        assert_eq!(op["attempts"][0]["usage"]["totalTokens"], 30);
        assert_eq!(
            op["attempts"][0]["usage"]["costMicrounits"],
            serde_json::Value::Null
        );
        assert!(!reply.to_string().contains(FAKE_KEY));
        assert_eq!(formal(&route), before);
    }
    #[tokio::test]
    async fn native_failure_is_persisted_without_retry_and_next_local_summary_remains_available() {
        for response in [Response::Reject, Response::Empty] {
            let local = fixture(response);
            let (_directory, service, route, secrets, ids) = seed(1);
            configure(
                &service,
                &secrets,
                &local.endpoint,
                ContextBudget::default(),
            );
            let before = formal(&route);
            let reply = json(
                &summarize(
                    &service,
                    &route,
                    "summary-native-failed",
                    ids.clone(),
                    ProviderKind::Compatible,
                )
                .await
                .unwrap(),
            );
            assert_eq!(reply["operations"][0]["status"], "failed");
            let expected_failure = if matches!(response, Response::Reject) {
                "provider_rejected"
            } else {
                "invalid_output"
            };
            assert_eq!(reply["operations"][0]["failure"], expected_failure);
            assert_eq!(
                reply["operations"][0]["attempts"][0]["failure"],
                expected_failure
            );
            assert_eq!(reply["operations"][0]["modelRequestsReserved"], 1);
            assert_eq!(reply["operations"][0]["attempts"][0]["status"], "failed");
            assert!(reply["annotations"]["summaries"]
                .as_array()
                .unwrap()
                .is_empty());
            assert_eq!(local.calls.load(Ordering::SeqCst), 1);
            assert_eq!(formal(&route), before);
            assert!(service.active.lock().unwrap().is_none());
            assert!(summarize(
                &service,
                &route,
                "summary-after-failure",
                ids,
                ProviderKind::Demo
            )
            .await
            .is_ok());
            assert_eq!(formal(&route), before);
        }
    }
    #[tokio::test]
    async fn native_oversized_optional_summary_defers_before_credentials_or_http() {
        let local = fixture(Response::Complete);
        let (_directory, service, route, secrets, ids) = seed(1);
        configure(
            &service,
            &secrets,
            &local.endpoint,
            ContextBudget {
                max_input_bytes: 100,
                ..ContextBudget::default()
            },
        );
        let before = formal(&route);
        let reply = json(
            &summarize(
                &service,
                &route,
                "summary-native-defer",
                ids,
                ProviderKind::Compatible,
            )
            .await
            .unwrap(),
        );
        assert_eq!(reply["operations"][0]["status"], "deferred");
        assert_eq!(reply["operations"][0]["modelRequestsReserved"], 0);
        assert_eq!(local.calls.load(Ordering::SeqCst), 0);
        assert_eq!(secrets.reads.load(Ordering::SeqCst), 0);
        assert_eq!(formal(&route), before);
        assert!(service.active.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn native_active_token_cancels_summary_and_does_not_create_formal_operation() {
        let local = fixture(Response::Slow);
        let (_directory, service, route, secrets, ids) = seed(1);
        configure(
            &service,
            &secrets,
            &local.endpoint,
            ContextBudget::default(),
        );
        let before = formal(&route);
        let lease = SummaryLease::acquire(
            Arc::clone(&service),
            Arc::clone(&route),
            "summary-native-cancel",
        )
        .unwrap();
        let task = tauri::async_runtime::spawn(run_summary(
            lease,
            WORLD.into(),
            head(&route),
            ids,
            ProviderKind::Compatible,
        ));
        local.requests.recv_timeout(Duration::from_secs(5)).unwrap();
        {
            let active = service.active.lock().unwrap();
            active.as_ref().unwrap().cancel.cancel();
        }
        let reply = json(&task.await.unwrap().unwrap());
        assert_eq!(reply["operations"][0]["status"], "cancelled");
        assert_eq!(reply["operations"][0]["attempts"][0]["status"], "cancelled");
        assert_eq!(reply["operations"][0]["modelRequestsReserved"], 1);
        assert!(reply["annotations"]["summaries"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(formal(&route), before);
        assert!(service.active.lock().unwrap().is_none());
        assert_eq!(local.calls.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn owned_summary_task_survives_ipc_receiver_loss_and_rejects_parallel_turn() {
        let local = fixture(Response::Slow);
        let (_directory, service, route, secrets, ids) = seed(1);
        configure(
            &service,
            &secrets,
            &local.endpoint,
            ContextBudget::default(),
        );
        let before = formal(&route);
        let lease = SummaryLease::acquire(
            Arc::clone(&service),
            Arc::clone(&route),
            "summary-native-detach",
        )
        .unwrap();
        let task = tauri::async_runtime::spawn(run_summary(
            lease,
            WORLD.into(),
            head(&route),
            ids,
            ProviderKind::Compatible,
        ));
        drop(task);
        local.requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(service
            .turn_lease(Arc::clone(&route), "formal-while-summary")
            .is_err());
        let deadline = Instant::now() + Duration::from_secs(4);
        while service.active.lock().unwrap().is_some() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let prepared = service.memory(WORLD).unwrap();
        let StoreRoute::V2(store) = route.as_ref() else {
            panic!("v2")
        };
        let view = store.view().unwrap();
        let reply = json(
            &prepared
                .annotation_reply(&view, &store.knowledge_history().unwrap())
                .unwrap(),
        );
        assert_eq!(reply["operations"][0]["status"], "completed");
        assert_eq!(local.calls.load(Ordering::SeqCst), 1);
        assert_eq!(formal(&route), before);
    }
    #[tokio::test]
    async fn invalid_source_order_and_stale_head_fail_before_persisting_or_requesting() {
        let (_directory, service, route, secrets, ids) = seed(2);
        let before = formal(&route);
        assert!(summarize(
            &service,
            &route,
            "summary-invalid-sources",
            vec![ids[1].clone(), ids[0].clone()],
            ProviderKind::Demo
        )
        .await
        .is_err());
        let lease = SummaryLease::acquire(
            Arc::clone(&service),
            Arc::clone(&route),
            "summary-stale-head",
        )
        .unwrap();
        assert!(
            run_summary(lease, WORLD.into(), None, ids, ProviderKind::Demo)
                .await
                .is_err()
        );
        assert_eq!(secrets.reads.load(Ordering::SeqCst), 0);
        assert_eq!(formal(&route), before);
        assert!(service.active.lock().unwrap().is_none());
    }
}
