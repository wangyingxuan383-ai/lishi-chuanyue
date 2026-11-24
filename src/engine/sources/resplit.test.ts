import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { migrate } from "../db/migrate";
import { Repo } from "../db/repo";
import { getReaderProgress, saveReaderProgress } from "../reader/store";
import { listBookToc, readBookSection, saveBook, searchBookFullText } from "./library";
import { applyBookResplit, inferFrontMatterTitle, previewBookResplit } from "./resplit";

describe("TXT custom & preset chapter re-splitter (R36-T003)", () => {
  it("re-splits numbered web-novel chapters, names front-matter smartly, updates search index, and clamps progress", async () => {
    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);

    const rawNovel = [
      "作品简介：一卷塞北风云录。",
      "【001】风雪雁门关",
      "朔风呼啸，关城之上旌旗猎猎作响。",
      "守捉郎握紧佩刀，望向苍茫雪原。",
      "【002】夜宿古驿",
      "驿丞挑亮油灯，端上一碗滚烫的羊汤。",
      "【003】长安急使",
      "八百里加急羽书连夜驰入关城。",
    ].join("\n\n");

    // Initially imported as a single unsplit "正文" section
    await saveBook(repo, {
      id: "txt-raw",
      title: "塞北风云录",
      format: "txt",
      createdAt: "2026-11-24T01:00:00.000Z",
      sections: [{ title: "正文", text: rawNovel }],
    });

    await saveReaderProgress(repo, {
      targetType: "book",
      targetId: "txt-raw",
      sectionIndex: 99,
      pageIndex: 2,
      scrollRatio: 0.8,
      anchorText: "",
      nodeId: null,
    });

    const preview = await previewBookResplit(repo, "txt-raw", { preset: "numbered" });
    expect(preview.sectionCount).toBe(4);
    expect(preview.sampleTitles).toEqual([
      "作品简介",
      "【001】风雪雁门关",
      "【002】夜宿古驿",
      "【003】长安急使",
    ]);

    const applied = await applyBookResplit(repo, "txt-raw", { preset: "numbered" });
    expect(applied.sectionCount).toBe(4);

    // Re-applying resplit is idempotent and does not duplicate front-matter headings
    const reapplied = await applyBookResplit(repo, "txt-raw", { preset: "numbered" });
    expect(reapplied.sampleTitles).toEqual([
      "作品简介",
      "【001】风雪雁门关",
      "【002】夜宿古驿",
      "【003】长安急使",
    ]);

    const toc = await listBookToc(repo, "txt-raw");
    expect(toc.map((t) => t.title)).toEqual([
      "作品简介",
      "【001】风雪雁门关",
      "【002】夜宿古驿",
      "【003】长安急使",
    ]);

    const sec0 = await readBookSection(repo, "txt-raw", 0);
    expect(sec0?.paragraphs[0]).toBe("作品简介：一卷塞北风云录。");

    const sec2 = await readBookSection(repo, "txt-raw", 2);
    expect(sec2?.title).toBe("【002】夜宿古驿");
    expect(sec2?.paragraphs[0]).toContain("羊汤");

    const hits = await searchBookFullText(repo, "txt-raw", "羽书");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.section).toBe(3);

    const clampedProg = await getReaderProgress(repo, "book", "txt-raw");
    expect(clampedProg?.sectionIndex).toBe(3);
  });

  it("names unmarked front-matter block '前言' instead of '正文' and recognizes preface keywords", async () => {
    expect(inferFrontMatterTitle("内容简介\n长安少年行。")).toBe("内容简介");
    expect(inferFrontMatterTitle("提要：前尘旧事一笔勾销。")).toBe("提要");
    expect(inferFrontMatterTitle("楔子 残阳如血\n朔风吹雪。")).toBe("楔子 残阳如血");
    expect(inferFrontMatterTitle("贞观三年秋，长安西市暮鼓初鸣。")).toBe("前言");

    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);

    await saveBook(repo, {
      id: "txt-preface",
      title: "西市行",
      format: "txt",
      createdAt: "2026-11-24T01:00:00.000Z",
      sections: [
        {
          title: "正文",
          text: "贞观三年秋，长安西市暮鼓初鸣。\n\n第一章 坊门初开\n人流涌入西市。",
        },
      ],
    });

    const preview = await previewBookResplit(repo, "txt-preface", { preset: "standard" });
    expect(preview.sampleTitles).toEqual(["前言", "第一章 坊门初开"]);
  });

  it("supports custom regex and fixed-length fallback while rejecting dangerous or empty patterns", async () => {
    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);

    await saveBook(repo, {
      id: "txt-custom",
      title: "残卷",
      format: "txt",
      createdAt: "2026-11-24T01:00:00.000Z",
      sections: [
        {
          title: "正文",
          text: "卷甲 初见\n春雨如酥。\n\n卷乙 远行\n扁舟一叶下扬州。",
        },
      ],
    });

    const custom = await previewBookResplit(repo, "txt-custom", {
      preset: "custom",
      customPattern: "^卷[甲乙丙丁]\\s+.+$",
    });
    expect(custom.sectionCount).toBe(2);
    expect(custom.sampleTitles).toEqual(["卷甲 初见", "卷乙 远行"]);

    await expect(
      previewBookResplit(repo, "txt-custom", {
        preset: "custom",
        customPattern: "(a+)+$",
      }),
    ).rejects.toThrow(/嵌套量词/);

    await expect(
      previewBookResplit(repo, "txt-custom", {
        preset: "symbols",
      }),
    ).rejects.toThrow(/未匹配到任何章节标题/);

    const fixed = await previewBookResplit(repo, "txt-custom", {
      preset: "fixed_length",
      fixedChars: 800,
    });
    expect(fixed.sectionCount).toBe(1);
  });
});
