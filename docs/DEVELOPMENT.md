# 开发说明

写给想自己构建、修改或研究这个应用的人。只想玩的话，看 [README](../README.md) 就够了。

日常开发主要在电脑的浏览器里进行（下面叫“浏览器开发台”）：使用手机同一套界面和 Rust 执行核心，存档保存在常驻本机宿主的 SQLite 中，也可以接一个不花钱的本地模拟模型。要看真机效果时，再构建安卓或 Windows 版。

## 代码在哪里

| 目录 | 内容 |
| --- | --- |
| `src/engine/` | TypeScript 游戏门面：上下文与提示词、资料检索、回合树、存档和界面操作；保留规则辅助与内存测试实现 |
| `src/ui/` | 界面（React）：首页、开局、游玩页、设置和各种面板 |
| `src/platform/` | 平台接口：原生版经 Tauri 调用 Rust，浏览器开发台经开发桥调用常驻 Rust 宿主 |
| `src/content/` | 内置内容：唐天宝年间的卡组、开局灵感、挑战卡 |
| `src-tauri/` | Tauri 2 外壳和 Rust 平台服务：SQLite、系统加密存储、流式请求、文件、通知、窗口状态、更新下载 |
| `src-tauri/gen/android/` | 安卓工程，含 Kotlin 写的系统桥接：文件选择、加密存储、后台生成、通知、安装更新 |
| `devserver/` | 浏览器开发台的 Vite 中间件：保管开发用的 Key、转发模型请求 |
| `crates/book-pdf/` | 原生版与开发桥共用的 PDF 文字提取核心 |
| `crates/story-core/` | 两种执行方式共用的规则、模型工具调度、内置技能、持久步骤与事务提交 |
| `crates/dev-host/` | 浏览器开发台的常驻宿主，通过标准输入输出通信，共用同一 SQLite 连接 |
| `scripts/` | 本地模拟模型、界面检查、打包与检查脚本 |
| `assets/` | 图标的源文件 |

故事运行和状态结算由共享 Rust 核心负责；前端通过现有 Game 门面启动、补读进度和停止。内置 MCP 服务使用进程内传输，不另开工具端口。提示词由门面准备，执行时加入技能与工具资料。

## 需要的工具

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | 24 | 前端与脚本 |
| pnpm | 11.25（`package.json` 里固定，经 corepack 使用） | 依赖管理 |
| Rust | 1.99（`rust-toolchain.toml` 固定，含两个安卓 target） | 共享执行核心、开发宿主与平台服务 |
| Microsoft Edge 或 Chromium | 新版即可 | 界面检查脚本（`playwright-core` 不自带浏览器；默认用本机的 Edge，设 `LISHI_BROWSER` 为 Chromium 的路径则用它） |
| Visual Studio 2022 生成工具（C++ 桌面开发） | 17.14 | Windows 版 |
| JDK | 17 | 安卓版 |
| Android SDK | API 36、Build Tools 36.0.0、NDK 28.2.13676358 | 安卓版 |
| libclang | 与NDK头文件兼容的版本 | Android受控JavaScript解释器的绑定生成，使用`LIBCLANG_PATH`定位 |

前端主要用 React 19、TypeScript 7、Vite 8、vitest 和 Tauri 2，内存测试使用 sql.js；安卓工程用 Gradle wrapper 9.6.1 与 AGP 9.3.3。

