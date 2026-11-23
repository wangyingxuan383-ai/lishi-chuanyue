// 首页·场景: the story you were reading fills the first screen as a classical
// ink-wash landscape — three mountain ranges generated deterministically from
// the story's id, a focal pavilion/skiff/pine motif, sky tinted by the book's
// cloth colour and in-world hour, drifting mist and gold dust — with a zero-overlap
// grid layout from 320px phones up to desktop dual-column screens.
import { useMemo } from "react";
import { BookCover, TONES, seedOf } from "../../components/BookArt";
import { Icon } from "../../components/Icon";
import { useLongPress } from "../../components/useLongPress";
import { relative, type HomeViewProps, type WorldCard } from "./types";
import "./home-scene.css";

/**
 * A ridge of ink mountains across an 800×220 canvas (rendered with xMidYMax slice
 * so peaks keep natural proportions on wide screens instead of stretching flat).
 * Note: default box stays 400×120 when called with 2–3 args in existing tests,
 * while Landscape passes width=800, height=220 for crisp unstretched peaks.
 */
export function ridge(seed: number, layer: number, peaks = [6, 4, 3][layer] ?? 4, boxW = 400, boxH = 120): string {
  let s = (seed ^ Math.imul(layer + 1, 0x9e3779b1)) >>> 0;
  const rand = () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    s ^= s + Math.imul(s ^ (s >>> 7), 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
  const scaleY = boxH / 120;
  const top = ([24, 44, 72][layer] ?? 44) * scaleY;
  const low = ([84, 94, 106][layer] ?? 96) * scaleY;
  const width = boxW / peaks;
  let x = 0;
  let y = low - rand() * (low - top) * 0.3;
  let d = `M0 ${boxH} L0 ${y.toFixed(1)}`;
  for (let i = 0; i < peaks; i++) {
    const peakX = x + width * (0.3 + rand() * 0.4);
    const peakY = top + rand() * (low - top) * 0.4;
    const nextX = Math.min(boxW, x + width * (0.85 + rand() * 0.35));
    const nextY = low - rand() * (low - top) * 0.4;
    const shoulder = width * (0.18 + rand() * 0.14);
    d += ` C${(x + (peakX - x) * 0.5).toFixed(1)} ${(y - (y - peakY) * 0.1).toFixed(1)} ${(peakX - shoulder).toFixed(1)} ${peakY.toFixed(1)} ${peakX.toFixed(1)} ${peakY.toFixed(1)}`;
    d += ` C${(peakX + shoulder).toFixed(1)} ${peakY.toFixed(1)} ${(peakX + (nextX - peakX) * 0.5).toFixed(1)} ${(nextY - (nextY - peakY) * 0.15).toFixed(1)} ${nextX.toFixed(1)} ${nextY.toFixed(1)}`;
    x = nextX;
    y = nextY;
  }
  return `${d} L${boxW} ${y.toFixed(1)} L${boxW} ${boxH} Z`;
}

const daypart = (hour: number) => (hour >= 5 && hour < 8 ? "dawn" : hour >= 8 && hour < 17 ? "day" : hour >= 17 && hour < 20 ? "dusk" : "night");

function FocalMotif({ seed }: { seed: number }) {
  const kind = (seed >>> 6) % 3;
  if (kind === 0) {
    // 飞檐山亭: cliffside mountain pavilion with upturned eaves
    return (
      <svg className="scene-motif motif-pavilion" viewBox="0 0 80 60" aria-hidden="true">
        <path d="M16 32c10-2 18-7 24-14 6 7 14 12 24 14l-5 2.5H21z" />
        <path d="M26 34v14M35 34v14M45 34v14M54 34v14M20 48h40" stroke="currentColor" strokeWidth="1.8" fill="none" />
        <path d="M8 58c14-10 30-12 64-6v8H8z" opacity="0.85" />
      </svg>
    );
  }
  if (kind === 1) {
    // 扁舟孤影: lone skiff drifting across misty water
    return (
      <svg className="scene-motif motif-boat" viewBox="0 0 90 44" aria-hidden="true">
        <path d="M12 28c18 4 46 4 66-3-8 7-22 10-42 10-12 0-20-2-24-7z" />
        <path d="M36 28c4-5 12-5 18 0z" opacity="0.85" />
        <circle cx="30" cy="21" r="2.2" />
        <path d="M27 28l3-5 4 5M24 23l-8 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      </svg>
    );
  }
  // 悬崖苍松: wind-bent ancient pine reaching from rock
  return (
    <svg className="scene-motif motif-pine" viewBox="0 0 84 64" aria-hidden="true">
      <path d="M68 62c-8-14-16-24-28-28-6-2-14-1-22 2" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <path d="M40 34l-10-9M28 35l-12-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <ellipse cx="26" cy="24" rx="14" ry="4.5" />
      <ellipse cx="16" cy="31" rx="11" ry="3.8" />
      <ellipse cx="38" cy="28" rx="11" ry="3.8" />
      <path d="M54 64c4-12 14-18 30-16v16z" opacity="0.88" />
    </svg>
  );
}

function Landscape({ seed, part }: { seed: number; part: string }) {
  const layers = useMemo(() => [0, 1, 2].map((layer) => ridge(seed, layer, [7, 5, 4][layer], 800, 220)), [seed]);
  return (
    <div className="scene-art" aria-hidden="true">
      <div className="scene-sky" />
      <div className="scene-stars">
        {Array.from({ length: 9 }, (_, i) => (
          <i key={i} style={{ left: `${9 + ((seed + i * 37) % 82)}%`, top: `${7 + ((seed + i * 23) % 28)}%` }} />
        ))}
      </div>
      <div className="scene-sun">
        {part === "night" && (
          <svg className="scene-moon" viewBox="0 0 40 40">
            <path d="M25.5 6.5a14 14 0 109 24.2A12.2 12.2 0 0125.5 6.5z" />
          </svg>
        )}
      </div>
      {layers.map((d, layer) => (
        <svg key={layer} className={`scene-ridge ridge-${layer}`} viewBox="0 0 800 220" preserveAspectRatio="xMidYMax slice">
          <defs>
            <linearGradient id={`wash-${seed}-${layer}`} x1="0" y1="0" x2="0" y2="1">
              <stop className="w0" offset="0" />
              <stop className="w1" offset="0.58" />
              <stop className="w2" offset="1" />
            </linearGradient>
          </defs>
          <path d={d} fill={`url(#wash-${seed}-${layer})`} />
        </svg>
      ))}
      <FocalMotif seed={seed} />
      <svg className="scene-birds" viewBox="0 0 60 20">
        <path d="M2 8q4-4 8 0q4-4 8 0M30 4q3-3 6 0q3-3 6 0M46 13q2.5-2.5 5 0q2.5-2.5 5 0" />
      </svg>
      <div className="scene-mist" />
      <div className="scene-clouds"><i /><i /><i /></div>
      <div className="scene-dust">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ ["--k" as string]: i }} />)}</div>
    </div>
  );
}

