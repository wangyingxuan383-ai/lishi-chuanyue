import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { Repo } from "../db/repo";
import { migrate } from "../db/migrate";
import { sampleState } from "../testing/fixtures";
import { archiveProblems, exportWorld, importWorld } from "../archive";
import { sourceAnalysisResult, sourceAnalysisText, relevantSourceFacts, structuredSourceAnalysis } from "./facts";
import { chunksOf, fitReference, newAnalysisJob, referenceContext, referenceEvidenceBlock, saveBook, saveJob } from "./library";
import { newBinding, type AnalysisJob, type SourceBook, type SourceFactData } from "./types";

async function setup() {
  const platform = await createMemoryPlatform(); await migrate(platform); const repo = new Repo(platform);
  const book: SourceBook = { id: crypto.randomUUID(), title: "山中记", format: "txt", createdAt: new Date().toISOString(), sections: [
    { title: "山门", text: "沈青字子安，尚是山中学徒，惯用竹笛。" },
    { title: "药庐", text: "沈青善辨药性，受任医官。师父唤他青先生。" },
    { title: "归来", text: "沈青后来继任掌门，号玄影。" },
  ] };
  await saveBook(repo, book); const binding = newBinding(book.id, true);
  const job = newAnalysisJob(book, binding, "mock"); await saveJob(repo, job);
  return { repo, platform, book, binding, job };
}

async function storePart(repo: Repo, book: SourceBook, job: AnalysisJob, section: number, facts: SourceFactData[], summary = "章节资料") {
  const chunk = chunksOf(book).find((c) => c.section === section)!;
  const parsed = sourceAnalysisResult(JSON.stringify({ summary, facts }), book, chunk, job);
  await repo.platform.sql.batch([{ sql: "INSERT INTO source_analysis(job_id,book_id,ordinal,section,text) VALUES(?,?,?,?,?)", params: [job.id, book.id, chunk.ordinal, section, parsed.text] }, ...parsed.statements]);
  return parsed;
}

