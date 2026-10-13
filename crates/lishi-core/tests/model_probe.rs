//! Real local HTTP tests with a deliberately invalid fixture token only.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use lishi_core::game_provider::production_stream_options;
use lishi_core::model_probe::{
    run_model_probe, run_model_probe_with_endpoint_policy, run_model_probe_with_options,
    CredentialMode, ModelProbeRequest, ModelProbeResult, SavedEndpointPolicy, FIXTURE_CREDENTIAL,
};
use lishi_core::secrets::SecretValue;
use lishi_core::{
    CancellationToken, ProbeStreamEvent, StreamErrorCode, StreamEventKind, StreamOptions,
    StreamStatus,
};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

const INVALID_EXPLICIT_HTTP_TOKEN: &str = "invalid-explicit-http-local-test-token";

struct CapturedRequest {
    method: String,
    path: String,
    credential_matches: bool,
    explicit_credential_matches: bool,
    accepts_sse: bool,
    json_content_type: bool,
    body: Value,
}

struct Server {
    url: String,
    count: Arc<AtomicUsize>,
    captured: Option<oneshot::Receiver<CapturedRequest>>,
    task: JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn start_server(
    status: u16,
    content_type: &str,
    chunks: Vec<(Duration, Vec<u8>)>,
    header_delay: Duration,
    hold_after: Duration,
    redirect: bool,
) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let url = format!("http://{address}/v1/chat/completions");
    let count = Arc::new(AtomicUsize::new(0));
    let worker_count = Arc::clone(&count);
    let (tx, rx) = oneshot::channel();
    let extra = if redirect {
        format!("Location: {url}\r\n")
    } else {
        String::new()
    };
    let headers = format!(
        "HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\n{extra}Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    );
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        worker_count.fetch_add(1, Ordering::SeqCst);
        socket.set_nodelay(true).unwrap();
        let mut headers_bytes = Vec::new();
        while !headers_bytes.ends_with(b"\r\n\r\n") {
            headers_bytes.push(socket.read_u8().await.unwrap());
            assert!(headers_bytes.len() <= 16 * 1024);
        }
        let request_headers = String::from_utf8(headers_bytes).unwrap();
        let lowercase = request_headers.to_ascii_lowercase();
        let length: usize = lowercase
            .lines()
            .find_map(|line| line.strip_prefix("content-length: "))
            .unwrap()
            .parse()
            .unwrap();
        assert!(length <= 20 * 1024);
        let mut body = vec![0; length];
        socket.read_exact(&mut body).await.unwrap();
        let mut request_line = request_headers.lines().next().unwrap().split_whitespace();
        let captured = CapturedRequest {
            method: request_line.next().unwrap().to_owned(),
            path: request_line.next().unwrap().to_owned(),
            credential_matches: request_headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("authorization")
                        .then_some(value.trim())
                })
                .is_some_and(|value| value == format!("Bearer {FIXTURE_CREDENTIAL}")),
            explicit_credential_matches: request_headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("authorization")
                        .then_some(value.trim())
                })
                .is_some_and(|value| value == format!("Bearer {INVALID_EXPLICIT_HTTP_TOKEN}")),
            accepts_sse: lowercase.contains("accept: text/event-stream\r\n"),
            json_content_type: lowercase.contains("content-type: application/json\r\n"),
            body: serde_json::from_slice(&body).unwrap(),
        };
        let _ = tx.send(captured);
        if !header_delay.is_zero() {
            tokio::time::sleep(header_delay).await;
        }
        if socket.write_all(headers.as_bytes()).await.is_err() {
            return;
        }
        for (delay, bytes) in chunks {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            if socket
                .write_all(format!("{:x}\r\n", bytes.len()).as_bytes())
                .await
                .is_err()
                || socket.write_all(&bytes).await.is_err()
                || socket.write_all(b"\r\n").await.is_err()
            {
                return;
            }
        }
        if !hold_after.is_zero() {
            tokio::time::sleep(hold_after).await;
        }
        let _ = socket.write_all(b"0\r\n\r\n").await;
        drop(socket);
        // Keep the listener open to detect an accidental retry/redirect.
        if let Ok(Ok((mut socket, _))) =
            tokio::time::timeout(Duration::from_millis(200), listener.accept()).await
        {
            worker_count.fetch_add(1, Ordering::SeqCst);
            let _ = socket
                .write_all(b"HTTP/1.1 500 Test\r\nContent-Length: 0\r\n\r\n")
                .await;
        }
    });
    Server {
        url,
        count,
        captured: Some(rx),
        task,
    }
}

async fn body_server(body: String) -> Server {
    start_server(
        200,
        "text/event-stream; charset=utf-8",
        vec![(Duration::ZERO, body.into_bytes())],
        Duration::ZERO,
        Duration::ZERO,
        false,
    )
    .await
}

