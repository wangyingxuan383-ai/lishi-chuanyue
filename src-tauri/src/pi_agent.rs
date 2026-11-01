//! Native facade for the pinned Pi host. Ordinary story execution stays in
//! `execution`; this adapter never reconstructs model context or resumes a run.
use serde_json::{json, Value};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(not(target_os = "android"))]
#[path = "../../crates/pi-model-reference.rs"]
mod model_reference;
#[cfg(not(target_os = "android"))]
#[path = "../../crates/pi-model-http.rs"]
mod model_http;

#[cfg(target_os = "android")]
struct AndroidAgent<R: Runtime>(tauri::plugin::PluginHandle<R>);

struct ControlStore(story_core::Store);

fn unavailable() -> Value {
    json!({"code":"agent_host_unavailable","message":"助手运行环境不可用，请检查安装包是否完整；已保存的任务不会自动重跑"})
}

fn core_error(error: story_core::Error) -> Value {
    let code = match &error {
        story_core::Error::Stale => "agent_stale",
        story_core::Error::Cancelled => "agent_cancelled",
        story_core::Error::Limit(_) => "agent_limit",
        _ => "agent_request_failed",
    };
    json!({"code":code,"message":error.to_string()})
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("agent-host")
        // Only the typed application command below may call this native
        // plugin. Do not expose a second frontend mobile-plugin route.
        .invoke_handler(|invoke| {
            invoke.resolver.reject("agent_host_internal");
            true
        })
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(AndroidAgent(api.register_android_plugin(
                "io.timejump.chuanyue",
                "AgentHostPlugin",
            )?));
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

/// Registers paths and shared native services only. Node is started lazily,
/// outside the UI process on Android and as a hidden desktop child elsewhere.
pub fn initialize<R: Runtime>(
    app: &tauri::AppHandle<R>,
    store: story_core::Store,
) -> Result<(), Box<dyn std::error::Error>> {
    story_core::pi_store::PiStore(store.clone()).initialize()?;
    app.manage(ControlStore(store.clone()));
    #[cfg(not(target_os = "android"))]
    {
        use std::sync::Arc;
        let secrets = Arc::clone(&app.state::<crate::secret::PlatformSecrets>().0);
        app.manage(DesktopAgent(Arc::new(desktop::Host::new(
            app.clone(),
            store,
            app.path().app_data_dir()?,
            app.path().resource_dir()?.join("agent"),
            secrets,
        ))));
    }
    #[cfg(target_os = "android")]
    let _ = (app, store);
    Ok(())
}

#[tauri::command]
pub async fn pi_agent_request<R: Runtime>(
    app: tauri::AppHandle<R>,
    request: Value,
) -> Result<Value, Value> {
    if !request.is_object() {
        return Err(json!({"code":"agent_invalid_request","message":"助手请求格式不完整"}));
    }
    if request["op"]=="resume_route" {return story_core::pi_resume::select_original_route(&app.state::<ControlStore>().0,&request).map_err(core_error);}
    if request["op"]=="archive_export" || request["op"]=="archive_validate" {
        let store=app.state::<ControlStore>().0.clone();
        return tauri::async_runtime::spawn_blocking(move||if request["op"]=="archive_export"{story_core::world_archive::export(&store,request["worldId"].as_str().unwrap_or(""))}else{story_core::world_archive::validate_history(&request)}).await.map_err(|_|unavailable())?.map_err(core_error);
    }
    if request["op"]=="resume_check" || request["op"]=="continue" {
        let store=app.state::<ControlStore>().0.clone();let query=request.clone();
        let check=tauri::async_runtime::spawn_blocking(move||story_core::pi_resume::check(&store,&query)).await.map_err(|_|unavailable())?.map_err(core_error)?;
        if request["op"]=="resume_check" {return Ok(check);}
        if check["canContinue"]!=true {return Err(json!({"code":check["reasonCode"],"message":check["message"],"next":check}));}
    }
    if request["op"]=="stop_status" {
        let store=app.state::<ControlStore>().0.clone();return tauri::async_runtime::spawn_blocking(move||story_core::pi_service::control_state(&store,&request)).await.map_err(|_|unavailable())?.map_err(core_error);
    }
    if request["op"]=="stop" {
        let store=app.state::<ControlStore>().0.clone();let data=request.clone();let saved=store.clone();
        let receipt=tauri::async_runtime::spawn_blocking(move||story_core::pi_service::persist_stop(&saved,&data)).await.map_err(|_|unavailable())?.map_err(core_error)?;
        if receipt["settled"]!=true {
            let cancel_app=app.clone();let cancel=request.clone();
            tauri::async_runtime::spawn(async move{
                #[cfg(target_os="android")]
                {let _=cancel_app.state::<AndroidAgent<R>>().0.run_mobile_plugin_async::<Value>("cancelExisting",json!({"request":cancel})).await;}
                #[cfg(not(target_os="android"))]
                {cancel_app.state::<DesktopAgent<R>>().0.cancel_existing(cancel,false).await;}
            });
            let isolate_app=app.clone();let expected=request.clone();
            tauri::async_runtime::spawn(async move{
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                let data=expected.clone();let should=tauri::async_runtime::spawn_blocking(move||story_core::pi_service::timeout_stop(&store,&data)).await;
                if matches!(should,Ok(Ok(Some(_)))) {
                    #[cfg(target_os="android")]
                    {let mut force=expected;force["op"]="force_stop_attempt".into();let _=isolate_app.state::<AndroidAgent<R>>().0.run_mobile_plugin_async::<Value>("cancelExisting",json!({"request":force})).await;}
                    #[cfg(not(target_os="android"))]
                    {isolate_app.state::<DesktopAgent<R>>().0.cancel_existing(expected,true).await;}
                }
            });
        }
        return Ok(receipt);
    }
    story_core::maintenance::guard(&*app.state::<ControlStore>().0.lock().map_err(core_error)?).map_err(core_error)?;
    #[cfg(target_os = "android")]
    {
        let store=app.state::<ControlStore>().0.clone();
        let before=if request["op"]=="continue" {story_core::pi_store::PiStore(store.clone()).task(request["taskId"].as_str().unwrap_or("")).ok().map(|t|t["lease_json"].clone())}else{None};
        let result=android_request(&app,&request).await;
        let reconnect=result.as_ref().err().is_some_and(|error|["host_unavailable","host_draining","agent_host_unavailable"].contains(&error["code"].as_str().unwrap_or("")));
        if reconnect {
            if let Some(before)=before {
                let unchanged=story_core::pi_store::PiStore(store.clone()).task(request["taskId"].as_str().unwrap_or("")).is_ok_and(|t|t["lease_json"]==before);
                // Retry only the explicit continue's bootstrap, after proving
                // no new attempt/model/tool began. Never replay an unknown run.
                if unchanged && story_core::pi_resume::ensure(&store,&request).is_ok() {
                    retire(&app).await?;
                    return android_request(&app,&request).await;
                }
            }
        }
        result
    }
    #[cfg(not(target_os = "android"))]
    {
        let host = app.state::<DesktopAgent<R>>().0.clone();
        let (reply, wait) = tokio::sync::oneshot::channel();
        // Detaching the UI waiter must not kill bootstrap, interrupt a task,
        // or make a command safe to repeat. The native owner survives it.
        tauri::async_runtime::spawn(async move {
            let result = host.request(request).await;
            let _ = reply.send(result);
        });
        wait.await.map_err(|_| unavailable())?
    }
}

#[cfg(target_os="android")]
async fn android_request<R:Runtime>(app:&tauri::AppHandle<R>,request:&Value)->Result<Value,Value>{
    #[derive(serde::Deserialize)] struct Reply {json:String}
    let reply:Reply=app.state::<AndroidAgent<R>>().0.run_mobile_plugin_async("request",json!({"request":request})).await.map_err(|_|unavailable())?;
    let mut response:Value=serde_json::from_str(&reply.json).map_err(|_|unavailable())?;
    match response["ok"].as_bool(){Some(true)=>Ok(response["data"].take()),Some(false)if response["error"].is_object()=>Err(response["error"].take()),_=>Err(unavailable())}
}

pub async fn retire<R:Runtime>(app:&tauri::AppHandle<R>)->Result<(),Value>{
    #[cfg(target_os="android")]{let _:Value=app.state::<AndroidAgent<R>>().0.run_mobile_plugin_async("cancelExisting",json!({"request":{"op":"retire_host"}})).await.map_err(|_|unavailable())?;}
    #[cfg(not(target_os="android"))]{app.state::<DesktopAgent<R>>().0.retire().await?;}
    Ok(())
}

#[cfg(not(target_os = "android"))]
struct DesktopAgent<R: Runtime>(std::sync::Arc<desktop::Host<R>>);

#[cfg(not(target_os = "android"))]
mod desktop {
    use super::*;
    use pi_host::{NodeLaunch, NodeProcess, TransportOptions};
    use std::{
        path::{Path, PathBuf},
        sync::Arc,
        time::Duration,
    };
    use story_core::pi_service::AgentHostService;

    struct Running {
        id: uuid::Uuid,
        service: AgentHostService,
        force: tokio_util::sync::CancellationToken,
        exited: Arc<std::sync::atomic::AtomicBool>,
        changed: Arc<tokio::sync::Notify>,
    }
    pub(super) struct Host<R: Runtime> {
        app: tauri::AppHandle<R>,
        store: story_core::Store,
        data: PathBuf,
        resources: PathBuf,
        secrets: Arc<dyn crate::secrets::SecretStore>,
        current: tokio::sync::Mutex<Option<Running>>,
    }

    impl<R: Runtime> Host<R> {
        pub(super) fn new(
            app: tauri::AppHandle<R>,
            store: story_core::Store,
            data: PathBuf,
            resources: PathBuf,
            secrets: Arc<dyn crate::secrets::SecretStore>,
        ) -> Self {
            Self {
                app,
                store,
                data,
                resources,
                secrets,
                current: tokio::sync::Mutex::new(None),
            }
        }

        pub(super) async fn request(self: Arc<Self>, request: Value) -> Result<Value, Value> {
            let service = self.service().await?;
            service.request(request).await.map_err(core_error)
        }

        pub(super) async fn cancel_existing(&self,request:Value,isolate:bool){
            let service=self.current.lock().await.as_ref().map(|r|r.service.clone());
            if let Some(service)=service {if isolate{let _=service.isolate_attempt(request["taskId"].as_str().unwrap_or(""),request["attemptId"].as_str().unwrap_or("")).await;}else{let _=service.request(request).await;}}
        }
        pub(super) async fn retire(&self)->Result<(),Value>{
            let state=self.current.lock().await.as_ref().map(|r|(r.force.clone(),r.exited.clone(),r.changed.clone()));
            if let Some((force,done,changed))=state {force.cancel();tokio::time::timeout(Duration::from_secs(10),async{loop{let wait=changed.notified();tokio::pin!(wait);wait.as_mut().enable();if done.load(std::sync::atomic::Ordering::Acquire){break;}wait.await;}}).await.map_err(|_|unavailable())?;}
            Ok(())
        }
        async fn service(self: &Arc<Self>) -> Result<AgentHostService, Value> {
            let mut current = self.current.lock().await;
            if let Some(running) = current.as_ref().filter(|r|r.service.usable()) {
                return Ok(running.service.clone());
            }
            if let Some(old)=current.take(){old.force.cancel();}
            let runtime = self.resources.join("runtime");
            let node =
                self.resources
                    .join("node")
                    .join(if cfg!(windows) { "node.exe" } else { "node" });
            let checked = node.clone();
            tauri::async_runtime::spawn_blocking(move || verify_node(&checked))
                .await
                .map_err(|_| unavailable())??;
            let working = self.data.join("agent-host");
            let directory = working.clone();
            tauri::async_runtime::spawn_blocking(move || std::fs::create_dir_all(directory))
                .await
                .map_err(|_| unavailable())?
                .map_err(|_| unavailable())?;
            let (mut process, incoming) = NodeProcess::spawn(NodeLaunch {
                node_executable: node,
                runtime_directory: runtime,
                working_directory: working,
                transport: TransportOptions::default(),
            })
            .await
            .map_err(|_| unavailable())?;
            let app = self.app.clone();
            let service = match AgentHostService::new(
                self.store.clone(),
                process.connection(),
                incoming,
                self.data.join("agent-sessions"),
                model_resolver(self.store.clone(), self.data.clone(), self.secrets.clone()),
                Arc::new(|_| {}),
                Arc::new(move |world| {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::notifications::story_committed(app, world).await;
                    });
                }),
            ) {
                Ok(service) => service,
                Err(_) => {
                    let _ = process.shutdown(Duration::from_secs(5)).await;
                    return Err(unavailable());
                }
            };
            let network_data = self.data.clone();
            let network_secrets = self.secrets.clone();
            let network_app=self.app.clone();
            let network_streams = self.app.state::<Arc<crate::stream::Streams>>().inner().clone();
            service.set_network(Arc::new(move |request,cancel,accounting| {
                let data=network_data.clone();
                let secrets=network_secrets.clone();
                let streams=network_streams.clone();
                let app=network_app.clone();
                Box::pin(async move {
                    if request["op"].as_str().unwrap_or("").starts_with("browser_"){return crate::agent_browser::execute(app,request,cancel).await;}
                    if ["list_documents","read_document","find_document","write_document"].contains(&request["op"].as_str().unwrap_or("")) {
                        return crate::execution::NativeModel::document(request,data,cancel).await;
                    }
                    let credentials=Arc::new(crate::credentials::Credentials::open(data,secrets)
                        .map_err(|_|story_core::Error::Invalid("联网能力的密钥未配置或地址与绑定不符".into()))?);
                    let model=crate::execution::NativeModel { credentials,streams };
                    model.network_counted(request,cancel,accounting).await
                })
            })).map_err(core_error)?;
            service.set_model_http(super::model_http::host(Arc::new(||crate::stream::client_builder().map_err(|_|story_core::Error::Invalid("无法初始化模型网络连接".into()))),model_resolver(self.store.clone(),self.data.clone(),self.secrets.clone()))).map_err(core_error)?;
            let id = uuid::Uuid::new_v4();
            let forced = tokio_util::sync::CancellationToken::new();
            let exited=Arc::new(std::sync::atomic::AtomicBool::new(false));let changed=Arc::new(tokio::sync::Notify::new());
            *current = Some(Running {
                id,
                service: service.clone(),force:forced.clone(),exited:exited.clone(),changed:changed.clone(),
            });
            let weak = Arc::downgrade(self);
            let managed = service.clone();
            let signal = forced.clone();
            service.set_control_timeout(Arc::new(move|_,_|signal.cancel()));
            tauri::async_runtime::spawn(async move {
                // The process owner outlives pages and request waiters. An
                // unexpected exit interrupts its active native lease before
                // a later explicit request may start a fresh runtime.
                tokio::select! { _ = process.wait() => {}, _ = forced.cancelled() => { let _ = process.terminate().await; } }
                let _ = tokio::time::timeout(Duration::from_secs(2),managed.shutdown()).await;
                exited.store(true,std::sync::atomic::Ordering::Release);changed.notify_waiters();
                if let Some(host) = weak.upgrade() {
                    let mut current = host.current.lock().await;
                    if current.as_ref().is_some_and(|running| running.id == id) {
                        *current = None;
                    }
                }
            });
            Ok(service)
        }
    }

    fn verify_node(node: &Path) -> Result<(), Value> {
        // Only the app-owned resource path is accepted. A shell PATH lookup,
        // caller-supplied executable and NODE_OPTIONS are never involved.
        if !node.is_file()
            || std::fs::symlink_metadata(node)
                .map_err(|_| unavailable())?
                .file_type()
                .is_symlink()
        {
            return Err(unavailable());
        }
        let mut command = std::process::Command::new(node);
        command.arg("--version").env_clear();
        for name in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
            "LC_ALL",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let result = command.output().map_err(|_| unavailable())?;
        if !result.status.success()
            || result.stdout != b"v24.19.0\n" && result.stdout != b"v24.19.0\r\n"
        {
            return Err(unavailable());
        }
        Ok(())
    }

    fn model_resolver(
        store: story_core::Store,
        data: PathBuf,
        secrets: Arc<dyn crate::secrets::SecretStore>,
    ) -> story_core::pi_service::ModelResolver {
        Arc::new(move |reference| resolve_model(&store, &data, secrets.clone(), reference))
    }

    fn resolve_model(
        store: &story_core::Store,
        data: &Path,
        secrets: Arc<dyn crate::secrets::SecretStore>,
        reference: &Value,
    ) -> story_core::Result<Value> {
        model_reference::resolve(store, data, reference, |slot, bound| {
            let invalid =
                || story_core::Error::Invalid("模型配置或凭据绑定不可用，请检查所选服务".into());
            // The main Credentials state caches bindings for its normal
            // execution path. The Agent obtains a fresh snapshot per task.
            let current = crate::credentials::Credentials::open(data.to_owned(), secrets)
                .map_err(|_| invalid())?;
            current
                .authorize(slot, bound)
                .map(|value| value.expose_secret().to_owned())
                .map_err(|_| invalid())
        })
    }
}
