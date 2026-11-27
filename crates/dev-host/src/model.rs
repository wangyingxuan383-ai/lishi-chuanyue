use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use story_core::{
    chat::{BoxFuture, Completion, Model, TextSink},
    Error, ModelConfig, Result,
};
use tokio_util::sync::CancellationToken;
#[path = "../../agent-model.rs"]
mod agent_model;
#[path = "../../agent-network.rs"]
mod agent_network;
#[path = "../../agent-documents.rs"]
mod agent_documents;

pub struct DevModel {
    pub secrets: PathBuf,
}

pub(crate) fn clean_raw_url_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > 8192
        || trimmed.chars().any(|c| c.is_control() || c == '\\')
    {
        return None;
    }
    let (_, after_scheme) = trimmed.split_once("://")?;
    let raw_path = match after_scheme.find(['/', '?', '#']) {
        None => "/",
        Some(idx) if after_scheme.as_bytes()[idx] == b'/' => {
            after_scheme[idx..].split(['?', '#']).next().unwrap_or("/")
        }
        Some(_) => "/",
    };

    let mut bytes = raw_path.as_bytes().to_vec();
    for depth in 0..8 {
        if let Ok(text) = std::str::from_utf8(&bytes) {
            if text.split('/').any(|seg| matches!(seg, "." | "..")) {
                return None;
            }
        }
        let mut decoded = Vec::with_capacity(bytes.len());
        let mut i = 0;
        let mut changed = false;
        while i < bytes.len() {
            if bytes[i] != b'%' {
                decoded.push(bytes[i]);
                i += 1;
                continue;
            }
            let hex = |v: u8| match v {
                b'0'..=b'9' => Some(v - b'0'),
                b'a'..=b'f' => Some(v - b'a' + 10),
                b'A'..=b'F' => Some(v - b'A' + 10),
                _ => None,
            };
            let hi = bytes.get(i + 1).and_then(|v| hex(*v))?;
            let lo = bytes.get(i + 2).and_then(|v| hex(*v))?;
            let value = (hi << 4) | lo;
            if matches!(value, b'.' | b'/' | b'\\' | 0x00..=0x1f | 0x7f) {
                return None;
            }
            decoded.push(value);
            i += 3;
            changed = true;
        }
        bytes = decoded;
        if !changed {
            break;
        }
        if depth == 7 {
            return None;
        }
    }
    let path = String::from_utf8(bytes).ok()?;
    if path.split('/').any(|seg| matches!(seg, "." | "..")) {
        return None;
    }
    Some(path)
}

fn path_within_prefix(base_path: &str, target_path: &str) -> bool {
    let norm_base = base_path.trim_end_matches('/');
    let norm_target = target_path.trim_end_matches('/');
    if norm_base.is_empty() {
        target_path.starts_with('/')
    } else {
        norm_target == norm_base || target_path.starts_with(&format!("{norm_base}/"))
    }
}

pub fn is_url_bound(base: &str, target: &str) -> bool {
    let base_trimmed = base.trim();
    let target_trimmed = target.trim();
    if base_trimmed.is_empty() || target_trimmed.is_empty() {
        return false;
    }
    if (!base_trimmed.starts_with("http://") && !base_trimmed.starts_with("https://"))
        || (!target_trimmed.starts_with("http://") && !target_trimmed.starts_with("https://"))
    {
        return false;
    }
    if clean_raw_url_path(base_trimmed).is_none() || clean_raw_url_path(target_trimmed).is_none() {
        return false;
    }
    let (Ok(base_url), Ok(target_url)) = (
        reqwest::Url::parse(base_trimmed),
        reqwest::Url::parse(target_trimmed),
    ) else {
        return false;
    };
    if !matches!(base_url.scheme(), "http" | "https")
        || !matches!(target_url.scheme(), "http" | "https")
        || base_url.host_str().is_none()
        || target_url.host_str().is_none()
        || !base_url.username().is_empty()
        || base_url.password().is_some()
        || base_url.query().is_some()
        || base_url.fragment().is_some()
        || !target_url.username().is_empty()
        || target_url.password().is_some()
        || target_url.fragment().is_some()
        || base_url.origin() != target_url.origin()
    {
        return false;
    }

    let base_path = base_url.path().trim_end_matches('/');
    let target_path = target_url.path();
    if path_within_prefix(base_path, target_path) {
        return true;
    }
    if let Some(gemini_native_path) = base_path
        .strip_suffix("/openai")
        .filter(|p| p.ends_with("/v1beta"))
    {
        if path_within_prefix(gemini_native_path, target_path) {
            return true;
        }
    }
    false
}

