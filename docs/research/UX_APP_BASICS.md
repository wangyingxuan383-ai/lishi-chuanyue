# 成熟 App 的“基本功”：功能之外，用户默认就该有的东西

> 调研日期：2026-10-17（Asia/Shanghai），由调研子代理完成。**本文所有来源的查阅日期都是 2026-10-17**，文末“来源一览”再逐条列出。
>
> 起因：用户觉得 0.8.0“能用，但不像一个完整、成熟的 App”，并发现 [PLAN_V4](../PLAN_V4.md) 的方向大多围绕游戏功能，漏了每个成熟 App 都有的“App 部分”（PLAN_V4 方向 K、L 只列了问题）。本文回答：成熟的手机和电脑应用在核心功能之外，通常还提供什么；我们现在有什么、缺什么。
>
> 姊妹篇：[中文产品界面细节](UX_CN.md)、[海外 AI 故事产品界面细节](UX_INTL.md)。那两篇讲“读与玩”的手感，本篇只讲“App 的基本功”：设置、关于、更新、反馈、数据、书架管理、系统状态、无障碍、电脑端、信任。
>
> 说明：
> - “我们有没有”是按 0.8.0 代码（`src/ui/`、`src/platform/`、`src-tauri/`）实际检查的结果，写“有 / 部分 / 没有”，不代表做得好。
> - 第三方测评、教程站的说法可能对应旧版本，凡没在官方文档或现行版本确认的写【待验证】。
> - 本文的建议都是候选，按 [AGENTS.md](../../AGENTS.md) 要先进[台账](../TASKS.md)候选池，经用户同意再立项。

## 一句话结论

我们的“游戏内”已经比多数同类细致（重说、改写、世界线、回收、撤销都有），但**“游戏外”几乎是空白**：没有关于页和版本号、没有检查更新、没有反馈和诊断、没有帮助入口；备份每天在做却看不见也恢复不了；首页的世界不能改名、置顶、搜索，删除是永久的；确认框和输入框用的是浏览器自带的 `confirm()`/`prompt()`；提示条不能撤销。这些单项都不大，但正是它们让一个 App 显得“完整”。最值得先补的是三件：**设置页重排并加“关于与更新”**、**首页书架的管理与回收站**、**统一的确认框和可撤销提示条**。

---

## 一、我们现在有什么（代码现场）

先把现状摆出来，后面的对照才有依据。

| 方面 | 现状 | 位置 |
|---|---|---|
| 设置页 | 一页平铺：AI 服务（多套配置、切换、修改、删除）、每回合上下文三档、阅读（字号四档、主题纸张/白天/夜间、黑体/宋体、带一段预览文字）、用量（总量 + 明细与费用估算）、开发者模式开关 | `src/ui/screens/Settings.tsx` |
| 分组 | 只用小灰字当标题，没有卡片和分隔，没有说明、没有恢复默认 | 同上 |
| 关于 / 版本 | 界面上任何地方都不显示版本号；没有关于页、许可、隐私说明 | 全局搜索无结果 |
| 首次使用 | 没有 AI 服务时自动进入“连接 AI 服务”，可“稍后再说”；首页空状态是印章 + “醒来时，你已在另一个时代。” | `App.tsx`、`Setup.tsx`、`Home.tsx` |
| 权限 | 安卓上第一次开局前弹自己的说明“允许通知吗？”，只问一次 | `Play.tsx` |
| 备份 | 每天启动时自动备份一次数据库，原生侧保留最近 20 份；**界面上看不到，也不能恢复** | `game.ts` `autoBackup`、`src-tauri/src/sql.rs` |
| 导入导出 | 单个世界导出为 `.lishi.json`、从文件导入（同 ID 问“另存/覆盖”） | `Home.tsx`、`engine/archive.ts` |
| 书架 | 世界卡片按最近游玩排列；长按菜单：继续、用同样设定再开一局、导出、删除（`confirm()` 后永久删除） | `Home.tsx` |
| 回收 | 世界线有“已删除 → 恢复 / 彻底删除”；人物、设定集删除“之后可以撤销”；**世界本身没有回收站** | `Lines.tsx`、`People.tsx`、`Codex.tsx` |
| 提示 | 统一的 `toast`（纯文字，无操作按钮）；确认用 `confirm()`，命名用 `prompt()` | `context.tsx`、多处 |
| 加载 / 错误 | 启动页有印章和“正在打开…”；其他地方是“正在读取…”文字；回合失败有说明，配置错误给“去设置” | `App.tsx`、`Play.tsx` |
| 返回键 | 浮层先关、再退一页、首页“再按一次退出” | `App.tsx` |
| 无障碍 | 约 51 处 `aria-label`；弹层有 `role="dialog"`；有 `prefers-reduced-motion`；点击区域 44px | `src/ui/` |
| 触感 | 长按时 `navigator.vibrate(10)`，没有开关 | `useLongPress.ts` |
| 电脑端 | 回车发送、Shift+回车换行、Esc 返回；右键被屏蔽（没有右键菜单）；只出 NSIS 安装包；窗口大小不记忆 | `Play.tsx`、`useLongPress.ts`、`tauri.conf.json` |
| 秘密 | Windows 用 DPAPI（当前用户），安卓用系统 Keystore；首次连接页写“Key 只保存在这台设备上，会加密存放” | `src-tauri/src/secret/`、`Setup.tsx` |

---

## 二、成熟 App 是怎么做的（按主题）

### 2.1 设置页的结构

**平台规范怎么说**

