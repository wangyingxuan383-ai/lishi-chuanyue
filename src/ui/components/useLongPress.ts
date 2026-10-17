import { useRef } from "react";
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
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  return {
    onPointerDown(e: React.PointerEvent) {
      // Only the main mouse button presses and holds; a right click is handled below.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const inner = (e.target as HTMLElement).closest("button, a, input, textarea, select");
      if (inner && inner !== e.currentTarget) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        if (document.documentElement.dataset.haptics !== "off") {
          // Native on Android (no VIBRATE permission there); navigator.vibrate elsewhere.
          void getPlatform().then((p) => p.system.haptic()).catch(() => {});
        }
        onLongPress();
      }, 450);
    },
    onPointerMove(e: React.PointerEvent) {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
    },
    onPointerUp() {
      const wasTap = start.current && !fired.current;
      cancel();
      if (wasTap) onTap?.();
    },
    onClick(e: React.MouseEvent) {
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
