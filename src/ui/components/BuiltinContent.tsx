import { useLayoutEffect, useRef, useState } from "react";
import { GENRE_PACKS, type GenrePack } from "../../content/genrePacks";
import { HISTORY_LIFE_PACKS } from "../../content/eras/lifeNotes";
import { BUILTIN_AGENT_SKILLS } from "../../engine/agent";
import { contentCardPatch, editableContentCards, type ContentCardDraft } from "../../engine/writing/contentPacks";
import type { TurnRecord } from "../../engine/state/apply";
import type { WorldState } from "../../engine/types";
import { Sheet } from "./Sheet";
import { useApp } from "../app/context";

const skillNames = (ids: string[]) => ids.map(id => BUILTIN_AGENT_SKILLS.find(skill => skill.id === id)?.name).filter(Boolean).join("、");
const PACKS = [
  ...GENRE_PACKS.map(pack => ({ ...pack, category: "原创题材", note: pack.description, sources: [] as { id: string; title: string; url: string; covers: string }[] })),
  ...HISTORY_LIFE_PACKS.map(pack => ({ ...pack, category: "历史资料" })),
];
type Pack = (typeof PACKS)[number];
const namesFrom = (value: string) => [...new Set(value.split(/[、，,\n]+/).map(word => word.trim()).filter(Boolean))];

function CardPreview({ pack, state, headId, busy, onSave, onBack, onClose, onDirty }: {
  pack: Pack; state: WorldState; headId: string; busy: boolean;
  onSave(patch: TurnRecord, summary: string, expectedHeadId?: string): Promise<void>;
  onBack(): void; onClose(): void; onDirty(): void;
}) {
  const { game, toast } = useApp();
  const [baseHead] = useState(headId), [cards, setCards] = useState(() => editableContentCards(pack));
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const stale = headId !== baseHead;
  const change = (id: string, patch: Partial<ContentCardDraft>) => { onDirty(); setCards(list => list.map(card => card.id === id ? { ...card, ...patch } : card)); };
  const save = async () => {
    if (busy || saving || stale) return;
    setError(""); setSaving(true);
    try {
      const patch = contentCardPatch(state, cards);
      await onSave({ cards: patch }, `选用${pack.title}资料`, baseHead);
      toast(`已加入 ${patch.length} 项，可在设定集修改、删除或撤销`); onClose();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  return <div className="stack">
    <button className="ghost" disabled={saving} onClick={onBack}>‹ 返回资料列表</button>
    <b>{pack.title} · {pack.version}</b>
    <p className="muted m-0">{pack.scope}</p>
    <p className="muted m-0">{pack.note}</p>
    <p className="muted m-0">先选要用的部分，可直接改内容。加入后是本局自己的副本，不会随内置更新变化；不更改时间、钱制或已发生剧情。</p>
    {skillNames(pack.skills) && <small className="muted">需要深入核对时可使用：{skillNames(pack.skills)}。选资料不会启动助手。</small>}
    {cards.map((card, index) => <section className="stack gap-2" key={card.id}>
      <label className="row"><input type="checkbox" className="check-20" checked={card.selected} onChange={event => change(card.id, { selected: event.target.checked })} />加入{card.name}</label>
      <details open={index === 0}><summary>预览与修改</summary><div className="stack mt-2">
      <label>卡片名称<input aria-label={`资料名称：${card.id}`} value={card.name} disabled={!card.selected} onChange={event => change(card.id, { name: event.target.value })} /></label>
      <label>资料内容<textarea aria-label={`资料内容：${card.id}`} rows={5} value={card.content} disabled={!card.selected} onChange={event => change(card.id, { content: event.target.value })} /></label>
      <label>相关词（用顿号分开）<input value={card.keys.join("、")} disabled={!card.selected} onChange={event => change(card.id, { keys: namesFrom(event.target.value) })} /></label>
      </div></details>
    </section>)}
    {!!pack.sources.length && <details><summary>出处与覆盖范围</summary><div className="stack">{pack.sources.map(source => <div key={source.id}><button className="ghost" onClick={() => void game.platform.system.openUrl(source.url)}>{source.title}</button><p className="muted">{source.covers}</p></div>)}</div></details>}
    {stale && <p className="notice">故事已变化，请重新打开资料再选用。</p>}
    {error && <p className="notice">{error}</p>}
    <button className="primary" disabled={busy || saving || stale || !cards.some(card => card.selected)} onClick={() => void save()}>{saving ? "正在加入…" : "加入所选资料"}</button>
  </div>;
}

export function BuiltinContent({ state, headId, busy, onSave, onClose }: {
  state: WorldState; headId: string; busy: boolean; onSave(patch: TurnRecord, summary: string, expectedHeadId?: string): Promise<void>; onClose(): void;
}) {
  const { ask } = useApp();
  const [pack, setPack] = useState<Pack | null>(null), [dirty, setDirty] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const sheet = body.current?.closest<HTMLElement>(".sheet"); if (sheet) sheet.scrollTop = 0; }, [pack]);
  const back = async () => {
    if (dirty && !await ask({ title: "放弃修改？", message: "刚才编辑的资料还没有加入本局。", confirm: "放弃", danger: true })) return;
    setPack(null); setDirty(false);
  };
  return <Sheet title="内置资料与灵感" dirty={dirty} onClose={onClose}><div ref={body}>
    {pack ? <CardPreview key={pack.id} pack={pack} state={state} headId={headId} busy={busy} onSave={onSave} onBack={() => void back()} onDirty={() => setDirty(true)} onClose={onClose} /> : <div className="stack">
      <p className="muted m-0">只提供可编辑的背景资料，不预设剧情或结局。预览与取消都不改本局。</p>
      {["原创题材", "历史资料"].map(category => <section className="stack" key={category}><b>{category}</b>{PACKS.filter(pack => pack.category === category).map(pack => <button className="item-row" key={pack.id} onClick={() => setPack(pack)}><span><b>{pack.title}</b><small>{pack.scope}</small></span></button>)}</section>)}
    </div>}</div>
  </Sheet>;
}

