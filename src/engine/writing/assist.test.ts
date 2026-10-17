import { describe, expect, it, vi } from "vitest";
import { Game } from "../game";
import { createMemoryPlatform } from "../../platform/memory";
import { sampleState } from "../testing/fixtures";
import { fakeLlm, reply, type Script } from "../testing/fakeLlm";
import type { StreamEvent } from "../../platform";
import * as tree from "../tree";
import { adoptRewrite, assertWritingAnchor, paragraphs, replaceRange, startWriting, STALE_WRITING, withoutRecord, writingMessages, WRITING_PROMPT_VERSION } from "./assist";

async function setup(scripts: Script[] = []) {
  const llm = fakeLlm(scripts);
  const platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, { slot: "fake", url: "http://127.0.0.1/v1/chat/completions", model: "main", auxModel: "aux", includeUsage: true });
  const { world, node, line } = await game.repo.createWorld({ title: "测试", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: "雨落下来。\n\n客人推门。", state: sampleState() } });
  const anchor = { worldId: world.id, lineId: line.id, headId: node.id, nodeId: node.id, original: node.narrative };
  const request = { anchor, kind: "rewrite" as const, text: "雨落下来。", hint: "简练些", mode: "do" as const };
  return { game, llm, platform, anchor, request, node, world, line };
}

