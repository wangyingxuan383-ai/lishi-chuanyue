// 这一版新增: a quiet line on the home screen until it is read or dismissed,
// remembered per installed version, and the same notes from 设置 → 关于与更新.
import { useEffect, useState } from "react";
import { useApp } from "../app/context";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** What this version adds, in the player's words: a name and one line each. Update with the version. */
const NOTES: [string, string][] = [
  ["全面开放全书原著查阅，告别防剧透打断", "去掉阅读器、选段问伴聊、全局伴聊与原著札记中的「防剧透 / 截至指定章节 / 未解锁」限制（历史旧存档也自动解锁全书），同时继续保留同人故事自动跟进「原著位置」与按需指定章节区间查证的能力。"],
  ["千章长篇百章札记引导与标题自动同步", "超过 150 章的原著自动提示按百章分卷新建札记并提供一键步进；札记「续整理 / 更新到现在」默认支持零额外请求自动同步更新标题（点恢复上一版时旧标题一并还原），且空白材料或未配 AI 时不再误锁已完成札记。"],
  ["存档备份保护、书斋写时复制与导出加固", "首页覆盖导入若遇自动备份失败会立即中止以保护原进度，导入前拦截损坏角色状态；对已引用藏书重分章节或多分支故事二次成书自动另存新卷、不破坏旧故事导出，双端自动清洗特殊符号文件名并修复安卓选文件偶发占用卡住。"],
  ["滚动阅读精准定位、跨世界线批注隔离与改档顺畅", "修复默认上下滚动模式下恢复上次位置、搜索跳转、书签与摘录跳转闪回章首的问题；故事小说阅读按世界线严格隔离批注、书签与进度；修复待确认改档预览在继续游玩后可重新校对或放弃草稿，完善 EPUB 解析与离线听书跨空节续播。"],
];
const SUMMARY = "全面开放原著全书查阅、百章札记引导、滚动阅读定位与存档安全加固";

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
