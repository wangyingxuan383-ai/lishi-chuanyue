import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useApp, useBack } from "../app/context";
import { Icon } from "./Icon";

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
  const requestClose = () => {
    if (!dirty) { onClose(); return; }
    if (asking.current) return;
    asking.current = true;
    void ask({ title: "放弃修改？", message: "刚才改的内容还没有保存。", confirm: "放弃", danger: true })
      .then((ok) => { if (ok) onClose(); })
      .finally(() => { asking.current = false; });
  };
  useBack(() => {
    requestClose();
    return true;
  });
  return createPortal(
    <div className="sheet-layer">
      <div className="backdrop" onClick={requestClose} />
      <div className="sheet" role="dialog" aria-label={title}>
        <div className="sheet-handle" />
        <button className="sheet-close" aria-label="关闭" onClick={requestClose}><Icon name="close" size={22} /></button>
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

export function MenuSheet({ title, items, onClose }: { title?: string; items: MenuItem[]; onClose: () => void }) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="sheet-menu">
        {items.filter((i) => !i.hidden).map((item) => (
          <button key={item.label} className={item.danger ? "danger" : ""} onClick={() => { onClose(); item.onSelect(); }}>
            {item.label}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
