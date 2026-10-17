import { describe, expect, it } from "vitest";
import { sampleState } from "../testing/fixtures";
import type { StoryNode } from "../types";
import { namesInPlay, recallBlock } from "./recall";

const node = (id: string, narrative: string) => ({ id, narrative, kind: "turn" } as StoryNode);

function world() {
  const s = sampleState();
  s.people = [{ id: "z", name: "赵四", aliases: ["赵大哥"], role: "不良人", attitude: "友善", alive: true, notes: "", lastSeenMinute: 0 }];
  s.cards = [{ id: "f", kind: "物品", name: "铜鱼符", keys: ["鱼符"], content: "死者的鱼符" }];
  s.places = [{ id: "p", name: "平康坊", description: "" }];
  return s;
}

describe("相关旧事", () => {
  it("finds the names in play, the latest-mentioned first", () => {
    expect(namesInPlay(world(), "赵大哥说，平康坊那边有动静。我去看看鱼符。").map((n) => n.name)).toEqual(["铜鱼符", "平康坊", "赵四"]);
    expect(namesInPlay(world(), "风很大")).toEqual([]);
  });

  it("brings back the first and latest old sentences about each name", () => {
    const older = [
      { node: node("a", "你醒在破庙。赵四蹲在门口，说他欠你一条命。"), turn: 0 },
      { node: node("b", "赵四替你挡了一刀，左臂见了骨。"), turn: 7 },
      { node: node("c", "你们在西市分头打听。"), turn: 9 },
      { node: node("d", "赵四把鱼符交还给你：“背面刻着太府寺少卿窦章。”"), turn: 12 },
    ];
    const block = recallBlock(world(), "去找赵四商量鱼符的事", older);
    expect(block).toContain("- 第 12 回合（铜鱼符）：赵四把鱼符交还给你：“背面刻着太府寺少卿窦章。”");
    expect(block).toContain("- 开场（赵四）：赵四蹲在门口，说他欠你一条命。");
    expect(block).not.toContain("挡了一刀");
    expect(recallBlock(world(), "去找赵四", [])).toBe("");
    expect(recallBlock(world(), "去找赵四", older, 10)).toBe("");
  });
});
