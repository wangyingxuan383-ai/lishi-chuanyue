const messages = {
  heading: "本机模型调用记录", read: "读取最近记录", loading: "正在读取…", empty: "尚无当前版本记录的模型请求。",
  help: "最近 100 次请求的本机记录。演示模式不发请求；旧版本的调用不会补填。响应接收完成后仍需通过回合校验才能成为剧情。",
  budget: "每个操作最多预留两次模型请求，当前不会自动重试。搜索单独计数；取消或中断可能仍产生服务商费用。",
  unknown: "未知", reserved: "结果尚未确认", completed: "响应接收完成", failed: "请求失败", cancelled: "请求已取消", interrupted: "程序中断，发送结果未知",
  attempts: "已确认 HTTP 尝试", tokens: "服务商返回 Token", elapsed: "请求耗时（毫秒）", http: "HTTP 状态", reservation: "本操作预留序号", details: "查看调用详情",
  world: "世界编号", branch: "世界线编号", operation: "操作编号", prompt: "提示词版本", diagnostic: "错误码", cost: "费用未知：尚未配置单价；Token 缺失时也无法据此估算账单。",
  error: "暂时无法读取调用记录。已有世界仍可查看；不会自动重新发送请求。", noEndpoint: "此处只保存模型名称、版本、次数和用量等诊断，不保存 Key、地址、提示词或响应正文。",
} as const;
export type CallMessageKey = keyof typeof messages;
export function callT(key: CallMessageKey): string { return messages[key]; }
