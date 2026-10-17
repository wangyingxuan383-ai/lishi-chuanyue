// AI 改写 and 润色 (R13-T103): the AI's version is a preview the player can
// edit; nothing changes until it is adopted. An adopted rewrite changes the
// passage in place and the first original can always be restored (恢复原文);
// a polished action only goes back into the input box. A result that arrives
// after a cancel, a new choice or a closed sheet is dropped.
import { useEffect, useRef, useState } from "react";
import { type WritingAnchor, type TextRange, paragraphs, replaceRange, startWriting, writingError } from "../../engine/writing/assist";
import type { ActionMode } from "../../engine/types";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import "./writing.css";

export interface WritingDraft { anchor: WritingAnchor; kind: "rewrite" | "polish"; text: string; mode: ActionMode }

const brief = (text: string, max = 12) => {
  const t = text.replace(/\s+/g, "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

export function WritingAssist({ draft, onClose, onAdopt }: {
  draft: WritingDraft; onClose: () => void; onAdopt: (text: string) => Promise<void>;
}) {
  const { game } = useApp();
  const rewrite = draft.kind === "rewrite";
  const ranges = paragraphs(draft.text);
  const whole: TextRange = { start: 0, end: draft.text.length };
  // A whole passage by default; a single paragraph is one tap away.
  const [range, setRange] = useState<TextRange>(whole);
  const [hint, setHint] = useState("");
  const [preview, setPreview] = useState("");
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const task = useRef<ReturnType<typeof startWriting> | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const stop = () => {
    generation.current++;
    task.current?.cancel();
    task.current = null;
    setPending(false);
    setReady(false);
    setPreview("");
  };
  const close = () => {
    if (saving) return;
    alive.current = false;
    stop();
    onClose();
  };
  useEffect(() => {
    alive.current = true;
    const visible = () => { if (document.visibilityState === "visible") void task.current?.catchUp(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive.current = false;
      generation.current++;
      task.current?.cancel();
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  const original = rewrite ? draft.text.slice(range.start, range.end) : draft.text;
  const choose = (next: TextRange) => {
    if (pending || saving) return;
    setRange(next);
    setReady(false);
    setPreview("");
    setError("");
  };
  const generate = async () => {
    if (pending || saving) return;
    const token = ++generation.current;
    setPending(true);
    setReady(false);
    setPreview("");
    setError("");
    const current = () => alive.current && token === generation.current;
    const work = startWriting(game, { ...draft, text: original, hint }, (text) => { if (current()) setPreview(text); });
    task.current = work;
    try {
      const text = await work.done;
      if (current()) { setPreview(text); setReady(true); }
    } catch (e) {
      if (current()) { setError(writingError(e)); setPreview(""); }
    } finally {
      if (current()) { setPending(false); task.current = null; }
    }
  };
  const adopt = async () => {
    if (!ready || saving || !preview.trim()) return;
    setSaving(true);
    setError("");
    try {
      await onAdopt(rewrite ? replaceRange(draft.text, range, preview) : preview);
      if (alive.current) onClose();
    } catch (e) {
      if (alive.current) setError(writingError(e));
    } finally {
      if (alive.current) setSaving(false);
    }
  };
  const isWhole = range.start === whole.start && range.end === whole.end;

  return (
    <Sheet title={rewrite ? "AI 改写" : "润色行动"} onClose={close}>
      <div className="stack writing-assist">
        {rewrite && <p className="muted">只改写法，情节和钱物不变；采用后随时可以恢复原文。</p>}
        {rewrite && ranges.length > 1 ? (
          <div className="writing-pick" role="radiogroup" aria-label="要改哪一段">
            <label className="writing-option all">
              <input type="radio" name="writing-range" aria-label="整段" checked={isWhole} disabled={pending || saving} onChange={() => choose(whole)} />
              <span>整段一起改</span>
            </label>
            {ranges.map((r, i) => (
              <label key={r.start} className="writing-option">
                <input type="radio" name="writing-range" aria-label={`第 ${i + 1} 段：${brief(draft.text.slice(r.start, r.end))}`}
                  checked={range.start === r.start && range.end === r.end} disabled={pending || saving} onChange={() => choose(r)} />
                <span>{draft.text.slice(r.start, r.end)}</span>
              </label>
            ))}
          </div>
        ) : <p className="writing-original">{original}</p>}
        <label>希望怎么改
          <input value={hint} disabled={pending || saving} onChange={(e) => { setHint(e.target.value); setReady(false); }} placeholder="可不填，如：简练一些、多些对话" />
        </label>
        {(preview || pending) && (
          <label>{pending ? <span className="cursor-blink" role="status">正在改稿</span> : "改稿（可以再改几个字）"}
            <textarea aria-label="改稿预览" value={preview} disabled={pending || saving} onChange={(e) => setPreview(e.target.value)} />
          </label>
        )}
        {error && <p role="alert" className="field-hint warn">{error}</p>}
        <div className="writing-actions">
          {pending
            ? <button onClick={() => { stop(); setError("已取消，原文没有改动。"); }}>取消生成</button>
            : <button disabled={saving} onClick={close}>取消</button>}
          {!pending && (
            <button className={preview ? "" : "primary"} disabled={saving || !original.trim()} onClick={() => void generate()}>{preview ? "再改一版" : "生成改稿"}</button>
          )}
          {ready && <button className="primary" disabled={saving || !preview.trim()} onClick={() => void adopt()}>{rewrite ? "采用改稿" : "采用到输入框"}</button>}
        </div>
      </div>
    </Sheet>
  );
}
