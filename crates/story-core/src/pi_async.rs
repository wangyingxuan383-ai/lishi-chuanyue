//! Long-running application tools. Pi owns all model scheduling; every nested
//! effect still goes through the same immutable native execution permit.
use crate::{
    agent_script::{self, ScriptHost, ScriptRequest},
    chat::BoxFuture,
    pi_gateway::{StoryToolGateway, TaskPermit},
    pi_store::{BeginCall, PiCallRequest},
    Error, Result,
};
use serde_json::{json, Value};
use rusqlite::OptionalExtension;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio_util::sync::CancellationToken;

pub(crate) fn supports(name: &str) -> bool {
    name == "run_script" || name=="call_tool_package" || name=="draft_tool_package" || network_tool(name)
}
fn network_tool(name: &str) -> bool {
    matches!(
        name,
        "web_search"
            | "list_documents" | "read_document" | "find_document" | "write_document"
            | "read_webpage" | "browser_open" | "browser_read" | "browser_find" | "browser_follow" | "browser_close"
            | "list_remote_tools"
            | "call_remote_tool"
            | "list_mcp_resources"
            | "read_mcp_resource"
    )
}

pub(crate) fn invoke(
    gateway: StoryToolGateway,
    permit: TaskPermit,
    request: PiCallRequest,
    cancel: CancellationToken,
    network: Option<crate::pi_service::NetworkHost>,
    root_cancel: CancellationToken,
) -> BoxFuture<Result<Value>> {
    invoke_scoped(gateway,permit,request,cancel,network,root_cancel,None)
}
pub(crate) fn invoke_scoped(gateway:StoryToolGateway,permit:TaskPermit,request:PiCallRequest,cancel:CancellationToken,network:Option<crate::pi_service::NetworkHost>,root_cancel:CancellationToken,child:Option<crate::pi_children::ChildAuthority>)->BoxFuture<Result<Value>> {
    Box::pin(async move {
        let result=invoke_inner(gateway.clone(),permit.clone(),request,cancel,network,root_cancel.clone(),child).await;
        if let Err(Error::Limit(message))=&result {
            if message.starts_with("本次") {
                let _=gateway.interrupt(&permit,message);
                root_cancel.cancel();
            }
        }
        result
    })
}
fn invoke_inner(
    gateway: StoryToolGateway,
    permit: TaskPermit,
    mut request: PiCallRequest,
    cancel: CancellationToken,
    network: Option<crate::pi_service::NetworkHost>,
    root_cancel: CancellationToken,
    child:Option<crate::pi_children::ChildAuthority>,
) -> BoxFuture<Result<Value>> {
    Box::pin(async move {
        if !supports(&request.tool) {
            let owner = gateway.clone();
            return tokio::task::spawn_blocking(move || match child.as_ref(){Some(child)=>owner.invoke_child(&permit,request,child),None=>owner.invoke(&permit,request)})
                .await
                .map_err(|_| Error::Invalid("本地工具执行已中断".into()))?;
        }
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if request.tool == "call_remote_tool" {
            let task = gateway.0.task(&request.task_id)?;
            let meta=&task["metadata_json"];
            request.external_write = !meta["network"]["mcps"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|s| s["id"] == request.args["serverId"])
                .is_some_and(|s| {
                    s["readOnlyTools"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|n| n == &request.args["name"])
                });
        }
        if request.tool=="write_document" {request.external_write=true;}
        match gateway.begin_async_scoped(&permit, &request,child.as_ref())? {
            BeginCall::Cached(result) => {
                return Ok(crate::pi_tools::delivery(
                    &request.call_id,
                    &request.tool,
                    result,
                ))
            }
            BeginCall::InFlight => {
                return Ok(
                    json!({"ok":false,"error":{"code":"call_in_flight","message":"原脚本尚无终态，不能重跑整段；请读取已完成工具账本并重新规划"}}),
                )
            }
            BeginCall::Unknown => {
                return Ok(
                    json!({"ok":false,"error":{"code":"outcome_unknown","message":"操作结果未知，不能自动重放"}}),
                )
            }
            BeginCall::Execute => {}
        }
        let dispatched = Arc::new(AtomicBool::new(false));
        let outcome = execute(
            &gateway,
            &permit,
            &request,
            cancel,
            network,
            dispatched.clone(),
            root_cancel.clone(),
            child.as_ref(),
        )
        .await;
        if let Err(Error::Limit(message))=&outcome {if message.starts_with("本次"){let _=gateway.interrupt(&permit,message);root_cancel.cancel();}}
        let result = match outcome {
            Ok(value) if value["isError"] == true || value["result"]["isError"] == true => {
                json!({"ok":false,"outcomeUnknown":value["outcomeUnknown"]==true,"error":{"code":value["error"]["code"].as_str().unwrap_or("remote_tool_error"),"message":value["error"]["message"].as_str().unwrap_or("工具报告业务失败"),"details":value}})
            }
            Ok(value) => json!({"ok":true,"data":value}),
            Err(error) => {
                let detail=match &error {Error::Tool{code,field,message,next}=>json!({"code":code,"field":field,"message":message,"next":next}),_=>json!({"code":match error{Error::Cancelled=>"cancelled",Error::Stale=>"stale",_=>"tool_failed"},"message":error.to_string()})};
                json!({"ok":false,"outcomeUnknown":request.external_write&&dispatched.load(Ordering::Acquire),"error":detail})
            }
        };
        gateway.0.finish_call(&request, &result)?;
        Ok(crate::pi_tools::delivery(
            &request.call_id,
            &request.tool,
            result,
        ))
    })
}

