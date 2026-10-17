// Character & world panel (PLAN_V3 §4.5); the 设定 tab is the 设定集 (§4.14).
import { useState } from "react";
import type { EraContext } from "../../engine/era";
import { nowOf } from "../../engine/calendar/clock";
import { rejectedReason } from "../../engine/game";
import { formatMoney } from "../../engine/money";
import type { TurnRecord } from "../../engine/state/apply";
import { matchName } from "../../engine/state/names";
import type { Item, WorldState } from "../../engine/types";
import { useApp, useBack } from "../app/context";
import { Codex } from "./Codex";
import { Goals } from "./Goals";
import { Journal } from "./Journal";
import { People } from "./People";
import { Sheet } from "./Sheet";

const TABS = ["我", "行囊", "人物", "目标", "记事", "设定"] as const;
/** Tabs with their own editors instead of the panel-wide 修改. */
const OWN_EDITOR: readonly string[] = ["行囊", "人物", "目标", "记事", "设定"];
type Tab = (typeof TABS)[number];
type Save = (patch: TurnRecord, summary: string) => Promise<void>;

/** The words the panel shows for each stat, best first (AUDIT_V4 8.3). */
const LEVELS = {
  health: ["康健", "微恙", "带伤", "重伤", "垂危"],
  energy: ["充沛", "尚可", "疲惫", "力竭"],
  fame: ["显赫", "知名", "略有耳闻", "无名小卒"],
} as const;
type Level = keyof typeof LEVELS;
const STAT_LABEL: Record<Level, string> = { health: "健康", energy: "精力", fame: "名望" };

function levelIndex(n: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.floor((100 - n) / (100 / count))));
}
function level(n: number, words: readonly string[]): string {
  return words[levelIndex(n, words.length)];
}
/** The middle of a level's band, so the number shows the same word again: 康健 90, 微恙 70… */
function levelValue(index: number, count: number): number {
  return Math.round(100 - (100 / count) * (index + 0.5));
}

export const NAME_MAX = 12;
const quantityText = (i: Item) => `${i.quantity}${i.unit ? ` ${i.unit}` : ""}`;

function Stat({ label, value, n }: { label: string; value: string; n?: number }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {n !== undefined && <div className="bar"><i style={{ width: `${n}%` }} /></div>}
    </div>
  );
}

