// 改后同步 and what follows a hand edit (D183): the edited text is what later
// passages follow — chapters covering it are marked, 本局札记 that read it are
// marked, a stored run that read the old text is not replayed, and “事实也一起改”
// keeps the player's text exactly while the record and earlier facts follow.
import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { PlatformError } from "../../platform";
import { Game, textGuard } from "../game";
import { sampleState } from "../testing/fixtures";
import * as tree from "../tree";
import { archiveProblems, exportWorld, importWorld } from "../archive";
import { getNote, listStoryNotes, newStoryNote, markNotesStale, notesForTurn, saveNote } from "../sources/notes";
import { abilityCardName, adoptPlayerRevision, adoptRewrite, MISSING_OPENING_SEED_SYNC, parseFactSync, type FactSyncRequest } from "./assist";

const LLM = { slot: "t", url: "https://main.invalid/v1/chat/completions", model: "m", auxModel: "aux", includeUsage: true };

async function story(tail = 0) {
  const platform = await createMemoryPlatform();
  const game = await Game.open(platform, LLM);
  const repo = game.repo;
  const opening = sampleState(100);
  opening.protagonist.name = "林舟";
  const { world } = await repo.createWorld({ title: "测试故事", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "开场：林舟醒在城外。", state: opening, meta: { openingSeed: opening } } });
  let c = await tree.cursor(repo, world.id);
  const add = async (text: string, record: object = {}) => {
    const s = sampleState(90); s.protagonist.name = "林舟";
    c = await tree.append(repo, c, { kind: "turn", actionMode: "do", actionText: `做${text.slice(0, 4)}`, narrative: text, state: s, record });
    return c.head;
  };
  const one = await add("你握着匕首进了城。", { time: "一刻", log: "带着匕首进城" });
  const two = await add("你在酒肆遇见王掌柜。");
  for (let i = 0; i < tail; i++) await add(`后续${i}。`);
  const sent: string[] = [];
  let body: object | string = "主线：进城、见王掌柜。";
  platform.llm.stream = async (request, onEvent) => {
    sent.push((request.body as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n"));
    const content = typeof body === "string" ? body : JSON.stringify(body);
    onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] }) });
    onEvent({ type: "done" });
    return "test-stream";
  };
  return { platform, game, repo, worldId: world.id, one, two, cursor: () => c, add, sent, reply: (b: object | string) => { body = b; } };
}

