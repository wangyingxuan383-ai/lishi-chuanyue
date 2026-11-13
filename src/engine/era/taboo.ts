// Era vocabulary reminders used by native prompt templates and previews.
export interface TabooHit { term: string; instead: string | null }

const TABOO_LINE = /^\s*不要出现\s*[：:]\s*(.*)$/;

/** The entries of an era card's "不要出现：" line (a full- or half-width colon), or null when it has none. */
export function tabooLine(content: string | null | undefined): string | null {
  for (const line of (content ?? "").split("\n")) {
    const m = TABOO_LINE.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/** The card text with at most `max` entries on its "不要出现" line: a short reminder, not a rulebook. */
export function shortTabooLine(content: string, max: number): string {
  return content.split("\n").flatMap((line) => {
    const m = TABOO_LINE.exec(line);
    if (!m) return [line];
    const items = m[1].split(/[；;]/).map((s) => s.trim()).filter(Boolean).slice(0, max);
    return items.length ? [`不要出现：${items.join("；")}`] : [];
  }).join("\n");
}

/** The reminder the next turn gets. */
export function tabooReminder(hits: TabooHit[]): string {
  if (!hits.length) return "";
  return `\n【用词提醒】上一段用了这个时代不该有的说法：${hits.map((h) => `“${h.term}”${h.instead ? `（该用：${h.instead}）` : ""}`).join("、")}。之后不要再用，已经写出的不必解释。`;
}
