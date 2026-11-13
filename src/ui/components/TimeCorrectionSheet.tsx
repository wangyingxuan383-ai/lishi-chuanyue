import { useEffect, useState } from "react";
import { previewDurationCorrection, type DurationCorrectionPreview } from "../../engine/calendar/manualTime";
import { turnNumbers } from "../../engine/book";
import { rejectedReason } from "../../engine/game";
import type { StoryNode } from "../../engine/types";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";

const challengeLabel = (status: string | undefined) => ({ active: "进行中", won: "已达成", lost: "已失败", abandoned: "已放弃" })[status ?? ""] ?? "未设";

export function TimeCorrectionSheet({ worldId, headId, busy, onClose, onSaved }: {
  worldId: string; headId: string; busy: boolean; onClose(): void; onSaved(): Promise<void>;
}) {
  const { game, ask, toast } = useApp();
  const [turns, setTurns] = useState<StoryNode[]>([]), [nodeId, setNodeId] = useState("");
  const [numbers, setNumbers] = useState(new Map<string, number>());
  const [duration, setDuration] = useState(""), [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<DurationCorrectionPreview | null>(null), [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { let active = true; void game.repo.path(headId).then(path => {
    if (!active) return;
    const available = path.filter(node => node.kind === "turn" && node.status === "ok" && node.record && node.parentId);
    setTurns(available); setNumbers(turnNumbers(path)); setNodeId(available.at(-1)?.id ?? "");
  }).catch(error => { if (active) setProblem(rejectedReason(error)); }); return () => { active = false; }; }, [game, headId]);
  const prepare = async () => {
    setPending(true); setProblem(null); setPreview(null);
    try { setPreview(await previewDurationCorrection(game, worldId, headId, nodeId, duration)); }
    catch (error) { setProblem(rejectedReason(error)); } finally { setPending(false); }
  };
  const save = async () => {
    if (!preview) return;
    const ok = await ask({ title: "建立时间修订路线？", message: `正文保留原字句，原路线和后续${preview.laterTurns ? ` ${preview.laterTurns} 回合` : ""}完整保留。新路线停在选中的修订回合，之后从这里继续。`, confirm: "采用修订" });
    if (!ok) return;
    setPending(true); setProblem(null);
    try { await game.correctDuration(preview); await onSaved(); toast("经过时长已纠正，原路线保留在世界线中"); onClose(); }
    catch (error) { setProblem(rejectedReason(error)); } finally { setPending(false); }
  };
  return <Sheet title="纠正剧情经过" onClose={onClose} dirty={!!duration.trim()}>
    <div className="stack">
      <p className="muted m-0">手动修改某回合实际经过的时长，重新结算年龄、期限和状态，不调用AI。只想改顶栏日期或时刻，请返回“时间与货币”校准显示。</p>
      <label>选择回合<select aria-label="纠正哪个回合" disabled={pending || busy} value={nodeId} onChange={e => { setNodeId(e.target.value); setPreview(null); setProblem(null); }}>
        {turns.map(node => <option key={node.id} value={node.id}>第 {numbers.get(node.id)} 回合 · {(node.actionText || node.narrative).replace(/\s+/g, " ").slice(0, 30)}</option>)}
      </select></label>
      {!turns.length && <p className="muted">还没有可纠正的完整剧情回合。</p>}
      <label>该回合应经过多久<input aria-label="应经过多久" value={duration} disabled={pending || busy} onChange={e => { setDuration(e.target.value); setPreview(null); setProblem(null); }} placeholder="如：90分钟、两天，也可以填0" /></label>
      <button disabled={busy || pending || !nodeId || !duration.trim()} onClick={() => void prepare()}>{pending ? "正在处理…" : "预演变化"}</button>
      {preview && <>
        <dl className="facts"><dt>回合耗时</dt><dd>{preview.elapsedBefore} → {preview.elapsedAfter} 分钟</dd><dt>修订前</dt><dd>{preview.before}</dd><dt>修订后</dt><dd>{preview.after}</dd><dt>年龄</dt><dd>{preview.originalState.protagonist.age ?? "未设"} → {preview.result.state.protagonist.age ?? "未设"}</dd>
          {preview.originalState.challenge && <><dt>挑战状态</dt><dd>{challengeLabel(preview.originalState.challenge.status)} → {challengeLabel(preview.result.state.challenge?.status)}</dd></>}
        </dl>
        {preview.projectedEnd && <details><summary>原后续记录的时间预演</summary><dl className="facts"><dt>原末尾</dt><dd>{preview.projectedEnd.before}</dd><dt>沿原记录推算</dt><dd>{preview.projectedEnd.after}</dd><dt>末尾年龄</dt><dd>{preview.projectedEnd.ageBefore ?? "未设"} → {preview.projectedEnd.ageAfter ?? "未设"}</dd></dl><p className="field-hint">仅供判断规则影响，后续正文不自动重写或采用。新路线停在修订回合。</p></details>}
        {preview.remainingProblem && <p className="notice">{preview.remainingProblem}</p>}
        <p className="field-hint m-0">原文中的日期与叙事衔接需要另行核对；程序不会自动收费改写正文。原路线随时可切回。</p>
        <button className="primary" disabled={busy || pending} onClick={() => void save()}>采用时间修订</button>
      </>}
      {problem && <p className="notice">{problem}</p>}
    </div>
  </Sheet>;
}
