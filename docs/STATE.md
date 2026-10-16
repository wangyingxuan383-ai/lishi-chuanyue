# 当前工作现场

> 更新：2026-10-17（Asia/Shanghai）· 阶段：**R03 时代感与纪年（刚开工）** · 分支：`main`

## 现在在哪

- R01 已完成。R02 的工程部分已完成（[R02 验证](validation/R02.md)）：作者模式开局、回合树、记账、回合管线、面板编辑、阅读位置、调用记录、提示词 turn-4、自动玩家评测。前端测试 153 项、手机尺寸流程 43 项、Rust 42 项通过。
- R02 阶段验收（T015）等用户集中试玩与问卷；按 D118 开发不停下等试玩。用户口头反馈“比较满意”。
- 用户 2026-10-16 要求**不再委托 Codex**、由主代理直接推进到计划完成（D118，计划第 8.6 节已作废）。
- R03 已开工：历法引擎 `src/engine/calendar/date.ts`（简化农历、年号表换年号、公元前无 0 年、干支、季节；D119），27 项测试通过，尚未接入游戏。

## 下一步

1. **R03-T001 时代包格式**：把 `src/content/eras/types.ts` 的草稿扩成完整格式（年号表、开局日期、货币与物价、称谓、身份、地点、时间线、日常细节、禁忌 ≥ 20、文风、姓名、来源），写校验测试与 `docs/contracts/ERA_PACK.md`。
2. **R03-T003 接入纪年**：`WorldState.time` 增加结构化开局日期（旧存档没有时降级为“第 N 日 · 时辰”）；开场记录改为给出 `{era, year, month, day, ceYear}`；顶栏、面板、首页卡片、提示词【当前】行改用“天宝七载 冬月十九 · 酉时”；过年时虚岁加一。提示词升到 turn-5，记 `CHANGES.md` 并跑一轮评测（顺带补 R02-T014 要求的 50 回合）。
3. **R03-T002 时代包**：充实唐天宝，新增北宋宣和、明崇祯（可加东汉末、清末），模板的 `eraId` 指向新包；抽查记录写 `docs/validation/R03_ERAS.md`。
4. R03-T004 模板扩充、分类筛选、导出 / 导入开局设定；然后打包装到手机（`install -r`）。

## 需要注意

- 用户服务地址与 Key 在本机 `.cache/dev-secrets.json`（不入 Git，**不要改动其中的 `main`**），评测脚本从这里读取，不打印。文档、代码、日志都不写服务地址或 Key；提交前扫描暂存文件。
- 真实模型评测花用户的钱：`--max-calls` 控制在 40～80。
- 手机：小米 24117RK2CC，无线 ADB（断开后需重新扫码配对，见 DEVELOPMENT）。安装只用 `adb -s <serial> install -r <apk>` 保留数据。用户手机上有真实存档，**不要运行会清空数据的 `scripts/ui/phone-flow.mjs`**，不要卸载旧版 Lishi Probe。
- 界面调试：`node scripts/fake-llm.mjs`（18800）+ `corepack pnpm dev`（1420）+ `node scripts/ui/game-flow.mjs`。
- PowerShell 先 `. .\scripts\Enter-Dev.ps1`（cargo 等只在其中可用）；Git 提交用 `git -c user.name=Claude -c user.email=noreply@anthropic.com commit ...`。
