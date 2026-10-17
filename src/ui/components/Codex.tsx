// The 设定 tab of the character panel: the world's 设定集 (PLAN §4.14, D121).
// The era card, places and the other cards, each editable on its own; every
// save becomes an edit node that can be undone.
import { useApp } from "../app/context";
import { rejectedReason } from "../../engine/game";
import { useEffect, useRef, useState } from "react";
import type { EraContext } from "../../engine/era";
import { ERA_CARD_LIMIT } from "../../engine/memory/cards";
import type { TurnRecord } from "../../engine/state/apply";
import type { Card, CardKind, Place, WorldState } from "../../engine/types";
import { Sheet } from "./Sheet";
import { Icon } from "./Icon";
import { deletionPatch, selectionKey, type CodexKind, type CodexSelection } from "../../engine/writing/codex";
import "./writing.css";

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
  const { ask, toast } = useApp();
  const isEra = editing.type === "card" && editing.kind === "时代";
  const eraLabel = (state.era as { mode?: string }).mode === "free" ? "世界卡" : "时代卡";
  const original = editing.type === "card" ? editing.card : editing.place;
  // The era card of an old save comes from its pack and is not stored yet.
  const stored = !!original && !original.id.startsWith("pack:");
  const [name, setName] = useState(original?.name ?? "");
  const [aliases, setAliases] = useState((editing.type === "card" ? editing.card?.keys : editing.place?.aliases)?.join("、") ?? "");
  const [text, setText] = useState(editing.type === "card" ? editing.card?.content ?? "" : editing.place?.description ?? "");
  const [saving, setSaving] = useState(false);
  const label = editing.type === "place" ? "地点" : isEra ? eraLabel : `${editing.kind}卡`;
  const isHere = editing.type === "place" && !!editing.place && editing.place.id === state.placeId;
  // A name another entry already has would update that entry instead (AUDIT_V4_FUNCTION F4).
  const pool = editing.type === "place" ? state.places.map((p) => ({ id: p.id, name: p.name })) : state.cards.filter((c) => c.kind !== "时代").map((c) => ({ id: c.id, name: c.name }));
  const taken = !isEra && name.trim() && pool.find((x) => x.name === name.trim() && x.id !== original?.id);

  const run = async (patch: TurnRecord, summary: string) => {
    setSaving(true);
    try { await onSave(patch, summary); onClose(); } catch (e) { toast(rejectedReason(e)); } finally { setSaving(false); }
  };
  const save = () => {
    const clean = name.trim();
    if (!clean || taken) return;
    if (editing.type === "place") {
      const fields = { name: clean, aliases: splitNames(aliases), description: text, source: "玩家" as const };
      void run({ places: [stored ? { op: "update", id: original!.id, ...fields } : { op: "add", ...fields }] }, stored ? `修改地点：${clean}` : `新建地点：${clean}`);
    } else {
      const fields = { kind: editing.kind, name: clean, keys: isEra ? [] : splitNames(aliases), content: text, source: "玩家" as const };
      void run({ cards: [stored ? { op: "update", id: original!.id, ...fields } : { op: "add", ...fields }] }, stored ? `修改${label}：${clean}` : `新建${label}：${clean}`);
    }
  };
  const remove = async () => {
    if (!stored || !await ask({ title: `删除${label}“${original!.name}”？`, message: "之后可以撤销。", confirm: "删除", danger: true })) return;
    void run(editing.type === "place" ? { places: [{ op: "remove", id: original!.id }] } : { cards: [{ op: "remove", id: original!.id }] }, `删除${label}：${original!.name}`);
  };

  return (
    <Sheet title={stored ? `修改${label}` : `新建${label}`} onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <label>名称<input value={name} onChange={(e) => setName(e.target.value)} placeholder={isEra ? eraLabel === "世界卡" ? "如：云海群岛" : "如：唐 · 天宝七载 · 长安" : "名称"} /></label>
        {!isEra && <label>别名（提到这些名字时也会交给 AI，用顿号分开）<input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="可不填" /></label>}
        <label>{editing.type === "place" ? "描述" : "内容"}
          <textarea rows={isEra ? 10 : 5} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={isEra ? "时局、货币与物价、称谓、日常与节令、文风、不要出现的东西……" : "写给 AI 看的资料"} />
        </label>
        {isEra && <p className="muted" style={{ margin: 0 }}>{text.length} / {ERA_CARD_LIMIT} 字{text.length > ERA_CARD_LIMIT ? "，超出的部分不会交给 AI" : `。${eraLabel}每回合都会交给 AI。`}</p>}
        {taken && <p className="field-hint warn">已经有叫“{name.trim()}”的了，换个名字，或者去改那一张。</p>}
        <div className="row">
          {stored && <button className="danger-text" disabled={saving || isHere} onClick={remove}>{isHere ? "当前所在地不能删" : "删除"}</button>}
          <button className="primary grow" disabled={saving || !name.trim() || !!taken} onClick={save}>保存</button>
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
  const { ask, toast } = useApp();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [filter, setFilter] = useState<"全部" | CodexKind>("全部");
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<CodexSelection[]>([]);
  const [deleting, setDeleting] = useState(false);
  const live = useRef({ state, active: true, busy });
  live.current = { state, active: true, busy };
  useEffect(() => () => { live.current.active = false; }, []);
  useEffect(() => { setSelected([]); setSelecting(false); }, [state]);
  const eraCard = era.eraCard;
  const eraLabel = (state.era as { mode?: string }).mode === "free" ? "世界卡" : "时代卡";
  const open = (next: Editing) => { if (!busy && !organizing) setEditing(next); };
  const organize = async () => {
    const own = eraCard?.source === "玩家";
    if (own && !await ask({ title: `让 AI 重新整理${eraLabel}？`, message: `会按故事设定重写，换掉你写的${eraLabel}。之后可以撤销。`, confirm: "重新整理" })) return;
    setOrganizing(true);
    try { await onOrganize(own); } finally { setOrganizing(false); }
  };
  const items = (kind: "地点" | CardKind): { id: string; name: string; text: string; tag?: string; edit: Editing }[] =>
    kind === "地点"
      ? [...state.places].sort((a, b) => Number(b.id === state.placeId) - Number(a.id === state.placeId))
        .map((p) => ({ id: p.id, name: p.name, text: p.description, tag: p.id === state.placeId ? "所在" : p.source === "AI" ? "AI 整理" : undefined, edit: { type: "place", place: p } }))
      : state.cards.filter((c) => c.kind === kind).map((c) => ({ id: c.id, name: c.name, text: c.content, tag: c.source === "AI" ? "AI 整理" : undefined, edit: { type: "card", kind, card: c } }));
  const matches = (item: { name: string; text: string; edit: Editing }) => {
    const aliases = item.edit.type === "place" ? item.edit.place?.aliases : item.edit.card?.keys;
    return [item.name, item.text, ...(aliases ?? [])].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  };
  const visible = GROUPS.filter((g) => filter === "全部" || g.kind === filter);
  const available = visible.flatMap(({ kind }) => items(kind).filter(matches).filter((item) => kind !== "地点" || item.id !== state.placeId).map((item) => ({ id: item.id, kind: kind as CodexKind })));
  const removeSelected = async () => {
    if (deleting || busy || !selected.length) return;
    setDeleting(true);
    const source = state;
    try {
      const names = selected.map((s) => items(s.kind).find((i) => i.id === s.id)?.name).filter(Boolean);
      if (!await ask({ title: `删除选中的 ${selected.length} 项设定？`, message: `${names.slice(0, 5).join("、")}${names.length > 5 ? "等" : ""}。删除后可以在“⋯”里撤销。`, confirm: "删除", danger: true })) return;
      if (!live.current.active || live.current.state !== source || live.current.busy) { toast("故事已经变了，请重新选择要删除的设定"); return; }
      const patch = deletionPatch(source, selected);
      const count = (patch.cards?.length ?? 0) + (patch.places?.length ?? 0);
      if (!count) return;
      await onSave(patch, `批量删除 ${count} 项设定`);
      setSelected([]); setSelecting(false); toast("已删除，可以在“⋯”里撤销");
    } catch { toast("没有删除成功，请稍后再试"); }
    finally { if (live.current.active) setDeleting(false); }
  };

  return (
    <div className="stack">
      <section className="codex-era">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <b className="grow">{eraLabel}</b>
          <button className="ghost" disabled={busy || organizing} onClick={() => void organize()}>{organizing ? "整理中…" : eraCard ? "AI 重新整理" : "AI 整理"}</button>
          <button className="ghost" disabled={busy || organizing} onClick={() => open({ type: "card", kind: "时代", card: eraCard })}>{eraCard ? "编辑" : "写一张"}</button>
        </div>
        {eraCard ? <>
          <p className="muted" style={{ margin: "2px 0 6px" }}>{eraCard.name}{eraCard.source ? ` · ${SOURCE[eraCard.source]}` : ""} · 每回合都交给 AI</p>
          <p className="codex-text">{expanded ? eraCard.content : preview(eraCard.content, 90)}</p>
          {eraCard.content.length > 90 && <button className="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "展开"}</button>}
        </> : <p className="muted" style={{ margin: "2px 0 0" }}>还没有{eraLabel}，AI 只按故事设定来写。可以写下这个世界的称谓、货币、风俗和其他背景。</p>}
      </section>
      <button className="ghost" style={{ textAlign: "left" }} onClick={onOpenStory}>故事设定与要点 ›</button>
      <div className="codex-tools">
        <input aria-label="搜索设定" placeholder="搜索名称、别名或内容" value={query} onChange={(e) => { setQuery(e.target.value); setSelected([]); }} />
        <button className="ghost" disabled={busy || organizing || deleting} onClick={() => { setSelecting(!selecting); setSelected([]); }}>
          {selecting ? "取消" : "批量删除"}
        </button>
      </div>
      <div className="codex-filters" role="group" aria-label="设定分类">
        {(["全部", "地点", "势力", "物品", "设定"] as const).map((kind) => (
          <button key={kind} aria-pressed={filter === kind} onClick={() => { setFilter(kind); setSelected([]); }}>{kind}</button>
        ))}
      </div>
      {visible.map(({ kind, hint }) => {
        const list = items(kind).filter(matches);
        const pick = (item: (typeof list)[number]) => {
          const selection = { id: item.id, kind: kind as CodexKind };
          const here = kind === "地点" && item.id === state.placeId;
          const checked = selected.some((s) => selectionKey(s) === selectionKey(selection));
          return (
            <label key={item.id} className="codex-select">
              <input type="checkbox" aria-label={`选择${kind}：${item.name}`} disabled={busy || deleting || here} checked={checked}
                onChange={(e) => setSelected((chosen) => (e.target.checked ? [...chosen, selection] : chosen.filter((s) => selectionKey(s) !== selectionKey(selection))))} />
              <span><b>{item.name}</b><small>{here ? "当前所在地，不能删" : preview(item.text)}</small></span>
            </label>
          );
        };
        const row = (item: (typeof list)[number]) => (
          <button key={item.id} className="item-row codex-item" onClick={() => open(item.edit)}>
            <div className="grow"><b>{item.name}</b><small>{item.text ? preview(item.text) : "（还没有描述，不会交给 AI）"}</small></div>
            {item.tag && <span className="tag">{item.tag}</span>}
          </button>
        );
        return (
          <section key={kind}>
            <div className="row" style={{ justifyContent: "space-between", minHeight: "var(--tap)" }}>
              <b>{kind}{list.length ? ` ${list.length}` : ""}</b>
              {!selecting && (
                <button className="ghost" aria-label={`新建${kind}`} disabled={busy} onClick={() => open(kind === "地点" ? { type: "place", place: null } : { type: "card", kind, card: null })}>
                  <Icon name="plus" size={18} />新建
                </button>
              )}
            </div>
            {list.length ? list.map(selecting ? pick : row)
              : <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>{query.trim() ? "没有找到匹配的设定" : hint}</p>}
          </section>
        );
      })}
      {selecting && (
        <div className="codex-batch">
          <button disabled={busy || deleting || !available.length} onClick={() => setSelected(available)}>全选</button>
          <button className="danger-text" disabled={busy || deleting || !selected.length} onClick={() => void removeSelected()}>删除所选（{selected.length}）</button>
        </div>
      )}
      {editing && <Editor editing={editing} state={state} onClose={() => setEditing(null)} onSave={onSave} />}
    </div>
  );
}
