// R01-T004 / V101: compare three turn-output formats on the same 20 scripted
// actions (Tang Chang'an, 748). Each format plays its own run with a tiny
// state model, so later turns see the consequences of earlier ones.
//
//   node_modules/.bin/tsx scripts/eval/format-experiment.ts --model <model> [--formats A,B,C] [--turns 20] [--max-calls 100]
//
// Reads the key from .cache/dev-secrets.json (save it once in the browser dev
// harness). Writes raw transcripts to .cache/eval/format-<stamp>/ and prints a
// summary table for docs/validation/R01_FORMAT.md.
import fs from "node:fs";
import path from "node:path";
import { chatCompletionsUrl, streamChat, ChatError, type ChatMessage } from "../../src/engine/llm/chat.ts";
import { parseDurationMinutes } from "../../src/engine/calendar/duration.ts";
import { ROOT, nodePlatform, serviceBaseUrl, stamp } from "./lib.ts";

// ---------- arguments ----------
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const MODEL = arg("model");
if (!MODEL) throw new Error("--model is required");
const FORMATS = (arg("formats", "A,B,C") as string).split(",") as Array<"A" | "B" | "C">;
const TURNS = Number(arg("turns", "20"));
const MAX_CALLS = Number(arg("max-calls", "100"));

// ---------- minimal state ----------
interface Person { name: string; role: string; attitude: string; note: string }
interface Goal { name: string; detail: string; status: "进行中" | "完成" | "失败" }
interface State {
  minutes: number; place: string; money: number;
  items: Record<string, number>; people: Person[]; statuses: Record<string, string>; goals: Goal[];
}
interface Record_ {
  time?: string | number; place?: string; money?: number;
  items?: { name: string; delta: number }[];
  people?: Partial<Person>[];
  status?: { op: string; name: string; detail?: string }[];
  goals?: { op: string; name: string; detail?: string }[];
  log?: string; choices?: string[];
}

const initial = (): State => ({
  minutes: 7 * 60 + 30, place: "西市旁邸店客房", money: 300,
  items: { 旧书: 3, 换洗衣: 1 },
  people: [{ name: "王掌柜", role: "邸店掌柜", attitude: "一般", note: "催讨所欠房钱" }],
  statuses: {}, goals: [{ name: "三日内付清所欠房钱九十文", detail: "尚未凑钱", status: "进行中" }],
});

const SHICHEN = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
function clock(minutes: number): string {
  const day = Math.floor(minutes / 1440) + 1;
  const m = minutes % 1440;
  const shichen = SHICHEN[Math.floor(((m + 60) % 1440) / 120)];
  return `第${day}日 ${shichen}时（约${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}）`;
}

