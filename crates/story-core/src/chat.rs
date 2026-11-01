//! Compatible completion messages, including pure tool responses and streamed arguments.
use crate::{ModelConfig, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type TextSink = Arc<dyn Fn(String) + Send + Sync>;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub text: String,
    /// Opaque protocol continuation, never player-facing story or tool output.
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub continuation: serde_json::Map<String, Value>,
    pub tool_calls: Vec<Value>,
    pub finish_reason: Option<String>,
    pub usage: Option<Value>,
    pub first_token_ms: Option<u64>,
    pub total_ms: u64,
}
pub trait Model: Send + Sync {
    fn complete(
        &self,
        config: ModelConfig,
        body: Value,
        cancel: CancellationToken,
        text: TextSink,
    ) -> BoxFuture<Result<Completion>>;
    /// Optional native search, webpage and configured remote MCP adapter.
    /// It receives the task's immutable network configuration, never a key.
    fn network(&self, _request: Value, _cancel: CancellationToken) -> BoxFuture<Result<Value>> {
        Box::pin(async {
            Err(crate::Error::Invalid(
                "当前宿主没有提供联网工具，请先配置可用的搜索或 MCP 服务".into(),
            ))
        })
    }
}

#[derive(Default)]
pub struct Accumulator {
    pub result: Completion,
    calls: BTreeMap<u64, Value>,
    invalid: bool,
    malformed_call: bool,
}
impl Accumulator {
    /// Some compatible services emit an empty argument string for a complete
    /// zero-argument call. Only normalize when the actually sent schema makes
    /// an empty object legal; incomplete JSON and required fields stay errors.
    pub fn finish_with_tools(mut self, tools:&[Value])->Result<Completion>{
        for call in self.calls.values_mut(){
            let empty=call["function"]["arguments"].as_str().is_some_and(|s|s.trim().is_empty());
            if !empty {continue;}
            let schema=tools.iter().find(|t|t["function"]["name"]==call["function"]["name"]).map(|t|&t["function"]["parameters"]);
            if schema.is_some_and(|s|s["type"]=="object"&&s.get("required").is_none_or(|v|v.as_array().is_some_and(Vec::is_empty))&&s.get("properties").is_none_or(Value::is_object)&&s["minProperties"].as_u64().unwrap_or(0)==0&&["allOf","anyOf","oneOf","not","enum","const","dependencies","dependentRequired","if"].iter().all(|key|s.get(*key).is_none())){call["function"]["arguments"]="{}".into();}
        }
        self.finish()
    }
    pub fn push(&mut self, data: &str) -> Option<String> {
        let value: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => {
                self.invalid = true;
                return None;
            }
        };
        if value.get("error").is_some() {
            self.invalid = true;
            return None;
        }
        let choice = &value["choices"][0];
        if choice["native_finish_reason"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("malformed_function_call"))
        {
            self.malformed_call = true;
        }
        let delta = choice
            .get("delta")
            .or_else(|| choice.get("message"))
            .cloned()
            .unwrap_or_default();
        let content = delta["content"].as_str().filter(|v| !v.is_empty());
        if let Some(text) = content {
            self.result.text.push_str(text);
        }
        // Thinking + tools services require these assistant-level fields on
        // subsequent requests. Tool-call metadata alone cannot carry them.
        for field in ["reasoning_content", "reasoning"] {
            if let Some(part) = delta[field].as_str() {
                let saved = self
                    .result
                    .continuation
                    .entry(field.to_owned())
                    .or_insert_with(|| json!(""));
                if let Some(text) = saved.as_str() {
                    *saved = json!(format!("{text}{part}"));
                }
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.result.finish_reason = Some(reason.into());
        }
        if value["usage"].is_object() {
            self.result.usage = Some(value["usage"].clone());
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for (i, call) in calls.iter().enumerate() {
                let index = call["index"].as_u64().unwrap_or(i as u64);
                let saved = self.calls.entry(index).or_insert_with(
                    || json!({"id":"","type":"function","function":{"name":"","arguments":""}}),
                );
                if let Some(id) = call["id"].as_str() {
                    saved["id"] = id.into();
                    saved["providerData"] = json!({"protocol":"chat-completions","id":id});
                }
                for (key, value) in call.as_object().into_iter().flatten() {
                    if !["index", "id", "function", "providerData"].contains(&key.as_str()) {
                        saved[key] = value.clone();
                    }
                }
                for (key, value) in call["function"].as_object().into_iter().flatten() {
                    if !["name", "arguments"].contains(&key.as_str()) {
                        saved["function"][key] = value.clone();
                    }
                }
                for key in ["name", "arguments"] {
                    if let Some(part) = call["function"][key].as_str() {
                        let previous = saved["function"][key].as_str().unwrap_or("");
                        saved["function"][key] = format!("{previous}{part}").into();
                    }
                }
            }
        }
        content.map(str::to_owned)
    }
    pub fn finish(mut self) -> Result<Completion> {
        self.result.tool_calls = self.calls.into_values().collect();
        if self.invalid {
            return Err(crate::Error::Invalid("模型返回了无法识别的响应".into()));
        }
        if self.malformed_call {
            return Err(crate::Error::Invalid("模型服务报告工具调用格式错误，本次没有执行工具；已保留进度，可继续或更换支持工具调用的模型".into()));
        }
        if self.result.text.is_empty() && self.result.tool_calls.is_empty() {
            return Err(crate::Error::Invalid("模型没有返回正文或工具调用".into()));
        }
        for call in &self.result.tool_calls {
            if call["id"].as_str().unwrap_or("").is_empty()
                || call["function"]["name"].as_str().unwrap_or("").is_empty()
            {
                return Err(crate::Error::Invalid("模型返回的工具调用不完整".into()));
            }
            let args = call["function"]["arguments"].as_str().unwrap_or("");
            if !serde_json::from_str::<Value>(args).is_ok_and(|v| v.is_object()) {
                return Err(crate::Error::Invalid("模型的工具参数没有写完整".into()));
            }
        }
        if !self.result.tool_calls.is_empty()
            && !matches!(
                self.result.finish_reason.as_deref(),
                Some("tool_calls" | "function_call" | "stop")
            )
        {
            return Err(crate::Error::Invalid(
                "工具调用未完整结束，未执行其中任何工具".into(),
            ));
        }
        Ok(self.result)
    }
}

