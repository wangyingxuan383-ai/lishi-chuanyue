//! Task-owned JavaScript computation. All effects go through the supplied tool
//! gateway; this interpreter never receives native IO or credential handles.
use crate::{chat::BoxFuture, Error, Result};
use rquickjs::{function::Async, AsyncContext, AsyncRuntime, Function, Promise};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub type ScriptHost = Arc<dyn Fn(String, Value, String) -> BoxFuture<Result<Value>> + Send + Sync>;
#[derive(Clone, Default)]
pub struct ScriptRequest {
    pub source: String,
    pub input: Value,
    /// Package-local JavaScript modules. No native or URL resolver is installed.
    pub modules: BTreeMap<String, String>,
    pub store: Value,
    pub catalog: Vec<Value>,
    pub step_id: String,
}
const MAX_DATA: usize = 256 * 1024;
const MAX_HEAP: usize = 32 * 1024 * 1024;
const MAX_STACK: usize = 256 * 1024;
const WALL: Duration = Duration::from_secs(120);

#[cfg(windows)]
fn cpu_ns() -> u64 {
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThread() -> *mut std::ffi::c_void;
        fn GetThreadTimes(
            thread: *mut std::ffi::c_void,
            created: *mut FileTime,
            exited: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
    }
    let mut t = [
        FileTime { low: 0, high: 0 },
        FileTime { low: 0, high: 0 },
        FileTime { low: 0, high: 0 },
        FileTime { low: 0, high: 0 },
    ];
    let p = t.as_mut_ptr();
    // Pseudo-handle belongs to this worker thread and is never exposed to JS.
    unsafe {
        if GetThreadTimes(GetCurrentThread(), p, p.add(1), p.add(2), p.add(3)) == 0 {
            return 0;
        }
    }
    let units = |v: &FileTime| ((v.high as u64) << 32) | v.low as u64;
    (units(&t[2]) + units(&t[3])).saturating_mul(100)
}
#[cfg(any(target_os = "android", target_os = "linux"))]
fn cpu_ns() -> u64 {
    #[repr(C)]
    struct Timespec {
        seconds: std::os::raw::c_long,
        nanos: std::os::raw::c_long,
    }
    extern "C" {
        fn clock_gettime(clock: i32, time: *mut Timespec) -> i32;
    }
    let mut t = Timespec {
        seconds: 0,
        nanos: 0,
    };
    // CLOCK_THREAD_CPUTIME_ID on Linux and Android. These are the supported
    // native Unix targets; wall deadline remains a separate upper bound.
    if unsafe { clock_gettime(3, &mut t) } != 0 {
        return 0;
    }
    (t.seconds as u64)
        .saturating_mul(1_000_000_000)
        .saturating_add(t.nanos as u64)
}
#[cfg(not(any(windows, target_os = "android", target_os = "linux")))]
fn cpu_ns() -> u64 {
    0
}

pub async fn run(
    request: ScriptRequest,
    host: ScriptHost,
    cancel: CancellationToken,
) -> Result<Value> {
    if request.source.len() > MAX_DATA
        || request.input.to_string().len() > MAX_DATA
        || request.store.to_string().len() > MAX_DATA
        || serde_json::to_vec(&request.modules)?.len() > MAX_DATA
        || serde_json::to_vec(&request.catalog)?.len() > MAX_DATA
    {
        return Err(Error::Invalid(
            "脚本或输入较大，请改为分页读取本任务资料".into(),
        ));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    struct StopWorker(CancellationToken);
    impl Drop for StopWorker {
        fn drop(&mut self) {
            self.0.cancel();
        }
    }
    let worker_cancel = cancel.child_token();
    let _worker_lifetime = StopWorker(worker_cancel.clone());
    std::thread::Builder::new()
        .name("story-agent-js".into())
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            let result = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .map_err(|e| Error::Invalid(format!("无法启动脚本执行器：{e}")))
                .and_then(|runtime| runtime.block_on(execute(request, host, worker_cancel)));
            let _ = tx.send(result);
        })
        .map_err(|e| Error::Invalid(format!("无法启动脚本线程：{e}")))?;
    let result = rx
        .await
        .map_err(|_| Error::Invalid("脚本执行器已中断，保留的工具结果可继续读取".into()))?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    result
}

