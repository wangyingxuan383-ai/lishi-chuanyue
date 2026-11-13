//! Real MCP SDK client/server over an in-process byte duplex. No listening
//! socket, external process, model key or user-provided executable is involved.
use crate::{tools, Error, Result};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ListToolsResult,
        PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig, Tool,
        ToolAnnotations,
    },
    service::{RequestContext, RunningService},
    ClientLifecycleMode, ClientServiceExt, ErrorData, RoleClient, RoleServer, ServerHandler,
    ServiceExt,
};
use serde_json::{json, Value};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

pub type DispatchFuture = Pin<Box<dyn Future<Output = Result<Value>> + Send + 'static>>;
pub type Dispatch = Arc<dyn Fn(String, Value) -> DispatchFuture + Send + Sync + 'static>;

#[derive(Clone)]
struct BuiltinServer {
    dispatch: Dispatch,
    tools: Vec<Tool>,
    definitions: Vec<tools::ToolDefinition>,
}

impl BuiltinServer {
    fn new(dispatch: Dispatch, definitions: Vec<tools::ToolDefinition>) -> Result<Self> {
        let tools = definitions
            .iter()
            .map(|definition| {
                Ok(Tool::new(
                    definition.name,
                    definition.description,
                    tools::parameter_object(&definition.parameters)?,
                )
                .with_annotations(
                    ToolAnnotations::new()
                        .read_only(definition.read_only)
                        .destructive(false)
                        .open_world(false),
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            dispatch,
            tools,
            definitions,
        })
    }
}

fn tool_error(error: impl std::fmt::Display) -> CallToolResponse {
    CallToolResult::structured_error(json!({"isError":true,"message":error.to_string()})).into()
}

impl ServerHandler for BuiltinServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("工具只操作绑定的本次运行；正文与状态最终由核心事务校验。原著资料必须读原文或明确资料不足。")
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: self.tools.clone(),
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        let arguments = Value::Object(request.arguments.unwrap_or_default());
        if let Err(error) = tools::validate_with(&self.definitions, &request.name, &arguments) {
            return Ok(tool_error(error));
        }
        let future = (self.dispatch)(request.name.into_owned(), arguments);
        Ok(tokio::select! {
            biased;
            _ = context.ct.cancelled() => tool_error("工具调用已停止"),
            result = future => match result {
                Ok(value) => CallToolResult::structured(value).into(),
                Err(error) => tool_error(error),
            }
        })
    }
}

pub struct BuiltinMcp {
    client: RunningService<RoleClient, ()>,
    server: RunningService<RoleServer, BuiltinServer>,
}

impl BuiltinMcp {
    pub async fn open(dispatch: Dispatch) -> Result<Self> {
        Self::open_with(dispatch, tools::catalog()).await
    }
    pub async fn open_with(
        dispatch: Dispatch,
        definitions: Vec<tools::ToolDefinition>,
    ) -> Result<Self> {
        let (server_io, client_io) = tokio::io::duplex(64 * 1024);
        let server_task = tokio::spawn(BuiltinServer::new(dispatch, definitions)?.serve(server_io));
        // `.serve()` on a client deliberately retains the old initialize
        // lifecycle in rmcp 3.7. Explicit discovery uses the 2026 protocol.
        let client = match tokio::time::timeout(
            Duration::from_secs(5),
            ().serve_with_lifecycle(
                client_io,
                ClientLifecycleMode::Discover {
                    preferred_versions: vec![ProtocolVersion::V_2026_07_28],
                },
            ),
        )
        .await
        {
            Ok(Ok(client)) => client,
            result => {
                server_task.abort();
                return Err(Error::Invalid(match result {
                    Ok(Err(error)) => format!("内置工具连接失败：{error}"),
                    _ => "内置工具连接超时".into(),
                }));
            }
        };
        // Discovery is stateless. rmcp does not finish a duplex server's
        // startup until its first non-discover request carries inline metadata.
        // Send tools/list before awaiting the server task, or both sides wait.
        match tokio::time::timeout(Duration::from_secs(5), client.list_all_tools()).await {
            Ok(Ok(_)) => {}
            result => {
                server_task.abort();
                return Err(Error::Invalid(match result {
                    Ok(Err(error)) => format!("内置工具目录无法读取：{error}"),
                    _ => "内置工具目录读取超时".into(),
                }));
            }
        }
        let server = server_task
            .await
            .map_err(|_| Error::Invalid("内置工具服务无法启动".into()))?
            .map_err(|error| Error::Invalid(format!("内置工具服务无法启动：{error}")))?;
        Ok(Self { client, server })
    }

    pub async fn tools(&self) -> Result<Vec<Value>> {
        let tools = self.client.list_all_tools().await.map_err(protocol_error)?;
        Ok(tools.into_iter().map(|tool| json!({"type":"function","function":{
            "name":tool.name,"description":tool.description.unwrap_or_default(),"parameters":tool.input_schema,
        }})).collect())
    }

