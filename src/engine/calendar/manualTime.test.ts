import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { Game } from "../game";
import { sampleState } from "../testing/fixtures";
import { eraContext, worldClock } from "../era";
import { applyRecord } from "../state/apply";
import { exportWorld, importWorld } from "../archive";
import * as tree from "../tree";
import { nowOf, timeRows } from "./clock";
import { previewDurationCorrection } from "./manualTime";

async function setup() {
  const game = await Game.open(await createMemoryPlatform());
  const state = sampleState(); state.version = 2;
  state.era = { mode: "free", clockStyle: "elapsed", packId: null, calendar: { lunar: false } };
  state.time = { start: "", startHour: 8, elapsedMinutes: 4054 * 1440 + 5 };
  state.challenge = { goal: "会合", limit: "十天", deadlineMinute: state.time.elapsedMinutes + 14400, failIf: "", progress: "", status: "active", startedMinute: state.time.elapsedMinutes };
  const { world } = await game.repo.createWorld({ title: "独立时间样本", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "开场", state } });
  return { game, world, state, cursor: await tree.cursor(game.repo, world.id) };
}
const context = (state: ReturnType<typeof sampleState>) => ({ mode: "continue" as const, difficulty: "标准" as const, currency: eraContext(null, state).currency, clock: eraContext(null, state).clock });

