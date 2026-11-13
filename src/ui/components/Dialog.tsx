// The app's own dialogs (R11-T003): a confirmation and a name prompt in the
// 宣纸 style, instead of the browser's confirm()/prompt(). One at a time,
// opened from anywhere through useApp().ask / useApp().askName.
import { useEffect, useRef, useState } from "react";
import { useBack } from "../app/context";
import { EXIT_MS, motionOn } from "../app/motion";

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
  // The answer goes back at once; the dialog then fades out before it is removed.
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const finish = () => {
    if (!motionOn()) { onDone(); return; }
    setClosing(true);
    timer.current = setTimeout(onDone, EXIT_MS);
  };
  const cancel = () => { if (closing) return; if (request.kind === "confirm") request.resolve(false); else request.resolve(null); finish(); };
  const ok = () => {
    if (closing) return;
    if (request.kind === "confirm") request.resolve(true);
    else { if (!name.trim()) return; request.resolve(name.trim()); }
    finish();
  };
  useBack(() => { cancel(); return true; });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (request.kind === "name") { input.current?.focus(); input.current?.select(); } else box.current?.focus(); }, []);
  return (
    <>
      <div className={`backdrop dialog-backdrop${closing ? " closing" : ""}`} onClick={cancel} />
      <div ref={box} tabIndex={-1} className={`dialog${closing ? " closing" : ""}`} role="alertdialog" aria-modal="true" aria-label={request.title}>
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