impl DevModel {
    pub fn network_counted(&self, request: Value, cancel: CancellationToken,accounting:Option<story_core::pi_accounting::NativeModelAccounting>) -> BoxFuture<Result<Value>> {
        let file = self.secrets.clone();
        Box::pin(async move {
            if request["op"].as_str().unwrap_or("").starts_with("browser_"){return Err(Error::Invalid("浏览器开发宿主未提供隔离动态页面；请用原生APP或HTTP网页读取".into()));}
            if ["list_documents","read_document","find_document","write_document"].contains(&request["op"].as_str().unwrap_or("")) {
                let data=file.parent().unwrap_or(std::path::Path::new(".")).join("dev-host");
                return tokio::task::spawn_blocking(move||agent_documents::execute(request,data,cancel)).await.map_err(|_|Error::Invalid("资料处理已中断".into()))?;
            }
            let secrets: Value = serde_json::from_slice(
                &tokio::fs::read(file)
                    .await
                    .map_err(|_| Error::Invalid("尚未配置联网能力".into()))?,
            )?;
            let authorize = std::sync::Arc::new(move |slot: &str, target: &str| {
                let entry = &secrets[slot];
                let bound = entry["boundBaseUrl"].as_str().unwrap_or("");
                if !is_url_bound(bound, target) {
                    return Err(Error::Invalid("联网能力的密钥地址与绑定不符".into()));
                }
                entry["value"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| Error::Invalid("尚未配置联网能力的密钥".into()))
            });
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(30))
                .timeout(Duration::from_secs(180))
                .build()
                .map_err(|_| Error::Invalid("无法初始化联网连接".into()))?;
            agent_network::execute_counted(client, request, authorize, cancel,accounting).await
        })
    }
}
impl Model for DevModel {
    fn network(&self,request:Value,cancel:CancellationToken)->BoxFuture<Result<Value>> {self.network_counted(request,cancel,None)}

    fn complete(
        &self,
        config: ModelConfig,
        body: Value,
        cancel: CancellationToken,
        text: TextSink,
    ) -> BoxFuture<Result<Completion>> {
        let file = self.secrets.clone();
        Box::pin(async move {
            let missing = || Error::Provider { kind: "no_secret".into(), status: None, message: "尚未配置 AI 服务".into(), partial: false };
            let secrets: Value = serde_json::from_slice(
                &tokio::fs::read(file)
                    .await
                    .map_err(|error| if error.kind() == std::io::ErrorKind::NotFound { missing() }
                        else { Error::fail(story_core::failure::FailKind::Setup, "无法读取开发台的 AI 服务配置") })?,
            ).map_err(|_| Error::fail(story_core::failure::FailKind::Setup, "开发台的 AI 服务配置无法解析"))?;
            let entry = &secrets[&config.slot];
            let key = entry["value"]
                .as_str()
                .ok_or_else(missing)?;
            let bound = entry["boundBaseUrl"].as_str().unwrap_or("");
            if !is_url_bound(bound, &config.url) {
                return Err(Error::Provider { kind: "url_not_bound".into(), status: None, message: "请求地址与密钥绑定地址不符".into(), partial: false });
            }
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(30))
                .timeout(Duration::from_millis(story_core::chat::REQUEST_BACKSTOP_MS))
                .build()
                .map_err(|_| Error::fail(story_core::failure::FailKind::Network, "无法初始化模型连接"))?;
            agent_model::complete(client, config, body, key.to_owned(), cancel, text).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_binding_rejects_dot_segments_encoded_traversal_and_prefix_escape() {
        let base = "https://relay.example.com/team-a/v1";
        assert!(is_url_bound(base, "https://relay.example.com/team-a/v1/chat/completions"));
        assert!(is_url_bound(base, "https://relay.example.com/team-a/v1?models=1"));

        for rejected in [
            "https://relay.example.com/team-a/v1/../../other",
            "https://relay.example.com/team-a/v1/../v2/chat/completions",
            "https://relay.example.com/team-a/v1/%2e%2e/other",
            "https://relay.example.com/team-a/v1/sub%2f..%2f..%2fother",
            "https://relay.example.com/team-a/v1-other/chat/completions",
            "http://relay.example.com/team-a/v1/chat/completions",
            "https://relay.example.com:8443/team-a/v1/chat/completions",
            "https://user:pass@relay.example.com/team-a/v1/chat/completions",
        ] {
            assert!(!is_url_bound(base, rejected), "should reject {rejected}");
        }
    }

    #[test]
    fn url_binding_supports_gemini_dual_paths_on_same_origin() {
        let oai = "https://generativelanguage.googleapis.com/v1beta/openai";
        assert!(is_url_bound(oai, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"));
        assert!(is_url_bound(oai, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"));
        assert!(!is_url_bound(oai, "https://generativelanguage.googleapis.com/v1alpha/models/gemini-2.5-flash:generateContent"));
        assert!(!is_url_bound(
            "https://relay.example.com/foov1beta/openai",
            "https://relay.example.com/foov1beta/models/x"
        ));

        let nat = "https://generativelanguage.googleapis.com/v1beta";
        assert!(is_url_bound(nat, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"));
        assert!(is_url_bound(nat, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"));
    }
}
