//! A private model transport, separate from the model-facing network tools.
//! Pi keeps its provider payloads and streaming parser; native hosts own TLS,
//! proxies and credentials. Only short control replies cross this interface.
use crate::{
    chat::BoxFuture,
    pi_gateway::{StoryToolGateway, TaskPermit},
    pi_store::arguments_hash,
    Error, Result,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio_util::sync::CancellationToken;

static NETWORK_EPOCH: AtomicU64 = AtomicU64::new(0);
pub fn network_epoch() -> u64 {
    NETWORK_EPOCH.load(Ordering::Acquire)
}
pub fn bump_network_epoch() {
    NETWORK_EPOCH.fetch_add(1, Ordering::AcqRel);
}

pub const MAX_MODEL_CHUNK: usize = 64 * 1024;
pub trait ModelHttpBody: Send + Sync {
    fn next(&self, cancel: CancellationToken) -> BoxFuture<Result<Option<Vec<u8>>>>;
}
pub struct ModelHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Arc<dyn ModelHttpBody>,
}
/// Called by the platform immediately before the actual HTTP send, after its
/// local endpoint/credential checks. Repeated admission never permits a replay.
pub type ModelAdmission = Arc<dyn Fn() -> Result<Value> + Send + Sync>;
pub type ModelHttpHost = Arc<
    dyn Fn(Value, Value, CancellationToken, ModelAdmission) -> BoxFuture<Result<ModelHttpResponse>>
        + Send
        + Sync,
>;

/// Strip trailing `/openai` compatibility suffix from a Gemini base URL so
/// native `/v1beta/models/...` requests do not hit `/v1beta/openai/models/...`.
pub fn strip_gemini_openai_base(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    let Some(scheme_sep) = trimmed.find("://") else {
        return trimmed.to_owned();
    };
    let after_scheme = &trimmed[scheme_sep + 3..];
    let Some(slash) = after_scheme.find('/') else {
        return trimmed.to_owned();
    };
    let origin = &trimmed[..scheme_sep + 3 + slash];
    let path = &after_scheme[slash..];
    let fixed = if let Some(prefix) = path.strip_suffix("/v1beta/openai") {
        format!("{prefix}/v1beta")
    } else if let Some(prefix) = path.strip_suffix("/v1alpha/openai") {
        format!("{prefix}/v1alpha")
    } else if let Some(prefix) = path.strip_suffix("/v1/openai") {
        format!("{prefix}/v1beta")
    } else if let Some(prefix) = path.strip_suffix("/openai") {
        format!("{prefix}/v1beta")
    } else {
        return trimmed.to_owned();
    };
    format!("{origin}{fixed}")
}

/// Rewrite `/v1beta/openai/models/...` (including `{model}` templates) to
/// `/v1beta/models/...` while preserving origin, proxy prefixes, and query strings.
pub fn normalize_gemini_native_url(raw: &str) -> String {
    let trimmed = raw.trim();
    let (base_part, suffix) = match trimmed.find(['?', '#']) {
        Some(idx) => (&trimmed[..idx], &trimmed[idx..]),
        None => (trimmed, ""),
    };
    let Some(scheme_sep) = base_part.find("://") else {
        return trimmed.to_owned();
    };
    let after_scheme = &base_part[scheme_sep + 3..];
    let Some(slash) = after_scheme.find('/') else {
        return trimmed.to_owned();
    };
    let origin = &base_part[..scheme_sep + 3 + slash];
    let path = &after_scheme[slash..];
    let fixed_path = if let Some((prefix, rest)) = path.rsplit_once("/v1beta/openai/models/") {
        format!("{prefix}/v1beta/models/{rest}")
    } else if let Some((prefix, rest)) = path.rsplit_once("/v1alpha/openai/models/") {
        format!("{prefix}/v1alpha/models/{rest}")
    } else if let Some((prefix, rest)) = path.rsplit_once("/v1/openai/models/") {
        format!("{prefix}/v1beta/models/{rest}")
    } else if let Some((prefix, rest)) = path.rsplit_once("/openai/models/") {
        format!("{prefix}/v1beta/models/{rest}")
    } else {
        return trimmed.to_owned();
    };
    format!("{origin}{fixed_path}{suffix}")
}

#[derive(Default)]
struct SseUsageTracker {
    buffer: Vec<u8>,
    input: Option<u64>,
    output: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
    reasoning: Option<u64>,
    total_tokens: Option<u64>,
}

impl SseUsageTracker {
    fn feed(&mut self, chunk: &[u8]) {
        if self.buffer.len().saturating_add(chunk.len()) > 256 * 1024 {
            self.buffer.clear();
        }
        self.buffer.extend_from_slice(chunk);
        while let Some(pos) = self.buffer.iter().position(|b| *b == b'\n') {
            let line_bytes: Vec<u8> = self.buffer.drain(..=pos).collect();
            if let Ok(line) = std::str::from_utf8(&line_bytes) {
                self.parse_line(line.trim());
            }
        }
    }

    fn flush_tail(&mut self) {
        if !self.buffer.is_empty() {
            let tail = std::mem::take(&mut self.buffer);
            if let Ok(line) = std::str::from_utf8(&tail) {
                self.parse_line(line.trim());
            }
        }
    }

