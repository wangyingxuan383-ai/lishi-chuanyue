//! Authority is independent of the local commit policy. The same checks cover
//! direct calls, script host calls, and delegated read-only work.
use crate::{runtime::Engine, Error, Result, RunPlan};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(crate) fn read_only(name: &str) -> bool {
    matches!(
        name,
        "list_resources"
            | "read_external_resource" | "read_commit_receipt" | "read_committed_snapshot" | "list_tool_packages" | "list_documents" | "read_document" | "find_document"
            | "discover_tools"
            | "read_resource"
            | "read_tool_result"
            | "read_player_choices"
            | "search_resources"
            | "list_skills"
            | "read_skill"
            | "read_skill_resource"
            | "read_world"
            | "check_draft"
            | "validate_changes"
            | "search_original"
            | "read_original"
            | "read_canon_facts"
            | "web_search"
            | "read_webpage" | "browser_open" | "browser_read" | "browser_find" | "browser_follow" | "browser_close"
            | "list_remote_tools"
            | "read_mcp_resource"
            | "list_mcp_resources"
            | "read_clock"
            | "search_agent_history"
            | "read_agent_history" | "read_timeline" | "read_evidence" | "read_fact_sources" | "record_findings"
            | "read_plan"
            | "ask_user"
            | "update_plan"
            | "record_skill_check"
    )
}
pub(crate) fn service_identity(service: &Value) -> String {
    let data = json!({"id":service["id"],"url":service["url"],"slot":service["slot"]});
    format!("{:x}", Sha256::digest(data.to_string().as_bytes()))
}
pub(crate) fn check(plan: &RunPlan, name: &str, args: &Value) -> Result<()> {
    let agent = &plan.meta["agent"];
    let child = agent["parentTaskId"].is_string() || agent["subtaskReadOnly"] == true;
    let readonly = child || agent["readOnly"] == true;
    if (name == "run_script" || name=="call_tool_package") && !child {
        return Ok(());
    }
    if matches!(name, "read_mcp_resource" | "list_mcp_resources") {
        let server = args["serverId"].as_str().unwrap_or("");
        let config = agent["network"]["mcps"]
            .as_array()
            .and_then(|a| a.iter().find(|s| s["id"] == server && s["enabled"] == true))
            .ok_or_else(|| Error::Invalid("此MCP服务未启用".into()))?;
        if config["allowResources"] != true
            || config["authorizationIdentity"].as_str() != Some(service_identity(config).as_str())
        {
            return Err(Error::Invalid(
                "尚未授权读取此服务的资料，请在联网设置中启用".into(),
            ));
        }
    }
    if name == "call_remote_tool" {
        let server = args["serverId"].as_str().unwrap_or("");
        let tool = args["name"].as_str().unwrap_or("");
        let config = agent["network"]["mcps"]
            .as_array()
            .and_then(|a| a.iter().find(|x| x["id"] == server && x["enabled"] == true))
            .ok_or_else(|| Error::Invalid("此MCP服务未启用".into()))?;
        let permitted = config["allowedTools"]
            .as_array()
            .is_some_and(|a| a.iter().any(|s| s == tool));
        let identity = config["authorizationIdentity"].as_str().unwrap_or("");
        if !permitted
            || config["authorizationVersion"].as_u64().unwrap_or(0) == 0
            || identity != service_identity(config)
        {
            return Err(Error::Invalid(
                "此MCP工具尚未获得当前服务的授权，请在联网设置中选择允许的工具范围".into(),
            ));
        }
        if readonly
            && !config["readOnlyTools"]
                .as_array()
                .is_some_and(|a| a.iter().any(|s| s == tool))
        {
            return Err(Error::Invalid(
                "当前是只读任务，此远端工具未被授权为只读".into(),
            ));
        }
        return Ok(());
    }
    if child
        && matches!(
            name,
            "draft_skill"
                | "delegate_readonly"
                | "stage_edit"
                | "stage_story_turn"
                | "stage_route"
                | "stage_clock"
                | "finish_task" | "run_script" | "call_tool_package" | "draft_tool_package"
        )
    {
        return Err(Error::Invalid(
            "只读子任务不能修改本局、技能或继续派生".into(),
        ));
    }
    if readonly && !read_only(name) && !matches!(name, "finish_task" | "delegate_readonly" | "run_script" | "call_tool_package") {
        return Err(Error::Invalid(
            "本次任务只读，不能修改本局或外部资料".into(),
        ));
    }
    Ok(())
}

