//! Durable findings are task results, never another model conversation.
use crate::{agent_workspace as ws, pi_store::arguments_hash, Error, Result, RunPlan};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub(crate) fn requires_canon(db:&Connection,task:&Value)->Result<bool> {
    let meta=ws::parse(ws::text(task,"metadata_json"));
    let requested=|text:&str|["遵循原著","参考原著","按原著","原著纠错"].iter().any(|s|text.contains(s));
    if meta["skills"].as_array().into_iter().flatten().any(|v|v=="canon-reference"||v=="canon-check"||v=="遵循原著") || requested(ws::text(task,"text")){return Ok(true);}
    for row in ws::rows(db,"SELECT content_json FROM pi_inputs WHERE task_id=? AND status='delivered' AND intent_revision<=?",&[&ws::text(task,"id"),&task["consumed_intent_revision"].as_i64().unwrap_or(0)])? {
        if requested(ws::text(&ws::parse(ws::text(&row,"content_json")),"text")){return Ok(true);}
    }
    Ok(false)
}

fn mechanical_groups(workspace:&Value)->Result<Value> {
    let groups=crate::pi_verification::resource_groups(workspace)?;
    let mut allowed=vec![];
    for edit in workspace["edits"].as_array().into_iter().flatten().filter(|e|e["kind"]=="state") {
        let mut before=edit["original"].clone();let mut after=edit["after"].clone();
        // A model's label cannot exempt a factual edit from original-source
        // checks. Only these display fields can be proven mechanical here.
        for (parent,key) in [("era","clockStyle"),("era","timeStyle"),("era","calendar"),("time","anchor")] {
            if let Some(object)=before[parent].as_object_mut(){object.remove(key);}
            if let Some(object)=after[parent].as_object_mut(){object.remove(key);}
        }
        if before!=after {continue;}
        for group in groups.as_array().into_iter().flatten().filter(|g|g["collection"]=="edits"&&g["kind"]==edit["kind"]&&g["id"]==edit["id"]&&g["routeId"].as_str().unwrap_or("")==edit["routeId"].as_str().unwrap_or("")) {allowed.push(group["groupId"].clone());}
    }
    Ok(json!(allowed))
}

pub(crate) fn constraints(db:&Connection,task:&Value,plan:&RunPlan)->Result<Value> {
    let mut refs=crate::pi_tools::player_choices(db,plan,&json!({"limit":20}))?["references"].as_array().cloned().unwrap_or_default();
    for item in &mut refs {
        item["kind"]=if item["field"]=="director_note"{"request"}else{"choice"}.into();
        item["explicit"]=(item["field"]!="director_note").into();item["scope"]="本局已保存的玩家原句；行动不证明已成功".into();
    }
    refs.push(json!({"id":format!("{}:request",ws::text(task,"id")),"text":task["text"],"kind":"request","explicit":false}));
    for input in ws::rows(db,"SELECT id,content_json FROM pi_inputs WHERE task_id=? AND status='delivered' AND intent_revision<=? ORDER BY seq",&[&ws::text(task,"id"),&task["consumed_intent_revision"].as_i64().unwrap_or(0)])? {
        let value=ws::parse(ws::text(&input,"content_json"));
        refs.push(json!({"id":input["id"],"text":value["text"],"kind":"request","explicit":false}));
    }
    Ok(json!({"worldVersion":task["base_world_version"],"intentRevision":task["consumed_intent_revision"],"requiresCanon":requires_canon(db,task)?,"factContract":ws::parse(ws::text(task,"metadata_json"))["factContract"],"rebaseConflicts":ws::workspace(db,ws::text(task,"id"))?["edits"].as_array().into_iter().flatten().filter(|e|e["rebaseConflicts"].as_array().is_some_and(|v|!v.is_empty())).map(|e|json!({"kind":e["kind"],"id":e["id"],"conflicts":e["rebaseConflicts"]})).collect::<Vec<_>>(),"mechanicalGroupIds":mechanical_groups(&ws::workspace(db,ws::text(task,"id"))?)?,"localCustomRequiresReference":true,"playerReferences":refs,"message":"编辑授权和任务要求不是具体原著事实；明确本局改写可引用真实原句并附declaration的对象、具体值和范围，自定资料须引用明确允许补全的原句。玩家原句只证明该句确由玩家给出，行动不证明已成功；引文相关性由助手核对。仅实际差异属于日期显示的mechanicalGroupIds可在原著核对任务中免原文；模型自报scope不扩大范围。"}))
}

