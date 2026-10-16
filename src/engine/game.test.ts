import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { nowOf } from "./calendar/clock";
import { eraContext } from "./era";
import { Game, type TurnEvent } from "./game";
import { RECORD, fakeLlm, reply, type Script } from "./testing/fakeLlm";
import * as tree from "./tree";

const LLM = { slot: "main", url: "https://x/v1/chat/completions", model: "m", auxModel: "aux", includeUsage: true };
const OPENING = "你醒来，屋里很冷。\n天宝七载（戊子）冬月，第一日，辰时。\n门外王掌柜催房钱。" + RECORD({
  place: "西市旁邸店", people: [{ name: "王掌柜", role: "邸店掌柜", attitude: "冷淡" }],
  items: [{ name: "旧书", delta: 3 }], goals: [{ op: "add", name: "三日内付清房钱九十文" }],
});

async function setup(scripts: Script[]) {
  const llm = fakeLlm([{ text: OPENING }, ...scripts]);
  const platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, LLM);
  const events: TurnEvent[] = [];
  const worldId = (await game.createWorld({
    title: "长安", eraId: "tang-748", settings: { premise: "天宝七载，长安。" },
    protagonist: { name: "李安", gender: "男", age: 22, identity: "你是落第举子，欠房钱。" },
    arrival: "魂穿", origin: "历史系研究生", opening: { mode: "ai", hint: "" },
  }, (e) => events.push(e)))!;
  return { llm, platform, game, worldId, events };
}

async function play(game: Game, worldId: string, text: string, mode: "do" | "say" | "continue" = "do") {
  const events: TurnEvent[] = [];
  await game.play(worldId, { mode, text }, (e) => events.push(e)).done;
  return events;
}

