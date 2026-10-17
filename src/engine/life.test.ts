import { describe, expect, it } from "vitest";
import { eraContext } from "./era";
import { earnedSeals, excerpt, lifeSeal, lifeSummary, newSeals, playStats, realMinutes, realTimeText, richThreshold, spanText, type SealFacts } from "./life";
import { TANG_CURRENCY } from "./money";
import { sampleState } from "./testing/fixtures";
import type { StoryNode, WorldState } from "./types";

function rich(): WorldState {
  const s = sampleState(5000);
  s.time.elapsedMinutes = 40 * 1440;
  s.places = [{ id: "p1", name: "长安西市", description: "" }, { id: "p2", name: "平康坊", description: "" }];
  s.placeId = "p2";
  s.people = [
    { id: "a", name: "王掌柜", aliases: [], role: "", attitude: "友善", alive: true, notes: "", lastSeenMinute: null },
    { id: "b", name: "崔娘子", aliases: [], role: "", attitude: "冷淡", alive: false, notes: "", lastSeenMinute: null },
  ];
  s.goals = [
    { id: "g1", name: "考中进士", kind: "主线", progress: "", status: "进行中" },
    { id: "g2", name: "还清旧债", kind: "心愿", progress: "", status: "完成" },
  ];
  s.deviations = ["王掌柜没有死于火灾。"];
  return s;
}

const node = (patch: Partial<StoryNode>): StoryNode => ({
  id: Math.random().toString(36), worldId: "w", parentId: null, lastChildId: null, seq: 0, kind: "turn", actionMode: "do", actionText: "", directorNote: null,
  narrative: "", record: null, choices: [], status: "ok", rewritten: false, fate: null, meta: {}, createdAt: "2026-10-17T10:00:00.000Z", ...patch,
});

describe("lifeSummary", () => {
  const era = eraContext("tang-748", rich());
  it("writes origin, life span, places, people, goals, history and money from state", () => {
    const life = lifeSummary({ state: rich(), clock: era.clock, currency: era.currency, eraTitle: "盛唐", dead: false });
    const text = life.prose;
    expect(life.name).toBe("李安");
    expect(text).toContain("原是历史系研究生");
    expect(text).toContain("身为落第举子");
    expect(text).toContain("历时约 1 个月");
    expect(text).toContain("今年 22 岁");
    expect(text).toContain("到过长安西市、平康坊，共 2 处；如今在平康坊");
    expect(text).toContain("王掌柜（友善）");
    expect(text).toContain("已故的有崔娘子");
    expect(text).toContain("做成了还清旧债");
    expect(text).toContain("还在做的事：考中进士");
    expect(text).toContain("改变了 1 件史事：王掌柜没有死于火灾");
    expect(text).toContain("5 贯");
    expect(life.seal).toBe("未竟");
  });
  it("speaks of death in the past", () => {
    const life = lifeSummary({ state: rich(), clock: era.clock, currency: era.currency, eraTitle: "盛唐", dead: true });
    expect(life.prose).toContain("卒于");
    expect(life.prose).toContain("享年 22 岁");
    expect(life.prose).toContain("身后留下");
    expect(life.seal).toBe("殉身");
  });
  it("leaves out what the life does not have", () => {
    const s = sampleState();
    const life = lifeSummary({ state: s, clock: era.clock, currency: TANG_CURRENCY, eraTitle: "盛唐", dead: false });
    expect(life.sections.map((x) => x.label)).toEqual(["出身", "生平", "改史", "家产"]);
    expect(life.prose).toContain("史事还是书上写的样子");
  });
  it("turns an identity written to the player into the third person", () => {
    const s = sampleState();
    s.protagonist.identity = "你是开封府的一名小吏，家中只剩你一人。上官让你连夜誊抄名册。";
    expect(lifeSummary({ state: s, clock: era.clock, currency: TANG_CURRENCY, eraTitle: "北宋", dead: false }).prose).toContain("李安是开封府的一名小吏，家中只剩他一人。");
    expect(lifeSummary({ state: s, clock: era.clock, currency: TANG_CURRENCY, eraTitle: "北宋", dead: false }).prose).not.toContain("名册");
  });
});

