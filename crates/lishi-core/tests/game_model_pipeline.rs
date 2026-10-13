//! Real local HTTP -> structured model output -> formal world transaction.
//! Fixtures use an explicitly invalid token and isolated temporary databases;
//! no product command or persisted provider is put into fixture mode.

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

use lishi_core::{
    game_protocol::{initial_state, parse_output, WorldSetup},
    game_provider::{compile_game_prompt, initial_choices, opening_narrative},
    game_store::{
        GameActionKind, GameOperationStatus, GameStore, GameStoreError, GameTurnRequest, WorldView,
    },
    model_probe::{
        run_model_probe_with_options, CredentialMode, ModelProbeRequest, ModelProbeResult,
        FIXTURE_CREDENTIAL,
    },
    CancellationToken, StreamErrorCode, StreamOptions, StreamStatus,
};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::{JoinHandle, JoinSet},
};

const WORLD_ID: &str = "http-world-fixture-0001";
const STORY: &str = "你在长安购买粮食，支付7记账单位。\n行囊和钥匙🔑仍在，准备继续旅行🙂。";
const UPSTREAM_PRIVATE_MARKER: &str = "PRIVATE_UPSTREAM_NOTE_MUST_NOT_BECOME_FACT";

#[derive(Clone)]
enum Response {
    Sse(String),
    RateLimited,
    Stall,
}

struct CapturedRequest {
    valid_transport: bool,
    credential_matches: bool,
    body: Value,
}

struct Fixture {
    endpoint: String,
    count: Arc<AtomicUsize>,
    received: Option<oneshot::Receiver<CapturedRequest>>,
    task: Option<JoinHandle<()>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Fixture {
    async fn start(response: Response) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let count = Arc::new(AtomicUsize::new(0));
        let worker_count = Arc::clone(&count);
        let (sender, received) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut sender = Some(sender);
            // Keep accepting while an earlier stream stalls, so a retry or
            // parallel background attempt is counted rather than hidden in
            // the listener backlog. Dropping JoinSet aborts owned children.
            let mut children = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break; };
                        worker_count.fetch_add(1, Ordering::SeqCst);
                        let acknowledgement = sender.take();
                        let response = response.clone();
                        children.spawn(serve(socket, response, acknowledgement));
                    }
                    result = children.join_next(), if !children.is_empty() => {
                        if let Some(Err(error)) = result {
                            assert!(error.is_cancelled(), "fixture child unexpectedly failed");
                        }
                    }
                }
            }
        });
        Self {
            endpoint,
            count,
            received: Some(received),
            task: Some(task),
        }
    }

    async fn captured(&mut self) -> CapturedRequest {
        tokio::time::timeout(Duration::from_secs(2), self.received.take().unwrap())
            .await
            .expect("actual POST must reach the fixture")
            .unwrap()
    }

    async fn finish_count(&mut self) -> usize {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let count = self.count.load(Ordering::SeqCst);
        let task = self.task.take().unwrap();
        task.abort();
        let _ = task.await;
        count
    }
}

async fn serve(
    mut socket: TcpStream,
    response: Response,
    acknowledgement: Option<oneshot::Sender<CapturedRequest>>,
) {
    socket.set_nodelay(true).unwrap();
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        let Ok(byte) = socket.read_u8().await else {
            return;
        };
        headers.push(byte);
        if headers.len() > 16 * 1024 {
            return;
        }
    }
    let headers = String::from_utf8(headers).unwrap();
    let lower = headers.to_ascii_lowercase();
    let Some(length) = lower
        .lines()
        .find_map(|line| line.strip_prefix("content-length: "))
    else {
        return;
    };
    let length: usize = length.parse().unwrap();
    if length > 20 * 1024 {
        return;
    }
    let mut body = vec![0; length];
    if socket.read_exact(&mut body).await.is_err() {
        return;
    }
    let body: Value = serde_json::from_slice(&body).unwrap();
    let request = CapturedRequest {
        valid_transport: headers.lines().next() == Some("POST /v1/chat/completions HTTP/1.1")
            && lower.contains("content-type: application/json\r\n")
            && lower.contains("accept: text/event-stream\r\n"),
        credential_matches: headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("authorization")
                    .then_some(value.trim())
            })
            .is_some_and(|value| value == format!("Bearer {FIXTURE_CREDENTIAL}")),
        body,
    };
    if let Some(sender) = acknowledgement {
        let _ = sender.send(request);
    }
    let (status, content_type) = if matches!(response, Response::RateLimited) {
        (429, "application/json")
    } else {
        (200, "text/event-stream; charset=utf-8")
    };
    let headers = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    );
    if socket.write_all(headers.as_bytes()).await.is_err() {
        return;
    }
    let body = match response {
        Response::Sse(body) => body,
        Response::RateLimited => json!({"error":{"message":UPSTREAM_PRIVATE_MARKER}}).to_string(),
        Response::Stall => {
            tokio::time::sleep(Duration::from_secs(2)).await;
            return;
        }
    };
    // Transfer chunks deliberately cut through UTF-8 scalars and SSE fields.
    for bytes in body.as_bytes().chunks(23) {
        if socket
            .write_all(format!("{:x}\r\n", bytes.len()).as_bytes())
            .await
            .is_err()
            || socket.write_all(bytes).await.is_err()
            || socket.write_all(b"\r\n").await.is_err()
        {
            return;
        }
    }
    let _ = socket.write_all(b"0\r\n\r\n").await;
}

