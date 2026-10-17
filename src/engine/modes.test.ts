import { describe, expect, it } from "vitest";
import { TANG_CURRENCY } from "./money";
import {
  beatTitle, challengeView, checkChallenge, checkScript, deadlineOf, modeEditSummary, newBeat, newChallenge, newScript, scriptProgress,
} from "./modes";
import { normalizeRecord } from "./record/parse";
import { applyRecord, type TurnRecord } from "./state/apply";
import { sampleState } from "./testing/fixtures";
import type { ActionMode, Script, WorldState } from "./types";

const DAY = 1440;
const play = (s: WorldState, r: TurnRecord | null, mode: ActionMode = "do") => applyRecord(s, r, { mode, difficulty: "标准", currency: TANG_CURRENCY });
const edit = (s: WorldState, r: TurnRecord) => applyRecord(s, r, { mode: "do", difficulty: "标准", currency: TANG_CURRENCY }, { advanceTime: false });
const texts = (r: { chips: { text: string }[] }) => r.chips.map((c) => c.text);

function withModes(at = 0): WorldState {
  const s = sampleState();
  s.time.elapsedMinutes = at;
  s.script = newScript({ line: "书生闯长安", beats: ["邸店掌柜催讨房钱", "夜探城隍庙，发现密道", "真相大白"], ending: "还清旧债" })!;
  s.challenge = newChallenge({ goal: "凑够三百两", limit: "十日", failIf: "被告到官府" }, 0)!;
  return s;
}

describe("play mode helpers", () => {
  it("reads limits as spans from the start, and keeps unreadable words without a deadline", () => {
    expect(deadlineOf("三个月", 0)).toBe(90 * DAY);
    expect(deadlineOf("十日", 100)).toBe(100 + 10 * DAY);
    expect(deadlineOf("半年", 0)).toBe(182.5 * DAY);
    expect(deadlineOf("一年", 0)).toBe(365 * DAY);
    for (const words of ["", "  ", "到年底", "30", "不限时"]) expect(deadlineOf(words, 0)).toBeNull();
    expect(newChallenge({ goal: " 凑够三百两 ", limit: "到年底", failIf: "" }, 0)).toEqual({
      goal: "凑够三百两", limit: "到年底", deadlineMinute: null, failIf: "", progress: "", status: "active", startedMinute: 0,
    });
    expect(newChallenge({ goal: " ", limit: "十日", failIf: "" }, 0)).toBeNull();
  });

  it("builds a script from an outline, dropping empty lines and beats past the twelfth", () => {
    const script = newScript({ line: " 主线 ", beats: ["一", " ", ...Array.from({ length: 13 }, (_, i) => `第${i + 2}件事`)], ending: "", steer: "firm" })!;
    expect(script.beats).toHaveLength(12);
    expect(script.beats[0]).toMatchObject({ text: "一", status: "todo" });
    expect(new Set(script.beats.map((b) => b.id)).size).toBe(12);
    expect(script).toMatchObject({ line: "主线", ending: "", steer: "firm" });
    expect(newScript({ line: "主线", beats: ["", " "], ending: "" })).toBeNull();
    expect(newScript({ line: "", beats: ["一"], ending: "" })!.steer).toBe("gentle");
  });

  it("shows where the script stands, with the current beat first still to play", () => {
    const s = withModes();
    expect(scriptProgress(sampleState())).toBeNull();
    expect(scriptProgress(s)).toMatchObject({ index: 1, total: 3, finished: false, current: { text: "邸店掌柜催讨房钱" } });
    s.script!.beats[0].status = "skipped";
    s.script!.beats[2].status = "done";
    expect(scriptProgress(s)).toMatchObject({ index: 2, total: 3, current: { text: "夜探城隍庙，发现密道" } });
    s.script!.beats[1].status = "done";
    expect(scriptProgress(s)).toEqual({ index: 3, total: 3, current: null, finished: true });
    expect(beatTitle("夜探城隍庙，发现密道")).toBe("夜探城隍庙");
    expect(beatTitle("一")).toBe("一");
    expect(beatTitle("从长安出发一路向西走到敦煌再折返回来")).toBe("从长安出发一路向西走到敦煌再折返…");
  });

  it("gives the banner, page and end card what they show", () => {
    const s = withModes(3.5 * DAY);
    expect(challengeView(sampleState())).toBeNull();
    expect(challengeView(s)).toMatchObject({ active: true, goal: "凑够三百两", remainingMinutes: 6.5 * DAY, remaining: "还剩 6 天", outcome: "", days: 4, turns: 0 });
    s.time.elapsedMinutes = 10 * DAY - 60;
    expect(challengeView(s)!.remaining).toBe("还剩不到一天");
    s.challenge = { ...s.challenge!, status: "won", endedMinute: 2 * DAY, outcome: "凑够了", turns: 7 };
    expect(challengeView(s)).toMatchObject({ active: false, remaining: "", remainingMinutes: null, outcome: "凑够了", days: 2, turns: 7 });
    s.challenge = newChallenge({ goal: "活下去", limit: "", failIf: "" }, 0);
    expect(challengeView(s)).toMatchObject({ remaining: "不限时", remainingMinutes: null });
  });

  it("says what a panel edit did in the player's words", () => {
    const s = withModes();
    const none = sampleState();
    expect(modeEditSummary(none, { scriptSet: s.script })).toBe("你加了一个剧本");
    expect(modeEditSummary(s, { scriptSet: s.script })).toBe("你修改了剧本");
    expect(modeEditSummary(s, { scriptSet: null })).toBe("你删掉了剧本");
    expect(modeEditSummary(s, { challengeSet: { ...s.challenge!, status: "abandoned" } })).toBe("你放弃了挑战");
    expect(modeEditSummary(s, { challengeSet: { ...s.challenge!, goal: "凑够五百两" } })).toBe("你修改了挑战");
    expect(modeEditSummary(none, { challengeSet: s.challenge })).toBe("你加了一个挑战");
    expect(modeEditSummary(s, { challengeSet: null, scriptSet: null })).toBe("你删掉了剧本；你删掉了挑战");
  });

  it("checks scripts and challenges from panels and files", () => {
    expect(checkScript({ beats: [{ text: " 甲 ", status: "done", endedMinute: 5 }, { text: "" }, { id: "b", text: "乙" }] })).toEqual({
      line: "", ending: "", steer: "gentle",
      beats: [{ id: expect.any(String), text: "甲", status: "done", endedMinute: 5 }, { id: "b", text: "乙", status: "todo" }],
    });
    expect(checkScript({ beats: [] })).toBe("剧本至少要有一幕");
    expect(checkScript({ beats: Array.from({ length: 13 }, () => ({ text: "事" })) })).toBe("剧本最多 12 幕");
    expect(checkScript({ beats: [{ text: "甲", status: "演完" }] })).toBe("剧本的内容不完整");
    expect(checkScript("剧本")).toBe("剧本的内容不完整");
    const c = newChallenge({ goal: "凑钱", limit: "十日", failIf: "" }, 60)!;
    expect(checkChallenge({ ...c, deadlineMinute: 5, limit: "三天" })).toMatchObject({ deadlineMinute: 60 + 3 * DAY });
    expect(checkChallenge({ ...c, goal: " " })).toBe("挑战要有一个目标");
    expect(checkChallenge({ ...c, status: "paused" })).toBe("挑战的内容不完整");
    expect(checkChallenge({ ...c, startedMinute: -1 })).toBe("挑战的内容不完整");
  });
});

