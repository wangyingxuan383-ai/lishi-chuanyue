//! Real loopback HTTP/SSE tests. No external service or API credential is used.

use std::time::Duration;

use lishi_core::{
    run_probe_stream_with_options, CancellationToken, ProbeStreamEvent, StreamErrorCode,
    StreamEventKind, StreamOptions, StreamResult, StreamStatus,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

struct TestServer {
    url: String,
    task: JoinHandle<()>,
    requested: Option<oneshot::Receiver<()>>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn start_server(
    status: u16,
    content_type: &str,
    segments: Vec<(Duration, Vec<u8>)>,
    header_delay: Duration,
    hold_after: Duration,
) -> TestServer {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback server");
    let address = listener.local_addr().expect("read server address");
    let (requested_tx, requested_rx) = oneshot::channel();
    let headers = format!(
        "HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    );
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept one real request");
        socket.set_nodelay(true).expect("disable TCP coalescing");
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            let byte = socket.read_u8().await.expect("read request headers");
            request.push(byte);
            assert!(request.len() <= 8192, "bounded test request headers");
        }
        let request = String::from_utf8(request).expect("HTTP headers are ASCII");
        assert!(request.starts_with("GET /probe HTTP/1.1\r\n"));
        let lowercase = request.to_ascii_lowercase();
        assert!(lowercase.contains("accept: text/event-stream\r\n"));
        assert!(!lowercase.contains("authorization:"));
        let _ = requested_tx.send(());
        if !header_delay.is_zero() {
            tokio::time::sleep(header_delay).await;
        }
        if socket.write_all(headers.as_bytes()).await.is_err() {
            return;
        }
        for (delay, bytes) in segments {
            // Zero-duration Tokio timers still yield to the OS timer wheel.
            // Hundreds of byte chunks must not acquire artificial 15ms delays
            // on Windows and accidentally test the total timeout instead.
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let chunk_header = format!("{:x}\r\n", bytes.len());
            if socket.write_all(chunk_header.as_bytes()).await.is_err()
                || socket.write_all(&bytes).await.is_err()
                || socket.write_all(b"\r\n").await.is_err()
            {
                return; // A cancelled or rejected request may close its socket.
            }
        }
        if !hold_after.is_zero() {
            tokio::time::sleep(hold_after).await;
        }
        let _ = socket.write_all(b"0\r\n\r\n").await;
    });
    TestServer {
        url: format!("http://{address}/probe"),
        task,
        requested: Some(requested_rx),
    }
}

async fn body_server(body: Vec<u8>) -> TestServer {
    start_server(
        200,
        "text/event-stream; charset=utf-8",
        vec![(Duration::ZERO, body)],
        Duration::ZERO,
        Duration::ZERO,
    )
    .await
}

fn delta(text: &str) -> String {
    format!(
        "data: {}\n\n",
        serde_json::json!({"choices": [{"delta": {"content": text}}]})
    )
}

fn options() -> StreamOptions {
    StreamOptions {
        connect_timeout: Duration::from_secs(1),
        idle_timeout: Duration::from_secs(1),
        total_timeout: Duration::from_secs(3),
        ..StreamOptions::default()
    }
}

async fn capture(url: String, options: StreamOptions) -> (StreamResult, Vec<ProbeStreamEvent>) {
    let mut events = Vec::new();
    let result = run_probe_stream_with_options(
        "test-operation".into(),
        url,
        CancellationToken::new(),
        options,
        |event| {
            events.push(event);
            true
        },
    )
    .await;
    assert_events(&result, &events);
    (result, events)
}

