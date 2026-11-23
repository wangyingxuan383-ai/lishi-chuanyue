// 资料范围 (D184): a row “资料范围：自动 ›” in every feature that uses the
// original; its page chooses 自动, only some notes, or some chapters of the book
// via a novel-reader-style searchable directory (with direct section inputs).
// The choice is for this request only: each time the feature opens it is 自动.
import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceBinding } from "../../engine/sources/types";
import { bookChapters, choosableNotes, chapterLabel, chapterQueryRank, chapterRangeSummary, chapterRowMeta, chapterWords, isChosen, notesRange, rangeChars, scopeLabel, wholeChapterFits, type BookChapter, type SourceScope } from "../../engine/sources/scope";
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

const TOC_PAGE = 120;

export function SourceScopeRow({ worldId, binding, value, onChange, purpose, disabled, anchorPosition }: {
  worldId: string | null; binding: SourceBinding | null | undefined; value: SourceScope; onChange: (scope: SourceScope) => void;
  purpose: ScopePurpose; disabled?: boolean; anchorPosition?: number;
}) {
  const { game } = useApp();
  const [open, setOpen] = useState(false);
  const [chapterSummary, setChapterSummary] = useState("");
  const label = scopeLabel(value);
  useEffect(() => {
    let live = true;
    if (value.mode !== "chapters" || !binding) { setChapterSummary(""); return; }
    void game.repo.platform.sql.query(
      "SELECT section, title FROM source_sections WHERE book_id=? AND section IN (?, ?)",
      [binding.bookId, value.from, value.to],
    ).then((rows) => {
      if (!live) return;
      const bySection = new Map(rows.map((r) => [Number(r.section), String(r.title)]));
      const a = chapterLabel(value.from, bySection.get(value.from));
      const b = chapterLabel(value.to, bySection.get(value.to));
      setChapterSummary(value.from === value.to ? a : a === b ? `${a}（第 ${value.from + 1} 节） ～ ${b}（第 ${value.to + 1} 节）` : `${a} ～ ${b}`);
    }).catch(() => { if (live) setChapterSummary(""); });
    return () => { live = false; };
  }, [game, binding?.bookId, value]);
  const subtitle = !isChosen(value)
    ? "按要求自动找相关的原文和札记"
    : value.mode === "chapters" && chapterSummary
      ? `只用：${chapterSummary}`
      : "只用你选的资料";
  return <>
    <button type="button" className="settings-entry scope-row" disabled={disabled} onClick={() => setOpen(true)} aria-label={`资料范围：${label}，点开选择`}>
      <span><b>资料范围</b><small>{subtitle}</small></span>
      <span aria-hidden="true">{label} ›</span>
    </button>
    {open && <SourceScopeSheet worldId={worldId} binding={binding} value={value} purpose={purpose} anchorPosition={anchorPosition} onClose={() => setOpen(false)} onChange={(scope) => { onChange(scope); setOpen(false); }} />}
  </>;
}

