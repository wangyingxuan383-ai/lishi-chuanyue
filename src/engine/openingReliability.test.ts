import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { Game, nativeFailReason } from "./game";
import { fakeLlm } from "./testing/fakeLlm";
import { newBinding } from "./sources/types";
import { saveBook } from "./sources/library";
import { exportWorldFile } from "./archive";

const model = { slot: "test", url: "https://fixture.invalid/v1/chat/completions", model: "mock", includeUsage: true };

describe("opening and recovery contracts", () => {
  it("all three opening helpers receive scoped original text without an extra model call", async () => {
    const llm = fakeLlm([{ text: JSON.stringify({ name: "陆白", premise: "青桥书铺", identity: "来客" }) }, { text: JSON.stringify({ line: "重逢", beats: ["书铺开门"], ending: "渡江" }) }, { text: JSON.stringify({ goal: "开门", limit: "一天", failIf: "" }) }]);
    const game = await Game.open(await createMemoryPlatform(llm), model);
    await saveBook(game.repo, { id: "original", title: "青桥", format: "txt", createdAt: "test", sections: [{ title: "书铺", text: "陆青是陆白的兄长，经营青桥边的书铺。" }, { title: "后来的秘密", text: "不能泄露的未来身份：渡江后成为掌门。" }] });
    const source = { ...newBinding("original", true), through: 0, instructions: "尊重兄弟关系，保留玩家分支" };
    const current = { mode: "free" as const, source, premise: "陆白走进书铺", identity: "访客" };
    await game.assist("补全身份", current);
    await game.draftScript(current);
    await game.draftChallenge(current);
    expect(llm.calls).toHaveLength(3);
    for (const call of llm.calls) {
      const content = JSON.stringify(call.body.messages);
      expect(content).toContain("陆青是陆白的兄长");
      expect(content).toContain(source.instructions);
      expect(content).not.toContain("不能泄露的未来身份");
      expect(content).not.toContain("[object Object]");
    }
    expect(source.through).toBe(0);
  });


  it("native archive errors stay actionable and never fall back to a second full export", async () => {
    const game = await Game.open(await createMemoryPlatform(), model);
    let attempts = 0;
    game.platform.files.exportWorld = async () => { attempts++; throw new Error("准备存档失败：参考书籍缺失"); };
    await expect(exportWorldFile(game.repo, "w", "书名")).rejects.toThrow("参考书籍缺失");
    expect(attempts).toBe(1);
    game.platform.files.exportWorld = async () => false;
    expect(await exportWorldFile(game.repo, "w", "书名")).toBe(false);
  });

  it("distinguishes local budgets, service refusals and technical waits", () => {
    expect(nativeFailReason("failed", "原著核对：请求装配超过14545字符预算")).toBe("config");
    expect(nativeFailReason("failed", "原著核对：AI服务拒绝本次内容")).toBe("refused");
    expect(nativeFailReason("failed", "写作：connection timeout")).toBe("timeout");
    expect(nativeFailReason("cancelled", "")).toBe("cancelled");
  });

  it.each([
    ["auth", "auth"], ["quota", "quota"], ["network", "network"], ["timeout", "timeout"],
    ["http", "http"], ["refused", "refused"], ["cancelled", "cancelled"], ["no_record", "no_record"],
    ["context", "config"], ["limit", "config"], ["stale", "config"], ["config", "config"], ["future-kind", "config"],
  ])("uses structured %s without guessing from contradictory text", (kind, expected) => {
    expect(nativeFailReason("failed", "拒绝 timeout HTTP 401 429 network 记录不完整", kind)).toBe(expected);
    expect(nativeFailReason("failed", null, kind)).toBe(expected);
  });

  it("preserves native detail and the old-record fallback in the shared failed event", async () => {
    const game = await Game.open(await createMemoryPlatform(), model);
    const snapshot = { id: "failed-run", worldId: "w", status: "failed", budget: { modelRequests: 1, toolCalls: 0, corrections: 0, activeMs: 10 },
      draft: {}, result: null, error: "原著核对：上下文窗口不足，服务拒绝输入", errorKind: "context", events: [] };
    expect(game["nativeFailure"](snapshot, "备用提示")).toEqual({ type: "failed", reason: "config", runId: "failed-run", detail: snapshot.error, partialSaved: false });
    expect(game["nativeFailure"]({ ...snapshot, errorKind: null, error: "连接中断" }, "备用提示").reason).toBe("network");
    expect(game["nativeFailure"]({ ...snapshot, error: null }, "备用提示").detail).toBe("备用提示");
  });
});
