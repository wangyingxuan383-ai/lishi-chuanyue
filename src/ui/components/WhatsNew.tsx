// 这一版新增: a quiet line on the home screen until it is read or dismissed,
// remembered per installed version, and the same notes from 设置 → 关于与更新.
import { useEffect, useState } from "react";
import { useApp } from "../app/context";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** What this version adds, in the player's words: a name and one line each. Update with the version. */
const NOTES: [string, string][] = [
  ["应用内更新直达安装与听书打断平缓暂停", "修复在更新弹窗内下载校验完成后按钮未直接切换为「安装」、以及前台下载抢占后台预下载时进度停滞的问题；安卓离线听书遇到来电或系统音频打断时改为自动暂停，不再误报未装语音引擎。"],
  ["伴聊「改档」指定章节区间与跨线校对精准对齐", "修复选用非首章起始范围（如第 3 章起）转交改档修改参考书时的章号偏移与检索遗漏，本局故事札记不再受参考书区间屏蔽；修复跨世界线重校对残留旧路线，以及多分支改开场后删旧分支导致导出无法再导入的问题。"],
  ["札记中途恢复无损与书斋派生书卷清晰区分", "札记在「续整理 / 更新到现在」中途暂停或失败后，点恢复可完整退回紧邻上一版正文、标题与待补缺口；已引用藏书重分章节或多分支二次成书自动标注「（重分章）」「（新编）」，常驻显示总节数并继承同线书签批注与进度。"],
  ["小说模式卷首跨线隔离与原著全书开放", "把故事当小说阅读时，「卷首 / 附录」书签划线按世界线严格隔离并清理失配孤立眉批；延续全书原著无剧透锁开放查阅、千章长篇每百章新建札记引导与续整理标题自动同步。"],
];
const SUMMARY = "更新弹窗直达安装、听书打断自动暂停、改档章节对齐与札记/书斋细节打磨";

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
