//! Immutable, root-owned authority for readonly Pi child sessions. Session
//! creation and model scheduling stay in the full Pi SDK, never a Rust loop.
use crate::{agent_workspace as ws,pi_store::arguments_hash,Error,Result};
use rusqlite::{params,Connection,OptionalExtension};
use serde_json::{json,Value};

#[derive(Clone)]
pub(crate) struct ChildAuthority {
    pub(crate) id:String,
    pub(crate) task_id:String,
    pub(crate) parent_call_id:String,
    pub(crate) world_version:String,
    pub(crate) intent_revision:i64,
}
impl ChildAuthority {
    pub(crate) fn call_id(&self,original:&str)->String {format!("child-{}-{}",self.id,arguments_hash(&json!({"id":original})))}
    pub(crate) fn owns_call(&self,id:&str)->bool {id.starts_with(&format!("child-{}-",self.id))}
}
fn invalid(message:&str)->Error{Error::Invalid(message.into())}
/// Called inside the parent's already-authorized SQLite transaction, after
/// its tool call has been registered. The capture callback pins only explicit
/// provided draft views, never the full root workspace.
pub(crate) fn prepare(db:&Connection,task:&Value,parent:&str,args:&Value,mut capture:impl FnMut(&Value)->Result<Value>)->Result<Value> {
    if db.is_autocommit(){return Err(invalid("子任务建立必须与父任务权限在同一事务中检查"));}
    let id=ws::text(task,"id");
    let saved:Option<(String,String,String,i64)>=db.query_row("SELECT status,args_hash,world_version,intent_revision FROM pi_calls WHERE task_id=? AND call_id=? AND tool='delegate_readonly'",params![id,parent],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    if !saved.is_some_and(|r|r.0=="running"&&r.1==arguments_hash(args)&&task["base_world_version"]==r.2&&task["intent_revision"].as_i64()==Some(r.3)) {return Err(Error::Stale);}
    let tasks=args["tasks"].as_array().filter(|v|!v.is_empty()&&v.len()<=2).ok_or_else(||invalid("每次可分派一至两项只读核对"))?;
    let count:i64=db.query_row("SELECT COUNT(*) FROM pi_children WHERE task_id=? AND status IN ('prepared','running')",[id],|r|r.get(0))?;
    if count+tasks.len()as i64>2{return Err(invalid("本次任务同时最多运行两项只读子任务"));}
    let mut children=vec![];let mut names=std::collections::HashSet::new();
    for item in tasks {
        let name=ws::text(item,"name").trim();let prompt=ws::text(item,"prompt").trim();
        if name.is_empty()||name.chars().count()>80||prompt.is_empty()||prompt.chars().count()>40000||!names.insert(name){return Err(invalid("子任务须有不同名称和有效的具体核对要求"));}
        if !item.is_object()||item.as_object().unwrap().keys().any(|k|!["name","prompt","draftRefs"].contains(&k.as_str())) {return Err(invalid("子任务只能包含name、prompt和draftRefs"));}
        let references=match item.get("draftRefs") {None=>vec![],Some(Value::Array(refs))=>refs.clone(),_=>return Err(invalid("draftRefs必须为明确的资源定位列表"))};
        if references.len()>16{return Err(invalid("子助手只接收必要的草稿定位，一次最多16项"));}
        let mut provided=vec![];
        for reference in references {provided.push(capture(&reference)?);}
        if serde_json::to_vec(&provided)?.len()>1024*1024 {return Err(invalid("提供给子助手的草稿过多，请缩小到必要段落"));}
        let child=ws::id();let now=ws::now();
        db.execute("INSERT INTO pi_children(id,task_id,parent_call_id,name,prompt,status,world_version,intent_revision,provided_json,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?,?,?,?)",params![child,id,parent,name,prompt,ws::text(task,"base_world_version"),task["intent_revision"].as_i64().unwrap_or(0),json!(provided).to_string(),now,now])?;
        children.push(json!({"id":child,"name":name,"prompt":prompt,"worldVersion":task["base_world_version"],"intentRevision":task["intent_revision"],"providedDrafts":provided.iter().enumerate().map(|(index,item)|json!({"index":index,"ref":item["ref"]})).collect::<Vec<_>>() }));
    }
    Ok(json!({"parentCallId":parent,"mode":"readonly","children":children,"goalCompleted":false}))
}
pub(crate) fn readonly_tool(name:&str)->bool {
    matches!(name,"discover_tools"|"list_resources"|"read_resource"|"search_resources"|"read_world"|"read_story_resources"|"read_continuity"|"read_clock"|"list_skills"|"read_skill"|"read_skill_resource"|"search_original"|"read_original"|"read_canon_facts"|"read_player_choices"|"read_tool_result"|"web_search"|"read_webpage"|"read_external_resource"|"browser_open"|"browser_read"|"browser_find"|"browser_follow"|"browser_close"|"list_documents"|"read_document"|"find_document"|"list_remote_tools"|"call_remote_tool"|"list_mcp_resources"|"read_mcp_resource"|"read_provided_draft"|"search_agent_history"|"read_agent_history" | "read_timeline" | "read_evidence" | "read_fact_sources")
}
pub(crate) fn catalog()->Vec<crate::tools::ToolDefinition> {
    let mut tools=crate::pi_tools::catalog().into_iter().filter(|tool|readonly_tool(tool.name)).collect::<Vec<_>>();
    tools.push(crate::tools::ToolDefinition{name:"read_provided_draft",description:"只读主助手明确提供的草稿片段。index来自子任务定位；path/offset/limit在已提供片段内分页，不会访问其他未提供草稿。",read_only:true,parameters:json!({"type":"object","additionalProperties":false,"properties":{"index":{"type":"integer","minimum":0,"maximum":15},"path":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":24000}},"required":["index"]})});
    tools
}
pub(crate) fn discover(args:&Value)->Result<Value> {
    let all=catalog();let names=args["names"].as_array().ok_or_else(||invalid("请提供只读工具名称列表"))?;
    if names.iter().any(|name|!name.as_str().is_some_and(|name|all.iter().any(|tool|tool.name==name))){return Err(invalid("子助手只能加载实际存在的只读工具"));}
    let definitions=all.iter().filter(|tool|names.iter().any(|name|name==tool.name)).map(|tool|json!({"name":tool.name,"description":tool.description,"parameters":tool.parameters,"readOnly":true})).collect::<Vec<_>>();
    Ok(json!({"definitions":definitions,"enabledTools":names,"catalog":all.iter().map(|tool|json!({"name":tool.name,"description":tool.description})).collect::<Vec<_>>(),"readOnly":true}))
}
pub(crate) fn provided(db:&Connection,child:&ChildAuthority,args:&Value)->Result<Value> {
    let raw:String=db.query_row("SELECT provided_json FROM pi_children WHERE task_id=? AND id=?",params![child.task_id,child.id],|r|r.get(0))?;
    let provided:Value=serde_json::from_str(&raw)?;let index=args["index"].as_u64().unwrap_or(u64::MAX)as usize;
    let item=provided.as_array().and_then(|items|items.get(index)).ok_or_else(||invalid("这项草稿没有提供给当前子助手"))?;
    let path=ws::text(args,"path");
    let data=if path.is_empty(){item["data"].clone()}else{item["data"].pointer(path).cloned().ok_or_else(||invalid("只能读取已提供草稿片段内的实际字段"))?};
    let mut page=ws::page(data,args);ws::attach_read_locators(&mut page,&json!({"index":index}));
    page["readTool"]="read_provided_draft".into();page["originRef"]=item["ref"].clone();page["worldVersion"]=child.world_version.clone().into();page["intentRevision"]=child.intent_revision.into();
    Ok(page)
}
pub(crate) fn authority(db:&Connection,task:&str,id:&str)->Result<ChildAuthority> {
    db.query_row("SELECT id,task_id,parent_call_id,world_version,intent_revision FROM pi_children WHERE task_id=? AND id=?",params![task,id],|r|Ok(ChildAuthority{id:r.get(0)?,task_id:r.get(1)?,parent_call_id:r.get(2)?,world_version:r.get(3)?,intent_revision:r.get(4)?})).optional()?.ok_or_else(||invalid("这项只读子任务不存在或不属于当前任务"))
}
pub(crate) fn owns_result(db:&Connection,child:&ChildAuthority,call:&str)->Result<bool> {
    Ok(child.owns_call(call)&&db.query_row("SELECT EXISTS(SELECT 1 FROM pi_child_calls WHERE task_id=? AND call_id=? AND child_id=?)",params![child.task_id,call,child.id],|r|r.get::<_,bool>(0))?)
}
/// Must run with the root owner's existing authority check. It never upgrades
/// an old child's intent or story version to match newer user requirements.
pub(crate) fn guard(db:&Connection,task:&Value,child:&ChildAuthority)->Result<()> {
    let saved=authority(db,ws::text(task,"id"),&child.id)?;
    let parent:Option<String>=db.query_row("SELECT status FROM pi_calls WHERE task_id=? AND call_id=? AND tool='delegate_readonly'",params![child.task_id,child.parent_call_id],|r|r.get(0)).optional()?;
    let status:String=db.query_row("SELECT status FROM pi_children WHERE id=?",[&child.id],|r|r.get(0))?;
    if saved.task_id!=child.task_id||saved.parent_call_id!=child.parent_call_id||saved.world_version!=child.world_version||saved.intent_revision!=child.intent_revision
        || task["status"]!="running"||task["stop_revision"].as_i64().unwrap_or(0)>0||task["base_world_version"]!=child.world_version||task["intent_revision"].as_i64()!=Some(child.intent_revision)||status!="running"||parent.as_deref()!=Some("running") {return Err(Error::Stale);}
    Ok(())
}
pub(crate) fn authorize_tool(db:&Connection,task:&Value,child:&ChildAuthority,name:&str,args:&Value)->Result<()> {
    guard(db,task,child)?;
    if !readonly_tool(name){return Err(invalid("只读子助手不能编辑、提交、提问、执行脚本或继续分派"));}
    if name=="discover_tools" && args["names"].as_array().into_iter().flatten().any(|name|!name.as_str().is_some_and(readonly_tool)) {return Err(invalid("只读子助手只能加载已允许的只读工具"));}
    if name=="read_tool_result" {
        let call=ws::text(args,"callId");
        let owned=owns_result(db,child,call)?;
        if !owned{return Err(invalid("只读子助手只能回读自己实际完成的调用；主助手草稿须经明确提供"));}
    }
    if name=="call_remote_tool" {
        let meta=ws::parse(ws::text(task,"metadata_json"));
        let allowed=meta["network"]["mcps"].as_array().into_iter().flatten().find(|server|server["id"]==args["serverId"]&&server["enabled"]==true)
            .is_some_and(|server|server["readOnlyTools"].as_array().into_iter().flatten().any(|name|name==&args["name"])&&server["allowedTools"].as_array().into_iter().flatten().any(|name|name==&args["name"]));
        if !allowed{return Err(invalid("该远端工具没有玩家预先授予的只读范围，子助手不能调用"));}
    }
    Ok(())
}
pub(crate) fn interrupt(db:&Connection,task:&str,reason:&str)->Result<()> {
    db.execute("UPDATE pi_children SET status='interrupted',error=?,updated_at=? WHERE task_id=? AND status IN ('prepared','running')",params![reason,ws::now(),task])?;Ok(())
}

pub(crate) fn open(db:&Connection,task:&Value,child:&ChildAuthority,file:&str)->Result<Value> {
    if db.is_autocommit(){return Err(invalid("子会话开启须与父任务权限在同一事务核对"));}
    let status:String=db.query_row("SELECT status FROM pi_children WHERE id=? AND task_id=?",params![child.id,child.task_id],|r|r.get(0))?;
    if status!="prepared" {return Err(invalid("子会话已开启或中断，不会自动重放"));}
    db.execute("UPDATE pi_children SET status='running',session_file=?,updated_at=? WHERE id=?",params![file,ws::now(),child.id])?;
    guard(db,task,child)?;
    context(db,task,child)
}
pub(crate) fn context(db:&Connection,task:&Value,child:&ChildAuthority)->Result<Value> {
    guard(db,task,child)?;
    let (name,prompt,provided):(String,String,String)=db.query_row("SELECT name,prompt,provided_json FROM pi_children WHERE id=?",[&child.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    let meta=ws::parse(ws::text(task,"metadata_json"));
    let supplied:Value=serde_json::from_str(&provided)?;
    let corrections={let mut stmt=db.prepare("SELECT content_json FROM pi_inputs WHERE task_id=? AND delivery IN ('steer','answer') AND status='delivered' AND intent_revision<=? ORDER BY seq")?;let rows=stmt.query_map(params![child.task_id,child.intent_revision],|r|r.get::<_,String>(0))?;rows.map(|row|row.map(|raw|json!({"text":ws::parse(&raw)["text"]}))).collect::<std::result::Result<Vec<_>,_>>()?};
    // Root draft contents, queued inputs and conversation are deliberately
    // absent. Only explicitly provided views have a child-readable locator.
    Ok(json!({"goal":format!("玩家原始目标：{}\n仅执行这项只读核对：{prompt}",ws::text(task,"text")),"corrections":corrections,"plan":[],"requestedSkills":meta["skills"],"intentRevision":child.intent_revision,"consumedIntentRevision":child.intent_revision,"storyVersion":child.world_version,"status":"running","resource":{"worldId":task["world_id"],"lineId":task["line_id"]},"draftRefs":supplied.as_array().into_iter().flatten().enumerate().map(|(index,item)|json!({"index":index,"ref":item["ref"]})).collect::<Vec<_>>(),"warning":format!("只读核对：{name}。只读正式资料及主助手明确提供的草稿片段；不能修改、提交、提问、执行脚本或派生。主任务要求或故事版本变化后，当前核对立即失效。" )}))
}
pub(crate) fn finish(db:&Connection,task:&Value,child:&ChildAuthority,args:&Value)->Result<Value> {
    if db.is_autocommit(){return Err(invalid("子任务结果须与原生身份在同一事务保存"));}
    let status:String=db.query_row("SELECT status FROM pi_children WHERE id=? AND task_id=?",params![child.id,child.task_id],|r|r.get(0))?;
    if !["prepared","running","interrupted"].contains(&status.as_str()){return Err(invalid("子任务结果已存在，不会覆盖或重跑"));}
    let current=guard(db,task,child).is_ok();
    let answer=args["text"].as_str().unwrap_or("");
    if answer.encode_utf16().count()>32000{return Err(invalid("子任务结果过长，请保留必要结论及调用定位"));}
    let completed=current&&status=="running"&&args["ok"]==true;
    let calls={let mut stmt=db.prepare("SELECT c.call_id,c.tool,c.status FROM pi_calls c JOIN pi_child_calls a ON a.task_id=c.task_id AND a.call_id=c.call_id WHERE a.task_id=? AND a.child_id=? ORDER BY c.created_at")?;let rows=stmt.query_map(params![child.task_id,child.id],|r|Ok(json!({"callId":r.get::<_,String>(0)?,"tool":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?})))?;rows.collect::<std::result::Result<Vec<_>,_>>()?};
    let result=json!({"childId":child.id,"status":if completed{"answered"}else if !current{"stale"}else{"failed"},"text":answer,"worldVersion":child.world_version,"intentRevision":child.intent_revision,"calls":calls,"goalCompleted":false,"warning":"子助手答复只作核对参考，不能代替主助手核实、实际修改或正式提交"});
    db.execute("UPDATE pi_children SET status=?,result_json=?,error=?,updated_at=? WHERE id=?",params![if completed{"answered"}else if !current{"interrupted"}else{"failed"},result.to_string(),if completed{None}else{Some("子任务未完整答复或权限版本已失效")},ws::now(),child.id])?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn child_reads_formal_story_and_only_explicitly_provided_draft_views() {
        use std::sync::{Arc,Mutex};
        use crate::{pi_gateway::StoryToolGateway,pi_store::PiCallRequest,Store};
        let mut db=Connection::open_in_memory().unwrap();db.execute_batch("PRAGMA foreign_keys=ON").unwrap();crate::migration::migrate(&mut db,None).unwrap();
        db.execute_batch("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('w','隔离','free','l','{\"premise\":\"正式设定\"}','test','test','test');INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n','w',0,'opening','独立正文','test');INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l','w','主线','n','test');INSERT INTO states(node_id,state_json) VALUES('n','{\"time\":{\"start\":\"第一天\",\"elapsedMinutes\":0},\"source\":null}');INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('s','w','l','隔离','test','test')").unwrap();
        let store=Store(Arc::new(Mutex::new(db)));let gateway=StoryToolGateway::new(store.clone());
        let task=gateway.start_task("s","t","核对资料","auto-reversible",false,json!({"model":"no-http"}),json!({})).unwrap();
        let permit=gateway.permit("t").unwrap();let version=task["base_world_version"].as_str().unwrap();
        let request=|id:&str,tool:&str,args:Value|PiCallRequest{task_id:"t".into(),call_id:id.into(),tool:tool.into(),args,intent_revision:0,world_version:version.into(),external_write:false};
        let long_draft=format!("仅明确提供的草稿内容{}末尾需要核对","稿".repeat(26000));
        assert_eq!(gateway.invoke(&permit,request("root-edit","stage_edit",json!({"kind":"settings","path":"/premise","operation":"set","value":long_draft,"summary":"未采用修改"}))).unwrap()["ok"],true);
        let draft=gateway.invoke(&permit,request("root-read","read_resource",json!({"kind":"settings","path":"/premise"}))).unwrap();
        let prepared=gateway.prepare_children(&permit,&request("delegate","delegate_readonly",json!({"tasks":[{"name":"核对资料","prompt":"核对正式设定，另看明确提供的草稿","draftRefs":[draft["data"]["ref"]]}]}))).unwrap();
        assert_eq!(prepared["ok"],true,"{prepared}");assert!(!prepared.to_string().contains("仅明确提供的草稿内容"),"draft content must not be preloaded into child startup");
        let id=prepared["data"]["children"][0]["id"].as_str().unwrap();
        let child=gateway.open_child(&permit,id,"/owned/child-session.jsonl").unwrap();
        assert!(gateway.open_child(&permit,id,"/owned/child-session.jsonl").is_err(),"opening a child twice must not replay it");
        assert_eq!(gateway.invoke(&permit,request("early-finish","finish_task",json!({"summary":"不应提前采用","outcome":"completed"}))).unwrap()["ok"],false);
        let read_id=child.call_id("read");
        let formal=gateway.invoke_child(&permit,request(&read_id,"read_resource",json!({"kind":"settings","path":"/premise"})),&child).unwrap();
        assert_eq!(formal["data"]["text"],"正式设定");assert!(!formal.to_string().contains("仅明确提供的草稿内容"));
        let provided=gateway.invoke_child(&permit,request(&child.call_id("provided"),"read_provided_draft",json!({"index":0})),&child).unwrap();
        assert!(provided.to_string().contains("仅明确提供的草稿内容"));
        let tail=gateway.invoke_child(&permit,request(&child.call_id("provided-tail"),"read_provided_draft",json!({"index":0,"offset":26000,"limit":100})),&child).unwrap();
        assert!(tail.to_string().contains("末尾需要核对"),"an explicitly provided long field must remain pageable beyond its first 24000 characters");
        assert_eq!(gateway.invoke_child(&permit,request(&child.call_id("other-draft"),"read_provided_draft",json!({"index":1})),&child).unwrap()["ok"],false);
        assert_eq!(gateway.invoke_child(&permit,request(&child.call_id("cannot-write"),"stage_edit",json!({"kind":"settings","path":"/premise","operation":"set","value":"子助手越权","summary":"禁止"})),&child).unwrap()["ok"],false);
        assert_eq!(gateway.invoke_child(&permit,request(&child.call_id("foreign-result"),"read_tool_result",json!({"callId":"root-read"})),&child).unwrap()["ok"],false);
        let own=gateway.invoke_child(&permit,request(&child.call_id("own-result"),"read_tool_result",json!({"callId":read_id})),&child).unwrap();
        assert!(own.to_string().contains("正式设定")&&!own.to_string().contains("仅明确提供的草稿内容"));
        let current=gateway.invoke(&permit,request("root-final-read","read_resource",json!({"kind":"settings","path":"/premise"}))).unwrap();
        assert!(current["data"]["text"].as_str().unwrap().starts_with("仅明确提供的草稿内容"));
        gateway.reserve_model_request(&permit,"root-request","model",&json!({"model":"isolated"})).unwrap();
        gateway.reserve_model_scoped(&permit,"child-request","subagent",&json!({"model":"isolated"}),Some(&child)).unwrap();
        assert!(gateway.reserve_model_scoped(&permit,"third-request","subagent",&json!({"model":"isolated"}),Some(&child)).is_err(),"root and children share two in-flight request slots");
        gateway.finish_model_request(&permit,"root-request",&json!({"input":2,"output":1}),"success").unwrap();
        gateway.finish_model_request(&permit,"child-request",&json!({"input":3,"output":1}),"success").unwrap();
        let report=gateway.finish_child(&permit,&child,&json!({"ok":true,"text":"已查正式设定与明确提供片段"})).unwrap();
        assert_eq!(report["status"],"answered");assert_eq!(report["goalCompleted"],false);
        let reports=gateway.finish_children(&permit,&request("delegate","delegate_readonly",json!({"tasks":[{"name":"核对资料","prompt":"核对正式设定，另看明确提供的草稿","draftRefs":[draft["data"]["ref"]]}]}))).unwrap();
        assert_eq!(reports["data"]["allAnswered"],true);
        assert_eq!(reports["data"]["goalCompleted"],false);
        assert!(gateway.reserve_model_scoped(&permit,"after-child-ended","subagent",&json!({"model":"isolated"}),Some(&child)).is_err());
        let db=store.lock().unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM pi_model_requests WHERE task_id='t'",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        assert_eq!(db.query_row("SELECT source FROM pi_model_requests WHERE request_id='child-request'",[],|r|r.get::<_,String>(0)).unwrap(),"subagent");
    }
    #[test]
    fn readonly_authority_rejects_writes_foreign_results_and_changed_root_intent() {
        let mut db=Connection::open_in_memory().unwrap();crate::migration::migrate(&mut db,None).unwrap();
        db.execute_batch("INSERT INTO worlds(id,title,era_id,created_at,updated_at,played_at) VALUES('w','隔离','free','test','test','test');INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('s','w','l','隔离','test','test');INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,base_json,base_world_version,created_at,updated_at) VALUES('t','s','w','l','检查','running','auto','{}','v1','test','test');INSERT INTO pi_calls(task_id,call_id,tool,args_hash,world_version,intent_revision,external_write,status,created_at,updated_at) VALUES('t','parent','delegate_readonly','h','v1',0,0,'running','test','test');INSERT INTO pi_children(id,task_id,parent_call_id,name,prompt,status,world_version,intent_revision,created_at,updated_at) VALUES('c','t','parent','核对','核对人物','running','v1',0,'test','test')").unwrap();
        let mut task=json!({"id":"t","status":"running","stop_revision":0,"base_world_version":"v1","intent_revision":0,"metadata_json":"{\"network\":{\"mcps\":[{\"id\":\"remote\",\"enabled\":true,\"allowedTools\":[\"search\",\"write\"],\"readOnlyTools\":[\"search\"]}]}}"});
        let child=authority(&db,"t","c").unwrap();
        authorize_tool(&db,&task,&child,"read_resource",&json!({"kind":"state"})).unwrap();
        for tool in ["stage_edit","finish_task","delegate_readonly","run_script","ask_user","draft_skill"]{assert!(authorize_tool(&db,&task,&child,tool,&json!({})).is_err());}
        assert!(authorize_tool(&db,&task,&child,"read_tool_result",&json!({"callId":"parent-draft"})).is_err());
        let own=child.call_id("own-read");
        assert!(authorize_tool(&db,&task,&child,"read_tool_result",&json!({"callId":own})).is_err(),"a matching prefix alone is not proof of ownership");
        db.execute("INSERT INTO pi_calls(task_id,call_id,tool,args_hash,world_version,intent_revision,external_write,status,created_at,updated_at) VALUES('t',?,'read_resource','h','v1',0,0,'done','test','test')",[&own]).unwrap();
        db.execute("INSERT INTO pi_child_calls(task_id,call_id,child_id) VALUES('t',?,'c')",[&own]).unwrap();
        authorize_tool(&db,&task,&child,"read_tool_result",&json!({"callId":own})).unwrap();
        authorize_tool(&db,&task,&child,"call_remote_tool",&json!({"serverId":"remote","name":"search"})).unwrap();
        assert!(authorize_tool(&db,&task,&child,"call_remote_tool",&json!({"serverId":"remote","name":"write"})).is_err());
        task["intent_revision"]=1.into();assert!(guard(&db,&task,&child).is_err());
        task["intent_revision"]=0.into();interrupt(&db,"t","新要求使旧核对失效").unwrap();assert!(guard(&db,&task,&child).is_err());
    }
}
