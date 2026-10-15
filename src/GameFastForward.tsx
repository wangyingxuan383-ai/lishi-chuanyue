import { useEffect, useId, useRef, useState } from "react";
import { cancelGameTurn, hasGameCore, type GameWorld, type ProviderKind } from "./gameClient";
import { cancelGameFastForward, continueGameFastForward, describeFastForwardError, getGameCalendar, listGameFastForward,
  resumeGameFastForward, startGameFastForward, FastForwardError, type CalendarMoment, type FastForwardJob, type GameCalendar } from "./gameFastForwardClient";
import { fastForwardT as t, type FastForwardMessageKey } from "./gameFastForwardMessages";
import "./gameFastForward.css";
export interface GameFastForwardProps {
  world: GameWorld; busy: boolean; archived: boolean; branchesEnabled: boolean; providerKind: ProviderKind; providerConfigured: boolean;
  beginWrite: () => boolean; endWrite: () => void; onWorld: (world: GameWorld) => void;
}
const statuses = {
  ready: "ff.status.ready", running: "ff.status.running", paused_decision: "ff.status.paused_decision", segment_limit: "ff.status.segment_limit",
  completed: "ff.status.completed", cancelled: "ff.status.cancelled", interrupted: "ff.status.interrupted", failed: "ff.status.failed",
} as const satisfies Record<FastForwardJob["status"], FastForwardMessageKey>;
const scopeOf = (world: GameWorld) => JSON.stringify([world.setup.worldId, world.branchId, world.headTurnId, world.state.protocolVersion]);
function formatMoment(moment: CalendarMoment): string {
  return t("ff.date", { era: t(moment.date.eraYear < 0 ? "ff.bc" : "ff.ad"), year: Math.abs(moment.date.eraYear), month: moment.date.month, day: moment.date.day,
    hour: String(moment.hour).padStart(2, "0"), minute: String(moment.minute).padStart(2, "0"), second: String(moment.second).padStart(2, "0") });
}
export default function GameFastForward({ world, busy, archived, branchesEnabled, providerKind, providerConfigured, beginWrite, endWrite, onWorld }: GameFastForwardProps) {
  const id = useId(); const enabled = hasGameCore() && world.state.protocolVersion === 2; const scope = scopeOf(world);
  const scopeRef = useRef(scope); scopeRef.current = scope; const mounted = useRef(false); const readingRef = useRef(0); const writingRef = useRef(false);
  const callback = useRef(onWorld); callback.current = onWorld;
  const activeRef = useRef<string | null>(null);
  const [jobs, setJobs] = useState<FastForwardJob[]>([]); const [reading, setReading] = useState(false); const [writing, setWriting] = useState(false);
  const [days, setDays] = useState("365"); const [segmentDays, setSegmentDays] = useState("30"); const [focus, setFocus] = useState("");
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [calendar, setCalendar] = useState<GameCalendar | null>(null);
  const [localStage, setLocalStage] = useState<{ scope: string; operationId: string; jobId: string } | null>(null);
  const [cancelState, setCancelState] = useState<"idle" | "requesting" | "requested" | "unknown">("idle");
  const stillCurrent = (frozen: string) => mounted.current && scopeRef.current === frozen;
  const canWrite = enabled && branchesEnabled && !archived && !busy && !writing && !reading;
  const currentStage = localStage?.scope === scope ? localStage : null;
  const activeJob = jobs.find(job => job.status === "running");
  const activeOperation = currentStage?.operationId ?? activeJob?.activeOperationId ?? null; activeRef.current = activeOperation;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readingRef.current++; }; }, []);
  useEffect(() => {
    const revision = ++readingRef.current; setJobs([]); setCalendar(null); setError(null); setNotice(null); setCancelState("idle"); setReading(enabled);
    if (!enabled) return;
    void listGameFastForward(world.setup.worldId, world.branchId).then(incoming => { if (stillCurrent(scope) && readingRef.current === revision) setJobs(incoming); })
      .catch((cause: unknown) => { if (stillCurrent(scope) && readingRef.current === revision) setError(describeFastForwardError(cause)); })
      .finally(() => { if (stillCurrent(scope) && readingRef.current === revision) setReading(false); });
    void getGameCalendar(world.setup.worldId, world.branchId, world.headTurnId).then(incoming => { if (stillCurrent(scope) && readingRef.current === revision) setCalendar(incoming); }).catch(() => {});
  }, [scope, enabled]);
  async function refresh() {
    if (!enabled || reading) return;
    const revision = ++readingRef.current; const frozen = scope; setReading(true); setError(null);
    try { const incoming = await listGameFastForward(world.setup.worldId, world.branchId); if (stillCurrent(frozen) && readingRef.current === revision) { setJobs(incoming); if (!incoming.some(job => job.status === "running")) { setCancelState("idle"); setNotice(null); } } }
    catch (cause) { if (stillCurrent(frozen) && readingRef.current === revision) setError(describeFastForwardError(cause)); }
    finally { if (stillCurrent(frozen) && readingRef.current === revision) setReading(false); }
  }
  function upsert(incoming: FastForwardJob) { setJobs(previous => [incoming, ...previous.filter(job => job.jobId !== incoming.jobId)].sort((a, b) => b.createdAtMs - a.createdAtMs)); }
  async function write(work: (frozen: string) => Promise<void>, stage: { operationId: string; jobId: string } | null = null) {
    if (!canWrite || writingRef.current) return;
    if (!beginWrite()) { setError(t("ff.error.busy")); return; }
    const frozen = scope; writingRef.current = true; setWriting(true); setError(null); setNotice(null); readingRef.current++; setReading(false); setCancelState("idle");
    if (stage) { setLocalStage({ ...stage, scope: frozen }); activeRef.current = stage.operationId; }
    try { await work(frozen); }
    catch (cause) {
      if (stillCurrent(frozen)) {
        if (cause instanceof FastForwardError && cause.code === "game_cancelled") { setError(null); setNotice(t("ff.cancelled")); }
        else setError(describeFastForwardError(cause));
        try { const incoming = await listGameFastForward(world.setup.worldId, world.branchId); if (stillCurrent(frozen)) { setJobs(incoming); if (!incoming.some(job => job.status === "running")) activeRef.current = null; } } catch { /* A failed read does not confirm a lost request. */ }
      }
    } finally { writingRef.current = false; if (mounted.current) { setWriting(false); setLocalStage(null); } endWrite(); }
  }
  function start() {
    const span = Number(days), cap = Number(segmentDays); const target = world.state.time.elapsedSeconds + span * 86400;
    if (!/^\d+$/.test(days.trim()) || !/^\d+$/.test(segmentDays.trim()) || !Number.isSafeInteger(span) || span < 1 || !Number.isSafeInteger(cap) || cap < 1
      || !Number.isSafeInteger(target) || !Number.isSafeInteger(cap * 86400) || new TextEncoder().encode(focus).length > 4096) { setError(t("ff.invalid")); return; }
    void write(async frozen => {
      const job = await startGameFastForward({ worldId: world.setup.worldId, branchId: world.branchId, jobId: crypto.randomUUID(), expectedHeadTurnId: world.headTurnId, targetElapsedSeconds: target, maxSegmentSeconds: cap * 86400, focus });
      if (stillCurrent(frozen)) { readingRef.current++; setReading(false); upsert(job); setNotice(t("ff.saved")); }
    });
  }
  function next(job: FastForwardJob) {
    const operationId = crypto.randomUUID();
    void write(async frozen => {
      const result = await continueGameFastForward({ worldId: world.setup.worldId, branchId: world.branchId, jobId: job.jobId, operationId, expectedHeadTurnId: world.headTurnId, expectedJobRevision: job.revision }, providerKind);
      if (stillCurrent(frozen)) { activeRef.current = null; readingRef.current++; setReading(false); upsert(result.job); setNotice(t("ff.segmentSaved")); callback.current(result.world); }
    }, { operationId, jobId: job.jobId });
  }
  function resume(job: FastForwardJob) {
    if (!world.headTurnId) return; const decisionTurnId = world.headTurnId;
    void write(async frozen => {
      const incoming = await resumeGameFastForward({ worldId: world.setup.worldId, branchId: world.branchId, jobId: job.jobId, decisionTurnId, expectedJobRevision: job.revision });
      if (stillCurrent(frozen)) { readingRef.current++; setReading(false); upsert(incoming); setNotice(t("ff.resumed")); }
    });
  }
  function cancelJob(job: FastForwardJob) {
    void write(async frozen => {
      const incoming = await cancelGameFastForward(world.setup.worldId, world.branchId, job.jobId, job.revision);
      if (stillCurrent(frozen)) { readingRef.current++; setReading(false); upsert(incoming); setNotice(t("ff.cancelled")); }
    });
  }
  async function cancelStage() {
    if (!enabled || !activeOperation || cancelState === "requesting" || cancelState === "requested") return;
    const operationId = activeOperation, frozen = scope; setCancelState("requesting");
    try {
      const result = await cancelGameTurn(operationId);
      if (stillCurrent(frozen) && activeRef.current === operationId) { setCancelState(result.state === "not_found" ? "unknown" : "requested"); setNotice(t(result.state === "not_found" ? "ff.cancelUnknown" : "ff.cancelRequested")); }
    } catch { if (stillCurrent(frozen) && activeRef.current === operationId) { setCancelState("unknown"); setNotice(t("ff.cancelUnknown")); } }
  }
  return <section className="game-fast-forward" aria-labelledby={`${id}-heading`}>
    <div className="game-section-top"><h2 id={`${id}-heading`}>{t("ff.heading")}</h2><button type="button" className="game-secondary" disabled={!enabled || reading} onClick={() => void refresh()}>{t(reading ? "ff.loading" : "ff.read")}</button></div>
    <p className="game-muted game-small">{t("ff.help")}</p>
    {!hasGameCore() && <p className="game-notice">{t("ff.unavailable")}</p>}{!branchesEnabled && <p className="game-notice">{t("ff.enableFirst")}</p>}{archived && <p className="game-notice">{t("ff.archived")}</p>}
    <p className="game-muted game-small">{calendar ? t("ff.calendarRange", { earliest: formatMoment(calendar.calendarRange.earliest), latest: formatMoment(calendar.calendarRange.latest) }) : t("ff.calendarUnknown")}<br />{t("ff.calendarHelp")}<br />
      {calendar?.age ? t("ff.age", { minimum: calendar.age.minimumYears, maximum: calendar.age.maximumYears }) : t("ff.ageUnknown")}{calendar?.age?.mayNotBeBornYet && ` ${t("ff.notBorn")}`}</p>
    <div aria-live="polite">{error && <p className="game-error" role="alert">{error}</p>}{notice && <p className="game-notice" role="status">{notice}</p>}</div>
    <div className="game-fast-forward-grid"><label htmlFor={`${id}-days`}>{t("ff.days")}<input id={`${id}-days`} value={days} maxLength={12} inputMode="numeric" disabled={!canWrite} onChange={event => setDays(event.target.value)} /></label>
      <label htmlFor={`${id}-cap`}>{t("ff.segmentDays")}<input id={`${id}-cap`} value={segmentDays} maxLength={12} inputMode="numeric" disabled={!canWrite} onChange={event => setSegmentDays(event.target.value)} /></label></div>
    <label htmlFor={`${id}-focus`}>{t("ff.focus")}</label><textarea id={`${id}-focus`} rows={2} value={focus} maxLength={4096} placeholder={t("ff.focusPlaceholder")} disabled={!canWrite} onChange={event => setFocus(event.target.value)} />
    <p className="game-muted game-small">{t(providerKind === "demo" ? "ff.providerDemo" : "ff.providerCompatible")}</p><button type="button" className="game-secondary" disabled={!canWrite} onClick={start}>{t(writing ? "ff.working" : "ff.create")}</button>
    {activeOperation && <div className="game-actions"><button type="button" className="game-secondary game-danger" disabled={!enabled || cancelState === "requesting" || cancelState === "requested"} onClick={() => void cancelStage()}>{t("ff.cancelStage")}</button></div>}
    {!reading && !jobs.length && <p className="game-muted game-small">{t("ff.none")}</p>}
    {jobs.map(job => {
      const elapsed = job.elapsedSeconds - job.startElapsedSeconds;
      const currentHead = job.headTurnId === world.headTurnId && job.elapsedSeconds === world.state.time.elapsedSeconds;
      const canContinue = currentHead && job.decision === null && ["ready", "segment_limit", "interrupted", "cancelled", "failed"].includes(job.status);
      const decisionTurn = world.turns.find(turn => turn.turnId === world.headTurnId);
      const canResume = job.decision !== null && decisionTurn?.parentTurnId === job.headTurnId && decisionTurn.actionKind === "action";
      return <article className={`game-fast-forward-job game-fast-forward-job--${job.status}`} key={job.jobId}>
        <strong>{t(statuses[currentStage?.jobId === job.jobId ? "running" : job.status])}</strong>
        <p className="game-muted game-small">{t("ff.target", { start: job.startElapsedSeconds, target: job.targetElapsedSeconds })}<br />{t("ff.progress", { days: Math.floor(elapsed / 86400), hours: Math.floor(elapsed % 86400 / 3600), minutes: Math.floor(elapsed % 3600 / 60), segments: job.segmentsCommitted })}<br />{t("ff.cap", { days: job.maxSegmentSeconds / 86400 })}</p>
        {job.focus && <p className="game-fast-forward-focus">{job.focus}</p>}<p className="game-muted game-small">{t("ff.calls", { count: job.modelRequestsReserved })}</p>
        {job.decision && <><p className="game-fast-forward-focus">{job.decision.prompt}</p><p className="game-notice">{t("ff.decisionHelp")}</p></>}
        {job.status === "failed" && <p className="game-error">{t("ff.failed")}</p>}{!currentHead && !job.decision && job.status !== "completed" && <p className="game-muted game-small">{t("ff.stale")}</p>}
        <div className="game-actions">{job.decision ? <button type="button" className="game-secondary" disabled={!canWrite || !canResume} onClick={() => resume(job)}>{t("ff.resume")}</button>
          : <button type="button" className="game-secondary" disabled={!canWrite || !canContinue || (providerKind === "compatible" && !providerConfigured)} onClick={() => next(job)}>{t("ff.continue")}</button>}
          <button type="button" className="game-secondary game-danger" disabled={!canWrite || ["running", "completed", "cancelled"].includes(job.status)} onClick={() => cancelJob(job)}>{t("ff.cancelJob")}</button></div>
        {canContinue && <p className="game-muted game-small">{t("ff.continueHelp")}</p>}
      </article>;
    })}
  </section>;
}
