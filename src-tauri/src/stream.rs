use crate::{
    error::{blocking, io_error, PlatformError, Result},
    keep_alive::{self, KeepAlive, Lease},
    secrets::SecretValue,
};
use reqwest::{header, Client, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::{sleep_until, Instant};
use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};

const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_HTTP_ERROR: usize = 8 * 1024;
const MAX_GET: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum StreamEvent {
    Open {
        status: u16,
    },
    Data {
        data: String,
    },
    Done,
    Error {
        kind: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

impl StreamEvent {
    fn error(kind: &str) -> Self {
        Self::Error {
            kind: kind.into(),
            status: None,
            message: None,
        }
    }

    fn terminal(&self) -> bool {
        matches!(self, Self::Done | Self::Error { .. })
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeouts {
    pub first_byte_ms: u64,
    pub idle_ms: u64,
    pub total_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resume {
    pub events: Vec<StreamEvent>,
    pub active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub stream_id: String,
    pub finished: bool,
    pub active: bool,
}

#[derive(Debug, Serialize)]
pub struct GetResponse {
    pub status: u16,
    pub body: String,
}

#[derive(Clone)]
struct Active {
    cancel: CancellationToken,
    finished: CancellationToken,
}

pub type EventSink = Arc<dyn Fn(StreamEvent) + Send + Sync>;

pub struct Streams {
    directory: PathBuf,
    active: Mutex<HashMap<String, Active>>,
    keep_alive: Arc<KeepAlive>,
}

// Owned from registration until terminal delivery. Drop also runs on task
// abort/unwind, or when the start future is dropped during registration.
struct ActiveStream {
    service: Arc<Streams>,
    id: String,
    control: Active,
    lease: Option<Lease>,
}

impl Drop for ActiveStream {
    fn drop(&mut self) {
        let mut active = self
            .service
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        active.remove(&self.id);
        drop(self.lease.take());
        drop(active);
        // cancel/ack waiters must observe both map cleanup and lease release.
        self.control.finished.cancel();
    }
}

fn valid_id(id: &str) -> bool {
    id.len() >= 16
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

impl Streams {
    pub async fn start_request(
        self: &Arc<Self>,
        credentials: Arc<crate::credentials::Credentials>,
        slot: String,
        url: String,
        body: serde_json::Value,
        timeouts: Timeouts,
        sink: EventSink,
    ) -> Result<String> {
        let target = url.clone();
        let key = match blocking(move || credentials.authorize(&slot, &target)).await {
            Ok(key) => Some(key),
            Err(error) if error.code == "llm_no_secret" => None,
            Err(error) => return Err(error),
        };
        self.start(url, body, timeouts, key, sink).await
    }

    pub fn open(cache: PathBuf) -> Result<Self> {
        let directory = cache.join("streams");
        fs::create_dir_all(&directory).map_err(|_| io_error())?;
        Ok(Self {
            directory,
            active: Mutex::new(HashMap::new()),
            keep_alive: keep_alive::shared(),
        })
    }

    fn path(&self, id: &str) -> Result<PathBuf> {
        if !valid_id(id) {
            return Err(PlatformError::new("llm_stream_id", "流标识格式不正确"));
        }
        Ok(self.directory.join(format!("{id}.jsonl")))
    }

    fn append(&self, id: &str, event: &StreamEvent) -> Result<()> {
        let mut file = OpenOptions::new()
            .append(true)
            .open(self.path(id)?)
            .map_err(|_| io_error())?;
        let mut record = serde_json::to_vec(event).map_err(|_| io_error())?;
        record.push(b'\n');
        file.write_all(&record).map_err(|_| io_error())?;
        file.flush().map_err(|_| io_error())
    }

    fn events(&self, id: &str) -> Result<Option<Vec<StreamEvent>>> {
        let bytes = match fs::read(self.path(id)?) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(io_error()),
        };
        let mut events = Vec::new();
        let mut valid_len = 0;
        for line in bytes.split_inclusive(|b| *b == b'\n') {
            if !line.ends_with(b"\n") {
                break;
            }
            events.push(serde_json::from_slice(line).map_err(|_| io_error())?);
            valid_len += line.len();
        }
        // A process kill can leave the last append incomplete.
        if valid_len != bytes.len() {
            OpenOptions::new()
                .write(true)
                .open(self.path(id)?)
                .and_then(|f| f.set_len(valid_len as u64))
                .map_err(|_| io_error())?;
        }
        Ok(Some(events))
    }

    pub fn resume(&self, id: &str) -> Result<Option<Resume>> {
        let active = self.active.lock().map_err(|_| io_error())?;
        let Some(mut events) = self.events(id)? else {
            return Ok(None);
        };
        let running = active.contains_key(id);
        if !running && !events.last().is_some_and(StreamEvent::terminal) {
            let event = StreamEvent::Error {
                kind: "network".into(),
                status: None,
                message: Some("interrupted".into()),
            };
            self.append(id, &event)?;
            events.push(event);
        }
        Ok(Some(Resume {
            events,
            active: running,
        }))
    }

    pub fn list(&self) -> Result<Vec<StreamInfo>> {
        let active = self.active.lock().map_err(|_| io_error())?;
        let mut result = Vec::new();
        for entry in fs::read_dir(&self.directory).map_err(|_| io_error())? {
            let entry = entry.map_err(|_| io_error())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".jsonl").filter(|id| valid_id(id)) else {
                continue;
            };
            let events = self.events(id)?.unwrap_or_default();
            result.push(StreamInfo {
                stream_id: id.into(),
                finished: events.last().is_some_and(StreamEvent::terminal),
                active: active.contains_key(id),
            });
        }
        result.sort_by(|a, b| a.stream_id.cmp(&b.stream_id));
        Ok(result)
    }

    pub async fn start(
        self: &Arc<Self>,
        url: String,
        body: serde_json::Value,
        timeouts: Timeouts,
        key: Option<SecretValue>,
        sink: EventSink,
    ) -> Result<String> {
        if !body.is_object() {
            return Err(PlatformError::new("llm_body_type", "请求体必须为对象"));
        }
        Budget::new(timeouts)
            .map_err(|_| PlatformError::new("llm_timeouts", "超时参数超出范围"))?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let task_id = id.clone();
        let service = Arc::clone(self);
        let control = Active {
            cancel: CancellationToken::new(),
            finished: CancellationToken::new(),
        };
        let registered = control.clone();
        let registration_id = id.clone();
        let lifecycle = blocking(move || {
            let mut active = service.active.lock().map_err(|_| io_error())?;
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(service.path(&registration_id)?)
                .map_err(|_| io_error())?;
            let lease = service.keep_alive.acquire();
            active.insert(registration_id.clone(), registered.clone());
            drop(active);
            Ok(ActiveStream {
                service,
                id: registration_id,
                control: registered,
                lease: Some(lease),
            })
        })
        .await?;
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let _lifecycle = lifecycle;
            let emitter = Emitter {
                service,
                id: task_id,
                sink,
            };
            let receiver = emitter.clone();
            // Isolate a receiver panic so the supervisor can cache a terminal
            // error. The outer RAII guard also covers a panic during delivery.
            let outcome = AbortOnDropHandle::new(tokio::spawn(async move {
                match key {
                    Some(key) => {
                        receive(&url, body, timeouts, &key, &control.cancel, &receiver).await
                    }
                    None => Err(StreamEvent::error(if control.cancel.is_cancelled() {
                        "cancelled"
                    } else {
                        "no_secret"
                    })),
                }
            }))
            .await
            .unwrap_or_else(|_| Err(StreamEvent::error("network")));
            let terminal = outcome.err().unwrap_or(StreamEvent::Done);
            if let Err(event) = emitter.emit(terminal).await {
                (emitter.sink)(event);
            }
        });
        Ok(id)
    }

    pub async fn cancel(self: &Arc<Self>, id: &str) -> Result<()> {
        self.path(id)?;
        let service = Arc::clone(self);
        let id = id.to_owned();
        let control = blocking(move || {
            Ok(service
                .active
                .lock()
                .map_err(|_| io_error())?
                .get(&id)
                .cloned())
        })
        .await?;
        if let Some(control) = control {
            control.cancel.cancel();
            control.finished.cancelled().await;
        }
        Ok(())
    }

    pub async fn ack(self: &Arc<Self>, id: String) -> Result<()> {
        self.cancel(&id).await?;
        let service = Arc::clone(self);
        blocking(move || {
            let _active = service.active.lock().map_err(|_| io_error())?;
            match fs::remove_file(service.path(&id)?) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err(io_error()),
            }
        })
        .await
    }
}

#[derive(Clone)]
struct Emitter {
    service: Arc<Streams>,
    id: String,
    sink: EventSink,
}

impl Emitter {
    async fn emit(&self, event: StreamEvent) -> std::result::Result<(), StreamEvent> {
        let service = Arc::clone(&self.service);
        let id = self.id.clone();
        let sink = Arc::clone(&self.sink);
        blocking(move || {
            {
                let _active = service.active.lock().map_err(|_| io_error())?;
                service.append(&id, &event)?;
            }
            sink(event);
            Ok(())
        })
        .await
        .map_err(|_| StreamEvent::error("network"))
    }
}

fn client() -> std::result::Result<Client, StreamEvent> {
    #[cfg(target_os = "android")]
    if !crate::android_tls::is_ready() {
        return Err(StreamEvent::error("network"));
    }
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .build()
        .map_err(|_| StreamEvent::error("network"))
}

struct Budget {
    first: Instant,
    idle: Duration,
    total: Instant,
    last: Option<Instant>,
}

impl Budget {
    fn new(timeouts: Timeouts) -> std::result::Result<Self, StreamEvent> {
        let now = Instant::now();
        Ok(Self {
            first: now
                .checked_add(Duration::from_millis(timeouts.first_byte_ms))
                .ok_or_else(|| StreamEvent::error("timeout_first"))?,
            idle: Duration::from_millis(timeouts.idle_ms),
            total: now
                .checked_add(Duration::from_millis(timeouts.total_ms))
                .ok_or_else(|| StreamEvent::error("timeout_total"))?,
            last: None,
        })
    }

    async fn wait<T>(
        &self,
        cancel: &CancellationToken,
        future: impl std::future::Future<Output = reqwest::Result<T>>,
    ) -> std::result::Result<T, StreamEvent> {
        let limit = self
            .last
            .map_or(Some(self.first), |last| last.checked_add(self.idle))
            .unwrap_or(self.total);
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(StreamEvent::error("cancelled")),
            _ = sleep_until(self.total) => Err(StreamEvent::error("timeout_total")),
            _ = sleep_until(limit) => Err(StreamEvent::error(if self.last.is_none() { "timeout_first" } else { "timeout_idle" })),
            result = future => result.map_err(|_| StreamEvent::error("network")),
        }
    }

    async fn chunk(
        &mut self,
        cancel: &CancellationToken,
        response: &mut Response,
    ) -> std::result::Result<Option<bytes::Bytes>, StreamEvent> {
        let chunk = self.wait(cancel, response.chunk()).await?;
        if chunk.as_ref().is_some_and(|c| !c.is_empty()) {
            self.last = Some(Instant::now());
        }
        Ok(chunk)
    }
}

