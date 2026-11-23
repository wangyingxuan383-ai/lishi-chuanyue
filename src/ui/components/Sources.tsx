import { useEffect, useMemo, useRef, useState } from "react";
import { CanonNotesSheet } from "./CanonNotes";
import { BUILTIN_SOURCE_USAGES } from "../../content/writingPresets";
import { useApp } from "../app/context";
import { localFind } from "../app/localFind";
import { Sheet } from "./Sheet";
import { StoryText } from "./StoryText";
import { Icon } from "./Icon";
import { readBudget } from "./budgetMath";
import { parseBook, type TextEncoding } from "../../engine/sources/parse";
import { analysisJobs, chunksOf, deleteBook, getBook, listBooks, referenceContext, saveBook } from "../../engine/sources/library";
import { chapterLabel, chapterQueryRank, chapterRowMeta, type BookChapter } from "../../engine/sources/scope";
import { newBinding, type AnalysisJob, type SourceBinding, type SourceBook } from "../../engine/sources/types";
import "./writing.css";

const TOC_PAGE = 120;
const charAmount = (chars: number) => chars >= 10000 ? `${(chars / 10000).toFixed(1).replace(/\.0$/, "")} 万字` : `${chars.toLocaleString()} 字`;

/** Searchable reader-style chapter picker for 原著位置 / 截至章节 (replaces raw 1000+ option <select>). */
function ChapterPickSheet({ title, book, maxSection, value, onSelect, onClose }: {
  title: string; book: SourceBook; maxSection?: number; value: number; onSelect: (section: number) => void; onClose: () => void;
}) {
  const chapters = useMemo<BookChapter[]>(() => {
    const limit = maxSection ?? book.sections.length - 1;
    return book.sections.slice(0, limit + 1).map((s, section) => ({ section, title: s.title, chars: s.text.length }));
  }, [book, maxSection]);
  const [query, setQuery] = useState("");
  const [jumpInput, setJumpInput] = useState(String(value + 1));
  const initialIdx = Math.max(0, chapters.findIndex((c) => c.section === value));
  const [offset, setOffset] = useState(() => initialIdx > TOC_PAGE / 2 ? Math.max(0, initialIdx - Math.floor(TOC_PAGE / 3)) : 0);
  const [limit, setLimit] = useState(TOC_PAGE);
  const listRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const filtered = useMemo(() => {
    if (!query.trim()) return chapters;
    return chapters
      .map((c) => ({ c, rank: chapterQueryRank(c, query) }))
      .filter((x) => x.rank > 0)
      .sort((a, b) => b.rank - a.rank || a.c.section - b.c.section)
      .map((x) => x.c);
  }, [chapters, query]);
  const searching = !!query.trim();
  const visible = searching ? filtered.slice(0, limit) : filtered.slice(offset, offset + limit);
  const hasEarlier = !searching && offset > 0;
  const hasLater = searching ? filtered.length > limit : offset + limit < filtered.length;
  const hasShift = useMemo(() => chapters.some((c) => chapterRowMeta(c).shifted), [chapters]);

  useEffect(() => {
    if (scrolled.current) return;
    scrolled.current = true;
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-section="${value}"]`)?.scrollIntoView({ block: "center" });
    });
  }, [value]);

  const jumpTo = (sec: number) => {
    const clamped = Math.max(0, Math.min(chapters.length - 1, sec));
    setQuery("");
    if (clamped < offset || clamped >= offset + limit) {
      setOffset(Math.max(0, clamped - Math.floor(TOC_PAGE / 3)));
      setLimit(TOC_PAGE);
    }
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-section="${clamped}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  };

  const applyJump = () => {
    const n = Math.trunc(Number(jumpInput.trim()));
    if (!Number.isSafeInteger(n) || n < 1) return;
    const clamped = Math.max(0, Math.min(chapters.length - 1, n - 1));
    onSelect(clamped);
    onClose();
  };

  return <Sheet title={title} onClose={onClose}>
    <div className="stack gap-2 scope-chapter-picker">
      <div className="scope-toc-bar">
        <input type="search" aria-label={`搜索${title}`} value={query}
          onChange={(e) => { setQuery(e.target.value); setLimit(TOC_PAGE); }}
          placeholder="搜章名或章号，如 61、六十一、永冻之域" />
      </div>
      <div className="row">
        <label className="row grow gap-2">
          <span className="muted">直达第</span>
          <input type="text" inputMode="numeric" pattern="[0-9]*" aria-label="书内顺序节号" style={{ width: "5.5em" }} value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") applyJump(); }} />
          <span className="muted">节（共 {chapters.length} 节）</span>
        </label>
        <button type="button" className="ghost small" onClick={applyJump}>确定</button>
        <button type="button" className="ghost small" onClick={() => jumpTo(value)}>跳到当前</button>
      </div>
      {hasShift && <small className="muted m-0">本书含序章、简介或分卷，目录按原著真实标题显示，下方“第 N 节”为书内顺序编号。</small>}
      <div className="scope-toc" ref={listRef} role="listbox" aria-label={title}>
        {hasEarlier && (
          <button type="button" className="ghost scope-toc-more" onClick={() => setOffset((o) => Math.max(0, o - TOC_PAGE))}>
            显示更早章节（前 {offset} 节）
          </button>
        )}
        {visible.length === 0 ? (
          <p className="muted scope-toc-empty">目录里没有匹配「{query.trim()}」的章节，换个关键词或章号试试。</p>
        ) : visible.map((c) => {
          const { primary, shifted } = chapterRowMeta(c);
          const selected = c.section === value;
          return (
            <button key={c.section} type="button" role="option" aria-selected={selected} data-section={c.section}
              className={`scope-toc-item${selected ? " selected edge" : ""}`}
              onClick={() => { onSelect(c.section); onClose(); }}>
              <span className="scope-toc-main">
                <b>{primary}</b>
                <small>第 {c.section + 1} 节{shifted ? "（书内顺序）" : ""} · 约 {charAmount(c.chars)}</small>
              </span>
              {selected && <span className="scope-toc-tags"><span className="scope-badge picked">当前</span></span>}
            </button>
          );
        })}
        {hasLater && (
          <button type="button" className="ghost scope-toc-more" onClick={() => setLimit((n) => n + TOC_PAGE)}>
            显示更多章节（还有 {searching ? filtered.length - limit : filtered.length - offset - limit} 节）
          </button>
        )}
      </div>
    </div>
  </Sheet>;
}

/** A collapsed summary reads book metadata, never the full imported text. */
export function SourceSummary({ value, label = "参考书籍" }: { value: SourceBinding | null | undefined; label?: string }) {
  const { game } = useApp();
  const [book, setBook] = useState<{ id: string; title: string } | null>(null);
  const [posTitle, setPosTitle] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    setBook(null); setPosTitle(""); setLoaded(false);
    if (value) void Promise.all([
      listBooks(game.repo),
      game.repo.platform.sql.query("SELECT title FROM source_sections WHERE book_id=? AND section=?", [value.bookId, value.position]).catch(() => []),
    ]).then(([books, rows]) => {
      if (live) {
        setBook(books.find((b) => b.id === value.bookId) ?? null);
        setPosTitle(rows[0] ? String(rows[0].title) : "");
        setLoaded(true);
      }
    }).catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [game, value?.bookId, value?.position]);
  const selected = book?.id === value?.bookId ? book : null;
  const posText = value ? `第 ${value.position + 1} 节${posTitle ? `（${posTitle.slice(0, 16)}）` : ""}` : "";
  return <span className="source-name">{label}{value && <small className="muted" style={{ display: "block", lineHeight: 1.6 }}>
    {selected?.title ?? (loaded ? "书籍暂不可读，请重新选择" : "正在读取书名…")} · 位置 {posText} · {value.through === null ? "全书" : `截至第 ${value.through + 1} 节`} · {!value.fanfic ? "只作资料" : value.plot === "canon" ? "尽量沿原剧情" : "允许改写原著"} · {value.method === "analysis" ? "通读整理与原文" : "直接检索引用"}
  </small>}</span>;
}

/** Uses the same library rows and copy-into-form behavior as 我的要求组. */
function SourcePresets({ value, onChange, disabled = false }: { value: string; onChange: (s: string) => void; disabled?: boolean }) {
  const { game, askName, toast } = useApp();
  type SavedUsage = { id: string; name: string; text: string };
  const [presets, setPresets] = useState<SavedUsage[]>([]);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<string | null>(null);
  const key = "source:presets:1";
  const load = async () => {
    const raw = await game.repo.getSetting<unknown>(key, []);
    return Array.isArray(raw) ? raw.filter((item): item is SavedUsage => !!item && typeof item.id === "string" && typeof item.name === "string" && typeof item.text === "string") : [];
  };
  useEffect(() => {
    let live = true;
    void load().then((items) => { if (live) { setPresets(items); setLoaded(true); } }).catch(() => { if (live) { setLoaded(true); toast("没能读取已保存用法，请稍后重试"); } });
    return () => { live = false; };
  }, [game]);
  const choose = (text: string) => { if (!disabled && !busy) { setUndo(value); onChange(text); } };
  const save = async () => {
    if (disabled || busy || !value.trim()) return;
    setBusy(true);
    try {
      const name = await askName({ title: "保存为常用用法", placeholder: "如：改写人物命运" });
      if (!name) return;
      const next = [...await load(), { id: crypto.randomUUID(), name, text: value }];
      await game.repo.setSetting(key, next); setPresets(next); toast("已保存，别的故事也能选用");
    } catch { toast("没能保存，请稍后再试"); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (disabled || busy) return;
    setBusy(true);
    try { const next = (await load()).filter((item) => item.id !== id); await game.repo.setSetting(key, next); setPresets(next); }
    catch { toast("没能删除，请稍后再试"); }
    finally { setBusy(false); }
  };
  return <details className="writing-presets"><summary>选择已保存用法与内置用法</summary><div className="writing-library">
    <details>
      <summary>内置原著用法 · {BUILTIN_SOURCE_USAGES.length}</summary>
      <div className="stack gap-0">
        <p className="muted">只填入“原著怎么用”，可继续修改或撤回。不会更换书籍、章节范围或剧情关系，也不会自动通读。</p>
        {BUILTIN_SOURCE_USAGES.map((preset) => <div className="writing-preset" key={preset.id}>
          <div className="writing-preset-text"><b>{preset.name}</b><p>{preset.text}</p><details><summary className="muted">查看完整用法</summary><div className="codex-text">{preset.text}</div></details></div>
          <button disabled={disabled || busy} aria-label={`选用内置用法“${preset.name}”`} onClick={() => choose(preset.text)}>选用</button>
        </div>)}
      </div>
    </details>
    {!presets.length && <p className="muted">把原著怎么用存下来，别的故事也能选用。</p>}
    {presets.map((preset) => <div className="writing-preset" key={preset.id}><div className="writing-preset-text"><b>{preset.name}</b><p>{preset.text}</p></div>
      <button disabled={disabled || busy} aria-label={`选用用法“${preset.name}”`} onClick={() => choose(preset.text)}>选用</button>
      <button disabled={disabled || busy} className="ghost writing-remove" aria-label={`删除“${preset.name}”`} onClick={() => void remove(preset.id)}><Icon name="close" size={18} /></button>
    </div>)}
    {undo !== null && <div className="writing-applied"><span className="muted">已填进下方，保存后生效。</span><button disabled={disabled || busy} className="ghost" onClick={() => { onChange(undo); setUndo(null); }}>撤回选用</button></div>}
    <button className="ghost writing-add" disabled={disabled || busy || !loaded || !value.trim()} onClick={() => void save()}><Icon name="plus" size={18} />保存为常用用法</button>
  </div></details>;
}

export function BookPreview({ book, through }: { book: SourceBook; through?: number | null }) {
  const [section, setSection] = useState(0), [query, setQuery] = useState("");
  const allowed = book.sections.map((s, i) => ({ ...s, i })).filter((s) => through == null || s.i <= through);
  const matches = query.trim() ? allowed.filter((s) => s.title.includes(query.trim()) || s.text.includes(query.trim())) : [];
  const current = allowed.find((s) => s.i === section) ?? allowed[0];
  return <div className="stack">
    <label className="field">目录<select aria-label="书籍目录" value={current?.i ?? 0} onChange={(e) => setSection(Number(e.target.value))}>{allowed.map((s) => <option key={s.i} value={s.i}>{s.i + 1}. {s.title}</option>)}</select></label>
    <input aria-label="搜索书籍" placeholder="搜索正文或章节" value={query} onChange={(e) => setQuery(e.target.value)} />
    {query.trim() && <div className="stack"><span className="muted">找到 {matches.length} 节</span>{matches.slice(0, 30).map((s) => <button key={s.i} className="ghost" onClick={() => { setSection(s.i); setQuery(""); }}>{s.title} · {s.text.slice(Math.max(0, s.text.indexOf(query) - 18), Math.max(0, s.text.indexOf(query) - 18) + 80)}</button>)}</div>}
    {current && <details open><summary>{current.title}{current.page ? ` · 第 ${current.page} 页` : ""}</summary><StoryText text={current.text.slice(0, 8000)} />{current.text.length > 8000 && <p className="muted">这里预览前 8000 字，检索使用完整正文。</p>}</details>}
  </div>;
}

export function SourceLibrary({ onClose, onSelect }: { onClose: () => void; onSelect?: (book: SourceBook, use?: "reference" | "fanfic") => void }) {
  const { game, toast, ask, push } = useApp();
  const [books, setBooks] = useState<Awaited<ReturnType<typeof listBooks>>>([]);
  const [bookQuery, setBookQuery] = useState("");
  const shownBooks = books.filter((book) => localFind(bookQuery, book.title, book.format));
  const [preview, setPreview] = useState<SourceBook | null>(null), [imported, setImported] = useState(false), [notes, setNotes] = useState(false);
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [encoding, setEncoding] = useState<TextEncoding>("auto"), [progress, setProgress] = useState("");
  const [error, setError] = useState(""), [usage, setUsage] = useState<"library" | "reference" | "fanfic">(onSelect ? "reference" : "library");
  const controller = useRef<AbortController | null>(null);
  const load = () => void listBooks(game.repo).then(setBooks);
  useEffect(() => { load(); return () => controller.current?.abort(); }, [game]);
  const parse = async (chosen: NonNullable<typeof file>, code: TextEncoding) => {
    controller.current?.abort(); const run = new AbortController(); controller.current = run;
    setError(""); setProgress("正在读取书籍…");
    try {
      const book = await parseBook(chosen, game.platform, { signal: run.signal, encoding: code, progress: (s) => { if (!run.signal.aborted) setProgress(s); } });
      if (!run.signal.aborted) { setPreview(book); setImported(true); }
    } catch (e) { if (!run.signal.aborted) setError(e instanceof Error ? e.message : "书籍没能打开"); }
    finally { if (controller.current === run) { controller.current = null; setProgress(""); } }
  };
  const choose = async () => {
    const run = new AbortController(); controller.current = run; setProgress("请选择书籍…"); setError("");
    try {
      const chosen = await game.platform.files.importBook(run.signal, (bytes) => { if (!run.signal.aborted) setProgress(`正在读取书籍…${(bytes / 1024 / 1024).toFixed(1)} MiB`); });
      if (!run.signal.aborted && chosen) { setPreview(null); setImported(false); setFile(chosen); setEncoding("auto"); await parse(chosen, "auto"); }
    } catch (e) { if (!run.signal.aborted) setError(e instanceof Error ? e.message : "书籍没能打开"); }
    finally { if (controller.current === run) { controller.current = null; setProgress(""); } }
  };
  const cancel = () => { controller.current?.abort(); controller.current = null; setProgress(""); };
  const save = async () => {
    if (!preview || !preview.title.trim()) return;
    setProgress("正在保存书籍…");
    try {
      await saveBook(game.repo, preview); setImported(false); setFile(null); load(); toast("书籍已保存");
      if (onSelect && usage !== "library") { onSelect(preview, usage); onClose(); }
      else if (usage !== "library") {
        await game.repo.setSetting("source:pending", newBinding(preview.id, usage === "fanfic"));
        setPreview(null);
        if (usage === "fanfic") { onClose(); push({ name: "newgame" }); }
        else toast("打开已有世界的本局设置，即可采用这本书");
      }
    } catch { setError("没能保存，请稍后再试"); } finally { setProgress(""); }
  };
  return <Sheet title="参考书籍" onClose={() => { cancel(); onClose(); }}><div className="stack">
    <p className="muted m-0">TXT、EPUB、文字 PDF、DOCX，单个不超过 64 MiB。书籍保存在本机；生成和 AI 整理时，相关内容会发送给你选择的服务。</p>
    {error && <div className="notice">{error}</div>}
    {progress ? <div className="row"><span className="muted grow" role="status">{progress}</span>{progress !== "正在保存书籍…" && <button onClick={cancel}>取消</button>}</div> : <button onClick={() => void choose()}>导入书籍</button>}
    {!preview && books.length > 0 && <input type="search" aria-label="查找参考书籍" placeholder="按书名或格式查找" value={bookQuery} onChange={(event) => setBookQuery(event.target.value)} />}
    {preview ? <>
      {imported ? <label className="field">书名<input aria-label="书名" value={preview.title} onChange={(e) => setPreview({ ...preview, title: e.target.value })} /></label> : <h3>{preview.title}</h3>}
      {file && preview.format === "txt" && <label className="field">文本编码<select aria-label="文本编码" disabled={!!progress} value={encoding} onChange={(e) => { const value = e.target.value as TextEncoding; setEncoding(value); void parse(file, value); }}>
        <option value="auto">自动识别</option><option value="utf-8">UTF-8</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gb18030">GBK / GB18030</option>
      </select></label>}
      <BookPreview key={preview.id} book={preview} />
      {imported && <><span className="muted">使用方式</span><div className="segmented">{([["library", "只存入书库"], ["reference", "用作参考"], ["fanfic", "同人开局"]] as const).map(([v, label]) => <button key={v} aria-pressed={usage === v} onClick={() => setUsage(v)}>{label}</button>)}</div><button className="primary" disabled={!!progress || !!error || !preview.title.trim()} onClick={() => void save()}>保存书籍</button></>}
      {!imported && onSelect && <button className="primary" onClick={() => { onSelect(preview); onClose(); }}>使用这本书</button>}
      {!imported && <button onClick={() => setNotes(true)}>原著札记</button>}
      {notes && <CanonNotesSheet bookId={preview.id} worldId={null} onClose={() => setNotes(false)} />}
      <button className="ghost" disabled={!!progress} onClick={() => { setPreview(null); setFile(null); setImported(false); }}>返回书库</button>
    </> : shownBooks.map((book) => <div className="row" key={book.id}><button className="grow" onClick={() => void getBook(game.repo, book.id).then((b) => { setPreview(b); setImported(false); })}>{book.title} · {book.format.toUpperCase()}</button><button className="ghost danger" onClick={async () => {
      if (!await ask({ title: `删除“${book.title}”？`, message: "未被当前或历史路线引用的书籍才能删除。", confirm: "删除", danger: true })) return;
      try { await deleteBook(game.repo, book.id); load(); } catch (e) { toast(e instanceof Error ? e.message : "没能删除"); }
    }}>删除</button></div>)}
    {!preview && !!books.length && !shownBooks.length && <p className="muted">没有找到相符的书籍，可以换个词或清除查找。</p>}
    {!preview && !books.length && !progress && <p className="muted">书库还是空的。导入一次，可以给多个故事使用。</p>}
  </div></Sheet>;
}

export function SourceSetup({ value, onChange, disabled = false, fanfic = false }: { value: SourceBinding | null | undefined; onChange: (b: SourceBinding | null) => void; disabled?: boolean; fanfic?: boolean }) {
  const { game, toast } = useApp();
  const [library, setLibrary] = useState(false), [book, setBook] = useState<SourceBook | null>(null), [analysis, setAnalysis] = useState(false), [browse, setBrowse] = useState(false), [notes, setNotes] = useState(false);
  const [picking, setPicking] = useState<"position" | "through" | null>(null);
  useEffect(() => { let live = true; setBook(null); if (value) void getBook(game.repo, value.bookId).then((b) => { if (live) setBook(b); }); return () => { live = false; }; }, [game, value?.bookId]);
  useEffect(() => { if (!value) void game.repo.getSetting<SourceBinding | null>("source:pending", null).then(async (pending) => { if (pending) { onChange(pending); await game.repo.setSetting("source:pending", null); } }); }, []);
  const set = (patch: Partial<SourceBinding>) => { if (value) onChange({ ...value, ...patch }); };
  const sectionText = (sec: number) => {
    const raw = book?.sections[sec]?.title;
    const label = chapterLabel(sec, raw);
    return raw ? `${label}（第 ${sec + 1} 节）` : label;
  };
  return <div className="stack">
    <div className="row"><button disabled={disabled} onClick={() => setLibrary(true)}>{book ? `参考书籍：${book.title}` : "选择或导入参考书籍"}</button>{value && <button className="ghost" disabled={disabled} onClick={() => onChange(null)}>解除绑定</button>}</div>
    {value && <p className="field-hint m-0">这里是当前表单中的选择，随开局或本局设置一起保存。</p>}
    {value && !book && <p className="muted">正在读取书籍，若已删除请重新选择。</p>}
    {value && book && <>
      <button type="button" className="settings-entry scope-row" aria-label="原著位置" disabled={disabled} onClick={() => setPicking("position")}>
        <span><b>原著位置</b><small>{sectionText(value.position)}</small></span>
        <span aria-hidden="true">第 {value.position + 1} 节 ›</span>
      </button>
      {value.fanfic && value.plot === "canon" && <p className="field-hint m-0">沿原剧情时，每段写完会按内容自动往后跟（一次至多 2 节，不花请求）；跟错了在这一段的变化里点“改回”，或在这里改。</p>}
      <span className="muted">剧情关系</span><div className="segmented">{([["reference", "只作资料"], ["rewrite", "允许改写原著"], ["canon", "尽量沿原剧情"]] as const).map(([v, label]) => <button disabled={disabled} key={v} aria-pressed={v === "reference" ? !value.fanfic : value.fanfic && value.plot === v} onClick={() => set({ fanfic: v !== "reference", ...(v === "reference" ? {} : { plot: v }) })}>{label}</button>)}</div>
      <span className="muted">参考范围</span><div className="segmented"><button disabled={disabled} aria-pressed={value.through === null} onClick={() => set({ through: null })}>全书</button><button disabled={disabled} aria-pressed={value.through !== null} onClick={() => {
        const nextThrough = value.through ?? (value.position > 0 ? value.position : Math.max(0, book.sections.length - 1));
        set({ through: nextThrough, analysisId: undefined });
        setPicking("through");
      }}>截至指定章节</button></div>
      {value.through !== null && (
        <button type="button" className="settings-entry scope-row" aria-label="截至章节" disabled={disabled} onClick={() => setPicking("through")}>
          <span><b>截至章节</b><small>{sectionText(value.through)}</small></span>
          <span aria-hidden="true">第 {value.through + 1} 节 ›</span>
        </button>
      )}
      {picking === "position" && <ChapterPickSheet title="选择原著位置" book={book} maxSection={value.through ?? undefined} value={value.position} onSelect={(section) => set({ position: section })} onClose={() => setPicking(null)} />}
      {picking === "through" && <ChapterPickSheet title="选择截至章节" book={book} value={value.through ?? Math.max(0, book.sections.length - 1)} onSelect={(section) => set({ through: section, position: Math.min(value.position, section), analysisId: undefined })} onClose={() => setPicking(null)} />}
      <SourcePresets key={value.bookId} disabled={disabled} value={value.instructions} onChange={(instructions) => { if (!disabled) set({ instructions }); }} />
      <label className="field">原著怎么用<textarea rows={4} maxLength={12000} disabled={disabled} aria-label="原著怎么用" value={value.instructions} onChange={(e) => set({ instructions: e.target.value })} /></label>
      <span className="muted">理解方式</span><div className="segmented"><button disabled={disabled} aria-pressed={value.method === "search"} onClick={() => set({ method: "search" })}>直接检索引用</button><button disabled={disabled} aria-pressed={value.method === "analysis"} onClick={() => set({ method: "analysis" })}>先让 AI 通读整理</button></div>
      <p className="muted m-0">直接检索无需预先调用 AI。未整理也可以先直接使用，以后再整理。修改用法不会自动重新整理，也不会自动产生费用。</p>
      <div className="row wrap"><button onClick={() => setBrowse(true)}>目录与正文</button><button onClick={() => setNotes(true)}>原著札记</button>{value.method === "analysis" && <button disabled={disabled} onClick={() => setAnalysis(true)}>通读整理</button>}</div>
      <p className="muted m-0">原著札记：让 AI 先整理一段主线、一个人物或一个设定，写作时带上，比每段都翻原文更快更省。</p>
      {notes && <CanonNotesSheet bookId={value.bookId} worldId={null} position={value.position} through={value.through} onClose={() => setNotes(false)} />}
    </>}
    {library && <SourceLibrary onClose={() => setLibrary(false)} onSelect={(b, use) => { onChange(newBinding(b.id, use === "fanfic" || fanfic || value?.fanfic)); toast("已选入，保存设置后生效"); }} />}
    {browse && book && <Sheet title={book.title} onClose={() => setBrowse(false)}><BookPreview book={book} through={value?.through} /></Sheet>}
    {analysis && book && value && <SourceAnalysis book={book} binding={value} onChange={onChange} onClose={() => setAnalysis(false)} />}
  </div>;
}

function SourceAnalysis({ book, binding, onChange, onClose }: { book: SourceBook; binding: SourceBinding; onChange: (b: SourceBinding) => void; onClose: () => void }) {
  const { game, ask, toast } = useApp();
  const [jobs, setJobs] = useState<AnalysisJob[]>([]), [running, setRunning] = useState(false), [job, setJob] = useState<AnalysisJob | null>(null), [estimate, setEstimate] = useState("金额未知（未配置单价）");
  const current = useRef<AnalysisJob | null>(null);
  const alive = useRef(true);
  const parts = chunksOf(book).filter((c) => binding.through === null || c.section <= binding.through);
  useEffect(() => { alive.current = true; void analysisJobs(game.repo, book.id).then((list) => { if (!alive.current) return; setJobs(list); const active = list.find((j) => j.id === binding.analysisId); if (active) { setJob({ ...active, status: active.status === "running" ? "paused" : active.status }); current.current = active; } });
    void readBudget(game.repo).then((prices) => { if (prices.input !== null && prices.output !== null) setEstimate(`约 ¥${((parts.reduce((n, c) => n + c.text.length + binding.instructions.length + 300, 0) * prices.input + parts.length * 1500 * prices.output) / 1_000_000).toFixed(3)}（按已填单价估算）`); });
    return () => { alive.current = false; if (current.current) game.pauseSourceAnalysis(current.current.id); };
  }, []);
  const start = async (fresh = false) => {
    if (!game.llm) { toast("请先连接 AI 服务"); return; }
    if (!await ask({ title: job && !fresh ? "继续通读整理？" : "开始通读整理？", message: `预计最多 ${job && !fresh ? Math.max(0, job.total - job.completed) : parts.length} 次调用；${estimate}。按现有辅助模型整理，已成功的片段不重复处理。`, confirm: "开始" })) return;
    setRunning(true);
    try {
      const result = await game.analyzeSource({ ...binding, analysisId: fresh ? undefined : job?.id }, (next) => { if (alive.current) { if (current.current?.id !== next.id) onChange({ ...binding, analysisId: next.id }); current.current = next; setJob(next); } });
      if (alive.current) { onChange({ ...binding, analysisId: result.id }); setJobs(await analysisJobs(game.repo, book.id)); }
    } catch (e) { toast(e instanceof Error ? e.message : "没能开始整理"); } finally { setRunning(false); }
  };
  return <Sheet title="通读整理" onClose={onClose}><div className="stack"><p className="muted">按章节分段整理人物、世界规则和剧情顺序，并保留出处。只整理选定范围；可以暂停，稍后继续。</p><p>预计 {parts.length} 次调用 · {estimate}</p>
    {job && <div className="notice">已整理 {job.completed}/{job.total} 段 · {running ? "正在整理" : job.status === "done" ? "已完成" : job.status === "failed" ? "可以重试" : "已暂停"}{job.error && <p>{job.error}</p>}</div>}
    {running ? <button onClick={() => { if (current.current) game.pauseSourceAnalysis(current.current.id); }}>暂停</button> : <div className="row"><button className="primary" disabled={job?.status === "done"} onClick={() => void start()}>{job ? "继续整理 / 重试" : "开始整理"}</button>{job && <button onClick={() => void start(true)}>按当前用法重新整理</button>}</div>}
    {jobs.map((j) => <button key={j.id} disabled={running} aria-pressed={binding.analysisId === j.id} onClick={() => { onChange({ ...binding, analysisId: j.id }); setJob(j); current.current = j; }}>{j.model} · 已整理 {j.completed}/{j.total} 段</button>)}
    <p className="muted">采用整理后，下一次生成会同时检索相关原文。若用法或范围变化，可以直接使用，也可以主动新建整理。</p>
  </div></Sheet>;
}

export function ReferenceSheet({ worldId, binding, onClose }: { worldId: string; binding: SourceBinding; onClose: () => void }) {
  const { game } = useApp();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof referenceContext>>>();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { let live = true; void game.repo.getWorld(worldId).then(async (world) => {
    if (!world?.currentLineId) return;
    const line = (await game.repo.lines(worldId)).find((l) => l.id === world.currentLineId);
    const path = line ? await game.repo.path(line.nodeId) : [];
    const used = [...path].reverse().find((n) => n.meta.reference)?.meta.reference as typeof preview;
    if (live) { setPreview(used); setLoaded(true); }
  }); return () => { live = false; }; }, [game, worldId, binding.bookId]);
  return <Sheet title="最近一次生成引用" onClose={onClose}><div className="stack"><p className="muted">这条路线最近一次生成实际引用的资料；章节范围以当次请求为准。下一次会结合当前行动重新检索。</p>{preview?.passages.map((p, i) => <details key={i}><summary>{p.title}{p.page ? ` · 第 ${p.page} 页` : ""} · {p.kind === "analysis" ? "AI 整理" : "原文"}</summary><StoryText text={p.text} /></details>)}{!preview && <p className="muted">{loaded ? "这条路线还没有引用书籍生成正文。" : "正在读取…"}</p>}</div></Sheet>;
}
