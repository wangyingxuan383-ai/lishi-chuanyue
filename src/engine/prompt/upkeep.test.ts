import { describe, expect, it } from "vitest";
import { sampleState } from "../testing/fixtures";
import type { WorldState } from "../types";
import { upkeepMessages, upkeepPatch } from "./upkeep";

function world(): WorldState {
  const state = sampleState();
  state.cards = [
    { id: "era", kind: "时代", name: "唐 · 天宝", keys: [], content: "时局……", source: "卡组" },
    { id: "a", kind: "势力", name: "相府", keys: ["右相府"], content: "李林甫的宅第与幕僚", source: "AI" },
    { id: "p", kind: "势力", name: "天地会", keys: [], content: "玩家写的反清组织", source: "玩家" },
    { id: "k", kind: "设定", name: "夜禁", keys: [], content: "卡组写的宵禁规矩", source: "卡组" },
  ];
  state.places = [
    { id: "x", name: "平康坊", description: "" },
    { id: "y", name: "崇仁坊", description: "AI 写过的描述", source: "AI" },
    { id: "z", name: "西市", description: "卡组写的西市", source: "卡组" },
  ];
  state.people = [{ id: "z4", name: "赵四", aliases: [], role: "不良人", attitude: "友善", alive: true, notes: "", lastSeenMinute: 0 }];
  state.dismissed = ["鬼市"];
  return state;
}

const answer = (value: unknown) => `整理如下：\n${JSON.stringify(value)}`;

