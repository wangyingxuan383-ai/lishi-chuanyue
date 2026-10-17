// 展开输入 (R13-T103): a full-height editor for a long action, with the
// player's 常用行动 to drop in. 完成输入 only puts the text back into the input
// box; nothing here sends a turn.
import { useEffect, useState } from "react";
import type { ActionMode } from "../../engine/types";
import { newId } from "../../engine/db/repo";
import { ACTIONS_KEY, loadActions, type SavedAction } from "../../engine/writing/library";
import { useApp } from "../app/context";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import "./writing.css";

const MODES: [ActionMode, string][] = [["do", "做"], ["say", "说"], ["write", "写"], ["direct", "幕后"]];
const firstLine = (text: string) => text.trim().split("\n")[0];

export function WritingDesk({ text, mode, onDone, onClose }: {
  text: string; mode: ActionMode; onDone: (text: string, mode: ActionMode) => void; onClose: () => void;
}) {
  const { game, toast, askName } = useApp();
  const [draft, setDraft] = useState(text);
  const [draftMode, setDraftMode] = useState(mode);
  const [actions, setActions] = useState<SavedAction[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    void loadActions(game.repo).then((list) => { if (active) { setActions(list); setLoaded(true); } });
    return () => { active = false; };
  }, [game]);

  const save = async () => {
    if (saving || !draft.trim()) return;
    setSaving(true);
    try {
      const name = await askName({ title: "保存为常用行动", initial: draft.trim().slice(0, 12) });
      if (!name) return;
      const next = [...await loadActions(game.repo), { id: newId(), name, text: draft, mode: draftMode }];
      await game.repo.setSetting(ACTIONS_KEY, next);
      setActions(next);
      toast("已保存常用行动");
    } catch {
      toast("没能保存，请稍后再试");
    } finally {
      setSaving(false);
    }
  };
  const remove = async (action: SavedAction) => {
    if (saving) return;
    setSaving(true);
    try {
      const next = (await loadActions(game.repo)).filter((a) => a.id !== action.id);
      await game.repo.setSetting(ACTIONS_KEY, next);
      setActions(next);
      toast("已删除常用行动", { label: "撤回", run: () => {
        void loadActions(game.repo).then(async (list) => {
          const restored = list.some((a) => a.id === action.id) ? list : [...list, action];
          await game.repo.setSetting(ACTIONS_KEY, restored);
          setActions(restored);
        }).catch(() => toast("没能恢复，请稍后再试"));
      } });
    } catch {
      toast("没能删除，请稍后再试");
    } finally {
      setSaving(false);
    }
  };
  const use = (action: SavedAction) => {
    setDraft((s) => (s ? `${s}\n${action.text}` : action.text));
    if (!draft) setDraftMode(action.mode);
  };

  return (
    <Sheet title="展开输入" dirty={draft !== text || draftMode !== mode} onClose={onClose}>
      <div className="writing-desk">
        <div className="segmented" role="group" aria-label="输入方式">
          {MODES.map(([value, label]) => <button key={value} aria-pressed={draftMode === value} onClick={() => setDraftMode(value)}>{label}</button>)}
        </div>
        <textarea aria-label="完整输入" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="慢慢写，换行不会发送…" />
        <details className="writing-saved">
          <summary>常用行动{actions.length ? ` · ${actions.length}` : ""}</summary>
          <div className="writing-library">
            {!actions.length && <p className="muted">常写的行动存下来，下次点一下就能填进来。</p>}
            {actions.map((a) => (
              <div className="writing-saved-row" key={a.id}>
                <button className="writing-saved-use" aria-label={a.name} title={a.text} onClick={() => use(a)}>
                  <b>{a.name}</b>
                  {firstLine(a.text) !== a.name && <small>{firstLine(a.text)}</small>}
                </button>
                <button className="ghost writing-remove" aria-label={`删除常用行动：${a.name}`} disabled={saving} onClick={() => void remove(a)}><Icon name="close" size={18} /></button>
              </div>
            ))}
            <button className="ghost writing-add" disabled={!loaded || saving || !draft.trim()} onClick={() => void save()}><Icon name="plus" size={18} />存为常用行动</button>
          </div>
        </details>
        <div className="writing-actions">
          <span className="muted">{draft.length} 字</span>
          <button className="primary" disabled={saving} onClick={() => onDone(draft, draftMode)}>完成输入</button>
        </div>
      </div>
    </Sheet>
  );
}