fn new_world(directory: &std::path::Path) -> GameStore {
    let setup = WorldSetup {
        world_id: WORLD_ID.to_owned(),
        title: "真实本地HTTP管线测试🔑".to_owned(),
        country: "唐".to_owned(),
        era_year: 618,
        location_name: "长安".to_owned(),
        protagonist_name: "林时".to_owned(),
        narrative_style: "中文，重要决定由玩家选择。".to_owned(),
    };
    let store = GameStore::open(directory.join("model-world.sqlite")).unwrap();
    store
        .create_world(
            &setup,
            &initial_state(&setup).unwrap(),
            &opening_narrative(&setup),
            &initial_choices(),
        )
        .unwrap();
    store
}

fn turn(id: &str) -> GameTurnRequest {
    GameTurnRequest {
        operation_id: id.to_owned(),
        world_id: WORLD_ID.to_owned(),
        branch_id: "main".to_owned(),
        expected_head_turn_id: None,
        action_kind: GameActionKind::Action,
        action_text: "购买粮食，保管好行囊和钥匙🔑。".to_owned(),
    }
}

fn model_output(changes: Value) -> String {
    json!({"protocolVersion":1,"narrative":STORY,"choices":[{"id":"continue","text":"继续了解长安。"}],
        "timeAdvance":{"elapsedSeconds":5400},"stateChanges":changes,
        "events":[{"id":"bought-food","description":"支付7记账单位购买粮食。","entityIds":["player"]}],
        "sourceReferences":[],"uncertainties":["固定测试背景，未进行历史研究。"]}).to_string()
}

fn sse(text: &str, done: bool, truncated: bool) -> String {
    let mut body = format!(
        "data: {}\n\n",
        json!({"choices":[{"delta":{"content":text}}]})
    );
    if truncated {
        body.push_str(&format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{},"finish_reason":"length"}]})
        ));
    }
    if done {
        body.push_str("data: [DONE]\n\n");
    }
    body
}

fn probe_request(store: &GameStore, turn: &GameTurnRequest, endpoint: &str) -> ModelProbeRequest {
    let prompt = compile_game_prompt(&store.view().unwrap(), turn).unwrap();
    assert!(prompt.contains(&turn.action_text));
    assert!(!prompt.contains(FIXTURE_CREDENTIAL));
    ModelProbeRequest {
        operation_id: turn.operation_id.clone(),
        endpoint: endpoint.to_owned(),
        model: "fixture-model".to_owned(),
        prompt,
        include_usage: false,
        credential_mode: CredentialMode::Fixture,
    }
}

fn options() -> StreamOptions {
    StreamOptions {
        connect_timeout: Duration::from_secs(1),
        idle_timeout: Duration::from_secs(1),
        total_timeout: Duration::from_secs(3),
        ..StreamOptions::default()
    }
}

async fn generate(store: &GameStore, turn: &GameTurnRequest, endpoint: &str) -> ModelProbeResult {
    let request = probe_request(store, turn, endpoint);
    store.begin(turn).unwrap();
    store.mark_generating(&turn.operation_id).unwrap();
    run_model_probe_with_options(request, None, CancellationToken::new(), options(), |_| true).await
}

