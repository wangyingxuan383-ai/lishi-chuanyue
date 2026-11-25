import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import type { ExecutionSnapshot, Json } from "../platform";
import { depthBudget, depthOf, REFERENCE_REVIEW_FULL, REFERENCE_REVIEW_LITE, referenceReview } from "./depth";
import { Game } from "./game";
import { buildNovelBook } from "./novel";
import { PROMPT_VERSION, buildTurnContext, turnMessages } from "./prompt/turn";
import { eraContext } from "./era";
import { relevantSourceFacts, sourceAnalysisResult } from "./sources/facts";
import { chunksOf, newAnalysisJob, referenceContext, referenceEvidenceBlock, referenceInstructionsBlock, saveBook, saveJob } from "./sources/library";
import { newNote, notesForTurn, saveNote } from "./sources/notes";
import { newBinding, type SourceBinding, type SourceBook } from "./sources/types";
import { sampleState } from "./testing/fixtures";
import { DEFAULT_SETTINGS } from "./types";
import { splitTurnUsage, turnForegroundUsage, turnUsage, usageLine } from "./usage";
import { CANON_WRITING_PROMPT_VERSION, REVISION_PROMPT_VERSION, canonCorrectionRules, playerRevisionRules, writingMessages } from "./writing/assist";
import { StoryText } from "../ui/components/StoryText";
import { looksLikeMetaQuestion } from "../ui/screens/Play";

const book: SourceBinding = { bookId: "b", fanfic: true, plot: "canon", through: null, position: 0, instructions: "", method: "search" };

