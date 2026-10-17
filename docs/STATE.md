# 当前工作现场

> 更新：2026-10-17（Asia/Shanghai）· 阶段：**V4 第一档（R11）工程完成，等真机试玩；R11 改动未推送** · 分支：`main`（已推送到 https://github.com/wangyingxuan383-ai/lishi-chuanyue）

## 现在在哪

- **V4 第一档（R11）工程完成，等真机试玩**：按 [第四版总计划](PLAN_V4.md) 做了精细度与交互、AI 服务设置、独立设置页、通知与安卓兼容、开局两步化、游玩指南、首页书架（详见台账 R11-T001～T007 与更新记录）。依据的调研与审查都在 `docs/research/UX_*.md`、`ANDROID_COMPAT.md`、`docs/validation/AUDIT_V4*.md`。
- 仓库已公开（D127），没有许可证；0.8.0 预发布在 GitHub。R11 的改动在本机提交，**还没推送，也没出新包**。
- 自动检查（2026-10-17）：前端 333 项、手机尺寸流程 111 项、桌面 18 项、Rust 43 项与 fmt、clippy 通过；安卓发行包能编译。

## 下一步

1. 用户手机试玩反馈（用户说会先试 0.8.0）；之后可以出 0.9.0 预发布（需要用户同意推送和发布）。
2. 功能审查（`AUDIT_V4_FUNCTION.md`）里还没做的：辅助模型失败的提示（A2 部分已做）、备份恢复（B2）、世界记住自己的服务（B5）、“我”页改名字身份（F7）、行囊物品编辑（F8）、年表大事改日期（F9、F2）、“我的开局”管理（D5）、路线重名（G1）、引擎没生效时不写“你修改了”（H1）。
3. 第二档（R12）：回目目录与搜索、分享长图、结语与列传、前情提要、成就与统计、电脑端快捷键与安装包；第三档评估：朗读、插图、网页版。
4. 需要用户的：真机试玩与问卷；许可证；每次推送和发布的同意。

## 需要注意

- **推送和发布都要用户同意**：0.8.0 这次的同意不延续到以后（D126）。推送前跑 `node .cache/v3-edit/scan.mjs`（暂存文件）和 `scan-history.mjs`（全历史），只输出计数。GitHub 命令行 `gh` 已登录用户账户（本机路径不写进仓库）；不要打印令牌。
- 用户服务地址与 Key 在本机 `.cache/dev-secrets.json`（不入 Git，**不要改动其中的 `main`**），评测脚本从这里读取，不打印。文档、代码、日志都不写服务地址或 Key。
- 真实模型评测花用户的钱：运行前在验证文档里登记调用上限，并确认登记已经写进文件。长局评测保存整局（`--save-db`），之后改记忆方案只需用 `probe.ts` 重新提问。后台任务被停止时只结束外层 shell，评测的 node 进程会继续跑，要停就结束对应的 node 进程。
- 手机：小米 24117RK2CC，无线 ADB（断开后需重新扫码配对，见 DEVELOPMENT）。安装只用 `adb -s <serial> install -r <apk>` 保留数据。**不要运行会清空数据的 `scripts/ui/phone-flow.mjs`**，不要卸载旧版 Lishi Probe。
- 界面调试：模拟模型 `node scripts/fake-llm.mjs`（18800）放在测试命令里一起起停；`corepack pnpm dev`（1420）；`node scripts/ui/game-flow.mjs`（手机尺寸）/ `desktop.mjs`（宽屏）/ `screens.mjs`（三套主题的全部主要界面截图）。浏览器开发台写库后 1 秒才存盘，刷新页面前要等一下。
- 用 Python 改文件时以 `write_bytes(s.encode("utf-8"))` 写回；含反斜杠的 Python 脚本用 Write 工具写成文件，不要用 bash heredoc（反斜杠会被吞掉）。
- PowerShell 先 `. .\scripts\Enter-Dev.ps1`（cargo 等只在其中可用）；Git 提交用 `git -c user.name=Claude -c user.email=noreply@anthropic.com commit ...`。
