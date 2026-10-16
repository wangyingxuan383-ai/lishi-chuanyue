import { describe, expect, it } from "vitest";
import { TANG_CURRENCY, formatMoney, parseMoney } from "../money";
import { sampleState } from "../testing/fixtures";
import type { Difficulty, WorldState } from "../types";
import { applyRecord, type TurnRecord } from "./apply";
import { matchName } from "./names";

const ctx = (difficulty: Difficulty = "标准") => ({ mode: "do" as const, difficulty, currency: TANG_CURRENCY });
const apply = (s: WorldState, r: TurnRecord | null, d?: Difficulty) => applyRecord(s, r, ctx(d));
const chipTexts = (r: { chips: { text: string }[] }) => r.chips.map((c) => c.text);

describe("money", () => {
  it("formats and parses Tang coins", () => {
    expect(formatMoney(1200, TANG_CURRENCY)).toBe("1 贯 200 文");
    expect(formatMoney(0, TANG_CURRENCY)).toBe("0 文");
    expect(formatMoney(30, { units: [{ name: "", value: 1 }] })).toBe("30");
    expect(parseMoney("三贯二百文", TANG_CURRENCY)).toBe(3200);
    expect(parseMoney("-2文", TANG_CURRENCY)).toBe(-2);
    expect(parseMoney("一贯半", TANG_CURRENCY)).toBe(1500);
    expect(parseMoney(-30, TANG_CURRENCY)).toBe(-30);
    expect(parseMoney("若干", TANG_CURRENCY)).toBeNull();
  });
});

describe("names", () => {
  const people = [{ name: "孙管事", aliases: [] }, { name: "王掌柜", aliases: ["王老丈"] }];
  it.each(["孙管事", "管事孙某", "孙管事儿", " 孙 管事 "])("%s → 孙管事", (name) => {
    expect(matchName(people, name)?.name).toBe("孙管事");
  });
  it("does not merge different titles with the same surname", () => {
    expect(matchName(people, "孙掌柜")).toBeUndefined();
  });
  it("uses aliases", () => {
    expect(matchName(people, "王老丈")?.name).toBe("王掌柜");
  });
  it("matches long goal names by containment but not two-character fragments", () => {
    const goals = [{ name: "三日内还清三贯钱" }];
    expect(matchName(goals, "三日内还清三贯钱的债")?.name).toBe("三日内还清三贯钱");
    expect(matchName([{ name: "李安" }], "李")).toBeUndefined();
  });
});

