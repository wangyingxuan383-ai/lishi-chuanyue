import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { archiveProblems, exportWorld, importWorld } from "./archive";
import { migrate } from "./db/migrate";
import { MIGRATIONS } from "./db/migrations";
import { Repo } from "./db/repo";
import { newChallenge, newScript } from "./modes";
import { sampleState } from "./testing/fixtures";
import * as tree from "./tree";
import { DEFAULT_SETTINGS } from "./types";

async function emptyRepo() {
  const platform = await createMemoryPlatform();
  await migrate(platform);
  return new Repo(platform);
}

/** A world with turns, a second line, a bookmark, a pin and a chapter. */
async function richWorld(repo: Repo) {
  const { world } = await repo.createWorld({ title: "长安", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState() } });
  let c = await tree.cursor(repo, world.id);
  for (const t of ["一", "二", "三"]) c = await tree.append(repo, c, { kind: "turn", actionMode: "do", actionText: t, narrative: `第${t}段`, state: sampleState(300 + t.length), meta: { chips: [{ text: t, tone: "info" }] } });
  const side = await repo.createLine(world.id, (await repo.path(c.head.id))[1].id, "岔路", false);
  await tree.addBookmark(repo, world.id, c.head.id, "书签");
  await repo.addPin(world.id, c.head.id, "王掌柜是舅舅");
  await repo.addChapter({ worldId: world.id, firstNodeId: (await repo.path(c.head.id))[1].id, lastNodeId: c.head.id, title: "第一章", gist: "梗概", summary: "摘要", model: "aux", promptVersion: "chapter-1" });
  return { worldId: world.id, side };
}

/** Everything about a world except its ids, to compare two copies. */
async function content(repo: Repo, worldId: string) {
  const c = await tree.cursor(repo, worldId);
  const path = await repo.path(c.head.id);
  return {
    path: path.map((n) => [n.kind, n.actionText, n.narrative, n.meta]),
    states: await Promise.all(path.map((n) => repo.getState(n.id))),
    lines: (await repo.lines(worldId)).map((l) => [l.name, l.kind]),
    pins: (await repo.pinsOnPath(worldId, c.head.id)).map((p) => p.text),
    chapters: (await repo.chaptersOnPath(worldId, c.head.id)).map((x) => [x.title, x.gist, x.summary]),
  };
}

