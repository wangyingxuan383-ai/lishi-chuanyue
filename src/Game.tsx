import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelGameTurn, createGameWorld, deleteGameProvider, describeGameCode, describeGameError,
  getGameActorView, getGameProvider, getGameWorld, hasGameCore, isGameRejectedBeforeStart, isGameTerminal,
  listGamePresets, listGameWorlds, saveGamePreset, saveGameProvider, setGamePolicy, startGameTurn, testGameProvider, upgradeGameWorld,
  type GameActionKind, type GameEvent, type GamePreset, type GameProviderProfile,
  type GameProviderTest, type GameStateV1, type GameStatus, type GameWorld, type GameWorldList,
  type GameActorView, type HoldingValue, type ObservedCondition, type ObservedResource, type ObservedRelationship,
  defaultContextBudget, parseContextBudget, type GameContextBudget,
  type ProviderCapability, type ProviderKind, type WorldSetup, type Certainty, type AcquisitionMode,
} from "./gameClient";
import { gameT as t, type GameMessageKey } from "./gameMessages";
import "./game.css";
import GameMemory from "./GameMemory";

type DisplayPhase = GameStatus | "starting" | "unconfirmed" | "notStarted";
type WriteKind = "create" | "turn" | "policy" | "provider" | "providerTest" | "providerDelete" | "preset" | "upgrade" | "annotation" | null;
interface LocalTurn {
  worldId: string; operationId: string; sequence: number;
  phase: DisplayPhase; draft: string; actionKind: GameActionKind; actionText: string;
}
type SetupForm = Omit<WorldSetup, "worldId" | "eraYear"> & { eraYear: string };
const phaseKeys = {
  pending: "game.phase.pending", generating: "game.phase.generating", validating: "game.phase.validating",
  committed: "game.phase.committed", failed: "game.phase.failed", cancelled: "game.phase.cancelled",
  interrupted: "game.phase.interrupted", starting: "game.phase.starting", unconfirmed: "game.phase.unconfirmed",
  notStarted: "game.phase.notStarted",
} as const satisfies Record<DisplayPhase, GameMessageKey>;
const capabilityKeys = {
  unknown: "game.capability.unknown", supported: "game.capability.supported", unsupported: "game.capability.unsupported",
} as const satisfies Record<ProviderCapability, GameMessageKey>;
const samples: SetupForm[] = [
  { title: t("game.sample.changan.title"), country: t("game.sample.changan.country"), eraYear: "748",
    locationName: t("game.sample.changan.location"), protagonistName: t("game.sample.changan.protagonist"), narrativeStyle: t("game.sample.style") },
  { title: t("game.sample.rome.title"), country: t("game.sample.rome.country"), eraYear: "-50",
    locationName: t("game.sample.rome.location"), protagonistName: t("game.sample.rome.protagonist"), narrativeStyle: t("game.sample.style") },
  { title: t("game.sample.kyoto.title"), country: t("game.sample.kyoto.country"), eraYear: "1600",
    locationName: t("game.sample.kyoto.location"), protagonistName: t("game.sample.kyoto.protagonist"), narrativeStyle: t("game.sample.style") },
];
function formatYear(eraYear: number): string {
  return eraYear < 0 ? t("game.stateBc", { year: Math.abs(eraYear) }) : t("game.stateAd", { year: eraYear });
}
function formatElapsed(seconds: number): string {
  return t("game.stateElapsed", { days: Math.floor(seconds / 86400), hours: Math.floor(seconds % 86400 / 3600), minutes: Math.floor(seconds % 3600 / 60) });
}
function phaseRank(phase: DisplayPhase): number {
  if (phase === "validating") return 3;
  if (phase === "generating") return 2;
  if (phase === "pending") return 1;
  return 0;
}
function setupFromForm(form: SetupForm): WorldSetup | null {
  const eraYear = Number(form.eraYear);
  if (!/^-?\d+$/.test(form.eraYear.trim()) || !Number.isSafeInteger(eraYear) || eraYear === 0 || Math.abs(eraYear) > 999999) return null;
  const fields = [[form.title, 256], [form.country, 128], [form.locationName, 256], [form.protagonistName, 128]] as const;
  const encoder = new TextEncoder();
  if (fields.some(([value, maxBytes]) => !value.trim() || encoder.encode(value.trim()).byteLength > maxBytes) || encoder.encode(form.narrativeStyle).byteLength > 2048) return null;
  return { worldId: crypto.randomUUID(), title: form.title.trim(), country: form.country.trim(), eraYear,
    locationName: form.locationName.trim(), protagonistName: form.protagonistName.trim(), narrativeStyle: form.narrativeStyle };
}
function formFromSetup(setup: WorldSetup): SetupForm {
  return { title: setup.title, country: setup.country, eraYear: String(setup.eraYear),
    locationName: setup.locationName, protagonistName: setup.protagonistName, narrativeStyle: setup.narrativeStyle };
}