describe("applyRecord", () => {
  it("advances time by the stated duration or a mode default", () => {
    expect(apply(sampleState(), { time: "半个时辰" }).state.time.elapsedMinutes).toBe(60);
    expect(apply(sampleState(), {}).state.time.elapsedMinutes).toBe(15);
    expect(applyRecord(sampleState(), null, { ...ctx(), mode: "continue" }).minutes).toBe(30);
  });

  it("spends and earns money with chips", () => {
    const r = apply(sampleState(300), { money: -6, items: [{ name: "胡饼", delta: 2 }] });
    expect(r.state.protagonist.stats.money).toBe(294);
    expect(r.state.protagonist.items[0]).toMatchObject({ name: "胡饼", quantity: 2 });
    expect(chipTexts(r)).toContain("钱 −6 文");
    expect(chipTexts(r)).toContain("得 胡饼×2");
  });

  it("cancels a purchase the player cannot afford (standard difficulty)", () => {
    const r = apply(sampleState(100), { money: "-八贯", items: [{ name: "青骢马", delta: 1 }] });
    expect(r.state.protagonist.stats.money).toBe(100);
    expect(r.state.protagonist.items).toHaveLength(0);
    expect(chipTexts(r)).toContain("钱不够，这笔没付成");
    expect(r.notes[0]).toContain("没有成交");
  });

  it("cancels unaffordable purchases on hard difficulty too", () => {
    const r = apply(sampleState(5), { money: -30, items: [{ name: "斗笠", delta: 1 }] }, "残酷");
    expect(r.state.protagonist.stats).toMatchObject({ money: 5, debt: 0 });
    expect(r.state.protagonist.items).toHaveLength(0);
    expect(chipTexts(r)).toContain("钱不够，这笔没付成");
  });

  it("never moves time backwards", () => {
    const s = sampleState();
    s.time.elapsedMinutes = 600;
    expect(apply(s, { time: -120 }).state.time.elapsedMinutes).toBe(615);
    expect(apply(s, { time: "-两个时辰" }).state.time.elapsedMinutes).toBeGreaterThanOrEqual(600);
  });

  it("keeps one goal across different phrasings", () => {
    let s = apply(sampleState(), { goals: [{ op: "add", name: "三日内还清三贯钱" }] }).state;
    for (const name of ["还清三贯钱", "三日内还清三贯钱的债", " 三日内 还清三贯钱 "]) {
      s = apply(s, { goals: [{ op: "add", name }, { op: "progress", name, detail: name }] }).state;
    }
    expect(s.goals).toHaveLength(1);
  });

  it("records debt on easy difficulty", () => {
    const r = apply(sampleState(10), { money: -30 }, "宽松");
    expect(r.state.protagonist.stats).toMatchObject({ money: 0, debt: 20 });
    expect(chipTexts(r)).toContain("钱不够，赊欠 20 文");
  });

  it("consumes only what exists", () => {
    const s = sampleState();
    s.protagonist.items.push({ name: "胡饼", quantity: 1, unit: "个", place: null, note: "" });
    const r = apply(s, { items: [{ name: "胡饼", delta: -3 }, { name: "银锭", delta: -1 }] });
    expect(r.state.protagonist.items).toHaveLength(0);
    expect(r.notes.join()).toContain("银锭");
  });

  it("moves an item to another place without changing its count, and gives items away", () => {
    const s = sampleState();
    s.protagonist.items.push({ name: "铜镜", quantity: 1, unit: "面", place: null, note: "" }, { name: "胡饼", quantity: 3, unit: "个", place: null, note: "" });
    const moved = apply(s, { items: [{ name: "铜镜", delta: 0, place: "邸店客房" }, { name: "胡饼", delta: -2 }] });
    expect(moved.state.protagonist.items).toEqual([
      expect.objectContaining({ name: "铜镜", quantity: 1, place: "邸店客房" }),
      expect.objectContaining({ name: "胡饼", quantity: 1 }),
    ]);
    expect(chipTexts(moved)).toEqual(expect.arrayContaining(["失 胡饼×2"]));
    expect(apply(moved.state, { items: [{ name: "铜镜", delta: 0, place: null }] }).state.protagonist.items[0].place).toBeNull();
  });

  it("merges people by name variants and never revives the dead", () => {
    let s = apply(sampleState(), { people: [{ name: "孙管事", role: "货栈管事", attitude: "冷淡" }] }).state;
    let r = apply(s, { people: [{ name: "管事孙某", attitude: "友善" }] });
    expect(r.state.people).toHaveLength(1);
    expect(r.state.people[0]).toMatchObject({ attitude: "友善", aliases: ["管事孙某"] });
    s = apply(r.state, { people: [{ name: "孙管事", alive: false }] }).state;
    r = apply(s, { people: [{ name: "孙管事", alive: true }] });
    expect(r.state.people[0].alive).toBe(false);
  });

  it("renames an unnamed person once their name is learned", () => {
    const s = apply(sampleState(), { people: [{ name: "货栈管事", role: "货栈管事" }] }).state;
    const r = apply(s, { people: [{ name: "刘三郎", aliases: ["货栈管事"] }] });
    expect(r.state.people).toHaveLength(1);
    expect(r.state.people[0]).toMatchObject({ name: "刘三郎", aliases: ["货栈管事"] });
    expect(chipTexts(r)).toContain("得知 货栈管事 名叫 刘三郎");
  });

  it("adds and resolves statuses", () => {
    const s = apply(sampleState(), { status: [{ op: "add", name: "脚踝扭伤", detail: "一瘸一拐" }] }).state;
    expect(s.protagonist.statuses[0].name).toBe("脚踝扭伤");
    expect(apply(s, { status: [{ op: "remove", name: "脚踝扭伤" }] }).state.protagonist.statuses).toHaveLength(0);
  });

  it("creates goals only on add and ignores progress for unknown goals", () => {
    let s = apply(sampleState(), { goals: [{ op: "add", name: "三日内还清三贯钱" }] }).state;
    s = apply(s, { goals: [{ op: "add", name: "三日内还清三贯钱" }, { op: "progress", name: "三日内还清三贯钱", detail: "凑到一贯" }] }).state;
    expect(s.goals).toHaveLength(1);
    expect(s.goals[0].progress).toBe("凑到一贯");
    const r = apply(s, { goals: [{ op: "done", name: "考中进士" }] });
    expect(r.state.goals).toHaveLength(1);
    expect(r.log.join()).toContain("考中进士");
  });

  it("caps large stat swings and does not mutate the input", () => {
    const before = sampleState();
    const r = apply(before, { stats: { health: -90 } });
    expect(r.state.protagonist.stats.health).toBe(40);
    expect(before.protagonist.stats.health).toBe(80);
  });

  it("moves to a new place", () => {
    const r = apply(sampleState(), { place: "西市货栈" });
    expect(r.state.places[0].name).toBe("西市货栈");
    expect(r.state.placeId).toBe(r.state.places[0].id);
  });
});
