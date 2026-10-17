import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { cnNumber, exportStory, huimu, lastSentences, needsRecap, recapOf, searchBook, snippet, storyText } from "./book";
import { migrate } from "./db/migrate";
import { Repo } from "./db/repo";
import { sampleState } from "./testing/fixtures";
import type { Chapter, StoryNode, WorldState } from "./types";

let seq = 0;
function node(fields: Partial<StoryNode>): StoryNode {
  seq++;
  return {
    id: `n${seq}`, worldId: "w", parentId: null, lastChildId: null, seq, kind: "turn", actionMode: "do", actionText: null,
    directorNote: null, narrative: "", record: null, choices: [], status: "ok", rewritten: false, fate: null, meta: {}, createdAt: "", ...fields,
  };
}
function chapter(fields: Partial<Chapter>): Chapter {
  return { id: "c", worldId: "w", firstNodeId: "", lastNodeId: "", title: "", gist: "", summary: "", model: null, promptVersion: null, edited: false, createdAt: "", ...fields };
}

describe("回目", () => {
  it("writes Chinese numbers", () => {
    expect([1, 10, 12, 20, 21, 100, 105, 110, 2026].map(cnNumber)).toEqual(["一", "十", "十二", "二十", "二十一", "一百", "一百零五", "一百一十", "二千零二十六"]);
    expect(huimu(3, "西市问米")).toBe("第三回　西市问米");
    expect(huimu(4)).toBe("第四回");
  });
});

describe("search", () => {
  it("cuts a snippet around the first hit", () => {
    expect(snippet("你走进西市，王掌柜\n抬起头来。", "王掌柜", 3)).toEqual({ before: "…西市，", hit: "王掌柜", after: " 抬起…" });
    expect(snippet("abc", "B")?.hit).toBe("b");
    expect(snippet("abc", "x")).toBeNull();
    expect(snippet("abc", "  ")).toBeNull();
  });

  it("finds passages newest first, people, cards and chapters on the path", () => {
    const opening = node({ kind: "opening", actionMode: null, narrative: "天宝七载冬，你醒在长安。" });
    const a = node({ actionText: "去西市", narrative: "西市里，王掌柜在卖米。" });
    const edit = node({ kind: "edit", actionText: "王掌柜" });
    const b = node({ actionMode: "direct", actionText: "多写王掌柜", narrative: "米价又涨了。" });
    const c = node({ actionMode: "say", actionText: "王掌柜，米怎么卖？", narrative: "他笑了。" });
    const state: WorldState = {
      ...sampleState(),
      people: [{ id: "p1", name: "王掌柜", aliases: [], role: "米铺掌柜", attitude: "一般", alive: true, notes: "", lastSeenMinute: null }],
      cards: [{ id: "k1", kind: "物品", name: "铜鹰符", keys: [], content: "王掌柜押在当铺的符。" }],
    };
    const hits = searchBook({
      path: [opening, a, edit, b, c], state,
      chapters: [chapter({ title: "初到西市", summary: "你在西市遇到王掌柜。", firstNodeId: a.id, lastNodeId: b.id })],
      minutes: new Map([[a.id, 60], [c.id, 120]]),
    }, "王掌柜");
    expect(hits.map((h) => `${h.kind}:${h.title}`)).toEqual(["章回:第一回　初到西市", "人物:王掌柜", "设定:铜鹰符", "正文:第 3 回合", "正文:第 1 回合"]);
    expect(hits[3]).toMatchObject({ nodeId: c.id, minute: 120 });
    expect(hits[0].nodeId).toBe(a.id);
    expect(searchBook({ path: [a], chapters: [], state }, "")).toEqual([]);
  });
});

describe("前情提要", () => {
  it("shows after six hours away", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    expect(needsRecap("2026-10-17T05:00:00Z", now)).toBe(true);
    expect(needsRecap("2026-10-17T07:00:00Z", now)).toBe(false);
    expect(needsRecap(null, now)).toBe(false);
  });

  it("keeps the last sentences with their closing quotes", () => {
    expect(lastSentences("他走了。门外下着雪。掌柜说：“明日再来！”")).toBe("门外下着雪。掌柜说：“明日再来！”");
  });

  it("builds from the latest chapter, the last passage and open goals", () => {
    const opening = node({ kind: "opening", actionMode: null, narrative: "开篇。" });
    expect(recapOf({ path: [opening], chapters: [], state: sampleState() })).toBeNull();
    const t = node({ narrative: "你付了房钱。掌柜点点头。" });
    const state: WorldState = { ...sampleState(), goals: [
      { id: "g1", name: "付清房钱", kind: "主线", progress: "", status: "进行中" },
      { id: "g2", name: "旧事", kind: "支线", progress: "", status: "完成" },
    ] };
    const recap = recapOf({ path: [opening, t], chapters: [chapter({ title: "初到西市", summary: "你初到西市。" }), chapter({ title: "米价风波", summary: "米价涨了。" })], state });
    expect(recap).toEqual({ chapter: { heading: "第二回　米价风波", summary: "米价涨了。" }, last: "你付了房钱。掌柜点点头。", goals: ["付清房钱"] });
  });
});

describe("export as a novel", () => {
  it("writes chapters as 回目, actions as short lines and indented paragraphs", () => {
    const opening = node({ kind: "opening", actionMode: null, narrative: "你醒了。\n\n窗外是长安。" });
    const a = node({ actionText: "去西市", narrative: "西市很热闹。" });
    const b = node({ actionMode: "continue", narrative: "天黑了。" });
    const e = node({ kind: "edit", actionText: "改了状态" });
    const c = node({ actionMode: "say", actionText: "掌柜，米怎么卖？", narrative: "掌柜笑了。" });
    const d = node({ actionMode: "direct", actionText: "写紧张些", narrative: "有人跟着你。" });
    const text = storyText({ title: "长安米贵", subtitle: "李安", path: [opening, a, b, e, c, d], chapters: [chapter({ title: "初到西市", firstNodeId: a.id, lastNodeId: b.id })] });
    expect(text).toBe([
      "《长安米贵》", "李安", "", "", "楔子", "", "　　你醒了。\n　　窗外是长安。",
      "", "", "第一回　初到西市", "", "◇ 你：去西市\n\n　　西市很热闹。", "", "　　天黑了。",
      "", "", "第二回（待续）", "", "◇ 你说：掌柜，米怎么卖？\n\n　　掌柜笑了。", "", "　　有人跟着你。",
      "", "", "（未完待续）", "",
    ].join("\n"));
    expect(text).not.toContain("改了状态");
    expect(text).not.toContain("写紧张些");
  });

  it("exports the current line of a saved world, with game minutes readable on the path", async () => {
    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);
    const { world, node: root, line } = await repo.createWorld({ title: "长安/米贵", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: "你醒了。", state: sampleState() } });
    const later = { ...sampleState(), time: { ...sampleState().time, elapsedMinutes: 90 } };
    const a = await repo.appendNode(world.id, line.id, { parentId: root.id, kind: "turn", actionMode: "do", actionText: "出门", narrative: "街上很冷。", state: later });
    const out = await exportStory(repo, world.id);
    expect(out.fileName).toBe("长安米贵.txt");
    expect(out.text).toContain("《长安/米贵》");
    expect(out.text).toContain("◇ 你：出门");
    const minutes = await repo.minutesOnPath(a.id);
    expect(minutes.get(root.id)).toBe(0);
    expect(minutes.get(a.id)).toBe(90);
  });
});