describe("manual time management without a model", () => {
  it("calibrates days, crosses midnight, preserves the true axis, and survives undo and archive", async () => {
    const { game, world, state, cursor } = await setup();
    const edited = await game.editState(world.id, { rules: { clock: { clockStyle: "elapsed", timeStyle: "24h", elapsedAnchor: { atElapsedMinutes: state.time.elapsedMinutes, day: 100, minuteOfDay: 1430 } } } }, "手动校时", undefined, cursor.head.id);
    expect((await game.repo.getNode(cursor.head.id))?.lastChildId).toBe(edited.head.id);
    const clocks = await game.repo.clocksOnPath(edited.head.id), old = clocks.get(cursor.head.id)!;
    expect(nowOf(worldClock(null, old), old.time.elapsedMinutes).text).toBe("第 4055 天 · 08:05");
    const saved = await game.repo.getState(edited.head.id), clock = eraContext(null, saved).clock;
    expect(nowOf(clock, saved.time.elapsedMinutes).text).toBe("第 100 天 · 23:50");
    expect(nowOf(clock, saved.time.elapsedMinutes + 20)).toMatchObject({ day: 4055, displayDay: 101, text: "第 101 天 · 00:10" });
    expect(saved.time.elapsedMinutes).toBe(state.time.elapsedMinutes);
    expect(saved.protagonist.age).toBe(state.protagonist.age);
    expect(saved.challenge).toEqual(state.challenge);
    expect(timeRows(clock, saved.time.elapsedMinutes)).toContainEqual({ label: "开局", value: "已过 4054 天" });
    expect((await game.repo.getState((await tree.undo(game.repo, edited)).head.id)).time.elapsedAnchor).toBeUndefined();
    await tree.redo(game.repo, await tree.cursor(game.repo, world.id));
    const copy = await importWorld(game.repo, await exportWorld(game.repo, world.id), "new");
    const imported = await game.repo.getState((await tree.cursor(game.repo, copy)).head.id);
    expect(nowOf(eraContext(null, imported).clock, imported.time.elapsedMinutes).text).toBe("第 100 天 · 23:50");
    expect(await game.platform.sql.query("SELECT * FROM usage")).toEqual([]);
  });

  it("keeps both display mappings across style changes and rejects an invalid mixed edit atomically", async () => {
    const { game, world, state, cursor } = await setup();
    const first = await game.editState(world.id, { rules: { clock: { elapsedAnchor: { atElapsedMinutes: state.time.elapsedMinutes, day: 100, minuteOfDay: 500 } } } }, "日序校准", undefined, cursor.head.id);
    const dated = await game.editState(world.id, { rules: { clock: { clockStyle: "era", anchor: { atElapsedMinutes: state.time.elapsedMinutes, date: { era: "斗罗历", year: 10015, month: 12, day: 31, ceYear: null, lunar: false }, minuteOfDay: 1430 } } } }, "纪年校准", undefined, first.head.id);
    const eraState = await game.repo.getState(dated.head.id);
    expect(nowOf(eraContext(null, eraState).clock, state.time.elapsedMinutes + 20).text).toBe("斗罗历10016年 1月1日 · 子时");
    const counted = await game.editState(world.id, { rules: { clock: { clockStyle: "elapsed" } } }, "切回日序", undefined, dated.head.id);
    const countedState = await game.repo.getState(counted.head.id);
    expect(nowOf(eraContext(null, countedState).clock, state.time.elapsedMinutes).text).toBe("第 100 天 · 08:20");
    const before = await game.repo.getState(counted.head.id);
    await expect(game.editState(world.id, { rules: { currency: [{ name: "灵石", value: 1 }], clock: { elapsedAnchor: { atElapsedMinutes: 1, day: 0, minuteOfDay: 0 } } } }, "无效混合", undefined, counted.head.id)).rejects.toThrow("日序锚点");
    expect((await tree.cursor(game.repo, world.id)).head.id).toBe(counted.head.id);
    expect(await game.repo.getState(counted.head.id)).toEqual(before);
  });

  it("refuses stale or actively leased manual saves without creating an edit", async () => {
    const { game, world, cursor } = await setup();
    const changed = await game.editState(world.id, { profile: { identity: "行者" } }, "身份");
    await expect(game.editState(world.id, { rules: { clock: { timeStyle: "24h" } } }, "旧表单", undefined, cursor.head.id)).rejects.toThrow("故事已变化");
    await game.platform.sql.batch([{ sql: "INSERT INTO world_execution_leases VALUES(?,?,?,?,?,?)", params: [world.id, "isolated-active", "test", 1, Date.now(), Date.now() + 60000] }]);
    await expect(game.editState(world.id, { rules: { clock: { timeStyle: "shichen" } } }, "忙碌表单", undefined, changed.head.id)).rejects.toThrow("任务执行");
    expect((await tree.cursor(game.repo, world.id)).head.id).toBe(changed.head.id);
  });

  it("previews actual duration and creates a protected revision, keeping the old future intact", async () => {
    const { game, world, cursor } = await setup();
    let previous = await game.repo.getState(cursor.head.id), current = cursor;
    for (const [time, text] of [[10, "甲"], [20, "乙"]] as const) {
      const record = { time, money: 5, log: text };
      const result = applyRecord(previous, record, context(previous));
      current = await tree.append(game.repo, current, { kind: "turn", actionMode: "continue", narrative: text, record, state: result.state, status: "ok" }); previous = result.state;
    }
    const path = await game.repo.path(current.head.id), oldHead = current.head.id;
    const preview = await previewDurationCorrection(game, world.id, oldHead, path[1].id, "一年");
    expect(preview.result.state.protagonist.age).toBe(23);
    expect(preview.result.state.challenge?.status).toBe("lost");
    expect(preview.laterTurns).toBe(1);
    expect((await tree.cursor(game.repo, world.id)).head.id).toBe(oldHead);
    const revised = await game.correctDuration(preview);
    expect(revised.line.id).not.toBe(current.line.id);
    expect(revised.head.narrative).toBe("甲");
    expect((await game.repo.getLine(current.line.id))?.nodeId).toBe(oldHead);
    expect((await game.repo.getState(revised.head.id)).time.elapsedMinutes).toBe(preview.result.state.time.elapsedMinutes);
    expect((await game.repo.path(revised.head.id)).map(node => node.narrative)).toEqual(["开场", "甲"]);
    await expect(game.correctDuration(preview)).rejects.toThrow("故事已变化");
    expect(await game.platform.sql.query("SELECT * FROM usage")).toEqual([]);
  });
  it("invalidates a duration preview when settlement settings change without moving the head", async () => {
    const { game, world, cursor } = await setup();
    const state = await game.repo.getState(cursor.head.id), record = { time: 10 };
    const current = await tree.append(game.repo, cursor, { kind: "turn", actionMode: "continue", narrative: "等待", record, state: applyRecord(state, record, context(state)).state });
    const preview = await previewDurationCorrection(game, world.id, current.head.id, current.head.id, "一年");
    await game.repo.updateSettings(world.id, { ...(await game.repo.getWorld(world.id))!.settings, difficulty: "残酷" });
    await expect(game.correctDuration(preview)).rejects.toThrow("重新预演");
    expect((await tree.cursor(game.repo, world.id)).line.id).toBe(current.line.id);
  });

  it("matches changed person times by identity while preserving independent reordering and notes", async () => {
    const { game, world, cursor } = await setup();
    const base = await game.repo.getState(cursor.head.id);
    base.people = [
      { id: "person-a", name: "甲", aliases: [], role: "旅人", attitude: "一般", alive: true, notes: "旧事", lastSeenMinute: base.time.elapsedMinutes - 30 },
      { id: "person-b", name: "乙", aliases: [], role: "旅人", attitude: "一般", alive: true, notes: "旧事", lastSeenMinute: base.time.elapsedMinutes - 30 },
    ];
    await game.platform.sql.batch([{ sql: "UPDATE states SET state_json=? WHERE node_id=?", params: [JSON.stringify(base), cursor.head.id] }]);
    const record = { time: 10, people: [{ name: "甲", note: "会面" }] }, result = applyRecord(base, record, context(base));
    result.state.people.reverse(); result.state.people[0].notes = "保留的独立说明";
    const current = await tree.append(game.repo, cursor, { kind: "turn", actionMode: "continue", narrative: "会面", record, state: result.state });
    const preview = await previewDurationCorrection(game, world.id, current.head.id, current.head.id, "60分钟");
    expect(preview.result.state.people.map(person => person.id)).toEqual(["person-b", "person-a"]);
    expect(preview.result.state.people[0]).toMatchObject({ notes: "保留的独立说明", lastSeenMinute: base.time.elapsedMinutes - 30 });
    expect(preview.result.state.people[1].lastSeenMinute).toBe(base.time.elapsedMinutes + 60);
    const corrected = await game.correctDuration(preview);
    expect((await game.repo.getState(corrected.head.id)).people).toEqual(preview.result.state.people);
  });

});
