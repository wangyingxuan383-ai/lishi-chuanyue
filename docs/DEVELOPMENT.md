# 开发说明

写给想自己构建、修改或研究这个应用的人。只想玩的话，看 [README](../README.md) 就够了。

日常开发主要在电脑的浏览器里进行（下面叫“浏览器开发台”）：界面和游戏逻辑与手机上的完全相同，存档放在浏览器里，AI 请求经本机的开发服务器转发，也可以接一个不花钱的本地模拟模型。要看真机效果时，再构建安卓或 Windows 版。

## 代码在哪里

| 目录 | 内容 |
| --- | --- |
| `src/engine/` | 游戏引擎（TypeScript）：回合与回合树、记账规则、记忆与上下文、提示词、纪年、玩法模式、存档的导入导出 |
| `src/ui/` | 界面（React）：首页、开局、游玩页、设置和各种面板 |
| `src/platform/` | 平台接口：原生版经 Tauri 调用 Rust，浏览器开发台用 sql.js 和开发服务器 |
| `src/content/` | 内置内容：唐天宝年间的卡组、开局灵感、挑战卡 |
| `src-tauri/` | Tauri 2 外壳和 Rust 平台服务：SQLite、系统加密存储、流式请求、文件、通知、窗口状态、更新下载 |
| `src-tauri/gen/android/` | 安卓工程，含 Kotlin 写的系统桥接：文件选择、加密存储、后台生成、通知、安装更新 |
| `devserver/` | 浏览器开发台的 Vite 中间件：保管开发用的 Key、转发模型请求 |
| `scripts/` | 本地模拟模型、界面检查、打包与检查脚本 |
| `assets/` | 图标的源文件 |

游戏规则、提示词和模型输出的解析都在 TypeScript 里；Rust 只做平台服务，不含游戏逻辑。

## 需要的工具

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | 24 | 前端与脚本 |
| pnpm | 11.25（`package.json` 里固定，经 corepack 使用） | 依赖管理 |
| Rust | 1.99（`rust-toolchain.toml` 固定，含两个安卓 target） | 平台服务 |
| Microsoft Edge | 新版即可 | 界面检查脚本（`playwright-core` 不自带浏览器，用本机的 Edge） |
| Visual Studio 2022 生成工具（C++ 桌面开发） | 17.14 | Windows 版 |
| JDK | 17 | 安卓版 |
| Android SDK | API 36、Build Tools 36.0.0、NDK 28.2.13676358 | 安卓版 |

前端主要用 React 19、TypeScript 7、Vite 8、sql.js、vitest 和 Tauri 2；安卓工程用 Gradle wrapper 9.6.1 与 AGP 9.3.3。

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

1. `pnpm dev`，用浏览器打开 `http://127.0.0.1:1420`，开发者工具切到手机尺寸（如 393×852 或 360×800）。
2. 第一次打开会进入“连接 AI 服务”。Key 由开发服务器保存在本机、不入 Git 的 `.cache/dev-secrets.json` 里，页面本身拿不到；模型请求经开发服务器转发，它只接受本机的访问。
3. 可选：把 `.env.example` 复制成 `.env.local`（不入 Git），预先填好服务地址和模型。

存档在浏览器里（sql.js），和原生版互不相干。开发模式下页面上有 `window.__lishi`，脚本可以借它直接读写引擎；正式构建里没有。

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
| `node scripts/ui/readme-shots.mjs` | 生成 README 里的截图（`docs/images/readme/`）；端口用 `--port`、`--fake-port` 改 |
| `node scripts/ui/r13-writing.mjs` | 写作工具：展开输入、常用行动、润色行动、AI 改写段落与恢复原文 |
| `node scripts/ui/app-update.mjs` | 更新面板的各种状态（360 宽、三套主题），截图在 `output/playwright/app-update/` |
| `node src/ui/components/quality.ui.mjs` | 封面与头像、这一版新增、本月预算、代理与隐私提示、长图书摘；在仓库根目录运行，端口用 `QUALITY_UI_PORT`、`QUALITY_FAKE_PORT` 改 |

另外两个不用浏览器的：`node_modules/.bin/tsx scripts/bench/long-world.ts [--turns 1000]` 在内存里造一个千回合的世界，给首页、游玩页和组装下一回合计时；`node_modules/.bin/tsx scripts/check-eras.ts` 逐个检查内置卡组，列出问题和时代卡的长度。

## 构建

### 安卓

