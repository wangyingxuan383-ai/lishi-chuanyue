//! Why a generation stopped (R30, D166): one typed record per failure, kept
//! with the run and in its history, so the player is offered the right action
//! and can look up the cause without the raw text being put on screen.
use crate::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The cause, as the player's next step needs it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailKind {
    /// The connection failed or dropped.
    Network,
    /// No first word, or no new words, in time.
    Timeout,
    /// The service broke off mid-stream (D164).
    Stream,
    /// Any other HTTP error from the service.
    Http,
    /// The key is wrong or has no permission (401/403).
    Auth,
    /// Out of credit or rate-limited (402/429).
    Quota,
    /// The request is larger than the model's window.
    Context,
    /// The service declined to write this.
    Refused,
    /// The model answered with no story.
    Empty,
    /// The answer or its record was malformed or incomplete.
    Format,
    /// The original-book check did not pass.
    Review,
    /// The record could not be applied to the story.
    Settle,
    /// The story moved on while this was being written.
    Stale,
    /// Another task holds the story.
    Busy,
    /// The phone stopped background work.
    SystemStop,
    /// The app was closed or lost the story before the passage finished.
    Interrupted,
    /// The player pressed stop.
    Cancelled,
    /// The run used its allowance and paused.
    Limit,
    /// No key, or the key is bound to another address.
    Setup,
    /// The local database failed.
    Storage,
    /// The model cannot call the tools this needs.
    Unsupported,
    Other,
}

impl FailKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FailKind::Network => "network",
            FailKind::Timeout => "timeout",
            FailKind::Stream => "stream",
            FailKind::Http => "http",
            FailKind::Auth => "auth",
            FailKind::Quota => "quota",
            FailKind::Context => "context",
            FailKind::Refused => "refused",
            FailKind::Empty => "empty",
            FailKind::Format => "format",
            FailKind::Review => "review",
            FailKind::Settle => "settle",
            FailKind::Stale => "stale",
            FailKind::Busy => "busy",
            FailKind::SystemStop => "system_stop",
            FailKind::Interrupted => "interrupted",
            FailKind::Cancelled => "cancelled",
            FailKind::Limit => "limit",
            FailKind::Setup => "setup",
            FailKind::Storage => "storage",
            FailKind::Unsupported => "unsupported",
            FailKind::Other => "other",
        }
    }
    /// Failures after the model had already answered: resuming must not
    /// serve the cached answer again (that replayed the same failure with no
    /// request at all), so the failed stage is requested afresh.
    pub fn after_reply(self) -> bool {
        matches!(self, FailKind::Refused | FailKind::Empty | FailKind::Format | FailKind::Review | FailKind::Settle)
    }
}

/// Where in a passage it stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Prepare,
    Write,
    Record,
    Review,
    Settle,
    Commit,
    Maintain,
}

impl Stage {
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Prepare => "prepare",
            Stage::Write => "write",
            Stage::Record => "record",
            Stage::Review => "review",
            Stage::Settle => "settle",
            Stage::Commit => "commit",
            Stage::Maintain => "maintain",
        }
    }
    pub fn parse(text: &str) -> Option<Stage> {
        Some(match text {
            "prepare" => Stage::Prepare,
            "write" => Stage::Write,
            "record" => Stage::Record,
            "review" => Stage::Review,
            "settle" => Stage::Settle,
            "commit" => Stage::Commit,
            "maintain" => Stage::Maintain,
            _ => return None,
        })
    }
    /// The stage a model request belongs to, from its purpose.
    pub fn of_purpose(purpose: &str) -> Stage {
        if purpose.is_empty() {
            Stage::Prepare
        } else if purpose.starts_with("writing:") || purpose.starts_with("tool:") || purpose == "capability" {
            Stage::Write
        } else if purpose == "extract" {
            Stage::Record
        } else if purpose.starts_with("reference-review") || purpose.starts_with("reference-tool") {
            Stage::Review
        } else if purpose.starts_with("upkeep") || purpose.starts_with("chapter") || purpose == "codex" {
            Stage::Maintain
        } else {
            Stage::Write
        }
    }
    /// Request purposes whose saved results belong to this stage or a later one.
    pub fn owns_purpose(self, purpose: &str) -> bool {
        Stage::of_purpose(purpose).order() >= self.order()
    }
    fn order(self) -> u8 {
        match self {
            Stage::Prepare => 0,
            Stage::Write => 1,
            Stage::Record => 2,
            Stage::Review => 3,
            Stage::Settle => 4,
            Stage::Commit => 5,
            Stage::Maintain => 6,
        }
    }
}

