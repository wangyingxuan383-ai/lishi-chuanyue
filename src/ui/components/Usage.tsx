// Usage (R08-T004): calls and tokens by world, by day or by purpose, from the
// usage table; with the prices set in 用量与花费 (the same ones the monthly
// budget uses), an estimated cost. Calls the service reported no usage for are
// counted as unknown, never guessed.
import { useEffect, useState } from "react";
import type { Row } from "../../platform";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import { readBudget } from "./budgetMath";

export const PURPOSES: Record<string, string> = {
  turn: "回合", opening: "开场", extract: "补记", assist: "补全", continue: "续写", codex: "整理设定", upkeep: "整理设定（游玩中）",
  chapter: "章节摘要", ask: "查一查", test: "测试", outline: "拟大纲", challenge: "出题", source: "通读书籍",
};
type By = "world" | "day" | "purpose";
interface Prices { input: number | null; output: number | null }

/** "2026-10-17" in the device's own time zone. */
const localDay = () => `${-new Date().getTimezoneOffset()} minutes`;

const GROUP: Record<By, string> = {
  world: "COALESCE(w.title, '（没有世界）')",
  day: "date(u.at, ?)",
  purpose: "u.purpose",
};

export function UsageSheet({ onClose }: { onClose: () => void }) {
  const { game } = useApp();
  const [by, setBy] = useState<By>("world");
  const [rows, setRows] = useState<Row[]>([]);
  const [prices, setPrices] = useState<Prices>({ input: null, output: null });
  useEffect(() => { void readBudget(game.repo).then(({ input, output }) => setPrices({ input, output })); }, []);
  useEffect(() => {
    void game.platform.sql.query(
      `SELECT ${GROUP[by]} AS label, COUNT(*) AS calls,
         COALESCE(SUM(u.prompt_tokens), 0) AS input, COALESCE(SUM(u.completion_tokens), 0) AS output,
         SUM(CASE WHEN u.prompt_tokens IS NULL THEN 1 ELSE 0 END) AS unknown, AVG(u.total_ms) AS ms
       FROM usage u LEFT JOIN worlds w ON w.id = u.world_id
       GROUP BY label ORDER BY ${by === "day" ? "label DESC" : "input DESC"} LIMIT 60`,
      by === "day" ? [localDay()] : [],
    ).then(setRows);
  }, [by]);
  const priced = prices.input !== null && prices.output !== null;
  const cost = (r: Row) => (Number(r.input) * (prices.input ?? 0) + Number(r.output) * (prices.output ?? 0)) / 1_000_000;
  const total = rows.reduce<{ calls: number; input: number; output: number; unknown: number }>((t, r) => ({ calls: t.calls + Number(r.calls), input: t.input + Number(r.input), output: t.output + Number(r.output), unknown: t.unknown + Number(r.unknown) }), { calls: 0, input: 0, output: 0, unknown: 0 });

  return (
    <Sheet title="用量明细" onClose={onClose}>
      <div className="stack">
        <div className="segmented">
          {([["world", "按世界"], ["day", "按天"], ["purpose", "按用途"]] as const).map(([k, l]) => <button key={k} aria-pressed={by === k} onClick={() => setBy(k)}>{l}</button>)}
        </div>
        <p className="muted" style={{ margin: 0 }}>
          共 {total.calls} 次调用，输入 {total.input.toLocaleString()}、输出 {total.output.toLocaleString()} token{total.unknown ? `；${total.unknown} 次服务没报用量，算作未知` : ""}
          {priced ? `；估计约 ${(rows.reduce((n, r) => n + cost(r), 0)).toFixed(2)} 元` : ""}。
        </p>
        {rows.map((r) => (
          <div key={String(r.label)} className="item-row">
            <div className="grow">
              <b>{by === "purpose" ? PURPOSES[String(r.label)] ?? String(r.label) : String(r.label)}</b>
              <small>{Number(r.calls)} 次 · 输入 {Number(r.input).toLocaleString()} · 输出 {Number(r.output).toLocaleString()}{Number(r.unknown) ? ` · 未知 ${Number(r.unknown)} 次` : ""}{r.ms != null ? ` · 平均 ${(Number(r.ms) / 1000).toFixed(1)} 秒` : ""}</small>
            </div>
            {priced && <span className="tag">{cost(r).toFixed(2)} 元</span>}
          </div>
        ))}
        <p className="muted" style={{ margin: "8px 0 0" }}>{priced ? "按“用量与花费”里填的单价估算，不是账单。" : "在“用量与花费”里填上单价，就能估算花费。"}</p>
      </div>
    </Sheet>
  );
}
