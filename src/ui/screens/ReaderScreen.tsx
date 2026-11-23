import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildNovelBook, type NovelBook, type NovelParagraph } from "../../engine/novel";
import {
  addReaderBookmark,
  addReaderHighlight,
  getReaderProgress,
  listReaderBookmarks,
  listReaderHighlights,
  removeReaderBookmark,
  removeReaderHighlight,
  saveReaderProgress,
  updateReaderHighlight,
  type HighlightColor,
  type ReaderBookmark,
  type ReaderHighlight,
  type ReaderTargetType,
} from "../../engine/reader/store";
import {
  getBookMeta,
  listBookToc,
  readBookSection,
  searchBookFullText,
  type BookSectionContent,
  type BookTocItem,
} from "../../engine/sources/library";
import { useApp, useBack, type ReaderRouteProps } from "../app/context";
import { localFind } from "../app/localFind";
import { buzz } from "../app/motion";
import { ChapterOrnament, EmptyVignette, TitleCartouche } from "../components/ChineseArt";
import { ExcerptsSheet } from "../components/ExcerptsSheet";
import { Icon } from "../components/Icon";
import { NovelExportSheet } from "../components/NovelExportSheet";
import { Paginator, type PaginatorHandle } from "../components/Paginator";
import { CardSheet, SEPARATOR, type CardContent } from "../components/ShareCard";
import { Sheet } from "../components/Sheet";
import { ReadingQuickSheet } from "./play/ReadingQuick";
import "./reader.css";

interface UnifiedTocItem {
  index: number;
  title: string;
  subtitle?: string;
  chars: number;
  locked?: boolean;
}

interface SelectionDraft {
  paragraphIndex: number;
  charStart: number;
  charEnd: number;
  selectedText: string;
  nodeId: string | null;
}

interface SearchResultRow {
  sectionIndex: number;
  sectionTitle: string;
  paragraphIndex: number;
  snippet: { before: string; hit: string; after: string };
}

const SECTION_CACHE_LIMIT = 5;

const HIGHLIGHT_COLORS: { id: HighlightColor; label: string; hex: string }[] = [
  { id: "cinnabar", label: "朱砂", hex: "#b33b2a" },
  { id: "amber", label: "藤黄", hex: "#c88a22" },
  { id: "bamboo", label: "竹青", hex: "#3f7a58" },
];

