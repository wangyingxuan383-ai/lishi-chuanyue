use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use story_core::{
    chat::{BoxFuture, Completion, Model, TextSink},
    Error, ModelConfig, Result,
};
use tokio_util::sync::CancellationToken;
#[path = "../../agent-model.rs"]
mod agent_model;
#[path = "../../agent-network.rs"]
mod agent_network;
#[path = "../../agent-documents.rs"]
mod agent_documents;

pub struct DevModel {
    pub secrets: PathBuf,
}

impl DevModel {
    pub fn network_counted(&self, request: Value, cancel: CancellationToken,accounting:Option<story_core::pi_accounting::NativeModelAccounting>) -> BoxFuture<Result<Value>> {
        let file = self.secrets.clone();
        Box::pin(async move {
            if request["op"].as_str().unwrap_or("").starts_with("browser_"){return Err(Error::Invalid("浏览器开发宿主未提供隔离动态页面；请用原生APP或HTTP网页读取".into()));}
            if ["list_documents","read_document","find_document","write_document"].contains(&request["op"].as_str().unwrap_or("")) {
                let data=file.parent().unwrap_or(std::path::Path::new(".")).join("dev-host");
                return tokio::task::spawn_blocking(move||agent_documents::execute(request,data,cancel)).await.map_err(|_|Error::Invalid("资料处理已中断".into()))?;
            }
            let secrets: Value = serde_json::from_slice(
                &tokio::fs::read(file)
                    .await
                    .map_err(|_| Error::Invalid("尚未配置联网能力".into()))?,
            )?;
            let authorize = std::sync::Arc::new(move |slot: &str, target: &str| {
                let entry = &secrets[slot];
                let bound = entry["boundBaseUrl"].as_str().unwrap_or("");
                let allowed = !bound.is_empty()
                    && target.strip_prefix(bound).is_some_and(|tail| {
                        tail.is_empty() || tail.starts_with('/') || tail.starts_with('?')
                    })
                    && reqwest::Url::parse(bound)
                        .ok()
                        .zip(reqwest::Url::parse(target).ok())
                        .is_some_and(|(base, url)| {
                            base.origin() == url.origin()
                                && url.username().is_empty()
                                && url.password().is_none()
                        });
                if !allowed {
                    return Err(Error::Invalid("联网能力的密钥地址与绑定不符".into()));
                }
                entry["value"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| Error::Invalid("尚未配置联网能力的密钥".into()))
            });
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(30))
                .timeout(Duration::from_secs(180))
                .build()
                .map_err(|_| Error::Invalid("无法初始化联网连接".into()))?;
            agent_network::execute_counted(client, request, authorize, cancel,accounting).await
        })
    }
}
impl Model for DevModel {
    fn network(&self,request:Value,cancel:CancellationToken)->BoxFuture<Result<Value>> {self.network_counted(request,cancel,None)}

    fn complete(
        &self,
        config: ModelConfig,
        body: Value,
        cancel: CancellationToken,
        text: TextSink,
    ) -> BoxFuture<Result<Completion>> {
        let file = self.secrets.clone();
        Box::pin(async move {
            let secrets: Value = serde_json::from_slice(
                &tokio::fs::read(file)
                    .await
                    .map_err(|_| Error::Invalid("尚未配置 AI 服务".into()))?,
            )?;
            let entry = &secrets[&config.slot];
            let key = entry["value"]
                .as_str()
                .ok_or_else(|| Error::Invalid("尚未配置 AI 服务".into()))?;
            let bound = entry["boundBaseUrl"].as_str().unwrap_or("");
            if bound.is_empty()
                || !config.url.starts_with(bound)
                || !matches!(
                    config.url.as_bytes().get(bound.len()),
                    None | Some(b'/') | Some(b'?')
                )
            {
                return Err(Error::Invalid("请求地址与密钥绑定地址不符".into()));
            }
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .connect_timeout(Duration::from_secs(30))
                .timeout(Duration::from_secs(180))
                .build()
                .map_err(|_| Error::Invalid("无法初始化模型连接".into()))?;
            agent_model::complete(client, config, body, key.to_owned(), cancel, text).await
        })
    }
}
