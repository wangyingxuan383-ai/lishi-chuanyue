import { useEffect, useRef } from "react";
import { getPlatform } from "../../platform";

/**
 * Long press (≈450 ms) without moving; a scroll gesture cancels it. A press
 * that starts on a button inside belongs to that button (AUDIT 4.4: a long
 * press on 重说 also opened the passage's menu). With a mouse, a right click
 * does what a long press does (UX_APP_BASICS #57); touch keeps the long press.
 * A click with no pointer press before it (Enter, Space, a screen reader's
 * double tap) is a tap too.
 */
export function useLongPress(onLongPress: () => void, onTap?: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const ghostTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cleanupGhost = useRef<(() => void) | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const clearGhost = () => {
    clearTimeout(ghostTimer.current);
    cleanupGhost.current?.();
    cleanupGhost.current = null;
  };
  // Suppresses the single synthetic click Android WebView dispatches when a finger
  // lifts at 450–500 ms right after PassageMenu's backdrop/buttons mount under it (B29).
  const armGhostClickGuard = () => {
    clearGhost();
    const onCaptureClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      fired.current = false;
      clearGhost();
    };
    let onNextPointerDown: (() => void) | null = null;
    const onRelease = () => {
      window.removeEventListener("pointerup", onRelease, true);
      window.removeEventListener("pointercancel", onRelease, true);
      clearTimeout(ghostTimer.current);
      // Once a fresh press starts on the newly opened menu, the old gesture cannot emit a ghost click.
      onNextPointerDown = () => {
        fired.current = false;
        clearGhost();
      };
      window.addEventListener("pointerdown", onNextPointerDown, true);
      ghostTimer.current = setTimeout(() => {
        fired.current = false;
        clearGhost();
      }, 600);
    };
    window.addEventListener("click", onCaptureClick, true);
    window.addEventListener("pointerup", onRelease, true);
    window.addEventListener("pointercancel", onRelease, true);
    cleanupGhost.current = () => {
      window.removeEventListener("click", onCaptureClick, true);
      window.removeEventListener("pointerup", onRelease, true);
      window.removeEventListener("pointercancel", onRelease, true);
      if (onNextPointerDown) window.removeEventListener("pointerdown", onNextPointerDown, true);
    };
    ghostTimer.current = setTimeout(() => {
      fired.current = false;
      clearGhost();
    }, 4000);
  };
  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  useEffect(() => () => {
    cancel();
    clearGhost();
  }, []);

  return {
    onPointerDown(e: React.PointerEvent) {
      if (!e.isPrimary) return;
      // Only the main mouse button presses and holds; a right click is handled below.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const inner = (e.target as HTMLElement).closest("button, a, input, textarea, select");
      if (inner && inner !== e.currentTarget) return;
      clearGhost();
      clearTimeout(timer.current);
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        armGhostClickGuard();
        if (document.documentElement.dataset.haptics !== "off") {
          // Native on Android (no VIBRATE permission there); navigator.vibrate elsewhere.
          void getPlatform().then((p) => p.system.haptic()).catch(() => {});
        }
        onLongPress();
      }, 450);
    },
    onPointerMove(e: React.PointerEvent) {
      if (e.isPrimary === false) return;
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
    },
    onPointerUp(e?: React.PointerEvent) {
      if (e && e.isPrimary === false) return;
      const wasTap = start.current && !fired.current;
      cancel();
      if (wasTap) onTap?.();
    },
    onClick(e: React.MouseEvent) {
      if (fired.current) {
        fired.current = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // A pointer click (detail ≥ 1) was handled on pointer up.
      if (e.detail !== 0) return;
      const inner = (e.target as HTMLElement).closest("button, a, input, textarea, select");
      if (inner && inner !== e.currentTarget) return;
      onTap?.();
    },
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu(e: React.MouseEvent) {
      e.preventDefault();
      const inner = (e.target as HTMLElement).closest("button, a, input, textarea, select");
      if (inner && inner !== e.currentTarget) return;
      // Touch screens also send a context menu on a long press; the timer above already handles that.
      const type = (e.nativeEvent as PointerEvent).pointerType;
      const mouse = type ? type === "mouse" : matchMedia("(hover: hover) and (pointer: fine)").matches;
      if (!mouse) return;
      e.stopPropagation();
      cancel();
      onLongPress();
    },
  };
}
