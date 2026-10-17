// 这一世小传 (PLAN_V4 direction G; UX_CN 15, 29, 30): a 列传-style summary of
// the protagonist's life, the 行状 (play statistics) and the 印谱 (seals
// earned), built from saved state without a model call. Opens on death from
// the ending card and any time from the ⋯ menu.
import { useEffect, useMemo, useRef, useState } from "react";
import { eraContext } from "../../engine/era";
import { dateText, earnedSeals, lifeSummary, newSeals, playStats, realTimeText, SEALS, spanText, type PlayStats } from "../../engine/life";
import type { World, WorldState } from "../../engine/types";
import { useApp } from "../app/context";
import { CardSheet } from "./ShareCard";
import { Sheet } from "./Sheet";

/** Live, not deleted world lines (bookmarks are not lines). */
export async function lineCount(game: ReturnType<typeof useApp>["game"], worldId: string): Promise<number> {
  return (await game.repo.lines(worldId)).filter((l) => l.kind === "line" && !l.deletedAt).length;
}

export function LifeSheet({ world, state, headId, dead, onClose }: { world: World; state: WorldState; headId: string; dead: boolean; onClose: () => void }) {
  const { game } = useApp();
  const era = eraContext(world.eraId, state);
  const life = useMemo(() => lifeSummary({ state, clock: era.clock, currency: era.currency, eraTitle: era.title, dead }), [state, dead, world.eraId]);
  const [stats, setStats] = useState<PlayStats | null>(null);
  const [card, setCard] = useState(false);
  useEffect(() => {
    void Promise.all([game.repo.path(headId), game.repo.allNodes(world.id), lineCount(game, world.id)])
      .then(([path, all, lines]) => setStats(playStats({ path, all, lines, gameMinutes: state.time.elapsedMinutes })));
  }, [game, world.id, headId, state]);
  const earned = new Set(stats ? earnedSeals({ turns: stats.turns, lines: stats.lines, state, currency: era.currency }).map((s) => s.id) : []);

  if (card) {
    return <CardSheet title="小传图片" onClose={() => setCard(false)} content={{
      title: world.title, heading: `${life.name}小传`, body: life.prose, seal: life.seal,
      date: dateText(era.clock, state.time.elapsedMinutes), place: state.places.find((p) => p.id === state.placeId)?.name ?? "", name: "",
    }} />;
  }
  return (
    <Sheet title="这一世小传" onClose={onClose}>
      <div className="life">
        <div className="life-head">
          <div className="life-seal" aria-label={`结局印：${life.seal}`}><span>{life.seal[0]}</span><span>{life.seal[1]}</span></div>
          <div className="grow">
            <h3>{life.name}</h3>
            <p className="muted">{world.title} · {dead ? "这一世已了" : "这一世还在继续"}</p>
          </div>
        </div>
        <div className="life-bio">
          {life.sections.map((s) => <p key={s.label}><b>{s.label}</b>{s.text}</p>)}
        </div>
        <button onClick={() => setCard(true)}>做成图片</button>

        <h4 className="section-title">行状</h4>
        {stats ? (
          <div className="stat-grid life-stats">
            <Stat label="这一世走了" value={`${stats.turns} 回合`} />
            <Stat label="游戏里过了" value={spanText(stats.gameMinutes)} />
            <Stat label="世界线" value={`${stats.lines} 条`} />
            <Stat label="大约玩了" value={realTimeText(stats.realMinutes)} />
            <Stat label="所有路线共" value={`${stats.allTurns} 回合`} />
            <Stat label="最常用" value={stats.modes.length ? stats.modes.slice(0, 2).map((m) => `${m.label} ${m.count} 次`).join("，") : "还没有"} />
          </div>
        ) : <p className="muted">正在统计…</p>}
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>“大约玩了”按每回合之间的间隔估算，停下超过十分钟的只算十分钟。</p>

        <h4 className="section-title">印谱 <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>{earned.size} / {SEALS.length}</span></h4>
        <div className="seal-book">
          {SEALS.map((s) => (
            <div key={s.id} className={`seal-stamp${earned.has(s.id) ? " got" : ""}`} aria-label={`${s.name}：${earned.has(s.id) ? "已得" : `未得，${s.how}`}`}>
              <div className="stamp" aria-hidden="true">{[...s.name].map((c, i) => <span key={i}>{c}</span>)}</div>
              <small>{earned.has(s.id) ? s.name : s.how}</small>
            </div>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><div className="label">{label}</div><div className="value">{value}</div></div>;
}

/**
 * The end of a life (AUDIT_V4 5.6): a card in the book's style, with where
 * and when it ended, the 结局印, the 小传, and the ways on — back a few
 * turns, another route, or the same setup again. Nothing is lost.
 */
export function EndingCard({ state, world, now, turns, onLife, onBack, onLines, onAgain }: {
  state: WorldState; world: World; now: string; turns: number; onLife: () => void; onBack: (steps: number) => void; onLines: () => void; onAgain: () => void;
}) {
  const me = state.protagonist;
  const known = state.people.length;
  const done = state.goals.filter((g) => g.status === "完成").length;
  return (
    <div className="ending-card" role="status">
      <div className="ending-seal" aria-hidden="true"><span>殉</span><span>身</span></div>
      <h2>{me.name}{me.age ? `，年${me.age}` : ""}</h2>
      <p className="ending-line">卒于{now}。{turns ? `历 ${turns} 回合，` : ""}结识 {known} 人{done ? `，了却 ${done} 桩心愿` : ""}{state.deviations.length ? `，改了 ${state.deviations.length} 件史事` : ""}。</p>
      <p className="muted">这一世到此为止。走过的路都还在，可以回到之前的某一刻重来。</p>
      <button className="ending-life" onClick={onLife}>看这一世小传</button>
      <div className="ending-actions">
        <button className="primary" onClick={() => onBack(1)}>回到上一回合</button>
        <button onClick={() => onBack(3)}>回到三回合前</button>
        <button onClick={onLines}>看看别的路线</button>
        <button className="ghost" onClick={onAgain}>同样设定再开一局</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{world.settings.difficulty === "残酷" ? "残酷难度下，重伤可能直接丧命。" : "长按任意一段，也可以回到那时。"}</p>
    </div>
  );
}

/**
 * Tells the player the first time a seal is earned in this world ("得一枚印：…");
 * the ones already told are kept in settings under "seals:<worldId>".
 */
export function useSealToast(world: World | null, state: WorldState | null, turns: number) {
  const { game, toast } = useApp();
  // Seals already earned when the world is opened (older saves) are recorded without a toast.
  const opened = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!world || !state) return;
    let live = true;
    const quiet = !opened.current;
    opened.current = true;
    // One check at a time, so two quick refreshes do not both announce the same seal.
    queue.current = queue.current.then(async () => {
      const key = "seals:" + world.id;
      const shown = await game.repo.getSetting<string[]>(key, []);
      const lines = await lineCount(game, world.id);
      const fresh = newSeals({ turns, lines, state, currency: eraContext(world.eraId, state).currency }, shown);
      if (!fresh) return;
      await game.repo.setSetting(key, [...shown, ...fresh.ids]);
      if (!quiet && live) toast(fresh.text);
    }).catch(() => {});
    return () => { live = false; };
  }, [game, world?.id, state, turns]);
}
