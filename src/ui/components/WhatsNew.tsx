// 这一版新增 (R13-T104): a quiet line on the home screen until it is read or
// dismissed, remembered per installed version, and the same notes from
// 设置 → 关于与更新. Never a pop-up that interrupts the start.
import { useEffect, useState } from "react";
import { useApp } from "../app/context";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** What this version adds, in the player's words: a name and one line each. Update with the version. */
const NOTES: [string, string][] = [
  ["生成档位", "快速、标准、深度三档，默认标准：少查资料、少绕弯，回复更快更省；点故事顶部“Aa”旁的小字切换。"],
  ["原著札记", "让 AI 先把原著的一段主线、一个人物或一个设定整理成札记，写作时只带用得着的；可以直接改，“查一查”的答案也能存成札记。"],
  ["每段用量", "最新一段下面一行小字：请求几次、多少 tokens、大约多少钱、用了几秒；⋯ 里看整局。"],
  ["让 AI 改设定", "设定卡、地点、时代卡和时间货币都能让 AI 按你的要求改，可选参考原著，看过再保存。"],
  ["两种首页", "场景（水墨山水里的上一本书）和书架（立体书本、抽出翻开），在 阅读与外观 里选。"],
  ["手机提醒", "写的时候通知栏显示进度和停止按钮；写好了带故事名和第一句，点开直达；没写完也会提醒。"],
];
const SUMMARY = "生成档位、原著札记、每段用量与两种新首页";

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