describe("writing assistance", () => {
  it("replaces only the chosen paragraph, preserving repeated text and separators", () => {
    const text = "雨落。\r\n\r\n雨落。\n客来。";
    expect(replaceRange(text, paragraphs(text)[1], "雨歇。" )).toBe("雨落。\r\n\r\n雨歇。\n客来。");
    expect(() => replaceRange(text, { start: 4, end: 2 }, "字")).toThrow();
  });
  it("drops a turn-format record block the model may append (R14 UI review)", () => {
    expect(withoutRecord("细雨。\n客人推门。\n<record>{\"time\":\"一刻\"}</record>")).toBe("细雨。\n客人推门。");
    expect(withoutRecord("只有改稿")).toBe("只有改稿");
    expect(withoutRecord("<record>{}</record>")).toBe("");
  });
  it("versions the prompt and keeps rewriting and action polishing factual", () => {
    // The version is kept with each adopted rewrite, not sent to the model.
    expect(WRITING_PROMPT_VERSION).toBe("writing-2");
    expect(writingMessages("rewrite", "雨", "", "前文", "do")[0].content).not.toContain(WRITING_PROMPT_VERSION);
    expect(writingMessages("rewrite", "雨", "", "前文", "do")[0].content).toContain("不改变已经发生的事实");
    expect(writingMessages("polish", "去问路", "", "前文", "say")[0].content).toContain("不写行动结果");
  });
  it("uses auxiliary model and logs world/node usage without editing or advancing", async () => {
    const s = await setup([{ text: "细雨落下。" }]);
    const onText = vi.fn();
    expect(await startWriting(s.game, s.request, onText).done).toBe("细雨落下。");
    expect(onText).toHaveBeenCalled();
    expect(s.llm.calls[0].body.model).toBe("aux");
    expect((await s.game.repo.getNode(s.node.id))?.narrative).toBe(s.node.narrative);
    expect((await tree.cursor(s.game.repo, s.world.id)).head.id).toBe(s.node.id);
    const rows = await s.platform.sql.query("SELECT * FROM usage");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ world_id: s.world.id, node_id: s.node.id, model: "aux", purpose: "段落改写", outcome: "ok", prompt_tokens: 100 });
  });
  it("falls back to main model and logs action polishing separately", async () => {
    const s = await setup([{ text: "请问前面的路怎么走？" }]);
    s.game.llm!.auxModel = "";
    await startWriting(s.game, { ...s.request, kind: "polish" }, () => {}).done;
    expect(s.llm.calls[0].body.model).toBe("main");
    expect((await s.platform.sql.query("SELECT purpose FROM usage"))[0].purpose).toBe("行动润色");
  });
  it("retries a failure before text once, recording both attempts", async () => {
    const s = await setup([[{ type: "error", kind: "http", status: 500 }], { text: "细雨。" }]);
    expect(await startWriting(s.game, s.request, () => {}).done).toBe("细雨。");
    expect(s.llm.calls).toHaveLength(2);
    expect((await s.platform.sql.query("SELECT outcome FROM usage ORDER BY rowid")).map((x) => x.outcome)).toEqual(["failed", "ok"]);
  });
  it("does not retry partial output, and never offers truncated or refused output", async () => {
    for (const script of [
      [reply("半句")[1], { type: "error", kind: "network" }] as StreamEvent[],
      { text: "半句", finish: "length" }, { text: "抱歉，我无法完成。", finish: "content_filter" },
    ]) {
      const s = await setup([script]);
      await expect(startWriting(s.game, s.request, () => {}).done).rejects.toThrow();
      expect(s.llm.calls).toHaveLength(1);
      expect((await s.game.repo.getNode(s.node.id))?.rewritten).toBe(false);
    }
  });
  it("cancels before startup without sending a request", async () => {
    const s = await setup();
    const work = startWriting(s.game, s.request, () => {});
    work.cancel();
    await expect(work.done).rejects.toMatchObject({ kind: "cancelled" });
    expect(s.llm.calls).toHaveLength(0);
  });
  it("ignores late events even if the provider ignores cancellation", async () => {
    const s = await setup();
    let emit!: (event: StreamEvent) => void;
    s.llm.stream = vi.fn(async (_request, callback) => { emit = callback; return "late"; });
    s.llm.cancel = vi.fn(async () => {});
    const onText = vi.fn();
    const work = startWriting(s.game, s.request, onText);
    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
    work.cancel();
    await expect(work.done).rejects.toMatchObject({ kind: "cancelled" });
    reply("迟到的改稿").forEach(emit);
    expect(onText).not.toHaveBeenCalled();
    expect(s.llm.cancel).toHaveBeenCalledWith("late");
    expect((await s.platform.sql.query("SELECT outcome FROM usage"))[0].outcome).toBe("cancelled");
  });
  it("rejects a result after advancing to a different node", async () => {
    const s = await setup();
    let emit!: (event: StreamEvent) => void;
    s.llm.stream = async (_request, callback) => { emit = callback; return "late"; };
    const work = startWriting(s.game, s.request, () => {});
    await vi.waitFor(() => expect(emit).toBeTypeOf("function"));
    await tree.append(s.game.repo, await tree.cursor(s.game.repo, s.world.id), { kind: "turn", narrative: "下一回合", state: sampleState() });
    reply("旧改稿").forEach(emit);
    await expect(work.done).rejects.toThrow(STALE_WRITING);
    expect((await s.platform.sql.query("SELECT outcome FROM usage"))[0].outcome).toBe("stale");
  });
  it("rejects another world, changed line, or changed original before adopting", async () => {
    const s = await setup();
    await expect(assertWritingAnchor(s.game, { ...s.anchor, worldId: "missing" })).rejects.toThrow(STALE_WRITING);
    await expect(adoptRewrite(s.game, { ...s.anchor, original: "旧原文" }, "改稿")).rejects.toThrow(STALE_WRITING);
    const other = await s.game.repo.createLine(s.world.id, s.node.id, "另一条路", false);
    await s.game.repo.setCurrentLine(s.world.id, other.id);
    await expect(adoptRewrite(s.game, s.anchor, "改稿")).rejects.toThrow(STALE_WRITING);
    expect((await s.game.repo.getNode(s.node.id))?.narrative).toBe(s.node.narrative);
  });
  it("adopts the new wording into the passage itself, keeping the route, facts and pins, and the original for 恢复原文", async () => {
    const s = await setup();
    const oldState = await s.game.repo.getState(s.node.id);
    await s.game.repo.addPin(s.world.id, s.node.id, "记住雨夜的约定");
    const nodes = async () => (await s.platform.sql.query("SELECT COUNT(*) AS n FROM nodes"))[0].n;
    const before = await nodes();
    const revised = await adoptRewrite(s.game, s.anchor, "细雨。\n\n客人推门。");
    expect(revised.head.id).toBe(s.node.id);
    expect(revised.line.id).toBe(s.line.id);
    expect(revised.head).toMatchObject({ narrative: "细雨。\n\n客人推门。", rewritten: true, meta: { original: s.node.narrative, writingVersion: WRITING_PROMPT_VERSION } });
    expect(await nodes()).toBe(before);
    expect(await s.game.repo.lines(s.world.id)).toHaveLength(1);
    expect(await s.game.repo.getState(s.node.id)).toEqual(oldState);
    expect((await s.game.repo.pinsOnPath(s.world.id, s.node.id)).map((p) => p.text)).toEqual(["记住雨夜的约定"]);
    // A second rewrite still restores to the first original.
    await adoptRewrite(s.game, { ...s.anchor, original: "细雨。\n\n客人推门。" }, "雨歇。\n\n客人推门。");
    expect(await s.game.repo.restoreNarrative(s.node.id)).toBe(true);
    expect(await s.game.repo.getNode(s.node.id)).toMatchObject({ narrative: s.node.narrative, rewritten: false });
  });
  it("leaves the passage untouched if the write fails", async () => {
    const s = await setup();
    const batch = s.platform.sql.batch.bind(s.platform.sql);
    const spy = vi.spyOn(s.platform.sql, "batch").mockImplementation((statements) => batch([...statements, { sql: "INSERT INTO missing_table VALUES (1)" }]));
    await expect(adoptRewrite(s.game, s.anchor, "改稿")).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await s.game.repo.getWorld(s.world.id))?.currentLineId).toBe(s.line.id);
    expect(await s.game.repo.getNode(s.node.id)).toMatchObject({ narrative: s.node.narrative, rewritten: false });
  });
  it.each(["line", "head", "text"])("changes nothing when the %s changes just before the write", async (change) => {
    const s = await setup();
    const alternative = await s.game.repo.createLine(s.world.id, s.node.id, "另一路", false);
    const next = await s.game.repo.appendNode(s.world.id, alternative.id, { parentId: s.node.id, kind: "turn", narrative: "下一段", state: sampleState() });
    const batch = s.platform.sql.batch.bind(s.platform.sql);
    vi.spyOn(s.platform.sql, "batch").mockImplementation(async (statements) => {
      if (change === "line") await s.game.repo.setCurrentLine(s.world.id, alternative.id);
      if (change === "head") await s.game.repo.moveLine(s.line.id, next.id);
      if (change === "text") await s.game.repo.updateNarrative(s.node.id, "玩家刚改的新文字");
      return batch(statements);
    });
    await expect(adoptRewrite(s.game, s.anchor, "过期改稿")).rejects.toThrow(STALE_WRITING);
    expect((await s.game.repo.getNode(s.node.id))?.narrative).toBe(change === "text" ? "玩家刚改的新文字" : s.node.narrative);
    expect(await s.game.repo.lines(s.world.id)).toHaveLength(2);
  });
  it("rewrites an earlier passage where it is: later turns, bookmarks and the current route stay", async () => {
    const s = await setup();
    let cur = await tree.cursor(s.game.repo, s.world.id);
    cur = await tree.append(s.game.repo, cur, { kind: "turn", narrative: "旧中段", state: sampleState(280) });
    const source = cur.head;
    cur = await tree.append(s.game.repo, cur, { kind: "turn", narrative: "旧结尾", state: sampleState(260) });
    const bookmark = await tree.addBookmark(s.game.repo, s.world.id, cur.head.id, "结尾书签");
    const revised = await adoptRewrite(s.game, { ...s.anchor, headId: cur.head.id, nodeId: source.id, original: source.narrative }, "润色中段");
    // The player stays at the end of the story (0.9.0 behaviour); the middle passage reads the new wording.
    expect(revised.head.id).toBe(cur.head.id);
    expect((await s.game.repo.path(cur.head.id)).map((n) => n.narrative)).toEqual([s.node.narrative, "润色中段", "旧结尾"]);
    expect((await s.game.repo.getLine(s.line.id))?.nodeId).toBe(cur.head.id);
    expect((await s.game.repo.getLine(bookmark.id))?.nodeId).toBe(cur.head.id);
    expect(await s.game.repo.getState(source.id)).toEqual(sampleState(280));
  });
});