describe("改过正文后的章节摘要 (D183)", () => {
  it("an edit marks every chapter that covers the passage, on every route that shares it, and only those", async () => {
    const s = await story(1);
    const three = s.cursor().head;
    const main = await s.repo.addChapter({ worldId: s.worldId, firstNodeId: s.one.id, lastNodeId: s.two.id, title: "进城", gist: "进城见人", summary: "进城见人", model: "aux", promptVersion: "chapter-1" });
    const later = await s.repo.addChapter({ worldId: s.worldId, firstNodeId: three.id, lastNodeId: three.id, title: "后来", gist: "后来", summary: "后来", model: "aux", promptVersion: "chapter-1" });
    // Another route that shares the first passage.
    let side = await tree.goBackTo(s.repo, s.cursor(), s.one.id);
    side = await tree.append(s.repo, side, { kind: "turn", actionMode: "do", actionText: "出城", narrative: "你转身出了城。", state: sampleState() });
    const branch = await s.repo.addChapter({ worldId: s.worldId, firstNodeId: s.one.id, lastNodeId: side.head.id, title: "出城", gist: "出城", summary: "出城", model: "aux", promptVersion: "chapter-1" });

    await s.repo.updateNarrative(s.one.id, "你握着短剑进了城。");
    const stale = async (id: string) => (await s.repo.chaptersOnPath(s.worldId, id));
    expect((await stale(s.cursor().head.id)).map((c) => [c.title, !!c.stale])).toEqual([["进城", true], ["后来", false]]);
    expect((await stale(side.head.id)).find((c) => c.id === branch.id)?.stale).toBe(true);

    // Summarizing it again clears the mark; 恢复原文 marks it again.
    expect(await s.repo.updateChapter(main.id, { title: "进城", gist: "带短剑进城", summary: "带短剑进城" })).toBe(true);
    expect((await stale(s.cursor().head.id))[0].stale).toBeUndefined();
    await s.repo.restoreNarrative(s.one.id);
    expect((await stale(s.cursor().head.id))[0].stale).toBe(true);
    expect((await stale(s.cursor().head.id)).find((c) => c.id === later.id)?.stale).toBeUndefined();
  });

  it("润色后采用 marks the chapters in the same write, and not when the text changed underneath", async () => {
    const s = await story();
    await s.repo.addChapter({ worldId: s.worldId, firstNodeId: s.one.id, lastNodeId: s.two.id, title: "进城", gist: "进城", summary: "进城", model: "aux", promptVersion: "chapter-1" });
    const head = s.cursor().head;
    const anchor = { worldId: s.worldId, lineId: s.cursor().line.id, headId: head.id, nodeId: s.one.id, original: s.one.narrative };
    await s.repo.updateNarrative(s.one.id, "别处改过的。");
    await s.repo.updateChapter((await s.repo.chaptersOnPath(s.worldId, head.id))[0].id, { title: "进城", gist: "进城", summary: "进城" });
    await expect(adoptRewrite(s.game, anchor, "润色过的。")).rejects.toThrow();
    expect((await s.repo.chaptersOnPath(s.worldId, head.id))[0].stale).toBeUndefined();
    await adoptRewrite(s.game, { ...anchor, original: "别处改过的。" }, "润色过的。");
    expect((await s.repo.chaptersOnPath(s.worldId, head.id))[0].stale).toBe(true);
  });

  it("the mark goes out with the story and comes back; an older file without it still imports", async () => {
    const s = await story();
    await s.repo.addChapter({ worldId: s.worldId, firstNodeId: s.one.id, lastNodeId: s.two.id, title: "进城", gist: "进城", summary: "进城", model: "aux", promptVersion: "chapter-1" });
    await s.repo.updateNarrative(s.one.id, "你握着短剑进了城。");
    const file = await exportWorld(s.repo, s.worldId);
    expect(archiveProblems(file)).toEqual([]);
    const copy = await importWorld(s.repo, file, "new");
    const copied = await tree.cursor(s.repo, copy);
    expect((await s.repo.chaptersOnPath(copy, copied.head.id))[0].stale).toBe(true);
    const old = structuredClone(file) as typeof file & { chapters: Record<string, unknown>[] };
    for (const chapter of old.chapters) delete chapter.stale;
    const older = await importWorld(s.repo, old, "new");
    const olderHead = await tree.cursor(s.repo, older);
    expect((await s.repo.chaptersOnPath(older, olderHead.head.id))[0].stale).toBeUndefined();
  });
});