在 PowerShell 里先执行一次 `. .\scripts\Enter-Dev.ps1`。它只为当前进程设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME` 和 `PATH`（含 `adb`），`pnpm` 不在 `PATH` 里时用 corepack 垫一个。JDK 和 SDK 的位置按这个顺序找：参数 `-JavaHome`、`-AndroidHome`；环境变量；项目里不入 Git 的 `.private/toolchain.json`（`{"javaHome": "…", "androidHome": "…"}`，可选 `javaProxyHost`、`javaProxyPort` 让 Gradle 走代理）；最后是 `%LOCALAPPDATA%\Android\Sdk`。

## 常用命令

```powershell
. .\scripts\Enter-Dev.ps1
pnpm install --frozen-lockfile
pnpm dev                    # 浏览器开发台：http://127.0.0.1:1420
pnpm typecheck              # 只做类型检查
pnpm test                   # 单元测试（vitest）
pnpm build                  # 类型检查 + 前端构建
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace      # Rust 平台服务的测试，只连本机的测试服务
```

在 Git Bash 里没有执行 `Enter-Dev.ps1` 时，把 `pnpm` 写成 `corepack pnpm`。

## 浏览器开发台

1. 激活开发工具后运行 `pnpm dev`，用浏览器打开 `http://127.0.0.1:1420`，开发者工具切到手机尺寸（如 393×852 或 360×800）。第一次访问会增量构建并启动 `story-dev-host`，因此也需要 Rust 工具链；可提前运行 `cargo build -p story-dev-host`。
2. 第一次打开会进入“连接 AI 服务”。Key 由开发服务器保存在本机、不入 Git 的 `.cache/dev-secrets.json` 里，页面本身拿不到；模型请求经开发服务器转发，它只接受本机的访问。
3. 可选：把 `.env.example` 复制成 `.env.local`（不入 Git），预先填好服务地址和模型。

宿主默认将存档写入 `.cache/dev-host/game.sqlite`，与安装版互不相干。旧浏览器 IndexedDB 数据只在宿主数据库为空时导入一次，原数据和备份保留；之后的读写都使用宿主。关掉页面仅停止订阅，宿主仍可完成运行；关掉开发服务器会取消并保存进度，重新启动可恢复完成步骤。

验证时须同时设置 `LISHI_DEV_DATABASE_DIR`（独立数据库目录）和 `LISHI_DEV_SECRETS_FILE`（独立凭据文件绝对路径），避免使用个人存档与 Key。隔离凭据不会从 `.env.local` 自动复制 Key。开发模式下页面有 `window.__lishi`，脚本可以借它直接读写引擎；正式构建里没有。

导入书籍的 TXT、EPUB 和 DOCX 在本地按需解析。PDF 使用 Rust 的同一套按页提取核心；浏览器开发前先运行 `cargo build -p book-pdf`，开发桥会调用生成的本机程序，原生版直接调用库。扫描 PDF 不做 OCR，某些未提供字形映射的中文字体编码暂不支持。导入只使用系统选定文件，不申请整个存储空间权限。

参考书籍的定向界面检查可用 `node --import tsx scripts/ui/sources.mjs --text-pdf <中文短文本样本.pdf> --image-pdf <图片型短样本.pdf>`；使用独立浏览器与模拟模型，不读写个人 AI 设置。当前文字样本断言使用“中文书籍第一页阿青守信”。

### 本地模拟模型

不想花钱时，用本地的模拟模型。它不调用任何真实服务，按请求内容给出固定的回复：

```powershell
node scripts/fake-llm.mjs            # 默认端口 18800，可用 --port 改
```

在“连接 AI 服务”里选“自定义”，地址填 `http://127.0.0.1:18800/v1`，Key 随便填，模型名决定它怎么回：

| 模型 | 行为 |
| --- | --- |
| `fake-normal` | 先给一段思考，再分 30 来块流式输出正文和记录 |
| `fake-slow` | 同上，每块之间停 400 毫秒（用来试停止、切后台） |
| `fake-http500` | 返回 500 |
| `fake-stall` | 发两块后不再出声 |
| `fake-nostream` | 不管 `stream: true`，一次返回整段 |
| `fake-plain` | 只有正文、没有记录（用来试补记） |

`GET /debug/last-request` 返回最近一次聊天请求，测试可以用它检查发出去的内容。

这些普通模拟模型用于原有游玩流程，开局无需选择执行方式。按需 Agent 的隔离对话、修改策略、工具调用与阅读位置可用 `node --import tsx scripts/ui/agent-chat.mjs` 独立验证；脚本自带本机模拟服务、独立数据库与假凭据，截图写入 `output/playwright/agent-chat-r17/`。原 `agent.mjs` 默认转到该脚本；`--preview-only` 只检查具体改稿预览和采用。