fn assert_events(result: &StreamResult, events: &[ProbeStreamEvent]) {
    assert_eq!(
        events.first().expect("started event").kind,
        StreamEventKind::Started
    );
    assert_eq!(
        events.last().expect("finished event").kind,
        StreamEventKind::Finished
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == StreamEventKind::Finished)
            .count(),
        1,
        "exactly one terminal event"
    );
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event.operation_id, result.operation_id);
        assert_eq!(event.sequence, u64::try_from(index).expect("sequence fits"));
        match event.kind {
            StreamEventKind::Started => {
                assert!(event.text.is_none());
                assert!(event.status.is_none());
                assert!(event.error_code.is_none());
            }
            StreamEventKind::Delta => {
                assert!(event.text.as_ref().is_some_and(|text| !text.is_empty()));
                assert!(event.status.is_none());
                assert!(event.error_code.is_none());
            }
            StreamEventKind::Finished => {
                assert!(event.text.is_none());
                assert_eq!(event.status, Some(result.status));
                assert_eq!(event.error_code, result.error_code);
            }
        }
    }
    assert_eq!(
        events
            .iter()
            .filter_map(|event| event.text.as_deref())
            .collect::<String>(),
        result.text
    );
}

#[tokio::test]
async fn chinese_bytes_bom_comments_all_line_endings_and_multiline_data_complete() {
    let body = concat!(
        "\u{feff}: keepalive\r",
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\r\r",
        "id: ignored\r\nretry: 1\r\nevent: message\r\n",
        "data: {\"choices\":[\r\n",
        "data: {\"delta\":{\"content\":\"唐朝🙂\\n长安\"}}]}\r\n\r\n",
        "data: {\"choices\":[],\"usage\":{\"total_tokens\":10}}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\r\r"
    );
    let segments = body
        .bytes()
        .map(|byte| (Duration::ZERO, vec![byte]))
        .collect();
    let server = start_server(
        200,
        "text/event-stream",
        segments,
        Duration::ZERO,
        Duration::ZERO,
    )
    .await;
    let (result, events) = capture(server.url.clone(), options()).await;
    assert_eq!(result.status, StreamStatus::Completed, "{result:?}");
    assert_eq!(result.error_code, None);
    assert_eq!(result.text, "唐朝🙂\n长安");
    assert_eq!(result.delta_count, 1);
    assert_eq!(events.len(), 3);
    let started = serde_json::to_value(&events[0]).expect("serialize started event");
    assert_eq!(
        started,
        serde_json::json!({"operationId":"test-operation","sequence":0,"kind":"started"})
    );
    let finished =
        serde_json::to_value(events.last().expect("finished")).expect("serialize terminal");
    assert_eq!(
        finished,
        serde_json::json!({"operationId":"test-operation","sequence":2,"kind":"finished","status":"completed"})
    );
    assert!(serde_json::to_value(&result)
        .expect("serialize result")
        .get("deltaCount")
        .is_some());
}

#[tokio::test]
async fn cancel_while_waiting_for_headers_returns_one_cancelled_terminal() {
    let mut server = start_server(
        200,
        "text/event-stream",
        Vec::new(),
        Duration::from_secs(2),
        Duration::ZERO,
    )
    .await;
    let requested = server.requested.take().expect("request signal");
    let token = CancellationToken::new();
    let cancel_token = token.clone();
    let canceller = tokio::spawn(async move {
        requested.await.expect("HTTP request reached server");
        cancel_token.cancel();
    });
    let mut events = Vec::new();
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        run_probe_stream_with_options(
            "cancel-headers".into(),
            server.url.clone(),
            token,
            options(),
            |event| {
                events.push(event);
                true
            },
        ),
    )
    .await
    .expect("cancellation ends header wait promptly");
    canceller.await.expect("canceller completed");
    assert_events(&result, &events);
    assert_eq!(result.status, StreamStatus::Cancelled);
    assert_eq!(result.error_code, None);
    assert!(result.text.is_empty());
}

#[tokio::test]
async fn cancellation_of_idle_response_preserves_only_received_draft() {
    let server = start_server(
        200,
        "text/event-stream",
        vec![(Duration::ZERO, delta("收到的草稿🙂").into_bytes())],
        Duration::ZERO,
        Duration::from_secs(2),
    )
    .await;
    let token = CancellationToken::new();
    let cancel_token = token.clone();
    let mut events = Vec::new();
    let result = run_probe_stream_with_options(
        "cancel-body".into(),
        server.url.clone(),
        token,
        options(),
        |event| {
            if event.kind == StreamEventKind::Delta {
                let token = cancel_token.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    token.cancel();
                });
            }
            events.push(event);
            true
        },
    )
    .await;
    assert_events(&result, &events);
    assert_eq!(result.status, StreamStatus::Cancelled);
    assert_eq!(result.text, "收到的草稿🙂");
    assert_eq!(result.delta_count, 1);
}

