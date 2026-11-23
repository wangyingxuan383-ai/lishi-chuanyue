import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { eraContext, eraPack } from "./era";
import { packCards } from "./era/card";
import { Game } from "./game";
import { applyRecord } from "./state/apply";
import { sampleState } from "./testing/fixtures";
import { fakeLlm } from "./testing/fakeLlm";
import { packTimeline } from "./timeline";
import { newId } from "./db/repo";
import { appendContinuity } from "./continuity";
import { saveBook } from "./sources/library";
import { getNote, noteWithinScope } from "./sources/notes";
import {
  BUILTIN_PERSONAS,
  CompanionClient,
  draftSetupFromCompanionText,
  escalateCompanionToAgent,
  exportPersonaJson,
  followCompanionRun,
  getOrCreateSession,
  parsePersonaJson,
  personaFromStoryPerson,
  resolveCompanionAgentPolicy,
  resolveEscalatedAgentModel,
  resolveSessionDraftSource,
  saveCompanionMessageAsNote,
  steerCompanionAgent,
  stopCompanionRun,
} from "./companion";

const LLM = {
  slot: "main",
  url: "https://api.example.invalid/v1/chat/completions",
  model: "main-model",
  auxModel: "aux-model",
  includeUsage: true,
};

async function createWorldFixture(scripts: Parameters<typeof fakeLlm>[0] = []) {
  const llm = fakeLlm(scripts);
  const platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, LLM);
  const pack = eraPack("tang-748")!;
  const seed = sampleState();
  seed.version = 2;
  seed.time = { start: "天宝七载 冬月十七", date: structuredClone(pack.start.date), startHour: 7, elapsedMinutes: 0 };
  seed.protagonist.name = "李安";
  seed.protagonist.origin = "现代顶尖心外科主任";
  seed.protagonist.cheat = "随身纳米医疗箱";
  seed.protagonist.panel = "隐藏面板：寿元九十九年";
  seed.protagonist.identity = "你是落第举子，暂居西市邸店。";
  Object.assign(seed, packCards(pack));
  const applied = applyRecord(
    seed,
    {
      place: "西市邸店",
      people: [
        { name: "王掌柜", role: "邸店掌柜", attitude: "友善", note: "正在算账" },
        { name: "沈捕头", role: "万年县捕头", attitude: "冷淡", note: "暗查失窃案" },
      ],
      goals: [{ op: "add", name: "凑齐九十文房钱" }],
    },
    { mode: "do", difficulty: "标准", currency: pack.currency },
    { advanceTime: false },
  ).state;
  applied.timeline = packTimeline(pack.timeline, eraContext(pack.id, applied).clock).map((e) => ({
    id: newId(),
    ...e,
  }));
  const { world, node, line } = await game.repo.createWorld({
    title: "天宝长安",
    eraId: pack.id,
    settings: { premise: "天宝七载冬，长安风雪。" },
    opening: {
      parentId: null,
      kind: "opening",
      narrative: "风雪夜，王掌柜看见李安从后院捡起半块铜符；沈捕头独自在暗巷发现了密信。",
      state: applied,
      meta: { setup: { arrival: "魂穿", hint: "", organize: false } },
    },
  });
  await game.repo.addPin(world.id, node.id, "玩家备忘：王掌柜其实不识字，密信在屋檐下");
  return { platform, llm, game, world, openingNode: node, line };
}

