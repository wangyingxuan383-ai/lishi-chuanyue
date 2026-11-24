import { useMemo, useRef, useState } from "react";
import {
  saveWorldNovelToLibrary,
  updateBookShelfPref,
  type LibraryShelfItem,
  type ReadingStatsSummary,
} from "../../../engine/reader/shelf";
import { deleteBook, saveBook } from "../../../engine/sources/library";
import { parseBook, type TextEncoding } from "../../../engine/sources/parse";
import type { SourceBook } from "../../../engine/sources/types";
import { useApp } from "../../app/context";
import { localFind } from "../../app/localFind";
import { openWithFlourish } from "../../app/motion";
import { BookCover, COVER_TONE_NAMES } from "../../components/BookArt";
import { EmptyVignette } from "../../components/ChineseArt";
import { Icon } from "../../components/Icon";
import { Sheet } from "../../components/Sheet";
import { useLongPress } from "../../components/useLongPress";
import type { WorldCard } from "./types";
import "./home-library.css";

export type ShelfSort = "recent" | "added" | "title" | "progress";

export interface HomeLibraryProps {
  items: LibraryShelfItem[] | null;
  stats: ReadingStatsSummary | null;
  totalHighlights: number;
  worlds: WorldCard[] | null;
  onReload: () => Promise<void> | void;
  onOpenExcerpts: (bookId: string | null) => void;
}

const formatWords = (chars: number): string =>
  chars >= 10000
    ? `${(chars / 10000).toFixed(1).replace(/\.0$/, "")} 万字`
    : `${Math.max(0, chars).toLocaleString()} 字`;

const ENCODING_OPTIONS: { value: TextEncoding; label: string }[] = [
  { value: "auto", label: "自动识别（推荐）" },
  { value: "utf-8", label: "UTF-8" },
  { value: "gb18030", label: "GBK / GB18030（常见中文 TXT）" },
  { value: "utf-16le", label: "UTF-16 LE" },
  { value: "utf-16be", label: "UTF-16 BE" },
];

interface PendingTxtImport {
  file: { name: string; bytes: Uint8Array };
  encoding: TextEncoding;
  book: SourceBook | null;
  error: string;
  replaceBookId?: string;
}