#[tokio::test]
async fn malformed_refused_truncated_and_disconnected_streams_keep_draft_and_safe_codes() {
    let cases = [
        (b"".to_vec(), StreamErrorCode::UnexpectedEof),
        (b"data: not-json\n\n".to_vec(), StreamErrorCode::InvalidPayload),
        (b"data: []\n\n".to_vec(), StreamErrorCode::InvalidPayload),
        (b"data: {\"choices\":[{\"delta\":{\"content\":42}}]}\n\n".to_vec(), StreamErrorCode::InvalidPayload),
        (b"data: {\"choices\":[{\"delta\":{\"unknown_instruction\":\"DO_NOT_EXPORT_UPSTREAM_DETAIL\"}}]}\n\n".to_vec(), StreamErrorCode::InvalidPayload),
        (b"data: {\"choices\":[{\"delta\":{\"role\":42}}]}\n\n".to_vec(), StreamErrorCode::InvalidPayload),
        (b"data: {\"error\":{\"message\":\"DO_NOT_EXPORT_UPSTREAM_DETAIL\"}}\n\n".to_vec(), StreamErrorCode::UpstreamError),
        (b"event: error\ndata: DO_NOT_EXPORT_UPSTREAM_DETAIL\n\n".to_vec(), StreamErrorCode::UpstreamError),
        (b"data: {\"choices\":[{\"delta\":{\"refusal\":\"DO_NOT_EXPORT_UPSTREAM_DETAIL\"}}]}\n\n".to_vec(), StreamErrorCode::Refused),
        (b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"content_filter\"}]}\n\n".to_vec(), StreamErrorCode::Refused),
        (b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n".to_vec(), StreamErrorCode::Truncated),
        (b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{}]}}]}\n\n".to_vec(), StreamErrorCode::InvalidPayload),
        (b"data: \xff\n\n".to_vec(), StreamErrorCode::InvalidUtf8),
        (b"data: \xe4\xb8".to_vec(), StreamErrorCode::InvalidUtf8),
        (b"data: [DONE]".to_vec(), StreamErrorCode::UnexpectedEof),
    ];
    for (tail, expected) in cases {
        let mut body = delta("先前草稿").into_bytes();
        body.extend(tail);
        let server = body_server(body).await;
        let (result, _) = capture(server.url.clone(), options()).await;
        assert_eq!(result.status, StreamStatus::Failed);
        assert_eq!(result.error_code, Some(expected));
        assert_eq!(result.text, "先前草稿");
        assert_eq!(result.delta_count, 1);
        let serialized = serde_json::to_string(&result).expect("serialize safe failure");
        assert!(!serialized.contains("DO_NOT_EXPORT_UPSTREAM_DETAIL"));
        assert!(!serialized.contains(&server.url));
    }
}

#[tokio::test]
async fn missing_content_and_wrong_http_responses_do_not_complete() {
    let server = body_server(b"data: [DONE]\n\n".to_vec()).await;
    let (empty, _) = capture(server.url.clone(), options()).await;
    assert_eq!(empty.error_code, Some(StreamErrorCode::EmptyOutput));

    for (status, content_type, expected) in [
        (429, "text/event-stream", StreamErrorCode::HttpStatus),
        (302, "text/event-stream", StreamErrorCode::HttpStatus),
        (200, "application/json", StreamErrorCode::InvalidContentType),
    ] {
        let server = start_server(
            status,
            content_type,
            Vec::new(),
            Duration::ZERO,
            Duration::ZERO,
        )
        .await;
        let (result, _) = capture(server.url.clone(), options()).await;
        assert_eq!(result.status, StreamStatus::Failed);
        assert_eq!(result.error_code, Some(expected));
    }
}

