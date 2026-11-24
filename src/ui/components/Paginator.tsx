// Viewport-height CSS Multi-Column book paginator shared by ReaderScreen and Play.
// Uses exact integer pixel column-width and stride so translate3d never drifts,
// preserves the reading anchor across font/resize changes, supports 4 page-turn
// animations (cover with crease shadow, slide, fade, E-Ink instant), classic &
// one-handed tap zones, hardware volume keys, wheel step, running header & status footer.
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
import type { PageTurnAnim, ReaderTapZones } from "../app/context";
import { motionOn } from "../app/motion";
import { Icon } from "./Icon";
import "./paginator.css";

const COLUMN_GAP = 48;
const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, summary, label, details, [role='button'], [data-no-page-tap], .choice-row, .turn-tools, .turn-changes, .notice-actions";

/**
 * Pure tap-zone resolver for unit-testable coordinate mapping:
 * - "classic": left 28% prev, right 28% next, center 44% HUD.
 * - "onehand": top-left (26% × 62%) prev, top-center (48% × 36%) HUD,
 *   entire bottom 64% + right side -> next page for effortless one-hand reading.
 */
export function resolveTapZone(
  relX: number,
  relY: number,
  mode: ReaderTapZones = "classic",
): "prev" | "next" | "center" {
  if (mode === "onehand") {
    if (relX < 0.26 && relY < 0.62) return "prev";
    if (relX >= 0.26 && relX <= 0.74 && relY < 0.36) return "center";
    return "next";
  }
  if (relX < 0.28) return "prev";
  if (relX > 0.72) return "next";
  return "center";
}

function formatClockNow(d = new Date()): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function readStageInnerBox(stage: HTMLElement): { w: number; h: number } {
  const cs = typeof getComputedStyle === "function" ? getComputedStyle(stage) : null;
  const padX = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
  const padY = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 0;
  return {
    w: Math.max(0, Math.floor(stage.clientWidth - padX)),
    h: Math.max(0, Math.floor(stage.clientHeight - padY)),
  };
}

interface BatteryState {
  level: number;
  charging: boolean;
}

interface NavigatorBatteryManager extends EventTarget {
  level: number;
  charging: boolean;
}

export interface PaginatorHandle {
  page: number;
  totalPages: number;
  goToPage: (target: number) => void;
  goToLastPage: () => void;
  stepBy: (delta: -1 | 1) => void;
  jumpToSelector: (selector: string) => boolean;
  currentAnchorId: (attr?: string) => string | null;
  remeasure: () => void;
}

