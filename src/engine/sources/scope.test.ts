// 资料范围 (D184): what each request gets for 自动, chosen notes, or chosen chapters.
import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../../platform/memory";
import { Game } from "../game";
import { sampleState } from "../testing/fixtures";
import * as tree from "../tree";
import { saveBook } from "./library";
import { newNote, newStoryNote, saveNote, type CanonNote } from "./notes";
import { bookChapters, chapterLabel, chapterRangeSummary, chapterRowMeta, choosableNotes, extractChapterNumbers, isChosen, matchChapterQuery, notesRange, parseChapterNumeral, rangeChars, rangeContext, scopeLabel, scopedMaterial, wholeChapterFits, type SourceScope } from "./scope";
import { newBinding, type SourceBook } from "./types";

const LLM = { slot: "main", url: "https://x/v1/chat/completions", model: "m", includeUsage: true, contextTokens: 12_000 };

async function setup(sectionText = (i: number) => `第${i + 1}章：青铜钥匙藏在第${i + 1}个匣子里。`, count = 10) {
  const platform = await createMemoryPlatform();
  const plans: Record<string, unknown>[] = [];
  platform.execution = {
    agent: async () => null, settle: async () => null, list: async () => [], stop: async () => ({ executionId: null, status: "cancelled", accepted: true, settled: true }), resume: async () => {},
    start: async (plan) => { plans.push(plan as Record<string, unknown>); return `run${plans.length}`; },
    snapshot: async (id) => ({ id, worldId: "", status: "failed", budget: { modelRequests: 0, toolCalls: 0, corrections: 0, activeMs: 0 }, draft: null, result: null, error: "测试结束", events: [] }),
  };
  const game = await Game.open(platform, LLM);
  const book: SourceBook = { id: crypto.randomUUID(), title: "长篇", format: "txt", createdAt: new Date().toISOString(), sections: Array.from({ length: count }, (_, i) => ({ title: `第${i + 1}章`, text: sectionText(i) })) };
  await saveBook(game.repo, book);
  const source = { ...newBinding(book.id, true), through: 7 };
  const { world } = await game.repo.createWorld({ title: "范围", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "开场。", state: { ...sampleState(), source }, meta: { openingSeed: { ...sampleState(), source } } } });
  let cursor = await tree.cursor(game.repo, world.id);
  cursor = await tree.append(game.repo, cursor, { kind: "turn", actionMode: "do", actionText: "开匣", narrative: "你打开了匣子，里面有一把钥匙。", state: { ...sampleState(), source } });
  const sent: string[] = [];
  platform.llm.stream = async (request, onEvent) => {
    sent.push((request.body as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n"));
    onEvent({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ replacement: "改好了。", note: "改了" }) }, finish_reason: "stop" }] }) });
    onEvent({ type: "done" });
    return "test-stream";
  };
  const done = (note: CanonNote, content: string, refs: number[] = []): CanonNote => ({ ...note, status: "done", content, refs });
  return { platform, game, repo: game.repo, book, source, world, cursor, plans, sent, done };
}

