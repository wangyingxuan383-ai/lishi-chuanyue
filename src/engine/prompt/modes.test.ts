import { describe, expect, it } from "vitest";
import { eraContext } from "../era";
import { sampleState } from "../testing/fixtures";
import { newChallenge } from "../modes";
import { DEFAULT_SETTINGS, type Challenge, type Script, type ScriptBeat, type StoryNode, type WorldSettings, type WorldState } from "../types";
import { assistMessages, extractMessages, openingExtractMessages, openingMessages, turnMessages, type OpeningInput, type TurnPromptInput } from "./turn";

const node = (id: string, kind: StoryNode["kind"], actionMode: StoryNode["actionMode"], actionText: string | null, narrative: string) =>
  ({ id, kind, actionMode, actionText, narrative } as StoryNode);

function historyState(): WorldState {
  const state = sampleState();
  state.time.elapsedMinutes = 600;
  state.places = [{ id: "p1", name: "西市旁邸店", description: "" }];
  state.placeId = "p1";
  state.people = [{ id: "a", name: "王掌柜", aliases: [], role: "邸店掌柜", attitude: "冷淡", alive: true, notes: "催讨房钱九十文", lastSeenMinute: 30 }];
  state.goals = [{ id: "g", name: "三日内付清房钱", kind: "主线", progress: "已付三十文", status: "进行中" }];
  state.protagonist.items = [{ name: "旧书", quantity: 3, unit: "卷", place: null, note: "" }];
  state.protagonist.statuses = [{ name: "风寒", detail: "有些头疼", sinceMinute: 0 }];
  return state;
}

function freeState(): WorldState {
  const state = historyState();
  state.era = { mode: "free", clockStyle: "elapsed", packId: null, currency: { units: [{ name: "银币", value: 100 }, { name: "铜币", value: 1 }] } };
  state.protagonist.panel = "剑术：入门";
  return state;
}

const HISTORY = [node("o", "opening", null, null, "你醒来，屋里很冷。王掌柜在门外催房钱。"), node("t1", "turn", "do", "开门见掌柜", "王掌柜叉着腰站在廊下。")];
const FREE_SETTINGS: WorldSettings = { ...DEFAULT_SETTINGS, mode: "free", clockStyle: "elapsed", heroPanelEnabled: true, premise: "浮空群岛，飞艇往来。", essentials: "主角怕高", rules: "多写对话" };

function turn(state: WorldState, settings: WorldSettings, overrides: Partial<TurnPromptInput> = {}): TurnPromptInput {
  return { state, era: eraContext(state.era.mode === "free" ? "free" : "tang-748", state), settings, protagonistName: "李安", history: HISTORY, mode: "do", text: "问问掌柜能否宽限", ...overrides };
}

function opening(state: WorldState, settings: WorldSettings, overrides: Partial<OpeningInput> = {}): OpeningInput {
  return { era: eraContext(state.era.mode === "free" ? "free" : "tang-748", state), settings, protagonistName: "李安", protagonist: { name: "李安", gender: "男", age: 22, identity: "落第举子" }, arrival: "魂穿", origin: "历史系研究生", hint: "邸店里醒来", ...overrides };
}

/** Requests for worlds without any play mode, as turn-17 built them. */
function ordinaryRequests() {
  const history = { ...DEFAULT_SETTINGS, premise: "天宝七载，长安。", essentials: "主角知道安史之乱将至", directive: "多写市井", fortune: "on" as const };
  const h = historyState();
  const f = freeState();
  return {
    historyDo: turnMessages(turn(h, history, { directorNote: "让掌柜心软一点", notes: ["上回合钱不够，这笔没付成"], fortune: "不顺", pins: ["王掌柜是舅舅"] })),
    historySay: turnMessages(turn(h, history, { mode: "say", text: "掌柜，再宽限两日" })),
    historyContinue: turnMessages(turn(h, history, { mode: "continue", text: "" })),
    historyDirect: turnMessages(turn(h, history, { mode: "direct", text: "让一个陌生人来敲门" })),
    historyWrite: turnMessages(turn(h, history, { mode: "write", text: "你把旧书卖了五十文。" })),
    historySkip: turnMessages(turn(h, history, { mode: "skip", text: "过一个月；这段时间照常过日子" })),
    noChoices: turnMessages(turn(h, { ...history, choiceCount: 0 })),
    freeDo: turnMessages(turn(f, FREE_SETTINGS)),
    freeContinue: turnMessages(turn(f, FREE_SETTINGS, { mode: "continue", text: "" })),
    historyOpening: openingMessages(opening(h, history)),
    freeOpening: openingMessages(opening(f, FREE_SETTINGS, { arrival: "不穿越", origin: "" })),
    playerOpening: openingExtractMessages({ ...opening(h, history), text: "我在邸店醒来。" }),
    extract: extractMessages({ era: eraContext("tang-748", h), state: h, action: "开门", narrative: "你开了门。", settings: history }),
    assist: assistMessages("唐朝书生", { mode: "history", name: "李安" }),
  };
}

