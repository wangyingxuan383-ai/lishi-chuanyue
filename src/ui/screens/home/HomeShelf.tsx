// 首页·书架: every story is a thread-bound book standing on a wooden or
// gilt-lacquer shelf, spine out, with four-hole silk stitching and vertical
// title slip. Shelf capacity adapts to viewport width (4 spines on 320px up to
// 9 on wide screens) so books never clip; under or beside the shelf a reading
// slip tracks the selected volume.
import { useEffect, useState } from "react";
import { BookCover, TONES, seedOf, slipText } from "../../components/BookArt";
import { Icon } from "../../components/Icon";
import { useLongPress } from "../../components/useLongPress";
import { relative, type HomeViewProps, type WorldCard } from "./types";
import "./home-shelf.css";

function computePerRow(): number {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return 7;
  if (window.matchMedia("(max-width: 350px)").matches) return 4;
  if (window.matchMedia("(max-width: 430px)").matches) return 5;
  if (window.matchMedia("(min-width: 960px)").matches) return 8;
  if (window.matchMedia("(min-width: 680px)").matches) return 8;
  return 7;
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

function ShelfBook({ card, featured, writing, onTap, onMenu, index }: { card: WorldCard; featured: boolean; writing: boolean; onTap: (card: WorldCard) => void; onMenu: HomeViewProps["onMenu"]; index: number }) {
  const seed = seedOf(card.world.id);
  const press = useLongPress(() => onMenu(card), () => onTap(card));
  const spine = slipText(card.world.title).slice(0, 6);
  const height = 132 + (seed % 5) * 6;
  const thick = 30 + ((seed >>> 3) % 4) * 3;
  return (
    <button className={`shelf-book tone-${seed % TONES}${featured ? " featured" : ""}${writing ? " writing" : ""}`} data-world-id={card.world.id} {...press}
      style={{ ["--bh" as string]: `${height}px`, ["--bt" as string]: `${thick}px`, ["--i" as string]: index }}
      aria-pressed={featured} aria-label={featured ? `继续“${card.world.title}”` : `抽出查看“${card.world.title}”`}>
      <span className="book3d">
        <span className="book-spine">
          <span className="spine-band" />
          <span className="spine-stitch" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="spine-title">{spine.map((c, i) => <b key={i}>{c}</b>)}</span>
          {card.seal && <span className="spine-seal">{card.seal}</span>}
          <span className="spine-band low" />
        </span>
        <span className="book-front"><BookCover seed={card.world.id} title={card.world.title} seal={card.seal} /></span>
        <span className="book-pages" />
        <span className="book-top" />
      </span>
      {writing && <span className="shelf-writing" aria-hidden="true" />}
    </button>
  );
}

/** Plain books and a brass/sandalwood paperweight that keep a short shelf lived-in. */
function PlainBooks({ count, offset }: { count: number; offset: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const n = offset + i;
        return (
          <span
            key={i}
            className={`plain-book tone-${(n * 3) % TONES}`}
            aria-hidden="true"
            style={{
              ["--bh" as string]: `${118 + ((n * 37) % 5) * 7}px`,
              ["--bt" as string]: `${22 + ((n * 13) % 3) * 5}px`,
              ["--lean" as string]: i === count - 1 ? "-6deg" : "0deg",
            }}
          />
        );
      })}
      <span className="shelf-weight" aria-hidden="true" />
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
  const room = perRow - rows[last].length;
  const colInRow = activeIndex % perRow;
  const rowLen = Math.max(1, rows[Math.floor(activeIndex / perRow)]?.length ?? 1);
  const arrowPct = Math.round(12 + (colInRow / Math.max(1, Math.max(rowLen, 3) - 1)) * 68);
  const openBook = (card: WorldCard) => onOpen(card, document.querySelector(`.shelf-book[data-world-id="${card.world.id}"]`));
  const tapBook = (card: WorldCard) => {
    if (card.world.id === active.world.id) openBook(card);
    else setSelectedId(card.world.id);
  };
  const stepBook = (delta: number) => {
    const next = cards[(activeIndex + delta + cards.length) % cards.length];
    if (next) setSelectedId(next.world.id);
  };

  return (
    <div className="home-shelf-layout">
      <section className="home-shelf" aria-label="书架">
        <div className="shelf-case">
          {rows.map((row, r) => (
            <div key={r} className="shelf-row">
              <div className="shelf-books">
                {row.map((card, i) => (
                  <ShelfBook
                    key={card.world.id}
                    card={card}
                    index={r * perRow + i}
                    featured={card.world.id === active.world.id}
                    writing={writing.has(card.world.id)}
                    onTap={tapBook}
                    onMenu={onMenu}
                  />
                ))}
                {r === last && (
                  <button className="new-book" onClick={onNew} aria-label="开始新的故事">
                    <span className="new-book-mark" aria-hidden="true"><Icon name="plus" size={18} /></span>
                    <span className="new-book-text">新书</span>
                  </button>
                )}
                {r === last && room > 2 && <PlainBooks count={Math.min(3, room - 2)} offset={cards.length} />}
              </div>
              <div className="shelf-plank" aria-hidden="true" />
            </div>
          ))}
        </div>
        <div key={active.world.id} className="shelf-slip" style={{ ["--arrow-x" as string]: `${arrowPct}%` }}>
          <div className="slip-head">
            <b>{active.world.title}</b>
            {cards.length > 1 && (
              <span className="slip-stepper">
                <button type="button" className="icon-btn slip-step" aria-label="上一本" onClick={() => stepBook(-1)}><Icon name="back" size={16} /></button>
                <span className="slip-index">{activeIndex + 1}/{cards.length}</span>
                <button type="button" className="icon-btn slip-step" aria-label="下一本" onClick={() => stepBook(1)}><Icon name="forward" size={16} /></button>
              </span>
            )}
            <button className="icon-btn world-menu" aria-label={`“${active.world.title}”的更多操作`} onClick={() => onMenu(active)}><Icon name="more" /></button>
          </div>
          <small>{active.protagonist} · {active.clock} · {writing.has(active.world.id) ? "正在写…" : active.turns ? `${active.turns} 回合 · ${relative(active.world.playedAt)}` : relative(active.world.playedAt)}</small>
          {active.lastLine && <p className="slip-line">{active.lastLine}</p>}
          <div className="slip-foot">
            <button className="primary continue-btn" onClick={() => openBook(active)}><Icon name="play" size={16} />翻开继续</button>
          </div>
        </div>
      </section>
      <div className="home-shelf-side">{newStory}</div>
    </div>
  );
}
