//! Shared, bounded network tools for the native and development hosts.
//!
//! The supplied client MUST use `redirect::Policy::none()`. In particular, API
//! keys and MCP session headers must never be forwarded to a redirect target.
//! Native API URLs are complete, explicitly configured endpoints; this module
//! never infers tool support from a provider name or a model name.

use reqwest::{header, Client, RequestBuilder, Url};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use story_core::{Error, Result};
use tokio_util::sync::CancellationToken;

type Authorize = Arc<dyn Fn(&str, &str) -> Result<String> + Send + Sync>;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_TEXT: usize = 24_000;
const MCP_VERSION: &str = "2025-11-25";
const MCP_MODERN: &str = "2026-07-28";
const MCP_VERSIONS: &[&str] = &[MCP_VERSION, "2025-06-18", "2025-03-26"];
type ToolCache = HashMap<String, (Instant, String, Vec<Value>)>;
static TOOL_CACHE: OnceLock<Mutex<ToolCache>> = OnceLock::new();

fn invalid(message: &str) -> Error {
    Error::Invalid(message.to_owned())
}

fn required<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| invalid("联网请求缺少必要配置"))
}

fn endpoint(raw: &str) -> Result<Url> {
    let mut url = Url::parse(raw).map_err(|_| invalid("联网地址无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid("联网地址须为不含登录信息的 HTTP 或 HTTPS 地址"));
    }
    url.set_fragment(None);
    Ok(url)
}

fn clipped(text: &str, count: usize) -> String {
    text.chars().take(count).collect()
}

fn credential(authorize: &Authorize, config: &Value, url: &str) -> Result<String> {
    let slot = required(config, "slot")?;
    let key = authorize(slot, url).map_err(|_| invalid("联网凭据不可用，或凭据未授权此地址"))?;
    if key.trim().is_empty() {
        return Err(invalid("尚未配置联网凭据"));
    }
    Ok(key)
}

fn secret_header(
    mut request: RequestBuilder,
    name: &'static str,
    key: &str,
) -> Result<RequestBuilder> {
    let mut value = header::HeaderValue::from_str(key).map_err(|_| invalid("联网凭据格式无效"))?;
    value.set_sensitive(true);
    request = request.header(name, value);
    Ok(request)
}

struct Reply {
    bytes: Vec<u8>,
    headers: header::HeaderMap,
    status: u16,
}

async fn receive(
    request: RequestBuilder,
    secret: Option<&str>,
    rpc_id: Option<u64>,
    allow_http_error: bool,
    cancel: &CancellationToken,
) -> Result<Reply> {
    receive_counted(request,secret,rpc_id,allow_http_error,cancel,None).await
}
async fn receive_counted(
    request:RequestBuilder,secret:Option<&str>,rpc_id:Option<u64>,allow_http_error:bool,cancel:&CancellationToken,
    accounting:Option<&story_core::pi_accounting::NativeModelAccounting>,
)->Result<Reply> {
    let(client,request)=request.build_split();
    let request=request.map_err(|_|invalid("联网请求格式无效，未发送请求"))?;
    if cancel.is_cancelled(){return Err(Error::Cancelled);}
    if let Some(accounting)=accounting {accounting.admit()?;}
    let mut response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(Error::Cancelled),
        value = client.execute(request) => value.map_err(|_| invalid("联网请求失败，请检查网络与服务配置"))?,
    };
    if response.status().is_redirection() {
        return Err(invalid("联网服务返回了跳转，请在配置中填写最终地址"));
    }
    if !response.status().is_success() && !allow_http_error {
        return Err(invalid(&format!(
            "联网服务返回 HTTP {}",
            response.status().as_u16()
        )));
    }
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE as u64)
    {
        return Err(invalid("联网结果过大，请缩小查询范围"));
    }
    let headers = response.headers().clone();
    let event_stream = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"));
    let mut bytes = Vec::new();
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            value = response.chunk() => value.map_err(|_| invalid("读取联网结果失败"))?,
        };
        let Some(chunk) = next else { break };
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(invalid("联网结果过大，请缩小查询范围"));
        }
        bytes.extend_from_slice(&chunk);
        // A Streamable HTTP server may keep the SSE connection open after its
        // response. Finish as soon as the matching complete event arrives.
        if event_stream && rpc_id.is_some_and(|id| sse_reply(&bytes, id).is_ok()) {
            break;
        }
    }
    // Do not persist or return a service accidentally echoing our credential.
    if secret.is_some_and(|key| !key.is_empty() && String::from_utf8_lossy(&bytes).contains(key)) {
        return Err(invalid("联网服务返回了敏感凭据，结果已丢弃"));
    }
    Ok(Reply {
        bytes,
        headers,
        status,
    })
}

fn decode_json(reply: &Reply) -> Result<Value> {
    serde_json::from_slice(&reply.bytes).map_err(|_| invalid("联网服务未返回有效 JSON"))
}

/// Executes only an explicitly configured capability. Cancellation and a total
/// timeout include handshake, pagination, model search, and response reading.
#[cfg(test)]
pub async fn execute(
    client: Client,
    request: Value,
    authorize: Authorize,
    cancel: CancellationToken,
) -> Result<Value> {
    execute_counted(client,request,authorize,cancel,None).await
}
pub async fn execute_counted(client:Client,request:Value,authorize:Authorize,cancel:CancellationToken,accounting:Option<story_core::pi_accounting::NativeModelAccounting>)->Result<Value> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Error::Cancelled),
        value = tokio::time::timeout(Duration::from_secs(60), execute_inner(&client, &request, &authorize, &cancel,accounting.as_ref())) => {
            value.map_err(|_| invalid("联网操作超时，请缩小范围或稍后重试"))?
        }
    }
}

