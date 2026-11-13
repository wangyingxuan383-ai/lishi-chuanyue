// Sparse adopted changes live once in each node's record, never in every state snapshot.
import type { Repo } from "./db/repo";
import type { Game } from "./game";
import type { WorldState } from "./types";

export interface ContinuitySource { nodeId?: string; from: "narrative" | "action"; quote: string }
export interface KnowledgeChange { id: string; person: string; personName?: string; claim: string; awareness: "witnessed" | "told" | "believes" | "rumor" | "denied" | "uncertain"; source: ContinuitySource; active?: boolean }
export interface ThreadChange { id: string; kind: "clue" | "promise"; title: string; detail: string; status: "open" | "resolved" | "dismissed"; recall?: boolean; entities?: string[]; source: ContinuitySource; dueMinute?: number }
export interface ContinuityChanges { knowledge?: KnowledgeChange[]; threads?: ThreadChange[] }
export interface ProjectedKnowledge extends KnowledgeChange { nodeId: string; originNodeId: string; historyCount: number }
export interface ProjectedThread extends ThreadChange { nodeId: string; originNodeId: string; historyCount: number }
export interface ContinuityView { worldId: string; headId: string; knowledge: ProjectedKnowledge[]; threads: ProjectedThread[]; ignoredEvents: number }
const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => typeof v === "string" && !!v.trim() && v.trim().length <= max && !v.includes("\0") ? v.trim() : undefined;
const note = (issues: string[], message: string) => { if (issues.length < 20) issues.push(message); };

/** Optional annotations cannot make an otherwise usable story record fail parsing. */
export function normalizeContinuity(raw: unknown, issues: string[] = []): ContinuityChanges {
  if (raw == null) return {};
  if (!isObject(raw)) { note(issues, "知情与线索附加记录格式无效，已忽略"); return {}; }
  const out: ContinuityChanges = {};
  for (const kind of ["knowledge", "threads"] as const) {
    if (raw[kind] === undefined) continue;
    if (!Array.isArray(raw[kind])) { note(issues, "知情与线索应为变化列表，已忽略无效部分"); continue; }
    if (raw[kind].length > 8) note(issues, "本回合知情或线索变化过多，仅保留前8项");
    const clean: any[] = [], seen = new Set<string>();
    for (const value of raw[kind].slice(0, 8)) {
      const source = value?.source, id = text(value?.id, 100);
      let valid = !!id && isObject(source) && ["narrative", "action"].includes(source.from) && !!text(source.quote, 600) && (source.nodeId === undefined || !!text(source.nodeId, 100));
      const item: any = { id, source: { from: source?.from, quote: text(source?.quote, 600), ...(source?.nodeId !== undefined ? { nodeId: text(source.nodeId, 100) } : {}) } };
      if (kind === "knowledge") {
        Object.assign(item, { person: text(value?.person, 100), claim: text(value?.claim, 600), awareness: value?.awareness });
        valid = valid && !!item.person && !!item.claim && ["witnessed", "told", "believes", "rumor", "denied", "uncertain"].includes(item.awareness) && (value.active === undefined || typeof value.active === "boolean");
        if (value?.active !== undefined) item.active = value.active;
      } else {
        Object.assign(item, { kind: value?.kind, title: text(value?.title, 120), detail: text(value?.detail, 1200), status: value?.status });
        valid = valid && ["clue", "promise"].includes(item.kind) && !!item.title && !!item.detail && ["open", "resolved", "dismissed"].includes(item.status)
          && (value.recall === undefined || typeof value.recall === "boolean") && (value.dueMinute === undefined || Number.isSafeInteger(value.dueMinute) && value.dueMinute >= 0)
          && (value.entities === undefined || Array.isArray(value.entities) && value.entities.length <= 12 && value.entities.every((name: unknown) => text(name, 100)));
        for (const key of ["recall", "dueMinute"] as const) if (value?.[key] !== undefined) item[key] = value[key];
        if (Array.isArray(value?.entities)) item.entities = [...new Set(value.entities.map((name: string) => name.trim()))];
      }
      if (!valid) { note(issues, "知情或线索的字段/出处不完整，已忽略无效项"); continue; }
      if (seen.has(id!)) { note(issues, "同一回合的知情或线索编号重复，已忽略重复项"); continue; }
      seen.add(id!); clean.push(item);
    }
    if (clean.length) Object.assign(out, { [kind]: clean });
  }
  return out;
}

