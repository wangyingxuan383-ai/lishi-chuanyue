//! Versioned story locators. Entity identity and its containing state/node
//! are deliberately separate. These references locate data, never grant it.
use crate::{agent_workspace as ws, pi_store::arguments_hash, Error, Result, RunPlan};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) fn schema()->Value {
    let text=json!({"type":"string"});
    json!({"type":"object","additionalProperties":false,"properties":{"version":{"type":"integer","enum":[1]},"worldId":text,"lineId":text,"worldVersion":text,"kind":text,"id":text,"containerId":text,"entityId":text,"entityPath":text,"path":text,"revision":text},"required":["version","worldId","lineId","worldVersion","kind","id","containerId","path","revision"]})
}
fn failure(code:&'static str,field:&'static str,message:&str,next:Value)->Error {
    Error::Tool{code,field,message:message.into(),next}
}
fn resource(db:&Connection,task:&Value,plan:&RunPlan,kind:&str,id:&str,formal:bool)->Result<Value> {
    if !formal && !plan.meta["agent"]["readOnlyActor"].is_string() {
        let work=ws::workspace(db,ws::text(task,"id"))?;
        if let Some(edit)=work["edits"].as_array().into_iter().flatten().rev().find(|e|e["kind"]==kind&&e["id"]==id) {return Ok(edit["after"].clone());}
    }
    // Imported books are immutable by ID; edits derive a new book. Directory
    // locators must not load every book's complete text and search index just
    // to return a version. A draft, when present, still has a content hash.
    if kind=="book" {
        let id=container(db,plan,kind,id)?;
        return db.query_row("SELECT id,title,format,created_at FROM source_books WHERE id=?",[&id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"format":r.get::<_,String>(2)?,"createdAt":r.get::<_,String>(3)?}))).optional()?.ok_or_else(||Error::Invalid("参考书已不存在，请重新选择资料".into()));
    }
    ws::resource(db,plan,kind,id)
}
/// A parent may explicitly pin a bounded draft view for a child. It is read
/// through the ordinary chapter fence; no entire workspace is preloaded.
pub(crate) fn provided_view(db:&Connection,task:&Value,plan:&RunPlan,reference:&Value)->Result<Value> {
    let args=resolve(db,task,plan,"read_resource",&json!({"ref":reference,"limit":24000}))?;
    let data=ws::draft_view(db,plan,ws::text(task,"id"),&args)?;
    if serde_json::to_vec(&data)?.len()>256*1024 {return Err(Error::Invalid("提供给子助手的草稿字段过长，请选择具体段落或字段".into()));}
    Ok(json!({"ref":reference,"data":data}))
}
fn container(db:&Connection,plan:&RunPlan,kind:&str,id:&str)->Result<String> {
    Ok(if ["world","settings"].contains(&kind){plan.world_id.clone()}
    else if kind=="line"&&id.is_empty(){plan.line_id.clone()}
    else if kind=="book"&&id.is_empty(){
        ws::resource(db,plan,"state","")?["source"]["bookId"].as_str().unwrap_or("").into()
    } else if id.is_empty(){plan.head_id.clone()} else{id.into()})
}
fn make(db:&Connection,task:&Value,plan:&RunPlan,kind:&str,id:&str,path:&str,formal:bool)->Result<Value> {
    let kind=ws::canonical_kind(kind);
    let value=resource(db,task,plan,kind,id,formal)?;
    let mut reference=json!({"version":1,"worldId":plan.world_id,"lineId":plan.line_id,"worldVersion":task["base_world_version"],"kind":kind,"id":id,"containerId":container(db,plan,kind,id)?,"path":path,"revision":arguments_hash(&value)});
    let mut parent=path;
    loop {
        let entity=if parent.is_empty(){&value}else{value.pointer(parent).unwrap_or(&Value::Null)};
        if let Some(id)=entity["id"].as_str().filter(|s|!s.is_empty()) {reference["entityId"]=id.into();reference["entityPath"]=parent.into();break;}
        if parent.is_empty(){break;}
        parent=parent.rsplit_once('/').map(|p|p.0).unwrap_or("");
    }
    Ok(reference)
}
fn refresh_entity(value:&Value,reference:&Value,mut refresh:Value)->Value {
    let Some(id)=reference["entityId"].as_str() else{return refresh;};
    fn find(value:&Value,id:&str,path:&str,depth:usize,remaining:&mut usize,found:&mut Vec<String>) {
        if depth>16||*remaining==0||found.len()>1{return;}*remaining-=1;
        if value["id"]==id {found.push(path.into());}
        match value {
            Value::Array(items)=>for(index,item)in items.iter().enumerate(){find(item,id,&format!("{path}/{index}"),depth+1,remaining,found);},
            Value::Object(items)=>for(key,item)in items{find(item,id,&format!("{path}/{}",key.replace('~',"~0").replace('/',"~1")),depth+1,remaining,found);},
            _=>{}
        }
    }
    let mut found=vec![];find(value,id,"",0,&mut 50_000,&mut found);
    let args=refresh["args"].as_object_mut().unwrap();args.remove("path");
    if found.len()==1 {
        let suffix=ws::text(reference,"path").strip_prefix(ws::text(reference,"entityPath")).unwrap_or("");
        let target=format!("{}{suffix}",found[0]);
        if !target.is_empty(){args.insert("path".into(),target.into());}
    }
    refresh
}