describe("设定集 upkeep", () => {
  it("does not confuse a successor with the existing ruler when filing people or deaths", () => {
    const state = world();
    state.people[0].name = "亚历山大";
    const patch = upkeepPatch(answer({ people: [{ name: "亚历山大二世", role: "王子" }], deaths: ["亚历山大二世"] }), state)!;
    expect(patch.people).toEqual([{ name: "亚历山大二世", role: "王子", note: "" }]);
    expect(state.people[0].alive).toBe(true);
  });
  it("names the protagonist, so their deeds are not filed under someone else", () => {
    const state = world();
    state.protagonist.name = "王延寿";
    state.protagonist.identity = "万年县不良帅";
    state.protagonist.statuses = [{ name: "左臂刀伤", detail: "", sinceMinute: 0 }, { name: "窥得重器", detail: "", sinceMinute: 0 }];
    const text = upkeepMessages({ premise: "", state, turns: [{ actionText: "去西市", narrative: "你到了西市。" }] }).map((m) => m.content).join("\n");
    expect(text).toContain("【主角】王延寿（万年县不良帅）；剧情里的“你”就是他");
    expect(text).toContain("【主角的状况】左臂刀伤、窥得重器");
  });

  it("clears statuses that are not the protagonist's condition and marks deaths the ledger missed", () => {
    const state = world();
    state.protagonist.statuses = [
      { name: "左臂刀伤", detail: "", sinceMinute: 0 }, { name: "窥得重器", detail: "", sinceMinute: 0 }, { name: "垂危", detail: "", sinceMinute: 0 },
    ];
    const patch = upkeepPatch(answer({ statusRemove: ["窥得重器", "窥得重器", "没有这个", "垂危"], deaths: ["赵四", "无名氏"] }), state)!;
    expect(patch.status).toEqual([{ op: "remove", name: "窥得重器" }]);
    expect(patch.people).toEqual([{ id: "z4", name: "赵四", alive: false }]);
    state.people[0].alive = false;
    expect(upkeepPatch(answer({ deaths: ["赵四"] }), state)).toBeNull();
  });

  it("adds new cards only for names nobody has used, at most three", () => {
    const patch = upkeepPatch(answer({
      cards: [
        { kind: "物品", name: "平卢铜鹰符", keys: ["鹰符"], content: "平卢军的调兵信物" },
        { kind: "势力", name: "右相府", content: "和相府是同一个，跳过" },
        { kind: "势力", name: "赵四", content: "是人物，跳过" },
        { kind: "设定", name: "鬼市", content: "玩家删过，跳过" },
        { kind: "门派", name: "鱼袋案", content: "种类不认识，记作设定" },
        { kind: "势力", name: "将作监", content: "第三张" },
        { kind: "势力", name: "金吾卫", content: "超过三张，丢掉" },
      ],
    }), world())!;
    expect(patch.cards).toEqual([
      { op: "add", kind: "物品", name: "平卢铜鹰符", keys: ["鹰符"], content: "平卢军的调兵信物", source: "AI" },
      { op: "add", kind: "设定", name: "鱼袋案", keys: [], content: "种类不认识，记作设定", source: "AI" },
      { op: "add", kind: "势力", name: "将作监", keys: [], content: "第三张", source: "AI" },
    ]);
  });

  it("updates only what the AI wrote", () => {
    const patch = upkeepPatch(answer({
      updates: [
        { name: "右相府", content: "李林甫已命人灭口" },
        { name: "天地会", content: "玩家的卡，不改" },
        { name: "夜禁", content: "卡组的卡，不改" },
        { name: "不存在", content: "没有这张卡" },
      ],
    }), world())!;
    expect(patch.cards).toEqual([{ op: "update", id: "a", name: "相府", content: "李林甫已命人灭口", source: "AI" }]);
  });

  it("fills blank places, rewrites its own, and leaves the rest", () => {
    const patch = upkeepPatch(answer({
      places: [
        { name: "平康坊", aliases: ["北里"], description: "妓馆聚集的坊" },
        { name: "崇仁坊", description: "新的描述" },
        { name: "西市", description: "卡组写过，不改" },
        { name: "通化门", description: "长安东面北起第一门" },
        { name: "鬼市", description: "玩家删过" },
      ],
    }), world())!;
    expect(patch.places).toEqual([
      { op: "update", id: "x", name: "平康坊", aliases: ["北里"], description: "妓馆聚集的坊", source: "AI" },
      { op: "update", id: "y", name: "崇仁坊", aliases: [], description: "新的描述", source: "AI" },
      { op: "add", name: "通化门", aliases: [], description: "长安东面北起第一门", source: "AI" },
    ]);
  });

  it("adds recurring people the ledger missed, and updates a place it described before", () => {
    const patch = upkeepPatch(answer({
      people: [
        { name: "崔县尉", role: "万年县尉，主角的上司", attitude: "冷淡", note: "限三日破案" },
        { name: "赵四", role: "已在人物表" },
        { name: "鬼市", role: "玩家删过的名字" },
      ],
      updates: [{ name: "崔仁坊", content: "不存在" }, { name: "崇仁坊", content: "铁匣已被取走" }, { name: "西市", content: "卡组写的，不改" }],
    }), world())!;
    expect(patch.people).toEqual([{ name: "崔县尉", role: "万年县尉，主角的上司", attitude: "冷淡", note: "限三日破案" }]);
    expect(patch.places).toEqual([{ op: "update", id: "y", name: "崇仁坊", description: "铁匣已被取走", source: "AI" }]);
  });

  it("returns null when nothing is worth keeping", () => {
    expect(upkeepPatch(answer({ cards: [], places: [], updates: [] }), world())).toBeNull();
    expect(upkeepPatch("没有需要记的", world())).toBeNull();
    expect(upkeepPatch(answer({ updates: [{ name: "相府", content: "李林甫的宅第与幕僚" }] }), world())).toBeNull();
  });

  it("shows what may be updated and keeps the newest story within budget", () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({ actionText: `行动${i + 1}`, narrative: `第${i + 1}段`.padEnd(600, "。") }));
    const [system, user] = upkeepMessages({ premise: "天宝七载，长安。", state: world(), turns, taboos: "钱庄；飞钱" });
    expect(user.content).toContain("【这个时代不该出现的东西】钱庄；飞钱");
    expect(system.content).toContain("人物不建卡");
    expect(user.content).toContain("势力 · 相府（AI 整理，可以更新）：李林甫的宅第与幕僚");
    expect(user.content).toContain("势力 · 天地会（玩家写的，不要改）");
    expect(user.content).toContain("平康坊（还没有描述）");
    expect(user.content).toContain("【人物表里已有的人物（不要建卡，也不要再写进 people）】赵四");
    expect(user.content).toContain("【玩家删掉的，不要再建】鬼市");
    expect(user.content).toContain("行动12");
    expect(user.content).not.toContain("行动1\n");
    expect(user.content).not.toContain("时代 · ");
  });
});
