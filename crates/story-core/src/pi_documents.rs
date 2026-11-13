//! Native-picked file grants. Paths/URIs never become model capabilities.
use crate::{agent_workspace as ws,Error,Result,RunPlan,Store};
use rusqlite::{params,Connection,OptionalExtension};
use serde_json::{json,Value};
use base64::Engine;

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
    let mut result=args.clone();result["_documentGrant"]=ws::parse(&scope);result["taskId"]=task["id"].clone();result["worldId"]=task["world_id"].clone();
    let binding=&plan.meta["agent"]["referenceScope"];
    if let (Some(book),Some(through))=(binding["bookId"].as_str(),binding["through"].as_u64()){
        let raw:Option<String>=db.query_row("SELECT json FROM source_books WHERE id=?",[book],|r|r.get(0)).optional()?;
        if let Some(raw)=raw {let value=ws::parse(&raw);let texts=json!(value["sections"].as_array().into_iter().flatten().map(|s|ws::text(s,"text")).collect::<Vec<_>>());result["boundBookHash"]=crate::pi_store::arguments_hash(&texts).into();result["through"]=through.into();}
    }
    Ok(result)
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
}