const DAY = 1440;
const system = (messages: { content: string }[]) => messages[0].content;
const user = (messages: { content: string }[]) => messages[messages.length - 1].content;

function scripted(statuses: ScriptBeat["status"][] = ["todo", "todo", "todo"], steer: Script["steer"] = "gentle"): Script {
  const texts = ["邸店掌柜催讨房钱", "夜探城隍庙，发现密道", "真相大白，名动西市"];
  return { line: "书生闯长安", ending: "还清旧债", steer, beats: texts.map((text, i) => ({ id: `b${i}`, text, status: statuses[i] })) };
}

const challenged = (at = 0, extra: Partial<Challenge> = {}) => ({ ...newChallenge({ goal: "凑够三百两", limit: "十日", failIf: "被告到官府" }, 0)!, ...extra });

function withModes(script: Script | null, challenge: Challenge | null, at = 0): WorldState {
  const state = historyState();
  state.time.elapsedMinutes = at;
  if (script) state.script = script;
  if (challenge) state.challenge = challenge;
  return state;
}

const HISTORY_SETTINGS: WorldSettings = { ...DEFAULT_SETTINGS, premise: "天宝七载，长安。" };

describe("turn-18 play modes", () => {
  it("leaves every request of a world without play modes as recorded", async () => {
    // Recorded from the turn-17 code before the play modes were added; it changes only on purpose (vitest -u):
    // turn-19 dropped the unclear 来源以玩家设定为准 from the 魂穿 line, the engine review the assistant's gender line.
    await expect(JSON.stringify(ordinaryRequests(), null, 1)).toMatchFileSnapshot("./__fixtures__/ordinary-requests.json");
  });

  it("treats “我来演”, no script and a challenge that has ended as no mode at all", () => {
    const plain = turnMessages(turn(historyState(), HISTORY_SETTINGS));
    expect(turnMessages(turn(historyState(), { ...HISTORY_SETTINGS, pilot: "player" }))).toEqual(plain);
    for (const status of ["won", "lost", "abandoned"] as const) {
      expect(turnMessages(turn(withModes(null, challenged(0, { status, endedMinute: 600 }), 600), HISTORY_SETTINGS))).toEqual(plain);
    }
    const state = historyState();
    Object.assign(state, { script: null, challenge: null });
    expect(turnMessages(turn(state, HISTORY_SETTINGS))).toEqual(plain);
  });

  it("gives the script's played beats by title, the beat to play now and what comes after", () => {
    const messages = turnMessages(turn(withModes(scripted(["done", "todo", "todo"]), null), HISTORY_SETTINGS));
    const text = user(messages);
    expect(text).toContain("【剧本】（玩家定的骨架）\n主线：书生闯长安\n已演完：邸店掌柜催讨房钱\n这一幕：夜探城隍庙，发现密道\n之后：真相大白，名动西市\n想要的结局：还清旧债");
    expect(text).toContain("主角怎么应对仍由玩家决定；玩家没往这一幕走时，只让苗头出现，不替主角行动，也不跳过时间去凑这一幕；之后几幕先不写");
    expect(text).toContain('"beat":"done"');
    expect(text).not.toContain("引回这一幕");
    expect(system(messages)).toContain(' "beat":当前这一幕的关键事件已在本段正文发生时写 "done"，否则不写,\n "choices"');
    // The script sits with the player's own direction, before the program's notes and the action.
    expect(text.indexOf("【剧本】")).toBeLessThan(text.indexOf("【玩家行动】"));
    const firm = user(turnMessages(turn(withModes(scripted(["skipped", "todo", "done"], "firm"), null), HISTORY_SETTINGS)));
    expect(firm).toContain("这一幕：夜探城隍庙，发现密道");
    expect(firm).toContain("已演完：真相大白");
    expect(firm).not.toContain("之后：");
    expect(firm).not.toContain("邸店掌柜催讨房钱");
    expect(firm).toContain("故事偏离时，用情理之中的人和事把它引回这一幕。");
  });

  it("says the script is over once every beat is played, without the beat field", () => {
    const messages = turnMessages(turn(withModes(scripted(["done", "skipped", "done"]), null), HISTORY_SETTINGS));
    expect(user(messages)).toContain("\n【剧本】剧本已演完，之后按玩家的行动自由发展。");
    expect(user(messages)).not.toContain("这一幕：");
    expect(system(messages)).not.toContain('"beat"');
  });

  it("puts the challenge's goal, time left, failure and progress before the narrator", () => {
    const messages = turnMessages(turn(withModes(null, challenged(0, { progress: "已凑得八十两" }), 3.5 * DAY), HISTORY_SETTINGS));
    const text = user(messages);
    expect(text).toContain("【挑战】凑够三百两\n期限：十日（还剩 6 天）\n失败条件：被告到官府\n最近进展：已凑得八十两\n难处是真实的，不放水也不刻意刁难");
    expect(text).toContain('"result":"won"');
    expect(system(messages)).toContain(' "challenge":{"progress":"挑战的现状，一句话"');
    const open = user(turnMessages(turn(withModes(null, newChallenge({ goal: "活下去", limit: "", failIf: "" }, 0)), HISTORY_SETTINGS)));
    expect(open).toContain("【挑战】活下去\n期限：不限时\n难处");
    const vague = user(turnMessages(turn(withModes(null, newChallenge({ goal: "活下去", limit: "秋收前", failIf: "" }, 0)), HISTORY_SETTINGS)));
    expect(vague).toContain("期限：秋收前\n");
  });

  it("lets the narrator play the protagonist when the player directs, in history and free worlds", () => {
    for (const settings of [{ ...HISTORY_SETTINGS, pilot: "ai" as const }, { ...FREE_SETTINGS, pilot: "ai" as const }]) {
      const state = settings.mode === "free" ? freeState() : historyState();
      const directed = turnMessages(turn(state, settings, { mode: "direct", text: "让一个陌生人来敲门" }));
      expect(system(directed)).toContain("主角和其他人物都由你来演，玩家在幕后指点。");
      expect(system(directed)).toContain("- 主角由你来演：照他的性格、处境和目标，自己决定此刻说什么、做什么；每段只往前推一小步，在有意思的地方停下；【幕后】是导演的安排，不是主角说的话。");
      expect(system(directed)).not.toContain("主角只做玩家写下或已开始的事");
      expect(system(directed)).toContain("记录里给 2～3 个“接下来可以怎样发展”的短句");
      expect(system(directed)).toContain(' "choices":["接下来的一种走向","另一种走向"]}');
      expect(user(directed)).toContain("\n\n【幕后】让一个陌生人来敲门\n照这个安排往下演，正文里不提这条安排。");
      const continued = turnMessages(turn(state, settings, { mode: "continue", text: "" }));
      expect(user(continued)).toContain("\n\n【继续】接着往下演，主角照自己的性格和打算行动。");
      // Earlier turns read the same way in the window.
      const window = turnMessages(turn(state, settings, { history: [...HISTORY, node("t2", "turn", "direct", "让雪下大些", "雪越下越大。")] }));
      expect(window.some((m) => m.role === "user" && m.content === "【幕后】让雪下大些\n照这个安排往下演，正文里不提这条安排。")).toBe(true);
    }
    const none = turnMessages(turn(historyState(), { ...HISTORY_SETTINGS, pilot: "ai", choiceCount: 0 }));
    expect(system(none)).toContain("记录里的 choices 写空数组 []");
    const scriptedAi = user(turnMessages(turn(withModes(scripted(), null), { ...HISTORY_SETTINGS, pilot: "ai" })));
    expect(scriptedAi).toContain("主角照自己的性格应对");
    expect(user(turnMessages(turn(withModes(scripted(["done", "done", "done"]), null), { ...HISTORY_SETTINGS, pilot: "ai" })))).toContain("【剧本】剧本已演完，之后自由发展。");
  });

  it("opens with the script's first beat and the challenge in front of the protagonist", () => {
    const script = scripted();
    const challenge = challenged();
    for (const settings of [HISTORY_SETTINGS, FREE_SETTINGS]) {
      const state = settings.mode === "free" ? freeState() : historyState();
      const messages = openingMessages(opening(state, settings, { script, challenge }));
      const text = user(messages);
      expect(text).toContain("玩家希望开场：邸店里醒来\n【剧本】（玩家定的骨架）\n主线：书生闯长安\n这一幕：邸店掌柜催讨房钱");
      expect(text).toContain("【挑战】凑够三百两\n期限：十日（还剩 10 天）");
      expect(text).toContain("开场就把这场挑战摆到主角面前：目标、期限和眼下最大的难处，要让玩家一读就清楚。\n从符合玩家设定的具体场景写起，写到需要玩家决定为止。");
      expect(system(messages)).toContain('"beat"');
      expect(system(messages)).toContain('"challenge"');
    }
    const watched = openingMessages(opening(historyState(), { ...HISTORY_SETTINGS, pilot: "ai" }));
    expect(user(watched)).toContain("从符合玩家设定的具体场景写起，写到一个有意思的地方停下。");
    expect(system(watched)).toContain("主角由你来演");
    // The player's own opening and the 补记 keep their requests.
    const extract = extractMessages({ era: eraContext("tang-748", historyState()), state: withModes(script, challenge), action: "开门", narrative: "你开了门。", settings: HISTORY_SETTINGS });
    expect(promptOf(extract)).not.toMatch(/【剧本】|【挑战】|"beat"/);
  });
});

const promptOf = (messages: { content: string }[]) => messages.map((m) => m.content).join("\n");
