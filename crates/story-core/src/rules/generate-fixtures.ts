// Refresh the narrow migration oracle from the existing TypeScript rules.
// Run with `pnpm exec tsx crates/story-core/src/rules/generate-fixtures.ts`.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyRecord, type TurnRecord } from "../../../../src/engine/state/apply";
import { sampleState } from "../../../../src/engine/testing/fixtures";
import { parseRecord } from "../../../../src/engine/record/parse";
import { parseDurationMinutes } from "../../../../src/engine/calendar/duration";
import { parseDateLabel } from "../../../../src/engine/calendar/date";
import { nowOf, type GameClock } from "../../../../src/engine/calendar/clock";
import { TANG_CURRENCY, parseMoney } from "../../../../src/engine/money";
import type { WorldState } from "../../../../src/engine/types";

const fixtures: unknown[] = [];
const rules = { lunar: true, eras: [{ name: "天宝", startCe: 742, yearWord: "载" }, { name: "至德", startCe: 756, startMonth: 7, yearWord: "载" }] };
const clock: GameClock = { date: { era: "天宝", year: 7, month: 12, day: 29, ceYear: 748, lunar: true }, hour: 8, label: "", rules };
const ctx = { mode: "do" as const, difficulty: "标准" as const, currency: TANG_CURRENCY, clock };
function apply(name: string, record: TurnRecord | null, change?: (s: WorldState) => void, options: Record<string, unknown> = {}) {
  const state = sampleState(300); change?.(state);
  const input = { ...ctx, ...options } as typeof ctx & { advanceTime?: boolean };
  const expected = applyRecord(state, record, input, { advanceTime: input.advanceTime });
  fixtures.push({ name, kind: "apply", state, record, options: input, expected });
}
apply("action default", {});
apply("missing record", null, undefined, { mode: "continue" });
apply("invalid duration", { time: "太阳下山" });
apply("short skip stops", { time: "十几息", hour: 7 }, undefined, { mode: "skip", asked: 43200 });
apply("skip aligns final hour", { time: "两天", hour: 6 }, undefined, { mode: "skip", asked: 2880 });
apply("dated age and timeline", { time: "一天" }, (s) => { s.timeline = [{ id: "event1", date: "天宝八载正月", atMinute: 960, title: "改元", kind: "可变" }]; });
apply("free world keeps history untouched", { time: "一年", deviation: "改史", timeline: [{ op: "add", date: "天宝九载", title: "不进入" }] }, (s) => { s.era.mode = "free"; s.era.calendar = rules; });
apply("history deviation dated", { deviation: "天子亲征", time: "一天" });
apply("timeline adds unknown and known", { timeline: [{ op: "add", date: "至德元载七月", title: "新事", ceYear: 756 }, { op: "add", date: "某年", title: "未知" }] });
apply("fortune and place", { place: "长安西市", risk: { what: "跃墙", result: "半成" } }, undefined, { fortune: "顺" });
apply("paid goods", { money: -6, items: [{ name: "胡饼", delta: 2 }] });
apply("unpaid goods", { money: -1000, items: [{ name: "胡饼", delta: 2 }, { name: "礼物", delta: 1 }] });
apply("easy debt", { money: -1000, items: [{ name: "胡饼", delta: 2 }] }, undefined, { difficulty: "宽松" });
apply("duplicate currency", { money: "三贯", items: [{ name: "开元通宝", delta: 3000 }, { name: "贯", delta: 3 }, { name: "通宝剑", delta: 1 }] });
apply("item subtraction and movement", { items: [{ name: "旧书", delta: -8 }, { name: "布衣", delta: 0, place: "家" }, { name: "刀", delta: -1 }] }, (s) => { s.protagonist.items = [{ name: "旧书", quantity: 2, unit: "本", place: null, note: "" }, { name: "布衣", quantity: 1, unit: "件", place: null, note: "" }]; });
apply("stat cap and standard dying", { stats: { health: -1000, energy: 41.5, fame: -8.5 } }, (s) => { s.protagonist.stats.health = 10; });
apply("dying hangs on", { stats: { health: -100 } }, (s) => { s.protagonist.stats.health = 1; s.protagonist.statuses = [{ name: "垂危", detail: "伤", sinceMinute: 0 }]; });
apply("dying written death", { died: true }, (s) => { s.protagonist.stats.health = 1; s.protagonist.statuses = [{ name: "垂危", detail: "伤", sinceMinute: 0 }]; });
apply("easy ignores written death", { died: true }, undefined, { difficulty: "宽松" });
apply("cruel death", { stats: { health: -40 } }, (s) => { s.protagonist.stats.health = 10; }, { difficulty: "残酷" });
apply("dying recovery", { stats: { health: 40 } }, (s) => { s.protagonist.stats.health = 1; s.protagonist.statuses = [{ name: "垂危", detail: "伤", sinceMinute: 0 }]; });
apply("people aliases and origin", { people: [{ name: "刘三郎", aliases: ["货栈管事"], note: "暗中送粮", attitude: "友善" }, { name: "孙掌柜", note: "相见" }] }, (s) => { s.people = [{ id: "p1", name: "货栈管事", aliases: [], role: "管事", attitude: "一般", alive: true, notes: "早年相救", lastSeenMinute: 0 }, { id: "p2", name: "孙管事", aliases: [], role: "管事", attitude: "一般", alive: true, notes: "", lastSeenMinute: 0 }]; });
apply("history dead cannot revive", { people: [{ name: "张三", alive: true }] }, (s) => { s.people = [{ id: "p1", name: "张三", aliases: [], role: "", attitude: "一般", alive: false, notes: "", lastSeenMinute: 0 }]; });
apply("status cap protects dying", { status: [{ op: "add", name: "淤伤", detail: "青紫" }] }, (s) => { s.protagonist.statuses = Array.from({ length: 12 }, (_, i) => ({ name: i === 0 ? "垂危" : `旧状况${i}`, detail: "", sinceMinute: i })); });
apply("goals record steps", { goals: [{ op: "done", name: "还清三贯钱的债", detail: "还清" }, { op: "add", name: "安居", kind: "心愿", detail: "找屋" }] }, (s) => { s.goals = [{ id: "g1", name: "还清三贯钱", kind: "支线", progress: "欠三贯", status: "进行中", steps: [] }]; });
apply("panel profile and items", { profile: { name: "李平", age: 121, identity: "士子", panel: "保留\n原文" }, setStats: { money: 555, health: 110 }, items: [{ name: "书", set: { name: "旧书", quantity: 2, unit: "卷", place: "家", note: "故物" } }] }, undefined, { advanceTime: false });
apply("panel source and rename person", { sourceSet: { bookId: "book1", fanfic: true, plot: "canon", through: 2, position: 1, instructions: "核对原著", method: "search" }, people: [{ id: "p1", name: "张四", aliases: ["张兄"], note: "近况", origin: "", attitude: "友善" }] }, (s) => { s.people = [{ id: "p1", name: "张三", aliases: [], role: "旧友", attitude: "一般", alive: true, notes: "旧事", origin: "身世", lastSeenMinute: 0 }]; }, { advanceTime: false });
apply("rules currency and retime", { rules: { currency: [{ name: "两", value: 1000 }, { name: "文", value: 1 }], lunar: true, date: { era: "天宝", year: 9, month: 1, day: 1 } } }, (s) => { s.era.calendar = rules; s.timeline = [{ id: "e1", date: "天宝十载三月", atMinute: 123, title: "史事", kind: "固定" }]; }, { advanceTime: false });
apply("invalid currency order", { rules: { currency: [{ name: "文", value: 1 }, { name: "两", value: 1000 }] } }, undefined, { advanceTime: false });
apply("card edits", { cards: [{ op: "update", id: "c1", name: "新名", keys: ["别称", "新名"], content: " 新内容 " }, { op: "remove", id: "c2" }, { op: "add", kind: "势力", name: "帮会", keys: ["帮", "帮"], content: "势力" }] }, (s) => { s.cards = [{ id: "c1", kind: "物品", name: "旧名", keys: ["旧"], content: "旧内容" }, { id: "c2", kind: "设定", name: "删去", keys: [], content: "" }]; }, { advanceTime: false });
apply("place edits protect current", { places: [{ op: "remove", id: "home" }, { op: "update", id: "other", name: "新坊", aliases: ["坊"], description: "新地" }, { op: "add", name: "郊外" }] }, (s) => { s.placeId = "home"; s.places = [{ id: "home", name: "家", description: "" }, { id: "other", name: "旧坊", description: "" }]; }, { advanceTime: false });
apply("script and challenge advance", { beat: "done", challenge: { progress: "找到线索" } }, (s) => { s.script = { line: "探案", beats: [{ id: "b1", text: "查访故人，寻找线索", status: "todo" }], ending: "", steer: "gentle" }; s.challenge = { goal: "破案", limit: "一天", deadlineMinute: 1440, failIf: "", progress: "", status: "active", startedMinute: 0 }; });
apply("challenge win precedes deadline", { time: 2000, challenge: { result: "won", why: "查明真相" } }, (s) => { s.challenge = { goal: "破案", limit: "一天", deadlineMinute: 1440, failIf: "", progress: "", status: "active", startedMinute: 0 }; });
apply("challenge deadline program decides", { time: 2000 }, (s) => { s.challenge = { goal: "破案", limit: "一天", deadlineMinute: 1440, failIf: "", progress: "", status: "active", startedMinute: 0 }; });
apply("mode editors validate", { scriptSet: { line: "故事", beats: [{ id: "b1", text: "第一幕", status: "done" }], ending: "归家", steer: "firm" }, challengeSet: { goal: "安顿", limit: "三天", deadlineMinute: 0, failIf: "破产", progress: "", status: "active", startedMinute: 0 } }, undefined, { advanceTime: false });
apply("panel fields model cannot replace", { scriptSet: null, challengeSet: null, sourceSet: null, profile: { identity: "错误" }, items: [{ name: "书", set: { quantity: 9 } }] });

