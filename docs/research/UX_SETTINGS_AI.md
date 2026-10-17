# AI 自定义与设置页信息架构调研

> 调研日期：2026-10-17（Asia/Shanghai），由调研子代理完成。下文所有外部来源的查阅日期都是 2026-10-17，不再逐条重复。
>
> 范围：本文只讲两件事——**AI 自定义**（玩家能怎样调教“叙事者”）和**设置页整体怎么分组**。服务商与模型的接入细节见同时撰写的 `docs/research/UX_PROVIDERS.md`，关于、更新、备份等通用基础见 `docs/research/UX_APP_BASICS.md`，本文只在需要时点到为止。
>
> 来源说明：官方文档优先；第三方下载站、评测文章标“第三方”；只在第三方处看到、未能核实的功能标【待验证】。我们自己代码的现状都按文件路径注明，检查时间同上。

## 结论先说

1. **用户的判断是对的：AI 自定义是这个 App 和普通角色扮演产品最大的区别，但它现在散在四个地方**——设置页（只有“每回合发给 AI 的内容”三挡）、开局“更多设置”、游戏内“本局设置”、游戏内“故事设定与要点”。同一个“文风”在三处出现，却没有“全局默认”这个概念：新开一局永远从代码里的 `DEFAULT_SETTINGS` 起步。玩家改了十局的偏好，第十一局还得重改。
2. **成熟产品的共同做法是三层：全局默认 → 预设 → 单个故事覆盖**。NovelAI 的 Defaults 页只作用于新故事，SillyTavern 的 Author's Note 有“本聊天”和“默认”两个框，AI Dungeon 把“账号级”（安全尺度）和“游戏内”（剧情组件、模型）分开。我们应照抄这个结构：设置页存“新开一局的默认值”，本局设置只覆盖本局，并且**清楚标出哪些项本局改过**。
3. **让参数平易近人的办法不是藏起来，而是“先给方案、再给滑杆、最后给原文”**。Character.AI 把模型差异包装成三种“聊天风格”（快、平衡、深思），Agnaistic 的预设有“只看要点 / 全部选项”开关，NovelAI 每个参数都写了“推荐值和为什么”。我们的叙事选项天然是“挡位”而不是数字，这比采样参数好懂得多，是优势。
4. **历史穿越题材能做出别人没有的 AI 选项**：文白程度、历史严谨度（考据 ↔ 演义）、穿越者优势（金手指强度）、叙事节奏、主角自主程度（防“抢话”）、用词提醒、不想看到的词、天下大事怎么处理。这些都能直接落到 `src/engine/prompt/turn.ts` 的具体句子上，而且大部分可以用现有的评测脚本（`scripts/eval/directive.ts` 的“同一回合有无某行对比”做法）验证。
5. **有三处现成的缺口值得优先补**：
   - 难度（宽松 / 标准 / 残酷）在引擎里决定运势权重和死亡规则（`src/engine/fortune.ts`、`src/engine/state/apply.ts`），但**界面上任何地方都改不了**，永远是“标准”。
   - 温度、最大输出在引擎里有参数（`src/engine/llm/chat.ts` 的 `temperature`，`src/engine/game.ts` 第 198 行 `maxTokens ?? 2048`），但没有入口。
   - 网络代理：Rust 端请求明确写了 `.no_proxy()`（`src-tauri/src/stream.rs` 第 385 行），也就是**连系统代理都不走**。要加代理设置，得先改这里。
6. **“编辑叙事者指令”可以给，但必须有护栏**：只开放“写作要求”那一段，记录块格式（`RECORD_SPEC`）和程序注入的栏目永远不让改；改过的指令带版本标记写进每个回合，记录块解析率下跌时提示恢复默认；有“试写一段对比”和一键恢复。

---

## 1. 现状盘点：我们现在有哪些设置，喂给了谁

### 1.1 散落在四处的设置

| 位置 | 现有选项 | 存在哪里 | 说明 |
|---|---|---|---|
| 设置页 `src/ui/screens/Settings.tsx` | AI 服务列表（使用 / 修改 / 删除 / 添加）；“每回合发给 AI 的内容”省一些 8k / 标准 12k / 记得更多 16k；阅读：字号四挡、主题纸张 / 白天 / 夜间、正文字体黑体 / 宋体、示例句预览；用量摘要与明细；开发者模式（调用记录） | 服务配置在 profile（`contextTokens` 存在服务配置里，`src/engine/llm/providers.ts`）；阅读存 `reading` 设置项；开发者模式存 `devMode` | 只有一个长滚动页，用灰色小字分组 |
| 服务设置 `src/ui/screens/Setup.tsx` | 服务商、地址、Key、模型（可获取列表）、辅助模型、允许 http、测试连接 | profile | 细节见 UX_PROVIDERS |
| 开局“更多设置” `src/ui/screens/NewGame.tsx` 第 283 行起 | 故事名、时代设定（AI 整理 / 内置卡组 / 不要）、叙述视角、文风与篇幅、建议选项数、三项内容尺度、要点、额外规则 | 开局草稿 `newgameDraft`，开局后复制进世界的 `settings` | 草稿会记住上一局填的值，但“清空重填”后回到代码默认值 |
| 本局设置 `WorldSettingsSheet`（`src/ui/screens/Play.tsx` 第 678 行起） | 篇幅、选项数、视角、文风、设定集自动整理开关、章节摘要频率（关 / 8 / 12 / 20）、三项内容尺度、纪年与货币入口 | 世界的 `settings` | 改了从下一段生效 |
| 故事设定与要点 `StorySheet`（`Play.tsx` 第 647 行起） | 故事设定、要点、剧情里记下的要点（可删）、叙事方针、额外规则 | 世界的 `settings` 与 pins 表 | 叙事方针只能在游戏里写，开局时没有 |

### 1.2 `WorldSettings` 每个字段喂给了哪里

`WorldSettings` 与 `DEFAULT_SETTINGS` 定义在 `src/engine/types.ts` 第 166–199 行。

| 字段 | 默认 | 喂给哪里 | 界面入口 |
|---|---|---|---|
| `premise` 故事设定 | 空 | `turn.ts` 系统规则【故事设定】；`chapter.ts`、`upkeep.ts`、`codex.ts` 的输入 | 开局、故事设定 |
| `essentials` 要点 | 空 | `turn.ts` 用户消息的要点块（不裁剪） | 开局、故事设定 |
| `rules` 额外规则 | 空 | `turn.ts` 系统规则【玩家给你的额外规则】 | 开局、故事设定 |
| `perspective` 视角 | 你 | `turn.ts` 写作要求第一条（`PERSPECTIVE`） | 开局、本局 |
| `length` 篇幅 | 中 | `turn.ts` `LENGTH`：短约两百字 / 中约四百 / 长约八百 | 开局、本局 |
| `choiceCount` 选项数 | 3 | `turn.ts` 写作要求最后一条 | 开局、本局 |
| `style` 文风 | 白话 | `turn.ts`：“叙述用白话 / 半文半白，人物对白带时代口吻” | 开局、本局 |
| `difficulty` 难度 | 标准 | `fortune.ts` 运势权重；`state/apply.ts` 伤病与死亡判定；`Play.tsx` 第 325 行“宽松”不判死 | **无** |
| `intensity` 内容尺度（暴力 / 感情 / 黑暗，各三挡） | 都是写实 | `turn.ts` `INTENSITY_TEXT` | 开局、本局 |
| `directive` 叙事方针 | 空 | `turn.ts` 用户消息【叙事方针】，每回合都有 | 只有故事设定 |
| `autoUpkeep` 设定集自动整理 | 开 | `game.ts` 每 `UPKEEP_EVERY`（6，`prompt/upkeep.ts`）回合调辅助模型 | 本局 |
| `chapterEvery` 章节摘要 | 12 | `game.ts` 第 725 行起，调 `prompt/chapter.ts`；结果进系统规则【前情提要】（≤1500 字，`RECAP_BUDGET`） | 本局 |

