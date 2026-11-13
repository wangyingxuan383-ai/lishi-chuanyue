import { useEffect, useState } from "react";
import type { Pin, World } from "../../../engine/types";
import { useApp } from "../../app/context";
import { NarrativePresets } from "../../components/NarrativePresets";
import { Sheet } from "../../components/Sheet";

export function StorySheet({ world, headId, onSave, onClose }: { world: World; headId: string; onSave: (p: Partial<World["settings"]>) => Promise<void>; onClose: () => void }) {
  const { game } = useApp();
  const s = world.settings;
  const [pins, setPins] = useState<Pin[]>([]);
  useEffect(() => { void game.repo.pinsOnPath(world.id, headId).then(setPins); }, [world.id, headId]);
  const [premise, setPremise] = useState(s.premise);
  const [essentials, setEssentials] = useState(s.essentials);
  const [rules, setRules] = useState(s.rules);
  const [directive, setDirective] = useState(s.directive);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <Sheet title="故事设定与要点" dirty={premise !== s.premise || essentials !== s.essentials || directive !== s.directive || rules !== s.rules} onClose={() => { if (!saving) onClose(); }}>
      <div className="stack">
        <label>故事设定<textarea rows={6} value={premise} onChange={(e) => setPremise(e.target.value)} placeholder="时代、地点、处境……AI 每一段都会参考" /></label>
        <label>要点<textarea rows={4} value={essentials} onChange={(e) => setEssentials(e.target.value)} placeholder="必须一直记住的事，每行一条。比如：王掌柜其实是主角的远房舅舅" /></label>
        {pins.length > 0 && <div className="stack gap-1">
          <span className="muted">从剧情里记下的要点，只在这条路线有效</span>
          {pins.map((pin) => (
            <div className="item-row" key={pin.id}>
              <div className="grow">{pin.text}</div>
              <button aria-label={`删除要点：${pin.text}`} onClick={() => void game.repo.deletePin(pin.id).then(() => setPins((list) => list.filter((x) => x.id !== pin.id)))}>删除</button>
            </div>
          ))}
        </div>}
        <NarrativePresets directive={directive} rules={rules} onApply={(preset) => { setDirective(preset.directive); setRules(preset.rules); }} />
        <label>叙事方针<textarea rows={2} value={directive} onChange={(e) => setDirective(e.target.value)} placeholder="文风和节奏，比如：节奏快一些，多写市井人物" /></label>
        <label>给 AI 的额外规则<textarea rows={3} value={rules} onChange={(e) => setRules(e.target.value)} placeholder="比如：不要让主角轻易获得权力" /></label>
        {error && <p role="alert" className="notice">{error}</p>}
        <button className="primary" disabled={saving} onClick={() => {
          setSaving(true); setError("");
          void onSave({ premise, essentials, rules, directive }).catch(() => setError("没有保存成功，文字还在，请重试。")).finally(() => setSaving(false));
        }}>{saving ? "正在保存…" : "保存"}</button>
      </div>
    </Sheet>
  );
}
