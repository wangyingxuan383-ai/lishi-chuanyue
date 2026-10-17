// The app's own dialogs (R11-T003): a confirmation and a name prompt in the
// 宣纸 style, instead of the browser's confirm()/prompt(). One at a time,
// opened from anywhere through useApp().ask / useApp().askName.
import { useEffect, useRef, useState } from "react";
import { useBack } from "../app/context";

export interface ConfirmRequest {
  kind: "confirm";
  /** Unique per request: the dialog's key. */
  id: number;
  title: string;
  message?: string;
  /** The button that does it, e.g. "删除". */
  confirm: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}
export interface NameRequest {
  kind: "name";
  id: number;
  title: string;
  initial: string;
  placeholder?: string;
  confirm?: string;
  resolve: (name: string | null) => void;
}
export type DialogRequest = ConfirmRequest | NameRequest;

export function Dialog({ request, onDone }: { request: DialogRequest; onDone: () => void }) {
  const [name, setName] = useState(request.kind === "name" ? request.initial : "");
  const input = useRef<HTMLInputElement>(null);
  const cancel = () => { if (request.kind === "confirm") request.resolve(false); else request.resolve(null); onDone(); };
  const ok = () => {
    if (request.kind === "confirm") request.resolve(true);
    else { if (!name.trim()) return; request.resolve(name.trim()); }
    onDone();
  };
  useBack(() => { cancel(); return true; });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (request.kind === "name") { input.current?.focus(); input.current?.select(); } else box.current?.focus(); }, []);
  return (
    <>
      <div className="backdrop dialog-backdrop" onClick={cancel} />
      <div ref={box} tabIndex={-1} className="dialog" role="alertdialog" aria-modal="true" aria-label={request.title}>
        <h2>{request.title}</h2>
        {request.kind === "confirm" && request.message && <p>{request.message}</p>}
        {request.kind === "name" && (
          <input ref={input} aria-label={request.title} value={name} placeholder={request.placeholder}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) ok(); }} />
        )}
        <div className="dialog-actions">
          <button onClick={cancel}>取消</button>
          <button className={request.kind === "confirm" && request.danger ? "danger-solid" : "primary"} disabled={request.kind === "name" && !name.trim()} onClick={ok}>
            {request.kind === "confirm" ? request.confirm : request.confirm ?? "保存"}
          </button>
        </div>
      </div>
    </>
  );
}
