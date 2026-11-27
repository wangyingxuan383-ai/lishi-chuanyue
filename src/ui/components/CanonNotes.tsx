// 原著札记 (R29-T003, D162, D194): digests of a bound book the player asks for once —
// a chapter range's main plot, one person, one setting, a timeline, a question —
// and then reads, edits, switches off or deletes. Each passage carries the ones
// that matter at the reading position, instead of re-reading the original.
import { createContext, useEffect, useRef, useState } from "react";
import {
  LONG_BOOK_SECTION_THRESHOLD,
  MAX_RECOMMENDED_NOTE_SPAN,
  NOTE_KINDS,
  NOTE_KIND_LABEL,
  NOTE_TEXT_LIMIT,
  RECOMMENDED_NOTE_SPAN,
  STORY_NOTE_KINDS,
  deleteNote,
  draftFromParts,
  estimateNote,
  gapRanges,
  listNotes,
  listStoryNotes,
  localNoteContent,
  newLocalNote,
  newNote,
  newStoryNote,
  nextNoteReach,
  noteBehind,
  noteChapterRange,
  noteNearEnd,
  noteOffRoute,
  noteProgressDetail,
  noteProgressLabel,
  noteStepsDone,
  noteUnit,
  preflightNoteUpdate,
  readNoteText,
  renameNote,
  resolveStoryNoteScope,
  restartOnRoute,
  restorePrevious,
  routeIds,
  saveNote,
  startNoteUpdate,
  storyLastTurn,
  suggestNextPlotRange,
  suggestTitle,
  turnLabel,
  type CanonNote,
  type NoteEstimate,
  type NoteKind,
  type NoteResume,
  type NoteScope,
} from "../../engine/sources/notes";
import { useApp } from "../app/context";
import { EmptyVignette } from "./ChineseArt";
import { Sheet } from "./Sheet";
import { RecentUsageLine } from "./TurnUsage";
import { RangeInputs } from "./RangeInputs";
import { chapterLabel } from "../../engine/sources/scope";
import { Switch } from "./Switch";

