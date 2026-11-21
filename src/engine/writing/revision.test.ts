// 按我的要求改: the player's words are the evidence; no book is needed.
import { describe, expect, it } from "vitest";
import { Game } from "../game";
import { createMemoryPlatform } from "../../platform/memory";
import { sampleState } from "../testing/fixtures";
import * as tree from "../tree";
import { archiveProblems, exportWorld, importWorld } from "../archive";
import { abilityCardName, adoptPlayerRevision, resolveCorrectionCards, canonOutcomeText, canonStop, filterCorrectionPatch, mergeRecordPatch, parsePlayerRevision, STALE_WRITING, type CanonCorrectionPreview, type PlayerRevisionRequest } from "./assist";

const LLM = { slot: "t", url: "https://main.invalid/v1/chat/completions", model: "m", auxModel: "aux", includeUsage: true };

async function setup(tail = 0) {
  const platform = await createMemoryPlatform();
  const game = await Game.open(platform, LLM);
  const opening = sampleState(100);
  opening.protagonist.name = "林舟";
  const { world } = await game.repo.createWorld({ title: "测试故事", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "开场。", state: opening, meta: { openingSeed: opening } } });
  let cursor = await tree.cursor(game.repo, world.id);
  const after = sampleState(90); after.protagonist.name = "林舟"; after.time.elapsedMinutes = 30;
  cursor = await tree.append(game.repo, cursor, { kind: "turn", actionMode: "do", actionText: "练剑", narrative: "你握着匕首练到第二式。你开始琢磨第三式。", state: after, record: { time: "半个时辰", money: -10, log: "练到第二式" } });
  const target = cursor.head;
  for (let i = 0; i < tail; i++) cursor = await tree.append(game.repo, cursor, { kind: "turn", actionMode: "continue", narrative: `后续${i}`, state: after });
  const reply = (body: object) => {
    platform.llm.stream = async (_request, onEvent) => {
      onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: JSON.stringify(body) }, finish_reason: "stop" }] }) });
      onEvent({ type: "done" });
      return "test-stream";
    };
  };
  const request: PlayerRevisionRequest = { anchor: { worldId: world.id, lineId: cursor.line.id, headId: cursor.head.id, nodeId: target.id, original: target.narrative }, range: { start: 0, end: target.narrative.length }, hint: "把匕首换成短剑；已经练到第三式" };
  return { game, world, target, cursor, request, reply };
}

