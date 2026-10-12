import { useEffect, useRef, useState } from "react";
import { locale } from "./i18n";
import { modelT, type ModelMessageKey } from "./modelMessages";
import {
  cancelProbeModel, describeModelCode, describeModelError, getProbeModel, listProbeModelHistory,
  startProbeModel, wasModelRejectedBeforeStart, type ModelCredentialMode, type ModelProbeDiagnostics,
  type ModelProbeHistoryEntry, type ModelProbeRequest, type ModelProbeSnapshot,
} from "./modelClient";
import { describeSecretError, getProbeSecretStatus } from "./secretClient";
import type { StreamEvent, StreamStatus } from "./streamClient";
import "./model-probe.css";

const scenarios = [
  "normal", "slow", "no-usage", "unauthorized", "rate-limit", "redirect", "malformed-usage",
  "truncated", "echo-secret", "stall", "large-truncated",
] as const;
type Scenario = (typeof scenarios)[number];
type Phase = "starting" | "running" | "confirming" | "unconfirmed" | "not_started" | StreamStatus;
type CancelState = "idle" | "requesting" | "requested";

const scenarioLabels = {
  normal: "model.scenario.normal", slow: "model.scenario.slow", "no-usage": "model.scenario.noUsage",
  unauthorized: "model.scenario.unauthorized", "rate-limit": "model.scenario.rateLimit",
  redirect: "model.scenario.redirect", "malformed-usage": "model.scenario.malformedUsage",
  truncated: "model.scenario.truncated", "echo-secret": "model.scenario.echoSecret", stall: "model.scenario.stall",
  "large-truncated": "model.scenario.largeTruncated",
} as const satisfies Record<Scenario, ModelMessageKey>;

const phaseLabels = {
  starting: "model.phase.starting", running: "model.phase.running", confirming: "model.phase.confirming",
  unconfirmed: "model.phase.unconfirmed", not_started: "model.phase.notStarted", completed: "model.phase.completed",
  cancelled: "model.phase.cancelled", failed: "model.phase.failed",
} as const satisfies Record<Phase, ModelMessageKey>;

interface OperationView {
  operationId: string;
  request: ModelProbeRequest | null;
  phase: Phase;
  sequence: number;
  text: string;
  deltaCount: number;
  started: boolean;
  terminal: boolean;
  diagnostics: ModelProbeDiagnostics | null;
}

function fixtureEndpoint(scenario: Scenario): string {
  return `http://127.0.0.1:18742/${scenario}/v1/chat/completions`;
}

function validEndpoint(endpoint: string, mode: ModelCredentialMode): boolean {
  try {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash) return false;
    if (mode === "saved") return url.protocol === "https:";
    // Match the original authority, avoiding URL normalization of shorthand IP spellings.
    return /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:\/|$)/.test(endpoint) && url.protocol === "http:";
  } catch {
    return false;
  }
}

function numberText(value: number | null | undefined): string {
  return value == null ? modelT("model.unknown") : new Intl.NumberFormat(locale).format(value);
}

function Diagnostics({ value }: { value: ModelProbeDiagnostics | null }) {
  if (value === null) return <p className="input-help">{modelT("model.diagnosticsPending")}</p>;
  return (
    <dl className="info-grid model-diagnostics">
      <div><dt>{modelT("model.attempts")}</dt><dd>{numberText(value.attempts)}</dd></div>
      <div><dt>{modelT("model.httpStatus")}</dt><dd>{numberText(value.httpStatus)}</dd></div>
      <div><dt>{modelT("model.elapsed")}</dt><dd>{modelT("model.elapsedValue", { elapsedMs: numberText(value.elapsedMs) })}</dd></div>
      <div><dt>{modelT("model.cost")}</dt><dd>{modelT("model.costUnknown")}</dd></div>
      <div><dt>{modelT("model.promptTokens")}</dt><dd>{numberText(value.usage?.promptTokens)}</dd></div>
      <div><dt>{modelT("model.completionTokens")}</dt><dd>{numberText(value.usage?.completionTokens)}</dd></div>
      <div><dt>{modelT("model.totalTokens")}</dt><dd>{numberText(value.usage?.totalTokens)}</dd></div>
    </dl>
  );
}