    fn parse_line(&mut self, line: &str) {
        let Some(rest) = line.strip_prefix("data:") else {
            return;
        };
        let payload = rest.trim();
        if payload.is_empty() || payload == "[DONE]" {
            return;
        }
        let Ok(val) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        let kind = val["type"].as_str().unwrap_or("");
        if kind == "message_start" {
            let u = &val["message"]["usage"];
            if let Some(inp) = u["input_tokens"].as_u64() {
                self.input = Some(inp);
            }
            if let Some(out) = u["output_tokens"].as_u64() {
                self.output = Some(out);
            }
            if let Some(cr) = u["cache_read_input_tokens"].as_u64() {
                self.cache_read = Some(cr);
            }
            if let Some(cw) = u["cache_creation_input_tokens"].as_u64() {
                self.cache_write = Some(cw);
            }
            return;
        }
        if kind == "message_delta" {
            let u = &val["usage"];
            if let Some(inp) = u["input_tokens"].as_u64() {
                self.input = Some(inp);
            }
            if let Some(out) = u["output_tokens"].as_u64() {
                self.output = Some(out);
            }
            if let Some(cr) = u["cache_read_input_tokens"].as_u64() {
                self.cache_read = Some(cr);
            }
            if let Some(cw) = u["cache_creation_input_tokens"].as_u64() {
                self.cache_write = Some(cw);
            }
            return;
        }
        if val["usageMetadata"].is_object() {
            let u = &val["usageMetadata"];
            let cached = u["cachedContentTokenCount"].as_u64().unwrap_or(0);
            if let Some(prompt) = u["promptTokenCount"].as_u64() {
                self.input = Some(prompt.saturating_sub(cached));
                if cached > 0 {
                    self.cache_read = Some(cached);
                }
            }
            let cand = u["candidatesTokenCount"].as_u64();
            let thoughts = u["thoughtsTokenCount"].as_u64().unwrap_or(0);
            if cand.is_some() || thoughts > 0 {
                self.output = Some(cand.unwrap_or(0).saturating_add(thoughts));
            }
            if thoughts > 0 {
                self.reasoning = Some(thoughts);
            }
            if let Some(total) = u["totalTokenCount"].as_u64() {
                self.total_tokens = Some(total);
            }
            return;
        }
        let resp_u = if val["response"]["usage"].is_object() {
            &val["response"]["usage"]
        } else {
            &val["usage"]
        };
        if resp_u.is_object() {
            if let Some(prompt) = resp_u["prompt_tokens"].as_u64() {
                let cached = resp_u["prompt_tokens_details"]["cached_tokens"]
                    .as_u64()
                    .or_else(|| resp_u["cached_tokens"].as_u64())
                    .unwrap_or(0);
                self.input = Some(prompt.saturating_sub(cached));
                if cached > 0 {
                    self.cache_read = Some(cached);
                }
                if let Some(comp) = resp_u["completion_tokens"].as_u64() {
                    self.output = Some(comp);
                }
                if let Some(r) = resp_u["completion_tokens_details"]["reasoning_tokens"].as_u64() {
                    self.reasoning = Some(r);
                }
                if let Some(t) = resp_u["total_tokens"].as_u64() {
                    self.total_tokens = Some(t);
                }
            } else if let Some(inp) = resp_u["input_tokens"].as_u64() {
                let cached = resp_u["input_tokens_details"]["cached_tokens"]
                    .as_u64()
                    .unwrap_or(0);
                self.input = Some(inp.saturating_sub(cached));
                if cached > 0 {
                    self.cache_read = Some(cached);
                }
                if let Some(out) = resp_u["output_tokens"].as_u64() {
                    self.output = Some(out);
                }
                if let Some(r) = resp_u["output_tokens_details"]["reasoning_tokens"].as_u64() {
                    self.reasoning = Some(r);
                }
                if let Some(t) = resp_u["total_tokens"].as_u64() {
                    self.total_tokens = Some(t);
                }
            }
        }
    }

    fn to_usage(&self) -> Option<Value> {
        if self.input.is_none()
            && self.output.is_none()
            && self.cache_read.is_none()
            && self.cache_write.is_none()
        {
            return None;
        }
        let mut out = json!({
            "input": self.input.unwrap_or(0),
            "output": self.output.unwrap_or(0),
        });
        if let Some(cr) = self.cache_read {
            out["cacheRead"] = cr.into();
        }
        if let Some(cw) = self.cache_write {
            out["cacheWrite"] = cw.into();
        }
        if let Some(r) = self.reasoning {
            out["reasoning"] = r.into();
        }
        if let Some(t) = self.total_tokens {
            out["totalTokens"] = t.into();
        }
        Some(out)
    }
}

#[derive(Default, Clone)]
struct RequestMeta {
    http_status: Option<u16>,
    partial_usage: Option<Value>,
}

