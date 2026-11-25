import { memo } from "react";
import type { Chip, TurnRecord } from "../../../engine/state/apply";
import type { StoryNode } from "../../../engine/types";
import { useApp } from "../../app/context";
import type { Tab } from "../../components/Panel";
import { StoryText } from "../../components/StoryText";
import { useLongPress } from "../../components/useLongPress";
import { TurnChanges } from "./TurnChanges";
import { ReportCard } from "./ReportCard";

// Memoized: while a new passage streams in, earlier turns do not re-render (R26-T008).
export const TurnView = memo(function TurnView({ node, onMenu, onPanel, onSourceBack, onNotes, onCanonCheck, onAskCanon, pressed, fresh, watch, children }: { node: StoryNode; onMenu: (n: StoryNode) => void; onPanel?: (tab?: Tab) => void; /** Head passage only: put the book position back where it was (D178). */ onSourceBack?: (position: number) => void; onNotes?: () => void; onCanonCheck?: (node: StoryNode) => void; onAskCanon?: (initialQuestion: string) => void; pressed?: boolean; fresh?: boolean; watch?: boolean; children?: React.ReactNode }) {
  const press = useLongPress(() => onMenu(node));
  const { devMode } = useApp();
  // Developer mode: era words the local check found (R07-T002).
  const taboos = devMode ? ((node.meta.taboos as { term: string; instead: string | null }[] | undefined) ?? []) : [];
  const advanced = node.meta.sourceAdvanced as { from?: number; to?: number; fromTitle?: string; toTitle?: string } | undefined;
  const sourceBack = onSourceBack && typeof advanced?.from === "number"
    ? { label: `原著进度改回第 ${advanced.from + 1} 节`, run: () => onSourceBack(advanced.from!) }
    : undefined;
  const referenceReview = node.meta.referenceReview as {
    status?: string;
    reason?: string;
    findings?: { claim: string; status: string }[];
    issues?: { quote?: string; problem?: string; fix?: string }[];
    unresolved?: string[];
    needsPlayer?: string | string[];
  } | undefined;
  const reviewFindings = referenceReview?.findings ?? [];
  const reviewIssues = referenceReview?.issues ?? [];
  const reviewUnresolved = referenceReview?.unresolved ?? [];
  const rawNeedsPlayer = referenceReview?.needsPlayer;
  const reviewNeedsPlayer = Array.isArray(rawNeedsPlayer)
    ? rawNeedsPlayer.filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
    : typeof rawNeedsPlayer === "string" && rawNeedsPlayer.trim()
      ? [rawNeedsPlayer.trim()]
      : [];
  const distinctNeedsPlayer = reviewNeedsPlayer.filter((q) => !reviewUnresolved.some((u) => u.includes(q)));
  const pendingReviewCount = reviewUnresolved.length + distinctNeedsPlayer.length;
  const reviewSkipped = referenceReview?.status === "skipped";
  const reviewPartial = referenceReview?.status === "partial";
  const reviewEmpty = reviewFindings.length === 0 && reviewIssues.length === 0 && pendingReviewCount === 0;
  // A summary already in the player's words (“你修改了剧本”) is shown as it is.
  if (node.kind === "edit") return <div className="edit-line" data-node-id={node.id}>{node.meta.by === "AI" || node.actionText?.startsWith("你") ? node.actionText : `你修改了：${node.actionText}`}</div>;
  return (
    <div className={`turn${pressed ? " pressed" : ""}${fresh ? " fresh" : ""}`} data-node-id={node.id} {...press}>
      {node.kind !== "opening" && node.actionMode === "write" && node.actionText && (
        <div className="turn-written"><StoryText text={node.actionText} /></div>
      )}
      {node.kind !== "opening" && node.actionMode !== "continue" && node.actionMode !== "write" && node.actionText && (
        <div className={`turn-action ${node.actionMode ?? ""}`}>{node.actionText}</div>
      )}
      {/* 旁观 passages follow one another without a “（继续）” before each. */}
      {node.kind !== "opening" && node.actionMode === "continue" && !watch && <div className="turn-action continue">（继续）</div>}
      <StoryText text={node.narrative} />
      {node.rewritten && <span className="rewritten-mark">已改写</span>}
      {node.actionMode === "skip" && <ReportCard report={(node.record as TurnRecord | null)?.report} />}
      <TurnChanges onPanel={onPanel} fresh={fresh} extra={sourceBack} notes={node.meta.notesUsed as string[] | undefined} onNotes={onNotes} chips={[...((node.meta.chips as Chip[]) ?? []), ...taboos.map((t) => ({ text: `用词：${t.term}${t.instead ? ` → ${t.instead}` : ""}`, tone: "warn" as const }))]} />
      {referenceReview && (
        <details className="ref-review">
          <summary>
            <span>原著核对</span>
            {reviewSkipped
              ? <span className="ref-pill warn">未核对</span>
              : pendingReviewCount
                ? <span className="ref-pill warn">{pendingReviewCount} 项待查</span>
                : reviewPartial
                  ? <span className="ref-pill warn">部分核对</span>
                  : reviewIssues.length
                    ? <span className="ref-pill ok">{reviewIssues.length} 处已校对</span>
                    : <span className="ref-pill ok">已核对</span>}
          </summary>
          <div className="ref-review-body">
            {reviewIssues.map((item, i) => (
              <p key={`i${i}`} className="ref-row">
                <span className="ref-badge ok">已校正</span>
                <span>
                  {item.problem ? `${item.problem}：` : ""}
                  {item.quote && item.fix ? `「${item.quote}」→「${item.fix}」` : item.fix || item.quote || "已按原著修正"}
                </span>
              </p>
            ))}
            {reviewFindings.map((f, i) => (
              <p key={i} className="ref-row">
                <span className={`ref-badge ${f.status === "supported" ? "ok" : f.status === "branch" ? "branch" : "warn"}`}>
                  {f.status === "supported" ? "原文依据" : f.status === "branch" ? "玩家分支" : "资料不足"}
                </span>
                <span>{f.claim}</span>
              </p>
            ))}
            {reviewUnresolved.map((t, i) => (
              <p key={`u${i}`} className="ref-row">
                <span className="ref-badge warn">待查</span>
                <span>{t}</span>
              </p>
            ))}
            {distinctNeedsPlayer.map((t, i) => (
              <p key={`np${i}`} className="ref-row">
                <span className="ref-badge branch">待确认</span>
                <span>{t}</span>
              </p>
            ))}
            {reviewEmpty && (
              <p className="ref-row muted">
                {reviewSkipped
                  ? referenceReview?.reason === "no_passages"
                    ? "本回合未取到可用的原著原文，未做原著核对。可在长按菜单里用“按原著纠错”指定章节核对。"
                    : "本次原著核对未完成，正文保留原稿。"
                  : "已核对，未发现与原著冲突。"}
              </p>
            )}
            {(reviewUnresolved.length > 0 || reviewNeedsPlayer.length > 0) && (onCanonCheck || onAskCanon) && (
              <div className="row gap-2 ref-review-actions">
                {onCanonCheck && (
                  <button type="button" className="ghost small" onClick={(e) => { e.stopPropagation(); onCanonCheck(node); }}>
                    按原著纠错
                  </button>
                )}
                {onAskCanon && (
                  <button type="button" className="ghost small" onClick={(e) => { e.stopPropagation(); onAskCanon(reviewUnresolved[0] ?? reviewNeedsPlayer[0] ?? ""); }}>
                    去查一查
                  </button>
                )}
              </div>
            )}
          </div>
        </details>
      )}
      {children}
    </div>
  );
});
