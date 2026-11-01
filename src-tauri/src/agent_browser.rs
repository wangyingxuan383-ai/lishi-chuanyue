//! A raw Wry view has no Tauri IPC handler, application scripts or credentials.
//! Only fixed extraction code and real snapshot links cross this boundary.
use serde_json::{json,Value};
use story_core::{Error,Result};
use tokio_util::sync::CancellationToken;

#[cfg(target_os="windows")]
mod windows {
    use super::*;
    use std::{any::Any,cell::RefCell,collections::HashMap,sync::{Arc,atomic::{AtomicBool,Ordering}},time::Duration};
    use tauri::{AppHandle,Runtime};
    thread_local!{static PAGES:RefCell<HashMap<String,Box<dyn Any>>>=RefCell::new(HashMap::new());}
    struct Page<R:Runtime>{_window:tauri::Window<R>,view:wry::WebView,task:String,attempt:String,actor:String,operation:String,loaded:Arc<AtomicBool>}
    fn bad()->Error{Error::Invalid("资料网页宿主不可用或页面已关闭，请重新打开；故事任务仍已保存".into())}
    fn allowed(url:&str)->bool{reqwest::Url::parse(url).is_ok_and(|u|matches!(u.scheme(),"http"|"https")&&u.username().is_empty()&&u.password().is_none())}
    async fn main<R:Runtime,T:Send+'static>(app:&AppHandle<R>,f:impl FnOnce()->Result<T>+Send+'static)->Result<T>{
        let(tx,rx)=tokio::sync::oneshot::channel();app.run_on_main_thread(move||{let _=tx.send(f());}).map_err(|_|bad())?;rx.await.map_err(|_|bad())?
    }
    fn owner<R:Runtime>(page:&Page<R>,q:&Value)->bool{page.task==q["taskId"].as_str().unwrap_or("")&&page.attempt==q["attemptId"].as_str().unwrap_or("")&&(q["op"]=="browser_release_task"||page.actor==q["actorId"].as_str().unwrap_or(""))}
    fn remove<R:Runtime>(q:&Value,force:bool){PAGES.with_borrow_mut(|pages|{
        let ids=pages.iter().filter_map(|(id,v)|{let p=v.downcast_ref::<Page<R>>()?;let id_ok=q["browserId"].as_str().is_none_or(|wanted|id==wanted);(owner(p,q)&&id_ok&&(force||p.operation==q["operationId"].as_str().unwrap_or(""))).then(||id.clone())}).collect::<Vec<_>>();
        for id in ids {if let Some(p)=pages.remove(&id){if let Ok(p)=p.downcast::<Page<R>>(){let _=p._window.close();}}}
    });}
    pub(super) async fn execute<R:Runtime>(app:AppHandle<R>,mut q:Value,cancel:CancellationToken)->Result<Value>{
        let op=q["op"].as_str().unwrap_or("").to_owned();
        if ["browser_release_task","browser_close"].contains(&op.as_str()) {let req=q.clone();return main(&app,move||{remove::<R>(&req,true);Ok(json!({"closed":true}))}).await;}
        let id=if op=="browser_open"{uuid::Uuid::new_v4().to_string()}else{q["browserId"].as_str().ok_or_else(bad)?.to_owned()};q["browserId"]=id.clone().into();
        let req=q.clone();let app2=app.clone();let id2=id.clone();
        let loaded=main(&app,move||PAGES.with_borrow_mut(|pages|{
            if req["op"]=="browser_open" {
                if pages.len()>=4{return Err(Error::Invalid("最多同时打开4个资料网页，请先关闭已读页面".into()));}
                let url=req["url"].as_str().unwrap_or("");if !allowed(url){return Err(bad());}
                let window=tauri::window::WindowBuilder::new(&app2,format!("agent-material-{id2}")).visible(false).inner_size(900.0,700.0).build().map_err(|_|bad())?;
                let loaded=Arc::new(AtomicBool::new(false));let marker=loaded.clone();
                let view=wry::WebViewBuilder::new().with_url(url).with_incognito(true).with_devtools(false).with_clipboard(false)
                    .with_navigation_handler(|url|allowed(&url))
                    .with_new_window_req_handler(|_,_|wry::NewWindowResponse::Deny)
                    .with_download_started_handler(|_,_|false)
                    .with_on_page_load_handler(move|event,_|if matches!(event,wry::PageLoadEvent::Finished){marker.store(true,Ordering::Release);})
                    .build_as_child(&window).map_err(|_|bad())?;
                pages.insert(id2.clone(),Box::new(Page{_window:window,view,task:req["taskId"].as_str().unwrap_or("").into(),attempt:req["attemptId"].as_str().unwrap_or("").into(),actor:req["actorId"].as_str().unwrap_or("").into(),operation:String::new(),loaded}));
            }
            let page=pages.get_mut(&id2).and_then(|v|v.downcast_mut::<Page<R>>()).ok_or_else(bad)?;
            if !owner(page,&req){return Err(bad());}if !page.operation.is_empty(){return Err(Error::Invalid("同一资料网页正在读取，请等待上一操作结束".into()));}
            page.operation=req["operationId"].as_str().unwrap_or("").into();
            if req["op"]=="browser_follow" {let url=req["_followUrl"].as_str().unwrap_or("");if !allowed(url){return Err(bad());}page.loaded.store(false,Ordering::Release);page.view.load_url(url).map_err(|_|bad())?;}
            Ok(page.loaded.clone())
        })).await?;
        let read=async {
            while !loaded.load(Ordering::Acquire){tokio::time::sleep(Duration::from_millis(100)).await;}
            if op=="browser_open"||op=="browser_follow"{tokio::time::sleep(Duration::from_millis(500)).await;}
            let(tx,rx)=tokio::sync::oneshot::channel();let sender=Arc::new(std::sync::Mutex::new(Some(tx)));let req=q.clone();let id=id.clone();
            main(&app,move||PAGES.with_borrow(|pages|{
                let page=pages.get(&id).and_then(|v|v.downcast_ref::<Page<R>>()).ok_or_else(bad)?;
                if !owner(page,&req)||page.operation!=req["operationId"].as_str().unwrap_or(""){return Err(bad());}
                page.view.evaluate_script_with_callback(include_str!("../../crates/browser-snapshot.js"),move|raw|{if let Some(tx)=sender.lock().unwrap_or_else(|p|p.into_inner()).take(){let _=tx.send(raw);}}).map_err(|_|bad())?;Ok(())
            })).await?;
            let raw=rx.await.map_err(|_|bad())?;let mut value:Value=serde_json::from_str(&raw).map_err(|_|bad())?;
            if let Some(s)=value.as_str(){value=serde_json::from_str(s).map_err(|_|bad())?;}
            if !allowed(value["url"].as_str().unwrap_or("")){return Err(bad());}value["browserId"]=q["browserId"].clone();Ok(value)
        };
        let result=tokio::select!{biased;_=cancel.cancelled()=>Err(Error::Cancelled),r=tokio::time::timeout(Duration::from_secs(25),read)=>r.unwrap_or_else(|_|Err(Error::Invalid("网页加载或提取超时，可重试原生网页读取或手动打开查看".into())))};
        let req=q.clone();let failed=result.is_err();let _=main(&app,move||{if failed{remove::<R>(&req,false);}else{PAGES.with_borrow_mut(|pages|{if let Some(p)=pages.get_mut(req["browserId"].as_str().unwrap_or("")).and_then(|v|v.downcast_mut::<Page<R>>()){if owner(p,&req)&&p.operation==req["operationId"].as_str().unwrap_or(""){p.operation.clear();}}});}Ok(())}).await;
        result
    }
}

pub async fn execute<R:tauri::Runtime>(app:tauri::AppHandle<R>,request:Value,cancel:CancellationToken)->Result<Value>{
    #[cfg(target_os="windows")]{windows::execute(app,request,cancel).await}
    #[cfg(not(target_os="windows"))]{let _=(app,request,cancel);Err(Error::Invalid("当前平台尚未提供动态网页宿主，可使用原生网页读取".into()))}
}
