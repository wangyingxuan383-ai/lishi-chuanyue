//! Independent compatibility adapter for the documented Operit pure-JS subset.
//! Upstream application, SDK, UI and execution loop are not embedded here.
use crate::{agent_script::{self,ScriptHost,ScriptRequest},agent_workspace as ws,Error,Result,Store};
use base64::Engine;
use rusqlite::{params,Connection,OptionalExtension};
use serde_json::{json,Value};
use std::{collections::{BTreeMap,BTreeSet},io::{Cursor,Read},sync::{Arc,Mutex,OnceLock}};
use tokio_util::sync::CancellationToken;

static IMPORTS:OnceLock<Mutex<BTreeMap<String,CancellationToken>>>=OnceLock::new();
pub(crate) fn cancel_import(request:&Value)->Result<Value>{let id=ws::text(request,"importId");if let Some(token)=IMPORTS.get_or_init(Default::default).lock().map_err(|_|Error::Cancelled)?.get(id){token.cancel();}Ok(json!({"accepted":true}))}
const MAX_PACKAGE:usize=8*1024*1024;
fn invalid(s:&str)->Error {Error::Invalid(s.into())}
fn path_ok(path:&str)->bool {!path.is_empty()&&path.len()<=500&&!path.starts_with('/')&&!path.contains(['\\',':','\0'])&&path.split('/').all(|s|!s.is_empty()&&s!="."&&s!="..")}
fn label(value:&Value)->String {value.as_str().or_else(||value["zh"].as_str()).or_else(||value["en"].as_str()).unwrap_or("").chars().take(1000).collect()}

fn archive(bytes:&[u8])->Result<BTreeMap<String,String>> {
    if bytes.len()>MAX_PACKAGE{return Err(invalid("工具包最多8MiB"));}
    let mut zip=zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_|invalid("工具包不是有效ZIP文件"))?;
    if zip.len()>256{return Err(invalid("工具包最多256个资源"));}
    let mut files=BTreeMap::new();let mut total=0;
    for i in 0..zip.len(){
        let file=zip.by_index(i).map_err(|_|invalid("工具包资源损坏"))?;
        if file.is_dir(){continue;}
        let name=file.name().map_err(|_|invalid("工具包路径编码无效"))?.into_owned();
        if !path_ok(&name)||file.unix_mode().is_some_and(|mode|mode&0o170000==0o120000)||files.contains_key(&name){return Err(invalid("工具包包含越级、链接或重复路径"));}
        if file.size()>256*1024{return Err(invalid("工具包单项文字资源最多256KiB"));}
        let mut data=vec![];file.take(256*1024+1).read_to_end(&mut data).map_err(|_|invalid("工具包资源读取失败"))?;
        total+=data.len();if total>MAX_PACKAGE{return Err(invalid("工具包展开后超过8MiB"));}
        let text=String::from_utf8(data).map_err(|_|invalid("首版工具包仅支持UTF-8文字资源，不执行二进制或WASM"))?;
        files.insert(name,text);
    }
    Ok(files)
}

