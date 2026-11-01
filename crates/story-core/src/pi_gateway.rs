//! Story effects for a Pi session. Pi owns model messages; this gateway owns
//! task authority, drafts, transaction guards, receipts and story recovery.
use crate::{
    agent_workspace as ws, execution_lease as lease,
    pi_store::{self, BeginCall, NewSession, NewTask, PiCallRequest, PiStore},
    Error, Result, RunPlan, Store,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};

#[derive(Clone)]
pub struct StoryToolGateway(pub PiStore);

/// Bound once when the native execution opens. Never refresh this ticket
/// merely because another executor saved a newer fence in the task row.
#[derive(Clone, Debug)]
pub struct TaskPermit {
    pub task_id: String,
    ticket: lease::LeaseTicket,
}

impl TaskPermit {
    pub(crate) fn attempt_id(&self)->String {pi_store::arguments_hash(&serde_json::to_value(&self.ticket).expect("lease serialization"))}
}

impl StoryToolGateway {
    pub fn new(store: Store) -> Self {
        Self(PiStore(store))
    }

    pub fn create_session(&self, request: &NewSession) -> Result<()> {
        let mut db = self.0 .0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ws::base(&tx, &request.world_id, &request.line_id)?;
        pi_store::create_session_tx(&tx, request)?;
        tx.commit()?;
        Ok(())
    }

    /// The base, lease and task are established in one transaction. No full
    /// world snapshot or former Agent conversation is fed to Pi at startup.
    pub fn start_task(
        &self,
        session_id: &str,
        task_id: &str,
        text: &str,
        policy: &str,
        read_only: bool,
        model: Value,
        mut metadata: Value,
    ) -> Result<Value> {
        self.0.initialize()?;
        let mut db = self.0 .0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        let (world, line): (String, String) = tx.query_row(
            "SELECT s.world_id,s.line_id FROM pi_sessions s JOIN worlds w ON w.id=s.world_id WHERE s.id=? AND w.archived=0", [session_id], |r| Ok((r.get(0)?,r.get(1)?)))?;
        let base = ws::base(&tx, &world, &line)?;
        let ticket = lease::acquire_tx(
            &tx,
            &world,
            task_id,
            lease::process_instance(),
            lease::now_ms(),
            lease::DEFAULT_TTL_MS,
        )?;
        if !metadata.is_object() {
            metadata = json!({});
        }
        metadata["_nativeHostActive"] = false.into();
        metadata["factContract"]=2.into();
        metadata["toolPackages"]=crate::pi_toolpkg::pinned(&tx)?;
        metadata["fileGrants"]=crate::pi_documents::pin(&tx)?;
        let state: String = tx.query_row(
            "SELECT state_json FROM states WHERE node_id=?",
            [ws::text(&base, "headId")],
            |r| r.get(0),
        )?;
        metadata["referenceScope"] = ws::parse(&state)["source"].clone();
        let request = NewTask {
            id: task_id.into(),
            session_id: session_id.into(),
            text: text.into(),
            policy: policy.into(),
            read_only,
            world_version: ws::text(&base, "fingerprint").into(),
            base,
            model,
            metadata,
            lease: serde_json::to_value(ticket)?,
            host_owner: lease::process_instance().into(),
        };
        pi_store::create_task_tx(&tx, &request)?;
        tx.commit()?;
        drop(db);
        self.0.task(task_id)
    }

    pub fn definitions(&self) -> Vec<Value> {
        crate::pi_tools::definitions()
    }

    pub(crate) fn capture_external(&self,permit:&TaskPermit,request:&PiCallRequest,value:&mut Value)->Result<()> {
        let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task=self.guard_owner(&tx,permit)?;guard(&tx,&task,request)?;
        if let Some(reference)=crate::pi_external::capture(&tx,&task,request,value)? {value["resourceRef"]=reference;}
        tx.commit()?;Ok(())
    }

    pub(crate) fn save_tool_package(&self,permit:&TaskPermit,request:&PiCallRequest,package:&crate::pi_toolpkg::Prepared)->Result<Value>{
        let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task=self.guard_owner(&tx,permit)?;guard(&tx,&task,request)?;
        let result=crate::pi_toolpkg::save(&tx,package,Some(&request.task_id))?;tx.commit()?;Ok(result)
    }

    /// Reserve readonly child identities before the trusted Pi adapter opens
    /// their sessions. The model-facing result is completed only after those
    /// sessions settle; preparing a delegation is not finishing the work.
    pub(crate) fn prepare_children(&self,permit:&TaskPermit,request:&PiCallRequest)->Result<Value> {
        if request.task_id!=permit.task_id||request.tool!="delegate_readonly"||request.external_write{return Err(Error::Invalid("子任务分派不属于本次执行".into()));}
        match self.0.begin_call_guarded(request,|tx,existing|{
            let task=self.guard_owner(tx,permit)?;
            if existing&&["committed","completed","previewed","blocked"].contains(&ws::text(&task,"status")){return Ok(());}
            guard(tx,&task,request)
        })? {
            BeginCall::Cached(value)=>return Ok(crate::pi_tools::delivery(&request.call_id,&request.tool,value)),
            BeginCall::InFlight|BeginCall::Unknown=>return Ok(failure("delegation_incomplete","原分派已有记录但未确认完整结束，不会自动重复运行；请查看子任务结果后重新安排")),
            BeginCall::Execute=>{}
        }
        let prepared=(||{
            let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let task=self.guard_owner(&tx,permit)?;guard(&tx,&task,request)?;
            crate::tools::validate_with(&crate::pi_tools::catalog(),"delegate_readonly",&request.args)?;
            let plan=task_plan(&tx,&task)?;
            let value=crate::pi_children::prepare(&tx,&task,&request.call_id,&request.args,|reference|crate::pi_resources::provided_view(&tx,&task,&plan,reference))?;
            tx.commit()?;Ok::<_,Error>(json!({"ok":true,"data":value}))
        })();
        match prepared {
            Ok(value)=>Ok(value),
            Err(error)=>{let value=failure("delegation_failed",&error.to_string());self.0.finish_call(request,&value)?;Ok(value)}
        }
    }

