//! Persistent pinned Pi runtime for the resident development host. This is a
//! second transport adapter for AgentHostService, never another Agent loop.
#[allow(dead_code)]
#[path = "../../pi-model-reference.rs"]
mod model_reference;
#[path = "../../pi-model-http.rs"]
mod model_http;

use pi_host::{NodeLaunch, NodeProcess, TransportOptions};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use story_core::{pi_service::AgentHostService, Store};
use tokio::sync::{oneshot, Mutex, Notify};

struct Running {
    generation: u64,
    service: AgentHostService,
    stop: Option<oneshot::Sender<()>>,
    force: tokio_util::sync::CancellationToken,
    exited: Arc<AtomicBool>,
    retired: Arc<Notify>,
}

pub struct PiAgent {
    store: Store,
    runtime: PathBuf,
    node: Option<PathBuf>,
    data: PathBuf,
    secrets: PathBuf,
    current: Mutex<Option<Running>>,
    generation: AtomicU64,
    closing: AtomicBool,
    changed: Notify,
}

fn unavailable() -> Value {
    json!({"code":"pi_host_unavailable","message":"Pi开发运行环境尚未准备完整；请先准备固定SDK并通过LISHI_PI_NODE指定Node24.19.0的绝对路径，不会自动下载或重跑任务"})
}

impl PiAgent {
    pub fn new(store: Store, root: PathBuf, data: PathBuf, secrets: PathBuf) -> Self {
        Self {
            store,
            runtime: root.join("agent-host/.cache/runtime"),
            node: std::env::var_os("LISHI_PI_NODE").map(PathBuf::from),
            data,
            secrets,
            current: Mutex::new(None),
            generation: AtomicU64::new(0),
            closing: AtomicBool::new(false),
            changed: Notify::new(),
        }
    }

    pub async fn request(self: &Arc<Self>, request: Value) -> Result<Value, Value> {
        if !request.is_object() || self.closing.load(Ordering::Acquire)&&request["op"]!="stop" {
            return Err(unavailable());
        }
        if request["op"]=="resume_route" {return story_core::pi_resume::select_original_route(&self.store,&request).map_err(crate::core_error);}
        if request["op"]=="archive_export" {return story_core::world_archive::export(&self.store,request["worldId"].as_str().unwrap_or("" )).map_err(crate::core_error);}
        if request["op"]=="archive_validate" {return story_core::world_archive::validate_history(&request).map_err(crate::core_error);}
        if request["op"]=="resume_check" {return story_core::pi_resume::check(&self.store,&request).map_err(crate::core_error);}
        if request["op"]=="continue" {story_core::pi_resume::ensure(&self.store,&request).map_err(crate::core_error)?;}
        if request["op"]=="stop_status" {return story_core::pi_service::control_state(&self.store,&request).map_err(crate::core_error);}
        if request["op"]=="stop"{
            let store=self.store.clone();let data=request.clone();let receipt=tokio::task::spawn_blocking(move||story_core::pi_service::persist_stop(&store,&data)).await.map_err(|_|unavailable())?.map_err(crate::core_error)?;
            if receipt["settled"]!=true {
                let owner=self.clone();let stop=request.clone();tokio::spawn(async move{let current=owner.current.lock().await.as_ref().map(|r|r.service.clone());if let Some(service)=current{let _=service.request(stop).await;}});
                let owner=self.clone();tokio::spawn(async move{tokio::time::sleep(Duration::from_secs(15)).await;let store=owner.store.clone();let data=request.clone();if matches!(tokio::task::spawn_blocking(move||story_core::pi_service::timeout_stop(&store,&data)).await,Ok(Ok(Some(_)))){let current=owner.current.lock().await.as_ref().map(|r|r.service.clone());if let Some(service)=current{let _=service.isolate_attempt(request["taskId"].as_str().unwrap_or(""),request["attemptId"].as_str().unwrap_or("")).await;}}});
            }
            return Ok(receipt);
        }
        story_core::maintenance::guard(&*self.store.lock().map_err(crate::core_error)?).map_err(crate::core_error)?;
        let service = self.service().await?;
        service.request(request).await.map_err(crate::core_error)
    }

