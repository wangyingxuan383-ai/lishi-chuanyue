// The world's rules (PLAN §4.14, D121): calendar style, start date and
// currency units. They are not cards: the program counts dates and money
// with them. Saving makes an edit node, so it can be undone.
import { useState } from "react";
import { LUNAR_MONTHS, formatDate, monthDays } from "../../engine/calendar/date";
import type { EraContext } from "../../engine/era";
import { rejectedReason } from "../../engine/game";
import { currencyIssues, formatMoney } from "../../engine/money";
import type { TurnRecord } from "../../engine/state/apply";
import type { WorldState } from "../../engine/types";
import { Sheet } from "./Sheet";
import { Icon } from "./Icon";

export function RulesSheet({ state, era, busy, onSave, onClose }: {
  state: WorldState; era: EraContext; busy: boolean;
  onSave: (patch: TurnRecord, summary: string) => Promise<void>;
  onClose: () => void;
}) {
  const start = era.clock.date;
  const [lunar, setLunar] = useState(start?.lunar ?? era.clock.rules.lunar ?? true);
  const [eraName, setEraName] = useState(start?.era ?? "");
  const [year, setYear] = useState(start ? String(start.year) : "");
  const [month, setMonth] = useState(start?.month ?? 1);
  const [day, setDay] = useState(start ? String(start.day) : "1");
  const [ceYear, setCeYear] = useState(start?.ceYear != null ? String(start.ceYear) : "");
  const [units, setUnits] = useState(era.currency.units.map((u) => ({ name: u.name, value: String(u.value) })));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const events = (state.timeline ?? []).length;

  const parsedUnits = units.map((u) => ({ name: u.name.trim(), value: Number(u.value) }));
  const currencyChanged = JSON.stringify(parsedUnits) !== JSON.stringify(era.currency.units.map((u) => ({ name: u.name, value: u.value })));
  // A world whose opening named no currency has one unnamed unit; it only needs fixing when edited.
  const unitProblems = currencyChanged ? currencyIssues(parsedUnits) : [];
  const dayLimit = monthDays({ lunar, month });
  const dateFilled = eraName.trim() !== "" || year !== "";
  const dateOk = !dateFilled || (eraName.trim() !== "" && eraName.trim().length <= 12 && Number(year) >= 1 && Number(day) >= 1 && Number(day) <= dayLimit);
  const newDate = dateFilled ? { era: eraName.trim(), year: Number(year), month, day: Number(day), lunar, ...(ceYear ? { ceYear: Number(ceYear) } : {}) } : null;

  const changes = (): { patch: TurnRecord; summary: string[] } => {
    const rules: NonNullable<TurnRecord["rules"]> = {};
    const summary: string[] = [];
    if (lunar !== (start?.lunar ?? era.clock.rules.lunar ?? true)) {
      rules.lunar = lunar;
      summary.push(`历法改为${lunar ? "农历" : "公历"}`);
    }
    const sameDate = !!start && !!newDate && start.era === newDate.era && start.year === newDate.year && start.month === newDate.month && start.day === newDate.day && (start.ceYear ?? null) === (newDate.ceYear ?? null);
    if (newDate && !sameDate) {
      rules.date = newDate;
      summary.push(`开局日期改为${formatDate({ ...newDate, ceYear: newDate.ceYear ?? null }, era.clock.rules)}`);
    }
    if (currencyChanged) {
      rules.currency = parsedUnits;
      summary.push(`货币改为${parsedUnits.map((u) => u.name).join("、")}`);
    }
    return { patch: summary.length ? { rules } : {}, summary };
  };
  const { summary } = changes();

  const save = async () => {
    const { patch, summary: lines } = changes();
    if (!lines.length) { onClose(); return; }
    setSaving(true);
    setProblem(null);
    try { await onSave(patch, lines.join("、")); onClose(); } catch (e) { setProblem(rejectedReason(e)); } finally { setSaving(false); }
  };

  return (
    <Sheet title="纪年与货币" onClose={onClose}>
      <div className="stack" style={{ gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>程序用这些规则推算日期、计算钱数。修改后可以撤销。</p>
        <span className="muted">历法</span>
        <div className="segmented">
          <button aria-pressed={lunar} onClick={() => setLunar(true)}>农历（中国）</button>
          <button aria-pressed={!lunar} onClick={() => setLunar(false)}>公历（西方）</button>
        </div>
        <span className="muted">开局日期{start ? "" : "（还没有，填好后顶栏会显示纪年）"}</span>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <input aria-label="年号" style={{ width: 110 }} value={eraName} onChange={(e) => setEraName(e.target.value)} placeholder={lunar ? "年号" : "公元"} />
          <input aria-label="年" style={{ width: 72 }} inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, ""))} placeholder="年" />
          <select aria-label="月" style={{ width: 92 }} value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{lunar ? LUNAR_MONTHS[i] : `${i + 1}月`}</option>)}
          </select>
          <input aria-label="日" style={{ width: 64 }} inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value.replace(/\D/g, ""))} placeholder="日" />
        </div>
        <label>对应的公元年（可不填，公元前写负数）
          <input aria-label="对应公元年" inputMode="numeric" value={ceYear} onChange={(e) => setCeYear(e.target.value.replace(/[^\d-]/g, ""))} placeholder="如 748" />
        </label>
        {!dateOk && <p className="notice" style={{ margin: 0 }}>日期不完整：要有年号、年份，日子在 1～{dayLimit} 之间。</p>}
        {dateOk && events > 0 && summary.some((s) => s.startsWith("开局日期") || s.startsWith("历法")) && <p className="field-hint" style={{ margin: 0 }}>年表里的 {events} 件大事会按新的开局日期重新排时间。</p>}
        <span className="muted">货币（从大到小，换算以最小的单位计，最小的写 1）</span>
        {units.map((u, i) => (
          <div className="row" key={i}>
            <input aria-label={`第 ${i + 1} 个单位名称`} className="grow" value={u.name} onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="名称，如：两" />
            <span className="muted">=</span>
            <input aria-label={`第 ${i + 1} 个单位换算`} style={{ width: 96 }} inputMode="numeric" value={u.value} onChange={(e) => setUnits(units.map((x, j) => (j === i ? { ...x, value: e.target.value.replace(/\D/g, "") } : x)))} />
            <button aria-label={`去掉${u.name || "这个单位"}`} disabled={units.length <= 1} onClick={() => setUnits(units.filter((_, j) => j !== i))}><Icon name="minus" size={20} /></button>
          </div>
        ))}
        <button onClick={() => setUnits([...units, { name: "", value: "" }])}><Icon name="plus" size={18} />添加单位</button>
        {unitProblems.length ? <p className="notice" style={{ margin: 0 }}>{unitProblems[0].message}</p>
          : <p className="muted" style={{ margin: 0 }}>你现在有 {formatMoney(state.protagonist.stats.money, { units: parsedUnits })}。</p>}
        {problem && <p className="notice" style={{ margin: 0 }}>{problem}</p>}
        <button className="primary" disabled={busy || saving || !dateOk || unitProblems.length > 0} onClick={() => void save()}>{summary.length ? "保存" : "关闭"}</button>
      </div>
    </Sheet>
  );
}
