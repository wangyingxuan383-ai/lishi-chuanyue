import { useEffect, useId, useRef, useState } from "react";
import { cancelGameTurn, hasGameCore, type GameWorld } from "./gameClient";
import {
  addConclusion, adoptResearch, deleteResearchProfile, describeResearchError, getResearchProfile,
  listResearch, researchHistory, saveResearchProfile, validResearchEra, validResearchQuestion,
  type ResearchConclusion, type ResearchEra, type ResearchProfile, type ResearchQuery, type ResearchRecord, type ResearchReply,
} from "./gameResearchClient";
import { researchT as t } from "./gameResearchMessages";
import "./gameResearch.css";

interface Props { world: GameWorld; busy: boolean; disabled: boolean; branchesEnabled: boolean; beginWrite: () => boolean; endWrite: () => void }
const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" });
const defaultEndpoint = "https://api.search.brave.com/res/v1/web/search";
const boundedText = (value: string, max: number) => value.trim().length > 0 && new TextEncoder().encode(value).length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value);
function readEra(start: string, end: string): ResearchEra | null | undefined {
  if (!start.trim() && !end.trim()) return null;
  if (!/^-?\d{1,6}$/u.test(start.trim()) || !/^-?\d{1,6}$/u.test(end.trim())) return undefined;
  const value = { startYear: Number(start), endYear: Number(end) };
  return validResearchEra(value) ? value : undefined;
}
function RecordView({ record, canAdopt, onAdopt }: { record: ResearchRecord; canAdopt: boolean; onAdopt: () => void }) {
  return <article className="game-research-record"><h3>{record.query.query}</h3><p className="game-muted">{t("note")}</p>
    {record.sources.length === 0 && <p>{t("emptyResults")}</p>}
    <ol>{record.sources.map(source => <li key={source.id}>
      <a href={source.url} target="_blank" rel="noreferrer noopener">{source.title}</a><blockquote>{source.excerpt}</blockquote>
      <small>{t("date")}：{clock.format(source.accessedAtMs)}（Asia/Shanghai）</small>
      <details><summary>{t("sourceDetails")}</summary><p>{source.id}</p><p>{source.requestedEra ? `${source.requestedEra.startYear} ~ ${source.requestedEra.endYear}` : t("noEra")}</p><p>{source.url}</p></details>
    </li>)}</ol>
    <ul>{record.conclusions.map(c => <li key={c.id}><strong>{t(c.status)}</strong>：{c.statement}
      {c.conflictsWith.length > 0 && <p className="game-small">{t("conflictWith")}：{c.conflictsWith.map(other => record.conclusions.find(item => item.id === other)?.statement).join("；")}</p>}
      {c.temporalConstraints.map((constraint, index) => <p className="game-small" key={index}>{t("constraints")}：{constraint.era.startYear} ~ {constraint.era.endYear} · {constraint.label}</p>)}
    </li>)}</ul>
    <button type="button" className="game-secondary" disabled={!canAdopt || record.sources.length === 0} onClick={onAdopt}>{t("adopt")}</button>
    <p className="game-muted game-small">{t("selected")}</p>
  </article>;
}
export default function GameResearch({ world, busy, disabled, branchesEnabled, beginWrite, endWrite }: Props) {
  const id = useId(), native = hasGameCore(), scope = JSON.stringify([world.setup.worldId, world.branchId, world.headTurnId]);
  const current = useRef(scope); current.current = scope;
  const mounted = useRef(false), working = useRef(false), profileRevision = useRef(-1), profileRequest = useRef(0), adoptedRequest = useRef(0);
  const [profile, setProfile] = useState<ResearchProfile | null>(null), [token, setToken] = useState(""), [endpoint, setEndpoint] = useState(defaultEndpoint), [language, setLanguage] = useState("zh-hans");
  const [question, setQuestion] = useState(""), [topic, setTopic] = useState<ResearchQuery["topic"]>("general"), [force, setForce] = useState(false);
  const [queryStart, setQueryStart] = useState(""), [queryEnd, setQueryEnd] = useState("");
  const [reply, setReply] = useState<ResearchReply | null>(null), [adopted, setAdopted] = useState<ResearchRecord[]>([]);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [running, setRunning] = useState(false), [operation, setOperation] = useState<string | null>(null), [cancelling, setCancelling] = useState(false);
  const [statement, setStatement] = useState(""), [status, setStatus] = useState<ResearchConclusion["status"]>("unknown");
  const [conclusionStart, setConclusionStart] = useState(""), [conclusionEnd, setConclusionEnd] = useState(""), [constraintLabel, setConstraintLabel] = useState(""), [conflicts, setConflicts] = useState<string[]>([]);
  const still = (frozen: string) => mounted.current && current.current === frozen;
  function acceptProfile(value: ResearchProfile) {
    if (!mounted.current || value.revision < profileRevision.current) return;
    profileRevision.current = value.revision; setProfile(value);
    setEndpoint(value.config?.endpoint ?? defaultEndpoint); setLanguage(value.config?.searchLanguage ?? "zh-hans");
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!native) return;
    const request = ++profileRequest.current;
    void getResearchProfile().then(value => { if (request === profileRequest.current) acceptProfile(value); })
      .catch(cause => { if (mounted.current && request === profileRequest.current) setError(describeResearchError(cause)); });
    return () => { profileRequest.current++; };
  }, [native]);
  useEffect(() => {
    setReply(null); setError(null); setNotice(null); setAdopted([]); setToken("");
    setStatement(""); setConflicts([]); setConclusionStart(""); setConclusionEnd(""); setConstraintLabel("");
    if (!native) return;
    const frozen = scope, request = ++adoptedRequest.current;
    void listResearch(world.setup.worldId, world.branchId, world.headTurnId)
      .then(value => { if (still(frozen) && request === adoptedRequest.current) setAdopted(value); })
      .catch(cause => { if (still(frozen) && request === adoptedRequest.current) setError(describeResearchError(cause)); });
    return () => { adoptedRequest.current++; };
  }, [native, scope]);
  const blocked = !native || disabled || busy || running;
  const queryEra = readEra(queryStart, queryEnd), conclusionEra = readEra(conclusionStart, conclusionEnd);
  const questionValid = validResearchQuestion(question.trim()), statementValid = boundedText(statement.trim(), 4096);
  const constraintValid = conclusionEra === null || (conclusionEra !== undefined && boundedText(constraintLabel.trim(), 256));
  async function write(action: () => Promise<void>) {
    if (blocked || working.current || !beginWrite()) return;
    working.current = true; setRunning(true); setError(null); setNotice(null); const frozen = scope;
    try { await action(); } catch (cause) { if (still(frozen)) setError(describeResearchError(cause)); }
    finally { working.current = false; endWrite(); if (mounted.current) { setRunning(false); setOperation(null); setCancelling(false); } }
  }
  async function search() {
    if (!questionValid || queryEra === undefined) return;
    const frozen = scope, operationId = crypto.randomUUID();
    await write(async () => {
      setOperation(operationId); setCancelling(false);
      const value = await researchHistory(world.setup.worldId, world.branchId, world.headTurnId, operationId,
        { query: question.trim(), topic, era: queryEra, entityTags: [], region: world.setup.country }, force);
      if (!still(frozen)) return;
      setReply(value); setConflicts([]);
      if (value.operation?.status === "cancelled") setNotice(t("cancelled"));
      else if (value.operation?.status === "failed" || value.operation?.status === "interrupted") setError(t("incomplete"));
      else setNotice(value.cached ? t("cached") : t("searched"));
    });
  }
  async function cancel() {
    if (!operation || cancelling) return;
    const frozen = scope; setCancelling(true);
    try { await cancelGameTurn(operation); if (still(frozen) && working.current) setNotice(t("cancelPending")); }
    catch (cause) { if (still(frozen)) { setCancelling(false); setError(describeResearchError(cause)); } }
  }
  async function adopt(record: ResearchRecord) {
    const frozen = scope;
    await write(async () => {
      await adoptResearch(world.setup.worldId, world.branchId, world.headTurnId, record);
      const request = ++adoptedRequest.current, values = await listResearch(world.setup.worldId, world.branchId, world.headTurnId);
      if (still(frozen) && request === adoptedRequest.current) { setAdopted(values); setNotice(t("adoptSaved")); }
    });
  }
  async function saveProfile(remove: boolean) {
    if (!profile) return;
    const expectedRevision = profile.revision, frozen = scope, enteredToken = token || null;
    await write(async () => {
      setToken(""); profileRequest.current++;
      const value = remove ? await deleteResearchProfile(expectedRevision)
        : await saveResearchProfile({ endpoint: endpoint.trim(), searchLanguage: language.trim() || null }, enteredToken, expectedRevision);
      acceptProfile(value); if (still(frozen)) setNotice(t(remove ? "configDeleted" : "configSaved"));
    });
  }
  async function append() {
    const frozen = scope, previous = reply;
    if (!previous?.record || !statementValid || conclusionEra === undefined || !constraintValid) return;
    const value: ResearchConclusion = { id: crypto.randomUUID(), statement: statement.trim(), status,
      sourceIds: previous.record.sources.map(source => source.id), conflictsWith: conflicts,
      temporalConstraints: conclusionEra ? [{ label: constraintLabel.trim(), era: conclusionEra }] : [] };
    await write(async () => {
      const record = await addConclusion(previous.record!.id, value);
      if (still(frozen)) { setReply({ ...previous, record }); setStatement(""); setConflicts([]); setConclusionStart(""); setConclusionEnd(""); setConstraintLabel(""); setNotice(t("conclusionSaved")); }
    });
  }
  return <section className="game-research" aria-labelledby={`${id}-heading`}>
    <h2 id={`${id}-heading`}>{t("heading")}</h2><p className="game-muted">{t("help")}</p>
    <details><summary>{t("profile")}</summary><p>{profile?.configured ? t("configured") : t("missing")}</p>
      <label htmlFor={`${id}-endpoint`}>{t("endpoint")}<input id={`${id}-endpoint`} value={endpoint} disabled={blocked} onChange={e => setEndpoint(e.target.value)} /></label>
      <label htmlFor={`${id}-language`}>{t("language")}<input id={`${id}-language`} value={language} disabled={blocked} onChange={e => setLanguage(e.target.value)} /></label>
      <label htmlFor={`${id}-key`}>{t("key")}<input id={`${id}-key`} type="password" autoComplete="off" value={token} disabled={blocked} onChange={e => setToken(e.target.value)} placeholder={t("keyPlaceholder")} /></label>
      <div className="game-actions"><button type="button" className="game-secondary" disabled={blocked || !profile} onClick={() => void saveProfile(false)}>{t("save")}</button>
        <button type="button" className="game-secondary game-danger" disabled={blocked || !profile?.config} onClick={() => void saveProfile(true)}>{t("delete")}</button></div>
    </details>
    <label htmlFor={`${id}-query`}>{t("query")}<textarea id={`${id}-query`} value={question} disabled={blocked} aria-describedby={`${id}-query-limit`} aria-invalid={!!question.trim() && !questionValid} onChange={e => setQuestion(e.target.value)} placeholder={t("queryPlaceholder")} /></label>
    <p id={`${id}-query-limit`} className="game-muted game-small">{t("queryLimit")}</p>
    {!!question.trim() && !questionValid && <p className="game-error">{t("queryInvalid")}</p>}
    <label htmlFor={`${id}-topic`}>{t("topic")}<select id={`${id}-topic`} value={topic} disabled={blocked} onChange={e => setTopic(e.target.value as ResearchQuery["topic"])}>{(["general", "person", "office", "place", "technology", "chronology"] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
    <div className="game-research-grid"><label htmlFor={`${id}-query-start`}>{t("queryEraStart")}<input id={`${id}-query-start`} inputMode="text" value={queryStart} disabled={blocked} onChange={e => setQueryStart(e.target.value)} /></label><label htmlFor={`${id}-query-end`}>{t("queryEraEnd")}<input id={`${id}-query-end`} inputMode="text" value={queryEnd} disabled={blocked} onChange={e => setQueryEnd(e.target.value)} /></label></div>
    <p className="game-muted game-small">{t("eraHelp")}</p>{queryEra === undefined && <p className="game-error">{t("eraInvalid")}</p>}
    <label className="game-research-check"><input type="checkbox" checked={force} disabled={blocked} onChange={e => setForce(e.target.checked)} />{t("refresh")}</label>
    <div className="game-actions"><button type="button" className="game-secondary" disabled={blocked || !questionValid || queryEra === undefined} onClick={() => void search()}>{running ? t(operation ? "running" : "working") : t("search")}</button>
      {running && operation && <button type="button" className="game-secondary game-danger" disabled={cancelling} onClick={() => void cancel()}>{t(cancelling ? "cancelling" : "cancel")}</button>}</div>
    {notice && <p role="status" className="game-research-status">{notice}</p>}{error && <p role="alert" className="game-error">{error}</p>}
    {reply?.operation && <details><summary>{t("diagnostics")}</summary><p>{t("searchBudget")} {reply.operation.searchSlotsUsed}/1 · HTTP {reply.operation.httpAttemptsKnown ? reply.operation.diagnostics.httpAttempts : t("unknown")}</p><p>{t("httpStatus")} {reply.operation.diagnostics.httpStatus ?? t("unknown")} · {t("costUnknown")}</p></details>}
    {reply?.warnings.map((warning, index) => <p key={index} className="game-notice">{t("warning")}：{warning.label}（{t(warning.status)}）</p>)}
    {reply?.record && !branchesEnabled && <p className="game-notice">{t("upgradeNeeded")}</p>}
    {reply?.record && <RecordView record={reply.record} canAdopt={!blocked && world.state.protocolVersion === 2 && branchesEnabled} onAdopt={() => void adopt(reply.record!)} />}
    {reply?.record && <details><summary>{t("conclusion")}</summary><p className="game-muted">{t("conclusionHelp")}</p>
      <label htmlFor={`${id}-statement`}>{t("statement")}<textarea id={`${id}-statement`} value={statement} disabled={blocked} onChange={e => setStatement(e.target.value)} /></label>
      {!!statement.trim() && !statementValid && <p className="game-error">{t("statementInvalid")}</p>}
      <label htmlFor={`${id}-status`}>{t("status")}<select id={`${id}-status`} value={status} disabled={blocked} onChange={e => setStatus(e.target.value as ResearchConclusion["status"])}>{(["unknown", "evidence", "inference", "disputed"] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
      {reply.record.conclusions.length > 0 && <fieldset className="game-research-conflicts" disabled={blocked}><legend>{t("conflicts")}</legend>{reply.record.conclusions.map(existing => <label className="game-research-check" key={existing.id}><input type="checkbox" checked={conflicts.includes(existing.id)} disabled={blocked || (!conflicts.includes(existing.id) && conflicts.length >= 16)} onChange={e => setConflicts(values => e.target.checked ? [...values, existing.id] : values.filter(value => value !== existing.id))} />{existing.statement}</label>)}</fieldset>}
      <div className="game-research-grid"><label htmlFor={`${id}-conclusion-start`}>{t("conclusionEraStart")}<input id={`${id}-conclusion-start`} value={conclusionStart} disabled={blocked} onChange={e => setConclusionStart(e.target.value)} /></label><label htmlFor={`${id}-conclusion-end`}>{t("conclusionEraEnd")}<input id={`${id}-conclusion-end`} value={conclusionEnd} disabled={blocked} onChange={e => setConclusionEnd(e.target.value)} /></label></div>
      <label htmlFor={`${id}-constraint-label`}>{t("constraintLabel")}<input id={`${id}-constraint-label`} value={constraintLabel} disabled={blocked} onChange={e => setConstraintLabel(e.target.value)} /></label><p className="game-muted game-small">{t("constraintHelp")}</p>
      {conclusionEra === undefined && <p className="game-error">{t("eraInvalid")}</p>}{conclusionEra !== null && !constraintValid && <p className="game-error">{t("constraintInvalid")}</p>}
      <button type="button" className="game-secondary" disabled={blocked || !statementValid || conclusionEra === undefined || !constraintValid || (status !== "unknown" && reply.record.sources.length === 0)} onClick={() => void append()}>{t("append")}</button>
    </details>}
    <details><summary>{t("adopted")}（{adopted.length}）</summary>{adopted.length ? adopted.slice(-32).map((record, index) => <RecordView key={`${record.id}:${index}`} record={record} canAdopt={false} onAdopt={() => {}} />) : <p>{t("none")}</p>}</details>
  </section>;
}
