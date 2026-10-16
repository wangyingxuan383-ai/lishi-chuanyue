// Character & world panel (PLAN_V3 §4.5). Read-only in this first version;
// editing via correction nodes follows in R02-T011.
import { useState } from "react";
import type { EraContext } from "../../engine/era";
import { clockParts } from "../../engine/calendar/clock";
import { formatMoney } from "../../engine/money";
import type { WorldState } from "../../engine/types";
import { useBack } from "../app/context";

const TABS = ["我", "行囊", "人物", "目标"] as const;
type Tab = (typeof TABS)[number];

function level(n: number, words: string[]): string {
  return words[Math.min(words.length - 1, Math.floor((100 - n) / (100 / words.length)))];
}

function Stat({ label, value, n }: { label: string; value: string; n?: number }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {n !== undefined && <div className="bar"><i style={{ width: `${n}%` }} /></div>}
    </div>
  );
}

export function Panel({ state, era, onClose }: { state: WorldState; era: EraContext; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("我");
  useBack(() => { onClose(); return true; });
  const me = state.protagonist;
  const c = clockParts(era.startHour, state.time.elapsedMinutes);
  const place = state.places.find((p) => p.id === state.placeId)?.name;
  const active = state.goals.filter((g) => g.status === "进行中");
  const finished = state.goals.filter((g) => g.status !== "进行中");
  const people = [...state.people].sort((a, b) => (b.lastSeenMinute ?? -1) - (a.lastSeenMinute ?? -1));

  return (
    <div className="panel" role="dialog" aria-label="角色">
      <div className="topbar">
        <button className="icon-btn" aria-label="关闭" onClick={onClose}>‹</button>
        <div className="title"><h1>{me.name}</h1><div className="subtitle">{me.age ? `${me.age}岁 · ` : ""}{me.identity}</div></div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}{t === "目标" && active.length ? ` ${active.length}` : ""}</button>)}
      </div>
      <div className="panel-body">
        {tab === "我" && (
          <div className="stack">
            <div className="stat-grid">
              <Stat label="钱" value={formatMoney(me.stats.money, era.currency)} />
              <Stat label="健康" value={level(me.stats.health, ["康健", "微恙", "带伤", "重伤", "垂危"])} n={me.stats.health} />
              <Stat label="精力" value={level(me.stats.energy, ["充沛", "尚可", "疲惫", "力竭"])} n={me.stats.energy} />
              <Stat label="名望" value={level(100 - me.stats.fame, ["显赫", "知名", "略有耳闻", "无名小卒"])} n={me.stats.fame} />
            </div>
            {me.stats.debt > 0 && <div className="notice">欠债 {formatMoney(me.stats.debt, era.currency)}</div>}
            <div>
              <p className="muted">身上的状况</p>
              {me.statuses.length ? me.statuses.map((s) => (
                <div className="item-row" key={s.name}><div><b>{s.name}</b><small>{s.detail}</small></div></div>
              )) : <p className="muted">无</p>}
            </div>
            <div className="stack" style={{ gap: 4 }}>
              <p className="muted" style={{ margin: 0 }}>{era.startLabel ? `${era.startLabel} · ` : ""}第 {c.day} 日 {c.shichen}时{place ? ` · ${place}` : ""}</p>
              {me.origin && <p className="muted" style={{ margin: 0 }}>穿越前：{me.origin}</p>}
            </div>
          </div>
        )}
        {tab === "行囊" && (me.items.length ? me.items.map((i) => (
          <div className="item-row" key={i.name}>
            <div>{i.name}{i.note && <small>{i.note}</small>}{i.place && <small>放在{i.place}</small>}</div>
            <span>×{i.quantity}{i.unit}</span>
          </div>
        )) : <p className="muted">行囊空空。</p>)}
        {tab === "人物" && (people.length ? people.map((p) => (
          <div className="item-row" key={p.id}>
            <div className="grow">
              <b>{p.name}</b>{!p.alive && " （已故）"}
              <small>{p.role}{p.aliases.length ? ` · 又称${p.aliases.join("、")}` : ""}</small>
              {p.notes && <small>{p.notes}</small>}
            </div>
            <span className="tag">{p.attitude}</span>
          </div>
        )) : <p className="muted">还没有结识什么人。</p>)}
        {tab === "目标" && (
          <div className="stack">
            {active.length ? active.map((g) => (
              <div className="item-row" key={g.id}><div><b>{g.name}</b>{g.progress && <small>{g.progress}</small>}</div><span className="tag">{g.kind}</span></div>
            )) : <p className="muted">眼下没有明确的目标。</p>}
            {finished.length > 0 && <p className="muted">已结束</p>}
            {finished.map((g) => (
              <div className="item-row" key={g.id} style={{ opacity: 0.7 }}><div>{g.name}<small>{g.progress}</small></div><span className="tag">{g.status}</span></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
