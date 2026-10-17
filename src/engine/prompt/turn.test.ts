import { describe, expect, it } from "vitest";
import { eraContext } from "../era";
import { sampleState } from "../testing/fixtures";
import { DEFAULT_SETTINGS, type Chapter, type Person, type StoryNode } from "../types";
import { assistMessages, buildTurnContext, continueMessages, extractMessages, openingExtractMessages, openingMessages, renderState, turnMessages, type OpeningInput, type TurnPromptInput } from "./turn";

const person = (name: string, notes: string, lastSeenMinute: number, extra: Partial<Person> = {}): Person =>
  ({ id: name, name, aliases: [], role: "坊里的人", attitude: "一般", alive: true, notes, lastSeenMinute, ...extra });

function userPrompt(people: Person[], recent: string, action = "四处看看") {
  const state = sampleState();
  state.people = people;
  const history = [{ kind: "turn", actionMode: "do", actionText: "进门", narrative: recent } as StoryNode];
  const messages = turnMessages({ era: eraContext("tang-748", state), settings: DEFAULT_SETTINGS, protagonistName: "李安", state, history, mode: "do", text: action });
  return messages[messages.length - 1].content;
}

describe("people in the turn prompt", () => {
  it("puts people in the scene first with their notes; others get one line", () => {
    const text = userPrompt([
      person("王掌柜", "催过三次房钱", 30),
      person("赵四", "替主角挡过一刀", 10, { aliases: ["赵大哥"] }),
      person("史思礼", "已被灭口", 5, { alive: false }),
    ], "赵大哥拍了拍你的肩膀。");
    const block = text.slice(text.indexOf("已知人物："), text.indexOf("进行中的目标"));
    expect(block.split("\n").slice(1, 4)).toEqual([
      "赵四（又称赵大哥）：坊里的人，对主角一般；替主角挡过一刀",
      "王掌柜：坊里的人，对主角一般",
      "史思礼：坊里的人，对主角一般，已死",
    ]);
  });

  it("shows the 来历 of someone in play before their latest notes", () => {
    const text = userPrompt([
      person("葛敬之", "暗中送药送粮", 30, { origin: "早年受主角相救，知恩图报" }),
      person("周氏", "发妻", 20, { origin: "发妻" }),
    ], "葛敬之和周氏都在药铺。");
    expect(text).toContain("葛敬之：坊里的人，对主角一般；来历：早年受主角相救，知恩图报；近况：暗中送药送粮");
    expect(text).toContain("周氏：坊里的人，对主角一般；发妻");
  });

  it("lists names only beyond thirty people", () => {
    const people = Array.from({ length: 33 }, (_, i) => person(`人物${i + 1}号`, "", i));
    const text = userPrompt(people, "街上人来人往。");
    expect(text).toContain("人物33号：坊里的人");
    expect(text).toContain("另有：人物3号、人物2号、人物1号");
  });
});

function turnInput(overrides: Partial<TurnPromptInput> = {}): TurnPromptInput {
  const state = sampleState();
  return { state, era: eraContext("tang-748", state), settings: { ...DEFAULT_SETTINGS }, protagonistName: "李安", history: [], mode: "do", text: "我只问价，不买。", ...overrides };
}

function openingInput(overrides: Partial<OpeningInput> = {}): OpeningInput {
  const turn = turnInput();
  return { era: turn.era, settings: turn.settings, protagonistName: "李安", protagonist: { name: "李安", gender: "男", age: 22, identity: "书店店主" }, arrival: "不穿越", origin: "", hint: "平静地整理新书", ...overrides };
}

const promptText = (messages: { content: string }[]) => messages.map((m) => m.content).join("\n");

