import { useCallback, useEffect, useRef, useState } from "react";
import { locale, t, type MessageKey } from "./i18n";
import {
  cancelProbeRecovery,
  describeRecoveryCode,
  describeRecoveryError,
  getProbeRecovery,
  isRecoveryTerminal,
  startProbeRecovery,
  type RecoveryEvent,
  type RecoveryPause,
  type RecoveryPhase,
  type RecoveryStatus,
  type RecoveryView,
} from "./recoveryClient";

interface RecoveryProbeProps {
  coreConnected: boolean;
}

const scenarios = ["normal", "slow", "stall", "truncated", "large-truncated", "malformed", "http-error"] as const;
type Scenario = (typeof scenarios)[number];
type DisplayPhase = RecoveryStatus | RecoveryPhase | "starting" | "awaiting_commit" | "unconfirmed";

const scenarioLabels = {
  normal: "probe.stream.scenario.normal",
  slow: "probe.stream.scenario.slow",
  stall: "probe.stream.scenario.stall",
  truncated: "probe.stream.scenario.truncated",
  "large-truncated": "probe.stream.scenario.largeTruncated",
  malformed: "probe.stream.scenario.malformed",
  "http-error": "probe.stream.scenario.httpError",
} as const satisfies Record<Scenario, MessageKey>;

const phaseLabels = {
  starting: "probe.recovery.phase.starting",
  pending: "probe.recovery.phase.pending",
  generating: "probe.recovery.phase.generating",
  validating: "probe.recovery.phase.validating",
  commit_paused: "probe.recovery.phase.commit_paused",
  awaiting_commit: "probe.recovery.phase.awaiting_commit",
  committed: "probe.recovery.phase.committed",
  failed: "probe.recovery.phase.failed",
  cancelled: "probe.recovery.phase.cancelled",
  interrupted: "probe.recovery.phase.interrupted",
  unconfirmed: "probe.recovery.phase.unconfirmed",
} as const satisfies Record<DisplayPhase, MessageKey>;

const pauseLabels = {
  none: "probe.recovery.pause.none",
  validating: "probe.recovery.pause.validating",
  commit: "probe.recovery.pause.commit",
} as const satisfies Record<RecoveryPause, MessageKey>;

interface LocalOperation {
  operationId: string;
  expectedHeadOperationId: string | null;
  sequence: number;
  streamStarted: boolean;
  text: string;
  phase: DisplayPhase;
}

function buildTestUrl(base: string, scenario: Scenario): string {
  const url = new URL(base.trim());
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid test address");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${scenario}`;
  return url.toString();
}

function phaseRank(phase: DisplayPhase): number {
  if (phase === "commit_paused") return 4;
  if (phase === "validating" || phase === "awaiting_commit") return 3;
  if (phase === "generating") return 2;
  if (phase === "pending") return 1;
  return 0;
}

