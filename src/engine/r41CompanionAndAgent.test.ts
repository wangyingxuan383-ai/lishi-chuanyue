import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { archiveProblems, exportWorld, importWorld } from "./archive";
import { AgentClient } from "./agent";
import {
  CompanionClient,
  draftSetupFromCompanionText,
  escalateCompanionToAgent,
  personaFromStoryPerson,
  steerCompanionAgent,
} from "./companion";
import { eraPack } from "./era";
import { packCards } from "./era/card";
import { Game } from "./game";
import { saveBook } from "./sources/library";
import { newBinding } from "./sources/types";
import { applyRecord } from "./state/apply";
import { fakeLlm } from "./testing/fakeLlm";
import { sampleState } from "./testing/fixtures";
import {
  isAgentPreviewTaskStale,
  shouldRebindSessionToActiveLine,
} from "../ui/screens/AgentConversation";
import {
  buildCitationBookPreview,
  isCompanionPreviewTaskStale,
  resolveAgentWorkspaceRoute,
  resolvePersonaSwitchSessionPatch,
} from "../ui/screens/CompanionScreen";
import {
  extractNpcLineId,
  formatNpcOriginLabel,
  groupNpcPersonasByWorld,
} from "../ui/screens/companion/PersonaSheet";
import { EMPTY, normalizeOpeningDraft, toNewWorld } from "../ui/screens/openingDraft";

const LLM = {
  slot: "main",
  url: "https://api.example.invalid/v1/chat/completions",
  model: "main-model",
  auxModel: "aux-model",
  includeUsage: true,
};

async function setupBookAndWorld() {
  const llm = fakeLlm([]);
  const platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, LLM);
  const book = {
    id: "book-canon",
    title: "测试原著长卷",
    format: "txt" as const,
    createdAt: "2026-11-27T00:00:00.000Z",
    sections: [
      { title: "第一章 初见", text: "青云崖下拾剑。" },
      { title: "第二章 拜师", text: "拜入外门静修。" },
      { title: "第三章 试剑", text: "演武场切磋。" },
      { title: "第四章 远行", text: "下山历练。" },
    ],
  };
  await saveBook(game.repo, book);

  const pack = eraPack("tang-748")!;
  const seed = sampleState();
  seed.version = 2;
  seed.source = {
    ...newBinding(book.id, true),
    through: 0, // Legacy locked through=0 in saved world state
    position: 0,
  };
  Object.assign(seed, packCards(pack));
  const state = applyRecord(
    seed,
    {
      place: "西市邸店",
      people: [{ name: "沈掌柜", role: "邸店东家", attitude: "温和", note: "熟悉坊市消息" }],
    },
    { mode: "do", difficulty: "标准", currency: pack.currency },
    { advanceTime: false },
  ).state;

  const { world, node, line } = await game.repo.createWorld({
    title: "天宝风雪录",
    eraId: "free",
    settings: { mode: "free", clockStyle: "elapsed", premise: "同人世界测试" },
    opening: {
      parentId: null,
      kind: "opening",
      narrative: "初雪落满西市屋檐。",
      state,
      meta: { openingSeed: state },
    },
  });

  return { platform, game, book, world, openingNode: node, line, state };
}

