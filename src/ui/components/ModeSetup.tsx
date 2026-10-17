// The 玩法 part of the new-story form (R14, docs/plans/R14_PLAY_MODES.md §2):
// four small cards, and under them only the editor of the chosen mode, so a
// player who keeps 自由 sees one compact row and nothing more.
import { useState, type Ref } from "react";
import { CHALLENGES, type ChallengeCard } from "../../content/challenges";
import { deadlineOf } from "../../engine/modes";
import { MAX_BEATS, type ChallengeDraft, type PlayStyle, type ScriptDraft } from "../screens/openingDraft";
import { Icon } from "./Icon";
import { Switch } from "./Switch";
import "./modes.css";

const STYLES: { value: PlayStyle; title: string; lines: [string, string]; says: string }[] = [
  { value: "plain", title: "自由", lines: ["你演主角", "随心而行"], says: "你来扮演主角，故事随你的行动展开" },
  { value: "script", title: "剧本", lines: ["定好大纲", "按幕推进"], says: "先定好主线和几幕骨架，AI 按幕推进，你照样自由行动" },
  { value: "challenge", title: "挑战", lines: ["限期难关", "成败自负"], says: "开局定下一个难关和期限，成败自负" },
  { value: "watch", title: "旁观", lines: ["AI 演主角", "你在幕后"], says: "主角交给 AI 演，你在幕后指点，坐看故事发展" },
];

export function PlayStyles({ value, onChange }: { value: PlayStyle; onChange: (v: PlayStyle) => void }) {
  return (
    <div className="play-styles" role="group" aria-label="玩法">
      {STYLES.map((s) => (
        <button key={s.value} type="button" className="play-style" aria-pressed={value === s.value} aria-label={`${s.title}：${s.says}`} onClick={() => onChange(s.value)}>
          <b>{s.title}</b>
          <small aria-hidden="true"><span>{s.lines[0]}</span><span>{s.lines[1]}</span></small>
        </button>
      ))}
    </div>
  );
}

/** “第一幕”…“第十二幕”. */
export const ORDINALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
const BEAT_EXAMPLES = ["如：初到此地，听闻怪事", "如：夜里去探，撞见秘密", "如：真相大白，当面对质"];

/** 剧本: 主线, the beats, 结局, how firmly to follow, who plays the protagonist. */
export function ScriptOutline({ value, onChange, aiPilot, onAiPilot, drafting, onDraft, wanted, firstBeat }: {
  value: ScriptDraft; onChange: (next: ScriptDraft) => void;
  aiPilot: boolean; onAiPilot: (v: boolean) => void;
  drafting: boolean; onDraft: () => void;
  /** Highlight the beats: the start button pointed here. */
  wanted?: boolean;
  firstBeat?: Ref<HTMLTextAreaElement>;
}) {
  const [tools, setTools] = useState<number | null>(null);
  const beats = value.beats.length ? value.beats : [""];
  const setBeats = (next: string[]) => onChange({ ...value, beats: next });
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= beats.length) return;
    const next = [...beats];
    [next[i], next[j]] = [next[j], next[i]];
    setBeats(next);
    setTools(j);
  };
  const remove = (i: number) => {
    setBeats(beats.length > 1 ? beats.filter((_, k) => k !== i) : [""]);
    setTools(null);
  };
  return (
    <div className="mode-panel" aria-label="剧本大纲">
      <label className="mode-field"><span>主线</span>
        <input value={value.line} onChange={(e) => onChange({ ...value, line: e.target.value })} placeholder="一句话：这个故事最终讲什么" aria-label="主线" />
      </label>
      <div className="mode-field">
        <span>几幕骨架</span>
        <div className="beat-list">
          {beats.map((text, i) => (
            <div className="beat-row" key={i}>
              <span className="beat-num" aria-hidden="true">{ORDINALS[i]}</span>
              <textarea ref={i === 0 ? firstBeat : undefined} rows={1} className={wanted && !text.trim() && i === 0 ? "wanted" : ""} value={text}
                aria-label={`第${ORDINALS[i]}幕`} placeholder={BEAT_EXAMPLES[i] ?? "这一幕要发生的事"}
                onChange={(e) => setBeats(beats.map((b, k) => (k === i ? e.target.value : b)))} />
              <button type="button" className="icon-btn" aria-label={`第${ORDINALS[i]}幕的操作`} aria-expanded={tools === i} onClick={() => setTools(tools === i ? null : i)}><Icon name="more" size={20} /></button>
              {tools === i && (
                <div className="beat-tools">
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`把第${ORDINALS[i]}幕上移`}>上移</button>
                  <button type="button" disabled={i === beats.length - 1} onClick={() => move(i, 1)} aria-label={`把第${ORDINALS[i]}幕下移`}>下移</button>
                  <button type="button" className="danger-text" onClick={() => remove(i)}>{beats.length > 1 ? "删去这一幕" : "清空"}</button>
                </div>
              )}
            </div>
          ))}
        </div>
        {beats.length < MAX_BEATS
          ? <button type="button" className="beat-add" onClick={() => { setBeats([...beats, ""]); setTools(null); }}><Icon name="plus" size={18} />加一幕</button>
          : <p className="mode-hint">最多 {MAX_BEATS} 幕。</p>}
      </div>
      <label className="mode-field"><span>结局<small className="optional">可不写</small></span>
        <input value={value.ending} onChange={(e) => onChange({ ...value, ending: e.target.value })} placeholder="想要怎样收场" aria-label="结局" />
      </label>
      <div className="mode-field">
        <span>推进方式</span>
        <div className="segmented" role="group" aria-label="推进方式">
          <button type="button" aria-pressed={value.steer === "gentle"} onClick={() => onChange({ ...value, steer: "gentle" })}>顺其自然</button>
          <button type="button" aria-pressed={value.steer === "firm"} onClick={() => onChange({ ...value, steer: "firm" })}>紧扣大纲</button>
        </div>
        <p className="mode-hint">{value.steer === "firm" ? "跑偏时，AI 会用情理之中的人和事把故事引回这一幕。" : "允许绕些远路，AI 在合适的时候引出下一幕。"}</p>
      </div>
      <Switch label="主角交给 AI 演" note={aiPilot ? "你在幕后指点，坐看剧本演成小说" : undefined} checked={aiPilot} onChange={onAiPilot} />
      <button type="button" className="mode-draft" disabled={drafting} onClick={onDraft}>{drafting ? "正在拟大纲…" : "AI 帮我拟大纲"}</button>
    </div>
  );
}

