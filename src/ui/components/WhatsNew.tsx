// 这一版新增: a quiet line on the home screen until it is read or dismissed,
// remembered per installed version, and the same notes from 设置 → 关于与更新.
import { useEffect, useState } from "react";
import { useApp } from "../app/context";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** What this version adds, in the player's words: a name and one line each. Update with the version. */
const NOTES: [string, string][] = [
  ["内建轻阅读器与左右翻页", "支持直接沉浸阅读书库中的原著与本局故事小说版，可随时在「上下滚动」与「左右翻页」间切换，还支持三色划线批注与一键做书摘卡。"],
  ["导出正式小说与电子书", "一键把走过的故事排成干净的章回小说（自动隐去操作指令、补齐章回、可选人物小传与大事纪年），支持标准 EPUB 电子书、精排文本与 Markdown。"],
  ["双首页焕新、人物脉络与双端提醒", "升级山水场景与立体线装书架双首页、国风印鉴题签与全套线条图标，新增人物出场脉络速览、手机与电脑有声横幅提醒，以及可选的无线网自动准备更新。"],
];
const SUMMARY = "内建阅读器、左右翻页、导出 EPUB 小说、双首页焕新与双端有声提醒";

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
