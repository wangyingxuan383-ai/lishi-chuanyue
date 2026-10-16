import { useEffect, useId, useRef, useState } from "react";
import type { CallAttempt } from "./gameCallClient";
import { hasGameCore } from "./gameClient";
import { clearGamePrice, costAttemptKey, getGameCostEstimates, getGamePrices, normalizePriceInput, setGamePrice, validPriceModel, type CostReply, type ModelPrice, type PriceCurrency, type PriceSettings } from "./gameCostClient";
import { costT as t, priceErrorKey, type GameCostMessageKey } from "./gameCostMessages";
import "./GameCostSettings.css";

interface Props { attempts: CallAttempt[] | null; estimates: CostReply | null; onEstimates: (value: CostReply | null) => void }
export function GameCostAmount({ attempt, reply }: { attempt: CallAttempt; reply: CostReply | null }) {
  const estimate = attempt.usage === null ? null : reply?.attempts.find(row => costAttemptKey(row) === costAttemptKey(attempt))?.estimate;
  return <div className="game-cost-amount"><dt>{t("currentEstimate")}</dt><dd>{reply === null ? t("notRead") : !estimate ? t("unknown") : `${estimate.currency} ${estimate.roundedToZero ? t("small") : estimate.totalAmount}`}</dd></div>;
}
export default function GameCostSettings({ attempts, estimates, onEstimates }: Props) {
  const [settings, setSettings] = useState<PriceSettings | null>(null);
  const [model, setModel] = useState("");
  const [currency, setCurrency] = useState<PriceCurrency>("CNY");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<GameCostMessageKey | null>(null);
  const [status, setStatus] = useState<GameCostMessageKey | null>(null);
  const active = useRef(false), lifecycle = useRef(0), mounted = useRef(false);
  const callback = useRef(onEstimates); callback.current = onEstimates;
  useEffect(() => { mounted.current = true; lifecycle.current++; return () => { mounted.current = false; lifecycle.current++; }; }, []);
  const fieldId = useId();
  const knownModels = [...new Set([...(attempts ?? []).map(entry => entry.model), ...(settings?.entries ?? []).map(entry => entry.model)])].sort();
  const existing = settings?.entries.find(entry => entry.model === model);
  const valid = validPriceModel(model) && normalizePriceInput(input) !== null && normalizePriceInput(output) !== null;
  function selectModel(value: string, source = settings) {
    setModel(value);
    const entry = source?.entries.find(row => row.model === value);
    setCurrency(entry?.currency ?? "CNY"); setInput(entry?.inputPerMillion ?? ""); setOutput(entry?.outputPerMillion ?? "");
    setStatus(null); setError(null);
  }
  function populate(entry: ModelPrice | undefined) {
    if (entry) { setCurrency(entry.currency); setInput(entry.inputPerMillion); setOutput(entry.outputPerMillion); }
  }
  async function run(action: "prices" | "estimates" | "save" | "clear") {
    if (active.current || !hasGameCore() || ((action === "save" || action === "clear") && !settings)) return;
    if (action === "save" && !valid || action === "clear" && !existing) return;
    active.current = true; const lifetime = lifecycle.current;
    setLoading(true); setError(null); setStatus(null);
    const current = () => mounted.current && lifetime === lifecycle.current;
    try {
      if (action === "estimates") {
        const result = await getGameCostEstimates();
        if (!current()) return;
        if (settings && settings.revision !== result.priceRevision) { callback.current(null); setStatus("reread"); }
        else { callback.current(result); setStatus("estimatesRead"); }
      } else {
        const result = action === "prices" ? await getGamePrices() : action === "save" ? await setGamePrice({ model, currency, inputPerMillion: input, outputPerMillion: output, expectedRevision: settings!.revision }) : await clearGamePrice(model, settings!.revision);
        if (!current()) return;
        setSettings(result);
        if (action !== "prices" || estimates && estimates.priceRevision !== result.revision) callback.current(null);
        if (action === "clear") { setInput(""); setOutput(""); }
        else populate(result.entries.find(row => row.model === model));
        setStatus(action === "prices" ? "pricesRead" : action === "save" ? "saved" : "cleared");
      }
    } catch (reason) { if (current()) { callback.current(null); setError(priceErrorKey(reason)); } }
    finally { active.current = false; if (current()) setLoading(false); }
  }
  const disabled = !hasGameCore() || loading;
  return <details className="game-cost-settings"><summary>{t("heading")}</summary>
    <p className="game-muted game-small">{t("help")}</p><p className="game-muted game-small">{t("scope")}</p>
    <div className="game-cost-actions"><button type="button" className="game-secondary" disabled={disabled} onClick={() => void run("prices")}>{t(loading ? "reading" : "readPrices")}</button>
      <button type="button" className="game-secondary" disabled={disabled} onClick={() => void run("estimates")}>{t("readEstimates")}</button></div>
    {error && <p className="game-error" role="alert">{t(error)}</p>}{status && <p className="game-muted" role="status">{t(status)}</p>}
    <p className="game-muted game-small">{t("loadFirst")}</p>
    {settings && <>
      {settings.entries.length === 0 && <p className="game-muted">{t("noPrices")}</p>}
      <div className="game-cost-form">
        {knownModels.length > 0 && <label className="game-cost-full" htmlFor={`${fieldId}-known`}>{t("chooseModel")}<select id={`${fieldId}-known`} disabled={disabled} value={knownModels.includes(model) ? model : ""} onChange={event => selectModel(event.target.value)}><option value="">{t("manualModel")}</option>{knownModels.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
        <label className="game-cost-full" htmlFor={`${fieldId}-model`}>{t("model")}<input id={`${fieldId}-model`} value={model} disabled={disabled} autoComplete="off" spellCheck={false} onChange={event => selectModel(event.target.value)} /></label>
        <label htmlFor={`${fieldId}-currency`}>{t("currency")}<select id={`${fieldId}-currency`} value={currency} disabled={disabled} onChange={event => setCurrency(event.target.value as PriceCurrency)}><option value="CNY">{t("CNY")}</option><option value="USD">{t("USD")}</option></select></label>
        <label htmlFor={`${fieldId}-input`}>{t("input")}<input id={`${fieldId}-input`} type="text" inputMode="decimal" value={input} disabled={disabled} autoComplete="off" onChange={event => setInput(event.target.value)} /></label>
        <label htmlFor={`${fieldId}-output`}>{t("output")}<input id={`${fieldId}-output`} type="text" inputMode="decimal" value={output} disabled={disabled} autoComplete="off" onChange={event => setOutput(event.target.value)} /></label>
      </div><p className="game-muted game-small">{t("modelHelp")}</p><p className="game-muted game-small">{t("priceHelp")}</p>
      {model && <p className="game-muted game-small">{t(existing ? "configured" : "notConfigured")}</p>}
      <div className="game-cost-actions"><button type="button" disabled={disabled || !valid} onClick={() => void run("save")}>{t("save")}</button>
        <button type="button" className="game-secondary" disabled={disabled || !existing} onClick={() => void run("clear")}>{t("clear")}</button></div>
      {!valid && <p className="game-muted game-small">{t("validInput")}</p>}
    </>}
  </details>;
}
