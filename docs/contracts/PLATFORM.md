# 平台服务契约（Rust ↔ TypeScript）

> 版本 1，2026-10-16（Asia/Shanghai）。对应 [PLAN_V3](../PLAN_V3.md) 第 7.3、7.4 节与任务 R01-T003。本文规定 Tauri 命令的名字、参数和返回值；TypeScript 侧 `src/platform/tauri.ts` 与浏览器开发台 `src/platform/web.ts` 都必须遵守同一语义。

## 0. 总原则

- Rust 只做**平台服务**：存储、密钥、网络传输、文件、系统事件。不包含任何游戏规则、提示词或模型输出解析。
- **不加额外的审计、预留、诊断白名单等机制**。只做必要的边界保护：大小上限、超时、Key 不外泄。
- 所有命令出错时返回 `{ code: string, message: string }`，`message` 用简短中文，可以直接给开发者看；不得包含 Key、认证头或完整请求体。
- 参数在 JS 侧用 camelCase；Rust 用 `#[serde(rename_all = "camelCase")]`。
- 所有可能阻塞的工作（SQLite、文件）放到 `spawn_blocking`，不阻塞 IPC 线程。

## 1. SQL 桥

数据库文件：应用数据目录下 `game.sqlite`，开启 WAL、`foreign_keys=ON`、`busy_timeout=5000`。只有一个连接，由互斥锁保护。

### `sql_query`

- 参数：`{ sql: string, params: JsonValue[] }`
- 返回：`Row[]`，每行是 `{ 列名: 值 }` 对象。
- 值映射：SQLite NULL ↔ `null`；INTEGER ↔ number（超出 ±2^53−1 时报错 `sql_integer_range`）；REAL ↔ number；TEXT ↔ string；BLOB 不支持（报错 `sql_blob_unsupported`）。参数里的 `true/false` 存为 1/0；对象或数组参数报错 `sql_param_type`。
- 可以执行任意单条语句（SELECT 或写语句均可）。写语句返回空数组。

### `sql_batch`

- 参数：`{ statements: { sql: string, params: JsonValue[] }[] }`
- 行为：在**一个事务**内依次执行；任一失败则整体回滚并返回错误 `sql_failed`（message 中可带 SQLite 错误文本，不含参数值）。
- 返回：`null`。
- 用途：迁移脚本（一条语句可以包含多条 SQL，用 `execute_batch` 执行，此时 `params` 必须为空）、写入回合节点。

### `sql_backup`

- 参数：`{ label: string }`（`[a-z0-9_-]{1,40}`）
- 行为：用 SQLite 在线备份 API 复制到应用数据目录 `backups/<时间戳>-<label>.sqlite`；只保留最近 20 份。
- 返回：备份文件名（不含路径）。

### `sql_list_backups`

- 返回：`{ name: string, at: string(ISO 8601), size: number }[]`，按时间倒序。

## 2. 密钥

槽位名 `slot`：`[a-z0-9_-]{1,64}`。

### `secret_set`

- 参数：`{ slot: string, value: string, boundBaseUrl: string }`
- 行为：用平台加密存储保存 `value`（Android Keystore / Windows DPAPI，复用 v2 实现，命名空间改为 `io.timejump.chuanyue.secret.v1`）；同时把 `boundBaseUrl` 记录在应用数据目录的普通 JSON 中（不是秘密）。`value` 不得含空白或控制字符，长度 1～4096。`boundBaseUrl` 必须是 `https://` 或 `http://` 开头的绝对地址，不含用户名、密码、查询参数和片段；保存前去掉末尾的 `/`。
- 返回：`null`。

### `secret_has`

- 参数：`{ slot: string }` → 返回 `{ configured: boolean, boundBaseUrl: string | null }`。

### `secret_remove`

- 参数：`{ slot: string }` → 返回 `null`；槽位不存在也算成功。

**不提供任何读取明文的命令。**

## 3. 模型请求

### 地址绑定规则

请求的 `url` 必须以该 `slot` 的 `boundBaseUrl` 开头，且紧接着是字符串结尾、`/` 或 `?`。不满足则报错 `llm_url_not_bound`，不发出请求。

### `llm_stream`

- 参数：
  ```ts
  {
    slot: string;
    url: string;
    body: object;              // 原样序列化为 JSON 请求体
    timeouts: { firstByteMs: number; idleMs: number; totalMs: number };
    onEvent: Channel<StreamEvent>;
  }
  ```