describe("lifeSeal", () => {
  it("is 功成 when every main goal is done and the protagonist lives", () => {
    const s = rich();
    s.goals.push({ id: "g3", name: "娶妻", kind: "主线", progress: "", status: "完成" });
    expect(lifeSeal(s, false)).toBe("未竟");
    s.goals[0].status = "完成";
    expect(lifeSeal(s, false)).toBe("功成");
    expect(lifeSeal(s, true)).toBe("殉身");
  });
});

describe("spans and real time", () => {
  it("reads game time in days, months and years", () => {
    expect(spanText(100)).toBe("不到一天");
    expect(spanText(3 * 1440)).toBe("3 天");
    expect(spanText(400 * 1440)).toBe("1 年 1 个月");
    expect(spanText(365 * 1440)).toBe("1 年");
  });
  it("counts long pauses as ten minutes", () => {
    const times = ["2026-10-17T10:00:00Z", "2026-10-17T10:02:00Z", "2026-10-17T15:00:00Z"].map((createdAt) => ({ createdAt }));
    expect(realMinutes(times)).toBe(12);
    expect(realTimeText(12)).toBe("约 12 分钟");
    expect(realTimeText(135)).toBe("约 2 小时 15 分");
  });
  it("counts turns on the path, every route's turns and the modes most used", () => {
    const all = [node({ kind: "opening", actionMode: null }), node({ actionMode: "say" }), node({ actionMode: "say" }), node({ actionMode: "do" }), node({ kind: "edit", actionMode: "do" })];
    const stats = playStats({ path: all.slice(0, 3), all, lines: 2, gameMinutes: 60 });
    expect(stats.turns).toBe(2);
    expect(stats.allTurns).toBe(3);
    expect(stats.modes[0]).toEqual({ mode: "say", label: "说", count: 2 });
  });
});

describe("seals", () => {
  const facts = (state: WorldState, turns = 1, lines = 1): SealFacts => ({ state, turns, lines, currency: TANG_CURRENCY });
  it("a new life has only the first seal after one turn", () => {
    expect(earnedSeals(facts(sampleState(), 0))).toEqual([]);
    expect(earnedSeals(facts(sampleState())).map((s) => s.id)).toEqual(["arrive"]);
  });
  it("earns history, wish and time seals from state", () => {
    const s = rich();
    s.time.elapsedMinutes = 366 * 1440;
    s.protagonist.age = 61;
    const ids = earnedSeals(facts(s, 5, 3)).map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["change", "wish", "year", "sixty", "lines"]));
    expect(ids).not.toContain("turn");
    expect(ids).not.toContain("rich");
  });
  it("家财千金 is a thousand of the largest unit", () => {
    expect(richThreshold(TANG_CURRENCY)).toBe(1_000_000);
    expect(earnedSeals(facts(sampleState(1_000_000))).map((s) => s.id)).toContain("rich");
  });
  it("tells only about seals not shown before", () => {
    const s = rich();
    expect(newSeals(facts(s), ["arrive", "change", "wish"])).toBeNull();
    expect(newSeals(facts(s), ["arrive", "change"])?.text).toBe("得一枚印：“得偿所愿”");
    expect(newSeals(facts(s), [])?.ids).toEqual(["arrive", "wish", "change"]);
  });
});

describe("excerpt", () => {
  it("keeps short passages whole and cuts long ones at a sentence end", () => {
    expect(excerpt("一段。\n\n二段。")).toBe("一段。\n二段。");
    const long = "春风十里。".repeat(80);
    const cut = excerpt(long, 300);
    expect(cut.length).toBeLessThanOrEqual(300);
    expect(cut.endsWith("。")).toBe(true);
    expect(excerpt("无".repeat(400), 300)).toBe("无".repeat(300) + "……");
  });
});
