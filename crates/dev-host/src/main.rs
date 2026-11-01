//! Resident local development host. The only transport is stdin/stdout NDJSON;
//! model execution is independent of the browser that submitted the run.
mod model;
mod pi_agent;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use story_core::{
    runtime::Engine,
    sql::{SqlStore, Statement},
    RunPlan,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const MAX_LINE: usize = 96 * 1024 * 1024;

#[derive(Deserialize)]
struct Request {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

struct Host {
    sql: Arc<SqlStore>,
    engine: Arc<Engine>,
    pi: Arc<pi_agent::PiAgent>,
}

fn invalid(message: &str) -> Value {
    json!({"code":"dev_host_invalid","message":message})
}
fn core_error(error: story_core::Error) -> Value {
    let code = match &error {
        story_core::Error::Stale => "execution_stale",
        story_core::Error::Cancelled => "execution_cancelled",
        story_core::Error::Limit(_) => "execution_limit",
        _ => "execution_failed",
    };
    json!({"code":code,"message":error.to_string()})
}
fn sql_error(error: story_core::error::PlatformError) -> Value {
    json!({"code":error.code,"message":error.message})
}
fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str, Value> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("请求参数不完整"))
}

impl Host {
    async fn dispatch(self: Arc<Self>, method: String, params: Value) -> Result<Value, Value> {
        match method.as_str() {
            "pi_agent" => {
                self.pi
                    .request(params.get("request").unwrap_or(&params).clone())
                    .await
            }
            "agent" => self
                .engine
                .agent_request(params.get("request").unwrap_or(&params).clone())
                .await
                .map_err(core_error),
            "context" => story_core::writing_context::build(&params["input"]).map_err(core_error),
            "settle" => story_core::rules::apply_record(
                &params["state"],
                &params["record"],
                &params["options"],
            )
            .map_err(|e| invalid(&e)),
            "start" => {
                let plan: RunPlan =
                    serde_json::from_value(params.get("plan").unwrap_or(&params).clone())
                        .map_err(|_| invalid("运行参数不完整"))?;
                self.engine
                    .start(plan)
                    .map(|id| json!(id))
                    .map_err(core_error)
            }
            "snapshot" => self
                .engine
                .snapshot(
                    required(&params, "id")?,
                    params["after"].as_u64().unwrap_or(0),
                )
                .and_then(|s| serde_json::to_value(s).map_err(Into::into))
                .map_err(core_error),
            "list" => {
                self.engine.store.initialize().map_err(core_error)?;
                self.engine
                    .store
                    .list()
                    .and_then(|rows| serde_json::to_value(rows).map_err(Into::into))
                    .map_err(core_error)
            }
            "stop" => self
                .engine
                .stop(required(&params, "id")?)
                .map(|_| Value::Null)
                .map_err(core_error),
            "resume" => self
                .engine
                .resume(required(&params, "id")?)
                .map(|_| Value::Null)
                .map_err(core_error),
            "sqlRestore"=>{
                let shared=self.sql.shared();self.sql.fence_writes();let ticket=story_core::maintenance::begin(&shared).map_err(core_error)?;
                let result=async {
                    for request in story_core::maintenance::pending_stops(&shared).map_err(core_error)?{self.pi.request(request).await?;}
                    self.engine.shutdown().await;
                    tokio::time::timeout(std::time::Duration::from_secs(30),async{loop{if story_core::maintenance::drained(&shared).map_err(core_error)?{break;}tokio::time::sleep(std::time::Duration::from_millis(50)).await;}Ok::<_,Value>(())}).await.map_err(|_|invalid("执行尚未停止，未恢复存档"))??;
                    self.pi.retire().await?;
                    let sql=self.sql.clone();let name=required(&params,"name")?.to_owned();let token=ticket.clone();tokio::task::spawn_blocking(move||sql.restore_managed(&name,&token).map(|v|json!(v)).map_err(sql_error)).await.map_err(|_|invalid("恢复尚未完成"))?
                }.await;
                let _=story_core::maintenance::end(&shared,&ticket);result
            }
            _ => {
                // SQLite and filesystem work never block the RPC reader or a
                // model future. The shared connection lock stays inside SQL.
                let issued=self.sql.generation();
                tokio::task::spawn_blocking(move || self.sql_call(&method, &params,issued))
                    .await
                    .map_err(|_| invalid("开发宿主操作未完成"))?
            }
        }
    }

