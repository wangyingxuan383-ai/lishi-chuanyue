import { describe, expect, it } from "vitest";
import { contentCardPatch, editableContentCards } from "./contentPacks";
import { GENRE_PACKS } from "../../content/genrePacks";
import { HISTORY_LIFE_PACKS } from "../../content/eras/lifeNotes";
import { EMPTY, normalizeOpeningDraft, toNewWorld } from "../../ui/screens/openingDraft";
import { fillGenreOpening } from "../../ui/screens/genreOpening";
import { newBinding } from "../sources/types";
import { Game } from "../game";
import { sampleState } from "../testing/fixtures";
import { createMemoryPlatform } from "../../platform/memory";
import { fakeLlm } from "../testing/fakeLlm";
import * as tree from "../tree";

describe("editable built-in copies", () => {
  it("fills only selected opening fields and keeps user facts, title, binding and play style", () => {
    const before = { ...structuredClone(EMPTY), title: "手写书名", titlePolicy: "manual" as const, name: "行者", premise: "已有设定", identity: "已有身份", play: "watch" as const, source: { ...newBinding("book", false), through: 3 }, settings: { ...EMPTY.settings, mode: "free" as const, essentials: "独立事实", directive: "旧写法", rules: "原规则" } };
    const copy = structuredClone(before), pack = GENRE_PACKS[0];
    const after = fillGenreOpening(before, { hint: pack.openingHint, guidance: pack.guidance });
    expect(before).toEqual(copy); expect(after).toMatchObject({ title: "手写书名", titlePolicy: "manual", name: "行者", premise: "已有设定", identity: "已有身份", play: "watch", source: before.source });
    expect(after.settings).toMatchObject({ essentials: "独立事实", directive: "旧写法", rules: `原规则\n${pack.guidance}` });
    expect(fillGenreOpening(after, { guidance: pack.guidance }).settings.rules).toBe(after.settings.rules);
    expect(() => fillGenreOpening({ ...before, fanfic: true }, { premise: pack.premise })).toThrow("同人");
    const restored = normalizeOpeningDraft(after as unknown as Record<string, unknown>);
    expect(toNewWorld(restored).settings.directive).toBe("旧写法");
    expect(normalizeOpeningDraft({ ...EMPTY, settings: { mode: "free" } }).settings.directive).toBe("");
  });
  it("rejects conflicting names and aliases instead of turning an add into an overwrite", () => {
    const cards = editableContentCards(GENRE_PACKS[0]), state = sampleState();
    state.cards = [{ id: "owned", kind: "设定", name: "我的规则", keys: [cards[0].name], content: "原内容", source: "玩家" }];
    expect(() => contentCardPatch(state, cards)).toThrow("不会覆盖");
    expect(state.cards[0].content).toBe("原内容");
    const drafts = editableContentCards(GENRE_PACKS[0]); drafts[1].name = drafts[0].name;
    expect(() => contentCardPatch({ cards: [] }, drafts)).toThrow("不会覆盖");
  });
  it("adopts edited selected cards through a zero-model reversible story edit; later catalog changes do not replace them", async () => {
    const llm = fakeLlm([]), platform = await createMemoryPlatform(llm), game = await Game.open(platform);
    const state = sampleState(); state.version = 2; state.era = { mode: "free", packId: null }; state.cards = [];
    const { world } = await game.repo.createWorld({ title: "独立资料样本", eraId: "free", opening: { parentId: null, kind: "opening", narrative: "旅人站在桥边。", state } });
    const before = await tree.cursor(game.repo, world.id), pack = structuredClone(HISTORY_LIFE_PACKS[0]);
    const cards = editableContentCards(pack); cards.forEach((card, index) => { card.selected = index === 0; }); cards[0].content += "\n本局补充：仅作为背景参考。";
    await game.editState(world.id, { cards: contentCardPatch(state, cards) }, "选用资料", undefined, before.head.id);
    const after = await tree.cursor(game.repo, world.id), saved = await game.repo.getState(after.head.id);
    expect(saved.cards).toHaveLength(1); expect(saved.cards[0]).toMatchObject({ source: "玩家", content: cards[0].content });
    expect(saved.time).toEqual(state.time); expect(saved.protagonist).toEqual(state.protagonist);
    pack.cards[0].text = "更新后的内置内容";
    expect((await game.repo.getState(after.head.id)).cards[0].content).not.toContain(pack.cards[0].text);
    await expect(game.editState(world.id, { cards: contentCardPatch(state, cards) }, "旧预览", undefined, before.head.id)).rejects.toThrow("故事已变化");
    await tree.undo(game.repo, after);
    expect((await game.repo.getState(before.head.id)).cards).toEqual([]);
    expect(llm.calls).toHaveLength(0); expect(await platform.sql.query("SELECT * FROM usage")).toEqual([]);
  });
});
