import { useEffect, useRef, useState } from "react";
import { locale, t, type MessageKey } from "./i18n";
import {
  cancelProbeStream,
  describeStreamCode,
  describeStreamError,
  getProbeStream,
  startProbeStream,
  wasRejectedBeforeStart,
  type StreamEvent,
  type StreamSnapshot,
  type StreamStatus,
} from "./streamClient";

interface StreamProbeProps {
  coreConnected: boolean;
}

const scenarios = [
  "normal", "slow", "stall", "truncated", "malformed", "http-error", "invalid-utf8", "large-event",
] as const;
type Scenario = (typeof scenarios)[number];
type Phase = "starting" | "running" | "confirming" | "unconfirmed" | "not_started" | StreamStatus;
type CancelState = "idle" | "requesting" | "requested";

const scenarioLabels = {
  normal: "probe.stream.scenario.normal",
  slow: "probe.stream.scenario.slow",
  stall: "probe.stream.scenario.stall",
  truncated: "probe.stream.scenario.truncated",
  malformed: "probe.stream.scenario.malformed",
  "http-error": "probe.stream.scenario.httpError",
  "invalid-utf8": "probe.stream.scenario.invalidUtf8",
  "large-event": "probe.stream.scenario.largeEvent",
} as const satisfies Record<Scenario, MessageKey>;

const phaseLabels = {
  starting: "probe.stream.phase.starting",
  running: "probe.stream.phase.running",
  confirming: "probe.stream.phase.confirming",
  unconfirmed: "probe.stream.phase.unconfirmed",
  not_started: "probe.stream.phase.notStarted",
  completed: "probe.stream.phase.completed",
  cancelled: "probe.stream.phase.cancelled",
  failed: "probe.stream.phase.failed",
} as const satisfies Record<Phase, MessageKey>;

interface OperationView {
  operationId: string;
  url: string;
  phase: Phase;
  sequence: number;
  text: string;
  deltaCount: number;
  started: boolean;
  terminal: boolean;
}

function buildStreamUrl(base: string, scenario: Scenario): string {
  const url = new URL(base.trim());
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid stream base URL");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${scenario}`;
  return url.toString();
}

