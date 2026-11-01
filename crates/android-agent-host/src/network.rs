//! Network adapter for the independent Android service. No Wry or UI handles.
use crate::{android::JavaBridge, credentials::Credentials};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};
use story_core::{pi_service::NetworkHost, Error, Result, Store};

#[path = "../../agent-network.rs"]
mod agent_network;
#[path = "../../pi-model-http.rs"]
mod model_http;

fn invalid() -> Error {
    Error::Invalid("无法初始化联网连接，请检查网络设置".into())
}

fn client(store: &Store, bridge: &JavaBridge) -> Result<reqwest::Client> {
    builder(store,bridge)?.timeout(Duration::from_secs(180)).build().map_err(|_|invalid())
}
fn builder(store:&Store,bridge:&JavaBridge)->Result<reqwest::ClientBuilder> {
    bridge.ensure_tls()?;
    let config: Value = {
        let db = store.lock()?;
        let saved: String = db.query_row(
            "SELECT COALESCE((SELECT value FROM settings WHERE key='network'),'{}')",
            [], |row| row.get(0),
        )?;
        serde_json::from_str(&saved).map_err(|_| invalid())?
    };
    let builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(30));
    let builder = match config["proxy"].as_str().unwrap_or("none") {
        "none" | "" => builder.no_proxy(),
        "system" => builder,
        "custom" => {
            let address = config["proxyUrl"].as_str().ok_or_else(invalid)?;
            let url = reqwest::Url::parse(address).map_err(|_| invalid())?;
            if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h") || url.host_str().is_none() {
                return Err(invalid());
            }
            builder.proxy(reqwest::Proxy::all(address).map_err(|_| invalid())?)
        }
        _ => return Err(invalid()),
    };
    Ok(builder)
}
pub fn model_host(store:Store,data:PathBuf,bridge:Arc<JavaBridge>)->story_core::pi_http::ModelHttpHost {
    let saved=store.clone();let java=bridge.clone();
    model_http::host(Arc::new(move||builder(&saved,&java)),crate::resolver::model_resolver(store,data,bridge))
}

pub fn host(store: Store, data: PathBuf, bridge: Arc<JavaBridge>) -> NetworkHost {
    Arc::new(move |request, cancel,accounting| {
        let store = store.clone();
        let data = data.clone();
        let bridge = bridge.clone();
        Box::pin(async move {
            if request["op"].as_str().unwrap_or("").starts_with("browser_") {
                let worker=bridge.clone();let pending=request.clone();
                return tokio::select!{biased;_=cancel.cancelled()=>{bridge.cancel_browser(&pending);Err(Error::Cancelled)},r=tokio::task::spawn_blocking(move||worker.browser(&request))=>r.map_err(|_|Error::Invalid("安卓网页宿主已中断".into()))?};
            }
            if ["list_documents","read_document","find_document","write_document"].contains(&request["op"].as_str().unwrap_or("")) {
                let worker=bridge.clone();let id=request["operationId"].as_str().unwrap_or("").to_owned();
                let result=tokio::select!{biased;
                    _=cancel.cancelled()=>{bridge.cancel_document(&id);return Err(Error::Cancelled);},
                    result=tokio::task::spawn_blocking(move||{
                        let mut value=worker.document(&request)?;
                        if let Some(path)=value["_documentRead"]["path"].as_str(){
                            use std::io::Read;
                            let mut file=std::fs::File::open(path).map_err(|_|Error::Invalid("资料缓存不可读".into()))?;
                            let mut magic=[0u8;5];let count=file.read(&mut magic).map_err(|_|Error::Invalid("资料缓存读取中断".into()))?;
                            if count==5 && &magic==b"%PDF-"{
                                let bytes=std::fs::read(path).map_err(|_|Error::Invalid("PDF缓存不可读".into()))?;
                                value["_documentRead"]["pdf"]=serde_json::to_value(book_pdf::extract(&bytes).map_err(|message|Error::Invalid(message.into()))?)?;
                            }
                        }
                        Ok::<_,Error>(value)
                    })=>result.map_err(|_|Error::Invalid("安卓资料处理已中断".into()))?,
                };
                return result;
            }
            let client = client(&store, &bridge)?;
            let authorize = Arc::new(move |slot: &str, target: &str| {
                // Re-open on each authorization, including paged MCP calls.
                // UI/model headers and credentials never reach this adapter.
                let credentials = Credentials::open(data.clone(), bridge.clone())
                    .map_err(|_| Error::Invalid("联网能力的密钥未配置或地址与绑定不符".into()))?;
                credentials.authorize(slot, target)
                    .map(|secret| secret.expose_secret().to_owned())
                    .map_err(|_| Error::Invalid("联网能力的密钥未配置或地址与绑定不符".into()))
            });
            agent_network::execute_counted(client, request, authorize, cancel,accounting).await
        })
    })
}
