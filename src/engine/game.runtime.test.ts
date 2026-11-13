import { describe, expect, it, vi } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import type { Platform, StreamEvent } from "../platform";
import { monthSpend } from "../ui/components/budgetMath";
import { Game } from "./game";
import type { ChatResult } from "./llm/chat";
import { fakeLlm, type Script } from "./testing/fakeLlm";
import { sampleState } from "./testing/fixtures";
import * as tree from "./tree";

// These regressions use only memory SQLite and synthetic streams, never a credential store or server.
const LLM = { slot: "fake", url: "https://runtime-test.invalid/v1/chat/completions", model: "story", auxModel: "aux", includeUsage: true };
const SETTINGS = { mode: "free" as const, heroPanelEnabled: true, fortune: "off" as const, autoUpkeep: false, chapterEvery: 0, choiceCount: 0 };
const PRICES = { input: 10_000, output: 10_000, limit: 2.5 };
const errorScript = (kind: "http" | "network" | "no_secret" | "url_not_bound", status?: number): StreamEvent[] => [{ type: "error", kind, ...(status ? { status } : {}) }];

async function prepare(scripts: Script[] = []) {
  const llm = fakeLlm(scripts);
  const platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, { ...LLM });
  const notifications: { id: string; persisted: boolean }[] = [];
  platform.system.storyCommitted = async (id) => {
    const node = await game.repo.getNode(id.split(":")[1]);
    notifications.push({ id, persisted: node?.status === "ok" });
  };
  return { llm, platform, game, notifications };
}
async function seed(scripts: Script[] = []) {
  const s = await prepare(scripts);
  const state = sampleState();
  state.era = { mode: "free", clockStyle: "elapsed", packId: null };
  state.protagonist.panel = "潜水：熟练";
  const world = await s.game.repo.createWorld({ title: "远航", eraId: "free", settings: SETTINGS,
    opening: { parentId: null, kind: "opening", narrative: "你推开船舱的门。", state } });
  return { ...s, ...world, state };
}
async function rows(platform: Platform) {
  return platform.sql.query("SELECT purpose, model, prompt_tokens, completion_tokens, estimated, outcome FROM usage ORDER BY rowid");
}

describe("auxiliary request accounting", () => {
  it.each(["play", "regenerate", "autoplay", "resumeInterrupted", "ask", "createWorld"] as const)("rejects %s when the native execution core is missing", async (method) => {
    const s = await seed();
    const invoke = (): unknown => {
      switch (method) {
        case "play": return s.game.play(s.world.id, { mode: "continue", text: "" }, () => {});
        case "regenerate": return s.game.regenerate(s.world.id, null, () => {});
        case "autoplay": return s.game.autoplay(s.world.id, { turns: 1 }, () => {});
        case "resumeInterrupted": return s.game.resumeInterrupted(s.world.id, () => {});
        case "ask": return s.game.ask(s.world.id, "船在哪？", () => {});
        case "createWorld": return s.game.createWorld({ title: "新故事", eraId: null, settings: {}, protagonist: { name: "旅人", gender: "男", age: 20, identity: "来客" }, arrival: "不穿越", origin: "", opening: { mode: "ai", hint: "" } }, () => {});
      }
    };
    await expect(Promise.resolve().then(invoke)).rejects.toEqual(new Error("当前环境未连接原生执行核心"));
    expect(s.llm.calls).toHaveLength(0);
    expect(await rows(s.platform)).toEqual([]);
    expect((await tree.cursor(s.game.repo, s.world.id)).head.id).toBe(s.node.id);
    expect(await s.game.repo.listWorlds()).toHaveLength(1);
  });

  it("clears legacy pending data once without resuming a TS stream or saving a turn", async () => {
    const s = await seed();
    await s.game.repo.setSetting("pending", { worldId: s.world.id, streamId: "legacy", parentId: s.node.id, kind: "turn", action: { mode: "continue", text: "" } });
    const resume = vi.spyOn(s.llm, "resume"), ack = vi.spyOn(s.llm, "ack");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await s.game.recoverPending()).toBeNull();
      expect(await s.game.repo.getSetting("pending", null)).toBeNull();
      expect(await s.platform.sql.query("SELECT key FROM settings WHERE key='pending'")).toEqual([]);
      expect(await s.game.recoverPending()).toBeNull();
      expect(warning).toHaveBeenCalledExactlyOnceWith("已清除旧版 TS 回合待恢复数据，不再尝试恢复");
      expect(resume).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
      expect((await tree.cursor(s.game.repo, s.world.id)).head.id).toBe(s.node.id);
      expect(await rows(s.platform)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("records retry failures in other Game.call consumers without duplicating their final row", async () => {
    const s = await seed([errorScript("http", 503), { text: JSON.stringify({ cards: [{ kind: "设定", name: "停泊", content: "船在港口。" }] }) }]);
    expect(await s.game.organize(s.world.id)).not.toBeNull();
    expect((await rows(s.platform)).map((r) => r.outcome)).toEqual(["failed", "ok"]);
    expect(await monthSpend(s.platform, PRICES)).toMatchObject({ calls: 2, unknown: 1, knownCost: 1.5 });
  });

  it("codex distinguishes real failures from unsent credential/binding failures", async () => {
    const purpose = "codex";
    for (const failure of ["http", "no_secret", "url_not_bound"] as const) {
      const s = await seed([errorScript(failure, failure === "http" ? 503 : undefined), errorScript(failure, failure === "http" ? 503 : undefined)]);
      expect(await s.game.organize(s.world.id)).toBeNull();
      const usage = await rows(s.platform);
      expect(usage).toHaveLength(failure === "http" ? 2 : 0);
      expect(usage.every((r) => r.purpose === purpose && r.outcome === "failed" && r.prompt_tokens === null && r.completion_tokens === null)).toBe(true);
      expect(s.llm.calls).toHaveLength(failure === "http" ? 2 : 1);
      expect(s.notifications).toEqual([]);
    }
  });

  it("marks a partially reported token count as estimated (compatible with nullable ChatUsage)", async () => {
    const s = await seed();
    // Exercise the Game usage boundary independently of the parser fix landing on main.
    const result = { text: "完成。", finishReason: "stop", firstTokenMs: 1, totalMs: 2,
      usage: { promptTokens: 100, completionTokens: null } } as unknown as ChatResult;
    await s.platform.sql.batch([s.game["usage"](s.world.id, s.node.id, "turn", result, "ok", "story")]);
    expect((await rows(s.platform))[0]).toMatchObject({ prompt_tokens: 100, completion_tokens: null, estimated: 1 });
    expect(await monthSpend(s.platform, PRICES)).toMatchObject({ calls: 1, unknown: 1, knownCost: null });
  });
});
