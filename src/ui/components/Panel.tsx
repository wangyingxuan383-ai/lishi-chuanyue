// Character & world panel (PLAN_V3 §4.5); the 设定 tab is the 设定集 (§4.14).
import { useState } from "react";
import type { EraContext } from "../../engine/era";
import { nowOf } from "../../engine/calendar/clock";
import { formatMoney } from "../../engine/money";
import type { TurnRecord } from "../../engine/state/apply";
import type { WorldState } from "../../engine/types";
import { useBack } from "../app/context";
import { Codex } from "./Codex";

const TABS = ["我", "行囊", "人物", "目标", "设定"] as const;
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

export function Panel({ state, era, onClose, onSave, onOpenStory, onOrganize, busy }: {
  state: WorldState; era: EraContext; onClose: () => void; onSave: (patch: TurnRecord, summary: string) => Promise<void>;
  onOpenStory: () => void; onOrganize: (replaceOwnEra: boolean) => Promise<boolean>; busy: boolean;
}) {
  const [tab, setTab] = useState<Tab>("我");
  const [draft, setDraft] = useState<WorldState | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = draft !== null;
  const change = (fn: (s: WorldState) => void) => setDraft((s) => { const next = structuredClone(s!); fn(next); return next; });
  useBack(() => { if (saving) return true; if (editing) setDraft(null); else onClose(); return true; });
  const shown = draft ?? state;
  const me = shown.protagonist;
  const now = nowOf(era.clock, state.time.elapsedMinutes);
  const place = state.places.find((p) => p.id === state.placeId)?.name;
  const active = shown.goals.filter((g) => g.status === "进行中");
  const finished = shown.goals.filter((g) => g.status !== "进行中");
  const people = [...shown.people].sort((a, b) => (b.lastSeenMinute ?? -1) - (a.lastSeenMinute ?? -1));

  const save = async () => {
    if (!draft) return;
    const patch: TurnRecord = {};
    const summary: string[] = [];
    const before = state.protagonist;
    for (const [key, label] of [["money", "钱"], ["health", "健康"], ["energy", "精力"], ["fame", "名望"]] as const) {
      const value = Math.max(0, Math.min(key === "money" ? Infinity : 100, me.stats[key]));
      if (value === before.stats[key]) continue;
      (patch.setStats ??= {})[key] = value;
      summary.push(`${label} ${before.stats[key]} → ${value}`);
    }
    for (const s of before.statuses) {
      if (me.statuses.some((x) => x.name === s.name)) continue;
      (patch.status ??= []).push({ op: "remove", name: s.name });
      summary.push(`去掉状况 ${s.name}`);
    }
    for (const s of me.statuses.filter((x) => x.name.trim())) {
      if (before.statuses.some((x) => x.name === s.name)) continue;
      (patch.status ??= []).push({ op: "add", name: s.name.trim(), detail: s.detail });
      summary.push(`添加状况 ${s.name.trim()}`);
    }
    const quantities = new Map<string, number>();
    for (const i of me.items.filter((x) => x.name.trim())) quantities.set(i.name.trim(), (quantities.get(i.name.trim()) ?? 0) + i.quantity);
    for (const name of new Set([...before.items.map((i) => i.name), ...quantities.keys()])) {
      const old = before.items.find((i) => i.name === name)?.quantity ?? 0;
      const quantity = quantities.get(name) ?? 0;
      if (old === quantity) continue;
      (patch.items ??= []).push({ name, delta: quantity - old });
      summary.push(old === 0 ? `添加物品 ${name}` : `${name} ${old} → ${quantity}`);
    }
    for (const p of shown.people) {
      const old = state.people.find((x) => x.id === p.id)!;
      if (p.attitude === old.attitude && p.notes === old.notes && p.alive === old.alive) continue;
      (patch.people ??= []).push({ name: p.name, attitude: p.attitude, note: p.notes, alive: p.alive });
      summary.push(p.attitude !== old.attitude ? `${p.name}：${p.attitude}` : p.alive !== old.alive ? `${p.name}：${p.alive ? "健在" : "已故"}` : `${p.name}：修改备注`);
    }
    for (const g of shown.goals.filter((x) => x.name.trim())) {
      const old = state.goals.find((x) => x.id === g.id);
      if (old?.status === g.status) continue;
      const op = !old ? "add" : g.status === "完成" ? "done" : "abandon";
      (patch.goals ??= []).push({ op, name: g.name.trim(), kind: g.kind });
      summary.push(!old ? `添加目标 ${g.name.trim()}` : `${g.status}目标 ${g.name}`);
    }
    if (!summary.length) { setDraft(null); return; }
    setSaving(true);
    try {
      await onSave(patch, summary.slice(0, 3).join("、") + (summary.length > 3 ? "等" : ""));
      setDraft(null);
    } finally { setSaving(false); }
  };

  return (
    <div className="panel" role="dialog" aria-label="角色">
      <div className="topbar">
        <button className="icon-btn" aria-label="关闭" disabled={saving} onClick={onClose}>‹</button>
        <div className="title"><h1>{me.name}</h1><div className="subtitle">{[me.gender, me.age ? `${me.age}岁` : ""].filter(Boolean).join(" · ")}</div></div>
        {!editing && tab !== "设定" && <button className="ghost" disabled={busy} onClick={() => setDraft(structuredClone(state))}>修改</button>}
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} disabled={editing && t === "设定"} onClick={() => setTab(t)}>{t}{t === "目标" && active.length ? ` ${active.length}` : ""}</button>)}
      </div>
      <div className="panel-body" style={saving ? { pointerEvents: "none" } : undefined}>
        {tab === "我" && (
          <div className="stack">
            {editing ? <div className="stat-grid">
              {([["money", "钱"], ["health", "健康"], ["energy", "精力"], ["fame", "名望"]] as const).map(([key, label]) => (
                <label key={key}>{label}<input aria-label={label} type="number" min={0} max={key === "money" ? undefined : 100} value={me.stats[key]} onChange={(e) => change((s) => { s.protagonist.stats[key] = Number(e.target.value); })} />
                  {key === "money" && <small>{formatMoney(me.stats.money, era.currency)}</small>}
                </label>
              ))}
            </div> : <div className="stat-grid">
              <Stat label="钱" value={formatMoney(me.stats.money, era.currency)} />
              <Stat label="健康" value={level(me.stats.health, ["康健", "微恙", "带伤", "重伤", "垂危"])} n={me.stats.health} />
              <Stat label="精力" value={level(me.stats.energy, ["充沛", "尚可", "疲惫", "力竭"])} n={me.stats.energy} />
              <Stat label="名望" value={level(100 - me.stats.fame, ["显赫", "知名", "略有耳闻", "无名小卒"])} n={me.stats.fame} />
            </div>}
            {me.stats.debt > 0 && <div className="notice">欠债 {formatMoney(me.stats.debt, era.currency)}</div>}
            <div>
              <p className="muted">身上的状况</p>
              {me.statuses.length ? me.statuses.map((s, i) => (
                <div className="item-row" key={i}>
                  {editing && !state.protagonist.statuses.some((x) => x.name === s.name) ? <div className="stack grow">
                    <input aria-label="状况名称" placeholder="名称" value={s.name} onChange={(e) => change((d) => { d.protagonist.statuses[i].name = e.target.value; })} />
                    <input aria-label="状况说明" placeholder="说明" value={s.detail} onChange={(e) => change((d) => { d.protagonist.statuses[i].detail = e.target.value; })} />
                  </div> : <div><b>{s.name}</b><small>{s.detail}</small></div>}
                  {editing && <button onClick={() => change((d) => { d.protagonist.statuses.splice(i, 1); })}>去掉</button>}
                </div>
              )) : <p className="muted">无</p>}
              {editing && <button onClick={() => change((d) => { d.protagonist.statuses.push({ name: "", detail: "", sinceMinute: d.time.elapsedMinutes }); })}>＋ 添加状况</button>}
            </div>
            <div className="stack" style={{ gap: 4 }}>
              <p className="muted" style={{ margin: 0 }}>{now.text}{place ? ` · ${place}` : ""}</p>
              {me.origin && <p className="muted" style={{ margin: 0 }}>穿越前：{me.origin}</p>}
              {me.identity && <p className="muted" style={{ margin: "6px 0 0", lineHeight: 1.7 }}>{me.identity}</p>}
            </div>
          </div>
        )}
        {tab === "行囊" && <div className="stack">{(me.items.length ? me.items.map((i, index) => (
          <div className="item-row" key={index}>
            <div className="grow">{editing && !state.protagonist.items.some((x) => x.name === i.name) ? <input aria-label="物品名称" placeholder="名称" value={i.name} onChange={(e) => change((d) => { d.protagonist.items[index].name = e.target.value; })} /> : i.name}{i.note && <small>{i.note}</small>}{i.place && <small>放在{i.place}</small>}</div>
            <div className="row">
              {editing && <button aria-label={`减少${i.name}`} disabled={i.quantity === 0} onClick={() => change((d) => { d.protagonist.items[index].quantity--; })}>−</button>}
              {editing && !state.protagonist.items.some((x) => x.name === i.name) ? <input aria-label="物品数量" type="number" min={0} style={{ width: 72 }} value={i.quantity} onChange={(e) => change((d) => { d.protagonist.items[index].quantity = Math.max(0, Number(e.target.value)); })} /> : <span>×{i.quantity}{i.unit}</span>}
              {editing && <button aria-label={`增加${i.name}`} onClick={() => change((d) => { d.protagonist.items[index].quantity++; })}>＋</button>}
            </div>
          </div>
        )) : <p className="muted">行囊空空。</p>)}
          {editing && <button onClick={() => change((d) => { d.protagonist.items.push({ name: "", quantity: 1, unit: "", place: null, note: "" }); })}>＋ 添加物品</button>}
        </div>}
        {tab === "人物" && (people.length ? people.map((p) => (
          <div className="item-row" key={p.id}>
            <div className="grow">
              <b>{p.name}</b>{!p.alive && " （已故）"}
              <small>{p.role}{p.aliases.length ? ` · 又称${p.aliases.join("、")}` : ""}</small>
              {editing ? <div className="stack">
                <select aria-label={`${p.name}的态度`} value={p.attitude} onChange={(e) => change((d) => { d.people.find((x) => x.id === p.id)!.attitude = e.target.value as typeof p.attitude; })}>
                  {["仇视", "敌意", "冷淡", "一般", "友善", "亲近", "生死之交"].map((a) => <option key={a}>{a}</option>)}
                </select>
                <input aria-label={`${p.name}的备注`} placeholder="备注" value={p.notes} onChange={(e) => change((d) => { d.people.find((x) => x.id === p.id)!.notes = e.target.value; })} />
                <label className="row"><input type="checkbox" style={{ width: 20, minHeight: 20 }} checked={!p.alive} onChange={(e) => change((d) => { d.people.find((x) => x.id === p.id)!.alive = !e.target.checked; })} />已故</label>
              </div> : p.notes && <small>{p.notes}</small>}
            </div>
            {!editing && <span className="tag">{p.attitude}</span>}
          </div>
        )) : <p className="muted">还没有结识什么人。</p>)}
        {tab === "设定" && <Codex state={state} era={era} busy={busy} onSave={onSave} onOpenStory={onOpenStory} onOrganize={onOrganize} />}
        {tab === "目标" && (
          <div className="stack">
            {active.length ? active.map((g) => (
              <div className="item-row" key={g.id}><div className="grow">{editing && !state.goals.some((x) => x.id === g.id) ? <input aria-label="目标名称" placeholder="名称" value={g.name} onChange={(e) => change((d) => { d.goals.find((x) => x.id === g.id)!.name = e.target.value; })} /> : <b>{g.name}</b>}{g.progress && <small>{g.progress}</small>}</div>
                {editing && state.goals.some((x) => x.id === g.id) ? <div className="segmented"><button onClick={() => change((d) => { d.goals.find((x) => x.id === g.id)!.status = "完成"; })}>完成</button><button onClick={() => change((d) => { d.goals.find((x) => x.id === g.id)!.status = "放弃"; })}>放弃</button></div> : <span className="tag">{g.kind}</span>}
              </div>
            )) : <p className="muted">眼下没有明确的目标。</p>}
            {editing && <button onClick={() => change((d) => { d.goals.push({ id: `new-${d.goals.length}`, name: "", kind: "心愿", progress: "", status: "进行中" }); })}>＋ 添加目标</button>}
            {finished.length > 0 && <p className="muted">已结束</p>}
            {finished.map((g) => (
              <div className="item-row" key={g.id} style={{ opacity: 0.7 }}><div>{g.name}<small>{g.progress}</small></div><span className="tag">{g.status}</span></div>
            ))}
          </div>
        )}
      </div>
      {editing && <div className="dock row" style={{ justifyContent: "space-between" }}>
        <button disabled={saving} onClick={() => setDraft(null)}>取消</button>
        <button className="primary" disabled={saving} onClick={() => void save()}>保存修改</button>
      </div>}
    </div>
  );
}
