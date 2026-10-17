// R03-T008 eval: three player-written setups (one fictional dynasty), each
// opened with AI organizing on, then two short turns. Records the era card,
// the organized cards, opening latency and every call, under a call cap.
//   node_modules/.bin/tsx scripts/eval/organize.ts --model <model> [--slot main] [--max-calls 24] [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { Game, type NewWorld, type TurnEvent } from "../../src/engine/game.ts";
import { chatCompletionsUrl, parseChunk, type ChatUsage } from "../../src/engine/llm/chat.ts";
import { ERA_CARD_LIMIT } from "../../src/engine/memory/cards.ts";
import { CODEX_PROMPT_VERSION } from "../../src/engine/prompt/codex.ts";
import { PROMPT_VERSION } from "../../src/engine/prompt/turn.ts";
import { cursor } from "../../src/engine/tree.ts";
import { createMemoryPlatform } from "../../src/platform/memory.ts";
import type { Platform, StreamEvent } from "../../src/platform/types.ts";
import { loadDevSecret, nodePlatform, ROOT, stamp } from "./lib.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const SETUPS: { id: string; world: NewWorld }[] = [
  {
    id: "fictional",
    world: {
      title: "青衣卫", eraId: null, organize: true,
      settings: { premise: "架空王朝大胤，景和三年，京城云京。少年天子登基三年，太后垂帘听政，外戚与清流相争；北境狄戎年年叩关。京中盛行斗茶与马球，夜里坊市灯火不绝。" },
      protagonist: { name: "沈砚", gender: "男", age: 20, identity: "你是青衣卫的小旗，奉命暗查一桩科场舞弊案，却发现线索指向太后的亲侄。" },
      arrival: "魂穿", origin: "历史系研究生", opening: { mode: "ai", hint: "" },
    },
  },
  {
    id: "later-tang",
    world: {
      title: "伶官", eraId: null, organize: true,
      settings: { premise: "后唐同光三年，洛阳。庄宗李存勖灭梁之后沉溺声色，宠信伶人，伶官出入宫禁、干预政事；将士赏赐不足，怨声渐起。" },
      protagonist: { name: "敬新", gender: "女", age: 18, identity: "你是宫中教坊的伶人，因一曲得了官家青眼，却也因此被几位得势的伶官视作眼中钉。" },
      arrival: "不穿越", origin: "", opening: { mode: "ai", hint: "" },
    },
  },
  {
    id: "london",
    world: {
      title: "瘟疫之年", eraId: null, organize: true,
      settings: { premise: "1665 年春，伦敦。城里开始有人得一种怪病，教区每周公布的死亡名单越来越长；有钱人陆续出城，穷人只能留下。" },
      protagonist: { name: "托马斯·韦尔", gender: "男", age: 19, identity: "你是泰晤士河边一家药剂师铺子的学徒，师傅昨夜没有回来，柜台上留着一张没写完的药方。" },
      arrival: "魂穿", origin: "外科医生", opening: { mode: "ai", hint: "" },
    },
  },
];
const ACTIONS = [{ mode: "do" as const, text: "四处走走，看看周围，打听一下最近的消息" }, { mode: "continue" as const, text: "" }];

type Call = { setup: string; usage: ChatUsage | null; firstTokenMs: number | null; totalMs: number; failed: string | null };

