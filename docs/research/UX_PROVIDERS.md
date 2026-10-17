# AI 客户端的服务与模型管理调研

> 调研日期：2026-10-17（Asia/Shanghai），由调研子代理完成，服务于 [PLAN_V4](../PLAN_V4.md) 方向 J。**本文所有来源的查阅日期均为 2026-10-17**，下文不再逐条重复。
>
> 范围：成熟 AI 客户端在“连接服务、管理模型”这一块是怎么做的，以及我们的“AI 服务”页差在哪里。对照对象是 [Setup.tsx](../../src/ui/screens/Setup.tsx)、[Settings.tsx](../../src/ui/screens/Settings.tsx)、[providers.ts](../../src/engine/llm/providers.ts) 在 2026-10-17 的代码（提交 `1c6ae1b`）。
>
> 来源说明：官方文档、GitHub 源码（界面文案文件）、PR 与 issue 优先；第三方接入教程（中转站写的 OpenCat、Cherry Studio 配置指南）只用来佐证界面行为，标为“第三方”。拿不到原文、只能推断的，标【待验证】。LobeHub 官方文档站正在迁移，provider 文档页是空壳，所以 LobeHub 的界面细节取自它的界面文案源文件（locale 文件），这比文档更接近实际界面。

## 结论先说

1. **成熟客户端都把“填 Key → 拿到模型 → 选一个 → 测一下”做成一条顺路的流水线**，而不是四个并列的控件。Msty、OpenCat、BotGem 在保存服务后自动列出模型；Cherry Studio、LobeHub 有醒目的“获取模型列表”并显示“上次更新时间”；Open WebUI 在验证连接时就顺带拉 `/models`。我们的“获取模型列表”按钮和模型输入框并排摆着，没人告诉玩家“点一下就能选”，这是用户已经指出的第一个缺口。
2. **服务是“玩家自己起名的条目”，不是“某个服务商”**。Chatbox、Msty、OpenCat、LobeHub、Cherry Studio 添加自定义服务时第一项都是“名称”；Msty 和 Cherry 还能改图标、改模型显示名。我们的服务名直接取预设名，两个自定义服务都叫“自定义”，无法区分。
3. **Key 周边有三件小事几乎人人都做**：申请 Key 的直达链接（LobeHub 的“点这里获取”、Msty 按服务商整理的 Key/用量/价格三链接表）、余额查询（NextChat 的“账户余额”、RikkaHub 和 Kelivo 的余额查询）、显示/隐藏。我们一件都没有。
4. **模型不只是一个字符串**。大家都给模型挂上能力标签（推理、视觉、工具）、上下文长度、价格（Cherry 可按模型填人民币或美元的百万 token 价格），列表能搜索、能收藏、能隐藏不用的。OpenRouter 的 `/models` 直接返回上下文长度和价格，可以白拿。
5. **“一个服务一个模型”之外，成熟产品普遍有“分工”**：Cherry 的“默认模型”分对话、快速（命名等轻任务）、翻译；Open WebUI 的“任务模型”专管标题、摘要等后台调用，文档明说“把后台工作指向小而快的模型是管理员能做的性价比最高的改动”。我们已有“辅助模型”，但藏在“高级”里、要手填、不会自动推荐。
6. **备用服务和多 Key 轮换是“高级用户”功能**，Cherry 官方甚至明确拒绝做失败自动换 Key（认为是网关的事）。对我们这种单人使用的游戏，优先级低于前面几条；但“出错时一键换个服务重试”是游戏特有的高价值点。
7. **新手引导的共同思路是“先让一个模型成功回答一句话，再谈其他”**（Cherry 手机版快速开始原话）。Chatbox 首屏就分“我是新手（推荐）/跳过”；Msty 首屏三选一（本地模型 / 远程服务 / 已有 Ollama）。国内有可以零成本起步的选项（智谱 Flash 系列免费、硅基流动注册赠金），是我们新手路径可以直接利用的。

---

## 1. 各产品逐项观察

### 1.1 Cherry Studio（桌面 + 手机版，国内最主流的开源客户端之一）

