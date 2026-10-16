const messages = {
  heading: "本机模型调用记录", read: "读取最近记录", loading: "正在读取…", empty: "尚无当前版本记录的模型请求。",
  help: "最近 100 次请求的本机记录。演示模式不发请求；旧版本的调用不会补填。响应接收完成后仍需通过回合校验才能成为剧情。",
  budget: "每个操作最多预留两次模型请求，当前不会自动重试。搜索单独计数；取消或中断可能仍产生服务商费用。",
  unknown: "未知", reserved: "结果尚未确认", completed: "响应接收完成", failed: "请求失败", cancelled: "请求已取消", interrupted: "程序中断，发送结果未知",
  attempts: "已确认 HTTP 尝试", tokens: "服务商返回 Token", elapsed: "请求耗时（毫秒）", http: "HTTP 状态", reservation: "本操作预留序号", details: "查看调用详情",
  world: "世界编号", branch: "世界线编号", operation: "操作编号", prompt: "提示词版本", diagnostic: "错误码", cost: "费用按你填写的当前本机单价估算，不代表实际账单；没有单价或服务用量时保持未知。",
  error: "暂时无法读取调用记录。已有世界仍可查看；不会自动重新发送请求。", noEndpoint: "此处只保存模型名称、版本、次数和用量等诊断，不保存 Key、地址、提示词或响应正文。",
  outputRead: "读取本窗口输出诊断", outputHelp: "仅保留本窗口最近 64 次被拒绝输出的类别和已知字段名，不含原始正文；此按钮不会请求模型。关闭应用后清除。", outputEmpty: "当前窗口没有这次输出诊断。", outputCategory: "校验类别", outputField: "相关字段", outputPosition: "JSON 行与列", outputBytes: "响应字节数",
  shape_constraints: "输出内容未满足结构约束", too_large: "输出超过大小上限", invalid_fence: "JSON 代码块格式不完整", invalid_protocol: "协议版本不符", json_syntax: "JSON 语法错误", incomplete_json: "JSON 未写完整", invalid_schema: "字段类型或结构不符", missing_field: "缺少必填字段", unknown_field: "包含不支持的字段", unknown_variant: "包含不支持的操作类型", holding_quantity_change: "转移物品时非法改变数量或单位；消耗须使用数量变化操作", domain_constraints: "输出违反当前世界状态规则",
} as const;
export type CallMessageKey = keyof typeof messages;
export function callT(key: CallMessageKey): string { return messages[key]; }
