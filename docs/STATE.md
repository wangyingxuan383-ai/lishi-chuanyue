# 当前工作现场

> 更新：2026-10-17（Asia/Shanghai）· 阶段：**R04 记忆与连续性（进行中）**；R02、R03 等集中试玩 · 分支：`main`

## 现在在哪

- R01 已完成。R02、R03 的工程部分已完成（[R02 验证](validation/R02.md)、[R03 验证](validation/R03.md)），阶段验收 R02-T015、R03-T006 等集中试玩与问卷（D118）。
- R03 按“自定义优先”（D121）完成：设定集、AI 整理设定集、纪年与货币规则、开局模板与分享。真实模型评测 C（三个自写设定）通过；A（唐卡组 50 回合，turn-5）已跑完：50 回合全部成功、记录全部直接解析、时代错误词 0、八股词 1 次、输入 token 稳定在 9.2k～9.7k。抢话的逐段审读还没写进 [R03 评测](validation/R03_EVAL.md)。
- R04-T002“记住这件事”已完成（剧情要点按路线生效，叙事方针真实模型对照通过，[R04 评测](validation/R04_EVAL.md)）。前端测试 222 项、手机尺寸流程 60 项通过。
- 手机 APK 是 R03 中途打的包，还没装（无线 ADB 断开，需要用户扫码配对）；装之前要按当前代码重新打包。

## 下一步

1. 写完 R03 评测 A（抢话审读、时辰与游戏时间的偏差），据此关闭 R03-T003 和 R02-T014。评测里时辰对比只能估算（这次没记录游戏时间）；脚本已补上逐回合游戏时间，R04-T005 长局评测时再精确核对。
2. R04-T001 故事卡自动维护与人物志：每若干回合用辅助模型提议新的势力、地点、物品卡并更新已有卡片（标“AI 整理”，可撤销），人物志完整版，在场人物优先进入上下文。
3. R04-T003 章节自动摘要（`chapters` 表已存在），之后 R04-T004 上下文预算器与查看器、R04-T005 150 回合长局评测（先登记上限）。
4. 用户方便时：重新打包 APK，扫码配对后 `install -r` 装到手机，R02-T015 与 R03-T006 集中试玩。

## 需要注意

- 用户服务地址与 Key 在本机 `.cache/dev-secrets.json`（不入 Git，**不要改动其中的 `main`**），评测脚本从这里读取，不打印。文档、代码、日志都不写服务地址或 Key；提交前运行 `node .cache/v3-edit/scan.mjs` 扫描暂存文件。
- 真实模型评测花用户的钱：运行前在验证文档里登记调用上限，并确认登记已经写进文件。
- 手机：小米 24117RK2CC，无线 ADB（断开后需重新扫码配对，见 DEVELOPMENT）。安装只用 `adb -s <serial> install -r <apk>` 保留数据。用户手机上有真实存档，**不要运行会清空数据的 `scripts/ui/phone-flow.mjs`**，不要卸载旧版 Lishi Probe。
- 界面调试：`node scripts/fake-llm.mjs`（18800）+ `corepack pnpm dev`（1420）+ `node scripts/ui/game-flow.mjs`。
- 用 Python 改文件时以 `write_bytes(s.encode("utf-8"))` 写回，避免 Windows 换行变成 CRLF。
- PowerShell 先 `. .\scripts\Enter-Dev.ps1`（cargo 等只在其中可用）；Git 提交用 `git -c user.name=Claude -c user.email=noreply@anthropic.com commit ...`。