async fn execute(
    request: ScriptRequest,
    host: ScriptHost,
    cancel: CancellationToken,
) -> Result<Value> {
    let runtime = AsyncRuntime::new().map_err(js_error)?;
    runtime.set_memory_limit(MAX_HEAP).await;
    runtime.set_max_stack_size(MAX_STACK).await;
    let wall = Instant::now();
    let cpu = cpu_ns();
    let interrupted = cancel.clone();
    runtime
        .set_interrupt_handler(Some(Box::new(move || {
            interrupted.is_cancelled()
                || wall.elapsed() >= WALL
                || cpu_ns().saturating_sub(cpu) >= 2_000_000_000
        })))
        .await;
    let context = AsyncContext::full(&runtime).await.map_err(js_error)?;
    let calls = Arc::new(AtomicUsize::new(0));
    let step = request.step_id.clone();
    let bridge_cancel = cancel.clone();
    let bridge = move |name: String, arguments: String| {
        let host = host.clone();
        let token = bridge_cancel.clone();
        let index = calls.fetch_add(1, Ordering::SeqCst);
        let key = format!("{step}:host:{index}");
        async move {
            if token.is_cancelled() {
                return json!({"__error":"任务已停止"}).to_string();
            }
            if name == "run_script" || name == "finish_task" {
                return json!({"__error":"脚本不能嵌套执行或绕过主任务收尾"}).to_string();
            }
            if arguments.len() > MAX_DATA {
                return json!({"__error":"工具参数过大，请分页处理"}).to_string();
            }
            let arguments: Value = match serde_json::from_str(&arguments) {
                Ok(v) => v,
                Err(_) => return json!({"__error":"工具参数不是有效JSON"}).to_string(),
            };
            tokio::select! {
                _ = token.cancelled() => json!({"__error":"任务已停止"}).to_string(),
                result = host(name, arguments, key) => match result {
                    Ok(v) if v.to_string().len() <= MAX_DATA => v.to_string(),
                    Ok(_) => json!({"__error":"工具完整结果较大，请使用结果定位分页读取"}).to_string(),
                    Err(e) => json!({"__error":e.to_string()}).to_string(),
                }
            }
        }
    };
    let input = request.input.to_string();
    let stored = if request.store.is_object() {
        request.store
    } else {
        json!({})
    }
    .to_string();
    let catalog = serde_json::to_string(&request.catalog)?;
    // Modules are delivered as source resources; executing them still happens
    // inside this same limited realm, with no filesystem/module resolver.
    let modules = serde_json::to_string(&request.modules)?;
    let source = request.source;
    let work = context.async_with(async |ctx| {
        ctx.globals().set("__host", Function::new(ctx.clone(), Async(bridge))?)?;
        ctx.globals().set("__input", input)?;
        ctx.globals().set("__stored", stored)?;
        ctx.globals().set("__catalog", catalog)?;
        ctx.globals().set("__modules", modules)?;
        ctx.eval::<(), _>(PRELUDE)?;
        let script = format!("(async()=>{{ const value = await (async()=>{{\n{source}\n}})(); return JSON.stringify({{value:value??null,output:__outputs,store:__values}}); }})()");
        let result = ctx.eval::<Promise, _>(script)?.into_future::<String>().await;
        result.map_err(|e| {
            let detail = ctx.catch();
            let text = detail.as_exception().and_then(|e| e.message()).unwrap_or_else(|| e.to_string());
            rquickjs::Error::Io(std::io::Error::other(text))
        })
    });
    let result = tokio::select! {
        _ = cancel.cancelled() => return Err(Error::Cancelled),
        value = tokio::time::timeout(WALL, work) => value.map_err(|_| Error::Limit("脚本执行已到120秒上限，已保留完成的工具步骤"))?.map_err(|error| {
            if cancel.is_cancelled(){return Error::Cancelled;}
            if wall.elapsed()>=WALL{return Error::Limit("脚本执行已到120秒上限，已保留完成的工具步骤");}
            if cpu_ns().saturating_sub(cpu)>=2_000_000_000{return Error::Limit("脚本计算已到2秒CPU上限，已保留完成的工具步骤，请缩小计算后重新安排");}
            if error.to_string().to_ascii_lowercase().contains("out of memory"){return Error::Limit("脚本已到32MiB内存上限，已保留完成的工具步骤，请分批处理");}
            js_error(error)
        })?,
    };
    if result.len() > MAX_DATA {
        return Err(Error::Invalid(
            "脚本结果过大，请保存小型索引并分页读取".into(),
        ));
    }
    Ok(serde_json::from_str(&result)?)
}

