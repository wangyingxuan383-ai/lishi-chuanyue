const messages = {
  heading: "本机单价与费用估算", help: "仅按你填写的当前单价和服务报告的 Token 用量重算最近 100 条调用，不代表历史价格或实际账单。没有单价或用量时显示未知。",
  scope: "同名模型可能来自不同服务商，请核对价格适用范围。币种不换算、不合计；未包含税费及特殊计费规则。",
  readPrices: "读取本机单价", readEstimates: "读取当前费用估算", reading: "正在处理…", pricesRead: "本机单价已读取。", estimatesRead: "当前费用估算已读取。",
  loadFirst: "先读取本机单价，再编辑并明确保存。保存和清除只影响本机单价，不修改接口、Key、世界或原调用记录。",
  noPrices: "尚未填写模型单价。", model: "模型名称", modelHelp: "可选已读取调用中的模型，也可填写名称；名称需与你的服务一致。",
  chooseModel: "选择已知模型", manualModel: "手动填写模型", currency: "单价币种", CNY: "CNY（人民币）", USD: "USD（美元）",
  input: "每百万输入 Token 单价", output: "每百万输出 Token 单价", priceHelp: "金额为 0 至 1000000，最多 6 位小数。填 0 表示你明确指定免费；留空不会视为 0。",
  save: "保存本机单价", clear: "清除此模型单价", saved: "本机单价已保存；请重新读取费用估算。", cleared: "此模型单价已清除；请重新读取费用估算。",
  configured: "此模型已有本机单价。", notConfigured: "此模型尚无本机单价。", validInput: "请填写有效模型名和两项单价，再保存。",
  game_price_invalid: "单价或估算数据不完整，请检查填写内容并重新读取。", game_price_stale: "本机单价已在其他位置变化，请重新读取后再保存或清除。",
  game_price_store: "暂时无法读取或保存本机单价。可以继续查看调用记录，稍后点击按钮重试。",
  currentEstimate: "按当前单价估算", unknown: "未知", notRead: "尚未读取", small: "<0.000001", estimateHelp: "此金额按当前本机单价重算，不是实际账单。", reread: "单价已变化，请先重新读取本机单价，再读取费用估算。",
} as const;
export type GameCostMessageKey = keyof typeof messages;
export function costT(key: GameCostMessageKey): string { return messages[key]; }
export function priceErrorKey(error: unknown): "game_price_invalid" | "game_price_stale" | "game_price_store" {
  const value = typeof error === "string" ? error : error instanceof Error ? error.message :
    typeof error === "object" && error !== null && !Array.isArray(error) ? (error as Record<string, unknown>).code : null;
  return value === "game_price_invalid" || value === "game_price_stale" ? value : "game_price_store";
}