fn options() -> StreamOptions {
    StreamOptions {
        connect_timeout: Duration::from_secs(1),
        idle_timeout: Duration::from_secs(1),
        total_timeout: Duration::from_secs(3),
        ..StreamOptions::default()
    }
}

fn request(endpoint: String, include_usage: bool) -> ModelProbeRequest {
    ModelProbeRequest {
        operation_id: "model-test-operation".into(),
        endpoint,
        model: "fixture-model".into(),
        prompt: "请描述长安晨光🙂。".into(),
        include_usage,
        credential_mode: CredentialMode::Fixture,
    }
}

fn delta(text: &str) -> String {
    format!(
        "data: {}\n\n",
        json!({"choices":[{"delta":{"content":text}}]})
    )
}

async fn capture(
    request: ModelProbeRequest,
    options: StreamOptions,
) -> (ModelProbeResult, Vec<ProbeStreamEvent>) {
    let mut events = Vec::new();
    let result =
        run_model_probe_with_options(request, None, CancellationToken::new(), options, |event| {
            events.push(event);
            true
        })
        .await;
    assert_events(&result, &events);
    (result, events)
}

fn assert_events(result: &ModelProbeResult, events: &[ProbeStreamEvent]) {
    assert_eq!(events.first().unwrap().kind, StreamEventKind::Started);
    assert_eq!(events.last().unwrap().kind, StreamEventKind::Finished);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == StreamEventKind::Finished)
            .count(),
        1
    );
    for (sequence, event) in events.iter().enumerate() {
        assert_eq!(event.sequence, sequence as u64);
        assert_eq!(event.operation_id, result.stream.operation_id);
    }
    assert_eq!(
        events
            .iter()
            .filter_map(|event| event.text.as_deref())
            .collect::<String>(),
        result.stream.text
    );
    let serialized = serde_json::to_string(result).unwrap();
    assert!(!serialized.contains(FIXTURE_CREDENTIAL));
    assert!(!serialized.contains(INVALID_EXPLICIT_HTTP_TOKEN));
    assert!(!serialized.contains("DO_NOT_RETURN_RAW_UPSTREAM_ERROR"));
}

#[tokio::test]
async fn post_body_auth_and_usage_option_are_exact_without_auto_appending_path() {
    for include_usage in [false, true] {
        let mut server = body_server(format!("{}data: [DONE]\n\n", delta("唐朝🙂\n长安"))).await;
        let (result, _) = capture(request(server.url.clone(), include_usage), options()).await;
        let received = server.captured.take().unwrap().await.unwrap();
        assert_eq!(received.method, "POST");
        assert_eq!(received.path, "/v1/chat/completions");
        assert!(
            received.credential_matches,
            "only the fixed invalid fixture token is sent"
        );
        assert!(received.accepts_sse && received.json_content_type);
        let mut expected = json!({
            "model":"fixture-model",
            "messages":[{"role":"user","content":"请描述长安晨光🙂。"}],
            "stream":true
        });
        if include_usage {
            expected["stream_options"] = json!({"include_usage":true});
        }
        assert_eq!(received.body, expected);
        assert_eq!(result.stream.status, StreamStatus::Completed);
        assert_eq!(result.stream.text, "唐朝🙂\n长安");
        assert_eq!(result.diagnostics.http_status, Some(200));
        assert_eq!(result.diagnostics.usage, None);
        assert_eq!(result.diagnostics.attempts, 1);
        assert_eq!(server.count.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn usage_only_empty_choices_chunk_is_reported_and_null_usage_is_unknown() {
    let body = format!(
        "{}data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        delta("测试完成"),
        json!({"choices":[{"delta":{}}],"usage":null}),
        json!({"choices":[],"usage":null}),
        json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}})
    );
    let server = body_server(body).await;
    let (result, _) = capture(request(server.url.clone(), true), options()).await;
    assert_eq!(result.stream.status, StreamStatus::Completed);
    let usage = result.diagnostics.usage.unwrap();
    assert_eq!(
        (
            usage.prompt_tokens,
            usage.completion_tokens,
            usage.total_tokens
        ),
        (12, 7, 19)
    );
}

#[tokio::test]
async fn invalid_negative_fractional_overflow_and_inconsistent_usage_fail_safely() {
    for usage in [
        json!(42),
        json!({"total_tokens":3}),
        json!({"prompt_tokens":-1,"completion_tokens":2,"total_tokens":1}),
        json!({"prompt_tokens":1.5,"completion_tokens":2,"total_tokens":3}),
        json!({"prompt_tokens":1,"completion_tokens":2,"total_tokens":9}),
        json!({"prompt_tokens":u64::MAX,"completion_tokens":1,"total_tokens":0}),
        json!({"prompt_tokens":9_007_199_254_740_992_u64,"completion_tokens":0,"total_tokens":9_007_199_254_740_992_u64}),
    ] {
        let server = body_server(format!(
            "{}data: {}\n\ndata: [DONE]\n\n",
            delta("先前安全草稿"),
            json!({"choices":[],"usage":usage})
        ))
        .await;
        let (result, _) = capture(request(server.url.clone(), true), options()).await;
        assert_eq!(
            result.stream.error_code,
            Some(StreamErrorCode::InvalidPayload)
        );
        assert_eq!(result.stream.text, "先前安全草稿");
        assert_eq!(result.diagnostics.usage, None);
    }
}