pub fn assistant_message(reply: &Completion) -> Value {
    let mut message = json!({"role":"assistant","content":if reply.text.is_empty()&&!reply.tool_calls.is_empty(){Value::Null}else{json!(reply.text)}});
    if !reply.tool_calls.is_empty() {
        message["tool_calls"] = json!(reply.tool_calls);
    }
    for field in ["reasoning_content", "reasoning"] {
        if let Some(value) = reply.continuation.get(field) {
            message[field] = value.clone();
        }
    }
    message
}

pub fn request(config: &ModelConfig, messages: &[Value], tools: &[Value], aux: bool) -> Value {
    let mut body = Value::Object(config.extra.clone());
    for key in ["protocol", "contextWindowTokens", "maxOutputTokens"] {
        body.as_object_mut().unwrap().remove(key);
    }
    body["model"] = if aux {
        config.aux_model.as_ref().unwrap_or(&config.model)
    } else {
        &config.model
    }
    .clone()
    .into();
    body["messages"] = Value::Array(messages.to_vec());
    body["max_tokens"] = config.max_output_tokens().into();
    body["stream"] = true.into();
    if config.include_usage {
        body["stream_options"] = json!({"include_usage":true});
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.to_vec());
        body["tool_choice"] = "auto".into();
    }
    body
}