async fn execute_inner(
    client: &Client,
    request: &Value,
    authorize: &Authorize,
    cancel: &CancellationToken,
    accounting:Option<&story_core::pi_accounting::NativeModelAccounting>,
) -> Result<Value> {
    let network = &request["network"];
    let mode = network["mode"].as_str().unwrap_or("off");
    if mode == "off" {
        return Err(invalid("本局尚未开启联网能力"));
    }
    if !matches!(mode, "auto" | "native" | "configured") {
        return Err(invalid("联网方式无效"));
    }
    match required(request, "op")? {
        "web_search" => {
            let query = required(request, "query")?.trim();
            if query.chars().count() > 4_000 {
                return Err(invalid("搜索内容过长，请缩小查询范围"));
            }
            let native_supported=["openai-responses","gemini","anthropic"].contains(&network["native"]["protocol"].as_str().unwrap_or(""));
            if matches!(mode, "auto" | "native") && network["native"]["enabled"] == true && native_supported {
                let result=native_search(client, &network["native"], query, authorize, cancel,accounting).await;
                if mode=="auto" && matches!(&result,Err(Error::Tool{code,..}) if ["native_search_rejected","native_search_no_sources"].contains(code)) {
                    // Only a known response permits a different, configured
                    // search capability. Never replay a timed-out model call.
                    let fallback=if network["search"]["provider"]=="tavily" {
                        tavily_search(client,&network["search"],query,authorize,cancel).await
                    }else{mcp_search(client,network,query,authorize,cancel).await};
                    match fallback {Ok(mut value)=>{value["nativeCapability"]=json!({"status":"unavailable_for_request","reason":result.err().unwrap().to_string(),"fallback":true});Ok(value)},Err(_)=>result}
                }else{result}
            } else if mode == "native" {
                Err(invalid("当前任务接口没有已接入的原生搜索能力；可改用已配置的搜索服务或MCP，不需要重新填写同一个模型"))
            } else if network["search"]["provider"] == "tavily" {
                tavily_search(client, &network["search"], query, authorize, cancel).await
            } else {
                mcp_search(client, network, query, authorize, cancel).await
            }
        }
        "read_webpage" => read_webpage(client, request, cancel).await,
        "list_mcp_resources" | "read_mcp_resource" => {
            let id = required(request, "serverId")?;
            let configs = mcp_configs(network, Some(id))?;
            let mut session = Mcp::connect(client, configs[0], authorize, cancel).await?;
            let reading = request["op"] == "read_mcp_resource";
            let params = if reading {
                let uri = required(request, "uri")?;
                if uri.len() > 8192 || uri.chars().any(char::is_control) {
                    return Err(invalid("服务资料地址无效"));
                }
                Some(json!({"uri":uri}))
            } else {
                request["cursor"].as_str().map(|c| json!({"cursor":c}))
            };
            let reply = session
                .rpc(
                    if reading {
                        "resources/read"
                    } else {
                        "resources/list"
                    },
                    params,
                    false,
                    cancel,
                )
                .await;
            session.close(cancel).await;
            let value = reply?;
            if !reading {
                return Ok(
                    json!({"serverId":id,"resources":value["resources"],"nextCursor":value["nextCursor"],"untrusted":true}),
                );
            }
            let offset = request["offset"].as_u64().unwrap_or(0) as usize;
            let limit = request["limit"].as_u64().unwrap_or(4000).clamp(1, 12000) as usize;
            let mut remaining = limit;
            let mut contents = Vec::new();
            for entry in value["contents"].as_array().into_iter().flatten().take(30) {
                if let Some(text) = entry["text"].as_str() {
                    let selected = text
                        .chars()
                        .skip(offset)
                        .take(remaining)
                        .collect::<String>();
                    remaining = remaining.saturating_sub(selected.chars().count());
                    contents.push(json!({"uri":entry["uri"],"mimeType":entry["mimeType"],"text":selected,"offset":offset,"total":text.chars().count(),"nextOffset":offset+selected.chars().count()}));
                } else {
                    contents.push(json!({"uri":entry["uri"],"mimeType":entry["mimeType"],"message":"此资源没有可读取文字"}));
                }
                if remaining == 0 {
                    break;
                }
            }
            Ok(json!({"serverId":id,"contents":contents,"untrusted":true}))
        }
        "list_remote_tools" => {
            let configs = mcp_configs(network, request["serverId"].as_str())?;
            let mut servers = Vec::new();
            for config in configs {
                let user = request["userDiscovery"] == true;
                let cache_key=json!({"id":config["id"],"url":config["url"],"slot":config["slot"],"authorizationVersion":config["authorizationVersion"]}).to_string();
                let cached = if user || request["refresh"] == true {
                    None
                } else {
                    TOOL_CACHE
                        .get_or_init(Default::default)
                        .lock()
                        .ok()
                        .and_then(|c| {
                            c.get(&cache_key)
                                .filter(|(when, _, _)| when.elapsed() < Duration::from_secs(300))
                                .map(|(_, version, tools)| (version.clone(), tools.clone()))
                        })
                };
                let (version, tools) = if let Some(cached) = cached {
                    cached
                } else {
                    let mut session = Mcp::connect(client, config, authorize, cancel).await?;
                    let tools = session.list(cancel).await;
                    session.close(cancel).await;
                    let tools = tools?;
                    let version = session.version.clone();
                    if let Ok(mut cache) = TOOL_CACHE.get_or_init(Default::default).lock() {
                        if cache.len() >= 32 {
                            cache.clear();
                        }
                        cache.insert(cache_key, (Instant::now(), version.clone(), tools.clone()));
                    }
                    (version, tools)
                };
                let query = request["query"].as_str().unwrap_or("").to_lowercase();
                let name = request["name"].as_str();
                let available = tools
                    .into_iter()
                    .filter(|t| {
                        user || config["allowedTools"]
                            .as_array()
                            .is_some_and(|a| a.iter().any(|n| n == &t["name"]))
                    })
                    .filter(|t| name.is_none_or(|name| t["name"] == name))
                    .filter(|t| {
                        query.is_empty()
                            || format!("{} {}", t["name"], t["description"])
                                .to_lowercase()
                                .contains(&query)
                    })
                    .collect::<Vec<_>>();
                let total = available.len();
                let offset = request["offset"].as_u64().unwrap_or(0) as usize;
                let limit = request["limit"].as_u64().unwrap_or(20).clamp(1, 500) as usize;
                let page = available
                    .into_iter()
                    .skip(offset)
                    .take(limit)
                    .map(|mut t| {
                        if !user && name.is_none() {
                            if let Some(o) = t.as_object_mut() {
                                o.remove("inputSchema");
                                o.remove("outputSchema");
                            }
                        }
                        t
                    })
                    .collect::<Vec<_>>();
                servers.push(json!({"serverId":config["id"],"serverName":config["name"],"protocolVersion":version,"tools":page,"total":total,"offset":offset,"nextOffset":offset+page.len()}));
            }
            Ok(json!({"servers":servers,"untrusted":true}))
        }
        "call_remote_tool" => {
            let id = required(request, "serverId")?;
            let configs = mcp_configs(network, Some(id))?;
            let name = required(request, "name")?;
            if name.len() > 256 || request["arguments"].to_string().len() > 65_536 {
                return Err(invalid("MCP 工具参数过长"));
            }
            let arguments = request
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if !arguments.is_object() {
                return Err(invalid("MCP 工具参数须为对象"));
            }
            let mut session = Mcp::connect(client, configs[0], authorize, cancel).await?;
            let tools = session.list(cancel).await;
            if tools.is_err() {
                session.close(cancel).await;
            }
            let tools = tools?;
            if !tools.iter().any(|tool| tool["name"] == name) {
                session.close(cancel).await;
                return Err(invalid("已配置的 MCP 服务未提供此工具"));
            }
            let result = session.call(name, arguments, cancel).await;
            session.close(cancel).await;
            let result = result?;
            Ok(
                json!({"serverId":id,"name":name,"protocolVersion":session.version,"isError":result["isError"] == true,"result":result,"untrusted":true}),
            )
        }
        _ => Err(invalid("不支持此联网操作")),
    }
}

fn add_source(sources: &mut Vec<Value>, url: &str, title: &str, text: &str) {
    let Ok(url) = endpoint(url) else { return };
    if sources.len() >= 20 || sources.iter().any(|source| source["url"] == url.as_str()) {
        return;
    }
    sources
        .push(json!({"url":url.as_str(),"title":clipped(title, 300),"text":clipped(text, 2_000)}));
}

fn search_output(provider: &str, query: &str, text: String, sources: Vec<Value>) -> Result<Value> {
    if sources.is_empty() {
        return Err(invalid(
            "搜索未返回可核实的来源；不能将模型记忆视为联网结果",
        ));
    }
    Ok(
        json!({"provider":provider,"query":query,"text":clipped(&text,MAX_TEXT),"sources":sources,"untrusted":true}),
    )
}