describe("turn-16 player control and factual context", () => {
  it.each(["魂穿", "身穿", "投胎", "不穿越"] as const)("opens %s without a mandatory crisis, sequence or quest", (arrival) => {
    const input = openingInput({ arrival });
    const text = promptText(openingMessages(input));
    expect(text).toContain(input.hint);
    expect(text).toContain("需要玩家决定");
    expect(text).toContain("goals 只记玩家已明确的目标，没有就省略");
    expect(text).not.toMatch(/迫在眉睫|先写醒来|[1234]\. |写出第一个目标/);
    const extraction = promptText(openingExtractMessages({ ...input, text: "我在书店整理书架。" }));
    expect(extraction).not.toMatch(/第一个目标|迫在眉睫/);
    expect(extraction).toContain('time 写 "0"');
  });

  it.each(["do", "skip"] as const)("includes only past and present timeline entries for %s, without mutating the save", (mode) => {
    const input = turnInput({ mode, text: mode === "skip" ? "一年" : "听听消息" });
    input.state.time.elapsedMinutes = 1000;
    input.state.timeline = [
      { id: "past", date: "之前", title: "渡口已通航", atMinute: 999, kind: "可变" },
      { id: "now", date: "今日", title: "雨停", atMinute: 1000, kind: "固定" },
      { id: "soon", date: "明日", title: "城门将封", atMinute: 1001, kind: "固定" },
      { id: "later", date: "半年后", title: "王朝将亡", atMinute: 180 * 1440, kind: "可变" },
      { id: "unknown", date: "某日", title: "无日期事件", atMinute: null, kind: "固定" },
    ];
    input.state.deviations = ["玩家已经救下渡口守卫"];
    const saved = structuredClone(input.state);
    const context = buildTurnContext(input);
    const world = context.layers.find((l) => l.key === "world")!;
    expect(world.content).toContain("渡口已通航");
    expect(world.content).toContain("雨停");
    expect(world.content).toContain("玩家已经救下渡口守卫");
    expect(promptText(context.messages)).not.toMatch(/城门将封|王朝将亡|无日期事件|一定发生|日子过得越长/);
    expect(input.state).toEqual(saved);
  });

  it.each(["do", "say", "write", "continue", "direct", "skip"] as const)("keeps control, facts and record protocol in %s", (mode) => {
    const input = turnInput({ mode, directorNote: "只写其他人的反应", pins: ["店家欠我三文"] });
    const messages = turnMessages(input);
    const text = promptText(messages);
    for (const expected of ["不替主角添计划、约定、许诺、威胁或贿赂", "秘密、证据和底牌", "钱不够就付不起", "时间不倒退", "人物、物品、目标沿用", "店家欠我三文", "<record>", "</record>", '"died":', '"risk":', '"stats":']) expect(text).toContain(expected);
    if (mode !== "continue") expect(messages.at(-1)!.content).toContain(input.text);
    expect(messages.at(-1)!.content).toContain("只写其他人的反应");
    if (mode === "write") expect(text).toContain("视为已经发生，不要复述");
    if (mode === "continue" || mode === "direct") expect(text).toContain("主角不做新的决定");
    if (mode === "skip") expect(text).toContain("平静的日子可以过满");
    expect(text).not.toContain("不要用：指节泛白");
  });

  it("treats a missing mode exactly like history and keeps the fortune switch", () => {
    const input = turnInput({ fortune: "大不顺" });
    expect(turnMessages(input)).toEqual(turnMessages({ ...input, settings: { ...input.settings, mode: "history" } }));
    expect(promptText(turnMessages(input))).toContain("只作参考");
    expect(promptText(turnMessages({ ...input, settings: { ...input.settings, fortune: "off" } }))).not.toContain("运势");
    expect(promptText(turnMessages({ ...input, settings: { ...input.settings, fortune: "on" } }))).toContain("不翻转结果");
  });
});

