import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { migrate } from "../db/migrate";
import { Repo } from "../db/repo";
import {
  addReaderBookmark,
  addReaderHighlight,
  ensureReaderSchema,
  exportHighlightsMarkdown,
  getReaderProgress,
  listReaderBookmarks,
  listReaderHighlights,
  removeReaderBookmark,
  removeReaderHighlight,
  saveReaderProgress,
  updateReaderHighlight,
} from "./store";

describe("reader store", () => {
  it("initializes schema idempotently with 0 rows, 0 BLOB columns, and no BEGIN/COMMIT inside sql.batch", async () => {
    const platform = await createMemoryPlatform();
    const batchedSql: string[] = [];
    const origBatch = platform.sql.batch.bind(platform.sql);
    platform.sql.batch = async (stmts) => {
      for (const s of stmts) batchedSql.push(s.sql);
      return origBatch(stmts);
    };

    await ensureReaderSchema(platform);
    await ensureReaderSchema(platform); // cached in WeakMap — zero extra batch calls

    expect(batchedSql.length).toBe(6);
    for (const sql of batchedSql) {
      expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK)\b/i);
      expect(sql).not.toMatch(/\bBLOB\b/i);
      expect(sql).not.toMatch(/\bREFERENCES\b/i);
    }

    for (const table of ["reader_progress", "reader_bookmarks", "reader_highlights"]) {
      const [row] = await platform.sql.query(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(Number(row.n)).toBe(0);
    }
  });

  it("saves and updates reading progress across book and world_novel targets", async () => {
    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);

    expect(await getReaderProgress(repo, "book", "book-1")).toBeNull();

    const first = await saveReaderProgress(repo, {
      targetType: "book",
      targetId: "book-1",
      sectionIndex: 2,
      pageIndex: 5,
      scrollRatio: 0.42,
      anchorText: "青铜钥匙藏在灯座下",
      nodeId: null,
      updatedAt: "2026-11-24T01:00:00Z",
    });
    expect(first).toEqual({
      targetType: "book",
      targetId: "book-1",
      sectionIndex: 2,
      pageIndex: 5,
      scrollRatio: 0.42,
      anchorText: "青铜钥匙藏在灯座下",
      nodeId: null,
      updatedAt: "2026-11-24T01:00:00Z",
    });

    // Upsert on same (target_type, target_id) while keeping world_novel distinct.
    await saveReaderProgress(repo, {
      targetType: "world_novel",
      targetId: "book-1",
      sectionIndex: 1,
      pageIndex: 0,
      scrollRatio: 0.15,
      anchorText: "街上很冷",
      nodeId: "node-7",
      updatedAt: "2026-11-24T01:30:00Z",
    });
    await saveReaderProgress(repo, {
      targetType: "book",
      targetId: "book-1",
      sectionIndex: 4,
      pageIndex: 1,
      scrollRatio: 1.5, // clamped to 1
      anchorText: "雪夜重逢",
      nodeId: null,
      updatedAt: "2026-11-24T02:00:00Z",
    });

    expect(await getReaderProgress(repo, "book", "book-1")).toMatchObject({
      sectionIndex: 4,
      pageIndex: 1,
      scrollRatio: 1,
      anchorText: "雪夜重逢",
    });
    expect(await getReaderProgress(repo, "world_novel", "book-1")).toMatchObject({
      sectionIndex: 1,
      nodeId: "node-7",
    });
  });

  it("manages bookmarks and highlights with filtering, updates, deletion, and Markdown export", async () => {
    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);

    const bm1 = await addReaderBookmark(repo, {
      targetType: "book",
      targetId: "b1",
      sectionIndex: 0,
      sectionTitle: "第一章 灯",
      snippet: "阿青在青石桥经营书铺。",
      paragraphIndex: 0,
      nodeId: null,
    });
    const bm2 = await addReaderBookmark(repo, {
      targetType: "book",
      targetId: "b1",
      sectionIndex: 2,
      sectionTitle: "第三章 雪",
      snippet: "雪夜风急。",
      paragraphIndex: 4,
      nodeId: null,
    });
    expect((await listReaderBookmarks(repo, "book", "b1")).map((b) => b.id)).toEqual([bm2.id, bm1.id]);
    await removeReaderBookmark(repo, bm1.id);
    expect((await listReaderBookmarks(repo, "book", "b1")).map((b) => b.id)).toEqual([bm2.id]);

    const h1 = await addReaderHighlight(repo, {
      targetType: "book",
      targetId: "b1",
      worldId: "w1",
      sectionIndex: 1,
      sectionTitle: "第二章 信",
      paragraphIndex: 2,
      charStart: 4,
      charEnd: 18,
      selectedText: "阿青把青铜钥匙交给阿白。",
      note: "钥匙易手之处",
      color: "cinnabar",
      nodeId: null,
    });
    const h2 = await addReaderHighlight(repo, {
      targetType: "book",
      targetId: "b1",
      worldId: "w1",
      sectionIndex: 0,
      sectionTitle: "第一章 灯",
      paragraphIndex: 0,
      charStart: 0,
      charEnd: 12,
      selectedText: "阿青守信，不愿出卖朋友。",
      note: "",
      color: "amber",
      nodeId: null,
    });
    const hWorld = await addReaderHighlight(repo, {
      targetType: "world_novel",
      targetId: "w1",
      worldId: "w1",
      sectionIndex: 1,
      sectionTitle: "第一回 · 初入长安",
      paragraphIndex: 1,
      charStart: 0,
      charEnd: 9,
      selectedText: "暮鼓声传遍西市。",
      note: "开篇气象",
      color: "bamboo",
      nodeId: "n2",
    });

    await updateReaderHighlight(repo, h2.id, { color: "bamboo", note: "立得住的人物底色" });

    // Filtered by targetId returns reading order (section 0 before section 1).
    const bookHighlights = await listReaderHighlights(repo, { targetType: "book", targetId: "b1" });
    expect(bookHighlights.map((h) => h.id)).toEqual([h2.id, h1.id]);
    expect(bookHighlights[0]).toMatchObject({ color: "bamboo", note: "立得住的人物底色" });

    // Filtered by worldId returns both book and world_novel highlights associated with w1.
    const worldAll = await listReaderHighlights(repo, { worldId: "w1" });
    expect(worldAll).toHaveLength(3);

    const md = exportHighlightsMarkdown(worldAll, {
      b1: "灯下书",
      "world_novel:w1": "长安米贵",
    });
    expect(md).toContain("# 书摘与批注");
    expect(md).toContain("## 《长安米贵》");
    expect(md).toContain("### 第一回 · 初入长安");
    expect(md).toContain("> 暮鼓声传遍西市。");
    expect(md).toContain("批注：开篇气象");
    expect(md).toContain("## 《灯下书》");
    expect(md.indexOf("### 第一章 灯")).toBeLessThan(md.indexOf("### 第二章 信"));
    expect(md).toContain("摘于 ");

    await removeReaderHighlight(repo, hWorld.id);
    expect(await listReaderHighlights(repo, { targetType: "world_novel", targetId: "w1" })).toEqual([]);
    expect(exportHighlightsMarkdown([])).toBe("");
  });
});
