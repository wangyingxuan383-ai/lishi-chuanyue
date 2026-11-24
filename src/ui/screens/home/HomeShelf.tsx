// 首页·书阁 (HomeShelf.tsx v3): Zero-clipping Song-scholar Bogu gallery
// (明窗净几·温润浅胡桃博古架 / 乌木描金博古阁) with upright Bogu dividers,
// sky-blue Ru-ware celadon vase & plum blossom curio, front-leaning featured
// volume display, and zero-truncation reading desk slip.
import { Fragment, useEffect, useState } from "react";
import { BookCover, TONES, seedOf, slipText } from "../../components/BookArt";
import { Icon } from "../../components/Icon";
import { useLongPress } from "../../components/useLongPress";
import { relative, type HomeViewProps, type WorldCard } from "./types";
import "./home-shelf.css";

function computePerRow(): number {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return 7;
  if (window.matchMedia("(max-width: 359px)").matches) return 3;
  if (window.matchMedia("(max-width: 459px)").matches) return 5;
  if (window.matchMedia("(min-width: 960px)").matches) return 7;
  if (window.matchMedia("(min-width: 680px)").matches) return 8;
  return 6;
}

function useShelfPerRow(): number {
  const [perRow, setPerRow] = useState(computePerRow);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const update = () => setPerRow(computePerRow());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return perRow;
}

function ShelfBook({
  card,
  featured,
  writing,
  onTap,
  onMenu,
  index,
}: {
  card: WorldCard;
  featured: boolean;
  writing: boolean;
  onTap: (card: WorldCard) => void;
  onMenu: HomeViewProps["onMenu"];
  index: number;
}) {
  const seed = seedOf(card.world.id);
  const press = useLongPress(() => onMenu(card), () => onTap(card));
  const spine = slipText(card.world.title).slice(0, 6);
  const height = 130 + (seed % 5) * 5;
  const thick = 26 + ((seed >>> 3) % 3) * 2;
  return (
    <button
      className={`shelf-book tone-${seed % TONES}${featured ? " featured" : ""}${writing ? " writing" : ""}`}
      data-world-id={card.world.id}
      {...press}
      style={{ ["--bh" as string]: `${height}px`, ["--bt" as string]: `${thick}px`, ["--i" as string]: index }}
      aria-pressed={featured}
      aria-label={featured ? `继续“${card.world.title}”` : `抽出查看“${card.world.title}”`}
    >
      <span className="book3d">
        <span className="book-spine">
          <span className="spine-band" />
          <span className="spine-stitch" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="spine-title">{spine.map((c, i) => <b key={i}>{c}</b>)}</span>
          {card.seal && <span className="spine-seal">{card.seal}</span>}
          <span className="spine-band low" />
        </span>
        <span className="book-front">
          <BookCover seed={card.world.id} title={card.world.title} seal={card.seal} />
        </span>
        <span className="book-pages" aria-hidden="true" />
        <span className="book-top" aria-hidden="true" />
      </span>
      {writing && <span className="shelf-writing" aria-hidden="true" />}
    </button>
  );
}

