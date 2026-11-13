import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { eraContext, eraPack } from "./era";
import { packCards } from "./era/card";
import { Game } from "./game";
import { applyRecord } from "./state/apply";
import { sampleState } from "./testing/fixtures";
import { fakeLlm } from "./testing/fakeLlm";
import { packTimeline } from "./timeline";
import { newId } from "./db/repo";
import * as tree from "./tree";

const LLM = { slot: "main", url: "https://x/v1/chat/completions", model: "m", auxModel: "aux", includeUsage: true };

async function setup() {
  const platform = await createMemoryPlatform();
  const game = await Game.open(platform, LLM);
  const pack = eraPack("tang-748")!;
  const seed = sampleState();
  seed.version = 2;
  seed.time = { start: "天宝七载 冬月十七", date: structuredClone(pack.start.date), startHour: 7, elapsedMinutes: 0 };
  seed.protagonist.identity = "你是落第举子，欠房钱。";
  Object.assign(seed, packCards(pack));
  const state = applyRecord(seed, {
    place: "西市旁邸店", people: [{ name: "王掌柜", role: "邸店掌柜", attitude: "冷淡" }],
    items: [{ name: "旧书", delta: 3 }], goals: [{ op: "add", name: "三日内付清房钱九十文" }],
  }, { mode: "do", difficulty: "标准", currency: pack.currency }, { advanceTime: false }).state;
  state.timeline = packTimeline(pack.timeline, eraContext(pack.id, state).clock).map(e => ({ id: newId(), ...e }));
  const { world } = await game.repo.createWorld({
    title: "长安", eraId: pack.id, settings: { premise: "天宝七载，长安。" },
    opening: { parentId: null, kind: "opening", narrative: "你醒来，屋里很冷。门外王掌柜催房钱。", state,
      meta: { setup: { arrival: "魂穿", hint: "", organize: false } } },
  });
  return { platform, game, worldId: world.id };
}

