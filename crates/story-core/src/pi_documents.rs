//! Native-picked file grants. Paths/URIs never become model capabilities.
use crate::{agent_workspace as ws,Error,Result,RunPlan,Store};
use rusqlite::{params,Connection,OptionalExtension};
use serde_json::{json,Value};
use base64::Engine;

pub const PARSER_CACHE_PREFIX: &str = "parser2-";

pub fn register(store:&Store,scope:&Value,writable:bool)->Result<Value>{
    if !scope["path"].is_string()&&!scope["uri"].is_string(){return Err(Error::Invalid("请选择有效的资料文件或目录".into()));}
    let mode=if writable{"write"}else{"read"};
    let mut db=store.lock()?;let tx=db.transaction()?;crate::maintenance::guard(&tx)?;
    let old:Option<(String,i64)>=tx.query_row("SELECT id,revision FROM agent_capability_grants WHERE kind='file' AND COALESCE(json_extract(scope_json,'$.uri'),'')=? AND COALESCE(json_extract(scope_json,'$.path'),'')=? AND COALESCE(json_extract(scope_json,'$.directory'),0)=? ORDER BY created_at DESC LIMIT 1",params![ws::text(scope,"uri"),ws::text(scope,"path"),i64::from(scope["directory"]==true)],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let(id,revision)=if let Some((id,rev))=old{tx.execute("UPDATE agent_capability_grants SET scope_json=?,mode=?,revision=revision+1,enabled=1,updated_at=? WHERE id=?",params![scope.to_string(),mode,ws::now(),id])?;(id,rev+1)}else{
        let id=ws::id();tx.execute("INSERT INTO agent_capability_grants(id,kind,scope_json,mode,revision,enabled,created_at,updated_at) VALUES(?,'file',?,?,1,1,?,?)",params![id,scope.to_string(),mode,ws::now(),ws::now()])?;(id,1)
    };tx.commit()?;
    Ok(json!({"id":id,"name":scope["name"],"directory":scope["directory"]==true,"writable":writable,"enabled":true,"revision":revision}))
}
pub(crate) fn list(db:&Connection)->Result<Vec<Value>>{
    let mut stmt=db.prepare("SELECT id,scope_json,mode,revision,enabled FROM agent_capability_grants WHERE kind='file' ORDER BY created_at DESC")?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?,r.get::<_,i64>(4)?)))?;
    rows.map(|r|{let(id,scope,mode,revision,enabled)=r?;let scope=ws::parse(&scope);Ok(json!({"id":id,"name":scope["name"],"directory":scope["directory"]==true,"writable":mode=="write","revision":revision,"enabled":enabled==1}))}).collect()
}
pub(crate) fn pin(db:&Connection)->Result<Value>{Ok(json!(list(db)?.into_iter().filter(|g|g["enabled"]==true).collect::<Vec<_>>()))}
pub(crate) fn revoke(db:&Connection,id:&str)->Result<Value>{
    let tx=db.unchecked_transaction()?;crate::maintenance::guard(&tx)?;
    tx.execute("UPDATE agent_capability_grants SET enabled=0,revision=revision+1,updated_at=? WHERE id=? AND kind='file'",params![ws::now(),id])?;tx.commit()?;
    Ok(json!({"id":id,"enabled":false}))
}
pub(crate) fn request(db:&Connection,task:&Value,plan:&RunPlan,args:&Value,writing:bool)->Result<Value>{
    let mut requested=args.clone();
    if let Some(cursor)=args["nextCursor"].as_str(){
        let bytes=base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(cursor).map_err(|_|Error::Invalid("资料游标无效".into()))?;
        let saved:Value=serde_json::from_slice(&bytes)?;
        if saved["grantId"]!=args["grantId"]||saved["taskId"]!=task["id"]||saved["path"].as_str().unwrap_or("")!=ws::text(args,"path") {return Err(Error::Invalid("资料游标不属于当前任务与文件范围".into()));}
        for key in ["version","offset","section"]{requested[key]=saved[key].clone();}
    }
    let args=&requested;
    let meta=ws::parse(ws::text(task,"metadata_json"));let id=ws::text(args,"grantId");
    let frozen=meta["fileGrants"].as_array().and_then(|all|all.iter().find(|g|g["id"]==id)).ok_or_else(||Error::Invalid("此资料范围未在本次任务中授权，请选择资料后开始新任务".into()))?;
    let grant:Option<(String,String,i64,i64)>=db.query_row("SELECT scope_json,mode,revision,enabled FROM agent_capability_grants WHERE id=? AND kind='file'",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((scope,mode,revision,enabled))=grant else{return Err(Error::Invalid("资料授权已移除".into()));};
    if enabled!=1||frozen["revision"]!=revision||writing&&(mode!="write"||plan.meta["agent"]["readOnly"]==true){return Err(Error::Invalid("资料授权已撤销、变化或只允许读取，本次操作未执行".into()));}
    let relative=ws::text(args,"path");
    if relative.starts_with('/')||relative.contains(['\\',':','\0'])||relative.split('/').any(|s|s==".."||s=="."){return Err(Error::Invalid("资料路径必须位于所选范围内".into()));}
    let scope_val = ws::parse(&scope);
    let mut result = args.clone();
    result["_documentGrant"] = scope_val.clone();
    result["taskId"] = task["id"].clone();
    result["worldId"] = task["world_id"].clone();
    result["parserCachePrefix"] = PARSER_CACHE_PREFIX.into();
    for key in ["bookId", "fileHash", "sha256"] {
        if result.get(key).is_none() && scope_val[key].is_string() {
            result[key] = scope_val[key].clone();
        }
    }
    if result.get("fileHash").is_none() && result["sha256"].is_string() {
        result["fileHash"] = result["sha256"].clone();
    }
    let binding = &plan.meta["agent"]["referenceScope"];
    if let (Some(book), Some(through)) = (binding["bookId"].as_str(), binding["through"].as_u64()) {
        result["boundBookId"] = book.into();
        result["through"] = through.into();
        let raw: Option<String> = db
            .query_row("SELECT json FROM source_books WHERE id=?", [book], |r| r.get(0))
            .optional()?;
        if let Some(raw) = raw {
            let value = ws::parse(&raw);
            if let Some(fh) = value["fileHash"]
                .as_str()
                .or_else(|| value["sha256"].as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                result["boundFileHash"] = fh.to_ascii_lowercase().into();
            }
            let texts = json!(value["sections"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| ws::text(s, "text"))
                .collect::<Vec<_>>());
            result["boundBookHash"] = crate::pi_store::arguments_hash(&texts).into();
        }
        if matches_bound_book(&result, result["fileHash"].as_str(), None) {
            if let Some(section) = result["section"].as_u64() {
                if section > through {
                    return Err(Error::Invalid("所选章节不存在或超出本次参考范围。".into()));
                }
            }
        }
    }
    Ok(result)
}

pub(crate) fn matches_bound_book(
    request: &Value,
    file_hash: Option<&str>,
    normalized_hash: Option<&str>,
) -> bool {
    let bound_book = ws::text(request, "boundBookId");
    let req_book = ws::text(request, "bookId");
    if !bound_book.is_empty() && !req_book.is_empty() && bound_book == req_book {
        return true;
    }
    let bound_file = ws::text(request, "boundFileHash");
    let candidate_file = file_hash
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| request["fileHash"].as_str().map(str::trim).filter(|s| !s.is_empty()));
    if !bound_file.is_empty() {
        if let Some(fh) = candidate_file {
            if bound_file.eq_ignore_ascii_case(fh) {
                return true;
            }
        }
    }
    let bound_norm = ws::text(request, "boundBookHash");
    if !bound_norm.is_empty() {
        if let Some(nh) = normalized_hash.map(str::trim).filter(|s| !s.is_empty()) {
            if bound_norm.eq_ignore_ascii_case(nh) {
                return true;
            }
        }
    }
    false
}

