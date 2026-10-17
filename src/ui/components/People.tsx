// The 人物 tab of the character panel: the people records (人物志, PLAN §4.5).
// Each person opens on their own and can be edited or removed; every save
// becomes an edit node that can be undone.
import { useApp } from "../app/context";
import { rejectedReason } from "../../engine/game";
import { useState } from "react";
import { agoText } from "../../engine/calendar/clock";
import type { EraContext } from "../../engine/era";
import type { TurnRecord } from "../../engine/state/apply";
import { matchName } from "../../engine/state/names";
import type { Attitude, Person, WorldState } from "../../engine/types";
import { Sheet } from "./Sheet";
import { Icon } from "./Icon";

const ATTITUDES: Attitude[] = ["仇视", "敌意", "冷淡", "一般", "友善", "亲近", "生死之交"];
const splitNames = (text: string) => text.split(/[、，,\s]+/).map((n) => n.trim()).filter(Boolean);
const preview = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max)}…` : text);
/** Closeness at a glance (AUDIT_V4 8.4): hostile in cinnabar, cold grey, friendly green, close gold. */
export function attitudeClass(a: Attitude): string {
  return a === "仇视" || a === "敌意" ? "att-hostile" : a === "冷淡" ? "att-cold" : a === "友善" ? "att-friendly" : a === "亲近" || a === "生死之交" ? "att-close" : "att-plain";
}

function Editor({ person, state, era, onClose, onSave }: {
  person: Person | null; state: WorldState; era: EraContext; onClose: () => void; onSave: (patch: TurnRecord, summary: string) => Promise<void>;
}) {
  const { ask, toast } = useApp();
  const [name, setName] = useState(person?.name ?? "");
  const [aliases, setAliases] = useState(person?.aliases.join("、") ?? "");
  const [role, setRole] = useState(person?.role ?? "");
  const [attitude, setAttitude] = useState<Attitude>(person?.attitude ?? "一般");
  const [notes, setNotes] = useState(person?.notes ?? "");
  const [origin, setOrigin] = useState(person?.origin ?? "");
  const [alive, setAlive] = useState(person?.alive ?? true);
  const [saving, setSaving] = useState(false);
  const clean = name.trim();
  // A new entry, or a new name, must not be someone the list already has under another wording (AUDIT_V4_FUNCTION F3).
  const found = clean && clean !== person?.name ? matchName(state.people, clean) : undefined;
  const clash = found && found.id !== person?.id ? found : undefined;

  const run = async (patch: TurnRecord, summary: string) => {
    setSaving(true);
    try { await onSave(patch, summary); onClose(); } catch (e) { toast(rejectedReason(e)); } finally { setSaving(false); }
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
      <div className="stack" style={{ gap: 10 }}>
        {person?.lastSeenMinute != null && <p className="muted" style={{ margin: 0 }}>最近相见：{agoText(era.clock, person.lastSeenMinute, state.time.elapsedMinutes)}</p>}
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
        <p className="muted" style={{ margin: 0 }}>这个人出场或被提到时，AI 会看到来历和近况。</p>
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
        <button className="ghost" aria-label="添加人物" disabled={busy} onClick={() => setEditing({ person: null })}><Icon name="plus" size={18} />添加</button>
      </div>
      {people.length ? people.map((p) => (
        <button key={p.id} className="item-row codex-item" disabled={busy} onClick={() => setEditing({ person: p })}>
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
      )) : <p className="muted">还没有结识什么人。</p>}
      {editing && <Editor person={editing.person} state={state} era={era} onClose={() => setEditing(null)} onSave={onSave} />}
    </div>
  );
}
