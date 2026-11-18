// The native port of 天下大事 and 相关旧事 (crates/story-core/src/recall.rs, D169)
// must give the same lines as these functions; the Rust tests use the same fixtures.
import { describe, expect, it } from "vitest";
import { worldBlock } from "../timeline";
import { recallBlock, RECALL_BUDGET } from "./recall";
import type { StoryNode, WorldState } from "../types";

describe("native assembly parity (R30, D169)", () => {
  it("天下大事 and 历史偏离", () => {
    const state = { time: { elapsedMinutes: 200000 }, timeline: [
      { date: "天宝八载六月", title: "哥舒翰攻克石堡城", kind: "固定", atMinute: 190000 },
      { date: "天宝九载", title: "未来的事", kind: "固定", atMinute: 300000 },
      { date: "很久以前", title: "旧事", kind: "固定", atMinute: 1000 }],
    deviations: ["李林甫提前罢相"] } as unknown as WorldState;
    expect(worldBlock(state, 0)).toBe("\n【天下大事】\n天宝八载六月：哥舒翰攻克石堡城（按史书；若【历史偏离】改变了它，以偏离为准）\n【历史偏离（这一世已经和史书不同的事）】\n- 李林甫提前罢相");
  });

  it("相关旧事 for the names in play and for what the player wrote", () => {
    const state = { people: [{ name: "王掌柜", aliases: ["掌柜"] }], cards: [], places: [], protagonist: { items: [] } } as unknown as WorldState;
    const node = (narrative: string) => ({ narrative } as StoryNode);
    const older = [{ node: node("你在西市旁的邸店醒来。王掌柜催你付九十文房钱。"), turn: 0 }, { node: node("你把两封密信藏进皮甲的夹层里，谁也没看见。"), turn: 3 }];
    const block = recallBlock(state, "王掌柜又来了", older, RECALL_BUDGET, "我取出藏在皮甲里的那两封信");
    expect(block.startsWith("\n【相关旧事】（早先的剧情里和眼下有关的句子）\n")).toBe(true);
    expect(block).toContain("- 第 3 回合：你把两封密信藏进皮甲的夹层里，谁也没看见。");
    expect(block).toContain("- 开场（王掌柜）：王掌柜催你付九十文房钱。");
  });
});
