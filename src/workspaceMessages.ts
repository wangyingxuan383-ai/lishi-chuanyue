const workspaceMessages = {
  "workspace.navigation": "世界导航",
  "workspace.story": "剧情",
  "workspace.state": "人物与状态",
  "workspace.branches": "世界线",
  "workspace.memory": "记忆",
  "workspace.fast": "快进",
  "workspace.research": "历史资料",
  "workspace.saves": "存档",
  "workspace.worlds": "切换世界",
  "workspace.settings": "叙事与接口",
  "workspace.close": "收起",
  "workspace.latest": "跳到最新剧情",
  "workspace.action": "写下行动",
  "workspace.backToTask": "返回正在处理的页面",
  "workspace.working": "操作处理中，请等待完成或回到原页面取消。",
  "workspace.draft": "未提交的行动仅保留在当前窗口；切换世界线后可以继续编辑。关闭应用后不会自动执行或保留。",
  "workspace.anchorYear": "开局纪年：{year}",
  "workspace.branch": "当前世界线：{name}",
  "workspace.empty": "创建或导入一个世界，开始你的故事。",
  "workspace.waitingSaves": "正式存档管理正在接入。",
} as const;
export type WorkspaceMessageKey = keyof typeof workspaceMessages;
export function workspaceT(key: WorkspaceMessageKey, values: Record<string, string | number> = {}): string {
  return workspaceMessages[key].replace(/\{([^}]+)\}/g, (placeholder, name: string) => values[name] === undefined ? placeholder : String(values[name]));
}
