import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "../platform";
import { createMemoryPlatform } from "../platform/memory";
import { archiveProblems, exportWorld, importWorld } from "./archive";
import { migrate } from "./db/migrate";
import { Repo } from "./db/repo";
import { buildEpubBytes } from "./epub";
import { buildNovelBook } from "./novel";
import {
  getAllBookShelfPrefs,
  listLibraryShelfItems,
  saveWorldNovelToLibrary,
  updateBookShelfPref,
} from "./reader/shelf";
import {
  addReaderBookmark,
  addReaderHighlight,
  getReaderProgress,
  getWorldNovelProgress,
  listReaderBookmarks,
  listReaderHighlights,
  resolveHighlightRouteTarget,
  saveReaderProgress,
  saveWorldNovelProgress,
  worldNovelProgressTargetId,
} from "./reader/store";
import {
  chunksOf,
  getBook,
  hasBookExternalReferences,
  readBookSection,
  saveBook,
  saveJob,
} from "./sources/library";
import { newLocalNote, newNote, saveNote } from "./sources/notes";
import { decodeHtmlEntities, normalizeArchivePath, parseBook } from "./sources/parse";
import {
  RESPLIT_WORKER_SOURCE,
  applyBookResplit,
  compileSafeLineRegex,
  splitTextWithRule,
  splitTextWithRuleAsync,
} from "./sources/resplit";
import { newBinding, type SourceBook } from "./sources/types";
import { sampleState } from "./testing/fixtures";
import { filterExcerptsForWorldRoute } from "../ui/components/ExcerptsSheet";
import {
  applyPendingScrollAction,
  classifyBookParagraph,
  collectNovelRouteNodeIds,
  encodeWorldNovelAnnotationNodeId,
  filterParagraphHighlights,
  filterWorldNovelBookmarks,
  filterWorldNovelHighlights,
  findCurrentSectionBookmark,
  locateNovelNodeTarget,
  resolveHighlightSpans,
  resolveWorldNovelBookmarkJump,
  type PendingScrollAction,
  type ScrollableStageLike,
} from "../ui/screens/ReaderScreen";
import { buildReaderAskHandoff, type AskTurn } from "../ui/screens/reader/ReaderAskSheet";
import {
  useReaderTts,
  type ReaderTtsController,
  type UseReaderTtsOptions,
} from "../ui/screens/reader/readerTts";

let platform: Platform;
let repo: Repo;

beforeEach(async () => {
  platform = await createMemoryPlatform();
  await migrate(platform);
  repo = new Repo(platform);
});

describe("R41-T006: Copy-on-write book resplit & world-novel re-compilation (#1 & #2)", () => {
  it("updates unreferenced pure-reading books in place on resplit while re-anchoring annotations", async () => {
    const raw = [
      "楔子 寒夜孤灯\n风雪拍打着破庙的窗棂。",
      "第一章 初入雁门\n少年背着长刀踏入关城。",
      "第二章 古驿听风\n老驿卒低声说起塞外异动，案头油灯摇晃。",
    ].join("\n\n");

    await saveBook(repo, {
      id: "pure-book",
      title: "雁门行",
      format: "txt",
      createdAt: "2026-11-27T00:00:00.000Z",
      sections: [{ title: "正文", text: raw }],
    });

    expect(await hasBookExternalReferences(repo, "pure-book")).toBe(false);

    await addReaderBookmark(repo, {
      targetType: "book",
      targetId: "pure-book",
      sectionIndex: 0,
      sectionTitle: "正文",
      snippet: "老驿卒低声说起塞外异动",
      paragraphIndex: 4,
      nodeId: null,
    });
    await addReaderHighlight(repo, {
      targetType: "book",
      targetId: "pure-book",
      worldId: null,
      sectionIndex: 0,
      sectionTitle: "正文",
      paragraphIndex: 4,
      charStart: 0,
      charEnd: 11,
      selectedText: "老驿卒低声说起塞外异动",
      note: "关键伏笔",
      color: "amber",
      nodeId: null,
    });
    await saveReaderProgress(repo, {
      targetType: "book",
      targetId: "pure-book",
      sectionIndex: 0,
      pageIndex: 0,
      scrollRatio: 0.7,
      anchorText: "少年背着长刀踏入关城",
      nodeId: null,
    });

    const res = await applyBookResplit(repo, "pure-book", { preset: "standard" });
    expect(res.forked).toBe(false);
    expect(res.bookId).toBe("pure-book");
    expect(res.sectionCount).toBe(3);

    const bms = await listReaderBookmarks(repo, "book", "pure-book");
    expect(bms[0]?.sectionIndex).toBe(2);
    expect(bms[0]?.sectionTitle).toBe("第二章 古驿听风");

    const hls = await listReaderHighlights(repo, { targetType: "book", targetId: "pure-book" });
    expect(hls[0]?.sectionIndex).toBe(2);
    expect(hls[0]?.note).toBe("关键伏笔");

    const prog = await getReaderProgress(repo, "book", "pure-book");
    expect(prog?.sectionIndex).toBe(1);
  });

  it("forks into a new bookId when referenced by a world, canon_notes, or source_jobs, keeping archive export 100% valid", async () => {
    const raw = [
      "【001】青石桥畔\n阿青在青石桥经营书铺，青铜钥匙藏在灯座下。",
      "【002】夜渡寒江\n阿白乘孤舟夜渡寒江，接过青铜钥匙。",
    ].join("\n\n");
    const origBook: SourceBook = {
      id: "cited-book",
      title: "青石书铺录",
      format: "txt",
      createdAt: "2026-11-27T01:00:00.000Z",
      sections: [{ title: "正文", text: raw }],
    };
    await saveBook(repo, origBook);
    await updateBookShelfPref(repo, "cited-book", {
      author: "青石散人",
      coverTone: 5,
      pinned: true,
    });

    const chunks = chunksOf(origBook);
    const quote = "青铜钥匙藏在灯座下。";
    const quoteStart = chunks[0]!.text.indexOf(quote);
    expect(quoteStart).toBeGreaterThanOrEqual(0);

    const st = sampleState();
    st.source = newBinding("cited-book", true);
    st.facts = [
      {
        id: "fact-1",
        detail: "青铜钥匙藏在书铺灯座下",
        origin: "source",
        citations: [
          {
            bookId: "cited-book",
            section: 0,
            chunk: 0,
            title: "正文",
            quote,
            start: quoteStart,
            end: quoteStart + quote.length,
          },
        ],
      },
    ];

    const { world } = await repo.createWorld({
      title: "书铺同人局",
      eraId: "free",
      opening: { parentId: null, kind: "opening", narrative: "雨落青石桥。", state: st },
    });

    const note = newLocalNote(
      newNote("cited-book", "plot", { from: 0, to: 0 }, "主线：第 1 章", world.id),
      "第 1 章记述阿青将青铜钥匙藏在灯座下。",
      1,
    );
    await saveNote(repo, note);
    await saveJob(repo, {
      id: "job-1",
      bookId: "cited-book",
      instructions: "",
      through: null,
      status: "paused",
      completed: 0,
      total: 1,
      model: "test-m",
      promptVersion: "source-4",
    });

    expect(await hasBookExternalReferences(repo, "cited-book")).toBe(true);

    await addReaderHighlight(repo, {
      targetType: "book",
      targetId: "cited-book",
      worldId: null,
      sectionIndex: 0,
      sectionTitle: "正文",
      paragraphIndex: 1,
      charStart: 0,
      charEnd: 10,
      selectedText: "阿白乘孤舟夜渡寒江",
      note: "渡江名场面",
      color: "bamboo",
      nodeId: null,
    });
    await saveReaderProgress(repo, {
      targetType: "book",
      targetId: "cited-book",
      sectionIndex: 0,
      pageIndex: 0,
      scrollRatio: 0.8,
      anchorText: "阿白乘孤舟夜渡寒江",
      nodeId: null,
    });

    const res = await applyBookResplit(repo, "cited-book", { preset: "numbered" });
    expect(res.forked).toBe(true);
    expect(res.bookId).not.toBe("cited-book");
    expect(res.sectionCount).toBe(2);
    expect(res.sampleTitles).toEqual(["【001】青石桥畔", "【002】夜渡寒江"]);

    // Original book MUST remain 100% untouched so world citations & archive round-trip pass!
    const untouchedOrig = await getBook(repo, "cited-book");
    expect(untouchedOrig?.sections).toEqual(origBook.sections);

    const exported = await exportWorld(repo, world.id);
    expect(archiveProblems(exported)).toEqual([]);
    const importedId = await importWorld(repo, exported, "new");
    expect(importedId).toBeTruthy();

    // Forked book has new split chapters, cloned shelf prefs, and re-anchored annotations
    const forkedSec1 = await readBookSection(repo, res.bookId, 1);
    expect(forkedSec1?.title).toBe("【002】夜渡寒江");

    const prefs = await getAllBookShelfPrefs(repo);
    expect(prefs[res.bookId]).toMatchObject({
      author: "青石散人",
      coverTone: 5,
      pinned: true,
    });

    const clonedHighlights = await listReaderHighlights(repo, {
      targetType: "book",
      targetId: res.bookId,
    });
    expect(clonedHighlights).toHaveLength(1);
    expect(clonedHighlights[0]?.sectionIndex).toBe(1);
    expect(clonedHighlights[0]?.note).toBe("渡江名场面");

    const clonedProg = await getReaderProgress(repo, "book", res.bookId);
    expect(clonedProg?.sectionIndex).toBe(1);
  });

  it("protects cited or multi-route world novels during saveWorldNovelToLibrary while re-anchoring unreferenced updates", async () => {
    const base = sampleState();
    const { world, node: opening, line: mainLine } = await repo.createWorld({
      title: "洛阳风华录",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "洛阳天津桥上晓月如钩。", state: base },
    });
    const turn1 = await repo.appendNode(world.id, mainLine.id, {
      parentId: opening.id,
      kind: "turn",
      actionMode: "do",
      actionText: "凭栏远眺",
      narrative: "洛水波光潋滟，画舫徐徐驶过桥洞。",
      state: { ...base, time: { ...base.time, elapsedMinutes: 60 } },
    });

    const firstCompile = await saveWorldNovelToLibrary(repo, world.id);
    expect(firstCompile.forked).toBe(false);

    // Add highlight on turn1 text and another highlight on a phrase we will rewrite
    await addReaderHighlight(repo, {
      targetType: "book",
      targetId: firstCompile.bookId,
      worldId: null,
      sectionIndex: 2,
      sectionTitle: "第一回",
      paragraphIndex: 0,
      charStart: 0,
      charEnd: 6,
      selectedText: "画舫徐徐驶过",
      note: "留存选段",
      color: "cinnabar",
      nodeId: null,
    });
    await addReaderHighlight(repo, {
      targetType: "book",
      targetId: firstCompile.bookId,
      worldId: null,
      sectionIndex: 1,
      sectionTitle: "楔子",
      paragraphIndex: 0,
      charStart: 0,
      charEnd: 6,
      selectedText: "洛阳天津桥上",
      note: "即将改写",
      color: "amber",
      nodeId: null,
    });

    await repo.updateNarrative(opening.id, "洛阳铜驼陌上晨钟初响。");
    const secondCompile = await saveWorldNovelToLibrary(repo, world.id);
    expect(secondCompile.bookId).toBe(firstCompile.bookId);
    expect(secondCompile.forked).toBe(false);

    const updatedHls = await listReaderHighlights(repo, {
      targetType: "book",
      targetId: secondCompile.bookId,
    });
    const keptHl = updatedHls.find((h) => h.note === "留存选段")!;
    const rewrittenHl = updatedHls.find((h) => h.note === "即将改写")!;
    expect(keptHl.charEnd).toBeGreaterThan(keptHl.charStart);
    // Deleted snippet has offsets cleared to 0..0 so it never mis-highlights new text
    expect(rewrittenHl.charStart).toBe(0);
    expect(rewrittenHl.charEnd).toBe(0);
    expect(resolveHighlightSpans("洛阳铜驼陌上晨钟初响。", [rewrittenHl])).toEqual([]);

    // Branch off opening into a distinct route "雪夜抗命" -> MUST allocate a new bookId!
    const altLine = await repo.createLine(world.id, opening.id, "雪夜抗命", false);
    await repo.appendNode(world.id, altLine.id, {
      parentId: opening.id,
      kind: "turn",
      actionMode: "do",
      actionText: "转身入暗巷",
      narrative: "暗巷深处传来急促的马蹄声。",
      state: { ...base, time: { ...base.time, elapsedMinutes: 45 } },
    });
    const branchCompile = await saveWorldNovelToLibrary(repo, world.id, { lineId: altLine.id });
    expect(branchCompile.bookId).not.toBe(firstCompile.bookId);
    expect(branchCompile.title).toContain("雪夜抗命");

    // Now cite firstCompile.bookId in a sequel world -> re-compiling mainLine MUST fork instead of overwriting!
    const sequelState = sampleState();
    sequelState.source = newBinding(firstCompile.bookId, false);
    const { world: sequelWorld } = await repo.createWorld({
      title: "洛阳后传",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "十年后再入洛阳。", state: sequelState },
    });
    await repo.appendNode(world.id, mainLine.id, {
      parentId: turn1.id,
      kind: "turn",
      actionMode: "do",
      actionText: "登船饮茶",
      narrative: "船头茶烟袅袅。",
      state: { ...base, time: { ...base.time, elapsedMinutes: 120 } },
    });

    const thirdCompile = await saveWorldNovelToLibrary(repo, world.id, { lineId: mainLine.id });
    expect(thirdCompile.forked).toBe(true);
    expect(thirdCompile.bookId).not.toBe(firstCompile.bookId);

    // Sequel world archive remains 100% valid!
    const sequelArchive = await exportWorld(repo, sequelWorld.id);
    expect(archiveProblems(sequelArchive)).toEqual([]);

    const shelf = await listLibraryShelfItems(repo);
    expect(shelf.length).toBe(3);
  });
});

