# 海外 AI 互动小说与 AI RPG 调研

> 调研日期：2026-10-16（Asia/Shanghai），由调研子代理完成，主代理整理入库。用于 [v3 计划](../PLAN_V3.md) 第 3 节。本次没有拿到 Reddit 原帖，用户痛点主要来自 Steam 评论、应用商店评论和第三方评测；第三方评测站不是官方来源；标“未核实”的内容没有找到可靠来源。

**结论**：成熟产品用的是同一个基本循环：写一回合叙事，然后可以重试、撤销、编辑、分支，再加一套玩家看得见、改得动的记忆。玩家抱怨最多的四件事是：遗忘、重复、行动几乎总能成功、看不懂系统怎么判定。对历史穿越模拟最值得借鉴的是 Voyage 和 Friends & Fables：规则和状态由确定性程序管，LLM 只负责叙事。

## 1. AI Dungeon（Latitude）

- **回合操作**：Take a Turn 后选模式。Do 做动作，Say 自动加“You say”和引号，Story 是玩家自己写旁白，See 生成图片。主要按钮：Continue、Retry、Erase、Undo/Redo。
- **Retry Stack**：多次重试结果叠成栈，可在版本间挑选；每次重试都计费。
- **Erase 与 Undo 分开**：Erase 本身算一个动作，可以被撤销；Undo 只在当前会话有效。
- **Erase to Here**：双击某段文字，从那里往后全部删掉。
- **直接编辑**：点任意段落就能改，点空白处保存。
- **外观设置**：紧凑按钮、大字体、回合结束后保持输入框打开、关闭文字动画。
- **记忆系统**：每 6 个动作压缩成一条 Memory，最近 6 个动作不压缩（撤销、编辑不会污染记忆）；约每 15 个动作更新一次 Story Summary，可手动改；Memory Bank 用向量检索取回相关记忆；Context Viewer 可查看记忆。
- **Story Cards（原 World Info）**：输入或输出出现触发词才注入上下文；中途被触发的卡要到下一轮才生效。
- **常驻内容**：Plot Essentials（原 Memory）和 Author's Note 每轮都带上。
- **上下文分配**：必需部分最多占 70%，剩下约一半给历史、四分之一给 Memory Bank、四分之一给 Story Cards。
- **剧本占位符**：开局用 `${问题}` 向玩家提问，同样的占位符复用第一次的答案。
- **游戏机制**：本体没有内置属性和背包，只能靠剧本脚本实现。
- 来源：[How to play](https://help.aidungeon.com/faq/how-to-play)、[Memory System](https://help.aidungeon.com/faq/the-memory-system)、[Story Cards](https://help.aidungeon.com/faq/story-cards)、[Erase to Here](https://help.aidungeon.com/faq/what-is-erase-to-here)、[Scripting](https://help.aidungeon.com/scripting)、[Heroes 公告](https://content.latitude.io/blog/sharpening-our-focus-on-ai-dungeon/)、[占位符指南（第三方）](https://arcanumrpgs.com/blog/ai-dungeon-scenario-creation/)、[故障与重复（第三方）](https://arcanumrpgs.com/blog/ai-dungeon-not-working/)

**Voyage（Latitude，2026-04 扩大测试，2026-08-26 公测）**
- 确定性的 World Engine 管理 HP、物品、货币、位置、关系。官方原话：“when the rules say you're out of gold, you're out of gold”。
- 每回合先由引擎和骰子裁定结果，再由模型叙事（resolve before narrate）。
- 手机优先设计；GM 性格选项从温和到硬核，影响基调和节奏，不只是难度。
- 已知问题：背包和装备经常出错；叙述者会改写玩家台词、替玩家角色做事；没有内置导出。
- 来源：[Voyage 指南](https://arcanumrpgs.com/blog/voyage-guide/)、[TechCrunch](https://techcrunch.com/2026/04/21/voyage-is-an-ai-rpg-platform-for-creating-custom-gaming-worlds-with-ai-generated-npc-interactions/)、[GamesBeat](https://gamesbeat.com/latitude-launches-ai-game-voyage/)、[RuntimeWire](https://runtimewire.com/article/latitude-opens-voyage-ai-roleplay-world-engine)

**体验好坏**：Retry Stack 和可撤销的 Erase 让试错成本很低；但免费档上下文小、容易遗忘，重复和循环严重，“骰子不是真骰子”。

## 2. SillyTavern

- **消息操作**：Swipe 为同一条回复生成其他版本；每条消息可编辑、删除、移动、设为 AI 可见/不可见；Prompt 按钮查看实际发送的提示词和 token。
- **分支**：Create Branch（复制到这里并切过去）与 Create Checkpoint（命名存档不切换）；每个分支是独立聊天文件并链接父聊天；Timelines 扩展画出分支和 swipe 的树状图。
- **World Info / Lorebook**：扫描深度、注入位置可调；只有 Content 字段进上下文，条目要能独立读懂。
- **Summarize 扩展**：每 N 条消息自动摘要或手动摘要；可编辑、可回退、可暂停；官方提醒摘要可能幻觉。
- **Persona**：管理玩家身份。
- **体验**：控制粒度最细，适合高级用户；手机只能通过 Termux 运行，第三方“移动优化”前端的卖点就是滑动顺畅和单手操作。
- 来源：[Chatting](https://docs.sillytavern.app/usage/chatting/)、[Chat File Management](https://docs.sillytavern.app/usage/core-concepts/chatfilemanagement/)、[Timelines](https://github.com/SillyTavern/SillyTavern-Timelines)、[World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)、[Summarize](https://docs.sillytavern.app/extensions/summarize/)、[Personas](https://docs.sillytavern.app/usage/core-concepts/personas/)

## 3. NovelAI

- **Text Adventure 输入**：Do 自动加“> You”；Say 根据结尾标点变成说/问/喊；以 `!` 开头原样输入；以 `*` 结尾让 AI 补完动作。
- **Lorebook**：按关键词激活，有 token 预算。
- **Context Viewer**：列出每段上下文的来源和被纳入的原因。
- **Retry Tree**：Redo 旁有计数，可看到所有重试版本（未核实是否仍如此）。
- **体验**：透明度高，但设置项太多，新手困惑。
- 来源：[Text Adventure](https://docs.novelai.net/en/text/textadventure/)、[Lorebook](https://docs.novelai.net/en/text/lorebook/)、[Context Viewer](https://docs.novelai.net/en/text/editor/advancedsettings/)

## 4. Character.AI 与移动端聊天产品

- **滑动换回复**：最后一条回复左右滑动看其他版本，继续聊即选定该版本。
- **评分**：1 到 4 星。
- **记忆（2026 年 4–5 月更新）**：长按消息 Pin 到 Story Memory；Facts 自动抓取人设细节可编辑；Memory Usage 用容量条显示占用；Auto-Compact 压缩旧聊天但不压缩固定内容。
- **问题**：swipe 只是换说法，情节结果不变（第三方）。
- **猫箱**：回溯分出新路线最受讨论；差评有“吞设定”、角色降智、误点“从头开始”丢进度。
- 来源：[Pinned Memories](https://support.character.ai/hc/en-us/articles/24327914463003-New-Feature-Pinned-Memories)、[官方 Book](https://book.character.ai/character-guide/training-a-character)、[Memory 更新 pt.5](https://x.com/character_ai/status/2052456668018160039)、[swipe 只换说法](https://www.roborhythms.com/character-ai-same-response-every-swipe/)、[猫箱评测](https://www.aixq.cc/27600.html)

## 5. 有结构化状态的 AI RPG

**Friends & Fables（Franz）**：每个玩家动作同时发给多个专职模型（查设定、更新角色卡、维护地图、写叙事）；每次回复前生成玩家能看能改的“工作上下文”；跨会话一致性好，不能靠嘴炮骗奖励；但连续出错会滚雪球，价格偏贵。来源：[评测 1](https://arcanumrpgs.com/blog/friends-and-fables-review/)、[评测 2](https://dreamgen.com/blog/articles/friends-and-fables-review)

**AI Roguelite**：物品、行动合理性和属性骰共同决定结果，再把故事喂回 AI 判断敌人状态；早期每类判断一个提示词，后来合并成 Unified 模式减少矛盾，但 2026 年仍在修 JSON 解析和截断；玩家抱怨不告诉检定哪个属性、AI 只写故事不像 GM。来源：[Steam](https://store.steampowered.com/app/1889620/AI_Roguelite/)、[更新日志](https://steamcommunity.com/app/1889620/announcements/)

**Hidden Door（2025-08 网页版）**：每段叙事约一个情节节拍，结尾给建议行动；有角色卡、地点卡、物品卡、剧情方向卡；章节目标出现与完成都有提示。Ian Bicking 批评：几乎每次都成功、世界“不落地”、状态自相矛盾；建议维护隐藏世界状态与变更日志、先定结果再写文字、允许真正的失败、用流式输出掩盖延迟。来源：[Ian Bicking 评测](https://ianbicking.org/blog/2025/08/hidden-door-design-review-llm-driven-game)、[Arcanum 评测](https://arcanumrpgs.com/blog/hidden-door-review/)、[PC Gamer](https://www.pcgamer.com/hidden-door-ai-game-narrative-rpg/)

**Infinite Worlds**：作者自定义“tracked items”（技能、背包、关系）并附更新说明；有隐藏信息字段，摘要器重点保留。来源：[社区 FAQ](https://infiniteworlds.mywikis.wiki/wiki/Frequently_Asked_Questions)

**Dreamjourney**：宣传 Lorebook、向量记忆、中途换模型、Director 模式、重新生成和分支（独立验证不足）。来源：[官网](https://dreamjourneyai.com/)

## 6. 工程方案：先叙事再抽取，还是一次输出 JSON

- 论文《Let Me Speak Freely?》（EMNLP 2024）发现推理类任务在 JSON-mode 下明显退化，“先用自然语言作答再转格式”几乎不掉分；分类任务反而可能受益。推论（未在叙事任务上直接测过）：正文用自由文本，状态变更作为“分类 + 抽取”单独结构化。来源：[论文](https://arxiv.org/abs/2408.02442)
- Wordplay 2024 把游戏规则做成函数供 GM 调用，报告叙事质量和一致性都有提升；ChatRPG v2 把角色拆成 Narrator 和 Archivist。来源：[Wordplay](https://wordplay-workshop.github.io/wordplay2024/pdfs/11.pdf)、[ChatRPG](https://arxiv.org/html/2502.19519v2)
- 业界共识：模型提出的状态变更必须先经过游戏逻辑校验才能写入。
- 可靠性（第三方估计，未核实）：只靠提示词输出 JSON 约 80%–95%，工具调用约 95%–99%，原生约束解码能保证格式合法。来源：[结构化输出](https://dev.to/pockit_tools/llm-structured-output-in-2026-stop-parsing-json-with-regex-and-do-it-right-34pk)
- 延迟取舍：多次调用会叠加延迟，常见做法是叙事先流式输出、抽取在后台异步跑；合并成一次调用能减少矛盾，但要长期修解析和截断问题。

## 7. 值得采用的 UX 模式（调研原文）

1. 输入模式切换（做 / 说 / 旁白），中文按钮加标点自动识别。【AID、NAI】
2. 每回合 3–4 个建议行动，保留自由输入框。【Hidden Door、Voyage】
3. “继续”按钮。【AID】
4. 重试结果做成可滑动卡片栈。【AID、ST、C.AI、NAI】
5. “删除这一回合”可撤销，与撤销/重做分开。【AID】
6. 长按某段“回到这里”，可撤销。【AID】
7. 任意段落直接编辑，AI 按新文本继续写。【AID、ST、NAI】
8. 长按节点分支：分出并切换，或命名存档不切换。【ST、猫箱】
9. 时间线树视图。【ST Timelines、猫箱】
10. “从头开始”和“回溯”明确分开并二次确认。【猫箱】
11. 最近 N 回合不压缩。【AID】
12. 玩家可编辑剧情摘要，有回退、可暂停。【AID、ST】
13. 长按固定记忆，不被压缩。【C.AI、AID】
14. 记忆容量条。【C.AI】
15. 上下文查看器，说明每条资料为什么被纳入。【NAI、AID、F&F】
16. 设定卡片按关键词注入，中文要处理别名和字号。【AID、ST、NAI】
17. 开局问卷，同样的问题复用同一答案。【AID】
18. 状态由确定性引擎持有，LLM 只能提议变更。【Voyage、F&F、Wordplay】
19. 先裁定后叙事，判定依据对玩家可见。【Voyage、Hidden Door】
20. 状态变化即时提示（“银两 −20”“声望 ↑”）。【Hidden Door、Voyage】
21. 目标和任务出现、完成都有提示。【Hidden Door、Voyage】
22. 难度 / GM 性格档位，影响节奏和基调。【Voyage】
23. 叙事流式输出，掩盖多次调用延迟。【Bicking】
24. 手机阅读设置：大字号、紧凑按钮、关闭打字动画、回合后保持输入框。【AID】
25. 重试/生成前显示费用或配额估计。【AID】

## 8. 要避免的坑

1. 长线遗忘、设定被“吞”。
2. 重复和循环。
3. 几乎永远成功，选择不影响剧情。
4. 判定是黑箱。
5. AI 替玩家角色说话、行动，或改写玩家台词。
6. 状态自相矛盾，物品凭空出现或消失。
7. 小错滚雪球，最后只能重开整局。
8. 重试只换说法不换结果。
9. 设置项太多，新手被劝退。
10. 配额不透明、误触破坏性操作丢进度。

额外提醒：摘要会产生幻觉，内容过滤过严会打断正常剧情；两者都需要可见、可改、可回退的机制。
