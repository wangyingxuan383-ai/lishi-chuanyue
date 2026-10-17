// The 人物 tab of the character panel: the people records (人物志, PLAN §4.5).
// Each person opens on their own and can be edited or removed; every save
// becomes an edit node that can be undone.
import { useState } from "react";
import { agoText } from "../../engine/calendar/clock";
import type { EraContext } from "../../engine/era";
import type { TurnRecord } from "../../engine/state/apply";
import { matchName } from "../../engine/state/names";
import type { Attitude, Person, WorldState } from "../../engine/types";
import { Sheet } from "./Sheet";

const ATTITUDES: Attitude[] = ["仇视", "敌意", "冷淡", "一般", "友善", "亲近", "生死之交"];
const splitNames = (text: string) => text.split(/[、，,\s]+/).map((n) => n.trim()).filter(Boolean);
const preview = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max)}…` : text);

function Editor({ person, state, era, onClose, onSave }: {
  person: Person | null; state: WorldState; era: EraContext; onClose: () => void; onSave: (patch: TurnRecord, summary: string) => Promise<void>;
}) {
  const [name, setName] = useState(person?.name ?? "");
  const [aliases, setAliases] = useState(person?.aliases.join("、") ?? "");
  const [role, setRole] = useState(person?.role ?? "");
  const [attitude, setAttitude] = useState<Attitude>(person?.attitude ?? "一般");
  const [notes, setNotes] = useState(person?.notes ?? "");
  const [alive, setAlive] = useState(person?.alive ?? true);
  const [saving, setSaving] = useState(false);
  const clean = name.trim();
  // A new entry must not be someone the list already has under another wording.
  const clash = !person && clean ? matchName(state.people, clean) : undefined;

  const run = async (patch: TurnRecord, summary: string) => {
    setSaving(true);
    try { await onSave(patch, summary); onClose(); } finally { setSaving(false); }
  };
  const save = () => {
    if (!clean || clash) return;
    const fields = { name: clean, aliases: splitNames(aliases), role: role.trim(), attitude, note: notes.trim(), alive };
    void run({ people: [person ? { id: person.id, ...fields } : fields] }, person ? `修改人物：${clean}` : `添加人物：${clean}`);
  };
  const remove = () => {
    if (!person || !confirm(`从人物表里删除“${person.name}”？之后可以撤销。`)) return;
    void run({ people: [{ id: person.id, op: "remove", name: person.name }] }, `删除人物：${person.name}`);
  };

  return (
    <Sheet title={person ? person.name : "添加人物"} onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        {person?.lastSeenMinute != null && <p className="muted" style={{ margin: 0 }}>最近相见：{agoText(era.clock, person.lastSeenMinute, state.time.elapsedMinutes)}</p>}
        <label>名字<input value={name} onChange={(e) => setName(e.target.value)} placeholder="名字或称呼" /></label>
        <label>别名（其他叫法，用顿号分开）<input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="可不填" /></label>
        <label>身份<input value={role} onChange={(e) => setRole(e.target.value)} placeholder="如：万年县尉，主角的上司" /></label>
        <label>对你的态度
          <select value={attitude} onChange={(e) => setAttitude(e.target.value as Attitude)}>{ATTITUDES.map((a) => <option key={a}>{a}</option>)}</select>
        </label>
        <label>备注（这个人出场或被提到时 AI 会看到）
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="来历、和你的过节、答应过的事……" />
        </label>
        <label className="row"><input type="checkbox" style={{ width: 20, minHeight: 20 }} checked={!alive} onChange={(e) => setAlive(!e.target.checked)} />已故</label>
        {clash && <p className="notice" style={{ margin: 0 }}>人物表里已经有“{clash.name}”了，点开它修改即可。</p>}
        <div className="row">
          {person && <button className="danger-text" disabled={saving} onClick={remove}>删除</button>}
          <button className="primary grow" disabled={saving || !clean || !!clash} onClick={save}>保存</button>
        </div>
      </div>
    </Sheet>
  );
}

export function People({ state, era, busy, onSave }: {
  state: WorldState; era: EraContext; busy: boolean; onSave: (patch: TurnRecord, summary: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<{ person: Person | null } | null>(null);
  const people = [...state.people].sort((a, b) => Number(b.alive) - Number(a.alive) || (b.lastSeenMinute ?? -1) - (a.lastSeenMinute ?? -1));
  const now = state.time.elapsedMinutes;

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>人物{people.length ? ` ${people.length}` : ""}</b>
        <button className="ghost" aria-label="添加人物" disabled={busy} onClick={() => setEditing({ person: null })}>＋ 添加</button>
      </div>
      {people.length ? people.map((p) => (
        <button key={p.id} className="item-row codex-item" disabled={busy} onClick={() => setEditing({ person: p })}>
          <div className="grow">
            <b>{p.name}</b>{!p.alive && <span className="muted">（已故）</span>}
            <small>{[p.role, p.aliases.length ? `又称${p.aliases.join("、")}` : ""].filter(Boolean).join(" · ") || "身份不明"}</small>
            {p.notes && <small>{preview(p.notes)}</small>}
          </div>
          <div className="person-side">
            <span className="tag">{p.attitude}</span>
            {p.lastSeenMinute != null && <small>{agoText(era.clock, p.lastSeenMinute, now)}</small>}
          </div>
        </button>
      )) : <p className="muted">还没有结识什么人。</p>}
      {editing && <Editor person={editing.person} state={state} era={era} onClose={() => setEditing(null)} onSave={onSave} />}
    </div>
  );
}
