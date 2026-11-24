// 这一版新增: a quiet line on the home screen until it is read or dismissed,
// remembered per installed version, and the same notes from 设置 → 关于与更新.
import { useEffect, useState } from "react";
import { useApp } from "../app/context";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** What this version adds, in the player's words: a name and one line each. Update with the version. */
const NOTES: [string, string][] = [
  ["双主栏焕新首页与一级「书斋」", "首页彻底重塑山水画卷与温润博古书阁，并新增一级轻量化小说阅读器「书斋」——无需连接 AI 即可直接导入并畅读 TXT、EPUB、PDF、DOCX 小说，支持换封皮、置顶与阅读统计。"],
  ["满配左右翻页、音量键与离线听书", "补齐手机实体音量上下键翻页、单手躺读点击区、仿真覆页等四档翻页动效、底栏常驻时间电量与全书进度、六套护眼纸色与深夜减光、回到刚才位置、TXT 正则重分章及离线语音听书。"],
  ["全新宋韵书卷图标与展卷开屏礼", "启用全新「宋韵书卷·流金朱印」桌面图标与落印展卷启动动画，点击书封无缝展开书页，划线选段可一键防剧透询问伴聊。"],
];
const SUMMARY = "新桌面图标与开屏动画、双主栏首页与免 AI 小说书斋、音量键翻页、护眼纸色与离线听书";

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