不在 `WorldSettings` 里、但同样影响叙事的东西：

| 项 | 现在的值 | 位置 | 有无入口 |
|---|---|---|---|
| 上下文预算 | 8k / 12k / 16k token，默认 12k | profile 的 `contextTokens`；`game.ts` 第 103、668 行折成字数 | 设置页 |
| 温度 | 不发送（用服务商默认） | `llm/chat.ts` 第 81、149 行支持 | 无 |
| 最大输出 | 2048 token | `game.ts` 第 198 行 | 无 |
| 超时 | 首字 30 秒 / 空闲 30 秒 / 总计 180 秒；整理类 30/30/75 秒 | `llm/chat.ts` 第 87 行、`game.ts` 第 102–104 行 | 无 |
| 套话黑名单 | 10 个词，提示里列前 6 个 | `turn.ts` 第 27、90 行 `CLICHES` | 无 |
| 用词提醒 | 时代卡“不要出现”命中后下一回合提醒 | `era/taboo.ts`，`turn.ts` `tabooReminder` | 无（开发者模式能看到命中） |
| 相关旧事、相关设定的预算 | 1200 字、卡片预算 | `memory/recall.ts`、`memory/cards.ts` | 无 |
| 天下大事、历史偏离 | 按年表注入 | `timeline.ts` `worldBlock` | 无 |
| 运势 | 每个父节点掷一次，按难度加权，玩家看不到 | `fortune.ts`，`game.ts` 第 483、649 行 | 无 |
| 提示词版本 | `turn-14` 等 | 各 prompt 文件，写进回合 `meta.promptVersion` | 开发者 |

**小结**：可调的东西不少，但“调”的入口与“效果”的关系玩家看不出来；而且没有“全局默认”这一层。

---

## 2. 成熟产品怎么做 AI 自定义

### 2.1 SillyTavern：最全、也最劝退

