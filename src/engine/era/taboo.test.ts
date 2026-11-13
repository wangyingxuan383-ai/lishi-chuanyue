import { describe, expect, it } from "vitest";
import { shortTabooLine, tabooLine, tabooReminder } from "./taboo";


describe("era words check", () => {
  it("reads the line however the organizer spaced or punctuated it, and keeps it short", () => {
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
