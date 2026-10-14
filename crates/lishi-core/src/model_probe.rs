//! One bounded authenticated POST probe. Configuration is supplied per call,
//! no game state or saved profile is created, and no raw diagnostics escape.
//! Fixture mode has a fixed invalid token and can reach literal loopback only.

use std::time::Instant;

use reqwest::{header, Url};
use serde::{Deserialize, Serialize};

use crate::secrets::SecretValue;
use crate::stream::{
    bounded_client, failed_stream, run_request_stream_with_options, ProbeStreamEvent,
    StreamErrorCode, StreamOptions, StreamResult,
};
use crate::CancellationToken;

pub use crate::stream::TokenUsage;

pub const FIXTURE_CREDENTIAL: &str = "invalid-m01-fixture-token";

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialMode {
    Fixture,
    Saved,
}

/// Native-only policy: an explicit user choice may permit a saved credential
/// over HTTP. It is deliberately absent from the deserializable request DTO,
/// so ordinary callers retain HTTPS-only validation and transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SavedEndpointPolicy {
    HttpsOnly,
    ExplicitHttp,
}

/// Trusted native policy, deliberately absent from ModelProbeRequest's JSON
/// DTO. The ordinary technical probe retains the original 8192-byte boundary.
/// `Some` selects the compatible `max_tokens` field explicitly; endpoints that
/// reject that field fail once, without fallback, automatic retry or guessing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelContextPolicy {
    pub max_prompt_bytes: usize,
    pub output_reserve_tokens: Option<u32>,
}

pub const MAX_MODEL_PROMPT_BYTES: usize = 4 * 1024 * 1024;
const MAX_MODEL_OUTPUT_TOKENS: u32 = 4 * 1024 * 1024;

impl Default for ModelContextPolicy {
    fn default() -> Self {
        Self {
            max_prompt_bytes: 8192,
            output_reserve_tokens: None,
        }
    }
}

