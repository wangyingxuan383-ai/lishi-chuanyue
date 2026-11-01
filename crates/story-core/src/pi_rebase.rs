//! Re-read authoritative story data; a summary never rebases a draft.
use crate::{agent_workspace as ws, Error, Result, RunPlan};
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};

fn merge(before:Option<&Value>, current:Option<&Value>, proposed:Option<&Value>, path:&str, conflicts:&mut Vec<Value>)->Option<Value> {
    if proposed==before { return current.cloned(); }
    if current==before || current==proposed { return proposed.cloned(); }
    if let (Some(b),Some(c),Some(p))=(before.and_then(Value::as_object),current.and_then(Value::as_object),proposed.and_then(Value::as_object)) {
        let mut out=Map::new();let keys=b.keys().chain(c.keys()).chain(p.keys()).collect::<std::collections::BTreeSet<_>>();
        for key in keys {
            let at=format!("{path}/{}",key.replace('~',"~0").replace('/',"~1"));
            if let Some(v)=merge(b.get(key),c.get(key),p.get(key),&at,conflicts){out.insert(key.clone(),v);}
        }
        return Some(Value::Object(out));
    }
    conflicts.push(json!({"path":path,"original":before,"current":current,"proposed":proposed}));
    current.cloned()
}
pub(crate) fn map_node(db:&Connection,world:&str,line:&str,old:&str)->Result<String> {
    let rows=ws::rows(db,"WITH RECURSIVE path(id,parent_id,meta_json) AS (SELECT n.id,n.parent_id,n.meta_json FROM nodes n JOIN lines l ON l.node_id=n.id WHERE l.id=? AND l.world_id=? UNION ALL SELECT n.id,n.parent_id,n.meta_json FROM nodes n JOIN path p ON n.id=p.parent_id WHERE n.world_id=?) SELECT id FROM path WHERE id=? OR json_extract(meta_json,'$.agentOriginalNodeId')=? LIMIT 1",&[&line,&world,&world,&old,&old])?;
    rows.first().map(|v|ws::text(v,"id").to_owned()).ok_or_else(||Error::Tool{code:"rebase_target_missing",field:"id",message:"旧修改目标不在最新路线中，需要重新定位后核对，原草稿保留".into(),next:json!({"tool":"search_resources","args":{"kind":"node","query":old}})})
}
pub(crate) fn workspace(db:&Connection,task:&Value,plan:&RunPlan,work:&Value,new_base:&Value)->Result<Value> {
    let mut next=work.clone();let mut fresh_plan=plan.clone();
    fresh_plan.line_id=ws::text(new_base,"lineId").into();fresh_plan.head_id=ws::text(new_base,"headId").into();
    for edit in next["edits"].as_array_mut().into_iter().flatten() {
        let kind=ws::text(edit,"kind").to_owned();let old_id=ws::text(edit,"id").to_owned();
        let rid=if ["node","state","protagonist","people","places","cards","goals","facts"].contains(&kind.as_str())&&!old_id.is_empty(){map_node(db,&plan.world_id,&fresh_plan.line_id,&old_id)?}else{old_id.clone()};
        let latest=ws::resource(db,&fresh_plan,&kind,&rid)?;
        let mut conflicts=vec![];
        let merged=merge(Some(&edit["original"]),Some(&latest),Some(&edit["after"]),"",&mut conflicts).unwrap_or(Value::Null);
        edit["id"]=rid.into();edit["original"]=latest;edit["after"]=merged;
        edit["rebaseConflicts"]=json!(conflicts);
    }
    // A planned fork must still refer to a real node, never a node guessed from
    // a compressed conversation. Source/target versions are exposed to the AI.
    for route in next["routes"].as_array_mut().into_iter().flatten() {
        route["headId"]=map_node(db,&plan.world_id,&fresh_plan.line_id,ws::text(route,"headId"))?.into();
    }
    let _=task;
    Ok(next)
}
pub(crate) fn save(db:&Connection,task:&Value,plan:&RunPlan,work:&Value,new_base:&Value)->Result<Value> {
    let next=workspace(db,task,plan,work,new_base)?;
    ws::save_workspace(db,ws::text(task,"id"),&next)?;
    let mut meta=ws::parse(ws::text(task,"metadata_json"));
    meta["goalReport"]=Value::Null;meta["goalResult"]=Value::Null;
    meta["rebase"]=json!({"at":ws::now(),"fromVersion":task["base_world_version"],"toVersion":new_base["fingerprint"],"requiresVerification":true});
    let state=ws::resource(db,plan,"state",ws::text(new_base,"headId"))?;
    meta["referenceScope"]=state["source"].clone();
    db.execute("UPDATE pi_tasks SET line_id=?,base_json=?,base_world_version=?,metadata_json=?,updated_at=? WHERE id=?",params![ws::text(new_base,"lineId"),new_base.to_string(),ws::text(new_base,"fingerprint"),meta.to_string(),ws::now(),ws::text(task,"id")])?;
    db.execute("DELETE FROM pi_read_cache WHERE task_id=?",[ws::text(task,"id")])?;
    Ok(next)
}

#[cfg(test)] mod tests {
 use super::*;
 #[test] fn three_way_merge_preserves_new_play_and_exposes_actual_conflict(){
  let mut conflicts=vec![];
  let merged=merge(Some(&json!({"money":10,"name":"旧名","age":17})),Some(&json!({"money":8,"name":"旧名","age":18})),Some(&json!({"money":20,"name":"新名","age":17})),"",&mut conflicts).unwrap();
  assert_eq!(merged,json!({"money":8,"name":"新名","age":18}));assert_eq!(conflicts.len(),1);assert_eq!(conflicts[0]["path"],"/money");assert_eq!(conflicts[0]["proposed"],20);
 }
}
