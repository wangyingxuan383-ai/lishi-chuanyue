# 开发环境与命令

> 更新：2026-10-16（Asia/Shanghai），对应 R01。工具基线来自 v2 实测（2026-10-12 核实）并继续沿用；v2 完整开发说明见[归档](archive/v2/DEVELOPMENT.md)。

## 本机工具基线

| 工具 | 版本 / 位置 |
| --- | --- |
| Node / npm | 24.19.0，`C:\Program Files\nodejs` |
| pnpm | 11.25.0，经 corepack 使用（bash 中写 `corepack pnpm ...`；PowerShell 执行 Enter-Dev 后可直接用 `pnpm`） |
| Rust / Cargo | 1.99.0；`rust-toolchain.toml` 固定版本与 Android target |
| Windows C++ | VS 2022 BuildTools 17.14，`C:\DevTools\LishiBuildTools` |
| JDK | Temurin 17.0.20.1+1，`%LOCALAPPDATA%\Programs\LishiToolchain\jdk-17.0.20.1+1` |
| Android SDK | `%LOCALAPPDATA%\Android\Sdk`（手机脚本从 `ANDROID_HOME` 读取，没设置时用这里）；API 36、Build Tools 36.0.0、NDK 28.2.13676358 |
| Gradle / AGP | wrapper 9.6.1 / AGP 9.3.3 |
| 前端 | React 19.3、TypeScript 7.0.2、Vite 8.3.4、`@tauri-apps/api` 2.12.3、sql.js、vitest、playwright-core、tsx |

机器相关路径放在不入 Git 的 `.private/toolchain.json`（`javaHome`、`androidHome`，可选 `javaProxyHost`/`javaProxyPort`），由 `scripts/Enter-Dev.ps1` 读取，只设置当前 PowerShell 进程的环境。

## 常用命令

```powershell
. .\scripts\Enter-Dev.ps1                 # JAVA_HOME / ANDROID_HOME / NDK_HOME / pnpm 垫片
pnpm install --frozen-lockfile
pnpm test                                  # vitest 单元测试
pnpm build                                 # 类型检查 + 前端构建
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                     # Rust 平台服务测试（只连本机测试服务）
pnpm tauri build --debug --no-bundle       # Windows：target\debug\lishi-app.exe
pnpm tauri android build --debug --target aarch64 --apk --ci   # Android debug APK
pnpm tauri android build --target aarch64 --apk --ci          # Android 发行包（未签名），签名与检查见 RELEASE.md
.\scripts\Verify-AndroidPackage.ps1 -Profile debug -ApkPath src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
node scripts/check-docs.mjs                # 文档检查
```

## 浏览器开发台（日常开发主要用这个）

1. 可选：复制 `.env.example` 为 `.env.local`，预填服务地址与模型（`.env.local` 不入 Git）。
2. `corepack pnpm dev`，浏览器打开 `http://127.0.0.1:1420`，开发者工具切换为手机尺寸（393×852 或 360×800）。
3. 在页面中填写服务地址、模型和 Key 并保存。Key 只保存在开发服务器本机的 `.cache/dev-secrets.json`（不入 Git），页面本身拿不到；请求经开发服务器中间件转发（只接受本机访问）。
4. 不想花 token 时，用本地模拟模型：`node scripts/fake-llm.mjs`（端口 18800），服务地址填 `http://127.0.0.1:18800/v1`，模型选 `fake-normal` / `fake-slow` / `fake-http500` / `fake-stall` / `fake-nostream`，Key 随便填。

自动化检查：

以下脚本都需要先启动模拟模型和 `pnpm dev`，截图在 `.cache/ui/`：

- 手机尺寸完整流程：`node scripts/ui/game-flow.mjs`（R02 起替代了旧的 `devcheck.mjs`）。
- 桌面宽屏：`node scripts/ui/desktop.mjs`（双栏布局、回车发送、窄窗口退回手机布局）。
- 全部主要界面在三套主题下的截图与拼图：`node scripts/ui/screens.mjs [--out docs/images]`。
- 应用图标（这一条不需要模拟模型和开发服务器，但要联网下载字体）：改了 `assets/app-icon.svg` 或 `app-icon-desktop.svg` 后，`node scripts/ui/icon.mjs` 用开源字体渲染成 PNG；再 `pnpm tauri icon assets/app-icon.png --ios-color "#efe5cf"` 生成安卓图标（这个颜色参数同时决定安卓自适应图标的纸色背景，写进 `res/values/ic_launcher_background.xml`；不要在别的文件里再定义同名颜色，否则安卓打包报重复资源），然后用 `pnpm tauri icon assets/app-icon-desktop.png --output .cache/icons-desktop` 生成桌面图标，把其中除 `android/`、`ios/` 以外的文件复制到 `src-tauri/icons/`。
- 千回合世界的打开与滚动：`node scripts/ui/long-world.mjs`；引擎侧计时 `node_modules/.bin/tsx scripts/bench/long-world.ts`。
- Windows 原生：`native-devcheck.mjs` 是 R01 时针对调试页写的，界面已经换掉，需要按现在的界面改写后才能再用；它还会改写原生版的服务设置，本机原生版里有用户数据时不要运行。

## 评测

- 评测脚本用 `node_modules/.bin/tsx` 运行，Key 读取开发台保存的 `.cache/dev-secrets.json`（槽位 `main`），不打印 Key。
- 格式实验（R01-T004）：`node_modules/.bin/tsx scripts/eval/format-experiment.ts --model <模型> [--formats A,B,C] [--turns 20] [--max-calls 90]`，原始记录在 `.cache/eval/format-<时间>/`。

## 手机连接

- 无线配对：`python scripts/Pair-AndroidQr.py` 生成二维码，手机“开发者选项 → 无线调试 → 使用二维码配对设备”扫码。
- 小米手机 `adb install` 曾返回 `INSTALL_FAILED_USER_RESTRICTED`。可尝试在开发者选项中开启“USB 安装”“USB 调试（安全设置）”（R01-T005）；不行则 `adb push <apk> /sdcard/Download/`，由用户在文件管理器中点击安装。
- 热更新尝试：`pnpm tauri android dev --host`（R01-T005 验证）。
