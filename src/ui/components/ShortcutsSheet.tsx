// The list of desktop keyboard shortcuts, opened with ? or Ctrl+/ and from
// the play screen's ⋯ menu on a computer.
import { Sheet } from "./Sheet";

const KBD: React.CSSProperties = { fontFamily: "var(--sans)", fontSize: 13, padding: "1px 6px", border: "1px solid var(--line)", borderRadius: 4, background: "var(--surface)", whiteSpace: "nowrap" };

export const SHORTCUTS: [string, string][] = [
  ["Enter", "发送（Shift+Enter 换行）"],
  ["Ctrl+Enter", "发送（任何输入方式下都行）"],
  ["Alt+1～4", "选第 1～4 个建议行动"],
  ["Ctrl+K 或 /", "把光标放进输入框"],
  ["Ctrl+Z", "撤销"],
  ["Ctrl+Y 或 Ctrl+Shift+Z", "重做"],
  ["Ctrl+R", "重说这一段"],
  ["Ctrl+F", "查一查"],
  ["Ctrl+,", "设置"],
  ["F1", "游玩指南"],
  ["Esc", "关掉弹出的面板，或返回上一页"],
  ["右键", "段落：打开这一段的菜单；首页故事：更多操作"],
  ["? 或 Ctrl+/", "打开这张快捷键表"],
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="快捷键" onClose={onClose}>
      <dl className="facts shortcut-list">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} style={{ display: "contents" }}>
            <dt><kbd style={KBD}>{keys}</kbd></dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <p className="muted" style={{ margin: 0 }}>在输入框里打字时，只有带 Ctrl、Alt 的组合键和 F1 起作用。</p>
    </Sheet>
  );
}