function StripCard({ card, writing, onOpen, onMenu, index }: { card: WorldCard; writing: boolean; onOpen: HomeViewProps["onOpen"]; onMenu: HomeViewProps["onMenu"]; index: number }) {
  const press = useLongPress(() => onMenu(card), () => onOpen(card, document.querySelector(`[data-world-id="${card.world.id}"] .book-art`)));
  const tone = seedOf(card.world.id) % TONES;
  return (
    <div className={`strip-card tone-${tone}`} style={{ ["--i" as string]: index }}>
      <button className="world-open strip-open" data-world-id={card.world.id} {...press} aria-label={`继续“${card.world.title}”`}>
        <span className="strip-art" aria-hidden="true">
          <svg viewBox="0 0 400 120" preserveAspectRatio="xMidYMax slice">
            <path d={ridge(seedOf(card.world.id), 1, 5)} />
          </svg>
        </span>
        <BookCover seed={card.world.id} title={card.world.title} seal={card.seal} />
        <span className="strip-info">
          <b>{card.world.title}</b>
          <small>{card.protagonist}</small>
          <small className="meta">{writing ? <span className="writing-badge"><i aria-hidden="true" />正在写…</span> : relative(card.world.playedAt)}</small>
        </span>
      </button>
      <button className="icon-btn world-menu" aria-label={`“${card.world.title}”的更多操作`} onClick={() => onMenu(card)}><Icon name="more" /></button>
    </div>
  );
}

export function HomeScene({ cards, writing, onOpen, onMenu, newStory }: HomeViewProps) {
  const hero = cards[0];
  const seed = seedOf(hero.world.id);
  const part = daypart(hero.hour);
  const open = (target: Element | null) => onOpen(hero, (target?.closest(".home-scene")?.querySelector(".book-art") as HTMLElement | null) ?? null);
  const press = useLongPress(() => onMenu(hero), () => open(document.querySelector(".home-scene")));
  return (
    <div className={`home-scene-layout${cards.length > 1 ? " has-others" : ""}`}>
      <section className={`home-scene tone-${seed % TONES} at-${part}`} data-world-id={hero.world.id}>
        <Landscape seed={seed} part={part} />
        <button className="scene-hit world-open" {...press} aria-label={`继续“${hero.world.title}”`}>
          <span className="scene-heading">
            <span className="scene-kicker">{writing.has(hero.world.id) ? "正在写下一段" : `上次读到 · ${relative(hero.world.playedAt)}`}</span>
            <span className="scene-title">{hero.world.title}</span>
            <span className="scene-sub">{hero.protagonist} · {hero.clock}</span>
          </span>
          <span className="scene-book"><BookCover seed={hero.world.id} title={hero.world.title} seal={hero.seal} /></span>
        </button>
        <div className="scene-panel">
          {hero.lastLine && <p className="scene-line">{hero.lastLine}</p>}
          <div className="scene-actions">
            <span className="scene-meta">{writing.has(hero.world.id) ? <span className="writing-badge"><i aria-hidden="true" />正在写…</span> : hero.turns ? `${hero.turns} 回合` : "刚开局"}</span>
            <button className="icon-btn scene-menu" aria-label={`“${hero.world.title}”的更多操作`} onClick={() => onMenu(hero)}><Icon name="more" /></button>
            <button className="primary continue-btn" onClick={(e) => open(e.currentTarget)}><Icon name="play" size={16} />继续</button>
          </div>
        </div>
      </section>
      <div className="home-scene-side stack">
        {newStory}
        {cards.length > 1 && (
          <div className="list">
            <p className="section-title">其他故事</p>
            <div className="scene-strip">
              {cards.slice(1).map((card, i) => <StripCard key={card.world.id} card={card} index={i} writing={writing.has(card.world.id)} onOpen={onOpen} onMenu={onMenu} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