describe("free mode prompt boundaries", () => {
  const settings: TurnPromptInput["settings"] = { ...DEFAULT_SETTINGS, mode: "free", clockStyle: "elapsed", fortune: "off" };
  const historical = /历史互动小说|【时代】|【用词提醒】|【天下大事】|【历史偏离|"deviation":|天宝|年号|农历|时辰|辰时|不要出现：|虚岁/;

  it("drops historical defaults even if the caller accidentally retains an era pack and reminders", () => {
    const input = turnInput({ settings, taboos: [{ term: "小时", instead: "时辰" }], mode: "skip", text: "三天" });
    input.state.timeline = [{ id: "a", date: "天宝七载", title: "预定改朝换代", atMinute: 0, kind: "固定" }];
    input.state.deviations = ["旧历史偏离"];
    const context = buildTurnContext(input);
    expect(promptText(context.messages)).not.toMatch(historical);
    expect(promptText(context.messages)).not.toMatch(/预定改朝换代|旧历史偏离/);
    expect(context.layers.find((l) => l.key === "world")!.content).toBe("");
    expect(context.layers.find((l) => l.key === "era")!.label).toBe("世界卡");
  });

  it("keeps the player's world card and rules verbatim without importing historical prohibitions", () => {
    const input = turnInput({ settings: { ...settings, rules: "对白使用现代口语" } });
    input.era = { ...input.era, eraCard: { id: "world", kind: "时代", name: "轨道城", content: "空气可交易。不要出现：读心魔法", keys: [], source: "玩家" } };
    const text = promptText(turnMessages(input));
    expect(text).toContain("【世界】轨道城");
    expect(text).toContain("空气可交易。不要出现：读心魔法");
    expect(text).toContain("对白使用现代口语");
    expect(text).not.toContain("人物对白带时代口吻");
  });

  it("keeps a free template's world card when it has no historical pack", () => {
    const input = turnInput({ settings });
    input.era = { ...input.era, packId: null, eraCard: { id: "free-template", kind: "时代", name: "浮空邮局", content: "信件靠风帆送达。", keys: [], source: "卡组" } };
    expect(promptText(turnMessages(input))).toContain("【世界】浮空邮局");
    expect(promptText(turnMessages(input))).toContain("信件靠风帆送达。");
  });

  it.each(["elapsed", "era"] as const)("uses elapsed days and HH:mm in free mode even with clockStyle=%s", (clockStyle) => {
    const input = turnInput();
    input.era = { ...input.era, clock: { ...input.era.clock, hour: 23 } };
    input.state.time.elapsedMinutes = 90;
    expect(renderState(input.state, input.era, undefined, { ...settings, clockStyle }).split("\n")[0]).toBe("【当前】第 2 天 00:30 · （未记录）");
    expect(renderState(input.state, input.era)).toContain("天宝");
    expect(renderState(input.state, input.era, undefined, { clockStyle: "elapsed" })).not.toContain("天宝");
  });

  it("uses the free protocol for generated openings, authored openings and fallback extraction", () => {
    const input = openingInput({ settings, protagonist: { name: "零", gender: "未指定", age: 0, identity: "初生人工智能" } });
    const turn = turnInput({ settings });
    turn.state.protagonist.age = 0;
    for (const messages of [openingMessages(input), openingExtractMessages({ ...input, text: "零第一次睁开眼。" }), extractMessages({ ...turn, action: "查看屏幕", narrative: "屏幕亮起。" })]) {
      const text = promptText(messages);
      expect(text).not.toMatch(historical);
      expect(text).toContain('"time"');
      expect(text).toContain('"choices"');
    }
    expect(promptText(openingMessages(input))).toContain("0岁");
    expect(promptText(turnMessages(turn))).toContain("0岁");
    expect(promptText(openingMessages(input))).not.toContain("本时代资料已定");
  });

  it.each([undefined, false, true])("includes the opaque hero panel only when enabled=%s, also under a tight budget", (heroPanelEnabled) => {
    const panel = "境界：随玩家设定\n技能：闪现（未评级）\n能量：∞";
    const s = { ...settings, heroPanelEnabled, heroPanel: panel };
    const input = turnInput({ settings: s, budgetChars: 1 });
    Object.assign(input.state.protagonist, { panel });
    const before = structuredClone(input);
    const opening = openingInput({ settings: s });
    for (const messages of [turnMessages(input), openingMessages(opening), openingExtractMessages({ ...opening, text: "初来轨道城。" }), extractMessages({ ...input, action: input.text, narrative: "我观察屏幕。" })]) {
      expect(promptText(messages).includes(panel)).toBe(heroPanelEnabled === true);
    }
    expect(input).toEqual(before);
    Object.assign(input.state.protagonist, { panel: "   " });
    expect(promptText(turnMessages(input))).not.toContain("【主角面板");
  });

  it("reads the current branch snapshot and never falls back to the opening seed during play", () => {
    const input = turnInput({ settings: { ...settings, heroPanelEnabled: true, heroPanel: "开局：尚未学会闪现" } });
    const other = structuredClone(input);
    Object.assign(input.state.protagonist, { panel: "甲支线：已学会闪现" });
    Object.assign(other.state.protagonist, { panel: "乙支线：仍在学习" });
    for (const branch of [input, other]) {
      const expected = branch === input ? "甲支线：已学会闪现" : "乙支线：仍在学习";
      for (const messages of [turnMessages(branch), extractMessages({ ...branch, action: branch.text, narrative: "我查看笔记。" })]) {
        const text = promptText(messages);
        expect(text).toContain(expected);
        expect(text).not.toContain(branch === input ? "乙支线" : "甲支线");
        expect(text).not.toContain("开局：尚未学会闪现");
      }
    }
    const missing = turnInput({ settings: input.settings });
    expect(promptText(turnMessages(missing))).not.toContain("【主角面板");
    expect(promptText(extractMessages({ ...missing, action: "观察", narrative: "灯亮着。" }))).not.toContain("【主角面板");
  });

  it("recognizes mode on the setup draft and preserves filled values", () => {
    const current = { mode: "free" as const, name: "零", age: 0, premise: "宇宙中只有一座书店" };
    const text = promptText(assistMessages("轻松日常", current));
    expect(text).not.toMatch(historical);
    expect(text).not.toMatch(/迫在眉睫|核心冲突/);
    for (const value of ["mode: free", "name: 零", "age: 0", current.premise]) expect(text).toContain(value);
    expect(assistMessages("", {})[0].content).toContain("历史互动小说");
    // A fact, not a plot rule: the suggested gender matches a gendered identity (R02 playtest).
    for (const draft of [current, {}]) expect(assistMessages("", draft)[0].content).toContain("性别与身份要一致");
  });

  it("continues interrupted free requests with their settings and record contract intact", () => {
    const base = turnMessages(turnInput({ settings }));
    const continued = continueMessages(base, "灯光照在");
    expect(continued.slice(0, base.length)).toEqual(base);
    expect(continued.at(-2)).toEqual({ role: "assistant", content: "灯光照在" });
    expect(continued.at(-1)!.content).toContain("记录块要涵盖整段回复");
    expect(promptText(continued)).not.toMatch(historical);
  });
});

