// 字号与主题 (R28): the reading settings used most, one tap from the story.
// The same values as 设置 → 阅读与外观; the change shows at once behind the sheet.
import { useApp, type Reading } from "../../app/context";
import { Sheet } from "../../components/Sheet";
import { Choice, SIZES, STYLES, THEMES } from "../Settings";

export function ReadingQuickSheet({ onClose }: { onClose: () => void }) {
  const { reading, setReading } = useApp();
  const set = (patch: Partial<Reading>) => setReading({ ...reading, ...patch });
  const sizes = SIZES.map(([v]) => v);
  const at = sizes.indexOf(reading.size);
  const step = (by: number) => {
    // A size set elsewhere (not one of the four) moves to its nearest neighbour.
    const index = at >= 0 ? at + by : by > 0 ? sizes.findIndex((v) => v > reading.size) : sizes.reduce((found, v, i) => (v < reading.size ? i : found), -1);
    if (index >= 0 && index < sizes.length) set({ size: sizes[index] });
  };
  const label = SIZES.find(([v]) => v === reading.size)?.[1] ?? `${reading.size}`;
  return (
    <Sheet title="字号与主题" onClose={onClose}>
      <div className="setting">
        <div className="setting-head"><b>字号</b></div>
        <div className="size-stepper">
          <button aria-label="字号小一些" disabled={reading.size <= sizes[0]} onClick={() => step(-1)}><span className="size-a small-a">A</span>−</button>
          <span className="size-now" aria-live="polite">{label}</span>
          <button aria-label="字号大一些" disabled={reading.size >= sizes[sizes.length - 1]} onClick={() => step(1)}><span className="size-a">A</span>+</button>
        </div>
      </div>
      <div className="setting">
        <div className="setting-head"><b>明暗</b></div>
        <div className="theme-cards">
          {THEMES.map(([v, l]) => (
            <button key={v} aria-pressed={reading.theme === v} className={`theme-card theme-${v}`} onClick={() => set({ theme: v })}><span className="swatch" aria-hidden="true" />{l}</button>
          ))}
        </div>
      </div>
      <Choice label="外观风格" value={reading.style} options={STYLES.map(([v, l]) => [v, l] as [typeof v, string])} onChange={(v) => set({ style: v })} />
      <Choice label="行距" value={reading.leading} options={[[1.7, "紧"], [2, "适中"], [2.3, "松"]]} onChange={(v) => set({ leading: v })} />
    </Sheet>
  );
}