async fn tavily_search(
    client: &Client,
    config: &Value,
    query: &str,
    authorize: &Authorize,
    cancel: &CancellationToken,
) -> Result<Value> {
    let url = endpoint(
        config["url"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("https://api.tavily.com/search"),
    )?;
    let key = credential(authorize, config, url.as_str())?;
    let request =
        secret_header(client.post(url), "authorization", &format!("Bearer {key}"))?.json(&json!({
            "query":query,"max_results":6,"search_depth":"basic","topic":"general",
            "include_answer":false,"include_raw_content":false,"include_images":false
        }));
    let value = decode_json(&receive(request, Some(&key), None, false, cancel).await?)?;
    let mut sources = Vec::new();
    if let Some(results) = value["results"].as_array() {
        for item in results {
            add_source(
                &mut sources,
                item["url"].as_str().unwrap_or(""),
                item["title"].as_str().unwrap_or(""),
                item["content"].as_str().unwrap_or(""),
            );
        }
    }
    search_output("tavily", query, String::new(), sources)
}

async fn native_search(
    client: &Client,
    config: &Value,
    query: &str,
    authorize: &Authorize,
    cancel: &CancellationToken,
    accounting:Option<&story_core::pi_accounting::NativeModelAccounting>,
) -> Result<Value> {
    let protocol = required(config, "protocol")?;
    let model = required(config, "model")?;
    let configured_url = required(config, "url")?;
    // Gemini places the model in its endpoint; allow an explicit placeholder.
    let escaped_model: String = model
        .bytes()
        .flat_map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.".contains(&b) {
                vec![b as char]
            } else {
                format!("%{b:02X}").chars().collect()
            }
        })
        .collect();
    let url = endpoint(&configured_url.replace("{model}", &escaped_model))?;
    // Bind to the configured endpoint, rather than a model-substituted address.
    let key = credential(authorize, config, configured_url)?;
    let mut request = client.post(url);
    let body = match protocol {
        "openai-responses" => {
            request = secret_header(request, "authorization", &format!("Bearer {key}"))?;
            json!({"model":model,"input":query,"tools":[{"type":"web_search"}],"tool_choice":"required","include":["web_search_call.action.sources"],"max_output_tokens":2_500,"stream":false})
        }
        "gemini" => {
            request = secret_header(request, "x-goog-api-key", &key)?;
            json!({"contents":[{"role":"user","parts":[{"text":format!("请实际使用 Google Search 检索，并依据搜索结果回答：{query}")}]}],"tools":[{"google_search":{}}],"generationConfig":{"maxOutputTokens":2_500}})
        }
        "anthropic" => {
            request = secret_header(request, "x-api-key", &key)?
                .header("anthropic-version", "2023-06-01");
            json!({"model":model,"max_tokens":2_500,"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":3}],"messages":[{"role":"user","content":format!("请实际调用 web_search 检索，再根据来源回答：{query}")}],"stream":false})
        }
        _ => return Err(invalid("不支持此原生搜索协议，请选择明确支持搜索的接口")),
    };
    let reply=receive_counted(request.json(&body), Some(&key), None, true, cancel,accounting).await?;
    if reply.status>=400 {
        if let Some(accounting)=accounting {accounting.finish(&json!({}),"failed")?;}
        if [400,404,405,422].contains(&reply.status){return Err(Error::Tool{code:"native_search_rejected".into(),field:"protocol".into(),message:format!("当前任务接口拒绝了原生搜索请求（HTTP {}），未宣称已联网",reply.status),next:json!({"action":"use_configured_search"})});}
        return Err(invalid(&format!("原生搜索返回HTTP {}，本次未自动重发",reply.status)));
    }
    let value = native_json(protocol,&reply)?;
    let usage=native_model_usage(protocol,&value);
    if let Some(accounting)=accounting {accounting.finish(&usage,"success")?;}
    let (text, sources) = native_sources(protocol, &value);
    let mut result = search_output(protocol, query, text, sources).map_err(|_|Error::Tool{code:"native_search_no_sources".into(),field:"sources".into(),message:"模型没有返回真实搜索来源，未将普通回答当成联网查证".into(),next:json!({"action":"use_configured_search"})})?;
    if protocol == "gemini" {
        // The host may present the provider's attribution widget as untrusted
        // content. Never merge this HTML into the application's own document.
        result["attribution"] =
            value["candidates"][0]["groundingMetadata"]["searchEntryPoint"].clone();
    }
    result["modelRequests"] = json!(1);
    result["modelUsage"]=usage;
    result["nativeCapability"]=json!({"status":"observed_supported","protocol":protocol});
    Ok(result)
}
fn native_json(protocol:&str,reply:&Reply)->Result<Value>{
    if protocol!="gemini" {return decode_json(reply);}
    let decoded=serde_json::from_slice::<Value>(&reply.bytes);
    let values=match decoded {
        Ok(Value::Array(values))=>values,
        Ok(value)=>return Ok(value),
        Err(_)=>{
            let text=std::str::from_utf8(&reply.bytes).map_err(|_|invalid("原生搜索未返回有效文字"))?;
            let mut values=vec![];
            for event in text.replace("\r\n","\n").split("\n\n"){
                let data=event.lines().filter_map(|l|l.strip_prefix("data:")).map(str::trim_start).collect::<Vec<_>>().join("\n");
                if data.is_empty()||data=="[DONE]"{continue;}
                values.push(serde_json::from_str(&data).map_err(|_|invalid("原生搜索流不完整，未重发请求"))?);
            }
            if values.is_empty(){return Err(invalid("原生搜索未返回有效JSON或完整事件流"));}values
        }
    };
    let mut result=json!({"candidates":[{"content":{"parts":[]}}]});let mut parts=vec![];let mut chunks=vec![];
    for value in values {
        if value.get("error").is_some(){return Err(invalid("原生搜索流报告错误，未宣称查证完成"));}
        if value.get("usageMetadata").is_some(){result["usageMetadata"]=value["usageMetadata"].clone();}
        for candidate in value["candidates"].as_array().into_iter().flatten().take(1){
            for part in candidate["content"]["parts"].as_array().into_iter().flatten(){
                if part["thought"]==true{continue;}
                if let Some(text)=part["text"].as_str(){if let Some(last)=parts.last_mut().filter(|p:&&mut Value|p["text"].is_string()){let joined=format!("{}{}",last["text"].as_str().unwrap(),text);last["text"]=joined.into();}else{parts.push(part.clone());}}else{parts.push(part.clone());}
            }
            if candidate.get("groundingMetadata").is_some(){chunks.extend(candidate["groundingMetadata"]["groundingChunks"].as_array().into_iter().flatten().cloned());result["candidates"][0]["groundingMetadata"]=candidate["groundingMetadata"].clone();}
        }
    }
    result["candidates"][0]["content"]["parts"]=parts.into();
    if !chunks.is_empty(){result["candidates"][0]["groundingMetadata"]["groundingChunks"]=chunks.into();}
    Ok(result)
}
fn native_model_usage(protocol:&str,value:&Value)->Value {
    let mut usage=json!({});
    let fields=match protocol {
        "openai-responses"=>vec![("input",value["usage"]["input_tokens"].as_u64()),("output",value["usage"]["output_tokens"].as_u64()),("cacheRead",value["usage"]["input_tokens_details"]["cached_tokens"].as_u64()),("reasoning",value["usage"]["output_tokens_details"]["reasoning_tokens"].as_u64()),("totalTokens",value["usage"]["total_tokens"].as_u64())],
        "anthropic"=>vec![("input",value["usage"]["input_tokens"].as_u64()),("output",value["usage"]["output_tokens"].as_u64()),("cacheRead",value["usage"]["cache_read_input_tokens"].as_u64()),("cacheWrite",value["usage"]["cache_creation_input_tokens"].as_u64())],
        "gemini"=>vec![("input",value["usageMetadata"]["promptTokenCount"].as_u64()),("output",value["usageMetadata"]["candidatesTokenCount"].as_u64()),("cacheRead",value["usageMetadata"]["cachedContentTokenCount"].as_u64()),("reasoning",value["usageMetadata"]["thoughtsTokenCount"].as_u64()),("totalTokens",value["usageMetadata"]["totalTokenCount"].as_u64())],
        _=>vec![],
    };
    for(key,n)in fields{if let Some(n)=n{usage[key]=n.into();}}
    if !usage.as_object().unwrap().values().any(|v|v.as_u64().is_some_and(|n|n>0)){return json!({});}
    if protocol!="anthropic" {if let Some(input)=usage["input"].as_u64(){usage["input"]=input.saturating_sub(usage["cacheRead"].as_u64().unwrap_or(0)).into();}}
    if protocol=="gemini" {if let Some(output)=usage["output"].as_u64(){usage["output"]=output.saturating_add(usage["reasoning"].as_u64().unwrap_or(0)).into();}}
    usage
}

fn native_sources(protocol: &str, value: &Value) -> (String, Vec<Value>) {
    let mut text = String::new();
    let mut sources = Vec::new();
    match protocol {
        "openai-responses" => {
            for output in value["output"].as_array().into_iter().flatten() {
                for source in output["action"]["sources"].as_array().into_iter().flatten() {
                    add_source(
                        &mut sources,
                        source["url"].as_str().unwrap_or(""),
                        source["title"].as_str().unwrap_or(""),
                        "",
                    );
                }
                for part in output["content"].as_array().into_iter().flatten() {
                    if let Some(t) = part["text"].as_str() {
                        text.push_str(t);
                        text.push('\n');
                    }
                    for cite in part["annotations"].as_array().into_iter().flatten() {
                        if cite["type"] == "url_citation" {
                            add_source(
                                &mut sources,
                                cite["url"].as_str().unwrap_or(""),
                                cite["title"].as_str().unwrap_or(""),
                                "",
                            );
                        }
                    }
                }
            }
        }
        "gemini" => {
            for candidate in value["candidates"].as_array().into_iter().flatten().take(1) {
                for part in candidate["content"]["parts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if part["thought"]==true{continue;}
                    if let Some(t) = part["text"].as_str() {
                        text.push_str(t);
                        text.push('\n');
                    }
                }
                for chunk in candidate["groundingMetadata"]["groundingChunks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    add_source(
                        &mut sources,
                        chunk["web"]["uri"].as_str().unwrap_or(""),
                        chunk["web"]["title"].as_str().unwrap_or(""),
                        "",
                    );
                }
            }
        }
        "anthropic" => {
            for part in value["content"].as_array().into_iter().flatten() {
                if part["type"] == "text" {
                    if let Some(t) = part["text"].as_str() {
                        text.push_str(t);
                        text.push('\n');
                    }
                    for cite in part["citations"].as_array().into_iter().flatten() {
                        add_source(
                            &mut sources,
                            cite["url"].as_str().unwrap_or(""),
                            cite["title"].as_str().unwrap_or(""),
                            cite["cited_text"].as_str().unwrap_or(""),
                        );
                    }
                }
                if part["type"] == "web_search_tool_result" {
                    for source in part["content"].as_array().into_iter().flatten() {
                        if source["type"] == "web_search_result" {
                            add_source(
                                &mut sources,
                                source["url"].as_str().unwrap_or(""),
                                source["title"].as_str().unwrap_or(""),
                                "",
                            );
                        }
                    }
                }
            }
        }
        _ => {}
    }
    (text, sources)
}

