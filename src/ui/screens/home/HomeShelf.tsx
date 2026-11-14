// 首页·书架 (R29-T007, D163): every story is a thread-bound book standing on a
// shelf, spine out, with its title written down the spine. The one read last is
// half pulled out, its cover showing; under the shelf a slip tells where you
// left off. Opening a book pulls it from the shelf, turns it to face you and
// lifts the cover before the story comes up.
import { BookCover, TONES, seedOf, slipText } from "../../components/BookArt";
import { Icon } from "../../components/Icon";
import { useLongPress } from "../../components/useLongPress";
import { relative, type HomeViewProps, type WorldCard } from "./types";
import "./home-shelf.css";

/** Books per shelf row: enough to fill a phone's width, spine by spine. */
const PER_ROW = 7;

function ShelfBook({ card, featured, writing, onOpen, onMenu, index }: { card: WorldCard; featured: boolean; writing: boolean; onOpen: HomeViewProps["onOpen"]; onMenu: HomeViewProps["onMenu"]; index: number }) {
  const seed = seedOf(card.world.id);
  const press = useLongPress(() => onMenu(card), () => onOpen(card, document.querySelector(`.shelf-book[data-world-id="${card.world.id}"]`)));
  const spine = slipText(card.world.title).slice(0, 6);
  // Books are not all the same size: a little height and thickness from the seed.
  const height = 132 + (seed % 5) * 7, thick = 30 + ((seed >>> 3) % 4) * 4;
  return (
    <button className={`shelf-book tone-${seed % TONES}${featured ? " featured" : ""}${writing ? " writing" : ""}`} data-world-id={card.world.id} {...press}
      style={{ ["--bh" as string]: `${height}px`, ["--bt" as string]: `${thick}px`, ["--i" as string]: index }} aria-label={`继续“${card.world.title}”`}>
      <span className="book3d">
        <span className="book-spine">
          <span className="spine-band" />
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

/** Plain books that keep a short shelf from looking empty; not stories. */
function PlainBooks({ count, offset }: { count: number; offset: number }) {
  return <>{Array.from({ length: count }, (_, i) => {
    const n = offset + i;
    return <span key={i} className={`plain-book tone-${(n * 3) % TONES}`} aria-hidden="true" style={{ ["--bh" as string]: `${118 + ((n * 37) % 5) * 8}px`, ["--bt" as string]: `${22 + ((n * 13) % 3) * 6}px`, ["--lean" as string]: i === count - 1 ? "-7deg" : "0deg" }} />;
  })}</>;
}

export function HomeShelf({ cards, writing, onOpen, onMenu, onNew, newStory }: HomeViewProps & { onNew: () => void }) {
  const latest = cards[0];
  const rows: WorldCard[][] = [];
  for (let i = 0; i < cards.length; i += PER_ROW) rows.push(cards.slice(i, i + PER_ROW));
  const last = rows.length - 1, room = PER_ROW - rows[last].length;
  const openLatest = () => onOpen(latest, document.querySelector(`.shelf-book[data-world-id="${latest.world.id}"]`));
  return (
    <>
      <section className="home-shelf" aria-label="书架">
        <div className="shelf-case">
          {rows.map((row, r) => (
            <div key={r} className="shelf-row">
              <div className="shelf-books">
                {row.map((card, i) => <ShelfBook key={card.world.id} card={card} index={r * PER_ROW + i} featured={card === latest} writing={writing.has(card.world.id)} onOpen={onOpen} onMenu={onMenu} />)}
                {r === last && <button className="new-book" onClick={onNew} aria-label="开始新的故事"><span className="new-book-mark" aria-hidden="true">＋</span><span className="new-book-text">新书</span></button>}
                {r === last && room > 2 && <PlainBooks count={Math.min(4, room - 1)} offset={cards.length} />}
              </div>
              <div className="shelf-plank" aria-hidden="true" />
            </div>
          ))}
        </div>
        <div className="shelf-slip">
          <div className="slip-head">
            <b>{latest.world.title}</b>
            <button className="icon-btn world-menu" aria-label={`“${latest.world.title}”的更多操作`} onClick={() => onMenu(latest)}><Icon name="more" /></button>
          </div>
          <small>{latest.protagonist} · {latest.clock} · {writing.has(latest.world.id) ? "正在写…" : relative(latest.world.playedAt)}</small>
          {latest.lastLine && <p className="slip-line">{latest.lastLine}</p>}
          <button className="primary continue-btn" onClick={openLatest}><Icon name="play" size={16} />翻开继续</button>
        </div>
      </section>
      {newStory}
    </>
  );
}