- **AI 回复配置（AI Response Configuration）**：回复长度（token）、流式输出、上下文长度（token），上下文截断处在聊天里画一条虚线，“提示词拆解（Prompt Itemization）”能看到这次到底发了什么。采样参数十几种（温度、Top-K/P、Min-P、重复惩罚、DRY、XTC、Mirostat……），每个都写明“取什么值等于关闭”。[来源：Common Settings](https://docs.sillytavern.app/usage/common-settings/)
- **提示词管理器（Prompt Manager）**：把系统提示拆成一块块，可拖动排序、可关闭；Main Prompt、Chat History 这类固定块“不能删，只能关”；每块可设角色、插入位置与深度。预设和角色同名时自动套用。[来源：Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)
- **作者注（Author's Note）**：两个框——“本聊天”和“默认（自动用于每个新聊天）”；可设插入深度（越靠近末尾影响越大）和频率（每 N 次用户发言插一次）。[来源：Author's Note](https://docs.sillytavern.app/usage/core-concepts/authors-note/)
- **世界书（World Info）全局设置**：扫描深度、预算（占上下文百分比或固定 token）、最少触发数、递归扫描与最大递归次数、整词匹配（文档明说**中文应关闭**）、超预算提醒、插入策略。[来源：World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- **用户设置**里与生成有关的：自动重说（Auto-swipe：回复过短或命中黑名单词就自动重来）、自动续写（Auto-continue：没到目标长度就自动接着写，文档提醒“AI 认为写完了的，续写通常没用”）、滑动换版本、“发送键即续写”。[来源：User Settings](https://docs.sillytavern.app/usage/user-settings/)
- **正则扩展**：对输出或输入做替换，可全局或只作用于某角色，可导出分享。[来源：Regex](https://docs.sillytavern.app/extensions/regex/)
- **体验评价**：透明度最高，但新手被选项淹没（我们的 [海外竞品调研](COMPETITORS_INTL.md) 已记录“设置项太多，新手被劝退”）。

**可借鉴**：上下文截断线与“这次发了什么”；固定块“只能关不能删”；默认 / 本局两个框；自动重说、自动续写的条件写清楚。**不借鉴**：采样参数墙、拖动排序整段提示词。

### 2.2 NovelAI：预设管理做得最好

- **配置预设（Config Preset）**：下拉列出“我的 / 导入的”在上，官方默认在下；改了任何参数就弹出“更新当前预设 / 撤销修改 / 另存为新预设”；有导入、导出按钮。[来源：Slider Settings](https://docs.novelai.net/en/text/editor/slidersettings/)
- **参数说人话**：随机度（Randomness）“等于 1 是默认，不知道选什么就选它”；输出长度；重复惩罚“太高 AI 会无词可用，太低会一直重复”。每个采样器都给了“试验时建议从多少开始”。[来源：同上]
- **故事设置（Story Settings）**：每个故事选模型、预设、模块，旁边一个“更改默认”按钮直达默认设置；Memory 放在上下文最前，作者注放在很靠后、“像加强版的 Memory”；官方小贴士“AI 跑偏、复读时换个预设试试”。[来源：Story Settings](https://docs.novelai.net/en/text/editor/storysettings/)
- **默认设置（Defaults）**：“新开任何故事时都套用这一页”——默认模型、默认预设、默认模块、设定集生成用的模型与预设。[来源：Defaults](https://docs.novelai.net/en/text/usersettings/defaults/)
- **AI 设置**：流式输出与流速、“写到句末再停”（不在半句话处截断）。[来源：AI Settings](https://docs.novelai.net/en/text/usersettings/aisettings/)

**可借鉴**：改动后的“更新预设 / 撤销 / 另存”三按钮；“本故事设置旁边就有去改默认的入口”；“写到句末再停”；设定集整理用单独的模型（我们已有辅助模型）。

### 2.3 AI Dungeon：剧情组件最接近我们

- **账号设置**：AI 安全尺度（Safe / Moderate / Mature，全账号一个值，Mature 需确认成年）；“禁用词”功能已废弃，官方让玩家改写进 AI Instructions。[来源：Understanding Settings](https://help.aidungeon.com/understanding-settings)
- **游戏内设置**分“冒险”和“玩法”：
  - 冒险 → 剧情：AI Instructions（放在上下文开头，管题材、视角、文风）、故事摘要（可自动更新，**会覆盖手改**）、Plot Essentials（每次都带）、作者注（放在末尾附近）、第三人称开关。
  - 冒险 → 故事卡（按关键词触发）、详情（封面、导出）。
  - 玩法 → AI 模型：选模型；记忆系统（上下文长度滑杆、自动摘要、记忆库）；模型设置；“测试与反馈”里有原始输出、上下文警告图标、“查看输入”。
  - 玩法 → 外观：主题、文字动画、字号、紧凑按钮、回合后保持输入框。[来源：同上]
- **模型设置说明**：上下文长度“通常设到最大最好”；回复长度“纯属个人喜好”；温度“默认常是 0.8，觉得离谱可降到 0.6，想看罕见文字可到 0.95 甚至 1.2”；Top-P“0.9～0.95 适合大多数人”；频率惩罚会连人名一起罚。[来源：What are AI Model Settings?](https://help.aidungeon.com/faq/what-are-advanced-settings)

**可借鉴**：把“影响剧情的文字”（指令、要点、作者注）和“影响生成的机器参数”（模型、长度、温度）分成两组；“查看输入”放在测试区；自动摘要会覆盖手改这件事要明说——我们的章节摘要可改，应保证手改后不被下一次自动摘要冲掉【待验证：现有实现是否会覆盖】。

### 2.4 其他产品一句话

| 产品 | 值得看的设置 | 来源 |
|---|---|---|
| KoboldAI Lite | 设置分 General / GUI / Samplers / Media / Tokens / Tools / Misc；**四种用法模式**（指令、聊天、故事、冒险）一键切换整套行为；采样页顶部是采样预设 | [KoboldCpp 文档](https://koboldcpp.net/docs/features/lite/)、[Lite 页面](https://lite.koboldai.net/) |
| RisuAI | 长期记忆（SupaMemory：上下文满了就让 AI 摘要旧聊天，必要时再摘要摘要）全局配置、按角色启用；摘要提示词可改但“建议留空用默认”；高级设置页首句“新手建议保持默认” | [SupaMemory](https://github.com/kwaroran/Risuai/wiki/SupaMemory)、[Advanced Settings](https://kwaroran.github.io/docs/characterconfig/advsettings/)、[DeepWiki 记忆系统](https://deepwiki.com/kwaroran/RisuAI/5.1-memory-systems) |
| Agnaistic | 预设分 General / Prompt / Memory / Advanced 四个标签；“预设模式：只看要点选项 / 全部选项”开关；“锁定提示词顺序（方便手机）”；每个参数旁写“推荐值”；全局设置里有“新聊天默认用哪个预设”、文字流速、“给消息加一句提示来引导回复” | [Chat Settings](https://agnai.guide/docs/chat-settings/)、[预设编辑页](https://agnai.chat/presets/new)、[站点设置](https://agnai.chat/settings?tab=2)、[Beating Repetition](https://agnai.guide/docs/tips-tricks-and-troubleshooting/beating-repetition-with-llms.html) |
| ChatterUI（安卓原生） | 采样参数配置（曾叫 Preset，后改名 Sampler Config）、指令格式模板、系统提示格式；目标是“适合手机、但对聊天结构有细粒度控制” | [GitHub](https://github.com/Vali-98/ChatterUI)、[DeepWiki 格式与指令](https://deepwiki.com/Vali-98/ChatterUI/5-formatting-and-instructions) |
| Character.AI | 不给参数，给“聊天风格”：Meow 快、Roar 平衡、Nyan 深思（2025-02）；2026-05 免费用户只剩一个默认风格，引发强烈反弹（第三方报道） | [官方博客 Chat Styles](https://blog.character.ai/level-up-your-character-ai-experience-with-chat-styles/)、[官方 2026-04 更新](https://blog.character.ai/pipsqueak2-and-more/)、[RoboRhythms（第三方）](https://www.roborhythms.com/character-ai-all-chat-styles-removed-may-2026/) |
| 星野 | 创建时按用途选模型类型：“剧情演绎（擅长括号体、动作、心理推动剧情）/ 真人陪伴 / 实用工具”；对话设置里可关“选一句回复”；聊天 BGM 开关；“指代关系”让模型分清“你”“他”是谁（第三方）。有第三方称可调括号体描写频率（戏剧化 / 日常化）【待验证】，另有第三方称高级参数可调 Temperature【待验证，疑为站方编写】 | [安卓谷（第三方）](https://www.apkgu.com/android/xyai/)、[艾艾软件园（第三方）](https://www.qh24.com/soft/668270.html)、[资讯中国（第三方）](http://cn.geceo.com/hangye/90516.html)、[ai7（第三方）](https://m.ai7.com/apps/n966575.html) |
| 猫箱 | 会员“灵动模式：角色更聪明有灵性”——把模型档位包装成一个开关 | [App Store](https://apps.apple.com/cn/app/%E7%8C%AB%E7%AE%B1-%E5%92%8C%E5%BF%83%E5%8A%A8-ai-%E6%8E%A2%E7%B4%A2%E5%89%A7%E6%83%85%E5%AE%87%E5%AE%99/id6475000292) |
| 筑梦岛 | “小剧场”=同一角色换场景设定（本质是注入额外设定）；青少年模式；2025-06 因内容问题被约谈 | [人人都是产品经理](https://www.woshipm.com/evaluating/5974879.html)、[新京报 2026-03-17](https://epaper.bjnews.com.cn/html/2026/20260317/20260317_A10/20260317_A10_01_5629_2033560506542854146.html) |

国内陪伴类产品几乎不开放生成参数，靠“模型类型 + 少数开关 + 人设文字”来定制。这说明普通玩家要的是**“选风格”而不是“调参数”**。我们是自带 Key 的工具型 App，两种都要：风格放前面，参数放折叠里。

---

## 3. 共性规律

| 规律 | 谁这样做 | 对我们的含义 |
|---|---|---|
| **默认值与单个故事分开**，改默认不影响已开的故事 | NovelAI Defaults、SillyTavern 作者注“默认”框、Agnaistic“新聊天默认预设” | 新增“游玩默认”，存成一个设置项；开局时复制进世界 |
| **本故事页面有直达默认的入口** | NovelAI“Change Default” | 本局设置底部放“把这些设为以后的默认” 与 “恢复为默认” |
| **预设 = 一组参数的名字**，可另存、导入导出、撤销修改 | NovelAI、Agnaistic、ChatterUI | 做“叙事方案”：一组叙事挡位；与开局设定一样可复制成文字分享（沿用 `openingDraft.ts` 的 `shareText` 思路） |
| **简单 / 完整两种视图** | Agnaistic“只看要点”、RisuAI“新手保持默认” | 每个子页先列 3～5 个常用项，其余收进“更多”折叠 |
| **参数说人话，给推荐值** | NovelAI、AI Dungeon、Agnaistic | 我们的挡位本身就是人话；数字类（温度、超时）一律用挡位或“推荐”标记 |
| **能看到实际发了什么** | SillyTavern Prompt Itemization、AI Dungeon Inspect Input | 已有“查看上下文（开发者）”，可在高级区给非开发者一个只读入口 |
| **影响剧情的文字与机器参数分组** | AI Dungeon“冒险 / 玩法” | “AI 写作与叙事”与“AI 服务”分页 |
| **固定结构不让删** | SillyTavern 固定块只能关 | 叙事者指令里，记录块格式等程序依赖的部分只读 |
| **自动功能会改玩家内容时要说明** | AI Dungeon 自动摘要会覆盖手改 | 设定集整理“只改 AI 写的卡”（D122 已如此）要在开关旁写明 |

---

## 4. App 级设置：成熟 App 一般有什么

| 类别 | 常见项 | 例子 | 我们现在 |
|---|---|---|---|
| 外观 | 浅色 / 深色 / **跟随系统**；强调色；Android 12+ 动态取色 | Material 3 应用普遍三选一 | 只有纸张 / 白天 / 夜间，无跟随系统 |
| 文字 | 字号、字体、行距、段距、首行缩进 | 微信读书、七猫（见 [国内交互调研](UX_CN.md)） | 字号四挡、黑体 / 宋体 |
| 语言 | 界面语言 | SillyTavern | 不需要（只做中文） |
| 网络 | 代理：**跟随系统 / 不用 / 自定义**（HTTP、SOCKS5），绕过列表；超时 | Cherry Studio“代理模式：系统代理（默认）/ 自定义代理 / 不使用代理”，自定义时可填绕过规则 [来源](https://docs.cherryai.com.cn/pre-basic/settings/general) | 无，且 Rust 端 `.no_proxy()` |
| 更新 | 自动检查、渠道（正式 / 测试） | AI Dungeon 账号设置里可切移动端发布渠道 | 无（见 UX_APP_BASICS） |
| 通知与声音 | 完成提醒、音效、触感 | 星野 BGM 开关 | 生成时前台服务通知（D116）、首次询问通知权限；长按有 10ms 震动（`useLongPress.ts`） |
| 隐私 | 不上传、日志脱敏 | — | 原则已有（AGENTS 第 9 节） |
| 数据 | 导出、备份、存储占用、清理 | — | 单个世界导出导入（`engine/archive.ts`）；用量统计 |
| 开发者 | 调试模式、日志 | Cherry Studio 开发者模式 | 有 |

---

## 5. 我们的设置信息架构

### 5.1 顶层页面

设置首页不再是一条长滚动，而是**分三段的入口列表**，每个入口一行：标题 + 一句当前状态（如“DeepSeek · deepseek-chat”“说书人 · 白话 · 中篇”），点进去是子页。这是安卓“设置”App 本身的样式，手机上最熟悉。

```
设置
├─ AI
│  ├─ AI 服务                ← 现有，细节见 UX_PROVIDERS
│  ├─ 写作与叙事（默认）     ← 新：叙事方案、文风、篇幅、视角……
│  └─ 记忆与整理             ← 新：上下文量、章节摘要、设定集整理、用词提醒
├─ 游戏
│  ├─ 游玩默认               ← 新：难度与运势、内容尺度、开局默认
│  ├─ 阅读与外观             ← 现有“阅读”扩充
│  └─ 通知与声音             ← 新
└─ 应用
   ├─ 数据与备份             ← 用量移到这里；细节见 UX_APP_BASICS
   ├─ 网络与代理             ← 新
   ├─ 更新                   ← 见 UX_APP_BASICS
   ├─ 关于                   ← 见 UX_APP_BASICS
   └─ 开发者                 ← 现有，默认隐藏在“关于”里连点版本号打开【可选】
```

顶部可放一个搜索框，输入“代理”“字号”直接跳到项【可选，项数超过 40 后再做】。

**游戏里的“本局设置”**按同样的三块排列（写作与叙事 / 记忆与整理 / 游玩），只放可以按局覆盖的项。

### 5.2 全局默认与本局覆盖的规则

1. **新增设置项 `playDefaults`**（`WorldSettings` 中除 `premise`、`essentials`、`rules`、`directive` 外的字段，加上下文新增的叙事字段）。新开一局时，开局草稿的 `settings` 从它初始化，而不是从 `DEFAULT_SETTINGS`；“清空重填”也回到它。
2. **世界保存完整的一份**（现在就是这样），所以改默认**不影响已开的局**。这句话要直接写在“写作与叙事（默认）”页顶部：“这里是新开一局的默认值，已经开始的故事不受影响，在游戏里的‘本局设置’单独改。”
3. **本局设置里标出覆盖**：某项与当前默认不同时，标题后加一个小标签“本局”，长按或点“…”出现“恢复为默认”。页面底部两个按钮：“全部恢复为默认”“把本局的设为以后的默认”。
4. **AI 服务级的项留在服务里**：上下文量、温度、最大输出、超时跟模型强相关，存在 profile（现状 `contextTokens` 即如此），不做按局覆盖。换服务时这些跟着变，记忆页显示“当前服务：××，约 12k”。
5. **故事专属的文字**（故事设定、要点、叙事方针、额外规则）只有本局，没有全局默认；但“额外规则”可以有一份“每局都附加的规则”（见 6.1 的“我的通用规则”）。

---

## 6. 逐页设计

表中“现状”一列：**有**＝已实现（注明位置），**改**＝已有但要调整，**新**＝要新做。“层级”：全局＝只在设置页；默认＋本局＝设置页存默认、本局可覆盖；服务＝跟着 AI 服务配置。“折叠”：常用＝子页第一屏；更多＝收进“更多选项”。

### 6.1 写作与叙事（默认）

页面顶部是**叙事方案**卡片横排，下面是各项挡位，最底下是折叠的“高级：叙事者指令”。每项下方一句灰字说明，改动后顶部方案卡显示“已修改 · 另存为方案 / 撤销”（学 NovelAI）。页面底部固定一段**示例**：用当前挡位渲染的一小段固定文字说明（不调用 AI），例如“白话 · 第二人称 · 紧凑：你推开坊门，鼓声一下下撞在胸口……”；另有“用 AI 试写一段”按钮【可选，花一次调用，结果不入存档】。

| 选项（玩家看到的名字） | 挡位与默认 | 说明文字 | 喂给哪里 | 现状 | 层级 | 折叠 | 风险 |
|---|---|---|---|---|---|---|---|
| 叙事方案 | 内置：**平衡**（默认）/ 说书人 / 史笔 / 市井白描 / 网文爽快；“我的方案”若干 | 一键套用下面一组挡位 | 只是一组字段值，不直接进提示词 | 新 | 默认＋本局 | 常用 | 低（各挡位分别评测） |
| 文风 | 说书人（章回口吻，偶有“看官”式旁白）/ 史笔（冷静克制、少形容）/ 白描（市井细节、对话多）/ 文学（细腻心理与意象）；默认“白描” | 叙述的整体腔调 | `turn.ts` 写作要求第一条后加一句风格描述 | 新 | 默认＋本局 | 常用 | **高**：改写作要求，需评测八股词频率、抢话率 |
| 文白程度 | 白话 / 浅文言（叙述白话、对白带古味）/ 半文半白；默认“浅文言” | 叙述和对白里古语用多少 | `turn.ts` 现有“叙述用白话 / 半文半白，人物对白带时代口吻”扩成三挡 | 改（现为 `style` 两挡） | 默认＋本局 | 常用 | 中：需迁移旧值（白话→白话，半文半白→半文半白），评测可读性 |
| 每段篇幅 | 短约 200 字 / 中约 400 / 长约 800；默认中 | — | `turn.ts` `LENGTH` | 有（开局、本局） | 默认＋本局 | 常用 | 低 |
| 叙述视角 | 你 / 我 / 他（她）；默认你 | — | `turn.ts` `PERSPECTIVE` | 有 | 默认＋本局 | 常用 | 低 |
| 叙事节奏 | 慢热细写 / 适中 / 紧凑推进；默认适中 | 慢热：多写环境与人情；紧凑：少铺垫，事情来得快 | `turn.ts` 写作要求加一句；与“叙事方针”同位但是固定句 | 新 | 默认＋本局 | 常用 | **高**：评测（可直接仿 `scripts/eval/directive.ts`，它就是测“节奏快一些”的方针是否生效） |
| 建议选项 | 不要 / 2 / 3 / 4；默认 3 | — | `turn.ts` 最后一条 | 有 | 默认＋本局 | 常用 | 低 |
| 选项风格 | 稳妥为主 / 各有取舍（默认）/ 敢想敢做 | 敢想敢做：至少一个选项冒险或出人意料 | `turn.ts` 选项那句后加要求 | 新 | 默认＋本局 | 更多 | 中：评测选项多样性 |
| 主角自主程度 | 只做我写的（默认）/ 可补小动作 / 可替我做小决定 | “只做我写的”最不抢话；后两挡让剧情更顺，但 AI 会替你多走几步 | `turn.ts` 写作要求第二条（抢话规则，turn-6 起细化）按挡位换措辞 | 新 | 默认＋本局 | 更多 | **高**：直接影响抢话率（PLAN_V3 8.3 门槛 ≤5%），后两挡只放宽“小动作”，不放宽“许诺、底牌” |
| 不想看到的词 | 自定义列表，默认空；下方显示内置的 10 个 | AI 不要用的词句，如“嘴角勾起” | `turn.ts` `CLICHES` 那句后追加；可选：像用词提醒一样本地检查，命中则下回合提醒 | 新（内置表已有） | 全局 | 更多 | 中：列表过长会稀释提示，限 20 条 |
| 我的通用规则 | 文本，默认空 | 每局都附加的要求，如“多写对话” | 拼到每局 `rules` 之前 | 新 | 全局 | 更多 | 中：同额外规则 |
| 回复写到句末 | 开（默认） | 被长度截断时，丢掉最后半句 | 程序后处理，不进提示词 | 新 | 全局 | 更多 | 低【待验证：与记录块位置的关系，截断通常意味着记录块也没写出来】 |
| 被截断时自动接着写 | 关（默认）/ 开 | 服务端截断时自动续写一次 | `game.ts` 现有 `continue` 模式 | 新 | 全局 | 更多 | 中：多一次调用；SillyTavern 文档提醒“AI 自认写完的续写无效” |
| 高级：叙事者指令 | 见第 8 节 | — | `turn.ts` `systemParts` | 新 | 全局（可另存为方案） | 折叠 | **最高** |

**历史题材专属，也放在本页“历史与穿越”小标题下**：

| 选项 | 挡位与默认 | 说明文字 | 喂给哪里 | 现状 | 层级 | 风险 |
|---|---|---|---|---|---|---|
| 历史严谨度 | 考据（宁可模糊，不编确切人名官职数字）/ 平衡（默认）/ 演义（可以虚构名人轶事，重戏剧性） | 越严谨越像史书，越放开越像小说 | `turn.ts` `eraBlock` 现有“拿不准的细节写得模糊些”按挡位换句；演义挡同时放宽“查一查”（`prompt/ask.ts`）的【仅供参考】措辞【可选】 | 新 | 默认＋本局 | **高**：评测时代错误与编造率（可复用 R07 用词提醒的检查） |
| 穿越者优势（金手指） | 普通人（现代知识大多派不上用场，说出去没人信）/ 有点本事（默认）/ 天命之子（现代知识常常奏效，好运多一些） | 你的现代知识在这个时代有多好用 | `turn.ts` 写作要求加一句；“天命之子”还可以把运势权重往顺的一侧挪一点（`fortune.ts`）；“不穿越”的局隐藏此项 | 新 | 默认＋本局 | **高**：影响失败率与“有后果”支柱；需评测风险行动的成 / 败 / 半成分布（记录块已有 `risk.result`） |
| 史实大事 | 照史书来（默认）/ 可以被你改变 / 不提天下事 | 天下大事是否出现，以及你能不能改写历史 | `timeline.ts` `worldBlock`：第一挡固定事件写“一定发生”，第二挡全部改为“可能因剧情改变”，第三挡不注入；`deviation` 记录照旧 | 新 | 默认＋本局 | 中：第三挡少了一块上下文；评测天下大事出现率 |
| 用词提醒 | 开（默认）/ 关 | 时代卡里写了“不要出现”的词，上一段用了，下一段提醒 AI | `era/taboo.ts`，`turn.ts` `tabooReminder` | 改（现在总是开） | 默认＋本局 | 低 |
| 别人怎么称呼我 | 自动（默认，按身份）/ 自填，如“公子”“三娘” | — | `turn.ts` `renderState` 主角行后加称谓 | 新（UX_CN 第 23 条已提） | 只有本局（开局可填） | 低 |

### 6.2 记忆与整理

| 选项 | 挡位与默认 | 说明文字 | 喂给哪里 | 现状 | 层级 | 折叠 | 风险 |
|---|---|---|---|---|---|---|---|
| 每回合给 AI 看多少 | 省一些 8k / 标准 12k（默认）/ 记得更多 16k / 自定义【更多】 | 现有说明文字很好，保留 | profile `contextTokens` → `game.ts` 第 668 行 | 有（设置页） | 服务 | 常用 | 低；自定义值上限按模型窗口提示【待验证：各模型窗口】 |
| 章节摘要 | 关 / 每 8 / 12（默认）/ 20 回合 | 现有说明保留 | `game.ts` 第 725 行；`prompt/chapter.ts` | 有（本局） | 默认＋本局 | 常用 | 低 |
| 设定集自动整理 | 开（默认）/ 关；更多里：每 4 / 6（默认）/ 10 回合 | 加一句“只改 AI 自己写的卡，你写的不会动” | `game.ts` 第 805 行起；频率现为常量 `UPKEEP_EVERY` | 改（开关已有，频率新） | 默认＋本局 | 常用 | 低；频率改小多花调用 |
| 开局整理时代资料 | AI 按故事设定整理（默认）/ 不要 | 开局“更多设置”里已有这项，这里存默认 | `prompt/codex.ts` | 改（只有开局） | 默认 | 常用 | 低 |
| 剧情里记下的要点上限 | 不限（默认）/ 提醒超过 N 条 | 要点每回合全带、不裁剪，太多会挤掉前文 | `turn.ts` 要点块 | 新 | 全局 | 更多 | 低 |
| 前情提要长度 | 1500 字（默认）/ 1000 / 2500 | — | `prompt/chapter.ts` `RECAP_BUDGET` | 新 | 服务 | 更多 | 中：要跑记忆探针评测 H |
| 相关旧事长度 | 1200 字（默认） | — | `memory/recall.ts` `RECALL_BUDGET` | 新 | 服务 | 更多 | 中：同上 |
| 整理用的模型 | 跟随辅助模型（默认） | 摘要、整理设定集、查一查用哪个模型 | `game.ts` 第 197 行 `auxModel` | 有（服务设置里） | 服务 | 更多 | 低 |
| 看看下一回合发了什么 | 入口 | 只读，分层显示字数 | `game.previewContext`（现为开发者菜单） | 改（向非开发者开放只读版） | — | 更多 | 低 |

### 6.3 游玩默认

| 选项 | 挡位与默认 | 说明文字 | 喂给哪里 | 现状 | 层级 | 折叠 | 风险 |
|---|---|---|---|---|---|---|---|
| 难度 | 宽松 / 标准（默认）/ 残酷 | 宽松：运气偏好，受了重伤也不会死；标准：先“垂危”，剧情写出才死；残酷：运气偏差，重伤可能直接丧命 | `fortune.ts` 权重；`state/apply.ts` 第 235、275 行死亡判定；`Play.tsx` 第 325 行 | **引擎有、界面无** | 默认＋本局 | 常用 | 中：本局中途改要提示“从下一段起生效”；D123/D124 的死亡规则不变 |
| 运气透明度 | 不显示（默认）/ 事后显示 | 事后显示：有风险的行动写完后，在段尾小字显示“这次运气：不顺” | `fortune` 已存在节点上；纯界面 | 新 | 默认＋本局 | 更多 | 低；第六支柱“有后果”看得见原因 |
| 内容尺度 | 暴力与伤亡 / 感情与亲密 / 黑暗与压抑，各：含蓄 / 写实（默认）/ 浓烈 | 保留现有说明“浓烈仍受所用 AI 服务的规则限制” | `turn.ts` `INTENSITY_TEXT`（D114） | 有（开局、本局） | 默认＋本局 | 常用 | 中：浓烈挡的拒答率要记录 |
| 开局默认视角、篇幅等 | — | 不单列，直接用“写作与叙事（默认）” | — | — | — | — | — |
| 过些日子默认时长 | 半个月（默认）等 | — | `Play.tsx` `SkipSheet` | 新 | 全局 | 更多 | 低 |
| 重说时的快捷方向 | 内置若干 + 自定义 | “写短一点”“换个结果”…… | `Play.tsx` `HINTS` | 新（列表已有） | 全局 | 更多 | 低 |
| 生成前确认费用 | 关（默认） | — | 用量模块 | 新【可选】 | 全局 | 更多 | 低 |

### 6.4 阅读与外观

| 选项 | 挡位与默认 | 现状 | 折叠 | 备注 |
|---|---|---|---|---|
| 主题 | **跟随系统（默认）** / 纸张 / 白天 / 夜间 | 改（`context.tsx` 只有三挡，默认纸张） | 常用 | 跟随系统：系统浅色用纸张、深色用夜间；D125 视觉方向不变 |
| 字号 | 小 / 中 / 大 / 特大 | 有 | 常用 | — |
| 正文字体 | 宋体 / 黑体 | 有 | 常用 | — |
| 行距、段距、首行缩进 | 挡位 | 新 | 更多 | UX_CN 第 1 条 |
| 写字效果 | 逐句淡入（默认）/ 立刻显示 | 新 | 更多 | UX_CN 第 3 条 |
| 生成时跟随最新文字 | 开 / 关（停在段首） | 新 | 更多 | AI Dungeon 2026-08 新增 |
| 动效 | 跟随系统“减少动态效果” / 关 | 新 | 更多 | — |
| 阅读时不锁屏 | 关（默认） | 新 | 更多 | 【待验证：Tauri 安卓接口】 |
| 预览 | 现有示例句保留，随设置实时变化 | 有 | — | — |

### 6.5 通知与声音

| 选项 | 默认 | 现状 | 备注 |
|---|---|---|---|
| 写完时提醒 | 开（在后台时） | 改：现在只在第一次生成前问一次权限（`Play.tsx` 第 220 行），之后无处可改 | 关掉时仍保留前台服务通知（D116，系统要求） |
| 通知权限状态 | 显示“已允许 / 未允许 → 去系统设置” | 新 | — |
| 触感反馈 | 开 | 改：长按已有 10ms 震动（`useLongPress.ts`），无开关 | 【待验证：WebView `navigator.vibrate` 在小米真机】 |
| 音效 | 关 | 新【可选】 | 翻页、盖印小声音；后置 |

### 6.6 网络与代理

| 选项 | 挡位与默认 | 说明文字 | 现状 | 备注 |
|---|---|---|---|---|
| 代理 | 跟随系统（默认）/ 不用代理 / 自定义 | 连不上海外服务时再改 | 新；**需改 Rust**：`src-tauri/src/stream.rs` 第 385 行 `.no_proxy()` | “跟随系统”在 Windows 可读系统代理；安卓 WebView 外的 Rust 请求能否拿到系统代理【待验证】 |
| 自定义代理地址 | `http://` 或 `socks5://` 主机:端口；可选用户名密码 | 密码按 Key 同样加密保存 | 新 | reqwest 的 SOCKS 需要额外 feature【待验证：编译与安卓体积】；地址属于用户私人信息，不写入日志与诊断导出 |
| 测试代理 | 按钮 | 用当前服务做一次短请求 | 新 | 复用 `Setup.tsx` 的测试逻辑 |
| 网络较慢时多等一会 | 关（默认）/ 开 | 开：等待首字、空闲时间加倍 | 新 | `llm/chat.ts` `DEFAULT_TIMEOUTS`、`game.ts` 第 102–104 行 |
| 允许 http 地址 | 按服务 | — | 有（`Setup.tsx`） | 留在服务里 |

### 6.7 数据与备份、更新、关于

只列入口与归属，细节见 `docs/research/UX_APP_BASICS.md`：用量与费用（从现设置页移入，`components/Usage.tsx`）、导出全部世界、自动备份、存储占用、回收站、**导出 / 导入我的设置与叙事方案（不含 Key）**、检查更新、关于与许可。

### 6.8 开发者

现有：开发者模式、调用记录、长按看原始输出、查看上下文。新增：每次调用的提示词版本（`meta.promptVersion` 已有）、记录块解析失败次数统计（用于第 8 节的护栏）、用词提醒命中记录。

---

## 7. 预设：叙事方案怎么定

### 7.1 内置方案（只改叙事挡位，不改服务）

| 方案 | 文风 | 文白 | 节奏 | 篇幅 | 选项 | 适合 |
|---|---|---|---|---|---|---|
| 平衡（默认） | 白描 | 浅文言 | 适中 | 中 | 3 · 各有取舍 | 第一次玩 |
| 说书人 | 说书人 | 浅文言 | 适中 | 中 | 3 | 想要“话说”的味道 |
| 史笔 | 史笔 | 半文半白 | 慢热 | 中 | 2 | 考据党，配合“历史严谨度：考据” |
| 市井白描 | 白描 | 白话 | 紧凑 | 短 | 3 · 敢想敢做 | 手机碎片时间 |
| 网文爽快 | 文学 | 白话 | 紧凑 | 中 | 4 · 敢想敢做 | 配合“穿越者优势：天命之子” |

### 7.2 “快速 / 平衡 / 文笔优先”这类跟成本相关的方案

这一类改的是**服务级**的东西（用主模型还是辅助模型写正文、上下文量、要不要自动整理），应放在“AI 服务”页，作为一个“省钱程度”挡位：

| 挡位 | 上下文 | 设定集整理 | 章节摘要 | 说明 |
|---|---|---|---|---|
| 省着用 | 8k | 每 10 回合 | 每 20 回合 | 便宜、略健忘 |
| 平衡（默认） | 12k | 每 6 回合 | 每 12 回合 | — |
| 记性优先 | 16k | 每 4 回合 | 每 8 回合 | 更贵更慢 |

两类方案分开，玩家就不会把“想写得古雅一点”和“想省钱”混在一个下拉里。

### 7.3 另存、分享与恢复

- 改了任何挡位：方案卡显示“已修改”，给“另存为我的方案 / 撤销修改”。
- “我的方案”可复制成一段文字或保存为文件，与“开局设定”的分享方式一致（`openingDraft.ts` 的 `shareText` / `parseShare`）；导入时只认识的字段生效，不认识的忽略并提示。
- 每个子页右上角“恢复默认”，只恢复本页；确认框说明恢复哪些项。

---

## 8. 高级：编辑叙事者指令

### 8.1 开放什么、不开放什么

`turn.ts` 的系统规则由 `systemParts` 拼成四段：`rules`（写作要求）、`premise`（故事设定与额外规则）、`era`（时代卡）、`spec`（记录块格式）。另外用户消息里有程序注入的【当前】【上回合的实际结果】【本回合运势】【用词提醒】等。

| 部分 | 是否可改 | 理由 |
|---|---|---|
| 写作要求（`rulesText` 里的各条） | **可改**：显示默认原文，玩家在副本上改 | 文风、节奏、抢话规则都在这里，是玩家最想调的 |
| 套话黑名单 | 通过“不想看到的词”改，不直接改原文 | 结构化更安全 |
| 内容尺度、视角、篇幅、选项句 | 不在原文里改，由挡位生成；原文中显示为灰色占位“〔内容尺度〕” | 防止改原文后挡位失效 |
| 记录块格式 `RECORD_SPEC`、开场附加要求 `OPENING_EXTRA` | **只读** | 程序靠它解析钱、物品、人物；改坏了整个状态系统失灵（记录块解析率是 R02 起的门槛 ≥95%） |
| 程序注入的【当前】【运势】【实际结果】【天下大事】 | **只读**，可在“看看发了什么”里看到 | 程序裁决（D113） |
| 摘要、整理设定集、查一查的提示词（`chapter.ts`、`upkeep.ts`、`ask.ts`、`codex.ts`） | 首版不开放 | 输出是 JSON，容错更低；RisuAI 也建议摘要提示词留空 |

### 8.2 护栏

1. **入口深**：“写作与叙事 → 更多 → 高级：叙事者指令”，进入前一屏说明：“这里改的是 AI 每回合读到的写作要求。改得不好，AI 可能抢你的话、记错钱物。随时可以恢复默认。”
2. **副本编辑**：默认原文只读显示；点“在副本上修改”才可编辑。显示与默认的差异（增删的行高亮）。
3. **长度限制**：写作要求总长不超过默认的两倍【数值待定】；超出不让保存。
4. **占位检查**：保存时检查挡位占位（〔视角〕〔篇幅〕〔内容尺度〕〔选项〕）都还在；删了就提示“这样‘本局设置’里的××将不起作用”，可以坚持保存。
5. **版本标记**：自定义指令存一个短哈希，回合 `meta.promptVersion` 写成 `turn-14+my-3f9a`。开发者模式与评测脚本都能区分。
6. **默认版本升级提醒**：`PROMPT_VERSION` 升级（如 `turn-14` → `turn-15`）后，若玩家有自定义，提示“默认指令更新了，你的副本基于旧版”，给“看看改了什么 / 合并到我的副本 / 继续用旧的”。
7. **试写对比**：“试写一段”在当前局当前回合生成一个**新版本**（沿用重说的版本机制，不覆盖原文），玩家左右切换比较。
8. **健康监测**：使用自定义指令后，若最近 10 回合里记录块需要补记的次数明显高于之前，或首字前失败增多，在游戏页提示一次“最近 AI 常漏写记录，可能和你改的叙事者指令有关”，给“恢复默认”按钮。
9. **作用范围**：自定义指令保存为“我的方案”的一部分；默认方案不含自定义；本局可以选用某个方案。
10. **不进分享**：分享方案时，自定义指令单独勾选才包含，并提示对方“这份方案改了叙事者指令”。

---

## 9. 风险与评测清单

AGENTS 第 5 节要求：改提示词要记版本并跑评测，评测有事先登记的费用上限。下表是每个新选项上线前要做的检查，都可以在现有 `scripts/eval/` 框架上做。

| 选项 | 改动的提示词 | 必跑评测 | 看什么 |
|---|---|---|---|
| 文风（4 挡） | `turn.ts` 写作要求 | 仿 `directive.ts`：同一回合各挡位各生成 2 次 | 文风差异可感知（人工盲评）；八股词频率 ≤0.5/千字；抢话率 ≤5% |
| 文白程度（3 挡） | 同上 | 同上 | 可读性（人工）；时代用词命中（`era/taboo.ts`） |
| 叙事节奏 | 同上 | `directive.ts` 已有“段落数、长度、对话占比”的 `shape` 统计，直接复用 | 三挡之间统计有差 |
| 主角自主程度 | 抢话规则 | `autoplay.ts` 20 回合 × 3 挡 | 抢话率；“可替我做小决定”挡不得出现许诺、底牌类抢话 |
| 历史严谨度 | `eraBlock` | `autoplay.ts` + 人工审读 | 编造确切人名官职的次数；用词提醒命中 |
| 穿越者优势 | 写作要求 + 可能改 `fortune.ts` | `autoplay.ts`，统计记录块 `risk.result` | 三挡的成 / 败 / 半成分布拉开；“普通人”挡不变成全败 |
| 史实大事 | `worldBlock` | `deviation.ts` | 天下大事出现率、偏离记录 |
| 不想看到的词 | 黑名单句 | 本地统计即可 | 命中率下降；列表长时其他指标不变差 |
| 选项风格 | 选项句 | `smoke.ts` | 选项之间的差异（人工） |
| 前情提要 / 相关旧事长度 | 不改文字，改组装 | `probe.ts` 记忆探针（评测 H） | 答对题数 |
| 自定义叙事者指令 | 玩家自写 | 不评测内容，靠第 8.2 节健康监测 | 记录块补记率 |

内容尺度、篇幅、视角、选项数、章节摘要、设定集整理这些**已有选项只是换个地方放**，不改提示词，不需要重新评测。

---

## 10. 建议的实施顺序

1. **先搭架子，不改提示词**：设置首页改成分段入口；把现有项挪进对应子页；新增 `playDefaults` 与“本局”覆盖标记；补上难度入口；主题加“跟随系统”；通知开关。全部是界面和存储，风险低、玩家立刻能感到“像成品”。
2. **服务级参数**：省钱程度挡位、温度（“稳一些 / 服务默认 / 放开些”，默认不发送）、最大输出、慢网等待；这一步和 UX_PROVIDERS 的结论一起做。【待验证：推理类模型不接受 `temperature` 的情况，需按服务商隐藏】
3. **网络与代理**：先改 Rust 去掉 `.no_proxy()` 改为可配置，再做界面；Windows 先行，安卓真机验证。
4. **叙事挡位第一批**（每项一个提示词版本、一次评测）：叙事节奏、文白程度三挡、用词提醒开关、不想看到的词。
5. **叙事挡位第二批**：文风、主角自主程度、历史严谨度、穿越者优势、史实大事、选项风格；然后组合成内置叙事方案。
6. **最后**：高级叙事者指令及其护栏、方案分享。

每一步按 AGENTS 第 4 节先进台账；第 4、5 步改变玩法与提示词，要新增决策记录。

---

## 11. 待验证清单

| 项 | 为什么不确定 | 怎么验证 |
|---|---|---|
| 安卓上 Rust（reqwest）能否读到系统代理 | 安卓系统代理通常只对 Java 网络栈生效 | 小米真机开系统代理测试 |
| reqwest SOCKS 支持的编译与包体积 | 需要额外 feature | 本机编译 Android 包比较大小 |
| 推理类模型是否拒绝 `temperature` | 各服务商行为不同 | 在 UX_PROVIDERS 的服务清单上逐个测 |
| 最大输出 2048 对思考型模型是否够 | 思考内容可能占用输出额度 | 评测中统计截断率 |
| 手改章节摘要后会不会被下次自动摘要覆盖 | 未细查 `game.ts` 写章逻辑 | 读代码并补测试 |
| “阅读时不锁屏”、触感在 Tauri 安卓上的接口 | 未查插件 | 查 Tauri 插件文档并真机试 |
| 星野“括号体频率调节”“高级参数调温度” | 只见于第三方下载站 | 真机安装星野查看 |
| 各模型的上下文窗口上限（自定义上下文量的上限提示） | 随模型变 | 跟随 UX_PROVIDERS 的模型资料 |
| 写作要求自定义的长度上限取多少合适 | 无数据 | 评测时试 1.5 倍、2 倍 |

---

## 12. 来源

外部来源查阅日期均为 2026-10-17。

**SillyTavern（官方文档）**
- [Common Settings](https://docs.sillytavern.app/usage/common-settings/)
- [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- [Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)
- [Author's Note](https://docs.sillytavern.app/usage/core-concepts/authors-note/)
- [User Settings](https://docs.sillytavern.app/usage/user-settings/)
- [Regex](https://docs.sillytavern.app/extensions/regex/)

**NovelAI（官方文档）**
- [Slider Settings / Config Preset](https://docs.novelai.net/en/text/editor/slidersettings/)
- [Story Settings](https://docs.novelai.net/en/text/editor/storysettings/)
- [Defaults](https://docs.novelai.net/en/text/usersettings/defaults/)
- [AI Settings](https://docs.novelai.net/en/text/usersettings/aisettings/)

**AI Dungeon（官方帮助中心）**
- [Understanding AI Dungeon System Settings](https://help.aidungeon.com/understanding-settings)
- [What are AI Model Settings?](https://help.aidungeon.com/faq/what-are-advanced-settings)

**其他客户端**
- [KoboldAI Lite 说明（KoboldCpp 文档）](https://koboldcpp.net/docs/features/lite/)、[KoboldAI Lite](https://lite.koboldai.net/)
- [RisuAI SupaMemory](https://github.com/kwaroran/Risuai/wiki/SupaMemory)、[RisuAI Advanced Settings](https://kwaroran.github.io/docs/characterconfig/advsettings/)、[RisuAI 记忆系统（DeepWiki，第三方整理）](https://deepwiki.com/kwaroran/RisuAI/5.1-memory-systems)
- [Agnaistic Chat Settings](https://agnai.guide/docs/chat-settings/)、[Agnaistic 预设编辑页](https://agnai.chat/presets/new)、[Agnaistic 站点设置](https://agnai.chat/settings?tab=2)、[Beating Repetition](https://agnai.guide/docs/tips-tricks-and-troubleshooting/beating-repetition-with-llms.html)
- [ChatterUI（GitHub）](https://github.com/Vali-98/ChatterUI)、[ChatterUI 格式与指令（DeepWiki，第三方整理）](https://deepwiki.com/Vali-98/ChatterUI/5-formatting-and-instructions)
- [Cherry Studio 系统设置（代理模式）](https://docs.cherryai.com.cn/pre-basic/settings/general)

**Character.AI**
- [Level Up Your Character.AI Experience with Chat Styles（官方博客，2025-02-18）](https://blog.character.ai/level-up-your-character-ai-experience-with-chat-styles/)
- [April Update: New Model, Memory, and Lorebook（官方博客，2026-04-14）](https://blog.character.ai/pipsqueak2-and-more/)
- [Character AI Just Wiped Every Chat Style for Free Users（RoboRhythms，第三方，2026-05-09）](https://www.roborhythms.com/character-ai-all-chat-styles-removed-may-2026/)

**国内产品**
- [星野 App Store](https://apps.apple.com/cn/app/%E6%98%9F%E9%87%8E-%E6%89%80%E5%BB%BA%E7%9A%86%E4%BD%A0%E6%89%80ai/id6463076337)
- [星野ai（安卓谷，第三方）](https://www.apkgu.com/android/xyai/)、[星野（艾艾软件园，第三方）](https://www.qh24.com/soft/668270.html)、[星野全新版本（ai7，第三方）](https://m.ai7.com/apps/n966575.html)、[星野春节更新（资讯中国，第三方）](http://cn.geceo.com/hangye/90516.html)、[星野原生功能测评（资讯中国，第三方）](http://cn.geceo.com/hangye/88735.html)
- [猫箱 App Store](https://apps.apple.com/cn/app/%E7%8C%AB%E7%AE%B1-%E5%92%8C%E5%BF%83%E5%8A%A8-ai-%E6%8E%A2%E7%B4%A2%E5%89%A7%E6%83%85%E5%AE%87%E5%AE%99/id6475000292)
- [用 AGI 视角重新理解筑梦岛（人人都是产品经理）](https://www.woshipm.com/evaluating/5974879.html)
- [孩子聊的 AI 充斥“爱上嫂子”等情节（新京报，2026-03-17）](https://epaper.bjnews.com.cn/html/2026/20260317/20260317_A10/20260317_A10_01_5629_2033560506542854146.html)

**本项目内**
- 代码：`src/ui/screens/Settings.tsx`、`Setup.tsx`、`Play.tsx`、`NewGame.tsx`、`openingDraft.ts`；`src/ui/app/context.tsx`；`src/engine/types.ts`、`game.ts`、`fortune.ts`、`timeline.ts`、`state/apply.ts`、`era/taboo.ts`、`memory/recall.ts`、`memory/cards.ts`、`llm/chat.ts`、`llm/providers.ts`；`src/engine/prompt/turn.ts`、`chapter.ts`、`upkeep.ts`、`ask.ts`、`codex.ts`、`CHANGES.md`；`src-tauri/src/stream.rs`；`scripts/eval/`。
- 文档：[PLAN_V4 方向 K](../PLAN_V4.md)、[PLAN_V3 第 4.11、8.3 节](../PLAN_V3.md)、[决策记录](../DECISIONS.md)（D106、D113、D114、D116、D121–D125）、[海外竞品调研](COMPETITORS_INTL.md)、[国内交互调研](UX_CN.md)、[海外交互调研](UX_INTL.md)。