export default function StreamProbe({ coreConnected }: StreamProbeProps) {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:18741/stream");
  const [scenario, setScenario] = useState<Scenario>("normal");
  const [view, setView] = useState<OperationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelState, setCancelState] = useState<CancelState>("idle");
  const [querying, setQuerying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const active = useRef<OperationView | null>(null);
  const startInFlight = useRef(false);
  const cancelInFlight = useRef(false);
  const queryInFlight = useRef(false);
  const restoreInFlight = useRef(false);
  const restoreGeneration = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const generation = ++restoreGeneration.current;
    if (!coreConnected || active.current) {
      return;
    }
    restoreInFlight.current = true;
    setRestoring(true);
    void getProbeStream(null).then((snapshot) => {
      if (!mounted.current || generation !== restoreGeneration.current || active.current || snapshot === null) {
        return;
      }
      adoptSnapshot(snapshot);
    }).catch((caught: unknown) => {
      if (mounted.current && generation === restoreGeneration.current) {
        setError(describeStreamError(caught));
      }
    }).finally(() => {
      if (generation === restoreGeneration.current) {
        restoreInFlight.current = false;
        if (mounted.current) {
          setRestoring(false);
        }
      }
    });
    return () => {
      restoreGeneration.current += 1;
      restoreInFlight.current = false;
    };
  }, [coreConnected]);

  useEffect(() => {
    if (!coreConnected || !view || view.terminal) {
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const operation = active.current;
      if (!stopped && operation && !operation.terminal) {
        // A timer only schedules a real IPC query; it never decides a terminal status.
        await refreshOperation(operation, true);
        if (!stopped && !operation.terminal) {
          timer = setTimeout(() => void poll(), 750);
        }
      }
    };
    timer = setTimeout(() => void poll(), 750);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [coreConnected, view?.operationId, view?.terminal]);

  function isCurrent(operation: OperationView): boolean {
    return mounted.current && active.current === operation;
  }

  function publish(operation: OperationView): void {
    if (isCurrent(operation)) {
      setView({ ...operation });
    }
  }

  function adoptSnapshot(snapshot: StreamSnapshot): void {
    const operation: OperationView = {
      operationId: snapshot.operationId, url: t("probe.stream.recoveredUrl"),
      phase: snapshot.state, sequence: snapshot.sequence, text: snapshot.text,
      deltaCount: snapshot.deltaCount, started: true, terminal: snapshot.state !== "running",
    };
    active.current = operation;
    startInFlight.current = !operation.terminal;
    cancelInFlight.current = false;
    setCancelState("idle");
    setView({ ...operation });
    setError(operation.phase === "failed" || snapshot.errorCode ? describeStreamCode(snapshot.errorCode) : null);
  }

  function finish(operation: OperationView, status: StreamStatus, text: string, errorCode?: string): void {
    if (!isCurrent(operation) || operation.terminal) {
      return;
    }
    operation.phase = status;
    operation.text = text;
    operation.terminal = true;
    startInFlight.current = false;
    cancelInFlight.current = false;
    setCancelState("idle");
    setError(status === "failed" || errorCode ? describeStreamCode(errorCode) : null);
    publish(operation);
  }

  function receiveEvent(operation: OperationView, event: StreamEvent): void {
    if (!isCurrent(operation) || operation.terminal || event.operationId !== operation.operationId) {
      return;
    }
    if (event.sequence <= operation.sequence) {
      return;
    }
    if (event.sequence !== operation.sequence + 1 || (event.kind === "started" && event.sequence !== 0)) {
      setError(t("probe.stream.error.eventOrder"));
      return;
    }
    if (event.kind !== "started" && !operation.started) {
      setError(t("probe.stream.error.eventOrder"));
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
      // A finished event prompts confirmation; only a result/query releases the operation.
      operation.phase = "confirming";
    }
    publish(operation);
  }

  async function refreshOperation(operation = active.current, quiet = false): Promise<void> {
    if (!coreConnected || !operation || queryInFlight.current) {
      return;
    }
    queryInFlight.current = true;
    if (!quiet) {
      setQuerying(true);
    }
    try {
      const snapshot = await getProbeStream(operation.operationId);
      if (!isCurrent(operation) || operation.terminal) {
        return;
      }
      if (snapshot === null) {
        setError(t("probe.stream.error.notFound"));
        return;
      }
      if (snapshot.state !== "running") {
        operation.sequence = Math.max(operation.sequence, snapshot.sequence);
        operation.deltaCount = snapshot.deltaCount;
        finish(operation, snapshot.state, snapshot.text, snapshot.errorCode);
        return;
      }
      if (snapshot.sequence >= operation.sequence) {
        operation.sequence = snapshot.sequence;
        operation.text = snapshot.text;
        operation.deltaCount = snapshot.deltaCount;
        operation.phase = "running";
        publish(operation);
      }
    } catch (caught: unknown) {
      if (isCurrent(operation) && !operation.terminal) {
        setError(describeStreamError(caught));
      }
    } finally {
      queryInFlight.current = false;
      if (mounted.current && !quiet) {
        setQuerying(false);
      }
    }
  }

  async function startStream(): Promise<void> {
    if (!coreConnected || startInFlight.current || restoreInFlight.current) {
      return;
    }
    let url: string;
    try {
      url = buildStreamUrl(baseUrl, scenario);
    } catch {
      setError(t("probe.stream.error.invalidUrl"));
      return;
    }
    const operation: OperationView = {
      operationId: crypto.randomUUID(), url, phase: "starting", sequence: -1,
      text: "", deltaCount: 0, started: false, terminal: false,
    };
    active.current = operation;
    startInFlight.current = true;
    cancelInFlight.current = false;
    setCancelState("idle");
    setError(null);
    publish(operation);
    try {
      const result = await startProbeStream(
        { operationId: operation.operationId, url: operation.url },
        (event) => receiveEvent(operation, event),
        () => {
          if (isCurrent(operation) && !operation.terminal) {
            setError(t("probe.stream.error.eventFormat"));
          }
        },
      );
      if (isCurrent(operation)) {
        if (operation.terminal) {
          if (operation.phase === result.status) {
            operation.deltaCount = result.deltaCount;
            operation.text = result.text;
            publish(operation);
          } else {
            setError(t("probe.stream.error.resultFormat"));
          }
        } else {
          operation.deltaCount = result.deltaCount;
          finish(operation, result.status, result.text, result.errorCode);
        }
      }
    } catch (caught: unknown) {
      if (isCurrent(operation) && !operation.terminal) {
        if (wasRejectedBeforeStart(caught)) {
          operation.phase = "not_started";
          operation.terminal = true;
          startInFlight.current = false;
          setError(describeStreamError(caught));
          publish(operation);
          if (caught.code === "stream_busy" || caught.code === "stream_duplicate") {
            restoreInFlight.current = true;
            setRestoring(true);
            try {
              const snapshot = await getProbeStream(caught.code === "stream_busy" ? null : operation.operationId);
              if (isCurrent(operation) && snapshot !== null) {
                adoptSnapshot(snapshot);
              }
            } catch (queryError: unknown) {
              if (isCurrent(operation)) {
                setError(describeStreamError(queryError));
              }
            } finally {
              restoreInFlight.current = false;
              if (mounted.current) {
                setRestoring(false);
              }
            }
          }
          return;
        }
        operation.phase = "unconfirmed";
        setError(describeStreamError(caught));
        publish(operation);
        await refreshOperation(operation);
      }
    }
  }

  async function cancelStream(): Promise<void> {
    const operation = active.current;
    if (!coreConnected || !operation?.started || operation.terminal || cancelInFlight.current || cancelState !== "idle") {
      return;
    }
    cancelInFlight.current = true;
    setCancelState("requesting");
    try {
      const result = await cancelProbeStream(operation.operationId);
      if (!isCurrent(operation) || operation.terminal) {
        return;
      }
      if (result.state === "cancel_requested") {
        setCancelState("requested");
      } else {
        setCancelState("idle");
        if (result.state === "not_found") {
          setError(t("probe.stream.error.notFound"));
        }
        await refreshOperation(operation);
      }
    } catch (caught: unknown) {
      if (isCurrent(operation) && !operation.terminal) {
        setCancelState("idle");
        setError(describeStreamError(caught));
      }
    } finally {
      if (isCurrent(operation)) {
        cancelInFlight.current = false;
      }
    }
  }

  const busy = view !== null && !view.terminal;
  const canCancel = coreConnected && view?.started && !view.terminal && view.phase !== "confirming" && cancelState === "idle";

  return (
    <section className="probe-card" aria-labelledby="stream-heading">
      <h2 id="stream-heading">{t("probe.stream.heading")}</h2>
      <p className="section-description">{t("probe.stream.description")}</p>
      {!coreConnected && <p className="notice stream-notice">{t("probe.stream.unavailable")}</p>}

      <label className="input-label" htmlFor="stream-base-url">{t("probe.stream.baseLabel")}</label>
      <input
        id="stream-base-url" className="probe-input" type="url" value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
        spellCheck={false} autoCapitalize="none" aria-describedby="stream-address-help"
      />
      <p id="stream-address-help" className="input-help">{t("probe.stream.addressHelp")}</p>
      <label className="input-label" htmlFor="stream-scenario">{t("probe.stream.scenarioLabel")}</label>
      <select id="stream-scenario" className="probe-input" value={scenario} onChange={(event) => setScenario(event.target.value as Scenario)}>
        {scenarios.map((value) => <option key={value} value={value}>{t(scenarioLabels[value])}</option>)}
      </select>

      <div className="stream-actions">
        <button type="button" className="primary-button" onClick={() => void startStream()} disabled={!coreConnected || busy || restoring}>
          {restoring ? t("probe.stream.restoreBusy") : busy ? t("probe.stream.startBusy") : t("probe.stream.start")}
        </button>
        <button type="button" className="secondary-button" onClick={() => void cancelStream()} disabled={!canCancel}>
          {cancelState === "idle" ? t("probe.stream.cancel") : t("probe.stream.cancelPending")}
        </button>
        <button type="button" className="secondary-button" onClick={() => void refreshOperation()} disabled={!coreConnected || !view || view.terminal || querying}>
          {querying ? t("probe.stream.queryBusy") : t("probe.stream.query")}
        </button>
      </div>
      <p className="input-help stream-cancel-help">{t("probe.stream.cancelHelp")}</p>

      <div className="stream-feedback" aria-live="polite">
        {error && <p className="error-message">{error}</p>}
        {view && <p className={`stream-status stream-status--${view.phase}`}>{t(phaseLabels[view.phase])}</p>}
        {cancelState === "requested" && <p className="notice">{t("probe.stream.cancelRequested")}</p>}
      </div>

      {view && (
        <div className="stream-result">
          <dl className="info-grid stream-metadata">
            <div><dt>{t("probe.stream.operationId")}</dt><dd>{view.operationId}</dd></div>
            <div><dt>{t("probe.stream.deltaCount")}</dt><dd>{view.deltaCount.toLocaleString(locale)}</dd></div>
            <div className="stream-url"><dt>{t("probe.stream.frozenUrl")}</dt><dd>{view.url}</dd></div>
          </dl>
          <h3>{t("probe.stream.draftHeading")}</h3>
          <p className="input-help">{t("probe.stream.draftHelp")}</p>
          <pre className="echo-output stream-draft">{view.text === "" ? t("probe.stream.empty") : view.text}</pre>
        </div>
      )}
    </section>
  );
}
