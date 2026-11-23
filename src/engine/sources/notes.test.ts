import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { Game } from "../game";
import { saveBook } from "./library";
import { askedAbout, deleteNote, draftFromParts, estimateNote, gapRanges, getNote, listNotes, newLocalNote, newNote, noteBatches, noteMaterials, noteProgressDetail, noteProgressLabel, noteReplyProblem, noteStepsDone, notesForTurn, readNoteText, renameNote, restorePrevious, runNote, saveNote, startNoteUpdate } from "./notes";
import { archiveProblems, exportWorld, importWorld } from "../archive";
import { newBinding, type SourceBook } from "./types";
import { sampleState } from "../testing/fixtures";

const longBook = (): SourceBook => ({ id: crypto.randomUUID(), title: "长河", format: "txt", createdAt: new Date().toISOString(), sections:
  Array.from({ length: 12 }, (_, i) => ({ title: `第${i + 1}章`, text: `${i % 3 === 0 ? "沈青在青云书院修炼。" : "小镇平静如常。"}${"风吹过山谷。".repeat(1100)}` })) });

async function setup() {
  const platform = await createMemoryPlatform();
  const game = await Game.open(platform, { slot: "t", url: "https://test.invalid/v1/chat/completions", model: "m", auxModel: "aux", includeUsage: true });
  const book = longBook();
  await saveBook(game.repo, book);
  return { game, repo: game.repo, book };
}

