// 原著札记 (R29-T003, D162): digests of a bound book the player asks for once —
// a chapter range's main plot, one person, one setting, a timeline, a question —
// and then reads, edits, switches off or deletes. Each passage carries the ones
// that matter at the reading position, instead of re-reading the original.
import { useEffect, useRef, useState } from "react";
import { NOTE_KINDS, NOTE_KIND_LABEL, deleteNote, estimateNote, listNotes, newNote, saveNote, suggestTitle, type CanonNote, type NoteEstimate, type NoteKind, type NoteScope } from "../../engine/sources/notes";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import { Switch } from "./Switch";

type View = { name: "list" } | { name: "new" } | { name: "note"; id: string };

/** A note left "running" by a closed app is simply paused. */
const statusText = (n: CanonNote, running: boolean) =>
  running ? `整理中 ${n.progress.parts.length}/${Math.max(1, n.progress.total)}`
    : n.status === "done" ? (n.active ? "写作时会用" : "已停用")
    : n.status === "failed" ? "没整理完" : "已暂停";

export function CanonNotesSheet({ bookId, worldId, position = 0, onClose }: { bookId: string; worldId: string | null; position?: number; onClose: () => void }) {
  const { game, toast, ask } = useApp();
  const [view, setView] = useState<View>({ name: "list" });
  const [notes, setNotes] = useState<CanonNote[] | null>(null);
  const [sections, setSections] = useState<string[]>([]);
  const [, setTick] = useState(0);
  const reload = () => void listNotes(game.repo, bookId, worldId).then(setNotes);
  useEffect(() => {
    reload();
    void game.repo.platform.sql.query("SELECT section,title FROM source_sections WHERE book_id=? ORDER BY section", [bookId]).then((rows) => setSections(rows.map((r) => String(r.title))));
  }, [bookId, worldId]);
  const run = (note: CanonNote) => {
    void game.runCanonNote(note.id, (next) => { setNotes((list) => list?.map((n) => (n.id === next.id ? next : n)) ?? null); setTick((t) => t + 1); })
      .then((done) => { if (done.status === "done") toast(`“${done.title}”整理好了`); else if (done.status === "failed") toast(done.progress.error ?? "没整理完，已完成的部分保留"); reload(); })
      .catch((e) => { toast(e instanceof Error ? e.message : "没能开始整理"); reload(); });
  };
  const current = view.name === "note" ? notes?.find((n) => n.id === view.id) : undefined;
  return (
    <Sheet title={view.name === "new" ? "新建札记" : current ? current.title : "原著札记"} onClose={onClose}>
      {view.name === "list" && <div className="stack">
        <p className="muted m-0">让 AI 先把原著的一段主线、一个人物或一个设定整理成札记。写作时只带上用得着的札记，比每段都翻原文更快、更省；札记可以直接改。</p>
        {notes?.length === 0 && <p className="muted">还没有札记。同人故事可以先整理当前章节前后的主线。</p>}
        <ul className="note-list">
          {notes?.map((n) => (
            <li key={n.id}><button className="note-row" onClick={() => setView({ name: "note", id: n.id })}>
              <span className="tag">{NOTE_KIND_LABEL[n.kind]}</span><b>{n.title}</b>
              <small className={`note-status ${game.canonNoteRunning(n.id) ? "running" : n.status}`}>{statusText(n, game.canonNoteRunning(n.id))}</small>
            </button></li>
          ))}
        </ul>
        <button className="primary" onClick={() => setView({ name: "new" })}>新建札记</button>
      </div>}
      {view.name === "new" && <NewNote bookId={bookId} worldId={worldId} sections={sections} position={position}
        onCancel={() => setView({ name: "list" })}
        onStart={async (note) => { await saveNote(game.repo, note); setNotes((list) => [...(list ?? []), note]); setView({ name: "note", id: note.id }); run(note); }} />}
      {view.name === "note" && current && <NoteDetail note={current} running={game.canonNoteRunning(current.id)}
        onBack={() => setView({ name: "list" })}
        onResume={() => run(current)} onPause={() => game.pauseCanonNote(current.id)}
        onSave={async (patch) => { const next = { ...current, ...patch, updatedAt: new Date().toISOString() }; await saveNote(game.repo, next); setNotes((list) => list?.map((n) => (n.id === next.id ? next : n)) ?? null); }}
        onDelete={async () => {
          if (!await ask({ title: `删除“${current.title}”？`, message: "删除后写作不再用到这份札记，不能撤销。", confirm: "删除", danger: true })) return;
          game.pauseCanonNote(current.id); await deleteNote(game.repo, current.id); setView({ name: "list" }); reload(); toast("札记已删除");
        }} />}
    </Sheet>
  );
}

