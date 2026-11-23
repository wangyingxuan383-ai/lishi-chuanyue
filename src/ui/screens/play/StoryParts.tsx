// Pieces of the story stream (R28 第二批, D160): the choices under the latest
// passage, its tool row, the passage being written and the notice card.
import { useMemo, useState } from "react";
import type { StoryNode } from "../../../engine/types";
import { useApp } from "../../app/context";
import { FailureSheet } from "../../components/FailureSheet";
import type { Variants } from "../../../engine/tree";
import { Icon, type IconName } from "../../components/Icon";
import { StoryText } from "../../components/StoryText";
import { RunUsageLine } from "../../components/TurnUsage";
import { DiffView } from "../../components/WritingAssist";
import { diffStats, diffText } from "../../components/textDiff";
import { useLongPress } from "../../components/useLongPress";
import { ChoiceButton } from "./ChoiceButton";
import type { Gen } from "./types";
import type { Notice, NoticeAction } from "./useGeneration";

/** 接下来: the suggested next moves, in the story right after the latest passage. */
export function NextChoices({ choices, watch, mouse, onPick, onFill }: {
  choices: string[]; watch?: boolean; mouse: boolean; onPick: (text: string) => void; onFill: (text: string) => void;
}) {
  return (
    <section className="next-choices" aria-label="接下来">
      <h3 className="next-head"><span>{watch ? "接下来可以" : "接下来"}</span></h3>
      <div className="choices">
        {choices.map((choice, i) => <ChoiceButton key={choice} text={choice}
          title={mouse ? `${i < 4 ? `Alt+${i + 1} 选这个，` : ""}右键放进输入框改一改` : undefined}
          onTap={() => onPick(choice)} onLong={() => onFill(choice)} />)}
      </div>
    </section>
  );
}

function ToolButton({ icon, label, title, onTap, onLong, disabled }: { icon: IconName; label: string; title?: string; onTap: () => void; onLong?: () => void; disabled?: boolean }) {
  const press = useLongPress(onLong ?? onTap, onTap);
  return <button className="tool-btn" title={title} disabled={disabled} {...(onLong ? press : { onClick: onTap })}><Icon name={icon} size={18} /><span>{label}</span></button>;
}

function variantOrigin(node: StoryNode, index: number): string {
  if (index === 0) return "原版";
  if (typeof node.meta.rewriteHint === "string" && node.meta.rewriteHint.trim()) {
    const h = node.meta.rewriteHint.trim();
    return h.length > 10 ? `${h.slice(0, 10)}…` : h;
  }
  const rev = node.meta.revision && typeof node.meta.revision === "object"
    ? (node.meta.revision as { kind?: string; hint?: string })
    : null;
  if (rev?.kind === "factSync" || node.meta.factSync) return "改后同步";
  if (rev?.kind === "canonCorrection" || node.meta.canonCorrection) return "原著纠错";
  if (rev?.kind === "playerRevision" || node.meta.playerRevision) {
    const h = typeof rev?.hint === "string" ? rev.hint.trim() : "";
    return h ? (h.length > 10 ? `${h.slice(0, 10)}…` : h) : "按要求改";
  }
  return "重说";
}