**服务列表与添加**
- 内置 60 多家服务商模板，按协议分为 OpenAI 兼容、Anthropic 兼容、Gemini、Bedrock、Azure、本地推理、特殊网关几类；文档另有一张“一句话选择指南”（新手→CherryIN/CherryAI；高性价比→DeepSeek/Kimi/智谱；一个 Key 用 200+ 模型→OpenRouter；完全本地→Ollama/LM Studio）。来源：[模型服务](https://docs.cherryai.com.cn/pre-basic/providers)、[All Providers Quick Reference](https://cherryai.com/docs/en/pre-basic/providers/quick-reference/)
- 自定义服务商：设置 → 模型服务 → “+ 添加服务商”，填名称（如“MyCustomOpenAI”）、类型（OpenAI / Anthropic，更多设置里还有 Responses、Gemini 等），可以“从预设创建”，用于“多账号或项目隔离”——也就是**同一家服务商可以建多个实例**。启用的服务商旁边显示绿点，右上角有启用开关。来源：[自定义服务商](https://docs.cherryai.com.cn/pre-basic/providers/zi-ding-yi-fu-wu-shang.md)
- 文档用红色警告强调：配好后“务必打开服务商右上角的启用开关，否则……模型不会出现在模型选择列表里”。这说明“启用开关”本身是一个常见的踩坑点，我们不该照抄。来源：[模型服务设置](https://docs.cherryai.com.cn/pre-basic/providers/providers)

**Key**
- 一个服务商可填多个 Key，用英文逗号分隔，按列表从前到后轮询；Key 输入框右侧的钥匙图标进入“API 密钥管理”，每个 Key 可编辑标签、启用/禁用、复制、删除。文档特别提醒“必须使用英文逗号”。来源：同上
- 轮询只是“每次调用取下一个”，**报错不会自动换 Key**；开发者在 issue 里说“Retry 更像是一个网关该干的事……Fallbacks、Timeouts、Cooldowns、Routing……会是一个比较大的坑”，“应该不会继续深入去做”。来源：[issue #563](https://github.com/CherryHQ/cherry-studio/issues/563)
- 文档开头就解释“密钥、Key、API Key、令牌，指的都是同一个东西”。手机版快速开始提醒“不要把平台登录密码当作 API Key”“聊天会员不一定包含开放接口额度”。来源：[模型服务设置](https://docs.cherryai.com.cn/pre-basic/providers/providers)、[手机版快速开始](https://cherryai.com.cn/docs/zh-cn/mobile/quick-start/)

**地址**
- 只填根地址 `https://xxx.com`，自动补 `/v1/chat/completions`；路径不标准时“填完整地址并以 `#` 结尾”，不再拼接。第三方整理的规则更细：以 `/` 结尾只拼 `chat/completions`，以 `#` 结尾不拼接。来源：[模型服务设置](https://docs.cherryai.com.cn/pre-basic/providers/providers)、[矛·盾知识库（第三方）](https://arch3rpro.github.io/software/cherrystudio/providers)
- 这套 `/`、`#` 规则对普通玩家是“暗号”，我们已有的“根地址自动补 `/v1`、完整地址原样用”（[chat.ts](../../src/engine/llm/chat.ts) 的 `chatCompletionsUrl`）更友好，不必学。

**模型**
- 点“获取模型列表”弹出“模型管理”，逐个点 `+` 加入；“只有加入列表的模型才会出现在各处的模型选择器里”。名称下方显示服务商返回的真实模型 ID，提醒“添加前先核对这行 ID”。来源：[模型服务设置](https://docs.cherryai.com.cn/pre-basic/providers/providers)
- 手机版模型编辑页字段：显示名称、分组、备注、模型 ID（创建后不可改）、模型类型、接口、推理、工具调用、支持的输入、流式输出；上下文窗口 / 最大输入 / 最大输出（“把数值调大不会突破服务商限制，反而可能让请求被拒绝”）；价格（美元或人民币、每百万 token、缓存读写价、阶梯价，“未知价格和免费不同，`0` 表示明确的零价格”）。长按模型可多选删除。来源：[添加、编辑与管理模型（手机版）](https://cherryai.com.cn/docs/zh-cn/mobile/model-management/)
- 按模型设置输入/输出价格和币种，并在消息的 token 用量旁显示价格（2025-06 合入）。来源：[PR #3125](https://github.com/CherryHQ/cherry-studio/pull/3125)

**测试**
- “检测”按钮选一个模型测试，多 Key 时可选用哪个 Key；另有一键“健康检查”，并发检查服务商下所有模型，显示每个模型的连通性和延迟。来源：[模型服务设置](https://docs.cherryai.com.cn/pre-basic/providers/providers)、[PR #2613](https://github.com/CherryHQ/cherry-studio/pull/2613)

**分工**
- “默认模型”四项：默认助手模型（兜底）、快速模型（对话命名、搜索关键字提炼等轻任务，“建议便宜快速”“不建议选思考模型”）、翻译模型、绘画模型；“不确定时全部保持默认”。来源：[默认模型](https://docs.cherryai.com.cn/pre-basic/settings/default-models.md)

**导入**
- URL Scheme 一键导入：`cherrystudio://providers/api-keys?v=1&data=<base64 的 JSON>`，JSON 含 `id`、`baseUrl`、`apiKey`、可选 `name`、`type`；打开后 Cherry 弹出确认框，用户核对后才添加。中转站控制台（New API、DimiLinks 等）普遍提供“导入到 Cherry Studio”按钮。来源：[PR #7529](https://github.com/CherryHQ/cherry-studio/pull/7529)、[providersImport.ts](https://github.com/CherryHQ/cherry-studio/blob/d498753e/src/main/services/protocol/handlers/providersImport.ts)、[OcHub 文档（第三方）](https://docs.ochub.org/cherry-studio/)
- 手机版可“从电脑导入配置”，选择要带到手机的服务商和模型（导入方式的具体形式未查到原文【待验证】）。来源：[手机版快速开始](https://cherryai.com.cn/docs/zh-cn/mobile/quick-start/)

### 1.2 LobeChat / LobeHub

以下取自界面文案源文件 [modelProvider.ts（v2.1.26）](https://cdn.jsdelivr.net/npm/@lobehub/lobehub@2.1.26/src/locales/default/modelProvider.ts)，括号内是原文 key。

- **服务列表**：分“已启用 / 已禁用 / 自定义未启用”三组（`menu.list.*`），可搜索服务商（“Search Providers...”），可自定义排序或按字母排序（`menu.sort`、`sortModal.*`）。
- **创建自定义服务商**（`createNewAiProvider.*`）：分“基本信息”和“配置信息”两段；字段有服务商 ID（“创建后不可修改”，只允许小写字母、数字、`-`、`_`）、名称、描述（可选）、Logo、请求格式（openai/anthropic/azureai/ollama…）、代理地址、API Key。之后可以“更新服务商基本配置”（`updateAiProvider.tooltip`），即**名称可改、ID 不可改**。
- **Key**：说明文字带链接“请输入你的 {{name}} API Key。<点这里获取>”（`providerModels.config.apiKey.descWithUrl`）；“你的 Key 和代理地址会用 AES-GCM 加密”（`config.aesGcm`）。
- **地址**：标题叫“API 代理地址”，提示“必须包含 http(s)://”，校验“请输入有效的 URL”，占位符 `https://your-proxy-url.com/v1`。
- **连通性检查**：“检查”按钮，说明“测试 API Key 与代理地址是否填写正确”，成功显示“检查通过”。
- **模型列表**（`providerModels.list.*`）：分“已启用 / 已禁用”，可“全部启用 / 全部禁用”、搜索（“Search Models...”，显示“找到 {{count}} 个模型”）、按发布时间或字母排序；“获取模型列表”按钮旁显示“上次更新：{{time}}”或“尚未获取模型列表”，可“清除已获取的模型”；按类型分页签（全部 / 对话 / 嵌入 / 图像 / 语音）。
- **单个模型**：显示价格（“输入 ${{amount}}/M”“输出 ${{amount}}/M”）和发布日期；自定义模型可设模型 ID、显示名称、部署名、最大上下文窗口、类型，以及“支持工具调用 / 视觉 / 深度思考 / 联网 / 文件上传 / 图像生成”开关，每个开关都注明“这只是打开应用里的入口，模型实际能不能做取决于模型本身”。还能为模型选“扩展参数”（推理强度、思考预算、关闭上下文缓存等），提示“配置错误可能导致请求失败”。
- **客户端请求模式**：“从浏览器直接发起请求，可提升响应速度”（`fetchOnClient`）。这是 Web 部署特有的，与我们无关。
- 自托管时可用环境变量 `OPENAI_MODEL_LIST` 控制模型：`+` 增加、`-` 隐藏、`id=显示名` 改名。来源：[LobeHub README](https://github.com/lobehub/lobe-chat)

### 1.3 Chatbox（桌面 + 手机）

- **新手首屏**：首次启动显示引导，底部两张卡片——“我是新手（推荐）”和“跳过引导”。新手路径以对话形式一步步带着登录 Chatbox 自家服务（每日刷新的免费额度），额度用完再订阅或换自己的 Key。来源：[Your First Chat](https://chatboxai.app/en/guide/getting-started/first-chat)、[Chatbox AI Service FAQs](https://chatboxai.app/en/help-center/chatbox-ai-service-faqs)
- **自定义服务商**：设置 → 模型提供方 → 底部“添加”；填名称、API 类型（OpenAI 兼容 / Gemini 兼容）、API Key、API 主机，路径“一般不用填，默认 `/v1/chat/completions`”；至少添加一个模型，能力勾选可选，“不配置视为纯文本模型”；保存后点“检查”，提示连接成功。来源：[模型配置](https://docs.chatboxai.app/guides/providers.md)
- **一键导入第三方配置**（1.15.1 起）：JSON 配置可复制后在软件里一键导入，或用 deep link `chatbox://provider/import?config=<base64>`。配置字段：`id`（建议用域名）、`name`、`type`（目前只支持 openai）、`iconUrl`、`urls.website / getApiKey / docs / models`、`settings.apiHost / apiPath / apiKey（可选，可导入后让用户自己填）/ models`；每个模型可带 `nickname`、`type`、`capabilities`（vision / reasoning / tool_use）、`contextWindow`、`maxOutput`。302.AI、AiHubMix 等中转站已提供。来源：[导入第三方提供方配置](https://docs.chatboxai.app/guides/providers/import-config.md)
- **参数默认值**：temperature 0.7、top_p 1、流式默认开；`maxContextMessageCount` 控制带多少条历史；可收藏模型置顶。来源：[DeepWiki 对源码的整理（第三方）](https://deepwiki.com/chatboxai/chatbox/4.3-model-configuration-and-settings)
- **故障排查页**把常见问题写成“症状 → 原因 → 解决”：回复慢（换更快的模型、开新对话、减少上下文条数）、重复输出（调低温度、调频率惩罚、换模型）、图片不被理解（换支持视觉的模型），并给出按任务推荐的模型表。来源：[Troubleshooting](https://chatboxai.app/en/guide/faq/troubleshooting)

### 1.4 NextChat（ChatGPT-Next-Web）

- 设置里有“自定义接口”开关、服务商选择（OpenAI / Azure / Google…）、接口地址、API Key、“自定义模型”（逗号分隔）。来源：[界面文案 en.ts](https://github.com/ChatGPTNextWeb/NextChat/blob/c3b8c158/app/locales/en.ts)
- **“账户余额”一栏**：“本月已用 $x，订阅 $y”，按钮“检查”，未填 Key 时提示“填写 API Key 后才能查询余额”。来源：同上
- 生成参数直接列在设置页：Temperature（“值越大越随机”）、Top P（“不要和温度同时修改”）、Max Tokens、Presence Penalty、Frequency Penalty、附带历史消息数、历史压缩阈值，以及“摘要模型”（“用于压缩历史和生成标题”）。来源：同上
- 部署者用 `CUSTOM_MODELS` 控制模型列表：`+llama` 增加、`-gpt-3.5-turbo` 隐藏、`gpt-4-1106-preview=gpt-4-turbo` 改显示名。来源：[NextChat 环境变量](https://docs.nextchat.dev/quickstart/selfhost/env)

### 1.5 Open WebUI

- 管理员在“设置 → 管理 → 连接”添加 OpenAI 兼容连接：URL（输入时会“建议常见服务商地址”）、API Key；高级里有 Model IDs（留空则自动发现，填了就只显示这些，用来“隐藏老旧或昂贵的模型”，重复 ID 会被拒绝并提示“Model ID is already added”）、Prefix ID（两个服务都有同名模型时加前缀区分，如 `groq.qwen3.6`）、Provider 类型。来源：[OpenAI-Compatible 连接](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible)、[Starting with OpenAI](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai.md)
- **每个连接都有启用开关**，“不删除就能临时停用，保留配置”。来源：同上
- **验证连接其实是调 `/models`**。文档专门提醒：有的服务没有 `/models`（Perplexity、MiniMax 等），验证会报 400/401/403，“这不代表不兼容，聊天仍然能用”，手动把模型 ID 加进列表即可；OpenRouter 会返回上千个模型，“强烈建议加白名单”。来源：同上
- **任务模型**：后台的小调用（写标题、生成标签、追问建议、压缩旧消息摘要等）默认用当前聊天模型，“在昂贵的旗舰模型上是一笔没人计划过的账单”；可单独指定外部/本地任务模型，并给出推荐（`gpt-5.4-nano`、`gemini-3.5-flash-lite` 等）。还提醒：推理模型做任务模型时，思考会吃掉 token 预算导致标题被截断。来源：[Task Models](https://docs.openwebui.com/features/administration/task-models/)

### 1.6 SillyTavern

- **连接配置（Connection Profiles）**：1.12.6 起默认开启的内置扩展，保存 API 类型、模型、服务器地址、**API Key**、设置预设、推理格式等；“创建”时起一个唯一的名字；“更新”才写回；“删除”不可恢复；文档没有提到改名。可用斜杠命令 `/profile 名字` 切换。注意它只记下拉框里选的是哪个预设，不保存预设内容。来源：[Connection Profiles](https://docs.sillytavern.app/usage/core-concepts/connection-profiles/)
- **自定义 OpenAI 兼容接口**：“连接有问题时试试在末尾加 `/v1`”“不要加 `/chat/completions`”；实现了 `/v1/models` 就能从下拉框选，否则手填；“Test Message”发一条简单消息验证连通；“跳过 API 状态检查”用来压掉误报。来源：[Chat Completions](https://docs.sillytavern.app/usage/api-connections/openai/)
- **附加参数**：三个 YAML 文本框——追加请求体参数（如 `top_k: 20`）、排除请求体参数（如 `frequency_penalty`）、追加请求头。曾因示例格式写错导致用户困惑，后修正。来源：[模板源码](https://github.com/SillyTavern/SillyTavern/blob/aa50edcf/public/scripts/templates/customEndpointAdditionalParameters.html)、[issue #4333](https://github.com/SillyTavern/SillyTavern/issues/4333)
- Key 存在 `secrets.json`，界面只显示“✔️ Key saved / ❌ Missing key”；要看明文得改配置 `allowKeysExposure: true` 再点“View hidden API keys”。来源：[FAQ](https://docs.sillytavern.app/usage/faq/)

### 1.7 安卓原生客户端：RikkaHub、Kelivo、ChatterUI

- **RikkaHub**（安卓，Jetpack Compose）：自定义 API / URL / 模型（OpenAI、Google、Anthropic 兼容），**二维码导出导入服务商**，自定义请求头和请求体。来源：[RikkaHub README](https://github.com/rikkahub/rikkahub)。源码里服务商接口带 `getBalance`，余额接口路径和 JSON 字段路径可配置（`BalanceOption`），Key 轮换由 `KeyRoulette` 完成。来源：[DeepWiki：AI Provider System（第三方）](https://deepwiki.com/rikkahub/rikkahub/5-ai-provider-system)。社区分支的更新说明提到二维码分享可携带 Key 和模型列表，分享到 QQ 时曾错发成 `ai-provider:v1:base64` 文本而不是图片。来源：同一搜索结果中的 [rikkahubx](https://github.com/wanxiaoT/rikkahubx)（第三方分支）
- **Kelivo**（Flutter，安卓/iOS/桌面）：README 列出——每个服务商可多 Key，支持轮询、优先级、最少使用、随机四种策略，“自动标记异常的 Key”；在服务商、模型或助手级别自定义请求头和请求体；每个服务商单独设 HTTP/HTTPS/SOCKS5 代理；**余额查询**；按指数退避自动重试；**服务商分组，二维码或文本分享导入**；按模型和助手的用量排行；请求日志与“实际发给模型的完整内容”日志。来源：[Kelivo 中文 README](https://github.com/Chevey339/kelivo/blob/master/README_ZH_CN.md)。2026-06 加入“多 Key 管理里一次查询所有 Key 的余额”。来源：[提交 8c825a6](https://github.com/Chevey339/kelivo/commit/8c825a65ad5e90079c2e932b3a3c9cc1a67f5f43)。更新日志提到“停止默认的硅基流动余额查询”，说明余额查询需要按服务商区分、不能对所有服务默认发。来源：同一提交页所在的 [Releases](https://github.com/Chevey339/kelivo/releases)
- **ChatterUI**（安卓，React Native）：本地模式（设备上跑 GGUF）+ 远程模式（OpenAI、Claude、OpenRouter 等专用接口，以及通用 Chat/Text Completions），缺的服务商可用 JSON 模板自定义；采样参数可设推理强度、推理最大 token、排除推理内容。来源：[ChatterUI README](https://github.com/Vali-98/ChatterUI)、[Grokipedia 整理（第三方）](https://grokipedia.com/page/ChatterUI)

### 1.8 OpenCat（iOS / macOS）

- 设置 → 服务商 → 选“OpenAI 兼容”，填**名称（可自定义）**、接口地址、Key，点“浏览”获取模型，勾选要启用的模型后保存，底部有“验证”按钮；可手动加模型 ID；服务商之间并存，旧对话保持原来的服务商绑定。来源：[ChineseAPI 的 OpenCat 教程（第三方，含截图步骤）](https://cherrystudio.chineseapi.com/opencat/opencat-chineseapi-ios)、[APIsRouter 指南（第三方）](https://apisrouter.com/for-opencat)
- 多篇教程的常见问题都集中在**地址要不要带 `/v1`、末尾斜杠**：“报 404：接口地址漏了 `/v1`，OpenCat 不会自动补”；“确认地址末尾没有斜杠”。来源：[Relay AI 文档（第三方）](https://docs.relayai.asia/guide/clients/opencat)、[Lurus 文档（第三方）](https://docs.lurus.cn/en/guide/clients/opencat)
- 支持 URL Scheme 一键配置 `opencat://team/join?domain=…&token=…`；设置与 Key 可经 iCloud 在设备间同步，可关闭。来源：同上
- 单次对话可临时换模型，不影响默认配置。来源：[ttttt.ai 文档（第三方）](https://docs.ttttt.ai/clients/opencat)

### 1.9 Msty、Jan、AnythingLLM、LM Studio

- **Msty**：首次打开三选一——“安装本地 AI”（默认下载约 1.6 GB 的小模型）、“添加远程服务商”（填 Key、选模型）、“使用已有的 Ollama”。来源：[Msty Onboarding](https://docs.msty.app/getting-started/onboarding)。可**重命名服务商和模型**、改 Logo、在模型选择器里点星设默认、给模型打用途标签（文本、编程、工具、视觉、思考等）；Model Hub 有“模型分工（Model Squad）”“模型推荐（Matchmaker）”“费用计算器”“上下文解释器”。来源：[Managing Models](https://docs.msty.ai/studio/managing-models)、[Online Providers](https://docs.msty.ai/studio/managing-models/online-providers)。还有一页按服务商列出“API 地址 / 申请 Key 的网址 / Key 能看几次（仅一次或随时）/ 用量面板 / 价格页”。来源：[Find Online Model API Keys](https://docs.msty.ai/studio/how-tos/find-api-keys)。模型注册表（上下文长度、能力标签）可以不升级应用单独刷新。来源：[Add Models Not Included in Registry](https://docs.msty.app/how-to-guides/add-models-not-included-in-registry)
- **Jan**：设置 → 模型服务商，侧栏列出 Anthropic、Gemini、Groq、Mistral、OpenAI、OpenRouter 等和“Custom Endpoints”；OpenAI 页只要求“填入 API Key”，并提醒“确认 Key 有足够余额”；“自动包含常用 OpenAI 模型”，缺的再手动加。来源：[Jan OpenAI](https://docs.jan.ai/desktop/remote-models/openai)
- **AnythingLLM**：通用 OpenAI 接口被标为“面向开发者，不懂就别用”；表单要求填 Base URL、模型、**模型上下文窗口**、**Max Tokens**（默认 1024，会截断每次回复），取不到模型列表时退回手填。来源：[OpenAI (Generic) LLM](https://docs.anythingllm.com/setup/llm-configuration/cloud/openai-generic)、[源码 GenericOpenAiOptions](https://github.com/Mintplex-Labs/anything-llm/blob/master/frontend/src/components/LLMSelection/GenericOpenAiOptions/index.jsx)。这正是 v2 被否定的“五项参数手填”路线，反面教材。
- **LM Studio**：本地推理为主，本次未深入；Open WebUI 和 Cherry 都把它当作“本地服务商”接入。对手机端玩家意义不大。

---

## 2. 按主题汇总

### 2.1 服务列表

| 做法 | 谁在做 | 备注 |
|---|---|---|
| 添加时先填“名称”，之后可改 | Chatbox、Msty、OpenCat、LobeHub、Cherry 自定义服务商 | LobeHub：名称可改、ID 不可改 |
| 改图标 / Logo | Msty、LobeHub（创建时填 Logo 地址） | |
| 启用 / 停用而不删除 | Open WebUI、Cherry、LobeHub | Cherry 的“必须打开开关”反成踩坑点 |
| 排序、搜索 | LobeHub（自定义排序、字母排序、搜索） | |
| 同一家多个实例 | Cherry（“从预设创建”，用于多账号）、OpenCat、Open WebUI | Open WebUI 用前缀区分同名模型 |
| 分组 | Kelivo | |
| 一眼看出正在用哪个 | 多数产品在聊天页的模型选择器显示当前模型；Cherry 列表绿点 | |

### 2.2 Key

| 做法 | 谁在做 |
|---|---|
| “去申请 Key”直达链接 | LobeHub（Key 说明里的“点这里获取”）、Msty（Key/用量/价格三链接表）、Chatbox 导入配置的 `urls.getApiKey` |
| 多 Key 轮换 | Cherry（逗号分隔 + 单独管理页）、Kelivo（四种策略、自动标记异常）、RikkaHub |
| 余额查询 | NextChat（“账户余额”）、RikkaHub（可配置路径）、Kelivo（含多 Key 一次查询） |
| 只显示“已保存/缺失”，不回显明文 | SillyTavern、我们（“已保存，留空表示不修改”） |
| 说明“Key 只能看一次” | Msty（Only Once / Anytime） |

**国内常用服务商的余额接口**（都用同一个 Bearer Key，可以直接复用我们存好的 Key）：

| 服务商 | 接口 | 返回里有用的字段 | 来源 |
|---|---|---|---|
| DeepSeek | `GET https://api.deepseek.com/user/balance` | `is_available`、`balance_infos[].currency`（CNY/USD）、`total_balance`、`granted_balance`（赠金）、`topped_up_balance`（充值） | [查询余额](https://api-docs.deepseek.com/zh-cn/api/get-user-balance) |
| 硅基流动 | `GET https://api.siliconflow.cn/v1/user/info`（文档示例域名为 `.com`，国内站同路径【待验证】） | `data.balance`、`chargeBalance`、`totalBalance` | [Retrieve user info](https://docs.siliconflow.com/en/api-reference/userinfo/get-user-info) |
| Kimi（月之暗面） | `GET https://api.moonshot.cn/v1/users/me/balance` | `data.available_balance`（含现金与代金券，“≤0 时不能调用推理接口”）；英文文档写单位 USD，国内站应为人民币【待验证】 | [Check Balance](https://platform.kimi.ai/docs/api/balance) |
| OpenRouter | `GET https://openrouter.ai/api/v1/key`；`GET /api/v1/credits` | Key 的 `limit_remaining`（无上限时为 null）；账户 `total_credits`、`total_usage` | [Limits](https://openrouter.ai/docs/api_reference/limits)、[Get remaining credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits) |
| 通义千问、智谱、火山方舟、Gemini | 未找到用同一 Key 可调的公开余额接口【待验证】 | 只能给“去控制台看余额”的链接 | — |

### 2.3 地址

- 自动补全：Cherry（根地址自动补 `/v1/chat/completions`）、Chatbox（路径默认 `/v1/chat/completions`）、我们（根地址补 `/v1`，带路径的只补 `/chat/completions`）。OpenCat 不补，于是它的教程里“404 漏了 `/v1`”是头号问题。
- 校验：LobeHub“必须包含 http(s)://”“请输入有效的 URL”；Open WebUI 输入时联想常见服务商地址。
- 常见错误（从各家 FAQ 归纳）：漏 `/v1`、多了 `/chat/completions`、末尾斜杠、缺 `https://`、把网页控制台地址当接口地址、Key 前后有空格、选错了服务商类型（OpenCat 选“OpenAI 原生”会去官方拉模型列表）。来源：上文 OpenCat、SillyTavern、Msty 各条
- 代理、请求头、请求体：Kelivo（每个服务商单独代理；三个层级的请求头/请求体）、SillyTavern（YAML 文本框）、RikkaHub。都放在高级区。

### 2.4 模型

| 做法 | 谁在做 |
|---|---|
| 保存服务后自动列出模型 | Msty、OpenCat、BotGem（教程称“自动从 `/v1/models` 获取”，第三方） |
| 显式按钮 + “上次更新时间” | LobeHub、Cherry |
| 搜索 | LobeHub、Chatbox（更新日志“模型列表支持搜索”） |
| 只把选中的模型放进选择器 / 隐藏不用的 | Cherry（`+` 加入）、LobeHub（启用/禁用）、Open WebUI（白名单）、NextChat（`-` 隐藏） |
| 显示名 | Cherry、LobeHub、Msty、NextChat（`id=显示名`）、Chatbox（`nickname`） |
| 能力标签 | LobeHub（工具、视觉、深度思考、联网、文件、生图）、Cherry、Chatbox（vision/reasoning/tool_use）、Msty（用途标签） |
| 上下文长度、最大输出 | LobeHub、Cherry、Chatbox 导入配置、AnythingLLM（必填，反面） |
| 按模型的价格 | Cherry（人民币或美元，每百万 token，含缓存和阶梯价）、LobeHub（显示内置价格） |
| 收藏 / 默认 | Chatbox（星标置顶）、Msty（星标设默认） |
| 手动加模型 | 所有产品都支持；Open WebUI、Msty 专门为“没有 `/models` 的服务”写了说明 |

**白拿的模型信息**：OpenRouter 的 `/models` 每个模型都带 `context_length`、`pricing.prompt / completion`（美元/每 token）、`supported_parameters`（含 `reasoning`）、`architecture.input_modalities`、`top_provider.max_completion_tokens`。来源：[OpenRouter Get models](https://openrouter.ai/docs/api/api-reference/models/get-models)。其他服务商的 `/models` 通常只有 `id`，上下文与价格要靠内置表（Msty 的“模型注册表”、LobeHub 的内置模型卡就是这么做的）。

**模型名会过期**：DeepSeek 在 2026-04-24 发布 V4 时宣布 `deepseek-chat`、`deepseek-reasoner` 两个旧名于 2026-07-24 停用；2026-09-10 又上线 `deepseek-flash`（V4.1 Flash），`deepseek-v4-flash` 暂时路由过去。来源：[DeepSeek 更新日志](https://api-docs.deepseek.com/updates/)。Open WebUI 文档也写明“`deepseek-chat` 和 `deepseek-reasoner` 别名已于 2026-07-24 退役”。智谱免费档也在迭代（`glm-4.5-flash` 2026-01-30 下线，自动路由到 `glm-4.7-flash`）。来源：[蓝猫 AI 整理（第三方）](https://lanmao.ai/zh/o/bigmodel-glm/)。所以**推荐模型不能写死，只能按偏好从实时列表里挑**——我们的 `recommendModel` 思路是对的，但偏好表和占位符要更新（见第 3 节 J-08）。

### 2.5 生成参数

| 参数 | 放在哪 | 例子 |
|---|---|---|
| 温度、Top P、最大 token、存在/频率惩罚 | 设置页直接列出 | NextChat（每项一句话说明） |
| 温度、Top P | 助手（角色）级别 | Kelivo、Chatbox |
| 推理强度 / 思考预算 / 关闭思考 | 模型的“扩展参数” | LobeHub（按模型族列出）、Cherry（`enable_thinking`）、ChatterUI |
| 上下文条数 / 压缩阈值 | 设置页 | NextChat、Chatbox |
| 参数预设 | Msty（含服务商原生工具预设）、SillyTavern | |
| 单次对话覆盖 | OpenCat（临时换模型）、Kelivo（按对话设模型和系统提示词） | |
| 超时、重试 | Kelivo（指数退避自动重试）、Open WebUI（模型列表获取超时可调） | |

### 2.6 分工、备用与快速切换

- **分工**：Cherry“默认模型”（助手 / 快速 / 翻译 / 绘画）、Open WebUI“任务模型”、NextChat“摘要模型”、Msty“Model Squad”。共同点是把便宜快速的模型用在后台杂活上，并明确建议不要用思考模型。
- **备用 / 失败转移**：Cherry 明确不做；Kelivo 有自动重试和“标记异常 Key”；客户端普遍把真正的路由交给 OpenRouter、New API 等网关。
- **快速切换**：几乎所有聊天客户端都把模型选择器放在聊天页顶部或输入栏；OpenCat 单次对话可临时换模型。

### 2.7 测试与诊断

| 产品 | 测试做什么 | 显示什么 |
|---|---|---|
| Cherry | 选一个模型（可选 Key）发请求；健康检查并发测全部模型 | 成功/失败、每个模型的延迟 |
| LobeHub | 检查 Key 和地址 | “检查通过”或错误 |
| Chatbox | 保存后“检查” | “连接成功” |
| SillyTavern | “Test Message”发一条简单消息 | 成功或错误提示 |
| Open WebUI | 调 `/models` | “Server connection verified”；文档提醒失败不一定代表不能聊 |
| 我们 | 用选中的模型发“只回复两个字：你好”，`max_tokens` 16；顺便探测是否支持 `include_usage` | “连接成功，响应 x 秒”或一句玩家语言的错误 |

诊断方面最好的是 Kelivo 的“上下文日志”（记录实际发给模型的完整内容）和 Msty 文档里“提供者已添加但没有模型 → 服务没有 `/models`，手动添加”“Key 被拒 → 检查空格、Key 是否只显示一次、权限”这类症状对照表。

### 2.8 费用

- 按模型价格：Cherry（可选美元/人民币；未知 ≠ 免费）、LobeHub（内置价格显示）、OpenRouter `/models` 自带价格。
- 用量统计：Kelivo（按模型和助手排行、输入/输出/缓存 token、聊天热力图，最新版在输入栏显示上下文占用和预估费用）、Cherry（消息旁显示价格）。来源：[Kelivo README](https://github.com/Chevey339/kelivo/blob/master/README_ZH_CN.md)、[Kelivo Releases](https://github.com/Chevey339/kelivo/releases)
- 预算：客户端里少见；OpenRouter 可给 Key 设额度上限（`limit_remaining`），属于服务端能力。
- 余额：见 2.2 表。

### 2.9 导入、导出、分享

| 形式 | 谁在做 | 是否带 Key |
|---|---|---|
| deep link（base64 JSON） | Cherry、Chatbox、OpenCat | 可带可不带；Cherry 打开后弹确认框 |
| JSON 粘贴导入 | Chatbox | 可选 |
| 二维码 / 文本 | RikkaHub、Kelivo | RikkaHub 分支可带 Key 和模型列表 |
| 从电脑导入到手机 | Cherry 手机版 | 【待验证】 |
| 云同步 | OpenCat（iCloud，可关闭） | Key 走 iCloud 钥匙串 |

注意：base64 只是编码不是加密，带 Key 的链接或二维码被别人看到就等于泄露 Key（Chatbox 文档没写这一点，是本文的判断）。

### 2.10 新手引导

- **先给能用的东西，再要 Key**：Chatbox 新手路径直接登录自家服务（每日免费额度）；Msty 可以先下载本地小模型；Cherry 推荐新手用自家 CherryAI（免费）。我们没有自家服务，也不打算在手机上跑本地模型，所以要靠“选一个有免费额度的服务商 + 带路”。
- **国内零成本或低成本的起步选项**：
  - 智谱：GLM-4.7-Flash 等 Flash 系列模型免费调用（官方文档设“免费模型”板块；GLM-4.7-Flash 上下文 200K、最大输出 128K，文档推荐用于“沉浸式写作与角色驱动创作”），有并发限制。来源：[GLM-4.7-Flash 官方文档](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash)、[白嫖计对比（第三方，核实于 2026-08）](https://baipiaoji.com/vs/siliconflow-vs-zhipu-glm)
  - 硅基流动：新用户注册送平台额度，实名再领代金券；部分小模型长期免费。来源：同上第三方对比页、[硅基流动价格页](https://www.siliconflow.cn/pricing)
  - 其他（第三方汇总，金额与时效以官方为准）：阿里百炼新用户各模型体验额度、Kimi 新用户体验额度等。来源：[Get Model Key 福利专题（第三方）](https://www.getmodelkey.com/zh/offers/)
  - Gemini 有免费层，但国内需要特殊网络，不适合作为国内新手默认。来源：[Gemini 价格](https://ai.google.dev/gemini-api/docs/pricing)
- **怎么不吓人**：Cherry 解释“密钥 = Key = 令牌”，手机版快速开始第一句就是“先让一个模型成功回答一条消息”；Chatbox 新手路径用对话代替表单；AnythingLLM 把通用接口标成“开发者用”，变相告诉普通人别碰。Msty 的“Key 只能看一次”提示很实用：很多人第一次申请 Key 后没复制就关掉了页面。

---

## 3. 对照我们的现状：缺口清单

### 3.1 我们现在有什么

- 9 个预设按钮横排（DeepSeek、通义千问、Kimi、智谱、硅基流动、火山方舟、OpenRouter、Gemini、自定义），预设地址折叠显示，自定义时显示地址输入框；HTTP 地址要勾选风险确认。
- API Key 密码框（编辑时“已保存，留空表示不修改”），存系统密钥库并绑定到服务地址。
- “获取模型列表”按钮；获取后模型从输入框变为原生下拉框，并按预设偏好自动选一个（过滤掉嵌入、图像等非对话模型）。
- “高级”折叠里的“辅助模型”（带候选的输入框）。
- “测试连接”：发一条极短请求，显示秒数，同时探测是否支持用量统计；失败时显示一句玩家语言的原因。
- 设置页：服务卡片（名称、模型、使用/修改/删除）、“＋ 添加服务”、每回合上下文预算三档（省一些/标准/记得更多）、用量与费用估算（全局一个输入/输出单价，人民币）。

### 3.2 从代码里看到的问题（未在真机复现，标【待验证】）

- **服务名永远等于预设名**：`ensureProfile` 写入 `name: preset.name`，所以两个自定义服务都叫“自定义”，两个 DeepSeek 实例都叫“DeepSeek”。（与用户反馈一致）
- **点“获取模型列表”或“测试连接”就会把服务写进数据库**：`loadModels` 和 `test` 都先调用 `ensureProfile`。如果玩家点了获取、然后返回不保存，设置页会多出一个半成品服务（可能还没有模型）。【待验证】
- **修改服务时换了预设、但不重新填 Key**：Key 绑定在旧地址上（`secrets.set(keySlot, key, serviceBase)`），换地址后获取模型可能报“还没有配置好 AI 服务”，玩家看不懂。【待验证】
- **推荐偏好和占位符过时**：DeepSeek 预设偏好 `deepseek-chat`、模型输入框占位“例如 deepseek-chat”，而该名称已于 2026-07-24 停用（见 2.4）。好在偏好表里还有通配的 `deepseek`，大概率仍能选中可用模型，但会选到哪个不可控。
- **价格是全局一个**：用量页的输入/输出单价是一个全局设置，玩家换了服务或模型，费用估算就不对了。
- **9 个预设挤在一个分段控件里**：手机竖屏上会换行或拥挤，且只有名字，看不出各家区别。【待验证：未截图】

### 3.3 缺口清单

成本：S＝半天以内；M＝一到三天；L＝三天以上。优先级：P0＝第一批就做，P1＝第二批，P2＝候选池。

| 编号 | 缺什么 | 谁做得好 | 为什么对我们的玩家重要 | 成本 | 不加说明文字的设计建议 | 优先级 |
|---|---|---|---|---|---|---|
| J-01 | **填好 Key 后自动获取模型** | Msty、OpenCat 保存后自动列出；LobeHub/Cherry 显示“上次更新时间” | 玩家不知道“可以获取列表然后挑一个”（用户原话）；手机上手打模型名容易错 | S | Key 输入框失焦或粘贴后、地址合法时自动拉 `/models`；成功后模型区直接变成“已选：推荐模型 ›”；原按钮缩成模型区角落的“刷新”图标；拉取失败才露出手填框 | P0 |
| J-02 | **服务可以命名、改名** | Chatbox、Msty、OpenCat、LobeHub、Cherry | 两个“自定义”分不清；同一家建两个（如便宜模型和好模型）也分不清 | S | 名称默认自动生成：预设名；自定义取地址的域名主体（如 `api.example.com` → “example”）；重名自动加“2”。页面顶部标题位置就是可点的名称，点一下改 | P0 |
| J-03 | **可搜索的模型选择器，推荐模型置顶** | LobeHub（搜索、分组、能力标签）、Chatbox（搜索、星标） | 硅基流动、OpenRouter 一拉就是几十上百个模型，原生下拉框在手机上翻不动；玩家不知道选哪个 | M | 点“已选模型 ›”弹出底部面板：顶部搜索框，第一组“推荐”（按预设偏好挑 1～3 个，标“推荐”），其余按厂商前缀分组，默认隐藏嵌入、图像、语音等非对话模型；有 OpenRouter 数据时在条目右侧小字显示上下文长度与价格 | P0 |
| J-04 | **测试结果给出实际回话和模型名** | Cherry（延迟、多模型健康检查）、SillyTavern（Test Message） | 只显示“响应 x 秒”，玩家不确定“真的通了吗、用的是哪个模型” | S | 成功时显示一行：“DeepSeek V4 Flash 回了一句：你好 · 1.2 秒”；失败时显示原因和一个直接修的按钮（“重新填 Key”“换个模型”“去充值”），原始错误放进可展开的小字里 | P0 |
| J-05 | **地址和 Key 填错的自动识别** | LobeHub（URL 校验）、Open WebUI（地址联想）、SillyTavern/OpenCat 的 FAQ | 漏 `/v1`、贴了网页地址、贴了带空格的 Key 是头号失败原因（见 2.3）；玩家看到“404”不知道怎么办 | S～M | 输入时静默纠正：去首尾空格、补 `https://`；识别出已知服务商域名时自动切到对应预设；地址框里贴进的是 `sk-` 开头内容、或 Key 框贴进网址时，直接把内容挪到正确的框；`/models` 返回 404 时自动再试一次补 `/v1` 的地址，成功就悄悄替换；只有都失败才提示 | P0 |
| J-06 | **Key 的显示/隐藏、粘贴、去申请** | LobeHub（“点这里获取”）、Msty（Key/用量/价格链接表） | 手机上看不见自己贴进去的是什么；不知道去哪儿申请 | S | Key 框右侧两个小图标：眼睛（显示/隐藏）、粘贴；预设下方一行小链接“申请 Key · 价格”，跳各家官方控制台。不写教程，链接本身就是指引 | P0 |
| J-07 | **余额显示** | NextChat（账户余额）、RikkaHub、Kelivo | 额度用完是最常见的“突然不能玩”；玩家不知道还剩多少、要不要充值 | M | 只对有接口的服务商查（DeepSeek、硅基流动、Kimi、OpenRouter，见 2.2 表）：服务卡片副标题显示“余额 ¥12.30”，测试成功时一并刷新；余额为零或 `is_available=false` 时，在开新局前给一句提醒并附“去充值”链接；查不到就不显示，不报错 | P0 |
| J-08 | **更新推荐偏好，修正过时占位符** | —（内部维护） | `deepseek-chat` 已停用，推荐不可控；占位符误导手填的玩家 | S | DeepSeek 偏好改为 `deepseek-flash`、`deepseek-v4-flash`、`deepseek`；占位符改成随预设变化；偏好表集中维护，附核对日期 | P0 |
| J-09 | **获取模型和测试不应提前写入服务列表** | Cherry 手机版（模型编辑页“手动保存，不要把退出页面当作保存”） | 返回后多出半成品服务，玩家困惑【待验证】 | S | 获取模型和测试时用临时 Key 槽；只有点“保存”才落库；没保存就返回时，若已填 Key，弹一句“放弃这个服务？” | P0 |
| J-10 | **服务商选择改为带说明的卡片网格** | Cherry 的“一句话选择指南”、Msty 首屏三选一 | 9 个名字挤在一行，新手不知道选哪家 | S | 两列卡片，每张：名字 + 四五个字的特点（“便宜、中文好”“有免费模型”“一个 Key 用很多家”）；“自定义”放最后；已配置过的服务商卡片带小勾 | P1 |
| J-11 | **服务卡片的更多信息和操作** | LobeHub（排序）、Open WebUI（停用）、Cherry（多实例） | 想试另一个模型时只能重新填一遍；看不出哪个服务还有钱、哪个最近失败过 | M | 卡片显示：名称、模型、余额（J-07）、最近一次是否成功；“使用”改成点整张卡片即切换；长按或“⋯”菜单放 修改 / 复制一份 / 删除。暂不做“停用”和手动排序（个人使用服务不多，按最近使用排序即可） | P1 |
| J-12 | **辅助模型自动推荐** | Open WebUI（任务模型推荐小模型）、Cherry（快速模型“不建议思考模型”） | 辅助模型藏在“高级”里要手填，多数玩家永远不会设，白白多花钱 | S | 拿到模型列表后，自动从同一服务里挑一个名字含 flash / lite / mini / turbo 且非思考型的模型作为辅助模型，在模型区下方显示一行“整理记录用：xxx（更省钱）›”，可点开换；没有合适的就跟主模型相同 | P1 |
| J-13 | **按服务/模型记价格，费用估算跟着走** | Cherry（按模型、可选币种、未知≠免费）、LobeHub、OpenRouter `/models` | 现在的全局单价在换服务后就不准 | M | 价格挂在服务的模型上；OpenRouter 自动填（美元换算显示）；常用预设内置一份参考价（标核对日期【待验证 价格需逐家核对】）；用量页增加“按模型”分组 | P1 |
| J-14 | **出错时一键换服务重试** | Kelivo（自动重试、标记异常 Key）；网关类产品 | 玩到一半服务挂了或没钱了，现在只能退出去设置里切 | M | 不做静默自动切换（会让玩家搞不清哪个服务在写、费用落在哪）；回合失败提示里，如果玩家有第二个服务，直接给按钮“用 xxx 重试这一段” | P1 |
| J-15 | **游玩中快速换模型** | OpenCat（单次对话临时换）、Kelivo（按对话设模型） | 想换个文风或更好的模型重说一段，要走三层菜单 | M | 在“重说”里加一项“换个模型重说”，列出所有已配置服务的主模型；选中只影响这一次 | P1 |
| J-16 | **思考开关 / 回应速度** | LobeHub（扩展参数）、Cherry（`enable_thinking`）、ChatterUI（推理强度） | 思考型模型首字慢、费用高，对讲故事帮助有限；PLAN_V3 第 5.7 节已计划“按服务商预设可选关闭思考” | M | 模型区下方，仅当模型支持时出现两档：“快一些 / 想得更周到”；具体参数按服务商预设映射（`thinking`、`enable_thinking`、`reasoning_effort` 等，逐家【待验证】） | P1 |
| J-17 | **服务配置导出导入（手机 ↔ 电脑）** | RikkaHub/Kelivo（二维码、文本）、Chatbox/Cherry（deep link）、Cherry 手机版（从电脑导入） | 用户在 Windows 上调试、在手机上玩，两边都要配一遍 | M | “⋯”菜单里“分享给另一台设备”：生成二维码 + 可复制文本，默认**不含 Key**；勾选“包含 Key”时用一次性口令加密（口令显示在发送端，接收端输入）；导入时弹确认框列出名称、地址、模型。依赖扫码能力【待验证 Tauri 安卓扫码插件】 | P1 |
| J-18 | **新手路径“我还没有 Key”** | Chatbox（新手卡片）、Msty（三选一）、Cherry（先让一个模型答一句） | 从没听说过 API Key 的玩家第一屏就卡住；PLAN_V4 方向 A 也要求 | M | 首次连接页顶部两个选项：“我已有 Key” / “我还没有”。后者推荐一家有免费模型的服务商（智谱 Flash 或硅基流动），三步卡片：①打开申请页（按钮直达）②复制 Key ③回到游戏（自动检测剪贴板里像 Key 的内容并询问是否填入【待验证 安卓剪贴板读取限制】），然后自动完成 J-01、J-04 | P1 |
| J-19 | **错误原因细分** | Msty/Chatbox 的症状对照表 | 现在 402 和 429 合并为“额度不足或太频繁”；404 不区分“地址错”还是“模型名错” | S | 利用已有信息区分：`/models` 能拉到但聊天 404 → “这个模型名不对”；拉不到 → “地址不对”；402 / 余额为零 → “余额用完了”+充值链接；429 → “请求太快，稍等再试”；智谱、通义等返回的中文错误信息直接原样展示一句 | P1 |
| J-20 | **用量按服务和模型分组** | Kelivo（按模型排行） | 玩家想知道“钱花在哪个模型上” | S | 用量页现有“按世界/按天/按用途”再加“按模型”（`usage` 表已有 `model` 字段） | P1 |
| J-21 | **自定义请求头、请求体、代理** | Kelivo、SillyTavern、RikkaHub | 少数中转站需要额外请求头；不影响普通玩家 | S | 只在开发者模式的服务编辑页出现“附加请求头 / 附加参数”（键值对，不用 YAML，避免 SillyTavern 那种格式困惑） | P2 |
| J-22 | **多 Key 轮换** | Cherry、Kelivo、RikkaHub | 主要用于绕开速率限制；单人游戏少见 | M | 暂不做；需要时用“复制一份服务、换个 Key”代替 | P2 |
| J-23 | **生成参数（温度、最长输出）** | NextChat、Chatbox | 大多数玩家不该碰；但有人想要“更天马行空/更稳” | S | 暂不暴露原始参数；若要做，作为游戏设置里的“文风：稳一些 / 放开一些”映射到温度，不放在服务页 | P2 |
| J-24 | **预算提醒** | 客户端少见；OpenRouter Key 限额 | 防止不知不觉花多 | M | 用量页可设“本月提醒线”，超过时在首页轻提示一次；依赖 J-13 的价格 | P2 |
| J-25 | **模型能力与上下文长度用于自动设置上下文预算** | Chatbox 导入配置的 `contextWindow`、LobeHub、Cherry | 现在三档预算与模型无关；小上下文模型可能被塞爆 | M | 已知模型上下文较小时，自动把“记得更多”档置灰并说明“这个模型记不下这么多”；数据来自 OpenRouter 或内置表 | P2 |

### 3.4 建议的落地顺序

1. **第一批（P0，一个小计划内完成）**：J-01 自动获取模型、J-02 命名改名、J-03 模型选择面板、J-04 测试结果、J-05 填错自动纠正、J-06 Key 小工具、J-07 余额、J-08 偏好更新、J-09 不提前落库。做完后，Setup 页的视觉结构应当是：服务商卡片 → Key（含眼睛/粘贴/申请链接）→ 自动出现的“已选模型 ›”和“整理记录用 ›” → 测试结果一行 → 保存。地址只在自定义或纠错时出现。
2. **第二批（P1）**：J-10 到 J-20。其中 J-14、J-15 涉及游戏页，需与方向 D（交互）一起排；J-18 与方向 A（第一次使用）一起做。
3. **候选池（P2）**：J-21 到 J-25，等玩家反馈再立项。

### 3.5 用六条支柱检查

- **流畅**：J-01、J-05、J-09 把“填 Key 到能玩”的点击数压到最少，并且不再出现“点了获取却多出一个服务”。
- **掌控**：J-02、J-11、J-15、J-17 让玩家能管理多个服务并随时换；J-14 出错时有出路。
- **有后果 / 有盼头**在这一页体现为“钱”：J-07、J-13、J-20、J-24 让玩家知道花了多少、还剩多少。
- **代入**：服务页本身是工具，不追求时代感；但出错提示的按钮（“用 xxx 重试这一段”）应留在游戏页里完成，不把玩家赶出故事。

---

## 4. 未验证与后续需要核对的事项

- 通义千问、智谱、火山方舟、Gemini 是否有可用同一个 Key 查询的余额接口：本次未找到【待验证】。
- 硅基流动国内站余额接口的域名、Kimi 国内站余额的币种【待验证】。
- 火山方舟的 OpenAI 兼容地址是否支持 `GET /models` 列出可用模型：官方“兼容 OpenAI SDK”页只示范了对话调用，接入点列表接口需要另一套签名鉴权【待验证】。来源：[兼容 OpenAI SDK](https://ark.volcengine.com/region:cn-beijing/docs/compatible-with-openai-sdk)
- 各家“关闭思考”的参数名与取值【待验证，J-16 开工前逐家查官方文档】。
- 各家内置参考价格【待验证，J-13 开工前逐家核对并记录日期】。
- Tauri 安卓端读取剪贴板、扫描二维码的能力与权限【待验证】。
- 3.2 节从代码推断的三个问题（半成品服务、换预设后 Key 绑定、预设按钮拥挤），需要在浏览器开发台（手机尺寸）里实际操作确认。
