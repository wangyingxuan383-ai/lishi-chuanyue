import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { createMemoryPlatform } from "../../platform/memory";
import { Game } from "../game";
import { sampleState } from "../testing/fixtures";
import { fakeLlm } from "../testing/fakeLlm";
import { parseBook, decodeText } from "./parse";
import {
  analysisJobs,
  deleteBook,
  fitReference,
  getBook,
  getBookMeta,
  listBookToc,
  readBookSection,
  referenceBlock,
  referenceContext,
  referenceEvidenceBlock,
  saveBook,
  searchBookFullText,
} from "./library";
import { chapterRangeSummary, extractChapterNumbers } from "./scope";
import { newBinding, type SourceBook } from "./types";
import { archiveProblems, exportWorld, importWorld } from "../archive";
import { buildTurnContext } from "../prompt/turn";
import { eraContext } from "../era";
import { DEFAULT_SETTINGS } from "../types";
import * as tree from "../tree";
import { normalizeRecord } from "../record/parse";

const shortBook = (): SourceBook => ({ id: crypto.randomUUID(), title: "灯下书", format: "txt", createdAt: new Date().toISOString(), sections: [
  { title: "第一章 灯", text: "阿青在青石桥经营书铺。她守信，不愿出卖朋友。青铜钥匙藏在灯座下。" },
  { title: "第二章 信", text: "阿青把青铜钥匙交给阿白，二人约定救下阿兰。" },
  { title: "第三章 雪", text: "终章秘密：阿白其实是北地王子，原著阿兰在雪夜死去。" },
] });
const llmConfig = { slot: "test", url: "https://test.invalid/v1/chat/completions", model: "m", auxModel: "aux", includeUsage: true };