struct Stream {
    cancel: CancellationToken,
    response: Mutex<Option<Arc<ModelHttpResponse>>>,
    reading: Arc<tokio::sync::Semaphore>,
    auth_epoch: AtomicU64,
    last_auth_ms: AtomicI64,
    tracker: Mutex<SseUsageTracker>,
}
impl Drop for Stream {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
struct State {
    gateway: StoryToolGateway,
    permit: TaskPermit,
    config: Value,
    host: ModelHttpHost,
    cancel: CancellationToken,
    streams: Mutex<HashMap<String, Arc<Stream>>>,
    meta: Mutex<HashMap<String, RequestMeta>>,
    child:Option<crate::pi_children::ChildAuthority>,
}
#[derive(Clone)]
pub(crate) struct ModelHttpController(Arc<State>);
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn request_id(args: &Value) -> Result<&str> {
    args["requestId"]
        .as_str()
        .filter(|id| {
            id.starts_with("model-")
                && id.len() <= 128
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        .ok_or_else(|| invalid("模型传输标识无效"))
}

fn extract_gemini_url_model(url: &str) -> Option<String> {
    let (_, after) = url.rsplit_once("/models/")?;
    let (model, _) = after.split_once(':')?;
    let trimmed = model.trim();
    (!trimmed.is_empty() && trimmed != "{model}").then(|| trimmed.to_owned())
}

fn extract_payload_model(args: &Value, url: &str, protocol: &str) -> Option<String> {
    if let Some(m) = args["model"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(m.to_owned());
    }
    if let Some(encoded) = args["body"].as_str() {
        if let Ok(bytes) = STANDARD.decode(encoded) {
            if let Ok(doc) = serde_json::from_slice::<Value>(&bytes) {
                if let Some(m) = doc["model"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    return Some(m.to_owned());
                }
            }
        }
    }
    if protocol == "gemini" {
        return extract_gemini_url_model(url);
    }
    None
}

fn has_token_counts(usage: &Value) -> bool {
    usage["input"].as_u64().is_some()
        || usage["output"].as_u64().is_some()
        || usage["cacheRead"].as_u64().is_some()
        || usage["cacheWrite"].as_u64().is_some()
}

fn normalized_tokens(usage: &Value) -> Value {
    let mut out = usage.clone();
    if !out.is_object() {
        out = json!({});
    }
    if out["input"].as_u64().is_none() {
        out["input"] = 0_u64.into();
    }
    if out["output"].as_u64().is_none() {
        out["output"] = 0_u64.into();
    }
    out
}

impl ModelHttpController {
    pub(crate) fn new(
        gateway: StoryToolGateway,
        permit: TaskPermit,
        model: Value,
        reference: Value,
        host: ModelHttpHost,
        cancel: CancellationToken,
    ) -> Self {
        Self(Arc::new(State {
            gateway,
            permit,
            config: json!({"resolved":model,"reference":reference}),
            host,
            cancel,
            streams: Mutex::new(HashMap::new()),
            meta: Mutex::new(HashMap::new()),
            child:None,
        }))
    }
    pub(crate) fn child(&self,child:crate::pi_children::ChildAuthority,cancel:CancellationToken)->Self {
        Self(Arc::new(State{gateway:self.0.gateway.clone(),permit:self.0.permit.clone(),config:self.0.config.clone(),host:self.0.host.clone(),cancel,streams:Mutex::new(HashMap::new()),meta:Mutex::new(HashMap::new()),child:Some(child)}))
    }
    fn is_user_stop(&self) -> bool {
        let Ok(db) = self.0.gateway.0 .0.lock() else {
            return false;
        };
        db.query_row(
            "SELECT stop_revision, json_extract(metadata_json, '$.stopReceipt.source') FROM pi_tasks WHERE id=?",
            [&self.0.permit.task_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .ok()
        .flatten()
        .is_some_and(|(rev, src)| rev > 0 && src.as_deref() != Some("system_timeout"))
    }
    fn resolve_final_usage(
        &self,
        id: &str,
        supplied: Option<&Value>,
        supplied_status: Option<&str>,
        aborted_hint: bool,
    ) -> Option<(Value, &'static str)> {
        let meta = self
            .0
            .meta
            .lock()
            .ok()
            .and_then(|m| m.get(id).cloned())
            .unwrap_or_default();
        let user_cancelled =
            supplied_status == Some("cancelled") || aborted_hint || self.is_user_stop();
        if let Some(u) = supplied.filter(|u| has_token_counts(u)) {
            let st = match supplied_status {
                Some("success") => "success",
                Some("cancelled") => "cancelled",
                _ if user_cancelled => "cancelled",
                _ => "failed",
            };
            return Some((normalized_tokens(u), st));
        }
        if let Some(partial) = meta.partial_usage {
            let st = if user_cancelled { "cancelled" } else { "failed" };
            return Some((partial, st));
        }
        if let Some(code) = meta.http_status.filter(|c| *c >= 400) {
            return Some((
                json!({"input": 0_u64, "output": 0_u64, "totalTokens": 0_u64, "httpStatus": code}),
                "failed",
            ));
        }
        None
    }
    pub(crate) async fn invoke(
        &self,
        action: &str,
        args: &Value,
        rpc_cancel: CancellationToken,
    ) -> Result<Value> {
        let id = request_id(args)?.to_owned();
        match action {
            "start" => self.start(&id, args, rpc_cancel).await,
            "read" => self.read(&id, rpc_cancel).await,
            "cancel" => self.cancel(
                &id,
                args["reason"] == "consumer",
                args["reason"] == "aborted" || args["userCancelled"] == true,
            ),
            "usage" => {
                let task = &self.0.permit.task_id;
                let status: Option<String> = self
                    .0
                    .gateway
                    .0
                     .0
                    .lock()?
                    .query_row(
                        "SELECT status FROM pi_model_requests WHERE task_id=? AND request_id=?",
                        rusqlite::params![task, id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let raw_status = args["status"].as_str().unwrap_or("failed");
                let aborted_hint =
                    raw_status == "cancelled" || args["stopReason"] == "aborted";
                if let Some((resolved_usage, resolved_status)) =
                    self.resolve_final_usage(&id, Some(&args["usage"]), Some(raw_status), aborted_hint)
                {
                    return self.0.gateway.finish_model_context(
                        &self.0.permit,
                        &id,
                        &resolved_usage,
                        resolved_status,
                        args["accepted"] == true && resolved_status == "success",
                    );
                }
                if status.as_deref() == Some("unknown") {
                    return self.0.gateway.model_budget(&self.0.permit);
                }
                let fallback_status = match raw_status {
                    "success" => "success",
                    "cancelled" => "cancelled",
                    "unknown" => "unknown",
                    _ if aborted_hint && self.is_user_stop() => "cancelled",
                    _ => "failed",
                };
                self.0.gateway.finish_model_context(
                    &self.0.permit,
                    &id,
                    &args["usage"],
                    fallback_status,
                    args["accepted"] == true,
                )
            }
            _ => Err(invalid("未知模型传输控制")),
        }
    }
    async fn start(&self, id: &str, args: &Value, rpc_cancel: CancellationToken) -> Result<Value> {
        if self.0.cancel.is_cancelled() || rpc_cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if args["method"] != "POST"
            || !args["url"].as_str().is_some_and(|s| s.len() <= 8192)
            || !args["body"]
                .as_str()
                .is_some_and(|s| s.len() <= 7 * 1024 * 1024)
            || !args["headers"].as_array().is_some_and(|v| v.len() <= 64)
        {
            return Err(invalid("模型请求格式或大小无效"));
        }
        let stream = Arc::new(Stream {
            cancel: self.0.cancel.child_token(),
            response: Mutex::new(None),
            reading: Arc::new(tokio::sync::Semaphore::new(1)),
            auth_epoch: AtomicU64::new(crate::agent_workspace::pi_auth_epoch()),
            last_auth_ms: AtomicI64::new(crate::execution_lease::now_ms()),
            tracker: Mutex::new(SseUsageTracker::default()),
        });
        {
            let mut streams = self.0.streams.lock().map_err(|_| Error::Cancelled)?;
            if streams.contains_key(id) || streams.len() >= 2 {
                return Err(invalid("模型请求已存在或根任务已有两个在途请求"));
            }
            streams.insert(id.into(), stream.clone());
        }
        let admitted = Arc::new(AtomicBool::new(false));
        let called = Arc::new(AtomicBool::new(false));
        let state = self.0.clone();
        let request = id.to_owned();
        let admitted_flag = admitted.clone();
        let protocol = state.config["resolved"]["protocol"].as_str().unwrap_or("chat-completions");
        let has_custom_endpoint = !state.config["resolved"]["endpointRef"].is_null()
            || !state.config["reference"]["endpointRef"].is_null();
        let mut host_args = args.clone();
        if protocol == "gemini" && !has_custom_endpoint {
            if let Some(raw_url) = host_args["url"].as_str() {
                host_args["url"] = normalize_gemini_native_url(raw_url).into();
            }
        }
        let purpose = if args["purpose"] == "compaction" {
            "compaction"
        } else if args["purpose"] == "progress_review" {
            "progress_review"
        } else {
            "model"
        };
        let aux_purpose = state.child.is_some() || matches!(purpose, "compaction" | "progress_review");
        let configured_aux = state.config["resolved"]["auxModel"]
            .as_str()
            .or_else(|| state.config["reference"]["auxModel"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let primary_id = state.config["resolved"]["id"]
            .as_str()
            .or_else(|| state.config["reference"]["id"].as_str())
            .or_else(|| state.config["reference"]["model"].as_str())
            .map(str::trim)
            .unwrap_or("");
        let payload_model = extract_payload_model(
            &host_args,
            host_args["url"].as_str().unwrap_or(""),
            protocol,
        );
        let effective_aux = if has_custom_endpoint {
            None
        } else if let Some(ref req_m) = payload_model {
            if req_m != primary_id && (configured_aux == Some(req_m.as_str()) || aux_purpose) {
                Some(req_m.clone())
            } else {
                None
            }
        } else if aux_purpose {
            configured_aux
                .filter(|a| *a != primary_id)
                .map(str::to_owned)
        } else {
            None
        };
        let mut model = state.config["reference"].clone();
        if !model.is_object() {
            model = json!({});
        }
        if let Some(ref aux_id) = effective_aux {
            model["id"] = aux_id.clone().into();
            model["model"] = aux_id.clone().into();
            model["cost"] = if state.config["resolved"]["auxCost"].is_object() {
                state.config["resolved"]["auxCost"].clone()
            } else {
                json!({})
            };
            model["configHash"] = arguments_hash(&json!({
                "baseUrl": state.config["resolved"]["baseUrl"],
                "protocol": state.config["resolved"]["protocol"],
                "id": aux_id,
            }))
            .into();
        } else {
            model["cost"] = state.config["resolved"]["cost"].clone();
            model["configHash"] = arguments_hash(&json!({
                "baseUrl": state.config["resolved"]["baseUrl"],
                "protocol": state.config["resolved"]["protocol"],
                "id": state.config["resolved"]["id"],
            }))
            .into();
        }
        model["requestHash"] = arguments_hash(&json!({
            "method": host_args["method"],
            "url": host_args["url"],
            "body": host_args["body"],
        }))
        .into();
        let life = stream.cancel.clone();
        let receipts=args.get("receipts").cloned().unwrap_or(Value::Null);
        let admit: ModelAdmission = Arc::new(move || {
            if life.is_cancelled() {
                return Err(Error::Cancelled);
            }
            if called.swap(true, Ordering::AcqRel) {
                return Err(invalid("同一模型请求不能重复发送"));
            }
            let result =
                state
                    .gateway
                    .reserve_model_context(&state.permit, &request, if state.child.is_some(){"subagent"}else{purpose}, &model,state.child.as_ref(),&receipts,purpose)?;
            if result["admitted"] != true {
                return Err(invalid("这项模型请求已登记，未重发HTTP"));
            }
            admitted_flag.store(true, Ordering::Release);
            Ok(result)
        });
        let mut guard = StartGuard {
            controller: self.clone(),
            id: id.into(),
            admitted: admitted.clone(),
            armed: true,
        };
        host_args["_nativePurpose"] = (if self.0.child.is_some() { "subagent" } else { purpose }).into();
        let result = tokio::select! {biased;
            _=rpc_cancel.cancelled()=>return Err(Error::Cancelled),
            _=stream.cancel.cancelled()=>return Err(Error::Cancelled),
            value=(self.0.host)(self.0.config.clone(),host_args,stream.cancel.clone(),admit)=>value
        };
        let response = result?;
        if !admitted.load(Ordering::Acquire) {
            return Err(invalid("原生模型宿主没有登记请求，未接收响应"));
        }
        stream.auth_epoch.store(crate::agent_workspace::pi_auth_epoch(), Ordering::Release);
        stream.last_auth_ms.store(crate::execution_lease::now_ms(), Ordering::Release);
        if !(200..=599).contains(&response.status) || response.headers.len() > 128 {
            return Err(invalid("原生模型响应头无效"));
        }
        if let Ok(mut meta) = self.0.meta.lock() {
            meta.entry(id.to_owned()).or_default().http_status = Some(response.status);
        }
        let reply = json!({"status":response.status,"headers":response.headers});
        *stream.response.lock().map_err(|_| Error::Cancelled)? = Some(Arc::new(response));
        guard.armed = false;
        Ok(reply)
    }
    async fn read(&self, id: &str, rpc_cancel: CancellationToken) -> Result<Value> {
        if self.0.cancel.is_cancelled() || rpc_cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let stream = self
            .0
            .streams
            .lock()
            .map_err(|_| Error::Cancelled)?
            .get(id)
            .cloned()
            .ok_or_else(|| invalid("模型响应已结束，不能重复读取"))?;
        if stream.cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        // Fast path: skip per-chunk SQLite lock while no stop/lease/child write
        // occurred and the last DB check is within 2s (R31-P3).
        let current_epoch = crate::agent_workspace::pi_auth_epoch();
        let now_ms = crate::execution_lease::now_ms();
        if current_epoch != stream.auth_epoch.load(Ordering::Acquire)
            || now_ms.saturating_sub(stream.last_auth_ms.load(Ordering::Acquire)) >= 2000
        {
            self.0.gateway.authorize_model_scoped(&self.0.permit,self.0.child.as_ref())?;
            stream.auth_epoch.store(crate::agent_workspace::pi_auth_epoch(), Ordering::Release);
            stream.last_auth_ms.store(now_ms, Ordering::Release);
        }
        let _reading = stream
            .reading
            .clone()
            .try_acquire_owned()
            .map_err(|_| invalid("同一模型响应不能并发拉取"))?;
        let response = stream
            .response
            .lock()
            .map_err(|_| Error::Cancelled)?
            .clone()
            .ok_or_else(|| invalid("模型响应尚未就绪"))?;
        let next = tokio::select! {biased;_=rpc_cancel.cancelled()=>Err(Error::Cancelled),_=stream.cancel.cancelled()=>Err(Error::Cancelled),value=response.body.next(stream.cancel.clone())=>value};
        match next {
            Ok(Some(chunk)) if !chunk.is_empty() && chunk.len() <= MAX_MODEL_CHUNK => {
                if let Ok(mut tracker) = stream.tracker.lock() {
                    tracker.feed(&chunk);
                    if let Some(partial) = tracker.to_usage() {
                        if let Ok(mut meta) = self.0.meta.lock() {
                            meta.entry(id.to_owned()).or_default().partial_usage = Some(partial);
                        }
                    }
                }
                Ok(json!({"done":false,"chunk":STANDARD.encode(chunk)}))
            }
            Ok(None) => {
                if let Ok(mut tracker) = stream.tracker.lock() {
                    tracker.flush_tail();
                    if let Some(partial) = tracker.to_usage() {
                        if let Ok(mut meta) = self.0.meta.lock() {
                            meta.entry(id.to_owned()).or_default().partial_usage = Some(partial);
                        }
                    }
                }
                self.0
                    .streams
                    .lock()
                    .map_err(|_| Error::Cancelled)?
                    .remove(id);
                self.0
                    .gateway
                    .model_transport_complete(&self.0.permit, id)?;
                Ok(json!({"done":true}))
            }
            outcome => {
                let _ = self.cancel(id, false, false);
                outcome.and_then(|_| Err(invalid("模型响应块大小无效")))
            }
        }
    }
    fn cancel(&self, id: &str, consumer: bool, aborted_hint: bool) -> Result<Value> {
        if let Some(stream) = self
            .0
            .streams
            .lock()
            .map_err(|_| Error::Cancelled)?
            .remove(id)
        {
            stream.cancel.cancel();
            if let Ok(mut tracker) = stream.tracker.lock() {
                tracker.flush_tail();
                if let Some(partial) = tracker.to_usage() {
                    if let Ok(mut meta) = self.0.meta.lock() {
                        meta.entry(id.to_owned()).or_default().partial_usage = Some(partial);
                    }
                }
            }
            if consumer {
                let _ = self.0.gateway.model_transport_complete(&self.0.permit, id);
            } else if let Some((usage, status)) =
                self.resolve_final_usage(id, None, None, aborted_hint)
            {
                let _ = self
                    .0
                    .gateway
                    .finish_model_request(&self.0.permit, id, &usage, status);
            } else {
                let _ =
                    self.0
                        .gateway
                        .finish_model_request(&self.0.permit, id, &json!({}), "unknown");
            }
        }
        Ok(json!({"requestId":id,"cancelled":true}))
    }
    pub(crate) fn close(&self) {
        let streams =
            std::mem::take(&mut *self.0.streams.lock().unwrap_or_else(|p| p.into_inner()));
        for (id, stream) in streams {
            stream.cancel.cancel();
            if let Ok(mut tracker) = stream.tracker.lock() {
                tracker.flush_tail();
                if let Some(partial) = tracker.to_usage() {
                    if let Ok(mut meta) = self.0.meta.lock() {
                        meta.entry(id.clone()).or_default().partial_usage = Some(partial);
                    }
                }
            }
            if let Some((usage, status)) = self.resolve_final_usage(&id, None, None, false) {
                let _ = self
                    .0
                    .gateway
                    .finish_model_request(&self.0.permit, &id, &usage, status);
            } else {
                let _ = self
                    .0
                    .gateway
                    .finish_model_request(&self.0.permit, &id, &json!({}), "unknown");
            }
        }
    }
}
struct StartGuard {
    controller: ModelHttpController,
    id: String,
    admitted: Arc<AtomicBool>,
    armed: bool,
}
impl Drop for StartGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Some(stream) = self
                .controller
                .0
                .streams
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&self.id)
            {
                stream.cancel.cancel();
            }
            if self.admitted.load(Ordering::Acquire) {
                if let Some((usage, status)) =
                    self.controller.resolve_final_usage(&self.id, None, None, false)
                {
                    let _ = self.controller.0.gateway.finish_model_request(
                        &self.controller.0.permit,
                        &self.id,
                        &usage,
                        status,
                    );
                } else {
                    let _ = self.controller.0.gateway.finish_model_request(
                        &self.controller.0.permit,
                        &self.id,
                        &json!({}),
                        "unknown",
                    );
                }
            }
        }
    }
}
use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::atomic::AtomicUsize};
    struct Body(Mutex<VecDeque<Vec<u8>>>);
    impl ModelHttpBody for Body {
        fn next(&self, cancel: CancellationToken) -> BoxFuture<Result<Option<Vec<u8>>>> {
            let value = self.0.lock().unwrap().pop_front();
            Box::pin(async move {
                if cancel.is_cancelled() {
                    Err(Error::Cancelled)
                } else {
                    Ok(value)
                }
            })
        }
    }
    fn fixture(host: ModelHttpHost) -> (StoryToolGateway, TaskPermit, ModelHttpController) {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::migration::migrate(&mut db, None).unwrap();
        db.execute_batch("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('w','隔离','free','l','{}','test','test','test');INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n','w',0,'opening','独立正文','test');INSERT INTO states VALUES('n','{\"time\":{\"elapsedMinutes\":0}}');INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l','w','主线','n','test')").unwrap();
        let store = crate::Store(Arc::new(Mutex::new(db)));
        let gateway = StoryToolGateway::new(store);
        gateway
            .create_session(&crate::pi_store::NewSession {
                id: "s".into(),
                world_id: "w".into(),
                line_id: "l".into(),
                title: "隔离".into(),
                session_file: None,
            })
            .unwrap();
        gateway
            .start_task(
                "s",
                "t",
                "只检查模型流",
                "auto",
                false,
                json!({"id":"fixture","slot":"own-slot"}),
                json!({"limits":{"modelRequests":2}}),
            )
            .unwrap();
        let permit = gateway.permit("t").unwrap();
        let controller = ModelHttpController::new(
            gateway.clone(),
            permit.clone(),
            json!({"id":"fixture","baseUrl":"https://private.invalid/v1","protocol":"chat-completions","apiKey":"OWNED-HTTP-SECRET"}),
            json!({"id":"fixture","slot":"own-slot"}),
            host,
            CancellationToken::new(),
        );
        (gateway, permit, controller)
    }
    fn args(id: &str) -> Value {
        json!({"requestId":id,"method":"POST","url":"https://private.invalid/v1/chat/completions","headers":[["content-type","application/json"]],"body":STANDARD.encode(b"{\"opaque\":\"signature\"}")})
    }
    #[tokio::test]
    async fn pull_completion_usage_cancellation_and_replay_share_the_real_ledger() {
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        let host: ModelHttpHost = Arc::new(move |_, request, _, admit| {
            let counter = counter.clone();
            Box::pin(async move {
                assert_eq!(
                    STANDARD.decode(request["body"].as_str().unwrap()).unwrap(),
                    b"{\"opaque\":\"signature\"}"
                );
                admit()?;
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(ModelHttpResponse {
                    status: 200,
                    headers: vec![("content-type".into(), "text/event-stream".into())],
                    body: Arc::new(Body(Mutex::new(VecDeque::from([
                        b"data: fixture\n\n".to_vec()
                    ])))),
                })
            })
        });
        let (gateway, permit, controller) = fixture(host);
        let token = CancellationToken::new();
        assert_eq!(
            controller
                .invoke("start", &args("model-one"), token.clone())
                .await
                .unwrap()["status"],
            200
        );
        let part = controller
            .invoke("read", &json!({"requestId":"model-one"}), token.clone())
            .await
            .unwrap();
        assert_eq!(
            STANDARD.decode(part["chunk"].as_str().unwrap()).unwrap(),
            b"data: fixture\n\n"
        );
        assert_eq!(
            controller
                .invoke("read", &json!({"requestId":"model-one"}), token.clone())
                .await
                .unwrap()["done"],
            true
        );
        let budget = gateway.model_budget(&permit).unwrap();
        assert_eq!(budget["runningRequests"], 0);
        assert_eq!(budget["unknownRequests"], 1);
        assert_eq!(budget["usageKnown"], false);
        assert!(controller
            .invoke("start", &args("model-one"), token.clone())
            .await
            .is_err());
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let budget=controller.invoke("usage",&json!({"requestId":"model-one","status":"success","usage":{"input":7,"output":3,"raw":"OWNED-HTTP-SECRET"}}),token.clone()).await.unwrap();
        assert_eq!(budget["modelRequests"], 1);
        assert_eq!(budget["usageKnown"], true);
        controller
            .invoke("start", &args("model-two"), token.clone())
            .await
            .unwrap();
        controller
            .invoke(
                "cancel",
                &json!({"requestId":"model-two","reason":"aborted"}),
                token.clone(),
            )
            .await
            .unwrap();
        let after = controller
            .invoke(
                "usage",
                &json!({"requestId":"model-two","status":"failed","usage":{}}),
                token.clone(),
            )
            .await
            .unwrap();
        assert_eq!(after["unknownRequests"], 1);
        assert!(controller
            .invoke("start", &args("model-three"), token)
            .await
            .is_err());
        assert_eq!(count.load(Ordering::SeqCst), 2);
        let raw: String = gateway
            .0
             .0
            .lock()
            .unwrap()
            .query_row(
                "SELECT group_concat(model_json||COALESCE(usage_json,'')) FROM pi_model_requests",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!raw.contains("OWNED-HTTP-SECRET") && !raw.contains("private.invalid"));
        controller.close();
    }
    #[tokio::test]
    async fn a_native_host_without_admission_cannot_return_a_response() {
        let host: ModelHttpHost = Arc::new(|_, _, _, _| {
            Box::pin(async {
                Ok(ModelHttpResponse {
                    status: 200,
                    headers: vec![],
                    body: Arc::new(Body(Mutex::new(VecDeque::new()))),
                })
            })
        });
        let (gateway, permit, controller) = fixture(host);
        assert!(controller
            .invoke("start", &args("model-unadmitted"), CancellationToken::new())
            .await
            .is_err());
        assert_eq!(gateway.model_budget(&permit).unwrap()["modelRequests"], 0);
        assert!(controller.0.streams.lock().unwrap().is_empty());
    }
    #[test]
    fn gemini_openai_urls_strip_openai_suffix_cleanly() {
        assert_eq!(
            strip_gemini_openai_base("https://generativelanguage.googleapis.com/v1beta/openai/"),
            "https://generativelanguage.googleapis.com/v1beta"
        );
        assert_eq!(
            normalize_gemini_native_url("https://generativelanguage.googleapis.com/v1beta/openai/models/gemini-2.5-flash:streamGenerateContent?alt=sse"),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            normalize_gemini_native_url("https://proxy.example.com/google/v1beta/openai/models/{model}:generateContent"),
            "https://proxy.example.com/google/v1beta/models/{model}:generateContent"
        );
    }
    #[tokio::test]
    async fn partial_sse_tokens_zero_token_http_errors_and_aux_model_billing_are_preserved() {
        let seen_urls = Arc::new(Mutex::new(Vec::<String>::new()));
        let urls_copy = seen_urls.clone();
        let step = Arc::new(AtomicUsize::new(0));
        let step_copy = step.clone();
        let host: ModelHttpHost = Arc::new(move |_, req, _, admit| {
            let urls_copy = urls_copy.clone();
            let idx = step_copy.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                urls_copy.lock().unwrap().push(req["url"].as_str().unwrap_or("").to_owned());
                admit()?;
                if idx == 0 {
                    // HTTP 429 retry before any token generation
                    Ok(ModelHttpResponse {
                        status: 429,
                        headers: vec![("content-type".into(), "application/json".into())],
                        body: Arc::new(Body(Mutex::new(VecDeque::from([
                            b"{\"error\":\"rate_limited\"}".to_vec(),
                        ])))),
                    })
                } else {
                    // Partial Anthropic SSE stream with usage in message_start, then user cancels
                    Ok(ModelHttpResponse {
                        status: 200,
                        headers: vec![("content-type".into(), "text/event-stream".into())],
                        body: Arc::new(Body(Mutex::new(VecDeque::from([
                            b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":320,\"output_tokens\":14,\"cache_read_input_tokens\":80}}}\n\n".to_vec(),
                        ])))),
                    })
                }
            })
        });
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::migration::migrate(&mut db, None).unwrap();
        db.execute_batch("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('w','隔离','free','l','{}','test','test','test');INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n','w',0,'opening','独立正文','test');INSERT INTO states VALUES('n','{\"time\":{\"elapsedMinutes\":0}}');INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l','w','主线','n','test')").unwrap();
        let store = crate::Store(Arc::new(Mutex::new(db)));
        let gateway = StoryToolGateway::new(store.clone());
        gateway
            .create_session(&crate::pi_store::NewSession {
                id: "s".into(),
                world_id: "w".into(),
                line_id: "l".into(),
                title: "计费".into(),
                session_file: None,
            })
            .unwrap();
        gateway
            .start_task(
                "s",
                "t",
                "检查计费",
                "auto",
                false,
                json!({"id":"gemini-2.5-pro","auxModel":"gemini-2.5-flash","slot":"own-slot"}),
                json!({"limits":{"modelRequests":4}}),
            )
            .unwrap();
        let permit = gateway.permit("t").unwrap();
        let controller = ModelHttpController::new(
            gateway.clone(),
            permit.clone(),
            json!({
                "id":"gemini-2.5-pro",
                "auxModel":"gemini-2.5-flash",
                "baseUrl":"https://generativelanguage.googleapis.com/v1beta/openai",
                "protocol":"gemini",
                "apiKey":"SECRET",
                "cost":{"input":2.0,"output":10.0,"currency":"USD"},
                "auxCost":{"input":0.2,"output":1.0,"currency":"USD"}
            }),
            json!({"id":"gemini-2.5-pro","auxModel":"gemini-2.5-flash","slot":"own-slot"}),
            host,
            CancellationToken::new(),
        );
        let token = CancellationToken::new();
        // 1) Aux compaction call against Gemini /v1beta/openai URL returning HTTP 429 (0 tokens)
        let aux_req = json!({
            "requestId":"model-aux1",
            "purpose":"compaction",
            "method":"POST",
            "url":"https://generativelanguage.googleapis.com/v1beta/openai/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
            "headers":[["content-type","application/json"]],
            "body":STANDARD.encode(b"{\"contents\":[]}")
        });
        assert_eq!(controller.invoke("start", &aux_req, token.clone()).await.unwrap()["status"], 429);
        assert_eq!(
            seen_urls.lock().unwrap()[0],
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
        );
        let after_429 = controller
            .invoke("usage", &json!({"requestId":"model-aux1","status":"failed","usage":{}}), token.clone())
            .await
            .unwrap();
        assert_eq!(after_429["priceKnown"], true);
        assert_eq!(after_429["unknownRequests"], 0);
        let billed_model: String = store
            .lock()
            .unwrap()
            .query_row("SELECT json_extract(model_json,'$.id') FROM pi_model_requests WHERE request_id='model-aux1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(billed_model, "gemini-2.5-flash");

        // 2) Main call streams partial tokens then aborts
        let main_req = json!({
            "requestId":"model-main1",
            "method":"POST",
            "url":"https://generativelanguage.googleapis.com/v1beta/openai/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
            "headers":[["content-type","application/json"]],
            "body":STANDARD.encode(b"{\"contents\":[]}")
        });
        controller.invoke("start", &main_req, token.clone()).await.unwrap();
        controller.invoke("read", &json!({"requestId":"model-main1"}), token.clone()).await.unwrap();
        controller
            .invoke("cancel", &json!({"requestId":"model-main1","reason":"aborted","userCancelled":true}), token.clone())
            .await
            .unwrap();
        let final_budget = controller
            .invoke("usage", &json!({"requestId":"model-main1","status":"cancelled","usage":{}}), token)
            .await
            .unwrap();
        assert_eq!(final_budget["usage"]["input"], 320);
        assert_eq!(final_budget["usage"]["output"], 14);
        assert_eq!(final_budget["usage"]["cacheRead"], 80);
        assert_eq!(final_budget["unknownRequests"], 0);
        assert_eq!(final_budget["usageKnown"], true);
        assert_eq!(final_budget["priceKnown"], true);
    }
}
