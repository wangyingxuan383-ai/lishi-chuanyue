# 当前工作现场

> 更新：2026-10-17（Asia/Shanghai）· 阶段：**R02～R10 里不需要手机的工程都已完成，0.8.0 已发布到 GitHub 私有仓库，等用户在手机上试玩** · 分支：`main`（已推送到 https://github.com/wangyingxuan383-ai/lishi-chuanyue）

## 现在在哪

- 0.8.0（预发布）：[GitHub 发布](https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/tag/v0.8.0)，附安卓 APK 和 Windows 压缩包；APK 签名与包检查通过，Windows 程序本机能启动；**都还没在手机上装过**。仓库私有，许可证未定（D126）。
- R04-T005 长局评测已完成：评测 I 记忆探针 94%（远程 96%），第 100 回合输入约 11.7k token（[R04 评测](validation/R04_EVAL.md)）；审读发现的三个问题已改。剩下的改进想法在候选池里。
- R09：视觉方向由 Claude 按用户授权选定（D125），全部界面、图标、启动页已重做（[设计规范](design/DESIGN_SPEC.md)）；T002、T003 待真机验收。
- 阶段验收 R02～R10（试玩与问卷，D109、D118）都等用户在手机上试玩；R08 的 T001（系统选择器）、T002（生命周期）、T003（千回合真机测速）、T005（覆盖安装）差真机部分；R10-T001 等用户在 Windows 上试宽屏。
- 发布前自查（[记录](validation/REVIEW_0.8.0.md)）：前端测试 328 项、手机尺寸流程 88 项、桌面宽屏检查 18 项、Rust 测试 42 项、fmt 与 clippy 通过；代码审查发现的 9 个问题（2 个中等、7 个轻微）都已改（2026-10-17）。

## 下一步

1. 用户能用手机时：从 Releases 下载 `chuanyue-0.8.0.apk` 覆盖安装（不要先卸载），或无线配对后 `adb -s <serial> install -r`；装好后按 [私人发行包](RELEASE.md) 的检查项看一遍，再集中试玩、填问卷，逐个关闭各阶段验收。
2. 用户决定许可证和是否公开（[公开前检查](validation/R10_PUBLIC.md)）；公开前写 LICENSE、补 `license` 字段、再扫一遍历史。
3. 候选池里评测 I 留下的改进（关键物证钉住原文、垂危时行动受限、对白口头语、长局节奏与主线），经用户同意再立项；改提示词要登记调用上限再评测。

## 需要注意

- **推送和发布都要用户同意**：0.8.0 这次的同意不延续到以后（D126）。推送前跑 `node .cache/v3-edit/scan.mjs`（暂存文件）和 `scan-history.mjs`（全历史），只输出计数。GitHub 命令行 `gh` 已登录用户账户（本机路径不写进仓库）；不要打印令牌。
- 用户服务地址与 Key 在本机 `.cache/dev-secrets.json`（不入 Git，**不要改动其中的 `main`**），评测脚本从这里读取，不打印。文档、代码、日志都不写服务地址或 Key。
- 真实模型评测花用户的钱：运行前在验证文档里登记调用上限，并确认登记已经写进文件。长局评测保存整局（`--save-db`），之后改记忆方案只需用 `probe.ts` 重新提问。后台任务被停止时只结束外层 shell，评测的 node 进程会继续跑，要停就结束对应的 node 进程。
- 手机：小米 24117RK2CC，无线 ADB（断开后需重新扫码配对，见 DEVELOPMENT）。安装只用 `adb -s <serial> install -r <apk>` 保留数据。**不要运行会清空数据的 `scripts/ui/phone-flow.mjs`**，不要卸载旧版 Lishi Probe。
- 界面调试：模拟模型 `node scripts/fake-llm.mjs`（18800）放在测试命令里一起起停；`corepack pnpm dev`（1420）；`node scripts/ui/game-flow.mjs`（手机尺寸）/ `desktop.mjs`（宽屏）/ `screens.mjs`（三套主题的全部主要界面截图）。浏览器开发台写库后 1 秒才存盘，刷新页面前要等一下。
- 用 Python 改文件时以 `write_bytes(s.encode("utf-8"))` 写回；含反斜杠的 Python 脚本用 Write 工具写成文件，不要用 bash heredoc（反斜杠会被吞掉）。
- PowerShell 先 `. .\scripts\Enter-Dev.ps1`（cargo 等只在其中可用）；Git 提交用 `git -c user.name=Claude -c user.email=noreply@anthropic.com commit ...`。