fn js_error(error: rquickjs::Error) -> Error {
    Error::Invalid(format!(
        "脚本未完成：{error}；请缩小计算或检查已保存的工具步骤"
    ))
}
const PRELUDE: &str = r#"
'use strict';
globalThis.input = JSON.parse(__input);
globalThis.ALL_TOOLS = Object.freeze(JSON.parse(__catalog));
globalThis.__values = Object.assign(Object.create(null),JSON.parse(__stored));
globalThis.__outputs = [];
let outputSize = 0;
globalThis.text = value => { const s=typeof value==='string'?value:JSON.stringify(value); outputSize+=(s||'').length; if(outputSize>65536)throw Error('输出过长，请只返回所需片段'); __outputs.push(s??''); };
globalThis.console = Object.freeze({log:(...v)=>text(v),info:(...v)=>text(v),warn:(...v)=>text(v)});
globalThis.store = (key,value) => {if(typeof key!=='string'||key.length>200)throw Error('存储名称无效'); if(value===undefined)delete __values[key]; else __values[key]=JSON.parse(JSON.stringify(value)); if(JSON.stringify(__values).length>65536)throw Error('任务暂存较大，请保留定位和简短摘要');};
globalThis.load = key => __values[key];
globalThis.tools = new Proxy(Object.create(null),{get:(_,name)=>{if(typeof name!=='string'||name==='then')return undefined; return async(args={})=>{const v=JSON.parse(await __host(name,JSON.stringify(args)));if(v&&v.__error)throw Error(v.__error);return v;};}});
// Page protocol is shared with native tools: no guessed offset increments.
globalThis.pages = async function*(name,args={},options={}) {
  if(typeof name!=='string'||!ALL_TOOLS.some(t=>t.name===name))throw Error("pages/collectPages第一个参数必须是可用工具名，例如 collectPages('read_resource',{kind:'people'})；collectPages直接返回数组，不是{items}");
  if(!args||typeof args!=='object'||Array.isArray(args)||!options||typeof options!=='object'||Array.isArray(options))throw Error('分页参数应为对象');
  let request={...args,pageSize:args.pageSize??40,charBudget:args.charBudget??12000};
  let version,previous; const seen=new Set();
  for(let index=0;index<(options.maxPages??10000);index++) {
    const result=await tools[name](request);if(result.ok===false)throw Error(result.error?.message??'读取失败');
    const page=result.data??result;if(page.pageError)throw Error(page.pageError.message);
    if(page.paged)throw Error('完整结果已外置，请调用pages(page.readTool,page.read)');
    if(!Object.hasOwn(page,'nextCursor'))throw Error('工具未返回标准分页协议，请读取具体字段或采用返回的read定位');
    if(version!==undefined&&version!==page.version)throw Error('资料版本已变化，请重新读取');version=page.version;
    yield page;
    if(page.complete===true&&page.nextCursor==null)return;
    if(typeof page.nextCursor!=='string'||seen.has(page.nextCursor)||page.nextCursor===previous)throw Error('分页游标未前进，已停止重复读取');
    seen.add(page.nextCursor);previous=page.nextCursor;request={...request,nextCursor:page.nextCursor};delete request.offset;delete request.limit;
  }
  throw Error('达到本次分页保护范围，请保存游标后继续');
};
globalThis.collectPages = async (name,args={},options={}) => {const items=[];for await(const page of pages(name,args,options)) {if(page.oversized?.length||page.directoryOnly||!Array.isArray(page.value))throw Error('本页有未返回的超大条目/目录，不能当作完整条目；请按oversized/paths的read读取');items.push(...page.value);}return items;};
globalThis.searchTools = (query,{limit=8}={}) => ALL_TOOLS.filter(t=>(t.name+' '+t.description).toLowerCase().includes(String(query).toLowerCase())).slice(0,Math.min(30,limit));
globalThis.describeTool = name => ALL_TOOLS.find(t=>t.name===name);
globalThis.readModule = path => {if(typeof path!=='string'||path.startsWith('/')||path.includes('..')||path.includes(':'))throw Error('只能读取技能包内资源');const modules=JSON.parse(__modules);if(!Object.hasOwn(modules,path))throw Error('技能资源不存在');return modules[path];};
"#;

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn oversized_support_files_do_not_start_the_interpreter() {
        let host: ScriptHost =
            Arc::new(|_, _, _| Box::pin(async { panic!("oversized package called a tool") }));
        let request = ScriptRequest {
            source: "return 1".into(),
            modules: BTreeMap::from([("reference.js".into(), "a".repeat(MAX_DATA + 1))]),
            ..Default::default()
        };
        assert!(matches!(
            run(request, host, CancellationToken::new()).await,
            Err(Error::Invalid(_))
        ));
    }
    #[tokio::test]
    async fn script_uses_gateway_and_has_no_native_io() {
        let host: ScriptHost = Arc::new(|name, args, key| {
            Box::pin(async move {
                Ok(json!({"name":name,"value":args["n"].as_i64().unwrap()+1,"key":key}))
            })
        });
        let request = ScriptRequest { source: "if(typeof process!=='undefined'||typeof fetch!=='undefined'||typeof require!=='undefined') throw Error('native IO'); if(describeTool('read_resource').parameters.required[0]!=='n') throw Error('missing tool schema'); const values=await Promise.all([tools.read_resource({n:1}),tools.read_resource({n:2})]);store('ids',values.map(x=>x.key));text('done');return values.map(x=>x.value)".into(), step_id:"s".into(), catalog:vec![json!({"name":"read_resource","description":"read","parameters":{"type":"object","properties":{"n":{"type":"integer"}},"required":["n"]}})], ..Default::default() };
        let result = run(request, host, CancellationToken::new()).await.unwrap();
        assert_eq!(result["value"], json!([2, 3]));
        assert_eq!(result["store"]["ids"][0], "s:host:0");
    }
    #[tokio::test]
    async fn stopped_script_cannot_call_gateway() {
        let token = CancellationToken::new();
        token.cancel();
        let host: ScriptHost =
            Arc::new(|_, _, _| Box::pin(async { panic!("stopped script called a tool") }));
        assert!(matches!(
            run(
                ScriptRequest {
                    source: "while(true){}".into(),
                    ..Default::default()
                },
                host,
                token
            )
            .await,
            Err(Error::Cancelled)
        ));
    }
    #[tokio::test]
    async fn running_computation_is_cancelled_without_cancelling_parent_on_success() {
        let parent = CancellationToken::new();
        let host: ScriptHost = Arc::new(|_, _, _| Box::pin(async { Ok(json!(null)) }));
        run(
            ScriptRequest {
                source: "return 1".into(),
                ..Default::default()
            },
            host.clone(),
            parent.clone(),
        )
        .await
        .unwrap();
        assert!(!parent.is_cancelled());
        let stop = parent.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            stop.cancel();
        });
        let start = Instant::now();
        assert!(matches!(
            run(
                ScriptRequest {
                    source: "while(true){}".into(),
                    ..Default::default()
                },
                host,
                parent
            )
            .await,
            Err(Error::Cancelled)
        ));
        assert!(start.elapsed() < Duration::from_secs(2));
    }
    #[tokio::test]
    async fn computation_and_allocation_are_bounded_without_user_stop() {
        let host: ScriptHost = Arc::new(|_, _, _| Box::pin(async { Ok(json!(null)) }));
        let start = Instant::now();
        assert!(run(
            ScriptRequest {
                source: "while(true){}".into(),
                ..Default::default()
            },
            host.clone(),
            CancellationToken::new()
        )
        .await
        .is_err());
        assert!(start.elapsed() < Duration::from_secs(10));
        assert!(run(
            ScriptRequest {
                source: "const a=[];for(;;)a.push(new Array(100000).fill(42))".into(),
                ..Default::default()
            },
            host,
            CancellationToken::new()
        )
        .await
        .is_err());
    }
}