/** The latest passage's tools: versions, 重说 (long press: with a wish), 换个写法, 撤销, more. */
export function HeadTools({ node, variants, mouse, onSwitch, onRegen, onHints, onUndo, onMenu }: {
  node: StoryNode; variants: Variants | null; mouse: boolean;
  onSwitch: (delta: number) => void; onRegen: () => void; onHints: () => void; onUndo: () => void; onMenu: () => void;
}) {
  const [compare, setCompare] = useState(false);
  const multi = !!(variants && variants.count > 1);
  const baseIndex = multi ? (variants!.index === 0 ? 1 : 0) : -1;
  const baseNode = multi && baseIndex >= 0 ? variants!.siblings[baseIndex] : null;
  const stats = useMemo(() => (compare && baseNode ? diffStats(diffText(baseNode.narrative, node.narrative)) : null), [compare, baseNode, node.narrative]);
  return (
    <>
      <div className="turn-tools">
        {multi && variants && (
          <span className="variant-nav">
            <button className="icon-btn" aria-label="上一版" title="上一版" disabled={variants.index === 0} onClick={() => onSwitch(-1)}><Icon name="back" size={18} /></button>
            <span className="variant-count">{variants.index + 1}/{variants.count}</span>
            <button className="icon-btn" aria-label="下一版" title="下一版" disabled={variants.index === variants.count - 1} onClick={() => onSwitch(1)}><Icon name="forward" size={18} /></button>
            <span className="variant-origin">{variantOrigin(node, variants.index)}</span>
            <button type="button" className="ghost small variant-diff-btn" aria-pressed={compare} onClick={() => setCompare((v) => !v)}>{compare ? "收起对比" : "对比"}</button>
          </span>
        )}
        <ToolButton icon="refresh" label="重说" title={mouse ? "重说（Ctrl+R），右键选重说的要求" : undefined} onTap={onRegen} onLong={onHints} />
        <ToolButton icon="pen" label="换个写法" title="重说时提个要求" onTap={onHints} />
        {node.parentId && <ToolButton icon="undo" label="撤销" title={mouse ? "撤销这一段（Ctrl+Z）" : "撤销这一段"} onTap={onUndo} />}
        <button className="icon-btn tool-more" aria-label="这一段还能做什么" title={mouse ? "这一段还能做什么（也可以右键点这一段）" : undefined} onClick={onMenu}><Icon name="more" size={20} /></button>
      </div>
      {compare && baseNode && (
        <div className="variant-diff">
          <div className="row between">
            <small className="muted">与第 {baseIndex + 1} 版（{variantOrigin(baseNode, baseIndex)}）对照</small>
            {stats && <span className="diff-counts">{stats.removed > 0 && <em className="del">-{stats.removed}</em>}{stats.added > 0 && <em className="ins">+{stats.added}</em>}</span>}
          </div>
          <DiffView before={baseNode.narrative} after={node.narrative} />
        </div>
      )}
    </>
  );
}

/** The passage being written: the action, then an ink-brush wait until the first words, then the words. */
export function WritingTurn({ gen, statusText, waitLine, waited, slow }: { gen: Gen; statusText: string; waitLine: string; waited: number; slow: boolean }) {
  const detail = gen.detail || statusText;
  const phaseLabel = gen.phase === "organizing" ? "整理中"
    : gen.phase === "thinking" ? (detail.includes("翻查") ? "查原著" : detail.includes("核对") ? "核札记" : detail.includes("查阅") ? "查前情" : detail.includes("深度") ? "思考中" : "构思中")
    : "落笔中";
  return (
    <div className="turn writing-turn">
      {gen.action?.mode === "write" && gen.action.text && <div className="turn-written"><StoryText text={gen.action.text} /></div>}
      {gen.action && gen.action.mode !== "continue" && gen.action.mode !== "write" && gen.action.text && <div className={`turn-action ${gen.action.mode} flying`}>{gen.action.text}</div>}
      {gen.text ? <StoryText text={gen.text} streaming={gen.phase === "writing"} /> : (
        <div className="ink-wait" data-phase={gen.phase} role="status">
          <span className="ink-brush" aria-hidden="true"><i /><i /><i /></span>
          <div className="ink-wait-body">
            <span className="status-line">
              <span className="phase-pill">{phaseLabel}</span>
              <span className="cursor-blink">{detail || waitLine}</span>
              {waited >= 2 && <span className="waited">{waited} 秒</span>}
            </span>
            <span className="ink-progress" aria-hidden="true"><i /></span>
          </div>
        </div>
      )}
      {gen.text && detail && <p className="status-line">{detail}</p>}
      {slow && gen.text && <p className="status-line">还在写，稍等…（不想等可以点“停止”）</p>}
      {slow && !gen.text && waited >= 8 && <p className="status-line">还没收到回复，稍等…（不想等可以点“停止”）</p>}
    </div>
  );
}

/** What happened and what to do now; the first action is the main one. */
const PAUSED = new Set(["cancelled", "limit", "interrupted", "system_stop", "busy"]);

