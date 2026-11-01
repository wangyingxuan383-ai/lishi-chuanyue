//! Explicit, isolated Node/Pi/native-gateway probe. Never run during tests.
//! cargo run -p story-core --example pi_gateway_probe -- --node <absolute>
//!   --runtime <absolute fixed distribution> --output <new absolute directory>

#[cfg(not(target_os = "android"))]
#[path = "../../pi-model-http.rs"]
mod native_model_http;

#[cfg(target_os = "android")]
fn main() {
    eprintln!("This explicit desktop probe does not launch processes on Android.");
    std::process::exit(2);
}

#[cfg(not(target_os = "android"))]
#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = desktop::run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "android"))]
mod desktop {
    use chrono::Utc;
    use pi_host::{NodeLaunch, NodeProcess, ProcessExit, TransportOptions};
    use serde_json::{json, Value};
    use std::{
        env, fs,
        fs::{File, OpenOptions},
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        path::{Component, Path, PathBuf},
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Mutex,
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };
    use story_core::{
        pi_gateway::StoryToolGateway,
        pi_runtime::{PiTaskConfig, PiTaskHost},
        pi_store::NewSession,
        sql::SqlStore,
    };

    const OWNED_KEY: &str = "pi-gateway-probe-owned-fake-key-only";
    const FROZEN_KEY: &str = "pi-gateway-probe-old-memory-fake-key";
    const PREMISE: &str = "Pi端到端实际采用的本局设定";
    const STAGE_CALL: &str = "probe-stage-setting";
    const DISCOVER_CALL: &str = "probe-discover-tools";
    const COMMIT_CALL: &str = "probe-finish-task";
    const DELEGATE_CALL:&str="probe-delegate";
    type Outcome<T> = std::result::Result<T, String>;

    fn clean(error: impl std::fmt::Display) -> String {
        error.to_string().replace(OWNED_KEY, "[owned-key-redacted]").replace(FROZEN_KEY, "[old-key-redacted]")
    }
    fn require(condition: bool, message: &str) -> Outcome<()> {
        if condition {
            Ok(())
        } else {
            Err(message.into())
        }
    }

    struct Options {
        node: PathBuf,
        runtime: PathBuf,
        output: PathBuf,
        children:bool,
    }
    impl Options {
        fn parse() -> Outcome<Self> {
            let mut args = env::args().skip(1);
            let (mut node, mut runtime, mut output) = (None, None, None);
            let mut children=false;
            while let Some(name) = args.next() {
                if name=="--children" {require(!children,"Repeated child scenario")?;children=true;continue;}
                let value = args.next().ok_or("Every option needs an absolute path")?;
                let target = match name.as_str() {
                    "--node" => &mut node,
                    "--runtime" => &mut runtime,
                    "--output" => &mut output,
                    _ => return Err("Expected only --node, --runtime and --output".into()),
                };
                require(target.is_none(), "An option was supplied more than once")?;
                let path = PathBuf::from(value);
                require(
                    path.is_absolute()
                        && !path.components().any(|c| matches!(c, Component::ParentDir)),
                    "All paths must be absolute without parent traversal",
                )?;
                *target = Some(path);
            }
            let value = Self {
                node: node.ok_or("--node is required")?,
                runtime: runtime.ok_or("--runtime is required")?,
                output: output.ok_or("--output is required")?,
                children,
            };
            require(
                value.node.is_file(),
                "The selected Node executable is missing",
            )?;
            require(
                value.runtime.is_dir(),
                "The selected fixed Pi distribution is missing",
            )?;
            // create_dir below is exclusive as well, so an existing output is
            // never reused even if another process creates it after this check.
            require(
                !value.output.exists(),
                "Output already exists; choose a new isolated directory",
            )?;
            Ok(value)
        }
    }