describe("R41-T006: Safe custom regex parser & Worker timeout isolation (#5)", () => {
  it("blocks exponential backtracking, backreferences, and unanchored overlapping wildcards while allowing CJK chapter rules", () => {
    const dangerousPatterns = [
      "(a|aa)+",
      "((a+))+",
      "([a-z]+)*",
      "(a|a?)+",
      "(a+){2,5}",
      "((?:甲|乙))+",
      "^(.*)\\1$",
      ".*.*",
      ".+.+",
      "^.*\\s*.*$",
      ".*第.*章",
    ];
    for (const pat of dangerousPatterns) {
      expect(() => compileSafeLineRegex(pat), `pattern should be rejected: ${pat}`).toThrow();
    }

    const validPatterns = [
      "^第[0-9零〇一二两三四五六七八九十百千万]+[章回节话卷集篇].*",
      "^[0-9]+[\\.、\\s].*",
      "^(?:楔子|序章|第.+章).*",
      "^卷[甲乙丙丁]\\s+.+$",
    ];
    for (const pat of validPatterns) {
      const re = compileSafeLineRegex(pat);
      expect(re).toBeInstanceOf(RegExp);
    }

    const chRe = compileSafeLineRegex("^(?:楔子|序章|第.+章).*");
    expect(chRe.test("楔子 朔风起")).toBe(true);
    expect(chRe.test("第十二章 夜宴")).toBe(true);
    expect(chRe.test("普通正文段落。")).toBe(false);
  });

  it("terminates Web Worker immediately on AbortSignal or 800ms timeout without hanging", async () => {
    const origWorker = globalThis.Worker;
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;

    let terminatedCount = 0;
    let mode: "hang" | "resolve" = "hang";

    class FakeWorker {
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: ((ev: ErrorEvent) => void) | null = null;
      constructor(_url: string | URL) {}
      postMessage(_data: unknown) {
        if (mode === "resolve") {
          setTimeout(() => {
            this.onmessage?.({
              data: { ok: true, sections: [{ title: "第一章 破晓", text: "晨光熹微。" }] },
            } as MessageEvent);
          }, 10);
        }
      }
      terminate() {
        terminatedCount += 1;
      }
    }

    try {
      (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
      URL.createObjectURL = () => "blob:test-resplit-worker";
      URL.revokeObjectURL = () => {};

      // 1. Timeout triggers worker.terminate()
      mode = "hang";
      await expect(
        splitTextWithRuleAsync("第一章 破晓\n晨光熹微。", { preset: "standard" }, { timeoutMs: 60 }),
      ).rejects.toThrow(/超时/);
      expect(terminatedCount).toBe(1);

      // 2. AbortController cancellation immediately terminates worker
      const ctrl = new AbortController();
      const pending = splitTextWithRuleAsync(
        "第一章 破晓\n晨光熹微。",
        { preset: "standard" },
        { signal: ctrl.signal, timeoutMs: 800 },
      );
      setTimeout(() => ctrl.abort(), 15);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(terminatedCount).toBe(2);

      // 3. Normal Worker resolution returns sections cleanly
      mode = "resolve";
      const okSections = await splitTextWithRuleAsync("第一章 破晓\n晨光熹微。", { preset: "standard" });
      expect(okSections).toEqual([{ title: "第一章 破晓", text: "晨光熹微。" }]);
    } finally {
      (globalThis as unknown as { Worker: unknown }).Worker = origWorker;
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }

    // 4. Execute RESPLIT_WORKER_SOURCE in a completely isolated global Function scope (simulating minified APK Blob Worker)
    const runIsolatedWorker = (rawText: string, rule: { preset: string; fixedChars?: number; customPattern?: string }) => {
      let posted: { ok?: boolean; sections?: { title: string; text: string }[]; error?: string } | null = null;
      const selfObj: {
        onmessage: ((ev: { data: unknown }) => void) | null;
        postMessage: (msg: { ok?: boolean; sections?: { title: string; text: string }[]; error?: string }) => void;
      } = {
        onmessage: null,
        postMessage: (msg) => {
          posted = msg;
        },
      };
      const init = new Function("self", RESPLIT_WORKER_SOURCE);
      init(selfObj);
      selfObj.onmessage?.({ data: { rawText, rule } });
      return posted!;
    };

    const sampleTxt = "楔子 塞北风雪\n寒风呼啸。\n\n第一章 初入长安\n朱雀大街人声鼎沸。\n\n第二章 夜探安邑坊\n灯火阑珊。";
    const stdOut = runIsolatedWorker(sampleTxt, { preset: "standard" });
    expect(stdOut.ok).toBe(true);
    expect(stdOut.sections).toEqual(splitTextWithRule(sampleTxt, { preset: "standard" }));

    const fixedOut = runIsolatedWorker(sampleTxt, { preset: "fixed_length", fixedChars: 800 });
    expect(fixedOut.ok).toBe(true);
    expect(fixedOut.sections).toEqual(splitTextWithRule(sampleTxt, { preset: "fixed_length", fixedChars: 800 }));
  });
});

describe("R41-T006: ReaderScreen scroll positioning single-consumption (E06)", () => {
  function makeMockScroller(paraOffsets: Record<number, number>): ScrollableStageLike & { flashed: number[] } {
    const flashed: number[] = [];
    const scroller: ScrollableStageLike & { flashed: number[] } = {
      scrollTop: 0,
      scrollHeight: 2400,
      clientHeight: 400,
      flashed,
      querySelector<T extends Element = HTMLElement>(selector: string): T | null {
        const paraMatch = /\[data-para-index="(\d+)"\]/.exec(selector);
        if (paraMatch) {
          const idx = Number(paraMatch[1]);
          if (idx in paraOffsets) {
            return {
              dataset: { paraIndex: String(idx) },
              classList: {
                add: (c: string) => {
                  if (c === "toc-flash") flashed.push(idx);
                },
                remove: () => {},
              },
              scrollIntoView: () => {
                scroller.scrollTop = paraOffsets[idx]!;
              },
            } as unknown as T;
          }
        }
        return null;
      },
    };
    return scroller;
  }

  it("restores saved scrollRatio and jumps to paragraphs without resetting scrollTop to 0 on subsequent frames", () => {
    const scroller = makeMockScroller({ 0: 0, 5: 620, 12: 1480 });
    const pendingRef: { current: PendingScrollAction | null } = {
      current: { section: 2, kind: "ratio", ratio: 0.65 },
    };
    const settledSectionRef = { current: null as number | null };
    const lastVisibleParaRef = { current: 0 };
    const lastScrollTopRef = { current: 0 };
    let reportedRatio = 0;

    // Frame 1: consumes saved scrollRatio (0.65 * 2000 = 1300)
    applyPendingScrollAction({
      scroller,
      secIdx: 2,
      pendingRef,
      settledSectionRef,
      lastVisibleParaRef,
      lastScrollTopRef,
      onScrollRatio: (r) => {
        reportedRatio = r;
      },
    });
    expect(scroller.scrollTop).toBe(1300);
    expect(reportedRatio).toBe(0.65);
    expect(pendingRef.current).toBeNull();

    // Frame 2 (re-render after state/TOC hydration on same section): MUST NOT reset scrollTop to 0!
    applyPendingScrollAction({
      scroller,
      secIdx: 2,
      pendingRef,
      settledSectionRef,
      lastVisibleParaRef,
      lastScrollTopRef,
      onScrollRatio: (r) => {
        reportedRatio = r;
      },
    });
    expect(scroller.scrollTop).toBe(1300);
    expect(reportedRatio).toBe(0.65);

    // Search/bookmark jump to paragraph 12 in same section
    pendingRef.current = { section: 2, kind: "para", paraIndex: 12, flash: true };
    applyPendingScrollAction({
      scroller,
      secIdx: 2,
      pendingRef,
      settledSectionRef,
      lastVisibleParaRef,
      lastScrollTopRef,
      onScrollRatio: (r) => {
        reportedRatio = r;
      },
    });
    expect(scroller.scrollTop).toBe(1480);
    expect(scroller.flashed).toEqual([12]);
    expect(lastVisibleParaRef.current).toBe(12);

    // Next frame after jump: stays at 1480, never drops to 0!
    applyPendingScrollAction({
      scroller,
      secIdx: 2,
      pendingRef,
      settledSectionRef,
      lastVisibleParaRef,
      lastScrollTopRef,
      onScrollRatio: (r) => {
        reportedRatio = r;
      },
    });
    expect(scroller.scrollTop).toBe(1480);

    // Switching to section 3 without explicit jump resets cleanly to top = 0
    applyPendingScrollAction({
      scroller,
      secIdx: 3,
      pendingRef,
      settledSectionRef,
      lastVisibleParaRef,
      lastScrollTopRef,
      onScrollRatio: (r) => {
        reportedRatio = r;
      },
    });
    expect(scroller.scrollTop).toBe(0);
    expect(reportedRatio).toBe(0);
  });
});

describe("R41-T006: world_novel cross-route isolation (#3 & E16)", () => {
  it("isolates highlights, bookmarks, per-line reading progress, and ExcerptsSheet route resolution across branches", async () => {
    const base = sampleState();
    const { world, node: opening, line: lineA } = await repo.createWorld({
      title: "双线风云记",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "长安暮雪纷纷扬扬。", state: base },
    });

    // Main route A: 12 turns so it has multiple chapters
    let parentA = opening.id;
    let routeATargetNodeId = "";
    for (let i = 1; i <= 12; i++) {
      const n = await repo.appendNode(world.id, lineA.id, {
        parentId: parentA,
        kind: "turn",
        actionMode: "do",
        actionText: `主线行动${i}`,
        narrative: i === 2 ? "主线独有：裴十二递来玄铁令牌。" : `主线第${i}段风雪行路。`,
        state: { ...base, time: { ...base.time, elapsedMinutes: i * 60 } },
      });
      if (i === 2) routeATargetNodeId = n.id;
      parentA = n.id;
    }

    // Short branch B from opening: only 1 turn
    const lineB = await repo.createLine(world.id, opening.id, "东市支线", false);
    const nodeB1 = await repo.appendNode(world.id, lineB.id, {
      parentId: opening.id,
      kind: "turn",
      actionMode: "do",
      actionText: "转入东市",
      narrative: "支线独有：胡姬在酒肆弹奏琵琶，弦音清越。",
      state: { ...base, time: { ...base.time, elapsedMinutes: 45 } },
    });

    const novelA = (await buildNovelBook(repo, world.id, { lineId: lineA.id }))!;
    const novelB = (await buildNovelBook(repo, world.id, { lineId: lineB.id }))!;
    const routeIdsA = collectNovelRouteNodeIds(novelA);
    const routeIdsB = collectNovelRouteNodeIds(novelB);

    expect(routeIdsA.has(routeATargetNodeId)).toBe(true);
    expect(routeIdsB.has(routeATargetNodeId)).toBe(false);
    expect(routeIdsB.has(nodeB1.id)).toBe(true);

    // 1. Highlight on Route A MUST NOT mount on Route B or paint unrelated text by stale offsets
    const hlA = await addReaderHighlight(repo, {
      targetType: "world_novel",
      targetId: world.id,
      worldId: world.id,
      sectionIndex: 2,
      sectionTitle: novelA.sections[2]!.title,
      paragraphIndex: 1,
      charStart: 5,
      charEnd: 15,
      selectedText: "裴十二递来玄铁令牌",
      note: "甲线信物",
      color: "cinnabar",
      nodeId: routeATargetNodeId,
    });

    const secBChap = novelB.sections.find((s) => s.kind === "chapter")!;
    for (let idx = 0; idx < secBChap.paragraphs.length; idx++) {
      const matched = filterParagraphHighlights(
        [hlA],
        secBChap.paragraphs[idx]!,
        idx,
        secBChap.paragraphs,
        "world_novel",
      );
      expect(matched).toEqual([]);
    }
    // Even if passed directly to resolveHighlightSpans on different text, stale [5,15] must NOT match!
    expect(resolveHighlightSpans("支线独有：胡姬在酒肆弹奏琵琶，弦音清越。", [hlA])).toEqual([]);
    // Shifted offset within matching text still resolves accurately
    expect(resolveHighlightSpans("前文微调后，裴十二递来玄铁令牌，神情肃穆。", [hlA])[0]).toMatchObject({
      start: 6,
      end: 15,
    });

    // 2. Bookmarks on Route A must NOT show ribbon on Route B or get deleted from Route B
    const bmA = await addReaderBookmark(repo, {
      targetType: "world_novel",
      targetId: world.id,
      sectionIndex: secBChap.index,
      sectionTitle: novelA.sections[secBChap.index]!.title,
      snippet: "裴十二递来玄铁令牌",
      paragraphIndex: 1,
      nodeId: routeATargetNodeId,
    });
    const bmsForB = filterWorldNovelBookmarks([bmA], routeIdsB, novelB.sections);
    expect(bmsForB).toEqual([]);
    expect(findCurrentSectionBookmark(bmsForB, "world_novel", secBChap.index, secBChap)).toBeNull();

    const bmsForA = filterWorldNovelBookmarks([bmA], routeIdsA, novelA.sections);
    expect(bmsForA).toHaveLength(1);

    // 3. Per-route progress isolation: saving progress on Route A does NOT push short Route B to appendix,
    //    and reading Route B does NOT overwrite Route A's progress!
    expect(worldNovelProgressTargetId(world.id, lineA.id)).toBe(`${world.id}:${lineA.id}`);
    await saveWorldNovelProgress(repo, world.id, lineA.id, {
      sectionIndex: novelA.sections.length - 2,
      pageIndex: 2,
      scrollRatio: 0.75,
      anchorText: "主线第11段",
      nodeId: parentA,
    });
    // Also simulate a legacy unscoped progress pointing to Route A's deep node
    await saveReaderProgress(repo, {
      targetType: "world_novel",
      targetId: world.id,
      sectionIndex: novelA.sections.length - 2,
      pageIndex: 2,
      scrollRatio: 0.75,
      anchorText: "主线第11段",
      nodeId: parentA,
    });

    const progOnB = await getWorldNovelProgress(repo, world.id, lineB.id, {
      routeNodeIds: routeIdsB,
      sections: novelB.sections,
    });
    expect(progOnB).toBeNull();

    await saveWorldNovelProgress(repo, world.id, lineB.id, {
      sectionIndex: 1,
      pageIndex: 0,
      scrollRatio: 0.2,
      anchorText: "长安暮雪",
      nodeId: opening.id,
    });

    const progOnAAfter = await getWorldNovelProgress(repo, world.id, lineA.id, {
      routeNodeIds: routeIdsA,
      sections: novelA.sections,
    });
    expect(progOnAAfter?.sectionIndex).toBe(novelA.sections.length - 2);
    expect(progOnAAfter?.scrollRatio).toBe(0.75);

    // 4. ExcerptsSheet route target resolution: finds lineA even when world.currentLineId is lineB!
    await repo.setCurrentLine(world.id, lineB.id);
    const resolvedTarget = await resolveHighlightRouteTarget(repo, hlA);
    expect(resolvedTarget).toEqual({ lineId: lineA.id, nodeExists: true });

    const locatedInA = locateNovelNodeTarget(novelA, routeATargetNodeId, undefined, hlA.selectedText);
    expect(locatedInA).not.toBeNull();
    expect(
      novelA.sections[locatedInA!.sectionIndex]!.paragraphs[locatedInA!.paragraphIndex]!.text,
    ).toContain("裴十二递来玄铁令牌");

    // Deleted / non-existent node returns nodeExists: false instead of mis-jumping
    const missingTarget = await resolveHighlightRouteTarget(repo, {
      targetType: "world_novel",
      targetId: world.id,
      worldId: world.id,
      nodeId: "deleted-node-999",
    });
    expect(missingTarget).toEqual({ lineId: undefined, nodeExists: false });
    expect(locateNovelNodeTarget(novelB, routeATargetNodeId)).toBeNull();
  });
});