Agent 会话和任务独立保存在 SQLite，服务／模型配置随任务固定，普通游玩的服务不会被临时覆盖。默认每次30次模型请求、100次工具调用、15分钟，可在助手执行设置中调整；继续累计原用量。工具说明按需发现，大资料分页读取；每次请求将工具参数说明一并计入现有上下文输入预算。模型原生搜索、Tavily及远程Streamable HTTP MCP由玩家配置，密钥只存系统槽；不会自动安装工具。网页及原文必须实际进入模型请求才能记作已读。

世界文件保存独立的助手对话及完结任务摘要，导入后作为只读历史；执行连接、未完运行及本机任务恢复点不导出，小说导出只包含正式剧情。预览采用和任务撤回会检查故事是否已有新变化，避免覆盖后续进展。

玩法模式另有触发词。“段数”按请求里已有的 AI 回复数算（开场算第 1 段）；“本回合行动”是用户消息里最后一个以“【”开头的段落（玩家行动、幕后指点或继续）。

| 请求里有 | 模拟模型怎么回 |
| --- | --- |
| 【剧本】且还有没演完的幕 | 第 2、4、6……段的记录写 `"beat":"done"`，所以每两段演完一幕 |
| 【挑战】且挑战进行中 | 每段记录写 `"challenge":{"progress":"第 N 段：离目标又近了一步"}` |
| 本回合行动里有“达成” | 挑战记 `"result":"won"`，理由“主角做成了这件事” |
| 本回合行动里有“放弃抵抗” | 挑战记 `"result":"lost"`，理由“主角放弃了抵抗” |
| 开场请求里有【挑战】 | 开场记录多一条 `"challenge":{"progress":"还没有头绪"}` |
| 旁观（系统提示里有“主角由你来演”） | 换一组主角自己说话做事的正文，建议是“让他在西市撞见旧识”这类走向；连播的每一段也是这组 |
| 拟大纲（“拟剧本大纲”） | 一份五幕大纲：主线“落第书生在长安闯出一条生路”，结局“还清旧债，在长安站稳脚跟” |
| 出题（“出一个开局挑战”） | `{"goal":"三个月内凑够三百两","limit":"三个月","failIf":"被债主告到官府"}` |

“过些日子”的模拟回复固定过一个月、不写挑战进展，可以用来试“期限已到”：期限写“十日”时，过一次就失败。要试主角死亡，可以在主角面板里把健康改成 0（难度不是“宽松”时就算死去）。

### 在 Linux 上开发

前端、Rust 核心和浏览器开发台都能在 Linux 上跑；安卓和 Windows 安装包仍要在装了 JDK、Android SDK 或 Visual Studio 生成工具的机器上打。

- `rust-toolchain.toml` 要求两个安卓 target，没有安卓工具时 rustup 会尝试下载它们。只做前端、核心和开发台时，可以先设 `RUSTUP_TOOLCHAIN=1.99.0`，直接用已装好的工具链。
- 仓库放在网络挂载的目录（如 sshfs）上时，把编译产物放到本地盘：`CARGO_TARGET_DIR=~/lishi-target`。开发台和检查脚本都会按这个变量找 `story-dev-host`。
- 内存小的机器：`CARGO_BUILD_JOBS=2`、`CARGO_PROFILE_DEV_DEBUG=0` 能明显降低编译时的内存占用；前端测试可用 `pnpm exec vitest run --maxWorkers=1`，避免超时。
- 开发台每次启动都会先 `cargo build -p story-dev-host`，超过 3 分钟就放弃，页面停在“正在打开…”。改过 Rust 代码或版本号之后，先手动构建一次，或用 `LISHI_DEV_HOST_BUILD_TIMEOUT_MS` 放宽时限。
- 改了样式后跑一次 `node_modules/.bin/vite build`：开发服务器对某些 CSS 写法很宽容，生产构建会直接失败（`src/ui/styles/styles.test.ts` 检查最常见的一种）。
- 界面检查用 Chromium：`LISHI_BROWSER=/usr/bin/chromium`。冷启动慢时用 `LISHI_UI_TIMEOUT_MS=45000` 放宽等待时间。
- 浏览器开发台里的助手需要固定版本的 Node 与 SDK（`LISHI_PI_NODE`），没准备时助手页会提示运行环境未准备；其他功能不受影响。

