import { memo } from "react";
import type { Chip, TurnRecord } from "../../../engine/state/apply";
import type { StoryNode } from "../../../engine/types";
import { useApp } from "../../app/context";
import { StoryText } from "../../components/StoryText";
import { useLongPress } from "../../components/useLongPress";
import { ChipRow } from "./ChipRow";
import { ReportCard } from "./ReportCard";

// Memoized: while a new passage streams in, earlier turns do not re-render (R26-T008).
export const TurnView = memo(function TurnView({ node, onMenu, pressed, watch, children }: { node: StoryNode; onMenu: (n: StoryNode) => void; pressed?: boolean; watch?: boolean; children?: React.ReactNode }) {
  const press = useLongPress(() => onMenu(node));
  const { devMode } = useApp();
  // Developer mode: era words the local check found (R07-T002).
  const taboos = devMode ? ((node.meta.taboos as { term: string; instead: string | null }[] | undefined) ?? []) : [];
  const referenceReview = node.meta.referenceReview as { findings?: { claim: string; status: string }[]; unresolved?: string[] } | undefined;
  // A summary already in the player's words (“你修改了剧本”) is shown as it is.
  if (node.kind === "edit") return <div className="edit-line" data-node-id={node.id}>{node.meta.by === "AI" || node.actionText?.startsWith("你") ? node.actionText : `你修改了：${node.actionText}`}</div>;
  return (
    <div className={`turn${pressed ? " pressed" : ""}`} data-node-id={node.id} {...press}>
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
      <ChipRow chips={[...((node.meta.chips as Chip[]) ?? []), ...taboos.map((t) => ({ text: `用词：${t.term}${t.instead ? ` → ${t.instead}` : ""}`, tone: "warn" as const }))]} />
      {referenceReview && <details className="muted"><summary>原著核对{referenceReview.unresolved?.length ? ` · ${referenceReview.unresolved.length}项待查` : ""}</summary>{referenceReview.findings?.map((f, i) => <p key={i}>{f.claim} · {f.status === "supported" ? "有原文依据" : f.status === "branch" ? "保留玩家分支" : "资料不足"}</p>)}{referenceReview.unresolved?.map((t, i) => <p key={`u${i}`}>{t}</p>)}</details>}
      {children}
    </div>
  );
});
