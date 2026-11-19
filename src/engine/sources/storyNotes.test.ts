// 本局札记 (D174), 续整理 / 更新到现在, 恢复上一版 and 带到下一局 (D177).
import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { Game } from "../game";
import { sampleState } from "../testing/fixtures";
import * as tree from "../tree";
import { exportWorld, importWorld } from "../archive";
import { carryNotes, getNote, listStoryNotes, newStoryNote, noteOffRoute, notesForTurn, restorePrevious, routeIds, saveNote, startNoteUpdate, storyLastTurn } from "./notes";

const LLM = { slot: "t", url: "https://main.invalid/v1/chat/completions", model: "m", auxModel: "aux", includeUsage: true };

async function story() {
  const platform = await createMemoryPlatform();
  const game = await Game.open(platform, LLM);
  const repo = game.repo;
  const { world } = await repo.createWorld({ title: "长安", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: "开场：主角醒在长安城外。", state: sampleState() } });
  let c = await tree.cursor(repo, world.id);
  const add = async (text: string) => { c = await tree.append(repo, c, { kind: "turn", actionMode: "do", actionText: `做${text}`, narrative: text, state: sampleState() }); return c.head; };
  const one = await add("第一段：进城。");
  const two = await add("第二段：在酒肆遇见王掌柜，他是舅舅。");
  await add("第三段：夜里出城。");
  await repo.addChapter({ worldId: world.id, firstNodeId: one.id, lastNodeId: two.id, title: "第一章", gist: "进城", summary: "第一章摘要：进城，认了舅舅。", model: "aux", promptVersion: "chapter-1" });
  const calls: { url: string; text: string }[] = [];
  let reply = (text: string) => (text.includes("已有札记") ? "合并后的主线：进城、认舅、出城、上山。" : "本局主线：进城、认舅、出城。");
  const refuse = { when: (_url: string, _text: string) => false };
  platform.llm.stream = async (request, onEvent) => {
    const text = (request.body as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");
    calls.push({ url: request.url, text });
    const refused = refuse.when(request.url, text);
    onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: refused ? "" : reply(text) }, finish_reason: refused ? "content_filter" : "stop" }] }) });
    onEvent({ type: "done" });
    return "test-stream";
  };
  return { platform, game, repo, worldId: world.id, add, calls, refuse, setReply: (f: typeof reply) => { reply = f; } };
}

describe("本局札记 (D174)", () => {
  it("builds the main plot from chapter summaries and the turns they do not cover", async () => {
    const { game, repo, worldId, calls } = await story();
    const note = newStoryNote(worldId, "plot", {}, "主线梗概");
    await saveNote(repo, note);
    const done = await game.runCanonNote(note.id, () => {});
    expect(done.status).toBe("done");
    expect(done.content).toBe("本局主线：进城、认舅、出城。");
    expect(done.scope.to).toBe(await storyLastTurn(repo, worldId));
    expect(calls).toHaveLength(1);
    const sent = calls[0].text;
    expect(sent).toContain("第一章摘要");
    expect(sent).toContain("开场：主角醒在长安城外");
    expect(sent).toContain("第三段：夜里出城");
    // Turns the chapter summary already covers are not sent again.
    expect(sent).not.toContain("第一段：进城。");
    expect(sent).not.toContain("在酒肆遇见");
  });

  it("a person note reads only the turns that mention them", async () => {
    const { game, repo, worldId, calls } = await story();
    const note = newStoryNote(worldId, "person", { subject: "王掌柜", aliases: ["舅舅"] }, "人物：王掌柜");
    await saveNote(repo, note);
    expect((await game.runCanonNote(note.id, () => {})).status).toBe("done");
    expect(calls[0].text).toContain("在酒肆遇见王掌柜");
    expect(calls[0].text).not.toContain("夜里出城");
  });

  it("更新到现在 reads only the new turns, keeps the old note as 上一版, and 恢复上一版 swaps back", async () => {
    const { game, repo, worldId, add, calls } = await story();
    const note = newStoryNote(worldId, "plot", {}, "主线梗概");
    await saveNote(repo, note);
    const first = await game.runCanonNote(note.id, () => {});
    await add("第四段：上山拜师。");
    const last = await storyLastTurn(repo, worldId);
    expect(() => startNoteUpdate(first, first.scope.to!)).toThrow("已经整理到最新");
    await saveNote(repo, startNoteUpdate(first, last), true);
    const before = calls.length;
    const updated = await game.runCanonNote(note.id, () => {});
    const sent = calls.slice(before);
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain("第四段：上山拜师");
    expect(sent[0].text).not.toContain("夜里出城");
    // The merge keeps the existing note as the lead.
    expect(sent[1].text).toContain("本局主线：进城、认舅、出城。");
    expect(updated).toMatchObject({ status: "done", content: "合并后的主线：进城、认舅、出城、上山。", previousContent: "本局主线：进城、认舅、出城。" });
    expect(updated.scope.to).toBe(last);
    const restored = await restorePrevious(repo, note.id);
    expect(restored?.content).toBe("本局主线：进城、认舅、出城。");
    expect((await getNote(repo, note.id))?.previousContent).toBe("合并后的主线：进城、认舅、出城、上山。");
  });

  it("goes into writing: the main plot always, people when named, ahead of book notes", async () => {
    const { game, repo, worldId } = await story();
    const plot = newStoryNote(worldId, "plot", {}, "主线梗概");
    const person = newStoryNote(worldId, "person", { subject: "王掌柜" }, "人物：王掌柜");
    await saveNote(repo, plot);
    await saveNote(repo, person);
    await game.runCanonNote(plot.id, () => {});
    await game.runCanonNote(person.id, () => {});
    expect((await notesForTurn(repo, null, worldId, "夜色很深")).map((n) => [n.title, n.source])).toEqual([["主线梗概", "story"]]);
    expect((await notesForTurn(repo, null, worldId, "王掌柜推门进来")).map((n) => n.title)).toEqual(["主线梗概", "人物：王掌柜"]);
  });

  it("a passage the service blocks goes to the backup service before it becomes a gap", async () => {
    const { game, repo, worldId, calls, refuse } = await story();
    game.fallbackLlm = { ...LLM, slot: "b", url: "https://backup.invalid/v1/chat/completions", model: "backup" };
    refuse.when = (url) => url.startsWith("https://main.invalid");
    const note = newStoryNote(worldId, "plot", {}, "主线梗概");
    await saveNote(repo, note);
    const done = await game.runCanonNote(note.id, () => {});
    expect(done.status).toBe("done");
    expect(done.progress.gaps ?? []).toEqual([]);
    expect(calls.some((c) => c.url.startsWith("https://backup.invalid"))).toBe(true);
  });
});

