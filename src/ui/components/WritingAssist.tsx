// AI 改写: 按我的要求改 (content, the player's words are the evidence), 只润色文字
// (wording only) and 按原著纠错 (only what the book supports) share one preview sheet.
import { useEffect, useMemo, useRef, useState } from "react";
import { type WritingAnchor, type TextRange, type CanonCorrectionPreview, type PlayerRevisionPreview, CanonStop, canonOutcomeText, paragraphs, replaceRange, startWriting, runCanonCorrection, writingError } from "../../engine/writing/assist";
import type { TurnRecord } from "../../engine/state/apply";
import type { ActionMode } from "../../engine/types";
import type { SourceBinding } from "../../engine/sources/types";
import { WRITING_REQUIREMENT_PRESETS } from "../../content/agentTasks";
import { useApp } from "../app/context";
import { MenuSheet, Sheet } from "./Sheet";
import { RecentUsageLine } from "./TurnUsage";
import { SourceScopeRow, SourceScopeSheet } from "./SourceScope";
import { AUTO_SCOPE, type SourceScope } from "../../engine/sources/scope";
import { diffStats, diffText } from "./textDiff";
import "./writing.css";

export interface WritingDraft { anchor: WritingAnchor; kind: "rewrite" | "polish"; text: string; mode: ActionMode; source?: SourceBinding | null }