describe("改过正文后的本局札记 (D183)", () => {
  it("marks the notes that read the edited turn, keeps the earliest turn, and says so in writing", async () => {
    const s = await story(2);
    const plot = { ...newStoryNote(s.worldId, "plot", { from: 0, to: 4, auto: true }, "主线梗概"), status: "done" as const, content: "主线：进城。" };
    const early = { ...newStoryNote(s.worldId, "person", { from: 0, to: 1, subject: "王掌柜" }, "人物：王掌柜"), status: "done" as const, content: "王掌柜是舅舅。" };
    const later = { ...newStoryNote(s.worldId, "setting", { from: 3, to: 4, subject: "城外" }, "地点：城外"), status: "done" as const, content: "城外有河。" };
    for (const note of [plot, early, later]) await saveNote(s.repo, note);
    expect(await markNotesStale(s.repo, s.worldId, 2)).toBe(1);
    expect((await getNote(s.repo, plot.id))?.scope.staleFrom).toBe(2);
    expect((await getNote(s.repo, early.id))?.scope.staleFrom).toBeUndefined();
    expect((await getNote(s.repo, later.id))?.scope.staleFrom).toBeUndefined();
    // An earlier edit moves the mark back; a later one leaves it.
    await markNotesStale(s.repo, s.worldId, 3);
    expect((await getNote(s.repo, plot.id))?.scope.staleFrom).toBe(2);
    await markNotesStale(s.repo, s.worldId, 1);
    expect((await getNote(s.repo, plot.id))?.scope.staleFrom).toBe(1);
    const brief = (await notesForTurn(s.repo, null, s.worldId, "")).find((n) => n.title.startsWith("主线梗概"));
    expect(brief?.title).toContain("之后的正文改过，以正文为准");
  });

  it("afterTextEdit finds the turn of the passage; the automatic 主线梗概 is redone once its chapters are summarized again", async () => {
    const s = await story();
    const chapter = await s.repo.addChapter({ worldId: s.worldId, firstNodeId: s.one.id, lastNodeId: s.two.id, title: "进城", gist: "进城见人", summary: "进城见人", model: "aux", promptVersion: "chapter-1" });
    const plot = { ...newStoryNote(s.worldId, "plot", { from: 0, to: 2, auto: true }, "主线梗概"), status: "done" as const, content: "旧主线：带着匕首进城。" };
    const mine = { ...newStoryNote(s.worldId, "plot", { from: 1, to: 2 }, "我写的梗概"), status: "done" as const, content: "玩家写的。" };
    await saveNote(s.repo, plot); await saveNote(s.repo, mine);
    await s.repo.updateNarrative(s.one.id, "你握着短剑进了城。");
    await s.game.afterTextEdit(s.worldId, s.one.id);
    expect((await getNote(s.repo, plot.id))?.scope.staleFrom).toBe(1);
    expect((await getNote(s.repo, mine.id))?.scope.staleFrom).toBe(1);

    // While the chapter is still out of date nothing is redone.
    await s.game.autoStoryPlot(s.worldId);
    expect(s.sent).toHaveLength(0);
    expect((await getNote(s.repo, plot.id))?.content).toBe("旧主线：带着匕首进城。");

    await s.repo.updateChapter(chapter.id, { title: "进城", gist: "带短剑进城", summary: "带短剑进城见王掌柜" });
    // A chapter the player wrote stays marked but does not hold the redo back.
    const own = await s.repo.addChapter({ worldId: s.worldId, firstNodeId: s.two.id, lastNodeId: s.two.id, title: "我写的", gist: "我写的", summary: "我写的", model: null, promptVersion: null });
    await s.repo.updateChapter(own.id, { title: "我写的", gist: "我写的", summary: "我写的", edited: true });
    await s.platform.sql.batch([{ sql: "UPDATE chapters SET stale=1 WHERE id=?", params: [own.id] }]);
    s.reply("新主线：带着短剑进城，见王掌柜。");
    await s.game.autoStoryPlot(s.worldId);
    const redone = (await getNote(s.repo, plot.id))!;
    expect(redone.content).toBe("新主线：带着短剑进城，见王掌柜。");
    expect(redone.previousContent).toBe("旧主线：带着匕首进城。");
    expect(redone.scope.staleFrom).toBeUndefined();
    expect(s.sent.at(-1)).toContain("带短剑进城见王掌柜");
    // The one the player wrote is only marked, never redone without asking.
    expect((await getNote(s.repo, mine.id))?.content).toBe("玩家写的。");
    expect((await listStoryNotes(s.repo, s.worldId)).filter((n) => n.kind === "plot")).toHaveLength(2);
  });
});

