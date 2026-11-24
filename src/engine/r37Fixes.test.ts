import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import type { Platform } from "../platform";
import { migrate } from "./db/migrate";
import { Repo } from "./db/repo";
import { ChatError, isMaxTokensError, retryDecision } from "./llm/chat";
import { bookExists, getBookOutline, saveBook } from "./sources/library";
import { sampleState } from "./testing/fixtures";
import { newBinding } from "./sources/types";

let platform: Platform;
let repo: Repo;

beforeEach(async () => {
  platform = await createMemoryPlatform();
  await migrate(platform);
  repo = new Repo(platform);
});

describe("R37 performance & reliability fixes", () => {
  it("steps down maxTokens automatically on HTTP 400/422 max_tokens provider errors", () => {
    const err = new ChatError(
      "http",
      400,
      "",
      "Invalid value for 'max_tokens': 8192 exceeds model maximum allowed completion tokens 4096",
    );
    expect(isMaxTokensError(err)).toBe(true);
    const d1 = retryDecision(err, 1, [{ role: "user", content: "测试" }], 8192);
    expect(d1).toEqual({ retry: true, messages: [{ role: "user", content: "测试" }], maxTokens: 4096 });

    const d2 = retryDecision(err, 2, [{ role: "user", content: "测试" }], 4096);
    expect(d2).toEqual({ retry: true, messages: [{ role: "user", content: "测试" }], maxTokens: 2048 });

    const d3 = retryDecision(err, 3, [{ role: "user", content: "测试" }], 2048);
    expect(d3).toEqual({ retry: true, messages: [{ role: "user", content: "测试" }], maxTokens: 1024 });

    // Once already at 1024 or attempt >= 4, do not loop forever
    expect(retryDecision(err, 1, [{ role: "user", content: "测试" }], 1024).retry).toBe(false);
    expect(retryDecision(err, 4, [{ role: "user", content: "测试" }], 8192).retry).toBe(false);
  });

  it("bookExists and getBookOutline never deserialize source_books.json", async () => {
    await saveBook(repo, {
      id: "big-book",
      title: "绝世唐门测试卷",
      format: "txt",
      createdAt: "2026-11-24T00:00:00.000Z",
      sections: [
        { title: "第一章 外院大广场", text: "杜维伦立在高台上，目光扫过全场。" },
        { title: "第二章 凤凰第三变", text: "炽烈金红魂力腾空而起。" },
      ],
    });

    const queries: string[] = [];
    const origQuery = platform.sql.query.bind(platform.sql);
    platform.sql.query = async (sql, params) => {
      queries.push(sql);
      return origQuery(sql, params);
    };

    expect(await bookExists(repo, "big-book")).toBe(true);
    expect(await bookExists(repo, "missing-book")).toBe(false);

    const outline = await getBookOutline(repo, "big-book");
    expect(outline).not.toBeNull();
    expect(outline!.title).toBe("绝世唐门测试卷");
    expect(outline!.sections).toEqual([
      { title: "第一章 外院大广场", chars: 16 },
      { title: "第二章 凤凰第三变", chars: 11 },
    ]);

    // Must never execute `SELECT json FROM source_books`
    expect(queries.some((q) => /SELECT\s+json\s+FROM\s+source_books/i.test(q))).toBe(false);
  });

  it("listWorldCardInputs and listWorldSourceBriefs batch all worlds in a single SQL query without trailing edit pollution", async () => {
    await saveBook(repo, {
      id: "book-a",
      title: "外院原著",
      format: "txt",
      createdAt: "2026-11-24T00:00:00.000Z",
      sections: [{ title: "第一章", text: "考核开始。" }],
    });
    const s1 = sampleState();
    s1.protagonist.name = "霍雨浩";
    s1.source = newBinding("book-a", true);
    const w1 = await repo.createWorld({
      title: "外院风云",
      eraId: "free",
      settings: { mode: "free", clockStyle: "elapsed" },
      opening: { parentId: null, kind: "opening", narrative: "清晨的外院大广场人声鼎沸。", state: s1 },
    });
    const s1Turn = structuredClone(s1);
    s1Turn.time.elapsedMinutes = 15;
    const t1 = await repo.appendNode(w1.world.id, w1.line.id, {
      parentId: w1.node.id,
      kind: "turn",
      actionMode: "do",
      actionText: "观察高台",
      narrative: "杜维伦朗声宣布考核开始。你握紧拳头蓄势待发。",
      state: s1Turn,
    });
    // Trailing edit node must not hide latest non-edit narrative or inflate turn count
    await repo.appendNode(w1.world.id, w1.line.id, {
      parentId: t1.id,
      kind: "edit",
      narrative: "",
      actionText: "AI 整理了设定集",
      state: s1Turn,
    });

    const s2 = sampleState();
    s2.protagonist.name = "沈行";
    await repo.createWorld({
      title: "长安行",
      eraId: "tang-748",
      opening: { parentId: null, kind: "opening", narrative: "微雨初歇，崇仁坊灯火渐起。", state: s2 },
    });

    let queryCount = 0;
    const origQuery = platform.sql.query.bind(platform.sql);
    platform.sql.query = async (sql, params) => {
      queryCount++;
      return origQuery(sql, params);
    };

    const cards = await repo.listWorldCardInputs();
    expect(queryCount).toBe(1);
    expect(cards).toHaveLength(2);
    const fanficCard = cards.find((c) => c.world.id === w1.world.id)!;
    expect(fanficCard.protagonistName).toBe("霍雨浩");
    expect(fanficCard.turns).toBe(1);
    expect(fanficCard.last).toContain("你握紧拳头蓄势待发。");
    expect(fanficCard.time.elapsedMinutes).toBe(15);

    queryCount = 0;
    const briefs = await repo.listWorldSourceBriefs();
    expect(queryCount).toBe(1);
    expect(briefs).toHaveLength(2);
    expect(briefs.find((b) => b.world.id === w1.world.id)?.source?.bookId).toBe("book-a");
    expect(briefs.find((b) => b.world.title === "长安行")?.source).toBeNull();
  });
});