describe("external books", () => {
  it("decodes Chinese TXT encodings, chapters, EPUB spine and DOCX tables in document order", async () => {
    const platform = await createMemoryPlatform();
    expect(decodeText(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]))).toBe("中文");
    expect(decodeText(new Uint8Array([255, 254, 45, 78, 135, 101]))).toBe("中文");
    expect(decodeText(new Uint8Array([254, 255, 78, 45, 101, 135]))).toBe("中文");
    const txt = await parseBook({ name: "灯下书.txt", bytes: strToU8("第一章 灯\n阿青在桥边。\n第二章 信\n阿白来了。") }, platform);
    expect(txt.sections.map((s) => s.title)).toEqual(["第一章 灯", "第二章 信"]);
    const epub = zipSync({
      "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'),
      "OEBPS/book.opf": strToU8('<package><metadata><dc:title xmlns:dc="dc" id="title">灯下书</dc:title></metadata><manifest><item id="one" href="z.xhtml"/><item id="two" href="a.xhtml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>'),
      "OEBPS/a.xhtml": strToU8('<html><head><title>忽略</title></head><body><h1>第二章 信</h1><p>阿白来了。</p></body></html>'),
      "OEBPS/z.xhtml": strToU8('<html><body><h1>第一章 灯</h1><p>阿青守信。</p></body></html>'),
    });
    const book = await parseBook({ name: "x.epub", bytes: epub }, platform);
    expect(book.title).toBe("灯下书"); expect(book.sections.map((s) => s.title)).toEqual(["第一章 灯", "第二章 信"]);
    const docx = zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 灯</w:t></w:r></w:p><w:p><w:r><w:t>段落一</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>表格乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>段落二</w:t></w:r></w:p></w:body></w:document>') });
    const doc = await parseBook({ name: "灯.docx", bytes: docx }, platform);
    expect(doc.sections[0].title).toBe("第一章 灯"); expect(doc.sections[0].text).toMatch(/段落一[\s\S]*表格甲[\s\S]*表格乙[\s\S]*段落二/);
    await expect(parseBook({ name: "坏.epub", bytes: strToU8("PK坏文件") }, platform)).rejects.toThrow();
    const cancel = new AbortController(); cancel.abort();
    await expect(parseBook({ name: "x.txt", bytes: strToU8("正文") }, platform, { signal: cancel.signal })).rejects.toMatchObject({ name: "AbortError" });
    platform.files.extractPdf = async () => ({ pages: ["", ""], headings: [] });
    await expect(parseBook({ name: "scan.pdf", bytes: strToU8("%PDF-1.7") }, platform)).rejects.toThrow("扫描图片型");
    platform.files.extractPdf = async () => ({ pages: ["第一页中文", "第二页中文"], headings: [{ title: "第一章", page: 1 }] });
    expect((await parseBook({ name: "text.pdf", bytes: strToU8("%PDF-1.7") }, platform)).sections.map((s) => s.page)).toEqual([1, 2]);
  });

  it("isolates scope in originals and analysis, respects the context budget and excludes source edits from model records", async () => {
    const game = await Game.open(await createMemoryPlatform()); const book = shortBook(); await saveBook(game.repo, book);
    const binding = { ...newBinding(book.id, true), through: 0 };
    const context = await referenceContext(game.repo, binding, "阿白 王子 雪夜", 3000);
    expect(context?.passages.every((p) => p.section === 0)).toBe(true);
    expect(referenceBlock(context)).not.toContain("终章秘密");
    expect(referenceBlock(context)).toContain("本局实际正文、当前事实和玩家行动优先");
    const state = sampleState(); state.source = binding;
    const prompt = buildTurnContext({ state, era: eraContext("tang-748", state), settings: DEFAULT_SETTINGS, protagonistName: "李安", history: [], mode: "do", text: "救下阿兰", reference: context, budgetChars: 12000 });
    expect(referenceEvidenceBlock(prompt.reference).length).toBeLessThanOrEqual(3000);
    const tight = buildTurnContext({ state, era: eraContext("tang-748", state), settings: DEFAULT_SETTINGS, protagonistName: "李安", history: [], mode: "do", text: "救下阿兰", budgetChars: 500, reference: context });
    expect(tight.messages.at(-1)!.content).toContain(binding.instructions);
    expect(tight.reference?.status).toBe("insufficient");
    expect(tight.budgetExceeded).toBe(true);
    expect(fitReference(context, 0)?.binding.instructions).toBe(binding.instructions);
    expect(normalizeRecord({ time: "一刻", sourceSet: null })?.sourceSet).toBeUndefined();
  });

  it("pauses/reuses completed analysis parts, stores branch bindings and round-trips immutable books with rebuilt indexes", async () => {
    const llm = fakeLlm([{ text: '{"summary":"阿青守信","facts":[]}' }, { text: '{"summary":"阿青交出钥匙","facts":[]}' }]);
    const game = await Game.open(await createMemoryPlatform(llm), llmConfig);
    const book = shortBook(); await saveBook(game.repo, book);
    let binding = { ...newBinding(book.id, true), method: "analysis" as const, through: 1 };
    let paused = false;
    const job = await game.analyzeSource(binding, (j) => { if (j.completed === 1 && !paused) { paused = true; game.pauseSourceAnalysis(j.id); } });
    expect(job.status).toBe("paused"); expect(job.completed).toBe(1);
    binding = { ...binding, analysisId: job.id };
    const complete = await game.analyzeSource(binding, () => {}); expect(complete.status).toBe("done"); expect(complete.completed).toBe(2); expect(llm.calls).toHaveLength(2);
    expect((await referenceContext(game.repo, { ...binding, through: 0 }, "阿白 王子", 3000))?.passages.every((p) => p.section === 0)).toBe(true);
    const state = sampleState();
    const { world } = await game.repo.createWorld({ title: "灯下同人", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "阿兰已被你救下。", state } });
    await game.bindSource(world.id, binding);
    const bound = await tree.cursor(game.repo, world.id);
    await tree.undo(game.repo, bound); expect((await game.repo.getState((await tree.cursor(game.repo, world.id)).head.id)).source).toBeUndefined();
    await tree.redo(game.repo, await tree.cursor(game.repo, world.id));
    await game.bindSource(world.id, null);
    await expect(deleteBook(game.repo, book.id)).rejects.toThrow("历史路线");
    const archive = await exportWorld(game.repo, world.id); expect(archive.version).toBe(8); expect(archiveProblems(archive)).toEqual([]);
    const copy = await importWorld(game.repo, archive, "new");
    const copyState = await game.repo.getState((await tree.cursor(game.repo, copy)).head.parentId!);
    expect(copyState.source?.bookId).not.toBe(book.id);
    const copied = (await getBook(game.repo, copyState.source!.bookId))!;
    expect(copied.sections).toEqual(book.sections);
    const results = await referenceContext(game.repo, copyState.source, "钥匙", 3000); expect(results?.passages.some((p) => p.kind === "analysis")).toBe(true);
    expect((await analysisJobs(game.repo, copied.id))[0].completed).toBe(2);
    expect((await game.repo.getState(bound.head.id)).source).toEqual({ ...binding, through: null });
    expect(JSON.stringify(llm.calls)).not.toContain("终章秘密");
  });

  it("does not advance the analysis cursor on a truncated reply, and only retries that chunk", async () => {
    const llm = fakeLlm([
      { text: '{"summary":"已经整理好的第一章","facts":[]}' },
      { text: '{"summary":"第二章缺尾部","facts":[]}', finish: "length" },
      { text: '{"summary":"重新整理的第二章","facts":[]}' },
    ]);
    const game = await Game.open(await createMemoryPlatform(llm), llmConfig);
    const book = shortBook();
    await saveBook(game.repo, book);
    const binding = { ...newBinding(book.id, true), method: "analysis" as const, through: 1 };
    const failed = await game.analyzeSource(binding, () => {});
    expect(failed.status).toBe("failed");
    expect(failed.completed).toBe(1);
    expect(failed.error).toContain("写到一半");
    const resumed = await game.analyzeSource({ ...binding, analysisId: failed.id }, () => {});
    expect(resumed.status).toBe("done");
    expect(resumed.completed).toBe(2);
    expect(llm.calls).toHaveLength(3);
    expect(llm.calls[1].body.messages).toEqual(llm.calls[2].body.messages);
  });

  it("preserves multi-volume headings across TXT/DOCX/EPUB and never conflates volume numbers with chapter numbers", async () => {
    const platform = await createMemoryPlatform();
    const txt = await parseBook({
      name: "多卷.txt",
      bytes: strToU8("第一卷 海神缘\n第一章 初入学院\n第一卷第一章正文。\n第二卷 新生考核\n第一章 考核开始\n第二卷第一章正文。"),
    }, platform);
    expect(txt.sections.map((s) => s.title)).toEqual([
      "第一卷 海神缘 · 第一章 初入学院",
      "第二卷 新生考核 · 第一章 考核开始",
    ]);
    expect(extractChapterNumbers("第二卷 新生考核 · 第六十一章 永冻之域")).toEqual([61]);
    expect(extractChapterNumbers("第零章 序幕")).toEqual([0]);
    expect(extractChapterNumbers("Chapter 12 Awakening")).toEqual([12]);
    // Identical prefix across distinct sections must not collapse into a single section summary.
    expect(chapterRangeSummary([
      { section: 207, title: "第一卷 超长卷名截断前缀 · 第一章", chars: 100 },
      { section: 212, title: "第一卷 超长卷名截断前缀 · 第六章", chars: 100 },
    ], { from: 207, to: 212 })).toContain("～");

    const epub = zipSync({
      "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'),
      "OEBPS/book.opf": strToU8('<package><metadata><dc:title xmlns:dc="dc">多卷书</dc:title></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="c1.xhtml"/><item id="c2" href="c2.xhtml"/></manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>'),
      "OEBPS/toc.ncx": strToU8('<ncx><navMap><navPoint id="v1"><navLabel><text>第一卷 启程</text></navLabel><content src="c1.xhtml"/><navPoint id="p1"><navLabel><text>第一章 启程</text></navLabel><content src="c1.xhtml"/></navPoint></navPoint><navPoint id="v2"><navLabel><text>第二卷 考核</text></navLabel><content src="c2.xhtml"/><navPoint id="p2"><navLabel><text>第一章 考核</text></navLabel><content src="c2.xhtml"/></navPoint></navPoint></navMap></ncx>'),
      "OEBPS/c1.xhtml": strToU8('<html><body><h1>第一章 启程</h1><p>启程正文。</p></body></html>'),
      "OEBPS/c2.xhtml": strToU8('<html><body><h1>第一章 考核</h1><p>考核正文。</p></body></html>'),
    });
    const parsedEpub = await parseBook({ name: "multi.epub", bytes: epub }, platform);
    expect(parsedEpub.sections.map((s) => s.title)).toEqual([
      "第一卷 启程 · 第一章 启程",
      "第二卷 考核 · 第一章 考核",
    ]);
  });

  it("anchors current position section, weights nearby sections higher, and prints positionTitle/throughTitle", async () => {
    const game = await Game.open(await createMemoryPlatform());
    const sections = Array.from({ length: 30 }, (_, i) => ({
      title: `第${i + 1}章 ${i === 2 ? "初见" : i === 25 ? "决战" : "过渡"}`,
      text: i === 2
        ? "主角在新生考核现场展示魂环与武魂，裁判宣读规则。"
        : i === 25
          ? "全大陆高级魂师大赛决赛，新生考核早已过去多年，众人再次展示魂环。"
          : `第${i + 1}节日常修炼内容。`,
    }));
    const book: SourceBook = { id: crypto.randomUUID(), title: "绝世示例", format: "txt", createdAt: new Date().toISOString(), sections };
    await saveBook(game.repo, book);
    const binding = { ...newBinding(book.id, true), position: 2, through: 26 };
    const ctx = await referenceContext(game.repo, binding, "展示魂环", 3000);
    expect(ctx?.positionTitle).toBe("第3章 初见");
    expect(ctx?.throughTitle).toBe("第27章 过渡");
    expect(ctx?.passages[0].section).toBe(2);
    const rendered = referenceBlock(ctx);
    expect(rendered).toContain("第 3 节（第3章 初见）");
    expect(rendered).toContain("第 27 节（第27章 过渡）");
  });

  it("handles PDF >1024B preambles (F15), 上/中/下卷 headings (F16), and subtitled 楔子/序章 (F17)", async () => {
    const platform = await createMemoryPlatform();
    platform.files.extractPdf = async () => ({
      pages: ["第一章 朔风起\n正文第一页。"],
      headings: [{ page: 1, title: "上卷 西市胡风" }, { page: 1, title: "第一章 朔风起" }],
    });
    const preamble = new Uint8Array(1300).fill(0x20);
    const pdfMagic = strToU8("%PDF-1.4\n%%EOF");
    const pdfBytes = new Uint8Array(preamble.length + pdfMagic.length);
    pdfBytes.set(preamble, 0);
    pdfBytes.set(pdfMagic, preamble.length);

    const pdfBook = await parseBook({ name: "long-header.pdf", bytes: pdfBytes }, platform);
    expect(pdfBook.format).toBe("pdf");
    expect(pdfBook.sections[0]?.title).toBe("上卷 西市胡风 · 第一章 朔风起 · 第 1 页");

    const txt = [
      "楔子 寒鸦渡口",
      "渡口风雪交加，楔子打进木缝里也挡不住寒风！",
      "上卷 西市胡风",
      "第一章 胡商遗匣",
      "上卷书说到胡商留下一只紫檀匣。",
      "下卷 曲江暗流",
      "第一章 夜宴惊变",
      "曲江池畔灯火通明。",
    ].join("\n");
    const txtBook = await parseBook({ name: "shang-xia.txt", bytes: strToU8(txt) }, platform);
    expect(txtBook.sections.map((s) => s.title)).toEqual([
      "楔子 寒鸦渡口",
      "上卷 西市胡风 · 第一章 胡商遗匣",
      "下卷 曲江暗流 · 第一章 夜宴惊变",
    ]);
    expect(txtBook.sections[0]?.text).toContain("楔子打进木缝里");
    expect(txtBook.sections[1]?.text).toContain("上卷书说到");
  });

  it("supports zero-RAM per-section reading, TOC aggregation, and full-text search with through spoiler gating", async () => {
    const game = await Game.open(await createMemoryPlatform());
    const longPara0 = "甲".repeat(1500) + "，藏书阁秘卷在此。";
    const longPara1 = "乙".repeat(1400) + "，跨分片段落里的青铜罗盘与特殊问号？";
    const longPara2 = "丙".repeat(600) + "，尾段风雪夜归人。";
    const longSecText = [longPara0, longPara1, longPara2].join("\n\n");

    const book: SourceBook = {
      id: crypto.randomUUID(),
      title: "零内存长卷测试",
      format: "epub",
      createdAt: "2026-11-24T00:00:00.000Z",
      sections: [
        { title: "第一章 阁楼", text: longSecText, page: 1 },
        { title: "第二章 渡口", text: "　　渡口孤舟横斜。\n\n船家递来一封密信。", page: 12 },
        { title: "第三章 终局剧透", text: "青铜罗盘真正的幕后黑手现身王城！", page: 28 },
      ],
    };
    await saveBook(game.repo, book);

    expect(await getBookMeta(game.repo, "missing-id")).toBeNull();
    const meta = await getBookMeta(game.repo, book.id);
    expect(meta).toEqual({
      id: book.id,
      title: "零内存长卷测试",
      format: "epub",
      sectionCount: 3,
      totalChars: book.sections.reduce((n, s) => n + s.text.length, 0),
      createdAt: "2026-11-24T00:00:00.000Z",
    });

    const toc = await listBookToc(game.repo, book.id);
    expect(toc).toEqual([
      { section: 0, title: "第一章 阁楼", page: 1, chars: longSecText.length },
      { section: 1, title: "第二章 渡口", page: 12, chars: book.sections[1].text.length },
      { section: 2, title: "第三章 终局剧透", page: 28, chars: book.sections[2].text.length },
    ]);

    expect(await readBookSection(game.repo, book.id, 99)).toBeNull();
    const sec0 = (await readBookSection(game.repo, book.id, 0))!;
    expect(sec0.text).toBe(longSecText);
    expect(sec0.paragraphs).toEqual([longPara0, longPara1, longPara2]);

    const sec1 = (await readBookSection(game.repo, book.id, 1))!;
    expect(sec1.paragraphs).toEqual(["渡口孤舟横斜。", "船家递来一封密信。"]);

    // 2-char+ CJK search via `source_terms` postings + exact paragraph alignment across multi-chunk section
    const compassAll = await searchBookFullText(game.repo, book.id, "青铜罗盘");
    expect(compassAll.map((h) => ({ section: h.section, paragraphIndex: h.paragraphIndex, hit: h.snippet.hit }))).toEqual([
      { section: 0, paragraphIndex: 1, hit: "青铜罗盘" },
      { section: 2, paragraphIndex: 0, hit: "青铜罗盘" },
    ]);
    expect(sec0.paragraphs[compassAll[0].paragraphIndex]).toContain("青铜罗盘");

    // Spoiler gating: `through: 1` strictly hides section 2!
    const compassGated = await searchBookFullText(game.repo, book.id, "青铜罗盘", { through: 1 });
    expect(compassGated).toHaveLength(1);
    expect(compassGated[0].section).toBe(0);
    expect(await searchBookFullText(game.repo, book.id, "幕后黑手", { through: 1 })).toEqual([]);

    // 1-char / punctuation fallback (`LIKE`) also respects `through` and aligns `paragraphIndex`
    const oneCharGated = await searchBookFullText(game.repo, book.id, "船", { through: 1 });
    expect(oneCharGated).toHaveLength(1);
    expect(oneCharGated[0]).toMatchObject({ section: 1, paragraphIndex: 1 });
    expect(await searchBookFullText(game.repo, book.id, "！", { through: 1 })).toEqual([]);
    expect((await searchBookFullText(game.repo, book.id, "！", { through: null }))[0]?.section).toBe(2);
  });

});
