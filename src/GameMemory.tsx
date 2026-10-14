import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cancelGameTurn, hasGameCore, type ActorObservedFact, type FactKey, type GameActorView,
  type GameWorld, type HoldingValue, type ObservedCondition, type ObservedRelationship,
  type ObservedResource, type ProviderKind } from "./gameClient";
import { bookmarkGameTurn, createGameSummary, describeMemoryError, getGameAnnotations, getGameContextTrace,
  pinGameFact, queryGameMemory, removeGameAnnotation, type AnnotationEnvelope,
  type GameContextTrace, type MemoryEnvelope, type MemoryQuery, type SummaryOperation, type SummaryUsage } from "./gameMemoryClient";
import { memoryT as t, type MemoryMessageKey, type MemoryPlainMessageKey } from "./gameMemoryMessages";
import "./gameMemory.css";

export interface GameMemoryProps {
  world: GameWorld; actorView: GameActorView | null; busy: boolean;
  beginWrite: () => boolean; endWrite: () => void;
}
interface FactOption { key: FactKey; value: string; label: string }
interface LocalWrite { scope: string; kind: "pin" | "bookmark" | "remove" | "summary"; operationId: string | null }
type CancelState = "idle" | "requesting" | "requested" | "unknown";
const statuses = {
  pending: "memory.status.pending", running: "memory.status.running", deferred: "memory.status.deferred",
  completed: "memory.status.completed", failed: "memory.status.failed", cancelled: "memory.status.cancelled",
  interrupted: "memory.status.interrupted",
} as const satisfies Record<SummaryOperation["status"], MemoryMessageKey>;
const failures = {
  network: "memory.summaryFailure.network", timeout: "memory.summaryFailure.timeout",
  invalid_output: "memory.summaryFailure.invalid_output", provider_rejected: "memory.summaryFailure.provider_rejected",
  budget: "memory.summaryFailure.budget", cancelled: "memory.summaryFailure.cancelled",
  process_interrupted: "memory.summaryFailure.process_interrupted", manual: "memory.summaryFailure.manual",
} as const;
const attempts = {
  reserved: "memory.summaryAttempt.reserved", completed: "memory.summaryAttempt.completed",
  failed: "memory.summaryAttempt.failed", cancelled: "memory.summaryAttempt.cancelled",
  interrupted: "memory.summaryAttempt.interrupted",
} as const;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const scopeOf = (world: GameWorld) => JSON.stringify([world.setup.worldId, world.branchId, world.headTurnId, world.state.protocolVersion]);
const factId = (fact: FactKey) => JSON.stringify(fact);
const numberOrUnknown = (value: number | null) => value === null ? t("memory.summaryUnknown") : value.toLocaleString("zh-CN");

function factOptions(view: GameActorView | null): FactOption[] {
  if (!view) return [];
  const names = new Map(view.entities.map((entity) => [entity.entityId, entity.name]));
  const nameOf = (id: string | null) => id === null ? t("memory.summaryUnknown") : names.get(id) ?? t("memory.factUnknownName");
  const describe = ({ factKey: fact, value }: ActorObservedFact): string => {
    switch (fact.type) {
      case "entity_created": return nameOf(fact.entityId);
      case "entity_name": return String(value);
      case "entity_life": return `${nameOf(fact.entityId)}：${t(value === true ? "memory.fact.alive" : "memory.fact.dead")}`;
      case "entity_attribute": return `${nameOf(fact.entityId)} · ${fact.key}：${String(value)}`;
      case "entity_alias": return `${nameOf(fact.entityId)} · ${fact.text}`;
      case "item_holding": {
        const holding = value as HoldingValue;
        return t("memory.factHolding", { item: nameOf(fact.itemId), quantity: numberOrUnknown(holding.quantity),
          unit: holding.unit ?? "", holder: nameOf(holding.holderId), place: nameOf(holding.placeId) });
      }
      case "condition": {
        const condition = value as ObservedCondition;
        return t("memory.factCondition", { person: nameOf(condition.entityId), description: condition.description,
          status: t(condition.active ? "memory.factActive" : "memory.factResolved") });
      }
      case "resource": {
        const resource = value as ObservedResource;
        return `${nameOf(resource.ownerId)} · ${resource.key}：${numberOrUnknown(resource.amount)} ${resource.unit}`;
      }
      case "relationship": {
        const relation = value as ObservedRelationship;
        return `${nameOf(relation.fromId)} → ${nameOf(relation.toId)} · ${relation.kind}：${relation.strength}`;
      }
      case "event": return (value as { description: string }).description;
      case "claim": return (value as { text: string }).text;
      case "location": return nameOf(String(value));
      case "time": {
        const clock = value as { eraYear: number; elapsedSeconds: number };
        return t("memory.factTime", { year: clock.eraYear, seconds: clock.elapsedSeconds });
      }
    }
  };
  const options = view.observedFacts.map((fact) => ({ key: fact.factKey, value: factId(fact.factKey),
    label: `${t(`memory.fact.${fact.factKey.type}`)}：${describe(fact)}` }));
  for (const known of view.knowledge) {
    const key: FactKey = known.targetType === "event" ? { type: "event", eventId: known.targetId } : { type: "claim", claimId: known.targetId };
    if (!options.some((option) => option.value === factId(key))) options.push({ key, value: factId(key), label: `${t(`memory.fact.${key.type}`)}：${known.text}` });
  }
  return options;
}

