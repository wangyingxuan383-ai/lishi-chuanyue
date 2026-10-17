use super::*;
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
    task::JoinHandle,
    time::{sleep, timeout},
};

const FAKE_KEY: &str = "fake-loopback-only-token";

fn timeouts() -> Timeouts {
    Timeouts {
        first_byte_ms: 3000,
        idle_ms: 3000,
        total_ms: 10000,
    }
}

async fn server(
    status: u16,
    content_type: &str,
    chunks: Vec<(u64, Vec<u8>)>,
    header_delay: u64,
    trailing_delay: u64,
) -> (String, JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/chat", listener.local_addr().unwrap());
    let length: usize = chunks.iter().map(|(_, c)| c.len()).sum();
    let headers = format!("HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nLocation: /redirect-target\r\nConnection: close\r\n\r\n", length + usize::from(trailing_delay > 0));
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        socket.set_nodelay(true).unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
            if let Some(end) = request.windows(4).position(|b| b == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|n| n.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
        }
        sleep(Duration::from_millis(header_delay)).await;
        if socket.write_all(headers.as_bytes()).await.is_ok() {
            for (delay, bytes) in chunks {
                sleep(Duration::from_millis(delay)).await;
                if socket.write_all(&bytes).await.is_err() {
                    return request;
                }
            }
            if trailing_delay > 0 {
                sleep(Duration::from_millis(trailing_delay)).await;
                let _ = socket.write_all(b"x").await;
            }
        }
        request
    });
    (url, task)
}

fn service() -> (tempfile::TempDir, Arc<Streams>) {
    let dir = tempfile::tempdir().unwrap();
    let mut service = Streams::open(dir.path().into()).unwrap();
    service.keep_alive = Arc::new(KeepAlive::new(|_| {}));
    let service = Arc::new(service);
    (dir, service)
}

async fn start(
    service: &Arc<Streams>,
    url: String,
    timeouts: Timeouts,
) -> (String, mpsc::UnboundedReceiver<StreamEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let id = service
        .start(
            url,
            json!({"unknown_request_field":{"中文":true}}),
            timeouts,
            Some(SecretValue::new(FAKE_KEY.into()).unwrap()),
            Arc::new(move |e| {
                let _ = tx.send(e);
            }),
        )
        .await
        .unwrap();
    assert!(valid_id(&id));
    (id, rx)
}

async fn collect(
    service: &Arc<Streams>,
    id: &str,
    mut rx: mpsc::UnboundedReceiver<StreamEvent>,
) -> Vec<StreamEvent> {
    let events = timeout(Duration::from_secs(8), async move {
        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            let terminal = event.terminal();
            events.push(event);
            if terminal {
                break;
            }
        }
        events
    })
    .await
    .expect("stream terminates locally");
    service.cancel(id).await.unwrap();
    assert_eq!(
        service.keep_alive.count(),
        service.active.lock().unwrap().len()
    );
    assert!(events.last().is_some_and(StreamEvent::terminal));
    events
}

fn assert_kind(events: &[StreamEvent], expected: &str) {
    assert!(
        matches!(events.last(), Some(StreamEvent::Error { kind, .. }) if kind == expected),
        "unexpected terminal: {:?}",
        events.last()
    );
    assert_eq!(events.iter().filter(|e| e.terminal()).count(), 1);
}

#[tokio::test]
async fn unknown_json_is_forwarded_verbatim_and_request_is_unchanged() {
    let (_dir, service) = service();
    let data = r#" {"future":{"arbitrary":[1,true]},"choices":[{"delta":{"brand_new":"中"}}]} "#;
    let body = format!(": comment\r\nevent: whatever\nid: 12\nretry: 1\n\ndata: {data}\r\ndata:  second\ndata:\ndata: [DONE]\ndata: ignored\n");
    let (url, task) = server(
        200,
        "text/event-stream; charset=utf-8",
        vec![(0, body.into_bytes())],
        0,
        0,
    )
    .await;
    let (id, rx) = start(&service, url, timeouts()).await;
    let events = collect(&service, &id, rx).await;
    assert_eq!(
        events,
        vec![
            StreamEvent::Open { status: 200 },
            StreamEvent::Data { data: data.into() },
            StreamEvent::Data {
                data: " second".into()
            },
            StreamEvent::Data {
                data: String::new()
            },
            StreamEvent::Done
        ]
    );
    let request = String::from_utf8(task.await.unwrap()).unwrap();
    assert!(request.starts_with("POST /v1/chat HTTP/1.1"));
    assert!(request.contains(&format!("authorization: Bearer {FAKE_KEY}")));
    assert!(request.contains("accept: text/event-stream"));
    assert!(request.contains("content-type: application/json"));
    let body = request.split_once("\r\n\r\n").unwrap().1;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(body).unwrap(),
        json!({"unknown_request_field":{"中文":true}})
    );
}