### 界面检查脚本

这些脚本都在浏览器里、用本地模拟模型跑，不发真实请求；它们证明不了真实模型的效果，也代替不了手机上的试玩。

先启动 `pnpm dev` 和模拟模型再运行的。默认连 `http://127.0.0.1:1420/` 和端口 18800；同时开几个工作区时，用环境变量 `LISHI_APP`、`LISHI_FAKE_PORT` 指到你实际启动的端口，例如 `node_modules\.bin\vite --port 1434 --strictPort`、`node scripts/fake-llm.mjs --port 18834`，再 `LISHI_APP=http://127.0.0.1:1434/ LISHI_FAKE_PORT=18834 node scripts/ui/desktop.mjs`：

| 命令 | 检查什么 |
| --- | --- |
| `node scripts/ui/game-flow.mjs` | 手机尺寸的完整流程：连接服务、开局、游玩、各个面板、世界线、设置、导入导出；截图在 `.cache/ui/` |
| `node scripts/ui/modes.mjs` | 剧本、挑战、旁观三种玩法；截图在 `output/playwright/modes/` |
| `node scripts/ui/r13-free.mjs [--play]` | 自由世界的开局，加 `--play` 再真的开一局；注意它默认连 `http://127.0.0.1:1450/` 和端口 18850 |
| `node scripts/ui/desktop.mjs` | 电脑宽屏：双栏布局、回车发送、窄窗口退回手机布局、快捷键、右键菜单、悬停提示、拖入世界文件 |
| `node scripts/ui/long-world.mjs` | 千回合世界的打开与滚动 |
| `node scripts/ui/screens.mjs` | 三套主题下的主要界面截图和拼图，在 `.cache/ui/screens/` |

自己启动所需服务、不用先开 `pnpm dev` 的：

| 命令 | 检查什么 |
| --- | --- |
| `node scripts/ui/dev-isolated.mjs --fresh` 后 `node scripts/ui/play-check.mjs` | 前者在 1421 端口启动只用 `.cache/ui-isolated` 的开发台（不碰你的存档和 Key，只许访问本机）；后者配合 `node scripts/fake-llm.mjs` 检查首次启动、三种开局、游玩页菜单、长按、助手页、主题与大字号、流式生成、动效退场、草稿、正文里的选项、变化行和生成中离开；报告和截图在 `output/playwright/play-check/` |
| 同一个隔离开发台上再跑 `node scripts/ui/style-shots.mjs` | 两种外观风格（宣纸书卷、墨韵）各自浅色与深色下的首页、设置、开局、游玩、菜单、变化清单、打字、发送和写完时的截图，含几张动画进行中的画面，首页有场景和书架两种；在 `output/playwright/style-shots/` |
| 同一个隔离开发台上跑 `node scripts/ui/feature-shots.mjs [scroll\|ink] [paper\|night]` | 给第一个故事挂一本小样书，截生成档位、原著札记（新建、整理完成）、每段用量、本局用量、让 AI 改时间与货币、两种首页和开书中途的画面；在 `output/playwright/feature-shots/` |
| 同一个隔离开发台上跑 `node scripts/ui/motion-film.mjs [scroll\|ink] [paper\|night]` | 动画放慢四倍、每 80 毫秒截一帧，拼成胶片图：从场景首页和书架首页开书、从故事返回；在 `output/playwright/motion-film/` |
| `node scripts/ui/readme-shots.mjs` | 生成 README 里的截图（`docs/images/readme/`）；端口用 `--port`、`--fake-port` 改 |
| `node scripts/ui/r13-writing.mjs` | 写作工具：展开输入、常用行动、润色行动、AI 改写段落与恢复原文 |
| `node scripts/ui/app-update.mjs` | 更新面板的各种状态（360 宽、三套主题），截图在 `output/playwright/app-update/` |
| `node src/ui/components/quality.ui.mjs` | 封面与头像、这一版新增、本月预算、代理与隐私提示、长图书摘；在仓库根目录运行，端口用 `QUALITY_UI_PORT`、`QUALITY_FAKE_PORT` 改 |

