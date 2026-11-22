// 这一回合的变化 (R28 第二批, D160): what changed after a passage, as one quiet
// line under it instead of a row of boxes. Tapping it opens the full list,
// grouped, with a way to the character panel. The engine's labels are kept as
// they are (the TS and Rust rules share them); only how they look changes here.
import { useEffect, useState } from "react";
import type { Chip } from "../../../engine/state/apply";
import { Icon, type IconName } from "../../components/Icon";
import type { Tab } from "../../components/Panel";
import { Sheet } from "../../components/Sheet";
import { motionLevel } from "../../app/motion";

const GROUPS: { name: string; icon: IconName; tab?: Tab; test: RegExp }[] = [
  { name: "原著", icon: "book", tab: "设定", test: /^原著进度/ },
  { name: "地点", icon: "pin", tab: "我", test: /^(到|来到|离开) / },
  { name: "时间", icon: "clock", tab: "我", test: /^(过了|过年|快进|第.+天)/ },
  { name: "数值", icon: "coin", tab: "我", test: /^(钱|健康|精力|名望|体力|声望)/ },
  { name: "物品", icon: "seal", tab: "行囊", test: /^(得|失|用掉|丢了|丢|换|交出|收下) / },
  { name: "人物", icon: "people", tab: "人物", test: /^(结识|告别)|：(友善|冷淡|敌视|亲近|信任|戒备|敬重|厌恶|中立)/ },
  { name: "目标", icon: "flag", tab: "目标", test: /(目标|支线|主线|完成|失败|幕演完|挑战)/ },
  { name: "状态", icon: "heart", tab: "我", test: /(好了|受伤|轻伤|重伤|虚脱|疲惫|垂危|中毒|生病)/ },
];
const groupOf = (text: string) => GROUPS.find((g) => g.test.test(text)) ?? { name: "其他", icon: "info" as IconName, tab: undefined, test: /./ };

/** The label as shown: the engine's 📜 / ⚠ become words, not colour emoji (AUDIT_V4 4.6). */
export function chipLabel(text: string): string {
  return text.replace(/^📜\s*/, "史载 ").replace(/^⚠\s*/, "").replace(/^🎲\s*/, "签 ");
}

/** A number in a just-written label counts up to its value (华丽 only; plain text otherwise). */
function CountUp({ text }: { text: string }) {
  const match = text.match(/([+\-−]?)(\d+)/);
  const target = match ? Number(match[2]) : 0;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!match || motionLevel() !== "rich") { setShown(target); return; }
    let frame = 0; const start = performance.now();
    const tick = (now: number) => { const t = Math.min(1, (now - start) / 700); setShown(Math.round(target * (1 - Math.pow(1 - t, 3)))); if (t < 1) frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text]);
  if (!match) return <>{text}</>;
  const at = match.index!;
  return <>{text.slice(0, at)}<span className="count-up">{match[1]}{shown}</span>{text.slice(at + match[0].length)}</>;
}

/** How many labels the line shows before “另 N 项”. */
const SHOWN = 3;

/** `extra`: an action shown in the sheet, such as 改回 for the book position (D178). */
export function TurnChanges({ chips, onPanel, fresh, extra, notes, onNotes }: { chips: Chip[]; onPanel?: (tab?: Tab) => void; fresh?: boolean; extra?: { label: string; run: () => void };
  /** 参考了哪些札记 for this passage (R30 step 2). */ notes?: string[]; onNotes?: () => void }) {
  const [open, setOpen] = useState(false);
  if (!chips?.length) return null;
  const shown = chips.slice(0, SHOWN), rest = chips.length - shown.length;
  const grouped = new Map<string, { icon: IconName; tab?: Tab; chips: Chip[] }>();
  for (const chip of chips) {
    const g = groupOf(chip.text);
    if (!grouped.has(g.name)) grouped.set(g.name, { icon: g.icon, tab: g.tab, chips: [] });
    grouped.get(g.name)!.chips.push(chip);
  }
  return (
    <>
      <button className="turn-changes" aria-label={`这一回合的变化，共 ${chips.length} 项`} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        {shown.map((c, i) => <span key={i} className={`change ${c.tone}`}>{fresh && (c.tone === "gain" || c.tone === "loss") ? <CountUp text={chipLabel(c.text)} /> : chipLabel(c.text)}</span>)}
        {rest > 0 && <span className="change more">另 {rest} 项</span>}
        <Icon name="forward" size={14} />
      </button>
      {open && (
        <Sheet title="这一回合的变化" onClose={() => setOpen(false)}>
          <div className="changes-sheet">
            {[...grouped].map(([name, g]) => (
              <section key={name} className="changes-group">
                <div className="row between">
                  <h3><Icon name={g.icon} size={18} />{name}</h3>
                  {onPanel && g.tab && <button type="button" className="ghost small changes-jump" onClick={() => { setOpen(false); onPanel(g.tab); }}>去{g.tab} ›</button>}
                </div>
                <ul>{g.chips.map((c, i) => <li key={i} className={`change-row ${c.tone}`} style={{ ["--i" as string]: i }}>{chipLabel(c.text)}</li>)}</ul>
              </section>
            ))}
            {!!notes?.length && <section className="changes-group">
              <h3><Icon name="book" size={18} />写这段时参考的札记</h3>
              <p className="muted m-0">{notes.join("、")}</p>
              {onNotes && <button className="ghost" onClick={() => { setOpen(false); onNotes(); }}>查看札记</button>}
            </section>}
            {extra && <button onClick={() => { setOpen(false); extra.run(); }}>{extra.label}</button>}
            {onPanel && <button className="primary" onClick={() => { setOpen(false); onPanel(); }}>在角色面板里查看和修改</button>}
          </div>
        </Sheet>
      )}
    </>
  );
}
