//! Bounded HTTP/SSE transport probe. All text is an uncommitted test draft.
//!
//! The probe makes one GET request without credentials, retries, redirects,
//! database access, or raw diagnostic output. It is not a model Provider.
//! SSE framing follows the WHATWG event-stream format, except invalid UTF-8 is
//! rejected instead of replaced and EOF never implies a completed generation.
//! Android HTTPS also requires the native host to initialize the matching
//! rustls-platform-verifier JVM/Kotlin component. HTTP tests do not verify it.

use std::time::Duration;

use reqwest::{header, Client, Url};
use serde::Serialize;
use serde_json::Value;
use tokio::time::{sleep_until, Instant};
use tokio_util::sync::CancellationToken;

const MAX_EVENT_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StreamStatus {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StreamEventKind {
    Started,
    Delta,
    Finished,
}

/// Stable safe error codes. No upstream body, URL, or header is included.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StreamErrorCode {
    InvalidUrl,
    InvalidOptions,
    ClientSetup,
    Network,
    ConnectTimeout,
    IdleTimeout,
    TotalTimeout,
    HttpStatus,
    InvalidContentType,
    InvalidUtf8,
    EventTooLarge,
    ResponseTooLarge,
    OutputTooLarge,
    InvalidPayload,
    UpstreamError,
    Refused,
    Truncated,
    UnexpectedEof,
    EmptyOutput,
    ConsumerClosed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeStreamEvent {
    pub operation_id: String,
    pub sequence: u64,
    pub kind: StreamEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<StreamStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<StreamErrorCode>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StreamResult {
    pub operation_id: String,
    pub status: StreamStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<StreamErrorCode>,
    pub text: String,
    pub delta_count: u64,
}

/// Tests may lower these budgets. Increasing the production caps is rejected.
#[derive(Debug, Clone)]
pub struct StreamOptions {
    pub connect_timeout: Duration,
    pub idle_timeout: Duration,
    pub total_timeout: Duration,
    pub max_event_bytes: usize,
    pub max_response_bytes: usize,
    pub max_output_bytes: usize,
}

impl Default for StreamOptions {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(5),
            idle_timeout: Duration::from_secs(10),
            total_timeout: Duration::from_secs(90),
            max_event_bytes: MAX_EVENT_BYTES,
            max_response_bytes: MAX_RESPONSE_BYTES,
            max_output_bytes: MAX_OUTPUT_BYTES,
        }
    }
}

impl StreamOptions {
    fn is_valid(&self) -> bool {
        !self.connect_timeout.is_zero()
            && self.connect_timeout <= Duration::from_secs(5)
            && !self.idle_timeout.is_zero()
            && self.idle_timeout <= Duration::from_secs(10)
            && !self.total_timeout.is_zero()
            && self.total_timeout <= Duration::from_secs(90)
            && (1..=MAX_EVENT_BYTES).contains(&self.max_event_bytes)
            && (1..=MAX_RESPONSE_BYTES).contains(&self.max_response_bytes)
            && (1..=MAX_OUTPUT_BYTES).contains(&self.max_output_bytes)
    }
}

enum Outcome {
    Completed,
    Cancelled,
    Failed(StreamErrorCode),
    ConsumerClosed,
}

struct Emitter<F> {
    operation_id: String,
    sequence: u64,
    text: String,
    delta_count: u64,
    emit: F,
}

impl<F: FnMut(ProbeStreamEvent) -> bool> Emitter<F> {
    fn send(&mut self, kind: StreamEventKind, text: Option<String>) -> bool {
        let accepted = (self.emit)(ProbeStreamEvent {
            operation_id: self.operation_id.clone(),
            sequence: self.sequence,
            kind,
            text,
            status: None,
            error_code: None,
        });
        self.sequence += 1;
        accepted
    }

    fn finish(mut self, outcome: Outcome) -> StreamResult {
        let (status, error_code) = match outcome {
            Outcome::Completed => (StreamStatus::Completed, None),
            Outcome::Cancelled => (StreamStatus::Cancelled, None),
            Outcome::Failed(error) => (StreamStatus::Failed, Some(error)),
            Outcome::ConsumerClosed => (
                StreamStatus::Cancelled,
                Some(StreamErrorCode::ConsumerClosed),
            ),
        };
        // Exactly one terminal delivery attempt, even if the receiver closed.
        let _ = (self.emit)(ProbeStreamEvent {
            operation_id: self.operation_id.clone(),
            sequence: self.sequence,
            kind: StreamEventKind::Finished,
            text: None,
            status: Some(status),
            error_code,
        });
        StreamResult {
            operation_id: self.operation_id,
            status,
            error_code,
            text: self.text,
            delta_count: self.delta_count,
        }
    }
}

/// Receives one SSE response. The callback must return promptly; `false` stops
/// the local consumer. Cancelling drops the local request, not provider billing.
pub async fn run_probe_stream(
    operation_id: String,
    url: String,
    cancel: CancellationToken,
    emit: impl FnMut(ProbeStreamEvent) -> bool,
) -> StreamResult {
    run_probe_stream_with_options(operation_id, url, cancel, StreamOptions::default(), emit).await
}