pub(crate) type BatchSnapshots = std::collections::HashMap<(String, String), Value>;

pub(crate) fn record_batch_snapshot(
    db: &Connection,
    task: &Value,
    plan: &RunPlan,
    kind: &str,
    id: &str,
    snapshots: &mut BatchSnapshots,
) -> Result<()> {
    let canonical = ws::canonical_kind(kind).to_owned();
    let cid = container(db, plan, &canonical, id)?;
    let key = (canonical.clone(), cid);
    if !snapshots.contains_key(&key) {
        let val = resource(db, task, plan, &canonical, id, false)?;
        snapshots.insert(key, val);
    }
    Ok(())
}

fn find_entity_paths(value: &Value, id: &str) -> Vec<String> {
    fn walk(
        value: &Value,
        id: &str,
        path: &str,
        depth: usize,
        remaining: &mut usize,
        found: &mut Vec<String>,
    ) {
        if depth > 16 || *remaining == 0 || found.len() > 1 {
            return;
        }
        *remaining -= 1;
        if value["id"] == id {
            found.push(path.into());
        }
        match value {
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    walk(item, id, &format!("{path}/{index}"), depth + 1, remaining, found);
                }
            }
            Value::Object(items) => {
                for (key, item) in items {
                    walk(
                        item,
                        id,
                        &format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")),
                        depth + 1,
                        remaining,
                        found,
                    );
                }
            }
            _ => {}
        }
    }
    let mut found = vec![];
    walk(value, id, "", 0, &mut 50_000, &mut found);
    found
}

pub(crate) fn resolve(db:&Connection,task:&Value,plan:&RunPlan,tool:&str,args:&Value)->Result<Value> {
    if !["read_resource","stage_edit"].contains(&tool){return Ok(args.clone());}
    resolve_with_snapshots(db, task, plan, args, None)
}

pub(crate) fn resolve_in_batch(
    db: &Connection,
    task: &Value,
    plan: &RunPlan,
    args: &Value,
    snapshots: &BatchSnapshots,
) -> Result<Value> {
    resolve_with_snapshots(db, task, plan, args, Some(snapshots))
}

