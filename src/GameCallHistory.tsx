import { useEffect, useRef, useState } from "react";
import { hasGameCore } from "./gameClient";
import { getGameCalls, type CallAttempt } from "./gameCallClient";
import { callT as t } from "./gameCallMessages";

export default function GameCallHistory() {
  const [entries, setEntries] = useState<CallAttempt[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const working = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function read() {
    if (working.current || !hasGameCore()) return;
    working.current = true; setLoading(true); setError(false);
    try { const result = await getGameCalls(); if (mounted.current) setEntries(result); }
    catch { if (mounted.current) setError(true); }
    finally { working.current = false; if (mounted.current) setLoading(false); }
  }
  const number = (value: number | null | undefined) => value === null || value === undefined ? t("unknown") : value.toLocaleString("zh-CN");
  return <details className="game-diagnostics"><summary>{t("heading")}</summary>
    <p className="game-muted game-small">{t("help")}</p><p className="game-muted game-small">{t("budget")}</p>
    <button type="button" className="game-secondary" disabled={!hasGameCore() || loading} onClick={() => void read()}>{t(loading ? "loading" : "read")}</button>
    {error && <p role="alert" className="game-error">{t("error")}</p>}
    {entries?.length === 0 && <p role="status" className="game-muted">{t("empty")}</p>}
    {entries?.map(entry => <article key={entry.operationId + ":" + entry.sequence} className="game-call-entry">
      <p><strong>{entry.model}</strong> · {t(entry.state)}<br /><small>{new Date(entry.createdAtMs).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</small></p>
      <dl className="game-capabilities"><div><dt>{t("reservation")}</dt><dd>{entry.sequence} / 2</dd></div>
        <div><dt>{t("attempts")}</dt><dd>{number(entry.actualHttpAttempts)}</dd></div><div><dt>{t("tokens")}</dt><dd>{number(entry.usage?.totalTokens)}</dd></div>
        <div><dt>{t("http")}</dt><dd>{number(entry.httpStatus)}</dd></div><div><dt>{t("elapsed")}</dt><dd>{number(entry.elapsedMs)}</dd></div></dl>
      <details><summary>{t("details")}</summary><dl className="game-state-summary">
        {([["world", entry.worldId], ["branch", entry.branchId], ["operation", entry.operationId], ["prompt", entry.promptVersion], ["diagnostic", entry.errorCode ?? t("unknown")]] as const).map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>)}
      </dl></details></article>)}
    <p className="game-muted game-small">{t("cost")}</p><p className="game-muted game-small">{t("noEndpoint")}</p>
  </details>;
}