async fn read_webpage(
    client: &Client,
    request: &Value,
    cancel: &CancellationToken,
) -> Result<Value> {
    let mut url = endpoint(required(request, "url")?)?;
    let mut redirects = HashSet::new();
    let reply = loop {
        if !redirects.insert(url.as_str().to_owned()) || redirects.len() > 5 {
            return Err(invalid("网页跳转过多，请直接提供目标页面地址"));
        }
        // No credentials or MCP headers are attached to arbitrary webpages.
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            value = client.get(url.clone()).header(header::ACCEPT,"text/html, text/plain;q=0.9").send() => value.map_err(|_| invalid("无法读取网页，请检查地址与网络"))?,
        };
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| invalid("网页跳转地址无效"))?;
            let next = url
                .join(location)
                .map_err(|_| invalid("网页跳转地址无效"))?;
            url = endpoint(next.as_str())?;
            continue;
        }
        // receive() owns request sending; read this already received response
        // directly so a webpage is never downloaded twice.
        if !response.status().is_success() {
            return Err(invalid(&format!(
                "网页返回 HTTP {}",
                response.status().as_u16()
            )));
        }
        let headers = response.headers().clone();
        let mut response = response;
        let mut bytes = Vec::new();
        if response
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE as u64)
        {
            return Err(invalid("网页过大，请换用较短页面"));
        }
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(Error::Cancelled),
                value = response.chunk() => value.map_err(|_| invalid("读取网页失败"))?,
            };
            let Some(chunk) = chunk else { break };
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err(invalid("网页过大，请换用较短页面"));
            }
            bytes.extend_from_slice(&chunk);
        }
        break Reply {
            bytes,
            headers,
            status: 200,
        };
    };
    let content_type = reply
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/html")
        .to_ascii_lowercase();
    if !(content_type.starts_with("text/") || content_type.starts_with("application/xhtml+xml")) {
        return Err(invalid("此链接不是可直接阅读的文字网页"));
    }
    let raw = String::from_utf8_lossy(&reply.bytes);
    let (title, text) = if content_type.starts_with("text/plain") {
        (String::new(), raw.into_owned())
    } else {
        html_text(&raw)
    };
    let offset = request["offset"].as_u64().unwrap_or(0).min(2_000_000) as usize;
    let limit = request["limit"]
        .as_u64()
        .unwrap_or(12_000)
        .clamp(1, MAX_TEXT as u64) as usize;
    let total = text.chars().count();
    let offset = offset.min(total);
    let excerpt: String = text.chars().skip(offset).take(limit).collect();
    let end = offset + excerpt.chars().count();
    Ok(
        json!({"url":url.as_str(),"title":title,"text":excerpt,"offset":offset,"nextOffset":if end<total {Some(end)}else{None},"totalChars":total,"source":{"url":url.as_str(),"title":title},"untrusted":true}),
    )
}

// A deliberately small text extractor, not an HTML renderer. Scripts, styles,
// comments, attributes and templates are never returned as article prose.
fn html_text(html: &str) -> (String, String) {
    let mut text = String::new();
    let mut title = String::new();
    let mut hidden: Option<String> = None;
    let mut in_title = false;
    let mut pos = 0;
    while pos < html.len() {
        let rest = &html[pos..];
        if rest.starts_with("<!--") {
            pos += rest.find("-->").map(|n| n + 3).unwrap_or(rest.len());
            continue;
        }
        if rest.starts_with('<') {
            let Some(end) = rest.find('>') else { break };
            let tag = rest[1..end].trim();
            let closing = tag.starts_with('/');
            let name = tag
                .trim_start_matches('/')
                .split(|c: char| c.is_whitespace() || c == '/')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if let Some(current) = &hidden {
                if closing && &name == current {
                    hidden = None;
                }
            } else if !closing
                && matches!(
                    name.as_str(),
                    "script" | "style" | "noscript" | "template" | "svg"
                )
            {
                hidden = Some(name.clone());
            } else if name == "title" {
                in_title = !closing;
            } else if matches!(
                name.as_str(),
                "p" | "div"
                    | "br"
                    | "h1"
                    | "h2"
                    | "h3"
                    | "h4"
                    | "li"
                    | "tr"
                    | "section"
                    | "article"
                    | "blockquote"
                    | "hr"
            ) {
                text.push('\n');
            }
            pos += end + 1;
        } else {
            let end = rest.find('<').unwrap_or(rest.len());
            if hidden.is_none() {
                let decoded = entities(&rest[..end]);
                if in_title {
                    title.push_str(&decoded);
                } else {
                    text.push_str(&decoded);
                }
            }
            pos += end;
        }
    }
    let title = clipped(&title.split_whitespace().collect::<Vec<_>>().join(" "), 300);
    let text = text
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (title, text)
}

fn entities(text: &str) -> String {
    let mut result = String::new();
    let mut rest = text;
    while let Some(index) = rest.find('&') {
        result.push_str(&rest[..index]);
        rest = &rest[index..];
        let decoded = rest.find(';').filter(|n| *n < 14).and_then(|end| {
            let name = &rest[1..end];
            let ch = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                _ => name
                    .strip_prefix("#x")
                    .or_else(|| name.strip_prefix("#X"))
                    .and_then(|s| u32::from_str_radix(s, 16).ok())
                    .or_else(|| name.strip_prefix('#').and_then(|s| s.parse().ok()))
                    .and_then(char::from_u32),
            }?;
            Some((end, ch))
        });
        if let Some((end, ch)) = decoded {
            result.push(ch);
            rest = &rest[end + 1..];
        } else {
            result.push('&');
            rest = &rest[1..];
        }
    }
    result.push_str(rest);
    result
}

fn mcp_configs<'a>(network: &'a Value, id: Option<&str>) -> Result<Vec<&'a Value>> {
    let configs: Vec<_> = network["mcps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["enabled"] == true && id.is_none_or(|id| v["id"] == id))
        .take(9)
        .collect();
    if configs.is_empty() {
        return Err(invalid(
            "尚未配置可用的联网服务；请启用原生搜索、搜索服务或 MCP",
        ));
    }
    if configs.len() > 8 {
        return Err(invalid("单次最多连接 8 个 MCP 服务，请指定服务"));
    }
    if id.is_some() && configs.len() != 1 {
        return Err(invalid("MCP 服务标识重复，请检查配置"));
    }
    for config in &configs {
        required(config, "id")?;
        required(config, "url")?;
    }
    Ok(configs)
}

struct Mcp<'a> {
    client: &'a Client,
    url: Url,
    key: Option<String>,
    session: Option<String>,
    version: String,
    id: u64,
    schemas: HashMap<String, Value>,
}

impl<'a> Mcp<'a> {
    async fn connect(
        client: &'a Client,
        config: &Value,
        authorize: &Authorize,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        let url = endpoint(required(config, "url")?)?;
        let key = if config["slot"].as_str().is_some_and(|s| !s.is_empty()) {
            Some(credential(authorize, config, url.as_str())?)
        } else {
            None
        };
        let mut client = Self {
            client,
            url,
            key,
            session: None,
            version: MCP_MODERN.to_owned(),
            id: 0,
            schemas: HashMap::new(),
        };
        if client.discover(cancel).await? {
            return Ok(client);
        }
        client.version = MCP_VERSION.to_owned();
        let result = client.rpc("initialize",Some(json!({"protocolVersion":MCP_VERSION,"capabilities":{},"clientInfo":{"name":"story-agent","version":"1.0"}})),false,cancel).await?;
        let version = result["protocolVersion"]
            .as_str()
            .ok_or_else(|| invalid("MCP 握手未返回协议版本"))?;
        if !MCP_VERSIONS.contains(&version) {
            return Err(invalid("MCP 服务协商了尚未支持的协议版本"));
        }
        client.version = version.to_owned();
        if !result["capabilities"]["tools"].is_object() {
            return Err(invalid("MCP 服务未声明工具能力"));
        }
        client
            .rpc("notifications/initialized", None, true, cancel)
            .await?;
        Ok(client)
    }

