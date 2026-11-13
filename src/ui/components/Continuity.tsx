// Small route-scoped records inside the existing people/journal panels.
// Manual changes append a sourced edit; they never ask a model or rewrite old rows.
import { useEffect, useState } from "react";
import { appendContinuity, readContinuity, type KnowledgeChange, type ProjectedKnowledge, type ProjectedThread, type ThreadChange } from "../../engine/continuity";
import { turnNumbers } from "../../engine/book";
import { newId } from "../../engine/db/repo";
import type { Person } from "../../engine/types";
import { useApp } from "../app/context";
import { Sheet } from "./Sheet";
import { Icon } from "./Icon";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const AWARENESS = [
  ["witnessed", "亲见"], ["told", "被告知"], ["believes", "相信"],
  ["rumor", "听闻"], ["denied", "已否认或澄清"], ["uncertain", "尚不确定"],
] as const;
const STATUS = [["open", "未解决"], ["resolved", "已解决"], ["dismissed", "已作废"]] as const;
const awarenessText = (value: KnowledgeChange["awareness"]) => AWARENESS.find(([key]) => key === value)?.[1] ?? "尚不确定";
const statusText = (value: ThreadChange["status"]) => STATUS.find(([key]) => key === value)?.[1] ?? "未解决";
const splitNames = (value: string) => [...new Set(value.split(/[、，,\n]+/).map(text => text.trim()).filter(Boolean))];

type RecordPerson = Pick<Person, "id" | "name" | "aliases">;
type Saved = () => void | Promise<void>;
function useRecords(worldId: string, headId: string) {
  const { game } = useApp();
  const [data, setData] = useState<Awaited<ReturnType<typeof readContinuity>> | null>(null);
  const [problem, setProblem] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setData(null); setProblem("");
    void readContinuity(game.repo, worldId, headId).then(next => { if (live) setData(next); }).catch(error => { if (live) setProblem(errorText(error)); });
    return () => { live = false; };
  }, [game, worldId, headId, revision]);
  return { data, problem, reload: () => setRevision(value => value + 1) };
}

