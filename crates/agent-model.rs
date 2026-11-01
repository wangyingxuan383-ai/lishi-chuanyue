//! Shared native protocol adapter. Endpoints are final configured URLs: no path
//! discovery, redirects, retries, tool execution or credentials in transcripts.
//! Wire references (2026-10-25):
//! https://developers.openai.com/api/docs/guides/migrate-to-responses
//! https://platform.claude.com/docs/en/build-with-claude/streaming
//! https://ai.google.dev/api/generate-content
use reqwest::{header, Client, Url};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use story_core::{
    chat::{self, Accumulator, Completion, TextSink},
    Error, ModelConfig, Result,
};
use tokio_util::sync::CancellationToken;

const MAX_RESPONSE: usize = 4 * 1024 * 1024;
#[derive(Clone, Copy, PartialEq)]
enum Protocol {
    Chat,
    Responses,
    Anthropic,
    Gemini,
}
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn items(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn protocol(config: &ModelConfig) -> Result<Protocol> {
    match config.protocol() {
        "chat-completions" => Ok(Protocol::Chat),
        "openai-responses" => Ok(Protocol::Responses),
        "anthropic" => Ok(Protocol::Anthropic),
        "gemini" => Ok(Protocol::Gemini),
        _ => Err(invalid("模型协议无效，请检查模型配置")),
    }
}
fn protocol_name(p: Protocol) -> &'static str {
    match p {
        Protocol::Chat => "chat-completions",
        Protocol::Responses => "openai-responses",
        Protocol::Anthropic => "anthropic",
        Protocol::Gemini => "gemini",
    }
}
fn arguments(call: &Value) -> Result<Value> {
    let args = serde_json::from_str::<Value>(text(&call["function"]["arguments"]))
        .map_err(|_| invalid("工具参数不完整，未发送请求"))?;
    if !args.is_object() {
        return Err(invalid("工具参数必须是对象"));
    }
    Ok(args)
}
fn opaque<'a>(calls: &'a [Value], p: Protocol, key: &str) -> Option<&'a Value> {
    calls
        .iter()
        .find(|c| c["providerData"]["protocol"] == protocol_name(p))
        .and_then(|c| c["providerData"].get(key))
}
fn call_ids(messages: &[Value], p: Protocol) -> BTreeMap<String, (Option<String>, String)> {
    let mut result = BTreeMap::new();
    for message in messages {
        for call in items(&message["tool_calls"]) {
            let meta = &call["providerData"];
            let id = if meta["protocol"] == protocol_name(p) {
                meta["id"].as_str().map(str::to_owned)
            } else {
                Some(text(&call["id"]).into())
            };
            result.insert(
                text(&call["id"]).into(),
                (id, text(&call["function"]["name"]).into()),
            );
        }
    }
    result
}
fn append_message(messages: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    if let Some(last) = messages.last_mut().filter(|m| m["role"] == role) {
        last["content"].as_array_mut().unwrap().extend(blocks);
    } else {
        messages.push(json!({"role":role,"content":blocks}));
    }
}
fn copy_fields(source: &Value, target: &mut Value, keys: &[&str]) {
    for key in keys {
        if let Some(value) = source.get(*key) {
            target[*key] = value.clone();
        }
    }
}
fn prepare(config: &ModelConfig, body: &Value, p: Protocol) -> Result<Value> {
    if p == Protocol::Chat {
        return Ok(chat::wire_chat_body(body.clone()));
    }
    let messages = body["messages"]
        .as_array()
        .ok_or_else(|| invalid("模型消息列表无效"))?;
    let ids = call_ids(messages, p);
    let tools: Vec<_> = items(&body["tools"])
        .iter()
        .map(|t| t.get("function").unwrap_or(t))
        .collect();
    let model = body["model"].as_str().unwrap_or(&config.model);
    let limit = body["max_tokens"]
        .as_u64()
        .unwrap_or(config.max_output_tokens() as u64);
    if limit == 0 {
        return Err(invalid("模型输出上限须大于零"));
    }
    match p {
        Protocol::Responses => {
            let mut input = vec![];
            for message in messages {
                let role = text(&message["role"]);
                let calls = items(&message["tool_calls"]);
                if role == "tool" {
                    let id = ids
                        .get(text(&message["tool_call_id"]))
                        .and_then(|v| v.0.as_deref())
                        .ok_or_else(|| invalid("工具回复缺少配对调用"))?;
                    input.push(json!({"type":"function_call_output","call_id":id,"output":text(&message["content"])}));
                } else if role == "assistant" && !calls.is_empty() {
                    if let Some(raw) = opaque(calls, p, "items").and_then(Value::as_array) {
                        input.extend(raw.iter().cloned());
                    } else {
                        if !text(&message["content"]).is_empty() {
                            input.push(json!({"role":"assistant","content":message["content"]}));
                        }
                        for call in calls {
                            arguments(call)?;
                            input.push(json!({"type":"function_call","call_id":call["id"],"name":call["function"]["name"],"arguments":call["function"]["arguments"]}));
                        }
                    }
                } else {
                    input.push(json!({"role":role,"content":text(&message["content"])}));
                }
            }
            let mut result = json!({"model":model,"input":input,"max_output_tokens":limit,"stream":true,"store":false});
            copy_fields(
                body,
                &mut result,
                &[
                    "temperature",
                    "top_p",
                    "reasoning",
                    "text",
                    "metadata",
                    "include",
                    "parallel_tool_calls",
                    "service_tier",
                    "truncation",
                ],
            );
            if !tools.is_empty() {
                result["tools"]=json!(tools.iter().map(|t|json!({"type":"function","name":t["name"],"description":t["description"].as_str().unwrap_or(""),"parameters":t["parameters"],"strict":t["strict"].as_bool().unwrap_or(false)})).collect::<Vec<_>>());
                result["tool_choice"] = "auto".into();
            }
            Ok(result)
        }
        Protocol::Anthropic => {
            let mut system = vec![];
            let mut history = vec![];
            for message in messages {
                let role = text(&message["role"]);
                let calls = items(&message["tool_calls"]);
                if role == "system" || role == "developer" {
                    system.push(json!({"type":"text","text":text(&message["content"])}));
                    continue;
                }
                let mut blocks = vec![];
                let target = if role == "tool" {
                    let id = ids
                        .get(text(&message["tool_call_id"]))
                        .and_then(|v| v.0.as_deref())
                        .ok_or_else(|| invalid("工具回复缺少配对调用"))?;
                    blocks.push(json!({"type":"tool_result","tool_use_id":id,"content":text(&message["content"])}));
                    "user"
                } else if role == "assistant" {
                    if let Some(raw) = opaque(calls, p, "content").and_then(Value::as_array) {
                        blocks.extend(raw.iter().cloned());
                    } else {
                        if !text(&message["content"]).is_empty() {
                            blocks.push(json!({"type":"text","text":message["content"]}));
                        }
                        for call in calls {
                            blocks.push(json!({"type":"tool_use","id":call["id"],"name":call["function"]["name"],"input":arguments(call)?}));
                        }
                    }
                    "assistant"
                } else {
                    blocks.push(json!({"type":"text","text":text(&message["content"])}));
                    "user"
                };
                append_message(&mut history, target, blocks);
            }
            let mut result =
                json!({"model":model,"messages":history,"max_tokens":limit,"stream":true});
            if !system.is_empty() {
                result["system"] = json!(system);
            }
            copy_fields(
                body,
                &mut result,
                &[
                    "temperature",
                    "top_p",
                    "top_k",
                    "stop_sequences",
                    "metadata",
                    "thinking",
                    "output_config",
                    "service_tier",
                ],
            );
            if !tools.is_empty() {
                result["tools"]=json!(tools.iter().map(|t|json!({"name":t["name"],"description":t["description"].as_str().unwrap_or(""),"input_schema":t["parameters"]})).collect::<Vec<_>>());
            }
            Ok(result)
        }
        Protocol::Gemini => {
            let mut system = vec![];
            let mut contents = vec![];
            for message in messages {
                let role = text(&message["role"]);
                let calls = items(&message["tool_calls"]);
                if role == "system" || role == "developer" {
                    system.push(json!({"text":text(&message["content"])}));
                    continue;
                }
                let mut parts = vec![];
                let target = if role == "tool" {
                    let (id, name) = ids
                        .get(text(&message["tool_call_id"]))
                        .ok_or_else(|| invalid("工具回复缺少配对调用"))?;
                    let response = serde_json::from_str::<Value>(text(&message["content"]))
                        .ok()
                        .filter(Value::is_object)
                        .unwrap_or_else(|| json!({"result":text(&message["content"])}));
                    let mut output = json!({"name":name,"response":response});
                    if let Some(id) = id {
                        output["id"] = id.clone().into();
                    }
                    parts.push(json!({"functionResponse":output}));
                    "user"
                } else if role == "assistant" {
                    if let Some(raw) = opaque(calls, p, "parts").and_then(Value::as_array) {
                        parts.extend(raw.iter().cloned());
                    } else {
                        if !text(&message["content"]).is_empty() {
                            parts.push(json!({"text":message["content"]}));
                        }
                        for call in calls {
                            parts.push(json!({"functionCall":{"id":call["id"],"name":call["function"]["name"],"args":arguments(call)?}}));
                        }
                    }
                    "model"
                } else {
                    parts.push(json!({"text":text(&message["content"])}));
                    "user"
                };
                if let Some(last) = contents
                    .last_mut()
                    .filter(|m: &&mut Value| m["role"] == target)
                {
                    last["parts"].as_array_mut().unwrap().extend(parts);
                } else {
                    contents.push(json!({"role":target,"parts":parts}));
                }
            }
            let generation = body
                .get("generationConfig")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let mut result = json!({"contents":contents,"generationConfig":generation});
            result["generationConfig"]["maxOutputTokens"] = limit.into();
            if let Some(t) = body.get("temperature") {
                result["generationConfig"]["temperature"] = t.clone();
            }
            if let Some(t) = body.get("top_p") {
                result["generationConfig"]["topP"] = t.clone();
            }
            if !system.is_empty() {
                result["systemInstruction"] = json!({"parts":system});
            }
            copy_fields(
                body,
                &mut result,
                &["safetySettings", "toolConfig", "cachedContent"],
            );
            if !tools.is_empty() {
                result["tools"] = json!([{"functionDeclarations":tools.iter().map(|t|json!({"name":t["name"],"description":t["description"].as_str().unwrap_or(""),"parametersJsonSchema":t["parameters"]})).collect::<Vec<_>>() }]);
            }
            Ok(result)
        }
        Protocol::Chat => unreachable!(),
    }
}

