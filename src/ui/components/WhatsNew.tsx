// 这一版新增 (R13-T104): a quiet line on the home screen until it is read or
// dismissed, remembered per installed version, and the same notes from
// 设置 → 关于与更新. Never a pop-up that interrupts the start.
import { useEffect, useState } from "react";
import { useApp } from "../app/context";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** What this version adds, in the player's words: a name and one line each. Update with the version. */
const NOTES: [string, string][] = [
  ["墨韵风格", "新中式的卡片风格，有浅色和深色；默认仍是宣纸书卷，在“Aa”或阅读与外观里切换。"],
  ["读的地方更大", "建议选项放进故事里的“接下来”，底部只剩一条输入栏；点选项不清掉你在写的字。"],
  ["写时可离开", "返回书架后故事在后台接着写，书架上显示“正在写…”。"],
  ["变化一目了然", "每段的变化收成一行，点开分类查看，还能直接去角色面板修改。"],
  ["华丽动画", "开书、翻页、墨迹成字、金光、朱印盖下……也可以在设置里改成简洁或关闭。"],
  ["新图标与字体", "墨底朱印的新图标；自带思源宋体，各手机上都是书卷气的宋体。"],
];
const SUMMARY = "墨韵风格、正文里的选项与华丽动画";

export function WhatsNewSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="这一版新增" onClose={onClose}>
      <div className="stack whats-new-body">
        <p className="muted">版本 {__APP_VERSION__}</p>
        <dl className="whats-new-list">
          {NOTES.map(([name, line]) => <div key={name}><dt>{name}</dt><dd>{line}</dd></div>)}
        </dl>
        <button className="primary" onClick={onClose}>知道了</button>
      </div>
    </Sheet>
  );
}

/** The home screen's line for a version not seen yet. */
export function WhatsNewNotice() {
  const { game, toast } = useApp();
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    void game.repo.getSetting("whatsNewSeen", "")
      .then((seen) => { if (live) setVisible(seen !== __APP_VERSION__); })
      .catch(() => {});
    return () => { live = false; };
  }, [game]);
  const dismiss = async () => {
    try {
      await game.repo.setSetting("whatsNewSeen", __APP_VERSION__);
      setVisible(false);
      setOpen(false);
    } catch {
      toast("没能保存，下次还会显示这一条");
    }
  };
  if (!visible) return null;
  // The sheet is a sibling of the line, not inside it: a fixed sheet inside an
  // animated box would be laid out within that box instead of the screen.
  return (
    <>
      <div className="whats-new">
        <button className="whats-new-open" aria-label={`看看新增：${SUMMARY}`} onClick={() => setOpen(true)}>
          <span className="whats-new-mark" aria-hidden="true">新</span>
          <span className="whats-new-text"><b>这一版新增</b><small>{SUMMARY}</small></span>
          <Icon name="forward" size={18} />
        </button>
        <button className="icon-btn whats-new-close" aria-label="知道了" onClick={() => void dismiss()}><Icon name="close" size={20} /></button>
      </div>
      {open && <WhatsNewSheet onClose={() => void dismiss()} />}
    </>
  );
}