function NewNote({ bookId, worldId, sections, position, onStart, onCancel }: {
  bookId: string; worldId: string | null; sections: string[]; position: number; onStart: (note: CanonNote) => Promise<void>; onCancel: () => void;
}) {
  const { game } = useApp();
  const last = Math.max(0, sections.length - 1);
  const [kind, setKind] = useState<NoteKind>("plot");
  const [from, setFrom] = useState(Math.max(0, Math.min(position, last)));
  const [to, setTo] = useState(Math.min(last, Math.max(position, 0) + 99));
  const [subject, setSubject] = useState(""), [aliases, setAliases] = useState(""), [question, setQuestion] = useState("");
  const [title, setTitle] = useState(""), [titleEdited, setTitleEdited] = useState(false);
  const [estimate, setEstimate] = useState<NoteEstimate | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => { setTo((t) => Math.min(last, t)); }, [last]);
  const ranged = kind === "plot" || kind === "timeline";
  const scope: NoteScope = ranged ? { from: Math.min(from, to), to: Math.max(from, to) }
    : kind === "question" ? { question: question.trim() }
    : { subject: subject.trim(), aliases: aliases.split(/[、，,\s]+/).map((s) => s.trim()).filter(Boolean) };
  const ready = ranged ? sections.length > 0 : kind === "question" ? !!question.trim() : !!subject.trim();
  const key = JSON.stringify([kind, scope]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!titleEdited) setTitle(suggestTitle(kind, scope));
    setEstimate(null);
    if (!ready) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void estimateNote(game.repo, { bookId, kind, scope }).then(setEstimate).catch(() => setEstimate(null)), 400);
    return () => clearTimeout(timer.current);
  }, [key, ready]);
  const chapter = (n: number) => `第 ${n + 1} 章${sections[n] ? ` · ${sections[n].slice(0, 18)}` : ""}`;
  return (
    <div className="stack">
      <div className="note-kinds" role="radiogroup" aria-label="札记种类">
        {NOTE_KINDS.map(([k, label, hint]) => (
          <button key={k} role="radio" aria-checked={kind === k} className="note-kind" onClick={() => setKind(k)}><b>{label}</b><small>{hint}</small></button>
        ))}
      </div>
      {ranged && <div className="stack gap-2">
        <label>从<input type="number" inputMode="numeric" min={1} max={last + 1} value={from + 1} onChange={(e) => setFrom(Math.max(0, Math.min(last, Number(e.target.value) - 1 || 0)))} /></label>
        <small className="muted">{chapter(Math.min(from, to))}</small>
        <label>到<input type="number" inputMode="numeric" min={1} max={last + 1} value={to + 1} onChange={(e) => setTo(Math.max(0, Math.min(last, Number(e.target.value) - 1 || 0)))} /></label>
        <small className="muted">{chapter(Math.max(from, to))}（全书共 {sections.length} 章）</small>
      </div>}
      {(kind === "person" || kind === "setting") && <div className="stack gap-2">
        <label>{kind === "person" ? "人物名字" : "设定名称"}<input value={subject} maxLength={40} onChange={(e) => setSubject(e.target.value)} placeholder={kind === "person" ? "如：唐舞麟" : "如：魂导器、史莱克学院"} /></label>
        <label>别名（可不填，用顿号隔开）<input value={aliases} maxLength={120} onChange={(e) => setAliases(e.target.value)} placeholder="如：舞麟、小舞麟" /></label>
      </div>}
      {kind === "question" && <label>问题<textarea rows={3} maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="如：主角第一次见到古月娜是在什么场合？" /></label>}
      <label>标题<input value={title} maxLength={40} onChange={(e) => { setTitle(e.target.value); setTitleEdited(true); }} /></label>
      <p className="muted m-0 note-estimate" aria-live="polite">{!ready ? "填好上面的内容后，这里会估算要花多少。"
        : !estimate ? "正在估算…"
        : !estimate.pieces ? "原著里没有找到相关内容，换个名字或别名试试。"
        : `用辅助模型约 ${estimate.requests} 次请求，读约 ${(estimate.chars / 10000).toFixed(estimate.chars >= 100000 ? 0 : 1)} 万字${estimate.digests ? `（其中 ${estimate.digests} 段用通读整理的摘要，更省）` : ""}。可以随时暂停，已整理的部分保留。`}</p>
      <div className="row">
        <button className="ghost" onClick={onCancel}>返回</button>
        <button className="primary grow" disabled={!ready || starting || estimate?.pieces === 0} onClick={() => {
          setStarting(true);
          void onStart(newNote(bookId, kind, scope, title || suggestTitle(kind, scope), kind === "question" ? worldId : null)).finally(() => setStarting(false));
        }}>开始整理</button>
      </div>
    </div>
  );
}

