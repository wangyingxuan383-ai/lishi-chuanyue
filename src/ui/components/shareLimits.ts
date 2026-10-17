/** Bound canvas allocation before drawing. Text is never silently truncated. */
export function checkCardSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
    || width > 8192 || height > 8192 || width * height > 12_000_000) {
    throw new Error("这张图太长了，请少选几段，或从首页导出成小说文本。");
  }
}
export function checkCardText(text: string) {
  if (text.length > 24_000) throw new Error("这张图文字太多，请少选几段，或从首页导出成小说文本。");
}
