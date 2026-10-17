import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { exportWorld, importWorld } from "../archive";
import { Game } from "../game";
import { TANG_CURRENCY } from "../money";
import { sampleState } from "../testing/fixtures";
import * as tree from "../tree";
import { applyRecord, type TurnRecord } from "./apply";
import { matchName } from "./names";

const ctx = { mode: "do" as const, difficulty: "标准" as const, currency: TANG_CURRENCY };
const edit = { advanceTime: false };
const freeState = () => {
  const s = sampleState();
  Object.assign(s.era, { mode: "free" });
  return s;
};

describe("ledger keeps records without guessing transactions", () => {
  it.each(["通宝剑", "碎银剑", "开元通宝", "三百文"])("keeps %s without a separate money record", (name) => {
    const before = sampleState();
    const result = applyRecord(before, { items: [{ name, delta: 20 }] }, ctx);
    expect(result.state.protagonist.items).toEqual([expect.objectContaining({ name, quantity: 20 })]);
    expect(result.state.protagonist.stats.money).toBe(before.protagonist.stats.money);
    expect(result.log).toEqual([]);
    expect(before.protagonist.items).toEqual([]);
  });

  it("takes back what an unaffordable record gained and names it, so a real gift can be recorded again", () => {
    const before = sampleState(10);
    before.protagonist.items = [{ name: "旧钱袋", quantity: 1, unit: "", place: null, note: "" }];
    const result = applyRecord(before, {
      money: -20,
      items: [{ name: "胡饼", delta: 1 }, { name: "朋友赠的信", delta: 1 }, { name: "旧钱袋", delta: -1 }],
    }, ctx);
    // 钱不够就买不成: the bag never holds what the story was just told did not change hands.
    expect(result.state.protagonist.stats.money).toBe(10);
    expect(result.state.protagonist.items).toEqual([]);
    expect(result.chips.map((c) => c.text)).toContain("钱不够，这笔没付成，胡饼、朋友赠的信没到手");
    expect(result.notes).toEqual([expect.stringContaining("胡饼、朋友赠的信也没有记上")]);
    expect(result.notes[0]).toContain("本回合再记一次");
    expect(result.log).toEqual(expect.arrayContaining(["钱不够，未获得 胡饼", "钱不够，未获得 朋友赠的信"]));
    // A record that gains things without failing to pay is untouched.
    expect(applyRecord(sampleState(10), { money: -5, items: [{ name: "胡饼", delta: 1 }] }, ctx).state.protagonist.items).toHaveLength(1);
  });

  it("deduplicates only exact currency units with the same explicitly booked amount", () => {
    const result = applyRecord(sampleState(), {
      money: 2000,
      items: [{ name: "贯", delta: 2 }, { name: "缗", delta: 2 }, { name: "文", delta: 3 }, { name: "通宝剑", delta: 2000 }],
    }, ctx);
    expect(result.state.protagonist.stats.money).toBe(2300);
    expect(result.state.protagonist.items).toEqual([
      expect.objectContaining({ name: "文", quantity: 3 }),
      expect.objectContaining({ name: "通宝剑", quantity: 2000 }),
    ]);
    expect(result.log).toHaveLength(2);
  });

  it.each([undefined, null, 0, "若干", -5])("keeps currency items when money %s does not account for them", (money) => {
    const result = applyRecord(sampleState(), { money, items: [{ name: "文", delta: 20 }] }, ctx);
    expect(result.state.protagonist.items).toEqual([expect.objectContaining({ name: "文", quantity: 20 })]);
    expect(result.state.protagonist.stats.money).toBe(300 + (typeof money === "number" ? money : 0));
  });

  it("lets the player add, rename and consume physical coins", () => {
    const added = applyRecord(sampleState(), { items: [{ name: "开元通宝", set: { quantity: 3, unit: "枚", note: "纪念品" } }] }, ctx, edit);
    expect(added.log).toEqual([]);
    const renamed = applyRecord(added.state, { items: [{ name: "开元通宝", set: { name: "文" } }] }, ctx, edit);
    const consumed = applyRecord(renamed.state, { money: -2, items: [{ name: "文", delta: -2 }] }, ctx);
    expect(consumed.state.protagonist.items).toEqual([expect.objectContaining({ name: "文", quantity: 1, note: "纪念品" })]);
    expect(consumed.state.protagonist.stats.money).toBe(298);
  });
});