/** 人物小传: name, age, identity, who they were and their 金手指 (AUDIT_V4_FUNCTION F7). */
function BioSheet({ state, onClose, onSave }: { state: WorldState; onClose: () => void; onSave: Save }) {
  const me = state.protagonist;
  const [name, setName] = useState(me.name);
  const [age, setAge] = useState(me.age != null ? String(me.age) : "");
  const [identity, setIdentity] = useState(me.identity);
  const [origin, setOrigin] = useState(me.origin);
  const [cheat, setCheat] = useState(me.cheat);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const clean = name.trim();
  const ageNumber = age === "" ? null : Number(age);
  const ageBad = ageNumber !== null && (ageNumber < 1 || ageNumber > 120);
  const nameBad = !clean ? "名字不能空着" : [...clean].length > NAME_MAX ? `名字最多 ${NAME_MAX} 个字` : null;

  const save = async () => {
    const profile: NonNullable<TurnRecord["profile"]> = {};
    const summary: string[] = [];
    if (clean !== me.name) { profile.name = clean; summary.push(`名字 ${me.name} → ${clean}`); }
    if (ageNumber !== me.age) { profile.age = ageNumber; summary.push(ageNumber === null ? "年龄改为不详" : `年龄 ${ageNumber} 岁`); }
    if (identity.trim() !== me.identity) { profile.identity = identity; summary.push("身份"); }
    if (origin.trim() !== me.origin) { profile.origin = origin; summary.push("穿越前"); }
    if (cheat.trim() !== me.cheat) { profile.cheat = cheat; summary.push("金手指"); }
    if (!summary.length) { onClose(); return; }
    setSaving(true);
    try {
      await onSave({ profile }, `人物小传：${summary.join("、")}`);
      onClose();
    } catch (e) { setProblem(rejectedReason(e)); } finally { setSaving(false); }
  };

  return (
    <Sheet title="人物小传" onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="row bio-fields">
          <label className="grow">名字
            <span className="field-line">
              <input aria-label="名字" value={name} onChange={(e) => setName(e.target.value)} className={nameBad ? "wanted" : ""} />
              <span className="field-suffix">{[...clean].length}/{NAME_MAX}</span>
            </span>
          </label>
          <label style={{ width: 92 }}>年龄
            <input aria-label="年龄" inputMode="numeric" value={age} placeholder="不详" className={ageBad ? "wanted" : ""} onChange={(e) => setAge(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </label>
        </div>
        {(nameBad || ageBad) && <p className="field-hint warn">{nameBad ?? "年龄要在 1～120 岁之间"}</p>}
        <label>身份与处境<textarea rows={3} value={identity} onChange={(e) => setIdentity(e.target.value)} placeholder="你是谁、身处什么境地" /></label>
        <label>穿越前<input value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="穿越前你是谁；本来就是这个时代的人可不填" /></label>
        <label>金手指<input value={cheat} onChange={(e) => setCheat(e.target.value)} placeholder="带过来的本事或知识，如：熟读唐史、会做外科手术" /></label>
        <p className="muted" style={{ margin: 0 }}>AI 每回合都会看到这些。保存后可以撤销。</p>
        {problem && <p className="notice" style={{ margin: 0 }}>{problem}</p>}
        <button className="primary" disabled={saving || !!nameBad || ageBad} onClick={() => void save()}>保存</button>
      </div>
    </Sheet>
  );
}

/** One item of the 行囊, or a new one (AUDIT_V4_FUNCTION F8). */
function ItemSheet({ item, state, onClose, onSave }: { item: Item | null; state: WorldState; onClose: () => void; onSave: Save }) {
  const { ask } = useApp();
  const [name, setName] = useState(item?.name ?? "");
  const [quantity, setQuantity] = useState(String(item?.quantity ?? 1));
  const [unit, setUnit] = useState(item?.unit ?? "");
  const [place, setPlace] = useState(item?.place ?? "");
  const [note, setNote] = useState(item?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const clean = name.trim();
  const count = Number(quantity || 0);
  const items = state.protagonist.items;
  const same = clean && clean !== item?.name ? matchName(items.filter((i) => i !== item && i.name !== item?.name), clean) : undefined;

  const run = async (patch: TurnRecord, summary: string) => {
    setSaving(true);
    try { await onSave(patch, summary); onClose(); } catch (e) { setProblem(rejectedReason(e)); } finally { setSaving(false); }
  };
  const save = async () => {
    if (!clean) return;
    if (same) {
      const merge = await ask({ title: `行囊里已经有“${same.name}”`, message: `合并成一件，数量加到 ${same.quantity + count}？`, confirm: "合并" });
      if (!merge) { setProblem(`换个名字，或者合并到“${same.name}”。`); return; }
      const patch: TurnRecord = { items: [{ name: same.name, set: { quantity: same.quantity + count } }, ...(item ? [{ name: item.name, set: { quantity: 0 } }] : [])] };
      void run(patch, item ? `${item.name}并入${same.name}` : `${same.name} ${same.quantity} → ${same.quantity + count}`);
      return;
    }
    const set = { name: clean, quantity: count, unit, place: place.trim() || null, note };
    if (!item) { void run({ items: [{ name: clean, set }] }, `添加物品 ${clean}${count > 1 ? ` ×${count}` : ""}`); return; }
    void run({ items: [{ name: item.name, set }] }, count === 0 ? `去掉物品 ${item.name}` : `修改物品 ${item.name === clean ? clean : `${item.name} → ${clean}`}`);
  };
  const remove = async () => {
    if (!item || !await ask({ title: `从行囊里去掉“${item.name}”？`, message: "之后可以撤销。", confirm: "去掉", danger: true })) return;
    void run({ items: [{ name: item.name, set: { quantity: 0 } }] }, `去掉物品 ${item.name}`);
  };

  return (
    <Sheet title={item ? item.name : "添加物品"} onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <label>名称<input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：紫毫笔" /></label>
        <div className="row">
          <label className="grow">数量<input aria-label="数量" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
          <label className="grow">单位<input aria-label="单位" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="支、两、卷" /></label>
        </div>
        <label>放在哪<input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="不填就是带在身上" /></label>
        <label>备注<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="来历、用处" /></label>
        {same && <p className="field-hint warn">行囊里已经有“{same.name}”，保存时会问你要不要合并。</p>}
        {problem && <p className="notice" style={{ margin: 0 }}>{problem}</p>}
        <div className="row">
          {item && <button className="danger-text" disabled={saving} onClick={() => void remove()}>去掉</button>}
          <button className="primary grow" disabled={saving || !clean || (!item && count === 0)} onClick={() => void save()}>保存</button>
        </div>
      </div>
    </Sheet>
  );
}

export function Panel({ worldId, headId, chapterEvery, state, era, onClose, onSave, onOpenStory, onOrganize, busy, docked = false }: {
  worldId: string; headId: string; chapterEvery: number;
  /** Shown beside the story on wide windows instead of over it (R10-T001). */
  docked?: boolean;
  state: WorldState; era: EraContext; onClose: () => void; onSave: Save;
  onOpenStory: () => void; onOrganize: (replaceOwnEra: boolean) => Promise<boolean>; busy: boolean;
}) {
  const [tab, setTab] = useState<Tab>("我");
  const [draft, setDraft] = useState<WorldState | null>(null);
  // What the draft started from: beside a docked panel a turn can be played while editing, and saving keeps what it did.
  const [base, setBase] = useState<WorldState | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [bio, setBio] = useState(false);
  const [item, setItem] = useState<{ item: Item | null } | null>(null);
  const editing = draft !== null;
  const change = (fn: (s: WorldState) => void) => setDraft((s) => { const next = structuredClone(s!); fn(next); return next; });
  useBack(() => {
    if (saving) return true;
    if (editing) { setDraft(null); return true; }
    if (docked) return false;
    onClose();
    return true;
  });
  const shown = draft ?? state;
  const me = shown.protagonist;
  const now = nowOf(era.clock, state.time.elapsedMinutes);
  const place = state.places.find((p) => p.id === state.placeId)?.name;
  const active = state.goals.filter((g) => g.status === "进行中");

  const save = async () => {
    if (!draft) return;
    const patch: TurnRecord = {};
    const summary: string[] = [];
    // Only what the player changed since the draft began; the values shown are today's.
    const before = (base ?? state).protagonist;
    const current = state.protagonist;
    const money = Math.max(0, Math.round(me.stats.money || 0));
    if (money !== before.stats.money) {
      (patch.setStats ??= {}).money = money;
      summary.push(`钱 ${formatMoney(current.stats.money, era.currency)} → ${formatMoney(money, era.currency)}`);
    }
    for (const key of Object.keys(LEVELS) as Level[]) {
      const value = me.stats[key];
      if (value === before.stats[key]) continue;
      (patch.setStats ??= {})[key] = value;
      summary.push(`${STAT_LABEL[key]} ${level(current.stats[key], LEVELS[key])} → ${level(value, LEVELS[key])}`);
    }
    for (const s of before.statuses) {
      if (me.statuses.some((x) => x.name === s.name) || !current.statuses.some((x) => x.name === s.name)) continue;
      (patch.status ??= []).push({ op: "remove", name: s.name });
      summary.push(`去掉状况 ${s.name}`);
    }
    for (const s of me.statuses.filter((x) => x.name.trim())) {
      if (before.statuses.some((x) => x.name === s.name)) continue;
      (patch.status ??= []).push({ op: "add", name: s.name.trim(), detail: s.detail });
      summary.push(`添加状况 ${s.name.trim()}`);
    }
    if (!summary.length) { setDraft(null); return; }
    setSaving(true);
    setProblem(null);
    try {
      await onSave(patch, summary.slice(0, 3).join("、") + (summary.length > 3 ? "等" : ""));
      setDraft(null);
    } catch (e) { setProblem(rejectedReason(e)); } finally { setSaving(false); }
  };

  return (
    <div className={`panel${docked ? " docked" : ""}`} role={docked ? "complementary" : "dialog"} aria-label="角色">
      <div className="topbar">
        {!docked && <button className="icon-btn" aria-label="关闭" disabled={saving} onClick={onClose}>‹</button>}
        <div className="title"><h1>{tab === "我" ? "我" : me.name}</h1>{tab !== "我" && <div className="subtitle">{[me.gender, me.age ? `${me.age}岁` : ""].filter(Boolean).join(" · ")}</div>}</div>
        {!editing && !OWN_EDITOR.includes(tab) && <button className="ghost" disabled={busy} onClick={() => { setProblem(null); setBase(state); setDraft(structuredClone(state)); }}>修改</button>}
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} disabled={editing && t !== "我"} onClick={() => setTab(t)}>{t}{t === "目标" && active.length ? ` ${active.length}` : ""}</button>)}
      </div>
      <div className="panel-body" style={saving ? { pointerEvents: "none" } : undefined}>
        {tab === "我" && (
          <div className="stack">
            <section className="bio-card">
              <div className="bio-head">
                <h2 className="bio-name">{me.name}</h2>
                <span className="muted">{[me.gender, me.age ? `${me.age} 岁` : ""].filter(Boolean).join(" · ")}</span>
                <button className="ghost bio-edit" disabled={busy || editing} onClick={() => setBio(true)}>改小传</button>
              </div>
              {me.identity && <p className="bio-identity">{me.identity}</p>}
              {me.origin && <p className="bio-line"><span>穿越前</span>{me.origin}</p>}
              {me.cheat && <p className="bio-line"><span>金手指</span>{me.cheat}</p>}
              <p className="bio-line"><span>此时此地</span>{now.text}{place ? ` · ${place}` : ""}</p>
            </section>
            {editing ? <div className="stack" style={{ gap: 12 }}>
              <label>钱
                <span className="field-line">
                  <input aria-label="钱" inputMode="numeric" value={String(me.stats.money)} onChange={(e) => change((s) => { s.protagonist.stats.money = Number(e.target.value.replace(/\D/g, "").slice(0, 12) || 0); })} />
                  {formatMoney(me.stats.money, era.currency) !== String(me.stats.money) && <span className="field-suffix">{formatMoney(me.stats.money, era.currency)}</span>}
                </span>
              </label>
              {(Object.keys(LEVELS) as Level[]).map((key) => {
                const words = LEVELS[key];
                const at = levelIndex(me.stats[key], words.length);
                return (
                  <div key={key} className="stack" style={{ gap: 6 }}>
                    <span className="field-label">{STAT_LABEL[key]}</span>
                    <div className="segmented level-buttons" role="group" aria-label={STAT_LABEL[key]}>
                      {words.map((w, i) => <button key={w} aria-pressed={at === i} onClick={() => change((s) => {
                        // A word already shown keeps its exact number.
                        if (levelIndex(s.protagonist.stats[key], words.length) !== i) s.protagonist.stats[key] = levelValue(i, words.length);
                      })}>{w}</button>)}
                    </div>
                  </div>
                );
              })}
            </div> : <div className="stat-grid">
              <Stat label="钱" value={formatMoney(me.stats.money, era.currency)} />
              <Stat label="健康" value={level(me.stats.health, LEVELS.health)} n={me.stats.health} />
              <Stat label="精力" value={level(me.stats.energy, LEVELS.energy)} n={me.stats.energy} />
              <Stat label="名望" value={level(me.stats.fame, LEVELS.fame)} n={me.stats.fame} />
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
            {problem && <p className="notice" style={{ margin: 0 }}>{problem}</p>}
          </div>
        )}
        {tab === "行囊" && <div className="stack">
          {me.items.length ? me.items.map((i, index) => (
            <button key={`${i.name}-${index}`} className="item-row codex-item" disabled={busy} onClick={() => setItem({ item: i })}>
              <div className="grow"><b>{i.name}</b>{i.note && <small>{i.note}</small>}{i.place && <small>放在{i.place}</small>}</div>
              <span className="item-count">{quantityText(i)}</span>
            </button>
          )) : <p className="muted">行囊空空。</p>}
          <button disabled={busy} onClick={() => setItem({ item: null })}>＋ 添加物品</button>
        </div>}
        {tab === "人物" && <People state={state} era={era} busy={busy} onSave={onSave} />}
        {tab === "记事" && <Journal worldId={worldId} headId={headId} chapterEvery={chapterEvery} busy={busy} state={state} era={era} onSave={onSave} />}
        {tab === "设定" && <Codex state={state} era={era} busy={busy} onSave={onSave} onOpenStory={onOpenStory} onOrganize={onOrganize} />}
        {tab === "目标" && <Goals state={state} era={era} busy={busy} onSave={onSave} />}
      </div>
      {editing && <div className="dock row" style={{ justifyContent: "space-between" }}>
        <button disabled={saving} onClick={() => setDraft(null)}>取消</button>
        <button className="primary" disabled={saving || busy} onClick={() => void save()}>{busy ? "等这段写完" : "保存修改"}</button>
      </div>}
      {bio && <BioSheet state={state} onClose={() => setBio(false)} onSave={onSave} />}
      {item && <ItemSheet item={item.item} state={state} onClose={() => setItem(null)} onSave={onSave} />}
    </div>
  );
}
