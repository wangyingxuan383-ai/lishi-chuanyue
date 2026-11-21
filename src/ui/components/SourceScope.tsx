// 资料范围 (D184): a row “资料范围：自动 ›” in every feature that uses the
// original; its page chooses 自动, only some notes, or some chapters of the book.
// The choice is for this request only: each time the feature opens it is 自动.
import { useEffect, useState } from "react";
import type { SourceBinding } from "../../engine/sources/types";
import { bookChapters, choosableNotes, chapterLabel, chapterWords, isChosen, notesRange, rangeChars, scopeLabel, type BookChapter, type SourceScope } from "../../engine/sources/scope";
import { turnLabel, type CanonNote } from "../../engine/sources/notes";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import { RangeInputs } from "./RangeInputs";

export type ScopePurpose = "correction" | "revise" | "organize" | "ask" | "opening";

/** Which chapters (原著札记) or how far (本局札记) a note covers, so two notes of one title can be told apart. */
const reach = (n: CanonNote) => {
  if (n.source === "story") return n.scope.to !== undefined ? `到${turnLabel(n.scope.to)} · ` : "";
  const r = notesRange([n]);
  return r ? `${chapterWords(r)} · ` : "";
};
const amount = (chars: number) => chars >= 10000 ? `${(chars / 10000).toFixed(1).replace(/\.0$/, "")} 万字` : `${chars.toLocaleString()} 字`;

