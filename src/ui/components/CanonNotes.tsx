// 原著札记 (R29-T003, D162): digests of a bound book the player asks for once —
// a chapter range's main plot, one person, one setting, a timeline, a question —
// and then reads, edits, switches off or deletes. Each passage carries the ones
// that matter at the reading position, instead of re-reading the original.
import { createContext, useEffect, useRef, useState } from "react";
import { NOTE_KINDS, NOTE_KIND_LABEL, STORY_NOTE_KINDS, NOTE_TEXT_LIMIT, deleteNote, draftFromParts, estimateNote, gapRanges, listNotes, listStoryNotes, localNoteContent, newLocalNote, newNote, newStoryNote, nextNoteReach, noteBehind, noteChapterRange, noteNearEnd, noteOffRoute, restartOnRoute, routeIds, noteProgressDetail, noteProgressLabel, noteStepsDone, noteUnit, readNoteText, renameNote, restorePrevious, saveNote, startNoteUpdate, storyLastTurn, suggestTitle, turnLabel, type CanonNote, type NoteEstimate, type NoteKind, type NoteResume, type NoteScope } from "../../engine/sources/notes";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import { Switch } from "./Switch";

type View = { name: "list" } | { name: "new"; draft?: CanonNote } | { name: "note"; id: string };

const STORY_KIND_LABEL = Object.fromEntries(STORY_NOTE_KINDS.map(([k, l]) => [k, l])) as Record<NoteKind, string>;
const kindLabel = (n: CanonNote) => (n.source === "story" ? STORY_KIND_LABEL : NOTE_KIND_LABEL)[n.kind];

/** A note left "running" by a closed app is simply paused. */
const statusText = (n: CanonNote, running: boolean) =>
  running ? noteProgressLabel(n.progress, noteUnit(n))
    : n.status === "done" ? (n.active ? "写作时会用" : "已停用")
    : n.status === "failed" ? "没整理完" : "已暂停";

/** What a new note starts as when opened from elsewhere (a 设定集 card, the character panel). */
export interface NoteStart { kind: NoteKind; subject?: string; aliases?: string[] }

/** The play screen offers 整理成札记 through this; elsewhere (no story) it is absent. */
export const NoteEntry = createContext<((start: NoteStart) => void) | null>(null);

/**
 * 札记: 本局 (this story's own, D174) and 原著 (the bound book, D162). A story
 * without a book has only 本局; the book's page has only 原著.
 */