describe("本局札记与路线", () => {
  it("anchors a reply to the passages read before the player switched routes", async () => {
    const { game, repo, worldId, platform } = await story();
    const original = await tree.cursor(repo, worldId);
    const note = newStoryNote(worldId, "plot", {}, "本局主线");
    await saveNote(repo, note);

    let ready!: () => void, finish!: () => void;
    const hasRequest = new Promise<void>((resolve) => { ready = resolve; });
    const mayFinish = new Promise<void>((resolve) => { finish = resolve; });
    platform.llm.stream = async (_request, emit) => {
      ready();
      await mayFinish;
      emit({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: "主角出城" }, finish_reason: "stop" }] }) });
      emit({ type: "done" });
      return "test-stream";
    };

    const work = game.runCanonNote(note.id, () => {});
    await hasRequest;
    try {
      const undone = await tree.undo(repo, original);
      await tree.append(repo, undone, { kind: "turn", narrative: "留在城里。", state: sampleState() });
    } finally {
      finish();
    }
    expect((await work).scope.toNode).toBe(original.head.id);
    expect(noteOffRoute((await getNote(repo, note.id))!, await routeIds(repo, worldId))).toBe(true);
    expect(await notesForTurn(repo, null, worldId, "")).toEqual([]);
  });

  it("a note made on a route the player left is kept out of writing, and import keeps it on its route", async () => {
    const { game, repo, worldId } = await story();
    const note = newStoryNote(worldId, "plot", {}, "主线梗概");
    await saveNote(repo, note);
    const done = await game.runCanonNote(note.id, () => {});
    expect(done.scope.toNode).toBe((await tree.cursor(repo, worldId)).head.id);
    expect((await notesForTurn(repo, null, worldId, "")).map((n) => n.title)).toEqual(["主线梗概"]);
    // Imported under new ids, the note still points at its passage.
    const copy = await importWorld(repo, await exportWorld(repo, worldId), "new");
    const [copied] = await listStoryNotes(repo, copy);
    expect(noteOffRoute(copied, await routeIds(repo, copy))).toBe(false);
    // The player goes back one passage: the note describes a passage that is no longer there.
    await tree.undo(repo, await tree.cursor(repo, worldId));
    expect(noteOffRoute((await getNote(repo, note.id))!, await routeIds(repo, worldId))).toBe(true);
    expect(await notesForTurn(repo, null, worldId, "")).toEqual([]);
  });
});

describe("带到下一局 (D177)", () => {
  it("copies finished notes as background from the earlier story; they are hand-edited only", async () => {
    const { game, repo, worldId } = await story();
    const person = newStoryNote(worldId, "person", { subject: "王掌柜" }, "人物：王掌柜");
    const unfinished = newStoryNote(worldId, "setting", { subject: "酒肆" }, "酒肆");
    await saveNote(repo, person);
    await saveNote(repo, unfinished);
    await game.runCanonNote(person.id, () => {});
    const { world: next } = await repo.createWorld({ title: "洛阳", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: "新的开场", state: sampleState() } });
    expect(await carryNotes(repo, [person.id, unfinished.id], next.id, { worldId, title: "长安" })).toBe(1);
    const [carried] = await listStoryNotes(repo, next.id);
    expect(carried).toMatchObject({ title: "人物：王掌柜", originWorldId: worldId, originTitle: "长安", status: "done", source: "story" });
    expect(carried.id).not.toBe(person.id);
    expect((await notesForTurn(repo, null, next.id, "王掌柜也来了洛阳")).map((n) => n.title)).toEqual(["人物：王掌柜（前作《长安》）"]);
    await expect(game.runCanonNote(carried.id, () => {})).rejects.toThrow("来自前作");
    // The earlier story keeps its own copy.
    expect((await getNote(repo, person.id))?.worldId).toBe(worldId);
  });
});