    #[derive(Default)]
    struct Observations {
        stage_result_delivered: bool,
        commit_result_delivered: bool,
        failures: Vec<String>,
    }
    struct Mock {
        port: u16,
        received: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
        observations: Arc<Mutex<Observations>>,
        worker: Option<JoinHandle<()>>,
    }
    impl Mock {
        fn start(directory: &Path,children:bool) -> Outcome<Self> {
            let ledger = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.join("mock-ledger.jsonl"))
                .map_err(clean)?;
            ledger.sync_all().map_err(clean)?;
            let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(clean)?;
            listener.set_nonblocking(true).map_err(clean)?;
            let port = listener.local_addr().map_err(clean)?.port();
            let received = Arc::new(AtomicUsize::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            let observations = Arc::new(Mutex::new(Observations::default()));
            let (count, stopping, seen) = (received.clone(), stop.clone(), observations.clone());
            let worker = thread::spawn(move || {
                let mut ledger = ledger;
                while !stopping.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut socket, peer)) => {
                            if !peer.ip().is_loopback() {
                                continue;
                            }
                            if socket.set_nonblocking(false).is_err() {continue;}
                            if let Err(error) = serve(&mut socket, &mut ledger, &count, &seen,children) {
                                if let Ok(mut observations) = seen.lock() {
                                    observations.failures.push(clean(error));
                                }
                                let _ = http_error(&mut socket);
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10))
                        }
                        Err(error) => {
                            if let Ok(mut observations) = seen.lock() {
                                observations.failures.push(clean(error));
                            }
                            break;
                        }
                    }
                }
            });
            Ok(Self {
                port,
                received,
                stop,
                observations,
                worker: Some(worker),
            })
        }
        fn close(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
        fn snapshot(&self) -> Value {
            let observed = self.observations.lock().unwrap_or_else(|p| p.into_inner());
            json!({"modelRequests":self.received.load(Ordering::Acquire),"mockRequests":self.received.load(Ordering::Acquire),"realRequests":0,
                "stageResultDelivered":observed.stage_result_delivered,"commitResultDelivered":observed.commit_result_delivered,"failures":observed.failures})
        }
    }
    impl Drop for Mock {
        fn drop(&mut self) {
            self.close();
        }
    }

    fn serve(
        socket: &mut TcpStream,
        ledger: &mut File,
        count: &AtomicUsize,
        seen: &Mutex<Observations>,
        children:bool,
    ) -> Outcome<()> {
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(clean)?;
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(clean)?;
        let mut bytes = Vec::new();
        let mut block = [0u8; 8192];
        let mut sequence = None;
        let boundary = loop {
            let size = match socket.read(&mut block) {
                Ok(0) if bytes.is_empty()=>return Ok(()),
                Err(error) if bytes.is_empty() && matches!(error.kind(),std::io::ErrorKind::WouldBlock|std::io::ErrorKind::TimedOut)=>return Ok(()),
                value=>value.map_err(clean)?,
            };
            require(size > 0, "Incomplete owned HTTP request")?;
            if sequence.is_none() {
                let current = count.fetch_add(1, Ordering::AcqRel) + 1;
                // Count every received attempt before validation or response,
                // including malformed and excess requests. Never save headers.
                serde_json::to_writer(&mut *ledger,&json!({"sequence":current,"at":Utc::now().to_rfc3339(),"mockRequests":1,"realRequests":0,"event":"received"})).map_err(clean)?;
                ledger.write_all(b"\n").map_err(clean)?;
                ledger.sync_all().map_err(clean)?;
                sequence = Some(current);
            }
            bytes.extend_from_slice(&block[..size]);
            if let Some(at) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                break at + 4;
            }
            require(
                bytes.len() <= 64 * 1024,
                "Owned HTTP headers exceed the fixture limit",
            )?;
        };
        let headers = String::from_utf8_lossy(&bytes[..boundary]);
        require(
            headers
                .lines()
                .next()
                .is_some_and(|line| line.starts_with("POST /v1/chat/completions ")),
            "Unexpected owned HTTP route",
        )?;
        let size = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .ok_or("Owned HTTP request has no bounded content length")?;
        require(
            size <= 4 * 1024 * 1024,
            "Owned request body exceeds the fixture limit",
        )?;
        while bytes.len() - boundary < size {
            let size_read = socket.read(&mut block).map_err(clean)?;
            require(size_read > 0, "Incomplete owned request body")?;
            bytes.extend_from_slice(&block[..size_read]);
        }
        let body: Value = serde_json::from_slice(&bytes[boundary..boundary + size])
            .map_err(|_| "Invalid owned JSON body".to_string())?;
        let sequence = sequence.ok_or("Owned request was not accounted")?;
        require(body["messages"].to_string().contains("本次任务实时约束"),"The current native task constraints were not injected")?;
        let (delta, finish) = if children {child_response(&body,seen)?}else{match sequence {
            1 => (
                json!({"role":"assistant","content":"先读取需要的工具参数。","tool_calls":[tool(DISCOVER_CALL,"discover_tools",json!({"names":["stage_edit","validate_changes"]}))]}),
                "tool_calls",
            ),
            2 => {
                let result=tool_result(&body,DISCOVER_CALL)?;
                require(result["ok"]==true && body["tools"].as_array().is_some_and(|tools|tools.iter().any(|t|t["function"]["name"]=="stage_edit")),"Tool discovery did not enable the requested schema")?;
                (
                json!({"role":"assistant","content":"先暂存设定，再按策略采用。","tool_calls":[tool(STAGE_CALL,"stage_edit",json!({"kind":"settings","path":"/premise","operation":"set","value":PREMISE,"summary":"仅修改独立设定"}))]}),
                "tool_calls",
                )
            },
            3 => {
                let result = tool_result(&body, STAGE_CALL)?;
                require(
                    result["ok"] == true && result["data"]["staged"] == true,
                    "Pi did not receive the real staged tool result",
                )?;
                seen.lock()
                    .map_err(|_| "Mock observation lock failed")?
                    .stage_result_delivered = true;
                (
                    json!({"role":"assistant","tool_calls":[tool(COMMIT_CALL,"finish_task",json!({"summary":"已按要求采用独立设定"}))]}),
                    "tool_calls",
                )
            }
            4 => {
                let result = tool_result(&body, COMMIT_CALL)?;
                require(
                    result["ok"] == true
                        && result["data"]["status"] == "committed"
                        && result["data"]["recoveryId"].is_string(),
                    "Pi did not receive the native commit receipt",
                )?;
                seen.lock()
                    .map_err(|_| "Mock observation lock failed")?
                    .commit_result_delivered = true;
                require(body["messages"].to_string().contains("\\\"status\\\":\\\"committed\\\""),"Final response did not read the actual committed task status")?;
                (
                    json!({"role":"assistant","content":"独立设定已采用；未新增剧情、未推进时间。"}),
                    "stop",
                )
            }
            _ => return Err("The fixed four-round sequence was exceeded".into()),
        }};
        let chunk = |delta: Value, reason: Value| json!({"id":format!("owned-mock-{sequence}"),"object":"chat.completion.chunk","created":1,"model":"owned-pi-gateway-probe","usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12},"choices":[{"index":0,"delta":delta,"finish_reason":reason}]});
        let response = format!(
            "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
            chunk(delta, Value::Null),
            chunk(json!({}), finish.into())
        );
        write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-cache\r\n\r\n{}",response.len(),response).map_err(clean)?;
        socket.flush().map_err(clean)
    }
    fn tool(id: &str, name: &str, args: Value) -> Value {
        json!({"index":0,"id":id,"type":"function","function":{"name":name,"arguments":args.to_string()}})
    }
    fn child_response(body:&Value,seen:&Mutex<Observations>)->Outcome<(Value,&'static str)> {
        let messages=body["messages"].as_array().ok_or("No child scenario messages")?;
        let child=messages.iter().filter(|m|m["role"]=="system").any(|m|m["content"].to_string().contains("你是本局的只读核对助手"));
        if child {
            require(!body["tools"].to_string().contains("\"name\":\"finish_task\""),"A child received a formal commit tool")?;
            let supplied=body["messages"].to_string().contains("子任务B");
            if messages.iter().any(|m|m["role"]=="tool") {
                let result=tool_result(body,"probe-child-read")?;
                require(result["ok"]==true,"The readonly child did not receive its actual read result")?;
                require(result["data"]["text"]==if supplied{PREMISE}else{"原设定"},"Child draft/formal visibility crossed its assigned scope")?;
                return Ok((json!({"role":"assistant","content":format!("{}：已核对{}",if supplied{"子任务B"}else{"子任务A"},result["data"]["text"])}),"stop"));
            }
            return Ok((json!({"role":"assistant","tool_calls":[if supplied{tool("probe-child-read","read_provided_draft",json!({"index":0}))}else{tool("probe-child-read","read_resource",json!({"kind":"settings","path":"/premise"}))}]}),"tool_calls"));
        }
        let last=messages.iter().rev().find(|m|m["role"]=="tool").and_then(|m|m["tool_call_id"].as_str()).unwrap_or("");
        Ok(match last {
            ""=>(json!({"role":"assistant","tool_calls":[tool(DISCOVER_CALL,"discover_tools",json!({"names":["stage_edit","delegate_readonly"]}))]}),"tool_calls"),
            DISCOVER_CALL=>{require(tool_result(body,DISCOVER_CALL)?["ok"]==true,"Discovery failed")?;(json!({"role":"assistant","tool_calls":[tool(STAGE_CALL,"stage_edit",json!({"kind":"settings","path":"/premise","operation":"set","value":PREMISE,"summary":"准备独立设定"}))]}),"tool_calls")},
            STAGE_CALL=>{
                let result=tool_result(body,STAGE_CALL)?;require(result["ok"]==true&&result["data"]["ref"].is_object(),"Staged draft has no native ResourceRef")?;
                seen.lock().map_err(clean)?.stage_result_delivered=true;
                (json!({"role":"assistant","content":"并行核对正式设定与明确提供的草稿。","tool_calls":[tool(DELEGATE_CALL,"delegate_readonly",json!({"tasks":[{"name":"正式设定","prompt":"子任务A：只核对正式premise，不要读草稿"},{"name":"所提供草稿","prompt":"子任务B：核对明确提供的草稿premise","draftRefs":[result["data"]["ref"]]}]}))]}),"tool_calls")
            },
            DELEGATE_CALL=>{
                let result=tool_result(body,DELEGATE_CALL)?;
                require(result["ok"]==true&&result["data"]["allAnswered"]==true&&result["data"]["goalCompleted"]==false,"Delegation results were missing or incorrectly declared the root goal complete")?;
                let reports=result["data"]["reports"].as_array().ok_or("No native child reports")?;
                require(reports.len()==2&&reports.iter().all(|report|report["status"]=="answered"&&report["calls"][0]["callId"].as_str().is_some_and(|id|id.starts_with("child-"))),"Readonly child call ownership was not returned")?;
                (json!({"role":"assistant","tool_calls":[tool(COMMIT_CALL,"finish_task",json!({"summary":"两项只读核对后采用独立设定"}))]}),"tool_calls")
            },
            COMMIT_CALL=>{
                require(tool_result(body,COMMIT_CALL)?["data"]["status"]=="committed","The parent did not receive a formal receipt")?;
                seen.lock().map_err(clean)?.commit_result_delivered=true;
                (json!({"role":"assistant","content":"已核对并采用；子助手只读，未新增剧情或推进时间。"}),"stop")
            },
            _=>return Err("Unexpected root tool in child scenario".into())
        })
    }
    fn tool_result(body: &Value, call_id: &str) -> Outcome<Value> {
        let message = body["messages"]
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item["role"] == "tool" && item["tool_call_id"] == call_id)
            })
            .ok_or("Expected native tool result message is missing")?;
        let text = if let Some(text) = message["content"].as_str() {
            text.into()
        } else {
            message["content"]
                .as_array()
                .ok_or("Unexpected tool result representation")?
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        };
        serde_json::from_str(&text).map_err(|_| "Native tool result is not structured JSON".into())
    }
    fn http_error(socket: &mut TcpStream) -> std::io::Result<()> {
        // Deliberately 400: a broken fixture is not a retryable model service.
        let body="{\"error\":{\"message\":\"Owned fixture rejected the request\",\"type\":\"fixture_invalid\"}}";
        write!(socket,"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body)
    }

    #[derive(Default)]
    struct Execution {
        process: Option<NodeProcess>,
        host: Option<PiTaskHost>,
    }

    fn initial_state() -> Value {
        json!({"version":2,"time":{"start":"第一天","elapsedMinutes":0,"startHour":8},"placeId":null,
            "protagonist":{"name":"旅人","aliases":[],"age":20,"gender":"男","identity":"行旅","origin":"现代","cheat":"","stats":{"money":10,"debt":0,"health":100,"energy":100,"fame":0},"statuses":[],"items":[]},
            "people":[],"places":[],"cards":[],"goals":[],"facts":[],"era":{"packId":null,"mode":"free","clockStyle":"elapsed"},"deviations":[]})
    }

    async fn perform(
        options: &Options,
        mock: &Mock,
        execution: &mut Execution,
        report: &mut Value,
    ) -> Outcome<()> {
        let database = options.output.join("database");
        let sql = SqlStore::open(database).map_err(|error| clean(error.message))?;
        let store = sql.shared();
        {
            let db = store.lock().map_err(clean)?;
            db.execute("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('probe-world','独立Pi端到端故事','free','probe-line',?,'test','test','test')",[json!({"premise":"原设定","autoUpkeep":false,"chapterEvery":0}).to_string()]).map_err(clean)?;
            db.execute_batch("INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('probe-opening','probe-world',0,'opening','保留的独立开场正文','test');INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('probe-line','probe-world','主线','probe-opening','test')").map_err(clean)?;
            db.execute(
                "INSERT INTO states(node_id,state_json) VALUES('probe-opening',?)",
                [initial_state().to_string()],
            )
            .map_err(clean)?;
        }
        let gateway = StoryToolGateway::new(store.clone());
        gateway
            .create_session(&NewSession {
                id: "probe-session".into(),
                world_id: "probe-world".into(),
                line_id: "probe-line".into(),
                title: "独立Pi端到端助手".into(),
                session_file: None,
            })
            .map_err(clean)?;
        gateway.start_task("probe-session","probe-task","仅把本局premise改为指定独立设定，采用后说明；不要新增正文或推进时间。","auto-reversible",false,
            json!({"model":"owned-pi-gateway-probe","protocol":"chat-completions","inputTokens":12000,"contextWindowTokens":20000,"maxOutputTokens":1024}),json!({"fixtureOnly":true})).map_err(clean)?;
        let permit = gateway.permit("probe-task").map_err(clean)?;
        let session_directory = options.output.join("pi-session");
        fs::create_dir(&session_directory).map_err(clean)?;
        let (process, incoming) = NodeProcess::spawn(NodeLaunch {
            node_executable: options.node.clone(),
            runtime_directory: options.runtime.clone(),
            working_directory: session_directory.clone(),
            transport: TransportOptions::default(),
        })
        .await
        .map_err(clean)?;
        report["nodeProcessId"] = json!(process.process_id());
        let connection = process.connection();
        execution.process = Some(process);
        let model = json!({"id":"owned-pi-gateway-probe","protocol":"chat-completions","baseUrl":format!("http://127.0.0.1:{}/v1",mock.port),"apiKey":FROZEN_KEY,"inputTokens":12000,"contextWindowTokens":20000,"maxOutputTokens":1024});
        let mut fresh_model = model.clone();
        fresh_model["apiKey"] = OWNED_KEY.into();
        let resolver: story_core::pi_service::ModelResolver = Arc::new(move |_| Ok(fresh_model.clone()));
        let native_http = crate::native_model_http::host(Arc::new(|| Ok(reqwest::Client::builder().no_proxy())), resolver);
        let host = PiTaskHost::attach_with_capabilities(connection, incoming, gateway.clone(), permit, None, Some(native_http)).map_err(clean)?;
        execution.host = Some(host.clone());
        let inspected=host.create(PiTaskConfig{directory:session_directory,model,constraints:"只操作独立夹具；采用策略自动可撤回。".into()}).await.map_err(clean)?;
        report["piUpstream"] = inspected["upstream"].clone();
        require(
            inspected["inputBudgetTokens"] == 12000
                && inspected["modelContextWindowTokens"] == 20000
                && inspected["outputReserveTokens"] == 1024,
            "Pi did not apply the explicitly seeded model budgets",
        )?;
        report["budget"] = json!({"inputTokens":inspected["inputBudgetTokens"],"configuredWindowTokens":inspected["modelContextWindowTokens"],"outputTokens":inspected["outputReserveTokens"]});
        let response = host.prompt().await.map_err(clean)?;
        report["taskReceipt"] = response["taskReceipt"].clone();
        report["assistantAnswer"] = response["answer"].clone();
        require(
            response["taskReceipt"]["status"] == "committed",
            "Pi ended without a native committed task receipt",
        )?;
        require(
            response["taskReceipt"]["result"]["recoveryId"].is_string(),
            "The reversible native result has no recovery point",
        )?;
        let db = store.lock().map_err(clean)?;
        let settings: String = db
            .query_row(
                "SELECT settings_json FROM worlds WHERE id='probe-world'",
                [],
                |r| r.get(0),
            )
            .map_err(clean)?;
        let saved: Value = serde_json::from_str(&settings).map_err(clean)?;
        let nodes: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM nodes WHERE world_id='probe-world'",
                [],
                |r| r.get(0),
            )
            .map_err(clean)?;
        let actual: String = db
            .query_row(
                "SELECT state_json FROM states WHERE node_id='probe-opening'",
                [],
                |r| r.get(0),
            )
            .map_err(clean)?;
        let actual: Value = serde_json::from_str(&actual).map_err(clean)?;
        let calls: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM pi_calls WHERE task_id='probe-task' AND status='done'",
                [],
                |r| r.get(0),
            )
            .map_err(clean)?;
        let row: String = db
            .query_row(
                "SELECT result_json FROM pi_tasks WHERE id='probe-task'",
                [],
                |r| r.get(0),
            )
            .map_err(clean)?;
        let row: Value = serde_json::from_str(&row).map_err(clean)?;
        require(
            saved["premise"] == PREMISE,
            "The formal story premise did not change",
        )?;
        require(
            nodes == 1 && actual == initial_state(),
            "The settings task created story text or changed time/state",
        )?;
        require(
            calls == if options.children{6}else{3} && row == response["taskReceipt"]["result"],
            "The native receipt differs from SQLite or its paired tool results",
        )?;
        report["formalVerification"] = json!({"premise":saved["premise"],"nodeCount":nodes,"stateUnchanged":true,"elapsedMinutes":actual["time"]["elapsedMinutes"],"completedCalls":calls,"receiptMatchesSqlite":true});
        let (model_count, reported_count, input, output): (i64,i64,i64,i64) = db.query_row("SELECT COUNT(*),COALESCE(SUM(status='success' AND json_type(usage_json,'$.input')='integer' AND json_type(usage_json,'$.output')='integer'),0),COALESCE(SUM(json_extract(usage_json,'$.input')),0),COALESCE(SUM(json_extract(usage_json,'$.output')),0) FROM pi_model_requests WHERE task_id='probe-task'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(clean)?;
        report["nativeModelAccounting"] = json!({"requests":model_count,"reported":reported_count,"input":input,"output":output,"freshCredentialRequired":true});
        let expected=if options.children{9}else{4};
        require(model_count==expected && reported_count==expected && input==expected*10 && output==expected*2,"Native model request ledger or Pi usage does not match the mock responses")?;
        if options.children {
            let (children,subrequests):(i64,i64)=db.query_row("SELECT (SELECT COUNT(*) FROM pi_children WHERE task_id='probe-task' AND status='answered'),(SELECT COUNT(*) FROM pi_model_requests WHERE task_id='probe-task' AND source='subagent')",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(clean)?;
            require(children==2&&subrequests==4,"Child sessions were not charged to the root native ledger")?;
            report["readonlyChildren"]=json!({"answered":children,"modelRequests":subrequests,"formalAndProvidedDraftIsolated":true,"rootGoalNotAutomaticallyCompleted":true});
            let(candidates,accepted):(i64,i64)=db.query_row("SELECT (SELECT COUNT(*) FROM pi_tool_deliveries WHERE task_id='probe-task'),(SELECT COUNT(*) FROM pi_context_deliveries WHERE task_id='probe-task' AND status='accepted')",[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(clean)?;
            require(candidates==2&&accepted==2,"The actual model-window tool delivery hashes were not confirmed by the native request ledger")?;
            report["modelWindowDeliveries"]=json!({"candidates":candidates,"accepted":accepted,"sourceKinds":["world","draft"],"canonVerified":false});
        }
        Ok(())
    }

    fn exit_value(exit: &ProcessExit) -> Value {
        json!({"code":exit.code,"success":exit.success,"forced":exit.forced,"abortConfirmed":exit.abort_confirmed,"sessionCloseConfirmed":exit.session_close_confirmed})
    }
    async fn cleanup(execution: &mut Execution, report: &mut Value) -> Outcome<()> {
        let mut failures = Vec::new();
        if let Some(host) = execution.host.take() {
            match tokio::time::timeout(Duration::from_secs(20), host.shutdown()).await {
                Ok(Ok(())) => report["taskHostShutdownConfirmed"] = true.into(),
                Ok(Err(error)) => failures.push(clean(error)),
                Err(_) => failures.push("Task host shutdown timed out".into()),
            }
        }
        if let Some(mut process) = execution.process.take() {
            match tokio::time::timeout(Duration::from_secs(10), process.wait()).await {
                Ok(Ok(exit)) => {
                    report["processExit"] = exit_value(&exit);
                    if !exit.success {
                        failures.push("Owned Node process exited with a failure".into());
                    }
                }
                _ => match process.shutdown(Duration::from_secs(3)).await {
                    Ok(exit) => {
                        report["processExit"] = exit_value(&exit);
                        failures.push("Owned Node needed explicit fallback shutdown".into());
                    }
                    Err(error) => {
                        report["processExit"] =
                            json!({"confirmed":false,"forced":true,"dropKillsOwnedProcess":true});
                        failures.push(clean(error));
                    }
                },
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn contains_owned_key(directory: &Path) -> Outcome<bool> {
        if !directory.exists() {
            return Ok(false);
        }
        for entry in fs::read_dir(directory).map_err(clean)? {
            let path = entry.map_err(clean)?.path();
            let metadata = fs::symlink_metadata(&path).map_err(clean)?;
            require(
                !metadata.file_type().is_symlink(),
                "Unexpected symbolic link in owned probe output",
            )?;
            if metadata.is_dir() {
                if contains_owned_key(&path)? {
                    return Ok(true);
                }
            } else if metadata.is_file() {
                let bytes = fs::read(&path).map_err(clean)?;
                if [OWNED_KEY,FROZEN_KEY].iter().any(|key| bytes.windows(key.len()).any(|part| part == key.as_bytes()))
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    fn save_result(directory: &Path, report: &Value) -> Outcome<()> {
        let temporary = directory.join("result.json.tmp");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(clean)?;
        serde_json::to_writer_pretty(&mut file, report).map_err(clean)?;
        file.write_all(b"\n").map_err(clean)?;
        file.sync_all().map_err(clean)?;
        fs::rename(temporary, directory.join("result.json")).map_err(clean)
    }

    pub async fn run() -> Outcome<()> {
        let options = Options::parse()?;
        fs::create_dir(&options.output).map_err(clean)?;
        let started = Instant::now();
        let mut report = json!({"startedAt":Utc::now().to_rfc3339(),"ok":false,"fixtureOnly":true,"realRequests":0,
            "paths":{"node":options.node,"runtime":options.runtime,"output":options.output,
                "database":options.output.join("database/game.sqlite"),"sessionDirectory":options.output.join("pi-session"),"requestLedger":options.output.join("mock-ledger.jsonl")},"processExit":null});
        let mut failures = Vec::new();
        let mut execution = Execution::default();
        report["scenario"]=if options.children{"children"}else{"basic"}.into();
        match Mock::start(&options.output,options.children) {
            Ok(mut mock) => {
                match tokio::time::timeout(
                    Duration::from_secs(90),
                    perform(&options, &mock, &mut execution, &mut report),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => failures.push(error),
                    Err(_) => failures.push("The bounded four-round probe timed out".into()),
                }
                if let Err(error) = cleanup(&mut execution, &mut report).await {
                    failures.push(error);
                }
                mock.close();
                let snapshot = mock.snapshot();
                report["mock"] = snapshot.clone();
                report["modelRequests"] = snapshot["modelRequests"].clone();
                report["mockRequests"] = snapshot["mockRequests"].clone();
                if snapshot["modelRequests"] != if options.children{9}else{4}
                    || snapshot["stageResultDelivered"] != true
                    || snapshot["commitResultDelivered"] != true
                    || snapshot["failures"]
                        .as_array()
                        .is_some_and(|v| !v.is_empty())
                {
                    failures.push("The fixed four-request sequence or actual tool result delivery did not pass".into());
                }
            }
            Err(error) => {
                failures.push(error);
                report["modelRequests"] = 0.into();
                report["mockRequests"] = 0.into();
            }
        }
        match (
            contains_owned_key(&options.output.join("database")),
            contains_owned_key(&options.output.join("pi-session")),
        ) {
            (Ok(false), Ok(false)) => report["fakeCredentialNotPersisted"] = true.into(),
            (Ok(_), Ok(_)) => {
                report["fakeCredentialNotPersisted"] = false.into();
                failures.push("The owned fake credential appeared in persisted data".into());
            }
            _ => failures.push("Persisted credential check could not complete".into()),
        }
        report["failures"] = json!(failures);
        report["ok"] = failures.is_empty().into();
        report["elapsedMs"] = json!(started.elapsed().as_millis());
        report["finishedAt"] = Utc::now().to_rfc3339().into();
        save_result(&options.output, &report)?;
        println!(
            "{}",
            json!({"ok":report["ok"],"modelRequests":report["modelRequests"],"realRequests":0,"result":options.output.join("result.json")})
        );
        if failures.is_empty() {
            Ok(())
        } else {
            Err("Owned Pi gateway probe failed; inspect its isolated result.json and request ledger".into())
        }
    }
}