describe("play mode ledger", () => {
  it("marks the current beat played, one at a time, and ignores beats with none left", () => {
    const first = play(withModes(), { beat: "done" });
    expect(first.state.script!.beats.map((b) => b.status)).toEqual(["done", "todo", "todo"]);
    expect(first.state.script!.beats[0].endedMinute).toBe(15);
    expect(texts(first)).toContain("📜 第 1 幕演完：邸店掌柜催讨房钱");
    const second = play(first.state, { beat: "done" });
    expect(texts(second)).toContain("📜 第 2 幕演完：夜探城隍庙");
    const s = withModes();
    s.script!.beats.forEach((b) => { b.status = "done"; });
    const over = play(s, { beat: "done" });
    expect(over.state.script).toEqual(s.script);
    expect(over.log).toContain("没有正在演的一幕，beat 已忽略");
    expect(play(sampleState(), { beat: "done" }).log).toContain("没有正在演的一幕，beat 已忽略");
  });

  it("moves the challenge on, ends it on a result, and ignores news after the end", () => {
    const moved = play(withModes(), { challenge: { progress: "已凑得八十两" } });
    expect(moved.state.challenge).toMatchObject({ status: "active", progress: "已凑得八十两", turns: 1 });
    expect(texts(moved)).toContain("⚑ 挑战进展：已凑得八十两");
    expect(texts(play(moved.state, { challenge: { progress: "已凑得八十两" } }))).not.toContain("⚑ 挑战进展：已凑得八十两");
    const won = play(moved.state, { challenge: { progress: "凑够了三百两", result: "won" } });
    expect(won.state.challenge).toMatchObject({ status: "won", progress: "凑够了三百两", outcome: "凑够了三百两", endedMinute: 30, turns: 2 });
    expect(texts(won)).toContain("⚑ 挑战成功");
    expect(texts(won).some((t) => t.startsWith("⚑ 挑战进展"))).toBe(false);
    const after = play(won.state, { challenge: { progress: "又多了十两", result: "lost" } });
    expect(after.state.challenge).toEqual(won.state.challenge);
    expect(after.log).toContain("没有进行中的挑战，记录里的挑战进展已忽略");
    const lost = play(withModes(), { challenge: { result: "lost", why: "债主告到了官府" } });
    expect(lost.state.challenge).toMatchObject({ status: "lost", outcome: "债主告到了官府" });
    expect(texts(lost)).toContain("⚑ 挑战失败：债主告到了官府");
  });

  it("ends the challenge when its time runs out, after any turn and a skip too", () => {
    const skipped = play(withModes(), { time: "一个月" }, "skip");
    expect(skipped.state.challenge).toMatchObject({ status: "lost", outcome: "期限已到", endedMinute: 10 * DAY, turns: 1 });
    expect(texts(skipped)).toContain("⚑ 挑战失败：期限已到");
    const silent = play(withModes(10 * DAY - 10), null);
    expect(silent.state.challenge!.status).toBe("lost");
    const won = play(withModes(10 * DAY - 10), { challenge: { result: "won", why: "最后一刻凑齐" } });
    expect(won.state.challenge).toMatchObject({ status: "won", outcome: "最后一刻凑齐" });
    expect(play(withModes(), { time: "九天" }).state.challenge!.status).toBe("active");
    const open = withModes();
    open.challenge = newChallenge({ goal: "活下去", limit: "", failIf: "" }, 0);
    expect(play(open, { time: "一年" }).state.challenge!.status).toBe("active");
  });

  it("takes whole scripts and challenges from panel edits only", () => {
    const s = withModes();
    const script: Script = { ...s.script!, beats: [{ ...s.script!.beats[0], status: "done" }, ...s.script!.beats.slice(1)] };
    const fromStory = play(s, { scriptSet: script, challengeSet: null });
    expect(fromStory.state.script).toEqual(s.script);
    expect(fromStory.state.challenge!.status).toBe("active");
    expect(fromStory.log).toEqual(expect.arrayContaining(["剧本只能在剧本页修改，记录里的修改已忽略", "挑战只能在挑战页修改，记录里的修改已忽略"]));
    const edited = edit(s, { scriptSet: script });
    expect(edited.state.script!.beats[0]).toMatchObject({ status: "done", endedMinute: 0 });
    expect(edited.log).toEqual([]);
    expect(edit(s, { scriptSet: null }).state).not.toHaveProperty("script");
    expect(edit(s, { scriptSet: { ...script, beats: [] } }).log).toEqual(["剧本至少要有一幕"]);
  });

  it("recomputes an edited deadline, refuses one already past and dates a challenge given up", () => {
    const s = withModes(5 * DAY);
    const longer = edit(s, { challengeSet: { ...s.challenge!, limit: "一个月" } });
    expect(longer.state.challenge!.deadlineMinute).toBe(30 * DAY);
    expect(edit(s, { challengeSet: { ...s.challenge!, limit: "三天" } }).log).toEqual(["这个期限已经过了"]);
    const vague = edit(s, { challengeSet: { ...s.challenge!, limit: "秋收前" } });
    expect(vague.state.challenge).toMatchObject({ limit: "秋收前", deadlineMinute: null });
    expect(vague.log).toEqual(["期限“秋收前”无法换算，按不限时处理"]);
    const given = edit(s, { challengeSet: { ...s.challenge!, status: "abandoned" } });
    expect(given.state.challenge).toMatchObject({ status: "abandoned", endedMinute: 5 * DAY });
    // An abandoned challenge no longer counts down, takes news or ends on time.
    expect(play(given.state, { time: "一个月", challenge: { progress: "又凑了些" } }).state.challenge).toEqual(given.state.challenge);
    expect(edit(s, { challengeSet: null }).state).not.toHaveProperty("challenge");
  });

  it("reads the model's mode fields leniently, and never a panel replacement", () => {
    expect(normalizeRecord({ beat: "done", challenge: { progress: " 有了眉目 ", result: "WON", why: "凑齐了" } })).toMatchObject({
      beat: "done", challenge: { progress: "有了眉目", result: "won", why: "凑齐了" },
    });
    expect(normalizeRecord({ beat: true, challenge: "有了眉目" })).toMatchObject({ beat: "done", challenge: { progress: "有了眉目" } });
    const ignored = normalizeRecord({ beat: "no", challenge: { result: "draw" }, scriptSet: null, challengeSet: { goal: "x" } })!;
    expect(ignored).not.toHaveProperty("beat");
    expect(ignored).not.toHaveProperty("challenge");
    expect(ignored).not.toHaveProperty("scriptSet");
    expect(ignored).not.toHaveProperty("challengeSet");
  });

  it("leaves ordinary worlds exactly as before", () => {
    const s = sampleState();
    const r = play(s, { time: "一个月", log: "过了一个月", choices: ["甲"] }, "skip");
    expect(r.state).not.toHaveProperty("script");
    expect(r.state).not.toHaveProperty("challenge");
    expect(texts(r).some((t) => t.includes("挑战") || t.includes("幕"))).toBe(false);
    expect(newBeat(" 甲 ")).toMatchObject({ text: "甲", status: "todo" });
  });
});
