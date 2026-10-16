# 当前工作现场

> 更新：2026-10-17（Asia/Shanghai）· 阶段：**R03 时代感与纪年（进行中，方向待用户确认）** · 分支：`main`

## 现在在哪

- R01 已完成。R02 工程部分已完成（[R02 验证](validation/R02.md)），阶段验收 T015 等集中试玩与问卷（D118）。
- R03 已完成：时代包格式、校验与[写作指南](contracts/ERA_PACK.md)（T001，D120）；纪年接入顶栏、面板、首页与提示词，点顶栏看“此时此地”，过年长一岁，提示词 turn-5（T003 大部分）；开局模板按朝代筛选、开局设定复制 / 导入 / 存文件、“用同样设定再开一局”（T004 大部分）。前端测试 202 项、手机尺寸流程 50 项通过。最后提交 `e717aee`。
- **用户 2026-10-17 提出：为什么一直在写真实历史，之前说的是偏向自定义。** 已停掉宋、明两个时代包的资料调研；唐包只保留一个核对已写内容的后台任务。

## 下一步

1. 等用户确认调整方向。主代理的建议：宋、明时代包移入候选池；时代资料改为玩家可自写或让 AI 按故事设定生成后再改（支持架空朝代、自定纪年、货币、称谓、禁忌），唐包只作可选示范；把 R04 的“故事卡”（类似世界书）提前做。确认后改 PLAN_V3、TASKS，并新增决策。
2. 唐包核对结果回来后，按结果改正 `src/content/eras/tang-748.ts`，记到 [时代包抽查记录](validation/R03_ERAS.md)。
3. turn-5 的真实模型评测已登记（[R03 评测](validation/R03_EVAL.md)，上限 170 次调用），**方向确认前暂不运行**，以免花用户的钱测一个可能要改的方案。

## 需要注意

- 用户服务地址与 Key 在本机 `.cache/dev-secrets.json`（不入 Git，**不要改动其中的 `main`**），评测脚本从这里读取，不打印。文档、代码、日志都不写服务地址或 Key；提交前运行 `node .cache/v3-edit/scan.mjs` 扫描暂存文件。
- 真实模型评测花用户的钱：运行前在验证文档里登记调用上限。
- 手机：小米 24117RK2CC，无线 ADB（断开后需重新扫码配对，见 DEVELOPMENT）。安装只用 `adb -s <serial> install -r <apk>` 保留数据。用户手机上有真实存档，**不要运行会清空数据的 `scripts/ui/phone-flow.mjs`**，不要卸载旧版 Lishi Probe。
- 界面调试：`node scripts/fake-llm.mjs`（18800）+ `corepack pnpm dev`（1420）+ `node scripts/ui/game-flow.mjs`。
- 用 Python 改文件时以 `write_bytes(s.encode("utf-8"))` 写回，避免 Windows 换行变成 CRLF。
- PowerShell 先 `. .\scripts\Enter-Dev.ps1`（cargo 等只在其中可用）；Git 提交用 `git -c user.name=Claude -c user.email=noreply@anthropic.com commit ...`。
