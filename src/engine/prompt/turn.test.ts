import { describe, expect, it } from "vitest";
import { eraContext } from "../era";
import { sampleState } from "../testing/fixtures";
import { DEFAULT_SETTINGS, type Chapter, type Person, type StoryNode } from "../types";
import { buildTurnContext, turnMessages } from "./turn";

const person = (name: string, notes: string, lastSeenMinute: number, extra: Partial<Person> = {}): Person =>
  ({ id: name, name, aliases: [], role: "坊里的人", attitude: "一般", alive: true, notes, lastSeenMinute, ...extra });

function userPrompt(people: Person[], recent: string, action = "四处看看") {
  const state = sampleState();
  state.people = people;
  const history = [{ kind: "turn", actionMode: "do", actionText: "进门", narrative: recent } as StoryNode];
  const messages = turnMessages({ era: eraContext("tang-748", state), settings: DEFAULT_SETTINGS, protagonistName: "李安", state, history, mode: "do", text: action });
  return messages[messages.length - 1].content;
}

describe("people in the turn prompt", () => {
  it("puts people in the scene first with their notes; others get one line", () => {
    const text = userPrompt([
      person("王掌柜", "催过三次房钱", 30),
      person("赵四", "替主角挡过一刀", 10, { aliases: ["赵大哥"] }),
      person("史思礼", "已被灭口", 5, { alive: false }),
    ], "赵大哥拍了拍你的肩膀。");
    const block = text.slice(text.indexOf("已知人物："), text.indexOf("进行中的目标"));
    expect(block.split("\n").slice(1, 4)).toEqual([
      "赵四（又称赵大哥）：坊里的人，对主角一般；替主角挡过一刀",
      "王掌柜：坊里的人，对主角一般",
      "史思礼：坊里的人，对主角一般，已死",
    ]);
  });

  it("lists names only beyond thirty people", () => {
    const people = Array.from({ length: 33 }, (_, i) => person(`人物${i + 1}号`, "", i));
    const text = userPrompt(people, "街上人来人往。");
    expect(text).toContain("人物33号：坊里的人");
    expect(text).toContain("另有：人物3号、人物2号、人物1号");
  });
});

describe("context budget", () => {
  const chapter = (n: number, first: string): Chapter => ({
    id: `c${n}`, worldId: "w", firstNodeId: first, lastNodeId: first, title: `第${n}章`, gist: `梗概${n}`,
    summary: `摘要${n}`.padEnd(400, "。"), model: null, promptVersion: null, edited: false, createdAt: "",
  });
  const turns = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`, kind: "turn", actionMode: "do", actionText: `行动${i + 1}`, narrative: `第${i + 1}段，漕帮和天地会的人都在。`.padEnd(800, "雪"),
  } as StoryNode));

  function context(budgetChars: number) {
    const state = sampleState();
    state.people = [person("王掌柜", "催过三次房钱", 30)];
    state.cards = [
      { id: "k1", kind: "势力", name: "漕帮", keys: [], content: "把持码头的帮会".padEnd(200, "。") },
      { id: "k2", kind: "势力", name: "天地会", keys: [], content: "反清秘密结社".padEnd(200, "。") },
    ];
    const settings = { ...DEFAULT_SETTINGS, essentials: "王掌柜其实是主角的舅舅", directive: "节奏快一些" };
    return buildTurnContext({
      era: eraContext("tang-748", state), settings, protagonistName: "李安", state, history: turns(12), mode: "do", text: "去码头看看",
      chapters: [chapter(1, "t1"), chapter(2, "t4"), chapter(3, "t7")], pins: ["漕帮答应三日后交货"], budgetChars,
    });
  }

  it("fills what is left with recent turns and recaps chapters that fell out", () => {
    const roomy = context(9000);
    const history = roomy.layers.find((l) => l.key === "history")!;
    expect(history.note).toMatch(/^最近 \d+ 段/);
    expect(roomy.messages.length - 2).toBeGreaterThan(6);
    const recap = roomy.layers.find((l) => l.key === "recap")!;
    expect(recap.content).toContain("第 1 章 · 第1章：摘要1");
    // A chapter is recapped exactly when its first turn is outside the window.
    const firstInWindow = 12 - Number(history.note.match(/^最近 (\d+) 段/)![1]) + 1;
    for (const [n, first] of [[1, 1], [2, 4], [3, 7]]) expect(recap.content.includes(`第 ${n} 章`)).toBe(first < firstInWindow);
    // With room for every turn there is nothing to recap.
    expect(context(20000).layers.find((l) => l.key === "recap")!.content).toBe("");
  });

  it("over the hard cap keeps three turns, shrinks the recap to gists, then drops cards; the fixed layers stay", () => {
    const tight = context(3000);
    expect(tight.messages.length - 2).toBe(6);
    const recap = tight.layers.find((l) => l.key === "recap")!;
    expect(recap.content).toContain("第 3 章 · 第3章：梗概3");
    expect(recap.note).toContain("只留梗概");
    expect(tight.layers.find((l) => l.key === "cards")!.note).toContain("去掉了 2 张");
    const user = tight.messages[tight.messages.length - 1].content;
    // 王掌柜 is not mentioned lately, so only his line comes in, without the note.
    for (const kept of ["【当前】", "王掌柜：坊里的人，对主角一般", "王掌柜其实是主角的舅舅", "漕帮答应三日后交货", "【叙事方针】节奏快一些", "去码头看看"]) expect(user).toContain(kept);
    expect(tight.messages[0].content).toContain("【写作要求】");
    expect(tight.messages[0].content).toContain("不要出现：");
  });
});
