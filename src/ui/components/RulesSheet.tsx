// Display calibration and currency are ordinary reversible player edits.
import { useState } from "react";
import { LUNAR_MONTHS, monthDays } from "../../engine/calendar/date";
import { nowOf } from "../../engine/calendar/clock";
import { applyDisplayClock, validClockDate, type ClockDisplayChange } from "../../engine/calendar/clockEdit";
import type { EraContext } from "../../engine/era";
import { rejectedReason } from "../../engine/game";
import { currencyIssues, formatMoney } from "../../engine/money";
import type { TurnRecord } from "../../engine/state/apply";
import type { WorldState } from "../../engine/types";
import { Sheet } from "./Sheet";
import { Icon } from "./Icon";
import { Switch } from "./Switch";
import { useApp } from "../app/context";
import type { ReviseRules } from "../../engine/prompt/revise";

export function RulesSheet({ worldId, state: liveState, era: liveEra, headId, busy, onSave, onClose, onCorrectDuration }: {
  worldId?: string; state: WorldState; era: EraContext; headId: string; busy: boolean;
  onSave: (patch: TurnRecord, summary: string, expectedHeadId: string) => Promise<void>;
  onClose: () => void;
  onCorrectDuration?: () => void;
}) {
  const [opened] = useState(() => ({ state: structuredClone(liveState), era: structuredClone(liveEra), headId }));
  const { state, era } = opened;
  const stale = headId !== opened.headId || JSON.stringify(liveState.time) !== JSON.stringify(state.time) || JSON.stringify(liveState.era) !== JSON.stringify(state.era);
  const current = nowOf(era.clock, state.time.elapsedMinutes);
  const eraDisplay = nowOf({ ...era.clock, clockStyle: "era" }, state.time.elapsedMinutes);
  const date = current.date ?? eraDisplay.date;
  const elapsedDisplay = nowOf({ ...era.clock, clockStyle: "elapsed" }, state.time.elapsedMinutes);
  const initial = {
    style: current.clockStyle ?? "elapsed", timeStyle: current.timeStyle ?? "24h", lunar: date?.lunar ?? era.clock.rules.lunar ?? false,
    eraName: date?.era ?? "", year: date ? String(date.year) : "", month: date?.month ?? 1, day: date ? String(date.day) : "1",
    displayDay: String(elapsedDisplay.displayDay), hour: String(current.hour).padStart(2, "0"), minute: String(current.minute).padStart(2, "0"),
  };
  const [form, setForm] = useState(initial);
  const [units, setUnits] = useState(era.currency.units.map(u => ({ name: u.name, value: String(u.value) })));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: typeof form[K]) => { setForm(v => ({ ...v, [key]: value })); setProblem(null); };
  const selectStyle = (style: "era" | "elapsed") => {
    const previous = form.style === "elapsed" ? elapsedDisplay : eraDisplay;
    const next = style === "elapsed" ? elapsedDisplay : eraDisplay;
    const editedTime = style === "era" && !date || Number(form.hour) !== previous.hour || Number(form.minute) !== previous.minute;
    setForm(v => ({ ...v, style, ...(!editedTime ? { hour: String(next.hour).padStart(2, "0"), minute: String(next.minute).padStart(2, "0") } : {}) }));
    setProblem(null);
  };
  // 让 AI 改 (R29-T005): the answer fills this form; the preview below shows it before 保存.
  const { game, toast } = useApp();
  const [instruction, setInstruction] = useState(""), [useSource, setUseSource] = useState(!!state.source), [revising, setRevising] = useState(false), [aiNote, setAiNote] = useState("");
  const revise = async () => {
    if (!worldId || !instruction.trim() || revising) return;
    setRevising(true);
    try {
      const current: ReviseRules = { clockStyle: form.style, timeStyle: form.timeStyle, lunar: form.lunar, eraName: form.eraName, year: form.year ? Number(form.year) : null, month: form.month, day: Number(form.day) || 1,
        displayDay: Number(form.displayDay) || 1, hour: Number(form.hour) || 0, minute: Number(form.minute) || 0, currency: units.map((u) => ({ name: u.name.trim(), value: Number(u.value) })) };
      const r = await game.reviseRules(worldId, current, instruction, { useSource: useSource && !!state.source });
      const two = (n: number) => String(n).padStart(2, "0");
      setForm((v) => ({ ...v, ...(r.clockStyle ? { style: r.clockStyle } : {}), ...(r.timeStyle ? { timeStyle: r.timeStyle } : {}), ...(r.lunar !== undefined ? { lunar: r.lunar } : {}),
        ...(r.eraName ? { eraName: r.eraName } : {}), ...(r.year ? { year: String(r.year) } : {}), ...(r.month ? { month: r.month } : {}), ...(r.day ? { day: String(r.day) } : {}),
        ...(r.displayDay ? { displayDay: String(r.displayDay) } : {}), ...(r.hour !== undefined ? { hour: two(r.hour) } : {}), ...(r.minute !== undefined ? { minute: two(r.minute) } : {}) }));
      if (r.currency) setUnits(r.currency.map((u) => ({ name: u.name, value: String(u.value) })));
      setProblem(null);
      setAiNote(r.note ? `AI：${r.note}` : "AI 改好了，看看下面“保存后”的样子再保存。");
    } catch (e) { toast(e instanceof Error ? e.message : "这次没改成，稍后再试"); }
    finally { setRevising(false); }
  };
  const timeDirty = JSON.stringify(form) !== JSON.stringify(initial);
  const parsedUnits = units.map(u => ({ name: u.name.trim(), value: Number(u.value) }));
  const currencyChanged = JSON.stringify(parsedUnits) !== JSON.stringify(era.currency.units.map(u => ({ name: u.name, value: u.value })));
  const unitProblems = currencyChanged ? currencyIssues(parsedUnits) : [];
  const dayLimit = monthDays({ lunar: form.lunar, month: form.month });
  let clockChange: ClockDisplayChange | undefined, clockProblem: string | null = null, preview = current.text;
  if (timeDirty) {
    const hour = Number(form.hour), minute = Number(form.minute), displayDay = Number(form.displayDay);
    if (!form.hour || !form.minute || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) clockProblem = "时请填0～23，分请填0～59。";
    else {
      clockChange = { clockStyle: form.style, timeStyle: form.timeStyle };
      const projection = form.style === "elapsed" ? elapsedDisplay : eraDisplay;
      const timeChanged = Number(form.hour) !== projection.hour || Number(form.minute) !== projection.minute;
      if (form.style === "elapsed") {
        if (!form.displayDay || !Number.isSafeInteger(displayDay) || displayDay < 1) clockProblem = "日序请填正整数。";
        else if (timeChanged || form.displayDay !== initial.displayDay) clockChange.elapsedAnchor = { atElapsedMinutes: state.time.elapsedMinutes, day: displayDay, minuteOfDay: hour * 60 + minute };
      } else {
        const rules = { ...era.clock.rules, lunar: form.lunar };
        const newDate = validClockDate({ era: form.eraName.trim(), year: Number(form.year), month: form.month, day: Number(form.day), lunar: form.lunar, ceYear: null }, rules);
        if (!newDate) clockProblem = `请填完整纪年和日期；该月日数为1～${dayLimit}，自定年份支持1～999999999。`;
        else {
          // Custom free-world years are independent of CE, including similarly named era tables.
          if (state.era.mode === "free" && !["公元", "公元前"].includes(newDate.era)) newDate.ceYear = null;
          if (timeChanged || !date || form.eraName !== initial.eraName || form.year !== initial.year || form.month !== initial.month || form.day !== initial.day || form.lunar !== initial.lunar) clockChange.anchor = { atElapsedMinutes: state.time.elapsedMinutes, date: newDate, minuteOfDay: hour * 60 + minute };
          if (rules.lunar !== era.clock.rules.lunar) clockChange.calendar = rules;
        }
      }
      if (!clockProblem) try {
        const after = applyDisplayClock(state, clockChange);
        preview = nowOf({ ...era.clock, clockStyle: after.era.clockStyle, timeStyle: after.era.timeStyle, anchor: after.time.anchor, elapsedAnchor: after.time.elapsedAnchor, rules: after.era.calendar ?? era.clock.rules }, state.time.elapsedMinutes).text;
      } catch (error) { clockProblem = rejectedReason(error); }
    }
  }
  const dirty = timeDirty || currencyChanged;
  const save = async () => {
    if (!dirty) { onClose(); return; }
    if (stale || clockProblem || unitProblems.length) return;
    setSaving(true); setProblem(null);
    const rules: NonNullable<TurnRecord["rules"]> = {
      ...(timeDirty ? { clock: clockChange } : {}), ...(currencyChanged ? { currency: parsedUnits } : {}),
    };
    const summary = [timeDirty ? `时间显示校准为${preview}` : "", currencyChanged ? `货币改为${parsedUnits.map(u => u.name).join("、")}` : ""].filter(Boolean).join("；");
    try { await onSave({ rules }, summary, opened.headId); onClose(); } catch (error) { setProblem(rejectedReason(error)); } finally { setSaving(false); }
  };

  return <Sheet title="时间与货币" onClose={onClose} dirty={dirty}>
    <div className="stack gap-10">
      <p className="muted m-0">直接校准当前显示，不改变实际经过、年龄或期限。保存后可以撤销。</p>
      {worldId && <details className="ai-revise">
        <summary>让 AI 改</summary>
        <div className="stack gap-2">
          <textarea rows={2} maxLength={500} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="如：改用斗罗历，货币换成金魂币、银魂币、铜魂币，一金魂币等于一百银魂币" />
          {state.source && <Switch label="参考原著" note={useSource ? "带上原著札记和相关原文片段" : "只按你的要求改"} checked={useSource} onChange={setUseSource} />}
          <div className="row"><span className="grow" /><button disabled={!instruction.trim() || revising || saving} onClick={() => void revise()}>{revising ? "AI 正在改…" : "让 AI 改"}</button></div>
          {aiNote && <p className="field-hint m-0">{aiNote}</p>}
        </div>
      </details>}
      <span className="muted">日期显示</span>
      <div className="segmented">
        <button aria-pressed={form.style === "elapsed"} onClick={() => selectStyle("elapsed")}>日序</button>
        <button aria-pressed={form.style === "era"} onClick={() => selectStyle("era")}>纪年</button>
      </div>
      {form.style === "elapsed" ? <label>当前日序<div className="row"><span>第</span><input aria-label="当前日序" className="grow" inputMode="numeric" value={form.displayDay} onChange={e => set("displayDay", e.target.value.replace(/\D/g, ""))} /><span>天</span></div></label> : <>
        <span className="muted">历法</span>
        <div className="segmented"><button aria-pressed={form.lunar} onClick={() => set("lunar", true)}>农历（简化）</button><button aria-pressed={!form.lunar} onClick={() => set("lunar", false)}>阳历式</button></div>
        <p className="field-hint m-0">沿用十二个月，不含闰月或闰日；纪年名可自定。</p>
        <label>当前纪年<input aria-label="纪年名称" maxLength={12} value={form.eraName} onChange={e => set("eraName", e.target.value)} placeholder="如：斗罗历、天宝、公元" /></label>
        <div className="row wrap">
          <input aria-label="当前年" className="date-y" inputMode="numeric" value={form.year} onChange={e => set("year", e.target.value.replace(/\D/g, ""))} placeholder="年" />
          <select aria-label="当前月" className="date-m" value={form.month} onChange={e => set("month", Number(e.target.value))}>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{form.lunar ? LUNAR_MONTHS[i] : `${i + 1}月`}</option>)}</select>
          <input aria-label="当前日" className="date-d" inputMode="numeric" value={form.day} onChange={e => set("day", e.target.value.replace(/\D/g, ""))} placeholder="日" />
        </div>
      </>}
      <span className="muted">时间显示</span>
      <div className="segmented"><button aria-pressed={form.timeStyle === "24h"} onClick={() => set("timeStyle", "24h")}>24小时</button><button aria-pressed={form.timeStyle === "shichen"} onClick={() => set("timeStyle", "shichen")}>时辰</button></div>
      <div className="row"><label className="grow">当前时<input aria-label="当前时" inputMode="numeric" value={form.hour} onChange={e => set("hour", e.target.value.replace(/\D/g, ""))} /></label><label className="grow">当前分<input aria-label="当前分" inputMode="numeric" value={form.minute} onChange={e => set("minute", e.target.value.replace(/\D/g, ""))} /></label></div>
      {clockProblem ? <p className="notice m-0">{clockProblem}</p> : <dl className="facts"><dt>现在</dt><dd>{current.text}</dd><dt>保存后</dt><dd>{preview}</dd><dt>实际经过</dt><dd>{state.time.elapsedMinutes.toLocaleString()} 分钟（保持不变）</dd></dl>}
      {onCorrectDuration && <details><summary>纠正剧情经过</summary><div className="stack"><p className="muted">某回合耗时记错时，可以手动选择回合预演，再建立修订路线。原路线保留。</p><button disabled={busy || dirty || saving} onClick={onCorrectDuration}>选择回合并预演</button>{dirty && <small className="muted">请先保存或放弃上面的修改。</small>}</div></details>}
      <span className="muted">货币（从大到小，最小单位写1）</span>
      {units.map((u, i) => <div className="row" key={i}>
        <input aria-label={`第 ${i + 1} 个单位名称`} className="grow" value={u.name} onChange={e => setUnits(units.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="名称，如：两" />
        <span className="muted">=</span><input aria-label={`第 ${i + 1} 个单位换算`} style={{ width: 80 }} inputMode="numeric" value={u.value} onChange={e => setUnits(units.map((x, j) => j === i ? { ...x, value: e.target.value.replace(/\D/g, "") } : x))} />
        <button aria-label={`去掉${u.name || "这个单位"}`} disabled={units.length <= 1} onClick={() => setUnits(units.filter((_, j) => j !== i))}><Icon name="minus" size={20} /></button>
      </div>)}
      <button onClick={() => setUnits([...units, { name: "", value: "" }])}><Icon name="plus" size={18} />添加单位</button>
      {unitProblems.length ? <p className="notice m-0">{unitProblems[0].message}</p> : <p className="muted m-0">你现在有 {formatMoney(state.protagonist.stats.money, { units: parsedUnits })}。</p>}
      {stale && <p className="notice m-0">故事已变化，请关闭后重新打开时间设置；当前填写未保存。</p>}
      {problem && <p className="notice m-0">{problem}</p>}
      <button className="primary" disabled={stale || busy || saving || !!clockProblem || unitProblems.length > 0} onClick={() => void save()}>{saving ? "正在保存…" : dirty ? "保存" : "关闭"}</button>
    </div>
  </Sheet>;
}
