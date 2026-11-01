# Android Node 共享运行库

这里是独立的原生运行库构建门槛，**尚未连接正式应用，也不会安装手机应用**。

构建输入固定为 Node 24.19.0 和 Linux 版 Android NDK 28.2.13676358。Android 仍是 Node 的实验平台；源码校验、语法检查或编译成功，都不能替代完整 Pi SDK 在 APK 中的实际启动。

## 获取已校验的输入

在仓库根目录使用 Node 24.19.0 运行：

```text
node runtime/android-node/fetch-source.mjs
node runtime/android-node/fetch-source.mjs --ndk
```

第二条额外下载约722MB的Linux NDK。工具只下载和校验忽略目录中的缓存，不执行安装。Node 同时核对锁文件和官方公布的 SHA-256；NDK 的大小和 SHA-1取自 Google 官方元数据，首次核验后的实测 SHA-256也已锁定。Windows NDK 的可执行文件不能替代 WSL 中的 Linux 工具链。

应用首次启动不下载依赖，不使用 Termux 前缀、包管理器、全局配置或个人凭据。

## 准备与构建

Python 3.12及以上可以在两种宿主上核验和安全解包 Node 源码：

```text
python runtime/android-node/build.py --phase inspect
python runtime/android-node/build.py --phase prepare
```

正式编译使用 Linux／WSL2，需安装 `python3`、`build-essential`、`unzip` 和 `patch`。源码、符号链接和构建产物放在 WSL 的 ext4 文件系统，避免在 `/mnt/d` 的 NTFS 挂载中编译。下载归档可以继续复用 Windows 侧缓存：

```sh
python3 runtime/android-node/build.py --phase prepare-ndk \
  --cache-dir "$HOME/.cache/lishi-node" \
  --source-archive /mnt/d/lishi/.cache/r19/android-node/downloads/node-v24.19.0.tar.xz \
  --ndk-archive /mnt/d/lishi/.cache/r19/android-node/downloads/android-ndk-r28c-linux.zip

python3 runtime/android-node/build.py --phase build \
  --cache-dir "$HOME/.cache/lishi-node" \
  --source-archive /mnt/d/lishi/.cache/r19/android-node/downloads/node-v24.19.0.tar.xz \
  --ndk "$HOME/.cache/lishi-node/toolchains/android-ndk-r28c" --jobs 4
```

以上 `/mnt/d/lishi` 只是示例仓库位置，可替换为实际路径。也可使用 `LISHI_ANDROID_NODE_CACHE_ROOT` 指定专用构建缓存。

构建阶段只执行生成的 GYP `libnode` 目标及其依赖，产出 Release 共享运行库；不使用上游顶层默认目标附带编译的桌面 `cctest`。这不修改上游测试源码或 Android API 级别，也不替代本应用的运行验收。

长时间构建可将命令中的 `build.py --phase build` 替换为 `run-build.py`，其余缓存、源码归档、NDK和并发参数相同，另用 `--label node-build` 指定本次日志名。这个 Linux 启动器只接续构建，不删除对象、不安装应用、不自动启动 JNI 编译；它将后台进程与终端分离，并拒绝并行占用同一源码树的编译。

启动器返回本次 `runId`、`runs/<runId>.json`、进程和日志位置。记录包含 Linux boot ID、worker及子进程 PID/启动时钟、实际命令、最终退出码和校验收据。恢复时必须同时检查 boot ID 与进程启动时钟，不能只看 PID 或旧文件里的 running；电脑重启或强制终止后，保留的 running 记录不等于编译仍在继续。成功须为本次退出码0、succeeded状态及新生成且通过校验的收据，不能仅凭共享库文件存在判断。

该 Node 版本附带的旧 Android patch 与当前 V8 源码不匹配。`patches/` 中的最小补丁保留其原意，只禁用 Android trap handler；构建器严格核对修改前后哈希，不模糊套用。配置使用共享库和16KiB ELF对齐，不修改 Pi 的执行逻辑。

首次实际交叉构建还发现 zlib 已调用 `android_getCpuFeatures`，但未链接 NDK 的对应实现。第二个补丁仅在 Android 目标工具集中加入已锁定 NDK 的 `cpu-features.c`，不影响 Linux 主机工具或其他平台；原失败日志保留，后续使用已有对象增量继续。

随后 Linux 主机的 ARM64 模拟器快照工具链接缺少 trap handler：V8 按真实编译器启用 Linux host 的处理器，但 GYP 按全局 Android 目标漏选了对应源。第三个补丁只给 Linux/x64 host 补回原有 POSIX 和模拟器源，不改处理器实现，不启用 Android target 的 trap handler，也不关闭 WASM。补丁文件及修改前后 GYP 哈希均锁定，配置检查须确认只作用于 host。

静态验证会拒绝错误架构、SONAME、未打包共享依赖、不足的 LOAD 对齐和未对齐的 GNU_RELRO 结束边界；链接的最大与通常页大小均固定16KiB。输出仍标记 `runtimeTested: false`，APK加载、完整SDK和API24／16KiB环境运行必须另行实测。

## 独立 JNI 原型

`prototype/` 使用 Node 官方嵌入接口、进程内私有 UNIX socketpair和明确取消操作。Kotlin 声明没有接入正式应用的清单或构建。未来独立服务必须自己持有 Context、Rust 网关和绝对存储路径，不能依赖活动 Activity、WebView或主进程的全局 Engine。

受审宿主接受 `--transport-fd <fd>`，将描述符包装为 Node socket；Windows则使用同一宿主的标准输入输出。正常停止通过 Pi 协议取消，`abortRuntime()` 仅作原生兜底，调用后要重新创建服务进程。入口使用 Node 正常加载器，保留 ESM、Worker和WASM的相对资源路径。语法检查通过不表示原型已在手机运行。

Node 库构建并静态验证通过后，在 Linux 另装 `cmake`，使用上述相同缓存、源码归档和 NDK 参数，将 `--phase build` 改为 `--phase prototype` 即可编译链接 JNI 库。该步骤只构建原型并核验两份 ELF，不生成或安装 APK；手机启动仍单独验收。

构建、静态验证和 JNI 链接成功时，会同时向缓存的 `notices/` 导出 Node LICENSE、NDK 和 LLVM 的完整声明（包括 libc++），并保存来源归档、原文件位置和 SHA-256。也可使用相同参数单独运行 `--phase notices`，不等待编译。打包时必须携带该目录，不能只复制共享库；导出工具会拒绝被改动的上游声明或不匹配的现有文件。

## 来源与许可

- [Node源码与构建说明](https://github.com/nodejs/node/tree/v24.19.0)
- [Node嵌入接口](https://github.com/nodejs/node/blob/v24.19.0/doc/api/embedding.md)
- [Google官方NDK元数据](https://dl.google.com/android/repository/repository2-3.xml)
- [Android可执行代码限制](https://developer.android.com/about/versions/10/behavior-changes-10#execute-permission)

Node及其内含依赖保留各自的许可声明。构建产物应携带上游 Node LICENSE 和依赖声明；本目录不替应用选择许可证。
