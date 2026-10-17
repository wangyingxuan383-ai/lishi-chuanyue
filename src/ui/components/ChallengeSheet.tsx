// 挑战 page (R14, docs/plans/R14_PLAY_MODES.md §2): the goal, the time left,
// what makes it fail, the latest progress; change it, give it up (after a
// confirmation, then the story goes on as an ordinary one), or start a new one
// whose time counts from now. Every change is one undoable edit in the story.
import { useState } from "react";
import { EditRejected } from "../../engine/game";
import { challengeView, checkChallenge, modeEditSummary, newChallenge } from "../../engine/modes";
import type { Challenge, WorldState } from "../../engine/types";
import { useApp } from "../app/context";
import { ChallengeFields, type ChallengeFieldValues } from "./ModeSetup";
import { Sheet } from "./Sheet";
import "./modes.css";

const STATUS: Record<Challenge["status"], string> = { active: "进行中", won: "挑战成功", lost: "挑战失败", abandoned: "已放弃" };

export function ChallengeSheet({ state, busy, onSave, onClose }: {
  state: WorldState; busy: boolean;
  onSave: (challenge: Challenge | null, summary: string) => Promise<void>;
  onClose: () => void;
}) {
  const { ask } = useApp();
  const c = state.challenge ?? null;
  const view = challengeView(state);
  const now = state.time.elapsedMinutes;
  const [mode, setMode] = useState<"view" | "edit" | "create">(c ? "view" : "create");
  const [fields, setFields] = useState<ChallengeFieldValues>(c && mode !== "create" ? { goal: c.goal, limit: c.limit, failIf: c.failIf } : { goal: "", limit: "", failIf: "" });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dirty = mode === "create" ? !!(fields.goal.trim() || fields.limit.trim() || fields.failIf.trim())
    : mode === "edit" && !!c && (fields.goal !== c.goal || fields.limit !== c.limit || fields.failIf !== c.failIf);

  const save = async (next: Challenge | null) => {
    setSaving(true);
    setProblem(null);
    try {
      // A new challenge in place of an ended one is an addition, even when it starts in the same minute.
      await onSave(next, mode === "create" && next ? "你加了一个挑战" : modeEditSummary(state, { challengeSet: next }));
      onClose();
    } catch (e) {
      setProblem(e instanceof EditRejected ? e.reason : "没有保存成功，改动还在，请再试一次。");
    } finally {
      setSaving(false);
    }
  };
  const submit = () => {
    if (mode === "create") {
      const next = newChallenge(fields, now);
      if (!next) { setProblem("挑战要有一个目标。"); return; }
      void save(next);
      return;
    }
    if (!c) return;
    const next = checkChallenge({ ...c, ...fields });
    if (typeof next === "string") { setProblem(next); return; }
    void save(next);
  };
  const abandon = async () => {
    if (!c) return;
    if (!await ask({ title: "放弃这个挑战？", message: "故事照常继续，只是不再计较成败。之后也可以撤销。", confirm: "放弃挑战", danger: true })) return;
    const next = checkChallenge({ ...c, status: "abandoned", endedMinute: now });
    if (typeof next === "string") { setProblem(next); return; }
    void save(next);
  };
  const startNew = () => { setFields({ goal: "", limit: "", failIf: "" }); setProblem(null); setMode("create"); };

  const total = c && c.deadlineMinute !== null ? c.deadlineMinute - c.startedMinute : null;
  const used = c && total ? Math.min(1, Math.max(0, (now - c.startedMinute) / total)) : 0;
  const soon = !!view?.active && view.remainingMinutes !== null && view.remainingMinutes < 3 * 1440;
  const title = mode === "create" ? (c ? "换一个挑战" : "加一个挑战") : mode === "edit" ? "修改挑战" : "挑战";

  return (
    <Sheet title={title} dirty={dirty && !saving} onClose={() => { if (!saving) onClose(); }}>
      <div className="challenge-sheet">
        {mode === "view" && c && view ? (
          <>
            <div className="challenge-state">
              <span className={`mark ${c.status}`}>{STATUS[c.status]}</span>
              {view.active && <span className="muted">第 {Math.floor((now - c.startedMinute) / 1440) + 1} 天</span>}
            </div>
            <p className="challenge-goal">{c.goal}</p>
            <dl className="challenge-facts">
              <dt>期限</dt>
              <dd>
                {c.limit ? <>{c.limit}{view.active && <span className="muted"> · {view.remaining}</span>}</> : "不限时"}
                {view.active && total ? <div className={`time-meter${soon ? " soon" : ""}`} aria-hidden="true"><i style={{ width: `${Math.round(used * 100)}%` }} /></div> : null}
              </dd>
              <dt>失败条件</dt>
              <dd>{c.failIf || <span className="muted">没有写</span>}</dd>
              <dt>最近进展</dt>
              <dd>{c.progress || <span className="muted">还没有进展</span>}</dd>
              {!view.active && view.outcome && <><dt>结局</dt><dd>{view.outcome}</dd></>}
              {(c.status === "won" || c.status === "lost") && <><dt>用时</dt><dd>{view.days} 天{view.turns ? `，${view.turns} 回合` : ""}</dd></>}
            </dl>
            {problem && <p className="notice" role="alert" style={{ margin: 0 }}>{problem}</p>}
            <div className="sheet-foot">
              {view.active ? (
                <>
                  <button type="button" className="ghost danger-text" disabled={busy || saving} onClick={() => void abandon()}>放弃挑战</button>
                  <button type="button" className="primary" disabled={busy || saving} onClick={() => { setFields({ goal: c.goal, limit: c.limit, failIf: c.failIf }); setMode("edit"); }}>修改</button>
                </>
              ) : (
                <button type="button" className="primary" disabled={busy || saving} onClick={startNew}>换一个挑战</button>
              )}
            </div>
          </>
        ) : (
          <>
            {mode === "create" && <p className="mode-hint">期限从现在算起。</p>}
            <ChallengeFields value={fields} onChange={setFields} />
            {problem && <p className="notice" role="alert" style={{ margin: 0 }}>{problem}</p>}
            <div className="sheet-foot">
              {(mode === "edit" || c) && <button type="button" className="ghost" disabled={saving} onClick={() => { setProblem(null); setMode("view"); }}>取消</button>}
              <button type="button" className="primary" disabled={busy || saving || !fields.goal.trim() || (mode === "edit" && !dirty)} onClick={submit}>
                {busy ? "正在写…" : saving ? "正在保存…" : mode === "create" ? "开始挑战" : "保存"}
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** “还剩 12 天 · 凑够三百两”, for the banner and 本局设置; null when there is no challenge going on. */
export function challengeLine(state: WorldState): string | null {
  const v = challengeView(state);
  if (!v) return null;
  return v.active ? `${v.remaining} · ${v.goal}` : `${STATUS[v.status]} · ${v.goal}`;
}