describe("Companion engine (R33-T001..T003)", () => {
  it("supports built-in + custom persona CRUD, overrides/reset, and .persona.json export/import validation", async () => {
    const { game } = await createWorldFixture();
    const client = new CompanionClient(game);

    // Built-ins exist without writing rows to companion_personas on init:
    const initial = await client.listPersonas();
    expect(initial.map((p) => p.id)).toEqual(BUILTIN_PERSONAS.map((p) => p.id));
    const [dbCount] = await game.platform.sql.query("SELECT COUNT(*) AS n FROM companion_personas");
    expect(Number(dbCount.n)).toBe(0);

    // Customize a built-in persona, then reset it back to factory default:
    const customized = await client.savePersona({
      id: "builtin:lingxi",
      name: "灵犀·长卷版",
      systemPrompt: "用温润半文半白交流。",
      roleKind: "assistant",
      memoryScope: "persona",
    });
    expect(customized.builtin).toBe(true);
    expect(customized.customized).toBe(true);

    const reset = await client.deletePersona("builtin:lingxi");
    expect(reset).toEqual({ id: "builtin:lingxi", deleted: false, resetBuiltin: true });
    expect((await client.getPersona("builtin:lingxi")).name).toBe("灵犀");

    // Custom persona + .persona.json export/import strips local source IDs & mints fresh ID:
    const custom = await client.savePersona({
      name: "裴先生",
      avatar: "裴",
      tagline: "长安老幕僚",
      roleKind: "npc",
      systemPrompt: "你是裴先生，说话滴水不漏。",
      greeting: "请坐。",
      starters: ["先生如何看今日朝局？"],
      styleNotes: "老练克制",
      memoryScope: "persona",
      pureRoleplay: true,
      sourceWorldId: "secret-local-world",
      sourcePersonId: "secret-person",
      sourceHeadId: "secret-node",
    });
    const rawJson = exportPersonaJson(custom);
    expect(rawJson).not.toContain("secret-local-world");
    expect(rawJson).toContain('"format": "lishi-persona-v1"');

    const imported = await client.importPersona(rawJson);
    expect(imported.id).not.toBe(custom.id);
    expect(imported.id.startsWith("builtin:")).toBe(false);
    expect(imported.name).toBe("裴先生");
    expect(imported.roleKind).toBe("roleplay");
    expect(imported.pureRoleplay).toBe(true);

    // Reject invalid JSON, unsupported versions, and missing fields:
    expect(() => parsePersonaJson("{broken")).toThrow(/JSON/);
    expect(() => parsePersonaJson(JSON.stringify({ format: "unknown-v9", persona: {} }))).toThrow(/版本/);
    expect(() => parsePersonaJson(JSON.stringify({ name: "无提示词", systemPrompt: "   " }))).toThrow(/提示词/);
  });

  it("manages tree-structured messages: send, regenerate sibling, edit user message fork, and switch active branch", async () => {
    const { game } = await createWorldFixture([
      { text: "第一版回复：先走西市。" },
      { text: "第二版重答：改走东市。" },
      { text: "分叉后的新回复：留在邸店。" },
    ]);
    const client = new CompanionClient(game);
    const created = await client.createSession({ title: "路线推演", personaId: "builtin:editor" });
    const sid = created.session.id;

    // 1. Normal send:
    const r1 = await client.send({ sessionId: sid, text: "第一步去哪？" });
    let snap = await client.snapshot(r1.runId, 0, 500);
    while (!snap.done) snap = await client.snapshot(r1.runId, snap.seq, 500);
    expect(snap.content).toBe("第一版回复：先走西市。");

    // 2. Regenerate assistant reply -> creates sibling under same user message:
    const r2 = await client.send({ sessionId: sid, regenerateMessageId: r1.assistantMessage.id });
    snap = await client.snapshot(r2.runId, 0, 500);
    while (!snap.done) snap = await client.snapshot(r2.runId, snap.seq, 500);

    const afterRegen = await client.getSessionDetail(sid);
    expect(afterRegen.messages).toHaveLength(2);
    expect(afterRegen.messages[1].content).toBe("第二版重答：改走东市。");
    expect(afterRegen.messages[1].branch).toEqual({
      branchIndex: 1,
      branchCount: 2,
      siblingIds: [r1.assistantMessage.id, r2.assistantMessage.id],
    });

    // 3. Edit user message -> forks root user message and replies on new branch:
    const r3 = await client.send({
      sessionId: sid,
      editMessageId: r1.userMessage!.id,
      text: "如果不出门呢？",
    });
    snap = await client.snapshot(r3.runId, 0, 500);
    while (!snap.done) snap = await client.snapshot(r3.runId, snap.seq, 500);

    const afterEdit = await client.getSessionDetail(sid);
    expect(afterEdit.messages).toHaveLength(2);
    expect(afterEdit.messages[0].content).toBe("如果不出门呢？");
    expect(afterEdit.messages[0].branch).toEqual({
      branchIndex: 1,
      branchCount: 2,
      siblingIds: [r1.userMessage!.id, r3.userMessage!.id],
    });
    expect(afterEdit.messages[1].content).toBe("分叉后的新回复：留在邸店。");

    // 4. Switch back to original user message -> restores deepest latest leaf (r2), then switch to r1:
    const backToU1 = await client.switchBranch(sid, r1.userMessage!.id);
    expect(backToU1.messages[0].id).toBe(r1.userMessage!.id);
    expect(backToU1.messages[1].id).toBe(r2.assistantMessage.id);

    const backToA1 = await client.switchBranch(sid, r1.assistantMessage.id);
    expect(backToA1.messages[1].id).toBe(r1.assistantMessage.id);
    expect(backToA1.messages[1].branch?.branchIndex).toBe(0);
  });

  it("preserves chat history across repo.deleteWorld (soft boundWorldId) and wraps legacy pi_sessions", async () => {
    const { game, world, line } = await createWorldFixture([{ text: "这条闲聊在删档后也必须还在。" }]);
    const client = new CompanionClient(game);

    // Insert a legacy 0.19.1 unlinked `pi_sessions` row:
    await game.platform.sql.batch([
      {
        sql: "INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        params: ["legacy-pi-1", world.id, line.id, "0.19.1历史修改记录", "2026-11-20T00:00:00Z", "2026-11-20T01:00:00Z"],
      },
    ]);

    const listedBefore = await client.listSessions({ worldId: world.id });
    expect(listedBefore.sessions.some((s) => s.id === "pi:legacy-pi-1" && s.legacyPi)).toBe(true);

    const sessionDetail = await client.createSession({
      title: "长安盘道",
      boundWorldId: world.id,
      boundLineId: line.id,
    });
    const sent = await client.send({ sessionId: sessionDetail.session.id, text: "聊聊西市" });
    let snap = await client.snapshot(sent.runId, 0, 500);
    while (!snap.done) snap = await client.snapshot(sent.runId, snap.seq, 500);

    // Permanently delete the world!
    await game.repo.deleteWorld(world.id);
    expect(await game.repo.getWorld(world.id)).toBeNull();

    // Companion session & messages survive completely intact!
    const survived = await client.getSessionDetail(sessionDetail.session.id);
    expect(survived.session.boundWorldId).toBe(world.id);
    expect(survived.messages).toHaveLength(2);
    expect(survived.messages[1].content).toBe("这条闲聊在删档后也必须还在。");
  });

  it("enforces KnowledgeRecords fence in personaFromStoryPerson without leaking protagonist cheat/origin or other NPCs' secrets", async () => {
    const { game, world, openingNode } = await createWorldFixture();
    const state = await game.repo.getState(openingNode.id);
    const wang = state.people.find((p) => p.name === "王掌柜")!;
    const shen = state.people.find((p) => p.name === "沈捕头")!;

    await appendContinuity(game, world.id, openingNode.id, {
      knowledge: [
        {
          id: "k-wang-copper",
          person: wang.id,
          claim: "李安在后院捡起了半块铜符",
          awareness: "witnessed",
          source: { nodeId: openingNode.id, from: "narrative", quote: "王掌柜看见李安从后院捡起半块铜符" },
        },
        {
          id: "k-wang-inactive",
          person: wang.id,
          claim: "已澄清的旧误会不应出现",
          awareness: "rumor",
          active: false,
          source: { nodeId: openingNode.id, from: "narrative", quote: "王掌柜" },
        },
        {
          id: "k-shen-secret",
          person: shen.id,
          claim: "暗巷密信里写着右相暗桩名单",
          awareness: "witnessed",
          source: { nodeId: openingNode.id, from: "narrative", quote: "沈捕头独自在暗巷发现了密信" },
        },
      ],
      threads: [
        {
          id: "t-secret-plot",
          kind: "clue",
          title: "三日后刺杀密谋",
          detail: "不可泄露给王掌柜的幕后线索",
          status: "open",
          source: { nodeId: openingNode.id, from: "narrative", quote: "暗巷发现了密信" },
        },
      ],
    });

    const npcPersona = await personaFromStoryPerson(game, world.id, wang.id);
    expect(npcPersona.pureRoleplay).toBe(true);
    expect(npcPersona.roleKind).toBe("npc");
    expect(npcPersona.systemPrompt).toContain("李安在后院捡起了半块铜符");
    expect(npcPersona.systemPrompt).toContain("亲眼所见");

    // Strictly verify ZERO leakage of inactive knowledge, other NPC secrets, protagonist cheat/origin/panel, pins, threads, or timeline!
    expect(npcPersona.systemPrompt).not.toContain("已澄清的旧误会不应出现");
    expect(npcPersona.systemPrompt).not.toContain("右相暗桩名单");
    expect(npcPersona.systemPrompt).not.toContain("心外科主任");
    expect(npcPersona.systemPrompt).not.toContain("纳米医疗箱");
    expect(npcPersona.systemPrompt).not.toContain("寿元九十九年");
    expect(npcPersona.systemPrompt).not.toContain("王掌柜其实不识字");
    expect(npcPersona.systemPrompt).not.toContain("三日后刺杀密谋");
    expect(npcPersona.systemPrompt).not.toContain("安禄山");
  });

  it("isolates persona vs global memories, preserves `through` spoiler fence on saveCompanionMessageAsNote, and bridges setup & Agent escalation", async () => {
    const { game, world, openingNode, line } = await createWorldFixture();
    const client = new CompanionClient(game);

    // 1. Scoped vs global memories:
    await client.saveMemory({ scope: "global", category: "preference", content: "全局偏好：少用感叹号", pinned: true });
    await client.saveMemory({ scope: "persona", personaId: "builtin:lingxi", category: "fact", content: "灵犀专属：正在规划河西走廊线" });
    await client.saveMemory({ scope: "persona", personaId: "builtin:tavern", category: "relation", content: "茶寮专属：存了一坛竹叶青" });

    const forLingxi = await client.activeMemoriesForPersona("builtin:lingxi", "persona");
    expect(forLingxi.map((m) => m.content)).toEqual([
      "全局偏好：少用感叹号",
      "灵犀专属：正在规划河西走廊线",
    ]);
    expect(await client.activeMemoriesForPersona("builtin:lingxi", "off")).toEqual([]);

    // 2. Bind a 3-chapter source book to the world with `through: 0` (Chapter 1 ceiling):
    await saveBook(game.repo, {
      id: "book-1",
      title: "剑起陇右",
      format: "txt",
      createdAt: "2026-11-23T00:00:00Z",
      sections: [
        { title: "第一章 边城风雪", text: "陈玄在边城铁匠铺打造了一柄寒铁短刀。" },
        { title: "第二章 驿站夜袭", text: "驿站外马蹄声急。" },
        { title: "第三章 幕后真凶", text: "全书结局大剧透：节度使才是幕后主使。" },
      ],
    });
    const curState = await game.repo.getState(openingNode.id);
    curState.source = { bookId: "book-1", through: 0, position: 0, fanfic: true, plot: "canon", method: "search", instructions: "" };
    await game.repo.appendNode(world.id, line.id, {
      parentId: openingNode.id,
      kind: "turn",
      actionMode: "do",
      actionText: "打听边城消息",
      narrative: "你在邸店听人谈起边城。",
      state: curState,
    });

    const bookSession = await client.createSession({
      title: "原著考据",
      boundWorldId: world.id,
      boundLineId: line.id,
      activeGear: "research",
    });
    // Message mentions "第三章" in text, plus a valid section 0 citation and an out-of-bounds section 2 citation:
    const savedNote = await saveCompanionMessageAsNote(
      game,
      bookSession.session,
      {
        id: "msg-note-1",
        content: "# 寒铁短刀考据\n第一章陈玄打造了寒铁短刀（至于第三章还没读到）。",
        citations: [
          { kind: "book", bookId: "book-1", title: "第一章 边城风雪", section: 0, chunk: 0, quote: "寒铁短刀" },
          { kind: "book", bookId: "book-1", title: "第三章 幕后真凶", section: 2, chunk: 2, quote: "剧透" },
        ],
      },
    );
    expect(savedNote.bookId).toBe("book-1");
    expect(savedNote.worldId).toBe(world.id);
    expect(savedNote.scope.through).toBe(0);
    expect(savedNote.refs).toEqual([0]);
    expect(noteWithinScope(savedNote, 0, true)).toBe(true);
    const storedNote = await getNote(game.repo, savedNote.id);
    expect(storedNote?.scope.through).toBe(0);

    // 3. Bridge 1: draftSetupFromCompanionText:
    const draft = draftSetupFromCompanionText(
      `标题：《陇右孤城》
故事设定：大唐天宝末年，陇右道烽燧告警，孤城粮尽。
主角姓名：沈砚
性别：女
年龄：19
身份：你是戍边折冲府的一名女医工，精通金疮包扎。
穿越方式：魂穿
前世：急诊科护士
开场：暴雪封山之夜，斥候浑身是血撞开营门。
要点：城中存粮仅够七日`,
      "青灯编修",
    );
    expect(draft).toMatchObject({
      mode: "history",
      title: "陇右孤城",
      name: "沈砚",
      gender: "女",
      age: 19,
      arrival: "魂穿",
      origin: "急诊科护士",
    });
    expect(draft.identity).toContain("女医工");

    // 4. Bridge 3: escalateCompanionToAgent creates/reuses pi_session_id, keeps AI prose & research prompts out of task.text, honors prefs.modelName, and records piTaskId:
    await client.appendMessage(bookSession.session.id, {
      role: "user",
      gear: "research",
      content: "请作为原著考据助手，自行定位已导入的参考书，批量搜索并阅读相关原文（此句为查证模板，不应混入改档任务）",
    });
    await client.appendMessage(bookSession.session.id, {
      role: "user",
      gear: "chat",
      content: "我想给王掌柜补一句会打算盘的备注",
    });
    await client.appendMessage(bookSession.session.id, {
      role: "assistant",
      content: "AI助手建议：还可以顺便把他的银两改成九千两（此句为AI建议，绝不能当成玩家原话依据！）",
    });
    await game.repo.setSetting("agent:preferences", {
      policy: "preview",
      modelName: "dedicated-agent-model",
      thinkingMode: "off",
      skills: [],
      customSkills: [],
      network: { mode: "auto" },
      limits: { modelRequests: 0, toolCalls: 0, activeMs: 0 },
      limitsVersion: 2,
      inputTokens: 475_000,
      inputBudgetVersion: 2,
    });

    const capturedAgentCalls: Record<string, unknown>[] = [];
    game.platform.execution = {
      async agent(req): Promise<import("../platform").Json> {
        const r = req as Record<string, unknown>;
        capturedAgentCalls.push(r);
        if (r.op === "create") {
          return {
            id: "pi-sess-new",
            worldId: String(r.worldId),
            lineId: String(r.lineId),
            title: String(r.title ?? ""),
            createdAt: "2026-11-23T00:00:00Z",
            updatedAt: "2026-11-23T00:00:00Z",
          };
        }
        if (r.op === "session") {
          return {
            session: {
              id: String(r.id),
              worldId: world.id,
              lineId: line.id,
              title: "伴聊协作",
              createdAt: "2026-11-23T00:00:00Z",
              updatedAt: "2026-11-23T00:00:00Z",
            },
            messages: [],
            tasks: [],
          };
        }
        if (r.op === "start") {
          return { taskId: "pi-task-99", runId: "pi-task-99" };
        }
        throw new Error(`unexpected op ${String(r.op)}`);
      },
      settle: async () => ({}),
      start: async () => "run",
      snapshot: async () => ({ id: "run", worldId: world.id, status: "committed", budget: { modelRequests: 0, toolCalls: 0, corrections: 0, activeMs: 0 }, draft: {}, result: null, error: null, events: [] }),
      list: async () => [],
      stop: async () => ({ executionId: null, status: "cancelled", accepted: true, settled: true }),
      resume: async () => {},
    };

    const escalated = await escalateCompanionToAgent(game, {
      sessionId: bookSession.session.id,
      text: "按我上面说的，只给王掌柜补上会打算盘的备注",
      policy: "preview",
    });
    expect(escalated.piSessionId).toBe("pi-sess-new");
    expect(escalated.taskId).toBe("pi-task-99");
    expect(escalated.agentMessage.piTaskId).toBe("pi-task-99");
    expect(escalated.agentMessage.gear).toBe("agent");
    expect(escalated.agentMessage.modelId).toBe("dedicated-agent-model");

    const startCall = capturedAgentCalls.find((c) => c.op === "start")!;
    const sentTaskText = String(startCall.text);
    expect(sentTaskText).toContain("我想给王掌柜补一句会打算盘的备注");
    expect(sentTaskText).not.toContain("九千两");
    expect(sentTaskText).not.toContain("原著考据助手");
    expect((startCall.model as Record<string, unknown>).model).toBe("dedicated-agent-model");

    // Self-contained explicit edit request (>= 40 chars without back-references) skips prior chat lines:
    capturedAgentCalls.length = 0;
    const explicitRequest = "请直接在设定集中新增一张势力卡「玄鸟司」，说明它是北梁负责边镇密谍的暗卫机构，不要改动其他人物状态。";
    await escalateCompanionToAgent(game, {
      sessionId: bookSession.session.id,
      text: explicitRequest,
      policy: "preview",
    });
    const explicitStart = capturedAgentCalls.find((c) => c.op === "start")!;
    expect(explicitStart.text).toBe(explicitRequest);

    const updatedDetail = await client.getSessionDetail(bookSession.session.id);
    expect(updatedDetail.session.piSessionId).toBe("pi-sess-new");
    expect(updatedDetail.session.activeGear).toBe("agent");
  });

  it("self-heals orphan streaming messages on getSessionDetail while supporting live followCompanionRun and sessionId stop", async () => {
    let releaseStream!: () => void;
    const gate = new Promise<void>((resolve) => { releaseStream = resolve; });
    const { game } = await createWorldFixture();
    const client = new CompanionClient(game);

    const created = await client.createSession({
      title: "断流自愈",
      metadata: { activeRunId: "stale-orphan-run" },
    });
    const sid = created.session.id;

    // 1. Insert an orphan `streaming` row with no active run in memory:
    await client.appendMessage(sid, {
      id: "orphan-stream-1",
      role: "assistant",
      gear: "chat",
      status: "streaming",
      content: "崩溃前只写了一半",
      steps: [{ id: "st-1", tool: "search_original", label: "检索原著原文", status: "running", summary: "正在查阅…" }],
    });

    const healed = await client.getSessionDetail(sid);
    expect(healed.activeRunId).toBeNull();
    expect(healed.session.activeRunId).toBeNull();
    expect(healed.session.metadata.activeRunId).toBeUndefined();
    expect(healed.messages[0].status).toBe("interrupted");
    expect(healed.messages[0].content).toBe("崩溃前只写了一半");
    expect(healed.messages[0].steps[0].status).toBe("failed");

    // 2. Start a real in-flight streaming run, verify getSessionDetail keeps it `streaming` + exposes `activeRunId`,
    //    attach via `followCompanionRun`, and stop via `stopCompanionRun({ sessionId })` even without the original handle!
    game.platform.llm.cancel = async () => {
      releaseStream();
    };
    game.platform.llm.stream = async (_req, onEvent) => {
      void (async () => {
        onEvent({
          type: "data",
          data: JSON.stringify({ choices: [{ delta: { content: "正在持续流式输出…" }, finish_reason: null }] }),
        });
        await gate;
        onEvent({ type: "done" });
      })();
      return "live-stream-1";
    };

    const started = await client.send({ sessionId: sid, text: "重新进入会话测试" });
    await new Promise((r) => setTimeout(r, 20));

    const reentered = await client.getSessionDetail(sid);
    expect(reentered.activeRunId).toBe(started.runId);
    expect(reentered.session.activeRunId).toBe(started.runId);
    expect(reentered.messages.at(-1)?.status).toBe("streaming");

    const observedFrames: string[] = [];
    const attached = followCompanionRun(game, sid, started.runId, (u) => {
      if (u.text) observedFrames.push(u.text);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(observedFrames).toContain("正在持续流式输出…");

    const stopped = await stopCompanionRun(game, { sessionId: sid });
    releaseStream();
    expect(stopped.accepted).toBe(true);
    const finalSnap = await attached.done;
    expect(finalSnap.status).toBe("cancelled");

    const afterStop = await client.getSessionDetail(sid);
    expect(afterStop.activeRunId).toBeNull();
    expect(afterStop.messages.at(-1)?.status).toBe("cancelled");
  });

  it("handles relative baseUrl safely, inherits agentAdoptionMode, keeps failed agent escalation atomic, and steers active runs", async () => {
    const { game, world, line } = await createWorldFixture();
    const client = new CompanionClient(game);
    const sess = await client.createSession({
      title: "改档健壮性",
      boundWorldId: world.id,
      boundLineId: line.id,
    });

    // Relative dev-proxy base URL (`/v1`) must NEVER throw `TypeError: Invalid URL` across non-chat-completions protocols:
    game.llm = {
      ...LLM,
      url: "/v1",
      model: "proxy-main",
    };
    const basePrefs = {
      policy: "preview" as const,
      thinkingMode: "off" as const,
      skills: [],
      customSkills: [],
      network: { mode: "off" as const },
      limits: { modelRequests: 0, toolCalls: 0, activeMs: 0 },
      limitsVersion: 2 as const,
      inputTokens: 475_000,
      inputBudgetVersion: 2 as const,
    };
    const respModel = await resolveEscalatedAgentModel(game, { ...basePrefs, protocol: "openai-responses" });
    expect(respModel.url).toBe("/v1/responses");
    const anthModel = await resolveEscalatedAgentModel(game, { ...basePrefs, protocol: "anthropic" });
    expect(anthModel.url).toBe("/v1/messages");
    const gemModel = await resolveEscalatedAgentModel(game, { ...basePrefs, protocol: "gemini" });
    expect(gemModel.url).toBe("/v1/models/proxy-main:streamGenerateContent?alt=sse");

    // Default adoption policy when unset is `"preview"` ("review"), and `"agentAdoptionMode": "auto"` maps to `"auto"`:
    expect(await resolveCompanionAgentPolicy(game)).toBe("preview");
    await game.repo.setSetting("agentAdoptionMode", "auto");
    expect(await resolveCompanionAgentPolicy(game)).toBe("auto");
    await game.repo.setSetting("agentAdoptionMode", "review");
    expect(await resolveCompanionAgentPolicy(game)).toBe("preview");
    await game.repo.setSetting("agentAdoptionMode", "auto");
    await game.repo.setSetting("agent:preferences", { ...basePrefs, protocol: "openai-responses" });

    let failStart = true;
    const agentCalls: Record<string, unknown>[] = [];
    game.platform.execution = {
      async agent(req): Promise<import("../platform").Json> {
        const r = req as Record<string, unknown>;
        agentCalls.push(r);
        if (r.op === "create") {
          return {
            id: "pi-atomic-1",
            worldId: world.id,
            lineId: line.id,
            title: "伴聊协作",
            createdAt: "2026-11-24T00:00:00Z",
            updatedAt: "2026-11-24T00:00:00Z",
          };
        }
        if (r.op === "session") {
          return {
            session: {
              id: String(r.id),
              worldId: world.id,
              lineId: line.id,
              title: "伴聊协作",
              createdAt: "2026-11-24T00:00:00Z",
              updatedAt: "2026-11-24T00:00:00Z",
            },
            messages: [],
            tasks: [],
          };
        }
        if (r.op === "start") {
          if (failStart) throw new Error("当前故事正忙，暂时无法启动改档");
          return { taskId: "pi-task-live", runId: "pi-task-live" };
        }
        if (r.op === "enqueue_input" || r.op === "enqueue") {
          return { id: "inp-1", delivery: "steer", status: "accepted" };
        }
        throw new Error(`unexpected op ${String(r.op)}`);
      },
      settle: async () => ({}),
      start: async () => "run",
      snapshot: async () => ({ id: "run", worldId: world.id, status: "committed", budget: { modelRequests: 0, toolCalls: 0, corrections: 0, activeMs: 0 }, draft: {}, result: null, error: null, events: [] }),
      list: async () => [],
      stop: async () => ({ executionId: null, status: "cancelled", accepted: true, settled: true }),
      resume: async () => {},
    };

    // 1. Failed `agent.start` must NEVER leave any dead agent card or orphan user message in `companion_messages`!
    await expect(
      escalateCompanionToAgent(game, {
        sessionId: sess.session.id,
        text: "给王掌柜加一把算盘",
      }),
    ).rejects.toThrow("当前故事正忙");
    const afterFailedStart = await client.getSessionDetail(sess.session.id);
    expect(afterFailedStart.messages).toHaveLength(0);

    // 2. Successful start with relative `/v1` endpoint + inherited `agentAdoptionMode = "auto"`:
    failStart = false;
    agentCalls.length = 0;
    const ok = await escalateCompanionToAgent(game, {
      sessionId: sess.session.id,
      text: "给王掌柜加一把算盘",
    });
    expect(ok.piSessionId).toBe("pi-atomic-1");
    expect(ok.agentMessage.piTaskId).toBe("pi-task-live");
    const startReq = agentCalls.find((c) => c.op === "start")!;
    expect(startReq.policy).toBe("auto");
    expect((startReq.model as Record<string, unknown>).model).toBe("proxy-main");

    // 3. Follow-up message while Pi task is active steers the existing session instead of calling `start` again:
    agentCalls.length = 0;
    const steered = await steerCompanionAgent(game, {
      sessionId: sess.session.id,
      piSessionId: ok.piSessionId,
      taskId: ok.taskId,
      text: "顺便注明算盘是紫檀木的",
    });
    expect(steered.delivery).toBe("steer");
    expect(agentCalls.some((c) => c.op === "start")).toBe(false);
    const enqueueCall = agentCalls.find((c) => c.op === "enqueue_input" || c.op === "enqueue")!;
    expect(enqueueCall.taskId ?? enqueueCall.id).toBe("pi-task-live");
    expect(enqueueCall.text).toBe("顺便注明算盘是紫檀木的");
    const afterSteer = await client.getSessionDetail(sess.session.id);
    expect(afterSteer.messages.at(-2)?.content).toBe("顺便注明算盘是紫檀木的");
    expect(afterSteer.messages.at(-1)?.role).toBe("system_note");
  });

  it("preserves spoiler ceiling `through`, `position`, `fanfic`, `plot`, and `instructions` when drafting a new game", async () => {
    const { game, world, line } = await createWorldFixture();
    const client = new CompanionClient(game);

    await saveBook(game.repo, {
      id: "book-ceiling",
      title: "长安暗潮",
      format: "txt",
      createdAt: "2026-11-24T00:00:00Z",
      sections: Array.from({ length: 6 }, (_, idx) => ({
        title: `第${idx + 1}章`,
        text: `第${idx + 1}章正文内容。`,
      })),
    });
    await game.bindSource(world.id, {
      bookId: "book-ceiling",
      through: 4,
      position: 2,
      fanfic: true,
      plot: "rewrite",
      method: "search",
      instructions: "仅参考前五章设定，不照搬后续剧情",
    });

    const boundSession = await client.createSession({
      title: "新局构思",
      boundWorldId: world.id,
      boundLineId: line.id,
      boundBookId: "book-ceiling",
      bookScope: { mode: "through" },
    });

    const inheritedSource = await resolveSessionDraftSource(game, boundSession.session);
    expect(inheritedSource).toMatchObject({
      bookId: "book-ceiling",
      through: 4,
      position: 2,
      fanfic: true,
      plot: "rewrite",
      instructions: "仅参考前五章设定，不照搬后续剧情",
    });

    const draft = draftSetupFromCompanionText(
      "标题：《风雪西市》\n故事设定：天宝年间西市暗流涌动。\n主角姓名：裴行",
      "灵犀",
      { worldSource: inheritedSource, bookId: "book-ceiling", bookScope: boundSession.session.bookScope },
    );
    expect(draft.source).toMatchObject({
      bookId: "book-ceiling",
      through: 4,
      position: 2,
      fanfic: true,
      plot: "rewrite",
      instructions: "仅参考前五章设定，不照搬后续剧情",
    });
  });

  it("isolates NPC private chat personas, knowledge, memories, and sessions across worldlines without cross-branch leaks", async () => {
    const { game, world, openingNode, line: lineA } = await createWorldFixture();
    const client = new CompanionClient(game);
    const baseState = await game.repo.getState(openingNode.id);
    const wang = baseState.people.find((p) => p.name === "王掌柜")!;

    // Fork a second worldline `lineB` from `openingNode`:
    const branchBState = structuredClone(baseState);
    const wangInB = branchBState.people.find((p) => p.id === wang.id)!;
    wangInB.attitude = "冷淡";
    wangInB.notes = "怀疑有人夜探账房";
    const lineB = { id: "line-branch-b" };
    await game.platform.sql.batch([
      {
        sql: "INSERT INTO lines(id,world_id,name,node_id,kind,created_at) VALUES(?,?,?,?,'line',?)",
        params: [lineB.id, world.id, "暗查支线", openingNode.id, "2026-11-24T00:00:00Z"],
      },
    ]);
    const nodeB = await game.repo.appendNode(world.id, lineB.id, {
      parentId: openingNode.id,
      kind: "turn",
      actionMode: "do",
      actionText: "夜探账房",
      narrative: "王掌柜听见账房窗户异响，起了疑心。",
      state: branchBState,
    });

    // Advance `lineA` with completely different secret knowledge for Wang:
    const nodeA = await game.repo.appendNode(world.id, lineA.id, {
      parentId: openingNode.id,
      kind: "turn",
      actionMode: "say",
      actionText: "坦白来意",
      narrative: "王掌柜亲眼看见李安拿出太医署荐书。",
      state: structuredClone(baseState),
    });
    await appendContinuity(game, world.id, nodeA.id, {
      knowledge: [
        {
          id: "k-line-a-only",
          person: wang.id,
          claim: "李安持有太医署荐书",
          awareness: "witnessed",
          source: { nodeId: nodeA.id, from: "narrative", quote: "王掌柜亲眼看见李安拿出太医署荐书" },
        },
      ],
    });
    await game.platform.sql.batch([
      { sql: "UPDATE worlds SET current_line_id=? WHERE id=?", params: [lineB.id, world.id] },
    ]);
    await appendContinuity(game, world.id, nodeB.id, {
      knowledge: [
        {
          id: "k-line-b-only",
          person: wang.id,
          claim: "昨晚有人撬动了账房窗栓",
          awareness: "witnessed",
          source: { nodeId: nodeB.id, from: "narrative", quote: "王掌柜听见账房窗户异响" },
        },
      ],
    });
    await game.platform.sql.batch([
      { sql: "UPDATE worlds SET current_line_id=? WHERE id=?", params: [lineA.id, world.id] },
    ]);

    // Insert an unbound legacy `npc:${worldId}:${person.id}` persona + memory: must NOT leak into `lineB`!
    await client.savePersona({
      id: `npc:${world.id}:${wang.id}`,
      name: "王掌柜",
      roleKind: "npc",
      systemPrompt: "旧版未分线人格",
      pureRoleplay: true,
    });
    await client.saveMemory({
      scope: "persona",
      personaId: `npc:${world.id}:${wang.id}`,
      category: "relation",
      content: "旧主线专属记忆：不该泄露到暗查支线",
    });

    // 1. Extract NPC persona on `lineA` (3-arg default currentLineId) vs `lineB` (explicit 4th arg):
    const personaA = await personaFromStoryPerson(game, world.id, wang.id);
    const personaB = await personaFromStoryPerson(game, world.id, wang.id, lineB.id);

    expect(personaA.id).toBe(`npc:${world.id}:${lineA.id}:${wang.id}`);
    expect(personaA.boundLineId).toBe(lineA.id);
    expect(personaB.id).toBe(`npc:${world.id}:${lineB.id}:${wang.id}`);
    expect(personaB.boundLineId).toBe(lineB.id);

    expect(personaA.systemPrompt).toContain("李安持有太医署荐书");
    expect(personaA.systemPrompt).not.toContain("昨晚有人撬动了账房窗栓");

    expect(personaB.systemPrompt).toContain("昨晚有人撬动了账房窗栓");
    expect(personaB.systemPrompt).toContain("冷淡");
    expect(personaB.systemPrompt).not.toContain("李安持有太医署荐书");

    // 2. Persona memories on `lineA` never leak into `lineB` (and unbound legacy memory did NOT leak into `lineB`):
    await client.saveMemory({
      scope: "persona",
      personaId: personaA.id,
      category: "bond",
      content: "主线约定：帮王掌柜代写家书",
    });
    const memsA = await client.activeMemoriesForPersona(personaA.id, "persona");
    const memsB = await client.activeMemoriesForPersona(personaB.id, "persona");
    expect(memsA.map((m) => m.content)).toContain("主线约定：帮王掌柜代写家书");
    expect(memsB).toEqual([]);

    // 3. `getOrCreateSession` strictly isolates NPC sessions per worldline:
    const sessA1 = await getOrCreateSession(game, {
      personaId: personaA.id,
      worldId: world.id,
      lineId: lineA.id,
    });
    const sessB1 = await getOrCreateSession(game, {
      personaId: personaB.id,
      worldId: world.id,
      lineId: lineB.id,
    });
    const sessA2 = await getOrCreateSession(game, {
      personaId: personaA.id,
      worldId: world.id,
      lineId: lineA.id,
    });
    expect(sessA1.id).toBe(sessA2.id);
    expect(sessA1.boundLineId).toBe(lineA.id);
    expect(sessB1.id).not.toBe(sessA1.id);
    expect(sessB1.boundLineId).toBe(lineB.id);
  });
});
