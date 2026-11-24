// Local art for the bookshelf, the novel studio, and the people list:
// every volume is a thread-bound book (线装书) — a layered Song-brocade cloth board,
// spine fold crease, geometric silk corner guards (包角), four-hole silk stitching
// along the spine, a double-framed ivory Xuan title slip (题签), an optional
// cinnabar seal, and a subtle crimson silk bookmark ribbon tail. Pure inline SVG.
import "./bookArt.css";

export function seedOf(text: string): number {
  let seed = 2166136261;
  for (const c of text) seed = Math.imul(seed ^ c.codePointAt(0)!, 16777619);
  return seed >>> 0;
}

/** Book-cloth colours: .cover-0 … .cover-7 in bookArt.css. */
export const TONES = 8;

/** Curated Song-brocade cloth swatches for custom cover selection in 书斋. */
export const COVER_TONE_NAMES: readonly { tone: number; name: string; hex: string }[] = [
  { tone: 0, name: "靛青", hex: "#34506b" },
  { tone: 1, name: "赭石", hex: "#8a5a3c" },
  { tone: 2, name: "黛绿", hex: "#415e52" },
  { tone: 3, name: "绛红", hex: "#6e3b42" },
  { tone: 4, name: "苍青", hex: "#55626b" },
  { tone: 5, name: "栗壳", hex: "#6b5036" },
  { tone: 6, name: "暮紫", hex: "#5b4f66" },
  { tone: 7, name: "秋香", hex: "#6f6a3e" },
];

const HAN = /\p{Script=Han}/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The characters on the title slip: the title's first five Chinese characters,
 * falling back to letters/digits so pure numeric or foreign titles (e.g. "1840")
 * never produce a blank white slip.
 */
export function slipText(title: string): string[] {
  const han = [...title].filter((c) => HAN.test(c)).slice(0, 5);
  if (han.length) return han;
  const fallback = [...title.trim()].filter((c) => WORD_CHAR.test(c)).slice(0, 5);
  return fallback.length ? fallback.map((c) => c.toUpperCase()) : ["无", "题"];
}

export interface BookCoverProps {
  seed: string;
  title: string;
  seal?: string;
  tone?: number | null;
  badge?: string;
}

/**
 * A volume's cover. `seal` is one character (唐、宋、明…); `tone` overrides the
 * deterministic cloth palette (`0..7`) when customized in 书斋.
 */
export function BookCover({ seed, title, seal, tone, badge }: BookCoverProps) {
  const chars = slipText(title);
  const tight = chars.length > 4;
  const step = tight ? 8.6 : 10.4;
  const resolvedTone =
    typeof tone === "number" && Number.isFinite(tone)
      ? ((Math.trunc(tone) % TONES) + TONES) % TONES
      : seedOf(seed) % TONES;
  return (
    <svg className={`book-art cover-${resolvedTone}`} viewBox="0 0 60 84" aria-hidden="true" focusable="false">
      {/* Subtle crimson silk bookmark ribbon tail peeking beneath the pages */}
      <path className="cover-ribbon" d="M21.5 82.8V87.2L23.8 85.4L26.1 87.2V82.8Z" />
      <rect className="cover-board" x="0.5" y="0.5" width="59" height="83" rx="1.8" />
      {/* Layered diagonal silk weave highlight & deep spine shadow */}
      <path className="cover-sheen" d="M1.2 1.2H50.2V42L1.2 68Z" />
      <rect className="cover-spine-band" x="50.4" y="1" width="8.6" height="82" rx="1" />
      {/* Spine fold groove & ivory silk catchlight */}
      <path className="cover-crease-dark" d="M50.2 1V83" />
      <path className="cover-crease-light" d="M51 1V83" />
      {/* Song-brocade geometric corner guards (锦包角) at corners & spine caps */}
      <path
        className="cover-brocade"
        d="M1 10.5H8.5V1M1 7.5H5.5V1M1 73.5H8.5V83M1 76.5H5.5V83M48.5 1V6.5H59M48.5 83V77.5H59"
      />
      {/* 四眼订装: silk binding cord along the spine and wrapping across the right edge */}
      <path className="cover-thread" d="M53.6 1V83M53.6 12H59.5M53.6 31.5H59.5M53.6 52.5H59.5M53.6 72H59.5" />
      <circle className="cover-knot" cx="53.6" cy="12" r="0.95" />
      <circle className="cover-knot" cx="53.6" cy="31.5" r="0.95" />
      <circle className="cover-knot" cx="53.6" cy="52.5" r="0.95" />
      <circle className="cover-knot" cx="53.6" cy="72" r="0.95" />
      {/* Double-framed ivory Xuan title slip (乌丝栏题签) */}
      <rect className="cover-slip-shadow" x="7.6" y="6.8" width="15.6" height="53" rx="0.6" />
      <rect className="cover-slip" x="7" y="6" width="15.6" height="53" rx="0.6" />
      <rect className="cover-slip-frame" x="8.3" y="7.3" width="13" height="50.4" />
      <rect className="cover-slip-inner" x="9.2" y="8.3" width="11.2" height="48.4" />
      <path className="cover-slip-ticks" d="M9.2 10.6H20.4M9.2 54.4H20.4" />
      {chars.map((c, i) => (
        <text key={i} className={`cover-title${tight ? " tight" : ""}`} x="14.8" y={(tight ? 17.2 : 18.4) + i * step} textAnchor="middle">{c}</text>
      ))}
      {seal && (
        <>
          <rect className="cover-seal" x="8.8" y="63.6" width="12" height="12" rx="0.9" />
          <rect className="cover-seal-frame" x="10" y="64.8" width="9.6" height="9.6" />
          <text className="cover-seal-mark" x="14.8" y="72.9" textAnchor="middle">{seal}</text>
        </>
      )}
      {badge && (
        <g className="cover-badge-group">
          <rect className="cover-badge-bg" x="28" y="69.5" width="19" height="8.5" rx="1.4" />
          <text className="cover-badge-text" x="37.5" y="75.3" textAnchor="middle">{badge.slice(0, 4)}</text>
        </g>
      )}
    </svg>
  );
}

/** A person's name seal: the first character of the name, red on paper; faded for the dead. */
export function PersonAvatar({ name, dead = false }: { name: string; dead?: boolean }) {
  return <span className={`person-avatar${dead ? " dead" : ""}`} aria-hidden="true">{[...name.trim()][0] ?? "人"}</span>;
}