fn modules(files:&BTreeMap<String,String>,entries:&[String])->Result<BTreeMap<String,String>> {
    let regex=regex::Regex::new(r#"require\s*\(\s*['"]([^'"]+)['"]\s*\)"#).unwrap();
    let mut pending=entries.to_vec();let mut result=BTreeMap::new();
    while let Some(path)=pending.pop(){
        if result.contains_key(&path){continue;}
        let source=files.get(&path).ok_or_else(||invalid("工具包入口或依赖不存在"))?.clone();
        for matched in regex.captures_iter(&source){pending.push(resolve(&path,&matched[1],files)?);}
        result.insert(path,source);
        if result.values().map(String::len).sum::<usize>()>192*1024 {return Err(invalid("本次工具入口及依赖超过192KiB，请拆分工具包；未放宽解释器输入限制"));}
    }
    Ok(result)
}
fn assembled(files:&BTreeMap<String,String>,entries:&[String],manifest:&Value)->Result<BTreeMap<String,String>>{
    let mut selected=modules(files,entries)?;
    for resource in manifest["resources"].as_array().into_iter().flatten(){
        let path=ws::text(resource,"path");let key=ws::text(resource,"key");
        if !path_ok(path)||key.len()>128{return Err(invalid("工具包资源定位无效"));}
        let value=files.get(path).ok_or_else(||invalid("工具包声明的文字资源不存在"))?;
        selected.insert(path.into(),value.clone());
        if !key.is_empty(){if selected.contains_key(key)&&key!=path{return Err(invalid("工具包资源键与模块路径冲突"));}selected.insert(key.into(),value.clone());}
    }
    if serde_json::to_vec(&selected)?.len()>192*1024{return Err(invalid("入口与本次文字资源超过192KiB，请拆分支持资料"));}
    Ok(selected)
}
fn resolve(from:&str,name:&str,files:&BTreeMap<String,String>)->Result<String>{
    if !name.starts_with('.')||name.contains(['\\',':','\0']){return Err(invalid("工具包仅支持包内相对模块，不支持Node或网络依赖"));}
    let mut parts:Vec<&str>=from.split('/').collect();parts.pop();
    for part in name.split('/'){match part {""|"."=>{},".."=>{if parts.pop().is_none(){return Err(invalid("模块路径越出工具包"));}},_=>parts.push(part)}}
    let target=parts.join("/");
    for candidate in [target.clone(),format!("{target}.js"),format!("{target}.json"),format!("{target}/index.js")] {if files.contains_key(&candidate){return Ok(candidate);}}
    Err(invalid("工具包相对模块不存在"))
}

pub(crate) struct Prepared {id:String,manifest:Value,files:BTreeMap<String,String>,compatibility:Value,hash:String}
pub(crate) async fn import(store:&Store,request:&Value)->Result<Value>{
    let bytes=base64::engine::general_purpose::STANDARD.decode(ws::text(request,"bytes")).map_err(|_|invalid("工具包编码无效"))?;
    let id=request["importId"].as_str().map(str::to_owned).unwrap_or_else(ws::id);
    if uuid::Uuid::parse_str(&id).is_err(){return Err(invalid("工具包导入标识无效"));}
    let cancel=CancellationToken::new();
    {let mut imports=IMPORTS.get_or_init(Default::default).lock().map_err(|_|Error::Cancelled)?;if imports.len()>=4||imports.contains_key(&id){return Err(invalid("工具包导入仍在处理，请勿重复开始"));}imports.insert(id.clone(),cancel.clone());}
    let result=async {let files=archive(&bytes)?;inspect(files,cancel.clone()).await}.await;
    IMPORTS.get_or_init(Default::default).lock().map_err(|_|Error::Cancelled)?.remove(&id);
    let prepared=result?;if cancel.is_cancelled(){return Err(Error::Cancelled);}
    let mut db=store.lock()?;let tx=db.transaction()?;crate::maintenance::guard(&tx)?;
    let result=save(&tx,&prepared,None)?;tx.commit()?;Ok(result)
}
pub(crate) async fn prepare_draft(args:&Value,cancel:CancellationToken)->Result<Prepared>{
    let mut files:BTreeMap<String,String>=serde_json::from_value(args["files"].clone()).map_err(|_|invalid("工具包草稿files须为相对路径到UTF-8文字的映射"))?;
    if files.contains_key("manifest.json"){return Err(invalid("清单请放在manifest字段，不与files重复"));}
    files.insert("manifest.json".into(),serde_json::to_string(&args["manifest"])?);
    if files.len()>256||files.iter().any(|(path,text)|!path_ok(path)||text.len()>256*1024)||serde_json::to_vec(&files)?.len()>MAX_PACKAGE{return Err(invalid("工具包草稿路径、数量或大小超出支持范围"));}
    inspect(files,cancel).await
}
async fn inspect(files:BTreeMap<String,String>,cancel:CancellationToken)->Result<Prepared>{
    if cancel.is_cancelled(){return Err(Error::Cancelled);}
    if files.contains_key("manifest.hjson")&&!files.contains_key("manifest.json"){return Err(invalid("首版只支持manifest.json，请将HJSON清单转换为JSON"));}
    let manifest:Value=serde_json::from_str(files.get("manifest.json").ok_or_else(||invalid("工具包缺少manifest.json"))?).map_err(|_|invalid("工具包清单不是有效JSON"))?;
    let mut missing=BTreeSet::new();
    if manifest["schema_version"]!=1 {missing.insert("不支持的schema_version".to_owned());}
    if !["1.0.0","1.0.1"].contains(&ws::text(&manifest,"api_version")){missing.insert("不支持的api_version，仅兼容1.0.0/1.0.1纯工具子集".into());}
    for key in ["wasm_modules","workflow_templates","workspace_templates"]{if manifest[key].as_array().is_some_and(|a|!a.is_empty()){missing.insert(format!("未接入：{key}"));}}
    let main=ws::text(&manifest,"main");let mut entries=vec![];
    if !main.is_empty(){entries.push(main.to_owned());}
    for package in manifest["subpackages"].as_array().into_iter().flatten(){entries.push(ws::text(package,"entry").to_owned());}
    if entries.is_empty(){missing.insert("没有JavaScript入口".into());}
    for entry in &entries {if !path_ok(entry)||!entry.ends_with(".js"){missing.insert(format!("入口必须为包内JavaScript：{entry}"));}}
    let mut tools=vec![];
    if missing.is_empty(){
        let assembled=assembled(&files,&entries,&manifest)?;
        let interfaces=regex::Regex::new(r"\bTools\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)").unwrap();
        for source in assembled.values(){
            for found in interfaces.captures_iter(source){
                if !["Net.visit","Files.read","Files.list","Files.write"].contains(&format!("{}.{}",&found[1],&found[2]).as_str()) {missing.insert(format!("未接入工具接口：Tools.{}.{}",&found[1],&found[2]));}
            }
            if regex::Regex::new(r"\b(?:OkHttp|Java\.type|Packages\.|getEnv\s*\()").unwrap().is_match(source){missing.insert("需要未接入的原生网络、Java或环境变量接口".into());}
        }
        let input=json!({"mode":"inspect","files":assembled,"main":main,"entries":entries});
        let no_io:ScriptHost=Arc::new(|_,_,_|Box::pin(async{Err(invalid("工具包注册检查期间禁止IO和工具调用"))}));
        match agent_script::run(ScriptRequest{source:ADAPTER.into(),input,..Default::default()},no_io,cancel.clone()).await {
            Ok(result)=>{
                if let Some(raw)=result["output"].as_array().and_then(|a|a.last()).and_then(Value::as_str){
                    let view:Value=serde_json::from_str(raw).map_err(|_|invalid("工具包注册结果无效"))?;
                    if let Some(message)=view["error"]["message"].as_str(){missing.insert(message.to_owned());}
                    tools=view["tools"].as_array().cloned().unwrap_or_default();
                    for item in view["missing"].as_array().into_iter().flatten(){missing.insert(item.as_str().unwrap_or("不支持的注册接口").to_owned());}
                }
            }
            Err(error)=>{missing.insert(error.to_string());}
        }
    }
    if tools.is_empty(){missing.insert("未找到可调用的纯工具导出".into());}
    let id=ws::id();let hash=crate::pi_store::arguments_hash(&json!(files));
    let compatibility=json!({"supported":missing.is_empty(),"missing":missing,"tools":tools,"subset":"pure-js-1"});
    let package_id=ws::text(&manifest,"toolpkg_id");
    if package_id.is_empty()||package_id.len()>256{return Err(invalid("工具包须有有效toolpkg_id"));}
    if cancel.is_cancelled(){return Err(Error::Cancelled);}
    Ok(Prepared{id,manifest,files,compatibility,hash})
}
pub(crate) fn save(db:&Connection,p:&Prepared,task:Option<&str>)->Result<Value>{
    db.execute("INSERT INTO agent_tool_packages(id,package_id,version,hash,status,manifest_json,files_json,compatibility_json,created_at,task_id) VALUES(?,?,?,?,?,?,?,?,?,?)",params![p.id,ws::text(&p.manifest,"toolpkg_id"),ws::text(&p.manifest,"version"),p.hash,if task.is_some(){"draft"}else{"disabled"},p.manifest.to_string(),serde_json::to_string(&p.files)?,p.compatibility.to_string(),ws::now(),task])?;
    Ok(json!({"id":p.id,"name":label(&p.manifest["display_name"]),"version":p.manifest["version"],"hash":p.hash,"enabled":false,"draft":task.is_some(),"compatibility":p.compatibility}))
}
pub(crate) fn adopt(db:&Connection,args:&Value)->Result<Value>{
    let tx=db.unchecked_transaction()?;crate::maintenance::guard(&tx)?;
    let changed=tx.execute("UPDATE agent_tool_packages SET status='disabled',task_id=NULL WHERE id=? AND hash=? AND status='draft'",params![ws::text(args,"id"),ws::text(args,"hash")])?;
    if changed!=1{return Err(invalid("工具包草稿已变化或删除，请重新打开详情"));}tx.commit()?;
    Ok(json!({"saved":true,"enabled":false,"message":"已保存，仍需明确启用；能力声明不会自动获得授权"}))
}

pub(crate) fn list(db:&Connection)->Result<Vec<Value>>{
    let mut stmt=db.prepare("SELECT id,package_id,version,hash,status,manifest_json,compatibility_json FROM agent_tool_packages ORDER BY created_at DESC")?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?)))?;
    rows.map(|r|{let(id,package,version,hash,status,manifest,compat)=r?;let manifest=ws::parse(&manifest);Ok(json!({"id":id,"packageId":package,"name":label(&manifest["display_name"]),"description":label(&manifest["description"]),"version":version,"hash":hash,"enabled":status=="enabled","draft":status=="draft","compatibility":ws::parse(&compat)}))}).collect()
}
pub(crate) fn enable(db:&Connection,request:&Value)->Result<Value>{
    let tx=db.unchecked_transaction()?;crate::maintenance::guard(&tx)?;
    let id=ws::text(request,"id");let enabled=request["enabled"].as_bool().ok_or_else(||invalid("请明确选择是否启用工具包"))?;
    let (raw,status):(String,String)=db.query_row("SELECT compatibility_json,status FROM agent_tool_packages WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if status=="draft"{return Err(invalid("请先采用工具包草稿为常用能力，再明确启用"));}
    if enabled&&ws::parse(&raw)["supported"]!=true{return Err(invalid("工具包存在缺失能力，当前不能启用；请查看兼容详情"));}
    tx.execute("UPDATE agent_tool_packages SET status=? WHERE id=?",params![if enabled{"enabled"}else{"disabled"},id])?;tx.commit()?;
    Ok(json!({"id":id,"enabled":enabled}))
}

pub(crate) fn pinned(db:&Connection)->Result<Value>{Ok(json!(list(db)?.into_iter().filter(|p|p["enabled"]==true).collect::<Vec<_>>()))}

pub(crate) fn execution(db:&Connection,task:&Value,args:&Value)->Result<ScriptRequest>{
    let id=ws::text(args,"packageId");let meta=ws::parse(ws::text(task,"metadata_json"));
    let pin=meta["toolPackages"].as_array().and_then(|p|p.iter().find(|p|p["id"]==id)).ok_or_else(||invalid("此工具包未在本次任务启动时启用，不能自动增加能力"))?;
    let row:Option<(String,String,String,String)>=db.query_row("SELECT manifest_json,files_json,hash,status FROM agent_tool_packages WHERE id=?",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((raw,files,hash,status))=row else{return Err(invalid("工具包已移除"));};
    if status!="enabled"||pin["hash"]!=hash{return Err(invalid("工具包已停用或版本变化，请在新任务重新选择"));}
    let manifest=ws::parse(&raw);let entry=ws::text(args,"entry");
    if entry!=ws::text(&manifest,"main")&&!manifest["subpackages"].as_array().is_some_and(|p|p.iter().any(|p|p["entry"]==entry)){return Err(invalid("调用入口不属于已声明的工具包"));}
    let files:BTreeMap<String,String>=serde_json::from_str(&files)?;
    let main=ws::text(&manifest,"main");let mut entries=vec![entry.to_owned()];if !main.is_empty(){entries.push(main.to_owned());}let selected=assembled(&files,&entries,&manifest)?;
    Ok(ScriptRequest{source:ADAPTER.into(),input:json!({"mode":"run","files":selected,"main":main,"entry":entry,"tool":args["name"],"args":args["arguments"]}),..Default::default()})
}

const ADAPTER:&str=r#"
try {
const files=input.files, cache=Object.create(null), registered=Object.create(null), missing=[];
function resolve(from,name){if(!name.startsWith('.')||/[\\:\0]/.test(name))throw Error('只支持包内相对模块');const parts=from.split('/');parts.pop();for(const p of name.split('/')){if(!p||p==='.')continue;if(p==='..'){if(!parts.length)throw Error('模块越界');parts.pop();}else parts.push(p);}const base=parts.join('/');for(const p of [base,base+'.js',base+'.json',base+'/index.js'])if(Object.hasOwn(files,p))return p;throw Error('模块不存在：'+base);}
function requireFile(path){if(Object.hasOwn(cache,path))return cache[path].exports;if(!Object.hasOwn(files,path))throw Error('入口不存在');const module={exports:{}};cache[path]=module;if(path.endsWith('.json'))module.exports=JSON.parse(files[path]);else new Function('module','exports','require',files[path])(module,module.exports,name=>requireFile(resolve(path,name)));return module.exports;}
let completed, didComplete=false;
globalThis.complete=value=>{if(didComplete)throw Error('工具重复返回结果');completed=value;didComplete=true;};
globalThis.toolCall=async(name,args={})=>{if(input.mode==='inspect')throw Error('注册期间禁止调用工具');const result=await tools[name](args);if(result.ok===false)throw Error(result.error?.message||'工具失败');return result.data??result.value??result.text??result;};
globalThis.readResource=path=>{if(!Object.hasOwn(files,path))throw Error('资源不存在');return files[path];};
globalThis.ToolPkg=new Proxy(Object.create(null),{get:(_,name)=>name==='registerTool'?definition=>{if(!definition||typeof definition.name!=='string'||typeof definition.handler!=='function')throw Error('工具注册须有名称和函数');registered[definition.name]=definition.handler;}:()=>{missing.push('未接入的ToolPkg接口：'+String(name));}});
function scoped(path){if(path&&typeof path==='object'&&typeof path.grantId==='string')return {...path};if(typeof path==='string'&&path.startsWith('grant:')){const [grantId,...parts]=path.slice(6).split('/');return {grantId,path:parts.join('/')};}throw Error('文件路径须为授权资料定位或grant:授权ID/相对路径，不能使用手机绝对路径');}
const versions=new Map();
globalThis.Tools=Object.freeze({Net:Object.freeze({visit:async url=>toolCall('read_webpage',typeof url==='string'?{url}:url)}),Files:Object.freeze({
  read:async path=>{const args=scoped(path),result=await toolCall('read_document',args);versions.set(JSON.stringify(args),result.version);return {...result,content:result.text};},
  list:async path=>toolCall('list_documents',scoped(path)),
  write:async(path,content,append=false)=>{if(append)throw Error('首版工具包不支持隐式追加，请读取版本并显式写出完整笔记');const args=scoped(path);return toolCall('write_document',{...args,text:String(content),version:args.version??versions.get(JSON.stringify(args))??''});}
})});
if(input.main){const main=requireFile(input.main);if(typeof main.registerToolPkg==='function')await main.registerToolPkg();}
if(input.mode==='inspect'){const found=[];for(const entry of input.entries){const exported=requireFile(entry);for(const name of Object.keys(exported)){if(name==='registerToolPkg')continue;if(typeof exported[name]==='function')found.push({entry,name});}}for(const name of Object.keys(registered))found.push({entry:input.main,name});text({tools:found,missing});}
else {if(missing.length)throw Error(missing.join('；'));const exported=requireFile(input.entry), name=input.tool;const fn=Object.hasOwn(registered,name)?registered[name]:Object.hasOwn(exported,name)?exported[name]:null;if(typeof fn!=='function')throw Error('此入口没有指定工具');const result=await fn(input.args??{});text({success:!(didComplete?completed:result)?.error,result:didComplete?completed:result??null});}
} catch(error) { text({success:false,error:{code:'toolpkg_execution_failed',message:String(error?.message??error).slice(0,2400)}}); }
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write,sync::Mutex};
    fn store()->Store {let mut db=Connection::open_in_memory().unwrap();crate::migration::migrate(&mut db,None).unwrap();let store=Store(Arc::new(Mutex::new(db)));crate::pi_store::PiStore(store.clone()).initialize().unwrap();store}
    fn zip(entries:&[(&str,&str)])->String {
        let mut writer=zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name,source) in entries {writer.start_file(*name,zip::write::SimpleFileOptions::default()).unwrap();writer.write_all(source.as_bytes()).unwrap();}
        base64::engine::general_purpose::STANDARD.encode(writer.finish().unwrap().into_inner())
    }
    #[tokio::test]
    async fn unchanged_upstream_time_script_can_be_inspected_enabled_and_executed_without_io(){
        let store=store();let manifest=r#"{"schema_version":1,"api_version":"1.0.0","toolpkg_id":"fixture.upstream.time","version":"1.0.0","display_name":{"zh":"时间样本"},"main":"time.js"}"#;
        let script=include_str!("../tests/fixtures/operit/time.js");
        let imported=import(&store,&json!({"bytes":zip(&[("manifest.json",manifest),("time.js",script)])})).await.unwrap();
        assert_eq!(imported["compatibility"]["supported"],true,"{imported}");
        assert_eq!(imported["compatibility"]["tools"].as_array().unwrap().len(),2);
        assert_eq!(imported["enabled"],false);
        enable(&*store.lock().unwrap(),&json!({"id":imported["id"],"enabled":true})).unwrap();
        let pin=pinned(&*store.lock().unwrap()).unwrap();
        let task=json!({"metadata_json":json!({"toolPackages":pin}).to_string()});
        let args=json!({"packageId":imported["id"],"entry":"time.js","name":"format_time","arguments":{}});
        let script=execution(&*store.lock().unwrap(),&task,&args).unwrap();
        let no_io:ScriptHost=Arc::new(|_,_,_|Box::pin(async{panic!("pure upstream script must not call native tools")}));
        let result=agent_script::run(script,no_io,CancellationToken::new()).await.unwrap();
        let value:Value=serde_json::from_str(result["output"][0].as_str().unwrap()).unwrap();
        assert_eq!(value["success"],true);assert!(value["result"]["iso"].as_str().unwrap().contains('T'));
        enable(&*store.lock().unwrap(),&json!({"id":imported["id"],"enabled":false})).unwrap();
        assert!(execution(&*store.lock().unwrap(),&task,&args).is_err());
    }
    #[tokio::test]
    async fn registration_has_no_io_and_unsupported_hooks_cannot_be_enabled(){
        let store=store();let manifest=r#"{"schema_version":1,"api_version":"1.0.1","toolpkg_id":"fixture.hook","version":"1","main":"main.js"}"#;
        let source="exports.registerToolPkg=()=>ToolPkg.registerAppLifecycleHook({id:'hook'});exports.read=()=>1;";
        let imported=import(&store,&json!({"bytes":zip(&[("manifest.json",manifest),("main.js",source)])})).await.unwrap();
        assert_eq!(imported["compatibility"]["supported"],false);
        assert!(enable(&*store.lock().unwrap(),&json!({"id":imported["id"],"enabled":true})).is_err());
        let io="exports.registerToolPkg=async()=>{await tools.read_resource({kind:'settings'});};exports.read=()=>1;";
        let imported=import(&store,&json!({"bytes":zip(&[("manifest.json",manifest),("main.js",io)])})).await.unwrap();assert_eq!(imported["compatibility"]["supported"],false);
        assert!(archive(&base64::engine::general_purpose::STANDARD.decode(zip(&[("../outside.js","exports.x=()=>1")])).unwrap()).is_err());
    }
    #[tokio::test]
    async fn generated_package_stays_a_draft_and_resource_keys_are_read_only_package_data(){
        let store=store();
        store.lock().unwrap().execute_batch("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('world','隔离包草稿','free','line','{}','test','test','test');INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('session','world','line','test','test','test');INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,base_json,base_world_version,created_at,updated_at) VALUES('test-task','session','world','line','draft package','running','auto','{}','v1','test','test');").unwrap();
        let prepared=prepare_draft(&json!({"manifest":{"schema_version":1,"api_version":"1.0.1","toolpkg_id":"fixture.resource","version":"1","main":"main.js","resources":[{"key":"greeting","path":"resources/greeting.txt"}]},"files":{"main.js":"exports.read=()=>({text:readResource('greeting')});","resources/greeting.txt":"包内资料"}}),CancellationToken::new()).await.unwrap();
        let entry=save(&*store.lock().unwrap(),&prepared,Some("test-task")).unwrap();
        assert_eq!(entry["draft"],true);assert_eq!(entry["enabled"],false);
        assert!(enable(&*store.lock().unwrap(),&json!({"id":entry["id"],"enabled":true})).is_err());assert!(pinned(&*store.lock().unwrap()).unwrap().as_array().unwrap().is_empty());
        adopt(&*store.lock().unwrap(),&json!({"id":entry["id"],"hash":entry["hash"]})).unwrap();
        enable(&*store.lock().unwrap(),&json!({"id":entry["id"],"enabled":true})).unwrap();
        let task=json!({"metadata_json":json!({"toolPackages":pinned(&*store.lock().unwrap()).unwrap()}).to_string()});
        let request=execution(&*store.lock().unwrap(),&task,&json!({"packageId":entry["id"],"entry":"main.js","name":"read"})).unwrap();
        let host:ScriptHost=Arc::new(|_,_,_|Box::pin(async{panic!("resource lookup must not perform IO")}));
        let result=agent_script::run(request,host,CancellationToken::new()).await.unwrap();assert!(result["output"][0].as_str().unwrap().contains("包内资料"));
        let cancel=CancellationToken::new();cancel.cancel();assert!(matches!(prepare_draft(&json!({"manifest":{},"files":{}}),cancel).await,Err(Error::Cancelled)));
    }
}
