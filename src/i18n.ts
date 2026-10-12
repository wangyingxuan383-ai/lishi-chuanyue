// Stable UI keys are the starting point for later language catalogs.
// This probe currently offers only Simplified Chinese.
export const locale = "zh-CN";

const messages = {
  "probe.page.stage": "M01 · 平台技术探针",
  "probe.page.title": "AI 历史穿越模拟器",
  "probe.page.description": "验证原生核心连接、中文通信与本地测试笔记。",
  "probe.page.footer": "当前页面用于 M01 技术验证，游戏功能尚未实现。",
  "probe.core.heading": "核心连接",
  "probe.core.loading": "正在读取核心信息",
  "probe.core.unavailable": "未连接原生核心",
  "probe.core.connected": "原生核心已连接",
  "probe.core.failed": "核心连接失败",
  "probe.core.refreshBusy": "读取中…",
  "probe.core.refresh": "刷新状态",
  "probe.core.version": "核心版本",
  "probe.core.platform": "运行平台",
  "probe.core.browserNotice": "当前为浏览器页面。请在 Windows 应用或 Android APK 中打开，验证真实的原生通信。",
  "probe.echo.heading": "中文往返",
  "probe.echo.description": "输入内容会发送给 Rust 核心，再显示核心返回的原文和计数。",
  "probe.echo.inputLabel": "测试文本",
  "probe.echo.inputHelp": "Enter 换行；点击按钮发送。文本只用于本次往返检查。",
  "probe.echo.sample": "我来到长安。\n钥匙🔑还在。",
  "probe.echo.sendBusy": "等待核心回传…",
  "probe.echo.send": "发送到核心",
  "probe.echo.matches": "回传内容与发送原文一致",
  "probe.echo.mismatch": "回传内容与发送原文不一致，请检查核心通信",
  "probe.echo.scalarCount": "Unicode 标量数",
  "probe.echo.byteCount": "UTF-8 字节数",
  "probe.echo.returnedText": "核心返回原文",
  "probe.echo.empty": "（空文本）",
  "probe.note.heading": "SQLite 测试笔记",
  "probe.note.description": "用于 M01 持久化验证，测试数据不是真实游戏存档。读写由 Rust 核心在应用私有目录完成。",
  "probe.note.unavailable": "未连接原生核心，笔记读取和保存不可用。",
  "probe.note.inputLabel": "编辑测试笔记",
  "probe.note.inputHelp": "当前 {byteCount} 字节 / 65,536 字节（64 KiB）上限，超限由核心拒绝。重新读取保留当前编辑内容。",
  "probe.note.saveBusy": "正在保存…",
  "probe.note.save": "保存测试笔记",
  "probe.note.readBusy": "正在读取…",
  "probe.note.read": "重新读取",
  "probe.note.readPreserved": "已重新读取保存记录；当前编辑内容保留。",
  "probe.note.readConfirmed": "已读取核心中的测试笔记。",
  "probe.note.saveConfirmed": "保存已由核心确认，修订号 {revision}。",
  "probe.note.saveWithNewEdits": "本次文本已保存为修订 {revision}；保存期间的新编辑尚未保存。",
  "probe.note.savedHeading": "最近确认已保存的测试笔记",
  "probe.note.notRead": "尚未从核心取得保存记录。",
  "probe.note.notSaved": "核心中还没有已保存的测试笔记。",
  "probe.note.revision": "修订号",
  "probe.note.savedTime": "保存时间（北京时间）",
  "probe.note.empty": "（空笔记）",
  "probe.error.unavailable": "未连接原生核心，请在 Windows 应用或 Android APK 中运行此探针。",
  "probe.error.nativeCall": "原生核心调用失败，请刷新核心状态后重试。",
  "probe.error.infoFormat": "核心信息格式不符合约定，请检查前后端版本。",
  "probe.error.echoFormat": "回传结果格式不符合约定，请检查前后端版本。",
  "probe.error.noteFormat": "测试笔记返回格式不符合约定，请重新读取核实。",
  "probe.error.noteRead": "测试笔记读取失败，请重新读取后重试。",
  "probe.error.noteSaveUnconfirmed": "测试笔记保存结果未确认，请重新读取核实。编辑内容仍保留。",
  "probe.error.noteMismatch": "核心返回的笔记与本次保存文本不一致，请重新读取核实。编辑内容仍保留。",
  "probe.error.noteTooLarge": "测试笔记超过 64 KiB，请减少内容后重试。",
  "probe.error.storageFailed": "本地数据库操作失败，请重新读取核实。",
  "probe.error.savedTimeInvalid": "核心返回的保存时间无效",
  "probe.error.unknown": "探针调用失败，请刷新后重试。",
  "probe.error.missingRoot": "页面缺少 React root 容器。",
} as const;

export type MessageKey = keyof typeof messages;

type PlaceholderNames<Text extends string> =
  Text extends `${string}{${infer Name}}${infer Remaining}`
    ? Name | PlaceholderNames<Remaining>
    : never;

type TranslationArgs<Key extends MessageKey> =
  [PlaceholderNames<(typeof messages)[Key]>] extends [never]
    ? []
    : [params: Record<PlaceholderNames<(typeof messages)[Key]>, string | number>];

export function t<Key extends MessageKey>(key: Key, ...args: TranslationArgs<Key>): string {
  const params = args[0] as Record<string, string | number> | undefined;
  return messages[key].replace(/\{([^}]+)\}/g, (placeholder, name: string) => {
    const value = params?.[name];
    return value === undefined ? placeholder : String(value);
  });
}