function UsageDetails({ usage }: { usage: SummaryUsage }) {
  return <dl className="game-memory-meta">
    <div><dt>{t("memory.summaryTokens")}</dt><dd>{numberOrUnknown(usage.inputTokens)} / {numberOrUnknown(usage.outputTokens)} / {numberOrUnknown(usage.totalTokens)}</dd></div>
    <div><dt>{t("memory.summaryCost")}</dt><dd>{usage.costMicrounits === null ? t("memory.summaryUnknown")
      : `${usage.costMicrounits / 1_000_000} ${usage.currency} · ${t(usage.costKind === "actual" ? "memory.summaryActual" : "memory.summaryEstimate")}`}</dd></div>
  </dl>;
}

function SummaryCard({ summary, rebuildDisabled, onRebuild }: { summary: SummaryOperation; rebuildDisabled: boolean; onRebuild: () => void }) {
  const first = summary.sources[0].sequence;
  const last = summary.sources[summary.sources.length - 1].sequence;
  const local = summary.plan.provider === "local-extract-v1" && summary.plan.model === "local-extract-v1" && summary.modelRequestsReserved === 0;
  return <article className={`game-memory-card game-memory-summary game-memory-summary--${summary.status}`}>
    <div className="game-memory-card-top"><strong>{t("memory.summaryRange", { first, last, count: summary.sources.length })}</strong><span>{t(statuses[summary.status])}</span></div>
    {summary.body !== null && <p className="game-memory-body">{summary.body}</p>}
    {summary.failure !== null && <p className="game-muted game-small">{t(failures[summary.failure])}</p>}
    <p className="game-muted game-small">{local ? t("memory.summaryExcerpt") : t("memory.summaryCalls", { count: summary.modelRequestsReserved })}</p>
    <details><summary>{t("memory.summaryDetails")}</summary>
      <dl className="game-memory-meta"><div><dt>{t("memory.summaryModel")}</dt><dd>{summary.plan.provider} / {summary.plan.model}</dd></div>
        <div><dt>{t("memory.summaryVersion")}</dt><dd>{summary.plan.promptVersion}</dd></div></dl>
      <ul className="game-memory-sources">{summary.sources.map((source) => <li key={source.turnId}>
        {t("memory.turn", { sequence: source.sequence })}<small>{t("memory.sourceId", { id: source.turnId })}</small>
        <small>{t("memory.sourceHash")}：<code>{source.narrativeSha256}</code></small>
      </li>)}</ul>
      {summary.attempts.map((attempt) => <div className="game-memory-attempt" key={attempt.attemptNumber}>
        <strong>{t("memory.summaryAttempt", { number: attempt.attemptNumber })} · {t(attempts[attempt.status])}</strong>
        <UsageDetails usage={attempt.usage} />
      </div>)}
    </details>
    <button type="button" className="game-secondary" disabled={rebuildDisabled} onClick={onRebuild}>{t("memory.summaryRebuild")}</button>
  </article>;
}