    async fn discover(&mut self, cancel: &CancellationToken) -> Result<bool> {
        self.id += 1;
        let id = self.id;
        let body = json!({"jsonrpc":"2.0","id":id,"method":"server/discover","params":{"_meta":self.metadata()}});
        let mut request = self
            .client
            .post(self.url.clone())
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header("MCP-Protocol-Version", MCP_MODERN)
            .header("Mcp-Method", "server/discover")
            .json(&body);
        if let Some(key) = &self.key {
            request = secret_header(request, "authorization", &format!("Bearer {key}"))?;
        }
        let reply = receive(request, self.key.as_deref(), Some(id), true, cancel).await?;
        let message = if reply
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"))
        {
            sse_reply(&reply.bytes, id).ok()
        } else {
            serde_json::from_slice::<Value>(&reply.bytes).ok()
        };
        let matching = message
            .as_ref()
            .filter(|message| message["jsonrpc"] == "2.0" && message["id"] == id);
        if let Some(message) = matching {
            if message["error"]["code"] == -32022 {
                let supported = message["error"]["data"]["supported"].as_array();
                if supported.is_some_and(|versions| {
                    versions
                        .iter()
                        .any(|v| v.as_str().is_some_and(|v| MCP_VERSIONS.contains(&v)))
                }) {
                    return Ok(false);
                }
                return Err(invalid("MCP 服务没有与本应用兼容的协议版本"));
            }
            if message["error"]["code"] == -32601 && reply.status == 200 {
                return Ok(false);
            }
            if matches!(message["error"]["code"].as_i64(), Some(-32020 | -32021))
                || (message["error"]["code"] == -32601 && reply.status == 404)
            {
                return Err(invalid(
                    "MCP 现代协议发现失败，请检查服务的元数据与能力支持",
                ));
            }
            if reply.status < 300 && message["error"].is_null() {
                let result = &message["result"];
                if !result["supportedVersions"]
                    .as_array()
                    .is_some_and(|versions| versions.iter().any(|v| v == MCP_MODERN))
                {
                    return Err(invalid("MCP 发现结果未包含受支持的现代协议版本"));
                }
                if !result["capabilities"]["tools"].is_object()
                    && !result["capabilities"]["resources"].is_object()
                {
                    return Err(invalid("MCP 服务未声明工具或资料能力"));
                }
                return Ok(true);
            }
        }
        // Only an unrecognized legacy-era 4xx permits a handshake fallback.
        // Authentication and server failures never cause blind alternate calls.
        if matches!(reply.status, 400 | 404 | 405) {
            Ok(false)
        } else {
            Err(invalid("MCP 服务发现失败，请检查地址、授权与协议支持"))
        }
    }

    fn metadata(&self) -> Value {
        json!({"io.modelcontextprotocol/protocolVersion":self.version,"io.modelcontextprotocol/clientInfo":{"name":"story-agent","version":"1.0"},"io.modelcontextprotocol/clientCapabilities":{}})
    }

    async fn rpc(
        &mut self,
        method: &str,
        params: Option<Value>,
        notification: bool,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.id += 1;
        let id = self.id;
        let mut body = json!({"jsonrpc":"2.0","method":method});
        if !notification {
            body["id"] = json!(id);
        }
        if let Some(params) = params {
            body["params"] = params;
        }
        if self.version == MCP_MODERN {
            if !body["params"].is_object() {
                body["params"] = json!({});
            }
            body["params"]["_meta"] = self.metadata();
        }
        let mut request = self
            .client
            .post(self.url.clone())
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header("MCP-Protocol-Version", &self.version)
            .json(&body);
        if self.version == MCP_MODERN {
            request = request.header("Mcp-Method", method);
            if let Some(name) = body["params"]["name"].as_str() {
                request = request.header("Mcp-Name", mcp_header_value(name));
                if let Some(schema) = self.schemas.get(name) {
                    for (path, name, kind) in
                        schema_headers(schema).ok_or_else(|| invalid("MCP 工具的请求头定义无效"))?
                    {
                        let mut value = &body["params"]["arguments"];
                        for key in &path {
                            value = &value[key];
                        }
                        if value.is_null() {
                            continue;
                        }
                        let value = match kind.as_str() {
                            "string" => value.as_str().map(str::to_owned),
                            "boolean" => value.as_bool().map(|v| v.to_string()),
                            "integer" => value
                                .as_i64()
                                .filter(|v| v.unsigned_abs() <= 9_007_199_254_740_991)
                                .map(|v| v.to_string()),
                            _ => None,
                        }
                        .ok_or_else(|| invalid("MCP 请求头参数的类型或整数范围无效"))?;
                        request =
                            request.header(format!("Mcp-Param-{name}"), mcp_header_value(&value));
                    }
                }
            }
        }
        if let Some(key) = &self.key {
            request = secret_header(request, "authorization", &format!("Bearer {key}"))?;
        }
        if let Some(session) = &self.session {
            request = secret_header(request, "mcp-session-id", session)?;
        }
        let reply = receive(
            request,
            self.key.as_deref(),
            if notification { None } else { Some(id) },
            false,
            cancel,
        )
        .await?;
        if method == "initialize" {
            if let Some(session) = reply.headers.get("mcp-session-id") {
                let session = session.to_str().map_err(|_| invalid("MCP 会话标识无效"))?;
                if session.is_empty() || session.len() > 512 {
                    return Err(invalid("MCP 会话标识无效"));
                }
                self.session = Some(session.to_owned());
            }
        }
        if notification && reply.bytes.is_empty() {
            return Ok(Value::Null);
        }
        let content_type = reply
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let message = if content_type
            .to_ascii_lowercase()
            .contains("text/event-stream")
        {
            sse_reply(&reply.bytes, id)?
        } else {
            decode_json(&reply)?
        };
        if notification {
            return Ok(Value::Null);
        }
        if message["jsonrpc"] != "2.0" || message["id"] != id {
            return Err(invalid("MCP 响应与当前请求不匹配"));
        }
        if !message["error"].is_null() {
            return Err(invalid("MCP 服务拒绝了请求，请检查工具配置与协议兼容性"));
        }
        let result = message
            .get("result")
            .cloned()
            .ok_or_else(|| invalid("MCP 响应缺少结果"))?;
        if result["resultType"] == "input_required" || result.get("inputRequests").is_some() {
            return Err(invalid(
                "此 MCP 工具还需要额外授权或客户端交互，本次尚未执行完成",
            ));
        }
        Ok(result)
    }

    async fn list(&mut self, cancel: &CancellationToken) -> Result<Vec<Value>> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        let mut cursors = HashSet::new();
        for _ in 0..8 {
            let params = cursor.as_ref().map(|cursor| json!({"cursor":cursor}));
            let result = self.rpc("tools/list", params, false, cancel).await?;
            let page = result["tools"]
                .as_array()
                .ok_or_else(|| invalid("MCP 工具目录无效"))?;
            for tool in page {
                if tool["name"].as_str().is_none() || !tool["inputSchema"].is_object() {
                    return Err(invalid("MCP 工具定义无效"));
                }
                if self.version == MCP_MODERN && schema_headers(&tool["inputSchema"]).is_none() {
                    continue;
                }
                let name = tool["name"].as_str().unwrap();
                if self
                    .schemas
                    .insert(name.to_owned(), tool["inputSchema"].clone())
                    .is_some()
                {
                    return Err(invalid("MCP 工具目录包含重复名称"));
                }
                tools.push(tool.clone());
                if tools.len() > 128 {
                    return Err(invalid("MCP 工具目录过大，请减少服务提供的工具"));
                }
            }
            cursor = result["nextCursor"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
            if let Some(next) = &cursor {
                if next.len() > 4096 || !cursors.insert(next.clone()) {
                    return Err(invalid("MCP 工具目录分页无效"));
                }
            } else {
                return Ok(tools);
            }
        }
        Err(invalid("MCP 工具目录分页过多，请减少服务提供的工具"))
    }

    async fn call(
        &mut self,
        name: &str,
        arguments: Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.rpc(
            "tools/call",
            Some(json!({"name":name,"arguments":arguments})),
            false,
            cancel,
        )
        .await
    }