#[tokio::test]
async fn chinese_tcp_fragments_and_invalid_utf8_and_final_line_are_supported() {
    let (_dir, service) = service();
    let mut bytes = "data: 你好世界\r\ndata: ".as_bytes().to_vec();
    bytes.extend_from_slice(b"\xff\n");
    bytes.extend_from_slice("data: 末行".as_bytes());
    let chunks = bytes.into_iter().map(|b| (1, vec![b])).collect();
    let (url, task) = server(200, "text/event-stream", chunks, 0, 0).await;
    let (id, rx) = start(&service, url, timeouts()).await;
    let events = collect(&service, &id, rx).await;
    assert_eq!(
        events,
        vec![
            StreamEvent::Open { status: 200 },
            StreamEvent::Data {
                data: "你好世界".into()
            },
            StreamEvent::Data { data: "�".into() },
            StreamEvent::Data {
                data: "末行".into()
            },
            StreamEvent::Done
        ]
    );
    task.await.unwrap();
}

#[tokio::test]
async fn done_terminates_without_waiting_for_connection_close() {
    let (_dir, service) = service();
    let (url, task) = server(
        200,
        "text/event-stream",
        vec![(0, b"data: [DONE]\n".to_vec())],
        0,
        3000,
    )
    .await;
    let (id, rx) = start(&service, url, timeouts()).await;
    let events = timeout(Duration::from_secs(1), collect(&service, &id, rx))
        .await
        .unwrap();
    assert_eq!(events.last(), Some(&StreamEvent::Done));
    task.abort();
}

#[tokio::test]
async fn non_sse_body_is_one_data_event_then_done() {
    let (_dir, service) = service();
    let text = "{\"中文\":\"完整响应\",\"any\":[1,2]}";
    let (url, task) = server(
        200,
        "application/json",
        text.as_bytes().chunks(3).map(|c| (1, c.to_vec())).collect(),
        0,
        0,
    )
    .await;
    let (id, rx) = start(&service, url, timeouts()).await;
    let events = collect(&service, &id, rx).await;
    assert_eq!(
        events,
        vec![
            StreamEvent::Open { status: 200 },
            StreamEvent::Data { data: text.into() },
            StreamEvent::Done
        ]
    );
    task.await.unwrap();
}

#[tokio::test]
async fn http_errors_are_bounded_redacted_and_redirects_are_not_followed() {
    for status in [401, 302] {
        let (_dir, service) = service();
        let text = format!("failure {FAKE_KEY} {}", "x".repeat(MAX_HTTP_ERROR));
        let (url, task) = server(status, "text/plain", vec![(0, text.into_bytes())], 0, 0).await;
        let (id, rx) = start(&service, url, timeouts()).await;
        let events = collect(&service, &id, rx).await;
        assert_kind(&events, "http");
        match events.last().unwrap() {
            StreamEvent::Error {
                status: actual,
                message: Some(message),
                ..
            } => {
                assert_eq!(*actual, Some(status));
                assert!(!message.contains(FAKE_KEY));
                assert!(message.contains("***"));
                assert!(message.len() <= MAX_HTTP_ERROR);
            }
            _ => panic!("HTTP error event"),
        }
        assert_eq!(events.len(), 1);
        task.await.unwrap();
    }
}