export function GameMemory({ world, actorView, busy, beginWrite, endWrite }: GameMemoryProps) {
  const id = useId();
  const native = hasGameCore();
  const enabled = native && world.state.protocolVersion === 2;
  const scope = scopeOf(world);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const mounted = useRef(false);
  const readRevision = useRef(0);
  const searchRevision = useRef(0);
  const traceRevision = useRef(0);
  const currentTraceKey = useRef("");
  const writeRef = useRef<LocalWrite | null>(null);
  const activeSummaryRef = useRef<string | null>(null);
  const [annotations, setAnnotations] = useState<AnnotationEnvelope | null>(null);
  const [reading, setReading] = useState(false);
  const [memory, setMemory] = useState<MemoryEnvelope | null>(null);
  const [query, setQuery] = useState("");
  const [entityId, setEntityId] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<MemoryQuery | null>(null);
  const [searching, setSearching] = useState(false);
  const [bookmarkLabel, setBookmarkLabel] = useState("");
  const [factFilter, setFactFilter] = useState("");
  const [selectedFact, setSelectedFact] = useState("");
  const [provider, setProvider] = useState<ProviderKind>("demo");
  const [writing, setWriting] = useState<LocalWrite | null>(null);
  const [cancelState, setCancelState] = useState<CancelState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [contextTrace, setContextTrace] = useState<GameContextTrace | null>(null);
  const [traceRead, setTraceRead] = useState(false);
  const [traceLoading, setTraceLoading] = useState(false);
  const traceKey = JSON.stringify([scope, world.latestOperation?.operationId, world.latestOperation?.status]);
  currentTraceKey.current = traceKey;
  const stillCurrent = (frozenScope: string) => mounted.current && currentScope.current === frozenScope;
  const matches = (value: { worldId: string; branchId: string; headTurnId: string | null }) =>
    value.worldId === world.setup.worldId && value.branchId === world.branchId && value.headTurnId === world.headTurnId;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readRevision.current++; searchRevision.current++; traceRevision.current++; }; }, []);
  useEffect(() => { traceRevision.current++; setContextTrace(null); setTraceRead(false); setTraceLoading(false); }, [traceKey]);
  useEffect(() => {
    const revision = ++readRevision.current;
    searchRevision.current++;
    setAnnotations(null); setMemory(null); setSubmittedQuery(null); setSearching(false);
    setEntityId(""); setSelectedFact(""); setFactFilter(""); setError(null); setNotice(null); setCancelState("idle");
    setReading(enabled);
    if (!enabled) return;
    void getGameAnnotations(world.setup.worldId, world.headTurnId).then((incoming) => {
      if (stillCurrent(scope) && readRevision.current === revision && matches(incoming)) setAnnotations(incoming);
    }).catch((cause: unknown) => {
      if (stillCurrent(scope) && readRevision.current === revision) setError(describeMemoryError(cause));
    }).finally(() => {
      if (stillCurrent(scope) && readRevision.current === revision) setReading(false);
    });
  }, [scope, enabled]);

  const view = actorView?.worldId === world.setup.worldId && actorView.headTurnId === world.headTurnId && actorView.actorId === world.state.protagonistId ? actorView : null;
  const facts = useMemo(() => factOptions(view), [view]);
  const factMap = new Map(facts.map((option) => [option.value, option]));
  const filteredFacts = facts.filter((option) => option.label.toLocaleLowerCase("zh-CN").includes(factFilter.trim().toLocaleLowerCase("zh-CN")));
  const visibleFacts = filteredFacts.slice(0, 256);
  const chosenFact = visibleFacts.find((option) => option.value === selectedFact) ?? visibleFacts[0] ?? null;
  const currentAnnotations = annotations && matches(annotations) ? annotations : null;
  const currentMemory = memory && matches(memory) ? memory : null;
  const currentWrite = writing?.scope === scope ? writing : null;
  const summaries = new Map(currentAnnotations?.annotations.summaries.map((summary) => [summary.plan.operationId, summary]) ?? []);
  for (const operation of currentAnnotations?.operations ?? []) summaries.set(operation.plan.operationId, operation);
  const summaryList = [...summaries.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const persistedActive = summaryList.find((summary) => summary.status === "pending" || summary.status === "running");
  const activeSummaryId = currentWrite?.kind === "summary" ? currentWrite.operationId : persistedActive?.plan.operationId ?? null;
  activeSummaryRef.current = activeSummaryId;
  const cannotWrite = !enabled || busy || currentWrite !== null || reading || persistedActive !== undefined;
  const recentTurns = world.turns.slice(-10);
  const firstSequence = world.turnCount - recentTurns.length + 1;
  const sequenceOf = (turnId: string) => {
    const index = world.turns.findIndex((turn) => turn.turnId === turnId);
    return index < 0 ? null : world.turnCount - world.turns.length + index + 1;
  };

  async function refreshAnnotations() {
    if (!enabled || reading) return;
    const frozenScope = scope;
    const revision = ++readRevision.current;
    setReading(true); setError(null);
    try {
      const incoming = await getGameAnnotations(world.setup.worldId, world.headTurnId);
      if (stillCurrent(frozenScope) && readRevision.current === revision && matches(incoming)) {
        setAnnotations(incoming);
        if (!incoming.operations.some((operation) => operation.status === "pending" || operation.status === "running")) {
          setCancelState("idle"); setNotice(null);
        }
      }
    } catch (cause) { if (stillCurrent(frozenScope) && readRevision.current === revision) setError(describeMemoryError(cause)); }
    finally { if (stillCurrent(frozenScope) && readRevision.current === revision) setReading(false); }
  }

  async function readContextTrace() {
    const operation = world.latestOperation;
    if (!enabled || !operation || traceLoading || busy) return;
    const frozenScope = scope;
    const frozenTraceKey = traceKey;
    const revision = ++traceRevision.current;
    setTraceLoading(true); setError(null);
    try {
      const incoming = await getGameContextTrace(world.setup.worldId, operation.operationId, operation.expectedHeadTurnId);
      if (stillCurrent(frozenScope) && currentTraceKey.current === frozenTraceKey && traceRevision.current === revision) {
        if (incoming === null || incoming.branchId === world.branchId) { setContextTrace(incoming); setTraceRead(true); }
      }
    } catch (cause) {
      if (stillCurrent(frozenScope) && currentTraceKey.current === frozenTraceKey && traceRevision.current === revision) setError(describeMemoryError(cause));
    } finally {
      if (stillCurrent(frozenScope) && currentTraceKey.current === frozenTraceKey && traceRevision.current === revision) setTraceLoading(false);
    }
  }

  async function search(nextPage = false) {
    if (!enabled || searching || busy || writeRef.current) return;
    const request: MemoryQuery = nextPage && submittedQuery && currentMemory?.page.nextCursor
      ? { ...submittedQuery, cursor: currentMemory.page.nextCursor }
      : { query: query.trim(), entityIds: entityId ? [entityId] : [], tags: [], minElapsedSeconds: null, maxElapsedSeconds: null, maxResults: 12, cursor: null };
    if (bytes(request.query) > 256) { setError(t("memory.queryLimit")); return; }
    const frozenScope = scope;
    const revision = ++searchRevision.current;
    setSearching(true); setError(null); setNotice(null);
    try {
      const incoming = await queryGameMemory(world.setup.worldId, world.headTurnId, request);
      if (stillCurrent(frozenScope) && searchRevision.current === revision && matches(incoming)) {
        setMemory(incoming); setSubmittedQuery(request);
      }
    } catch (cause) { if (stillCurrent(frozenScope) && searchRevision.current === revision) setError(describeMemoryError(cause)); }
    finally { if (stillCurrent(frozenScope) && searchRevision.current === revision) setSearching(false); }
  }

  async function mutate(kind: LocalWrite["kind"], request: () => Promise<AnnotationEnvelope>, message: MemoryPlainMessageKey, operationId: string | null = null) {
    if (cannotWrite || writeRef.current) return;
    if (!beginWrite()) { setError(t("memory.error.busy")); return; }
    const reservation: LocalWrite = { scope, kind, operationId };
    writeRef.current = reservation; setWriting(reservation); setCancelState("idle"); setError(null); setNotice(null);
    // A read started before this write cannot replace its committed result.
    readRevision.current++; setReading(false);
    try {
      const incoming = await request();
      if (stillCurrent(reservation.scope) && matches(incoming)) {
        if (reservation.kind === "summary" && !incoming.operations.some((operation) => operation.plan.operationId === reservation.operationId && (operation.status === "pending" || operation.status === "running"))) activeSummaryRef.current = null;
        readRevision.current++; setReading(false); setAnnotations(incoming); setNotice(t(message));
      }
    } catch (cause) { if (stillCurrent(reservation.scope)) setError(describeMemoryError(cause)); }
    finally {
      if (writeRef.current === reservation) { writeRef.current = null; if (mounted.current) setWriting(null); }
      endWrite();
    }
  }

  function saveBookmark(turnId: string, sequence: number) {
    const label = bookmarkLabel.trim() || t("memory.bookmarkDefault", { sequence });
    if (bytes(label) > 2048) { setError(t("memory.bookmarkTooLong")); return; }
    void mutate("bookmark", () => bookmarkGameTurn(world.setup.worldId, world.headTurnId, turnId, label), "memory.bookmarkSaved");
  }
  function makeSummary(sourceTurnIds: string[]) {
    if (!sourceTurnIds.length) return;
    if (sourceTurnIds.length > 512) { setError(t("memory.error.large")); return; }
    const operationId = crypto.randomUUID();
    void mutate("summary", () => createGameSummary(world.setup.worldId, world.headTurnId, operationId, sourceTurnIds, provider), "memory.summaryCreated", operationId);
  }
  async function cancelSummary() {
    if (!enabled || !activeSummaryId || cancelState === "requesting" || cancelState === "requested") return;
    const frozenScope = scope;
    const operationId = activeSummaryId;
    setCancelState("requesting"); setError(null);
    try {
      const result = await cancelGameTurn(operationId);
      if (!stillCurrent(frozenScope) || activeSummaryRef.current !== operationId) return;
      if (result.state === "not_found") { setCancelState("unknown"); setNotice(t("memory.summaryUnknownCancel")); }
      else { setCancelState("requested"); setNotice(t("memory.summaryCancelRequested")); }
    } catch { if (stillCurrent(frozenScope)) { setCancelState("unknown"); setNotice(t("memory.summaryUnknownCancel")); } }
  }

  return <section className="game-memory" aria-labelledby={`${id}-heading`}>
    <div className="game-section-top"><h2 id={`${id}-heading`}>{t("memory.heading")}</h2>
      <button type="button" className="game-secondary" disabled={!enabled || reading || (busy && currentWrite?.kind !== "summary")}
        onClick={() => void refreshAnnotations()}>{t(reading ? "memory.loading" : "memory.refresh")}</button></div>
    <p className="game-muted game-small">{t("memory.help")}</p>
    {!native && <p className="game-notice">{t("memory.unavailable")}</p>}
    {world.state.protocolVersion === 1 && <p className="game-notice">{t("memory.legacy")}</p>}
    <div aria-live="polite">{error && <p className="game-error" role="alert">{error}</p>}{notice && <p className="game-notice" role="status">{notice}</p>}</div>

    <details className="game-memory-section" open><summary>{t("memory.query")}</summary>
      <p className="game-muted game-small" id={`${id}-query-help`}>{t("memory.queryHelp")}</p>
      <form onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <label htmlFor={`${id}-query`}>{t("memory.query")}</label>
        <input id={`${id}-query`} value={query} maxLength={256} placeholder={t("memory.queryPlaceholder")} disabled={!enabled || searching || busy}
          aria-describedby={`${id}-query-help`} onChange={(event) => setQuery(event.target.value)} />
        <label htmlFor={`${id}-entity`}>{t("memory.queryEntity")}</label>
        <select id={`${id}-entity`} value={entityId} disabled={!enabled || searching || busy || !view} onChange={(event) => setEntityId(event.target.value)}>
          <option value="">{t("memory.queryAllEntities")}</option>
          {view?.entities.filter((entity) => entity.name !== null).map((entity) => <option key={entity.entityId} value={entity.entityId}>{entity.name}</option>)}
        </select>
        <div className="game-actions"><button type="submit" className="game-secondary" disabled={!enabled || searching || busy}>{t(searching ? "memory.searching" : "memory.search")}</button></div>
      </form>
      {currentMemory && <div className="game-memory-results">
        <p className="game-muted game-small">{t("memory.references")}</p>
        {!currentMemory.page.fragments.length && <p className="game-muted game-small">{t("memory.searchEmpty")}</p>}
        {currentMemory.page.fragments.length > 0 && <label htmlFor={`${id}-bookmark-label`}>{t("memory.bookmarkLabel")}
          <input id={`${id}-bookmark-label`} value={bookmarkLabel} maxLength={2048} disabled={cannotWrite} onChange={(event) => setBookmarkLabel(event.target.value)} /></label>}
        {currentMemory.page.fragments.map((fragment) => <article className="game-memory-card" key={`${fragment.source.turnId}:${fragment.source.byteStart}`}>
          <strong>{t("memory.turn", { sequence: fragment.source.sequence })}</strong><p className="game-memory-body">{fragment.text}</p>
          <details><summary>{t("memory.sourceDetails")}</summary><p className="game-muted game-small">{t("memory.sourceId", { id: fragment.source.turnId })}<br />
            {t("memory.sourceOrigin", { branch: fragment.source.originBranchId })}<br />{t("memory.sourceRange", { start: fragment.source.byteStart, end: fragment.source.byteEnd })}<br />
            {t("memory.sourceHash")}：<code>{fragment.source.narrativeSha256}</code></p></details>
          <button type="button" className="game-secondary" disabled={cannotWrite} onClick={() => saveBookmark(fragment.source.turnId, fragment.source.sequence)}>{t("memory.bookmark")}</button>
        </article>)}
        {currentMemory.page.candidateWindowExhausted && <p className="game-muted game-small">{t("memory.searchWindow")}</p>}
        {currentMemory.page.nextCursor && <button type="button" className="game-secondary" disabled={!enabled || searching || busy} onClick={() => void search(true)}>{t("memory.more")}</button>}
      </div>}
    </details>

    <details className="game-memory-section"><summary>{t("memory.pinHeading")}</summary>
      <p className="game-muted game-small">{t("memory.pinHelp")}</p>
      {!view && <p className="game-muted game-small">{t("memory.factsWaiting")}</p>}
      <label htmlFor={`${id}-fact-filter`}>{t("memory.factFilter")}</label><input id={`${id}-fact-filter`} value={factFilter} placeholder={t("memory.factFilterPlaceholder")}
        disabled={!enabled || !view || busy} onChange={(event) => { setFactFilter(event.target.value); setSelectedFact(""); }} />
      <label htmlFor={`${id}-fact`}>{t("memory.pinSelect")}</label><select id={`${id}-fact`} value={chosenFact?.value ?? ""}
        disabled={cannotWrite || !chosenFact} onChange={(event) => setSelectedFact(event.target.value)}>
        {visibleFacts.length ? visibleFacts.map((option) => <option key={option.value} value={option.value}>{option.label}</option>) : <option value="">{t("memory.factsNone")}</option>}
      </select>
      {filteredFacts.length > visibleFacts.length && <p className="game-muted game-small">{t("memory.factsLimited", { count: visibleFacts.length })}</p>}
      <button type="button" className="game-secondary game-memory-spaced" disabled={cannotWrite || !chosenFact}
        onClick={() => { if (chosenFact) void mutate("pin", () => pinGameFact(world.setup.worldId, world.headTurnId, chosenFact.key), "memory.pinSaved"); }}>{t(currentWrite?.kind === "pin" ? "memory.working" : "memory.pin")}</button>
      {currentAnnotations ? currentAnnotations.annotations.pins.length ? <ul className="game-memory-list">{currentAnnotations.annotations.pins.map((pin) => <li key={pin.id}>
        <div><span>{factMap.get(factId(pin.factKey))?.label ?? t("memory.factReference", { key: factId(pin.factKey) })}</span>
          <small>{t("memory.sourceNode", { id: pin.createdHeadTurnId ?? t("memory.initialNode") })}</small></div>
        <button type="button" className="game-secondary game-danger" disabled={cannotWrite} onClick={() => void mutate("remove", () => removeGameAnnotation(world.setup.worldId, world.headTurnId, pin.id), "memory.removed")}>{t("memory.remove")}</button>
      </li>)}</ul> : <p className="game-muted game-small">{t("memory.pinsEmpty")}</p> : <p className="game-muted game-small">{t("memory.annotationsWaiting")}</p>}
    </details>

    <details className="game-memory-section"><summary>{t("memory.bookmarksHeading")}</summary>
      {currentAnnotations ? currentAnnotations.annotations.bookmarks.length ? <ul className="game-memory-list">{currentAnnotations.annotations.bookmarks.map((bookmark) => {
        const sequence = sequenceOf(bookmark.turnId);
        const original = world.turns.find((turn) => turn.turnId === bookmark.turnId);
        return <li key={bookmark.id}><div><span>{bookmark.label || (sequence === null ? t("memory.sourceId", { id: bookmark.turnId }) : t("memory.turn", { sequence }))}</span>
          <small>{t("memory.sourceId", { id: bookmark.turnId })}</small>
          {original && <details><summary>{t("memory.original")}</summary><p className="game-memory-body">{original.narrative}</p></details>}</div>
          <button type="button" className="game-secondary game-danger" disabled={cannotWrite} onClick={() => void mutate("remove", () => removeGameAnnotation(world.setup.worldId, world.headTurnId, bookmark.id), "memory.removed")}>{t("memory.remove")}</button></li>;
      })}</ul> : <p className="game-muted game-small">{t("memory.bookmarksEmpty")}</p> : <p className="game-muted game-small">{t("memory.annotationsWaiting")}</p>}
    </details>

    <details className="game-memory-section"><summary>{t("memory.summaryHeading")}</summary>
      <p className="game-muted game-small">{t("memory.summaryHelp")}</p>
      <p className="game-muted game-small">{recentTurns.length ? t("memory.summaryRange", { first: firstSequence, last: world.turnCount, count: recentTurns.length }) : t("memory.summaryEmptyRange")}</p>
      <label htmlFor={`${id}-summary-provider`}>{t("memory.summaryProvider")}</label><select id={`${id}-summary-provider`} value={provider} disabled={cannotWrite} onChange={(event) => setProvider(event.target.value as ProviderKind)}>
        <option value="demo">{t("memory.summaryDemo")}</option><option value="compatible">{t("memory.summaryCompatible")}</option></select>
      {provider === "compatible" && <p className="game-muted game-small">{t("memory.summaryCostHelp")}</p>}
      <div className="game-actions"><button type="button" className="game-secondary" disabled={cannotWrite || !recentTurns.length} onClick={() => makeSummary(recentTurns.map((turn) => turn.turnId))}>{t(currentWrite?.kind === "summary" ? "memory.summaryRunning" : "memory.summaryCreate")}</button>
        {activeSummaryId && <button type="button" className="game-secondary game-danger" disabled={!enabled || cancelState === "requesting" || cancelState === "requested"} onClick={() => void cancelSummary()}>{t("memory.summaryCancel")}</button>}</div>
      {currentWrite?.kind === "summary" && <p className="game-notice" role="status">{t("memory.summaryRunning")}</p>}
      {summaryList.length > 0 && <p className="game-muted game-small">{t("memory.summaryRebuildHelp")}</p>}
      {summaryList.length ? summaryList.map((summary) => <SummaryCard key={summary.plan.operationId} summary={summary} rebuildDisabled={cannotWrite}
        onRebuild={() => makeSummary(summary.sources.map((source) => source.turnId))} />)
        : <p className="game-muted game-small">{t(currentAnnotations ? "memory.summaryNone" : "memory.annotationsWaiting")}</p>}
    </details>

    <details className="game-memory-section"><summary>{t("memory.contextHeading")}</summary>
      <p className="game-muted game-small">{t("memory.contextHelp")}</p>
      <button type="button" className="game-secondary" disabled={!enabled || !world.latestOperation || busy || traceLoading} onClick={() => void readContextTrace()}>{t(traceLoading ? "memory.loading" : "memory.contextRead")}</button>
      {traceRead && !contextTrace && <p className="game-muted game-small">{t("memory.contextNone")}</p>}
      {contextTrace && <div className="game-memory-context"><dl className="game-memory-meta">
        <div><dt>{t("memory.contextInput")}</dt><dd>{contextTrace.inputUtf8Bytes.toLocaleString("zh-CN")} / {contextTrace.requiredInputBytes.toLocaleString("zh-CN")} / {contextTrace.effectiveInputLimitBytes.toLocaleString("zh-CN")}</dd></div>
        <div><dt>{t("memory.contextEstimate")}</dt><dd>{contextTrace.estimatedInputTokens.toLocaleString("zh-CN")}<small>{t("memory.contextEstimateHelp")}</small></dd></div>
        <div><dt>{t("memory.contextActual")}</dt><dd>{numberOrUnknown(contextTrace.actualInputTokens)}</dd></div>
      </dl><ul className="game-memory-sources">{contextTrace.sections.map((section, index) => <li key={`${section.kind}:${section.id ?? ""}:${index}`}>
        <strong>{t(`memory.context.${section.kind}`)}</strong> · {t(`memory.context.${section.outcome}`)}{section.required && ` · ${t("memory.contextRequired")}`}
        <small>{t("memory.contextSection", { bytes: section.utf8Bytes, count: section.sourceTurnCount })}</small>
      </li>)}</ul></div>}
    </details>
  </section>;
}

export default GameMemory;
