// 用量与花费 (R13-T104, reworked in R14): this month's estimated spend against
// the player's own budget, from the usage table and one set of prices, and a
// reminder once a month when the budget is reached. An estimate, never a bill:
// calls the service reported no usage for stay unknown instead of counting as free.
import { useEffect, useState, type ChangeEvent } from "react";
import type { Game } from "../../engine/game";
import { useApp } from "../app/context";
import { UsageSheet } from "./Usage";
import { budgetSummary, claimBudgetReminder, monthSpend, overBudget, readBudget, type BudgetConfig, type MonthSpend } from "./budgetMath";

/**
 * Mount on Home and Play. It checks when mounted, whenever `revision` changes
 * (Play changes it with each turn and each sheet it opens or closes, so usage
 * from the writing tools and 查一查 is counted too), when a world changes in
 * the background and when the app comes back to the front. No timer: a cost
 * recorded quietly in the background shows at the next of these.
 */
export function BudgetReminder({ revision = "" }: { revision?: string | number }) {
  const { game, toast } = useApp();
  useEffect(() => {
    let live = true;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const config = await readBudget(game.repo);
      if (!config.limit) return;
      const spend = await monthSpend(game.platform, config);
      if (live && await claimBudgetReminder(game.repo, config, spend)) toast(`本月估算花费已到 ${config.limit} 元预算，仍可继续玩`);
    };
    const run = () => { void check().catch(() => {}); };
    run();
    const unsubscribe = game.subscribe(run);
    document.addEventListener("visibilitychange", run);
    return () => {
      live = false;
      unsubscribe();
      document.removeEventListener("visibilitychange", run);
    };
  }, [game, revision, toast]);
  return null;
}

/** The settings entry's one line: “本月约 4.20 元 · 预算 5 元”. */
export async function budgetState(game: Game): Promise<string> {
  const config = await readBudget(game.repo);
  const spend = await monthSpend(game.platform, config);
  const cost = spend.knownCost === null ? (spend.calls ? "本月花费未知" : "本月还没用过") : `本月约 ${spend.knownCost.toFixed(2)} 元`;
  return config.limit ? `${cost} · 预算 ${config.limit} 元` : cost;
}

const text = (n: number | null) => (n === null ? "" : String(n));
const NUMBER = /^\d+(\.\d+)?$/;

/** The month at a glance: the estimate, the share of the budget, what is not counted. */
function SpendCard({ spend, config }: { spend: MonthSpend; config: BudgetConfig }) {
  const cost = spend.knownCost;
  const share = cost !== null && config.limit ? Math.min(1, cost / config.limit) : null;
  const over = overBudget(config, spend);
  const unused = spend.calls === 0;
  const note = unused ? "这个月还没有用过 AI。"
    : cost === null ? budgetSummary(spend)
    : spend.unknown ? `另有 ${spend.unknown} 次没有用量数据，没算进去。` : `共 ${spend.calls} 次调用。`;
  return (
    <div className={`spend-card${over ? " over" : ""}`}>
      <small>{Number(spend.month.slice(5))} 月 · 估算，不是账单</small>
      <p className="spend-total">
        <b>{unused ? "还没用过" : cost === null ? "花费未知" : `约 ${cost.toFixed(2)} 元`}</b>
        {config.limit ? <span>预算 {config.limit} 元</span> : null}
      </p>
      {share !== null && <div className="bar" role="img" aria-label={`已用预算的 ${Math.round(share * 100)}%`}><i style={{ width: `${share * 100}%` }} /></div>}
      <small>{over ? `已到预算。${note}` : note}</small>
    </div>
  );
}

export function MonthlyBudgetSettings() {
  const { game, toast } = useApp();
  const [fields, setFields] = useState({ limit: "", input: "", output: "" });
  const [saved, setSaved] = useState<BudgetConfig | null>(null);
  const [spend, setSpend] = useState<MonthSpend | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      const config = await readBudget(game.repo);
      const result = await monthSpend(game.platform, config);
      if (!live) return;
      setSaved(config);
      setSpend(result);
      setFields({ limit: text(config.limit), input: text(config.input), output: text(config.output) });
    })().catch(() => { if (live) setError("没能读取本月用量，请返回后重试。"); });
    return () => { live = false; };
  }, [game]);
  const dirty = !!saved && (fields.limit !== text(saved.limit) || fields.input !== text(saved.input) || fields.output !== text(saved.output));
  const field = (key: keyof typeof fields) => ({
    value: fields[key],
    inputMode: "decimal" as const,
    onChange: (e: ChangeEvent<HTMLInputElement>) => setFields({ ...fields, [key]: e.target.value }),
  });
  const save = async () => {
    if (Object.values(fields).some((v) => v.trim() !== "" && (!NUMBER.test(v.trim()) || !Number.isFinite(Number(v))))) {
      setError("请填零或正数；不需要的留空。");
      return;
    }
    const value = (v: string) => (v.trim() === "" ? null : Number(v));
    const config: BudgetConfig = { limit: value(fields.limit), input: value(fields.input), output: value(fields.output) };
    setSaving(true);
    setError("");
    try {
      await game.repo.setSetting("monthlyBudget", config);
      setSaved(config);
      setSpend(await monthSpend(game.platform, config));
      toast("已保存");
    } catch {
      setError("没能保存，请再试一次。");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      {spend && saved && <SpendCard spend={spend} config={saved} />}
      <label className="setting">
        <div className="setting-head"><b>每月预算</b><small>花到这里时提醒你一次，不会拦着你玩；留空就不提醒。</small></div>
        <span className="field-line"><input aria-label="每月预算（元）" placeholder="不设" {...field("limit")} /><span className="field-suffix">元</span></span>
      </label>
      <div className="setting">
        <div className="setting-head"><b>单价</b><small>照服务商价格页填，每百万 token 多少元；免费的填 0。</small></div>
        <div className="row price-row">
          <label className="grow">输入
            <span className="field-line"><input aria-label="输入单价（元／百万 token）" placeholder="未知" {...field("input")} /><span className="field-suffix">元</span></span>
          </label>
          <label className="grow">输出
            <span className="field-line"><input aria-label="输出单价（元／百万 token）" placeholder="未知" {...field("output")} /><span className="field-suffix">元</span></span>
          </label>
        </div>
      </div>
      {error && <p role="alert" className="notice">{error}</p>}
      <button className="primary" disabled={!saved || saving || !dirty} onClick={() => void save()}>{saving ? "正在保存…" : "保存"}</button>
      <h3 className="settings-sub">明细</h3>
      <button onClick={() => setDetails(true)}>用量明细</button>
      {details && <UsageSheet onClose={() => setDetails(false)} />}
    </>
  );
}