pub(crate) fn enforce_spoiler_fence(
    request: &Value,
    file_hash: Option<&str>,
    data: &mut Value,
) -> Result<()> {
    let Some(through) = request["through"].as_u64() else {
        return Ok(());
    };
    let fh = file_hash
        .or_else(|| data["fileHash"].as_str())
        .or_else(|| data["version"].as_str());
    let nh = data["normalizedHash"].as_str();
    if !matches_bound_book(request, fh, nh) {
        return Ok(());
    }
    if let Some(section) = data["section"].as_u64().or_else(|| request["section"].as_u64()) {
        if section > through {
            return Err(Error::Invalid("所选章节不存在或超出本次参考范围。".into()));
        }
    }
    if let Some(sections) = data["sections"].as_array_mut() {
        sections.retain(|s| {
            s["index"]
                .as_u64()
                .or_else(|| s["section"].as_u64())
                .is_some_and(|idx| idx <= through)
        });
    }
    if let Some(count) = data["sectionCount"].as_u64() {
        let capped = count.min(through.saturating_add(1));
        data["sectionCount"] = capped.into();
        if data["nextSectionOffset"].as_u64().is_some_and(|next| next >= capped) {
            data["nextSectionOffset"] = Value::Null;
        }
    }
    if let Some(hits) = data["hits"].as_array_mut() {
        hits.retain(|h| h["section"].as_u64().is_none_or(|idx| idx <= through));
    }
    Ok(())
}