describe("context budget", () => {
  const chapter = (n: number, first: string): Chapter => ({
    id: `c${n}`, worldId: "w", firstNodeId: first, lastNodeId: first, title: `第${n}章`, gist: `梗概${n}`,
    summary: `摘要${n}`.padEnd(400, "。"), model: null, promptVersion: null, edited: false, createdAt: "",
  });
  const turns = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`, kind: "turn", actionMode: "do", actionText: `行动${i + 1}`, narrative: `第${i + 1}段，漕帮和天地会的人都在。`.padEnd(800, "雪"),
  } as StoryNode));

  function context(budgetChars: number) {
    const state = sampleState();
    state.people = [person("王掌柜", "催过三次房钱", 30)];
    state.cards = [
      { id: "k1", kind: "势力", name: "漕帮", keys: [], content: "把持码头的帮会".padEnd(200, "。") },
      { id: "k2", kind: "势力", name: "天地会", keys: [], content: "反清秘密结社".padEnd(200, "。") },
    ];
    const settings = { ...DEFAULT_SETTINGS, essentials: "王掌柜其实是主角的舅舅", directive: "节奏快一些" };
    return buildTurnContext({
      era: eraContext("tang-748", state), settings, protagonistName: "李安", state, history: turns(12), mode: "do", text: "去码头看看",
      chapters: [chapter(1, "t1"), chapter(2, "t4"), chapter(3, "t7")], pins: ["漕帮答应三日后交货"], budgetChars,
    });
  }

  it("fills what is left with recent turns and recaps chapters that fell out", () => {
    const roomy = context(9000);
    const history = roomy.layers.find((l) => l.key === "history")!;
    expect(history.note).toMatch(/^最近 \d+ 段/);
    expect(roomy.messages.length - 2).toBeGreaterThan(6);
    const recap = roomy.layers.find((l) => l.key === "recap")!;
    expect(recap.content).toContain("第 1 章 · 第1章：摘要1");
    // A chapter is recapped exactly when its first turn is outside the window.
    const firstInWindow = 12 - Number(history.note.match(/^最近 (\d+) 段/)![1]) + 1;
    for (const [n, first] of [[1, 1], [2, 4], [3, 7]]) expect(recap.content.includes(`第 ${n} 章`)).toBe(first < firstInWindow);
    // With room for every turn there is nothing to recap.
    expect(context(20000).layers.find((l) => l.key === "recap")!.content).toBe("");
  });

  it("over the hard cap keeps three turns, shrinks the recap to gists, then drops cards; the fixed layers stay", () => {
    const tight = context(3000);
    expect(tight.messages.length - 2).toBe(6);
    const recap = tight.layers.find((l) => l.key === "recap")!;
    expect(recap.content).toContain("第 3 章 · 第3章：梗概3");
    expect(recap.note).toContain("只留梗概");
    expect(tight.layers.find((l) => l.key === "cards")!.note).toContain("去掉了 2 张");
    const user = tight.messages[tight.messages.length - 1].content;
    // 王掌柜 is not mentioned lately, so only his line comes in, without the note.
    for (const kept of ["【当前】", "王掌柜：坊里的人，对主角一般", "王掌柜其实是主角的舅舅", "漕帮答应三日后交货", "【叙事方针】节奏快一些", "去码头看看"]) expect(user).toContain(kept);
    expect(tight.messages[0].content).toContain("【写作要求】");
    expect(tight.messages[0].content).toContain("不要出现：");
  });
});
