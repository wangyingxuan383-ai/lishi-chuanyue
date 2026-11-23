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
/// A model request failure with its transport kind, so the runner can retry
/// transient failures and the UI can classify without parsing text (R26-T003).
fn provider(kind: &str, status: Option<u16>, message: &str, partial: bool) -> Error {
    Error::Provider { kind: kind.into(), status, message: message.into(), partial }
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
    let raw_messages = body["messages"]
        .as_array()
        .ok_or_else(|| invalid("模型消息列表无效"))?;
    let projected = chat::project_supplied_skills(raw_messages);
    let messages = projected.as_slice();
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
                result["tool_choice"] = if body["tool_choice"] == "none" { "none" } else { "auto" }.into();
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
                    let body_text = text(&message["content"]);
                    if !body_text.is_empty() {
                        system.push(json!({"type":"text","text":body_text}));
                    }
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
                    let body_text = text(&message["content"]);
                    if !body_text.is_empty() {
                        blocks.push(json!({"type":"text","text":body_text}));
                    }
                    "user"
                };
                append_message(&mut history, target, blocks);
            }
            let cacheable = |block: &Value| {
                matches!(
                    block["type"].as_str(),
                    Some("text" | "tool_use" | "tool_result" | "image" | "document")
                ) && (block["type"] != "text" || !block["text"].as_str().unwrap_or("").is_empty())
            };
            // Prompt-cache breakpoints (R31-P3): mark the end of tools, system, and the
            // penultimate history message (skipping thinking blocks) so Anthropic caches
            // the stable prefix across turns and tool-call loops.
            if let Some(last_sys) = system.iter_mut().rev().find(|b| cacheable(b)) {
                last_sys["cache_control"] = json!({"type":"ephemeral"});
            }
            if history.len() >= 2 {
                let target_idx = history.len() - 2;
                if let Some(blocks) = history[target_idx]["content"].as_array_mut() {
                    if let Some(last_block) = blocks.iter_mut().rev().find(|b| cacheable(b)) {
                        last_block["cache_control"] = json!({"type":"ephemeral"});
                    }
                }
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
                let mut wire_tools: Vec<Value> = tools
                    .iter()
                    .map(|t| json!({"name":t["name"],"description":t["description"].as_str().unwrap_or(""),"input_schema":t["parameters"]}))
                    .collect();
                if let Some(last_tool) = wire_tools.last_mut() {
                    last_tool["cache_control"] = json!({"type":"ephemeral"});
                }
                result["tools"] = Value::Array(wire_tools);
                if body["tool_choice"] == "none" {
                    result["tool_choice"] = json!({"type":"none"});
                }
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
                if body["tool_choice"] == "none" {
                    result["toolConfig"] = json!({"functionCallingConfig":{"mode":"NONE"}});
                }
            }
            Ok(result)
        }
        Protocol::Chat => unreachable!(),
    }
}