- Windows 的设置指南：设置页放“不常改的配置、偏好、以及不常看的 App 信息（隐私政策、帮助、版本、版权）”，日常操作不要放进设置；改了**立即生效，不要“确定”按钮**；用小节标题分组；少用的设置收进可展开的一组（SettingsExpander），**展开不超过一层**；某项暂时不可用时置灰并写明原因；主题选项建议是“浅色 / 深色 / 跟随系统”；**在设置页底部放“关于”**，折叠时显示应用名、图标、版本号，展开后放仓库链接、反馈链接、依赖列表、版权与隐私声明。[Windows 应用设置指南](https://learn.microsoft.com/en-us/windows/apps/design/app-settings/guidelines-for-app-settings)
- 安卓系统设置的设计指南：常用的放最上面；**每屏 10～15 项**，多了拆子页；“高级”折叠**至少藏三项才值得折**，折叠行的副标题要列出被藏的项目名；**每项副标题显示当前值**，而不是重复标题；标题要短、关键词在前、少用“设置/管理/更改”这类空动词；危险操作（清除数据）用灰色按钮；标题栏放搜索和帮助，不鼓励把动作藏进溢出菜单；需要教育用户时，顶部放图或动画、底部放说明文字。[AOSP 设置设计指南](https://source.android.com/docs/core/settings/settings-guidelines)
- 同一设置可以从多个地方进入（如“默认通知音”同时出现在“通知”和“声音”下），但应是同一个页面的多个入口，避免两个开关管一件事。[AOSP 设置设计指南](https://source.android.com/docs/core/settings/settings-guidelines)

**成熟产品的做法**

- **Chatbox** 的设置按主题分页：模型提供方、联网搜索、默认模型、对话设置、键盘快捷键、常规设置（字号、语言、数据备份）；点左上 Logo 进“产品信息”，内含版本、官网、建议反馈、**更新日志**、官方邮箱。[Chatbox 界面介绍](https://chatboxai.app/zh/guide/getting-started/interface-overview)
- **Stardew Valley** 的选项分“常规 / 声音 / 画面 / 操作”，每项有明确默认值（如音乐音量默认 75%、UI 缩放 75%～150%、每档 5%）；**开新档时另有“高级选项”**（扳手按钮），和游戏中的选项分开。操作页有“恢复默认按键”（且不二次确认）。[Stardew Valley Wiki：Options](https://wiki.stardewvalley.net/Options)
- **微信读书**把“阅读时的设置”放在阅读器工具栏（目录、进度、背景、字体），把“全局设置”放在“我 → 设置”（阅读时不锁屏、音量键翻页、隐私等）。[微信读书帮助：背景和字体](https://weread.qq.com/wrpage/app/help/detail/qReadingBgAndFront)、[微信读书 56 条指南](https://mp.weixin.qq.com/s/dM2Abv_SWzQ--0y3XaORDw)
- **番茄小说**阅读设置分“字号 / 字体 / 间距 / 背景 / 翻页 / 夜间”，“更多设置”里有锁屏时间（常亮）、音量键翻页。（第三方教程，版本 v7～9）[番茄小说阅读设置指南](https://fanqiepc.ijinshan.com/pages/guides/reading-settings/index.html)、[屏幕常亮教程](https://www.iefans.net/info/v1396856.html)
- **LibreTube** 给“自动检查更新”加了一句副标题“每次启动时自动检查更新”——一个小提交，说明成熟项目在意“每项都有一句解释”。[LibreTube 提交 d68b53e](https://github.com/libre-tube/LibreTube/commit/d68b53ed661768e0a1651bfcc8ac35088f2a7faa)

**设置搜索**：大型 App（安卓系统设置、Obsidian、VS Code 类）才需要；AOSP 指南要求搜索结果显示标题、副标题和路径。[AOSP 设置设计指南](https://source.android.com/docs/core/settings/settings-guidelines)。我们的设置不到 20 项，**不需要搜索**，按 Windows 指南“总设置数保持很少”即可。

**对我们的启发**：设置页按“AI 服务 / 阅读 / 游玩默认 / 数据与备份 / 关于”分组，每组一张卡；每项一句说明、显示当前值；阅读组保留现有预览；“开发者模式”收进“关于”底部（连点版本号 7 次打开是安卓社区常见做法【待验证】）；每组提供“恢复默认”。

### 2.2 关于页、更新说明、检查更新

**关于页放什么**：应用名与图标、版本号（最好附构建号/日期）、仓库或主页链接、反馈与报告问题入口、依赖与开源许可列表、版权、隐私声明。[Windows 应用设置指南](https://learn.microsoft.com/en-us/windows/apps/design/app-settings/guidelines-for-app-settings)。ChatGPT 把版本号放在设置页最底部。[ChatGPT iOS 常见问题](https://help.openai.com/en/articles/7885016)。豆包的版本号也在“我的 → 设置 → 关于豆包”，并在这里“检测更新”。[豆包无障碍更新说明](https://mp.weixin.qq.com/s/9xLEjIAnh68fqJo1DikAGQ)。Obsidian 用户在论坛提出“设置里的版本号应该能一键复制”，官方回复用“显示调试信息 → 复制”代替——说明**版本号可复制**是用户默认期待。[Obsidian 论坛：复制版本号](https://forum.obsidian.md/t/allow-to-copy-obsidian-version-in-settings/76351)

**开源许可**：我们打包了 React、sql.js、Tauri 及大量 Rust crate，按各自许可（MIT/Apache 等）通常要求随附版权与许可文本【待验证：逐项许可要求，见 [R10 公开前检查](../validation/R10_PUBLIC.md)】。常见做法是关于页里一个“开源许可”子页，按依赖名列出、点开看全文。

**更新后的“新功能”**：Chatbox 在产品信息里放更新日志入口，并维护带日期的版本说明页。[Chatbox 更新日志](https://chatboxai.app/zh/help-center/changelog)。Obsidian 在“设置 → 常规”顶部显示 App 版本与安装器版本、“检查更新”按钮、“自动更新”开关，有新版时提示“重新启动”应用更新。[Obsidian 帮助：更新](https://obsidian.md/help/updates)。常见做法是：版本号变化后第一次打开，弹一张“这一版有什么新东西”的卡片（3～5 条），可关闭、可在关于页再看【待验证：具体哪些中文 App 这样做】。

**侧载 APK 与 GitHub Releases 的更新检查**（我们的发行方式）：

| 做法 | 怎么工作 | 谁在用 | 适合我们吗 |
|---|---|---|---|
| Tauri 官方更新插件（仅电脑） | `tauri.conf.json` 里写更新地址，可直接指向 `releases/latest/download/latest.json`；**签名强制，不能关**，私钥丢了就再也不能给已安装的用户推更新；前端调 `check()`、`downloadAndInstall()`，有进度事件；Windows 安装时 App 自动退出，安装模式可选 passive（默认，小进度窗）/basicUi/quiet；插件只在桌面端初始化，**不支持安卓** | Tauri 项目 | 适合 Windows 版；要先管好签名私钥。[Tauri 更新插件](https://v2.tauri.app/plugin/updater/) |
| 应用内查 GitHub 最新发布 | 调 `GET /repos/{owner}/{repo}/releases/latest`，返回最新的非预发布版：`tag_name`、`name`、`body`（更新说明）、`assets`（含 `browser_download_url`）；比较版本号，有新版就展示说明并打开下载链接，由系统安装器覆盖安装 | LibreTube 在设置里有“检查更新”按钮和“自动检查”开关 | 适合安卓侧载包。未登录调用**每个 IP 每小时 60 次**，一天查一次绰绰有余。[GitHub：获取最新发布](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)、[GitHub：速率限制](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[LibreTube 提交](https://github.com/libre-tube/LibreTube/commit/d68b53ed661768e0a1651bfcc8ac35088f2a7faa) |
| 交给第三方更新器 | 用户在 Obtainium 里添加仓库地址，它比较已安装版本与发布版本号（要求格式一致，如 `0.14.21` 对 `v0.14.21`），提示或静默更新 | 很多开源安卓 App 推荐此法 | 作为补充写进帮助即可。[Obtainium Wiki](https://wiki.obtainium.imranr.dev/app_tracking/) |
| 只给一个静态 JSON | App 读自己网站上的版本文件；讨论中指出“报告问题前先确认自己是不是最新版”是这个按钮的主要价值 | Butterfly | 我们没有网站，不如直接用 GitHub。[Butterfly issue #691](https://github.com/LinwoodDev/Butterfly/issues/691) |

注意事项：检查更新是本 App 除 AI 服务外**唯一的联网行为**，应默认只在用户点按钮时检查，或首次询问“要不要每天自动检查一次”，并在信任说明里写清楚“只访问 github.com，不发送任何游戏内容”；仓库是否已公开、未登录能否读到发布【待验证：D127 之后的仓库状态】。

### 2.3 反馈、诊断、帮助

- **一键复制诊断信息**：Obsidian 的“显示调试信息 → 复制到剪贴板”输出版本、安装器版本、系统、语言、主题、插件列表等纯文本，论坛志愿者第一句话往往就是“请贴一下调试信息”。它还有“启动耗时”报告，同样可复制。[Obsidian 帮助与支持](https://obsidian.md/help/resources)、[Obsidian 论坛示例](https://forum.obsidian.md/t/links-not-updating/89004)
- **反馈入口带上机型和版本**：番茄小说“我的 → 反馈与帮助 → 意见反馈”（第三方教程）。[起剖：番茄小说](https://www.qipou.com/fanqiexiaoshuo/page/10/)。DeepSeek 隐私政策写明意见反馈会收集问题描述、附件、联系方式。[DeepSeek 隐私政策](https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html)
- **帮助中心**：Kimi 帮助中心按“新手入门 / 常见问题”组织，常见问题包括“对话发送不出去”“删除后能否找回”“数据存在哪里”等。[Kimi 常见问题](https://www.kimi.com/help/others)、[Kimi 新手入门](https://www.kimi.com/help/new-user-guide/overview)。Chatbox 把数据存储写成专门一篇 FAQ（存在哪、怎么备份、能否从服务器恢复——“无法恢复，因为只存在本地”）。[Chatbox 数据存储](https://chatboxai.app/zh/guide/faq/data-storage)
- **法规层面**（中国）：隐私政策从主界面起**不能超过 4 次点击**才能访问；必须提供投诉、举报渠道。[网信办等《App 违法违规收集使用个人信息行为认定方法》](https://www.cac.gov.cn/2019-12/27/c_1578986455686625.htm)。我们是个人自用、未上架，这条不是硬约束，但“隐私说明 4 步内可达”是好的参照。

**对我们的启发**：我们没有服务器，反馈最合适的形态是“复制诊断信息”+“打开 GitHub Issues（或复制到剪贴板发给作者）”。诊断信息应包含：版本、平台与系统版本、当前 AI 服务的**服务商类型和模型名（不含地址和 Key）**、世界数与回合数、最近 N 次调用的结果与耗时、最近错误；严格脱敏（[AGENTS.md](../../AGENTS.md) 第 9 条：不写私人服务地址、不输出认证头）。帮助做成 App 内的“游玩指南”页（方向 B 已列），常见问题至少覆盖：连不上 / Key 错、费用、存档在哪、换手机、删除能否找回。

### 2.4 首次使用与权限

- **权限按需、先解释**：安卓官方流程是“等用户用到功能时再请求”“系统弹窗只说要什么、不说为什么，所以先用自己的界面讲为什么、拒绝后少了什么，**并且一定有‘不用了’**”；被拒绝后优雅降级、只说明具体哪个功能不可用、**不反复纠缠，也不引导去系统设置劝说用户改主意**。[安卓：请求运行时权限](https://developer.android.com/training/permissions/requesting)、[安卓核心质量清单](https://developer.android.com/docs/quality-guidelines/core-app-quality)
- 中国监管口径相同：在对应功能启动时动态申请，同步告知目的；用户拒绝后不得频繁再申请（国标草案建议“每 48 小时不超过一次”）。[工信部 2023 年 26 号文](https://www.miit.gov.cn/jgsj/xgj/APPqhyhqyzxzzxd/tzgg/art/2023/art_be5c5d0782af4300a4cdcbc10a60f202.html)、[网信办：App 申请权限要注意哪几点](https://www.cac.gov.cn/2019-08/17/c_1124885929.htm)
- **首次运行提示隐私规则**是国内上架 App 的硬性做法（弹窗、不得默认勾选）。[认定方法](https://www.cac.gov.cn/2019-12/27/c_1578986455686625.htm)。我们不收集任何个人信息，可以只在欢迎页写一句“你的故事只存在这台设备上”，不必做同意弹窗。
- **样例内容 / 先试玩**：NN/g 建议空状态给“直达关键任务的入口”，如 Loggly 同时提供“接入数据”和“加载示例数据”两条路。[NN/g：空状态设计](https://www.nngroup.com/articles/empty-state-interface-design/)。

**对我们的启发**：通知权限我们已做对（先解释、只问一次）。要补的是：欢迎页（一到两屏，讲“这是什么、需要你自己的 AI 服务、数据只在本机”）、可跳过；没有 AI 服务时能读一段**预置的示范开场**（不调 AI），让人先看到产品长什么样（PLAN_V4 方向 A 已提“能不能先试玩”）。

### 2.5 数据管理：存储、备份、恢复、迁移

| 能力 | 成熟做法 | 来源 |
|---|---|---|
| 说清楚数据在哪 | Chatbox 列出各平台存储路径（Windows `%APPDATA%\chatbox\`、安卓“应用私有存储”），并声明“聊天记录不上传、Key 不发到我们服务器、对话直接发给 AI 服务商” | [Chatbox 数据存储](https://chatboxai.app/zh/guide/faq/data-storage) |
| 手动 + 自动备份 | Cherry Studio：手动“备份”随时点；自动备份按间隔（几分钟到 24 小时）；**本地备份可选目录（如外置硬盘）**，并能管理备份文件；还有 WebDAV、S3；“精简备份”只备份聊天和设置；**明确警告备份里含 API Key** | [Cherry Studio 数据设置](https://docs.cherryai.com.cn/pre-basic/settings/data-settings.md) |
| 版本快照 | Obsidian“文件恢复”：默认每 5 分钟最多一次快照、保留 7 天，可改；查看快照可“复制”或“恢复”，可“显示差异”；官方强调**它不是完整备份** | [Obsidian 文件恢复](https://obsidian.md/help/plugins/file-recovery) |
| 换设备 | Chatbox：设备 A 导出 → 云盘 → 设备 B 导入；建议“卸载前先导出” | [Chatbox 数据存储](https://chatboxai.app/zh/guide/faq/data-storage) |
| 系统级备份 | 安卓自动备份：每应用最多 25MB，存用户 Google Drive；`dataExtractionRules` 可分别配置云备份和设备间迁移；凭据建议不进备份 | [安卓自动备份](https://developer.android.com/identity/data/autobackup)、[核心质量清单 App_Data_Backup](https://developer.android.com/docs/quality-guidelines/core-app-quality) |
| 清理缓存 | Cherry Studio“清除缓存”按类别显示大小（应用缓存 / 站点数据 / 残留文件 / 旧版数据），每类写明后果；“重置数据”单独放，提示先备份 | [Cherry Studio 数据设置](https://docs.cherryai.com.cn/pre-basic/settings/data-settings.md) |
| 全部导出 | ChatGPT、DeepSeek 都提供“导出全部数据”（邮件链接 / 网页端，链接 24 小时或 7 天有效），并提醒导出文件含敏感信息 | [ChatGPT 导出](https://help.openai.com/en/articles/7730893-data-controls-in-chatgpt)、[DeepSeek 导出与删除（第三方整理）](https://bigolab.com/guides/2275-deepseek-export-delete-history) |
| 跨平台存档 | Stardew：手机标准存档用 PC 格式，可与电脑互传；切到后台时自动做“紧急存档”，下次启动询问是否从上次离开处恢复；手动“备份存档”每个农场一份 | [Stardew Wiki：Mobile Saves](https://wiki.stardewvalley.net/Mobile_Saves) |

国内中文 App 普遍有“清除缓存”（番茄小说、豆包都有，第三方教程）。[起剖：番茄小说](https://www.qipou.com/fanqiexiaoshuo/page/10/)、[豆包清理缓存问答](https://ask.faxianai.com/2522)。我们没有图片和网络缓存，**不需要“清除缓存”**；对应的应是“存储占用”（数据库多大、备份占多少）和“删除旧备份”。

**对我们的启发**：设置里新增“数据与备份”页：数据在哪（一句话 + 可复制路径，电脑端“打开所在文件夹”）、占用多少、**备份列表（时间、大小）与“从这份恢复”**（恢复前先自动备份当前状态）、“立即备份”、“导出全部世界”、“从文件导入”。R08-T001 遗留的“备份目录改到用户选择的手机目录”放在这里。安卓系统自动备份要排除 Key 槽位【待验证：当前 `allowBackup` 与 Keystore 密钥在恢复后的行为】。

### 2.6 书架与内容管理

| 能力 | 成熟做法 | 来源 |
|---|---|---|
| 重命名 / 置顶 | DeepSeek：长按对话 → 重命名 / 置顶，置顶有上限且会提示 | [DeepSeek（第三方整理）](https://bigolab.com/guides/2275-deepseek-export-delete-history) |
| 星标置顶、批量删除、搜索 | Chatbox：星标的对话置顶；“对话列表清除”一次删自定义数量；按关键词搜历史；单个对话可改名、**复制整个对话**、删除 | [Chatbox 界面介绍](https://chatboxai.app/zh/guide/getting-started/interface-overview) |
| 归档 | ChatGPT：归档**不需确认**、从列表隐藏但不删除；“设置 → 数据控制 → 已归档”可恢复或删除；删除需要确认且不可恢复 | [ChatGPT：删除与归档](https://help.openai.com/en/articles/8809935-how-do-i-delete-my-chatgpt-data) |
| 回收站 | Notion：删除进“垃圾桶”，默认保留 30 天，可搜索、按位置筛选、打开预览、恢复到原位置或永久删除 | [Notion：删除与恢复](https://www.notion.com/help/duplicate-delete-and-restore-content) |
| 删除去向可选 | Obsidian：删除的文件可去系统回收站 / 软件内 `.trash` / 直接永久删除，默认系统回收站 | [Obsidian：管理笔记](https://obsidian.md/help/manage-notes) |
| 分组 | 微信读书书架“编辑”可分组（像文件夹）；私密阅读 | [微信读书 56 条指南](https://mp.weixin.qq.com/s/dM2Abv_SWzQ--0y3XaORDw) |
| 重命名快捷键 | Obsidian：点标题或按 F2 重命名，引用自动更新 | [Obsidian：管理笔记](https://obsidian.md/help/manage-notes) |

反面例子：DeepSeek“已删除的对话无法恢复”、Kimi 帮助专门有一条“误删的聊天记录还能找回吗”——说明“误删”是高频问题。[DeepSeek（第三方整理）](https://bigolab.com/guides/2275-deepseek-export-delete-history)、[Kimi 常见问题](https://www.kimi.com/help/others)

**对我们的启发**：我们的世界数量不会多（个人玩家，几个到几十个），所以优先级是：**删除进回收站（30 天）> 改名 > 置顶 > 归档 > 搜索/排序 > 封面 > 批量**。搜索和批量在世界超过 10 个之前意义不大。“复制世界”（从当前进度分出一份独立存档）可以复用现有的“另存为新的世界”导入逻辑。

### 2.7 反馈与系统状态

- **提示条（snackbar）与撤销**：Compose 的 snackbar 默认短时显示，`Indefinite` 要等用户或程序关掉；`actionLabel` 用于“撤销”这类操作，典型例子是“删除邮件后提供撤销”；返回值区分用户点了操作还是自然消失。[安卓 Compose：Snackbar](https://developer.android.com/develop/ui/compose/components/snackbar)。系统不会同时显示多个 snackbar，后来的排队。[安卓 Views：Snackbar](https://developer.android.com/develop/ui/views/notifications/snackbar/showing)。常见经验值：短约 4 秒、长约 10 秒、只放一个操作、操作不写“关闭/取消”【待验证：M3 官方页本次未能抓取正文】。
- **确认框什么时候用、怎么写**：只给**高代价、不可逆**的操作用；日常操作滥用确认会“狼来了”；**能撤销就别确认**；文字要具体（写清对象名、数量），按钮用动作词（“删除文件 / 保留文件”）而不是“是 / 否”，最好没有默认“是”；极少数最危险的操作才要求输入文字确认。[NN/g：确认对话框](https://www.nngroup.com/articles/confirmation-dialog/)
- **加载**：1 秒以内不显示任何加载提示；2～10 秒用转圈，**整页加载用骨架屏**；超过 10 秒必须有进度条和预计时间；骨架屏只用于整页加载。[NN/g：骨架屏](https://www.nngroup.com/articles/skeleton-screens/)。安卓质量清单：启动超过 2 秒要有进度指示。[核心质量清单](https://developer.android.com/docs/quality-guidelines/core-app-quality)
- **空状态**：要说明系统状态（别让人分不清是在加载、出错还是真的没有）、**不要先显示“没有记录”再刷出内容**；给学习提示（“这里会出现什么、怎么让它出现”）；给直达按钮。[NN/g：空状态](https://www.nngroup.com/articles/empty-state-interface-design/)
- **离线与错误**：AI 产品常见“对话发送不出去 / 显示红圈”等状态（Kimi 帮助专门有一条）。[Kimi 常见问题](https://www.kimi.com/help/others)。错误页的基本形态是“发生了什么 + 你能做什么（重试 / 去设置）”。

**对我们的启发**：做一个统一的“提示条”组件替换现有 toast：支持一个操作按钮（撤销 / 去看看 / 重试），删除世界、删除书签、回到这里、彻底删除前的“移入回收站”都配“撤销”。做一个统一的“确认弹层”替换 `confirm()`，做一个“命名弹层”替换 `prompt()`（`NewGame.tsx` 存为我的开局），外观与宣纸风格一致、标题写对象名、按钮写动作词。离线时（`navigator.onLine` 或首个请求失败）在输入区上方显示一条细横幅“没有网络，连上后可以继续写”【待验证：安卓 WebView 中 `online/offline` 事件是否可靠】。

### 2.8 无障碍与舒适

- **触控目标至少 48dp；对比度小字 4.5:1、大字和图形 3:1；除纯文字外每个控件都要有可读名称。**[安卓核心质量清单](https://developer.android.com/docs/quality-guidelines/core-app-quality)。我们的 `--tap` 是 44px，略低于 48dp。
- **系统字号**：安卓 14 起系统字号可放大到 200%，大字用非线性放大；要在最大字号下测试布局。[安卓 14 新功能：非线性字体缩放](https://developer.android.com/about/versions/14/features#non-linear-font-scaling)。我们的界面文字多是写死的 px，WebView 是否跟随系统字号【待验证：Tauri 安卓 WebView 的 `textZoom` 设置】。
- **深浅主题**：所有内容在浅色和深色下都清晰可读。[核心质量清单 Theme_Support](https://developer.android.com/docs/quality-guidelines/core-app-quality)。Windows 建议主题选项含“跟随系统”。[Windows 设置指南](https://learn.microsoft.com/en-us/windows/apps/design/app-settings/guidelines-for-app-settings)
- **不只靠颜色传达信息**（必填、出错、成功要有图标或文字），色弱、单色屏都要能分辨。[WCAG 2.2：1.4.1 颜色使用](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
- **读屏**：豆包有一篇很具体的修复清单，可以直接当检查表用：按钮未加标签、“深度思考”开关不读出开/关状态、长按菜单弹出后**焦点能穿透到底下的列表**、“正在播报”时按钮应读“停止播报”、纯装饰图标应过滤焦点。[豆包 11.8.0 无障碍优化点](https://mp.weixin.qq.com/s/9xLEjIAnh68fqJo1DikAGQ)。Windows 清单：可访问名称、Tab 顺序、键盘激活、高对比主题、用“讲述人”实测。[Windows 无障碍检查清单](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-checklist)
- **触感**：少即是多；优先用系统预设的“确认”类触感，避免嗡嗡的长震；过度会让用户关掉所有触感。[安卓触感设计原则](https://developer.android.com/develop/ui/views/haptics/haptics-principles)。ChatGPT 设置里有“触感反馈”开关。[ChatGPT iOS 常见问题](https://help.openai.com/en/articles/7885016)
- **屏幕常亮**：微信读书“阅读时不锁屏”、番茄小说“锁屏时间 → 常亮”。[微信读书 56 条指南](https://mp.weixin.qq.com/s/dM2Abv_SWzQ--0y3XaORDw)、[番茄常亮教程](https://www.iefans.net/info/v1396856.html)。网页层可用 Screen Wake Lock API，页面隐藏时会被系统自动释放，回到前台要重新申请；建议显示是否生效并可关闭。[MDN：Screen Wake Lock API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)【待验证：Tauri 安卓 WebView 是否支持，否则要原生 `FLAG_KEEP_SCREEN_ON`】
- **语言**：安卓 13 起系统设置里有“按应用设置语言”。[安卓：按应用语言偏好](https://developer.android.com/guide/topics/resources/app-languages)。我们只服务中文玩家，**不需要多语言**；但可以考虑繁体【低优先级】。
- **声音**：Stardew 每类声音单独滑块（音乐、音效、环境、脚步）。[Stardew Wiki：Options](https://wiki.stardewvalley.net/Options)。我们现在没有任何声音，若以后加（翻页声、落印声），必须有总开关且默认关【建议】。

### 2.9 电脑端（Windows 版）

- **快捷键**：为最常用的操作设快捷键，并在提示气泡或菜单项里写出来（如“复制 (Ctrl+C)”“重命名 (F2)”）；常用约定：Ctrl+N 新建、Ctrl+F 查找、F2 重命名、Del 删除（可撤销）、Ctrl+Z/Ctrl+Y 撤销重做、Ctrl+加/减/0 缩放、F5 刷新、Ctrl+W 关闭、F6 切换窗格；右键菜单项的快捷键应限定在该区域内生效。[Windows：键盘快捷键](https://learn.microsoft.com/en-us/windows/apps/design/input/keyboard-accelerators)
- **快捷键一览**：Chatbox 在设置里有“键盘快捷键”页，并在帮助中心列表：Ctrl+N 新对话、Ctrl+K 搜索、Ctrl+I 聚焦输入框、回车发送 / Shift+回车换行、↑↓ 调出上一条输入、Alt+\` 显示/隐藏窗口。[Chatbox 键盘快捷键](https://chatboxai.app/zh/help-center/chatbox-keyboard-shortcuts)
- **右键菜单**：Notion 任何内容都能右键调出含“删除”的菜单。[Notion：删除与恢复](https://www.notion.com/help/duplicate-delete-and-restore-content)。我们目前把右键屏蔽了，电脑上要靠“按住鼠标”才能打开段落菜单。
- **记住窗口大小和位置**：Tauri 窗口状态插件，关闭时保存、下次启动恢复；建议窗口先隐藏、恢复后再显示，避免闪一下；只在桌面端初始化。[Tauri 窗口状态插件](https://v2.tauri.app/plugin/window-state/)
- **安装包 vs 便携版**：Tauri 的 NSIS 默认“仅当前用户”安装（不需要管理员、装到 `%LOCALAPPDATA%`）；WebView2 默认在线下载引导程序，也可内置离线安装包（约多 127MB）；可显示语言选择。[Tauri：Windows 安装包](https://v2.tauri.app/distribute/windows-installer/)。便携版（单个 exe、数据放旁边）Tauri 没有官方选项【待验证】。
- **文件关联**：Tauri `bundle.fileAssociations` 可注册扩展名，Windows 上 `description` 显示在资源管理器“类型”列；安卓也能生成对应 intent-filter。[Tauri 配置参考](https://v2.tauri.app/reference/config/)。可把 `.lishi.json` 关联到本 App，双击即导入【需要处理启动参数，待验证】。
- **托盘**：Tauri 支持托盘图标与菜单。[Tauri：系统托盘](https://v2.tauri.app/learn/system-tray/)。我们**不需要**托盘（没有后台任务要常驻）。
- **拖放导入、单实例、高 DPI**：把 `.lishi.json` 拖进窗口即导入、第二次打开时聚焦已有窗口（Tauri 有单实例插件）、高 DPI 下文字清晰，都是桌面 App 的常见期待【待验证：本次未查 Tauri 拖放事件与单实例插件文档；WebView2 本身按系统缩放渲染】。

### 2.10 信任细节

- **数据在哪、什么会离开这台设备**：Chatbox 写明“聊天记录不上传到我们的服务器；Key 本地存储；对话直接发送到 AI 服务提供商”。[Chatbox 数据存储](https://chatboxai.app/zh/guide/faq/data-storage)。工信部要求“建立已收集个人信息清单”，在二级菜单展示。[新华网：个人信息保护“双清单”](http://www.xinhuanet.com/techpro/20211109/a73cf95fe529484e80a34dc843c4d389/c.html)。我们可以做成反过来的“**不收集清单**”：本 App 不联网收集任何信息；只有两类网络请求——发给你配置的 AI 服务（含故事内容）、你点“检查更新”时访问 GitHub。
- **Key 怎么存**：Cherry Studio 提醒“备份里含 API Key，不要分享”。[Cherry Studio 数据设置](https://docs.cherryai.com.cn/pre-basic/settings/data-settings.md)。我们的导出文件不含 Key（Key 在系统密钥库里，不在数据库），这是优点，应该写出来让玩家放心：“导出的世界文件不含 Key，可以放心发给朋友”（已核对：`archive.ts` 只导出世界、回合、状态、世界线、要点、章节，不含 AI 服务配置；Key 在系统密钥库里）。
- **费用透明**：我们已有用量明细和按自填单价的费用估算，这在同类自带 Key 的产品里不多见；可以在设置首屏显示“本月约 ¥x”【建议】。
- **训练与隐私开关**：ChatGPT、DeepSeek 都有“数据用于改进模型”的开关。[ChatGPT 数据控制](https://help.openai.com/en/articles/7730893-data-controls-in-chatgpt)、[DeepSeek 隐私政策](https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html)。我们本身不收集数据，但可以在信任页提醒“你的故事会发给你选的 AI 服务商，它们是否用于训练取决于服务商政策”。

---

## 三、成熟 App 基本功清单（59 项）

图例：**我们** 列为代码检查结果；**成本** S＝半天以内、M＝一到三天、L＝一周左右或需要原生代码/真机。“国风建议”指在“宣纸书卷”风格下的落地方式，不是硬性设计。

### A. 设置

| # | 是什么 | 谁做得好 | 我们 | 为什么重要 | 成本 | 国风建议 |
|---|---|---|---|---|---|---|
| 1 | 设置分组成卡片（服务 / 阅读 / 游玩默认 / 数据 / 关于） | Windows 指南、Chatbox | 部分（只有小灰字标题） | 一眼看出“东西在哪”，是“像成品”的第一印象 | S | 每组一张宣纸卡，组名用小号宋体加朱砂短竖线 |
| 2 | 每项一句说明 + 显示当前值 | AOSP 指南、LibreTube | 部分（只有上下文一项有说明） | 玩家不必猜“这是干什么的” | S | 说明用浅墨小字，像书页的旁批 |
| 3 | 改了立即生效、无需“保存” | Windows 指南 | 有 | 已符合 | — | — |
| 4 | 阅读设置带实时预览 | 微信读书、我们 | 有 | 已符合，保留 | — | 预览改成一小段竖排或带印章的“样张” |
| 5 | 每组“恢复默认” | Stardew（恢复默认按键） | 没有 | 调乱了能回去，敢于尝试 | S | 组尾一行浅色文字链“恢复默认”，点后提示条带“撤销” |
| 6 | 主题“跟随系统” | Windows 指南、豆包 | 没有（只有纸张/白天/夜间） | 晚上系统切深色时自动跟上 | S | 第四档“随天色” |
| 7 | 行距 / 段距 / 页边距 | 微信读书、番茄 | 没有 | 长文阅读舒适度的主要来源 | S | 三档“疏 / 中 / 密” |
| 8 | 游玩默认值（新开局默认篇幅、选项数、视角） | Stardew“高级选项”与游戏选项分开 | 没有（每局在开局页设） | 不用每局重设；也厘清“全局 vs 本局” | M | 放“游玩默认”卡，开局页注明“来自默认，可改” |
| 9 | 高级 / 开发者选项收起 | AOSP 指南 | 部分（复选框在页中） | 普通玩家不被工程信息打扰 | S | 移到“关于”底部，连点版本号打开 |
| 10 | 设置搜索 | 安卓系统设置 | 没有 | 我们不到 20 项，**不需要** | — | 不做 |

### B. App 基础

| # | 是什么 | 谁做得好 | 我们 | 为什么重要 | 成本 | 国风建议 |
|---|---|---|---|---|---|---|
| 11 | 关于页：图标、名称、版本、构建日期 | Windows 指南、ChatGPT、豆包 | 没有（界面无版本号） | 报问题第一句就是“什么版本” | S | 印章图标 + “历史穿越 · 〇.八.〇” 双写，下附公历日期 |
| 12 | 版本号可一键复制 | Obsidian 用户期待 | 没有 | 发反馈省事 | S | 长按版本号复制，提示“已誊抄” |
| 13 | 开源许可列表 | Windows 指南 | 没有 | 公开分发的基本义务 | M（要生成清单） | 子页按依赖名列表，正文用等宽小字 |
| 14 | 隐私与数据说明（不收集清单） | Chatbox、工信部双清单 | 部分（首次连接页一句话） | 让人放心，也回答“数据在哪” | S | 一页“本 App 的约定”，三条朱砂编号 |
| 15 | 更新后“这一版新东西” | Chatbox 更新日志 | 没有 | 让玩家知道新功能，减少“没发现” | S | 版本变化后首屏弹一张“新刊”卡，3～5 条 |
| 16 | 关于页里的更新日志 | Chatbox、Obsidian | 没有 | 随时回看 | S | 按版本列，像书的“再版记” |
| 17 | 手动“检查更新”（安卓：GitHub 发布） | LibreTube、豆包 | 没有 | 侧载用户没有应用商店提醒 | M | 结果卡显示新版号与说明，按钮“去下载” |
| 18 | 自动检查更新开关（默认关或首次询问） | LibreTube、Obsidian | 没有 | 不打扰、不偷偷联网 | S | 开关副标题写明“只访问 GitHub，不发送内容” |
| 19 | Windows 应用内更新（Tauri updater，签名） | Tauri、Obsidian | 没有 | 电脑端一键升级 | M～L（签名私钥管理） | 下载进度用卷轴展开动效 |
| 20 | 复制诊断信息（脱敏） | Obsidian“显示调试信息” | 没有（开发者模式只有调用记录） | 远程排查唯一的线索 | M | “誊抄诊断”按钮，内容先预览再复制 |
| 21 | 反馈入口（GitHub Issues / 复制给作者） | 番茄、豆包、Kimi | 没有 | 让问题能回到作者手里 | S | “递个条子”，附诊断勾选 |
| 22 | 帮助 / 游玩指南入口 | Kimi 帮助中心、Chatbox 指南 | 没有（只有开局页随机小贴士） | 想深入时有地方学（方向 B） | M（内容为主） | 做成一本“穿越须知”小册，按章翻 |
| 23 | 常见问题（连不上、费用、存档、换机、误删） | Kimi、Chatbox | 没有 | 自助解决最常见问题 | S（写作） | 问答体，问句用朱砂 |
| 24 | 分享 App（发给朋友的文字或链接） | 各类 App | 没有 | 个人项目可低优先 | S | 生成一张“荐书笺” |

### C. 首次使用与权限

| # | 是什么 | 谁做得好 | 我们 | 为什么重要 | 成本 | 国风建议 |
|---|---|---|---|---|---|---|
| 25 | 欢迎页（1～2 屏，可跳过） | 主流 App | 部分（空首页 + 直接进连接页） | 第一眼知道这是什么、要准备什么 | S | 卷轴展开 + 一句题记，右上“跳过” |
| 26 | 权限先解释、只问一次、可拒绝 | 安卓指南、网信办 | 有（通知） | 已符合 | — | 说明卡用书信体 |
| 27 | 无 AI 服务时的示范内容 | NN/g（示例数据） | 没有 | 先看到产品价值再配置 | M | 一段预置开场 + “想接着写，先连接笔墨（AI 服务）” |
| 28 | 连接服务的分步引导与常见错误说明 | Chatbox | 部分（有预设、测试、错误解释） | 最容易流失的一步 | M | 三步“备纸、研墨、落笔” |

### D. 数据管理

| # | 是什么 | 谁做得好 | 我们 | 为什么重要 | 成本 | 国风建议 |
|---|---|---|---|---|---|---|
| 29 | 说明数据存在哪（路径可复制 / 打开文件夹） | Chatbox | 没有 | 换机、备份、排查都要知道 | S | “存档所在”一行，电脑端加“打开” |
| 30 | 存储占用 | 安卓系统设置、Cherry | 没有 | 长局会变大，玩家会好奇 | S | “卷帙”大小：数据库、备份各多少 |
| 31 | 备份列表可见 | Cherry Studio | 没有（每天在做但看不见） | 已有的安全网要让人看见 | S | 按日期列，像“藏本目录” |
| 32 | 从备份恢复（恢复前先备份当前） | Obsidian 快照、Cherry | 没有 | 出事时唯一的后悔药 | M | 二次确认写清“将回到某日某时” |
| 33 | 立即备份 | Cherry、Stardew“保存备份” | 没有 | 大改动前手动留底 | S | “封存一份” |
| 34 | 备份到用户选择的目录 / 保留份数可调 | Cherry Studio | 没有（R08-T001 遗留） | 卸载或清数据时不一起丢 | L（安卓系统选择器） | — |
| 35 | 导出 / 导入单个世界 | Chatbox | 有 | 已符合 | — | — |
| 36 | 导出全部（一键打包所有世界） | ChatGPT、DeepSeek | 没有 | 换机一次搞定 | M | — |
| 37 | 换设备指引（手机 ↔ 电脑） | Chatbox、Stardew | 部分（能导，没有说明） | 我们两端都有，这是独特卖点 | S（写说明） | 帮助里一页“搬家” |

### E. 书架与内容管理

| # | 是什么 | 谁做得好 | 我们 | 为什么重要 | 成本 | 国风建议 |
|---|---|---|---|---|---|---|
| 38 | 世界回收站（保留 30 天，可恢复） | Notion、Obsidian | 没有（删除即永久） | 误删是 AI 产品高频问题 | M | “废纸篓”放首页底部，标注“还剩 N 天” |
| 39 | 世界改名 | DeepSeek、Chatbox、Obsidian F2 | 没有 | 名字是“这是我的故事”的标志 | S | 命名弹层，题签式输入框 |
| 40 | 置顶 / 收藏 | DeepSeek、Chatbox 星标 | 没有 | 常玩的放上面 | S | 卡角一枚小朱印 |
| 41 | 归档（不显示但保留） | ChatGPT | 部分（数据库 `worlds.archived` 列已有、首页已过滤，但没有任何界面能归档或查看已归档） | 玩完的故事收起来，首页清爽 | S | “束之高阁”分区，可展开 |
| 42 | 复制世界（从当前进度分一份） | Chatbox“复制整个对话” | 部分（只有“用同样设定再开一局”） | 想试另一种走法又不想用世界线时 | S～M | — |
| 43 | 排序与搜索 | Chatbox、DeepSeek | 没有（固定按最近） | 十个以上世界才需要 | S | 世界 ≥ 8 个时才出现搜索框 |
| 44 | 封面 | 微信读书书架 | 没有 | 书架的“书”感 | M | 按朝代自动生成题签封面（色块 + 书名竖排），不需要图片 |
| 45 | “我的开局”可改名 / 删除 | — | 没有（只能存，不能删） | 存过就删不掉，会越积越多 | S | 长按菜单 |

### F. 反馈与系统状态

| # | 是什么 | 谁做得好 | 我们 | 为什么重要 | 成本 | 国风建议 |
|---|---|---|---|---|---|---|
| 46 | 可撤销的提示条（一个操作按钮） | 安卓 Snackbar、Gmail | 没有（toast 无操作） | 用撤销代替大部分确认框（NN/g） | M | 底部细长纸条，右侧朱砂字“撤销” |
| 47 | 统一风格的确认弹层（替换 `confirm()`） | NN/g 写法 | 没有（浏览器原生框） | 原生框是最明显的“不像成品” | S～M | 标题写对象名，按钮“删除这个世界 / 留着” |
| 48 | 统一的命名弹层（替换 `prompt()`） | — | 没有 | 同上 | S | — |
| 49 | 整页加载骨架 / 超过 10 秒的进度 | NN/g | 部分（“正在读取…”文字、开局阶段文字） | 慢的时候不慌 | S～M | 骨架用淡墨横线，像未干的字迹 |
| 50 | 离线横幅与错误重试 | Kimi 帮助 | 部分（配置错误有“去设置”） | 地铁里断网很常见 | S | 输入区上方一条浅色横幅 |

### G. 无障碍、舒适与电脑端

| # | 是什么 | 谁做得好 | 我们 | 为什么重要 | 成本 | 国风建议 |
|---|---|---|---|---|---|---|
| 51 | 读屏完整（标签、开关状态、弹层焦点锁定） | 豆包修复清单、Windows 清单 | 部分（51 处标签，弹层不锁焦点） | 也让自动化测试更稳 | M | — |
| 52 | 触控目标 48dp、对比度 4.5:1、不只靠颜色 | 安卓质量清单、WCAG | 部分（44px；对比度【待验证】） | 老人与户外强光下可用 | S～M | 朱砂色作强调时配文字或图标 |
| 53 | 跟随系统字号 / 界面字号 | 安卓 14、豆包字号 | 部分（只有正文四档） | 大字用户 | M【待验证】 | — |
| 54 | 阅读时屏幕常亮（开关） | 微信读书、番茄 | 没有 | 长段阅读不被锁屏打断 | S～M【待验证】 | 阅读卡里一项“掌灯不熄” |
| 55 | 触感开关 | ChatGPT | 没有（长按固定震动） | 有人讨厌震动 | S | — |
| 56 | 电脑快捷键 + 一览页 | Chatbox、Windows 指南 | 部分（回车、Esc） | 电脑上效率与“专业感” | M | 一览页用两栏“键 · 用途” |
| 57 | 右键菜单（与长按菜单相同） | Notion | 没有（右键被屏蔽） | 电脑用户第一反应就是右键 | S | — |
| 58 | 记住窗口大小位置 | Tauri 插件 | 没有 | 每次打开都要拖窗口很烦 | S | — |
| 59 | 拖放 / 双击 `.lishi.json` 导入 | Tauri 文件关联 | 没有 | 电脑上最自然的导入方式 | M【待验证】 | — |

> 共 59 项（其中 3、4、26、35 已具备，10 建议不做），实际待做约 54 项。

---

## 四、逐屏完整性检查表（通用）

给评审者对任意一个屏幕、列表、表单逐条问。每条答“是 / 否 / 不适用”，“否”就记一个问题。依据见上文第二节对应小节。

### 4.1 每个屏幕

1. **我在哪**：标题说清这是什么页面？从哪里来的、怎么回去一眼可见？
2. **返回**：安卓返回键 / 手势、电脑 Esc 是否一致——先关浮层、再退一页、首页不误退？（[核心质量清单 Back_Button_Nav](https://developer.android.com/docs/quality-guidelines/core-app-quality)）
3. **离开再回来**：切到后台、锁屏、被系统杀掉后回来，是否回到原处、输入没丢？（[核心质量清单 State_Preservation](https://developer.android.com/docs/quality-guidelines/core-app-quality)）
4. **四种状态都设计过**：加载中、空、出错、正常；加载超过 1 秒才显示提示、超过 10 秒有进度；不会先闪“没有内容”再刷出内容？（[NN/g 骨架屏](https://www.nngroup.com/articles/skeleton-screens/)、[NN/g 空状态](https://www.nngroup.com/articles/empty-state-interface-design/)）
5. **空状态有下一步**：解释这里会出现什么、怎么让它出现，并有直达按钮？
6. **出错有出路**：说清发生了什么（玩家语言，不是错误码），给“重试”或“去设置”？
7. **断网**：没网时这个页面会怎样？有提示吗？
8. **玩家语言**：没有工程词（token、node、slot 等只在开发者模式出现）？（[PLAN_V3 第 4.12 节](../PLAN_V3.md)）
9. **主题与字号**：三种主题、最大字号下都清楚可读、不溢出、不截断？
10. **手机与宽屏**：360px 宽和电脑宽屏下都不难看？
11. **读屏与键盘**：每个图标按钮有名称、开关读出状态；弹层打开时焦点进入弹层、关闭后回到原处；Tab 顺序合理？（[Windows 无障碍清单](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-checklist)、[豆包修复清单](https://mp.weixin.qq.com/s/9xLEjIAnh68fqJo1DikAGQ)）
12. **点得到**：可点区域 ≥ 48dp，相邻危险按钮不挨着常用按钮？
13. **不只靠颜色**：选中、出错、危险都有文字或图标？（[WCAG 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)）
14. **入口可发现**：这个页面的主要功能，新玩家不看说明能找到吗？隐藏在长按里的功能有没有第二个可见入口？
15. **帮助就近**：有需要解释的概念时，旁边有“？”或一句说明？

### 4.2 每个列表

1. **新建**：从哪里新建？空列表时新建入口是否最显眼？
2. **命名**：新建时有合理的默认名？能改名？名字太长怎么显示？重名怎么办？
3. **复制**：需要“复制一份”吗？
4. **删除**：删除入口在哪？是进回收站还是永久？永久删除是否有具体的确认（写对象名、按钮写动作）？
5. **撤销 / 恢复**：删除后有提示条“撤销”吗？有回收站吗？保留多久？
6. **排序**：默认按什么排？玩家能改吗？能手动置顶 / 拖动排序吗？
7. **查找**：条目多（> 10）时能搜索或筛选吗？搜索无结果时说什么？
8. **分组 / 归档**：用完的条目能收起来而不删除吗？
9. **批量**：会不会需要一次处理多个？（多数列表不需要，答“不适用”即可）
10. **每项信息**：每张卡片显示的信息够判断“这是哪一个”吗（名称、时间、进度、状态）？
11. **长列表性能**：上百条时滚动是否流畅？
12. **电脑端**：右键菜单与长按菜单一致？F2 改名、Del 删除？

### 4.3 每个表单 / 编辑页

1. **默认值**：每项有合理默认？默认值从哪来（全局设置 / 上次填写）清楚吗？
2. **说明**：每项有一句说明或占位示例？必填项标清楚？
3. **校验**：错了是边填边提示还是提交才提示？错误写在出错的那一项旁边？
4. **草稿**：中途离开再回来，填的内容还在吗？
5. **放弃改动**：有未保存改动时返回，是否提醒（或自动保存）？
6. **恢复默认**：能一键回到默认吗？
7. **保存反馈**：保存后有明确反馈？保存失败说原因？
8. **键盘**：手机上弹出的键盘类型对吗（数字、文本）？键盘不遮挡输入框？电脑上回车 / Ctrl+回车的行为一致且有提示？
9. **长文本**：多行输入能看到字数或长度限制吗？
10. **危险项**：会覆盖已有内容的操作，是否写清后果并可撤销？

### 4.4 每个危险操作

1. 能不能改成**可撤销**而不是确认？（[NN/g](https://www.nngroup.com/articles/confirmation-dialog/)）
2. 确认文字是否**具体**：对象名、影响范围（“只属于它的 12 个回合会一起删掉”）？
3. 按钮是动作词（“删除这个世界 / 留着”），没有默认选中“删除”？
4. 危险按钮颜色与位置与常用按钮分开？
5. 做完之后的提示里有没有“撤销”或“去回收站找回”？

---

## 五、建议的落地顺序（候选，待用户同意）

按“玩家最常碰到、成本最低”排序，供拆成 PLAN_V4 方向 K、L 的小计划时参考：

1. **系统交互三件套**（#46、#47、#48）：可撤销提示条、确认弹层、命名弹层。全 App 受益，替掉最显眼的“浏览器原生框”。约 1～2 天。
2. **设置页重排 + 关于页**（#1、#2、#5、#6、#9、#11、#12、#14、#16）：分组卡片、说明、恢复默认、跟随系统、关于（版本可复制、更新日志、数据约定），开发者模式收进关于。约 1～2 天。
3. **书架管理**（#38、#39、#40、#41、#45）：回收站、改名、置顶、归档、“我的开局”管理。约 2 天。
4. **数据与备份页**（#29～#33、#36、#37）：数据在哪、占用、备份列表与恢复、立即备份、导出全部、搬家说明。约 2 天。
5. **更新与反馈**（#17、#18、#20、#21、#15）：检查 GitHub 发布、诊断信息、反馈入口、新版本卡片。约 2 天；Windows 内置更新（#19）待签名方案定后另做。
6. **帮助与首次使用**（#22、#23、#25、#27）：与方向 A、B 合并。
7. **电脑端细节**（#56～#59）、**无障碍与舒适**（#51～#55）：与方向 E、H 合并，部分需要真机验证。

---

## 六、本次没有查到或未能核实的内容

- **Material Design 3 官方页**（snackbar、dialog、accessibility）本次抓取只返回标题，正文未读到；文中 snackbar 的“4 秒 / 10 秒、只放一个操作”等经验值标【待验证】，主要依据改用安卓开发者文档和 NN/g。
- **inkle（80 Days 等）、人生重开模拟器**的设置菜单细节没有查到可靠来源（Family Gaming Database 返回 403）。人生重开模拟器是 MIT 许可的网页游戏，[仓库](https://github.com/vickscarlet/liferestart)可见，但设置与存档细节未核实。
- **Bear、印象笔记、墨问、Claude App** 本次未查，相关结论未引用。
- **国内 App 的具体界面**（番茄小说、豆包、Kimi、DeepSeek App）多来自第三方教程或用户文章，可能对应旧版本，均应以现行版本为准。
- **平台能力**：Tauri 安卓 WebView 是否支持 Screen Wake Lock、是否跟随系统字号、`online/offline` 事件是否可靠、Tauri 拖放与单实例插件、便携版打包、文件关联在 Windows 上的启动参数处理，都需要实测。
- **仓库状态**：D127 之后仓库是否公开、未登录能否读取 Releases，影响 #17 的实现方式。

---

## 来源一览（查阅日期均为 2026-10-17）

**平台规范**

- 安卓核心应用质量清单 https://developer.android.com/docs/quality-guidelines/core-app-quality
- AOSP 设置设计指南 https://source.android.com/docs/core/settings/settings-guidelines
- 安卓：请求运行时权限 https://developer.android.com/training/permissions/requesting
- 安卓 Compose：Snackbar https://developer.android.com/develop/ui/compose/components/snackbar
- 安卓 Views：Snackbar https://developer.android.com/develop/ui/views/notifications/snackbar/showing
- 安卓 14 新功能（非线性字体缩放） https://developer.android.com/about/versions/14/features#non-linear-font-scaling
- 安卓触感设计原则 https://developer.android.com/develop/ui/views/haptics/haptics-principles
- 安卓自动备份 https://developer.android.com/identity/data/autobackup
- 安卓按应用语言偏好 https://developer.android.com/guide/topics/resources/app-languages
- Windows 应用设置指南 https://learn.microsoft.com/en-us/windows/apps/design/app-settings/guidelines-for-app-settings
- Windows 键盘快捷键 https://learn.microsoft.com/en-us/windows/apps/design/input/keyboard-accelerators
- Windows 无障碍检查清单 https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-checklist
- WCAG 2.2 理解 1.4.1 颜色使用 https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
- MDN：Screen Wake Lock API https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API

**交互研究**

- NN/g：确认对话框 https://www.nngroup.com/articles/confirmation-dialog/
- NN/g：空状态设计 https://www.nngroup.com/articles/empty-state-interface-design/
- NN/g：骨架屏 https://www.nngroup.com/articles/skeleton-screens/

**Tauri 与 GitHub**

- Tauri 更新插件 https://v2.tauri.app/plugin/updater/
- Tauri 窗口状态插件 https://v2.tauri.app/plugin/window-state/
- Tauri Windows 安装包 https://v2.tauri.app/distribute/windows-installer/
- Tauri 系统托盘 https://v2.tauri.app/learn/system-tray/
- Tauri 配置参考（fileAssociations） https://v2.tauri.app/reference/config/
- GitHub REST：获取最新发布 https://docs.github.com/en/rest/releases/releases#get-the-latest-release
- GitHub REST：速率限制 https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- LibreTube 提交 d68b53e https://github.com/libre-tube/LibreTube/commit/d68b53ed661768e0a1651bfcc8ac35088f2a7faa
- Butterfly issue #691 https://github.com/LinwoodDev/Butterfly/issues/691
- Obtainium Wiki https://wiki.obtainium.imranr.dev/app_tracking/

**笔记与写作类**

- Obsidian 文件恢复 https://obsidian.md/help/plugins/file-recovery
- Obsidian 管理笔记 https://obsidian.md/help/manage-notes
- Obsidian 帮助与支持（调试信息） https://obsidian.md/help/resources
- Obsidian 更新 https://obsidian.md/help/updates
- Obsidian 论坛：复制版本号 https://forum.obsidian.md/t/allow-to-copy-obsidian-version-in-settings/76351
- Obsidian 论坛：调试信息示例 https://forum.obsidian.md/t/links-not-updating/89004
- Notion：删除与恢复 https://www.notion.com/help/duplicate-delete-and-restore-content

**AI 应用**

- Cherry Studio 数据设置 https://docs.cherryai.com.cn/pre-basic/settings/data-settings.md
- Chatbox 数据存储 https://chatboxai.app/zh/guide/faq/data-storage
- Chatbox 键盘快捷键 https://chatboxai.app/zh/help-center/chatbox-keyboard-shortcuts
- Chatbox 界面介绍 https://chatboxai.app/zh/guide/getting-started/interface-overview
- Chatbox 更新日志 https://chatboxai.app/zh/help-center/changelog
- ChatGPT 数据控制 https://help.openai.com/en/articles/7730893-data-controls-in-chatgpt
- ChatGPT 删除与归档 https://help.openai.com/en/articles/8809935-how-do-i-delete-my-chatgpt-data
- ChatGPT iOS 常见问题 https://help.openai.com/en/articles/7885016
- DeepSeek 隐私政策 https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html
- DeepSeek 导出、删除与注销（第三方整理） https://bigolab.com/guides/2275-deepseek-export-delete-history
- Kimi 常见问题 https://www.kimi.com/help/others
- Kimi 新手入门 https://www.kimi.com/help/new-user-guide/overview
- 豆包 11.8.0 无障碍优化点（用户文章） https://mp.weixin.qq.com/s/9xLEjIAnh68fqJo1DikAGQ
- 豆包清理缓存（问答站） https://ask.faxianai.com/2522

**阅读与游戏**

- 微信读书帮助：背景和字体 https://weread.qq.com/wrpage/app/help/detail/qReadingBgAndFront
- 微信读书 56 条阅读指南（用户文章） https://mp.weixin.qq.com/s/dM2Abv_SWzQ--0y3XaORDw
- 番茄小说阅读设置指南（第三方） https://fanqiepc.ijinshan.com/pages/guides/reading-settings/index.html
- 番茄小说屏幕常亮（第三方） https://www.iefans.net/info/v1396856.html
- 番茄小说清除缓存、反馈（第三方） https://www.qipou.com/fanqiexiaoshuo/page/10/
- Stardew Valley Wiki：Options https://wiki.stardewvalley.net/Options
- Stardew Valley Wiki：Mobile Saves https://wiki.stardewvalley.net/Mobile_Saves
- 人生重开模拟器仓库 https://github.com/vickscarlet/liferestart

**国内法规与监管**

- 网信办等《App 违法违规收集使用个人信息行为认定方法》 https://www.cac.gov.cn/2019-12/27/c_1578986455686625.htm
- 网信办：App 申请和使用权限要注意哪几点 https://www.cac.gov.cn/2019-08/17/c_1124885929.htm
- 工信部《关于进一步提升移动互联网应用服务能力的通知》（2023） https://www.miit.gov.cn/jgsj/xgj/APPqhyhqyzxzzxd/tzgg/art/2023/art_be5c5d0782af4300a4cdcbc10a60f202.html
- 新华网：个人信息保护“双清单” http://www.xinhuanet.com/techpro/20211109/a73cf95fe529484e80a34dc843c4d389/c.html
