// 首页·画卷: Song-painting mineral blue-green & gilt landscape (千里江山青绿描金)
// by day and pine-soot moonlight with brushed gold (月夜松烟鎏金) at night/ink,
// complete with misty river shore reflections, Song pavilion/boat/pine vignettes,
// live multi-world scroll switcher, and Xuan-paper reading desk card.
import { useMemo, useState } from "react";
import { BookCover, TONES, seedOf } from "../../components/BookArt";
import { Icon } from "../../components/Icon";
import { useLongPress } from "../../components/useLongPress";
import { relative, type HomeViewProps, type WorldCard } from "./types";
import "./home-scene.css";

/**
 * Song blue-green landscape ridge with asymmetric main peaks, secondary shoulders,
 * and cascading foothills so mountains read like brushwork rather than sine waves.
 */
export function ridge(seed: number, layer: number, peaks = [6, 4, 3][layer] ?? 4, boxW = 400, boxH = 120): string {
  let s = (seed ^ Math.imul(layer + 1, 0x9e3779b1)) >>> 0;
  const rand = () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    s ^= s + Math.imul(s ^ (s >>> 7), 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
  const scaleY = boxH / 120;
  const top = ([20, 40, 68][layer] ?? 42) * scaleY;
  const low = ([82, 92, 106][layer] ?? 94) * scaleY;
  const span = low - top;
  const heroIdx = Math.floor(rand() * peaks);
  const width = boxW / peaks;
  let x = 0;
  let y = low - rand() * span * 0.25;
  let d = `M0 ${boxH} L0 ${y.toFixed(1)}`;
  for (let i = 0; i < peaks; i++) {
    const stepW = i === peaks - 1 ? boxW - x : width * (0.78 + rand() * 0.44);
    const nextX = Math.min(boxW, x + stepW);
    const isHero = i === heroIdx;
    const steepLeft = rand() > 0.45;
    const peakBias = steepLeft ? 0.26 + rand() * 0.16 : 0.56 + rand() * 0.18;
    const peakX = x + (nextX - x) * peakBias;
    const peakY = isHero ? top + rand() * span * 0.16 : top + span * (0.22 + rand() * 0.36);
    const nextY = low - rand() * span * 0.34;
    const ridgeX = peakX + (nextX - peakX) * (0.44 + rand() * 0.18);
    const ridgeY = peakY + (nextY - peakY) * (0.46 + rand() * 0.18);

    d += ` C${(x + (peakX - x) * 0.42).toFixed(1)} ${(y - (y - peakY) * 0.14).toFixed(1)} ${(peakX - (peakX - x) * 0.22).toFixed(1)} ${(peakY + span * 0.03).toFixed(1)} ${peakX.toFixed(1)} ${peakY.toFixed(1)}`;
    d += ` C${(peakX + (ridgeX - peakX) * 0.38).toFixed(1)} ${(peakY + span * 0.04).toFixed(1)} ${(ridgeX - (ridgeX - peakX) * 0.28).toFixed(1)} ${(ridgeY - span * 0.03).toFixed(1)} ${ridgeX.toFixed(1)} ${ridgeY.toFixed(1)}`;
    d += ` C${(ridgeX + (nextX - ridgeX) * 0.46).toFixed(1)} ${(ridgeY + (nextY - ridgeY) * 0.55).toFixed(1)} ${(nextX - (nextX - ridgeX) * 0.24).toFixed(1)} ${nextY.toFixed(1)} ${nextX.toFixed(1)} ${nextY.toFixed(1)}`;
    x = nextX;
    y = nextY;
    if (x >= boxW) break;
  }
  return `${d} L${boxW} ${y.toFixed(1)} L${boxW} ${boxH} Z`;
}

const daypart = (hour: number) => (hour >= 5 && hour < 8 ? "dawn" : hour >= 8 && hour < 17 ? "day" : hour >= 17 && hour < 20 ? "dusk" : "night");

/** Song-painting miniature motif nestled at the misty mountain-water junction above the Xuan card. */
function FocalMotif({ seed }: { seed: number }) {
  const kind = (seed >>> 6) % 3;
  if (kind === 0) {
    return (
      <svg className="scene-motif motif-pavilion" viewBox="0 0 112 72" aria-hidden="true">
        <path className="motif-cliff" d="M4 66c18-11 40-15 68-12 14 1.5 26 5 36 10v8H4z" />
        <path className="motif-roof" d="M22 30c14-2.5 24-9 32-17 8 8 18 14.5 32 17l-7 3.2H29z" />
        <path className="motif-gilt" d="M22 30c14-2.5 24-9 32-17 8 8 18 14.5 32 17" fill="none" />
        <path d="M35 33v18M46 33v18M62 33v18M73 33v18M28 51h52M31 46h46" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <path d="M16 56c16-4 46-5 76 1" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.55" fill="none" />
      </svg>
    );
  }
  if (kind === 1) {
    return (
      <svg className="scene-motif motif-boat" viewBox="0 0 116 54" aria-hidden="true">
        <path className="motif-cliff" d="M14 34c22 5 56 4.5 84-4-10 8.5-28 12.5-52 12.5-15 0-25-2.5-32-8.5z" />
        <path className="motif-roof" d="M44 34c5-8.5 19-8.5 26 0z" />
        <path className="motif-gilt" d="M45 33.5c5-7.5 18-7.5 24 0" fill="none" />
        <circle cx="36" cy="25.5" r="2.3" />
        <path d="M33 34l3-6 4.5 6M30 28l-11 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
        <path d="M18 45h42M52 49h38" stroke="currentColor" strokeWidth="1" strokeOpacity="0.42" strokeLinecap="round" fill="none" />
      </svg>
    );
  }
  return (
    <svg className="scene-motif motif-pine" viewBox="0 0 108 76" aria-hidden="true">
      <path className="motif-cliff" d="M58 74c5-16 18-24 46-21v21z" />
      <path d="M80 68c-9-16-19-28-34-33-8-2.5-18-1.5-28 2.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      <path d="M48 35l-12-10M34 37l-14-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <ellipse className="motif-roof" cx="32" cy="23" rx="16" ry="5" />
      <ellipse className="motif-roof" cx="19" cy="31" rx="13" ry="4.2" />
      <ellipse className="motif-roof" cx="46" cy="28" rx="13" ry="4.2" />
      <path className="motif-gilt" d="M18 22.5c8-3 19-3 28 0M8 30.5c6-2.2 15-2.2 22 0" fill="none" />
    </svg>
  );
}

function Landscape({ seed, part }: { seed: number; part: string }) {
  const layers = useMemo(() => [0, 1, 2].map((layer) => ridge(seed, layer, [7, 5, 4][layer], 800, 220)), [seed]);
  return (
    <div className="scene-art" aria-hidden="true">
      <div className="scene-sky" />
      <div className="scene-stars">
        {Array.from({ length: 11 }, (_, i) => {
          const rawLeft = 7 + ((seed + i * 37) % 85);
          const rawTop = 6 + ((seed + i * 23) % 28);
          // Keep bright star dots clear of the top-left story title & era zone so glyphs stay crisp.
          const safeLeft = rawLeft < 56 && rawTop > 11 ? 56 + (rawLeft % 36) : rawLeft;
          return <i key={i} style={{ left: `${safeLeft}%`, top: `${rawTop}%` }} />;
        })}
      </div>
      <div className="scene-sun">
        {part === "night" && (
          <svg className="scene-moon" viewBox="0 0 40 40">
            <path d="M25.5 6.5a14 14 0 109 24.2A12.2 12.2 0 0125.5 6.5z" />
          </svg>
        )}
      </div>
      <svg className="scene-birds" viewBox="0 0 60 20">
        <path d="M2 8q4-4 8 0q4-4 8 0M30 4q3-3 6 0q3-3 6 0M46 13q2.5-2.5 5 0q2.5-2.5 5 0" />
      </svg>
      <svg className="scene-ridge ridge-0" viewBox="0 0 800 220" preserveAspectRatio="xMidYMax slice">
        <defs>
          <linearGradient id={`wash-${seed}-0`} x1="0" y1="0" x2="0" y2="1">
            <stop className="w0" offset="0" />
            <stop className="w1" offset="0.55" />
            <stop className="w2" offset="1" />
          </linearGradient>
        </defs>
        <path className="ridge-fill" d={layers[0]} fill={`url(#wash-${seed}-0)`} />
        <path className="ridge-gilt ridge-gilt-far" d={layers[0]} fill="none" />
      </svg>
      <div className="scene-clouds"><i /><i /><i /><i /></div>
      {[1, 2].map((layer) => (
        <svg key={layer} className={`scene-ridge ridge-${layer}`} viewBox="0 0 800 220" preserveAspectRatio="xMidYMax slice">
          <defs>
            <linearGradient id={`wash-${seed}-${layer}`} x1="0" y1="0" x2="0" y2="1">
              <stop className="w0" offset="0" />
              <stop className="w1" offset="0.52" />
              <stop className="w2" offset="1" />
            </linearGradient>
          </defs>
          <path className="ridge-fill" d={layers[layer]} fill={`url(#wash-${seed}-${layer})`} />
          <path className="ridge-gilt" d={layers[layer]} fill="none" />
        </svg>
      ))}
      <div className="scene-mist" />
      {/* Misty river shore & shimmering water-ripple reflections */}
      <div className="scene-water">
        <svg className="scene-ripples" viewBox="0 0 600 70" preserveAspectRatio="none">
          <path d="M36 14h92M168 10h64M380 16h118M88 28h128M290 26h146M140 42h108M350 40h158M54 54h94M240 56h132" />
        </svg>
      </div>
      <FocalMotif seed={seed} />
      <div className="scene-dust">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ ["--k" as string]: i }} />)}</div>
    </div>
  );
}