#[tokio::test]
async fn header_idle_and_total_timeouts_are_distinguished() {
    let server = start_server(
        200,
        "text/event-stream",
        Vec::new(),
        Duration::from_secs(1),
        Duration::ZERO,
    )
    .await;
    let (result, _) = capture(
        server.url.clone(),
        StreamOptions {
            connect_timeout: Duration::from_millis(50),
            ..options()
        },
    )
    .await;
    assert_eq!(result.error_code, Some(StreamErrorCode::ConnectTimeout));
    drop(server);

    let server = start_server(
        200,
        "text/event-stream",
        vec![(Duration::ZERO, delta("等待草稿").into_bytes())],
        Duration::ZERO,
        Duration::from_secs(1),
    )
    .await;
    let (idle, _) = capture(
        server.url.clone(),
        StreamOptions {
            idle_timeout: Duration::from_millis(50),
            ..options()
        },
    )
    .await;
    assert_eq!(idle.error_code, Some(StreamErrorCode::IdleTimeout));
    assert_eq!(idle.text, "等待草稿");
    drop(server);

    let segments = (0..20)
        .map(|_| (Duration::from_millis(20), b": heartbeat\n\n".to_vec()))
        .collect();
    let server = start_server(
        200,
        "text/event-stream",
        segments,
        Duration::ZERO,
        Duration::ZERO,
    )
    .await;
    let (total, _) = capture(
        server.url.clone(),
        StreamOptions {
            idle_timeout: Duration::from_millis(200),
            total_timeout: Duration::from_millis(100),
            ..options()
        },
    )
    .await;
    assert_eq!(total.error_code, Some(StreamErrorCode::TotalTimeout));
}

#[tokio::test]
async fn event_response_and_output_budgets_are_enforced() {
    let prefix = delta("中");
    let event_server =
        body_server(format!("{prefix}data: {}\n\n", "x".repeat(300)).into_bytes()).await;
    let (event, _) = capture(
        event_server.url.clone(),
        StreamOptions {
            max_event_bytes: 128,
            ..options()
        },
    )
    .await;
    assert_eq!(event.error_code, Some(StreamErrorCode::EventTooLarge));
    assert_eq!(event.text, "中");

    // Separate HTTP chunks ensure the valid prefix is received before the cap.
    let response_server = start_server(
        200,
        "text/event-stream",
        vec![
            (Duration::ZERO, prefix.as_bytes().to_vec()),
            (
                Duration::from_millis(10),
                b": excessive response bytes\n\n".to_vec(),
            ),
        ],
        Duration::ZERO,
        Duration::ZERO,
    )
    .await;
    let (response, _) = capture(
        response_server.url.clone(),
        StreamOptions {
            max_response_bytes: prefix.len(),
            ..options()
        },
    )
    .await;
    assert_eq!(response.error_code, Some(StreamErrorCode::ResponseTooLarge));
    assert_eq!(response.text, "中");

    let output_server =
        body_server(format!("{prefix}{}data: [DONE]\n\n", delta("文")).into_bytes()).await;
    let (output, _) = capture(
        output_server.url.clone(),
        StreamOptions {
            max_output_bytes: 4,
            ..options()
        },
    )
    .await;
    assert_eq!(output.error_code, Some(StreamErrorCode::OutputTooLarge));
    assert_eq!(output.text, "中");
}

