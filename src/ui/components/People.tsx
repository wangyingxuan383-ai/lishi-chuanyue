// The 人物 tab of the character panel: the people records (人物志, PLAN §4.5).
// Each person opens on their own and can be edited or removed; every save
// becomes an edit node that can be undone.
import { useApp } from "../app/context";
import { useContext, useEffect, useRef, useState } from "react";
import { personaFromStoryPerson } from "../../engine/companion";
import { buildCharacterAtlas, type CharacterEntry } from "../../engine/characterAtlas";
import { NoteEntry } from "./CanonNotes";
import { agoText } from "../../engine/calendar/clock";
import type { EraContext } from "../../engine/era";
import type { TurnRecord } from "../../engine/state/apply";
import { matchName } from "../../engine/state/names";
import { headFollowsUpkeep } from "../../engine/writing/assist";
import type { Attitude, Person, StoryNode, WorldState } from "../../engine/types";
import { EmptyVignette } from "./ChineseArt";
import { Sheet } from "./Sheet";
import { Icon } from "./Icon";
import { KnowledgeRecords } from "./Continuity";
import { PersonAvatar } from "./BookArt";

const ATTITUDES: Attitude[] = ["仇视", "敌意", "冷淡", "一般", "友善", "亲近", "生死之交"];
const splitNames = (text: string) => text.split(/[、，,\s]+/).map((n) => n.trim()).filter(Boolean);
const preview = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max)}…` : text);
/** Closeness at a glance (AUDIT_V4 8.4): hostile in cinnabar, cold grey, friendly green, close gold. */
export function attitudeClass(a: Attitude): string {
  return a === "仇视" || a === "敌意" ? "att-hostile" : a === "冷淡" ? "att-cold" : a === "友善" ? "att-friendly" : a === "亲近" || a === "生死之交" ? "att-close" : "att-plain";
}

export interface PersonFormFields {
  name: string;
  aliases: string;
  role: string;
  attitude: Attitude;
  notes: string;
  origin: string;
  alive: boolean;
}

export function personToFormFields(person: Person | null | undefined): PersonFormFields {
  return {
    name: person?.name ?? "",
    aliases: person?.aliases.join("、") ?? "",
    role: person?.role ?? "",
    attitude: person?.attitude ?? "一般",
    notes: person?.notes ?? "",
    origin: person?.origin ?? "",
    alive: person?.alive ?? true,
  };
}

export function didPersonChangeInUpkeep(prev: Person | undefined, next: Person | undefined): boolean {
  if (!prev && !next) return false;
  if (!prev || !next) return true;
  return (
    prev.name !== next.name ||
    prev.aliases.join("\u001f") !== next.aliases.join("\u001f") ||
    prev.role !== next.role ||
    prev.attitude !== next.attitude ||
    prev.notes !== next.notes ||
    (prev.origin ?? "") !== (next.origin ?? "") ||
    prev.alive !== next.alive
  );
}

/**
 * Reconciles an open Person editor form when background upkeep updates the state:
 * fields untouched by the player adopt the latest AI values (e.g. `alive: false` or updated `notes`),
 * while fields modified by both the player and upkeep flag `hasFieldConflict` so `expectedHeadId`
 * is not silently advanced over AI updates without player review.
 */
export function reconcilePersonFormOnUpkeep(
  base: PersonFormFields,
  draft: PersonFormFields,
  nextPerson: Person | undefined,
): { nextBase: PersonFormFields; nextDraft: PersonFormFields; syncedAny: boolean; hasFieldConflict: boolean } {
  if (!nextPerson) {
    return { nextBase: base, nextDraft: draft, syncedAny: false, hasFieldConflict: true };
  }
  const incoming = personToFormFields(nextPerson);
  const nextBase: PersonFormFields = { ...base };
  const nextDraft: PersonFormFields = { ...draft };
  let syncedAny = false;
  let hasFieldConflict = false;
  const syncField = <K extends keyof PersonFormFields>(key: K) => {
    if (base[key] === incoming[key]) return;
    if (draft[key] === base[key]) {
      nextDraft[key] = incoming[key];
      nextBase[key] = incoming[key];
      syncedAny = true;
    } else if (draft[key] !== incoming[key]) {
      // Conflicted key: preserve `base[key]` so a subsequent background upkeep cannot make `base[key] === incoming[key]` and silently clear the conflict!
      hasFieldConflict = true;
    } else {
      nextBase[key] = incoming[key];
    }
  };
  for (const key of ["name", "aliases", "role", "attitude", "notes", "origin", "alive"] as const) {
    syncField(key);
  }
  return { nextBase, nextDraft, syncedAny, hasFieldConflict };
}

export interface PersonUpkeepEditorState {
  base: PersonFormFields;
  draft: PersonFormFields;
  upkeepConflict: boolean;
  expectedHeadId: string | undefined;
}

export function stepPersonUpkeepState(
  current: PersonUpkeepEditorState,
  nextPerson: Person | undefined,
  latestHeadId: string | undefined,
): {
  state: PersonUpkeepEditorState;
  syncedAny: boolean;
  hasFieldConflict: boolean;
} {
  const { nextBase, nextDraft, syncedAny, hasFieldConflict } = reconcilePersonFormOnUpkeep(
    current.base,
    current.draft,
    nextPerson,
  );
  const nextConflict = current.upkeepConflict || hasFieldConflict;
  return {
    state: {
      base: nextBase,
      draft: nextDraft,
      upkeepConflict: nextConflict,
      expectedHeadId: nextConflict ? current.expectedHeadId : latestHeadId,
    },
    syncedAny,
    hasFieldConflict,
  };
}

function Editor({ person, state, era, onClose, onClosePanel, captureReading, onSave, worldId, headId, latestHeadId, upkeepSeq = 0, onResolveUpkeepHead, onConflictChange, lineId, busy = false, onContinuitySaved }: {
  person: Person | null; state: WorldState; era: EraContext; onClose: () => void; onClosePanel?: () => void; captureReading?: () => void; onSave: (patch: TurnRecord, summary: string, expectedHeadId?: string) => Promise<void>; worldId?: string; headId?: string; latestHeadId?: string; upkeepSeq?: number; onResolveUpkeepHead?: (nextHeadId: string | undefined) => void; onConflictChange?: (conflicted: boolean) => void; lineId?: string; busy?: boolean; onContinuitySaved?: () => void | Promise<void>;
}) {
  const { game, push, ask, toast } = useApp();
  const noteEntry = useContext(NoteEntry);
  const initialFields = personToFormFields(person);
  const baseFieldsRef = useRef<PersonFormFields>(initialFields);
  const [name, setName] = useState(initialFields.name);
  const [aliases, setAliases] = useState(initialFields.aliases);
  const [role, setRole] = useState(initialFields.role);
  const [attitude, setAttitude] = useState<Attitude>(initialFields.attitude);
  const [notes, setNotes] = useState(initialFields.notes);
  const [origin, setOrigin] = useState(initialFields.origin);
  const [alive, setAlive] = useState(initialFields.alive);
  const [upkeepConflict, setUpkeepConflict] = useState(false);
  const upkeepConflictRef = useRef(false);
  const updateConflict = (next: boolean) => {
    upkeepConflictRef.current = next;
    setUpkeepConflict(next);
    onConflictChange?.(next);
  };
  const [saving, setSaving] = useState(false);
  const appliedSeqRef = useRef(0);
  useEffect(() => {
    if (!person || upkeepSeq === 0 || upkeepSeq === appliedSeqRef.current) return;
    appliedSeqRef.current = upkeepSeq;
    const livePerson = state.people.find((p) => p.id === person.id);
    const currentDraft: PersonFormFields = { name, aliases, role, attitude, notes, origin, alive };
    const stepped = stepPersonUpkeepState(
      {
        base: baseFieldsRef.current,
        draft: currentDraft,
        upkeepConflict: upkeepConflictRef.current,
        expectedHeadId: headId,
      },
      livePerson,
      latestHeadId,
    );
    baseFieldsRef.current = stepped.state.base;
    if (stepped.syncedAny) {
      setName(stepped.state.draft.name);
      setAliases(stepped.state.draft.aliases);
      setRole(stepped.state.draft.role);
      setAttitude(stepped.state.draft.attitude);
      setNotes(stepped.state.draft.notes);
      setOrigin(stepped.state.draft.origin);
      setAlive(stepped.state.draft.alive);
    }
    if (stepped.state.upkeepConflict) {
      if (!upkeepConflictRef.current) updateConflict(true);
      if (stepped.hasFieldConflict) {
        toast("AI 刚更新了这个人物，请先核对最新内容再保存");
      }
    } else {
      updateConflict(false);
      onResolveUpkeepHead?.(stepped.state.expectedHeadId);
      if (stepped.syncedAny) toast("AI 刚更新了这个人物的状态，已同步未改动的项");
    }
  }, [upkeepSeq, person, state.people, headId, latestHeadId, name, aliases, role, attitude, notes, origin, alive, onResolveUpkeepHead, toast]);
  const clean = name.trim();
  // A new entry, or a new name, must not be someone the list already has under another wording (AUDIT_V4_FUNCTION F3).
  const found = clean && clean !== person?.name ? matchName(state.people, clean, { partial: false }) : undefined;
  const clash = found && found.id !== person?.id ? found : undefined;

  const run = async (patch: TurnRecord, summary: string) => {
    setSaving(true);
    try { await onSave(patch, summary, headId); onClose(); } catch (e) { toast(e instanceof Error ? e.message : "没能保存，请稍后再试"); } finally { setSaving(false); }
  };
  const save = () => {
    if (!clean || clash) return;
    const fields = { name: clean, aliases: splitNames(aliases), role: role.trim(), attitude, note: notes.trim(), origin: origin.trim(), alive };
    void run({ people: [person ? { id: person.id, ...fields } : fields] }, person ? `修改人物：${clean}` : `添加人物：${clean}`);
  };
  const remove = async () => {
    if (!person || !await ask({ title: `从人物表里删除“${person.name}”？`, message: "之后可以撤销。", confirm: "删除", danger: true })) return;
    void run({ people: [{ id: person.id, op: "remove", name: person.name }] }, `删除人物：${person.name}`);
  };

  return (
    <Sheet title={person ? person.name : "添加人物"} onClose={onClose}>
      <div className="stack gap-10">
        {upkeepConflict && person && (
          <div className="stack gap-2">
            <p className="notice m-0">AI 刚刚整理更新了这个人物的资料，为免误覆盖最新状态，请先核对。</p>
            <div className="row gap-2">
              {state.people.some((p) => p.id === person.id) && (
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => {
                    const livePerson = state.people.find((p) => p.id === person.id);
                    if (!livePerson) return;
                    const fresh = personToFormFields(livePerson);
                    baseFieldsRef.current = fresh;
                    setName(fresh.name);
                    setAliases(fresh.aliases);
                    setRole(fresh.role);
                    setAttitude(fresh.attitude);
                    setNotes(fresh.notes);
                    setOrigin(fresh.origin);
                    setAlive(fresh.alive);
                    updateConflict(false);
                    onResolveUpkeepHead?.(latestHeadId);
                  }}
                >
                  载入 AI 最新内容
                </button>
              )}
              <button
                type="button"
                className="ghost small"
                onClick={() => {
                  const livePerson = state.people.find((p) => p.id === person.id);
                  if (livePerson) baseFieldsRef.current = personToFormFields(livePerson);
                  updateConflict(false);
                  onResolveUpkeepHead?.(latestHeadId);
                }}
              >
                保留我的修改继续
              </button>
            </div>
          </div>
        )}
        {person && (
          <div className="person-head row between wrap">
            <div className="row">
              <PersonAvatar name={name || person.name} dead={!alive} />
              <span className="muted">{person.lastSeenMinute != null && `最近相见：${agoText(era.clock, person.lastSeenMinute, state.time.elapsedMinutes)}`}</span>
            </div>
            {worldId && (
              <button
                type="button"
                className="ghost small"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  try {
                    const invited = await personaFromStoryPerson(game, worldId, person.id, lineId);
                    captureReading?.();
                    onClose();
                    onClosePanel?.();
                    push({ name: "companion", worldId, lineId, personaId: invited.id, gear: "chat" });
                  } catch (e) {
                    toast(e instanceof Error ? e.message : "没能发起私聊");
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                找TA私聊 ›
              </button>
            )}
          </div>
        )}
        <label>名字<input value={name} onChange={(e) => setName(e.target.value)} placeholder="名字或称呼" /></label>
        <label>别名（其他叫法，用顿号分开）<input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="可不填" /></label>
        <label>身份<input value={role} onChange={(e) => setRole(e.target.value)} placeholder="如：万年县尉，主角的上司" /></label>
        <label>对你的态度
          <select value={attitude} onChange={(e) => setAttitude(e.target.value as Attitude)}>{ATTITUDES.map((a) => <option key={a}>{a}</option>)}</select>
        </label>
        <label>来历（和你的渊源，一直保留）
          <textarea rows={2} value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="如：早年受你相救，知恩图报" />
        </label>
        <label>近况（随剧情更新）
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="和你的过节、答应过的事……" />
        </label>
        <p className="muted m-0">这个人出场或被提到时，AI 会看到来历和近况。</p>
        {person && worldId && headId && <KnowledgeRecords worldId={worldId} headId={headId} person={person} busy={busy || saving} onSaved={onContinuitySaved} />}
        <label className="row"><input type="checkbox" className="check-20" checked={!alive} onChange={(e) => setAlive(!e.target.checked)} />已故</label>
        {clash && <p className="notice m-0">人物表里已经有“{clash.name}”了，点开它修改即可。</p>}
        {person && worldId && (
          <button
            type="button"
            className="ghost"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                const invited = await personaFromStoryPerson(game, worldId, person.id, lineId);
                captureReading?.();
                onClose();
                onClosePanel?.();
                push({ name: "companion", worldId, lineId, personaId: invited.id, gear: "chat" });
              } catch (e) {
                toast(e instanceof Error ? e.message : "没能发起私聊");
              } finally {
                setSaving(false);
              }
            }}
          >
            找{person.name}私聊（伴聊扮演，不改存档）
          </button>
        )}
        {person && noteEntry && <button className="ghost" onClick={() => { onClose(); noteEntry({ kind: "person", subject: person.name, aliases: person.aliases }); }}>整理成札记（这个人在本局的经历）</button>}
        <div className="row">
          {person && <button className="danger-text" disabled={saving} onClick={remove}>删除</button>}
          <button className="primary grow" disabled={saving || !clean || !!clash} onClick={save}>保存</button>
        </div>
      </div>
    </Sheet>
  );
}

export function People({ state, era, busy, onSave, worldId, headId, lineId, path, captureReading, onJumpNode, onContinuitySaved, onClosePanel }: {
  state: WorldState; era: EraContext; busy: boolean; onSave: (patch: TurnRecord, summary: string, expectedHeadId?: string) => Promise<void>; worldId?: string; headId?: string; lineId?: string; path?: Pick<StoryNode, "id" | "kind" | "meta">[]; captureReading?: () => void; onJumpNode?: (nodeId: string) => void; onContinuitySaved?: () => void | Promise<void>; onClosePanel?: () => void;
}) {
  const { game } = useApp();
  const [editing, setEditing] = useState<{ person: Person | null } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const unresolvedConflictRef = useRef(false);
  const openEditor = (person: Person | null) => {
    unresolvedConflictRef.current = false;
    setExpectedHeadId(headId);
    setEditing({ person });
  };
  const closeEditor = () => {
    unresolvedConflictRef.current = false;
    setEditing(null);
  };
  const [expectedHeadId, setExpectedHeadId] = useState(headId);
  const [upkeepSeq, setUpkeepSeq] = useState(0);
  const [view, setView] = useState<"list" | "atlas">("list");
  const [atlas, setAtlas] = useState<CharacterEntry[] | null>(null);
  const prevAnchor = useRef<{ worldId?: string; headId?: string; state: WorldState }>({ worldId, headId, state });
  useEffect(() => {
    const prev = prevAnchor.current;
    if (!headId) {
      if (prev.state !== state) {
        prevAnchor.current = { worldId, headId, state };
        closeEditor();
      }
      return;
    }
    if (prev.worldId === worldId && prev.headId === headId) {
      prevAnchor.current = { worldId, headId, state };
      return;
    }
    const prevState = prev.state;
    const prevHeadId = prev.headId;
    prevAnchor.current = { worldId, headId, state };
    if (prev.worldId !== worldId || !prevHeadId) {
      setExpectedHeadId(headId);
      closeEditor();
      return;
    }
    const applyUpkeepTransition = () => {
      const activePerson = editingRef.current?.person;
      if (activePerson) {
        const oldP = prevState.people.find((p) => p.id === activePerson.id);
        const newP = state.people.find((p) => p.id === activePerson.id);
        if (didPersonChangeInUpkeep(oldP, newP)) {
          setUpkeepSeq((n) => n + 1);
          return;
        }
        if (unresolvedConflictRef.current) {
          return;
        }
      }
      setExpectedHeadId(headId);
    };
    if (path) {
      if (headFollowsUpkeep(path, prevHeadId, headId)) {
        applyUpkeepTransition();
      } else {
        setExpectedHeadId(headId);
        closeEditor();
      }
      return;
    }
    let live = true;
    void game.repo.path(headId).then((loadedPath) => {
      if (!live) return;
      if (headFollowsUpkeep(loadedPath, prevHeadId, headId)) {
        applyUpkeepTransition();
      } else {
        setExpectedHeadId(headId);
        closeEditor();
      }
    }).catch(() => {
      if (live) {
        setExpectedHeadId(headId);
        closeEditor();
      }
    });
    return () => { live = false; };
  }, [game.repo, worldId, headId, path, state]);

  useEffect(() => {
    if (view !== "atlas" || !worldId || !headId) return;
    let live = true;
    void Promise.all([
      game.repo.path(headId),
      game.repo.chaptersOnPath(worldId, headId),
      game.repo.clocksOnPath(headId),
    ])
      .then(([path, chapters, clocks]) => {
        if (!live) return;
        setAtlas(
          buildCharacterAtlas({
            state,
            path,
            chapters,
            clock: era.clock,
            clocks,
          }),
        );
      })
      .catch(() => {
        if (live) setAtlas([]);
      });
    return () => {
      live = false;
    };
  }, [era.clock, game.repo, headId, state, view, worldId]);

  const people = [...state.people].sort((a, b) => Number(b.alive) - Number(a.alive) || (b.lastSeenMinute ?? -1) - (a.lastSeenMinute ?? -1));
  const now = state.time.elapsedMinutes;

  return (
    <div className="stack">
      <div className="row between">
        <b>人物{people.length ? ` ${people.length}` : ""}</b>
        <button className="ghost" aria-label="添加人物" disabled={busy} onClick={() => openEditor(null)}><Icon name="plus" size={18} />添加</button>
      </div>
      {people.length > 0 && worldId && headId && (
        <div className="segmented" role="group" aria-label="人物视图">
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>人物名录</button>
          <button type="button" aria-pressed={view === "atlas"} onClick={() => setView("atlas")}>出场脉络</button>
        </div>
      )}
      {!people.length ? (
        <EmptyVignette kind="tea-cups" title="还没有结识什么人" hint="走出门去与世人交谈，结识的人物都会记进名录。" compact />
      ) : view === "atlas" ? (
        <div className="stack gap-2">
          {!atlas ? (
            <p className="muted m-0">正在梳理人物出场与交集…</p>
          ) : (
            atlas.map((entry) => (
              <div
                key={entry.id}
                className="stack gap-1"
                style={{
                  padding: "10px 12px",
                  borderRadius: "var(--radius)",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                }}
              >
                <div className="row between wrap gap-1">
                  <div className="row gap-2">
                    <PersonAvatar name={entry.name} dead={!entry.alive} />
                    <div>
                      <b>{entry.name}</b>
                      {!entry.alive && <span className="muted">（已故）</span>}
                      <small className="muted" style={{ display: "block" }}>
                        {entry.role || "局中人"} · 共出场 {entry.appearances} 段
                      </small>
                    </div>
                  </div>
                  <span className={`tag ${attitudeClass(entry.attitude)}`}>{entry.attitude}</span>
                </div>
                <small className="muted">
                  {entry.firstTurn != null
                    ? `初见：${entry.firstChapterTitle ? `${entry.firstChapterTitle} · ` : ""}第 ${entry.firstTurn} 段${entry.firstDate ? `（${entry.firstDate}）` : ""}`
                    : "初见：开篇已识"}
                  {entry.lastTurn != null && entry.lastTurn !== entry.firstTurn
                    ? ` · 近见：第 ${entry.lastTurn} 段`
                    : ""}
                </small>
                {entry.coOccurs.length > 0 && (
                  <small className="muted">
                    常同场：{entry.coOccurs.map((c) => `${c.name}(${c.count})`).join("、")}
                  </small>
                )}
                <div className="row wrap gap-1">
                  <button type="button" className="ghost small" disabled={busy} onClick={() => openEditor(entry.person)}>
                    查看小传
                  </button>
                  {onJumpNode && entry.firstNodeId && (
                    <button type="button" className="ghost small" onClick={() => onJumpNode(entry.firstNodeId!)}>
                      跳到初见
                    </button>
                  )}
                  {onJumpNode && entry.lastNodeId && entry.lastNodeId !== entry.firstNodeId && (
                    <button type="button" className="ghost small" onClick={() => onJumpNode(entry.lastNodeId!)}>
                      跳到近见
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        people.map((p) => (
          <button key={p.id} className="item-row codex-item" disabled={busy} onClick={() => openEditor(p)}>
            <PersonAvatar name={p.name} dead={!p.alive} />
            <div className="grow">
              <b>{p.name}</b>{!p.alive && <span className="muted">（已故）</span>}
              <small>{[p.role, p.aliases.length ? `又称${p.aliases.join("、")}` : ""].filter(Boolean).join(" · ") || "身份不明"}</small>
              {p.notes && <small>{preview(p.notes)}</small>}
            </div>
            <div className="person-side">
              <span className={`tag ${attitudeClass(p.attitude)}`}>{p.attitude}</span>
              {p.lastSeenMinute != null && <small>{agoText(era.clock, p.lastSeenMinute, now)}</small>}
            </div>
          </button>
        ))
      )}
      {editing && <Editor key={editing.person?.id ?? "__new"} person={editing.person} state={state} era={era} worldId={worldId} headId={expectedHeadId} latestHeadId={headId} upkeepSeq={upkeepSeq} onResolveUpkeepHead={setExpectedHeadId} onConflictChange={(v) => { unresolvedConflictRef.current = v; }} lineId={lineId} busy={busy} captureReading={captureReading} onContinuitySaved={onContinuitySaved} onClose={closeEditor} onClosePanel={onClosePanel} onSave={onSave} />}
    </div>
  );
}