另外两个不用浏览器的：`node_modules/.bin/tsx scripts/bench/long-world.ts [--turns 1000]` 在内存里造一个千回合的世界，给首页、游玩页和组装下一回合计时；`node_modules/.bin/tsx scripts/check-eras.ts` 逐个检查内置卡组，列出问题和时代卡的长度。

## 构建

### 安卓

开发中的 Pi 助手需要把完整运行环境随包携带。先按 [Node 构建说明](../runtime/android-node/README.md)准备固定版本的 Node/JNI 产物及声明，再用 `scripts/Build-PiAndroidHost.ps1` 构建独立故事宿主。使用 `node scripts/pi-host/prepare-android-app.mjs --native <ARM64原生库目录> --jni <liblishi_agent_host.so> --notices <声明目录> --readelf <llvm-readelf> --output <新装配目录>` 校验和装配，参数中的路径均为绝对路径；命令不会安装应用。构建前将 `ORG_GRADLE_PROJECT_piAppRuntimeDirectory` 环境变量指向装配目录，Gradle会重新核对资源与库的哈希。没有完整产物时停止组包，不在手机首次启动时下载补齐，也不忽略共享库冲突。

```powershell
. .\scripts\Enter-Dev.ps1
pnpm tauri android build --debug --target aarch64 --apk --ci   # 调试包
pnpm tauri android build --target aarch64 --apk --ci           # 发行包（未签名）
```

调试包是 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`（包含调试信息与内嵌运行环境，体积较大），发行包是旁边的 `universal/release/app-universal-release-unsigned.apk`，签名后才能安装：

```powershell
$env:LISHI_SIGNING_STORE_PASSWORD = 'android'   # 安卓调试证书的默认密码，只放在本次进程里
./scripts/Sign-AndroidPreview.ps1 `
  -UnsignedApk src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk `
  -ReferenceApk src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk `
  -KeystorePath $HOME/.android/debug.keystore `
  -OutputPath .cache/release/chuanyue-<版本>.apk
