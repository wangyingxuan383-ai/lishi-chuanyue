import { describe, expect, it, vi } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import type { ExecutionSnapshot, Platform, StreamEvent } from "../platform";
import { monthSpend } from "../ui/components/budgetMath";
import { fallbackEligible, Game } from "./game";
import { startRun, type RunPlan } from "./execution";
import { ChatError, type ChatResult } from "./llm/chat";
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

it("reconnects to an existing generation and stops only its observed attempt", async () => {
  vi.useFakeTimers();
  try {
    const events: string[] = [];
    const start = vi.fn(async () => "run");
    const resume = vi.fn(async () => {});
    const stop = vi.fn(async () => ({ executionId: "attempt", status: "running", accepted: true, settled: false }));
    const running: ExecutionSnapshot = { id: "run", worldId: "world", executionId: "attempt", stopRequested: false,
      status: "running", budget: { modelRequests: 1, toolCalls: 0, corrections: 0, activeMs: 1 },
      draft: null, result: null, error: null, events: [] };
    const snapshot = vi.fn()
      .mockRejectedValueOnce(new Error("lost observation"))
      .mockResolvedValueOnce(running)
      .mockResolvedValue({ ...running, status: "cancelled", stopRequested: true });
    const platform = { execution: { start, resume, snapshot, stop } } as unknown as Platform;
    const run = startRun(platform, { id: "run" } as RunPlan, (e) => { if (e.type === "execution-status") events.push(String(e.state)); });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["reconnecting"]);
    await vi.advanceTimersByTimeAsync(700);
    run.cancel();
    await vi.advanceTimersByTimeAsync(350);
    expect(events).toEqual(["reconnecting", "connected", "stop-requested"]);
    expect(stop).toHaveBeenCalledExactlyOnceWith("run", "attempt");
    expect(start).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    await expect(run.done).resolves.toMatchObject({ status: "cancelled" });
  } finally { vi.useRealTimers(); }
});