function LibraryBookCard({
  item,
  index,
  onOpen,
  onManage,
}: {
  item: LibraryShelfItem;
  index: number;
  onOpen: (item: LibraryShelfItem, from: HTMLElement | null) => void;
  onManage: (item: LibraryShelfItem) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const press = useLongPress(
    () => onManage(item),
    () => onOpen(item, cardRef.current?.querySelector<HTMLElement>(".book-art") ?? cardRef.current),
  );
  const statusLabel = item.finished
    ? "已读完"
    : item.progress
      ? `${item.progressPct}%`
      : "未读";

  return (
    <div
      ref={cardRef}
      className={`lib-book-card${item.pinned ? " is-pinned" : ""}${item.finished ? " is-finished" : ""}`}
      data-book-id={item.id}
      style={{ ["--i" as string]: index }}
    >
      <button
        type="button"
        className="lib-card-open"
        {...press}
        aria-label={`阅读《${item.title}》（${statusLabel}）`}
      >
        <span className="lib-cover-stage">
          <BookCover seed={item.id} title={item.title} tone={item.coverTone} />
        </span>
        <span className="lib-card-body">
          <span className="lib-card-tags">
            {item.pinned && (
              <span className="lib-card-pin">
                <Icon name="pushpin-fill" size={10} />
                置顶
              </span>
            )}
            <span className="lib-card-fmt">{item.format.toUpperCase()}</span>
          </span>
          <b className="lib-card-title">{item.title}</b>
          {item.author ? (
            <small className="lib-card-author">{item.author}</small>
          ) : (
            <small className="lib-card-author muted-faint">共 {item.sectionCount} 节</small>
          )}
          <span className="lib-card-prog">
            <i className="lib-card-prog-track" aria-hidden="true">
              <b style={{ width: `${item.progressPct}%` }} />
            </i>
            <em className="lib-card-prog-pct">{statusLabel}</em>
          </span>
        </span>
      </button>
      <button
        type="button"
        className="icon-btn lib-card-more"
        aria-label={`《${item.title}》的更多操作`}
        onClick={() => onManage(item)}
      >
        <Icon name="more" size={16} />
      </button>
    </div>
  );
}

export function HomeLibrary({
  items,
  stats,
  totalHighlights,
  worlds,
  onReload,
  onOpenExcerpts,
}: HomeLibraryProps) {
  const { game, push, toast, ask, askName } = useApp();
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<ShelfSort>("recent");
  const [manageId, setManageId] = useState<string | null>(null);
  const [compileOpen, setCompileOpen] = useState(false);
  const [compilingId, setCompilingId] = useState<string | null>(null);

  const [importProgress, setImportProgress] = useState("");
  const [pendingTxt, setPendingTxt] = useState<PendingTxtImport | null>(null);
  const [lastTxtSession, setLastTxtSession] = useState<{
    bookId: string;
    title: string;
    file: { name: string; bytes: Uint8Array };
  } | null>(null);
  const importAbort = useRef<AbortController | null>(null);

  const manageItem = useMemo(
    () => items?.find((x) => x.id === manageId) ?? null,
    [items, manageId],
  );

  const totalCollectionChars = useMemo(
    () => (items ?? []).reduce((sum, b) => sum + b.totalChars, 0),
    [items],
  );

  const featured = useMemo(() => {
    if (!items || items.length === 0) return null;
    return items.find((x) => x.progress) ?? items[0] ?? null;
  }, [items]);

  const sortedItems = useMemo(() => {
    if (!items) return [];
    const filtered = items.filter((item) =>
      localFind(query, item.title, item.author, item.currentSectionTitle, item.format),
    );
    const copy = [...filtered];
    copy.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sortBy === "added") return b.createdAt.localeCompare(a.createdAt);
      if (sortBy === "title") return a.title.localeCompare(b.title, "zh-CN");
      if (sortBy === "progress") {
        return b.progressPct - a.progressPct || b.lastActiveAt.localeCompare(a.lastActiveAt);
      }
      return b.lastActiveAt.localeCompare(a.lastActiveAt);
    });
    return copy;
  }, [items, query, sortBy]);

  const openBook = (item: LibraryShelfItem, from: HTMLElement | null) => {
    const host = from?.closest<HTMLElement>(".lib-hero, .lib-book-card") ?? from;
    openWithFlourish(
      host,
      host?.querySelector<HTMLElement>(".book-art") ?? from,
      () => push({ name: "reader", bookId: item.id }),
      340,
    );
  };

  const cancelImport = () => {
    importAbort.current?.abort();
    importAbort.current = null;
    setImportProgress("");
  };

  const startImport = async () => {
    if (importProgress) return;
    const run = new AbortController();
    importAbort.current = run;
    setImportProgress("正在打开文件选择器…");
    try {
      const chosen = await game.platform.files.importBook(run.signal, (bytes) => {
        if (!run.signal.aborted) {
          setImportProgress(`正在读取文件… ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
        }
      });
      if (run.signal.aborted || !chosen) return;
      setImportProgress("正在解析章节与目录…");
      try {
        const parsed = await parseBook(chosen, game.platform, {
          signal: run.signal,
          encoding: "auto",
          progress: (msg) => {
            if (!run.signal.aborted) setImportProgress(msg);
          },
        });
        if (run.signal.aborted) return;
        const sample = parsed.sections
          .slice(0, 2)
          .map((s) => s.text.slice(0, 600))
          .join("");
        if (parsed.format === "txt" && sample.includes("\uFFFD")) {
          setPendingTxt({ file: chosen, encoding: "auto", book: parsed, error: "" });
          return;
        }
        setImportProgress("正在存入书斋…");
        await saveBook(game.repo, parsed, run.signal);
        await onReload();
        if (parsed.format === "txt") {
          setLastTxtSession({ bookId: parsed.id, title: parsed.title, file: chosen });
        } else {
          setLastTxtSession(null);
        }
        toast(`已入藏《${parsed.title}》（共 ${parsed.sections.length} 节）`, {
          label: "立即展读",
          run: () => push({ name: "reader", bookId: parsed.id }),
        });
      } catch (err) {
        if (run.signal.aborted) return;
        const isLikelyTxt = !/\.(?:epub|pdf|docx)$/i.test(chosen.name);
        if (isLikelyTxt) {
          setPendingTxt({
            file: chosen,
            encoding: "gb18030",
            book: null,
            error: err instanceof Error ? err.message : "自动编码未能识别，请手动切换编码",
          });
          void reparsePendingTxt(chosen, "gb18030");
          return;
        }
        toast(err instanceof Error ? err.message : "书籍未能打开，请检查文件格式");
      }
    } catch (err) {
      if (!run.signal.aborted) {
        toast(err instanceof Error ? err.message : "文件读取失败");
      }
    } finally {
      if (importAbort.current === run) {
        importAbort.current = null;
        setImportProgress("");
      }
    }
  };

  const reparsePendingTxt = async (
    file: { name: string; bytes: Uint8Array },
    encoding: TextEncoding,
    replaceBookId?: string,
  ) => {
    const run = new AbortController();
    importAbort.current?.abort();
    importAbort.current = run;
    setImportProgress("正在按所选编码解析…");
    try {
      const book = await parseBook(file, game.platform, {
        signal: run.signal,
        encoding,
        progress: (msg) => {
          if (!run.signal.aborted) setImportProgress(msg);
        },
      });
      if (!run.signal.aborted) {
        setPendingTxt({ file, encoding, book, error: "", replaceBookId });
      }
    } catch (err) {
      if (!run.signal.aborted) {
        setPendingTxt({
          file,
          encoding,
          book: null,
          error: err instanceof Error ? err.message : "该编码无法解析此文件",
          replaceBookId,
        });
      }
    } finally {
      if (importAbort.current === run) {
        importAbort.current = null;
        setImportProgress("");
      }
    }
  };

  const confirmSavePendingTxt = async (openAfter: boolean) => {
    if (!pendingTxt?.book || !pendingTxt.book.title.trim()) return;
    setImportProgress("正在存入书斋…");
    try {
      if (pendingTxt.replaceBookId) {
        await deleteBook(game.repo, pendingTxt.replaceBookId).catch(() => {});
      }
      const targetBook = pendingTxt.book;
      await saveBook(game.repo, targetBook);
      setPendingTxt(null);
      setLastTxtSession(null);
      await onReload();
      if (openAfter) {
        push({ name: "reader", bookId: targetBook.id });
      } else {
        toast(`已入藏《${targetBook.title}》`);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "保存失败，请稍后重试");
    } finally {
      setImportProgress("");
    }
  };

  const handleCompileWorld = async (card: WorldCard) => {
    if (compilingId) return;
    setCompilingId(card.world.id);
    try {
      const res = await saveWorldNovelToLibrary(game.repo, card.world.id);
      setCompileOpen(false);
      await onReload();
      toast(`已将《${res.title}》编纂入藏（共 ${res.sectionCount} 节）`, {
        label: "展读",
        run: () => push({ name: "reader", bookId: res.bookId }),
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : "故事尚无足够正文可编纂成书");
    } finally {
      setCompilingId(null);
    }
  };

  const togglePin = async (item: LibraryShelfItem) => {
    const nextPinned = !item.pinned;
    await updateBookShelfPref(game.repo, item.id, { pinned: nextPinned });
    await onReload();
    toast(nextPinned ? `已置顶《${item.title}》` : "已取消置顶");
  };

  const pickCoverTone = async (item: LibraryShelfItem, tone: number | null) => {
    await updateBookShelfPref(game.repo, item.id, { coverTone: tone });
    await onReload();
  };

  const editAuthor = async (item: LibraryShelfItem) => {
    const val = await askName({
      title: `填写《${item.title}》作者或备注`,
      initial: item.author,
      placeholder: "如：施耐庵 / 精校全本（留空清除）",
      confirm: "保存",
    });
    if (val === null) return;
    await updateBookShelfPref(game.repo, item.id, { author: val });
    await onReload();
    toast("已更新书籍信息");
  };

  const toggleFinished = async (item: LibraryShelfItem) => {
    const nextFinished = !item.finished;
    await updateBookShelfPref(game.repo, item.id, { finished: nextFinished });
    await onReload();
    toast(nextFinished ? `已将《${item.title}》标为读完` : `已将《${item.title}》标为在读`);
  };

  const removeBook = async (item: LibraryShelfItem) => {
    const confirmed = await ask({
      title: `从书斋移除《${item.title}》？`,
      message: "本地藏书将被移除；若该书正被某个穿越故事引用，会为你保留以确保故事不断档。",
      confirm: "从书斋移除",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await deleteBook(game.repo, item.id);
      setManageId(null);
      await onReload();
      toast(`已移除《${item.title}》`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "未能移除该书，可能正被故事世界引用");
    }
  };

  return (
    <div className="home-library stack">
      {/* 书斋雅集卡 Studio Banner */}
      <section className="lib-banner" aria-label="书斋雅集">
        <div className="lib-banner-head">
          <div className="lib-banner-title-group">
            <span className="lib-seal-mark" aria-hidden="true">书斋</span>
            <div className="lib-banner-copy">
              <h2>明窗书斋</h2>
              <p>
                离线藏书阁 · 免配 AI<span className="lib-sub-wide"> 随时展卷</span>
              </p>
            </div>
          </div>
          {(!items || items.length > 0) && (
            <button
              type="button"
              className="primary lib-import-btn"
              disabled={!!importProgress}
              onClick={() => void startImport()}
            >
              <Icon name="plus" size={17} />
              <span>导入小说</span>
            </button>
          )}
        </div>

        <div className="lib-metrics">
          <div className="lib-metric">
            <span className="lib-metric-label">
              <Icon name="clock" size={14} />
              今日展读
            </span>
            <b className="lib-metric-val">
              {stats?.todayMinutes ?? 0} <small>分钟</small>
            </b>
            <small className="lib-metric-sub">
              {stats && stats.streakDays > 0
                ? `连续 ${stats.streakDays} 天`
                : stats && stats.totalMinutes > 0
                  ? `累计 ${stats.totalMinutes} 分钟`
                  : "静心开卷"}
            </small>
          </div>

          <div className="lib-metric">
            <span className="lib-metric-label">
              <Icon name="book" size={14} />
              馆藏书卷
            </span>
            <b className="lib-metric-val">
              {items?.length ?? 0} <small>卷</small>
            </b>
            <small className="lib-metric-sub">
              {totalCollectionChars > 0 ? `共 ${formatWords(totalCollectionChars)}` : "支持四类格式"}
            </small>
          </div>

          <button
            type="button"
            className="lib-metric lib-metric-btn"
            onClick={() => onOpenExcerpts(null)}
            aria-label={`打开佳句摘录簿，共 ${totalHighlights} 则`}
          >
            <span className="lib-metric-label">
              <Icon name="highlight" size={14} />
              佳句批注
            </span>
            <b className="lib-metric-val">
              {totalHighlights} <small>则</small>
            </b>
            <small className="lib-metric-sub accent-link">翻阅摘录 ›</small>
          </button>
        </div>

        {importProgress && (
          <div className="lib-progress-notice" role="status">
            <span className="lib-spinner" aria-hidden="true" />
            <span className="grow">{importProgress}</span>
            {importProgress !== "正在存入书斋…" && (
              <button type="button" className="ghost small" onClick={cancelImport}>
                取消
              </button>
            )}
          </div>
        )}

        {lastTxtSession && !importProgress && (
          <div className="lib-encoding-hint">
            <span>刚导入《{lastTxtSession.title}》若遇文字乱码，可切换编码重解：</span>
            <button
              type="button"
              className="ghost small"
              onClick={() =>
                void reparsePendingTxt(lastTxtSession.file, "gb18030", lastTxtSession.bookId)
              }
            >
              切换 TXT 编码
            </button>
            <button
              type="button"
              className="icon-btn lib-encoding-dismiss"
              aria-label="关闭编码提示"
              onClick={() => setLastTxtSession(null)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
      </section>

      {/* Loading skeleton */}
      {!items && (
        <div className="stack" aria-hidden="true">
          <div className="skeleton skeleton-hero">
            <span className="skeleton-cover" />
            <span className="skeleton-lines"><i /><i /><i /></span>
          </div>
          <div className="lib-grid">
            <div className="skeleton skeleton-book" />
            <div className="skeleton skeleton-book" />
            <div className="skeleton skeleton-book" />
          </div>
        </div>
      )}

      {/* Empty State */}
      {items && items.length === 0 && (
        <section className="lib-empty-desk">
          <EmptyVignette kind="book-stack" compact />
          <h3>一室书香，静候展卷</h3>
          <p className="lib-empty-desc">
            无需连接 AI 服务即可离线畅读 <b>TXT、EPUB、PDF、DOCX</b> 本地小说。支持仿真覆页与滚动阅读、音量键翻页、六色护眼宣纸、三色划线眉批与语音听书。
          </p>
          <div className="lib-feature-pills" aria-hidden="true">
            <span>离线畅读</span>
            <span>六色护眼纸</span>
            <span>音量键翻页</span>
            <span>三色划线摘录</span>
            <span>语音听书</span>
          </div>
          <div className="lib-empty-actions">
            <button
              type="button"
              className="primary lib-empty-primary"
              disabled={!!importProgress}
              onClick={() => void startImport()}
            >
              <Icon name="import" size={18} />
              <span>导入本地小说（TXT / EPUB / PDF / DOCX）</span>
            </button>
            {worlds && worlds.length > 0 && (
              <button
                type="button"
                className="lib-empty-secondary"
                onClick={() => setCompileOpen(true)}
              >
                <Icon name="sparkle" size={17} />
                <span>将穿越故事编纂入藏</span>
              </button>
            )}
          </div>
        </section>
      )}

      {/* Featured "Currently Reading" Hero Card */}
      {items && items.length > 0 && featured && (
        <section className="lib-hero" data-book-id={featured.id} aria-label="正在展读">
          <button
            type="button"
            className="icon-btn lib-hero-more"
            aria-label={`《${featured.title}》的更多操作`}
            title="封皮锦色与管理"
            onClick={() => setManageId(featured.id)}
          >
            <Icon name="more" size={18} />
          </button>
          <button
            type="button"
            className="lib-hero-cover-btn"
            onClick={(e) => openBook(featured, e.currentTarget)}
            aria-label={`继续展读《${featured.title}》`}
          >
            <span className="lib-hero-cover">
              <BookCover seed={featured.id} title={featured.title} tone={featured.coverTone} />
            </span>
          </button>
          <div className="lib-hero-main">
            <div className="lib-hero-badges">
              <span className="lib-kicker">正在展读</span>
              <span className="lib-fmt-pill">{featured.format.toUpperCase()}</span>
              {featured.pinned && <span className="lib-pin-pill">置顶</span>}
              {featured.finished && <span className="lib-done-pill">已读完</span>}
            </div>
            <h3 className="lib-hero-title">{featured.title}</h3>
            {featured.author && <p className="lib-hero-author">{featured.author}</p>}
            <p className="lib-hero-chapter">
              {featured.currentSectionTitle || `共 ${featured.sectionCount} 节`}
            </p>
            <div className="lib-hero-progress">
              <div className="lib-progress-track" aria-hidden="true">
                <i style={{ width: `${featured.progressPct}%` }} />
              </div>
              <span className="lib-progress-meta">
                <b>
                  {featured.finished
                    ? "100% 已读完"
                    : featured.progress
                      ? `${featured.progressPct}%`
                      : "未开卷"}
                </b>
                <span>· 共 {featured.sectionCount} 节 · {formatWords(featured.totalChars)}</span>
              </span>
            </div>
            {featured.progress?.anchorText?.trim() && (() => {
              const rawQuote = featured.progress.anchorText.trim();
              const cleanQuote = /[。！？…）”』》.!?"']$/.test(rawQuote) ? rawQuote : `${rawQuote}…`;
              return <blockquote className="lib-hero-quote">{cleanQuote}</blockquote>;
            })()}
            <div className="lib-hero-actions">
              <button
                type="button"
                className="primary lib-continue-btn"
                onClick={(e) => openBook(featured, e.currentTarget)}
              >
                <Icon name="book-open" size={17} />
                <span>继续展读</span>
              </button>
              <button
                type="button"
                className="lib-excerpts-btn"
                aria-label="本书摘录"
                onClick={() => onOpenExcerpts(featured.id)}
              >
                <Icon name="highlight" size={16} />
                <span>本书摘录</span>
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Controls Row + Shelf Grid */}
      {items && items.length > 0 && (
        <>
          <div className="lib-controls">
            <div className="lib-search-box">
              <Icon name="search" size={16} />
              <input
                type="search"
                aria-label="搜书名、作者或章节"
                placeholder="搜书名、作者或章节"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="lib-controls-sub">
              <label className="lib-sort-box">
                <Icon name="sort" size={15} />
                <select
                  aria-label="书斋排序"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as ShelfSort)}
                >
                  <option value="recent">最近阅读</option>
                  <option value="added">刚导入</option>
                  <option value="title">书名</option>
                  <option value="progress">阅读进度</option>
                </select>
              </label>
              {worlds && worlds.length > 0 && (
                <button
                  type="button"
                  className="lib-compile-btn"
                  onClick={() => setCompileOpen(true)}
                >
                  <Icon name="sparkle" size={15} />
                  <span>将穿越故事编纂入藏</span>
                </button>
              )}
            </div>
          </div>

          {sortedItems.length === 0 ? (
            <EmptyVignette
              kind="mist-search"
              title="没有找到相符的藏书"
              hint="换个关键词，或清空搜索框查看全部书卷。"
              compact
            />
          ) : (
            <div className="lib-grid" role="list" aria-label="书斋书架">
              {sortedItems.map((item, idx) => (
                <LibraryBookCard
                  key={item.id}
                  item={item}
                  index={idx}
                  onOpen={openBook}
                  onManage={(target) => setManageId(target.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Book Manage & 8-Swatch Song-Brocade Customizer Sheet */}
      {manageItem && (
        <Sheet title={manageItem.title} onClose={() => setManageId(null)}>
          <div className="stack gap-3 lib-manage-sheet">
            <div className="lib-manage-preview">
              <BookCover
                seed={manageItem.id}
                title={manageItem.title}
                tone={manageItem.coverTone}
              />
              <div className="lib-manage-meta">
                <b>{manageItem.title}</b>
                <small>
                  {manageItem.author ? `${manageItem.author} · ` : ""}
                  {manageItem.format.toUpperCase()} · 共 {manageItem.sectionCount} 节 ·{" "}
                  {formatWords(manageItem.totalChars)}
                </small>
                <small>
                  {manageItem.finished
                    ? "已读完"
                    : manageItem.progress
                      ? `读至 ${manageItem.progressPct}%（${manageItem.currentSectionTitle}）`
                      : "尚未开卷"}
                </small>
              </div>
            </div>

            <div className="lib-tone-picker">
              <div className="row between">
                <span className="lib-picker-label">
                  <Icon name="palette" size={15} />
                  更换封皮锦色
                </span>
                {manageItem.coverTone !== null && (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => void pickCoverTone(manageItem, null)}
                  >
                    恢复默认色
                  </button>
                )}
              </div>
              <div className="lib-swatches" role="group" aria-label="宋锦封皮配色">
                {COVER_TONE_NAMES.map((sw) => {
                  const selected = manageItem.coverTone === sw.tone;
                  return (
                    <button
                      key={sw.tone}
                      type="button"
                      className={`lib-swatch${selected ? " selected" : ""}`}
                      aria-pressed={selected}
                      aria-label={`${sw.name}锦封`}
                      onClick={() => void pickCoverTone(manageItem, sw.tone)}
                    >
                      <i style={{ background: sw.hex }} aria-hidden="true" />
                      <span>{sw.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="sheet-menu lib-manage-actions">
              <button
                type="button"
                className="with-icon"
                onClick={() => {
                  const id = manageItem.id;
                  setManageId(null);
                  push({ name: "reader", bookId: id });
                }}
              >
                <Icon name="book-open" size={20} />
                打开阅读
              </button>
              <button
                type="button"
                className="with-icon"
                onClick={() => {
                  const item = manageItem;
                  setManageId(null);
                  void togglePin(item);
                }}
              >
                <Icon name={manageItem.pinned ? "pushpin-fill" : "pushpin"} size={20} />
                {manageItem.pinned ? "取消置顶" : "置顶到书斋首位"}
              </button>
              <button
                type="button"
                className="with-icon"
                onClick={() => {
                  const item = manageItem;
                  setManageId(null);
                  void editAuthor(item);
                }}
              >
                <Icon name="pen" size={20} />
                填写作者/备注
              </button>
              <button
                type="button"
                className="with-icon"
                onClick={() => {
                  const item = manageItem;
                  setManageId(null);
                  void toggleFinished(item);
                }}
              >
                <Icon name="check" size={20} />
                {manageItem.finished ? "标记为在读" : "标记为已读完"}
              </button>
              <button
                type="button"
                className="with-icon"
                onClick={() => {
                  const id = manageItem.id;
                  setManageId(null);
                  onOpenExcerpts(id);
                }}
              >
                <Icon name="highlight" size={20} />
                本书佳句与批注（{manageItem.highlightCount}）
              </button>
              <button
                type="button"
                className="danger with-icon"
                onClick={() => void removeBook(manageItem)}
              >
                <Icon name="trash" size={20} />
                从书斋移除
              </button>
            </div>
          </div>
        </Sheet>
      )}

      {/* TXT Encoding & Title Confirmation Sheet */}
      {pendingTxt && (
        <Sheet
          title="确认文本编码与书名"
          onClose={() => {
            cancelImport();
            setPendingTxt(null);
          }}
        >
          <div className="stack gap-3">
            <p className="muted m-0">
              部分本地 TXT 小说采用 GBK/GB18030 或 UTF-16 编码，切换下方选项即可实时预览正文是否清晰无乱码。
            </p>
            <label className="field">
              文本编码
              <select
                aria-label="文本编码"
                disabled={!!importProgress}
                value={pendingTxt.encoding}
                onChange={(e) => {
                  const nextEnc = e.target.value as TextEncoding;
                  void reparsePendingTxt(pendingTxt.file, nextEnc, pendingTxt.replaceBookId);
                }}
              >
                {ENCODING_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            {pendingTxt.error && <div className="notice">{pendingTxt.error}</div>}
            {pendingTxt.book && (
              <>
                <label className="field">
                  书名
                  <input
                    aria-label="书名"
                    value={pendingTxt.book.title}
                    onChange={(e) =>
                      setPendingTxt({
                        ...pendingTxt,
                        book: { ...pendingTxt.book!, title: e.target.value },
                      })
                    }
                  />
                </label>
                <div className="lib-txt-preview">
                  <small className="muted">
                    解析出 {pendingTxt.book.sections.length} 节 · 首节预览：
                  </small>
                  <p>
                    {pendingTxt.book.sections[0]?.text.slice(0, 260) ?? ""}
                  </p>
                </div>
                <div className="row gap-2">
                  <button
                    type="button"
                    className="grow"
                    disabled={!!importProgress || !pendingTxt.book.title.trim()}
                    onClick={() => void confirmSavePendingTxt(false)}
                  >
                    存入书斋
                  </button>
                  <button
                    type="button"
                    className="primary grow"
                    disabled={!!importProgress || !pendingTxt.book.title.trim()}
                    onClick={() => void confirmSavePendingTxt(true)}
                  >
                    存入并立即展读
                  </button>
                </div>
              </>
            )}
          </div>
        </Sheet>
      )}

      {/* Compile Interactive Story World into Library Sheet */}
      {compileOpen && worlds && (
        <Sheet title="将穿越故事编纂入藏" onClose={() => setCompileOpen(false)}>
          <div className="stack gap-2">
            <p className="muted m-0">
              将你在穿越模式中亲历的当前世界线整理成正式章回体书卷，永久收入书斋书架，支持离线翻页、划线批注与听书。
            </p>
            <div className="stack gap-2">
              {worlds.map((w) => (
                <button
                  key={w.world.id}
                  type="button"
                  className="lib-world-pick"
                  disabled={!!compilingId}
                  onClick={() => void handleCompileWorld(w)}
                >
                  <BookCover seed={w.world.id} title={w.world.title} seal={w.seal} />
                  <span className="lib-world-pick-info">
                    <b>{w.world.title}</b>
                    <small>
                      {w.protagonist} · {w.clock} · {w.turns ? `${w.turns} 回合` : "刚开局"}
                    </small>
                  </span>
                  <span className="lib-world-pick-cta">
                    {compilingId === w.world.id ? "编纂中…" : "入藏 ›"}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
