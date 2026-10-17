import { describe, expect, it } from "vitest";
import { sampleState } from "../testing/fixtures";
import { codexMessages, codexPatch, codexSummary } from "./codex";

const ANSWER = JSON.stringify({
  era: { name: "大胤 · 景和三年 · 云京", content: "时局：景和帝年少，太后垂帘。\n货币：通宝铜钱，千文一贯。\n不要出现：火枪（用弓弩）；银票" },
  cards: [
    { kind: "势力", name: "青衣卫", keys: ["青衣"], content: "太后亲领的密探" },
    { kind: "地点", name: "云京", content: "大胤京城，分内外两城" },
    { kind: "门派", name: "天机阁", content: "江湖情报组织" },
    { kind: "势力", name: "", content: "没有名字的卡会被丢掉" },
  ],
});

describe("organizing the 设定集", () => {
  it("asks for an era card and a few cards from the player's setup", () => {
    const [system, user] = codexMessages({ premise: "架空王朝大胤，太后垂帘。", protagonist: { name: "沈砚", gender: "男", age: 20, identity: "你是青衣卫的小旗。" }, arrival: "魂穿", known: ["西市"] });
    expect(system.content).toContain("只补故事设定里没写清楚的部分");
    expect(system.content).toContain("不要出现");
    expect(user.content).toContain("架空王朝大胤");
    expect(user.content).toContain("你是青衣卫的小旗。");
    expect(user.content).toContain("【已有卡片，不要重复】西市");
  });

  it("turns the answer into an AI-marked patch", () => {
    const patch = codexPatch(`好的：\n${ANSWER}`, sampleState())!;
    expect(patch.cards).toEqual([
      { op: "add", kind: "时代", name: "大胤 · 景和三年 · 云京", content: expect.stringContaining("太后垂帘"), source: "AI" },
      { op: "add", kind: "势力", name: "青衣卫", keys: ["青衣"], content: "太后亲领的密探", source: "AI" },
      { op: "add", kind: "设定", name: "天机阁", keys: [], content: "江湖情报组织", source: "AI" },
    ]);
    expect(patch.places).toEqual([{ op: "add", name: "云京", aliases: [], description: "大胤京城，分内外两城" }]);
    expect(codexSummary(patch)).toBe("AI 整理了设定集：时代卡、青衣卫、天机阁等");
  });

  it("keeps what the player wrote", () => {
    const state = sampleState();
    state.cards = [
      { id: "e", kind: "时代", name: "我的大胤", keys: [], content: "自己写的", source: "玩家" },
      { id: "q", kind: "势力", name: "青衣卫", keys: [], content: "自己写的", source: "玩家" },
    ];
    state.places = [{ id: "y", name: "云京", description: "自己写的" }];
    expect(codexPatch(ANSWER, state)?.cards?.map((c) => c.name)).toEqual(["天机阁"]);
    expect(codexPatch(ANSWER, state)?.places).toBeUndefined();
    expect(codexPatch(ANSWER, state, { replaceOwnEra: true })?.cards?.[0]).toMatchObject({ kind: "时代", name: "大胤 · 景和三年 · 云京" });
  });

  it("returns null when nothing usable came back", () => {
    expect(codexPatch("抱歉，我无法完成", sampleState())).toBeNull();
    expect(codexPatch(JSON.stringify({ era: {}, cards: [] }), sampleState())).toBeNull();
  });
});
