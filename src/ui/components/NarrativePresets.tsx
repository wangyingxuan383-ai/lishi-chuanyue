// 我的要求组 (R13-T103): a story's 叙事方针 and 额外规则 saved under a name, for
// any story. Choosing one only fills the two boxes below it — the sheet's own
// 保存 applies it — and can be taken back.
import { useEffect, useState } from "react";
import { loadPresets, savePreset, PRESETS_KEY, type NarrativePreset } from "../../engine/writing/library";
import { useApp } from "../app/context";
import { Icon } from "./Icon";
import "./writing.css";

type Wording = Pick<NarrativePreset, "directive" | "rules">;

export function NarrativePresets({ directive, rules, onApply }: { directive: string; rules: string; onApply: (value: Wording) => void }) {
  const { game, askName, toast } = useApp();
  const [presets, setPresets] = useState<NarrativePreset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<Wording | null>(null);
  useEffect(() => {
    let active = true;
    void loadPresets(game.repo).then((list) => { if (active) { setPresets(list); setLoaded(true); } });
    return () => { active = false; };
  }, [game]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const name = await askName({ title: "保存叙事要求组", placeholder: "如：市井闲谈、紧张冒险" });
      if (name) {
        setPresets(await savePreset(game.repo, name, { directive, rules }));
        toast("已保存，别的故事也能选用");
      }
    } catch {
      toast("没能保存，请稍后再试");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (preset: NarrativePreset) => {
    if (busy) return;
    setBusy(true);
    try {
      const list = (await loadPresets(game.repo)).filter((p) => p.id !== preset.id);
      await game.repo.setSetting(PRESETS_KEY, list);
      setPresets(list);
      toast("已删除要求组", { label: "撤回", run: () => {
        void loadPresets(game.repo).then(async (current) => {
          const next = current.some((p) => p.id === preset.id) ? current : [...current, preset];
          await game.repo.setSetting(PRESETS_KEY, next);
          setPresets(next);
        }).catch(() => toast("没能恢复，请稍后再试"));
      } });
    } catch {
      toast("没能删除，请稍后再试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="writing-presets">
      <summary>我的要求组{presets.length ? ` · ${presets.length}` : ""}</summary>
      <div className="writing-library">
        {!presets.length && <p className="muted">把下面的叙事方针和额外规则存成一组，别的故事也能选用。</p>}
        {presets.map((p) => (
          <div key={p.id} className="writing-preset">
            <div className="writing-preset-text">
              <b>{p.name}</b>
              <p>{[p.directive, p.rules].filter(Boolean).join("；") || "没有写要求"}</p>
            </div>
            <button aria-label={`选用“${p.name}”`} disabled={busy} onClick={() => { setUndo({ directive, rules }); onApply(p); }}>选用</button>
            <button className="ghost writing-remove" aria-label={`删除“${p.name}”`} disabled={busy} onClick={() => void remove(p)}><Icon name="close" size={18} /></button>
          </div>
        ))}
        {undo && (
          <div className="writing-applied">
            <span className="muted">已填进下面，保存后生效。</span>
            <button className="ghost" onClick={() => { onApply(undo); setUndo(null); }}>撤回选用</button>
          </div>
        )}
        <button className="ghost writing-add" disabled={!loaded || busy} onClick={() => void save()}><Icon name="plus" size={18} />将下方要求存为一组</button>
      </div>
    </details>
  );
}