```

`scripts/Verify-AndroidPackage.ps1 -ApkPath <apk> [-Profile debug] [-ReferenceApk <apk>] [-PiRuntimeDirectory <运行资源目录>]` 不连手机地检查一个安装包：应用 ID、发行包不可调试、v2 签名且证书与参考包一致、ZIP 与原生库的 16 KB 对齐、包里的 ARM64 原生库与刚编译的一致、Rust 用到的系统桥接类都在、声明了安装更新所需的权限。从别的目录运行时，`-ApkPath`、`-OutputPath` 请写绝对路径。 包含内嵌 Pi 的包需提供构建时使用的运行资源目录（也可由 `ORG_GRADLE_PROJECT_piAppRuntimeDirectory` 传入），额外核对 Node、独立服务原生库、运行资源和许可清单的完整哈希及服务进程声明；未提供时仍检查普通包。包检查不替代真机运行验证。

**签名与覆盖安装**：安卓只允许用同一个证书签名的新包覆盖旧包。发布页上的安装包用作者电脑上的安卓调试证书签名，这样调试包和发行包能互相覆盖、保留存档。你自己构建的包用的是你电脑上的调试证书，和发布页的包签名不同，系统不会让两者互相覆盖。想换成自己构建的版本，先在首页把每个世界导出成文件，卸载、安装之后再导入：卸载会删掉所有的世界。

发行包暂时没有开 R8 精简，所以比可以做到的大一些。

### Windows

Agent 助手的发行包同时携带固定版本的 Node 与完整 Pi 资源。先按上方说明准备 `agent-host/.cache/runtime`，从 Node 官方同版本目录取得 `node-v24.19.0-win-x64.zip` 与 `SHASUMS256.txt`，运行：

```powershell
node scripts/pi-host/prepare-windows-app.mjs --node-archive <官方ZIP绝对路径> --checksums <校验表绝对路径>
```

装配脚本校验归档、运行版本、许可证与完整资源清单，默认写入 `.cache/pi-windows`，拒绝覆盖已有装配目录。平台构建配置将其放入安装目录的 `agent` 子目录。便携包必须同时包含 `lishi-app.exe` 和该 `agent` 目录，不能只压缩一个EXE。

```powershell
. .\scripts\Enter-Dev.ps1
pnpm tauri build --debug --no-bundle   # 调试版：target\debug\lishi-app.exe
pnpm tauri build                       # 安装包和单个程序
```

- 安装包是 `target\release\bundle\nsis\穿越小说模拟_<版本>_x64-setup.exe`：只装给当前用户，不需要管理员，展示名为“穿越小说模拟”，沿用旧安装标识，默认目录保持 `%LOCALAPPDATA%\历史穿越`；安装界面是简体中文，自动建开始菜单快捷方式，完成页可以勾选桌面快捷方式。卸载时“删除应用程序数据”默认不勾，不勾就不会删掉世界。WebView2 用在线引导安装（Windows 10、11 一般已经自带）。
- 主程序是 `target\release\lishi-app.exe`；将它和装配后的完整 `agent` 目录一起打成 zip，得到免安装版。它不是“数据放在旁边”的便携版：数据和安装版一样放在 `%APPDATA%\io.timejump.chuanyue`，两者共用同一份存档。
- 第一次打安装包时，Tauri 会从 GitHub 下载 NSIS 并缓存到 `%LOCALAPPDATA%\tauri\NSIS`，以后离线也能打包；打不开 GitHub 时只能先用 `--no-bundle` 出单个程序。
- 程序和安装包都没有代码签名，第一次运行时 SmartScreen 可能提示“Windows 已保护你的电脑”，点“更多信息 → 仍要运行”。

### 版本号

版本号写成“主.次.修订”，三处保持一致：`package.json`、`src-tauri/tauri.conf.json`、根目录 `Cargo.toml` 的 `[workspace.package]`。安卓的内部版本号由 Tauri 按“主 × 1000000 + 次 × 1000 + 修订”算出，只增不减，新包才能覆盖旧包。

## 装到手机上

- **无线配对**：手机打开“开发者选项 → 无线调试”。电脑上装好 Python 的 `qrcode` 包（`pip install "qrcode[pil]"`），然后运行

  ```powershell
  python scripts/Pair-AndroidQr.py --adb "$env:ANDROID_HOME\platform-tools\adb.exe" --output .cache/adb/pair.png --result .cache/adb/pair.json
  ```

  打开生成的 `pair.png`，在手机上点“使用二维码配对设备”扫码。配对成功后脚本打印设备序列号，也写进 `pair.json`。二维码和结果都只放在不入 Git 的 `.cache/` 里。
- **安装**：`adb -s <设备> install -r <apk>`。一律加 `-r`（覆盖安装、保留数据），**不要卸载**：卸载会删掉手机上所有的世界。
- 小米手机返回 `INSTALL_FAILED_USER_RESTRICTED` 时，在开发者选项里打开“USB 安装”和“USB 调试（安全设置）”；还不行就 `adb push <apk> /sdcard/Download/`，在手机的文件管理里点开安装。
- 在 Git Bash 里运行 `adb shell` 时，命令里的 `/sdcard/...` 会被改写成 Windows 路径，要在命令前加 `MSYS_NO_PATHCONV=1`。
- 没有热更新：`pnpm tauri android dev` 认不出经无线调试连接的设备。日常改界面用浏览器开发台，要看真机效果时构建后用 adb 安装。

## 应用内更新

安卓版在“设置 → 关于与更新”和首页的新版本提示里，可以直接下载、校验并安装新版：

- 版本信息来自 GitHub 公开的发布列表（本仓库的 Releases）。打开应用时每天最多查一次，只看有没有新版本，可以在设置里关掉。安装包按文件名 `chuanyue-<版本>.apk` 找。
- 校验值取 GitHub 为每个发布文件计算的 SHA-256（发布接口里的 `digest`）；没有时读同一个发布里的 `SHA256SUMS.txt`；两样都没有，就不在应用里安装，只提供“用浏览器下载”。
- 只从本仓库的发布地址和 GitHub 跳转到的文件服务器下载，名单在 `src/platform/link-policy.json`，每一次跳转都重新检查；请求里不带任何账号或 Key，走“网络与代理”里设置的代理。
- 下载存在应用的缓存目录里，断了会自动重连，再下载时从断点接着下；大小和 SHA-256 都对才算下完，不对就删掉。安装前再校验一次，然后交给系统的安装界面（第一次要允许本应用“安装未知应用”）。覆盖安装，存档不受影响。
- Windows 版打开发布页，由浏览器下载安装包：运行中的程序不能替换自己，由程序启动没有签名的安装包也容易被安全软件拦下。

### 在手机上测试应用内更新（调试版）

调试版（`--debug` 构建）可以把“检查更新”指向这台电脑上的测试服务 `scripts/update-fixture.mjs`，经 `adb reverse` 在手机上走完下载、校验、安装的全过程。发行版没有这个入口，也不接受本机地址。

1. 编译调试版并覆盖安装（和你自己签名的发行包用的是同一个调试证书、同一个应用 ID，存档保留）：

   ```powershell
   . .\scripts\Enter-Dev.ps1
   pnpm tauri android build --debug --target aarch64 --apk --ci
   adb -s <设备> install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
   ```

2. 准备一个当作“新版本”的安装包：必须用同一个证书签名，内部版本号不低于手机上的包。可用签名后的发行包；调试包包含额外调试信息，传输体积通常更大。
3. 启动测试服务并转发端口：

   ```powershell
   node scripts/update-fixture.mjs --apk <安装包> --port 18990
   adb -s <设备> reverse tcp:18990 tcp:18990
   ```

   它把版本报成当前版本的修订号加一（可以用 `--version` 改），带 GitHub 式的 `digest`；下载先 302 跳转，再按 Range 返回，终端里能看到每个请求和续传的位置。
4. 手机上：设置 → 关于与更新，滚到最下面，在“提交问题”下方的空白处连点 7 下打开开发者模式（会提示“开发者模式已打开”）；再到 设置 → 开发者 →“测试更新源”，填 `http://127.0.0.1:18990` 并保存。
5. 设置 → 关于与更新 → 检查更新 → 去更新 → 下载更新 → 安装。第一次会打开本应用的“安装未知应用”开关，打开后返回，应用会自己再打开安装界面（没出现就再点一次“安装”）。
6. 换参数重启测试服务，依次看这些情况：

   | 参数 | 看什么 |
   | --- | --- |
   | `--drop-at 0.3` | 断开后显示“网络不稳，正在重连”，服务端出现 `range <字节>-` 的续传请求，最后校验通过 |
   | `--rate 300` | 进度和字节数；“暂停”后“继续下载”是续传；切到后台再回来；下载中划掉应用，重开后再下载会接着下 |
   | `--corrupt` | 显示“下载的文件不完整，已删除”，“重新下载”从头下并成功 |
   | `--no-digest --sums` | 没有 `digest` 时读 `SHA256SUMS.txt`，照常下载 |
   | `--no-digest` | 没有任何校验值：只提供“用浏览器下载” |

