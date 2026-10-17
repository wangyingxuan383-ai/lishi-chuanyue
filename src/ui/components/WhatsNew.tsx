// 这一版新增 (R13-T104): a quiet line on the home screen until it is read or
// dismissed, remembered per installed version, and the same notes from
// 设置 → 关于与更新. Never a pop-up that interrupts the start.
import { useEffect, useState } from "react";
import { useApp } from "../app/context";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** What this version adds, in the player's words: a name and one line each. Update with the version. */
const NOTES: [string, string][] = [
  ["四种玩法", "开新故事时可选：自由；剧本，先定主线和几幕；挑战，有目标、期限和成败；旁观，主角交给 AI 演，你在幕后指点，还能连播几段。"],
  ["自由世界", "仙侠、奇幻、科幻，或你喜欢的作品，都能开一局；模板只是灵感，世界由你来定。"],
  ["应用内更新", "安卓版在“设置 → 关于与更新”里直接下载新版，断了能接着下，校验无误才安装，存档不会丢。"],
  ["写作助手", "大输入框慢慢写，常用的行动存下来再用；AI 可以润色你的行动、改写段落，先看改稿再决定用不用。"],
  ["我的要求组", "常用的文风和规则存成一组，别的故事点一下就能用。"],
  ["设定集好找了", "按地点、势力、物品分类，可以搜索，也能一次删掉好几项。"],
  ["主角面板", "在本局设置里打开，记下境界、本事或约定，随时翻看。"],
  ["书架换了新封面", "每个故事是一册线装书，人物也有了自己的名章。"],
  ["花费心里有数", "设置 → 用量与花费：填上预算和单价，花到预算时提醒你一次。"],
  ["书摘连着几段", "做书摘卡时，可以把前面几段一起放进去。"],
];
const SUMMARY = "四种玩法、自由世界、应用内更新……";

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
