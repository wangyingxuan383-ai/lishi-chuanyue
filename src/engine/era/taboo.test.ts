import { describe, expect, it } from "vitest";
import { TANG_748 } from "../../content/eras/tang-748";
import { eraCardText } from "./card";
import { findTaboos, tabooReminder, tabooTerms } from "./taboo";
import type { Card } from "../types";

const card = (content: string): Card => ({ id: "e", kind: "时代", name: "时代", keys: [], content });

describe("era words check", () => {
  it("uses a pack's match words, so 小时候 is not a clock", () => {
    const terms = tabooTerms(card(eraCardText(TANG_748)), TANG_748);
    expect(terms.find((t) => t.term === "银两")).toMatchObject({ entry: "碎银子付账", instead: "铜钱、绢帛" });
    expect(findTaboos("他小时候在西市长大，掏出两银子付账。", terms).map((h) => h.term)).toEqual(["两银子"]);
    expect(findTaboos("街鼓响了一刻钟。", terms)).toEqual([]);
  });

  it("reads a card the AI or the player wrote", () => {
    const terms = tabooTerms(card("时局：天下初定。\n不要出现：火枪（用弓弩）；银票、交子；动辄跪地磕头"), null);
    expect(terms.map((t) => [t.term, t.instead])).toEqual([["火枪", "弓弩"], ["银票", null], ["交子", null], ["动辄跪地磕头", null]]);
    expect(findTaboos("他掏出一张银票。", terms)).toEqual([{ term: "银票", instead: null }]);
    expect(tabooTerms(card("时局：没有这一行"), null)).toEqual([]);
  });

  it("reminds the next turn of what to say instead", () => {
    expect(tabooReminder([{ term: "银两", instead: "铜钱、绢帛" }])).toBe("\n【用词提醒】上一段用了这个时代不该有的说法：“银两”（该用：铜钱、绢帛）。之后不要再用，已经写出的不必解释。");
    expect(tabooReminder([])).toBe("");
  });
});