describe("备用服务接替的条件", () => {
  it("takes a reply cut off midway like the native core does, never a refusal of the key", () => {
    expect(fallbackEligible(new ChatError("stream", undefined, "写到一半"))).toBe(true);
    expect(fallbackEligible(new ChatError("network"))).toBe(true);
    expect(fallbackEligible(new ChatError("http", 503))).toBe(true);
    expect(fallbackEligible(new ChatError("http", 401))).toBe(false);
    expect(fallbackEligible(new ChatError("empty"))).toBe(false);
  });

  it("logs a helper's usage under the backup model when the backup answered", async () => {
    const platform = await createMemoryPlatform();
    platform.llm.stream = async (request, onEvent) => {
      if (request.url.startsWith("https://main.invalid")) { onEvent({ type: "error", kind: "network", message: "断网" } as StreamEvent); return "s"; }
      onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ text: "改好的设定" }) }, finish_reason: "stop" }] }) });
      onEvent({ type: "done" });
      return "s";
    };
    const game = await Game.open(platform, { slot: "main", url: "https://main.invalid/v1/chat/completions", model: "main-model", auxModel: "main-aux", includeUsage: true });
    game.fallbackLlm = { slot: "b", url: "https://backup.invalid/v1/chat/completions", model: "backup-model", includeUsage: true };
    const { world } = await game.repo.createWorld({ title: "试", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "开场。", state: sampleState() } });
    await game.reviseEntry(world.id, { label: "设定卡", name: "渡口", aliases: [], text: "一个渡口" }, "写具体些");
    const rows = await platform.sql.query("SELECT model, outcome FROM usage ORDER BY rowid");
    expect(rows.filter((r) => r.outcome === "ok").map((r) => r.model)).toEqual(["backup-model"]);
    expect(rows.filter((r) => r.outcome === "failed").every((r) => r.model === "main-aux")).toBe(true);
  });
});

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
      await expect(s.game.recoverPending()).resolves.toBeUndefined();
      expect(await s.game.repo.getSetting("pending", null)).toBeNull();
      expect(await s.platform.sql.query("SELECT key FROM settings WHERE key='pending'")).toEqual([]);
      await expect(s.game.recoverPending()).resolves.toBeUndefined();
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

  it("buffers pre-snapshot live events, forwards seq=0 thinking, and tears down listeners on detach", async () => {
    let emitLive: ((e: { seq: number; event: unknown }) => void) | null = null;
    let unsubscribed = false;
    let resolveSnap!: (s: ExecutionSnapshot) => void;
    const snapPromise = new Promise<ExecutionSnapshot>((resolve) => { resolveSnap = resolve; });
    const delivered: Record<string, unknown>[] = [];
    const platform = {
      execution: {
        start: async () => "run-live",
        resume: async () => {},
        stop: async () => ({ executionId: null, status: "cancelled", accepted: true, settled: true }),
        subscribe: (_id: string, cb: (e: { seq: number; event: unknown }) => void) => {
          emitLive = cb;
          return () => { unsubscribed = true; };
        },
        snapshot: () => snapPromise,
      },
    } as unknown as Platform;
    const handle = startRun(platform, { id: "run-live" } as RunPlan, (ev) => delivered.push(ev));
    await new Promise((r) => setTimeout(r, 0));
    // Live events arriving before the first snapshot resolves must be buffered, not skip seq=1.
    emitLive!({ seq: 0, event: { type: "thinking", deep: true } });
    emitLive!({ seq: 2, event: { type: "text", full: "第二帧" } });
    expect(delivered).toEqual([]);
    resolveSnap({
      id: "run-live", worldId: "w", executionId: "e1", stopRequested: false, status: "running",
      budget: { modelRequests: 1, toolCalls: 0, corrections: 0, activeMs: 1 },
      draft: null, result: null, error: null,
      events: [{ seq: 1, event: { type: "tool", tool: "search_original" } }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(delivered).toEqual([
      { type: "tool", tool: "search_original" },
      { type: "thinking", deep: true },
      { type: "text", full: "第二帧" },
    ]);
    handle.detach();
    expect(unsubscribed).toBe(true);
  });

  it("currentExecution exposes saved action so failed prompts survive retry and reopen, and retryRun preserves pre-depth settingsGuard", async () => {
    const s = await seed();
    const plans: Record<string, unknown>[] = [];
    const resumed: string[] = [];
    s.platform.execution = {
      agent: async () => null, settle: async () => null, list: async () => [],
      stop: async () => ({ executionId: null, status: "cancelled", accepted: true, settled: true }),
      resume: async (id) => { resumed.push(id); },
      start: async (plan) => { plans.push(plan as Record<string, unknown>); return `new-${plans.length}`; },
      snapshot: async (id) => ({ id, worldId: s.world.id, status: "failed", budget: { modelRequests: 1, toolCalls: 0, corrections: 0, activeMs: 1 }, draft: null, result: null, error: "模拟失败", events: [{ seq: 5, event: { type: "failed", reason: "http" } }] }),
    };
    const head = (await tree.cursor(s.game.repo, s.world.id)).head;
    const line = (await tree.cursor(s.game.repo, s.world.id)).line;
    // Simulate a legacy pre-depth settings_json (no "depth" key in worlds.settings_json).
    const liveSettings = JSON.parse(String((await s.platform.sql.query("SELECT settings_json FROM worlds WHERE id=?", [s.world.id]))[0].settings_json));
    delete liveSettings.depth;
    await s.platform.sql.batch([
      { sql: "UPDATE worlds SET settings_json=? WHERE id=?", params: [JSON.stringify(liveSettings), s.world.id] },
      {
        sql: "INSERT INTO execution_runs(id,world_id,line_id,base_head_id,status,plan_json,budget_json,draft_json,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        params: [
          "failed-run", s.world.id, line.id, head.id, "failed",
          JSON.stringify({
            id: "failed-run", worldId: s.world.id, lineId: line.id, headId: head.id, baseId: head.id, kind: "turn",
            model: { ...LLM, model: "old-model" },
            settings: liveSettings,
            action: { mode: "do", text: "去外院广场参加新生考核", directorNote: "重点写魂环展示" },
            meta: { settingsGuard: liveSettings, sourceGuard: null },
          }),
          "{}", "{}", "HTTP 500", new Date().toISOString(), new Date().toISOString(),
        ],
      },
      { sql: "INSERT INTO execution_steps(run_id,step_key,kind,status,input_json,output_json) VALUES('failed-run','model:1','writing:0','done','{}','{\"text\":\"ok\"}')", params: [] },
    ]);
    const saved = await s.game.currentExecution(s.world.id);
    expect(saved?.action).toEqual({ mode: "do", text: "去外院广场参加新生考核", directorNote: "重点写魂环展示" });
    // Retry with new model on a pre-depth world: settingsGuard stays aligned with live settings_json (no injected depth key).
    await s.game.retryRun("failed-run", () => {}).done;
    expect(resumed).toEqual(["failed-run"]);
    const updatedPlan = JSON.parse(String((await s.platform.sql.query("SELECT plan_json FROM execution_runs WHERE id='failed-run'"))[0].plan_json));
    expect("depth" in updatedPlan.meta.settingsGuard).toBe(false);
  });
});