export function resolveKnowledgePerson(state: Pick<WorldState, "protagonist" | "people">, query: string): { person: string; personName: string } | null {
  const matches = (p: { id?: string; name: string; aliases?: string[] }) => p.id === query || p.name === query || p.aliases?.includes(query);
  const result = [
    ...(["主角", "protagonist"].includes(query) || matches(state.protagonist) ? [{ person: "protagonist", personName: state.protagonist.name }] : []),
    ...state.people.filter(matches).map(p => ({ person: p.id, personName: p.name })),
  ];
  return result.length === 1 ? result[0] : null;
}
const PATH = `WITH RECURSIVE up(id,parent_id) AS (SELECT id,parent_id FROM nodes WHERE id=? AND world_id=? UNION SELECT n.id,n.parent_id FROM nodes n JOIN up ON n.id=up.parent_id WHERE n.world_id=?)`;
async function pathRows(repo: Repo, worldId: string, headId: string) {
  const rows = await repo.platform.sql.query(`${PATH} SELECT n.id,n.parent_id,json_extract(n.record_json,'$.continuity') AS changes FROM nodes n JOIN up ON n.id=up.id`, [headId, worldId, worldId]);
  const byId = new Map(rows.map(row => [String(row.id), row]));
  const result: typeof rows = [], seen = new Set<string>(); let id: string | null = headId;
  while (id) { const row = byId.get(id); if (!row || seen.has(id)) throw new Error("知情与线索定位不属于这个故事的有效路线"); seen.add(id); result.push(row); id = row.parent_id ? String(row.parent_id) : null; }
  return result.reverse();
}
async function sourceValid(repo: Repo, worldId: string, source: ContinuitySource, allowed: Set<string>, current?: { id: string; narrative: string; action: string }) {
  if (!source.nodeId || !allowed.has(source.nodeId)) return false;
  if (current?.id === source.nodeId) return (source.from === "narrative" ? current.narrative : current.action).includes(source.quote);
  const [row] = await repo.platform.sql.query("SELECT narrative,action_text,director_note FROM nodes WHERE id=? AND world_id=?", [source.nodeId, worldId]);
  return !!row && (source.from === "narrative" ? String(row.narrative) : `${row.action_text ?? ""}\n${row.director_note ?? ""}`).includes(source.quote);
}
async function nodeActors(repo: Repo, nodeId: string): Promise<Pick<WorldState, "protagonist" | "people">> {
  const [heroRows, people] = await Promise.all([
    repo.platform.sql.query("SELECT json_extract(state_json,'$.protagonist.name') AS name,json_extract(state_json,'$.protagonist.aliases') AS aliases FROM states WHERE node_id=?", [nodeId]),
    repo.platform.sql.query("SELECT json_extract(p.value,'$.id') AS id,json_extract(p.value,'$.name') AS name,json_extract(p.value,'$.aliases') AS aliases FROM states s,json_each(s.state_json,'$.people') p WHERE s.node_id=?", [nodeId]),
  ]);
  const row = heroRows[0];
  return { protagonist: { name: String(row?.name ?? ""), aliases: JSON.parse(String(row?.aliases ?? "[]")) } as WorldState["protagonist"], people: people.map(person => ({ id: String(person.id), name: String(person.name), aliases: JSON.parse(String(person.aliases ?? "[]")) })) as WorldState["people"] };
}
function parse(raw: unknown) { try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; } }

export async function readContinuity(repo: Repo, worldId: string, headId: string): Promise<ContinuityView> {
  const knowledge = new Map<string, ProjectedKnowledge>(), threads = new Map<string, ProjectedThread>(), allowed = new Set<string>(); let ignoredEvents = 0;
  for (const row of await pathRows(repo, worldId, headId)) {
    const id = String(row.id); allowed.add(id);
    const issues: string[] = [], changes = normalizeContinuity(parse(row.changes), issues); ignoredEvents += issues.length;
    const actors = changes.knowledge?.length ? await nodeActors(repo, id) : null;
    for (const kind of ["knowledge", "threads"] as const) for (const raw of changes[kind] ?? []) {
      const item: any = { ...raw, source: { ...raw.source, nodeId: raw.source.nodeId ?? id } };
      const map: Map<string, any> = kind === "knowledge" ? knowledge : threads, previous = map.get(item.id);
      if (!await sourceValid(repo, worldId, item.source, allowed)) { ignoredEvents++; continue; }
      if (kind === "knowledge") {
        const actor = actors && resolveKnowledgePerson(actors, item.person);
        if (!actor || previous && previous.person !== actor.person) { ignoredEvents++; continue; }
        Object.assign(item, actor); item.active ??= true;
      } else item.recall ??= true;
      Object.assign(item, { nodeId: id, originNodeId: previous?.originNodeId ?? id, historyCount: (previous?.historyCount ?? 0) + 1 }); map.set(item.id, item);
    }
  }
  return { worldId, headId, knowledge: [...knowledge.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), threads: [...threads.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), ignoredEvents };
}

