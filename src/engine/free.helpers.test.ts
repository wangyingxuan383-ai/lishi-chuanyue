import { describe, expect, it } from "vitest";
import { agoText, newYearsBetween, nowOf, timeOfDay, timeRows } from "./calendar/clock";
import { eraContext, GENERIC_CURRENCY } from "./era";
import { askMessages } from "./prompt/ask";
import { codexMessages, codexPatch, codexSummary } from "./prompt/codex";
import { upkeepMessages, upkeepPatch } from "./prompt/upkeep";
import { applyRecord } from "./state/apply";
import { sampleState } from "./testing/fixtures";
import { DEFAULT_SETTINGS } from "./types";

function freeState() {
  const state = sampleState();
  state.era.mode = "free";
  state.cards = [{ id: "world-card", kind: "时代", name: "星海", keys: [], content: "众人用星币交易。", source: "玩家" }];
  return state;
}

describe("free world helpers and auxiliary prompts", () => {
  it("takes mode from the snapshot and never falls back to a Tang pack, even for v1", () => {
    const state = freeState();
    const era = eraContext("tang-748", state);
    expect(era).toMatchObject({ mode: "free", packId: null, title: "星海", currency: GENERIC_CURRENCY });
    expect(era.eraCard?.id).toBe("world-card");
    expect(era.clock).toMatchObject({ date: null, clockStyle: "elapsed", rules: { lunar: false } });
    state.cards = [];
    expect(eraContext("tang-748", state).eraCard).toBeNull();
    expect(eraContext("free", sampleState()).mode).toBe("history");
    expect(eraContext("tang-748", sampleState()).eraCard?.source).toBe("卡组");
  });

  it("counts elapsed days across midnight, with modern times and no automatic ages", () => {
    const state = freeState();
    state.time.startHour = 23;
    const clock = eraContext("tang-748", state).clock;
    expect(nowOf(clock, 0).text).toBe("第 1 天 · 23:00");
    expect(nowOf(clock, 90).text).toBe("第 2 天 · 00:30");
    expect(timeOfDay(nowOf(clock, 90))).toBe("00:30");
    expect(timeRows(clock, 90)).toEqual([
      { label: "日期", value: "第 2 天" }, { label: "时间", value: "00:30" }, { label: "开局", value: "已过 1 天" },
    ]);
    expect(agoText(clock, 0, 90)).toBe("昨天");
    // An explicitly chosen calendar still does not impose 虚岁 in free mode.
    state.era.clockStyle = "era";
    state.time.date = { era: "公元", year: 2000, month: 12, day: 31, lunar: false, ceYear: 2000 };
    const dated = eraContext(null, state).clock;
    expect(nowOf(dated, 1440).date?.year).toBe(2001);
    expect(newYearsBetween(dated, 0, 1440)).toBe(0);
  });

  it("rejects history effects at apply time while retaining money, people, cards and elapsed time", () => {
    const state = freeState();
    state.era.currency = { units: [{ name: "星币", value: 1 }] };
    state.timeline = [{ id: "legacy-event", title: "旧事件", date: "天宝八载正月", atMinute: 30, kind: "可变" }];
    state.deviations = ["原有记录"];
    // Deliberately pass a history clock to verify that state.mode is authoritative.
    const history = sampleState();
    history.time.date = { era: "天宝", year: 7, month: 12, day: 29, ceYear: 748, lunar: true };
    const out = applyRecord(state, {
      time: "两天", money: "-5星币", items: [{ name: "电池", delta: 1 }], people: [{ name: "阿洛", role: "领航员" }],
      deviation: "改写历史", timeline: [{ op: "remove", id: "legacy-event" }, { op: "add", date: "天宝八载正月", title: "不该生成" }],
      cards: [{ op: "add", kind: "时代", name: "远航", content: "航行中的世界。" }],
    }, { mode: "do", difficulty: "标准", currency: state.era.currency, clock: eraContext("tang-748", history).clock });
    expect(out.state.protagonist).toMatchObject({ age: 22, stats: { money: 295 }, items: [expect.objectContaining({ name: "电池" })] });
    expect(out.state.people[0].name).toBe("阿洛");
    expect(out.state.cards).toHaveLength(1);
    expect(out.state.cards[0]).toMatchObject({ id: "world-card", kind: "时代", name: "远航" });
    expect(out.state.timeline).toEqual(state.timeline);
    expect(out.state.deviations).toEqual(state.deviations);
    expect(out.chips.map((c) => c.text).join("\n")).not.toMatch(/历史|史书|过年/);
    expect(state.cards[0].name).toBe("星海");
    expect(applyRecord(state, { time: 90 }, { mode: "do", difficulty: "标准", currency: GENERIC_CURRENCY }).chips[0].text).toBe("过了 1 小时 30 分钟");
  });

  it("organizes a world card, preserves its identity and player ownership, drops unsolicited timeline", () => {
    const state = freeState();
    const input = { premise: "星际航行", protagonist: state.protagonist, arrival: "不穿越" };
    const system = codexMessages({ ...input, mode: "free" })[0].content;
    expect(system).toContain("世界卡");
    expect(system).toContain("不生成年表");
    expect(system).not.toMatch(/历史互动|时代卡|不要出现：|史书记载/);
    expect(codexMessages(input)[0].content).toContain("历史互动小说");
    const raw = JSON.stringify({ era: { content: "新世界资料" }, timeline: [{ title: "未来灾难", date: "天宝八载正月" }] });
    expect(codexPatch(raw, state)).toBeNull();
    const patch = codexPatch(raw, state, { replaceOwnEra: true })!;
    expect(patch.timeline).toBeUndefined();
    expect(patch.cards?.[0]).toMatchObject({ kind: "时代", name: "世界" });
    expect(codexSummary(patch, state)).toBe("AI 整理了设定集：世界卡");
    // The same reply for a history world keeps its great events for the 记事 page.
    expect(codexPatch(raw, sampleState())?.timeline).toHaveLength(1);
  });

  it("upkeep uses the world card and retains factual memory without era vocabulary or future events", () => {
    const state = freeState();
    const input = { premise: "星际航行", state, turns: [{ actionText: "交谈", narrative: "阿洛是领航员。" }], taboos: "测试历史禁词" };
    const messages = upkeepMessages(input).map((m) => m.content).join("\n");
    expect(messages).toContain("【世界卡】星海");
    expect(messages).toContain("不输出 timeline、deviation");
    expect(messages).not.toMatch(/历史互动|这个时代|测试历史禁词|官署/);
    const raw = JSON.stringify({ people: [{ name: "阿洛", role: "领航员" }], cards: [{ kind: "设定", name: "跃迁", content: "需充能" }], timeline: [{ date: "天宝八载", title: "未来" }], deviation: "改史" });
    const patch = upkeepPatch(raw, state)!;
    expect(patch.people?.[0].name).toBe("阿洛");
    expect(patch.cards?.[0].name).toBe("跃迁");
    expect(patch.timeline).toBeUndefined();
    expect(patch.deviation).toBeUndefined();
    expect(upkeepMessages({ ...input, state: sampleState() })[0].content).toContain("历史互动小说");
  });

  it("answers from the snapshot's mode and marks outside knowledge, keeping saved facts intact", () => {
    const state = freeState();
    const before = structuredClone(state);
    const input = { question: "用什么钱？", state, era: eraContext("tang-748", state), settings: { ...DEFAULT_SETTINGS, mode: "history" as const }, chapters: [], history: [], pins: ["阿洛欠你三枚星币"] };
    const [system, user] = askMessages(input);
    expect(system.content).not.toMatch(/历史互动|历史知识|官品/);
    expect(system.content).toContain("【仅供参考】");
    expect(system.content).toContain("不输出 timeline、deviation");
    expect(user.content).toContain("【世界卡】星海");
    expect(user.content).not.toContain("【时代卡】");
    expect(user.content).toContain("阿洛欠你三枚星币");
    expect(state).toEqual(before);
    expect(askMessages({ ...input, state: sampleState() })[0].content).toContain("历史知识");
    state.protagonist.panel = "能在水下呼吸";
    expect(askMessages({ ...input, settings: { ...input.settings, heroPanelEnabled: true } })[1].content).toContain("能在水下呼吸");
    expect(askMessages({ ...input, settings: { ...input.settings, heroPanelEnabled: false } })[1].content).not.toContain("能在水下呼吸");
  });
});
