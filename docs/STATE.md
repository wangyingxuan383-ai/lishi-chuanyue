# 当前工作现场

> 更新：2026-10-16（Asia/Shanghai）· 阶段：**R01 技术底座与开发回路** · 分支：`main`

## 现在在哪

- R00 已完成：计划 [PLAN_V3](PLAN_V3.md) 经用户确认（内容尺度改为玩家可调挡位，D114；允许调用本机 Codex 官方模型分工，D115）。
- R01 大部分工程已完成并验证，详见 [R01 验证](validation/R01.md)：
  - 新应用标识 `io.timejump.chuanyue` /“历史穿越”；v2 前端和 Rust 核心已删除（旧代码在标签 `legacy-v2-final`）。
  - 浏览器开发台（R01-T002）已完成；Rust 平台服务（R01-T003）由 Codex 实现、已核查，Windows 原生实测通过；Android debug APK 构建与包检查通过。
  - 格式实验脚本已就绪（R01-T004），**尚未对真实模型运行**。
- 当前界面只有 R01 临时“开发自检”页，游戏界面从 R02 开始。

## 下一步

1. **等用户在浏览器开发台保存真实服务**：用户运行开发台（见 [DEVELOPMENT](DEVELOPMENT.md)“浏览器开发台”），在页面里填服务地址、模型、Key 并点保存，Key 只写入本机 `.cache/dev-secrets.json`。然后运行格式实验：`node_modules/.bin/tsx scripts/eval/format-experiment.ts --model <模型> --max-calls 90`，阅读 `.cache/eval/format-*/` 中的正文，写 `docs/validation/R01_FORMAT.md` 并选定格式（V101）。
2. **手机**（R01-T001 验收、R01-T003 真机、R01-T005）：无线 ADB 连接后安装 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`（约 213 MB），确认与旧版共存；在手机上用自检页测流式、停止、切后台 1 分钟、关闭重开、返回键（手势与三键导航）。
3. 两项完成后做 R01-T006 阶段验收，然后开始 R02-T001（数据层）。

## 需要注意

- 用户的模型服务是第三方 HTTP 中转，地址与 Key 不写进任何文档或代码；只能由用户在开发台或应用里填写。
- 用户手机：小米 Android 16（24117RK2CC），无线 ADB；`adb install` 曾被拒绝（`INSTALL_FAILED_USER_RESTRICTED`），可 `adb push` 到 `/sdcard/Download/` 让用户手动安装。手机上的旧版 “Lishi Probe” 不要卸载或清数据。
- Codex 只用官方 provider：`codex exec -c model_provider=openai -c model_reasoning_effort=high -s workspace-write ...`；任务说明与报告放 `.cache/codex/`。
- PowerShell 里先 `. .\scripts\Enter-Dev.ps1`（会自动提供 `pnpm` 垫片）；Git 提交用 `git -c user.name=Claude -c user.email=noreply@anthropic.com commit ...`。
- 本机可能有遗留的后台进程：`scripts/fake-llm.mjs`（端口 18800）、`pnpm dev`（端口 1420），需要时可直接结束。
