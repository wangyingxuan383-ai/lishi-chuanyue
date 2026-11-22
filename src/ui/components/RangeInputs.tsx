// 从…到… for chapters of a book or turns of a story: 札记's range and 资料范围's chapters.
// Chapters count from 1; turns from 0, the opening, so the number matches “第 N 回合”.
// Keeps string draft state while typing (so mobile backspace can clear cleanly) and always
// renders each input's own chapter/turn description without swapping when `from > to`.
import { useEffect, useState } from "react";

export function RangeInputs({ last, from, to, setFrom, setTo, story = false, describe, total, disabled }: {
  last: number; from: number; to: number; setFrom: (n: number) => void; setTo: (n: number) => void;
  story?: boolean; describe: (n: number) => string; total: string; disabled?: boolean;
}) {
  const shift = story ? 1 : 0;
  const minDisplay = 1 - shift;
  const maxDisplay = last + 1 - shift;
  const toDisplay = (n: number) => String(n + 1 - shift);
  const [fromText, setFromText] = useState(() => toDisplay(from));
  const [toText, setToText] = useState(() => toDisplay(to));

  useEffect(() => { setFromText(toDisplay(from)); }, [from, shift]);
  useEffect(() => { setToText(toDisplay(to)); }, [to, shift]);

  const parse = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed || !/^-?\d+$/.test(trimmed)) return null;
    const value = Math.trunc(Number(trimmed));
    if (!Number.isSafeInteger(value)) return null;
    return Math.max(0, Math.min(last, value - 1 + shift));
  };

  const handleChange = (raw: string, setText: (s: string) => void, commit: (n: number) => void) => {
    setText(raw);
    const parsed = parse(raw);
    if (parsed !== null) commit(parsed);
  };

  const handleBlur = (raw: string, current: number, setText: (s: string) => void, commit: (n: number) => void) => {
    const parsed = parse(raw);
    const next = parsed ?? current;
    commit(next);
    setText(toDisplay(next));
  };

  const reversed = from > to;
  return <div className="stack gap-2 range-inputs">
    <div className="range-grid">
      <div className="range-field">
        <label>从{story ? "第" : "第"}<input type="text" inputMode="numeric" pattern="[0-9]*" min={minDisplay} max={maxDisplay} value={fromText} disabled={disabled}
          onChange={(e) => handleChange(e.target.value, setFromText, setFrom)}
          onBlur={() => handleBlur(fromText, from, setFromText, setFrom)}
          onKeyDown={(e) => { if (e.key === "Enter") handleBlur(fromText, from, setFromText, setFrom); }} />{story ? "回合" : "节"}</label>
        <small className="muted range-desc">{describe(from)}</small>
      </div>
      <div className="range-field">
        <label>到{story ? "第" : "第"}<input type="text" inputMode="numeric" pattern="[0-9]*" min={minDisplay} max={maxDisplay} value={toText} disabled={disabled}
          onChange={(e) => handleChange(e.target.value, setToText, setTo)}
          onBlur={() => handleBlur(toText, to, setToText, setTo)}
          onKeyDown={(e) => { if (e.key === "Enter") handleBlur(toText, to, setToText, setTo); }} />{story ? "回合" : "节"}</label>
        <small className="muted range-desc">{describe(to)}</small>
      </div>
    </div>
    {reversed && <small className="field-hint warn range-swap-hint">起止顺序相反，采用时会自动按小到大（{describe(Math.min(from, to))} ～ {describe(Math.max(from, to))}）。</small>}
    <small className="muted">{total}</small>
  </div>;
}
