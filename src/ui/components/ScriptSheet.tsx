// 剧本 page (R14, docs/plans/R14_PLAY_MODES.md §2): every beat with where the
// story stands — played (a stamped seal), the current one, the ones to come —
// and the editing a writer needs: change the words, add, remove, reorder, mark
// played or skipped. Saving makes one edit in the story, undoable and kept to
// this world line like any panel edit.
import { useMemo, useState } from "react";
import { EditRejected } from "../../engine/game";
import { MAX_BEATS, beatTitle, checkScript, modeEditSummary, newBeat, scriptProgress } from "../../engine/modes";
import type { Script, ScriptBeat, WorldState } from "../../engine/types";
import { Icon } from "./Icon";
import { ORDINALS } from "./ModeSetup";
import { Sheet } from "./Sheet";
import { useApp } from "../app/context";
import "./modes.css";

const blank = (): Script => ({ line: "", beats: [newBeat(""), newBeat(""), newBeat("")], ending: "", steer: "gentle" });
const same = (a: Script | null | undefined, b: Script) => JSON.stringify(a ?? null) === JSON.stringify(b);
const beatName = (i: number) => `第${ORDINALS[i] ?? i + 1}幕`;

/** The line the edit leaves in the story: the one thing changed when that is clear, else the engine's words. */
function summaryOf(before: WorldState, next: Script | null): string {
  const was = before.script;
  if (was && next && was.beats.length === next.beats.length && was.line === next.line && was.ending === next.ending && was.steer === next.steer) {
    const changed = next.beats.map((b, i) => [b, was.beats[i]] as const).filter(([b, a]) => JSON.stringify(a) !== JSON.stringify(b));
    if (changed.length === 1 && changed[0][0].id === changed[0][1].id && changed[0][0].text === changed[0][1].text) {
      const [b] = changed[0];
      const i = next.beats.indexOf(b);
      return b.status === "done" ? `你把${beatName(i)}标为演完` : b.status === "skipped" ? `你跳过了${beatName(i)}` : `你把${beatName(i)}改回未演`;
    }
  }
  return modeEditSummary(before, { scriptSet: next });
}

