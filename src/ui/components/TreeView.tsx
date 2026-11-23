// The turn tree (PLAN §4.8, R06-T002): every branch of a world on a phone.
// Chains without a fork are folded into one row (a "segment"); forks nest
// under it. Routes, bookmarks and the current path are marked; any turn can
// be the place to carry on from.
import { useEffect, useMemo, useState } from "react";
import * as tree from "../../engine/tree";
import type { Line, StoryNode } from "../../engine/types";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import { editSummary, isStory, jumpTarget, lineMarks, rangeLabel, segments, type Segment } from "./treeSegments";

const brief = (text: string, max = 18) => {
  const t = text.replace(/\s+/g, "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

function SegmentRow({ seg, depth, marks, onPath, busy, onJump }: {
  seg: Segment; depth: number; marks: Map<string, string[]>; onPath: Set<string>; busy: boolean;
  onJump: (node: StoryNode, n: number, editOnly?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const turns = seg.nodes.filter(isStory);
  const numbered = turns.map((n, i) => ({ n, number: seg.first + 1 + i }));
  const pureEdit = numbered.length === 0;
  const editText = pureEdit ? editSummary(seg.nodes) : "";
  const range = numbered.length
    ? rangeLabel(numbered[0].number, numbered.at(-1)!.number)
    : seg.nodes.length > 1 ? `${seg.nodes.length} 处修改` : "修改";
  const labels = seg.nodes.flatMap((n) => marks.get(n.id) ?? []);
  const current = seg.nodes.some((n) => onPath.has(n.id));
  const head = turns[0];
  const last = turns.at(-1);
  const editBase = Math.max(0, seg.first);
  return (
    <div className="tree-seg" style={{ marginLeft: Math.min(depth, 5) * 14 }}>
      <button className={`tree-row${current ? " on-path" : ""}`} onClick={() => setOpen(!open)}>
        <span className="muted">{range}</span>
        <span>{head ? `${brief(head.kind === "opening" ? head.narrative : head.actionText || head.narrative)}${last && last !== head ? ` → ${brief(last.narrative, 14)}` : ""}` : brief(editText, 22)}</span>
        {labels.length > 0 && <span className="tree-marks">{labels.join(" · ")}</span>}
      </button>
      {open && <div className="tree-turns">
        {pureEdit ? (
          <div className="row">
            <small className="grow">{editBase === 0 ? "开场后修改" : `第 ${editBase} 回合后修改`}：{brief(editText, 24)}</small>
            <button className="ghost" disabled={busy} onClick={() => onJump(seg.nodes[seg.nodes.length - 1], editBase, true)}>从这里继续</button>
          </div>
        ) : numbered.map(({ n, number }) => (
          <div key={n.id} className="row">
            <small className="grow">{number === 0 ? "开场" : `第 ${number} 回合`}：{brief(n.actionText || n.narrative, 24)}</small>
            <button className="ghost" disabled={busy} onClick={() => onJump(jumpTarget(seg, n.id), number)}>从这里继续</button>
          </div>
        ))}
      </div>}
      {seg.children.map((c) => <SegmentRow key={c.nodes[0].id} seg={c} depth={depth + 1} marks={marks} onPath={onPath} busy={busy} onJump={onJump} />)}
    </div>
  );
}

export function TreeView({ worldId, busy = false, onClose, onJumped }: { worldId: string; busy?: boolean; onClose: () => void; onJumped: (message: string) => void }) {
  const { game } = useApp();
  const [data, setData] = useState<{ nodes: StoryNode[]; lines: Line[]; path: Set<string> } | null>(null);
  useEffect(() => {
    void (async () => {
      const [nodes, lines, c] = await Promise.all([game.repo.allNodes(worldId), game.repo.lines(worldId), tree.cursor(game.repo, worldId)]);
      const path = new Set((await game.repo.path(c.head.id)).map((n) => n.id));
      setData({ nodes, lines, path });
    })();
  }, [worldId]);
  const roots = useMemo(() => (data ? segments(data.nodes) : []), [data]);
  const marks = useMemo(() => lineMarks(data?.lines ?? []), [data]);
  const jump = async (node: StoryNode, number: number, editOnly = false) => {
    if (busy) return;
    const routeName = editOnly
      ? (number === 0 ? "从开场修改处重来的路" : `第 ${number} 回合修改后的另一条路`)
      : (number === 0 ? "从开场重来的路" : `第 ${number} 回合后的另一条路`);
    await tree.jumpTo(game.repo, worldId, node.id, routeName);
    onJumped(editOnly ? (number === 0 ? "已回到开场修改处" : `已回到第 ${number} 回合修改处`) : (number === 0 ? "已回到开场" : `已回到第 ${number} 回合`));
  };
  return (
    <Sheet title="回合树" onClose={onClose}>
      {busy && <p className="notice mt-0" role="status">正在续写故事，等这一段写完再从分支继续。</p>}
      <p className="muted mt-0">没有岔路的一段合成一行，点开能看每一回合。红框是你现在走的路。</p>
      <div className="tree">{data ? roots.map((root) => <SegmentRow key={root.nodes[0].id} seg={root} depth={0} marks={marks} onPath={data.path} busy={busy} onJump={(n, i, editOnly) => void jump(n, i, editOnly)} />) : <p className="muted">正在读取…</p>}</div>
    </Sheet>
  );
}
