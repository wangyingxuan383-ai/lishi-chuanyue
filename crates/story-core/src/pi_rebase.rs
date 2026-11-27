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
    let new_head=ws::text(new_base,"headId").to_owned();
    fresh_plan.line_id=ws::text(new_base,"lineId").into();fresh_plan.head_id=new_head.clone();
    for edit in next["edits"].as_array_mut().into_iter().flatten() {
        let kind=ws::text(edit,"kind").to_owned();let old_id=ws::text(edit,"id").to_owned();
        let mapped=if ["node","state","protagonist","people","places","cards","goals","facts"].contains(&kind.as_str())&&!old_id.is_empty(){
            map_node(db,&plan.world_id,&fresh_plan.line_id,&old_id)
        }else{
            Ok(old_id.clone())
        };
        let Ok(rid)=mapped else {
            // Soft conflict instead of hard-locking resume (R31-P5): preserve draft for relocation or discard.
            edit["needsRelocation"]=true.into();
            edit["rebaseConflicts"]=json!([{"path":"","reason":"target_missing","oldId":old_id,"message":"旧修改目标不在最新路线中，请重新定位或撤回该草稿"}]);
            continue;
        };
        let Ok(latest) = ws::resource(db, &fresh_plan, &kind, &rid) else {
            edit["needsRelocation"] = true.into();
            edit["rebaseConflicts"] = json!([{"path":"","reason":"target_missing","oldId":old_id,"message":"旧修改目标已被删除或不在当前故事中，请重新定位或撤回该草稿"}]);
            continue;
        };
        if kind == "line"
            && (!latest["deleted_at"].is_null()
                || latest["archived"].as_i64().unwrap_or(0) != 0)
        {
            edit["needsRelocation"] = true.into();
            edit["rebaseConflicts"] = json!([{"path":"","reason":"target_missing","oldId":old_id,"message":"目标路线已删除或归档，请重新定位或撤回该草稿"}]);
            continue;
        }
        let prior_conflicts: Vec<Value> = edit["rebaseConflicts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| ws::text(c, "reason") != "target_missing")
            .cloned()
            .collect();
        let mut conflicts = vec![];
        let merged = merge(
            Some(&edit["original"]),
            Some(&latest),
            Some(&edit["after"]),
            "",
            &mut conflicts,
        )
        .unwrap_or(Value::Null);
        for old in prior_conflicts {
            let p = ws::text(&old, "path");
            if !conflicts.iter().any(|c| ws::text(c, "path") == p) {
                conflicts.push(old);
            }
        }
        edit["id"] = rid.into();
        edit["original"] = latest;
        edit["after"] = merged;
        edit["rebaseConflicts"] = json!(conflicts);
        if let Some(obj) = edit.as_object_mut() {
            obj.remove("needsRelocation");
        }
    }
    // A planned fork must still refer to a real node, never a node guessed from
    // a compressed conversation. Missing targets are marked for relocation instead of locking resume.
    for route in next["routes"].as_array_mut().into_iter().flatten() {
        let old_head=ws::text(route,"headId").to_owned();
        match map_node(db,&plan.world_id,&fresh_plan.line_id,&old_head) {
            Ok(rid)=>{
                route["headId"]=rid.into();
                if let Some(obj)=route.as_object_mut(){obj.remove("needsRelocation");obj.remove("rebaseConflicts");}
            }
            Err(_)=>{
                route["needsRelocation"]=true.into();
                route["rebaseConflicts"]=json!([{"path":"/headId","reason":"target_missing","oldId":old_head,"message":"路线起点不在最新路线中，请重新定位或撤回该草稿"}]);
            }
        }
    }
    // Staged story turns depend on the route head; mark them conflicted if the story moved on.
    let old_base=task["base_json"].as_str().map(ws::parse).unwrap_or_else(||task["base_json"].clone());
    let old_head=ws::text(&old_base,"headId");
    if !old_head.is_empty() && old_head != new_head {
        for turn in next["turns"].as_array_mut().into_iter().flatten() {
            turn["rebaseConflicts"]=json!([{"path":"/headId","reason":"story_advanced","fromHeadId":old_head,"toHeadId":new_head,"message":"主线已有新段落，续跑时需重新核对或撤回该草稿剧情"}]);
        }
    }
    Ok(next)
}
pub(crate) fn save(db:&Connection,task:&Value,plan:&RunPlan,work:&Value,new_base:&Value)->Result<Value> {
    let next=workspace(db,task,plan,work,new_base)?;
    ws::save_workspace(db,ws::text(task,"id"),&next)?;
    let mut meta=ws::parse(ws::text(task,"metadata_json"));
    meta["goalReport"]=Value::Null;meta["goalResult"]=Value::Null;
    meta["rebase"]=json!({"at":ws::now(),"fromVersion":task["base_world_version"],"toVersion":new_base["fingerprint"],"requiresVerification":true});
    let prior_scope = meta["referenceScope"].clone();
    let state=ws::resource(db,plan,"state",ws::text(new_base,"headId"))?;
    let mut next_scope = state["source"].clone();
    if next_scope.is_object() {
        if prior_scope["explicitRange"] == true && prior_scope["bookId"] == next_scope["bookId"] {
            next_scope["through"] = prior_scope["through"].clone();
            if let Some(from) = prior_scope.get("from").filter(|v| v.is_i64()) {
                next_scope["from"] = from.clone();
            }
            next_scope["explicitRange"] = true.into();
        } else {
            next_scope["through"] = Value::Null;
            if let Some(obj) = next_scope.as_object_mut() {
                obj.remove("from");
                obj.remove("explicitRange");
            }
        }
    }
    meta["referenceScope"]=next_scope;
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
 #[test] fn rebase_marks_missing_targets_for_relocation_and_flags_staged_turns_when_head_advances() {
  let mut db = Connection::open_in_memory().unwrap();
  crate::migration::migrate(&mut db, None).unwrap();
  db.execute_batch(
      "INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('w','rebase','free','l','{}','t','t','t');
       INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n0','w',0,'opening','开场','t'),('n1','w',1,'turn','新段','t');
       UPDATE nodes SET parent_id='n0' WHERE id='n1';
       INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l','w','主线','n1','t');
       INSERT INTO states(node_id,state_json) VALUES('n0','{}'),('n1','{}');"
  ).unwrap();
  let plan: RunPlan = serde_json::from_value(json!({
      "id":"r","worldId":"w","lineId":"l","headId":"n0","baseId":"n0","kind":"turn",
      "model":{"slot":"s","url":"http://127.0.0.1","model":"m","includeUsage":false,"extra":{}},
      "messages":[],"extractMessages":[],"state":{},"settings":{},"options":{},"action":{},"meta":{}
  })).unwrap();
  let task = json!({"base_json": json!({"lineId":"l","headId":"n0"}).to_string()});
  let new_base = json!({"lineId":"l","headId":"n1","fingerprint":"fp2"});
  let work = json!({
      "edits": [{"kind":"node","id":"gone-node","original":{"narrative":"旧"},"after":{"narrative":"改"},"summaries":["修改旧段"]}],
      "routes": [{"id":"rt1","name":"分支","headId":"gone-node","activate":false,"summary":"开分支"}],
      "turns": [{"summary":"暂存新剧情","narrative":"新写一段剧情"}]
  });
  let rebased = workspace(&db, &task, &plan, &work, &new_base).unwrap();
  assert_eq!(rebased["edits"][0]["needsRelocation"], true);
  assert_eq!(rebased["edits"][0]["rebaseConflicts"][0]["reason"], "target_missing");
  assert_eq!(rebased["routes"][0]["needsRelocation"], true);
  assert_eq!(rebased["routes"][0]["rebaseConflicts"][0]["reason"], "target_missing");
  assert_eq!(rebased["turns"][0]["rebaseConflicts"][0]["reason"], "story_advanced");
  assert!(crate::pi_adoption::check_no_conflicts(&rebased).is_err());
  assert!(crate::pi_adoption::check_no_conflicts(&json!({"edits":[],"routes":[],"turns":rebased["turns"]})).is_err());
  assert!(crate::pi_adoption::check_no_conflicts(&json!({"edits":[],"routes":rebased["routes"],"turns":[]})).is_err());
 }
}
