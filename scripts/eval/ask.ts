// R07-T001 check: play a few turns, then ask ten questions about this world and
// ten about the era. The transcript lists the world's records next to the
// answers so a reader can judge them.
//   node_modules/.bin/tsx scripts/eval/ask.ts --model <model> [--slot main] [--max-calls 40] [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { Game } from "../../src/engine/game.ts";
import { chatCompletionsUrl, parseChunk, type ChatUsage } from "../../src/engine/llm/chat.ts";
import { ASK_PROMPT_VERSION } from "../../src/engine/prompt/ask.ts";
import { renderState } from "../../src/engine/prompt/turn.ts";
import { eraContext } from "../../src/engine/era/index.ts";
import { cursor } from "../../src/engine/tree.ts";
import { TEMPLATES, templateName } from "../../src/content/templates.ts";
import { createMemoryPlatform } from "../../src/platform/memory.ts";
import type { Platform, StreamEvent } from "../../src/platform/types.ts";
import { loadDevSecret, nodePlatform, ROOT, stamp } from "./lib.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const ACTIONS = [
  "向县尉告退，带两个弟兄去案发处查看", "仔细查看死者身上和周围的痕迹", "向坊里的人打听昨夜的动静", "顺着线索去找可疑的人",
  "把查到的东西记下来，回县廨禀报", "（继续）", "去找能认出这件东西来历的人", "（继续）",
];
const WORLD = ["我的上司是谁？他给了我什么期限？", "我手下有哪些人？", "死者是什么人？", "我现在在哪里？", "我身上有多少钱？", "我眼下的目标是什么？", "谁对我最不友善？", "到目前为止我查到了什么线索？", "我答应过谁什么事吗？", "开局到现在过了多久？"];
const HISTORY = ["天宝年间一斗米大约多少钱？", "李林甫是什么人？", "唐代长安的宵禁是怎样的？", "不良人是做什么的？", "京县的县尉是几品官？", "安禄山这时候任什么官？", "唐代女子出门戴什么？", "开元通宝多少文为一贯？", "唐代的鱼袋是做什么用的？", "平康坊在长安城哪一带，以什么出名？"];

async function main() {
  const model = arg("model");
  if (!model) throw new Error("用法：tsx scripts/eval/ask.ts --model <模型> [--slot main] [--max-calls 40] [--out <目录>]");
  const slot = arg("slot", "main")!;
  const maxCalls = Number(arg("max-calls", "40"));
  const out = path.resolve(ROOT, arg("out", `.cache/eval/ask-${stamp()}`)!);
  const url = chatCompletionsUrl(loadDevSecret(slot).base);
  const upstream = nodePlatform(slot).llm;
  const calls: { usage: ChatUsage | null; failed: string | null }[] = [];
  const llm: Platform["llm"] = {
    ...upstream,
    ack: async () => {},
    async stream(request, emit) {
      if (calls.length >= maxCalls) { emit({ type: "error", kind: "cancelled" }); return crypto.randomUUID(); }
      const call = { usage: null as ChatUsage | null, failed: null as string | null };
      calls.push(call);
      return upstream.stream(request, (event: StreamEvent) => {
        if (event.type === "data") { const chunk = parseChunk(event.data); if (chunk?.usage) call.usage = chunk.usage; }
        if (event.type === "error") call.failed = event.status ? `${event.kind}:${event.status}` : event.kind;
        emit(event);
      });
    },
  };
  const game = await Game.open(await createMemoryPlatform(llm), { slot, url, model, includeUsage: true });
  const t = TEMPLATES.find((x) => x.id === "tang-buliang")!;
  const worldId = await game.createWorld({
    title: t.title, eraId: t.eraId, settings: { premise: t.premise, autoUpkeep: false, chapterEvery: 0 },
    protagonist: { name: templateName(t, "男"), gender: "男", age: t.age, identity: t.identity },
    arrival: "魂穿", origin: "历史系研究生", opening: { mode: "ai", hint: t.openingHint },
  }, () => {});
  if (!worldId) throw new Error("开局失败");
  for (const text of ACTIONS) {
    if (calls.length >= maxCalls) break;
    await game.play(worldId, text === "（继续）" ? { mode: "continue", text: "" } : { mode: "do", text }, () => {}).done;
  }
  const head = (await cursor(game.repo, worldId)).head;
  const state = await game.repo.getState(head.id);
  const story = (await game.repo.path(head.id)).map((n) => `${n.actionText ? `【玩家】${n.actionText}\n` : ""}${n.narrative}`).join("\n\n");
  const answers: { kind: string; q: string; a: string }[] = [];
  for (const [kind, list] of [["本局", WORLD], ["历史", HISTORY]] as const) {
    for (const q of list) {
      if (calls.length >= maxCalls) break;
      const a = await game.ask(worldId, q, () => {}).catch(() => "（失败）");
      answers.push({ kind, q, a });
      console.log(`${kind}：${q} · 调用 ${calls.length}/${maxCalls}`);
    }
  }
  const summary = {
    model, promptVersion: ASK_PROMPT_VERSION, maxCalls,
    calls: { total: calls.length, failed: calls.filter((c) => c.failed).map((c) => c.failed) },
    tokens: { prompt: calls.reduce((n, c) => n + (c.usage?.promptTokens ?? 0), 0), completion: calls.reduce((n, c) => n + (c.usage?.completionTokens ?? 0), 0) },
    answers,
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(out, "transcript.md"), `# 查一查评测\n\n模型：${model}\n\n## 本局资料（问答时的状态）\n\n${renderState(state, eraContext(t.eraId, state))}\n\n## 问答\n\n${answers.map((x, i) => `### ${i + 1}. 【${x.kind}】${x.q}\n\n${x.a}\n`).join("\n")}\n## 全部剧情\n\n${story}\n`, "utf8");
  console.log(JSON.stringify({ calls: summary.calls, tokens: summary.tokens }, null, 2));
  console.log(`结果：${path.relative(ROOT, out)}`);
}

main().catch((error) => {
  console.error(error instanceof Error && /^(用法：|开局失败)/.test(error.message) ? error.message : "评测未完成，请检查槽位配置和本地环境（错误详情未输出以免泄露秘密）。");
  process.exitCode = 1;
});
