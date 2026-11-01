use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, Weak,
    },
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot, watch, Notify},
};
use tokio_util::sync::CancellationToken;

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
type Reply = oneshot::Sender<Result<Value, HostError>>;
pub type IncomingReceiver = mpsc::Receiver<Incoming>;

#[derive(Debug, Clone, thiserror::Error)]
pub enum HostError {
    #[error("Pi transport closed: {0}")]
    Closed(String),
    #[error("Pi transport I/O failed ({0})")]
    Io(String),
    #[error("Invalid Pi host record: {0}")]
    Protocol(String),
    #[error("Pi host record exceeds the 8MiB limit")]
    FrameTooLarge,
    #[error("Pi event consumer cannot keep up; the transport was closed without replay")]
    Backpressure,
    #[error("The Pi tool request has ended or was cancelled")]
    ToolCancelled,
    #[error("Pi host error {code}: {message}")]
    Host {
        code: String,
        message: String,
        details: Option<Value>,
    },
    #[error("Invalid Pi transport options")]
    InvalidOptions,
}

#[derive(Debug, Clone, Copy)]
pub struct TransportOptions {
    /// The owner must continuously drain and durably project these records.
    /// A full queue is a visible failure, never silent event loss.
    pub incoming_capacity: usize,
    pub write_capacity: usize,
}
impl Default for TransportOptions {
    fn default() -> Self {
        Self {
            incoming_capacity: 128,
            write_capacity: 8,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequest {
    pub request_id: String,
    pub session_id: String,
    pub task_id: Option<String>,
    pub tool_call_id: String,
    pub name: String,
    pub args: Value,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}
impl std::fmt::Debug for ToolRequest {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{
        f.debug_struct("ToolRequest").field("request_id",&self.request_id).field("session_id",&self.session_id).field("task_id",&self.task_id).field("tool_call_id",&self.tool_call_id).field("name",&self.name).finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
pub enum Incoming {
    /// Complete Pi event envelope, including session/task identifiers.
    Event(Value),
    ToolRequest(ToolRequest),
    ToolCancel {
        request_id: String,
    },
    /// A command-level error without a matching command ID (for example, a
    /// tool result raced host cancellation). It must remain observable.
    Notice(Value),
}

struct State {
    pending: Mutex<HashMap<String, Reply>>,
    tools: Mutex<HashSet<String>>,
    sequence: AtomicU64,
    cancel: CancellationToken,
    closed: watch::Sender<Option<HostError>>,
    tasks: AtomicUsize,
    task_done: Notify,
}
impl State {
    fn close(&self, reason: HostError) {
        {
            // Pending's short synchronous lock also serializes first close.
            let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            let mut value = self.closed.borrow().clone();
            if value.is_none() {
                value = Some(reason.clone());
                self.closed.send_replace(value.clone());
            }
            let reason = value.unwrap_or(reason);
            for (_, reply) in pending.drain() {
                let _ = reply.send(Err(reason.clone()));
            }
        }
        self.tools.lock().unwrap_or_else(|p| p.into_inner()).clear();
        self.cancel.cancel();
    }
    fn reason(&self) -> Option<HostError> {
        self.closed.borrow().clone()
    }
    fn done(&self) {
        self.tasks.fetch_sub(1, Ordering::AcqRel);
        self.task_done.notify_waiters();
    }
}

struct Lifetime(Weak<State>);
impl Drop for Lifetime {
    fn drop(&mut self) {
        if let Some(state) = self.0.upgrade() {
            state.close(HostError::Closed("last native handle dropped".into()));
        }
    }
}
struct PendingGuard {
    state: Arc<State>,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.state
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.id);
    }
}

#[derive(Clone)]
pub struct AgentConnection {
    state: Arc<State>,
    outgoing: mpsc::Sender<Vec<u8>>,
    _lifetime: Arc<Lifetime>,
}
impl AgentConnection {
    /// Works with desktop pipes or Android's private socketpair. The reader
    /// never executes tools and never waits for a tool's result.
    pub fn attach<R, W>(
        reader: R,
        writer: W,
        options: TransportOptions,
    ) -> Result<(Self, IncomingReceiver), HostError>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        if !(1..=4096).contains(&options.incoming_capacity)
            || !(1..=64).contains(&options.write_capacity)
        {
            return Err(HostError::InvalidOptions);
        }
        let (closed, _) = watch::channel(None);
        let state = Arc::new(State {
            pending: Mutex::new(HashMap::new()),
            tools: Mutex::new(HashSet::new()),
            sequence: AtomicU64::new(1),
            cancel: CancellationToken::new(),
            closed,
            tasks: AtomicUsize::new(2),
            task_done: Notify::new(),
        });
        let (outgoing, writes) = mpsc::channel(options.write_capacity);
        let (incoming, receiver) = mpsc::channel(options.incoming_capacity);
        let connection = Self {
            state: state.clone(),
            outgoing,
            _lifetime: Arc::new(Lifetime(Arc::downgrade(&state))),
        };
        let read_state = state.clone();
        tokio::spawn(async move {
            let result = read_records(reader, &read_state, incoming).await;
            read_state.close(
                result
                    .err()
                    .unwrap_or_else(|| HostError::Closed("host reached EOF".into())),
            );
            read_state.done();
        });
        tokio::spawn(async move {
            let result = write_records(writer, &state, writes).await;
            state.close(
                result
                    .err()
                    .unwrap_or_else(|| HostError::Closed("native writer closed".into())),
            );
            state.done();
        });
        Ok((connection, receiver))
    }

    /// Dropping this future removes only the response waiter. It does not
    /// cancel work or retry a command that may already have reached Pi.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, HostError> {
        if method.is_empty() || method == "tool_result" {
            return Err(HostError::Protocol("invalid request method".into()));
        }
        // Keep the workspace's Rust 1.90 boundary; its atomic method predates
        // the later `try_update` rename.
        #[allow(deprecated)]
        let number = self
            .state
            .sequence
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1))
            .map_err(|_| HostError::Protocol("command ID space exhausted".into()))?;
        let id = format!("native-{number}");
        let frame = encode(json!({"id":id,"method":method,"params":params}))?;
        let (send, receive) = oneshot::channel();
        {
            let mut pending = self.state.pending.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(reason) = self.state.reason() {
                return Err(reason);
            }
            pending.insert(id.clone(), send);
        }
        let _guard = PendingGuard {
            state: self.state.clone(),
            id,
        };
        self.write(frame).await?;
        receive.await.map_err(|_| {
            self.state
                .reason()
                .unwrap_or_else(|| HostError::Closed("response waiter ended".into()))
        })?
    }

    /// The gateway must persist the tool outcome before calling this. Results
    /// are never replayed by the transport, including on connection failure.
    pub async fn tool_result(&self, request_id: &str, result: Value) -> Result<(), HostError> {
        let frame = encode(
            json!({"method":"tool_result","params":{"requestId":request_id,"result":result}}),
        )?;
        if !self
            .state
            .tools
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(request_id)
        {
            return Err(HostError::ToolCancelled);
        }
        self.write(frame).await
    }

    async fn write(&self, frame: Vec<u8>) -> Result<(), HostError> {
        if let Some(reason) = self.state.reason() {
            return Err(reason);
        }
        tokio::select! { biased;
            _ = self.state.cancel.cancelled() => Err(self.state.reason().unwrap_or_else(|| HostError::Closed("transport cancelled".into()))),
            result = self.outgoing.send(frame) => result.map_err(|_| self.state.reason().unwrap_or_else(|| HostError::Closed("writer ended".into()))),
        }
    }

    /// Marks the transport closed, fails every waiter, drops both pipe ends,
    /// and waits for its reader/writer tasks. This is not a business stop
    /// acknowledgement; send and await `abort` when stopping a task.
    pub async fn close_transport(&self) {
        self.state
            .close(HostError::Closed("closed by native owner".into()));
        loop {
            let notified = self.state.task_done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.state.tasks.load(Ordering::Acquire) == 0 {
                break;
            }
            notified.await;
        }
    }

    pub async fn wait_closed(&self) -> HostError {
        let mut closed = self.state.closed.subscribe();
        loop {
            if let Some(reason) = closed.borrow().clone() {
                return reason;
            }
            if closed.changed().await.is_err() {
                return HostError::Closed("connection state ended".into());
            }
        }
    }

    pub fn is_closed(&self) -> bool {
        self.state.reason().is_some()
    }
    pub fn pending_requests(&self) -> usize {
        self.state
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len()
    }
}