pub async fn run_probe_stream_with_options(
    operation_id: String,
    url: String,
    cancel: CancellationToken,
    options: StreamOptions,
    emit: impl FnMut(ProbeStreamEvent) -> bool,
) -> StreamResult {
    let mut emitter = Emitter {
        operation_id,
        sequence: 0,
        text: String::new(),
        delta_count: 0,
        emit,
    };
    if !emitter.send(StreamEventKind::Started, None) {
        return emitter.finish(Outcome::ConsumerClosed);
    }
    let outcome = receive_stream(&url, &cancel, &options, &mut emitter).await;
    emitter.finish(outcome)
}

async fn receive_stream<F: FnMut(ProbeStreamEvent) -> bool>(
    url: &str,
    cancel: &CancellationToken,
    options: &StreamOptions,
    emitter: &mut Emitter<F>,
) -> Outcome {
    if cancel.is_cancelled() {
        return Outcome::Cancelled;
    }
    if !options.is_valid() {
        return Outcome::Failed(StreamErrorCode::InvalidOptions);
    }
    let url = match Url::parse(url) {
        Ok(url)
            if matches!(url.scheme(), "http" | "https")
                && url.has_host()
                && url.username().is_empty()
                && url.password().is_none() =>
        {
            url
        }
        _ => return Outcome::Failed(StreamErrorCode::InvalidUrl),
    };
    let deadline = Instant::now() + options.total_timeout;
    let client = match Client::builder()
        .connect_timeout(options.connect_timeout)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => return Outcome::Failed(StreamErrorCode::ClientSetup),
    };
    let request = client
        .get(url)
        .header(header::ACCEPT, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .send();
    let mut response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Outcome::Cancelled,
        _ = sleep_until(deadline) => return Outcome::Failed(StreamErrorCode::TotalTimeout),
        result = tokio::time::timeout(options.connect_timeout, request) => match result {
            Err(_) => return Outcome::Failed(StreamErrorCode::ConnectTimeout),
            Ok(Err(error)) if error.is_timeout() => return Outcome::Failed(StreamErrorCode::ConnectTimeout),
            Ok(Err(_)) => return Outcome::Failed(StreamErrorCode::Network),
            Ok(Ok(response)) => response,
        },
    };
    if response.status() != reqwest::StatusCode::OK {
        return Outcome::Failed(StreamErrorCode::HttpStatus);
    }
    let is_event_stream = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"));
    if !is_event_stream {
        return Outcome::Failed(StreamErrorCode::InvalidContentType);
    }
    let mut decoder = SseDecoder::new(options.max_event_bytes);
    let mut response_bytes = 0usize;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Outcome::Cancelled,
            _ = sleep_until(deadline) => return Outcome::Failed(StreamErrorCode::TotalTimeout),
            result = tokio::time::timeout(options.idle_timeout, response.chunk()) => match result {
                Err(_) => return Outcome::Failed(StreamErrorCode::IdleTimeout),
                Ok(Err(_)) => return Outcome::Failed(StreamErrorCode::Network),
                Ok(Ok(None)) => return Outcome::Failed(decoder.eof_error()),
                Ok(Ok(Some(chunk))) => chunk,
            },
        };
        response_bytes = match response_bytes.checked_add(chunk.len()) {
            Some(bytes) if bytes <= options.max_response_bytes => bytes,
            _ => return Outcome::Failed(StreamErrorCode::ResponseTooLarge),
        };
        for &byte in chunk.iter() {
            if cancel.is_cancelled() {
                return Outcome::Cancelled;
            }
            if Instant::now() >= deadline {
                return Outcome::Failed(StreamErrorCode::TotalTimeout);
            }
            let message = match decoder.push_byte(byte) {
                Ok(Some(message)) => message,
                Ok(None) => continue,
                Err(error) => return Outcome::Failed(error),
            };
            match interpret_message(message) {
                Err(error) => return Outcome::Failed(error),
                Ok(Payload::Metadata) => {}
                Ok(Payload::Done) => {
                    return if emitter.text.is_empty() {
                        Outcome::Failed(StreamErrorCode::EmptyOutput)
                    } else {
                        Outcome::Completed
                    };
                }
                Ok(Payload::Delta(text)) => {
                    if emitter.text.len().saturating_add(text.len()) > options.max_output_bytes {
                        return Outcome::Failed(StreamErrorCode::OutputTooLarge);
                    }
                    emitter.text.push_str(&text);
                    emitter.delta_count += 1;
                    if !emitter.send(StreamEventKind::Delta, Some(text)) {
                        return Outcome::ConsumerClosed;
                    }
                }
            }
        }
    }
}

struct SseMessage {
    event: String,
    data: String,
}

struct SseDecoder {
    line: Vec<u8>,
    data: String,
    event: String,
    first_line: bool,
    skip_lf: bool,
    event_bytes: usize,
    max_event_bytes: usize,
}

impl SseDecoder {
    fn new(max_event_bytes: usize) -> Self {
        Self {
            line: Vec::new(),
            data: String::new(),
            event: String::new(),
            first_line: true,
            skip_lf: false,
            event_bytes: 0,
            max_event_bytes,
        }
    }

