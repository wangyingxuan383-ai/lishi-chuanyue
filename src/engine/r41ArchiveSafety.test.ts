import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import {
  archiveProblems,
  exportWorld,
  exportWorldFile,
  importWorld,
  replaceWorldWithBackup,
  sanitizeArchiveFileTitle,
} from "./archive";
import { migrate } from "./db/migrate";
import { ReferencedRoute, Repo } from "./db/repo";
import { Game } from "./game";
import { buildNovelBook } from "./novel";
import { addReaderHighlight, getReaderProgress, listReaderHighlights, saveReaderProgress } from "./reader/store";
import { saveBook } from "./sources/library";
import { listNotes, newLocalNote, newNote, saveNote } from "./sources/notes";
import { newBinding } from "./sources/types";
import { sampleState } from "./testing/fixtures";
import * as tree from "./tree";

async function setup() {
  const platform = await createMemoryPlatform();
  await migrate(platform);
  return { platform, repo: new Repo(platform) };
}

describe("R41 archive safety, state validation, and replace cleanup", () => {
  it("aborts replace import when pre-import backup fails and succeeds after backup recovers", async () => {
    const { platform, repo } = await setup();
    const made = await repo.createWorld({
      title: "本地新进度标题",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "开场在西市。", state: sampleState() },
    });
    const c1 = await tree.append(repo, await tree.cursor(repo, made.world.id), {
      kind: "turn",
      narrative: "玩家刚写了宝贵的新回合。",
      state: sampleState(500),
    });

    const older = await exportWorld(repo, made.world.id);
    older.world.title = "外部导入的旧档标题";
    older.nodes = older.nodes.filter((n) => n.id === made.node.id).map((n) => ({ ...n, last_child_id: null }));
    older.states = older.states.filter((s) => s.node_id === made.node.id);
    older.lines[0]!.node_id = made.node.id;

    const realBackup = platform.sql.backup.bind(platform.sql);
    let failBackup = true;
    platform.sql.backup = async (label: string) => {
      if (failBackup) throw new Error("磁盘空间不足");
      return realBackup(label);
    };

    await expect(replaceWorldWithBackup(platform, repo, older)).rejects.toThrow("自动备份失败");
    expect((await repo.getWorld(made.world.id))?.title).toBe("本地新进度标题");
    expect((await tree.cursor(repo, made.world.id)).head.id).toBe(c1.head.id);

    failBackup = false;
    await replaceWorldWithBackup(platform, repo, older);
    expect((await repo.getWorld(made.world.id))?.title).toBe("外部导入的旧档标题");
    const backups = await platform.sql.listBackups();
    const beforeImportBackup = backups.find((b) => b.name.includes("before-import"));
    expect(beforeImportBackup).toBeDefined();
    expect(beforeImportBackup!.size).toBeGreaterThan(0);
  });

  it("rejects corrupted protagonist/core state before touching existing world while keeping valid saves working", async () => {
    const { repo } = await setup();
    const made = await repo.createWorld({
      title: "正常可读世界",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "正常开场。", state: sampleState() },
    });
    const baseFile = await exportWorld(repo, made.world.id);

    const nullProtagonist = structuredClone(baseFile);
    const s0 = JSON.parse(String(nullProtagonist.states[0]!.state_json));
    s0.protagonist = null;
    nullProtagonist.states[0]!.state_json = JSON.stringify(s0);
    expect(archiveProblems(nullProtagonist)).toContain("有的状态损坏了或不属于这个故事");
    await expect(importWorld(repo, nullProtagonist, "replace")).rejects.toThrow("有的状态损坏了");

    const badStats = structuredClone(baseFile);
    const s1 = JSON.parse(String(badStats.states[0]!.state_json));
    s1.protagonist.stats.health = "满血";
    badStats.states[0]!.state_json = JSON.stringify(s1);
    expect(archiveProblems(badStats)).toContain("有的状态损坏了或不属于这个故事");

    const negativeTime = structuredClone(baseFile);
    const s2 = JSON.parse(String(negativeTime.states[0]!.state_json));
    s2.time.elapsedMinutes = -10;
    negativeTime.states[0]!.state_json = JSON.stringify(s2);
    expect(archiveProblems(negativeTime)).toContain("有的状态损坏了或不属于这个故事");

    // Existing world remains intact and renders as novel cleanly
    expect((await buildNovelBook(repo, made.world.id))?.title).toBe("正常可读世界");

    // Valid legacy v1 save (without places/cards/timeline and with age: null) still passes
    const legacyValid = structuredClone(baseFile);
    legacyValid.version = 1;
    const sLegacy = JSON.parse(String(legacyValid.states[0]!.state_json));
    sLegacy.protagonist.age = null;
    delete sLegacy.places;
    delete sLegacy.cards;
    delete sLegacy.timeline;
    delete sLegacy.dismissed;
    legacyValid.states[0]!.state_json = JSON.stringify(sLegacy);
    expect(archiveProblems(legacyValid)).toEqual([]);
  });

  it("supports opening roots created by Pi agent (agentOriginalNodeId) in validation and new-world remap", async () => {
    const { repo } = await setup();
    const made = await repo.createWorld({
      title: "开局改档世界",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "旧开场。", state: sampleState() },
    });
    const file = await exportWorld(repo, made.world.id);
    const origNode = file.nodes[0]!;
    const revisedRoot = {
      ...structuredClone(origNode),
      id: "agent-opening-root",
      seq: origNode.seq, // Even pre-R41 equal-seq opening clone must roundtrip cleanly
      narrative: "改档助手润色后的新开场。",
      rewritten: 1,
      meta_json: JSON.stringify({ openingSeed: sampleState(), agentOriginalNodeId: origNode.id }),
    };
    file.nodes.push(revisedRoot);
    file.states.push({ node_id: revisedRoot.id, state_json: JSON.stringify(sampleState(888)) });
    file.lines[0]!.node_id = revisedRoot.id;

    expect(archiveProblems(file)).toEqual([]);
    const copiedId = await importWorld(repo, file, "new");
    const copiedArchive = await exportWorld(repo, copiedId);
    expect(archiveProblems(copiedArchive)).toEqual([]);
    const copiedRevised = copiedArchive.nodes.find((n) => n.narrative === "改档助手润色后的新开场。")!;
    const copiedOrig = copiedArchive.nodes.find((n) => n.narrative === "旧开场。")!;
    expect(JSON.parse(String(copiedRevised.meta_json)).agentOriginalNodeId).toBe(copiedOrig.id);
  });

  it("cleans stale execution_runs, world_novel highlights & companion pointers on replace and reuses identical source_books", async () => {
    const { platform, repo } = await setup();
    const book = {
      id: "shared-book-1",
      title: "十万字测试书",
      format: "txt" as const,
      createdAt: new Date().toISOString(),
      sections: [{ title: "第一章", text: "测试原著正文内容。" }],
    };
    await saveBook(repo, book);
    await saveNote(repo, newLocalNote(newNote(book.id, "plot", { from: 0, to: 0 }, "全书共享札记", null), "共享札记正文", 1));
    await addReaderHighlight(repo, {
      targetType: "book",
      targetId: book.id,
      worldId: null,
      sectionIndex: 0,
      sectionTitle: "第一章",
      paragraphIndex: 0,
      charStart: 0,
      charEnd: 4,
      selectedText: "测试原著",
      note: "读者在原书上的批注",
      color: "cinnabar",
      nodeId: null,
    });

    const state = sampleState();
    state.source = { ...newBinding(book.id, true), position: 0 };
    const made = await repo.createWorld({
      title: "同人回滚测试",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "开场。", state },
    });
    const cleanBackup = await exportWorld(repo, made.world.id);
    // Also test page: null tolerance from native derive_book
    (cleanBackup.books![0]!.book.sections[0] as any).page = null;
    expect(archiveProblems(cleanBackup)).toEqual([]);

    // Pollute world with a failed execution_run, a future world_novel highlight, and a companion session on a future branch
    const futureLine = await repo.createLine(made.world.id, made.node.id, "未来分支", false);
    await addReaderHighlight(repo, {
      targetType: "world_novel",
      targetId: made.world.id,
      worldId: made.world.id,
      sectionIndex: 2,
      sectionTitle: "未来章",
      paragraphIndex: 0,
      charStart: 0,
      charEnd: 2,
      selectedText: "未来",
      note: "应随回滚清除",
      color: "bamboo",
      nodeId: made.node.id,
    });
    await platform.sql.batch([
      {
        sql: `CREATE TABLE IF NOT EXISTS companion_sessions (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, persona_id TEXT NOT NULL, gear TEXT NOT NULL,
          bound_world_id TEXT, bound_line_id TEXT, bound_book_id TEXT, pi_session_id TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )`,
      },
      {
        sql: `INSERT INTO execution_runs(id,world_id,line_id,base_head_id,status,plan_json,budget_json,draft_json,error,created_at,updated_at)
              VALUES('failed-after-backup',?,?,?,'failed','{"kind":"turn"}','{}','{}','余额不足','2026-11-27T00:00:00Z','2026-11-27T00:00:00Z')`,
        params: [made.world.id, made.line.id, made.node.id],
      },
      {
        sql: `INSERT INTO companion_sessions(id,title,persona_id,gear,bound_world_id,bound_line_id,bound_book_id,pi_session_id,created_at,updated_at)
              VALUES('comp-1','伴聊','default','chat',?,?,?,'stale-pi-sess','2026-11-27T00:00:00Z','2026-11-27T00:00:00Z')`,
        params: [made.world.id, futureLine.id, book.id],
      },
    ]);

    await importWorld(repo, cleanBackup, "replace");

    const game = await Game.open({ ...platform, execution: {} as any }, null);
    expect(await game.currentExecution(made.world.id)).toBeNull();
    expect(await listReaderHighlights(repo, { worldId: made.world.id })).toHaveLength(0);

    // Identical book was reused: still 1 book row, 1 shared note, and book highlights stayed attached!
    expect(await platform.sql.query("SELECT id FROM source_books")).toHaveLength(1);
    expect(await listNotes(repo, book.id, made.world.id)).toHaveLength(1);
    const restoredState = await repo.getState((await tree.cursor(repo, made.world.id)).head.id);
    expect(restoredState.source?.bookId).toBe(book.id);
    expect(await listReaderHighlights(repo, { targetType: "book", targetId: restoredState.source!.bookId })).toHaveLength(1);

    // Companion session had its deleted futureLine reset to restored current line and stale pi_session_id cleared
    const [compRow] = await platform.sql.query("SELECT bound_line_id, bound_book_id, pi_session_id FROM companion_sessions WHERE id='comp-1'");
    expect(compRow).toEqual({
      bound_line_id: made.line.id,
      bound_book_id: book.id,
      pi_session_id: null,
    });
  });

  it("sanitizes illegal characters in exported archive filenames and handles deleted lineId in JS Pi export", async () => {
    expect(sanitizeArchiveFileTitle("唐/宋:长安?")).toBe("唐·宋·长安·");
    expect(sanitizeArchiveFileTitle("CON")).toBe("_CON");
    expect(sanitizeArchiveFileTitle("  ...  ")).toBe("世界存档");

    const { platform, repo } = await setup();
    let exportedName = "";
    platform.files.exportText = async (name: string) => {
      exportedName = name;
      return true;
    };
    const made = await repo.createWorld({
      title: "Fate/stay night: 圣杯?",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "开场。", state: sampleState() },
    });
    await exportWorldFile(repo, made.world.id, "Fate/stay night: 圣杯?");
    expect(exportedName).toBe("Fate·stay night· 圣杯·.lishi.json");

    // JS exportWorld fallback with a deleted task line_id & message-only session
    await platform.sql.batch([
      {
        sql: "INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('s-del',?,'deleted-line','历史对话','t','t')",
        params: [made.world.id],
      },
      {
        sql: "INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,base_json,base_world_version,result_json,created_at,updated_at) VALUES('t-del','s-del',?,'deleted-line','旧分支任务','completed','preview','{}','',?,'t','t')",
        params: [made.world.id, JSON.stringify({ history: { messages: [{ id: "m1", role: "assistant", content: "已完成" }], steps: [], plan: [], sources: [], result: { summary: "好" } } })],
      },
    ]);
    const exported = await exportWorld(repo, made.world.id);
    expect(archiveProblems(exported)).toEqual([]);
  });

  it("R42-T003: importWorld('replace') guards LIKE prefixes with instr() so '_' and '%' in world.id never delete sibling leases or route-scoped reader_progress", async () => {
    const { platform, repo } = await setup();
    const seed = await repo.createWorld({
      title: "种子世界",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "开场。", state: sampleState() },
    });
    const template = await exportWorld(repo, seed.world.id);

    const makeWildcardArchive = (worldId: string, nodeId: string, lineId: string, title: string) => {
      const copy = structuredClone(template);
      copy.world = { ...copy.world, id: worldId, title, current_line_id: lineId };
      copy.nodes = copy.nodes.map((n) => ({ ...n, id: nodeId, world_id: worldId }));
      copy.states = copy.states.map((s) => ({ ...s, node_id: nodeId }));
      copy.lines = copy.lines.map((l) => ({ ...l, id: lineId, world_id: worldId, node_id: nodeId }));
      return copy;
    };

    // "wX1Za_tail" matches `'w_1%a' || ...` under raw SQLite LIKE because '_' matches 'X' and '%' matches '1Z'!
    const targetArchive = makeWildcardArchive("w_1%a", "n_target", "l_target", "通配符目标局");
    const siblingArchive = makeWildcardArchive("wX1Za", "n_sibling", "l_sibling", "无辜兄弟局");
    await importWorld(repo, targetArchive, "replace");
    await importWorld(repo, siblingArchive, "replace");

    await platform.sql.batch([
      {
        sql: "INSERT INTO world_execution_leases (world_id, owner_id, owner_instance, fence, heartbeat_at_ms, expires_at_ms) VALUES (?, 'o1', 'i1', 1, 100, 1)",
        params: ["w_1%a#read:ask-target"],
      },
      {
        sql: "INSERT INTO world_execution_leases (world_id, owner_id, owner_instance, fence, heartbeat_at_ms, expires_at_ms) VALUES (?, 'o2', 'i1', 1, 100, 9999999999999)",
        params: ["wX1Za#read:ask-sibling"],
      },
    ]);

    await saveReaderProgress(repo, {
      targetType: "world_novel",
      targetId: "w_1%a",
      sectionIndex: 0,
      pageIndex: 0,
      scrollRatio: 0.2,
      anchorText: "目标裸进度",
      nodeId: null,
    });
    await saveReaderProgress(repo, {
      targetType: "world_novel",
      targetId: "w_1%a:l_target",
      sectionIndex: 1,
      pageIndex: 0,
      scrollRatio: 0.6,
      anchorText: "目标路线进度",
      nodeId: null,
    });
    await saveReaderProgress(repo, {
      targetType: "world_novel",
      targetId: "wX1Za:l_sibling",
      sectionIndex: 2,
      pageIndex: 0,
      scrollRatio: 0.8,
      anchorText: "兄弟路线进度",
      nodeId: null,
    });

    await importWorld(repo, targetArchive, "replace");

    const leases = await platform.sql.query("SELECT world_id FROM world_execution_leases");
    expect(leases.map((r) => r.world_id)).toEqual(["wX1Za#read:ask-sibling"]);
    expect(await getReaderProgress(repo, "world_novel", "w_1%a")).toBeNull();
    expect(await getReaderProgress(repo, "world_novel", "w_1%a:l_target")).toBeNull();
    expect(await getReaderProgress(repo, "world_novel", "wX1Za:l_sibling")).toMatchObject({
      anchorText: "兄弟路线进度",
    });
  });

  it("R42-T003: repo.purgeLine blocks deleting original opening root N0 while cloned opening roots still reference $.agentOriginalNodeId = N0", async () => {
    const { platform, repo } = await setup();
    const { world, node: n0, line: l0 } = await repo.createWorld({
      title: "开局多分支保护",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "原始开场 N0。", state: sampleState() },
    });

    // Insert two cloned opening roots R1 (on L1) and R2 (on L2), both anchored to N0 via meta.agentOriginalNodeId
    const t = new Date().toISOString();
    const stateJson = JSON.stringify(sampleState());
    const cloneMeta = JSON.stringify({ openingSeed: sampleState(), agentOriginalNodeId: n0.id });
    await platform.sql.batch([
      {
        sql: `INSERT INTO nodes (id, world_id, parent_id, last_child_id, seq, kind, narrative, status, rewritten, meta_json, created_at)
              VALUES ('r1', ?, NULL, NULL, 1, 'opening', '第一次克隆开场 R1', 'done', 1, ?, ?),
                     ('r2', ?, NULL, NULL, 2, 'opening', '第二次克隆开场 R2', 'done', 1, ?, ?)`,
        params: [world.id, cloneMeta, t, world.id, cloneMeta, t],
      },
      {
        sql: "INSERT INTO states (node_id, state_json) VALUES ('r1', ?), ('r2', ?)",
        params: [stateJson, stateJson],
      },
    ]);
    const l1 = await repo.createLine(world.id, "r1", "重写路线一", false);
    const l2 = await repo.createLine(world.id, "r2", "重写路线二", false);
    await repo.setCurrentLine(world.id, l1.id);

    // Move initial route L0 into trash and attempt to purge it while R1 & R2 still depend on N0!
    await repo.setLineDeleted(l0.id, true);
    await expect(repo.purgeLine(l0.id)).rejects.toBeInstanceOf(ReferencedRoute);
    expect(await repo.getNode(n0.id)).not.toBeNull();
    expect(await repo.getLine(l0.id)).not.toBeNull();

    // Archive validation MUST still find unique original opening N0 (`originals.length === 1`)!
    expect(archiveProblems(await exportWorld(repo, world.id))).toEqual([]);

    // Purging unreferenced cloned route L2 succeeds cleanly, while L0/N0 remains protected by surviving R1 on L1!
    await repo.setLineDeleted(l2.id, true);
    expect(await repo.purgeLine(l2.id)).toBe(1);
    expect(await repo.getNode("r2")).toBeNull();
    expect(l1.id).toBeTruthy();
    await expect(repo.purgeLine(l0.id)).rejects.toBeInstanceOf(ReferencedRoute);
    expect(archiveProblems(await exportWorld(repo, world.id))).toEqual([]);
  });
});
