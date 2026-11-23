import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { migrate } from "./db/migrate";
import { Repo } from "./db/repo";
import { buildNovelBook, formatNovelMarkdown, formatNovelTxt, novelFileName } from "./novel";
import { parseBook } from "./sources/parse";
import { sampleState } from "./testing/fixtures";
import type { WorldState } from "./types";

describe("true-novel builder (novel.ts)", () => {
  it("strips ◇ command echoes by default, preserves write-mode prose, and inserts quiet transitions", async () => {
    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);

    const base = sampleState();
    const { world, node: opening, line } = await repo.createWorld({
      title: "长安客栈记",
      eraId: "tang-748",
      opening: {
        parentId: null,
        kind: "opening",
        narrative: "　　天宝七载冬，你推开怀远坊的木门。\n\n檐角积雪簌簌落下。",
        state: base,
      },
    });

    const state1: WorldState = {
      ...base,
      time: { ...base.time, elapsedMinutes: 30 },
    };
    const t1 = await repo.appendNode(world.id, line.id, {
      parentId: opening.id,
      kind: "turn",
      actionMode: "do",
      actionText: "去柜台问房钱",
      narrative: "掌柜拨着算盘，头也不抬地报了价。",
      record: { time: 30 },
      state: state1,
    });

    const state2: WorldState = {
      ...base,
      time: { ...base.time, elapsedMinutes: 60 },
    };
    const t2 = await repo.appendNode(world.id, line.id, {
      parentId: t1.id,
      kind: "turn",
      actionMode: "write",
      actionText: "你解下腰间铜钱，一枚枚排在柜面上。",
      narrative: "铜钱相击，发出清脆声响。",
      record: { time: 30 },
      state: state2,
    });

    const state3: WorldState = {
      ...base,
      placeId: "p-east",
      places: [...base.places, { id: "p-east", name: "东市", description: "达官贵人聚集之所" }],
      time: { ...base.time, elapsedMinutes: 60 + 3 * 1440 },
    };
    await repo.appendNode(world.id, line.id, {
      parentId: t2.id,
      kind: "fastforward",
      actionMode: "skip",
      actionText: "在客栈安顿三日后前往东市",
      narrative: "三日后雪霁天晴，东市车马如流。",
      record: { time: 3 * 1440, place: "东市" },
      state: state3,
    });

    const novel = (await buildNovelBook(repo, world.id))!;
    expect(novel).not.toBeNull();
    expect(novel.statusLine).toBe("—— 未完待续 ——");

    const txt = formatNovelTxt(novel);
    expect(txt).not.toContain("◇ 你：");
    expect(txt).not.toContain("去柜台问房钱");
    expect(txt).not.toContain("在客栈安顿三日");
    // Write-mode player prose is seamlessly retained as real story prose!
    expect(txt).toContain("　　你解下腰间铜钱，一枚枚排在柜面上。");
    expect(txt).toContain("　　铜钱相击，发出清脆声响。");
    // Fastforward + multi-day place jump produces a quiet divider block!
    const chap = novel.sections.find((s) => s.kind === "chapter")!;
    expect(chap.paragraphs.some((p) => p.kind === "divider" && p.text.includes("东市"))).toBe(true);

    // When includeActions = true, clean action blocks are included.
    const withActions = (await buildNovelBook(repo, world.id, { includeActions: true }))!;
    const chapWithActions = withActions.sections.find((s) => s.kind === "chapter")!;
    expect(chapWithActions.paragraphs.some((p) => p.kind === "action" && p.text === "你：去柜台问房钱")).toBe(true);
  });

  it("never swallows Chapter 1 whether chapters[0] starts at opening or Turn 1, and keeps fastforward inside chapters", async () => {
    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);

    const base = sampleState();
    const { world, node: opening, line } = await repo.createWorld({
      title: "西市风云",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "开篇暮色四合。", state: base },
    });
    const t1 = await repo.appendNode(world.id, line.id, {
      parentId: opening.id,
      kind: "turn",
      actionMode: "say",
      actionText: "店家温酒",
      narrative: "酒肆灯火摇曳。",
      state: { ...base, time: { ...base.time, elapsedMinutes: 30 } },
    });
    const ff = await repo.appendNode(world.id, line.id, {
      parentId: t1.id,
      kind: "fastforward",
      actionMode: "skip",
      actionText: "过两日",
      narrative: "两日间胡商云集。",
      state: { ...base, time: { ...base.time, elapsedMinutes: 2910 } },
    });
    const t3 = await repo.appendNode(world.id, line.id, {
      parentId: ff.id,
      kind: "turn",
      actionMode: "do",
      actionText: "查看货栈",
      narrative: "货栈里堆满驼铃丝绸。",
      state: { ...base, time: { ...base.time, elapsedMinutes: 2950 } },
    });

    // Case A: chapters[0] starts at Turn 1 (`path[1]`) -> `楔子` + `第一回 · 夜饮西市`
    const ch1 = await repo.addChapter({
      worldId: world.id,
      firstNodeId: t1.id,
      lastNodeId: t3.id,
      title: "夜饮西市",
      gist: "主角于西市酒肆听闻胡商消息。",
      summary: "主角夜饮西市，两日后赴货栈查探。",
      model: null,
      promptVersion: null,
    });

    const bookA = (await buildNovelBook(repo, world.id, { includePreface: false, includeChronicle: false }))!;
    expect(bookA.sections.map((s) => s.title)).toEqual(["楔子", "第一回 · 夜饮西市"]);
    expect(bookA.sections[1].paragraphs.some((p) => p.text.includes("两日间胡商云集。"))).toBe(true);

    // Case B: chapters[0] starts right at `opening` (`path[0]`) -> `第一回 · 夜饮西市` is NOT swallowed!
    await repo.deleteChapter(ch1.id);
    await repo.addChapter({
      worldId: world.id,
      firstNodeId: opening.id,
      lastNodeId: t3.id,
      title: "夜饮西市",
      gist: "从入城到货栈。",
      summary: "全章概要。",
      model: null,
      promptVersion: null,
    });
    const bookB = (await buildNovelBook(repo, world.id, { includePreface: false, includeChronicle: false }))!;
    expect(bookB.sections.map((s) => s.title)).toEqual(["第一回 · 夜饮西市"]);
    expect(bookB.sections[0].paragraphs[0].text).toContain("开篇暮色四合。");
  });

  it("auto-chapters a 25-turn story with 0 AI summaries into readable traditional chapters parseable by parseBook", async () => {
    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);

    const base: WorldState = {
      ...sampleState(),
      placeId: "p1",
      places: [{ id: "p1", name: "长安", description: "帝京" }],
      people: [
        { id: "npc1", name: "裴十二", aliases: ["裴郎"], role: "不良人", attitude: "友善", alive: true, notes: "巡街相识", lastSeenMinute: 600 },
      ],
      goals: [{ id: "g1", name: "站稳脚跟", kind: "主线", progress: "已在西市落脚", status: "完成", endedMinute: 720 }],
      deviations: ["提前揭穿胡商假币案"],
    };

    const { world, node: opening, line } = await repo.createWorld({
      title: "大唐行商录",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "初雪落满朱雀大街。", state: base },
    });

    let parentId = opening.id;
    const places = ["长安", "西市", "曲江"];
    for (let i = 1; i <= 25; i++) {
      const place = places[Math.floor((i - 1) / 10)] ?? "曲江";
      const elapsedMinutes = i * 180;
      const saved = await repo.appendNode(world.id, line.id, {
        parentId,
        kind: "turn",
        actionMode: "do",
        actionText: `第${i}步行动`,
        narrative: `第${i}段正文：风吹过${place}的坊墙，行人匆匆而过。`,
        record: { time: 180, ...(i === 1 || i === 11 || i === 21 ? { place } : {}) },
        state: { ...base, time: { ...base.time, elapsedMinutes } },
      });
      parentId = saved.id;
    }

    const novel = (await buildNovelBook(repo, world.id))!;
    expect(novel.turnCount).toBe(25);
    expect(novel.chapterCount).toBe(3); // 10 + 10 + 5 turns
    const chapterTitles = novel.sections.filter((s) => s.kind === "chapter").map((s) => s.title);
    expect(chapterTitles).toHaveLength(3);
    expect(chapterTitles[0]).toMatch(/^第一回 · /);
    expect(chapterTitles[1]).toMatch(/^第二回 · /);
    expect(chapterTitles[2]).toMatch(/^第三回 · /);
    // Distinct auto-generated titles
    expect(new Set(chapterTitles).size).toBe(3);

    // Preface & Appendix verification
    const preface = novel.sections.find((s) => s.kind === "preface")!;
    expect(preface.title).toBe("卷首 · 人物与前情");
    expect(preface.paragraphs.some((p) => p.text.includes("裴十二"))).toBe(true);

    const appendix = novel.sections.find((s) => s.kind === "appendix")!;
    expect(appendix.title).toBe("附录 · 本局大事纪年");
    expect(appendix.paragraphs.some((p) => p.text.includes("站稳脚跟"))).toBe(true);
    expect(appendix.paragraphs.some((p) => p.text.includes("提前揭穿胡商假币案"))).toBe(true);

    // Plain-text formatting + parseBook chapter detection
    const txt = formatNovelTxt(novel);
    const parsed = await parseBook({ name: novelFileName(novel.title, "txt"), bytes: strToU8(txt) }, platform);
    expect(parsed.sections.some((s) => s.title === "楔子")).toBe(true);
    expect(parsed.sections.some((s) => s.title.startsWith("第一回 · "))).toBe(true);
    expect(parsed.sections.some((s) => s.title.startsWith("第二回 · "))).toBe(true);
    expect(parsed.sections.some((s) => s.title.startsWith("第三回 · "))).toBe(true);

    // Markdown formatting & safe file naming
    const md = formatNovelMarkdown(novel);
    expect(md).toContain("# 《大唐行商录》");
    expect(md).toContain("## 卷首 · 人物与前情");
    expect(novelFileName('大唐:行商/录*?"<>|', "epub")).toBe("大唐行商录.epub");
  });

  it("computes accurate colophon statusLine for death vs 宽松 difficulty and completed challenge/script", async () => {
    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);

    const deadState: WorldState = {
      ...sampleState(),
      protagonist: {
        ...sampleState().protagonist,
        stats: { ...sampleState().protagonist.stats, health: 0 },
      },
    };

    const { world: deadWorld } = await repo.createWorld({
      title: "孤城绝响",
      eraId: "tang-748",
      settings: { difficulty: "标准" },
      opening: { parentId: null, kind: "opening", narrative: "残阳如血。", state: deadState },
    });
    expect((await buildNovelBook(repo, deadWorld.id))?.statusLine).toBe("—— 全书完 · 这一世终 ——");

    // On 宽松 difficulty, health <= 0 does not mean protagonist death.
    const { world: relaxedWorld } = await repo.createWorld({
      title: "宽松不死",
      eraId: "tang-748",
      settings: { difficulty: "宽松" },
      opening: { parentId: null, kind: "opening", narrative: "幸得良医相救。", state: deadState },
    });
    expect((await buildNovelBook(repo, relaxedWorld.id))?.statusLine).toBe("—— 未完待续 ——");

    // Completed challenge -> —— 本卷完 ——
    const wonState: WorldState = {
      ...sampleState(),
      challenge: {
        goal: "三月内还清积欠",
        limit: "三个月",
        deadlineMinute: 129600,
        failIf: "",
        progress: "全数结清",
        status: "won",
        startedMinute: 0,
        endedMinute: 20000,
        outcome: "如期偿清债款",
      },
    };
    const { world: challengeWorld } = await repo.createWorld({
      title: "还债记",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "账册合上。", state: wonState },
    });
    expect((await buildNovelBook(repo, challengeWorld.id))?.statusLine).toBe("—— 本卷完 ——");
  });
});