describe("R41 Companion, Agent state machine, and archive invariants (R41-T005)", () => {
  it("E01 & E10: cloned Turn-0 opening root with monotonic seq and derived book without null page pass archiveProblems 100%", async () => {
    const { game, world, openingNode, state } = await setupBookAndWorld();
    const archive = await exportWorld(game.repo, world.id);

    // Simulate Rust apply_workspace Turn-0 opening clone (`seq = max_seq + 1`, `agentOriginalNodeId = old_id`)
    const maxSeq = Math.max(0, ...archive.nodes.map((n) => Number(n.seq) || 0));
    const clonedOpeningId = "cloned_opening_r41";
    archive.nodes.push({
      ...structuredClone(archive.nodes[0]!),
      id: clonedOpeningId,
      seq: maxSeq + 1,
      parent_id: null,
      last_child_id: null,
      narrative: "改档助手重新润色后的开场正文。",
      rewritten: 1,
      meta_json: JSON.stringify({
        openingSeed: state,
        agentOriginalNodeId: openingNode.id,
      }),
    });
    archive.states.push({
      node_id: clonedOpeningId,
      state_json: JSON.stringify(state),
    });
    archive.lines[0]!.node_id = clonedOpeningId;

    // Simulate derived book whose section 0 omitted null `page` and section 1 kept integer `page: 2`
    archive.books![0]!.book.sections = [
      { title: "第一章 初见", text: "青云崖下拾剑。" },
      { title: "第二章 拜师·修订", text: "拜入外门静修。", page: 2 },
    ];

    expect(archiveProblems(archive)).toEqual([]);
    const importedWorldId = await importWorld(game.repo, archive, "new");
    const roundtripped = await exportWorld(game.repo, importedWorldId);
    expect(archiveProblems(roundtripped)).toEqual([]);
  });

  it("E03: escalateCompanionToAgent & steerCompanionAgent unlock legacy through=0 by default and forward explicit chapter ranges", async () => {
    const { platform, game, book, world, line } = await setupBookAndWorld();
    const capturedAgentCalls: Record<string, unknown>[] = [];
    platform.execution = {
      agent: async (req: unknown) => {
        const r = req as Record<string, unknown>;
        capturedAgentCalls.push(r);
        if (r.op === "create") {
          return {
            id: "pi-sess-1",
            worldId: world.id,
            lineId: line.id,
            title: "伴聊改档",
            createdAt: "t",
            updatedAt: "t",
          };
        }
        if (r.op === "start") {
          return { taskId: `task-${capturedAgentCalls.length}`, runId: `run-${capturedAgentCalls.length}` };
        }
        if (r.op === "enqueue_input") {
          return { id: r.id, accepted: true, delivery: r.delivery };
        }
        return {};
      },
    } as unknown as typeof platform.execution;

    const companion = new CompanionClient(game);

    // 1. Default / "all" / "full" scope unlocks legacy `state.source.through = 0` to `through: null`:
    const createdAll = await companion.createSession({
      boundWorldId: world.id,
      boundLineId: line.id,
      boundBookId: book.id,
      bookScope: { mode: "all" },
    });
    const escalatedAll = await escalateCompanionToAgent(game, {
      sessionId: createdAll.session.id,
      text: "按全书设定补全人物卡片",
    });
    const startAllCall = capturedAgentCalls.find((c) => c.op === "start")!;
    expect(startAllCall.referenceScope).toEqual({
      bookId: book.id,
      through: null,
    });

    await steerCompanionAgent(game, {
      sessionId: createdAll.session.id,
      piSessionId: escalatedAll.piSessionId,
      taskId: escalatedAll.taskId,
      text: "顺便核对第四章设定",
    });
    const steerAllCall = capturedAgentCalls.find((c) => c.op === "enqueue_input") as {
      request: { referenceScope?: unknown };
    };
    expect(steerAllCall.request.referenceScope).toEqual({
      bookId: book.id,
      through: null,
    });

    // 2. Explicit `chapters` scope forwards `{ bookId, from, through, explicitRange: true }`:
    capturedAgentCalls.length = 0;
    await companion.updateSession(createdAll.session.id, {
      bookScope: { mode: "chapters", from: 1, to: 2 },
    });
    const escalatedRange = await escalateCompanionToAgent(game, {
      sessionId: createdAll.session.id,
      text: "只依据第二到第三章调整剧情",
    });
    const startRangeCall = capturedAgentCalls.find((c) => c.op === "start")!;
    expect(startRangeCall.referenceScope).toEqual({
      bookId: book.id,
      from: 1,
      through: 2,
      explicitRange: true,
    });

    await steerCompanionAgent(game, {
      sessionId: createdAll.session.id,
      piSessionId: escalatedRange.piSessionId,
      taskId: escalatedRange.taskId,
      text: "补充一条细节",
      phase: "closing",
    });
    const steerRangeCall = capturedAgentCalls.find((c) => c.op === "enqueue_input") as {
      delivery: string;
      request: { referenceScope?: unknown };
    };
    expect(steerRangeCall.delivery).toBe("queued");
    expect(steerRangeCall.request.referenceScope).toEqual({
      bookId: book.id,
      from: 1,
      through: 2,
      explicitRange: true,
    });
  });

  it("E04: CompanionScreen & AgentConversation detect stale previewed tasks and route recheck / discard cleanly", async () => {
    const { platform, game } = await setupBookAndWorld();
    const previewTask = {
      id: "t-preview-1",
      baseLineId: "line-main",
      baseHeadId: "node-1",
      previewStale: false,
    };

    // Fresh preview is NOT marked stale:
    expect(isCompanionPreviewTaskStale("previewed", previewTask, "line-main", "node-1")).toBe(false);
    expect(isAgentPreviewTaskStale("previewed", previewTask, "line-main", "node-1", false)).toBe(false);

    // Diverged head, switched branch, backend previewStale flag, or post-adopt Stale error all trigger recovery mode:
    expect(isCompanionPreviewTaskStale("previewed", previewTask, "line-branch", "node-1")).toBe(true);
    expect(isCompanionPreviewTaskStale("previewed", previewTask, "line-main", "node-2")).toBe(true);
    expect(
      isCompanionPreviewTaskStale("previewed", previewTask, "line-main", "node-1", new Set(["t-preview-1"])),
    ).toBe(true);

    expect(isAgentPreviewTaskStale("previewed", previewTask, "line-branch", "node-1")).toBe(true);
    expect(isAgentPreviewTaskStale("previewed", previewTask, "line-main", "node-2")).toBe(true);
    expect(isAgentPreviewTaskStale("previewed", { ...previewTask, previewStale: true }, "line-main", "node-1")).toBe(
      true,
    );
    expect(isAgentPreviewTaskStale("previewed", previewTask, "line-main", "node-1", true)).toBe(true);

    // Non-previewed statuses never enter previewStale state:
    expect(isCompanionPreviewTaskStale("committed", previewTask, "line-branch", "node-2")).toBe(false);
    expect(isAgentPreviewTaskStale("cancelled", previewTask, "line-branch", "node-2", true)).toBe(false);

    // Verify AgentClient discardDrafts & resumeCheck RPC wiring for stale preview resolution:
    const rpcOps: Record<string, unknown>[] = [];
    platform.execution = {
      agent: async (req: unknown) => {
        const r = req as Record<string, unknown>;
        rpcOps.push(r);
        if (r.op === "resume_check") {
          return {
            canContinue: false,
            reasonCode: "story_version_changed",
            message: "故事已有新进展",
            storyChanged: true,
            routeChanged: false,
            needsRebase: true,
            worldId: "w1",
            lineId: "line-main",
            currentLineId: "line-branch",
          };
        }
        if (r.op === "discard_drafts") {
          return { discarded: true, task: { id: r.taskId, status: "cancelled", draftCount: 0 } };
        }
        return {};
      },
    } as unknown as typeof platform.execution;
    const client = new AgentClient(game);
    const check = await client.resumeCheck("t-preview-1");
    expect(check.needsRebase).toBe(true);
    expect(check.routeChanged).toBe(false);
    await client.discardDrafts("t-preview-1");
    expect(rpcOps.map((o) => o.op)).toEqual(["resume_check", "discard_drafts"]);
  });

  it("E12 & E13: syncs active world line when opening AgentConversation, groups NPC personas by world/route, cleans unrelated book bindings, preserves citation section, and enforces fanfic free-mode clock", async () => {
    const { game, world, line } = await setupBookAndWorld();
    const branchLine = await game.repo.createLine(world.id, line.nodeId, "东市支线", true);

    // 1. Opening Agent workspace from Companion uses latest `boundWorldBrief.lineId` instead of stale `session.boundLineId`:
    const workspaceRoute = resolveAgentWorkspaceRoute(
      { boundWorldId: world.id, boundLineId: line.id, piSessionId: "pi-old-empty" },
      { lineId: branchLine.id },
      { session: { id: "pi-old-empty", worldId: world.id, lineId: line.id, title: "旧线空对话", createdAt: "t", updatedAt: "t" }, tasks: [] },
    );
    expect(workspaceRoute).toEqual({
      worldId: world.id,
      lineId: branchLine.id,
      syncSessionLineId: branchLine.id,
    });
    // Non-empty historical Pi session is still viewable while syncing active lineId:
    const nonEmptyRoute = resolveAgentWorkspaceRoute(
      { boundWorldId: world.id, boundLineId: line.id, piSessionId: "pi-with-history" },
      { lineId: branchLine.id },
      {
        session: { id: "pi-with-history", worldId: world.id, lineId: line.id, title: "有记录", createdAt: "t", updatedAt: "t" },
        tasks: [{ id: "t1" } as never],
      },
    );
    expect(nonEmptyRoute?.sessionId).toBe("pi-with-history");
    expect(shouldRebindSessionToActiveLine(line.id, branchLine.id, 0)).toBe(true);
    expect(shouldRebindSessionToActiveLine(line.id, branchLine.id, 2)).toBe(false);
    expect(shouldRebindSessionToActiveLine(line.id, branchLine.id)).toBe(true);

    // 2. NPC persona invitation records `boundLineId` and groups/sorts by current world & active route:
    await expect(personaFromStoryPerson(game, world.id, "non-existent-person", line.id)).rejects.toThrow(
      "没有找到这位人物",
    );
    const curState = await game.repo.getState(line.nodeId);
    const shen = curState.people[0]!;
    const shenMain = (await personaFromStoryPerson(game, world.id, shen.id, line.id))!;
    const shenBranch = (await personaFromStoryPerson(game, world.id, shen.id, branchLine.id))!;
    expect(extractNpcLineId(shenMain)).toBe(line.id);
    expect(extractNpcLineId(shenBranch)).toBe(branchLine.id);

    const foreignNpc = {
      ...shenMain,
      id: "npc:other-world:other-line:p9",
      name: "异界掌柜",
      sourceWorldId: "other-world",
      boundLineId: "other-line",
      metadata: { worldTitle: "异界风云", boundLineId: "other-line" },
    };
    const grouped = groupNpcPersonasByWorld([shenMain, foreignNpc, shenBranch], world.id, branchLine.id);
    expect(grouped.currentWorldNpcs.map((p) => p.id)).toEqual([shenBranch.id, shenMain.id]);
    expect(grouped.otherWorldNpcs.map((p) => p.id)).toEqual([foreignNpc.id]);
    expect(
      formatNpcOriginLabel(
        shenBranch,
        { [world.id]: world.title },
        { [`${world.id}:${branchLine.id}`]: "东市支线" },
      ),
    ).toBe("《天宝风雪录》 · 东市支线");

    // 3. Switching to an NPC in empty / non-empty sessions cleans unrelated `boundBookId`:
    const emptySwitch = resolvePersonaSwitchSessionPatch({
      persona: foreignNpc,
      session: {
        activeGear: "research",
        boundWorldId: world.id,
        boundLineId: line.id,
        boundBookId: "unrelated-book-99",
        bookScope: { mode: "chapters", from: 0, to: 1 },
      },
      isEmptySession: true,
      npcWorldBookId: null,
      npcFallbackLineId: "other-line",
    });
    expect(emptySwitch).toEqual({
      mode: "update",
      personaId: foreignNpc.id,
      activeGear: "chat",
      boundWorldId: "other-world",
      boundLineId: "other-line",
      boundBookId: null,
      bookScope: null,
    });

    const nonEmptySwitch = resolvePersonaSwitchSessionPatch({
      persona: shenBranch,
      session: {
        activeGear: "research",
        boundWorldId: "other-world",
        boundLineId: "other-line",
        boundBookId: "unrelated-book-99",
        bookScope: { mode: "chapters", from: 0, to: 1 },
      },
      isEmptySession: false,
      npcWorldBookId: "book-canon",
      npcFallbackLineId: branchLine.id,
    });
    expect(nonEmptySwitch).toEqual({
      mode: "create",
      personaId: shenBranch.id,
      activeGear: "chat",
      boundWorldId: world.id,
      boundLineId: branchLine.id,
      boundBookId: "book-canon",
      bookScope: { mode: "full" },
    });

    // 4. Book citation preview preserves `cite.section` (including section 0):
    expect(buildCitationBookPreview({ id: "b1", title: "史记" }, { quote: "原文", section: 0 })).toEqual({
      bookId: "b1",
      title: "史记",
      quote: "原文",
      section: 0,
    });
    expect(buildCitationBookPreview({ id: "b1", title: "史记" }, { quote: "第五章引文", section: 4 })).toEqual({
      bookId: "b1",
      title: "史记",
      quote: "第五章引文",
      section: 4,
    });

    // 5. Fanfic drafts in `normalizeOpeningDraft` & Companion draft setup always align `mode: "free"` + `clockStyle: "elapsed"`:
    const fanficDraft = normalizeOpeningDraft({
      ...EMPTY,
      eraId: "tang-748",
      premise: "斗罗同人开局",
      name: "唐晓",
      identity: "外门学员",
      fanfic: true,
      source: newBinding("book-canon", true),
      settings: {
        ...EMPTY.settings,
        mode: "history",
        clockStyle: "era",
      },
    });
    expect(fanficDraft.eraId).toBeNull();
    expect(fanficDraft.settings.mode).toBe("free");
    expect(fanficDraft.settings.clockStyle).toBe("elapsed");
    expect(toNewWorld(fanficDraft).settings).toMatchObject({
      mode: "free",
      clockStyle: "elapsed",
    });

    const companionFanficSetup = draftSetupFromCompanionText(
      "书名：青云剑影\n主角：林牧\n身份：青云外门弟子\n世界背景：同人续写开局。",
      "灵犀",
      { worldSource: newBinding("book-canon", true), bookId: "book-canon" },
    );
    const companionNormalized = normalizeOpeningDraft({
      ...EMPTY,
      ...companionFanficSetup,
      fanfic: companionFanficSetup.source?.fanfic === true,
      settings: { ...EMPTY.settings, mode: "history", clockStyle: "era" },
    });
    expect(companionNormalized.settings.mode).toBe("free");
    expect(companionNormalized.settings.clockStyle).toBe("elapsed");
  });
});