/** Song sky-blue Ru-ware gall-bladder vase with plum blossoms & antique brass paperweight (宋汝窑天青小胆瓶插梅与镇纸). */
function ShelfCurio({ seed }: { seed: number }) {
  const gradId = `ru-celadon-${seed}`;
  return (
    <span className="shelf-curio" aria-hidden="true">
      <svg className="curio-svg" viewBox="0 0 62 112" focusable="false">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#b5cfcc" />
            <stop offset="0.48" stopColor="#86a9a5" />
            <stop offset="1" stopColor="#567673" />
          </linearGradient>
        </defs>
        {/* Slanting winter plum branch */}
        <path
          d="M25 49C24 37 29 26 42 16M30 33C24 27 18 24 12 23M35 23C38 16 44 12 50 11"
          fill="none"
          stroke="#4b3526"
          strokeWidth="1.65"
          strokeLinecap="round"
        />
        {/* Cinnabar-blush plum blossoms & gold stamens */}
        <g fill="#cf4b3d">
          <circle cx="42" cy="15.5" r="3.2" />
          <circle cx="14.5" cy="22.5" r="2.8" />
          <circle cx="49.5" cy="11" r="2.2" opacity="0.88" />
          <circle cx="25.5" cy="27.5" r="1.9" opacity="0.82" />
        </g>
        <g fill="#f6df9e">
          <circle cx="42" cy="15.5" r="1" />
          <circle cx="14.5" cy="22.5" r="0.9" />
        </g>
        {/* Carved rosewood mini stand */}
        <path d="M13 106h24l2 5H11z" fill="#52351e" />
        <path d="M15 104.5h20v2H15z" fill="#785030" />
        {/* Ru-ware sky-blue celadon gall-bladder vase */}
        <path
          d="M22.2 48h5.6c-.5 7-.3 15 2.8 22.5 4.8 11.2 3.8 25-2.6 34H22c-6.4-9-7.4-22.8-2.6-34 3.1-7.5 3.3-15.5 2.8-22.5z"
          fill={`url(#${gradId})`}
          stroke="#4b6966"
          strokeWidth="0.7"
        />
        {/* Mouth rim & ice-crackle sheen */}
        <ellipse cx="25" cy="48" rx="3.2" ry="1" fill="#d9e7e4" />
        <path
          d="M21.5 55c-.2 8-2.6 16-3.2 25M27 68l-4 7M22 83l6 5"
          fill="none"
          stroke="rgba(255,252,244,0.36)"
          strokeWidth="0.65"
          strokeLinecap="round"
        />
        {/* Antique brushed brass scholar's paperweight */}
        <rect x="40" y="104.5" width="19" height="6.2" rx="1.4" fill="#b7904c" />
        <path d="M41 105.3h17" stroke="#f3dfb0" strokeWidth="0.8" strokeLinecap="round" />
        <rect x="47.5" y="102" width="4" height="2.8" rx="0.9" fill="#cfab68" />
      </svg>
    </span>
  );
}

/** Companion decorative volumes that keep a wide shelf lived-in. */
function PlainBooks({ count, offset }: { count: number; offset: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const n = offset + i;
        return (
          <span
            key={i}
            className={`plain-book tone-${(n * 3) % TONES}${i === count - 1 ? " is-leaning" : ""}`}
            aria-hidden="true"
            style={{
              ["--bh" as string]: `${120 + ((n * 37) % 4) * 6}px`,
              ["--bt" as string]: `${24 + ((n * 13) % 3) * 3}px`,
            }}
          />
        );
      })}
    </>
  );
}