export function SourceScopeRow({ worldId, binding, value, onChange, purpose, disabled }: {
  worldId: string | null; binding: SourceBinding | null | undefined; value: SourceScope; onChange: (scope: SourceScope) => void;
  purpose: ScopePurpose; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = scopeLabel(value);
  return <>
    <button type="button" className="settings-entry scope-row" disabled={disabled} onClick={() => setOpen(true)} aria-label={`资料范围：${label}，点开选择`}>
      <span><b>资料范围</b><small>{isChosen(value) ? "只用你选的资料" : "按要求自动找相关的原文和札记"}</small></span>
      <span aria-hidden="true">{label} ›</span>
    </button>
    {open && <SourceScopeSheet worldId={worldId} binding={binding} value={value} purpose={purpose} onClose={() => setOpen(false)} onChange={(scope) => { onChange(scope); setOpen(false); }} />}
  </>;
}

export function SourceScopeSheet({ worldId, binding, value, purpose, onChange, onClose }: {
  worldId: string | null; binding: SourceBinding | null | undefined; value: SourceScope; purpose: ScopePurpose;
  onChange: (scope: SourceScope) => void; onClose: () => void;
}) {
  const { game } = useApp();
  const [mode, setMode] = useState<SourceScope["mode"]>(isChosen(value) ? value.mode : "auto");
  const [chapters, setChapters] = useState<BookChapter[] | null>(null);
  const [notes, setNotes] = useState<{ book: CanonNote[]; story: CanonNote[] } | null>(null);
  const [room, setRoom] = useState(0);
  const start = binding?.position ?? 0;
  const [from, setFrom] = useState(value.mode === "chapters" ? value.from : start);
  const [to, setTo] = useState(value.mode === "chapters" ? value.to : start);
  const [picked, setPicked] = useState<Set<string>>(new Set(value.mode === "notes" ? value.noteIds : []));
  useEffect(() => {
    let live = true;
    void (async () => {
      const [c, n, r] = await Promise.all([binding ? bookChapters(game.repo, binding) : Promise.resolve([]), choosableNotes(game.repo, binding, worldId), game.scopeRoom()]);
      if (!live) return;
      setChapters(c); setNotes(n); setRoom(r);
      const last = Math.max(0, c.length - 1);
      setFrom((f) => Math.min(f, last)); setTo((t) => Math.min(t, last));
    })().catch(() => { if (live) { setChapters([]); setNotes({ book: [], story: [] }); } });
    return () => { live = false; };
  }, []);
  const last = Math.max(0, (chapters?.length ?? 1) - 1);
  const range = { from: Math.min(from, to), to: Math.max(from, to) };
  const chars = chapters ? rangeChars(chapters, range) : 0;
  // Each passage's label costs a little; “约” covers it.
  const whole = room > 0 && chars * 1.03 <= room;
  const allNotes = [...(notes?.book ?? []), ...(notes?.story ?? [])];
  const chosenIds = allNotes.filter((n) => picked.has(n.id)).map((n) => n.id);
  const noteHint = purpose === "correction" ? "先把勾选的札记交给 AI。" : purpose === "ask" ? "只依据勾选的札记回答，不查原文。" : "只把勾选的札记交给 AI，不查原文。";
  const options: [SourceScope["mode"], string, string][] = [
    ["auto", "自动（推荐）", "按你的要求自动找相关的原文和札记。"],
    ["notes", "只用指定札记", noteHint],
    ...(binding ? [["chapters", "原著指定章节", "只用这几章的原文。"] as [SourceScope["mode"], string, string]] : []),
  ];
  const ready = mode === "auto" || (mode === "notes" && chosenIds.length > 0) || (mode === "chapters" && !!chapters?.length);
  const choose = () => onChange(mode === "chapters" ? { mode, ...range } : mode === "notes" ? { mode, noteIds: chosenIds } : { mode: "auto" });
  const toggle = (id: string, on: boolean) => setPicked((set) => { const next = new Set(set); if (on) next.add(id); else next.delete(id); return next; });
  const noteList = (title: string, list: CanonNote[]) => list.length > 0 && <fieldset className="stack gap-2 scope-notes">
    <legend className="muted">{title}</legend>
    {list.map((n) => <label key={n.id} className="row"><input type="checkbox" className="check-20" checked={picked.has(n.id)} onChange={(e) => toggle(n.id, e.target.checked)} /><span className="grow">{n.title}<small className="muted"> · {reach(n)}约 {amount(n.content.length)}</small></span></label>)}
  </fieldset>;
  return <Sheet title="资料范围" onClose={onClose}>
    <div className="stack">
      <p className="muted m-0">只对这一次有效，下次打开还是自动。</p>
      <div className="note-kinds scope-modes" role="radiogroup" aria-label="资料范围">
        {options.map(([m, label, hint]) => <button key={m} type="button" role="radio" aria-checked={mode === m} className="note-kind" onClick={() => setMode(m)}><b>{label}</b><small>{hint}</small></button>)}
      </div>
      {mode === "notes" && (notes === null ? <p className="muted m-0">正在读取札记…</p>
        : allNotes.length === 0 ? <p className="muted m-0">还没有整理好的札记。可以先在游玩页的“更多 → 札记”里整理，再回来选。</p>
        : <>{noteList("原著札记", notes.book)}{noteList("本局札记", notes.story)}
          {purpose === "correction" && <p className="muted m-0">纠错要引原文：查原文只在勾选的原著札记覆盖的章节里；勾选的都没写章节时，在本局能看的范围里查。</p>}</>)}
      {mode === "chapters" && (chapters === null ? <p className="muted m-0">正在读取章节…</p>
        : chapters.length === 0 ? <p className="muted m-0">这本书在本局允许的范围里没有正文。</p>
        : <>
          <RangeInputs last={last} from={from} to={to} setFrom={setFrom} setTo={setTo} describe={(n) => chapterLabel(n, chapters[n]?.title)}
            total={binding?.through != null ? `本局可参考到第 ${binding.through + 1} 章` : `全书共 ${chapters.length} 章`} />
          <p className={whole ? "m-0" : "field-hint m-0"} aria-live="polite">{chapterWords(range)}约 {amount(chars)}，{whole
            ? "会整段交给 AI。"
            : "一次放不下，会在这几章里找和要求相关的段落。想让 AI 读全这几章，可以先在“札记”里把它们整理成一份札记，再选“只用指定札记”。"}</p>
        </>)}
      <div className="writing-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button type="button" className="primary" disabled={!ready} onClick={choose}>用这个范围</button>
      </div>
    </div>
  </Sheet>;
}
