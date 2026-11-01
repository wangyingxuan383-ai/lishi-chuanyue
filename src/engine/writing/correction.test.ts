import { describe, expect, it, vi } from "vitest";
import { Game } from "../game";
import { createMemoryPlatform } from "../../platform/memory";
import { sampleState } from "../testing/fixtures";
import { newBinding, type SourceBook } from "../sources/types";
import { referenceContext, saveBook } from "../sources/library";
import * as tree from "../tree";
import { adoptCanonCorrection, MISSING_OPENING_SEED, openingBaseline, type CanonCorrectionPreview } from "./assist";
import { archiveProblems, exportWorld, importWorld } from "../archive";
import type { TurnRecord } from "../state/apply";

async function setup(tail = 1, opening = false, savedSeed = true) {
  const game = await Game.open(await createMemoryPlatform());
  const book: SourceBook = { id: crypto.randomUUID(), title: "灯下书", format: "txt", createdAt: new Date().toISOString(), sections: [{ title: "第一章", text: "阿青是药铺医者，佩戴白玉梅花纹玉佩。" }] };
  await saveBook(game.repo, book);
  const source = newBinding(book.id, true), seed = sampleState(100); seed.source = source;
  const oldOpening = structuredClone(seed); if (opening) oldOpening.protagonist.stats.money = 999;
  const { world, node } = await game.repo.createWorld({ title: "纠错样本", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: "阿青佩戴青铜玉佩。", state: oldOpening, meta: savedSeed ? { openingSeed: seed } : {} } });
  let cursor = await tree.cursor(game.repo, world.id), target = node;
  if (!opening) {
    const old = sampleState(80); old.source = source; old.time.elapsedMinutes = 20;
    cursor = await tree.append(game.repo, cursor, { kind: "turn", actionMode: "do", actionText: "付十文买药", narrative: "阿青佩戴青铜玉佩，你付了二十文。", state: old }); target = cursor.head;
  }
  for (let i = 0; i < tail; i++) {
    const later = sampleState(20); later.source = source;
    cursor = await tree.append(game.repo, cursor, { kind: "turn", actionMode: "continue", narrative: `原路线后续${i}`, state: later });
  }
  const reference = (await referenceContext(game.repo, source, "玉佩", 3000))!;
  const preview: CanonCorrectionPreview = {
    anchor: { worldId: world.id, lineId: cursor.line.id, headId: cursor.head.id, nodeId: target.id, original: target.narrative },
    sourceGuard: JSON.stringify(source), narrative: "阿青佩戴白玉梅花纹玉佩，你付了十文。",
    record: opening ? { money: 50, time: "0", place: "药铺" } : { money: -10, time: "十分钟", place: "药铺" },
    corrections: [{ detail: "玉佩应为白玉，纹样为梅花。", citations: [{ bookId: book.id, section: 0, chunk: 0, title: "第一章", quote: book.sections[0].text, start: 0, end: book.sections[0].text.length }] }], reference,
  };
  return { game, book, world, node, target, cursor, seed, preview };
}