impl ModelContextPolicy {
    pub fn validate(self) -> Result<(), StreamErrorCode> {
        if self.max_prompt_bytes == 0
            || self.max_prompt_bytes > MAX_MODEL_PROMPT_BYTES
            || self
                .output_reserve_tokens
                .is_some_and(|tokens| tokens == 0 || tokens > MAX_MODEL_OUTPUT_TOKENS)
        {
            Err(StreamErrorCode::InvalidConfig)
        } else {
            Ok(())
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelProbeRequest {
    pub operation_id: String,
    pub endpoint: String,
    pub model: String,
    pub prompt: String,
    pub include_usage: bool,
    pub credential_mode: CredentialMode,
}

impl ModelProbeRequest {
    /// Repeated by the native host before reservation and credential access.
    /// Parsing does not perform DNS or any other network operation.
    pub fn validate(&self) -> Result<(), StreamErrorCode> {
        self.validate_with_endpoint_policy(SavedEndpointPolicy::HttpsOnly)
    }

    /// `ExplicitHttp` changes the allowed scheme for saved credentials only.
    /// Fixture authorities, URL credentials, query strings and fragments retain
    /// their original restrictions. It never changes TLS verification.
    pub fn validate_with_endpoint_policy(
        &self,
        policy: SavedEndpointPolicy,
    ) -> Result<(), StreamErrorCode> {
        self.validate_with_context_policy(policy, ModelContextPolicy::default())
    }

    pub fn validate_with_context_policy(
        &self,
        policy: SavedEndpointPolicy,
        context: ModelContextPolicy,
    ) -> Result<(), StreamErrorCode> {
        context.validate()?;
        if !(8..=128).contains(&self.operation_id.len())
            || !self
                .operation_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            || !(1..=256).contains(&self.model.len())
            || self
                .model
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
            || !(1..=context.max_prompt_bytes).contains(&self.prompt.len())
        {
            return Err(StreamErrorCode::InvalidConfig);
        }
        if !(1..=2048).contains(&self.endpoint.len())
            || self
                .endpoint
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err(StreamErrorCode::InvalidUrl);
        }
        let url = Url::parse(&self.endpoint).map_err(|_| StreamErrorCode::InvalidUrl)?;
        if !url.has_host()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(StreamErrorCode::InvalidUrl);
        }
        match self.credential_mode {
            CredentialMode::Saved
                if url.scheme() == "https"
                    || (policy == SavedEndpointPolicy::ExplicitHttp && url.scheme() == "http") =>
            {
                Ok(())
            }
            CredentialMode::Fixture
                if url.scheme() == "http" && literal_fixture_authority(&self.endpoint) =>
            {
                Ok(())
            }
            _ => Err(StreamErrorCode::InvalidUrl),
        }
    }
}

fn literal_fixture_authority(endpoint: &str) -> bool {
    let Some((_, remainder)) = endpoint.split_once("://") else {
        return false;
    };
    let authority = remainder.split('/').next().unwrap_or_default();
    let port = if let Some(port) = authority.strip_prefix("127.0.0.1") {
        port
    } else if let Some(port) = authority.strip_prefix("[::1]") {
        port
    } else {
        return false;
    };
    port.is_empty()
        || port
            .strip_prefix(':')
            .is_some_and(|port| !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelProbeDiagnostics {
    pub http_status: Option<u16>,
    pub usage: Option<TokenUsage>,
    pub elapsed_ms: u64,
    pub attempts: u8,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelProbeResult {
    pub stream: StreamResult,
    pub diagnostics: ModelProbeDiagnostics,
}

pub async fn run_model_probe(
    request: ModelProbeRequest,
    secret: Option<SecretValue>,
    cancel: CancellationToken,
    emit: impl FnMut(ProbeStreamEvent) -> bool,
) -> ModelProbeResult {
    run_model_probe_with_options(request, secret, cancel, StreamOptions::default(), emit).await
}

pub async fn run_model_probe_with_options(
    request: ModelProbeRequest,
    secret: Option<SecretValue>,
    cancel: CancellationToken,
    options: StreamOptions,
    emit: impl FnMut(ProbeStreamEvent) -> bool,
) -> ModelProbeResult {
    run_model_probe_with_endpoint_policy(
        request,
        secret,
        cancel,
        options,
        SavedEndpointPolicy::HttpsOnly,
        emit,
    )
    .await
}

/// Only a trusted native caller may opt into HTTP for a saved credential. The
/// same bounded client, single attempt, cancellation and credential-echo guard
/// are used for both policies; there is no redirect, retry, or TLS bypass.
pub async fn run_model_probe_with_endpoint_policy(
    request: ModelProbeRequest,
    secret: Option<SecretValue>,
    cancel: CancellationToken,
    options: StreamOptions,
    policy: SavedEndpointPolicy,
    emit: impl FnMut(ProbeStreamEvent) -> bool,
) -> ModelProbeResult {
    run_model_probe_with_context_policy(
        request,
        secret,
        cancel,
        options,
        policy,
        ModelContextPolicy::default(),
        emit,
    )
    .await
}

/// Same one-attempt transport with a separately validated native context policy.
/// Limits apply to exact UTF-8 bytes; no action or prompt is truncated. Output
/// reservation is a request limit, not a fabricated endpoint capability/usage.
pub async fn run_model_probe_with_context_policy(
    request: ModelProbeRequest,
    secret: Option<SecretValue>,
    cancel: CancellationToken,
    options: StreamOptions,
    policy: SavedEndpointPolicy,
    context: ModelContextPolicy,
    emit: impl FnMut(ProbeStreamEvent) -> bool,
) -> ModelProbeResult {
    let started = Instant::now();
    let fail = |error, emit| ModelProbeResult {
        stream: failed_stream(request.operation_id.clone(), error, emit),
        diagnostics: ModelProbeDiagnostics {
            http_status: None,
            usage: None,
            elapsed_ms: elapsed_ms(started),
            attempts: 0,
        },
    };
    if let Err(error) = request.validate_with_context_policy(policy, context) {
        return fail(error, emit);
    }
    if !options.is_valid() {
        return fail(StreamErrorCode::InvalidOptions, emit);
    }
    let secret = match request.credential_mode {
        CredentialMode::Fixture => SecretValue::new(FIXTURE_CREDENTIAL.to_owned())
            .expect("the fixed invalid fixture credential satisfies the storage contract"),
        CredentialMode::Saved => match secret {
            Some(secret) => secret,
            None => return fail(StreamErrorCode::CredentialMissing, emit),
        },
    };
    let mut authorization =
        match header::HeaderValue::from_str(&format!("Bearer {}", secret.expose_secret())) {
            Ok(value) => value,
            Err(_) => return fail(StreamErrorCode::InvalidConfig, emit),
        };
    authorization.set_sensitive(true);
    let client = match bounded_client(&options) {
        Ok(client) => client,
        Err(error) => return fail(error, emit),
    };
    let mut body = serde_json::json!({
        "model": request.model,
        "messages": [{"role": "user", "content": request.prompt}],
        "stream": true
    });
    if request.include_usage {
        body["stream_options"] = serde_json::json!({"include_usage": true});
    }
    if let Some(tokens) = context.output_reserve_tokens {
        body["max_tokens"] = serde_json::json!(tokens);
    }
    let body = match serde_json::to_vec(&body) {
        Ok(body) => body,
        Err(_) => return fail(StreamErrorCode::InvalidConfig, emit),
    };
    let http = client
        .post(&request.endpoint)
        .header(header::AUTHORIZATION, authorization)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(body);
    let (stream, diagnostics) = run_request_stream_with_options(
        request.operation_id,
        http,
        cancel,
        options,
        Some(secret.expose_secret()),
        emit,
    )
    .await;
    ModelProbeResult {
        stream,
        diagnostics: ModelProbeDiagnostics {
            http_status: diagnostics.http_status,
            usage: diagnostics.usage,
            elapsed_ms: elapsed_ms(started),
            attempts: diagnostics.attempts,
        },
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}