    pub async fn call(&self, name: &str, arguments: &Value) -> Result<Value> {
        let Some(arguments) = arguments.as_object() else {
            return Ok(json!({"isError":true,"message":"工具参数必须是对象"}));
        };
        let result = self
            .client
            .call_tool(
                CallToolRequestParams::new(name.to_owned()).with_arguments(arguments.clone()),
            )
            .await
            .map_err(protocol_error)?;
        let failed = result.is_error == Some(true);
        let mut value = result
            .structured_content
            .unwrap_or(serde_json::to_value(result.content)?);
        if failed {
            if let Some(object) = value.as_object_mut() {
                object.insert("isError".into(), Value::Bool(true));
            } else {
                value = json!({"isError":true,"result":value});
            }
        }
        Ok(value)
    }

    pub fn protocol_version(&self) -> Option<String> {
        self.client
            .peer_info()
            .map(|info| info.protocol_version.to_string())
    }

    /// Dropping the session also cancels both SDK services. Explicit close is
    /// useful at run end to wait for transport/request cleanup before return.
    pub async fn close(mut self) -> Result<()> {
        self.client
            .close_with_timeout(Duration::from_secs(2))
            .await
            .map_err(|_| Error::Invalid("内置工具会话关闭失败".into()))?;
        self.server
            .close_with_timeout(Duration::from_secs(2))
            .await
            .map_err(|_| Error::Invalid("内置工具服务关闭失败".into()))?;
        Ok(())
    }
}

fn protocol_error(error: impl std::fmt::Display) -> Error {
    Error::Invalid(format!("内置工具通信失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn discovers_lists_and_calls_through_the_sdk() {
        let called = Arc::new(AtomicUsize::new(0));
        let counter = called.clone();
        let dispatch: Dispatch = Arc::new(move |name, arguments| {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { Ok(json!({"tool":name,"arguments":arguments})) })
        });
        let session = BuiltinMcp::open(dispatch).await.unwrap();
        assert_eq!(session.protocol_version().as_deref(), Some("2026-07-28"));
        let definitions = session.tools().await.unwrap();
        assert_eq!(definitions.len(), 14);
        assert!(definitions
            .iter()
            .any(|tool| tool["type"] == "function" && tool["function"]["name"] == "read_original"));
        let result = session
            .call("search_original", &json!({"query":"人物的真实身份"}))
            .await
            .unwrap();
        assert_eq!(result["arguments"]["query"], "人物的真实身份");
        assert_eq!(called.load(Ordering::SeqCst), 1);
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn validation_and_business_errors_remain_visible_to_the_agent() {
        let called = Arc::new(AtomicUsize::new(0));
        let counter = called.clone();
        let dispatch: Dispatch = Arc::new(move |_, _| {
            counter.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err(Error::Invalid("没有可用原著资料".into())) })
        });
        let session = BuiltinMcp::open(dispatch).await.unwrap();
        assert_eq!(
            session
                .call("read_original", &json!({"section":-1}))
                .await
                .unwrap()["isError"],
            true
        );
        assert_eq!(
            session
                .call("read_world", &json!({"worldId":"elsewhere"}))
                .await
                .unwrap()["isError"],
            true
        );
        assert_eq!(
            session.call("unknown_tool", &json!({})).await.unwrap()["isError"],
            true
        );
        assert_eq!(called.load(Ordering::SeqCst), 0);
        let result = session.call("read_world", &json!({})).await.unwrap();
        assert_eq!(result["isError"], true);
        assert_eq!(result["message"], "没有可用原著资料");
        assert_eq!(called.load(Ordering::SeqCst), 1);
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn closing_a_session_releases_pending_dispatch_work() {
        struct OnDrop(Arc<tokio::sync::Notify>);
        impl Drop for OnDrop {
            fn drop(&mut self) {
                self.0.notify_one();
            }
        }
        let started = Arc::new(tokio::sync::Notify::new());
        let released = Arc::new(tokio::sync::Notify::new());
        let signal_started = started.clone();
        let signal_released = released.clone();
        let dispatch: Dispatch = Arc::new(move |_, _| {
            let started = signal_started.clone();
            let released = signal_released.clone();
            Box::pin(async move {
                let _release = OnDrop(released);
                started.notify_one();
                std::future::pending::<Result<Value>>().await
            })
        });
        let session = BuiltinMcp::open(dispatch).await.unwrap();
        let arguments = json!({});
        let mut call = Box::pin(session.call("read_world", &arguments));
        tokio::select! {
            result = &mut call => panic!("unexpected completed tool: {result:?}"),
            _ = started.notified() => {},
        }
        drop(call);
        session.close().await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), released.notified())
            .await
            .unwrap();
    }
}
