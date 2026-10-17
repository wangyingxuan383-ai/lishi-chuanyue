import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import { Game, type NewWorld, type TurnEvent } from "./game";
import { fakeLlm, RECORD, type Script } from "./testing/fakeLlm";
import * as tree from "./tree";
import { monthSpend } from "../ui/components/budgetMath";

const setup: NewWorld = {
  title: "静静的书店", eraId: null, settings: { autoUpkeep: false, chapterEvery: 0, choiceCount: 0 },
  protagonist: { name: "李安", age: 22, gender: "男", identity: "店主" },
  arrival: "不穿越", origin: "", opening: { mode: "ai", hint: "" }, organize: false,
};
const opening = { text: "午后的书店很安静。" + RECORD({ money: 100 }) };
const failure: Script = [{ type: "error", kind: "http", status: 401, message: "test" }];
async function prepare(scripts: Script[]) {
  const platform = await createMemoryPlatform(fakeLlm(scripts));
  const game = await Game.open(platform, { slot: "test", model: "test", url: "https://invalid.test/v1/chat/completions", includeUsage: true });
  const notifications: string[] = [];
  const stored: boolean[] = [];
  platform.system.storyCommitted = async (id) => {
    const node = await game.repo.getNode(id.split(":")[1]);
    stored.push(node?.status === "ok");
    notifications.push(id);
  };
  return { platform, game, notifications, stored };
}
describe("business completion notifications", () => {
  it("retains missing output usage as unknown in the actual game and monthly budget", async () => {
    const partial: Script = [
      { type: "open", status: 200 },
      { type: "data", data: JSON.stringify({ choices: [{ delta: { content: opening.text }, finish_reason: "stop" }], usage: { prompt_tokens: 100 } }) },
      { type: "done" },
    ];
    const { game, platform } = await prepare([partial]);
    await game.createWorld(setup, () => {});
    await game.settled();
    const rows = await platform.sql.query("SELECT prompt_tokens, completion_tokens FROM usage");
    expect(rows).toEqual([{ prompt_tokens: 100, completion_tokens: null }]);
    expect(await monthSpend(platform, { input: 1, output: 1, limit: 1 })).toMatchObject({ calls: 1, unknown: 1, knownCost: null });
  });
  it("only announces persisted opening/turns; failures, edits and reloading do not notify", async () => {
    const { game, notifications, stored } = await prepare([opening, { text: "你翻开旧书。" + RECORD({ time: 5 }) }, failure]);
    const worldId = (await game.createWorld(setup, () => {}))!;
    await game.play(worldId, { mode: "do", text: "翻开旧书" }, () => {}).done;
    await game.play(worldId, { mode: "do", text: "再看一页" }, () => {}).done;
    await game.editState(worldId, { profile: { identity: "书店主人" } }, "改称呼");
    await tree.cursor(game.repo, worldId);
    await game.settled();
    expect(notifications).toHaveLength(2);
    expect(stored).toEqual([true, true]);
  });
  it("does not announce failed opening or an unfinished record", async () => {
    const { game, notifications } = await prepare([failure, opening, { text: "你翻开旧书，还没读完。" }, failure]);
    expect(await game.createWorld(setup, () => {})).toBeNull();
    const worldId = (await game.createWorld(setup, () => {}))!;
    const events: TurnEvent[] = [];
    await game.play(worldId, { mode: "do", text: "翻书" }, (e) => events.push(e)).done;
    await game.settled();
    expect((await tree.cursor(game.repo, worldId)).head.status).toBe("no_record");
    expect(notifications).toHaveLength(1);
  });
  it("preserves successful turns when the OS notification bridge fails", async () => {
    const { game, platform } = await prepare([opening]);
    platform.system.storyCommitted = async () => { throw new Error("permission unavailable"); };
    const worldId = (await game.createWorld(setup, () => {}))!;
    await game.settled();
    expect((await tree.cursor(game.repo, worldId)).head.status).toBe("ok");
  });
});
