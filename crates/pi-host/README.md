# Pi 原生传输适配

本 crate 只连接完整 Pi 宿主，不保存另一份模型上下文，不实现 Agent 循环，也不重试业务工具。故事授权、持久调用账本、修改草稿、提交和恢复由原生业务层负责。

`AgentConnection::attach` 接受独立的 `AsyncRead`／`AsyncWrite`，可连接桌面标准输入输出或 Android 私有 socketpair。协议与 `agent-host/src/entry.mjs` 相同：请求通过字符串 ID 配对，事件、工具请求和工具取消送入独立的有界接收通道，工具结果使用 `tool_result` 通知。读循环不执行工具，也不等待工具返回，所以 `prompt` 进行时仍可发送 `steer`、`abort` 和读取事件。

宿主拥有者必须持续读取 `IncomingReceiver` 并将事件持久化；它不能直接依赖当前页面是否订阅。通道满会明确以 `Backpressure` 关闭连接并使所有等待失败，不静默丢失过程记录，也不无限等待缓慢页面。输入和输出单帧最多8MiB，分片 UTF-8 与 CRLF 均支持，截断或无效记录会明确失败。

调用 `request` 的 future 被丢弃，只移除本地响应等待，不代表停止任务或撤回已经送达的命令。停止任务必须发送并等待 `abort`。`close_transport` 关闭并等待本地读写任务退出，不能当作业务停止成功。`wait_closed` 返回关闭原因。工具结果必须先在原生账本落盘，再交给 `tool_result`；连接丢失、取消或未知外部写入均不由传输层自动重放。

桌面 `NodeProcess` 在非 Android 目标编译，启动本机应用提供的 Node 路径和固定 `host/src/entry.mjs`。启动前使用共享原生校验器核对固定来源、完整文件列表及每项哈希；Android初始化复用同一校验。路径由应用提供，不能让模型指定。Pi 创建会话时继续检查完整来源、资源与 Node 版本。子进程隐藏 Windows 控制台，凭据只通过内存协议提供，不放进命令参数；清除继承环境，仅保留系统启动、临时目录和语言设置，丢弃标准错误以免输出服务内容或秘密。应用应通过结构化错误和退出结果诊断问题。

`NodeProcess::shutdown` 先请求 `abort` 与 `close`，关闭管道并等待进程退出；超时只终止自身子进程，结果标记 `forced`，分别保留协议确认状态。它不承诺撤回外部服务修改。`wait` 可独立监测已启动的进程退出。`tokio` 的 `process` 功能用于子进程管理，其 Unix 信号等待支撑带入 `signal-hook-registry`，不增加另一套执行核心。

定向检查：

```powershell
cargo test -p pi-host --test transport
```

检查使用内存双工流，覆盖并发命令、真实工具结果、错误、取消、响应等待丢弃、EOF、背压、分片和帧大小；不调用模型、不连接个人数据。该检查不等于桌面实际 Node 进程或 Android socketpair 已接入正式应用。