export default function ModelProbe({ coreConnected }: { coreConnected: boolean }) {
  const [credentialMode, setCredentialMode] = useState<ModelCredentialMode>("fixture");
  const [scenario, setScenario] = useState<Scenario>("normal");
  const [endpoint, setEndpoint] = useState(fixtureEndpoint("normal"));
  const [model, setModel] = useState("fixture-model");
  const [prompt, setPrompt] = useState(modelT("model.promptSample"));
  const [includeUsage, setIncludeUsage] = useState(false);
  const [view, setView] = useState<OperationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelState, setCancelState] = useState<CancelState>("idle");
  const [querying, setQuerying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [secretConfigured, setSecretConfigured] = useState<boolean | null>(null);
  const [secretRefreshing, setSecretRefreshing] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [history, setHistory] = useState<ModelProbeHistoryEntry[] | null>(null);
  const [historyRefreshing, setHistoryRefreshing] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const active = useRef<OperationView | null>(null);
  const mounted = useRef(true);
  const startInFlight = useRef(false);
  const cancelInFlight = useRef(false);
  const queryInFlight = useRef(false);
  const restoreInFlight = useRef(false);
  const historyInFlight = useRef(false);
  const secretInFlight = useRef(false);
  const restoreGeneration = useRef(0);
  const secretGeneration = useRef(0);
  const historyGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const generation = ++restoreGeneration.current;
    if (!coreConnected || active.current) return;
    restoreInFlight.current = true;
    setRestoring(true);
    void getProbeModel(null).then((snapshot) => {
      if (mounted.current && generation === restoreGeneration.current && !active.current && snapshot !== null) {
        adoptSnapshot(snapshot);
      }
    }).catch((caught: unknown) => {
      if (mounted.current && generation === restoreGeneration.current) setError(describeModelError(caught));
    }).finally(() => {
      if (generation === restoreGeneration.current) {
        restoreInFlight.current = false;
        if (mounted.current) setRestoring(false);
      }
    });
    return () => { restoreGeneration.current += 1; restoreInFlight.current = false; };
  }, [coreConnected]);

  useEffect(() => {
    if (coreConnected && credentialMode === "saved") void refreshSecret();
    return () => { secretGeneration.current += 1; secretInFlight.current = false; };
  }, [coreConnected, credentialMode]);

  useEffect(() => {
    if (!coreConnected || !view || view.terminal) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const operation = active.current;
      if (!stopped && operation && !operation.terminal) {
        await refreshOperation(operation, true);
        if (!stopped && !operation.terminal) timer = setTimeout(() => void poll(), 750);
      }
    };
    timer = setTimeout(() => void poll(), 750);
    return () => { stopped = true; clearTimeout(timer); };
  }, [coreConnected, view?.operationId, view?.terminal]);

  function isCurrent(operation: OperationView): boolean {
    return mounted.current && active.current === operation;
  }

  function publish(operation: OperationView): void {
    if (isCurrent(operation)) setView({ ...operation });
  }

  function adoptSnapshot(snapshot: ModelProbeSnapshot): void {
    const stream = snapshot.stream;
    const operation: OperationView = {
      operationId: stream.operationId, request: null, phase: stream.state, sequence: stream.sequence,
      text: stream.text, deltaCount: stream.deltaCount, started: true, terminal: stream.state !== "running",
      diagnostics: snapshot.diagnostics,
    };
    active.current = operation;
    startInFlight.current = !operation.terminal;
    cancelInFlight.current = false;
    setCancelState("idle");
    setError(stream.state === "failed" || stream.errorCode ? describeModelCode(stream.errorCode) : null);
    publish(operation);
  }

  function finish(operation: OperationView, status: StreamStatus, text: string, diagnostics: ModelProbeDiagnostics | null, errorCode?: string): void {
    if (!isCurrent(operation)) return;
    if (operation.terminal && operation.phase !== status) return;
    operation.phase = status;
    operation.text = text;
    operation.terminal = true;
    operation.diagnostics = diagnostics ?? operation.diagnostics;
    startInFlight.current = false;
    cancelInFlight.current = false;
    setCancelState("idle");
    setError(status === "failed" || errorCode ? describeModelCode(errorCode) : null);
    publish(operation);
  }

  function receiveEvent(operation: OperationView, event: StreamEvent): void {
    if (!isCurrent(operation) || operation.terminal || event.operationId !== operation.operationId || event.sequence <= operation.sequence) return;
    if (event.sequence !== operation.sequence + 1 || (event.kind === "started" && event.sequence !== 0) || (event.kind !== "started" && !operation.started)) {
      setError(modelT("model.error.eventOrder"));
      return;
    }
    operation.sequence = event.sequence;
    if (event.kind === "started") {
      operation.started = true;
      operation.phase = "running";
    } else if (event.kind === "delta") {
      operation.text += event.text;
      operation.deltaCount += 1;
    } else {
      // Only a returned result or real state query confirms the terminal result and diagnostics.
      operation.phase = "confirming";
    }
    publish(operation);
  }

  async function refreshOperation(operation = active.current, quiet = false): Promise<void> {
    if (!coreConnected || !operation || queryInFlight.current) return;
    const terminalAtQuery = operation.terminal;
    queryInFlight.current = true;
    if (!quiet) setQuerying(true);
    try {
      const snapshot = await getProbeModel(operation.operationId);
      if (!isCurrent(operation)) return;
      if (operation.terminal) {
        // An older running query cannot alter a subsequently confirmed terminal result.
        if (!terminalAtQuery) return;
        if (snapshot === null) setError(modelT("model.error.notFound"));
        else if (snapshot.stream.state === operation.phase && snapshot.diagnostics !== null) {
          operation.diagnostics = snapshot.diagnostics;
          publish(operation);
        }
        return;
      }
      if (snapshot === null) { setError(modelT("model.error.notFound")); return; }
      const stream = snapshot.stream;
      if (stream.state !== "running") {
        operation.sequence = Math.max(operation.sequence, stream.sequence);
        operation.deltaCount = stream.deltaCount;
        finish(operation, stream.state, stream.text, snapshot.diagnostics, stream.errorCode);
      } else if (stream.sequence >= operation.sequence) {
        operation.sequence = stream.sequence;
        operation.text = stream.text;
        operation.deltaCount = stream.deltaCount;
        operation.started = true;
        operation.phase = "running";
        publish(operation);
      }
    } catch (caught: unknown) {
      if (isCurrent(operation) && !operation.terminal) setError(describeModelError(caught));
    } finally {
      queryInFlight.current = false;
      if (mounted.current && !quiet) setQuerying(false);
    }
  }

  async function startModel(): Promise<void> {
    if (!coreConnected || startInFlight.current || restoreInFlight.current || queryInFlight.current || inspectingId !== null) return;
    const request: ModelProbeRequest = {
      operationId: crypto.randomUUID(), endpoint: endpoint.trim(), model: model.trim(), prompt,
      includeUsage, credentialMode,
    };
    if (!validEndpoint(request.endpoint, request.credentialMode)) { setError(modelT("model.error.invalidUrl")); return; }
    if (!request.model || !request.prompt.trim()) { setError(modelT("model.error.invalidConfig")); return; }
    if (request.credentialMode === "saved" && secretConfigured !== true) { setError(modelT("model.error.credentialMissing")); return; }
    const operation: OperationView = {
      operationId: request.operationId, request, phase: "starting", sequence: -1, text: "",
      deltaCount: 0, started: false, terminal: false, diagnostics: null,
    };
    active.current = operation;
    startInFlight.current = true;
    cancelInFlight.current = false;
    setCancelState("idle");
    setError(null);
    publish(operation);
    try {
      const result = await startProbeModel(request, (event) => receiveEvent(operation, event), () => {
        if (isCurrent(operation) && !operation.terminal) setError(modelT("model.error.eventFormat"));
      });
      if (!isCurrent(operation)) return;
      if (operation.terminal && operation.phase !== result.stream.status) {
        setError(modelT("model.error.resultFormat"));
      } else {
        operation.deltaCount = result.stream.deltaCount;
        finish(operation, result.stream.status, result.stream.text, result.diagnostics, result.stream.errorCode);
      }
    } catch (caught: unknown) {
      if (!isCurrent(operation) || operation.terminal) return;
      if (wasModelRejectedBeforeStart(caught)) {
        operation.phase = "not_started";
        operation.terminal = true;
        startInFlight.current = false;
        cancelInFlight.current = false;
        setCancelState("idle");
      } else {
        operation.phase = "unconfirmed";
      }
      setError(describeModelError(caught));
      publish(operation);
      if (!operation.terminal) await refreshOperation(operation, true);
    }
  }

  async function cancelModel(): Promise<void> {
    const operation = active.current;
    if (!coreConnected || !operation || operation.terminal || cancelInFlight.current) return;
    cancelInFlight.current = true;
    setCancelState("requesting");
    try {
      const result = await cancelProbeModel(operation.operationId);
      if (!isCurrent(operation) || operation.terminal) return;
      if (result.state === "cancel_requested") setCancelState("requested");
      else { setCancelState("idle"); await refreshOperation(operation); }
    } catch (caught: unknown) {
      if (isCurrent(operation) && !operation.terminal) { setError(describeModelError(caught)); setCancelState("idle"); }
    } finally {
      if (isCurrent(operation)) cancelInFlight.current = false;
    }
  }

  async function refreshSecret(): Promise<void> {
    if (!coreConnected || secretInFlight.current) return;
    const generation = ++secretGeneration.current;
    secretInFlight.current = true;
    setSecretRefreshing(true);
    setSecretConfigured(null);
    setSecretError(null);
    try {
      const status = await getProbeSecretStatus();
      if (mounted.current && generation === secretGeneration.current) setSecretConfigured(status.configured);
    } catch (caught: unknown) {
      if (mounted.current && generation === secretGeneration.current) setSecretError(describeSecretError(caught));
    } finally {
      if (generation === secretGeneration.current) {
        secretInFlight.current = false;
        if (mounted.current) setSecretRefreshing(false);
      }
    }
  }

  async function refreshHistory(): Promise<void> {
    if (!coreConnected || historyInFlight.current) return;
    const generation = ++historyGeneration.current;
    historyInFlight.current = true;
    setHistoryRefreshing(true);
    setHistoryError(null);
    try {
      const records = await listProbeModelHistory();
      if (mounted.current && generation === historyGeneration.current) setHistory(records);
    } catch (caught: unknown) {
      if (mounted.current && generation === historyGeneration.current) setHistoryError(describeModelError(caught));
    } finally {
      if (generation === historyGeneration.current) {
        historyInFlight.current = false;
        if (mounted.current) setHistoryRefreshing(false);
      }
    }
  }

  async function inspectHistory(operationId: string): Promise<void> {
    if (!coreConnected || startInFlight.current || queryInFlight.current || restoreInFlight.current) return;
    const previous = active.current;
    queryInFlight.current = true;
    setInspectingId(operationId);
    try {
      const snapshot = await getProbeModel(operationId);
      if (!mounted.current || active.current !== previous || startInFlight.current) return;
      if (snapshot === null) setHistoryError(modelT("model.error.notFound"));
      else { setHistoryError(null); adoptSnapshot(snapshot); }
    } catch (caught: unknown) {
      if (mounted.current && active.current === previous) setHistoryError(describeModelError(caught));
    } finally {
      queryInFlight.current = false;
      if (mounted.current) setInspectingId(null);
    }
  }

  const busy = view !== null && !view.terminal;
  const startDisabled = !coreConnected || busy || restoring || querying || inspectingId !== null || (credentialMode === "saved" && secretConfigured !== true);
  const secretStatus = secretConfigured === null ? "model.secret.unknown" : secretConfigured ? "model.secret.configured" : "model.secret.missing";

  return (
    <section className="probe-card model-probe" aria-labelledby="model-heading">
      <h2 id="model-heading">{modelT("model.heading")}</h2>
      <p className="section-description">{modelT("model.description")}</p>
      {!coreConnected && <p className="model-unavailable" role="status">{modelT("model.unavailable")}</p>}
      <label className="input-label" htmlFor="model-credential-mode">{modelT("model.modeLabel")}</label>
      <select id="model-credential-mode" className="probe-input" value={credentialMode} onChange={(event) => setCredentialMode(event.target.value as ModelCredentialMode)} aria-describedby="model-mode-help">
        <option value="fixture">{modelT("model.mode.fixture")}</option><option value="saved">{modelT("model.mode.saved")}</option>
      </select>
      <p id="model-mode-help" className="input-help">{modelT(credentialMode === "fixture" ? "model.fixtureHelp" : "model.savedHelp")}</p>
      {credentialMode === "saved" && (
        <div className="model-secret-status">
          <p role="status">{modelT(secretStatus)}</p>
          <button type="button" className="secondary-button" disabled={!coreConnected || secretRefreshing} onClick={() => void refreshSecret()}>{modelT(secretRefreshing ? "model.secret.refreshBusy" : "model.secret.refresh")}</button>
          {secretError && <p className="error-message" role="alert">{secretError}</p>}
        </div>
      )}
      {credentialMode === "fixture" && (
        <>
          <label className="input-label" htmlFor="model-scenario">{modelT("model.scenarioLabel")}</label>
          <select id="model-scenario" className="probe-input" value={scenario} onChange={(event) => {
            const next = event.target.value as Scenario;
            setScenario(next); setEndpoint(fixtureEndpoint(next));
          }} aria-describedby="model-scenario-help">{scenarios.map((item) => <option key={item} value={item}>{modelT(scenarioLabels[item])}</option>)}</select>
          <p id="model-scenario-help" className="input-help">{modelT("model.scenarioHelp")}</p>
        </>
      )}
      <label className="input-label" htmlFor="model-endpoint">{modelT("model.endpointLabel")}</label>
      <input id="model-endpoint" className="probe-input" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} type="url" autoComplete="off" spellCheck={false} aria-describedby="model-endpoint-help" />
      <p id="model-endpoint-help" className="input-help">{modelT("model.endpointHelp")}</p>
      <label className="input-label" htmlFor="model-name">{modelT("model.modelLabel")}</label>
      <input id="model-name" className="probe-input" value={model} onChange={(event) => setModel(event.target.value)} autoComplete="off" spellCheck={false} />
      <label className="input-label model-prompt-label" htmlFor="model-prompt">{modelT("model.promptLabel")}</label>
      <textarea id="model-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} spellCheck={false} aria-describedby="model-prompt-help" />
      <p id="model-prompt-help" className="input-help">{modelT("model.promptHelp")}</p>
      <label className="model-usage-option" htmlFor="model-include-usage"><input id="model-include-usage" type="checkbox" checked={includeUsage} onChange={(event) => setIncludeUsage(event.target.checked)} aria-describedby="model-usage-help" /><span>{modelT("model.includeUsage")}</span></label>
      <p id="model-usage-help" className="input-help">{modelT("model.usageHelp")}</p>
      <div className="model-actions">
        <button type="button" className="primary-button" disabled={startDisabled} onClick={() => void startModel()}>{modelT(restoring ? "model.restoreBusy" : busy ? "model.startBusy" : "model.start")}</button>
        <button type="button" className="secondary-button" disabled={!coreConnected || !busy || cancelState !== "idle"} onClick={() => void cancelModel()}>{modelT(cancelState === "requesting" ? "model.cancelBusy" : "model.cancel")}</button>
        <button type="button" className="secondary-button" disabled={!coreConnected || !view || querying || restoring || inspectingId !== null} onClick={() => void refreshOperation()}>{modelT(querying ? "model.queryBusy" : "model.query")}</button>
      </div>
      <p className="input-help model-send-help">{modelT("model.sendHelp")}</p>
      <div aria-live="polite">
        {view && <p className={`model-status model-status--${view.phase}`}>{modelT(phaseLabels[view.phase])}</p>}
        {cancelState === "requested" && <p className="notice">{modelT("model.cancelRequested")}</p>}
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>
      {view && (
        <div className="model-result">
          <dl className="info-grid model-metadata">
            <div><dt>{modelT("model.operationId")}</dt><dd>{view.operationId}</dd></div><div><dt>{modelT("model.deltaCount")}</dt><dd>{numberText(view.deltaCount)}</dd></div>
            {view.request ? <><div className="model-endpoint-metadata"><dt>{modelT("model.frozenEndpoint")}</dt><dd>{view.request.endpoint}</dd></div><div><dt>{modelT("model.frozenModel")}</dt><dd>{view.request.model}</dd></div></> : <div className="model-endpoint-metadata"><dt>{modelT("model.frozenEndpoint")}</dt><dd>{modelT("model.recoveredMetadata")}</dd></div>}
          </dl>
          <h3>{modelT("model.diagnosticsHeading")}</h3><Diagnostics value={view.diagnostics} />
          <h3>{modelT("model.draftHeading")}</h3><p className="input-help">{modelT("model.draftHelp")}</p>
          <pre className="echo-output model-draft">{view.text || modelT("model.empty")}</pre>
        </div>
      )}
      <div className="model-history-section">
        <div className="card-heading"><h3>{modelT("model.historyHeading")}</h3><button type="button" className="secondary-button" disabled={!coreConnected || historyRefreshing} onClick={() => void refreshHistory()}>{modelT(historyRefreshing ? "model.historyBusy" : "model.historyRefresh")}</button></div>
        <p className="input-help">{modelT("model.historyHelp")}</p>
        {historyError && <p className="error-message" role="alert">{historyError}</p>}
        {history === null ? <p className="input-help">{modelT("model.historyNotRead")}</p> : history.length === 0 ? <p className="input-help">{modelT("model.historyEmpty")}</p> : (
          <ol className="model-history">{history.map((record) => (
            <li key={record.operationId}>
              <p className={`model-status model-status--${record.status}`}>{modelT(phaseLabels[record.status])}</p>
              <dl className="info-grid model-metadata"><div className="model-endpoint-metadata"><dt>{modelT("model.operationId")}</dt><dd>{record.operationId}</dd></div></dl>
              {record.errorCode && <p className="error-message">{describeModelCode(record.errorCode)}</p>}
              <Diagnostics value={record.diagnostics} />
              <button type="button" className="secondary-button model-history-inspect" disabled={!coreConnected || busy || querying || restoring || inspectingId !== null} onClick={() => void inspectHistory(record.operationId)}>{modelT(inspectingId === record.operationId ? "model.historyInspectBusy" : "model.historyInspect")}</button>
            </li>
          ))}</ol>
        )}
      </div>
    </section>
  );
}