export function CanonNotesSheet({ bookId, worldId, position = 0, onClose, start, open }: { bookId: string | null; worldId: string | null; position?: number; onClose: () => void; start?: NoteStart; /** Opens this note directly (札记预备). */ open?: { id: string; source: "book" | "story" } }) {
  const { game, toast, ask } = useApp();
  const [tab, setTab] = useState<"story" | "book">(open?.source ?? (worldId ? "story" : "book"));
  const [view, setView] = useState<View>(start ? { name: "new" } : open ? { name: "note", id: open.id } : { name: "list" });
  const [notes, setNotes] = useState<CanonNote[] | null>(null);
  const [sections, setSections] = useState<string[]>([]);
  const [lastTurn, setLastTurn] = useState(-1);
  const [route, setRoute] = useState<Set<string> | null>(null);
  const [, setTick] = useState(0);
  const story = tab === "story" && !!worldId;
  const reload = () => void (story ? listStoryNotes(game.repo, worldId!) : bookId ? listNotes(game.repo, bookId, worldId) : Promise.resolve([])).then(setNotes);
  useEffect(() => {
    setNotes(null);
    reload();
    if (story) {
      void storyLastTurn(game.repo, worldId).then((last) => { setLastTurn(last); setSections(Array.from({ length: last + 1 }, (_, i) => turnLabel(i))); });
      void routeIds(game.repo, worldId).then(setRoute).catch(() => setRoute(null));
    } else if (bookId) {
      void game.repo.platform.sql.query("SELECT section,title FROM source_sections WHERE book_id=? ORDER BY section", [bookId]).then((rows) => setSections(rows.map((r) => String(r.title))));
    }
  }, [bookId, worldId, tab]);
  const run = (note: CanonNote, resume?: NoteResume) => {
    void game.runCanonNote(note.id, (next) => { setNotes((list) => list?.map((n) => (n.id === next.id ? { ...next, title: n.title } : n)) ?? null); setTick((t) => t + 1); }, resume)
      .then((done) => { if (done.status === "done") toast(`“${done.title}”整理好了`); reload(); })
      .catch((e) => { toast(e instanceof Error ? e.message : "没能开始整理"); reload(); });
  };
  const current = view.name === "note" ? notes?.find((n) => n.id === view.id) : undefined;
  return (
    <Sheet title={view.name === "new" ? "新建札记" : current ? current.title : worldId ? "札记" : "原著札记"} onClose={onClose}>
      {view.name === "list" && worldId && bookId && <div className="tabs" role="tablist" aria-label="札记来源">
        <button role="tab" aria-selected={tab === "story"} onClick={() => setTab("story")}>本局</button>
        <button role="tab" aria-selected={tab === "book"} onClick={() => setTab("book")}>原著</button>
      </div>}
      {view.name === "list" && <div className="stack">
        <p className="muted m-0">{story
          ? "从这局已经写出的故事里整理：主线梗概、某个人物、地点或势力、一条时间线，或者一个问题。写作时会参考和眼下剧情有关的札记；剧情往前走了，可以一键更新。"
          : "可以让 AI 整理原著，也可以手写或导入 TXT。写作时会参考和当前剧情有关的札记。"}</p>
        {notes?.length === 0 && <p className="muted">{story ? "还没有本局札记。故事有了章节摘要后，主线梗概会自动整理；也可以现在新建。" : "还没有札记。同人故事可以先整理当前章节前后的主线。"}</p>}
        <ul className="note-list">
          {notes?.map((n) => (
            <li key={n.id}><button className="note-row" onClick={() => setView({ name: "note", id: n.id })}>
              <span className="tag">{kindLabel(n)}</span><b>{n.title}</b>
              <small className={`note-status ${game.canonNoteRunning(n.id) ? "running" : n.status}`}>{statusText(n, game.canonNoteRunning(n.id))}</small>
              {!game.canonNoteRunning(n.id) && <NoteHint note={n} position={position} last={story ? lastTurn : sections.length - 1} offRoute={!!route && noteOffRoute(n, route)} />}
            </button></li>
          ))}
        </ul>
        <button className="primary" onClick={() => setView({ name: "new" })}>新建札记</button>
      </div>}
      {view.name === "new" && <NewNote bookId={bookId ?? ""} worldId={worldId} story={story} sections={sections} position={story ? 0 : position} draft={view.draft} start={start}
        onCancel={() => setView({ name: "list" })}
        onStart={async (note, generate) => {
          await saveNote(game.repo, note);
          setNotes((list) => [...(list ?? []), note]); setView({ name: "note", id: note.id });
          if (generate) run(note); else toast("札记已保存");
        }} />}
      {view.name === "note" && current && <NoteDetail key={current.id} note={current} running={game.canonNoteRunning(current.id)} position={story ? 0 : position}
        offRoute={!!route && noteOffRoute(current, route)}
        onRestart={async () => {
          const next = restartOnRoute(current, lastTurn);
          await saveNote(game.repo, next, true);
          setNotes((list) => list?.map((n) => (n.id === next.id ? next : n)) ?? null);
          run(next);
        }}
        last={story ? lastTurn : sections.length - 1}
        onBack={() => setView({ name: "list" })}
        onResume={(resume) => run(current, resume)} onPause={() => game.pauseCanonNote(current.id)}
        onUpdate={async (to) => {
          const next = startNoteUpdate(current, to);
          await saveNote(game.repo, next, true);
          setNotes((list) => list?.map((n) => (n.id === next.id ? next : n)) ?? null);
          run(next);
        }}
        onRestore={async () => {
          const restored = await restorePrevious(game.repo, current.id);
          if (restored) { setNotes((list) => list?.map((n) => (n.id === restored.id ? restored : n)) ?? null); toast("已恢复上一版", { label: "撤销", run: () => void restorePrevious(game.repo, current.id).then(reload) }); }
        }}
        onCopy={() => setView({ name: "new", draft: current })}
        onRename={async (title) => {
          await renameNote(game.repo, current.id, title);
          setNotes((list) => list?.map((n) => n.id === current.id ? { ...n, title } : n) ?? null);
        }}
        onSave={async (patch) => {
          const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
          if (patch.content !== undefined && !current.model) next.refs = newLocalNote(current, patch.content, sections.length).refs;
          await saveNote(game.repo, next, true);
          setNotes((list) => list?.map((n) => (n.id === next.id ? next : n)) ?? null);
        }}
        onDelete={async () => {
          if (!await ask({ title: `删除“${current.title}”？`, message: "删除后写作不再用到这份札记，不能撤销。", confirm: "删除", danger: true })) return;
          game.pauseCanonNote(current.id); await deleteNote(game.repo, current.id); setView({ name: "list" }); reload(); toast("札记已删除");
        }} />}
    </Sheet>
  );
}

