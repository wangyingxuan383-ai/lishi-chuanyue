import { useEffect, useRef, useState } from "react";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import { StoryText } from "./StoryText";
import { Icon } from "./Icon";
import { readBudget } from "./budgetMath";
import { parseBook, type TextEncoding } from "../../engine/sources/parse";
import { analysisJobs, chunksOf, deleteBook, getBook, listBooks, referenceContext, saveBook } from "../../engine/sources/library";
import { newBinding, type AnalysisJob, type SourceBinding, type SourceBook } from "../../engine/sources/types";
import "./writing.css";

/** Uses the same library rows and copy-into-form behavior as 我的要求组. */
function SourcePresets({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const { game, askName, toast } = useApp();
  const [presets, setPresets] = useState<{ id: string; name: string; text: string }[]>([]);
  const key = "source:presets:1";
  useEffect(() => { void game.repo.getSetting<typeof presets>(key, []).then(setPresets); }, [game]);
  const save = async () => {
    const name = await askName({ title: "保存为常用用法", placeholder: "如：改写人物命运" });
    if (!name) return;
    const current = await game.repo.getSetting<typeof presets>(key, []);
    const next = [...current, { id: crypto.randomUUID(), name, text: value }];
    await game.repo.setSetting(key, next); setPresets(next); toast("已保存，别的故事也能选用");
  };
  return <details className="writing-presets"><summary>选择已保存用法</summary><div className="writing-library">
    {!presets.length && <p className="muted">把原著怎么用存下来，别的故事也能选用。</p>}
    {presets.map((p) => <div className="writing-preset" key={p.id}><div className="writing-preset-text"><b>{p.name}</b><p>{p.text}</p></div>
      <button onClick={() => onChange(p.text)}>选用</button><button className="ghost writing-remove" aria-label={`删除“${p.name}”`} onClick={() => {
        void game.repo.getSetting<typeof presets>(key, []).then(async (current) => { const next = current.filter((x) => x.id !== p.id); await game.repo.setSetting(key, next); setPresets(next); });
      }}><Icon name="close" size={18} /></button></div>)}
    <button className="ghost writing-add" disabled={!value.trim()} onClick={() => void save().catch(() => toast("没能保存，请稍后再试"))}><Icon name="plus" size={18} />保存为常用用法</button>
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
  const [preview, setPreview] = useState<SourceBook | null>(null), [imported, setImported] = useState(false);
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
    <p className="muted" style={{ margin: 0 }}>TXT、EPUB、文字 PDF、DOCX，单个不超过 64 MiB。书籍保存在本机；生成和 AI 整理时，相关内容会发送给你选择的服务。</p>
    {error && <div className="notice">{error}</div>}
    {progress ? <div className="row"><span className="muted grow" role="status">{progress}</span>{progress !== "正在保存书籍…" && <button onClick={cancel}>取消</button>}</div> : <button onClick={() => void choose()}>导入书籍</button>}
    {preview ? <>
      {imported ? <label className="field">书名<input aria-label="书名" value={preview.title} onChange={(e) => setPreview({ ...preview, title: e.target.value })} /></label> : <h3>{preview.title}</h3>}
      {file && preview.format === "txt" && <label className="field">文本编码<select aria-label="文本编码" disabled={!!progress} value={encoding} onChange={(e) => { const value = e.target.value as TextEncoding; setEncoding(value); void parse(file, value); }}>
        <option value="auto">自动识别</option><option value="utf-8">UTF-8</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gb18030">GBK / GB18030</option>
      </select></label>}
      <BookPreview key={preview.id} book={preview} />
      {imported && <><span className="muted">使用方式</span><div className="segmented">{([["library", "只存入书库"], ["reference", "用作参考"], ["fanfic", "同人开局"]] as const).map(([v, label]) => <button key={v} aria-pressed={usage === v} onClick={() => setUsage(v)}>{label}</button>)}</div><button className="primary" disabled={!!progress || !!error || !preview.title.trim()} onClick={() => void save()}>保存书籍</button></>}
      {!imported && onSelect && <button className="primary" onClick={() => { onSelect(preview); onClose(); }}>使用这本书</button>}
      <button className="ghost" disabled={!!progress} onClick={() => { setPreview(null); setFile(null); setImported(false); }}>返回书库</button>
    </> : books.map((book) => <div className="row" key={book.id}><button className="grow" onClick={() => void getBook(game.repo, book.id).then((b) => { setPreview(b); setImported(false); })}>{book.title} · {book.format.toUpperCase()}</button><button className="ghost danger" onClick={async () => {
      if (!await ask({ title: `删除“${book.title}”？`, message: "未被当前或历史路线引用的书籍才能删除。", confirm: "删除", danger: true })) return;
      try { await deleteBook(game.repo, book.id); load(); } catch (e) { toast(e instanceof Error ? e.message : "没能删除"); }
    }}>删除</button></div>)}
    {!preview && !books.length && !progress && <p className="muted">书库还是空的。导入一次，可以给多个故事使用。</p>}
  </div></Sheet>;
}

export function SourceSetup({ value, onChange, disabled = false, fanfic = false }: { value: SourceBinding | null | undefined; onChange: (b: SourceBinding | null) => void; disabled?: boolean; fanfic?: boolean }) {
  const { game, toast } = useApp();
  const [library, setLibrary] = useState(false), [book, setBook] = useState<SourceBook | null>(null), [analysis, setAnalysis] = useState(false), [browse, setBrowse] = useState(false);
  useEffect(() => { let live = true; setBook(null); if (value) void getBook(game.repo, value.bookId).then((b) => { if (live) setBook(b); }); return () => { live = false; }; }, [game, value?.bookId]);
  useEffect(() => { if (!value) void game.repo.getSetting<SourceBinding | null>("source:pending", null).then(async (pending) => { if (pending) { onChange(pending); await game.repo.setSetting("source:pending", null); } }); }, []);
  const set = (patch: Partial<SourceBinding>) => { if (value) onChange({ ...value, ...patch }); };
  return <div className="stack">
    <div className="row"><button disabled={disabled} onClick={() => setLibrary(true)}>{book ? `参考书籍：${book.title}` : "选择或导入参考书籍"}</button>{value && <button className="ghost" disabled={disabled} onClick={() => onChange(null)}>解除绑定</button>}</div>
    {value && !book && <p className="muted">正在读取书籍，若已删除请重新选择。</p>}
    {value && book && <>
      <label className="field">原著位置<select aria-label="原著位置" disabled={disabled} value={value.position} onChange={(e) => set({ position: Number(e.target.value) })}>{book.sections.map((s, i) => value.through !== null && i > value.through ? null : <option value={i} key={i}>{i + 1}. {s.title}</option>)}</select></label>
      <span className="muted">剧情关系</span><div className="segmented">{([["reference", "只作资料"], ["rewrite", "允许改写原著"], ["canon", "尽量沿原剧情"]] as const).map(([v, label]) => <button disabled={disabled} key={v} aria-pressed={v === "reference" ? !value.fanfic : value.fanfic && value.plot === v} onClick={() => set({ fanfic: v !== "reference", ...(v === "reference" ? {} : { plot: v }) })}>{label}</button>)}</div>
      <span className="muted">参考范围</span><div className="segmented"><button disabled={disabled} aria-pressed={value.through === null} onClick={() => set({ through: null })}>全书</button><button disabled={disabled} aria-pressed={value.through !== null} onClick={() => set({ through: value.position, analysisId: undefined })}>截至指定章节</button></div>
      {value.through !== null && <label className="field">截至章节<select aria-label="截至章节" disabled={disabled} value={value.through} onChange={(e) => set({ through: Number(e.target.value), position: Math.min(value.position, Number(e.target.value)), analysisId: undefined })}>{book.sections.map((s, i) => <option key={i} value={i}>{i + 1}. {s.title}</option>)}</select></label>}
      <SourcePresets value={value.instructions} onChange={(instructions) => { if (!disabled) set({ instructions }); }} />
      <label className="field">原著怎么用<textarea rows={4} maxLength={12000} disabled={disabled} aria-label="原著怎么用" value={value.instructions} onChange={(e) => set({ instructions: e.target.value })} /></label>
      <span className="muted">理解方式</span><div className="segmented"><button disabled={disabled} aria-pressed={value.method === "search"} onClick={() => set({ method: "search" })}>直接检索引用</button><button disabled={disabled} aria-pressed={value.method === "analysis"} onClick={() => set({ method: "analysis" })}>先让 AI 通读整理</button></div>
      <p className="muted" style={{ margin: 0 }}>直接检索无需预先调用 AI。未整理也可以先直接使用，以后再整理。修改用法不会自动重新整理，也不会自动产生费用。</p>
      <div className="row"><button onClick={() => setBrowse(true)}>目录与正文</button>{value.method === "analysis" && <button disabled={disabled} onClick={() => setAnalysis(true)}>通读整理</button>}</div>
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
