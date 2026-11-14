// 首页·场景 (R29-T007, D163): the story you were reading fills the first screen
// as a landscape — ink mountains drawn from the story's id in three layers, its
// book-cloth colour and the story's hour in the sky, drifting clouds and gold
// dust — with the title large and a frosted panel to go on. The other stories
// follow in a strip you swipe through.
import { useMemo } from "react";
import { BookCover, TONES, seedOf } from "../../components/BookArt";
import { Icon } from "../../components/Icon";
import { useLongPress } from "../../components/useLongPress";
import { relative, type HomeViewProps, type WorldCard } from "./types";
import "./home-scene.css";

/**
 * A ridge of ink mountains across the scene, in a 400×120 box: steep-sided
 * peaks from the seed, far layers taller and busier, near ones broad and low.
 */
export function ridge(seed: number, layer: number, peaks = [6, 4, 3][layer] ?? 4): string {
  let s = (seed ^ Math.imul(layer + 1, 0x9e3779b1)) >>> 0;
  const rand = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; s ^= s + Math.imul(s ^ (s >>> 7), 61); return ((s ^ (s >>> 14)) >>> 0) / 4294967296; };
  const top = [24, 44, 72][layer] ?? 44, low = [84, 94, 106][layer] ?? 96;
  const width = 400 / peaks;
  let x = 0, y = low - rand() * (low - top) * 0.3;
  let d = `M0 120 L0 ${y.toFixed(1)}`;
  for (let i = 0; i < peaks; i++) {
    const peakX = x + width * (0.3 + rand() * 0.4), peakY = top + rand() * (low - top) * 0.4;
    const nextX = Math.min(400, x + width * (0.85 + rand() * 0.35)), nextY = low - rand() * (low - top) * 0.4;
    const shoulder = width * (0.18 + rand() * 0.14);
    // Ink-painting mountains: a soft rise, a rounded summit, a long shoulder down to the next valley.
    d += ` C${(x + (peakX - x) * 0.5).toFixed(1)} ${(y - (y - peakY) * 0.1).toFixed(1)} ${(peakX - shoulder).toFixed(1)} ${peakY.toFixed(1)} ${peakX.toFixed(1)} ${peakY.toFixed(1)}`;
    d += ` C${(peakX + shoulder).toFixed(1)} ${peakY.toFixed(1)} ${(peakX + (nextX - peakX) * 0.5).toFixed(1)} ${(nextY - (nextY - peakY) * 0.15).toFixed(1)} ${nextX.toFixed(1)} ${nextY.toFixed(1)}`;
    x = nextX; y = nextY;
  }
  return `${d} L400 ${y.toFixed(1)} L400 120 Z`;
}

const daypart = (hour: number) => (hour >= 5 && hour < 8 ? "dawn" : hour >= 8 && hour < 17 ? "day" : hour >= 17 && hour < 20 ? "dusk" : "night");

function Landscape({ seed }: { seed: number }) {
  const layers = useMemo(() => [0, 1, 2].map((layer) => ridge(seed, layer)), [seed]);
  return (
    <div className="scene-art" aria-hidden="true">
      <div className="scene-sky" />
      <div className="scene-sun" />
      {layers.map((d, layer) => (
        <svg key={layer} className={`scene-ridge ridge-${layer}`} viewBox="0 0 400 120" preserveAspectRatio="none">
          <defs><linearGradient id={`wash-${seed}-${layer}`} x1="0" y1="0" x2="0" y2="1"><stop className="w0" offset="0" /><stop className="w1" offset="0.55" /><stop className="w2" offset="1" /></linearGradient></defs>
          <path d={d} fill={`url(#wash-${seed}-${layer})`} />
        </svg>
      ))}
      <svg className="scene-birds" viewBox="0 0 60 20"><path d="M2 8q4-4 8 0q4-4 8 0M30 4q3-3 6 0q3-3 6 0M46 13q2.5-2.5 5 0q2.5-2.5 5 0" /></svg>
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
        <span className="strip-art" aria-hidden="true"><svg viewBox="0 0 400 120" preserveAspectRatio="none"><path d={ridge(seedOf(card.world.id), 1, 5)} /></svg></span>
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
  const open = (target: Element | null) => onOpen(hero, (target?.closest(".home-scene")?.querySelector(".book-art") as HTMLElement | null) ?? null);
  const press = useLongPress(() => onMenu(hero), () => open(document.querySelector(".home-scene")));
  return (
    <>
      <section className={`home-scene tone-${seed % TONES} at-${daypart(hero.hour)}`} data-world-id={hero.world.id}>
        <Landscape seed={seed} />
        <button className="scene-hit world-open" {...press} aria-label={`继续“${hero.world.title}”`}>
          <span className="scene-book"><BookCover seed={hero.world.id} title={hero.world.title} seal={hero.seal} /></span>
          <span className="scene-heading">
            <span className="scene-kicker">{writing.has(hero.world.id) ? "正在写下一段" : `上次读到 · ${relative(hero.world.playedAt)}`}</span>
            <span className="scene-title">{hero.world.title}</span>
            <span className="scene-sub">{hero.protagonist} · {hero.clock}</span>
          </span>
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
      {newStory}
      {cards.length > 1 && (
        <div className="list">
          <p className="section-title">其他故事</p>
          <div className="scene-strip">
            {cards.slice(1).map((card, i) => <StripCard key={card.world.id} card={card} index={i} writing={writing.has(card.world.id)} onOpen={onOpen} onMenu={onMenu} />)}
          </div>
        </div>
      )}
    </>
  );
}