export function HomeShelf({ cards, writing, onOpen, onMenu, onNew, newStory }: HomeViewProps & { onNew: () => void }) {
  const perRow = useShelfPerRow();
  const [selectedId, setSelectedId] = useState(cards[0]?.world.id ?? "");
  const activeIndex = Math.max(0, cards.findIndex((c) => c.world.id === selectedId));
  const active = cards[activeIndex] ?? cards[0];
  const rows: WorldCard[][] = [];
  for (let i = 0; i < cards.length; i += perRow) rows.push(cards.slice(i, i + perRow));
  const last = rows.length - 1;
  const lastRowLen = rows[last]?.length ?? 0;
  // On 320px (perRow=3), up to 2 books share the shelf with new-book + curio; on 390px (perRow=5), up to 4 books fit cleanly with zero horizontal clipping.
  const maxInlineWithExtras = perRow <= 3 ? 2 : perRow - 1;
  const trailSeparateRow = lastRowLen > maxInlineWithExtras;
  const room = Math.max(0, perRow - lastRowLen);
  const colInRow = activeIndex % perRow;
  const rowLen = Math.max(1, rows[Math.floor(activeIndex / perRow)]?.length ?? 1);
  const arrowPct = Math.round(12 + (colInRow / Math.max(1, Math.max(rowLen, 3) - 1)) * 68);
  const escId = (id: string) => (typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id);
  const openBook = (card: WorldCard) =>
    onOpen(card, document.querySelector(`.shelf-book[data-world-id="${escId(card.world.id)}"]`));
  const tapBook = (card: WorldCard) => {
    if (card.world.id === active.world.id) openBook(card);
    else setSelectedId(card.world.id);
  };
  const stepBook = (delta: number) => {
    const next = cards[(activeIndex + delta + cards.length) % cards.length];
    if (next) setSelectedId(next.world.id);
  };
  const isWriting = writing.has(active.world.id);

  return (
    <div className="home-shelf-layout">
      <section className="home-shelf" aria-label="书阁">
        <div className="shelf-case">
          {rows.map((row, r) => (
            <div key={r} className="shelf-row">
              <div className="shelf-books">
                {row.map((card, i) => (
                  <Fragment key={card.world.id}>
                    {i > 0 && i % 3 === 0 && row.length >= 5 && (
                      <span className="shelf-divider" aria-hidden="true" />
                    )}
                    <ShelfBook
                      card={card}
                      index={r * perRow + i}
                      featured={card.world.id === active.world.id}
                      writing={writing.has(card.world.id)}
                      onTap={tapBook}
                      onMenu={onMenu}
                    />
                  </Fragment>
                ))}
                {r === last && !trailSeparateRow && (
                  <>
                    <button className="new-book" onClick={onNew} aria-label="开始新的故事">
                      <span className="new-book-mark" aria-hidden="true"><Icon name="plus" size={17} /></span>
                      <span className="new-book-text">新卷</span>
                    </button>
                    <span className="shelf-divider" aria-hidden="true" />
                    {perRow >= 6 && room >= 4 && <PlainBooks count={Math.min(2, room - 3)} offset={cards.length} />}
                    <ShelfCurio seed={r + cards.length} />
                  </>
                )}
              </div>
              <div className="shelf-plank" aria-hidden="true" />
            </div>
          ))}
          {trailSeparateRow && (
            <div className="shelf-row">
              <div className="shelf-books">
                <button className="new-book" onClick={onNew} aria-label="开始新的故事">
                  <span className="new-book-mark" aria-hidden="true"><Icon name="plus" size={17} /></span>
                  <span className="new-book-text">新卷</span>
                </button>
                <span className="shelf-divider" aria-hidden="true" />
                {perRow >= 6 && <PlainBooks count={2} offset={cards.length} />}
                <ShelfCurio seed={rows.length + cards.length} />
              </div>
              <div className="shelf-plank" aria-hidden="true" />
            </div>
          )}
        </div>
      </section>

      <div className="home-shelf-side stack">
        <div key={active.world.id} className="shelf-slip" style={{ ["--arrow-x" as string]: `${arrowPct}%` }}>
          <div className="slip-top">
            <button
              type="button"
              className="slip-cover-btn"
              onClick={() => openBook(active)}
              aria-label={`翻开《${active.world.title}》`}
            >
              <BookCover seed={active.world.id} title={active.world.title} seal={active.seal} />
            </button>
            {active.seal && (
              <span className="slip-dynasty" aria-hidden="true">
                {active.seal}代
              </span>
            )}
            <div className="slip-main">
              <div className="slip-head">
                <b>{active.world.title}</b>
                <button
                  className="icon-btn world-menu"
                  aria-label={`“${active.world.title}”的更多操作`}
                  onClick={() => onMenu(active)}
                >
                  <Icon name="more" />
                </button>
              </div>
              <small className="slip-sub">
                {active.protagonist} · {active.clock} ·{" "}
                {isWriting ? (
                  "正在续写…"
                ) : active.turns ? (
                  <>
                    {active.turns} 回合 · <span className="slip-rel">{relative(active.world.playedAt)}</span>
                  </>
                ) : (
                  <span className="slip-rel">{relative(active.world.playedAt)}</span>
                )}
              </small>
            </div>
          </div>

          {active.lastLine && <p className="slip-line">{active.lastLine}</p>}

          <div className="slip-foot">
            <button className="primary continue-btn" onClick={() => openBook(active)}>
              <Icon name="play" size={16} />
              <span>翻开继续</span>
            </button>
            {cards.length > 1 && (
              <span className="slip-stepper" role="group" aria-label="切换案头书卷">
                <button type="button" className="icon-btn slip-step" aria-label="上一本" onClick={() => stepBook(-1)}>
                  <Icon name="back" size={16} />
                </button>
                <span className="slip-index">{activeIndex + 1}/{cards.length}</span>
                <button type="button" className="icon-btn slip-step" aria-label="下一本" onClick={() => stepBook(1)}>
                  <Icon name="forward" size={16} />
                </button>
              </span>
            )}
          </div>
        </div>
        {newStory}
      </div>
    </div>
  );
}
