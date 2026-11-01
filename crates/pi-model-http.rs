//! Raw model HTTP only. Pi owns provider JSON, opaque signatures and SSE.
//! Client builders come from each host's existing system TLS/proxy settings;
//! this layer always disables redirect/retry and never logs request material.
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header, ClientBuilder, Url};
use serde_json::Value;
use std::{sync::Arc, time::{Duration,Instant}};
use story_core::{
    chat::BoxFuture,
    pi_http::{ModelHttpBody, ModelHttpHost, ModelHttpResponse, MAX_MODEL_CHUNK},
    pi_service::ModelResolver,
    Error, Result,
};
use tokio_util::sync::CancellationToken;

pub type ClientFactory = Arc<dyn Fn() -> Result<ClientBuilder> + Send + Sync>;
fn invalid() -> Error {
    Error::Invalid("模型连接未完成，请检查所选服务、凭据和网络设置".into())
}
fn endpoint(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url)
}
fn decoded_path(value: &str) -> Result<String> {
    let mut value = value.as_bytes().to_vec();
    for step in 0..8 {
        let mut next = Vec::with_capacity(value.len());
        let mut at = 0;
        let mut changed = false;
        while at < value.len() {
            if value[at] == b'%' {
                if at + 2 >= value.len() {
                    return Err(invalid());
                }
                let digit = |v: u8| match v {
                    b'0'..=b'9' => Some(v - b'0'),
                    b'a'..=b'f' => Some(v - b'a' + 10),
                    b'A'..=b'F' => Some(v - b'A' + 10),
                    _ => None,
                };
                let a = digit(value[at + 1]).ok_or_else(invalid)?;
                let b = digit(value[at + 2]).ok_or_else(invalid)?;
                next.push(a * 16 + b);
                at += 3;
                changed = true;
            } else {
                next.push(value[at]);
                at += 1;
            }
        }
        value = next;
        if !changed {
            break;
        }
        if step == 7 {
            return Err(invalid());
        }
    }
    let value = String::from_utf8(value).map_err(|_| invalid())?;
    if value
        .chars()
        .any(|c| c.is_control() || matches!(c, '?' | '#' | '\\'))
    {
        return Err(invalid());
    }
    let parsed = Url::parse(&format!("https://bound.invalid{value}")).map_err(|_| invalid())?;
    if parsed.origin() != Url::parse("https://bound.invalid").unwrap().origin() {
        return Err(invalid());
    }
    Ok(parsed.path().trim_end_matches('/').into())
}
fn full_endpoint(model: &Value) -> Result<bool> {
    match model.get("endpointRef") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::String(id))
            if id.len() == 64
                && id
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) =>
        {
            Ok(true)
        }
        _ => Err(invalid()),
    }
}
fn full_endpoint_query(model: &Value, url: &Url) -> Result<()> {
    let protocol = model["protocol"].as_str().unwrap_or("chat-completions");
    if !matches!(
        protocol,
        "chat-completions" | "openai-responses" | "anthropic" | "gemini"
    ) {
        return Err(invalid());
    }
    for (name, value) in url.query_pairs() {
        if !(protocol == "gemini" && name == "alt" && value == "sse")
            && !(protocol == "anthropic" && name == "beta" && value == "true")
        {
            return Err(invalid());
        }
    }
    Ok(())
}
fn verify_gemini_model_proof(model: &Value, request: &Value) -> Result<()> {
    if model["protocol"] != "gemini" || !full_endpoint(model)? {
        return Ok(());
    }
    let mut proofs = request["headers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|pair| {
            pair[0]
                .as_str()
                .is_some_and(|name| name.eq_ignore_ascii_case("x-lishi-pi-model"))
        });
    let proof = proofs
        .next()
        .and_then(|pair| pair[1].as_str())
        .filter(|value| value.len() <= 2048)
        .ok_or_else(invalid)?;
    if proofs.next().is_some() {
        return Err(invalid());
    }
    let decoded = STANDARD.decode(proof).map_err(|_| invalid())?;
    if model["id"]
        .as_str()
        .is_none_or(|id| decoded != id.as_bytes())
    {
        return Err(invalid());
    }
    Ok(())
}
fn authorize_url(model: &Value, raw: &str) -> Result<Url> {
    let base = endpoint(model["baseUrl"].as_str().ok_or_else(invalid)?)?;
    let url = endpoint(raw)?;
    if base.query().is_some()
        || url.origin() != base.origin()
        || url
            .query_pairs()
            .any(|(key, _)| matches!(key.as_ref(), "key" | "api_key" | "apikey" | "access_token"))
    {
        return Err(invalid());
    }
    let prefix = decoded_path(base.path())?;
    let path = decoded_path(url.path())?;
    if full_endpoint(model)? {
        // The fresh resolver has already checked this immutable grant against
        // its saved profile and native secret binding. Only that exact path is
        // a generation endpoint; no descendants/count_tokens are authorized.
        if url.path() != base.path() || path != prefix {
            return Err(invalid());
        }
        full_endpoint_query(model, &url)?;
        return Ok(url);
    }
    if !(path == prefix || path.starts_with(&format!("{prefix}/"))) {
        return Err(invalid());
    }
    let matches = match model["protocol"].as_str().unwrap_or("chat-completions") {
        "chat-completions" => {
            path == if prefix.ends_with("/chat/completions") {
                prefix.clone()
            } else {
                format!("{prefix}/chat/completions")
            }
        }
        "openai-responses" => {
            path == if prefix.ends_with("/responses") {
                prefix.clone()
            } else {
                format!("{prefix}/responses")
            }
        }
        "anthropic" => {
            path == if prefix.ends_with("/messages") {
                prefix.clone()
            } else if prefix.is_empty() {
                "/v1/messages".into()
            } else {
                format!("{prefix}/messages")
            }
        }
        "gemini" => {
            let id = model["id"]
                .as_str()
                .ok_or_else(invalid)?
                .trim_start_matches("models/");
            let expected = decoded_path(&format!("{prefix}/models/{id}"))?;
            path == format!("{expected}:streamGenerateContent")
                || path == format!("{expected}:generateContent")
        }
        _ => false,
    };
    if !matches {
        return Err(invalid());
    }
    Ok(url)
}
fn request_headers(request: &Value) -> Result<header::HeaderMap> {
    let mut result = header::HeaderMap::new();
    for pair in request["headers"].as_array().ok_or_else(invalid)? {
        let name = pair[0].as_str().ok_or_else(invalid)?.to_ascii_lowercase();
        let value = pair[1].as_str().ok_or_else(invalid)?;
        let allowed = matches!(
            name.as_str(),
            "accept"
                | "content-type"
                | "user-agent"
                | "anthropic-version"
                | "anthropic-beta"
                | "openai-organization"
                | "openai-project"
                | "openai-beta"
                | "x-goog-api-client"
        ) || name.starts_with("x-stainless-");
        if !allowed {
            continue;
        }
        if name.len() > 128 || value.len() > 8192 {
            return Err(invalid());
        }
        result.insert(
            header::HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid())?,
            header::HeaderValue::from_str(value).map_err(|_| invalid())?,
        );
    }
    Ok(result)
}