    fn sql_call(&self, method: &str, params: &Value,issued:u64) -> Result<Value, Value> {
        match method {
            "status" => self
                .sql
                .is_empty()
                .map(|empty| json!({"empty":empty,"transport":"stdio","version":1}))
                .map_err(sql_error),
            "importLegacy" => {
                let encoded = required(params, "bytesBase64")?;
                if encoded.len() > MAX_LINE {
                    return Err(invalid("旧开发台数据库超过导入上限"));
                }
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|_| invalid("旧开发台数据库编码无效"))?;
                if bytes.len() > 64 * 1024 * 1024 {
                    return Err(invalid("旧开发台数据库超过 64 MiB 导入上限"));
                }
                self.sql
                    .import_legacy(&bytes)
                    .map(|imported| json!({"imported":imported}))
                    .map_err(sql_error)
            }
            "sqlQuery" => {
                let statement = required(params, "sql")?;
                let args = params
                    .get("params")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                self.sql
                    .query_at(issued,statement, args)
                    .map(|rows| json!(rows))
                    .map_err(sql_error)
            }
            "sqlBatch" => {
                let statements = params
                    .get("statements")
                    .and_then(Value::as_array)
                    .ok_or_else(|| invalid("缺少批量语句"))?;
                let statements = statements
                    .iter()
                    .map(|s| {
                        Ok(Statement {
                            sql: required(s, "sql")?.into(),
                            params: s
                                .get("params")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default(),
                        })
                    })
                    .collect::<Result<Vec<_>, Value>>()?;
                self.sql
                    .batch_at(issued,statements)
                    .map(|_| Value::Null)
                    .map_err(sql_error)
            }
            "sqlBackup" => self
                .sql
                .backup(required(params, "label")?)
                .map(|name| json!(name))
                .map_err(sql_error),
            "sqlListBackups" => self
                .sql
                .list_backups()
                .map(|items| json!(items))
                .map_err(sql_error),
            // Restore checks running work while holding the shared SQL lock.
            "sqlRestore" => self
                .sql
                .restore(required(params, "name")?)
                .map(|name| json!(name))
                .map_err(sql_error),
            _ => Err(invalid("未知开发宿主接口")),
        }
    }
}

#[tokio::main]
async fn main() {
    // These environment values contain paths, never model credentials.
    let root = std::env::var_os("LISHI_DEV_ROOT")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let root = if root.is_absolute() {
        root
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(root)
    };
    let directory = std::env::var_os("LISHI_DEV_DATABASE_DIR")
        .map(PathBuf::from)
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or_else(|| root.join(".cache/dev-host"));
    let sql = match SqlStore::open(directory.clone()) {
        Ok(sql) => Arc::new(sql),
        Err(_) => {
            eprintln!("开发宿主无法打开数据库");
            std::process::exit(1);
        }
    };
    let secrets = std::env::var_os("LISHI_DEV_SECRETS_FILE")
        .map(PathBuf::from)
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or_else(|| root.join(".cache/dev-secrets.json"));
    let pi = Arc::new(pi_agent::PiAgent::new(
        sql.shared(),
        root,
        directory,
        secrets.clone(),
    ));
    let engine = Arc::new(Engine::new(
        sql.shared(),
        Arc::new(model::DevModel { secrets }),
        Arc::new(|_| Box::new(())),
        Arc::new(|_| {}),
    ));
    if engine.recover_on_start().is_err() {
        eprintln!("开发宿主无法读取运行进度");
        std::process::exit(1);
    }
    let host = Arc::new(Host { sql, engine, pi });
    let (sender, mut responses) = tokio::sync::mpsc::channel::<Value>(32);
    let writer = tokio::spawn(async move {
        let mut output = tokio::io::stdout();
        while let Some(response) = responses.recv().await {
            let Ok(mut line) = serde_json::to_vec(&response) else {
                continue;
            };
            line.push(b'\n');
            if output.write_all(&line).await.is_err() || output.flush().await.is_err() {
                break;
            }
        }
    });
    let mut input = BufReader::new(tokio::io::stdin());
    let mut line = Vec::new();
    loop {
        line.clear();
        match input.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) if line.len() > MAX_LINE => {
                let _ = sender
                    .send(json!({"id":null,"error":invalid("请求内容过大")}))
                    .await;
                continue;
            }
            Ok(_) => {}
        }
        let request: Request = match serde_json::from_slice(&line) {
            Ok(value) => value,
            Err(_) => {
                let _ = sender
                    .send(json!({"id":null,"error":invalid("请求格式无效")}))
                    .await;
                continue;
            }
        };
        let host = host.clone();
        let sender = sender.clone();
        tokio::spawn(async move {
            let response = match host.dispatch(request.method, request.params).await {
                Ok(result) => json!({"id":request.id,"result":result}),
                Err(error) => json!({"id":request.id,"error":error}),
            };
            let _ = sender.send(response).await;
        });
    }
    // Vite closing ends this process; page disconnection never reaches here.
    host.pi.shutdown().await;
    host.engine.shutdown().await;
    drop(sender);
    writer.abort();
}