7. 收尾：“测试更新源”点“清除”，再 `adb -s <设备> reverse --remove tcp:18990`。装上去的如果是发行版，就不再有测试入口。

不连手机的检查：`cargo test --workspace updates`（下载核心对本机测试服务：断点续传、哈希与大小不符、取消、重试、跳转与地址名单）；`node scripts/ui/app-update.mjs`。浏览器开发台里的下载是模拟的（`src/platform/webUpdate.ts`），在 `localStorage` 的 `lishi.devUpdateSim` 里写 `slow`、`fail`、`corrupt`、`permission`（用空格分隔）可以模拟各种情况。

## 电脑端的细节

- **快捷键**（`src/ui/components/useShortcuts.ts`，只在有鼠标键盘时生效；游玩页按 `?` 或 `Ctrl+/`，或者 ⋯ 菜单里的“快捷键”能看到一览）：Ctrl+Z 撤销、Ctrl+Y 或 Ctrl+Shift+Z 重做、Ctrl+R 重说、Ctrl+K 或 / 聚焦输入框、Ctrl+F 查一查、Ctrl+, 设置、F1 游玩指南、Alt+1～4 选建议行动、Ctrl+Enter 发送、Esc 关面板。输入框里只认 Ctrl、Alt 组合和 F 键，输入法正在拼字时一律不响应；有面板打开时，游玩页的快捷键除 Esc 外都不动作。用到的 Ctrl 组合会挡住 WebView 自带的同名键（Ctrl+R 刷新、Ctrl+F 网页查找）。
- **右键**：`useLongPress` 在鼠标右键时直接触发长按动作，所以段落、首页故事卡片的右键和长按打开同一个菜单；触屏的长按不变。
- **窗口**：`src-tauri/src/window_state.rs` 在启动时恢复上次的大小、位置和是否最大化，关窗时写进数据目录的 `window-state.json`；保存的位置已经不在任何屏幕上（比如拔了显示器）就居中。删掉这个文件，窗口就回到默认的 1100×800 居中；最小 420×600。
- **拖入导入**：把 `.lishi.json` 拖进窗口就导入（`App.tsx` 的 `useDropImport`）。Tauri 自带的拖放已关（`dragDropEnabled: false`），网页直接收到文件内容，所以浏览器开发台里也能试。已有同一个世界时只提供“另存为新的世界”，要覆盖请走首页的“从文件导入世界…”。

