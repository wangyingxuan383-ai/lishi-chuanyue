import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import type { Platform, StreamEvent, StreamRequest } from "../platform";
import { migrate } from "./db/migrate";
import { Repo } from "./db/repo";
import { exportWorld } from "./archive";
import {
  ChatError,
  isMaxCompletionTokensParamError,
  isMaxTokensError,
  retryDecision,
  streamChat,
  stripInlineThink,
} from "./llm/chat";
import { chatCompletionsUrl as providerChatUrl } from "./llm/providers";
import { completeJson, lenientJson, parseRecord } from "./record/parse";
import { parsePlayerRevision } from "./writing/assist";
import { textSections } from "./sources/parse";
import { deleteBook, getBook, saveBook, searchBookFullText } from "./sources/library";
import { applyBookResplit, reconstructBookText } from "./sources/resplit";
import { addReaderBookmark, addReaderHighlight, ensureReaderSchema, saveReaderProgress } from "./reader/store";
import { sampleState } from "./testing/fixtures";
import { newBinding } from "./sources/types";
import { normalizeOpeningDraft, EMPTY } from "../ui/screens/openingDraft";

let platform: Platform;
let repo: Repo;

beforeEach(async () => {
  platform = await createMemoryPlatform();
  await migrate(platform);
  repo = new Repo(platform);
});

function fakeStreamPlatform(events: StreamEvent[]): Platform {
  return {
    llm: {
      async stream(_req: StreamRequest, onEvent: (e: StreamEvent) => void) {
        queueMicrotask(() => events.forEach(onEvent));
        return "s-think";
      },
      cancel: async () => {},
    },
  } as unknown as Platform;
}

