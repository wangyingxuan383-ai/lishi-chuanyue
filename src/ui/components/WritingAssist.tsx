// Wording edits and bounded reference corrections share the existing preview sheet.
import { useEffect, useRef, useState } from "react";
import { type WritingAnchor, type TextRange, type CanonCorrectionPreview, paragraphs, replaceRange, startWriting, runCanonCorrection, writingError } from "../../engine/writing/assist";
import type { ActionMode } from "../../engine/types";
import type { SourceBinding } from "../../engine/sources/types";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import "./writing.css";

export interface WritingDraft { anchor: WritingAnchor; kind: "rewrite" | "polish"; text: string; mode: ActionMode; source?: SourceBinding | null }

const brief = (text: string, max = 12) => {
  const t = text.replace(/\s+/g, "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

export function WritingAssist({ draft, onClose, onAdopt }: {
  draft: WritingDraft; onClose: () => void; onAdopt: (text: string, correction?: CanonCorrectionPreview) => Promise<void>;
}) {
  const { game, push } = useApp();
  const rewrite = draft.kind === "rewrite";
  const [canon, setCanon] = useState(rewrite && !!draft.source);
  const ranges = paragraphs(draft.text);
  const whole: TextRange = { start: 0, end: draft.text.length };
  const [range, setRange] = useState<TextRange>(whole);
  const [hint, setHint] = useState("");
  const [preview, setPreview] = useState("");
  const [correction, setCorrection] = useState<CanonCorrectionPreview | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const task = useRef<{ cancel(): void } | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const stop = () => { generation.current++; task.current?.cancel(); task.current = null; setPending(false); setReady(false); setPreview(""); setCorrection(null); };
  const close = () => { if (saving) return; alive.current = false; stop(); onClose(); };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; task.current?.cancel(); };
  }, []);
  const original = rewrite ? draft.text.slice(range.start, range.end) : draft.text;
  const choose = (next: TextRange) => { if (pending || saving) return; setRange(next); setReady(false); setPreview(""); setCorrection(null); setError(""); };
  const isWhole = range.start === whole.start && range.end === whole.end;
  const generate = async () => {
    if (pending || saving) return;
    const token = ++generation.current;
    setPending(true); setReady(false); setPreview(""); setCorrection(null); setError("");
    const current = () => alive.current && token === generation.current;
    try {
      if (canon) {
        const work = runCanonCorrection(game, { anchor: draft.anchor, range, hint }, text => { if (current()) setPreview(text); });
        task.current = work;
        const result = await work.done;
        if (current()) { setCorrection(result); setPreview(result.replacement ?? result.narrative); setReady(true); }
      } else {
        const work = startWriting(game, { ...draft, text: original, hint }, (text) => { if (current()) setPreview(text); });
        task.current = work;
        const text = await work.done;
        if (current()) { setPreview(text); setReady(true); }
      }
    } catch (e) { if (current()) { setError(writingError(e)); setPreview(""); } }
    finally { if (current()) { setPending(false); task.current = null; } }
  };
  const adopt = async () => {
    if (!ready || saving || !preview.trim()) return;
    setSaving(true); setError("");
    try { await onAdopt(canon && correction ? correction.narrative : rewrite ? replaceRange(draft.text, range, preview) : preview, canon ? correction ?? undefined : undefined); if (alive.current) onClose(); }
    catch (e) { if (alive.current) setError(writingError(e)); }
    finally { if (alive.current) setSaving(false); }
  };
  return <Sheet title={rewrite ? "AI 改写" : "润色行动"} onClose={close}>
    <div className="stack writing-assist">
      {rewrite && <div className="segmented"><button disabled={pending || saving} aria-pressed={!canon} onClick={() => { choose(range); setCanon(false); }}>文字润色</button><button disabled={pending || saving} aria-pressed={canon} onClick={() => { choose(range); setCanon(true); }}>按原著纠错</button></div>}
      {rewrite && <p className="muted">{canon ? "查阅原文并预览局部改稿，同步受影响的本回合记录。较早回合采用后另起修订路线，原路线和后续保留。" : "只改写法，情节和钱物不变；采用后随时可以恢复原文。"}</p>}
      {rewrite && ranges.length > 1 ? <div className="writing-pick" role="radiogroup" aria-label="要改哪一段">
        <label className="writing-option all"><input type="radio" name="writing-range" aria-label="整段" checked={isWhole} disabled={pending || saving} onChange={() => choose(whole)} /><span>整段一起改</span></label>
        {ranges.map((r, i) => <label key={r.start} className="writing-option"><input type="radio" name="writing-range" aria-label={`第 ${i + 1} 段：${brief(draft.text.slice(r.start, r.end))}`} checked={range.start === r.start && range.end === r.end} disabled={pending || saving} onChange={() => choose(r)} /><span>{draft.text.slice(r.start, r.end)}</span></label>)}
      </div> : <p className="writing-original">{original}</p>}
      <label>希望怎么改<input value={hint} disabled={pending || saving} onChange={(e) => { setHint(e.target.value); setReady(false); }} placeholder={canon ? "可不填，如：核对人物身份、关系和这时的经历" : "可不填，如：简练一些、多些对话"} /></label>
      {(preview || pending) && <label>{pending ? <span className="cursor-blink" role="status">正在改稿</span> : canon ? "改稿预览" : "改稿（可以再改几个字）"}<textarea aria-label="改稿预览" readOnly={canon} value={preview} disabled={pending || saving} onChange={(e) => setPreview(e.target.value)} /></label>}
      {correction && <details><summary>更正与出处</summary>{correction.corrections.map((c, i) => <div key={i}><p>{c.detail}</p>{c.citations.map((cite, j) => <blockquote key={j}>{cite.quote}<small> — {cite.title}{cite.page ? ` · 第${cite.page}页` : ""}</small></blockquote>)}</div>)}</details>}
      {correction?.recordChanges && <details><summary>本回合记录{correction.recordChanges.length ? ` · ${correction.recordChanges.length}项调整` : "保持原样"}</summary><dl>{correction.recordChanges.map((c, i) => <div key={i}><dt>{c.name}</dt><dd>原：{c.before}</dd><dd>改：{c.after}</dd></div>)}</dl></details>}
      {correction?.unresolved?.map((t, i) => <p className="field-hint warn" key={`u${i}`}>待核对：{t}</p>)}
      {correction?.related?.map((t, i) => <p className="muted" key={`r${i}`}>关联问题：{t}</p>)}
      {correction && ((correction.related?.length ?? 0) + (correction.unresolved?.length ?? 0) > 0) && <button disabled={pending || saving} onClick={() => { const paragraph = isWhole ? undefined : ranges.findIndex(r => r.start === range.start); onClose(); push({ name: "agent", worldId: draft.anchor.worldId, lineId: draft.anchor.lineId, skills: ["canon-reference"], target: { nodeId: draft.anchor.nodeId, ...(paragraph !== undefined ? { paragraph } : {}), evidence: correction.corrections.flatMap(c => c.citations) }, initialText: `继续核对局部改稿的关联问题，保留玩家主动分支：\n${[...correction.related ?? [], ...correction.unresolved ?? []].join("\n")}\n${hint}` }); }}>交给 Agent 处理关联问题</button>}
      {error && <p role="alert" className="field-hint warn">{error}</p>}
      <div className="writing-actions">
        {pending ? <button onClick={() => { stop(); setError("已取消，原文没有改动。"); }}>取消生成</button> : <button disabled={saving} onClick={close}>取消</button>}
        {!pending && <button className={preview ? "" : "primary"} disabled={saving || !original.trim()} onClick={() => void generate()}>{preview ? "再改一版" : "生成改稿"}</button>}
        {ready && (!canon || !!correction?.corrections.length) && <button className="primary" disabled={saving || !preview.trim()} onClick={() => void adopt()}>{rewrite ? "采用改稿" : "采用到输入框"}</button>}
      </div>
    </div>
  </Sheet>;
}
