// 这一版新增 (R13-T104): a quiet line on the home screen until it is read or
// dismissed, remembered per installed version, and the same notes from
// 设置 → 关于与更新. Never a pop-up that interrupts the start.
import { useEffect, useState } from "react";
import { useApp } from "../app/context";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** What this version adds, in the player's words: a name and one line each. Update with the version. */
const NOTES: [string, string][] = [
  ["AI 改写：按我的要求改", "直接说正确的事实，这段、本回合记录和之前的设定一起改。按原著纠错查不到依据时也会直说。"],
  ["设定集记得住主角的本事", "武魂、魂环、等级这些记在“主角名的本事”卡里，随剧情更新，每段都带上；用不上的卡会自己清掉。"],
  ["每个故事都有自己的札记", "“本局札记”从这局写出的故事里整理主线、人物和地点；主线梗概随章节摘要自动跟上。在 ⋯ → 札记 里看。"],
  ["札记能接着更新，也能带到下一局", "原著札记可以续整理到后面的章节，本局札记可以更新到现在，能恢复上一版。开新故事时可以带上以前的札记。"],
  ["札记卡住的几章不再挡路", "一直被服务拒绝的地方会自动换说法、跳过一小段并写明，札记照常用于写作。"],
  ["提醒有声音了", "“写好了”“没写完”会响铃和振动，设置 → 通知与提醒里可以关或试一下。"],
  ["原著进度跟着剧情走", "同人沿原剧情写时自动往后跟，跟错了一点就能改回。"],
  ["备用服务和速度体检", "主服务出错时由备用服务接着写；设置 → 用量与花费 → 速度，看时间花在哪、换更快的整理用模型。"],
];
const SUMMARY = "本局札记、札记更新与带到下一局、提醒有声音";

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
