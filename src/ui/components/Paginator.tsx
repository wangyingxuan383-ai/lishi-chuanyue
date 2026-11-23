// Viewport-height CSS Multi-Column book paginator shared by ReaderScreen and Play.
// Uses exact integer pixel column-width and stride so translate3d never drifts,
// preserves the reading anchor across font/resize changes, supports touch drag-follow,
// left/right 26% tap zones, keyboard arrows/Space, and live streaming follow/lock.
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { motionOn } from "../app/motion";
import { Icon } from "./Icon";
import "./paginator.css";

const COLUMN_GAP = 48;
const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, summary, label, details, [role='button'], [data-no-page-tap], .choice-row, .turn-tools, .turn-changes, .notice-actions";

export interface PaginatorHandle {
  page: number;
  totalPages: number;
  goToPage: (target: number) => void;
  goToLastPage: () => void;
  jumpToSelector: (selector: string) => boolean;
  currentAnchorId: (attr?: string) => string | null;
  remeasure: () => void;
}

export interface PaginatorProps {
  children: ReactNode;
  /** Bumped when content changes so columns remeasure immediately. */
  contentKey?: string | number;
  /** Initial page ("last" opens at the final page of the section/story). */
  initialPage?: number | "last";
  /** Optional selector to jump to once rendered (e.g. `[data-node-id="..."]`). */
  initialSelector?: string | null;
  /** Whether new streaming words are currently arriving at the tail. */
  streaming?: boolean;
  /** Follow newly generated pages automatically when on/following the tail. */
  autoFollow?: boolean;
  /** Left caption in the quiet bottom margin (chapter or place name). */
  footerLeft?: string;
  /** Called when user taps/swipes past page 0 (e.g. previous chapter or loadMore). */
  onBoundaryStart?: () => void;
  /** Called when user taps/swipes past the last page (e.g. next chapter). */
  onBoundaryEnd?: () => void;
  /** Called when user taps the center 48% reading zone (e.g. toggle HUD). */
  onCenterTap?: () => void;
  /** Reports page & anchor updates for progress persistence. */
  onPageChange?: (page: number, totalPages: number, anchorNodeId: string | null) => void;
  /** Enable keyboard Left/Right/PageUp/PageDown/Space navigation. */
  keyboard?: boolean;
  className?: string;
}