fn assert_transport(captured: CapturedRequest) {
    assert!(captured.valid_transport);
    assert!(
        captured.credential_matches,
        "only the fixed invalid fixture token may be transmitted"
    );
    assert_eq!(captured.body["model"], "fixture-model");
    assert_eq!(captured.body["stream"], true);
    assert_eq!(captured.body["messages"][0]["role"], "user");
    assert!(captured.body["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("当前正式状态："));
    assert!(captured.body.get("stream_options").is_none());
}

fn assert_formal_unchanged(before: &WorldView, after: &WorldView) {
    assert_eq!(after.setup, before.setup);
    assert_eq!(after.state, before.state);
    assert_eq!(after.head_turn_id, before.head_turn_id);
    assert_eq!(after.turn_count, before.turn_count);
    assert_eq!(after.turns, before.turns);
    assert_eq!(after.opening_narrative, before.opening_narrative);
    assert_eq!(after.opening_choices, before.opening_choices);
    assert_eq!(after.narrative_policy, before.narrative_policy);
}

fn finish_transport_failure(
    store: &GameStore,
    turn: &GameTurnRequest,
    result: &ModelProbeResult,
    cancelled: bool,
) {
    let code = if cancelled {
        "game_cancelled".to_owned()
    } else {
        serde_json::to_value(result.stream.error_code.unwrap())
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    };
    store
        .finish_uncommitted(
            &turn.operation_id,
            if cancelled {
                GameOperationStatus::Cancelled
            } else {
                GameOperationStatus::Failed
            },
            Some(&code),
        )
        .unwrap();
    let serialized = serde_json::to_string(result).unwrap();
    assert!(!serialized.contains(FIXTURE_CREDENTIAL));
    assert!(!serialized.contains(UPSTREAM_PRIVATE_MARKER));
    assert_eq!(result.diagnostics.attempts, 1);
}

#[tokio::test]
async fn chinese_structured_sse_reaches_one_immutable_formal_turn_without_retry() {
    let directory = tempfile::tempdir().unwrap();
    let store = new_world(directory.path());
    let turn = turn("http-valid-turn-0001");
    let body = model_output(
        json!([{"type":"change_resource","ownerId":"player","key":"cash","unit":"记账单位","delta":-7,"expectedAmount":100}]),
    );
    let mut fixture = Fixture::start(Response::Sse(sse(&body, true, false))).await;
    let result = generate(&store, &turn, &fixture.endpoint).await;
    assert_transport(fixture.captured().await);
    assert_eq!(result.stream.status, StreamStatus::Completed);
    assert_eq!(result.diagnostics.attempts, 1);
    assert_eq!(result.diagnostics.http_status, Some(200));
    let output = parse_output(&result.stream.text).unwrap();
    store
        .stage_output(&turn.operation_id, &result.stream.text)
        .unwrap();
    let committed = store.commit(&turn.operation_id, &output).unwrap();
    assert_eq!(committed.turn_count, 1);
    assert_eq!(committed.state.resources[0].amount, 93);
    assert_eq!(committed.state.time.elapsed_seconds, 5400);
    assert_eq!(committed.turns[0].narrative, STORY);
    assert_eq!(
        committed.latest_operation.as_ref().unwrap().status,
        GameOperationStatus::Committed
    );
    assert_eq!(store.begin(&turn), Err(GameStoreError::Duplicate));
    assert_eq!(
        store.commit(&turn.operation_id, &output),
        Err(GameStoreError::InvalidTransition)
    );
    assert_eq!(
        fixture.finish_count().await,
        1,
        "no extra HTTP for duplicate or implicit repair"
    );
    drop(store);
    let reopened = GameStore::open(directory.path().join("model-world.sqlite")).unwrap();
    assert_eq!(reopened.view().unwrap(), committed);
}

#[tokio::test]
async fn valid_json_with_unknown_entity_is_rejected_by_real_store_without_model_repair() {
    let directory = tempfile::tempdir().unwrap();
    let store = new_world(directory.path());
    let before = store.view().unwrap();
    let turn = turn("http-illegal-turn-0001");
    let body = model_output(json!([{"type":"move","locationId":"unknown-place"}]));
    let mut fixture = Fixture::start(Response::Sse(sse(&body, true, false))).await;
    let result = generate(&store, &turn, &fixture.endpoint).await;
    assert_transport(fixture.captured().await);
    assert_eq!(result.stream.status, StreamStatus::Completed);
    let output = parse_output(&result.stream.text).unwrap();
    store
        .stage_output(&turn.operation_id, &result.stream.text)
        .unwrap();
    assert_eq!(
        store.commit(&turn.operation_id, &output),
        Err(GameStoreError::InvalidOutput)
    );
    store
        .finish_uncommitted(
            &turn.operation_id,
            GameOperationStatus::Failed,
            Some("game_invalid_reference"),
        )
        .unwrap();
    let after = store.view().unwrap();
    assert_formal_unchanged(&before, &after);
    assert_eq!(
        after.latest_operation.unwrap().status,
        GameOperationStatus::Failed
    );
    assert_eq!(result.diagnostics.attempts, 1);
    assert_eq!(fixture.finish_count().await, 1);
}

#[tokio::test]
async fn provider_length_truncation_and_missing_done_do_not_commit_even_if_json_is_complete() {
    for (index, truncated) in [true, false].into_iter().enumerate() {
        let directory = tempfile::tempdir().unwrap();
        let store = new_world(directory.path());
        let before = store.view().unwrap();
        let turn = turn(&format!("http-truncated-turn-{index:04}"));
        let mut fixture = Fixture::start(Response::Sse(sse(
            &model_output(json!([])),
            truncated,
            truncated,
        )))
        .await;
        let result = generate(&store, &turn, &fixture.endpoint).await;
        assert_transport(fixture.captured().await);
        assert_eq!(result.stream.status, StreamStatus::Failed);
        assert_eq!(
            result.stream.error_code,
            Some(if truncated {
                StreamErrorCode::Truncated
            } else {
                StreamErrorCode::UnexpectedEof
            })
        );
        finish_transport_failure(&store, &turn, &result, false);
        assert_formal_unchanged(&before, &store.view().unwrap());
        assert_eq!(fixture.finish_count().await, 1);
    }
}

#[tokio::test]
async fn rate_limit_retains_player_input_without_upstream_body_facts_or_retry() {
    let directory = tempfile::tempdir().unwrap();
    let store = new_world(directory.path());
    let before = store.view().unwrap();
    let turn = turn("http-rate-limit-turn-0001");
    let mut fixture = Fixture::start(Response::RateLimited).await;
    let result = generate(&store, &turn, &fixture.endpoint).await;
    assert_transport(fixture.captured().await);
    assert_eq!(result.stream.status, StreamStatus::Failed);
    assert_eq!(result.stream.error_code, Some(StreamErrorCode::HttpStatus));
    assert_eq!(result.diagnostics.http_status, Some(429));
    finish_transport_failure(&store, &turn, &result, false);
    let after = store.view().unwrap();
    assert_formal_unchanged(&before, &after);
    let operation = after.latest_operation.unwrap();
    assert_eq!(operation.action_text, turn.action_text);
    assert_eq!(operation.status, GameOperationStatus::Failed);
    assert_eq!(operation.error_code.as_deref(), Some("http_status"));
    assert_eq!(fixture.finish_count().await, 1);
}

#[tokio::test]
async fn cancel_after_actual_post_preserves_formal_world_and_never_resends() {
    let directory = tempfile::tempdir().unwrap();
    let store = new_world(directory.path());
    let before = store.view().unwrap();
    let turn = turn("http-cancelled-turn-0001");
    let mut fixture = Fixture::start(Response::Stall).await;
    let request = probe_request(&store, &turn, &fixture.endpoint);
    store.begin(&turn).unwrap();
    store.mark_generating(&turn.operation_id).unwrap();
    let cancel = CancellationToken::new();
    let worker_cancel = cancel.clone();
    let worker = tokio::spawn(async move {
        run_model_probe_with_options(request, None, worker_cancel, options(), |_| true).await
    });
    assert_transport(fixture.captured().await);
    cancel.cancel();
    let result = tokio::time::timeout(Duration::from_secs(1), worker)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.stream.status, StreamStatus::Cancelled);
    finish_transport_failure(&store, &turn, &result, true);
    let after = store.view().unwrap();
    assert_formal_unchanged(&before, &after);
    assert_eq!(
        after.latest_operation.unwrap().status,
        GameOperationStatus::Cancelled
    );
    assert_eq!(fixture.finish_count().await, 1);
}
