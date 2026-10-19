import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { createMemoryPlatform } from "../../platform/memory";
import { Game } from "../game";
import { sampleState } from "../testing/fixtures";
import { fakeLlm, RECORD } from "../testing/fakeLlm";
import { parseBook, decodeText } from "./parse";
import { analysisJobs, deleteBook, fitReference, getBook, referenceBlock, referenceContext, saveBook } from "./library";
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
    expect(prompt.layers.find((l) => l.key === "reference")!.chars).toBeLessThanOrEqual(3000);
    const without = buildTurnContext({ state, era: eraContext("tang-748", state), settings: DEFAULT_SETTINGS, protagonistName: "李安", history: [], mode: "do", text: "救下阿兰", budgetChars: 500 });
    const tight = buildTurnContext({ state, era: eraContext("tang-748", state), settings: DEFAULT_SETTINGS, protagonistName: "李安", history: [], mode: "do", text: "救下阿兰", budgetChars: 500, reference: context });
    expect(tight.messages).toEqual(without.messages);
    expect(fitReference(context, 100)).toBeUndefined();
    expect(normalizeRecord({ time: "一刻", sourceSet: null })?.sourceSet).toBeUndefined();
  });

  it("pauses/reuses completed analysis parts, stores branch bindings and round-trips immutable books with rebuilt indexes", async () => {
    const llm = fakeLlm([{ text: "人物：阿青守信。[第一章 灯·片段1]" }, { text: "剧情：阿青交出钥匙。[第二章 信·片段2]" }]);
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
    const archive = await exportWorld(game.repo, world.id); expect(archive.version).toBe(3); expect(archiveProblems(archive)).toEqual([]);
    const copy = await importWorld(game.repo, archive, "new");
    const copyState = await game.repo.getState((await tree.cursor(game.repo, copy)).head.parentId!);
    expect(copyState.source?.bookId).not.toBe(book.id);
    const copied = (await getBook(game.repo, copyState.source!.bookId))!;
    expect(copied.sections).toEqual(book.sections);
    const results = await referenceContext(game.repo, copyState.source, "钥匙", 3000); expect(results?.passages.some((p) => p.kind === "analysis")).toBe(true);
    expect((await analysisJobs(game.repo, copied.id))[0].completed).toBe(2);
    expect((await game.repo.getState(bound.head.id)).source).toEqual(binding);
    expect(JSON.stringify(llm.calls)).not.toContain("终章秘密");
  });

  it("uses saved source settings for opening, skip, regenerate, edited interrupted continuation and ask", async () => {
    const llm = fakeLlm([
      { text: "你走进书铺，阿青向你点头。" + RECORD({ time: "0", place: "书铺" }) },
      { text: "几天后，阿兰仍安然住在书铺。" + RECORD({ time: "三天" }) },
      { text: "你在书铺过了三天，阿青照看着妹妹。" + RECORD({ time: "三天" }) },
      { text: "纸包里是一把钥匙，阿青让你先收好。" + RECORD({ time: "十分钟" }) },
      { text: "【原著参考·第一章 灯】阿青重信守诺。" },
    ]);
    const game = await Game.open(await createMemoryPlatform(llm), llmConfig), book = shortBook(); await saveBook(game.repo, book);
    const source = { ...newBinding(book.id, true), through: 0 };
    const id = (await game.createWorld({ source, title: "开局引用", eraId: null, settings: { mode: "free", chapterEvery: 0, autoUpkeep: false, fortune: "off" }, protagonist: { name: "沈舟", gender: "男", age: 20, identity: "旅人" }, arrival: "不穿越", origin: "", opening: { mode: "ai", hint: "在书铺碰见阿青" } }, () => {}))!;
    let c = await tree.cursor(game.repo, id); expect(c.head.meta.reference).toBeDefined();
    await game.play(id, { mode: "skip", text: "过三天；在书铺休息" }, () => {}).done;
    expect((await tree.cursor(game.repo, id)).head.meta.reference).toBeDefined();
    const changed = { ...source, instructions: "按新用法保留已救下的阿兰" };
    await game.bindSource(id, changed);
    await game.regenerate(id, "换个写法", () => {}).done;
    expect(JSON.stringify(llm.calls[2].body)).toContain(changed.instructions);
    c = await tree.cursor(game.repo, id); expect((await game.repo.getState(c.head.id)).source).toEqual(changed);
    c = await tree.append(game.repo, c, { kind: "turn", narrative: "你打开纸包，", status: "interrupted", state: await game.repo.getState(c.head.id), actionMode: "do", actionText: "打开纸包" });
    const continued = { ...changed, instructions: "续写继续参考阿青守信，不恢复原著结局" };
    await game.bindSource(id, continued);
    const editId = (await tree.cursor(game.repo, id)).head.id;
    await game.resumeInterrupted(id, () => {}).done;
    c = await tree.cursor(game.repo, id);
    expect(c.head.id).toBe(editId); expect((await game.repo.getState(c.head.id)).source).toEqual(continued);
    expect((await game.repo.getNode(c.head.parentId!))!.narrative).toContain("纸包里是一把钥匙");
    expect(JSON.stringify(llm.calls[3].body)).toContain(continued.instructions);
    expect(await game.ask(id, "阿青性格如何？", () => {})).toContain("原著参考");
    expect(llm.calls).toHaveLength(5);
    expect(JSON.stringify(llm.calls)).not.toContain("终章秘密");
  });
});