export function SourceScopeSheet({ worldId, binding, value, purpose, onChange, onClose, initialMode, anchorPosition }: {
  worldId: string | null; binding: SourceBinding | null | undefined; value: SourceScope; purpose: ScopePurpose;
  onChange: (scope: SourceScope) => void; onClose: () => void; initialMode?: SourceScope["mode"]; anchorPosition?: number;
}) {
  const { game } = useApp();
  const [mode, setMode] = useState<SourceScope["mode"]>(initialMode ?? (isChosen(value) ? value.mode : "auto"));
  const [chapters, setChapters] = useState<BookChapter[] | null>(null);
  const [notes, setNotes] = useState<{ book: CanonNote[]; story: CanonNote[] } | null>(null);
  const [room, setRoom] = useState(0);
  const start = anchorPosition ?? binding?.position ?? 0;
  const [from, setFrom] = useState(value.mode === "chapters" ? value.from : start);
  const [to, setTo] = useState(value.mode === "chapters" ? value.to : start);
  const [pickMode, setPickMode] = useState<"single" | "range">(value.mode === "chapters" && value.from !== value.to ? "range" : "single");
  const [rangeAnchor, setRangeAnchor] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [tocOffset, setTocOffset] = useState(0);
  const [tocLimit, setTocLimit] = useState(TOC_PAGE);
  const tocListRef = useRef<HTMLDivElement>(null);
  const scrolledOnce = useRef(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(value.mode === "notes" ? value.noteIds : []));
  useEffect(() => {
    let live = true;
    void (async () => {
      const [c, n, r] = await Promise.all([binding ? bookChapters(game.repo, binding) : Promise.resolve([]), choosableNotes(game.repo, binding, worldId), game.scopeRoom(purpose)]);
      if (!live) return;
      setChapters(c); setNotes(n); setRoom(r);
      const lastSection = c.length ? c[c.length - 1].section : 0;
      const clampSection = (n: number) => Math.max(0, Math.min(n, lastSection));
      const nextFrom = clampSection(value.mode === "chapters" ? value.from : start);
      const nextTo = clampSection(value.mode === "chapters" ? value.to : start);
      setFrom(nextFrom); setTo(nextTo);
      const idx = c.findIndex((item) => item.section === nextFrom);
      if (idx > TOC_PAGE / 2) setTocOffset(Math.max(0, idx - Math.floor(TOC_PAGE / 3)));
    })().catch(() => { if (live) { setChapters([]); setNotes({ book: [], story: [] }); } });
    return () => { live = false; };
  }, []);

  const bySection = useMemo(() => new Map((chapters ?? []).map((c) => [c.section, c])), [chapters]);
  const last = chapters?.length ? chapters[chapters.length - 1].section : 0;
  const range = { from: Math.min(from, to), to: Math.max(from, to) };
  const chars = chapters ? rangeChars(chapters, range) : 0;
  const whole = chapters ? wholeChapterFits(chapters, range, room) : false;
  const filtered = useMemo(() => {
    if (!chapters) return [];
    if (!query.trim()) return chapters;
    return chapters
      .map((c) => ({ c, rank: chapterQueryRank(c, query) }))
      .filter((x) => x.rank > 0)
      .sort((a, b) => b.rank - a.rank || a.c.section - b.c.section)
      .map((x) => x.c);
  }, [chapters, query]);
  const searching = !!query.trim();
  const visibleChapters = searching
    ? filtered.slice(0, tocLimit)
    : filtered.slice(tocOffset, tocOffset + tocLimit);
  const hasEarlier = !searching && tocOffset > 0;
  const hasLater = searching ? filtered.length > tocLimit : tocOffset + tocLimit < filtered.length;

  useEffect(() => {
    if (mode !== "chapters") {
      scrolledOnce.current = false;
      return;
    }
    if (!chapters?.length || scrolledOnce.current) return;
    scrolledOnce.current = true;
    requestAnimationFrame(() => {
      const target = tocListRef.current?.querySelector<HTMLElement>(`[data-section="${from}"]`);
      target?.scrollIntoView({ block: "center" });
    });
  }, [mode, chapters, from]);

  const jumpToSection = (section: number) => {
    if (!chapters?.length) return;
    setQuery("");
    const idx = chapters.findIndex((c) => c.section === section);
    if (idx >= 0) {
      if (idx < tocOffset || idx >= tocOffset + tocLimit) {
        setTocOffset(Math.max(0, idx - Math.floor(TOC_PAGE / 3)));
        setTocLimit(TOC_PAGE);
      }
      requestAnimationFrame(() => {
        tocListRef.current?.querySelector<HTMLElement>(`[data-section="${section}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
  };

  const selectNearby = () => {
    const pos = Math.max(0, Math.min(start, last));
    const a = Math.max(0, pos - 2);
    const b = Math.min(last, pos + 2);
    setPickMode(a === b ? "single" : "range");
    setRangeAnchor(null);
    setFrom(a);
    setTo(b);
    jumpToSection(pos);
  };

  const tapChapter = (section: number) => {
    if (pickMode === "single") {
      setFrom(section);
      setTo(section);
      setRangeAnchor(null);
      return;
    }
    if (rangeAnchor === null) {
      setRangeAnchor(section);
      setFrom(section);
      setTo(section);
    } else {
      setFrom(Math.min(rangeAnchor, section));
      setTo(Math.max(rangeAnchor, section));
      setRangeAnchor(null);
    }
  };

  const describeSection = (n: number) => {
    const item = bySection.get(n);
    if (!item) return chapterLabel(n);
    const { primary, shifted } = chapterRowMeta(item);
    return shifted ? `${primary}（第 ${n + 1} 节）` : chapterLabel(n, item.title);
  };

  const allNotes = [...(notes?.book ?? []), ...(notes?.story ?? [])];
  const chosenIds = allNotes.filter((n) => picked.has(n.id)).map((n) => n.id);
  const noteHint = purpose === "correction" ? "先把勾选的札记交给 AI。" : purpose === "ask" ? "只依据勾选的札记回答，不查原文。" : "只把勾选的札记交给 AI，不查原文。";
  const options: [SourceScope["mode"], string, string][] = [
    ["auto", "自动（推荐）", "按你的要求自动找相关的原文和札记。"],
    ["notes", "只用指定札记", noteHint],
    ...(binding ? [["chapters", "原著指定章节", "在目录里挑单章或连续区间。"] as [SourceScope["mode"], string, string]] : []),
  ];
  const ready = mode === "auto" || (mode === "notes" && chosenIds.length > 0) || (mode === "chapters" && !!chapters?.length);
  const choose = () => onChange(mode === "chapters" ? { mode, ...range } : mode === "notes" ? { mode, noteIds: chosenIds } : { mode: "auto" });
  const toggle = (id: string, on: boolean) => setPicked((set) => { const next = new Set(set); if (on) next.add(id); else next.delete(id); return next; });
  const noteList = (title: string, list: CanonNote[]) => list.length > 0 && <fieldset className="stack gap-2 scope-notes">
    <legend className="muted">{title}</legend>
    {list.map((n) => <label key={n.id} className="row"><input type="checkbox" className="check-20" checked={picked.has(n.id)} onChange={(e) => toggle(n.id, e.target.checked)} /><span className="grow">{n.title}<small className="muted"> · {reach(n)}约 {amount(n.content.length)}</small></span></label>)}
  </fieldset>;
  const rangeSummary = chapters ? chapterRangeSummary(chapters, range) : "";
  const hasShift = useMemo(() => (chapters ?? []).some((c) => chapterRowMeta(c).shifted), [chapters]);

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
      {mode === "chapters" && (chapters === null ? <p className="muted m-0">正在读取目录…</p>
        : chapters.length === 0 ? <p className="muted m-0">这本书在本局允许的范围里没有正文。</p>
        : <div className="stack gap-2 scope-chapter-picker">
          <div className="scope-toc-bar">
            <input type="search" aria-label="搜索原著目录" value={query}
              onChange={(e) => { setQuery(e.target.value); setTocLimit(TOC_PAGE); }}
              placeholder="搜章名或章号，如 35、三十五、渡口" />
          </div>
          <div className="scope-toc-chips">
            <div className="segmented scope-pick-mode" role="group" aria-label="选择方式">
              <button type="button" aria-pressed={pickMode === "single"} onClick={() => { setPickMode("single"); setRangeAnchor(null); setTo(from); }}>选单章</button>
              <button type="button" aria-pressed={pickMode === "range"} onClick={() => { setPickMode("range"); setRangeAnchor(null); }}>选区间</button>
            </div>
            <button type="button" className="ghost small" onClick={selectNearby}>当前进度附近</button>
            <button type="button" className="ghost small" onClick={() => jumpToSection(range.from)}>跳到已选</button>
          </div>
          {pickMode === "range" && (
            <small className="muted m-0">
              {rangeAnchor !== null
                ? `已选起点「${describeSection(rangeAnchor)}」，再点一章作为终点。`
                : "依次点击目录里的起始章与结束章，即可选中连续区间。"}
            </small>
          )}
          {hasShift && <small className="muted m-0">本书含序章、简介或分卷，括号内的「第 N 节」为书内顺序编号，目录按原著真实标题显示。</small>}
          <div className="scope-toc" ref={tocListRef} role="listbox" aria-label="原著章节目录">
            {hasEarlier && (
              <button type="button" className="ghost scope-toc-more" onClick={() => setTocOffset((o) => Math.max(0, o - TOC_PAGE))}>
                显示更早章节（前 {tocOffset} 节）
              </button>
            )}
            {visibleChapters.length === 0 ? (
              <p className="muted scope-toc-empty">目录里没有匹配「{query.trim()}」的章节，换个关键词或章号试试。</p>
            ) : visibleChapters.map((c) => {
              const { primary, shifted } = chapterRowMeta(c);
              const inRange = c.section >= range.from && c.section <= range.to;
              const isStart = c.section === range.from;
              const isEnd = c.section === range.to;
              const isCurrent = c.section === start;
              const badge = rangeAnchor === c.section ? "起点"
                : isStart && isEnd ? "已选"
                : isStart ? "起"
                : isEnd ? "止"
                : null;
              return (
                <button
                  key={c.section}
                  type="button"
                  role="option"
                  aria-selected={inRange}
                  data-section={c.section}
                  className={`scope-toc-item${inRange ? " selected" : ""}${isStart || isEnd ? " edge" : ""}`}
                  onClick={() => tapChapter(c.section)}
                >
                  <span className="scope-toc-main">
                    <b>{primary}</b>
                    <small>第 {c.section + 1} 节{shifted ? "（书内顺序）" : ""} · 约 {amount(c.chars)}</small>
                  </span>
                  <span className="scope-toc-tags">
                    {isCurrent && <span className="scope-badge current">当前</span>}
                    {badge && <span className="scope-badge picked">{badge}</span>}
                  </span>
                </button>
              );
            })}
            {hasLater && (
              <button type="button" className="ghost scope-toc-more" onClick={() => setTocLimit((n) => n + TOC_PAGE)}>
                显示更多章节（还有 {(searching ? filtered.length - tocLimit : filtered.length - tocOffset - tocLimit)} 节）
              </button>
            )}
          </div>
          <RangeInputs last={last} from={from} to={to}
            setFrom={(n) => { setFrom(n); setRangeAnchor(null); }}
            setTo={(n) => { setTo(n); setRangeAnchor(null); }}
            describe={describeSection}
            total={binding?.through != null ? `本局可参考到第 ${binding.through + 1} 节（共 ${chapters.length} 节）` : `全书共 ${chapters.length} 节`} />
          <p className={whole ? "m-0" : "field-hint m-0"} aria-live="polite">{chapterWords(range)}{rangeSummary && rangeSummary !== chapterWords(range) ? `（${rangeSummary}）` : ""}约 {amount(chars)}，{whole
            ? "会整段交给 AI。"
            : "一次放不下，会在这几章里找和要求相关的段落。想让 AI 读全这几章，可以先在“札记”里把它们整理成一份札记，再选“只用指定札记”。"}</p>
        </div>)}
      <div className="writing-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button type="button" className="primary" disabled={!ready} onClick={choose}>用这个范围</button>
      </div>
    </div>
  </Sheet>;
}
