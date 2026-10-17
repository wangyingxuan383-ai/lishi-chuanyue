import { describe, expect, it } from "vitest";
import type { Chapter } from "../types";
import { chapterMessages, parseChapter, recapBlock } from "./chapter";

const chapter = (n: number, extra: Partial<Chapter> = {}): Chapter => ({
  id: `c${n}`, worldId: "w", firstNodeId: `first${n}`, lastNodeId: `last${n}`, title: `第${n}章题`, gist: `梗概${n}`,
  summary: `摘要${n}`.padEnd(200, "。"), model: "aux", promptVersion: "chapter-1", edited: false, createdAt: "", ...extra,
});

describe("chapter summaries", () => {
  it("asks for one chapter with the earlier gists and turn numbers", () => {
    const [system, user] = chapterMessages({
      premise: "天宝七载，长安。", protagonist: "崔怀远", previous: [{ title: "鱼袋失踪", gist: "县尉限期三日" }],
      turns: [{ actionText: "去平康坊", narrative: "坊墙下一摊冻血。" }, { actionText: null, narrative: "赵四跑来报信。" }], firstTurn: 13,
    });
    expect(system.content).toContain("许下的承诺、欠下的人情或债");
    expect(user.content).toContain("第 1 章 · 鱼袋失踪：县尉限期三日");
    expect(user.content).toContain("【本章剧情（第 13～14 回合）】");
    expect(user.content).toContain("第 14 回合\n赵四跑来报信。");
  });

  it("reads the answer, filling a missing title or gist", () => {
    expect(parseChapter('好的：{"title":"夜闯死牢","gist":"崔怀远潜入死牢","summary":"崔怀远买通狱吏……"}')).toEqual({ title: "夜闯死牢", gist: "崔怀远潜入死牢", summary: "崔怀远买通狱吏……" });
    expect(parseChapter('{"summary":"一段摘要"}')).toEqual({ title: "无题", gist: "一段摘要", summary: "一段摘要" });
    expect(parseChapter("写不出来")).toBeNull();
  });

  it("recaps chapters that left the window: newest in full, older by gist, oldest dropped first", () => {
    const chapters = [1, 2, 3, 4, 5, 6].map((n) => chapter(n));
    const inWindow = (id: string) => id === "first6";
    const recap = recapBlock(chapters, inWindow);
    expect(recap).toContain("第 1 章 · 第1章题：梗概1");
    expect(recap).toContain("第 2 章 · 第2章题：梗概2");
    expect(recap).toContain("第 5 章 · 第5章题：摘要5");
    expect(recap).not.toContain("第 6 章");
    const tight = recapBlock(chapters, inWindow, 500);
    expect(tight).not.toContain("第 1 章");
    expect(tight).toContain("第 5 章");
    expect(recapBlock(chapters, () => true)).toBe("");
  });
});