describe("local Game operations", () => {
  it("edits without advancing time and supports undo and redo", async () => {
    const { game, worldId } = await setup();
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

  it("clamps edited stats and lets notes and deceased marks be cleared", async () => {
    const { game, worldId } = await setup();
    await game.editState(worldId, { people: [{ name: "王掌柜", note: "旧事", alive: false }] }, "王掌柜：已故");
    const c = await game.editState(worldId, { setStats: { money: -1, health: 200, energy: -10, fame: 150 }, people: [{ name: "王掌柜", note: "", alive: true }] }, "修改");
    const state = await game.repo.getState(c.head.id);
    expect(state.protagonist.stats).toMatchObject({ money: 0, health: 100, energy: 0, fame: 100 });
    expect(state.people[0]).toMatchObject({ notes: "", alive: true });
  });

  it("returns the setup a world began with", async () => {
    const { game, worldId } = await setup();
    await game.repo.updateSettings(worldId, { ...(await game.repo.getWorld(worldId))!.settings, rules: "多写对话" });
    expect(await game.setupOf(worldId)).toMatchObject({
      title: "长安", eraId: "tang-748", settings: { premise: "天宝七载，长安。", rules: "多写对话" },
      protagonist: { name: "李安", gender: "男", age: 22, identity: "你是落第举子，欠房钱。" },
      arrival: "魂穿", origin: "历史系研究生", opening: { mode: "ai", hint: "" },
    });
  });

  it("backs up at start once a day", async () => {
    const { game } = await setup();
    const now = Date.now();
    expect(await game.autoBackup(now)).toMatch(/-auto\.sqlite$/);
    expect(await game.autoBackup(now + 3_600_000)).toBeNull();
    expect(await game.autoBackup(now + 2 * 86_400_000)).toMatch(/-auto\.sqlite$/);
  });

  it("adds no edit node and says why when nothing changes or a part is refused", async () => {
    const { game, worldId } = await setup();
    const before = await tree.cursor(game.repo, worldId);
    const state = await game.repo.getState(before.head.id);
    // A wish under a goal's name, a date without an era, a stat already at that value.
    await expect(game.editState(worldId, { goals: [{ op: "add", kind: "心愿", name: "三日内付清房钱九十文" }] }, "新心愿")).rejects.toMatchObject({ name: "EditRejected", reason: "已经有目标“三日内付清房钱九十文”了" });
    await expect(game.editState(worldId, { rules: { date: { era: "", year: 9, month: 11, day: 17 } } }, "开局日期改为九年")).rejects.toMatchObject({ reason: "开局日期写得不完整，没有生效" });
    await expect(game.editState(worldId, { setStats: { money: state.protagonist.stats.money } }, "钱")).rejects.toMatchObject({ reason: expect.stringContaining("没有需要保存的改动") });
    // One refused part rejects the whole edit, so the summary never claims what did not happen.
    await expect(game.editState(worldId, { setStats: { money: 1 }, profile: { age: 999 } }, "钱、年龄")).rejects.toMatchObject({ reason: "年龄 999 不在 1～120 之间，没有生效" });
    expect((await tree.cursor(game.repo, worldId)).head.id).toBe(before.head.id);
    expect((await game.repo.getState(before.head.id)).protagonist.stats.money).toBe(state.protagonist.stats.money);
    // A real change still goes through.
    const c = await game.editState(worldId, { setStats: { money: 1 } }, "钱");
    expect(c.head.kind).toBe("edit");
  });

  it("edits the protagonist's 人物小传 and an item's own fields", async () => {
    const { game, worldId } = await setup();
    const c = await game.editState(worldId, {
      profile: { name: "李长安", age: 23, identity: "替人抄书的落第举子", origin: "程序员", cheat: "熟读唐史" },
      items: [{ name: "旧书", set: { name: "旧书卷", quantity: 2, unit: "卷", place: "邸店床下", note: "《文选》残本" } }, { name: "紫毫笔", set: { quantity: 1, unit: "支" } }],
    }, "人物小传");
    const me = (await game.repo.getState(c.head.id)).protagonist;
    expect(me).toMatchObject({ name: "李长安", aliases: ["李安"], age: 23, identity: "替人抄书的落第举子", origin: "程序员", cheat: "熟读唐史" });
    expect(me.items).toEqual([
      { name: "旧书卷", quantity: 2, unit: "卷", place: "邸店床下", note: "《文选》残本" },
      { name: "紫毫笔", quantity: 1, unit: "支", place: null, note: "" },
    ]);
    const dropped = await game.editState(worldId, { items: [{ name: "紫毫笔", set: { quantity: 0 } }] }, "去掉物品 紫毫笔");
    expect((await game.repo.getState(dropped.head.id)).protagonist.items.map((i) => i.name)).toEqual(["旧书卷"]);
  });

  it("places the great events again when the opening date changes (F2)", async () => {
    const { game, worldId } = await setup();
    const start = await game.repo.getState((await tree.cursor(game.repo, worldId)).head.id);
    const shibao = start.timeline!.find((e) => e.title.includes("石堡城"))!;
    // A year earlier: the same written date is about a year further away.
    const c = await game.editState(worldId, { rules: { date: { era: "天宝", year: 6, month: 11, day: 17, ceYear: 747 } } }, "开局日期改为天宝六载");
    const moved = (await game.repo.getState(c.head.id)).timeline!.find((e) => e.id === shibao.id)!;
    expect(moved.date).toBe(shibao.date);
    const days = Math.round((moved.atMinute! - shibao.atMinute!) / 1440);
    expect(days).toBeGreaterThan(350);
    expect(days).toBeLessThan(390);
  });

  it("purges routes left in the trash for 30 days when the game opens (G2)", async () => {
    const { game, worldId, platform } = await setup();
    const c = await tree.cursor(game.repo, worldId);
    const old = await game.repo.createLine(worldId, c.head.id, "旧路", false);
    await game.repo.setLineDeleted(old.id, true);
    await platform.sql.query("UPDATE lines SET deleted_at = ? WHERE id = ?", [new Date(Date.now() - 31 * 86_400_000).toISOString(), old.id]);
    await Game.open(platform, LLM);
    expect(await game.repo.getLine(old.id)).toBeNull();
  });

  it("previews the next request with a previously saved token ratio", async () => {
    const { game, worldId } = await setup();
    expect((await game.previewContext(worldId)).calibrated).toBe(false);
    await game.repo.setSetting("tokenRatio:m", 0.3);
    const preview = await game.previewContext(worldId);
    expect(preview).toMatchObject({ calibrated: true, ratio: 0.3, budgetChars: 40000 });
    expect(preview.layers.map(l => l.key)).toEqual(["rules", "premise", "era", "recap", "history", "state", "world", "essentials", "cards", "recall", "directive", "notes", "action", "spec"]);
    expect(preview.layers.find(l => l.key === "action")!.content).toContain("（下一回合的行动）");
  });

  it("writes a chapter on request when automatic summaries are off, and rewrites it", async () => {
    const { game, worldId } = await setup();
    const llm = fakeLlm(["鱼袋失踪", "重写的章"].map(title => ({ text: JSON.stringify({ title, gist: title + "的梗概", summary: title + "：崔怀远查到鱼袋下落。" }) })));
    const chapterGame = await Game.open({ ...game.platform, llm }, LLM);
    await game.repo.updateSettings(worldId, { ...(await game.repo.getWorld(worldId))!.settings, chapterEvery: 0 });
    let cursor = await tree.cursor(game.repo, worldId);
    for (let i = 1; i <= 2; i++) cursor = await tree.append(game.repo, cursor, { kind: "turn", narrative: "第" + i + "段。", actionText: "走第" + i + "步", state: await game.repo.getState(cursor.head.id) });
    expect(llm.calls).toHaveLength(0);
    const chapter = (await chapterGame.writeChapter(worldId))!;
    expect(chapter.title).toBe("鱼袋失踪");
    expect(await chapterGame.writeChapter(worldId)).toBeNull();
    await game.repo.updateChapter(chapter.id, { title: "我改的", gist: "我改的", summary: "我改的", edited: true });
    expect(await chapterGame.rewriteChapter(worldId, chapter.id)).toMatchObject({ title: "重写的章", edited: false });
    expect(JSON.stringify(llm.calls[1].body)).toContain("第 1～2 回合");
  });
});