export interface PaginatorProps {
  children: ReactNode;
  /** Bumped when content changes so columns remeasure immediately. */
  contentKey?: string | number;
  /** Bumped on explicit jumps (including same-chapter jumps) to re-apply initialSelector/initialPage. */
  jumpNonce?: number;
  /** Initial page ("last" opens at the final page of the section/story). */
  initialPage?: number | "last";
  /** Optional selector to jump to once rendered (e.g. `[data-node-id="..."]`). */
  initialSelector?: string | null;
  /** Whether new streaming words are currently arriving at the tail. */
  streaming?: boolean;
  /** Follow newly generated pages automatically when on/following the tail. */
  autoFollow?: boolean;
  /** Quiet running header title at top margin (眉标). */
  headerTitle?: string;
  /** Optional right-aligned running header note. */
  headerRight?: string;
  /** Left caption in the quiet bottom margin (chapter or place name). */
  footerLeft?: string;
  /** Estimated remaining chapter reading time label (e.g. "剩 3 分钟" / "本章末"). */
  readingEtaText?: string | null;
  /** Total book reading progress percentage (0..100), shown when `showStatusMeta` is true. */
  bookProgressPct?: number | null;
  /** Show tabular book %, live HH:MM clock, and battery icon in footer. */
  showStatusMeta?: boolean;
  /** Hide the bottom footer row completely. */
  hideFooter?: boolean;
  /** Reserve right margin in running header so bookmark silk ribbon never overlaps text. */
  hasBookmarkRibbon?: boolean;
  /** Whether outer reader HUD is currently visible (shows step buttons on touch screens). */
  hudVisible?: boolean;
  /** Optional 0..100 countdown progress bar along the bottom edge during auto-page reading. */
  autoReadProgress?: number | null;
  /** Page-turn animation preset ("cover" | "slide" | "fade" | "none"). */
  pageTurnAnim?: PageTurnAnim;
  /** Tap zone preset ("classic" | "onehand"). */
  tapZones?: ReaderTapZones;
  /** Listen to Android `lishi:volume-page` hardware key events. */
  volumeKeys?: boolean;
  /** Called when user taps/swipes past page 0 (e.g. previous chapter or loadMore). */
  onBoundaryStart?: () => void;
  /** Called when user taps/swipes past the last page (e.g. next chapter). */
  onBoundaryEnd?: () => void;
  /** Called when user taps the center reading zone (e.g. toggle HUD). */
  onCenterTap?: () => void;
  /** Called when user touches or manually interacts with the page stage. */
  onUserInteract?: () => void;
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
    jumpNonce,
    initialPage = 0,
    initialSelector,
    streaming = false,
    autoFollow = false,
    headerTitle,
    headerRight,
    footerLeft,
    readingEtaText = null,
    bookProgressPct = null,
    showStatusMeta = false,
    hideFooter = false,
    hasBookmarkRibbon = false,
    hudVisible = false,
    autoReadProgress = null,
    pageTurnAnim = "cover",
    tapZones = "classic",
    volumeKeys = false,
    onBoundaryStart,
    onBoundaryEnd,
    onCenterTap,
    onUserInteract,
    onPageChange,
    keyboard = true,
    className = "",
  },
  ref,
) {
  const stageRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const coverViewportRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(0);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [coverTurn, setCoverTurn] = useState<{
    dir: -1 | 1;
    leafPage: number;
    basePage: number;
    fromPx: number | null;
    tick: number;
  } | null>(null);
  const [fadeActive, setFadeActive] = useState(false);
  const [clockText, setClockText] = useState(() => formatClockNow());
  const [battery, setBattery] = useState<BatteryState | null>(null);

  const pageRef = useRef(0);
  pageRef.current = page;
  const totalRef = useRef(1);
  totalRef.current = totalPages;
  const followTailRef = useRef(initialPage === "last" || autoFollow);
  const initializedRef = useRef(false);
  const appliedJumpNonceRef = useRef<number | undefined>(jumpNonce);
  const anchorBeforeResizeRef = useRef<string | null>(null);
  const turnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelCooldownRef = useRef(0);
  const pendingReleaseDragRef = useRef(0);

  const effectiveAnim: PageTurnAnim = motionOn() ? pageTurnAnim : "none";
  const effectiveAnimRef = useRef<PageTurnAnim>(effectiveAnim);
  effectiveAnimRef.current = effectiveAnim;

  const stride = box.w > 0 ? box.w + COLUMN_GAP : 0;

  useEffect(
    () => () => {
      if (turnTimerRef.current) clearTimeout(turnTimerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    },
    [],
  );

  // Live HH:MM clock & optional Web Battery API for immersive book status footer
  useEffect(() => {
    if (!showStatusMeta || hideFooter) return;
    setClockText(formatClockNow());
    const clockTimer = setInterval(() => {
      setClockText(formatClockNow());
    }, 20_000);

    let live = true;
    let mgr: NavigatorBatteryManager | null = null;
    const syncBattery = () => {
      if (!live || !mgr) return;
      if (Number.isFinite(mgr.level)) {
        setBattery({
          level: Math.min(1, Math.max(0, mgr.level)),
          charging: !!mgr.charging,
        });
      }
    };
    const nav = typeof navigator !== "undefined"
      ? (navigator as Navigator & { getBattery?: () => Promise<NavigatorBatteryManager> })
      : null;
    if (typeof nav?.getBattery === "function") {
      void nav
        .getBattery()
        .then((b) => {
          if (!live || !b) return;
          mgr = b;
          syncBattery();
          b.addEventListener("levelchange", syncBattery);
          b.addEventListener("chargingchange", syncBattery);
        })
        .catch(() => {
          if (live) setBattery(null);
        });
    }

    return () => {
      live = false;
      clearInterval(clockTimer);
      if (mgr) {
        mgr.removeEventListener("levelchange", syncBattery);
        mgr.removeEventListener("chargingchange", syncBattery);
      }
    };
  }, [hideFooter, showStatusMeta]);

  // Clear any in-flight cover leaf when contentKey changes
  useEffect(() => {
    if (turnTimerRef.current) {
      clearTimeout(turnTimerRef.current);
      turnTimerRef.current = null;
    }
    setCoverTurn(null);
  }, [contentKey]);

  const triggerTurnVisual = useCallback(
    (prev: number, next: number) => {
      const releaseDrag = pendingReleaseDragRef.current;
      pendingReleaseDragRef.current = 0;
      if (prev === next) return;
      const anim = effectiveAnimRef.current;
      if (anim === "cover" && box.w > 0) {
        const dir: -1 | 1 = next > prev ? 1 : -1;
        const fromPx =
          dir > 0
            ? releaseDrag < -2
              ? releaseDrag
              : 0
            : releaseDrag > 2
              ? -box.w + releaseDrag
              : null;
        setCoverTurn((old) => ({
          dir,
          leafPage: dir > 0 ? prev : next,
          basePage: dir > 0 ? next : prev,
          fromPx,
          tick: (old?.tick ?? 0) + 1,
        }));
        if (turnTimerRef.current) clearTimeout(turnTimerRef.current);
        turnTimerRef.current = setTimeout(() => setCoverTurn(null), 290);
      } else if (anim === "fade") {
        setFadeActive(false);
        requestAnimationFrame(() => {
          setFadeActive(true);
          if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
          fadeTimerRef.current = setTimeout(() => setFadeActive(false), 190);
        });
      }
    },
    [box.w],
  );

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

  const findVisibleAnchor = useCallback(
    (attr = "data-node-id", targetPage = pageRef.current): string | null => {
      const stage = stageRef.current;
      const cols = columnsRef.current;
      if (!stage || !cols) return null;
      const sr = stage.getBoundingClientRect();
      if (sr.width <= 0) return null;
      const colsRect = cols.getBoundingClientRect();
      const colW = box.w > 0 ? box.w : sr.width;
      const s = colW + COLUMN_GAP;
      const colLeft = colsRect.left + targetPage * s;
      const colRight = colLeft + colW;
      const candidates = cols.querySelectorAll<HTMLElement>(`[${attr}]`);
      for (const el of candidates) {
        const rects = el.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i]!;
          if (r.right > colLeft + 6 && r.left < colRight - 6 && r.bottom > sr.top + 4) {
            return el.getAttribute(attr);
          }
        }
      }
      return null;
    },
    [box.w],
  );

  const measureColumns = useCallback(() => {
    const stage = stageRef.current;
    const cols = columnsRef.current;
    if (!stage || !cols || stage.clientWidth <= 0) return totalRef.current;
    const { w, h } = readStageInnerBox(stage);
    if (w <= 0 || h <= 0) return totalRef.current;
    if (w !== box.w || h !== box.h) {
      if (!anchorBeforeResizeRef.current) {
        anchorBeforeResizeRef.current = findVisibleAnchor("data-node-id") ?? findVisibleAnchor("data-para-index");
      }
      setBox({ w, h });
      return totalRef.current;
    }
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
      const prev = pageRef.current;
      followTailRef.current = clamped >= maxPage && autoFollow;
      pageRef.current = clamped;
      setPage(clamped);
      triggerTurnVisual(prev, clamped);
    },
    [autoFollow, triggerTurnVisual],
  );

  const jumpToSelector = useCallback(
    (selector: string): boolean => {
      const cols = columnsRef.current;
      if (!cols) return false;
      const target = cols.querySelector(selector);
      const p = pageOfElement(target);
      if (p === null) return false;
      const clamped = Math.max(0, Math.min(Math.max(0, totalRef.current - 1), p));
      const prev = pageRef.current;
      followTailRef.current = false;
      pageRef.current = clamped;
      setPage(clamped);
      triggerTurnVisual(prev, clamped);
      return true;
    },
    [pageOfElement, triggerTurnVisual],
  );

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

  useImperativeHandle(
    ref,
    () => ({
      page,
      totalPages,
      goToPage,
      goToLastPage: () => {
        const last = Math.max(0, totalRef.current - 1);
        const prev = pageRef.current;
        followTailRef.current = true;
        pageRef.current = last;
        setPage(last);
        triggerTurnVisual(prev, last);
      },
      stepBy,
      jumpToSelector,
      currentAnchorId: (attr = "data-node-id") => findVisibleAnchor(attr),
      remeasure: () => {
        measureColumns();
      },
    }),
    [findVisibleAnchor, goToPage, jumpToSelector, measureColumns, page, stepBy, totalPages, triggerTurnVisual],
  );

  // Observe stage size & content mutations cleanly
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const cols = columnsRef.current;
    if (!stage || !cols) return;
    if (stage.clientWidth > 0) {
      const { w, h } = readStageInnerBox(stage);
      if (w > 0 && h > 0 && (w !== box.w || h !== box.h)) {
        setBox({ w, h });
      }
    }
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      measureColumns();
    });
    ro.observe(stage);
    ro.observe(cols);
    return () => ro.disconnect();
  }, [box.h, box.w, measureColumns]);

  // Re-measure whenever content, typography variables, jumpNonce, or box dimensions change
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || stage.clientWidth <= 0) return;
    const { w, h } = readStageInnerBox(stage);
    if (w <= 0 || h <= 0) return;
    const count = measureColumns();
    if (box.w <= 0 || box.h <= 0) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      appliedJumpNonceRef.current = jumpNonce;
      if (initialSelector && jumpToSelector(initialSelector)) return;
      if (initialPage === "last") {
        followTailRef.current = true;
        const last = Math.max(0, count - 1);
        pageRef.current = last;
        setPage(last);
        return;
      }
      followTailRef.current = autoFollow;
      const start = Math.max(0, Math.min(count - 1, initialPage));
      pageRef.current = start;
      setPage(start);
      return;
    }
    if (jumpNonce !== appliedJumpNonceRef.current) {
      appliedJumpNonceRef.current = jumpNonce;
      anchorBeforeResizeRef.current = null;
      if (initialSelector && jumpToSelector(initialSelector)) return;
      if (initialPage === "last") {
        followTailRef.current = true;
        const last = Math.max(0, count - 1);
        const prev = pageRef.current;
        pageRef.current = last;
        setPage(last);
        triggerTurnVisual(prev, last);
        return;
      }
      followTailRef.current = autoFollow;
      const target = Math.max(0, Math.min(count - 1, initialPage));
      const prev = pageRef.current;
      pageRef.current = target;
      setPage(target);
      triggerTurnVisual(prev, target);
      return;
    }
    if ((streaming && (autoFollow || followTailRef.current)) || (followTailRef.current && initialPage === "last")) {
      anchorBeforeResizeRef.current = null;
      const last = Math.max(0, count - 1);
      if (pageRef.current !== last) {
        pageRef.current = last;
        setPage(last);
      }
      return;
    }
    if (anchorBeforeResizeRef.current) {
      const id = anchorBeforeResizeRef.current;
      anchorBeforeResizeRef.current = null;
      if (jumpToSelector(`[data-node-id="${CSS.escape(id)}"]`) || jumpToSelector(`[data-para-index="${CSS.escape(id)}"]`)) {
        return;
      }
    }
    if (pageRef.current >= count) {
      const clamped = Math.max(0, count - 1);
      pageRef.current = clamped;
      setPage(clamped);
    }
  }, [
    autoFollow,
    box.h,
    box.w,
    contentKey,
    initialPage,
    initialSelector,
    jumpNonce,
    jumpToSelector,
    measureColumns,
    streaming,
    triggerTurnVisual,
  ]);

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
    const stage = stageRef.current;
    if (!onPageChange || !stage || stage.clientWidth <= 0 || box.w <= 0 || box.h <= 0) return;
    const { w, h } = readStageInnerBox(stage);
    if (w <= 0 || h <= 0) return;
    const id = findVisibleAnchor("data-node-id") ?? findVisibleAnchor("data-para-index");
    onPageChange(page, totalPages, id);
  }, [box.h, box.w, findVisibleAnchor, onPageChange, page, totalPages]);

  const isOverlayOrInputActive = () => {
    const active = document.activeElement as HTMLElement | null;
    if (
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.tagName === "SELECT" ||
        active.isContentEditable)
    ) {
      return true;
    }
    return !!document.querySelector(".sheet-layer, .dialog, .panel:not(.docked)");
  };

  // Keyboard navigation (ArrowLeft/PageUp = prev, ArrowRight/PageDown/Space = next)
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const stage = stageRef.current;
      if (!stage || stage.clientWidth <= 0) return;
      const { w, h } = readStageInnerBox(stage);
      if (w <= 0 || h <= 0) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (isOverlayOrInputActive()) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        onUserInteract?.();
        stepBy(-1);
      } else if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) {
        e.preventDefault();
        onUserInteract?.();
        stepBy(1);
      } else if (e.key === " " && e.shiftKey) {
        e.preventDefault();
        onUserInteract?.();
        stepBy(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard, onUserInteract, stepBy]);

  // Android hardware volume-key page turning (`lishi:volume-page`)
  useEffect(() => {
    if (!volumeKeys) return;
    const onVolumePage = (ev: Event) => {
      const stage = stageRef.current;
      if (!stage || stage.clientWidth <= 0) return;
      const { w, h } = readStageInnerBox(stage);
      if (w <= 0 || h <= 0) return;
      if (isOverlayOrInputActive()) return;
      const detail = (ev as CustomEvent<"prev" | "next">).detail;
      if (detail === "prev" || detail === "next") {
        onUserInteract?.();
        stepBy(detail === "prev" ? -1 : 1);
      }
    };
    window.addEventListener("lishi:volume-page", onVolumePage);
    return () => window.removeEventListener("lishi:volume-page", onVolumePage);
  }, [onUserInteract, stepBy, volumeKeys]);

  // Desktop mouse wheel / trackpad page turning with smooth debounce
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || isOverlayOrInputActive()) return;
    const primary = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(primary) < 24) return;
    const now = performance.now();
    if (now - wheelCooldownRef.current < 240) return;
    wheelCooldownRef.current = now;
    onUserInteract?.();
    stepBy(primary > 0 ? 1 : -1);
  };

  // Pointer drag-follow swipe & edge tap zones (coexisting cleanly with long-press & text selection)
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
    if (!interactive) {
      onUserInteract?.();
    }
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
    if (effectiveAnim === "fade" || effectiveAnim === "none") return;
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
      const releasedOffset = dragOffset;
      setDragging(false);
      setDragOffset(0);
      if (!cancelled) {
        const threshold = Math.min(72, Math.max(40, box.w * 0.16));
        const velocity = Math.abs(dx) / dt;
        if (Math.abs(dx) >= threshold || velocity > 0.38) {
          pendingReleaseDragRef.current = releasedOffset;
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
    const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
    const relY = (e.clientY - rect.top) / Math.max(1, rect.height);
    const zone = resolveTapZone(relX, relY, tapZones);
    if (zone === "prev") stepBy(-1);
    else if (zone === "next") stepBy(1);
    else onCenterTap?.();
  };

  const visualDrag = effectiveAnim === "fade" || effectiveAnim === "none" ? 0 : dragOffset;

  // True Dual-Layer Cover Page-Turn physics:
  // - Live drag next (left): bottom sits at page+1, upper cover leaf holds page sliding left with finger.
  // - Live drag prev (right): bottom sits at page, upper cover leaf holds page-1 sliding in from -100%.
  // - Discrete 280ms turn: bottom sits stationary at basePage while upper cover leaf animates leafPage.
  const canCoverDragNext = dragging && effectiveAnim === "cover" && visualDrag < -2 && page < totalPages - 1 && box.w > 0;
  const canCoverDragPrev = dragging && effectiveAnim === "cover" && visualDrag > 2 && page > 0 && box.w > 0;
  const showLiveCoverDrag = canCoverDragNext || canCoverDragPrev;
  const showDiscreteCover = !dragging && effectiveAnim === "cover" && coverTurn !== null && box.w > 0;

  const activeCoverLeafPage = showLiveCoverDrag
    ? canCoverDragNext
      ? page
      : page - 1
    : showDiscreteCover
      ? coverTurn.leafPage
      : null;

  const baseDisplayPage = showLiveCoverDrag
    ? canCoverDragNext
      ? page + 1
      : page
    : showDiscreteCover
      ? coverTurn.basePage
      : page;

  const tx =
    stride <= 0
      ? 0
      : showLiveCoverDrag || showDiscreteCover
        ? -baseDisplayPage * stride
        : -page * stride + visualDrag;

  const liveCoverLeafX = canCoverDragNext ? visualDrag : -box.w + visualDrag;

  // Populate lightweight read-only column clone inside .paginator-cover-viewport ONLY while cover leaf is active
  useLayoutEffect(() => {
    const host = coverViewportRef.current;
    const source = columnsRef.current;
    if (!host) return;
    host.replaceChildren();
    if (activeCoverLeafPage === null || !source || box.w <= 0 || box.h <= 0) return;

    const clone = source.cloneNode(true) as HTMLDivElement;
    clone.removeAttribute("id");
    for (const el of clone.querySelectorAll(
      "[id],[data-node-id],[data-para-index],[role],[aria-live],[aria-label],button,input,textarea,select,a",
    )) {
      el.removeAttribute("id");
      el.removeAttribute("data-node-id");
      el.removeAttribute("data-para-index");
      el.removeAttribute("role");
      el.removeAttribute("aria-live");
      el.removeAttribute("aria-label");
      if (el instanceof HTMLElement) el.tabIndex = -1;
    }
    clone.style.width = `${box.w}px`;
    clone.style.height = `${box.h}px`;
    clone.style.columnWidth = `${box.w}px`;
    clone.style.columnGap = `${COLUMN_GAP}px`;
    clone.style.transition = "none";
    clone.style.animation = "none";
    clone.style.transform = `translate3d(${-activeCoverLeafPage * (box.w + COLUMN_GAP)}px, 0, 0)`;
    host.appendChild(clone);

    return () => {
      host.replaceChildren();
    };
  }, [activeCoverLeafPage, box.h, box.w, contentKey, coverTurn?.tick]);

  const animClass =
    dragging
      ? " is-dragging"
      : effectiveAnim === "cover"
        ? " anim-cover"
        : effectiveAnim === "slide"
          ? " anim-slide"
          : effectiveAnim === "fade"
            ? ` anim-fade${fadeActive ? " is-fading" : ""}`
            : " anim-none";

  const isLowBattery = !!battery && !battery.charging && battery.level <= 0.15;

  return (
    <div
      className={`paginator${animClass}${hudVisible ? " hud-shown" : ""}${className ? ` ${className}` : ""}`}
      data-anim={effectiveAnim}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finishPointer(e, false)}
      onPointerCancel={(e) => finishPointer(e, true)}
      onWheel={onWheel}
    >
      <div className="paginator-frame">
        {(headerTitle || headerRight) && (
          <header className={`paginator-header${hasBookmarkRibbon ? " has-ribbon" : ""}`} aria-hidden="true">
            <span className="ph-title">{headerTitle ?? ""}</span>
            {headerRight && <span className="ph-right">{headerRight}</span>}
          </header>
        )}
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
          {(showLiveCoverDrag || showDiscreteCover) && (
            <div
              key={showDiscreteCover ? `cover-${coverTurn.tick}` : "cover-live"}
              className={`paginator-cover-leaf${
                showDiscreteCover
                  ? coverTurn.dir > 0
                    ? " is-turning-next"
                    : " is-turning-prev"
                  : " is-live-drag"
              }`}
              aria-hidden="true"
              style={
                showLiveCoverDrag
                  ? { transform: `translate3d(${liveCoverLeafX}px, 0, 0)` }
                  : ({
                      "--cover-from":
                        coverTurn!.fromPx !== null
                          ? `${coverTurn!.fromPx}px`
                          : coverTurn!.dir > 0
                            ? "0px"
                            : "-104%",
                    } as React.CSSProperties)
              }
              onAnimationEnd={() => {
                if (turnTimerRef.current) {
                  clearTimeout(turnTimerRef.current);
                  turnTimerRef.current = null;
                }
                setCoverTurn(null);
              }}
            >
              <div className="paginator-cover-viewport" ref={coverViewportRef} />
              <div className="paginator-cover-shadow" />
            </div>
          )}
        </div>
        {!hideFooter && (
          <footer className={`paginator-footer${showStatusMeta ? " has-meta" : ""}`} data-no-page-tap="true">
            <span className="pf-title">{footerLeft ?? ""}</span>
            <span className="pf-controls">
              {showStatusMeta && readingEtaText && (
                <span className="pf-meta-item pf-eta">{readingEtaText}</span>
              )}
              {showStatusMeta && bookProgressPct != null && (
                <span className="pf-meta-item">全书 {bookProgressPct.toFixed(1)}%</span>
              )}
              <span className="pf-meta-item pf-pager">
                <button
                  type="button"
                  className="icon-btn pf-step"
                  aria-label="上一页"
                  disabled={page <= 0 && !onBoundaryStart}
                  onClick={() => stepBy(-1)}
                >
                  <Icon name="back" size={14} />
                </button>
                <span className="pf-count" aria-live="polite">
                  {page + 1}/{totalPages}
                </span>
                <button
                  type="button"
                  className="icon-btn pf-step"
                  aria-label="下一页"
                  disabled={page >= totalPages - 1 && !onBoundaryEnd}
                  onClick={() => stepBy(1)}
                >
                  <Icon name="forward" size={14} />
                </button>
              </span>
              {showStatusMeta && (
                <>
                  <span className="pf-meta-item pf-clock">{clockText}</span>
                  {battery && (
                    <span
                      className={`pf-battery${battery.charging ? " is-charging" : ""}${isLowBattery ? " is-low" : ""}`}
                      aria-label={`电量 ${Math.round(battery.level * 100)}%`}
                      title={`电量 ${Math.round(battery.level * 100)}%${battery.charging ? "（充电中）" : ""}`}
                    >
                      <svg width="20" height="11" viewBox="0 0 20 11" fill="none" aria-hidden="true">
                        <rect x="0.75" y="1" width="16.5" height="9" rx="2" stroke="currentColor" strokeWidth="1.2" />
                        <path d="M18.4 3.6v3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        <rect
                          x="2.3"
                          y="2.5"
                          width={Math.max(1.2, Number((13.4 * battery.level).toFixed(1)))}
                          height="6"
                          rx="1"
                          fill="currentColor"
                        />
                      </svg>
                    </span>
                  )}
                </>
              )}
            </span>
          </footer>
        )}
      </div>
      {autoReadProgress != null && autoReadProgress >= 0 && (
        <div className="paginator-autoread-bar" aria-hidden="true">
          <i style={{ width: `${Math.min(100, Math.max(0, autoReadProgress))}%` }} />
        </div>
      )}
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