fn encode(value: Value) -> Result<Vec<u8>, HostError> {
    let mut bytes = serde_json::to_vec(&value)
        .map_err(|_| HostError::Protocol("command cannot be encoded".into()))?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(HostError::FrameTooLarge);
    }
    bytes.push(b'\n');
    Ok(bytes)
}

async fn write_records<W: AsyncWrite + Unpin>(
    mut writer: W,
    state: &State,
    mut queue: mpsc::Receiver<Vec<u8>>,
) -> Result<(), HostError> {
    let result = loop {
        let frame = tokio::select! { biased; _ = state.cancel.cancelled() => break Ok(()), value = queue.recv() => value };
        let Some(frame) = frame else {
            break Ok(());
        };
        let write = tokio::select! { biased;
            _ = state.cancel.cancelled() => break Ok(()),
            value = writer.write_all(&frame) => value,
        };
        if let Err(error) = write {
            break Err(HostError::Io(error.kind().to_string()));
        }
    };
    // A misbehaving custom writer cannot leave cleanup waiting indefinitely.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), writer.shutdown()).await;
    result
}

async fn frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>, HostError> {
    let mut output = Vec::new();
    loop {
        let bytes = reader
            .fill_buf()
            .await
            .map_err(|error| HostError::Io(error.kind().to_string()))?;
        if bytes.is_empty() {
            return if output.is_empty() {
                Ok(None)
            } else {
                Err(HostError::Protocol("truncated JSON line".into()))
            };
        }
        let end = bytes.iter().position(|byte| *byte == b'\n');
        let take = end.unwrap_or(bytes.len());
        if output.len().saturating_add(take) > MAX_FRAME_BYTES {
            return Err(HostError::FrameTooLarge);
        }
        output.extend_from_slice(&bytes[..take]);
        reader.consume(take + usize::from(end.is_some()));
        if end.is_some() {
            if output.last() == Some(&b'\r') {
                output.pop();
            }
            return Ok(Some(output));
        }
    }
}

