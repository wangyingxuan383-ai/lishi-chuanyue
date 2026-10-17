// Automatic player eval, using only the selected dev-secret slot.
// node_modules/.bin/tsx scripts/eval/autoplay.ts --model fake-normal --slot fake --turns 8
// Memory probes (R04-T005): --probe-at 60,100,150 asks, out of band and with the
// next turn's own context, questions written from turns --probe-from 3-20.
import fs from "node:fs";
import path from "node:path";
import { Game, type TurnEvent } from "../../src/engine/game.ts";
import { ChatError, chatCompletionsUrl, parseChunk, streamChat, type ChatUsage } from "../../src/engine/llm/chat.ts";
import { CLICHES, PROMPT_VERSION } from "../../src/engine/prompt/turn.ts";
import { eraContext, eraPack } from "../../src/engine/era/index.ts";
import { nowOf, timeOfDay } from "../../src/engine/calendar/clock.ts";
import { formatDate } from "../../src/engine/calendar/date.ts";
import { cursor } from "../../src/engine/tree.ts";
import type { ActionMode, StoryNode } from "../../src/engine/types.ts";
import { TEMPLATES, templateName } from "../../src/content/templates.ts";
import { createMemoryPlatform } from "../../src/platform/memory.ts";
import type { Platform, StreamEvent } from "../../src/platform/types.ts";
import { loadDevSecret, nodePlatform, ROOT, stamp } from "./lib.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} 缺少值`);
  return value;
};
const positive = (name: string, fallback: string) => {
  const value = Number(arg(name, fallback));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} 必须是正整数`);
  return value;
};

type Failure = { reason: string; status?: number };
type Purpose = "opening" | "player" | "turn" | "extract" | "upkeep" | "probe";
type Call = {
  turn: number; purpose: Purpose; usage: ChatUsage | null;
  firstTokenMs: number | null; totalMs: number; failure: Failure | null;
};
type Entry = {
  turn: number; mode: ActionMode; action: string; narrative: string;
  firstTokenMs: number | null; totalMs: number; modelTotalMs: number | null;
  usage: ChatUsage | null; status: string | null;
  meta: { extracted: boolean | null; log: string[]; chips: unknown[] };
  /** The game clock after the turn, as the player sees it in 此时此地. */
  clock: { text: string; shichen: string; elapsedMinutes: number } | null;
  /** The hidden fortune of the turn and what the model said it was used for (R05-T002). */
  fortune: string | null;
  risk: { what: string; result?: string } | null;
  /** Goal changes the record asked for, to check progress updates (R05-T003). */
  goals: { op: string; name: string; detail?: string }[];
  failures: Failure[]; calls: Call[];
};
const BRANCHES = "子丑寅卯辰巳午未申酉戌亥";
/** Steps between two 时辰 on the 12-hour dial. */
const shichenGap = (a: string, b: string) => {
  const d = Math.abs(BRANCHES.indexOf(a) - BRANCHES.indexOf(b));
  return Math.min(d, 12 - d);
};
const serverFailure = (f: Failure) => f.reason === "network" || f.reason === "timeout"
  || f.status === 429 || (f.status !== undefined && f.status >= 500 && f.status < 600);
const fromError = (error: unknown): Failure => error instanceof ChatError
  ? { reason: error.kind.startsWith("timeout_") ? "timeout" : error.kind, ...(error.status ? { status: error.status } : {}) }
  : { reason: "script_error" };
const counts = (values: string[]) => {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
};
const latency = (values: (number | null)[]) => {
  const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const n = sorted.length;
  return {
    samples: n,
    median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    p90: n ? sorted[Math.ceil(n * 0.9) - 1] : null,
  };
};
const tokens = (calls: Call[]) => ({
  totalTokens: calls.reduce((n, c) => n + (c.usage?.promptTokens ?? 0) + (c.usage?.completionTokens ?? 0), 0),
  promptTokens: calls.reduce((n, c) => n + (c.usage?.promptTokens ?? 0), 0),
  completionTokens: calls.reduce((n, c) => n + (c.usage?.completionTokens ?? 0), 0),
  missingUsageCalls: calls.filter((c) => !c.usage).length,
});

function playerAction(raw: string): { mode: "do" | "say"; text: string } {
  let text = raw.trim().replace(/^```[^\n]*\n?/, "").trim();
  text = text.replace(/^(?:[-*]\s*|\d+[.、)）]\s*)/, "")
    .replace(/^(?:(?:下一步行动|下一步|玩家行动|玩家|行动|回答|输出|做|说|写)\s*[:：]\s*)+/, "").trim();
  const mode = /^[“"「『‘']/.test(text) ? "say" : "do";
  text = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  text = text.replace(/^[“"「『‘']+/, "").replace(/[”"」』’']+$/, "").trim()
    .replace(/^(?:(?:下一步行动|下一步|玩家行动|玩家|行动|回答|输出|做|说|写)\s*[:：]\s*)+/, "");
  return { mode, text: [...text].slice(0, 40).join("") };
}

async function main() {
  const model = arg("model");
  if (!model) throw new Error("用法：tsx scripts/eval/autoplay.ts --model <主模型> [--player-model <模型>] [--slot main] [--template tang-scholar] [--turns 50] [--max-calls 140] [--out <目录>]");
  const playerModel = arg("player-model", model)!;
  const slot = arg("slot", "main")!;
  const templateId = arg("template", "tang-scholar")!;
  const turns = positive("turns", "50");
  const maxCalls = positive("max-calls", "140");
  const out = path.resolve(ROOT, arg("out", `.cache/eval/autoplay-${stamp()}`)!);
  const t = TEMPLATES.find((x) => x.id === templateId);
  if (!t) throw new Error("模板不存在");
  // The key stays inside lib.ts; never persist request bodies, URLs or error details.
  const url = chatCompletionsUrl(loadDevSecret(slot).base);
  const upstream = nodePlatform(slot).llm;
  const calls: Call[] = [];
  let turn = 0;
  let purpose: Purpose = "opening";
  let blocked: Extract<StreamEvent, { type: "error" }> | null = null;
  const begin = (next: Purpose) => { purpose = next; blocked = null; };
  // Game has a built-in retry. Replay the first error locally so it never sends
  // a second upstream request. Also gate *all* calls, including hidden 补记.
  const llm: Platform["llm"] = {
    ...upstream,
    ack: async () => {},
    async stream(request, emit) {
      // 设定集 upkeep runs in the background between turns: counted, but kept out of the turn's retry gate.
      const body = request.body as { messages?: { content?: string }[] } | undefined;
      if (String(body?.messages?.[0]?.content ?? "").includes("替作者维护“设定集”")) {
        if (calls.length >= maxCalls) {
          emit({ type: "error", kind: "cancelled" });
          return crypto.randomUUID();
        }
        const call: Call = { turn, purpose: "upkeep", usage: null, firstTokenMs: null, totalMs: 0, failure: null };
        calls.push(call);
        const start = performance.now();
        return upstream.stream(request, (event) => {
          if (event.type === "data") {
            const chunk = parseChunk(event.data);
            if (chunk?.usage) call.usage = chunk.usage;
          }
          if (event.type === "error") call.failure = { reason: event.kind.startsWith("timeout_") ? "timeout" : event.kind, status: event.status };
          if (event.type === "error" || event.type === "done") call.totalMs = performance.now() - start;
          emit(event);
        });
      }
      if (blocked || calls.length >= maxCalls) {
        emit(blocked ?? { type: "error", kind: "cancelled" });
        return crypto.randomUUID();
      }
      const call: Call = { turn, purpose, usage: null, firstTokenMs: null, totalMs: 0, failure: null };
      calls.push(call);
      const start = performance.now();
      try {
        return await upstream.stream(request, (event) => {
          if (event.type === "data") {
            const chunk = parseChunk(event.data);
            if (chunk?.content) call.firstTokenMs ??= performance.now() - start;
            if (chunk?.usage) call.usage = chunk.usage;
          }
          if (event.type === "error") {
            // No provider text in failures: it may contain credentials or URLs.
            blocked = { type: "error", kind: event.kind, status: event.status };
            call.failure = { reason: event.kind.startsWith("timeout_") ? "timeout" : event.kind, status: event.status };
          }
          if (event.type === "error" || event.type === "done") call.totalMs = performance.now() - start;
          emit(event);
        });
      } catch {
        blocked = { type: "error", kind: "network" };
        call.failure = { reason: "network" };
        call.totalMs = performance.now() - start;
        emit(blocked);
        return crypto.randomUUID();
      }
    },
  };
  const platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, { slot, url, model, includeUsage: true });
  const entries: Entry[] = [];
  let stopReason = "turns";
  const probeAt = (arg("probe-at", "") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const [probeFrom, probeTo] = (arg("probe-from", "3-20") ?? "3-20").split("-").map(Number);
  const probes: { questions: { q: string; a: string }[]; rounds: { turn: number; answers: string[]; promptTokens: number | null }[] } = { questions: [], rounds: [] };
  // Every goal in progress must reach the next turn's context (R05-T003); checked locally, no calls.
  const goalChecks = { turns: 0, missing: [] as { turn: number; goal: string }[] };
  async function checkGoals(): Promise<void> {
    const head = (await cursor(game.repo, worldId!)).head;
    const active = (await game.repo.getState(head.id)).goals.filter((g) => g.status === "进行中");
    const stateLayer = (await game.previewContext(worldId!)).layers.find((l) => l.key === "state")?.content ?? "";
    goalChecks.turns++;
    for (const g of active) if (!stateLayer.includes(g.name)) goalChecks.missing.push({ turn, goal: g.name });
  }

  /** Six fact questions about turns probeFrom..probeTo, with answers taken from the text. */
  async function writeQuestions(): Promise<void> {
    const path = (await game.repo.path((await cursor(game.repo, worldId!)).head.id)).filter((n) => n.kind === "turn");
    const text = path.slice(probeFrom - 1, probeTo).map((n, i) => `第 ${probeFrom + i} 回合\n【玩家】${n.actionText || "（继续）"}\n${n.narrative}`).join("\n\n");
    begin("probe");
    const result = await streamChat(platform, {
      slot, url, model, includeUsage: true, maxTokens: 1500,
      messages: [
        { role: "system", content: "你替一部互动小说出记忆测试题。出 6 道事实题，检查读者以后是否还记得这些事：每题只问一件具体、之后不会被剧情改写的事实（人物的名字或身份、钱数、地点、约定或承诺、受的伤、得到或交出的东西），答案能在原文里找到、一两句话说清，不要问感受或推测。只输出 JSON 数组：[{\"q\":\"问题\",\"a\":\"答案\"}]" },
        { role: "user", content: text },
      ],
    }).result;
    const list = JSON.parse(result.text.slice(result.text.indexOf("["), result.text.lastIndexOf("]") + 1)) as { q?: unknown; a?: unknown }[];
    probes.questions = list.filter((x) => typeof x.q === "string" && typeof x.a === "string").slice(0, 6).map((x) => ({ q: x.q as string, a: x.a as string }));
  }

  /** Asks the questions with exactly the context the next turn would get; nothing is saved to the story. */
  async function askQuestions(): Promise<void> {
    if (!probes.questions.length) return;
    const { messages } = await game.previewContext(worldId!);
    const last = messages[messages.length - 1];
    const ask = `\n\n【这不是剧情，是一次记忆测试】请只根据上面的前文、前情提要和设定回答下列问题，每题一行，格式“编号. 答案”；不记得就写“不知道”，不要编。\n${probes.questions.map((x, i) => `${i + 1}. ${x.q}`).join("\n")}`;
    const content = last.content.slice(0, last.content.indexOf("\n\n【玩家行动】")) + ask;
    begin("probe");
    const callStart = calls.length;
    const result = await streamChat(platform, { slot, url, model, includeUsage: true, maxTokens: 800, messages: [...messages.slice(0, -1), { role: "user", content }] }).result;
    const answers = probes.questions.map((_, i) => result.text.split("\n").map((l) => l.trim()).find((l) => l.startsWith(`${i + 1}.`) || l.startsWith(`${i + 1}、`))?.replace(/^\d+[.、]\s*/, "") ?? "（没有回答）");
    probes.rounds.push({ turn, answers, promptTokens: calls[callStart]?.usage?.promptTokens ?? null });
  }

  async function capture(mode: ActionMode, action: string, run: (onEvent: (e: TurnEvent) => void) => Promise<unknown>): Promise<Entry> {
    const start = performance.now();
    const callStart = calls.length;
    let node: StoryNode | null = null;
    let narrative = "";
    let firstTokenMs: number | null = null;
    const failures: Failure[] = [];
    await run((event) => {
      if (event.type === "text") { firstTokenMs ??= performance.now() - start; narrative = event.full; }
      if (event.type === "organizing") begin("extract");
      if (event.type === "done") node = event.node;
      if (event.type === "failed") {
        failures.push({ reason: event.reason, ...(event.status ? { status: event.status } : {}) });
        node = event.cursor?.head ?? null;
      }
    });
    // Assigned by the synchronous event callback above.
    const saved = node as StoryNode | null;
    if (saved?.status === "no_record" && !failures.length) failures.push({ reason: "no_record" });
    let clock: Entry["clock"] = null;
    let fortune: string | null = null;
    let risk: Entry["risk"] = null;
    let goals: Entry["goals"] = [];
    if (saved) {
      fortune = saved.parentId ? ((await game.repo.getNode(saved.parentId))?.meta.fortune as string | undefined) ?? null : null;
      risk = (saved.record as { risk?: Entry["risk"] } | null)?.risk ?? null;
      goals = ((saved.record as { goals?: Entry["goals"] } | null)?.goals ?? []).map((g) => ({ op: g.op, name: g.name, ...(g.detail ? { detail: g.detail } : {}) }));
      const state = await game.repo.getState(saved.id);
      const era = eraContext(t!.eraId, state);
      const now = nowOf(era.clock, state.time.elapsedMinutes);
      const when = now.date ? formatDate(now.date, era.clock.rules) : `第 ${now.day} 日`;
      clock = { text: `${when} ${timeOfDay(now)}`, shichen: now.shichen, elapsedMinutes: state.time.elapsedMinutes };
    }
    return {
      turn, mode, action, narrative: saved?.narrative ?? narrative, firstTokenMs,
      totalMs: performance.now() - start, modelTotalMs: (saved?.meta.totalMs as number) ?? null,
      usage: (saved?.meta.usage as ChatUsage) ?? null, status: saved?.status ?? null,
      meta: {
        extracted: typeof saved?.meta.extracted === "boolean" ? saved.meta.extracted : null,
        log: (saved?.meta.log as string[]) ?? [], chips: (saved?.meta.chips as unknown[]) ?? [],
      },
      clock, fortune, risk, goals, failures, calls: calls.slice(callStart),
    };
  }

  const gender = t.gender ?? "女";
  let worldId: string | null = null;
  const opening = await capture("write", "（开场）", async (onEvent) => {
    // Like the app: without a built-in pack, the AI organizes the 设定集 from the premise.
    worldId = await game.createWorld({
      title: t.title, eraId: t.eraId, settings: { premise: t.premise }, organize: !eraPack(t.eraId),
      protagonist: { name: templateName(t, gender), gender, age: t.age, identity: t.identity },
      arrival: t.arrival ?? "魂穿", origin: "历史系研究生", opening: { mode: "ai", hint: t.openingHint },
    }, onEvent);
  });
  if (!worldId) stopReason = calls.length >= maxCalls ? "max_calls" : "opening_failed";
  let consecutiveFailures = 0;
  for (turn = 1; worldId && turn <= turns; turn++) {
    if (calls.length >= maxCalls) { stopReason = "max_calls"; break; }
    const { head } = await cursor(game.repo, worldId);
    const recent = (await game.repo.path(head.id, 2)).map((n) => n.narrative).join("\n\n---\n\n");
    const isContinue = turn % 10 === 0;
    // Shift the write at multiples of 30 one turn earlier to avoid continue.
    const isWrite = turn % 30 === 15 || turn % 30 === 29;
    const selectChoice = !isContinue && !isWrite && [1, 3, 6, 8].includes(turn % 10) && head.choices.length > 0;
    const instruction = isContinue ? "本回合等待故事推进，只输出：（继续）。"
      : isWrite ? "本回合用写模式：以作者身份写一句已经发生的情节，不要写行动意图。"
      : selectChoice ? "本回合必须直接选一个建议选项，原文输出，不要改字。"
      : "本回合自由行动，可以做事或用引号说一句话，不必照选项。";
    const callStart = calls.length;
    begin("player");
    let action = { mode: (isContinue ? "continue" : isWrite ? "write" : "do") as ActionMode, text: "" };
    let entry: Entry;
    try {
      const player = await streamChat(platform, {
        slot, url, model: playerModel, includeUsage: true, maxTokens: 128,
        messages: [
          { role: "system", content: "你在玩一个历史穿越文字游戏，扮演主角。根据最近两段剧情和建议选项，输出下一步行动：一行，不超过40字，不解释，不加前缀。" },
          { role: "user", content: `最近两段剧情：\n${recent}\n\n建议选项：\n${head.choices.join("\n") || "（无）"}\n\n${instruction}` },
        ],
      }).result;
      const parsed = playerAction(player.text);
      const choice = head.choices.find((c) => c === parsed.text) ?? head.choices[0];
      action = isContinue ? { mode: "continue", text: "（继续）" }
        : isWrite ? { mode: "write", text: parsed.text }
        : selectChoice ? { mode: /^[“"「『‘']/.test(choice) ? "say" : "do", text: choice }
        : { mode: parsed.mode, text: parsed.text };
      if (!action.text) throw new ChatError("empty");
      if (calls.length >= maxCalls) { stopReason = "max_calls"; break; }
      begin("turn");
      entry = await capture(action.mode, action.text, (onEvent) => game.play(worldId!, {
        mode: action.mode, text: action.mode === "continue" ? "" : action.text,
      }, onEvent).done);
    } catch (error) {
      entry = {
        turn, mode: action.mode, action: action.text, narrative: "", firstTokenMs: null, totalMs: 0, modelTotalMs: null,
        usage: null, status: null, meta: { extracted: null, log: [], chips: [] }, clock: null, fortune: null, risk: null, goals: [], failures: [fromError(error)], calls: [],
      };
    }
    entry.calls = calls.slice(callStart);
    entries.push(entry);
    console.log(`第 ${turn} 回合 · ${entry.mode} · ${entry.action || "（玩家生成失败）"} · ${entry.status ?? "failed"} · 调用 ${calls.length}/${maxCalls}`);
    consecutiveFailures = entry.failures.length ? consecutiveFailures + 1 : 0;
    if (calls.length >= maxCalls) { stopReason = "max_calls"; break; }
    if (consecutiveFailures >= 3) { stopReason = "three_failures"; break; }
    if (worldId && entry.status) await checkGoals();
    if (probeAt.length && turn === probeTo) await writeQuestions().catch(() => console.log("记忆探针出题失败"));
    if (probeAt.includes(turn)) {
      await game.settled();
      await askQuestions().catch(() => console.log(`第 ${turn} 回合记忆探针失败`));
    }
  }

  await game.settled();
  const failures = entries.flatMap((e) => e.failures);
  const failedTurns = entries.filter((e) => e.failures.length);
  const serverFailedTurns = failedTurns.filter((e) => e.failures.every(serverFailure)).length;
  const log = entries.flatMap((e) => e.meta.log);
  const newPeople = [...new Set(log.filter((l) => l.startsWith("新人物")).map((l) => l.replace(/^新人物[:：]?\s*/, "")).filter(Boolean))];
  const head = worldId ? (await cursor(game.repo, worldId)).head : null;
  const state = head ? await game.repo.getState(head.id) : null;
  // Chapter summaries on the final path, so their accuracy can be read against the story (R04-T003).
  const chapterList = head ? (await game.repo.chaptersOnPath(worldId!, head.id)).map((c) => ({ title: c.title, gist: c.gist, summary: c.summary })) : [];
  const upkeep = {
    calls: calls.filter((c) => c.purpose === "upkeep").length,
    edits: head ? (await game.repo.path(head.id)).filter((n) => n.kind === "edit" && n.meta.by === "AI").map((n) => n.actionText ?? "") : [],
    cards: (state?.cards ?? []).filter((c) => c.source === "AI").map((c) => ({ kind: c.kind, name: c.name, keys: c.keys, content: c.content })),
    places: (state?.places ?? []).filter((p) => p.source === "AI").map((p) => ({ name: p.name, aliases: p.aliases ?? [], description: p.description })),
  };
  const names = [...new Set([...(state?.people.map((p) => p.name) ?? []), ...newPeople])];
  const stripped = (name: string) => name.replace(/管事|掌柜|郎君|娘子|大人|老丈|伙计/g, "").trim();
  const suspectedDuplicates: string[][] = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = names[i], b = names[j];
    if (a.includes(b) || b.includes(a) || (stripped(a) && stripped(a) === stripped(b))) suspectedDuplicates.push([a, b]);
  }
  const pack = eraPack(t.eraId);
  const tabooKeywords = [...new Set((pack?.taboos ?? []).flatMap((taboo) => taboo.match ?? [taboo.name]))];
  const frequency = (words: string[]) => {
    const byWord = Object.fromEntries(words.map((word) => [word, entries.reduce((n, e) => n + e.narrative.split(word).length - 1, 0)]));
    const count = Object.values(byWord).reduce((a, b) => a + b, 0);
    const characters = entries.reduce((n, e) => n + [...e.narrative.replace(/\s/g, "")].length, 0);
    return { count, characters, per1000Characters: characters ? count * 1000 / characters : 0, byWord };
  };
  // 时辰 named in the text that are more than one 时辰 away from the clock at both ends of the turn.
  const timeMismatches: { turn: number; word: string; clock: string; context: string }[] = [];
  entries.forEach((e, i) => {
    const before = i === 0 ? opening.clock : entries[i - 1].clock;
    if (!e.clock) return;
    for (const m of e.narrative.matchAll(/([子丑寅卯辰巳午未申酉戌亥])时/g)) {
      const gap = Math.min(shichenGap(m[1], e.clock.shichen), before ? shichenGap(m[1], before.shichen) : 12);
      if (gap > 1) timeMismatches.push({
        turn: e.turn, word: m[0], clock: e.clock.text,
        context: e.narrative.slice(Math.max(0, m.index! - 16), m.index! + 8).replace(/\s+/g, " "),
      });
    }
  });
  // Risky actions by fortune: does an unlucky roll fail more often than a lucky one (R05-T002)?
  const fortuneStats = Object.fromEntries(["大顺", "顺", "平", "不顺", "大不顺"].map((level) => {
    const turnsAt = entries.filter((e) => e.fortune === level);
    const risky = turnsAt.filter((e) => e.risk);
    return [level, { turns: turnsAt.length, risky: risky.length, failed: risky.filter((e) => e.risk!.result === "败").length, half: risky.filter((e) => e.risk!.result === "半成").length }];
  }));
  const failRate = (levels: string[]) => {
    const risky = levels.reduce((n, l) => n + fortuneStats[l].risky, 0);
    return risky ? levels.reduce((n, l) => n + fortuneStats[l].failed, 0) / risky : null;
  };
  const direct = entries.filter((e) => e.status === "ok" && e.meta.extracted === false).length;
  const summary = {
    model, playerModel, template: templateId, promptVersion: PROMPT_VERSION,
    requestedTurns: turns, maxCalls, stopReason, turns: entries.length, failedTurns: failedTurns.length,
    failuresByReason: counts(failures.map((f) => f.status ? `${f.reason}:${f.status}` : f.reason)),
    serverFailedTurns, otherFailedTurns: failedTurns.length - serverFailedTurns,
    successRateExcludingServer: entries.length > serverFailedTurns ? (entries.length - failedTurns.length) / (entries.length - serverFailedTurns) : null,
    records: {
      directParsed: direct, denominator: entries.length, directParseRate: entries.length ? direct / entries.length : null,
      extractionCalls: calls.filter((c) => c.purpose === "extract" && c.turn > 0).length,
      extractedTurns: entries.filter((e) => e.meta.extracted === true).length,
      noRecordTurns: entries.filter((e) => e.status === "no_record").length,
    },
    correctionsOrDiscards: log.filter((l) => !l.startsWith("新人物")).length,
    newPeople, suspectedDuplicates, cliches: frequency(CLICHES),
    anachronisms: pack ? { eraId: pack.id, ...frequency(tabooKeywords) } : null,
    clock: { start: opening.clock?.text ?? null, end: entries.at(-1)?.clock?.text ?? null, elapsedMinutes: entries.at(-1)?.clock?.elapsedMinutes ?? null },
    timeMismatches, upkeep, chapters: chapterList,
    fortune: { byLevel: fortuneStats, riskyTurns: entries.filter((e) => e.risk).length, luckyFailRate: failRate(["大顺", "顺"]), unluckyFailRate: failRate(["不顺", "大不顺"]) },
    probes: probeAt.length ? { from: `${probeFrom}-${probeTo}`, ...probes } : null,
    goalsInContext: goalChecks,
    tokenCurve: entries.filter((e) => e.turn % 10 === 0).map((e) => ({ turn: e.turn, promptTokens: e.usage?.promptTokens ?? null })),
    latencyMs: { firstToken: latency(entries.map((e) => e.firstTokenMs)), total: latency(entries.filter((e) => e.calls.some((c) => c.purpose === "turn")).map((e) => e.totalMs)) },
    calls: { total: calls.length, byPurpose: counts(calls.map((c) => c.purpose)), failuresByReason: counts(calls.filter((c) => c.failure).map((c) => c.failure!.status ? `${c.failure!.reason}:${c.failure!.status}` : c.failure!.reason)) },
    tokens: { ...tokens(calls), byPurpose: Object.fromEntries((["opening", "player", "turn", "extract", "upkeep", "probe"] as Purpose[]).map((p) => [p, tokens(calls.filter((c) => c.purpose === p))])) },
    notes: [
      "回合指标不含开场；调用和 token 合计含开场、玩家、主模型和补记。缺失 usage 不估算。",
      "首字为 game.play 到首个正文事件；总耗时含补记，不含玩家生成；p90 用最近秩，字数为不含空白的 Unicode 字符数。",
      "directParseRate 严格按 status=ok 且 meta.extracted=false / 所有尝试回合；补记次数以实际调用计，失败补记也计。",
      "疑似重复人物和时代禁词仅为字面筛查；八股词逐词计数，词表重叠可能重复计数。",
      "时辰不符为字面筛查：正文提到的时辰与本回合前后的游戏时钟都相差一个时辰以上就记一次；约定的时间、规矩里的时间也会被算进去，需要人工复核。",
      "每十回合第十回合继续；每十五回合一次写（与继续重合时提前一回合）；固定四个回合选建议，输出不合规则使用第一个原选项。",
      "达到调用上限后不再发请求；最后一次调用的结果仍会保存。引擎内部重试仅本地重放失败，不再次请求。",
    ],
    opening, entries,
  };
  const labels: Record<ActionMode, string> = { do: "做", say: "说", write: "写", direct: "导演", continue: "继续", skip: "过些日子" };
  const render = (e: Entry, heading: string) => `${heading}\n\n${e.narrative || "（无正文）"}\n\n状态：${e.status ?? "未生成节点"}；补记：${e.meta.extracted ?? "未记录"}；首字：${e.firstTokenMs === null ? "无" : Math.round(e.firstTokenMs) + "ms"}；总耗时：${Math.round(e.totalMs)}ms\n\n游戏时间：${e.clock?.text ?? "（无）"}；运势：${e.fortune ?? "（无）"}${e.risk ? `；风险：${e.risk.what}${e.risk.result ? ` · ${e.risk.result}` : ""}` : ""}${e.goals?.length ? `

目标变化：${e.goals.map((g) => `${g.op} ${g.name}${g.detail ? `（${g.detail}）` : ""}`).join("；")}` : ""}\n\n状态标签：${e.meta.chips.map((c) => (c as { text?: string }).text ?? "").join(" | ") || "（无）"}\n\n记录日志：\n${e.meta.log.map((l) => `- ${l}`).join("\n") || "（无）"}\n\n失败：${e.failures.map((f) => `${f.reason}${f.status ? ` (${f.status})` : ""}`).join("；") || "（无）"}\n`;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(out, "transcript.md"), `# 自动玩家试玩\n\n模板：${templateId}；主模型：${model}；玩家模型：${playerModel}\n\n${render(opening, "## 开场")}\n${entries.map((e) => render(e, `### 第 ${e.turn} 回合 · ${labels[e.mode]} · ${e.action || "（玩家生成失败）"}`)).join("\n")}\n## 设定集（AI 整理）\n\n${upkeep.edits.map((x) => `- ${x}`).join("\n") || "（没有整理）"}\n\n${upkeep.cards.map((c) => `- 【${c.kind}】${c.name}${c.keys.length ? `（又称${c.keys.join("、")}）` : ""}：${c.content}`).join("\n")}\n${upkeep.places.map((x) => `- 【地点】${x.name}：${x.description}`).join("\n")}\n${chapterList.length ? `\n## 章节摘要\n\n${chapterList.map((c, i) => `### 第 ${i + 1} 章 · ${c.title}\n\n梗概：${c.gist}\n\n${c.summary}`).join("\n\n")}\n` : ""}${probes.questions.length ? `\n## 记忆探针（第 ${probeFrom}～${probeTo} 回合出题）\n\n${probes.questions.map((x, i) => `${i + 1}. ${x.q}\n   标准答案：${x.a}${probes.rounds.map((r) => `\n   第 ${r.turn} 回合：${r.answers[i]}`).join("")}`).join("\n")}\n` : ""}`, "utf8");
  const { opening: _opening, entries: _entries, ...totals } = summary;
  console.log(JSON.stringify(totals, null, 2));
  console.log(`结果：${path.relative(ROOT, out)}`);
  if (!worldId || stopReason === "three_failures") process.exitCode = 1;
}

main().catch((error) => {
  // Only local argument errors are printable; never dump network error objects.
  console.error(error instanceof Error && /^(?:用法：|--|模板不存在)/.test(error.message) ? error.message : "自动玩家评测未完成，请检查槽位配置和本地环境（错误详情未输出以免泄露秘密）。");
  process.exitCode = 1;
});
