//! A private model transport, separate from the model-facing network tools.
//! Pi keeps its provider payloads and streaming parser; native hosts own TLS,
//! proxies and credentials. Only short control replies cross this interface.
use crate::{
    chat::BoxFuture,
    pi_gateway::{StoryToolGateway, TaskPermit},
    pi_store::arguments_hash,
    Error, Result,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio_util::sync::CancellationToken;

pub const MAX_MODEL_CHUNK: usize = 64 * 1024;
pub trait ModelHttpBody: Send + Sync {
    fn next(&self, cancel: CancellationToken) -> BoxFuture<Result<Option<Vec<u8>>>>;
}
pub struct ModelHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Arc<dyn ModelHttpBody>,
}
/// Called by the platform immediately before the actual HTTP send, after its
/// local endpoint/credential checks. Repeated admission never permits a replay.
pub type ModelAdmission = Arc<dyn Fn() -> Result<Value> + Send + Sync>;
pub type ModelHttpHost = Arc<
    dyn Fn(Value, Value, CancellationToken, ModelAdmission) -> BoxFuture<Result<ModelHttpResponse>>
        + Send
        + Sync,
>;

struct Stream {
    cancel: CancellationToken,
    response: Mutex<Option<Arc<ModelHttpResponse>>>,
    reading: Arc<tokio::sync::Semaphore>,
}
impl Drop for Stream {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
struct State {
    gateway: StoryToolGateway,
    permit: TaskPermit,
    config: Value,
    host: ModelHttpHost,
    cancel: CancellationToken,
    streams: Mutex<HashMap<String, Arc<Stream>>>,
    child:Option<crate::pi_children::ChildAuthority>,
}
#[derive(Clone)]
pub(crate) struct ModelHttpController(Arc<State>);
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn request_id(args: &Value) -> Result<&str> {
    args["requestId"]
        .as_str()
        .filter(|id| {
            id.starts_with("model-")
                && id.len() <= 128
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        .ok_or_else(|| invalid("模型传输标识无效"))
}

impl ModelHttpController {
    pub(crate) fn new(
        gateway: StoryToolGateway,
        permit: TaskPermit,
        model: Value,
        reference: Value,
        host: ModelHttpHost,
        cancel: CancellationToken,
    ) -> Self {
        Self(Arc::new(State {
            gateway,
            permit,
            config: json!({"resolved":model,"reference":reference}),
            host,
            cancel,
            streams: Mutex::new(HashMap::new()),
            child:None,
        }))
    }
    pub(crate) fn child(&self,child:crate::pi_children::ChildAuthority,cancel:CancellationToken)->Self {
        Self(Arc::new(State{gateway:self.0.gateway.clone(),permit:self.0.permit.clone(),config:self.0.config.clone(),host:self.0.host.clone(),cancel,streams:Mutex::new(HashMap::new()),child:Some(child)}))
    }
    pub(crate) async fn invoke(
        &self,
        action: &str,
        args: &Value,
        rpc_cancel: CancellationToken,
    ) -> Result<Value> {
        let id = request_id(args)?.to_owned();
        match action {
            "start" => self.start(&id, args, rpc_cancel).await,
            "read" => self.read(&id, rpc_cancel).await,
            "cancel" => self.cancel(&id, args["reason"] == "consumer"),
            "usage" => {
                let task = &self.0.permit.task_id;
                let status: Option<String> = self
                    .0
                    .gateway
                    .0
                     .0
                    .lock()?
                    .query_row(
                        "SELECT status FROM pi_model_requests WHERE task_id=? AND request_id=?",
                        rusqlite::params![task, id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if status.as_deref() == Some("unknown") {
                    return self.0.gateway.model_budget(&self.0.permit);
                }
                self.0.gateway.finish_model_context(
                    &self.0.permit,
                    &id,
                    &args["usage"],
                    args["status"].as_str().unwrap_or("failed"),
                    args["accepted"]==true,
                )
            }
            _ => Err(invalid("未知模型传输控制")),
        }
    }
    async fn start(&self, id: &str, args: &Value, rpc_cancel: CancellationToken) -> Result<Value> {
        if self.0.cancel.is_cancelled() || rpc_cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if args["method"] != "POST"
            || !args["url"].as_str().is_some_and(|s| s.len() <= 8192)
            || !args["body"]
                .as_str()
                .is_some_and(|s| s.len() <= 7 * 1024 * 1024)
            || !args["headers"].as_array().is_some_and(|v| v.len() <= 64)
        {
            return Err(invalid("模型请求格式或大小无效"));
        }
        let stream = Arc::new(Stream {
            cancel: self.0.cancel.child_token(),
            response: Mutex::new(None),
            reading: Arc::new(tokio::sync::Semaphore::new(1)),
        });
        {
            let mut streams = self.0.streams.lock().map_err(|_| Error::Cancelled)?;
            if streams.contains_key(id) || streams.len() >= 2 {
                return Err(invalid("模型请求已存在或根任务已有两个在途请求"));
            }
            streams.insert(id.into(), stream.clone());
        }
        let admitted = Arc::new(AtomicBool::new(false));
        let called = Arc::new(AtomicBool::new(false));
        let state = self.0.clone();
        let request = id.to_owned();
        let admitted_flag = admitted.clone();
        let mut model = state.config["reference"].clone();
        if !model.is_object() {
            model = json!({});
        }
        model["cost"] = state.config["resolved"]["cost"].clone();
        model["configHash"]=arguments_hash(&json!({"baseUrl":state.config["resolved"]["baseUrl"],"protocol":state.config["resolved"]["protocol"],"id":state.config["resolved"]["id"]})).into();
        model["requestHash"] =
            arguments_hash(&json!({"method":args["method"],"url":args["url"],"body":args["body"]}))
                .into();
        let life = stream.cancel.clone();
        let receipts=args.get("receipts").cloned().unwrap_or(Value::Null);
        let purpose=if args["purpose"]=="compaction"{"compaction"}else if args["purpose"]=="progress_review"{"progress_review"}else{"model"};
        let admit: ModelAdmission = Arc::new(move || {
            if life.is_cancelled() {
                return Err(Error::Cancelled);
            }
            if called.swap(true, Ordering::AcqRel) {
                return Err(invalid("同一模型请求不能重复发送"));
            }
            let result =
                state
                    .gateway
                    .reserve_model_context(&state.permit, &request, if state.child.is_some(){"subagent"}else{purpose}, &model,state.child.as_ref(),&receipts,purpose)?;
            if result["admitted"] != true {
                return Err(invalid("这项模型请求已登记，未重发HTTP"));
            }
            admitted_flag.store(true, Ordering::Release);
            Ok(result)
        });
        let mut guard = StartGuard {
            controller: self.clone(),
            id: id.into(),
            admitted: admitted.clone(),
            armed: true,
        };
        let result = tokio::select! {biased;
            _=rpc_cancel.cancelled()=>return Err(Error::Cancelled),
            _=stream.cancel.cancelled()=>return Err(Error::Cancelled),
            value=(self.0.host)(self.0.config.clone(),args.clone(),stream.cancel.clone(),admit)=>value
        };
        let response = result?;
        if !admitted.load(Ordering::Acquire) {
            return Err(invalid("原生模型宿主没有登记请求，未接收响应"));
        }
        if !(200..=599).contains(&response.status) || response.headers.len() > 128 {
            return Err(invalid("原生模型响应头无效"));
        }
        let reply = json!({"status":response.status,"headers":response.headers});
        *stream.response.lock().map_err(|_| Error::Cancelled)? = Some(Arc::new(response));
        guard.armed = false;
        Ok(reply)
    }
    async fn read(&self, id: &str, rpc_cancel: CancellationToken) -> Result<Value> {
        // Check the live immutable owner before each pull without keeping the
        // database locked while the next network chunk is awaited.
        self.0.gateway.authorize_model_scoped(&self.0.permit,self.0.child.as_ref())?;
        let stream = self
            .0
            .streams
            .lock()
            .map_err(|_| Error::Cancelled)?
            .get(id)
            .cloned()
            .ok_or_else(|| invalid("模型响应已结束，不能重复读取"))?;
        let _reading = stream
            .reading
            .clone()
            .try_acquire_owned()
            .map_err(|_| invalid("同一模型响应不能并发拉取"))?;
        let response = stream
            .response
            .lock()
            .map_err(|_| Error::Cancelled)?
            .clone()
            .ok_or_else(|| invalid("模型响应尚未就绪"))?;
        let next = tokio::select! {biased;_=rpc_cancel.cancelled()=>Err(Error::Cancelled),_=stream.cancel.cancelled()=>Err(Error::Cancelled),value=response.body.next(stream.cancel.clone())=>value};
        match next {
            Ok(Some(chunk)) if !chunk.is_empty() && chunk.len() <= MAX_MODEL_CHUNK => {
                Ok(json!({"done":false,"chunk":STANDARD.encode(chunk)}))
            }
            Ok(None) => {
                self.0
                    .streams
                    .lock()
                    .map_err(|_| Error::Cancelled)?
                    .remove(id);
                self.0
                    .gateway
                    .model_transport_complete(&self.0.permit, id)?;
                Ok(json!({"done":true}))
            }
            outcome => {
                let _ = self.cancel(id, false);
                outcome.and_then(|_| Err(invalid("模型响应块大小无效")))
            }
        }
    }
    fn cancel(&self, id: &str, consumer: bool) -> Result<Value> {
        if let Some(stream) = self
            .0
            .streams
            .lock()
            .map_err(|_| Error::Cancelled)?
            .remove(id)
        {
            stream.cancel.cancel();
            if consumer {
                let _ = self.0.gateway.model_transport_complete(&self.0.permit, id);
            } else {
                let _ =
                    self.0
                        .gateway
                        .finish_model_request(&self.0.permit, id, &json!({}), "unknown");
            }
        }
        Ok(json!({"requestId":id,"cancelled":true}))
    }
    pub(crate) fn close(&self) {
        let streams =
            std::mem::take(&mut *self.0.streams.lock().unwrap_or_else(|p| p.into_inner()));
        for (id, stream) in streams {
            stream.cancel.cancel();
            let _ = self
                .0
                .gateway
                .finish_model_request(&self.0.permit, &id, &json!({}), "unknown");
        }
    }
}
struct StartGuard {
    controller: ModelHttpController,
    id: String,
    admitted: Arc<AtomicBool>,
    armed: bool,
}
impl Drop for StartGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Some(stream) = self
                .controller
                .0
                .streams
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&self.id)
            {
                stream.cancel.cancel();
            }
            if self.admitted.load(Ordering::Acquire) {
                let _ = self.controller.0.gateway.finish_model_request(
                    &self.controller.0.permit,
                    &self.id,
                    &json!({}),
                    "unknown",
                );
            }
        }
    }
}
use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::atomic::AtomicUsize};
    struct Body(Mutex<VecDeque<Vec<u8>>>);
    impl ModelHttpBody for Body {
        fn next(&self, cancel: CancellationToken) -> BoxFuture<Result<Option<Vec<u8>>>> {
            let value = self.0.lock().unwrap().pop_front();
            Box::pin(async move {
                if cancel.is_cancelled() {
                    Err(Error::Cancelled)
                } else {
                    Ok(value)
                }
            })
        }
    }
    fn fixture(host: ModelHttpHost) -> (StoryToolGateway, TaskPermit, ModelHttpController) {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::migration::migrate(&mut db, None).unwrap();
        db.execute_batch("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('w','隔离','free','l','{}','test','test','test');INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n','w',0,'opening','独立正文','test');INSERT INTO states VALUES('n','{\"time\":{\"elapsedMinutes\":0}}');INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l','w','主线','n','test')").unwrap();
        let store = crate::Store(Arc::new(Mutex::new(db)));
        let gateway = StoryToolGateway::new(store);
        gateway
            .create_session(&crate::pi_store::NewSession {
                id: "s".into(),
                world_id: "w".into(),
                line_id: "l".into(),
                title: "隔离".into(),
                session_file: None,
            })
            .unwrap();
        gateway
            .start_task(
                "s",
                "t",
                "只检查模型流",
                "auto",
                false,
                json!({"id":"fixture","slot":"own-slot"}),
                json!({"limits":{"modelRequests":2}}),
            )
            .unwrap();
        let permit = gateway.permit("t").unwrap();
        let controller = ModelHttpController::new(
            gateway.clone(),
            permit.clone(),
            json!({"id":"fixture","baseUrl":"https://private.invalid/v1","protocol":"chat-completions","apiKey":"OWNED-HTTP-SECRET"}),
            json!({"id":"fixture","slot":"own-slot"}),
            host,
            CancellationToken::new(),
        );
        (gateway, permit, controller)
    }
    fn args(id: &str) -> Value {
        json!({"requestId":id,"method":"POST","url":"https://private.invalid/v1/chat/completions","headers":[["content-type","application/json"]],"body":STANDARD.encode(b"{\"opaque\":\"signature\"}")})
    }
    #[tokio::test]
    async fn pull_completion_usage_cancellation_and_replay_share_the_real_ledger() {
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        let host: ModelHttpHost = Arc::new(move |_, request, _, admit| {
            let counter = counter.clone();
            Box::pin(async move {
                assert_eq!(
                    STANDARD.decode(request["body"].as_str().unwrap()).unwrap(),
                    b"{\"opaque\":\"signature\"}"
                );
                admit()?;
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(ModelHttpResponse {
                    status: 200,
                    headers: vec![("content-type".into(), "text/event-stream".into())],
                    body: Arc::new(Body(Mutex::new(VecDeque::from([
                        b"data: fixture\n\n".to_vec()
                    ])))),
                })
            })
        });
        let (gateway, permit, controller) = fixture(host);
        let token = CancellationToken::new();
        assert_eq!(
            controller
                .invoke("start", &args("model-one"), token.clone())
                .await
                .unwrap()["status"],
            200
        );
        let part = controller
            .invoke("read", &json!({"requestId":"model-one"}), token.clone())
            .await
            .unwrap();
        assert_eq!(
            STANDARD.decode(part["chunk"].as_str().unwrap()).unwrap(),
            b"data: fixture\n\n"
        );
        assert_eq!(
            controller
                .invoke("read", &json!({"requestId":"model-one"}), token.clone())
                .await
                .unwrap()["done"],
            true
        );
        let budget = gateway.model_budget(&permit).unwrap();
        assert_eq!(budget["runningRequests"], 0);
        assert_eq!(budget["unknownRequests"], 1);
        assert_eq!(budget["usageKnown"], false);
        assert!(controller
            .invoke("start", &args("model-one"), token.clone())
            .await
            .is_err());
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let budget=controller.invoke("usage",&json!({"requestId":"model-one","status":"success","usage":{"input":7,"output":3,"raw":"OWNED-HTTP-SECRET"}}),token.clone()).await.unwrap();
        assert_eq!(budget["modelRequests"], 1);
        assert_eq!(budget["usageKnown"], true);
        controller
            .invoke("start", &args("model-two"), token.clone())
            .await
            .unwrap();
        controller
            .invoke(
                "cancel",
                &json!({"requestId":"model-two","reason":"aborted"}),
                token.clone(),
            )
            .await
            .unwrap();
        let after = controller
            .invoke(
                "usage",
                &json!({"requestId":"model-two","status":"failed","usage":{}}),
                token.clone(),
            )
            .await
            .unwrap();
        assert_eq!(after["unknownRequests"], 1);
        assert!(controller
            .invoke("start", &args("model-three"), token)
            .await
            .is_err());
        assert_eq!(count.load(Ordering::SeqCst), 2);
        let raw: String = gateway
            .0
             .0
            .lock()
            .unwrap()
            .query_row(
                "SELECT group_concat(model_json||COALESCE(usage_json,'')) FROM pi_model_requests",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!raw.contains("OWNED-HTTP-SECRET") && !raw.contains("private.invalid"));
        controller.close();
    }
    #[tokio::test]
    async fn a_native_host_without_admission_cannot_return_a_response() {
        let host: ModelHttpHost = Arc::new(|_, _, _, _| {
            Box::pin(async {
                Ok(ModelHttpResponse {
                    status: 200,
                    headers: vec![],
                    body: Arc::new(Body(Mutex::new(VecDeque::new()))),
                })
            })
        });
        let (gateway, permit, controller) = fixture(host);
        assert!(controller
            .invoke("start", &args("model-unadmitted"), CancellationToken::new())
            .await
            .is_err());
        assert_eq!(gateway.model_budget(&permit).unwrap()["modelRequests"], 0);
        assert!(controller.0.streams.lock().unwrap().is_empty());
    }
}