function LegacyWorldStatePanel({ state, upgradeDisabled, upgrading, onUpgrade }: {
  state: GameStateV1; upgradeDisabled: boolean; upgrading: boolean; onUpgrade: () => void;
}) {
  const names = new Map(state.entities.map((entity) => [entity.id, entity.name]));
  const nameOf = (id: string) => names.get(id) ?? id;
  const protagonist = state.entities.find((entity) => entity.id === state.protagonistId);
  const conditions = state.conditions.filter((condition) => condition.active);
  return (
    <aside className="game-world-state" aria-labelledby="game-state-heading">
      <h2 id="game-state-heading">{t("game.stateHeading")}</h2>
      <p className="game-muted">{t("game.stateHelp")}</p>
      <details className="game-upgrade" open><summary>{t("game.longState.heading")}</summary>
        <p>{t("game.longState.legacy")}</p><p className="game-muted">{t("game.longState.upgradeHelp")}</p>
        <button type="button" className="game-secondary" disabled={upgradeDisabled} onClick={onUpgrade}>{t(upgrading ? "game.longState.upgrading" : "game.longState.upgrade")}</button>
      </details>
      <dl className="game-state-summary">
        <div><dt>{t("game.stateTime")}</dt><dd>{formatYear(state.time.eraYear)}<small>{formatElapsed(state.time.elapsedSeconds)}</small></dd></div>
        <div><dt>{t("game.stateLocation")}</dt><dd>{nameOf(state.locationId)}</dd></div>
        <div><dt>{t("game.stateProtagonist")}</dt><dd>{nameOf(state.protagonistId)}<small>{t(protagonist?.alive === false ? "game.stateDead" : protagonist?.alive === true ? "game.stateAlive" : "game.stateLifeUnknown")}</small></dd></div>
      </dl>
      <details open><summary>{t("game.stateResources")}</summary>
        {state.resources.length ? <ul className="game-state-list">{state.resources.map((resource) => (
          <li key={`${resource.ownerId}:${resource.key}`}><span>{resource.key === "cash" ? t("game.stateCash") : resource.key}<small>{nameOf(resource.ownerId)}</small></span><strong>{resource.amount.toLocaleString("zh-CN")} {resource.unit}</strong></li>
        ))}</ul> : <p className="game-muted">{t("game.stateResourcesEmpty")}</p>}
      </details>
      <details open><summary>{t("game.stateConditions")}</summary>
        {conditions.length ? <ul className="game-state-list">{conditions.map((condition) => <li key={condition.id}><span>{condition.description}<small>{nameOf(condition.entityId)}</small></span></li>)}</ul>
          : <p className="game-muted">{t("game.stateConditionsEmpty")}</p>}
      </details>
      <details><summary>{t("game.statePeople")}</summary><ul className="game-state-list">{state.entities.filter((entity) => entity.kind === "person").map((entity) => (
        <li key={entity.id}><span>{entity.name}<small>{t(entity.alive === false ? "game.stateDead" : entity.alive === true ? "game.stateAlive" : "game.stateLifeUnknown")}</small>
          {Object.entries(entity.attributes).map(([key, value]) => <small key={key}>{key}：{value}</small>)}</span></li>
      ))}</ul></details>
      <details><summary>{t("game.stateRelationships")}</summary>
        {state.relationships.length ? <ul className="game-state-list">{state.relationships.map((relation, index) => (
          <li key={`${relation.fromId}:${relation.toId}:${relation.kind}:${index}`}><span>{nameOf(relation.fromId)} → {nameOf(relation.toId)}<small>{relation.kind} · {t("game.stateStrength", { value: relation.strength })}</small></span></li>
        ))}</ul> : <p className="game-muted">{t("game.stateRelationshipsEmpty")}</p>}
      </details>
      <details><summary>{t("game.stateEvents")}</summary>
        {state.events.length ? <ul className="game-state-list">{state.events.map((event) => <li key={event.id}><span>{event.description}</span></li>)}</ul>
          : <p className="game-muted">{t("game.stateEventsEmpty")}</p>}
      </details>
    </aside>
  );
}

const certaintyKeys = {
  certain: "game.actor.certainty.certain", reported: "game.actor.certainty.reported", doubtful: "game.actor.certainty.doubtful", legacy_unspecified: "game.actor.certainty.legacy_unspecified",
} as const satisfies Record<Certainty, GameMessageKey>;
const acquisitionKeys = {
  observed: "game.actor.acquisition.observed", told: "game.actor.acquisition.told", inferred: "game.actor.acquisition.inferred", legacy_unspecified: "game.actor.acquisition.legacy_unspecified",
} as const satisfies Record<AcquisitionMode, GameMessageKey>;

