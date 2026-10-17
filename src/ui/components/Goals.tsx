// The 目标 tab of the character panel (PLAN §4.5, R05-T003): goals in progress
// by kind, how each one went, the player's own wishes, and finished goals.
// Every change is an edit node that can be undone.
import { useState } from "react";
import { nowOf } from "../../engine/calendar/clock";
import { formatDate } from "../../engine/calendar/date";
import type { EraContext } from "../../engine/era";
import type { TurnRecord } from "../../engine/state/apply";
import type { Goal, WorldState } from "../../engine/types";
import { Sheet } from "./Sheet";

const ORDER: Goal["kind"][] = ["主线", "支线", "心愿"];
type Save = (patch: TurnRecord, summary: string) => Promise<void>;

/** "天宝七载 冬月十九", or "第 3 日" when the world has no date. */
function dayOf(era: EraContext, minute: number): string {
  const now = nowOf(era.clock, minute);
  return now.date ? formatDate(now.date, era.clock.rules) : `第 ${now.day} 日`;
}

function GoalSheet({ goal, era, onClose, onSave }: { goal: Goal; era: EraContext; onClose: () => void; onSave: Save }) {
  const [saving, setSaving] = useState(false);
  const run = async (patch: TurnRecord, summary: string) => {
    setSaving(true);
    try { await onSave(patch, summary); onClose(); } finally { setSaving(false); }
  };
  const active = goal.status === "进行中";
  const ref = { id: goal.id, name: goal.name };
  return (
    <Sheet title={goal.name} onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>
          {goal.kind} · {goal.status}{goal.startedMinute != null ? ` · ${dayOf(era, goal.startedMinute)}起` : ""}{goal.endedMinute != null ? `，${dayOf(era, goal.endedMinute)}${goal.status}` : ""}
        </p>
        {goal.steps?.length
          ? <ol className="timeline">{goal.steps.map((s, i) => <li key={i}><small>{dayOf(era, s.minute)}</small>{s.text}</li>)}</ol>
          : <p style={{ margin: 0 }}>{goal.progress || "还没有进展。"}</p>}
        {goal.kind === "心愿" && active && <p className="muted" style={{ margin: 0 }}>这是你自己的心愿：AI 不会替你去做，但会让相关的人和机会自然出现。</p>}
        <div className="row">
          {active ? <>
            <button disabled={saving} onClick={() => void run({ goals: [{ op: "abandon", ...ref }] }, `放弃目标：${goal.name}`)}>放弃</button>
            <button className="primary grow" disabled={saving} onClick={() => void run({ goals: [{ op: "done", ...ref }] }, `完成目标：${goal.name}`)}>标为完成</button>
          </> : <button className="primary grow" disabled={saving} onClick={() => void run({ goals: [{ op: "reopen", ...ref }] }, `重新开始：${goal.name}`)}>重新开始</button>}
        </div>
      </div>
    </Sheet>
  );
}

function WishSheet({ onClose, onSave }: { onClose: () => void; onSave: Save }) {
  const [name, setName] = useState("");
  const [how, setHow] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await onSave({ goals: [{ op: "add", kind: "心愿", name: name.trim(), ...(how.trim() ? { detail: how.trim() } : {}) }] }, `新心愿：${name.trim()}`);
      onClose();
    } finally { setSaving(false); }
  };
  return (
    <Sheet title="我的心愿" onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>写下你想让主角做成的事。AI 不会替你去做，但会让相关的人和机会自然出现。</p>
        <label>心愿<input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：攒钱在长安买一处宅子" /></label>
        <label>打算怎么做（可不填）<input value={how} onChange={(e) => setHow(e.target.value)} placeholder="如：先替人抄书攒钱" /></label>
        <button className="primary" disabled={saving || !name.trim()} onClick={() => void save()}>记下</button>
      </div>
    </Sheet>
  );
}

export function Goals({ state, era, busy, onSave }: { state: WorldState; era: EraContext; busy: boolean; onSave: Save }) {
  const [open, setOpen] = useState<Goal | null>(null);
  const [wish, setWish] = useState(false);
  const active = state.goals.filter((g) => g.status === "进行中").sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const ended = state.goals.filter((g) => g.status !== "进行中").reverse();
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>进行中{active.length ? ` ${active.length}` : ""}</b>
        <button className="ghost" aria-label="添加心愿" disabled={busy} onClick={() => setWish(true)}>＋ 我的心愿</button>
      </div>
      {active.length ? active.map((g) => (
        <button key={g.id} className="item-row codex-item" disabled={busy} onClick={() => setOpen(g)}>
          <div className="grow"><b>{g.name}</b>{g.progress && <small>{g.progress}</small>}</div>
          <span className="tag">{g.kind}</span>
        </button>
      )) : <p className="muted">眼下没有明确的目标。</p>}
      {ended.length > 0 && <details>
        <summary className="muted">已结束 {ended.length}</summary>
        {ended.map((g) => (
          <button key={g.id} className="item-row codex-item" style={{ opacity: 0.75 }} disabled={busy} onClick={() => setOpen(g)}>
            <div className="grow">{g.name}{g.progress && <small>{g.progress}</small>}</div>
            <span className="tag">{g.status}</span>
          </button>
        ))}
      </details>}
      {open && <GoalSheet goal={open} era={era} onClose={() => setOpen(null)} onSave={onSave} />}
      {wish && <WishSheet onClose={() => setWish(false)} onSave={onSave} />}
    </div>
  );
}