export const Paginator = forwardRef<PaginatorHandle, PaginatorProps>(function Paginator(
  {
    children,
    contentKey,
    initialPage = 0,
    initialSelector,
    streaming = false,
    autoFollow = false,
    footerLeft,
    onBoundaryStart,
    onBoundaryEnd,
    onCenterTap,
    onPageChange,
    keyboard = true,
    className = "",
  },
  ref,
) {
  const stageRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(0);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const pageRef = useRef(0);
  pageRef.current = page;
  const totalRef = useRef(1);
  totalRef.current = totalPages;
  const followTailRef = useRef(initialPage === "last" || autoFollow);
  const initializedRef = useRef(false);
  const anchorBeforeResizeRef = useRef<string | null>(null);

  const stride = box.w > 0 ? box.w + COLUMN_GAP : 0;

  const pageOfElement = useCallback(
    (el: Element | null): number | null => {
      const cols = columnsRef.current;
      if (!el || !cols || stride <= 0) return null;
      const rects = el.getClientRects();
      const r = rects[0] ?? el.getBoundingClientRect();
      const colsRect = cols.getBoundingClientRect();
      const offsetX = r.left - colsRect.left;
      return Math.max(0, Math.floor((offsetX + COLUMN_GAP * 0.35) / stride));
    },
    [stride],
  );

  const findVisibleAnchor = useCallback((attr = "data-node-id"): string | null => {
    const stage = stageRef.current;
    const cols = columnsRef.current;
    if (!stage || !cols) return null;
    const sr = stage.getBoundingClientRect();
    if (sr.width <= 0) return null;
    const candidates = cols.querySelectorAll<HTMLElement>(`[${attr}]`);
    for (const el of candidates) {
      const rects = el.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i]!;
        if (r.right > sr.left + 6 && r.left < sr.right - 6 && r.bottom > sr.top + 4) {
          return el.getAttribute(attr);
        }
      }
    }
    return null;
  }, []);

  const measureColumns = useCallback(() => {
    const stage = stageRef.current;
    const cols = columnsRef.current;
    if (!stage || !cols) return 1;
    const w = Math.max(0, Math.floor(stage.clientWidth));
    const h = Math.max(0, Math.floor(stage.clientHeight));
    if (w > 0 && h > 0 && (w !== box.w || h !== box.h)) {
      if (!anchorBeforeResizeRef.current) {
        anchorBeforeResizeRef.current = findVisibleAnchor("data-node-id") ?? findVisibleAnchor("data-para-index");
      }
      setBox({ w, h });
      return totalRef.current;
    }
    if (w <= 0) return 1;
    const s = w + COLUMN_GAP;
    const computed = Math.max(1, Math.round((cols.scrollWidth + COLUMN_GAP) / s));
    setTotalPages((prev) => (prev === computed ? prev : computed));
    totalRef.current = computed;
    return computed;
  }, [box.h, box.w, findVisibleAnchor]);

  const goToPage = useCallback(
    (target: number) => {
      const maxPage = Math.max(0, totalRef.current - 1);
      const clamped = Math.max(0, Math.min(maxPage, target));
      followTailRef.current = clamped >= maxPage && autoFollow;
      pageRef.current = clamped;
      setPage(clamped);
    },
    [autoFollow],
  );

  const jumpToSelector = useCallback(
    (selector: string): boolean => {
      const cols = columnsRef.current;
      if (!cols) return false;
      const target = cols.querySelector(selector);
      const p = pageOfElement(target);
      if (p === null) return false;
      const clamped = Math.max(0, Math.min(Math.max(0, totalRef.current - 1), p));
      followTailRef.current = false;
      pageRef.current = clamped;
      setPage(clamped);
      return true;
    },
    [pageOfElement],
  );

  useImperativeHandle(
    ref,
    () => ({
      page,
      totalPages,
      goToPage,
      goToLastPage: () => {
        const last = Math.max(0, totalRef.current - 1);
        followTailRef.current = true;
        pageRef.current = last;
        setPage(last);
      },
      jumpToSelector,
      currentAnchorId: (attr = "data-node-id") => findVisibleAnchor(attr),
      remeasure: () => {
        measureColumns();
      },
    }),
    [findVisibleAnchor, goToPage, jumpToSelector, measureColumns, page, totalPages],
  );

  // Observe stage size & content mutations cleanly
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const cols = columnsRef.current;
    if (!stage || !cols) return;
    const w = Math.max(0, Math.floor(stage.clientWidth));
    const h = Math.max(0, Math.floor(stage.clientHeight));
    if (w > 0 && h > 0 && (w !== box.w || h !== box.h)) {
      setBox({ w, h });
    }
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      measureColumns();
    });
    ro.observe(stage);
    ro.observe(cols);
    return () => ro.disconnect();
  }, [box.h, box.w, measureColumns]);

  // Re-measure whenever content, typography variables, or box dimensions change
  useLayoutEffect(() => {
    const count = measureColumns();
    if (box.w <= 0) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      if (initialSelector && jumpToSelector(initialSelector)) return;
      if (initialPage === "last") {
        const last = Math.max(0, count - 1);
        pageRef.current = last;
        setPage(last);
        return;
      }
      const start = Math.max(0, Math.min(count - 1, initialPage));
      pageRef.current = start;
      setPage(start);
      return;
    }
    if (anchorBeforeResizeRef.current) {
      const id = anchorBeforeResizeRef.current;
      anchorBeforeResizeRef.current = null;
      if (jumpToSelector(`[data-node-id="${CSS.escape(id)}"]`) || jumpToSelector(`[data-para-index="${CSS.escape(id)}"]`)) {
        return;
      }
    }
    if (streaming && (autoFollow || followTailRef.current)) {
      const last = Math.max(0, count - 1);
      if (pageRef.current !== last) {
        pageRef.current = last;
        setPage(last);
      }
      return;
    }
    if (pageRef.current >= count) {
      const clamped = Math.max(0, count - 1);
      pageRef.current = clamped;
      setPage(clamped);
    }
  }, [autoFollow, box.h, box.w, contentKey, initialPage, initialSelector, jumpToSelector, measureColumns, streaming]);

  // Fonts finishing load can shift line breaks slightly; remeasure once ready
  useEffect(() => {
    let live = true;
    void document.fonts?.ready?.then(() => {
      if (live) measureColumns();
    });
    return () => {
      live = false;
    };
  }, [measureColumns]);

  // Notify parent of page & anchor changes
  useEffect(() => {
    if (!onPageChange || box.w <= 0) return;
    const id = findVisibleAnchor("data-node-id") ?? findVisibleAnchor("data-para-index");
    onPageChange(page, totalPages, id);
  }, [box.w, findVisibleAnchor, onPageChange, page, totalPages]);

  const stepBy = useCallback(
    (delta: -1 | 1) => {
      const cur = pageRef.current;
      const last = Math.max(0, totalRef.current - 1);
      if (delta < 0) {
        if (cur > 0) {
          followTailRef.current = false;
          goToPage(cur - 1);
        } else {
          onBoundaryStart?.();
        }
      } else if (cur < last) {
        followTailRef.current = cur + 1 >= last && autoFollow;
        goToPage(cur + 1);
      } else {
        onBoundaryEnd?.();
      }
    },
    [autoFollow, goToPage, onBoundaryEnd, onBoundaryStart],
  );

  // Keyboard navigation (ArrowLeft/PageUp = prev, ArrowRight/PageDown/Space = next)
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (document.querySelector(".sheet-layer, .dialog, .panel:not(.docked)")) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        stepBy(-1);
      } else if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) {
        e.preventDefault();
        stepBy(1);
      } else if (e.key === " " && e.shiftKey) {
        e.preventDefault();
        stepBy(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard, stepBy]);

  // Pointer drag-follow swipe & edge tap zones (coexisting cleanly with 450ms long-press & text selection)
  const gestureRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    startTime: number;
    swiping: boolean;
    interactive: boolean;
    pointerType: string;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const target = e.target as Element | null;
    const interactive = !!target?.closest(INTERACTIVE_SELECTOR);
    gestureRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startTime: performance.now(),
      swiping: false,
      interactive,
      pointerType: e.pointerType,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.id !== e.pointerId || g.pointerType === "mouse") return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.swiping) {
      // Do not hijack if user has active text selection or vertical scroll intent
      const sel = window.getSelection?.()?.toString().trim();
      if (sel) return;
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.35) {
        g.swiping = true;
        setDragging(true);
      } else {
        return;
      }
    }
    const atEdge = (page === 0 && dx > 0) || (page >= totalPages - 1 && dx < 0);
    setDragOffset(atEdge ? Math.round(dx * 0.28) : Math.round(dx));
  };

  const finishPointer = (e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const g = gestureRef.current;
    if (!g || g.id !== e.pointerId) return;
    gestureRef.current = null;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const dt = Math.max(1, performance.now() - g.startTime);

    if (g.swiping) {
      setDragging(false);
      setDragOffset(0);
      if (!cancelled) {
        const threshold = Math.min(72, Math.max(40, box.w * 0.16));
        const velocity = Math.abs(dx) / dt;
        if (Math.abs(dx) >= threshold || velocity > 0.38) {
          stepBy(dx < 0 ? 1 : -1);
        }
      }
      return;
    }

    if (cancelled || g.interactive) return;
    // Short clean tap (< 300ms, < 10px) when no text is selected
    if (dt >= 300 || Math.hypot(dx, dy) >= 10) return;
    const selected = window.getSelection?.()?.toString().trim();
    if (selected) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / Math.max(1, rect.width);
    if (rel < 0.26) stepBy(-1);
    else if (rel > 0.74) stepBy(1);
    else onCenterTap?.();
  };

  const animate = motionOn() && !dragging;
  const tx = stride > 0 ? -page * stride + dragOffset : 0;

  return (
    <div
      className={`paginator${dragging ? " is-dragging" : ""}${animate ? " is-animated" : ""}${className ? ` ${className}` : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finishPointer(e, false)}
      onPointerCancel={(e) => finishPointer(e, true)}
    >
      <div className="paginator-frame">
        <div
          className="paginator-stage"
          ref={stageRef}
          onScroll={(e) => {
            if (e.currentTarget.scrollLeft !== 0) e.currentTarget.scrollLeft = 0;
            if (e.currentTarget.scrollTop !== 0) e.currentTarget.scrollTop = 0;
          }}
        >
          <div
            className="paged-columns"
            ref={columnsRef}
            style={
              box.w > 0 && box.h > 0
                ? {
                    width: `${box.w}px`,
                    height: `${box.h}px`,
                    columnWidth: `${box.w}px`,
                    columnGap: `${COLUMN_GAP}px`,
                    transform: `translate3d(${tx}px, 0, 0)`,
                  }
                : undefined
            }
          >
            {children}
          </div>
        </div>
        <footer className="paginator-footer" data-no-page-tap="true">
          <span className="pf-title">{footerLeft ?? ""}</span>
          <span className="pf-controls">
            <button
              type="button"
              className="icon-btn pf-step"
              aria-label="上一页"
              disabled={page <= 0 && !onBoundaryStart}
              onClick={() => stepBy(-1)}
            >
              <Icon name="back" size={16} />
            </button>
            <span className="pf-count" aria-live="polite">
              {page + 1} / {totalPages}
            </span>
            <button
              type="button"
              className="icon-btn pf-step"
              aria-label="下一页"
              disabled={page >= totalPages - 1 && !onBoundaryEnd}
              onClick={() => stepBy(1)}
            >
              <Icon name="forward" size={16} />
            </button>
          </span>
        </footer>
      </div>
      {streaming && page < totalPages - 1 && (
        <button
          type="button"
          className="paged-follow-pill"
          data-no-page-tap="true"
          onClick={() => {
            followTailRef.current = true;
            goToPage(totalPages - 1);
          }}
        >
          <i aria-hidden="true" />
          <span>落笔中 · 到末页 ›</span>
        </button>
      )}
    </div>
  );
});