pub(crate) fn project(task:&Value,args:&Value,value:&mut Value){
    value["grantId"]=args["grantId"].clone();value["path"]=args["path"].clone();
    if value["complete"].is_boolean(){
        let next=if value["complete"]==true{Value::Null}else{
            let cursor=json!({"taskId":task["id"],"grantId":args["grantId"],"path":args["path"],"version":value["version"],"offset":value["nextOffset"],"section":value["section"]});
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(cursor.to_string()).into()
        };
        value["nextCursor"]=next;
    }
    if value["section"].is_number(){value["scope"]="section".into();}
}

pub(crate) fn catalog()->Vec<crate::tools::ToolDefinition>{
    use crate::tools::ToolDefinition;
    let mut result=vec![];
    for (name,description,extra,readonly) in [
        ("list_documents","查看本任务获准的资料目录。省略grantId列出已选资料范围；指定grantId可分页查看目录，path只在所选范围内。",json!({"offset":{"type":"integer","minimum":0},"pageSize":{"type":"integer","minimum":1,"maximum":100}}),true),
        ("read_document","读取已授权文件，复用现有TXT/EPUB/PDF/DOCX解析。section从0开始，offset按Unicode字符；继续回传nextCursor读取当前章节。目录按sectionOffset/pageSize分页，nextSectionOffset为空才到末尾；不能绕过已绑定原著限章。",json!({"section":{"type":"integer","minimum":0},"offset":{"type":"integer","minimum":0},"sectionOffset":{"type":"integer","minimum":0},"pageSize":{"type":"integer","minimum":1,"maximum":100},"charBudget":{"type":"integer","minimum":1,"maximum":24000},"version":{"type":"string"}}),true),
        ("find_document","在已授权文件正文中查找文字，返回命中附近内容及章节/页码，不返回整本书。",json!({"query":{"type":"string","minLength":1,"maxLength":512}}),true),
        ("write_document","向已授权可写范围保存UTF-8笔记（TXT/MD/JSON）。修改现有文件必须提供读取时版本；外部文件不随故事撤回，结果未知不能重放。",json!({"text":{"type":"string","maxLength":262144},"version":{"type":"string"}}),false),
    ]{
        let mut properties=json!({"grantId":{"type":"string"},"path":{"type":"string"},"nextCursor":{"type":"string","maxLength":8192},"version":{"type":"string"}});
        for(key,value)in extra.as_object().unwrap(){properties[key]=value.clone();}
        let mut required=vec![];if name!="list_documents"{required.push("grantId");}if name=="write_document"{required.push("text");}if name=="find_document"{required.push("query");}
        result.push(ToolDefinition{name,description,parameters:json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),read_only:readonly});
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc,Mutex};
    #[test]
    fn frozen_grant_cursor_and_current_revocation_share_one_scope(){
        let store=Store(Arc::new(Mutex::new(Connection::open_in_memory().unwrap())));
        crate::migration::migrate(&mut store.lock().unwrap(),None).unwrap();
        crate::pi_store::PiStore(store.clone()).initialize().unwrap();
        let public=register(&store,&json!({"path":"private-native-location","name":"资料目录","directory":true}),true).unwrap();assert!(!public.to_string().contains("private-native-location"));
        let task=json!({"id":"task","world_id":"world","metadata_json":json!({"fileGrants":pin(&*store.lock().unwrap()).unwrap()}).to_string()});
        let plan:RunPlan=serde_json::from_value(json!({"id":"task","worldId":"world","lineId":"line","headId":"head","kind":"pi_task","model":{"slot":"","url":"","model":"","includeUsage":false},"messages":[],"extractMessages":[],"state":{},"settings":{},"options":{},"action":{},"meta":{"agent":{"readOnly":true}}})).unwrap();
        let args=json!({"grantId":public["id"],"path":"book.txt"});
        assert!(request(&*store.lock().unwrap(),&task,&plan,&args,false).is_ok());assert!(request(&*store.lock().unwrap(),&task,&plan,&args,true).is_err());
        let mut page=json!({"version":"file-version","nextOffset":20,"complete":false,"section":2});project(&task,&args,&mut page);
        let next=request(&*store.lock().unwrap(),&task,&plan,&json!({"grantId":public["id"],"path":"book.txt","nextCursor":page["nextCursor"]}),false).unwrap();assert_eq!(next["offset"],20);assert_eq!(next["section"],2);assert_eq!(next["version"],"file-version");
        assert!(request(&*store.lock().unwrap(),&task,&plan,&json!({"grantId":public["id"],"path":"other.txt","nextCursor":page["nextCursor"]}),false).is_err());
        let updated=register(&store,&json!({"path":"private-native-location","name":"资料目录","directory":true}),false).unwrap();
        assert_eq!(updated["id"],public["id"]);assert_eq!(updated["revision"],2);assert_eq!(list(&*store.lock().unwrap()).unwrap().len(),1);
        assert!(request(&*store.lock().unwrap(),&task,&plan,&args,false).is_err(),"reselecting a scope retires the previous task grant");
        revoke(&*store.lock().unwrap(),public["id"].as_str().unwrap()).unwrap();assert!(request(&*store.lock().unwrap(),&task,&plan,&args,false).is_err());
    }
    #[test]
    fn spoiler_fence_matches_by_book_id_or_raw_file_hash_and_uses_parser2_prefix() {
        let store = Store(Arc::new(Mutex::new(Connection::open_in_memory().unwrap())));
        crate::migration::migrate(&mut store.lock().unwrap(), None).unwrap();
        crate::pi_store::PiStore(store.clone()).initialize().unwrap();
        store
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO source_books(id,title,format,json,created_at) VALUES('b1','原著','txt',?,'t')",
                [json!({
                    "fileHash": "AA11BB22",
                    "sections": [{"title":"一","text":"正文一"},{"title":"二","text":"正文二"},{"title":"三","text":"剧透三"}]
                })
                .to_string()],
            )
            .unwrap();
        let grant = register(&store, &json!({"path":"native-book","name":"原著","directory":false}), false).unwrap();
        let task = json!({"id":"task","world_id":"world","metadata_json":json!({"fileGrants":pin(&*store.lock().unwrap()).unwrap()}).to_string()});
        let plan: RunPlan = serde_json::from_value(json!({
            "id":"task","worldId":"world","lineId":"line","headId":"head","kind":"pi_task",
            "model":{"slot":"","url":"","model":"","includeUsage":false},
            "messages":[],
            "extractMessages":[],
            "state":{},
            "settings":{},
            "options":{},
            "action":{},
            "meta":{"agent":{"readOnly":true,"referenceScope":{"bookId":"b1","through":1}}}
        }))
        .unwrap();
        let req = request(
            &*store.lock().unwrap(),
            &task,
            &plan,
            &json!({"grantId":grant["id"],"path":"book.txt"}),
            false,
        )
        .unwrap();
        assert_eq!(req["parserCachePrefix"], "parser2-");
        assert_eq!(req["boundBookId"], "b1");
        assert_eq!(req["boundFileHash"], "aa11bb22");
        assert_eq!(req["through"], 1);
        let mut parsed = json!({
            "section": 1,
            "sectionCount": 3,
            "nextSectionOffset": 2,
            "sections": [{"index":0,"title":"一"},{"index":1,"title":"二"},{"index":2,"title":"剧透三"}],
            "hits": [{"section":0,"snippet":"一"},{"section":2,"snippet":"剧透"}]
        });
        enforce_spoiler_fence(&req, Some("aa11bb22"), &mut parsed).unwrap();
        assert_eq!(parsed["sectionCount"], 2);
        assert!(parsed["nextSectionOffset"].is_null());
        assert_eq!(parsed["sections"].as_array().unwrap().len(), 2);
        assert_eq!(parsed["hits"].as_array().unwrap().len(), 1);
        let mut spoiler_read = json!({"section": 2, "text": "剧透三"});
        assert!(enforce_spoiler_fence(&req, Some("aa11bb22"), &mut spoiler_read).is_err());
    }
}
