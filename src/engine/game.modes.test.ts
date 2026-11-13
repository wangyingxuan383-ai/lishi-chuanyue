import { describe, expect, it } from "vitest";
import { createMemoryPlatform } from "../platform/memory";
import type { Platform } from "../platform";
import { EditRejected, Game } from "./game";
import { modeEditSummary, newChallenge, newScript } from "./modes";
import { fakeLlm, type Script } from "./testing/fakeLlm";
import { sampleState } from "./testing/fixtures";
import * as tree from "./tree";
const LLM = { slot: "fake", url: "https://modes-test.invalid/v1/chat/completions", model: "story", auxModel: "aux", includeUsage: true };
async function prepare(scripts: Script[] = []) {
  const llm = fakeLlm(scripts), platform = await createMemoryPlatform(llm), game = await Game.open(platform, LLM);
  const state = sampleState();
  state.era = { mode: "free", clockStyle: "elapsed", packId: null };
  state.script = newScript({ line: "小吏查清一桩旧案", beats: ["上官交代誊抄名册", "名册里少了一个人", "夜访失踪者的家"], ending: "旧案昭雪" })!;
  state.challenge = newChallenge({ goal: "十日内查出名册缺页的去向", limit: "十日", failIf: "被上官发现私查" }, 0)!;
  const { world } = await game.repo.createWorld({ title: "汴京", eraId: "free", settings: { mode: "free" }, opening: { parentId: null, kind: "opening", narrative: "府衙里灯火昏黄。", state } });
  return { llm, platform, game, worldId: world.id };
}
const messagesOf = (llm: ReturnType<typeof fakeLlm>, i: number) => llm.calls[i].body.messages as { role: string; content: string }[];
const lastUser = (llm: ReturnType<typeof fakeLlm>, i: number) => messagesOf(llm, i).at(-1)!.content;
const usageRows = (platform: Platform) => platform.sql.query("SELECT purpose, model, outcome FROM usage ORDER BY rowid");
describe("script and challenge editing and drafting", () => {
  it("edits the script and the challenge as undoable story edits, refused in the player's words", async () => {
    const { game, worldId } = await prepare([]);
    const before = await tree.cursor(game.repo, worldId);
    const state = await game.repo.getState(before.head.id);
    const script = { ...state.script!, beats: [...state.script!.beats.slice(0, 2), { ...state.script!.beats[2], text: "夜访失踪者的旧宅" }] };
    const summary = modeEditSummary(state, { scriptSet: script });
    expect(summary).toBe("你修改了剧本");
    const edited = await game.editState(worldId, { scriptSet: script }, summary);
    expect(edited.head).toMatchObject({ kind: "edit", actionText: "你修改了剧本" });
    expect((await game.repo.getState(edited.head.id)).script!.beats[2].text).toBe("夜访失踪者的旧宅");
    const undone = await tree.undo(game.repo, edited);
    expect((await game.repo.getState(undone.head.id)).script!.beats[2].text).toBe("夜访失踪者的家");
    const redone = await tree.redo(game.repo, undone);
    expect((await game.repo.getState(redone.head.id)).script!.beats[2].text).toBe("夜访失踪者的旧宅");
    await expect(game.editState(worldId, { scriptSet: { ...script, beats: [] } }, "你修改了剧本")).rejects.toEqual(new EditRejected("剧本至少要有一幕"));
    await expect(game.editState(worldId, { scriptSet: script }, "你修改了剧本")).rejects.toThrow("和现在的内容一样");
    const given = await game.editState(worldId, { challengeSet: { ...state.challenge!, status: "abandoned" } }, "你放弃了挑战");
    expect((await game.repo.getState(given.head.id)).challenge).toMatchObject({ status: "abandoned", endedMinute: 0 });
  });

  it("drafts an outline and a challenge on the auxiliary model, or gives null", async () => {
    const { llm, platform, game } = await prepare([
      { text: JSON.stringify({ line: "查清旧案", beats: ["誊抄名册", " ", "发现缺页", "夜访旧宅"], ending: "昭雪" }) },
      { text: "抱歉，这个我帮不了。" },
      [{ type: "error", kind: "http", status: 401, message: "test" }],
      { text: JSON.stringify({ goal: "十日内查出缺页的去向", limit: "十日", failIf: "" }) },
      { text: JSON.stringify({ limit: "十日" }) },
    ]);
    const current = { mode: "free" as const, premise: "汴京，开封府。", name: "沈默", script: { line: "查清旧案", beats: ["誊抄名册"] } };
    expect(await game.draftScript(current)).toEqual({ line: "查清旧案", beats: ["誊抄名册", "发现缺页", "夜访旧宅"], ending: "昭雪" });
    expect(lastUser(llm, 0)).toContain("故事设定：汴京，开封府。");
    expect(lastUser(llm, 0)).toContain("主线：查清旧案\n已写的幕：\n1. 誊抄名册");
    expect(llm.calls[0].body.model).toBe("aux");
    expect(await game.draftScript({})).toBeNull();
    expect(await game.draftScript({})).toBeNull();
    expect(await game.draftChallenge({ premise: "汴京" })).toEqual({ goal: "十日内查出缺页的去向", limit: "十日", failIf: "" });
    expect(messagesOf(llm, 3)[0].content).toContain("出一个开局挑战");
    expect(await game.draftChallenge({})).toBeNull();
    expect(await usageRows(platform)).toEqual([
      { purpose: "outline", model: "aux", outcome: "ok" },
      { purpose: "outline", model: "aux", outcome: "no_record" },
      { purpose: "outline", model: "aux", outcome: "failed" },
      { purpose: "challenge", model: "aux", outcome: "ok" },
      { purpose: "challenge", model: "aux", outcome: "no_record" },
    ]);
  });
});