/** A quotation is evidence of this claim, not proof that the claim itself is true. */
function SourceDetails({ record, headId }: { record: ProjectedKnowledge | ProjectedThread; headId: string }) {
  const { game } = useApp();
  const [open, setOpen] = useState(false), [label, setLabel] = useState("");
  const nodeId = record.source.nodeId || record.nodeId;
  useEffect(() => {
    let live = true;
    if (open) void game.repo.path(headId).then(path => {
      const number = turnNumbers(path).get(nodeId), node = path.find(item => item.id === nodeId);
      if (live) setLabel(node?.kind === "edit" ? "本局修改记录" : node?.kind === "opening" ? "开场" : number ? `第 ${number} 回合` : "本局记录");
    }).catch(() => { if (live) setLabel("本局记录"); });
    return () => { live = false; };
  }, [game, headId, nodeId, open]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="muted">查看依据</summary>
    <div className="stack gap-2 mt-2">
      <small className="muted">{label || "正在读取…"} · {record.source.from === "action" ? "行动或记录说明" : "本局正文"}</small>
      <p className="codex-text m-0">{record.source.quote}</p>
    </div>
  </details>;
}

function KnowledgeEditor({ record, person, worldId, headId, busy, onSaved, onClose }: {
  record: ProjectedKnowledge | null; person: RecordPerson; worldId: string; headId: string; busy: boolean; onSaved: Saved; onClose(): void;
}) {
  const { game, toast } = useApp();
  const [baseHead] = useState(headId);
  const [claim, setClaim] = useState(record?.claim ?? "");
  const [awareness, setAwareness] = useState<KnowledgeChange["awareness"]>(record?.awareness ?? "uncertain");
  const [active, setActive] = useState(record?.active !== false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false), [problem, setProblem] = useState("");
  const dirty = !!claim.trim() && (!record || claim.trim() !== record.claim || awareness !== record.awareness || active !== (record.active !== false) || !!note.trim());
  const stale = headId !== baseHead;
  const save = async () => {
    if (!claim.trim() || !dirty || stale) return;
    const quote = `你手动记录${person.name}的认知：${claim.trim()}；认知状态：${awarenessText(awareness)}；${active ? "保留此记录" : "撤下此记录"}${note.trim() ? `；依据或说明：${note.trim()}` : ""}。`;
    setSaving(true); setProblem("");
    try {
      await appendContinuity(game, worldId, baseHead, { knowledge: [{ id: record?.id ?? newId(), person: person.id, claim: claim.trim(), awareness, active, source: { from: "action", quote: quote.slice(0, 600) } }] });
      await onSaved(); toast("知情记录已保存，可撤销"); onClose();
    } catch (error) { setProblem(errorText(error)); } finally { setSaving(false); }
  };
  return <Sheet title={record ? "修改知情记录" : `记录${person.name}的认知`} onClose={onClose} dirty={dirty}>
    <div className="stack">
      <p className="muted m-0">记录这个人物如何理解某件事。听闻或相信不代表事情为真；这里的手动说明不会冒充原著原文。</p>
      <label>具体主张<textarea aria-label="人物认知的具体主张" rows={3} maxLength={600} value={claim} onChange={event => setClaim(event.target.value)} placeholder="如：他相信密信由王掌柜写成" /></label>
      <label>认知状态<select aria-label="认知状态" value={awareness} onChange={event => setAwareness(event.target.value as KnowledgeChange["awareness"])}>{AWARENESS.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
      <label>依据或更正说明（可不填）<textarea aria-label="知情依据或说明" rows={3} maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder="说明亲见、获知、传闻或更正的经过" /></label>
      {record && <><SourceDetails record={record} headId={headId} /><label className="row"><input type="checkbox" className="check-20" checked={active} onChange={event => setActive(event.target.checked)} />保留此记录</label><small className="muted">撤下不等于这个人物忘记或不知道；旧记录仍随原路线保留。</small></>}
      {stale && <p className="notice">故事已变化，请重新打开此记录后修改。</p>}
      {problem && <p className="notice">{problem}</p>}
      <button className="primary" disabled={busy || saving || stale || !dirty || !claim.trim()} onClick={() => void save()}>{saving ? "正在保存…" : "保存知情记录"}</button>
    </div>
  </Sheet>;
}

export function KnowledgeRecords({ worldId, headId, person, busy, onSaved }: {
  worldId: string; headId: string; person: RecordPerson; busy: boolean; onSaved?: Saved;
}) {
  const { data, problem, reload } = useRecords(worldId, headId);
  const [editing, setEditing] = useState<{ record: ProjectedKnowledge | null } | null>(null), [all, setAll] = useState(false);
  const names = new Set([person.id, person.name, ...person.aliases]);
  const records = (data?.knowledge ?? []).filter(item => names.has(item.person));
  const shown = records.filter(item => all || item.active !== false);
  const saved = async () => { reload(); await onSaved?.(); };
  return <details>
    <summary>关键知情{records.filter(item => item.active !== false).length ? ` · ${records.filter(item => item.active !== false).length}` : ""}</summary>
    <div className="stack mt-2">
      <p className="muted m-0">只记关键获知、误会与澄清；没有记录不代表此人不知情。</p>
      {problem && <p className="notice">{problem}</p>}
      {!!data?.ignoredEvents && <p className="notice">部分旧记录的原句或人物已变化，需重新核对；暂未作为有效依据。</p>}
      {!data && !problem && <small className="muted">正在读取…</small>}
      {shown.map(record => <div key={record.id} className="stack gap-2">
        <button className="item-row codex-item" disabled={busy} onClick={() => setEditing({ record })}><div className="grow"><b>{record.claim}</b><small>{awarenessText(record.awareness)}{record.active === false ? " · 已撤下" : ""}</small></div><Icon name="forward" size={16} /></button>
        <SourceDetails record={record} headId={headId} />
      </div>)}
      {data && !shown.length && <small className="muted">还没有符合条件的关键知情记录。</small>}
      <div className="row wrap"><button disabled={busy || !data} onClick={() => setEditing({ record: null })}><Icon name="plus" size={16} />手动记录</button>{records.some(record => record.active === false) && <button className="ghost" onClick={() => setAll(value => !value)}>{all ? "只看保留的" : "包括已撤下"}</button>}</div>
      {editing && <KnowledgeEditor record={editing.record} person={person} worldId={worldId} headId={headId} busy={busy} onSaved={saved} onClose={() => setEditing(null)} />}
    </div>
  </details>;
}

function ThreadEditor({ record, worldId, headId, busy, onSaved, onClose }: {
  record: ProjectedThread | null; worldId: string; headId: string; busy: boolean; onSaved: Saved; onClose(): void;
}) {
  const { game, toast } = useApp();
  const [baseHead] = useState(headId);
  const [kind, setKind] = useState<ThreadChange["kind"]>(record?.kind ?? "clue");
  const [title, setTitle] = useState(record?.title ?? ""), [detail, setDetail] = useState(record?.detail ?? "");
  const [status, setStatus] = useState<ThreadChange["status"]>(record?.status ?? "open");
  const [recall, setRecall] = useState(record?.recall !== false), [entities, setEntities] = useState(record?.entities?.join("、") ?? "");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false), [problem, setProblem] = useState("");
  const dirty = !!title.trim() && (!record || JSON.stringify([kind, title.trim(), detail.trim(), status, recall, splitNames(entities)]) !== JSON.stringify([record.kind, record.title, record.detail, record.status, record.recall !== false, record.entities ?? []]) || !!note.trim());
  const stale = headId !== baseHead;
  const save = async () => {
    if (!title.trim() || !dirty || stale) return;
    const quote = `你手动记录${kind === "promise" ? "承诺" : "线索"}：${title.trim()}${detail.trim() ? `；内容：${detail.trim()}` : ""}；状态：${statusText(status)}；${recall ? "参与回忆" : "暂不提醒"}${note.trim() ? `；依据或说明：${note.trim()}` : ""}。`;
    const change: ThreadChange = { id: record?.id ?? newId(), kind, title: title.trim(), detail: detail.trim() || title.trim(), status, recall, entities: splitNames(entities), source: { from: "action", quote: quote.slice(0, 600) }, ...(record?.dueMinute !== undefined ? { dueMinute: record.dueMinute } : {}) };
    setSaving(true); setProblem("");
    try { await appendContinuity(game, worldId, baseHead, { threads: [change] }); await onSaved(); toast("线索与承诺已保存，可撤销"); onClose(); }
    catch (error) { setProblem(errorText(error)); } finally { setSaving(false); }
  };
  return <Sheet title={record ? "修改线索与承诺" : "添加线索与承诺"} onClose={onClose} dirty={dirty}>
    <div className="stack">
      <p className="muted m-0">记下尚待追查或兑现的事，不会自动推进剧情，也不替代原来的目标。</p>
      <div className="segmented"><button aria-pressed={kind === "clue"} onClick={() => setKind("clue")}>线索</button><button aria-pressed={kind === "promise"} onClick={() => setKind("promise")}>承诺</button></div>
      <label>名称<input aria-label="线索或承诺名称" maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder="如：密信上的梅花印记" /></label>
      <label>内容与当前进展<textarea aria-label="线索或承诺内容" rows={4} maxLength={600} value={detail} onChange={event => setDetail(event.target.value)} placeholder="记录实际发现、约定以及仍不确定的地方" /></label>
      <label>相关人物或物件<input aria-label="相关人物或物件" value={entities} onChange={event => setEntities(event.target.value)} placeholder="用顿号分开，可不填" /></label>
      <label>剧情状态<select aria-label="线索或承诺状态" value={status} onChange={event => setStatus(event.target.value as ThreadChange["status"])}>{STATUS.map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
      <label className="row"><input type="checkbox" className="check-20" checked={recall} onChange={event => setRecall(event.target.checked)} />参与回忆</label>
      <p className="field-hint m-0">暂不提醒只影响回忆，不代表已解决。已解决或作废的记录仍可查看。</p>
      <label>依据或更正说明（可不填）<textarea aria-label="线索依据或说明" rows={2} maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder="说明新增、更正或改变状态的原因" /></label>
      {record && <SourceDetails record={record} headId={headId} />}
      {stale && <p className="notice">故事已变化，请重新打开此记录后修改。</p>}
      {problem && <p className="notice">{problem}</p>}
      <button className="primary" disabled={busy || saving || stale || !dirty || !title.trim()} onClick={() => void save()}>{saving ? "正在保存…" : "保存线索与承诺"}</button>
    </div>
  </Sheet>;
}

export function ThreadsSection({ worldId, headId, busy, onSaved }: { worldId: string; headId: string; busy: boolean; onSaved?: Saved }) {
  const { data, problem, reload } = useRecords(worldId, headId);
  const [all, setAll] = useState(false), [editing, setEditing] = useState<{ record: ProjectedThread | null } | null>(null);
  const shown = (data?.threads ?? []).filter(record => all || record.status === "open").sort((a, b) => Number(b.recall !== false) - Number(a.recall !== false));
  const saved = async () => { reload(); await onSaved?.(); };
  return <section className="stack gap-2">
    <div className="row between"><b>线索与承诺</b><button className="ghost" aria-label="添加线索或承诺" disabled={busy || !data} onClick={() => setEditing({ record: null })}><Icon name="plus" size={18} />添加</button></div>
    <p className="muted m-0">保留本条路线的关键线索和约定；不会自动安排后续。</p>
    {problem && <p className="notice">{problem}</p>}
    {!!data?.ignoredEvents && <p className="notice">部分旧记录的原句或人物已变化，需重新核对；暂未作为有效依据。</p>}
    {!data && !problem && <small className="muted">正在读取…</small>}
    {shown.map(record => <div className="stack gap-2" key={record.id}>
      <button className="item-row codex-item" disabled={busy} onClick={() => setEditing({ record })}><div className="grow"><b>{record.title}</b>{record.detail && <small>{record.detail}</small>}<small>{record.kind === "promise" ? "承诺" : "线索"} · {statusText(record.status)}{record.recall === false ? " · 暂不提醒" : ""}{record.entities?.length ? ` · ${record.entities.join("、")}` : ""}</small></div><Icon name="forward" size={16} /></button>
      <SourceDetails record={record} headId={headId} />
    </div>)}
    {data && !shown.length && <small className="muted">{all ? "还没有线索与承诺，可以手动添加。" : "还没有未解决的线索与承诺。"}</small>}
    {!!data?.threads.some(record => record.status !== "open") && <button className="ghost start" onClick={() => setAll(value => !value)}>{all ? "只看未解决" : "包括已解决与作废"}</button>}
    {editing && <ThreadEditor record={editing.record} worldId={worldId} headId={headId} busy={busy} onSaved={saved} onClose={() => setEditing(null)} />}
  </section>;
}