describe("Game", () => {
  it("edits without advancing time and supports undo and redo", async () => {
    const { game, worldId } = await setup([]);
    const before = await tree.cursor(game.repo, worldId);
    const c = await game.editState(worldId, {
      time: "一夜",
      setStats: { money: 500, health: 0, energy: 100, fame: 100 },
      people: [{ name: "王掌柜", attitude: "友善", note: "记得这份人情", alive: false }],
      items: [{ name: "银簪", delta: 1 }], status: [{ op: "add", name: "风寒", detail: "有些头疼" }],
      goals: [{ op: "abandon", name: "三日内付清房钱九十文" }],
    }, "钱 300 → 500等");
    const state = await game.repo.getState(c.head.id);
    expect(state.time.elapsedMinutes).toBe(0);
    expect(c.head).toMatchObject({ kind: "edit", narrative: "", actionText: "钱 300 → 500等", choices: [] });
    expect(c.head.meta.chips).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("过了") })]));
    expect(state.protagonist.stats).toMatchObject({ money: 500, health: 0, energy: 100, fame: 100 });
    expect(state.people[0]).toMatchObject({ attitude: "友善", notes: "记得这份人情", alive: false });
    expect(state.protagonist.items.at(-1)?.name).toBe("银簪");
    expect(state.protagonist.statuses[0].name).toBe("风寒");
    expect(state.goals[0].status).toBe("放弃");
    const undone = await tree.undo(game.repo, c);
    expect(undone.head.id).toBe(before.head.id);
    expect((await game.repo.getState(undone.head.id)).protagonist.stats.money).toBe(300);
    const redone = await tree.redo(game.repo, undone);
    expect(await game.repo.getState(redone.head.id)).toEqual(state);
  });

  it("reapplies the immediate edit after regenerating its preceding turn", async () => {
    const { game, worldId } = await setup([
      { text: "版本一。" + RECORD({ money: -10 }) },
      { text: "版本二。" + RECORD({ money: -30 }) },
    ]);
    await play(game, worldId, "打听消息");
    const patch = { setStats: { money: 500 }, items: [{ name: "银簪", delta: 1 }] };
    await game.editState(worldId, patch, "钱 290 → 500、添加物品 银簪");
    const events: TurnEvent[] = [];
    await game.regenerate(worldId, null, (e) => events.push(e)).done;
    const c = await tree.cursor(game.repo, worldId);
    expect(c.head.kind).toBe("edit");
    expect(c.head.record).toEqual(patch);
    expect(c.head.actionText).toBe("钱 290 → 500、添加物品 银簪（已沿用）");
    const parent = (await game.repo.getNode(c.head.parentId!))!;
    expect(parent.narrative).toBe("版本二。");
    expect(parent.actionText).toBe("打听消息");
    expect((await game.repo.getState(c.head.id)).protagonist.stats.money).toBe(500);
    expect((await game.repo.getState(c.head.id)).time.elapsedMinutes).toBe(15);
    expect(events.at(-1)).toMatchObject({ type: "done", cursor: { head: { id: c.head.id } } });
  });

  it("clamps edited stats and lets notes and deceased marks be cleared", async () => {
    const { game, worldId } = await setup([]);
    await game.editState(worldId, { people: [{ name: "王掌柜", note: "旧事", alive: false }] }, "王掌柜：已故");
    const c = await game.editState(worldId, { setStats: { money: -1, health: 200, energy: -10, fame: 150 }, people: [{ name: "王掌柜", note: "", alive: true }] }, "修改");
    const state = await game.repo.getState(c.head.id);
    expect(state.protagonist.stats).toMatchObject({ money: 0, health: 100, energy: 0, fame: 100 });
    expect(state.people[0]).toMatchObject({ notes: "", alive: true });
  });

  it("only carries the first edit immediately after the regenerated turn", async () => {
    const { game, worldId } = await setup([
      { text: "版本一。" + RECORD({}) }, { text: "版本二。" + RECORD({}) },
    ]);
    await play(game, worldId, "出门");
    await game.editState(worldId, { setStats: { money: 500 } }, "钱 300 → 500");
    await game.editState(worldId, { setStats: { money: 800 } }, "钱 500 → 800");
    await game.regenerate(worldId, null, () => {}).done;
    const c = await tree.cursor(game.repo, worldId);
    expect(c.head.actionText).toBe("钱 300 → 500（已沿用）");
    expect((await game.repo.getState(c.head.id)).protagonist.stats.money).toBe(500);
    expect((await game.repo.getNode(c.head.parentId!))!.kind).toBe("turn");
  });

  it("creates a world from the opening record without spending time or money", async () => {
    const { game, worldId, events } = await setup([]);
    expect(events.at(-1)?.type).toBe("done");
    const c = await tree.cursor(game.repo, worldId);
    const state = await game.repo.getState(c.head.id);
    expect(c.head.narrative).toContain("王掌柜催房钱");
    expect(c.head.narrative).not.toContain("<record>");
    expect(state.time).toMatchObject({ start: "天宝七载 冬月十七", date: { era: "天宝", year: 7, month: 11, day: 17 }, startHour: 7, elapsedMinutes: 0 });
    expect(state.protagonist.stats.money).toBe(300);
    expect(state.people[0].name).toBe("王掌柜");
    expect(state.goals[0].name).toBe("三日内付清房钱九十文");
    expect(c.head.choices).toEqual(["甲", "乙", "丙"]);
  });

  it("uses the opening's purse, date and hour", async () => {
    const llm = fakeLlm([{ text: "你醒在汴京。" + RECORD({ money: "二百两", date: "宣和四年春二月", hour: 9, currency: [{ name: "文", value: 1 }, { name: "两", value: 1000 }], goals: [{ op: "add", name: "活下去" }] }) }]);
    const game = await Game.open(await createMemoryPlatform(llm), LLM);
    const worldId = (await game.createWorld({
      title: "", eraId: null, settings: { premise: "北宋宣和年间，汴京。" },
      protagonist: { name: "赵某", gender: "男", age: 17, identity: "你是官家的第十七子。" },
      arrival: "魂穿", origin: "程序员", opening: { mode: "ai", hint: "宫宴" },
    }, () => {}))!;
    const c = await tree.cursor(game.repo, worldId);
    const state = await game.repo.getState(c.head.id);
    expect(state.protagonist.stats.money).toBe(200000);
    expect(state.time).toMatchObject({ start: "宣和四年 二月初一", date: { era: "宣和", year: 4, month: 2, day: 1, ceYear: null }, startHour: 9, elapsedMinutes: 0 });
    expect(state.era.currency?.units[0].name).toBe("两");
    expect((await game.repo.getWorld(worldId))!.title).toBe("赵某的故事");
    expect(JSON.stringify(llm.calls[0].body)).toContain("北宋宣和年间，汴京。");
  });

  it("counts dates from a structured opening date and adds a year at New Year", async () => {
    const llm = fakeLlm([
      { text: "你醒来，已是岁末。" + RECORD({ date: { era: "天宝", year: 7, month: 12, day: 29, ceYear: 748 }, hour: 20, goals: [{ op: "add", name: "过年" }] }) },
      { text: "转眼过了年。" + RECORD({ time: "三天", choices: ["拜年"] }) },
    ]);
    const game = await Game.open(await createMemoryPlatform(llm), LLM);
    const worldId = (await game.createWorld({
      title: "", eraId: "tang-748", settings: {}, protagonist: { name: "李安", gender: "男", age: 22, identity: "你是落第举子。" },
      arrival: "魂穿", origin: "", opening: { mode: "ai", hint: "" },
    }, () => {}))!;
    expect(JSON.stringify(llm.calls[0].body)).toContain("开局日期是天宝七载 冬月十七");
    const events = await play(game, worldId, "等着过年");
    expect(JSON.stringify(llm.calls[1].body)).toContain("【当前】天宝七载 腊月廿九 戌时（约 20:00）");
    const done = events.at(-1) as Extract<TurnEvent, { type: "done" }>;
    expect(done.chips.map((c) => c.text)).toEqual(expect.arrayContaining(["过了 3 天", "过年了，23 岁"]));
    const state = await game.repo.getState((await tree.cursor(game.repo, worldId)).head.id);
    expect(state.time).toMatchObject({ start: "天宝七载 腊月廿九", startHour: 20 });
    expect(state.protagonist.age).toBe(23);
    expect(nowOf(eraContext("tang-748", state).clock, state.time.elapsedMinutes).text).toBe("天宝八载 正月初三 · 戌时");
  });

  it("keeps a player-written opening verbatim and extracts its state", async () => {
    const llm = fakeLlm([{ text: '{"time":"0","money":50,"place":"破庙","people":[{"name":"老乞丐","attitude":"友善"}],"choices":["起身"],"log":"开场"}' }]);
    const game = await Game.open(await createMemoryPlatform(llm), LLM);
    const worldId = (await game.createWorld({
      title: "破庙", eraId: "tang-748", settings: {},
      protagonist: { name: "阿九", gender: "女", age: 15, identity: "你是流落街头的孤女。" },
      arrival: "不穿越", origin: "", opening: { mode: "player", text: "雨夜，破庙。阿九缩在神像后面。" },
    }, () => {}))!;
    const c = await tree.cursor(game.repo, worldId);
    const state = await game.repo.getState(c.head.id);
    expect(c.head.narrative).toBe("雨夜，破庙。阿九缩在神像后面。");
    expect(state.protagonist.stats.money).toBe(50);
    expect(state.people[0].name).toBe("老乞丐");
    expect(c.head.choices).toEqual(["起身"]);
    expect(llm.calls[0].body.model).toBe("aux");
  });

  it("treats a written passage as part of the story", async () => {
    const { game, worldId, llm } = await setup([{ text: "掌柜愣住了。" + RECORD({}) }]);
    await game.play(worldId, { mode: "write", text: "你忽然掏出一锭金子拍在柜上。" }, () => {}).done;
    expect(JSON.stringify(llm.calls[1].body)).toContain("玩家以作者身份亲手写下了接下来的情节");
  });

  it("plays a turn: streams text without the record, applies changes, records usage", async () => {
    const { game, worldId, platform } = await setup([{ text: "你下楼买了两个胡饼。" + RECORD({ money: -6, items: [{ name: "胡饼", delta: 2 }] }) }]);
    const events = await play(game, worldId, "买两个胡饼");
    const texts = events.filter((e) => e.type === "text").map((e) => (e as { full: string }).full);
    expect(texts.at(-1)).toBe("你下楼买了两个胡饼。\n\n");
    expect(texts.join("")).not.toContain("record");
    const done = events.at(-1) as Extract<TurnEvent, { type: "done" }>;
    expect(done.chips.map((c) => c.text)).toContain("钱 −6 文");
    const state = await game.repo.getState(done.node.id);
    expect(state.protagonist.stats.money).toBe(294);
    expect(state.time.elapsedMinutes).toBe(15);
    const usage = await platform.sql.query("SELECT purpose, prompt_tokens FROM usage ORDER BY at");
    expect(usage.map((u) => u.purpose)).toEqual(["opening", "turn"]);
  });

  it("falls back to extraction when the record is missing", async () => {
    const { game, worldId, llm } = await setup([
      { text: "你在街角坐了半个时辰，什么也没发生。" },
      { text: '{"time":"半个时辰","log":"闲坐","choices":["起身"]}' },
    ]);
    const events = await play(game, worldId, "坐一会儿");
    expect(events.some((e) => e.type === "organizing")).toBe(true);
    const done = events.at(-1) as Extract<TurnEvent, { type: "done" }>;
    expect(done.node.choices).toEqual(["起身"]);
    expect(done.node.meta.extracted).toBe(true);
    expect((await game.repo.getState(done.node.id)).time.elapsedMinutes).toBe(60);
    expect(llm.calls[2].body.model).toBe("aux");
  });

  it("keeps the turn with no record when extraction also fails", async () => {
    const { game, worldId } = await setup([{ text: "你发了会儿呆。" }, { text: "无法提取" }]);
    const done = (await play(game, worldId, "发呆")).at(-1) as Extract<TurnEvent, { type: "done" }>;
    expect(done.node.status).toBe("no_record");
    expect(done.node.choices).toEqual([]);
  });

  it("retries once when the request fails before any data", async () => {
    const { game, worldId, llm } = await setup([
      [{ type: "error", kind: "http", status: 503 }],
      { text: "这回顺利了。" + RECORD({}) },
    ]);
    const events = await play(game, worldId, "出门");
    expect(events.at(-1)?.type).toBe("done");
    expect(llm.calls).toHaveLength(3);
  });

  it.each([
    [{ type: "error", kind: "http", status: 429 } as const, "quota"],
    [{ type: "error", kind: "timeout_first" } as const, "timeout"],
    [{ type: "error", kind: "network", message: "reset" } as const, "network"],
  ])("gives up after one retry: %o", async (error, reason) => {
    const { game, worldId, llm } = await setup([[error], [error]]);
    const events = await play(game, worldId, "出门");
    expect(events.at(-1)).toMatchObject({ type: "failed", reason, partialSaved: false });
    expect(llm.calls).toHaveLength(3);
    expect((await tree.cursor(game.repo, worldId)).head.kind).toBe("opening");
  });

  it("reports an empty reply without saving a turn", async () => {
    const { game, worldId } = await setup([{ text: "" }]);
    expect((await play(game, worldId, "出门")).at(-1)).toMatchObject({ type: "failed", reason: "empty" });
    expect((await tree.cursor(game.repo, worldId)).head.kind).toBe("opening");
  });

  it("reports a failure before any text without saving a turn", async () => {
    const { game, worldId } = await setup([
      [{ type: "error", kind: "http", status: 401, message: "bad key" }],
    ]);
    const events = await play(game, worldId, "出门");
    expect(events.at(-1)).toMatchObject({ type: "failed", reason: "auth", partialSaved: false });
    const c = await tree.cursor(game.repo, worldId);
    expect(c.head.kind).toBe("opening");
  });

  it("saves partial text as an interrupted turn and can continue it", async () => {
    const partial = reply("你推开门，风雪扑面。", { size: 3 }).slice(0, 3);
    const { game, worldId } = await setup([
      [...partial, { type: "error", kind: "timeout_idle" }],
      { text: "你缩了缩脖子，走进雪里。" + RECORD({ time: "两刻" }) },
    ]);
    const events = await play(game, worldId, "出门");
    expect(events.at(-1)).toMatchObject({ type: "failed", reason: "timeout", partialSaved: true });
    let c = await tree.cursor(game.repo, worldId);
    expect(c.head.status).toBe("interrupted");
    expect(c.head.narrative).toBe("你推开门，风");

    const more: TurnEvent[] = [];
    await game.resumeInterrupted(worldId, (e) => more.push(e)).done;
    c = await tree.cursor(game.repo, worldId);
    expect(c.head.status).toBe("ok");
    expect(c.head.narrative).toBe("你推开门，风你缩了缩脖子，走进雪里。");
    expect((await game.repo.getState(c.head.id)).time.elapsedMinutes).toBe(30);
  });

  it("does not save a refused turn", async () => {
    const { game, worldId } = await setup([{ text: "抱歉，我无法继续这个故事。" }]);
    const events = await play(game, worldId, "动手");
    expect(events.at(-1)).toMatchObject({ type: "failed", reason: "refused" });
    expect((await tree.cursor(game.repo, worldId)).head.kind).toBe("opening");
  });

  it("treats a content_filter finish as refused", async () => {
    const { game, worldId } = await setup([{ text: "……", finish: "content_filter" }]);
    expect((await play(game, worldId, "动手")).at(-1)).toMatchObject({ reason: "refused" });
  });

  it("regenerates a sibling version with the same action", async () => {
    const { game, worldId, llm } = await setup([
      { text: "版本一。" + RECORD({}) },
      { text: "版本二。" + RECORD({}) },
    ]);
    await play(game, worldId, "打听消息");
    await game.regenerate(worldId, "写短一点", () => {}).done;
    const c = await tree.cursor(game.repo, worldId);
    expect(c.head.narrative).toBe("版本二。");
    expect(c.head.actionText).toBe("打听消息");
    expect((await tree.variants(game.repo, c.head)).count).toBe(2);
    expect(JSON.stringify(llm.calls[2].body)).toContain("写短一点");
  });

  it("passes last turn's corrections into the next prompt", async () => {
    const { game, worldId, llm } = await setup([
      { text: "你想买马。" + RECORD({ money: -9000, items: [{ name: "马", delta: 1 }] }) },
      { text: "你转身离开。" + RECORD({}) },
    ]);
    await play(game, worldId, "买马");
    await play(game, worldId, "走");
    expect(JSON.stringify(llm.calls[2].body)).toContain("没有成交");
  });

  it("continues from a rewritten passage", async () => {
    const { game, worldId, llm } = await setup([
      { text: "掌柜冷着脸。" + RECORD({}) },
      { text: "你接着往下说。" + RECORD({}) },
    ]);
    await play(game, worldId, "求情");
    const c = await tree.cursor(game.repo, worldId);
    await game.repo.updateNarrative(c.head.id, "掌柜叹了口气，答应宽限三日。");
    expect((await tree.cursor(game.repo, worldId)).head).toMatchObject({ narrative: "掌柜叹了口气，答应宽限三日。", rewritten: true });
    await play(game, worldId, "道谢");
    const prompt = JSON.stringify(llm.calls[2].body);
    expect(prompt).toContain("答应宽限三日");
    expect(prompt).not.toContain("掌柜冷着脸");
  });

  it("recovers a turn that finished while the app was killed", async () => {
    const { game, worldId, platform } = await setup([]);
    const c = await tree.cursor(game.repo, worldId);
    const llm = platform.llm as ReturnType<typeof fakeLlm>;
    llm.cache.set("dead", reply("你睡到天亮。" + RECORD({ time: "一夜" })));
    await game.repo.setSetting("pending", { worldId, lineId: c.line.id, parentId: c.head.id, streamId: "dead", kind: "turn", action: { mode: "do", text: "睡觉" } });
    expect(await game.recoverPending()).toBe(worldId);
    const after = await tree.cursor(game.repo, worldId);
    expect(after.head.narrative).toBe("你睡到天亮。");
    expect((await game.repo.getState(after.head.id)).time.elapsedMinutes).toBe(720);
    expect(await game.recoverPending()).toBeNull();
  });
});
