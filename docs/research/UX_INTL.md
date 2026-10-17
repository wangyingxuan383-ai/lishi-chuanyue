# 海外 AI 故事产品的界面与交互细节调研

> 调研日期：2026-10-17（Asia/Shanghai），由调研子代理完成。本文所有来源的查阅日期均为 2026-10-17，下文不再逐条重复。
>
> 本文接着 [海外调研](COMPETITORS_INTL.md) 往下挖。那份报告讲清了“基本循环”和记忆机制，这份只看**玩家手指碰得到的东西**：屏幕怎么排、按钮在哪、怎么切换、出错时说什么、什么让人觉得“做完了”。已经写过的内容（AI Dungeon 的 Erase 与 Undo 分开、SillyTavern 的分支与检查点、C.AI 的固定记忆等）只在需要对照时一笔带过。
>
> 来源说明：官方帮助中心、更新日志、官方博客优先；第三方评测站（Arcanum RPGs、RoboRhythms、DreamGen 等）不是官方来源，标为“第三方”；拿不到原文或只有营销页的，标【待验证】。Reddit 原帖大多拿不到，只拿到了转载页和情绪汇总页。

## 结论先说

1. **成熟产品的“精细度”主要来自三类小事**：生成过程中的状态反馈（能不能边写边改、按钮多久恢复、要不要自动滚动）、每个操作的“后悔药”（撤销、回到这里、重说时能写方向），以及阅读排版（行宽、行距、段距、首行缩进、字号可调）。AI Dungeon 2026 年的几十个补丁，大部分就是这类小事。
2. **“功能感”主要来自让一局游戏有形状**：章节与目标完成提示（Hidden Door）、可以回看的足迹（Sorcery! 的地图、Reigns 的历代君主时间线）、结局与成就（Choice of Games）、“你的故事到目前为止”统计页（AI Dungeon 2026-08）、可以分享的精彩片段（NovelAI 截图设计器、Hidden Door 分享时刻）。我们的游戏里状态很完整，但**一局游戏缺少“段落感”和“回顾感”**。
3. **记忆界面的方向已经统一**：“自动抓取 + 每次抓取有提示 + 玩家可改可锁可撤销 + 容量条”。Character.AI（2026-04/05）、Dreamjourney（Memory Nexus 的“变更小圆点”）、Friends & Fables（Working Context 抽屉）都是这个思路。
4. **最常被骂的不是 AI 写得差，而是界面让人丢东西**：C.AI 的 Rewind 一下跳回第一条且不能撤销、Talefy 提交后不能改只能重开、Chai 误点“删除全部聊天”、AI Dungeon 用户误按 redo 毁掉几小时进度。我们“任何操作不丢内容”的原则是对的，要继续守住，并在界面上让玩家**看得见**这一点。

---

## 1. 逐个产品

### 1.1 AI Dungeon（Latitude，2026 年仍在高频更新）

AI Dungeon 是这份调研里细节最多的样本：它几乎每周发补丁，补丁说明直接暴露了“成熟产品在磨什么”。下面按五个维度整理，重点是 2026 年的新变化。

