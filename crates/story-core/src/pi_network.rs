//! Task-scoped network references; credential material is never accepted here.
use crate::{agent_policy, Error, Result};
use serde_json::{json, Map, Value};

fn fields(value: &Value, names: &[&str]) -> Result<Value> {
    let mut out = Map::new();
    for name in names {
        if let Some(v) = value.get(name).filter(|v| !v.is_null()) {
            let valid = match *name {
                "enabled" | "allowResources" => v.is_boolean(),
                "authorizationVersion" => v.as_u64().is_some(),
                "allowedTools" | "readOnlyTools" => v.as_array().is_some_and(|items| {
                    items.len() <= 500
                        && items.iter().all(|s| {
                            s.as_str()
                                .is_some_and(|n| !n.is_empty() && n.len() <= 256 && n != "*")
                        })
                }),
                _ => v.as_str().is_some_and(|s| s.len() <= 8192),
            };
            if !valid {
                return Err(Error::Invalid("联网配置字段类型或范围无效".into()));
            }
            out.insert((*name).into(), v.clone());
        }
    }
    Ok(Value::Object(out))
}
pub(crate) fn snapshot(raw: &Value) -> Result<Value> {
    if raw.is_null() {
        return Ok(json!({"mode":"auto","mcps":[]}));
    }
    if !raw.is_object() {
        return Err(Error::Invalid("联网配置无效".into()));
    }
    let mode = raw["mode"].as_str().unwrap_or("auto");
    if !["off", "auto", "native", "configured"].contains(&mode) {
        return Err(Error::Invalid("联网方式无效".into()));
    }
    let mut result = json!({"mode":mode});
    for (name, keys) in [
        ("search", &["provider", "slot", "url"][..]),
        (
            "native",
            &["binding", "protocol", "enabled", "url", "model", "slot"][..],
        ),
    ] {
        if raw[name].is_object() {
            result[name] = fields(&raw[name], keys)?;
        }
    }
    if !result["native"].is_object() {
        result["native"]=json!({"binding":"task","enabled":true});
    } else if !result["native"]["binding"].is_string() {
        result["native"]["binding"]="profile".into();
    }
    if !["task","profile"].contains(&result["native"]["binding"].as_str().unwrap_or("")) {
        return Err(Error::Invalid("搜索模型绑定无效".into()));
    }
    let servers = raw["mcps"].as_array().cloned().unwrap_or_default();
    if servers.len() > 32 {
        return Err(Error::Invalid("MCP服务过多，请保留本次需要的服务".into()));
    }
    let mut ids = std::collections::HashSet::new();
    let mut normalized = vec![];
    for server in servers {
        let server = fields(
            &server,
            &[
                "id",
                "name",
                "url",
                "slot",
                "enabled",
                "allowedTools",
                "readOnlyTools",
                "authorizationVersion",
                "authorizationIdentity",
                "allowResources",
            ],
        )?;
        if !server["id"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 128 && ids.insert(s.to_owned()))
        {
            return Err(Error::Invalid("MCP服务标识缺失或重复".into()));
        }
        normalized.push(server);
    }
    result["mcps"] = json!(normalized);
    if result.to_string().len() > 256 * 1024 {
        return Err(Error::Invalid("联网配置过长".into()));
    }
    Ok(result)
}

/// Resolve the inherited binding from this execution's frozen model. This
/// works with safe references for accounting and the in-memory resolved model
/// for transport. Authentication bytes are never copied into a network DTO.
pub(crate) fn bind_model(raw: &Value, model: &Value) -> Value {
    let mut network=raw.clone();
    if !network.is_object() { network=json!({"mode":"auto"}); }
    if network["native"]["binding"]=="task" || !network["native"].is_object() {
        let enabled=network["native"]["enabled"].as_bool().unwrap_or(true);
        let protocol=model["protocol"].as_str().unwrap_or("chat-completions");
        let base=model["baseUrl"].as_str().unwrap_or("").trim_end_matches('/');
        let endpoint=model["url"].as_str().map(str::to_owned).unwrap_or_else(|| {
            if base.is_empty() || model["endpointRef"].is_string() {return base.to_owned();}
            format!("{base}{}",match protocol {"openai-responses"=>"/responses","anthropic"=>"/messages","gemini"=>"/models/{model}:generateContent",_=>"/chat/completions"})
        });
        network["native"]=json!({"binding":"task","enabled":enabled,
            "protocol":protocol,"model":model.get("id").or_else(||model.get("model")).cloned().unwrap_or(Value::Null),
            "slot":model["slot"],"url":endpoint,"endpointRef":model["endpointRef"],
            "capability":if ["openai-responses","gemini","anthropic"].contains(&protocol){"unconfirmed"}else{"unsupported"}});
    }
    network
}

#[cfg(test)]
mod binding_tests {
    use super::*;
    #[test]
    fn current_binding_follows_frozen_task_and_never_copies_credentials() {
        let raw=snapshot(&json!({"mode":"native"})).unwrap();
        let model=json!({"protocol":"gemini","id":"selected","url":"https://example.invalid/generate","slot":"agent","apiKey":"never-return"});
        let result=bind_model(&raw,&model);
        assert_eq!(result["native"]["model"],"selected"); assert!(!result.to_string().contains("never-return"));
        assert_eq!(raw["native"],json!({"binding":"task","enabled":true}));
        let old=snapshot(&json!({"native":{"enabled":true,"model":"independent","protocol":"anthropic","url":"https://example.invalid/messages","slot":"other"}})).unwrap();
        assert_eq!(bind_model(&old,&model)["native"]["model"],"independent");
        assert_eq!(old["native"]["binding"],"profile");
        let resolved=bind_model(&raw,&json!({"id":"selected","protocol":"openai-responses","baseUrl":"https://example.invalid/v1","slot":"agent"}));
        assert_eq!(resolved["native"]["url"],"https://example.invalid/v1/responses");
        let full=bind_model(&raw,&json!({"id":"selected","protocol":"anthropic","baseUrl":"https://example.invalid/custom/messages","endpointRef":"bound","slot":"agent"}));
        assert_eq!(full["native"]["url"],"https://example.invalid/custom/messages");
    }
}

pub(crate) fn authorize(raw: &Value) -> Result<Value> {
    let mut network = snapshot(raw)?;
    for server in network["mcps"].as_array_mut().into_iter().flatten() {
        let allowed = server["allowedTools"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let readonly = server["readOnlyTools"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if allowed.len() > 500
            || allowed.iter().any(|s| {
                !s.as_str()
                    .is_some_and(|n| !n.is_empty() && n.len() <= 256 && n != "*")
            })
            || readonly.iter().any(|n| !allowed.contains(n))
        {
            return Err(Error::Invalid(
                "请明确选择允许的工具，只读范围须包含在允许范围中".into(),
            ));
        }
        server["allowedTools"] = json!(allowed);
        server["readOnlyTools"] = json!(readonly);
        server["authorizationVersion"] = server["authorizationVersion"]
            .as_u64()
            .unwrap_or(0)
            .saturating_add(1)
            .into();
        server["authorizationIdentity"] = agent_policy::service_identity(server).into();
    }
    Ok(json!({"network":network}))
}