pub(crate) fn metadata(name: &str) -> Value {
    json!({"readOnly":read_only(name),"effect":if read_only(name){"read"}else if name=="call_remote_tool"{"external"}else{"draft"},"parallel":read_only(name)&&!matches!(name,"ask_user"|"update_plan"|"discover_tools")})
}

pub(crate) fn is_external_write(plan: &RunPlan, name: &str, args: &Value) -> bool {
    if name != "call_remote_tool" {
        return false;
    }
    !plan.meta["agent"]["network"]["mcps"]
        .as_array()
        .and_then(|a| a.iter().find(|s| s["id"] == args["serverId"]))
        .is_some_and(|s| {
            s["readOnlyTools"]
                .as_array()
                .is_some_and(|a| a.iter().any(|n| n == &args["name"]))
        })
}

impl Engine {
    /// UI control requests may perform capability discovery without a model
    /// request. Model tool calls still pass the task-scoped authority gateway.
    pub async fn agent_request(self: &Arc<Self>, request: Value) -> Result<Value> {
        match request["op"].as_str().unwrap_or("") {
            "network_tools" => {
                let mut network = request["network"].clone();
                if !network.is_object() {
                    return Err(Error::Invalid("请先配置MCP服务".into()));
                }
                network["mode"] = "configured".into();
                self.model.network(json!({"op":"list_remote_tools","network":network,"serverId":request["serverId"],"userDiscovery":true,"limit":500}),CancellationToken::new()).await
            }
            "network_authorize" => {
                let mut network = request["network"].clone();
                if !network.is_object() {
                    return Err(Error::Invalid("联网配置无效".into()));
                }
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
                            "请明确选择允许的工具，只读工具必须在允许范围内".into(),
                        ));
                    }
                    server["allowedTools"] = json!(allowed);
                    server["readOnlyTools"] = json!(readonly);
                    server["authorizationVersion"] = json!(server["authorizationVersion"]
                        .as_u64()
                        .unwrap_or(0)
                        .saturating_add(1));
                    server["authorizationIdentity"] = service_identity(server).into();
                }
                Ok(json!({"network":network}))
            }
            _ => self.agent(request),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn read_only_script_wrappers_do_not_confer_child_executor_authority() {
        let mut p:RunPlan=serde_json::from_value(json!({"id":"r","worldId":"w","lineId":"l","headId":"n","kind":"pi_task","model":{"slot":"s","url":"https://test.invalid","model":"m","includeUsage":false},"messages":[],"extractMessages":[],"state":{},"settings":{},"options":{},"action":{},"meta":{"agent":{"readOnly":true}}})).unwrap();
        assert!(check(&p,"run_script",&json!({})).is_ok());
        assert!(check(&p,"call_tool_package",&json!({})).is_ok());
        assert!(check(&p,"write_document",&json!({})).is_err());
        p.meta["agent"]["parentTaskId"]="root-task".into();
        assert!(check(&p,"run_script",&json!({})).is_err());
        assert!(check(&p,"call_tool_package",&json!({})).is_err());
        assert!(check(&p,"read_document",&json!({})).is_ok());
    }
    #[test]
    fn external_grant_is_bound_to_service_and_read_scope() {
        let mut p:RunPlan=serde_json::from_value(json!({"id":"r","worldId":"w","lineId":"l","headId":"n","kind":"agent_task","model":{"slot":"s","url":"https://test.invalid","model":"m","includeUsage":false},"messages":[],"extractMessages":[],"state":{},"settings":{},"options":{},"action":{},"meta":{"agent":{"readOnly":true,"network":{"mcps":[]}}}})).unwrap();
        let mut server = json!({"id":"s","url":"https://test.invalid/mcp","enabled":true,"authorizationVersion":1,"allowedTools":["read","write"],"readOnlyTools":["read"]});
        server["authorizationIdentity"] = service_identity(&server).into();
        p.meta["agent"]["network"]["mcps"] = json!([server]);
        assert!(check(
            &p,
            "call_remote_tool",
            &json!({"serverId":"s","name":"read"})
        )
        .is_ok());
        assert!(check(
            &p,
            "call_remote_tool",
            &json!({"serverId":"s","name":"write"})
        )
        .is_err());
        p.meta["agent"]["network"]["mcps"][0]["url"] = "https://changed.invalid/mcp".into();
        assert!(check(
            &p,
            "call_remote_tool",
            &json!({"serverId":"s","name":"read"})
        )
        .is_err());
    }
}
