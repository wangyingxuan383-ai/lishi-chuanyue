# 同类产品功能广度调研（方向 O）

> 调研日期：2026-10-17（Asia/Shanghai）。所有外部资料的查阅日期均为 2026-10-17，链接见各节和文末“来源”。对应 [第四版总计划](../PLAN_V4.md) 方向 O“功能广度”。
>
> 本报告**不重复**已有调研：AI Dungeon 的回合操作与记忆系统、SillyTavern 的分支与摘要、NovelAI 的输入方式与上下文查看器、Character.AI 的滑动换回复（见 [海外产品调研](COMPETITORS_INTL.md)）；星野、猫箱、筑梦岛的界面细节与阅读 App（见 [中文 UX 调研](UX_CN.md)）；各家的服务与模型管理（见 [服务与模型管理](UX_PROVIDERS.md)）；联网搜索（见 [查一查要不要联网](WEB_SEARCH.md)）。这里只补“还有哪些功能”，并判断哪些适合我们。
>
> **用户取向（2026-10-17，经协调者转达）**：现有的内容规则已经太多，不要再加固定的剧情机制和新的内容约束，也不要预先编排故事里发生什么。本报告的推荐因此只集中在**让玩家更有掌控、用得更舒服、让 AI 拿到更好的上下文**的功能：写作与编辑工具、记忆、阅读、分享、定制、App 品质。凡是会增加固定剧情机制（任务链、数值系统、触发事件、胜负条件、挑战规则、NPC 预设阴谋）或新内容约束（屏蔽名单、警告标签、额外写作规则）的功能，一律标为“**不推荐**”并写明理由；目录里仍保留，供以后用户改主意时参考。
>
> 标记说明：【待验证】= 来自第三方评测、营销页或推断，没有在官方文档或实际产品里确认；成本 S/M/L = 大约 1～2 天 / 3～7 天 / 两周以上的单人工作量（含测试与手机尺寸试玩）。

## 一句话结论

同类产品近一年的新功能集中在四处：**① 让玩家“少打字也能掌舵”**（AI Dungeon 的 Guide 与 Guided Retry、Character.AI 的 Pin to Memory、猫箱的回复建议与括号快捷键）；**② 让记忆看得见、改得动**（Character.AI 的 Memory 页与容量条、Dreamjourney 的 Memory Nexus、Friends & Fables 的 NPC 记忆与计划）；**③ 多媒体**（每段配图、朗读、角色语音、背景音乐，几乎全部要额外付费的接口）；**④ 社区与分享**（场景/剧本市场、分享片段、创作者分成）。我们已经把①②做得比多数商业产品更细；按用户取向，真正值得补的缺口在“写和改更顺手”（AI 改写选中段落、代写/润色行动、全屏输入）、“玩家可以自己定制和复用的东西”（要求组、文风样例、开局问答、开局与设定集导入导出）、“AI 拿到更好的上下文”（资料库、设定集整理）、“读起来更舒服”（朗读、自动播放、常亮）和可选的多媒体。同类产品里的剧情结构类功能（任务链、胜负条件、挑战卡、NPC 预设计划、多周目规则、自定义数值）会增加固定机制，**不推荐**。下一批建议 14 项都不需要新的付费服务，其中**AI 改写选中段落**、**代写/润色行动**、**系统朗读**、**我的要求组**、**设定集/世界书导入导出**价值最高。

---

## 一、调研对象速览

只列与“功能”有关的新发现；已在旧报告里写过的不再重复。