- 返回：`streamId: string`（随机，`[a-z0-9]{16,}`），在发出请求前就返回，之后通过 `onEvent` 推送事件。
- 请求：`POST url`，头部 `Authorization: Bearer <key>`、`Content-Type: application/json`、`Accept: text/event-stream`。不跟随重定向（3xx 当作 HTTP 错误）。HTTP 证书校验沿用 v2 的系统证书方案（Android 需先初始化）。
- 事件类型：
  ```ts
  type StreamEvent =
    | { type: "open"; status: number }               // 收到 2xx 响应头
    | { type: "data"; data: string }                 // 一行 SSE 的 data 内容（去掉 "data:" 前缀与首个空格），原样转发，不解析 JSON
    | { type: "done" }                               // 正常结束：收到 data 为 "[DONE]" 的行（该行不再以 data 事件转发），或连接正常关闭
    | { type: "error"; kind: ErrorKind; status?: number; message?: string };
  type ErrorKind = "network" | "timeout_first" | "timeout_idle" | "timeout_total"
                 | "http" | "cancelled" | "too_large" | "secret_echo" | "url_not_bound" | "no_secret";
  ```
- SSE 解析只做到“按行切分”：以 `\n` 或 `\r\n` 分行；`data:` 行转发；空行、`:` 开头的注释行、`event:`、`id:`、`retry:` 行忽略；同一事件多条 `data:` 行各自单独转发。**不检查 JSON 内容、不维护字段白名单。** 不合法的 UTF-8 用替换字符处理，不报错。
- 若响应 `Content-Type` 不是 `text/event-stream`（有的中转忽略流式参数），把完整响应体作为**一个** `data` 事件转发，然后发 `done`。
- 非 2xx：读取至多 8 KiB 响应体，发 `{type:"error", kind:"http", status, message}`（message 中出现 Key 时替换为 `***`）。
- 超时：`firstByteMs` 从发出请求到收到第一个响应体字节；`idleMs` 为任意两次收到字节的间隔；`totalMs` 为整次请求。
- 上限：单次响应体累计不超过 4 MiB，超出报 `too_large` 并断开。
- Key 回显：任何 `data` 内容包含 Key 原文时，不转发该行，报 `secret_echo` 并断开。
- **流缓存**：每个 `streamId` 在应用缓存目录 `streams/<streamId>.jsonl` 追加记录：每个事件一行 JSON（与 `StreamEvent` 相同结构，`open/data/done/error`）。这样在 Android 后台暂停 JS、甚至进程被杀后，界面可以补齐。
- 结束后保留缓存文件，直到 `llm_stream_ack` 删除。

### `llm_cancel`

- 参数：`{ streamId: string }`。停止请求，发 `{type:"error", kind:"cancelled"}` 并写入缓存。对已结束的流无副作用。

### `llm_stream_resume`

- 参数：`{ streamId: string }`
- 返回：`{ events: StreamEvent[]; active: boolean } | null`。`events` 为缓存中的全部事件（按顺序）；`active` 表示该流在本进程中仍在进行。文件不存在返回 `null`。
- 若进程重启后发现缓存文件最后一条不是 `done/error` 且该流不在进行中，返回的 `events` 末尾**追加**一条 `{type:"error", kind:"network", message:"interrupted"}`（同时写入文件），表示已中断。

### `llm_stream_list`

- 返回：缓存目录中所有 `streamId` 及是否已结束：`{ streamId: string; finished: boolean; active: boolean }[]`。

### `llm_stream_ack`

- 参数：`{ streamId: string }`。删除缓存文件（流仍在进行时先取消）。

### `llm_get`

- 参数：`{ slot: string; url: string; timeoutMs: number }`（地址绑定规则同上）
- 返回：`{ status: number; body: string }`，body 至多 1 MiB（超出截断）。用于 `GET /models`。不跟随重定向。

## 4. 文件

### `file_export_text`

- 参数：`{ suggestedName: string; text: string }`
- 行为：Windows 用系统保存对话框；Android 用系统文档创建（`ACTION_CREATE_DOCUMENT`，复用 v2 文档选择器的思路）。用户取消返回 `false`。
- 返回：`boolean`。

### `file_import_text`

- 行为：Windows 系统打开对话框；Android 系统文档选择器（复用 v2 `DocumentPickerPlugin` + `RustFileAccessBridge`）。文件不超过 64 MiB，按 UTF-8 解码（失败报错 `file_not_utf8`）。用户取消返回 `null`。
- 返回：`string | null`。

## 5. 系统

- 返回键：前端使用 `@tauri-apps/api/app` 的 `onBackButtonPress`。Rust 侧只需在 capabilities 中加入所需权限（`core:app:default` 及注册/移除监听、`exit` 所需权限）。
- 平台名：`platform_info` 返回 `{ platform: "android" | "windows" | "other", appVersion: string }`。
- 前后台：前端使用 `document.visibilitychange`，不需要 Rust 命令。

## 6. 浏览器开发台的对应实现

`src/platform/web.ts` 用相同语义实现：`sql` 用 sql.js（IndexedDB 持久化）；`secret_*` 与 `llm_*` 通过 Vite 开发服务器中间件 `/__dev/*` 完成（Key 存在本机 `.cache/dev-secrets.json`，中间件只监听 127.0.0.1，按 slot 注入 Key、按行转发 SSE）；`file_*` 用浏览器下载与文件选择。流缓存在开发台中用内存实现。
