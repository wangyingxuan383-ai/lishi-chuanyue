// Local art for the bookshelf and the people list (R13-T104, redrawn in R14):
// every story is a thread-bound book (线装书) — a cloth-coloured board, the
// stitching along the spine on the right, a paper title slip (题签) at the
// upper left and, for a historical story, a small cinnabar seal with the
// dynasty. People get a 朱文 name seal. Drawn here, no pictures and no network;
// the colours live in bookArt.css so the three themes can tune them.
import "./bookArt.css";

function seedOf(text: string): number {
  let seed = 2166136261;
  for (const c of text) seed = Math.imul(seed ^ c.codePointAt(0)!, 16777619);
  return seed >>> 0;
}

/** Book-cloth colours: .cover-0 … .cover-7 in bookArt.css. */
const TONES = 8;
const HAN = /\p{Script=Han}/u;

/** The characters on the title slip: the title's first five Chinese characters. */
export function slipText(title: string): string[] {
  return [...title].filter((c) => HAN.test(c)).slice(0, 5);
}

/**
 * A story's cover. `seal` is one character (唐、宋、明…); leave it out when the
 * story has no dynasty. The same `seed` always gives the same cloth colour.
 */
export function BookCover({ seed, title, seal }: { seed: string; title: string; seal?: string }) {
  const chars = slipText(title);
  const tight = chars.length > 4;
  const step = tight ? 8.6 : 10.4;
  return (
    <svg className={`book-art cover-${seedOf(seed) % TONES}`} viewBox="0 0 60 84" aria-hidden="true" focusable="false">
      <rect className="cover-board" x="0.5" y="0.5" width="59" height="83" rx="1.5" />
      {/* 四眼钉装: the thread runs along the spine and wraps over the edge at each of the four holes. */}
      <path className="cover-thread" d="M53 1V83M53 12H59.5M53 31.5H59.5M53 52.5H59.5M53 72H59.5" />
      <rect className="cover-slip" x="7.5" y="6.5" width="15" height="52" />
      <rect className="cover-slip-frame" x="9" y="8" width="12" height="49" />
      {chars.map((c, i) => (
        <text key={i} className={`cover-title${tight ? " tight" : ""}`} x="15" y={(tight ? 17 : 18) + i * step} textAnchor="middle">{c}</text>
      ))}
      {seal && (
        <>
          <rect className="cover-seal" x="9" y="64" width="12" height="12" rx="0.8" />
          <rect className="cover-seal-frame" x="10.2" y="65.2" width="9.6" height="9.6" />
          <text className="cover-seal-mark" x="15" y="73.3" textAnchor="middle">{seal}</text>
        </>
      )}
    </svg>
  );
}

/** A person's name seal: the first character of the name, red on paper; faded for the dead. */
export function PersonAvatar({ name, dead = false }: { name: string; dead?: boolean }) {
  return <span className={`person-avatar${dead ? " dead" : ""}`} aria-hidden="true">{[...name.trim()][0] ?? "人"}</span>;
}
