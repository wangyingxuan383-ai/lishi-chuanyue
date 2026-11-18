import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { Game } from "../game";
import { saveBook } from "./library";
import { deleteNote, estimateNote, getNote, listNotes, newNote, noteBatches, noteMaterials, noteStepsDone, notesForTurn, runNote, saveNote } from "./notes";
import { archiveProblems, exportWorld, importWorld } from "../archive";
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

  it("explains a service refusal without retrying it or rejecting legitimate English prose", async () => {
    const { game, repo, book } = await setup();
    const note = newNote(book.id, "plot", { from: 0, to: 0 }, "短札记");
    await saveNote(repo, note);
    let calls = 0;
    game.platform.llm.stream = async (_request, onEvent) => {
      const refused = ++calls === 1;
      onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: refused ? "" : "The traveler leaves the small town at sunrise." }, finish_reason: refused ? "content_filter" : "stop" }] }) });
      onEvent({ type: "done" });
      return "test-stream";
    };
    const failed = await game.runCanonNote(note.id, () => {});
    expect(failed.progress.error).toContain("AI 服务拒绝");
    expect(calls).toBe(1);
    expect((await game.runCanonNote(note.id, () => {})).status).toBe("done");
    expect(calls).toBe(2);
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

  it("excludes mixed later chapters and notes with unknown scope from a limited story", async () => {
    const { repo, book } = await setup();
    const done = (n: ReturnType<typeof newNote>, refs: number[]) => ({ ...n, refs, status: "done" as const, content: n.title });
    await saveNote(repo, done(newNote(book.id,"plot",{from:0,to:11},"后文主线"),[0,11]));
    await saveNote(repo, done(newNote(book.id,"person",{subject:"唐三"},"后文身份"),[0,11]));
    await saveNote(repo, done(newNote(book.id,"person",{subject:"唐三"},"旧札记范围不明"),[]));
    await saveNote(repo, done(newNote(book.id,"person",{subject:"唐三"},"已知身份"),[0]));
    await saveNote(repo, done(newNote(book.id,"plot",{from:0,to:0},"当前主线"),[0]));
    const binding={...newBinding(book.id,true),through:0};
    expect((await notesForTurn(repo,binding,"","唐三")).map(n=>n.title)).toEqual(["当前主线","已知身份"]);
    expect((await notesForTurn(repo,{...binding,through:null},"","唐三")).length).toBe(5);
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
});
