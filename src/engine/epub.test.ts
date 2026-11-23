import { XMLValidator } from "fast-xml-parser";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { buildEpubBytes } from "./epub";
import type { NovelBook } from "./novel";
import { parseBook } from "./sources/parse";

function sampleNovelBook(): NovelBook {
  return {
    worldId: "world-01",
    lineId: "line-main",
    lineName: "主线",
    title: "长安风雪 & <夜行录>",
    subtitle: "李安 · 天宝七载 冬月十七",
    author: "李安 传",
    eraTitle: "盛唐天宝",
    seal: "功成",
    statusLine: "—— 本卷完 ——",
    generatedAt: "2026-11-24T02:00:00.123Z",
    turnCount: 12,
    chapterCount: 2,
    totalChars: 180,
    sections: [
      {
        index: 0,
        kind: "preface",
        title: "卷首 · 人物与前情",
        chapterNumber: null,
        paragraphs: [
          { kind: "prose", text: "李安，天宝年间入长安，结识王掌柜与裴十二。" },
        ],
        chars: 22,
      },
      {
        index: 1,
        kind: "prologue",
        title: "楔子",
        subtitle: "天宝七载 冬月十七 · 怀远坊",
        chapterNumber: null,
        paragraphs: [
          { kind: "prose", text: "暮鼓声中，大雪初落。" },
        ],
        chars: 10,
      },
      {
        index: 2,
        kind: "chapter",
        title: "第一回 · 初入长安",
        subtitle: "天宝七载 冬月十八 · 西市",
        chapterNumber: 1,
        paragraphs: [
          {
            kind: "prose",
            text: "西市茶肆里有人低语：\"米价涨了 <三成> & '胡商'未归\x00\x07\x0B\x1F。\"",
          },
          { kind: "divider", text: "天宝七载 冬月二十 · 东市" },
          { kind: "prose", text: "东市长街灯火通明，车马络绎不绝。" },
        ],
        chars: 64,
      },
      {
        index: 3,
        kind: "chapter",
        title: "第二回 · 雪夜定计",
        chapterNumber: 2,
        paragraphs: [
          { kind: "action", text: "你：取出铜鹰符核对暗记" },
          { kind: "prose", text: "裴十二接过铜鹰符，神色骤然凝重。" },
        ],
        chars: 32,
      },
      {
        index: 4,
        kind: "appendix",
        title: "附录 · 本局大事纪年",
        chapterNumber: null,
        paragraphs: [
          { kind: "prose", text: "功成之事：查明西市米价异动。" },
        ],
        chars: 14,
      },
    ],
  };
}

describe("W3C EPUB 3.3 packager (epub.ts)", () => {
  it("writes uncompressed mimetype at exact OCF byte offsets 30..58", () => {
    const bytes = buildEpubBytes(sampleNovelBook());
    // PK\x03\x04 local file header signature
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // Compression method at bytes 8..10 must be 0 (STORE / uncompressed)
    const compressionMethod = bytes[8] | (bytes[9] << 8);
    expect(compressionMethod).toBe(0);
    // Extra field length at bytes 28..30 must be 0
    const extraLen = bytes[28] | (bytes[29] << 8);
    expect(extraLen).toBe(0);
    // Exact OCF byte offsets: 30..38 = "mimetype", 38..58 = "application/epub+zip"
    expect(strFromU8(bytes.slice(30, 38))).toBe("mimetype");
    expect(strFromU8(bytes.slice(38, 58))).toBe("application/epub+zip");
  });

  it("produces strictly valid XML across all .xml, .opf, .ncx, .svg, and .xhtml entries and night-mode safe CSS", () => {
    const book = sampleNovelBook();
    const bytes = buildEpubBytes(book);
    const entries = unzipSync(bytes);

    expect(entries["META-INF/container.xml"]).toBeDefined();
    expect(entries["OEBPS/content.opf"]).toBeDefined();
    expect(entries["OEBPS/nav.xhtml"]).toBeDefined();
    expect(entries["OEBPS/toc.ncx"]).toBeDefined();
    expect(entries["OEBPS/cover.xhtml"]).toBeDefined();
    expect(entries["OEBPS/cover.svg"]).toBeDefined();
    expect(entries["OEBPS/styles/book.css"]).toBeDefined();

    const xmlPaths = Object.keys(entries).filter((p) => /\.(?:xml|opf|ncx|xhtml|svg)$/i.test(p));
    expect(xmlPaths.length).toBeGreaterThanOrEqual(10);

    for (const path of xmlPaths) {
      const raw = strFromU8(entries[path]);
      // Must strip illegal XML control chars
      expect(raw).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
      const withoutDoctype = raw.replace(/<!DOCTYPE[^>]*>/gi, "");
      expect(XMLValidator.validate(withoutDoctype)).toBe(true);
    }

    const opf = strFromU8(entries["OEBPS/content.opf"]);
    expect(opf).toContain('version="3.0"');
    expect(opf).toContain("<dc:language>zh-CN</dc:language>");
    expect(opf).toContain('<meta property="dcterms:modified">2026-11-24T02:00:00Z</meta>');

    const nav = strFromU8(entries["OEBPS/nav.xhtml"]);
    expect(nav).toContain('epub:type="toc"');

    const cover = strFromU8(entries["OEBPS/cover.xhtml"]);
    expect(cover).toContain("<svg");
    expect(cover).toContain("功");
    expect(cover).toContain("成");

    const css = strFromU8(entries["OEBPS/styles/book.css"]);
    expect(css).toContain("text-indent: 2em");
    expect(css).toContain("line-height: 1.9");
    expect(css).toContain("color: inherit");
    expect(css).not.toMatch(/body\s*\{[^}]*background(?:-color)?\s*:\s*(?:#fff|#ffffff|white|rgb)/i);
  });

  it("round-trips cleanly through parseBook recovering title, chapters, and prose text", async () => {
    const platform = await createMemoryPlatform();
    const book = sampleNovelBook();
    const epubBytes = buildEpubBytes(book);

    const parsed = await parseBook({ name: "export.epub", bytes: epubBytes }, platform);
    expect(parsed.format).toBe("epub");
    expect(parsed.title).toBe("长安风雪 & <夜行录>");
    expect(parsed.sections.map((s) => s.title)).toEqual([
      "卷首 · 人物与前情",
      "楔子",
      "第一回 · 初入长安",
      "第二回 · 雪夜定计",
      "附录 · 本局大事纪年",
    ]);

    const ch1 = parsed.sections[2];
    expect(ch1.text).toContain("米价涨了 <三成> & '胡商'未归。");
    expect(ch1.text).toContain("东市长街灯火通明，车马络绎不绝。");

    const ch2 = parsed.sections[3];
    expect(ch2.text).toContain("裴十二接过铜鹰符，神色骤然凝重。");
    expect(ch2.text).toContain("—— 本卷完 ——");
  });
});
