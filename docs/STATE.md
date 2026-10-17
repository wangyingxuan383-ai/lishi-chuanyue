# 当前工作现场

> 更新：2026-10-17（Asia/Shanghai）· 阶段：**0.9.0 预发布（V4 第一、二档），等真机试玩** · 分支：`main`（推送到 https://github.com/wangyingxuan383-ai/lishi-chuanyue）

## 现在在哪

- **0.9.0 是第二个公开版本**，预发布在 GitHub，含 R11（服务设置、独立设置页、通知、开局、指南）和 R12（目录与搜索、小传、电脑端、安卓、角色面板、视觉），以及运势只作参考（R11-T008）。都没在手机上试过。
- 发布前审查见 [REVIEW_0.9.0](validation/REVIEW_0.9.0.md)：高、中问题已修，少数低问题留到下一版（“写好了”通知的时机、链接白名单、代理密码提示）。
- 自动检查（2026-10-17）：前端 369 项、手机尺寸流程 151 项、桌面 43 项、Rust 49 项与 fmt、clippy 通过。
- 用户纠正了下一步的方向（D129）：**内容上的规定越少越好**，不加科举、怀疑度这类定剧情的系统，先删减现有规定。三份调研已写好：[FREE_MODE](research/FREE_MODE.md)、[HISTORY_MECHANICS](research/HISTORY_MECHANICS.md)（第 2 节列出可删减的规定）、[FEATURE_SURVEY](research/FEATURE_SURVEY.md)。

## 下一步

1. 按三份调研和 D129 写 R13b 的任务：先做“精简提示词与规则”（与 turn-15 对比评测，要先登记调用上限）、异世界模式的最小版本（关掉历史规则 + 世界卡 + 模板）、调研里推荐的第一批工具类功能（选中改写、帮我润色行动、我的要求组等）。立项前把调研“待你决定”的几项带给用户。
2. 评测 G7（运势只作参考）已登记、未运行，跑之前确认上限。
3. 需要用户的：0.9.0 真机试玩与问卷；异世界模式的取舍（关闭清单、主角面板、知名作品世界入口）；死亡开关默认值；许可证。

## 需要注意

- **推送和发布都要用户同意**：0.8.0 这次的同意不延续到以后（D126）。推送前跑 `node .cache/v3-edit/scan.mjs`（暂存文件）和 `scan-history.mjs`（全历史），只输出计数。GitHub 命令行 `gh` 已登录用户账户（本机路径不写进仓库）；不要打印令牌。
- 用户服务地址与 Key 在本机 `.cache/dev-secrets.json`（不入 Git，**不要改动其中的 `main`**），评测脚本从这里读取，不打印。文档、代码、日志都不写服务地址或 Key。
- 真实模型评测花用户的钱：运行前在验证文档里登记调用上限，并确认登记已经写进文件。长局评测保存整局（`--save-db`），之后改记忆方案只需用 `probe.ts` 重新提问。后台任务被停止时只结束外层 shell，评测的 node 进程会继续跑，要停就结束对应的 node 进程。
- 手机：小米 24117RK2CC，无线 ADB（断开后需重新扫码配对，见 DEVELOPMENT）。安装只用 `adb -s <serial> install -r <apk>` 保留数据。**不要运行会清空数据的 `scripts/ui/phone-flow.mjs`**，不要卸载旧版 Lishi Probe。
- 界面调试：模拟模型 `node scripts/fake-llm.mjs`（18800）放在测试命令里一起起停；`corepack pnpm dev`（1420）；`node scripts/ui/game-flow.mjs`（手机尺寸）/ `desktop.mjs`（宽屏）/ `screens.mjs`（三套主题的全部主要界面截图）。浏览器开发台写库后 1 秒才存盘，刷新页面前要等一下。
- 用 Python 改文件时以 `write_bytes(s.encode("utf-8"))` 写回；含反斜杠的 Python 脚本用 Write 工具写成文件，不要用 bash heredoc（反斜杠会被吞掉）。
- PowerShell 先 `. .\scripts\Enter-Dev.ps1`（cargo 等只在其中可用）；Git 提交用 `git -c user.name=Claude -c user.email=noreply@anthropic.com commit ...`。
