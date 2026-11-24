import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { migrate } from "../db/migrate";
import { Repo } from "../db/repo";
import { saveBook } from "../sources/library";
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
});