| 产品 | 类型 | 2025–2026 值得注意的功能 | 主要来源 |
|---|---|---|---|
| SillyTavern | 开源前端（桌面/自部署） | 内置扩展：聊天翻译、图片识别、生图（7 种模式：角色全身/脸/玩家/全剧回顾/最后一条/背景）、表情立绘、摘要、聊天向量化、朗读（多家，含系统朗读）、Quick Reply、Token 计数；可装扩展：Dynamic Audio（按场景切 BGM 与环境音）、Objective（目标拆成任务、按节奏推进）、Speech Recognition、Live2D/VRM、Blip（打字音）、Guided Generations（230 星，一组“引导”工具：衣着/状态/思考/规则/纠错/代写玩家台词）；STscript 脚本语言、Data Bank（文档 RAG） | [扩展列表](https://docs.sillytavern.app/extensions/)、[生图](https://docs.sillytavern.app/extensions/stable-diffusion/)、[TTS](https://docs.sillytavern.app/extensions/tts/)、[Objective](https://docs.sillytavern.app/extensions/objective/)、[Dynamic Audio](https://docs.sillytavern.app/extensions/dynamic-audio/)、[STscript](https://docs.sillytavern.app/usage/st-script/)、[Data Bank](https://docs.sillytavern.app/usage/core-concepts/data-bank/)、[Guided Generations](https://github.com/Samueras/GuidedGenerations-Extension) |
| RisuAI | 开源前端（网页/桌面/手机网页） | 三层世界书（全局/角色/单个聊天），关键词可写正则、全词匹配、概率触发、优先级与预算；LoreBook+ 用向量匹配；正则脚本与触发器、Lua 脚本；聊天内嵌素材（图片/音频） | [文档](https://kwaroran.github.io/docs/)、[DeepWiki 世界书](https://deepwiki.com/kwaroran/RisuAI/5.4-lorebook-system)、[仓库](https://github.com/kwaroran/RisuAI) |
| Agnaistic | 开源前端 + 托管 | 多用户 + 多角色同一聊天；Memory Book（关键词触发）；角色卡“外貌提示词”专供生图；按角色单独设置生图与声音 | [FAQ](https://edge-api.agnai.chat/faq)、[建角色指南](https://agnai.guide/docs/creating-a-character/) |
| KoboldAI Lite | 开源网页前端 | Memory、Author's Note、World Info；TextDB（粘贴大段资料，切块检索，可选 embedding 语义检索）；冒险/聊天/写作/指令四种模式；可接生图 | [Lite](https://lite.koboldai.net/)、[KoboldCpp 文档](https://koboldcpp.net/docs/features/lite/) |
| ChatterUI | 开源安卓 App（2677 星） | 0.10.0（2026-09）：多语言界面含中文、Author Notes（按聊天/角色/全局，可设插入深度）、Lorebooks（可导入 JSON）、角色绑定连接/采样参数/格式、自定义请求字段、上下文占用估算、回到底部按钮；0.9.0：系统 TTS、在其他 App 选中文字“用 ChatterUI 问”、从某处 Fork、屏幕常亮、分开的深浅主题；Character Card v2 导入导出 | [仓库](https://github.com/Vali-98/ChatterUI)、[Releases](https://github.com/Vali-98/ChatterUI/releases) |
| AI Dungeon（Latitude） | 商业 | 2026：Story Card 生成器重做（用当前模型、全文上下文、可改命令）、Story Card 分类折叠与批量删除、可复用的 AI 指令集、多选题占位符（开局问答）、图片风格组件、Guided Continues（私下引导一次续写，不进故事）、Custom Retry Guidance、增强版 Memory Bank、Adventure Narration（设备朗读免费，高级音色收费，可调语速、自动播放）、Your Story So Far（活动日历、高光、最长冒险）、每日连续签到、脚本可直接加到自己的冒险里、生成封面、故事片段转短视频；Multiplayer 仍在 | [What's New](https://play.aidungeon.com/whats-new)、[Alchemy](https://aidungeon.com/alchemy)、[Story Card 生成器](https://play.aidungeon.com/whats-new/feature/announcement%3Aaid-story-card-generator-rework) |
| Latitude Voyage | 商业 | 确定性 World Engine（HP/物品/货币/位置/关系），先裁定后叙事；2026-09 开放 Creator API | [Latitude 新闻](https://latitude.io/news)、旧报告 |
| Character.AI | 商业 | Scenes（2025-10 开放创作：设定/背景/玩家目标/开场白/封面/标签）、Stories（2025-11：选 2～3 个角色 + 类型 + 前提，图文分支、可重玩、可分享）、AvatarFX（图生视频）、Streams（两个角色自己对话）、Imagine Gallery（2026-03）、群聊里角色会互相接话、Memory 页（2026-05：Story Memory、长按 Pin、自动 Facts 可编辑可禁用、记忆容量条、新聊天可复制 Facts）、Lorebook 在做 | [Scenes](https://blog.character.ai/introducing-scenes-your-new-way-to-tell-stories-on-c-ai/)、[Stories](https://blog.character.ai/introducing-stories-a-new-way-to-create-play-and-share-adventures-with-your-favorite-characters/)、[Memory](https://blog.character.ai/memory/)、[2025-09 社区更新](https://support.character.ai/hc/en-us/articles/41760067000475-Community-Update-September-2025) |
| Talkie / 星野（MiniMax） | 商业 | 抽卡（星念/卡牌）、AI 主动来电、角色朋友圈、捏音色、聊天记录印成实体书【待验证】 | [钛媒体](https://www.tmtpost.com/7823036.html)、[什么值得买](https://post.smzdm.com/p/a8256lzq/)、[Talkie 评测](https://aicompanionradar.com/articles/talkie-plus-explained) |
| Janitor AI / Chub | 商业（自带代理/Key） | Chub：大型角色卡库、Lorebook、分支聊天树；Janitor：聊天记忆模板、代理接入 | [Chub Lorebooks](https://docs.chub.ai/docs/advanced-setups/lorebooks)、[Janitor 记忆](https://help.janitorai.com/en/article/chat-memory-context-management-9oivt3/) |
| Infinite Worlds | 商业 | 作者可定义 Tracked Items（文本/数字/XML/YAML，可见性六档：玩家与 AI/仅 AI/仅玩家/隐藏，带“更新说明”）、Trigger Events（7 种条件、22 种效果）、胜利/失败条件、关键词指令块、PawScript（2026-07）、Storyteller 模式（看隐藏字段、强制下一回合）；第 8 回合起每 6 回合摘要，含“剧情线”和“人物档案” | [世界编辑](https://infiniteworlds.mywikis.wiki/wiki/World_editing)、[Tracked Items](https://infiniteworlds.mywikis.wiki/wiki/Items_to_track)、[工作方式](https://infiniteworlds.mywikis.wiki/wiki/How_Infinite_Worlds_works)、[PawScript](https://infiniteworlds.mywikis.wiki/wiki/PawScript) |
| Friends & Fables | 商业 TTRPG | 世界地图编辑器（多边形、分层、网格）、旅行系统、任务与单次冒险、NPC 记忆与计划（25.41）、Memories V2、阵营同步、OOC 模式、语音输入、朗读、生图与场景图、休息、XP 升级、组队检定 | [官网](https://fables.gg/)、[Patch Notes](https://fables.gg/patch-notes) |
| AI Roguelite | 商业（Steam） | AI 生成实体与合成配方、属性条变化动画、每个实体一张图（本地 GPU 或云）、最多 4 名队友、派系声望、世界/宇宙层级地图拖拽、导出世界预设、多语言 | [Steam](https://store.steampowered.com/app/1889620/AI_Roguelite/)、[更新](https://steamcommunity.com/app/1889620/announcements/) |
| Hidden Door | 商业 | 世界=一副卡牌（人物/地点/物品卡可收集解锁），Modifier 卡可跨世界叠加，一个故事 1～3 幕；Moments（带贴纸、边框的分享截图，2025-12）；Atlas 世界编辑器（2026-05：从一句话或粘贴设定开始）；“我的想法”按钮让玩家提自己的故事线；快慢两条线：慢线在玩家阅读时做后台规划，只有 0.5% 回合需要等待 | [FAQ](https://www.hiddendoor.co/help/faq)、[Atlas](https://www.hiddendoor.co/blog/atlas-worldbuilding-interactive-world-builder-storytelling-rpg)、[2026 新年](https://www.hiddendoor.co/blog/new-year-goodbye-2025-hello-2026)、[快慢架构](https://www.hiddendoor.co/blog/fast-slow-architecture-latency-turn-based-narrative) |
| Dreamjourney | 商业 | Memory Nexus（可编辑的长期记忆、可单次关闭）、Director 模式（引导下一条回复）、按场景选“声音”的模型、重新生成与“从这里分支” 【多为营销页，待验证】 | [Memory Nexus](https://dreamjourneyai.com/blog/ai-that-remembers-memory-nexus)、[Storytelling](https://dreamjourneyai.com/ai-storytelling) |
| Talefy | 商业 | 随时生成本段配图、朗读、语音输入、新手冒险引导；没有世界书和脚本；记忆测试较差（第三方） | [DreamGen 评测](https://dreamgen.com/blog/articles/talefy-ai-review)、[Google Play](https://play.google.com/store/apps/details?id=com.talefyaiapp&hl=en) |
| 猫箱（字节） | 商业 | 回溯到任意一句、回复建议、括号快捷键（写动作/心理）、语音通话、多章节故事创作并可加背景音乐、AI 创作助手一问一答生成角色与故事（自动分章、设结局）、三种对话模式（普通/心动/细腻）记忆不互通（玩家吐槽） | [产品库介绍](https://aiproducthub.cn/sites/bytedance-maoxiang-ai-emotional-companion.html)、[App Store](https://apps.apple.com/cn/app/id6475000292)、[微博](https://www.sina.cn/news/detail/5310913959693946.html) |
| 筑梦岛（阅文） | 商业 | 梦屋（多角色群聊）、小剧场（番外、特定场景）、梦境（保存精彩对话，可公开或接着聊）、亲密度解锁、角色发动态、打电话 | [9200 介绍](https://9200.cn/tools/2273)、[Foreverse 横评](https://foreverse.cn/zh/ai-roleplay-apps) |
| 造梦次元 | 商业 | 互动故事 + 角色 + 生图/换装/音乐/MV；日均使用约 1 小时 50 分钟 | [36氪/新浪](https://finance.sina.cn/stock/jdts/2026-01-19/detail-inhhvsfx9800273.d.html?vt=4) |
| 冒泡鸭、X Eva、豆包智能体 | 已停运或下线 | 冒泡鸭：剧情互动带主线任务、分章节、成功/失败条件、“专属回忆”；2025 年停运。X Eva 关闭充值注册；豆包、千问 2026-07-15 下线自定义智能体（配合《人工智能拟人化互动服务管理暂行办法》）。玩家的最大恐惧是“角色和记忆带不走” | [腾讯新闻](https://news.qq.com/rain/a/20250604A02RM500)、[钛媒体](https://www.tmtpost.com/7718052.html)、[梭哈 AI](https://www.163264.com/14078) |
| Foreverse（新梦） | 商业（自带 Key 的手机酒馆） | chara_card_v3 完整导入导出（PNG/JSON/.charx），卡内世界书、正则随卡激活；原著 txt/epub 整本导入、在分支上写 if 线 | [横评页](https://foreverse.cn/zh/ai-roleplay-apps) |
| 开源引擎 | GitHub | **waidrin**（385 星，2025-07）：JSON Schema 约束生成的类型化状态机，动态建地点与人物；**ai_rpg**（151 星，2025-09）：地区节点图地图、NPC 记忆、真随机检定 + AI 给环境加值、需求系统（饥饿/休息）、多维好感（友情/爱慕/信任/尊重，缓慢变化）、按“场景”而非按行摘要、可读 SillyTavern 世界书；**Project Lunar**（39 星）：开局问答 `{{变量}}`、AI 冷开场、四层记忆、**目击者过滤**（NPC 不知道自己不在场的事）、**离场世界按经过的时间演化**、NPC 私下的感受/目标/对玩家看法/秘密计划、自动大事记、自动剧情钩子；**aisandboxgame**（65 星，2026-03，纯前端 BYOK）：访谈式造世界、d20、游戏内手机短信、斜杠命令、羊皮纸/木纹主题、PWA；**DiceFrame**（123 星，2026-07，中文）：COC/DND/自由规则、世界书、可选 embedding、系统 TTS 零配置回退并可接 OpenAI 兼容 TTS 与 GPT-SoVITS、OpenAI 兼容生图做场景/头像/道具/地图、QQ 群机器人；**OpenStory 万象谱**（429 星，浙大，2026-04）：多智能体模拟的故事世界，一句话生成可交互世界 | [waidrin](https://github.com/p-e-w/waidrin)、[ai_rpg](https://github.com/envy-ai/ai_rpg)、[project-lunar](https://github.com/horizonfps/project-lunar)、[aisandboxgame](https://github.com/hayowei/aisandboxgame)、[diceframe](https://github.com/diceframe/diceframe)、[OpenStory](https://github.com/ZJU-LLMs/OpenStory) |

**没查到可靠资料的**：NovelAI 2025–2026 的文字端新功能（官方文档主要是脚本 API，[脚本 API](https://docs.novelai.net/en/scripting/api-reference/) 能读写文档、历史节点、作者注、世界书，说明它在往“用户脚本”走）【待验证】；AI Dungeon“Heroes”最后改名为 Voyage（[Latitude 新闻](https://latitude.io/news) 中“We Can't Launch Heroes...With That Name”），不是独立产品；Talkie 的“声音克隆”只见于第三方评测【待验证】。

---

## 二、功能目录（按主题）

每个表的列：**功能 · 谁有 · 给玩家什么 · 适合我们吗 · 成本 · 依赖**。“适合”的判断基于：单机、自带 OpenAI 兼容模型、历史穿越为主、计划中的自由异世界模式（方向 M）、手机优先、玩家语言（PLAN_V3 第 4.12 节）、六条体验支柱。“已有”表示我们已经实现（见第三节），这里列出只为完整。

### 2.1 写作辅助

| 功能 | 谁有 | 给玩家什么 | 适合我们吗 | 成本 | 依赖 |
|---|---|---|---|---|---|
| 续写（不行动，让故事往下走） | 全部 | 卡住时不用想 | 已有（“续写”） | — | — |
| 重说 + 重说时提要求 | AI Dungeon Custom Retry Guidance、Guided Retry；Dreamjourney | 只改不满意的那一点 | 已有 | — | — |
| 私下引导下一段（不进故事） | AI Dungeon Guided Continues / Guide；Infinite Worlds Storyteller 输入框；Dreamjourney Director | 掌舵感，不破坏代入 | 已有（“幕后要求”） | — | — |
| 改写选中的一段文字（扩写、缩写、换语气、更古雅/更白话） | SillyTavern Guided Generations（Corrections、Spellchecker）；NovelAI 编辑器；猫箱改写【待验证】 | 不满意一句话就改一句话，不用整段重说 | **适合**。我们有“改写这段文字”（手改）和“把这段删改成一句”，缺“让 AI 按要求改这一段”。历史模式可加“改得更像那个时代”。 | S | 无 |
| 代写玩家的行动/台词（Impersonate） | SillyTavern、Guided Generations（第一/二/三人称代写）、ChatterUI | 不知道怎么说时让 AI 先替你拟一句再改 | **适合**：放在输入框里，生成后可编辑，不直接发送 | S | 无 |
| 行动润色（把“我去找县令”扩成一段有细节的行动） | 猫箱回复建议、AI Dungeon Do 模式补全 | 少打字，行动写得更好 | 适合，可和上一项合并 | S | 无 |
| 括号/快捷符号（动作、心理、旁白） | 猫箱括号键、NovelAI `!`/`*` | 手机上少切键盘 | 已有输入方式切换（行动/说话/写/幕后），可补一个“插入（）”快捷键 | S | 无 |
| 翻译（界面外的正文翻译） | SillyTavern Chat Translation | 用外语模型写，读中文 | 不适合：我们只做中文，模型直接写中文 | — | — |
| 文风迁移（整局切换文风、换叙述人称） | SillyTavern 预设、Infinite Worlds Author style、Hidden Door 世界风格 | 一局之中换口味 | 已有本局文风/人称/篇幅设置；可加“文风样例”（贴一段喜欢的文字让 AI 模仿） | S | 无 |
| 关键词替换/过滤（正则） | SillyTavern Regex、RisuAI 正则脚本、ChatterUI 文本过滤 | 去掉模型的口头禅、统一标点 | **不推荐**：等于再加一层内容规则；用户已认为规则太多。模型口头禅更适合用“AI 改写选中段落”就地处理 | — | — |
| 反重复 / 去“AI 腔” | ai_rpg（自称最好的去重复系统）、Guided Generations | 长局不腻 | 谨慎：只能做成减法（精简现有提示词），不再往提示词里加规则；需登记评测费用 | M | 评测费用 |
| 拼写/错字修正 | Guided Generations Spellchecker | — | 不需要（中文输入法已足够） | — | — |

### 2.2 记忆与世界

| 功能 | 谁有 | 给玩家什么 | 适合我们吗 | 成本 | 依赖 |
|---|---|---|---|---|---|
| 关键词触发的设定卡（世界书） | 全部 | 设定不丢 | 已有（设定集） | — | — |
| AI 自动建卡/整理设定卡 | AI Dungeon Story Card 生成器、Friends & Fables、ai_rpg | 不用自己维护 | 已有（自动整理设定集） | — | — |
| 设定卡分类、折叠、排序、批量删除 | AI Dungeon（2026-04） | 卡多了还找得到 | 适合；设定集多了以后需要 | S | 无 |
| 长按正文“记住这件事” / Pin | Character.AI Pin to Memory | 一步钉住关键时刻 | 已有 | — | — |
| 记忆容量条 / 上下文占用 | Character.AI Memory Usage、ChatterUI 估算 | 知道 AI 还记得多少 | 已有（上下文查看器，开发者向）；可做一个玩家语言的“这一局 AI 记得多少”小条 | S | 无 |
| 自动抓取人物事实，可编辑可禁用 | Character.AI Facts | 人物不崩 | 已有（人物志、来历） | — | — |
| 章节摘要 + 剧情线 + 人物档案 | Infinite Worlds、AI Dungeon Story Summary | 长局不忘主线 | 适合（属于给 AI 更好的上下文）：在章节摘要里保留“还没了结的事”，只记录、不规定剧情该怎么走 | M | 评测费用 |
| 向量记忆 / 语义召回 | AI Dungeon Memory Bank、SillyTavern Chat Vectorization、RisuAI LoreBook+、KoboldAI TextDB、DiceFrame（可选） | 很久以前的事也能想起 | 我们用无模型的“相关旧事”召回已达 94%（R04 评测 I），**向量检索不是急需**；可作为可选增强 | M | 需要 embedding 接口（OpenAI 兼容 `/embeddings`，很多中转服务支持）或本地小模型 |
| 资料库 / 粘贴大段资料（RAG） | SillyTavern Data Bank、KoboldAI TextDB、Foreverse 原著整本导入 | 把史料、原著、自己写的设定整本放进去 | **适合**（尤其异世界“穿书”）：先做无向量版（关键词切块检索，复用现有 match），有 embedding 再增强 | M | 可选 embedding |
| NPC 各自的记忆 + 目击者过滤 | Friends & Fables NPC Memory、ai_rpg、Project Lunar witness filter | NPC 不会知道自己不在场的事，更像活人 | 可选（上下文类）：只在人物志里**记录**“谁在场、谁知道”，作为给 AI 的参考事实，不加行为规则；优先级中 | M | 无 |
| NPC 的心思与计划（隐藏目标、对你的看法、秘密打算） | Project Lunar Independent Minds、Friends & Fables Planning、Hidden Door 慢线 | 世界会主动找上你，有阴谋和惊喜 | **不推荐**：由程序替 NPC 预设隐藏目标和阴谋，等于预先编排剧情，又多一套要 AI 遵守的规则。叙事模型本身就会让人物有动机 | — | — |
| 离场世界随时间演化 | Project Lunar Reactive World | 回到长安，旧识已升官或下狱 | 已有天下大事与过些日子，**不再加**新的演化机制（会多一套规则） | — | — |
| 多维好感 / 关系 | ai_rpg（友情/爱慕/信任/尊重）、AI Roguelite 派系声望、F&F 关系管理 | 关系看得见、慢慢变 | **不推荐**：新的数值系统属于固定机制；关系用人物志里的文字描述即可 | — | — |
| 时间线 / 年表 | SillyTavern Timelines（分支树）、我们的年表 | — | 已有（世界线、回合树、年表、天下大事） | — | — |
| 地图（节点图 / 手绘地图 / 层级地点） | Friends & Fables 地图编辑器、ai_rpg 节点图、AI Roguelite 层级、aisandboxgame 六角格 | 知道自己在哪、去过哪 | 适合做**轻量版**：按地点卡自动画“去过的地方”关系图或层级列表，不做真实地理；真实历史地图需要授权数据（候选池已有 CHGIS） | M（关系图）/ L（真实地图） | 历史地图需核实数据授权 |
| 物品/状态的程序记账 | Voyage World Engine、Infinite Worlds Tracked Items、AI Roguelite | 钱花完就是没了 | 已有（行囊、钱、伤病、状况） | — | — |
| 自定义追踪项（玩家自己加“修为”“好感”“官声”等数值） | Infinite Worlds Tracked Items（含可见性与更新说明） | 异世界题材各有各的数值 | **不推荐**（至少不作为内置机制）：新增程序记账的数值系统；异世界的修为、等级写进设定集文字即可，由 AI 叙述 | — | — |
| 触发事件（条件满足时自动发生） | Infinite Worlds Trigger Events、AI Dungeon 脚本 | 作者能设计机关和结局 | **不推荐**：典型的预先编排剧情 | — | — |
| 胜利/失败条件 | Infinite Worlds、冒泡鸭 | 有终点、有目标 | **不推荐**：固定的胜负判定是新机制；玩家的心愿已在目标页，由玩家自己决定结局 | — | — |

### 2.3 人物

| 功能 | 谁有 | 给玩家什么 | 适合我们吗 | 成本 | 依赖 |
|---|---|---|---|---|---|
| 多个同伴同行 | AI Roguelite（4 名队友）、ai_rpg、F&F 队伍 | 有人陪着走 | 叙事里已能自然出现，不另加机制 | — | — |
| 群像场景 / 多角色同台互相接话 | Character.AI 群聊、筑梦岛梦屋、SillyTavern 群聊、Agnaistic | 朝堂、宴席、修罗场 | 我们是“叙事者写全场”，天然就是群像；不需要聊天式群聊 | — | — |
| 两个角色自己对话（看戏） | Character.AI Streams | 观赏 | 不需要：玩家写一句“躲在屏风后听”即可，不另做功能 | — | — |
| 角色卡导入导出（Character Card v2/v3 PNG/JSON） | SillyTavern、ChatterUI、Foreverse、Chub、Janitor | 带走自己的角色，用社区的卡 | **适合**：导入卡 → 生成人物志条目或开局主角；导出主角/人物为卡。中文社区“捏崽”玩家普遍有酒馆卡 | M | 无（PNG tEXt 解析） |
| 世界书导入导出（SillyTavern/Chub 格式） | SillyTavern、ChatterUI、ai_rpg、RisuAI | 复用社区设定 | **适合**：导入成设定集卡片；候选池已有“分享整套世界设定” | M | 无 |
| 玩家多身份（Persona） | SillyTavern、Agnaistic | 同一世界换个人玩 | 部分已有（每局一个主角）；“用同样设定再开一局”已有 | — | — |
| 角色立绘 / 表情立绘 | SillyTavern Expressions、星野 | 看得见人 | 需要图片；可先允许玩家给人物**上传头像**（无需接口） | S（上传）/ L（生成） | 生成需图片接口 |
| NPC 主动来找你 | 星野主动来电、Character.AI 角色主动发消息 | 世界有生气 | **不推荐**：程序安排 NPC 定时登场属于编排剧情；也不做打扰式推送 | — | — |
| 角色朋友圈/动态 | 筑梦岛、猫箱、星野 | 角色有自己的生活 | 不做：会多一套生成内容的机制；天下大事已足够 | — | — |
| 亲密度解锁 | 筑梦岛、LoveyDovey | 养成感 | 不适合直接照搬（拟人化监管、情感依赖风险）；用“关系”与“人物来历”自然体现即可 | — | — |

### 2.4 媒体

| 功能 | 谁有 | 给玩家什么 | 适合我们吗 | 成本 | 依赖 |
|---|---|---|---|---|---|
| 朗读（系统 TTS） | AI Dungeon Narration（设备音色免费）、ChatterUI、SillyTavern、DiceFrame、Talefy | 躺着听、通勤听、眼睛休息 | **很适合**，零费用。注意：安卓 WebView 不支持网页 `speechSynthesis`（[Can I WebView](https://caniwebview.com/features/mdn-speechsynthesis/)、[Chromium 40417848](https://issues.chromium.org/40417848)），要走安卓原生 `TextToSpeech`，可参考 [tauri-plugin-tts](https://github.com/httpjamesm/tauri-plugin-tts/) 或自写 Kotlin 插件；Windows 的 WebView2 支持 `speechSynthesis`。中文离线音色取决于手机自带引擎（小米有）【待真机验证】 | M | 安卓原生插件 |
| 自动播放（读完一段自动下一段，可调语速） | AI Dungeon 自动播放、猫箱 | 解放双手 | 适合，与朗读一起做 | S | 朗读 |
| 高品质语音 / 角色分声 | AI Dungeon Expressive 音色、SillyTavern Voice Map、DiceFrame（OpenAI 兼容 TTS、GPT-SoVITS）、猫箱 150+ 音色 | 有声剧 | 可选：接玩家自带的 OpenAI 兼容 `/audio/speech`；按人物分配音色 | M | TTS 接口（付费或自部署） |
| 语音输入 | F&F Speech to Text、Talefy、SillyTavern、猫箱按住说话 | 手机上少打字 | 适合：先用输入法自带的语音键（零成本，指南里说明即可）；原生语音识别价值有限 | S | 无 |
| 每段配图 / 场景图 | AI Dungeon See、Talefy、Infinite Worlds、Character.AI Imagine、AI Roguelite、DiceFrame | 画面感 | 可选；按需点一下生成，不自动（控制费用）；历史题材需写好风格提示（工笔、水墨） | M | 图片接口（OpenAI 兼容 `/images/generations` 或其他） |
| 人物肖像生成 | SillyTavern “Your Face”、Agnaistic 外貌提示词、Infinite Worlds 肖像框 | 记住人物长相 | 可选，与配图同一接口；人物志加“外貌”字段专供生图 | S（在配图之上） | 图片接口 |
| 封面生成 | AI Dungeon 生成封面、Infinite Worlds | 书架好看 | 可选；不接接口时用现有印章 + 朝代纹样生成封面（零成本） | S | 可选图片接口 |
| 图片风格预设 | AI Dungeon Image Style、Infinite Worlds Image style | 一局画风统一 | 随配图一起做 | S | 图片接口 |
| 视频（片段转短视频、立绘动起来） | AI Dungeon H3、Character.AI AvatarFX | 炫 | 不适合：贵、慢，与“书卷”方向不符 | — | — |
| 背景音乐 / 环境音（按场景切换） | SillyTavern Dynamic Audio、F&F 音乐生成、猫箱故事 BGM | 氛围 | 适合做**本地内置**的少量免版税曲目与环境音（雨、市集、更鼓、风雪），按场景关键词或手动切换；不接生成接口 | M | 需挑选可商用/CC0 音频，安装包会变大 |
| 打字音 / 翻页音 | SillyTavern Blip | 手感 | 小而有趣；可选开关 | S | 内置音效 |
| 图片识别（玩家发图给 AI） | SillyTavern Image Captioning、猫箱发图、ai_rpg “Take me there” | 用一张画开局 | 低优先：需要多模态模型；可用于“用一幅画开一局”【待评估】 | M | 多模态模型 |

### 2.5 剧情结构

> 按用户取向，本节大部分是同类产品的固定剧情机制，只作记录；推荐的只有不限制剧情的开局定制与回顾类功能。

| 功能 | 谁有 | 给玩家什么 | 适合我们吗 | 成本 | 依赖 |
|---|---|---|---|---|---|
| 任务 / 目标 / 主线支线 | F&F Quests、Objective 扩展、冒泡鸭主线任务、Hidden Door 章节目标 | 有盼头 | 已有（目标页、心愿）；候选池有“目标记得更像目标” | — | — |
| 目标拆成步骤，AI 按节奏推进 | SillyTavern Objective（自动生成任务、按回合检查完成） | 主线不散 | **不推荐**：AI 自动拆任务并“按节奏推进”就是编排剧情 | — | — |
| 章节（自动分章、回目） | AI Dungeon、猫箱多章节、我们的回目 | 有段落感 | 已有（章节摘要、回目目录） | — | — |
| 成就 | Steam、AI Dungeon 签到徽章、Hidden Door 收集卡 | 留下东西 | 已有（印谱 12 枚，按状态计算、不影响剧情）；可小幅扩充，属于纪念而非规则 | S | 无 |
| 结局与结局卡 | Infinite Worlds 胜负条件、Character.AI Stories、冒泡鸭 | 一局有完整感 | 已有（结局卡、小传、结局印） | — | — |
| 多周目与继承（下一世带走一样东西） | 人生重开模拟器（继承天赋）、Hidden Door Modifier 卡跨世界 | 想再玩一次 | **不推荐**作为规则；可以只提供“用这一世的小传作为新局的背景”这种可选的文字带入（属于开局定制，玩家自己写也行） | — | — |
| 收集图鉴（人物/地点/物品卡解锁） | Hidden Door 卡组 | 收集欲 | 适合做成**回顾视图**（结识的人、去过的地方），只展示已有数据，不设解锁规则 | S | 无 |
| 开局问答（占位符） | AI Dungeon `${}` 与多选占位符、Project Lunar Setup Wizard | 一个剧本，每人开出不同的局 | **适合**（属于开局定制，不限制剧情）：模板里写“你的出身？①寒门 ②商贾 ③将门 ④自己写”，回答只是填进开局设定 | M | 无 |
| AI 冷开场（每局开场不同） | Project Lunar AI Cold Opens | 重玩也新鲜 | 已有（开场由 AI 写） | — | — |
| 存档位 / 书签 / 回到过去 | 全部 | 不怕玩坏 | 已有（世界线、书签、回合树、回到这里） | — | — |
| 剧本（Scenario）格式与“我的开局” | AI Dungeon Scenario、Character.AI Scenes、Infinite Worlds World、Hidden Door Atlas | 自己设计的局可以反复开、分享给朋友 | **适合**：把“开局设定 + 设定集 + 开局问答”打包成一个文件（不含胜负条件等规则）；功能审查 D5 已有“我的开局管理” | M | 无 |
| 骰子与检定可视化 | Hidden Door、F&F、aisandboxgame d20、ai_rpg | 判定透明 | 已有运势（R11-T008 正在改为“只作参考、可关闭”）；检定透明度见方向 N | — | — |
| Modifier（叠加玩法规则卡，如“不能说谎”“身无分文开局”） | Hidden Door Modifiers | 玩法花样多 | **不推荐**：每张挑战卡都是一条新的内容规则。想要类似效果的玩家可以把要求写进自己的“要求组” | — | — |
| 快进 / 时间跳跃 | 我们的“过些日子”、Project Lunar | — | 已有 | — | — |

### 2.6 社交与分享

| 功能 | 谁有 | 给玩家什么 | 适合我们吗 | 成本 | 依赖 |
|---|---|---|---|---|---|
| 分享图片卡 / 长图 | Hidden Door Moments（贴纸、边框）、星野、人生重开截图 | 炫耀、留念 | 已有（书摘卡三种样式、小传做成图片）；可加“多段拼成长图” | S | 无 |
| 导出小说 | 我们、SillyTavern 导出 | 一局变成一本书 | 已有（导出成小说）；可加 epub | S | 无 |
| 实体书 | 星野【待验证】 | — | 不做 | — | — |
| 剧本/世界分享文件 | Infinite Worlds 分享链接、AI Dungeon 发布、Atlas | 朋友之间互传 | 适合以**文件**方式（不建社区、不上传服务器）：导出剧本文件 → 微信发给朋友 → 导入 | M | 无 |
| 社区剧本库 / Feed / 创作者分成 | Character.AI Feed、AI Dungeon Discover、Hidden Door、星野星工坊 | 内容无限 | 不适合（PLAN_V4 暂不考虑账户与云；个人项目） | — | — |
| 多人联机 | AI Dungeon Multiplayer、F&F、DiceFrame、Agnaistic | 和朋友一起 | 不适合（PLAN_V4 暂不考虑） | — | — |
| 私信 / 关注 / 点赞 | AI Dungeon DM、F&F follows | — | 不适合 | — | — |

### 2.7 定制

| 功能 | 谁有 | 给玩家什么 | 适合我们吗 | 成本 | 依赖 |
|---|---|---|---|---|---|
| 可复用的“要求组”（命名、保存、套用到任一局） | AI Dungeon Reusable AI Instruction Sets（2026-05）、SillyTavern 预设 | 喜欢的写法一键带走 | **很适合**：现在有“每局都附加的要求”和本局要求；加“我的要求组”（如“多写市井”“宫斗节奏”“少写打斗”），开局或游玩中勾选 | S | 无 |
| 采样参数（温度、top_p、最长输出） | SillyTavern、ChatterUI、KoboldAI | 高手调口味 | 部分已有；放在开发者模式或“高级”里，用玩家语言（“更稳/更有想象力”） | S | 无 |
| 自定义请求字段 | ChatterUI 0.10 | 适配各种中转的特殊参数 | 适合放进 AI 服务的“高级”，用于推理强度等 | S | 无 |
| 角色/世界绑定参数（某局用某个服务和模型） | ChatterUI Character Links | 不同的局用不同的模型 | 功能审查 B5“世界记住自己的服务”已列 | S | 无 |
| 脚本（STscript、PawScript、Lua、AI Dungeon Scripts） | 多家 | 作者造机关 | 不适合普通玩家；不做 | — | — |
| 主题 / 自定义 CSS / 背景图 | SillyTavern、ChatterUI（每角色背景图、深浅色分开）、aisandboxgame 主题 | 好看、个性 | 已有三套主题；可加“每局一张背景/纸色”与内置字体（候选池） | S | 无 |
| 快捷回复按钮（自定义常用语） | SillyTavern Quick Reply | 一键发常用行动 | 适合：建议选项旁加“我的常用”（如“查看四周”“问身边人”） | S | 无 |
| 界面语言 | ChatterUI 多语言 | — | 不需要 | — | — |

### 2.8 平台

| 功能 | 谁有 | 给玩家什么 | 适合我们吗 | 成本 | 依赖 |
|---|---|---|---|---|---|
| 后台生成 + 写好通知 | ChatterUI、我们 | 切出去不怕 | 已有 | — | — |
| 屏幕常亮 | ChatterUI Keep Awake | 阅读不熄屏 | 适合，开关一项 | S | 安卓 API |
| 从其他 App 选中文字发过来（分享到/文字选择菜单） | ChatterUI “Ask in ChatterUI” | 看到一段史料直接拿来开局或问“查一查” | 适合但优先级中：安卓 `PROCESS_TEXT` / 分享接收，作为“用这段话开一局”或加进资料库 | M | 安卓原生 |
| 桌面小部件（继续上次的故事、今日运势） | 不少阅读 App | 回访 | 低优先【待评估 Tauri 支持】 | M | 安卓原生 |
| 手机与电脑互传存档 | — | 跨设备 | 已有导出导入；局域网/二维码见方向 E | M | — |
| 离线 | ChatterUI 本地模型 | 没网也能玩 | 不适合（手机跑本地模型质量不够写长篇中文）；但“没网时能读、能整理、能导出”应保证 | — | — |
| 本地模型 / Ollama | ChatterUI、KoboldAI、SillyTavern | 免费 | 已通过 OpenAI 兼容接口支持（Ollama、LM Studio 都提供），可在服务商列表里加说明 | S | 无 |
| 穿戴设备 | — | — | 不做 | — | — |
| PWA / 网页版 | aisandboxgame、F&F | 免安装 | 已评估暂不做 | — | — |

### 2.9 便利与质量

| 功能 | 谁有 | 给玩家什么 | 适合我们吗 | 成本 | 依赖 |
|---|---|---|---|---|---|
| 正文搜索 | 猫箱玩家强烈要求（App Store 评论）、我们 | 找回那一段 | 已有（目录与搜索） | — | — |
| 书签 | 多家 | — | 已有 | — | — |
| 游玩统计 / 活动日历 / 高光 | AI Dungeon Your Story So Far | 回顾、成就感 | 已有行状；可加“全部世界”的总统计与日历（本机数据，不上传） | S | 无 |
| 费用统计、预算提醒 | 我们（用量明细） | 心里有数 | 已有用量；可加“本月预算，超了提醒” | S | 无 |
| 回到底部按钮 | ChatterUI | — | 已有 | — | — |
| 输入框全屏编辑 | ChatterUI 编辑器全屏 | 长段落好写 | 适合 | S | 无 |
| 每日签到 / 连续天数 | AI Dungeon Daily Streaks | 回访 | 不建议（有诱导依赖之嫌，与个人项目调性不符）；可用“今日运势/今日一句史书”替代，不计连续天数 | — | — |
| “最近更新”弹窗 | Character.AI What's New Pop-Up | 知道新功能 | 适合：升级后首次打开显示本版新增（已有更新检查，可补本地更新说明页） | S | 无 |

### 2.10 安全与内容控制

| 功能 | 谁有 | 给玩家什么 | 适合我们吗 | 成本 | 依赖 |
|---|---|---|---|---|---|
| 内容尺度分项（暴力、亲密、黑暗） | Hidden Door（逐项调）、AI Dungeon Content Preferences | 想看什么自己定 | 已有（暴力与伤亡、感情与亲密、黑暗与压抑） | — | — |
| 内容警告标签（剧本上标“死亡”“血腥”等） | Hidden Door 19 种警告、Infinite Worlds | 开局前知道 | **不推荐**：新增内容约束 | — | — |
| 淡出处理（Fade to black） | Hidden Door | 不写细节但剧情继续 | 不另加：现有内容尺度已覆盖 | — | — |
| 屏蔽词 / 不想看到的题材 | AI Dungeon Muted Content | 避开雷点 | **不推荐**：新增内容约束 | — | — |
| 年龄验证、家长锁 | AI Dungeon Parental Lock、Character.AI | — | 不需要（个人自用，自带模型；公开发行前另议） | — | — |
| 防沉迷 / 使用时长提醒 | 国内监管要求（拟人化互动办法） | 健康 | 我们不是“拟人化陪伴”产品，但可选“玩了 N 小时提醒休息” | S | 无 |
| 被模型拒绝时的处理 | 我们（拒绝识别） | — | 已有 | — | — |

---

## 三、我们已经有什么

根据 [变更记录](../../CHANGELOG.md)（到 2026-10-17“V4 第一档”）、最近的提交（书摘卡、小传、行状、印谱、目录与搜索、前情提要、导出小说、电脑快捷键与右键菜单、安装包）和 `src/` 代码检查：

| 主题 | 已有 |
|---|---|
| 回合与写作 | 流式回合；行动/说话/亲手写一段/幕后要求四种输入；重说（可带要求，如写短一点、换个结果、让对方拒绝、多些对话）；续写；上一版/下一版；改写这段文字（手改，可恢复原文）；把这段删改成一句；撤销/重做；出错“再试一次”；建议选项（数量可设） |
| 世界线 | 回到这里重来、世界线管理、书签、回合树、只在这条路线有效/所有路线有效的要点 |
| 记忆 | 故事设定与要点（必须一直记住的事）、记住这件事（长按正文）、设定集（时代卡、人物、地点、势力，关键词与别名触发、AI 自动整理、玩家写的不动）、章节摘要、相关旧事（无模型召回）、人物志与来历、上下文预算与查看器（开发者） |
| 历史特色 | 纪年与货币（可改）、年号/农历/公历、唐天宝示范卡组、不合时代用词提醒、天下大事与历史偏离、过些日子（快进，有事停下）、运势（难度/偏好，R11-T008 正在改）、查一查（本局资料 + 模型知识） |
| 角色面板 | 我（健康、精力、名望、年龄虚岁、伤病与状况、行囊）、人物、目标与心愿、记事、设定集、垂危与结局 |
| 完整感 | 目录与搜索、前情提要、导出小说、书摘卡（册页/手卷/简洁）、这一世小传、行状（统计）、印谱（12 枚印）、结局卡与结局印 |
| 开局 | 随便穿、一句话让 AI 补全、灵感卡（16 个模板），作者模式；用同样设定再开一局 |
| 工具 | AI 服务（自动拉模型列表、写故事与整理记录分开选模型、改名、地址纠错、测试）、设置分组、游玩默认、阅读排版与三套主题、通知、存档与每日备份、恢复、最近删除 30 天、导出导入世界、代理、检查更新、用量明细（价格可填）、游玩指南、电脑宽屏/快捷键/右键菜单/安装包/拖入导入、安卓系统栏与触感 |

**没有的**（与本报告相关）：朗读、任何图片或音频、角色卡/世界书导入导出、开局文件格式、开局问答、可复用的要求组、AI 改写选中段落、代写/润色行动、资料库、屏幕常亮、外部文字分享进来、桌面小部件。（NPC 心思计划、自定义数值、多周目规则、开局挑战等同样没有，但按用户取向**不推荐**补。）

---

## 四、差距清单（50 项，按“价值 ÷ 成本”排序）

价值按“掌控、舒适、AI 上下文、像成品”打分：高/中/低。“免费”= 不需要新的付费服务。第一部分是推荐项；第二部分是同类产品有、但会增加固定剧情机制或内容约束的功能，**不推荐**，列出理由。

### 4.1 推荐

| # | 功能 | 价值 | 成本 | 免费 | 说明 / 依赖 |
|---|---|---|---|---|---|
| 1 | AI 改写选中段落（按要求：扩写、缩写、更古雅、更白话、自定义一句话要求），新旧对照后采用 | 高 | S | ✓ | 长按菜单“改写这段文字”旁加“让 AI 改”；同时能顺手处理模型口头禅 |
| 2 | 代写我的行动 / 润色我的行动（放进输入框，不自动发送） | 高 | S | ✓ | 新手最常卡在“不知道写什么” |
| 3 | 我的要求组（命名、保存、复制；开局或游玩中勾选） | 高 | S | ✓ | 对标 AI Dungeon Reusable Instruction Sets；是玩家自己的要求，不是程序规则 |
| 4 | 系统朗读 + 自动播放 + 语速 + 朗读位置高亮 | 高 | M | ✓ | 安卓原生 TextToSpeech；Windows `speechSynthesis` |
| 5 | 设定集/世界书导入（SillyTavern、Chub JSON）与导出，导入前预览勾选 | 高 | M | ✓ | 设定带得走；给 AI 更好的上下文 |
| 6 | 开局文件导出导入（开局设定 + 设定集 + 开局问答），可发给朋友 | 高 | M | ✓ | 不含规则、不含游玩记录与 Key |
| 7 | 开局问答模板（单选/填空，答案填进开局设定） | 中 | M | ✓ | 只影响开局写什么，不限制之后的剧情 |
| 8 | 角色卡导入（Character Card v2/v3 PNG/JSON）→ 主角或人物志；导出 | 中 | M | ✓ | 吸引酒馆玩家 |
| 9 | 设定集分类折叠、排序、多选删除 | 中 | S | ✓ | 卡多了、导入后更需要 |
| 10 | 输入框全屏编辑 | 中 | S | ✓ | 写长段落 |
| 11 | 我的常用行动（快捷回复，点一下放进输入框） | 中 | S | ✓ | 少打字 |
| 12 | 文风样例（贴一段喜欢的文字，作为本局文风参考） | 中 | S | ✓ | 玩家自己的选择 |
| 13 | 屏幕常亮开关（只在游玩页） | 中 | S | ✓ | 阅读必备 |
| 14 | 本月预算与超支提醒 | 中 | S | ✓ | 用量已有 |
| 15 | 升级后“这一版新增”页 | 中 | S | ✓ | 已有检查更新 |
| 16 | 人物头像上传（本地图片） | 中 | S | ✓ | 人物志、小传、书摘卡用 |
| 17 | 无接口封面（印章 + 朝代纹样 + 标题自动排版） | 中 | S | ✓ | 书架好看 |
| 18 | 多段拼成长图分享 | 中 | S | ✓ | 书摘卡已有绘制 |
| 19 | 回顾视图：结识的人、去过的地方、得到的物件（只展示已有数据） | 中 | S | ✓ | 不设解锁规则 |
| 20 | 资料库：粘贴或导入大段资料（史料、原著梗概、自己的设定），关键词切块检索后放进上下文 | 中 | M | ✓ | 给 AI 更好的上下文；可选 embedding 增强 |
| 21 | “还没了结的事”保留在章节摘要里（只记录，不规定走向） | 中 | M | ✓（评测费用） | 改善长局上下文；需登记评测 |
| 22 | 精简现有提示词与规则（减法），并用评测确认质量不降 | 中 | M | ✓（评测费用） | 直接回应“规则太多” |
| 23 | 采样参数以玩家语言开放（更稳/更有想象力、最长输出） | 低 | S | ✓ | 高级设置 |
| 24 | 自定义请求字段（推理强度等） | 低 | S | ✓ | AI 服务高级 |
| 25 | 每局绑定自己的服务和模型 | 中 | S | ✓ | 功能审查 B5 |
| 26 | 本局“AI 记得多少”的玩家语言小条 | 低 | S | ✓ | 上下文查看器已有数据 |
| 27 | 全部世界的总统计与游玩日历（本机） | 低 | S | ✓ | 行状已有单局 |
| 28 | 导出 epub | 低 | S | ✓ | 导出小说已有 |
| 29 | 插入（）快捷键 | 低 | S | ✓ | 猫箱同款 |
| 30 | 印谱小幅扩充（纪念性质，不影响剧情） | 低 | S | ✓ | 已有 12 枚 |
| 31 | 打字音/翻页音（可选） | 低 | S | ✓ | 内置音效 |
| 32 | 内置背景音乐与环境音（少量 CC0，手动切换为主） | 中 | M | ✓ | 安装包变大；需挑选授权音频 |
| 33 | 去过的地方关系图（按地点卡自动画） | 低 | M | ✓ | 只展示，不做旅行规则 |
| 34 | 安卓“分享到/文字选择菜单”接收文字（开局或放进资料库） | 低 | M | ✓ | 原生 PROCESS_TEXT |
| 35 | 记录“谁在场、谁知道”（人物志里的事实，不加行为规则） | 低～中 | M | ✓ | 上下文类，可选 |
| 36 | 游玩时长提醒休息（可选，默认关） | 低 | S | ✓ | — |
| 37 | 桌面小部件（继续故事） | 低 | M | ✓ | 【待评估 Tauri 安卓】 |
| 38 | 按需配图、画风预设 | 中 | M | ✗ | 图片接口 |
| 39 | 人物肖像生成 | 中 | S（在 #38 之上） | ✗ | 图片接口 |
| 40 | 高品质朗读与角色分声 | 中 | M | ✗ | TTS 接口 |
| 41 | 向量语义召回（相关旧事、资料库增强） | 低～中 | M | ✗ | embedding 接口 |
| 42 | AI 生成封面 | 低 | S（在 #38 之上） | ✗ | 图片接口 |
| 43 | 用一幅画开局 | 低 | M | ✗ | 多模态模型 |

### 4.2 不推荐（会增加固定剧情机制或内容约束）

| # | 功能 | 谁有 | 不推荐的理由 |
|---|---|---|---|
| 44 | 开局挑战 / Modifier 卡 | Hidden Door | 每张卡都是一条新的内容规则；需要的玩家可以写进自己的要求组 |
| 45 | NPC 隐藏目标与秘密计划由程序维护 | Project Lunar、F&F | 预先编排剧情，并多一套要 AI 遵守的规则 |
| 46 | 自定义追踪项 / 新数值系统（修为、好感、官声…） | Infinite Worlds、ai_rpg | 程序记账的固定机制；写进设定集文字由 AI 叙述即可 |
| 47 | 目标自动拆步骤并按节奏推进 | SillyTavern Objective | 编排剧情走向 |
| 48 | 胜负条件、触发事件、剧本机关 | Infinite Worlds、AI Dungeon 脚本 | 固定判定与预设事件 |
| 49 | 多周目继承规则、解锁型图鉴/挑战 | 人生重开、Hidden Door | 新机制；只保留“用小传作为新局背景”这种可选文字带入 |
| 50 | 屏蔽词名单、内容警告标签、淡出写法、反口头禅规则 | AI Dungeon、Hidden Door、SillyTavern 正则 | 新内容约束；现有内容尺度已覆盖，个别句子用 AI 改写处理 |

另外仍**不做**：NPC 定时登场/离场演化新机制、多维关系数值、视频生成、社区与 Feed、多人联机、账户与云同步、抽卡与付费道具、每日连续签到、亲密度解锁、脚本语言、本地手机模型、实体书、界面翻译。

---

## 五、建议的下一批（14 项，不需要新的付费服务）

选择原则：只增加玩家的掌控与舒适、或给 AI 更好的上下文；不加任何剧情机制和内容规则；只用玩家已有的 AI 服务；能在浏览器开发台手机尺寸里试玩验收（朗读需真机）。

| 顺序 | 功能（差距 #） | 为什么先做 | 验收要点（草案） | 成本 |
|---|---|---|---|---|
| 1 | AI 改写选中段落（#1） | 掌控感最直接；一次模型调用 | 长按任意一段 →“让 AI 改”→ 扩写/缩写/更古雅/更白话/写一句要求 → 新旧对照 → 采用或放弃；可恢复原文；不改动状态记录 | S |
| 2 | 代写/润色我的行动（#2） | 减少“不知道写什么” | 输入框“帮我写”：空时按处境拟一句，有内容时改为“润色”；结果放进输入框，不自动发送 | S |
| 3 | 我的要求组（#3） | 喜欢的写法一键带走 | 新建、改名、复制、删除；开局与本局设置里勾选；可设为新局默认 | S |
| 4 | 输入框全屏 + 我的常用行动 + 插入（）（#10、#11、#29） | 手机上写得更舒服 | 输入框可展开全屏；常用行动可增删排序；括号键光标落在括号内 | S |
| 5 | 设定集分类折叠、排序、多选删除（#9） | 卡多后好管理，为导入做准备 | 按人物/地点/势力/物件/时代分组；按名字或最近出现排序；多选删除进最近删除 | S |
| 6 | 屏幕常亮 + 本月预算提醒 + 这一版新增页（#13、#14、#15） | 成熟 App 的小件 | 常亮只在游玩页；预算超过时提醒一次；升级后首次打开显示新增 | S |
| 7 | 人物头像上传 + 无接口封面（#16、#17） | 不花钱也“有脸” | 本机图片压缩入库；封面三套主题下都好看 | S |
| 8 | 长图分享 + 回顾视图（#18、#19） | 留下东西、方便分享 | 选多段拼图；回顾视图只展示已有的人、地、物，空状态有设计 | S |
| 9 | 系统朗读 + 自动播放（#4） | 阅读 App 标配，零费用 | 朗读一段、自动下一段、语速、位置高亮、切后台与来电暂停；没有中文音色时说明去哪装【需真机】 | M |
| 10 | 设定集/世界书导入导出（#5） | 设定带得走，AI 上下文更好 | 识别 SillyTavern/Chub 世界书，映射为设定集卡片（关键词→别名），预览勾选后导入；同格式导出 | M |
| 11 | 开局文件导出导入 + 开局问答（#6、#7） | “我的开局”可保存、可分享、可反复开 | 单文件包含开局设定、设定集、问答；导入后预览再开局；问答一屏一题，答案只填进开局设定 | M |
| 12 | 角色卡导入导出（#8） | 酒馆玩家的角色带得进来 | PNG/JSON 导入为主角或人物志条目，预览可改；导出为卡 | M |
| 13 | 资料库（#20） | 给 AI 更好的上下文（史料、原著梗概、自己的长设定） | 粘贴或导入 txt；按关键词切块，与当前剧情相关的几段进上下文并计入预算；在上下文查看器里看得到 | M |
| 14 | 精简提示词与规则（#22） | 直接回应“规则太多” | 列出现有每条规则及来源，和用户一起删减；跑一次登记过费用的评测，确认记忆与文笔不降 | M |

合计 8 个 S + 6 个 M，单人约 5～7 周。建议先做 1～8（两周内），再做 9～14。#13 的检索可复用现有 `match`；#14 需要登记真实模型评测费用并先和用户确认删哪些规则。

---

## 六、后续批次：需要额外接口的功能，以及怎样做成可选

原则：**不接也能完整地玩**；接了只是“更好看/更好听/记得更准”。所有额外接口都放在“AI 服务”里作为可选用途，和“写故事”“整理记录”并列，沿用现有服务管理（自动拉模型列表、测试、价格、用量）。

| 功能 | 接口 | 可选化方案 | 费用控制 |
|---|---|---|---|
| 按需配图、人物肖像、AI 封面（#38、#39、#42） | OpenAI 兼容 `/v1/images/generations`；或服务商原生接口 | 没配“画图”服务时按钮不出现；只在点按时生成，绝不自动；生成前显示预估价格；图片存本地库，导出时可选是否带图；画风由玩家选（工笔、水墨、写实…） | 计入用量与本月预算；失败不自动重试 |
| 高品质朗读与角色分声（#40） | OpenAI 兼容 `/v1/audio/speech`；自部署 GPT-SoVITS 等 | 默认系统朗读；配了“朗读”服务后可切换并按人物分配音色 | 显示预估；缓存已读音频 |
| 向量语义召回、资料库增强（#41） | OpenAI 兼容 `/v1/embeddings` | 默认关键词匹配；配了后作为第二路召回合并 | 只在入库时计算一次 |
| 用一幅画开局（#43） | 支持图片输入的模型 | 模型不支持时提示换模型 | 单次调用 |

顺序：配图 → 高品质朗读 → 向量召回（我们无模型的相关旧事召回已达 94%，收益最小）。上线前按 AGENTS.md 第 5 节登记评测与费用上限。

---

## 七、对方向 M（异世界模式）与方向 N（历史机制）的提示

- 按用户取向，两份专题调研也应**优先少规则**：异世界模式靠开局问答、开局文件、设定集（含导入的世界书）和资料库就能支撑各种题材，修为、等级等写成设定文字由 AI 叙述，不做程序记账。
- 本报告目录中标为“不推荐”的机制类功能（追踪项、NPC 计划、多周目规则、挑战卡、胜负条件），如果方向 N 的调研认为某一项非常有价值，应作为**默认关闭、可在设置里打开**的选项单独请用户决定，而不是默认加入。
- 现有机制（运势、用词提醒等）按台账 R11-T008 的方向逐项可开关，并考虑借 #22 做减法。

---

## 八、待验证与已知局限

- 朗读：小米手机系统 TTS 的中文音色质量、离线可用性、后台朗读是否被系统杀掉【需真机】；Tauri 安卓插件的成熟度（参考插件只有 10 星）【待验证】。
- 角色卡与世界书格式：SillyTavern、Chub、RisuAI 各版本字段差异较大，需要找真实样本测试；chara_card_v3 的 `.charx` 是压缩包格式【待验证】。
- 图片接口：各中转服务对 `/images/generations` 的支持程度、价格差异很大【待验证】，上线前按 [服务与模型管理](UX_PROVIDERS.md) 的方法逐家核对。
- Dreamjourney、Talefy、Talkie 的功能多来自营销页或第三方评测；星野“实体书”、Talkie“声音克隆”未在官方渠道确认。
- 本次没有登录任何产品实际试玩，也没有拿到 Reddit 原帖；国内产品的功能描述多来自媒体与产品库，可能已随版本变化。
- 开源项目星数为 2026-10-17 搜索结果中的数字，会变化。

---

## 来源（查阅日期均为 2026-10-17）

**SillyTavern 与开源前端**
- [SillyTavern 扩展列表](https://docs.sillytavern.app/extensions/) · [生图](https://docs.sillytavern.app/extensions/stable-diffusion/) · [TTS](https://docs.sillytavern.app/extensions/tts/) · [聊天向量化](https://docs.sillytavern.app/extensions/chat-vectorization/) · [Data Bank](https://docs.sillytavern.app/usage/core-concepts/data-bank/) · [STscript](https://docs.sillytavern.app/usage/st-script/) · [Objective](https://docs.sillytavern.app/extensions/objective/) · [Dynamic Audio](https://docs.sillytavern.app/extensions/dynamic-audio/) · [Guided Generations](https://github.com/Samueras/GuidedGenerations-Extension)
- [RisuAI 文档](https://kwaroran.github.io/docs/) · [RisuAI 仓库](https://github.com/kwaroran/RisuAI) · [RisuAI 世界书（DeepWiki）](https://deepwiki.com/kwaroran/RisuAI/5.4-lorebook-system)
- [Agnaistic FAQ](https://edge-api.agnai.chat/faq) · [Agnaistic 建角色](https://agnai.guide/docs/creating-a-character/) · [Agnaistic 仓库](https://github.com/agnaistic/agnai)
- [KoboldAI Lite](https://lite.koboldai.net/) · [KoboldCpp Lite 文档](https://koboldcpp.net/docs/features/lite/)
- [ChatterUI 仓库](https://github.com/Vali-98/ChatterUI) · [ChatterUI Releases](https://github.com/Vali-98/ChatterUI/releases)

**商业产品**
- [AI Dungeon What's New](https://play.aidungeon.com/whats-new) · [AI Dungeon Alchemy](https://aidungeon.com/alchemy) · [Story Card 生成器](https://play.aidungeon.com/whats-new/feature/announcement%3Aaid-story-card-generator-rework) · [AI Dungeon 记忆系统](https://help.aidungeon.com/faq/the-memory-system) · [Latitude 新闻](https://latitude.io/news)
- [Character.AI 新创作功能（2025-06）](https://blog.character.ai/character-ai-unveils-new-ways-to-create/) · [Scenes](https://blog.character.ai/introducing-scenes-your-new-way-to-tell-stories-on-c-ai/) · [Stories](https://blog.character.ai/introducing-stories-a-new-way-to-create-play-and-share-adventures-with-your-favorite-characters/) · [Memory（2026-05）](https://blog.character.ai/memory/) · [Chat memories（2025-05）](https://blog.character.ai/helping-characters-remember-what-matters-most/) · [2025-09 社区更新](https://support.character.ai/hc/en-us/articles/41760067000475-Community-Update-September-2025) · [2025-04 社区更新](https://support.character.ai/hc/en-us/articles/36429196456475-Community-Update-April-2025) · [TechCrunch：AvatarFX](https://techcrunch.com/2025/06/02/chatbot-platform-character-ai-unveils-video-generation-social-feeds/) · [TechRadar：Stories 试玩](https://www.techradar.com/ai-platforms-assistants/character-ai-launches-stories-to-keep-teens-engaged-as-it-scales-back-open-ended-chat-for-under-18s)
- [Talkie+ 说明](https://aicompanionradar.com/articles/talkie-plus-explained)
- [Chub Lorebooks](https://docs.chub.ai/docs/advanced-setups/lorebooks) · [Janitor AI 记忆](https://help.janitorai.com/en/article/chat-memory-context-management-9oivt3/)
- [Infinite Worlds 世界编辑](https://infiniteworlds.mywikis.wiki/wiki/World_editing) · [Tracked Items](https://infiniteworlds.mywikis.wiki/wiki/Items_to_track) · [World JSON](https://infiniteworlds.mywikis.wiki/wiki/World_JSON_format) · [工作方式](https://infiniteworlds.mywikis.wiki/wiki/How_Infinite_Worlds_works) · [PawScript](https://infiniteworlds.mywikis.wiki/wiki/PawScript) · [Specialist Instructions](https://infiniteworlds.mywikis.wiki/wiki/Specialist_Instructions)
- [Friends & Fables](https://fables.gg/) · [F&F Patch Notes](https://fables.gg/patch-notes)
- [AI Roguelite（Steam）](https://store.steampowered.com/app/1889620/AI_Roguelite/) · [AI Roguelite 公告](https://steamcommunity.com/app/1889620/announcements/)
- [Hidden Door FAQ](https://www.hiddendoor.co/help/faq) · [Atlas](https://www.hiddendoor.co/blog/atlas-worldbuilding-interactive-world-builder-storytelling-rpg) · [2026 新年回顾](https://www.hiddendoor.co/blog/new-year-goodbye-2025-hello-2026) · [快慢两条线](https://www.hiddendoor.co/blog/fast-slow-architecture-latency-turn-based-narrative) · [2026-06 更新](https://www.linkedin.com/posts/hiddendoor_howdy-its-the-update-report-for-june-2-activity-7467602385763221505-cN6d) · [2026-03 更新](https://www.linkedin.com/posts/hiddendoor_its-the-update-report-for-march-31-2026-activity-7444791619612016640--B2_)
- [Dreamjourney Memory Nexus](https://dreamjourneyai.com/blog/ai-that-remembers-memory-nexus) · [Dreamjourney Storytelling](https://dreamjourneyai.com/ai-storytelling)
- [Talefy 评测（DreamGen）](https://dreamgen.com/blog/articles/talefy-ai-review) · [Talefy Google Play](https://play.google.com/store/apps/details?id=com.talefyaiapp&hl=en)

**中文产品与行业**
- [猫箱产品库介绍](https://aiproducthub.cn/sites/bytedance-maoxiang-ai-emotional-companion.html) · [猫箱 App Store](https://apps.apple.com/cn/app/id6475000292) · [猫箱模式记忆不互通（微博）](https://www.sina.cn/news/detail/5310913959693946.html) · [动点科技：猫箱](https://cn.technode.com/post/2025-08-29/maoxiang-ai-app-whats-going-on/)
- [筑梦岛介绍](https://9200.cn/tools/2273) · [Foreverse 横评](https://foreverse.cn/zh/ai-roleplay-apps) · [FlowPix 横评](https://www.flowpixai.com/ai-tools/ai-companion-app-comparison.html)
- [造梦次元（36氪/新浪）](https://finance.sina.cn/stock/jdts/2026-01-19/detail-inhhvsfx9800273.d.html?vt=4) · [冒泡鸭停运（腾讯新闻）](https://news.qq.com/rain/a/20250604A02RM500) · [冒泡鸭超长记忆](https://m.aitntnews.com/newDetail.html?newId=6509) · [AI 社交关停潮（钛媒体）](https://www.tmtpost.com/7718052.html) · [星野主动来电（钛媒体）](https://www.tmtpost.com/7823036.html) · [AI 陪伴付费四笔账（什么值得买）](https://post.smzdm.com/p/a8256lzq/) · [豆包千问下线智能体](https://www.163264.com/14078) · [十款 AI 伴侣评测（搜狐）](https://www.sohu.com/a/1027917538_121124868) · [五款情感陪伴（腾讯云）](https://cloud.tencent.com/developer/news/1809875)

**开源引擎**
- [waidrin](https://github.com/p-e-w/waidrin) · [ai_rpg](https://github.com/envy-ai/ai_rpg) · [project-lunar](https://github.com/horizonfps/project-lunar) · [aisandboxgame](https://github.com/hayowei/aisandboxgame) · [DiceFrame](https://github.com/diceframe/diceframe) · [OpenStory 万象谱](https://github.com/ZJU-LLMs/OpenStory) · [Dungeo_ai](https://github.com/Laszlobeer/Dungeo_ai) · [YIKES](https://github.com/psema4/yikes/)

**平台能力**
- [Android TextToSpeech](https://developer.android.com/reference/android/speech/tts/TextToSpeech) · [Can I WebView: SpeechSynthesis](https://caniwebview.com/features/mdn-speechsynthesis/) · [Chromium：WebView 不支持 Web Speech](https://issues.chromium.org/40417848) · [tauri-plugin-tts](https://github.com/httpjamesm/tauri-plugin-tts/)
