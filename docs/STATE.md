# 当前工作现场

> 更新：2026-10-16（Asia/Shanghai）· 阶段：**R02 核心回合体验（刚开始）** · 分支：`main`

## 现在在哪

- **R01 已完成**（[R01 验证](validation/R01.md)、[格式实验](validation/R01_FORMAT.md)）：
  - 新应用“历史穿越”（`io.timejump.chuanyue`）已装在用户手机上，与旧版共存。
  - 浏览器开发台、Windows 原生、Android 真机都能流式生成、存库、重启保留；手机返回键（按键与手势）已接管。
  - 真机发现 Android 15+ 会在后台约 5 秒切断网络 → 已加生成期间的前台服务（D116），复测通过。
  - 回合格式选定 **A：正文 + `<record>` JSON**（V101）。用户服务 `gemini-3.8-flash-high` 首字中位约 7 秒，偏慢（V103）。
- **R02 已开工**：数据层（R02-T001）、回合树（R02-T002）、记账规则（R02-T004）的核心代码与 31 项测试已完成，状态为“进行中”。前端单元测试共 65 项通过。
- 界面仍只有 R01 临时“开发自检”页。

## 下一步

1. R02-T003 流式分离与宽容解析：按格式 A 实现 `<record>` 的流式切分（标签跨分片）与宽容 JSON 解析，至少 20 种畸形输入测试。可复用 `scripts/eval/format-experiment.ts` 里的 `lenientJson`/`splitA` 思路。
2. R02-T005 回合管线：上下文 v1（含人物简表、目标、可用钱物）+ 主调用 + 补记 + 拒答识别 + 停止/中断；然后 R02-T014 提示词 v1（要求人物改名时写 `aliases`、禁用“算盘”等）。
3. 之后做界面：R02-T006 设置与引导、R02-T007～T011 游玩界面与角色面板、R02-T012 开局。
4. 评测对照：找一个不带推理的模型（如服务上的 `gemini-3-flash`）跑同样的剧本比较首字延迟（V103）。

## 需要注意

- 用户的服务地址与 Key 已保存在本机 `.cache/dev-secrets.json`（开发台写入，不入 Git）；评测脚本从这里读取，不打印。任何文档、代码、日志都不写服务地址或 Key。
- 手机：小米 24117RK2CC，无线 ADB 已配对（会话断开后需重新扫码：`python scripts/Pair-AndroidQr.py --adb <adb路径> --output .cache/device/pair-qr.png --result .cache/device/pair-result.json`）。安装：`adb -s <serial> install -r <apk>`。旧版 “Lishi Probe” 不要卸载。
- Codex 只用官方 provider：`codex exec -c model_provider=openai -c model_reasoning_effort=high -s workspace-write ...`；说明与报告放 `.cache/codex/`。Codex 沙箱里无法跑 Android 构建，由主代理构建。
- PowerShell 先 `. .\scripts\Enter-Dev.ps1`；Git 提交用 `git -c user.name=Claude -c user.email=noreply@anthropic.com commit ...`。
- 本机可能有遗留后台进程：`scripts/fake-llm.mjs`（18800）、`pnpm dev`（1420）。
