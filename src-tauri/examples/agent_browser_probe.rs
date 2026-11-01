//! Isolated desktop host check: no database, application commands or model.
#[cfg(target_os="windows")]
#[path="../src/agent_browser.rs"]
mod agent_browser;

#[cfg(target_os="windows")]
fn main(){
    use serde_json::json;
    use tokio_util::sync::CancellationToken;
    let base=std::env::args().nth(1).expect("local fixture URL required");
    assert!(base.starts_with("http://127.0.0.1:"));
    let mut context=tauri::generate_context!();context.config_mut().app.windows.clear();
    tauri::Builder::default().setup(move|app|{
        let app=app.handle().clone();let base=base.clone();
        tauri::async_runtime::spawn(async move{
            let task="isolated-browser-check";let attempt="attempt-a";
            let result=async{
                let q=json!({"op":"browser_open","url":format!("{base}/start"),"taskId":task,"attemptId":attempt,"operationId":"open"});
                let opened=agent_browser::execute(app.clone(),q,CancellationToken::new()).await?;
                assert!(opened["text"].as_str().unwrap_or("").contains("动态正文已加载"),"dynamic content absent");
                assert!(opened["text"].as_str().unwrap().contains("应用接口不存在"),"application IPC exposed");
                let mut q=json!({"op":"browser_read","browserId":opened["browserId"],"taskId":"foreign-task","attemptId":attempt,"operationId":"foreign"});
                assert!(agent_browser::execute(app.clone(),q.clone(),CancellationToken::new()).await.is_err());
                q["taskId"]=task.into();q["actorId"]="foreign-child".into();
                assert!(agent_browser::execute(app.clone(),q.clone(),CancellationToken::new()).await.is_err(),"another actor cannot read the page");
                q["actorId"]="".into();q["op"]="browser_follow".into();q["operationId"]="follow".into();q["_followUrl"]=format!("{base}/next").into();
                let next=agent_browser::execute(app.clone(),q,CancellationToken::new()).await?;assert!(next["text"].as_str().unwrap_or("").contains("第二页资料"));
                let cancel=CancellationToken::new();let signal=cancel.clone();tauri::async_runtime::spawn(async move{tokio::time::sleep(std::time::Duration::from_millis(300)).await;signal.cancel();});
                let held=agent_browser::execute(app.clone(),json!({"op":"browser_open","url":format!("{base}/held"),"taskId":task,"attemptId":attempt,"operationId":"cancel"}),cancel).await;
                assert!(matches!(held,Err(story_core::Error::Cancelled)));
                agent_browser::execute(app.clone(),json!({"op":"browser_release_task","taskId":task,"attemptId":attempt}),CancellationToken::new()).await?;
                Ok::<_,story_core::Error>(())
            }.await;
            println!("{}",json!({"case":"native-windows-browser","ok":result.is_ok(),"dynamicContent":result.is_ok(),"noTauriIpc":result.is_ok(),"ownerAndAttemptFenced":result.is_ok(),"cancelled":result.is_ok(),"realRequests":0,"error":result.err().map(|e|e.to_string())}));
            app.exit(0);
        });Ok(())
    }).run(context).expect("isolated browser event loop");
}
#[cfg(not(target_os="windows"))]
fn main(){eprintln!("Windows-only browser host check");}
