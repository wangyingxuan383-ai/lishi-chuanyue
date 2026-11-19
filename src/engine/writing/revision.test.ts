// 按我的要求改: the player's words are the evidence; no book is needed.
import { describe, expect, it } from "vitest";
import { Game } from "../game";
import { createMemoryPlatform } from "../../platform/memory";
import { sampleState } from "../testing/fixtures";
import * as tree from "../tree";
import { archiveProblems, exportWorld, importWorld } from "../archive";
import { abilityCardName, adoptPlayerRevision, CANON_NOT_FOUND, canonStopText, mergeRecordPatch, parsePlayerRevision, STALE_WRITING, type PlayerRevisionRequest } from "./assist";

const LLM = { slot: "t", url: "https://main.invalid/v1/chat/completions", model: "m", auxModel: "aux", includeUsage: true };

async function setup(tail = 0) {
  const platform = await createMemoryPlatform();
  const game = await Game.open(platform, LLM);
  const opening = sampleState(100);
  opening.protagonist.name = "唐舞";
  const { world } = await game.repo.createWorld({ title: "绝世同人", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "开场。", state: opening, meta: { openingSeed: opening } } });
  let cursor = await tree.cursor(game.repo, world.id);
  const after = sampleState(90); after.protagonist.name = "唐舞"; after.time.elapsedMinutes = 30;
  cursor = await tree.append(game.repo, cursor, { kind: "turn", actionMode: "do", actionText: "吸收魂环", narrative: "你的两个黄色魂环亮起。你开始吸收第二魂环。", state: after, record: { time: "半个时辰", money: -10, log: "吸收第二魂环" } });
  const target = cursor.head;
  for (let i = 0; i < tail; i++) cursor = await tree.append(game.repo, cursor, { kind: "turn", actionMode: "continue", narrative: `后续${i}`, state: after });
  const reply = (body: object) => {
    platform.llm.stream = async (_request, onEvent) => {
      onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: JSON.stringify(body) }, finish_reason: "stop" }] }) });
      onEvent({ type: "done" });
      return "test-stream";
    };
  };
  const request: PlayerRevisionRequest = { anchor: { worldId: world.id, lineId: cursor.line.id, headId: cursor.head.id, nodeId: target.id, original: target.narrative }, range: { start: 0, end: target.narrative.length }, hint: "魂环是紫紫，现在是二环，正在吸收第三环" };
  return { game, world, target, cursor, request, reply };
}

describe("按我的要求改", () => {
  it("merges only the patched fields of the turn's record, never whole-story fields", () => {
    expect(mergeRecordPatch({ time: "半个时辰", money: -10, items: [{ name: "魂骨", delta: 1 }] } as never, { money: -20, items: [{ name: "魂骨", delta: 2 }, { name: "药", delta: 1 }], setStats: { money: 9 }, protagonist: {} }))
      .toEqual({ time: "半个时辰", money: -20, items: [{ name: "魂骨", delta: 2 }, { name: "药", delta: 1 }] });
  });

  it("keeps the AI's cards the AI's to keep up, and drops a correction outside what may be corrected", () => {
    const s = { anchor: { worldId: "w", lineId: "l", headId: "h", nodeId: "n", original: "原文" }, range: { start: 0, end: 2 }, hint: "改" };
    const ok = parsePlayerRevision(JSON.stringify({ replacement: "新文", correctionPatch: { cards: [{ name: "唐舞的本事", content: "两个千年紫环" }] }, note: "改了魂环" }), s, null)!;
    expect(ok.correctionPatch?.cards).toEqual([{ name: "唐舞的本事", content: "两个千年紫环", kind: "设定", source: "AI" }]);
    expect(ok.narrative).toBe("新文");
    const bad = parsePlayerRevision(JSON.stringify({ replacement: "新文", correctionPatch: { setStats: { money: 1 } } }), s, null)!;
    expect(bad.correctionPatch).toBeUndefined();
    expect(parsePlayerRevision("不是 JSON", s, null)).toBeNull();
  });

  it("revises the latest passage as another version, fixes the earlier fact in the 设定集, and needs no book", async () => {
    const s = await setup();
    s.reply({
      replacement: "你的两个紫色魂环亮起。你开始吸收第三魂环。",
      recordPatch: { log: "开始吸收第三魂环" },
      correctionPatch: { cards: [{ name: abilityCardName("唐舞"), content: "武魂：蓝银草。魂环：两个千年紫环，正在吸收第三环。" }] },
      note: "魂环改为紫紫，正在吸收第三环",
    });
    const preview = await s.game.runPlayerRevision(s.request, () => {}).done;
    expect(preview.recordChanges.map((c) => c.name)).toContain("本回合记事");
    const revised = await adoptPlayerRevision(s.game, preview);
    expect(revised.head.narrative).toBe("你的两个紫色魂环亮起。你开始吸收第三魂环。");
    expect(revised.head.parentId).toBe(s.target.parentId);
    expect((await tree.variants(s.game.repo, revised.head)).count).toBe(2);
    const state = await s.game.repo.getState(revised.head.id);
    expect(state.cards.find((c) => c.name === "唐舞的本事")).toMatchObject({ source: "AI", content: expect.stringContaining("千年紫环") });
    expect(state.protagonist.stats.money).toBe(90);
    expect(state.facts?.some((f) => f.origin === "player" && f.detail.includes("魂环改为紫紫"))).toBe(true);
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
    s.reply({ replacement: "你的两个紫色魂环亮起。你开始吸收第三魂环。", note: "改魂环" });
    const revised = await adoptPlayerRevision(s.game, await s.game.runPlayerRevision(request, () => {}).done);
    expect(revised.line.id).toBe(s.cursor.line.id);
    expect(revised.head.parentId).toBe(s.target.parentId);
    expect((await tree.variants(s.game.repo, revised.head)).count).toBe(2);
  });

  it("rejects a latest-passage preview if the player advances before the commit", async () => {
    const s = await setup();
    s.reply({ replacement: "你的两个紫色魂环亮起。", note: "改魂环" });
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
    s.reply({ replacement: "你的两个紫色魂环亮起。你开始吸收第三魂环。", note: "改魂环" });
    const revised = await adoptPlayerRevision(s.game, await s.game.runPlayerRevision(s.request, () => {}).done);
    expect(revised.line.name).toContain("改写后的路线");
    expect(revised.line.id).not.toBe(s.cursor.line.id);
    expect((await s.game.repo.getLine(s.cursor.line.id))?.nodeId).toBe(s.cursor.head.id);
  });

  it("按原著纠错 that finds no basis says so and points to 按我的要求改, never just “进度已保存”", () => {
    expect(canonStopText("本次生成查阅资料的次数较多，已先停下，进度已保存")).toBe(CANON_NOT_FOUND);
    expect(canonStopText("尚未查出带原文依据的更正，原路线未改动")).toBe(CANON_NOT_FOUND);
    expect(CANON_NOT_FOUND).toContain("按我的要求改");
    expect(canonStopText("AI 服务返回 503：busy，进度已保存")).toBe("AI 服务返回 503：busy");
  });
});
