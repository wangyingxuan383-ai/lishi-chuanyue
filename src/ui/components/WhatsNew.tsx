// 这一版新增: a quiet line on the home screen until it is read or dismissed,
// remembered per installed version, and the same notes from 设置 → 关于与更新.
import { useEffect, useState } from "react";
import { useApp } from "../app/context";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** What this version adds, in the player's words: a name and one line each. Update with the version. */
const NOTES: [string, string][] = [
  ["长篇书斋秒开与跨章连续听书", "数千章、数百万字的长篇小说点开即入正文、翻查目录顺滑不卡；无章节标题的长篇 TXT 导入自动分节并压缩占用，离线听书读完一章自动顺畅续播下一章，极速返回与切换翻页/滚动均稳记当前段落。"],
  ["同人深度模式与思考模型全面兼容", "提升单次生成上限并支持多级平滑降档，解决同人深度模式反复核对报错或写到一半断开的问题；全面兼容带深度思考的模型（连接测试不再误报空返回，彻底隔离内部思考草稿不混入正文）。"],
  ["全局流畅度与故事页细节打磨", "首页、故事页与选书面板消除重复加载骨架屏与掉帧；修复多行草稿被工具图标遮住、翻页模式从伴聊返回未刷新、聚焦输入框偶发整屏微偏，以及后台整理冲掉编辑框等问题。"],
  ["双主栏「书斋」与满配阅读套件（0.22）", "首页支持「穿越 ⇄ 书斋」切换（免配 AI 也能直接畅读本地小说），配备手机实体音量键翻页、仿真覆页动效、六套护眼纸色与深夜减光、防剧透问伴聊及宋韵书卷图标。"],
];
const SUMMARY = "长篇书斋秒开与跨章听书、同人深度与思考模型兼容、全局丝滑度修复";

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
