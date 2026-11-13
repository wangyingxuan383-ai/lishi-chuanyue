import { useEffect, useState } from "react";
import { FORTUNE_MODES, FORTUNE_MODE_NOTE, fortuneMode } from "../../../engine/fortune";
import type { SourceBinding } from "../../../engine/sources/types";
import type { Intensity, Pilot, World, WorldState } from "../../../engine/types";
import { useApp } from "../../app/context";
import { differsFromDefaults, loadPlayDefaults, savePlayDefaults, type PlayDefaults } from "../../app/playDefaults";
import { ModesSettings } from "../../components/Modes";
import { Sheet } from "../../components/Sheet";
import { SourceSetup, SourceSummary, ReferenceSheet } from "../../components/Sources";
import { Switch } from "../../components/Switch";
import type { WritingSettings } from "./types";

export function WorldSettingsSheet({ world, state, busy, onChange, onPanelSave, onPilot, onScript, onChallenge, onRules, onSourceSave, onClose }: {
  world: World; state: WorldState; busy: boolean; onChange: (p: Partial<WritingSettings>) => void; onPanelSave: (text: string) => Promise<void>;
  onPilot: (pilot: Pilot) => void; onScript: () => void; onChallenge: () => void; onRules: () => void; onClose: () => void;
  onSourceSave: (source: SourceBinding | null) => Promise<void>;
}) {
  const { game, toast } = useApp();
  const s = world.settings as WritingSettings;
  const storedPanel = (state.protagonist as { panel?: string }).panel ?? "";
  const [heroPanel, setHeroPanel] = useState(storedPanel);
  const [savingPanel, setSavingPanel] = useState(false);
  const [source, setSource] = useState(state.source ?? null), [savingSource, setSavingSource] = useState(false), [reference, setReference] = useState(false);
  const sourceDirty = JSON.stringify(source) !== JSON.stringify(state.source ?? null);
  const [defaults, setDefaults] = useState<PlayDefaults | null>(null);
  useEffect(() => { void loadPlayDefaults(game.repo).then(setDefaults); }, []);
  const differs = defaults ? differsFromDefaults(s, defaults) : [];
  /** “本局” on a heading whose value differs from the play defaults. */
  const mark = (key: keyof PlayDefaults) => (differs.includes(key) ? <span className="tag own">本局</span> : null);
  const levels: Intensity[] = ["含蓄", "写实", "浓烈"];
  const intensity = (key: keyof typeof s.intensity, label: string) => (
    <div className="stack gap-2">
      <span className="muted">{label}</span>
      <div className="segmented">
        {levels.map((l) => <button key={l} aria-pressed={s.intensity[key] === l} onClick={() => onChange({ intensity: { ...s.intensity, [key]: l } })}>{l}</button>)}
      </div>
    </div>
  );
  return (
    <Sheet title="本局设置" dirty={heroPanel !== storedPanel || sourceDirty} onClose={onClose}>
      <div className="stack">
        <p className="muted m-0">只改这个故事，从下一段起生效。</p>
        <h3 className="settings-sub">玩法</h3>
        <ModesSettings state={state} pilot={s.pilot ?? "player"} busy={busy} onPilot={onPilot} onScript={onScript} onChallenge={onChallenge} />
        <span className="muted">难度 {mark("difficulty")}</span>
        <div className="segmented">
          {(["宽松", "标准", "残酷"] as const).map((l) => <button key={l} aria-pressed={s.difficulty === l} onClick={() => onChange({ difficulty: l })}>{l}</button>)}
        </div>
        <p className="muted m-0">{s.difficulty === "宽松" ? "运气偏好；受了重伤也只是昏过去，不会死。" : s.difficulty === "残酷" ? "运气偏差；重伤可能直接丧命。" : "运气平常；伤重时先“垂危”，剧情真写到才会死。"}</p>
        <span className="muted">运势 {mark("fortune")}</span>
        <div className="segmented">
          {FORTUNE_MODES.map(([v, l]) => <button key={v} aria-pressed={fortuneMode(s.fortune) === v} onClick={() => onChange({ fortune: v })}>{l}</button>)}
        </div>
        <p className="muted m-0">{FORTUNE_MODE_NOTE[fortuneMode(s.fortune)]}</p>

        <h3 className="settings-sub">写法</h3>
        <span className="muted">每段篇幅 {mark("length")}</span>
        <div className="segmented">
          {(["短", "中", "长"] as const).map((l) => <button key={l} aria-pressed={s.length === l} onClick={() => onChange({ length: l })}>{l}</button>)}
        </div>
        <span className="muted">建议选项数量 {mark("choiceCount")}</span>
        <div className="segmented">
          {[0, 2, 3, 4].map((n) => <button key={n} aria-pressed={s.choiceCount === n} onClick={() => onChange({ choiceCount: n })}>{n === 0 ? "不要" : n}</button>)}
        </div>
        <span className="muted">叙述视角 {mark("perspective")}</span>
        <div className="segmented">
          {([["你", "你"], ["我", "我"], ["他", "他 / 她"]] as const).map(([v, l]) => <button key={v} aria-pressed={s.perspective === v} onClick={() => onChange({ perspective: v })}>{l}</button>)}
        </div>
        <span className="muted">文风 {mark("style")}</span>
        <div className="segmented">
          {(["白话", "半文半白"] as const).map((v) => <button key={v} aria-pressed={s.style === v} onClick={() => onChange({ style: v })}>{v}</button>)}
        </div>

        <h3 className="settings-sub">记忆与整理</h3>
        <details><summary><SourceSummary value={source} /></summary><div className="stack"><SourceSetup value={source} onChange={setSource} disabled={busy || savingSource} />
          <div className="row"><button disabled={busy || savingSource || !sourceDirty} onClick={() => { setSavingSource(true); void onSourceSave(source).then(() => toast("书籍用法已保存，可撤销")).catch((e) => toast(e.message ?? "没能保存")).finally(() => setSavingSource(false)); }}>保存书籍用法</button>{state.source && <button onClick={() => setReference(true)}>查看参考资料</button>}</div>
        </div></details>
        {reference && state.source && <ReferenceSheet worldId={world.id} binding={state.source} onClose={() => setReference(false)} />}
        <Switch label="显示主角面板" note={s.heroPanelEnabled ? "写下想随时查看的能力、境界或约定" : undefined} checked={s.heroPanelEnabled ?? false} onChange={(v) => onChange({ heroPanelEnabled: v })} />
        {s.heroPanelEnabled && <div className="stack gap-2">
          <label>主角面板内容<textarea rows={5} maxLength={2000} value={heroPanel} onChange={(e) => setHeroPanel(e.target.value.slice(0, 2000))} placeholder="如：境界、技能、特长……" /></label>
          <div className="row">
            <span className="muted grow">{heroPanel.length}/2000 字 · 只记事，不计算数值</span>
            <button disabled={savingPanel || heroPanel === storedPanel} onClick={() => {
              setSavingPanel(true); void onPanelSave(heroPanel).then(() => toast("已保存，可在 ⋯ 里撤销")).catch(() => toast("没有保存成功，请稍后再试")).finally(() => setSavingPanel(false));
            }}>{savingPanel ? "正在保存…" : "保存面板"}</button>
          </div>
        </div>}
        <span className="muted">设定集自动整理 {mark("autoUpkeep")}</span>
        <div className="segmented">
          {([[true, "开"], [false, "关"]] as const).map(([v, l]) => <button key={l} aria-pressed={s.autoUpkeep === v} onClick={() => onChange({ autoUpkeep: v })}>{l}</button>)}
        </div>
        <p className="muted m-0">每过几回合，AI 把新出现的人物、地点和势力记进设定集；你写的卡不会动。</p>
        <span className="muted">章节摘要 {mark("chapterEvery")}</span>
        <div className="segmented">
          {[0, 8, 12, 20].map((n) => <button key={n} aria-pressed={s.chapterEvery === n} onClick={() => onChange({ chapterEvery: n })}>{n ? `每 ${n} 回合` : "关"}</button>)}
        </div>
        <p className="muted m-0">把一段剧情写成一章摘要，更早的事靠它记住；在“我 → 记事”里看。</p>
        {s.mode !== "free" && <><span className="muted">用词提醒 {mark("tabooHints")}</span>
        <div className="segmented">
          {([[true, "开"], [false, "关"]] as const).map(([v, l]) => <button key={l} aria-pressed={(s.tabooHints ?? true) === v} onClick={() => onChange({ tabooHints: v })}>{l}</button>)}
        </div>
        <p className="muted m-0">AI 用了这个朝代不该有的说法时，下一段提醒它改。</p></>}

        <h3 className="settings-sub">内容尺度</h3>
        {intensity("violence", "暴力与伤亡")}
        {intensity("romance", "感情与亲密")}
        {intensity("darkness", "黑暗与压抑")}
        <p className="muted">“浓烈”仍受所用 AI 服务的规则限制。</p>
        {defaults && differs.length > 0 && <div className="row wrap">
          <button onClick={() => { onChange({ difficulty: defaults.difficulty, length: defaults.length, choiceCount: defaults.choiceCount, perspective: defaults.perspective, style: defaults.style, autoUpkeep: defaults.autoUpkeep, chapterEvery: defaults.chapterEvery, fortune: defaults.fortune, tabooHints: defaults.tabooHints, intensity: defaults.intensity }); toast("已恢复为默认"); }}>全部恢复为默认</button>
          <button className="ghost" onClick={() => { const next = { ...defaults, difficulty: s.difficulty, length: s.length, choiceCount: s.choiceCount, perspective: s.perspective, style: s.style, autoUpkeep: s.autoUpkeep, chapterEvery: s.chapterEvery, fortune: fortuneMode(s.fortune), tabooHints: s.tabooHints ?? true, intensity: s.intensity }; void savePlayDefaults(game.repo, next).then(() => { setDefaults(next); toast("以后新开一局都用这些设置"); }); }}>设为以后的默认</button>
        </div>}
        <button className="ghost t-left" onClick={onRules}>{s.mode === "free" ? "时间与货币 ›" : "纪年与货币 ›"}</button>
      </div>
    </Sheet>
  );
}