export default function RecoveryProbe({ coreConnected }: RecoveryProbeProps) {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:18741/stream");
  const [scenario, setScenario] = useState<Scenario>("normal");
  const [pauseAt, setPauseAt] = useState<RecoveryPause>("none");
  const [persisted, setPersisted] = useState<RecoveryView | null>(null);
  const [local, setLocal] = useState<LocalOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [cancelState, setCancelState] = useState<"idle" | "requesting" | "requested">("idle");
  const mounted = useRef(true);
  const persistedRef = useRef<RecoveryView | null>(null);
  const localRef = useRef<LocalOperation | null>(null);
  const startInFlight = useRef(false);
  const queryInFlight = useRef(false);
  const cancelInFlight = useRef(false);
  const initialReadGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const applyPersisted = useCallback((view: RecoveryView) => {
    if (!mounted.current) return;
    const confirmed = persistedRef.current?.latestOperation;
    const incoming = view.latestOperation;
    // A delayed query must not replace the terminal result already confirmed for this ID.
    if (confirmed && incoming?.operationId === confirmed.operationId &&
      isRecoveryTerminal(confirmed.status) && !isRecoveryTerminal(incoming.status)) return;
    persistedRef.current = view;
    setPersisted(view);
    const operation = view.latestOperation;
    const current = localRef.current;
    if (operation && (!current || current.operationId !== operation.operationId)) {
      // An earlier query can finish after a new IPC start. Do not replace its live draft.
      if (current && startInFlight.current) return;
      const adopted: LocalOperation = {
        operationId: operation.operationId, expectedHeadOperationId: operation.expectedHeadOperationId,
        sequence: -1, streamStarted: false,
        text: "", phase: operation.status,
      };
      localRef.current = adopted;
      setLocal({ ...adopted });
    } else if (operation && current) {
      // A DB query may have started before a phase event. Never move that event backwards.
      if (isRecoveryTerminal(operation.status) || phaseRank(operation.status) >= phaseRank(current.phase)) {
        current.phase = operation.status;
      }
      setLocal({ ...current });
    }
    if (operation && isRecoveryTerminal(operation.status)) {
      setCancelState("idle");
      cancelInFlight.current = false;
      if (operation.status === "failed") {
        setError(describeRecoveryCode(operation.errorCode));
      }
    }
  }, []);

  const refreshState = useCallback(async (silent = false) => {
    if (!coreConnected || queryInFlight.current) return;
    queryInFlight.current = true;
    setQuerying(true);
    try {
      const view = await getProbeRecovery();
      applyPersisted(view);
      if (mounted.current && !silent && view.latestOperation?.status !== "failed") {
        setError(null);
      }
    } catch (caught: unknown) {
      if (mounted.current) setError(describeRecoveryError(caught));
    } finally {
      queryInFlight.current = false;
      if (mounted.current) setQuerying(false);
    }
  }, [coreConnected, applyPersisted]);

  useEffect(() => {
    const generation = ++initialReadGeneration.current;
    if (!coreConnected) return;
    setRestoring(true);
    queryInFlight.current = true;
    // Startup reads durable state only. It never generates or replays a request.
    void getProbeRecovery().then((view) => {
      if (mounted.current && generation === initialReadGeneration.current) applyPersisted(view);
    }).catch((caught: unknown) => {
      if (mounted.current && generation === initialReadGeneration.current) setError(describeRecoveryError(caught));
    }).finally(() => {
      if (generation === initialReadGeneration.current) {
        queryInFlight.current = false;
        if (mounted.current) setRestoring(false);
      }
    });
    return () => { initialReadGeneration.current += 1; };
  }, [coreConnected, applyPersisted]);

  const persistentActive = persisted?.activeOperationId !== null && persisted?.activeOperationId !== undefined;
  const latestStatus = persisted?.latestOperation?.status;
  const busy = startInFlight.current || persistentActive || (latestStatus !== undefined && !isRecoveryTerminal(latestStatus));

  useEffect(() => {
    if (!coreConnected || !busy || restoring) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      await refreshState(true);
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [coreConnected, busy, restoring, refreshState]);

  function receiveEvent(operation: LocalOperation, event: RecoveryEvent): void {
    if (!mounted.current || localRef.current !== operation) return;
    const confirmed = persistedRef.current?.latestOperation;
    const terminal = confirmed?.operationId === operation.operationId && isRecoveryTerminal(confirmed.status)
      ? confirmed.status : null;
    if (event.kind === "phase") {
      if (event.operationId !== operation.operationId) return;
      // Tauri can fetch large Channel packets after the start IPC result has arrived.
      // A late generation/validation event cannot revoke a durable terminal result.
      operation.phase = terminal ?? event.phase;
      setLocal({ ...operation });
      return;
    }
    const stream = event.event;
    if (stream.operationId !== operation.operationId || stream.sequence <= operation.sequence) return;
    if (stream.sequence !== operation.sequence + 1 || (stream.kind === "started" && stream.sequence !== 0) ||
      (stream.kind !== "started" && !operation.streamStarted)) {
      if (terminal === null) setError(t("probe.recovery.error.eventFormat"));
      return;
    }
    operation.sequence = stream.sequence;
    if (stream.kind === "started") {
      operation.streamStarted = true;
      if (terminal === null) operation.phase = "generating";
    } else if (stream.kind === "delta") {
      operation.text += stream.text;
    } else {
      // The network completion event cannot establish a committed DB snapshot.
      if (terminal === null) operation.phase = stream.status === "completed" ? "awaiting_commit" : "unconfirmed";
    }
    if (terminal !== null) operation.phase = terminal;
    setLocal({ ...operation });
  }

  async function startRecovery(): Promise<void> {
    if (!coreConnected || startInFlight.current || queryInFlight.current || restoring || !persistedRef.current || busy) return;
    let url: string;
    try {
      url = buildTestUrl(baseUrl, scenario);
    } catch {
      setError(t("probe.stream.error.invalidUrl"));
      return;
    }
    const operation: LocalOperation = {
      operationId: crypto.randomUUID(), expectedHeadOperationId: persistedRef.current.snapshot.operationId,
      sequence: -1, streamStarted: false, text: "", phase: "starting",
    };
    const expectedHeadOperationId = operation.expectedHeadOperationId;
    localRef.current = operation;
    startInFlight.current = true;
    cancelInFlight.current = false;
    setCancelState("idle");
    setError(null);
    setLocal({ ...operation });
    try {
      const view = await startProbeRecovery(
        { operationId: operation.operationId, url, expectedHeadOperationId, pauseAt },
        (event) => receiveEvent(operation, event),
        () => {
          const confirmed = persistedRef.current?.latestOperation;
          const terminal = confirmed?.operationId === operation.operationId && isRecoveryTerminal(confirmed.status);
          if (mounted.current && localRef.current === operation && !terminal) setError(t("probe.recovery.error.eventFormat"));
        },
      );
      if (mounted.current && localRef.current === operation) applyPersisted(view);
    } catch (caught: unknown) {
      if (mounted.current && localRef.current === operation) {
        const confirmed = persistedRef.current?.latestOperation;
        const terminal = confirmed?.operationId === operation.operationId && isRecoveryTerminal(confirmed.status)
          ? confirmed.status : null;
        operation.phase = terminal ?? "unconfirmed";
        setLocal({ ...operation });
        if (terminal === null) setError(describeRecoveryError(caught));
      }
      await refreshState(true);
    } finally {
      startInFlight.current = false;
      if (mounted.current && localRef.current === operation) setLocal({ ...operation });
    }
  }

  async function cancelRecovery(): Promise<void> {
    const operationId = persistedRef.current?.activeOperationId ?? localRef.current?.operationId;
    if (!coreConnected || !busy || !operationId || cancelInFlight.current || cancelState !== "idle") return;
    cancelInFlight.current = true;
    setCancelState("requesting");
    try {
      const result = await cancelProbeRecovery(operationId);
      if (!mounted.current) return;
      const latest = persistedRef.current?.latestOperation;
      const alreadyTerminal = latest?.operationId === operationId && isRecoveryTerminal(latest.status);
      setCancelState(result.status === "cancel_requested" && !alreadyTerminal ? "requested" : "idle");
      if (result.status !== "cancel_requested") await refreshState();
    } catch (caught: unknown) {
      if (mounted.current) {
        setCancelState("idle");
        setError(describeRecoveryError(caught));
      }
    } finally {
      cancelInFlight.current = false;
    }
  }

  const snapshot = persisted?.snapshot;
  const latest = persisted?.latestOperation;
  const phase = local?.phase ?? latest?.status;

  return (
    <section className="probe-card" aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">{t("probe.recovery.heading")}</h2>
      <p className="section-description">{t("probe.recovery.description")}</p>
      {!coreConnected && <p className="notice recovery-connection-notice">{t("probe.recovery.unavailable")}</p>}
      <label className="input-label" htmlFor="recovery-base-url">{t("probe.recovery.baseLabel")}</label>
      <input id="recovery-base-url" className="probe-input" type="url" value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)} autoCapitalize="none" spellCheck={false}
        aria-describedby="recovery-address-help" />
      <p id="recovery-address-help" className="input-help">{t("probe.recovery.addressHelp")}</p>
      <label className="input-label" htmlFor="recovery-scenario">{t("probe.recovery.scenarioLabel")}</label>
      <select id="recovery-scenario" className="probe-input" value={scenario}
        onChange={(event) => setScenario(event.target.value as Scenario)}>
        {scenarios.map((value) => <option key={value} value={value}>{t(scenarioLabels[value])}</option>)}
      </select>
      <label className="input-label recovery-pause-label" htmlFor="recovery-pause">{t("probe.recovery.pauseLabel")}</label>
      <select id="recovery-pause" className="probe-input" value={pauseAt}
        onChange={(event) => setPauseAt(event.target.value as RecoveryPause)} aria-describedby="recovery-pause-help">
        {(["none", "validating", "commit"] as const).map((value) => <option key={value} value={value}>{t(pauseLabels[value])}</option>)}
      </select>
      <p id="recovery-pause-help" className="input-help">{t("probe.recovery.pauseHelp")}</p>
      <div className="recovery-actions">
        <button type="button" className="primary-button" onClick={() => void startRecovery()}
          disabled={!coreConnected || busy || restoring || querying || !persisted}>
          {t(restoring ? "probe.recovery.restoreBusy" : busy ? "probe.recovery.startBusy" : "probe.recovery.start")}
        </button>
        <button type="button" className="secondary-button" onClick={() => void cancelRecovery()}
          disabled={!coreConnected || !busy || cancelState !== "idle"}>
          {t(cancelState === "idle" ? "probe.recovery.cancel" : "probe.recovery.cancelPending")}
        </button>
        <button type="button" className="secondary-button" onClick={() => void refreshState()}
          disabled={!coreConnected || restoring || querying}>
          {t(querying ? "probe.recovery.queryBusy" : "probe.recovery.query")}
        </button>
      </div>
      <p className="input-help recovery-cancel-help">{t("probe.recovery.cancelHelp")}</p>
      <div aria-live="polite">
        {error && <p className="error-message">{error}</p>}
        {phase && <p className={`recovery-status recovery-status--${phase}`}>{t(phaseLabels[phase])}</p>}
        {persisted && !local && !latest && <p className="notice">{t("probe.recovery.noOperation")}</p>}
        {cancelState === "requested" && busy && <p className="notice">{t("probe.recovery.cancelRequested")}</p>}
      </div>
      {(local || latest) && (
        <dl className="info-grid recovery-metadata">
          <div><dt>{t("probe.recovery.operationId")}</dt><dd>{local?.operationId ?? latest?.operationId}</dd></div>
          <div><dt>{t("probe.recovery.baseHead")}</dt><dd>{(local ? local.expectedHeadOperationId : latest?.expectedHeadOperationId) ?? t("probe.recovery.noHead")}</dd></div>
        </dl>
      )}
      <div className="recovery-draft-section">
        <h3>{t("probe.recovery.draftHeading")}</h3>
        <p className="input-help">{t("probe.recovery.draftHelp")}</p>
        <pre className="echo-output recovery-draft">{local?.text || t("probe.recovery.draftEmpty")}</pre>
      </div>
      <div className="recovery-snapshot-section">
        <h3>{t("probe.recovery.snapshotHeading")}</h3>
        <p className="input-help">{t("probe.recovery.snapshotHelp")}</p>
        {snapshot ? (
          <>
            <dl className="info-grid recovery-snapshot-metadata">
              <div><dt>{t("probe.recovery.revision")}</dt><dd>{snapshot.revision.toLocaleString(locale)}</dd></div>
              <div><dt>{t("probe.recovery.snapshotId")}</dt><dd>{snapshot.operationId ?? t("probe.recovery.noHead")}</dd></div>
            </dl>
            <pre className="echo-output recovery-snapshot">{snapshot.text === "" ? t("probe.recovery.snapshotEmpty") : snapshot.text}</pre>
          </>
        ) : <p className="notice">{t("probe.recovery.notRead")}</p>}
      </div>
    </section>
  );
}
