# 开发环境与命令

> 更新：2026-10-16（Asia/Shanghai）。v3 的开发命令会在 R01 完成后重写；当前仍是 v2 代码，下面的工具基线来自 v2 实测（2026-10-12 核实），v3 继续沿用。v2 完整开发说明见[归档](archive/v2/DEVELOPMENT.md)。

## 本机工具基线

| 工具 | 版本 / 位置 |
| --- | --- |
| Node / npm | 24.19.0 / 11.17.0，`C:\Program Files\nodejs` |
| pnpm | 11.25.0（`package.json` 的 `packageManager` 固定） |
| Rust / Cargo | 1.99.0，用户 `.cargo/bin`；`rust-toolchain.toml` 固定版本与 Android target |
| Windows C++ | VS 2022 BuildTools 17.14，`C:\DevTools\LishiBuildTools` |
| WebView2 | 已安装 |
| JDK | Temurin 17.0.20.1+1，`C:\Users\Windows11\AppData\Local\Programs\LishiToolchain\jdk-17.0.20.1+1` |
| Android SDK | `C:\Users\Windows11\AppData\Local\Android\Sdk`；API 36、Build Tools 36.0.0、NDK 28.2.13676358 |
| Gradle / AGP | wrapper 9.6.1 / AGP 9.3.3 |
| 前端 / Tauri | React 19.3、TypeScript 7.0.2、Vite 8.3.4、Tauri CLI 2.12.2、`@tauri-apps/api` 2.12.3 |

机器相关路径放在不入 Git 的 `.private/toolchain.json`（`javaHome`、`androidHome`，可选 `javaProxyHost`/`javaProxyPort`），由 `scripts/Enter-Dev.ps1` 读取，只设置当前进程环境。

## 当前可用命令（v2 代码，R01 后更新）

```powershell
. .\scripts\Enter-Dev.ps1                 # 设置当前进程的 JAVA_HOME / ANDROID_HOME 等
pnpm install --frozen-lockfile
pnpm build                                 # 类型检查 + 前端构建
pnpm tauri build --no-bundle               # Windows 优化构建
pnpm tauri android build --target aarch64 --apk --ci   # Android ARM64 APK
node scripts/check-docs.mjs                # 文档检查
```

APK 签名与包检查：`scripts/Sign-AndroidPreview.ps1`、`scripts/Verify-AndroidPackage.ps1`（细节见[归档交付说明](archive/v2/RELEASE.md)）。

## 手机连接

- 无线配对：`python scripts/Pair-AndroidQr.py` 生成二维码，手机“开发者选项 → 无线调试 → 使用二维码配对设备”扫码。
- 小米手机 `adb install` 曾返回 `INSTALL_FAILED_USER_RESTRICTED`。R01-T005 将尝试开启“USB 安装”“USB 调试（安全设置）”；不行则用 `adb push` 把 APK 放到 `/sdcard/Download/`，由用户在文件管理器里点击安装。

## v3 计划中的开发方式（R01 落地后在此更新）

- **浏览器开发台**：`pnpm dev` 后在浏览器开发者工具中切换手机尺寸（393×852、360×800），用真实模型直接游玩；Key 放在本地 `.env.local`（不入 Git）。见 [PLAN_V3](PLAN_V3.md) 第 8.1 节与 D108。
- **真机热更新**：尝试 `pnpm tauri android dev --host`（需 Vite 监听 `TAURI_DEV_HOST`）。
- **评测**：`scripts/eval/`（R01-T004、R02-T009 建立）。
