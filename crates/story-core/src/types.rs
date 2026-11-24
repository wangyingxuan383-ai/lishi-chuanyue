use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("数据库操作失败")]
    Sql(#[from] rusqlite::Error),
    #[error("运行记录无效")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("{}", provider_message(.kind, .status, .message))]
    Provider { kind: String, status: Option<u16>, message: String, partial: bool },
    #[error("{0}")]
    Refused(String),
    #[error("AI 服务报告模型上下文窗口不足。可缩小本次正文或资料范围，或改用输入窗口更大的模型。")]
    ContextWindow,
    #[error("{message}")]
    Tool { code: &'static str, field: &'static str, message: String, next: serde_json::Value },
    #[error("故事路线或参考配置已经变化，请重新发起")]
    Stale,
    #[error("已停止，进度已保存")]
    Cancelled,
    #[error("{0}，进度已保存")]
    Limit(&'static str),
    /// A failure whose cause is known where it happens (R30, D166).
    #[error("{message}")]
    Fail { kind: crate::failure::FailKind, message: String },
    /// Another task holds the story: a passage, a look-up, the assistant.
    #[error("{}", busy_message(.holder))]
    Busy { holder: String, until_ms: i64 },
    /// The phone stopped background work; not the player's stop.
    #[error("手机系统停止了后台生成，进度已保存")]
    SystemStop(String),
}
pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn fail(kind: crate::failure::FailKind, message: impl Into<String>) -> Error {
        Error::Fail { kind, message: message.into() }
    }
}

fn busy_message(holder: &str) -> &'static str {
    match holder {
        "ask" => "“查一查”还在进行，等它结束后再写",
        "assistant" => "助手正在处理这个故事，等它结束后再写",
        "autoplay" => "连播还在进行，等它停下后再写",
        "turn" => "上一段还在生成或收尾",
        _ => "这个故事还有任务正在运行",
    }
}

fn provider_message(kind: &str, status: &Option<u16>, message: &str) -> String {
    if let Some(status) = status {
        // Only what the service said, cleaned; never a raw response body (R30).
        let said = crate::failure::service_words(message).unwrap_or_default();
        format!("AI 服务返回 {status}：{said}")
    } else if message.is_empty() {
        format!("模型请求未完成（{kind}）")
    } else {
        message.to_owned()
    }
}

/// The stored failure category (D166): read from the error's type, never
/// guessed from its words.
pub fn failure_kind(error: &Error) -> &'static str {
    crate::failure::kind_of(error).as_str()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunBudget {
    pub model_requests: u32,
    pub tool_calls: u32,
    pub corrections: u32,
    pub active_ms: u64,
}
impl Default for RunBudget {
    fn default() -> Self {
        Self {
            model_requests: 0,
            tool_calls: 0,
            corrections: 0,
            active_ms: 0,
        }
    }
}
impl RunBudget {
    pub fn request(&mut self) -> Result<()> {
        self.time()?;
        if self.model_requests >= RUN_REQUEST_LIMIT {
            return Err(Error::Limit("本次生成用到的模型请求较多，已先停下"));
        }
        self.model_requests += 1;
        Ok(())
    }
    pub fn tool(&mut self) -> Result<()> {
        self.time()?;
        if self.tool_calls >= RUN_TOOL_LIMIT {
            return Err(Error::Limit("本次生成查阅资料的次数较多，已先停下"));
        }
        self.tool_calls += 1;
        Ok(())
    }
    pub fn correction(&mut self) -> Result<()> {
        self.time()?;
        if self.corrections >= 1 {
            return Err(Error::Limit("本次已用过一次自动纠错"));
        }
        self.corrections += 1;
        Ok(())
    }
    pub fn time(&self) -> Result<()> {
        if self.active_ms >= RUN_TIME_LIMIT_MS {
            return Err(Error::Limit(RUN_TIME_LIMIT_TEXT));
        }
        Ok(())
    }
}

