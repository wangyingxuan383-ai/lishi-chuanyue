# 当前工作现场

> 更新：2026-10-17（Asia/Shanghai）· 阶段：**R04 记忆与连续性（进行中）**；R02、R03 等集中试玩 · 分支：`main`

## 现在在哪

- R01 已完成。R02、R03 的工程部分已完成（[R02 验证](validation/R02.md)、[R03 验证](validation/R03.md)），阶段验收 R02-T015、R03-T006 等集中试玩与问卷（D118）。
- R04：T002“记住这件事”、T003 章节摘要与记事页、T004 上下文预算与查看器已完成；T001 游玩中整理设定集与人物志的工程已完成（D122），等评测 E 的审读结果关闭。前端测试 250 项、手机尺寸流程 68 项通过。
- 真实模型评测：R03 评测 A（turn-5，50 回合）除抢话 12% 外达标；据此改出 turn-6 并补唐卡组禁词。R04 评测 E（turn-6 + upkeep-1，30 回合，67 次调用）已跑完：30/30 成功、直接解析 29/30、按逐回合游戏时间筛查时辰没有不符、AI 整理的卡片和地点与剧情相符；抢话与明清用语的逐回合审读还在进行（Claude 子代理），结果写进 [R04 评测](validation/R04_EVAL.md) 的 E 节。
- 手机 APK 是 R03 中途打的包，还没装（无线 ADB 断开，需要用户扫码配对）；装之前要按当前代码重新打包。

## 下一步

1. 拿到评测 E 的审读结果：写进 R04_EVAL 的 E 节；抢话严重的回合 ≤ 5% 就关闭 R03-T003、R02-T014 和 R04-T001，否则再改提示词（turn-7）并登记复测。
2. R04-T005 长局评测：先在 R04_EVAL 登记（唐 · 万年县不良人与一个没有卡组的朝代各 150 回合，打开记忆探针 `--probe-at 60,100,150`，按评测 E 的用量估算调用和 token 上限），确认登记写进文件后再跑；记忆探针用 Claude 子代理判对错。
3. R04-T006 阶段验收：整理 `docs/validation/R04.md`，等集中试玩。之后进入 R05 时间与世界推进。
4. 用户方便时：重新打包 APK，扫码配对后 `install -r` 装到手机，R02、R03、R04 集中试玩。

## 需要注意

- 用户服务地址与 Key 在本机 `.cache/dev-secrets.json`（不入 Git，**不要改动其中的 `main`**），评测脚本从这里读取，不打印。文档、代码、日志都不写服务地址或 Key；提交前运行 `node .cache/v3-edit/scan.mjs` 扫描暂存文件。
- 真实模型评测花用户的钱：运行前在验证文档里登记调用上限，并确认登记已经写进文件。
- 手机：小米 24117RK2CC，无线 ADB（断开后需重新扫码配对，见 DEVELOPMENT）。安装只用 `adb -s <serial> install -r <apk>` 保留数据。用户手机上有真实存档，**不要运行会清空数据的 `scripts/ui/phone-flow.mjs`**，不要卸载旧版 Lishi Probe。
- 界面调试：`node scripts/fake-llm.mjs`（18800，改了它要重启）+ `corepack pnpm dev`（1420）+ `node scripts/ui/game-flow.mjs`。浏览器开发台写库后 1 秒才存盘，流程里刷新页面前要等一下。
- 用 Python 改文件时以 `write_bytes(s.encode("utf-8"))` 写回，避免 Windows 换行变成 CRLF；含反斜杠的 Python 脚本用文件写，不要用 bash heredoc（反斜杠会被吞掉）。
- PowerShell 先 `. .\scripts\Enter-Dev.ps1`（cargo 等只在其中可用）；Git 提交用 `git -c user.name=Claude -c user.email=noreply@anthropic.com commit ...`。
