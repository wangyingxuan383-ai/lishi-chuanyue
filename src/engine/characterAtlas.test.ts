import { describe, expect, it } from "vitest";
import { buildCharacterAtlas } from "./characterAtlas";
import { worldClock } from "./era";
import { sampleState } from "./testing/fixtures";
import type { Chapter, StoryNode, WorldState } from "./types";

let seq = 0;
function makeNode(fields: Partial<StoryNode>): StoryNode {
  seq++;
  return {
    id: `node-${seq}`,
    worldId: "w1",
    parentId: null,
    lastChildId: null,
    seq,
    kind: "turn",
    actionMode: "do",
    actionText: null,
    directorNote: null,
    narrative: "",
    record: null,
    choices: [],
    status: "ok",
    rewritten: false,
    fate: null,
    meta: {},
    createdAt: "2026-11-24T00:00:00Z",
    ...fields,
  };
}

function makeChapter(fields: Partial<Chapter>): Chapter {
  return {
    id: `ch-${++seq}`,
    worldId: "w1",
    firstNodeId: "",
    lastNodeId: "",
    title: "",
    gist: "",
    summary: "",
    model: null,
    promptVersion: null,
    edited: false,
    createdAt: "2026-11-24T00:00:00Z",
    ...fields,
  };
}

describe("characterAtlas", () => {
  it("computes debut/latest turns & dates, chapter indices, edit patches, and top-4 co-occurrences while ignoring interrupted nodes", () => {
    const base = sampleState();
    const state: WorldState = {
      ...base,
      time: { ...base.time, elapsedMinutes: 4 * 1440 },
      people: [
        { id: "p1", name: "王掌柜", aliases: ["老王"], role: "米铺掌柜", attitude: "友善", alive: true, notes: "", lastSeenMinute: 2880 },
        { id: "p2", name: "裴十二", aliases: ["裴校尉"], role: "不良帅", attitude: "生死之交", alive: true, notes: "", lastSeenMinute: 4320 },
        { id: "p3", name: "阿青", aliases: [], role: "书肆东家", attitude: "亲近", alive: true, notes: "", lastSeenMinute: 4320 },
        { id: "p4", name: "崔九", aliases: [], role: "牙人", attitude: "一般", alive: true, notes: "", lastSeenMinute: 2880 },
        { id: "p5", name: "胡商康某", aliases: ["康胡子"], role: "粟特胡商", attitude: "冷淡", alive: true, notes: "", lastSeenMinute: 2880 },
        { id: "p6", name: "孙主簿", aliases: [], role: "县衙主簿", attitude: "敌意", alive: true, notes: "", lastSeenMinute: 2880 },
      ],
    };

    const n0 = makeNode({
      kind: "opening",
      actionMode: null,
      narrative: "天宝七载冬月十七，你在西市米铺遇见王掌柜。",
    });
    const n1 = makeNode({
      kind: "turn",
      narrative: "老王引你去见裴十二与阿青，崔九和康胡子也在座。",
    });
    const nInterrupted = makeNode({
      kind: "turn",
      status: "interrupted",
      narrative: "孙主簿带着衙役闯入（本段中断，不应计入）。",
    });
    const n2 = makeNode({
      kind: "fastforward",
      actionMode: "skip",
      narrative: "两日后，裴校尉与阿青、老王、崔九再度聚首议事。",
    });
    const nEditOther = makeNode({
      kind: "edit",
      actionText: "调整铜钱与孙主簿字样",
      record: { money: 100 },
    });
    const nEditPeople = makeNode({
      kind: "edit",
      record: {
        people: [{ id: "p6", name: "孙主簿", note: "暗中调阅户籍" }],
      },
    });
    const n3 = makeNode({
      kind: "turn",
      narrative: "夜深风急，唯有裴十二一人执灯来访。",
      record: {
        people: [{ name: "阿青", note: "托裴十二捎来密信" }],
      },
    });

    const path = [n0, n1, nInterrupted, n2, nEditOther, nEditPeople, n3];
    const chapters = [
      makeChapter({ firstNodeId: n1.id, lastNodeId: n2.id, title: "西市暗流" }),
      makeChapter({ firstNodeId: nEditPeople.id, lastNodeId: n3.id, title: "夜半密信" }),
    ];

    const clock = worldClock("tang-748", state);
    const clocks = new Map<string, Pick<WorldState, "time" | "era">>([
      [n0.id, { time: { ...state.time, elapsedMinutes: 0 }, era: state.era }],
      [n1.id, { time: { ...state.time, elapsedMinutes: 1440 }, era: state.era }],
      [nInterrupted.id, { time: { ...state.time, elapsedMinutes: 1500 }, era: state.era }],
      [n2.id, { time: { ...state.time, elapsedMinutes: 3 * 1440 }, era: state.era }],
      [nEditPeople.id, { time: { ...state.time, elapsedMinutes: 3 * 1440 }, era: state.era }],
      [n3.id, { time: { ...state.time, elapsedMinutes: 4 * 1440 }, era: state.era }],
    ]);

    const atlas = buildCharacterAtlas({ state, path, chapters, clock, clocks });
    const byId = new Map(atlas.map((entry) => [entry.id, entry]));

    // 王掌柜: appeared in opening (turn 0, 楔子), n1 (turn 1, ch 1), n2 (turn 3 because nInterrupted was a turn node? Wait: let's check!)
    const wang = byId.get("p1")!;
    expect(wang.firstNodeId).toBe(n0.id);
    expect(wang.firstTurn).toBe(0);
    expect(wang.firstChapterTitle).toBe("楔子");
    expect(wang.firstDate).toContain("天宝七载");
    expect(wang.lastNodeId).toBe(n2.id);
    expect(wang.appearances).toBe(3);
    expect(wang.chapterIndices).toEqual([1]);

    // 裴十二: appeared in n1, n2, n3 (3 times across chapters 1 and 2); co-occurs with 阿青(3), 王掌柜(2), 崔九(2), 胡商康某(1) -> capped at top 4!
    const pei = byId.get("p2")!;
    expect(pei.firstNodeId).toBe(n1.id);
    expect(pei.firstChapterTitle).toBe("第一回　西市暗流");
    expect(pei.lastNodeId).toBe(n3.id);
    expect(pei.appearances).toBe(3);
    expect(pei.chapterIndices).toEqual([1, 2]);
    expect(pei.coOccurs).toEqual([
      { id: "p3", name: "阿青", count: 3 },
      { id: "p1", name: "王掌柜", count: 2 },
      { id: "p4", name: "崔九", count: 2 },
      { id: "p5", name: "胡商康某", count: 1 },
    ]);
    expect(pei.coOccurs).toHaveLength(4);

    // 阿青: matched in n3 via structured `record.people` even though narrative didn't repeat her name!
    const aqing = byId.get("p3")!;
    expect(aqing.appearances).toBe(3);
    expect(aqing.lastNodeId).toBe(n3.id);
    expect(aqing.chapterIndices).toEqual([1, 2]);

    // 孙主簿: interrupted node & unrelated edit ignored; matched only via `nEditPeople` people patch!
    const sun = byId.get("p6")!;
    expect(sun.appearances).toBe(1);
    expect(sun.firstNodeId).toBe(nEditPeople.id);
    expect(sun.chapterIndices).toEqual([2]);
    expect(sun.coOccurs).toEqual([]);
  });
});
