import { describe, expect, it } from "vitest";
import { applyRecord } from "../state/apply";
import { TANG_CURRENCY } from "../money";
import { sampleState } from "../testing/fixtures";
import { activeCardLines, eraCardOf } from "./cards";

function world() {
  const s = sampleState();
  s.places = [
    { id: "p1", name: "西市", aliases: [], description: "胡商云集" },
    { id: "p2", name: "长安县", aliases: [], description: "朱雀街以西" },
    { id: "p3", name: "破庙", description: "" },
  ];
  s.cards = [
    { id: "c0", kind: "时代", name: "唐", keys: [], content: "时代卡" },
    { id: "c1", kind: "势力", name: "天地会", keys: ["会党"], content: "反清秘密结社" },
    { id: "c2", kind: "物品", name: "玉玺", keys: [], content: "传国玉玺" },
    { id: "c3", kind: "设定", name: "长安", keys: [], content: "京城" },
  ];
  return s;
}

describe("cards in context", () => {
  it("finds the era card", () => {
    expect(eraCardOf(world())?.content).toBe("时代卡");
    expect(eraCardOf(sampleState())).toBeNull();
  });

  it("brings in cards whose name or alias was mentioned, newest first", () => {
    expect(activeCardLines(world(), "他拿出玉玺。会党的人来了。")).toEqual(["【势力】天地会（又称会党）：反清秘密结社", "【物品】玉玺：传国玉玺"]);
    expect(activeCardLines(world(), "风很大")).toEqual([]);
  });

  it("brings in a card the action describes without its exact name, after the named ones", () => {
    const s = world();
    s.cards.push({ id: "c4", kind: "物品", name: "乌木包银鹰牌", keys: [], content: "恶少年头目的信物" });
    expect(activeCardLines(s, "他拿出玉玺", undefined, "那块刻着鹰隼的乌木包银腰牌是谁的")).toEqual(["【物品】玉玺：传国玉玺", "【物品】乌木包银鹰牌：恶少年头目的信物"]);
    expect(activeCardLines(s, "风很大", undefined, "")).toEqual([]);
  });

  it("puts the current place first and skips places without a description", () => {
    const s = world();
    s.placeId = "p1";
    expect(activeCardLines(s, "")).toEqual(["【地点】西市：胡商云集"]);
    s.placeId = "p3";
    expect(activeCardLines(s, "破庙里很冷")).toEqual([]);
  });

  it("does not fire a short name inside a longer one", () => {
    expect(activeCardLines(world(), "他去了长安县衙")).toEqual(["【地点】长安县：朱雀街以西"]);
    expect(activeCardLines(world(), "长安县衙在西，长安城很大")).toEqual(["【设定】长安：京城", "【地点】长安县：朱雀街以西"]);
  });

  it("still brings a renamed card in by its old name", () => {
    const renamed = applyRecord(world(), { cards: [{ op: "update", id: "c1", name: "洪门" }] }, { mode: "do", difficulty: "标准", currency: TANG_CURRENCY }, { advanceTime: false }).state;
    expect(activeCardLines(renamed, "天地会的人来了")).toEqual(["【势力】洪门（又称会党、天地会）：反清秘密结社"]);
  });

  it("never sends the era card here and keeps to the budget", () => {
    expect(activeCardLines(world(), "唐朝")).toEqual([]);
    expect(activeCardLines(world(), "天地会 玉玺", 20)).toEqual(["【物品】玉玺：传国玉玺"]);
  });
});
