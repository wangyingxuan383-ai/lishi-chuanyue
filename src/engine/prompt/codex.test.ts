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
    expect(system.content).toContain("没把握的就不写");
    // The era words are an optional short list, not a rulebook (D129); no style rules.
    expect(system.content).toContain("可以加一行“不要出现：”");
    expect(system.content).toContain("至多 8 条");
    expect(system.content).not.toMatch(/十条以上|文风/);
    // Real dynasties only: the great events after the start, for the player's 记事 page.
    expect(system.content).toContain("故事设定是真实朝代时，另列故事开始之后几年里史书记载的大事，至多 8 件");
    expect(system.content).toContain("架空或改编的世界不写");
    expect(system.content).toContain('"timeline":[{"date":"崇祯二年十月","ceYear":1629');
    expect(user.content).toContain("架空王朝大胤");
    expect(user.content).toContain("你是青衣卫的小旗。");
    expect(user.content).toContain("【已有卡片，不要重复】西市");
  });

  it("keeps a short list of era words and the great events for a history world only", () => {
    const words = Array.from({ length: 12 }, (_, i) => `词${"甲乙丙丁戊己庚辛壬癸子丑"[i]}`);
    const raw = JSON.stringify({
      era: { name: "明 · 崇祯元年", content: `时局：新帝登基。\n不要出现: ${words.join("；")}` },
      timeline: [
        ...Array.from({ length: 10 }, (_, i) => ({ date: `崇祯${i + 2}年十月`, ceYear: 1629 + i, title: `大事${i}`, kind: i % 2 ? "固定" : "随便" })),
      ],
    });
    const patch = codexPatch(raw, sampleState())!;
    const card = patch.cards![0].content!;
    expect(card).toBe(`时局：新帝登基。\n不要出现：${words.slice(0, 8).join("；")}`);
    expect(patch.timeline).toHaveLength(8);
    expect(patch.timeline![0]).toEqual({ op: "add", date: "崇祯2年十月", title: "大事0", kind: "可变", source: "AI", ceYear: 1629 });
    expect(patch.timeline![1].kind).toBe("固定");
    // Free worlds: no list is trimmed into shape and no events are kept, whatever the reply says.
    const free = sampleState();
    free.era.mode = "free";
    const freePatch = codexPatch(raw, free)!;
    expect(freePatch.timeline).toBeUndefined();
    expect(freePatch.cards![0].content).toContain(words[11]);
  });

  it("turns the answer into an AI-marked patch", () => {
    const patch = codexPatch(`好的：\n${ANSWER}`, sampleState())!;
    expect(patch.cards).toEqual([
      { op: "add", kind: "时代", name: "大胤 · 景和三年 · 云京", content: expect.stringContaining("太后垂帘"), source: "AI" },
      { op: "add", kind: "势力", name: "青衣卫", keys: ["青衣"], content: "太后亲领的密探", source: "AI" },
      { op: "add", kind: "设定", name: "天机阁", keys: [], content: "江湖情报组织", source: "AI" },
    ]);
    expect(patch.places).toEqual([{ op: "add", name: "云京", aliases: [], description: "大胤京城，分内外两城", source: "AI" }]);
    expect(codexSummary(patch)).toBe("AI 整理了设定集：时代卡、青衣卫、天机阁等");
    // Upkeep passes that only clear statuses or mark deaths still say what they did.
    expect(codexSummary({ status: [{ op: "remove", name: "窥得重器" }, { op: "remove", name: "热食充饥" }] })).toBe("AI 整理了设定集：去掉了 2 项过去的状况");
    expect(codexSummary({ cards: [{ op: "add", kind: "势力", name: "右金吾卫", content: "禁军" }], people: [{ id: "p", name: "周管事", alive: false }] }))
      .toBe("AI 整理了设定集：右金吾卫；记下周管事已去世");
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
