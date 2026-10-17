// The 设定 tab of the character panel: the world's 设定集 (PLAN §4.14, D121).
// The era card, places and the other cards, each editable on its own; every
// save becomes an edit node that can be undone.
import { useState } from "react";
import type { EraContext } from "../../engine/era";
import { ERA_CARD_LIMIT } from "../../engine/memory/cards";
import type { TurnRecord } from "../../engine/state/apply";
import type { Card, CardKind, Place, WorldState } from "../../engine/types";
import { Sheet } from "./Sheet";

type Editing =
  | { type: "card"; kind: CardKind; card: Card | null }
  | { type: "place"; place: Place | null };

const GROUPS: { kind: "地点" | CardKind; hint: string }[] = [
  { kind: "地点", hint: "身处其中或被提到时交给 AI" },
  { kind: "势力", hint: "门派、帮会、朝中党派……被提到时交给 AI" },
  { kind: "物品", hint: "有来历的东西；行囊里的数量另记" },
  { kind: "设定", hint: "规矩、风俗、功法、传说……被提到时交给 AI" },
];
const SOURCE: Record<NonNullable<Card["source"]>, string> = { 卡组: "内置卡组", AI: "AI 整理", 玩家: "自己写" };

const splitNames = (text: string) => text.split(/[、，,\s]+/).map((n) => n.trim()).filter(Boolean);
const preview = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max)}…` : text);

function Editor({ editing, state, onClose, onSave }: { editing: Editing; state: WorldState; onClose: () => void; onSave: (patch: TurnRecord, summary: string) => Promise<void> }) {
  const isEra = editing.type === "card" && editing.kind === "时代";
  const original = editing.type === "card" ? editing.card : editing.place;
  // The era card of an old save comes from its pack and is not stored yet.
  const stored = !!original && !original.id.startsWith("pack:");
  const [name, setName] = useState(original?.name ?? "");
  const [aliases, setAliases] = useState((editing.type === "card" ? editing.card?.keys : editing.place?.aliases)?.join("、") ?? "");
  const [text, setText] = useState(editing.type === "card" ? editing.card?.content ?? "" : editing.place?.description ?? "");
  const [saving, setSaving] = useState(false);
  const label = editing.type === "place" ? "地点" : isEra ? "时代卡" : `${editing.kind}卡`;
  const isHere = editing.type === "place" && !!editing.place && editing.place.id === state.placeId;

  const run = async (patch: TurnRecord, summary: string) => {
    setSaving(true);
    try { await onSave(patch, summary); onClose(); } finally { setSaving(false); }
  };
  const save = () => {
    const clean = name.trim();
    if (!clean) return;
    if (editing.type === "place") {
      const fields = { name: clean, aliases: splitNames(aliases), description: text };
      void run({ places: [stored ? { op: "update", id: original!.id, ...fields } : { op: "add", ...fields }] }, stored ? `修改地点：${clean}` : `新建地点：${clean}`);
    } else {
      const fields = { kind: editing.kind, name: clean, keys: isEra ? [] : splitNames(aliases), content: text, source: "玩家" as const };
      void run({ cards: [stored ? { op: "update", id: original!.id, ...fields } : { op: "add", ...fields }] }, stored ? `修改${label}：${clean}` : `新建${label}：${clean}`);
    }
  };
  const remove = () => {
    if (!stored || !confirm(`删除${label}“${original!.name}”？之后可以撤销。`)) return;
    void run(editing.type === "place" ? { places: [{ op: "remove", id: original!.id }] } : { cards: [{ op: "remove", id: original!.id }] }, `删除${label}：${original!.name}`);
  };

  return (
    <Sheet title={stored ? `修改${label}` : `新建${label}`} onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <label>名称<input value={name} onChange={(e) => setName(e.target.value)} placeholder={isEra ? "如：唐 · 天宝七载 · 长安" : "名称"} /></label>
        {!isEra && <label>别名（提到这些名字时也会交给 AI，用顿号分开）<input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="可不填" /></label>}
        <label>{editing.type === "place" ? "描述" : "内容"}
          <textarea rows={isEra ? 10 : 5} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={isEra ? "时局、货币与物价、称谓、日常与节令、文风、不要出现的东西……" : "写给 AI 看的资料"} />
        </label>
        {isEra && <p className="muted" style={{ margin: 0 }}>{text.length} / {ERA_CARD_LIMIT} 字{text.length > ERA_CARD_LIMIT ? "，超出的部分不会交给 AI" : "。时代卡每回合都会交给 AI。"}</p>}
        <div className="row">
          {stored && <button className="danger-text" disabled={saving || isHere} onClick={remove}>{isHere ? "当前所在地不能删" : "删除"}</button>}
          <button className="primary grow" disabled={saving || !name.trim()} onClick={save}>保存</button>
        </div>
      </div>
    </Sheet>
  );
}

export function Codex({ state, era, busy, onSave, onOpenStory, onOrganize }: {
  state: WorldState; era: EraContext; busy: boolean;
  onSave: (patch: TurnRecord, summary: string) => Promise<void>;
  onOpenStory: () => void;
  /** Lets the AI organize the 设定集 from the premise; true when something was added. */
  onOrganize: (replaceOwnEra: boolean) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const eraCard = era.eraCard;
  const open = (next: Editing) => { if (!busy && !organizing) setEditing(next); };
  const organize = async () => {
    const own = eraCard?.source === "玩家";
    if (own && !confirm("AI 会按故事设定重新整理，并覆盖你写的时代卡。确定吗？之后可以撤销。")) return;
    setOrganizing(true);
    try { await onOrganize(own); } finally { setOrganizing(false); }
  };
  const items = (kind: "地点" | CardKind): { id: string; name: string; text: string; tag?: string; edit: Editing }[] =>
    kind === "地点"
      ? [...state.places].sort((a, b) => Number(b.id === state.placeId) - Number(a.id === state.placeId))
        .map((p) => ({ id: p.id, name: p.name, text: p.description, tag: p.id === state.placeId ? "所在" : undefined, edit: { type: "place", place: p } }))
      : state.cards.filter((c) => c.kind === kind).map((c) => ({ id: c.id, name: c.name, text: c.content, tag: c.source === "AI" ? "AI 整理" : undefined, edit: { type: "card", kind, card: c } }));

  return (
    <div className="stack">
      <section className="codex-era">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <b className="grow">时代卡</b>
          <button className="ghost" disabled={busy || organizing} onClick={() => void organize()}>{organizing ? "整理中…" : eraCard ? "AI 重新整理" : "AI 整理"}</button>
          <button className="ghost" disabled={busy || organizing} onClick={() => open({ type: "card", kind: "时代", card: eraCard })}>{eraCard ? "编辑" : "写一张"}</button>
        </div>
        {eraCard ? <>
          <p className="muted" style={{ margin: "2px 0 6px" }}>{eraCard.name}{eraCard.source ? ` · ${SOURCE[eraCard.source]}` : ""} · 每回合都交给 AI</p>
          <p className="codex-text">{expanded ? eraCard.content : preview(eraCard.content, 90)}</p>
          {eraCard.content.length > 90 && <button className="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "展开"}</button>}
        </> : <p className="muted" style={{ margin: "2px 0 0" }}>还没有时代卡，AI 只按故事设定来写。可以写下这个时代的称谓、货币、风俗和不该出现的东西。</p>}
      </section>
      <button className="ghost" style={{ textAlign: "left" }} onClick={onOpenStory}>故事设定与要点 ›</button>
      {GROUPS.map(({ kind, hint }) => {
        const list = items(kind);
        return (
          <section key={kind}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>{kind}{list.length ? ` ${list.length}` : ""}</b>
              <button className="ghost" aria-label={`新建${kind}`} disabled={busy} onClick={() => open(kind === "地点" ? { type: "place", place: null } : { type: "card", kind, card: null })}>＋ 新建</button>
            </div>
            {list.length ? list.map((item) => (
              <button key={item.id} className="item-row codex-item" onClick={() => open(item.edit)}>
                <div className="grow"><b>{item.name}</b><small>{item.text ? preview(item.text) : "（还没有描述，不会交给 AI）"}</small></div>
                {item.tag && <span className="tag">{item.tag}</span>}
              </button>
            )) : <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>{hint}</p>}
          </section>
        );
      })}
      {editing && <Editor editing={editing} state={state} onClose={() => setEditing(null)} onSave={onSave} />}
    </div>
  );
}