describe("person identities", () => {
  it.each([
    ["亚历山大", "亚历山大二世"],
    ["亚历山大二世", "亚历山大"],
  ])("keeps %s and %s separate", (first, second) => {
    const before = applyRecord(sampleState(), { people: [{ name: first, role: "原身份", note: "原近况" }] }, ctx).state;
    const result = applyRecord(before, { people: [{ name: second, role: "新人物", note: "新近况" }] }, ctx);
    expect(result.state.people).toHaveLength(2);
    expect(result.state.people[0]).toEqual(before.people[0]);
    expect(result.state.people[1]).toMatchObject({ name: second, role: "新人物", notes: "新近况", aliases: [] });
  });

  it("does not let an approximate alias merge a different person", () => {
    const before = applyRecord(sampleState(), { people: [{ name: "亚历山大", role: "父王" }] }, ctx).state;
    const result = applyRecord(before, { people: [{ name: "王子", aliases: ["亚历山大二世"], role: "王子" }] }, ctx);
    expect(result.state.people).toHaveLength(2);
    expect(result.state.people[0]).toEqual(before.people[0]);
  });

  it("keeps deliberate renaming through exact aliases and panel ids", () => {
    const first = applyRecord(sampleState(), { people: [{ name: "货栈管事", role: "管事" }] }, ctx).state;
    const learned = applyRecord(first, { people: [{ name: "刘三郎", aliases: ["货栈管事"] }] }, ctx).state;
    const renamed = applyRecord(learned, { people: [{ id: learned.people[0].id, name: "刘长安" }] }, ctx, edit).state;
    expect(renamed.people).toHaveLength(1);
    expect(renamed.people[0]).toMatchObject({ id: first.people[0].id, name: "刘长安", aliases: ["货栈管事", "刘三郎"] });
    const again = applyRecord(renamed, { people: [{ name: "刘三郎", note: "又见面了" }] }, ctx).state;
    expect(again.people).toHaveLength(1);
    expect(again.people[0]).toMatchObject({ name: "刘长安", notes: "又见面了" });
  });

  it("retains title normalization without enabling containment for people", () => {
    expect(matchName([{ name: "孙管事" }], "管事孙某", { partial: false })?.name).toBe("孙管事");
    expect(matchName([{ name: "亚历山大" }], "亚历山大二世", { partial: false })).toBeUndefined();
    expect(matchName([{ name: "三日内还清三贯钱" }], "还清三贯钱")?.name).toBe("三日内还清三贯钱");
  });
});