describe("过期的运行 (D183)", () => {
  it("the route's text fingerprint changes with any passage's words, not with 设定集 edits", async () => {
    const s = await story();
    const path = await s.repo.path(s.cursor().head.id);
    const before = textGuard(path);
    expect(textGuard(path)).toBe(before);
    const withEdit = [...path, { id: "e", kind: "edit" as const, narrative: "" }];
    expect(textGuard(withEdit)).toBe(before);
    await s.repo.updateNarrative(s.one.id, "你握着短剑进了城。");
    expect(textGuard(await s.repo.path(s.cursor().head.id))).not.toBe(before);
  });
});

describe("改后同步：事实也一起改 (D183)", () => {
  const request = (s: Awaited<ReturnType<typeof story>>, node = s.one, text = "你握着短剑进了城。"): FactSyncRequest => ({
    anchor: { worldId: s.worldId, lineId: s.cursor().line.id, headId: s.cursor().head.id, nodeId: node.id, original: node.narrative }, text,
  });

  it("keeps the player's text exactly, follows it in the record, and says which fields it could not change", async () => {
    const s = await story();
    const r = request(s, s.two, "你在酒肆遇见王掌柜，他是你表哥。");
    s.reply({ replacement: "模型自己改写的正文", unchanged: false, recordPatch: { log: "见到表哥王掌柜" }, correctionPatch: { people: [{ name: "王掌柜", role: "表哥" }], setStats: { money: 1 } }, note: "王掌柜是表哥" });
    const preview = await s.game.runFactSync(r).done;
    expect(preview.narrative).toBe("你在酒肆遇见王掌柜，他是你表哥。");
    expect(preview.replacement).toBe("你在酒肆遇见王掌柜，他是你表哥。");
    expect(preview.unchanged).toBe(false);
    expect(preview.kind).toBe("factSync");
    expect(preview.droppedCorrections).toEqual(["钱物统计"]);
    expect(preview.correctionPatch).toEqual({ people: [{ name: "王掌柜", role: "表哥" }] });
    expect(preview.recordChanges.map((c) => c.name)).toContain("本回合记事");
    // The request shows both texts and says the edited one is final.
    expect(s.sent[0]).toContain("【这是最新一段】\n【改前正文】\n你在酒肆遇见王掌柜。");
    expect(s.sent[0]).toContain("【改后正文（玩家定稿，不要改写）】\n你在酒肆遇见王掌柜，他是你表哥。");

    const adopted = await adoptPlayerRevision(s.game, preview);
    expect(adopted.head.narrative).toBe("你在酒肆遇见王掌柜，他是你表哥。");
    expect((await tree.variants(s.repo, adopted.head)).count).toBe(2);
    expect(adopted.head.meta.revision).toMatchObject({ kind: "factSync", nodeId: s.two.id });
    expect((adopted.head.record as { log?: string } | null)?.log).toBe("见到表哥王掌柜");
    const state = await s.repo.getState(adopted.head.id);
    expect(state.facts?.some((f) => f.origin === "player" && f.detail.startsWith("玩家改写了这段：王掌柜是表哥"))).toBe(true);
    // The story still exports with the new revision kind.
    const file = await exportWorld(s.repo, s.worldId);
    expect(archiveProblems(file)).toEqual([]);
    await importWorld(s.repo, file, "new");
  });

  it("an earlier passage gets its own route and the original route keeps what followed", async () => {
    const s = await story(2);
    s.reply({ unchanged: false, recordPatch: { log: "带着短剑进城" }, correctionPatch: { cards: [{ name: abilityCardName("林舟"), content: "兵器：短剑。" }] }, note: "匕首换成短剑" });
    const preview = await s.game.runFactSync(request(s)).done;
    expect(s.sent[0]).not.toContain("【这是最新一段】\n【改前正文】");
    const adopted = await adoptPlayerRevision(s.game, preview);
    expect(adopted.line.name).toContain("改写后的路线");
    expect(adopted.head.narrative).toBe("你握着短剑进了城。");
    expect((await s.repo.getNode(s.one.id))?.narrative).toBe("你握着匕首进了城。");
    expect((await s.repo.getState(adopted.head.id)).cards.find((c) => c.name === "林舟的本事")?.content).toBe("兵器：短剑。");
  });

  it("“only the wording changed” changes no record and is not offered as a revision", async () => {
    const s = await story();
    s.reply({ unchanged: true, recordPatch: { log: "不该用的" }, correctionPatch: { cards: [{ name: "x", content: "y" }] } });
    const preview = await s.game.runFactSync(request(s, s.two, "你在酒肆里遇见了王掌柜。")).done;
    expect(preview.unchanged).toBe(true);
    expect(preview.recordChanges).toEqual([]);
    expect(preview.correctionPatch).toBeUndefined();
    expect(preview.narrative).toBe("你在酒肆里遇见了王掌柜。");
  });

  it("a reply that is not a record is an honest failure; parseFactSync never takes the model's text", async () => {
    const s = await story();
    s.reply("我觉得改得很好。");
    await expect(s.game.runFactSync(request(s)).done).rejects.toThrow("这次没有整理出记录的变化");
    const parsed = parseFactSync(JSON.stringify({ replacement: "别的", narrative: "别的" }), request(s), null)!;
    expect(parsed.narrative).toBe("你握着短剑进了城。");
    // Nothing changed in the story.
    expect((await s.repo.getNode(s.one.id))?.narrative).toBe("你握着匕首进了城。");
  });

  it("survives background AI upkeep during fact-sync and text-only rewrite", async () => {
    const s = await story();
    const r = request(s, s.two, "你在酒肆遇见王掌柜，他是你表哥。");
    const origStream = s.platform.llm.stream.bind(s.platform.llm);
    let appended = false;
    s.platform.llm.stream = async (req, onEvent) => {
      if (!appended) {
        appended = true;
        const cur = s.cursor();
        await tree.append(s.repo, cur, { kind: "edit", actionText: "AI 整理了设定集", narrative: "", state: await s.repo.getState(cur.head.id), meta: { by: "AI", upkeep: true } });
      }
      return origStream(req, onEvent);
    };
    s.reply({ unchanged: false, recordPatch: { log: "见到表哥王掌柜" }, note: "改关系" });
    const preview = await s.game.runFactSync(r).done;
    expect(preview.anchor.headId).toBe((await tree.cursor(s.repo, s.worldId)).head.id);
    // Also verify text-only adoptRewrite survives an upkeep edit appended after the anchor.
    const cur = await tree.cursor(s.repo, s.worldId);
    const oldAnchor = { worldId: s.worldId, lineId: cur.line.id, headId: cur.head.id, nodeId: s.one.id, original: s.one.narrative };
    await tree.append(s.repo, cur, { kind: "edit", actionText: "AI 整理了设定集", narrative: "", state: await s.repo.getState(cur.head.id), meta: { by: "AI", upkeep: true } });
    await adoptRewrite(s.game, oldAnchor, "你握着长剑进了城。");
    expect((await s.repo.getNode(s.one.id))?.narrative).toBe("你握着长剑进了城。");
  });

  it("stops early with zero model calls when syncing a legacy opening without openingSeed", async () => {
    const s = await story();
    const { world, node, line } = await s.repo.createWorld({
      title: "旧开场", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "旧开场正文。", state: sampleState(), meta: {} },
    });
    let calls = 0;
    s.platform.llm.stream = async () => { calls++; return "never"; };
    const anchor = { worldId: world.id, lineId: line.id, headId: node.id, nodeId: node.id, original: node.narrative };
    await expect(s.game.runFactSync({ anchor, text: "改过的旧开场。" }).done).rejects.toThrow(MISSING_OPENING_SEED_SYNC);
    expect(calls).toBe(0);
  });
});

