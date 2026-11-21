// 从…到… for chapters of a book or turns of a story: 札记's range and 资料范围's chapters.
// Chapters count from 1; turns from 0, the opening, so the number matches “第 N 回合”.
export function RangeInputs({ last, from, to, setFrom, setTo, story = false, describe, total, disabled }: {
  last: number; from: number; to: number; setFrom: (n: number) => void; setTo: (n: number) => void;
  story?: boolean; describe: (n: number) => string; total: string; disabled?: boolean;
}) {
  const shift = story ? 1 : 0;
  const read = (value: string) => Math.max(0, Math.min(last, Math.trunc(Number(value)) - 1 + shift || 0));
  return <div className="stack gap-2">
    <label>从{story ? "第" : ""}<input type="number" inputMode="numeric" min={1 - shift} max={last + 1 - shift} value={from + 1 - shift} disabled={disabled} onChange={(e) => setFrom(read(e.target.value))} />{story ? "回合" : ""}</label>
    <small className="muted">{describe(Math.min(from, to))}</small>
    <label>到{story ? "第" : ""}<input type="number" inputMode="numeric" min={1 - shift} max={last + 1 - shift} value={to + 1 - shift} disabled={disabled} onChange={(e) => setTo(read(e.target.value))} />{story ? "回合" : ""}</label>
    <small className="muted">{describe(Math.max(from, to))}（{total}）</small>
  </div>;
}