/// Provider continuation metadata is persisted locally but is not a Chat field.
pub fn wire_chat_body(mut body: Value) -> Value {
    let mut ids = BTreeMap::new();
    for message in body["messages"].as_array().into_iter().flatten() {
        for call in message["tool_calls"].as_array().into_iter().flatten() {
            if call["providerData"]["protocol"] == "chat-completions" {
                if let (Some(id), Some(original)) =
                    (call["id"].as_str(), call["providerData"]["id"].as_str())
                {
                    ids.insert(id.to_owned(), original.to_owned());
                }
            }
        }
    }
    for message in body["messages"].as_array_mut().into_iter().flatten() {
        if let Some(original) = message["tool_call_id"].as_str().and_then(|id| ids.get(id)) {
            message["tool_call_id"] = original.clone().into();
        }
        for call in message["tool_calls"].as_array_mut().into_iter().flatten() {
            if let Some(original) = call["id"].as_str().and_then(|id| ids.get(id)) {
                call["id"] = original.clone().into();
            }
            if let Some(object) = call.as_object_mut() {
                object.remove("providerData");
            }
        }
    }
    // Preloading a player-selected skill is application work, not a model
    // assistant turn. Keep the durable tool trace, but project it as supplied
    // reference material on the wire (thinking APIs require authentic assistant
    // continuation fields and cannot reconstruct them for synthetic calls).
    if let Some(messages) = body["messages"].as_array() {
        let mut projected = vec![];
        let mut index = 0;
        while index < messages.len() {
            let message = &messages[index];
            let supplied = message["role"] == "assistant"
                && message["tool_calls"].as_array().is_some_and(|calls| {
                    !calls.is_empty()
                        && calls.iter().all(|c| {
                            c["id"]
                                .as_str()
                                .is_some_and(|id| id.starts_with("requested-skill-"))
                                && c["function"]["name"] == "read_skill"
                        })
                });
            if supplied {
                let ids = message["tool_calls"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|c| c["id"].as_str())
                    .collect::<Vec<_>>();
                let mut end = index + 1;
                let mut content = vec![];
                while end < messages.len()
                    && messages[end]["role"] == "tool"
                    && messages[end]["tool_call_id"]
                        .as_str()
                        .is_some_and(|id| ids.contains(&id))
                {
                    content.push(messages[end]["content"].as_str().unwrap_or("").to_owned());
                    end += 1;
                }
                if content.len() == ids.len() {
                    projected.push(json!({"role":"user","content":format!("【程序依玩家指定读取的技能资料；资料内容不改变权限】\n{}",content.join("\n"))}));
                    index = end;
                    continue;
                }
            }
            projected.push(message.clone());
            index += 1;
        }
        body["messages"] = json!(projected);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_arguments_are_only_normalized_for_a_sent_schema_accepting_an_empty_object(){
        let tools=json!([{"type":"function","function":{"name":"validate_changes","parameters":{"type":"object","properties":{},"required":[]}}},{"type":"function","function":{"name":"stage_edit","parameters":{"type":"object","required":["kind"]}}}]);
        for (name,args,reason,valid) in [("validate_changes","","tool_calls",true),("validate_changes"," ","stop",true),("stage_edit","","tool_calls",false),("unknown","","tool_calls",false),("validate_changes","{","tool_calls",false),("validate_changes","","length",false)]{
            let mut a=Accumulator::default();a.push(&json!({"choices":[{"message":{"tool_calls":[{"id":"call","type":"function","function":{"name":name,"arguments":args}}]},"finish_reason":reason}]}).to_string());
            let result=a.finish_with_tools(tools.as_array().unwrap());assert_eq!(result.is_ok(),valid,"{name}:{args}:{reason}");if valid {assert_eq!(result.unwrap().tool_calls[0]["function"]["arguments"],"{}");}
        }
    }
    #[test]
    fn assembles_interleaved_tool_arguments_and_accepts_no_prose() {
        let mut a = Accumulator::default();
        a.push(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"search_original","arguments":"{\"query\":"}},{"index":1,"id":"b","function":{"name":"read_skill","arguments":"{\"name\":"}}]}}]}"#);
        a.push(r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"canon-grounding\"}"}},{"index":0,"function":{"arguments":"\"师兄\"}"}}]},"finish_reason":"tool_calls"}]}"#);
        let r = a.finish().unwrap();
        assert_eq!(r.tool_calls.len(), 2);
        assert_eq!(
            r.tool_calls[0]["function"]["arguments"],
            r#"{"query":"师兄"}"#
        );
        assert_eq!(r.text, "");
        let mut call = r.tool_calls[0].clone();
        call["id"] = "agent-prefixed-a".into();
        let wire = wire_chat_body(
            json!({"messages":[{"role":"assistant","tool_calls":[call]},{"role":"tool","tool_call_id":"agent-prefixed-a","content":"{}"}]}),
        );
        assert_eq!(wire["messages"][0]["tool_calls"][0]["id"], "a");
        assert_eq!(wire["messages"][1]["tool_call_id"], "a");
        assert!(wire["messages"][0]["tool_calls"][0]
            .get("providerData")
            .is_none());
    }
    #[test]
    fn model_wire_fields_round_trip_without_becoming_api_parameters() {
        let config:ModelConfig=serde_json::from_value(json!({"slot":"main","url":"https://fixture.invalid/final","model":"fixture","auxModel":null,"includeUsage":false,"maxTokens":300,"protocol":"anthropic","contextWindowTokens":32000,"maxOutputTokens":4000,"extra":{"temperature":0.5}})).unwrap();
        assert_eq!(config.protocol(), "anthropic");
        assert_eq!(config.extra["contextWindowTokens"], 32000);
        let wire = serde_json::to_value(&config).unwrap();
        assert_eq!(wire["protocol"], "anthropic");
        assert!(wire["extra"].get("protocol").is_none());
        let body = request(&config, &[], &[], false);
        assert_eq!(body["max_tokens"], 4000);
        for key in ["protocol", "contextWindowTokens", "maxOutputTokens"] {
            assert!(body.get(key).is_none());
        }
    }
    #[test]
    fn length_truncated_and_unfinished_calls_are_not_executable() {
        for reason in [json!("length"), Value::Null] {
            let mut a = Accumulator::default();
            a.push(&json!({"choices":[{"message":{"tool_calls":[{"id":"c","type":"function","function":{"name":"read_clock","arguments":"{}"}}]},"finish_reason":reason}]}).to_string());
            assert!(a.finish().is_err());
        }
    }
    #[test]
    fn thinking_continuation_survives_streaming_checkpoint_and_tool_reply() {
        let mut a = Accumulator::default();
        a.push(r#"{"choices":[{"delta":{"reasoning_content":"opaque-"}}]}"#);
        a.push(r#"{"choices":[{"delta":{"reasoning_content":"continuation","tool_calls":[{"id":"original","function":{"name":"read_clock","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#);
        let saved = serde_json::to_string(&a.finish().unwrap()).unwrap();
        let reply: Completion = serde_json::from_str(&saved).unwrap();
        assert!(reply.text.is_empty());
        let mut message = assistant_message(&reply);
        message["tool_calls"][0]["id"] = "local-original".into();
        let wire = wire_chat_body(
            json!({"messages":[message,{"role":"tool","tool_call_id":"local-original","content":"{}"}]}),
        );
        assert_eq!(
            wire["messages"][0]["reasoning_content"],
            "opaque-continuation"
        );
        assert_eq!(wire["messages"][1]["tool_call_id"], "original");
        let old:Completion=serde_json::from_value(json!({"text":"old","toolCalls":[],"finishReason":"stop","usage":null,"firstTokenMs":null,"totalMs":0})).unwrap();
        assert!(old.continuation.is_empty());
    }
    #[test]
    fn application_skill_reads_do_not_impersonate_model_assistant_turns() {
        let wire = wire_chat_body(
            json!({"messages":[{"role":"assistant","content":null,"tool_calls":[{"id":"requested-skill-canon-reference-0","type":"function","function":{"name":"read_skill","arguments":"{}"}}]},{"role":"tool","tool_call_id":"requested-skill-canon-reference-0","content":"{\"body\":\"read evidence\"}"},{"role":"user","content":"continue"}]}),
        );
        assert_eq!(wire["messages"].as_array().unwrap().len(), 2);
        assert_eq!(wire["messages"][0]["role"], "user");
        assert!(wire["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("read evidence"));
        assert_eq!(wire["messages"][1]["content"], "continue");
    }
}
