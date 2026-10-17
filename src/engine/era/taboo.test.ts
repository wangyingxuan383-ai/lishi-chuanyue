import { describe, expect, it } from "vitest";
import { TANG_748 } from "../../content/eras/tang-748";
import { eraCardText } from "./card";
import { findTaboos, shortTabooLine, tabooLine, tabooReminder, tabooTerms } from "./taboo";
import type { Card } from "../types";

const card = (content: string): Card => ({ id: "e", kind: "时代", name: "时代", keys: [], content });

describe("era words check", () => {
  it("uses a pack's match words, so 小时候 is not a clock", () => {
    const terms = tabooTerms(card(eraCardText(TANG_748)), TANG_748);
    expect(terms.find((t) => t.term === "银两")).toMatchObject({ entry: "碎银子付账", instead: "铜钱、绢帛" });
    expect(findTaboos("他小时候在西市长大，掏出两银子付账。", terms).map((h) => h.term)).toEqual(["两银子"]);
    expect(findTaboos("街鼓响了一刻钟。", terms)).toEqual([]);
    // A pack's watch words are checked too, though the card does not print them.
    const watched = findTaboos("小的这就去请差爷。", terms).map((h) => h.term);
    expect(watched).toEqual(expect.arrayContaining(["小的", "差爷"]));
    expect(findTaboos("案上一张神臂弩，檐下挂着马灯。", terms).map((h) => h.term)).toEqual(["神臂弩", "马灯"]);
    expect(findTaboos("西市的走马灯转个不停。", terms)).toEqual([]);
    // 小的 is a servant speaking, not something small; three shifts are not 三班衙役.
    expect(findTaboos("“小的这就去。”", terms).map((h) => h.term)).toEqual(["小的"]);
    expect(findTaboos("大人，小的不敢。", terms).map((h) => h.term)).toEqual(["小的"]);
    expect(findTaboos("他最小的儿子捧着小小的布包，大大小小的箱笼分作三班看守。", terms)).toEqual([]);
    const memorial = [{ term: "折子", entry: "折子", instead: "表、状" }];
    expect(findTaboos("他吹亮火折子。", memorial)).toEqual([]);
    expect(findTaboos("他吹亮火折子，又递上折子。", memorial)).toEqual([{ term: "折子", instead: "表、状" }]);
  });

  it("reads a card the AI or the player wrote", () => {
    const terms = tabooTerms(card("时局：天下初定。\n不要出现：火枪（用弓弩）；银票、交子；动辄跪地磕头"), null);
    expect(terms.map((t) => [t.term, t.instead])).toEqual([["火枪", "弓弩"], ["银票", null], ["交子", null], ["动辄跪地磕头", null]]);
    expect(findTaboos("他掏出一张银票。", terms)).toEqual([{ term: "银票", instead: null }]);
    expect(tabooTerms(card("时局：没有这一行"), null)).toEqual([]);
  });

  it("reads the line however the organizer spaced or punctuated it, and keeps it short", () => {
    // Half-width colon, leading spaces, a bracketed note inside a 、 list.
    const loose = tabooTerms(card("货币：铜钱。\n  不要出现: 算盘（用算筹）、银票; 火柴（用火石、火镰）"), null);
    expect(loose.map((t) => [t.term, t.instead])).toEqual([["算盘", null], ["银票", null], ["火柴", "火石、火镰"]]);
    expect(tabooLine("时局：x\n不要出现：甲乙")).toBe("甲乙");
    expect(tabooLine("时局：x")).toBeNull();
    expect(shortTabooLine("时局：x\n不要出现：一一；二二；三三；四四", 2)).toBe("时局：x\n不要出现：一一；二二");
    expect(shortTabooLine("时局：x\n不要出现：", 8)).toBe("时局：x");
  });

  it("reminds the next turn of what to say instead", () => {
    expect(tabooReminder([{ term: "银两", instead: "铜钱、绢帛" }])).toBe("\n【用词提醒】上一段用了这个时代不该有的说法：“银两”（该用：铜钱、绢帛）。之后不要再用，已经写出的不必解释。");
    expect(tabooReminder([])).toBe("");
  });
});
