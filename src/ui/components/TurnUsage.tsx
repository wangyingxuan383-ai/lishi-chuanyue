// 每段用量 (R29-T004): what the latest passage cost, one small line under it;
// tapping it shows the requests by purpose. 本局用量 sums the whole story.
import { useEffect, useState } from "react";
import { costText, tokenText, turnUsage, usageCost, usageLine, worldUsage, type Prices, type UsageTotal } from "../../engine/usage";
import { useApp } from "../app/context";
import { readBudget } from "./budgetMath";
import { Sheet } from "./Sheet";

function usePrices(): Prices {
  const { game } = useApp();
  const [prices, setPrices] = useState<Prices>({ input: null, output: null });
  useEffect(() => { void readBudget(game.repo).then(({ input, output }) => setPrices({ input, output })); }, [game]);
  return prices;
}

export function TurnUsageLine({ nodeId }: { nodeId: string }) {
  const { game } = useApp();
  const prices = usePrices();
  const [total, setTotal] = useState<UsageTotal | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    setTotal(null);
    void turnUsage(game.platform, nodeId).then((t) => { if (live) setTotal(t); });
    // Background tidying (补记, 设定集) may land a moment later.
    const later = setTimeout(() => void turnUsage(game.platform, nodeId).then((t) => { if (live && t) setTotal(t); }), 4000);
    return () => { live = false; clearTimeout(later); };
  }, [nodeId]);
  if (!total) return null;
  return <>
    <button className="usage-line" aria-label={`这一段的用量：${usageLine(total, prices)}`} onClick={() => setOpen(true)}>{usageLine(total, prices)}</button>
    {open && <UsageBreakdownSheet title="这一段的用量" total={total} prices={prices} onClose={() => setOpen(false)} />}
  </>;
}

export function PassageUsageSheet({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const { game } = useApp();
  const prices = usePrices();
  const [total, setTotal] = useState<UsageTotal | null | undefined>(undefined);
  useEffect(() => { void turnUsage(game.platform, nodeId).then(setTotal); }, [nodeId]);
  return total ? <UsageBreakdownSheet title="这一段的用量" total={total} prices={prices} onClose={onClose} />
    : <Sheet title="这一段的用量" onClose={onClose}><p className="muted">{total === null ? "这一段没有用量记录（亲手写的、早期版本写的，或记录已清理）。" : "正在读取…"}</p></Sheet>;
}

export function WorldUsageSheet({ worldId, onClose }: { worldId: string; onClose: () => void }) {
  const { game } = useApp();
  const prices = usePrices();
  const [total, setTotal] = useState<UsageTotal | null | undefined>(undefined);
  useEffect(() => { void worldUsage(game.platform, worldId).then(setTotal); }, [worldId]);
  return total ? <UsageBreakdownSheet title="本局用量" total={total} prices={prices} onClose={onClose} note="这个故事至今所有请求，包括整理设定、章节摘要和只给这个故事的札记。" />
    : <Sheet title="本局用量" onClose={onClose}><p className="muted">{total === null ? "这个故事还没有用量记录。" : "正在读取…"}</p></Sheet>;
}

export function UsageBreakdownSheet({ title, total, prices, note, onClose }: { title: string; total: UsageTotal; prices: Prices; note?: string; onClose: () => void }) {
  const cost = usageCost(total, prices);
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="stack">
        {note && <p className="muted m-0">{note}</p>}
        <dl className="facts usage-facts">
          <dt>请求</dt><dd>{total.calls} 次{total.unknown ? `（${total.unknown} 次服务没报用量）` : ""}</dd>
          <dt>输入</dt><dd>{tokenText(total.input)} tokens</dd>
          <dt>输出</dt><dd>{tokenText(total.output)} tokens</dd>
          <dt>用时</dt><dd>{(total.ms / 1000).toFixed(1)} 秒</dd>
          <dt>花费</dt><dd>{cost === null ? "在 设置 → 用量与花费 填上单价后可以估算" : costText(cost)}</dd>
        </dl>
        <h3 className="settings-sub">按用途</h3>
        {total.parts.map((p) => (
          <div key={p.label} className="item-row">
            <div className="grow"><b>{p.label}</b><small>{p.calls} 次 · 输入 {tokenText(p.input)} · 输出 {tokenText(p.output)}{p.ms ? ` · ${(p.ms / 1000).toFixed(1)} 秒` : ""}</small></div>
            {usageCost(p, prices) !== null && <span className="tag">{costText(usageCost(p, prices)!)}</span>}
          </div>
        ))}
        <p className="muted m-0">嫌慢或嫌贵，可以点故事顶部“Aa”旁边的小字换成快速档。估算按你填的单价，不是账单。</p>
      </div>
    </Sheet>
  );
}