type View =
  | { name: "list" }
  | { name: "new"; draft?: CanonNote; initialRange?: { from: number; to: number } }
  | { name: "note"; id: string };

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
export function CanonNotesSheet({
  bookId,
  worldId,
  position = 0,
  onClose,
  start,
  open,
}: {
  bookId: string | null;
  worldId: string | null;
  position?: number;
  onClose: () => void;
  start?: NoteStart;
  /** Opens this note or a prefilled new-note volume directly (札记预备). */
  open?: { id?: string; source: "book" | "story"; initialRange?: { from: number; to: number } };
}) {
  const { game, toast, ask } = useApp();
  const [tab, setTab] = useState<"story" | "book">(open?.source ?? (worldId ? "story" : "book"));
  const [view, setView] = useState<View>(
    start
      ? { name: "new" }
      : open?.id
        ? { name: "note", id: open.id }
        : open?.initialRange
          ? { name: "new", initialRange: open.initialRange }
          : { name: "list" },
  );
  const [notes, setNotes] = useState<CanonNote[] | null>(null);
  const [sections, setSections] = useState<string[]>([]);
  const [totalBookSections, setTotalBookSections] = useState(0);
  const [lastTurn, setLastTurn] = useState(-1);
  const [route, setRoute] = useState<Set<string> | null>(null);
  const [, setTick] = useState(0);
  const story = tab === "story" && !!worldId;
  const loadGen = useRef(0);
  const reload = () => {
    const gen = ++loadGen.current;
    void (story ? listStoryNotes(game.repo, worldId!) : bookId ? listNotes(game.repo, bookId, worldId) : Promise.resolve([]))
      .then((items) => { if (loadGen.current === gen) setNotes(items); });
  };
  useEffect(() => {
    let live = true;
    const gen = ++loadGen.current;
    setNotes(null);
    void (story ? listStoryNotes(game.repo, worldId!) : bookId ? listNotes(game.repo, bookId, worldId) : Promise.resolve([]))
      .then((items) => { if (live && loadGen.current === gen) setNotes(items); });
    if (story) {
      void storyLastTurn(game.repo, worldId).then((last) => { if (live) { setLastTurn(last); setSections(Array.from({ length: last + 1 }, (_, i) => turnLabel(i))); } });
      void routeIds(game.repo, worldId).then((ids) => { if (live) setRoute(ids); }).catch(() => { if (live) setRoute(null); });
    } else if (bookId) {
      void game.repo.platform.sql.query(
        "SELECT section,title FROM source_sections WHERE book_id=? ORDER BY section",
        [bookId],
      ).then((rows) => {
        if (!live) return;
        setSections(rows.map((r) => String(r.title)));
        setTotalBookSections(rows.length);
      });
    }
    return () => { live = false; };
  }, [bookId, worldId, tab]);
  const run = (note: CanonNote, resume?: NoteResume) => {
    void game.runCanonNote(
      note.id,
      (next) => {
        setNotes((list) =>
          list?.map((n) => (n.id === next.id ? { ...next, title: next.status === "done" ? next.title : n.title } : n)) ?? null,
        );
        setTick((t) => t + 1);
      },
      resume,
    )
      .then((done) => { if (done.status === "done") toast(`“${done.title}”整理好了`); reload(); })
      .catch((e) => { toast(e instanceof Error ? e.message : "没能开始整理"); reload(); });
  };
  const current = view.name === "note" ? notes?.find((n) => n.id === view.id) : undefined;
  const suggestedVolume =
    !story && sections.length >= LONG_BOOK_SECTION_THRESHOLD && notes !== null
      ? suggestNextPlotRange(notes, sections.length, position)
      : null;
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
        {suggestedVolume && (
          <div className="note-volume-guide">
            <b>长篇分段整理建议（全书共 {sections.length} 节）</b>
            <p className="muted m-0">
              上百章乃至千章的长篇小说，建议按每 {RECOMMENDED_NOTE_SPAN} 章新建一份「主线剧情」札记，保留的伏笔与细节远比把上千章滚进同一份札记丰富；写作与检索时会自动跨多份札记联合查用。
            </p>
            {!suggestedVolume.allCovered ? (
              <>
                <button
                  type="button"
                  className="note-volume-action"
                  onClick={() => setView({ name: "new", initialRange: { from: suggestedVolume.from, to: suggestedVolume.to } })}
                >
                  {suggestedVolume.plotNoteCount === 0
                    ? `新建首卷百章札记（第 ${suggestedVolume.from + 1}～${suggestedVolume.to + 1} 节）`
                    : `新建下一百章札记（第 ${suggestedVolume.from + 1}～${suggestedVolume.to + 1} 节）`}
                </button>
                {(suggestedVolume.incompletePlotCount ?? 0) > 0 && (
                  <small className="muted">
                    另有 {suggestedVolume.incompletePlotCount} 份主线札记未整理完、已停用或含待补章节，暂未计入已覆盖范围。
                  </small>
                )}
              </>
            ) : (
              <small className="muted">全书 {sections.length} 节已由 {suggestedVolume.plotNoteCount} 份主线札记完整覆盖。</small>
            )}
          </div>
        )}
        {notes?.length === 0 && (
          <EmptyVignette
            kind="blank-bamboo"
            title={story ? "还没有本局札记" : "还没有原著札记"}
            hint={story ? "故事有了章节摘要后，主线梗概会自动整理；也可以现在新建。" : "同人故事可以先整理当前章节前后的主线。"}
            compact
          />
        )}
        <ul className="note-list">
          {notes?.map((n) => {
            const nextSec = (n.scope.to ?? -1) + 1;
            const hasNextCover =
              !story &&
              (n.kind === "plot" || n.kind === "timeline") &&
              n.scope.to !== undefined &&
              !!notes?.some(
                (other) =>
                  other.id !== n.id &&
                  other.source !== "story" &&
                  other.kind === n.kind &&
                  other.status === "done" &&
                  other.active &&
                  Boolean(other.content.trim()) &&
                  !(other.progress.gaps ?? []).some((g) => g.sections.includes(nextSec)) &&
                  (other.scope.from ?? 0) <= nextSec &&
                  (other.scope.to ?? -1) >= nextSec,
              );
            return (
              <li key={n.id}><button className="note-row" onClick={() => setView({ name: "note", id: n.id })}>
                <span className="tag">{kindLabel(n)}</span><b>{n.title}</b>
                <small className={`note-status ${game.canonNoteRunning(n.id) ? "running" : n.status}`}>{statusText(n, game.canonNoteRunning(n.id))}</small>
                {!game.canonNoteRunning(n.id) && <NoteHint note={n} position={position} last={story ? lastTurn : sections.length - 1} offRoute={!!route && noteOffRoute(n, route)} hasNextCover={hasNextCover} />}
              </button></li>
            );
          })}
        </ul>
        <button className="primary" onClick={() => setView({ name: "new" })}>新建札记</button>
      </div>}
      {view.name === "new" && <NewNote bookId={bookId ?? ""} worldId={worldId} story={story} sections={sections} totalSections={story ? sections.length : (totalBookSections || sections.length)} position={story ? 0 : position} draft={view.draft} initialRange={view.initialRange} existingNotes={notes ?? undefined} start={start}
        onCancel={() => setView({ name: "list" })}
        onStart={async (note, generate) => {
          await saveNote(game.repo, note);
          setNotes((list) => [...(list ?? []), note]); setView({ name: "note", id: note.id });
          if (generate) run(note); else toast("札记已保存");
        }} />}
      {view.name === "note" && current && <NoteDetail key={current.id} worldId={worldId} note={current} running={game.canonNoteRunning(current.id)} position={story ? 0 : position}
        offRoute={!!route && noteOffRoute(current, route)}
        onRestart={async () => {
          const next = restartOnRoute(current, lastTurn);
          await preflightNoteUpdate(game.repo, next, !!game.llm);
          await saveNote(game.repo, next, true);
          setNotes((list) => list?.map((n) => (n.id === next.id ? next : n)) ?? null);
          run(next);
        }}
        last={story ? lastTurn : sections.length - 1}
        onBack={() => setView({ name: "list" })}
        onResume={(resume) => run(current, resume)} onPause={() => game.pauseCanonNote(current.id)}
        onUpdate={async (to, syncTitle) => {
          const next = startNoteUpdate(current, to, syncTitle);
          await preflightNoteUpdate(game.repo, next, !!game.llm);
          await saveNote(game.repo, next, true);
          setNotes((list) => list?.map((n) => (n.id === next.id ? next : n)) ?? null);
          run(next);
        }}
        onCreateNextVolume={(range) => setView({ name: "new", initialRange: range })}
        onRestore={async () => {
          const restored = await restorePrevious(game.repo, current.id);
          if (restored) { setNotes((list) => list?.map((n) => (n.id === restored.id ? restored : n)) ?? null); toast("已恢复上一版", restored.previousContent ? { label: "撤销", run: () => void restorePrevious(game.repo, current.id).then(reload) } : undefined); }
        }}
        onCopy={() => setView({ name: "new", draft: current })}
        onRename={async (title) => {
          await renameNote(game.repo, current.id, title);
          setNotes((list) => list?.map((n) => n.id === current.id ? { ...n, title } : n) ?? null);
        }}
        onSave={async (patch) => {
          const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
          if (patch.content !== undefined && !current.model) next.refs = newLocalNote(current, patch.content, story ? sections.length : (totalBookSections || sections.length)).refs;
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

/** 札记预备 (D178, D194) and stale 本局札记: one quiet line on the row. */
function NoteHint({ note, position, last, offRoute, hasNextCover = false }: { note: CanonNote; position: number; last: number; offRoute: boolean; hasNextCover?: boolean }) {
  if (offRoute) return <small className="note-hint">整理的是另一条路线，写作暂不使用</small>;
  if (note.scope.staleFrom !== undefined) return <small className="note-hint">{turnLabel(note.scope.staleFrom)}之后的正文改过，札记可能过时</small>;
  if (last < 0) return null;
  if (!hasNextCover && noteNearEnd(note, position, last)) {
    const span = (note.scope.to ?? 0) - (note.scope.from ?? 0) + 1;
    if (note.source !== "story" && last + 1 >= LONG_BOOK_SECTION_THRESHOLD && span >= 85) {
      return <small className="note-hint">剧情快到第 {(note.scope.to ?? 0) + 1} 节末尾，建议新建下一百章札记</small>;
    }
    return <small className="note-hint">剧情快到第 {(note.scope.to ?? 0) + 1} 节的末尾了，可以续整理</small>;
  }
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

function NewNote({ bookId, worldId, story, sections, totalSections, position, draft, initialRange, existingNotes, start, onStart, onCancel }: {
  bookId: string; worldId: string | null; story: boolean; sections: string[]; totalSections: number; position: number; draft?: CanonNote; initialRange?: { from: number; to: number }; existingNotes?: CanonNote[]; start?: NoteStart;
  onStart: (note: CanonNote, generate: boolean) => Promise<void>; onCancel: () => void;
}) {
  const { game, toast } = useApp();
  const last = Math.max(0, sections.length - 1);
  const computeInitialRange = () => {
    if (draft?.scope.from !== undefined && draft?.scope.to !== undefined) {
      return { from: Math.max(0, Math.min(draft.scope.from, last)), to: Math.min(last, draft.scope.to) };
    }
    if (!story && initialRange) {
      return { from: Math.max(0, Math.min(initialRange.from, last)), to: Math.min(last, initialRange.to) };
    }
    if (!story && sections.length >= LONG_BOOK_SECTION_THRESHOLD && existingNotes) {
      const sug = suggestNextPlotRange(existingNotes, sections.length, position);
      if (sug) return { from: sug.from, to: sug.to };
    }
    const f = Math.max(0, Math.min(position, last));
    return { from: f, to: story ? last : Math.min(last, f + RECOMMENDED_NOTE_SPAN - 1) };
  };
  const initRange = computeInitialRange();
  const [kind, setKind] = useState<NoteKind>(draft?.kind ?? start?.kind ?? "plot");
  const [from, setFrom] = useState(initRange.from);
  const [to, setTo] = useState(initRange.to);
  const rangeTouched = useRef(!!draft || !!initialRange);
  const [subject, setSubject] = useState(draft?.scope.subject ?? start?.subject ?? ""), [aliases, setAliases] = useState(draft?.scope.aliases?.join("、") ?? start?.aliases?.join("、") ?? "");
  const [question, setQuestion] = useState(draft?.scope.question ?? "");
  const [title, setTitle] = useState(draft ? `${Array.from(draft.title).slice(0, 34).join("")}（已整理）` : "");
  const [titleEdited, setTitleEdited] = useState(!!draft);
  const [generate, setGenerate] = useState(!draft);
  const [importedExternal, setImportedExternal] = useState(false);
  const [body, setBody] = useState(() => draft ? draftFromParts(draft) : "");
  const [estimate, setEstimate] = useState<NoteEstimate | null>(null);
  const [starting, setStarting] = useState(false);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (!sections.length) return;
    if (!rangeTouched.current) {
      const next = computeInitialRange();
      setFrom(next.from);
      setTo(next.to);
    } else {
      setFrom((f) => Math.min(last, f));
      setTo((t) => (story ? last : Math.min(last, t)));
    }
  }, [last, sections.length, story, position]);
  const ranged = kind === "plot" || kind === "timeline";
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const spanCount = hi - lo + 1;
  const scope: NoteScope = ranged
    ? { from: lo, to: hi }
    : kind === "question"
      ? { question: question.trim() }
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
  const chapter = (n: number) => (story ? turnLabel(n) : chapterLabel(n, sections[n]));
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
        setImportedExternal(false);
      } else {
        setImportedExternal(true);
      }
      setGenerate(false);
      setBody(imported.content);
    } catch (error) { toast(error instanceof Error ? error.message : "没能读取 TXT 文件"); }
    finally { setPicking(false); }
  };
  return (
    <div className="stack">
      {!draft && <div className="row" aria-label="札记录入方式">
        <button className={generate ? "primary" : ""} aria-pressed={generate} onClick={() => { setGenerate(true); setImportedExternal(false); }}>AI 整理</button>
        <button className={!generate && !importedExternal ? "primary" : ""} aria-pressed={!generate && !importedExternal} onClick={() => { setGenerate(false); setImportedExternal(false); }}>手写</button>
        <button disabled={picking} onClick={() => void importText()}>导入 TXT</button>
      </div>}
      <div className="note-kinds" role="radiogroup" aria-label="札记种类">
        {(story ? STORY_NOTE_KINDS : NOTE_KINDS).map(([k, label, hint]) => (
          <button key={k} role="radio" aria-checked={kind === k} className="note-kind" onClick={() => setKind(k)}><b>{label}</b><small>{hint}</small></button>
        ))}
      </div>
      {ranged && <>
        <RangeInputs last={last} from={from} to={to} setFrom={(n) => { rangeTouched.current = true; setFrom(n); }} setTo={(n) => { rangeTouched.current = true; setTo(n); }} story={story} describe={chapter} total={story ? `本局到${turnLabel(last)}` : `全书共 ${totalSections} 节`} />
        {!story && sections.length >= LONG_BOOK_SECTION_THRESHOLD && (
          <div className="note-range-shortcuts">
            <button
              type="button"
              className="ghost small"
              disabled={lo <= 0}
              onClick={() => {
                rangeTouched.current = true;
                const nextTo = Math.max(0, lo - 1);
                const nextFrom = Math.max(0, nextTo - RECOMMENDED_NOTE_SPAN + 1);
                setFrom(nextFrom);
                setTo(nextTo);
              }}
            >
              ← 上一百章
            </button>
            {spanCount > RECOMMENDED_NOTE_SPAN && (
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  rangeTouched.current = true;
                  setFrom(lo);
                  setTo(Math.min(last, lo + RECOMMENDED_NOTE_SPAN - 1));
                }}
              >
                按 {RECOMMENDED_NOTE_SPAN} 章收紧
              </button>
            )}
            <button
              type="button"
              className="ghost small"
              disabled={hi >= last}
              onClick={() => {
                rangeTouched.current = true;
                const nextFrom = Math.min(last, hi + 1);
                const nextTo = Math.min(last, nextFrom + RECOMMENDED_NOTE_SPAN - 1);
                setFrom(nextFrom);
                setTo(nextTo);
              }}
            >
              下一百章 →
            </button>
          </div>
        )}
        {!story && spanCount > MAX_RECOMMENDED_NOTE_SPAN && (
          <p className="field-hint warn m-0">
            当前跨度共 {spanCount} 节。超过 {MAX_RECOMMENDED_NOTE_SPAN} 节会被多层压缩、损失细节，建议每 {RECOMMENDED_NOTE_SPAN} 章建一份札记。
          </p>
        )}
      </>}
      {(kind === "person" || kind === "setting") && <div className="stack gap-2">
        <label>{kind === "person" ? "人物名字" : story ? "地点、势力或物件" : "设定名称"}<input value={subject} maxLength={40} onChange={(e) => setSubject(e.target.value)} placeholder={kind === "person" ? (story ? "如：主角的名字、王掌柜" : "如：林舟") : story ? "如：西市货栈、漕帮" : "如：机关傀儡、青云书院"} /></label>
        <label>别名（可不填，用顿号隔开）<input value={aliases} maxLength={120} onChange={(e) => setAliases(e.target.value)} placeholder="如：阿舟、林兄" /></label>
      </div>}
      {kind === "question" && <label>问题<textarea rows={3} maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="如：主角第一次见到师父是在什么场合？" /></label>}
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
          void (async () => {
            const named = title || (story ? storyTitle(kind, scope) : suggestTitle(kind, scope));
            const finalScope = story && worldId && !generate ? await resolveStoryNoteScope(game.repo, worldId, scope) : scope;
            const note = story && worldId ? newStoryNote(worldId, kind, finalScope, named) : newNote(bookId, kind, finalScope, named, kind === "question" ? worldId : null);
            return onStart(generate ? note : newLocalNote(note, body, totalSections), generate);
          })().catch((error) => toast(error instanceof Error ? error.message : "没能保存札记")).finally(() => setStarting(false));
        }}>{generate ? "开始整理" : "保存札记"}</button>
      </div>
    </div>
  );
}