function LongStatePanel({ world, view, loading, error, onRefresh }: {
  world: GameWorld; view: GameActorView | null; loading: boolean; error: string | null; onRefresh: () => void;
}) {
  // The objective snapshot cannot fill gaps in the actor's filtered DTO. A
  // newer hidden name, illness or claim assessment must remain hidden here.
  const names = new Map(view?.entities.map((entity) => [entity.entityId, entity.name]) ?? []);
  const nameOf = (id: string) => names.get(id) ?? t("game.actor.unknownName");
  const facts = view?.observedFacts ?? [];
  const resources = facts.filter((f) => f.factKey.type === "resource").map((f) => f.value as ObservedResource);
  const conditions = facts.filter((f) => f.factKey.type === "condition").map((f) => f.value as ObservedCondition);
  const relations = facts.filter((f) => f.factKey.type === "relationship").map((f) => f.value as ObservedRelationship);
  const holdings = facts.filter((f) => f.factKey.type === "item_holding").map((f) => ({ itemId: f.factKey.type === "item_holding" ? f.factKey.itemId : "", value: f.value as HoldingValue }));
  const knownKinds = new Map(facts.filter((f) => f.factKey.type === "entity_created").map((f) => {
    const value = f.value as { id: string; kind: string }; return [value.id, value.kind];
  }));
  const people = view?.entities.filter((entity) => entity.alive !== null || knownKinds.get(entity.entityId) === "person") ?? [];
  const protagonist = view?.entities.find((entity) => entity.entityId === world.state.protagonistId);
  return <aside className="game-world-state game-long-state" aria-labelledby="game-state-heading">
    <h2 id="game-state-heading">{t("game.actor.heading")}</h2>
    <p className="game-muted">{t("game.actor.help")}</p>
    <p className="game-save-notice">{t("game.longState.active")}</p>
    <dl className="game-state-summary">
      <div><dt>{t("game.stateTime")}</dt><dd>{formatYear(world.state.time.eraYear)}<small>{formatElapsed(world.state.time.elapsedSeconds)}</small></dd></div>
      <div><dt>{t("game.stateLocation")}</dt><dd>{nameOf(world.state.locationId)}</dd></div>
      <div><dt>{t("game.stateProtagonist")}</dt><dd>{nameOf(world.state.protagonistId)}<small>{t(protagonist?.alive === false ? "game.stateDead" : protagonist?.alive === true ? "game.stateAlive" : "game.stateLifeUnknown")}</small></dd></div>
    </dl>
    <button type="button" className="game-secondary game-actor-refresh" disabled={loading} onClick={onRefresh}>{t(loading ? "game.actor.loading" : "game.actor.refresh")}</button>
    {error && <p className="game-error" role="alert">{error}</p>}
    <details open><summary>{t("game.stateResources")}</summary>
      {resources.length ? <ul className="game-state-list">{resources.map((resource) => <li key={`${resource.ownerId}:${resource.key}`}><span>{resource.key === "cash" ? t("game.stateCash") : resource.key}<small>{nameOf(resource.ownerId)}</small></span><strong>{resource.amount.toLocaleString("zh-CN")} {resource.unit}</strong></li>)}</ul> : <p className="game-muted">{t("game.stateResourcesEmpty")}</p>}
    </details>
    <details open><summary>{t("game.actor.inventory")}</summary>
      {holdings.length ? <ul className="game-state-list game-inventory-list">{holdings.map(({ itemId, value }) => <li key={itemId}><span>{nameOf(itemId)}
        {value.status === "legacy_unknown" ? <small className="game-state-pending">{t("game.actor.legacyUnknown")}</small> : <>
          <small>{t("game.actor.quantity", { count: value.quantity!, unit: value.unit! })}</small>
          {value.holderId && <small>{t("game.actor.holder", { name: nameOf(value.holderId) })}</small>}
          {value.placeId && <small>{t("game.actor.place", { name: nameOf(value.placeId) })}</small>}
          {value.quantity === 0 && <small>{t("game.actor.depleted")}</small>}
        </>}</span></li>)}</ul> : <p className="game-muted">{t("game.actor.inventoryEmpty")}</p>}
    </details>
    <details open><summary>{t("game.actor.conditions")}</summary>
      {conditions.length ? <ul className="game-state-list">{conditions.map((condition) => <li key={condition.id}><span>{condition.description}<small>{nameOf(condition.entityId)} · {t(condition.active ? "game.actor.conditionActive" : "game.actor.conditionResolved")}</small></span></li>)}</ul> : <p className="game-muted">{t("game.actor.conditionsEmpty")}</p>}
    </details>
    <details><summary>{t("game.statePeople")}</summary>
      {people.length ? <div className="game-people-list">{people.map((person) => <details className="game-person-detail" key={person.entityId}>
        <summary><span>{person.name ?? t("game.actor.unknownName")}</span><small>{t(person.alive === false ? "game.stateDead" : person.alive === true ? "game.stateAlive" : "game.stateLifeUnknown")}</small></summary>
        {person.aliases.length > 0 && <p><span className="game-muted">{t("game.actor.aliases")}</span><br />{person.aliases.join("、")}</p>}
        {Object.keys(person.attributes).length > 0 ? <dl className="game-person-attributes">{Object.entries(person.attributes).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl> : <p className="game-muted">{t("game.actor.noAttributes")}</p>}
      </details>)}</div> : <p className="game-muted">{t("game.actor.empty")}</p>}
    </details>
    <details><summary>{t("game.stateRelationships")}</summary>
      {relations.length ? <ul className="game-state-list">{relations.map((relation) => <li key={`${relation.fromId}:${relation.toId}:${relation.kind}`}><span>{nameOf(relation.fromId)} → {nameOf(relation.toId)}<small>{relation.kind} · {t("game.stateStrength", { value: relation.strength })}</small></span></li>)}</ul> : <p className="game-muted">{t("game.stateRelationshipsEmpty")}</p>}
    </details>
    <details><summary>{t("game.actor.knowledge")}</summary>
      {view?.knowledge.length ? <ul className="game-state-list game-knowledge-list">{view.knowledge.map((known) => <li key={`${known.targetType}:${known.targetId}`}><span>{known.text}<small>{t(known.targetType === "claim" ? "game.actor.claim" : "game.actor.event")} · {t(certaintyKeys[known.certainty])} · {t(acquisitionKeys[known.acquisitionMode])}</small></span></li>)}</ul> : <p className="game-muted">{t("game.actor.knowledgeEmpty")}</p>}
    </details>
  </aside>;
}

export default function Game() {
  const native = hasGameCore();
  const [library, setLibrary] = useState<GameWorldList>({ worlds: [], unavailableCount: 0 });
  const [world, setWorld] = useState<GameWorld | null>(null);
  const [form, setForm] = useState<SetupForm>({ ...samples[0] });
  const [showSetup, setShowSetup] = useState(false);
  const [presets, setPresets] = useState<GamePreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [presetMessage, setPresetMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(native);
  const [querying, setQuerying] = useState(false);
  const [writeKind, setWriteKind] = useState<WriteKind>(null);
  const [local, setLocal] = useState<LocalTurn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [policy, setPolicy] = useState("");
  const [policyMessage, setPolicyMessage] = useState<string | null>(null);
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);
  const [actorView, setActorView] = useState<GameActorView | null>(null);
  const [actorLoading, setActorLoading] = useState(false);
  const [actorError, setActorError] = useState<string | null>(null);
  const [actorRevision, setActorRevision] = useState(0);
  const [providerKind, setProviderKind] = useState<ProviderKind>("demo");
  const [profile, setProfile] = useState<GameProviderProfile | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [contextBudget, setContextBudget] = useState<GameContextBudget>({ ...defaultContextBudget });
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [providerTest, setProviderTest] = useState<GameProviderTest | null>(null);
  const [cancelState, setCancelState] = useState<"idle" | "requesting" | "requested">("idle");
  const mounted = useRef(true);
  const worldRef = useRef<GameWorld | null>(null);
  const selectedId = useRef<string | null>(null);
  const localRef = useRef<LocalTurn | null>(null);
  const profileRef = useRef<GameProviderProfile | null>(null);
  const writeRef = useRef(false);
  const queryRef = useRef(false);
  const generation = useRef(0);
  const password = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; if (password.current) password.current.value = ""; };
  }, []);

  const applyWorld = useCallback((incoming: GameWorld) => {
    if (!mounted.current || selectedId.current !== incoming.setup.worldId) return;
    const previous = worldRef.current;
    if (previous?.setup.worldId === incoming.setup.worldId) {
      // A late query cannot roll back a committed head or a confirmed terminal operation.
      if (previous.turnCount > incoming.turnCount) return;
      if (previous.turnCount === incoming.turnCount && previous.state.protocolVersion === 2 && incoming.state.protocolVersion === 1) return;
      const before = previous.latestOperation;
      const after = incoming.latestOperation;
      if (previous.turnCount === incoming.turnCount && before && after &&
        ((before.operationId === after.operationId && isGameTerminal(before.status) && !isGameTerminal(after.status)) ||
         (before.createdAtMs > after.createdAtMs))) return;
    }
    worldRef.current = incoming;
    setWorld(incoming);
    const operation = incoming.latestOperation;
    const current = localRef.current;
    if (operation && current?.operationId === operation.operationId) {
      if (isGameTerminal(operation.status) || (!isGameTerminal(current.phase) && phaseRank(operation.status) >= phaseRank(current.phase))) {
        current.phase = operation.status;
      }
      setLocal({ ...current });
    } else if (operation && !writeRef.current && (!current || isGameTerminal(current.phase) || current.phase === "notStarted")) {
      const restored: LocalTurn = { worldId: incoming.setup.worldId, operationId: operation.operationId, sequence: -1,
        phase: operation.status, draft: "", actionKind: operation.actionKind, actionText: operation.actionText };
      localRef.current = restored;
      setLocal(restored);
    }
    if (operation && isGameTerminal(operation.status) && (!current || current.operationId === operation.operationId || !writeRef.current)) {
      setCancelState("idle");
      if (operation.status === "failed") setError(describeGameCode(operation.errorCode));
    }
    setLibrary((currentLibrary) => ({ ...currentLibrary, worlds: currentLibrary.worlds.map((summary) => summary.worldId === incoming.setup.worldId
      ? { worldId: incoming.setup.worldId, title: incoming.setup.title, country: incoming.setup.country,
        eraYear: incoming.setup.eraYear, protagonistName: incoming.setup.protagonistName, headTurnId: incoming.headTurnId, turnCount: incoming.turnCount } : summary) }));
  }, []);

  function selectWorld(incoming: GameWorld) {
    selectedId.current = incoming.setup.worldId;
    worldRef.current = null;
    localRef.current = null;
    setLocal(null);
    setAction("");
    setPolicy(incoming.narrativePolicy);
    setPolicyMessage(null);
    setUpgradeMessage(null);
    setActorView(null);
    setActorError(null);
    setError(null);
    applyWorld(incoming);
    setShowSetup(false);
  }
  function applyProfile(incoming: GameProviderProfile, fillInputs = false) {
    if (!mounted.current) return;
    if (profileRef.current && profileRef.current.revision > incoming.revision) return;
    profileRef.current = incoming;
    setProfile(incoming);
    if (fillInputs) {
      setEndpoint(incoming.config?.endpoint ?? "");
      setModel(incoming.config?.model ?? "");
      setAllowInsecureHttp(incoming.config?.allowInsecureHttp ?? false);
      setContextBudget({ ...(incoming.config?.contextBudget ?? defaultContextBudget) });
    }
  }

  useEffect(() => {
    if (!native) return;
    const currentGeneration = ++generation.current;
    setLoading(true);
    // Startup performs reads only: it never replays an interrupted action or calls an AI endpoint.
    void Promise.allSettled([listGameWorlds(), listGamePresets(), getGameProvider()]).then(async ([worldResult, presetResult, profileResult]) => {
      if (!mounted.current || generation.current !== currentGeneration) return;
      if (presetResult.status === "fulfilled") setPresets(presetResult.value);
      else setPresetMessage(describeGameError(presetResult.reason));
      if (profileResult.status === "fulfilled") applyProfile(profileResult.value, true);
      else setProfileError(describeGameError(profileResult.reason));
      if (worldResult.status === "rejected") { setError(describeGameError(worldResult.reason)); return; }
      setLibrary(worldResult.value);
      const first = worldResult.value.worlds[0];
      if (!first) { setShowSetup(true); return; }
      try {
        const stored = await getGameWorld(first.worldId);
        if (mounted.current && generation.current === currentGeneration) selectWorld(stored);
      } catch (caught: unknown) {
        if (mounted.current && generation.current === currentGeneration) setError(describeGameError(caught));
      }
    }).finally(() => { if (mounted.current && generation.current === currentGeneration) setLoading(false); });
    // Helpers act on refs/state setters, and this initial read intentionally runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  const refreshWorld = useCallback(async (silent = false) => {
    const worldId = selectedId.current;
    if (!native || !worldId || queryRef.current) return;
    queryRef.current = true;
    setQuerying(true);
    try {
      const stored = await getGameWorld(worldId);
      if (selectedId.current === worldId) {
        applyWorld(stored);
        if (!silent && stored.latestOperation?.status !== "failed") setError(null);
        // A missing operation does not prove a lost IPC request never reached a
        // worker. Keep an unknown local result blocked instead of replaying it.
      }
    } catch (caught: unknown) { if (mounted.current && selectedId.current === worldId) setError(describeGameError(caught)); }
    finally { queryRef.current = false; if (mounted.current) setQuerying(false); }
  }, [native, applyWorld]);

  const persistedActive = world?.latestOperation && !isGameTerminal(world.latestOperation.status);
  const localActive = local && local.worldId === world?.setup.worldId &&
    (local.phase === "starting" || local.phase === "pending" || local.phase === "generating" || local.phase === "validating" || local.phase === "unconfirmed");
  const busy = writeKind !== null || Boolean(persistedActive) || Boolean(localActive);
  const protagonist = world?.state.entities.find((entity) => entity.id === world.state.protagonistId);
  const dead = protagonist?.alive === false;
  const canAct = native && world !== null && !loading && !querying && !busy && !dead &&
    (providerKind === "demo" || Boolean(profile?.configured));

  useEffect(() => {
    if (!native || !world || world.state.protocolVersion !== 2) {
      setActorView(null); setActorError(null); setActorLoading(false); return;
    }
    let stopped = false;
    const worldId = world.setup.worldId, head = world.headTurnId, actorId = world.state.protagonistId;
    setActorView(null); setActorError(null); setActorLoading(true);
    void getGameActorView(worldId, actorId).then((incoming) => {
      if (!stopped && mounted.current && worldRef.current?.setup.worldId === worldId &&
        worldRef.current.headTurnId === head && incoming.headTurnId === head) setActorView(incoming);
      else if (!stopped && mounted.current) setActorError(t("game.error.stale"));
    }).catch((caught: unknown) => { if (!stopped && mounted.current) setActorError(describeGameError(caught)); })
      .finally(() => { if (!stopped && mounted.current) setActorLoading(false); });
    return () => { stopped = true; };
    // A policy/provider change cannot change which committed facts were known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, world?.setup.worldId, world?.headTurnId, world?.state.protocolVersion, actorRevision]);

  useEffect(() => {
    if (!native || !world || !busy || loading) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { if (stopped) return; await refreshWorld(true); if (!stopped) timer = setTimeout(() => void poll(), 1000); };
    timer = setTimeout(() => void poll(), 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [native, world?.setup.worldId, busy, loading, refreshWorld]);

  async function openWorld(worldId: string) {
    if (!native || writeRef.current || busy || loading) return;
    const currentGeneration = ++generation.current;
    setLoading(true);
    try {
      const stored = await getGameWorld(worldId);
      if (mounted.current && generation.current === currentGeneration) selectWorld(stored);
    } catch (caught: unknown) { if (mounted.current) setError(describeGameError(caught)); }
    finally { if (mounted.current && generation.current === currentGeneration) setLoading(false); }
  }
  function reserveWrite(kind: Exclude<WriteKind, null>): boolean {
    if (!native || writeRef.current || busy || loading) return false;
    writeRef.current = true;
    setWriteKind(kind);
    return true;
  }
  function releaseWrite() { writeRef.current = false; if (mounted.current) setWriteKind(null); }

  async function createWorld() {
    const setup = setupFromForm(form);
    if (!setup) { setError(t("game.error.invalid")); return; }
    if (!reserveWrite("create")) return;
    setError(null);
    try {
      const created = await createGameWorld(setup);
      if (mounted.current) {
        selectWorld(created);
        setLibrary(await listGameWorlds());
      }
    } catch (caught: unknown) { if (mounted.current) setError(describeGameError(caught)); }
    finally { releaseWrite(); }
  }
  async function savePreset() {
    const setup = setupFromForm(form);
    const name = presetName.trim();
    if (!setup || !name || name.length > 128) { setPresetMessage(t("game.error.invalid")); return; }
    if (!reserveWrite("preset")) return;
    try {
      const saved = await saveGamePreset(name, setup);
      if (mounted.current) { setPresets(saved); setPresetMessage(t("game.presetSaved")); }
    } catch (caught: unknown) { if (mounted.current) setPresetMessage(describeGameError(caught)); }
    finally { releaseWrite(); }
  }

  function receiveEvent(operation: LocalTurn, event: GameEvent) {
    if (!mounted.current || localRef.current !== operation || selectedId.current !== operation.worldId || event.operationId !== operation.operationId) return;
    const persisted = worldRef.current?.latestOperation;
    const confirmedTerminal = persisted?.operationId === operation.operationId && isGameTerminal(persisted.status) ? persisted.status : null;
    if (event.sequence <= operation.sequence) return;
    if (event.sequence !== operation.sequence + 1) {
      if (!confirmedTerminal) setError(t("game.error.event"));
      return;
    }
    operation.sequence = event.sequence;
    if (event.kind === "narrative") operation.draft += event.text;
    else if (confirmedTerminal) operation.phase = confirmedTerminal;
    else if (!isGameTerminal(operation.phase) && (isGameTerminal(event.phase) || phaseRank(event.phase) >= phaseRank(operation.phase))) {
      operation.phase = event.phase;
      if (event.phase === "failed") setError(describeGameCode(event.errorCode));
    }
    // Terminal phase events are progress only. Formal facts always come from a DB view.
    if (confirmedTerminal) operation.phase = confirmedTerminal;
    setLocal({ ...operation });
  }

  async function submitTurn(actionKind: GameActionKind, actionText: string) {
    const frozenWorld = worldRef.current;
    if (!canAct || !frozenWorld || (actionKind === "action" && !actionText.trim()) || actionText.length > 32768) return;
    if (!reserveWrite("turn")) return;
    const operation: LocalTurn = { worldId: frozenWorld.setup.worldId, operationId: crypto.randomUUID(), sequence: -1,
      phase: "starting", draft: "", actionKind, actionText };
    localRef.current = operation;
    setLocal({ ...operation });
    setError(null);
    setCancelState("idle");
    const frozenProviderKind = providerKind;
    try {
      const stored = await startGameTurn({ operationId: operation.operationId, worldId: operation.worldId, branchId: "main",
        expectedHeadTurnId: frozenWorld.headTurnId, actionKind, actionText }, frozenProviderKind,
        (event) => receiveEvent(operation, event), () => {
          if (mounted.current && localRef.current === operation && !isGameTerminal(operation.phase)) setError(t("game.error.event"));
        });
      if (mounted.current && localRef.current === operation) {
        applyWorld(stored);
        if (stored.latestOperation?.operationId === operation.operationId && stored.latestOperation.status === "committed" && action === actionText) setAction("");
      }
    } catch (caught: unknown) {
      if (mounted.current && localRef.current === operation) {
        const latest = worldRef.current?.latestOperation;
        operation.phase = latest?.operationId === operation.operationId && isGameTerminal(latest.status)
          ? latest.status : isGameRejectedBeforeStart(caught) ? "notStarted" : "unconfirmed";
        setLocal({ ...operation });
        if (operation.phase !== "committed") setError(describeGameError(caught));
      }
    } finally {
      releaseWrite();
      await refreshWorld(true);
    }
  }
  async function cancelTurn() {
    const operationId = worldRef.current?.latestOperation && !isGameTerminal(worldRef.current.latestOperation.status)
      ? worldRef.current.latestOperation.operationId : localRef.current?.operationId;
    if (!native || !operationId || !busy || cancelState !== "idle" || writeKind !== "turn" && !persistedActive && !localActive) return;
    setCancelState("requesting");
    try {
      const result = await cancelGameTurn(operationId);
      if (mounted.current) {
        const latest = worldRef.current?.latestOperation;
        const terminal = latest?.operationId === operationId && isGameTerminal(latest.status);
        setCancelState(result.state === "cancel_requested" && !terminal ? "requested" : "idle");
      }
      await refreshWorld(true);
    } catch (caught: unknown) { if (mounted.current) { setCancelState("idle"); setError(describeGameError(caught)); } }
  }
  async function savePolicy() {
    const frozen = worldRef.current;
    if (!frozen || policy.length > 8192 || !reserveWrite("policy")) return;
    const frozenPolicy = policy;
    setPolicyMessage(null);
    try {
      const stored = await setGamePolicy(frozen.setup.worldId, frozenPolicy);
      if (mounted.current) { applyWorld(stored); setPolicyMessage(t("game.policySaved")); }
    } catch (caught: unknown) { if (mounted.current) setPolicyMessage(describeGameError(caught)); }
    finally { releaseWrite(); }
  }
  async function enableLongState() {
    const frozen = worldRef.current;
    if (!frozen || frozen.state.protocolVersion !== 1 || queryRef.current || !reserveWrite("upgrade")) return;
    setUpgradeMessage(null); setError(null);
    try {
      const upgraded = await upgradeGameWorld(frozen.setup.worldId, frozen.headTurnId);
      if (mounted.current && selectedId.current === frozen.setup.worldId) {
        applyWorld(upgraded); setUpgradeMessage(t("game.longState.upgraded"));
      }
    } catch (caught: unknown) { if (mounted.current) setError(describeGameError(caught)); }
    finally { releaseWrite(); await refreshWorld(true); }
  }
  async function refreshProfile() {
    if (!native || busy || loading || writeRef.current) return;
    try { applyProfile(await getGameProvider(), true); setProfileError(null); }
    catch (caught: unknown) { if (mounted.current) setProfileError(describeGameError(caught)); }
  }
  async function saveProfile() {
    if (!reserveWrite("provider")) return;
    // Clear the uncontrolled input before crossing IPC. Never put a key in React state.
    let token: string | null = password.current?.value || null;
    if (password.current) password.current.value = "";
    setProfileError(null); setProfileMessage(null); setProviderTest(null);
    try {
      const saved = await saveGameProvider(endpoint.trim(), model.trim(), token, profileRef.current?.revision ?? 0, allowInsecureHttp, parseContextBudget(contextBudget));
      if (mounted.current) { applyProfile(saved, true); setProfileMessage(t("game.providerSaved")); }
    } catch (caught: unknown) {
      if (mounted.current) setProfileError(describeGameError(caught));
      try { applyProfile(await getGameProvider()); } catch { /* Keep uncertainty; no automatic save retry. */ }
    } finally { token = null; releaseWrite(); }
  }
  async function deleteProfile() {
    if (!profileRef.current?.configured || !reserveWrite("providerDelete")) return;
    if (password.current) password.current.value = "";
    setProfileError(null); setProfileMessage(null); setProviderTest(null);
    try {
      const deleted = await deleteGameProvider(profileRef.current.revision);
      if (mounted.current) { applyProfile(deleted, true); setProfileMessage(t("game.providerDeleted")); }
    } catch (caught: unknown) {
      if (mounted.current) setProfileError(describeGameError(caught));
      try { applyProfile(await getGameProvider()); } catch { /* Deletion remains unconfirmed. */ }
    } finally { releaseWrite(); }
  }
  async function checkProvider() {
    if (!profileRef.current?.configured || !reserveWrite("providerTest")) return;
    setProfileError(null); setProfileMessage(null); setProviderTest(null);
    try {
      const result = await testGameProvider();
      if (mounted.current) {
        setProviderTest(result);
        if (result.status === "completed") setProfileMessage(t("game.providerChecked"));
        else setProfileError(describeGameCode(result.errorCode));
      }
      applyProfile(await getGameProvider());
    } catch (caught: unknown) { if (mounted.current) setProfileError(describeGameError(caught)); }
    finally { releaseWrite(); }
  }

  const latestTurn = world?.turns.at(-1);
  const choices = latestTurn?.choices ?? world?.openingChoices ?? [];
  const phase = local && world && local.worldId === world.setup.worldId ? local.phase : world?.latestOperation?.status;
  const retry = world?.latestOperation;
  const canRetry = retry && (retry.status === "failed" || retry.status === "cancelled" || retry.status === "interrupted");
  const diagnostics = providerTest?.diagnostics;

  return (
    <main className="game-page">
      <header className="game-header"><div><span className="game-eyebrow">{t("game.stage")}</span><h1>{t("game.title")}</h1><p>{t("game.subtitle")}</p></div></header>
      {!native && <p className="game-notice" role="status">{t("game.unavailable")}</p>}
      {loading && <p className="game-notice" role="status">{t("game.loading")}</p>}
      <section className="game-library" aria-labelledby="game-library-heading">
        <div className="game-section-top"><h2 id="game-library-heading">{t("game.library")}</h2><button type="button" className="game-secondary" onClick={() => setShowSetup((value) => !value)} disabled={busy || loading}>{t(showSetup && world ? "game.setupCancel" : "game.worldNew")}</button></div>
        {library.worlds.length ? <div className="game-world-tabs">{library.worlds.map((summary) => (
          <button type="button" className={`game-world-tab${world?.setup.worldId === summary.worldId ? " game-world-tab--active" : ""}`} key={summary.worldId}
            onClick={() => void openWorld(summary.worldId)} disabled={!native || busy || loading} aria-pressed={world?.setup.worldId === summary.worldId}>
            <strong>{summary.title}</strong><span>{summary.country} · {formatYear(summary.eraYear)}</span><small>{t("game.worldCount", { count: summary.turnCount })}</small>
          </button>
        ))}</div> : !loading && <p className="game-muted">{t("game.libraryEmpty")}</p>}
        {library.unavailableCount > 0 && <p className="game-notice">{t("game.worldUnavailable", { count: library.unavailableCount })}</p>}
      </section>

      {(showSetup || !world) && <section className="game-start" aria-labelledby="game-setup-heading">
        <div className="game-section-top"><h2 id="game-setup-heading">{t("game.setupHeading")}</h2><button type="button" className="game-secondary" disabled={busy} onClick={() => {
          const values = new Uint32Array(1); crypto.getRandomValues(values); setForm({ ...samples[values[0] % samples.length] }); setPresetMessage(null);
        }}>{t("game.setupRandom")}</button></div>
        <p className="game-muted">{t("game.setupHelp")}</p>
        <p className="game-muted game-small">{t("game.setupRandomHelp")}</p>
        <div className="game-form-grid">
          <label>{t("game.setupTitle")}<input id="game-setup-title" value={form.title} maxLength={256} disabled={busy} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <label>{t("game.setupCountry")}<input id="game-setup-country" value={form.country} maxLength={128} disabled={busy} onChange={(event) => setForm({ ...form, country: event.target.value })} /></label>
          <label>{t("game.setupYear")}<input id="game-setup-year" value={form.eraYear} inputMode="text" maxLength={7} disabled={busy} onChange={(event) => setForm({ ...form, eraYear: event.target.value })} /></label>
          <label>{t("game.setupLocation")}<input id="game-setup-location" value={form.locationName} maxLength={256} disabled={busy} onChange={(event) => setForm({ ...form, locationName: event.target.value })} /></label>
          <label className="game-full-row">{t("game.setupProtagonist")}<input id="game-setup-protagonist" value={form.protagonistName} maxLength={128} disabled={busy} onChange={(event) => setForm({ ...form, protagonistName: event.target.value })} /></label>
          <label className="game-full-row">{t("game.setupStyle")}<textarea id="game-setup-style" rows={3} value={form.narrativeStyle} maxLength={8192} disabled={busy} onChange={(event) => setForm({ ...form, narrativeStyle: event.target.value })} /></label>
        </div>
        <p className="game-muted game-small">{t("game.setupYearHelp")} {t("game.setupStyleHelp")}</p>
        <button className="game-primary" type="button" disabled={!native || busy || loading} onClick={() => void createWorld()}>{t(writeKind === "create" ? "game.setupCreating" : "game.setupCreate")}</button>
        <details className="game-presets"><summary>{t("game.presetHeading")}</summary>
          <div className="game-preset-list">{presets.length ? presets.map((preset) => <button type="button" className="game-secondary" key={preset.presetId} disabled={busy} onClick={() => {
            setForm(formFromSetup(preset.setup)); setPresetName(preset.name); setPresetMessage(null);
          }}>{preset.name} · {t("game.presetLoad")}</button>) : <p className="game-muted">{t("game.presetEmpty")}</p>}</div>
          <label>{t("game.presetName")}<input id="game-preset-name" value={presetName} maxLength={128} disabled={busy} onChange={(event) => setPresetName(event.target.value)} /></label>
          <button type="button" className="game-secondary" disabled={!native || busy || !presetName.trim()} onClick={() => void savePreset()}>{t(writeKind === "preset" ? "game.presetSaving" : "game.presetSave")}</button>
          {presetMessage && <p className="game-notice" role="status">{presetMessage}</p>}
        </details>
      </section>}

      <section className="game-provider-card">
        <label className="game-provider-select">{t("game.playProvider")}<select id="game-provider-kind" value={providerKind} disabled={busy} onChange={(event) => setProviderKind(event.target.value as ProviderKind)}>
          <option value="demo">{t("game.provider.demo")}</option><option value="compatible">{t("game.provider.compatible")}</option>
        </select></label>
        <p className="game-muted game-small">{t(providerKind === "demo" ? "game.demoHelp" : "game.compatibleHelp")}</p>
        {providerKind === "compatible" && profile?.config?.allowInsecureHttp && <p className="game-notice">{t("game.providerHttpRisk")}</p>}
        {providerKind === "compatible" && !profile?.configured && <p className="game-notice">{t("game.providerMissing")}</p>}
        <details className="game-provider-settings"><summary>{t("game.providerHeading")}</summary><p className="game-muted">{t("game.providerDescription")}</p>
          <p className="game-notice" role="status">{t(profile ? profile.configured ? "game.providerConfigured" : "game.providerNotConfigured" : "game.providerNotRead")}</p>
          <label>{t("game.providerEndpoint")}<input id="game-provider-endpoint" type="url" value={endpoint} maxLength={2048} spellCheck={false} autoCapitalize="none" disabled={busy} onChange={(event) => setEndpoint(event.target.value)} /></label>
          <p className="game-muted game-small">{t("game.providerEndpointHelp")}</p>
          <label className="game-http-consent"><input id="game-provider-allow-http" type="checkbox" checked={allowInsecureHttp} disabled={busy}
            onChange={(event) => setAllowInsecureHttp(event.target.checked)} /><span>{t("game.providerAllowHttp")}</span></label>
          {(allowInsecureHttp || profile?.config?.allowInsecureHttp) && <p className="game-notice">{t("game.providerHttpRisk")}</p>}
          <label>{t("game.providerModel")}<input id="game-provider-model" value={model} maxLength={256} spellCheck={false} autoCapitalize="none" disabled={busy} onChange={(event) => setModel(event.target.value)} /></label>
          <details className="game-context-settings"><summary>{t("game.context.settings")}</summary>
            <p className="game-muted">{t("game.context.budgetHelp")}</p>
            <div className="game-form-grid">
              {([ ["maxInputBytes", "game.context.inputBytes"], ["contextLimitTokens", "game.context.tokenLimit"], ["outputReserveTokens", "game.context.outputReserve"], ["transportReserveTokens", "game.context.transportReserve"] ] as const).map(([key,label]) =>
                <label key={key}>{t(label)}<input type="number" min={key === "transportReserveTokens" ? 0 : 1} max={4194304} step={1} value={contextBudget[key]} disabled={busy} onChange={(event) => setContextBudget({ ...contextBudget, [key]: Number(event.target.value) })} /></label>)}
            </div>
          </details>
          <label>{t("game.providerKey")}<input id="game-provider-key" ref={password} type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={8192} disabled={busy} /></label>
          <p className="game-muted game-small">{t("game.providerKeyHelp")}</p>
          <div className="game-actions"><button type="button" className="game-primary" disabled={!native || busy || loading} onClick={() => void saveProfile()}>{t(writeKind === "provider" ? "game.providerSaving" : "game.providerSave")}</button>
            <button type="button" className="game-secondary" disabled={!native || busy || loading} onClick={() => void refreshProfile()}>{t("game.providerRefresh")}</button>
            <button type="button" className="game-secondary" disabled={!native || busy || !profile?.configured} onClick={() => void checkProvider()}>{t(writeKind === "providerTest" ? "game.providerChecking" : "game.providerCheck")}</button>
            <button type="button" className="game-secondary game-danger" disabled={!native || busy || !profile?.configured} onClick={() => void deleteProfile()}>{t(writeKind === "providerDelete" ? "game.providerDeleting" : "game.providerDelete")}</button></div>
          <p className="game-muted game-small">{t("game.providerTestHelp")}</p>
          {profile && <dl className="game-capabilities"><div><dt>{t("game.providerStreaming")}</dt><dd>{t(capabilityKeys[profile.capabilities.streaming])}</dd></div><div><dt>{t("game.providerStructured")}</dt><dd>{t(capabilityKeys[profile.capabilities.structuredOutput])}</dd></div></dl>}
          <div aria-live="polite">{profileError && <p className="game-error">{profileError}</p>}{profileMessage && <p className="game-success">{profileMessage}</p>}</div>
          {diagnostics && <details className="game-diagnostics"><summary>{t("game.diagnostics")}</summary><dl className="game-capabilities">
            <div><dt>{t("game.diagnostic.http")}</dt><dd>{diagnostics.httpStatus ?? t("game.unknown")}</dd></div>
            <div><dt>{t("game.diagnostic.attempts")}</dt><dd>{diagnostics.attempts}</dd></div>
            <div><dt>{t("game.diagnostic.elapsed")}</dt><dd>{t("game.diagnostic.elapsedValue", { count: diagnostics.elapsedMs })}</dd></div>
            <div><dt>{t("game.diagnostic.tokens")}</dt><dd>{diagnostics.usage?.totalTokens ?? t("game.unknown")}</dd></div></dl><p className="game-muted game-small">{t("game.diagnostic.cost")}</p></details>}
        </details>
      </section>

      {error && <p className="game-error game-global-error" role="alert">{error}</p>}
      {upgradeMessage && <p className="game-success" role="status">{upgradeMessage}</p>}
      {world && <div className="game-play-layout">
        <div className="game-story-column">
          <section className="game-story" aria-labelledby="game-story-heading">
            <div className="game-section-top"><div><span className="game-eyebrow">{world.setup.country} · {formatYear(world.setup.eraYear)}</span><h2 id="game-story-heading">{world.setup.title}</h2></div>
              <button type="button" className="game-secondary" disabled={!native || loading || querying} onClick={() => void refreshWorld()}>{t(querying ? "game.worldRefreshBusy" : "game.worldRefresh")}</button></div>
            <article className="game-turn game-turn-opening"><span className="game-turn-label">{t("game.opening")}</span><div className="game-narrative">{world.openingNarrative}</div></article>
            {world.turnCount > world.turns.length && <p className="game-muted game-small">{t("game.timelineWindow", { count: world.turns.length })}</p>}
            {world.turns.map((turn, index) => <article className="game-turn" key={turn.turnId}><div className="game-turn-top"><span className="game-turn-label">{t("game.turnHeading", { number: world.turnCount - world.turns.length + index + 1 })}</span><small>{formatElapsed(turn.state.time.elapsedSeconds)}</small></div>
              <div className="game-player-action"><span>{t(turn.actionKind === "continue" ? "game.turnContinue" : "game.turnAction")}</span>{turn.actionKind === "action" && <p>{turn.actionText}</p>}</div>
              <div className="game-narrative">{turn.narrative}</div></article>)}
          </section>
          <section className="game-composer" aria-labelledby="game-action-label">
            <div aria-live="polite">{phase && <p className={`game-phase game-phase--${phase}`}>{t(phaseKeys[phase])}</p>}{cancelState === "requested" && <p className="game-muted game-small">{t("game.cancelRequested")}</p>}</div>
            {local?.draft && local.phase !== "committed" && <div className="game-draft"><h3>{t("game.draftHeading")}</h3><p className="game-muted game-small">{t("game.draftHelp")}</p><div className="game-narrative">{local.draft}</div></div>}
            {choices.length > 0 && !dead && <div className="game-choices"><h3>{t("game.choicesHeading")}</h3>{choices.map((choice) => <button type="button" className="game-choice" key={`${world.headTurnId ?? "opening"}:${choice.id}`} disabled={!canAct} onClick={() => void submitTurn("action", choice.text)}>{choice.text}<span aria-hidden="true">↗</span></button>)}</div>}
            <label id="game-action-label" htmlFor="game-action">{t("game.actionLabel")}</label><textarea id="game-action" rows={4} value={action} maxLength={32768} placeholder={t("game.actionPlaceholder")} disabled={busy || dead} onChange={(event) => setAction(event.target.value)} aria-describedby="game-action-help" />
            <p id="game-action-help" className="game-muted game-small">{t("game.actionHelp")}</p>
            <div className="game-actions"><button type="button" className="game-primary" disabled={!canAct || !action.trim()} onClick={() => void submitTurn("action", action)}>{t(writeKind === "turn" ? "game.actionBusy" : "game.actionSubmit")}</button>
              <button type="button" className="game-secondary" disabled={!canAct} onClick={() => void submitTurn("continue", "")}>{t("game.continue")}</button>
              {(writeKind === "turn" || persistedActive || localActive) && <button type="button" className="game-secondary" disabled={cancelState !== "idle"} onClick={() => void cancelTurn()}>{t(cancelState === "idle" ? "game.cancel" : "game.cancelling")}</button>}
            </div>
            {canRetry && <div className="game-retry"><button type="button" className="game-secondary" disabled={!canAct} onClick={() => void submitTurn(retry.actionKind, retry.actionText)}>{t("game.retry")}</button><p className="game-muted game-small">{t("game.retryHelp")}</p></div>}
            {dead && <p className="game-notice">{t("game.stateDeadHelp")}</p>}
            <p className="game-save-notice">{t("game.saveNotice")}</p>
          </section>
          <details className="game-policy"><summary>{t("game.policyHeading")}</summary><p className="game-muted">{t("game.policyHelp")}</p>
            <label htmlFor="game-policy-input">{t("game.policyLabel")}</label><textarea id="game-policy-input" value={policy} maxLength={8192} rows={3} disabled={busy} onChange={(event) => { setPolicy(event.target.value); setPolicyMessage(null); }} />
            <button type="button" className="game-secondary" disabled={!native || busy || policy === world.narrativePolicy} onClick={() => void savePolicy()}>{t(writeKind === "policy" ? "game.policySaving" : "game.policySave")}</button>
            {policyMessage && <p className="game-notice" role="status">{policyMessage}</p>}
          </details>
        </div>
        {world.state.protocolVersion === 1
          ? <LegacyWorldStatePanel state={world.state} upgradeDisabled={!native || busy || loading || querying} upgrading={writeKind === "upgrade"} onUpgrade={() => void enableLongState()} />
          : <LongStatePanel world={world} view={actorView} loading={actorLoading || busy || !native} error={actorError} onRefresh={() => { if (native && !busy) setActorRevision((value) => value + 1); }} />}
      </div>}
      {world && <GameMemory key={`${world.setup.worldId}:${world.branchId}`} world={world} actorView={actorView} busy={busy || loading || querying}
        beginWrite={() => reserveWrite("annotation")} endWrite={releaseWrite} />}
      <footer className="game-footer">{t("game.stateArchivedHelp")}</footer>
    </main>
  );
}
