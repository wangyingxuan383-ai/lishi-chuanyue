// 目录 (PLAN_V4 direction G; UX_CN 13–14): the chapters as 回目, bookmarks, the
// 要点 the player pinned and how history has changed, in one place, with a
// search over what is on the current path. Tapping a chapter, a passage or a
// pin scrolls the story there; a bookmark on another route carries on from it.
import { Fragment, useEffect, useMemo, useState } from "react";
import { nowOf, type GameClock } from "../../engine/calendar/clock";
import { huimu, searchBook, turnNumbers, type SearchHit } from "../../engine/book";
import type { Chapter, Line, Pin, StoryNode, WorldState } from "../../engine/types";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";

interface Data {
  path: StoryNode[];
  chapters: Chapter[];
  pins: Pin[];
  bookmarks: { line: Line; onPath: boolean; minute: number | null }[];
  minutes: Map<string, number>;
}

function Highlight({ hit }: { hit: SearchHit }) {
  return <small className="toc-snippet">{hit.snippet.before}<mark>{hit.snippet.hit}</mark>{hit.snippet.after}</small>;
}

export function TocSheet({ worldId, headId, state, clock, onJump, onBookmark, onClose }: {
  worldId: string; headId: string; state: WorldState; clock: GameClock;
  /** Scroll the story to a passage on the current path. */
  onJump: (nodeId: string) => void;
  /** Carry on from a bookmark that is not on the current path. */
  onBookmark: (line: Line) => void;
  onClose: () => void;
}) {
  const { game } = useApp();
  const [data, setData] = useState<Data | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void (async () => {
      const [path, chapters, pins, lines, minutes] = await Promise.all([
        game.repo.path(headId), game.repo.chaptersOnPath(worldId, headId), game.repo.pinsOnPath(worldId, headId),
        game.repo.lines(worldId), game.repo.minutesOnPath(headId),
      ]);
      const onPath = new Set(path.map((n) => n.id));
      const bookmarks = await Promise.all(lines.filter((l) => l.kind === "bookmark" && !l.deletedAt).map(async (line) => ({
        line, onPath: onPath.has(line.nodeId),
        minute: minutes.get(line.nodeId) ?? (await game.repo.getState(line.nodeId).then((s) => s.time.elapsedMinutes).catch(() => null)),
      })));
      setData({ path, chapters, pins, bookmarks, minutes });
    })();
  }, [worldId, headId]);

  const hits = useMemo(() => (data && query.trim() ? searchBook({ path: data.path, chapters: data.chapters, state, minutes: data.minutes }, query) : []), [data, query, state]);
  const when = (minute: number | null | undefined) => (minute == null ? null : nowOf(clock, minute).text);
  const go = (nodeId: string) => { onClose(); onJump(nodeId); };

  if (!data) return <Sheet title="目录" onClose={onClose}><p className="muted">正在读取…</p></Sheet>;
  const numbers = turnNumbers(data.path);
  const lastDone = data.chapters.at(-1)?.lastNodeId;
  const doneAt = lastDone ? data.path.findIndex((n) => n.id === lastDone) : 0;
  const rest = data.path.slice(doneAt + 1).filter((n) => n.kind === "turn" || n.kind === "fastforward");
  const turnsOf = (c: Chapter) => {
    const from = numbers.get(c.firstNodeId);
    const to = numbers.get(c.lastNodeId);
    return from && to ? `第 ${from}～${to} 回合` : "";
  };
  const meta = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

  return (
    <Sheet title="目录" onClose={onClose}>
      <div className="stack toc">
        <input type="search" aria-label="搜索" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜正文、人物、设定、回目" />
        {query.trim() ? (
          <section className="stack" style={{ gap: 0 }} aria-label="搜索结果">
            <p className="muted" style={{ margin: "0 0 4px" }}>{hits.length ? `找到 ${hits.length} 处${hits.filter((h) => h.kind === "正文").length >= 60 ? "（正文只列最近 60 段）" : ""}` : "没有找到。换个词试试，如人名、地名。"}</p>
            {hits.map((hit, i) => {
              const content = (
                <div className="grow">
                  <b>{hit.title}</b>
                  <Highlight hit={hit} />
                  {hit.minute != null && <small>{when(hit.minute)}</small>}
                </div>
              );
              return hit.nodeId
                ? <button key={i} className="item-row codex-item" onClick={() => go(hit.nodeId!)}>{content}<span className="tag">{hit.kind}</span></button>
                : <div key={i} className="item-row">{content}<span className="tag">{hit.kind}</span></div>;
            })}
          </section>
        ) : (
          <>
            <section className="stack" style={{ gap: 0 }}>
              <p className="section-title">章回</p>
              {data.path[0] && (
                <button className="item-row codex-item" onClick={() => go(data.path[0].id)}>
                  <div className="grow"><b>{data.chapters.length ? "楔子" : "开篇"}</b><small>{when(data.minutes.get(data.path[0].id))}</small></div>
                </button>
              )}
              {data.chapters.map((c, i) => (
                <button key={c.id} className="item-row codex-item" onClick={() => go(c.firstNodeId)}>
                  <div className="grow">
                    <b>{huimu(i + 1, c.title)}</b>
                    {c.gist && <small>{c.gist}</small>}
                    <small>{meta(when(data.minutes.get(c.firstNodeId)), turnsOf(c))}</small>
                  </div>
                </button>
              ))}
              {rest.length > 0 && (
                <button className="item-row codex-item" onClick={() => go(rest[0].id)}>
                  <div className="grow">
                    <b>{huimu(data.chapters.length + 1)}（进行中）</b>
                    <small>{meta(when(data.minutes.get(rest[0].id)), numbers.get(rest[0].id) ? `从第 ${numbers.get(rest[0].id)} 回合起，${rest.length} 回合` : null)}</small>
                  </div>
                </button>
              )}
              {!data.chapters.length && <p className="muted" style={{ margin: "6px 0 0" }}>每过一些回合，AI 会把剧情写成一回，回目会列在这里。</p>}
            </section>

            <section className="stack" style={{ gap: 0 }}>
              <p className="section-title">书签</p>
              {data.bookmarks.length ? data.bookmarks.map(({ line, onPath, minute }) => (
                <button key={line.id} className="item-row codex-item" onClick={() => { if (onPath) go(line.nodeId); else { onClose(); onBookmark(line); } }}>
                  <div className="grow"><b>{line.name}</b><small>{meta(when(minute), onPath ? null : "在另一条路线上，点一下从那里接着玩")}</small></div>
                </button>
              )) : <p className="muted" style={{ margin: "6px 0 0" }}>长按任意一段选“加书签”，以后在这里一点就能回去。</p>}
            </section>

            <section className="stack" style={{ gap: 0 }}>
              <p className="section-title">我记下的要点</p>
              {data.pins.length ? data.pins.map((pin) => (
                <button key={pin.id} className="item-row codex-item" onClick={() => go(pin.originNodeId)}>
                  <div className="grow"><span className="toc-pin">{pin.text}</span><small>{when(data.minutes.get(pin.originNodeId))}</small></div>
                </button>
              )) : <p className="muted" style={{ margin: "6px 0 0" }}>长按一段选“记住这件事”，AI 会一直记着，这里也能找到。</p>}
            </section>

            {state.deviations.length > 0 && (
              <section className="stack" style={{ gap: 0 }}>
                <p className="section-title">历史因你而变</p>
                {state.deviations.map((d, i) => <Fragment key={i}><div className="item-row"><span className="grow toc-pin">{d}</span></div></Fragment>)}
              </section>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