const escId = (id: string) => (typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id);

function StripCard({
  card,
  writing,
  onOpen,
  onMenu,
  index,
}: {
  card: WorldCard;
  writing: boolean;
  onOpen: HomeViewProps["onOpen"];
  onMenu: HomeViewProps["onMenu"];
  index: number;
}) {
  const press = useLongPress(
    () => onMenu(card),
    () => onOpen(card, document.querySelector(`.strip-card [data-world-id="${escId(card.world.id)}"] .book-art`)),
  );
  const tone = seedOf(card.world.id) % TONES;
  return (
    <div className={`strip-card tone-${tone}`} style={{ ["--i" as string]: index }}>
      <button className="world-open strip-open" data-world-id={card.world.id} {...press} aria-label={`继续“${card.world.title}”`}>
        <span className="strip-cover-wrap">
          <BookCover seed={card.world.id} title={card.world.title} seal={card.seal} />
        </span>
        <span className="strip-info">
          <b className="strip-title">{card.world.title}</b>
          <small className="strip-sub">{card.protagonist} · {card.clock}</small>
          {card.lastLine && <span className="strip-line">{card.lastLine}</span>}
          <small className="strip-meta">
            {writing ? (
              <span className="writing-badge"><i aria-hidden="true" />正在写…</span>
            ) : (
              `${card.turns ? `${card.turns} 回 · ` : ""}${relative(card.world.playedAt)}`
            )}
          </small>
        </span>
      </button>
      <button className="icon-btn world-menu" aria-label={`“${card.world.title}”的更多操作`} onClick={() => onMenu(card)}>
        <Icon name="more" size={18} />
      </button>
    </div>
  );
}