async fn read_records<R: AsyncRead + Unpin>(
    reader: R,
    state: &State,
    incoming: mpsc::Sender<Incoming>,
) -> Result<(), HostError> {
    let mut reader = BufReader::new(reader);
    loop {
        let bytes = tokio::select! { biased; _ = state.cancel.cancelled() => return Ok(()), value = frame(&mut reader) => value? };
        let Some(bytes) = bytes else {
            return Ok(());
        };
        if bytes.is_empty() {
            continue;
        }
        let record: Value = serde_json::from_slice(&bytes)
            .map_err(|_| HostError::Protocol("invalid JSON".into()))?;
        let envelope = match record["type"].as_str() {
            Some("response") => {
                let Some(id) = record["id"].as_str() else {
                    if record["ok"] == false {
                        emit(&incoming, Incoming::Notice(record))?;
                        continue;
                    }
                    return Err(HostError::Protocol("response ID missing".into()));
                };
                let pending = state
                    .pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(id);
                // A dropped waiter is intentional and must not stop the task.
                if let Some(reply) = pending {
                    let outcome = if record["ok"] == true {
                        Ok(record.get("data").cloned().unwrap_or(Value::Null))
                    } else if record["ok"] == false {
                        Err(HostError::Host {
                            code: record["error"]["code"]
                                .as_str()
                                .unwrap_or("host_error")
                                .into(),
                            message: record["error"]["message"]
                                .as_str()
                                .unwrap_or("Host command failed")
                                .into(),
                            details: record["error"].get("details").cloned(),
                        })
                    } else {
                        Err(HostError::Protocol("response success flag missing".into()))
                    };
                    let _ = reply.send(outcome);
                }
                continue;
            }
            Some("event") if record["event"].is_object() => Incoming::Event(record),
            Some("tool_request") => {
                let request: ToolRequest = serde_json::from_value(record)
                    .map_err(|_| HostError::Protocol("incomplete tool request".into()))?;
                if request.request_id.is_empty()
                    || request.tool_call_id.is_empty()
                    || request.session_id.is_empty()
                    || request.name.is_empty()
                {
                    return Err(HostError::Protocol("empty tool identity".into()));
                }
                if !state
                    .tools
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(request.request_id.clone())
                {
                    return Err(HostError::Protocol(
                        "duplicate active tool request ID".into(),
                    ));
                }
                Incoming::ToolRequest(request)
            }
            Some("tool_cancel") => {
                let request_id = record["requestId"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| HostError::Protocol("tool cancellation ID missing".into()))?
                    .to_owned();
                state
                    .tools
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&request_id);
                Incoming::ToolCancel { request_id }
            }
            _ => return Err(HostError::Protocol("unknown host record type".into())),
        };
        emit(&incoming, envelope)?;
    }
}

fn emit(incoming: &mpsc::Sender<Incoming>, value: Incoming) -> Result<(), HostError> {
    incoming.try_send(value).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => HostError::Backpressure,
        mpsc::error::TrySendError::Closed(_) => {
            HostError::Closed("native event consumer ended".into())
        }
    })
}