function NoteDetail({ note, running, last, position, offRoute, onRestart, onBack, onResume, onPause, onUpdate, onCreateNextVolume, onRestore, onCopy, onRename, onSave, onDelete }: {
  note: CanonNote; worldId?: string | null; running: boolean; last: number; position: number; offRoute: boolean; onRestart: () => Promise<void>; onBack: () => void; onResume: (resume?: NoteResume) => void; onPause: () => void;
  onUpdate: (to: number, syncTitle: boolean) => Promise<void>; onCreateNextVolume?: (range: { from: number; to: number }) => void; onRestore: () => Promise<void>;
  onCopy: () => void; onRename: (title: string) => Promise<void>;
  onSave: (patch: Partial<CanonNote>) => Promise<void>; onDelete: () => void;
}) {
  const { toast, devMode } = useApp();
  const [text, setText] = useState(note.content);
  const [newTitle, setNewTitle] = useState<string | null>(null);
  const [syncTitle, setSyncTitle] = useState(true);
  const [saving, setSaving] = useState(false);
  const [manual, setManual] = useState<{ batch: number; also: number[]; text: string } | null>(null);
  const [since, setSince] = useState<string | null>(null);
  const [usageTick, setUsageTick] = useState(0);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running) {
      setSince((prev) => prev ?? new Date().toISOString());
    } else if (wasRunning.current) {
      setUsageTick((n) => n + 1);
    }
    wasRunning.current = running;
  }, [running]);
  useEffect(() => { setSince(null); setUsageTick(0); }, [note.id]);
  const story = note.source === "story";
  const unit = noteUnit(note);
  const covered = note.scope.to ?? -1;
  const reach = () => (story ? last : nextNoteReach(note, position, last));
  const [target, setTarget] = useState(reach);
  const [targetText, setTargetText] = useState(() => String(reach() + 1));
  useEffect(() => { setText(note.content); }, [note.content]);
  useEffect(() => { setManual(null); }, [note.id]);
  useEffect(() => { const next = reach(); setTarget(next); setTargetText(String(next + 1)); }, [last, covered, position]);
  const total = Math.max(1, note.progress.total);
  const done = noteStepsDone(note.progress);
  const gaps = note.progress.gaps ?? [];
  const parts = note.progress.parts ?? [];
  const canCopy = !running && note.status !== "done" && parts.some(Boolean);
  const carried = !!note.originWorldId;
  const hasRange = note.scope.to !== undefined;
  const updatable = note.status === "done" && !carried && !running && !offRoute && hasRange && covered < last && (note.model || note.kind === "plot" || story);
  const currentSpan = covered - (note.scope.from ?? 0) + 1;
  const targetSpan = target - (note.scope.from ?? 0) + 1;
  const preferNextVolume =
    !story &&
    onCreateNextVolume &&
    (note.kind === "plot" || note.kind === "timeline") &&
    last + 1 >= LONG_BOOK_SECTION_THRESHOLD &&
    covered >= 0 &&
    covered < last &&
    (currentSpan >= 85 || targetSpan > MAX_RECOMMENDED_NOTE_SPAN)
      ? { from: covered + 1, to: Math.min(last, covered + RECOMMENDED_NOTE_SPAN) }
      : null;
  const where = (n: number) => (story ? turnLabel(n) : `第 ${n + 1} 节`);
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
      {!offRoute && note.scope.staleFrom !== undefined && note.status === "done" && !running && <div className="stack gap-2">
        <p className="muted m-0">{turnLabel(note.scope.staleFrom)}之后的正文改过，这份札记可能还写着改之前的事。写作时会提醒 AI 以正文为准。{note.scope.auto ? "自动的主线梗概会在章节摘要更新后自己重整。" : ""}</p>
        <button onClick={() => void onRestart().catch((e) => toast(e instanceof Error ? e.message : "没能开始整理"))}>按现在的正文重新整理</button>
      </div>}
      {offRoute && !running && <div className="stack gap-2">
        <p className="muted m-0">这份札记整理的是另一条路线上的故事（你后来回到前面或换了路线），写作时暂不使用，免得把没发生的事当成前情。</p>
        <button onClick={() => void onRestart().catch((e) => toast(e instanceof Error ? e.message : "没能开始整理"))}>按现在的路线重新整理</button>
      </div>}
      {updatable && <div className="stack gap-2">
        {preferNextVolume && onCreateNextVolume && (
          <div className="note-volume-guide">
            <b>建议改为新建下一百章札记</b>
            <p className="muted m-0">
              当前札记已覆盖 {currentSpan} 节。长篇原著每 {RECOMMENDED_NOTE_SPAN} 章分卷新建一份札记，比继续滚入同一份札记更能保留章节细节。
            </p>
            <button
              type="button"
              className="note-volume-action"
              onClick={() => onCreateNextVolume(preferNextVolume)}
            >
              新建第 {preferNextVolume.from + 1}～{preferNextVolume.to + 1} 节札记
            </button>
          </div>
        )}
        {story
          ? <button onClick={() => void onUpdate(last, syncTitle).catch((e) => toast(e instanceof Error ? e.message : "没能开始更新"))}>更新到现在（{turnLabel(last)}）</button>
          : <div className="row">
            <label className="grow">续整理到第<input type="text" inputMode="numeric" pattern="[0-9]*" value={targetText}
              onChange={(e) => {
                const raw = e.target.value;
                setTargetText(raw);
                if (/^\d+$/.test(raw.trim())) {
                  setTarget(Math.max(covered + 1, Math.min(last, Math.trunc(Number(raw)) - 1)));
                }
              }}
              onBlur={() => {
                const raw = targetText.trim();
                const next = /^\d+$/.test(raw) ? Math.max(covered + 1, Math.min(last, Math.trunc(Number(raw)) - 1)) : target;
                setTarget(next);
                setTargetText(String(next + 1));
              }} />节</label>
            <button onClick={() => void onUpdate(target, syncTitle).catch((e) => toast(e instanceof Error ? e.message : "没能开始续整理"))}>续整理</button>
          </div>}
        <Switch
          label="同步更新札记标题"
          note={story ? "随新进展更新标题，恢复上一版时一并还原" : "按合并后的章节范围与阶段自动更新标题，恢复上一版时一并还原"}
          checked={syncTitle}
          onChange={setSyncTitle}
        />
        <small className="muted">只读新增的{story ? "回合" : "章节"}，再合进现有札记；你改过的内容会保留，可以恢复上一版。</small>
      </div>}
      {note.status === "done" && <>
        <Switch label="写作时使用" note={note.active ? "写到相关章节、人物或设定时带上" : "暂时不用，札记保留"} checked={note.active} onChange={(v) => { if (!saving) void saveChange(() => onSave({ active: v }), v ? "札记已启用" : "札记已停用"); }} />
        <textarea aria-label="札记内容" className="note-text" rows={14} value={text} disabled={saving} onChange={(e) => setText(e.target.value)} />
        <div className="row">
          <span className="muted grow">{text.length} 字</span>
          <button disabled={saving || text === note.content} onClick={() => void saveChange(() => onSave({ content: localNoteContent(text) }), "札记已保存")}>保存修改</button>
        </div>
      </>}
      {note.previousContent && !running && <button className="ghost" onClick={() => void onRestore()}>恢复上一版</button>}
      {!running && since && <RecentUsageLine worldId={note.worldId ?? null} purposes={["canon-notes"]} since={since} refreshKey={usageTick} />}
      <div className="row">
        <button className="ghost" onClick={onBack}>全部札记</button>
        <span className="grow" />
        {!running && <button className="ghost" disabled={saving} onClick={() => setNewTitle(note.title)}>改标题</button>}
        <button className="ghost danger" disabled={saving} onClick={onDelete}>删除</button>
      </div>
    </div>
  );
}