describe("按我的要求改", () => {
  it("merges only the patched fields of the turn's record, never whole-story fields", () => {
    expect(mergeRecordPatch({ time: "半个时辰", money: -10, items: [{ name: "玉佩", delta: 1 }] } as never, { money: -20, items: [{ name: "玉佩", delta: 2 }, { name: "药", delta: 1 }], setStats: { money: 9 }, protagonist: {} }))
      .toEqual({ time: "半个时辰", money: -20, items: [{ name: "玉佩", delta: 2 }, { name: "药", delta: 1 }] });
  });

  it("keeps the AI's cards the AI's to keep up, and drops a correction outside what may be corrected", () => {
    const s = { anchor: { worldId: "w", lineId: "l", headId: "h", nodeId: "n", original: "原文" }, range: { start: 0, end: 2 }, hint: "改" };
    const ok = parsePlayerRevision(JSON.stringify({ replacement: "新文", correctionPatch: { cards: [{ name: "林舟的本事", content: "剑法练到第三式" }] }, note: "改了剑法" }), s, null)!;
    expect(ok.correctionPatch?.cards).toEqual([{ name: "林舟的本事", content: "剑法练到第三式" }]);
    expect(ok.narrative).toBe("新文");
    const bad = parsePlayerRevision(JSON.stringify({ replacement: "新文", correctionPatch: { setStats: { money: 1 } } }), s, null)!;
    expect(bad.correctionPatch).toBeUndefined();
    expect(bad.droppedCorrections).toEqual(["钱物统计"]);
    // One stray field no longer throws away the rest of the correction (R30 step 3).
    const mixed = filterCorrectionPatch({ cards: [{ name: "林舟的本事", content: "第三式" }], setStats: { money: 1 }, profile: { identity: "镖师", panel: "x" } });
    expect(mixed.kept).toEqual({ cards: [{ name: "林舟的本事", content: "第三式" }], profile: { identity: "镖师" } });
    expect(mixed.dropped).toEqual(["钱物统计", "主角面板"]);
    expect(parsePlayerRevision("不是 JSON", s, null)).toBeNull();
  });

  it("a correction updates an existing card as its own kind and owner; only a new card is the AI's", () => {
    const state = sampleState(100);
    state.cards.push({ id: "gang", kind: "势力", name: "漕帮", keys: ["运河帮"], content: "旧说法", source: "玩家" });
    const resolved = resolveCorrectionCards({ cards: [{ op: "update", name: "运河帮", kind: "设定", content: "新说法", source: "AI" }, { op: "add", name: "铜鹰符", kind: "设定", content: "信物" }] } as never, state);
    expect(resolved.cards).toEqual([{ op: "update", name: "运河帮", kind: "势力", content: "新说法" }, { op: "add", name: "铜鹰符", kind: "设定", content: "信物", source: "AI" }]);
  });

  it("revises the latest passage as another version, fixes the earlier fact in the 设定集, and needs no book", async () => {
    const s = await setup();
    s.reply({
      replacement: "你握着短剑练到第三式。你开始琢磨第四式。",
      recordPatch: { log: "练到第三式" },
      correctionPatch: { cards: [{ name: abilityCardName("林舟"), content: "兵器：短剑。剑法：练到第三式。" }] },
      note: "匕首改为短剑，已练到第三式",
    });
    const preview = await s.game.runPlayerRevision(s.request, () => {}).done;
    expect(preview.recordChanges.map((c) => c.name)).toContain("本回合记事");
    const revised = await adoptPlayerRevision(s.game, preview);
    expect(revised.head.narrative).toBe("你握着短剑练到第三式。你开始琢磨第四式。");
    expect(revised.head.parentId).toBe(s.target.parentId);
    expect((await tree.variants(s.game.repo, revised.head)).count).toBe(2);
    const state = await s.game.repo.getState(revised.head.id);
    expect(state.cards.find((c) => c.name === "林舟的本事")).toMatchObject({ source: "AI", content: expect.stringContaining("练到第三式") });
    expect(state.protagonist.stats.money).toBe(90);
    expect(state.facts?.some((f) => f.origin === "player" && f.detail.includes("匕首改为短剑"))).toBe(true);
    expect(revised.head.meta.revision).toMatchObject({ kind: "playerRevision", nodeId: s.target.id });
    // The story still exports and imports with the new revision kind.
    const file = await exportWorld(s.game.repo, s.world.id);
    expect(archiveProblems(file)).toEqual([]);
    await importWorld(s.game.repo, file, "new");
  });

  it("the AI's background 设定集 tidy-up after the latest passage does not make it an earlier one", async () => {
    const s = await setup();
    const state = await s.game.repo.getState(s.cursor.head.id);
    const tidied = await tree.append(s.game.repo, s.cursor, { kind: "edit", actionText: "AI 整理了设定集", narrative: "", state, meta: { by: "AI", upkeep: true } });
    const request = { ...s.request, anchor: { ...s.request.anchor, headId: tidied.head.id } };
    s.reply({ replacement: "你握着短剑练到第三式。你开始琢磨第四式。", note: "改兵器" });
    const revised = await adoptPlayerRevision(s.game, await s.game.runPlayerRevision(request, () => {}).done);
    expect(revised.line.id).toBe(s.cursor.line.id);
    expect(revised.head.parentId).toBe(s.target.parentId);
    expect((await tree.variants(s.game.repo, revised.head)).count).toBe(2);
  });

  it("the player's own edit after the latest passage keeps it the latest, and the edit is made again on the new version", async () => {
    const s = await setup();
    const edited = await s.game.editState(s.world.id, { profile: { identity: "镖师" } }, "你改了身份");
    const head = "head" in edited ? edited.head : (await tree.cursor(s.game.repo, s.world.id)).head;
    const request = { ...s.request, anchor: { ...s.request.anchor, headId: head.id } };
    s.reply({ replacement: "你握着短剑练到第三式。", note: "改兵器" });
    const revised = await adoptPlayerRevision(s.game, await s.game.runPlayerRevision(request, () => {}).done);
    expect(revised.line.id).toBe(s.cursor.line.id);
    // The route ends on the edit made again, whose parent is the new version beside the old passage.
    expect(revised.head.kind).toBe("edit");
    expect(revised.head.actionText).toBe("你改了身份");
    const version = (await s.game.repo.getNode(revised.head.parentId!))!;
    expect(version.narrative).toBe("你握着短剑练到第三式。");
    expect(version.parentId).toBe(s.target.parentId);
    expect((await tree.variants(s.game.repo, version)).count).toBe(2);
    expect((await s.game.repo.getState(revised.head.id)).protagonist.identity).toBe("镖师");
  });

  it("rejects a latest-passage preview if the player advances before the commit", async () => {
    const s = await setup();
    s.reply({ replacement: "你握着短剑练到第三式。", note: "改兵器" });
    const preview = await s.game.runPlayerRevision(s.request, () => {}).done;
    const repo = s.game.repo;
    const fork = repo.forkRevision.bind(repo);
    repo.forkRevision = async (...args) => {
      await tree.append(repo, s.cursor, { kind: "turn", narrative: "我已继续。", state: sampleState() });
      return fork(...args);
    };
    await expect(adoptPlayerRevision(s.game, preview)).rejects.toThrow(STALE_WRITING);
    expect((await tree.cursor(repo, s.world.id)).head.narrative).toBe("我已继续。");
  });

  it("an earlier passage gets a revision route, and what followed stays on the original one", async () => {
    const s = await setup(2);
    s.reply({ replacement: "你握着短剑练到第三式。你开始琢磨第四式。", note: "改兵器" });
    const revised = await adoptPlayerRevision(s.game, await s.game.runPlayerRevision(s.request, () => {}).done);
    expect(revised.line.name).toContain("改写后的路线");
    expect(revised.line.id).not.toBe(s.cursor.line.id);
    expect((await s.game.repo.getLine(s.cursor.line.id))?.nodeId).toBe(s.cursor.head.id);
  });

  it("按原著纠错 tells each way it can end as it is, never “not in the book” for all (D182)", () => {
    expect(canonStop({ status: "paused", error: "本次生成查阅资料的次数较多，已先停下，进度已保存" })).toMatchObject({ resumable: true, text: expect.stringContaining("可以接着查") });
    expect(canonStop({ status: "failed", error: "改稿引用的原文和实际查到的对不上，没有采用", draft: { correctionStop: { code: "quote_mismatch", quotes: ["城门每日卯时开启"] } } }).text).toContain("“城门每日卯时开启”");
    expect(canonStop({ status: "failed", error: "AI 服务返回 503：busy，进度已保存" }).text).toBe("AI 服务返回 503：busy");
    const base = { searched: [{ tool: "search_original", query: "城门", hits: 3, times: 2 }], read: 3 } as unknown as CanonCorrectionPreview;
    expect(canonOutcomeText({ ...base, outcome: "verified" })).toContain("对得上");
    expect(canonOutcomeText({ ...base, outcome: "answer", answer: "城门卯时开、酉时关。" })).toBe("城门卯时开、酉时关。");
    const noBasis = canonOutcomeText({ ...base, outcome: "not_found", reason: "no_basis" });
    expect(noBasis).toContain("读了 3 段原文");
    expect(noBasis).toContain("城门（2 次，命中 3 段）");
    expect(noBasis).toContain("按我的要求改");
    expect(canonOutcomeText({ ...base, outcome: "not_found", reason: "out_of_range" }, 49)).toContain("截至第 50 章");
    expect(canonOutcomeText({ ...base, outcome: "not_found", reason: "no_excerpt", read: 0 })).toContain("没有找到相关的原文");
  });

  it("refuses to adopt a revision that changes nothing", async () => {
    const s = await setup();
    s.reply({ replacement: s.target.narrative, note: "没有变化" });
    const preview = await s.game.runPlayerRevision(s.request, () => {}).done;
    await expect(adoptPlayerRevision(s.game, preview)).rejects.toThrow("没有要采用的改动");
  });
});