async fn execute(
    gateway: &StoryToolGateway,
    permit: &TaskPermit,
    request: &PiCallRequest,
    cancel: CancellationToken,
    network: Option<crate::pi_service::NetworkHost>,
    dispatched: Arc<AtomicBool>,
    root_cancel: CancellationToken,
    child:Option<&crate::pi_children::ChildAuthority>,
) -> Result<Value> {
    let (plan, task) = gateway.async_context_scoped(permit, request,child)?;
    crate::agent_policy::check(&plan, &request.tool, &request.args)?;
    if request.tool=="draft_tool_package"{
        let package=crate::pi_toolpkg::prepare_draft(&request.args,cancel).await?;
        return gateway.save_tool_package(permit,request,&package);
    }
    if network_tool(&request.tool) {
        let document=matches!(request.tool.as_str(),"list_documents"|"read_document"|"find_document"|"write_document");
        if document&&request.tool=="list_documents"&&request.args["grantId"].as_str().unwrap_or("").is_empty(){
            let meta:Value=serde_json::from_str(task["metadata_json"].as_str().unwrap_or("{}"))?;
            return Ok(json!({"grants":meta["fileGrants"],"message":"仅这些资料范围已在本任务中授权；原生路径和URI不会提供给模型。"}));
        }
        if !document && plan.meta["agent"]["network"]["mode"] == "off" {
            return Err(Error::Invalid("本任务已关闭联网".into()));
        }
        let network = network.ok_or_else(|| Error::Invalid("当前宿主尚未接通联网能力".into()))?;
        let mut args = request.args.clone();
        if document {args=crate::pi_documents::request(&*gateway.0.0.lock()?,&task,&plan,&args,request.tool=="write_document")?;}
        if request.tool.starts_with("browser_"){args=crate::pi_browser::request(&*gateway.0.0.lock()?,&task,&permit.attempt_id(),child.map(|c|c.id.as_str()).unwrap_or(""),&request.tool,&args)?;}
        args["op"] = request.tool.clone().into();
        args["operationId"]=format!("{}-{}",request.task_id,crate::pi_store::arguments_hash(&json!([request.call_id,permit.attempt_id()]))).into();
        args["network"] = crate::pi_capabilities::effective_network(&*gateway.0.0.lock()?,&crate::pi_network::bind_model(&plan.meta["agent"]["network"],&task["model_json"]),plan.meta["agent"]["readOnly"]==true)?;
        let document_args=if document{Some(args.clone())}else{None};
        let browser_args=if request.tool.starts_with("browser_"){Some(args.clone())}else{None};
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        dispatched.store(true, Ordering::Release);
        let config=&args["network"];
        let accounting=(request.tool=="web_search"&&["auto","native"].contains(&config["mode"].as_str().unwrap_or(""))&&config["native"]["enabled"]==true&&["openai-responses","gemini","anthropic"].contains(&config["native"]["protocol"].as_str().unwrap_or("")))
            .then(||crate::pi_accounting::NativeModelAccounting::search_scoped(gateway.clone(),permit.clone(),&request.call_id,&config["native"],child.cloned()));
        let result=network(args,cancel,accounting.clone()).await;
        if result.as_ref().is_ok_and(|value|value["modelRequests"]==1)&&accounting.as_ref().is_none_or(|a|!a.admitted()||!a.finished()) {
            return Err(Error::Invalid("原生搜索没有确认模型调用与用量，结果未冒充已完成".into()));
        }
        let mut value=result?;
        if let Some(args)=document_args {crate::pi_documents::request(&*gateway.0.0.lock()?,&task,&plan,&args,request.tool=="write_document")?;crate::pi_documents::project(&task,&args,&mut value);}
        if let Some(args)=browser_args {crate::pi_browser::project(&request.tool,&args,&mut value)?;}
        gateway.capture_external(permit,request,&mut value)?;
        return Ok(value);
    }
    let owner = gateway.clone();
    let ticket = permit.clone();
    let parent = request.clone();
    let token = cancel.clone();
    let host: ScriptHost = Arc::new(move |name, args, key| {
        let owner = owner.clone();
        let ticket = ticket.clone();
        let token = token.clone();
        let parent = parent.clone();
        let network = network.clone();
        let root_cancel = root_cancel.clone();
        Box::pin(async move {
            if ["run_script", "call_tool_package", "finish_task", "delegate_readonly", "ask_user"].contains(&name.as_str()) {
                return Err(Error::Invalid(
                    "脚本不能继续派生执行器、提交整个任务或代替主助手提问".into(),
                ));
            }
            if parent.tool=="call_tool_package" {
                let (_,task)=owner.async_context_scoped(&ticket,&parent,None)?;
                crate::pi_toolpkg::execution(&*owner.0.0.lock()?,&task,&parent.args)?;
            }
            let result_owner=owner.clone();let task_id=parent.task_id.clone();let call_id=key.clone();
            let display=invoke(
                owner,
                ticket,
                PiCallRequest {
                    task_id: parent.task_id,
                    call_id: key,
                    tool: name,
                    args,
                    intent_revision: parent.intent_revision,
                    world_version: parent.world_version,
                    external_write: false,
                },
                token,
                network,
                root_cancel,
            )
            .await?;
            // A script consumes protocol data, never the model display view.
            let db=result_owner.0.0.lock()?;
            let raw:Option<String>=db.query_row("SELECT output_json FROM pi_calls WHERE task_id=? AND call_id=? AND status='done'",rusqlite::params![task_id,call_id],|r|r.get(0)).optional()?;
            Ok(crate::pi_tools::script_delivery(&call_id,raw.map(|s|crate::agent_workspace::parse(&s)).unwrap_or(display)))
        })
    });
    let metadata: Value = serde_json::from_str(task["metadata_json"].as_str().unwrap_or("{}"))?;
    let mut script = if request.tool=="call_tool_package" {
        crate::pi_toolpkg::execution(&*gateway.0.0.lock()?,&task,&request.args)?
    } else {ScriptRequest {
        source: request.args["source"].as_str().unwrap_or("").into(),
        input: request.args["input"].clone(),
        modules: serde_json::from_value(request.args.get("modules").cloned().unwrap_or(json!({})))
            .map_err(|_| Error::Invalid("脚本模块应为名称到源码的映射".into()))?,
        store: metadata["scriptStore"].clone(),
        catalog: gateway.definitions(),
        step_id: request.call_id.clone(),
    }};
    script.step_id=request.call_id.clone();script.catalog=gateway.definitions();script.store=metadata["scriptStore"].clone();
    let result = agent_script::run(script, host, cancel).await?;
    gateway.save_script_store(permit, request, &result["store"])?;
    if request.tool=="call_tool_package" {
        let raw=result["output"].as_array().and_then(|rows|rows.last()).and_then(Value::as_str).ok_or_else(||Error::Invalid("工具包没有返回可读取的结果".into()))?;
        let mut value:Value=serde_json::from_str(raw)?;
        if value["success"]==false || value["result"]["success"]==false {value["isError"]=true.into();if !value["error"].is_object(){value["error"]=json!({"code":"toolpkg_business_failed","message":value["result"]["error"]["message"].as_str().or_else(||value["result"]["message"].as_str()).unwrap_or("工具包未完成所请求操作")});}}
        return Ok(value);
    }
    Ok(result)
}