pub fn host(clients: ClientFactory, resolver: ModelResolver) -> ModelHttpHost {
    Arc::new(move |config, request, cancel, admit| {
        let clients = clients.clone();
        let resolver = resolver.clone();
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let current = resolver(&config["reference"])?;
            for key in ["baseUrl", "protocol", "id", "endpointRef"] {
                if current[key] != config["resolved"][key] {
                    return Err(invalid());
                }
            }
            let url = authorize_url(&current, request["url"].as_str().ok_or_else(invalid)?)?;
            verify_gemini_model_proof(&current, &request)?;
            let body = STANDARD
                .decode(request["body"].as_str().ok_or_else(invalid)?)
                .map_err(|_| invalid())?;
            if request["method"] != "POST" || body.len() > 5 * 1024 * 1024 {
                return Err(invalid());
            }
            let document: Value = serde_json::from_slice(&body).map_err(|_| invalid())?;
            if !document.is_object()
                || current["protocol"] != "gemini" && document["model"] != current["id"]
            {
                return Err(invalid());
            }
            let key = current["apiKey"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 8192)
                .ok_or_else(invalid)?;
            let mut headers = request_headers(&request)?;
            headers.insert(
                header::ACCEPT_ENCODING,
                header::HeaderValue::from_static("identity"),
            );
            let (name, authorization) =
                match current["protocol"].as_str().unwrap_or("chat-completions") {
                    "anthropic" => ("x-api-key", key.to_owned()),
                    "gemini" => ("x-goog-api-key", key.to_owned()),
                    _ => ("authorization", format!("Bearer {key}")),
                };
            let mut value = header::HeaderValue::from_str(&authorization).map_err(|_| invalid())?;
            value.set_sensitive(true);
            headers.insert(name, value);
            let client = (clients)()?
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(30))
                .read_timeout(Duration::from_secs(180))
                .timeout(Duration::from_secs(900))
                .build()
                .map_err(|_| invalid())?;
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            admit()?;
            let started=Instant::now();
            let response = tokio::select! {biased;_=cancel.cancelled()=>return Err(Error::Cancelled),value=tokio::time::timeout(Duration::from_secs(180),client.post(url).headers(headers).body(body).send())=>value.map_err(|_|Error::Limit("本次模型响应首字节等待超时，进度已保存，未自动重发".into()))?.map_err(|error|if error.is_timeout(){Error::Limit("本次模型连接等待超时，进度已保存，未自动重发".into())}else{invalid()})?};
            if response
                .headers()
                .get(header::CONTENT_ENCODING)
                .is_some_and(|v| !v.as_bytes().eq_ignore_ascii_case(b"identity"))
            {
                return Err(invalid());
            }
            let mut secrets = vec![key.as_bytes().to_vec()];
            if let Some(old) = config["resolved"]["apiKey"]
                .as_str()
                .filter(|s| !s.is_empty() && s.as_bytes() != key.as_bytes())
            {
                secrets.push(old.as_bytes().to_vec());
            }
            let headers = response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    if matches!(
                        name.as_str(),
                        "set-cookie"
                            | "authorization"
                            | "proxy-authorization"
                            | "proxy-authenticate"
                            | "www-authenticate"
                    ) {
                        return None;
                    }
                    let value = value.to_str().ok()?;
                    if value.len() > 8192
                        || secrets
                            .iter()
                            .any(|key| value.as_bytes().windows(key.len()).any(|v| v == key))
                    {
                        return None;
                    }
                    Some((name.as_str().to_owned(), value.to_owned()))
                })
                .take(128)
                .collect();
            Ok(ModelHttpResponse {
                status: response.status().as_u16(),
                headers,
                body: Arc::new(Body(Arc::new(tokio::sync::Mutex::new(BodyState {
                    response,
                    secrets,
                    pending: vec![],
                    output: vec![],
                    done: false,
                    received: 0,
                    started,
                })))),
            })
        })
    })
}
struct Body(Arc<tokio::sync::Mutex<BodyState>>);
struct BodyState {
    response: reqwest::Response,
    secrets: Vec<Vec<u8>>,
    pending: Vec<u8>,
    output: Vec<u8>,
    done: bool,
    received: usize,
    started: Instant,
}
impl ModelHttpBody for Body {
    fn next(&self, cancel: CancellationToken) -> BoxFuture<Result<Option<Vec<u8>>>> {
        // The trait future must own a handle. The reader state is shared only
        // through this per-response mutex and never contains a database lock.
        let shared = self.0.clone();
        let future = async move {
            let mut state = tokio::select! {biased;_=cancel.cancelled()=>return Err(Error::Cancelled),state=shared.lock()=>state};
            loop {
                if !state.output.is_empty() {
                    let count = state.output.len().min(MAX_MODEL_CHUNK);
                    return Ok(Some(state.output.drain(..count).collect()));
                }
                if state.done {
                    return Ok(None);
                }
                let remaining=Duration::from_secs(900).saturating_sub(state.started.elapsed());
                if remaining.is_zero(){return Err(Error::Limit("本次模型单请求等待超时，进度已保存，未自动重发".into()));}
                let wait=Duration::from_secs(180).min(remaining);
                let next = tokio::select! {biased;_=cancel.cancelled()=>return Err(Error::Cancelled),value=tokio::time::timeout(wait,state.response.chunk())=>value.map_err(|_|Error::Limit("本次模型流等待超时，进度已保存，未自动重发".into()))?.map_err(|error|if error.is_timeout(){Error::Limit("本次模型流等待超时，进度已保存，未自动重发".into())}else{invalid()})?};
                if let Some(next) = next {
                    state.received = state.received.saturating_add(next.len());
                    if state.received > 16 * 1024 * 1024 {
                        return Err(invalid());
                    }
                    state.pending.extend_from_slice(&next);
                } else {
                    state.done = true;
                }
                if state
                    .secrets
                    .iter()
                    .any(|key| state.pending.windows(key.len()).any(|value| value == key))
                {
                    return Err(invalid());
                }
                let retain = if state.done {
                    0
                } else {
                    state
                        .secrets
                        .iter()
                        .map(Vec::len)
                        .max()
                        .unwrap_or(1)
                        .saturating_sub(1)
                };
                let ready = state.pending.len().saturating_sub(retain);
                if ready > 0 {
                    let tail = state.pending.split_off(ready);
                    state.output = std::mem::replace(&mut state.pending, tail);
                }
            }
        };
        Box::pin(future)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn model_http_scope_matches_only_the_selected_protocol_endpoint_and_model() {
        for (protocol, base, route) in [
            (
                "chat-completions",
                "https://fixture.invalid/proxy/v1",
                "/proxy/v1/chat/completions",
            ),
            (
                "openai-responses",
                "https://fixture.invalid/proxy/v1/responses",
                "/proxy/v1/responses",
            ),
            ("anthropic", "https://fixture.invalid", "/v1/messages"),
            (
                "anthropic",
                "https://fixture.invalid/proxy/v1",
                "/proxy/v1/messages",
            ),
            (
                "gemini",
                "https://fixture.invalid/proxy/v1beta",
                "/proxy/v1beta/models/owned-model:streamGenerateContent?alt=sse",
            ),
        ] {
            let model = json!({"protocol":protocol,"baseUrl":base,"id":"owned-model"});
            assert!(
                authorize_url(&model, &format!("https://fixture.invalid{route}")).is_ok(),
                "{protocol}"
            );
            for raw in [
                "https://other.invalid/proxy/v1/chat/completions",
                "https://fixture.invalid/proxy/v1/%252e%252e/%252e%252e/private",
                "https://fixture.invalid/proxy/v1/tools",
                "https://fixture.invalid/proxy/v1/chat/completions?api_key=OWNED",
            ] {
                assert!(authorize_url(&model,raw).is_err(),"an unrelated or credential-bearing endpoint cannot inherit model authorization");
            }
        }
        let gemini = json!({"protocol":"gemini","baseUrl":"https://fixture.invalid/v1beta","id":"models/owned-model"});
        assert!(authorize_url(
            &gemini,
            "https://fixture.invalid/v1beta/models/owned-model:generateContent"
        )
        .is_ok());
        assert!(authorize_url(
            &gemini,
            "https://fixture.invalid/v1beta/models/other-model:generateContent"
        )
        .is_err());
        let headers=request_headers(&json!({"headers":[["authorization","OWNED-STALE"],["cookie","OWNED-STALE"],["content-type","application/json"],["anthropic-beta","fixture-beta"]]})).unwrap();
        assert!(headers.get("authorization").is_none() && headers.get("cookie").is_none());
        assert_eq!(headers["anthropic-beta"], "fixture-beta");
    }
    #[test]
    fn granted_custom_endpoints_accept_only_the_exact_path_and_protocol_query() {
        for protocol in [
            "chat-completions",
            "openai-responses",
            "anthropic",
            "gemini",
        ] {
            let base = "https://fixture.invalid/proxy/v1/custom_generation";
            let model = json!({"id":"owned-model","protocol":protocol,"baseUrl":base,"endpointRef":"a".repeat(64)});
            assert!(authorize_url(&model, base).is_ok());
            for bad in [
                format!("{base}/chat/completions"),
                format!("{base}/v1/messages/count_tokens"),
                format!("{base}/models/owned-model:streamGenerateContent"),
                format!("{base}/other"),
                format!("{base}?api_key=forbidden"),
                format!("{base}?key=forbidden"),
                format!("{base}?unknown=1"),
                "https://other.invalid/proxy/v1/custom_generation".into(),
                "https://fixture.invalid/proxy/v1/custom_generation%2f..%2foutside".into(),
            ] {
                assert!(
                    authorize_url(&model, &bad).is_err(),
                    "custom endpoint scope widened"
                );
            }
            assert_eq!(
                authorize_url(&model, &format!("{base}?alt=sse")).is_ok(),
                protocol == "gemini"
            );
            assert_eq!(
                authorize_url(&model, &format!("{base}?beta=true")).is_ok(),
                protocol == "anthropic"
            );
            let mut without = model.clone();
            without.as_object_mut().unwrap().remove("endpointRef");
            assert!(
                authorize_url(&without, base).is_err(),
                "ungranted custom path became an exact generation endpoint"
            );
            let mut malformed = model.clone();
            malformed["endpointRef"] = "invalid".into();
            assert!(authorize_url(&malformed, base).is_err());
        }
    }
    #[test]
    fn gemini_custom_endpoint_requires_the_checked_model_identity_and_never_forwards_the_private_proof(
    ) {
        let model = json!({"id":"models/owned-model","protocol":"gemini","baseUrl":"https://fixture.invalid/v1/custom_generation","endpointRef":"a".repeat(64)});
        let proof = STANDARD.encode("models/owned-model");
        let request =
            json!({"headers":[["X-Lishi-Pi-Model",proof],["content-type","application/json"]]});
        assert!(verify_gemini_model_proof(&model, &request).is_ok());
        assert!(verify_gemini_model_proof(&model, &json!({"headers":[]})).is_err());
        assert!(verify_gemini_model_proof(
            &model,
            &json!({"headers":[["x-lishi-pi-model",STANDARD.encode("other-model")]]})
        )
        .is_err());
        assert!(verify_gemini_model_proof(
            &model,
            &json!({"headers":[["x-lishi-pi-model",proof],["X-Lishi-Pi-Model",proof]]})
        )
        .is_err());
        assert!(verify_gemini_model_proof(
            &model,
            &json!({"headers":[["x-lishi-pi-model","not base64"]]})
        )
        .is_err());
        let headers = request_headers(&request).unwrap();
        assert!(headers.get("x-lishi-pi-model").is_none());
        assert_eq!(headers["content-type"], "application/json");
        let mut plain = model.clone();
        plain.as_object_mut().unwrap().remove("endpointRef");
        assert!(
            verify_gemini_model_proof(&plain, &json!({"headers":[]})).is_ok(),
            "legacy Gemini still carries its model in the authorized URL"
        );
    }
}
