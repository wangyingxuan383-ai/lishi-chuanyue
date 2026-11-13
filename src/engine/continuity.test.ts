import { describe, expect, it } from "vitest";
import { Game } from "./game";
import { createMemoryPlatform } from "../platform/memory";
import { sampleState } from "./testing/fixtures";
import { fakeLlm, type Script } from "./testing/fakeLlm";
import { DEFAULT_SETTINGS } from "./types";
import * as tree from "./tree";
import { appendContinuity, readContinuity, validateContinuity, continuityBlock, normalizeContinuity, type ContinuityChanges } from "./continuity";
import { archiveProblems, exportWorld, importWorld } from "./archive";
import { previewDurationCorrection } from "./calendar/manualTime";

async function fixture(scripts: Script[] = []) {
  const llm = fakeLlm(scripts), platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, { slot: "isolated", model: "fake", url: "http://127.0.0.1/v1/chat/completions", includeUsage: true });
  const state = sampleState(); state.version = 2; state.era = { mode: "free", packId: null, clockStyle: "elapsed" }; state.time = { start: "", elapsedMinutes: 0, startHour: 8 };
  state.people = [{ id: "person-a", name: "甲", aliases: ["阿甲"], role: "旅人", attitude: "一般", notes: "", alive: true, lastSeenMinute: 0 }];
  const { world } = await game.repo.createWorld({ title: "独立线索样本", eraId: "free", settings: { ...DEFAULT_SETTINGS, mode: "free", choiceCount: 0, chapterEvery: 0, autoUpkeep: false }, opening: { parentId: null, kind: "opening", narrative: "开篇，众人来到桥边。", state } });
  return { game, llm, world, cursor: await tree.cursor(game.repo, world.id) };
}
const knowledge = (awareness: "rumor" | "denied" = "rumor"): ContinuityChanges => ({ knowledge: [{ id: "secret", person: "阿甲", claim: "密信由乙所写", awareness, source: { from: "action", quote: `手动说明：甲${awareness === "rumor" ? "听说" : "否认"}密信由乙所写。` } }] });
const thread = (status: "open" | "resolved" = "open", recall = true): ContinuityChanges => ({ threads: [{ id: "letter", kind: "promise", title: "交还密信", detail: "约定明日交还密信", status, recall, source: { from: "action", quote: `手动说明：交还密信，状态${status}，提醒${recall}。` } }] });