const LIMIT_PICKS = ["十日", "三个月", "一年"];

export interface ChallengeFieldValues { goal: string; limit: string; failIf: string }

/** 目标 / 期限 / 失败条件, with what the limit is understood as; shared by the new story and the 挑战 page. */
export function ChallengeFields({ value, onChange, wanted, goalRef }: {
  value: ChallengeFieldValues; onChange: (next: ChallengeFieldValues) => void; wanted?: boolean; goalRef?: Ref<HTMLTextAreaElement>;
}) {
  const span = value.limit.trim() ? deadlineOf(value.limit, 0) : null;
  return (
    <>
      <label className="mode-field"><span>目标</span>
        <textarea ref={goalRef} rows={2} className={wanted && !value.goal.trim() ? "wanted" : ""} value={value.goal} onChange={(e) => onChange({ ...value, goal: e.target.value })}
          placeholder="要达成什么，如：凑够三百两，赎回祖宅" aria-label="挑战目标" />
      </label>
      <div className="mode-field">
        <label className="mode-field"><span>期限</span>
          <span className="field-line">
            <input value={value.limit} onChange={(e) => onChange({ ...value, limit: e.target.value })} placeholder="如：三个月；不写就不限时" aria-label="期限" />
            {span !== null && <span className="field-suffix">{span >= 1440 ? `共 ${Math.round(span / 1440)} 天` : "不到一天"}</span>}
          </span>
        </label>
        {value.limit.trim() && span === null && <p className="field-hint warn" style={{ margin: 0 }}>看不出有多久。写成“十日”“三个月”这样的时长，不写就不限时。</p>}
        <div className="limit-picks" role="group" aria-label="常用期限">
          {LIMIT_PICKS.map((l) => <button key={l} type="button" aria-pressed={value.limit.trim() === l} onClick={() => onChange({ ...value, limit: l })}>{l}</button>)}
          <button type="button" aria-pressed={!value.limit.trim()} onClick={() => onChange({ ...value, limit: "" })}>不限时</button>
        </div>
      </div>
      <label className="mode-field"><span>失败条件<small className="optional">可不写</small></span>
        <input value={value.failIf} onChange={(e) => onChange({ ...value, failIf: e.target.value })} placeholder="怎样算失败，如：祖宅被卖掉" aria-label="失败条件" />
      </label>
    </>
  );
}

/** 挑战: ready-made cards, then 目标 / 期限 / 失败条件. */
export function ChallengeSetup({ value, onChange, selected, onCard, aiPilot, onAiPilot, drafting, onDraft, free, wanted, goalBox }: {
  value: ChallengeDraft; onChange: (next: ChallengeDraft) => void;
  selected: string | null; onCard: (card: ChallengeCard) => void;
  aiPilot: boolean; onAiPilot: (v: boolean) => void;
  drafting: boolean; onDraft: () => void;
  /** The world kind being set up: its cards come first. */
  free: boolean;
  wanted?: boolean;
  goalBox?: Ref<HTMLTextAreaElement>;
}) {
  const cards = [...CHALLENGES].sort((a, b) => Number(a.mode !== (free ? "free" : "history")) - Number(b.mode !== (free ? "free" : "history")));
  return (
    <div className="mode-panel" aria-label="挑战">
      <div className="mode-field">
        <span>现成的挑战</span>
        <div className="challenge-row" role="group" aria-label="现成的挑战">
          {cards.map((c) => (
            <button key={c.id} type="button" className="challenge-card" aria-pressed={selected === c.id} aria-label={`挑战：${c.title}，${c.blurb}`} onClick={() => onCard(c)}>
              <span className="head"><b>{c.title}</b><small>{c.era}</small></span>
              <span className="blurb">{c.blurb}</span>
            </button>
          ))}
        </div>
      </div>
      <ChallengeFields value={value} onChange={onChange} wanted={wanted} goalRef={goalBox} />
      <Switch label="主角交给 AI 演" note={aiPilot ? "你在幕后指点，看 AI 自己闯关" : undefined} checked={aiPilot} onChange={onAiPilot} />
      <button type="button" className="mode-draft" disabled={drafting} onClick={onDraft}>{drafting ? "正在出题…" : "AI 帮我出题"}</button>
    </div>
  );
}