const brief = (text: string, max = 12) => {
  const t = text.replace(/\s+/g, "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

type Mode = "revise" | "polish" | "canon";
const MODE_NOTE: Record<Mode, string> = {
  revise: "按你说的改，事实、数字、能力、情节都可以改；本回合记录和之前的设定会一起改正。改最新一段会多出一个版本，改较早的回合会另起一条路线，原来的都保留。",
  polish: "只改写法，不改事实；采用时会问你事实要不要一起改，原文随时可以恢复。",
  canon: "查阅原文，只改有原著依据的错误，同步本回合记录。较早回合采用后另起修订路线，原路线和后续保留。查不到依据时会说明；本局自己的设定用“按我的要求改”。",
};
const PLACEHOLDER: Record<Mode, string> = {
  revise: "如：把匕首换成短剑；他其实是她的表哥；时间改到第二天早上",
  polish: "可不填，如：简练一些、多些对话",
  canon: "可不填，如：核对人物身份、关系和这时的经历；也可以直接问，如“这里的规矩原著怎么写”",
};

/** Inline diff highlighting what changed between original and revised text. */
export function DiffView({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => diffText(before, after), [before, after]);
  return (
    <div className="diff-box" aria-label="正文改动对照">
      {parts.map((part, i) =>
        part.kind === "del" ? <del key={i} className="diff-del">{part.text}</del>
        : part.kind === "ins" ? <ins key={i} className="diff-ins">{part.text}</ins>
        : <span key={i}>{part.text}</span>
      )}
    </div>
  );
}

/** What the turn's record and the earlier settings will change to; shared by every preview that changes facts. */
export function RecordChanges({ changes, patch, dropped }: { changes: { name: string; before: string; after: string }[]; patch?: TurnRecord; dropped?: string[] }) {
  const hasPatch = !!patch && (!!patch.cards?.length || !!patch.people?.length || !!patch.places?.length || !!patch.place || (!!patch.profile && Object.values(patch.profile).some(Boolean)));
  return <details><summary>本回合记录{changes.length ? ` · ${changes.length}项调整` : "保持原样"}{hasPatch ? " · 之前的设定一起改正" : ""}</summary>
    <dl>{changes.map((c, i) => <div key={i}><dt>{c.name}</dt><dd>原：{c.before}</dd><dd>改：{c.after}</dd></div>)}</dl>
    {patch?.cards?.map((c, i) => <p key={`c${i}`} className="muted">设定集“{c.name}”：{c.content}</p>)}
    {patch?.people?.map((p, i) => <p key={`p${i}`} className="muted">人物“{p.name}”{p.role ? `：${p.role}` : ""}{p.note ? `；${p.note}` : ""}</p>)}
    {patch?.place && <p className="muted">当前地点：{patch.place}</p>}
    {patch?.places?.map((p, i) => <p key={`pl${i}`} className="muted">地点“{p.name}”{p.description ? `：${p.description}` : ""}</p>)}
    {patch?.profile && <p className="muted">主角：{Object.values(patch.profile).filter(Boolean).join("、")}</p>}
    {!!dropped?.length && <p className="field-hint warn">这些没有改：{dropped.join("、")}。钱物统计、玩法设置要在设定里改。</p>}
  </details>;
}

/** Original passages a finding or a correction rests on. */
function Citations({ items }: { items: { detail: string; citations: { quote: string; title?: string; page?: number }[] }[] }) {
  return <>{items.map((c, i) => <div key={i}><p>{c.detail}</p>{c.citations.map((cite, j) => <blockquote key={j}>{cite.quote}<small> — {cite.title}{cite.page ? ` · 第${cite.page}页` : ""}</small></blockquote>)}</div>)}</>;
}

export function WritingAssist({ draft, onClose, onAdopt, captureReading }: {
  draft: WritingDraft; onClose: () => void; onAdopt: (text: string, correction?: CanonCorrectionPreview, revision?: PlayerRevisionPreview) => Promise<void>; captureReading?: () => void;
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
  /** 资料范围 (D184): for this request only; 自动 each time the sheet opens. */
  const [scope, setScope] = useState<SourceScope>(AUTO_SCOPE);
  const [targetPosition, setTargetPosition] = useState<number | undefined>(draft.source?.position);
  const [pickChaptersOpen, setPickChaptersOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [preview, setPreview] = useState("");
  const [showDiff, setShowDiff] = useState(true);
  const [correction, setCorrection] = useState<CanonCorrectionPreview | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [since, setSince] = useState<string | null>(null);
  const [usageTick, setUsageTick] = useState(0);
  /** A correction paused at its allowance: 接着查 goes on from what it has read (D182). */
  const [pausedRun, setPausedRun] = useState<string | null>(null);
  const task = useRef<{ cancel(): void } | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const stop = () => { generation.current++; task.current?.cancel(); task.current = null; setPending(false); setReady(false); setPreview(""); setCorrection(null); setRevision(null); setTimeout(() => { if (alive.current) setUsageTick((n) => n + 1); }, 300); };
  const close = () => { if (saving) return; alive.current = false; stop(); onClose(); };
  useEffect(() => {
    alive.current = true;
    let live = true;
    if (draft.source) {
      const bound = draft.source;
      void game.repo.getState(draft.anchor.nodeId).then((s) => {
        if (!live) return;
        if (s.source && s.source.bookId === bound.bookId) setTargetPosition(Math.min(s.source.position, bound.through ?? Infinity));
      }).catch(() => {});
    }
    return () => { live = false; alive.current = false; generation.current++; task.current?.cancel(); };
  }, [game, draft.anchor.nodeId, draft.source?.bookId, draft.source?.through]);
  const original = rewrite ? draft.text.slice(range.start, range.end) : draft.text;
  const choose = (next: TextRange) => { if (pending || saving) return; setRange(next); setReady(false); setPreview(""); setCorrection(null); setRevision(null); setError(""); };
  const pick = (next: Mode) => { choose(range); setMode(next); };
  const isWhole = range.start === whole.start && range.end === whole.end;
  const generate = async (resume?: string, overrideScope?: SourceScope) => {
    if (pending || saving) return;
    const token = ++generation.current;
    const activeScope = overrideScope ?? scope;
    setPending(true); setReady(false); setPreview(""); setCorrection(null); setRevision(null); setError(""); setPausedRun(null);
    if (!resume) setSince(new Date().toISOString());
    const current = () => alive.current && token === generation.current;
    try {
      if (canon) {
        const work = runCanonCorrection(game, { anchor: draft.anchor, range, hint, scope: activeScope }, text => { if (current()) setPreview(text); }, resume);
        task.current = work;
        const result = await work.done;
        // Only a change has a new text to show; a check or an answer is shown below as what it found.
        if (current()) { setCorrection(result); setPreview((result.outcome ?? "changed") === "changed" ? result.replacement ?? result.narrative : ""); setReady(true); }
      } else if (mode === "revise") {
        const work = game.runPlayerRevision({ anchor: draft.anchor, range, hint, scope: activeScope }, text => { if (current()) setPreview(text); });
        task.current = work;
        const result = await work.done;
        if (current()) { setRevision(result); setPreview(result.replacement); setReady(true); }
      } else {
        const work = startWriting(game, { ...draft, text: original, hint, range: rewrite ? range : undefined }, (text) => { if (current()) setPreview(text); });
        task.current = work;
        const text = await work.done;
        if (current()) { setPreview(text); setReady(true); }
      }
    } catch (e) {
      if (current()) { setError(writingError(e)); setPreview(""); if (e instanceof CanonStop && e.runId) setPausedRun(e.runId); }
    }
    finally { if (current()) { setPending(false); task.current = null; setUsageTick((n) => n + 1); } }
  };
  const outcome = correction ? correction.outcome ?? "changed" : null;
  const outcomeText = correction ? canonOutcomeText(correction, draft.source?.through) : "";
  const canAdoptEmpty = mode === "revise" && !!revision && ranges.length > 1 && !isWhole;
  const hasPreview = Boolean(preview) || (mode === "revise" && ready && revision !== null);
  const previewDiff = useMemo(() => (ready && hasPreview && preview !== original ? diffStats(diffText(original, preview)) : null), [ready, hasPreview, preview, original]);
  /** Something different to adopt: a change with its basis, a revision that changes text or facts, or any polish. */
  const adoptable = ready && (canon ? outcome === "changed" && !!correction?.corrections.length
    : mode === "revise" ? !!revision && (revision.replacement.trim() !== original.trim() || revision.recordChanges.length > 0 || !!revision.correctionPatch)
    : true);
  const adopt = async () => {
    if (!ready || saving || (!preview.trim() && !canAdoptEmpty)) return;
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
      <label>希望怎么改<input value={hint} disabled={pending || saving} onChange={(e) => { setHint(e.target.value); setReady(false); setPreview(""); setCorrection(null); setRevision(null); setError(""); setPausedRun(null); }} placeholder={PLACEHOLDER[mode]} /></label>
      {rewrite && (canon || mode === "revise") && <SourceScopeRow worldId={draft.anchor.worldId} binding={draft.source} value={scope} purpose={canon ? "correction" : "revise"} anchorPosition={targetPosition} disabled={pending || saving} onChange={(next) => { choose(range); setScope(next); }} />}
      <button className="ghost" disabled={pending || saving} onClick={() => setPresetsOpen(true)}>常用改稿要求</button>
      {presetsOpen && <MenuSheet title="常用改稿要求" onClose={() => setPresetsOpen(false)} items={WRITING_REQUIREMENT_PRESETS.filter(item => (item.mode === "polish" || rewrite) && (item.mode !== "canon" || !!draft.source)).map(item => ({ label: item.name, onSelect: () => { choose(range); setHint(item.hint); if (rewrite) setMode(item.mode); } }))} />}
      {(hasPreview || pending) && (
        <div className="stack gap-2">
          <div className="row between">
            <span className="field-label">{pending ? <span className="cursor-blink" role="status">正在改稿</span> : mode === "polish" ? "改稿（可以再改几个字）" : "改稿预览"}</span>
            {previewDiff && (
              <button type="button" className="ghost small diff-toggle" aria-pressed={showDiff} onClick={() => setShowDiff((v) => !v)}>
                {showDiff ? "看纯正文" : "对照改动"}
                <span className="diff-counts">{previewDiff.removed > 0 && <em className="del">-{previewDiff.removed}</em>}{previewDiff.added > 0 && <em className="ins">+{previewDiff.added}</em>}</span>
              </button>
            )}
          </div>
          {previewDiff && showDiff && <DiffView before={original} after={preview} />}
          {(!previewDiff || !showDiff || mode === "polish") && (
            <textarea aria-label="改稿预览" readOnly={mode !== "polish"} value={preview} disabled={pending || saving} onChange={(e) => setPreview(e.target.value)} />
          )}
        </div>
      )}
      {revision?.note && <p className="muted m-0">{revision.note}</p>}
      {revision && <RecordChanges changes={revision.recordChanges} patch={revision.correctionPatch} dropped={revision.droppedCorrections} />}
      {revision && !adoptable && <p className="muted m-0">这次改稿和原来一样，没有要采用的改动；换个说法再改一版。</p>}
      {outcomeText && <p className={outcome === "not_found" ? "field-hint warn" : "m-0"} role="status">{outcomeText}</p>}
      {correction && outcome === "changed" && <details><summary>更正与出处</summary><Citations items={correction.corrections} /></details>}
      {correction && (outcome === "verified" || outcome === "answer") && !!correction.findings?.length && <details open><summary>{outcome === "answer" ? "原文出处" : "核对依据"}</summary><Citations items={correction.findings} /></details>}
      {correction && outcome === "changed" && correction.recordChanges && <RecordChanges changes={correction.recordChanges} patch={correction.correctionPatch} />}
      {correction?.unresolved?.map((t, i) => <p className="field-hint warn" key={`u${i}`}>待核对：{t}</p>)}
      {correction?.related?.map((t, i) => <p className="muted" key={`r${i}`}>关联问题：{t}</p>)}
      {correction && ((correction.related?.length ?? 0) + (correction.unresolved?.length ?? 0) > 0) && <button disabled={pending || saving} onClick={() => { const paragraph = isWhole ? undefined : ranges.findIndex(r => r.start === range.start); captureReading?.(); onClose(); push({ name: "agent", worldId: draft.anchor.worldId, lineId: draft.anchor.lineId, skills: ["canon-reference"], target: { nodeId: draft.anchor.nodeId, ...(paragraph !== undefined ? { paragraph } : {}), evidence: correction.corrections.flatMap(c => c.citations) }, initialText: `继续核对局部改稿的关联问题，保留玩家主动分支：\n${[...correction.related ?? [], ...correction.unresolved ?? []].join("\n")}\n${hint}` }); }}>交给助手处理关联问题</button>}
      {error && <p role="alert" className="field-hint warn">{error}</p>}
      {!pending && since && <RecentUsageLine worldId={draft.anchor.worldId} purposes={["revise", "revise-passage", "段落改写", "行动润色", "correction", "writing", "tool"]} since={since} refreshKey={usageTick} />}
      {pausedRun && canon && !pending && <button className="primary" onClick={() => void generate(pausedRun)}>接着查</button>}
      {outcome === "not_found" && canon && !pending && !!draft.source && <button className="primary" onClick={() => setPickChaptersOpen(true)}>去目录选章节再查</button>}
      {((error && !pausedRun) || outcome === "not_found") && canon && !pending && <button onClick={() => { setError(""); pick("revise"); }}>改用“按我的要求改”</button>}
      {error && mode === "revise" && error.includes("只润色文字") && !pending && <button onClick={() => { setError(""); pick("polish"); }}>改用“只润色文字”</button>}
      {pickChaptersOpen && draft.source && <SourceScopeSheet worldId={draft.anchor.worldId} binding={draft.source} value={scope} purpose="correction" initialMode="chapters" anchorPosition={targetPosition} onClose={() => setPickChaptersOpen(false)} onChange={(next) => { setPickChaptersOpen(false); choose(range); setScope(next); void generate(undefined, next); }} />}
      <div className="writing-actions">
        {pending ? <button onClick={() => { stop(); setError("已取消，原文没有改动。"); }}>取消生成</button> : <button disabled={saving} onClick={close}>取消</button>}
        {!pending && <button className={hasPreview || correction ? "" : "primary"} disabled={saving || !original.trim() || (mode === "revise" && !hint.trim())} onClick={() => void generate()}>{canon ? (correction ? "再查一次" : "开始核对") : hasPreview ? "再改一版" : "生成改稿"}</button>}
        {adoptable && <button className="primary" disabled={saving || (!preview.trim() && !canAdoptEmpty)} onClick={() => void adopt()}>{rewrite ? "采用改稿" : "采用到输入框"}</button>}
      </div>
    </div>
  </Sheet>;
}