    fn push_byte(&mut self, byte: u8) -> Result<Option<SseMessage>, StreamErrorCode> {
        if self.skip_lf {
            self.skip_lf = false;
            if byte == b'\n' {
                return Ok(None);
            }
        }
        self.event_bytes += 1;
        if self.event_bytes > self.max_event_bytes {
            return Err(StreamErrorCode::EventTooLarge);
        }
        if byte != b'\r' && byte != b'\n' {
            self.line.push(byte);
            return Ok(None);
        }
        self.skip_lf = byte == b'\r';
        let bytes = std::mem::take(&mut self.line);
        let mut line = std::str::from_utf8(&bytes).map_err(|_| StreamErrorCode::InvalidUtf8)?;
        if self.first_line {
            self.first_line = false;
            line = line.strip_prefix('\u{feff}').unwrap_or(line);
        }
        if line.is_empty() {
            self.event_bytes = 0;
            let event = std::mem::take(&mut self.event);
            if self.data.is_empty() {
                return Ok(None);
            }
            self.data.pop(); // Every data field appended one framing newline.
            return Ok(Some(SseMessage {
                event,
                data: std::mem::take(&mut self.data),
            }));
        }
        if line.starts_with(':') {
            return Ok(None);
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "data" => {
                self.data.push_str(value);
                self.data.push('\n');
            }
            "event" => self.event = value.to_owned(),
            // id/retry do not grant this one-shot probe reconnection rights.
            _ => {}
        }
        Ok(None)
    }

    fn eof_error(&self) -> StreamErrorCode {
        if std::str::from_utf8(&self.line).is_err() {
            StreamErrorCode::InvalidUtf8
        } else {
            StreamErrorCode::UnexpectedEof
        }
    }
}

enum Payload {
    Delta(String),
    Metadata,
    Done,
}

fn interpret_message(message: SseMessage) -> Result<Payload, StreamErrorCode> {
    if message.event == "error" {
        return Err(StreamErrorCode::UpstreamError);
    }
    if !message.event.is_empty() && message.event != "message" {
        return Err(StreamErrorCode::InvalidPayload);
    }
    if message.data == "[DONE]" {
        return Ok(Payload::Done);
    }
    let payload: Value =
        serde_json::from_str(&message.data).map_err(|_| StreamErrorCode::InvalidPayload)?;
    let object = payload.as_object().ok_or(StreamErrorCode::InvalidPayload)?;
    if object.get("error").is_some_and(|error| !error.is_null()) {
        return Err(StreamErrorCode::UpstreamError);
    }
    let choices = match object.get("choices") {
        Some(value) => value.as_array().ok_or(StreamErrorCode::InvalidPayload)?,
        None if object.get("usage").is_some_and(Value::is_object) => return Ok(Payload::Metadata),
        None => return Err(StreamErrorCode::InvalidPayload),
    };
    let Some(choice) = choices.first() else {
        return if object.get("usage").is_some_and(Value::is_object) {
            Ok(Payload::Metadata)
        } else {
            Err(StreamErrorCode::InvalidPayload)
        };
    };
    let choice = choice.as_object().ok_or(StreamErrorCode::InvalidPayload)?;
    match choice.get("finish_reason") {
        None | Some(Value::Null) => {}
        Some(Value::String(reason)) if reason == "stop" => {}
        Some(Value::String(reason)) if reason == "length" => {
            return Err(StreamErrorCode::Truncated)
        }
        Some(Value::String(reason)) if reason == "content_filter" => {
            return Err(StreamErrorCode::Refused)
        }
        Some(_) => return Err(StreamErrorCode::InvalidPayload),
    }
    let delta = choice
        .get("delta")
        .and_then(Value::as_object)
        .ok_or(StreamErrorCode::InvalidPayload)?;
    if delta.keys().any(|key| {
        !matches!(
            key.as_str(),
            "content" | "role" | "refusal" | "tool_calls" | "function_call"
        )
    }) {
        return Err(StreamErrorCode::InvalidPayload);
    }
    if delta
        .get("role")
        .is_some_and(|role| role.as_str() != Some("assistant"))
    {
        return Err(StreamErrorCode::InvalidPayload);
    }
    match delta.get("refusal") {
        None | Some(Value::Null) => {}
        Some(Value::String(refusal)) if refusal.is_empty() => {}
        Some(Value::String(_)) => return Err(StreamErrorCode::Refused),
        Some(_) => return Err(StreamErrorCode::InvalidPayload),
    }
    if delta
        .get("tool_calls")
        .is_some_and(|value| !value.is_null())
        || delta
            .get("function_call")
            .is_some_and(|value| !value.is_null())
    {
        return Err(StreamErrorCode::InvalidPayload);
    }
    match delta.get("content") {
        None | Some(Value::Null) => Ok(Payload::Metadata),
        Some(Value::String(text)) if text.is_empty() => Ok(Payload::Metadata),
        Some(Value::String(text)) => Ok(Payload::Delta(text.clone())),
        Some(_) => Err(StreamErrorCode::InvalidPayload),
    }
}