## 图标

改了 `assets/app-icon.svg`（安卓用，印章四周留白，落在启动器遮罩保留的圆里）或 `assets/app-icon-desktop.svg`（电脑用，印章撑满）之后：

1. `node scripts/ui/icon.mjs` 用思源宋体（SIL OFL，从 Google Fonts 加载，要联网）把它们渲染成 1024×1024 的 PNG；浏览器同界面检查脚本，用 `LISHI_BROWSER` 指定 Chromium。
2. `pnpm tauri icon assets/app-icon.png --ios-color "#efe5cf"` 生成安卓图标。这个颜色参数同时决定安卓自适应图标的纸色背景，写进 `res/values/ic_launcher_background.xml`；不要在别的文件里再定义同名颜色，否则安卓打包会报资源重复。
3. `pnpm tauri icon assets/app-icon-desktop.png --output .cache/icons-desktop` 生成电脑图标，把其中除 `android/`、`ios/` 以外的文件复制到 `src-tauri/icons/`。

界面的配色、字体和组件见[设计规范](design/DESIGN_SPEC.md)。

## 数据放在哪里

- **安卓**：应用的私有目录，卸载即删除。Key 用系统 Keystore 加密保存。
- **Windows**：`%APPDATA%\io.timejump.chuanyue`，里面有数据库 `game.sqlite`、每日备份 `backups/`（保留最近 20 份）和 `window-state.json`。Key 用当前 Windows 用户的 DPAPI 加密保存，换一台电脑或换一个用户就读不出来。
- **浏览器开发台**：存档在 `.cache/dev-host/` 的宿主数据库，开发用的 Key 默认在 `.cache/dev-secrets.json`；旧浏览器库保留作一次导入来源。

不要把 Key、令牌或私人的服务地址写进代码、文档、日志和提交；`.cache/`、`.env.local`、`.private/` 都已经被 Git 忽略。