fn usage(raw: &Value, p: Protocol) -> Option<Value> {
    let mut result = raw.as_object()?.clone();
    let number = |key: &str| raw[key].as_u64().unwrap_or(0);
    let (input, output) = match p {
        Protocol::Responses => (number("input_tokens"), number("output_tokens")),
        Protocol::Anthropic => (
            number("input_tokens")
                + number("cache_creation_input_tokens")
                + number("cache_read_input_tokens"),
            number("output_tokens"),
        ),
        Protocol::Gemini => (
            number("promptTokenCount"),
            number("candidatesTokenCount") + number("thoughtsTokenCount"),
        ),
        Protocol::Chat => return Some(raw.clone()),
    };
    result.insert("prompt_tokens".into(), input.into());
    result.insert("completion_tokens".into(), output.into());
    Some(result.into())
}
fn canonical_call(
    id: &str,
    name: &str,
    args: Value,
    p: Protocol,
    provider_id: Value,
) -> Result<Value> {
    if id.is_empty() || name.is_empty() || !args.is_object() {
        return Err(invalid("模型的工具调用不完整，未执行工具"));
    }
    Ok(
        json!({"id":id,"type":"function","function":{"name":name,"arguments":args.to_string()},"providerData":{"protocol":protocol_name(p),"id":provider_id}}),
    )
}
fn completed(raw: &Value, p: Protocol) -> Result<Completion> {
    let mut result = Completion::default();
    let (blocks, reason, key) = match p {
        Protocol::Responses => {
            if raw["status"] != "completed" {
                return Err(invalid("模型响应未完整结束，未执行工具"));
            }
            (items(&raw["output"]), "stop", "items")
        }
        Protocol::Anthropic => (items(&raw["content"]), text(&raw["stop_reason"]), "content"),
        Protocol::Gemini => (
            items(&raw["candidates"][0]["content"]["parts"]),
            text(&raw["candidates"][0]["finishReason"]),
            "parts",
        ),
        Protocol::Chat => return Err(invalid("模型协议内部状态无效")),
    };
    for block in blocks {
        match p {
            Protocol::Responses => {
                if block["type"] == "function_call" {
                    if block.get("status").is_some_and(|s| s != "completed") {
                        return Err(invalid("模型工具调用尚未完成"));
                    }
                    let args = serde_json::from_str::<Value>(text(&block["arguments"]))
                        .map_err(|_| invalid("模型工具参数未完整结束"))?;
                    result.tool_calls.push(canonical_call(
                        text(&block["call_id"]),
                        text(&block["name"]),
                        args,
                        p,
                        block["call_id"].clone(),
                    )?);
                } else if block["type"] == "message" {
                    for part in items(&block["content"]) {
                        if part["type"] == "output_text" {
                            result.text.push_str(text(&part["text"]));
                        }
                    }
                }
            }
            Protocol::Anthropic => {
                if block["type"] == "text" {
                    result.text.push_str(text(&block["text"]));
                } else if block["type"] == "tool_use" {
                    result.tool_calls.push(canonical_call(
                        text(&block["id"]),
                        text(&block["name"]),
                        block["input"].clone(),
                        p,
                        block["id"].clone(),
                    )?);
                }
            }
            Protocol::Gemini => {
                if let Some(call) = block.get("functionCall") {
                    if !call.as_object().is_some_and(|o| {
                        o.keys()
                            .all(|k| ["id", "name", "args"].contains(&k.as_str()))
                    }) {
                        return Err(invalid("Gemini工具参数格式尚不支持，未执行工具"));
                    }
                    let id = call["id"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("gemini-call-{}", result.tool_calls.len()));
                    result.tool_calls.push(canonical_call(
                        &id,
                        text(&call["name"]),
                        call.get("args").cloned().unwrap_or_else(|| json!({})),
                        p,
                        call["id"].clone(),
                    )?);
                } else if block["thought"] != true {
                    result.text.push_str(text(&block["text"]));
                }
            }
            Protocol::Chat => {}
        }
    }
    if reason.is_empty()
        || p == Protocol::Gemini && !matches!(reason, "STOP" | "MAX_TOKENS")
        || p == Protocol::Anthropic
            && !matches!(
                reason,
                "end_turn" | "tool_use" | "stop_sequence" | "max_tokens"
            )
    {
        return Err(invalid("模型响应未正常结束，未执行工具"));
    }
    if !result.tool_calls.is_empty() {
        if p == Protocol::Anthropic && reason != "tool_use" {
            return Err(invalid("模型工具调用未完整结束，未执行工具"));
        }
        let ids: std::collections::BTreeSet<_> =
            result.tool_calls.iter().map(|c| text(&c["id"])).collect();
        if ids.len() != result.tool_calls.len() {
            return Err(invalid("模型返回了重复工具标识，未执行工具"));
        }
        if matches!(reason, "max_tokens" | "MAX_TOKENS") {
            return Err(invalid("工具调用被输出上限截断，未执行工具"));
        }
        result.tool_calls[0]["providerData"][key] = Value::Array(blocks.to_vec());
    }
    if result.text.is_empty() && result.tool_calls.is_empty() {
        return Err(invalid("模型没有返回正文或工具调用"));
    }
    result.finish_reason = Some(
        if !result.tool_calls.is_empty() {
            "tool_calls"
        } else if matches!(reason, "max_tokens" | "MAX_TOKENS") {
            "length"
        } else {
            "stop"
        }
        .into(),
    );
    result.usage = usage(
        if p == Protocol::Gemini {
            &raw["usageMetadata"]
        } else {
            &raw["usage"]
        },
        p,
    );
    Ok(result)
}

