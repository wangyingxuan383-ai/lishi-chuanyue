//! Current grants intersect the execution snapshot; declarations grant nothing.
use crate::{agent_workspace as ws, Error, Result, RunPlan, Store};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

pub(crate) fn describe(name: &str, read_only: bool) -> Value {
    let capability=if name.ends_with("document")||name=="list_documents" {"file"}
        else if name.contains("mcp") || matches!(name,"call_remote_tool"|"list_remote_tools") {"mcp"}
        else if (matches!(name,"web_search"|"read_webpage")||name.starts_with("browser_")) {"web"}
        else if matches!(name,"read_commit_receipt"|"read_committed_snapshot") {"receipt"}
        else if name.contains("skill") || name=="run_script" {"package"} else {"story"};
    let control=matches!(name,"ask_user"|"update_plan"|"discover_tools"|"record_findings"|"record_skill_check");
    json!({"capability":capability,"effect":if name=="finish_task"{"formal_commit"}else if control{"task_control"}else if name=="call_remote_tool"{"external_dynamic"}else if name=="write_document"{"external_write"}else if read_only{"read"}else{"draft"},
        "platforms":["android","windows","development"],"parallel":read_only&&!control,"cancellation":"task","resultDelivery":"bounded-with-ref"})
}

pub(crate) fn authorize_network(store: &Store, raw: &Value) -> Result<Value> {
    let network=crate::pi_network::authorize(raw)?["network"].clone();
    let mut db=store.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    crate::maintenance::guard(&tx)?;
    tx.execute("UPDATE agent_capability_grants SET enabled=0,revision=revision+1,updated_at=? WHERE kind='mcp'",[ws::now()])?;
    for server in network["mcps"].as_array().into_iter().flatten() {
        tx.execute("INSERT INTO agent_capability_grants(id,kind,scope_json,mode,revision,enabled,created_at,updated_at) VALUES(?,'mcp',?,'configured',?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope_json=excluded.scope_json,revision=agent_capability_grants.revision+1,enabled=excluded.enabled,updated_at=excluded.updated_at",
            params![format!("mcp:{}",ws::text(server,"id")),server.to_string(),server["authorizationVersion"].as_i64().unwrap_or(1),i64::from(server["enabled"]==true),ws::now(),ws::now()])?;
    }
    tx.commit()?;Ok(json!({"network":network}))
}

pub(crate) fn check(db:&Connection,plan:&RunPlan,name:&str,args:&Value)->Result<()> {
    if !matches!(name,"call_remote_tool"|"read_mcp_resource"|"list_mcp_resources"|"list_remote_tools") {return Ok(());}
    let server=ws::text(args,"serverId");
    if server.is_empty(){return Ok(());}
    let grant:Option<(String,i64)>=db.query_row("SELECT scope_json,enabled FROM agent_capability_grants WHERE id=? AND kind='mcp'",[format!("mcp:{server}")],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
    // Pre-migration grants keep their already-authorized frozen scope until
    // the player saves current configuration; nothing is silently broadened.
    let Some((raw,enabled))=grant else{return Ok(());};
    let current=ws::parse(&raw);
    let frozen=plan.meta["agent"]["network"]["mcps"].as_array().into_iter().flatten().find(|entry|entry["id"]==server);
    let valid=frozen.is_some_and(|frozen|current["url"]==frozen["url"]&&current["slot"]==frozen["slot"]);
    let allowed=match name {
        "call_remote_tool"=>current["allowedTools"].as_array().is_some_and(|tools|tools.contains(&args["name"]))
            && (plan.meta["agent"]["readOnly"]!=true || current["readOnlyTools"].as_array().is_some_and(|tools|tools.contains(&args["name"]))),
        "read_mcp_resource"|"list_mcp_resources"=>current["allowResources"]==true,
        _=>true,
    };
    if enabled!=1||!valid||!allowed {return Err(Error::Tool{code:"capability_revoked".into(),field:"serverId".into(),message:"此服务或工具的当前授权已撤销或改变，未沿用旧任务权限执行".into(),next:json!({"action":"review_network_settings"})});}
    Ok(())
}

/// Search fallback and discovery also intersect current service grants; they
/// cannot use a broader frozen MCP list as an alternate authorization route.
pub(crate) fn effective_network(db:&Connection,network:&Value,readonly:bool)->Result<Value>{
    let mut result=network.clone();let mut servers=vec![];
    for frozen in network["mcps"].as_array().into_iter().flatten(){
        let saved:Option<(String,i64)>=db.query_row("SELECT scope_json,enabled FROM agent_capability_grants WHERE kind='mcp' AND id=?",[format!("mcp:{}",ws::text(frozen,"id"))],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((raw,enabled))=saved else{servers.push(frozen.clone());continue;};
        let current=ws::parse(&raw);if enabled!=1||current["url"]!=frozen["url"]||current["slot"]!=frozen["slot"]{continue;}
        let mut server=frozen.clone();
        for key in ["allowedTools","readOnlyTools"]{
            server[key]=json!(frozen[key].as_array().into_iter().flatten().filter(|tool|current[key].as_array().is_some_and(|now|now.contains(tool))&&(!readonly||current["readOnlyTools"].as_array().is_some_and(|now|now.contains(tool)))).cloned().collect::<Vec<_>>());
        }
        server["allowResources"]=(frozen["allowResources"]==true&&current["allowResources"]==true).into();
        // The permitted subset has a new identity; it is still bounded by
        // both explicit grants rather than trusting the service's metadata.
        server["authorizationIdentity"]=crate::agent_policy::service_identity(&server).into();servers.push(server);
    }
    result["mcps"]=servers.into();Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc,Mutex};
    #[test]
    fn revoking_current_scope_blocks_a_frozen_task_without_granting_new_tools(){
        let store=Store(Arc::new(Mutex::new(Connection::open_in_memory().unwrap())));
        crate::pi_store::PiStore(store.clone()).initialize().unwrap();
        let raw=json!({"mode":"configured","mcps":[{"id":"source","url":"https://source.invalid/mcp","enabled":true,"allowedTools":["read"],"readOnlyTools":["read"],"allowResources":true}]});
        let authorized=authorize_network(&store,&raw).unwrap()["network"].clone();
        let plan:RunPlan=serde_json::from_value(json!({"id":"task","worldId":"world","lineId":"line","headId":"head","kind":"pi_task","model":{"slot":"","url":"","model":"","includeUsage":false},"messages":[],"extractMessages":[],"state":{},"settings":{},"options":{},"action":{},"meta":{"agent":{"network":authorized,"readOnly":true}}})).unwrap();
        assert!(check(&*store.lock().unwrap(),&plan,"call_remote_tool",&json!({"serverId":"source","name":"read"})).is_ok());
        assert!(check(&*store.lock().unwrap(),&plan,"call_remote_tool",&json!({"serverId":"source","name":"write"})).is_err());
        authorize_network(&store,&json!({"mode":"configured","mcps":[]})).unwrap();
        assert!(matches!(check(&*store.lock().unwrap(),&plan,"call_remote_tool",&json!({"serverId":"source","name":"read"})),Err(Error::Tool{code,..}) if code=="capability_revoked"));
        assert!(check(&*store.lock().unwrap(),&plan,"read_mcp_resource",&json!({"serverId":"source"})).is_err());
    }
}