pub(crate) fn evaluate(db:&Connection,task:&Value,plan:&RunPlan,report:&Value)->Result<Value> {
    if report.to_string().len()>512*1024{return Err(Error::Invalid("核对报告过长，请按本次实际目标收敛".into()));}
    let workspace=ws::workspace(db,ws::text(task,"id"))?;
    let mut limits=constraints(db,task,plan)?;
    // Older explicit player choices stay usable without injecting the whole
    // history into the starting context. Resolve only referenced, real nodes
    // on this route; another branch's request cannot authorize this branch.
    let mut seen=std::collections::BTreeSet::new();
    for finding in report["findings"].as_array().into_iter().flatten() {
        for reference in finding["references"].as_array().into_iter().flatten() {
            let id=ws::text(reference,"playerReferenceId");
            if id.is_empty()||!seen.insert(id.to_owned()) {continue;}
            if seen.len()>256 {return Err(Error::Invalid("玩家依据过多，请只核对本次相关原句".into()));}
            if limits["playerReferences"].as_array().unwrap().iter().any(|r|r["id"]==id){continue;}
            let Some((node,field))=id.rsplit_once(':') else {continue;};
            if !["action_text","director_note"].contains(&field){continue;}
            let sql=format!("WITH RECURSIVE history(id,parent_id) AS (SELECT id,parent_id FROM nodes WHERE id=? AND world_id=? UNION ALL SELECT n.id,n.parent_id FROM nodes n JOIN history h ON n.id=h.parent_id WHERE n.world_id=?) SELECT n.{field} AS text FROM nodes n JOIN history h ON h.id=n.id WHERE n.id=? LIMIT 1");
            let rows=ws::rows(db,&sql,&[&plan.head_id,&plan.world_id,&plan.world_id,&node])?;
            if let Some(value)=rows.first().and_then(|r|r["text"].as_str()).filter(|s|!s.trim().is_empty()) {
                limits["playerReferences"].as_array_mut().unwrap().push(json!({"id":id,"text":value,"kind":if field=="director_note"{"request"}else{"choice"},"explicit":field!="director_note","nodeId":node,"field":field,"scope":"本局路线已保存的玩家原句"}));
            }
        }
    }
    crate::pi_findings::validate_report(&workspace,&crate::pi_receipts::pages(db,task)?,report,&limits)
}

pub(crate) fn record(db:&Connection,task:&Value,plan:&RunPlan,report:&Value)->Result<Value> {
    let checked=evaluate(db,task,plan,report)?;
    let mut meta=ws::parse(ws::text(task,"metadata_json"));
    meta["goalReport"]=report.clone();meta["goalResult"]=checked.clone();
    db.execute("UPDATE pi_tasks SET metadata_json=?,updated_at=? WHERE id=?",params![meta.to_string(),ws::now(),ws::text(task,"id")])?;
    Ok(checked)
}

pub(crate) fn for_finish(db:&Connection,task:&Value,plan:&RunPlan)->Result<Option<Value>> {
    let meta=ws::parse(ws::text(task,"metadata_json"));
    if meta["goalReport"].is_null() {
        if requires_canon(db,task)?{return Err(Error::Invalid("本次明确要求核对原著，请先check_draft取得实际送达的evidenceLedger及resourceGroups，再record_findings记录具体依据或资料不足；读取技能和编辑授权不能代替查证".into()));}
        return Ok(None);
    }
    let checked=evaluate(db,task,plan,&meta["goalReport"])?;
    if checked["workspaceFingerprint"]!=arguments_hash(&ws::workspace(db,ws::text(task,"id"))?) {return Err(Error::Stale);}
    if checked["unresolvedGroupIds"].as_array().is_some_and(|v|!v.is_empty()) && checked["validSelections"].as_array().is_none_or(Vec::is_empty) {
        return Err(Error::Invalid("本批草稿仍包含未通过核对的完整资源；请先修订或移除这些资源，再重新record_findings。已通过项目不会被当作全部完成，未校验内容不会一起采用".into()));
    }
    Ok(Some(checked))
}