export interface GenreSelection { premise: boolean; identity: boolean; hint: boolean; guidance: boolean }
export function GenreOpeningPreview({ pack, has, stale, onApply, onClose }: {
  pack: GenrePack; has: { premise: boolean; identity: boolean; hint: boolean }; stale: boolean;
  onApply(value: { premise?: string; identity?: string; hint?: string; guidance?: string }): void; onClose(): void;
}) {
  const [selection, setSelection] = useState<GenreSelection>({ premise: !has.premise, identity: !has.identity, hint: !has.hint, guidance: true });
  const [premise, setPremise] = useState(pack.premise), [identity, setIdentity] = useState(pack.identities[0]);
  const [hint, setHint] = useState(pack.openingHint), [guidance, setGuidance] = useState(pack.guidance);
  return <Sheet title={`${pack.title}灵感`} dirty={premise !== pack.premise || identity !== pack.identities[0] || hint !== pack.openingHint || guidance !== pack.guidance} onClose={onClose}>
    <div className="stack">
      <p className="muted m-0">{pack.scope} · {pack.version}</p>
      <p className="muted m-0">只填入勾选的部分，可先修改；已写内容默认保留。题材说明附加到额外规则，不更改原著、玩法或主角姓名。</p>
      <label className="row"><input type="checkbox" className="check-20" checked={selection.premise} onChange={event => setSelection(value => ({ ...value, premise: event.target.checked }))} />填入故事设定{has.premise ? "（替换当前内容）" : ""}</label>
      <textarea aria-label="题材故事设定" rows={4} value={premise} onChange={event => setPremise(event.target.value)} />
      <label className="row"><input type="checkbox" className="check-20" checked={selection.identity} onChange={event => setSelection(value => ({ ...value, identity: event.target.checked }))} />填入主角身份{has.identity ? "（替换当前内容）" : ""}</label>
      <select aria-label="题材身份灵感" value={pack.identities.includes(identity) ? identity : "custom"} onChange={event => { if (event.target.value !== "custom") setIdentity(event.target.value); }}><option value="custom">自己修改</option>{pack.identities.map(text => <option key={text} value={text}>{text}</option>)}</select>
      <textarea aria-label="题材主角身份" rows={3} value={identity} onChange={event => setIdentity(event.target.value)} />
      <label className="row"><input type="checkbox" className="check-20" checked={selection.hint} onChange={event => setSelection(value => ({ ...value, hint: event.target.checked }))} />填入开场提示{has.hint ? "（替换当前内容）" : ""}</label>
      <textarea aria-label="题材开场提示" rows={3} value={hint} onChange={event => setHint(event.target.value)} />
      <label className="row"><input type="checkbox" className="check-20" checked={selection.guidance} onChange={event => setSelection(value => ({ ...value, guidance: event.target.checked }))} />附加题材说明</label>
      <textarea aria-label="题材说明" rows={3} value={guidance} onChange={event => setGuidance(event.target.value)} />
      <small className="muted">适用技能：{skillNames(pack.skills)}。不会自动执行。</small>
      {stale && <p className="notice">开局已变化，请重新打开这份灵感。</p>}
      <button className="primary" disabled={stale || !Object.values(selection).some(Boolean)} onClick={() => onApply({ ...(selection.premise ? { premise } : {}), ...(selection.identity ? { identity } : {}), ...(selection.hint ? { hint } : {}), ...(selection.guidance ? { guidance } : {}) })}>填入所选内容</button>
    </div>
  </Sheet>;
}