export function NoticeCard({ notice, onAction, onOpenUsage }: { notice: Notice; onAction: (action: NoticeAction) => void; onOpenUsage?: () => void }) {
  const { toast } = useApp();
  const [why, setWhy] = useState(false);
  const tone = notice.reason ? (PAUSED.has(notice.reason) ? "pause" : "bad")
    : /拒绝|失败|不对|没有权限|连不上|出了问题/.test(notice.text) ? "bad" : /停下|保存|中断|没有写完/.test(notice.text) ? "pause" : "info";
  const icon: IconName = tone === "bad" ? "alert" : tone === "pause" ? "hourglass" : "info";
  // A stopped or failed run keeps its cause and usage behind 查看明细 / 查看原因 (R31-P4).
  const explained = !!(notice.reason && (notice.failure || notice.detail || notice.runId));
  const promptBrief = (() => {
    const r = notice.restore;
    if (!r) return "";
    const parts = [r.text.trim(), r.note.trim() ? `幕后：${r.note.trim()}` : ""].filter(Boolean);
    const full = parts.join(" · ");
    return full.length > 64 ? `${full.slice(0, 64)}…` : full;
  })();
  return (
    <>
      {notice.partialText && (
        <div className="partial-prose" aria-label="已收到的未完成正文">
          <div className="partial-prose-head">
            <span>{notice.proseSaved ? "已收到的正文（待补记）" : "已收到的部分正文（仅供参考）"}</span>
            <button type="button" className="ghost small" onClick={() => void navigator.clipboard?.writeText(notice.partialText!).then(() => toast("已复制"), () => toast("没能复制"))}>复制</button>
          </div>
          <StoryText text={notice.partialText} />
        </div>
      )}
      <div className={`notice notice-${tone}`} role="status">
        <span className="notice-icon"><Icon name={icon} size={20} /></span>
        <div className="notice-body">
          <p>{notice.text}</p>
          {promptBrief && <p className="muted m-0">原输入：{promptBrief}</p>}
          <RunUsageLine runId={notice.runId} />
          {(notice.actions.length > 0 || explained) && <div className="notice-actions">
            {notice.actions.map((a, i) => <button key={a.label} className={i === 0 ? "primary" : ""} onClick={() => onAction(a)}>{a.label}</button>)}
            {explained && <button className="ghost" onClick={() => setWhy(true)}>{notice.reason === "cancelled" ? "查看明细" : "查看原因"}</button>}
          </div>}
        </div>
        {why && <FailureSheet text={notice.text} failure={notice.failure} failures={notice.failures} detail={notice.detail} runId={notice.runId} onOpenUsage={onOpenUsage} onClose={() => setWhy(false)} />}
      </div>
    </>
  );
}

/** What a milestone in a passage's changes is called on the stamp, if any (华丽 only). */
export function milestoneOf(texts: string[]): { label: string; sub: string } | null {
  const pick = (re: RegExp) => texts.find((t) => re.test(t));
  let hit: string | undefined;
  if ((hit = pick(/^完成|达成|挑战.*(成功|胜)/))) return { label: "达成", sub: hit.replace(/^完成[:：]\s*/, "") };
  if ((hit = pick(/幕演完/))) return { label: "幕终", sub: hit.replace(/^📜\s*/, "") };
  if ((hit = pick(/新支线|新目标|主线目标/))) return { label: "新篇", sub: hit.replace(/^(新支线|新目标|主线目标)[:：]\s*/, "") };
  if ((hit = pick(/^结识/))) return { label: "结识", sub: hit.replace(/^结识\s*/, "") };
  return null;
}

/** A cinnabar seal stamped down over the story, with ink splashing out. */
export function StampBurst({ label, sub }: { label: string; sub: string }) {
  const splashes = Array.from({ length: 12 }, (_, i) => ({ a: `${i * 30 + (i % 3) * 7}deg`, d: `${90 + ((i * 37) % 70)}px`, s: 6 + ((i * 5) % 8) }));
  return (
    <div className="stamp-layer" aria-hidden="true">
      {splashes.map((p, i) => <i key={i} className="stamp-splash" style={{ ["--a" as string]: p.a, ["--d" as string]: p.d, width: p.s, height: p.s }} />)}
      <div className="stamp">{label}{sub && <small>{sub.slice(0, 8)}</small>}</div>
    </div>
  );
}
