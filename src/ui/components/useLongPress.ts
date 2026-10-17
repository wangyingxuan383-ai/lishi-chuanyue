import { useRef } from "react";

/**
 * Long press (≈450 ms) without moving; a scroll gesture cancels it. A press
 * that starts on a button inside belongs to that button (AUDIT 4.4: a long
 * press on 重说 also opened the passage's menu).
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
      const inner = (e.target as HTMLElement).closest("button, a, input, textarea, select");
      if (inner && inner !== e.currentTarget) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        fired.current = true;
        if (document.documentElement.dataset.haptics !== "off") navigator.vibrate?.(10);
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
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu(e: React.MouseEvent) {
      e.preventDefault();
    },
  };
}