function NoteDetail({ note, running, onBack, onResume, onPause, onSave, onDelete }: {
  note: CanonNote; running: boolean; onBack: () => void; onResume: () => void; onPause: () => void;
  onSave: (patch: Partial<CanonNote>) => Promise<void>; onDelete: () => void;
}) {
  const { toast } = useApp();
  const [text, setText] = useState(note.content);
  useEffect(() => { setText(note.content); }, [note.content]);
  const total = Math.max(1, note.progress.total);
  return (
    <div className="stack">
      <p className="muted m-0"><span className="tag">{NOTE_KIND_LABEL[note.kind]}</span> AI 整理，可能有误，可以直接改。{note.worldId ? "只用于这个故事。" : "用这本书的故事都会用到。"}</p>
      {note.status !== "done" && <div className="stack gap-2">
        <div className="bar" aria-hidden="true"><i style={{ width: `${Math.round((note.progress.parts.length / total) * 100)}%` }} /></div>
        <p className="muted m-0">{running ? `正在整理：${note.progress.parts.length}/${total}` : note.status === "failed" ? note.progress.error ?? "没整理完" : `已暂停：${note.progress.parts.length}/${total}`}</p>
        <div className="row">{running ? <button onClick={onPause}>暂停</button> : <button className="primary" onClick={onResume}>{note.progress.parts.length ? "接着整理" : "开始整理"}</button>}</div>
      </div>}
      {note.status === "done" && <>
        <Switch label="写作时使用" note={note.active ? "写到相关章节、人物或设定时带上" : "暂时不用，札记保留"} checked={note.active} onChange={(v) => void onSave({ active: v })} />
        <textarea className="note-text" rows={14} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row">
          <span className="muted grow">{text.length} 字</span>
          <button disabled={text === note.content} onClick={() => void onSave({ content: text.trim() }).then(() => toast("札记已保存"))}>保存修改</button>
        </div>
      </>}
      <div className="row">
        <button className="ghost" onClick={onBack}>全部札记</button>
        <span className="grow" />
        <button className="ghost danger" onClick={onDelete}>删除</button>
      </div>
    </div>
  );
}