export async function validateContinuity(repo: Repo, worldId: string, baseHead: string | null, currentId: string, narrative: string, action: string, state: WorldState, raw: unknown, strict: boolean) {
  const issues: string[] = [], changes = normalizeContinuity(raw, issues), clean: ContinuityChanges = {};
  let rows: Awaited<ReturnType<typeof pathRows>>, previous: Pick<ContinuityView, "knowledge">;
  try {
    rows = baseHead ? await pathRows(repo, worldId, baseHead) : [];
    previous = baseHead ? await readContinuity(repo, worldId, baseHead) : { knowledge: [] };
  } catch (error) {
    if (strict) throw error;
    note(issues, "历史资料未能校对，本回合附加知情与线索未保存");
    return { changes: clean, issues };
  }
  const allowed = new Set([...rows.map(row => String(row.id)), currentId]);
  for (const kind of ["knowledge", "threads"] as const) for (const raw of changes[kind] ?? []) {
    const item: any = { ...raw, source: { ...raw.source, nodeId: raw.source.nodeId ?? currentId } };
    if (!await sourceValid(repo, worldId, item.source, allowed, { id: currentId, narrative, action })) { note(issues, "知情或线索的引文不存在于当前路线的指定正文/玩家行动中"); continue; }
    if (kind === "knowledge") {
      const actor = resolveKnowledgePerson(state, item.person), prior = previous.knowledge.find(old => old.id === item.id);
      if (!actor || prior && prior.person !== actor.person) { note(issues, "知情记录的人物不存在、名字不唯一或同一编号改指其他人物"); continue; }
      Object.assign(item, actor);
    }
    (clean[kind] ??= [] as any).push(item);
  }
  if (strict && issues.length) throw new Error(issues.join("；"));
  return { changes: clean, issues };
}

/** Direct edits are explicit player statements, not evidence that canon says the same thing. */
export async function appendContinuity(game: Game, worldId: string, headId: string, changes: ContinuityChanges): Promise<void> {
  const action = [...changes.knowledge ?? [], ...changes.threads ?? []].map(item => item.source.quote.trim()).join("\n");
  await game.editState(worldId, { continuity: changes }, action, undefined, headId);
}

/** A small relevance view, never an extra permanent summary or a claim of complete knowledge. */
export function continuityBlock(view: ContinuityView | undefined, query: string, cap = 1200): string {
  if (!view) return "";
  const lines: string[] = [];
  const rank = (value: any) => [value.personName, value.title, ...value.entities ?? []].filter(Boolean).some(word => query.includes(word)) ? 1 : 0;
  const candidates = [
    ...view.knowledge.filter(item => item.active !== false && (item.person === "protagonist" || !!item.personName && query.includes(item.personName))).map(item => ({ ...item, text: `人物${item.personName ?? item.person}：${item.claim}（${item.awareness}，${item.nodeId}，不等同世界真相）` })),
    ...view.threads.filter(item => item.status === "open" && item.recall !== false).map(item => ({ ...item, text: `${item.kind === "promise" ? "约定" : "线索"}${item.title}：${item.detail}（${item.nodeId}）` })),
  ].sort((a, b) => rank(b) - rank(a));
  let used = 100;
  for (const item of candidates) { const line = item.text.slice(0, 350); if (used + line.length > cap) continue; used += line.length + 1; lines.push(line); if (lines.length >= 8) break; }
  return lines.length ? `\n【本局关键知情与未完事项（部分；可用read_continuity回读原句，不强行安排后续）】\n${lines.join("\n")}` : "";
}

/** Copying a story node must carry its quotations to the copied node ids too. */
export function remapContinuity(changes: ContinuityChanges | undefined, map: (id: string) => string): ContinuityChanges | undefined {
  if (!changes) return undefined;
  return Object.fromEntries(Object.entries(changes).map(([kind, rows]) => [kind, rows.map((row: any) => ({ ...row, source: { ...row.source, ...(row.source.nodeId ? { nodeId: map(row.source.nodeId) } : {}) } }))]));
}