for (const input of ["", "<record>{time:'半个时辰',money:'二百文',items:[{name:'饼',delta:'+2个'}],choices:['1. 问路'],}</record>", '{"time":15,"items":[{"name":"纸","delta":1}],"choices":["说', '{time:15, choices:["继续"],}', '{“time”:30,“choices”:[“继续”]}', JSON.stringify({ time: "三日", place: 3, stats: { health: "4", energy: null, fame: "bad" }, items: ["纸+2", { name: "钱", change: "-3文" }, { name: "坏", delta: "bad" }], people: [{ name: "张三", aliases: ["张兄"], note: "好友" }, {}], status: { name: "微伤" }, goals: { name: "归家" }, hour: null, date: { era: "天宝", year: 7, month: 1 }, died: "true", currency: [{ name: "文", value: "1" }], log: "记事", report: { local: "无事" }, risk: { what: "越墙", result: "没成" }, beat: "DONE", challenge: { progress: "前进", result: "WON", why: "完成" }, choices: ["一、问路", { text: "- 等待" }] })]) fixtures.push({ name: `record ${fixtures.length}`, kind: "parse", input, expected: parseRecord(input) });
for (const input of ["半个时辰", "二十余日", "数日", "十几息", "一阵子", "日头", "月余", "二个半时辰", "一盏茶", " 90分钟", -1, 2.5]) fixtures.push({ name: `duration ${input}`, kind: "duration", input, expected: parseDurationMinutes(input) });
for (const input of ["天宝七载（戊子）冬月十七", "大唐天宝十五载六月廿九", "中平元年秋", "宣和四年春二月初三", "公元前44年3月14日", "1665年4月", "秦王政二十六年正月", "崇祯元年闰腊月初十", "月余"]) fixtures.push({ name: `date ${input}`, kind: "date", input, rules, expected: parseDateLabel(input, rules) });
for (const elapsed of [0, 960, 2000, 525600]) fixtures.push({ name: `now ${elapsed}`, kind: "now", clock, elapsed, expected: nowOf(clock, elapsed) });
for (const input of ["三贯二百文", "一贯半", "−二百文", "＋2,300文", 3.5, -1.5, "若干"]) fixtures.push({ name: `money ${input}`, kind: "money", input, currency: TANG_CURRENCY, expected: parseMoney(input, TANG_CURRENCY) });
writeFileSync(fileURLToPath(new URL("fixtures.json", import.meta.url)), JSON.stringify(fixtures, null, 2) + "\n");
console.log(`Wrote ${fixtures.length} scoped TypeScript rule fixtures.`);
