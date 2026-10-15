import { useEffect, useId, useRef, useState } from "react";
import { getGameWorld, hasGameCore, type GameActorView, type GameWorld } from "./gameClient";
import { correctGameFact, describeBranchError, editGameBranch, enableGameBranches, forkGameBranch, listGameBranches,
  type BranchCard, type BranchEditRequest, type FactCorrection, type ForkBranchRequest, type RewriteAction } from "./gameBranchClient";
import { branchT as t, type BranchPlainMessageKey } from "./gameBranchMessages";
import "./gameBranches.css";
export interface GameBranchesProps {
  world: GameWorld; actorView: GameActorView | null; busy: boolean; beginWrite: () => boolean; endWrite: () => void;
  onSelect: (world: GameWorld, card: BranchCard, originalAction: RewriteAction | null) => void;
  onCurrentBranch: (card: BranchCard | null) => void;
}
const scopeOf = (world: GameWorld) => JSON.stringify([world.setup.worldId, world.branchId, world.headTurnId, world.state.protocolVersion, world.narrativePolicy]);
const validName = (value: string) => value.trim().length > 0 && new TextEncoder().encode(value.trim()).length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
export default function GameBranches({ world, actorView, busy, beginWrite, endWrite, onSelect, onCurrentBranch }: GameBranchesProps) {
  const id = useId(); const native = hasGameCore(); const scope = scopeOf(world);
  const currentScope = useRef(scope); currentScope.current = scope;
  const callbacks = useRef({ onSelect, onCurrentBranch }); callbacks.current = { onSelect, onCurrentBranch };
  const mounted = useRef(false); const readRevision = useRef(0); const writingRef = useRef(false);
  const [cards, setCards] = useState<BranchCard[] | null>(null); const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState(false); const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [backupName, setBackupName] = useState<string | null>(null); const [newName, setNewName] = useState("");
  const [rename, setRename] = useState(""); const [sourceId, setSourceId] = useState("");
  const [showArchived, setShowArchived] = useState(true); const [page, setPage] = useState(0);
  const [correctionKind, setCorrectionKind] = useState<"name" | "cash">("name"); const [correctionValue, setCorrectionValue] = useState("");
  const stillCurrent = (frozen: string) => mounted.current && currentScope.current === frozen;
  const currentCard = cards?.find((card) => card.branchId === world.branchId) ?? null;
  const canWrite = native && world.state.protocolVersion === 2 && !busy && !reading && !writing && loaded;
  const canFork = canWrite && currentCard !== null && !currentCard.archived && currentCard.headTurnId === world.headTurnId;
  const filteredCards = cards?.filter((card) => showArchived || !card.archived || card.branchId === world.branchId) ?? [];
  const visible = [...filteredCards.filter((card) => card.branchId === world.branchId), ...filteredCards.filter((card) => card.branchId !== world.branchId)];
  const pageCount = Math.max(1, Math.ceil(visible.length / 12)); const pageIndex = Math.min(page, pageCount - 1);
  const names = new Map(cards?.map((card) => [card.branchId, card.name]) ?? []);
  const actor = actorView?.worldId === world.setup.worldId && actorView.branchId === world.branchId && actorView.headTurnId === world.headTurnId ? actorView : null;
  const canCorrectCash = Boolean(actor?.observedFacts.some((fact) => fact.factKey.type === "resource" && fact.factKey.ownerId === world.state.protagonistId && fact.factKey.key === "cash"));
  const canCorrectName = Boolean(actor?.entities.some((entity) => entity.entityId === world.state.protagonistId && entity.name !== null));

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readRevision.current++; }; }, []);
  useEffect(() => {
    setCards(null); setLoaded(false); setRename(""); setNewName(""); setPage(0); setSourceId(world.headTurnId ?? "");
    setError(null); setNotice(null); setCorrectionValue(""); setCorrectionKind("name");
    const revision = ++readRevision.current;
    setReading(native);
    if (!native) { callbacks.current.onCurrentBranch(null); return; }
    void listGameBranches(world.setup.worldId).then((incoming) => {
      if (stillCurrent(scope) && readRevision.current === revision) {
        setCards(incoming); setLoaded(true);
        const selected = incoming?.find((card) => card.branchId === world.branchId) ?? null;
        callbacks.current.onCurrentBranch(selected); setRename(selected?.name ?? "");
      }
    }).catch((cause: unknown) => { if (stillCurrent(scope) && readRevision.current === revision) setError(describeBranchError(cause)); })
      .finally(() => { if (stillCurrent(scope) && readRevision.current === revision) setReading(false); });
  }, [scope, native]);

  async function refresh() {
    if (!native || reading || writingRef.current || busy) return;
    const frozen = scope; const revision = ++readRevision.current; setReading(true); setError(null);
    try {
      const incoming = await listGameBranches(world.setup.worldId);
      if (stillCurrent(frozen) && readRevision.current === revision) {
        setCards(incoming); setLoaded(true); const selected = incoming?.find((card) => card.branchId === world.branchId) ?? null;
        callbacks.current.onCurrentBranch(selected); setRename(selected?.name ?? "");
      }
    } catch (cause) { if (stillCurrent(frozen) && readRevision.current === revision) setError(describeBranchError(cause)); }
    finally { if (stillCurrent(frozen) && readRevision.current === revision) setReading(false); }
  }
  async function runWrite(work: (frozen: string) => Promise<void>) {
    if (!canWrite || writingRef.current) return;
    if (!beginWrite()) { setError(t("branches.error.busy")); return; }
    writingRef.current = true; setWriting(true); setError(null); setNotice(null); readRevision.current++;
    try { await work(scope); }
    catch (cause) { if (stillCurrent(scope)) setError(describeBranchError(cause)); }
    finally { writingRef.current = false; if (mounted.current) setWriting(false); endWrite(); }
  }
  function editRequest(card: BranchCard): BranchEditRequest {
    return { worldId: world.setup.worldId, branchId: card.branchId, expectedHeadTurnId: card.headTurnId, expectedRevision: card.revision, operationId: crypto.randomUUID() };
  }
  function forkRequest(forkTurnId: string | null): ForkBranchRequest | null {
    if (!currentCard || !validName(newName)) { setError(t("branches.nameInvalid")); return null; }
    return { worldId: world.setup.worldId, sourceBranchId: world.branchId, expectedHeadTurnId: world.headTurnId, expectedRevision: currentCard.revision,
      operationId: crypto.randomUUID(), newBranchId: crypto.randomUUID(), name: newName.trim(), forkTurnId };
  }
  function open(card: BranchCard) {
    void runWrite(async (frozen) => {
      const incoming = await getGameWorld(world.setup.worldId, card.branchId);
      if (stillCurrent(frozen)) callbacks.current.onSelect(incoming, { ...card, headTurnId: incoming.headTurnId, turnCount: incoming.turnCount }, null);
    });
  }
  function enable() {
    void runWrite(async (frozen) => {
      const receipt = await enableGameBranches(world.setup.worldId, world.headTurnId);
      if (!stillCurrent(frozen)) return;
      setBackupName(receipt.backupBasename); setLoaded(false);
      const incoming = await listGameBranches(world.setup.worldId);
      if (stillCurrent(frozen)) {
        setCards(incoming); setLoaded(true); setNotice(t("branches.enabled"));
        const selected = incoming?.find((card) => card.branchId === world.branchId) ?? null;
        callbacks.current.onCurrentBranch(selected); setRename(selected?.name ?? "");
      }
    });
  }
  function edit(card: BranchCard, changes: { name: string } | { archived: boolean }, message: BranchPlainMessageKey) {
    if ("name" in changes && !validName(changes.name)) { setError(t("branches.nameInvalid")); return; }
    const request = editRequest(card);
    void runWrite(async (frozen) => {
      const incoming = await editGameBranch(request, changes);
      if (stillCurrent(frozen)) {
        setCards((previous) => previous?.map((row) => row.branchId === incoming.branchId ? incoming : row) ?? null); setNotice(t(message));
        if (incoming.branchId === world.branchId) { callbacks.current.onCurrentBranch(incoming); setRename(incoming.name); }
      }
    });
  }
  function fork(rewrite: boolean) {
    if (!canFork || (rewrite && !sourceId)) return;
    const turn = world.turns.find((row) => row.turnId === sourceId);
    const request = forkRequest(rewrite ? turn?.parentTurnId ?? null : sourceId || null); if (!request) return;
    void runWrite(async (frozen) => {
      const created = await forkGameBranch(request, rewrite ? sourceId : undefined);
      if (stillCurrent(frozen)) callbacks.current.onSelect(created.world, created.branch, created.originalAction);
    });
  }
  function correct() {
    if (!canFork || (correctionKind === "cash" ? !canCorrectCash : !canCorrectName)) return;
    const value = correctionValue.trim();
    let correction: FactCorrection;
    if (correctionKind === "name") {
      if (!validName(value)) { setError(t("branches.correctionInvalid")); return; }
      correction = { kind: "name", name: value };
    } else {
      const amount = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(amount) || amount < 0) { setError(t("branches.correctionInvalid")); return; }
      correction = { kind: "cash", amount };
    }
    const request = forkRequest(world.headTurnId); if (!request) return;
    void runWrite(async (frozen) => {
      const created = await correctGameFact(request, crypto.randomUUID(), correction);
      if (stillCurrent(frozen)) callbacks.current.onSelect(created.world, created.branch, null);
    });
  }
  return <section className="game-branches" aria-labelledby={`${id}-heading`}>
    <div className="game-section-top"><h2 id={`${id}-heading`}>{t("branches.heading")}</h2><button type="button" className="game-secondary" disabled={!native || busy || reading || writing} onClick={() => void refresh()}>{t(reading ? "branches.loading" : "branches.refresh")}</button></div>
    <p className="game-muted game-small">{t("branches.help")}</p>
    {!native && <p className="game-notice">{t("branches.unavailable")}</p>}
    {world.state.protocolVersion === 1 && <p className="game-notice">{t("branches.legacy")}</p>}
    <div aria-live="polite">{error && <p className="game-error" role="alert">{error}</p>}{notice && <p className="game-notice" role="status">{notice}</p>}</div>
    {backupName && <p className="game-muted game-small">{t("branches.backup", { name: backupName })}</p>}
    {native && loaded && cards === null && world.state.protocolVersion === 2 && <div><p className="game-muted game-small">{t("branches.enableHelp")}</p><button type="button" className="game-secondary" disabled={!canWrite} onClick={enable}>{t(writing ? "branches.working" : "branches.enable")}</button></div>}
    {cards !== null && <>
      {currentCard && <p className="game-notice">{t("branches.current", { name: currentCard.name })}{currentCard.archived && ` · ${t("branches.archived")}`}</p>}
      <label className="game-branches-check"><input type="checkbox" checked={showArchived} onChange={(event) => { setShowArchived(event.target.checked); setPage(0); }} />{t("branches.showArchived")}</label>
      <div className="game-branches-list">{visible.slice(pageIndex * 12, pageIndex * 12 + 12).map((card) => <article className={`game-branch-card${card.branchId === world.branchId ? " game-branch-card--selected" : ""}`} key={card.branchId}>
        <div className="game-branch-card-top"><strong>{card.name}</strong><span>{t(card.archived ? "branches.archived" : "branches.active")}</span></div>
        <small>{card.parentBranchId === null ? t("branches.root") : t("branches.parent", { name: names.get(card.parentBranchId) ?? card.parentBranchId })}</small>
        <small>{card.forkTurnId === null ? t("branches.initial") : t("branches.forkNode", { count: card.forkTurnCount })}</small>
        {card.forkTurnId && <small>{t("branches.nodeId", { id: card.forkTurnId })}</small>}<small>{t("branches.head", { count: card.turnCount })}</small>
        <div className="game-actions"><button type="button" className="game-secondary" disabled={!canWrite || card.branchId === world.branchId} onClick={() => open(card)}>{t(card.branchId === world.branchId ? "branches.selected" : "branches.open")}</button>
          <button type="button" className="game-secondary" disabled={!canWrite} onClick={() => edit(card, { archived: !card.archived }, card.archived ? "branches.restoreDone" : "branches.archiveDone")}>{t(card.archived ? "branches.restore" : "branches.archive")}</button></div>
      </article>)}</div>
      {pageCount > 1 && <div className="game-branches-pagination"><button type="button" className="game-secondary" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>{t("branches.previous")}</button><span>{t("branches.page", { page: pageIndex + 1, pages: pageCount })}</span><button type="button" className="game-secondary" disabled={pageIndex === pageCount - 1} onClick={() => setPage(pageIndex + 1)}>{t("branches.next")}</button></div>}
      <p className="game-muted game-small">{t("branches.archiveHelp")}</p>
      {currentCard && <div className="game-branches-controls"><label htmlFor={`${id}-rename`}>{t("branches.renameLabel")}</label><input id={`${id}-rename`} value={rename} maxLength={256} disabled={!canWrite} onChange={(event) => setRename(event.target.value)} />
        <div className="game-actions"><button type="button" className="game-secondary" disabled={!canWrite || rename.trim() === currentCard.name} onClick={() => edit(currentCard, { name: rename.trim() }, "branches.renamed")}>{t("branches.rename")}</button></div></div>}
      <details className="game-branches-controls"><summary>{t("branches.forkHeading")}</summary>
        <p className="game-muted game-small">{t("branches.recentHelp")}</p><label htmlFor={`${id}-source`}>{t("branches.source")}</label><select id={`${id}-source`} value={sourceId} disabled={!canFork} onChange={(event) => setSourceId(event.target.value)}>
          <option value="">{t("branches.initial")}</option>{world.turns.map((turn, index) => <option value={turn.turnId} key={turn.turnId}>{t("branches.turn", { count: world.turnCount - world.turns.length + index + 1 })}</option>)}</select>
        <label htmlFor={`${id}-new-name`}>{t("branches.newName")}</label><input id={`${id}-new-name`} value={newName} maxLength={256} disabled={!canFork} onChange={(event) => setNewName(event.target.value)} />
        <div className="game-actions"><button type="button" className="game-secondary" disabled={!canFork || !newName.trim()} onClick={() => fork(false)}>{t("branches.fork")}</button><button type="button" className="game-secondary" disabled={!canFork || !sourceId || !newName.trim()} onClick={() => fork(true)}>{t("branches.rewrite")}</button></div>
        <p className="game-muted game-small">{t("branches.rewriteHelp")}</p>
      </details>
      <details className="game-branches-controls"><summary>{t("branches.correctHeading")}</summary><p className="game-muted game-small">{t("branches.correctHelp")}</p>
        <label htmlFor={`${id}-correction-kind`}>{t("branches.correctKind")}</label><select id={`${id}-correction-kind`} value={correctionKind} disabled={!canFork} onChange={(event) => { setCorrectionKind(event.target.value as "name" | "cash"); setCorrectionValue(""); }}><option value="name">{t("branches.correctName")}</option><option value="cash" disabled={!canCorrectCash}>{t("branches.correctCash")}</option></select>
        {!canCorrectCash && <p className="game-muted game-small">{t("branches.correctCashUnavailable")}</p>}
        <label htmlFor={`${id}-correction-value`}>{t(correctionKind === "name" ? "branches.correctNameValue" : "branches.correctCashValue")}</label><input id={`${id}-correction-value`} value={correctionValue} maxLength={256} inputMode={correctionKind === "cash" ? "numeric" : "text"} disabled={!canFork} onChange={(event) => setCorrectionValue(event.target.value)} />
        <label htmlFor={`${id}-correct-name`}>{t("branches.newName")}</label><input id={`${id}-correct-name`} value={newName} maxLength={256} disabled={!canFork} onChange={(event) => setNewName(event.target.value)} />
        <div className="game-actions"><button type="button" className="game-secondary" disabled={!canFork || !newName.trim() || !correctionValue.trim() || (correctionKind === "cash" ? !canCorrectCash : !canCorrectName)} onClick={correct}>{t("branches.correct")}</button></div>
      </details>
    </>}
  </section>;
}