describe("sparse sourced story records", () => {
  it("saves zero-model manual changes, undo and side routes see their own belief and thread state", async () => {
    const { game, world, cursor, llm } = await fixture();
    const before = await game.repo.getState(cursor.head.id);
    await appendContinuity(game, world.id, cursor.head.id, { ...knowledge(), ...thread("open", false) });
    const initial = await tree.cursor(game.repo, world.id);
    expect(initial.head.actionText!.length).toBeLessThan(60);
    const first = await readContinuity(game.repo, world.id, initial.head.id);
    expect(first.knowledge[0]).toMatchObject({ person: "person-a", personName: "甲", awareness: "rumor", historyCount: 1 });
    expect(first.threads[0]).toMatchObject({ status: "open", recall: false });
    expect(await game.repo.getState(initial.head.id)).toEqual(before);
    await appendContinuity(game, world.id, initial.head.id, { ...knowledge("denied"), ...thread("resolved") });
    const changed = await tree.cursor(game.repo, world.id);
    expect((await readContinuity(game.repo, world.id, changed.head.id)).knowledge[0]).toMatchObject({ awareness: "denied", historyCount: 2, originNodeId: initial.head.id });
    await tree.undo(game.repo, changed);
    expect((await readContinuity(game.repo, world.id, initial.head.id)).threads[0].status).toBe("open");
    const side = await game.repo.createLine(world.id, initial.head.id, "另一条路", false); await game.repo.setCurrentLine(world.id, side.id);
    expect((await readContinuity(game.repo, world.id, initial.head.id)).knowledge[0].awareness).toBe("rumor");
    expect(llm.calls).toHaveLength(0); expect(await game.platform.sql.query("SELECT * FROM usage")).toEqual([]);
  });
  it("roundtrips actual source node references in format seven and never mixes another story", async () => {
    const { game, world, cursor } = await fixture(); await appendContinuity(game, world.id, cursor.head.id, knowledge());
    const file = await exportWorld(game.repo, world.id); expect(archiveProblems(file)).toEqual([]);
    const copied = await importWorld(game.repo, file, "new"), current = await tree.cursor(game.repo, copied), view = await readContinuity(game.repo, copied, current.head.id);
    expect(view.knowledge[0].source.nodeId).toBe(current.head.id); expect(view.knowledge[0].source.nodeId).not.toBe((await tree.cursor(game.repo, world.id)).head.id);
    await expect(readContinuity(game.repo, copied, cursor.head.id)).rejects.toThrow("路线");
    const again = await exportWorld(game.repo, copied); expect(archiveProblems(again)).toEqual([]);
  });
  it("rejects foreign quotations and changed actor identity, and stale manual changes do not append", async () => {
    const { game, world, cursor } = await fixture(); await appendContinuity(game, world.id, cursor.head.id, knowledge());
    const head = (await tree.cursor(game.repo, world.id)).head, state = await game.repo.getState(head.id);
    await expect(appendContinuity(game, world.id, cursor.head.id, thread())).rejects.toThrow("故事已变化");
    const bad = knowledge(); bad.knowledge![0].source = { from: "narrative", nodeId: cursor.head.id, quote: "不存在的密信引文" };
    await expect(validateContinuity(game.repo, world.id, head.id, "new", "", "", state, bad, true)).rejects.toThrow("引文不存在");
    const other = knowledge(); other.knowledge![0].person = "protagonist";
    await expect(validateContinuity(game.repo, world.id, head.id, "new", "", other.knowledge![0].source.quote, state, other, true)).rejects.toThrow("人物");
    expect((await tree.cursor(game.repo, world.id)).head.id).toBe(head.id);
    const missingHistory = await validateContinuity(game.repo, world.id, "unavailable", "new", "", "", state, knowledge(), false);
    expect(missingHistory.changes).toEqual({}); expect(missingHistory.issues.join()).toContain("历史资料未能校对");
  });
  it("keeps changed old quotations exportable but unverified until the original passage is restored", async () => {
    const { game, world, cursor } = await fixture();
    const changes = knowledge(); changes.knowledge![0].source = { from: "narrative", nodeId: cursor.head.id, quote: "众人来到桥边" };
    await game.platform.sql.batch([{ sql: "UPDATE nodes SET record_json=? WHERE id=?", params: [JSON.stringify({ continuity: changes }), cursor.head.id] }]);
    expect((await readContinuity(game.repo, world.id, cursor.head.id)).knowledge).toHaveLength(1);
    await game.repo.updateNarrative(cursor.head.id, "开篇，众人留在城内。");
    expect((await readContinuity(game.repo, world.id, cursor.head.id)).ignoredEvents).toBe(1);
    const file = await exportWorld(game.repo, world.id); expect(archiveProblems(file)).toEqual([]);
    const copy = await importWorld(game.repo, file, "new"), head = (await tree.cursor(game.repo, copy)).head;
    expect((await readContinuity(game.repo, copy, head.id)).knowledge).toEqual([]);
    expect((await readContinuity(game.repo, copy, head.id)).ignoredEvents).toBe(1);
    await game.repo.restoreNarrative(cursor.head.id);
    expect((await readContinuity(game.repo, world.id, cursor.head.id)).knowledge).toHaveLength(1);
  });
  it("recall is bounded and excludes resolved or hidden threads; malformed metadata stays optional", () => {
    const issues: string[] = []; expect(normalizeContinuity({ knowledge: "not a list" }, issues)).toEqual({}); expect(issues.length).toBeGreaterThan(0);
    const block = continuityBlock({ worldId: "w", headId: "n", ignoredEvents: 0, knowledge: [], threads: Array.from({ length: 1000 }, (_, i) => ({ ...thread(i === 0 ? "resolved" : "open", i !== 1).threads![0], id: String(i), title: `线索${i}`, nodeId: "n", originNodeId: "n", historyCount: 1 })) }, "线索2", 500);
    expect(block.length).toBeLessThanOrEqual(500); expect(block).not.toContain("线索0："); expect(block).not.toContain("线索1："); expect(block).toContain("线索2");
  });
});