/** Compact vertical era text for the Song-blockprint reign slip (竖排纪年签). */
function eraSlipLabel(clock: string, seal?: string): string {
  const trimmed = clock.split(/[·\s]/)[0]?.trim() || clock.trim();
  if (trimmed.length <= 7) return trimmed;
  return seal ? `${seal}·${trimmed.slice(0, 5)}` : trimmed.slice(0, 7);
}

export function HomeScene({ cards, writing, onOpen, onMenu, newStory }: HomeViewProps) {
  const [selectedId, setSelectedId] = useState(cards[0]?.world.id ?? "");
  const activeIdx = Math.max(0, cards.findIndex((c) => c.world.id === selectedId));
  const hero = cards[activeIdx] ?? cards[0];
  const seed = seedOf(hero.world.id);
  const part = daypart(hero.hour);
  const open = (target: Element | null) =>
    onOpen(hero, (target?.closest(".home-scene")?.querySelector(".book-art") as HTMLElement | null) ?? null);
  const press = useLongPress(() => onMenu(hero), () => open(document.querySelector(".home-scene")));
  const slipEra = eraSlipLabel(hero.clock, hero.seal);
  const isWriting = writing.has(hero.world.id);
  const otherCards = useMemo(() => cards.filter((_, idx) => idx !== activeIdx), [cards, activeIdx]);

  const stepWorld = (delta: number) => {
    const next = cards[(activeIdx + delta + cards.length) % cards.length];
    if (next) setSelectedId(next.world.id);
  };

  return (
    <div className={`home-scene-layout${cards.length > 1 ? " has-others" : ""}`}>
      <section className={`home-scene tone-${seed % TONES} at-${part}`} data-world-id={hero.world.id}>
        <Landscape seed={seed} part={part} />

        <div className="scene-topbar">
          <span className="scene-kicker">
            {isWriting ? "笔墨未歇 · 正在续写" : `上次展卷 · ${relative(hero.world.playedAt)}`}
          </span>
          {cards.length > 1 && (
            <span className="scene-stepper" role="group" aria-label="切换画卷世界">
              <button
                type="button"
                className="icon-btn scene-step-btn"
                aria-label="上一个世界"
                onClick={() => stepWorld(-1)}
              >
                <Icon name="back" size={14} />
              </button>
              <span className="scene-step-idx">{activeIdx + 1}/{cards.length}</span>
              <button
                type="button"
                className="icon-btn scene-step-btn"
                aria-label="下一个世界"
                onClick={() => stepWorld(1)}
              >
                <Icon name="forward" size={14} />
              </button>
            </span>
          )}
        </div>

        <button className="scene-hit world-open" {...press} aria-label={`继续“${hero.world.title}”`}>
          <span key={hero.world.id} className="scene-heading scene-switch-anim">
            <span className="scene-title">{hero.world.title}</span>
            <span className="scene-sub">
              <span className="scene-protagonist">{hero.protagonist}</span>
              <span className="scene-clock">{hero.clock}</span>
            </span>
          </span>
          <span key={`totem-${hero.world.id}`} className="scene-totem scene-switch-anim">
            {slipEra && (
              <span className="scene-era-slip" aria-hidden="true">
                {slipEra}
              </span>
            )}
            <span className="scene-book">
              <BookCover seed={hero.world.id} title={hero.world.title} seal={hero.seal} />
            </span>
          </span>
        </button>

        <div className="scene-bottom-stack">
          {cards.length > 1 && (
            <div className="scene-world-pills" role="tablist" aria-label="画卷预览世界">
              {cards.slice(0, 6).map((c, idx) => {
                const active = idx === activeIdx;
                return (
                  <button
                    key={c.world.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-label={`预览《${c.world.title}》`}
                    className={`scene-world-pill${active ? " active" : ""}`}
                    onClick={() => setSelectedId(c.world.id)}
                  >
                    <i className="pill-dot" aria-hidden="true" />
                    <span className="pill-name">{c.world.title}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="scene-panel">
            {hero.lastLine && <p className="scene-line">{hero.lastLine}</p>}
            <div className="scene-actions">
              <span className="scene-meta">
                {isWriting ? (
                  <span className="writing-badge"><i aria-hidden="true" />正在写…</span>
                ) : (
                  <span className="scene-turn-pill">
                    {hero.turns ? `第 ${hero.turns} 回` : "初入此世"}
                  </span>
                )}
              </span>
              <button
                className="icon-btn scene-menu"
                aria-label={`“${hero.world.title}”的更多操作`}
                onClick={() => onMenu(hero)}
              >
                <Icon name="more" />
              </button>
              <button className="primary continue-btn" onClick={(e) => open(e.currentTarget)}>
                <Icon name="brush" size={16} />
                <span>继续书写</span>
              </button>
            </div>
          </div>
        </div>
      </section>
      <div className="home-scene-side stack">
        {newStory}
        {otherCards.length > 0 && (
          <div className="list">
            <p className="section-title">其他故事</p>
            <div className="scene-strip story-strip">
              {otherCards.map((card, i) => (
                <StripCard
                  key={card.world.id}
                  card={card}
                  index={i}
                  writing={writing.has(card.world.id)}
                  onOpen={onOpen}
                  onMenu={onMenu}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