fn usage(raw: &Value, p: Protocol) -> Option<Value> {
    let mut result = raw.as_object()?.clone();
    let number = |key: &str| raw[key].as_u64();
    let add_if_present = |base: &str, others: &[&str]| {
        number(base).map(|n| others.iter().filter_map(|key| number(key)).fold(n, u64::saturating_add))
    };
    let (input, output) = match p {
        Protocol::Responses => (number("input_tokens"), number("output_tokens")),
        Protocol::Anthropic => (
            add_if_present("input_tokens", &["cache_creation_input_tokens", "cache_read_input_tokens"]),
            number("output_tokens"),
        ),
        Protocol::Gemini => (
            number("promptTokenCount"),
            add_if_present("candidatesTokenCount", &["thoughtsTokenCount"]),
        ),
        Protocol::Chat => return Some(raw.clone()),
    };
    if let Some(input) = input { result.insert("prompt_tokens".into(), input.into()); }
    if let Some(output) = output { result.insert("completion_tokens".into(), output.into()); }
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

fn gemini_prompt_blocked(raw: &Value) -> bool {
    raw["promptFeedback"]["blockReason"].as_str().is_some_and(|reason| {
        !matches!(reason, "" | "BLOCK_REASON_UNSPECIFIED" | "BLOCKED_REASON_UNSPECIFIED")
    })
}

fn completed(raw: &Value, p: Protocol) -> Result<Completion> {
    let mut result = Completion::default();
    let (blocks, reason, key) = match p {
        Protocol::Responses => {
            let reason = match text(&raw["status"]) {
                "completed" => "stop",
                "incomplete" => match text(&raw["incomplete_details"]["reason"]) {
                    "max_output_tokens" | "max_messages" => "length",
                    "content_filter" => "content_filter",
                    _ => return Err(invalid("模型响应未完整结束，未执行工具")),
                },
                _ => return Err(invalid("模型响应未完整结束，未执行工具")),
            };
            (items(&raw["output"]), reason, "items")
        }
        Protocol::Anthropic => (items(&raw["content"]), text(&raw["stop_reason"]), "content"),
        Protocol::Gemini => (
            items(&raw["candidates"][0]["content"]["parts"]),
            text(&raw["candidates"][0]["finishReason"]),
            "parts",
        ),
        Protocol::Chat => return Err(invalid("模型协议内部状态无效")),
    };
    let stopped = match p {
        Protocol::Responses => {
            if reason == "content_filter" || blocks.iter().any(|block| {
                block["type"] == "message" && items(&block["content"]).iter().any(|part| part["type"] == "refusal")
            }) {
                Some("content_filter")
            } else if reason == "length" {
                Some("length")
            } else {
                None
            }
        }
        Protocol::Anthropic => match reason {
            "refusal" => Some("refusal"),
            "max_tokens" | "model_context_window_exceeded" => Some("length"),
            _ => None,
        },
        Protocol::Gemini if gemini_prompt_blocked(raw) => Some("content_filter"),
        Protocol::Gemini => match reason {
            "MAX_TOKENS" => Some("length"),
            "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII"
            | "IMAGE_SAFETY" | "IMAGE_PROHIBITED_CONTENT" | "IMAGE_RECITATION" => Some("content_filter"),
            _ => None,
        },
        Protocol::Chat => unreachable!(),
    };
    result.usage = usage(
        if p == Protocol::Gemini { &raw["usageMetadata"] } else { &raw["usage"] },
        p,
    );
    if stopped.is_none_or(|reason| reason == "length") {
        for block in blocks {
            match p {
                Protocol::Responses if block["type"] == "message" => {
                    for part in items(&block["content"]) {
                        if part["type"] == "output_text" {
                            result.text.push_str(text(&part["text"]));
                        }
                    }
                }
                Protocol::Anthropic if block["type"] == "text" => result.text.push_str(text(&block["text"])),
                Protocol::Gemini if block["thought"] != true => result.text.push_str(text(&block["text"])),
                _ => {}
            }
        }
    }
    if let Some(reason) = stopped {
        // Keep partial prose on length limits. Never execute tools from
        // a response the service stopped, even if their JSON parses.
        result.finish_reason = Some(reason.into());
        return Ok(result);
    }
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
                }
            }
            Protocol::Anthropic => {
                if block["type"] == "tool_use" {
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
                }
            }
            Protocol::Chat => {}
        }
    }
    if reason.is_empty()
        || p == Protocol::Gemini && reason != "STOP"
        || p == Protocol::Anthropic
            && !matches!(
                reason,
                "end_turn" | "tool_use" | "stop_sequence"
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
        result.tool_calls[0]["providerData"][key] = Value::Array(blocks.to_vec());
    }
    result.finish_reason = Some(if result.tool_calls.is_empty() { "stop" } else { "tool_calls" }.into());
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
    prompt_blocked: bool,
    saw_thinking: bool,
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
            prompt_blocked: false,
            saw_thinking: false,
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
        if !value["error"].is_null() || value["type"] == "error" {
            return Err(provider("stream", None, "模型服务中途返回错误，未执行工具", !self.current_text().is_empty()));
        }
        match self.protocol {
            Protocol::Responses => match text(&value["type"]) {
                "response.output_text.delta" => self.result.text.push_str(text(&value["delta"])),
                "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                    self.saw_thinking = true;
                }
                "response.output_item.added" if value["item"]["type"] == "reasoning" => {
                    self.saw_thinking = true;
                }
                "response.completed" | "response.incomplete" => {
                    self.final_value = Some(value["response"].clone());
                    self.ended = true;
                }
                "response.failed" => {
                    return Err(provider("stream", None, "模型服务报告响应失败，未执行工具", !self.current_text().is_empty()));
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
                    } else if block["type"] == "thinking" {
                        self.saw_thinking = true;
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
                            } else if key == "thinking" && !part.is_empty() {
                                self.saw_thinking = true;
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
                if gemini_prompt_blocked(value) {
                    self.prompt_blocked = true;
                    self.ended = true;
                }
                for part in items(&candidate["content"]["parts"]) {
                    if part["thought"] == true {
                        self.saw_thinking = true;
                    } else {
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
    fn has_thinking(&self) -> bool {
        if self.protocol == Protocol::Chat {
            self.chat.has_thinking()
        } else {
            self.saw_thinking
        }
    }
    fn finish(self, sse: bool) -> Result<Completion> {
        if self.protocol == Protocol::Chat {
            return self.chat.finish();
        }
        if sse && !self.ended {
            return Err(provider("stream", None, "模型连接提前结束，未执行工具", !self.current_text().is_empty()));
        }
        if let Some(value) = self.final_value {
            let mut result = completed(&value, self.protocol)?;
            if result.finish_reason.as_deref() == Some("length") && result.text.is_empty() {
                result.text = self.result.text;
            }
            return Ok(result);
        }
        match self.protocol {
            Protocol::Anthropic => {
                if self.blocks.values().any(|b| !b.closed) {
                    return Err(provider("stream", None, "模型内容尚未完整结束", !self.current_text().is_empty()));
                }
                let reason = self.result.finish_reason.as_deref().unwrap_or_default();
                let stopped = matches!(reason, "max_tokens" | "model_context_window_exceeded" | "refusal");
                let mut content = Vec::new();
                for mut block in self.blocks.into_values() {
                    if !stopped && !block.args.is_empty() {
                        block.value["input"] = serde_json::from_str(&block.args)
                            .map_err(|_| invalid("模型工具参数未完整结束"))?;
                    }
                    content.push(block.value);
                }
                completed(
                    &json!({"content":content,"stop_reason":reason,"usage":self.result.usage}),
                    self.protocol,
                )
            }
            Protocol::Gemini => completed(
                &json!({"candidates":[{"content":{"parts":self.parts},"finishReason":self.result.finish_reason}],"usageMetadata":self.result.usage,
                    "promptFeedback":{"blockReason":if self.prompt_blocked { "SAFETY" } else { "" }}}),
                self.protocol,
            ),
            _ => Err(invalid("模型未返回完整响应")),
        }
    }
    fn finish_with_tools(self,sse:bool,tools:&[Value])->Result<Completion>{
        if self.protocol==Protocol::Chat {
            if sse && !self.ended && self.chat.expects_terminal_marker() {
                return Err(provider("stream", None, "模型连接提前结束，未执行工具", self.chat.has_content()));
            }
            return self.chat.finish_with_tools(tools);
        }
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
        // The whole request may take long while words keep coming (D167).
        .timeout(Duration::from_millis(story_core::chat::REQUEST_BACKSTOP_MS))
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
    // The client's connect timeout, first byte, idle time and request backstop
    // cover different stages of a slowly starting response.
    let mut response = tokio::select! {_ = cancel.cancelled()=>return Err(Error::Cancelled),r=tokio::time::timeout(Duration::from_millis(story_core::chat::FIRST_BYTE_MS),request.send())=>r.map_err(|_|provider("timeout_first",None,"等待模型响应超时",false))?.map_err(|e|provider("network",None,story_core::failure::connection_reason(&e),false))?};
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mut raw_err = Vec::new();
        let err_deadline = Instant::now() + Duration::from_secs(15);
        while raw_err.len() < 64 * 1024 {
            let Some(remain) = err_deadline.checked_duration_since(Instant::now()) else { break };
            let next = tokio::select! {
                _ = cancel.cancelled() => return Err(Error::Cancelled),
                r = tokio::time::timeout(remain, response.chunk()) => r,
            };
            match next {
                Ok(Ok(Some(chunk))) => {
                    let take = (64 * 1024 - raw_err.len()).min(chunk.len());
                    raw_err.extend_from_slice(&chunk[..take]);
                }
                _ => break,
            }
        }
        let detail = String::from_utf8_lossy(&raw_err).replace(&key, "***");
        if story_core::chat::provider_context_rejected(Some(status), &detail) {
            return Err(Error::ContextWindow);
        }
        let detail: String = detail.chars().take(2000).collect();
        return Err(provider("http", Some(status), if detail.trim().is_empty() { "模型服务返回错误" } else { detail.trim() }, false));
    }
    let sse = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.split(';').next().is_some_and(|kind| kind.trim().eq_ignore_ascii_case("text/event-stream")));
    let mut parser = Parser::new(p);
    let mut buffer = vec![];
    let mut data = String::new();
    let mut total = 0;
    let mut first = None;
    let mut streamed_text_len = 0;
    let mut thinking_notified = false;
    'read: loop {
        let chunk = tokio::select! {_ = cancel.cancelled()=>return Err(Error::Cancelled),r=tokio::time::timeout(Duration::from_millis(if first.is_none() {story_core::chat::FIRST_BYTE_MS} else {story_core::chat::IDLE_MS}),response.chunk())=>r.map_err(|_|provider(if first.is_none() {"timeout_first"} else {"timeout_idle"},None,"等待模型内容超时",first.is_some()))?.map_err(|e|provider("network",None,story_core::failure::connection_reason(&e),first.is_some()))?};
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
            let mut should_flush = false;
            if line.is_empty() {
                should_flush = !data.is_empty();
            } else if let Some(payload) = line.strip_prefix("data:") {
                data.push_str(payload.strip_prefix(' ').unwrap_or(payload));
                data.push('\n');
                let trimmed = data.trim();
                if trimmed == "[DONE]"
                    || serde_json::from_str::<serde::de::IgnoredAny>(trimmed).is_ok()
                {
                    should_flush = true;
                }
            }
            if should_flush {
                let payload = data.trim_end_matches('\n');
                if payload.contains(&key) {
                    return Err(invalid("模型意外返回认证信息，已停止并隐藏"));
                }
                let done = parser.push(payload)?;
                if !thinking_notified && streamed_text_len == 0 && parser.has_thinking() {
                    thinking_notified = true;
                    sink("\0phase:thinking".into());
                }
                if parser.current_text().len() > streamed_text_len {
                    streamed_text_len = parser.current_text().len();
                    first.get_or_insert(started.elapsed().as_millis() as u64);
                    sink(parser.current_text().into());
                }
                data.clear();
                if done {
                    buffer.clear();
                    break 'read;
                }
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
    fn a_final_only_request_keeps_tools_but_forbids_calls_in_every_protocol() {
        let wire = |name: &str| {
            let settings = config(name);
            let mut request = body(&settings);
            request["tool_choice"] = "none".into();
            prepare(&settings, &request, protocol(&settings).unwrap()).unwrap()
        };
        assert_eq!(wire("openai-responses")["tool_choice"], "none");
        assert_eq!(wire("anthropic")["tool_choice"], json!({"type":"none"}));
        assert_eq!(wire("gemini")["toolConfig"], json!({"functionCallingConfig":{"mode":"NONE"}}));
        for name in ["openai-responses", "anthropic", "gemini"] {
            assert!(wire(name).to_string().contains("read_clock"), "{name} keeps the definitions");
        }
        let responses = config("openai-responses");
        let plain = prepare(&responses, &body(&responses), Protocol::Responses).unwrap();
        assert_eq!(plain["tool_choice"], "auto");
        let anthropic = config("anthropic");
        assert!(prepare(&anthropic, &body(&anthropic), Protocol::Anthropic).unwrap().get("tool_choice").is_none());
    }
    #[test]
    fn truncated_or_incomplete_tools_are_never_returned_for_execution() {
        let mut raw = response_fixture();
        raw["status"] = "incomplete".into();
        assert!(completed(&raw, Protocol::Responses).is_err());
        raw = response_fixture();
        raw["output"][1]["arguments"] = "{\"broken\":".into();
        assert!(completed(&raw, Protocol::Responses).is_err());
        let anthropic = completed(&json!({"content":[{"type":"tool_use","id":"c","name":"read_clock","input":{}}],"stop_reason":"max_tokens"}),Protocol::Anthropic).unwrap();
        assert_eq!(anthropic.finish_reason.as_deref(), Some("length"));
        assert!(anthropic.tool_calls.is_empty());
        let gemini = completed(&json!({"candidates":[{"content":{"parts":[{"functionCall":{"id":"c","name":"read_clock","args":{}}}]},"finishReason":"MAX_TOKENS"}]}),Protocol::Gemini).unwrap();
        assert_eq!(gemini.finish_reason.as_deref(), Some("length"));
        assert!(gemini.tool_calls.is_empty());
        let mut parser = Parser::new(Protocol::Anthropic);
        parser.push(&json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c","name":"read_clock","input":{}}}).to_string()).unwrap();
        parser.push("{\"type\":\"message_stop\"}").unwrap();
        assert!(parser.finish(true).is_err());
        assert!(Parser::new(Protocol::Responses).finish(true).is_err());
    }
    #[test]
    fn native_adapters_distinguish_service_refusal_and_truncated_prose() {
        let mut parser = Parser::new(Protocol::Responses);
        parser.push(r#"{"type":"response.output_text.delta","delta":"半截正文"}"#).unwrap();
        parser.push(r#"{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":4,"output_tokens":8}}}"#).unwrap();
        let reply = parser.finish(true).unwrap();
        assert_eq!(reply.finish_reason.as_deref(), Some("length"));
        assert_eq!(reply.text, "半截正文");
        assert_eq!(reply.usage.unwrap()["completion_tokens"], 8);

        let mut parser = Parser::new(Protocol::Responses);
        parser.push(r#"{"object":"response","status":"completed","error":null,"output":[{"type":"message","content":[{"type":"refusal","refusal":"拒绝"}]}]}"#).unwrap();
        assert_eq!(parser.finish(false).unwrap().finish_reason.as_deref(), Some("content_filter"));

        let mut parser = Parser::new(Protocol::Gemini);
        parser.push(r#"{"promptFeedback":{"blockReason":"BLOCKLIST"},"usageMetadata":{"promptTokenCount":12}}"#).unwrap();
        let reply = parser.finish(true).unwrap();
        assert_eq!(reply.finish_reason.as_deref(), Some("content_filter"));
        let usage = reply.usage.unwrap();
        assert_eq!(usage["prompt_tokens"], 12);
        assert!(usage.get("completion_tokens").is_none());

        let reply = completed(
            &json!({"content":[{"type":"text","text":"已有文字"}],"stop_reason":"model_context_window_exceeded"}),
            Protocol::Anthropic,
        ).unwrap();
        assert_eq!(reply.finish_reason.as_deref(), Some("length"));
        assert_eq!(reply.text, "已有文字");
    }
    #[test]
    fn chat_sse_needs_a_terminal_marker_but_whole_message_does_not() {
        let mut partial = Parser::new(Protocol::Chat);
        partial.push(r#"{"choices":[{"delta":{"content":"半截"}}]}"#).unwrap();
        assert!(matches!(partial.finish_with_tools(true, &[]), Err(Error::Provider { partial: true, .. })));
        let mut whole = Parser::new(Protocol::Chat);
        whole.push(r#"{"choices":[{"message":{"content":"全文"}}]}"#).unwrap();
        assert_eq!(whole.finish_with_tools(false, &[]).unwrap().text, "全文");
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
    #[test]
    fn anthropic_attaches_ephemeral_cache_control_and_skips_thinking_blocks() {
        let settings = config("anthropic");
        let messages = vec![
            json!({"role":"system","content":"固定规则前缀"}),
            json!({"role":"user","content":"第一回合"}),
            json!({"role":"assistant","content":"","tool_calls":[{"id":"c1","type":"function","function":{"name":"read_clock","arguments":"{}"},"providerData":{"protocol":"anthropic","content":[{"type":"thinking","thinking":"内部推理","signature":"sig1"},{"type":"text","text":"正文回答"}]}}]}),
            json!({"role":"user","content":"第二回合"}),
        ];
        let request = chat::request(&settings, &messages, &[json!({"type":"function","function":{"name":"read_clock","description":"读时间","parameters":{"type":"object","properties":{}}}})], false);
        let wire = prepare(&settings, &request, Protocol::Anthropic).unwrap();
        assert_eq!(wire["system"][0]["cache_control"], json!({"type":"ephemeral"}));
        assert_eq!(wire["tools"][0]["cache_control"], json!({"type":"ephemeral"}));
        assert!(wire["messages"][1]["content"][0].get("cache_control").is_none());
        assert_eq!(wire["messages"][1]["content"][1]["cache_control"], json!({"type":"ephemeral"}));
        assert!(wire["messages"][2]["content"][0].get("cache_control").is_none());
    }
    #[tokio::test]
    async fn thinking_phase_sentinel_emitted_once_before_text() {
        let mut chat_parser = Parser::new(Protocol::Chat);
        assert!(!chat_parser.has_thinking());
        chat_parser.push(r#"{"choices":[{"delta":{"reasoning_content":"先理清人物关系"}}]}"#).unwrap();
        assert!(chat_parser.has_thinking());

        let mut gemini_parser = Parser::new(Protocol::Gemini);
        assert!(!gemini_parser.has_thinking());
        gemini_parser.push(r#"{"candidates":[{"content":{"parts":[{"thought":true,"text":"先核对时间线"}]}}]}"#).unwrap();
        assert!(gemini_parser.has_thinking());

        let wire = [
            json!({"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"第一步推理"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"第二步推理"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"雨停了。"}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}),
            json!({"type":"message_stop"}),
        ]
        .into_iter()
        .map(event)
        .collect::<String>();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf);
            let output = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{wire}", wire.len());
            socket.write_all(output.as_bytes()).unwrap();
        });
        let mut cfg = config("anthropic");
        cfg.url = format!("http://{address}/v1/messages");
        let client = Client::builder().no_proxy().build().unwrap();
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen_sink = seen.clone();
        let result = complete(
            client,
            cfg.clone(),
            body(&cfg),
            "fixture-key".into(),
            CancellationToken::new(),
            Arc::new(move |s| seen_sink.lock().unwrap().push(s)),
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(result.text, "雨停了。");
        let events = seen.lock().unwrap();
        let thinking_count = events.iter().filter(|e| e.as_str() == "\0phase:thinking").count();
        assert_eq!(thinking_count, 1, "expected sentinel once, got {events:?}");
        assert_eq!(events[0], "\0phase:thinking");
        assert!(events.iter().any(|e| e == "雨停了。"));
    }

    #[tokio::test]
    async fn sse_without_blank_lines_and_anthropic_empty_text_and_skill_projection_work() {
        // 1. Anthropic skips empty text blocks and projects synthetic requested-skill-* traces across protocols.
        let anthropic = config("anthropic");
        let messages = vec![
            json!({"role":"system","content":""}),
            json!({"role":"system","content":"系统规则"}),
            json!({"role":"assistant","content":null,"tool_calls":[{"id":"requested-skill-canon-0","type":"function","function":{"name":"read_skill","arguments":"{}"}}]}),
            json!({"role":"tool","tool_call_id":"requested-skill-canon-0","content":"{\"body\":\"原著技能正文\"}"}),
            json!({"role":"user","content":""}),
            json!({"role":"user","content":"开始写作"}),
        ];
        let req = chat::request(&anthropic, &messages, &[], false);
        let wire = prepare(&anthropic, &req, Protocol::Anthropic).unwrap();
        assert_eq!(wire["system"].as_array().unwrap().len(), 1);
        let wire_msgs = wire["messages"].as_array().unwrap();
        assert_eq!(wire_msgs.len(), 1, "adjacent projected user messages merge cleanly without empty text blocks");
        let blocks = wire_msgs[0]["content"].as_array().unwrap();
        assert!(blocks.iter().all(|b| b["type"] != "text" || !b["text"].as_str().unwrap_or("").is_empty()));
        assert!(blocks[0]["text"].as_str().unwrap().contains("原著技能正文"));

        // 2. Chat SSE stream with NO blank lines between data: frames still parses every chunk.
        let compact_sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"世界\"},\"finish_reason\":\"stop\"}]}\n",
            "data: [DONE]\n"
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf);
            let output = format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{compact_sse}", compact_sse.len());
            socket.write_all(output.as_bytes()).unwrap();
        });
        let mut cfg = config("chat-completions");
        cfg.url = format!("http://{address}/v1/chat/completions");
        let client = Client::builder().no_proxy().build().unwrap();
        let result = complete(
            client,
            cfg.clone(),
            body(&cfg),
            "fixture-key".into(),
            CancellationToken::new(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(result.text, "你好世界");
    }
}
