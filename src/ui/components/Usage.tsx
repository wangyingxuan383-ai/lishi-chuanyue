// Usage (R08-T004): calls and tokens by world, by day or by purpose, from the
// usage table; with the prices set in 用量与花费 (the same ones the monthly
// budget uses), an estimated cost. Calls the service reported no usage for are
// counted as unknown, never guessed.
import { useEffect, useState } from "react";
import type { Row } from "../../platform";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import { readBudget } from "./budgetMath";
import { PURPOSE_SQL, purposeLabel } from "../../engine/usage";

type By = "world" | "day" | "purpose";
interface Prices { input: number | null; output: number | null }

/** "2026-10-17" in the device's own time zone. */
const localDay = () => `${-new Date().getTimezoneOffset()} minutes`;

const GROUP: Record<By, string> = {
  world: "COALESCE(w.title, '（没有世界）')",
  day: "date(u.at, ?)",
  purpose: PURPOSE_SQL,
};

export function UsageSheet({ onClose }: { onClose: () => void }) {
  const { game } = useApp();
  const [by, setBy] = useState<By>("world");
  const [rows, setRows] = useState<Row[]>([]);
  const [outcomes, setOutcomes] = useState<{ ok: number; other: number }>({ ok: 0, other: 0 });
  const [prices, setPrices] = useState<Prices>({ input: null, output: null });
  useEffect(() => { void readBudget(game.repo).then(({ input, output }) => setPrices({ input, output })); }, []);
  useEffect(() => {
    void game.platform.sql.query(
      `SELECT ${GROUP[by]} AS label, COUNT(*) AS calls,
         COALESCE(SUM(CASE WHEN u.prompt_tokens >= 0 THEN u.prompt_tokens ELSE 0 END), 0) AS input,
         COALESCE(SUM(CASE WHEN u.completion_tokens >= 0 THEN u.completion_tokens ELSE 0 END), 0) AS output,
         SUM(CASE WHEN u.prompt_tokens IS NULL OR u.completion_tokens IS NULL THEN 1 ELSE 0 END) AS unknown,
         AVG(u.total_ms) AS ms
       FROM usage u LEFT JOIN worlds w ON w.id = u.world_id
       GROUP BY label ORDER BY ${by === "day" ? "label DESC" : "input DESC"} LIMIT 60`,
      by === "day" ? [localDay()] : [],
    ).then(setRows);
  }, [by]);
  useEffect(() => {
    void game.platform.sql.query(
      `SELECT CASE WHEN outcome = 'ok' THEN 'ok' ELSE 'other' END AS bucket, COUNT(*) AS calls FROM usage GROUP BY bucket`,
    ).then((list) => {
      let ok = 0, other = 0;
      for (const r of list) {
        if (String(r.bucket) === "ok") ok = Number(r.calls);
        else other += Number(r.calls);
      }
      setOutcomes({ ok, other });
    });
  }, []);
  const priced = prices.input !== null && prices.output !== null;
  const cost = (r: Row) => (Number(r.input) * (prices.input ?? 0) + Number(r.output) * (prices.output ?? 0)) / 1_000_000;
  const total = rows.reduce<{ calls: number; input: number; output: number; unknown: number }>((t, r) => ({ calls: t.calls + Number(r.calls), input: t.input + Number(r.input), output: t.output + Number(r.output), unknown: t.unknown + Number(r.unknown) }), { calls: 0, input: 0, output: 0, unknown: 0 });
  const totalCost = rows.reduce((n, r) => n + cost(r), 0);
  const totalCostLabel = !priced ? "" : total.calls > 0 && total.unknown === total.calls ? "；花费未知" : total.unknown > 0 ? `；已计约 ${totalCost.toFixed(2)} 元（另 ${total.unknown} 次未知）` : `；估计约 ${totalCost.toFixed(2)} 元`;
  const rowCostTag = (r: Row) => {
    const calls = Number(r.calls), unknown = Number(r.unknown);
    if (calls > 0 && unknown === calls) return "未知";
    const yuan = cost(r).toFixed(2);
    return unknown > 0 ? `已计 ${yuan} 元+` : `${yuan} 元`;
  };

  return (
    <Sheet title="用量明细" onClose={onClose}>
      <div className="stack">
        <div className="segmented">
          {([["world", "按世界"], ["day", "按天"], ["purpose", "按用途"]] as const).map(([k, l]) => <button key={k} aria-pressed={by === k} onClick={() => setBy(k)}>{l}</button>)}
        </div>
        <p className="muted m-0">
          共 {total.calls} 次调用{outcomes.other > 0 ? `（已完成 ${outcomes.ok} 次，中断或失败 ${outcomes.other} 次）` : ""}，输入 {total.input.toLocaleString()}、输出 {total.output.toLocaleString()} token{total.unknown ? `；${total.unknown} 次服务没报完整用量，算作未知` : ""}
          {totalCostLabel}。
        </p>
        {rows.map((r) => (
          <div key={String(r.label)} className="item-row">
            <div className="grow">
              <b>{by === "purpose" ? purposeLabel(String(r.label)) : String(r.label)}</b>
              <small>{Number(r.calls)} 次 · 输入 {Number(r.input).toLocaleString()} · 输出 {Number(r.output).toLocaleString()}{Number(r.unknown) ? ` · 未知 ${Number(r.unknown)} 次` : ""}{r.ms != null ? ` · 平均 ${(Number(r.ms) / 1000).toFixed(1)} 秒` : ""}</small>
            </div>
            {priced && <span className="tag">{rowCostTag(r)}</span>}
          </div>
        ))}
        <p className="muted mt-2 mb-0">{priced ? "按“用量与花费”里填的单价估算，不是账单。" : "在“用量与花费”里填上单价，就能估算花费。"}</p>
      </div>
    </Sheet>
  );
}
