import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { buildNovelBook, type NovelBook, type NovelParagraph } from "../../engine/novel";
import { recordReadingSeconds, saveWorldNovelToLibrary } from "../../engine/reader/shelf";
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
  getBookHeader,
  listBookSectionsFast,
  listBookToc,
  readBookSection,
  searchBookFullText,
  type BookSectionContent,
  type BookTocItem,
} from "../../engine/sources/library";
import { PAPER_TONES, resolvedTheme, useApp, useBack, type ReaderRouteProps } from "../app/context";
import { localFind } from "../app/localFind";
import { buzz, motionOn } from "../app/motion";
import { ChapterOrnament, EmptyVignette, TitleCartouche } from "../components/ChineseArt";
import { ExcerptsSheet } from "../components/ExcerptsSheet";
import { Icon } from "../components/Icon";
import { NovelExportSheet } from "../components/NovelExportSheet";
import { Paginator, type PaginatorHandle } from "../components/Paginator";
import { CardSheet, SEPARATOR, type CardContent } from "../components/ShareCard";
import { Sheet } from "../components/Sheet";
import { useMouse } from "../components/useMedia";
import { useShortcuts } from "../components/useShortcuts";
import { ReadingQuickSheet } from "./play/ReadingQuick";
import { ReaderAskSheet } from "./reader/ReaderAskSheet";
import { ReaderResplitSheet } from "./reader/ReaderResplitSheet";
import { TTS_RATES, TTS_SLEEP_OPTIONS, formatSleepRemaining, useReaderTts } from "./reader/readerTts";
import "./reader.css";

interface UnifiedTocItem {
  index: number;
  title: string;
  subtitle?: string;
  chars: number;
  locked?: boolean;
}

interface SelectionAnchorRect {
  top: number;
  bottom: number;
  centerX: number;
}

interface SelectionDraft {
  paragraphIndex: number;
  charStart: number;
  charEnd: number;
  selectedText: string;
  nodeId: string | null;
  anchorRect?: SelectionAnchorRect | null;
}

interface SearchResultRow {
  sectionIndex: number;
  sectionTitle: string;
  paragraphIndex: number;
  snippet: { before: string; hit: string; after: string };
}

interface JumpUndoState {
  sectionIndex: number;
  page: number;
  scrollRatio: number;
  title: string;
}

interface AskSheetState {
  selectedText: string;
  contextParagraphs: string[];
}

const SECTION_CACHE_LIMIT = 5;
const AUTO_READ_PAGE_MS = [18_000, 13_000, 9_500, 6_800, 4_600] as const;
const AUTO_READ_SCROLL_PX_PER_SEC = [18, 28, 42, 60, 84] as const;

const BASE_BAR_COLORS = {
  scroll: { paper: "#efe5cf", day: "#faf7f0", night: "#131518" },
  ink: { paper: "#f7f5f0", day: "#fbfaf7", night: "#121212" },
} as const;

const HIGHLIGHT_COLORS: { id: HighlightColor; label: string; hex: string }[] = [
  { id: "cinnabar", label: "朱砂", hex: "#b33b2a" },
  { id: "amber", label: "藤黄", hex: "#c88a22" },
  { id: "bamboo", label: "竹青", hex: "#3f7a58" },
];

/**
 * Pure helper computing character-weighted total book progress percentage (`0`..`100`, 1 decimal).
 * Returns `null` when TOC is empty.
 */
