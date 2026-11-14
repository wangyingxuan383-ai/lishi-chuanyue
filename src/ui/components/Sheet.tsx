import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useApp, useBack } from "../app/context";
import { EXIT_MS, motionOn } from "../app/motion";
import { Icon, type IconName } from "./Icon";

/**
 * Bottom sheet; the Android back button, a tap on the backdrop and the ×
 * close it. A sheet holding a form passes `dirty` while it has unsaved
 * changes: closing then asks "放弃修改？" first (saving still calls onClose
 * directly, so it is never asked).
 *
 * It is drawn on <body>, wherever it is opened from: inside a box that is
 * animating (a transform) or isolated, a fixed sheet would be laid out
 * within that box instead of over the screen (R14 review). Each sheet has
 * its own layer, so one opened from another, or from the character panel,
 * still covers and dims everything under it. React events still reach the
 * component that opened it.
 */
export function Sheet({ title, onClose, dirty = false, children }: { title?: string; onClose: () => void; dirty?: boolean; children: ReactNode }) {
  const { ask } = useApp();
  const asking = useRef(false);
  // Dismissing (back, backdrop, ×) lets the sheet sink away before it is removed.
  // Anything that unmounts the sheet first (a save, a menu choice) cancels the timer.
  const [closing, setClosing] = useState(false);
  const latest = useRef(onClose);
  latest.current = onClose;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const dismiss = () => {
    if (closing) return;
    if (!motionOn()) { latest.current(); return; }
    setClosing(true);
    timer.current = setTimeout(() => latest.current(), EXIT_MS);
  };
  const requestClose = () => {
    if (!dirty) { dismiss(); return; }
    if (asking.current) return;
    asking.current = true;
    void ask({ title: "放弃修改？", message: "刚才改的内容还没有保存。", confirm: "放弃", danger: true })
      .then((ok) => { if (ok) dismiss(); })
      .finally(() => { asking.current = false; });
  };
  useBack(() => {
    requestClose();
    return true;
  });
  // Pull the handle or the title down to close (R28 第二批): the sheet follows the finger,
  // and a long or quick pull lets it fall away; otherwise it springs back.
  const sheetRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number; t: number } | null>(null);
  const grab = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || closing || (e.target as Element).closest("button")) return;
      drag.current = { y: e.clientY, dy: 0, t: performance.now() };
      sheetRef.current?.classList.add("dragging");
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current, el = sheetRef.current;
      if (!d || !el) return;
      d.dy = Math.max(0, e.clientY - d.y);
      el.style.transform = `translateY(${d.dy}px)`;
      if (backdropRef.current) backdropRef.current.style.opacity = String(Math.max(0.2, 1 - d.dy / 400));
    },
    onPointerUp: () => {
      const d = drag.current, el = sheetRef.current;
      drag.current = null;
      if (!d || !el) return;
      el.classList.remove("dragging");
      const fast = d.dy / Math.max(1, performance.now() - d.t) > 0.7;
      if ((d.dy > 120 || (fast && d.dy > 30)) && !dirty && motionOn()) {
        el.classList.add("flung");
        el.style.transform = "translateY(105%)";
        if (backdropRef.current) { backdropRef.current.style.transition = "opacity 200ms ease-in"; backdropRef.current.style.opacity = "0"; }
        timer.current = setTimeout(() => latest.current(), 200);
        return;
      }
      el.classList.add("settle");
      el.style.transform = "";
      if (backdropRef.current) backdropRef.current.style.opacity = "";
      setTimeout(() => el.classList.remove("settle"), 450);
      if (d.dy > 120) requestClose();
    },
  };
  return createPortal(
    <div className={`sheet-layer${closing ? " closing" : ""}`}>
      <div ref={backdropRef} className="backdrop" onClick={requestClose} />
      <div ref={sheetRef} className="sheet" role="dialog" aria-label={title}>
        <div className="sheet-grab" {...grab} onPointerCancel={grab.onPointerUp}><div className="sheet-handle" /></div>
        <button className="sheet-close" aria-label="关闭" onClick={requestClose}><Icon name="close" size={22} /></button>
        {title && <h2 {...grab} onPointerCancel={grab.onPointerUp}>{title}</h2>}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  /** A line icon in front of the label (R28 第二批). */
  icon?: IconName;
  group?: string;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

export function MenuSheet({ title, items, onClose }: { title?: string; items: MenuItem[]; onClose: () => void }) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="sheet-menu">
        {items.filter((i) => !i.hidden).map((item, index, visible) => (
          <Fragment key={item.label}>
            {item.group && visible[index - 1]?.group !== item.group && <h3 className="settings-sub">{item.group}</h3>}
            <button className={`${item.danger ? "danger" : ""}${item.icon ? " with-icon" : ""}`} onClick={() => { onClose(); item.onSelect(); }}>{item.icon && <Icon name={item.icon} size={20} />}{item.label}</button>
          </Fragment>
        ))}
      </div>
    </Sheet>
  );
}