#[tokio::test]
async fn key_echo_in_sse_or_non_sse_never_reaches_channel_or_cache() {
    for (content_type, body) in [
        (
            "text/event-stream",
            format!("data: before-{FAKE_KEY}-after\n"),
        ),
        ("application/json", format!("{{\"echo\":\"{FAKE_KEY}\"}}")),
    ] {
        let (dir, service) = service();
        let (url, task) = server(
            200,
            content_type,
            body.as_bytes().chunks(3).map(|c| (1, c.to_vec())).collect(),
            0,
            0,
        )
        .await;
        let (id, rx) = start(&service, url, timeouts()).await;
        let events = collect(&service, &id, rx).await;
        assert_kind(&events, "secret_echo");
        assert!(!events.iter().any(|e| matches!(e, StreamEvent::Data { .. })));
        assert!(
            !fs::read_to_string(dir.path().join("streams").join(format!("{id}.jsonl")))
                .unwrap()
                .contains(FAKE_KEY)
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn cancellation_is_cached_once_and_ack_cancels_active_stream() {
    let (_dir, service) = service();
    let (url, task) = server(
        200,
        "text/event-stream",
        vec![(3000, b"data: delayed\n".to_vec())],
        0,
        0,
    )
    .await;
    let (id, mut rx) = start(&service, url, timeouts()).await;
    assert_eq!(rx.recv().await, Some(StreamEvent::Open { status: 200 }));
    assert!(service.resume(&id).unwrap().unwrap().active);
    let list = service.list().unwrap();
    assert!(list[0].active && !list[0].finished);
    service.cancel(&id).await.unwrap();
    let events = collect(&service, &id, rx).await;
    assert_kind(&events, "cancelled");
    let before = service.resume(&id).unwrap().unwrap().events;
    service.cancel(&id).await.unwrap();
    assert_eq!(service.resume(&id).unwrap().unwrap().events, before);
    service.ack(id.clone()).await.unwrap();
    service.ack(id.clone()).await.unwrap();
    assert!(service.resume(&id).unwrap().is_none());
    task.abort();

    let (url, task) = server(
        200,
        "text/event-stream",
        vec![(3000, b"data: delayed\n".to_vec())],
        0,
        0,
    )
    .await;
    let (id, mut rx) = start(&service, url, timeouts()).await;
    rx.recv().await.unwrap();
    service.ack(id.clone()).await.unwrap();
    assert_kind(&collect(&service, &id, rx).await, "cancelled");
    assert!(service.resume(&id).unwrap().is_none());
    assert!(service.list().unwrap().is_empty());
    task.abort();
}

#[tokio::test]
async fn first_byte_timeout_includes_body_wait_after_headers() {
    for header_delay in [0, 250] {
        let (_dir, service) = service();
        let (url, task) = server(
            200,
            "text/event-stream",
            vec![(250, b"data: late\n".to_vec())],
            header_delay,
            0,
        )
        .await;
        let (id, rx) = start(
            &service,
            url,
            Timeouts {
                first_byte_ms: 60,
                ..timeouts()
            },
        )
        .await;
        assert_kind(&collect(&service, &id, rx).await, "timeout_first");
        task.abort();
    }
}

#[tokio::test]
async fn idle_timeout_counts_bytes_even_without_complete_data_lines() {
    let (_dir, service) = service();
    let (url, task) = server(
        200,
        "text/event-stream",
        vec![(0, b"data: partial".to_vec()), (250, b"\n".to_vec())],
        0,
        0,
    )
    .await;
    let (id, rx) = start(
        &service,
        url,
        Timeouts {
            idle_ms: 60,
            ..timeouts()
        },
    )
    .await;
    assert_kind(&collect(&service, &id, rx).await, "timeout_idle");
    task.abort();
}

#[tokio::test]
async fn total_timeout_stops_a_stream_that_keeps_receiving_bytes() {
    let (_dir, service) = service();
    let chunks = (0..100).map(|_| (10, b": heartbeat\n".to_vec())).collect();
    let (url, task) = server(200, "text/event-stream", chunks, 0, 0).await;
    let (id, rx) = start(
        &service,
        url,
        Timeouts {
            total_ms: 80,
            ..timeouts()
        },
    )
    .await;
    assert_kind(&collect(&service, &id, rx).await, "timeout_total");
    task.abort();
}

#[tokio::test]
async fn four_mib_limit_is_inclusive_and_applies_to_sse_and_plain_bodies() {
    for (content_type, length, error) in [
        ("application/json", MAX_BODY, false),
        ("application/json", MAX_BODY + 1, true),
        ("text/event-stream", MAX_BODY + 1, true),
    ] {
        let (_dir, service) = service();
        let chunks = vec![b'x'; length]
            .chunks(64 * 1024)
            .map(|c| (0, c.to_vec()))
            .collect();
        let (url, task) = server(200, content_type, chunks, 0, 0).await;
        let (id, rx) = start(&service, url, timeouts()).await;
        let events = collect(&service, &id, rx).await;
        if error {
            assert_kind(&events, "too_large");
        } else {
            assert_eq!(events.last(), Some(&StreamEvent::Done));
            assert!(matches!(&events[1],StreamEvent::Data {data} if data.len()==MAX_BODY));
        }
        task.await.unwrap();
    }
}

#[tokio::test]
async fn cache_is_jsonl_and_resume_matches_every_channel_event() {
    let (dir, service) = service();
    let (url, task) = server(
        200,
        "text/event-stream",
        vec![(0, b"data: first\ndata: second\ndata: [DONE]\n".to_vec())],
        0,
        0,
    )
    .await;
    let (id, rx) = start(&service, url, timeouts()).await;
    let events = collect(&service, &id, rx).await;
    let resume = service.resume(&id).unwrap().unwrap();
    assert!(!resume.active);
    assert_eq!(resume.events, events);
    let jsonl = fs::read_to_string(dir.path().join("streams").join(format!("{id}.jsonl"))).unwrap();
    let stored: Vec<StreamEvent> = jsonl
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(stored, events);
    assert!(service.list().unwrap()[0].finished);
    let restarted = Streams::open(dir.path().into()).unwrap();
    assert_eq!(restarted.resume(&id).unwrap().unwrap().events, events);
    task.await.unwrap();
}

#[test]
fn restart_appends_interrupted_once_and_repairs_partial_last_append() {
    let (dir, service) = service();
    let id = "1234567890abcdef";
    let path = dir.path().join("streams").join(format!("{id}.jsonl"));
    fs::write(
        &path,
        b"{\"type\":\"open\",\"status\":200}\n{\"type\":\"data\",\"data\":\"half\"}\n{\"ty",
    )
    .unwrap();
    drop(service);
    let restarted = Streams::open(dir.path().into()).unwrap();
    assert!(!restarted.list().unwrap()[0].finished);
    let resumed = restarted.resume(id).unwrap().unwrap();
    assert!(!resumed.active);
    assert_eq!(resumed.events.len(), 3);
    assert!(
        matches!(resumed.events.last(),Some(StreamEvent::Error {kind,message:Some(message),..}) if kind=="network" && message=="interrupted")
    );
    assert_eq!(
        restarted.resume(id).unwrap().unwrap().events,
        resumed.events
    );
    assert!(restarted.list().unwrap()[0].finished);
    assert!(restarted.resume("../../not-allowed").is_err());
    assert!(restarted.resume("abcdef1234567890").unwrap().is_none());
}

#[tokio::test]
async fn get_preserves_status_truncates_redacts_and_does_not_redirect() {
    let (url, task) = server(
        302,
        "application/json",
        vec![(0, format!("{FAKE_KEY}{}", "x".repeat(MAX_GET)).into_bytes())],
        0,
        0,
    )
    .await;
    let result = get(&url, 3000, SecretValue::new(FAKE_KEY.into()).unwrap())
        .await
        .unwrap();
    assert_eq!(result.status, 302);
    assert!(!result.body.contains(FAKE_KEY));
    assert!(result.body.starts_with("***"));
    assert_eq!(result.body.len(), MAX_GET - FAKE_KEY.len() + 3);
    let request = String::from_utf8(task.await.unwrap()).unwrap();
    assert!(request.starts_with("GET /v1/chat HTTP/1.1"));
}

#[tokio::test]
async fn get_timeout_is_reported_without_request_details() {
    let (url, task) = server(200, "text/plain", vec![(250, b"late".to_vec())], 0, 0).await;
    assert_eq!(
        get(&url, 60, SecretValue::new(FAKE_KEY.into()).unwrap())
            .await
            .unwrap_err()
            .code,
        "llm_timeout"
    );
    task.abort();
}

#[tokio::test]
async fn get_bounds_decoded_text_even_when_invalid_utf8_expands() {
    let (url, task) = server(200, "text/plain", vec![(0, vec![0xff; MAX_GET])], 0, 0).await;
    let result = get(&url, 3000, SecretValue::new(FAKE_KEY.into()).unwrap())
        .await
        .unwrap();
    assert_eq!(result.status, 200);
    assert!(result.body.len() <= MAX_GET);
    assert!(result.body.chars().all(|c| c == '�'));
    task.await.unwrap();
}

#[tokio::test]
async fn command_service_rejects_unbound_url_without_sending_and_reports_missing_secret() {
    use crate::credentials::{tests::MemoryStore, Credentials};
    let dir = tempfile::tempdir().unwrap();
    let credentials =
        Arc::new(Credentials::open(dir.path().into(), Arc::new(MemoryStore::default())).unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    credentials.set("model", FAKE_KEY.into(), &base).unwrap();
    let (_dir, service) = service();
    let error = service
        .start_request(
            Arc::clone(&credentials),
            "model".into(),
            format!("{base}evil/x"),
            json!({}),
            timeouts(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "llm_url_not_bound");
    assert!(service.list().unwrap().is_empty());
    let (tx, rx) = mpsc::unbounded_channel();
    let id = service
        .start_request(
            credentials,
            "missing".into(),
            base,
            json!({}),
            timeouts(),
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .await
        .unwrap();
    assert_kind(&collect(&service, &id, rx).await, "no_secret");
    assert!(timeout(Duration::from_millis(50), listener.accept())
        .await
        .is_err());
}

#[tokio::test]
async fn cancellation_before_headers_stops_the_request() {
    let (_dir, service) = service();
    let (url, task) = server(
        200,
        "text/event-stream",
        vec![(0, b"data: unused\n".to_vec())],
        500,
        0,
    )
    .await;
    let (id, rx) = start(&service, url, timeouts()).await;
    service.cancel(&id).await.unwrap();
    assert_kind(&collect(&service, &id, rx).await, "cancelled");
    task.abort();
}

#[tokio::test]
async fn premature_connection_close_is_a_network_error() {
    let (_dir, service) = service();
    let (url, task) = server(
        200,
        "text/event-stream",
        vec![(0, b"data: partial\n".to_vec())],
        0,
        100,
    )
    .await;
    let (id, rx) = start(&service, url, timeouts()).await;
    sleep(Duration::from_millis(50)).await;
    task.abort();
    assert_kind(&collect(&service, &id, rx).await, "network");
}

async fn gated_server(
    status: u16,
    body: &'static str,
) -> (String, tokio::sync::oneshot::Sender<()>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/chat", listener.local_addr().unwrap());
    let (release, gate) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = [0; 4096];
        let _ = socket.read(&mut buffer).await;
        if gate.await.is_ok() {
            let response = format!(
                "HTTP/1.1 {status} Test\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (url, release, task)
}

#[tokio::test]
async fn concurrent_done_error_cancel_and_ack_share_one_service_lease() {
    let (dir, _) = service();
    let transitions = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&transitions);
    let mut streams = Streams::open(dir.path().into()).unwrap();
    streams.keep_alive = Arc::new(KeepAlive::new(move |on| recorded.lock().unwrap().push(on)));
    let service = Arc::new(streams);
    let (url, done_gate, done_task) = gated_server(200, "data: [DONE]\n").await;
    let (done_id, done_rx) = start(&service, url, timeouts()).await;
    let (url, error_gate, error_task) = gated_server(503, "unavailable").await;
    let (error_id, error_rx) = start(&service, url, timeouts()).await;
    let (url, _cancel_gate, cancel_task) = gated_server(200, "unused").await;
    let (cancel_id, cancel_rx) = start(&service, url, timeouts()).await;
    let (url, _ack_gate, ack_task) = gated_server(200, "unused").await;
    let (ack_id, ack_rx) = start(&service, url, timeouts()).await;
    assert_eq!(service.keep_alive.count(), 4);
    assert_eq!(*transitions.lock().unwrap(), [true]);

    done_gate.send(()).unwrap();
    assert_eq!(
        collect(&service, &done_id, done_rx).await.last(),
        Some(&StreamEvent::Done)
    );
    assert_eq!(service.keep_alive.count(), 3);
    error_gate.send(()).unwrap();
    assert_kind(&collect(&service, &error_id, error_rx).await, "http");
    assert_eq!(service.keep_alive.count(), 2);
    service.cancel(&cancel_id).await.unwrap();
    assert_kind(&collect(&service, &cancel_id, cancel_rx).await, "cancelled");
    assert_eq!(service.keep_alive.count(), 1);
    assert_eq!(*transitions.lock().unwrap(), [true]);
    service.ack(ack_id.clone()).await.unwrap();
    assert_kind(&collect(&service, &ack_id, ack_rx).await, "cancelled");
    assert!(service.resume(&ack_id).unwrap().is_none());
    assert_eq!(service.keep_alive.count(), 0);
    assert_eq!(*transitions.lock().unwrap(), [true, false]);

    // Repeated cleanup and a later generation cannot underflow or skip start.
    for id in [done_id, error_id, cancel_id, ack_id] {
        service.cancel(&id).await.unwrap();
        service.ack(id).await.unwrap();
    }
    let id = service
        .start(
            "unused".into(),
            json!({}),
            timeouts(),
            None,
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
    service.cancel(&id).await.unwrap();
    assert_eq!(service.keep_alive.count(), 0);
    assert_eq!(*transitions.lock().unwrap(), [true, false, true, false]);
    done_task.await.unwrap();
    error_task.await.unwrap();
    cancel_task.abort();
    ack_task.abort();
}

#[tokio::test]
async fn panicking_event_delivery_releases_count_and_cancel_waiters() {
    let (_dir, service) = service();
    let id = service
        .start(
            "unused".into(),
            json!({}),
            timeouts(),
            None,
            Arc::new(|_| panic!("simulated event delivery panic")),
        )
        .await
        .unwrap();
    timeout(Duration::from_secs(2), service.cancel(&id))
        .await
        .expect("panic cleanup releases waiters")
        .unwrap();
    assert_eq!(service.keep_alive.count(), 0);
    assert!(!service.resume(&id).unwrap().unwrap().active);
    service.ack(id).await.unwrap();
}

#[tokio::test]
async fn aborting_unpolled_stream_guard_releases_registration_and_lease() {
    let (_dir, service) = service();
    let id = "1234567890abcdef".to_owned();
    let control = Active {
        cancel: CancellationToken::new(),
        finished: CancellationToken::new(),
    };
    service
        .active
        .lock()
        .unwrap()
        .insert(id.clone(), control.clone());
    let guard = ActiveStream {
        service: Arc::clone(&service),
        id: id.clone(),
        control: control.clone(),
        lease: Some(service.keep_alive.acquire()),
    };
    let task = tokio::spawn(async move {
        let _guard = guard;
        std::future::pending::<()>().await;
    });
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(control.finished.is_cancelled());
    assert!(!service.active.lock().unwrap().contains_key(&id));
    assert_eq!(service.keep_alive.count(), 0);
}

#[test]
fn network_settings_accept_http_and_socks_proxies_and_reject_others() {
    let custom = |url: &str| NetworkConfig {
        proxy: "custom".into(),
        proxy_url: Some(url.into()),
    };
    assert!(set_network(custom("http://127.0.0.1:7890")).is_ok());
    assert!(set_network(custom("socks5://127.0.0.1:1080")).is_ok());
    assert_eq!(
        set_network(custom("ftp://127.0.0.1:21")).unwrap_err().code,
        "proxy_invalid"
    );
    assert_eq!(
        set_network(custom("not a url")).unwrap_err().code,
        "proxy_invalid"
    );
    assert!(set_network(NetworkConfig {
        proxy: "none".into(),
        proxy_url: None
    })
    .is_ok());
}