describe("原著札记 (D162)", () => {
  it("saves the previous text on both insert and update of a book note", async () => {
    const { repo, book } = await setup();
    const note = { ...newNote(book.id, "plot", { from: 0, to: 2 }, "原著主线"), previousContent: "第一份旧稿" };
    await saveNote(repo, note, false);
    expect((await getNote(repo, note.id))?.previousContent).toBe("第一份旧稿");
    await saveNote(repo, { ...note, previousContent: "第二份旧稿" }, false);
    expect((await getNote(repo, note.id))?.previousContent).toBe("第二份旧稿");
  });
  it("says how far the note has read in chapters, keeping batch counts for the developer view (R30 review #3)", async () => {
    const { repo, book } = await setup();
    const note = newNote(book.id, "plot", { from: 0, to: 11 }, "原标题");
    const progress = { parts: Array.from({ length: 39 }, (_, i) => i === 19 ? "" : "已有段落"), total: 53,
      batchSizes: Array(39).fill(1), gaps: [{ batch: 19, sections: [5, 6] }] };
    expect(noteStepsDone(progress)).toBe(38);
    expect(noteProgressLabel(progress)).toBe("已完成 72% · 1 处没整理成");
    expect(noteProgressDetail(progress)).toBe("分段 38/39 · 汇总 0/14 · 缺口 1");
    const keys = Array.from({ length: 39 }, (_, i) => `${i}:${i}`);
    expect(noteProgressLabel({ ...progress, materialKeys: keys, parts: progress.parts.slice(0, 20) })).toBe("已整理到第 20 章，共到第 39 章 · 1 处没整理成");
    expect(noteProgressLabel({ ...progress, materialKeys: keys })).toBe("正在合并成一份札记 · 1 处没整理成");
    expect(gapRanges([{ batch: 4, sections: [9] }, { batch: 2, sections: [5] }, { batch: 3, sections: [6, 7] }])).toEqual([{ batches: [2, 3, 4], sections: [5, 6, 7, 9] }]);
    await saveNote(repo, { ...note, progress });
    await renameNote(repo, note.id, "新标题");
    const draft = draftFromParts({ ...note, progress });
    expect(draft).toContain("第 6～7 章待补");
    const copy = newLocalNote(newNote(book.id, "plot", note.scope, "另存"), draft, 12);
    await saveNote(repo, copy);
    await saveNote(repo, { ...note, progress, status: "failed" }, true);
    expect(await getNote(repo, note.id)).toMatchObject({ title: "新标题", status: "failed", progress });
    expect(await getNote(repo, copy.id)).toMatchObject({ status: "done", content: draft, model: "" });
  });

  it("imports a copied sheet as an editable, lengthy note and reads the nearby chapter within scope", async () => {
    const { repo, book } = await setup();
    const paragraphs = Array.from({ length: 12 }, (_, i) => `第${i + 1}章。${"示例内容。".repeat(370)}${i === 11 ? "找到后段铜钥匙。" : ""}`);
    const raw = ["主线：第 1～12 章", "主线剧情 AI 整理，可能有误，可以直接改。", "第 5～6 章待补", "查看已整理的内容", ...paragraphs].join("\n\n");
    const imported = readNoteText(raw);
    expect(imported).toMatchObject({ title: "主线：第 1～12 章", from: 0, to: 11 });
    expect(imported.content).not.toContain("查看已整理的内容");
    expect(readNoteText("\uFEFF普通札记\n\n原格式").content).toBe("普通札记\n\n原格式");
    const { world } = await repo.createWorld({ title: "导入札记", eraId: "free", opening: {
      parentId: null, kind: "opening", narrative: "开场", state: { ...sampleState(), source: newBinding(book.id) },
    } });
    const note = newLocalNote(newNote(book.id, "plot", { from: 0, to: 11 }, imported.title!), imported.content, 12);
    await saveNote(repo, note);
    expect((await getNote(repo, note.id))?.content).toBe(imported.content);
    const binding = { ...newBinding(book.id), position: 11 };
    expect(await notesForTurn(repo, { ...binding, through: 10 }, world.id, "铜钥匙")).toEqual([]);
    const [read] = await notesForTurn(repo, binding, world.id, "铜钥匙");
    expect(read.content).toContain("第12章");
    expect(read.content).toContain("第 5～6 章待补");
    expect(read.content.length).toBeLessThanOrEqual(2400);
    const archive = await exportWorld(repo, world.id);
    const copied = await importWorld(repo, archive, "new");
    expect((await exportWorld(repo, copied)).books![0].notes![0].content).toBe(imported.content);
  });

  it("separates a probable refusal from a quoted reply containing a chapter or turn range", () => {
    expect(noteReplyProblem({ text: "抱歉，我无法整理这段资料。", finishReason: "stop" })?.kind).toBe("suspected_refusal");
    expect(noteReplyProblem({ text: "抱歉，我无法回答是人物的原话。由此引出后面的误会。（第202～207章）", finishReason: "stop" })).toBeNull();
    expect(noteReplyProblem({ text: "抱歉，我无法回答是掌柜的原话。由此引出后面的误会。（第12回合）", finishReason: "stop" })).toBeNull();
  });

  it("keeps the current and previous coverage of a book note through a failed update and an archive round trip", async () => {
    const { repo, book } = await setup();
    const { world } = await repo.createWorld({ title: "札记续整理", eraId: "free", opening: {
      parentId: null, kind: "opening", narrative: "开场", state: { ...sampleState(), source: newBinding(book.id) },
    } });
    const first: ReturnType<typeof newNote> = { ...newNote(book.id, "plot", { from: 0, to: 0 }, "旧版范围", world.id), status: "done", content: "第一章见到船工。", refs: [0] };
    await saveNote(repo, first);
    const update = startNoteUpdate(first, 1);
    const signal = new AbortController().signal;
    const stopped = await runNote(repo, update, book.title, { model: "test", call: async () => { throw new Error("fixture interruption"); } }, signal, () => {});
    expect(stopped).toMatchObject({ status: "failed", refs: [0] });
    const done = await runNote(repo, stopped, book.title, { model: "test", call: async () => "船工在第二章启程。" }, signal, () => {});
    expect(done).toMatchObject({ status: "done", refs: [0, 1], previousContent: first.content, scope: { to: 1, previous: { to: 0, refs: [0] } } });

    const imported = await importWorld(repo, await exportWorld(repo, world.id), "new");
    const [copy] = (await exportWorld(repo, imported)).books![0].notes!.filter((note) => note.worldId === imported);
    expect(await restorePrevious(repo, copy.id)).toMatchObject({ content: first.content, scope: { to: 0 }, refs: [0] });
  });

  it("splits a saved multi-chapter gap without sending its completed neighbours again", async () => {
    const { repo } = await setup();
    const book: SourceBook = {
      id: crypto.randomUUID(), title: "渡口", format: "txt", createdAt: new Date().toISOString(),
      sections: ["旧开场", "渡船到了", "服务拒绝这一章", "同伴回城", "旧结尾"].map(
        (text, i) => ({ title: `第${i + 1}章`, text }),
      ),
    };
    await saveBook(repo, book);
    const note = newNote(book.id, "plot", { from: 0, to: 4 }, "主线");
    note.progress = {
      parts: ["已整理开场", "", "已整理结尾"], batchSizes: [1, 3, 1], total: 4,
      gaps: [{ batch: 1, sections: [1, 2, 3], reason: "blocked" }],
    };
    await saveNote(repo, note);
    const sent: string[] = [];
    const done = await runNote(repo, note, book.title, { model: "mock", call: async (messages) => {
      const content = messages.map((message) => message.content).join("\n");
      sent.push(content);
      if (content.includes("服务拒绝这一章")) throw noteReplyProblem({ text: "", finishReason: "content_filter" })!;
      if (content.includes("渡船到了")) return "已整理渡船";
      if (content.includes("同伴回城") && !content.includes("已整理同伴回城")) return "已整理同伴回城";
      return ["已整理开场", "已整理渡船", "已整理同伴回城", "已整理结尾"].join("。");
    } }, new AbortController().signal, () => {});
    expect(done.status).toBe("done");
    expect(done.progress.gaps).toEqual([{ batch: 2, sections: [2], reason: "blocked" }]);
    expect(done.content).toContain("已整理渡船。已整理同伴回城");
    expect(sent.every((call) => !call.includes("旧开场") && !call.includes("旧结尾"))).toBe(true);
  });

  it("reads a chapter range in order and finds a person across the book", async () => {
    const { repo, book } = await setup();
    const range = await noteMaterials(repo, { bookId: book.id, kind: "plot", scope: { from: 2, to: 4 } });
    expect([...new Set(range.map((m) => m.section))]).toEqual([2, 3, 4]);
    const person = await noteMaterials(repo, { bookId: book.id, kind: "person", scope: { subject: "沈青" } });
    expect(person.length).toBeGreaterThan(0);
    expect(person.every((m) => m.text.includes("沈青"))).toBe(true);
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
    expect(paused.progress.parts).toEqual(["第1段摘要"]);
    const done = await runNote(repo, (await getNote(repo, note.id))!, book.title, runner, new AbortController().signal, () => {});
    expect(done.status).toBe("done");
    expect(done.content).toBe("合并后的主线（第1章）");
    expect(calls.filter((c) => !c.includes("合并")).length).toBe(paused.progress.batchSizes!.length + 1);
  });

  it("rescues a long range at the failed batch without redoing its previous chapters", async () => {
    const { game, repo } = await setup();
    const book: SourceBook = {
      ...longBook(),
      sections: Array.from({ length: 300 }, (_, i) => ({ title: `标记${i + 1}`, text: "风起，船离开码头。".repeat(170) })),
    };
    await saveBook(repo, book);
    const note = newNote(book.id, "plot", { from: 100, to: 299 }, "第101～300章");
    const materials = await noteMaterials(repo, note);
    const first = noteBatches(materials)[0];
    // A checkpoint written by 0.16.0, before the work plan was persisted.
    await saveNote(repo, { ...note, status: "failed", progress: { parts: ["既有摘要"], total: 23, error: "模型没有返回可用的札记" } });
    const writes: string[] = [];
    const chapter = /\[第(\d+)章/g;
    game.platform.llm.stream = async (request, onEvent) => {
      const body = request.body as { max_tokens: number; messages: { content: string }[] };
      expect(body.max_tokens).toBe(8192);
      const messages = body.messages;
      const original = messages[1].content.startsWith("【原著材料】");
      if (original) writes.push(messages[1].content);
      const failed = original && writes.length === 1;
      onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: failed ? "没写完" : "整理的事实（第101章）" }, finish_reason: failed ? "length" : "stop" }] }) });
      onEvent({ type: "done" });
      return "test-stream";
    };
    const done = await game.runCanonNote(note.id, () => {});
    expect(done.status).toBe("done");
    const sent = writes.map((text) => [...text.matchAll(chapter)].map((m) => Number(m[1])));
    expect(sent[1].length).toBeLessThan(sent[0].length);
    const actuallyWritten = sent.slice(1).flat();
    expect(actuallyWritten).toEqual(materials.slice(first.length).map((m) => m.section + 1));
  });

  it("recovers a completed merge after a later merge failed, without reading the source again", async () => {
    const { repo, book } = await setup();
    const note = newNote(book.id, "plot", { from: 0, to: 11 }, "长札记");
    await saveNote(repo, note);
    let mergeCalls = 0;
    const failed = await runNote(repo, note, book.title, { model: "aux", call: async (messages) => {
      if (!messages[0].content.includes("合并")) return "局部摘要";
      if (++mergeCalls === 2) throw new Error("模型连接已经断开");
      return "第一组合并结果";
    } }, new AbortController().signal, () => {});
    expect(failed.status).toBe("failed");
    expect(failed.progress.merges).toEqual([["第一组合并结果"]]);
    expect(noteStepsDone(failed.progress)).toBe(failed.progress.parts.length + 1);
    expect(failed.progress.detail).toContain("第 2 组");
    const calls: string[] = [];
    const done = await runNote(repo, (await getNote(repo, note.id))!, book.title, { model: "aux", call: async (messages) => {
      expect(messages[0].content).toContain("合并");
      calls.push(messages[1].content);
      return calls.length === 1 ? "第二组合并结果" : "完整札记";
    } }, new AbortController().signal, () => {});
    expect(done.content).toBe("完整札记");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("第一组合并结果");
  });

  it("asks again in neutral words after a refusal, and accepts legitimate English prose", async () => {
    const { game, repo, book } = await setup();
    const note = newNote(book.id, "plot", { from: 0, to: 0 }, "短札记");
    await saveNote(repo, note);
    const prompts: string[] = [];
    game.platform.llm.stream = async (request, onEvent) => {
      const content = (request.body as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
      prompts.push(content);
      const refused = !content.includes("客观概括");
      onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: refused ? "" : "The traveler leaves the small town at sunrise." }, finish_reason: refused ? "content_filter" : "stop" }] }) });
      onEvent({ type: "done" });
      return "test-stream";
    };
    const done = await game.runCanonNote(note.id, () => {});
    expect(done.status).toBe("done");
    expect(done.content).toContain("The traveler");
    expect(done.progress.gaps ?? []).toEqual([]);
    expect(prompts.some((p) => p.includes("客观概括"))).toBe(true);
  });

  it("a service that refuses everything fails with one clear sentence, and works once it relents", async () => {
    const { game, repo, book } = await setup();
    const note = newNote(book.id, "plot", { from: 0, to: 0 }, "短札记");
    await saveNote(repo, note);
    let refuse = true;
    let calls = 0;
    game.platform.llm.stream = async (_request, onEvent) => {
      calls++;
      onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: refuse ? "" : "旅人清晨离开小镇。" }, finish_reason: refuse ? "content_filter" : "stop" }] }) });
      onEvent({ type: "done" });
      return "test-stream";
    };
    const failed = await game.runCanonNote(note.id, () => {});
    expect(failed.status).toBe("failed");
    expect(failed.progress.error).toContain("一直不肯处理");
    expect(calls).toBeLessThan(20);
    refuse = false;
    const done = await game.runCanonNote(note.id, () => {});
    expect(done.status).toBe("done");
    expect(done.content).toContain("旅人清晨离开小镇");
    expect(done.content).not.toContain("未能整理");
  });

  it("a persistently refused 202–207 does not stop the note: it is named, used for writing, kept in exports, and can be retried or filled", async () => {
    const { game, repo } = await setup();
    const book: SourceBook = {
      ...longBook(),
      sections: Array.from({ length: 300 }, (_, i) => ({ title: `章节${i + 1}`, text: `第${i + 1}章里风吹过山谷。` })),
    };
    await saveBook(repo, book);
    const note = newNote(book.id, "plot", { from: 100, to: 299 }, "第101～300章");
    await saveNote(repo, note);
    const blocked = (content: string) => [202, 203, 204, 205, 206, 207].some((n) => content.includes(`[第${n}章`));
    let refuse = true;
    const calls: string[] = [];
    game.platform.llm.stream = async (request, onEvent) => {
      const content = (request.body as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
      calls.push(content);
      const refused = refuse && blocked(content);
      onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: refused ? "" : "后续或合并札记" }, finish_reason: refused ? "content_filter" : "stop" }] }) });
      onEvent({ type: "done" });
      return "test-stream";
    };
    const done = await game.runCanonNote(note.id, () => {});
    expect(done.status).toBe("done");
    expect(gapRanges(done.progress.gaps ?? []).map((r) => r.sections)).toEqual([[201, 202, 203, 204, 205, 206]]);
    expect(done.content).toContain("第 202～207 章有部分内容未能整理");
    // The chapters around it were still read.
    expect(calls.some((c) => c.includes("[第201章") && !blocked(c))).toBe(true);
    expect(calls.some((c) => c.includes("[第208章") && !blocked(c))).toBe(true);
    // Gaps no longer keep the note out of writing (R30 review #2).
    expect((await notesForTurn(repo, { ...newBinding(book.id, true), position: 210 }, "world", "")).map((n) => n.title)).toContain("第101～300章");

    const { world } = await repo.createWorld({ title: "札记归档", eraId: "free", opening: {
      parentId: null, kind: "opening", narrative: "起航", state: { ...sampleState(), source: newBinding(book.id, true) },
    } });
    const archive = await exportWorld(repo, world.id);
    expect(archiveProblems(archive)).toEqual([]);
    const copy = await importWorld(repo, archive, "new");
    const copiedLine = await repo.getLine((await repo.getWorld(copy))!.currentLineId!);
    const copiedBook = (await repo.getState(copiedLine!.nodeId)).source!.bookId;
    const [copiedNote] = await listNotes(repo, copiedBook);
    expect(copiedNote.progress.gaps).toEqual(done.progress.gaps);
    expect(copiedNote.status).toBe("done");

    // 再试 once the service relents: only the gaps are sent, then one merge.
    refuse = false;
    const before = calls.length;
    const reopened = await Game.open(game.platform, game.llm);
    const retried = await reopened.runCanonNote(note.id, () => {});
    expect(retried.status).toBe("done");
    expect(retried.progress.gaps ?? []).toEqual([]);
    expect(retried.content).not.toContain("未能整理");
    const sent = calls.slice(before);
    expect(sent.filter((c) => c.includes("[第208章"))).toHaveLength(0);
    expect(sent.every((c) => blocked(c) || c.includes("后续或合并札记"))).toBe(true);
  });

  it("one manual note covers a run of adjacent gaps", async () => {
    const { game, repo } = await setup();
    const book: SourceBook = { ...longBook(), sections: Array.from({ length: 10 }, (_, i) => ({ title: `章节${i + 1}`, text: `第${i + 1}章的事。` })) };
    await saveBook(repo, book);
    const note = newNote(book.id, "plot", { from: 0, to: 9 }, "十章");
    await saveNote(repo, note);
    const calls: string[] = [];
    game.platform.llm.stream = async (request, onEvent) => {
      const content = (request.body as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
      calls.push(content);
      const refused = ["[第4章", "[第5章"].some((t) => content.includes(t));
      onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: refused ? "" : "札记段落" }, finish_reason: refused ? "content_filter" : "stop" }] }) });
      onEvent({ type: "done" });
      return "test-stream";
    };
    const first = await game.runCanonNote(note.id, () => {});
    const [range] = gapRanges(first.progress.gaps ?? []);
    expect(range.sections).toEqual([3, 4]);
    const filled = await game.runCanonNote(note.id, () => {}, { kind: "fill", batch: range.batches[0], also: range.batches.slice(1), text: "手动补上：第4～5章主角离乡。" });
    expect(filled.status).toBe("done");
    expect(filled.progress.gaps ?? []).toEqual([]);
    expect(calls.at(-1)).toContain("手动补上：第4～5章主角离乡。");
  });

  it("gives a passage the plot around the reading position and the people in play", async () => {
    const { repo, book } = await setup();
    const world = async () => (await repo.createWorld({ title: "试", eraId: "free", settings: { premise: "" }, opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState(), meta: {} } })).world.id;
    const [here, other] = [await world(), await world()];
    const done = (n: ReturnType<typeof newNote>, content: string) => ({ ...n, content, status: "done" as const });
    await saveNote(repo, done(newNote(book.id, "plot", { from: 0, to: 4 }, "前段主线"), "前段"));
    await saveNote(repo, done(newNote(book.id, "plot", { from: 5, to: 11 }, "后段主线"), "后段"));
    await saveNote(repo, done(newNote(book.id, "person", { subject: "沈青", aliases: ["青哥"] }, "人物：沈青"), "沈家弟子"));
    await saveNote(repo, { ...done(newNote(book.id, "person", { subject: "阿柳" }, "人物：阿柳"), "白狐"), active: false });
    await saveNote(repo, done(newNote(book.id, "question", { question: "别的故事的问题" }, "别处", other), "不该出现"));
    const binding = { ...newBinding(book.id, true), position: 6 };
    const notes = await notesForTurn(repo, binding, here, "青哥推门进来，阿柳跟在后面。");
    expect(notes.map((n) => n.title)).toEqual(["后段主线", "人物：沈青"]);
    expect((await listNotes(repo, book.id, here)).some((n) => n.title === "别处")).toBe(false);
  });

  it("brings in an answer saved from 查一查 when the passage is about it, even under a reading limit", async () => {
    const { repo, book } = await setup();
    const { world } = await repo.createWorld({ title: "试", eraId: "free", settings: { premise: "" }, opening: { parentId: null, kind: "opening", narrative: "开场", state: sampleState(), meta: {} } });
    await saveNote(repo, { ...newNote(book.id, "question", { question: "王掌柜是什么来头？" }, "王掌柜是什么来头", world.id), content: "王掌柜原是镖局的账房。", status: "done" as const });
    const binding = { ...newBinding(book.id, true), position: 2, through: 5 };
    expect((await notesForTurn(repo, binding, world.id, "王掌柜把算盘一推，抬头看你。")).map((n) => n.title)).toEqual(["王掌柜是什么来头"]);
    expect(await notesForTurn(repo, binding, world.id, "雨下了一整夜。")).toEqual([]);
    expect(askedAbout("一斗米多少钱", "他买了一斗米")).toBe(true);
    expect(askedAbout("核对一下是什么", "这是什么东西")).toBe(false);
  });

  it("excludes mixed later chapters and notes with unknown scope from a limited story", async () => {
    const { repo, book } = await setup();
    const done = (n: ReturnType<typeof newNote>, refs: number[]) => ({ ...n, refs, status: "done" as const, content: n.title });
    await saveNote(repo, done(newNote(book.id,"plot",{from:0,to:11},"后文主线"),[0,11]));
    await saveNote(repo, done(newNote(book.id,"person",{subject:"沈青"},"后文身份"),[0,11]));
    await saveNote(repo, done(newNote(book.id,"person",{subject:"沈青"},"旧札记范围不明"),[]));
    await saveNote(repo, done(newNote(book.id,"person",{subject:"沈青"},"已知身份"),[0]));
    await saveNote(repo, done(newNote(book.id,"plot",{from:0,to:0},"当前主线"),[0]));
    const binding={...newBinding(book.id,true),through:0};
    expect((await notesForTurn(repo,binding,"","沈青")).map(n=>n.title)).toEqual(["当前主线","已知身份"]);
    expect((await notesForTurn(repo,{...binding,through:null},"","沈青")).length).toBe(5);
  });

  it("a request that never answers is freed by 暂停, and 接着整理 works afterwards (R30)", async () => {
    const { repo, book } = await setup();
    const note = newNote(book.id, "plot", { from: 0, to: 0 }, "挂起的札记");
    await saveNote(repo, note);
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const pending = runNote(repo, note, book.title, { model: "aux", call: () => { started(); return new Promise<string>(() => {}); } }, controller.signal, () => {});
    await ready;
    controller.abort();
    expect((await pending).status).toBe("paused");
    const done = await runNote(repo, (await getNote(repo, note.id))!, book.title, { model: "aux", call: async () => "第1章主线" }, new AbortController().signal, () => {});
    expect(done.status).toBe("done");
  });

  it("a failure is one sentence for the player, the cause kept apart (R30)", async () => {
    const { repo, book } = await setup();
    const note = newNote(book.id, "plot", { from: 0, to: 0 }, "失败的札记");
    await saveNote(repo, note);
    const failing = Object.assign(new Error("HTTP 500 upstream overloaded, see https://relay.invalid/status"), { kind: "http", status: 500 });
    const failed = await runNote(repo, note, book.title, { model: "aux", call: async () => { throw failing; } }, new AbortController().signal, () => {});
    expect(failed.status).toBe("failed");
    expect(failed.progress.error).toBe("服务暂时出了问题，稍后再试，或换一个服务。已完成的部分保留了，可以接着整理。");
    expect(failed.progress.detail).toContain("upstream overloaded");
    expect(failed.progress.detail).not.toContain("relay.invalid");
  });

  it.each(["reject","resolve"])("does not recreate a deleted note when cancellation later %ss", async (outcome) => {
    const {repo,book}=await setup();
    const note=newNote(book.id,"plot",{from:0,to:0},"删除中的札记");await saveNote(repo,note);
    let started!:()=>void, finish!:(value:string)=>void, fail!:(error:Error)=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    const controller=new AbortController();
    const pending=runNote(repo,note,book.title,{model:"mock",call:()=>new Promise<string>((resolve,reject)=>{finish=resolve;fail=reject;started();})},controller.signal,()=>{});
    await ready;controller.abort();await deleteNote(repo,note.id);
    expect(await getNote(repo,note.id)).toBeNull();
    if(outcome==="reject")fail(new Error("cancelled"));else finish("迟到结果");
    expect((await pending).status).toBe("paused");expect(await getNote(repo,note.id)).toBeNull();
  });

  it("can cancel before the note worker finishes its initial reads",async()=>{
    const {game,repo,book}=await setup();const note=newNote(book.id,"plot",{from:0,to:0},"马上删除");await saveNote(repo,note);
    const running=game.runCanonNote(note.id,()=>{});
    game.pauseCanonNote(note.id);
    const stopped=expect(running).rejects.toMatchObject({name:"AbortError"});
    await deleteNote(repo,note.id);await stopped;
    expect(await getNote(repo,note.id)).toBeNull();expect(game.canonNoteRunning(note.id)).toBe(false);
  });

  it("roundtrips shared and own notes without another story or automatic execution",async()=>{
    const {repo,book}=await setup();
    const create=async()=>(await repo.createWorld({title:"归档",eraId:"free",settings:{premise:""},opening:{parentId:null,kind:"opening",narrative:"开场",state:{...sampleState(),source:newBinding(book.id,true)},meta:{}}})).world.id;
    const here=await create(),other=await create();
    for(const [title,worldId,status] of [["共享",null,"done"],["本局",here,"running"],["别局",other,"done"]] as const){
      await saveNote(repo,{...newNote(book.id,"question",{question:title},title,worldId),content:title,status,refs:[0],progress:{parts:["已保存摘要"],total:2}});
    }
    const archive=await exportWorld(repo,here);expect(archiveProblems(archive)).toEqual([]);
    expect(archive.books![0].notes!.map(n=>[n.title,n.status])).toEqual([["共享","done"],["本局","paused"]]);
    const imported=await importWorld(repo,archive,"new"),copy=await exportWorld(repo,imported);
    expect(archiveProblems(copy)).toEqual([]);
    expect(copy.books![0].book.id).not.toBe(book.id);
    const notes=copy.books![0].notes!;
    expect(notes.map(n=>n.content)).toEqual(["共享","本局"]);
    expect(notes[1].worldId).toBe(imported);expect(notes[1].progress.parts).toEqual(["已保存摘要"]);
    expect(notes[0].id).not.toBe(archive.books![0].notes![0].id);
    const damaged=structuredClone(archive);damaged.books![0].notes![0].worldId=other;
    expect(archiveProblems(damaged)).toContain("原著札记损坏或不属于这个故事");
    const legacy=structuredClone(archive);delete legacy.books![0].notes;
    expect(archiveProblems(legacy)).toEqual([]);await expect(importWorld(repo,legacy,"new")).resolves.toBeTypeOf("string");
  });

  it("enforces scope.through on non-ranged book notes, supports Chinese numerals, 1-char names, and invalidates stale merges on gap split", async () => {
    const { repo } = await setup();
    const book: SourceBook = {
      id: crypto.randomUUID(), title: "武魂录", format: "txt", createdAt: new Date().toISOString(),
      sections: [
        { title: "第一章", text: "冬在史莱克外院报到，魂环显现。" },
        { title: "第二章", text: "第十二章剧透：冬其实是隐藏强者的女儿，剧透内容绝不能泄露。" },
      ],
    };
    await saveBook(repo, book);
    // scope.through caps person/setting/question material retrieval & allows 1-char name "冬".
    const materials = await noteMaterials(repo, { bookId: book.id, kind: "person", scope: { subject: "冬", through: 0 } });
    expect(materials.length).toBe(1);
    expect(materials[0].section).toBe(0);
    expect(materials[0].text).not.toContain("隐藏强者");

    // Short 1-bigram query ("魂环") matches question note via askedAbout.
    expect(askedAbout("魂环怎么吸收", "他正在吸收魂环")).toBe(true);

    // Chinese numeral chapter mention ("第十二章") is caught by notesForTurn truncation around current position.
    const bigNote = newLocalNote(
      newNote(book.id, "plot", { from: 0, to: 15 }, "长主线"),
      `${"前段日常铺垫。".repeat(300)}\n\n第十二章：主角在考核场上觉醒第二武魂。\n\n${"后段日常。".repeat(300)}`,
      16,
    );
    await saveNote(repo, bigNote);
    const [picked] = await notesForTurn(repo, { ...newBinding(book.id, true), position: 11 }, "", "考核");
    expect(picked.content).toContain("第十二章");

    // Gap split clears stale cached merges so newly rescued gap text appears in the final merge.
    const gapBook: SourceBook = {
      id: crypto.randomUUID(), title: "补缺测试", format: "txt", createdAt: new Date().toISOString(),
      sections: ["第一章", "第二章新发现", "第三章补回"].map((text, i) => ({ title: `第${i + 1}章`, text })),
    };
    await saveBook(repo, gapBook);
    const gapNote = newNote(gapBook.id, "plot", { from: 0, to: 2 }, "补缺主线");
    gapNote.progress = {
      parts: ["第一章旧摘要", ""],
      batchSizes: [1, 2],
      total: 3,
      gaps: [{ batch: 1, sections: [1, 2], reason: "blocked" }],
      merges: [["陈旧的合并缓存"]],
      mergeBasis: "stale-basis",
    };
    await saveNote(repo, gapNote);
    const done = await runNote(repo, gapNote, gapBook.title, {
      model: "mock",
      call: async (messages) => {
        const prompt = messages.map((m) => m.content).join("\n");
        if (prompt.includes("合并")) return `最终合并：${prompt.includes("新发现摘录") && prompt.includes("补回摘录") ? "完整" : "缺失"}`;
        // Reject combined 2-section batch to force gap split and stale merge cache invalidation.
        if (prompt.includes("第二章新发现") && prompt.includes("第三章补回")) {
          throw noteReplyProblem({ text: "", finishReason: "content_filter" })!;
        }
        if (prompt.includes("第二章新发现")) return "新发现摘录";
        return "补回摘录";
      },
    }, new AbortController().signal, () => {});
    expect(done.status).toBe("done");
    expect(done.content).toBe("最终合并：完整");
  });

  it("chunks oversized story passages, scales output budget on small windows, and preserves through on saveAnswerAsNote (B08, B12)", async () => {
    const { game, repo, book } = await setup();
    const { world } = await repo.createWorld({
      title: "超长单段",
      eraId: "free",
      opening: {
        parentId: null,
        kind: "opening",
        narrative: Array.from({ length: 6 }, (_, i) => `第${i + 1}段长文：${"星河浩瀚，飞舟穿云而行。".repeat(350)}`).join("\n\n"),
        state: sampleState(),
      },
    });
    const storyPieces = await noteMaterials(repo, { bookId: "", source: "story", worldId: world.id, kind: "plot", scope: { from: 0, to: 0 } });
    expect(storyPieces.length).toBeGreaterThan(1);
    expect(storyPieces.every((p) => p.text.length <= 16_000)).toBe(true);

    // Small contextWindowTokens scales max_tokens down instead of reserving fixed 8192 (B12)
    game.llm = { slot: "t", url: "https://test.invalid/v1/chat/completions", model: "m", auxModel: "aux", includeUsage: true, contextWindowTokens: 8192 };
    let seenMaxTokens = 0;
    const shortNote = newNote(book.id, "plot", { from: 0, to: 0 }, "小窗口测试");
    await saveNote(repo, shortNote);
    game.platform.llm.stream = async (req, onEvent) => {
      seenMaxTokens = (req.body as { max_tokens: number }).max_tokens;
      onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: "第一章要点（第1章）" }, finish_reason: "stop" }] }) });
      onEvent({ type: "done" });
      return "s";
    };
    await game.runCanonNote(shortNote.id, () => {});
    expect(seenMaxTokens).toBe(2048);

    // saveAnswerAsNote records scope.through and extracts chapter refs against full book section count (B08)
    const savedAns = await game.saveAnswerAsNote(world.id, book.id, "沈青在哪修炼？", "沈青在第1章进入青云书院修炼。", 3);
    expect(savedAns.scope.through).toBe(3);
    expect(savedAns.refs).toEqual([0]);
  });
});
