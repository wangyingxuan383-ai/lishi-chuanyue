# 开发环境与命令

本文记录 M01 的实际工具和入口，不代表游戏或平台验收已完成。阶段结果见 [TASKS](TASKS.md) 与 [M01 验证记录](validation/M01.md)。工具核实日期：2026-10-12，Asia/Shanghai。

## 本机工具基线

| 工具 | 实测版本 / 位置 |
| --- | --- |
| Node / npm | 24.19.0 / 11.17.0，`C:\Program Files\nodejs` |
| pnpm | 11.25.0；版本固定于 packageManager，依赖固定于 pnpm-lock.yaml |
| Rust / Cargo | 1.99.0，用户 `.cargo/bin`；项目 rust-toolchain.toml 固定版本和两个 Android target |
| Windows C++ | VS 2022 BuildTools 17.14.37710.0，`C:\DevTools\LishiBuildTools` |
| WebView2 | 154.0.4258.62，已安装 |
| JDK | Temurin 17.0.20.1+1，`C:\Users\Windows11\AppData\Local\Programs\LishiToolchain\jdk-17.0.20.1+1` |
| Android SDK | `C:\Users\Windows11\AppData\Local\Android\Sdk` |
| Android 构建 | API 36 / Build Tools 36.0.0 / NDK 28.2.13676358 |
| Gradle / AGP | wrapper 固定 9.6.1 / root 和 buildSrc 同步固定 9.3.3 |
| 前端 / Tauri | React 19.3.0 / TypeScript 7.0.2 / Vite 8.3.4 / CLI 2.12.2 / Rust tauri 2.12.3 |
| SQLite核心 | rusqlite 0.40.2 / bundled libsqlite3-sys 0.38.2 |
| 网络核心 | reqwest 0.13.5 / Tokio 1.53.2 / tokio-util 0.7.20 / verifier 0.7.1 / Android shim 0.2.0 |
| 系统文件 | tauri-plugin-dialog 2.8.2 / tauri-plugin-fs 2.7.0 / rfd 0.16.0；Rust私有桥与sha2 0.10.9 |

JDK 从已核实的现有完整发行目录复制到独立项目工具目录，避免依赖其他项目的生命周期。MSVC/SDK 使用微软官方安装器安装；NDK 通过 Google SDK 管理器并存安装，没有删除 NDK 27。工具安装不等于原生构建通过，具体构建结果单独登记。

本机已为 Tauri 创建原生库符号链接启用 Windows 开发模式，并在普通权限下实际创建/读取链接通过。有效 Windows SDK 位于 `C:\Program Files (x86)\Windows Kits\10`，不能使用旧注册项指向的只有 Catalogs 的另一目录。

## 开发入口

在项目根目录使用 PowerShell。机器路径放在忽略的 `.private/toolchain.json`，不写入公共构建文件：

```json
{
  "javaHome": "你的 JDK 根目录",
  "androidHome": "你的 Android SDK 根目录"
}
```

```powershell
# 只设置当前进程及子进程环境，不修改系统 PATH。
. .\scripts\Enter-Dev.ps1

# 安装已锁定依赖。
pnpm install --frozen-lockfile

# 类型检查和前端生产构建。
pnpm build

# 普通浏览器预览（不会连接 Rust，不能验证原生能力）。
pnpm dev

# 原生构建命令，是否成功以验证记录为准。
pnpm tauri build --debug --no-bundle
pnpm tauri android build --debug --target aarch64 --apk --ci

# Rust 格式与静态检查。
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings

# 核心、真实loopback HTTP/SSE、隔离Windows DPAPI与期限/排队测试。
cargo test --workspace
```

也可以向环境脚本传 `-JavaHome`、`-AndroidHome`，或沿用已存在的 JAVA_HOME / ANDROID_HOME。Gradle 用户缓存默认位于项目忽略的 `.cache/gradle`；Windows 原生及 Android 产物位于忽略的 `target` / Android `app/build`。

