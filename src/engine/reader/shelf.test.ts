import { describe, expect, it } from "vitest";
import type { SqlStatement } from "../../platform";
import { createMemoryPlatform } from "../../platform/memory";
import { migrate } from "../db/migrate";
import { Repo } from "../db/repo";
import {
  getBookHeader,
  getBookMeta,
  listBookSectionsFast,
  listBookToc,
  readBookSection,
  saveBook,
} from "../sources/library";
import { applyBookResplit } from "../sources/resplit";
import { bookChapters } from "../sources/scope";
import { saveReaderProgress } from "./store";
import {
  getReadingStatsSummary,
  listLibraryShelfItems,
  recordReadingSeconds,
  updateBookShelfPref,
} from "./shelf";

describe("reader shelf prefs, stats & fast summary (R36-T003)", () => {
  it("tracks reading duration, streak days, pinned order, cover tone, and book progress %", async () => {
    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);

    await saveBook(repo, {
      id: "book-a",
      title: "长安十二时辰札记",
      format: "txt",
      createdAt: "2026-11-20T08:00:00.000Z",
      sections: [
        { title: "第一章 巳正", text: "西市鼓声初起，胡商牵驼而入。" },
        { title: "第二章 午初", text: "望楼旗帜翻动，城坊暗流涌动。" },
        { title: "第三章 未初", text: "靖安司案牍堆积如山。" },
        { title: "第四章 申正", text: "暮色渐沉，灯火次第亮起。" },
      ],
    });
    await saveBook(repo, {
      id: "book-b",
      title: "汴京梦华小录",
      format: "epub",
      createdAt: "2026-11-21T08:00:00.000Z",
      sections: [
        { title: "卷一 东角楼", text: "州桥夜市车马骈阗。" },
        { title: "卷二 潘楼街", text: "茶坊酒肆灯烛荧煌。" },
      ],
    });

    await saveReaderProgress(repo, {
      targetType: "book",
      targetId: "book-a",
      sectionIndex: 2,
      pageIndex: 0,
      scrollRatio: 0.5,
      anchorText: "靖安司案牍堆积如山。",
      nodeId: null,
      updatedAt: "2026-11-24T07:00:00.000Z",
    });

    await updateBookShelfPref(repo, "book-b", { pinned: true, coverTone: 3, author: "孟元老" });

    const day1 = new Date("2026-11-23T21:00:00+08:00");
    const day2 = new Date("2026-11-24T08:00:00+08:00");
    await recordReadingSeconds(repo, "book", "book-a", 120, day1);
    await recordReadingSeconds(repo, "book", "book-a", 180, day2);

    const stats = await getReadingStatsSummary(repo, day2);
    expect(stats.todayMinutes).toBe(3);
    expect(stats.totalMinutes).toBe(5);
    expect(stats.streakDays).toBe(2);

    const shelf = await listLibraryShelfItems(repo);
    expect(shelf.map((x) => x.id)).toEqual(["book-b", "book-a"]);
    expect(shelf[0]!.pinned).toBe(true);
    expect(shelf[0]!.coverTone).toBe(3);
    expect(shelf[0]!.author).toBe("孟元老");
    expect(shelf[1]!.currentSectionTitle).toBe("第三章 未初");
    expect(shelf[1]!.progressPct).toBeGreaterThanOrEqual(60);
    expect(shelf[1]!.readingSeconds).toBe(300);
  });

  it("opens 1,500-chapter multi-thousand-chunk novels without O(N^2) table-scan freeze and invalidates cache on resplit", async () => {
    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);

    // Verify empty shelf does NOT pollute settings rows
    const emptyShelf = await listLibraryShelfItems(repo);
    expect(emptyShelf).toEqual([]);
    const settingsBefore = await platform.sql.query("SELECT COUNT(*) AS n FROM settings");
    expect(Number(settingsBefore[0]?.n ?? 0)).toBe(0);

    // Insert a 1,500-section, 3,000-chunk book directly into source_sections/source_chunks
    const sectionCount = 1500;
    const chunkText = "长安月下千门雪，驿路梅花万里春。".repeat(160); // 2,560 chars
    const stmts: SqlStatement[] = [
      {
        sql: "INSERT INTO source_books(id,title,format,created_at,json) VALUES(?,?,?,?,?)",
        params: [
          "mega-book",
          "万卷长篇测试录",
          "txt",
          "2026-11-24T00:00:00Z",
          JSON.stringify({
            id: "mega-book",
            title: "万卷长篇测试录",
            format: "txt",
            createdAt: "2026-11-24T00:00:00Z",
            sections: [
              { title: "第1话 朔风起", text: "第一话正文内容。\n\n第2话 夜渡河\n\n第二话正文内容。" },
            ],
          }),
        ],
      },
    ];
    for (let s = 0; s < sectionCount; s++) {
      stmts.push({
        sql: "INSERT INTO source_sections(book_id,section,title,page) VALUES(?,?,?,?)",
        params: ["mega-book", s, `第${s + 1}章 风起云涌`, null],
      });
      stmts.push({
        sql: "INSERT INTO source_chunks(book_id,ordinal,section,text) VALUES(?,?,?,?)",
        params: ["mega-book", s * 2, s, chunkText],
      });
      stmts.push({
        sql: "INSERT INTO source_chunks(book_id,ordinal,section,text) VALUES(?,?,?,?)",
        params: ["mega-book", s * 2 + 1, s, chunkText.slice(0, 800)],
      });
    }
    await platform.sql.batch(stmts);

    const t0 = performance.now();
    const header = await getBookHeader(repo, "mega-book");
    const fastSecs = await listBookSectionsFast(repo, "mega-book");
    const midSec = await readBookSection(repo, "mega-book", 999);
    const stage1Ms = performance.now() - t0;

    expect(header?.sectionCount).toBe(sectionCount);
    expect(fastSecs.length).toBe(sectionCount);
    expect(midSec?.title).toBe("第1000章 风起云涌");
    expect(midSec?.text.length).toBe(2560 + 800);
    expect(stage1Ms).toBeLessThan(800);

    const t1 = performance.now();
    const toc = await listBookToc(repo, "mega-book");
    const meta = await getBookMeta(repo, "mega-book");
    const shelf = await listLibraryShelfItems(repo);
    const scoped = await bookChapters(repo, {
      bookId: "mega-book",
      fanfic: true,
      plot: "canon",
      through: 50,
      position: 10,
      method: "search",
      instructions: "",
    });
    const stage2Ms = performance.now() - t1;

    expect(toc.length).toBe(sectionCount);
    expect(toc[0]!.chars).toBe(3360);
    expect(toc[1499]!.chars).toBe(3360);
    expect(meta?.totalChars).toBe(sectionCount * 3360);
    expect(shelf[0]!.totalChars).toBe(sectionCount * 3360);
    expect(scoped.length).toBe(51);
    expect(scoped[50]!.chars).toBe(3360);
    expect(stage2Ms).toBeLessThan(1200);

    // Resplitting triggers SQLite `reference_index_versions` revision bump & invalidates cached metrics!
    await applyBookResplit(repo, "mega-book", {
      preset: "custom",
      customPattern: "^第\\d+话.*",
    });
    const afterToc = await listBookToc(repo, "mega-book");
    expect(afterToc.length).toBe(2);
    expect(afterToc[0]!.title).toBe("第1话 朔风起");
    expect(afterToc[1]!.title).toBe("第2话 夜渡河");
    const afterMeta = await getBookMeta(repo, "mega-book");
    expect(afterMeta?.totalChars).toBe(afterToc[0]!.chars + afterToc[1]!.chars);
  });
});