**主界面与控制**
- 左上角火焰图标打开菜单；右上角齿轮打开游戏内设置，分“冒险”（剧情组件、故事卡、详情）和“玩法”（AI 模型、外观）两组。来源：[How to play](https://help.aidungeon.com/faq/how-to-play)、[系统设置说明](https://help.aidungeon.com/understanding-settings)
- 底部四个主按钮：Take a Turn、Continue、Retry、Erase；AI 输出用高亮与玩家文字区分（第三方截图描述）。来源：[Arcanum AI Dungeon 评测](https://arcanumrpgs.com/blog/ai-dungeon-review/)
- 外观设置在“玩法”最上方：主题与无障碍、关闭新输出的文字动画、更大的文字与界面、回合结束后保持输入框打开、只显示图标的紧凑按钮。来源：[How to play](https://help.aidungeon.com/faq/how-to-play)
- **“跟随最新文字”开关**（2026-08-24）：关闭时生成中保持在本段开头，方便从头读；打开时自动滚到底。来源：[What's New](https://play.aidungeon.com/whats-new)
- “续写另起一段”开关（2026-08-24）：所有 Continue 从新段落开始。来源：同上
- 去掉了游玩界面顶部的渐隐遮罩，“阅读更不受遮挡”（2026-03-30）。来源：同上
- “回到光标处”按钮从屏幕中间移到左侧（2026-05-11），理由是“在中间很别扭”。来源：同上
- 生成结束后按钮恢复快了约 0.85 秒（2026-09-21）。来源：同上

**输入**
- 点 Take a Turn 后在同一个切换器里选 Do / Say / Story / See；2026-08-12 新增 **Guide（引导）**：写下想要的结果，AI 照此续写一段，但引导语不作为玩家行动进入故事，只在“查看上下文”里可见。来源：[What's New](https://play.aidungeon.com/whats-new)
- **重说时可以写方向**（2026-08-03）：Retry 旁边的铅笔图标，写“要改什么”再重说。来源：同上
- 移动端键盘处理在 2026 年重做了两次（2026-02-26 安卓、2026-07-06 全平台）：不再遮住输入框、不再出现大块空白、不再锁住滚动、控件不再乱跳。来源：同上

**对故事的控制**
- 点任意段落直接改，点空白处保存；双击某段“擦到这里”。来源：[How to play](https://help.aidungeon.com/faq/how-to-play)
- **生成过程中也能开始编辑**（2026-09-21）：正在被 Retry 替换的那段除外；未保存的修改有浮动的“检查 / 放弃”按钮；出错时草稿保留。来源：[What's New](https://play.aidungeon.com/whats-new)
- 安卓与手机网页上拖动选字手柄时编辑框不再跳动；iOS 要求明确的竖向拖动才触发整体拖动，防止选字时误拖（2026-03、2026-04）。来源：同上
- 玩家抱怨：有人以为 redo 是退出编辑框的唯一办法，按下后“毁掉了几小时的进度和故事”，后来才知道点顶部空白处就能保存。来源：[App Store 评论](https://apps.apple.com/us/app/ai-dungeon-rpg-story-maker/id1491268416?platform=iphone&see-all=reviews)（玩家 Dragonborn1355）

**记忆与设定**
- 记忆系统在“玩法 → AI 模型 → 记忆系统”里开关，开一次对所有冒险生效；Story Summary 作为剧情组件出现，可手改，玩家的修改会交给摘要模型吸收。来源：[Memory System](https://help.aidungeon.com/faq/the-memory-system)
- 上下文查看器：长按最后一段选“View Context”；“Explore Memories”有“时间线 / 相关度”两个标签，显示“已使用 / 已存储 / 已遗忘”的记忆。来源：同上、[管理上下文](https://help.aidungeon.com/how-do-i-manage-context)
- 故事卡（Story Cards）2026 年的整理功能：可折叠分类、按字母排序、全部展开 / 收起、批量删除、置顶卡（有独立分区和标记，在上下文详情里显示“已纳入”或“放不下”）、手机网页上编辑卡片改为全屏弹层并保留滚动位置。来源：[What's New](https://play.aidungeon.com/whats-new)、[Story Cards](https://help.aidungeon.com/faq/story-cards)
- 故事卡编辑器有“快速创建”模式：完成按钮变成“下一张”，保存后直接开一张同类型的空卡。来源：[Story Cards](https://help.aidungeon.com/faq/story-cards)

**开局、完整感与打磨**
- 剧本占位符可在多选开局里使用，子剧本复用父剧本的答案；简易开局里加入性别选择，代词自动按性别替换。来源：[What's New](https://play.aidungeon.com/whats-new)
- 新玩家的推荐页会把“已验证适合新手”的冒险排在前面（2026-08-03）。来源：同上
- **朗读**（2026-08-20）：免费使用系统语音，另有付费的两档更好听的声音；可选声音、语速、自动朗读。来源：同上
- **“你的故事到目前为止”**（2026-08-16）：私人统计页，含活动日历、高光、最活跃时段、最长冒险的链接。具体版式【待验证】。来源：同上
- 每日连续打卡与徽章（3、7、14、30、60、100 天）。来源：同上
- 冒险可导出为 zip；改进过导出的文件名和加载反馈。来源：[系统设置说明](https://help.aidungeon.com/understanding-settings)、[What's New](https://play.aidungeon.com/whats-new)
- 原生分享面板分享内容链接（2026-03）；连接错误页直接链接到服务状态页和社交频道（2026-03）。来源：[What's New](https://play.aidungeon.com/whats-new)
- 冒险里可生成封面，先显示整批价格再生成（2026-09）。来源：同上
- 列表页返回时恢复到原来的滚动位置（2026-06、2026-07）。来源：同上

**玩家抱怨**：界面 bug 多，“重启就好但很烦”；记忆差、细节前后矛盾，需要玩家回头改；自动保存用旧版本覆盖新编辑。来源：[App Store 评论](https://apps.apple.com/us/app/ai-dungeon-rpg-story-maker/id1491268416?platform=iphone&see-all=reviews)、[r/AIDungeon 帖子转载](https://enmlounge.com/sub/AIDungeon/t3-1oy1z0k-ai-dungeon-production-level-interface-seems-forever-b)（第三方转载）

### 1.2 NovelAI

NovelAI 是“写作器”形态，不是聊天形态，但它的阅读与来源标识很值得抄。

- **按来源上色**：开场提示为奶油色，AI 生成为白色，玩家改过的 AI 文字为粉色，玩家亲手写的为蓝色；颜色可在主题里改。来源：[Editor](https://docs.novelai.net/en/text/editor/)
- **编辑历史是分支时间线**：撤销、重做在时间线上前后走；History 按钮上显示“当前位置有几个生成版本”，点开选择从哪个继续。来源：同上
- **在中间生成**：点到前文任意位置，菜单选“Generate Inline”，从那里而不是从结尾续写。来源：同上
- **右键（触屏为长按）菜单**：把选中文字加进 Lorebook、用它生成设定、截图、朗读。来源：同上
- **截图设计器**：选中一段精彩文字，生成适合分享的图片。来源：同上
- **阅读设置非常细**：界面字号 10–24px、正文字号 10–30px、行距、段首缩进、段距、按钮缩放、最大行宽、对白高亮（引号内斜体或反过来）、显示小贴士、编辑工具条。来源：[Interface Settings](https://docs.novelai.net/en/text/usersettings/interface/)
- 触屏手势：从屏幕边缘滑出书库和设置侧栏，可关闭。来源：同上
- 标题生成：一键生成故事标题，保留最近 50 个可回选。来源：[Editor](https://docs.novelai.net/en/text/editor/)
- Hypebot：一个小吉祥物偶尔点评你的故事、给推进建议，频率可调，也可只在点它时才说话。来源：同上
- Lorebook 有搜索、排序（字母或最近）、多选批量导出删除、按分类管理、启用开关、“始终启用”。来源：[Lorebook](https://docs.novelai.net/en/text/lorebook/)
- 玩家抱怨：设置太多，新手困惑（第三方汇总）。来源：[bex.co 负面反馈汇总](https://bex.co/blog/2025/04/17/negative-feedback-on-llm-powered-storytelling-and-roleplay-apps)

### 1.3 SillyTavern 与手机前端 ChatterUI

SillyTavern 是控制最细的样本，适合挑“小开关”；ChatterUI 是它在安卓上的原生对应物，适合看手机上怎么收纳。

- **每条消息上的按钮**：Swipe（另生成一版）、Edit，以及“⋯”里的翻译、生成图片、朗读、查看提示词、隐藏（AI 看不见但保留）、检查点、分支、复制。来源：[Chatting](https://docs.sillytavern.app/usage/chatting/)
- **全局动作放在输入栏左侧的选项按钮**：Continue、Regenerate、Impersonate（AI 替你写一句，你再改）、作者注、开新聊天、批量删除。来源：同上
- 设置里的小开关（都值得借鉴）：流式“平滑输出”及速度、流式淡入、**生成结束提示音（可设为只在后台时响）**、刷新后恢复未发送的输入、快捷“继续”按钮、手机上的滑动手势、自动滚动、编辑自动保存、删除前确认、自动重说（太短或出现黑名单词时自动重来）、自动续写到目标长度。来源：[User Settings](https://docs.sillytavern.app/usage/user-settings/)
- 视觉小说模式：用立绘代替头像的版式。来源：[Visual Novel Mode](https://docs.sillytavern.app/usage/user-settings/visual-novel/)
- ChatterUI（安卓原生）：上滑一段后出现“跳到末尾”按钮；发送后收起键盘；从某处“分叉”克隆聊天；聊天列表显示最近一句和日期，可按最近 / 字母排序、可搜索；编辑类下拉改为长按打开；底部弹层有退出动画；消息增删改时布局有动画；“保持屏幕常亮”；通知在手动回到应用时自动消失；正文字号和字重可调；深浅主题分别设置。来源：[ChatterUI 发布记录](https://github.com/Vali-98/ChatterUI/releases)

### 1.4 Character.AI

C.AI 是手机聊天形态的标杆，也是“改版翻车”的反面教材。

- **聊天界面**：顶部头像与名字，中间消息流，底部输入框与相机图标；每条消息一排小图标：编辑、重说、回到这里、星级评分。第三方指出“多数新手一两天后才发现这些图标”。来源：[ourdream 新手指南](https://ourdream.ai/guides/how-to-use-character-ai)（第三方）
- **长按消息**打开菜单（手机）：固定、编辑等。来源：[Pinned Memories](https://support.character.ai/hc/en-us/articles/24327914463003-Pinned-Memories)
- **记忆页**（2026-05-21）：聊天顶栏的笔记本图标打开。分三块：Story Memory（玩家写的背景和长按固定的消息，压缩时永不丢）、Facts（自动抓取外貌、癖好、关系等，分“我 / 角色 / 配角”标签，可改、可停用、可删；开新聊天时可选择把 Facts 带过去）、Memory Usage（容量条，快满时提醒，后台整理旧内容）。来源：[Smarter Memory](https://blog.character.ai/memory/)
- **每记下一条记忆，聊天里出现一条提示**，“让你知道系统在听”（2026-04-14）。来源：[April Update](https://blog.character.ai/pipsqueak2-and-more/)
- **多个开场白可左右滑动挑选**：创作者最多加 5 个额外开场，玩家开聊前滑动浏览，挑自己想要的情境。官方写作指南强调开场要“把玩家丢进一个时刻而不是一段简介”“以一个可回应的东西结尾”。来源：[Greeting and Voice](https://support.character.ai/hc/en-us/articles/50609011294235-4-Greeting-and-Voice-%EF%BC%90-%E3%83%8E)
- 角色打字时的**触感反馈**（实验功能，可在设置里关）；“从这里开新聊天”（原“复制聊天”）。来源：[2025-02 社区更新](https://support.character.ai/hc/en-us/articles/34428285052827-Community-Update-February-2025)（帮助中心原页面返回 403，内容取自搜索结果摘录，【待验证】）
- **改版翻车**（第三方，2026）：网页版改成手机版样式后，人设头像从消息流里消失（最多人抱怨，伤代入感）；Rewind 常常直接跳回第一条并删掉之后全部内容、不能撤销；滑动换版本改成“笨拙的按钮”；回车在不同设备上一会儿发送一会儿换行；读屏软件遇到无标签按钮；恢复旧界面的开关只给付费用户。来源：[RoboRhythms 新界面](https://www.roborhythms.com/character-ai-new-ui/)
- **功能被砍**（第三方，2026-03）：免费用户的“回放 / 分支”被直接移除，“没有替代界面也没有说明”；重说次数被压缩，“继续”也算进重说次数；消息之间插广告。来源：[RoboRhythms 移除滑动与回放](https://www.roborhythms.com/character-ai-removed-swipes-playbacks/)

### 1.5 Talkie 与 Chai（手机陪伴类）

这两个产品的故事能力弱，但手机上的“留存小把戏”和翻车点有参考价值。

- **Talkie**：只有 iOS 和安卓版；聊天可解锁“卡牌”（同一角色的不同画面，6 张一包，每天一次免费抽，可设为聊天背景、可交易）；语音通话是付费功能，每次 10 分钟；免费版有广告。来源：[AI Haven 评测](https://aihaven.com/aitools/talkie/)、[RoboRhythms 评测](https://www.roborhythms.com/talkie-ai-review/)（均为第三方）
- **Chai**（2026-04）：在聊天底部加了左右两个箭头，可以回到之前的回复版本继续；玩家很高兴（“重说失败也能回去了”），但嫌样子笨，常把“重说”按钮当成“编辑”按钮误点。玩家还想要：一次删多条、人设、复制聊天。来源：[PiunikaWeb](https://piunikaweb.com/2026/04/14/chai-introduces-option-to-go-back-to-previous-responses/)
- Chai 社区的高赞抱怨：误点“删除全部聊天”丢掉所有故事；旧聊天莫名消失只剩开场白；消息额度不透明。来源：[r/ChaiApp 快照](https://reddit.sentinel-team.org/subreddits/ChaiApp/snapshots/2026-04-18T00%3A54%3A18.2235Z)（第三方汇总页）

### 1.6 Hidden Door

Hidden Door 是“一局有形状”的代表：故事由场景组成，有卡牌、有目标、有结局。

- **一局的长度**：一个场景 5–8 分钟，一个故事 1–3 个场景；每个故事都有结局；在一个世界里集齐所有卡至少要 6–8 个故事。来源：[Hidden Door FAQ](https://www.hiddendoor.co/help/faq)
- **桌面与故事两个空间**：故事模式里以第一人称玩；回到“桌面”时世界显示为一副牌，选下一局带哪些人物、物品、地点。来源：同上
- **卡牌是回顾工具**：游玩中收集人物、地点卡，“可以翻回去当作关键情节的提醒”；叙事者手里还有一副情节卡，偶尔让你挑一张决定走向。来源：[The Verge](https://www.theverge.com/games/757816/hidden-door-early-access-ai-story)
- 人物卡写短描述与特质（如“稻草做的人，怕火”），并显示人物关系（友善 → 对手）。来源：[Ian Bicking 评测](https://ianbicking.org/blog/2025/08/hidden-door-design-review-llm-driven-game)
- 每段结尾给几个建议行动；也能自己写，但自写内容会被改写成合规版本再交还给你（“把不合适的翻译成 PG-13 再给你”）。来源：同上、[FAQ](https://www.hiddendoor.co/help/faq)
- 目标出现与完成都有提示（如“选择方向：成功！”）；章节开头选故事方向。来源：[Ian Bicking 评测](https://ianbicking.org/blog/2025/08/hidden-door-design-review-llm-driven-game)
- 难的行动在幕后掷骰，失败显示“你失败了”。来源：[The Verge](https://www.theverge.com/games/757816/hidden-door-early-access-ai-story)
- 美术全部由画师手绘，“少量高质量的美术比大量失控的生成图更好”。来源：[FAQ](https://www.hiddendoor.co/help/faq)
- 定位是社交：鼓励把喜欢的时刻分享到群聊。来源：同上、[官网](https://www.hiddendoor.co/)
- 抱怨：等待叙事者“思考”常要好几秒，评测者等的时候会切走；几乎每次都成功；能感到幕后有线在拽；有时把一大段人物介绍原样贴进正文。来源：[The Verge](https://www.theverge.com/games/757816/hidden-door-early-access-ai-story)、[Ian Bicking 评测](https://ianbicking.org/blog/2025/08/hidden-door-design-review-llm-driven-game)

### 1.7 Friends & Fables（Franz）

- **工作上下文抽屉**：输入框正上方一个抽屉，三个标签：上下文块（指令 / 记忆 / 实体 / 设定 / 其他，每块可设“几回合后过期”，可拖动排优先级，状态分“使用中 / 待命 / 已归档”，底部链接到来源）、剧情与计划（每回合更新，玩家可改）、场景上下文（你在哪、附近有谁）。玩家纠正 Franz 时会自动生成一条“指令块”记住。来源：[Franz 2.0 更新](https://fables.gg/patch-notes/franz-20-working-context-lore-improved-planning-and-more)
- **研究步骤可见**：显示 Franz 这回合查了哪些主题、建了哪些块、来源是哪条设定或记忆。来源：同上
- **小地图**：游玩时有随位置自动更新的小地图，可缩放平移；有测距工具，显示两点距离和预计路程时间；计划中“未去过的地点隐藏”“显示走过的路线”。来源：[MAPS 更新](https://fables.gg/patch-notes/maps)
- 游玩中遇到的有名字的 NPC 自动进入人物表，带外貌和性格，可编辑。来源：[创建角色帮助](https://help.fables.gg/articles/4931727-creating-a-character)
- 攻击可以用嘴说（Franz 识别武器与目标后让你确认，确认前可改），也可以点交叉剑图标打开攻击面板；掷骰可切换为“自己扔实体骰子再输入点数”。来源：[战斗帮助](https://help.fables.gg/articles/9942035-how-our-combat-system-works-attacks-and-turns)、[Combat V4](https://fables.gg/patch-notes/combat-v4)
- 有朗读（叙事者为角色配不同声音）、语音输入、PWA 与通知、多人（最多 6 人）。来源：[官网](https://fables.gg/)、[更新日志](https://fables.gg/patch-notes)
- 抱怨：小错会滚雪球，几次连错后整局玩不下去；价格高（第三方）。来源：[Arcanum F&F 评测](https://arcanumrpgs.com/blog/friends-and-fables-review/)

### 1.8 Voyage（Latitude）

上一份报告已写过机制，这里补体验层面。

- 手机优先，“为通勤、休息这种短时间游玩设计”；没有战棋网格，除场景图外不加视觉层，“视觉复杂度在手机上只会消耗注意力”（第三方）。来源：[Arcanum Voyage 评测](https://arcanumrpgs.com/blog/voyage-review/)
- 可选“视觉小说模式”，战斗时在人物立绘上显示冲击、伤害与血量变化（第三方，【待验证】）。来源：[Arcanum Voyage 指南](https://arcanumrpgs.com/blog/voyage-guide/)
- 开局三步：选世界（建议先选现成的）→ 生成角色（生成前可改背景，可存起来用于别的世界）→ 选 GM 性格（从“温和宽容”到“硬核残酷”）。来源：同上
- 角色死了就是死了，新角色在同一世界继承前任造成的后果。来源：[Arcanum Voyage 评测](https://arcanumrpgs.com/blog/voyage-review/)
- 抱怨：叙述者把你的台词润色成“不完全是你的话”，还会替你做小动作；你没告诉 GM 你在撒谎时，它可能把谎话当真话说出来。来源：同上
- 具体屏幕布局、骰子显示方式没有找到可靠描述【待验证】。

### 1.9 Infinite Worlds

- 布局：顶部是游戏名、主角名和当前回合数；左边故事，右边图片。来源：[Game interface](https://infiniteworlds.mywikis.wiki/wiki/Game_interface)（社区维基）
- 故事区从上到下：上回合玩家行动 → 正文 → 角色按钮 → “追踪项”按钮（**有变化的追踪项变黄**）→ 建议行动 → 自由输入框 → 提交 → 上一回合 → 重新生成。来源：同上
- **点建议行动会覆盖输入框里已有的文字**，维基专门提醒“小心”。来源：同上
- 重新生成会弹窗让你改提示，并提醒与新回合同价。来源：同上
- 回到上一回合后可以跳到任意回合号，但从旧回合载入会丢掉之后全部进度。来源：同上
- “说书人模式”是给作者的后台：显示隐藏追踪项、隐藏信息、整回合编辑、指定下一回合会发生什么（可用于跳时间）。来源：同上
- 角色卡显示技能等级 1–5 与文字说明，以及“这张头像是第几回合生成的”。来源：同上

### 1.10 AI Roguelite

- **状态变化动画**（2026-06）：血条和各状态条变化时有动画，“一眼看出这回合涨了还是跌了、变了多少”；受伤、治疗、升级等有特效。来源：[Visual Enhancements](https://gamehypes.com/news/visual-enhancements-bug-fixes)
- **掷骰透明**：鼠标悬停骰子图标看这次结果怎么来的；悬停属性数值看“掷到多少算成功”的分界。来源：[Roll Check Transparency](https://gamehypes.com/news/play-in-your-language-of-choice-roll-check-transparency-and-more)
- 七档结果（大成功到大失败）；合理性评估：物理上是否可能、成功可能性、所用物品是否相关，各自变成加减值。来源：[Plausibility V2](https://gamehypes.com/news/plausibility-v2)
- “快捷行动”按钮：弹出三个选项，可设置其中一个是搞笑选项的概率。来源：[Encounters 更新](https://gamehypes.com/news/encounters-bug-fixes-more-subscription-options)
- 一个人物被提到足够多次时，出现一个可确认的图标，生成他的性格、背景与关系。来源：[Playable characters 更新](https://gamehypes.com/news/playable-characters-enhanced-character-details-ui-changes-etc)
- 很多 AI 判断（“某某现在在场”“学到了名字”“敌人被打倒”）做成**玩家可确认的事件**，不直接生效。来源：同上、[常见问题修复](https://gamehypes.com/news/fixes-to-some-frequently-encountered-issues)
- 最近一回合的插图放在右上角；默认占位图是作者的狗（后来改掉了，可用秘籍改回）。来源：[UI Changes](https://gamehypes.com/news/ui-changes-2)、[Visual Enhancements](https://gamehypes.com/news/visual-enhancements-bug-fixes)
- 更短回合长度选项，用来“减少 AI 替你行动”。来源：[Plausibility tweaks](https://gamehypes.com/news/plausibility-tweaks-etc)

### 1.11 Dreamjourney

- **导演模式**：输入框附近一组快捷芯片——“推进剧情”“提高赌注”“多些对白”“放慢节奏”“别替我行动”，加一句自定义方向；可只用一次或“每次回复都保持”。来源：[官网](https://dreamjourneyai.com/)（营销页，界面细节【待验证】）
- **回复风格设置**：长度（聊天 / 适中 / 普通 / 小说）、人称（第一 / 第三 / 自动）、对白与叙述比例、时态。来源：同上
- **Memory Nexus**：给每个人、地点、物品建条目并随剧情更新；关键场景连同涉及的人物一起存；**“小圆点标出你上次看过之后 Nexus 改了什么”，每项可改、可锁、可撤销**。来源：同上
- 重说与分支在同一处，显示“2 / 3”与“从这里分支”。来源：同上
- Lorebook：每条有类型、触发词、权重 1–10、最多 3 条置顶、隐藏；扫描最近 16 条消息；整词匹配。来源：[Lorebooks 文档](https://djai.gitbook.io/djai-docs/basics/lorebooks)
- 玩家自己做的浏览器扩展补上的功能（反过来说明原产品缺什么）：重说前保存旧回复可一键换回、输入内容自动保存防崩溃、导出为 txt、“距离上次检查记忆过了多少条”提醒（变橙再变红）。来源：[Aster 扩展](https://github.com/Sunflower-Seedss/Aster/blob/main/README.md)

### 1.12 Talefy

- 每步四个预设选项加一个自由输入框；文字和自动生成的场景图一起出现；每步约 10 秒以上。来源：[DreamGen Talefy 评测](https://dreamgen.com/blog/articles/talefy-ai-review)（第三方）
- 故事列表有分类、热门、悬停播放的短动画预览、年龄分级。来源：同上
- 一位玩家好评：开始前有简短概述告诉你“会是什么样”；退出后能从原处继续；配音像真人。来源：[App Store 评论](https://apps.apple.com/us/app/talefy-ai-character-roleplay/id6504186435?platform=iphone&see-all=reviews)
- **严重缺陷**：提交后不能编辑、删除或重说，走错一步只能整局重来；玩家抱怨“故事已被编辑，无法继续”的错误反复把人踢出故事；闪退后从头开始。来源：同上、[DreamGen 评测](https://dreamgen.com/blog/articles/talefy-ai-review)

### 1.13 成熟的手机互动小说（呈现打磨）

**80 Days 与 Sorcery!（inkle）**
- 每段文字不超过约 100 字（英文词），玩家“在思考下一步时几乎是顺带读完的”。来源：[去掉阅读的挫败感](https://www.gamedeveloper.com/design/how-to-remove-the-frustration-of-reading-in-games)
- 节奏像对话：你说一句，游戏回一句；大抉择拆成“走近一点 → 再近一点 → 搭话”的一串小选择，像二十一点一样越来越险。来源：[80 Days：为手机打造文字冒险](https://www.gamedeveloper.com/business/-i-80-days-i-building-the-perfect-text-adventure-for-mobile)
- “点一下继续”让玩家觉得“是自己把故事从玻璃里拉出来的”。来源：同上
- GDC 2018 Joseph Humfrey 的文字界面原则：一行 5–15 个词，超过 16 眼睛就跟不上；行距、段距要宽；自动首行缩进；字号普遍偏小；当前该读的一行用亮色，读过的变灰；**短句慢放、长句快放**；文字逐步显示本质上是动画，要像调关键帧一样反复调；**80 Days 里玩家选中的选项会变成下一段的开头，平滑地动画并入正文**；Sorcery! 选择后新的一页纸从底部滑上来接在前文后面，接缝让你知道读到了哪里。来源：[4Gamer GDC 2018 报道](https://www.4gamer.net/games/020/G002085/20180324008/)、[Game Developer 视频简介](https://www.gamedeveloper.com/design/video-designing-text-ux-for-effortless-reading)
- 界面原则：每个界面元素在有用的时候才逐一引入，“十分钟后不看教程也知道每样东西干什么”；把“文字当作图像”，因为人先看到再读。来源：[Vice 采访](https://www.vice.com/en/article/the-makers-of-mobile-hit-80-days-on-the-importance-of-amazing-ui-852/)
- Sorcery! 的地图同时是：进度条、分支与后果的证明（“你走了河道，所以错过了村子”）、存档点系统（沿着走过的路线倒回去）、结局时的成就（回头看自己走了多远）。来源：[Sorcery! 复盘](https://www.gamedeveloper.com/business/postmortem-i-steve-jackson-s-sorcery-i-series-by-inkle)
- 倒带：Sorcery! 3 允许沿路线倒回任意一步，随后补进前两部，评测称“几乎是必需的”。来源：[TouchArcade](https://toucharcade.com/2015/07/08/inkle-updates-sorcery-and-sorcery-2-with-rewind/)

**Choice of Games / Hosted Games 安卓合集（2026-04 新版）**
- 设置：字体（衬线 / 无衬线 / OpenDyslexic）、字号、背景色（黑、白、米黄）、翻页卷曲动画（可关，系统“减少动态效果”时自动关）、默认隐藏时钟和电量（可打开）、跟随系统深浅色。来源：[安卓新版公测说明](https://forum.choiceofgames.com/t/beta-test-the-new-version-of-our-android-app/177129/1)、[字号与颜色](https://www.choiceofgames.com/2017/04/change-the-color-and-size-of-our-text/)
- 游戏内：手机上点“显示属性”看属性页（平板横屏时属性页常驻右侧并实时更新）；属性页里看成就；可从属性页恢复检查点；重开游戏不清成就。来源：同上
- 书库：最近游玩、收藏、已购、已下载；搜索支持类型标签、排序方向、网格 / 详情两种视图。来源：同上
- 跨游戏“元成就”：玩完几个游戏、同一游戏重玩几次、做过多少选择、连续几天有游玩等。来源：同上
- 结局时：打 9–10 分才引导去商店评价；分享给朋友。来源：同上
- 离线可玩；设置里有“排障”页：存档列表、更新时间与错误、发送错误日志。来源：同上

**Lifeline**
- 实时推进：主角说“去山那边，三小时后联系”，就真的三小时后用通知找你；“主角在忙”是游戏的一部分；可以直接在锁屏或手表上回复。来源：[Game Developer](https://www.gamedeveloper.com/design/building-a-narrative-out-of-push-notifications-in-i-lifeline-i-)、[App Store](https://apps.apple.com/ca/app/lifeline/id982354972)
- 完成任意一条路线后解锁“快速模式”跳过等待，并可倒回到经过的检查点而不必从头开始。来源：[App Store 版本说明](https://apps.apple.com/ca/app/lifeline/id982354972)

**Reigns**
- 每次决策影响四个势力条，太高太低都会死；每一代君主存进时间线，得到“某某大帝”“某某邪恶者”式的称号，下一代继承之前解锁的牌。来源：[TechCrunch](https://techcrunch.com/2016/08/17/reigns-app-game/)、[Reigns 设计复盘](https://www.gamedeveloper.com/design/game-design-deep-dive-creating-an-adaptive-narrative-in-i-reigns-i-)
- 拖到一半预览影响哪几个条（已在 [中文调研](COMPETITORS_CN.md) 里记录）。

---

## 2. 横向对照

### 2.1 主界面：AI 文字和玩家输入怎么区分

| 做法 | 产品 | 评价 |
|---|---|---|
| 玩家行动小字淡色，正文大字 | 我们现在的做法；AI Dungeon 用高亮区分 | 读起来干净 |
| 按来源上色（开场 / AI / 玩家改过 / 玩家写的） | NovelAI | 对“写”模式和“改写”特别有用，能看出哪些字是自己定下的 |
| 选中的选项变成下一段开头并动画并入 | 80 Days | 最顺滑的过渡，连续阅读感最强 |
| 新内容像新纸页从底部滑上，留接缝 | Sorcery! | 告诉玩家“读到这里了” |
| 气泡加头像 | C.AI、Chai | 聊天感强、小说感弱；去掉头像会被骂 |

### 2.2 “后悔药”的入口与可发现性

| 操作 | 常见入口 | 可发现性问题 |
|---|---|---|
| 重说 / 换版本 | 最后一条下方的箭头和计数（2/3） | Chai 的箭头被嫌笨，玩家把“重说”当“编辑”误点 |
| 重说时给方向 | AI Dungeon 重说旁的铅笔图标 | 我们用“长按重说”，可发现性更差，可考虑加可见小图标 |
| 回到这里 | 长按或消息菜单 | C.AI 的实现跳到第一条且不能撤销，是最大差评点 |
| 编辑 | 点段落（AID、NAI）或长按（C.AI） | AID 用户不知道怎么退出编辑，误按 redo 丢进度 |
| 分支 | 消息菜单（ST）、“从这里开新聊天”（C.AI） | 免费用户被砍掉后怨气极大 |
| 记住这件事 | 长按 → 固定（C.AI） | 每次记住出提示，玩家才知道“它在听” |

### 2.3 读写设置清单（取并集）

字号（正文与界面分开）、行距、段距、首行缩进、最大行宽、字体（衬线 / 无衬线 / 易读字体）、背景（白 / 黑 / 米黄）、跟随系统深浅色、关闭文字动画、流式速度、生成跟随到底部的开关、回合后保持输入框、紧凑按钮、隐藏状态栏、减少动态效果、对白高亮、生成完成提示音（只在后台时）、触感反馈开关、屏幕常亮。来源见 1.1、1.2、1.3、1.13 各节。

---

## 3. 玩家抱怨汇总（要避开的）

| 抱怨 | 产品 | 对我们的含义 |
|---|---|---|
| 回到某处时把之后的内容全删了，且不能撤销 | C.AI、Infinite Worlds | 继续坚持“回到这里不删除”，并在操作后给一条可撤销提示 |
| 提交后不能改，走错只能重开 | Talefy | 我们已解决；要在新手阶段让玩家知道“随时能改” |
| 误点“删除全部” | Chai | 危险操作放深一层、二次确认、进回收站 |
| 退出编辑的方式不明，误按别的按钮丢进度 | AI Dungeon | 编辑态要有明确的“完成 / 放弃”，离开时自动保存草稿 |
| 自动保存用旧内容覆盖新编辑 | AI Dungeon | 编辑与后台写入的冲突要测 |
| 手机键盘遮住输入框、留大块空白、控件乱跳 | AI Dungeon（修了两次） | 每次改输入栏都要真机试键盘 |
| 回车有时发送有时换行 | C.AI | 我们已定“回车换行、按钮发送”，保持一致 |
| 改版后头像 / 熟悉元素消失 | C.AI | R09 之后的改版要保留玩家熟悉的元素 |
| 好功能被砍或改成付费且无说明 | C.AI、Chai | 个人项目不涉及收费，但删功能要写进更新说明 |
| 等待太久，等的时候切走 | Hidden Door、Talefy | 流式要尽早出字；后台写完给提示音或振动 |
| 叙述者改写我的台词、替我做动作 | Voyage、AI Roguelite | 提示词约束 + “说”模式原样保留玩家台词 |
| 点建议行动覆盖了输入框里我写的字 | Infinite Worlds | 输入框有字时点选项要询问或改为追加 |
| 界面 bug 多，“重启就好” | AI Dungeon、Talefy | 出错时说人话，并提供“重试”而不是要玩家重启 |
| 设置太多吓人 | NovelAI、SillyTavern | 高级项折叠；默认值要好 |

---

## 4. 值得采用的模式（按优先级）

成本：S 约半天到一天，M 约两三天，L 一周以上。“现状”一栏是对照本项目代码和 [PLAN_V3](../PLAN_V3.md) 第 4 节的粗略判断，实施前要再核对现场。

### 第一档：直接提升“精细度”，成本低

| # | 模式 | 谁在做 | 对玩家的意义 | 成本 | 历史题材的改法 | 现状 |
|---|---|---|---|---|---|---|
| 1 | **选项并入正文的过渡动画**：点选项后，选项文字滑入并成为玩家行动行，新正文在其下流式出现 | 80 Days、Sorcery! | 连续阅读不断裂，“我做的事”和“发生的事”接成一条线 | S | 无 | 待做 |
| 2 | **生成跟随开关**：生成时保持在本段开头（从头读）或自动跟到底 | AI Dungeon | 长段落不必追着滚动条读 | S | 无 | 部分已有（有“回到底部”），缺开关 |
| 3 | **重说旁加可见的“带方向重说”小图标**，并给几个常用芯片（短一点 / 换个结果 / 让他拒绝） | AI Dungeon、Dreamjourney | 长按不可发现；芯片让人不用想措辞 | S | 芯片可用“写得更有古意”“少些现代词” | 已有长按，缺可见入口 |
| 4 | **每次自动记下东西时在故事流里出一行可点的小提示**（“记下：孙管事欠你五两”），点开可改、可撤销 | C.AI、Dreamjourney | 玩家知道系统在听，记错能当场纠正 | S | 提示用“记事”口吻 | 部分已有（设定集整理有提示），扩展到人物与要点 |
| 5 | **状态条变化动画**：数值档位变化时细条滑动并短暂高亮涨跌方向 | AI Roguelite | “有后果”一眼可见 | S | 钱用“文 / 两”滚动计数 | 有标签，缺动画 |
| 6 | **生成完成的提示音 / 振动（仅在后台或锁屏时）** | SillyTavern、C.AI | 等待时可以切走，写完被叫回来 | S | 提示音可用木鱼、磬声 | 有前台服务通知，缺完成提醒 |
| 7 | **阅读排版补齐**：段距、首行缩进、最大行宽、对白高亮（引号内文字变色或加粗）、米黄纸色 | NovelAI、Choice of Games、inkle | 中文长段落最影响舒适度的是段距和行宽 | S | 首行缩进两字是中文书的习惯；可选楷体 / 宋体标题 | 有字号、行距、主题，缺其余 |
| 8 | **“回到这里 / 撤销”后的可撤销提示条**（“已回到第 12 回合，原路线已保留 [撤回]”） | Gmail 式通用做法；反面是 C.AI | 让“不丢东西”被看见，敢于尝试 | S | 无 | 待核对 |
| 9 | **输入框有字时点选项不覆盖**：改为询问或追加到末尾 | 反面是 Infinite Worlds | 避免辛苦打的字消失 | S | 无 | 待核对 |
| 10 | **刷新 / 闪退后恢复未发送的输入** | SillyTavern、Aster 扩展 | 打了一大段字被杀进程不会丢 | S | 无 | 待核对 |
| 11 | **编辑态明确的“完成 / 放弃”浮动按钮，离开自动存草稿** | AI Dungeon 2026-09 | 避免误操作丢改动 | S | 无 | 待核对 |
| 12 | **出错页说人话并给下一步**（重试 / 换服务 / 查看服务状态） | AI Dungeon（错误页链接状态页） | 不用重启、不用猜 | S | 时代感过场文案可用于等待，不用于错误 | 部分已有（PLAN 4.12） |

### 第二档：让一局游戏有“形状”和“回顾感”

| # | 模式 | 谁在做 | 对玩家的意义 | 成本 | 历史题材的改法 | 现状 |
|---|---|---|---|---|---|---|
| 13 | **回来时的“前情提要”卡**：离开超过一段时间再进入，先给三五句上回发生了什么、当前目标、时间地点，一键收起 | 通用做法；AID 的 Story Summary、F&F 的 Plot 是数据来源 | 隔天再玩不用往上翻 | S～M | 写成“前回书说到……”章回体口吻 | 有章节摘要数据，缺进入时的展示 |
| 14 | **章回化**：每 N 回合或每次“过些日子”后自动成回，生成回目（对仗标题），故事流里显示回目分隔 | Hidden Door 的场景 / 故事结构；80 Days 的分段 | 一局有段落和节奏，读起来像小说 | M | 章回体回目“第三回 西市问米价 城隍遇故人”是天然特色 | 有章节摘要，缺可见分隔与回目 |
| 15 | **足迹 / 行程图**：按时间顺序列出到过的地点和停留时长，可点某站“回到那时” | Sorcery! 地图、F&F 小地图与测距 | 看得见走了多远、分支在哪 | M（列表）～L（真地图） | 先做“行程录”（某年某月 自长安至洛阳），远期叠古地图 | 待做 |
| 16 | **目标出现 / 完成的仪式感提示**：小卡片从顶部落下，附一句评语 | Hidden Door | 有盼头、有收获感 | S | 用“立誓”“了却心愿”等说法 | 有目标系统，缺仪式感 |
| 17 | **一生 / 一局总结页**：结束或任意时刻生成“传记”——年表、结识的人、做成的事、历史偏离；可导出图片 | Reigns（历代君主与称号）、BitLife | 记得住；适合截图分享 | M | 盖棺定论式的“谥号”与“史官评语”，墓志铭 / 列传体 | 待做 |
| 18 | **“你的故事”统计页**：总回合数、游戏内过了多少年、走过几座城、认识多少人、最长世界、游玩日历 | AI Dungeon 2026-08 | 让长期游玩有可见积累 | S～M | 统计“历经几朝几帝”“花了多少两银子” | 有用量统计，缺玩家向统计 |
| 19 | **成就（轻量、不打扰）**：本地成就，如“初到异乡”“结识十人”“改变一件史实”“活过一甲子” | Choice of Games 元成就 | 有盼头，鼓励尝试不同开局 | M | 成就名用典故或时代说法 | 待做 |
| 20 | **精彩片段分享图**：长按一段选“生成分享图”，排成竖版宣纸卡片，带世界名、时代、回目 | NovelAI 截图设计器、Hidden Door 分享时刻 | 个人项目也有“想给朋友看”的时刻 | M | 宣纸、印章、竖排可选 | 待做 |
| 21 | **导出为可读的文本 / 电子书**（不是存档 JSON）：按章回排版的 txt 或 HTML | AI Dungeon 下载冒险、Aster 导出 txt | 一局结束后留下一本“小说” | S～M | 封面写书名与“某某著” | 只有 JSON 存档导出 |
| 22 | **朗读**：系统 TTS 朗读正文，可调语速，可自动朗读新段落 | AI Dungeon、ChatterUI、F&F | 通勤或做家务时“听书” | M | 中文系统语音质量参差，【待验证】小米设备的效果 | 待做 |

### 第三档：控制与记忆界面再进一步

| # | 模式 | 谁在做 | 对玩家的意义 | 成本 | 历史题材的改法 | 现状 |
|---|---|---|---|---|---|---|
| 23 | **导演快捷芯片**：输入栏上方一排可点的方向（推进剧情 / 提高赌注 / 多些对白 / 放慢 / 别替我行动），可选“保持” | Dreamjourney、AID 的 Guide | 不想打字也能掌控节奏 | S | 加“来点历史大事”“让朝局动一动” | 有导演模式，缺芯片 |
| 24 | **记忆“变更小圆点”**：人物、设定卡被 AI 改过后出现小圆点，打开显示改了什么，可撤销或锁定 | Dreamjourney Memory Nexus | 自动整理不再是黑箱 | M | 无 | 有“AI 整理”行，缺逐卡标记与锁定 |
| 25 | **记忆容量条（玩家语言）**：要点和固定记忆占了多少，快满时提醒 | C.AI | 理解“为什么它忘了” | S | 用“案头”“书箱”比喻 | 开发者模式有上下文查看器 |
| 26 | **“这回合参考了什么”**：点状态标签旁的小图标，列出本回合用到的人物卡、设定卡、记事（不显示 token） | F&F 研究步骤、AID 上下文查看器 | 掌控感；出错时知道该改哪张卡 | M | 无 | 只有开发者模式 |
| 27 | **可确认的关键事件**：人物死亡、重大物品得失、身份变化这类大改动先以“确认卡”出现（同意 / 不对，改一下） | AI Roguelite | 防止一次误判毁掉长局，避免“小错滚雪球” | M | 无 | 记账直接生效 |
| 28 | **多个开场可滑动挑选**：同一开局设定先生成 2–3 个开场概要，玩家挑一个再写全文 | C.AI 多开场白 | 第一回合就“对味” | M | 不同开场可对应不同落脚处（醒在牢里 / 醒在花轿上） | 待做 |
| 29 | **新手开局推荐与“开始前一句话预期”**：模板卡片显示时代、身份、难度、一句“你会经历什么” | AID 新手推荐、Talefy 开场概述、CoG 的类型标签 | 第一次就挑对、开得快 | S | 卡片封面可用朝代色与纹样 | 有模板，待核对卡片信息量 |
| 30 | **首页书库**：世界卡片封面、按最近游玩 / 名称 / 时代排序、搜索、收藏置顶 | ChatterUI、CoG | 世界多了也好找 | S～M | 封面用朝代纹样 + 主角名 | 有卡片，缺排序与搜索 |

### 第四档：有特色但成本高，或需要先验证

| # | 模式 | 谁在做 | 对玩家的意义 | 成本 | 历史题材的改法 | 现状 |
|---|---|---|---|---|---|---|
| 31 | **邸报 / 家书式的离线推进通知**：玩家设定“过些日子”后关掉应用，到时间用通知送来一封家书或邸报摘要 | Lifeline | 生活化的牵挂感；穿越题材很搭 | L | 通知标题“家书一封”“京中邸报” | 待做；后台网络限制【待验证】 |
| 32 | **一回合一张插图（可关）** | AI Roguelite、Talefy、Infinite Worlds | 画面感 | L | 需要图像服务，风格要统一（工笔 / 水墨）；Hidden Door 认为少而精胜过多而乱 | 不在范围内，需用户决定 |
| 33 | **视觉小说式人物立绘** | SillyTavern、Voyage | 人物更立体 | L | 需要立绘资源 | 不建议近期做 |
| 34 | **语音输入** | F&F | 手机上打长段中文费劲 | M | 依赖系统输入法即可，可能不需要专门做 | 系统输入法已支持 |
| 35 | **每日签到 / 连续天数** | AI Dungeon、CoG 元成就 | 留存 | S | 个人使用意义不大，不建议 | 不建议 |

### 不建议学的

- **卡牌抽卡、广告、付费墙式限制**（Talkie、Chai、C.AI）：个人项目没有这个需要，而且是差评重灾区。
- **自写行动被系统改写成“合规版本”**（Hidden Door）：伤害“掌控”支柱。
- **把设置全部摊开**（SillyTavern、NovelAI）：我们按 PLAN_V3 4.11 的折叠原则即可。

---

## 5. 未能核实的内容

- Character.AI 2025-02 社区更新原页返回 403，触感反馈、“从这里开新聊天”等内容取自搜索摘录【待验证】。
- AI Dungeon“你的故事到目前为止”统计页只拿到一句概述，版式【待验证】。
- Voyage 的屏幕布局、骰子与血量的具体显示、视觉小说模式只有第三方一句话描述【待验证】；Google Play 页面未能抓取。
- Dreamjourney 导演模式、Memory Nexus 小圆点的界面只来自官网营销页【待验证】。
- Hidden Door 游玩界面布局（建议行动的位置、卡牌在屏幕上的位置）没有找到可靠图文描述【待验证】。
- Reigns 拖动预览、Lifeline 的通知节奏数值，只有设计复盘文章，没有亲自试玩。
- 中文系统 TTS 在小米手机上的质量、Android 15+ 后台定时通知能否稳定送达，需要真机验证【待验证】。