#[cfg(test)]
mod paging_tests {
 use super::*;
 #[tokio::test]async fn helper_uses_real_cursor_and_rejects_stuck_version_or_fake_empty_data(){
  for mode in ["ok","stuck","changed","oversized"] {
   let count=Arc::new(AtomicUsize::new(0));let calls=count.clone();let mode=mode.to_owned();let label=mode.clone();
   let host:ScriptHost=Arc::new(move|_,args,_|{let n=calls.fetch_add(1,Ordering::SeqCst);let mode=mode.clone();Box::pin(async move{if n>0{assert_eq!(args["nextCursor"],"v:1");}Ok(json!({"ok":true,"data":{"version":if mode=="changed"&&n>0{"new"}else{"v"},"value":if mode=="oversized"{json!([])}else{json!([n])},"oversized":if mode=="oversized"{json!([{"path":"/0"}])}else{json!([])},"complete":n>0&&mode!="stuck","nextCursor":if n==0||mode=="stuck"{json!("v:1")}else{Value::Null}}}))})});
   let result=run(ScriptRequest{source:"return await collectPages('read_resource',{});".into(),catalog:vec![json!({"name":"read_resource"})],..Default::default()},host,CancellationToken::new()).await;
   if label=="ok" {assert!(result.is_ok());assert_eq!(count.load(Ordering::SeqCst),2);}else{assert!(result.is_err(),"{label}");assert!(count.load(Ordering::SeqCst)<=2);}
  }
 }
}

#[cfg(test)] mod argument_tests {
 use super::*;
 #[tokio::test] async fn callback_helper_misuse_fails_before_host_call() {
  let host:ScriptHost=Arc::new(|_,_,_|Box::pin(async {panic!("invalid helper reached gateway")}));
  let result=run(ScriptRequest {source:"return await collectPages(cursor=>tools.read_resource({}),{maxPages:5});".into(),..Default::default()},host,CancellationToken::new()).await;
  assert!(result.unwrap_err().to_string().contains("第一个参数"));
 }
}
