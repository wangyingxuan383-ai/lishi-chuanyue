// 这一版新增: a quiet line on the home screen until it is read or dismissed,
// remembered per installed version, and the same notes from 设置 → 关于与更新.
import { useEffect, useState } from "react";
import { useApp } from "../app/context";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** What this version adds, in the player's words: a name and one line each. Update with the version. */
const NOTES: [string, string][] = [
  ["伴聊「改档」即连即用与交互补全", "修复在伴聊切到「改档」时误报未保存自定义接口地址的问题，完善 Gemini 地址兼容与删旧服务自动回退；修复「读全书」误显防剧透节数与引文锁章，角色卡切挡自动展示对应快捷提问，并补齐内置「改档设置」、实时步骤与追问确认弹窗。"],
  ["同人跨章自动跟进与场外提问引导", "同人故事在默认「允许改写原著」下随剧情自动跨章更新原著参考进度，全书允许范围内查资料不再卡在开局前几章；故事页输入栏支持一键「查一查」，在「做」模式下直接输入场外提问会贴心提示转交查证、不污染小说正文。"],
  ["纯小说正文排版与深度档提速", "严禁 AI 将场外说明报告写进小说正文，自动净化新旧段落中的星号加粗与横线分隔符；收紧深度档查阅轮次并优化原著核对，不再把主角蝴蝶效应误标为待查，本段写作耗时与后台整理耗时分开显示。"],
  ["阅读器翻页保位、听书解耦与书斋细节", "左右翻页调整字号、行距或字体后稳守当前段落，滚动模式开放音量键翻页开关；离线听书自动释放音量键、保持常亮并遵守防剧透上限；支持清空藏书作者、成书入藏原位去重更新，修复安卓分屏/小窗选文件被提前取消的问题。"],
];
const SUMMARY = "修复伴聊改档报错、同人跨章跟进与场外提问引导、阅读器翻页保位";

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