fn resolve_with_snapshots(
    db: &Connection,
    task: &Value,
    plan: &RunPlan,
    args: &Value,
    snapshots: Option<&BatchSnapshots>,
) -> Result<Value> {
    let Some(reference)=args.get("ref") else{return Ok(args.clone());};
    let mut fresh=json!({"kind":reference["kind"],"limit":1200});
    for key in ["id","path"] {if reference[key].as_str().is_some_and(|s|!s.is_empty()){fresh[key]=reference[key].clone();}}
    let refresh=json!({"tool":"read_resource","args":fresh});
    if !reference.is_object() || ["worldId","lineId","worldVersion","kind","id","containerId","path","revision"].iter().any(|key|!reference[*key].as_str().is_some_and(|s|s.len()<=4096))
        || reference["entityId"].as_str().is_none()&&!reference["entityId"].is_null()
        || reference["entityId"].is_string()&&!reference["entityPath"].as_str().is_some_and(|p|p.len()<=4096&&(p.is_empty()||p.starts_with('/')))
        || !reference["revision"].as_str().is_some_and(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit())) {
        return Err(failure("resource_ref_invalid","ref","定位结构不完整，请直接回传工具返回的完整ref。",json!({"tool":"list_resources","args":{}})));
    }
    if reference["version"]!=1 || reference["worldId"]!=plan.world_id || reference["lineId"]!=plan.line_id {
        return Err(failure("resource_ref_scope","ref","这项定位不属于本次故事与路线，不能跨局使用。",json!({"tool":"list_resources","args":{}})));
    }
    if reference["worldVersion"]!=task["base_world_version"] {
        return Err(failure("resource_ref_stale","ref.worldVersion","故事版本已变化，请在当前任务重新查阅并核对目标。",refresh));
    }
    let kind=ws::canonical_kind(ws::text(reference,"kind"));let id=ws::text(reference,"id");let path=ws::text(reference,"path");
    if path.len()>4096 || !path.is_empty()&&!path.starts_with('/') {
        return Err(failure("resource_ref_invalid","ref.path","定位路径须为有效JSON Pointer。",refresh));
    }
    let cid = container(db, plan, kind, id)?;
    if reference["containerId"] != cid {
        return Err(failure("resource_ref_container","ref.containerId","实体与所属回合或资料容器不一致，请重新读取，不能猜测回合ID。",refresh));
    }
    if args["kind"].as_str().is_some_and(|k|ws::canonical_kind(k)!=kind) || args["id"].as_str().is_some_and(|i|i!=id) {
        return Err(failure("resource_ref_conflict","ref","ref与另外填写的kind/id冲突；直接回传ref即可。",refresh));
    }
    let entity_path=ws::text(reference,"entityPath");
    let relative=ws::text(args,"path");
    if !relative.is_empty()&&!relative.starts_with('/') {
        return Err(failure("resource_ref_invalid","path","带ref时path为相对目标的JSON Pointer，例如/description；省略即目标本身。",refresh));
    }
    let is_root_collection_append = ws::text(args, "operation") == "append"
        && matches!(kind, "cards" | "people" | "places" | "goals" | "facts")
        && matches!(relative, "" | "/" | "/-")
        && (path.is_empty() || path.split('/').count() == 2);
    if !is_root_collection_append
        && reference["entityId"].is_string()
        && !(path == entity_path || path.starts_with(&format!("{entity_path}/")))
    {
        return Err(failure("resource_ref_invalid","ref.entityPath","目标字段必须位于所定位实体之内。",refresh));
    }
    let value=resource(db,task,plan,kind,id,false)?;
    if is_root_collection_append {
        let revision_ok = reference["revision"] == arguments_hash(&value)
            || snapshots
                .and_then(|s| s.get(&(kind.to_owned(), cid)))
                .is_some_and(|pre| reference["revision"] == arguments_hash(pre));
        if !revision_ok {
            return Err(failure("resource_ref_stale","ref.revision","该资料或草稿已变化，原定位已过期；重新读取并核对后再改。",refresh_entity(&value,reference,refresh)));
        }
        let mut result = args.clone();
        result.as_object_mut().unwrap().remove("ref");
        result["kind"] = kind.into();
        result["id"] = id.into();
        result["path"] = "".into();
        return Ok(result);
    }
    let effective_path = if reference["revision"] == arguments_hash(&value) {
        if kind!="book"&&!path.is_empty()&&value.pointer(path).is_none(){
            return Err(failure("resource_ref_missing","ref.path","该目标已不存在，请重新定位。",refresh));
        }
        let entity=if entity_path.is_empty(){&value}else{value.pointer(entity_path).unwrap_or(&Value::Null)};
        if reference["entityId"].as_str().is_some_and(|eid|entity["id"]!=eid) {
            return Err(failure("resource_ref_entity","ref.entityId","实体位置已变化，不能把旧数组下标用于另一个人物或设定。",refresh));
        }
        path.to_owned()
    } else if let Some(pre_batch) = snapshots
        .and_then(|s| s.get(&(kind.to_owned(), cid)))
        .filter(|pre| reference["revision"] == arguments_hash(pre))
    {
        if kind != "book" && !path.is_empty() && pre_batch.pointer(path).is_none() {
            return Err(failure("resource_ref_missing","ref.path","该目标已不存在，请重新定位。",refresh));
        }
        if let Some(eid) = reference["entityId"].as_str() {
            let pre_entity = if entity_path.is_empty() {
                pre_batch
            } else {
                pre_batch.pointer(entity_path).unwrap_or(&Value::Null)
            };
            if pre_entity["id"] != eid {
                return Err(failure("resource_ref_entity","ref.entityId","实体位置已变化，不能把旧数组下标用于另一个人物或设定。",refresh));
            }
            let cur_entity = if entity_path.is_empty() {
                &value
            } else {
                value.pointer(entity_path).unwrap_or(&Value::Null)
            };
            let relocated = if cur_entity["id"] == eid {
                path.to_owned()
            } else {
                let found = find_entity_paths(&value, eid);
                if found.len() == 1 {
                    let suffix = path.strip_prefix(entity_path).unwrap_or("");
                    format!("{}{suffix}", found[0])
                } else {
                    return Err(failure("resource_ref_missing","ref.entityId","同一批次前序修改已移除该实体，请核对后再改。",refresh_entity(&value,reference,refresh)));
                }
            };
            if kind != "book" && !relocated.is_empty() && value.pointer(&relocated).is_none() {
                return Err(failure("resource_ref_missing","ref.path","该目标已不存在，请重新定位。",refresh_entity(&value,reference,refresh)));
            }
            relocated
        } else {
            if kind != "book" && !path.is_empty() && value.pointer(path).is_none() {
                return Err(failure("resource_ref_missing","ref.path","该目标已不存在，请重新定位。",refresh));
            }
            path.to_owned()
        }
    } else {
        return Err(failure("resource_ref_stale","ref.revision","该资料或草稿已变化，原定位已过期；重新读取并核对后再改。",refresh_entity(&value,reference,refresh)));
    };
    let mut result=args.clone();result.as_object_mut().unwrap().remove("ref");
    result["kind"]=kind.into();result["id"]=id.into();result["path"]=format!("{effective_path}{relative}").into();
    Ok(result)
}
fn read_locator(db:&Connection,task:&Value,plan:&RunPlan,kind:&str,id:&str,locator:&Value)->Result<Value> {
    let reference=make(db,task,plan,kind,id,ws::text(locator,"path"),false)?;
    let mut read=json!({"ref":reference});
    if locator.get("pageSize").is_some()||locator.get("charBudget").is_some(){for key in ["pageSize","charBudget","nextCursor","offset"]{if let Some(value)=locator.get(key){read[key]=value.clone();}}}else{read["offset"]=locator["offset"].as_u64().unwrap_or(0).into();read["limit"]=locator["limit"].as_u64().unwrap_or(1200).into();}Ok(read)
}
pub(crate) fn project(db:&Connection,task:&Value,plan:&RunPlan,tool:&str,args:&Value,mut value:Value)->Result<Value> {
    match tool {
        "list_resources"|"search_resources"=>{
            let key=if tool=="list_resources"{"resources"}else{"matches"};
            for item in value[key].as_array_mut().into_iter().flatten() {
                let reference=make(db,task,plan,ws::text(item,"kind"),ws::text(item,"id"),ws::text(item,"path"),tool=="search_resources")?;
                item["ref"]=reference;
            }
            if tool=="list_resources"&&value.get("value").is_some(){value["value"]=value["resources"].clone();}
        }
        "read_resource"=>{
            let kind=ws::canonical_kind(ws::text(args,"kind"));let id=ws::text(args,"id");
            for item in value["oversized"].as_array_mut().into_iter().flatten(){
                if item["read"].is_object(){item["read"]=read_locator(db,task,plan,kind,id,&item["read"])?;}
                for field in item["paths"].as_array_mut().into_iter().flatten(){if field["read"].is_object(){field["read"]=read_locator(db,task,plan,kind,id,&field["read"])?;}}
            }

            let kind=ws::canonical_kind(ws::text(args,"kind"));let id=ws::text(args,"id");let base=ws::text(args,"path");
            value["ref"]=make(db,task,plan,kind,id,base,false)?;
            if value["read"].is_object(){value["read"]=read_locator(db,task,plan,kind,id,&value["read"])?;}
            for field in value["paths"].as_array_mut().into_iter().flatten() {
                if field["read"].is_object(){field["read"]=read_locator(db,task,plan,kind,id,&field["read"])?;}
            }
            let offset=value["offset"].as_u64().unwrap_or(0);let mut items=vec![];
            for (index,item) in value["value"].as_array_mut().into_iter().flatten().enumerate() {
                let path=if let Some(path)=item["largeItemPath"].as_str(){path.to_owned()}else{format!("{base}/{}",offset+index as u64)};
                items.push(json!({"index":offset+index as u64,"ref":make(db,task,plan,kind,id,&path,false)?}));
                if item["read"].is_object(){item["read"]=read_locator(db,task,plan,kind,id,&item["read"])?;}
                for field in item["paths"].as_array_mut().into_iter().flatten(){if field["read"].is_object(){field["read"]=read_locator(db,task,plan,kind,id,&field["read"])?;}}
            }
            if !items.is_empty(){value["items"]=json!(items);}
        }
        "stage_edit"=>{
            let kind = ws::canonical_kind(ws::text(args, "kind"));
            let id = ws::text(args, "id");
            let req_path = ws::text(args, "path");
            let after_val = resource(db, task, plan, kind, id, false)?;
            let ref_path = if !req_path.is_empty()
                && kind != "book"
                && after_val.pointer(req_path).is_none()
            {
                ""
            } else {
                req_path
            };
            value["ref"] = make(db, task, plan, kind, id, ref_path, false)?;
        }
        "stage_edits"=>{
            let mut containers: Vec<(String, String)> = Vec::new();
            for item in value["results"].as_array_mut().into_iter().flatten() {
                let kind = ws::canonical_kind(ws::text(item, "kind")).to_owned();
                let id = ws::text(item, "id").to_owned();
                let item_path = ws::text(item, "path");
                let after_val = resource(db, task, plan, &kind, &id, false)?;
                let ref_path = if !item_path.is_empty()
                    && kind != "book"
                    && after_val.pointer(item_path).is_none()
                {
                    ""
                } else {
                    item_path
                };
                item["ref"] = make(db, task, plan, &kind, &id, ref_path, false)?;
                if !containers.iter().any(|(k, i)| k == &kind && i == &id) {
                    containers.push((kind, id));
                }
            }
            let refs = containers
                .iter()
                .map(|(k, i)| make(db, task, plan, k, i, "", false))
                .collect::<Result<Vec<_>>>()?;
            if refs.len() == 1 {
                value["ref"] = refs[0].clone();
            }
            value["refs"] = json!(refs);
        }
        "read_world"=>{
            if let Some(id)=value["currentHead"]["id"].as_str().map(str::to_owned){value["currentHead"]["ref"]=make(db,task,plan,"node",&id,"",false)?;}
            value["resourceRefs"]=json!(["settings","state","protagonist","people","cards","facts"].into_iter().map(|kind|make(db,task,plan,kind,"","",false)).collect::<Result<Vec<_>>>()?);
        }
        _=>{}
    }
    Ok(value)
}