function renderState(s: State): string {
  const items = Object.entries(s.items).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`).join("、") || "无";
  const people = s.people.map((p) => `${p.name}（${p.role}，${p.attitude}；${p.note}）`).join("；") || "无";
  const statuses = Object.entries(s.statuses).map(([k, v]) => `${k}：${v}`).join("；") || "无";
  const goals = s.goals.filter((g) => g.status === "进行中").map((g) => `${g.name}（${g.detail}）`).join("；") || "无";
  return `【当前】${clock(s.minutes)} · ${s.place}\n可用的钱：${s.money}文\n行囊：${items}\n已知人物：${people}\n身体状况：${statuses}\n进行中的目标：${goals}`;
}

interface Applied { minutes: number; timeDefaulted: boolean; moneyDelta: number; moneyClamped: boolean; newPeople: string[]; dropped: string[] }

function findPerson(s: State, name: string): Person | undefined {
  const norm = (x: string) => x.replace(/[\s·]/g, "");
  return s.people.find((p) => norm(p.name) === norm(name))
    ?? s.people.find((p) => norm(p.name).includes(norm(name)) || norm(name).includes(norm(p.name)));
}

function apply(s: State, r: Record_ | null): Applied {
  const out: Applied = { minutes: 0, timeDefaulted: false, moneyDelta: 0, moneyClamped: false, newPeople: [], dropped: [] };
  const minutes = parseDurationMinutes(r?.time ?? null);
  out.minutes = minutes ?? 15;
  out.timeDefaulted = minutes === null;
  s.minutes += out.minutes;
  if (!r) return out;
  if (r.place) s.place = r.place;
  if (typeof r.money === "number" && Number.isFinite(r.money)) {
    const next = s.money + Math.round(r.money);
    out.moneyClamped = next < 0;
    out.moneyDelta = Math.max(0, next) - s.money;
    s.money = Math.max(0, next);
  }
  for (const item of r.items ?? []) {
    if (!item?.name || typeof item.delta !== "number") { out.dropped.push("item"); continue; }
    s.items[item.name] = Math.max(0, (s.items[item.name] ?? 0) + item.delta);
  }
  for (const p of r.people ?? []) {
    if (!p?.name) { out.dropped.push("person"); continue; }
    const found = findPerson(s, p.name);
    if (found) Object.assign(found, Object.fromEntries(Object.entries(p).filter(([k, v]) => v && k !== "name")));
    else {
      s.people.push({ name: p.name, role: p.role ?? "", attitude: p.attitude ?? "一般", note: p.note ?? "" });
      out.newPeople.push(p.name);
    }
  }
  for (const st of r.status ?? []) {
    if (!st?.name) continue;
    if (/^(remove|-|解除)/.test(st.op ?? "")) delete s.statuses[st.name];
    else s.statuses[st.name] = st.detail ?? "";
  }
  for (const g of r.goals ?? []) {
    if (!g?.name) continue;
    const existing = s.goals.find((x) => x.name === g.name || x.name.includes(g.name) || g.name.includes(x.name));
    if (g.op === "add") { if (!existing) s.goals.push({ name: g.name, detail: g.detail ?? "", status: "进行中" }); continue; }
    if (!existing) { out.dropped.push(`goal:${g.op}`); continue; }
    if (g.op === "done") existing.status = "完成";
    else if (g.op === "fail") existing.status = "失败";
    else if (g.detail) existing.detail = g.detail;
  }
  return out;
}

// ---------- prompts ----------
const BASE = `你是一部历史穿越互动小说的叙事者。
【写作要求】
- 用第二人称“你”。先写画面与动作，少用总结句。叙述用白话，人物对白带唐人口吻。每回合约三百字。
- 只写到玩家需要做决定为止：不替玩家说话，不替玩家做行动以外的决定，不擅自把玩家没说要做完的事做完。
- 玩家输入“（继续）”时，主角只做等待、观察这类被动动作，由他人和环境推动剧情。
- 玩家输入带“（导演：……）”时，那是写给你的幕后要求，照做，但不要在正文中提及。
- 涉及钱物时只能使用【当前】中列出的数量，正文写清具体数目；钱不够就买不成。
- 避免套话，如“指节泛白”“嘴角勾起一抹弧度”“眼中闪过一丝”“空气仿佛凝固”。
【时代】唐天宝七载（748年）冬，长安。货币为开元通宝铜钱，一贯等于一千文。物价参考：胡饼一枚约三文，邸店一宿约三十文，搬货短工一日约六十文，一匹驽马约十贯。计时用时辰与刻：一刻为十五分钟，一个时辰为两小时。
【主角】你本是现代历史系研究生，魂穿到落第举子李安身上，二十二岁，客居长安西市旁的邸店。`;

const FORMAT_A = `【输出格式】先写正文。正文结束后另起一行，输出记录块（只写有变化的字段，没有变化的字段省略；time、log、choices 每回合都要有）：
<record>
{"time":"本回合经过的时长，如：一刻 / 半个时辰 / 两个时辰 / 一夜","place":"新的地点（没移动就省略）","money":钱的增减（整数，单位文，花钱为负数）,"items":[{"name":"物品名","delta":数量增减}],"people":[{"name":"人物名（已知人物沿用原名）","role":"身份","attitude":"仇视/敌意/冷淡/一般/友善/亲近","note":"一句备注"}],"status":[{"op":"add 或 remove","name":"伤病或状态名","detail":"说明"}],"goals":[{"op":"add / progress / done / fail","name":"目标名（已有目标沿用原名）","detail":"进展"}],"log":"一句话记下本回合发生了什么","choices":["建议行动1","建议行动2","建议行动3"]}
</record>`;

const FORMAT_B = `【输出格式】先写正文。正文结束后另起一行写“【记录】”，再逐行列出本回合的变化（没有变化的行省略；时间、记事、选项每回合都要有）：
时间：本回合经过的时长（如：一刻 / 半个时辰 / 两个时辰 / 一夜）
地点：新的地点
钱：+60 或 -10（单位文）
物品：胡饼 +2；旧书 -1
人物：名字｜身份｜态度（仇视/敌意/冷淡/一般/友善/亲近）｜一句备注
状态：+名称｜说明　或　-名称
目标：+名称｜说明　或　~名称｜进展　或　✓名称　或　✗名称
记事：一句话记下本回合发生了什么
选项：建议行动1｜建议行动2｜建议行动3`;

const FORMAT_C = `【输出格式】只写正文，不要附加任何说明、列表或记录。`;

const EXTRACT = `你是这部互动小说的记录员。根据【当前】状态和【本回合正文】，只输出一个 JSON 对象描述本回合的变化（字段与含义如下，没有变化的字段省略；time、log、choices 必须有）：
{"time":"经过时长，如：一刻 / 半个时辰 / 两个时辰 / 一夜","place":"新地点","money":钱的增减（整数，单位文）,"items":[{"name":"物品名","delta":数量增减}],"people":[{"name":"人物名（已知人物沿用原名）","role":"身份","attitude":"仇视/敌意/冷淡/一般/友善/亲近","note":"一句备注"}],"status":[{"op":"add 或 remove","name":"状态名","detail":"说明"}],"goals":[{"op":"add / progress / done / fail","name":"目标名","detail":"进展"}],"log":"一句话","choices":["给玩家的建议行动1","建议行动2","建议行动3"]}
只输出 JSON，不要输出其他文字。`;

// ---------- parsing ----------
function lenientJson(text: string): any | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const raw = text.slice(start, end + 1);
  for (const candidate of [raw, raw.replace(/,\s*([}\]])/g, "$1"), raw.replace(/[“”]/g, '"')]) {
    try { return JSON.parse(candidate); } catch { /* try next */ }
  }
  return null;
}

function splitA(full: string): { narrative: string; record: Record_ | null } {
  const i = full.search(/<\s*record\s*>/i);
  if (i < 0) return { narrative: full.trim(), record: null };
  return { narrative: full.slice(0, i).trim(), record: lenientJson(full.slice(i)) };
}

function splitB(full: string): { narrative: string; record: Record_ | null } {
  const i = full.indexOf("【记录】");
  if (i < 0) return { narrative: full.trim(), record: null };
  const r: Record_ = {};
  for (const line of full.slice(i + 4).split(/\r?\n/)) {
    const m = /^\s*([^：:]+)[：:]\s*(.+)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    const parts = (v: string) => v.split(/[；;]/).map((x) => x.trim()).filter(Boolean);
    if (key === "时间") r.time = value;
    else if (key === "地点") r.place = value;
    else if (key === "钱") r.money = Number(value.replace(/[^\d+-]/g, ""));
    else if (key === "物品") r.items = parts(value).map((p) => {
      const mm = /^(.+?)\s*([+-]\s*\d+)/.exec(p);
      return mm ? { name: mm[1].trim(), delta: Number(mm[2].replace(/\s/g, "")) } : { name: p, delta: NaN };
    });
    else if (key === "人物") r.people = parts(value).map((p) => { const [name, role, attitude, note] = p.split(/[｜|]/); return { name, role, attitude, note }; });
    else if (key === "状态") r.status = parts(value).map((p) => { const [name, detail] = p.slice(1).split(/[｜|]/); return { op: p[0] === "-" ? "remove" : "add", name, detail }; });
    else if (key === "目标") r.goals = parts(value).map((p) => {
      const op = { "+": "add", "~": "progress", "✓": "done", "✗": "fail" }[p[0]] ?? "progress";
      const [name, detail] = p.slice(1).split(/[｜|]/);
      return { op, name, detail };
    });
    else if (key === "记事") r.log = value;
    else if (key === "选项") r.choices = value.split(/[｜|]/).map((x) => x.trim()).filter(Boolean);
  }
  return { narrative: full.slice(0, i).trim(), record: r };
}

// ---------- scripted actions with automatic probes ----------
interface Ctx { before: State; after: State; applied: Applied; record: Record_ | null }
interface Action { text: string; probe?: (c: Ctx) => string | null }

const ACTIONS: Action[] = [
  { text: "先坐起来，看看屋里有什么，理一理原主的记忆。" },
  { text: "“掌柜，房钱再宽限三日，我必想法子凑齐。”" },
  { text: "出门去西市，打听哪里招短工。" },
  { text: "跟着货栈的管事先试着搬一刻钟的货，然后停下来问工钱怎么算。",
    probe: (c) => (c.applied.minutes >= 10 && c.applied.minutes <= 30 && c.applied.moneyDelta === 0 ? null : `动作范围：用时${c.applied.minutes}分钟、钱变化${c.applied.moneyDelta}`) },
  { text: "请教管事尊姓，和他谈好一天的工钱。" },
  { text: "答应下来，老老实实干完今天的活，领工钱。",
    probe: (c) => (c.applied.moneyDelta > 0 ? null : `干完活钱没增加（${c.applied.moneyDelta}）`) },
  { text: "用六文钱买两个胡饼，当场吃掉一个。",
    probe: (c) => {
      const got = Object.entries(c.after.items).find(([k]) => k.includes("饼"));
      const issues = [];
      if (c.applied.moneyDelta !== -6) issues.push(`钱变化${c.applied.moneyDelta}≠-6`);
      if (!got || got[1] !== 1) issues.push(`胡饼数量${got?.[1] ?? 0}≠1`);
      return issues.length ? issues.join("，") : null;
    } },
  { text: "在原地等候半个时辰，什么也不做。",
    probe: (c) => (c.applied.minutes === 60 ? null : `半个时辰记为${c.applied.minutes}分钟`) },
  { text: "回邸店，先付给掌柜三十文房钱。",
    probe: (c) => (c.applied.moneyDelta === -30 ? null : `付房钱钱变化${c.applied.moneyDelta}≠-30`) },
  { text: "去马市问问，我想买一匹马。",
    probe: (c) => (c.applied.moneyClamped || Object.keys(c.after.items).some((k) => k.includes("马")) ? "钱不够却买成了马或钱被扣成负数" : null) },
  { text: "（继续）" },
  { text: "去找白天那位管事，问明天还有没有活。",
    probe: (c) => (c.applied.newPeople.length === 0 ? null : `新增了人物：${c.applied.newPeople.join("、")}（可能重复）`) },
  { text: "（导演：这一段让主角搬货时在结冰的地上滑倒，扭伤脚踝）继续搬货。",
    probe: (c) => (Object.keys(c.after.statuses).length > Object.keys(c.before.statuses).length ? null : "扭伤没有记入状态") },
  { text: "一瘸一拐地去药铺看脚，问问药钱多少，先不买。",
    probe: (c) => (c.applied.moneyDelta === 0 ? null : `只问价却花了钱（${c.applied.moneyDelta}）`) },
  { text: "回邸店睡一觉，直到天亮。",
    probe: (c) => (c.applied.minutes >= 300 ? null : `睡到天亮只过了${c.applied.minutes}分钟`) },
  { text: "清点一下身上的钱和东西。" },
  { text: "去西市酒肆坐坐，听听有没有关于边镇节度使的传闻。" },
  { text: "给自己定个目标：一个月内攒够一贯钱，在西市租个小摊。",
    probe: (c) => (c.after.goals.length > c.before.goals.length ? null : "新目标没有记录") },
  { text: "把剩下的那个胡饼送给门口讨饭的孩子。",
    probe: (c) => {
      const got = Object.entries(c.after.items).find(([k]) => k.includes("饼"));
      return !got || got[1] === 0 ? null : `胡饼还剩${got[1]}`;
    } },
  { text: "（继续）" },
];

const CLICHES = ["指节泛白", "嘴角勾起", "一抹弧度", "眼中闪过一丝", "空气仿佛凝固", "五味杂陈", "不由得", "心中一凛"];

// ---------- run ----------
const platform = nodePlatform();
const url = chatCompletionsUrl(serviceBaseUrl());
let calls = 0;

async function call(messages: ChatMessage[], maxTokens: number) {
  if (++calls > MAX_CALLS) throw new Error(`超过调用上限 ${MAX_CALLS}`);
  const handle = streamChat(platform, { slot: "main", url, model: MODEL!, messages, maxTokens, includeUsage: true });
  return handle.result;
}

const outDir = path.join(ROOT, ".cache", "eval", `format-${stamp()}`);
fs.mkdirSync(outDir, { recursive: true });
const summary: Record<string, any> = {};

for (const format of FORMATS) {
  const state = initial();
  const history: { action: string; narrative: string }[] = [];
  const turns: any[] = [];
  let consecutiveFailures = 0;
  for (const [index, action] of ACTIONS.slice(0, TURNS).entries()) {
    const before = structuredClone(state);
    const recent = history.slice(-3).map((h) => `玩家：${h.action}\n${h.narrative}`).join("\n\n");
    const system = `${BASE}\n\n${format === "A" ? FORMAT_A : format === "B" ? FORMAT_B : FORMAT_C}`;
    const user = `${renderState(state)}\n\n${recent ? `【最近剧情】\n${recent}\n\n` : ""}【玩家行动】${action.text}`;
    const turn: any = { index: index + 1, action: action.text };
    try {
      const main = await call([{ role: "system", content: system }, { role: "user", content: user }], 1500);
      turn.main = { firstTokenMs: main.firstTokenMs, totalMs: main.totalMs, usage: main.usage, finishReason: main.finishReason };
      let split = format === "A" ? splitA(main.text) : format === "B" ? splitB(main.text) : { narrative: main.text.trim(), record: null };
      turn.raw = main.text;
      if (format === "C") {
        const extract = await call([
          { role: "system", content: EXTRACT },
          { role: "user", content: `${renderState(state)}\n\n【玩家行动】${action.text}\n\n【本回合正文】\n${split.narrative}` },
        ], 800);
        turn.extract = { totalMs: extract.totalMs, usage: extract.usage, raw: extract.text };
        split = { narrative: split.narrative, record: lenientJson(extract.text) };
      }
      turn.narrative = split.narrative;
      turn.record = split.record;
      turn.recordOk = !!split.record;
      turn.hasTime = split.record?.time !== undefined;
      turn.hasChoices = Array.isArray(split.record?.choices) && split.record!.choices!.length > 0;
      turn.hasLog = !!split.record?.log;
      turn.leak = /<\s*record|【记录】|"choices"|\{\s*"time"/.test(split.narrative);
      turn.applied = apply(state, split.record);
      turn.cliches = CLICHES.filter((c) => split.narrative.includes(c));
      turn.chars = split.narrative.length;
      turn.probe = action.probe ? action.probe({ before, after: state, applied: turn.applied, record: split.record }) ?? "ok" : null;
      history.push({ action: action.text, narrative: split.narrative });
      consecutiveFailures = 0;
    } catch (error) {
      const e = error as ChatError;
      turn.error = { kind: e.kind ?? "unknown", status: e.status, message: String(e.message).slice(0, 300) };
      consecutiveFailures++;
      if (String(e.message).includes("调用上限") || consecutiveFailures >= 3) {
        turns.push(turn);
        console.log(`[${format}] 停止：${turn.error.kind} ${turn.error.message}`);
        break;
      }
    }
    turn.stateAfter = structuredClone(state);
    turns.push(turn);
    console.log(`[${format}] ${index + 1}/${TURNS} ${turn.error ? `错误 ${turn.error.kind}` : `记录${turn.recordOk ? "✓" : "✗"} ${turn.probe && turn.probe !== "ok" ? `探针✗ ${turn.probe}` : ""}`}`);
  }
  fs.writeFileSync(path.join(outDir, `${format}.json`), JSON.stringify({ model: MODEL, format, turns }, null, 2));
  const ok = turns.filter((t) => !t.error);
  const median = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const probes = ok.filter((t) => t.probe !== null);
  summary[format] = {
    turns: turns.length,
    errors: turns.length - ok.length,
    recordOk: ok.filter((t) => t.recordOk).length,
    timePresent: ok.filter((t) => t.hasTime).length,
    choicesPresent: ok.filter((t) => t.hasChoices).length,
    leaks: ok.filter((t) => t.leak).length,
    probesPassed: `${probes.filter((t) => t.probe === "ok").length}/${probes.length}`,
    probeFailures: probes.filter((t) => t.probe !== "ok").map((t) => `#${t.index} ${t.probe}`),
    newPeople: ok.flatMap((t) => t.applied.newPeople),
    firstTokenMedianMs: median(ok.map((t) => t.main.firstTokenMs).filter((x: number | null) => x !== null)),
    turnMedianMs: median(ok.map((t) => t.main.totalMs + (t.extract?.totalMs ?? 0))),
    tokens: ok.reduce((n, t) => n + (t.main.usage ? t.main.usage.promptTokens + t.main.usage.completionTokens : 0)
      + (t.extract?.usage ? t.extract.usage.promptTokens + t.extract.usage.completionTokens : 0), 0),
    avgChars: Math.round(ok.reduce((n, t) => n + t.chars, 0) / Math.max(1, ok.length)),
    cliches: ok.flatMap((t) => t.cliches),
    finalState: state,
  };
}

fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ model: MODEL, calls, summary }, null, 2));
console.log(JSON.stringify({ model: MODEL, calls, outDir: path.relative(ROOT, outDir), summary }, (k, v) => (k === "finalState" ? undefined : v), 2));