describe("free-world state boundaries", () => {
  it.each([undefined, edit])("ignores free-world calendar changes while accepting currency (edit: %s)", (opts) => {
    const before = freeState();
    before.time.date = { era: "天宝", year: 7, month: 11, day: 17, ceYear: 748, lunar: true };
    before.era.calendar = { lunar: true };
    const calendar = structuredClone(before.era.calendar);
    const currency = [{ name: "金币", value: 100 }, { name: "铜币", value: 1 }];
    const result = applyRecord(before, {
      rules: { date: { era: "星历", year: 300, month: 2, day: 1 }, lunar: false, currency },
    }, ctx, opts);
    expect(result.state.time.date).toEqual(before.time.date);
    expect(result.state.time.start).toBe(before.time.start);
    expect(result.state.era.calendar).toEqual(calendar);
    expect(result.state.era.currency?.units).toEqual(currency);
    expect(before.era.calendar).toEqual(calendar);
    expect(before.era.currency).toBeUndefined();
    expect(result.log).toEqual([]);
  });

  it.each([
    { date: null },
    { date: { era: "", year: 0 } },
    { lunar: false },
  ])("does not clear, validate or rewrite a free world's calendar: %j", (rules) => {
    const before = freeState();
    before.time.date = { era: "天宝", year: 7, month: 11, day: 17, ceYear: 748, lunar: true };
    before.era.calendar = { lunar: true };
    const result = applyRecord(before, { rules }, ctx, edit);
    expect(result.state).toEqual(before);
    expect(result.log).toEqual([]);
  });

  it("does not introduce calendar fields into a free world without them", () => {
    const before = freeState();
    const result = applyRecord(before, {
      rules: { lunar: true, date: { era: "天宝", year: 7, month: 1, day: 1 } },
    }, ctx, edit);
    expect(result.state).toEqual(before);
    expect(result.state.time).not.toHaveProperty("date");
    expect(result.state.era).not.toHaveProperty("calendar");
  });

  it.each([undefined, "history"])("retains calendar edits in history mode (%s)", (mode) => {
    const before = sampleState();
    if (mode) Object.assign(before.era, { mode });
    const result = applyRecord(before, {
      rules: { lunar: false, date: { era: "公元", year: 2026, month: 10, day: 17, ceYear: 2026 } },
    }, ctx, edit);
    expect(result.state.era.calendar?.lunar).toBe(false);
    expect(result.state.time.date).toMatchObject({ era: "公元", year: 2026, month: 10, day: 17, ceYear: 2026, lunar: false });
    expect(result.log).toEqual([]);
    expect(applyRecord(result.state, { rules: { date: null } }, ctx, edit).state.time.date).toBeNull();
  });

  it("allows an explicit NPC resurrection only in a free world", () => {
    for (const mode of [undefined, "history", "free"] as const) {
      const before = sampleState();
      if (mode) Object.assign(before.era, { mode });
      const dead = applyRecord(before, { people: [{ name: "阿青", alive: false }] }, ctx).state;
      const unchanged = applyRecord(dead, { people: [{ name: "阿青", note: "有人等待他归来" }] }, ctx).state;
      expect(unchanged.people[0].alive).toBe(false);
      const revived = applyRecord(unchanged, { people: [{ name: "阿青", alive: true, note: "复生了" }] }, ctx);
      expect(revived.state.people[0].alive).toBe(mode === "free");
      expect(revived.log).toHaveLength(mode === "free" ? 0 : 1);
      expect(dead.people[0].alive).toBe(false);
    }
  });

  it("accepts long-lived ages through the existing profile edit without changing history defaults", () => {
    const free = applyRecord(freeState(), { profile: { age: 5000 } }, ctx, edit);
    expect(free.state.protagonist.age).toBe(5000);
    expect(free.log).toEqual([]);
    const history = applyRecord(sampleState(), { profile: { age: 5000 } }, ctx, edit);
    expect(history.state.protagonist.age).toBe(22);
    expect(history.log).toEqual(["年龄 5000 不在 1～120 之间，没有生效"]);
    expect(applyRecord(free.state, { profile: { age: null } }, ctx, edit).state.protagonist.age).toBeNull();
    expect(applyRecord(free.state, { profile: { age: 8000 } }, ctx).state.protagonist.age).toBe(5000);
  });

  it("ages a free-world protagonist with each full year of play, without 虚岁 or New Year wording", () => {
    const before = freeState();
    before.protagonist.age = 5000;
    const year = applyRecord(before, { time: "一年" }, { ...ctx, mode: "skip" });
    expect(year.state.protagonist.age).toBe(5001);
    expect(year.chips.map((c) => c.text)).toEqual(["过了 1 年", "5001 岁了"]);
    expect(applyRecord(before, { time: "三个月" }, { ...ctx, mode: "skip" }).state.protagonist.age).toBe(5000);
    // An age the player left open stays open.
    before.protagonist.age = null;
    expect(applyRecord(before, { time: "一年" }, { ...ctx, mode: "skip" }).chips.map((c) => c.text)).toEqual(["过了 1 年"]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("still rejects invalid free-world age %s", (age) => {
    const result = applyRecord(freeState(), { profile: { age } }, ctx, edit);
    expect(result.state.protagonist.age).toBe(22);
    expect(result.log).toHaveLength(1);
  });

  it.each(["宽松", "标准", "残酷"] as const)("retains protagonist death rules on %s", (difficulty) => {
    const historic = sampleState();
    historic.protagonist.stats.health = 10;
    const free = structuredClone(historic);
    Object.assign(free.era, { mode: "free" });
    // Keep this assertion about death rules, independent of mode-specific time labels.
    const record = { time: 1, died: true, stats: { health: -20 } };
    const a = applyRecord(historic, record, { ...ctx, difficulty });
    const b = applyRecord(free, record, { ...ctx, difficulty });
    expect(b.state.protagonist).toEqual(a.state.protagonist);
    expect(b.chips).toEqual(a.chips);
    expect(b.notes).toEqual(a.notes);
    const second = applyRecord(b.state, record, { ...ctx, difficulty });
    expect(second.state.protagonist).toEqual(applyRecord(a.state, record, { ...ctx, difficulty }).state.protagonist);
  });

  it("stores panel text verbatim only through edits, without interpreting stats", () => {
    const before = freeState();
    const panel = "  境界：筑基\n寿命：九千岁；健康：0；金钱：99999  ";
    const patch: TurnRecord = { profile: { panel } };
    const edited = applyRecord(before, patch, ctx, edit);
    expect(edited.state.protagonist).toEqual({ ...before.protagonist, panel });
    expect(edited.state.time).toEqual(before.time);
    expect(before.protagonist).not.toHaveProperty("panel");
    const regular = applyRecord(edited.state, { profile: { panel: "AI 另写一版" } }, ctx);
    expect(regular.state.protagonist).toEqual(edited.state.protagonist);
    expect(applyRecord(edited.state, { profile: { panel: "" } }, ctx, edit).state.protagonist).toMatchObject({ panel: "" });
  });

  it("persists panel edits in snapshots with undo, redo, branch isolation and archive round trips", async () => {
    const platform = await createMemoryPlatform();
    const game = await Game.open(platform);
    const { world } = await game.repo.createWorld({
      title: "自由世界", eraId: "custom", opening: { parentId: null, kind: "opening", narrative: "开场", state: freeState() },
    });
    const before = await tree.cursor(game.repo, world.id);
    const edited = await game.editState(world.id, { profile: { panel: "境界：筑基", age: 500 } }, "修改主角面板");
    const state = await game.repo.getState(edited.head.id);
    expect(state.protagonist).toMatchObject({ panel: "境界：筑基", age: 500 });
    expect(edited.head.record).toMatchObject({ profile: { panel: "境界：筑基", age: 500 } });
    const oldLine = await game.repo.createLine(world.id, edited.head.id, "筑基", false);
    const undone = await tree.undo(game.repo, edited);
    expect(undone.head.id).toBe(before.head.id);
    expect((await game.repo.getState(undone.head.id)).protagonist).not.toHaveProperty("panel");
    const redone = await tree.redo(game.repo, undone);
    expect(await game.repo.getState(redone.head.id)).toEqual(state);
    await tree.undo(game.repo, redone);
    const other = await game.editState(world.id, { profile: { panel: "境界：金丹" } }, "另一条路");
    expect((await game.repo.getState(other.head.id)).protagonist).toMatchObject({ panel: "境界：金丹", age: 22 });
    await tree.switchLine(game.repo, world.id, oldLine.id);
    expect((await game.repo.getState((await tree.cursor(game.repo, world.id)).head.id)).protagonist).toMatchObject({ panel: "境界：筑基", age: 500 });
    const importedId = await importWorld(game.repo, await exportWorld(game.repo, world.id), "new");
    const imported = await tree.cursor(game.repo, importedId);
    expect(await game.repo.getState(imported.head.id)).toEqual(state);
    const restarted = await Game.open(await createMemoryPlatform(undefined, { data: platform.exportDb() }));
    expect(await restarted.repo.getState(imported.head.id)).toEqual(state);
  });
});