describe("R41-T006: ReaderAskSheet handoff & readerTts sleep/empty-section/jump fixes (E17)", () => {
  it("excludes incomplete/error turns from Companion handoff history and preserves unresolved question in draftQuestion", () => {
    // Case 1: First turn failed with error text -> asked is empty, draftQuestion preserves full prompt + original Q
    const failedTurns: AskTurn[] = [
      {
        q: "解释这段里的铜鹰符典故",
        a: "这次没有连上服务，请稍后再试。",
        pending: false,
        incomplete: true,
      },
    ];
    const handoff1 = buildReaderAskHandoff({
      bookTitle: "长安风雪",
      sectionIndex: 1,
      sectionTitle: "第二回",
      selectedText: "裴十二接过铜鹰符，神色骤然凝重。",
      turns: failedTurns,
      question: "",
    });
    expect(handoff1.asked).toEqual([]);
    expect(handoff1.draftQuestion).toContain("解释这段里的铜鹰符典故");
    expect(JSON.stringify(handoff1)).not.toContain("这次没有连上服务");

    // Case 2: Turn 1 succeeded, Turn 2 was stopped ("已停止。") -> asked has ONLY Turn 1, draftQuestion has Turn 2's Q
    const mixedTurns: AskTurn[] = [
      {
        q: "裴十二是什么身份？",
        a: "裴十二是长安不良人。",
        pending: false,
        incomplete: false,
      },
      {
        q: "铜鹰符代表哪一卫？",
        a: "已停止。",
        pending: false,
        incomplete: true,
      },
    ];
    const handoff2 = buildReaderAskHandoff({
      bookTitle: "长安风雪",
      sectionIndex: 1,
      sectionTitle: "第二回",
      selectedText: "裴十二接过铜鹰符，神色骤然凝重。",
      turns: mixedTurns,
      question: "",
    });
    expect(handoff2.asked).toHaveLength(1);
    expect(handoff2.asked[0]?.a).toBe("裴十二是长安不良人。");
    expect(handoff2.draftQuestion).toBe("铜鹰符代表哪一卫？");
  });

  it("resets sleepMode/sleepRemainingSec in stop(), skips empty/divider sections with loop cap, and honors external paragraph jumps", async () => {
    const spokenLog: { sec: number; idx: number; text: string }[] = [];
    const toasts: string[] = [];
    const listeners = new Map<string, Set<EventListener>>();

    const origWindow = (globalThis as Record<string, unknown>).window;
    const origDocument = (globalThis as Record<string, unknown>).document;
    const origIframe = (globalThis as Record<string, unknown>).HTMLIFrameElement;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

    const fakeWin = {
      HTMLIFrameElement: class FakeIframe {},
      addEventListener(type: string, fn: EventListener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener(type: string, fn: EventListener) {
        listeners.get(type)?.delete(fn);
      },
      dispatchEvent(ev: Event) {
        listeners.get(ev.type)?.forEach((fn) => fn(ev));
        return true;
      },
    };
    const fakeDoc = {
      nodeType: 9,
      defaultView: fakeWin,
      activeElement: null,
      documentElement: { namespaceURI: "http://www.w3.org/1999/xhtml" },
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: (tag: string) => ({
        nodeType: 1,
        nodeName: tag.toUpperCase(),
        tagName: tag.toUpperCase(),
        namespaceURI: "http://www.w3.org/1999/xhtml",
        style: {},
        appendChild: () => {},
        removeChild: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    };

    let latestUtteranceId = "";
    let curSec = 0;
    const chapters: { kind: string; text: string }[][] = [
      [{ kind: "prose", text: "第一章第一段。" }],
      [{ kind: "divider", text: "◇" }, { kind: "prose", text: "   " }], // Empty / pure divider chapter!
      [
        { kind: "prose", text: "第三章第零段。" },
        { kind: "prose", text: "第三章第一段。" },
        { kind: "prose", text: "第三章第二段目标。" },
      ],
    ];

    const ttsPlatform = {
      ...platform,
      name: "android" as const,
      system: {
        ...platform.system,
        ttsSpeak: vi.fn(async ({ utteranceId, text }: { utteranceId: string; text: string }) => {
          latestUtteranceId = utteranceId;
          spokenLog.push({ sec: curSec, idx: Number(utteranceId.split("-").at(-1)), text });
          return true;
        }),
        ttsStop: vi.fn(async () => {}),
      },
    };

    let ctrl!: ReaderTtsController;
    let root: ReturnType<typeof createRoot> | null = null;
    let hookProps: UseReaderTtsOptions = {
      platform: ttsPlatform,
      paragraphs: chapters[0]!,
      sectionIndex: 0,
      sectionReady: true,
      jumpTarget: null,
      onSectionEnd: () => {
        if (curSec < chapters.length - 1) {
          curSec += 1;
          rerender();
          return true;
        }
        return false;
      },
      toast: (m) => toasts.push(m),
    };

    function Harness(props: UseReaderTtsOptions) {
      ctrl = useReaderTts(props);
      return null;
    }

    const container = {
      nodeType: 1,
      nodeName: "DIV",
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: fakeDoc,
      appendChild: () => {},
      removeChild: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Element;

    const rerender = () => {
      hookProps = {
        ...hookProps,
        sectionIndex: curSec,
        paragraphs: chapters[curSec] ?? [],
      };
      root?.render(createElement(Harness, hookProps));
    };

    try {
      vi.useFakeTimers();
      (globalThis as Record<string, unknown>).window = fakeWin;
      (globalThis as Record<string, unknown>).document = fakeDoc;
      (globalThis as Record<string, unknown>).HTMLIFrameElement = class FakeIframe {};
      root = createRoot(container);

      await act(async () => {
        root!.render(createElement(Harness, hookProps));
      });

      // 1. Set 15-min sleep timer, verify countdown active, then stop() resets sleepMode="off" & sleepRemainingSec=0
      await act(async () => {
        ctrl.setSleepMode(15);
        ctrl.play(0);
      });
      expect(ctrl.sleepMode).toBe(15);
      expect(ctrl.sleepRemainingSec).toBe(900);
      expect(spokenLog.at(-1)).toEqual({ sec: 0, idx: 0, text: "第一章第一段。" });

      await act(async () => {
        ctrl.stop();
      });
      expect(ctrl.sleepMode).toBe("off");
      expect(ctrl.sleepRemainingSec).toBe(0);
      expect(ctrl.status).toBe("idle");

      // Advancing fake timers after stop() must NOT fire sleep timeout toast!
      await act(async () => {
        vi.advanceTimersByTime(20 * 60_000);
      });
      expect(toasts).not.toContain("定时时间到，已停止朗读");

      // 2. Continuous cross-chapter playback skips pure-divider Chapter 1 and lands on Chapter 2 Para 0
      spokenLog.length = 0;
      await act(async () => {
        ctrl.play(0);
      });
      expect(spokenLog).toEqual([{ sec: 0, idx: 0, text: "第一章第一段。" }]);

      await act(async () => {
        fakeWin.dispatchEvent(
          new CustomEvent("lishi:tts-event", {
            detail: { utteranceId: latestUtteranceId, state: "done" },
          }),
        );
      });
      expect(curSec).toBe(2);
      expect(spokenLog.at(-1)).toEqual({ sec: 2, idx: 0, text: "第三章第零段。" });

      // 3. External explicit jump during active playback continues from jumped paragraph (idx 2), NOT 0!
      await act(async () => {
        hookProps = {
          ...hookProps,
          jumpTarget: { nonce: 1, sectionIndex: 2, paragraphIndex: 2 },
        };
        root!.render(createElement(Harness, hookProps));
      });
      expect(ctrl.speakingIndex).toBe(2);
      expect(spokenLog.at(-1)).toEqual({ sec: 2, idx: 2, text: "第三章第二段目标。" });

      // Cross-chapter explicit jump (e.g. jumping to Chapter 2 Para 1 from Chapter 0 while playing)
      await act(async () => {
        curSec = 0;
        hookProps = {
          ...hookProps,
          sectionIndex: 0,
          paragraphs: chapters[0]!,
          jumpTarget: { nonce: 2, sectionIndex: 0, paragraphIndex: 0 },
        };
        root!.render(createElement(Harness, hookProps));
      });
      await act(async () => {
        curSec = 2;
        hookProps = {
          ...hookProps,
          sectionIndex: 2,
          paragraphs: chapters[2]!,
          jumpTarget: { nonce: 3, sectionIndex: 2, paragraphIndex: 1 },
        };
        root!.render(createElement(Harness, hookProps));
      });
      expect(ctrl.speakingIndex).toBe(1);
      expect(spokenLog.at(-1)).toEqual({ sec: 2, idx: 1, text: "第三章第一段。" });

      // 4. All-empty sections hit consecutive empty cap instead of infinite loop
      await act(async () => {
        ctrl.stop();
      });
      let infiniteAdvances = 0;
      curSec = 0;
      await act(async () => {
        hookProps = {
          ...hookProps,
          sectionIndex: 0,
          paragraphs: [{ kind: "divider", text: "◇" }],
          onSectionEnd: () => {
            infiniteAdvances += 1;
            curSec += 1;
            hookProps = {
              ...hookProps,
              sectionIndex: curSec,
              paragraphs: [{ kind: "divider", text: "◇" }],
            };
            root!.render(createElement(Harness, hookProps));
            return true;
          },
        };
        root!.render(createElement(Harness, hookProps));
      });
      await act(async () => {
        ctrl.play(0);
      });
      expect(infiniteAdvances).toBeLessThanOrEqual(13);
      expect(ctrl.status).toBe("idle");
    } finally {
      try {
        if (root) {
          await act(async () => {
            root!.unmount();
          });
        }
      } finally {
        vi.useRealTimers();
        (globalThis as Record<string, unknown>).window = origWindow;
        (globalThis as Record<string, unknown>).document = origDocument;
        (globalThis as Record<string, unknown>).HTMLIFrameElement = origIframe;
      }
    }
  });
});

describe("R41-T006: Lossless EPUB parsing & round-trip deduplication (E18)", () => {
  it("normalizes relative/encoded ZIP paths while rejecting root-escaping '..'", () => {
    expect(normalizeArchivePath("/OEBPS/./Toc/../Text/ch1.xhtml")).toBe("OEBPS/Text/ch1.xhtml");
    expect(() => normalizeArchivePath("OEBPS/../../secret.xml")).toThrow(/越界/);
    expect(
      decodeHtmlEntities("&emsp;李白&middot;字太白&ldquo;行路难&rdquo;&mdash;&hellip;&#20013;&#x6587;&amp;lt;"),
    ).toBe("\u3000李白·字太白“行路难”—…中文&lt;");
  });

  it("retains pre-anchor Chapter 1, preserves inline tag spaces, decodes entities, reads attributed NCX <text>, skips large binary assets, and auto-splits >24k single-section EPUBs", async () => {
    // 30 MiB fake font binary entry (would blow past 24 MiB per-entry cap if not filtered out!)
    const hugeFontBytes = new Uint8Array(26 * 1024 * 1024);
    const epubBytes = zipSync({
      "META-INF/container.xml": strToU8(
        '<container><rootfiles><rootfile full-path="/OEBPS/./sub/../content.opf"/></rootfiles></container>',
      ),
      "OEBPS/Fonts/NotoSerif.ttf": [hugeFontBytes, { level: 0 }],
      "OEBPS/content.opf": strToU8(
        `<package version="2.0">
          <metadata><dc:title xmlns:dc="dc">盛唐&middot;诗卷</dc:title></metadata>
          <manifest>
            <item id="ncx" href="Toc/toc.ncx" media-type="application/x-dtbncx+xml"/>
            <item id="p1" href="Text/Part%201.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine toc="ncx"><itemref idref="p1"/></spine>
        </package>`,
      ),
      "OEBPS/Toc/toc.ncx": strToU8(
        `<ncx><navMap>
          <navPoint id="n1"><navLabel><text xml:lang="zh-CN">第一章 开端</text></navLabel><content src="../Text/Part%201.xhtml"/></navPoint>
          <navPoint id="n2"><navLabel><text id="lbl2">第二章 转折</text></navLabel><content src="../Text/Part%201.xhtml#sec2"/></navPoint>
          <navPoint id="n3"><navLabel><text>第三章 远行</text></navLabel><content src="../Text/Part%201.xhtml#sec3"/></navPoint>
        </navMap></ncx>`,
      ),
      // Note literal percent-encoded key fallback: `OEBPS/Text/Part%201.xhtml`
      "OEBPS/Text/Part%201.xhtml": strToU8(
        `<html><body>
          <h1>第一章 开端</h1>
          <p>&emsp;&emsp;Hello <em>world</em> and <span>friends</span> in &ldquo;Chang&rsquo;an&rdquo;&mdash;year &#55;&#x34;8&hellip;</p>
          <h2 id="sec2">第二章 转折</h2>
          <p>李白&middot;字太白，举杯邀明月。</p>
          <h2 id="sec3">第三章 远行</h2>
          <p>孤帆远影碧空尽。</p>
        </body></html>`,
      ),
    });

    const parsed = await parseBook({ name: "multi-anchor.epub", bytes: epubBytes }, platform);
    expect(parsed.title).toBe("盛唐·诗卷");
    expect(parsed.sections.map((s) => s.title)).toEqual([
      "第一章 开端",
      "第二章 转折",
      "第三章 远行",
    ]);
    expect(parsed.sections[0]!.text).toContain("\u3000\u3000Hello world and friends in “Chang’an”—year 748…");
    expect(parsed.sections[0]!.text).not.toMatch(/^第一章 开端/);
    expect(parsed.sections[1]!.text).toBe("李白·字太白，举杯邀明月。");
    expect(parsed.sections[2]!.text).toBe("孤帆远影碧空尽。");

    // Single-section >24k char unindexed EPUB auto-splits into manageable natural-paragraph sections
    const longBody = Array.from(
      { length: 1050 },
      (_, i) => `<p>第${i + 1}自然段：长安朱雀大街车水马龙，晨钟暮鼓声传四野，灯火彻夜不息。</p>`,
    ).join("\n");
    const longSingleEpub = zipSync({
      "META-INF/container.xml": strToU8(
        '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      ),
      "OEBPS/content.opf": strToU8(
        '<package><metadata><dc:title xmlns:dc="dc">无目录长卷</dc:title></metadata><manifest><item id="c1" href="c1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>',
      ),
      "OEBPS/c1.xhtml": strToU8(`<html><body>${longBody}</body></html>`),
    });
    const splitLong = await parseBook({ name: "long.epub", bytes: longSingleEpub }, platform);
    expect(splitLong.sections.length).toBeGreaterThanOrEqual(3);
  });

  it("deduplicates chapter title & subtitle on app-exported EPUB re-import and classifies ◇ dividers & colophon for centered display", async () => {
    const base = sampleState();
    const { world, node: opening, line } = await repo.createWorld({
      title: "剑阁夜雨录",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "剑阁细雨湿青苔。", state: base },
    });
    const t1 = await repo.appendNode(world.id, line.id, {
      parentId: opening.id,
      kind: "turn",
      actionMode: "do",
      actionText: "投宿山驿",
      narrative: "山驿灯火昏黄，掌柜添了一块松柴。",
      state: { ...base, time: { ...base.time, elapsedMinutes: 60 } },
    });
    await repo.appendNode(world.id, line.id, {
      parentId: t1.id,
      kind: "fastforward",
      actionMode: "skip",
      actionText: "盘桓三日",
      narrative: "三日后雨歇云开，蜀道栈桥重现。",
      record: { time: 3 * 1440 },
      state: { ...base, time: { ...base.time, elapsedMinutes: 60 + 3 * 1440 } },
    });

    const novel = (await buildNovelBook(repo, world.id))!;
    const epubBytes = buildEpubBytes(novel);
    const reimported = await parseBook({ name: "剑阁夜雨录.epub", bytes: epubBytes }, platform);
    await saveBook(repo, reimported);

    // Wedge ("楔子") and Chapter 1 ("第一回 · ...") must NOT repeat section title or subtitle in paragraph 0!
    const prologueIdx = reimported.sections.findIndex((s) => s.title === "楔子");
    const chap1Idx = reimported.sections.findIndex((s) => s.title.startsWith("第一回"));
    expect(prologueIdx).toBeGreaterThanOrEqual(0);
    expect(chap1Idx).toBeGreaterThanOrEqual(0);

    const prologueSec = (await readBookSection(repo, reimported.id, prologueIdx))!;
    expect(prologueSec.paragraphs[0]).toBe("剑阁细雨湿青苔。");

    const chap1Sec = (await readBookSection(repo, reimported.id, chap1Idx))!;
    expect(chap1Sec.paragraphs[0]).toBe("山驿灯火昏黄，掌柜添了一块松柴。");
    expect(chap1Sec.paragraphs.some((p) => p.startsWith("第一回"))).toBe(false);

    // ◇ divider and statusLine colophon classify into centered ornament & colophon!
    const classified = chap1Sec.paragraphs.map(classifyBookParagraph);
    expect(classified.some((p) => p.kind === "divider")).toBe(true);
    expect(classified.some((p) => p.isColophon === true && p.text === "—— 未完待续 ——")).toBe(true);
    expect(classifyBookParagraph("◇")).toEqual({ kind: "divider", text: "◇" });
  });
});

describe("R42-T004: Copy-on-write fork polish, preface/appendix isolation, stale book notes & handoff", () => {
  it("disambiguates forked resplit titles, moves pinned flag off old edition, and detaches world-novel origin on in-place resplit", async () => {
    const raw = [
      "【001】暮鼓初响\n长安西市灯火渐次点亮。",
      "【002】夜渡渭水\n扁舟穿过寒雾直抵北岸。",
    ].join("\n\n");
    await saveBook(repo, {
      id: "fork-src",
      title: "渭水夜航录",
      format: "txt",
      createdAt: "2026-11-28T00:00:00.000Z",
      sections: [{ title: "正文", text: raw }],
    });
    await updateBookShelfPref(repo, "fork-src", {
      author: "关中客",
      coverTone: 4,
      pinned: true,
    });

    const st = sampleState();
    st.source = newBinding("fork-src", false);
    await repo.createWorld({
      title: "渭水同人",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "渭水秋风急。", state: st },
    });

    const fork1 = await applyBookResplit(repo, "fork-src", { preset: "numbered" });
    expect(fork1.forked).toBe(true);
    expect(fork1.title).toBe("渭水夜航录（重分章）");
    expect((await getBook(repo, fork1.bookId))?.title).toBe("渭水夜航录（重分章）");

    // Pinned flag moved from old referenced edition to newly forked copy (no duplicate pinned cards!)
    let prefs = await getAllBookShelfPrefs(repo);
    expect(prefs["fork-src"]?.pinned).toBe(false);
    expect(prefs[fork1.bookId]?.pinned).toBe(true);

    // Forking a second time (or forking the already-suffixed copy once referenced) increments to （重分章 2）
    const fork2 = await applyBookResplit(repo, "fork-src", { preset: "numbered" });
    expect(fork2.forked).toBe(true);
    expect(fork2.title).toBe("渭水夜航录（重分章 2）");

    // Unreferenced world-novel TXT book resplit in-place detaches world-novel origin so later re-compile won't overwrite it!
    const base = sampleState();
    const { world } = await repo.createWorld({
      title: "朔方烽燧记",
      eraId: "tang-748",
      opening: {
        parentId: null,
        kind: "opening",
        narrative: "第1节 烽火初起\n\n塞上秋风猎猎。\n\n第2节 铁骑出关\n\n鼓角声震四野。",
        state: base,
      },
    });
    const compiled1 = await saveWorldNovelToLibrary(repo, world.id);
    const resplitCustom = await applyBookResplit(repo, compiled1.bookId, {
      preset: "custom",
      customPattern: "^第\\d+节.*",
    });
    expect(resplitCustom.forked).toBe(false);
    expect(resplitCustom.bookId).toBe(compiled1.bookId);

    prefs = await getAllBookShelfPrefs(repo);
    expect(prefs[compiled1.bookId]?.origin).toBe("imported");
    expect(prefs[compiled1.bookId]?.sourceWorldId).toBeUndefined();

    // Re-compiling the world allocates a fresh book instead of overwriting the user's custom split!
    const compiled2 = await saveWorldNovelToLibrary(repo, world.id);
    expect(compiled2.bookId).not.toBe(compiled1.bookId);
    expect(compiled2.title).toBe("朔方烽燧记（新编）");
    const customStillIntact = await getBook(repo, compiled1.bookId);
    expect(customStillIntact?.sections.length).toBe(resplitCustom.sectionCount);
  });

  it("clones & re-anchors bookmarks/highlights/progress, moves pinned, and disambiguates title when saveWorldNovelToLibrary forks", async () => {
    const base = sampleState();
    const { world, node: opening, line: mainLine } = await repo.createWorld({
      title: "汴梁风物志",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "州桥明月夜，汴水波光如练。", state: base },
    });
    const turn1 = await repo.appendNode(world.id, mainLine.id, {
      parentId: opening.id,
      kind: "turn",
      actionMode: "do",
      actionText: "步入夜市",
      narrative: "马行街茶坊灯烛荧煌，琵琶声隔帘传来。",
      state: { ...base, time: { ...base.time, elapsedMinutes: 60 } },
    });

    const v1 = await saveWorldNovelToLibrary(repo, world.id, { lineId: mainLine.id });
    expect(v1.forked).toBe(false);
    expect(v1.title).toBe("汴梁风物志");

    await updateBookShelfPref(repo, v1.bookId, { pinned: true, coverTone: 6 });

    const v1Book = (await getBook(repo, v1.bookId))!;
    const chapIdx = v1Book.sections.findIndex((s) => s.text.includes("马行街茶坊灯烛荧煌"));
    expect(chapIdx).toBeGreaterThanOrEqual(0);

    await addReaderBookmark(repo, {
      targetType: "book",
      targetId: v1.bookId,
      sectionIndex: chapIdx,
      sectionTitle: v1Book.sections[chapIdx]!.title,
      snippet: "马行街茶坊灯烛荧煌",
      paragraphIndex: 0,
      nodeId: null,
    });
    await addReaderHighlight(repo, {
      targetType: "book",
      targetId: v1.bookId,
      worldId: null,
      sectionIndex: chapIdx,
      sectionTitle: v1Book.sections[chapIdx]!.title,
      paragraphIndex: 0,
      charStart: 0,
      charEnd: 9,
      selectedText: "马行街茶坊灯烛荧煌",
      note: "夜市繁华",
      color: "cinnabar",
      nodeId: null,
    });
    await addReaderHighlight(repo, {
      targetType: "book",
      targetId: v1.bookId,
      worldId: null,
      sectionIndex: 1,
      sectionTitle: v1Book.sections[1]!.title,
      paragraphIndex: 0,
      charStart: 0,
      charEnd: 5,
      selectedText: "州桥明月夜",
      note: "旧开篇批注",
      color: "amber",
      nodeId: null,
    });
    await saveReaderProgress(repo, {
      targetType: "book",
      targetId: v1.bookId,
      sectionIndex: chapIdx,
      pageIndex: 1,
      scrollRatio: 0.4,
      anchorText: "马行街茶坊灯烛荧煌",
      nodeId: null,
    });

    // Cite v1 in a sequel world so v1 becomes copy-on-write protected
    const sequelState = sampleState();
    sequelState.source = newBinding(v1.bookId, false);
    await repo.createWorld({
      title: "汴梁续集",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "旧事重提。", state: sequelState },
    });

    // Rewrite opening text and append more turns on mainLine, then re-compile -> forks v2!
    await repo.updateNarrative(opening.id, "虹桥晓雾散尽，漕船千帆竞发。");
    await repo.appendNode(world.id, mainLine.id, {
      parentId: turn1.id,
      kind: "turn",
      actionMode: "do",
      actionText: "登楼凭栏",
      narrative: "樊楼高处俯瞰全城烟火。",
      state: { ...base, time: { ...base.time, elapsedMinutes: 120 } },
    });

    const v2 = await saveWorldNovelToLibrary(repo, world.id, { lineId: mainLine.id });
    expect(v2.forked).toBe(true);
    expect(v2.bookId).not.toBe(v1.bookId);
    expect(v2.title).toBe("汴梁风物志（新编）");

    // Pinned moved from v1 -> v2, coverTone inherited!
    const prefs = await getAllBookShelfPrefs(repo);
    expect(prefs[v1.bookId]?.pinned).toBe(false);
    expect(prefs[v2.bookId]?.pinned).toBe(true);
    expect(prefs[v2.bookId]?.coverTone).toBe(6);

    // Bookmarks, highlights, and progress cloned & re-anchored onto v2!
    const v2Bms = await listReaderBookmarks(repo, "book", v2.bookId);
    expect(v2Bms).toHaveLength(1);
    expect(v2Bms[0]?.snippet).toBe("马行街茶坊灯烛荧煌");

    const v2Hls = await listReaderHighlights(repo, { targetType: "book", targetId: v2.bookId });
    expect(v2Hls).toHaveLength(2);
    const kept = v2Hls.find((h) => h.note === "夜市繁华")!;
    const rewritten = v2Hls.find((h) => h.note === "旧开篇批注")!;
    expect(kept.charEnd).toBeGreaterThan(kept.charStart);
    expect(rewritten.charStart).toBe(0);
    expect(rewritten.charEnd).toBe(0);

    // Fix A: orphan `book` highlight whose text was rewritten MUST NOT match unrelated paragraph 0!
    const rewrittenPara = { kind: "prose" as const, text: "虹桥晓雾散尽，漕船千帆竞发。" };
    expect(filterParagraphHighlights([rewritten], rewrittenPara, 0, [rewrittenPara], "book")).toEqual([]);
    const matchingPara = { kind: "prose" as const, text: "马行街茶坊灯烛荧煌，琵琶声隔帘传来。" };
    expect(filterParagraphHighlights([kept], matchingPara, 0, [matchingPara], "book")).toHaveLength(1);

    const v2Prog = await getReaderProgress(repo, "book", v2.bookId);
    expect(v2Prog?.sectionIndex).toBe(kept.sectionIndex);

    // Citing v2 and re-compiling again increments title to （新编 2）!
    const sequelState2 = sampleState();
    sequelState2.source = newBinding(v2.bookId, false);
    await repo.createWorld({
      title: "汴梁三编引用",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "再续前缘。", state: sequelState2 },
    });
    const v3 = await saveWorldNovelToLibrary(repo, world.id, { lineId: mainLine.id });
    expect(v3.forked).toBe(true);
    expect(v3.title).toBe("汴梁风物志（新编 2）");
  });

  it("isolates world_novel preface/appendix line:${lineId} & legacy null-nodeId bookmarks/highlights across branches and relocates shifted sections", async () => {
    const base = sampleState();
    const { world, node: opening, line: lineA } = await repo.createWorld({
      title: "陇右双线传",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "陇山积雪初融。", state: base },
    });

    // Branch A has exclusive cast member & historical deviation in preface/appendix
    const stateA = {
      ...base,
      time: { ...base.time, elapsedMinutes: 60 },
      people: [
        ...base.people,
        {
          id: "p-exclusive-a",
          name: "哥舒翰",
          aliases: [],
          role: "陇右节度副使",
          attitude: "亲近" as const,
          notes: "镇守临洮要塞。",
          alive: true,
          lastSeenMinute: 60,
        },
      ],
      deviations: ["主线独有变迁：提前收复石堡城"],
    };
    let tailA = await repo.appendNode(world.id, lineA.id, {
      parentId: opening.id,
      kind: "turn",
      actionMode: "do",
      actionText: "拜谒军帐",
      narrative: "主线军帐议事，旌旗蔽空。",
      state: stateA,
    });

    // Branch B diverges from opening without Branch A's cast/deviation
    const lineB = await repo.createLine(world.id, opening.id, "河西支线", false);
    await repo.appendNode(world.id, lineB.id, {
      parentId: opening.id,
      kind: "turn",
      actionMode: "do",
      actionText: "西出阳关",
      narrative: "支线驼铃悠扬，大漠孤烟直。",
      state: { ...base, time: { ...base.time, elapsedMinutes: 90 } },
    });

    const novelA1 = (await buildNovelBook(repo, world.id, { lineId: lineA.id }))!;
    const novelB = (await buildNovelBook(repo, world.id, { lineId: lineB.id }))!;
    const routeIdsA1 = collectNovelRouteNodeIds(novelA1);
    const routeIdsB = collectNovelRouteNodeIds(novelB);

    const prefaceA = novelA1.sections.find((s) => s.kind === "preface")!;
    const appendixA1 = novelA1.sections.find((s) => s.kind === "appendix")!;
    const prefaceB = novelB.sections.find((s) => s.kind === "preface")!;
    const appendixB = novelB.sections.find((s) => s.kind === "appendix")!;

    // 1. Tagging helper produces `line:${lineId}` ONLY when targetType === "world_novel" & para.nodeId == null
    expect(encodeWorldNovelAnnotationNodeId("world_novel", null, lineA.id)).toBe(`line:${lineA.id}`);
    expect(encodeWorldNovelAnnotationNodeId("world_novel", tailA.id, lineA.id)).toBe(tailA.id);
    expect(encodeWorldNovelAnnotationNodeId("book", null, lineA.id)).toBeNull();

    // Create a `line:${lineA.id}` bookmark & highlight on Preface (shared text "开局纪事" / protagonist bio)
    // AND a legacy `nodeId: null` bookmark & highlight on Appendix ("提前收复石堡城")
    const bmPrefaceTagged = await addReaderBookmark(repo, {
      targetType: "world_novel",
      targetId: world.id,
      sectionIndex: prefaceA.index,
      sectionTitle: prefaceA.title,
      snippet: prefaceA.paragraphs[0]!.text.slice(0, 24),
      paragraphIndex: 0,
      nodeId: `line:${lineA.id}`,
    });
    const bmAppendixLegacy = await addReaderBookmark(repo, {
      targetType: "world_novel",
      targetId: world.id,
      sectionIndex: appendixA1.index,
      sectionTitle: appendixA1.title,
      snippet: "提前收复石堡城",
      paragraphIndex: appendixA1.paragraphs.length - 1,
      nodeId: null,
    });

    const hlPrefaceTagged = await addReaderHighlight(repo, {
      targetType: "world_novel",
      targetId: world.id,
      worldId: world.id,
      sectionIndex: prefaceA.index,
      sectionTitle: prefaceA.title,
      paragraphIndex: 0,
      charStart: 0,
      charEnd: 6,
      selectedText: prefaceA.paragraphs[0]!.text.slice(0, 6),
      note: "主线卷首批注",
      color: "cinnabar",
      nodeId: `line:${lineA.id}`,
    });
    const hlAppendixLegacy = await addReaderHighlight(repo, {
      targetType: "world_novel",
      targetId: world.id,
      worldId: world.id,
      sectionIndex: appendixA1.index,
      sectionTitle: appendixA1.title,
      paragraphIndex: appendixA1.paragraphs.length - 1,
      charStart: 0,
      charEnd: 7,
      selectedText: "提前收复石堡城",
      note: "旧版附录批注",
      color: "bamboo",
      nodeId: null,
    });

    const allBms = [bmPrefaceTagged, bmAppendixLegacy];
    const allHls = [hlPrefaceTagged, hlAppendixLegacy];

    // On Branch B: NEITHER `line:${lineA.id}` NOR legacy `null` Branch-A-only snippet may leak!
    expect(filterWorldNovelBookmarks(allBms, routeIdsB, novelB.sections, lineB.id)).toEqual([]);
    expect(findCurrentSectionBookmark(allBms, "world_novel", prefaceB.index, prefaceB, lineB.id)).toBeNull();
    expect(findCurrentSectionBookmark(allBms, "world_novel", appendixB.index, appendixB, lineB.id)).toBeNull();
    expect(filterWorldNovelHighlights(allHls, routeIdsB, novelB.sections, lineB.id)).toEqual([]);
    expect(
      filterParagraphHighlights(allHls, prefaceB.paragraphs[0]!, 0, prefaceB.paragraphs, "world_novel", lineB.id),
    ).toEqual([]);

    // ExcerptsSheet route filter matches ReaderScreen visibleHighlights count on both branches!
    const sheetHlsOnB = await filterExcerptsForWorldRoute(repo, allHls, world.id, {
      lineId: lineB.id,
      routeNodeIds: routeIdsB,
    });
    expect(sheetHlsOnB).toEqual([]);
    const sheetHlsOnA = await filterExcerptsForWorldRoute(repo, allHls, world.id, {
      lineId: lineA.id,
      routeNodeIds: routeIdsA1,
    });
    expect(sheetHlsOnA).toHaveLength(2);

    // On Branch A: append 12 more turns so chapter count grows and Appendix `sectionIndex` shifts!
    for (let i = 1; i <= 12; i++) {
      tailA = await repo.appendNode(world.id, lineA.id, {
        parentId: tailA.id,
        kind: "turn",
        actionMode: "do",
        actionText: `行军第${i}程`,
        narrative: `第${i}程军报频传，烽火连天。`,
        state: { ...stateA, time: { ...stateA.time, elapsedMinutes: 60 + i * 60 } },
      });
    }
    const novelA2 = (await buildNovelBook(repo, world.id, { lineId: lineA.id }))!;
    const routeIdsA2 = collectNovelRouteNodeIds(novelA2);
    const appendixA2 = novelA2.sections.find((s) => s.kind === "appendix")!;
    expect(appendixA2.index).toBeGreaterThan(appendixA1.index);

    // Shifted Appendix bookmark & highlight still match on Branch A and relocate cleanly by `sectionTitle`!
    expect(filterWorldNovelBookmarks(allBms, routeIdsA2, novelA2.sections, lineA.id)).toHaveLength(2);
    expect(filterWorldNovelHighlights(allHls, routeIdsA2, novelA2.sections, lineA.id)).toHaveLength(2);
    expect(
      findCurrentSectionBookmark(allBms, "world_novel", appendixA2.index, appendixA2, lineA.id)?.id,
    ).toBe(bmAppendixLegacy.id);

    const tocA2 = novelA2.sections.map((s) => ({ title: s.title }));
    const jumpLegacy = resolveWorldNovelBookmarkJump(novelA2, tocA2, bmAppendixLegacy);
    expect(jumpLegacy.sectionIndex).toBe(appendixA2.index);
    expect(novelA2.sections[jumpLegacy.sectionIndex]!.paragraphs[jumpLegacy.paragraphIndex]!.text).toContain(
      "提前收复石堡城",
    );

    const bmAppendixTagged = { ...bmAppendixLegacy, nodeId: `line:${lineA.id}` };
    const jumpTagged = resolveWorldNovelBookmarkJump(novelA2, tocA2, bmAppendixTagged);
    expect(jumpTagged.sectionIndex).toBe(appendixA2.index);
  });

  it("ignores superseded failed turns in buildReaderAskHandoff when a subsequent turn succeeded", () => {
    const turns: AskTurn[] = [
      {
        q: "早期连接失败的问题",
        a: "连接中断，请重试。",
        pending: false,
        incomplete: true,
      },
      {
        q: "后续成功回答的问题",
        a: "这段典出《汉书·西域传》。",
        pending: false,
        incomplete: false,
      },
    ];
    const handoff = buildReaderAskHandoff({
      bookTitle: "陇右行",
      sectionIndex: 0,
      sectionTitle: "第一回",
      selectedText: "阳关大道尘土飞扬。",
      turns,
      question: "",
    });
    expect(handoff.asked).toHaveLength(1);
    expect(handoff.asked[0]?.a).toBe("这段典出《汉书·西域传》。");
    // Must NOT resurrect "早期连接失败的问题" into draftQuestion after a later turn succeeded!
    expect(handoff.draftQuestion).toBe("");
  });
});