describe("structured source analysis", () => {
  it("requires exact local quotes and assigns provenance on the host, preserving plain-text notes", async () => {
    const { repo, book, job } = await setup(), chunk = chunksOf(book)[0];
    const valid = { kind: "person", subject: "沈青", aliases: ["子安", "子安", "沈青"], statement: "沈青字子安，此时还是学徒。", quote: "沈青字子安，尚是山中学徒", validFrom: 0, validThrough: 0 };
    const result = sourceAnalysisResult(JSON.stringify({ summary: "山门人物", facts: [
      { ...valid, bookId: "伪造", jobId: "其他任务", section: 2, chunk: 99 },
      { ...valid, statement: "未来身份", quote: book.sections[2].text },
      { ...valid, statement: "虚构未来范围", validFrom: 2 },
      { ...valid, kind: "instruction" },
    ] }), book, chunk, job);
    await repo.platform.sql.batch(result.statements);
    const rows = await repo.platform.sql.query("SELECT * FROM canon_facts");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ book_id: book.id, job_id: job.id, section: 0, chunk: 0, quote: valid.quote, aliases_json: '["子安"]' });
    expect(structuredSourceAnalysis(result.text)?.facts).toHaveLength(1);
    expect(sourceAnalysisText(result.text)).toBe("山门人物");
    expect(sourceAnalysisText("旧整理：沈青守信。")).toBe("旧整理：沈青守信。");
    const legacy = sourceAnalysisResult("旧整理：沈青守信。", book, chunk, job);
    expect(legacy.text).toBe("旧整理：沈青守信。");
    expect(legacy.statements).toHaveLength(1); // No fabricated facts from old prose.
    expect(() => sourceAnalysisResult("{}", book, { ...chunk, section: 1 }, job)).toThrow("原著");
  });

  it("uses allowed aliases to find original text and keeps identity ranges separate from later revelations", async () => {
    const { repo, book, job, binding } = await setup();
    await storePart(repo, book, job, 0, [{ kind: "person", subject: "沈青", aliases: ["子安"], statement: "沈青字子安。", quote: "沈青字子安" }]);
    await storePart(repo, book, job, 1, [{ kind: "person", subject: "沈青", aliases: ["青先生"], statement: "受任医官后被称为青先生。", quote: "沈青善辨药性，受任医官。师父唤他青先生。", validFrom: 1 }]);
    await storePart(repo, book, job, 2, [{ kind: "person", subject: "沈青", aliases: ["玄影"], statement: "后来继任掌门。", quote: "沈青后来继任掌门，号玄影。", validFrom: 2 }]);
    const context = await referenceContext(repo, { ...binding, position: 1, through: 1 }, "子安的本领", 5000);
    expect(referenceEvidenceBlock(context)).toContain("沈青善辨药性");
    expect(context?.passages.some((p) => p.fact?.aliases.includes("子安"))).toBe(true);
    expect(referenceEvidenceBlock(context)).not.toContain("玄影");
    expect(await relevantSourceFacts(repo, binding, new Map([["玄影", 4]]), 1, 1)).toEqual([]);
    expect(await relevantSourceFacts(repo, binding, new Map([["玄影", 4]]), 2, 1)).toEqual([]);
    expect(await relevantSourceFacts(repo, binding, new Map([["玄影", 4]]), 2, 2)).toHaveLength(1);
    const narrow = fitReference(context, 90)!;
    expect(narrow.passages.every((p) => !p.fact || narrow.passages.some((o) => o.kind === "original" && o.chunk === p.chunk && o.text.includes(p.fact!.quote)))).toBe(true);
  });

  it("does not reuse an explicitly expired identity even when the book permits later chapters", async () => {
    const { repo, book, job, binding } = await setup();
    await storePart(repo, book, job, 0, [{ kind: "person", subject: "沈青", aliases: ["子安"], statement: "此时是学徒。", quote: "尚是山中学徒", validFrom: 0, validThrough: 0 }]);
    expect(await relevantSourceFacts(repo, binding, new Map([["子安", 4]]), 2, 0)).toHaveLength(1);
    expect(await relevantSourceFacts(repo, binding, new Map([["子安", 4]]), 2, 1)).toEqual([]);
  });

  it("rebuilds the same cited index with fresh book and job ids during archive import", async () => {
    const { repo, book, job, binding } = await setup();
    await storePart(repo, book, job, 0, [{ kind: "person", subject: "沈青", aliases: ["子安"], statement: "沈青字子安。", quote: "沈青字子安" }], "沈青的名与字");
    const state = sampleState(); state.source = { ...binding, method: "analysis", analysisId: job.id };
    const { world } = await repo.createWorld({ title: "资料归档", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "山门相逢。", state } });
    const archive = await exportWorld(repo, world.id);
    expect(archive.version).toBe(4); expect(archiveProblems(archive)).toEqual([]);
    const imported = await importWorld(repo, archive, "new");
    const copy = await exportWorld(repo, imported), copyBook = copy.books![0];
    expect(copyBook.book.id).not.toBe(book.id); expect(copyBook.jobs[0].id).not.toBe(job.id);
    const [fact] = await repo.platform.sql.query("SELECT * FROM canon_facts WHERE book_id=?", [copyBook.book.id]);
    expect(fact).toMatchObject({ book_id: copyBook.book.id, job_id: copyBook.jobs[0].id, subject: "沈青", aliases_json: '["子安"]', section: 0, chunk: 0, quote: "沈青字子安" });
    expect(copyBook.analysis[0].jobId).toBe(copyBook.jobs[0].id);
    expect(copyBook.analysis[0].text).toBe(archive.books![0].analysis[0].text);
    const corrupt = structuredClone(archive), parsed = JSON.parse(corrupt.books![0].analysis[0].text);
    parsed.facts[0].quote = book.sections[2].text; corrupt.books![0].analysis[0].text = JSON.stringify(parsed);
    expect(archiveProblems(corrupt)).toContain("书籍整理事实缺少有效原文出处或生效范围");
  });
});