    async fn service(self: &Arc<Self>) -> Result<AgentHostService, Value> {
        let mut current = self.current.lock().await;
        if self.closing.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        if let Some(running) = current.as_ref().filter(|r|r.service.usable()) {
            return Ok(running.service.clone());
        }
        if let Some(mut old)=current.take(){if let Some(stop)=old.stop.take(){let _=stop.send(());}}
        // Node is supplied by the trusted launcher as process.execPath or by
        // an explicit environment path. Never resolve `node` through PATH.
        let node = self
            .node
            .as_ref()
            .filter(|path| path.is_absolute())
            .cloned()
            .ok_or_else(unavailable)?;
        let check = node.clone();
        tokio::task::spawn_blocking(move || verify_node(&check))
            .await
            .map_err(|_| unavailable())??;
        let working = self.data.join("agent-host");
        let directory = working.clone();
        tokio::task::spawn_blocking(move || std::fs::create_dir_all(directory))
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?;
        if self.closing.load(Ordering::Acquire) {
            return Err(unavailable());
        }
        let (mut process, incoming) = NodeProcess::spawn(NodeLaunch {
            node_executable: node,
            runtime_directory: self.runtime.clone(),
            working_directory: working,
            transport: TransportOptions::default(),
        })
        .await
        .map_err(|_| unavailable())?;
        let store = self.store.clone();
        let secrets = self.secrets.clone();
        let service = match AgentHostService::new(
            self.store.clone(),
            process.connection(),
            incoming,
            self.data.join("agent-sessions"),
            Arc::new(move |reference| {
                model_reference::resolve_profile(&store, reference, |slot, expected| {
                    authorize(&secrets, slot, expected)
                })
            }),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        ) {
            Ok(service) => service,
            Err(_) => {
                let _ = process.shutdown(Duration::from_secs(5)).await;
                return Err(unavailable());
            }
        };
        let network_model = Arc::new(crate::model::DevModel { secrets: self.secrets.clone() });
        service.set_network(Arc::new(move |request,cancel,accounting| {
            network_model.network_counted(request,cancel,accounting)
        })).map_err(crate::core_error)?;
        let model_store=self.store.clone();let model_secrets=self.secrets.clone();let client_store=self.store.clone();
        service.set_model_http(model_http::host(Arc::new(move||{
            let raw:String=client_store.lock()?.query_row("SELECT COALESCE((SELECT value FROM settings WHERE key='network'),'{}')",[],|r|r.get(0))?;
            let config:Value=serde_json::from_str(&raw)?;let builder=reqwest::Client::builder();
            match config["proxy"].as_str().unwrap_or("none"){
                "none"|""=>Ok(builder.no_proxy()),"system"=>Ok(builder),"custom"=>Ok(builder.proxy(reqwest::Proxy::all(config["proxyUrl"].as_str().ok_or_else(||story_core::Error::Invalid("代理配置无效".into()))?).map_err(|_|story_core::Error::Invalid("代理配置无效".into()))?)),_=>Err(story_core::Error::Invalid("代理配置无效".into()))
            }
        }),Arc::new(move|reference|model_reference::resolve_profile(&model_store,reference,|slot,expected|authorize(&model_secrets,slot,expected))))).map_err(crate::core_error)?;
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let (stop, stopped) = oneshot::channel();
        let forced=tokio_util::sync::CancellationToken::new();let exited=Arc::new(AtomicBool::new(false));let retired=Arc::new(Notify::new());
        *current = Some(Running {
            generation,
            service: service.clone(),
            stop: Some(stop),force:forced.clone(),exited:exited.clone(),retired:retired.clone(),
        });
        let weak = Arc::downgrade(self);
        let managed = service.clone();
        let signal = forced.clone();
        service.set_control_timeout(Arc::new(move|_,_|signal.cancel()));
        tokio::spawn(async move {
            tokio::select! {
                _ = process.wait() => {},
                _ = forced.cancelled() => { let _ = process.terminate().await; },
                _ = stopped => {
                    let _ = tokio::time::timeout(Duration::from_secs(2),managed.shutdown()).await;
                    let _ = process.shutdown(Duration::from_secs(5)).await;
                },
            }
            // Unexpected termination must release the task's lease and mark
            // interruption. Nothing here retries model requests or tools.
            let _ = tokio::time::timeout(Duration::from_secs(2),managed.shutdown()).await;
            exited.store(true,Ordering::Release);retired.notify_waiters();
            if let Some(owner) = weak.upgrade() {
                let mut current = owner.current.lock().await;
                if current
                    .as_ref()
                    .is_some_and(|run| run.generation == generation)
                {
                    *current = None;
                }
                owner.changed.notify_waiters();
            }
        });
        Ok(service)
    }

    pub async fn retire(&self)->Result<(),Value>{
        let state=self.current.lock().await.as_ref().map(|r|(r.force.clone(),r.exited.clone(),r.retired.clone()));
        if let Some((force,done,changed))=state{force.cancel();tokio::time::timeout(Duration::from_secs(10),async{loop{let wait=changed.notified();tokio::pin!(wait);wait.as_mut().enable();if done.load(Ordering::Acquire){break;}wait.await;}}).await.map_err(|_|unavailable())?;}
        Ok(())
    }
    pub async fn shutdown(&self) {
        self.closing.store(true, Ordering::Release);
        let stop = self
            .current
            .lock()
            .await
            .as_mut()
            .and_then(|running| running.stop.take());
        if let Some(stop) = stop {
            let _ = stop.send(());
        }
        let wait = async {
            loop {
                let notified = self.changed.notified();
                if self.current.lock().await.is_none() {
                    break;
                }
                notified.await;
            }
        };
        // The owner also has kill_on_drop when the development host exits.
        let _ = tokio::time::timeout(Duration::from_secs(15), wait).await;
    }
}

fn verify_node(node: &Path) -> Result<(), Value> {
    if !node.is_absolute() || !node.is_file() {
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

/// Read the selected JSON only; never mutate the normal development key slot.
fn authorize(file: &Path, slot: &str, expected: &str) -> story_core::Result<String> {
    let invalid =
        || story_core::Error::Invalid("开发模型的密钥或地址绑定不可用，请检查所选服务".into());
    if std::fs::metadata(file).map_err(|_| invalid())?.len() > 1024 * 1024 {
        return Err(invalid());
    }
    let secrets: Value = serde_json::from_slice(&std::fs::read(file).map_err(|_| invalid())?)
        .map_err(|_| invalid())?;
    let entry = &secrets[slot];
    // `expected` is derived from the current native profile, not caller input.
    let bound = entry["boundBaseUrl"].as_str().ok_or_else(invalid)?;
    if bound.trim_end_matches('/') != expected {
        return Err(invalid());
    }
    let key = entry["value"]
        .as_str()
        .filter(|key| {
            !key.is_empty()
                && key.len() <= 4096
                && !key.chars().any(|c| c.is_whitespace() || c.is_control())
        })
        .ok_or_else(invalid)?;
    Ok(key.to_owned())
}