describe("R38 full-stack deep audit regression suite", () => {
  it("strips fragmented inline <think> blocks during streaming without flashing <th or letting inner <record> corrupt prose", async () => {
    const seenDeltas: string[] = [];
    const seenFull: string[] = [];
    let thinkingCalls = 0;

    const sse = (content: string): StreamEvent => ({
      type: "data",
      data: JSON.stringify({ choices: [{ delta: { content } }] }),
    });

    const handle = streamChat(
      fakeStreamPlatform([
        { type: "open", status: 200 },
        sse("<"),
        sse("th"),
        sse("ink>先思考一下，这里提到 <record>{\"place\":\"错误陷阱\"}</record> 和 {broken json"),
        sse("</th"),
        sse("ink>\n\n高台之上寒风猎猎，你稳住呼吸。"),
        sse("<record>{\"place\":\"外院大广场\",\"choices\":[\"示意退场\",\"稳住心脉\"]}</record>"),
        { type: "done" },
      ]),
      { slot: "main", url: "https://x/v1/chat/completions", model: "m", messages: [] },
      {
        onThinking: () => {
          thinkingCalls += 1;
        },
        onText: (delta, full) => {
          seenDeltas.push(delta);
          seenFull.push(full);
        },
      },
    );

    const res = await handle.result;
    expect(thinkingCalls).toBe(1);
    expect(seenFull.some((s) => s.includes("<th") || s.includes("错误陷阱"))).toBe(false);
    expect(res.text).toBe(
      "高台之上寒风猎猎，你稳住呼吸。<record>{\"place\":\"外院大广场\",\"choices\":[\"示意退场\",\"稳住心脉\"]}</record>",
    );

    const stripped = stripInlineThink("<THINK >推理草稿</think >正文段落<think>未闭合尾巴");
    expect(stripped.visible).toBe("正文段落");
    expect(stripped.thinking).toContain("推理草稿");
    expect(stripped.thinking).toContain("未闭合尾巴");
  });

  it("ignores braces and <record> inside <think> when decoding JSON and turn records", () => {
    const raw = `<think>如果返回 {"place":"假地点", broken } 会怎样？</think><record>{"place":"史莱克内院","time":"一刻","choices":["上前应战","静观其变"]}</record>`;
    const parsed = parseRecord(raw);
    expect(parsed.record?.place).toBe("史莱克内院");
    expect(parsed.record?.choices).toEqual(["上前应战", "静观其变"]);

    expect(completeJson(`<think>{"bad": </think>{"unchanged":true,"note":"无变化"}`)).toEqual({
      unchanged: true,
      note: "无变化",
    });
    expect(lenientJson(`<think>未闭合思考 {"a":1`)).toBeNull();
  });

  it("distinguishes reducible max_tokens errors from Anthropic budget_tokens and OpenAI max_completion_tokens errors", () => {
    const anthropicBudgetErr = new ChatError(
      "http",
      400,
      "",
      "max_tokens: 4096 must be greater than thinking.budget_tokens (8000)",
    );
    expect(isMaxTokensError(anthropicBudgetErr)).toBe(false);

    const openAiParamErr = new ChatError(
      "http",
      400,
      "",
      "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    );
    expect(isMaxCompletionTokensParamError(openAiParamErr)).toBe(true);
    expect(isMaxTokensError(openAiParamErr)).toBe(false);

    const smallCapErr = new ChatError("http", 400, "", "max_tokens: 8192 exceeds model maximum output 2048");
    expect(isMaxTokensError(smallCapErr)).toBe(true);
    expect(retryDecision(smallCapErr, 1, [], 8192).maxTokens).toBe(4096);
    expect(retryDecision(smallCapErr, 2, [], 4096).maxTokens).toBe(2048);
    expect(retryDecision(smallCapErr, 3, [], 2048).maxTokens).toBe(1024);
    expect(retryDecision(smallCapErr, 4, [], 1024).retry).toBe(false);
  });

  it("normalizes bare Google Gemini base URLs to OpenAI-compatible /v1beta/openai endpoints", () => {
    expect(providerChatUrl("https://generativelanguage.googleapis.com")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(providerChatUrl("https://generativelanguage.googleapis.com/v1beta/")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });

  it("auto-sections unsplit >24k TXT books into synthetic sections and preserves lossless resplit & slim storage", async () => {
    const para = "青石广场上晨雾未散，少年握紧木剑凝神静气，远处钟声悠悠回荡在群山之间。";
    const bigRaw = Array.from({ length: 820 }, (_, i) => `【段${i + 1}】${para}`).join("\n\n");
    expect(bigRaw.length).toBeGreaterThan(28_000);

    const sections = await textSections(bigRaw);
    expect(sections.length).toBeGreaterThanOrEqual(4);
    expect(sections[0]!.title).toBe("第 1 节");
    expect(sections[1]!.title).toBe("第 2 节");

    await saveBook(repo, {
      id: "unsplit-novel",
      title: "无章题长卷",
      format: "txt",
      createdAt: "2026-11-24T00:00:00.000Z",
      sections,
    });

    // Slim source_books.json should only store section metadata, not duplicate 30 KB of text
    const [rawRow] = await platform.sql.query(
      "SELECT LENGTH(json) AS len FROM source_books WHERE id = ?",
      ["unsplit-novel"],
    );
    expect(Number(rawRow?.len ?? 0)).toBeLessThan(1_000);

    // getBook reconstructs exact text seamlessly across 2,400-char chunk boundaries
    const loaded = await getBook(repo, "unsplit-novel");
    expect(loaded).not.toBeNull();
    expect(reconstructBookText(loaded!)).toBe(bigRaw);

    // World archive export also embeds full reconstructed book text
    const st = sampleState();
    st.source = newBinding("unsplit-novel", true);
    const created = await repo.createWorld({
      title: "长卷同人测试",
      eraId: "free",
      settings: { mode: "free", clockStyle: "elapsed" },
      opening: { parentId: null, kind: "opening", narrative: "开卷。", state: st },
    });
    const archived = await exportWorld(repo, created.world.id);
    const exportedBooks = archived.books ?? [];
    expect(exportedBooks.length).toBe(1);
    expect(reconstructBookText(exportedBooks[0]!.book)).toBe(bigRaw);
  });

  it("supports multi-phrase/chunk-seam full-text search with exact paragraph offsets and cleans reader annotations on deleteBook", async () => {
    const filler = "长街灯火通明，行人摩肩接踵，茶肆酒旗在夜风中猎猎作响。".repeat(95); // > 2,400 chars (chunk 0)
    const ch1Text = `${filler}\n\n第二大段承接前文。\n\n霍雨浩亮出第3魂技与10万年冰碧帝皇蝎魂环，全场哗然。`;
    await saveBook(repo, {
      id: "search-book",
      title: "搜索与清理卷",
      format: "txt",
      createdAt: "2026-11-24T00:00:00.000Z",
      sections: [
        { title: "第一章 铺垫", text: "序幕拉开。" },
        { title: "第二章 亮环", text: ch1Text },
      ],
    });

    const hits = await searchBookFullText(repo, "search-book", "第3魂技 10万年");
    expect(hits.length).toBe(1);
    expect(hits[0]!.section).toBe(1);
    expect(hits[0]!.paragraphIndex).toBe(2);

    await ensureReaderSchema(platform);
    await saveReaderProgress(repo, {
      targetType: "book",
      targetId: "search-book",
      sectionIndex: 1,
      pageIndex: 0,
      scrollRatio: 0.5,
      anchorText: "霍雨浩亮出第3魂技",
      nodeId: null,
    });
    await addReaderBookmark(repo, {
      targetType: "book",
      targetId: "search-book",
      sectionIndex: 1,
      sectionTitle: "第二章 亮环",
      paragraphIndex: 2,
      snippet: "霍雨浩亮出第3魂技与10万年冰碧帝皇蝎魂环",
      nodeId: null,
    });
    await addReaderHighlight(repo, {
      targetType: "book",
      targetId: "search-book",
      worldId: null,
      sectionIndex: 1,
      sectionTitle: "第二章 亮环",
      paragraphIndex: 2,
      charStart: 0,
      charEnd: 12,
      selectedText: "霍雨浩亮出第3魂技",
      color: "cinnabar",
      note: "关键处",
      nodeId: null,
    });

    // Resplitting re-anchors bookmarks/highlights cleanly when chapter boundaries change
    const resplitBookText = `引子\n\n序幕拉开。\n\n第一回 试锋\n\n${ch1Text}`;
    await saveBook(repo, {
      id: "resplit-book",
      title: "重分章卷",
      format: "txt",
      createdAt: "2026-11-24T00:00:00.000Z",
      sections: [{ title: "正文", text: resplitBookText }],
    });
    await addReaderBookmark(repo, {
      targetType: "book",
      targetId: "resplit-book",
      sectionIndex: 0,
      sectionTitle: "正文",
      paragraphIndex: 4,
      snippet: "霍雨浩亮出第3魂技与10万年冰碧帝皇蝎魂环",
      nodeId: null,
    });
    const resplitRes = await applyBookResplit(repo, "resplit-book", { preset: "standard" });
    expect(resplitRes.sectionCount).toBeGreaterThanOrEqual(2);
    const bmRows = await platform.sql.query(
      "SELECT section_index FROM reader_bookmarks WHERE target_type = 'book' AND target_id = ?",
      ["resplit-book"],
    );
    expect(Number(bmRows[0]?.section_index)).toBe(resplitRes.sectionCount - 1);

    // Deleting a book cleans up reader_progress, reader_bookmarks, and reader_highlights
    await deleteBook(repo, "search-book");
    for (const tbl of ["reader_progress", "reader_bookmarks", "reader_highlights"]) {
      const rem = await platform.sql.query(`SELECT 1 FROM ${tbl} WHERE target_type = 'book' AND target_id = ?`, [
        "search-book",
      ]);
      expect(rem.length).toBe(0);
    }
  });

  it("allows single-paragraph empty replacement deletion in multi-paragraph revisions and preserves fanfic draft state", () => {
    const original = "第一段保留文字。\n\n第二段冗余重复需要删去。\n\n第三段结尾收束。";
    const start = original.indexOf("第二段");
    const end = start + "第二段冗余重复需要删去。".length;
    const preview = parsePlayerRevision(
      JSON.stringify({ replacement: "", note: "删去重复的第二段" }),
      {
        anchor: { worldId: "w1", lineId: "l1", headId: "n1", nodeId: "n1", original },
        range: { start, end },
        hint: "删除这一段",
      },
      null,
    );
    expect(preview).not.toBeNull();
    expect(preview!.replacement).toBe("");
    expect(preview!.narrative).toBe("第一段保留文字。\n\n第三段结尾收束。");

    const fanficDraft = normalizeOpeningDraft({
      ...EMPTY,
      settings: { ...EMPTY.settings, mode: "history" },
      fanfic: true,
    } as unknown as Record<string, unknown>);
    expect(fanficDraft.settings.mode).toBe("free");
    expect(fanficDraft.settings.clockStyle).toBe("elapsed");
    expect(fanficDraft.fanfic).toBe(true);

    const historyDraft = normalizeOpeningDraft({
      ...EMPTY,
      settings: { ...EMPTY.settings, mode: "history" },
      fanfic: false,
    } as unknown as Record<string, unknown>);
    expect(historyDraft.fanfic).toBe(false);
  });
});