#[tokio::test]
async fn unsafe_urls_invalid_budgets_and_unreachable_network_use_safe_errors() {
    for url in [
        "file:///probe",
        "http://user:password@127.0.0.1/probe",
        "http://user@127.0.0.1/probe",
        "/relative",
        "invalid",
    ] {
        let (result, events) = capture(url.into(), options()).await;
        assert_eq!(result.error_code, Some(StreamErrorCode::InvalidUrl));
        assert_eq!(events.len(), 2);
    }
    let (invalid, _) = capture(
        "http://127.0.0.1/probe".into(),
        StreamOptions {
            max_response_bytes: 0,
            ..options()
        },
    )
    .await;
    assert_eq!(invalid.error_code, Some(StreamErrorCode::InvalidOptions));

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("reserve unused local port");
    let address = listener.local_addr().expect("read reserved port");
    drop(listener);
    let (network, _) = capture(format!("http://{address}/probe"), options()).await;
    // Windows may delay a refused port beyond the bounded connection deadline.
    assert!(matches!(
        network.error_code,
        Some(StreamErrorCode::Network | StreamErrorCode::ConnectTimeout)
    ));

    // A connected peer that closes before headers gives a deterministic
    // transport failure, independently of platform refused-port timing.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind disconnect server");
    let address = listener.local_addr().expect("disconnect address");
    let peer = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept disconnect request");
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            headers.push(socket.read_u8().await.expect("read disconnect request"));
            assert!(headers.len() <= 8192);
        }
        // Drop without writing a response; production retries are disabled.
    });
    let (disconnected, _) = capture(format!("http://{address}/probe"), options()).await;
    peer.await.expect("disconnect server ended");
    assert_eq!(disconnected.error_code, Some(StreamErrorCode::Network));
}

#[tokio::test]
async fn a_closed_consumer_and_precancelled_token_never_claim_completion() {
    let server = body_server(format!("{}data: [DONE]\n\n", delta("局部草稿")).into_bytes()).await;
    let mut events = Vec::new();
    let result = run_probe_stream_with_options(
        "closed-consumer".into(),
        server.url.clone(),
        CancellationToken::new(),
        options(),
        |event| {
            let keep_receiving = event.kind != StreamEventKind::Delta;
            events.push(event);
            keep_receiving
        },
    )
    .await;
    assert_events(&result, &events);
    assert_eq!(result.status, StreamStatus::Cancelled);
    assert_eq!(result.error_code, Some(StreamErrorCode::ConsumerClosed));
    assert_eq!(result.text, "局部草稿");

    let token = CancellationToken::new();
    token.cancel();
    let mut events = Vec::new();
    let result = run_probe_stream_with_options(
        "pre-cancelled".into(),
        "http://127.0.0.1/probe".into(),
        token,
        options(),
        |event| {
            events.push(event);
            true
        },
    )
    .await;
    assert_events(&result, &events);
    assert_eq!(result.status, StreamStatus::Cancelled);
    assert_eq!(result.error_code, None);
    assert_eq!(events.len(), 2);
}

#[tokio::test]
async fn reliable_snapshot_survives_closed_ui_then_allows_a_new_operation() {
    use lishi_core::probe_jobs::{ProbeJobError, ProbeJobState, ProbeJobs};
    let server =
        body_server(format!("{}data: [DONE]\n\n", delta("断开界面的草稿🙂")).into_bytes()).await;
    let jobs = ProbeJobs::default();
    let id = "channel-disconnect";
    let token = jobs.register(id).expect("reserve operation");
    let result =
        run_probe_stream_with_options(id.into(), server.url.clone(), token, options(), |event| {
            assert!(jobs.record_event(&event));
            // Simulate a genuine downstream consumer loss after the core stored the
            // first delta; the HTTP connection and manager are still real.
            event.kind != StreamEventKind::Delta
        })
        .await;
    jobs.finish(&result)
        .expect("release completed core operation");
    let snapshot = jobs
        .snapshot(Some(id))
        .expect("query reliable result")
        .expect("retained result");
    assert_eq!(snapshot.state, ProbeJobState::Cancelled);
    assert_eq!(snapshot.error_code, Some(StreamErrorCode::ConsumerClosed));
    assert_eq!(snapshot.text, "断开界面的草稿🙂");
    assert_eq!(snapshot.delta_count, 1);
    assert_eq!(snapshot.sequence, 2);
    assert!(jobs.snapshot(None).expect("query active").is_none());
    assert_eq!(jobs.register(id).unwrap_err(), ProbeJobError::Duplicate);
    assert!(jobs.register("next-operation").is_ok());
}
