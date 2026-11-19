// 带到新的一局 (D177): notes of an earlier story chosen to come along with a
// new one. They inform the opening and join the new story as 前作 background.
import { useEffect, useState } from "react";
import type { CanonNote } from "../../engine/sources/notes";
import { NOTE_KIND_LABEL } from "../../engine/sources/notes";
import { useApp } from "../app/context";

export type Carry = { fromWorldId: string; fromTitle: string; ids: string[] } | null;

export function CarryNotes({ value, onChange }: { value: Carry; onChange: (carry: Carry) => void }) {
  const { game } = useApp();
  const [worlds, setWorlds] = useState<{ id: string; title: string }[]>([]);
  const [from, setFrom] = useState(value?.fromWorldId ?? "");
  const [notes, setNotes] = useState<CanonNote[] | null>(null);
  useEffect(() => { void game.repo.listWorlds().then((list) => setWorlds(list.map((w) => ({ id: w.id, title: w.title })))).catch(() => setWorlds([])); }, [game]);
  useEffect(() => {
    setNotes(null);
    if (!from) return;
    void game.carryableNotes(from).then(setNotes).catch(() => setNotes([]));
  }, [from]);
  const title = worlds.find((w) => w.id === from)?.title ?? value?.fromTitle ?? "";
  const chosen = new Set(value?.fromWorldId === from ? value.ids : []);
  const toggle = (id: string, on: boolean) => {
    const ids = on ? [...chosen, id] : [...chosen].filter((x) => x !== id);
    onChange(ids.length ? { fromWorldId: from, fromTitle: title, ids } : null);
  };
  return (
    <div className="stack gap-2">
      <p className="muted m-0">选一个以前的故事，勾选要带上的札记。它们会当作前情交给 AI：开场就会参考，之后也一直在新故事的札记里。</p>
      <label>从哪个故事<select value={from} onChange={(e) => { setFrom(e.target.value); onChange(null); }}>
        <option value="">不带</option>
        {worlds.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
      </select></label>
      {from && notes?.length === 0 && <p className="muted m-0">这个故事还没有整理好的札记。</p>}
      {from && notes && notes.length > 0 && <div className="stack gap-2">
        {notes.map((n) => (
          <label key={n.id} className="row"><input type="checkbox" className="check-20" checked={chosen.has(n.id)} onChange={(e) => toggle(n.id, e.target.checked)} />
            <span className="grow"><span className="tag">{n.source === "story" ? "本局" : "原著"} · {NOTE_KIND_LABEL[n.kind]}</span> {n.title}</span></label>
        ))}
        <div className="row"><button className="ghost" onClick={() => onChange({ fromWorldId: from, fromTitle: title, ids: notes.map((n) => n.id) })}>全选</button>
          <button className="ghost" onClick={() => onChange(null)}>都不带</button></div>
      </div>}
    </div>
  );
}
