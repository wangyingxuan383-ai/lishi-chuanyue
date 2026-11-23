// Lightweight inline SVG Chinese classical ornaments & ink-wash vignettes:
// hand-carved stone seals (白文/朱文), thread-bound fishtail title cartouches,
// chapter hairline dividers, and album-leaf empty-state sketches. Zero bitmaps,
// zero external assets, and fully adaptive across paper/day/night & scroll/ink.
import type { ReactNode } from "react";
import "./chineseArt.css";

export type SealVariant = "yin" | "yang";
export type SealShape = "square" | "round" | "oval";

/**
 * Hand-carved cinnabar seal (石刻朱印).
 * `yin` (白文): cinnabar stone ground with carved paper-colored characters.
 * `yang` (朱文): warm paper ground with irregular stone-carved cinnabar rim and characters.
 */
export function CinnabarSeal({
  text,
  variant = "yin",
  shape = "square",
  size = 48,
  tilt = 0,
  muted = false,
  label,
  className = "",
}: {
  text: string;
  variant?: SealVariant;
  shape?: SealShape;
  size?: number;
  tilt?: number;
  muted?: boolean;
  label?: string;
  className?: string;
}) {
  const chars = [...text.trim()].filter(Boolean).slice(0, 4);
  if (!chars.length) chars.push("印");
  const isOval = shape === "oval";
  const w = isOval ? Math.round(size * 0.72) : size;
  const h = size;
  // Traditional 4-character seal order: right column top-to-bottom (0,1), left column top-to-bottom (2,3).
  const positions: { x: number; y: number; fs: number }[] =
    chars.length === 1
      ? [{ x: 50, y: 53, fs: 52 }]
      : chars.length === 2
        ? [
            { x: 50, y: 33, fs: 37 },
            { x: 50, y: 72, fs: 37 },
          ]
        : chars.length === 3
          ? [
              { x: 68, y: 52, fs: 32 },
              { x: 32, y: 34, fs: 29 },
              { x: 32, y: 71, fs: 29 },
            ]
          : [
              { x: 68, y: 34, fs: 30 },
              { x: 68, y: 71, fs: 30 },
              { x: 32, y: 34, fs: 30 },
              { x: 32, y: 71, fs: 30 },
            ];

  return (
    <svg
      className={`cinnabar-seal seal-${variant} seal-${shape}${muted ? " is-muted" : ""}${className ? ` ${className}` : ""}`}
      width={w}
      height={h}
      viewBox={isOval ? "0 0 72 100" : "0 0 100 100"}
      style={tilt ? { transform: `rotate(${tilt}deg)` } : undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {shape === "round" ? (
        <>
          <circle className="cs-ground" cx="50" cy="50" r="46" />
          <circle className="cs-rim" cx="50" cy="50" r="41.5" strokeDasharray="78 3 44 2.5 96 3" />
        </>
      ) : isOval ? (
        <>
          <rect className="cs-ground" x="4" y="4" width="64" height="92" rx="32" />
          <rect className="cs-rim" x="8.5" y="8.5" width="55" height="83" rx="27.5" strokeDasharray="64 2.5 52 3 88 2" />
        </>
      ) : (
        <>
          {/* Slightly organic hand-chiseled stone silhouette instead of a mechanical rectangle */}
          <path
            className="cs-ground"
            d="M7 4.5L48 4l45 .8c1.8.2 2.8 1.3 3 3.2L96.2 54 95.5 92.5c-.2 1.8-1.4 3-3.2 3.2L51 96.2 7.5 95.4c-1.8-.2-3-1.4-3.2-3.2L3.8 47 4.4 7.6C4.6 5.8 5.5 4.7 7 4.5z"
          />
          <path
            className="cs-rim"
            d="M11 10.5L53 10.2l36 .5.4 38-.5 40.3-42 .4-36-.5-.4-41z"
            strokeDasharray="68 2.8 46 2.2 84 3 52 2"
          />
          {/* Subtle stone-weathering nicks at two corners */}
          <circle className="cs-nick" cx="12" cy="87" r="1.8" />
          <circle className="cs-nick" cx="88" cy="14" r="1.4" />
        </>
      )}
      {chars.map((ch, idx) => {
        const p = positions[idx]!;
        const cx = isOval ? Math.round(p.x * 0.72) : p.x;
        return (
          <text
            key={idx}
            className="cs-char"
            x={cx}
            y={p.y}
            fontSize={isOval ? Math.round(p.fs * 0.84) : p.fs}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {ch}
          </text>
        );
      })}
    </svg>
  );
}

/**
 * Classical frontispiece / chapter header cartouche (卷首鱼尾题签):
 * double hairline frame (乌丝栏), traditional fishtail (鱼尾) mark, title, meta & optional seal.
 */
export function TitleCartouche({
  kicker,
  title,
  subtitle,
  seal,
  actions,
}: {
  kicker?: string;
  title: string;
  subtitle?: string;
  seal?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="title-cartouche">
      <div className="tc-fishtail" aria-hidden="true">
        <svg viewBox="0 0 36 14" width="36" height="14" focusable="false">
          <path d="M1 2h34v3l-17 7L1 5z" fill="currentColor" opacity="0.82" />
          <path d="M1 13h34" stroke="currentColor" strokeWidth="1" opacity="0.45" />
        </svg>
      </div>
      <div className="tc-body">
        <div className="tc-text">
          {kicker && <span className="tc-kicker">{kicker}</span>}
          <h2 className="tc-title">{title}</h2>
          {subtitle && <p className="tc-sub">{subtitle}</p>}
        </div>
        {seal && <CinnabarSeal text={seal} variant="yang" size={44} tilt={-3} />}
      </div>
      {actions && <div className="tc-actions">{actions}</div>}
    </header>
  );
}

/**
 * Chapter or section hairline ornament (章回纹饰) with optional centered label.
 */
export function ChapterOrnament({
  label,
  variant = "cloud",
}: {
  label?: string;
  variant?: "cloud" | "bamboo" | "knot";
}) {
  const motif =
    variant === "bamboo" ? (
      <svg className="co-motif" viewBox="0 0 36 14" width="32" height="13" aria-hidden="true" focusable="false">
        <path d="M4 9c5-1 9-4 13-7-1 4-4 7-9 9M19 7c5 0 9-2 13-5-2 4-5 6-10 7M15 9.5c3 1 6 2.2 8 3.5-3 .2-6-.6-8-3.5z" fill="currentColor" opacity="0.78" />
      </svg>
    ) : variant === "knot" ? (
      <svg className="co-motif" viewBox="0 0 28 14" width="26" height="13" aria-hidden="true" focusable="false">
        <path d="M14 2l5 5-5 5-5-5zM6 7l3-3 3 3-3 3zM16 7l3-3 3 3-3 3z" fill="none" stroke="currentColor" strokeWidth="1.15" />
      </svg>
    ) : (
      <svg className="co-motif" viewBox="0 0 36 14" width="34" height="13" aria-hidden="true" focusable="false">
        <path
          d="M18 3c-2.6 0-4.2 1.7-4.2 3.5 0 1.4.9 2.4 2.1 2.4 1 0 1.6-.6 1.6-1.3 0-.6-.4-1-1-1M18 3c2.6 0 4.2 1.7 4.2 3.5 0 1.4-.9 2.4-2.1 2.4-1 0-1.6-.6-1.6-1.3 0-.6.4-1 1-1M5 7.5c3.5 0 5.2-2 8.8-2M31 7.5c-3.5 0-5.2-2-8.8-2M12 10.5c2 1.2 4 1.8 6 1.8s4-.6 6-1.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    );

  return (
    <div className="chapter-ornament" role={label ? undefined : "presentation"} aria-hidden={label ? undefined : true}>
      <span className="co-line" aria-hidden="true" />
      {motif}
      {label && <span className="co-label">{label}</span>}
      {label && motif}
      <span className="co-line" aria-hidden="true" />
    </div>
  );
}

export type VignetteKind =
  | "desk-lamp"
  | "empty-satchel"
  | "tea-cups"
  | "distant-road"
  | "blank-bamboo"
  | "book-stack"
  | "mist-search";

function VignetteSvg({ kind }: { kind: VignetteKind }) {
  switch (kind) {
    case "desk-lamp":
      return (
        <svg className="ev-art" viewBox="0 0 160 100" aria-hidden="true" focusable="false">
          <ellipse cx="80" cy="82" rx="58" ry="7" fill="currentColor" opacity="0.06" />
          {/* Warm candle halo */}
          <circle cx="114" cy="34" r="22" fill="var(--accent)" opacity="0.1" />
          <circle cx="114" cy="34" r="10" fill="var(--accent)" opacity="0.18" />
          {/* Scholar's low table */}
          <path d="M22 72h116M32 72v14M128 72v14M28 76h104" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.55" />
          {/* Unrolled scroll & brush rest */}
          <path d="M40 67c0-3 2-5 5-5h42c3 0 5 2 5 5v5H40z" fill="currentColor" opacity="0.08" />
          <path d="M38 64v8M94 64v8M40 66h52M48 69h28" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.7" />
          <path d="M62 56l24-12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.78" />
          <path d="M58 58c2-.4 3.5-1.2 4.2-2.2" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
          {/* Oil lamp stand & flame */}
          <path d="M114 72V48M106 72h16M107 48h14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.68" />
          <path d="M114 30c3 4.2 3.2 8 0 11-3.2-3-3-6.8 0-11z" fill="var(--accent)" opacity="0.85" />
        </svg>
      );
    case "empty-satchel":
      return (
        <svg className="ev-art" viewBox="0 0 160 100" aria-hidden="true" focusable="false">
          <ellipse cx="80" cy="80" rx="46" ry="6" fill="currentColor" opacity="0.06" />
          {/* Soft cloth bundle (包袱) */}
          <path d="M52 46c0-10 12-16 28-16s28 6 28 16l4 24c0 5-5 8-12 8H60c-7 0-12-3-12-8z" fill="currentColor" opacity="0.07" />
          <path d="M52 48c2-11 13-17 28-17s26 6 28 17l3 22c0 5-5 8-12 8H61c-7 0-12-3-12-8z" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.68" />
          {/* Tied cloth knot & tassel */}
          <path d="M67 27c5 4 9 6 13 6s8-2 13-6M74 33c-3 5-6 9-10 12M86 33c3 5 6 9 10 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.75" />
          <circle cx="80" cy="33" r="3.2" fill="var(--accent)" opacity="0.78" />
          {/* Willow sprig */}
          <path d="M104 60c10-6 18-16 24-28M116 46c4-.5 7 .6 9 2.5M121 38c3.5-.6 6.2.4 8 2" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" opacity="0.45" />
        </svg>
      );
    case "tea-cups":
      return (
        <svg className="ev-art" viewBox="0 0 160 100" aria-hidden="true" focusable="false">
          <ellipse cx="80" cy="80" rx="52" ry="6" fill="currentColor" opacity="0.06" />
          {/* Tea tray */}
          <path d="M34 76h92l-5 5H39z" fill="currentColor" opacity="0.09" />
          <path d="M32 76h96" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.58" />
          {/* Teapot */}
          <path d="M52 54c0-7 7-12 16-12s16 5 16 12v14c0 4-4 8-16 8s-16-4-16-8z" fill="currentColor" opacity="0.08" />
          <path d="M52 54c0-7 7-12 16-12s16 5 16 12v14c0 4-4 8-16 8s-16-4-16-8zM44 53c-5 2-6 9 0 12l8 2M84 56l10-6M63 41h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
          <circle cx="68" cy="39" r="2.2" fill="var(--accent)" opacity="0.8" />
          {/* Two waiting cups & rising steam */}
          <path d="M100 63h15l-1.5 11c-.3 1.2-1.4 2-2.8 2h-6.4c-1.4 0-2.5-.8-2.8-2zM119 66h12l-1.2 8.5c-.2 1-1.1 1.5-2.2 1.5h-5.2c-1.1 0-2-.5-2.2-1.5z" fill="none" stroke="currentColor" strokeWidth="1.3" opacity="0.65" />
          <path d="M107 57c-2-4 2-7 0-11M125 60c-1.5-3.5 1.8-6 0-9.5" fill="none" stroke="var(--accent)" strokeWidth="1.15" strokeLinecap="round" opacity="0.55" />
        </svg>
      );
    case "distant-road":
      return (
        <svg className="ev-art" viewBox="0 0 160 100" aria-hidden="true" focusable="false">
          {/* Far ink hills */}
          <path d="M14 68c16-18 28-28 42-24s22 14 36 8 24-22 38-18 16 18 20 34z" fill="currentColor" opacity="0.07" />
          <path d="M18 68c15-16 27-25 40-22s22 13 36 8 24-21 37-17" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" opacity="0.45" />
          {/* Winding road */}
          <path d="M52 88c14-10 26-17 20-26-5-7 6-13 20-18M76 88c10-9 16-17 10-25-4-6 3-11 14-16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" opacity="0.62" />
          {/* Sun / moon seal in sky */}
          <circle cx="118" cy="24" r="7" fill="var(--accent)" opacity="0.72" />
          {/* Wayside pavilion eave */}
          <path d="M36 56c5-2 9-5 12-8 3 3 7 6 12 8M41 56v11M55 56v11M38 67h20" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" opacity="0.68" />
        </svg>
      );
    case "blank-bamboo":
      return (
        <svg className="ev-art" viewBox="0 0 160 100" aria-hidden="true" focusable="false">
          <ellipse cx="80" cy="82" rx="52" ry="6" fill="currentColor" opacity="0.06" />
          {[42, 56, 70, 84, 98].map((x, idx) => (
            <g key={x} opacity={0.72 - idx * 0.05}>
              <rect x={x} y={24 + (idx % 2) * 2} width="9.5" height="50" rx="1.5" fill="currentColor" fillOpacity="0.06" stroke="currentColor" strokeWidth="1.25" />
            </g>
          ))}
          {/* Binding cords */}
          <path d="M38 36h74M38 62h74" stroke="var(--accent)" strokeWidth="1.35" strokeLinecap="round" opacity="0.72" />
          {/* Resting calligraphy brush */}
          <path d="M116 74l16-42" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.75" />
          <path d="M114 79c1.8-1 2.8-2.8 2.4-5.2-1.8 1-3 2.8-2.4 5.2z" fill="var(--accent)" opacity="0.85" />
        </svg>
      );
    case "book-stack":
      return (
        <svg className="ev-art" viewBox="0 0 160 100" aria-hidden="true" focusable="false">
          <ellipse cx="80" cy="82" rx="52" ry="6" fill="currentColor" opacity="0.06" />
          {/* Three stacked thread-bound volumes */}
          <rect x="38" y="64" width="84" height="12" rx="2" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.3" opacity="0.72" />
          <rect x="44" y="50" width="76" height="12" rx="2" fill="currentColor" fillOpacity="0.05" stroke="currentColor" strokeWidth="1.3" opacity="0.68" />
          <rect x="40" y="36" width="74" height="12" rx="2" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.3" opacity="0.75" />
          {/* Spine stitching marks */}
          <path d="M52 36v12M66 36v12M80 36v12M58 50v12M74 50v12M50 64v12M68 64v12" stroke="currentColor" strokeWidth="1" opacity="0.45" />
          {/* Hanging bookmark ribbon */}
          <path d="M98 48v18l4-3 4 3V48" fill="var(--accent)" opacity="0.8" />
        </svg>
      );
    case "mist-search":
      return (
        <svg className="ev-art" viewBox="0 0 160 100" aria-hidden="true" focusable="false">
          <path d="M22 64c18-16 32-20 48-12s28 4 46-12 20 8 24 24z" fill="currentColor" opacity="0.07" />
          <path d="M18 54h54M86 46h52M30 68h78M68 78h56" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.38" />
          <circle cx="82" cy="48" r="14" fill="none" stroke="var(--accent)" strokeWidth="1.5" opacity="0.75" />
          <path d="M92 58l11 11" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" opacity="0.75" />
        </svg>
      );
  }
}

/**
 * Calm ink-wash empty-state vignette with title, optional hint, and optional CTA.
 */
export function EmptyVignette({
  kind,
  title,
  hint,
  action,
  compact = false,
}: {
  kind: VignetteKind;
  title?: string;
  hint?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-vignette${compact ? " compact" : ""}`}>
      <VignetteSvg kind={kind} />
      {title && <p className="ev-title">{title}</p>}
      {hint && <p className="ev-hint">{hint}</p>}
      {action && <div className="ev-action">{action}</div>}
    </div>
  );
}
