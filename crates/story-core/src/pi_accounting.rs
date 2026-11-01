//! Root-owned accounting for a native model capability outside Pi's provider
//! stream (currently native web search). No network or provider loop here.
use crate::{pi_gateway::{StoryToolGateway,TaskPermit},pi_store::arguments_hash,Error,Result};
use serde_json::{json,Value};
use std::sync::{Arc,atomic::{AtomicBool,Ordering}};

#[derive(Clone)]
pub struct NativeModelAccounting(Arc<State>);
struct State {
    gateway:StoryToolGateway,
    permit:TaskPermit,
    id:String,
    model:Value,
    child:Option<crate::pi_children::ChildAuthority>,
    called:AtomicBool,
    admitted:AtomicBool,
    finished:AtomicBool,
}
impl NativeModelAccounting {
    pub(crate) fn search_scoped(gateway:StoryToolGateway,permit:TaskPermit,call:&str,config:&Value,child:Option<crate::pi_children::ChildAuthority>)->Self {
        let model=json!({"slot":config["slot"],"model":config["model"],"protocol":config["protocol"],"configHash":arguments_hash(&json!({"url":config["url"],"model":config["model"],"protocol":config["protocol"]}))});
        Self(Arc::new(State{gateway,permit,id:format!("native-{}",arguments_hash(&json!({"callId":call}))),model,child,called:AtomicBool::new(false),admitted:AtomicBool::new(false),finished:AtomicBool::new(false)}))
    }
    /// Platform calls this only after credentials, endpoint and request have
    /// passed local validation, immediately before the single HTTP send.
    pub fn admit(&self)->Result<()> {
        if self.0.called.swap(true,Ordering::AcqRel){return Err(Error::Invalid("原生搜索不能重复发送同一模型请求".into()));}
        let value=self.0.gateway.reserve_model_scoped(&self.0.permit,&self.0.id,"native_search",&self.0.model,self.0.child.as_ref())?;
        if value["admitted"]!=true {return Err(Error::Invalid("该原生搜索已登记，未重复发送".into()));}
        self.0.admitted.store(true,Ordering::Release);Ok(())
    }
    pub fn finish(&self,usage:&Value,status:&str)->Result<()> {
        if !self.admitted(){return Err(Error::Invalid("原生搜索尚未登记模型请求，不能确认用量".into()));}
        self.0.gateway.finish_model_request(&self.0.permit,&self.0.id,usage,status)?;
        self.0.finished.store(true,Ordering::Release);Ok(())
    }
    pub fn admitted(&self)->bool{self.0.admitted.load(Ordering::Acquire)}
    pub fn finished(&self)->bool{self.0.finished.load(Ordering::Acquire)}
}
impl Drop for State {
    fn drop(&mut self){
        if self.admitted.load(Ordering::Acquire)&&!self.finished.load(Ordering::Acquire){
            // Timeout, cancellation and a dropped future leave an attempt,
            // never a fictitious zero-token response or an automatic replay.
            let _=self.gateway.finish_model_request(&self.permit,&self.id,&json!({}),"unknown");
        }
    }
}
