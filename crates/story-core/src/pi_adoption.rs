//! Formal provenance is story data, independent of Agent chat lifetime.
use crate::{agent_workspace as ws, pi_store::arguments_hash, Error, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub(crate) fn sources(db:&Connection,task:&Value,batch:&str,report:Option<&Value>,selected:&Value,line:&str)->Result<()> {
    let Some(report)=report else{return Ok(());};
    let allowed=selected.as_array().into_iter().flatten().filter_map(|r|r["groupId"].as_str()).collect::<std::collections::BTreeSet<_>>();
    for finding in report["normalizedFindings"].as_array().into_iter().flatten().filter(|f|f["eligibleForAdoption"]==true) {
        for resource in finding["resources"].as_array().into_iter().flatten().filter(|r|allowed.contains(ws::text(r,"groupId"))) {
            let raw_kind=ws::text(resource,"kind");
            // Resource selections may only carry fingerprints. Resolve their
            // kind/id against the exact full workspace that was verified.
            let work=ws::parse(ws::text(task,"workspace_json"));
            let groups=crate::pi_verification::resource_groups(&work)?;
            let group=groups.as_array().into_iter().flatten().find(|g|g["groupId"]==resource["groupId"]).unwrap_or(resource);
            let kind=if raw_kind.is_empty(){ws::text(group,"kind")}else{raw_kind};
            let old=ws::text(group,"id");
            let node=if ["node","state","protagonist","people","places","cards","goals","facts"].contains(&kind){
                let fallback=ws::parse(ws::text(task,"base_json"));
                let old=if old.is_empty(){ws::text(&fallback,"headId")}else{old};
                Some(crate::pi_rebase::map_node(db,ws::text(task,"world_id"),line,old)?)
            }else{None};
            let id=arguments_hash(&json!([batch,finding["id"],resource["groupId"]]));
            let source=json!({"findingId":finding["id"],"goalId":finding["goalId"],"topic":finding["topic"],"references":finding["references"],"sourceClaim":finding["sourceClaim"],"revisionDecision":finding["revisionDecision"],"interpretationVerified":false,"groupId":resource["groupId"]});
            db.execute("INSERT INTO story_fact_sources(id,world_id,line_id,node_id,resource_kind,resource_id,batch_id,task_id,basis,claim,source_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",params![id,ws::text(task,"world_id"),line,node,kind,old,batch,ws::text(task,"id"),ws::text(finding,"basis"),ws::text(finding,"claim"),source.to_string(),ws::now()])?;
        }
    }
    Ok(())
}
pub(crate) fn check_no_conflicts(work:&Value)->Result<()> {
    if work["edits"].as_array().into_iter().flatten().any(|e|e["rebaseConflicts"].as_array().is_some_and(|v|!v.is_empty())) {
        return Err(Error::Tool{code:"draft_rebase_conflict",field:"edits",message:"草稿包含待重新核对的冲突字段，尚不能完成".into(),next:json!({"tool":"check_draft","args":{}})});
    }
    Ok(())
}