#[derive(Default)]
struct Block {
    value: Value,
    args: String,
    closed: bool,
}
struct Parser {
    protocol: Protocol,
    chat: Accumulator,
    result: Completion,
    final_value: Option<Value>,
    blocks: BTreeMap<u64, Block>,
    parts: Vec<Value>,
    ended: bool,
}
impl Parser {
    fn new(protocol: Protocol) -> Self {
        Self {
            protocol,
            chat: Accumulator::default(),
            result: Completion::default(),
            final_value: None,
            blocks: BTreeMap::new(),
            parts: vec![],
            ended: false,
        }
    }
    fn push(&mut self, data: &str) -> Result<bool> {
        if data == "[DONE]" {
            if self.protocol == Protocol::Chat {
                self.ended = true;
                return Ok(true);
            }
            return Ok(false);
        }
        if self.protocol == Protocol::Chat {
            self.chat.push(data);
            return Ok(false);
        }
        let value: Value = serde_json::from_str(data).map_err(|_| invalid("模型事件格式无效"))?;
        self.value(&value)
    }
    fn value(&mut self, value: &Value) -> Result<bool> {
        if value.get("error").is_some() || value["type"] == "error" {
            return Err(invalid("模型服务返回错误，未执行工具"));
        }
        match self.protocol {
            Protocol::Responses => match text(&value["type"]) {
                "response.output_text.delta" => self.result.text.push_str(text(&value["delta"])),
                "response.completed" => {
                    self.final_value = Some(value["response"].clone());
                    self.ended = true;
                }
                "response.failed" | "response.incomplete" => {
                    return Err(invalid("模型响应未完整结束，未执行工具"))
                }
                _ if value["object"] == "response" || value.get("output").is_some() => {
                    self.final_value = Some(value.clone());
                    self.ended = true;
                }
                _ => {}
            },
            Protocol::Anthropic => match text(&value["type"]) {
                "message_start" => {
                    self.result.usage = value["message"]["usage"]
                        .as_object()
                        .cloned()
                        .map(Value::Object);
                }
                "content_block_start" => {
                    let index = value["index"]
                        .as_u64()
                        .ok_or_else(|| invalid("模型内容索引无效"))?;
                    if self.blocks.contains_key(&index) {
                        return Err(invalid("模型内容索引重复"));
                    }
                    let block = value["content_block"].clone();
                    if block["type"] == "text" {
                        self.result.text.push_str(text(&block["text"]));
                    }
                    self.blocks.insert(
                        index,
                        Block {
                            value: block,
                            ..Default::default()
                        },
                    );
                }
                "content_block_delta" => {
                    let block = self
                        .blocks
                        .get_mut(&value["index"].as_u64().unwrap_or(u64::MAX))
                        .filter(|b| !b.closed)
                        .ok_or_else(|| invalid("模型内容没有配对开头"))?;
                    let delta = &value["delta"];
                    match text(&delta["type"]) {
                        "text_delta" | "thinking_delta" | "signature_delta" => {
                            let key = match text(&delta["type"]) {
                                "text_delta" => "text",
                                "thinking_delta" => "thinking",
                                _ => "signature",
                            };
                            let part = text(&delta[key]);
                            let old = text(&block.value[key]);
                            block.value[key] = format!("{old}{part}").into();
                            if key == "text" {
                                self.result.text.push_str(part);
                            }
                        }
                        "input_json_delta" => block.args.push_str(text(&delta["partial_json"])),
                        "citations_delta" => {
                            if !block.value["citations"].is_array() {
                                block.value["citations"] = json!([]);
                            }
                            block.value["citations"]
                                .as_array_mut()
                                .unwrap()
                                .push(delta["citation"].clone());
                        }
                        _ => return Err(invalid("模型返回了尚不支持的内容增量")),
                    }
                }
                "content_block_stop" => {
                    let block = self
                        .blocks
                        .get_mut(&value["index"].as_u64().unwrap_or(u64::MAX))
                        .filter(|b| !b.closed)
                        .ok_or_else(|| invalid("模型内容结束没有配对开头"))?;
                    if !block.args.is_empty() {
                        block.value["input"] = serde_json::from_str(&block.args)
                            .map_err(|_| invalid("模型工具参数未完整结束"))?;
                    }
                    block.closed = true;
                }
                "message_delta" => {
                    if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                        self.result.finish_reason = Some(reason.into());
                    }
                    if let Some(usage) = value["usage"].as_object() {
                        let target = self.result.usage.get_or_insert_with(|| json!({}));
                        for (k, v) in usage {
                            target[k] = v.clone();
                        }
                    }
                }
                "message_stop" => self.ended = true,
                "message" => {
                    self.final_value = Some(value.clone());
                    self.ended = true;
                }
                "ping" => {}
                _ => return Err(invalid("模型事件类型无法识别")),
            },
            Protocol::Gemini => {
                if let Some(array) = value.as_array() {
                    for chunk in array {
                        self.value(chunk)?;
                    }
                    return Ok(false);
                }
                let candidate = &value["candidates"][0];
                for part in items(&candidate["content"]["parts"]) {
                    if part["thought"] != true {
                        self.result.text.push_str(text(&part["text"]));
                    }
                    self.parts.push(part.clone());
                }
                if let Some(reason) = candidate["finishReason"].as_str() {
                    self.result.finish_reason = Some(reason.into());
                    self.ended = true;
                }
                if value["usageMetadata"].is_object() {
                    self.result.usage = Some(value["usageMetadata"].clone());
                }
                return Ok(false);
            }
            Protocol::Chat => unreachable!(),
        }
        Ok(self.ended)
    }
    fn current_text(&self) -> &str {
        if self.protocol == Protocol::Chat {
            &self.chat.result.text
        } else {
            &self.result.text
        }
    }
    fn finish(self, sse: bool) -> Result<Completion> {
        if self.protocol == Protocol::Chat {
            return self.chat.finish();
        }
        if sse && !self.ended {
            return Err(invalid("模型连接提前结束，未执行工具"));
        }
        if let Some(value) = self.final_value {
            return completed(&value, self.protocol);
        }
        match self.protocol {
            Protocol::Anthropic => {
                if self.blocks.values().any(|b| !b.closed) {
                    return Err(invalid("模型内容尚未完整结束"));
                }
                completed(
                    &json!({"content":self.blocks.into_values().map(|b|b.value).collect::<Vec<_>>(),"stop_reason":self.result.finish_reason,"usage":self.result.usage}),
                    self.protocol,
                )
            }
            Protocol::Gemini => completed(
                &json!({"candidates":[{"content":{"parts":self.parts},"finishReason":self.result.finish_reason}],"usageMetadata":self.result.usage}),
                self.protocol,
            ),
            _ => Err(invalid("模型未返回完整响应")),
        }
    }
    fn finish_with_tools(self,sse:bool,tools:&[Value])->Result<Completion>{
        if self.protocol==Protocol::Chat {return self.chat.finish_with_tools(tools);}
        self.finish(sse)
    }
}