describe("canon correction revisions", () => {
  it("keeps text outside the selected range and its unrelated payment", async () => {
    const s = await setup(0);
    const end = s.target.narrative.indexOf("，");
    s.preview.range = { start: 0, end };
    s.preview.replacement = "阿青佩戴白玉梅花纹玉佩";
    s.preview.narrative = s.preview.replacement + s.target.narrative.slice(end);
    s.preview.record = { money: -20, time: "二十分钟" };
    const revised = await adoptCanonCorrection(s.game, s.preview);
    expect(revised.head.narrative.endsWith("，你付了二十文。")).toBe(true);
    const state = await s.game.repo.getState(revised.head.id);
    expect(state.protagonist.stats.money).toBe(80);
    expect(state.time.elapsedMinutes).toBe(20);
  });
  it("rejects an out-of-range change before creating a revision", async () => {
    const s = await setup(0);
    s.preview.range = { start: 0, end: s.target.narrative.indexOf("，") };
    s.preview.replacement = "阿青佩戴白玉梅花纹玉佩";
    await expect(adoptCanonCorrection(s.game, s.preview)).rejects.toThrow("选中范围");
    expect((await tree.cursor(s.game.repo, s.world.id)).head.id).toBe(s.cursor.head.id);
  });
  it("keeps copied player provenance separate and refuses an invented preservation note", async () => {
    const s = await setup();
    const fact = { id: "player-rescue", origin: "player" as const, detail: "玩家救下阿兰，阿兰活着。", citations: [] };
    const seed = await s.game.repo.getState(s.node.id); seed.facts = [fact];
    await s.game.platform.sql.batch([{ sql: "UPDATE states SET state_json=? WHERE node_id=?", params: [JSON.stringify(seed), s.node.id] }]);
    s.preview.preservedPlayerFacts = [{ id: fact.id, detail: "AI胡编的另一条事实" }];
    await expect(adoptCanonCorrection(s.game, s.preview)).rejects.toThrow("玩家分支的来源");
    s.preview.preservedPlayerFacts = [{ id: fact.id, detail: fact.detail }];
    const revised = await adoptCanonCorrection(s.game, s.preview), state = await s.game.repo.getState(revised.head.id);
    expect(state.facts?.find((f) => f.id === fact.id)).toEqual(fact);
    expect(revised.head.meta.preservedPlayerFacts).toEqual([{ id: fact.id, detail: fact.detail }]);
    expect(state.facts?.filter((f) => f.origin === "correction").every((f) => f.citations.length)).toBe(true);
  });
  it.each([0, 1, 2, 5])("preserves an original route with %i later turns and settles once from the target parent", async (tail) => {
    const s = await setup(tail), oldPath = await s.game.repo.path(s.cursor.head.id);
    const revised = await adoptCanonCorrection(s.game, s.preview);
    expect(revised.line.id).not.toBe(s.cursor.line.id);
    expect((await s.game.repo.getLine(s.cursor.line.id))!.nodeId).toBe(s.cursor.head.id);
    expect(await s.game.repo.path(s.cursor.head.id)).toEqual(oldPath);
    expect((await s.game.repo.path(revised.head.id)).map((n) => n.narrative)).toEqual([s.node.narrative, s.preview.narrative]);
    const state = await s.game.repo.getState(revised.head.id);
    expect(state.protagonist.stats.money).toBe(90);
    expect(state.time.elapsedMinutes).toBe(10);
    expect(state.facts?.[0]).toMatchObject({ origin: "correction", nodeId: revised.head.id });
    await tree.switchLine(s.game.repo, s.world.id, s.cursor.line.id);
    expect((await tree.cursor(s.game.repo, s.world.id)).head.id).toBe(s.cursor.head.id);
  });

  it("applies a cited prior correction without treating an AI mistake as an intentional branch", async () => {
    const s = await setup();
    s.preview.correctionPatch = { profile: { identity: "医者" }, people: [{ name: "阿青", role: "药铺医者" }] };
    const revised = await adoptCanonCorrection(s.game, s.preview), state = await s.game.repo.getState(revised.head.id);
    expect(state.protagonist.identity).toBe("医者");
    expect(state.people.find((p) => p.name === "阿青")?.role).toBe("药铺医者");
    expect(state.facts?.some((f) => f.origin === "branch")).toBe(false);
    expect(state.facts?.every((f) => f.citations.length)).toBe(true);
    expect((await s.game.repo.getState(s.target.id)).protagonist.identity).not.toBe("医者");
  });

  it.each(["source", "text", "line"] as const)("atomically rejects a late %s change without leaving a node or route", async (change) => {
    const s = await setup(), sql = s.game.platform.sql, batch = sql.batch.bind(sql);
    const count = async () => (await sql.query("SELECT COUNT(*) AS n FROM nodes"))[0].n;
    const before = await count(), lines = (await s.game.repo.lines(s.world.id)).length;
    vi.spyOn(sql, "batch").mockImplementationOnce(async (statements) => {
      if (change === "source") await batch([{ sql: "UPDATE states SET state_json=json_set(state_json,'$.source.instructions','新的用法') WHERE node_id=?", params: [s.cursor.head.id] }]);
      if (change === "text") await batch([{ sql: "UPDATE nodes SET narrative='玩家新改的文字' WHERE id=?", params: [s.target.id] }]);
      if (change === "line") await batch([{ sql: "UPDATE worlds SET current_line_id=NULL WHERE id=?", params: [s.world.id] }]);
      return batch(statements);
    });
    await expect(adoptCanonCorrection(s.game, s.preview)).rejects.toThrow();
    expect(await count()).toBe(before);
    expect((await s.game.repo.lines(s.world.id)).length).toBe(lines);
  });

  it("requires actual in-scope original citations and does not adopt an analysis-only claim", async () => {
    const s = await setup();
    s.preview.reference.passages = s.preview.reference.passages.map((p) => ({ ...p, kind: "analysis" }));
    await expect(adoptCanonCorrection(s.game, s.preview)).rejects.toThrow("原文出处");
    expect((await tree.cursor(s.game.repo, s.world.id)).head.id).toBe(s.cursor.head.id);
    s.preview.reference.passages = (await referenceContext(s.game.repo, newBinding(s.book.id, true), "玉佩", 3000))!.passages;
    s.preview.corrections[0].citations[0].quote = "玉佩是红色";
    await expect(adoptCanonCorrection(s.game, s.preview)).rejects.toThrow("原文出处");
  });

  it.each(["sourceSet", "executionSet", "setStats", "scriptSet", "challengeSet", "rules"])("rejects %s in a model correction patch", async (key) => {
    const s = await setup();
    s.preview.correctionPatch = { [key]: null } as TurnRecord;
    await expect(adoptCanonCorrection(s.game, s.preview)).rejects.toThrow("不能修改");
    expect((await tree.cursor(s.game.repo, s.world.id)).head.id).toBe(s.cursor.head.id);
  });

  it("normalizes the complete model record so settings cannot be smuggled into a revision", async () => {
    const s = await setup();
    s.preview.record = { ...s.preview.record, sourceSet: null, executionSet: "agent", setStats: { money: 999999 } } as TurnRecord;
    const revised = await adoptCanonCorrection(s.game, s.preview), state = await s.game.repo.getState(revised.head.id);
    expect(state.executionMode).toBe("classic");
    expect(state.source?.bookId).toBe(s.book.id);
    expect(state.protagonist.stats.money).toBe(90);
    expect(revised.head.record).not.toHaveProperty("executionSet");
    expect(revised.head.record).not.toHaveProperty("sourceSet");
    expect(revised.head.record).not.toHaveProperty("setStats");
  });

  it("creates a sibling opening root from its saved seed and treats its purse as absolute", async () => {
    const s = await setup(2, true), revised = await adoptCanonCorrection(s.game, s.preview);
    expect(revised.head.parentId).toBeNull(); expect(revised.head.kind).toBe("opening");
    expect((await s.game.repo.path(revised.head.id)).length).toBe(1);
    expect((await s.game.repo.getState(revised.head.id)).protagonist.stats.money).toBe(50);
    expect((await s.game.repo.getState(revised.head.id)).time.elapsedMinutes).toBe(0);
    expect((await s.game.repo.getState(s.node.id)).protagonist.stats.money).toBe(999);
    expect((await s.game.repo.getLine(s.cursor.line.id))!.nodeId).toBe(s.cursor.head.id);
  });

  it("blocks legacy openings until the player supplies a clean initial seed", async () => {
    const s = await setup(0, true, false);
    await expect(adoptCanonCorrection(s.game, s.preview)).rejects.toThrow(MISSING_OPENING_SEED);
    s.preview.baseline = openingBaseline(s.world, { name: "沈舟", gender: "男", age: "20", identity: "旅人", origin: "", date: "天宝七载冬月十七", money: "30文", place: "药铺", items: "火折子 × 1" });
    expect(s.preview.baseline.people).toEqual([]);
    expect(s.preview.baseline.protagonist.stats.money).toBe(30);
    const revised = await adoptCanonCorrection(s.game, s.preview);
    expect((await s.game.repo.getState(revised.head.id)).protagonist.name).toBe("沈舟");
    expect(revised.head.meta.openingSeed).toEqual(s.preview.baseline);
  });

  it("round-trips version four revisions, roots, fact/book references and execution snapshots under new IDs", async () => {
    const s = await setup(1, true), revised = await adoptCanonCorrection(s.game, s.preview);
    const file = await exportWorld(s.game.repo, s.world.id);
    expect(file.version).toBe(7); expect(file).not.toHaveProperty("runs"); expect(archiveProblems(file)).toEqual([]);
    const copy = await importWorld(s.game.repo, file, "new"), current = await tree.cursor(s.game.repo, copy), state = await s.game.repo.getState(current.head.id);
    const revision = current.head.meta.revision as { nodeId: string; lineId: string; corrections: CanonCorrectionPreview["corrections"] };
    expect(current.head.id).not.toBe(revised.head.id);
    expect(revision.nodeId).not.toBe(s.target.id);
    expect((await s.game.repo.getNode(revision.nodeId))!.worldId).toBe(copy);
    expect((await s.game.repo.getLine(revision.lineId))!.worldId).toBe(copy);
    expect(state.executionMode).toBe("classic");
    expect(state.facts?.[0].nodeId).toBe(current.head.id);
    expect(state.facts?.[0].citations[0].bookId).toBe(state.source?.bookId);
    expect(revision.corrections[0].citations[0].bookId).toBe(state.source?.bookId);
    expect((current.head.meta.openingSeed as typeof s.seed).source?.bookId).toBe(state.source?.bookId);
    expect(archiveProblems(await exportWorld(s.game.repo, copy))).toEqual([]);
  });
});
