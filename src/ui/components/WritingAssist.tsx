// AI 改写: 按我的要求改 (content, the player's words are the evidence), 只润色文字
// (wording only) and 按原著纠错 (only what the book supports) share one preview sheet.
import { useEffect, useRef, useState } from "react";
import { type WritingAnchor, type TextRange, type CanonCorrectionPreview, type PlayerRevisionPreview, CANON_NOT_FOUND, paragraphs, replaceRange, startWriting, runCanonCorrection, writingError } from "../../engine/writing/assist";
import type { ActionMode } from "../../engine/types";
import type { SourceBinding } from "../../engine/sources/types";
import { WRITING_REQUIREMENT_PRESETS } from "../../content/agentTasks";
import { useApp } from "../app/context";
import { MenuSheet, Sheet } from "./Sheet";
import "./writing.css";

export interface WritingDraft { anchor: WritingAnchor; kind: "rewrite" | "polish"; text: string; mode: ActionMode; source?: SourceBinding | null }

const brief = (text: string, max = 12) => {
  const t = text.replace(/\s+/g, "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

type Mode = "revise" | "polish" | "canon";
const MODE_NOTE: Record<Mode, string> = {
  revise: "按你说的改，事实、数字、能力、情节都可以改；本回合记录和之前的设定会一起改正。改最新一段会多出一个版本，改较早的回合会另起一条路线，原来的都保留。",
  polish: "只改写法，情节和钱物不变；采用后随时可以恢复原文。",
  canon: "查阅原文，只改有原著依据的错误，同步本回合记录。较早回合采用后另起修订路线，原路线和后续保留。查不到依据时会说明；本局自己的设定用“按我的要求改”。",
};
const PLACEHOLDER: Record<Mode, string> = {
  revise: "如：魂环是紫紫，现在是第二环，正在吸收第三环",
  polish: "可不填，如：简练一些、多些对话",
  canon: "可不填，如：核对人物身份、关系和这时的经历",
};

export function WritingAssist({ draft, onClose, onAdopt }: {
  draft: WritingDraft; onClose: () => void; onAdopt: (text: string, correction?: CanonCorrectionPreview, revision?: PlayerRevisionPreview) => Promise<void>;
}) {
  const { game, push } = useApp();
  const rewrite = draft.kind === "rewrite";
  const [mode, setMode] = useState<Mode>(rewrite ? "revise" : "polish");
  const canon = mode === "canon";
  const [revision, setRevision] = useState<PlayerRevisionPreview | null>(null);
  const ranges = paragraphs(draft.text);
  const whole: TextRange = { start: 0, end: draft.text.length };
  const [range, setRange] = useState<TextRange>(whole);
  const [hint, setHint] = useState("");
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [preview, setPreview] = useState("");
  const [correction, setCorrection] = useState<CanonCorrectionPreview | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const task = useRef<{ cancel(): void } | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const stop = () => { generation.current++; task.current?.cancel(); task.current = null; setPending(false); setReady(false); setPreview(""); setCorrection(null); setRevision(null); };
  const close = () => { if (saving) return; alive.current = false; stop(); onClose(); };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; task.current?.cancel(); };
  }, []);
  const original = rewrite ? draft.text.slice(range.start, range.end) : draft.text;
  const choose = (next: TextRange) => { if (pending || saving) return; setRange(next); setReady(false); setPreview(""); setCorrection(null); setRevision(null); setError(""); };
  const pick = (next: Mode) => { choose(range); setMode(next); };
  const isWhole = range.start === whole.start && range.end === whole.end;
  const generate = async () => {
    if (pending || saving) return;
    const token = ++generation.current;
    setPending(true); setReady(false); setPreview(""); setCorrection(null); setRevision(null); setError("");
    const current = () => alive.current && token === generation.current;
    try {
      if (canon) {
        const work = runCanonCorrection(game, { anchor: draft.anchor, range, hint }, text => { if (current()) setPreview(text); });
        task.current = work;
        const result = await work.done;
        if (current()) { setCorrection(result); setPreview(result.replacement ?? result.narrative); setReady(true); }
      } else if (mode === "revise") {
        const work = game.runPlayerRevision({ anchor: draft.anchor, range, hint }, text => { if (current()) setPreview(text); });
        task.current = work;
        const result = await work.done;
        if (current()) { setRevision(result); setPreview(result.replacement); setReady(true); }
      } else {
        const work = startWriting(game, { ...draft, text: original, hint, range: rewrite ? range : undefined }, (text) => { if (current()) setPreview(text); });
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
    try {
      // The head may have moved on by the AI's own tidy-up since the preview: adopt against today's.
      const anchor = draft.anchor;
      if (mode === "revise" && revision) await onAdopt(revision.narrative, undefined, { ...revision, anchor: { ...revision.anchor, headId: anchor.headId } });
      else await onAdopt(canon && correction ? correction.narrative : rewrite ? replaceRange(draft.text, range, preview) : preview, canon && correction ? { ...correction, anchor: { ...correction.anchor, headId: anchor.headId } } : undefined);
      if (alive.current) onClose();
    }
    catch (e) { if (alive.current) setError(writingError(e)); }
    finally { if (alive.current) setSaving(false); }
  };
  return <Sheet title={rewrite ? "AI 改写" : "润色行动"} onClose={close}>
    <div className="stack writing-assist">
      {rewrite && <div className="segmented" role="group" aria-label="怎么改">
        <button disabled={pending || saving} aria-pressed={mode === "revise"} onClick={() => pick("revise")}>按我的要求改</button>
        <button disabled={pending || saving} aria-pressed={mode === "polish"} onClick={() => pick("polish")}>只润色文字</button>
        {!!draft.source && <button disabled={pending || saving} aria-pressed={canon} onClick={() => pick("canon")}>按原著纠错</button>}
      </div>}
      {rewrite && <p className="muted">{MODE_NOTE[mode]}</p>}
      {rewrite && ranges.length > 1 ? <div className="writing-pick" role="radiogroup" aria-label="要改哪一段">
        <label className="writing-option all"><input type="radio" name="writing-range" aria-label="整段" checked={isWhole} disabled={pending || saving} onChange={() => choose(whole)} /><span>整段一起改</span></label>
        {ranges.map((r, i) => <label key={r.start} className="writing-option"><input type="radio" name="writing-range" aria-label={`第 ${i + 1} 段：${brief(draft.text.slice(r.start, r.end))}`} checked={range.start === r.start && range.end === r.end} disabled={pending || saving} onChange={() => choose(r)} /><span>{draft.text.slice(r.start, r.end)}</span></label>)}
      </div> : <p className="writing-original">{original}</p>}
      <label>希望怎么改<input value={hint} disabled={pending || saving} onChange={(e) => { setHint(e.target.value); setReady(false); }} placeholder={PLACEHOLDER[mode]} /></label>
      <button className="ghost" disabled={pending || saving} onClick={() => setPresetsOpen(true)}>常用改稿要求</button>
      {presetsOpen && <MenuSheet title="常用改稿要求" onClose={() => setPresetsOpen(false)} items={WRITING_REQUIREMENT_PRESETS.filter(item => (item.mode === "polish" || rewrite) && (item.mode !== "canon" || !!draft.source)).map(item => ({ label: item.name, onSelect: () => { choose(range); setHint(item.hint); if (rewrite) setMode(item.mode); } }))} />}
      {(preview || pending) && <label>{pending ? <span className="cursor-blink" role="status">正在改稿</span> : mode === "polish" ? "改稿（可以再改几个字）" : "改稿预览"}<textarea aria-label="改稿预览" readOnly={mode !== "polish"} value={preview} disabled={pending || saving} onChange={(e) => setPreview(e.target.value)} /></label>}
      {revision?.note && <p className="muted m-0">{revision.note}</p>}
      {revision && <details><summary>本回合记录{revision.recordChanges.length ? ` · ${revision.recordChanges.length}项调整` : "保持原样"}{revision.correctionPatch ? " · 之前的设定一起改正" : ""}</summary>
        <dl>{revision.recordChanges.map((c, i) => <div key={i}><dt>{c.name}</dt><dd>原：{c.before}</dd><dd>改：{c.after}</dd></div>)}</dl>
        {revision.correctionPatch?.cards?.map((c, i) => <p key={`c${i}`} className="muted">设定集“{c.name}”：{c.content}</p>)}
        {revision.correctionPatch?.people?.map((p, i) => <p key={`p${i}`} className="muted">人物“{p.name}”{p.role ? `：${p.role}` : ""}{p.note ? `；${p.note}` : ""}</p>)}
        {revision.correctionPatch?.profile && <p className="muted">主角：{Object.values(revision.correctionPatch.profile).filter(Boolean).join("、")}</p>}
      </details>}
      {correction && <details><summary>更正与出处</summary>{correction.corrections.map((c, i) => <div key={i}><p>{c.detail}</p>{c.citations.map((cite, j) => <blockquote key={j}>{cite.quote}<small> — {cite.title}{cite.page ? ` · 第${cite.page}页` : ""}</small></blockquote>)}</div>)}</details>}
      {correction?.recordChanges && <details><summary>本回合记录{correction.recordChanges.length ? ` · ${correction.recordChanges.length}项调整` : "保持原样"}</summary><dl>{correction.recordChanges.map((c, i) => <div key={i}><dt>{c.name}</dt><dd>原：{c.before}</dd><dd>改：{c.after}</dd></div>)}</dl></details>}
      {correction?.unresolved?.map((t, i) => <p className="field-hint warn" key={`u${i}`}>待核对：{t}</p>)}
      {correction?.related?.map((t, i) => <p className="muted" key={`r${i}`}>关联问题：{t}</p>)}
      {correction && ((correction.related?.length ?? 0) + (correction.unresolved?.length ?? 0) > 0) && <button disabled={pending || saving} onClick={() => { const paragraph = isWhole ? undefined : ranges.findIndex(r => r.start === range.start); onClose(); push({ name: "agent", worldId: draft.anchor.worldId, lineId: draft.anchor.lineId, skills: ["canon-reference"], target: { nodeId: draft.anchor.nodeId, ...(paragraph !== undefined ? { paragraph } : {}), evidence: correction.corrections.flatMap(c => c.citations) }, initialText: `继续核对局部改稿的关联问题，保留玩家主动分支：\n${[...correction.related ?? [], ...correction.unresolved ?? []].join("\n")}\n${hint}` }); }}>交给助手处理关联问题</button>}
      {error && <p role="alert" className="field-hint warn">{error}</p>}
      {error && canon && !pending && <button onClick={() => { setError(""); pick("revise"); }}>改用“按我的要求改”</button>}
      <div className="writing-actions">
        {pending ? <button onClick={() => { stop(); setError("已取消，原文没有改动。"); }}>取消生成</button> : <button disabled={saving} onClick={close}>取消</button>}
        {!pending && <button className={preview ? "" : "primary"} disabled={saving || !original.trim()} onClick={() => void generate()}>{preview ? "再改一版" : "生成改稿"}</button>}
        {ready && (!canon || !!correction?.corrections.length) && <button className="primary" disabled={saving || !preview.trim()} onClick={() => void adopt()}>{rewrite ? "采用改稿" : "采用到输入框"}</button>}
      </div>
    </div>
  </Sheet>;
}