Java 需要代理时，可在本地 JSON 中增加 `javaProxyHost` 与数字 `javaProxyPort`。脚本仅给当前进程的 GRADLE_OPTS 设置明确的 HTTP/HTTPS 代理，不写系统代理或公共仓库。本机 Java 直连 Gradle 分发超时，而 .NET 走既有 loopback 代理；官方 ZIP 的 SHA256 已固定到 wrapper，实际 `gradlew --version` 成功。无需伪造缓存校验标记或关闭 TLS。

Android 工程已经生成，通常不要重复 `android init`；它可能覆盖本项目调整的 SDK/AGP 配置。第一次生成或确需重新生成前，先安装完整 Rust toolchain，再运行 `pnpm tauri android init --ci --skip-targets-install`，检查差异后保留本项目的 API 36、NDK 和 AGP 固定值。不能同时运行显式 Rust 安装和会隐式安装同一 toolchain 的 Tauri 命令。

## 工具与平台来源

以下官方资料均于 2026-10-12 核对：

- [Tauri 前置工具](https://v2.tauri.app/start/prerequisites/)、[Vite 配置](https://v2.tauri.app/start/frontend/vite/)、[Tauri CLI](https://v2.tauri.app/reference/cli/)。
- [VS BuildTools 组件](https://learn.microsoft.com/en-us/visualstudio/install/workload-component-id-vs-build-tools?view=vs-2022)及[安装参数](https://learn.microsoft.com/en-us/visualstudio/install/use-command-line-parameters-to-install-visual-studio?view=vs-2022)。Windows 原生构建需要真实 MSVC 和 SDK 文件；注册表记录不能代替编译。
- [Rustup 安装](https://rust-lang.github.io/rustup/installation/index.html)。
- [AGP 9.3 兼容表与补丁](https://developer.android.com/build/releases/agp-9-3-0-release-notes)、[Gradle 9.6.1](https://docs.gradle.org/9.6.1/release-notes.html)。AGP 9.3.3 避免前两个补丁已经修复的 JDK17 lint 与 Windows R8 文件名问题；API36、Build Tools36、NDK28.2 和 JDK17 在该兼容范围内。
- [模拟器加速](https://developer.android.com/studio/run/emulator-acceleration)。本机 WHPX 未启用；本轮不改 OS 可选功能、装驱动或自动重启。软件 TCG 不作为验收基础，ATD 也不代表普通手机体验。
- [Playwright CLI CDP 会话](https://github.com/microsoft/playwright-cli/blob/main/skills/playwright-cli/references/session-management.md)、[WebView2 测试](https://playwright.dev/docs/webview2)。调试端口只在受控开发子进程使用，验证结束关闭；不能带入公开应用启动配置。

依赖、配置和命令发生实际变化时更新本文；任务完成状态始终只维护在台账中。

## 当前产物与数据

`target/debug/lishi-app.exe` 为Windows技术探针；Android debug APK在`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`。当前包含原生信息、文本往返、SQLite、HTTP/SSE、密钥、文件与恢复面板，不能开局或游玩。双击exe可普通运行。`pnpm tauri dev` 的原生热更新路径尚未单独验收，当前以已验证的打包exe为入口。

笔记由Rust写入Tauri应用私有目录的`m01-probe.sqlite`，与未来每世界游戏数据库分开。每次保存原子更新正文、保存时间和修订，64KiB按UTF-8字节限制。恢复探针另用`m01-recovery.sqlite`，不覆盖原笔记；它仍不包含正式游戏状态。

界面文案集中于`src/i18n.ts`的类型安全键；目前仅提供简体中文，后续增加语言时扩展词条而非逐页搜索文字。正式输入与笔记内容保持原文，不参与翻译。

## 流式传输探针

在一个独立终端运行`node scripts/stream-fixture.mjs`，再打开Windows技术探针。默认基础地址为`http://127.0.0.1:18741/stream`，界面选择正常、缓慢、无数据、截断或错误场景后发起真实Rust HTTP请求；`/stats`给出每种场景的请求、断开和活动响应计数。服务只监听本机loopback，不含Key或真实模型调用，Ctrl+C结束服务。

核心只发送一次GET，关闭自动重试、重定向与系统代理；使用5秒连接/响应头、10秒读取空闲、90秒总期限，以及64KiB单事件、1MiB总响应、256KiB草稿上限。`[DONE]`才代表完成，EOF/格式错误保留未提交草稿。取消通过核心令牌停止本地接收，不保证远端计费停止。草稿不写SQLite，不能当成正式剧情。

本面板操作注册先于请求，同一时间仅允许一个任务，最近十项结果仅保留于当前进程内存。界面重载可查询活动操作，无需再次发HTTP；进程终止后这些状态丢失。下面的独立恢复面板另外验证持久化，不将本面板的内存结果误当数据库。当前GET探针不是带认证的模型Provider，不能用于配置真实模型。

后续Android调试可在明确连接的设备上使用`adb reverse tcp:18741 tcp:18741`映射loopback测试服务。手机上的localhost默认指向手机本身；当前未连接设备，未执行该命令或Android流式运行验收。公开release不包含debug明文网络许可，正式服务使用HTTPS。

Android系统证书验证由`src-tauri/src/android_tls.rs`在Wry JNI线程初始化；`stream_tls_unavailable`表示发送前拒绝，需核对初始化而不能关闭TLS。Gradle读取Cargo.lock中的shim版本，匹配Kotlin AAR；改网络依赖后必须重建并检查DEX，不能只做Windows测试。设计与设备边界见[D019](DECISIONS.md#d019-使用系统证书验证并显式初始化-android-tls)。

本探针的实现依据于2026-10-12核对：[SSE解析规则](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)、[Tauri Channel](https://v2.tauri.app/develop/calling-frontend/#channels)、[reqwest构建选项](https://docs.rs/reqwest/0.13.5/reqwest/struct.ClientBuilder.html)、[Tokio取消令牌](https://docs.rs/tokio-util/0.7.20/tokio_util/sync/struct.CancellationToken.html)。

## 密钥存储探针

只使用无效测试值；固定槽`m01-provider`用于M01，不是正式模型配置。密码框提交即清空，保存会替换该槽，刷新在核心内部解密验证但仅返回`configured`；删除后再次核对缺失。首次输入不可避免经UI与IPC，界面不回读已存明文、前缀、长度或指纹。当前不会发送密钥到任何模型。

Windows用当前用户DPAPI，密文在Tauri私有目录下`secrets/secret-v1-<slot字节hex>.dpapi`，与SQLite笔记分开。namespace/slot附加entropy防换槽；只把密文写入同目录临时文件，sync后替换。Android用系统Keystore AES256-GCM与随机IV/AAD，密文放`noBackupFilesDir/lishi-secret-store-v1/…`；已有密文但alias丢失时报错，需要明确删除并重配，不会悄悄创建新Key覆盖。

移动插件namespace拒绝前端命令并终止fallback；内部load仅经无@Command JNI helper。Root入队前持有owned占用，10秒等待超时返回未确认而不重发，排队或执行中旧任务仍未结束时不接受新操作。已启动平台worker不能安全强杀；JNI读的5秒只限制返回等待。持续不可用需重开。密文/内存占用不充当完整游戏操作恢复，后者在M01-T007。

Rust受控值与JNI JSON、DPAPI解密分配、Kotlin明文ByteArray有清零；JS/Tauri传输副本/JVM immutable String不能保证全部主动擦除。不要开启包含原始IPC参数的生产日志或把真实Key用于验收。应用声明关闭自动备份并排除cloud/device-transfer数据；游戏迁移留给显式存档包，秘密不进包。规则、边界和来源见[D020](DECISIONS.md#d020-密钥只在内部读取安全存储操作在入队前占用)。

Android六项密钥仪器测试使用独立随机namespace/fake token，四项文件桥测试使用target私有cache及FileProvider。共十项测试源码已编译进测试APK，尚未连接设备或执行：

```powershell
# 先完成同源码ARM64原生构建。
. .\scripts\Enter-Dev.ps1
pnpm tauri android build --debug --target aarch64 --apk --ci

# 只编译设备测试APK；native库已有成功构建，排除会重启Tauri临时CLI的Rust任务。
& .\src-tauri\gen\android\gradlew.bat -p src-tauri/gen/android :app:assembleUniversalDebugAndroidTest -PabiList=arm64-v8a -ParchList=arm64 -PtargetList=aarch64 -x :app:rustBuildUniversalDebug -x :app:rustBuildArm64Debug
```

测试APK在`src-tauri/gen/android/app/build/outputs/apk/androidTest/universal/debug/app-universal-debug-androidTest.apk`。后续指定设备并安装两包后，用`adb shell am instrument -w -e class io.timejump.lishi.SecretStoreTest io.timejump.lishi.test/androidx.test.runner.AndroidJUnitRunner`运行；当前这条命令未执行。须先核对实际test applicationId，记录设备/系统/测试结果再验收。

## 文档测试包

文件面板只导出明确输入的技术文本。`.lishi-probe` JSON v1包含format/version/note/checksum，文本64KiB、编码包400KiB；SHA256输入为format+NUL+version的LE32+NUL+原文UTF-8。它仅检测损坏，允许人工重新计算校验，不证明作者可信，也不是未来.timejump存档。

导入只经系统选择器，选后复制到应用私有`m01-import-stage`再验证，成功仅展示预览；复制到编辑框需显式点击，原SQLite笔记保持原样。关闭选择器保留编辑/预览，损坏、未来版本或超限被拒绝；Android上游把取消与选择器错误都映射为未选中，不能据此判断用户原因。

Android当前选择为GET_CONTENT临时授权，保存为CREATE_DOCUMENT，不保留URI；无Command的JNI桥在Rust阻塞worker用openFileDescriptor，fd由Rust关闭。前端无dialog/fs权限，不提供任意路径/URI入口。选后I/O最多等30秒；返回未确认不代表worker已取消，占用实际结束才释放，禁止自动重试。外部provider写失败可能留部分目标文件；Windows完整临时文件sync后才替换选中探针文件。启动只清私有目录内自己的平面stage，先取得应用owner锁。

实施来源与边界见 [D021](DECISIONS.md#d021-系统选择器与私有暂存验证文件权限留在原生层)，实际证据见M01记录。后续设备可运行`adb shell am instrument -w -e class io.timejump.lishi.FileAccessBridgeTest io.timejump.lishi.test/androidx.test.runner.AndroidJUnitRunner`；本机未执行，四项桥测试也不替代SAF选择器验收。

## 持久恢复探针

恢复面板使用独立`m01-recovery.sqlite`，操作ID/base head先持久登记，再发一次测试HTTP。传输完成先进入validating候选，只有短事务成功才更新正式文本、修订、操作终态和提交记录。流式草稿只在页面内存；校验候选暂存数据库，失败/取消/重开中断清除。启动只查询并显示中断，不重发请求；旧ID/旧head和第二活owner拒绝。

默认无暂停。技术验收可选择20秒校验或提交事务暂停，看到明确边界事件后才强杀；commit_paused意味着事务写入已发生但未COMMIT。事务暂停仅用于证明回滚，不带入正常回合。取消可结束等待并回滚，状态查询可能等事务释放。正式世界Schema/资源结算属于M02，尚未实现。

恢复面板包含large-truncated场景：12000B中文分片后直接EOF，验证大Channel晚到时仍以持久失败为准。前端不得让晚到事件或旧查询降低已确认终态；真正取数发生在原生IPC中，测试不替换模型或数据库结果。

五个握手边界子进程强杀和Windows真实UI验证见M01记录；平台策略见 [D022](DECISIONS.md#d022-独立恢复探针验证提交边界与单进程持有权)。用户恢复手机测试时按 [六项设备清单](validation/M01_DEVICE_CHECKLIST.md) 执行，当前完整M01门槛未通过。
