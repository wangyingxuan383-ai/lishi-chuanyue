import { describe, expect, it } from "vitest";
import { eraContext } from "../era";
import { sampleState } from "../testing/fixtures";
import { DEFAULT_SETTINGS, type Person, type StoryNode } from "../types";
import { turnMessages } from "./turn";

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