/// The cause of an error, without guessing from its words.
pub fn kind_of(error: &Error) -> FailKind {
    match error {
        Error::Fail { kind, .. } => *kind,
        Error::Busy { .. } => FailKind::Busy,
        Error::SystemStop(_) => FailKind::SystemStop,
        Error::Cancelled => FailKind::Cancelled,
        Error::ContextWindow => FailKind::Context,
        Error::Limit(_) => FailKind::Limit,
        Error::Stale => FailKind::Stale,
        Error::Refused(_) => FailKind::Refused,
        Error::Sql(_) | Error::Json(_) => FailKind::Storage,
        Error::Provider { kind, status, .. } => match kind.as_str() {
            k if k.starts_with("timeout") => FailKind::Timeout,
            "network" => FailKind::Network,
            "stream" => FailKind::Stream,
            "no_secret" | "url_not_bound" | "secret_echo" => FailKind::Setup,
            "too_large" => FailKind::Context,
            "http" => match status {
                Some(401 | 403) => FailKind::Auth,
                Some(402 | 429) => FailKind::Quota,
                _ => FailKind::Http,
            },
            "cancelled" => FailKind::Cancelled,
            _ => FailKind::Other,
        },
        Error::Tool { .. } | Error::Invalid(_) => FailKind::Other,
    }
}

/// What the service said, made fit to show: the `message` out of a JSON error
/// body, without addresses, keys or control characters, at most 300 characters.
pub fn service_words(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(raw).ok();
    let said = parsed
        .as_ref()
        .and_then(|v| {
            v["error"]["message"].as_str()
                .or(v["error"].as_str())
                .or(v["message"].as_str())
                .or(v["detail"].as_str())
                .or(v["msg"].as_str())
        })
        .map(str::to_owned)
        .unwrap_or_else(|| raw.to_owned());
    let words = said
        .split_whitespace()
        .map(|w| if w.contains("://") || w.contains("www.") { "[链接]" } else if w.len() > 24 && w.starts_with("sk-") { "[密钥]" } else { w })
        .collect::<Vec<_>>()
        .join(" ");
    let clean: String = words.chars().filter(|c| !c.is_control()).take(300).collect();
    (!clean.is_empty()).then_some(clean)
}

/// Whether the failing attempt reached the service.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sent {
    /// The service answered (with a status, words or an error body).
    Yes,
    /// Nothing was sent this time (refused locally, or replayed).
    No,
    /// It may not have arrived (connection or first-byte failure).
    Unknown,
}

impl Sent {
    fn as_str(self) -> &'static str {
        match self {
            Sent::Yes => "yes",
            Sent::No => "no",
            Sent::Unknown => "unknown",
        }
    }
}

/// The stored record of one failure. `requests` counts the model requests of
/// this attempt only, so a retry that sent nothing shows as such.
pub fn record(error: &Error, stage: Stage, requests: u32) -> Value {
    let kind = kind_of(error);
    let (status, said, partial) = match error {
        Error::Provider { status, message, partial, .. } => (*status, service_words(message), *partial),
        Error::Refused(message) => (None, service_words(message), false),
        _ => (None, None, false),
    };
    let sent = if requests == 0 {
        Sent::No
    } else {
        match error {
            Error::Provider { status: Some(_), .. } => Sent::Yes,
            Error::Provider { partial: true, .. } => Sent::Yes,
            Error::Provider { .. } => Sent::Unknown,
            _ => Sent::Yes,
        }
    };
    let detail: String = error
        .to_string()
        .split_whitespace()
        .map(|w| if w.contains("://") { "[链接]" } else { w })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(600)
        .collect();
    let mut value = json!({
        "kind": kind.as_str(),
        "stage": stage.as_str(),
        "sent": sent.as_str(),
        "partial": partial,
        "requests": requests,
        "detail": detail,
        "at": chrono::Utc::now().to_rfc3339(),
    });
    if let Some(status) = status {
        value["status"] = status.into();
    }
    if let Some(said) = said {
        value["said"] = said.into();
    }
    if let Error::Busy { holder, until_ms } = error {
        value["holder"] = holder.clone().into();
        value["untilMs"] = (*until_ms).into();
    }
    value
}

