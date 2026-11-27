// The 设定 tab of the character panel: the world's 设定集 (PLAN §4.14, D121).
// The era card, places and the other cards, each editable on its own; every
// save becomes an edit node that can be undone.
import { abilityCardName, isAbilityCard } from "../../engine/memory/cards";
import { useApp } from "../app/context";
import { useContext, useEffect, useRef, useState } from "react";
import { NoteEntry } from "./CanonNotes";
import type { EraContext } from "../../engine/era";
import { ERA_CARD_LIMIT } from "../../engine/memory/cards";
import type { TurnRecord } from "../../engine/state/apply";
import type { Card, CardKind, Place, StoryNode, WorldState } from "../../engine/types";
import { headFollowsUpkeep } from "../../engine/writing/assist";
import { SourceScopeRow } from "./SourceScope";
import { AUTO_SCOPE, type SourceScope } from "../../engine/sources/scope";
import { Sheet } from "./Sheet";
import { Switch } from "./Switch";
import { BuiltinContent } from "./BuiltinContent";
import { Icon } from "./Icon";
import { deletionPatch, selectionKey, type CodexKind, type CodexSelection } from "../../engine/writing/codex";
import "./writing.css";

export type Editing =
  | { type: "card"; kind: CardKind; card: Card | null; /** A new card's suggested name. */ name?: string }
  | { type: "place"; place: Place | null };

export function didEditedCodexChange(
  editing: Editing | null,
  prevState: WorldState,
  nextState: WorldState,
): boolean {
  if (!editing) return false;
  if (editing.type === "place") {
    if (!editing.place) return false;
    const p1 = prevState.places.find((p) => p.id === editing.place!.id);
    const p2 = nextState.places.find((p) => p.id === editing.place!.id);
    if (!p1 && !p2) return false;
    if (!p1 || !p2) return true;
    return (
      p1.name !== p2.name ||
      (p1.aliases ?? []).join("\u001f") !== (p2.aliases ?? []).join("\u001f") ||
      p1.description !== p2.description ||
      p1.source !== p2.source
    );
  }
  if (!editing.card) {
    if (editing.kind === "时代") {
      return prevState.cards.some((c) => c.kind === "时代") !== nextState.cards.some((c) => c.kind === "时代");
    }
    if (editing.name) {
      return !prevState.cards.some((c) => c.name === editing.name) && nextState.cards.some((c) => c.name === editing.name);
    }
    return false;
  }
  if (editing.card.id.startsWith("pack:")) {
    return nextState.cards.some((c) => c.kind === "时代");
  }
  const c1 = prevState.cards.find((c) => c.id === editing.card!.id);
  const c2 = nextState.cards.find((c) => c.id === editing.card!.id);
  if (!c1 && !c2) return false;
  if (!c1 || !c2) return true;
  return (
    c1.name !== c2.name ||
    c1.keys.join("\u001f") !== c2.keys.join("\u001f") ||
    c1.content !== c2.content ||
    c1.source !== c2.source
  );
}

const GROUPS: { kind: "地点" | CardKind; hint: string }[] = [
  { kind: "地点", hint: "身处其中或被提到时交给 AI" },
  { kind: "势力", hint: "门派、帮会、朝中党派……被提到时交给 AI" },
  { kind: "物品", hint: "有来历的东西；行囊里的数量另记" },
  { kind: "设定", hint: "规矩、风俗、功法、传说……被提到时交给 AI" },
];
const SOURCE: Record<NonNullable<Card["source"]>, string> = { 卡组: "内置卡组", AI: "AI 整理", 玩家: "自己写" };