export function computeBookProgressPct(
  toc: { chars: number }[],
  sectionIndex: number,
  intraRatio = 0,
): number | null {
  if (!toc.length) return null;
  const sec = Math.max(0, Math.min(toc.length - 1, Math.trunc(sectionIndex)));
  const intra = Number.isFinite(intraRatio) ? Math.min(1, Math.max(0, intraRatio)) : 0;
  const rawSum = toc.reduce((acc, item) => acc + Math.max(0, item.chars || 0), 0);
  const weights = rawSum > 0 ? toc.map((item) => Math.max(1, item.chars || 0)) : toc.map(() => 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let before = 0;
  for (let i = 0; i < sec; i++) {
    before += weights[i]!;
  }
  const progressed = before + weights[sec]! * intra;
  const pct = (progressed / Math.max(1, total)) * 100;
  return Math.min(100, Math.max(0, Number(pct.toFixed(1))));
}

const CHARS_PER_MINUTE = 420;

/**
 * Pure helper estimating remaining chapter reading time at ~420 Chinese chars/minute.
 * - Returns `null` when chapter has 0 chars and not at end.
 * - Returns `"本章末"` when `isAtEnd` is true or `intraRatio >= 1`.
 * - Returns `"剩 <1 分钟"` when remaining chars < 420, otherwise `"剩 X 分钟"`.
 */
export function computeReadingEtaText(
  chapterChars: number,
  intraRatio: number,
  isAtEnd = false,
): string | null {
  if (isAtEnd) return "本章末";
  if (!Number.isFinite(chapterChars) || chapterChars <= 0) return null;
  const clamped = Number.isFinite(intraRatio) ? Math.min(1, Math.max(0, intraRatio)) : 0;
  if (clamped >= 0.995) return "本章末";
  const remainingChars = Math.max(0, (1 - clamped) * chapterChars);
  if (remainingChars <= 0) return "本章末";
  const mins = remainingChars / CHARS_PER_MINUTE;
  if (mins < 1) return "剩 <1 分钟";
  return `剩 ${Math.max(1, Math.round(mins))} 分钟`;
}

function measureSelectionAnchor(
  paraEl: HTMLElement,
  rangeRect?: DOMRect | null,
  point?: { x: number; y: number },
): SelectionAnchorRect {
  const vw = typeof window !== "undefined" ? window.innerWidth || 390 : 390;
  if (
    rangeRect &&
    (rangeRect.width > 0 || rangeRect.height > 0) &&
    rangeRect.right > 4 &&
    rangeRect.left < vw - 4
  ) {
    return {
      top: rangeRect.top,
      bottom: rangeRect.bottom,
      centerX: rangeRect.left + rangeRect.width / 2,
    };
  }
  const clientRects = Array.from(paraEl.getClientRects()).filter(
    (r) => r.width > 0 && r.height > 0 && r.right > 4 && r.left < vw - 4,
  );
  if (clientRects.length > 0) {
    let chosen = clientRects[0]!;
    if (point) {
      let bestDist = Infinity;
      for (const r of clientRects) {
        const dy = point.y < r.top ? r.top - point.y : point.y > r.bottom ? point.y - r.bottom : 0;
        if (dy < bestDist) {
          bestDist = dy;
          chosen = r;
        }
      }
    }
    return {
      top: chosen.top,
      bottom: chosen.bottom,
      centerX: chosen.left + chosen.width / 2,
    };
  }
  const fallback = paraEl.getBoundingClientRect();
  return {
    top: fallback.top,
    bottom: fallback.bottom,
    centerX: fallback.left + fallback.width / 2,
  };
}

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
  initialParagraph,
  initialNodeId,
  through: propThrough,
}: ReaderRouteProps & { initialParagraph?: number }) {
  const { game, pop, push, reading, setReading, toast, ask } = useApp();
  const targetType: ReaderTargetType = bookId ? "book" : "world_novel";
  const targetId = bookId ?? worldId ?? "";

  const [bookTitle, setBookTitle] = useState("正在打开书卷…");
  const [bookFormat, setBookFormat] = useState("");
  const [toc, setToc] = useState<UnifiedTocItem[]>([]);
  const [novelBook, setNovelBook] = useState<NovelBook | null>(null);
  const [sectionIndex, setSectionIndex] = useState(initialSection ?? 0);
  const [jumpNonce, setJumpNonce] = useState(0);
  const [entryPage, setEntryPage] = useState<number | "last">(0);
  const [entrySelector, setEntrySelector] = useState<string | null>(
    initialParagraph !== undefined
      ? `[data-para-index="${initialParagraph}"]`
      : initialNodeId
        ? `[data-node-id="${CSS.escape(initialNodeId)}"]`
        : null,
  );
  const [pendingScrollRatio, setPendingScrollRatio] = useState<number | null>(null);
  const [pendingFlashPara, setPendingFlashPara] = useState<number | null>(
    initialParagraph !== undefined ? initialParagraph : null,
  );
  const [bookSection, setBookSection] = useState<BookSectionContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [spoilerCeiling, setSpoilerCeiling] = useState<number | null>(propThrough ?? null);
  const [spoilerUnlocked, setSpoilerUnlocked] = useState(false);

  const [bookmarks, setBookmarks] = useState<ReaderBookmark[]>([]);
  const [highlights, setHighlights] = useState<ReaderHighlight[]>([]);
  const [hudHidden, setHudHidden] = useState(true);
  const [drawerTab, setDrawerTab] = useState<"toc" | "bookmarks" | "search" | null>(null);
  const [tocFilter, setTocFilter] = useState("");
  const [tocRange, setTocRange] = useState<{ start: number; end: number }>({ start: 0, end: 160 });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchResultRow[]>([]);
  const [searching, setSearching] = useState(false);

  const [readingSheet, setReadingSheet] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [excerptsOpen, setExcerptsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [resplitOpen, setResplitOpen] = useState(false);
  const [askSheetState, setAskSheetState] = useState<AskSheetState | null>(null);
  const [selection, setSelection] = useState<SelectionDraft | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<ReaderHighlight | null>(null);
  const [noteInput, setNoteInput] = useState("");
  const [newNoteSheet, setNewNoteSheet] = useState<{ draft: SelectionDraft; color: HighlightColor } | null>(null);
  const [cardContent, setCardContent] = useState<CardContent | null>(null);

  // Page/scroll progress, slider scrub preview, 8s jump-undo, ribbon animation, auto-read & TTS
  const [pageStats, setPageStats] = useState<{ page: number; totalPages: number }>({ page: 0, totalPages: 1 });
  const [scrollRatio, setScrollRatio] = useState(0);
  const [scrubSection, setScrubSection] = useState<number | null>(null);
  const [jumpUndo, setJumpUndo] = useState<JumpUndoState | null>(null);
  const [ribbonDropKey, setRibbonDropKey] = useState(0);
  const [shelvingBusy, setShelvingBusy] = useState(false);
  const [shelvedBookId, setShelvedBookId] = useState<string | null>(null);

  const [ttsOpen, setTtsOpen] = useState(false);
  const [ttsTimerOpen, setTtsTimerOpen] = useState(false);
  const [autoRead, setAutoRead] = useState<{ active: boolean; paused: boolean; speed: 1 | 2 | 3 | 4 | 5 }>({
    active: false,
    paused: false,
    speed: 3,
  });
  const [autoReadProgress, setAutoReadProgress] = useState<number | null>(null);

  const [brightnessHud, setBrightnessHud] = useState<number | null>(null);
  const [docVisible, setDocVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

  const sectionCache = useRef<Map<number, BookSectionContent>>(new Map());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const proseRef = useRef<HTMLDivElement>(null);
  const paginatorRef = useRef<PaginatorHandle>(null);
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProgressRef = useRef<Parameters<typeof saveReaderProgress>[1] | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const jumpUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const brightnessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sliderPointerDownRef = useRef(false);
  const lastReportedPageRef = useRef<{ section: number; page: number } | null>(null);
  const lastVisibleParaRef = useRef(initialParagraph ?? 0);
  const prevPageModeRef = useRef(reading.pageMode);
  const modeSwitchRestoreRef = useRef(false);
  const programmaticScrollUntilRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const mouse = useMouse();
  const readingRef = useRef(reading);
  readingRef.current = reading;
  const tocRef = useRef(toc);
  tocRef.current = toc;

  useBack(() => {
    if (selection) {
      window.getSelection?.()?.removeAllRanges();
      setSelection(null);
      return true;
    }
    if (ttsTimerOpen) {
      setTtsTimerOpen(false);
      return true;
    }
    if (autoRead.active) {
      setAutoRead((prev) => ({ ...prev, active: false, paused: false }));
      setAutoReadProgress(null);
      return true;
    }
    if (!hudHidden) {
      setHudHidden(true);
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

  // Track document visibility, app resume & window blur/focus for volume-key release and accurate reading stats
  useEffect(() => {
    const syncVis = () => {
      setDocVisible(document.visibilityState === "visible" && document.hasFocus?.() !== false);
    };
    const onBlur = () => setDocVisible(false);
    const onFocusOrResume = () => setDocVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", syncVis);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocusOrResume);
    window.addEventListener("lishi:app-resume", onFocusOrResume);
    return () => {
      document.removeEventListener("visibilitychange", syncVis);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocusOrResume);
      window.removeEventListener("lishi:app-resume", onFocusOrResume);
    };
  }, []);

  // Sync :root[data-reader-tone] so portaled Sheets, MenuSheets, Dialogs, and Toasts inherit active paper tone
  useEffect(() => {
    const root = document.documentElement;
    if (reading.paperTone !== "default") {
      root.dataset.readerTone = reading.paperTone;
    } else {
      delete root.dataset.readerTone;
    }
    return () => {
      delete root.dataset.readerTone;
    };
  }, [reading.paperTone]);

  // Sync Android system bars with active eye-care paper tone, and restore app theme bar on unmount
  useEffect(() => {
    const baseTheme = resolvedTheme(reading.theme);
    const tone = PAPER_TONES.find((t) => t.id === reading.paperTone);
    const toneBg = tone?.id === "oled" ? "#000000" : tone?.bg;
    const bg = tone && tone.id !== "default" && toneBg ? toneBg : BASE_BAR_COLORS[reading.style][baseTheme];
    const dark = tone && tone.id !== "default" ? tone.dark : baseTheme === "night";
    void game.platform.system.setSystemBars(bg, dark).catch(() => {});
  }, [game.platform.system, reading.paperTone, reading.style, reading.theme]);

  useEffect(
    () => () => {
      const r = readingRef.current;
      const baseTheme = resolvedTheme(r.theme);
      void game.platform.system
        .setSystemBars(BASE_BAR_COLORS[r.style][baseTheme], baseTheme === "night")
        .catch(() => {});
    },
    [game.platform.system],
  );

  // Active reading duration tracker: flushes every 30s + on pause/unmount
  useEffect(() => {
    if (!targetId || loading || !!error) return;
    let lastMark = Date.now();
    const flush = () => {
      const now = Date.now();
      const elapsedSec = Math.floor((now - lastMark) / 1000);
      lastMark = now;
      if (elapsedSec >= 2) {
        void recordReadingSeconds(game.repo, targetType, targetId, elapsedSec).catch(() => {});
      }
    };
    if (!docVisible) {
      lastMark = Date.now();
      return;
    }
    const timer = setInterval(flush, 30_000);
    return () => {
      clearInterval(timer);
      flush();
    };
  }, [docVisible, error, game.repo, loading, targetId, targetType]);

  const hasOverlayOpen =
    drawerTab !== null ||
    readingSheet ||
    shortcutsOpen ||
    excerptsOpen ||
    exportOpen ||
    resplitOpen ||
    askSheetState !== null ||
    newNoteSheet !== null ||
    activeHighlight !== null ||
    cardContent !== null;

  const volumeTurnActive = reading.volumeKeyTurn && !hasOverlayOpen && docVisible && !loading && !error;

  // Sync Android hardware volume-key interception & immediately restore on notification-shade / foreground resume
  useEffect(() => {
    const sync = () => {
      void game.platform.system.setVolumePageTurn?.(volumeTurnActive).catch(() => {});
    };
    sync();
    window.addEventListener("lishi:app-resume", sync);
    window.addEventListener("focus", sync);
    return () => {
      window.removeEventListener("lishi:app-resume", sync);
      window.removeEventListener("focus", sync);
      void game.platform.system.setVolumePageTurn?.(false).catch(() => {});
    };
  }, [game.platform.system, volumeTurnActive]);

  const refreshAnnotations = useCallback(async () => {
    if (!targetId) return;
    const [bms, hls] = await Promise.all([
      listReaderBookmarks(game.repo, targetType, targetId),
      listReaderHighlights(game.repo, { targetType, targetId }),
    ]);
    setBookmarks(bms);
    setHighlights(hls);
  }, [game.repo, targetId, targetType]);

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

  // Initial load of book / world novel + saved reading progress.
  // Stage 1 loads ONLY lightweight headers + the single active chapter so multi-thousand-chapter
  // novels paint in <15ms; Stage 2 hydrates per-chapter char weights & annotations in background.
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
          const [header, fastSecs, saved] = await Promise.all([
            getBookHeader(game.repo, bookId),
            listBookSectionsFast(game.repo, bookId),
            initialSection === undefined && initialParagraph === undefined
              ? getReaderProgress(game.repo, "book", bookId)
              : Promise.resolve(null),
          ]);
          if (!live) return;
          if (!header || !fastSecs.length) {
            setError("这本书暂时无法打开，可能已被移除。");
            setLoading(false);
            return;
          }
          const maxInitial =
            effectiveThrough != null ? Math.min(fastSecs.length - 1, effectiveThrough) : fastSecs.length - 1;
          const startSec = Math.max(
            0,
            Math.min(
              fastSecs.length - 1,
              initialSection ?? Math.min(saved?.sectionIndex ?? 0, maxInitial),
            ),
          );
          const firstChapter = await fetchSectionCached(startSec);
          if (!live) return;
          setSpoilerCeiling(effectiveThrough);
          setBookTitle(header.title);
          setBookFormat(header.format.toLowerCase());
          setToc(
            fastSecs.map((item) => ({
              index: item.section,
              title: item.title || `第 ${item.section + 1} 节`,
              chars: firstChapter && item.section === startSec ? firstChapter.text.length : 0,
              locked: effectiveThrough != null && item.section > effectiveThrough,
            })),
          );
          setSectionIndex(startSec);
          setBookSection(firstChapter);
          if (initialParagraph !== undefined) {
            setEntryPage(0);
            setEntrySelector(`[data-para-index="${initialParagraph}"]`);
            setPendingFlashPara(initialParagraph);
            setPendingScrollRatio(null);
            setJumpNonce((n) => n + 1);
          } else if (saved && initialSection === undefined && saved.sectionIndex === startSec) {
            setEntryPage(saved.pageIndex);
            setPendingScrollRatio(saved.scrollRatio);
          }
          setLoading(false);

          // Stage 2: non-blocking background hydration of char counts & annotations
          void Promise.all([
            listBookToc(game.repo, bookId).then((fullToc: BookTocItem[]) => {
              if (!live || !fullToc.length) return;
              setToc(
                fullToc.map((item) => ({
                  index: item.section,
                  title: item.title || `第 ${item.section + 1} 节`,
                  chars: item.chars,
                  locked: effectiveThrough != null && item.section > effectiveThrough,
                })),
              );
            }),
            refreshAnnotations(),
          ]).catch(() => {});
          return;
        } else if (worldId) {
          const [built, saved] = await Promise.all([
            buildNovelBook(game.repo, worldId, {
              lineId,
              includePreface: true,
              includeChronicle: true,
              includeActions: false,
            }),
            initialSection === undefined && initialParagraph === undefined && !initialNodeId
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
          setBookFormat("novel");
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
          if (initialParagraph !== undefined) {
            setEntryPage(0);
            setEntrySelector(`[data-para-index="${initialParagraph}"]`);
            setPendingFlashPara(initialParagraph);
            setPendingScrollRatio(null);
            setJumpNonce((n) => n + 1);
          } else if (initialNodeId) {
            setEntrySelector(`[data-node-id="${CSS.escape(initialNodeId)}"]`);
            setJumpNonce((n) => n + 1);
          } else if (saved && initialSection === undefined && saved.sectionIndex === startSec) {
            setEntryPage(saved.pageIndex);
            setPendingScrollRatio(saved.scrollRatio);
          }
          await refreshAnnotations();
        }
      } catch (e: unknown) {
        if (live) setError(e instanceof Error ? e.message : "读取书卷失败");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [
    bookId,
    fetchSectionCached,
    game.repo,
    initialNodeId,
    initialParagraph,
    initialSection,
    lineId,
    propThrough,
    refreshAnnotations,
    worldId,
  ]);

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

  const reloadAfterResplit = useCallback(async () => {
    if (!bookId) return;
    setJumpUndo(null);
    sectionCache.current.clear();
    const [rawToc, prog] = await Promise.all([
      listBookToc(game.repo, bookId),
      getReaderProgress(game.repo, "book", bookId).catch(() => null),
    ]);
    await refreshAnnotations();
    if (!rawToc.length) return;
    setToc(
      rawToc.map((item) => ({
        index: item.section,
        title: item.title || `第 ${item.section + 1} 节`,
        chars: item.chars,
        locked: spoilerCeiling != null && item.section > spoilerCeiling,
      })),
    );
    const targetSec = prog ? prog.sectionIndex : sectionIndex;
    const clampedSec = Math.max(0, Math.min(rawToc.length - 1, targetSec));
    setEntrySelector(null);
    setEntryPage(0);
    setPendingScrollRatio(prog && prog.sectionIndex === clampedSec ? prog.scrollRatio : 0);
    setJumpNonce((n) => n + 1);
    setSectionIndex(clampedSec);
    const fresh = await fetchSectionCached(clampedSec);
    setBookSection(fresh);
  }, [bookId, fetchSectionCached, game.repo, refreshAnnotations, sectionIndex, spoilerCeiling]);

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

  const intraProgressRatio =
    reading.pageMode === "paged"
      ? pageStats.totalPages <= 1
        ? 1
        : (pageStats.page + 1) / pageStats.totalPages
      : scrollRatio;

  const currentChapterChars = useMemo(() => {
    const tocChars = toc[sectionIndex]?.chars ?? 0;
    if (tocChars > 0) return tocChars;
    if (!currentSection) return 0;
    return currentSection.paragraphs.reduce(
      (sum, p) => sum + (p.kind === "divider" ? 0 : p.text.length),
      0,
    );
  }, [currentSection, sectionIndex, toc]);

  const isAtChapterEnd =
    reading.pageMode === "paged"
      ? pageStats.totalPages <= 1 || pageStats.page >= pageStats.totalPages - 1
      : scrollRatio >= 0.98;

  const readingEtaText = useMemo(
    () => computeReadingEtaText(currentChapterChars, intraProgressRatio, isAtChapterEnd),
    [currentChapterChars, intraProgressRatio, isAtChapterEnd],
  );

  const nextChapterTailHint = useMemo(() => {
    const nextItem = toc[sectionIndex + 1];
    if (!nextItem) return null;
    const locked = !spoilerUnlocked && spoilerCeiling != null && nextItem.index > spoilerCeiling;
    if (locked) {
      return `下一节：第 ${nextItem.index + 1} 节（防剧透保护中）`;
    }
    const estMins = Math.max(1, Math.round((nextItem.chars || CHARS_PER_MINUTE) / CHARS_PER_MINUTE));
    return `下一节：〈${nextItem.title}〉（约 ${estMins} 分钟）`;
  }, [sectionIndex, spoilerCeiling, spoilerUnlocked, toc]);

  const bookProgressPct = useMemo(
    () => computeBookProgressPct(toc, sectionIndex, intraProgressRatio),
    [intraProgressRatio, sectionIndex, toc],
  );

  const currentSectionRef = useRef(currentSection);
  currentSectionRef.current = currentSection;

  const getCurrentParagraphIndex = useCallback((): number => {
    if (readingRef.current.pageMode === "paged") {
      const raw = paginatorRef.current?.currentAnchorId("data-para-index");
      const parsed = raw != null ? Number(raw) : NaN;
      if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
      return lastVisibleParaRef.current;
    }
    const scroller = scrollerRef.current;
    if (!scroller) return lastVisibleParaRef.current;
    const scrollerRect = scroller.getBoundingClientRect();
    if (scrollerRect.height <= 0) return lastVisibleParaRef.current;
    const probeY = scrollerRect.top + Math.min(96, Math.max(24, scrollerRect.height * 0.18));
    const paras = scroller.querySelectorAll<HTMLElement>("[data-para-index]");
    if (!paras.length) return 0;
    let lo = 0;
    let hi = paras.length - 1;
    let ans = paras.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = paras[mid]!.getBoundingClientRect();
      if (r.bottom >= probeY) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    const rawIdx = Number(paras[ans]!.dataset.paraIndex ?? 0);
    return Number.isFinite(rawIdx) && rawIdx >= 0 ? Math.trunc(rawIdx) : 0;
  }, []);

  // Restore reading position when switching between `paged` and `scroll` modes
  useLayoutEffect(() => {
    if (prevPageModeRef.current === reading.pageMode) return;
    prevPageModeRef.current = reading.pageMode;
    const pIdx = lastVisibleParaRef.current;
    modeSwitchRestoreRef.current = true;
    setEntrySelector(`[data-para-index="${pIdx}"]`);
    if (reading.pageMode === "paged") {
      setJumpNonce((n) => n + 1);
    } else {
      setPendingScrollRatio(scrollRatio);
    }
  }, [reading.pageMode, scrollRatio]);

  // Dismiss selection popover on outside pointerdown
  useEffect(() => {
    if (!selection) return;
    const onOutsidePointerDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest(".reader-selection-bar")) return;
      setSelection(null);
    };
    document.addEventListener("pointerdown", onOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", onOutsidePointerDown, true);
  }, [selection]);

  // Flash jumped paragraph in paged mode
  useEffect(() => {
    if (reading.pageMode !== "paged" || !currentSection || pendingFlashPara === null) return;
    const raf = requestAnimationFrame(() => {
      const el = proseRef.current?.querySelector<HTMLElement>(`[data-para-index="${pendingFlashPara}"]`);
      if (el) {
        el.classList.add("toc-flash");
        setTimeout(() => el.classList.remove("toc-flash"), 1600);
      }
      setPendingFlashPara(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [currentSection, jumpNonce, pendingFlashPara, reading.pageMode]);

  const resolveAnchorText = useCallback((nextSection: number, preferredParaIdx?: number): string => {
    const cur = currentSectionRef.current;
    if (cur && cur.index === nextSection) {
      const candidate =
        (preferredParaIdx !== undefined ? cur.paragraphs[preferredParaIdx] : undefined) ??
        cur.paragraphs.find((p) => p.kind !== "divider" && p.text.trim()) ??
        cur.paragraphs[0];
      if (candidate?.text) return candidate.text.slice(0, 36);
    }
    return tocRef.current[nextSection]?.title ?? "";
  }, []);

  const scheduleSaveProgress = useCallback(
    (
      nextSection: number,
      pageIndex: number,
      ratio: number,
      nodeId: string | null = null,
      preferredParaIdx?: number,
    ) => {
      if (!targetId) return;
      const payload: Parameters<typeof saveReaderProgress>[1] = {
        targetType,
        targetId,
        sectionIndex: nextSection,
        pageIndex,
        scrollRatio: ratio,
        anchorText: resolveAnchorText(nextSection, preferredParaIdx),
        nodeId,
      };
      pendingProgressRef.current = payload;
      if (progressTimer.current) clearTimeout(progressTimer.current);
      progressTimer.current = setTimeout(() => {
        progressTimer.current = null;
        const latest = pendingProgressRef.current;
        if (!latest) return;
        pendingProgressRef.current = null;
        const freshAnchor = resolveAnchorText(latest.sectionIndex, preferredParaIdx) || latest.anchorText;
        void saveReaderProgress(game.repo, { ...latest, anchorText: freshAnchor }).catch(() => {});
      }, 360);
    },
    [game.repo, resolveAnchorText, targetId, targetType],
  );

  useEffect(
    () => () => {
      if (progressTimer.current) {
        clearTimeout(progressTimer.current);
        progressTimer.current = null;
      }
      if (pendingProgressRef.current) {
        const pending = pendingProgressRef.current;
        pendingProgressRef.current = null;
        const freshAnchor = resolveAnchorText(pending.sectionIndex) || pending.anchorText;
        void saveReaderProgress(game.repo, { ...pending, anchorText: freshAnchor }).catch(() => {});
      }
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      if (jumpUndoTimerRef.current) clearTimeout(jumpUndoTimerRef.current);
      if (brightnessTimerRef.current) clearTimeout(brightnessTimerRef.current);
    },
    [game.repo, resolveAnchorText],
  );

  const armJumpUndo = useCallback(() => {
    const curTitle = currentSection?.title ?? `第 ${sectionIndex + 1} 节`;
    setJumpUndo({
      sectionIndex,
      page: pageStats.page,
      scrollRatio,
      title: curTitle,
    });
    if (jumpUndoTimerRef.current) clearTimeout(jumpUndoTimerRef.current);
    jumpUndoTimerRef.current = setTimeout(() => {
      setJumpUndo(null);
    }, 8000);
  }, [currentSection?.title, pageStats.page, scrollRatio, sectionIndex]);

  // Restore scroll position or flash jumped paragraph in scroll mode
  useEffect(() => {
    if (reading.pageMode !== "scroll" || !currentSection) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    programmaticScrollUntilRef.current = performance.now() + 280;
    requestAnimationFrame(() => {
      programmaticScrollUntilRef.current = performance.now() + 280;
      if (pendingFlashPara !== null) {
        const el = scroller.querySelector<HTMLElement>(`[data-para-index="${pendingFlashPara}"]`);
        if (el) {
          el.scrollIntoView({ block: "center" });
          el.classList.add("toc-flash");
          setTimeout(() => el.classList.remove("toc-flash"), 1600);
        }
        lastScrollTopRef.current = scroller.scrollTop;
        setPendingFlashPara(null);
        return;
      }
      if (entrySelector) {
        const isModeRestore = modeSwitchRestoreRef.current;
        modeSwitchRestoreRef.current = false;
        const el = scroller.querySelector<HTMLElement>(entrySelector);
        if (el) {
          el.scrollIntoView({ block: isModeRestore ? "start" : "center" });
          if (!isModeRestore) {
            el.classList.add("toc-flash");
            setTimeout(() => el.classList.remove("toc-flash"), 1600);
          }
        }
        lastScrollTopRef.current = scroller.scrollTop;
        setEntrySelector(null);
        return;
      }
      if (pendingScrollRatio !== null && pendingScrollRatio > 0) {
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = Math.round(maxScroll * pendingScrollRatio);
        lastScrollTopRef.current = scroller.scrollTop;
        setPendingScrollRatio(null);
      } else {
        scroller.scrollTop = 0;
        lastScrollTopRef.current = 0;
        setScrollRatio(0);
      }
    });
  }, [currentSection, entrySelector, pendingFlashPara, pendingScrollRatio, reading.pageMode]);

  const goSection = useCallback(
    async (
      targetSec: number,
      opts?: { page?: number | "last"; paraIndex?: number; selector?: string; scrollRatio?: number; recordUndo?: boolean },
    ): Promise<boolean> => {
      if (!toc.length || targetSec < 0 || targetSec >= toc.length) return false;
      const clamped = Math.max(0, Math.min(toc.length - 1, targetSec));
      if (bookId && spoilerCeiling != null && clamped > spoilerCeiling && !spoilerUnlocked) {
        const ok = await ask({
          title: "超出本局防剧透范围",
          message: `本局当前设定的参考范围截至第 ${spoilerCeiling + 1} 节。提前翻阅第 ${clamped + 1} 节可能会看到后续原著剧情，确定要先看吗？`,
          confirm: "继续翻阅",
        });
        if (!ok) return false;
        setSpoilerUnlocked(true);
      }
      if (opts?.recordUndo && (clamped !== sectionIndex || opts.paraIndex !== undefined)) {
        armJumpUndo();
        setHudHidden(true);
      } else if (!opts?.recordUndo) {
        if (jumpUndoTimerRef.current) clearTimeout(jumpUndoTimerRef.current);
        setJumpUndo(null);
      }
      setSelection(null);
      setEntryPage(opts?.page ?? 0);
      setEntrySelector(
        opts?.selector ??
          (opts?.paraIndex !== undefined ? `[data-para-index="${opts.paraIndex}"]` : null),
      );
      lastVisibleParaRef.current = opts?.paraIndex ?? 0;
      if (opts?.paraIndex !== undefined) setPendingFlashPara(opts.paraIndex);
      setPendingScrollRatio(opts?.scrollRatio ?? null);
      setJumpNonce((n) => n + 1);
      setSectionIndex(clamped);
      scheduleSaveProgress(
        clamped,
        typeof opts?.page === "number" ? opts.page : 0,
        opts?.scrollRatio ?? 0,
        null,
        opts?.paraIndex,
      );
      return true;
    },
    [armJumpUndo, ask, bookId, scheduleSaveProgress, sectionIndex, spoilerCeiling, spoilerUnlocked, toc.length],
  );

  // Scroll-mode hardware volume-key handler
  useEffect(() => {
    if (!volumeTurnActive || reading.pageMode !== "scroll") return;
    const onVolumeScroll = (ev: Event) => {
      if (document.querySelector(".sheet-layer, .dialog, .panel:not(.docked)")) return;
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.tagName === "SELECT" ||
          active.isContentEditable)
      ) {
        return;
      }
      const detail = (ev as CustomEvent<"prev" | "next">).detail;
      if (detail !== "prev" && detail !== "next") return;
      setAutoRead((prev) => (prev.active && !prev.paused ? { ...prev, paused: true } : prev));
      const el = scrollerRef.current;
      if (!el) return;
      const stepPx = Math.max(120, Math.round(el.clientHeight * 0.85));
      if (detail === "prev") {
        if (el.scrollTop <= 4) {
          if (sectionIndex > 0) void goSection(sectionIndex - 1);
          else toast("已经是第一章了");
        } else {
          el.scrollBy({ top: -stepPx, behavior: motionOn() ? "smooth" : "auto" });
        }
      } else {
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 6) {
          if (sectionIndex < toc.length - 1) void goSection(sectionIndex + 1);
          else toast("已经读到最后一章了");
        } else {
          el.scrollBy({ top: stepPx, behavior: motionOn() ? "smooth" : "auto" });
        }
      }
    };
    window.addEventListener("lishi:volume-page", onVolumeScroll);
    return () => window.removeEventListener("lishi:volume-page", onVolumeScroll);
  }, [goSection, reading.pageMode, sectionIndex, toast, toc.length, volumeTurnActive]);

  // Offline dual-engine TTS audiobook controller
  const focusSpokenParagraph = useCallback(
    (pIdx: number) => {
      if (reading.pageMode === "paged") {
        paginatorRef.current?.jumpToSelector(`[data-para-index="${pIdx}"]`);
      } else {
        programmaticScrollUntilRef.current = performance.now() + 450;
        const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-para-index="${pIdx}"]`);
        el?.scrollIntoView({ behavior: motionOn() ? "smooth" : "auto", block: "center" });
      }
    },
    [reading.pageMode],
  );

  const tts = useReaderTts({
    platform: game.platform,
    paragraphs: currentSection?.paragraphs ?? [],
    sectionIndex,
    onParagraphFocus: focusSpokenParagraph,
    onSectionEnd: async () => {
      if (sectionIndex < toc.length - 1) {
        return await goSection(sectionIndex + 1, { page: 0 });
      }
      toast("整本书已朗读完毕");
      return false;
    },
    toast,
  });

  // Auto-page / Auto-scroll controller
  const pauseAutoReadOnTouch = useCallback(() => {
    setAutoRead((prev) => {
      if (!prev.active || prev.paused) return prev;
      return { ...prev, paused: true };
    });
    setAutoReadProgress(null);
  }, []);

  useEffect(() => {
    if (!autoRead.active || autoRead.paused || hasOverlayOpen || !docVisible || !currentSection) {
      setAutoReadProgress(null);
      return;
    }

    if (reading.pageMode === "paged") {
      const durationMs = AUTO_READ_PAGE_MS[autoRead.speed - 1];
      let startedAt = performance.now();
      const timer = setInterval(() => {
        const elapsed = performance.now() - startedAt;
        const pct = Math.min(100, (elapsed / durationMs) * 100);
        if (pct >= 100) {
          startedAt = performance.now();
          setAutoReadProgress(0);
          const p = paginatorRef.current;
          if (!p) return;
          if (p.page >= p.totalPages - 1) {
            if (sectionIndex >= toc.length - 1) {
              setAutoRead((prev) => ({ ...prev, active: false, paused: false }));
              setAutoReadProgress(null);
              toast("已自动读完全书");
              return;
            }
            if (bookId && !spoilerUnlocked && spoilerCeiling != null && sectionIndex + 1 > spoilerCeiling) {
              setAutoRead((prev) => ({ ...prev, paused: true }));
              setAutoReadProgress(null);
              toast(`已读至防剧透范围上限（第 ${spoilerCeiling + 1} 节），自动阅读已暂停`);
              return;
            }
            void goSection(sectionIndex + 1, { page: 0 });
            return;
          }
          p.stepBy(1);
        } else {
          setAutoReadProgress(pct);
        }
      }, 100);
      return () => {
        clearInterval(timer);
        setAutoReadProgress(null);
      };
    }

    // Smooth rAF auto-scroll in scroll mode with minimum chapter dwell time & spoilerCeiling guard
    const pxPerSec = AUTO_READ_SCROLL_PX_PER_SEC[autoRead.speed - 1];
    const minDwellMs = Math.max(2600, Math.round(AUTO_READ_PAGE_MS[autoRead.speed - 1] * 0.55));
    const chapterEnteredAt = performance.now();
    let rafId = 0;
    let lastTs = chapterEnteredAt;
    let subPixelCarry = 0;
    let advancing = false;

    const tick = (ts: number) => {
      const dt = Math.min(0.1, Math.max(0, (ts - lastTs) / 1000));
      lastTs = ts;
      const el = scrollerRef.current;
      if (el && !advancing) {
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
          if (ts - chapterEnteredAt >= minDwellMs) {
            if (sectionIndex >= toc.length - 1) {
              setAutoRead((prev) => ({ ...prev, active: false, paused: false }));
              toast("已自动读完全书");
              return;
            }
            if (bookId && !spoilerUnlocked && spoilerCeiling != null && sectionIndex + 1 > spoilerCeiling) {
              setAutoRead((prev) => ({ ...prev, paused: true }));
              toast(`已读至防剧透范围上限（第 ${spoilerCeiling + 1} 节），自动阅读已暂停`);
              return;
            }
            advancing = true;
            void goSection(sectionIndex + 1, { scrollRatio: 0 });
          }
        } else {
          subPixelCarry += pxPerSec * dt;
          const whole = Math.trunc(subPixelCarry);
          if (whole >= 1) {
            el.scrollTop += whole;
            subPixelCarry -= whole;
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [
    autoRead.active,
    autoRead.paused,
    autoRead.speed,
    bookId,
    currentSection,
    docVisible,
    goSection,
    hasOverlayOpen,
    reading.pageMode,
    sectionIndex,
    spoilerCeiling,
    spoilerUnlocked,
    toast,
    toc.length,
  ]);

  // Leftmost 16px bezel gesture: vertical swipe adjusts eye-care dim; quick tap flips prev page
  const bezelGestureRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    startTime: number;
    startDim: number;
    mode: "undecided" | "dim" | "horizontal";
  } | null>(null);

  const onBezelPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    bezelGestureRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startTime: performance.now(),
      startDim: reading.nightDim,
      mode: "undecided",
    };
  };

  const onBezelPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = bezelGestureRef.current;
    if (!g || g.id !== e.pointerId) return;
    e.stopPropagation();
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.mode === "undecided") {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx) * 1.2) {
        g.mode = "dim";
        if (brightnessTimerRef.current) clearTimeout(brightnessTimerRef.current);
      } else if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        g.mode = "horizontal";
        return;
      } else {
        return;
      }
    }
    if (g.mode !== "dim") return;
    // Dragging down increases nightDim (0..50); dragging up decreases nightDim toward 0
    const nextDim = Math.min(50, Math.max(0, Math.round(g.startDim + dy / 4.2)));
    setBrightnessHud(nextDim);
    if (nextDim !== readingRef.current.nightDim) {
      setReading({ ...readingRef.current, nightDim: nextDim });
    }
  };

  const finishBezelPointer = (e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const g = bezelGestureRef.current;
    if (!g || g.id !== e.pointerId) return;
    bezelGestureRef.current = null;
    e.stopPropagation();
    if (g.mode === "dim") {
      if (brightnessTimerRef.current) clearTimeout(brightnessTimerRef.current);
      brightnessTimerRef.current = setTimeout(() => setBrightnessHud(null), 900);
      return;
    }
    if (cancelled || reading.pageMode !== "paged") return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const dt = Math.max(1, performance.now() - g.startTime);
    if (g.mode === "horizontal" && (Math.abs(dx) >= 40 || Math.abs(dx) / dt > 0.38)) {
      pauseAutoReadOnTouch();
      paginatorRef.current?.stepBy(dx < 0 ? 1 : -1);
      return;
    }
    if (dt < 280 && Math.hypot(dx, dy) < 10) {
      pauseAutoReadOnTouch();
      paginatorRef.current?.stepBy(-1);
    }
  };

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
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    const pIdx = Number(startEl.dataset.paraIndex ?? 0);
    const fullText = currentSection?.paragraphs[pIdx]?.text ?? startEl.textContent ?? "";
    let charStart = 0;
    let charEnd = fullText.length;
    try {
      const preRange = document.createRange();
      preRange.selectNodeContents(startEl);
      preRange.setEnd(range.startContainer, range.startOffset);
      charStart = Math.max(0, Math.min(fullText.length, preRange.toString().length));
      if (startEl.contains(range.endContainer)) {
        const endRange = document.createRange();
        endRange.selectNodeContents(startEl);
        endRange.setEnd(range.endContainer, range.endOffset);
        charEnd = Math.max(charStart, Math.min(fullText.length, endRange.toString().length));
      } else {
        charEnd = fullText.length;
      }
      while (charStart < charEnd && /\s/.test(fullText[charStart] ?? "")) charStart++;
      while (charEnd > charStart && /\s/.test(fullText[charEnd - 1] ?? "")) charEnd--;
    } catch {
      charEnd = charStart;
    }
    if (charEnd <= charStart) {
      const pos = fullText.indexOf(raw);
      charStart = pos >= 0 ? pos : 0;
      charEnd = pos >= 0 ? pos + raw.length : Math.min(fullText.length, raw.length);
    }
    const anchorRect = measureSelectionAnchor(startEl, range.getBoundingClientRect());
    setSelection({
      paragraphIndex: pIdx,
      charStart,
      charEnd,
      selectedText: raw.slice(0, 1200),
      nodeId: startEl.dataset.nodeId ?? null,
      anchorRect,
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

  const openAskCompanionFromSelection = () => {
    if (!selection || !currentSection) return;
    const pIdx = selection.paragraphIndex;
    const contextParagraphs = currentSection.paragraphs
      .slice(Math.max(0, pIdx - 2), Math.min(currentSection.paragraphs.length, pIdx + 3))
      .filter((p) => p.kind !== "divider")
      .map((p) => p.text);
    setAskSheetState({
      selectedText: selection.selectedText,
      contextParagraphs,
    });
    window.getSelection?.()?.removeAllRanges();
    setSelection(null);
  };

  const toggleBookmark = async () => {
    if (!currentSection) return;
    if (sectionBookmark) {
      await removeReaderBookmark(game.repo, sectionBookmark.id);
      await refreshAnnotations();
      toast("已移除本章书签");
      return;
    }
    const paraIdx = getCurrentParagraphIndex();
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
    setRibbonDropKey((k) => k + 1);
    buzz(game.platform);
    await refreshAnnotations();
    toast("已夹入朱砂书签");
  };

  const handleSaveToLibrary = async () => {
    if (!worldId || shelvingBusy) return;
    if (shelvedBookId) {
      push({ name: "reader", bookId: shelvedBookId });
      return;
    }
    setShelvingBusy(true);
    try {
      const saved = await saveWorldNovelToLibrary(game.repo, worldId, { lineId });
      setShelvedBookId(saved.bookId);
      buzz(game.platform);
      toast(`已收入书斋：《${saved.title}》（共 ${saved.sectionCount} 章）`, {
        label: "去翻阅",
        run: () => push({ name: "reader", bookId: saved.bookId }),
      });
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "收入书斋失败");
    } finally {
      setShelvingBusy(false);
    }
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
        const isSpeaking = tts.status !== "idle" && tts.speakingIndex === pIdx;
        const isSelected = selection?.paragraphIndex === pIdx;
        return (
          <Fragment key={pIdx}>
            <p
              className={`reader-para is-${para.kind}${isSpeaking ? " is-speaking" : ""}${isSelected ? " is-selected" : ""}`}
              data-para-index={pIdx}
              data-node-id={para.nodeId ?? undefined}
              onContextMenu={(e) => {
                const existingSel = window.getSelection?.()?.toString().trim();
                if (existingSel) return;
                e.preventDefault();
                const anchorRect = measureSelectionAnchor(e.currentTarget, null, {
                  x: e.clientX,
                  y: e.clientY,
                });
                setSelection({
                  paragraphIndex: pIdx,
                  charStart: 0,
                  charEnd: para.text.length,
                  selectedText: para.text.slice(0, 1200),
                  nodeId: para.nodeId ?? null,
                  anchorRect,
                });
              }}
              onTouchStart={(e) => {
                if (longPressTimer.current) clearTimeout(longPressTimer.current);
                const paraEl = e.currentTarget;
                const touch = e.touches[0];
                const pt = touch ? { x: touch.clientX, y: touch.clientY } : null;
                touchStartPosRef.current = pt;
                longPressTimer.current = setTimeout(() => {
                  longPressTimer.current = null;
                  const existingSel = window.getSelection?.()?.toString().trim();
                  if (existingSel) return;
                  buzz(game.platform);
                  const anchorRect = measureSelectionAnchor(paraEl, null, pt ?? undefined);
                  setSelection({
                    paragraphIndex: pIdx,
                    charStart: 0,
                    charEnd: para.text.length,
                    selectedText: para.text.slice(0, 1200),
                    nodeId: para.nodeId ?? null,
                    anchorRect,
                  });
                }, 520);
              }}
              onTouchMove={(e) => {
                if (!longPressTimer.current) return;
                const touch = e.touches[0];
                const start = touchStartPosRef.current;
                if (!touch || !start || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) {
                  clearTimeout(longPressTimer.current);
                  longPressTimer.current = null;
                }
              }}
              onTouchEnd={() => {
                if (longPressTimer.current) {
                  clearTimeout(longPressTimer.current);
                  longPressTimer.current = null;
                }
                touchStartPosRef.current = null;
              }}
              onTouchCancel={() => {
                if (longPressTimer.current) {
                  clearTimeout(longPressTimer.current);
                  longPressTimer.current = null;
                }
                touchStartPosRef.current = null;
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
                <i className="rpn-seal" aria-hidden="true">
                  批
                </i>
                <span className="rpn-text">{h.note}</span>
              </span>
            ))}
          </Fragment>
        );
      })}
      {currentSection.statusLine && <p className="reader-colophon">{currentSection.statusLine}</p>}
      <footer className="reader-chapter-tail" aria-label="本节尾记">
        <span className="rct-count">◇ 本节 {currentChapterChars.toLocaleString()} 字</span>
        {nextChapterTailHint && <span className="rct-next">{nextChapterTailHint}</span>}
      </footer>
    </div>
  );

  const padX = reading.pageMargin === "compact" ? "12px" : reading.pageMargin === "wide" ? "28px" : "20px";
  const screenVars = {
    "--story-font": `var(--${reading.fontFamily})`,
    "--story-tracking": `${reading.letterSpacing}em`,
    "--story-pad-x": padX,
  } as CSSProperties;

  const paginatorKey = `${targetId}:${sectionIndex}:${toc.length}:${sectionHighlights
    .map((h) => `${h.id}:${h.color}:${h.note}`)
    .join("|")}:${reading.size}:${reading.leading}:${reading.paragraph}:${reading.fontFamily}:${reading.indent}:${reading.measure}:${reading.pageMargin}:${reading.letterSpacing}:${reading.readerFooter}`;

  const selectionPopover = useMemo(() => {
    if (!selection?.anchorRect || typeof window === "undefined") return null;
    const vw = window.innerWidth || 390;
    const vh = window.innerHeight || 800;
    const bubbleH = 88;
    const bubbleW = Math.min(296, Math.max(220, vw - 24));
    const halfW = bubbleW / 2;
    const preferAbove = selection.anchorRect.top - bubbleH - 12 >= 64;
    const rawTop = preferAbove
      ? selection.anchorRect.top - bubbleH - 10
      : selection.anchorRect.bottom + 10;
    const minTop = 64;
    const maxTop = Math.max(64, vh - 150);
    const clampedTop = Math.round(Math.min(maxTop, Math.max(minTop, rawTop)));
    const clampedCenterX = Math.round(
      Math.min(Math.max(12 + halfW, selection.anchorRect.centerX), vw - 12 - halfW),
    );
    const arrowOffset = Math.round(
      Math.min(halfW - 20, Math.max(-(halfW - 20), selection.anchorRect.centerX - clampedCenterX)),
    );
    return {
      placement: preferAbove ? ("above" as const) : ("below" as const),
      style: {
        top: `${clampedTop}px`,
        left: `${clampedCenterX}px`,
        bottom: "auto",
        "--rsb-arrow-x": `${arrowOffset}px`,
      } as CSSProperties,
    };
  }, [selection]);

  // Desktop & hardware-keyboard reader shortcuts (inactive while any sheet/dialog/input is focused)
  useShortcuts(
    {
      "[": {
        run: () => {
          if (!currentSection) return false;
          if (sectionIndex > 0) void goSection(sectionIndex - 1);
          else toast("已经是第一章了");
        },
      },
      "]": {
        run: () => {
          if (!currentSection) return false;
          if (sectionIndex < toc.length - 1) void goSection(sectionIndex + 1);
          else toast("已经读到最后一章了");
        },
      },
      T: { run: () => setDrawerTab("toc") },
      B: {
        run: () => {
          if (!currentSection) return false;
          void toggleBookmark();
        },
      },
      "/": { run: () => setDrawerTab("search") },
      "Ctrl+F": { inInputs: true, run: () => setDrawerTab("search") },
      A: { run: () => setReadingSheet(true) },
      M: { run: () => setHudHidden((h) => !h) },
      "?": { run: () => setShortcutsOpen(true) },
      "Ctrl+/": { inInputs: true, run: () => setShortcutsOpen(true) },
    },
    !hasOverlayOpen && !loading && !error,
  );

  useEffect(() => {
    if (drawerTab !== "toc") return;
    const start = Math.max(0, sectionIndex - 60);
    const end = Math.min(toc.length, Math.max(start + 160, sectionIndex + 100));
    setTocRange({ start, end });
    const raf = requestAnimationFrame(() => {
      document.querySelector(".sheet [aria-current='true']")?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [drawerTab, sectionIndex, toc.length]);

  const previewSec = scrubSection ?? sectionIndex;
  const scrubPct =
    scrubSection !== null ? computeBookProgressPct(toc, scrubSection, 0) : null;
  const sleepCountdownText = formatSleepRemaining(tts.sleepRemainingSec);
  const forceHudOpen = loading || !!error || !currentSection;
  const effectiveHudHidden = hudHidden && !forceHudOpen;

  return (
    <div
      className={`reader-screen${effectiveHudHidden ? " hud-hidden" : ""}`}
      data-paper-tone={reading.paperTone === "default" ? undefined : reading.paperTone}
      data-focus-mode={reading.focusMode ? "on" : undefined}
      style={screenVars}
    >
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
        {bookId && bookFormat === "txt" && (
          <button
            type="button"
            className="icon-btn"
            aria-label="重分章节目录"
            title="重分章节目录"
            onClick={() => setResplitOpen(true)}
          >
            <Icon name="sliders" />
          </button>
        )}
        {targetType === "world_novel" && worldId && (
          <>
            <button
              type="button"
              className="icon-btn"
              aria-label={shelvedBookId ? "已在书斋，点此打开" : "收入书斋"}
              title={shelvedBookId ? "已收入书斋" : "收入书斋永久珍藏"}
              disabled={shelvingBusy}
              onClick={() => void handleSaveToLibrary()}
            >
              <Icon name="library-hall" />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="导出成书"
              title="导出成正式小说"
              onClick={() => setExportOpen(true)}
            >
              <Icon name="download" />
            </button>
          </>
        )}
        <button
          type="button"
          className="icon-btn reading-btn"
          aria-label="排版与护眼"
          title="排版与护眼（A）"
          onClick={() => setReadingSheet(true)}
        >
          <span aria-hidden="true">Aa</span>
        </button>
        {mouse && (
          <button
            type="button"
            className="icon-btn reader-keys-btn"
            aria-label="阅读快捷键"
            title="阅读快捷键（?）"
            onClick={() => setShortcutsOpen(true)}
          >
            <span aria-hidden="true">?</span>
          </button>
        )}
      </div>

      <div className="reader-stage">
        {/* Cinnabar silk bookmark ribbon */}
        {sectionBookmark && (
          <div
            key={ribbonDropKey}
            className={`reader-silk-ribbon${ribbonDropKey > 0 ? " is-dropping" : ""}`}
            aria-hidden="true"
          />
        )}

        {/* Leftmost 16px bezel: vertical drag adjusts dim, quick tap flips previous page */}
        {!hasOverlayOpen && (
          <div
            className="reader-brightness-edge"
            aria-hidden="true"
            onPointerDown={onBezelPointerDown}
            onPointerMove={onBezelPointerMove}
            onPointerUp={(e) => finishBezelPointer(e, false)}
            onPointerCancel={(e) => finishBezelPointer(e, true)}
          />
        )}

        {brightnessHud !== null && (
          <div className="reader-brightness-pill" role="status" aria-live="polite">
            <Icon name={brightnessHud >= 20 ? "moon" : "sun"} size={16} />
            <span>{brightnessHud > 0 ? `深夜减光 ${brightnessHud}%` : "标准亮度（减光 0%）"}</span>
          </div>
        )}

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
            jumpNonce={jumpNonce}
            initialPage={entryPage}
            initialSelector={entrySelector}
            headerTitle={bookTitle}
            headerRight={toc.length > 1 ? `第 ${sectionIndex + 1} / ${toc.length} 节` : undefined}
            footerLeft={currentSection.title}
            readingEtaText={readingEtaText}
            bookProgressPct={bookProgressPct}
            showStatusMeta={true}
            hideFooter={!reading.readerFooter}
            hasBookmarkRibbon={!!sectionBookmark}
            hudVisible={!hudHidden}
            autoReadProgress={autoReadProgress}
            pageTurnAnim={reading.pageTurnAnim}
            tapZones={reading.tapZones}
            volumeKeys={volumeTurnActive}
            onUserInteract={pauseAutoReadOnTouch}
            onCenterTap={() => {
              if (!selection) setHudHidden((h) => !h);
            }}
            onBoundaryStart={
              sectionIndex > 0
                ? () => {
                    setHudHidden(true);
                    void goSection(sectionIndex - 1, { page: "last" });
                  }
                : () => toast("已经是第一章了")
            }
            onBoundaryEnd={
              sectionIndex < toc.length - 1
                ? () => {
                    setHudHidden(true);
                    void goSection(sectionIndex + 1, { page: 0 });
                  }
                : () => toast("已经读到最后一章了")
            }
            onPageChange={(p, total, anchorNodeId) => {
              const prev = lastReportedPageRef.current;
              if (prev && prev.section === sectionIndex && prev.page !== p) {
                setHudHidden(true);
                if (selection) {
                  window.getSelection?.()?.removeAllRanges();
                  setSelection(null);
                }
              }
              lastReportedPageRef.current = { section: sectionIndex, page: p };
              const rawPara = paginatorRef.current?.currentAnchorId("data-para-index");
              const pIdx = rawPara != null && Number.isFinite(Number(rawPara)) ? Math.max(0, Math.trunc(Number(rawPara))) : 0;
              lastVisibleParaRef.current = pIdx;
              const proportionalRatio = p + 1 <= total ? p / Math.max(1, total - 1) : 0;
              setScrollRatio(proportionalRatio);
              setPageStats((old) =>
                old.page === p && old.totalPages === total ? old : { page: p, totalPages: total },
              );
              const nodeId = targetType === "world_novel" ? anchorNodeId : null;
              scheduleSaveProgress(sectionIndex, p, proportionalRatio, nodeId, pIdx);
            }}
          >
            {proseBody}
          </Paginator>
        ) : (
          <div
            className="reader-scroller"
            ref={scrollerRef}
            onPointerDown={(e) => {
              const t = e.target as Element | null;
              if (!t?.closest("button, a, mark")) {
                pauseAutoReadOnTouch();
              }
            }}
            onWheel={pauseAutoReadOnTouch}
            onClick={(e) => {
              const t = e.target as Element | null;
              if (t?.closest("button, a, mark, [data-no-page-tap]")) return;
              const sel = window.getSelection?.()?.toString().trim();
              if (sel || selection) return;
              // Center tap in scroll mode toggles HUD cleanly
              const rect = e.currentTarget.getBoundingClientRect();
              const relY = (e.clientY - rect.top) / Math.max(1, rect.height);
              if (relY > 0.22 && relY < 0.78) {
                setHudHidden((h) => !h);
              }
            }}
            onScroll={() => {
              const el = scrollerRef.current;
              if (!el) return;
              const max = Math.max(1, el.scrollHeight - el.clientHeight);
              const ratio = Math.min(1, Math.max(0, el.scrollTop / max));
              const pIdx = getCurrentParagraphIndex();
              lastVisibleParaRef.current = pIdx;
              if (
                performance.now() > programmaticScrollUntilRef.current &&
                Math.abs(el.scrollTop - lastScrollTopRef.current) > 8
              ) {
                lastScrollTopRef.current = el.scrollTop;
                setHudHidden(true);
                if (selection) {
                  window.getSelection?.()?.removeAllRanges();
                  setSelection(null);
                }
              }
              setScrollRatio(ratio);
              scheduleSaveProgress(sectionIndex, 0, ratio, null, pIdx);
            }}
          >
            {proseBody}
            {targetType === "world_novel" && worldId && currentSection.isLast && (
              <div className="reader-world-novel-cta">
                <button
                  type="button"
                  disabled={shelvingBusy}
                  onClick={() => void handleSaveToLibrary()}
                >
                  <Icon name="library-hall" size={18} />
                  <span>{shelvedBookId ? "已入书斋 · 打开书卷" : "收入书斋"}</span>
                </button>
                <button type="button" className="ghost" onClick={() => setExportOpen(true)}>
                  <Icon name="download" size={18} />
                  <span>导出成书</span>
                </button>
              </div>
            )}
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

      {/* 8s Jump-Undo Floating Pill */}
      {jumpUndo && (
        <button
          type="button"
          className="reader-undo-pill"
          onClick={() => {
            const target = jumpUndo;
            if (jumpUndoTimerRef.current) clearTimeout(jumpUndoTimerRef.current);
            setJumpUndo(null);
            void goSection(target.sectionIndex, {
              page: target.page,
              scrollRatio: target.scrollRatio,
              recordUndo: false,
            });
          }}
        >
          <span>↩ 回到刚才位置（{jumpUndo.title}）</span>
        </button>
      )}

      {/* Compact Auto-Read Floating Control Bar */}
      {autoRead.active && (
        <div className="reader-floating-bar reader-autoread-bar" role="region" aria-label="自动阅读控制">
          <button
            type="button"
            className="ghost small"
            onClick={() =>
              setAutoRead((prev) => ({ ...prev, paused: !prev.paused }))
            }
          >
            <Icon name={autoRead.paused ? "play" : "pause"} size={16} />
            <span>{autoRead.paused ? "继续自动读" : "自动阅读中"}</span>
          </button>
          <div className="reader-speed-pills">
            <button
              type="button"
              className="ghost small"
              aria-label="放慢自动翻页速度"
              disabled={autoRead.speed <= 1}
              onClick={() =>
                setAutoRead((prev) => ({
                  ...prev,
                  speed: Math.max(1, prev.speed - 1) as 1 | 2 | 3 | 4 | 5,
                }))
              }
            >
              慢
            </button>
            <span className="reader-speed-now">{autoRead.speed} 档</span>
            <button
              type="button"
              className="ghost small"
              aria-label="加快自动翻页速度"
              disabled={autoRead.speed >= 5}
              onClick={() =>
                setAutoRead((prev) => ({
                  ...prev,
                  speed: Math.min(5, prev.speed + 1) as 1 | 2 | 3 | 4 | 5,
                }))
              }
            >
              快
            </button>
          </div>
          <button
            type="button"
            className="icon-btn reader-mini-close"
            aria-label="退出自动阅读"
            onClick={() => {
              setAutoRead((prev) => ({ ...prev, active: false, paused: false }));
              setAutoReadProgress(null);
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {/* Offline Dual-Engine TTS Audiobook Bar */}
      {ttsOpen && (
        <div className="reader-floating-bar reader-tts-bar" role="region" aria-label="语音听书控制">
          <div className="reader-tts-main">
            <button
              type="button"
              className="icon-btn reader-tts-btn"
              aria-label="上一段"
              onClick={() => tts.prevParagraph()}
            >
              <Icon name="back" size={17} />
            </button>
            <button
              type="button"
              className="primary reader-tts-play"
              aria-label={tts.status === "playing" ? "暂停朗读" : "开始朗读"}
              onClick={() => tts.toggle()}
            >
              <Icon name={tts.status === "playing" ? "pause" : "play"} size={17} />
              <span>{tts.status === "playing" ? "暂停" : tts.status === "paused" ? "继续" : "朗读"}</span>
            </button>
            <button
              type="button"
              className="icon-btn reader-tts-btn"
              aria-label="下一段"
              onClick={() => tts.nextParagraph()}
            >
              <Icon name="forward" size={17} />
            </button>
            <button
              type="button"
              className="ghost small"
              aria-label="切换语速"
              onClick={() => {
                const idx = TTS_RATES.indexOf(tts.rate);
                const next = TTS_RATES[(idx + 1) % TTS_RATES.length]!;
                tts.setRate(next);
              }}
            >
              {tts.rate}x
            </button>
            <button
              type="button"
              className="ghost small"
              aria-pressed={tts.sleepMode !== 0}
              onClick={() => setTtsTimerOpen((o) => !o)}
            >
              <Icon name="timer" size={15} />
              <span>
                {tts.sleepMode === "chapter"
                  ? "本章完"
                  : sleepCountdownText
                    ? sleepCountdownText
                    : "定时"}
              </span>
            </button>
            <button
              type="button"
              className="icon-btn reader-mini-close"
              aria-label="停止并关闭听书"
              onClick={() => {
                tts.stop();
                setTtsTimerOpen(false);
                setTtsOpen(false);
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          {ttsTimerOpen && (
            <div className="reader-tts-sleep-row" role="group" aria-label="睡眠定时">
              {TTS_SLEEP_OPTIONS.map(([mode, label]) => (
                <button
                  key={String(mode)}
                  type="button"
                  className="ghost small"
                  aria-pressed={tts.sleepMode === mode}
                  onClick={() => {
                    tts.setSleepMode(mode);
                    setTtsTimerOpen(false);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {mouse && hudHidden && (
        <button
          type="button"
          className="icon-btn reader-hud-fab"
          aria-label="显示阅读工具栏"
          title="显示阅读工具栏（M）"
          onClick={() => setHudHidden(false)}
        >
          <Icon name="more" size={18} />
        </button>
      )}

      {selection && (
        <div
          className={`reader-selection-bar${selectionPopover ? ` is-${selectionPopover.placement}` : ""}`}
          role="toolbar"
          aria-label="划线与摘录工具"
          style={selectionPopover?.style}
        >
          <div className="rsb-row rsb-row-top">
            <div className="rsb-dots">
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
            </div>
            <span className="rsb-divider" aria-hidden="true" />
            <button
              type="button"
              className="ghost small reader-ask-trigger"
              onClick={openAskCompanionFromSelection}
            >
              <Icon name="sparkle" size={14} />
              <span>问伴聊</span>
            </button>
          </div>
          <div className="rsb-row rsb-row-actions">
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
              className="ghost small rsb-close"
              aria-label="关闭划线菜单"
              onClick={() => {
                window.getSelection?.()?.removeAllRanges();
                setSelection(null);
              }}
            >
              <Icon name="close" size={15} />
            </button>
          </div>
        </div>
      )}

      <div className="reader-dock">
        {scrubSection !== null && toc[scrubSection] && (() => {
          const scrubLocked = !spoilerUnlocked && spoilerCeiling != null && scrubSection > spoilerCeiling;
          return (
            <div className="reader-scrub-bubble" role="status" aria-live="polite">
              <b>第 {scrubSection + 1} 节</b>
              <span className="scrub-title">
                {scrubLocked ? `第 ${scrubSection + 1} 章（未解锁）` : toc[scrubSection]!.title}
              </span>
              {scrubPct !== null && <span className="scrub-pct">{scrubPct.toFixed(1)}%</span>}
            </div>
          );
        })()}
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
              value={previewSec}
              onPointerDown={() => {
                sliderPointerDownRef.current = true;
                setScrubSection(sectionIndex);
              }}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (sliderPointerDownRef.current) {
                  setScrubSection(next);
                } else {
                  void goSection(next, { recordUndo: true });
                }
              }}
              onPointerUp={(e) => {
                if (!sliderPointerDownRef.current) return;
                sliderPointerDownRef.current = false;
                const target = scrubSection ?? Number((e.target as HTMLInputElement).value);
                setScrubSection(null);
                if (target !== sectionIndex) {
                  void goSection(target, { recordUndo: true });
                }
              }}
              onPointerCancel={() => {
                sliderPointerDownRef.current = false;
                setScrubSection(null);
              }}
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
            className={`reader-tool-btn${ttsOpen || tts.status === "playing" ? " is-active" : ""}`}
            aria-pressed={ttsOpen || tts.status === "playing"}
            onClick={() => {
              if (!ttsOpen) {
                setAutoRead((prev) => ({ ...prev, active: false, paused: false }));
                if (jumpUndoTimerRef.current) clearTimeout(jumpUndoTimerRef.current);
                setJumpUndo(null);
                setTtsOpen(true);
                setHudHidden(true);
                if (tts.status === "idle") {
                  const pIdx = getCurrentParagraphIndex();
                  tts.play(pIdx);
                }
              } else {
                tts.stop();
                setTtsTimerOpen(false);
                setTtsOpen(false);
              }
            }}
          >
            <Icon name="headphones" size={19} />
            <span>{tts.status === "playing" ? "听书中" : "听书"}</span>
          </button>
          <button
            type="button"
            className={`reader-tool-btn${autoRead.active ? " is-active" : ""}`}
            aria-pressed={autoRead.active}
            onClick={() => {
              if (!autoRead.active) {
                if (tts.status !== "idle") {
                  tts.stop();
                  setTtsOpen(false);
                }
                setAutoRead((prev) => ({ ...prev, active: true, paused: false }));
                setHudHidden(true);
              } else {
                setAutoRead((prev) => ({ ...prev, active: false, paused: false }));
                setAutoReadProgress(null);
              }
            }}
          >
            <Icon name="auto-read" size={19} />
            <span>{autoRead.active ? "自动中" : "自动读"}</span>
          </button>
        </div>
      </div>

      {/* Eye-comfort late-night dim veil (0%..50%) */}
      {reading.nightDim > 0 && (
        <div
          className="reader-dim-veil"
          aria-hidden="true"
          style={{ opacity: Number((reading.nightDim / 100).toFixed(2)) }}
        />
      )}

      {drawerTab === "toc" && (
        <Sheet title="目录" onClose={() => setDrawerTab(null)}>
          <div className="stack gap-2">
            {(bookId && bookFormat === "txt") || (targetType === "world_novel" && worldId) ? (
              <div className="row between wrap gap-2">
                {bookId && bookFormat === "txt" && (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => {
                      setDrawerTab(null);
                      setResplitOpen(true);
                    }}
                  >
                    <Icon name="sliders" size={16} />
                    <span>TXT 重分章节</span>
                  </button>
                )}
                {targetType === "world_novel" && worldId && (
                  <div className="row gap-1">
                    <button
                      type="button"
                      className="ghost small"
                      disabled={shelvingBusy}
                      onClick={() => {
                        setDrawerTab(null);
                        void handleSaveToLibrary();
                      }}
                    >
                      <Icon name="library-hall" size={16} />
                      <span>{shelvedBookId ? "已入书斋" : "收入书斋"}</span>
                    </button>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => {
                        setDrawerTab(null);
                        setExportOpen(true);
                      }}
                    >
                      <Icon name="download" size={16} />
                      <span>导出成书</span>
                    </button>
                  </div>
                )}
              </div>
            ) : null}
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
                {!tocFilter.trim() && tocRange.start > 0 && (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() =>
                      setTocRange((r) => ({ ...r, start: Math.max(0, r.start - 240) }))
                    }
                  >
                    ↑ 展开更早章节（前 {tocRange.start} 节）
                  </button>
                )}
                {(tocFilter.trim()
                  ? filteredToc.slice(0, 200)
                  : filteredToc.slice(tocRange.start, tocRange.end)
                ).map((item) => {
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
                        void goSection(item.index, { recordUndo: true });
                      }}
                    >
                      <div className="grow">
                        <b>{locked ? `第 ${item.index + 1} 章（未解锁）` : item.title}</b>
                        {!locked && item.subtitle && <small>{item.subtitle}</small>}
                      </div>
                      <span className="person-side">
                        {locked ? (
                          <span className="tag">未解锁</span>
                        ) : active ? (
                          <span className="tag">在读</span>
                        ) : item.chars > 0 ? (
                          <small>{item.chars.toLocaleString()} 字</small>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
                {!tocFilter.trim() && tocRange.end < filteredToc.length && (
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() =>
                      setTocRange((r) => ({
                        ...r,
                        end: Math.min(filteredToc.length, r.end + 240),
                      }))
                    }
                  >
                    ↓ 展开后续章节（余 {filteredToc.length - tocRange.end} 节）
                  </button>
                )}
                {tocFilter.trim() !== "" && filteredToc.length > 200 && (
                  <small className="muted t-center">
                    共命中 {filteredToc.length} 节，已展示前 200 节；继续输入可进一步缩小范围。
                  </small>
                )}
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
                      void goSection(bm.sectionIndex, { paraIndex: bm.paragraphIndex, recordUndo: true });
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
                    void goSection(hit.sectionIndex, { paraIndex: hit.paragraphIndex, recordUndo: true });
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
                    body: noteInput.trim()
                      ? `${h.selectedText}\n\n${SEPARATOR}\n\n批注：${noteInput.trim()}`
                      : h.selectedText,
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
      {shortcutsOpen && (
        <Sheet title="阅读快捷键" onClose={() => setShortcutsOpen(false)}>
          <div className="stack gap-2">
            <dl className="facts reader-shortcut-list m-0">
              {(
                [
                  ["← / → / Space", "上一页 / 下一页（翻页模式）"],
                  ["[ / ]", "上一章 / 下一章"],
                  ["T", "打开章节目录"],
                  ["B", "添加 / 移除本章书签"],
                  ["/ 或 Ctrl+F", "全文检索"],
                  ["A", "排版与护眼设置"],
                  ["M", "显示 / 隐藏顶底工具栏"],
                  ["? 或 Ctrl+/", "打开这张快捷键表"],
                  ["Esc", "收起面板或返回书架"],
                ] as const
              ).map(([keys, desc]) => (
                <div key={keys} className="contents">
                  <dt>
                    <kbd className="reader-kbd">{keys}</kbd>
                  </dt>
                  <dd>{desc}</dd>
                </div>
              ))}
            </dl>
            <p className="muted m-0">
              鼠标滚轮或触控板滑动也可翻页；沿左侧边缘上下拖动可调节深夜减光。
            </p>
          </div>
        </Sheet>
      )}
      {excerptsOpen && (
        <ExcerptsSheet
          worldId={targetType === "world_novel" ? targetId : worldId}
          bookId={targetType === "book" ? targetId : null}
          onJumpHighlight={(h) => {
            if (h.targetType === targetType && h.targetId === targetId) {
              void goSection(h.sectionIndex, { paraIndex: h.paragraphIndex, recordUndo: true });
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
      {resplitOpen && bookId && (
        <ReaderResplitSheet
          bookId={bookId}
          bookTitle={bookTitle}
          onApplied={async () => {
            await reloadAfterResplit();
          }}
          onClose={() => setResplitOpen(false)}
        />
      )}
      {askSheetState && currentSection && (
        <ReaderAskSheet
          bookId={bookId}
          worldId={worldId}
          bookTitle={bookTitle}
          sectionIndex={sectionIndex}
          sectionTitle={currentSection.title}
          selectedText={askSheetState.selectedText}
          contextParagraphs={askSheetState.contextParagraphs}
          onOpenFullCompanion={({ prompt, asked, draftQuestion }) => {
            const effectiveCeiling =
              !spoilerUnlocked && spoilerCeiling != null
                ? Math.max(0, Math.min(sectionIndex, spoilerCeiling))
                : Math.max(0, sectionIndex);
            push({
              name: "companion",
              worldId,
              lineId,
              bookId,
              gear: "research",
              prompt,
              autoSend: false,
              handoff: {
                asked,
                draftQuestion,
                ...(bookId ? { sourceScope: { mode: "chapters", from: 0, to: effectiveCeiling } } : {}),
              },
            });
          }}
          onClose={() => setAskSheetState(null)}
        />
      )}
      {cardContent && <CardSheet content={cardContent} onClose={() => setCardContent(null)} />}
    </div>
  );
}
