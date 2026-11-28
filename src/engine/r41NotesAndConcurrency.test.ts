import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { Game } from "./game";
import { migrate } from "./db/migrate";
import { ReferencedRoute, Repo, newId } from "./db/repo";
import { sampleState } from "./testing/fixtures";
import * as tree from "./tree";
import { saveBook } from "./sources/library";
import { newBinding, type SourceBook } from "./sources/types";
import {
  carryNotes,
  getNote,
  listNotes,
  listStoryNotes,
  markNotesStale,
  newLocalNote,
  newNote,
  newStoryNote,
  noteOffRoute,
  notesForTurn,
  preflightNoteUpdate,
  resolveStoryNoteScope,
  restartOnRoute,
  restorePrevious,
  routeIds,
  runNote,
  saveNote,
  startNoteUpdate,
  suggestNextPlotRange,
} from "./sources/notes";
import {
  addReaderBookmark,
  addReaderHighlight,
  getReaderProgress,
  listReaderBookmarks,
  listReaderHighlights,
  saveReaderProgress,
} from "./reader/store";
import { archiveProblems, exportWorld } from "./archive";
import {
  didPersonChangeInUpkeep,
  personToFormFields,
  reconcilePersonFormOnUpkeep,
  stepPersonUpkeepState,
} from "../ui/components/People";
import { didEditedCodexChange } from "../ui/components/Codex";
import { hasModalDomOverlay } from "../ui/screens/Play";

const LLM = {
  slot: "main",
  url: "https://test.invalid/v1/chat/completions",
  model: "test-main",
  auxModel: "test-aux",
  includeUsage: true,
};

const makeBook = (id = crypto.randomUUID(), count = 6): SourceBook => ({
  id,
  title: "沧海录",
  format: "txt",
  createdAt: new Date().toISOString(),
  sections: Array.from({ length: count }, (_, i) => ({
    title: `第${i + 1}章`,
    text: `第${i + 1}章正文：沈青在青云门修行剑术，与林师姐论道。`,
  })),
});