export function ScriptSheet({ state, busy, onSave, onClose }: {
  state: WorldState; busy: boolean;
  onSave: (script: Script | null, summary: string) => Promise<void>;
  onClose: () => void;
}) {
  const { ask } = useApp();
  const creating = !state.script;
  const [script, setScript] = useState<Script>(() => (state.script ? structuredClone(state.script) : blank()));
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const now = state.time.elapsedMinutes;
  const dirty = creating ? script.beats.some((b) => b.text.trim()) || !!script.line.trim() || !!script.ending.trim() : !same(state.script, script);
  const checked = useMemo(() => checkScript(script), [script]);
  // Where the edited outline stands: the first beat still to play is the current one.
  const current = script.beats.findIndex((b) => b.status === "todo" && b.text.trim());
  const progress = scriptProgress({ script: typeof checked === "string" ? null : checked });

  const setBeats = (beats: ScriptBeat[]) => setScript((s) => ({ ...s, beats }));
  const patchBeat = (id: string, patch: Partial<ScriptBeat>) => setBeats(script.beats.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const mark = (b: ScriptBeat, status: ScriptBeat["status"]) => {
    patchBeat(b.id, { status, endedMinute: status === "todo" ? undefined : now });
    setEditing(null);
  };
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= script.beats.length) return;
    const next = [...script.beats];
    [next[i], next[j]] = [next[j], next[i]];
    setBeats(next);
  };
  const remove = (b: ScriptBeat) => {
    setBeats(script.beats.length > 1 ? script.beats.filter((x) => x.id !== b.id) : [newBeat("")]);
    setEditing(null);
  };
  const add = () => {
    const beat = newBeat("");
    setBeats([...script.beats, beat]);
    if (!creating) setEditing(beat.id);
  };

  const save = async (next: Script | null) => {
    setSaving(true);
    setProblem(null);
    try {
      await onSave(next, summaryOf(state, next));
      onClose();
    } catch (e) {
      setProblem(e instanceof EditRejected ? e.reason : "没有保存成功，改动还在，请再试一次。");
    } finally {
      setSaving(false);
    }
  };
  const removeScript = async () => {
    if (!await ask({ title: "删掉这个剧本？", message: "故事照常继续，之后按你的行动自由发展。之后也可以撤销。", confirm: "删掉剧本", danger: true })) return;
    void save(null);
  };

  return (
    <Sheet title={creating ? "加一个剧本" : "剧本"} dirty={dirty && !saving} onClose={() => { if (!saving) onClose(); }}>
      <div className="script-sheet">
        {!creating && progress && (
          <div className="script-progress">
            <b>{progress.finished ? `${progress.total} 幕都演完了` : `正在第 ${progress.index} 幕，共 ${progress.total} 幕`}</b>
            <span className="muted">{script.steer === "firm" ? "紧扣大纲" : "顺其自然"}</span>
          </div>
        )}
        <label className="mode-field"><span>主线</span>
          <input value={script.line} onChange={(e) => setScript({ ...script, line: e.target.value })} placeholder="一句话：这个故事最终讲什么" aria-label="主线" />
        </label>

        <div className="script-beats" role="list" aria-label="各幕">
          {script.beats.map((b, i) => {
            const kind = b.status === "done" ? "done" : b.status === "skipped" ? "skipped" : i === current ? "current" : "upcoming";
            const open = editing === b.id;
            const note = creating ? "" : kind === "done" ? "演完了" : kind === "skipped" ? "跳过了" : kind === "current" ? "正在这一幕" : "";
            return (
              <div key={b.id} role="listitem" className={`script-beat ${creating ? "upcoming" : kind}`}>
                <span className="beat-stamp" aria-hidden="true">{ORDINALS[i] ?? i + 1}</span>
                {/* A new outline is written straight in every row; an existing one opens a row to change it. */}
                {open || creating ? (
                  <textarea autoFocus={open && !creating} rows={1} value={b.text} aria-label={beatName(i)} placeholder={`${beatName(i)}要发生的事`}
                    onChange={(e) => patchBeat(b.id, { text: e.target.value })} />
                ) : (
                  <button type="button" className="beat-body" aria-label={`${beatName(i)}：${b.text || "还没写"}${note ? `，${note}` : ""}。点一下修改`} onClick={() => setEditing(b.id)}>
                    <p>{b.text.trim() || <span className="muted">还没写这一幕</span>}</p>
                    {note && <small>{note}</small>}
                  </button>
                )}
                <button type="button" className="icon-btn" aria-label={`${beatName(i)}的操作`} aria-expanded={open} onClick={() => setEditing(open ? null : b.id)}>
                  <Icon name={open ? "close" : "more"} size={20} />
                </button>
                {open && (
                  <div className="beat-tools">
                    {creating ? null : b.status === "todo"
                      ? <><button type="button" onClick={() => mark(b, "done")}>演完了</button><button type="button" onClick={() => mark(b, "skipped")}>跳过</button></>
                      : <button type="button" onClick={() => mark(b, "todo")}>改回未演</button>}
                    <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`把${beatName(i)}上移`}>上移</button>
                    <button type="button" disabled={i === script.beats.length - 1} onClick={() => move(i, 1)} aria-label={`把${beatName(i)}下移`}>下移</button>
                    <button type="button" className="danger-text" onClick={() => remove(b)}>删去</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {script.beats.length < MAX_BEATS
          ? <button type="button" className="beat-add" onClick={add}><Icon name="plus" size={18} />加一幕</button>
          : <p className="mode-hint">最多 {MAX_BEATS} 幕。</p>}

        <label className="mode-field"><span>结局<small className="optional">可不写</small></span>
          <input value={script.ending} onChange={(e) => setScript({ ...script, ending: e.target.value })} placeholder="想要怎样收场" aria-label="结局" />
        </label>
        <div className="mode-field">
          <span>推进方式</span>
          <div className="segmented" role="group" aria-label="推进方式">
            <button type="button" aria-pressed={script.steer === "gentle"} onClick={() => setScript({ ...script, steer: "gentle" })}>顺其自然</button>
            <button type="button" aria-pressed={script.steer === "firm"} onClick={() => setScript({ ...script, steer: "firm" })}>紧扣大纲</button>
          </div>
        </div>

        {problem && <p className="notice" role="alert" style={{ margin: 0 }}>{problem}</p>}
        <div className="sheet-foot">
          {!creating && <button type="button" className="ghost danger-text" disabled={busy || saving} onClick={() => void removeScript()}>删掉剧本</button>}
          <button type="button" className="primary" disabled={busy || saving || (!creating && !dirty) || typeof checked === "string"}
            onClick={() => { if (typeof checked !== "string") void save(checked); }}>
            {busy ? "正在写…" : saving ? "正在保存…" : creating ? "开始这个剧本" : "保存"}
          </button>
        </div>
        {typeof checked === "string" && dirty && <p className="mode-hint" style={{ textAlign: "right" }}>{checked}</p>}
      </div>
    </Sheet>
  );
}

/** “第 2/5 幕 · 夜探城隍庙”, for the banner and 本局设置. */
export function scriptLine(state: WorldState): string | null {
  const p = scriptProgress(state);
  if (!p) return null;
  return p.finished ? `${p.total} 幕都演完了` : `第 ${p.index}/${p.total} 幕 · ${beatTitle(p.current!.text)}`;
}