describe("资料范围的取材 (D184)", () => {
  it("names the choice in the row, and an empty choice of notes is 自动", () => {
    expect(scopeLabel({ mode: "auto" })).toBe("自动");
    expect(scopeLabel({ mode: "chapters", from: 2, to: 4 })).toBe("第 3～5 章");
    expect(scopeLabel({ mode: "chapters", from: 2, to: 2 })).toBe("第 3 章");
    expect(scopeLabel({ mode: "notes", noteIds: ["a", "b"] })).toBe("2 份札记");
    expect(isChosen({ mode: "notes", noteIds: [] })).toBe(false);
    // A title that already says which chapter it is is not numbered twice.
    expect(chapterLabel(2, "第3章 渡口")).toBe("第3章 渡口");
    expect(chapterLabel(2, "第三章 渡口")).toBe("第三章 渡口");
    expect(chapterLabel(2, "渡口")).toBe("第 3 章 · 渡口");
    expect(chapterLabel(2)).toBe("第 3 章");
  });

  it("lists only the chapters the story may read, with their length", async () => {
    const s = await setup();
    const chapters = await bookChapters(s.repo, s.source);
    expect(chapters.map((c) => c.section)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(rangeChars(chapters, { from: 2, to: 3 })).toBe(s.book.sections[2].text.length + s.book.sections[3].text.length);
  });

  it("gives chosen chapters whole when they fit, and searches within them when not", async () => {
    const s = await setup((i) => i === 8 ? "青铜钥匙青铜钥匙青铜钥匙，钥匙的来历全在这里。" : `第${i + 1}章：${"风吹过山谷。".repeat(i === 3 ? 400 : 4)}青铜钥匙。`);
    const small = await scopedMaterial(s.repo, s.source, { mode: "chapters", from: 1, to: 2 }, "青铜钥匙的来历", 4000);
    expect(small.whole).toBe(true);
    expect(small.reference?.passages.map((p) => p.section)).toEqual([1, 2]);
    expect(small.reference?.passages[0].text).toBe(s.book.sections[1].text);
    expect(small.meta).toEqual({ mode: "chapters", from: 1, to: 2 });
    const big = await scopedMaterial(s.repo, s.source, { mode: "chapters", from: 2, to: 4 }, "青铜钥匙的来历", 900);
    expect(big.whole).toBe(false);
    expect(big.reference?.passages.length).toBeGreaterThan(0);
    expect(big.reference?.passages.every((p) => p.section >= 2 && p.section <= 4)).toBe(true);
    // Never past what the story may read: chapter 9 is beyond 截至第 8 章.
    expect(await rangeContext(s.repo, s.source, { from: 8, to: 9 }, 100000)).toBeUndefined();
    const past = await scopedMaterial(s.repo, s.source, { mode: "chapters", from: 6, to: 9 }, "青铜钥匙的来历", 100000);
    expect(past.reference?.passages.every((p) => p.section <= 7)).toBe(true);
  });

  it("gives only the chosen notes, cut around what is asked; a correction may read what its book notes cover", async () => {
    const s = await setup();
    const picked = s.done(newNote(s.book.id, "person", { subject: "铜匠" }, "人物：铜匠"), `${"铜匠年轻时走南闯北。".repeat(200)}铜匠打了一把青铜钥匙。${"后来他回到镇上。".repeat(200)}`, [4, 5]);
    const other = s.done(newNote(s.book.id, "person", { subject: "樵夫" }, "人物：樵夫"), "樵夫知道青铜钥匙。", [1]);
    const story = s.done(newStoryNote(s.world.id, "plot", { from: 0, to: 1 }, "主线梗概"), "本局：打开匣子。");
    for (const n of [picked, other, story]) await saveNote(s.repo, n);
    const scope: SourceScope = { mode: "notes", noteIds: [picked.id, story.id] };
    const plain = await scopedMaterial(s.repo, s.source, scope, "青铜钥匙", 2000, { worldId: s.world.id });
    expect(plain.notes.map((n) => [n.title, n.source])).toEqual([["人物：铜匠", "book"], ["主线梗概", "story"]]);
    expect(plain.notes[0].content).toContain("铜匠打了一把青铜钥匙");
    expect(plain.notes[0].content.length).toBeLessThan(picked.content.length);
    expect(plain.reference).toBeUndefined();
    expect(plain.meta).toEqual({ mode: "notes", noteIds: [picked.id, story.id] });
    expect(notesRange([picked, story])).toEqual({ from: 4, to: 5 });
    const correction = await scopedMaterial(s.repo, s.source, scope, "青铜钥匙", 4000, { worldId: s.world.id, lookups: true });
    expect(correction.meta).toMatchObject({ mode: "notes", lookups: true, from: 4, to: 5 });
    expect(correction.reference?.passages.every((p) => p.section >= 4 && p.section <= 5)).toBe(true);
    const { book, story: own } = await choosableNotes(s.repo, s.source, s.world.id);
    expect(book.map((n) => n.title).sort()).toEqual(["人物：樵夫", "人物：铜匠"]);
    expect(own.map((n) => n.title)).toEqual(["主线梗概"]);
  });

  it("keeps the chapter and route restrictions when notes are selected explicitly", async () => {
    const s = await setup();
    const local = s.done(newStoryNote(s.world.id, "plot", { from: 0, to: 1, toNode: s.cursor.head.id, staleFrom: 1 }, "本局主线"), "主角在城里。");
    const later = s.done(newNote(s.book.id, "plot", { from: 8, to: 9 }, "后面的情节"), "回城之后。", [8, 9]);
    await saveNote(s.repo, local);
    await saveNote(s.repo, later);
    expect(await choosableNotes(s.repo, s.source, s.world.id)).toMatchObject({ book: [], story: [{ id: local.id }] });

    const scope = { mode: "notes" as const, noteIds: [local.id] };
    const options = { worldId: s.world.id };
    const permitted = await scopedMaterial(s.repo, s.source, scope, "城里", 1000, options);
    expect(permitted.notes[0].title).toContain("以正文为准");
    await tree.undo(s.repo, s.cursor);
    expect(await choosableNotes(s.repo, s.source, s.world.id)).toEqual({ book: [], story: [] });
    await expect(scopedMaterial(s.repo, s.source, scope, "城里", 1000, options)).rejects.toThrow("当前路线");
    await expect(scopedMaterial(s.repo, s.source, { mode: "notes", noteIds: [later.id] }, "回城", 1000, options)).rejects.toThrow("当前路线");
  });

  it("estimates a large range before reading whole chapter bodies", async () => {
    const s = await setup(() => "渡口".repeat(4000));
    const db = s.repo.platform.sql;
    const query = db.query.bind(db);
    const wholeChapterReads: string[] = [];
    db.query = async (sql, args) => {
      if (sql.includes("SELECT c.ordinal, c.section, c.text")) wholeChapterReads.push(sql);
      return query(sql, args);
    };
    expect(await rangeContext(s.repo, s.source, { from: 1, to: 7 }, 2500)).toBeUndefined();
    expect(wholeChapterReads).toHaveLength(0);
  });
});

describe("各功能按范围发送 (D184)", () => {
  it("按原著纠错 sends the chosen chapters and the scope for its lookups; 自动 sends no scope", async () => {
    const s = await setup();
    const anchor = { worldId: s.world.id, lineId: s.cursor.line.id, headId: s.cursor.head.id, nodeId: s.cursor.head.id, original: s.cursor.head.narrative };
    const request = { anchor, range: { start: 0, end: anchor.original.length }, hint: "钥匙在哪一章出现" };
    await s.game.runCanonCorrection({ ...request, scope: { mode: "chapters", from: 2, to: 3 } }, () => {}).done.catch(() => {});
    const plan = s.plans[0] as { meta: Record<string, unknown>; messages: { content: string }[]; reference: { passages: { section: number }[] } };
    expect(plan.meta.sourceScope).toEqual({ mode: "chapters", from: 2, to: 3 });
    expect(plan.reference.passages.map((p) => p.section)).toEqual([2, 3]);
    expect(plan.messages[1].content).toContain(s.book.sections[2].text);
    expect(plan.messages[1].content).toContain("【资料范围】这次只用原著第 3～4 章，查原文也只在这几章里。");
    await s.game.runCanonCorrection(request, () => {}).done.catch(() => {});
    expect((s.plans[1] as { meta: Record<string, unknown> }).meta.sourceScope).toBeUndefined();
  });

  it("查一查 with chosen notes answers from them only, without lookups in the book", async () => {
    const s = await setup();
    const note = s.done(newNote(s.book.id, "setting", { subject: "匣子" }, "匣子"), "第五个匣子是空的。", [4]);
    await saveNote(s.repo, note);
    // A long story: the history is cut to fit, and the chosen notes must survive that.
    let c = s.cursor;
    for (let i = 0; i < 40; i++) c = await tree.append(s.repo, c, { kind: "turn", actionMode: "do", actionText: `走第${i}步`, narrative: `第${i}段：${"风吹过渡口，船夫摇着橹。".repeat(40)}`, state: { ...sampleState(), source: s.source } });
    await s.game.ask(s.world.id, "第五个匣子里有什么", () => {}, undefined, { mode: "notes", noteIds: [note.id] }).catch(() => {});
    const plan = s.plans[0] as { meta: Record<string, unknown>; messages: { content: string }[]; reference?: unknown };
    expect(plan.meta.sourceScope).toEqual({ mode: "notes", noteIds: [note.id] });
    const last = plan.messages.at(-1)!.content;
    expect(last).toContain("第五个匣子是空的");
    expect(last).toContain("只依据上面你选的札记回答");
    expect(plan.reference).toBeUndefined();
  });

  it("按我的要求改 and 让 AI 改设定 put the chosen chapters into their one request", async () => {
    const s = await setup();
    const anchor = { worldId: s.world.id, lineId: s.cursor.line.id, headId: s.cursor.head.id, nodeId: s.cursor.head.id, original: s.cursor.head.narrative };
    await s.game.runPlayerRevision({ anchor, range: { start: 0, end: anchor.original.length }, hint: "照第 6 章写", scope: { mode: "chapters", from: 5, to: 5 } }, () => {}).done.catch(() => {});
    expect(s.sent.at(-1)).toContain(s.book.sections[5].text);
    expect(s.sent.at(-1)).not.toContain(s.book.sections[6].text);
    await s.game.reviseEntry(s.world.id, { label: "设定卡", name: "钥匙", aliases: [], text: "一把钥匙" }, "补上来历", { useSource: true, scope: { mode: "chapters", from: 6, to: 6 } }).catch(() => {});
    expect(s.sent.at(-1)).toContain(s.book.sections[6].text);
    expect(s.sent.at(-1)).not.toContain(s.book.sections[5].text);
  });

  it("the opening uses the chosen notes and is not held to a full original check", async () => {
    const s = await setup();
    const note = s.done(newNote(s.book.id, "plot", { from: 0, to: 2 }, "前三章主线"), "主角在第一章得到匣子。", [0, 1, 2]);
    await saveNote(s.repo, note);
    await s.game.createWorld({
      title: "", eraId: null, settings: { premise: "得到匣子之后", mode: "free", depth: "deep" }, protagonist: { name: "林舟", gender: "男", age: 18, identity: "学徒" },
      arrival: "不穿越", origin: "", opening: { mode: "ai", hint: "" }, source: s.source, sourceScope: { mode: "notes", noteIds: [note.id] },
    }, () => {}).catch(() => null);
    const plan = s.plans.at(-1) as { meta: Record<string, unknown>; messages: { content: string }[] };
    expect(s.plans).toHaveLength(1);
    expect(plan.meta.sourceScope).toEqual({ mode: "notes", noteIds: [note.id] });
    expect(plan.meta.referenceReviewVersion).toBeUndefined();
    expect(plan.messages.map((m) => m.content).join("\n")).toContain("主角在第一章得到匣子");
  });

  it("keeps whole chosen opening chapters beyond 3000 chars and aligns rangeContext with native JSON cost (M6)", async () => {
    const tailMarker = "【终段秘钥·勿截断】";
    const longChapter = `${"山雨欲来风满楼，城门紧闭。".repeat(300)}${tailMarker}`;
    expect(longChapter.length).toBeGreaterThan(3600);
    const s = await setup((i) => i === 0 ? longChapter : `第${i + 1}章。`);
    s.game.llm = { ...LLM, contextTokens: 24_000 };
    await s.game.createWorld({
      title: "", eraId: null, settings: { premise: "进城", mode: "free", depth: "standard" }, protagonist: { name: "林舟", gender: "男", age: 18, identity: "学徒" },
      arrival: "不穿越", origin: "", opening: { mode: "ai", hint: "" }, source: s.source, sourceScope: { mode: "chapters", from: 0, to: 0 },
    }, () => {}).catch(() => null);
    const plan = s.plans.at(-1) as { messages: { content: string }[] };
    expect(plan.messages.map((m) => m.content).join("\n")).toContain(tailMarker);

    // JSON escaping overhead (newlines/quotes + metadata) must prevent rangeContext from over-promising.
    const quoted = `"风"\n`.repeat(200); // 800 raw chars, but ~1400 chars after JSON escaping + metadata
    const s2 = await setup((i) => i === 0 ? quoted : "短章。");
    expect(await rangeContext(s2.repo, s2.source, { from: 0, to: 0 }, 950)).toBeUndefined();
    const chapters = await bookChapters(s2.repo, s2.source);
    expect(wholeChapterFits(chapters, { from: 0, to: 0 }, 950)).toBe(false);
    expect(wholeChapterFits(chapters, { from: 0, to: 0 }, 1600)).toBe(true);
  });

  it("rejects a world-owned question note whose refs exceed binding.through while allowing empty-ref questions", async () => {
    const s = await setup();
    const oursEmpty = s.done({ ...newNote(s.book.id, "question", { question: "城门几时开" }, "问事：城门"), worldId: s.world.id }, "卯时开。", []);
    const oursLate = s.done({ ...newNote(s.book.id, "question", { question: "后事如何" }, "问事：后事"), worldId: s.world.id }, "后面会变。", [9]);
    await saveNote(s.repo, oursEmpty);
    await saveNote(s.repo, oursLate);
    const { book } = await choosableNotes(s.repo, s.source, s.world.id);
    expect(book.map((n) => n.id)).toContain(oursEmpty.id);
    expect(book.map((n) => n.id)).not.toContain(oursLate.id);
  });

  it("matches novel chapters by Arabic/Chinese numerals, title text, and shifted front-matter indices", () => {
    expect(parseChapterNumeral("35")).toBe(35);
    expect(parseChapterNumeral("三十五")).toBe(35);
    expect(parseChapterNumeral("第一百零八章")).toBe(108);
    expect(parseChapterNumeral("第十二回")).toBe(12);
    expect(parseChapterNumeral("两百二十")).toBe(220);
    expect(parseChapterNumeral("无效")).toBeNull();
    expect(extractChapterNumbers("第三十五章 水门伏兵")).toEqual([35]);
    const shiftedBook = [
      { section: 0, title: "序章 楔子", chars: 800 },
      { section: 1, title: "第一卷 风起", chars: 120 },
      { section: 2, title: "第一章 渡口", chars: 2400 },
      { section: 36, title: "第三十五章 水门伏兵", chars: 3100 },
    ];
    expect(chapterRowMeta(shiftedBook[2])).toEqual({ primary: "第一章 渡口", shifted: true });
    expect(matchChapterQuery(shiftedBook[3], "35")).toBe(true);
    expect(matchChapterQuery(shiftedBook[3], "三十五")).toBe(true);
    expect(matchChapterQuery(shiftedBook[3], "37")).toBe(true); // 1-based section index
    expect(matchChapterQuery(shiftedBook[3], "35 水门")).toBe(true);
    expect(matchChapterQuery(shiftedBook[3], "35 客栈")).toBe(false);
    expect(chapterRangeSummary(shiftedBook, { from: 2, to: 36 })).toBe("第一章 渡口 ～ 第三十五章 水门伏兵");
  });
});
