//! Only literal loopback and invalid fixture credentials are used. No user's
//! profile, Key, game world, model endpoint, or Android device is accessed.

use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use lishi_core::{
    game_context::ContextBudget,
    game_provider::{Capability, ProviderError, ProviderStore},
    model_probe::{
        run_model_probe_with_context_policy, run_model_probe_with_endpoint_policy, CredentialMode,
        ModelContextPolicy, ModelProbeRequest, SavedEndpointPolicy, MAX_MODEL_PROMPT_BYTES,
    },
    CancellationToken, StreamErrorCode, StreamOptions, StreamStatus,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
    task::JoinHandle,
};

struct Fixture {
    endpoint: String,
    calls: Arc<AtomicUsize>,
    bodies: mpsc::UnboundedReceiver<Value>,
    task: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn fixture(status: u16) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let (tx, bodies) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            count.fetch_add(1, Ordering::SeqCst);
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
                assert!(header.len() <= 16 * 1024);
            }
            let headers = String::from_utf8(header).unwrap();
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            assert!(length <= 32 * 1024 * 1024);
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            tx.send(serde_json::from_slice(&body).unwrap()).unwrap();
            let response = if status == 200 {
                "data: {\"choices\":[{\"delta\":{\"content\":\"长输入完整🙂\"}}]}\n\ndata: [DONE]\n\n"
            } else {
                "{\"error\":{\"message\":\"fixture refuses max_tokens\"}}"
            };
            let content_type = if status == 200 {
                "text/event-stream"
            } else {
                "application/json"
            };
            let header=format!("HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.len());
            socket.write_all(header.as_bytes()).await.unwrap();
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    Fixture {
        endpoint,
        calls,
        bodies,
        task,
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
fn request(endpoint: &str, prompt: &str) -> ModelProbeRequest {
    ModelProbeRequest {
        operation_id: "context-http-local-0001".into(),
        endpoint: endpoint.into(),
        model: "fixture-model".into(),
        prompt: prompt.into(),
        include_usage: false,
        credential_mode: CredentialMode::Fixture,
    }
}

#[tokio::test]
async fn explicit_large_utf8_policy_reaches_http_unchanged_once_with_output_reservation() {
    let mut local = fixture(200).await;
    let prompt = "长行动中文🔑🙂\n\"保留引号\"".repeat(1000);
    assert!(prompt.len() > 8192);
    let legacy = run_model_probe_with_endpoint_policy(
        request(&local.endpoint, &prompt),
        None,
        CancellationToken::new(),
        options(),
        SavedEndpointPolicy::HttpsOnly,
        |_| true,
    )
    .await;
    assert_eq!(
        legacy.stream.error_code,
        Some(StreamErrorCode::InvalidConfig)
    );
    assert_eq!(legacy.diagnostics.attempts, 0);
    assert_eq!(local.calls.load(Ordering::SeqCst), 0);
    let result = run_model_probe_with_context_policy(
        request(&local.endpoint, &prompt),
        None,
        CancellationToken::new(),
        options(),
        SavedEndpointPolicy::HttpsOnly,
        ModelContextPolicy {
            max_prompt_bytes: 64 * 1024,
            output_reserve_tokens: Some(2048),
        },
        |_| true,
    )
    .await;
    assert_eq!(result.stream.status, StreamStatus::Completed);
    assert_eq!(result.stream.text, "长输入完整🙂");
    assert_eq!(result.diagnostics.attempts, 1);
    assert_eq!(result.diagnostics.usage, None);
    let body = tokio::time::timeout(Duration::from_secs(1), local.bodies.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(body["messages"][0]["content"], prompt);
    assert_eq!(body["max_tokens"], 2048);
    assert_eq!(body["stream"], true);
    assert_eq!(local.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn invalid_native_limits_and_utf8_overflow_have_zero_http_attempts() {
    let local = fixture(200).await;
    for policy in [
        ModelContextPolicy {
            max_prompt_bytes: 0,
            output_reserve_tokens: None,
        },
        ModelContextPolicy {
            max_prompt_bytes: MAX_MODEL_PROMPT_BYTES + 1,
            output_reserve_tokens: None,
        },
        ModelContextPolicy {
            max_prompt_bytes: 8192,
            output_reserve_tokens: Some(0),
        },
        ModelContextPolicy {
            max_prompt_bytes: 8192,
            output_reserve_tokens: Some(4 * 1024 * 1024 + 1),
        },
        ModelContextPolicy {
            max_prompt_bytes: 2,
            output_reserve_tokens: Some(100),
        },
    ] {
        let result = run_model_probe_with_context_policy(
            request(&local.endpoint, "中"),
            None,
            CancellationToken::new(),
            options(),
            SavedEndpointPolicy::HttpsOnly,
            policy,
            |_| true,
        )
        .await;
        assert_eq!(
            result.stream.error_code,
            Some(StreamErrorCode::InvalidConfig)
        );
        assert_eq!(result.diagnostics.attempts, 0);
        assert_eq!(result.diagnostics.http_status, None);
        assert_eq!(local.calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn old_probe_small_body_stays_unchanged_and_endpoint_refusal_never_retries() {
    let mut old = fixture(200).await;
    let result = run_model_probe_with_endpoint_policy(
        request(&old.endpoint, "旧技术探针🙂"),
        None,
        CancellationToken::new(),
        options(),
        SavedEndpointPolicy::HttpsOnly,
        |_| true,
    )
    .await;
    assert_eq!(result.stream.status, StreamStatus::Completed);
    let body = old.bodies.recv().await.unwrap();
    assert_eq!(body.as_object().unwrap().len(), 3);
    assert!(body.get("max_tokens").is_none());
    assert_eq!(old.calls.load(Ordering::SeqCst), 1);
    let denied = fixture(400).await;
    let result = run_model_probe_with_context_policy(
        request(&denied.endpoint, "明确预留输出"),
        None,
        CancellationToken::new(),
        options(),
        SavedEndpointPolicy::HttpsOnly,
        ModelContextPolicy {
            max_prompt_bytes: 8192,
            output_reserve_tokens: Some(4096),
        },
        |_| true,
    )
    .await;
    assert_eq!(result.stream.error_code, Some(StreamErrorCode::HttpStatus));
    assert_eq!(result.diagnostics.attempts, 1);
    assert_eq!(result.diagnostics.http_status, Some(400));
    assert_eq!(denied.calls.load(Ordering::SeqCst), 1);
}

#[test]
fn technical_request_json_cannot_inject_native_budget_bypass() {
    let base = json!({"operationId":"context-json-0001","endpoint":"http://127.0.0.1:9/v1/chat/completions","model":"fixture","prompt":"检查","includeUsage":false,"credentialMode":"fixture"});
    assert!(serde_json::from_value::<ModelProbeRequest>(base.clone()).is_ok());
    for field in ["contextPolicy", "maxPromptBytes", "outputReserveTokens"] {
        let mut injected = base.clone();
        injected[field] = json!({"maxPromptBytes":65536});
        assert!(serde_json::from_value::<ModelProbeRequest>(injected).is_err());
    }
}

fn budget() -> ContextBudget {
    ContextBudget {
        max_input_bytes: 64 * 1024,
        context_limit_tokens: 96 * 1024,
        output_reserve_tokens: 4096,
        transport_reserve_tokens: 512,
    }
}

#[test]
fn provider_budget_cas_restart_and_old_save_preserve_metadata_without_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fixture-settings.sqlite");
    let store = ProviderStore::open(&path).unwrap();
    store
        .save(
            "https://example.com/v1/chat/completions",
            "fixture",
            "fixture-slot-one",
            0,
        )
        .unwrap();
    assert_eq!(
        store.view().unwrap().config.unwrap().context_budget,
        ContextBudget::default()
    );
    let before = serde_json::to_value(store.view().unwrap()).unwrap();
    let invalid = ContextBudget {
        max_input_bytes: 0,
        ..budget()
    };
    assert_eq!(
        store
            .save_with_context_budget(
                "https://example.com/v1/chat/completions",
                "changed",
                "fixture-slot-two",
                1,
                false,
                invalid
            )
            .err(),
        Some(ProviderError::InvalidConfig)
    );
    assert_eq!(serde_json::to_value(store.view().unwrap()).unwrap(), before);
    assert_eq!(
        store.stored().unwrap().unwrap().secret_slot,
        "fixture-slot-one"
    );
    assert_eq!(
        store
            .save_with_context_budget(
                "https://example.com/v1/chat/completions",
                "changed",
                "fixture-slot-two",
                0,
                false,
                budget()
            )
            .err(),
        Some(ProviderError::Stale)
    );
    assert_eq!(serde_json::to_value(store.view().unwrap()).unwrap(), before);
    let changed = store
        .save_with_context_budget(
            "https://example.com/v1/chat/completions",
            "fixture",
            "fixture-slot-one",
            1,
            false,
            budget(),
        )
        .unwrap();
    assert_eq!(changed.revision, 2);
    assert_eq!(changed.config.unwrap().context_budget, budget());
    store
        .save_with_http_opt_in(
            "https://example.com/v1/chat/completions",
            "fixture-two",
            "fixture-slot-one",
            2,
            false,
        )
        .unwrap();
    assert_eq!(
        store.view().unwrap().config.unwrap().context_budget,
        budget()
    );
    drop(store);
    let reopened = ProviderStore::open(&path).unwrap();
    let view = reopened.view().unwrap();
    assert_eq!(view.revision, 3);
    assert_eq!(view.config.as_ref().unwrap().context_budget, budget());
    assert_eq!(view.capabilities.structured_output, Capability::Unknown);
    let public = serde_json::to_string(&view).unwrap();
    assert!(public.contains("\"contextBudget\""));
    assert!(!public.contains("fixture-slot-one"));
    assert!(!public.contains("secret"));
}

#[test]
fn additive_schema_legacy_profile_keeps_revision_slot_and_null_default_then_old_writer_is_compatible(
) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy-settings.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE provider(singleton INTEGER PRIMARY KEY CHECK(singleton=1),endpoint TEXT NOT NULL,model TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),secret_slot TEXT NOT NULL,streaming TEXT NOT NULL CHECK(streaming IN ('unknown','supported','unsupported'))) STRICT;INSERT INTO provider VALUES(1,'https://example.com/v1/chat/completions','legacy-model',7,'legacy-fixture-slot','supported');PRAGMA user_version=1;").unwrap();
    drop(db);
    let store = ProviderStore::open(&path).unwrap();
    let legacy = store.stored().unwrap().unwrap();
    assert_eq!(legacy.config.revision, 7);
    assert_eq!(legacy.config.model, "legacy-model");
    assert_eq!(legacy.secret_slot, "legacy-fixture-slot");
    assert_eq!(legacy.config.context_budget, ContextBudget::default());
    assert_eq!(legacy.streaming, Capability::Supported);
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT context_budget FROM provider", [], |row| row
            .get::<_, Option<String>>(0))
            .unwrap(),
        None
    );
    assert_eq!(
        db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(db);
    store
        .save_with_context_budget(
            "https://example.com/v1/chat/completions",
            "configured-model",
            "legacy-fixture-slot",
            7,
            false,
            budget(),
        )
        .unwrap();
    drop(store);
    let mut old_writer = Connection::open(&path).unwrap();
    let tx = old_writer.transaction().unwrap();
    // The original M02 writer updates its known columns, preserving the new
    // additive field without knowing it exists.
    tx.execute(
        "UPDATE provider SET model='old-writer-model',revision=9 WHERE singleton=1",
        [],
    )
    .unwrap();
    tx.execute("UPDATE provider_meta SET revision=9 WHERE singleton=1", [])
        .unwrap();
    tx.commit().unwrap();
    drop(old_writer);
    let reopened = ProviderStore::open(&path).unwrap();
    let profile = reopened.stored().unwrap().unwrap();
    assert_eq!(profile.config.revision, 9);
    assert_eq!(profile.config.model, "old-writer-model");
    assert_eq!(profile.config.context_budget, budget());
    assert_eq!(profile.secret_slot, "legacy-fixture-slot");
}

#[test]
fn malformed_persisted_budget_is_rejected_instead_of_silently_enlarging_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bad-settings.sqlite");
    let store = ProviderStore::open(&path).unwrap();
    store
        .save(
            "https://example.com/v1/chat/completions",
            "fixture",
            "fixture-slot",
            0,
        )
        .unwrap();
    drop(store);
    let db = Connection::open(&path).unwrap();
    db.execute("UPDATE provider SET context_budget=?1",[r#"{"maxInputBytes":65536,"contextLimitTokens":98304,"outputReserveTokens":4096,"transportReserveTokens":512,"unknownOverride":true}"#]).unwrap();
    drop(db);
    let reopened = ProviderStore::open(&path).unwrap();
    assert_eq!(reopened.stored().err(), Some(ProviderError::Database));
}
