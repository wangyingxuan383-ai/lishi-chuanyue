import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { Game } from "../game";
import { saveBook } from "./library";
import { estimateNote, getNote, listNotes, newNote, noteBatches, noteMaterials, notesForTurn, runNote, saveNote } from "./notes";
import { newBinding, type SourceBook } from "./types";
import { sampleState } from "../testing/fixtures";

const longBook = (): SourceBook => ({ id: crypto.randomUUID(), title: "长河", format: "txt", createdAt: new Date().toISOString(), sections:
  Array.from({ length: 12 }, (_, i) => ({ title: `第${i + 1}章`, text: `${i % 3 === 0 ? "唐三在史莱克学院修炼。" : "小镇平静如常。"}${"风吹过山谷。".repeat(1100)}` })) });

async function setup() {
  const platform = await createMemoryPlatform();
  const game = await Game.open(platform, { slot: "t", url: "https://test.invalid/v1/chat/completions", model: "m", auxModel: "aux", includeUsage: true });
  const book = longBook();
  await saveBook(game.repo, book);
  return { game, repo: game.repo, book };
}

describe("原著札记 (D162)", () => {
  it("reads a chapter range in order and finds a person across the book", async () => {
    const { repo, book } = await setup();
    const range = await noteMaterials(repo, { bookId: book.id, kind: "plot", scope: { from: 2, to: 4 } });
    expect([...new Set(range.map((m) => m.section))]).toEqual([2, 3, 4]);
    const person = await noteMaterials(repo, { bookId: book.id, kind: "person", scope: { subject: "唐三" } });
    expect(person.length).toBeGreaterThan(0);
    expect(person.every((m) => m.text.includes("唐三"))).toBe(true);
    expect(person.map((m) => m.section)).toEqual([...person.map((m) => m.section)].sort((a, b) => a - b));
    expect(await noteMaterials(repo, { bookId: book.id, kind: "person", scope: { subject: "没有这人" } })).toEqual([]);
  });

  it("batches material without splitting a piece and estimates the merge", async () => {
    const pieces = [5000, 5000, 5000, 9000].map((n, i) => ({ section: i, title: "", text: "字".repeat(n), digest: false }));
    expect(noteBatches(pieces, 16_000).map((b) => b.length)).toEqual([3, 1]);
    const { repo, book } = await setup();
    const estimate = await estimateNote(repo, { bookId: book.id, kind: "plot", scope: { from: 0, to: 11 } });
    expect(estimate.requests).toBeGreaterThan(1);
    expect(estimate.chars).toBeGreaterThan(70_000);
  });

  it("keeps finished parts across a pause and merges them at the end", async () => {
    const { repo, book } = await setup();
    const note = newNote(book.id, "plot", { from: 0, to: 11 }, "主线");
    await saveNote(repo, note);
    const calls: string[] = [];
    const pause = new AbortController();
    const runner = { model: "aux", call: async (messages: { content: string }[], signal: AbortSignal) => {
      calls.push(messages[0].content);
      if (calls.length === 2) pause.abort();
      if (signal.aborted && calls.length > 2) throw new Error("stopped");
      return messages[0].content.includes("合并") ? "合并后的主线（第1章）" : `第${calls.length}段摘要`;
    } };
    const paused = await runNote(repo, note, book.title, runner, pause.signal, () => {});
    expect(paused.status).toBe("paused");
    expect(paused.progress.parts).toEqual(["第1段摘要", "第2段摘要"]);
    const done = await runNote(repo, (await getNote(repo, note.id))!, book.title, runner, new AbortController().signal, () => {});
    expect(done.status).toBe("done");
    expect(done.content).toBe("合并后的主线（第1章）");
    expect(calls.filter((c) => !c.includes("合并")).length).toBe(paused.progress.total - 1);
  });

  it("gives a passage the plot around the reading position and the people in play", async () => {
    const { repo, book } = await setup();
    const world = async () => (await repo.createWorld({ title: "试", eraId: "free", settings: { premise: "" }, opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState(), meta: {} } })).world.id;
    const [here, other] = [await world(), await world()];
    const done = (n: ReturnType<typeof newNote>, content: string) => ({ ...n, content, status: "done" as const });
    await saveNote(repo, done(newNote(book.id, "plot", { from: 0, to: 4 }, "前段主线"), "前段"));
    await saveNote(repo, done(newNote(book.id, "plot", { from: 5, to: 11 }, "后段主线"), "后段"));
    await saveNote(repo, done(newNote(book.id, "person", { subject: "唐三", aliases: ["三哥"] }, "人物：唐三"), "唐门弟子"));
    await saveNote(repo, { ...done(newNote(book.id, "person", { subject: "小舞" }, "人物：小舞"), "柔骨兔"), active: false });
    await saveNote(repo, done(newNote(book.id, "question", { question: "别的故事的问题" }, "别处", other), "不该出现"));
    const binding = { ...newBinding(book.id, true), position: 6 };
    const notes = await notesForTurn(repo, binding, here, "三哥推门进来，小舞跟在后面。");
    expect(notes.map((n) => n.title)).toEqual(["后段主线", "人物：唐三"]);
    expect((await listNotes(repo, book.id, here)).some((n) => n.title === "别处")).toBe(false);
  });
});