#[tokio::test]
async fn http_failures_and_redirects_do_not_expose_body_or_retry() {
    for status in [401, 429, 302, 500] {
        let server = start_server(
            status,
            "application/json",
            vec![(Duration::ZERO, b"DO_NOT_RETURN_RAW_UPSTREAM_ERROR".to_vec())],
            Duration::ZERO,
            Duration::ZERO,
            status == 302,
        )
        .await;
        let (result, _) = capture(request(server.url.clone(), false), options()).await;
        assert_eq!(result.stream.error_code, Some(StreamErrorCode::HttpStatus));
        assert_eq!(result.diagnostics.http_status, Some(status));
        assert_eq!(result.diagnostics.attempts, 1);
        tokio::time::sleep(Duration::from_millis(220)).await;
        assert_eq!(
            server.count.load(Ordering::SeqCst),
            1,
            "one attempt without redirect or retry"
        );
    }
}

#[tokio::test]
async fn rejected_configuration_and_missing_saved_key_never_open_network() {
    let server = body_server(format!("{}data: [DONE]\n\n", delta("不应请求"))).await;
    for endpoint in [
        "http://localhost/probe",
        "http://127.1/probe",
        "http://2130706433/probe",
        "http://127.0.0.1.example/probe",
        "http://127.0.0.2/probe",
        "http://[::ffff:127.0.0.1]/probe",
        "https://127.0.0.1/probe",
        "http://user@127.0.0.1/probe",
        "http://127.0.0.1/probe?secret=value",
        "http://127.0.0.1/probe#fragment",
        "file:///probe",
        " http://127.0.0.1/probe",
    ] {
        let (result, _) = capture(request(endpoint.into(), false), options()).await;
        assert_eq!(result.stream.error_code, Some(StreamErrorCode::InvalidUrl));
        assert_eq!(result.diagnostics.attempts, 0);
    }
    for change in 0..5 {
        let mut input = request(server.url.clone(), false);
        match change {
            0 => input.operation_id = "bad".into(),
            1 => input.model = "model name".into(),
            2 => input.model = "x".repeat(257),
            3 => input.prompt.clear(),
            _ => input.prompt = "中".repeat(2731),
        }
        let (result, _) = capture(input, options()).await;
        assert_eq!(
            result.stream.error_code,
            Some(StreamErrorCode::InvalidConfig)
        );
        assert_eq!(result.diagnostics.attempts, 0);
    }
    let mut saved = request("https://example.invalid/v1/chat/completions".into(), false);
    saved.credential_mode = CredentialMode::Saved;
    let (result, _) = capture(saved, options()).await;
    assert_eq!(
        result.stream.error_code,
        Some(StreamErrorCode::CredentialMissing)
    );
    assert_eq!(result.diagnostics.attempts, 0);
    let mut saved_http = request(server.url.clone(), false);
    saved_http.credential_mode = CredentialMode::Saved;
    let (result, _) = capture(saved_http, options()).await;
    assert_eq!(result.stream.error_code, Some(StreamErrorCode::InvalidUrl));
    assert_eq!(server.count.load(Ordering::SeqCst), 0);
    assert!(
        request("http://[::1]:18742/v1/chat/completions".into(), false)
            .validate()
            .is_ok()
    );
    let invalid_fields = json!({"operationId":"test-op-id","endpoint":server.url,"model":"fixture-model","prompt":"test","includeUsage":false,"credentialMode":"fixture","secret":"not-accepted"});
    assert!(serde_json::from_value::<ModelProbeRequest>(invalid_fields).is_err());
}

#[tokio::test]
async fn fixture_mode_never_uses_the_supplied_saved_secret() {
    let mut server = body_server(format!("{}data: [DONE]\n\n", delta("完成"))).await;
    let result = run_model_probe_with_options(
        request(server.url.clone(), false),
        Some(SecretValue::new("isolated-unusable-saved-token".into()).unwrap()),
        CancellationToken::new(),
        options(),
        |_| true,
    )
    .await;
    assert_eq!(result.stream.status, StreamStatus::Completed);
    assert!(
        server
            .captured
            .take()
            .unwrap()
            .await
            .unwrap()
            .credential_matches
    );
}