    pub fn reserve_model_request(&self,permit:&TaskPermit,id:&str,source:&str,model:&Value)->Result<Value> {
        self.reserve_model_scoped(permit,id,source,model,None)
    }
    pub(crate) fn reserve_model_scoped(&self,permit:&TaskPermit,id:&str,source:&str,model:&Value,child:Option<&crate::pi_children::ChildAuthority>)->Result<Value> {
        self.reserve_model_context(permit,id,source,model,child,&Value::Null,"model")
    }
    pub(crate) fn reserve_model_context(&self,permit:&TaskPermit,id:&str,source:&str,model:&Value,child:Option<&crate::pi_children::ChildAuthority>,receipts:&Value,purpose:&str)->Result<Value> {
        let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task=self.guard_owner(&tx,permit)?;
        if let Some(child)=child {crate::pi_children::guard(&tx,&task,child)?;}
        if task["stop_revision"].as_i64().unwrap_or(0)>0{return Err(Error::Cancelled);}
        if task["status"]=="waiting_user" {return Err(Error::Invalid("请等待玩家回答后再请求模型".into()));}
        if source=="progress_review"&&!task["metadata_json"]["progressReview"]["pending"].is_object()&&!ws::parse(ws::text(&task,"metadata_json"))["progressReview"]["pending"].is_object(){return Err(Error::Stale);}
        let result=crate::pi_budget::reserve_model(&tx,&permit.task_id,id,source,model)?;
        tx.execute("UPDATE pi_tasks SET metadata_json=json_set(metadata_json,'$.executionPhase',?) WHERE id=?",params![match source {"compaction"=>"compacting","progress_review"=>"reviewing",_=>"waiting_model"},permit.task_id])?;
        if result["admitted"]==true {crate::pi_receipts::admit(&tx,&task,id,child.map(|c|c.id.as_str()).unwrap_or(""),receipts,purpose)?;}
        tx.commit()?;Ok(result)
    }
    pub fn finish_model_request(&self,permit:&TaskPermit,id:&str,usage:&Value,status:&str)->Result<Value> {
        self.finish_model_context(permit,id,usage,status,false)
    }
    pub(crate) fn finish_model_context(&self,permit:&TaskPermit,id:&str,usage:&Value,status:&str,accepted:bool)->Result<Value> {
        let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.guard_owner(&tx,permit)?;
        let result=crate::pi_budget::finish_model(&tx,&permit.task_id,id,usage,status)?;
        crate::pi_receipts::confirm(&tx,&permit.task_id,id,accepted&&status=="success")?;
        tx.commit()?;Ok(result)
    }
    pub(crate) fn model_transport_complete(&self,permit:&TaskPermit,id:&str)->Result<Value>{
        let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.guard_owner(&tx,permit)?;let result=crate::pi_budget::transport_complete(&tx,&permit.task_id,id)?;tx.commit()?;Ok(result)
    }
    pub(crate) fn model_budget(&self,permit:&TaskPermit)->Result<Value>{
        let db=self.0.0.lock()?;self.guard_owner(&db,permit)?;crate::pi_budget::read_budget(&db,&permit.task_id)
    }
    pub(crate) fn authorize_model_scoped(&self,permit:&TaskPermit,child:Option<&crate::pi_children::ChildAuthority>)->Result<()> {
        let db=self.0.0.lock()?;let task=self.guard_owner(&db,permit)?;
        if let Some(child)=child {crate::pi_children::guard(&db,&task,child)?;}
        if task["stop_revision"].as_i64().unwrap_or(0)>0{return Err(Error::Cancelled);}Ok(())
    }
    pub(crate) fn child_record(&self,permit:&TaskPermit,id:&str)->Result<crate::pi_children::ChildAuthority> {
        let db=self.0.0.lock()?;self.guard_owner(&db,permit)?;crate::pi_children::authority(&db,&permit.task_id,id)
    }
    pub(crate) fn open_child(&self,permit:&TaskPermit,id:&str,file:&str)->Result<crate::pi_children::ChildAuthority> {
        let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task=self.guard_owner(&tx,permit)?;let child=crate::pi_children::authority(&tx,&permit.task_id,id)?;
        crate::pi_children::open(&tx,&task,&child,file)?;tx.commit()?;Ok(child)
    }
    pub(crate) fn child_context(&self,permit:&TaskPermit,child:&crate::pi_children::ChildAuthority)->Result<Value> {
        let db=self.0.0.lock()?;let task=self.guard_owner(&db,permit)?;crate::pi_children::context(&db,&task,child)
    }
    pub(crate) fn finish_child(&self,permit:&TaskPermit,child:&crate::pi_children::ChildAuthority,args:&Value)->Result<Value> {
        let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task=self.guard_owner(&tx,permit)?;let value=crate::pi_children::finish(&tx,&task,child,args)?;tx.commit()?;Ok(value)
    }
    pub(crate) fn finish_children(&self,permit:&TaskPermit,request:&PiCallRequest)->Result<Value> {
        let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.guard_owner(&tx,permit)?;
        let children={let mut stmt=tx.prepare("SELECT status,result_json FROM pi_children WHERE task_id=? AND parent_call_id=? ORDER BY rowid")?;let rows=stmt.query_map(params![permit.task_id,request.call_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?;rows.collect::<std::result::Result<Vec<_>,_>>()?};
        if children.is_empty()||children.iter().any(|(status,_)|["prepared","running"].contains(&status.as_str())) {return Err(Error::Invalid("只读子任务尚未完整结束，不能把执行结束当作目标完成".into()));}
        let results=children.iter().map(|(status,result)|result.as_deref().map(ws::parse).unwrap_or_else(||json!({"status":status,"goalCompleted":false,"warning":"子任务未取得完整结果，不能自动重跑"}))).collect::<Vec<_>>();
        let value=json!({"ok":true,"data":{"reports":results,"allAnswered":children.iter().all(|(status,_)|status=="answered"),"goalCompleted":false,"message":"只读核对已返回，主助手须结合版本、证据与当前要求处理，答复不等于故事修改已经生效。"}});
        pi_store::complete_call_tx(&tx,request,&value)?;tx.commit()?;Ok(crate::pi_tools::delivery(&request.call_id,"delegate_readonly",value))
    }
    /// Only an explicitly continued execution may update its next-request
    /// settings. Counters, scope, permissions and the original goals survive.
    pub(crate) fn configure_continuation(&self, permit:&TaskPermit, model:&Value, limits:Option<&Value>,compacting:bool)->Result<()> {
        let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task=self.guard_owner(&tx,permit)?;
        if task["status"]!="running" || host_active(&task) {return Err(Error::Stale);}
        let mut meta=ws::parse(ws::text(&task,"metadata_json"));
        if let Some(limits)=limits {meta["limits"]=crate::pi_budget::limits(limits)?;}
        meta["activeOperation"]=if compacting{json!("compact")}else{Value::Null};
        tx.execute("UPDATE pi_tasks SET model_json=?,metadata_json=?,updated_at=? WHERE id=?",params![model.to_string(),meta.to_string(),ws::now(),permit.task_id])?;
        tx.commit()?;Ok(())
    }
    /// A manual Pi checkpoint is control state, never a goal receipt or a
    /// story commit. Leave all requirements, drafts and root usage intact.
    pub(crate) fn compacted(&self,permit:&TaskPermit,result:&Value)->Result<Value> {
        let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task=self.guard_owner(&tx,permit)?;
        if task["stop_revision"].as_i64().unwrap_or(0)>0{return Err(Error::Cancelled);}
        if task["status"]!="running"{return Err(Error::Stale);}
        let mut meta=ws::parse(ws::text(&task,"metadata_json"));
        let mut checkpoint=json!({"at":ws::now(),"consumedIntentRevision":task["consumed_intent_revision"],"latestIntentRevision":task["intent_revision"],"summaryStoredBy":"pi-session"});
        if let Some(id)=result["firstKeptEntryId"].as_str().filter(|s|s.len()<=512){checkpoint["firstKeptEntryId"]=id.into();}
        for key in ["tokensBefore","summaryChars","messageCount","inputBudgetTokens","effectiveInputBudgetTokens"] {if let Some(n)=result[key].as_u64(){checkpoint[key]=n.into();}}
        meta["contextCheckpoint"]=checkpoint.clone();
        meta["activeOperation"]=Value::Null;
        tx.execute("UPDATE pi_tasks SET status='paused',metadata_json=?,error=NULL,updated_at=? WHERE id=?",params![meta.to_string(),ws::now(),permit.task_id])?;
        crate::pi_budget::clock_pause(&tx,&permit.task_id)?;
        tx.commit()?;Ok(checkpoint)
    }

    /// Trusted Pi extension read, not a model-facing tool or transcript copy.
    /// It is also valid between formal adoption and Pi's final visible reply.
    pub(crate) fn task_context(&self,permit:&TaskPermit)->Result<Value> {
        let db=self.0.0.lock()?;
        let task=self.guard_owner(&db,permit)?;
        if task["stop_revision"].as_i64().unwrap_or(0)>0 {return Err(Error::Cancelled);}
        let mut stmt=db.prepare("SELECT id,seq,content_json,intent_revision FROM pi_inputs WHERE task_id=? AND delivery IN ('steer','answer') AND status='delivered' ORDER BY seq")?;
        let rows=stmt.query_map([&permit.task_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<i64>>(3)?)))?;
        let corrections=rows.map(|row|{let(id,seq,payload,intent)=row?;let payload:Value=serde_json::from_str(&payload)?;Ok(json!({"id":id,"seq":seq,"text":payload["text"],"intentRevision":intent}))}).collect::<Result<Vec<_>>>()?;
        let metadata=ws::parse(ws::text(&task,"metadata_json"));
        let workspace=ws::parse(ws::text(&task,"workspace_json"));
        let review=crate::pi_progress::prepare(&db,&task)?;
        Ok(json!({"reviewRequest":review,"runtimeGuidance":metadata["runtimeGuidance"],"target":metadata["target"],"goal":task["text"],"corrections":corrections,"plan":ws::parse(ws::text(&task,"plan_json")),"question":ws::parse(ws::text(&task,"question_json")),"draftRefs":ws::changes(&workspace),"skillRefs":metadata["skillReads"],"requestedSkills":metadata["skills"],"intentRevision":task["intent_revision"],"consumedIntentRevision":task["consumed_intent_revision"],"storyVersion":task["base_world_version"],"status":task["status"],"receipt":crate::pi_closeout::receipt_summary(&ws::parse(ws::text(&task,"result_json"))),"resource":{"worldId":task["world_id"],"lineId":task["line_id"]},"warning":"这些是程序保存的当前任务要求和实际状态，摘要或对话印象不能代替它们；修改草稿不是正式剧情。"}))
    }

    pub(crate) fn progress_decision(&self,permit:&TaskPermit,args:&Value)->Result<Value>{
        let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;let task=self.guard_owner(&tx,permit)?;
        let base=ws::parse(ws::text(&task,"base_json"));if ws::fingerprint(&tx,ws::text(&task,"world_id"))?!=ws::text(&base,"fingerprint"){return Err(Error::Stale);}
        let result=crate::pi_progress::decide(&tx,&task,args)?;tx.commit()?;Ok(result)
    }
    /// Await long operations only after releasing the authorizing transaction.
    pub(crate) fn begin_async_scoped(&self,permit:&TaskPermit,request:&PiCallRequest,child:Option<&crate::pi_children::ChildAuthority>)->Result<BeginCall> {
        if request.task_id!=permit.task_id || request.external_write && !["call_remote_tool","write_document"].contains(&request.tool.as_str()) || !crate::pi_async::supports(&request.tool) {
            return Err(Error::Invalid("该异步能力不属于当前任务".into()));
        }
        let begun=self.0.begin_call_guarded(request,|tx,existing|{
            let task=self.guard_owner(tx,permit)?;
            if let Some(child)=child {
                crate::pi_children::authorize_tool(tx,&task,child,&request.tool,&request.args)?;
                if !child.owns_call(&request.call_id)||existing&&!crate::pi_children::owns_result(tx,child,&request.call_id)? {return Err(Error::Stale);}
            }
            if existing && ["committed","completed","previewed","blocked"].contains(&ws::text(&task,"status")){return Ok(());}
            guard(tx,&task,request)
        })?;
        if matches!(begun,BeginCall::Execute) {
            if let Some(child)=child {
                let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let task=self.guard_owner(&tx,permit)?;crate::pi_children::authorize_tool(&tx,&task,child,&request.tool,&request.args)?;
                tx.execute("INSERT INTO pi_child_calls(task_id,call_id,child_id) VALUES(?,?,?)",params![request.task_id,request.call_id,child.id])?;tx.commit()?;
            }
        }
        Ok(begun)
    }

    pub(crate) fn async_context_scoped(&self,permit:&TaskPermit,request:&PiCallRequest,child:Option<&crate::pi_children::ChildAuthority>)->Result<(RunPlan,Value)> {
        let db=self.0.0.lock()?;
        let task=self.guard_owner(&db,permit)?;
        guard(&db,&task,request)?;
        crate::tools::validate_with(&crate::pi_tools::catalog(),&request.tool,&request.args)?;
        let mut plan=task_plan(&db,&task)?;
        crate::pi_capabilities::check(&db,&plan,&request.tool,&request.args)?;
        if let Some(child)=child {crate::pi_children::authorize_tool(&db,&task,child,&request.tool,&request.args)?;plan.meta["agent"]["readOnly"]=true.into();plan.meta["agent"]["subtaskReadOnly"]=true.into();plan.meta["agent"]["readOnlyActor"]=child.id.clone().into();plan.meta["agent"]["taskId"]="".into();}
        Ok((plan,task))
    }

    pub(crate) fn save_script_store(&self,permit:&TaskPermit,request:&PiCallRequest,store:&Value)->Result<()> {
        let mut db=self.0.0.lock()?;
        let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task=self.guard_owner(&tx,permit)?;
        guard(&tx,&task,request)?;
        let mut meta=ws::parse(ws::text(&task,"metadata_json"));
        meta["scriptStore"]=store.clone();
        tx.execute("UPDATE pi_tasks SET metadata_json=? WHERE id=?",params![meta.to_string(),request.task_id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn permit(&self, task_id: &str) -> Result<TaskPermit> {
        let db = self.0 .0.lock()?;
        let task = task_row(&db, task_id)?;
        let ticket = task_ticket(&task)?;
        lease::guard(&db, &ticket, lease::now_ms())?;
        Ok(TaskPermit {
            task_id: task_id.into(),
            ticket,
        })
    }

    /// expected_task comes from the owning host, never from a model argument.
    /// Every response, including a business error, is durable before Pi sees it.
    pub fn invoke(&self, permit: &TaskPermit, request: PiCallRequest) -> Result<Value> {
        self.invoke_scoped(permit,request,None)
    }
    pub(crate) fn invoke_child(&self,permit:&TaskPermit,request:PiCallRequest,child:&crate::pi_children::ChildAuthority)->Result<Value> {
        self.invoke_scoped(permit,request,Some(child))
    }
    fn invoke_scoped(&self,permit:&TaskPermit,request:PiCallRequest,child:Option<&crate::pi_children::ChildAuthority>)->Result<Value> {
        if request.task_id != permit.task_id {
            return Err(Error::Invalid("工具调用不属于当前任务".into()));
        }
        if request.external_write || !(crate::pi_tools::supports(&request.tool)||child.is_some()&&request.tool=="read_provided_draft") {
            return Err(Error::Invalid("该能力尚未接入当前故事网关".into()));
        }
        match self.0.begin_call_guarded(&request, |tx, existing| {
            let task = task_row(tx, &request.task_id)?;
            if task_ticket(&task)? != permit.ticket {
                return Err(Error::Stale);
            }
            if let Some(child)=child {
                lease::guard(tx,&permit.ticket,lease::now_ms())?;crate::pi_children::guard(tx,&task,child)?;
                if !child.owns_call(&request.call_id)||existing&&!crate::pi_children::owns_result(tx,child,&request.call_id)? {return Err(Error::Invalid("调用记录不属于当前只读子助手".into()));}
            }
            // A terminal receipt remains readable after release. Resuming a
            // task changes its saved ticket and invalidates this old permit.
            if existing && ["committed", "completed", "previewed", "blocked"].contains(&ws::text(&task, "status"))
                || child.is_none() && crate::pi_closeout::terminal(&task)
            {
                return Ok(());
            }
            lease::guard(tx, &permit.ticket, lease::now_ms())
        })? {
            BeginCall::Cached(result) => return Ok(crate::pi_tools::delivery(&request.call_id,&request.tool,result)),
            BeginCall::InFlight => {
                return Ok(failure(
                    "call_in_flight",
                    "该调用已登记且尚无结果，不能重复执行",
                ))
            }
            BeginCall::Unknown => {
                return Ok(failure(
                    "outcome_unknown",
                    "操作结果未知，须先核对，不能自动重放",
                ))
            }
            BeginCall::Execute => {}
        }
        let result = (||{
            if let Some(child)=child {
                let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let task=self.guard_owner(&tx,permit)?;crate::pi_children::guard(&tx,&task,child)?;
                if !child.owns_call(&request.call_id){return Err(Error::Invalid("子助手调用标识没有绑定到其原生身份".into()));}
                tx.execute("INSERT INTO pi_child_calls(task_id,call_id,child_id) VALUES(?,?,?)",params![request.task_id,request.call_id,child.id])?;tx.commit()?;
            }
            self.execute(permit, &request,child)
        })();
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                let value = match &error {
                    Error::Tool{code,field,message,next}=>json!({"ok":false,"error":{"code":code,"field":field,"message":message,"next":next}}),
                    _=>failure(match error {Error::Stale=>"stale",Error::Cancelled=>"cancelled",_=>"tool_failed"},&error.to_string()),
                };
                self.0.finish_call(&request, &value)?;
                Ok(value)
            }
        }
    }

    fn execute(&self, permit: &TaskPermit, request: &PiCallRequest,child:Option<&crate::pi_children::ChildAuthority>) -> Result<Value> {
        let mut db = self.0 .0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task = task_row(&tx, &request.task_id)?;
        if task_ticket(&task)? != permit.ticket {
            return Err(Error::Stale);
        }
        let mut plan = task_plan(&tx, &task)?;
        if child.is_none() && crate::pi_closeout::terminal(&task) {
            crate::tools::validate_with(&crate::pi_tools::catalog(), &request.tool, &request.args)?;
            let data=crate::pi_closeout::call(&tx,&task,&plan,request)?;
            let value=json!({"ok":true,"data":data});
            pi_store::complete_call_tx(&tx,request,&value)?;
            tx.commit()?;
            return Ok(crate::pi_tools::delivery(&request.call_id,&request.tool,value));
        }
        guard(&tx, &task, request)?;
        let catalog=if let Some(child)=child {
            crate::pi_children::authorize_tool(&tx,&task,child,&request.tool,&request.args)?;
            plan.meta["agent"]["taskId"]="".into();plan.meta["agent"]["readOnly"]=true.into();plan.meta["agent"]["readOnlyActor"]=child.id.clone().into();
            crate::pi_children::catalog()
        }else{crate::pi_tools::catalog()};
        crate::tools::validate_with(&catalog, &request.tool, &request.args)?;
        let modifying = matches!(
            request.tool.as_str(),
            "stage_edit" | "stage_story_turn" | "stage_route" | "discard_draft" | "stage_clock" | "draft_skill"
        );
        if task["read_only"] == 1 && modifying {
            return Err(Error::Invalid("本次仅作只读分析，不能暂存修改".into()));
        }
        let mut args = crate::pi_resources::resolve(&tx,&task,&plan,&request.tool,&request.args)?;
        if ["stage_edit","read_resource"].contains(&request.tool.as_str()) && child.is_none() {
            args = ws::scoped_resource_args(&tx,&plan,&request.task_id,&args)?;
        }
        if modifying {
            args["_agentCall"] = request.call_id.clone().into();
        }
        let cacheable=matches!(request.tool.as_str(),"read_resource"|"read_timeline"|"search_resources"|"search_original"|"read_original"|"read_canon_facts");
        let cache_key=pi_store::arguments_hash(&json!([request.world_version,task["workspace_json"],plan.meta["agent"]["referenceScope"],child.map(|c|c.id.as_str()).unwrap_or(""),request.tool,args]));
        let cached:Option<String>=if cacheable{tx.query_row("SELECT data_json FROM pi_read_cache WHERE task_id=? AND cache_key=?",params![request.task_id,cache_key],|r|r.get(0)).optional()?}else{None};
        let mut data = if let Some(raw)=cached {serde_json::from_str(&raw)?}else{match request.tool.as_str() {
            "list_resources" => ws::list_page(&tx, &plan, &args)?,
            "search_resources" => ws::search(&tx, &plan, &args)?,
            "read_world" => ws::locators(&tx, &plan)?,
            "read_resource" if child.is_some()=>ws::read_formal(&tx,&plan,&args)?,
            "read_resource" => ws::read(&tx, &plan, &request.task_id, &args)?,
            "read_provided_draft"=>crate::pi_children::provided(&tx,child.ok_or_else(||Error::Invalid("该草稿只提供给特定子助手".into()))?,&args)?,
            "discover_tools" if child.is_some()=>crate::pi_children::discover(&args)?,
            "stage_edit" => ws::stage(&tx, &plan, &request.task_id, &args)?,
            "stage_story_turn" => ws::stage_story(&tx, &request.task_id, &args)?,
            "stage_route" => ws::stage_route(&tx, &plan, &request.task_id, &args)?,
            "discard_draft" => ws::discard_draft(&tx, &request.task_id, &args)?,
            "read_clock" => crate::agent_clock::read_clock(&tx, &plan, &args)?,
            "stage_clock" => crate::agent_clock::stage_clock(&tx, &plan, &request.task_id, &args)?,
            "validate_changes" => ws::validate(&tx, &plan, &request.task_id)?,
            "finish_task" => finish(&tx, &task, &plan, request, false)?,
            _ => crate::pi_tools::call(&tx,&task,&plan,request)?,
        }};
        if request.tool=="read_timeline" {ws::attach_read_locators(&mut data,&json!({"callId":request.call_id}));}
        if cacheable&&data.to_string().len()<=256*1024 {tx.execute("INSERT OR IGNORE INTO pi_read_cache(task_id,cache_key,data_json) VALUES(?,?,?)",params![request.task_id,cache_key,data.to_string()])?;}
        let data=crate::pi_resources::project(&tx,&task,&plan,&request.tool,&args,data)?;
        let value = json!({"ok":true,"data":data});
        pi_store::complete_call_tx(&tx, request, &value)?;
        let delivered=crate::pi_tools::delivery(&request.call_id,&request.tool,value);
        let mut actual=request.clone();actual.args=args;
        let actor=child.map(|child|child.id.as_str()).unwrap_or("");
        let candidate=if request.tool=="read_tool_result" {
            crate::pi_evidence::capture_with_source(&tx,&task,&plan,&actual,&delivered,actor,|call|crate::pi_receipts::source(&tx,&request.task_id,call))?
        }else{crate::pi_evidence::capture(&tx,&task,&plan,&actual,&delivered,actor)?};
        if let Some(candidate)=candidate {
            crate::pi_receipts::save(&tx,&task,&request.call_id,child.map(|child|child.id.as_str()).unwrap_or(""),&candidate)?;
        }
        tx.commit()?;
        Ok(delivered)
    }

    /// Host timers call this while model/network work is in flight. A stale
    /// process cannot renew a new owner's ticket or later submit its draft.
    pub fn heartbeat(&self, permit: &TaskPermit) -> Result<()> {
        let mut db = self.0 .0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task = task_row(&tx, &permit.task_id)?;
        if task_ticket(&task)? != permit.ticket {
            return Err(Error::Stale);
        }
        if task["stop_revision"].as_i64().unwrap_or(0)>0{return Err(Error::Cancelled);}
        lease::heartbeat_tx(&tx, &permit.ticket, lease::now_ms(), lease::DEFAULT_TTL_MS)?;
        if task["status"]!="waiting_user" {
            crate::pi_budget::clock_start(&tx,&permit.task_id)?;
            crate::pi_budget::check_time(&tx,&permit.task_id)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn stop(&self, task_id: &str) -> Result<()> {
        self.0.stop(task_id)
    }
    pub(crate) fn cancel_waiting(&self,task_id:&str)->Result<()> {
        let mut db=self.0.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task=task_row(&tx,task_id)?;
        if task["status"]!="waiting_user"||host_active(&task){return Err(Error::Stale);}
        tx.execute("UPDATE pi_tasks SET status='cancelled',question_json=NULL,stop_revision=stop_revision+1,error=?,updated_at=? WHERE id=?",params!["玩家已停止，未采用草稿保留",ws::now(),task_id])?;
        crate::pi_budget::clock_pause(&tx,task_id)?;
        tx.commit()?;Ok(())
    }

    pub fn stop_owned(&self, permit: &TaskPermit) -> Result<()> {
        self.0.stop_guarded(&permit.task_id, |tx| {
            self.guard_owner(tx, permit).map(|_| ())
        })
    }

    /// These native control operations share the immutable execution fence.
    /// A late old process cannot change the resumed task's requirements.
    pub fn append_input(
        &self,
        permit: &TaskPermit,
        delivery: &str,
        content: &Value,
    ) -> Result<String> {
        self.append_named_input(permit,delivery,content,None)
    }
    pub fn append_named_input(
        &self,
        permit: &TaskPermit,
        delivery: &str,
        content: &Value,
        input_id: Option<&str>,
    ) -> Result<String> {
        if !["steer", "answer"].contains(&delivery) {
            return Err(Error::Invalid("当前执行只接收补充或问题回答".into()));
        }
        let task = self.0.task(&permit.task_id)?;
        self.0.append_named_input_guarded(
            ws::text(&task, "session_id"),
            Some(&permit.task_id),
            delivery,
            content,
            input_id,
            |tx| {
                let task = self.guard_owner(tx, permit)?;
                if task["stop_revision"].as_i64().unwrap_or(0) > 0 {
                    return Err(Error::Cancelled);
                }
                Ok(())
            },
        )
    }

    pub fn consume_input(&self, permit: &TaskPermit, id: &str) -> Result<Value> {
        self.0.consume_input_guarded(id, |tx, input| {
            self.guard_owner(tx, permit)?;
            if input["task_id"].as_str() != Some(&permit.task_id) {
                return Err(Error::Invalid("这条输入不属于当前任务".into()));
            }
            Ok(())
        })
    }

    fn guard_owner(&self, tx: &Connection, permit: &TaskPermit) -> Result<Value> {
        let task = task_row(tx, &permit.task_id)?;
        if task_ticket(&task)? != permit.ticket {
            return Err(Error::Stale);
        }
        lease::guard(tx, &permit.ticket, lease::now_ms())?;
        Ok(task)
    }

    pub fn attach_host(&self, permit: &TaskPermit) -> Result<()> {
        let mut db = self.0 .0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task = task_row(&tx, &permit.task_id)?;
        if task_ticket(&task)? != permit.ticket {
            return Err(Error::Stale);
        }
        lease::guard(&tx, &permit.ticket, lease::now_ms())?;
        set_host_active(&tx, &task, true)?;
        crate::pi_budget::clock_start(&tx,&permit.task_id)?;
        tx.commit()?;
        Ok(())
    }

    /// Keep the story/session exclusively owned through Pi's final visible
    /// reply, even if its formal changes were already committed by a tool.
    pub fn release_host(&self, permit: &TaskPermit) -> Result<()> {
        crate::pi_lifecycle::settle(&self.0.0,&permit.task_id,&permit.attempt_id(),"执行已结束，要求与草稿已保留")?;
        Ok(())
    }

    /// Called only after Pi confirms cancellation or a transport failure.
    /// The old execution cannot mark a resumed owner's task as interrupted.
    pub fn interrupt(&self, permit: &TaskPermit, reason: &str) -> Result<()> {
        crate::pi_lifecycle::settle(&self.0.0,&permit.task_id,&permit.attempt_id(),reason)?;
        Ok(())
    }

    pub fn resume_task(&self, task_id: &str) -> Result<TaskPermit> {
        let mut db = self.0 .0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        let task = task_row(&tx, task_id)?;
        if ![
            "interrupted",
            "cancelled",
            "paused",
            "failed",
            "blocked",
            "running",
            "stale",
        ]
        .contains(&ws::text(&task, "status"))
        {
            return Err(Error::Invalid("这项任务不能继续执行".into()));
        }
        let now = lease::now_ms();
        if lease::current(&tx, ws::text(&task, "world_id"))?
            .is_some_and(|l| !l.ticket.owner_id.is_empty() && l.expires_at_ms > now)
        {
            return Err(Error::Invalid("原执行尚未停止，不能重复启动".into()));
        }
        let old_base=ws::parse(ws::text(&task,"base_json"));
        let current=ws::base(&tx,ws::text(&task,"world_id"),ws::text(&old_base,"lineId"))?;
        if current["fingerprint"]!=old_base["fingerprint"] {
            crate::pi_rebase::save(&tx,&task,&task_plan(&tx,&task)?,&ws::parse(ws::text(&task,"workspace_json")),&current)?;
        }
        let task=task_row(&tx,task_id)?;
        let ticket = lease::acquire_tx(
            &tx,
            ws::text(&task, "world_id"),
            task_id,
            lease::process_instance(),
            now,
            lease::DEFAULT_TTL_MS,
        )?;
        tx.execute("UPDATE pi_tasks SET status='running',stop_revision=0,error=NULL,lease_json=?,host_owner=?,updated_at=? WHERE id=?",
            params![serde_json::to_string(&ticket)?,lease::process_instance(),ws::now(),task_id])?;
        let mut metadata=ws::parse(ws::text(&task,"metadata_json"));
        metadata.as_object_mut().map(|m|m.remove("stopReceipt"));
        metadata["executionPhase"]="starting".into();
        tx.execute("UPDATE pi_tasks SET metadata_json=? WHERE id=?",params![metadata.to_string(),task_id])?;
        crate::pi_budget::interrupt_models(&tx,task_id)?;
        crate::pi_children::interrupt(&tx,task_id,"恢复父任务时保留旧核对记录，不自动重跑子任务")?;
        let fresh=task_row(&tx,task_id)?;
        set_host_active(&tx, &fresh, false)?;
        tx.commit()?;
        Ok(TaskPermit {
            task_id: task_id.into(),
            ticket,
        })
    }

    /// A preview is never silently rebased onto new gameplay. Reacquire its
    /// story lease and check the original world and intent in this transaction.
    pub fn adopt_preview(&self, task_id: &str) -> Result<Value> {
        let mut db = self.0 .0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut task = task_row(&tx, task_id)?;
        if task["status"] == "committed" {
            return Ok(ws::parse(ws::text(&task, "result_json")));
        }
        if task["status"] != "previewed" {
            return Err(Error::Invalid("这项任务没有待采用的预览".into()));
        }
        ws::guard(&tx, &ws::parse(ws::text(&task, "base_json")))?;
        let ticket = lease::acquire_tx(
            &tx,
            ws::text(&task, "world_id"),
            task_id,
            lease::process_instance(),
            lease::now_ms(),
            lease::DEFAULT_TTL_MS,
        )?;
        task["lease_json"] = serde_json::to_string(&ticket)?.into();
        task["host_owner"] = lease::process_instance().into();
        task["status"] = "running".into();
        tx.execute(
            "UPDATE pi_tasks SET status='running',lease_json=?,host_owner=? WHERE id=?",
            params![
                task["lease_json"].as_str(),
                lease::process_instance(),
                task_id
            ],
        )?;
        let old = ws::parse(ws::text(&task, "result_json"));
        let request = PiCallRequest {
            task_id: task_id.into(),
            call_id: format!("adopt:{}", ws::id()),
            tool: "finish_task".into(),
            args: json!({"summary":old["summary"]}),
            intent_revision: task["intent_revision"].as_i64().unwrap_or(0),
            world_version: ws::text(&task, "base_world_version").into(),
            external_write: false,
        };
        let result = finish(&tx, &task, &task_plan(&tx, &task)?, &request, true)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn undo_recovery(&self, recovery_id: &str) -> Result<Value> {
        let mut db = self.0 .0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        let row = ws::rows(
            &tx,
            "SELECT * FROM story_recovery_points WHERE id=?",
            &[&recovery_id],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| Error::Invalid("这项恢复点不存在".into()))?;
        let ticket = lease::acquire_tx(
            &tx,
            ws::text(&row, "world_id"),
            &format!("restore:{recovery_id}"),
            lease::process_instance(),
            lease::now_ms(),
            lease::DEFAULT_TTL_MS,
        )?;
        let backup = json!({"worldId":row["world_id"],"postFingerprint":row["post_fingerprint"],"before":ws::parse(ws::text(&row,"before_json"))});
        ws::restore_backup(&tx, &backup)?;
        tx.execute("UPDATE pi_sessions SET line_id=(SELECT current_line_id FROM worlds WHERE id=?) WHERE id IN (SELECT session_id FROM pi_tasks WHERE id=?)",params![ws::text(&row,"world_id"),ws::text(&row,"task_id")])?;
        tx.execute(
            "DELETE FROM story_recovery_points WHERE id=?",
            [recovery_id],
        )?;
        tx.execute("UPDATE pi_commit_batches SET receipt_json=json_set(receipt_json,'$.undone',json('true')) WHERE json_extract(receipt_json,'$.recoveryId')=?",[recovery_id])?;
        tx.execute("UPDATE pi_tasks SET status='undone',error='最近一批修改已撤回；其他批次保留，后续修改请按当前故事重新核对',updated_at=? WHERE id=?",params![ws::now(),ws::text(&row,"task_id")])?;

        lease::release_tx(&tx, &ticket)?;
        tx.commit()?;
        Ok(json!({"undone":true,"worldId":row["world_id"]}))
    }
}

fn failure(code: &str, message: &str) -> Value {
    json!({"ok":false,"error":{"code":code,"message":message}})
}

fn host_active(task: &Value) -> bool {
    ws::parse(ws::text(task, "metadata_json"))["_nativeHostActive"] == true
}
fn set_host_active(tx: &Transaction<'_>, task: &Value, active: bool) -> Result<()> {
    let mut metadata = ws::parse(ws::text(task, "metadata_json"));
    if !metadata.is_object() {
        metadata = json!({});
    }
    metadata["_nativeHostActive"] = active.into();
    tx.execute(
        "UPDATE pi_tasks SET metadata_json=? WHERE id=?",
        params![metadata.to_string(), task["id"].as_str()],
    )?;
    Ok(())
}
fn release_finished(tx: &Transaction<'_>, task: &Value) -> Result<()> {
    if !host_active(task) {
        lease::release_tx(tx, &task_ticket(task)?)?;
    }
    Ok(())
}

fn task_row(db: &Connection, task: &str) -> Result<Value> {
    ws::rows(db, "SELECT * FROM pi_tasks WHERE id=?", &[&task])?
        .into_iter()
        .next()
        .ok_or_else(|| Error::Invalid("这项Pi任务不存在，旧助手会话不能继续执行".into()))
}

fn task_ticket(task: &Value) -> Result<lease::LeaseTicket> {
    let ticket: lease::LeaseTicket = serde_json::from_str(ws::text(task, "lease_json"))?;
    if ticket.world_id != ws::text(task, "world_id")
        || ticket.owner_id != ws::text(task, "id")
        || ticket.owner_instance != ws::text(task, "host_owner")
        || ticket.owner_instance != lease::process_instance()
    {
        return Err(Error::Stale);
    }
    Ok(ticket)
}

fn guard(db: &Connection, task: &Value, request: &PiCallRequest) -> Result<()> {
    lease::guard(db, &task_ticket(task)?, lease::now_ms())?;
    if task["status"] != "running" || task["stop_revision"].as_i64().unwrap_or(0) != 0 {
        return Err(Error::Cancelled);
    }
    if task["intent_revision"].as_i64() != Some(request.intent_revision) {
        return Err(Error::Stale);
    }
    let base = ws::parse(ws::text(task, "base_json"));
    if request.world_version != ws::text(task, "base_world_version") {
        return Err(Error::Stale);
    }
    ws::guard(db, &base)
}

fn task_plan(db: &Connection, task: &Value) -> Result<RunPlan> {
    let base = ws::parse(ws::text(task, "base_json"));
    let metadata = ws::parse(ws::text(task, "metadata_json"));
    // Business methods accept this existing rule context, without any model
    // authority, transcript, request scheduling or extraction messages.
    let plan = json!({"id":task["id"],"worldId":task["world_id"],"lineId":base["lineId"],"headId":base["headId"],
        "baseId":null,"kind":"pi_task","executionMode":"classic",
        "model":{"slot":"","url":"","model":"","auxModel":null,"includeUsage":false,"maxTokens":null,"extra":{}},
        "messages":[],"extractMessages":[],"state":{},"settings":{},"options":{},"action":{},
        "meta":{"agent":{"taskId":task["id"],"sessionId":task["session_id"],"referenceScope":metadata["referenceScope"],"skills":metadata["skills"],"skillSnapshots":metadata["skillSnapshots"],"customSkills":metadata["customSkills"],"network":metadata["network"],"readOnly":task["read_only"]==1}}});
    let _ = db; // The state itself is read from the current guarded story on demand.
    Ok(serde_json::from_value(plan)?)
}

fn finish(
    tx: &Transaction<'_>,
    task: &Value,
    plan: &RunPlan,
    request: &PiCallRequest,
    adopting: bool,
) -> Result<Value> {
    let workspace = ws::workspace(tx, &request.task_id)?;
    let changes = ws::changes(&workspace);
    let summary = request.args["summary"].as_str().unwrap_or("");
    let outcome = request.args["outcome"].as_str().unwrap_or("completed");
    if tx.query_row("SELECT EXISTS(SELECT 1 FROM pi_children WHERE task_id=? AND status IN ('prepared','running'))",[&request.task_id],|r|r.get::<_,bool>(0))? {return Err(Error::Invalid("只读子任务仍在核对，须先接收结果或取消，不能提前提交".into()));}
    if !task["question_json"].is_null() {
        return Err(Error::Invalid("当前问题尚未回答，不能完成任务".into()));
    }
    if outcome == "no_changes_needed" && !changes.is_empty() {
        return Err(Error::Invalid(
            "草稿中仍有修改，不能将其标记为无需修改".into(),
        ));
    }
    if outcome == "blocked" {
        let result = json!({"status":"blocked","goalStatus":"blocked","goalCompleted":false,"summary":summary,"changed":false,"reason":request.args["reason"],"pendingChanges":changes});
        tx.execute(
            "UPDATE pi_tasks SET status='blocked',result_json=?,updated_at=? WHERE id=?",
            params![result.to_string(), ws::now(), request.task_id],
        )?;
        release_finished(tx, task)?;
        return Ok(result);
    }
    let metadata=ws::parse(ws::text(task,"metadata_json"));
    for id in metadata["skills"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if !metadata["skillReads"].as_array().into_iter().flatten().any(|read|read["id"]==id && ws::text(read,"actor").is_empty() && read["status"]=="fetched" && read["bodyRead"]==true && !tx.query_row("SELECT EXISTS(SELECT 1 FROM pi_child_calls WHERE task_id=? AND call_id=?)",params![request.task_id,ws::text(read,"callId")],|r|r.get::<_,bool>(0)).unwrap_or(true)) {
            return Err(Error::Invalid(format!("请先读完本次明确指定的技能正文：{id}。用read_skill返回的requiresRead/read定位分页read_tool_result，或read_skill_resource(path=SKILL.md)；读取版本和支持文件不代表方法正文已经送达，也不代表完成查证")));
        }
    }
    // Re-evaluate against the current intent, complete draft and successful
    // model-window receipts in this same commit transaction. A saved report
    // is never an authorization to adopt later edits or a later branch.
    let goal_result=crate::pi_goal_report::for_finish(tx,task,plan)?;
    let reported_goal_status=goal_result.as_ref().and_then(|v|v["status"].as_str()).unwrap_or("completed");
    let selections=goal_result.as_ref().map(|v|v["validSelections"].clone()).unwrap_or(json!(crate::pi_verification::resource_groups(&workspace)?.as_array().into_iter().flatten().map(|g|json!({"groupId":g["groupId"],"fingerprint":g["fingerprint"],"originalFingerprint":g["originalFingerprint"],"afterFingerprint":g["afterFingerprint"]})).collect::<Vec<_>>()));
    let selected=if changes.is_empty(){workspace.clone()}else{crate::pi_verification::select_verified_workspace(&workspace,&selections)?["selectedWorkspace"].clone()};
    let remaining=if changes.is_empty(){json!({})}else{crate::pi_verification::remaining_workspace(&workspace,&selections)?};
    let pending_changes=ws::changes(&remaining);
    let pending=!pending_changes.is_empty() || reported_goal_status!="completed";
    let goal_status=if pending {"partial"}else{reported_goal_status};
    crate::pi_adoption::check_no_conflicts(&selected)?;
    if changes.is_empty() {
        let result = json!({"status":"answered","goalStatus":goal_status,"goalCompleted":goal_status=="completed","goalResult":goal_result,"summary":summary,"changed":false,"changes":[],"worldVersion":request.world_version});
        tx.execute(
            "UPDATE pi_tasks SET status=?,result_json=?,updated_at=? WHERE id=?",
            params![if pending{"paused"}else{"completed"},result.to_string(), ws::now(), request.task_id],
        )?;
        release_finished(tx, task)?;
        return Ok(result);
    }
    if task["read_only"] == 1 {
        return Err(Error::Invalid("只读任务不能采用故事修改".into()));
    }
    pi_store::guard_commit(
        tx,
        &request.task_id,
        request.intent_revision,
        &ws::fingerprint(tx, &plan.world_id)?,
    )?;
    ws::save_workspace(tx,&request.task_id,&selected)?;
    let changes=ws::changes(&selected);
    let preview = ws::validate(tx, plan, &request.task_id)?;
    if task["policy"] == "preview" && !adopting {
        ws::save_workspace(tx,&request.task_id,&workspace)?;
        let result = json!({"status":"previewed","goalStatus":goal_status,"goalCompleted":false,"goalResult":goal_result,"summary":summary,"changed":false,"changes":changes,"pendingChanges":pending_changes,"preview":preview["preview"],"worldVersion":request.world_version});
        tx.execute(
            "UPDATE pi_tasks SET status='previewed',result_json=?,updated_at=? WHERE id=?",
            params![result.to_string(), ws::now(), request.task_id],
        )?;
        release_finished(tx, task)?;
        return Ok(result);
    }
    let mut formal_plan=plan.clone();
    formal_plan.meta["agent"]["taskId"]="".into();
    let before_clock=crate::agent_clock::read_clock(tx,&formal_plan,&json!({}))?;
    let (mut result, backup) = ws::apply_contents(tx, plan, &request.task_id, summary)?;
    let batch_id=ws::id();
    let adopted_line:String=tx.query_row("SELECT current_line_id FROM worlds WHERE id=?",[&plan.world_id],|r|r.get(0))?;
    tx.execute("UPDATE pi_sessions SET line_id=? WHERE id=?",params![adopted_line,ws::text(task,"session_id")])?;
    crate::pi_adoption::sources(tx,task,&batch_id,goal_result.as_ref(),&selections,&adopted_line)?;
    let world_version = ws::fingerprint(tx, &plan.world_id)?;
    let recovery_id = if let Some(backup) = backup {
        let id = ws::id();
        tx.execute("INSERT INTO story_recovery_points(id,world_id,task_id,before_json,post_fingerprint,result_json,created_at) VALUES(?,?,?,?,?,?,?)",
            params![id,plan.world_id,request.task_id,backup["before"].to_string(),world_version,result.to_string(),ws::now()])?;
        Some(id)
    } else {
        None
    };
    result["status"] = "committed".into();
    result["goalStatus"]=goal_status.into();
    result["goalCompleted"]=(goal_status=="completed").into();
    result["goalResult"]=json!(goal_result);
    result["worldVersion"] = world_version.clone().into();
    result["recoveryId"] = json!(recovery_id);
    result["batchId"]=batch_id.clone().into();result["pendingChanges"]=json!(pending_changes);result["pendingContinue"]=pending.into();
    result["readBack"] = ws::base(
        tx,
        &plan.world_id,
        &tx.query_row(
            "SELECT current_line_id FROM worlds WHERE id=?",
            [&plan.world_id],
            |r| r.get::<_, String>(0),
        )?,
    )?;
    formal_plan.line_id=tx.query_row("SELECT current_line_id FROM worlds WHERE id=?",[&plan.world_id],|r|r.get(0))?;
    let after_clock=crate::agent_clock::read_clock(tx,&formal_plan,&json!({}))?;
    result["clockReadBack"]=json!({"before":before_clock["now"],"after":after_clock["now"],"elapsedMinutesBefore":before_clock["elapsedMinutes"],"elapsedMinutesAfter":after_clock["elapsedMinutes"],"elapsedMinutesPreserved":before_clock["elapsedMinutes"]==after_clock["elapsedMinutes"]});
    let formal_snapshot=crate::pi_closeout::snapshot(tx,&formal_plan)?;
    tx.execute("INSERT INTO pi_commit_snapshots(batch_id,task_id,world_version,snapshot_json) VALUES(?,?,?,?)",params![batch_id,request.task_id,world_version,formal_snapshot.to_string()])?;
    result["snapshotRef"]=json!({"batchId":batch_id,"worldVersion":world_version,"tool":"read_committed_snapshot"});
    if before_clock["now"]["date"]!=after_clock["now"]["date"] {
        result["clockReadBack"]["dateBasis"]=json!({"kind":"calibration_not_canon_evidence","originalDateVerified":false,"note":"本局日期校准值本身不能证明原著明示了这个日期；原文线索与推定须分别说明。"});
    }
    tx.execute("INSERT INTO pi_commit_batches(id,task_id,world_id,line_id,intent_revision,before_version,after_version,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",params![batch_id,request.task_id,plan.world_id,adopted_line,request.intent_revision,request.world_version,ws::text(&result,"worldVersion"),result.to_string(),ws::now()])?;
    if pending {crate::pi_rebase::save(tx,task,plan,&remaining,&result["readBack"])?;}else{ws::save_workspace(tx,&request.task_id,&json!({}))?;}
    tx.execute("UPDATE pi_tasks SET status=?,result_json=?,updated_at=? WHERE id=?",params![if pending{"paused"}else{"committed"},result.to_string(),ws::now(),request.task_id])?;
    release_finished(tx, task)?;
    Ok(result)
}