/// Backstop for one run (D159). Each model request already stops on its own after
/// 120 seconds without a first word or without new words, and requests and tool
/// calls are counted, so this only catches a run that is stuck some other way.
/// It used to be 5 minutes, which cut off slow services and original-book checks.
pub const RUN_TIME_LIMIT_MS: u64 = 30 * 60 * 1000;
pub const RUN_TIME_LIMIT_TEXT: &str = "本次生成超过 30 分钟仍未完成，已停止";
/// Model requests and tool calls one run may use before it pauses (D159). Writing with
/// read-only tools, completing the record and checking a bound original book share them;
/// 10 requests was often not enough for a long passage checked against the book.
/// "接着写完" on a paused run grants the same allowance again.
pub const RUN_REQUEST_LIMIT: u32 = 30;
pub const RUN_TOOL_LIMIT: u32 = 60;

#[derive(Debug, Clone)]
pub struct ModelConfig {
    pub slot: String,
    pub url: String,
    pub model: String,
    pub aux_model: Option<String>,
    pub include_usage: bool,
    pub max_tokens: Option<u32>,
    pub extra: serde_json::Map<String, Value>,
}

// Keep the existing Rust struct literal boundary while accepting the public
// top-level protocol/budget fields. These are local settings, never API extras.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigWire {
    slot: String,
    url: String,
    model: String,
    aux_model: Option<String>,
    include_usage: bool,
    max_tokens: Option<u32>,
    #[serde(default)]
    extra: serde_json::Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_window_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
}
impl<'de> Deserialize<'de> for ModelConfig {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let mut wire = ModelConfigWire::deserialize(deserializer)?;
        if let Some(protocol) = wire.protocol {
            wire.extra.insert("protocol".into(), protocol.into());
        }
        if let Some(tokens) = wire.context_window_tokens {
            wire.extra
                .insert("contextWindowTokens".into(), tokens.into());
        }
        if let Some(tokens) = wire.max_output_tokens {
            wire.extra.insert("maxOutputTokens".into(), tokens.into());
        }
        Ok(Self {
            slot: wire.slot,
            url: wire.url,
            model: wire.model,
            aux_model: wire.aux_model,
            include_usage: wire.include_usage,
            max_tokens: wire.max_tokens,
            extra: wire.extra,
        })
    }
}
impl Serialize for ModelConfig {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let mut extra = self.extra.clone();
        let protocol = extra
            .get("protocol")
            .and_then(|v| v.as_str().map(str::to_owned));
        let context_window_tokens = extra.get("contextWindowTokens").and_then(Value::as_u64);
        let max_output_tokens = extra
            .get("maxOutputTokens")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok());
        if protocol.is_some() {
            extra.remove("protocol");
        }
        if context_window_tokens.is_some() {
            extra.remove("contextWindowTokens");
        }
        if max_output_tokens.is_some() {
            extra.remove("maxOutputTokens");
        }
        ModelConfigWire {
            slot: self.slot.clone(),
            url: self.url.clone(),
            model: self.model.clone(),
            aux_model: self.aux_model.clone(),
            include_usage: self.include_usage,
            max_tokens: self.max_tokens,
            extra,
            protocol,
            context_window_tokens,
            max_output_tokens,
        }
        .serialize(serializer)
    }
}
impl ModelConfig {
    pub fn protocol(&self) -> &str {
        match self.extra.get("protocol") {
            None => "chat-completions",
            Some(value) => value.as_str().unwrap_or("invalid"),
        }
    }
    pub fn max_output_tokens(&self) -> u32 {
        self.extra
            .get("maxOutputTokens")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .or(self.max_tokens)
            .unwrap_or(8192)
    }
}

/// Prepared at entry; thereafter the entire run is independent of the WebView.
/// It contains no secret. All state changes are settled against the guarded base.
/// Serde's default unknown-field handling accepts and ignores legacy executionMode.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPlan {
    pub id: String,
    pub world_id: String,
    pub line_id: String,
    pub head_id: String,
    pub base_id: Option<String>,
    pub kind: String,
    pub model: ModelConfig,
    pub messages: Vec<Value>,
    pub extract_messages: Vec<Value>,
    pub state: Value,
    pub settings: Value,
    pub options: Value,
    pub action: Value,
    #[serde(default)]
    pub meta: Value,
    #[serde(default)]
    pub reference: Option<Value>,
    #[serde(default)]
    pub original: String,
    #[serde(default)]
    pub carried_edits: Vec<Value>,
    #[serde(default)]
    pub trailing_ids: Vec<String>,
    #[serde(default)]
    pub new_world: Option<Value>,
    /// 备用服务 (R30 step 2, D179): takes over a step the main service could
    /// not answer for a passing reason (connection, timeout, 5xx, 429).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_model: Option<ModelConfig>,
}