function renderHighlightedText(
  text: string,
  highlights: ReaderHighlight[],
  onPickHighlight: (h: ReaderHighlight) => void,
): ReactNode {
  if (!highlights.length) return text;
  const spans = highlights
    .map((h) => {
      if (h.charEnd > h.charStart && h.charStart < text.length) {
        return { start: Math.max(0, h.charStart), end: Math.min(text.length, h.charEnd), h };
      }
      const idx = h.selectedText ? text.indexOf(h.selectedText) : -1;
      if (idx >= 0) {
        return { start: idx, end: idx + h.selectedText.length, h };
      }
      return null;
    })
    .filter((x): x is { start: number; end: number; h: ReaderHighlight } => !!x && x.end > x.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  if (!spans.length) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  spans.forEach((span, idx) => {
    const start = Math.max(cursor, span.start);
    if (span.end <= start) return;
    if (start > cursor) {
      parts.push(<Fragment key={`t-${idx}`}>{text.slice(cursor, start)}</Fragment>);
    }
    parts.push(
      <mark
        key={span.h.id}
        className={`reader-hl hl-${span.h.color}`}
        data-no-page-tap="true"
        onClick={(e) => {
          e.stopPropagation();
          onPickHighlight(span.h);
        }}
      >
        {text.slice(start, span.end)}
      </mark>,
    );
    cursor = span.end;
  });
  if (cursor < text.length) {
    parts.push(<Fragment key="tail">{text.slice(cursor)}</Fragment>);
  }
  return parts;
}

export default function ReaderScreen({
  bookId,
  worldId,
  lineId,
  initialSection,
  initialNodeId,
  through: propThrough,
}: ReaderRouteProps) {
  const { game, pop, reading, setReading, toast, ask } = useApp();
  const targetType: ReaderTargetType = bookId ? "book" : "world_novel";
  const targetId = bookId ?? worldId ?? "";

  const [bookTitle, setBookTitle] = useState("正在打开书卷…");
  const [toc, setToc] = useState<UnifiedTocItem[]>([]);
  const [novelBook, setNovelBook] = useState<NovelBook | null>(null);
  const [sectionIndex, setSectionIndex] = useState(initialSection ?? 0);
  const [entryPage, setEntryPage] = useState<number | "last">(0);
  const [entrySelector, setEntrySelector] = useState<string | null>(
    initialNodeId ? `[data-node-id="${CSS.escape(initialNodeId)}"]` : null,
  );
  const [pendingScrollRatio, setPendingScrollRatio] = useState<number | null>(null);
  const [pendingFlashPara, setPendingFlashPara] = useState<number | null>(null);
  const [bookSection, setBookSection] = useState<BookSectionContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [spoilerCeiling, setSpoilerCeiling] = useState<number | null>(propThrough ?? null);
  const [spoilerUnlocked, setSpoilerUnlocked] = useState(false);

  const [bookmarks, setBookmarks] = useState<ReaderBookmark[]>([]);
  const [highlights, setHighlights] = useState<ReaderHighlight[]>([]);
  const [hudHidden, setHudHidden] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"toc" | "bookmarks" | "search" | null>(null);
  const [tocFilter, setTocFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchResultRow[]>([]);
  const [searching, setSearching] = useState(false);

  const [readingSheet, setReadingSheet] = useState(false);
  const [excerptsOpen, setExcerptsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [selection, setSelection] = useState<SelectionDraft | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<ReaderHighlight | null>(null);
  const [noteInput, setNoteInput] = useState("");
  const [newNoteSheet, setNewNoteSheet] = useState<{ draft: SelectionDraft; color: HighlightColor } | null>(null);
  const [cardContent, setCardContent] = useState<CardContent | null>(null);

  const sectionCache = useRef<Map<number, BookSectionContent>>(new Map());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const proseRef = useRef<HTMLDivElement>(null);
  const paginatorRef = useRef<PaginatorHandle>(null);
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useBack(() => {
    if (selection) {
      window.getSelection?.()?.removeAllRanges();
      setSelection(null);
      return true;
    }
    if (hudHidden) {
      setHudHidden(false);
      return true;
    }
    return false;
  });

  useEffect(() => {
    if (!reading.keepAwake) return;
    void game.platform.system.setKeepAwake(true).catch(() => {});
    return () => {
      void game.platform.system.setKeepAwake(false).catch(() => {});
    };
  }, [game.platform.system, reading.keepAwake]);

  const refreshAnnotations = useCallback(async () => {
    if (!targetId) return;
    const [bms, hls] = await Promise.all([
      listReaderBookmarks(game.repo, targetType, targetId),
      listReaderHighlights(game.repo, { targetType, targetId }),
    ]);
    setBookmarks(bms);
    setHighlights(hls);
  }, [game.repo, targetId, targetType]);

  // Initial load of book / world novel + saved reading progress
  useEffect(() => {
    let live = true;
    sectionCache.current.clear();
    setLoading(true);
    setError("");
    void (async () => {
      try {
        if (bookId) {
          let effectiveThrough = propThrough ?? null;
          if (effectiveThrough == null && worldId) {
            const w = await game.repo.getWorld(worldId);
            const line = w?.currentLineId ? await game.repo.getLine(w.currentLineId) : null;
            const st = line ? await game.repo.getState(line.nodeId).catch(() => null) : null;
            if (st?.source?.bookId === bookId && st.source.through != null) {
              effectiveThrough = st.source.through;
            }
          }
          const [meta, rawToc, saved] = await Promise.all([
            getBookMeta(game.repo, bookId),
            listBookToc(game.repo, bookId),
            initialSection === undefined ? getReaderProgress(game.repo, "book", bookId) : Promise.resolve(null),
          ]);
          if (!live) return;
          if (!meta || !rawToc.length) {
            setError("这本书暂时无法打开，可能已被移除。");
            setLoading(false);
            return;
          }
          setSpoilerCeiling(effectiveThrough);
          setBookTitle(meta.title);
          setToc(
            rawToc.map((item: BookTocItem) => ({
              index: item.section,
              title: item.title || `第 ${item.section + 1} 节`,
              chars: item.chars,
              locked: effectiveThrough != null && item.section > effectiveThrough,
            })),
          );
          const maxInitial = effectiveThrough != null ? Math.min(rawToc.length - 1, effectiveThrough) : rawToc.length - 1;
          const startSec = Math.max(
            0,
            Math.min(
              rawToc.length - 1,
              initialSection ?? Math.min(saved?.sectionIndex ?? 0, maxInitial),
            ),
          );
          setSectionIndex(startSec);
          if (saved && initialSection === undefined && saved.sectionIndex === startSec) {
            setEntryPage(saved.pageIndex);
            setPendingScrollRatio(saved.scrollRatio);
          }
        } else if (worldId) {
          const [built, saved] = await Promise.all([
            buildNovelBook(game.repo, worldId, {
              lineId,
              includePreface: true,
              includeChronicle: true,
              includeActions: false,
            }),
            initialSection === undefined && !initialNodeId
              ? getReaderProgress(game.repo, "world_novel", worldId)
              : Promise.resolve(null),
          ]);
          if (!live) return;
          if (!built || !built.sections.length) {
            setError("这部故事还没有可阅读的章节。");
            setLoading(false);
            return;
          }
          setNovelBook(built);
          setBookTitle(built.title);
          setToc(
            built.sections.map((s) => ({
              index: s.index,
              title: s.title,
              subtitle: s.subtitle,
              chars: s.chars,
            })),
          );
          let startSec = initialSection ?? saved?.sectionIndex ?? 0;
          if (initialNodeId) {
            const hitSec = built.sections.findIndex(
              (s) =>
                s.firstNodeId === initialNodeId ||
                s.lastNodeId === initialNodeId ||
                s.paragraphs.some((p) => p.nodeId === initialNodeId),
            );
            if (hitSec >= 0) startSec = hitSec;
          }
          startSec = Math.max(0, Math.min(built.sections.length - 1, startSec));
          setSectionIndex(startSec);
          if (saved && initialSection === undefined && !initialNodeId && saved.sectionIndex === startSec) {
            setEntryPage(saved.pageIndex);
            setPendingScrollRatio(saved.scrollRatio);
          }
        }
        await refreshAnnotations();
      } catch (e: unknown) {
        if (live) setError(e instanceof Error ? e.message : "读取书卷失败");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [bookId, game.repo, initialNodeId, initialSection, lineId, propThrough, refreshAnnotations, worldId]);

  // On-demand LRU chapter fetch for imported books (at most 5 sections in RAM)
  const fetchSectionCached = useCallback(
    async (sec: number): Promise<BookSectionContent | null> => {
      if (!bookId) return null;
      const cache = sectionCache.current;
      const hit = cache.get(sec);
      if (hit) {
        cache.delete(sec);
        cache.set(sec, hit);
        return hit;
      }
      const loaded = await readBookSection(game.repo, bookId, sec);
      if (loaded) {
        cache.set(sec, loaded);
        while (cache.size > SECTION_CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
      return loaded;
    },
    [bookId, game.repo],
  );

  useEffect(() => {
    if (!bookId || !toc.length) return;
    let live = true;
    void fetchSectionCached(sectionIndex).then((sec) => {
      if (!live) return;
      setBookSection(sec);
      const nextIdx = sectionIndex + 1;
      if (nextIdx < toc.length && (spoilerUnlocked || spoilerCeiling == null || nextIdx <= spoilerCeiling)) {
        void fetchSectionCached(nextIdx).catch(() => {});
      }
    });
    return () => {
      live = false;
    };
  }, [bookId, fetchSectionCached, sectionIndex, spoilerCeiling, spoilerUnlocked, toc.length]);

  const currentSection = useMemo(() => {
    if (bookId) {
      if (!bookSection || bookSection.section !== sectionIndex) return null;
      return {
        index: bookSection.section,
        title: bookSection.title || `第 ${bookSection.section + 1} 节`,
        subtitle: bookSection.page ? `第 ${bookSection.page} 页` : undefined,
        seal: undefined as string | undefined,
        paragraphs: bookSection.paragraphs.map<NovelParagraph>((text) => ({ kind: "prose", text })),
        isLast: sectionIndex === toc.length - 1,
        statusLine: null as string | null,
      };
    }
    const sec = novelBook?.sections[sectionIndex];
    if (!sec || !novelBook) return null;
    return {
      index: sec.index,
      title: sec.title,
      subtitle: sec.subtitle,
      seal: sec.index === 0 ? novelBook.seal.slice(0, 2) : undefined,
      paragraphs: sec.paragraphs,
      isLast: sectionIndex === novelBook.sections.length - 1,
      statusLine: sectionIndex === novelBook.sections.length - 1 ? novelBook.statusLine : null,
    };
  }, [bookId, bookSection, novelBook, sectionIndex, toc.length]);

  const sectionHighlights = useMemo(
    () => highlights.filter((h) => h.sectionIndex === sectionIndex),
    [highlights, sectionIndex],
  );

  const sectionBookmark = useMemo(
    () => bookmarks.find((b) => b.sectionIndex === sectionIndex) ?? null,
    [bookmarks, sectionIndex],
  );

  const scheduleSaveProgress = useCallback(
    (nextSection: number, pageIndex: number, scrollRatio: number, nodeId: string | null = null) => {
      if (!targetId) return;
      if (progressTimer.current) clearTimeout(progressTimer.current);
      progressTimer.current = setTimeout(() => {
        const snippet = currentSection?.paragraphs[0]?.text.slice(0, 36) ?? "";
        void saveReaderProgress(game.repo, {
          targetType,
          targetId,
          sectionIndex: nextSection,
          pageIndex,
          scrollRatio,
          anchorText: snippet,
          nodeId,
        }).catch(() => {});
      }, 360);
    },
    [currentSection, game.repo, targetId, targetType],
  );

  useEffect(
    () => () => {
      if (progressTimer.current) clearTimeout(progressTimer.current);
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    },
    [],
  );

  // Restore scroll position or flash jumped paragraph in scroll mode
  useEffect(() => {
    if (reading.pageMode !== "scroll" || !currentSection) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    requestAnimationFrame(() => {
      if (pendingFlashPara !== null) {
        const el = scroller.querySelector<HTMLElement>(`[data-para-index="${pendingFlashPara}"]`);
        if (el) {
          el.scrollIntoView({ block: "center" });
          el.classList.add("toc-flash");
          setTimeout(() => el.classList.remove("toc-flash"), 1600);
        }
        setPendingFlashPara(null);
        return;
      }
      if (entrySelector) {
        const el = scroller.querySelector<HTMLElement>(entrySelector);
        if (el) {
          el.scrollIntoView({ block: "center" });
          el.classList.add("toc-flash");
          setTimeout(() => el.classList.remove("toc-flash"), 1600);
        }
        setEntrySelector(null);
        return;
      }
      if (pendingScrollRatio !== null && pendingScrollRatio > 0) {
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = Math.round(maxScroll * pendingScrollRatio);
        setPendingScrollRatio(null);
      } else {
        scroller.scrollTop = 0;
      }
    });
  }, [currentSection, entrySelector, pendingFlashPara, pendingScrollRatio, reading.pageMode]);

  const goSection = useCallback(
    async (targetSec: number, opts?: { page?: number | "last"; paraIndex?: number; selector?: string }) => {
      if (!toc.length) return;
      const clamped = Math.max(0, Math.min(toc.length - 1, targetSec));
      if (bookId && spoilerCeiling != null && clamped > spoilerCeiling && !spoilerUnlocked) {
        const ok = await ask({
          title: "超出本局防剧透范围",
          message: `本局当前设定的参考范围截至第 ${spoilerCeiling + 1} 节。提前翻阅第 ${clamped + 1} 节可能会看到后续原著剧情，确定要先看吗？`,
          confirm: "继续翻阅",
        });
        if (!ok) return;
        setSpoilerUnlocked(true);
      }
      setSelection(null);
      setEntryPage(opts?.page ?? 0);
      setEntrySelector(
        opts?.selector ??
          (opts?.paraIndex !== undefined ? `[data-para-index="${opts.paraIndex}"]` : null),
      );
      if (opts?.paraIndex !== undefined) setPendingFlashPara(opts.paraIndex);
      setPendingScrollRatio(null);
      setSectionIndex(clamped);
      scheduleSaveProgress(clamped, typeof opts?.page === "number" ? opts.page : 0, 0);
    },
    [ask, bookId, scheduleSaveProgress, spoilerCeiling, spoilerUnlocked, toc.length],
  );

  // Selection detection inside .reader-prose
  const checkTextSelection = useCallback(() => {
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const raw = sel.toString().trim();
    if (!raw) return;
    const range = sel.getRangeAt(0);
    const root = proseRef.current;
    if (!root || !root.contains(range.commonAncestorContainer)) return;
    const startEl =
      range.startContainer instanceof HTMLElement
        ? range.startContainer.closest<HTMLElement>("[data-para-index]")
        : range.startContainer.parentElement?.closest<HTMLElement>("[data-para-index]");
    if (!startEl) return;
    const pIdx = Number(startEl.dataset.paraIndex ?? 0);
    const fullText = currentSection?.paragraphs[pIdx]?.text ?? startEl.textContent ?? "";
    const pos = fullText.indexOf(raw);
    const charStart = pos >= 0 ? pos : 0;
    const charEnd = pos >= 0 ? pos + raw.length : raw.length;
    setSelection({
      paragraphIndex: pIdx,
      charStart,
      charEnd,
      selectedText: raw.slice(0, 1200),
      nodeId: startEl.dataset.nodeId ?? null,
    });
  }, [currentSection]);

  const applyQuickHighlight = async (color: HighlightColor, note = "") => {
    if (!selection || !currentSection) return;
    await addReaderHighlight(game.repo, {
      targetType,
      targetId,
      worldId: worldId ?? (targetType === "world_novel" ? targetId : null),
      sectionIndex,
      sectionTitle: currentSection.title,
      paragraphIndex: selection.paragraphIndex,
      charStart: selection.charStart,
      charEnd: selection.charEnd,
      selectedText: selection.selectedText,
      note,
      color,
      nodeId: selection.nodeId,
    });
    window.getSelection?.()?.removeAllRanges();
    setSelection(null);
    buzz(game.platform);
    await refreshAnnotations();
    toast(note.trim() ? "已记下划线与批注" : "已划线收入佳句摘录");
  };

  const toggleBookmark = async () => {
    if (!currentSection) return;
    if (sectionBookmark) {
      await removeReaderBookmark(game.repo, sectionBookmark.id);
      await refreshAnnotations();
      toast("已移除本章书签");
      return;
    }
    const paraIdx = Number(paginatorRef.current?.currentAnchorId("data-para-index") ?? 0) || 0;
    const para = currentSection.paragraphs[paraIdx] ?? currentSection.paragraphs[0];
    await addReaderBookmark(game.repo, {
      targetType,
      targetId,
      sectionIndex,
      sectionTitle: currentSection.title,
      snippet: (para?.text ?? currentSection.title).slice(0, 48),
      paragraphIndex: paraIdx,
      nodeId: para?.nodeId ?? null,
    });
    buzz(game.platform);
    await refreshAnnotations();
    toast("已添加书签");
  };

  // Full-text search across imported book or novel sections
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || drawerTab !== "search") {
      setSearchHits([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      setSearching(true);
      void (async () => {
        try {
          if (bookId) {
            const hits = await searchBookFullText(game.repo, bookId, q, {
              through: !spoilerUnlocked && spoilerCeiling != null ? spoilerCeiling : null,
              limit: 80,
            });
            if (!live) return;
            setSearchHits(
              hits.map((h) => ({
                sectionIndex: h.section,
                sectionTitle: h.title || `第 ${h.section + 1} 节`,
                paragraphIndex: h.paragraphIndex,
                snippet: h.snippet,
              })),
            );
          } else if (novelBook) {
            const out: SearchResultRow[] = [];
            for (const sec of novelBook.sections) {
              for (let pIdx = 0; pIdx < sec.paragraphs.length; pIdx++) {
                const text = sec.paragraphs[pIdx]!.text;
                const pos = text.indexOf(q);
                if (pos < 0) continue;
                out.push({
                  sectionIndex: sec.index,
                  sectionTitle: sec.title,
                  paragraphIndex: pIdx,
                  snippet: {
                    before: text.slice(Math.max(0, pos - 20), pos),
                    hit: text.slice(pos, pos + q.length),
                    after: text.slice(pos + q.length, pos + q.length + 32),
                  },
                });
                if (out.length >= 80) break;
              }
              if (out.length >= 80) break;
            }
            if (live) setSearchHits(out);
          }
        } finally {
          if (live) setSearching(false);
        }
      })();
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [bookId, drawerTab, game.repo, novelBook, searchQuery, spoilerCeiling, spoilerUnlocked]);

  const filteredToc = useMemo(
    () =>
      toc.filter((item) => {
        if (!spoilerUnlocked && spoilerCeiling != null && item.index > spoilerCeiling && tocFilter.trim()) {
          return false;
        }
        return localFind(tocFilter, item.title, item.subtitle ?? "", String(item.index + 1));
      }),
    [spoilerCeiling, spoilerUnlocked, toc, tocFilter],
  );

  const proseBody = currentSection && (
    <div
      className="reader-prose"
      ref={proseRef}
      onMouseUp={checkTextSelection}
      onTouchEnd={() => setTimeout(checkTextSelection, 60)}
    >
      <TitleCartouche
        title={currentSection.title}
        subtitle={currentSection.subtitle}
        seal={currentSection.seal}
      />
      {currentSection.paragraphs.map((para, pIdx) => {
        if (para.kind === "divider") {
          return (
            <div key={pIdx} data-para-index={pIdx} data-node-id={para.nodeId ?? undefined}>
              <ChapterOrnament label={para.text} />
            </div>
          );
        }
        const paraHighlights = sectionHighlights.filter((h) => h.paragraphIndex === pIdx);
        const notesWithText = paraHighlights.filter((h) => h.note.trim());
        return (
          <Fragment key={pIdx}>
            <p
              className={`reader-para is-${para.kind}`}
              data-para-index={pIdx}
              data-node-id={para.nodeId ?? undefined}
              onContextMenu={(e) => {
                const existingSel = window.getSelection?.()?.toString().trim();
                if (existingSel) return;
                e.preventDefault();
                setSelection({
                  paragraphIndex: pIdx,
                  charStart: 0,
                  charEnd: para.text.length,
                  selectedText: para.text.slice(0, 1200),
                  nodeId: para.nodeId ?? null,
                });
              }}
              onTouchStart={() => {
                if (longPressTimer.current) clearTimeout(longPressTimer.current);
                longPressTimer.current = setTimeout(() => {
                  const existingSel = window.getSelection?.()?.toString().trim();
                  if (existingSel) return;
                  buzz(game.platform);
                  setSelection({
                    paragraphIndex: pIdx,
                    charStart: 0,
                    charEnd: para.text.length,
                    selectedText: para.text.slice(0, 1200),
                    nodeId: para.nodeId ?? null,
                  });
                }, 520);
              }}
              onTouchMove={() => {
                if (longPressTimer.current) clearTimeout(longPressTimer.current);
              }}
              onTouchEnd={() => {
                if (longPressTimer.current) clearTimeout(longPressTimer.current);
              }}
            >
              {renderHighlightedText(para.text, paraHighlights, (h) => {
                setActiveHighlight(h);
                setNoteInput(h.note);
              })}
            </p>
            {notesWithText.map((h) => (
              <span
                key={`note-${h.id}`}
                className="reader-para-note"
                data-no-page-tap="true"
                onClick={() => {
                  setActiveHighlight(h);
                  setNoteInput(h.note);
                }}
              >
                批注：{h.note}
              </span>
            ))}
          </Fragment>
        );
      })}
      {currentSection.statusLine && <p className="reader-colophon">{currentSection.statusLine}</p>}
    </div>
  );

  const paginatorKey = `${targetId}:${sectionIndex}:${sectionHighlights.map((h) => `${h.id}:${h.color}:${h.note}`).join("|")}:${reading.size}:${reading.leading}:${reading.paragraph}:${reading.serif}:${reading.indent}:${reading.measure}`;

  return (
    <div className={`reader-screen${hudHidden ? " hud-hidden" : ""}`}>
      <div className="topbar reader-topbar">
        <button className="icon-btn" aria-label="返回" onClick={pop}>
          <Icon name="back" />
        </button>
        <button
          type="button"
          className="title"
          aria-label="打开目录"
          onClick={() => setDrawerTab("toc")}
        >
          <h1>{bookTitle}</h1>
          <div className="subtitle">
            {currentSection
              ? `${currentSection.title}（${sectionIndex + 1}/${Math.max(1, toc.length)}）`
              : "正在展开书页…"}
          </div>
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={sectionBookmark ? "移除本章书签" : "添加本章书签"}
          title={sectionBookmark ? "移除本章书签" : "添加本章书签"}
          onClick={() => void toggleBookmark()}
        >
          <Icon name={sectionBookmark ? "bookmark-fill" : "bookmark"} />
        </button>
        {targetType === "world_novel" && worldId && (
          <button
            type="button"
            className="icon-btn"
            aria-label="导出成书"
            title="导出成正式小说"
            onClick={() => setExportOpen(true)}
          >
            <Icon name="download" />
          </button>
        )}
        <button
          type="button"
          className="icon-btn reading-btn"
          aria-label="排版与主题"
          title="排版与主题"
          onClick={() => setReadingSheet(true)}
        >
          <span aria-hidden="true">Aa</span>
        </button>
      </div>

      <div className="reader-stage">
        {loading ? (
          <div className="screen-body skeleton-story" role="status" aria-label="正在加载章节">
            {[86, 100, 94, 72, 0, 98, 90, 64].map((w, i) =>
              w ? <i key={i} className="skeleton" style={{ width: `${w}%` }} /> : <br key={i} />,
            )}
          </div>
        ) : error ? (
          <div className="screen-body stack">
            <EmptyVignette kind="book-stack" title="没能打开这卷书" hint={error} />
            <button type="button" onClick={pop}>
              返回上一页
            </button>
          </div>
        ) : !currentSection ? (
          <div className="screen-body">
            <p className="muted">正在读取章节正文…</p>
          </div>
        ) : reading.pageMode === "paged" ? (
          <Paginator
            key={`${targetId}:${sectionIndex}`}
            ref={paginatorRef}
            contentKey={paginatorKey}
            initialPage={entryPage}
            initialSelector={entrySelector}
            footerLeft={currentSection.title}
            onCenterTap={() => {
              if (!selection) setHudHidden((h) => !h);
            }}
            onBoundaryStart={
              sectionIndex > 0
                ? () => void goSection(sectionIndex - 1, { page: "last" })
                : () => toast("已经是第一章了")
            }
            onBoundaryEnd={
              sectionIndex < toc.length - 1
                ? () => void goSection(sectionIndex + 1, { page: 0 })
                : () => toast("已经读到最后一章了")
            }
            onPageChange={(p, _total, anchorNodeId) => {
              scheduleSaveProgress(sectionIndex, p, 0, anchorNodeId);
            }}
          >
            {proseBody}
          </Paginator>
        ) : (
          <div
            className="reader-scroller"
            ref={scrollerRef}
            onScroll={() => {
              const el = scrollerRef.current;
              if (!el) return;
              const max = Math.max(1, el.scrollHeight - el.clientHeight);
              scheduleSaveProgress(sectionIndex, 0, el.scrollTop / max);
            }}
          >
            {proseBody}
            <nav className="reader-chapter-nav" aria-label="章节翻页">
              <button
                type="button"
                className="ghost"
                disabled={sectionIndex <= 0}
                onClick={() => void goSection(sectionIndex - 1)}
              >
                ‹ 上一章
              </button>
              <button type="button" className="ghost" onClick={() => setDrawerTab("toc")}>
                目录（{sectionIndex + 1}/{toc.length}）
              </button>
              <button
                type="button"
                disabled={sectionIndex >= toc.length - 1}
                onClick={() => void goSection(sectionIndex + 1)}
              >
                下一章 ›
              </button>
            </nav>
          </div>
        )}
      </div>

      {hudHidden && (
        <button
          type="button"
          className="icon-btn reader-hud-fab"
          aria-label="显示阅读工具栏"
          onClick={() => setHudHidden(false)}
        >
          <Icon name="more" />
        </button>
      )}

      {selection && (
        <div className="reader-selection-bar" role="toolbar" aria-label="划线与摘录工具">
          {HIGHLIGHT_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              className="reader-color-dot"
              aria-label={`${c.label}划线`}
              title={`${c.label}划线`}
              style={{ background: c.hex }}
              onClick={() => void applyQuickHighlight(c.id)}
            />
          ))}
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              setNewNoteSheet({ draft: selection, color: "cinnabar" });
              setNoteInput("");
              window.getSelection?.()?.removeAllRanges();
              setSelection(null);
            }}
          >
            写批注
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              setCardContent({
                title: bookTitle,
                heading: currentSection?.title,
                body: selection.selectedText,
                date: "",
                place: "",
                name: "",
                seal: "书摘",
              });
              window.getSelection?.()?.removeAllRanges();
              setSelection(null);
            }}
          >
            书摘卡
          </button>
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              void navigator.clipboard?.writeText(selection.selectedText);
              window.getSelection?.()?.removeAllRanges();
              setSelection(null);
              toast("已复制选中文字");
            }}
          >
            复制
          </button>
          <button
            type="button"
            className="ghost small"
            aria-label="关闭划线菜单"
            onClick={() => {
              window.getSelection?.()?.removeAllRanges();
              setSelection(null);
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      <div className="reader-dock">
        {toc.length > 1 && (
          <div className="reader-progress-row">
            <button
              type="button"
              className="ghost small"
              disabled={sectionIndex <= 0}
              onClick={() => void goSection(sectionIndex - 1)}
            >
              上一章
            </button>
            <input
              type="range"
              aria-label="章节进度"
              min={0}
              max={Math.max(0, toc.length - 1)}
              value={sectionIndex}
              onChange={(e) => void goSection(Number(e.target.value))}
            />
            <button
              type="button"
              className="ghost small"
              disabled={sectionIndex >= toc.length - 1}
              onClick={() => void goSection(sectionIndex + 1)}
            >
              下一章
            </button>
          </div>
        )}
        <div className="reader-actions-row">
          <button type="button" className="reader-tool-btn" onClick={() => setDrawerTab("toc")}>
            <Icon name="toc" size={19} />
            <span>目录</span>
          </button>
          <button type="button" className="reader-tool-btn" onClick={() => setDrawerTab("bookmarks")}>
            <Icon name="bookmark" size={19} />
            <span>书签{bookmarks.length ? `(${bookmarks.length})` : ""}</span>
          </button>
          <button type="button" className="reader-tool-btn" onClick={() => setExcerptsOpen(true)}>
            <Icon name="highlight" size={19} />
            <span>摘录{highlights.length ? `(${highlights.length})` : ""}</span>
          </button>
          <button type="button" className="reader-tool-btn" onClick={() => setDrawerTab("search")}>
            <Icon name="search" size={19} />
            <span>搜索</span>
          </button>
          <button
            type="button"
            className="reader-tool-btn"
            aria-label={reading.pageMode === "paged" ? "切换为上下滚动" : "切换为左右翻页"}
            onClick={() =>
              setReading({
                ...reading,
                pageMode: reading.pageMode === "paged" ? "scroll" : "paged",
              })
            }
          >
            <Icon name={reading.pageMode === "paged" ? "page-scroll" : "page-turn"} size={19} />
            <span>{reading.pageMode === "paged" ? "翻页中" : "滚动中"}</span>
          </button>
        </div>
      </div>

      {drawerTab === "toc" && (
        <Sheet title="目录" onClose={() => setDrawerTab(null)}>
          <div className="stack gap-2">
            {spoilerCeiling != null && !spoilerUnlocked && (
              <div className="row between wrap gap-1">
                <small className="muted">防剧透保护开启：截至第 {spoilerCeiling + 1} 节</small>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => setSpoilerUnlocked(true)}
                >
                  临时显示全书
                </button>
              </div>
            )}
            {toc.length > 6 && (
              <input
                type="search"
                aria-label="筛选目录"
                placeholder="搜章节号或标题"
                value={tocFilter}
                onChange={(e) => setTocFilter(e.target.value)}
              />
            )}
            {!filteredToc.length ? (
              <EmptyVignette kind="mist-search" title="没有匹配的章节" compact />
            ) : (
              <div className="stack gap-1">
                {filteredToc.map((item) => {
                  const active = item.index === sectionIndex;
                  const locked = !spoilerUnlocked && spoilerCeiling != null && item.index > spoilerCeiling;
                  return (
                    <button
                      key={item.index}
                      type="button"
                      className={`item-row codex-item${active ? " edge" : ""}`}
                      aria-current={active ? "true" : undefined}
                      onClick={() => {
                        setDrawerTab(null);
                        void goSection(item.index);
                      }}
                    >
                      <div className="grow">
                        <b>{item.title}</b>
                        {item.subtitle && <small>{item.subtitle}</small>}
                      </div>
                      <span className="person-side">
                        {locked ? (
                          <span className="tag">未解锁</span>
                        ) : active ? (
                          <span className="tag">在读</span>
                        ) : (
                          <small>{item.chars.toLocaleString()} 字</small>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </Sheet>
      )}

      {drawerTab === "bookmarks" && (
        <Sheet title="书签" onClose={() => setDrawerTab(null)}>
          <div className="stack gap-2">
            <button type="button" onClick={() => void toggleBookmark()}>
              <Icon name={sectionBookmark ? "bookmark-fill" : "bookmark"} size={18} />
              {sectionBookmark ? "移除当前章节书签" : "给当前章节加书签"}
            </button>
            {!bookmarks.length ? (
              <EmptyVignette
                kind="book-stack"
                title="还没有夹入书签"
                hint="点右上角书签图标即可记下当前章节，随时翻回。"
                compact
              />
            ) : (
              bookmarks.map((bm) => (
                <div key={bm.id} className="item-row">
                  <button
                    type="button"
                    className="ghost grow"
                    style={{ textAlign: "left", justifyContent: "flex-start" }}
                    onClick={() => {
                      setDrawerTab(null);
                      void goSection(bm.sectionIndex, { paraIndex: bm.paragraphIndex });
                    }}
                  >
                    <div className="stack gap-0">
                      <b>{bm.sectionTitle}</b>
                      <small className="muted">{bm.snippet}</small>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="ghost small danger-text"
                    aria-label="删除书签"
                    onClick={async () => {
                      await removeReaderBookmark(game.repo, bm.id);
                      await refreshAnnotations();
                    }}
                  >
                    删除
                  </button>
                </div>
              ))
            )}
          </div>
        </Sheet>
      )}

      {drawerTab === "search" && (
        <Sheet title="全文检索" onClose={() => setDrawerTab(null)}>
          <div className="stack gap-2">
            <input
              type="search"
              aria-label="全文搜索关键词"
              placeholder="输入词句、人名或地名查找原文"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {spoilerCeiling != null && !spoilerUnlocked && (
              <small className="muted m-0">仅检索截至第 {spoilerCeiling + 1} 节的内容，避免剧透后文。</small>
            )}
            {searching ? (
              <p className="muted m-0">正在检索书卷…</p>
            ) : searchQuery.trim() && !searchHits.length ? (
              <EmptyVignette kind="mist-search" title="未找到相符原文" hint="换个关键词试试。" compact />
            ) : (
              searchHits.map((hit, idx) => (
                <button
                  key={`${hit.sectionIndex}-${hit.paragraphIndex}-${idx}`}
                  type="button"
                  className="item-row codex-item"
                  onClick={() => {
                    setDrawerTab(null);
                    void goSection(hit.sectionIndex, { paraIndex: hit.paragraphIndex });
                  }}
                >
                  <div className="grow">
                    <b>{hit.sectionTitle}</b>
                    <small className="toc-snippet">
                      {hit.snippet.before}
                      <mark>{hit.snippet.hit}</mark>
                      {hit.snippet.after}
                    </small>
                  </div>
                </button>
              ))
            )}
          </div>
        </Sheet>
      )}

      {newNoteSheet && currentSection && (
        <Sheet title="写批注与划线" onClose={() => setNewNoteSheet(null)}>
          <div className="stack gap-3">
            <blockquote
              className="m-0"
              style={{
                padding: "10px 12px",
                background: "var(--surface)",
                borderLeft: "3px solid var(--accent)",
                borderRadius: "0 8px 8px 0",
                fontFamily: "var(--serif)",
              }}
            >
              {newNoteSheet.draft.selectedText}
            </blockquote>
            <div className="row gap-1" role="group" aria-label="划线色标">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="ghost small"
                  aria-pressed={newNoteSheet.color === c.id}
                  onClick={() => setNewNoteSheet({ ...newNoteSheet, color: c.id })}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: c.hex,
                      marginRight: 6,
                    }}
                  />
                  {c.label}
                </button>
              ))}
            </div>
            <label className="field">
              批注（可留空）
              <textarea
                rows={3}
                placeholder="记下读到此处的一点想法…"
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="primary"
              onClick={async () => {
                const { draft, color } = newNoteSheet;
                await addReaderHighlight(game.repo, {
                  targetType,
                  targetId,
                  worldId: worldId ?? (targetType === "world_novel" ? targetId : null),
                  sectionIndex,
                  sectionTitle: currentSection.title,
                  paragraphIndex: draft.paragraphIndex,
                  charStart: draft.charStart,
                  charEnd: draft.charEnd,
                  selectedText: draft.selectedText,
                  note: noteInput.trim(),
                  color,
                  nodeId: draft.nodeId,
                });
                setNewNoteSheet(null);
                await refreshAnnotations();
                toast("已保存划线与批注");
              }}
            >
              保存
            </button>
          </div>
        </Sheet>
      )}

      {activeHighlight && (
        <Sheet title="划线与批注" onClose={() => setActiveHighlight(null)}>
          <div className="stack gap-3">
            <p className="m-0" style={{ fontFamily: "var(--serif)", lineHeight: 1.75 }}>
              {activeHighlight.selectedText}
            </p>
            <div className="row gap-1" role="group" aria-label="修改色标">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="ghost small"
                  aria-pressed={activeHighlight.color === c.id}
                  onClick={async () => {
                    await updateReaderHighlight(game.repo, activeHighlight.id, { color: c.id });
                    setActiveHighlight({ ...activeHighlight, color: c.id });
                    await refreshAnnotations();
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: c.hex,
                      marginRight: 6,
                    }}
                  />
                  {c.label}
                </button>
              ))}
            </div>
            <label className="field">
              批注
              <textarea rows={3} value={noteInput} onChange={(e) => setNoteInput(e.target.value)} />
            </label>
            <div className="row wrap gap-2">
              <button
                type="button"
                className="danger-text"
                onClick={async () => {
                  await removeReaderHighlight(game.repo, activeHighlight.id);
                  setActiveHighlight(null);
                  await refreshAnnotations();
                  toast("已移除划线");
                }}
              >
                移除划线
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const h = activeHighlight;
                  setActiveHighlight(null);
                  setCardContent({
                    title: bookTitle,
                    heading: h.sectionTitle || undefined,
                    body: noteInput.trim() ? `${h.selectedText}\n\n${SEPARATOR}\n\n批注：${noteInput.trim()}` : h.selectedText,
                    date: h.createdAt.slice(0, 10),
                    place: "",
                    name: "",
                    seal: "摘录",
                  });
                }}
              >
                做成书摘卡
              </button>
              <button
                type="button"
                className="primary grow"
                onClick={async () => {
                  await updateReaderHighlight(game.repo, activeHighlight.id, { note: noteInput.trim() });
                  setActiveHighlight(null);
                  await refreshAnnotations();
                  toast("已保存批注");
                }}
              >
                保存批注
              </button>
            </div>
          </div>
        </Sheet>
      )}

      {readingSheet && <ReadingQuickSheet onClose={() => setReadingSheet(false)} />}
      {excerptsOpen && (
        <ExcerptsSheet
          worldId={targetType === "world_novel" ? targetId : worldId}
          bookId={targetType === "book" ? targetId : null}
          onJumpHighlight={(h) => {
            if (h.targetType === targetType && h.targetId === targetId) {
              void goSection(h.sectionIndex, { paraIndex: h.paragraphIndex });
            }
          }}
          onClose={() => {
            setExcerptsOpen(false);
            void refreshAnnotations();
          }}
        />
      )}
      {exportOpen && worldId && (
        <NovelExportSheet
          worldId={worldId}
          lineId={lineId}
          worldTitle={bookTitle}
          onClose={() => setExportOpen(false)}
        />
      )}
      {cardContent && <CardSheet content={cardContent} onClose={() => setCardContent(null)} />}
    </div>
  );
}