async function main() {
  const model = arg("model");
  if (!model) throw new Error("用法：tsx scripts/eval/organize.ts --model <模型> [--slot main] [--max-calls 24] [--out <目录>]");
  const slot = arg("slot", "main")!;
  const maxCalls = Number(arg("max-calls", "24"));
  const out = path.resolve(ROOT, arg("out", `.cache/eval/organize-${stamp()}`)!);
  // The key stays inside lib.ts; never persist request bodies, URLs or error details.
  const url = chatCompletionsUrl(loadDevSecret(slot).base);
  const upstream = nodePlatform(slot).llm;
  const calls: Call[] = [];
  let current = "";
  const llm: Platform["llm"] = {
    ...upstream,
    ack: async () => {},
    async stream(request, emit) {
      if (calls.length >= maxCalls) {
        emit({ type: "error", kind: "cancelled" });
        return crypto.randomUUID();
      }
      const call: Call = { setup: current, usage: null, firstTokenMs: null, totalMs: 0, failed: null };
      calls.push(call);
      const start = performance.now();
      return upstream.stream(request, (event: StreamEvent) => {
        if (event.type === "data") {
          const chunk = parseChunk(event.data);
          if (chunk?.content) call.firstTokenMs ??= performance.now() - start;
          if (chunk?.usage) call.usage = chunk.usage;
        }
        if (event.type === "error") call.failed = event.status ? `${event.kind}:${event.status}` : event.kind;
        if (event.type === "error" || event.type === "done") call.totalMs = performance.now() - start;
        emit(event);
      });
    },
  };
  const platform = await createMemoryPlatform(llm);
  const game = await Game.open(platform, { slot, url, model, includeUsage: true });
  const results = [];
  for (const setup of SETUPS) {
    current = setup.id;
    const t0 = performance.now();
    let firstText: number | null = null;
    const worldId = await game.createWorld(setup.world, (e: TurnEvent) => {
      if (e.type === "text") firstText ??= performance.now() - t0;
    });
    if (!worldId) { results.push({ id: setup.id, failed: true }); continue; }
    const openedMs = performance.now() - t0;
    const opening = (await cursor(game.repo, worldId)).head;
    const state = await game.repo.getState(opening.id);
    const eraCard = state.cards.find((c) => c.kind === "时代") ?? null;
    const turns = [];
    for (const action of ACTIONS) {
      if (calls.length >= maxCalls) break;
      await game.play(worldId, action, () => {}).done;
      const head = (await cursor(game.repo, worldId)).head;
      turns.push({ action: action.text || "（继续）", narrative: head.narrative, status: head.status });
    }
    results.push({
      id: setup.id, premise: setup.world.settings.premise,
      openingFirstTextMs: firstText, openingTotalMs: openedMs, codexOk: opening.meta.codexOk ?? null,
      start: state.time.start, currency: state.era.currency ?? null,
      eraCard: eraCard && { name: eraCard.name, length: eraCard.content.length, withinLimit: eraCard.content.length <= ERA_CARD_LIMIT, content: eraCard.content },
      cards: state.cards.filter((c) => c.kind !== "时代").map((c) => ({ kind: c.kind, name: c.name, content: c.content })),
      places: state.places.map((p) => ({ name: p.name, description: p.description })),
      opening: opening.narrative, turns,
    });
    console.log(`${setup.id}：时代卡 ${eraCard ? `${eraCard.content.length} 字` : "无"}，卡片 ${state.cards.length - (eraCard ? 1 : 0)}，地点 ${state.places.length}，开场首字 ${firstText ? Math.round(firstText) : "—"}ms，调用 ${calls.length}/${maxCalls}`);
  }
  const summary = {
    model, promptVersion: PROMPT_VERSION, codexPromptVersion: CODEX_PROMPT_VERSION, maxCalls,
    calls: { total: calls.length, failed: calls.filter((c) => c.failed).map((c) => `${c.setup}:${c.failed}`) },
    tokens: {
      prompt: calls.reduce((n, c) => n + (c.usage?.promptTokens ?? 0), 0),
      completion: calls.reduce((n, c) => n + (c.usage?.completionTokens ?? 0), 0),
    },
    results,
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  const md = results.map((r) => "eraCard" in r
    ? `## ${r.id}\n\n故事设定：${r.premise}\n\n开局：${r.start}；货币：${JSON.stringify(r.currency)}\n\n### 时代卡（${r.eraCard?.length ?? 0} 字）\n\n${r.eraCard?.name ?? "（无）"}\n\n${r.eraCard?.content ?? ""}\n\n### 卡片\n\n${r.cards.map((c) => `- 【${c.kind}】${c.name}：${c.content}`).join("\n") || "（无）"}\n\n### 地点\n\n${r.places.map((p) => `- ${p.name}：${p.description}`).join("\n") || "（无）"}\n\n### 开场\n\n${r.opening}\n\n${r.turns.map((t) => `### ${t.action}\n\n${t.narrative}`).join("\n\n")}\n`
    : `## ${r.id}\n\n开局失败\n`).join("\n");
  fs.writeFileSync(path.join(out, "transcript.md"), `# 设定集整理评测\n\n模型：${model}\n\n${md}`, "utf8");
  console.log(JSON.stringify({ calls: summary.calls, tokens: summary.tokens }, null, 2));
  console.log(`结果：${path.relative(ROOT, out)}`);
}

main().catch((error) => {
  console.error(error instanceof Error && /^用法：/.test(error.message) ? error.message : "评测未完成，请检查槽位配置和本地环境（错误详情未输出以免泄露秘密）。");
  process.exitCode = 1;
});