describe("R41-T004 & R41-T007: repo cascade guards, chapter concurrency, canon notes & UI guards", () => {
  describe("1. repo.ts purgeLine & deleteWorld cascade and active/revision guards (E02, E11, E20)", () => {
    it("purgeLine blocks purging a trashed route referenced by a surviving node's meta.revision.lineId or an active execution_run", async () => {
      const platform = await createMemoryPlatform();
      await migrate(platform);
      const repo = new Repo(platform);

      const { world, node: root, line: mainLine } = await repo.createWorld({
        title: "长安",
        eraId: "free",
        opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState() },
      });

      // Create a branch line off root with its own turn node
      const branchNode = await repo.appendNode(world.id, mainLine.id, {
        parentId: root.id,
        kind: "turn",
        narrative: "旧分支第一段",
        state: sampleState(),
      });
      const oldBranchLine = await repo.createLine(world.id, branchNode.id, "旧分支", false);

      // Move mainLine onto another branch referencing oldBranchLine.id in meta.revision.lineId
      const revisedNode = await repo.appendNode(world.id, mainLine.id, {
        parentId: root.id,
        kind: "turn",
        narrative: "修订后的新路线",
        meta: { revision: { lineId: oldBranchLine.id } },
        state: sampleState(),
      });
      await repo.setCurrentLine(world.id, mainLine.id);
      await repo.setLineDeleted(oldBranchLine.id, true);

      // Guard 1: surviving node references oldBranchLine in meta.revision.lineId -> must reject with ReferencedRoute
      await expect(repo.purgeLine(oldBranchLine.id)).rejects.toBeInstanceOf(ReferencedRoute);
      expect(await repo.getLine(oldBranchLine.id)).not.toBeNull();
      expect(await repo.getNode(branchNode.id)).not.toBeNull();

      // Clear revision reference on surviving node, then test Guard 2: active execution_run on oldBranchLine
      await platform.sql.batch([
        { sql: "UPDATE nodes SET meta_json = '{}' WHERE id = ?", params: [revisedNode.id] },
        {
          sql: `INSERT INTO execution_runs (id, world_id, line_id, base_head_id, status, plan_json, budget_json, draft_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'running', '{}', '{}', '{}', ?, ?)`,
          params: ["run-active", world.id, oldBranchLine.id, branchNode.id, new Date().toISOString(), new Date().toISOString()],
        },
      ]);
      await expect(repo.purgeLine(oldBranchLine.id)).rejects.toBeInstanceOf(ReferencedRoute);

      // Also test 'committing' status
      await platform.sql.batch([
        { sql: "UPDATE execution_runs SET status = 'committing' WHERE id = 'run-active'" },
      ]);
      await expect(repo.purgeLine(oldBranchLine.id)).rejects.toBeInstanceOf(ReferencedRoute);

      // Self-reference inside `gone` must NOT block purge once external run finishes
      await platform.sql.batch([
        { sql: "UPDATE execution_runs SET status = 'failed' WHERE id = 'run-active'" },
        {
          sql: "UPDATE nodes SET meta_json = ? WHERE id = ?",
          params: [JSON.stringify({ revision: { lineId: oldBranchLine.id } }), branchNode.id],
        },
      ]);
      expect(await repo.purgeLine(oldBranchLine.id)).toBe(1);
      expect(await repo.getLine(oldBranchLine.id)).toBeNull();
      expect(await repo.getNode(branchNode.id)).toBeNull();
    });

    it("deleteWorld cleans read leases (#read:*), reader_* world_novel/world_id rows, and per-world settings keys", async () => {
      const platform = await createMemoryPlatform();
      await migrate(platform);
      const repo = new Repo(platform);

      const { world } = await repo.createWorld({
        title: "待删世界",
        eraId: "free",
        opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState() },
      });
      const { world: otherWorld } = await repo.createWorld({
        title: "保留世界",
        eraId: "free",
        opening: { parentId: null, kind: "opening", narrative: "另一局", state: sampleState() },
      });

      // Leases: direct world lease, read-only lease (`worldId#read:1`), and another world's lease
      await platform.sql.batch([
        {
          sql: "INSERT INTO world_execution_leases (world_id, owner_id, owner_instance, fence, heartbeat_at_ms, expires_at_ms) VALUES (?, 'o1', 'i1', 1, 100, 999999)",
          params: [world.id],
        },
        {
          sql: "INSERT INTO world_execution_leases (world_id, owner_id, owner_instance, fence, heartbeat_at_ms, expires_at_ms) VALUES (?, 'o2', 'i1', 1, 100, 999999)",
          params: [`${world.id}#read:ask-1`],
        },
        {
          sql: "INSERT INTO world_execution_leases (world_id, owner_id, owner_instance, fence, heartbeat_at_ms, expires_at_ms) VALUES (?, 'o3', 'i1', 1, 100, 999999)",
          params: [`${otherWorld.id}#read:ask-2`],
        },
      ]);

      // Reader progress, bookmarks, highlights (both target_type='world_novel' and book highlight associated with worldId)
      await saveReaderProgress(repo, {
        targetType: "world_novel",
        targetId: world.id,
        sectionIndex: 1,
        pageIndex: 0,
        scrollRatio: 0.5,
        anchorText: "锚点",
        nodeId: null,
      });
      await saveReaderProgress(repo, {
        targetType: "book",
        targetId: "book-keep",
        sectionIndex: 2,
        pageIndex: 0,
        scrollRatio: 0.2,
        anchorText: "原著进度",
        nodeId: null,
      });
      await addReaderBookmark(repo, {
        targetType: "world_novel",
        targetId: world.id,
        sectionIndex: 0,
        sectionTitle: "第一章",
        snippet: "摘录",
        paragraphIndex: 0,
        nodeId: null,
      });
      await addReaderHighlight(repo, {
        targetType: "world_novel",
        targetId: world.id,
        worldId: world.id,
        sectionIndex: 0,
        sectionTitle: "第一章",
        paragraphIndex: 0,
        charStart: 0,
        charEnd: 2,
        selectedText: "开场",
        note: "",
        color: "cinnabar",
        nodeId: null,
      });
      await addReaderHighlight(repo, {
        targetType: "book",
        targetId: "book-keep",
        worldId: world.id,
        sectionIndex: 0,
        sectionTitle: "原著章",
        paragraphIndex: 0,
        charStart: 0,
        charEnd: 2,
        selectedText: "原著句",
        note: "",
        color: "amber",
        nodeId: null,
      });
      await addReaderHighlight(repo, {
        targetType: "world_novel",
        targetId: otherWorld.id,
        worldId: otherWorld.id,
        sectionIndex: 0,
        sectionTitle: "他局章",
        paragraphIndex: 0,
        charStart: 0,
        charEnd: 2,
        selectedText: "另一局",
        note: "",
        color: "bamboo",
        nodeId: null,
      });

      // Settings keys
      await repo.setSetting(`autoplayUnusedNote:${world.id}`, "note-text");
      await repo.setSetting(`carriedDone:${world.id}`, true);
      await repo.setSetting(`carriedDone:${otherWorld.id}`, true);

      await repo.deleteWorld(world.id);

      const leases = await platform.sql.query("SELECT world_id FROM world_execution_leases");
      expect(leases.map((r) => r.world_id)).toEqual([`${otherWorld.id}#read:ask-2`]);

      expect(await getReaderProgress(repo, "world_novel", world.id)).toBeNull();
      expect(await getReaderProgress(repo, "book", "book-keep")).not.toBeNull();
      expect(await listReaderBookmarks(repo, "world_novel", world.id)).toEqual([]);
      expect(await listReaderHighlights(repo, { targetType: "world_novel", targetId: world.id })).toEqual([]);
      expect(await listReaderHighlights(repo, { worldId: world.id })).toEqual([]);
      expect(await listReaderHighlights(repo, { worldId: otherWorld.id })).toHaveLength(1);

      expect(await repo.getSetting(`autoplayUnusedNote:${world.id}`, null)).toBeNull();
      expect(await repo.getSetting(`carriedDone:${world.id}`, null)).toBeNull();
      expect(await repo.getSetting(`carriedDone:${otherWorld.id}`, null)).toBe(true);
    });
  });

  describe("2. Chapter summary/rewrite concurrency guards & duplicate prevention (Audit #4 + E20)", () => {
    it("rewriteChapter refuses to overwrite when source prose or user-edited summary changed in flight, keeping stale=true", async () => {
      const platform = await createMemoryPlatform();
      const game = await Game.open(platform, LLM);
      const repo = game.repo;
      const { world } = await repo.createWorld({
        title: "章节并发",
        eraId: "free",
        settings: { chapterEvery: 0 },
        opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState() },
      });
      let cursor = await tree.cursor(repo, world.id);
      cursor = await tree.append(repo, cursor, { kind: "turn", narrative: "第一回合原文", actionText: "行动1", state: sampleState() });
      const t1 = cursor.head;
      cursor = await tree.append(repo, cursor, { kind: "turn", narrative: "第二回合原文", actionText: "行动2", state: sampleState() });
      const t2 = cursor.head;

      const chap = await repo.addChapter({
        worldId: world.id,
        firstNodeId: t1.id,
        lastNodeId: t2.id,
        title: "初版章名",
        gist: "初版梗概",
        summary: "初版摘要",
        model: "test-aux",
        promptVersion: "v1",
        stale: true,
      });
      expect(chap.stale).toBe(true);

      // Case A: While rewriteChapter is waiting on LLM, player rewrites t1's narrative -> must refuse and keep stale = true!
      let mutateDuringCall = async () => {
        await repo.updateNarrative(t1.id, "第一回合被玩家中途改写");
      };
      platform.llm.stream = async (_req, onEvent) => {
        await mutateDuringCall();
        onEvent({
          type: "data",
          data: JSON.stringify({
            choices: [{ delta: { content: JSON.stringify({ title: "过期AI章", gist: "过期梗概", summary: "过期摘要" }) }, finish_reason: "stop" }],
          }),
        });
        onEvent({ type: "done" });
        return "s1";
      };

      expect(await game.rewriteChapter(world.id, chap.id)).toBeNull();
      const [afterProseEdit] = await repo.chaptersOnPath(world.id, t2.id);
      expect(afterProseEdit).toMatchObject({
        title: "初版章名",
        summary: "初版摘要",
        stale: true,
      });

      // Case B: While rewriteChapter is waiting on LLM, player manually edits the chapter summary in Journal.tsx (2-arg updateChapter)
      mutateDuringCall = async () => {
        await repo.updateChapter(chap.id, { title: "玩家手改章", gist: "玩家梗概", summary: "玩家亲手写的摘要", edited: true });
      };
      expect(await game.rewriteChapter(world.id, chap.id)).toBeNull();
      const [afterManualEdit] = await repo.chaptersOnPath(world.id, t2.id);
      expect(afterManualEdit).toMatchObject({
        title: "玩家手改章",
        summary: "玩家亲手写的摘要",
        edited: true,
      });

      // Case C: Clean rewrite succeeds and clears stale
      await repo.updateNarrative(t2.id, "第二回合定稿");
      expect((await repo.chaptersOnPath(world.id, t2.id))[0].stale).toBe(true);
      mutateDuringCall = async () => {};
      const ok = await game.rewriteChapter(world.id, chap.id);
      expect(ok).toMatchObject({ title: "过期AI章", summary: "过期摘要", edited: false });
      expect(ok?.stale).toBeUndefined();
      expect((await repo.chaptersOnPath(world.id, t2.id))[0].stale).toBeUndefined();
    });

    it("writeChapter prevents duplicate chapters, skips trashed worlds, and marks stale=true if prose changed in flight", async () => {
      const platform = await createMemoryPlatform();
      const game = await Game.open(platform, LLM);
      const repo = game.repo;
      const { world } = await repo.createWorld({
        title: "建章护栏",
        eraId: "free",
        settings: { chapterEvery: 0 },
        opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState() },
      });
      let cursor = await tree.cursor(repo, world.id);
      cursor = await tree.append(repo, cursor, { kind: "turn", narrative: "甲段原文", actionText: "甲", state: sampleState() });
      const n1 = cursor.head;
      cursor = await tree.append(repo, cursor, { kind: "turn", narrative: "乙段原文", actionText: "乙", state: sampleState() });
      const n2 = cursor.head;

      // 1. Concurrent background ~maintain inserts a chapter with the same firstNodeId while writeChapter is summarizing
      let inFlightHook = async () => {
        await repo.addChapter({
          worldId: world.id,
          firstNodeId: n1.id,
          lastNodeId: n2.id,
          title: "后台已建章",
          gist: "后台梗概",
          summary: "后台摘要",
          model: "test-aux",
          promptVersion: "v1",
        });
      };
      platform.llm.stream = async (_req, onEvent) => {
        await inFlightHook();
        onEvent({
          type: "data",
          data: JSON.stringify({
            choices: [{ delta: { content: JSON.stringify({ title: "新章", gist: "新梗概", summary: "新摘要" }) }, finish_reason: "stop" }],
          }),
        });
        onEvent({ type: "done" });
        return "s-write";
      };

      expect(await game.writeChapter(world.id)).toBeNull();
      const chapters1 = await repo.chaptersOnPath(world.id, n2.id);
      expect(chapters1).toHaveLength(1);
      expect(chapters1[0].title).toBe("后台已建章");

      // 2. Append two more turns; trash world in flight -> must not insert chapter
      cursor = await tree.append(repo, cursor, { kind: "turn", narrative: "丙段原文", actionText: "丙", state: sampleState() });
      const n3 = cursor.head;
      cursor = await tree.append(repo, cursor, { kind: "turn", narrative: "丁段原文", actionText: "丁", state: sampleState() });
      const n4 = cursor.head;

      inFlightHook = async () => {
        await repo.trashWorld(world.id);
      };
      expect(await game.writeChapter(world.id)).toBeNull();
      expect(await repo.chaptersOnPath(world.id, n4.id)).toHaveLength(1);

      // 3. Restore world; modify n3's narrative in flight -> newly inserted chapter must carry stale = true!
      await repo.restoreWorld(world.id);
      inFlightHook = async () => {
        await repo.updateNarrative(n3.id, "丙段中途被改写");
      };
      const staleChap = await game.writeChapter(world.id);
      expect(staleChap).not.toBeNull();
      expect(staleChap?.stale).toBe(true);
      const chapters2 = await repo.chaptersOnPath(world.id, n4.id);
      expect(chapters2).toHaveLength(2);
      expect(chapters2[1].stale).toBe(true);
    });
  });

  describe("3. Long-book plot range, E07 lock-prevention, E19 gap/restore/handwritten/carry/autoStoryPlot/stale", () => {
    it("suggestNextPlotRange excludes non-done/inactive/empty notes and treats gaps inside a done note as uncovered", () => {
      const bookId = "book-1000";
      const paused = { ...newNote(bookId, "plot", { from: 0, to: 99 }, "暂停卷"), status: "paused" as const, content: "" };
      const failed = { ...newNote(bookId, "plot", { from: 100, to: 199 }, "失败卷"), status: "failed" as const, content: "半截" };
      const inactive = { ...newNote(bookId, "plot", { from: 200, to: 299 }, "停用卷"), status: "done" as const, active: false, content: "已停用" };
      const emptyDone = { ...newNote(bookId, "plot", { from: 0, to: 99 }, "空卷"), status: "done" as const, content: "   " };

      const sugEmpty = suggestNextPlotRange([paused, failed, inactive, emptyDone], 300, 0);
      expect(sugEmpty).toMatchObject({
        from: 0,
        to: 99,
        allCovered: false,
        plotNoteCount: 0,
        incompletePlotCount: 4,
      });

      // 3 done volumes covering 0..299, except volume 2 has a gap at sections [150, 151]
      const v1 = { ...newNote(bookId, "plot", { from: 0, to: 99 }, "第一卷"), status: "done" as const, content: "第一卷正文" };
      const v2Gap = {
        ...newNote(bookId, "plot", { from: 100, to: 199 }, "第二卷"),
        status: "done" as const,
        content: "第二卷（含缺口）",
        progress: { parts: ["前", "", "后"], batchSizes: [1, 1, 1], total: 4, gaps: [{ batch: 1, sections: [150, 151], reason: "blocked" as const }] },
      };
      const v3 = { ...newNote(bookId, "plot", { from: 200, to: 299 }, "第三卷"), status: "done" as const, content: "第三卷正文" };

      const sugWithGap = suggestNextPlotRange([v1, v2Gap, v3], 300, 0);
      expect(sugWithGap).toMatchObject({
        from: 150,
        to: 151,
        allCovered: false,
        plotNoteCount: 3,
        incompletePlotCount: 1,
      });
    });

    it("E07: preflightNoteUpdate and runNote never lock a finished note into paused/empty when materials or LLM are missing", async () => {
      const platform = await createMemoryPlatform();
      const game = await Game.open(platform, LLM);
      const repo = game.repo;
      const book = makeBook();
      await saveBook(repo, book);

      const { world } = await repo.createWorld({
        title: "防锁死测试",
        eraId: "free",
        opening: { parentId: null, kind: "opening", narrative: "开场：主角与王掌柜交谈。", state: sampleState() },
      });
      let c = await tree.cursor(repo, world.id);
      c = await tree.append(repo, c, { kind: "turn", narrative: "第一回：独自登山看雪，不见旁人。", state: sampleState() });

      // Finished story person note covering turn 0 ("王掌柜")
      const storyPerson = {
        ...newStoryNote(world.id, "person", { subject: "王掌柜", to: 0, toNode: world.currentLineId ? undefined : undefined }, "人物：王掌柜"),
        status: "done" as const,
        content: "王掌柜在开场出现（开场）。",
      };
      await saveNote(repo, storyPerson);

      // Turn 1 does NOT mention 王掌柜 -> preflightNoteUpdate throws friendly story message BEFORE mutating DB!
      const candidateStory = startNoteUpdate(storyPerson, 1);
      await expect(preflightNoteUpdate(repo, candidateStory, true)).rejects.toThrow(
        "这段故事里还没有找到相关内容，换个名字、别名或等剧情推进后再试",
      );
      expect(await getNote(repo, storyPerson.id)).toMatchObject({
        status: "done",
        content: "王掌柜在开场出现（开场）。",
      });

      // Even if startNoteUpdate was saved directly to DB and runNote is invoked, runNote automatically reverts back to done + base content!
      await saveNote(repo, candidateStory, true);
      await expect(
        runNote(repo, candidateStory, "防锁死测试", { model: "aux", call: async () => "不会调到" }, new AbortController().signal, () => {}),
      ).rejects.toThrow("这段故事里还没有找到相关内容");
      expect(await getNote(repo, storyPerson.id)).toMatchObject({
        status: "done",
        content: "王掌柜在开场出现（开场）。",
        progress: { parts: [], total: 0 },
      });

      // Book note with no matching material in updated range -> friendly book message & reverts to done!
      const bookPerson = {
        ...newNote(book.id, "person", { subject: "不存在的神秘人", to: 1 }, "人物：神秘人"),
        status: "done" as const,
        content: "旧版手写内容",
      };
      await saveNote(repo, bookPerson);
      const candidateBook = startNoteUpdate(bookPerson, 4);
      await expect(preflightNoteUpdate(repo, candidateBook, true)).rejects.toThrow(
        "原著这一范围里没有找到相关内容，换个名字、别名或调整章节试试",
      );
      await expect(preflightNoteUpdate(repo, candidateBook, false)).rejects.toThrow("连接 AI 服务");
    });

    it("E19: gap-retry on an updated note preserves original V0 previousContent instead of overwriting with V1_gap", async () => {
      const platform = await createMemoryPlatform();
      const game = await Game.open(platform, LLM);
      const repo = game.repo;
      const book = makeBook(crypto.randomUUID(), 4);
      await saveBook(repo, book);

      const v0 = {
        ...newNote(book.id, "plot", { from: 0, to: 1 }, "主线：第 1～2 章"),
        status: "done" as const,
        content: "V0初版：前两章沈青入门（第1～2章）。",
        refs: [0, 1],
      };
      await saveNote(repo, v0);

      // Update to section 3 (sections 2 & 3 in 2 batches by forcing small text? No, make section 2 & 3 > 16000 chars so they form 2 batches)
      const bigBook: SourceBook = {
        id: crypto.randomUUID(),
        title: "大书",
        format: "txt",
        createdAt: new Date().toISOString(),
        sections: [
          { title: "第1章", text: "第一章入门。" },
          { title: "第2章", text: "第二章练剑。" },
          { title: "第3章", text: `敏感阻断章。${"风雪山神庙。".repeat(2000)}` },
          { title: "第4章", text: `第四章下山。${"江湖路远。".repeat(2000)}` },
        ],
      };
      await saveBook(repo, bigBook);
      const baseNote = {
        ...newNote(bigBook.id, "plot", { from: 0, to: 1 }, "主线：第 1～2 章"),
        status: "done" as const,
        content: "V0初版正文（第1～2章）。",
        refs: [0, 1],
      };
      await saveNote(repo, baseNote);

      let blockSec3 = true;
      const updating = startNoteUpdate(baseNote, 3, true);
      await saveNote(repo, updating, true);

      const runner = {
        model: "aux",
        call: async (messages: { content: string }[]) => {
          const text = messages.map((m) => m.content).join("\n");
          if (blockSec3 && text.includes("敏感阻断章")) {
            const err = new Error("refused");
            throw Object.assign(err, {}); // Trigger via finishReason? Let's use noteReplyProblem!
          }
          if (text.includes("【原札记】")) {
            return blockSec3
              ? "【标题】主线：第 1～4 章\nV1带缺口合并正文（第1～4章）。"
              : "【标题】主线：第 1～4 章\nV2补齐缺口完整正文（第1～4章）。";
          }
          if (text.includes("敏感阻断章")) return "第三章补齐要点（第3章）。";
          return "第四章下山要点（第4章）。";
        },
      };

      // Use game.platform.llm.stream so noteReplyProblem triggers real content_filter gap
      platform.llm.stream = async (req, onEvent) => {
        const text = (req.body as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
        const refused = blockSec3 && text.includes("敏感阻断章");
        let reply = "第四章下山要点（第4章）。";
        if (text.includes("【原札记】")) {
          reply = blockSec3
            ? "【标题】主线：第 1～4 章\nV1带缺口合并正文（第1～4章）。"
            : "【标题】主线：第 1～4 章\nV2补齐缺口完整正文（第1～4章）。";
        } else if (text.includes("敏感阻断章")) {
          reply = "第三章补齐要点（第3章）。";
        } else if (text.includes("同一份原著札记分段整理")) {
          reply = "第三四章汇总（第3～4章）。";
        }
        onEvent({
          type: "data",
          data: JSON.stringify({ choices: [{ delta: { content: refused ? "" : reply }, finish_reason: refused ? "content_filter" : "stop" }] }),
        });
        onEvent({ type: "done" });
        return "s-gap";
      };
      void runner;

      const v1Gap = await game.runCanonNote(baseNote.id, () => {});
      expect(v1Gap.status).toBe("done");
      expect(v1Gap.progress.gaps?.length).toBe(1);
      expect(v1Gap.previousContent).toBe("V0初版正文（第1～2章）。");

      // Retry gap after unblocking -> V2 completes, and previousContent MUST STILL BE V0 (not V1_gap)!
      blockSec3 = false;
      const v2Done = await game.runCanonNote(baseNote.id, () => {});
      expect(v2Done.status).toBe("done");
      expect(v2Done.progress.gaps ?? []).toEqual([]);
      expect(v2Done.content).toBe("V2补齐缺口完整正文（第1～4章）。");
      expect(v2Done.previousContent).toBe("V0初版正文（第1～2章）。");

      const restored = await restorePrevious(repo, baseNote.id);
      expect(restored?.content).toBe("V0初版正文（第1～2章）。");
      expect(restored?.title).toBe("主线：第 1～2 章");
      expect(restored?.scope.to).toBe(1);
    });

    it("E19: restorePrevious resets incomplete/failed status & progress, and restartOnRoute preserves & syncs turn-range titles", async () => {
      const platform = await createMemoryPlatform();
      const game = await Game.open(platform, LLM);
      const repo = game.repo;
      const { world } = await repo.createWorld({
        title: "恢复与重整",
        eraId: "free",
        opening: { parentId: null, kind: "opening", narrative: "开场：初到长安。", state: sampleState() },
      });
      let c = await tree.cursor(repo, world.id);
      c = await tree.append(repo, c, { kind: "turn", narrative: "第一回：城门盘查。", state: sampleState() });
      c = await tree.append(repo, c, { kind: "turn", narrative: "第二回：住进客栈。", state: sampleState() });

      const initial = {
        ...newStoryNote(world.id, "plot", { from: 0, to: 1, toNode: c.head.parentId! }, "主线梗概（至第 1 回合）"),
        status: "done" as const,
        content: "初版梗概正文（第1回合）。",
      };
      await saveNote(repo, initial);

      // Restart on route up to turn 2, then simulate mid-run failure -> restorePrevious must reset status='done' and clear progress!
      const restarted = restartOnRoute(initial, 2);
      expect(restarted.scope.previous?.title).toBe("主线梗概（至第 1 回合）");
      const failedMidway: typeof restarted = {
        ...restarted,
        status: "failed",
        progress: { parts: ["半截"], total: 2, error: "断网了", failure: { kind: "network", phase: "batch" } },
      };
      await saveNote(repo, failedMidway, true);

      const recovered = await restorePrevious(repo, initial.id);
      expect(recovered).toMatchObject({
        status: "done",
        title: "主线梗概（至第 1 回合）",
        content: "初版梗概正文（第1回合）。",
        progress: { parts: [], total: 0 },
        previousContent: null,
      });

      // Now run restartOnRoute to completion at turn 2 -> title with old turn range updates to '主线梗概（至第 2 回合）'!
      const restarted2 = restartOnRoute(recovered!, 2);
      await saveNote(repo, restarted2, true);
      platform.llm.stream = async (_req, onEvent) => {
        onEvent({
          type: "data",
          data: JSON.stringify({ choices: [{ delta: { content: "重整后的两回合主线（第2回合）。" }, finish_reason: "stop" }] }),
        });
        onEvent({ type: "done" });
        return "s-restart";
      };
      const doneRestart = await game.runCanonNote(initial.id, () => {});
      expect(doneRestart.status).toBe("done");
      expect(doneRestart.title).toBe("主线梗概（至第 2 回合）");
      expect((await getNote(repo, initial.id))?.title).toBe("主线梗概（至第 2 回合）");

      const restoredBack = await restorePrevious(repo, initial.id);
      expect(restoredBack?.title).toBe("主线梗概（至第 1 回合）");
      expect(restoredBack?.content).toBe("初版梗概正文（第1回合）。");
    });

    it("E19: hand-written story note anchors scope.toNode, carryNotes converts world-specific book notes when book differs, and autoStoryPlot skips trash & resumes failed auto notes", async () => {
      const platform = await createMemoryPlatform();
      const game = await Game.open(platform, LLM);
      const repo = game.repo;
      const book = makeBook();
      await saveBook(repo, book);

      const { world } = await repo.createWorld({
        title: "前作同人",
        eraId: "free",
        opening: {
          parentId: null,
          kind: "opening",
          narrative: "开场：踏入书院。",
          state: { ...sampleState(), source: newBinding(book.id, true) },
        },
      });
      let c = await tree.cursor(repo, world.id);
      c = await tree.append(repo, c, { kind: "turn", narrative: "第一回：结识沈青。", state: await repo.getState(c.head.id) });
      const branchTurn = c.head;

      // 1. Hand-written story note resolves scope.toNode via resolveStoryNoteScope -> switching route flags noteOffRoute!
      const scoped = await resolveStoryNoteScope(repo, world.id, { subject: "沈青" });
      expect(scoped.toNode).toBe(branchTurn.id);
      const manualStoryNote = newLocalNote(newStoryNote(world.id, "person", scoped, "人物：沈青"), "沈青是同门师兄。", 2);
      await saveNote(repo, manualStoryNote);
      expect(noteOffRoute(manualStoryNote, await routeIds(repo, world.id))).toBe(false);

      // Go back to opening and branch elsewhere -> manualStoryNote is now off-route and excluded from notesForTurn!
      const undone = await tree.undo(repo, c);
      const altCursor = await tree.append(repo, undone, { kind: "turn", narrative: "另一条世界线：留在山下开茶铺。", state: sampleState() });
      expect(noteOffRoute(manualStoryNote, await routeIds(repo, world.id))).toBe(true);
      expect(await notesForTurn(repo, null, world.id, "沈青走进茶铺")).toEqual([]);

      // 2. carryNotes: world-specific book note (`worldId = world.id`) carried into a new free world WITHOUT that book converts into story_notes!
      const savedAskBookNote = await game.saveAnswerAsNote(world.id, book.id, "青云门有什么剑诀？", "青云门镇派剑诀为沧海剑气。", null);
      const { world: sequelNoBook } = await repo.createWorld({
        title: "续作无原著",
        eraId: "free",
        opening: { parentId: null, kind: "opening", narrative: "续作开场", state: sampleState() },
      });
      expect(await carryNotes(repo, [savedAskBookNote.id], sequelNoBook.id, { worldId: world.id, title: world.title }, null)).toBe(1);
      const sequelStoryNotes = await listStoryNotes(repo, sequelNoBook.id);
      expect(sequelStoryNotes).toHaveLength(1);
      expect(sequelStoryNotes[0]).toMatchObject({
        source: "story",
        bookId: "",
        worldId: sequelNoBook.id,
        originWorldId: world.id,
        originTitle: "前作同人",
        refs: [],
      });
      expect(sequelStoryNotes[0].scope.through).toBeUndefined();
      // Recalled in sequel turns when question matches!
      const recalledInSequel = await notesForTurn(repo, null, sequelNoBook.id, "他想起青云门的剑诀");
      expect(recalledInSequel.map((n) => n.title)).toEqual([`${savedAskBookNote.title}（前作《前作同人》）`]);

      // Carrying into a sequel bound to the SAME book keeps it in canon_notes
      const { world: sequelSameBook } = await repo.createWorld({
        title: "续作同书",
        eraId: "free",
        opening: {
          parentId: null,
          kind: "opening",
          narrative: "同书续作",
          state: { ...sampleState(), source: newBinding(book.id, true) },
        },
      });
      expect(await carryNotes(repo, [savedAskBookNote.id], sequelSameBook.id, { worldId: world.id, title: world.title }, book.id)).toBe(1);
      expect(await listStoryNotes(repo, sequelSameBook.id)).toHaveLength(0);
      expect((await listNotes(repo, book.id, sequelSameBook.id)).some((n) => n.worldId === sequelSameBook.id)).toBe(true);

      // 3. autoStoryPlot: skips archived/trashed world with 0 LLM calls, and resumes failed/paused auto plot note once restored
      await repo.addChapter({
        worldId: world.id,
        firstNodeId: altCursor.head.id,
        lastNodeId: altCursor.head.id,
        title: "第一章",
        gist: "茶铺",
        summary: "在山下开茶铺。",
        model: "test-aux",
        promptVersion: "v1",
      });
      const failedAuto = {
        ...newStoryNote(world.id, "plot", { from: 0, to: 1, auto: true }, "主线梗概"),
        status: "failed" as const,
        progress: { parts: [], total: 1, error: "上次断网" },
      };
      await saveNote(repo, failedAuto);

      let llmCalls = 0;
      platform.llm.stream = async (_req, onEvent) => {
        llmCalls++;
        onEvent({
          type: "data",
          data: JSON.stringify({ choices: [{ delta: { content: "自动恢复后的主线梗概（第1回合）。" }, finish_reason: "stop" }] }),
        });
        onEvent({ type: "done" });
        return "s-auto";
      };

      await repo.trashWorld(world.id);
      await game.autoStoryPlot(world.id);
      expect(llmCalls).toBe(0);

      await repo.restoreWorld(world.id);
      await game.autoStoryPlot(world.id);
      expect(llmCalls).toBe(1);
      expect((await getNote(repo, failedAuto.id))?.status).toBe("done");
    });

    it("E19: markNotesStale marks running/paused notes, and runNote preserves concurrent staleFrom & active=false", async () => {
      const platform = await createMemoryPlatform();
      const game = await Game.open(platform, LLM);
      const repo = game.repo;
      const { world } = await repo.createWorld({
        title: "并发改文与停用",
        eraId: "free",
        opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState() },
      });
      let c = await tree.cursor(repo, world.id);
      c = await tree.append(repo, c, { kind: "turn", narrative: "第一回初稿", state: sampleState() });
      const turn1 = c.head;

      const pausedNote = newStoryNote(world.id, "plot", { from: 0, to: 1 }, "暂停中的主线");
      await saveNote(repo, pausedNote);
      expect(await markNotesStale(repo, world.id, 1)).toBe(1);
      expect((await getNote(repo, pausedNote.id))?.scope.staleFrom).toBe(1);

      // Running note: while LLM is generating, user edits turn 1 narrative AND toggles active = false
      const runningNote = newStoryNote(world.id, "plot", { from: 0, to: 1 }, "整理中的主线");
      await saveNote(repo, runningNote);

      platform.llm.stream = async (_req, onEvent) => {
        // User toggles active off in UI and rewrites turn 1 prose while runNote is in flight
        const cur = (await getNote(repo, runningNote.id))!;
        await saveNote(repo, { ...cur, active: false }, true);
        await repo.updateNarrative(turn1.id, "第一回运行中被玩家改写");
        await game.afterTextEdit(world.id, turn1.id);

        onEvent({
          type: "data",
          data: JSON.stringify({ choices: [{ delta: { content: "整理完的主线（第1回合）。" }, finish_reason: "stop" }] }),
        });
        onEvent({ type: "done" });
        return "s-concurrent";
      };

      const finished = await game.runCanonNote(runningNote.id, () => {});
      expect(finished.status).toBe("done");
      expect(finished.active).toBe(false);
      expect(finished.scope.staleFrom).toBe(1);
      const persisted = await getNote(repo, runningNote.id);
      expect(persisted?.active).toBe(false);
      expect(persisted?.scope.staleFrom).toBe(1);
    });
  });

  describe("4. People.tsx, Codex.tsx & Play.tsx concurrency and overlay guards (E20, E21, E23)", () => {
    it("reconcilePersonFormOnUpkeep syncs untouched fields (e.g. alive=false) and flags same-field conflicts", () => {
      const initialPerson = {
        id: "p1",
        name: "王掌柜",
        aliases: ["老王"],
        role: "掌柜",
        attitude: "友善" as const,
        alive: true,
        notes: "初识于酒肆",
        origin: "舅舅",
        lastSeenMinute: 10,
      };
      const base = personToFormFields(initialPerson);
      // Player only edited `role`, while upkeep marked `alive: false` and updated `notes`
      const draftUntouchedAlive = { ...base, role: "东市大掌柜" };
      const upkeepDead = { ...initialPerson, alive: false, notes: "在乱兵中遇难" };

      const res1 = reconcilePersonFormOnUpkeep(base, draftUntouchedAlive, upkeepDead);
      expect(res1.hasFieldConflict).toBe(false);
      expect(res1.syncedAny).toBe(true);
      expect(res1.nextDraft.alive).toBe(false);
      expect(res1.nextDraft.notes).toBe("在乱兵中遇难");
      expect(res1.nextDraft.role).toBe("东市大掌柜");
      expect(didPersonChangeInUpkeep(initialPerson, upkeepDead)).toBe(true);

      // Player edited `notes` at the same time upkeep also changed `notes` -> conflict!
      const draftConflictingNotes = { ...base, notes: "玩家正在手写的近况" };
      const res2 = reconcilePersonFormOnUpkeep(base, draftConflictingNotes, upkeepDead);
      expect(res2.hasFieldConflict).toBe(true);
      expect(res2.nextDraft.alive).toBe(false);
      expect(res2.nextDraft.notes).toBe("玩家正在手写的近况");
    });

    it("didEditedCodexChange detects upkeep changes on the exact edited card/place while ignoring unrelated cards", () => {
      const s1 = sampleState();
      const cardA = { id: "c-a", kind: "设定" as const, name: "李安的本事", keys: [], content: "初学剑法", source: "AI" as const };
      const cardB = { id: "c-b", kind: "势力" as const, name: "漕帮", keys: [], content: "水路帮派", source: "AI" as const };
      const prev = { ...s1, cards: [cardA, cardB] };
      const nextSameA = {
        ...s1,
        cards: [cardA, { ...cardB, content: "水路大帮，掌控码头" }],
      };
      const nextChangedA = {
        ...s1,
        cards: [{ ...cardA, content: "剑法小成，领悟沧海一剑" }, cardB],
      };

      expect(didEditedCodexChange({ type: "card", kind: "设定", card: cardA }, prev, nextSameA)).toBe(false);
      expect(didEditedCodexChange({ type: "card", kind: "设定", card: cardA }, prev, nextChangedA)).toBe(true);
    });

    it("hasModalDomOverlay detects open Sheet/FailureSheet and Dialog overlays while ignoring closing ones", () => {
      const fakeDoc = (matched: boolean) => ({
        querySelector: (selector: string) => {
          expect(selector).toContain(".sheet-layer:not(.closing)");
          expect(selector).toContain(".dialog-backdrop:not(.closing)");
          return matched ? ({} as Element) : null;
        },
      });
      expect(hasModalDomOverlay(fakeDoc(true))).toBe(true);
      expect(hasModalDomOverlay(fakeDoc(false))).toBe(false);
      expect(hasModalDomOverlay(null)).toBe(false);
    });

    it("R42-T003: repo.deleteWorld cleans route-scoped world_novel reader_progress ('worldId:lineId') with literal prefix guard", async () => {
      const platform = await createMemoryPlatform();
      await migrate(platform);
      const repo = new Repo(platform);

      const t = new Date().toISOString();
      const sJson = JSON.stringify(sampleState());
      // Create target world `w_del%1` and sibling world `wXdelZ1` (which would match `LIKE 'w_del%1:%'` without `instr`)
      await platform.sql.batch([
        {
          sql: "INSERT INTO worlds (id, title, era_id, current_line_id, settings_json, created_at, updated_at, played_at) VALUES ('w_del%1', '删局', 'free', 'l-main', '{}', ?, ?, ?), ('wXdelZ1', '留局', 'free', 'l-sib', '{}', ?, ?, ?)",
          params: [t, t, t, t, t, t],
        },
        {
          sql: "INSERT INTO nodes (id, world_id, parent_id, seq, kind, narrative, status, rewritten, meta_json, created_at) VALUES ('n-del', 'w_del%1', NULL, 0, 'opening', '开场', 'done', 0, '{}', ?), ('n-sib', 'wXdelZ1', NULL, 0, 'opening', '兄弟开场', 'done', 0, '{}', ?)",
          params: [t, t],
        },
        {
          sql: "INSERT INTO states (node_id, state_json) VALUES ('n-del', ?), ('n-sib', ?)",
          params: [sJson, sJson],
        },
        {
          sql: "INSERT INTO lines (id, world_id, name, node_id, kind, auto_named, created_at) VALUES ('l-main', 'w_del%1', '主线', 'n-del', 'branch', 0, ?), ('l-alt', 'w_del%1', '支线', 'n-del', 'branch', 0, ?), ('l-sib', 'wXdelZ1', '主线', 'n-sib', 'branch', 0, ?)",
          params: [t, t, t],
        },
      ]);

      for (const targetId of ["w_del%1", "w_del%1:l-main", "w_del%1:l-alt", "wXdelZ1:l-sib"]) {
        await saveReaderProgress(repo, {
          targetType: "world_novel",
          targetId,
          sectionIndex: 1,
          pageIndex: 0,
          scrollRatio: 0.4,
          anchorText: targetId,
          nodeId: null,
        });
      }

      await repo.deleteWorld("w_del%1");

      expect(await getReaderProgress(repo, "world_novel", "w_del%1")).toBeNull();
      expect(await getReaderProgress(repo, "world_novel", "w_del%1:l-main")).toBeNull();
      expect(await getReaderProgress(repo, "world_novel", "w_del%1:l-alt")).toBeNull();
      expect(await getReaderProgress(repo, "world_novel", "wXdelZ1:l-sib")).toMatchObject({
        anchorText: "wXdelZ1:l-sib",
      });
    });

    it("R42-T003: restorePrevious handles aborted V1 update (no V0), aborted V1->V2 update (preserving V0), incomplete restartOnRoute, and symmetric gaps/staleFrom swap", async () => {
      const platform = await createMemoryPlatform();
      const game = await Game.open(platform, LLM);
      const repo = game.repo;
      const book = makeBook(crypto.randomUUID(), 6);
      await saveBook(repo, book);

      const { world } = await repo.createWorld({
        title: "札记一致性回归",
        eraId: "free",
        opening: {
          parentId: null,
          kind: "opening",
          narrative: "开场：踏入长安。",
          state: { ...sampleState(), source: newBinding(book.id, true) },
        },
      });
      let c = await tree.cursor(repo, world.id);
      c = await tree.append(repo, c, { kind: "turn", narrative: "第一回：结识沈青。", state: await repo.getState(c.head.id) });
      const n1 = c.head;
      c = await tree.append(repo, c, { kind: "turn", narrative: "第二回：夜探东市。", state: await repo.getState(c.head.id) });
      const n2 = c.head;
      c = await tree.append(repo, c, { kind: "turn", narrative: "第三回：城门赴约。", state: await repo.getState(c.head.id) });

      // Case 1: First-time note (previousContent == null, with gaps & staleFrom) fails mid-update -> restores V1 as done!
      const v1First = {
        ...newStoryNote(world.id, "plot", { from: 0, to: 1, toNode: n1.id, staleFrom: 1 }, "主线梗概（至第 1 回合）"),
        status: "done" as const,
        content: "V1初版正文（第1回合）。",
        progress: {
          parts: ["开场要点", ""],
          batchSizes: [1, 1],
          total: 3,
          gaps: [{ batch: 1, sections: [1], reason: "blocked" as const }],
        },
      };
      await saveNote(repo, v1First);

      const midFirstUpdate = startNoteUpdate(v1First, 2, true);
      expect(midFirstUpdate.previousContent).toBeUndefined();
      expect(midFirstUpdate.scope.previous).toBeUndefined();
      expect(midFirstUpdate.progress.update).toMatchObject({
        base: "V1初版正文（第1回合）。",
        baseTitle: "主线梗概（至第 1 回合）",
        baseTo: 1,
        baseToNode: n1.id,
        baseStaleFrom: 1,
        baseGaps: [{ batch: 1, sections: [1], reason: "blocked" }],
      });

      await saveNote(
        repo,
        {
          ...midFirstUpdate,
          status: "failed",
          progress: { ...midFirstUpdate.progress, parts: ["半截"], error: "网络中断", failure: { kind: "network", phase: "batch" } },
        },
        true,
      );

      const abortedFirst = await restorePrevious(repo, v1First.id);
      expect(abortedFirst).toMatchObject({
        status: "done",
        title: "主线梗概（至第 1 回合）",
        content: "V1初版正文（第1回合）。",
        scope: { from: 0, to: 1, toNode: n1.id, staleFrom: 1 },
      });
      expect(abortedFirst?.previousContent).toBeUndefined();
      expect(abortedFirst?.progress.update).toBeUndefined();
      expect(abortedFirst?.progress.gaps).toEqual([{ batch: 1, sections: [1], reason: "blocked" }]);
      expect(archiveProblems(await exportWorld(repo, world.id))).toEqual([]);

      // Case 2: V0 -> V1 completes (stripping progress.update & storing V0 gaps in scope.previous), then V1 -> V2 fails mid-update -> restores V1 while keeping V0 in previousContent!
      const v0Book = {
        ...newNote(book.id, "plot", { from: 0, to: 1 }, "主线：第 1～2 章", world.id),
        status: "done" as const,
        content: "V0原著前两章（第1～2章）。",
        refs: [0, 1],
        progress: {
          parts: ["第1章摘要", ""],
          batchSizes: [1, 1],
          total: 3,
          gaps: [{ batch: 1, sections: [1], reason: "blocked" as const }],
        },
      };
      await saveNote(repo, v0Book);

      const v1Book = await runNote(
        repo,
        startNoteUpdate(v0Book, 3, true),
        book.title,
        {
          model: "aux",
          call: async (messages) => {
            const p = messages.map((m) => m.content).join("\n");
            if (p.includes("【原札记】")) return "【标题】主线：第 1～4 章 · 入门试剑\nV1原著前四章（第1～4章）。";
            return "第3～4章新增（第3～4章）。";
          },
        },
        new AbortController().signal,
        () => {},
      );
      expect(v1Book.status).toBe("done");
      expect(v1Book.progress.update).toBeUndefined();
      expect(v1Book.progress.failure).toBeUndefined();
      expect(v1Book.previousContent).toBe("V0原著前两章（第1～2章）。");
      expect(v1Book.scope.previous?.gaps).toEqual([{ batch: 1, sections: [1], reason: "blocked" }]);

      // Start V1 -> V2 update and pause/fail midway
      const v2Candidate = startNoteUpdate(v1Book, 5, true);
      await saveNote(repo, { ...v2Candidate, status: "failed", title: "半截标题", progress: { ...v2Candidate.progress, error: "超时" } }, true, true);

      const backToV1 = await restorePrevious(repo, v0Book.id);
      expect(backToV1).toMatchObject({
        status: "done",
        title: "主线：第 1～4 章 · 入门试剑",
        content: "V1原著前四章（第1～4章）。",
        refs: [0, 1, 2, 3],
        previousContent: "V0原著前两章（第1～2章）。",
        scope: { from: 0, to: 3 },
      });
      expect(backToV1?.progress.update).toBeUndefined();
      expect(backToV1?.scope.previous?.to).toBe(1);
      expect(backToV1?.scope.previous?.gaps).toEqual([{ batch: 1, sections: [1], reason: "blocked" }]);

      // Case 4: Swapping V1 <-> V0 symmetrically preserves V0's gaps & title across 恢复上一版 -> 撤销 -> 恢复上一版!
      const swappedToV0 = await restorePrevious(repo, v0Book.id);
      expect(swappedToV0).toMatchObject({
        status: "done",
        title: "主线：第 1～2 章",
        content: "V0原著前两章（第1～2章）。",
        refs: [0, 1],
        previousContent: "V1原著前四章（第1～4章）。",
        scope: { from: 0, to: 1 },
      });
      expect(swappedToV0?.progress.gaps).toEqual([{ batch: 1, sections: [1], reason: "blocked" }]);
      expect(archiveProblems(await exportWorld(repo, world.id))).toEqual([]);

      const undoneBackToV1 = await restorePrevious(repo, v0Book.id);
      expect(undoneBackToV1).toMatchObject({
        status: "done",
        title: "主线：第 1～4 章 · 入门试剑",
        content: "V1原著前四章（第1～4章）。",
        refs: [0, 1, 2, 3],
        previousContent: "V0原著前两章（第1～2章）。",
        scope: { from: 0, to: 3 },
      });
      expect(undoneBackToV1?.progress.gaps).toBeUndefined();
      expect(undoneBackToV1?.scope.previous?.gaps).toEqual([{ batch: 1, sections: [1], reason: "blocked" }]);
      expect(archiveProblems(await exportWorld(repo, world.id))).toEqual([]);

      // Case 3: Aborting an incomplete restartOnRoute restores staleFrom, title, and gaps while clearing previousContent!
      const restarted = restartOnRoute(abortedFirst!, 3);
      expect(restarted.scope.previous).toMatchObject({
        to: 1,
        toNode: n1.id,
        title: "主线梗概（至第 1 回合）",
        staleFrom: 1,
        gaps: [{ batch: 1, sections: [1], reason: "blocked" }],
      });
      await saveNote(repo, { ...restarted, status: "failed", progress: { parts: [], total: 2, error: "断线" } }, true);
      const recoveredRestart = await restorePrevious(repo, v1First.id);
      expect(recoveredRestart).toMatchObject({
        status: "done",
        title: "主线梗概（至第 1 回合）",
        content: "V1初版正文（第1回合）。",
        previousContent: null,
        scope: { from: 0, to: 1, toNode: n1.id, staleFrom: 1 },
      });
      expect(recoveredRestart?.progress.gaps).toEqual([{ batch: 1, sections: [1], reason: "blocked" }]);
      expect(n2.id).toBeTruthy();
      expect(archiveProblems(await exportWorld(repo, world.id))).toEqual([]);
    });

    it("R42-T003: People.tsx preserves unresolved upkeepConflict and expectedHeadId across subsequent background upkeeps while syncing clean fields", () => {
      const p0 = {
        id: "p-wang",
        name: "王掌柜",
        aliases: ["老王"],
        role: "掌柜",
        attitude: "友善" as const,
        alive: true,
        notes: "初识于酒肆",
        origin: "舅舅",
        lastSeenMinute: 5,
      };
      const base0 = personToFormFields(p0);
      // Player edits `notes` on top of H0
      const draft0 = { ...base0, notes: "玩家亲手改写的近况" };

      // Upkeep #1 (H1): AI updates BOTH `notes` (conflict!) and `role` (clean untouched field)
      const p1 = { ...p0, role: "东市大掌柜", notes: "AI第一轮更新的近况" };
      const step1 = stepPersonUpkeepState(
        { base: base0, draft: draft0, upkeepConflict: false, expectedHeadId: "H0" },
        p1,
        "H1",
      );
      expect(step1.hasFieldConflict).toBe(true);
      expect(step1.syncedAny).toBe(true);
      expect(step1.state.upkeepConflict).toBe(true);
      expect(step1.state.expectedHeadId).toBe("H0"); // Must NOT advance to H1!
      expect(step1.state.draft.role).toBe("东市大掌柜");
      expect(step1.state.draft.notes).toBe("玩家亲手改写的近况");
      // Conflicted key in base MUST stay at H0 value so Upkeep #2 cannot mask the conflict!
      expect(step1.state.base.notes).toBe("初识于酒肆");
      expect(step1.state.base.role).toBe("东市大掌柜");

      // Upkeep #2 (H2): AI updates `alive: false` while `notes` stays at H1's value; user still has NOT resolved!
      const p2 = { ...p1, alive: false };
      const step2 = stepPersonUpkeepState(step1.state, p2, "H2");
      expect(step2.syncedAny).toBe(true);
      expect(step2.state.draft.alive).toBe(false);
      expect(step2.state.base.alive).toBe(false);
      expect(step2.hasFieldConflict).toBe(true);
      expect(step2.state.upkeepConflict).toBe(true); // Conflict MUST remain active!
      expect(step2.state.expectedHeadId).toBe("H0"); // Must NOT advance to H2!

      // Upkeep #3 (H3): Even if AI reverts `notes` back to H0 (`hasFieldConflict === false`), existing unresolved `upkeepConflict` stays locked until explicit user action!
      const p3 = { ...p2, notes: "初识于酒肆" };
      const step3 = stepPersonUpkeepState(step2.state, p3, "H3");
      expect(step3.hasFieldConflict).toBe(false);
      expect(step3.state.upkeepConflict).toBe(true);
      expect(step3.state.expectedHeadId).toBe("H0");
    });
  });
});