pub async fn complete(
    client: Client,
    config: ModelConfig,
    body: Value,
    key: String,
    cancel: CancellationToken,
    sink: TextSink,
) -> Result<Completion> {
    let p = protocol(&config)?;
    let url = Url::parse(&config.url).map_err(|_| invalid("模型地址无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid("模型地址须为完整HTTP或HTTPS接口地址"));
    }
    if key.is_empty() {
        return Err(invalid("尚未配置模型凭据"));
    }
    let tools=body["tools"].as_array().cloned().unwrap_or_default();
    let body = prepare(&config, &body, p)?;
    let mut request = client
        .post(url)
        .header(header::ACCEPT, "text/event-stream, application/json")
        .header(header::ACCEPT_ENCODING, "identity")
        .timeout(Duration::from_secs(180))
        .json(&body);
    let auth = match p {
        Protocol::Anthropic => "x-api-key",
        Protocol::Gemini => "x-goog-api-key",
        _ => "authorization",
    };
    let value = if auth == "authorization" {
        format!("Bearer {key}")
    } else {
        key.clone()
    };
    let mut value =
        header::HeaderValue::from_str(&value).map_err(|_| invalid("模型凭据格式无效"))?;
    value.set_sensitive(true);
    request = request.header(auth, value);
    if p == Protocol::Anthropic {
        request = request.header("anthropic-version", "2023-06-01");
    }
    let started = Instant::now();
    // TCP connection still has the client's 30s connect timeout. A service
    // can accept it and then spend longer prefilling/reasoning before headers
    // or the next content chunk; keep the overall request deadline at 180s.
    let mut response = tokio::select! {_ = cancel.cancelled()=>return Err(Error::Cancelled),r=tokio::time::timeout(Duration::from_secs(120),request.send())=>r.map_err(|_|invalid("等待模型响应超时"))?.map_err(|_|invalid("无法连接模型服务"))?};
    if !response.status().is_success() {
        return Err(invalid(&format!(
            "模型服务返回 {}",
            response.status().as_u16()
        )));
    }
    let sse = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.contains("text/event-stream"));
    let mut parser = Parser::new(p);
    let mut buffer = vec![];
    let mut data = String::new();
    let mut total = 0;
    let mut first = None;
    'read: loop {
        let chunk = tokio::select! {_ = cancel.cancelled()=>return Err(Error::Cancelled),r=tokio::time::timeout(Duration::from_secs(120),response.chunk())=>r.map_err(|_|invalid("等待模型内容超时"))?.map_err(|_|invalid("模型连接中断"))?};
        let Some(chunk) = chunk else {
            break;
        };
        total += chunk.len();
        if total > MAX_RESPONSE {
            return Err(invalid("模型返回内容过长"));
        }
        buffer.extend_from_slice(&chunk);
        if !sse {
            continue;
        }
        while let Some(at) = buffer.iter().position(|b| *b == b'\n') {
            let bytes: Vec<_> = buffer.drain(..=at).collect();
            let line = std::str::from_utf8(&bytes)
                .map_err(|_| invalid("模型响应编码无效"))?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if data.is_empty() {
                    continue;
                }
                let payload = data.trim_end_matches('\n');
                if payload.contains(&key) {
                    return Err(invalid("模型意外返回认证信息，已停止并隐藏"));
                }
                let done = parser.push(payload)?;
                if !parser.current_text().is_empty() {
                    first.get_or_insert(started.elapsed().as_millis() as u64);
                    sink(parser.current_text().into());
                }
                data.clear();
                if done {
                    buffer.clear();
                    break 'read;
                }
            } else if let Some(payload) = line.strip_prefix("data:") {
                data.push_str(payload.strip_prefix(' ').unwrap_or(payload));
                data.push('\n');
            }
        }
    }
    if sse {
        if !buffer.is_empty() {
            let line = std::str::from_utf8(&buffer).map_err(|_| invalid("模型响应编码无效"))?;
            if let Some(payload) = line.strip_prefix("data:") {
                data.push_str(payload.trim_start());
            }
        }
        if !data.trim().is_empty() {
            if data.contains(&key) {
                return Err(invalid("模型意外返回认证信息，已停止并隐藏"));
            }
            parser.push(data.trim_end())?;
        }
    } else {
        let raw = std::str::from_utf8(&buffer).map_err(|_| invalid("模型响应编码无效"))?;
        if raw.contains(&key) {
            return Err(invalid("模型意外返回认证信息，已停止并隐藏"));
        }
        parser.push(raw)?;
    }
    let mut result = parser.finish_with_tools(sse,&tools)?;
    if !result.text.is_empty() {
        first.get_or_insert(started.elapsed().as_millis() as u64);
        sink(result.text.clone());
    }
    result.first_token_ms = first;
    result.total_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::Arc,
        thread,
    };

    fn config(name: &str) -> ModelConfig {
        ModelConfig {
            slot: "fixture".into(),
            url: "http://127.0.0.1/explicit".into(),
            model: "fixture-model".into(),
            aux_model: None,
            include_usage: true,
            max_tokens: Some(500),
            extra: serde_json::from_value(json!({"protocol":name})).unwrap(),
        }
    }
    fn body(config: &ModelConfig) -> Value {
        chat::request(
            config,
            &[
                json!({"role":"system","content":"规则"}),
                json!({"role":"user","content":"查时间"}),
            ],
            &[
                json!({"type":"function","function":{"name":"read_clock","description":"读取时间","parameters":{"type":"object","properties":{},"additionalProperties":false}}}),
            ],
            false,
        )
    }
    fn event(value: Value) -> String {
        format!("data: {value}\r\n\r\n")
    }
    fn response_fixture() -> Value {
        json!({"object":"response","status":"completed","output":[{"type":"reasoning","id":"reasoning1","summary":[],"encrypted_content":"opaque-responses"},{"type":"function_call","id":"fc1","call_id":"provider-call","name":"read_clock","arguments":"{}","status":"completed"}],"usage":{"input_tokens":9,"output_tokens":4}})
    }
    fn anthropic_fixture() -> String {
        [
            json!({"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-claude"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"provider-call","name":"read_clock","input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"atElapsed"}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"Minutes\":10}"}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}),
            json!({"type":"message_stop"}),
        ].into_iter().map(event).collect()
    }
    async fn exercise(name: &str, wire: String) -> (Completion, Value) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut input = vec![];
            let mut chunk = [0; 2048];
            let header_end;
            loop {
                let n = socket.read(&mut chunk).unwrap();
                assert!(n > 0);
                input.extend_from_slice(&chunk[..n]);
                if let Some(at) = input.windows(4).position(|s| s == b"\r\n\r\n") {
                    header_end = at + 4;
                    break;
                }
            }
            let headers = String::from_utf8(input[..header_end].to_vec()).unwrap();
            assert!(headers.starts_with("POST /explicit/final?mode=fixture HTTP/1.1"));
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|s| s.trim().parse::<usize>().ok())
                })
                .unwrap();
            while input.len() < header_end + length {
                let n = socket.read(&mut chunk).unwrap();
                assert!(n > 0);
                input.extend_from_slice(&chunk[..n]);
            }
            let request = serde_json::from_slice(&input[header_end..header_end + length]).unwrap();
            let output=format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{wire}",wire.len());
            // Byte-sized fragments include split UTF-8 sequences and SSE frames.
            for bytes in output.as_bytes().chunks(7) {
                socket.write_all(bytes).unwrap();
            }
            request
        });
        let mut config = config(name);
        config.url = format!("http://{address}/explicit/final?mode=fixture");
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .unwrap();
        let result = complete(
            client,
            config.clone(),
            body(&config),
            "fixture-credential-value".into(),
            CancellationToken::new(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        (result, server.join().unwrap())
    }
    fn next_body(name: &str, result: &Completion) -> Value {
        let config = config(name);
        let mut calls = result.tool_calls.clone();
        for call in &mut calls {
            call["id"] = format!("agent-prefix-{}", text(&call["id"])).into();
        }
        let messages = vec![
            json!({"role":"user","content":"核对"}),
            json!({"role":"assistant","content":null,"tool_calls":calls}),
            json!({"role":"tool","tool_call_id":calls[0]["id"],"content":"{\"value\":10}"}),
        ];
        prepare(
            &config,
            &chat::request(&config, &messages, &[], false),
            protocol(&config).unwrap(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn responses_mock_keeps_call_ids_and_encrypted_items() {
        let wire = event(
            json!({"type":"response.function_call_arguments.delta","item_id":"fc1","output_index":1,"delta":"{"}),
        ) + &event(
            json!({"type":"response.function_call_arguments.delta","item_id":"fc1","output_index":1,"delta":"}"}),
        ) + &event(json!({"type":"response.completed","response":response_fixture()}));
        let (result, request) = exercise("openai-responses", wire).await;
        assert_eq!(request["tools"][0]["name"], "read_clock");
        assert_eq!(request["tools"][0]["strict"], false);
        assert_eq!(result.usage.as_ref().unwrap()["prompt_tokens"], 9);
        let next = next_body("openai-responses", &result);
        assert_eq!(next["input"][1]["encrypted_content"], "opaque-responses");
        assert_eq!(next["input"][2]["call_id"], "provider-call");
        assert_eq!(next["input"][3]["call_id"], "provider-call");
    }
    #[tokio::test]
    async fn anthropic_mock_assembles_arguments_and_preserves_signature() {
        let (result, request) = exercise("anthropic", anthropic_fixture()).await;
        assert_eq!(request["tools"][0]["input_schema"]["type"], "object");
        assert!(request.get("stream_options").is_none());
        assert_eq!(
            result.tool_calls[0]["function"]["arguments"],
            "{\"atElapsedMinutes\":10}"
        );
        let next = next_body("anthropic", &result);
        assert_eq!(
            next["messages"][1]["content"][0]["signature"],
            "opaque-claude"
        );
        assert_eq!(
            next["messages"][2]["content"][0]["tool_use_id"],
            "provider-call"
        );
    }
    #[tokio::test]
    async fn gemini_mock_preserves_exact_signature_part_and_function_id() {
        let wire = event(
            json!({"candidates":[{"content":{"parts":[{"functionCall":{"id":"provider-call","name":"read_clock","args":{}},"thoughtSignature":"opaque-gemini"}]}}]}),
        ) + &event(
            json!({"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":4,"thoughtsTokenCount":3}}),
        );
        let (result, request) = exercise("gemini", wire).await;
        assert_eq!(
            request["tools"][0]["functionDeclarations"][0]["parametersJsonSchema"]["type"],
            "object"
        );
        assert_eq!(result.usage.as_ref().unwrap()["completion_tokens"], 7);
        let next = next_body("gemini", &result);
        assert_eq!(
            next["contents"][1]["parts"][0]["thoughtSignature"],
            "opaque-gemini"
        );
        assert_eq!(
            next["contents"][2]["parts"][0]["functionResponse"]["id"],
            "provider-call"
        );
    }
    #[test]
    fn truncated_or_incomplete_tools_are_never_returned_for_execution() {
        let mut raw = response_fixture();
        raw["status"] = "incomplete".into();
        assert!(completed(&raw, Protocol::Responses).is_err());
        raw = response_fixture();
        raw["output"][1]["arguments"] = "{\"broken\":".into();
        assert!(completed(&raw, Protocol::Responses).is_err());
        assert!(completed(&json!({"content":[{"type":"tool_use","id":"c","name":"read_clock","input":{}}],"stop_reason":"max_tokens"}),Protocol::Anthropic).is_err());
        assert!(completed(&json!({"candidates":[{"content":{"parts":[{"functionCall":{"id":"c","name":"read_clock","args":{}}}]},"finishReason":"MAX_TOKENS"}]}),Protocol::Gemini).is_err());
        let mut parser = Parser::new(Protocol::Anthropic);
        parser.push(&json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c","name":"read_clock","input":{}}}).to_string()).unwrap();
        parser.push("{\"type\":\"message_stop\"}").unwrap();
        assert!(parser.finish(true).is_err());
        assert!(Parser::new(Protocol::Responses).finish(true).is_err());
    }
    #[test]
    fn plain_json_and_json_chunk_arrays_use_the_same_canonical_boundary() {
        let mut parser = Parser::new(Protocol::Responses);
        parser.push(&response_fixture().to_string()).unwrap();
        assert_eq!(parser.finish(false).unwrap().tool_calls.len(), 1);
        let mut parser = Parser::new(Protocol::Anthropic);
        parser.push(&json!({"type":"message","content":[{"type":"text","text":"完成"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":2}}).to_string()).unwrap();
        assert_eq!(parser.finish(false).unwrap().text, "完成");
        let mut parser = Parser::new(Protocol::Gemini);
        parser.push(&json!([{"candidates":[{"content":{"parts":[{"text":"完"}]}}]},{"candidates":[{"content":{"parts":[{"text":"成"}]},"finishReason":"STOP"}]}]).to_string()).unwrap();
        assert_eq!(parser.finish(false).unwrap().text, "完成");
    }
}