/** 札记预备 (D178) and stale 本局札记: one quiet line on the row. */
function NoteHint({ note, position, last, offRoute }: { note: CanonNote; position: number; last: number; offRoute: boolean }) {
  if (offRoute) return <small className="note-hint">整理的是另一条路线，写作暂不使用</small>;
  if (last < 0) return null;
  if (noteNearEnd(note, position, last)) return <small className="note-hint">剧情快到第 {(note.scope.to ?? 0) + 1} 章的末尾了，可以续整理</small>;
  const behind = noteBehind(note, last);
  return behind >= 30 ? <small className="note-hint">落后 {behind} 回合，可以更新</small> : null;
}

/** Titles for 本局札记: turns, not chapters. */
function storyTitle(kind: NoteKind, scope: NoteScope): string {
  if (kind === "plot") return "主线梗概";
  if (kind === "timeline") return "本局时间线";
  if (kind === "person") return `人物：${scope.subject?.trim() || "未命名"}`;
  if (kind === "setting") return `${scope.subject?.trim() || "未命名"}`;
  return scope.question?.trim().slice(0, 24) || "问题";
}

function NewNote({ bookId, worldId, story, sections, position, draft, start, onStart, onCancel }: {
  bookId: string; worldId: string | null; story: boolean; sections: string[]; position: number; draft?: CanonNote; start?: NoteStart;
  onStart: (note: CanonNote, generate: boolean) => Promise<void>; onCancel: () => void;
}) {
  const { game, toast } = useApp();
  const last = Math.max(0, sections.length - 1);
  const [kind, setKind] = useState<NoteKind>(draft?.kind ?? start?.kind ?? "plot");
  const [from, setFrom] = useState(Math.max(0, Math.min(draft?.scope.from ?? position, last)));
  const [to, setTo] = useState(Math.min(last, draft?.scope.to ?? (story ? last : Math.max(position, 0) + 99)));
  const [subject, setSubject] = useState(draft?.scope.subject ?? start?.subject ?? ""), [aliases, setAliases] = useState(draft?.scope.aliases?.join("、") ?? start?.aliases?.join("、") ?? "");
  const [question, setQuestion] = useState(draft?.scope.question ?? "");
  const [title, setTitle] = useState(draft ? `${Array.from(draft.title).slice(0, 34).join("")}（已整理）` : "");
  const [titleEdited, setTitleEdited] = useState(!!draft);
  const [generate, setGenerate] = useState(!draft);
  const [body, setBody] = useState(() => draft ? draftFromParts(draft) : "");
  const [estimate, setEstimate] = useState<NoteEstimate | null>(null);
  const [starting, setStarting] = useState(false);
  const [picking, setPicking] = useState(false);
  useEffect(() => { setTo((t) => (story ? last : Math.min(last, t))); }, [last]);
  const ranged = kind === "plot" || kind === "timeline";
  const shift = story ? 1 : 0;
  const scope: NoteScope = ranged ? { from: Math.min(from, to), to: Math.max(from, to) }
    : kind === "question" ? { question: question.trim() }
    : { subject: subject.trim(), aliases: aliases.split(/[、，,\s]+/).map((s) => s.trim()).filter(Boolean) };
  const ready = ranged ? sections.length > 0 : kind === "question" ? !!question.trim() : !!subject.trim();
  const key = JSON.stringify([kind, scope]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!titleEdited) setTitle(story ? storyTitle(kind, scope) : suggestTitle(kind, scope));
    setEstimate(null);
    if (!ready || !generate) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void estimateNote(game.repo, { bookId, kind, scope, ...(story ? { source: "story" as const, worldId } : {}) }).then(setEstimate).catch(() => setEstimate(null)), 400);
    return () => clearTimeout(timer.current);
  }, [key, ready, generate, titleEdited]);
  const chapter = (n: number) => (story ? turnLabel(n) : `第 ${n + 1} 章${sections[n] ? ` · ${sections[n].slice(0, 18)}` : ""}`);
  const importText = async () => {
    setPicking(true);
    try {
      const text = await game.platform.files.importText();
      if (text === null) return;
      const imported = readNoteText(text);
      if (imported.title && !titleEdited) { setTitle(imported.title.slice(0, 40)); setTitleEdited(true); }
      if (imported.from !== undefined && imported.to !== undefined && imported.from <= imported.to && imported.to <= last) {
        setKind(imported.title?.startsWith("时间线：") ? "timeline" : "plot");
        setFrom(imported.from); setTo(imported.to);
      }
      setGenerate(false);
      setBody(imported.content);
    } catch (error) { toast(error instanceof Error ? error.message : "没能读取 TXT 文件"); }
    finally { setPicking(false); }
  };
  return (
    <div className="stack">
      {!draft && <div className="row" aria-label="札记录入方式">
        <button className={generate ? "primary" : ""} aria-pressed={generate} onClick={() => setGenerate(true)}>AI 整理</button>
        <button className={!generate ? "primary" : ""} aria-pressed={!generate} onClick={() => setGenerate(false)}>手写</button>
        <button disabled={picking} onClick={() => void importText()}>导入 TXT</button>
      </div>}
      <div className="note-kinds" role="radiogroup" aria-label="札记种类">
        {(story ? STORY_NOTE_KINDS : NOTE_KINDS).map(([k, label, hint]) => (
          <button key={k} role="radio" aria-checked={kind === k} className="note-kind" onClick={() => setKind(k)}><b>{label}</b><small>{hint}</small></button>
        ))}
      </div>
      {ranged && <div className="stack gap-2">
        {/* Chapters count from 1; turns from 0, the opening, so the number matches “第 N 回合”. */}
        <label>从{story ? "第" : ""}<input type="number" inputMode="numeric" min={1 - shift} max={last + 1 - shift} value={from + 1 - shift} onChange={(e) => setFrom(Math.max(0, Math.min(last, Math.trunc(Number(e.target.value)) - 1 + shift || 0)))} />{story ? "回合" : ""}</label>
        <small className="muted">{chapter(Math.min(from, to))}</small>
        <label>到{story ? "第" : ""}<input type="number" inputMode="numeric" min={1 - shift} max={last + 1 - shift} value={to + 1 - shift} onChange={(e) => setTo(Math.max(0, Math.min(last, Math.trunc(Number(e.target.value)) - 1 + shift || 0)))} />{story ? "回合" : ""}</label>
        <small className="muted">{chapter(Math.max(from, to))}（{story ? `本局到${turnLabel(last)}` : `全书共 ${sections.length} 章`}）</small>
      </div>}
      {(kind === "person" || kind === "setting") && <div className="stack gap-2">
        <label>{kind === "person" ? "人物名字" : story ? "地点、势力或物件" : "设定名称"}<input value={subject} maxLength={40} onChange={(e) => setSubject(e.target.value)} placeholder={kind === "person" ? (story ? "如：主角的名字、王掌柜" : "如：唐舞麟") : story ? "如：西市货栈、漕帮" : "如：魂导器、史莱克学院"} /></label>
        <label>别名（可不填，用顿号隔开）<input value={aliases} maxLength={120} onChange={(e) => setAliases(e.target.value)} placeholder="如：舞麟、小舞麟" /></label>
      </div>}
      {kind === "question" && <label>问题<textarea rows={3} maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="如：主角第一次见到古月娜是在什么场合？" /></label>}
      <label>标题<input value={title} maxLength={40} onChange={(e) => { setTitle(e.target.value); setTitleEdited(true); }} /></label>
      {generate ? <p className="muted m-0 note-estimate" aria-live="polite">{!ready ? "填好上面的内容后，这里会估算要花多少。"
        : !estimate ? "正在估算…"
        : !estimate.pieces ? (story ? "这局故事里还没有写到相关内容，换个名字或别名试试。" : "原著里没有找到相关内容，换个名字或别名试试。")
        : `用辅助模型约 ${estimate.requests} 次请求，读约 ${(estimate.chars / 10000).toFixed(estimate.chars >= 100000 ? 0 : 1)} 万字${estimate.digests ? `（其中 ${estimate.digests} 段用通读整理的摘要，更省）` : ""}。可以随时暂停，已整理的部分保留。`}</p>
        : <>
          {draft && <p className="muted m-0">已把目前整理出的内容带进来。请核对范围和待补提示，保存后会多一份可用于写作的札记。</p>}
          <label>札记内容<textarea aria-label="札记内容" className="note-text" rows={10} value={body} onChange={(event) => setBody(event.target.value)} /></label>
          <small className="muted">{body.length.toLocaleString()} / {NOTE_TEXT_LIMIT.toLocaleString()} 字{ranged ? " · 请确认上方章节范围" : ""}</small>
        </>}
      <div className="row">
        <button className="ghost" onClick={onCancel}>返回</button>
        <button className="primary grow" disabled={!ready || starting || picking || (generate ? estimate?.pieces === 0 : !body.trim() || body.length > NOTE_TEXT_LIMIT)} onClick={() => {
          setStarting(true);
          void Promise.resolve().then(() => {
            const named = title || (story ? storyTitle(kind, scope) : suggestTitle(kind, scope));
            const note = story && worldId ? newStoryNote(worldId, kind, scope, named) : newNote(bookId, kind, scope, named, kind === "question" ? worldId : null);
            return onStart(generate ? note : newLocalNote(note, body, sections.length), generate);
          }).catch((error) => toast(error instanceof Error ? error.message : "没能保存札记")).finally(() => setStarting(false));
        }}>{generate ? "开始整理" : "保存札记"}</button>
      </div>
    </div>
  );
}