const splitNames = (text: string) => text.split(/[、，,\s]+/).map((n) => n.trim()).filter(Boolean);
const preview = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max)}…` : text);

function Editor({ editing, state, worldId, headId, latestHeadId, upkeepChanged = false, onReloadLatest, onClose, onSave }: { editing: Editing; state: WorldState; worldId: string; headId: string; latestHeadId?: string; upkeepChanged?: boolean; onReloadLatest?: (nextEditing: Editing, nextHeadId: string) => void; onClose: () => void; onSave: (patch: TurnRecord, summary: string, expectedHeadId?: string) => Promise<void> }) {
  const { ask, toast, game } = useApp();
  const noteEntry = useContext(NoteEntry);
  const isEra = editing.type === "card" && editing.kind === "时代";
  const eraLabel = (state.era as { mode?: string }).mode === "free" ? "世界卡" : "时代卡";
  const original = editing.type === "card" ? editing.card : editing.place;
  // The era card of an old save comes from its pack and is not stored yet.
  const stored = !!original && !original.id.startsWith("pack:");
  const [name, setName] = useState(original?.name ?? (editing.type === "card" ? editing.name ?? "" : ""));
  const [aliases, setAliases] = useState((editing.type === "card" ? editing.card?.keys : editing.place?.aliases)?.join("、") ?? "");
  const [text, setText] = useState(editing.type === "card" ? editing.card?.content ?? "" : editing.place?.description ?? "");
  const [saving, setSaving] = useState(false);
  const label = editing.type === "place" ? "地点" : isEra ? eraLabel : `${editing.kind}卡`;
  // 让 AI 改 (R29-T005): the answer fills the fields; nothing is saved until 保存.
  const [instruction, setInstruction] = useState(""), [useSource, setUseSource] = useState(!!state.source), [revising, setRevising] = useState(false);
  const [scope, setScope] = useState<SourceScope>(AUTO_SCOPE);
  const [before, setBefore] = useState<{ name: string; aliases: string; text: string } | null>(null);
  const revise = async () => {
    if (!instruction.trim() || revising) return;
    setRevising(true);
    try {
      const result = await game.reviseEntry(worldId, { label, name: name.trim(), aliases: splitNames(aliases), text }, instruction, { useSource: useSource && !!state.source, scope });
      setBefore({ name, aliases, text });
      if (!isEra || result.name) setName(result.name);
      if (!isEra) setAliases(result.aliases.join("、"));
      setText(result.text);
      toast("AI 改好了，看看再保存");
    } catch (e) { toast(e instanceof Error ? e.message : "这次没改成，稍后再试"); }
    finally { setRevising(false); }
  };
  const isHere = editing.type === "place" && !!editing.place && editing.place.id === state.placeId;
  // The protagonist's 本事 card can stay the AI's to keep up after a hand edit: it sees
  // the edited text when it updates, so what the player fixed carries forward.
  const ability = editing.type === "card" && isAbilityCard(name.trim() || original?.name || "", state.protagonist.name);
  const [aiKeeps, setAiKeeps] = useState(!original || original.source === "AI");
  // A name another entry already has would update that entry instead (AUDIT_V4_FUNCTION F4).
  const pool = editing.type === "place" ? state.places.map((p) => ({ id: p.id, name: p.name })) : state.cards.filter((c) => c.kind !== "时代").map((c) => ({ id: c.id, name: c.name }));
  const taken = !isEra && name.trim() && pool.find((x) => x.name === name.trim() && x.id !== original?.id);

  const run = async (patch: TurnRecord, summary: string) => {
    setSaving(true);
    try { await onSave(patch, summary, headId); onClose(); } catch (e) { toast(e instanceof Error ? e.message : "没能保存，请稍后再试"); } finally { setSaving(false); }
  };
  const save = () => {
    const clean = name.trim();
    if (!clean || taken) return;
    if (editing.type === "place") {
      const fields = { name: clean, aliases: splitNames(aliases), description: text, source: "玩家" as const };
      void run({ places: [stored ? { op: "update", id: original!.id, ...fields } : { op: "add", ...fields }] }, stored ? `修改地点：${clean}` : `新建地点：${clean}`);
    } else {
      const fields = { kind: editing.kind, name: clean, keys: isEra ? [] : splitNames(aliases), content: text, source: ability && aiKeeps ? "AI" as const : "玩家" as const };
      void run({ cards: [stored ? { op: "update", id: original!.id, ...fields } : { op: "add", ...fields }] }, stored ? `修改${label}：${clean}` : `新建${label}：${clean}`);
    }
  };
  const remove = async () => {
    if (!stored || !await ask({ title: `删除${label}“${original!.name}”？`, message: "之后可以撤销。", confirm: "删除", danger: true })) return;
    void run(editing.type === "place" ? { places: [{ op: "remove", id: original!.id }] } : { cards: [{ op: "remove", id: original!.id }] }, `删除${label}：${original!.name}`);
  };

  return (
    <Sheet title={stored ? `修改${label}` : `新建${label}`} onClose={onClose}>
      <div className="stack gap-10">
        {upkeepChanged && latestHeadId && (
          <div className="stack gap-2">
            <p className="field-hint warn m-0">AI 刚刚整理更新了这张{label}，请先查看最新内容再修改，避免覆盖 AI 刚整理的成果。</p>
            <div className="row">
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  if (editing.type === "place") {
                    const latestPlace = editing.place ? state.places.find((p) => p.id === editing.place!.id) ?? null : null;
                    if (latestPlace) {
                      setName(latestPlace.name);
                      setAliases((latestPlace.aliases ?? []).join("、"));
                      setText(latestPlace.description);
                    }
                    onReloadLatest?.({ type: "place", place: latestPlace }, latestHeadId);
                  } else {
                    const latestCard = editing.card && !editing.card.id.startsWith("pack:")
                      ? state.cards.find((c) => c.id === editing.card!.id) ?? null
                      : editing.kind === "时代"
                        ? state.cards.find((c) => c.kind === "时代") ?? editing.card
                        : editing.name
                          ? state.cards.find((c) => c.name === editing.name) ?? null
                          : null;
                    if (latestCard) {
                      setName(latestCard.name);
                      setAliases(latestCard.keys.join("、"));
                      setText(latestCard.content);
                      setAiKeeps(latestCard.source === "AI");
                    }
                    onReloadLatest?.({ ...editing, card: latestCard }, latestHeadId);
                  }
                }}
              >
                查看并载入最新内容
              </button>
            </div>
          </div>
        )}
        <label>名称<input value={name} onChange={(e) => setName(e.target.value)} placeholder={isEra ? eraLabel === "世界卡" ? "如：云海群岛" : "如：唐 · 天宝七载 · 长安" : "名称"} /></label>
        {!isEra && <label>别名（提到这些名字时也会交给 AI，用顿号分开）<input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="可不填" /></label>}
        <label>{editing.type === "place" ? "描述" : "内容"}
          <textarea rows={isEra ? 10 : 5} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={isEra ? "时局、货币与物价、称谓、日常与节令、文风、不要出现的东西……" : "写给 AI 看的资料"} />
        </label>
        {isEra && <p className="muted m-0">{text.length} / {ERA_CARD_LIMIT} 字{text.length > ERA_CARD_LIMIT ? "，超出的部分不会交给 AI" : `。${eraLabel}每回合都会交给 AI。`}</p>}
        {taken && <p className="field-hint warn">已经有叫“{name.trim()}”的了，换个名字，或者去改那一张。</p>}
        {ability && <Switch label="AI 随剧情更新这张卡" note={aiKeeps ? "升级、突破、学会新招时 AI 会照你改过的接着写" : "只按你写的，AI 不会改"} checked={aiKeeps} onChange={setAiKeeps} />}
        <details className="ai-revise" open={!!before || undefined}>
          <summary>让 AI 改</summary>
          <div className="stack gap-2">
            <textarea rows={2} maxLength={500} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={isEra ? "如：货币改成金灵币、银灵币、铜灵币；补上修行境界的称呼" : "如：写得更具体些，补上来历和规矩"} />
            {state.source && <Switch label="参考原著" note={useSource ? "带上原著札记和相关原文片段" : "只按故事设定改"} checked={useSource} onChange={setUseSource} />}
            {state.source && useSource && <SourceScopeRow worldId={worldId} binding={state.source} value={scope} purpose="revise" disabled={revising} onChange={setScope} />}
            <div className="row">
              {before && <button className="ghost" disabled={revising} onClick={() => { setName(before.name); setAliases(before.aliases); setText(before.text); setBefore(null); }}>撤回 AI 的修改</button>}
              <span className="grow" />
              <button disabled={!instruction.trim() || revising || saving} onClick={() => void revise()}>{revising ? "AI 正在改…" : "让 AI 改"}</button>
            </div>
            {before && <p className="field-hint m-0">上面已换成 AI 改过的内容，满意再点“保存”；保存后也能在 ⋯ 里撤销。</p>}
          </div>
        </details>
        {stored && !isEra && noteEntry && original && <button className="ghost" onClick={() => { onClose(); noteEntry({ kind: "setting", subject: original.name, aliases: editing.type === "card" ? editing.card?.keys : editing.place?.aliases }); }}>整理成札记（它在本局的来龙去脉）</button>}
        <div className="row">
          {stored && <button className="danger-text" disabled={saving || isHere} onClick={remove}>{isHere ? "当前所在地不能删" : "删除"}</button>}
          <button className="primary grow" disabled={saving || !name.trim() || !!taken} onClick={save}>保存</button>
        </div>
      </div>
    </Sheet>
  );
}

export function Codex({ worldId, state, era, headId, path, busy, onSave, onOpenStory, onOrganize }: {
  worldId: string; headId: string; path?: Pick<StoryNode, "id" | "kind" | "meta">[]; state: WorldState; era: EraContext; busy: boolean;
  onSave: (patch: TurnRecord, summary: string, expectedHeadId?: string) => Promise<void>;
  onOpenStory: () => void;
  /** Lets the AI organize the 设定集 from the premise; true when something was added. */
  onOrganize: (replaceOwnEra: boolean, useSource?: boolean, scope?: SourceScope) => Promise<boolean>;
}) {
  const { game, ask, toast } = useApp();
  const [builtin, setBuiltin] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [expectedHeadId, setExpectedHeadId] = useState(headId);
  const [upkeepChanged, setUpkeepChanged] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [organizeSource, setOrganizeSource] = useState(true);
  const [organizeScope, setOrganizeScope] = useState<SourceScope>(AUTO_SCOPE);
  const [filter, setFilter] = useState<"全部" | CodexKind>("全部");
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<CodexSelection[]>([]);
  const [deleting, setDeleting] = useState(false);
  const live = useRef({ state, active: true, busy });
  live.current = { state, active: true, busy };
  useEffect(() => () => { live.current.active = false; }, []);
  const prevAnchor = useRef({ worldId, headId, state });
  useEffect(() => {
    const prev = prevAnchor.current;
    if (prev.worldId === worldId && prev.headId === headId) {
      prevAnchor.current = { worldId, headId, state };
      return;
    }
    const prevState = prev.state;
    const prevHeadId = prev.headId;
    prevAnchor.current = { worldId, headId, state };
    const resetAll = () => {
      setExpectedHeadId(headId);
      setUpkeepChanged(false);
      setEditing(null);
      setBuiltin(false);
      setSelected([]);
      setSelecting(false);
    };
    if (prev.worldId !== worldId) {
      resetAll();
      return;
    }
    const applyUpkeepTransition = () => {
      if (didEditedCodexChange(editingRef.current, prevState, state)) {
        setUpkeepChanged(true);
        toast("AI 刚整理更新了这张设定，请先查看最新内容再修改");
        return;
      }
      setExpectedHeadId(headId);
    };
    if (path) {
      if (headFollowsUpkeep(path, prevHeadId, headId)) {
        applyUpkeepTransition();
      } else {
        resetAll();
      }
      return;
    }
    let alive = true;
    void game.repo.path(headId).then((loadedPath) => {
      if (!alive) return;
      if (headFollowsUpkeep(loadedPath, prevHeadId, headId)) {
        applyUpkeepTransition();
      } else {
        resetAll();
      }
    }).catch(() => {
      if (alive) resetAll();
    });
    return () => { alive = false; };
  }, [game.repo, worldId, headId, path, state, toast]);
  const eraCard = era.eraCard;
  const eraLabel = (state.era as { mode?: string }).mode === "free" ? "世界卡" : "时代卡";
  const open = (next: Editing) => { if (!busy && !organizing) { setExpectedHeadId(headId); setUpkeepChanged(false); setEditing(next); } };
  const organize = async () => {
    const own = eraCard?.source === "玩家";
    if (own && !await ask({ title: `让 AI 重新整理${eraLabel}？`, message: `会按故事设定重写，换掉你写的${eraLabel}。之后可以撤销。`, confirm: "重新整理" })) return;
    setOrganizing(true);
    // 资料范围 is for one request: the next 整理 starts from 自动 again (D184).
    try { await onOrganize(own, organizeSource && !!state.source, organizeScope); } finally { setOrganizing(false); setOrganizeScope(AUTO_SCOPE); }
  };
  const items = (kind: "地点" | CardKind): { id: string; name: string; text: string; tag?: string; edit: Editing }[] =>
    kind === "地点"
      ? [...state.places].sort((a, b) => Number(b.id === state.placeId) - Number(a.id === state.placeId))
        .map((p) => ({ id: p.id, name: p.name, text: p.description, tag: p.id === state.placeId ? "所在" : p.source === "AI" ? "AI 整理" : undefined, edit: { type: "place", place: p } }))
      // The protagonist's abilities (“某某的本事”) first: the AI keeps it up as the story goes.
      // The protagonist's abilities (“某某的本事”) have their own place above, next to the era card.
      : state.cards.filter((c) => c.kind === kind && !isAbilityCard(c.name, state.protagonist.name))
        .map((c) => ({ id: c.id, name: c.name, text: c.content, tag: c.source === "AI" ? "AI 整理" : undefined, edit: { type: "card", kind, card: c } }));
  const matches = (item: { name: string; text: string; edit: Editing }) => {
    const aliases = item.edit.type === "place" ? item.edit.place?.aliases : item.edit.card?.keys;
    return [item.name, item.text, ...(aliases ?? [])].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  };
  const visible = GROUPS.filter((g) => filter === "全部" || g.kind === filter);
  const available = visible.flatMap(({ kind }) => items(kind).filter(matches).filter((item) => kind !== "地点" || item.id !== state.placeId).map((item) => ({ id: item.id, kind: kind as CodexKind })));
  const removeSelected = async () => {
    if (deleting || busy || !selected.length) return;
    setDeleting(true);
    const startHead = expectedHeadId;
    try {
      const names = selected.map((s) => items(s.kind).find((i) => i.id === s.id)?.name).filter(Boolean);
      if (!await ask({ title: `删除选中的 ${selected.length} 项设定？`, message: `${names.slice(0, 5).join("、")}${names.length > 5 ? "等" : ""}。删除后可以在“⋯”里撤销。`, confirm: "删除", danger: true })) return;
      const curState = live.current.state;
      const loadedPath = path ?? await game.repo.path(headId).catch(() => []);
      if (!live.current.active || live.current.busy || !headFollowsUpkeep(loadedPath, startHead, headId)) { toast("故事已经变了，请重新选择要删除的设定"); return; }
      const patch = deletionPatch(curState, selected);
      const count = (patch.cards?.length ?? 0) + (patch.places?.length ?? 0);
      if (!count) return;
      await onSave(patch, `批量删除 ${count} 项设定`, headId);
      setSelected([]); setSelecting(false); toast("已删除，可以在“⋯”里撤销");
    } catch (e) { toast(e instanceof Error ? e.message : "没有删除成功，请稍后再试"); }
    finally { if (live.current.active) setDeleting(false); }
  };

  return (
    <div className="stack">
      <section className="codex-era">
        <div className="row between">
          <b className="grow">{eraLabel}</b>
          <button className="ghost" disabled={busy || organizing} onClick={() => void organize()}>{organizing ? "整理中…" : eraCard ? "AI 重新整理" : "AI 整理"}</button>
          <button className="ghost" disabled={busy || organizing} onClick={() => open({ type: "card", kind: "时代", card: eraCard })}>{eraCard ? "编辑" : "写一张"}</button>
        </div>
        {eraCard ? <>
          <p className="muted codex-note">{eraCard.name}{eraCard.source ? ` · ${SOURCE[eraCard.source]}` : ""} · 每回合都交给 AI</p>
          <p className="codex-text">{expanded ? eraCard.content : preview(eraCard.content, 90)}</p>
          {eraCard.content.length > 90 && <button className="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "展开"}</button>}
        </> : <p className="muted codex-note mb-0">还没有{eraLabel}，AI 只按故事设定来写。可以写下这个世界的称谓、货币、风俗和其他背景。</p>}
        {state.source && <Switch label="AI 整理时参考原著" note={organizeSource ? "带上原著札记和相关原文，整理出原著里的势力、地点和规矩" : "只按故事设定整理"} checked={organizeSource} onChange={setOrganizeSource} />}
        {state.source && organizeSource && <SourceScopeRow worldId={worldId} binding={state.source} value={organizeScope} purpose="organize" disabled={organizing} onChange={setOrganizeScope} />}
      </section>
      {(() => {
        // 主角的本事 (D181): where the protagonist's abilities live, next to the era card, not deep in a group.
        const ability = state.cards.find((c) => isAbilityCard(c.name, state.protagonist.name));
        const name = abilityCardName(state.protagonist.name);
        return <section className="codex-ability">
          <div className="row between">
            <span className="row gap-2 grow"><b className="codex-ability-title">{ability?.name ?? name}</b><span className="codex-pin-badge">每回合必带</span></span>
            <button className="ghost" disabled={busy || organizing} onClick={() => open({ type: "card", kind: "设定", card: ability ?? null, name })}>{ability ? "编辑" : "写一张"}</button>
          </div>
          {ability?.content.trim()
            ? <><p className="muted codex-note">{ability.source === "AI" ? "AI 随剧情更新" : "你写的，AI 不会改"}</p><p className="codex-text">{ability.content}</p></>
            : <p className="muted codex-note mb-0">主角自己的本事（修为等级、境界、功法招式、法宝、特殊能力等）记在这里，每回合都交给 AI。AI 整理设定集时会随剧情补上，也可以自己写。</p>}
        </section>;
      })()}
      <button className="ghost t-left" onClick={onOpenStory}>故事设定与要点 ›</button>
      <button className="ghost t-left" disabled={busy || organizing || deleting} onClick={() => { setExpectedHeadId(headId); setBuiltin(true); }}>内置资料与灵感 ›</button>
      {builtin && <BuiltinContent state={state} headId={headId} path={path} busy={busy || organizing || deleting} onSave={onSave} onClose={() => setBuiltin(false)} />}
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
            {item.tag && <span className={`tag${item.tag === "AI 整理" ? " tag-ai" : ""}`}>{item.tag}</span>}
          </button>
        );
        return (
          <section key={kind}>
            <div className="row between tap-row">
              <b>{kind}{list.length ? ` ${list.length}` : ""}</b>
              {!selecting && (
                <button className="ghost" aria-label={`新建${kind}`} disabled={busy} onClick={() => open(kind === "地点" ? { type: "place", place: null } : { type: "card", kind, card: null })}>
                  <Icon name="plus" size={18} />新建
                </button>
              )}
            </div>
            {list.length ? list.map(selecting ? pick : row)
              : <p className="muted small mt-1 mb-0">{query.trim() ? "没有找到匹配的设定" : hint}</p>}
          </section>
        );
      })}
      {selecting && (
        <div className="codex-batch">
          <button disabled={busy || deleting || !available.length} onClick={() => setSelected(available)}>全选</button>
          <button className="danger-text" disabled={busy || deleting || !selected.length} onClick={() => void removeSelected()}>删除所选（{selected.length}）</button>
        </div>
      )}
      {editing && <Editor editing={editing} state={state} worldId={worldId} headId={expectedHeadId} latestHeadId={headId} upkeepChanged={upkeepChanged} onReloadLatest={(nextEditing, nextHead) => { setEditing(nextEditing); setExpectedHeadId(nextHead); setUpkeepChanged(false); }} onClose={() => { setEditing(null); setUpkeepChanged(false); }} onSave={onSave} />}
    </div>
  );
}