describe("改过正文后的下一段请求 (D183)", () => {
  async function native() {
    const platform = await createMemoryPlatform();
    const plans: Record<string, unknown>[] = [];
    const resumed: string[] = [];
    const closing = { once: false };
    platform.execution = {
      agent: async () => null, settle: async () => null, list: async () => [], stop: async () => ({ executionId: null, status: "cancelled", accepted: true, settled: true }),
      // A run that just stopped can answer “busy” once while it closes.
      resume: async (id) => { if (closing.once) { closing.once = false; throw new PlatformError("busy", "这个故事还有任务正在运行"); } resumed.push(id); },
      start: async (plan) => { plans.push(plan as Record<string, unknown>); return `run${plans.length}`; },
      snapshot: async (id) => ({ id, worldId: "", status: "failed", budget: { modelRequests: 0, toolCalls: 0, corrections: 0, activeMs: 0 }, draft: null, result: null, error: "测试结束", events: [] }),
    };
    const game = await Game.open(platform, { ...LLM, contextTokens: 20_000 });
    const { world } = await game.repo.createWorld({ title: "测试故事", eraId: "free", settings: { premise: "一座城。", chapterEvery: 8 },
      opening: { parentId: null, kind: "opening", narrative: "你醒来。", state: sampleState(), meta: {} } });
    let c = await tree.cursor(game.repo, world.id);
    c = await tree.append(game.repo, c, { kind: "turn", actionMode: "do", actionText: "进城", narrative: "你握着匕首进了城。", state: sampleState() });
    const one = c.head;
    c = await tree.append(game.repo, c, { kind: "turn", actionMode: "do", actionText: "喝茶", narrative: "你在茶摊坐下。", state: sampleState() });
    const chapter = await game.repo.addChapter({ worldId: world.id, firstNodeId: one.id, lastNodeId: c.head.id, title: "进城", gist: "带匕首进城", summary: "带匕首进城", model: "aux", promptVersion: "chapter-1" });
    const play = () => new Promise<void>((done) => game.play(world.id, { mode: "do", text: "出门" }, (e) => { if (e.type === "failed" || e.type === "done") done(); }));
    return { platform, game, world, one, chapter, plans, resumed, play, closing };
  }

  it("asks the tidy-up to summarize an out-of-date chapter again from the edited text, and carries the text fingerprint", async () => {
    const s = await native();
    await s.play();
    expect((s.plans[0].meta as Record<string, unknown>).chapterRefresh).toBeUndefined();
    await s.game.repo.updateNarrative(s.one.id, "你握着短剑进了城。");
    await s.play();
    const meta = s.plans[1].meta as { chapterRefresh?: { id: string; messages: { content: string }[] }[]; textGuard?: string };
    expect(meta.chapterRefresh?.map((r) => r.id)).toEqual([s.chapter.id]);
    expect(meta.chapterRefresh?.[0].messages.map((m) => m.content).join("\n")).toContain("你握着短剑进了城。");
    expect(meta.textGuard).toBe(textGuard(await s.game.repo.path((await tree.cursor(s.game.repo, s.world.id)).head.id)));
    // A chapter the player wrote is theirs: it is flagged, never summarized again.
    await s.game.repo.updateChapter(s.chapter.id, { title: "进城", gist: "我写的", summary: "我写的", edited: true });
    await s.game.repo.updateNarrative(s.one.id, "你握着长剑进了城。");
    await s.play();
    expect((s.plans[2].meta as Record<string, unknown>).chapterRefresh).toBeUndefined();
  });

  it("重试 a stopped passage whose earlier text was edited since writes it anew instead of replaying the old request", async () => {
    const s = await native();
    await s.play();
    // Stored as the native core keeps it: its model record has no contextTokens.
    const { contextTokens: _dropped, ...model } = s.plans[0].model as Record<string, unknown>;
    const saved = { ...s.plans[0], model };
    const store = (id: string) => s.platform.sql.batch([{ sql: "INSERT INTO execution_runs(id,world_id,line_id,base_head_id,status,plan_json,budget_json,draft_json,error_kind,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','{}',?,'t','t')", params: [id, s.world.id, String(s.plans[0].lineId), String(s.plans[0].headId), "failed", JSON.stringify(saved), "network"] }]);
    const retry = (id: string) => new Promise<void>((done) => { s.game.retryRun(id, (e) => { if (e.type === "failed" || e.type === "done" || e.type === "finished") done(); }); });
    await store("same");
    s.closing.once = true;
    await retry("same");
    expect(s.resumed).toEqual(["same"]);
    expect(s.plans).toHaveLength(1);
    await s.game.repo.updateNarrative(s.one.id, "你握着短剑进了城。");
    await store("edited");
    await retry("edited");
    expect(s.resumed).toEqual(["same"]);
    expect(s.plans).toHaveLength(2);
    expect(JSON.stringify((s.plans[1] as { messages: unknown }).messages)).toContain("你握着短剑进了城。");
  });

  it("retryRun preserves completed writing stage when model, auxModel, or depth tier changes (R31-P5)", async () => {
    const s = await native();
    await s.play();
    const { contextTokens: _dropped, ...model } = s.plans[0].model as Record<string, unknown>;
    const saved = { ...s.plans[0], model };
    await s.platform.sql.batch([
      { sql: "INSERT INTO execution_runs(id,world_id,line_id,base_head_id,status,plan_json,budget_json,draft_json,error_kind,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','{}',?,'t','t')", params: ["with-prose", s.world.id, String(s.plans[0].lineId), String(s.plans[0].headId), "failed", JSON.stringify(saved), "http"] },
      { sql: "INSERT INTO execution_steps(run_id,step_key,kind,status,input_json,output_json) VALUES('with-prose','model:1','writing:0','done','{}','{}')", params: [] },
      { sql: "INSERT INTO execution_runs(id,world_id,line_id,base_head_id,status,plan_json,budget_json,draft_json,error_kind,created_at,updated_at) VALUES(?,?,?,?,?,?,'{}','{}',?,'t','t')", params: ["no-prose", s.world.id, String(s.plans[0].lineId), String(s.plans[0].headId), "failed", JSON.stringify(saved), "http"] },
    ]);
    // Switch auxModel & depth tier on the active world.
    s.game.llm = { ...s.game.llm!, auxModel: "fast-aux-model" };
    await s.game.repo.updateSettings(s.world.id, { ...(await s.game.repo.getWorld(s.world.id))!.settings, depth: "fast" });
    const retry = (id: string) => new Promise<void>((done) => { s.game.retryRun(id, (e) => { if (e.type === "failed" || e.type === "done" || e.type === "finished") done(); }); });
    await retry("with-prose");
    // Preserved completed writing stage: resumed in place with patched plan_json instead of starting anew!
    expect(s.resumed).toEqual(["with-prose"]);
    expect(s.plans).toHaveLength(1);
    const [patched] = await s.platform.sql.query("SELECT plan_json FROM execution_runs WHERE id='with-prose'");
    const nextPlan = JSON.parse(String(patched.plan_json)) as { model: { auxModel?: string }; settings: { depth?: string }; meta: { allowModelSwitchReuse?: boolean; depth?: string } };
    expect(nextPlan.model.auxModel).toBe("fast-aux-model");
    expect(nextPlan.settings.depth).toBe("fast");
    expect(nextPlan.meta.depth).toBe("fast");
    expect(nextPlan.meta.allowModelSwitchReuse).toBe(true);
    // Without any completed stage, switching model/depth still starts fresh cleanly.
    await retry("no-prose");
    expect(s.resumed).toEqual(["with-prose"]);
    expect(s.plans).toHaveLength(2);
  });
});