#[tokio::test]
async fn credential_echo_split_across_json_chunks_never_reaches_events_or_result() {
    for split in 1..FIXTURE_CREDENTIAL.len() {
        let body = format!(
            "{}{}{}data: [DONE]\n\n",
            delta("安全前文："),
            delta(&FIXTURE_CREDENTIAL[..split]),
            delta(&FIXTURE_CREDENTIAL[split..])
        );
        let server = body_server(body).await;
        let (result, events) = capture(request(server.url.clone(), false), options()).await;
        assert_eq!(
            result.stream.error_code,
            Some(StreamErrorCode::CredentialEcho)
        );
        assert_eq!(result.stream.text, "安全前文：");
        assert_eq!(
            events
                .iter()
                .filter_map(|event| event.text.as_deref())
                .collect::<String>(),
            "安全前文："
        );
    }
    // A false prefix is delayed until the next character disproves a match.
    let server = body_server(format!(
        "{}{}data: [DONE]\n\n",
        delta("invalid-m01-"),
        delta("并非凭据🙂")
    ))
    .await;
    let (result, _) = capture(request(server.url.clone(), false), options()).await;
    assert_eq!(result.stream.status, StreamStatus::Completed);
    assert_eq!(result.stream.text, "invalid-m01-并非凭据🙂");
}

#[tokio::test]
async fn cancellation_and_timeouts_end_one_attempt_and_truncated_stream_keeps_safe_draft() {
    let mut server = start_server(
        200,
        "text/event-stream",
        Vec::new(),
        Duration::from_secs(2),
        Duration::ZERO,
        false,
    )
    .await;
    let rx = server.captured.take().unwrap();
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    let canceller = tokio::spawn(async move {
        rx.await.unwrap();
        signal.cancel();
    });
    let result = run_model_probe_with_options(
        request(server.url.clone(), false),
        None,
        cancel,
        options(),
        |_| true,
    )
    .await;
    canceller.await.unwrap();
    assert_eq!(result.stream.status, StreamStatus::Cancelled);
    assert_eq!(result.diagnostics.attempts, 1);
    assert_eq!(result.diagnostics.http_status, None);
    drop(server);

    let server = start_server(
        200,
        "text/event-stream",
        vec![(Duration::ZERO, delta("等待的草稿").into_bytes())],
        Duration::ZERO,
        Duration::from_secs(2),
        false,
    )
    .await;
    let (result, _) = capture(
        request(server.url.clone(), false),
        StreamOptions {
            idle_timeout: Duration::from_millis(50),
            ..options()
        },
    )
    .await;
    assert_eq!(result.stream.error_code, Some(StreamErrorCode::IdleTimeout));
    assert_eq!(result.stream.text, "等待的草稿");
    assert_eq!(result.diagnostics.attempts, 1);
    drop(server);

    let server = body_server(delta("断开前的草稿")).await;
    let (result, _) = capture(request(server.url.clone(), false), options()).await;
    assert_eq!(
        result.stream.error_code,
        Some(StreamErrorCode::UnexpectedEof)
    );
    assert_eq!(result.stream.text, "断开前的草稿");
}

