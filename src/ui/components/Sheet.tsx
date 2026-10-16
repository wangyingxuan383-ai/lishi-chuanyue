import type { ReactNode } from "react";
import { useBack } from "../app/context";

/** Bottom sheet; the Android back button and a tap on the backdrop close it. */
export function Sheet({ title, onClose, children }: { title?: string; onClose: () => void; children: ReactNode }) {
  useBack(() => {
    onClose();
    return true;
  });
  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label={title}>
        <div className="sheet-handle" />
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </>
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
