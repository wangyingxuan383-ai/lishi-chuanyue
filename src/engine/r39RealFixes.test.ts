import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { migrate } from "./db/migrate";
import { Repo } from "./db/repo";
import { eraContext } from "./era";
import { namesInPlay } from "./memory/recall";
import { askMessages } from "./prompt/ask";
import { renderState } from "./prompt/turn";
import { sampleState } from "./testing/fixtures";
import { cleanNovelProse, parseNovelProseBlocks } from "./text/proseClean";
import { DEFAULT_SETTINGS, type WorldState } from "./types";
import { looksLikeMetaQuestion } from "../ui/screens/Play";
import { listLibraryShelfItems, saveWorldNovelToLibrary } from "./reader/shelf";

describe("R39 real-device regression suite", () => {
  it("cleans the exact 0.22.1 Android raw Markdown essay into clean book prose and dividers", () => {
    const rawIncident = [
      "** 【关于预备队人选的说明】 **",
      "按目前本局已经改变的局势来看，后续若组建史莱克七怪预备队，**大概率不会完全照搬原著人选**。",
      "1. **原著与本局现状的边界**",
      "  * **一年级第一的含金量**: 刚结束的“一至五年级核心弟子大乱斗”本就打乱了常规新生晋升节奏。",
      "---",
      "当前剧情仍停留在 **斗罗历10000年10月10日 · 14:03 · 内院静室**。",
    ].join("\n\n");

    const blocks = parseNovelProseBlocks(rawIncident);
    expect(blocks).toEqual([
      { kind: "prose", text: "【关于预备队人选的说明】" },
      { kind: "prose", text: "按目前本局已经改变的局势来看，后续若组建史莱克七怪预备队，大概率不会完全照搬原著人选。" },
      { kind: "prose", text: "1. 原著与本局现状的边界" },
      { kind: "prose", text: "  一年级第一的含金量: 刚结束的“一至五年级核心弟子大乱斗”本就打乱了常规新生晋升节奏。" },
      { kind: "divider" },
      { kind: "prose", text: "当前剧情仍停留在 斗罗历10000年10月10日 · 14:03 · 内院静室。" },
    ]);

    const cleaned = cleanNovelProse(rawIncident);
    expect(cleaned).not.toContain("**");
    expect(cleaned).not.toContain("---");
    expect(cleaned).toContain("◇");
  });

  it("detects out-of-character canon/meta questions in Play without false-flagging in-world actions or dialogue", () => {
    // Exact user input from Android screenshot #1
    expect(
      looksLikeMetaQuestion("按理来说，应该是要选出来史莱克七怪预备队的，这样的话还会是原作中的人选吗？"),
    ).toBe(true);
    expect(looksLikeMetaQuestion("原著里玄老这时候在不在场？")).toBe(true);
    expect(looksLikeMetaQuestion("本局现在王亦的魂力是多少级了？")).toBe(true);
    expect(looksLikeMetaQuestion("请问一下，接下来还会按原剧情走吗")).toBe(true);

    // Normal in-character actions & spoken dialogue must NOT trigger the meta guard
    expect(looksLikeMetaQuestion("向言少哲拱手行礼，询问核心弟子的修行安排")).toBe(false);
    expect(looksLikeMetaQuestion("“预备队的人选定了吗？”我低声问贝贝。")).toBe(false);
    expect(looksLikeMetaQuestion("推开静室的门走出去看看外面的动静")).toBe(false);
    expect(looksLikeMetaQuestion("盘膝调息，稳住体内翻涌的凤凰魂力")).toBe(false);
  });

  it("deduplicates re-compiled world novels in 书斋 instead of spawning duplicate EPUB copies", async () => {
    const platform = await createMemoryPlatform();
    await migrate(platform);
    const repo = new Repo(platform);
    const state = sampleState();
    const { world, node: opening, line } = await repo.createWorld({
      title: "王亦的故事",
      eraId: "free",
      opening: {
        parentId: null,
        kind: "opening",
        narrative: "斗罗历一万年，史莱克学院内院静室。",
        state,
      },
    });

    const first = await saveWorldNovelToLibrary(repo, world.id);
    let shelf = await listLibraryShelfItems(repo);
    expect(shelf).toHaveLength(1);
    expect(shelf[0].id).toBe(first.bookId);
    expect(shelf[0].origin).toBe("world-novel");

    // Advance one turn and re-compile: should update the same bookId in place
    await repo.appendNode(world.id, line.id, {
      parentId: opening.id,
      kind: "turn",
      actionMode: "do",
      actionText: "调息养伤",
      narrative: "温暖的魂力流过经脉，伤势渐渐平稳。",
      state,
    });

    const second = await saveWorldNovelToLibrary(repo, world.id);
    expect(second.bookId).toBe(first.bookId);
    shelf = await listLibraryShelfItems(repo);
    expect(shelf).toHaveLength(1);
    expect(shelf[0].totalChars).toBeGreaterThan(20);
  });

  it("handles partial Person/Card entries missing aliases, keys, or alive without throwing or mislabeling alive people as dead", () => {
    const base = sampleState();
    const partialState = {
      ...base,
      era: { mode: "free" },
      people: [
        // Simulate imported/patched Person missing aliases and alive
        { id: "p-yan", name: "言少哲", role: "武魂系院长", attitude: "器重" } as unknown as WorldState["people"][number],
        { id: "p-dead", name: "风狒狒", role: "十年魂兽", attitude: "敌对", alive: false } as unknown as WorldState["people"][number],
      ],
      cards: [
        // Simulate imported/patched Card missing keys
        { id: "c-shrek", kind: "势力", name: "史莱克学院", content: "大陆第一魂师学院", source: "开场" } as unknown as WorldState["cards"][number],
      ],
    } as WorldState;
    const era = eraContext("free", partialState);

    const rendered = renderState(partialState, era);
    expect(rendered).toContain("言少哲：武魂系院长，对主角器重");
    expect(rendered).not.toContain("言少哲：武魂系院长，对主角器重，已死");
    expect(rendered).toContain("风狒狒：十年魂兽，对主角敌对，已死");

    const recalled = namesInPlay(partialState, "言少哲在史莱克学院静室看望王亦。");
    expect(recalled.map((r) => r.name)).toEqual(["史莱克学院", "言少哲"]);

    const msgs = askMessages({
      question: "史莱克七怪预备队都有谁？",
      state: partialState,
      era,
      settings: { ...DEFAULT_SETTINGS, mode: "free" },
      chapters: [],
      history: [],
      pins: [],
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toContain("史莱克学院");
  });
});