    async fn close(&self, cancel: &CancellationToken) {
        let Some(session) = &self.session else { return };
        let request = self
            .client
            .delete(self.url.clone())
            .header("MCP-Protocol-Version", &self.version);
        let Ok(mut request) = secret_header(request, "mcp-session-id", session) else {
            return;
        };
        if let Some(key) = &self.key {
            let Ok(authorized) = secret_header(request, "authorization", &format!("Bearer {key}"))
            else {
                return;
            };
            request = authorized;
        }
        // Session termination is optional (405 is permitted). Never replace a
        // completed tool result with a cleanup error or keep cancellation alive.
        tokio::select! {
            biased;
            _=cancel.cancelled()=>{},
            _=tokio::time::timeout(Duration::from_secs(2),request.send())=>{},
        }
    }
}

fn mcp_header_value(value: &str) -> String {
    if value.trim() == value
        && value
            .bytes()
            .all(|byte| (0x20..=0x7e).contains(&byte) || byte == b'\t')
        && !(value.starts_with("=?base64?") && value.ends_with("?="))
    {
        return value.to_owned();
    }
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::new();
    for bytes in value.as_bytes().chunks(3) {
        let a = bytes[0];
        let b = bytes.get(1).copied().unwrap_or(0);
        let c = bytes.get(2).copied().unwrap_or(0);
        encoded.push(TABLE[(a >> 2) as usize] as char);
        encoded.push(TABLE[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        encoded.push(if bytes.len() > 1 {
            TABLE[(((b & 15) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        encoded.push(if bytes.len() > 2 {
            TABLE[(c & 63) as usize] as char
        } else {
            '='
        });
    }
    format!("=?base64?{encoded}?=")
}

type HeaderSpec = (Vec<String>, String, String);

fn schema_headers(schema: &Value) -> Option<Vec<HeaderSpec>> {
    fn visit(
        value: &Value,
        path: &[String],
        reachable: bool,
        seen: &mut HashSet<String>,
        out: &mut Vec<HeaderSpec>,
        depth: usize,
    ) -> Option<()> {
        if depth > 32 {
            return None;
        }
        if let Some(name) = value.get("x-mcp-header") {
            let name = name.as_str()?;
            let kind = value["type"].as_str()?;
            if !reachable
                || path.is_empty()
                || name.is_empty()
                || !matches!(kind, "string" | "integer" | "boolean")
                || header::HeaderName::from_bytes(name.as_bytes()).is_err()
                || !seen.insert(name.to_ascii_lowercase())
            {
                return None;
            }
            out.push((path.to_vec(), name.to_owned(), kind.to_owned()));
        }
        match value {
            Value::Object(fields) => {
                for (key, nested) in fields {
                    if key == "properties" && reachable {
                        let properties = nested.as_object()?;
                        for (name, property) in properties {
                            let mut path = path.to_vec();
                            path.push(name.clone());
                            visit(property, &path, true, seen, out, depth + 1)?;
                        }
                    } else if key != "x-mcp-header" {
                        visit(nested, path, false, seen, out, depth + 1)?;
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, path, false, seen, out, depth + 1)?;
                }
            }
            _ => {}
        }
        Some(())
    }
    let mut out = Vec::new();
    visit(schema, &[], true, &mut HashSet::new(), &mut out, 0)?;
    Some(out)
}

fn sse_reply(bytes: &[u8], id: u64) -> Result<Value> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| invalid("MCP 事件流编码无效"))?
        .replace("\r\n", "\n");
    for event in text.split("\n\n") {
        let data = event
            .lines()
            .filter_map(|line| {
                line.strip_prefix("data:")
                    .map(|s| s.strip_prefix(' ').unwrap_or(s))
            })
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let message: Value =
            serde_json::from_str(&data).map_err(|_| invalid("MCP 事件流内容无效"))?;
        if message["id"] == id && message["method"].is_null() {
            return Ok(message);
        }
    }
    Err(invalid("MCP 事件流未包含当前请求结果"))
}

async fn mcp_search(
    client: &Client,
    network: &Value,
    query: &str,
    authorize: &Authorize,
    cancel: &CancellationToken,
) -> Result<Value> {
    for config in mcp_configs(network, None)? {
        let mut session = Mcp::connect(client, config, authorize, cancel).await?;
        let tools = session.list(cancel).await;
        if tools.is_err() {
            session.close(cancel).await;
        }
        let tools = tools?;
        let Some(tool) = tools.iter().find(|tool| {
            matches!(
                tool["name"].as_str(),
                Some("web_search" | "search" | "tavily_search" | "brave_web_search")
            ) && tool["inputSchema"]["properties"]["query"]["type"] == "string"
                && tool["inputSchema"]["required"]
                    .as_array()
                    .is_none_or(|fields| fields.iter().all(|field| field == "query"))
        }) else {
            session.close(cancel).await;
            continue;
        };
        let name = required(tool, "name")?;
        let result = session.call(name, json!({"query":query}), cancel).await;
        session.close(cancel).await;
        let result = result?;
        if result["isError"] == true {
            return Err(invalid("MCP 搜索工具返回失败，请检查服务配置"));
        }
        let mut sources = Vec::new();
        structured_sources(&result["structuredContent"], &mut sources, 0);
        let mut text = String::new();
        for content in result["content"].as_array().into_iter().flatten() {
            if content["type"] == "text" {
                if let Some(t) = content["text"].as_str() {
                    if let Ok(value) = serde_json::from_str::<Value>(t) {
                        structured_sources(&value, &mut sources, 0);
                    }
                    text.push_str(t);
                    text.push('\n');
                }
            }
        }
        let mut output = search_output("mcp", query, text, sources)?;
        output["serverId"] = config["id"].clone();
        return Ok(output);
    }
    Err(invalid(
        "已配置 MCP 未提供可直接搜索的工具；可先查看工具目录并按其参数调用",
    ))
}

fn structured_sources(value: &Value, sources: &mut Vec<Value>, depth: usize) {
    if depth > 8 || sources.len() >= 20 {
        return;
    }
    if let Some(url) = value["url"].as_str().or_else(|| value["uri"].as_str()) {
        add_source(
            sources,
            url,
            value["title"].as_str().unwrap_or(""),
            value["content"]
                .as_str()
                .or_else(|| value["text"].as_str())
                .unwrap_or(""),
        );
    }
    match value {
        Value::Array(items) => {
            for item in items {
                structured_sources(item, sources, depth + 1);
            }
        }
        Value::Object(items) => {
            for item in items.values() {
                if item.is_object() || item.is_array() {
                    structured_sources(item, sources, depth + 1);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_usage_normalization_keeps_unknowns_and_does_not_double_count_cache_or_reasoning() {
        use super::native_model_usage;
        use serde_json::json;
        assert_eq!(native_model_usage("openai-responses",&json!({})),json!({}));
        assert_eq!(native_model_usage("gemini",&json!({"usageMetadata":{"promptTokenCount":0,"candidatesTokenCount":0}})),json!({}));
        let responses=native_model_usage("openai-responses",&json!({"usage":{"input_tokens":100,"output_tokens":30,"input_tokens_details":{"cached_tokens":20},"output_tokens_details":{"reasoning_tokens":10},"total_tokens":130}}));
        assert_eq!(responses["input"],80);assert_eq!(responses["cacheRead"],20);assert_eq!(responses["output"],30);assert_eq!(responses["reasoning"],10);
        let anthropic=native_model_usage("anthropic",&json!({"usage":{"input_tokens":100,"output_tokens":30,"cache_read_input_tokens":20,"cache_creation_input_tokens":10}}));
        assert_eq!(anthropic["input"],100);assert_eq!(anthropic["cacheRead"],20);assert_eq!(anthropic["cacheWrite"],10);
        let gemini=native_model_usage("gemini",&json!({"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"cachedContentTokenCount":30,"thoughtsTokenCount":10,"totalTokenCount":130}}));
        assert_eq!(gemini["input"],70);assert_eq!(gemini["cacheRead"],30);assert_eq!(gemini["output"],30);assert_eq!(gemini["reasoning"],10);assert_eq!(gemini["totalTokens"],130);
    }
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn client() -> Client {
        Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    fn auth() -> Authorize {
        Arc::new(|slot, url| {
            assert_eq!(slot, "test-slot");
            assert!(url.starts_with("http://127.0.0.1:"));
            Ok("private-test-credential-9375".to_owned())
        })
    }

    fn server<F>(count: usize, mut handler: F) -> (String, thread::JoinHandle<()>)
    where
        F: FnMut(usize, &str, Value) -> (u16, Vec<(&'static str, String)>, String) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/endpoint", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let handle = thread::spawn(move || {
            for index in 0..count {
                let started = std::time::Instant::now();
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                started.elapsed() < Duration::from_secs(5),
                                "expected HTTP request not received"
                            );
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0u8; 4096];
                let split = loop {
                    let read = stream.read(&mut chunk).unwrap();
                    assert!(read > 0);
                    bytes.extend_from_slice(&chunk[..read]);
                    if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let head = String::from_utf8(bytes[..split].to_vec()).unwrap();
                let length = head
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                while bytes.len() < split + length {
                    let read = stream.read(&mut chunk).unwrap();
                    assert!(read > 0);
                    bytes.extend_from_slice(&chunk[..read]);
                }
                let body = if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes[split..split + length]).unwrap()
                };
                let (status, headers, body) = handler(index, &head.to_ascii_lowercase(), body);
                write!(
                    stream,
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                )
                .unwrap();
                for (name, value) in headers {
                    write!(stream, "{name}: {value}\r\n").unwrap();
                }
                write!(stream, "\r\n").unwrap();
                // Size-limit and cancellation checks can close the socket
                // before a deliberately oversized test body is fully written.
                let _ = stream.write_all(body.as_bytes());
            }
        });
        (url, handle)
    }

    fn json_response(value: Value) -> (u16, Vec<(&'static str, String)>, String) {
        (
            200,
            vec![("Content-Type", "application/json".to_owned())],
            value.to_string(),
        )
    }

    #[tokio::test]
    async fn inherited_gemini_stream_keeps_search_sources_and_usage_without_changing_its_endpoint(){
        let (url,handle)=server(1,|_,head,body|{
            assert!(head.contains("alt=sse"));assert!(body["tools"][0]["google_search"].is_object());
            let a=json!({"candidates":[{"content":{"parts":[{"text":"真实检索"}]}}]});
            let b=json!({"candidates":[{"content":{"parts":[{"text":"结果"}]},"groundingMetadata":{"groundingChunks":[{"web":{"uri":"https://example.org/evidence","title":"来源"}}]}}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":3,"cachedContentTokenCount":2}});
            (200,vec![("Content-Type","text/event-stream".into())],format!("data: {a}\n\ndata: {b}\n\n"))
        });
        let result=execute(client(),json!({"op":"web_search","query":"核实细节","network":{"mode":"native","native":{"enabled":true,"protocol":"gemini","url":format!("{url}?alt=sse"),"model":"configured","slot":"test-slot"}}}),auth(),CancellationToken::new()).await.unwrap();
        assert_eq!(result["sources"][0]["url"],"https://example.org/evidence");assert!(result["text"].as_str().unwrap().contains("真实检索结果"));assert_eq!(result["modelUsage"]["input"],10);assert_eq!(result["modelUsage"]["cacheRead"],2);handle.join().unwrap();
    }
    #[tokio::test]
    async fn known_native_rejection_falls_back_only_to_an_explicit_search_service(){
        let(url,handle)=server(2,|index,_,body|if index==0{assert!(body["tools"].is_array());(400,vec![("Content-Type","application/json".into())],"{\"error\":\"tools unsupported\"}".into())}else{json_response(json!({"results":[{"url":"https://example.org/source","title":"真实来源","content":"服务检索摘要"}]}))});
        let result=execute(client(),json!({"op":"web_search","query":"资料","network":{"mode":"auto","native":{"enabled":true,"protocol":"openai-responses","url":url,"model":"configured","slot":"test-slot"},"search":{"provider":"tavily","url":url,"slot":"test-slot"}}}),auth(),CancellationToken::new()).await.unwrap();
        assert_eq!(result["provider"],"tavily");assert_eq!(result["nativeCapability"]["fallback"],true);assert_eq!(result["sources"][0]["url"],"https://example.org/source");handle.join().unwrap();
    }

    #[tokio::test]
    async fn native_protocols_send_real_search_tools_and_keep_source_urls() {
        for protocol in ["openai-responses", "gemini", "anthropic"] {
            let (url, handle) = server(1, move |_, head, body| {
                let response = match protocol {
                    "openai-responses" => {
                        assert!(head.contains("authorization: bearer private-test-credential-9375"));
                        assert_eq!(body["tools"][0]["type"], "web_search");
                        assert_eq!(body["tool_choice"], "required");
                        json!({"output":[{"type":"web_search_call","action":{"sources":[{"url":"https://example.org/original","title":"原始来源"}]}},{"type":"message","content":[{"type":"output_text","text":"查证结果","annotations":[{"type":"url_citation","url":"https://example.org/original","title":"原始来源"}]}]}]})
                    }
                    "gemini" => {
                        assert!(head.contains("x-goog-api-key: private-test-credential-9375"));
                        assert!(body["tools"][0]["google_search"].is_object());
                        json!({"candidates":[{"content":{"parts":[{"text":"查证结果"}]},"groundingMetadata":{"groundingChunks":[{"web":{"uri":"https://example.org/original","title":"原始来源"}}],"searchEntryPoint":{"renderedContent":"<span>search attribution</span>"}}}]})
                    }
                    _ => {
                        assert!(head.contains("x-api-key: private-test-credential-9375"));
                        assert!(head.contains("anthropic-version: 2023-06-01"));
                        assert_eq!(body["tools"][0]["type"], "web_search_20250305");
                        json!({"content":[{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://example.org/original","title":"原始来源","encrypted_content":"do not expose"}]},{"type":"text","text":"查证结果"}]})
                    }
                };
                json_response(response)
            });
            let result=execute(client(),json!({"op":"web_search","query":"核对人物","network":{"mode":"auto","native":{"enabled":true,"protocol":protocol,"url":url,"model":"configured-model","slot":"test-slot"}}}),auth(),CancellationToken::new()).await.unwrap();
            assert_eq!(result["sources"].as_array().unwrap().len(), 1);
            assert_eq!(result["sources"][0]["url"], "https://example.org/original");
            assert_eq!(result["modelRequests"], 1);
            assert!(!result.to_string().contains("credential"));
            assert!(!result.to_string().contains("encrypted_content"));
            handle.join().unwrap();
        }
        assert!(search_output(
            "native",
            "query",
            "unverified model memory".to_owned(),
            vec![]
        )
        .is_err());
    }

    #[tokio::test]
    async fn configured_tavily_search_and_webpage_pagination() {
        let (url, handle) = server(1, |_, head, body| {
            assert!(head.contains("authorization: bearer private-test-credential-9375"));
            assert_eq!(body["query"], "原著人物");
            json_response(
                json!({"results":[{"url":"https://example.org/chapter/3","title":"第三章","content":"角色登场"}]}),
            )
        });
        let result=execute(client(),json!({"op":"web_search","query":"原著人物","network":{"mode":"configured","search":{"provider":"tavily","url":url,"slot":"test-slot"}}}),auth(),CancellationToken::new()).await.unwrap();
        assert_eq!(result["sources"][0]["text"], "角色登场");
        handle.join().unwrap();
        let (url, handle) = server(1, |_, head, _| {
            assert!(!head.contains("authorization:"));
            (200,vec![("Content-Type","text/html; charset=utf-8".to_owned())],"<html><title>章节 &amp; 出处</title><script>bad()</script><style>hidden</style><!-- private --><p>甲乙&#x4e19;丁</p><p>后文</p></html>".to_owned())
        });
        let result = execute(
            client(),
            json!({"op":"read_webpage","url":url,"offset":1,"limit":3,"network":{"mode":"auto"}}),
            auth(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(result["title"], "章节 & 出处");
        assert_eq!(result["text"], "乙丙丁");
        assert_eq!(result["nextOffset"], 4);
        assert_eq!(result["totalChars"], 7);
        assert_eq!(result["source"]["url"], result["url"]);
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn mcp_negotiates_session_paginates_and_calls_arbitrary_tool_with_sse() {
        let (url, handle) = server(7, |index, head, body| {
            assert!(head.contains("authorization: bearer private-test-credential-9375"));
            if index == 0 {
                assert_eq!(body["method"], "server/discover");
                assert_eq!(
                    body["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"],
                    MCP_MODERN
                );
                assert!(head.contains("mcp-method: server/discover"));
                return (400, vec![], String::new());
            }
            let index = index - 1;
            assert!(head.contains("mcp-protocol-version: 2025-11-25"));
            if index > 0 {
                assert!(head.contains("mcp-session-id: local-test-session"));
            }
            let id = body["id"].clone();
            match index {
                0 => {
                    assert_eq!(body["method"], "initialize");
                    assert_eq!(body["params"]["protocolVersion"], MCP_VERSION);
                    let mut response = json_response(
                        json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":MCP_VERSION,"capabilities":{"tools":{}},"serverInfo":{"name":"local","version":"1"}}}),
                    );
                    response
                        .1
                        .push(("Mcp-Session-Id", "local-test-session".to_owned()));
                    response
                }
                1 => {
                    assert_eq!(body["method"], "notifications/initialized");
                    assert!(body["id"].is_null());
                    (202, vec![], String::new())
                }
                2 => {
                    assert_eq!(body["method"], "tools/list");
                    json_response(
                        json!({"jsonrpc":"2.0","id":id,"result":{"tools":[{"name":"unusual_research_tool","inputSchema":{"type":"object"}}],"nextCursor":"page-2"}}),
                    )
                }
                3 => {
                    assert_eq!(body["params"]["cursor"], "page-2");
                    json_response(
                        json!({"jsonrpc":"2.0","id":id,"result":{"tools":[{"name":"other","inputSchema":{"type":"object"}}]}}),
                    )
                }
                4 => {
                    assert_eq!(body["method"], "tools/call");
                    assert_eq!(body["params"]["name"], "unusual_research_tool");
                    assert_eq!(body["params"]["arguments"]["topic"], "甲");
                    let event = json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":"外部工具结果"}],"isError":false}});
                    (200,vec![("Content-Type","text/event-stream".to_owned())],format!("event: message\r\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}}\r\n\r\nevent: message\r\ndata: {event}\r\n\r\n"))
                }
                _ => {
                    assert!(head.starts_with("delete "));
                    (204, vec![], String::new())
                }
            }
        });
        let result=execute(client(),json!({"op":"call_remote_tool","serverId":"local","name":"unusual_research_tool","arguments":{"topic":"甲"},"network":{"mode":"configured","mcps":[{"id":"local","name":"local MCP","url":url,"slot":"test-slot","enabled":true}]}}),auth(),CancellationToken::new()).await.unwrap();
        assert_eq!(result["result"]["content"][0]["text"], "外部工具结果");
        assert_eq!(result["isError"], false);
        assert!(!result.to_string().contains("local-test-session"));
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn modern_mcp_discovers_once_and_mirrors_safe_metadata_without_legacy_session() {
        let (url, handle) = server(3, |index, head, body| {
            assert!(head.contains("mcp-protocol-version: 2026-07-28"));
            assert!(!head.contains("mcp-session-id:"));
            let meta = &body["params"]["_meta"];
            assert_eq!(meta["io.modelcontextprotocol/protocolVersion"], MCP_MODERN);
            assert!(meta["io.modelcontextprotocol/clientCapabilities"].is_object());
            let id = body["id"].clone();
            let result = match index {
                0 => {
                    assert_eq!(body["method"], "server/discover");
                    assert!(head.contains("mcp-method: server/discover"));
                    json!({"resultType":"complete","supportedVersions":[MCP_MODERN],"capabilities":{"tools":{}}})
                }
                1 => {
                    assert_eq!(body["method"], "tools/list");
                    assert!(head.contains("mcp-method: tools/list"));
                    json!({"resultType":"complete","tools":[{"name":"inspect","inputSchema":{"type":"object","properties":{"greeting":{"type":"string","x-mcp-header":"Greeting"}}}},{"name":"invalid_header_tool","inputSchema":{"type":"object","properties":{"value":{"type":"number","x-mcp-header":"Bad"}}}}]})
                }
                _ => {
                    assert_eq!(body["method"], "tools/call");
                    assert!(head.contains("mcp-method: tools/call"));
                    assert!(head.contains("mcp-name: inspect"));
                    assert!(head.contains("mcp-param-greeting: =?base64?sgvsbg8sios4luevja==?="));
                    assert_eq!(body["params"]["arguments"]["greeting"], "Hello, 世界");
                    json!({"resultType":"complete","content":[{"type":"text","text":"modern result"}]})
                }
            };
            json_response(json!({"jsonrpc":"2.0","id":id,"result":result}))
        });
        let result=execute(client(),json!({"op":"call_remote_tool","serverId":"modern","name":"inspect","arguments":{"greeting":"Hello, 世界"},"network":{"mode":"configured","mcps":[{"id":"modern","url":url,"enabled":true}]}}),auth(),CancellationToken::new()).await.unwrap();
        assert_eq!(result["protocolVersion"], MCP_MODERN);
        assert_eq!(result["result"]["content"][0]["text"], "modern result");
        assert_eq!(
            mcp_header_value("Hello, 世界"),
            "=?base64?SGVsbG8sIOS4lueVjA==?="
        );
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn mcp_resources_and_scoped_directory_are_paged_and_cached() {
        let (url, handle) = server(6, |_,_,body| {
            let result=match body["method"].as_str().unwrap() {
                "server/discover"=>json!({"resultType":"complete","supportedVersions":[MCP_MODERN],"capabilities":{"tools":{},"resources":{}}}),
                "resources/list"=>json!({"resources":[{"uri":"fixture://note","name":"note"}],"nextCursor":"next"}),
                "resources/read"=>{assert_eq!(body["params"]["uri"],"fixture://note");json!({"contents":[{"uri":"fixture://note","mimeType":"text/plain","text":"甲乙丙丁戊"}]})},
                "tools/list"=>json!({"tools":[{"name":"inspect","description":"read note","inputSchema":{"type":"object"}},{"name":"erase","inputSchema":{"type":"object"}}]}),
                _=>panic!("unexpected request")
            };json_response(json!({"jsonrpc":"2.0","id":body["id"],"result":result}))
        });
        let network=json!({"mode":"configured","mcps":[{"id":"scoped","url":url,"enabled":true,"authorizationVersion":1,"allowedTools":["inspect"]}]});
        let execute_op=|op:&str,extra:Value|{let mut req=json!({"op":op,"network":network,"serverId":"scoped"});req.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());execute(client(),req,auth(),CancellationToken::new())};
        let listed=execute_op("list_mcp_resources",json!({})).await.unwrap();assert_eq!(listed["nextCursor"],"next");
        let read=execute_op("read_mcp_resource",json!({"uri":"fixture://note","offset":2,"limit":2})).await.unwrap();assert_eq!(read["contents"][0]["text"],"丙丁");
        let directory=execute_op("list_remote_tools",json!({})).await.unwrap();assert_eq!(directory["servers"][0]["total"],1);assert!(directory["servers"][0]["tools"][0].get("inputSchema").is_none());
        let schema=execute_op("list_remote_tools",json!({"name":"inspect"})).await.unwrap();assert!(schema["servers"][0]["tools"][0]["inputSchema"].is_object());
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn disabled_unconfigured_and_cancelled_do_not_authorize_or_connect() {
        let no_auth: Authorize = Arc::new(|_, _| panic!("no credential should be read"));
        for network in [
            json!({"mode":"off"}),
            json!({"mode":"auto"}),
            json!({"mode":"native","native":{"enabled":false}}),
        ] {
            let error = execute(
                client(),
                json!({"op":"web_search","query":"query","network":network}),
                no_auth.clone(),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert!(matches!(error, Error::Invalid(_)));
        }
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = execute(
            client(),
            json!({"op":"web_search","network":{"mode":"auto"}}),
            no_auth,
            cancel,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, Error::Cancelled));
    }

    #[tokio::test]
    async fn credential_echo_redirect_and_oversize_are_rejected_without_details() {
        for scenario in 0..3 {
            let (url, handle) = server(1, move |_, _, _| match scenario {
                0 => json_response(json!({"error":"private-test-credential-9375"})),
                1 => (
                    302,
                    vec![("Location", "http://127.0.0.1:1/must-not-follow".to_owned())],
                    String::new(),
                ),
                _ => (
                    200,
                    vec![("Content-Type", "application/json".to_owned())],
                    " ".repeat(MAX_RESPONSE + 1),
                ),
            });
            let error=execute(client(),json!({"op":"web_search","query":"q","network":{"mode":"configured","search":{"provider":"tavily","url":url,"slot":"test-slot"}}}),auth(),CancellationToken::new()).await.unwrap_err().to_string();
            assert!(!error.contains("private-test"));
            assert!(!error.contains("127.0.0.1"));
            handle.join().unwrap();
        }
    }
}