/// Why a connection failed, in words a player can act on, from the network
/// library's error chain. The details are not secret; addresses are left out.
pub fn connection_reason(error: &(dyn std::error::Error + 'static)) -> &'static str {
    let mut chain = String::new();
    let mut next: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(e) = next {
        chain.push_str(&e.to_string().to_lowercase());
        chain.push(' ');
        next = e.source();
    }
    if chain.contains("dns") || chain.contains("resolve") || chain.contains("lookup") || chain.contains("name or service") {
        "找不到服务地址（域名解析失败）"
    } else if chain.contains("certificate") || chain.contains("tls") || chain.contains("handshake") || chain.contains("ssl") {
        "加密连接没有建立（证书或 TLS 握手失败）"
    } else if chain.contains("proxy") || chain.contains("socks") {
        "代理连接失败"
    } else if chain.contains("refused") {
        "服务拒绝了连接"
    } else if chain.contains("reset") || chain.contains("broken pipe") || chain.contains("closed") || chain.contains("eof") {
        "连接被中途断开"
    } else if chain.contains("unreachable") || chain.contains("no route") {
        "网络不通"
    } else if chain.contains("connect") {
        "连不上服务"
    } else {
        "网络请求失败"
    }
}

/// Where a retry must ask the model again, if it must (D166). A failure after
/// the model answered would only fail again on the saved answer (the "continue
/// fails every time, and the service shows no request" bug), so the failed
/// stage and every later one are requested afresh; earlier stages are reused.
/// Runs saved before 0.16.0 have only a kind: anything decided after the reply
/// is rewritten from the passage itself, so a retry always sends a request.
pub fn retry_from(failure: Option<&Value>, legacy_kind: Option<&str>) -> Option<Stage> {
    if let Some(failure) = failure {
        let stage = failure["stage"].as_str().and_then(Stage::parse).unwrap_or(Stage::Write);
        return match failure["kind"].as_str()? {
            "refused" | "empty" => Some(Stage::Write),
            // A record the writer gave inline is redone by writing again.
            "format" => Some(if stage == Stage::Record { Stage::Record } else { Stage::Write }),
            "review" => Some(if stage == Stage::Review { Stage::Review } else { Stage::Write }),
            // A record that cannot be applied would fail the same way again.
            "settle" => Some(Stage::Write),
            _ => None,
        };
    }
    match legacy_kind? {
        "refused" | "empty" | "no_record" | "config" => Some(Stage::Write),
        _ => None,
    }
}

/// The one sentence a notification gives for a stop: the same words as the
/// in-app notice (src/engine/llm/providers.ts explainFailure), never raw text.
pub fn player_line(kind: FailKind) -> &'static str {
    match kind {
        FailKind::Network => "连不上服务，请检查网络和服务地址",
        FailKind::Timeout => "服务太久没有回应，可能网络不稳或服务繁忙",
        FailKind::Stream => "服务写到一半断开了，已写出的部分保留了",
        FailKind::Http => "服务暂时出了问题，稍后再试，或换一个服务",
        FailKind::Auth => "Key 不对或没有权限，请检查 API Key",
        FailKind::Quota => "服务额度不足或请求太频繁",
        FailKind::Context => "这次要发给 AI 的内容太多",
        FailKind::Refused => "这段被服务拒绝了",
        FailKind::Empty => "AI 这次没有写出正文",
        FailKind::Format => "正文写好了，但整理记录没有成功",
        FailKind::Review => "正文写好了，但原著核对没有通过",
        FailKind::Settle => "这段的变化没能记进故事",
        FailKind::Stale => "故事在这期间有了变化，这段需要重写",
        FailKind::Busy => "这个故事还有别的任务在进行",
        FailKind::SystemStop => "手机系统停掉了后台生成，进度已保存",
        FailKind::Interrupted => "上一段在写完前被中断了，进度已保存",
        FailKind::Cancelled => "已停止，进度已保存",
        FailKind::Limit => "已先停下，进度已保存，可以接着写完",
        FailKind::Setup => "还没有配置好 AI 服务",
        FailKind::Storage => "保存时出了问题，请稍后再试",
        FailKind::Unsupported => "这个模型不支持这次需要的工具",
        FailKind::Other => "这次没有写成，进度已保存",
    }
}

/// The record for a run refused before it started: nothing was sent.
pub fn refused_at_start(error: &Error) -> Value {
    record(error, Stage::Prepare, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_come_from_the_type_not_the_words() {
        let provider = |kind: &str, status: Option<u16>| Error::Provider { kind: kind.into(), status, message: String::new(), partial: false };
        assert_eq!(kind_of(&provider("http", Some(401))), FailKind::Auth);
        assert_eq!(kind_of(&provider("http", Some(429))), FailKind::Quota);
        assert_eq!(kind_of(&provider("http", Some(500))), FailKind::Http);
        assert_eq!(kind_of(&provider("timeout_total", None)), FailKind::Timeout);
        assert_eq!(kind_of(&provider("no_secret", None)), FailKind::Setup);
        assert_eq!(kind_of(&provider("stream", None)), FailKind::Stream);
        assert_eq!(kind_of(&Error::fail(FailKind::Format, "记录不完整")), FailKind::Format);
        assert_eq!(kind_of(&Error::Busy { holder: "ask".into(), until_ms: 0 }), FailKind::Busy);
        // An Invalid that only mentions a refusal is no longer guessed to be one.
        assert_eq!(kind_of(&Error::Invalid("服务拒绝了".into())), FailKind::Other);
    }

    #[test]
    fn the_service_message_is_lifted_out_of_its_json_and_cleaned() {
        assert_eq!(service_words(r#"{"error":{"message":"Insufficient balance, see https://x.invalid/pay","type":"x"}}"#).unwrap(), "Insufficient balance, see [链接]");
        assert_eq!(service_words("upstream timeout").unwrap(), "upstream timeout");
        assert!(service_words("  ").is_none());
        assert_eq!(service_words(&"长".repeat(400)).unwrap().chars().count(), 300);
    }

    #[test]
    fn a_record_says_whether_this_attempt_reached_the_service() {
        let format = record(&Error::fail(FailKind::Format, "整理结果不完整"), Stage::Record, 0);
        assert_eq!((format["kind"].as_str(), format["stage"].as_str(), format["sent"].as_str()), (Some("format"), Some("record"), Some("no")));
        let http = record(&Error::Provider { kind: "http".into(), status: Some(500), message: r#"{"error":{"message":"overloaded"}}"#.into(), partial: false }, Stage::Write, 1);
        assert_eq!((http["sent"].as_str(), http["status"].as_u64(), http["said"].as_str()), (Some("yes"), Some(500), Some("overloaded")));
        let dropped = record(&Error::Provider { kind: "network".into(), status: None, message: String::new(), partial: false }, Stage::Write, 1);
        assert_eq!(dropped["sent"], "unknown");
    }

    #[test]
    fn a_retry_after_the_reply_asks_again_from_the_failed_stage() {
        let at = |kind: &str, stage: &str| json!({"kind":kind,"stage":stage});
        assert_eq!(retry_from(Some(&at("format", "record")), None), Some(Stage::Record));
        assert_eq!(retry_from(Some(&at("format", "write")), None), Some(Stage::Write));
        assert_eq!(retry_from(Some(&at("review", "review")), None), Some(Stage::Review));
        assert_eq!(retry_from(Some(&at("refused", "review")), None), Some(Stage::Write));
        assert_eq!(retry_from(Some(&at("settle", "settle")), None), Some(Stage::Write));
        // Nothing saved for these: the failed request itself is sent again.
        for kind in ["network", "timeout", "stream", "http", "cancelled", "limit", "interrupted", "system_stop"] {
            assert_eq!(retry_from(Some(&at(kind, "write")), None), None, "{kind}");
        }
        // Older runs.
        assert_eq!(retry_from(None, Some("no_record")), Some(Stage::Write));
        assert_eq!(retry_from(None, Some("config")), Some(Stage::Write));
        assert_eq!(retry_from(None, Some("network")), None);
        assert_eq!(retry_from(None, None), None);
    }

    #[test]
    fn stages_order_the_saved_results_a_retry_must_request_again() {
        assert!(Stage::Record.owns_purpose("extract"));
        assert!(Stage::Record.owns_purpose("reference-review-lite"));
        assert!(!Stage::Record.owns_purpose("writing:0"));
        assert!(Stage::Write.owns_purpose("writing:1"));
        assert!(Stage::Review.owns_purpose("reference-review:0:1"));
        assert!(!Stage::Review.owns_purpose("extract"));
        assert!(FailKind::Format.after_reply() && !FailKind::Network.after_reply());
    }
}