#[tokio::test]
async fn precancelled_and_invalid_options_have_zero_attempts() {
    let server = body_server(format!("{}data: [DONE]\n\n", delta("不应请求"))).await;
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = run_model_probe_with_options(
        request(server.url.clone(), false),
        None,
        cancel,
        options(),
        |_| true,
    )
    .await;
    assert_eq!(result.stream.status, StreamStatus::Cancelled);
    assert_eq!(result.diagnostics.attempts, 0);
    let (result, _) = capture(
        request(server.url.clone(), false),
        StreamOptions {
            max_output_bytes: 0,
            ..options()
        },
    )
    .await;
    assert_eq!(
        result.stream.error_code,
        Some(StreamErrorCode::InvalidOptions)
    );
    assert_eq!(result.diagnostics.attempts, 0);
    assert_eq!(server.count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn post_header_timeout_and_malformed_truncation_have_safe_diagnostics() {
    let server = start_server(
        200,
        "text/event-stream",
        Vec::new(),
        Duration::from_secs(1),
        Duration::ZERO,
        false,
    )
    .await;
    let (result, _) = capture(
        request(server.url.clone(), false),
        StreamOptions {
            connect_timeout: Duration::from_millis(50),
            ..options()
        },
    )
    .await;
    assert_eq!(
        result.stream.error_code,
        Some(StreamErrorCode::ConnectTimeout)
    );
    assert_eq!(result.diagnostics.http_status, None);
    assert_eq!(result.diagnostics.attempts, 1);
    drop(server);

    for (tail, expected) in [
        ("data: not-json\n\n", StreamErrorCode::InvalidPayload),
        (
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
            StreamErrorCode::Truncated,
        ),
        (
            "data: {\"error\":{\"message\":\"DO_NOT_RETURN_RAW_UPSTREAM_ERROR\"}}\n\n",
            StreamErrorCode::UpstreamError,
        ),
    ] {
        let server = body_server(format!("{}{tail}", delta("此前安全正文"))).await;
        let (result, _) = capture(request(server.url.clone(), false), options()).await;
        assert_eq!(result.stream.error_code, Some(expected));
        assert_eq!(result.stream.text, "此前安全正文");
        assert_eq!(result.diagnostics.http_status, Some(200));
        assert_eq!(result.diagnostics.attempts, 1);
    }
}

#[test]
fn explicit_http_policy_changes_only_saved_scheme_not_url_or_fixture_rules() {
    for endpoint in [
        "http://example.invalid/v1/chat/completions",
        "http://127.0.0.1:18742/v1/chat/completions",
        "http://[::1]:18742/v1/chat/completions",
    ] {
        let mut saved = request(endpoint.into(), false);
        saved.credential_mode = CredentialMode::Saved;
        assert_eq!(saved.validate(), Err(StreamErrorCode::InvalidUrl));
        assert_eq!(
            saved.validate_with_endpoint_policy(SavedEndpointPolicy::HttpsOnly),
            Err(StreamErrorCode::InvalidUrl)
        );
        assert!(saved
            .validate_with_endpoint_policy(SavedEndpointPolicy::ExplicitHttp)
            .is_ok());
    }
    let mut https = request("https://example.invalid/v1/chat/completions".into(), false);
    https.credential_mode = CredentialMode::Saved;
    assert!(https.validate().is_ok());
    assert!(https
        .validate_with_endpoint_policy(SavedEndpointPolicy::ExplicitHttp)
        .is_ok());

    for endpoint in [
        "http://user:password@example.invalid/v1/chat/completions",
        "http://user@example.invalid/v1/chat/completions",
        "http://example.invalid/v1/chat/completions?option=value",
        "http://example.invalid/v1/chat/completions#fragment",
        "https://example.invalid/v1/chat/completions?option=value",
        "ftp://example.invalid/v1/chat/completions",
        "file:///v1/chat/completions",
        "http://",
        " http://example.invalid/v1/chat/completions",
    ] {
        let mut saved = request(endpoint.into(), false);
        saved.credential_mode = CredentialMode::Saved;
        assert_eq!(
            saved.validate_with_endpoint_policy(SavedEndpointPolicy::ExplicitHttp),
            Err(StreamErrorCode::InvalidUrl)
        );
    }
    for endpoint in [
        "http://example.invalid/v1/chat/completions",
        "http://localhost/v1/chat/completions",
        "http://127.1/v1/chat/completions",
        "http://127.0.0.2/v1/chat/completions",
        "http://127.0.0.1.example/v1/chat/completions",
        "https://127.0.0.1/v1/chat/completions",
    ] {
        assert_eq!(
            request(endpoint.into(), false)
                .validate_with_endpoint_policy(SavedEndpointPolicy::ExplicitHttp),
            Err(StreamErrorCode::InvalidUrl)
        );
    }
    assert!(
        request("http://127.0.0.1/v1/chat/completions".into(), false)
            .validate_with_endpoint_policy(SavedEndpointPolicy::ExplicitHttp)
            .is_ok()
    );
    let untrusted_dto = json!({
        "operationId":"untrusted-policy-test",
        "endpoint":"http://example.invalid/v1/chat/completions",
        "model":"fixture-model", "prompt":"local test", "includeUsage":false,
        "credentialMode":"saved", "savedEndpointPolicy":"explicit_http"
    });
    assert!(serde_json::from_value::<ModelProbeRequest>(untrusted_dto).is_err());
}

#[tokio::test]
async fn saved_http_requires_typed_opt_in_and_sends_exactly_one_local_request() {
    let mut server = body_server(format!("{}data: [DONE]\n\n", delta("显式HTTP本地验证🙂"))).await;
    let saved_request = || {
        let mut saved = request(server.url.clone(), false);
        saved.credential_mode = CredentialMode::Saved;
        saved
    };
    let fake_secret = || Some(SecretValue::new(INVALID_EXPLICIT_HTTP_TOKEN.into()).unwrap());
    let rejected = run_model_probe(
        saved_request(),
        fake_secret(),
        CancellationToken::new(),
        |_| true,
    )
    .await;
    assert_eq!(
        rejected.stream.error_code,
        Some(StreamErrorCode::InvalidUrl)
    );
    assert_eq!(rejected.diagnostics.attempts, 0);
    let rejected = run_model_probe_with_options(
        saved_request(),
        fake_secret(),
        CancellationToken::new(),
        options(),
        |_| true,
    )
    .await;
    assert_eq!(
        rejected.stream.error_code,
        Some(StreamErrorCode::InvalidUrl)
    );
    assert_eq!(rejected.diagnostics.attempts, 0);
    assert_eq!(server.count.load(Ordering::SeqCst), 0);

    let mut events = Vec::new();
    let completed = run_model_probe_with_endpoint_policy(
        saved_request(),
        fake_secret(),
        CancellationToken::new(),
        options(),
        SavedEndpointPolicy::ExplicitHttp,
        |event| {
            events.push(event);
            true
        },
    )
    .await;
    assert_events(&completed, &events);
    assert_eq!(completed.stream.status, StreamStatus::Completed);
    assert_eq!(completed.stream.text, "显式HTTP本地验证🙂");
    assert_eq!(completed.diagnostics.attempts, 1);
    assert_eq!(completed.diagnostics.http_status, Some(200));
    let captured = server.captured.take().unwrap().await.unwrap();
    assert!(captured.explicit_credential_matches);
    assert!(!captured.credential_matches);
    assert_eq!(captured.method, "POST");
    assert_eq!(captured.path, "/v1/chat/completions");
    assert_eq!(
        captured.body,
        json!({
            "model":"fixture-model",
            "messages":[{"role":"user","content":"请描述长安晨光🙂。"}],
            "stream":true
        })
    );
    tokio::time::sleep(Duration::from_millis(220)).await;
    assert_eq!(server.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn explicit_saved_http_retains_redirect_echo_and_missing_credential_guards() {
    let server = start_server(
        302,
        "application/json",
        Vec::new(),
        Duration::ZERO,
        Duration::ZERO,
        true,
    )
    .await;
    let mut saved = request(server.url.clone(), false);
    saved.credential_mode = CredentialMode::Saved;
    let result = run_model_probe_with_endpoint_policy(
        saved,
        Some(SecretValue::new(INVALID_EXPLICIT_HTTP_TOKEN.into()).unwrap()),
        CancellationToken::new(),
        options(),
        SavedEndpointPolicy::ExplicitHttp,
        |_| true,
    )
    .await;
    assert_eq!(result.stream.error_code, Some(StreamErrorCode::HttpStatus));
    assert_eq!(result.diagnostics.http_status, Some(302));
    assert_eq!(result.diagnostics.attempts, 1);
    tokio::time::sleep(Duration::from_millis(220)).await;
    assert_eq!(server.count.load(Ordering::SeqCst), 1);

    let split = INVALID_EXPLICIT_HTTP_TOKEN.len() / 2;
    let server = body_server(format!(
        "{}{}{}data: [DONE]\n\n",
        delta("安全前文"),
        delta(&INVALID_EXPLICIT_HTTP_TOKEN[..split]),
        delta(&INVALID_EXPLICIT_HTTP_TOKEN[split..]),
    ))
    .await;
    let mut saved = request(server.url.clone(), false);
    saved.credential_mode = CredentialMode::Saved;
    let mut events = Vec::new();
    let result = run_model_probe_with_endpoint_policy(
        saved,
        Some(SecretValue::new(INVALID_EXPLICIT_HTTP_TOKEN.into()).unwrap()),
        CancellationToken::new(),
        options(),
        SavedEndpointPolicy::ExplicitHttp,
        |event| {
            events.push(event);
            true
        },
    )
    .await;
    assert_events(&result, &events);
    assert_eq!(
        result.stream.error_code,
        Some(StreamErrorCode::CredentialEcho)
    );
    assert_eq!(result.stream.text, "安全前文");
    assert_eq!(result.diagnostics.attempts, 1);

    let server = body_server(format!("{}data: [DONE]\n\n", delta("不应请求"))).await;
    let mut saved = request(server.url.clone(), false);
    saved.credential_mode = CredentialMode::Saved;
    let result = run_model_probe_with_endpoint_policy(
        saved,
        None,
        CancellationToken::new(),
        options(),
        SavedEndpointPolicy::ExplicitHttp,
        |_| true,
    )
    .await;
    assert_eq!(
        result.stream.error_code,
        Some(StreamErrorCode::CredentialMissing)
    );
    assert_eq!(result.diagnostics.attempts, 0);
    assert_eq!(server.count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn explicit_policy_fixture_still_uses_only_fixed_invalid_credential() {
    let mut server = body_server(format!("{}data: [DONE]\n\n", delta("固定测试凭据"))).await;
    let result = run_model_probe_with_endpoint_policy(
        request(server.url.clone(), false),
        Some(SecretValue::new(INVALID_EXPLICIT_HTTP_TOKEN.into()).unwrap()),
        CancellationToken::new(),
        options(),
        SavedEndpointPolicy::ExplicitHttp,
        |_| true,
    )
    .await;
    assert_eq!(result.stream.status, StreamStatus::Completed);
    assert_eq!(result.diagnostics.attempts, 1);
    let captured = server.captured.take().unwrap().await.unwrap();
    assert!(captured.credential_matches);
    assert!(!captured.explicit_credential_matches);
}

#[tokio::test]
async fn reasoning_metadata_is_discarded_and_only_chinese_answer_is_emitted() {
    const REASONING_MARKER: &str = "FAKE_PRIVATE_REASONING_NOT_FOR_DISPLAY";
    let reasoning = |value: Value| format!("data: {}\n\n", json!({"choices":[{"delta":value}]}));
    let body = format!("{}{}{}{}{}{}data: [DONE]\n\n",
        reasoning(json!({"role":"assistant","reasoning_content":REASONING_MARKER,"content":null})),
        reasoning(json!({"reasoning_content":FIXTURE_CREDENTIAL})),
        reasoning(json!({"reasoning_content":"推理元数据：中文分片🙂"})),
        reasoning(json!({"reasoning_content":null,"content":"长安晨光，"})),
        reasoning(json!({"reasoning_content":"仍需丢弃的元数据","content":"你整理行囊🙂。"})),
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"\"},\"finish_reason\":\"stop\"}]}\n\n",
    );
    let bytes = body.into_bytes();
    let chunks = bytes
        .chunks(7)
        .map(|chunk| (Duration::ZERO, chunk.to_vec()))
        .collect();
    let mut server = start_server(
        200,
        "text/event-stream",
        chunks,
        Duration::ZERO,
        Duration::ZERO,
        false,
    )
    .await;
    let (result, events) = capture(request(server.url.clone(), false), options()).await;
    assert_eq!(result.stream.status, StreamStatus::Completed);
    assert_eq!(result.stream.text, "长安晨光，你整理行囊🙂。");
    assert_eq!(result.stream.delta_count, 2);
    assert_eq!(result.diagnostics.attempts, 1);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == StreamEventKind::Delta)
            .count(),
        2
    );
    let visible = serde_json::to_string(&events).unwrap();
    let serialized = serde_json::to_string(&result).unwrap();
    for forbidden in [
        REASONING_MARKER,
        FIXTURE_CREDENTIAL,
        "推理元数据",
        "仍需丢弃",
    ] {
        assert!(!visible.contains(forbidden));
        assert!(!serialized.contains(forbidden));
    }
    let received = server.captured.take().unwrap().await.unwrap();
    assert_eq!(received.method, "POST");
    assert!(received.credential_matches);
}

#[tokio::test]
async fn non_scalar_reasoning_and_other_unknown_delta_fields_still_fail() {
    for value in [
        json!(7),
        json!(true),
        json!([]),
        json!({"text":"not-a-string"}),
    ] {
        let body = format!(
            "{}data: {}\n\ndata: [DONE]\n\n",
            delta("已收到的正文"),
            json!({"choices":[{"delta":{"reasoning_content":value,"content":"不得放行"}}]})
        );
        let server = body_server(body).await;
        let (result, _) = capture(request(server.url.clone(), false), options()).await;
        assert_eq!(
            result.stream.error_code,
            Some(StreamErrorCode::InvalidPayload)
        );
        assert_eq!(result.stream.text, "已收到的正文");
        assert_eq!(result.diagnostics.attempts, 1);
    }
    let server = body_server(format!("data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"delta":{"reasoning_content":"忽略","unapproved_metadata":"拒绝","content":"不得放行"}}]})
    )).await;
    let (result, _) = capture(request(server.url.clone(), false), options()).await;
    assert_eq!(
        result.stream.error_code,
        Some(StreamErrorCode::InvalidPayload)
    );
    assert!(result.stream.text.is_empty());
}

#[tokio::test]
async fn reasoning_only_or_incomplete_answer_never_becomes_success() {
    let metadata = format!(
        "data: {}\n\n",
        json!({"choices":[{"delta":{"reasoning_content":"FAKE_REASONING_ONLY_METADATA","content":null}}]})
    );
    let server = body_server(format!("{metadata}data: [DONE]\n\n")).await;
    let (result, events) = capture(request(server.url.clone(), false), options()).await;
    assert_eq!(result.stream.error_code, Some(StreamErrorCode::EmptyOutput));
    assert_eq!(result.stream.status, StreamStatus::Failed);
    assert!(result.stream.text.is_empty());
    assert_eq!(result.stream.delta_count, 0);
    assert_eq!(events.len(), 2);

    let server = body_server(metadata).await;
    let (result, _) = capture(request(server.url.clone(), false), options()).await;
    assert_eq!(
        result.stream.error_code,
        Some(StreamErrorCode::UnexpectedEof)
    );
    assert!(result.stream.text.is_empty());
}

#[tokio::test]
async fn reasoning_extension_does_not_authorize_tools_or_weaken_refusal_finish_and_usage() {
    for (delta_value, finish, usage, expected) in [
        (
            json!({"reasoning_content":"忽略","tool_calls":[]}),
            Value::Null,
            Value::Null,
            StreamErrorCode::InvalidPayload,
        ),
        (
            json!({"reasoning_content":"忽略","function_call":{"name":"run"}}),
            Value::Null,
            Value::Null,
            StreamErrorCode::InvalidPayload,
        ),
        (
            json!({"reasoning_content":"忽略","refusal":"拒绝"}),
            Value::Null,
            Value::Null,
            StreamErrorCode::Refused,
        ),
        (
            json!({"reasoning_content":"忽略","role":"user"}),
            Value::Null,
            Value::Null,
            StreamErrorCode::InvalidPayload,
        ),
        (
            json!({"reasoning_content":"忽略"}),
            json!("length"),
            Value::Null,
            StreamErrorCode::Truncated,
        ),
        (
            json!({"reasoning_content":"忽略"}),
            json!("content_filter"),
            Value::Null,
            StreamErrorCode::Refused,
        ),
        (
            json!({"reasoning_content":"忽略"}),
            Value::Null,
            json!({"prompt_tokens":1,"completion_tokens":2,"total_tokens":9}),
            StreamErrorCode::InvalidPayload,
        ),
    ] {
        let server = body_server(format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"choices":[{"delta":delta_value,"finish_reason":finish}],"usage":usage})
        ))
        .await;
        let (result, _) = capture(request(server.url.clone(), false), options()).await;
        assert_eq!(result.stream.error_code, Some(expected));
        assert!(result.stream.text.is_empty());
        assert_eq!(result.diagnostics.attempts, 1);
    }
}

#[tokio::test]
async fn production_header_budget_accepts_slow_inference_without_changing_probe_default() {
    let probe_options = StreamOptions::default();
    let production_options = production_stream_options();
    assert_eq!(probe_options.connect_timeout, Duration::from_secs(5));
    assert_eq!(probe_options.idle_timeout, Duration::from_secs(10));
    assert_eq!(production_options.connect_timeout, Duration::from_secs(30));
    assert_eq!(production_options.idle_timeout, Duration::from_secs(30));
    assert_eq!(production_options.total_timeout, Duration::from_secs(90));
    assert_eq!(
        production_options.max_event_bytes,
        probe_options.max_event_bytes
    );
    assert_eq!(
        production_options.max_response_bytes,
        probe_options.max_response_bytes
    );
    assert_eq!(
        production_options.max_output_bytes,
        probe_options.max_output_bytes
    );

    let delay = Duration::from_millis(5200);
    let probe_server = start_server(
        200,
        "text/event-stream",
        vec![(
            Duration::ZERO,
            format!("{}data: [DONE]\n\n", delta("延后的技术探针正文")).into_bytes(),
        )],
        delay,
        Duration::ZERO,
        false,
    )
    .await;
    let production_server = start_server(
        200,
        "text/event-stream",
        vec![(
            Duration::ZERO,
            format!(
                "{}data: [DONE]\n\n",
                delta("模型延后正文，中文🙂完整保留。")
            )
            .into_bytes(),
        )],
        delay,
        Duration::ZERO,
        false,
    )
    .await;
    // Two independent HTTP requests run concurrently. The elapsed-header case
    // is measured against real transport deadlines, not a simulated clock.
    let ((timed_out, _), (completed, _)) = tokio::join!(
        capture(request(probe_server.url.clone(), false), probe_options),
        capture(
            request(production_server.url.clone(), false),
            production_options
        ),
    );
    assert_eq!(timed_out.stream.status, StreamStatus::Failed);
    assert_eq!(
        timed_out.stream.error_code,
        Some(StreamErrorCode::ConnectTimeout)
    );
    assert_eq!(timed_out.diagnostics.http_status, None);
    assert_eq!(timed_out.diagnostics.attempts, 1);
    assert!(timed_out.stream.text.is_empty());
    assert_eq!(completed.stream.status, StreamStatus::Completed);
    assert_eq!(completed.stream.text, "模型延后正文，中文🙂完整保留。");
    assert_eq!(completed.diagnostics.http_status, Some(200));
    assert_eq!(completed.diagnostics.attempts, 1);
    assert_eq!(probe_server.count.load(Ordering::SeqCst), 1);
    assert_eq!(production_server.count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn trusted_timeout_options_still_reject_zero_or_over_thirty_seconds_without_http() {
    let server = body_server(format!("{}data: [DONE]\n\n", delta("不应请求"))).await;
    for invalid in [
        StreamOptions {
            connect_timeout: Duration::ZERO,
            ..production_stream_options()
        },
        StreamOptions {
            idle_timeout: Duration::ZERO,
            ..production_stream_options()
        },
        StreamOptions {
            connect_timeout: Duration::from_secs(31),
            ..production_stream_options()
        },
        StreamOptions {
            idle_timeout: Duration::from_secs(31),
            ..production_stream_options()
        },
        StreamOptions {
            total_timeout: Duration::from_secs(91),
            ..production_stream_options()
        },
    ] {
        let (result, _) = capture(request(server.url.clone(), false), invalid).await;
        assert_eq!(
            result.stream.error_code,
            Some(StreamErrorCode::InvalidOptions)
        );
        assert_eq!(result.diagnostics.attempts, 0);
    }
    assert_eq!(server.count.load(Ordering::SeqCst), 0);
}
