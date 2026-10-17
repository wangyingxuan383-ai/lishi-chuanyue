import { describe, expect, it } from "vitest";
import { daypart, sentences, waitingLine } from "./StoryText";

describe("sentences", () => {
  it("splits after sentence ends and keeps closing quotes", () => {
    expect(sentences("雪下得紧。他说：“走吧！”你点头……然后")).toEqual(["雪下得紧。", "他说：“走吧！”", "你点头……", "然后"]);
  });
  it("loses nothing", () => {
    const text = "甲。乙！丙？“丁。”戊；己…庚";
    expect(sentences(text).join("")).toBe(text);
    expect(sentences("")).toEqual([]);
  });
});

describe("waitingLine", () => {
  it("is stable for the same moment and fits the place", () => {
    expect(waitingLine("西市当铺", 10)).toBe(waitingLine("西市当铺", 10));
    expect(["掌柜抬眼…", "算盘一停…", "伙计迎上来…"]).toContain(waitingLine("西市当铺", 10));
    expect(["挑灯…", "更鼓远远传来…", "烛花一跳…"]).toContain(waitingLine("城南", 23));
  });
  it("never says 正在生成", () => {
    for (const h of [0, 6, 12, 18, 22]) expect(waitingLine("某处", h)).not.toMatch(/生成|加载/);
  });
});

describe("daypart", () => {
  it("follows the hour", () => {
    expect([daypart(9), daypart(18), daypart(21), daypart(3)]).toEqual(["day", "dusk", "night", "night"]);
  });
});