impl ModelConfig {
    /// The same service and model (keys and options aside).
    pub fn same_service(&self, other: &ModelConfig) -> bool {
        self.slot == other.slot && self.url == other.url && self.model == other.model
    }
}

impl RunPlan {
    /// Rewriting settles against the previous turn's state, but reads the
    /// current route's reference binding from the captured start snapshot.
    pub(crate) fn reading_source(&self) -> &Value {
        if self.meta["generationSnapshot"] == true {
            if let Some(source) = self.meta.get("sourceGuard") {
                return source;
            }
        }
        &self.state["source"]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub id: String,
    pub world_id: String,
    pub status: String,
    #[serde(default)]
    pub execution_id: Option<String>,
    #[serde(default)]
    pub stop_requested: bool,
    pub budget: RunBudget,
    pub draft: Value,
    pub result: Option<Value>,
    pub error: Option<String>,
    #[serde(default)]
    pub error_kind: Option<String>,
    /// The typed record of why it stopped (R30, D166).
    #[serde(default)]
    pub failure: Option<Value>,
    /// Earlier failed attempts of this run, oldest first; filled only once
    /// the run has stopped, so polling a live run stays light.
    #[serde(default)]
    pub failures: Vec<Value>,
    pub events: Vec<RunEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStopReceipt {
    pub execution_id: Option<String>,
    pub status: String,
    pub accepted: bool,
    pub settled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunEvent {
    pub seq: u64,
    pub event: Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_kind_comes_from_the_error_type() {
        use crate::failure::FailKind;
        for (error, expected) in [
            (Error::Cancelled, "cancelled"),
            (Error::ContextWindow, "context"),
            (Error::Limit("请求额度已用完"), "limit"),
            (Error::Stale, "stale"),
            (Error::Refused("AI 这次没有给出可用的故事".into()), "refused"),
            (Error::fail(FailKind::Format, "回合记录不完整"), "format"),
            (Error::fail(FailKind::Empty, "模型没有写出正文"), "empty"),
            (Error::Busy { holder: "ask".into(), until_ms: 0 }, "busy"),
            (Error::SystemStop("destroyed".into()), "system_stop"),
            // Words no longer decide the category.
            (Error::Invalid("AI 服务拒绝请求".into()), "other"),
            (Error::Invalid("回合记录不完整".into()), "other"),
        ] {
            assert_eq!(failure_kind(&error), expected, "{error}");
        }
        for (kind, status, expected) in [
            ("network", None, "network"),
            ("stream", None, "stream"),
            ("timeout_first", None, "timeout"),
            ("timeout_idle", None, "timeout"),
            ("timeout_total", None, "timeout"),
            ("http", Some(401), "auth"),
            ("http", Some(403), "auth"),
            ("http", Some(402), "quota"),
            ("http", Some(429), "quota"),
            ("http", Some(500), "http"),
            ("http", None, "http"),
            ("no_secret", None, "setup"),
            ("future", None, "other"),
        ] {
            for partial in [false, true] {
                let error = Error::Provider { kind: kind.into(), status, message: "拒绝 网络 超时 记录不完整".into(), partial };
                assert_eq!(failure_kind(&error), expected);
            }
        }
    }

    #[test]
    fn a_busy_story_names_what_holds_it() {
        assert!(Error::Busy { holder: "ask".into(), until_ms: 0 }.to_string().contains("查一查"));
        assert!(Error::Busy { holder: "assistant".into(), until_ms: 0 }.to_string().contains("助手"));
        assert_eq!(Error::Busy { holder: "x".into(), until_ms: 0 }.to_string(), "这个故事还有任务正在运行");
    }

    #[test]
    fn provider_display_keeps_the_service_detail_or_kind_fallback() {
        let error = |status, message: &str| Error::Provider { kind: "network".into(), status, message: message.into(), partial: false };
        assert_eq!(error(Some(503), "服务繁忙").to_string(), "AI 服务返回 503：服务繁忙");
        assert_eq!(error(None, "连接中断").to_string(), "连接中断");
        assert_eq!(error(None, "").to_string(), "模型请求未完成（network）");
    }
}
