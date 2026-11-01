import { describe, expect, it } from "vitest";
import { Game } from "../game";
import { createMemoryPlatform } from "../../platform/memory";
import { fitReference, newAnalysisJob, referenceBlock, referenceContext, referenceEvidenceBlock, saveBook, saveJob } from "./library";
import { newBinding, type SourceBook } from "./types";
import { sourceAnalysisMessages } from "./analysis";

const bookOf = (texts: string[]): SourceBook => ({ id: crypto.randomUUID(), title: "虚构资料", format: "txt", createdAt: new Date().toISOString(), sections: texts.map((text, i) => ({ title: `第${i + 1}章`, text })) });
async function setup(texts: string[]) {
  const game = await Game.open(await createMemoryPlatform()), book = bookOf(texts);
  await saveBook(game.repo, book);
  return { game, book, binding: newBinding(book.id, true) };
}

describe("source evidence retrieval", () => {
  it("returns a late hit inside a chunk, keeping its exact immutable offsets after a smaller fit", async () => {
    const text = "雨".repeat(2000) + "青铜钥匙藏在灯座下。" + "雪".repeat(200);
    const { game, book, binding } = await setup([text]);
    const context = await referenceContext(game.repo, binding, "青铜钥匙", 3000);
    expect(referenceEvidenceBlock(context)).toContain("青铜钥匙藏在灯座下");
    const smaller = fitReference(context, 350)!;
    expect(referenceEvidenceBlock(smaller)).toContain("青铜钥匙");
    for (const p of smaller.passages) expect(book.sections[p.section].text.slice(p.start, p.end)).toBe(p.text);
    expect(referenceEvidenceBlock(smaller).length).toBeLessThanOrEqual(350);
  });

  it("filters future chapters before ranking, without losing an allowed hit behind many future matches", async () => {
    const { game, binding } = await setup(["雨".repeat(2400) + "青龙在药铺行医。", ...Array.from({ length: 60 }, () => "青龙剧情：终章秘密。")]);
    const context = await referenceContext(game.repo, { ...binding, through: 0 }, "青龙 剧情", 3000);
    expect(referenceEvidenceBlock(context)).toContain("青龙在药铺行医");
    expect(context!.passages.every((p) => p.section === 0)).toBe(true);
    expect(referenceEvidenceBlock(context)).not.toContain("终章秘密");
  });

  it("uses correction directions, aliases, the saved instructions and current position", async () => {
    const { game, binding } = await setup(["渡口下着小雨。", "沈青擅长医术，不会御剑。", "玉佩为白玉，边缘刻着梅花。", "阿白此时是学徒，尚未继任掌门。", "阿白后来继任掌门。"]);
    const aliases = await referenceContext(game.repo, binding, { text: "问她的本领", entities: [{ name: "阿青", aliases: ["沈青"] }] }, 3000);
    expect(referenceEvidenceBlock(aliases)).toContain("沈青擅长医术");
    const correction = await referenceContext(game.repo, binding, { text: "再写一版", rewriteHint: "玉佩应是什么材质、什么纹样？" }, 3000);
    expect(referenceEvidenceBlock(correction)).toContain("玉佩为白玉");
    const instructions = "按原著使用人物设定。".repeat(500) + "核对玉佩的梅花纹样。";
    const withInstructions = await referenceContext(game.repo, { ...binding, instructions }, "继续", 3000);
    expect(referenceEvidenceBlock(withInstructions)).toContain("玉佩为白玉");
    expect(referenceBlock(withInstructions)).toContain(instructions);
    const at = await referenceContext(game.repo, { ...binding, position: 3, through: 3 }, "阿白", 3000);
    expect(referenceEvidenceBlock(at)).toContain("此时是学徒");
    expect(referenceEvidenceBlock(at)).not.toContain("后来继任");
    expect(referenceBlock(at)).toContain("不把后来揭示的身份写成之前人人已知");
  });

  it("keeps analysis limited to cited allowed chunks and always retains original evidence first", async () => {
    const { game, book, binding } = await setup(["沈青守信，经营药铺。", "终章秘密：沈青是公主。"]);
    const source = { ...binding, method: "analysis" as const, through: 0 };
    const job = newAnalysisJob(book, source, "fake"); await saveJob(game.repo, job);
    await game.platform.sql.batch([
      { sql: "INSERT INTO source_analysis(job_id,book_id,ordinal,section,text) VALUES(?,?,?,?,?)", params: [job.id, book.id, 0, 0, "人物性格：沈青守信。【第1章·片段1】"] },
      { sql: "INSERT INTO source_analysis(job_id,book_id,ordinal,section,text) VALUES(?,?,?,?,?)", params: [job.id, book.id, 1, 1, "终章秘密：公主。【第2章·片段2】"] },
    ]);
    const context = await referenceContext(game.repo, { ...source, analysisId: job.id }, "沈青身份", 3000);
    expect(context!.passages.map((p) => p.kind)).toEqual(["original", "analysis"]);
    expect(context!.passages.every((p) => p.section === 0)).toBe(true);
    expect(referenceBlock(context)).not.toContain("终章秘密");
    expect(referenceEvidenceBlock(context)).toContain("原文");
    expect(referenceEvidenceBlock(context)).toContain("AI整理");
    const messages = sourceAnalysisMessages(book, { section: 0, ordinal: 0, text: book.sections[0].text }, source.instructions);
    expect(messages[0].content).toContain("此时谁知道");
    expect(messages[1].content).not.toContain("终章秘密");
  });

  it("keeps complete player instructions and marks insufficient evidence when no text fits", async () => {
    const { game, binding } = await setup(["沈青守信。"]);
    const instructions = "保存的使用说明。".repeat(800) + "最后要求必须保留。";
    const context = await referenceContext(game.repo, { ...binding, instructions }, "沈青", 0);
    expect(context?.status).toBe("insufficient");
    expect(context?.reason).toBe("budget");
    expect(context?.passages).toEqual([]);
    expect(referenceBlock(context, 0)).toContain(instructions);
  });
});