```powershell
. .\scripts\Enter-Dev.ps1
pnpm tauri android build --debug --target aarch64 --apk --ci   # 调试包
pnpm tauri android build --target aarch64 --apk --ci           # 发行包（未签名）
```

调试包是 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`（约 220 MB，带调试信息），发行包是旁边的 `universal/release/app-universal-release-unsigned.apk`，签名后才能安装：

```powershell
$env:LISHI_SIGNING_STORE_PASSWORD = 'android'   # 安卓调试证书的默认密码，只放在本次进程里
./scripts/Sign-AndroidPreview.ps1 `
  -UnsignedApk src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk `
  -ReferenceApk src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk `
  -KeystorePath $HOME/.android/debug.keystore `
  -OutputPath .cache/release/chuanyue-<版本>.apk
```

`scripts/Verify-AndroidPackage.ps1 -ApkPath <apk> [-Profile debug] [-ReferenceApk <apk>]` 不连手机地检查一个安装包：应用 ID、发行包不可调试、v2 签名且证书与参考包一致、ZIP 与原生库的 16 KB 对齐、包里的 ARM64 原生库与刚编译的一致、Rust 用到的系统桥接类都在、声明了安装更新所需的权限。从别的目录运行时，`-ApkPath`、`-OutputPath` 请写绝对路径。

**签名与覆盖安装**：安卓只允许用同一个证书签名的新包覆盖旧包。发布页上的安装包用作者电脑上的安卓调试证书签名，这样调试包和发行包能互相覆盖、保留存档。你自己构建的包用的是你电脑上的调试证书，和发布页的包签名不同，系统不会让两者互相覆盖。想换成自己构建的版本，先在首页把每个世界导出成文件，卸载、安装之后再导入：卸载会删掉所有的世界。

发行包暂时没有开 R8 精简，所以比可以做到的大一些。

### Windows

```powershell
. .\scripts\Enter-Dev.ps1
pnpm tauri build --debug --no-bundle   # 调试版：target\debug\lishi-app.exe
pnpm tauri build                       # 安装包和单个程序
```

- 安装包是 `target\release\bundle\nsis\历史穿越_<版本>_x64-setup.exe`：只装给当前用户，不需要管理员，装到 `%LOCALAPPDATA%\历史穿越`；安装界面是简体中文，自动建开始菜单快捷方式，完成页可以勾选桌面快捷方式。卸载时“删除应用程序数据”默认不勾，不勾就不会删掉世界。WebView2 用在线引导安装（Windows 10、11 一般已经自带）。
- 单个程序是 `target\release\lishi-app.exe`，打成 zip 就是免安装版。它不是“数据放在旁边”的便携版：数据和安装版一样放在 `%APPDATA%\io.timejump.chuanyue`，两者共用同一份存档。
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

2. 准备一个当作“新版本”的安装包：必须用同一个证书签名，内部版本号不低于手机上的包。用自己签名的发行包最快（约 23 MB）；直接用刚才的调试包也行，但约 220 MB，传得慢。
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

1. `node scripts/ui/icon.mjs` 用思源宋体（SIL OFL，从 Google Fonts 加载，要联网）把它们渲染成 1024×1024 的 PNG。
2. `pnpm tauri icon assets/app-icon.png --ios-color "#efe5cf"` 生成安卓图标。这个颜色参数同时决定安卓自适应图标的纸色背景，写进 `res/values/ic_launcher_background.xml`；不要在别的文件里再定义同名颜色，否则安卓打包会报资源重复。
3. `pnpm tauri icon assets/app-icon-desktop.png --output .cache/icons-desktop` 生成电脑图标，把其中除 `android/`、`ios/` 以外的文件复制到 `src-tauri/icons/`。

界面的配色、字体和组件见[设计规范](design/DESIGN_SPEC.md)。

## 数据放在哪里

- **安卓**：应用的私有目录，卸载即删除。Key 用系统 Keystore 加密保存。
- **Windows**：`%APPDATA%\io.timejump.chuanyue`，里面有数据库 `game.sqlite`、每日备份 `backups/`（保留最近 20 份）和 `window-state.json`。Key 用当前 Windows 用户的 DPAPI 加密保存，换一台电脑或换一个用户就读不出来。
- **浏览器开发台**：存档在浏览器里，开发用的 Key 在 `.cache/dev-secrets.json`。

不要把 Key、令牌或私人的服务地址写进代码、文档、日志和提交；`.cache/`、`.env.local`、`.private/` 都已经被 Git 忽略。