function NoteDetail({ note, running, last, position, offRoute, onRestart, onBack, onResume, onPause, onUpdate, onRestore, onCopy, onRename, onSave, onDelete }: {
  note: CanonNote; running: boolean; last: number; position: number; offRoute: boolean; onRestart: () => Promise<void>; onBack: () => void; onResume: (resume?: NoteResume) => void; onPause: () => void;
  onUpdate: (to: number) => Promise<void>; onRestore: () => Promise<void>;
  onCopy: () => void; onRename: (title: string) => Promise<void>;
  onSave: (patch: Partial<CanonNote>) => Promise<void>; onDelete: () => void;
}) {
  const { toast, devMode } = useApp();
  const [text, setText] = useState(note.content);
  const [newTitle, setNewTitle] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [manual, setManual] = useState<{ batch: number; also: number[]; text: string } | null>(null);
  const story = note.source === "story";
  const unit = noteUnit(note);
  const covered = note.scope.to ?? -1;
  const reach = () => (story ? last : nextNoteReach(note, position, last));
  const [target, setTarget] = useState(reach);
  useEffect(() => { setText(note.content); }, [note.content]);
  useEffect(() => { setManual(null); }, [note.id]);
  useEffect(() => { setTarget(reach()); }, [last, covered, position]);
  const total = Math.max(1, note.progress.total);
  const done = noteStepsDone(note.progress);
  const gaps = note.progress.gaps ?? [];
  const parts = note.progress.parts ?? [];
  const canCopy = !running && note.status !== "done" && parts.some(Boolean);
  const carried = !!note.originWorldId;
  const updatable = note.status === "done" && !carried && !running && !offRoute && covered < last && (note.model || note.kind === "plot" || story);
  const where = (n: number) => (story ? turnLabel(n) : `第 ${n + 1} 章`);
  const saveChange = async (save: () => Promise<void>, message: string) => {
    setSaving(true);
    try { await save(); toast(message); }
    catch (error) { toast(error instanceof Error ? error.message : "没能保存修改"); }
    finally { setSaving(false); }
  };
  return (
    <div className="stack">
      <p className="muted m-0"><span className="tag">{kindLabel(note)}</span> {carried ? `来自前作《${note.originTitle ?? ""}》，当作前情背景；可以手改，不会随这个故事更新。`
        : `${note.model || note.status !== "done" ? "AI 整理，可能有误，可以直接改。" : "手动保存，可直接编辑。"}${story ? "只用于这个故事。" : note.worldId ? "只用于这个故事。" : "用这本书的故事都会用到。"}`}
        {note.status === "done" && covered >= 0 && ` 已整理到${where(covered)}。`}</p>
      {newTitle !== null && !running && <div className="stack gap-2">
        <label>新标题<input value={newTitle} maxLength={40} disabled={saving} onChange={(event) => setNewTitle(event.target.value)} /></label>
        <div className="row">
          <button className="ghost" onClick={() => setNewTitle(null)}>取消</button>
          <button disabled={saving || !newTitle.trim() || newTitle.trim() === note.title} onClick={() => void saveChange(async () => {
            await onRename(newTitle.trim()); setNewTitle(null);
          }, "标题已保存")}>保存标题</button>
        </div>
      </div>}
      {note.status !== "done" && <div className="stack gap-2">
        <div className="bar" aria-hidden="true"><i style={{ width: `${Math.round((done / total) * 100)}%` }} /></div>
        <p className="muted m-0" aria-live="polite">{noteProgressLabel(note.progress, unit)}{note.progress.update ? "（续整理）" : ""}</p>
        {devMode && <small className="muted">{noteProgressDetail(note.progress)}</small>}
        {!running && note.status === "failed" && <p className="muted m-0">{note.progress.error ?? "没整理完"}</p>}
        {!running && note.status === "failed" && note.progress.detail && <details><summary className="muted">查看原因</summary><p className="field-hint m-0">{note.progress.detail}</p></details>}
        {canCopy && <details>
          <summary className="muted">查看已整理的内容</summary>
          {parts.map((part, index) => part && <p className="note-text" key={index}>{part}</p>)}
        </details>}
        {canCopy && <button className="ghost" onClick={onCopy}>另存已整理内容</button>}
        <div className="row">{running ? <button onClick={onPause}>暂停</button>
          : <button className="primary" disabled={saving} onClick={() => onResume()}>{done || note.status === "failed" ? "接着整理" : "开始整理"}</button>}</div>
      </div>}
      {gaps.length > 0 && !running && <div className="stack gap-2">
        <p className="muted m-0">这几处服务没有处理，札记照常可用，缺的地方写在札记末尾。可以再试一次，或者自己补上要点。</p>
        {gapRanges(gaps).map(({ batches, sections }) => <div className="row" key={batches[0]}>
          <span className="grow">{noteChapterRange(sections, unit)}</span>
          <button onClick={() => onResume()}>再试</button>
          <button onClick={() => setManual({ batch: batches[0], also: batches.slice(1), text: "" })}>手动补记</button>
        </div>)}
      </div>}
      {!running && manual && <div className="stack gap-2">
        <label>写下这段的要点<textarea rows={4} maxLength={3000} value={manual.text}
          onChange={(e) => setManual({ ...manual, text: e.target.value })} /></label>
        <div className="row">
          <button className="ghost" onClick={() => setManual(null)}>取消</button>
          <button disabled={!manual.text.trim()} onClick={() => {
            onResume({ kind: "fill", ...manual });
            setManual(null);
          }}>保存并合进札记</button>
        </div>
      </div>}
      {offRoute && !running && <div className="stack gap-2">
        <p className="muted m-0">这份札记整理的是另一条路线上的故事（你后来回到前面或换了路线），写作时暂不使用，免得把没发生的事当成前情。</p>
        <button onClick={() => void onRestart().catch((e) => toast(e instanceof Error ? e.message : "没能开始整理"))}>按现在的路线重新整理</button>
      </div>}
      {updatable && <div className="stack gap-2">
        {story
          ? <button onClick={() => void onUpdate(last).catch((e) => toast(e instanceof Error ? e.message : "没能开始更新"))}>更新到现在（{turnLabel(last)}）</button>
          : <div className="row">
            <label className="grow">续整理到第<input type="number" inputMode="numeric" min={covered + 2} max={last + 1} value={target + 1}
              onChange={(e) => setTarget(Math.max(covered + 1, Math.min(last, Math.trunc(Number(e.target.value)) - 1 || 0)))} />章</label>
            <button onClick={() => void onUpdate(target).catch((e) => toast(e instanceof Error ? e.message : "没能开始续整理"))}>续整理</button>
          </div>}
        <small className="muted">只读新增的{story ? "回合" : "章节"}，再合进现有札记；你改过的内容会保留，可以恢复上一版。</small>
      </div>}
      {note.status === "done" && <>
        <Switch label="写作时使用" note={note.active ? "写到相关章节、人物或设定时带上" : "暂时不用，札记保留"} checked={note.active} onChange={(v) => { if (!saving) void saveChange(() => onSave({ active: v }), v ? "札记已启用" : "札记已停用"); }} />
        <textarea aria-label="札记内容" className="note-text" rows={14} value={text} disabled={saving} onChange={(e) => setText(e.target.value)} />
        <div className="row">
          <span className="muted grow">{text.length} 字</span>
          <button disabled={saving || text === note.content} onClick={() => void saveChange(() => onSave({ content: localNoteContent(text) }), "札记已保存")}>保存修改</button>
        </div>
        {note.previousContent && !running && <button className="ghost" onClick={() => void onRestore()}>恢复上一版</button>}
      </>}
      <div className="row">
        <button className="ghost" onClick={onBack}>全部札记</button>
        <span className="grow" />
        {!running && <button className="ghost" disabled={saving} onClick={() => setNewTitle(note.title)}>改标题</button>}
        <button className="ghost danger" disabled={saving} onClick={onDelete}>删除</button>
      </div>
    </div>
  );
}
