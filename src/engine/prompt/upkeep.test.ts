import { describe, expect, it } from "vitest";
import { sampleState } from "../testing/fixtures";
import type { WorldState } from "../types";
import { upkeepMessages } from "./upkeep";

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


describe("设定集 upkeep", () => {
  it("names the protagonist, so their deeds are not filed under someone else", () => {
    const state = world();
    state.protagonist.name = "王延寿";
    state.protagonist.identity = "万年县不良帅";
    state.protagonist.statuses = [{ name: "左臂刀伤", detail: "", sinceMinute: 0 }, { name: "窥得重器", detail: "", sinceMinute: 0 }];
    const text = upkeepMessages({ premise: "", state, turns: [{ actionText: "去西市", narrative: "你到了西市。" }] }).map((m) => m.content).join("\n");
    expect(text).toContain("【主角】王延寿（万年县不良帅）；剧情里的“你”就是他");
    expect(text).toContain("【主角的状况】左臂刀伤、窥得重器");
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
