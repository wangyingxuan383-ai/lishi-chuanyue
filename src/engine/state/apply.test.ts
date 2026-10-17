import { describe, expect, it } from "vitest";
import { TANG_748 } from "../../content/eras/tang-748";
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

  it("formats and parses silver with copper", () => {
    const silver = { units: [{ name: "两", value: 1000 }, { name: "文", value: 1 }] };
    expect(formatMoney(3200, silver)).toBe("3 两 200 文");
    expect(parseMoney("三两二百文", silver)).toBe(3200);
    const weighed = { units: [{ name: "两", value: 1000 }, { name: "钱", value: 100 }, { name: "文", value: 1 }] };
    expect(formatMoney(3250, weighed)).toBe("3 两 2 钱 50 文");
    expect(parseMoney("二两五钱", weighed)).toBe(2500);
    expect(formatMoney(-3200, silver)).toBe("−3 两 200 文");
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

  it("keeps how a goal went, ends it with the time, and reopens it from the goals page", () => {
    let s = apply(sampleState(), { time: "一个时辰", goals: [{ op: "add", name: "三日内还清三贯钱", kind: "主线", detail: "欠王掌柜三贯" }] }).state;
    expect(s.goals[0]).toMatchObject({ kind: "主线", startedMinute: 120, steps: [{ minute: 120, text: "欠王掌柜三贯" }] });
    s = apply(s, { time: "一天", goals: [{ op: "progress", name: "还清三贯钱", detail: "凑到一贯" }, { op: "progress", name: "还清三贯钱", detail: "凑到一贯" }] }).state;
    const r = apply(s, { time: "一天", goals: [{ op: "done", name: "三日内还清三贯钱", detail: "还清了" }] });
    expect(r.chips.map((c) => c.text)).toContain("完成：三日内还清三贯钱");
    expect(r.state.goals[0]).toMatchObject({ status: "完成", progress: "还清了", endedMinute: 120 + 1440 * 2 });
    expect(r.state.goals[0].steps!.map((x) => x.text)).toEqual(["欠王掌柜三贯", "凑到一贯", "还清了"]);
    const reopened = applyRecord(r.state, { goals: [{ op: "reopen", id: r.state.goals[0].id, name: "" }] }, ctx(), { advanceTime: false }).state;
    expect(reopened.goals[0]).toMatchObject({ status: "进行中" });
    expect(reopened.goals[0].endedMinute).toBeUndefined();
  });

  it("marks the player's own wishes", () => {
    const r = applyRecord(sampleState(), { goals: [{ op: "add", name: "攒钱买一处宅子", kind: "心愿" }] }, ctx(), { advanceTime: false });
    expect(r.chips.map((c) => c.text)).toEqual(["新心愿：攒钱买一处宅子"]);
    expect(r.state.goals[0].kind).toBe("心愿");
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

  it("shows the fortune behind a risky action", () => {
    const r = applyRecord(sampleState(), { risk: { what: "说服掌柜赊账", result: "败" } }, { ...ctx(), fortune: "不顺" });
    expect(r.chips).toContainEqual({ text: "🎲 不顺 · 说服掌柜赊账 · 没成", tone: "loss" });
    expect(apply(sampleState(), { risk: { what: "说服掌柜赊账", result: "成" } }).chips.some((c) => c.text.startsWith("🎲"))).toBe(false);
  });

  it("moves to a new place", () => {
    const r = apply(sampleState(), { place: "西市货栈" });
    expect(r.state.places[0].name).toBe("西市货栈");
    expect(r.state.placeId).toBe(r.state.places[0].id);
  });

  it("grows the protagonist a year at each New Year (虚岁)", () => {
    const clock = { date: { era: "天宝", year: 7, month: 12, day: 29, ceYear: 748, lunar: true }, hour: 20, label: "", rules: TANG_748.calendar };
    const crossed = applyRecord(sampleState(), { time: "两天" }, { ...ctx(), clock });
    expect(crossed.state.protagonist.age).toBe(23);
    expect(crossed.chips.map((c) => c.text)).toContain("过年了，23 岁");
    expect(applyRecord(sampleState(), { time: "一个时辰" }, { ...ctx(), clock }).state.protagonist.age).toBe(22);
    expect(applyRecord(sampleState(), { time: "两天" }, ctx()).state.protagonist.age).toBe(22);
  });
});

describe("设定集 edits", () => {
  it("adds, updates and removes cards; a world keeps one era card", () => {
    let s = apply(sampleState(), { cards: [{ op: "add", kind: "势力", name: "天地会", keys: ["会党", "天地会", " "], content: " 反清 " }] }).state;
    expect(s.cards).toEqual([expect.objectContaining({ kind: "势力", name: "天地会", keys: ["会党"], content: "反清", source: "玩家" })]);
    s = apply(s, { cards: [{ op: "update", kind: "势力", name: "会党", content: "秘密结社" }] }).state;
    expect(s.cards[0].content).toBe("秘密结社");
    s = apply(s, { cards: [{ op: "add", kind: "时代", name: "唐", content: "一" }, { op: "add", kind: "时代", name: "唐朝", content: "二" }] }).state;
    expect(s.cards.filter((c) => c.kind === "时代")).toEqual([expect.objectContaining({ name: "唐朝", content: "二" })]);
    const r = apply(s, { cards: [{ op: "remove", id: s.cards[0].id }, { op: "remove", kind: "物品", name: "玉玺" }] });
    expect(r.state.cards.map((c) => c.name)).toEqual(["唐朝"]);
    expect(r.log).toContain("卡片“玉玺”不存在，删除已忽略");
  });

  it("edits place cards but keeps the current place", () => {
    const s = apply(sampleState(), { place: "西市" }).state;
    const r = apply(s, { places: [{ op: "update", name: "西市", aliases: ["西市场"], description: "胡商云集" }, { op: "add", name: "曲江池", description: "游赏" }, { op: "remove", id: s.placeId! }] });
    expect(r.state.places).toEqual([
      expect.objectContaining({ name: "西市", aliases: ["西市场"], description: "胡商云集" }),
      expect.objectContaining({ name: "曲江池", description: "游赏" }),
    ]);
    expect(r.log).toContain("“西市”是当前所在地，不能删除");
    expect(apply(r.state, { place: "西市场" }).state.placeId).toBe(s.placeId);
  });

  it("keeps the old name as a key after a rename, and never renames by alias", () => {
    let s = apply(sampleState(), { cards: [{ op: "add", kind: "势力", name: "天地会", keys: ["会党"], content: "反清" }], places: [{ op: "add", name: "鬼市", description: "夜市" }] }).state;
    s = apply(s, { cards: [{ op: "update", kind: "势力", name: "会党", content: "秘密结社" }] }).state;
    expect(s.cards[0]).toMatchObject({ name: "天地会", keys: ["会党"], content: "秘密结社" });
    s = apply(s, { cards: [{ op: "update", id: s.cards[0].id, name: "洪门", keys: ["会党"] }], places: [{ op: "update", id: s.places[0].id, name: "夜市" }] }).state;
    expect(s.cards[0]).toMatchObject({ name: "洪门", keys: ["会党", "天地会"] });
    expect(s.places[0]).toMatchObject({ name: "夜市", aliases: ["鬼市"] });
  });

  it("remembers deleted cards and places so the AI does not bring them back", () => {
    let s = apply(sampleState(), { cards: [{ op: "add", kind: "势力", name: "漕帮", content: "码头帮会", source: "AI" }], places: [{ op: "add", name: "鬼市", description: "夜里的市", source: "AI" }] }).state;
    expect(s.places[0].source).toBe("AI");
    s = apply(s, { cards: [{ op: "remove", id: s.cards[0].id }], places: [{ op: "remove", id: s.places[0].id }] }).state;
    expect(s.dismissed).toEqual(["漕帮", "鬼市"]);
  });
});

describe("people edits", () => {
  const edit = (s: WorldState, r: TurnRecord) => applyRecord(s, r, ctx(), { advanceTime: false });
  const met = () => apply(sampleState(), { time: "一个时辰", people: [{ name: "货栈管事", role: "货栈的管事", attitude: "冷淡" }] }).state;

  it("renames, replaces aliases and edits by id without counting as a meeting", () => {
    const s = met();
    const id = s.people[0].id;
    const later = apply(s, { time: "一天" }).state;
    const r = edit(later, { people: [{ id, name: "刘三郎", aliases: ["货栈管事", "刘管事"], role: "", attitude: "友善", note: "其实是主角的舅舅", alive: true }] });
    expect(r.state.people[0]).toMatchObject({ name: "刘三郎", aliases: ["货栈管事", "刘管事"], role: "", attitude: "友善", notes: "其实是主角的舅舅", lastSeenMinute: s.people[0].lastSeenMinute });
    // Renamed without listing the old name: it is kept as an alias anyway.
    expect(edit(later, { people: [{ id, name: "刘三郎" }] }).state.people[0].aliases).toEqual(["货栈管事"]);
    expect(apply(r.state, { people: [{ name: "刘管事", attitude: "亲近" }] }).state.people).toHaveLength(1);
  });

  it("removes a person by id and remembers the name", () => {
    const s = met();
    const r = edit(s, { people: [{ id: s.people[0].id, op: "remove", name: "货栈管事" }, { id: "nobody", name: "无名氏" }] });
    expect(r.state.people).toEqual([]);
    expect(r.state.dismissed).toEqual(["货栈管事"]);
    expect(r.log).toContain("人物“无名氏”不存在，修改已忽略");
  });
});

describe("rules edits", () => {
  it("changes currency units, keeping aliases that still fit", () => {
    const s = sampleState();
    s.era.currency = { units: [{ name: "贯", value: 1000 }, { name: "文", value: 1 }], aliases: { 缗: "贯", 钱: "文" } };
    const r = apply(s, { rules: { currency: [{ name: "两", value: 1000 }, { name: "文", value: 1 }] } });
    expect(r.state.era.currency).toEqual({ units: [{ name: "两", value: 1000 }, { name: "文", value: 1 }], aliases: { 钱: "文" } });
    const bad = apply(s, { rules: { currency: [{ name: "两", value: 1000 }, { name: "钱", value: 300 }, { name: "文", value: 1 }] } });
    expect(bad.state.era.currency).toEqual(s.era.currency);
    expect(bad.log).toContain("货币设置没有生效：“两”不是“钱”的整数倍");
  });

  it("sets the start date and calendar style", () => {
    const s = apply(sampleState(), { rules: { date: { era: "景和", year: 3, month: 3, day: 5 } } }).state;
    expect(s.time).toMatchObject({ start: "景和三年 三月初五", date: { era: "景和", year: 3, month: 3, day: 5, ceYear: null, lunar: true } });
    const western = apply(s, { rules: { lunar: false } }).state;
    expect(western.era.calendar).toEqual({ lunar: false });
    expect(western.time.date?.lunar).toBe(false);
    const r = apply(s, { rules: { date: { era: "景和", year: 0, month: 3 } } });
    expect(r.state.time.date).toEqual(s.time.date);
    expect(r.log).toContain("开局日期写得不完整，没有生效");
  });
});