async fn bounded_body(
    response: &mut Response,
    budget: &mut Budget,
    cancel: &CancellationToken,
    limit: usize,
) -> std::result::Result<Vec<u8>, StreamEvent> {
    let mut body = Vec::new();
    while body.len() < limit {
        let Some(chunk) = budget.chunk(cancel, response).await? else {
            break;
        };
        let length = chunk.len().min(limit - body.len());
        body.extend_from_slice(&chunk[..length]);
    }
    Ok(body)
}

async fn receive(
    url: &str,
    body: serde_json::Value,
    timeouts: Timeouts,
    key: &SecretValue,
    cancel: &CancellationToken,
    emitter: &Emitter,
) -> std::result::Result<(), StreamEvent> {
    let request = client()?
        .post(url)
        .bearer_auth(key.expose_secret())
        .header(header::ACCEPT, "text/event-stream")
        .json(&body);
    let mut budget = Budget::new(timeouts)?;
    let mut response = budget.wait(cancel, request.send()).await?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let bytes = bounded_body(&mut response, &mut budget, cancel, MAX_HTTP_ERROR).await?;
        return Err(StreamEvent::Error {
            kind: "http".into(),
            status: Some(status),
            message: Some(String::from_utf8_lossy(&bytes).replace(key.expose_secret(), "***")),
        });
    }
    emitter.emit(StreamEvent::Open { status }).await?;
    let sse = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|s| {
            s.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("text/event-stream")
        });
    let mut total = 0;
    let mut pending = Vec::new();
    while let Some(chunk) = budget.chunk(cancel, &mut response).await? {
        total += chunk.len();
        if total > MAX_BODY {
            return Err(StreamEvent::error("too_large"));
        }
        pending.extend_from_slice(&chunk);
        if sse {
            let mut start = 0;
            while let Some(offset) = pending[start..].iter().position(|b| *b == b'\n') {
                let end = start + offset;
                if forward_line(&pending[start..end], key, emitter).await? {
                    return Ok(());
                }
                start = end + 1;
            }
            pending.drain(..start);
        }
    }
    if sse {
        if !pending.is_empty() {
            forward_line(&pending, key, emitter).await?;
        }
    } else {
        let data = String::from_utf8_lossy(&pending).into_owned();
        if data.contains(key.expose_secret()) {
            return Err(StreamEvent::error("secret_echo"));
        }
        emitter.emit(StreamEvent::Data { data }).await?;
    }
    Ok(())
}

