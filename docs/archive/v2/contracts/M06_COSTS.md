# M06 本地单价与费用估算契约

2026-10-16（Asia/Shanghai），M06-T008。费用只按用户明确输入的当前单价和服务报告usage估算，不联网取价，不代表当时合同价、实际账单、税费或缓存/推理特殊计费。无单价或usage为null就未知；不得从预留次数推算。单价配置不入正式游戏包，不触碰Provider配置/Key。

## 核心与本机配置

独立model-prices.sqlite，严格版本/schema校验，CAS修订。初始revision=0，entries=[]；revision安全整数、最多128个model，model规则沿用Provider模型限制。currency仅CNY/USD；inputPerMillion/outputPerMillion为每百万输入/输出Token金额，字符串十进制，0～1000000，最多6位小数，整数部分为0或非零开头数字；不接受多余前导零、缺整数/小数、指数、负数、空白、NaN。输入0表示用户明确填0，默认不填。规范输出六位小数；不使用浮点计费。price数值转换为百万分之一货币的整数，再以u128计算tokens*price/1000000，四舍五入到六位小数；正值舍入为零时roundedToZero=true（UI显示小于0.000001）。总金额采用输入/输出精确分子求和后只舍入一次。

旧记录只凭model名称关联当前用户填写单价；若曾用同名跨服务商或不同价格，必须向玩家明确这是按当前单价重算，不能称作历史实际费用。单价变更不改不可变调用记录/世界/Provider修订。总表只处理最近100条本机记录，不做全历史支出承诺或跨币种合计。

## 原生公开命令与DTO

所有字段camelCase，严格字段，无Key/端点/提示词/原文。读命令不发网络。

- get_game_prices() -> PriceSettings {revision,entries:[ModelPrice]}
- set_game_price({input:PriceUpdate}) -> PriceSettings
- clear_game_price({model,expectedRevision}) -> PriceSettings
- get_game_cost_estimates() -> CostReply

ModelPrice={model,currency,inputPerMillion,outputPerMillion}。
PriceUpdate=ModelPrice加expectedRevision。
CostReply={priceRevision,attempts:[CostAttempt]}。
CostAttempt={worldId,branchId,operationId,sequence,model,estimate:CostEstimate|null}。
CostEstimate={currency,totalAmount,roundedToZero}；totalAmount为规范六位十进制字符串，不能由JS浮点重新计算。只按CallAttempt已有usage.promptTokens/completionTokens，usage缺失或价格缺失返回estimate:null；HTTP失败但有可信usage仍可估算，状态不影响已处理Token计价。

保存单价成功revision+1；清除已有模型成功+1，清除不存在模型在CAS正确时保持原revision。过期修订始终拒绝，不因目标不存在而绕过。金额/修订/usage无效不修改配置。

错误只用安全枚举game_price_invalid/game_price_stale/game_price_store，无上游错误内容。损坏价格库阻止估算和配置，不阻止离线读取世界或发送已经授权的普通回合。价格上限、revision及Token数均验证安全整数；数据库未知schema只读拒绝，不能静默重建或覆盖。

## UI与验收

调用详情显示“按当前单价估算”与金额或未知。调用记录面板中单价编辑器明确保存/删除，读取和保存不发模型请求；挂载不自动修改或调用网络。可选当前已读取记录中的model，也可手动填写model。CNY/USD不做汇率转换。保存仅改独立本机单价，保留Provider修订与Key；本机最近记录读取与估算读取可分别失败并可显式重读。

固定测试覆盖十进制边界/超大usage/精度/零与未知/不合法usage、CAS重开/损坏未来schema拒绝、最近100条与准确绑定、保存删除不触碰SecretStore或世界。隔离UI检查新增项含错误数据/重复点击/迟到卸载/未知金额/小额及360px布局。真实模型请求0、手机操作0。