describe("world archive", () => {
  it.each(["agent", "classic", "unknown", null, { legacy: true }])("ignores legacy executionMode %j without rewriting old snapshots", async (mode) => {
    const repo = await emptyRepo(), { worldId } = await richWorld(repo);
    const cursor = await tree.cursor(repo, worldId);
    const legacy = { ...await repo.getState(cursor.head.id), executionMode: mode };
    await repo.platform.sql.batch([{ sql: "UPDATE states SET state_json=? WHERE node_id=?", params: [JSON.stringify(legacy), cursor.head.id] }]);
    const file = await exportWorld(repo, worldId);
    expect(archiveProblems(file)).toEqual([]);
    const copy = await importWorld(repo, file, "new"), copied = await tree.cursor(repo, copy);
    expect(await repo.getState(copied.head.id)).toHaveProperty("executionMode", mode);
    expect(await repo.getState(cursor.head.id)).toEqual(legacy);
  });

  it("upgrades an existing version-six database without changing stories or old task snapshots", async () => {
    const platform = await createMemoryPlatform();
    await platform.sql.batch([{ sql: "CREATE TABLE schema_version(version INTEGER NOT NULL)" }]);
    for (const migration of MIGRATIONS.filter((item) => item.version <= 6)) await platform.sql.batch([{ sql: migration.sql }, { sql: "INSERT INTO schema_version(version) VALUES(?)", params: [migration.version] }]);
    const repo = new Repo(platform), { worldId } = await richWorld(repo), cursor = await tree.cursor(repo, worldId), time = new Date().toISOString();
    await platform.sql.batch([
      { sql: "INSERT INTO agent_sessions VALUES(?,?,?,?,?,?)", params: ["old-session", worldId, cursor.line.id, "原有任务", time, time] },
      { sql: "INSERT INTO agent_tasks(id,session_id,run_id,text,policy,status,base_json,created_at,updated_at) VALUES(?,?,?,?,?,'failed',?,?,?)", params: ["old-task", "old-session", "old-run", "未完成的查证", "auto-reversible", '{"permissions":"original-snapshot"}', time, time] },
    ]);
    const before = await content(repo, worldId), oldTasks = await platform.sql.query("SELECT * FROM agent_tasks");
    expect(await migrate(platform)).toBe(MIGRATIONS.at(-1)!.version);
    expect(await content(repo, worldId)).toEqual(before);
    expect(await platform.sql.query("SELECT * FROM agent_tasks")).toEqual(oldTasks);
    expect(await platform.sql.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agent_control','agent_inputs','agent_session_links','agent_subtasks')")).toHaveLength(4);
    expect(await platform.sql.listBackups()).toHaveLength(1);
    expect(await migrate(platform)).toBe(MIGRATIONS.at(-1)!.version);
    expect(await platform.sql.listBackups()).toHaveLength(1);
  });

  it("exports version seven and continues to read earlier formal stories", async () => {
    const repo = await emptyRepo();
    const { worldId } = await richWorld(repo);
    const file = await exportWorld(repo, worldId);
    expect(file.version).toBe(7);
    const old = { ...file, version: 1 };
    const copy = await importWorld(repo, old, "new");
    expect(await content(repo, copy)).toEqual(await content(repo, worldId));
    const copyTwo = await importWorld(repo, { ...file, version: 2 }, "new");
    expect(await content(repo, copyTwo)).toEqual(await content(repo, worldId));
    const copyThree = await importWorld(repo, { ...file, version: 3 }, "new");
    expect(await content(repo, copyThree)).toEqual(await content(repo, worldId));
    const copyFour = await importWorld(repo, { ...file, version: 4 }, "new");
    expect(await content(repo, copyFour)).toEqual(await content(repo, worldId));
    const copyFive = await importWorld(repo, { ...file, version: 5 }, "new");
    expect(await content(repo, copyFive)).toEqual(await content(repo, worldId));
    expect(archiveProblems({ ...file, version: 0 })).toEqual(["存档格式版本无效"]);
  });
  it("preserves readable Pi history and formal sources across format-seven import and re-export", async () => {
    const repo=await emptyRepo(), {worldId}=await richWorld(repo), cursor=await tree.cursor(repo,worldId), at=new Date().toISOString();
    const hidden="private-credential-marker";
    const history={messages:[{id:"reply",role:"assistant",content:"已核对"}],steps:[],plan:[{id:"p",title:"核对",status:"completed"}],sources:[],result:{status:"committed",summary:"已采用",apiKey:hidden}};
    await repo.platform.sql.batch([
      {sql:"INSERT INTO pi_sessions(id,world_id,line_id,title,session_file,created_at,updated_at) VALUES('ps',?,?,?,? ,?,?)",params:[worldId,cursor.line.id,"Pi记录",hidden,at,at]},
      {sql:"INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,base_json,base_world_version,result_json,created_at,updated_at) VALUES('pt','ps',?,?,?,'archived','auto-reversible','{}','',?,?,?)",params:[worldId,cursor.line.id,"核对日期",JSON.stringify({history}),at,at]},
      {sql:"INSERT INTO story_fact_sources VALUES('source',?,?,?,'state',?,'batch','pt','local_consistency','日期校准',?,?)",params:[worldId,cursor.line.id,cursor.head.id,cursor.head.id,JSON.stringify({findingId:"f",references:[{quote:"玩家原句",location:{nodeId:cursor.head.id,lineId:cursor.line.id},apiKey:hidden}],authorization:hidden}),at]},
    ]);
    const external={sourceClaim:"网页确实记载青桥旧称",contentHash:"sha256:page",readAt:"2026-11-01",revisionDecision:{summary:"补充地名",reason:"与本局位置一致",appliesTo:"world_rule",localReferences:[{quote:"本局青桥",location:{nodeId:cursor.head.id},authorization:hidden}]},references:[{quote:"青桥旧称",sourceKind:"external",location:{url:"https://example.invalid/page?id=2&token="+hidden+"#secret",contentHash:"sha256:page",readAt:"2026-11-01",grantId:hidden},apiKey:hidden}],grantId:hidden,packageCode:hidden};
    await repo.platform.sql.batch([{sql:"INSERT INTO story_fact_sources VALUES('web-source',?,?,?,'state',?,'batch','pt','external','地名依据',?,?)",params:[worldId,cursor.line.id,cursor.head.id,cursor.head.id,JSON.stringify(external),at]}]);
    const file=await exportWorld(repo,worldId);
    expect(file.version).toBe(7);expect(archiveProblems(file)).toEqual([]);expect(file.pi?.tasks).toHaveLength(1);
    expect(JSON.stringify(file)).not.toContain(hidden);
    const copy=await importWorld(repo,file,"new");
    const [task]=await repo.platform.sql.query("SELECT * FROM pi_tasks WHERE world_id=?",[copy]);
    expect(task.status).toBe("archived");expect(task.base_json).toBe("{}");expect(task.workspace_json).toBe("{}");
    const [session]=await repo.platform.sql.query("SELECT * FROM pi_sessions WHERE world_id=?",[copy]);expect(session.session_file).toBeNull();
    const [source]=await repo.platform.sql.query("SELECT * FROM story_fact_sources WHERE world_id=? AND basis='local_consistency'",[copy]);
    expect(source.node_id).not.toBe(cursor.head.id);expect(JSON.parse(String(source.source_json)).references[0].location.nodeId).toBe(source.node_id);
    const again=await exportWorld(repo,copy);expect(again.pi?.tasks[0].history).toMatchObject({messages:[{role:"assistant",content:"已核对"}]});expect(again.factSources).toHaveLength(2);
    const web=again.factSources!.find(row=>row.basis==="external")!;
    const evidence=JSON.parse(String(web.source_json));
    expect(evidence.sourceClaim).toBe(external.sourceClaim);expect(evidence.revisionDecision).toMatchObject({summary:"补充地名",appliesTo:"world_rule"});
    expect(evidence.references[0].location).toEqual({url:"https://example.invalid/page?id=2",contentHash:"sha256:page",readAt:"2026-11-01"});
    expect(JSON.stringify(again)).not.toContain(hidden);
    for(const table of ["agent_capability_grants","agent_tool_packages","pi_resource_snapshots"]) expect(await repo.platform.sql.query(`SELECT * FROM ${table}`)).toHaveLength(0);
  });
  it("ignores disabled pre-Pi agent payloads in old world formats",async()=>{
    const repo=await emptyRepo(),{worldId}=await richWorld(repo),file=await exportWorld(repo,worldId);
    for(const version of [1,2,3,4,5,6]){
      const copy=await importWorld(repo,{...file,version,agent:{sessions:[{broken:"legacy-context"}],tasks:[],messages:[]}},"new");
      expect(await content(repo,copy)).toEqual(await content(repo,worldId));
      expect(await repo.platform.sql.query("SELECT * FROM agent_sessions WHERE world_id=?",[copy])).toHaveLength(0);
    }
  });

  it("preserves a finished task's original route after its conversation moves to a revision", async () => {
    const repo = await emptyRepo(), { worldId, side } = await richWorld(repo), c = await tree.cursor(repo, worldId), time = "test";
    await repo.platform.sql.batch([
      { sql: "INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('moving',?,?,'修订对话',?,?)", params: [worldId, side.id, time, time] },
      { sql: "INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,base_json,base_world_version,result_json,created_at,updated_at) VALUES('finished','moving',?,?,'改稿','archived','auto','{}','',?,?,?)", params: [worldId, c.line.id, JSON.stringify({history:{messages:[],steps:[],plan:[],sources:[],result:{summary:"已采用"}}}), time, time] },
    ]);
    const file = await exportWorld(repo, worldId);
    expect(file.pi!.tasks[0].lineId).toBe(c.line.id);
    const copy = await importWorld(repo, file, "new"), again = await exportWorld(repo, copy);
    expect(archiveProblems(again)).toEqual([]);
    expect(again.pi!.tasks[0].lineId).not.toBe(again.pi!.sessions[0].lineId);
    expect(again.lines.some(l => l.id === again.pi!.tasks[0].lineId)).toBe(true);
    const broken = structuredClone(file); broken.pi!.tasks[0].lineId = "foreign";
    expect(archiveProblems(broken)).toContain("助手历史含有无效或未完成任务");
  });

  it("round-trips a world to another device unchanged, ids included", async () => {
    const a = await emptyRepo();
    const { worldId } = await richWorld(a);
    const file = JSON.parse(JSON.stringify(await exportWorld(a, worldId)));
    const b = await emptyRepo();
    expect(await importWorld(b, file, "replace")).toBe(worldId);
    expect(await content(b, worldId)).toEqual(await content(a, worldId));
    expect((await b.getWorld(worldId))!.title).toBe("长安");
  });

  it("imports and re-exports a book whose search index exceeds the JS argument limit", async () => {
    const repo = await emptyRepo(), { worldId } = await richWorld(repo);
    const file = await exportWorld(repo, worldId);
    // Fixed-width words keep the 2400-character chunk boundaries on spaces.
    const text = Array.from({ length: 140000 }, (_, i) => `w${String(i).padStart(6, "0")} `).join("");
    file.books = [{ book: { id: "large-book", title: "长篇资料", format: "txt", createdAt: "test", sections: [{ title: "正文", text }] }, jobs: [], analysis: [] }];
    const binding = { bookId: "large-book", fanfic: true, plot: "rewrite", through: null, position: 0, instructions: "按原文核对", method: "search" };
    for (const state of file.states) state.state_json = JSON.stringify({ ...JSON.parse(String(state.state_json)), source: binding });
    const copy = await importWorld(repo, file, "new");
    const again = await exportWorld(repo, copy), book = again.books![0].book;
    expect(book.sections[0].text).toBe(text);
    expect((await repo.platform.sql.query("SELECT COUNT(*) AS n FROM source_terms WHERE book_id=?", [book.id]))[0].n).toBeGreaterThanOrEqual(140000);
    expect((await repo.platform.sql.query("SELECT postings FROM source_terms WHERE book_id=? AND term='w139999'", [book.id]))).toHaveLength(1);
    expect(archiveProblems(again)).toEqual([]);
  }, 30000);

  it("keeps the old world and saves the import under new ids, or replaces it", async () => {
    const repo = await emptyRepo();
    const { worldId } = await richWorld(repo);
    const file = JSON.parse(JSON.stringify(await exportWorld(repo, worldId)));
    const copy = await importWorld(repo, file, "new");
    expect(copy).not.toBe(worldId);
    expect((await repo.listWorlds()).map((w) => w.title).sort()).toEqual(["长安", "长安（导入）"]);
    expect(await content(repo, copy)).toEqual(await content(repo, worldId));
    expect(await importWorld(repo, file, "replace")).toBe(worldId);
    expect((await repo.listWorlds())).toHaveLength(2);
  });

  it("rejects a damaged file without touching the database", async () => {
    const repo = await emptyRepo();
    const { worldId } = await richWorld(repo);
    const file = JSON.parse(JSON.stringify(await exportWorld(repo, worldId)));
    const before = await content(repo, worldId);
    expect(archiveProblems({ format: "其他" })).toEqual(["这不是本游戏导出的世界文件"]);
    expect(archiveProblems({ ...file, version: 99 })).toEqual(["这个文件来自更新的版本，请先更新游戏"]);
    const broken = { ...file, states: file.states.slice(1) };
    expect(archiveProblems(broken)).toContain("有的回合缺少状态");
    await expect(importWorld(repo, broken, "replace")).rejects.toThrow("有的回合缺少状态");
    expect(await content(repo, worldId)).toEqual(before);
    expect(await repo.listWorlds()).toHaveLength(1);
  });
});

describe("play modes in a world file", () => {
  async function modesWorld(repo: Repo) {
    const state = sampleState();
    state.script = newScript({ line: "主线", beats: ["甲", "乙"], ending: "" });
    state.challenge = newChallenge({ goal: "凑够三百两", limit: "十日", failIf: "" }, 0);
    const { world } = await repo.createWorld({ title: "长安", eraId: "tang-748", settings: { ...DEFAULT_SETTINGS, pilot: "ai" }, opening: { parentId: null, kind: "opening", narrative: "开场", state } });
    const c = await tree.cursor(repo, world.id);
    const next = structuredClone(state);
    next.script!.beats[0] = { ...next.script!.beats[0], status: "done", endedMinute: 15 };
    await tree.append(repo, c, { kind: "turn", actionMode: "continue", actionText: "", narrative: "第一段", state: next });
    return world.id;
  }

  it("carries the script, the challenge and 旁观 to another device unchanged", async () => {
    const a = await emptyRepo();
    const worldId = await modesWorld(a);
    const file = JSON.parse(JSON.stringify(await exportWorld(a, worldId)));
    const b = await emptyRepo();
    await importWorld(b, file, "replace");
    expect(await content(b, worldId)).toEqual(await content(a, worldId));
    expect((await b.getWorld(worldId))!.settings.pilot).toBe("ai");
    expect((await content(b, worldId)).states[1].script!.beats[0]).toMatchObject({ status: "done", endedMinute: 15 });
  });

  it("drops mode fields it cannot read instead of refusing the whole file", async () => {
    const a = await emptyRepo();
    const worldId = await modesWorld(a);
    const file = JSON.parse(JSON.stringify(await exportWorld(a, worldId)));
    const broken = JSON.parse(file.states[0].state_json);
    file.states[0].state_json = JSON.stringify({ ...broken, script: { beats: "甲乙" }, challenge: { goal: "", status: "active", startedMinute: 0 } });
    file.world.settings_json = JSON.stringify({ ...JSON.parse(file.world.settings_json), pilot: "robot" });
    expect(archiveProblems(file)).toEqual([]);
    const b = await emptyRepo();
    await importWorld(b, file, "replace");
    const imported = await content(b, worldId);
    expect(imported.states[0]).not.toHaveProperty("script");
    expect(imported.states[0]).not.toHaveProperty("challenge");
    expect(imported.states[0].protagonist).toEqual(broken.protagonist);
    expect(imported.states[1]).toEqual((await content(a, worldId)).states[1]);
    expect((await b.getWorld(worldId))!.settings).not.toHaveProperty("pilot");
  });
});