describe("generation tiers (D161)", () => {
  it("defaults old worlds to 标准 and trims only 快速's memory", () => {
    expect(depthOf({})).toBe("standard");
    expect(depthOf({ depth: "deep" })).toBe("deep");
    expect(depthBudget(20_000, "fast")).toBe(12_000);
    expect(depthBudget(20_000, "standard")).toBe(20_000);
    expect(depthBudget(20_000, "deep")).toBe(20_000);
  });
  it("checks the original fully at 深度, lightly for 同人 at 标准, never at 快速", () => {
    expect(referenceReview("deep", book)).toBe("reference-review-5");
    expect(referenceReview("standard", book)).toBe("reference-review-lite-6");
    expect(referenceReview("standard", { ...book, fanfic: false })).toBeUndefined();
    expect(referenceReview("fast", book)).toBeUndefined();
    expect(referenceReview("deep", null)).toBeUndefined();
  });
  it("passes the tier, free-world chapter version and old edited facts to the native turn", async () => {
    const platform = await createMemoryPlatform();
    const plans: Record<string, Json>[] = [];
    const contexts: Record<string, Json>[] = [];
    platform.execution = {
      agent: async () => null, settle: async () => null, list: async () => [], stop: async () => ({executionId:null,status:"cancelled",accepted:true,settled:true}), resume: async () => {},
      start: async (plan) => { plans.push(plan as Record<string, Json>); return "run"; },
      context: async (input) => {
        contexts.push(input as Record<string, Json>);
        return buildTurnContext(input as never) as unknown as Json;
      },
      snapshot: async (id): Promise<ExecutionSnapshot> => ({ id, worldId: "", status: "failed", budget: { modelRequests: 0, toolCalls: 0, corrections: 0, activeMs: 0 }, draft: null, result: null, error: "测试结束", events: [] }),
    };
    const game = await Game.open(platform, { slot: "main", url: "https://x/v1/chat/completions", model: "m", includeUsage: true, contextTokens: 10_000 });
    await saveBook(game.repo, { id: book.bookId, title: "试读", format: "txt", createdAt: new Date().toISOString(), sections: [{ title: "开篇", text: "旅人走出城门。" }] });
    const { world, node, line } = await game.repo.createWorld({
      title: "试", eraId: "free", settings: { premise: "一座城。", depth: "fast", chapterEvery: 1 },
      opening: { parentId: null, kind: "opening", narrative: "你醒来。", state: { ...sampleState(), era: { mode: "free", packId: null }, source: book } as never, meta: {} },
    });
    await platform.sql.batch([
      { sql: "UPDATE nodes SET rewritten=1 WHERE id=?", params: [node.id] },
      { sql: `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<201)
        INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,created_at)
        SELECT 'passage-'||n,?,CASE WHEN n=1 THEN ? ELSE 'passage-'||(n-1) END,n,'turn','后续','test' FROM sequence`, params: [world.id, node.id] },
      { sql: "INSERT INTO states SELECT 'passage-201',json_set(state_json,'$.facts',json(?)) FROM states WHERE node_id=?", params: [JSON.stringify([{ id: "old-ai", origin: "ai", nodeId: node.id, detail: "旧记事" }]), node.id] },
      { sql: "UPDATE lines SET node_id='passage-201' WHERE id=?", params: [line.id] },
    ]);
    await new Promise<void>((done) => game.play(world.id, { mode: "do", text: "出门" }, (e) => { if (e.type === "failed" || e.type === "done") done(); }));
    const meta = plans[0].meta as Record<string, unknown>;
    expect(meta.depth).toBe("fast");
    expect(meta.referenceReviewVersion).toBeUndefined();
    expect(meta.budgetChars).toBeLessThan(10_000);
    expect(meta.chapterVersion).toBe("chapter-4-free");
    expect((meta.chapterMessages as { content: string }[])[0].content).not.toContain("历史互动小说");
    expect((meta.chapterMessages as { content: string }[])[0].content).toContain("沿用本局世界设定与称呼");
    expect(contexts[0].history).toHaveLength(200);
    expect(contexts[0].editedFactNodeIds).toEqual([node.id]);
  });

  it("R39-T003: cleans Markdown from StoryText & novel builder, enforces turn-29 anti-fourth-wall rules, fixes stuck position retrieval, and splits foreground usage", async () => {
    // 1. Clean Novel Typography (StoryText & novel.ts)
    const dirtyProse = "### 第一幕\n\n** 【关于预备队人选的说明】 **\n---\n* 贝贝缓步上前，**沉声**开口。";
    const settledHtml = renderToStaticMarkup(createElement(StoryText, { text: dirtyProse, streaming: false }));
    expect(settledHtml).toContain('<hr class="story-divider" aria-hidden="true"/>');
    expect(settledHtml).not.toContain("**");
    expect(settledHtml).not.toContain("###");
    expect(settledHtml).not.toContain("* 贝贝");
    expect(settledHtml).toContain("【关于预备队人选的说明】");
    expect(settledHtml).toContain("贝贝缓步上前，沉声开口。");

    const streamHtml = renderToStaticMarkup(createElement(StoryText, { text: dirtyProse, streaming: true }));
    expect(streamHtml).toContain('<hr class="story-divider" aria-hidden="true"/>');
    expect(streamHtml).toContain("cursor-blink");
    expect(streamHtml).not.toContain("**");

    // 2. Meta-Question Detector
    expect(looksLikeMetaQuestion("按理来说，应该是要选出来史莱克七怪预备队的，这样的话还会是原作中的人选吗？")).toBe(true);
    expect(looksLikeMetaQuestion("请问这局设定集里有哪些人物？")).toBe(true);
    expect(looksLikeMetaQuestion("按理来说，接下来还会发生兽潮吗")).toBe(true);
    expect(looksLikeMetaQuestion("向言少哲行礼询问核心弟子的待遇")).toBe(false);
    expect(looksLikeMetaQuestion("“还会是原来的人选吗？”我低声问贝贝")).toBe(false);
    expect(looksLikeMetaQuestion("去书房翻阅原书")).toBe(false);

    // 3. Prompt versions & anti-fourth-wall / anti-Markdown rules
    expect(PROMPT_VERSION).toBe("turn-29");
    expect(REFERENCE_REVIEW_LITE).toBe("reference-review-lite-6");
    expect(REFERENCE_REVIEW_FULL).toBe("reference-review-5");
    expect(CANON_WRITING_PROMPT_VERSION).toBe("writing-canon-8");
    expect(REVISION_PROMPT_VERSION).toBe("revise-passage-5");

    const baseState = sampleState();
    const sys = turnMessages({
      state: baseState,
      era: eraContext("tang-748", baseState),
      settings: DEFAULT_SETTINGS,
      protagonistName: "李安",
      history: [],
      mode: "do",
      text: "探查",
    })[0].content;
    expect(sys).toContain("纯文本小说格式");
    expect(sys).toContain("严守故事第四面墙");
    expect(canonCorrectionRules(DEFAULT_SETTINGS, baseState)).toContain("严禁使用 **加粗**");
    expect(playerRevisionRules(DEFAULT_SETTINGS, baseState)).toContain("严禁使用 **加粗**");
    expect(writingMessages("rewrite", "原文", "", "原文", "do")[0].content).toContain("严禁使用 **加粗**");

    // 4. Retrieval & stuck source.position fixes
    const platform = await createMemoryPlatform();
    const game = await Game.open(platform, null);
    const sections = Array.from({ length: 55 }, (_, i) => ({
      title: `第${i + 1}章 ${i === 0 ? "开篇" : i === 49 ? "预备队选拔" : "日常"}`,
      text: i === 0
        ? "主角初入学院，导师介绍了基础魂力修炼常识。"
        : i === 49
          ? "言少哲当众宣布本届史莱克七怪预备队正式人选名单。"
          : `第${i + 1}章平淡过渡。`,
    }));
    const fanficBook: SourceBook = {
      id: "fanfic-book",
      title: "学院志",
      format: "txt",
      createdAt: new Date().toISOString(),
      sections,
    };
    await saveBook(game.repo, fanficBook);
    const fanficBind = { ...newBinding(fanficBook.id, true), position: 0, through: null };

    // Chapter 50 exact hit outranks position 0 and does NOT force-inject unmarked position 0 chunk
    const hitCtx = (await referenceContext(game.repo, fanficBind, "史莱克七怪预备队人选名单", 3000))!;
    expect(hitCtx.passages[0].section).toBe(49);
    expect(hitCtx.passages.some((p) => p.section === 0)).toBe(false);
    expect(referenceInstructionsBlock(hitCtx)).toContain("原著切入/近期参考锚点");
    expect(referenceInstructionsBlock(hitCtx)).toContain("绝不在小说正文里向玩家解释“资料不足”");
    expect(referenceInstructionsBlock(hitCtx, { ignorePosition: true })).not.toContain("原著位置");
    expect(referenceInstructionsBlock(hitCtx, { ignorePosition: true })).not.toContain("原著切入/近期参考锚点");

    // Zero-match fallback tags nearby chunk with match: "nearby" and labels it 附近参考
    const missCtx = (await referenceContext(game.repo, { ...fanficBind, instructions: "" }, "完全不存在的星际飞船词汇", 3000))!;
    expect(missCtx.passages).toHaveLength(1);
    expect(missCtx.passages[0].match).toBe("nearby");
    expect(referenceEvidenceBlock(missCtx)).toContain("·附近参考·");
    expect(referenceEvidenceBlock(missCtx)).not.toContain("·原文·");

    // relevantSourceFacts does not SQL-censor chapters position+1..=through for general facts,
    // and returns explicitly time-gated validFrom facts on ignorePosition (查一查/纠错) or once position advances
    const job = newAnalysisJob(fanficBook, fanficBind, "mock");
    await saveJob(game.repo, job);
    const ch49 = chunksOf(fanficBook).find((c) => c.section === 49)!;
    const parsedFact = sourceAnalysisResult(
      JSON.stringify({
        summary: "预备队",
        facts: [
          { kind: "rule", subject: "预备队赛制", aliases: ["七怪预备队"], statement: "正选与预备队共同出征", quote: "史莱克七怪预备队正式人选名单" },
          { kind: "event", subject: "预备队揭晓", aliases: [], statement: "言少哲宣布名单", quote: "史莱克七怪预备队正式人选名单", validFrom: 49 },
        ],
      }),
      fanficBook,
      ch49,
      job,
    );
    await platform.sql.batch(parsedFact.statements);
    const factsAtPos0 = await relevantSourceFacts(game.repo, fanficBind, new Map([["预备队", 5]]), 54, 0);
    expect(factsAtPos0).toHaveLength(1);
    expect(factsAtPos0[0].section).toBe(49);
    expect(factsAtPos0[0].subject).toBe("预备队赛制");
    const factsLookup = await relevantSourceFacts(game.repo, fanficBind, new Map([["预备队", 5]]), 54, 0, { ignorePosition: true });
    expect(factsLookup).toHaveLength(2);

    // notesForTurn (!allChapters) includes later-arc plot note within through on strong keyword overlap
    await saveNote(game.repo, {
      ...newNote(fanficBook.id, "plot", { from: 0, to: 10 }, "早期主线"),
      refs: [0, 10],
      content: "第一章至第十章：新生入学考核。",
      status: "done",
    });
    await saveNote(game.repo, {
      ...newNote(fanficBook.id, "plot", { from: 40, to: 52 }, "预备队主线"),
      refs: [40, 52],
      content: "第四十章至第五十二章：言少哲选拔史莱克七怪预备队。",
      status: "done",
    });
    const turnNotes = await notesForTurn(game.repo, fanficBind, "", "言少哲正在商议史莱克七怪预备队人选");
    expect(turnNotes.map((n) => n.title)).toEqual(["早期主线", "预备队主线"]);

    // novel.ts strips Markdown and converts --- to divider
    const { world } = await game.repo.createWorld({
      title: "净排测试",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "**开篇加粗**\n---\n* 列表句子。", state: baseState },
    });
    const novel = (await buildNovelBook(game.repo, world.id, { includePreface: false, includeChronicle: false }))!;
    expect(novel.sections[0].paragraphs).toEqual([
      { kind: "prose", text: "开篇加粗", nodeId: novel.sections[0].firstNodeId },
      { kind: "divider", text: "◇", nodeId: novel.sections[0].firstNodeId },
      { kind: "prose", text: "列表句子。", nodeId: novel.sections[0].firstNodeId },
    ]);

    // 5. Foreground vs Background usage separation
    const ins = (id: string, purpose: string, ms: number) => ({
      sql: "INSERT INTO usage(id,world_id,node_id,purpose,model,prompt_tokens,completion_tokens,estimated,first_token_ms,total_ms,outcome,at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [id, world.id, "turn-node-1", purpose, "m", 1000, 200, 0, 100, ms, "ok", new Date().toISOString()],
    });
    await platform.sql.batch([
      ins("u1", "writing:0", 14_000),
      ins("u2", "reference-review-lite", 4_000),
      ins("u3", "upkeep", 28_000),
      ins("u4", "chapter", 21_000),
    ]);
    const allTurn = (await turnUsage(platform, "turn-node-1"))!;
    const fgTurn = (await turnForegroundUsage(platform, "turn-node-1"))!;
    const split = splitTurnUsage(allTurn);
    expect(allTurn.calls).toBe(4);
    expect(fgTurn.calls).toBe(2);
    expect(fgTurn.ms).toBe(18_000);
    expect(split.foreground).toMatchObject({ calls: 2, ms: 18_000 });
    expect(split.background).toMatchObject({ calls: 2, ms: 49_000 });
    expect(usageLine(split.foreground!, { input: null, output: null })).toBe("2 次 · 2400 tokens · 18 秒");
  });
});
