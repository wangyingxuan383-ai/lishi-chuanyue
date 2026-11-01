# 单 APK 原生运行验证

这是独立测试应用，不是玩家界面，也不替换正式应用。包名为 `io.timejump.chuanyue.piprobe`，最低 Android API 24、目标 API 36。测试只操作自身私有目录，不连接正式故事数据库，不读取用户服务配置。

该应用在独立 `:agent` 前台服务进程中装载 JNI Node 运行库、完整固定版 Pi 宿主，以及独立 Rust JNI 工具网关。Node 与服务经私有 `socketpair` 交换消息。模型服务器是同一应用内的本机回环固定响应，仅用于验证，不代表产品依赖本机 HTTP 服务。

## 构建

先按相邻 `android-node` 目录说明构建并验证 Node／JNI 运行库，再按 `agent-host` 说明组装完整 Pi 分发。准备一个忽略的原生产物目录，其 `arm64-v8a/` 包含 `libnode.so`、`liblishi_node_embed.so` 和 `libc++_shared.so`。在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File runtime/android-probe/Build-Probe.ps1 -NativeDirectory <原生产物目录> -NativeNoticesDirectory <原生来源与许可目录>
```

脚本用固定依赖离线交叉编译独立 Rust JNI 网关，生成仅供本机 HTTPS 检查的短期证书到忽略缓存，然后用固定 Gradle 组装 APK。测试私钥、证书、运行库及构建结果不进入 Git。`-PrepareOnly` 仅准备网关和证书，不需要完整运行库。

原生运行库的来源、版本和许可目录随包进入 `assets/native-notices/`；缺少该目录时不能组装 APK。JDK 的本地 socket 临时目录仅通过当前 Gradle 进程的环境指定到自有构建缓存，结束后恢复原环境，不修改系统临时目录。

## 检查范围

带 `run=true` 启动测试 Activity 后，前台服务运行一次固定检查，并将 `probe-result.json` 写到本应用 `files/`：

- 实际 Worker 消息往返；实际加载随包 Photon WASM 并读取一个像素。
- 自有 localhost HTTPS 的证书验证，以及自有 HTTP CONNECT 隧道内的 TLS 读写。这只验证 Node 底层能力，不证明 Pi 模型请求已接入应用代理配置，也不证明所有外部服务、代理或系统证书均兼容。
- 完整 Pi 创建会话，读取 Rust 资料、获得具体业务错误，并准备独立草稿。
- 原文、资源定位和错误确实进入下一次模拟模型请求。
- 保存并重开 Pi 会话后，工具结果仍可读取；流式请求可以取消。
- 测试凭据不写入 Pi 会话。只检查本次固定测试凭据，不宣称替代正式凭据安全验收。

全部成功为 5 次模拟请求、0 次真实模型请求。失败报告记录实际已发请求数，不能把预期次数当成已执行。报告包含 Node 创建耗时、服务进程 ID 和 `VmHWM`；冷启动、内存、16KiB 和 API24 均须以目标设备实际结果为准。独立 Rust 草稿不等于正式故事事务已经迁移。

本机模拟服务在返回每次响应前，将本次请求序号同步写入自有运行目录的 `mock-ledger.jsonl`，不记录认证头。即使原生进程崩溃、来不及写最终报告，也可从账本恢复已经接收的模拟请求数。

每轮必须从新的测试应用进程开始；不能只停止并重启服务。Node 和 Rust 网关均为本进程一次初始化。启动新检查时会清除旧聚合报告，各次运行目录中的结果仍保留。只有全部检查完成、Node 线程退出且退出码为 0，最终报告才可为成功。

不在本目录提供自动安装、清空数据或操作个人故事的命令。正式应用切换前仍须单独完成备份和验收。
