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
    #[error("{message}")]
    Tool { code: &'static str, field: &'static str, message: String, next: serde_json::Value },
    #[error("故事路线或参考配置已经变化，请重新发起")]
    Stale,
    #[error("已停止，进度已保存")]
    Cancelled,
    #[error("{0}，进度已保存")]
    Limit(&'static str),
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionMode {
    #[default]
    Classic,
    Agent,
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
        if self.model_requests >= 10 {
            return Err(Error::Limit("本次已达到 10 次模型请求上限"));
        }
        self.model_requests += 1;
        Ok(())
    }
    pub fn tool(&mut self) -> Result<()> {
        self.time()?;
        if self.tool_calls >= 24 {
            return Err(Error::Limit("本次已达到 24 次工具调用上限"));
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
        if self.active_ms >= 300_000 {
            return Err(Error::Limit("本次运行已达到 5 分钟上限"));
        }
        Ok(())
    }
}

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
            .unwrap_or(2048)
    }
}

/// Prepared at entry; thereafter the entire run is independent of the WebView.
/// It contains no secret. All state changes are settled against the guarded base.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPlan {
    pub id: String,
    pub world_id: String,
    pub line_id: String,
    pub head_id: String,
    pub base_id: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub execution_mode: ExecutionMode,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub id: String,
    pub world_id: String,
    pub status: String,
    pub budget: RunBudget,
    pub draft: Value,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub events: Vec<RunEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunEvent {
    pub seq: u64,
    pub event: Value,
}