async fn forward_line(
    line: &[u8],
    key: &SecretValue,
    emitter: &Emitter,
) -> std::result::Result<bool, StreamEvent> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let Some(data) = line.strip_prefix(b"data:") else {
        return Ok(false);
    };
    let data = data.strip_prefix(b" ").unwrap_or(data);
    let data = String::from_utf8_lossy(data).into_owned();
    if data.contains(key.expose_secret()) {
        return Err(StreamEvent::error("secret_echo"));
    }
    if data == "[DONE]" {
        return Ok(true);
    }
    emitter.emit(StreamEvent::Data { data }).await?;
    Ok(false)
}

pub async fn get(url: &str, timeout_ms: u64, key: SecretValue) -> Result<GetResponse> {
    let run = async {
        let request: RequestBuilder = client()?.get(url).bearer_auth(key.expose_secret());
        let mut budget = Budget::new(Timeouts {
            first_byte_ms: timeout_ms,
            idle_ms: timeout_ms,
            total_ms: timeout_ms,
        })?;
        let cancel = CancellationToken::new();
        let mut response = budget.wait(&cancel, request.send()).await?;
        let status = response.status().as_u16();
        let bytes = bounded_body(&mut response, &mut budget, &cancel, MAX_GET).await?;
        let mut body = String::from_utf8_lossy(&bytes).replace(key.expose_secret(), "***");
        if body.len() > MAX_GET {
            let mut end = MAX_GET;
            while !body.is_char_boundary(end) {
                end -= 1;
            }
            body.truncate(end);
        }
        Ok::<_, StreamEvent>(GetResponse { status, body })
    };
    run.await.map_err(|event| match event {
        StreamEvent::Error { kind, .. } if kind.starts_with("timeout_") => {
            PlatformError::new("llm_timeout", "请求超时")
        }
        _ => PlatformError::new("llm_network", "网络请求失败"),
    })
}

#[cfg(test)]
mod tests;
